import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  "The artifact is the file pulled by the official CLI; this tool checks only that it is a " +
  "nonempty regular file, not that its container is valid. Its pixels prove nothing until LOOKED " +
  "at. Guest-side adb screenrecord and pico-cli capture record " +
  "yield empty/invalid files on this emulator display; the working macOS host-side recipe is " +
  "screencapture -V -l<windowId>. Evidence class: a capture artifact " +
  "that still requires a LOOK before any visual claim.";

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
const DEFAULT_WATCH_DEVICE = "emulator-5554";

export type WatchCrashRequest = {
  packageName: string;
  durationSec?: number;
  device?: string;
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
  const args = watchArgv(request.packageName, request.device ?? DEFAULT_WATCH_DEVICE, sec, nativeTimeoutSupported);
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
      device: request.device ?? DEFAULT_WATCH_DEVICE,
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
        "scan reads that complete log, not the returned tail. Optionally starts the app first (--start/--activity); " +
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
        device: z.string().optional().describe("Device serial (default emulator-5554)."),
        start: z.boolean().optional().describe("Pass --start so pico-cli launches the app before watching (default false)."),
        activity: z.string().optional().describe("Optional activity for --start, e.g. .MainActivity"),
        intervalSec: z.number().min(1).max(30).optional().describe("PID-poll interval seconds (CLI default 2)."),
      },
    },
    async ({ packageName, durationSec, device, start, activity, intervalSec }) => {
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
        { packageName, ...(durationSec !== undefined ? { durationSec } : {}), ...(device !== undefined ? { device } : {}),
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
        "lazily and runs its absolute path; successful resolution is returned as picoCli provenance. HONESTY: " + RECORD_HONESTY,
      // Typed contract (2026-07-28 revision lane): the shared CLI-wrapper core + the artifact fields.
      outputSchema: z.object({
        status: z.enum(["ok", "failed", "unavailable"]).describe("ok = the recording exists with real bytes (stat-checked — exit 0 alone is never ok); failed = run failed or the file is missing/empty; unavailable = pico-cli absent/unusable."),
        ...cliWrapperContractShape,
        artifact: z.string().optional().describe("The recording path. Its pixels prove nothing until LOOKED at."),
        artifactExists: z.boolean().optional(),
        artifactBytes: z.number().nullable().optional(),
        durationSec: z.number().optional(),
        exitCode: z.number().nullable().optional(),
      }).passthrough(),
      inputSchema: {
        durationSec: z.number().min(1).max(180).optional().describe("Recording length in seconds (CLI range 1-180; default 15)."),
        device: z.string().optional().describe("Device serial (default emulator-5554)."),
        outputPath: z.string().optional().describe("Local output path (default ~/.pico-mcp/recordings/rec-<timestamp>.mp4)."),
      },
    },
    async ({ durationSec, device, outputPath }) => {
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
      const outDir = path.join(os.homedir(), ".pico-mcp", "recordings");
      fs.mkdirSync(outDir, { recursive: true });
      const artifact = outputPath ?? path.join(outDir, `rec-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`);
      const args = ["capture", "record", "-t", String(sec), "-o", artifact, "-d", device ?? "emulator-5554"];

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
      const artifactFailure = inspection.statError
        ? `could not be stat-checked: ${inspection.statError}`
        : inspection.exists === false
          ? "missing"
          : !inspection.regularFile
            ? "not a regular file"
            : "empty";
      return okJsonStructured({
        status: artifactOk ? "ok" : "failed",
        artifact,
        ...(inspection.exists === null ? {} : { artifactExists: inspection.exists }),
        artifactBytes: inspection.bytes,
        durationSec: sec,
        ...(artifactOk
          ? {}
          : {
              failureClass: "runtime",
              note: `pico-cli exited 0 but the recording at ${artifact} is ${artifactFailure} — treat as failed.`,
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
