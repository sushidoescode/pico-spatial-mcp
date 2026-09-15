import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, run, runBinary } from "./util.js";
import { adbExecutable } from "./adb.js";
import {
  parseInstalledApkPath,
  parsePid,
  parseProcStartTicks,
  parseForegroundActivities,
  type ForegroundActivity,
} from "./nativefleetreceipt.js";
import {
  retainPicoCliObservation,
  picoCliObservationRoot,
  type PicoCliObservationRetentionInput,
  type PicoCliRetainedObservation,
} from "./picocli.js";
import { inspectPng, classifyFrame, sha256Bytes, sha256File, type FrameDecoder } from "./artifactinspection.js";

export const VERIFY_APK_TEARDOWN_MS = 2_000;
const OBSERVATION_OPERATION = "external-apk-observation";
const OBSERVATION_SCHEMA_VERSION = 1;
const LOGCAT_LINE_BOUND = 2_000;
const CRASH_ATTRIBUTION_WINDOW = 10;
const PID_POLL_ATTEMPTS = 6;
const PID_POLL_INTERVAL_MS = 1_000;
const CAPTURE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const TEXT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const COMMAND_TAIL_BYTES = 64 * 1024;

/**
 * verifyapk.ts — EXTERNAL-APK OBSERVATION (Task C6).
 *
 * An external builder hands us an arbitrary .apk. We install it on an EXPLICITLY NAMED device,
 * launch it, observe identity, read a bounded log, capture one frame, and publish an immutable
 * observation record. What comes back is an OBSERVATION, not a receipt: it can never become a
 * fleet-native-debug run receipt, a release claim, or a hardware claim, and it records nothing in
 * the ledger — the caller LOOKS at the frame and records what they saw.
 *
 * What the 2026-09-15 audit corrected here, and why each correction is load-bearing:
 *
 *  * The old module hardcoded one legacy SDK adb path and one fixed emulator serial. A tool that
 *    names a target the caller never chose can act on the wrong device — and on this host that
 *    device is reserved for someone else. The serial is now a REQUIRED input with no default, and
 *    adb comes from the shared resolver (src/adb.ts).
 *  * It ran the logcat CLEAR command, destroying the device's entire global log just to scope its
 *    own scan. It never clears anything now: the log is read with `-d --pid=<pid> -t <N>` — bounded, and scoped to the
 *    process actually observed. Flags verified against the AOSP logcat help text ("-d Dump the log
 *    and then exit (don't block)", "-t N Print most recent <count> lines (implies -d)",
 *    "--pid=PID Only print logs from the given pid").
 *  * It treated ANY global `FATAL` token as this app's crash. Attribution now requires the package
 *    or the observed PID inside the crash block, or a PID-scoped stream.
 *  * It force-stopped a FOREIGN foreground app and relaunched. Ordinary observation never stops an
 *    app it was not given: a foreign foreground is reported as a `conflict` with the evidence.
 *  * It wrote every capture to one mutable path in the shared render scratch directory, keyed only
 *    by package name, and validated it with `bytes > 1000` — so two observations of the same
 *    package overwrote each other's evidence. Captures now go into a unique run directory (`wx`,
 *    replacement refused) and the bytes are structurally inspected.
 *  * It could return `status: "ok"` when the capture had failed. A failed capture is its own state
 *    and never reads as a clean observation.
 *
 * ROUTE HONESTY: `adb exec-out screencap` reads the CURRENT DISPLAY through the shell/compositor.
 * For an XR-runtime immersive layer it can return black while the app draws perfectly, and it can
 * return black when nothing is drawn. Black is INCONCLUSIVE about the route, never a rendering
 * verdict. Earlier runs in this repository observed both outcomes at the same moment.
 */

