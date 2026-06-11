import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, image, ok, okJson, run, runBinary, sleep, tail } from "./util.js";
import { pickVersion, resolveToolsRoot } from "./toolchain.js";
import { adb, adbPath, resolveSerial } from "./adb.js";

/**
 * High-level orchestration: collapse the common edit→build→deploy→observe loop
 * into one call so an autonomous agent spends turns on decisions, not plumbing.
 */

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
      },
    },
    async ({ sceneDir, projectDir, workName, serial, deploy, toolsVersion }) => {
      const { root } = resolveToolsRoot();
      const sel = pickVersion(root, toolsVersion, "editor");
      if (!sel?.spatialbundle) return fail(`No spatialbundle found under ${root}`);
      const report: any = { steps: [] };

      // 1. pack — output to the project build dir (or a temp dir) to keep Sources/ clean
      const buildDir = projectDir ? path.join(expandHome(projectDir), "build", "spatial") : path.join(os.tmpdir(), "pico-mcp", "iterate");
      fs.mkdirSync(buildDir, { recursive: true });
      const outBundle = path.join(buildDir, `${workName}.bundle`);
      const packArgs = ["pack", "-s", expandHome(sceneDir), "-o", outBundle, "--formats", "usda", "--override-output", "--force-build"];
      if (projectDir) packArgs.push("-p", expandHome(projectDir));
      const pack = await run(sel.spatialbundle, packArgs, { timeoutMs: 600_000 });
      if (pack.code !== 0 || !fs.existsSync(outBundle)) {
        report.steps.push({ pack: "FAILED" });
        return fail(`iterate_scene: pack failed.\n${tail(pack.stdout + pack.stderr, 40)}`);
      }
      report.steps.push({ pack: "ok", bundle: outBundle, sizeMB: Number((fs.statSync(outBundle).size / 1024 / 1024).toFixed(2)) });

      // 2. inspect
      const info = await run(sel.spatialbundle, ["info", "--input", outBundle], { timeoutMs: 60_000 });
      const modelMatch = info.stdout.match(/Model Count:\s*(\d+)/);
      const assetMatch = info.stdout.match(/Asset Count:\s*(\d+)/);
      report.steps.push({ inspect: "ok", models: modelMatch?.[1] ?? "?", assets: assetMatch?.[1] ?? "?" });

      if (!deploy) return okJson(report);

      // 3. deploy to ScenePreview (reuse the editor module's protocol inline)
      const s = await resolveSerial(serial);
      const PKG = "com.pico.spatial.editor.scenepreview";
      const filesDir = `/storage/emulated/0/Android/data/${PKG}/files`;
      const macosDir = path.join(root, sel.version, "editor", "Spatial Editor.app", "Contents", "MacOS");
      const apk = path.join(macosDir, "scene_preview", "ScenePreview.apk");
      const present = await adb(["-s", s, "shell", "pm", "path", PKG]);
      if (!/package:/.test(present.stdout) && fs.existsSync(apk)) {
        await adb(["-s", s, "install", "-r", apk], 180_000);
      }
      const remote = `${filesDir}/${path.basename(outBundle)}`;
      await adb(["-s", s, "shell", "mkdir", "-p", filesDir]);
      await adb(["-s", s, "push", outBundle, remote], 300_000);
      const sceneName = workName;
      await adb(["-s", s, "shell", "am", "start", "-n", `${PKG}/.platform.LaunchActivity`, "--es", "sceneName", sceneName, "--es", "previewConfig", "{}", "--ef", "cameraHeightOffset", "0"]);
      await sleep(2500);
      await adb(["-s", s, "shell", "am", "broadcast", "-a", `${PKG}.FILE_TRANSFER_COMPLETE`, "--es", "filePath", remote, "--es", "sceneName", sceneName, "--es", "previewConfig", "{}", "--ef", "cameraHeightOffset", "0"]);
      await sleep(3000);

      const logErr = (await adb(["-s", s, "logcat", "-d", "-t", "150"])).stdout.split("\n").find((l) => /LoadFromStorage failed|Failed to load resource/.test(l));
      report.steps.push({ deploy: logErr ? "loaded-with-warning" : "ok", remote, warning: logErr?.trim().slice(0, 160) });

      const shot = await runBinary(await adbPath(), ["-s", s, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      if (shot.code === 0 && shot.stdout.length > 8) {
        return image(shot.stdout.toString("base64"), JSON.stringify(report, null, 2));
      }
      return okJson({ ...report, screenshot: "failed" });
    },
  );

  server.registerTool(
    "build_and_run",
    {
      description:
        "Full app loop: Gradle-build the spatial APK (scenes are packed automatically by the com.pico.spatial.tools plugin), install it on the running emulator, launch it, wait for boot, and screenshot. The end-to-end 'ship it to the device' path.",
      inputSchema: {
        projectDir: z.string().describe("Android project root (has gradlew)"),
        packageName: z.string().describe("App package to launch, e.g. com.example.app"),
        task: z.string().default("assembleDebug"),
        activity: z.string().optional(),
        serial: z.string().optional(),
        settleSec: z.number().int().default(6),
      },
    },
    async ({ projectDir, packageName, task, activity, serial, settleSec }) => {
      const dir = expandHome(projectDir);
      const gradlew = path.join(dir, "gradlew");
      if (!fs.existsSync(gradlew)) return fail(`No gradlew at ${gradlew}`);
      const report: any = { steps: [] };

      const build = await run(gradlew, [task, "--console=plain"], { cwd: dir, timeoutMs: 1_800_000 });
      if (build.code !== 0) return fail(`Gradle '${task}' failed:\n${tail(build.stdout + build.stderr, 60)}`);

      // newest apk under build/
      const apks: { p: string; m: number }[] = [];
      const walk = (d: string, depth = 0) => {
        if (depth > 8) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (e.name.endsWith(".apk") && p.includes(`${path.sep}build${path.sep}`)) apks.push({ p, m: fs.statSync(p).mtimeMs });
        }
      };
      walk(dir);
      if (!apks.length) return fail("Build succeeded but no APK found under build/");
      const apk = apks.sort((a, b) => b.m - a.m)[0].p;
      report.steps.push({ build: "ok", apk });

      const s = await resolveSerial(serial);
      const inst = await adb(["-s", s, "install", "-r", apk], 300_000);
      if (!/Success/i.test(inst.stdout + inst.stderr)) return fail(`Install failed: ${(inst.stdout + inst.stderr).trim()}`);
      report.steps.push({ install: "ok" });

      const launch = activity
        ? await adb(["-s", s, "shell", "am", "start", "-n", `${packageName}/${activity}`])
        : await adb(["-s", s, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"]);
      if (/Error|No activities found/i.test(launch.stdout + launch.stderr)) return fail(`Launch failed: ${(launch.stdout + launch.stderr).trim()}`);
      report.steps.push({ launch: "ok" });
      await sleep(settleSec * 1000);

      const crash = (await adb(["-s", s, "logcat", "-d", "-t", "400"])).stdout
        .split("\n")
        .filter((l) => /FATAL EXCEPTION|ANR in|E AndroidRuntime/.test(l) && l.includes(packageName));
      report.steps.push({ health: crash.length ? "CRASHED" : "ok", crashes: crash.slice(-4) });

      const shot = await runBinary(await adbPath(), ["-s", s, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      if (shot.code === 0 && shot.stdout.length > 8) {
        return image(shot.stdout.toString("base64"), JSON.stringify(report, null, 2));
      }
      return okJson(report);
    },
  );
}
