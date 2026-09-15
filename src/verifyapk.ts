import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";
import { adbExecutable } from "./adb.js";

const run = promisify(execFile);
/** THE shared adb lookup (src/adb.ts): explicit $PICO_ADB -> PATH -> the SELECTED toolchain's
 *  bundled platform-tools. Resolved PER CALL (identity-keyed, so a hit costs a stat) rather
 *  than frozen into a module constant at import time — this module is imported at server
 *  start, so an eager constant would re-freeze exactly what the identity keying unfreezes. */
const ADB = () => adbExecutable();
const SERIAL = "emulator-5554";
export const VERIFY_APK_TEARDOWN_MS = 2_000;

/**
 * verifyapk.ts — the CROSS-BUILDER DEPLOY+VERIFY handoff contract.
 *
 * An external builder (e.g. the user's separate Unity MCP that emits a PICO APK) hands us an
 * arbitrary .apk + its package/activity. We install it, launch it, structurally assert it BOOTS
 * WITHOUT CRASHING (pidof process-alive + a logcat FATAL/ANR scan), and capture ONE 2D frame — then
 * return an HONEST evidence matrix. We RECORD NOTHING: the caller LOOKS at the artifact and calls
 * record_verification itself. The matrix is structural; the returned pixels support only what the
 * caller actually LOOKS at. This adb path showed black for some immersive Unity runs but a later
 * same-moment OpenXR run did not reproduce that asymmetry, so black is inconclusive and gui_capture
 * is an alternate LOOK path, not a universal requirement. Hardware remains untested here. Every adb step is wrapped so a
 * failure becomes a structured field, never a throw.
 */
