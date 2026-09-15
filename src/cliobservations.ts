/**
 * cliobservations.ts — how much of a requested observation window a bounded pico-cli run actually
 * covered. Pure arithmetic over readings the caller supplies: no fs, no spawn, no clock of its own.
 *
 * The problem this module exists to fix: reporting the REQUESTED window as if it had been observed.
 * A watch that was asked for 60 seconds and whose child returned after 1 second observed 1 second,
 * and a quiet 1-second window is not evidence that nothing crashed in the other 59.
 *
 * Retained CLI facts behind the model (byte-checked excerpts from the 2026-09-15 audit, with the
 * help bytes copied into test/fixtures/picocli/help/):
 *
 *  - 0.4.4 `app watch-crash` (excerpt WATCH044; help fixture 0.4.4/025) exposes NO duration flag.
 *    It waits for a PID for up to `--launch-timeout` seconds (default 30) and then runs an
 *    INTERNAL 30-second monitoring loop (`for(;Date.now()-o<3e4;)`). So on that line the observed
 *    window is bounded by a constant we never set, whatever we request — and the old claim that it
 *    "streams indefinitely" was wrong in both directions.
 *  - 0.5.0 adds `--monitor-timeout <seconds>`, default 30 (excerpts WATCH_ARGS050 / WATCH050; help
 *    fixture 0.5.0/096), described in its own help as "Total wall-clock seconds to wait for the
 *    process and crash signals". WATCH050 shows one absolute deadline `a = start + timeout` shared
 *    by device resolution, the optional `--start` launch, the PID wait, every poll sleep and the
 *    final log collection. The handler also returns EARLY: with no PID found, and on any process
 *    change, where it separates confirmed correlated crash evidence from a restart/exit with no
 *    correlated evidence.
 *
 * Two consequences encoded below. Elapsed wall-clock time is NOT monitoring time — it includes the
 * launch and PID wait the CLI charges to the same budget. And the CLI never prints how long it
 * actually monitored, so `monitoredSec` stays null: see MONITORED_WINDOW_UNAVAILABLE.
 */

/** The coverage record attached to every observation result. */
export type ObservationCoverage = {
  requestedDurationSec: number;
  elapsedSec: number;
  monitoredSec: number | null;
  endedBy: "cli-exit" | "native-duration" | "watchdog" | "error";
  coverage: "complete" | "partial" | "unknown";
  outputComplete: boolean;
};

/** The exact field set of ObservationCoverage, so a consumer can pin the shape it renders. */
export const ObservationCoverageKeys: readonly (keyof ObservationCoverage)[] = [
  "requestedDurationSec",
  "elapsedSec",
  "monitoredSec",
  "endedBy",
  "coverage",
  "outputComplete",
] as const;

/**
 * Why `monitoredSec` is null for every retained CLI line. 0.4.4 prints only "No crash detected
 * during the monitoring window" and 0.5.0 prints "No crash detected during the <requested>s
 * monitoring window" — the REQUESTED budget echoed back, never the time actually spent monitoring
 * after the launch and PID wait were paid out of the same deadline (WATCH044 / WATCH050).
 */
export const MONITORED_WINDOW_UNAVAILABLE =
  "monitoredSec is null: neither retained pico-cli line reports how long it monitored after paying "
  + "for device resolution, the optional launch and the PID wait out of the same budget, so elapsed "
  + "wall-clock time must not be read as monitoring time.";

/**
 * Seconds allowed ON TOP of a window the CLI was actually given, before the outer watchdog kills a
 * child that has not settled. It is the CLI's own settlement allowance: process start-up, device
 * resolution, and the final log collection WATCH050 performs as its deadline expires. A documented
 * constant, never a multiplier — the watchdog is a safety bound on a hung child, not a second
 * observation window.
 */
export const WATCH_WATCHDOG_GRACE_SEC = 20;

/**
 * The hard settlement bound handed to the bounded runner.
 *
 * The grace is added only when the requested window was handed to the CLI through its own duration
 * flag: killing at exactly the requested second could then cut off the launch, PID wait or final
 * log collection the CLI charges to that same deadline, destroying evidence it was about to print.
 *
 * On a line with no duration flag the CLI was never given this window. Its own bound is a constant
 * this wrapper did not set — WATCH044 waits up to `--launch-timeout` seconds (default 30) for a PID
 * and then runs an internal 30 s loop, which no 20 s grace could cover anyway — so waiting past the
 * request buys latency, not evidence: coverage is capped at `partial` either way, and a grace would
 * make the reported observed window LONGER than the window that was asked for. The wrapper's kill
 * at the requested second is therefore the bound, unchanged from before this revision.
 */
export function watchWatchdogBoundSec(requestedDurationSec: number, nativeTimeoutSupported: boolean): number {
  return nativeTimeoutSupported ? requestedDurationSec + WATCH_WATCHDOG_GRACE_SEC : requestedDurationSec;
}

/**
 * The wrapper argv for one bounded crash watch. `--monitor-timeout` is appended only when the
 * caller proved the flag exists on the resolved package's line (see cliOperationNativeDurationFlag
 * in clicapabilities.ts); it is never inferred from a version comparison here.
 */
export function watchArgv(
  packageName: string, serial: string, durationSec: number, nativeTimeout: boolean,
): string[] {
  const args = ["app", "watch-crash", packageName, "-d", serial];
  if (nativeTimeout) args.push("--monitor-timeout", String(durationSec));
  return args;
}

export type WatchEndInput = {
  nativeTimeoutSupported: boolean;
  requestedDurationSec: number;
  elapsedSec: number;
  timedOut: boolean;
  spawnError: boolean;
};

