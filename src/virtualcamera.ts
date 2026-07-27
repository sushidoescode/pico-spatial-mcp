import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { adbPath } from "./adb.js";
import { extractSupportSurfaces, projectedCaptureFraction, type CaptureFrustum, type SupportSurface } from "./affordance.js";
import { loadOccupancyGrid, rayOccluded, type OccupancyGrid } from "./occupancy.js";
import { loadSemanticScene, type SemanticScene } from "./semanticplace.js";
import { okJson, run, runBinary } from "./util.js";

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
  emitBgra?: boolean;
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

interface CaptureAppArgs {
  serial: string;
  packageName?: string;
  outPath: string;
}

interface CaptureAppResult {
  packageName: string;
  capturePath: string;
  foregroundVerified: boolean;
}

interface ComposeFramesArgs {
  emulatorCapturePath: string;
  virtualFramePath: string;
  outDir: string;
  packageName: string;
}

export interface VirtualCameraFromAppOptions {
  packageName?: string;
  serial?: string;
  assumeSpawnPose?: boolean;
  splatPath?: string;
  worldConfig?: WorldConfigInput;
  semanticScenePath?: string;
  occupancyPath?: string;
  position?: Vec3;
  target?: Vec3;
  yawDeg?: number;
  pitchDeg?: number;
  fovDeg?: number;
  width?: number;
  height?: number;
  maxPoints?: number;
  calibrationPath?: string;
  outDir?: string;
  captureApp?: (args: CaptureAppArgs) => Promise<CaptureAppResult>;
  renderFrame?: (options: RenderVirtualFrameOptions) => Promise<any>;
  detectSurfaces?: (options: DetectVirtualSurfacesOptions) => any;
  composeFrames?: (args: ComposeFramesArgs) => Promise<{ imagePath: string }>;
}

const execFileAsync = promisify(execFile) as unknown as ExecOverride;
const DEFAULT_CALIBRATION = path.join(os.homedir(), ".pico-mcp", "camera-calibration.json");
const DEFAULT_OUT_DIR = "/tmp/pico-render/vcam";
const DEFAULT_FROM_APP_OUT_DIR = "/tmp/pico-render/vcam/from-app";
const DEFAULT_EMULATOR_SERIAL = "emulator-5554";
const ASSUMED_CAPTURE_POSITION: Vec3 = [0.034, 1.896, 0.147];
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
export const VIRTUAL_CAMERA_HONESTY =
  "host-side synthetic render of the scanned world — NOT an emulator capture; evidence class usd_host_render at best";
export const VIRTUAL_SURFACES_HONESTY =
  "simulated scene understanding from scanned geometry — structural evidence; labels are detector opinions";
