import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { okJson, tail, okJsonStructured } from "./util.js";
import {
  ensurePicoCli,
  picoCliProvenance,
  picoCliFromEnsure,
  runPicoCli,
  classifyPicoCliFailure,
  cliWrapperContractShape,
  inspectPicoCliArtifact,
  describePicoCliEnvironmentFailure,
  picoCliOperationCapability,
  retainPicoCliObservation,
  picoCliObservationRoot,
  type PicoCliCommandResult,
  type PicoCliObservationRetentionInput,
  type PicoCliRetainedObservation,
} from "./picocli.js";
import {
  capabilityFailureClass,
  cliOperationNativeDurationFlag,
  type CliRouteDurationFlag,
  type OperationCapability,
} from "./clicapabilities.js";
import { inspectMp4, sha256File } from "./artifactinspection.js";
import {
  assessCoverage,
  classifyWatchEnd,
  describeCoverage,
  watchArgv,
  watchAssessment,
  watchWatchdogBoundSec,
  MONITORED_WINDOW_UNAVAILABLE,
  WATCH_WATCHDOG_GRACE_SEC,
  type ObservationCoverage,
} from "./cliobservations.js";

/**
 * picoclitools.ts — v31: thin evidence primitives over the official pico-cli.
 *
 * watch_crash wraps `pico-cli app watch-crash <pkg>` — PICO's own crash monitor (PID-change
 * polling + surfaced exception logs) instead of our ad-hoc logcat grepping. The wrapper now asks
 * the resolved package's capability evidence before dispatching, hands the requested window to the
 * CLI through `--monitor-timeout` when that line advertises it (retained help 0.5.0/096), and
 * bounds a hung child with an outer watchdog: the requested window, plus WATCH_WATCHDOG_GRACE_SEC
 * of settlement time on a line that was actually given that window.
 *
 * The 2026-09-15 audit corrected two long-standing claims in this file. 0.4.4 does NOT stream
 * indefinitely: it waits for a PID for up to --launch-timeout seconds and then runs an internal
 * 30-second monitoring loop with no flag to change it (WATCH044, help fixture 0.4.4/025). And 0.5.0
 * DOES expose a duration flag: --monitor-timeout, "Total wall-clock seconds to wait for the process
 * and crash signals" (WATCH_ARGS050/WATCH050, help fixture 0.5.0/096) — one shared budget covering
 * device resolution, the optional launch, the PID wait, polling and the final log collection, so
 * elapsed time is not monitoring time. Coverage arithmetic lives in cliobservations.ts.
 *
 * capture_record wraps `pico-cli capture record` — the official screen recorder (1-180s, pulls
 * the file locally). It gives the ledger a recording evidence lane and the demo a video fallback.
 * Flag surface byte-identical between 0.3.0 and 0.4.2 --help (re-verified 2026-08-12).
 *
 * HONESTY (load-bearing): output is the CLI's verbatim text; crash detection is a best-effort
 * keyword scan over that text, never a verdict — read outputTail before claiming a crash or its
 * absence. A recording artifact is stat-checked, and its pixels prove nothing until LOOKED at:
 * on immersive content the recorded display surface may not show the intended view (some emulator
 * Unity runs produced black display captures; a later OpenXR run did not, so this is not universal).
 */

const WATCH_HONESTY =
  "watchedSec is the OBSERVED elapsed window, never the requested one; requestedDurationSec and " +
  "observation.coverage say how much of the request was actually covered. On a line that advertises " +
  "--monitor-timeout the request is handed to the CLI; otherwise the CLI's own monitoring bound is a " +
  "constant this wrapper did not set and an outer watchdog only bounds a stuck child. " +
  MONITORED_WINDOW_UNAVAILABLE + " crashIndicated is a best-effort keyword scan over the complete " +
  "retained log (not just the returned tail) — read outputTail and the retained log before claiming a " +
  "crash or its absence; unless coverage is 'complete', a quiet window is 'inconclusive', not a " +
  "no-crash result. Evidence class: structural.";

/** Source/freshness-neutral guidance for an unprovisioned utility payload. Byte-pinned by
 * test/distribution-adoption.mjs across every CLI wrapper: do not reword per branch. */
const SETUP_REQUIRED_NOTE =
  "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry.";

