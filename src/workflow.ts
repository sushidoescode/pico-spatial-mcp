import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, image, ok, okJson, run, runBinary, sleep, tail, type RunResult } from "./util.js";
import {
  gradleEnv,
  isToolchainFailure,
  prepareOperationToolchain,
  resolveOperationToolchain,
  settleOperationToolchain,
  toolchainProvenance,
  toolchainProvenanceLine,
  verifyOperationOverride,
  type OperationToolchain,
  type ToolComponent,
  ANDROID_PROJECT_ROOT_DESCRIPTION,
} from "./toolchain.js";
import { adb, adbPath, resolveSerial } from "./adb.js";
import { buildCapabilityMatrix } from "./capability.js";

/**
 * High-level orchestration: collapse the common edit→build→deploy→observe loop
 * into one call so an autonomous agent spends turns on decisions, not plumbing.
 */

export type AssembleTask = { modulePath: string; variantName: string };

/** Accept only an Android assemble task whose output can be tied to one module + variant. */
export function parseAssembleTask(task: string): AssembleTask | null {
  const match = /^(?:((?::[a-zA-Z0-9_-]+)+):)?assemble([A-Z][a-zA-Z0-9_]*)$/.exec(task);
  if (!match) return null;
  const prefix = match[1] ?? "";
  const moduleSegments = prefix ? prefix.split(":").filter(Boolean) : ["app"];
  if (!moduleSegments.length || moduleSegments.some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment))) return null;
  const variantSuffix = match[2];
  return { modulePath: path.join(...moduleSegments), variantName: variantSuffix[0].toLowerCase() + variantSuffix.slice(1) };
}

/** Resolve only the APK named by AGP's metadata for the requested assemble task and package. */
export function resolveAssembledApk(projectDir: string, task: string, packageName: string): { apk?: string; metadataPath?: string; reason?: string } {
  const parsed = parseAssembleTask(task);
  if (!parsed) return { reason: `task '${task}' is not a scoped Android assemble task (expected assembleDebug or :module:assembleVariant)` };
  const outputsRoot = path.join(projectDir, parsed.modulePath, "build", "outputs", "apk");
  if (!fs.existsSync(outputsRoot)) return { reason: `requested task output directory does not exist: ${outputsRoot}` };
  const metadataPaths: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 5) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(item, depth + 1);
      else if (entry.name === "output-metadata.json") metadataPaths.push(item);
    }
  };
  walk(outputsRoot);
  const matches: Array<{ apk: string; metadataPath: string }> = [];
  for (const metadataPath of metadataPaths) {
    let metadata: any;
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch { continue; }
    if (metadata?.variantName !== parsed.variantName || metadata?.applicationId !== packageName) continue;
    for (const element of Array.isArray(metadata.elements) ? metadata.elements : []) {
      if (typeof element?.outputFile !== "string" || path.basename(element.outputFile) !== element.outputFile) continue;
      const apk = path.join(path.dirname(metadataPath), element.outputFile);
      if (fs.existsSync(apk) && fs.statSync(apk).isFile() && fs.statSync(apk).size > 0) matches.push({ apk, metadataPath });
    }
  }
  if (matches.length !== 1) {
    return { reason: matches.length
      ? `requested ${parsed.modulePath}:${parsed.variantName} produced ${matches.length} APK candidates; select a single-output variant`
      : `no AGP output metadata bound task '${task}' to applicationId '${packageName}' and a non-empty APK` };
  }
  return matches[0];
}

export function launchResultSucceeded(result: RunResult, activity: string | undefined): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || /(?:^|\b)(?:Error|No activities found|device offline|monkey aborted)(?:\b|:)/i.test(output)) return false;
  return activity ? /Starting:|Warning: Activity not started|Status: ok/i.test(output) : /Events injected:\s*1|Monkey finished/i.test(output);
}

