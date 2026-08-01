import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, runBinary, okJson, fail, image, expandHome } from "./util.js";
import { probeDeviceIdentity } from "./swanparity.js";

/**
 * deploy_to_device — the PICO Swan (hardware) deploy+verify path. DORMANT until a Swan headset is
 * attached over USB (none exists today — emulator-only). It detects a non-emulator adb device and,
 * if present, installs/launches/captures/sanity-checks; if absent it returns a clear dormant status
 * and CANNOT crash the autonomous loop. This is the day-one-on-Swan handoff, wired in advance.
 * v31: a non-emulator serial is no longer trusted blindly — the getprop identity gate (shared with
 * swan_verify_matrix) demands assumeSwan:true for anything that doesn't look like PICO hardware
 * (a Quest 3 on this desk and the emulator over adb-over-TCP both hit this path).
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
        "Deploy + sanity-verify on a PICO Swan HEADSET over USB (the hardware handoff). DORMANT today — no Swan exists, so with only the emulator attached it returns a clear dormant status (wired, will not crash the loop). HARDWARE-IDENTITY GATE (v31): the target's getprop identity (ro.product.model + ro.build.fingerprint, both included in results) must look like PICO hardware — a phone, a Quest, or the emulator over adb-over-TCP is refused unless you pass assumeSwan:true. When the gate passes it installs the APK, launches, captures the first frame, and reports it for an assert_scene + vision pass. CAPTURE CAVEAT: the first-frame capture is adb screencap, which the v30.1 retraction proved captures the SHELL composite and is structurally blind to XR-runtime output — a black frame for an immersive app is a capture-path artifact, not proof of failure. Pair with swan_bring_up_checklist.",
      inputSchema: {
        apkPath: z.string().describe("Path to the built .apk to deploy."),
        packageName: z.string().describe("App package, e.g. com.example.app."),
        activity: z.string().optional().describe("Launcher activity (default .platform.LaunchActivity)."),
        assumeSwan: z.boolean().optional().describe("Override the hardware-identity gate: deploy even though the device's getprop identity does not look like PICO hardware. The probe result is still included."),
      },
    },
    async ({ apkPath, packageName, activity, assumeSwan }) => {
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
      // A non-emulator device IS attached — gate on its hardware identity before deploying.
      const dev = headsets[0];
      const identity = await probeDeviceIdentity(adb, dev);
      if (!identity.looksLikePico && !assumeSwan) {
        return okJson({
          status: "identity_blocked",
          device: dev,
          identity: { model: identity.model, fingerprint: identity.fingerprint, bootQemu: identity.bootQemu },
          reason: identity.reason,
          fix: "This non-emulator serial does not identify as PICO hardware — deploying would put on-device claims on the wrong machine (a Quest 3 over USB triggered exactly this live). If you are CERTAIN it is the Swan (e.g. a pre-release build with unexpected props), re-run with assumeSwan:true; the identity probe is included in the result either way.",
        });
      }
      const apk = expandHome(apkPath);
      if (!fs.existsSync(apk)) return fail(`APK not found: ${apk}`);
      const inst = await run(adb, ["-s", dev, "install", "-r", apk], { timeoutMs: 300_000 });
      if (!/Success/i.test(inst.stdout + inst.stderr)) return fail(`Install on ${dev} failed: ${(inst.stdout + inst.stderr).slice(0, 300)}`);
      await run(adb, ["-s", dev, "shell", "am", "force-stop", packageName], { timeoutMs: 10_000 });
      await run(adb, ["-s", dev, "shell", "am", "start", "-S", "-n", `${packageName}/${activity ?? ".platform.LaunchActivity"}`], { timeoutMs: 15_000 });
      await new Promise((r) => setTimeout(r, 8000));
      const shot = await runBinary(adb, ["-s", dev, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      const who = identity.looksLikePico ? "PICO hardware" : "device (assumeSwan override — identity did NOT look like PICO)";
      const note =
        `Deployed to ${who} ${dev} (model '${identity.model}', fingerprint '${identity.fingerprint.slice(0, 80)}'). LOOK at this frame, then run assert_scene + work the swan_bring_up_checklist (sense/plane pins, controller-ray, anchors). ` +
        `NOTE: this frame is adb screencap — the SHELL composite. If the app renders through the XR runtime a black frame here is a capture-path artifact, not failure (v30.1 retraction); verify immersive output another way before concluding anything.`;
      if (shot.code === 0 && shot.stdout.length > 1000) return image(shot.stdout.toString("base64"), note);
      return okJson({ status: "deployed", device: dev, identity: { model: identity.model, fingerprint: identity.fingerprint }, note: note + " (screencap failed — capture manually.)" });
    },
  );
}