const RECORD_HONESTY =
  "The artifact is the file pulled by the official CLI. This tool stat-checks it AND inspects its " +
  "container: box structure, declared tracks, and the duration MEASURED from the file's own movie " +
  "header. A returned duration is NOT a measurement — the CLI echoes the clamped request, so " +
  "requestedDurationSec and measuredDurationSec are reported separately and may disagree. A " +
  "container that will not parse is invalid media; when nothing could inspect the bytes the media " +
  "is unvalidated, never a successful decode. Its pixels still prove nothing until LOOKED " +
  "at. Guest-side adb screenrecord and pico-cli capture record " +
  "yield empty/invalid files on this emulator display; the working macOS host-side recipe is " +
  "screencapture -V -l<windowId>. Evidence class: a capture artifact " +
  "that still requires a LOOK before any visual claim.";

/** Bytes above this are hashed but not parsed: an unbounded read is not an inspection budget. */
const MAX_RECORDING_INSPECT_BYTES = 256 * 1024 * 1024;

export type RecordingInspection = {
  media: "validated" | "unvalidated" | "invalid";
  sha256: string | null;
  bytes: number | null;
  measuredDurationSec: number | null;
  hasVideoTrack: boolean | null;
  trackCount: number | null;
  reason: string;
};

/**
 * Inspect a pulled recording. `measuredDurationSec` comes from the file's own `mvhd`; the CLI's
 * returned duration is the clamped REQUEST and is never treated as a measurement. When the bytes
 * cannot be read or are too large to parse within budget the answer is `unvalidated` — explicitly
 * "nothing checked this" — and never a successful decode.
 */
