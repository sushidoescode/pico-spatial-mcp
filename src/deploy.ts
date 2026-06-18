import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, runBinary, okJson, fail, image, expandHome } from "./util.js";

/**
 * deploy_to_device — the PICO Swan (hardware) deploy+verify path. DORMANT until a Swan headset is
 * attached over USB (none exists today — emulator-only). It detects a non-emulator adb device and,
 * if present, installs/launches/captures/sanity-checks; if absent it returns a clear dormant status
 * and CANNOT crash the autonomous loop. This is the day-one-on-Swan handoff, wired in advance.
 */
function resolveAdb(): string {
  const c = [process.env.PICO_ADB, path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb"), "/opt/homebrew/bin/adb", "adb"].filter(Boolean) as string[];
  for (const x of c) if (x === "adb" || fs.existsSync(x)) return x;
  return "adb";
}

export function registerDeployTools(server: McpServer) {
  server.registerTool(
    "deploy_to_device",
    {
      description:
        "Deploy + sanity-verify on a PICO Swan HEADSET over USB (the hardware handoff). DORMANT today — no Swan exists, so with only the emulator attached it returns a clear dormant status (wired, will not crash the loop). When a Swan is connected it installs the APK, launches, captures the first frame, and reports it for an assert_scene + vision pass. Pair with swan_bring_up_checklist.",
      inputSchema: {
        apkPath: z.string().describe("Path to the built .apk to deploy."),
        packageName: z.string().describe("App package, e.g. com.example.app."),
        activity: z.string().optional().describe("Launcher activity (default .platform.LaunchActivity)."),
      },
    },
    async ({ apkPath, packageName, activity }) => {
      const adb = resolveAdb();
      const devs = (await run(adb, ["devices"], { timeoutMs: 10_000 })).stdout
        .split("\n").slice(1).map((l) => l.trim()).filter((l) => l && l.includes("\tdevice")).map((l) => l.split("\t")[0]);
      const headsets = devs.filter((d) => !d.startsWith("emulator-"));
      if (headsets.length === 0) {
        return okJson({
          status: "dormant",
          reason: "No PICO hardware (Swan) connected over USB — emulator-only today. This path is WIRED and activates the moment a Swan is attached; it cannot crash the loop.",
          devicesSeen: devs,
          nextOnSwan: "Connect the Swan over USB, then re-run: install -r the APK, launch, capture the first frame, run assert_scene + a vision pass, and work through swan_bring_up_checklist.",
        });
      }
      // A real (non-emulator) device IS attached — do the deploy.
      const dev = headsets[0];
      const apk = expandHome(apkPath);
      if (!fs.existsSync(apk)) return fail(`APK not found: ${apk}`);
      const inst = await run(adb, ["-s", dev, "install", "-r", apk], { timeoutMs: 300_000 });
      if (!/Success/i.test(inst.stdout + inst.stderr)) return fail(`Install on ${dev} failed: ${(inst.stdout + inst.stderr).slice(0, 300)}`);
      await run(adb, ["-s", dev, "shell", "am", "force-stop", packageName], { timeoutMs: 10_000 });
      await run(adb, ["-s", dev, "shell", "am", "start", "-S", "-n", `${packageName}/${activity ?? ".platform.LaunchActivity"}`], { timeoutMs: 15_000 });
      await new Promise((r) => setTimeout(r, 8000));
      const shot = await runBinary(adb, ["-s", dev, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      const note = `Deployed to PICO hardware ${dev}. LOOK at this frame, then run assert_scene + work the swan_bring_up_checklist (sense/plane pins, controller-ray, anchors).`;
      if (shot.code === 0 && shot.stdout.length > 1000) return image(shot.stdout.toString("base64"), note);
      return okJson({ status: "deployed", device: dev, note: note + " (screencap failed — capture manually.)" });
    },
  );
}