export function registerVerifyApkTools(server: McpServer) {
  server.registerTool(
    "verify_pico_apk",
    {
      description:
        "Cross-builder DEPLOY+VERIFY handoff: install and launch an arbitrary PICO APK, poll pidof, scan logcat for FATAL/ANR, and capture one adb frame. Automatic results are STRUCTURAL, not a visual XR claim. The caller must LOOK and record only what the exact returned pixels prove. Some immersive Unity runs produced black adb frames while a later same-moment OpenXR run did not; black is inconclusive, so inspect gui_capture as an alternate when available before assigning a rendering or capture-path cause. A full-space launch block triggers one explicit incumbent-stop/retry and is disclosed in recoveryNotes. Records nothing itself; step failures are structured.",
      inputSchema: {
        apkPath: z.string().describe("Absolute path to the .apk the external builder emitted."),
        packageName: z.string().describe("Android package id, e.g. com.example.unityxr."),
        activity: z.string().optional().describe("Fully-qualified launch activity (e.g. com.unity3d.player.UnityPlayerActivity). If omitted, launched via a monkey LAUNCHER intent."),
        expectLogcatContains: z.string().optional().describe("Optional substring to look for in logcat (e.g. a scene-ready log line). Sets logcatMatch true/false; null when not provided."),
        settleSec: z.number().min(0).max(120).optional().describe("Seconds to wait after launch before asserting (default 8)."),
      },
    },
    async ({ apkPath, packageName, activity, expectLogcatContains, settleSec }) => {
      const settle = settleSec ?? 8;
      const errors: string[] = [];

      // 1. install -r (reinstall, keep data)
      let installed = false;
      try {
        const r = await run(ADB(), ["-s", SERIAL, "install", "-r", apkPath], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
        installed = /Success/i.test(`${r.stdout}${r.stderr}`);
        if (!installed) errors.push(`install: ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
      } catch (e: any) {
        errors.push(`install: ${String(e?.stderr ?? e?.message ?? e).slice(0, 200)}`);
      }

      // 2. force-stop for a clean launch, then let the full-space container finish tearing down
      //    before starting another immersive activity. The OS 6 emulator rejects an immediate
      //    re-launch with "current full space don't allow start fullscreen" while its close
      //    animation is still in flight (reproduced by the Unity hello-XR settling test).
      //    CLEAR logcat after the pause so the crash/ANR scan remains scoped to THIS launch.
      try {
        await run(ADB(), ["-s", SERIAL, "shell", "am", "force-stop", packageName], { timeout: 20_000 });
        await new Promise((r) => setTimeout(r, VERIFY_APK_TEARDOWN_MS));
        await run(ADB(), ["-s", SERIAL, "logcat", "-c"], { timeout: 15_000 }).catch(() => {});
      } catch (e: any) {
        errors.push(`force-stop: ${String(e?.message ?? e).slice(0, 120)}`);
      }

      // 3. launch (explicit activity, else monkey LAUNCHER)
      // PLAIN start is deliberate: `am start -S` would force-stop the package a second time
      // immediately before launch and recreate the full-space teardown race fixed above.
      const launchArgs = activity
        ? ["-s", SERIAL, "shell", "am", "start", "-n", `${packageName}/${activity}`]
        : ["-s", SERIAL, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"];
      const attemptLaunch = async (): Promise<boolean> => {
        try {
          const r = await run(ADB(), launchArgs, { timeout: 30_000 });
          const started = !/Error|Exception|No activities found|aborted|current full space don't allow start fullscreen/i.test(`${r.stdout}${r.stderr}`);
          if (!started) errors.push(`launch: ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
          return started;
        } catch (e: any) {
          errors.push(`launch: ${String(e?.stderr ?? e?.message ?? e).slice(0, 200)}`);
          return false;
        }
      };
      let launched = await attemptLaunch();

      // 4. settle
      await new Promise((r) => setTimeout(r, settle * 1000));

      // 5a. process alive? (pidof exits non-zero when no process)
      const probeAlive = async (): Promise<boolean> => {
        try {
          const r = await run(ADB(), ["-s", SERIAL, "shell", "pidof", packageName], { timeout: 15_000 });
          return r.stdout.trim().length > 0;
        } catch {
          return false;
        }
      };
      let processAlive = await probeAlive();

      // 5b. crash / ANR scan + optional expected-log match
      let crashed = false;
      let logcatMatch: boolean | null = expectLogcatContains ? false : null;
      let fullSpaceBlocked = false;
      const scanLogcat = async () => {
        try {
          const r = await run(ADB(), ["-s", SERIAL, "shell", "logcat", "-d"], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
          const log = `${r.stdout}`;
          crashed = /\bFATAL\b/.test(log) || log.includes(`ANR in ${packageName}`);
          if (expectLogcatContains) logcatMatch = log.includes(expectLogcatContains);
          fullSpaceBlocked = /don't allow start fullscreen|ContainerManager/i.test(log);
        } catch (e: any) {
          errors.push(`logcat: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      };
      await scanLogcat();

      // 5c. incumbent recovery — `am start` can report success while the incumbent full-space app
      // blocks the actual start (logcat: "current full space don't allow start fullscreen" /
      // ContainerManager). Mirror fleet_build's launch_blocked path ONCE: read the incumbent from
      // dumpsys, force-stop it, wait out the container teardown, relaunch, re-assert. The outcome
      // is recorded in recoveryNotes, never silently absorbed.
      const recoveryNotes: string[] = [];
      if (launched && !processAlive && fullSpaceBlocked) {
        try {
          const d = await run(ADB(), ["-s", SERIAL, "shell", "dumpsys", "activity", "activities"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
          const m = String(d.stdout).match(/topResumedActivity=ActivityRecord\{\S+ u0 ([\w.]+)\//);
          const incumbent = m && m[1] !== packageName ? m[1] : null;
          if (incumbent) {
            await run(ADB(), ["-s", SERIAL, "shell", "am", "force-stop", incumbent], { timeout: 20_000 });
            await new Promise((r) => setTimeout(r, VERIFY_APK_TEARDOWN_MS));
            launched = await attemptLaunch();
            await new Promise((r) => setTimeout(r, settle * 1000));
            processAlive = await probeAlive();
            await scanLogcat();
            recoveryNotes.push(`full-space block by incumbent ${incumbent} — force-stopped it and relaunched once (processAlive now ${processAlive})`);
          } else {
            recoveryNotes.push("full-space block in logcat but no foreign topResumedActivity found — suspect a wedged ContainerManager: cold-restart the emulator (scripts/restart-emulator.sh) and re-run");
          }
        } catch (e: any) {
          recoveryNotes.push(`incumbent recovery failed: ${String(e?.message ?? e).slice(0, 160)}`);
        }
      }

      // 6. capture ONE 2D frame (the caller LOOKS at this, then records)
      let artifact: string | null = null;
      try {
        const dir = "/tmp/pico-render/verifyapk";
        fs.mkdirSync(dir, { recursive: true });
        const safe = packageName.replace(/[^A-Za-z0-9._-]/g, "_") || "app";
        const out = path.join(dir, `${safe}.png`);
        const png = await run(ADB(), ["-s", SERIAL, "exec-out", "screencap", "-p"], { timeout: 30_000, encoding: "buffer" as any, maxBuffer: 32 * 1024 * 1024 });
        const buf = png.stdout as unknown as Buffer;
        if (buf && buf.length > 1000) { fs.writeFileSync(out, buf); artifact = out; }
        else errors.push(`capture: screencap returned ${buf?.length ?? 0} bytes (too small)`);
      } catch (e: any) {
        errors.push(`capture: ${String(e?.message ?? e).slice(0, 120)}`);
      }

      const status = installed && launched && processAlive && !crashed ? "ok" : "attention";
      return okJson({
        status,
        installed,
        launched,
        processAlive,
        crashed,
        logcatMatch,
        artifact,
        errors,
        ...(recoveryNotes.length ? { recoveryNotes } : {}),
        // v27-pre first-light finding: with the target dead, screencap shows whatever app the
        // shell kept in the foreground — attributing those pixels to THIS apk is the exact
        // over-claim the ledger exists to prevent. Also the dead-target + launched combo is the
        // known wedged-ContainerManager signature.
        ...(artifact && !processAlive
          ? { captureWarning: `the ${packageName} process is NOT alive — this capture may show ANOTHER app's content (the shell keeps the incumbent activity). Do not attribute these pixels to this apk. If launch reported success but pidof is empty, suspect the wedged ContainerManager: diagnose symptom=launch_blocked (recovery: cold-restart the emulator, then re-run).` }
          : {}),
        evidence: {
          emulator: "structural: boots + not-crashed + a 2D capture; LOOK before making any pixel claim",
          swan: "hardware remains a separate run: LOOK at a device capture before device_verified",
        },
        honesty:
          "Structural only: installs/launches/process-alive/no-FATAL-or-ANR + one 2D screencap. This is NOT a vision_verified claim and says nothing by itself about immersive/XR rendering, controller-ray, or head-tracked depth. A green matrix means it BOOTS, not that it LOOKS right. LOOK at the frame; scope any conclusion to the tested emulator/device version. CAPTURE-PATH WARNING: this screencap is the SHELL composite — for an XR-RUNTIME IMMERSIVE app (Unity OpenXR / Unity Integration SDK) it comes back BLACK even when the app is rendering perfectly; use gui_capture for those and never read a black screencap as a rendering failure.",
        note: "Records nothing — the caller LOOKS at the artifact then calls record_verification. This is the Unity/other-builder handoff contract.",
      });
    },
  );
}