export type VerifyApkDependencies = {
  /** Text device commands. Injected in tests; a test that reaches a real adb is a bug, not a run. */
  runTextFn?: typeof run;
  /** Binary device commands (the capture). */
  runBinaryFn?: typeof runBinary;
  resolveAdbFn?: () => string;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => Date;
  runIdFn?: () => string;
  retainFn?: (input: PicoCliObservationRetentionInput) => PicoCliRetainedObservation;
  observationRoot?: () => string;
  /** Read-back of the published capture, so a substituted artifact is caught rather than trusted. */
  readPublishedDigestFn?: (filePath: string) => { sha256: string | null };
  /** Optional frame decoder for dark-frame classification; absent means the built-in PNG path. */
  frameDecoder?: FrameDecoder;
};

type Observed<T extends Record<string, unknown>> = ({ status: "observed" } & T) | { status: "missing"; reason: string };

const missing = (reason: string) => ({ status: "missing" as const, reason });

type CaptureStatus = "captured" | "unavailable" | "invalid" | "tampered" | "not-attributable";

const ROUTE_NOTE =
  "capture route 'adb-screencap': `adb exec-out screencap -p` composites the CURRENT DISPLAY through "
  + "the device shell. It observes what the display server presents, not what an XR runtime submits to "
  + "the headset, so an immersive layer can read black here while drawing correctly — and can also read "
  + "black when nothing is drawn. Treat black as inconclusive about the route and capture a second way.";

const HONESTY =
  "STRUCTURAL OBSERVATION ONLY. This records install identity, boot identity, process identity, "
  + "foreground, a bounded PID-scoped log and one inspected frame on ONE explicitly named device. It is "
  + "not a fleet-native run receipt, not a release claim and not a hardware claim, and it records nothing "
  + "in the ledger. A green matrix means the app BOOTED on that device, never that it LOOKS right. LOOK "
  + "at the frame, then record what you actually saw.";

const NOT_A_RECEIPT =
  "This is an external-APK observation, not a run receipt. It carries no build provenance, no AppSpec, "
  + "no signing inspection and no promotion identity, so it can never be promoted into portable receipt "
  + "provenance, a release claim or a hardware claim.";

