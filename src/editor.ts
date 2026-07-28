import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, image, ok, okJson, run, runBinary, sleep, tail } from "./util.js";
import { pickVersion, resolveToolsRoot } from "./toolchain.js";
import { adb, adbPath, resolveSerial } from "./adb.js";

/**
 * Spatial Editor parity tools: project scaffolding, the editor's own headless
 * build mode (the same path the Android Studio plugin uses), and ScenePreview
 * deployment. All of it drives the user's installed editor — nothing is vendored.
 */

const PREVIEW_PKG = "com.pico.spatial.editor.scenepreview";
const PREVIEW_FILES_DIR = `/storage/emulated/0/Android/data/${PREVIEW_PKG}/files`;
const PREVIEW_ACTIVITY = `${PREVIEW_PKG}/.platform.LaunchActivity`;
// The editor signals an already-running ScenePreview to load a transferred bundle
// via this broadcast.
const PREVIEW_BROADCAST = `${PREVIEW_PKG}.FILE_TRANSFER_COMPLETE`;

/** Result codes written by the editor's --ide_resultCodeFile (from the Gradle plugin's BundleResult). */
const RESULT_CODES: Record<string, string> = {
  "0": "SUCCESS (temp)",
  "10000": "SUCCESS",
  "10001": "FILE_OCCUPY — project open in a different editor version",
  "10003": "PARAMS_ERROR",
  "10004": "TARGET_FILE_EMPTY",
  "10005": "ASSETS_LOST",
  "10006": "EDITOR_ERROR",
  "10007": "EDITOR_COMMON error",
};

interface EditorPaths {
  version: string;
  macosDir: string;
  editorBin: string;
  scenePreviewApk: string;
  templateScene: string;
  editorVersion: string;
}

function editorPaths(toolsVersion?: string): EditorPaths | { error: string } {
  const { root } = resolveToolsRoot();
  const sel = pickVersion(root, toolsVersion, "editor");
  if (!sel) return { error: `No editor payload found under ${root} (version ${toolsVersion ?? "any"})` };
  const macosDir = path.join(root, sel.version, "editor", "Spatial Editor.app", "Contents", "MacOS");
  const editorBin = path.join(macosDir, "Spatial Editor");
  if (!fs.existsSync(editorBin)) return { error: `Spatial Editor binary not found at ${editorBin}` };
  let editorVersion = "unknown";
  try {
    editorVersion = JSON.parse(fs.readFileSync(path.join(macosDir, "version"), "utf8")).version ?? "unknown";
  } catch {
    /* version file is informational only */
  }
  return {
    version: sel.version,
    macosDir,
    editorBin,
    scenePreviewApk: path.join(macosDir, "scene_preview", "ScenePreview.apk"),
    templateScene: path.join(macosDir, "resources", "builtin", "scenes", "scene.usda"),
    editorVersion,
  };
}

function findProjectFile(projectDir: string): string | null {
  if (!fs.existsSync(projectDir)) return null;
  const f = fs.readdirSync(projectDir).find((n) => n.endsWith(".spatialproject"));
  return f ? path.join(projectDir, f) : null;
}