export function analyzePackageRuntimeLogs(pidLog: string, globalLog: string, packageName: string): { rendered: boolean; crashes: string[] } {
  const pidLines = pidLog.split("\n");
  const globalLines = globalLog.split("\n");
  const crashes = pidLines.filter((line) => /FATAL EXCEPTION|E AndroidRuntime|ANR in/.test(line));
  for (let index = 0; index < globalLines.length; index++) {
    const window = globalLines.slice(Math.max(0, index - 3), Math.min(globalLines.length, index + 4)).join("\n");
    if ((new RegExp(`ANR in\\s+${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")).test(globalLines[index])
        || (/FATAL EXCEPTION|E AndroidRuntime/.test(globalLines[index]) && window.includes(`Process: ${packageName}`))) {
      crashes.push(...globalLines.slice(Math.max(0, index - 1), Math.min(globalLines.length, index + 4)));
    }
  }
  const rendered = pidLines.some((line) => /FirstFrameRelease\(Displayed\)|SpatialView.*RenderEntity.*create texture success/.test(line));
  return { rendered, crashes: [...new Set(crashes.filter(Boolean))] };
}

/**
 * Everything a scene operation's stages need, injected so a test can capture the exact argv each
 * stage ran without spawning anything.
 */
export interface ScenePackDeps {
  /** The ONE selection this operation resolved. No stage below re-resolves it. */
  toolchain: OperationToolchain;
  run: (bin: string, args: string[], opts: { timeoutMs: number }) => Promise<RunResult>;
  exists: (p: string) => boolean;
  mkdirp: (p: string) => void;
  sizeBytes: (p: string) => number;
}

export interface ScenePackResult {
  bundle: string;
  sizeMB: number;
  /** Combined stdout of the inspect stage. */
  info: string;
  models: string | null;
  assets: string | null;
}

/**
 * Pack a scene directory and then inspect the bundle it produced.
 *
 * Both stages run `deps.toolchain.bin`. That is the whole point of taking the selection as a
 * parameter: an operation that re-resolved between stages could pack with one installation and
 * inspect with another, and report the second one's numbers as if they described the first.
 */
export async function packAndInspectScene(
  deps: ScenePackDeps,
  opts: { sceneDir: string; projectDir?: string; outBundle: string; details?: boolean },
): Promise<ScenePackResult | { error: string }> {
  const bin = deps.toolchain.bin;
  deps.mkdirp(path.dirname(opts.outBundle));
  const packArgs = ["pack", "-s", opts.sceneDir, "-o", opts.outBundle, "--formats", "usda", "--override-output", "--force-build"];
  if (opts.projectDir) packArgs.push("-p", opts.projectDir);
  const pack = await deps.run(bin, packArgs, { timeoutMs: 600_000 });
  if (pack.code !== 0 || !deps.exists(opts.outBundle)) {
    return { error: tail(pack.stdout + pack.stderr, 40) };
  }
  const infoArgs = ["info", "--input", opts.outBundle];
  if (opts.details) infoArgs.push("--details");
  const info = await deps.run(bin, infoArgs, { timeoutMs: 60_000 });
  return {
    bundle: opts.outBundle,
    sizeMB: Number((deps.sizeBytes(opts.outBundle) / 1024 / 1024).toFixed(2)),
    info: info.stdout,
    models: info.stdout.match(/Model Count:\s*(\d+)/)?.[1] ?? null,
    assets: info.stdout.match(/Asset Count:\s*(\d+)/)?.[1] ?? null,
  };
}

/** The host-backed stage runner. Tests pass their own; nothing here is reachable from a fixture. */
export function hostScenePackDeps(toolchain: OperationToolchain): ScenePackDeps {
  return {
    toolchain,
    run: (bin, args, opts) => run(bin, args, opts),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
    sizeBytes: (p) => fs.statSync(p).size,
  };
}

/**
 * Resolve ONE component-valid selection for a scene operation, before any stage runs.
 *
 * When the operation will also deploy through ScenePreview it asks for the editor payload in the
 * SAME request, so the packer and the ScenePreview APK cannot come from different installations.
 * The editor is a *preference*, not a precondition: ScenePreview may already be installed on the
 * device, and refusing to pack because the host's editor app bundle is gone would be a worse
 * answer than packing and letting the deploy stage skip the install (which it already did when
 * the APK was missing). The fallback happens here, before stage 1 — never between stages.
 */
export async function resolveSceneToolchain(
  opts: { toolsVersion?: string; androidProjectRoot?: string; needEditor?: boolean },
  resolve: typeof resolveOperationToolchain = resolveOperationToolchain,
  probe?: Parameters<typeof verifyOperationOverride>[1],
): Promise<OperationToolchain | { error: string }> {
  const base = {
    androidProjectRoot: opts.androidProjectRoot,
    toolsVersion: opts.toolsVersion,
    primary: "packer" as ToolComponent,
    allowBinaryOverride: true,
  };
  if (opts.needEditor) {
    const withEditor = resolve({ ...base, required: ["packer", "editor"] });
    if (!isToolchainFailure(withEditor)) return settleOperationToolchain(withEditor, probe);
  }
  return prepareOperationToolchain({ ...base, required: ["packer"] }, { probe, resolve });
}

export function registerWorkflowTools(server: McpServer) {
  server.registerTool(
    "iterate_scene",
    {
      description:
        "One-shot inner dev loop for a spatial scene: (1) compile the scene dir to a .bundle with spatialbundle, (2) inspect it, (3) deploy to the running emulator via ScenePreview, (4) screenshot. Returns a structured report + the screenshot. The fastest way for an agent to see a USDA edit rendered. (Build the full APK with build_and_run instead when you need the real app.)",
      inputSchema: {
        sceneDir: z.string().describe("Directory of scene files (e.g. <proj>/Sources/Scenes)"),
        projectDir: z.string().optional().describe("The .spatialproject dir, if applicable"),
        workName: z.string().default("iterate").describe("Base name for the bundle"),
        serial: z.string().optional(),
        deploy: z.boolean().default(true).describe("Deploy to ScenePreview + screenshot (false = compile/inspect only)"),
        toolsVersion: z.string().optional(),
        androidProjectRoot: z.string().optional().describe(ANDROID_PROJECT_ROOT_DESCRIPTION),
      },
    },
    async ({ sceneDir, projectDir, workName, serial, deploy, toolsVersion, androidProjectRoot }) => {
      // ONE selection for the whole operation. Deployment needs the editor payload too, so it is
      // part of the SAME request: the packer and the ScenePreview APK cannot come from different
      // installations, and no stage below resolves anything again.
      const ctx = await resolveSceneToolchain({ toolsVersion, androidProjectRoot, needEditor: deploy });
      if ("error" in ctx) return fail(`iterate_scene: ${ctx.error}`);
      const report: any = { steps: [], ...toolchainProvenance(ctx) };

      // 1. pack — output to the project build dir (or a temp dir) to keep Sources/ clean
      const buildDir = projectDir ? path.join(expandHome(projectDir), "build", "spatial") : path.join(os.tmpdir(), "pico-mcp", "iterate");
      const outBundle = path.join(buildDir, `${workName}.bundle`);
      const packed = await packAndInspectScene(hostScenePackDeps(ctx), {
        sceneDir: expandHome(sceneDir),
        projectDir: projectDir ? expandHome(projectDir) : undefined,
        outBundle,
      });
      if ("error" in packed) {
        report.steps.push({ pack: "FAILED" });
        return fail(`iterate_scene: pack failed with ${toolchainProvenanceLine(ctx)}.\n${packed.error}`);
      }
      report.steps.push({ pack: "ok", bundle: packed.bundle, sizeMB: packed.sizeMB });

      // 2. inspect (same binary, same selection)
      const modelMatch = packed.models;
      const assetMatch = packed.assets;
      report.steps.push({ inspect: "ok", models: modelMatch ?? "?", assets: assetMatch ?? "?" });

      if (!deploy) {
        const m = buildCapabilityMatrix(workName, [
          { name: "scene packs to .bundle", status: "structural", evidence: "spatialbundle pack ok" },
          { name: "bundle has geometry", status: "structural", evidence: `models=${modelMatch ?? "?"} assets=${assetMatch ?? "?"}` },
        ]);
        return ok(JSON.stringify(report, null, 2) + "\n\n" + m.markdown);
      }

      // 3. deploy to ScenePreview (reuse the editor module's protocol inline)
      const s = await resolveSerial(serial);
      const PKG = "com.pico.spatial.editor.scenepreview";
      const filesDir = `/storage/emulated/0/Android/data/${PKG}/files`;
      // The ScenePreview APK rides inside the SAME selection's editor payload.
      const editorBin = ctx.selection?.files.editor?.path ?? null;
      const apk = editorBin ? path.join(path.dirname(editorBin), "scene_preview", "ScenePreview.apk") : "";
      const present = await adb(["-s", s, "shell", "pm", "path", PKG]);
      if (!/package:/.test(present.stdout) && apk && fs.existsSync(apk)) {
        await adb(["-s", s, "install", "-r", apk], 180_000);
      }
      const remote = `${filesDir}/${path.basename(packed.bundle)}`;
      await adb(["-s", s, "shell", "mkdir", "-p", filesDir]);
      await adb(["-s", s, "push", packed.bundle, remote], 300_000);
      const sceneName = workName;
      await adb(["-s", s, "shell", "am", "start", "-n", `${PKG}/.platform.LaunchActivity`, "--es", "sceneName", sceneName, "--es", "previewConfig", "{}", "--ef", "cameraHeightOffset", "0"]);
      await sleep(2500);
      await adb(["-s", s, "shell", "am", "broadcast", "-a", `${PKG}.FILE_TRANSFER_COMPLETE`, "--es", "filePath", remote, "--es", "sceneName", sceneName, "--es", "previewConfig", "{}", "--ef", "cameraHeightOffset", "0"]);
      await sleep(3000);

      const logErr = (await adb(["-s", s, "logcat", "-d", "-t", "150"])).stdout.split("\n").find((l) => /LoadFromStorage failed|Failed to load resource/.test(l));
      report.steps.push({ deploy: logErr ? "loaded-with-warning" : "ok", remote, warning: logErr?.trim().slice(0, 160) });

      const m = buildCapabilityMatrix(workName, [
        { name: "scene packs to .bundle", status: "structural", evidence: "spatialbundle pack ok" },
        { name: "bundle has geometry", status: "structural", evidence: `models=${modelMatch ?? "?"} assets=${assetMatch ?? "?"}` },
        { name: "ScenePreview loads the scene", status: logErr ? "structural" : "logcat_asserted", evidence: logErr ? `load warning: ${logErr.trim().slice(0, 120)}` : "no load error in logcat" },
        { name: "visual appearance correct", status: "structural", evidence: "frame captured + RETURNED — LOOK (ScenePreview is a free-cam diorama); appearance NOT auto-verified" },
      ]);
      report.capability = m.summary;
      const note = JSON.stringify(report, null, 2) + "\n\n" + m.markdown;
      const shot = await runBinary(await adbPath(), ["-s", s, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      if (shot.code === 0 && shot.stdout.length > 8) {
        return image(shot.stdout.toString("base64"), note);
      }
      return ok(note);
    },
  );

  server.registerTool(
    "verify_scene",
    {
      description:
        "Compile a scene and verify it built correctly by inspecting the bundle's geometry — a STRUCTURAL pre-check (Model/Asset/mesh/texture/material counts + expected mesh names present) that COMPLEMENTS, never replaces, a LOOK at captured pixels. capture_frame uses adb display-0 screencap, which has produced stable forward frames for many measured runs but is not universally reliable for every immersive route; a black/absent app view is inconclusive until an alternate capture is LOOKed at. Reports Model/Asset/mesh/texture/material counts and checks expected mesh names.",
      inputSchema: {
        sceneDir: z.string(),
        projectDir: z.string().optional(),
        expectMeshNames: z.array(z.string()).default([]).describe("Mesh/asset names that must appear in the bundle"),
        minMeshes: z.number().int().optional().describe("Fail if fewer than this many mesh assets"),
        toolsVersion: z.string().optional(),
        androidProjectRoot: z.string().optional().describe(ANDROID_PROJECT_ROOT_DESCRIPTION),
      },
    },
    async ({ sceneDir, projectDir, expectMeshNames, minMeshes, toolsVersion, androidProjectRoot }) => {
      const ctx = await resolveSceneToolchain({ toolsVersion, androidProjectRoot });
      if ("error" in ctx) return fail(`verify_scene: ${ctx.error}`);
      const outBundle = path.join(os.tmpdir(), "pico-mcp", `verify-${Date.now()}.bundle`);
      const packed = await packAndInspectScene(hostScenePackDeps(ctx), {
        sceneDir: expandHome(sceneDir),
        projectDir: projectDir ? expandHome(projectDir) : undefined,
        outBundle,
        details: true,
      });
      if ("error" in packed) {
        return fail(`verify_scene: compile FAILED with ${toolchainProvenanceLine(ctx)}.\n${packed.error}`);
      }
      const txt = packed.info;
      const num = (re: RegExp) => Number(txt.match(re)?.[1] ?? 0);
      const meshNames = [...txt.matchAll(/Asset Name:\s*(.+?)\s*\n\s*Asset Type:\s*mesh/g)].map((m) => m[1].trim());
      const result = {
        compiled: true,
        models: num(/Model Count:\s*(\d+)/),
        assets: num(/Asset Count:\s*(\d+)/),
        meshAssets: (txt.match(/Asset Type:\s*mesh/g) || []).length,
        textureAssets: (txt.match(/Asset Type:\s*texture/g) || []).length,
        materialAssets: (txt.match(/Asset Type:\s*materialinstance/g) || []).length,
        meshNames: [...new Set(meshNames)],
        bundleSizeMB: packed.sizeMB,
        ...toolchainProvenance(ctx),
      };
      const problems: string[] = [];
      for (const want of expectMeshNames) if (!meshNames.some((n) => n.includes(want))) problems.push(`expected mesh '${want}' not found`);
      if (minMeshes != null && result.meshAssets < minMeshes) problems.push(`only ${result.meshAssets} mesh assets (< ${minMeshes})`);
      const out = { pass: problems.length === 0, ...result, problems };
      return problems.length ? fail(JSON.stringify(out, null, 2)) : okJson(out);
    },
  );

  server.registerTool(
    "build_and_run",
    {
      description:
        "POSIX-host app loop: run one scoped Android assemble task, resolve its APK through AGP output metadata for the requested package, install it, require a positive launch and live PID, inspect PID-scoped logs, and return a screenshot. build_and_run currently supports POSIX hosts only; native Windows execution remains unmeasured.",
      inputSchema: {
        projectDir: z.string().describe("Android project root (has gradlew)"),
        packageName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/).describe("Application ID to require in AGP output metadata and launch, e.g. com.example.app"),
        task: z.string().default("assembleDebug").describe("Scoped assemble task only, e.g. assembleDebug or :demo:assembleRelease"),
        activity: z.string().optional(),
        serial: z.string().optional(),
        settleSec: z.number().int().default(6),
      },
      // Typed contract (2026-07-28 revision lane, works on SDK v1). Success path only — every
      // failure branch returns isError (exempt). The honesty split is structural: `rendered` is a
      // logcat marker, `appearanceRule` states that NOTHING here is vision_verified.
      outputSchema: {
        apk: z.string().describe("The requested task/package APK selected through AGP output metadata."),
        installed: z.literal(true),
        launched: z.literal(true),
        health: z.enum(["ok", "CRASHED"]),
        rendered: z.boolean().describe("First-frame logcat marker seen during settle — a marker, not a look."),
        crashes: z.array(z.string()).describe("Last crash lines when health=CRASHED; empty otherwise."),
        capabilitySummary: z.string().describe("Auto-emitted honest capability matrix summary for this run."),
        screenshotIncluded: z.boolean().describe("Whether a frame rides along as image content — an agent must LOOK at it; appearance is NOT auto-verified."),
        appearanceRule: z.string(),
      },
    },
    async ({ projectDir, packageName, task, activity, serial, settleSec }) => {
      if (process.platform === "win32") {
        return fail("build_and_run currently supports POSIX hosts only; native Windows execution remains unmeasured. Build/install manually or run this tool from macOS/Linux.");
      }
      const dir = expandHome(projectDir);
      const gradlew = path.join(dir, "gradlew");
      if (!fs.existsSync(gradlew)) return fail(`No gradlew at ${gradlew}`);
      if (!parseAssembleTask(task)) {
        return fail(`Task '${task}' is not a scoped Android assemble task. Use assembleDebug or :module:assembleVariant; build_and_run will not reuse arbitrary stale APKs.`);
      }
      const report: any = { steps: [] };

      const build = await run(gradlew, [task, "--console=plain"], { cwd: dir, timeoutMs: 1_800_000, env: gradleEnv() });
      if (build.code !== 0) return fail(`Gradle '${task}' failed:\n${tail(build.stdout + build.stderr, 60)}`);
      const resolved = resolveAssembledApk(dir, task, packageName);
      if (!resolved.apk) return fail(`Gradle '${task}' succeeded, but its APK identity was not established: ${resolved.reason}`);
      const apk = resolved.apk;
      report.steps.push({ build: "ok", apk, outputMetadata: resolved.metadataPath });

      const s = await resolveSerial(serial);
      const inst = await adb(["-s", s, "install", "-r", apk], 300_000);
      if (inst.code !== 0 || !/Success/i.test(inst.stdout + inst.stderr)) return fail(`Install failed: ${(inst.stdout + inst.stderr).trim()}`);
      report.steps.push({ install: "ok" });

      // Clean relaunch + clear log so the render check sees a fresh frame.
      const stopped = await adb(["-s", s, "shell", "am", "force-stop", packageName]);
      if (stopped.code !== 0) return fail(`Could not force-stop ${packageName} before launch: ${(stopped.stdout + stopped.stderr).trim()}`);
      const cleared = await adb(["-s", s, "logcat", "-c"]);
      if (cleared.code !== 0) return fail(`Could not clear logcat before launch: ${(cleared.stdout + cleared.stderr).trim()}`);

      const launch = activity
        ? await adb(["-s", s, "shell", "am", "start", "-n", `${packageName}/${activity}`])
        : await adb(["-s", s, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"]);
      if (!launchResultSucceeded(launch, activity)) return fail(`Launch failed or was not positively acknowledged: ${(launch.stdout + launch.stderr).trim() || `(exit ${launch.code})`}`);

      // A successful am/monkey return is not proof the target process survived. Observe its PID.
      const pidDeadline = Date.now() + 5_000;
      let pid = "";
      do {
        const pidResult = await adb(["-s", s, "shell", "pidof", packageName]);
        if (pidResult.code === 0) pid = pidResult.stdout.trim().split(/\s+/).find((value) => /^\d+$/.test(value)) ?? "";
        if (pid || Date.now() >= pidDeadline) break;
        await sleep(500);
      } while (true);
      if (!pid) return fail(`Launch was acknowledged, but no live PID for ${packageName} appeared within 5 seconds.`);
      report.steps.push({ launch: "ok", pid });

      // Poll PID-scoped logs for render markers and correlate multiline crashes from global logcat.
      let rendered = false;
      let crash: string[] = [];
      const deadline = Date.now() + Math.max(0, settleSec) * 1000;
      do {
        const [pidLog, globalLog] = await Promise.all([
          adb(["-s", s, "logcat", "--pid", pid, "-d"]),
          adb(["-s", s, "logcat", "-d"]),
        ]);
        if (pidLog.code !== 0 || globalLog.code !== 0) {
          return fail(`Could not inspect runtime logs for ${packageName}: ${tail(pidLog.stderr || globalLog.stderr || pidLog.stdout || globalLog.stdout, 20)}`);
        }
        const observed = analyzePackageRuntimeLogs(pidLog.stdout, globalLog.stdout, packageName);
        rendered ||= observed.rendered;
        crash = observed.crashes;
        if (crash.length || Date.now() >= deadline) break;
        await sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
      } while (true);
      const aliveResult = await adb(["-s", s, "shell", "pidof", packageName]);
      const alive = aliveResult.code === 0 && aliveResult.stdout.trim().split(/\s+/).includes(pid);
      if (!alive && !crash.length) return fail(`${packageName} PID ${pid} disappeared during the observation window; no positive running-app claim was recorded.`);
      report.steps.push({ health: crash.length ? "CRASHED" : "ok", pidAlive: alive, rendered, crashes: crash.slice(-4) });

      // v3.5: auto-emit the honest capability matrix derived from the run's signals.
      // build_and_run did NOT look at the frame -> nothing is "vision_verified"; appearance stays
      // structural-only and is flagged for an agent vision pass (the frame IS returned below).
      const features: any[] = [
        { name: "APK compiles", status: "compiles", evidence: `gradle ${task}` },
        { name: "process runs without crash", status: crash.length ? "structural" : "logcat_asserted", evidence: crash.length ? `CRASHED: ${(crash[crash.length - 1] || "").slice(0, 120)}` : `PID ${pid} remained alive; no package-scoped FATAL/ANR observed` },
        { name: "first frame rendered (marker)", status: rendered ? "logcat_asserted" : "structural", evidence: rendered ? "FirstFrameRelease / RenderEntity marker" : "NO first-frame marker seen — may not have rendered" },
        { name: "visual appearance correct", status: "structural", evidence: crash.length ? "post-crash device frame returned — it is not evidence of app appearance" : "frame captured + RETURNED — an agent MUST LOOK (verify / capture_frame); appearance is NOT auto-verified" },
      ];
      const matrix = buildCapabilityMatrix(packageName, features);
      report.capability = matrix.summary;

      const shot = await runBinary(await adbPath(), ["-s", s, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      const note = JSON.stringify(report, null, 2) + "\n\n" + matrix.markdown;
      const screenshotIncluded = shot.code === 0 && shot.stdout.length > 8;
      const structuredContent: Record<string, unknown> = {
        apk,
        installed: true,
        launched: true,
        health: crash.length ? "CRASHED" : "ok",
        rendered,
        crashes: crash.slice(-4),
        capabilitySummary: matrix.summary,
        screenshotIncluded,
        appearanceRule: crash.length
          ? "the process crashed; the returned device frame may show shell/home and is not evidence of app appearance"
          : "frame captured and returned — an agent MUST LOOK (verify / capture_frame); appearance is NOT auto-verified",
      };
      if (screenshotIncluded) {
        return { ...image(shot.stdout.toString("base64"), note), structuredContent };
      }
      return { ...ok(note), structuredContent };
    },
  );
}