export function inspectRecordingArtifact(artifactPath: string): RecordingInspection {
  const digest = sha256File(artifactPath);
  if (digest.sha256 === null) {
    return { media: "unvalidated", sha256: null, bytes: null, measuredDurationSec: null, hasVideoTrack: null, trackCount: null, reason: digest.reason };
  }
  if (digest.bytes > MAX_RECORDING_INSPECT_BYTES) {
    return {
      media: "unvalidated",
      sha256: digest.sha256,
      bytes: digest.bytes,
      measuredDurationSec: null,
      hasVideoTrack: null,
      trackCount: null,
      reason: `the recording is ${digest.bytes} bytes, above the ${MAX_RECORDING_INSPECT_BYTES}-byte container-inspection budget; it was hashed but not parsed`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(artifactPath);
  } catch (error: any) {
    return { media: "unvalidated", sha256: digest.sha256, bytes: digest.bytes, measuredDurationSec: null, hasVideoTrack: null, trackCount: null, reason: `the recording could not be read for inspection: ${error?.message ?? String(error)}` };
  }
  const mp4 = inspectMp4(bytes);
  if (!mp4.valid) {
    return { media: "invalid", sha256: digest.sha256, bytes: digest.bytes, measuredDurationSec: null, hasVideoTrack: false, trackCount: null, reason: `the recording is not a parseable MP4/ISO-BMFF container: ${mp4.reason}` };
  }
  return {
    media: "validated",
    sha256: digest.sha256,
    bytes: digest.bytes,
    measuredDurationSec: mp4.durationSec,
    hasVideoTrack: mp4.hasVideoTrack,
    trackCount: mp4.trackCount,
    reason: mp4.durationSec === null
      ? "the container parsed but states no movie duration, so no duration was measured"
      : `the container parsed; ${mp4.durationSec}s measured from its movie header, ${mp4.trackCount} track(s), video track ${mp4.hasVideoTrack ? "declared" : "absent"}`,
  };
}

/** Best-effort crash-marker scan over watch-crash output. Named indicators, not a verdict. */
export function scanForCrashIndicators(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["fatal-exception", /FATAL EXCEPTION/i],
    ["crash-buffer", /beginning of crash/i],
    ["process-died", /Process .+ (died|has died)/i],
    ["anr", /ANR in /i],
    ["native-crash", /Fatal signal|\*\*\* \*\*\*/i],
  ];
  return patterns.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const WATCH_OPERATION = "watch-crash" as const;

export type WatchCrashRequest = {
  packageName: string;
  durationSec?: number;
  /** REQUIRED adb serial. There is no default: an observation that cannot name the device it
   *  watched is not evidence about any device, and a defaulted serial watches whatever happens to
   *  be attached. The registered tool refuses a missing target BEFORE any CLI resolution. */
  device: string;
  start?: boolean;
  activity?: string;
  intervalSec?: number;
};

/**
 * The seam the watch observation runs through. `now` is a MONOTONIC millisecond clock (production:
 * performance.now()), injected so tests can script a 60-second window without sleeping for it, and
 * so a wall-clock jump can never turn an early exit into a covered window.
 */
export type WatchCrashRuntime = {
  now: () => number;
  capability: () => OperationCapability;
  nativeDurationFlag: () => CliRouteDurationFlag | null;
  run: (argv: string[], options: { timeoutMs: number }) => Promise<PicoCliCommandResult>;
  retain: (input: PicoCliObservationRetentionInput) => PicoCliRetainedObservation;
  /** Absolute path of the resolved CLI, for manual setup guidance only — never executed here. */
  cliPath: string;
  cliRaw: string;
};

function retainedLogFields(retained: PicoCliRetainedObservation): Record<string, unknown> {
  return retained.retained
    ? {
        retainedLog: {
          directory: retained.directory,
          stdoutPath: retained.stdoutPath,
          stderrPath: retained.stderrPath,
          recordPath: retained.recordPath,
          stdoutSha256: retained.stdoutSha256,
          stderrSha256: retained.stderrSha256,
          stdoutBytes: retained.stdoutBytes,
          stderrBytes: retained.stderrBytes,
          outputTruncated: retained.outputTruncated,
        },
      }
    : { retainedLogError: retained.error };
}

function capabilityDisclosure(capability: OperationCapability): Record<string, unknown> {
  return {
    capability: {
      evidenceScope: "help-only",
      runtimeTested: false,
      visuallyReviewed: false,
      operation: capability.operation,
      state: capability.state,
      reason: capability.reason,
      argvPrefix: capability.argvPrefix ? [...capability.argvPrefix] : null,
      evidence: capability.evidence.flatMap((observation) => [observation.stdoutPath, observation.stderrPath]),
    },
  };
}

/**
 * One bounded crash-watch observation: capability gate, argv selection, bounded run, immutable raw
 * retention, and honest coverage. Exported (with its runtime seam) so the timing contract can be
 * tested against real fake children and a scripted clock instead of real minutes.
 */
export async function observeWatchCrash(
  request: WatchCrashRequest,
  runtime: WatchCrashRuntime,
): Promise<Record<string, unknown>> {
  const sec = Math.min(300, Math.max(5, Math.round(request.durationSec ?? 30)));

  // 1. Never dispatch without capability evidence bound to THIS execution target.
  const capability = runtime.capability();
  if (capability.state !== "supported" || !capability.argvPrefix || capability.argvPrefix.length === 0) {
    const failureClass = capabilityFailureClass(capability);
    const environmentGuidance = failureClass === "environment"
      ? describePicoCliEnvironmentFailure(capability.reason, "", WATCH_OPERATION)
      : null;
    const note = failureClass === "setup-required"
      ? SETUP_REQUIRED_NOTE
      : failureClass === "environment"
        ? environmentGuidance
          ?? "pico-cli reported an incomplete environment while this wrapper probed `app watch-crash`; read the capability reason before assuming a cause."
        : failureClass === "flag-or-version-drift"
          ? `pico-cli rejected \`app watch-crash --help\` (installed: ${runtime.cliRaw || "unknown"}) — its watch surface drifted from the routes this wrapper was verified against, so no watch was started.`
          : "The resolved pico-cli has no verified `app watch-crash` capability, so this wrapper started no watch. Run ensure_pico_cli to re-run bounded capability discovery, then read the capability reason below.";
    return {
      status: "failed",
      failureClass,
      note,
      ...(failureClass === "setup-required" ? { setupCommand: { path: runtime.cliPath, args: ["setup"] } } : {}),
      packageName: request.packageName,
      requestedDurationSec: sec,
      // No watchedSec and no observation: nothing was spawned, so there is no window to report.
      ...capabilityDisclosure(capability),
      honesty: WATCH_HONESTY,
    };
  }

  // 2. The requested window goes to the CLI only when this line's retained help advertises the
  //    flag AND that flag is the one watchArgv writes. Never inferred from a version comparison.
  const durationFlag = runtime.nativeDurationFlag();
  const nativeTimeoutSupported = durationFlag?.flag === "--monitor-timeout";
  const args = watchArgv(request.packageName, request.device, sec, nativeTimeoutSupported);
  if (request.start) args.push("--start");
  if (request.activity) args.push("--activity", request.activity);
  if (request.intervalSec) args.push("--interval", String(Math.round(request.intervalSec)));

  // 3. Outer watchdog. A line that was given the window gets a documented grace to settle inside
  //    its own deadline; a line that was not keeps the wrapper's kill at the requested second as
  //    its only bound (see watchWatchdogBoundSec).
  const watchdogBoundSec = watchWatchdogBoundSec(sec, nativeTimeoutSupported);
  const timeoutMs = watchdogBoundSec * 1000;
  const startedAtMs = runtime.now();
  const r = await runtime.run(args, { timeoutMs });
  const elapsedSec = Math.round(Math.max(0, runtime.now() - startedAtMs)) / 1000;
  const output = `${r.stdout}\n${r.stderr}`.trim();
  const endedBy = classifyWatchEnd({
    nativeTimeoutSupported,
    requestedDurationSec: sec,
    elapsedSec,
    timedOut: r.timedOut,
    spawnError: Boolean(r.spawnError),
  });
  const observation = assessCoverage({
    requestedDurationSec: sec,
    elapsedSec,
    nativeTimeoutSupported,
    endedBy,
    exitCode: r.code,
    outputComplete: !r.outputTruncated,
    monitoredSec: null,
  });

  // 4. Retain the bounded raw streams immutably before any of them is summarised away.
  const retained = runtime.retain({
    operation: WATCH_OPERATION,
    argv: args,
    result: r,
    metadata: {
      packageName: request.packageName,
      device: request.device,
      nativeTimeoutSupported,
      ...(durationFlag ? { nativeDurationFlag: durationFlag } : {}),
      watchdogBoundSec,
      watchdogGraceSec: nativeTimeoutSupported ? WATCH_WATCHDOG_GRACE_SEC : 0,
      observation,
      capabilityReason: capability.reason,
    },
  });

  const observationFields = {
    packageName: request.packageName,
    requestedDurationSec: sec,
    watchedSec: observation.elapsedSec,
    nativeTimeoutSupported,
    observation,
    coverageNote: describeCoverage(observation, nativeTimeoutSupported),
    ...retainedLogFields(retained),
  };

  const cleanDurationCap = r.timedOut && !r.spawnError;
  const cleanCliExit = !r.timedOut && !r.spawnError && r.code === 0;
  if (!cleanDurationCap && !cleanCliExit) {
    const failureClass = r.spawnError ? "runtime" : classifyPicoCliFailure(r.stderr, r.stdout);
    return {
      status: "failed",
      failureClass,
      note: r.spawnError
        ? "pico-cli app watch-crash did not satisfy its bounded execution and managed-integrity checks — treat the watch window as failed."
        : failureClass === "flag-or-version-drift"
        ? `pico-cli rejected the invocation (installed: ${runtime.cliRaw || "unknown"}) — its watch-crash surface drifted from the routes and flags this wrapper was verified against.`
        : failureClass === "setup-required"
          ? SETUP_REQUIRED_NOTE
          : failureClass === "environment"
            ? describePicoCliEnvironmentFailure(r.stderr, r.stdout, WATCH_OPERATION)
              ?? "pico-cli app watch-crash exited before the window elapsed — read outputTail (the CLI's own words) before assuming a cause."
            : "pico-cli app watch-crash exited before the window elapsed — read outputTail (the CLI's own words) before assuming a cause.",
      ...(failureClass === "setup-required" ? { setupCommand: { path: runtime.cliPath, args: ["setup"] } } : {}),
      exitCode: r.code,
      ...(r.spawnError ? { error: r.spawnError } : {}),
      ...(output ? { outputTail: tail(output, 20) } : {}),
      ...(r.outputTruncated ? { outputTruncated: true } : {}),
      ...observationFields,
      honesty: WATCH_HONESTY,
    };
  }

  // 5. The marker scan reads the COMPLETE retained log, not the returned tail. When the capture cap
  //    truncated that log the scan itself is incomplete, and silence cannot mean "no crash".
  const indicators = scanForCrashIndicators(output);
  const scanComplete = !r.outputTruncated;
  const assessment = watchAssessment({ indicators, coverage: observation.coverage, scanComplete });
  return {
    status: "ok",
    ...observationFields,
    endedBy: r.timedOut
      ? `duration-cap (watchdog: this wrapper killed the watcher after ${observation.elapsedSec}s; ${sec}s requested, ${watchdogBoundSec}s hard bound)`
      : endedBy === "native-duration"
        ? `cli-exit code ${r.code} (the CLI's own --monitor-timeout window elapsed)`
        : `cli-exit code ${r.code} after ${observation.elapsedSec}s of a ${sec}s request`,
    crashIndicated: indicators.length > 0,
    crashScanComplete: scanComplete,
    assessment,
    indicators,
    ...(output ? { outputTail: tail(output, 40) } : { outputTail: "(no output during the window)" }),
    ...(r.outputTruncated ? {
      outputTruncated: true,
      note: "pico-cli output exceeded the capture cap; crash indicators were scanned only over the retained (truncated) log, so crashIndicated:false does not prove the window was quiet.",
    } : {}),
    honesty: WATCH_HONESTY,
  };
}

export function registerPicoCliTools(server: McpServer) {
  server.registerTool(
    "watch_crash",
    {
      description:
        "Monitor a package for crashes with PICO's OFFICIAL crash watcher (`pico-cli app watch-crash <pkg>`: PID-change " +
        "polling + surfaced exception logs) for a bounded window. On a CLI line whose retained help advertises " +
        "`--monitor-timeout` the requested window is handed to the CLI itself; on a line without it the CLI's own " +
        "monitoring bound is a constant this wrapper cannot set. Either way an outer watchdog kills a stuck child after " +
        "the requested window — plus 20s of settlement grace only where the CLI was given that window — " +
        "reported as endedBy:'duration-cap …'. watchedSec is the OBSERVED elapsed window, " +
        "never the requested one — read observation.coverage (complete/partial/unknown) and assessment before treating a " +
        "quiet window as a no-crash result. Bounded raw stdout/stderr are retained immutably (retainedLog) and the crash " +
        "scan reads that complete log, not the returned tail. Requires an explicit `device` serial — there is no default " +
        "target, and a missing one is refused before any CLI resolution. Optionally starts the app first (--start/--activity); " +
        "nothing is launched implicitly. Dispatch requires verified `app watch-crash` capability evidence for the resolved " +
        "package. Resolves the latest managed @picoxr/pico-cli lazily and runs its absolute path; successful resolution is " +
        "returned as picoCli provenance. HONESTY: " + WATCH_HONESTY,
      // Typed contract (2026-07-28 revision lane): the shared CLI-wrapper core + the watch fields.
      outputSchema: z.object({
        status: z.enum(["ok", "failed", "unavailable"]).describe("ok = the window ran and is reported (a watchdog kill of a stuck child is reported here too, but it is never graded observation.coverage:'complete'); failed = the CLI exited non-zero early, or its capability evidence refuses the route; unavailable = pico-cli absent/unusable."),
        ...cliWrapperContractShape,
        packageName: z.string().optional(),
        watchedSec: z.number().optional().describe("OBSERVED elapsed seconds from a monotonic clock. MEANING CHANGED (C3): this was previously the REQUESTED window; it is now what was actually observed, and it can be far shorter."),
        requestedDurationSec: z.number().optional().describe("The window that was asked for. Compare with watchedSec and observation.coverage."),
        nativeTimeoutSupported: z.boolean().optional().describe("True when the resolved line's retained help advertises --monitor-timeout and the request was handed to the CLI."),
        observation: z.object({
          requestedDurationSec: z.number(),
          elapsedSec: z.number(),
          monitoredSec: z.number().nullable().describe("Null on every retained CLI line: neither reports its post-launch monitoring time."),
          endedBy: z.enum(["cli-exit", "native-duration", "watchdog", "error"]),
          coverage: z.enum(["complete", "partial", "unknown"]),
          outputComplete: z.boolean(),
        }).optional().describe("How much of the requested window this observation actually covered."),
        coverageNote: z.string().optional().describe("What the coverage grade does and does not establish, in plain words."),
        retainedLog: z.record(z.unknown()).optional().describe("Run-unique immutable copy of the bounded raw stdout/stderr, with sha256, byte counts and truncation state."),
        retainedLogError: z.string().optional().describe("Why the raw streams could not be retained; the observation is still reported."),
        capability: z.record(z.unknown()).optional().describe("The per-operation capability evidence behind a refusal: state, verbatim reason, route and evidence paths."),
        endedBy: z.string().optional().describe("'duration-cap …' is this wrapper's watchdog; anything else is the CLI's own exit."),
        crashIndicated: z.boolean().optional().describe("Best-effort keyword scan over the complete retained log — a verdict lives in outputTail, not here."),
        crashScanComplete: z.boolean().optional().describe("False when the retained log was truncated: crashIndicated:false then does not prove a quiet window."),
        assessment: z.enum(["crash-indicated", "no-crash-detected", "inconclusive"]).optional().describe("'no-crash-detected' requires complete coverage AND a complete scan; otherwise silence is 'inconclusive'."),
        indicators: z.array(z.string()).optional().describe("Named crash markers found (fatal-exception, anr, …)."),
        exitCode: z.number().nullable().optional(),
      }).passthrough(),
      inputSchema: {
        packageName: z.string().describe("Package to watch, e.g. com.example.knockdownxr"),
        durationSec: z.number().min(5).max(300).optional().describe("Requested watch window in seconds (default 30). Passed to the CLI as --monitor-timeout where that flag exists; otherwise only an outer watchdog bounds the child."),
        // Required in the SCHEMA, not merely in the prose: a client that omits it is refused by
        // the protocol before the handler runs. The handler's own refusal still covers the empty /
        // whitespace-only string, which the schema cannot reject.
        device: z.string().describe("REQUIRED adb device serial. There is no default: an observation names the device it watched."),
        start: z.boolean().optional().describe("Pass --start so pico-cli launches the app before watching (default false)."),
        activity: z.string().optional().describe("Optional activity for --start, e.g. .MainActivity"),
        intervalSec: z.number().min(1).max(30).optional().describe("PID-poll interval seconds (CLI default 2)."),
      },
    },
    async ({ packageName, durationSec, device, start, activity, intervalSec }) => {
      // Explicit target identity, checked before any CLI work (same rule as capture_record and
      // capture_frame): a watch that cannot name its device is not evidence about any device, and
      // a defaulted serial watches whatever is attached.
      if (!device || !device.trim()) {
        return okJsonStructured({
          status: "failed",
          failureClass: "runtime",
          note: "device is required: watch_crash names the device the observation watched, and there is no default target. Pass the adb serial of the device to watch.",
          packageName,
        });
      }
      const ensured = await ensurePicoCli();
      if (ensured.status !== "ok") {
        return okJsonStructured({
          status: "unavailable",
          failureClass: ensured.failureClass,
          note: ensured.note,
          ...(ensured.outputTail ? { outputTail: ensured.outputTail } : {}),
        });
      }
      const cli = picoCliFromEnsure(ensured)!;
      const provenance = { picoCli: picoCliProvenance(ensured) };
      const observed = await observeWatchCrash(
        { packageName, device, ...(durationSec !== undefined ? { durationSec } : {}),
          ...(start !== undefined ? { start } : {}), ...(activity !== undefined ? { activity } : {}),
          ...(intervalSec !== undefined ? { intervalSec } : {}) },
        {
          // performance.now() is monotonic: a wall-clock adjustment mid-watch cannot inflate or
          // shrink the observed window.
          now: () => performance.now(),
          capability: () => picoCliOperationCapability(cli, WATCH_OPERATION),
          nativeDurationFlag: () => cliOperationNativeDurationFlag(cli.version ?? "", WATCH_OPERATION),
          run: (argv, options) => runPicoCli(cli, argv, { timeoutMs: options.timeoutMs }),
          retain: (input) => retainPicoCliObservation(input),
          cliPath: cli.path,
          cliRaw: cli.raw ?? "",
        },
      );
      return okJsonStructured({ ...observed, ...provenance });
    },
  );

  server.registerTool(
    "capture_record",
    {
      description:
        "Record the device screen with PICO's OFFICIAL recorder (`pico-cli capture record`, 1-180s) and pull the file " +
        "locally as a RECORDING evidence artifact — the video lane for demos and ledger evidence that single-frame " +
        "captures lack. Returns the stat-checked output path + size. Resolves the latest managed @picoxr/pico-cli " +
        "lazily and runs its absolute path; successful resolution is returned as picoCli provenance. READ `status` AND " +
        "`media` TOGETHER: `status` grades the recording CALL (ok = the CLI exited 0, the file exists with real bytes, " +
        "and container inspection did not fail); `media` is the separate validation verdict — validated = the " +
        "container parsed, invalid = it did not (status is then failed), unvalidated = the container was NOT inspected " +
        "at all (over the inspection budget, or unreadable), so status ok with media unvalidated is an uninspected " +
        "file, never a validated recording. HONESTY: " + RECORD_HONESTY,
      // Typed contract (2026-07-28 revision lane): the shared CLI-wrapper core + the artifact fields.
      outputSchema: z.object({
        status: z.enum(["ok", "failed", "unavailable"]).describe("Grades the recording CALL only: ok = the CLI exited 0, the recording exists with real bytes (stat-checked — exit 0 alone is never ok) and container inspection did not fail; failed = run failed, the file is missing/empty, or the container is invalid; unavailable = pico-cli absent/unusable. Read `media` for whether the container was actually validated."),
        ...cliWrapperContractShape,
        artifact: z.string().optional().describe("The recording path. Its pixels prove nothing until LOOKED at."),
        artifactExists: z.boolean().optional(),
        artifactBytes: z.number().nullable().optional(),
        durationSec: z.number().optional().describe("Deprecated alias of requestedDurationSec — the CLAMPED REQUEST, never a measurement."),
        requestedDurationSec: z.number().optional().describe("What this wrapper asked the CLI for, after clamping to the 1-180s range."),
        measuredDurationSec: z.number().nullable().optional().describe("Duration read from the recording's OWN movie header. null when the container states none or nothing could inspect it."),
        media: z.enum(["validated", "unvalidated", "invalid"]).optional().describe("The validation verdict, separate from `status`: validated = the container parsed; invalid = it did not (status is then failed); unvalidated = the container was NOT inspected (over the inspection budget, or unreadable) — never a successful decode, so status ok beside it means an uninspected file."),
        artifactSha256: z.string().nullable().optional(),
        exitCode: z.number().nullable().optional(),
      }).passthrough(),
      inputSchema: {
        durationSec: z.number().min(1).max(180).optional().describe("Recording length in seconds (CLI range 1-180; default 15)."),
        // Required in the SCHEMA, not merely in the prose: a client that omits it is refused by
        // the protocol before the handler runs. The handler's own refusal below still covers the
        // empty / whitespace-only string, which the schema cannot reject.
        device: z.string().describe("REQUIRED adb device serial. There is no default: a recording names the device it came from."),
        outputPath: z.string().optional().describe("Local output path. Default: a run-unique file under the observation root, never a fixed or shared path a later recording can overwrite."),
      },
    },
    async ({ durationSec, device, outputPath }) => {
      // Explicit target identity, checked before any CLI work: a recording that cannot name its
      // device is not evidence about any device, and a default serial records whatever is attached.
      if (!device || !device.trim()) {
        return okJsonStructured({
          status: "failed",
          failureClass: "runtime",
          note: "device is required: capture_record names the device the recording came from, and there is no default target. Pass the adb serial of the device to record.",
        });
      }
      const ensured = await ensurePicoCli();
      if (ensured.status !== "ok") {
        return okJsonStructured({
          status: "unavailable",
          failureClass: ensured.failureClass,
          note: ensured.note,
          ...(ensured.outputTail ? { outputTail: ensured.outputTail } : {}),
        });
      }
      const cli = picoCliFromEnsure(ensured)!;
      const provenance = { picoCli: picoCliProvenance(ensured) };
      const sec = Math.min(180, Math.max(1, Math.round(durationSec ?? 15)));
      // Run-unique by construction. The old default was a wall-clock name in one shared directory:
      // two recordings started in the same millisecond collided, and nothing tied a file to its run.
      const runId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}`;
      const artifact = outputPath ?? path.join(picoCliObservationRoot(), "capture-record", runId, "recording.mp4");
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      const args = ["capture", "record", "-t", String(sec), "-o", artifact, "-d", device];

      // The CLI blocks for the recording duration, then pulls the file — allow generous pull time.
      const r = await runPicoCli(cli, args, { timeoutMs: (sec + 120) * 1000 });
      const output = `${r.stdout}\n${r.stderr}`.trim();
      if (r.spawnError || r.timedOut || r.code !== 0) {
        const failureClass = r.spawnError ? "runtime" : classifyPicoCliFailure(r.stderr, r.stdout);
        return okJsonStructured({
          status: "failed",
          failureClass,
          note: r.spawnError
            ? "pico-cli capture record did not satisfy its bounded execution and managed-integrity checks — treat the recording as failed."
            : r.timedOut
            ? `pico-cli capture record did not finish within ${sec + 120}s and was killed — read outputTail.`
            : failureClass === "flag-or-version-drift"
              ? `pico-cli rejected the invocation (installed: ${cli.raw || "unknown"}) — its capture surface drifted from the 0.3.0/0.4.2 flags this wrapper was verified against.`
              : failureClass === "setup-required"
                ? "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry."
                : "pico-cli capture record failed at runtime — read outputTail (the CLI's own words) before assuming a cause.",
          ...(failureClass === "setup-required" ? { setupCommand: { path: cli.path, args: ["setup"] } } : {}),
          exitCode: r.code,
          ...(r.spawnError ? { error: r.spawnError } : {}),
          ...(output ? { outputTail: tail(output, 20) } : {}),
          ...(r.outputTruncated ? { outputTruncated: true } : {}),
          ...provenance,
        });
      }
      // Exit 0 is not evidence the recording is a non-empty regular file — stat once and fail closed.
      const inspection = inspectPicoCliArtifact(artifact);
      const artifactOk = inspection.exists === true && inspection.regularFile && (inspection.bytes ?? 0) > 0;
      // ...and a nonempty regular file is not evidence it is a recording. Inspect the container.
      const media = artifactOk ? inspectRecordingArtifact(artifact) : null;
      const artifactFailure = inspection.statError
        ? `could not be stat-checked: ${inspection.statError}`
        : inspection.exists === false
          ? "missing"
          : !inspection.regularFile
            ? "not a regular file"
            : "empty";
      const mediaInvalid = media?.media === "invalid";
      return okJsonStructured({
        status: artifactOk && !mediaInvalid ? "ok" : "failed",
        artifact,
        ...(inspection.exists === null ? {} : { artifactExists: inspection.exists }),
        artifactBytes: inspection.bytes,
        durationSec: sec,
        requestedDurationSec: sec,
        ...(media
          ? {
              media: media.media,
              measuredDurationSec: media.measuredDurationSec,
              artifactSha256: media.sha256,
              hasVideoTrack: media.hasVideoTrack,
              mediaNote: media.reason,
              // The CLI's own returned duration is the clamped request; only measuredDurationSec is
              // read from the file. They are reported side by side precisely so nobody conflates them.
              durationNote: media.measuredDurationSec === null
                ? `requested ${sec}s; the file states no measurable duration, so the request is the only number here and it is not evidence of length`
                : `requested ${sec}s; the file's own movie header measures ${media.measuredDurationSec}s`,
            }
          : {}),
        ...(artifactOk && !mediaInvalid
          ? {}
          : {
              failureClass: "runtime",
              note: mediaInvalid
                ? `pico-cli exited 0 and wrote ${inspection.bytes} bytes to ${artifact}, but ${media!.reason} — treat as failed.`
                : `pico-cli exited 0 but the recording at ${artifact} is ${artifactFailure} — treat as failed.`,
              ...(inspection.statError ? { error: inspection.statError } : {}),
            }),
        ...(output ? { outputTail: tail(output, 12) } : {}),
        ...(r.outputTruncated ? { outputTruncated: true } : {}),
        honesty: RECORD_HONESTY,
        ...provenance,
      });
    },
  );
}