export const VIRTUAL_FROM_APP_HONESTY =
  "emulatorCapturePath is a real adb display capture of the foreground emulator app; " +
  "virtualFramePath is a host-side synthetic render of scanned geometry, usd_host_render at best; " +
  "surfaces are structural detector opinions; no live head pose was measured; " +
  "sideBySidePath earns no visual claim until a vision-capable reviewer LOOKS at it";

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
  const bgraPath = options.emitBgra ? imagePath.replace(/\.png$/, ".bgra") : null;
  const config = {
    splat: world.splatPath,
    maxPts: maxPoints,
    W: intrinsics.width,
    H: intrinsics.height,
    fov: fovDeg,
    f: intrinsics.f,
    cx: intrinsics.cx,
    cy: intrinsics.cy,
    emitBgra: !!options.emitBgra,
    views: [{ name: "virtual-camera", C: splatPose.position, T: splatPose.target, out: imagePath, bgraOut: bgraPath }],
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

  let bgraSha256: string | null = null;
  if (bgraPath) {
    const expected = intrinsics.width * intrinsics.height * 4;
    if (!fs.existsSync(bgraPath) || fs.statSync(bgraPath).size !== expected) {
      throw new Error(`renderer returned without a ${expected}-byte BGRA frame: ${bgraPath}`);
    }
    bgraSha256 = crypto.createHash("sha256").update(fs.readFileSync(bgraPath)).digest("hex");
  }

  return {
    imagePath,
    bgraPath,
    bgraSha256,
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

export function selectForegroundPackage(output: string, requestedPackage?: string): string {
  const packages = [...output.matchAll(
    /(?:topResumedActivity=|mResumedActivity:\s*|ResumedActivity:\s*)ActivityRecord\{\S+\s+u\d+\s+([\w.]+)\//g,
  )].map((matched) => matched[1]);
  const unique = [...new Set(packages)];
  if (requestedPackage) {
    if (unique.includes(requestedPackage)) return requestedPackage;
    throw new Error(`requested package ${requestedPackage} is not resumed on any display (resumed: ${unique.join(", ") || "none"})`);
  }
  const fleet = unique.filter((packageName) => packageName.startsWith("com.fleet."));
  if (fleet.length === 1) return fleet[0];
  if (fleet.length > 1) {
    throw new Error(`multiple resumed fleet apps make foreground selection ambiguous (${fleet.join(", ")}); pass packageName`);
  }
  throw new Error(`no resumed com.fleet.* app found (resumed: ${unique.join(", ") || "none"})`);
}

async function foregroundPackage(serial: string, requestedPackage?: string): Promise<string> {
  const result = await run(await adbPath(), ["-s", serial, "shell", "dumpsys", "activity", "activities"], {
    timeoutMs: 20_000,
  });
  if (result.code !== 0) {
    throw new Error(`cannot query foreground package on ${serial}: ${(result.stderr || result.stdout).trim()}`);
  }
  return selectForegroundPackage(result.stdout, requestedPackage);
}

function assertPng(filePath: string, label: string, minBytes = 8) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} was not written: ${filePath}`);
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < minBytes || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`${label} is not a valid non-empty PNG: ${filePath}`);
  }
}

async function captureForegroundApp(args: CaptureAppArgs): Promise<CaptureAppResult> {
  if (!/^emulator-\d+$/.test(args.serial)) {
    throw new Error(`virtual_camera_from_app only captures a PICO emulator; got serial '${args.serial}'`);
  }
  const before = await foregroundPackage(args.serial, args.packageName);
  const packageName = args.packageName ?? before;
  const result = await runBinary(await adbPath(), ["-s", args.serial, "exec-out", "screencap", "-p"], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0 || result.stdout.length < 1000) {
    throw new Error(`adb screencap failed on ${args.serial} (code ${result.code}, ${result.stdout.length} bytes): ${result.stderr.trim()}`);
  }
  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, result.stdout);
  assertPng(args.outPath, "emulator capture", 1000);
  const after = await foregroundPackage(args.serial, packageName);
  if (after !== packageName) {
    throw new Error(`foreground changed during capture (${packageName} -> ${after}); refusing to attribute the pixels`);
  }
  return { packageName, capturePath: args.outPath, foregroundVerified: true };
}

function magickPath(): string {
  const configured = process.env.PICO_MAGICK;
  if (configured) return configured;
  for (const candidate of ["/opt/homebrew/bin/magick", "/usr/local/bin/magick"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "magick";
}

async function composeFromAppFrames(args: ComposeFramesArgs): Promise<{ imagePath: string }> {
  const invocationHash = crypto.createHash("sha256").update(args.emulatorCapturePath).digest("hex").slice(0, 16);
  const imagePath = path.join(args.outDir, `side-by-side-${invocationHash}.png`);
  fs.mkdirSync(args.outDir, { recursive: true });
  const fontPath = "/System/Library/Fonts/Helvetica.ttc";
  if (!fs.existsSync(fontPath)) {
    throw new Error(`side-by-side label font not found: ${fontPath}`);
  }
  try {
    await execFileAsync(magickPath(), [
      "montage",
      "-font", fontPath,
      "-background", "#111827",
      "-fill", "#f8fafc",
      "-pointsize", "36",
      "-label", `EMULATOR DISPLAY (adb) — ${args.packageName}`,
      args.emulatorCapturePath,
      "-label", "HOST SYNTHETIC WORLD MODEL (usd_host_render)",
      args.virtualFramePath,
      "-tile", "2x1",
      "-geometry", "1080x1079+16+16",
      imagePath,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  } catch (error: any) {
    throw new Error(`side-by-side composition failed: ${subprocessError(error)}`);
  }
  assertPng(imagePath, "side-by-side composition");
  return { imagePath };
}

function inferredWorldInputs(packageName: string): { semanticScenePath?: string; occupancyPath?: string } {
  const matched = packageName.match(/^com\.fleet\.([a-z0-9_-]+)$/i);
  if (!matched) return {};
  const briefPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "briefs", `${matched[1]}.json`);
  if (!fs.existsSync(briefPath)) return {};
  const brief = readJson(briefPath, `brief for ${packageName}`);
  return {
    semanticScenePath: brief?.spec?.meta?.semanticScenePath,
    occupancyPath: brief?.spec?.meta?.occupancyPath,
  };
}

export async function virtualCameraFromApp(options: VirtualCameraFromAppOptions) {
  const assumeSpawnPose = options.assumeSpawnPose ?? true;
  if (!options.position && !assumeSpawnPose) {
    throw new Error("assumeSpawnPose is false, so an explicit position is required");
  }
  if (options.target && (options.yawDeg !== undefined || options.pitchDeg !== undefined)) {
    throw new Error("pass position+target OR yawDeg/pitchDeg, not both");
  }
  const poseAssumed = !options.position;
  const position = options.position ? finiteVec3(options.position, "position") : [...ASSUMED_CAPTURE_POSITION] as Vec3;
  const target = options.target ? finiteVec3(options.target, "target") : undefined;
  const yawExplicit = options.yawDeg !== undefined;
  const pitchExplicit = options.pitchDeg !== undefined;
  const orientationAssumed = !target && (!yawExplicit || !pitchExplicit);
  const yawDeg = target ? undefined : options.yawDeg ?? 0;
  const pitchDeg = target ? undefined : options.pitchDeg ?? (poseAssumed ? 20 : 0);
  const resolvedTarget = target ?? targetFromAngles(position, yawDeg, pitchDeg);
  validateLookDirection(position, resolvedTarget);

  const serial = options.serial ?? DEFAULT_EMULATOR_SERIAL;
  if (!/^emulator-\d+$/.test(serial)) {
    throw new Error(`virtual_camera_from_app only targets a PICO emulator; got serial '${serial}'`);
  }
  const outDir = options.outDir ?? DEFAULT_FROM_APP_OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const invocationId = crypto.randomBytes(8).toString("hex");
  const capture = await (options.captureApp ?? captureForegroundApp)({
    serial,
    packageName: options.packageName,
    outPath: path.join(outDir, `emulator-display-${invocationId}.png`),
  });
  if (options.packageName && capture.packageName !== options.packageName) {
    throw new Error(`capture attributed to ${capture.packageName}, not requested ${options.packageName}`);
  }
  if (!capture.foregroundVerified) {
    throw new Error("capture did not verify the foreground package before and after screencap");
  }
  assertPng(capture.capturePath, "emulator capture");

  const inferred = inferredWorldInputs(capture.packageName);
  const semanticScenePath = options.semanticScenePath ?? inferred.semanticScenePath;
  const occupancyPath = options.occupancyPath ?? inferred.occupancyPath;
  const worldConfig = options.worldConfig ?? occupancyPath;
  if (!semanticScenePath) {
    throw new Error(`semanticScenePath is required (no spec.meta.semanticScenePath found for ${capture.packageName})`);
  }
  if (!options.splatPath && !worldConfig) {
    throw new Error(`splatPath or worldConfig is required (no spec.meta.occupancyPath found for ${capture.packageName})`);
  }

  const poseOptions = target ? { target } : { yawDeg, pitchDeg };
  const virtualFrame = await (options.renderFrame ?? renderVirtualFrame)({
    splatPath: options.splatPath,
    worldConfig,
    position,
    ...poseOptions,
    fovDeg: options.fovDeg,
    width: options.width,
    height: options.height,
    maxPoints: options.maxPoints ?? 1_500_000,
    calibratedIntrinsics: true,
    calibrationPath: options.calibrationPath,
    outDir,
  });
  assertPng(virtualFrame.imagePath, "virtual frame");
  const surfaces = (options.detectSurfaces ?? detectVirtualSurfaces)({
    semanticScenePath,
    occupancyPath,
    position,
    ...poseOptions,
    fovDeg: options.fovDeg,
    width: options.width,
    height: options.height,
    calibratedIntrinsics: true,
    calibrationPath: options.calibrationPath,
  });
  const composed = await (options.composeFrames ?? composeFromAppFrames)({
    emulatorCapturePath: capture.capturePath,
    virtualFramePath: virtualFrame.imagePath,
    outDir,
    packageName: capture.packageName,
  });
  assertPng(composed.imagePath, "side-by-side composition");

  return {
    packageName: capture.packageName,
    serial,
    foregroundVerified: true,
    emulatorCapturePath: capture.capturePath,
    virtualFramePath: virtualFrame.imagePath,
    surfaces,
    sideBySidePath: composed.imagePath,
    pose: {
      position,
      ...(target ? { target } : { yawDeg, pitchDeg }),
    },
    poseAssumed,
    orientationAssumed,
    poseSource: poseAssumed
      ? `position is derived from the v27.7 ramen capture; ${target ? "orientation target is caller-supplied" : `orientation uses yaw ${yawDeg}° (${yawExplicit ? "caller-supplied" : "assumed/calibrated Task 2 default"}) and pitch ${pitchDeg}° (${pitchExplicit ? "caller-supplied" : "assumed/calibrated Task 2 default"})`}; no live head pose is available or measured`
      : `position is caller-supplied; ${target ? "orientation target is caller-supplied" : `orientation uses yaw ${yawDeg}° (${yawExplicit ? "caller-supplied" : "defaulted/assumed"}) and pitch ${pitchDeg}° (${pitchExplicit ? "caller-supplied" : "defaulted/assumed"})`}; no live head pose was queried or measured`,
    honesty: VIRTUAL_FROM_APP_HONESTY,
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
  emitBgra: z.boolean().optional().describe("Also write a raw BGRA sibling next to the PNG for the injected-pixel camera transport; this is a host-rendered file, not itself emulator/device evidence."),
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

const virtualCameraFromAppInputSchema = z.object({
  packageName: z.string().optional().describe("Foreground app package; omitted means the currently resumed com.fleet.* app."),
  serial: z.string().regex(/^emulator-\d+$/).optional().describe("PICO emulator serial (default emulator-5554; physical devices are rejected)."),
  assumeSpawnPose: z.boolean().optional().describe("Default true. Uses the explicitly labeled v27.7 position + Task-2-calibrated orientation when position is absent."),
  splatPath: z.string().optional(),
  worldConfig: worldConfigSchema.optional().describe("World/occupancy JSON. For com.fleet.* apps, omitted paths are inferred from briefs/<id>.json spec.meta."),
  semanticScenePath: z.string().optional(),
  occupancyPath: z.string().optional(),
  position: vec3Schema.optional(),
  target: vec3Schema.optional(),
  yawDeg: z.number().optional(),
  pitchDeg: z.number().optional(),
  fovDeg: z.number().gt(0).lt(180).optional(),
  width: z.number().int().positive().max(8192).optional(),
  height: z.number().int().positive().max(8192).optional(),
  maxPoints: z.number().int().positive().optional(),
  calibrationPath: z.string().optional(),
  outDir: z.string().optional(),
}).strict().superRefine((value, context) => {
  if (value.target && (value.yawDeg !== undefined || value.pitchDeg !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "pass position+target OR yawDeg/pitchDeg, not both" });
  }
  if (value.assumeSpawnPose === false && !value.position) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "assumeSpawnPose is false, so an explicit position is required" });
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
  server.registerTool(
    "virtual_camera_from_app",
    {
      description:
        "Capture the foreground PICO emulator app, render the scanned world from the same explicitly reported pose, simulate visible surfaces, and compose a labeled side-by-side. The default pose is an assumption: the bridge has scene entities but NO live head pose. The adb image is a real emulator display capture; the companion frame is host synthetic (usd_host_render at best), and the composition earns no visual claim until LOOKed at.",
      inputSchema: virtualCameraFromAppInputSchema,
    },
    async (args) => {
      try {
        return okJson({ status: "ok", ...await virtualCameraFromApp(args as VirtualCameraFromAppOptions) });
      } catch (error: any) {
        return okJson({ status: "error", error: error?.message ?? String(error), honesty: VIRTUAL_FROM_APP_HONESTY });
      }
    },
  );
}
