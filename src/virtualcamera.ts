import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractSupportSurfaces, projectedCaptureFraction, type CaptureFrustum, type SupportSurface } from "./affordance.js";
import { loadOccupancyGrid, rayOccluded, type OccupancyGrid } from "./occupancy.js";
import { loadSemanticScene, type SemanticScene } from "./semanticplace.js";
import { okJson } from "./util.js";

type Vec3 = [number, number, number];

export interface CameraIntrinsics {
  f: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

interface WorldConfig {
  splatPath?: string;
  splat?: string;
  source?: string;
  occupancyPath?: string;
  offsetApplied?: Vec3;
}

type WorldConfigInput = string | WorldConfig;
type ExecResult = { stdout: string | Buffer; stderr?: string | Buffer };
type ExecOverride = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; maxBuffer: number; timeout: number },
) => Promise<ExecResult>;

export interface RenderVirtualFrameOptions {
  splatPath?: string;
  worldConfig?: WorldConfigInput;
  position: Vec3;
  target?: Vec3;
  yawDeg?: number;
  pitchDeg?: number;
  fovDeg?: number;
  width?: number;
  height?: number;
  maxPoints?: number;
  calibratedIntrinsics?: boolean;
  calibrationPath?: string;
  outDir?: string;
  pythonPath?: string;
  exec?: ExecOverride;
}

export interface DetectVirtualSurfacesOptions {
  semanticScenePath?: string;
  occupancyPath?: string;
  scene?: SemanticScene;
  occupancy?: OccupancyGrid;
  position: Vec3;
  target?: Vec3;
  yawDeg?: number;
  pitchDeg?: number;
  fovDeg?: number;
  width?: number;
  height?: number;
  calibratedIntrinsics?: boolean;
  calibrationPath?: string;
  minVisibleFraction?: number;
}

const execFileAsync = promisify(execFile) as unknown as ExecOverride;
const DEFAULT_CALIBRATION = path.join(os.homedir(), ".pico-mcp", "camera-calibration.json");
const DEFAULT_OUT_DIR = "/tmp/pico-render/vcam";
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
export const VIRTUAL_CAMERA_HONESTY =
  "host-side synthetic render of the scanned world — NOT an emulator capture; evidence class usd_host_render at best";
export const VIRTUAL_SURFACES_HONESTY =
  "simulated scene understanding from scanned geometry — structural evidence; labels are detector opinions";

function finiteVec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new Error(`${label} must be a finite [x,y,z] tuple`);
  }
  return [value[0], value[1], value[2]];
}

function readJson(filePath: string, label: string): any {
  if (!fs.existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error: any) {
    throw new Error(`${label} is not valid JSON (${filePath}): ${error?.message ?? error}`);
  }
}

function worldObject(input?: WorldConfigInput): { config: WorldConfig; configPath?: string } {
  if (!input) return { config: {} };
  if (typeof input === "string") return { config: readJson(input, "worldConfig") as WorldConfig, configPath: input };
  return { config: input };
}

function resolveWorld(input?: WorldConfigInput, explicitSplat?: string): {
  splatPath: string;
  offsetApplied: Vec3;
  worldConfigPath?: string;
  occupancyPath?: string;
} {
  const { config, configPath } = worldObject(input);
  const occupancyPath = config.occupancyPath;
  let occupancy: WorldConfig | undefined;
  if (occupancyPath) occupancy = readJson(occupancyPath, "occupancy grid") as WorldConfig;

  // Passing an occupancy-grid JSON directly is the shortest complete worldConfig: its source is
  // the raw splat and offsetApplied is the exact raw-splat -> app-frame translation.
  const directOccupancy = config.offsetApplied && config.source ? config : undefined;
  const grid = occupancy ?? directOccupancy;
  const splatPath = explicitSplat
    ?? config.splatPath
    ?? config.splat
    ?? grid?.source;
  if (!splatPath) {
    throw new Error("splatPath is required (directly, in worldConfig, or as an occupancy grid's source)");
  }
  if (!fs.existsSync(splatPath)) throw new Error(`splat not found: ${splatPath}`);
  if (path.extname(splatPath).toLowerCase() !== ".ply") {
    throw new Error(`the deterministic virtual-camera renderer currently requires a decoded .ply (SPZ is not supported): ${splatPath}`);
  }
  const offsetApplied = finiteVec3(grid?.offsetApplied ?? config.offsetApplied ?? [0, 0, 0], "offsetApplied");
  return { splatPath, offsetApplied, worldConfigPath: configPath, occupancyPath: occupancyPath ?? (directOccupancy ? configPath : undefined) };
}

