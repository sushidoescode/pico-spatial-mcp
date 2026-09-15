import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, okJson } from "./util.js";

/**
 * unitygen.ts — v30: the Unity half of the seam (spec .dev/specs/2026-07-28-unity-mcp-seam-design.md).
 * Emits a complete Unity project from the packaged unityskeleton/ — the appskeleton mechanism
 * applied to Unity. The payload is ~11 text files because ALL Unity configuration happens
 * programmatically at build time (PicoBuild.cs), the pattern the hello-XR settling test proved.
 * Windowed by default (vision-verifiable on today's emulator); immersive: true adds the pinned
 * PICO OpenXR git dep + the XR setup overlay (structural ceiling on 0.13.x — stated in `next`).
 * spatialAdapter injects registry/deps/define — the slot PICO's pending packages drop into.
 *
 * Module-relative paths via fileURLToPath, never new URL().pathname (verify-tarball [M6]).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const UNITY_SKELETON_ROOT = path.join(here, "..", "unityskeleton");
export const UNITY_XR_DEP = "com.unity.xr.openxr.picoxr";
export const UNITY_XR_PIN =
  "https://github.com/Pico-Developer/PICO-Unity-OpenXR-SDK.git#3aa3e62bff41df618529eeb60ff02c29a515dafe";

/** Files that must ship for the Unity lane to work. preflight + the tarball gate assert these. */
export const UNITY_SKELETON_CANARIES = [
  "Packages/manifest.json",
  "ProjectSettings/ProjectVersion.txt",
  "Assets/PicoAgent/picoagent-config.json",
  "Assets/PicoAgent/PicoAgentBridge.cs",
  "Assets/PicoAgent/SpatialAdapterSlot.cs",
  "Assets/Scripts/HelloSpatialRuntime.cs",
  "Assets/Plugins/Android/PicoDebugCmdReceiver.java",
  "Assets/Editor/PicoBuild.cs",
  "_immersive/Assets/Editor/PicoXrSetup.cs",
  "_immersive/Assets/Editor/ControllerlessManifestPatch.cs",
  "_gitignore",
];

/** Structural payload check (stat injectable for preflight fixtures; real fs adds emptiness). */
export function verifyUnitySkeleton(statMtimeMs?: (p: string) => number | null): { ok: boolean; root: string; missing: string[]; empty: string[] } {
  const stat =
    statMtimeMs ??
    ((p: string) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return null;
      }
    });
  const missing = UNITY_SKELETON_CANARIES.filter((rel) => stat(path.join(UNITY_SKELETON_ROOT, ...rel.split("/"))) == null);
  const empty = statMtimeMs
    ? []
    : UNITY_SKELETON_CANARIES.filter((rel) => {
        if (missing.includes(rel)) return false;
        try {
          return fs.statSync(path.join(UNITY_SKELETON_ROOT, ...rel.split("/"))).size === 0;
        } catch {
          return false;
        }
      });
  return { ok: missing.length === 0 && empty.length === 0, root: UNITY_SKELETON_ROOT, missing, empty };
}

export interface UnityGenerateOptions {
  targetDir: string;
  packageName: string;
  productName: string;
  immersive?: boolean;
  spatialAdapter?: {
    registry?: { name: string; url: string; scopes: string[] };
    dependencies: Record<string, string>;
    define?: string;
  };
  extraDefines?: string[];
}

export interface UnityGenerateResult {
  created: string;
  packageName: string;
  productName: string;
  mode: "windowed" | "immersive";
  filesWritten: number;
  buildEntry: "PicoBuild.Apk";
  configPath: string;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".DS_Store") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(p);
    }
  };
  rec(dir);
  return out;
}

