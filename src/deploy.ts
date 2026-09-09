import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, runBinary, okJson, fail, image, expandHome } from "./util.js";
import { completeDependencies } from "./dependencies.js";
import { probeDeviceIdentity, selectPicoDevice } from "./swanparity.js";
import { validateCaptureBuffer } from "./evidence.js";

/**
 * deploy_to_device — the PICO Swan (hardware) deploy+verify path. DORMANT until a Swan headset is
 * attached over USB (none exists today — emulator-only). It detects a non-emulator adb device and,
 * if present, installs/launches/captures/sanity-checks; if absent it returns a clear dormant status
 * and CANNOT crash the autonomous loop. This is the day-one-on-Swan handoff, wired in advance.
 * A non-emulator serial is no longer trusted blindly. Every candidate is identity-probed; an
 * unrecognized identity is refused and multiple plausible PICO devices require an explicit serial.
 */
function resolveAdb(): string {
  const c = [process.env.PICO_ADB, path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb"), "/opt/homebrew/bin/adb", "adb"].filter(Boolean) as string[];
  for (const x of c) if (x === "adb" || fs.existsSync(x)) return x;
  return "adb";
}

interface DeployDependencies {
  runFn: typeof run;
  runBinaryFn: typeof runBinary;
  probeDeviceIdentityFn: typeof probeDeviceIdentity;
  resolveAdbFn: typeof resolveAdb;
  sleepFn: (ms: number) => Promise<void>;
}

export function registerDeployTools(server: McpServer, overrides: Partial<DeployDependencies> = {}) {
  const deps = completeDependencies<DeployDependencies>(
    "registerDeployTools", overrides,
    { runFn: true, runBinaryFn: true, probeDeviceIdentityFn: true, resolveAdbFn: true, sleepFn: true },
    () => ({ runFn: run, runBinaryFn: runBinary, probeDeviceIdentityFn: probeDeviceIdentity, resolveAdbFn: resolveAdb,
      sleepFn: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }),
  );
  const { runFn, runBinaryFn, probeDeviceIdentityFn: identityProbe, sleepFn } = deps;
  server.registerTool(
    "deploy_to_device",
    {
      description:
        "Deploy + sanity-verify on a PICO Swan HEADSET over USB (the hardware handoff). DORMANT today — no Swan exists, so with only the emulator attached it returns a clear dormant status. Every online non-emulator candidate is identity-probed: phones, Quest, and emulator-over-TCP are refused; multiple PICO-shaped devices require deviceSerial. There is no identity override. When the gate passes it installs, launches, and captures a first shell-composite frame for a later LOOK. This path has not been exercised on Swan hardware.",
      inputSchema: {
        apkPath: z.string().describe("Path to the built .apk to deploy."),
        packageName: z.string().describe("App package, e.g. com.example.app."),
        activity: z.string().optional().describe("Launcher activity (default .platform.LaunchActivity)."),
        deviceSerial: z.string().optional().describe("Explicit online adb serial. Required when more than one PICO-shaped candidate is attached; unrecognized identities are refused."),
      },
    },
    async ({ apkPath, packageName, activity, deviceSerial }) => {
      const adb = deps.resolveAdbFn();
      const listed = await runFn(adb, ["devices"], { timeoutMs: 10_000 });
      if (listed.code !== 0 || listed.timedOut) return fail(`adb devices failed (exit ${listed.code}${listed.timedOut ? ", timeout" : ""}): ${listed.stderr.trim() || "no stderr"}`);
      const devs = listed.stdout
        .split("\n").slice(1).map((l) => l.trim()).filter((l) => l && l.includes("\tdevice")).map((l) => l.split("\t")[0]);
      const selection = await selectPicoDevice(devs, deviceSerial, (serial) => identityProbe(adb, serial));
      if (selection.status === "no_candidate") {
        return okJson({
          status: "dormant",
          reason: "No PICO hardware (Swan) connected over USB — emulator-only today. This path is WIRED and activates the moment a Swan is attached; it cannot crash the loop.",
          devicesSeen: devs,
          nextOnSwan: "Connect the Swan over USB, then re-run: install -r the APK, launch, capture the first frame, run assert_scene + a vision pass, and work through swan_bring_up_checklist.",
        });
      }
      if (selection.status !== "selected" || !selection.selected) {
        return okJson({
          status: selection.status === "ambiguous" ? "identity_ambiguous" : "identity_blocked",
          identities: selection.identities,
          ...(selection.probeErrors.length ? { identityProbeErrors: selection.probeErrors } : {}),
          reason: selection.reason,
          fix: selection.status === "ambiguous"
            ? "Re-run with deviceSerial naming exactly one of the PICO-shaped candidates."
            : "Connect a device whose live model/fingerprint identify as PICO hardware; no override is accepted.",
        });
      }
      const identity = selection.selected;
      const dev = identity.serial;
      const apk = expandHome(apkPath);
      if (!fs.existsSync(apk)) return fail(`APK not found: ${apk}`);
      const inst = await runFn(adb, ["-s", dev, "install", "-r", apk], { timeoutMs: 300_000 });
      if (inst.code !== 0 || inst.timedOut || !/Success/i.test(inst.stdout + inst.stderr)) return fail(`Install on ${dev} failed: ${(inst.stdout + inst.stderr).slice(0, 300)}`);
      const stopped = await runFn(adb, ["-s", dev, "shell", "am", "force-stop", packageName], { timeoutMs: 10_000 });
      if (stopped.code !== 0 || stopped.timedOut) return fail(`Could not force-stop ${packageName} on ${dev} before launch (exit ${stopped.code}${stopped.timedOut ? ", timeout" : ""}): ${(stopped.stderr || stopped.stdout).trim().slice(0, 300)}`);
      const component = `${packageName}/${activity ?? ".platform.LaunchActivity"}`;
      const launched = await runFn(adb, ["-s", dev, "shell", "am", "start", "-S", "-n", component], { timeoutMs: 15_000 });
      const launchText = `${launched.stdout}\n${launched.stderr}`;
      if (launched.code !== 0 || launched.timedOut || !/\bStarting:\s+Intent\b/i.test(launchText)) {
        return fail(`Launch of ${component} on ${dev} was not accepted (exit ${launched.code}${launched.timedOut ? ", timeout" : ""}); no screenshot will be labeled as this app: ${launchText.trim().slice(0, 400)}`);
      }
      const parsePids = (text: string) => /^\d+(?:\s+\d+)*$/.test(text.trim()) ? text.trim().split(/\s+/) : [];
      let observedPids: string[] = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        const pid = await runFn(adb, ["-s", dev, "shell", "pidof", packageName], { timeoutMs: 10_000 });
        const pids = pid.code === 0 && !pid.timedOut ? parsePids(pid.stdout) : [];
        if (pids.length) {
          observedPids = pids;
          break;
        }
        await sleepFn(1_000);
      }
      if (!observedPids.length) return fail(`Launch of ${component} was accepted, but ${packageName} never exposed a live PID; it may have crashed or the package/activity may be wrong. No shell screenshot is treated as app evidence.`);
      await sleepFn(1_000);
      const stablePid = await runFn(adb, ["-s", dev, "shell", "pidof", packageName], { timeoutMs: 10_000 });
      const stablePids = stablePid.code === 0 && !stablePid.timedOut ? parsePids(stablePid.stdout) : [];
      const survivingPids = observedPids.filter((pid) => stablePids.includes(pid));
      if (!survivingPids.length) return fail(`${packageName} PID changed from ${observedPids.join(" ")} to ${stablePids.join(" ") || "none"} before capture; the process disappeared or restarted, so launch health is unstable and the shell frame is not app evidence.`);
      const shot = await runBinaryFn(adb, ["-s", dev, "exec-out", "screencap", "-p"], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 * 1024 });
      const postCapturePid = await runFn(adb, ["-s", dev, "shell", "pidof", packageName], { timeoutMs: 10_000 });
      const postCapturePids = postCapturePid.code === 0 && !postCapturePid.timedOut ? parsePids(postCapturePid.stdout) : [];
      const continuousPids = survivingPids.filter((pid) => postCapturePids.includes(pid));
      if (!continuousPids.length) return fail(`${packageName} PID ${survivingPids.join(" ")} exited or restarted during capture (now ${postCapturePids.join(" ") || "none"}); the shell frame is not app evidence.`);
      const captureCheck = shot.code === 0 && !shot.timedOut
        ? validateCaptureBuffer(shot.stdout, `adb screencap from ${dev}`)
        : { ok: false, reason: `adb screencap failed (exit ${shot.code}${shot.timedOut ? ", timeout" : ""}): ${shot.stderr.trim() || "no stderr"}` };
      const note =
        `Installed ${path.basename(apk)} and observed ${packageName} continuously alive (PID ${continuousPids.join(" ")}) on a PICO-shaped/non-emulator adb identity ${dev} (model '${identity.model}', fingerprint '${identity.fingerprint.slice(0, 80)}'). This proves only install + launch process health; LOOK at this shell-composite frame, then run assert_scene + the swan_bring_up_checklist. This workflow remains unverified on a real Swan in this repo. ` +
        `NOTE: this frame is adb screencap — the SHELL composite. A black frame is inconclusive: it can be a shell-capture limitation or a real render failure. Obtain and LOOK at an alternate immersive-output capture before concluding either cause.`;
      if (captureCheck.ok) return image(shot.stdout.toString("base64"), note);
      return okJson({ status: "launched_capture_unavailable", device: dev, identity: { model: identity.model, fingerprint: identity.fingerprint }, pid: continuousPids.join(" "), captureFailure: captureCheck.reason, note: note + " Screencap was unavailable or invalid; capture through another path and LOOK before recording visual evidence." });
    },
  );
}