export function registerVerifyApkTools(server: McpServer, deps: VerifyApkDependencies = {}) {
  const runText = deps.runTextFn ?? run;
  const runBin = deps.runBinaryFn ?? runBinary;
  const resolveAdb = deps.resolveAdbFn ?? (() => adbExecutable());
  const sleep = deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.nowFn ?? (() => new Date());
  const publishedDigest = deps.readPublishedDigestFn ?? ((filePath: string) => sha256File(filePath));
  const retain = deps.retainFn
    ?? ((input: PicoCliObservationRetentionInput) =>
      retainPicoCliObservation(input, deps.observationRoot ? deps.observationRoot() : picoCliObservationRoot()));

  server.registerTool(
    "verify_pico_apk",
    {
      description:
        "Cross-builder EXTERNAL-APK OBSERVATION: install an arbitrary PICO APK on an EXPLICITLY NAMED serial, "
        + "launch it, and observe identity — local APK sha256, the installed package and its on-device digest, "
        + "boot id, PID and process start, foreground package, a bounded PID-scoped logcat, and one inspected "
        + "screencap published immutably into a unique run directory. Results are STRUCTURAL: an observation, "
        + "never a run receipt, a release claim or a hardware claim, and nothing is recorded for you. "
        + "It never clears the global log and never stops an app it was not given: a foreign foreground comes "
        + "back as a conflict with the evidence. "
        + ROUTE_NOTE,
      inputSchema: {
        apkPath: z.string().describe("Absolute path to the .apk the external builder emitted; its bytes are hashed locally."),
        packageName: z.string().describe("Android package id, e.g. com.example.unityxr."),
        serial: z.string().optional().describe("REQUIRED adb serial of the target device. There is no default: an observation names the device it observed."),
        activity: z.string().optional().describe("Fully-qualified launch activity. If omitted, launched via a monkey LAUNCHER intent."),
        expectLogcatContains: z.string().optional().describe("Optional substring to look for in the bounded log. Sets logcatMatch true/false; null when not provided."),
        settleSec: z.number().min(0).max(120).optional().describe("Seconds to wait after launch before observing (default 8)."),
      },
    },
    async ({ apkPath, packageName, serial, activity, expectLogcatContains, settleSec }) => {
      const settle = settleSec ?? 8;
      const errors: string[] = [];
      const startedAt = now().toISOString();
      const commands: Array<{ argv: string[]; code: number | null; timedOut: boolean }> = [];

      const identity: Record<string, unknown> = {
        apk: missing("not read yet"),
        serial: missing("not supplied"),
        installedPackage: missing("not probed"),
        installedApk: missing("not probed"),
        bootId: missing("not probed"),
        process: missing("not probed"),
        foreground: missing("not probed"),
      };

      const refuse = (reason: string, extra: Record<string, unknown> = {}) =>
        okJson({
          status: "failed",
          scope: OBSERVATION_OPERATION,
          schemaVersion: OBSERVATION_SCHEMA_VERSION,
          observedAt: startedAt,
          reason,
          identity,
          capture: { route: "adb-screencap", status: "unavailable" as CaptureStatus, reason },
          logs: { status: "unavailable", reason, crash: { attributed: null, lines: [], reason } },
          errors,
          notAReceipt: NOT_A_RECEIPT,
          honesty: HONESTY,
          ...extra,
        });

      // ── explicit target identity ────────────────────────────────────────────────────────────
      if (!serial || !serial.trim()) {
        return refuse("serial is required: an external-APK observation names the exact device it observed, and this tool has no default serial. Pass the adb serial of the target device.");
      }
      identity.serial = { status: "observed", value: serial };

      let adb: string;
      try {
        adb = resolveAdb();
      } catch (error: any) {
        return refuse(`adb could not be resolved: ${error?.message ?? String(error)}`);
      }

      const local = sha256File(apkPath);
      if (local.sha256 === null) return refuse(`the APK could not be hashed: ${local.reason}`);
      identity.apk = { status: "observed", path: apkPath, sha256: local.sha256, bytes: local.bytes };

      // Every device step is wrapped: a failure becomes a structured field, never a throw. `run`
      // resolves rather than rejecting, so this catch is for an INJECTED runner (a test tripwire)
      // or a pathological spawn — either way the observation reports it instead of exploding.
      const device = async (args: string[], timeoutMs: number, maxOutputBytes = COMMAND_TAIL_BYTES) => {
        let result: Awaited<ReturnType<typeof run>>;
        try {
          result = await runText(adb, args, { timeoutMs, maxOutputBytes });
        } catch (error: any) {
          result = { code: null, stdout: "", stderr: `the device command could not be run: ${error?.message ?? String(error)}`, timedOut: false };
        }
        commands.push({ argv: args, code: result.code, timedOut: result.timedOut });
        return result;
      };
      const readValue = async (shellArgs: string[], timeoutMs = 20_000): Promise<{ ok: true; value: string } | { ok: false; reason: string }> => {
        const args = ["-s", serial, "shell", ...shellArgs];
        const result = await device(args, timeoutMs);
        if (result.code !== 0 || result.timedOut) {
          return { ok: false, reason: `\`${shellArgs.join(" ")}\` exited ${result.code}${result.timedOut ? " (timeout)" : ""}: ${(result.stderr || result.stdout).trim().slice(0, 200) || "no output"}` };
        }
        return { ok: true, value: result.stdout };
      };

      // ── boot identity, before ───────────────────────────────────────────────────────────────
      const bootBefore = await readValue(["cat", "/proc/sys/kernel/random/boot_id"]);
      if (!bootBefore.ok) {
        identity.bootId = missing(bootBefore.reason);
        errors.push(`boot-id: ${bootBefore.reason}`);
      } else {
        identity.bootId = { status: "observed", value: bootBefore.value.trim() };
      }

      // ── install ─────────────────────────────────────────────────────────────────────────────
      const installArgs = ["-s", serial, "install", "-r", apkPath];
      const installResult = await device(installArgs, 180_000, 8 * 1024 * 1024);
      const installText = `${installResult.stdout}${installResult.stderr}`;
      const installed = installResult.code === 0 && !installResult.timedOut && /(?:^|\r?\n)Success(?:\r?\n|$)/.test(installText);
      if (!installed) {
        errors.push(`install: ${installText.trim().slice(0, 200) || `exit ${installResult.code}`}`);
        return refuse(`install of ${apkPath} on ${serial} did not report Success: ${installText.trim().slice(0, 200) || `exit ${installResult.code}`}`);
      }

      // ── installed identity (observed FROM the device, never from the caller's claim) ────────
      const pmPath = await readValue(["pm", "path", packageName]);
      const remotePath = pmPath.ok ? parseInstalledApkPath(pmPath.value) : null;
      let installedDigest: string | null = null;
      if (!remotePath) {
        const reason = pmPath.ok
          ? `\`pm path ${packageName}\` did not name exactly one installed base APK`
          : pmPath.reason;
        identity.installedPackage = missing(reason);
        identity.installedApk = missing(reason);
        errors.push(`installed-identity: ${reason}`);
      } else {
        identity.installedPackage = { status: "observed", value: packageName, source: "pm path" };
        const digestRead = await readValue(["toybox", "sha256sum", remotePath]);
        const parsed = digestRead.ok ? /^([A-Fa-f0-9]{64})\s+(\S+)$/.exec(digestRead.value.trim()) : null;
        if (!parsed || parsed[2] !== remotePath) {
          const reason = digestRead.ok
            ? `\`toybox sha256sum ${remotePath}\` did not return exactly one digest for that path`
            : digestRead.reason;
          identity.installedApk = missing(reason);
          errors.push(`installed-digest: ${reason}`);
        } else {
          installedDigest = parsed[1].toLowerCase();
          identity.installedApk = { status: "observed", path: remotePath, sha256: installedDigest };
        }
      }

      const finalize = (
        status: string,
        reason: string,
        parts: {
          capture: Record<string, unknown>;
          logs: Record<string, unknown>;
          extra?: Record<string, unknown>;
        },
      ) => {
        const record = {
          status,
          scope: OBSERVATION_OPERATION,
          schemaVersion: OBSERVATION_SCHEMA_VERSION,
          observedAt: startedAt,
          completedAt: now().toISOString(),
          reason,
          packageName,
          identity,
          capture: parts.capture,
          logs: parts.logs,
          commands,
          errors,
          notAReceipt: NOT_A_RECEIPT,
          honesty: HONESTY,
          ...(parts.extra ?? {}),
        };
        return record;
      };

      // A digest mismatch means the bytes on the device are not the bytes the caller handed us.
      // Nothing after this point could be attributed to that APK, so nothing after this point runs.
      if (installedDigest && installedDigest !== local.sha256) {
        const reason = `the installed APK digest ${installedDigest} does not match the local APK digest ${local.sha256}: the device is not running the bytes you supplied, so nothing was launched, captured or attributed`;
        return okJson(finalize("mismatch", reason, {
          capture: { route: "adb-screencap", status: "unavailable" as CaptureStatus, reason: "not attempted: the installed APK is not the supplied APK" },
          logs: { status: "unavailable", reason: "not attempted: the installed APK is not the supplied APK", crash: { attributed: null, lines: [], reason: "no log was read" } },
        }));
      }

      // ── launch (only ever the package we were given) ────────────────────────────────────────
      // The target is force-stopped for a clean launch; NO other package is ever stopped. The
      // teardown pause is the v27.8 immersive-container finding: the OS rejects an immediate
      // re-launch with "current full space don't allow start fullscreen" while the previous
      // container's close animation is still in flight.
      await device(["-s", serial, "shell", "am", "force-stop", packageName], 20_000);
      await sleep(VERIFY_APK_TEARDOWN_MS);

      // PLAIN start, not `am start -S`: -S force-stops the package again immediately before launch
      // and recreates the teardown race above.
      const launchArgs = activity
        ? ["-s", serial, "shell", "am", "start", "-n", `${packageName}/${activity}`]
        : ["-s", serial, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"];
      const launchResult = await device(launchArgs, 30_000);
      const launchText = `${launchResult.stdout}${launchResult.stderr}`;
      const launched = launchResult.code === 0 && !launchResult.timedOut
        && !/Error|Exception|No activities found|aborted|don't allow start fullscreen/i.test(launchText);
      if (!launched) errors.push(`launch: ${launchText.trim().slice(0, 200) || `exit ${launchResult.code}`}`);

      await sleep(settle * 1000);

      // ── process identity ────────────────────────────────────────────────────────────────────
      let pid: number | null = null;
      let pidReason = "";
      for (let attempt = 0; attempt < PID_POLL_ATTEMPTS; attempt++) {
        const read = await readValue(["pidof", packageName], 15_000);
        pid = read.ok ? parsePid(read.value) : null;
        if (pid !== null) break;
        pidReason = read.ok ? `\`pidof ${packageName}\` returned no single PID` : read.reason;
        if (attempt < PID_POLL_ATTEMPTS - 1) await sleep(PID_POLL_INTERVAL_MS);
      }
      let startTicks: string | null = null;
      if (pid !== null) {
        const stat = await readValue(["cat", `/proc/${pid}/stat`]);
        startTicks = stat.ok ? parseProcStartTicks(stat.value) : null;
        if (startTicks === null) pidReason = stat.ok ? `/proc/${pid}/stat did not parse` : stat.reason;
      }
      if (pid !== null && startTicks !== null) {
        identity.process = { status: "observed", pid, startTicks };
      } else {
        identity.process = missing(pidReason || `no live process identity for ${packageName}`);
        errors.push(`process: ${pidReason || "no live process identity"}`);
      }

      // ── foreground (observed, never acted on) ───────────────────────────────────────────────
      const foregroundRead = await readValue(["dumpsys", "activity", "activities"], 20_000);
      const activities: ForegroundActivity[] = foregroundRead.ok ? parseForegroundActivities(foregroundRead.value) : [];
      const ours = activities.find((a) => a.packageName === packageName) ?? null;
      const foreign = ours ? null : activities[0] ?? null;
      let conflict: Record<string, unknown> | null = null;
      if (ours) {
        identity.foreground = { status: "observed", packageName: ours.packageName, component: ours.component, activities };
      } else if (foreign) {
        identity.foreground = { status: "observed", packageName: foreign.packageName, component: foreign.component, activities };
        conflict = {
          foregroundPackage: foreign.packageName,
          foregroundComponent: foreign.component,
          expectedPackage: packageName,
          // The actual evidence this conclusion was read from — not a paraphrase of it.
          evidence: foregroundRead.ok ? boundedTail(foregroundRead.value) : "",
          action: "none: this observation does not stop an app it was not given. Decide yourself whether to bring "
            + `${packageName} forward or to stop ${foreign.packageName}, and do it explicitly.`,
        };
      } else {
        const reason = foregroundRead.ok ? "dumpsys reported no resumed activity" : foregroundRead.reason;
        identity.foreground = missing(reason);
        errors.push(`foreground: ${reason}`);
      }

      // ── bounded, PID-scoped log. The device's global log is NEVER cleared. ──────────────────
      const logcatArgs = pid !== null
        ? ["-s", serial, "shell", "logcat", "-d", `--pid=${pid}`, "-t", String(LOGCAT_LINE_BOUND)]
        : ["-s", serial, "shell", "logcat", "-d", "-t", String(LOGCAT_LINE_BOUND)];
      const logcatResult = await device(logcatArgs, 30_000, TEXT_OUTPUT_LIMIT);
      const logsOk = logcatResult.code === 0 && !logcatResult.timedOut;
      const logText = logsOk ? logcatResult.stdout : "";
      const crash = attributeCrash(logText, packageName, pid, logsOk, pid !== null);
      const logcatMatch = expectLogcatContains ? (logsOk ? logText.includes(expectLogcatContains) : null) : null;
      if (!logsOk) errors.push(`logcat: exit ${logcatResult.code}${logcatResult.timedOut ? " (timeout)" : ""}`);

      // ── capture ─────────────────────────────────────────────────────────────────────────────
      let captureBytes: Buffer | null = null;
      let captureStatus: CaptureStatus = "unavailable";
      let captureReason = "";
      let capturedAt: string | null = null;
      if (conflict) {
        captureStatus = "not-attributable";
        captureReason = `not captured: ${conflict.foregroundPackage} is in the foreground, not ${packageName}. Those pixels would be another app's, and this observation does not publish them.`;
      } else {
        let shot: Awaited<ReturnType<typeof runBinary>>;
        try {
          shot = await runBin(adb, ["-s", serial, "exec-out", "screencap", "-p"], { timeoutMs: 30_000, maxOutputBytes: CAPTURE_OUTPUT_LIMIT });
        } catch (error: any) {
          shot = { code: null, stdout: Buffer.alloc(0), stderr: `the capture command could not be run: ${error?.message ?? String(error)}`, timedOut: false };
        }
        commands.push({ argv: ["-s", serial, "exec-out", "screencap", "-p"], code: shot.code, timedOut: shot.timedOut });
        if (shot.code !== 0 || shot.timedOut) {
          captureReason = `screencap exit ${shot.code}${shot.timedOut ? " (timeout)" : ""}: ${shot.stderr.trim().slice(0, 200) || "no stderr"}`;
          errors.push(`capture: ${captureReason}`);
        } else {
          captureBytes = Buffer.from(shot.stdout);
          capturedAt = now().toISOString();
          captureStatus = "captured";
        }
      }

      // ── continuity: the same boot, the same process, across the whole observation ───────────
      let continuityBreak: string | null = null;
      const bootAfter = await readValue(["cat", "/proc/sys/kernel/random/boot_id"]);
      const bootBeforeValue = bootBefore.ok ? bootBefore.value.trim() : null;
      if (!bootAfter.ok) {
        continuityBreak = `the device boot identity could not be re-read after the observation: ${bootAfter.reason}`;
      } else if (bootBeforeValue !== null && bootAfter.value.trim() !== bootBeforeValue) {
        continuityBreak = `the device boot identity changed during the observation ('${bootBeforeValue}' -> '${bootAfter.value.trim()}'): the device rebooted, so nothing observed here spans one run`;
      }
      if (!continuityBreak && pid !== null) {
        const pidAfter = await readValue(["pidof", packageName], 15_000);
        const pidAfterValue = pidAfter.ok ? parsePid(pidAfter.value) : null;
        if (pidAfterValue !== pid) {
          continuityBreak = `the ${packageName} PID changed during the observation (${pid} -> ${pidAfterValue ?? "none"}): the process exited or restarted`;
        } else {
          const statAfter = await readValue(["cat", `/proc/${pid}/stat`]);
          const ticksAfter = statAfter.ok ? parseProcStartTicks(statAfter.value) : null;
          if (ticksAfter !== startTicks) {
            continuityBreak = `the ${packageName} process start identity changed during the observation (${startTicks} -> ${ticksAfter ?? "unreadable"}): PID ${pid} is a different process now`;
          }
        }
      }
      if (continuityBreak) {
        errors.push(`continuity: ${continuityBreak}`);
        if (captureStatus === "captured") {
          captureStatus = "not-attributable";
          captureReason = `the bytes were captured, but ${continuityBreak}, so they cannot be attributed to this observation`;
        }
      }

      // ── media inspection: a nonempty file is not a frame ────────────────────────────────────
      let png: ReturnType<typeof inspectPng> | null = null;
      let frame: ReturnType<typeof classifyFrame> | null = null;
      if (captureBytes) {
        png = inspectPng(captureBytes);
        if (!png.valid) {
          captureStatus = "invalid";
          captureReason = `the captured bytes are not a valid image (${captureBytes.length} bytes): ${png.reason}`;
          errors.push(`capture-media: ${png.reason}`);
        } else if (!png.meetsCaptureFloor) {
          captureStatus = "invalid";
          captureReason = `the captured image is a valid PNG but below the capture-evidence floor: ${png.captureFloorReason}`;
          errors.push(`capture-media: ${png.captureFloorReason}`);
        } else if (captureStatus === "captured") {
          frame = classifyFrame(captureBytes, deps.frameDecoder);
        }
      }

      // ── immutable publication into a unique run directory ───────────────────────────────────
      const captureSha = captureBytes ? sha256Bytes(captureBytes) : null;
      const retention = retain({
        operation: OBSERVATION_OPERATION,
        argv: logcatArgs,
        result: {
          code: logcatResult.code,
          signal: null,
          stdout: logText,
          stderr: logcatResult.stderr,
          timedOut: logcatResult.timedOut,
          outputTruncated: false,
        },
        ...(deps.runIdFn ? { runId: deps.runIdFn() } : {}),
        metadata: {
          scope: OBSERVATION_OPERATION,
          schemaVersion: OBSERVATION_SCHEMA_VERSION,
          observedAt: startedAt,
          serial,
          packageName,
          identity,
          captureRoute: "adb-screencap",
          capturedAt,
          captureSha256: captureSha,
          captureStatus,
          commands,
          notAReceipt: NOT_A_RECEIPT,
        },
        ...(captureBytes && captureStatus !== "invalid"
          ? { artifacts: [{ name: "capture.png", bytes: captureBytes }] }
          : {}),
      });

      let artifactPath: string | null = null;
      if (retention.retained) {
        artifactPath = retention.artifacts[0]?.path ?? null;
        // The published file is read back and re-hashed. "The retainer returned a path" is not
        // "the path holds the frame I observed"; substituted bytes are caught here, not trusted.
        if (artifactPath && captureSha) {
          const republished = publishedDigest(artifactPath);
          if (republished.sha256 !== captureSha) {
            captureStatus = "tampered";
            captureReason = `the published artifact digest ${republished.sha256 ?? "unreadable"} differs from the captured bytes' digest ${captureSha}: the evidence on disk is not the frame that was captured`;
            errors.push(`capture-publication: ${captureReason}`);
          }
        }
      } else {
        errors.push(`retention: ${retention.error}`);
      }

      const capture: Record<string, unknown> = {
        route: "adb-screencap",
        status: captureStatus,
        capturedAt,
        bytes: captureBytes?.length ?? null,
        sha256: captureSha,
        ...(png?.valid ? { width: png.width, height: png.height, bitDepth: png.bitDepth } : {}),
        ...(artifactPath && captureStatus !== "tampered" ? { artifactPath } : {}),
        ...(artifactPath && captureStatus === "tampered" ? { publishedPath: artifactPath } : {}),
        ...(captureReason ? { reason: captureReason } : {}),
        ...(frame ? { frame } : {}),
        routeNote: ROUTE_NOTE,
      };

      const logs: Record<string, unknown> = {
        status: logsOk ? "collected" : "unavailable",
        scope: pid !== null ? "pid" : "unscoped",
        argv: logcatArgs,
        lineBound: LOGCAT_LINE_BOUND,
        lines: logsOk ? logText.split("\n").filter(Boolean).length : 0,
        cleared: false,
        ...(retention.retained ? { path: retention.stdoutPath, sha256: retention.stdoutSha256 } : {}),
        ...(logsOk ? {} : { reason: `logcat exited ${logcatResult.code}${logcatResult.timedOut ? " (timeout)" : ""}` }),
        crash,
        logcatMatch,
      };

      // ── one status, chosen fail-closed ──────────────────────────────────────────────────────
      let status: string;
      let reason: string;
      if (captureStatus === "tampered") {
        status = "tampered"; reason = captureReason;
      } else if (captureStatus === "invalid") {
        status = "invalid-media"; reason = captureReason;
      } else if (conflict) {
        status = "conflict";
        reason = `${conflict.foregroundPackage} is in the foreground, not ${packageName}. No app was stopped and no frame was published.`;
      } else if (continuityBreak) {
        status = "inconclusive"; reason = continuityBreak;
      } else if (!launched) {
        status = "inconclusive"; reason = `${packageName} was not observed to launch: ${launchText.trim().slice(0, 200) || `exit ${launchResult.code}`}`;
      } else if (identity.process && (identity.process as any).status === "missing") {
        status = "inconclusive"; reason = `no live process identity for ${packageName}, so no frame or log can be attributed to it: ${(identity.process as any).reason}`;
      } else if (crash.attributed === true) {
        status = "inconclusive"; reason = `the bounded log attributes a crash/ANR to ${packageName} — read logs.crash.lines`;
      } else if (identity.installedApk && (identity.installedApk as any).status === "missing") {
        status = "inconclusive"; reason = `the installed APK identity could not be observed: ${(identity.installedApk as any).reason}`;
      } else if (captureStatus !== "captured") {
        status = "inconclusive"; reason = captureReason || "no frame was captured";
      } else if (!retention.retained) {
        status = "inconclusive"; reason = `the observation could not be published immutably: ${retention.error}`;
      } else {
        status = "observed";
        reason = `${packageName} installed, launched and stayed alive on ${serial}; one frame was captured and published. LOOK at it before claiming anything about how it renders.`;
      }

      return okJson(finalize(status, reason, {
        capture,
        logs,
        extra: {
          launched,
          ...(conflict ? { conflict } : {}),
          ...(retention.retained
            ? { runDirectory: retention.directory, observationRecord: retention.recordPath }
            : { retentionError: retention.error }),
        },
      }));
    },
  );
}

function boundedTail(output: string): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(-12).join("\n").slice(-COMMAND_TAIL_BYTES);
}