export function intrinsicsFromFov(width: number, height: number, fovDeg: number): CameraIntrinsics {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("width and height must be positive integers");
  }
  if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) throw new Error("fovDeg must be between 0 and 180");
  const f = 0.5 * width / Math.tan((fovDeg * Math.PI / 180) / 2);
  return { f, cx: width / 2, cy: height / 2, width, height };
}

function loadCalibratedIntrinsics(filePath: string, requestedWidth?: number, requestedHeight?: number): CameraIntrinsics {
  const raw = readJson(filePath, "camera calibration");
  for (const key of ["f", "cx", "cy", "width", "height"] as const) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] <= 0) {
      throw new Error(`camera calibration ${filePath} has invalid ${key}`);
    }
  }
  const width = requestedWidth ?? raw.width;
  const height = requestedHeight ?? raw.height;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("width and height must be positive integers");
  }
  const scaleX = width / raw.width;
  const scaleY = height / raw.height;
  if (Math.abs(scaleX - scaleY) > 1e-9) {
    throw new Error("calibratedIntrinsics width/height must preserve the calibration aspect ratio (one focal length serves both axes)");
  }
  return { f: raw.f * scaleX, cx: raw.cx * scaleX, cy: raw.cy * scaleY, width, height };
}

function targetFromAngles(position: Vec3, yawDeg = 0, pitchDeg = 0): Vec3 {
  if (![yawDeg, pitchDeg].every(Number.isFinite)) throw new Error("yawDeg and pitchDeg must be finite");
  if (pitchDeg <= -90 || pitchDeg >= 90) throw new Error("pitchDeg must be between -90 and 90");
  const yaw = yawDeg * Math.PI / 180;
  const pitch = pitchDeg * Math.PI / 180;
  const cp = Math.cos(pitch);
  return [
    position[0] + Math.sin(yaw) * cp,
    position[1] + Math.sin(pitch),
    position[2] - Math.cos(yaw) * cp,
  ];
}

export function appPoseToSplatPose(
  pose: { position: Vec3; target: Vec3 },
  offsetApplied: Vec3,
): { position: Vec3; target: Vec3 } {
  const subtract = (value: Vec3): Vec3 => [
    value[0] - offsetApplied[0],
    value[1] - offsetApplied[1],
    value[2] - offsetApplied[2],
  ];
  return { position: subtract(pose.position), target: subtract(pose.target) };
}

function validateLookDirection(position: Vec3, target: Vec3) {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const dz = target[2] - position[2];
  if (Math.hypot(dx, dy, dz) < 1e-6) throw new Error("target must differ from position");
  if (Math.hypot(dx, dz) < 1e-6) {
    throw new Error("target direction cannot be parallel to world up; choose a non-vertical look direction");
  }
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  return [value[0] / length, value[1] / length, value[2] / length];
}