/**
 * How the window ended. `native-duration` is claimed only when we passed the CLI its own duration
 * AND the child survived at least the whole requested window: the CLI's deadline starts inside the
 * child, after ours, so a genuine native expiry always reads as elapsed >= requested. Anything
 * shorter is the CLI returning for its own reason (no PID, a detected process change, an error).
 */
export function classifyWatchEnd(input: WatchEndInput): ObservationCoverage["endedBy"] {
  if (input.spawnError) return "error";
  if (input.timedOut) return "watchdog";
  if (input.nativeTimeoutSupported && input.elapsedSec >= input.requestedDurationSec) return "native-duration";
  return "cli-exit";
}

export type CoverageInput = {
  requestedDurationSec: number;
  elapsedSec: number;
  nativeTimeoutSupported: boolean;
  endedBy: ObservationCoverage["endedBy"];
  exitCode: number | null;
  outputComplete: boolean;
  monitoredSec?: number | null;
};

/**
 * Whether the captured stream is whole. The `outputComplete` INPUT answers only "the capture cap
 * retained everything the child wrote"; a watchdog kill cut the stream mid-flight no matter what
 * the cap did, so the emitted record reports that as incomplete output.
 */
function observedOutputComplete(input: CoverageInput): boolean {
  return input.outputComplete && input.endedBy !== "watchdog";
}

function deriveCoverage(input: CoverageInput, outputComplete: boolean): ObservationCoverage["coverage"] {
  // A spawn or guard error observed nothing: there is no window to grade.
  if (input.endedBy === "error") return "unknown";
  const reachedRequestedWindow = input.elapsedSec >= input.requestedDurationSec;
  if (!input.nativeTimeoutSupported) {
    // The requested window was never handed to the CLI, so its own bound is a constant we did not
    // set (WATCH044: a 30 s loop after the PID wait). An early exit establishes nothing at all;
    // reaching the requested wall-clock window bounds our observation but not the CLI's monitoring.
    return reachedRequestedWindow ? "partial" : "unknown";
  }
  if (!outputComplete) return "partial";
  if (input.exitCode !== null && input.exitCode !== 0) return "partial";
  // Only the CLI ending the window ITSELF can be complete.
  //
  // `cli-exit` under a native timeout means the CLI returned before its own deadline. And a
  // `watchdog` end is the WEAKEST evidence, not the strongest: the child blew past the deadline we
  // handed it by the entire grace and had to be killed, so it never performed the end-of-window log
  // collection WATCH050 charges to that same deadline — and a killed child has no exit code, so the
  // nonzero-exit guard above never fires for it. Grading that `complete` would produce the
  // strongest verdict from the weakest evidence, and would contradict the non-native branch, which
  // caps the identical kill at `partial`.
  return reachedRequestedWindow && input.endedBy === "native-duration" ? "complete" : "partial";
}

/**
 * Grade one bounded observation. `complete` requires all three: the CLI was given the window
 * natively, it ended that window itself (`native-duration`) rather than being killed, and the
 * captured output is whole. A watchdog kill is never complete on either line.
 */
export function assessCoverage(input: CoverageInput): ObservationCoverage {
  const outputComplete = observedOutputComplete(input);
  return {
    requestedDurationSec: input.requestedDurationSec,
    elapsedSec: input.elapsedSec,
    monitoredSec: input.monitoredSec ?? null,
    endedBy: input.endedBy,
    coverage: deriveCoverage(input, outputComplete),
    outputComplete,
  };
}

/** One sentence naming exactly what the coverage grade does and does not establish. */
export function describeCoverage(coverage: ObservationCoverage, nativeTimeoutSupported: boolean): string {
  const window = `${coverage.elapsedSec}s observed of a ${coverage.requestedDurationSec}s request`;
  switch (coverage.coverage) {
    case "complete":
      // Only reachable for `native-duration`: the CLI ended its own window and exited on its own.
      return `complete: ${window}; the CLI was given the window with --monitor-timeout and ended it itself (${coverage.endedBy}) with whole output. `
        + MONITORED_WINDOW_UNAVAILABLE;
    case "partial":
      return `partial: ${window}, ended by ${coverage.endedBy}`
        + (coverage.endedBy === "watchdog"
          ? ", so this wrapper killed a child that had not settled: the CLI never ended the window itself, and its end-of-window log collection never ran"
          : coverage.outputComplete ? "" : ", and the captured output was truncated")
        + (coverage.endedBy === "watchdog"
          ? ". A killed child is the weakest evidence there is; silence here says nothing about what the CLI did or did not see."
          : nativeTimeoutSupported
            ? ". The window was cut short, so the unobserved remainder is unknown."
            : ". This CLI line has no duration flag, so the window was never handed to it and its own monitoring bound is a constant this wrapper did not set.")
        + " " + MONITORED_WINDOW_UNAVAILABLE;
    default:
      return `unknown: ${window}, ended by ${coverage.endedBy}`
        + (coverage.endedBy === "error"
          ? "; nothing was observed."
          : "; without a duration flag an early exit says nothing about whether the CLI monitored at all.")
        + " " + MONITORED_WINDOW_UNAVAILABLE;
  }
}

export type WatchAssessment = "crash-indicated" | "no-crash-detected" | "inconclusive";

/**
 * The honest verdict line. A quiet window is only a no-crash answer when the window was fully
 * covered AND the scanned log was whole; otherwise silence is inconclusive, never success. Since a
 * watchdog kill can never reach `complete` (assessCoverage), a killed child is always inconclusive.
 */
export function watchAssessment(input: {
  indicators: readonly string[];
  coverage: ObservationCoverage["coverage"];
  scanComplete: boolean;
}): WatchAssessment {
  if (input.indicators.length > 0) return "crash-indicated";
  return input.coverage === "complete" && input.scanComplete ? "no-crash-detected" : "inconclusive";
}