/**
 * A crash is THIS package's crash only when the package or the observed PID appears in the crash
 * block, or when the stream itself was PID-scoped. A global `FATAL` token belongs to whatever
 * produced it — reading it as this app's crash is how an unrelated failure became a verdict.
 */
function attributeCrash(
  log: string,
  packageName: string,
  pid: number | null,
  logsOk: boolean,
  pidScoped: boolean,
): { attributed: boolean | null; lines: string[]; reason: string } {
  if (!logsOk) {
    return { attributed: null, lines: [], reason: "no log was read, so crash state is UNKNOWN — unknown is not 'no crash'" };
  }
  const lines = log.split(/\r?\n/);
  const markers: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\bFATAL\b|FATAL EXCEPTION|\bANR in\b|Fatal signal/.test(lines[i])) markers.push(i);
  }
  if (!markers.length) {
    return {
      attributed: false,
      lines: [],
      reason: pidScoped
        ? `no crash or ANR marker in the PID-scoped log for ${packageName} (PID ${pid})`
        : `no crash or ANR marker in the bounded log`,
    };
  }
  if (pidScoped) {
    return {
      attributed: true,
      lines: markers.slice(0, 20).map((i) => lines[i]),
      reason: `the log was scoped to PID ${pid} with --pid, so these markers are ${packageName}'s`,
    };
  }
  const pidToken = pid !== null ? new RegExp(`\\b${pid}\\b`) : null;
  const attributing: string[] = [];
  for (const marker of markers) {
    const block = lines.slice(marker, marker + CRASH_ATTRIBUTION_WINDOW);
    const hit = block.find((line) => line.includes(packageName) || (pidToken ? pidToken.test(line) : false));
    if (hit) {
      attributing.push(lines[marker]);
      if (hit !== lines[marker]) attributing.push(hit);
    }
  }
  if (!attributing.length) {
    return {
      attributed: false,
      lines: [],
      reason: `${markers.length} crash/ANR marker(s) are present in the bounded log, but none names ${packageName}`
        + `${pid !== null ? ` or PID ${pid}` : " (no PID was observed to match against)"} within ${CRASH_ATTRIBUTION_WINDOW} lines — they belong to something else, not to this observation`,
    };
  }
  return {
    attributed: true,
    lines: attributing.slice(0, 20),
    reason: `a crash/ANR marker is followed within ${CRASH_ATTRIBUTION_WINDOW} lines by ${packageName}`
      + `${pid !== null ? ` or PID ${pid}` : ""}`,
  };
}