/** Check the editor's lock-file protocol: <project>/.CacheData/lock holds a live editor PID. */
function projectLockedBy(projectDir: string): number | null {
  const lockFile = path.join(projectDir, ".CacheData", "lock");
  if (!fs.existsSync(lockFile)) return null;
  const pid = parseInt(fs.readFileSync(lockFile, "utf8").split("\n")[0].trim(), 10);
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function registerEditorTools(server: McpServer) {
  server.registerTool(
    "create_scene_project",
    {
      description:
        "Scaffold a new PICO Spatial Editor project (the structure the GUI editor creates): <name>.spatialproject, Sources/Scenes/<scene>.usda from the editor's template, Sources/Assets/, .Component/component.json. Place it under an Android module's src/main/res3d/ to integrate with the com.pico.spatial.tools Gradle plugin (one project per module).",
      inputSchema: {
        parentDir: z.string().describe("Directory to create the project folder in, e.g. <module>/src/main/res3d"),
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Project name (also the folder and .spatialproject name)"),
        sceneName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).default("MyScene"),
        toolsVersion: z.string().optional(),
      },
    },
    async ({ parentDir, name, sceneName, toolsVersion }) => {
      const ep = editorPaths(toolsVersion);
      if ("error" in ep) return fail(ep.error);
      const projDir = path.join(expandHome(parentDir), name);
      if (fs.existsSync(projDir)) return fail(`Already exists: ${projDir}`);

      const template = fs.existsSync(ep.templateScene)
        ? fs.readFileSync(ep.templateScene, "utf8")
        : `#usda 1.0\n(\n    defaultPrim = "Root"\n    metersPerUnit = 1\n    upAxis = "Y"\n)\n\ndef Xform "Root" (\n    kind = "component"\n)\n{\n}\n`;

      fs.mkdirSync(path.join(projDir, "Sources", "Scenes"), { recursive: true });
      fs.mkdirSync(path.join(projDir, "Sources", "Assets"), { recursive: true });
      fs.mkdirSync(path.join(projDir, ".Component"), { recursive: true });
      fs.writeFileSync(
        path.join(projDir, `${name}.spatialproject`),
        JSON.stringify({ projectName: name, version: ep.editorVersion }, null, 4) + "\n",
      );
      fs.writeFileSync(path.join(projDir, "Sources", "Scenes", `${sceneName}.usda`), template);
      fs.writeFileSync(path.join(projDir, ".Component", "component.json"), JSON.stringify({ components: [] }, null, 2) + "\n");
      fs.writeFileSync(
        path.join(projDir, ".gitignore"),
        "\n#project cache data\n.CacheData\n\n#project library\n.Library\n\n#user settings\nUserSettings/EditorSceneSettings.yaml\nUserSettings/EditorUserSettings.yaml\nUserSettings/EditorViewportSettings.yaml\nUserSettings/history.json\n",
      );
      return okJson({
        projectDir: projDir,
        projectFile: path.join(projDir, `${name}.spatialproject`),
        scene: path.join(projDir, "Sources", "Scenes", `${sceneName}.usda`),
        editorVersion: ep.editorVersion,
        next: `Edit the scene USDA (see scene_schemas for PICO prim types), then pack_bundle with sceneDir=${path.join(projDir, "Sources", "Scenes")} or build_spatial_project with projectDir=${projDir}`,
      });
    },
  );

  server.registerTool(
    "build_spatial_project",
    {
      description:
        "Build a full .spatialproject using the Spatial Editor's own headless mode (--ide_noGraphics — the exact path the Android Studio plugin uses). Use this instead of pack_bundle when the project uses editor-managed features (components, timelines) and you want build parity with the GUI. Respects the editor's lock-file protocol.",
      inputSchema: {
        projectDir: z.string().describe("Directory containing <Name>.spatialproject"),
        outputDir: z.string().optional().describe("Bundle output dir (default <projectDir>/build)"),
        resultName: z.string().optional().describe("Output bundle filename (default <Name>.bundle)"),
        specialScenes: z.array(z.string()).default([]).describe("Optional subset of scenes to build"),
        timeoutSec: z.number().int().default(300),
        toolsVersion: z.string().optional(),
      },
    },
    async ({ projectDir, outputDir, resultName, specialScenes, timeoutSec, toolsVersion }) => {
      const ep = editorPaths(toolsVersion);
      if ("error" in ep) return fail(ep.error);
      const dir = expandHome(projectDir);
      const projectFile = findProjectFile(dir);
      if (!projectFile) return fail(`No .spatialproject file found in ${dir}`);
      const lockPid = projectLockedBy(dir);
      if (lockPid)
        return fail(
          `Project is open in a running Spatial Editor (pid ${lockPid}). Close it (or build via its GUI) — headless build would conflict.`,
        );

      const name = path.basename(projectFile, ".spatialproject");
      const outDir = expandHome(outputDir ?? path.join(dir, "build"));
      fs.mkdirSync(outDir, { recursive: true });
      const outName = resultName ?? `${name}.bundle`;
      const resultFile = path.join(os.tmpdir(), "pico-mcp", `ide-build-result-${Date.now()}.json`);
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });

      const args = [
        `--project=${projectFile}`,
        "--ide_noGraphics",
        `--ide_buildOutputDir=${outDir}`,
        `--ide_buildResultName=${outName}`,
        `--ide_buildSpecialScenes=${specialScenes.join(",")}`,
        `--ide_resultCodeFile=${resultFile}`,
        "--ide_buildAdditivePath=test_ide_buildAdditivePath",
      ];
      const r = await run(ep.editorBin, args, { cwd: ep.macosDir, timeoutMs: timeoutSec * 1000 });

      let resultJson: any = null;
      if (fs.existsSync(resultFile)) {
        try {
          resultJson = JSON.parse(fs.readFileSync(resultFile, "utf8"));
        } catch {
          resultJson = { raw: fs.readFileSync(resultFile, "utf8") };
        }
      }
      const code = String(resultJson?.data?.code ?? "");
      const bundlePath = path.join(outDir, outName);
      const bundleExists = fs.existsSync(bundlePath);
      const success = bundleExists && (code === "10000" || code === "0" || code === "");

      const summary = {
        success,
        bundle: bundleExists ? bundlePath : null,
        bundleSizeMB: bundleExists ? Number((fs.statSync(bundlePath).size / 1024 / 1024).toFixed(2)) : null,
        resultCode: code || "(no result file written)",
        resultCodeMeaning: RESULT_CODES[code] ?? "unknown",
        exitCode: r.code,
        timedOut: r.timedOut,
        editorVersion: ep.editorVersion,
      };
      const log = tail((r.stdout + "\n" + r.stderr).trim(), 50);
      return success
        ? ok(`${JSON.stringify(summary, null, 2)}\n\nEditor output tail:\n${log}`)
        : fail(`Headless editor build failed.\n${JSON.stringify(summary, null, 2)}\n\nEditor output tail:\n${log}`);
    },
  );

  server.registerTool(
    "preview_scene",
    {
      description:
        "EXPERIMENTAL: Deploy a compiled .bundle to the Spatial Editor's ScenePreview app on the emulator/headset — the editor's own 'preview on device' path, without a full APK build. Installs ScenePreview.apk (from your editor installation), pushes the bundle to its files dir, launches it, and returns a screenshot.",
      inputSchema: {
        bundlePath: z.string().describe("Compiled .bundle to preview"),
        serial: z.string().optional(),
        screenshotAfterSec: z.number().default(5).describe("Seconds to wait before the verification screenshot (0 = skip)"),
        toolsVersion: z.string().optional(),
      },
    },
    async ({ bundlePath, serial, screenshotAfterSec, toolsVersion }) => {
      const ep = editorPaths(toolsVersion);
      if ("error" in ep) return fail(ep.error);
      const bundle = expandHome(bundlePath);
      if (!fs.existsSync(bundle)) return fail(`No such bundle: ${bundle}`);
      if (!fs.existsSync(ep.scenePreviewApk)) return fail(`ScenePreview.apk not found at ${ep.scenePreviewApk}`);
      const s = await resolveSerial(serial);
      const steps: string[] = [];

      // Ensure ScenePreview is installed (only reinstall if absent — install is slow).
      const present = await adb(["-s", s, "shell", "pm", "path", PREVIEW_PKG]);
      if (!/package:/.test(present.stdout)) {
        const inst = await adb(["-s", s, "install", "-r", ep.scenePreviewApk], 180_000);
        if (!/Success/i.test(inst.stdout + inst.stderr)) return fail(`ScenePreview install failed: ${(inst.stdout + inst.stderr).trim()}`);
        steps.push("ScenePreview.apk installed");
      } else {
        steps.push("ScenePreview already installed");
      }

      // The app's external files dir exists once it has run at least once.
      const remote = `${PREVIEW_FILES_DIR}/${path.basename(bundle)}`;
      await adb(["-s", s, "shell", "mkdir", "-p", PREVIEW_FILES_DIR]);
      const push = await adb(["-s", s, "push", bundle, remote], 300_000);
      if (push.code !== 0) return fail(`Bundle push failed: ${(push.stdout + push.stderr).trim()}\nSteps so far: ${steps.join("; ")}`);
      steps.push(`bundle pushed to ${remote}`);

      // Launch (or foreground) the preview app, then signal it to load the bundle
      // exactly the way the Spatial Editor does: a FILE_TRANSFER_COMPLETE broadcast
      // carrying filePath/sceneName. sceneName is the bundle stem (the model name).
      const sceneName = path.basename(bundle).replace(/\.bundle$/, "");
      const launch = await adb([
        "-s", s, "shell", "am", "start", "-n", PREVIEW_ACTIVITY,
        "--es", "sceneName", sceneName, "--es", "previewConfig", "{}", "--ef", "cameraHeightOffset", "0",
      ]);
      if (/Error|No activities found/i.test(launch.stdout + launch.stderr)) return fail(`ScenePreview launch failed: ${(launch.stdout + launch.stderr).trim()}`);
      await sleep(2500);
      const bcast = await adb([
        "-s", s, "shell", "am", "broadcast", "-a", PREVIEW_BROADCAST,
        "--es", "filePath", remote, "--es", "sceneName", sceneName, "--es", "previewConfig", "{}", "--ef", "cameraHeightOffset", "0",
      ]);
      steps.push(`load broadcast sent (${/result=0/.test(bcast.stdout) ? "delivered" : "see log"})`);

      // Surface any bundle-load error the app reported.
      const log = await adb(["-s", s, "logcat", "-d", "-t", "200"]);
      const loadErr = log.stdout.split("\n").find((l) => /LoadFromStorage failed|Failed to load resource/.test(l));
      if (loadErr) steps.push(`WARNING: ${loadErr.trim().slice(0, 160)}`);

      if (screenshotAfterSec > 0) {
        await sleep(screenshotAfterSec * 1000);
        const shot = await runBinary(await adbPath(), ["-s", s, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
        if (shot.code === 0 && shot.stdout.length > 8) {
          return image(shot.stdout.toString("base64"), `Preview deployed (${steps.join("; ")}). Verify the scene is visible.`);
        }
        steps.push("screenshot failed — verify manually");
      }
      return ok(steps.join("; "));
    },
  );
}