interface CameraBasis {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

function cameraBasis(position: Vec3, target: Vec3): CameraBasis {
  const forward = normalize([target[0] - position[0], target[1] - position[1], target[2] - position[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  return { position, forward, right, up: cross(right, forward) };
}

/** Map app/world coordinates into projectedCaptureFraction's fixed camera convention (+X,+Y,-Z). */
function toCameraPoint(point: Vec3, basis: CameraBasis): Vec3 {
  const relative: Vec3 = [
    point[0] - basis.position[0],
    point[1] - basis.position[1],
    point[2] - basis.position[2],
  ];
  return [dot(relative, basis.right), dot(relative, basis.up), -dot(relative, basis.forward)];
}

function patchVisibility(
  min: Vec3,
  max: Vec3,
  basis: CameraBasis,
  frustum: CaptureFrustum,
): number {
  const corners: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    corners.push(toCameraPoint([x, y, z], basis));
  }
  // Use the helper's real-corner overload. Re-boxing an arbitrarily rotated patch in camera
  // space would invent corner combinations which do not exist and can create phantom geometry.
  return projectedCaptureFraction(corners, frustum) ?? 0;
}

/**
 * Average clipped-projection visibility over small equal-area surface patches. Subdivision is
 * required for floors that cross the camera plane: one giant AABB would fail closed when any
 * corner is behind the viewer even though most of the forward floor is in-frame.
 */
function surfaceVisibility(surface: SupportSurface, basis: CameraBasis, frustum: CaptureFrustum): {
  visibleFraction: number;
  detectedPatchVisibleFraction: number;
  visiblePatchFraction: number;
} {
  const spanX = surface.max[0] - surface.min[0];
  const spanZ = surface.max[1] - surface.min[1];
  const cellsX = Math.min(12, Math.max(1, Math.ceil(spanX / 0.25)));
  const cellsZ = Math.min(12, Math.max(1, Math.ceil(spanZ / 0.25)));
  let sum = 0;
  let visibleSum = 0;
  let visiblePatches = 0;
  for (let ix = 0; ix < cellsX; ix++) for (let iz = 0; iz < cellsZ; iz++) {
    const x0 = surface.min[0] + spanX * ix / cellsX;
    const x1 = surface.min[0] + spanX * (ix + 1) / cellsX;
    const z0 = surface.min[1] + spanZ * iz / cellsZ;
    const z1 = surface.min[1] + spanZ * (iz + 1) / cellsZ;
    const fraction = patchVisibility([x0, surface.y - 0.01, z0], [x1, surface.y + 0.01, z1], basis, frustum);
    sum += fraction;
    if (fraction > 0) { visibleSum += fraction; visiblePatches++; }
  }
  const totalPatches = cellsX * cellsZ;
  return {
    // The public visibleFraction is whole-surface coverage and drives minVisibleFraction. Keep
    // conditional in-frame quality separate so a tiny, crisp sliver cannot pass a high threshold.
    visibleFraction: sum / totalPatches,
    detectedPatchVisibleFraction: visiblePatches ? visibleSum / visiblePatches : 0,
    visiblePatchFraction: visiblePatches / totalPatches,
  };
}

export function detectVirtualSurfaces(options: DetectVirtualSurfacesOptions) {
  const position = finiteVec3(options.position, "position");
  if (options.target && (options.yawDeg !== undefined || options.pitchDeg !== undefined)) {
    throw new Error("pass position+target OR yawDeg/pitchDeg, not both");
  }
  const target = options.target
    ? finiteVec3(options.target, "target")
    : targetFromAngles(position, options.yawDeg ?? 0, options.pitchDeg ?? 0);
  validateLookDirection(position, target);
  const semanticPath = options.semanticScenePath?.replace(/^~\//, `${os.homedir()}/`);
  const scene = options.scene ?? (semanticPath ? loadSemanticScene(semanticPath) : null);
  if (!scene) throw new Error(semanticPath ? `cannot load semantic scene ${semanticPath}` : "semanticScenePath is required");
  const occupancyPath = options.occupancyPath?.replace(/^~\//, `${os.homedir()}/`);
  let occupancy = options.occupancy;
  if (!occupancy && occupancyPath) {
    try { occupancy = loadOccupancyGrid(occupancyPath); }
    catch (error: any) { throw new Error(`cannot load occupancy grid ${occupancyPath}: ${error?.message ?? error}`); }
  }
  const fovDeg = options.fovDeg ?? 70;
  const intrinsics = options.calibratedIntrinsics
    ? loadCalibratedIntrinsics(options.calibrationPath ?? DEFAULT_CALIBRATION, options.width, options.height)
    : intrinsicsFromFov(options.width ?? 1280, options.height ?? 1280, fovDeg);
  const minVisibleFraction = options.minVisibleFraction ?? 0.01;
  if (!Number.isFinite(minVisibleFraction) || minVisibleFraction < 0 || minVisibleFraction > 1) {
    throw new Error("minVisibleFraction must be between 0 and 1");
  }
  const basis = cameraBasis(position, target);
  const frustum: CaptureFrustum = intrinsics;
  const surfaces = extractSupportSurfaces(scene).map((surface) => {
    const center: Vec3 = [
      (surface.min[0] + surface.max[0]) / 2,
      surface.y,
      (surface.min[1] + surface.max[1]) / 2,
    ];
    const visibility = surfaceVisibility(surface, basis, frustum);
    return {
      kind: surface.kind,
      label: surface.label,
      objectId: surface.objectId,
      center,
      extent: [surface.max[0] - surface.min[0], 0, surface.max[1] - surface.min[1]] as Vec3,
      distanceM: Number(Math.hypot(center[0] - position[0], center[1] - position[1], center[2] - position[2]).toFixed(3)),
      visibleFraction: Number(visibility.visibleFraction.toFixed(4)),
      detectedPatchVisibleFraction: Number(visibility.detectedPatchVisibleFraction.toFixed(4)),
      visiblePatchFraction: Number(visibility.visiblePatchFraction.toFixed(4)),
      losClear: occupancy ? !rayOccluded(occupancy, position, center).occluded : null,
    };
  }).filter((surface) => surface.visibleFraction >= minVisibleFraction);
  return {
    surfaces,
    intrinsics,
    pose: { position, target },
    occupancyConsulted: !!occupancy,
    honesty: `${VIRTUAL_SURFACES_HONESTY}${occupancy ? "" : "; losClear is null because no occupancy grid was supplied"}`,
  };
}

function subprocessError(error: any): string {
  const stderr = String(error?.stderr ?? "").trim();
  if (stderr) return stderr.slice(-1200);
  return String(error?.message ?? error).slice(0, 800);
}

function resolvePython(explicit?: string, skipProbe = false): string {
  const python = explicit ?? process.env.PICO_PY ?? path.join(os.homedir(), ".pico", "venv", "bin", "python");
  if (skipProbe) return python;
  if (!fs.existsSync(python) && python.includes(path.sep)) throw new Error(`renderer Python not found: ${python}`);
  try {
    execFileSync(python, ["-c", "import numpy, PIL"], { stdio: "ignore", timeout: 30_000 });
  } catch {
    throw new Error(`${python} needs numpy + Pillow for the virtual-camera renderer`);
  }
  return python;
}

export async function renderVirtualFrame(options: RenderVirtualFrameOptions) {
  const position = finiteVec3(options.position, "position");
  if (options.target && (options.yawDeg !== undefined || options.pitchDeg !== undefined)) {
    throw new Error("pass position+target OR yawDeg/pitchDeg, not both");
  }
  const target = options.target
    ? finiteVec3(options.target, "target")
    : targetFromAngles(position, options.yawDeg ?? 0, options.pitchDeg ?? 0);
  validateLookDirection(position, target);
  const world = resolveWorld(options.worldConfig, options.splatPath);
  const splatPose = appPoseToSplatPose({ position, target }, world.offsetApplied);
  const fovDeg = options.fovDeg ?? 70;
  const intrinsics = options.calibratedIntrinsics
    ? loadCalibratedIntrinsics(options.calibrationPath ?? DEFAULT_CALIBRATION, options.width, options.height)
    : intrinsicsFromFov(options.width ?? 1280, options.height ?? 1280, fovDeg);
  const maxPoints = options.maxPoints ?? 500_000;
  if (!Number.isInteger(maxPoints) || maxPoints <= 0) throw new Error("maxPoints must be a positive integer");

  const signature = JSON.stringify({
    splatPath: world.splatPath,
    offsetApplied: world.offsetApplied,
    position,
    target,
    intrinsics,
    fovDeg,
    maxPoints,
  });
  const stem = path.basename(world.splatPath).replace(/\.(ply|spz)$/i, "").replace(/[^a-z0-9_-]+/gi, "-");
  const hash = crypto.createHash("sha256").update(signature).digest("hex").slice(0, 12);
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const imagePath = path.join(outDir, `${stem}-${hash}.png`);
  const rendererPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "py", "splat_perspective.py");
  const config = {
    splat: world.splatPath,
    maxPts: maxPoints,
    W: intrinsics.width,
    H: intrinsics.height,
    fov: fovDeg,
    f: intrinsics.f,
    cx: intrinsics.cx,
    cy: intrinsics.cy,
    views: [{ name: "virtual-camera", C: splatPose.position, T: splatPose.target, out: imagePath }],
  };
  const execute = options.exec ?? execFileAsync;
  const python = resolvePython(options.pythonPath, !!options.exec);
  let rendered: any;
  try {
    const result = await execute(python, [rendererPath, JSON.stringify(config)], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: RENDER_TIMEOUT_MS,
    });
    const stdout = String(result.stdout).trim();
    rendered = JSON.parse(stdout.split("\n").pop() as string);
  } catch (error: any) {
    throw new Error(`virtual-camera render failed: ${subprocessError(error)}`);
  }
  if (!fs.existsSync(imagePath) || fs.statSync(imagePath).size === 0) {
    throw new Error(`renderer returned without a non-empty PNG: ${imagePath}`);
  }

  return {
    imagePath,
    intrinsics,
    pose: {
      frame: "app",
      position,
      target,
      splatFrame: { position: splatPose.position, target: splatPose.target },
      appToSplatOffset: world.offsetApplied,
    },
    pointsRendered: rendered.views?.[0]?.pointsRendered ?? rendered.points,
    source: {
      splatPath: world.splatPath,
      worldConfigPath: world.worldConfigPath ?? null,
      occupancyPath: world.occupancyPath ?? null,
    },
    honesty: VIRTUAL_CAMERA_HONESTY,
  };
}

const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const worldConfigSchema = z.union([
  z.string(),
  z.object({
    splatPath: z.string().optional(),
    splat: z.string().optional(),
    source: z.string().optional(),
    occupancyPath: z.string().optional(),
    offsetApplied: vec3Schema.optional(),
  }).strict(),
]);

const virtualCameraFrameInputSchema = z.object({
        splatPath: z.string().optional().describe("Raw binary .ply path; optional when worldConfig resolves it (SPZ is not yet supported by this renderer)."),
  worldConfig: worldConfigSchema.optional().describe("World JSON/object; an occupancy grid directly supplies source + app-frame offsetApplied."),
  position: vec3Schema.describe("Camera position in the app frame."),
  target: vec3Schema.optional().describe("Look target in the app frame; mutually exclusive with yawDeg/pitchDeg."),
  yawDeg: z.number().optional().describe("Yaw in degrees; 0 faces app -Z."),
  pitchDeg: z.number().optional().describe("Pitch in degrees, strictly between -90 and 90."),
  fovDeg: z.number().gt(0).lt(180).optional().describe("Horizontal field of view (default 70)."),
  width: z.number().int().positive().max(8192).optional().describe("Output width (default 1280, or calibration width)."),
  height: z.number().int().positive().max(8192).optional().describe("Output height (default 1280, or calibration height)."),
  maxPoints: z.number().int().positive().optional().describe("Deterministic point sample budget (default 500000)."),
  calibratedIntrinsics: z.boolean().optional().describe("Use persisted capture-camera f/cx/cy instead of centered FOV intrinsics."),
  calibrationPath: z.string().optional().describe("Calibration JSON override; default ~/.pico-mcp/camera-calibration.json."),
  outDir: z.string().optional().describe("Output directory (default /tmp/pico-render/vcam)."),
}).strict().superRefine((value, context) => {
  if (value.target && (value.yawDeg !== undefined || value.pitchDeg !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "pass position+target OR yawDeg/pitchDeg, not both" });
  }
});

const virtualCameraSurfacesInputSchema = z.object({
  semanticScenePath: z.string(),
  occupancyPath: z.string().optional(),
  position: vec3Schema,
  target: vec3Schema.optional(),
  yawDeg: z.number().optional(),
  pitchDeg: z.number().optional(),
  fovDeg: z.number().gt(0).lt(180).optional(),
  width: z.number().int().positive().max(8192).optional(),
  height: z.number().int().positive().max(8192).optional(),
  calibratedIntrinsics: z.boolean().optional(),
  calibrationPath: z.string().optional(),
  minVisibleFraction: z.number().min(0).max(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.target && (value.yawDeg !== undefined || value.pitchDeg !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "pass position+target OR yawDeg/pitchDeg, not both" });
  }
});

export function registerVirtualCameraTools(server: McpServer) {
  server.registerTool(
    "virtual_camera_frame",
    {
      description:
        "Render a deterministic host-side synthetic camera frame from a scanned world model. The pose is in app coordinates; pass an occupancy-grid JSON as worldConfig to apply its exact offsetApplied mapping back to raw-splat coordinates. calibratedIntrinsics uses ~/.pico-mcp/camera-calibration.json (f/cx/cy). This is explicitly NOT an emulator camera capture.",
      inputSchema: virtualCameraFrameInputSchema,
    },
    async (args) => {
      try {
        return okJson({ status: "ok", ...await renderVirtualFrame(args as RenderVirtualFrameOptions) });
      } catch (error: any) {
        return okJson({ status: "error", error: error?.message ?? String(error), honesty: VIRTUAL_CAMERA_HONESTY });
      }
    },
  );
  server.registerTool(
    "virtual_camera_surfaces",
    {
      description:
        "Simulate camera-visible support-plane detection from a semantic scanned-room model. Reports detector-labeled floor/object tops, whole-surface visibleFraction plus detectedPatchVisibleFraction/visiblePatchFraction, center-ray occupancy LOS, distance, and extents for an arbitrary pose. A tiny visible sliver cannot pass a high minVisibleFraction. Structural geometry only; losClear is null without occupancyPath.",
      inputSchema: virtualCameraSurfacesInputSchema,
    },
    async (args) => {
      try {
        return okJson({ status: "ok", ...detectVirtualSurfaces(args as DetectVirtualSurfacesOptions) });
      } catch (error: any) {
        return okJson({ status: "error", error: error?.message ?? String(error), honesty: VIRTUAL_SURFACES_HONESTY });
      }
    },
  );
}