export function generateUnityProject(opts: UnityGenerateOptions): UnityGenerateResult {
  const { targetDir, packageName, productName } = opts;
  const immersive = opts.immersive === true;
  const skel = verifyUnitySkeleton();
  if (!skel.ok)
    throw new Error(`packaged unity skeleton incomplete at ${skel.root} — missing: ${[...skel.missing, ...skel.empty].join(", ")} (reinstall the package)`);
  if (fs.existsSync(targetDir)) throw new Error(`Target already exists: ${targetDir}`);
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName)) throw new Error(`invalid packageName: ${packageName}`);

  let filesWritten = 0;
  for (const abs of walkFiles(UNITY_SKELETON_ROOT)) {
    const rel = path.relative(UNITY_SKELETON_ROOT, abs).split(path.sep).join("/");
    if (rel.startsWith("_immersive/")) continue; // overlay applied below, immersive only
    const relOut = rel === "_gitignore" ? ".gitignore" : rel;
    const outAbs = path.join(targetDir, ...relOut.split("/"));
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.copyFileSync(abs, outAbs);
    filesWritten++;
  }
  if (immersive) {
    const overlay = path.join(UNITY_SKELETON_ROOT, "_immersive");
    for (const abs of walkFiles(overlay)) {
      const rel = path.relative(overlay, abs).split(path.sep).join("/");
      const outAbs = path.join(targetDir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.copyFileSync(abs, outAbs);
      filesWritten++;
    }
  }

  // Packages/manifest.json: XR dep (immersive) + SpatialAdapter registry/deps.
  const manifestPath = path.join(targetDir, "Packages", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (immersive) manifest.dependencies[UNITY_XR_DEP] = UNITY_XR_PIN;
  if (opts.spatialAdapter) {
    if (opts.spatialAdapter.registry) {
      manifest.scopedRegistries = [...(manifest.scopedRegistries ?? []), opts.spatialAdapter.registry];
    }
    for (const [id, version] of Object.entries(opts.spatialAdapter.dependencies)) manifest.dependencies[id] = version;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // picoagent-config.json: the contract PicoBuild.Apk reads at build time.
  const configPath = path.join(targetDir, "Assets", "PicoAgent", "picoagent-config.json");
  const defines = [...(opts.extraDefines ?? [])];
  if (opts.spatialAdapter) defines.push(opts.spatialAdapter.define ?? "PICO_SPATIAL_ADAPTER");
  fs.writeFileSync(configPath, JSON.stringify({ packageName, productName, immersive, extraDefines: defines }, null, 2) + "\n");

  return {
    created: targetDir,
    packageName,
    productName,
    mode: immersive ? "immersive" : "windowed",
    filesWritten,
    buildEntry: "PicoBuild.Apk",
    configPath,
  };
}

export function registerUnityGenTools(server: McpServer) {
  server.registerTool(
    "unity_scaffold_project",
    {
      description:
        "Create a Unity project for the PICO seam from the packaged skeleton (no machine-local template; ~11 text files — all Unity config is applied programmatically at build time by PicoBuild.Apk). DEFAULT mode is a 2D WINDOWED Android activity — honestly vision-verifiable on today's emulator, and closest to the OS 6 shared-space model. immersive: true adds the pinned PICO OpenXR SDK (structural ceiling on emulator 0.13.x: session+layers run, pixels do not composite — settled 2026-07-22). spatialAdapter injects PICO's (pending) SpatialAdapter packages: scoped registry / git URLs / file: tarballs all work. The app carries the <applicationId>.DEBUG_CMD drive contract (ping / color:<html-color> / spin:<on|off>). Build with unity_build_apk; verify with verify_pico_apk.",
      inputSchema: {
        targetDir: z.string().describe("Directory to create (must not exist)."),
        packageName: z
          .string()
          .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
          .describe("applicationId, e.g. com.demo.unityhello"),
        productName: z.string().describe("Unity product name (app display name)."),
        immersive: z.boolean().optional().describe("true = OpenXR immersive config (structural-only on the current emulator). Default false = windowed."),
        spatialAdapter: z
          .object({
            registry: z.object({ name: z.string(), url: z.string(), scopes: z.array(z.string()) }).optional(),
            dependencies: z.record(z.string()).describe("UPM id -> version | git URL | file: tarball path"),
            define: z.string().optional().describe("Scripting define guarding SpatialAdapterSlot (default PICO_SPATIAL_ADAPTER)"),
          })
          .optional()
          .describe("The slot for PICO's SpatialAdapter Unity packages (pending from PICO)."),
        extraDefines: z.array(z.string()).optional().describe("Additional Android scripting defines PicoBuild applies."),
      },
    },
    async (opts) => {
      try {
        const targetDir = opts.targetDir.replace(/^~\//, `${process.env.HOME}/`);
        const r = generateUnityProject({ ...opts, targetDir });
        return okJson({
          ...r,
          next: [
            `unity_build_apk with projectDir='${r.created}' (first build resolves packages — network needed${r.mode === "immersive" ? "; immersive pixels stay structural on emulator 0.13.x" : ""}).`,
            `Then verify_pico_apk with the built APK + packageName='${r.packageName}' + the serial of the device to observe (no default target).`,
            `Drive it: adb shell am broadcast -a ${r.packageName}.DEBUG_CMD --es cmd ping   (logcat tag PicoAgent, prefix PICOAGENT|).`,
          ],
        });
      } catch (e: any) {
        return fail(`unity scaffold failed: ${e.message}`);
      }
    },
  );
}
