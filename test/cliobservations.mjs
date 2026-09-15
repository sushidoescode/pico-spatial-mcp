// C3 observation-coverage lane: the pure coverage/argv arithmetic in dist/cliobservations.js and
// the watch_crash observation wrapper in dist/picoclitools.js.
//
// Deliberately spawns NO pico-cli and NO MCP server. Every child here is a fake node script driven
// by the PRODUCTION bounded runner (dist/picocli.js runPicoCliCommand), and every duration in the
// result comes from an INJECTED monotonic clock, so a "60 second" window costs milliseconds of
// real time. Run: node --test test/cliobservations.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const {
  ObservationCoverageKeys,
  assessCoverage,
  classifyWatchEnd,
  watchArgv,
  watchAssessment,
  WATCH_WATCHDOG_GRACE_SEC,
  watchWatchdogBoundSec,
  MONITORED_WINDOW_UNAVAILABLE,
} = await import("../dist/cliobservations.js");
const { observeWatchCrash } = await import("../dist/picoclitools.js");
const { runPicoCliCommand, retainPicoCliObservation } = await import("../dist/picocli.js");
const { cliOperationNativeDurationFlag } = await import("../dist/clicapabilities.js");

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------------------------
// A fake child the production runner really spawns. Behaviour is scripted through argv so each
// test gets a genuine exit code / kill / truncation instead of a hand-written result object.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico-cliobservations-"));
const fakeChild = path.join(tempRoot, "fake-watch-child.mjs");
fs.writeFileSync(fakeChild, `
const argv = process.argv.slice(2);
const read = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const mode = read("--fixture-mode", "quiet");
if (mode === "hang") { setInterval(() => {}, 1000); }
else {
  if (mode === "no-pid") process.stdout.write("No running pid found for com.example.fixture within 30s.\\n");
  else if (mode === "crash-early") {
    process.stdout.write("Observed pid 4242 for com.example.fixture. Monitoring crash signals...\\n");
    process.stdout.write("FATAL EXCEPTION: main\\n");
    for (let i = 0; i < 120; i += 1) process.stdout.write("  at com.example.fixture.Frame" + i + "\\n");
  }
  else if (mode === "flood") { for (let i = 0; i < 4000; i += 1) process.stdout.write("noise line " + i + " ................................\\n"); }
  else if (mode === "adb-error") { process.stderr.write("adb: device 'emulator-5554' not found\\n"); process.exit(2); }
  else process.stdout.write("No crash detected during the 60s monitoring window.\\n");
  process.exit(0);
}
`, "utf8");

const supported = (argvPrefix = ["app", "watch-crash"]) => ({
  operation: "watch-crash",
  state: "supported",
  argvPrefix,
  reason: "help-names-operation: `app watch-crash --help` exited 0 and a pico-cli usage line names `app watch-crash`",
  evidence: [{
    argv: ["app", "watch-crash", "--help"],
    exitCode: 0,
    timedOut: false,
    outputTruncated: false,
    stdoutPath: path.join(tempRoot, "evidence.stdout.txt"),
    stderrPath: path.join(tempRoot, "evidence.stderr.txt"),
    stdoutSha256: sha256(Buffer.alloc(0)),
    stderrSha256: sha256(Buffer.alloc(0)),
  }],
});

/**
 * Drive observeWatchCrash with a real fake child and a scripted clock.
 * `elapsedSec` is what the injected monotonic clock reports across the run; `realTimeoutMs` is the
 * genuine bound handed to the production runner so a "stuck" child dies in milliseconds.
 */
async function observe({
  request = { packageName: "com.example.fixture", durationSec: 60 },
  mode = "quiet",
  elapsedSec = 1,
  realTimeoutMs = 4_000,
  maxOutputBytes,
  capability = supported(),
  nativeDurationFlag = cliOperationNativeDurationFlag("0.5.0", "watch-crash"),
  retainRoot = path.join(tempRoot, `retain-${crypto.randomUUID()}`),
} = {}) {
  const seen = { argv: null, timeoutMs: null, retained: [] };
  let nowMs = 1_000_000;
  const runtime = {
    now: () => nowMs,
    capability: () => capability,
    nativeDurationFlag: () => nativeDurationFlag,
    run: async (argv, options) => {
      seen.argv = argv;
      seen.timeoutMs = options.timeoutMs;
      const result = await runPicoCliCommand(process.execPath, [fakeChild, ...argv, "--fixture-mode", mode], {
        timeoutMs: realTimeoutMs,
        ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      });
      nowMs += elapsedSec * 1000;
      return result;
    },
    retain: (input) => {
      const retained = retainPicoCliObservation(input, retainRoot);
      seen.retained.push(retained);
      return retained;
    },
    cliPath: path.join(tempRoot, "fixture-pico-cli"),
    cliRaw: "pico-cli/0.5.0 (fixture)",
  };
  const result = await observeWatchCrash(request, runtime);
  return { result, seen, retainRoot };
}

// ---------------------------------------------------------------------------------------------
test("watchArgv is the verbatim wrapper argv for both version lines", () => {
  assert.deepEqual(watchArgv("com.example.fixture", "fixture-serial", 60, true),
    ["app", "watch-crash", "com.example.fixture", "-d", "fixture-serial", "--monitor-timeout", "60"]);
  assert.deepEqual(watchArgv("com.example.fixture", "fixture-serial", 60, false),
    ["app", "watch-crash", "com.example.fixture", "-d", "fixture-serial"]);
});

test("the native duration flag is a per-version route fact, not a version comparison", () => {
  assert.equal(cliOperationNativeDurationFlag("0.4.4", "watch-crash"), null);
  assert.equal(cliOperationNativeDurationFlag("0.4.2", "watch-crash"), null);
  const flag = cliOperationNativeDurationFlag("0.5.0", "watch-crash");
  assert.equal(flag?.flag, "--monitor-timeout");
  assert.match(flag?.provenance ?? "", /096/);
  for (const operation of ["capture-record", "knowledge-server", "perf-live", "trace-record"]) {
    assert.equal(cliOperationNativeDurationFlag("0.5.0", operation), null, operation);
  }
  // A newer line inherits the newest table's flag; an unparseable version claims nothing.
  assert.equal(cliOperationNativeDurationFlag("0.6.0", "watch-crash")?.flag, "--monitor-timeout");
  for (const version of ["", "   ", "unknown", "nightly"]) {
    assert.equal(cliOperationNativeDurationFlag(version, "watch-crash"), null, JSON.stringify(version));
  }
});

test("ObservationCoverage carries exactly the declared fields", () => {
  const coverage = assessCoverage({
    requestedDurationSec: 60, elapsedSec: 60, nativeTimeoutSupported: true,
    endedBy: "native-duration", exitCode: 0, outputComplete: true, monitoredSec: null,
  });
  assert.deepEqual(Object.keys(coverage).sort(), [
    "coverage", "elapsedSec", "endedBy", "monitoredSec", "outputComplete", "requestedDurationSec",
  ]);
  assert.deepEqual(ObservationCoverageKeys.slice().sort(), Object.keys(coverage).sort());
  assert.equal(coverage.coverage, "complete");
  assert.equal(coverage.monitoredSec, null);
  assert.match(MONITORED_WINDOW_UNAVAILABLE, /monitor/i);
});

test("assessCoverage never calls an early or unbounded window complete", () => {
  const base = { requestedDurationSec: 60, nativeTimeoutSupported: true, exitCode: 0, outputComplete: true, monitoredSec: null };
  // Native timeout + the CLI ending the window ITSELF + complete output is the only `complete` shape.
  assert.equal(assessCoverage({ ...base, elapsedSec: 60, endedBy: "native-duration" }).coverage, "complete");
  // A watchdog kill is the weakest evidence, not the strongest: the child blew past the deadline we
  // gave it by the whole grace and was killed, so it never ran its end-of-window log collection.
  const killed = assessCoverage({ ...base, elapsedSec: 80, endedBy: "watchdog", exitCode: null });
  assert.equal(killed.coverage, "partial");
  assert.equal(killed.outputComplete, false, "a SIGKILL cuts the stream whatever the capture cap did");
  // Early exit inside a native window is partial: we know exactly how short it was.
  assert.equal(assessCoverage({ ...base, elapsedSec: 1, endedBy: "cli-exit" }).coverage, "partial");
  // Truncated output can never be complete.
  assert.equal(assessCoverage({ ...base, elapsedSec: 60, endedBy: "native-duration", outputComplete: false }).coverage, "partial");
  // A nonzero exit inside the window is partial, never complete.
  assert.equal(assessCoverage({ ...base, elapsedSec: 60, endedBy: "native-duration", exitCode: 2 }).coverage, "partial");
  // Without a native timeout the window was never handed to the CLI: an early exit proves nothing.
  assert.equal(assessCoverage({ ...base, nativeTimeoutSupported: false, elapsedSec: 1, endedBy: "cli-exit" }).coverage, "unknown");
  // ... and a watchdog kill only bounds wall clock, so it stays partial, never complete.
  assert.equal(assessCoverage({ ...base, nativeTimeoutSupported: false, elapsedSec: 80, endedBy: "watchdog", exitCode: null }).coverage, "partial");
  // A spawn/guard error observed nothing at all.
  assert.equal(assessCoverage({ ...base, elapsedSec: 0, endedBy: "error", exitCode: null }).coverage, "unknown");
  // The requested value is never substituted for the observed one.
  assert.equal(assessCoverage({ ...base, elapsedSec: 1, endedBy: "cli-exit" }).elapsedSec, 1);
});

test("classifyWatchEnd separates the CLI's own duration from our watchdog", () => {
  const base = { requestedDurationSec: 60, nativeTimeoutSupported: true, timedOut: false, spawnError: false };
  assert.equal(classifyWatchEnd({ ...base, elapsedSec: 60 }), "native-duration");
  assert.equal(classifyWatchEnd({ ...base, elapsedSec: 59.9 }), "cli-exit");
  assert.equal(classifyWatchEnd({ ...base, nativeTimeoutSupported: false, elapsedSec: 60 }), "cli-exit");
  assert.equal(classifyWatchEnd({ ...base, elapsedSec: 80, timedOut: true }), "watchdog");
  assert.equal(classifyWatchEnd({ ...base, elapsedSec: 0, spawnError: true }), "error");
  assert.equal(classifyWatchEnd({ ...base, elapsedSec: 0, spawnError: true, timedOut: true }), "error");
});

test("a quiet window is only a no-crash answer when coverage is complete", () => {
  assert.equal(watchAssessment({ indicators: ["fatal-exception"], coverage: "partial", scanComplete: false }), "crash-indicated");
  assert.equal(watchAssessment({ indicators: [], coverage: "complete", scanComplete: true }), "no-crash-detected");
  assert.equal(watchAssessment({ indicators: [], coverage: "partial", scanComplete: true }), "inconclusive");
  assert.equal(watchAssessment({ indicators: [], coverage: "unknown", scanComplete: true }), "inconclusive");
  assert.equal(watchAssessment({ indicators: [], coverage: "complete", scanComplete: false }), "inconclusive");
});

// ---------------------------------------------------------------------------------------------
test("a 60 second request whose child exits after 1 second reports 1 second, not 60", async () => {
  const { result, seen } = await observe({ mode: "quiet", elapsedSec: 1 });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.requestedDurationSec, 60);
  assert.equal(result.watchedSec, 1);
  assert.equal(result.observation.coverage, "partial");
  assert.equal(result.observation.endedBy, "cli-exit");
  assert.equal(result.observation.elapsedSec, 1);
  assert.equal(result.crashIndicated, false);
  assert.equal(result.assessment, "inconclusive");
  assert.deepEqual(seen.argv.slice(0, 7),
    ["app", "watch-crash", "com.example.fixture", "-d", "emulator-5554", "--monitor-timeout", "60"]);
  assert.equal(seen.timeoutMs, (60 + WATCH_WATCHDOG_GRACE_SEC) * 1000);
});

test("the watchdog grace is only spent on a line that was actually given the window", () => {
  // Given the window: the CLI charges launch, PID wait and the final log collection to that same
  // deadline (WATCH050), so it gets settlement time before the wrapper kills it.
  assert.equal(watchWatchdogBoundSec(60, true), 60 + WATCH_WATCHDOG_GRACE_SEC);
  assert.equal(watchWatchdogBoundSec(5, true), 25);
  // Not given the window: the wrapper's kill at the requested second IS the bound. Waiting longer
  // cannot raise coverage above `partial` and would report an observed window longer than the
  // requested one.
  assert.equal(watchWatchdogBoundSec(60, false), 60);
  assert.equal(watchWatchdogBoundSec(5, false), 5);
});

test("the native monitor timeout window that actually elapses is complete coverage", async () => {
  const { result } = await observe({ mode: "quiet", elapsedSec: 60 });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.watchedSec, 60);
  assert.equal(result.observation.endedBy, "native-duration");
  assert.equal(result.observation.coverage, "complete");
  assert.equal(result.observation.monitoredSec, null);
  assert.equal(result.crashIndicated, false);
  assert.equal(result.assessment, "no-crash-detected");
});

test("a CLI that gave up waiting for a process is never a clean no-crash window", async () => {
  const { result } = await observe({ mode: "no-pid", elapsedSec: 30 });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.watchedSec, 30);
  assert.equal(result.observation.coverage, "partial");
  assert.equal(result.assessment, "inconclusive");
  assert.match(result.outputTail, /No running pid found/);
});

test("a stuck child is killed by the documented watchdog and reports observed elapsed time", async () => {
  const { result, seen } = await observe({ mode: "hang", elapsedSec: 80, realTimeoutMs: 700 });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(seen.timeoutMs, 80_000);
  assert.equal(result.watchedSec, 80);
  assert.equal(result.observation.endedBy, "watchdog");
  assert.equal(result.observation.coverage, "partial");
  assert.match(result.endedBy, /^duration-cap/);
  assert.equal(result.assessment, "inconclusive");
});

test("a watchdog-killed silent child is never graded complete or no-crash-detected", async () => {
  // The worst case the old model got backwards: a child on a line that WAS given --monitor-timeout,
  // which wrote nothing at all, blew through its own deadline plus the entire grace, and had to be
  // SIGTERM/SIGKILLed. Strongest verdict from the weakest evidence.
  const { result } = await observe({ mode: "hang", elapsedSec: 80, realTimeoutMs: 700 });
  assert.equal(result.nativeTimeoutSupported, true);
  assert.equal(result.observation.endedBy, "watchdog");
  assert.equal(result.observation.coverage, "partial");
  assert.notEqual(result.observation.coverage, "complete");
  assert.equal(result.observation.outputComplete, false, "the kill cut the stream");
  assert.equal(result.crashIndicated, false);
  assert.equal(result.assessment, "inconclusive");
  assert.notEqual(result.assessment, "no-crash-detected");
  assert.equal(result.outputTail, "(no output during the window)");
  assert.doesNotMatch(result.coverageNote, /ran to the end/);
  assert.match(result.coverageNote, /never ended the window itself|end-of-window log collection/);
});

test("a stuck child without a native timeout can only be partial coverage", async () => {
  const { result, seen } = await observe({
    mode: "hang", elapsedSec: 80, realTimeoutMs: 700,
    nativeDurationFlag: cliOperationNativeDurationFlag("0.4.4", "watch-crash"),
  });
  assert.equal(seen.argv.includes("--monitor-timeout"), false, JSON.stringify(seen.argv));
  assert.equal(seen.timeoutMs, 60_000, "no grace is spent on a line that was never given the window");
  assert.equal(result.observation.coverage, "partial");
  assert.equal(result.assessment, "inconclusive");
});

test("an early clean exit without a native timeout leaves coverage unknown", async () => {
  const { result, seen } = await observe({
    mode: "quiet", elapsedSec: 1,
    nativeDurationFlag: cliOperationNativeDurationFlag("0.4.4", "watch-crash"),
  });
  assert.equal(seen.argv.includes("--monitor-timeout"), false);
  assert.equal(result.watchedSec, 1);
  assert.equal(result.observation.coverage, "unknown");
  assert.equal(result.assessment, "inconclusive");
});

test("a nonzero CLI exit is a failure that still carries its observed timing", async () => {
  const { result } = await observe({ mode: "adb-error", elapsedSec: 2 });
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.failureClass, "runtime");
  assert.equal(result.exitCode, 2);
  assert.equal(result.watchedSec, 2);
  assert.equal(result.observation.endedBy, "cli-exit");
  assert.equal(result.observation.coverage, "partial");
  assert.match(result.outputTail, /device 'emulator-5554' not found/);
});

test("truncated output is partial coverage and never a quiet-window success", async () => {
  const { result } = await observe({ mode: "flood", elapsedSec: 60, maxOutputBytes: 4096 });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.outputTruncated, true);
  assert.equal(result.observation.outputComplete, false);
  assert.equal(result.observation.coverage, "partial");
  assert.equal(result.crashScanComplete, false);
  assert.equal(result.crashIndicated, false);
  assert.equal(result.assessment, "inconclusive");
});

test("a crash marker outside the returned UI tail is still found in the complete retained log", async () => {
  const { result } = await observe({ mode: "crash-early", elapsedSec: 5 });
  assert.equal(result.crashIndicated, true);
  assert.deepEqual(result.indicators, ["fatal-exception"]);
  assert.equal(result.crashScanComplete, true);
  assert.equal(result.assessment, "crash-indicated");
  assert.doesNotMatch(result.outputTail, /FATAL EXCEPTION/,
    "the marker must be outside the returned tail for this test to mean anything");
  const retainedBytes = fs.readFileSync(result.retainedLog.stdoutPath, "utf8");
  assert.match(retainedBytes, /FATAL EXCEPTION/);
});

test("raw stdout and stderr are retained immutably with hashes and byte counts", async () => {
  const retainRoot = path.join(tempRoot, `retain-immutable-${crypto.randomUUID()}`);
  const first = await observe({ mode: "quiet", elapsedSec: 60, retainRoot });
  const second = await observe({ mode: "no-pid", elapsedSec: 30, retainRoot });
  assert.notEqual(first.result.retainedLog.directory, second.result.retainedLog.directory);
  for (const run of [first, second]) {
    const log = run.result.retainedLog;
    const stdout = fs.readFileSync(log.stdoutPath);
    assert.equal(sha256(stdout), log.stdoutSha256);
    assert.equal(stdout.byteLength, log.stdoutBytes);
    assert.equal(fs.readFileSync(log.stderrPath).byteLength, log.stderrBytes);
    assert.equal(log.outputTruncated, false);
    assert.throws(() => fs.openSync(log.stdoutPath, "wx"), /EEXIST/);
  }
  // A second retention into an existing run directory refuses instead of overwriting.
  const clash = retainPicoCliObservation(
    { operation: "watch-crash", argv: ["app", "watch-crash"], result: { code: 0, signal: null, stdout: "x", stderr: "", timedOut: false, outputTruncated: false }, runId: "fixed-run-id" },
    retainRoot,
  );
  assert.equal(clash.retained, true, JSON.stringify(clash));
  const again = retainPicoCliObservation(
    { operation: "watch-crash", argv: ["app", "watch-crash"], result: { code: 0, signal: null, stdout: "y", stderr: "", timedOut: false, outputTruncated: false }, runId: "fixed-run-id" },
    retainRoot,
  );
  assert.equal(again.retained, false, JSON.stringify(again));
  assert.equal(fs.readFileSync(clash.stdoutPath, "utf8"), "x");
});

test("optional start and activity are preserved and nothing launches implicitly", async () => {
  const quiet = await observe({ request: { packageName: "com.example.fixture", durationSec: 60 } });
  assert.equal(quiet.seen.argv.includes("--start"), false, JSON.stringify(quiet.seen.argv));
  assert.equal(quiet.seen.argv.includes("--activity"), false);
  const started = await observe({
    request: { packageName: "com.example.fixture", durationSec: 60, start: true, activity: ".MainActivity", intervalSec: 3, device: "fixture-serial" },
  });
  assert.deepEqual(started.seen.argv, [
    "app", "watch-crash", "com.example.fixture", "-d", "fixture-serial", "--monitor-timeout", "60",
    "--start", "--activity", ".MainActivity", "--interval", "3",
  ]);
});

test("an unsupported capability refuses before any spawn and keeps the neutral setup guidance", async () => {
  let spawned = 0;
  const refusal = async (capability) => {
    const runtime = {
      now: () => 0,
      capability: () => capability,
      nativeDurationFlag: () => cliOperationNativeDurationFlag("0.5.0", "watch-crash"),
      run: async () => { spawned += 1; throw new Error("capability refusal must not spawn"); },
      retain: () => { throw new Error("capability refusal must not retain"); },
      cliPath: "/abs/fixture/pico-cli",
      cliRaw: "pico-cli/0.5.0 (fixture)",
    };
    return observeWatchCrash({ packageName: "com.example.fixture", durationSec: 60 }, runtime);
  };

  const gated = await refusal({
    operation: "watch-crash", state: "unavailable", argvPrefix: ["app", "watch-crash"],
    reason: "utilities-not-installed: `app watch-crash --help` exited 1 at the CLI's utilities gate: Error: Perf utilities are not installed. Run `pico-cli setup` to install.",
    evidence: [],
  });
  assert.equal(gated.status, "failed", JSON.stringify(gated));
  assert.equal(gated.failureClass, "setup-required");
  assert.equal(gated.note, "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry.");
  assert.deepEqual(gated.setupCommand, { path: "/abs/fixture/pico-cli", args: ["setup"] });
  assert.equal(gated.capability.reason.startsWith("utilities-not-installed:"), true);

  const drifted = await refusal({
    operation: "watch-crash", state: "unavailable", argvPrefix: ["app", "watch-crash"],
    reason: "unknown-command: the installed CLI rejected `app watch-crash --help` (exit 1)",
    evidence: [],
  });
  assert.equal(drifted.failureClass, "flag-or-version-drift");

  const environment = await refusal({
    operation: "watch-crash", state: "unavailable", argvPrefix: ["app", "watch-crash"],
    reason: "environment: `app watch-crash --help` exited 3 because the CLI's environment is incomplete: [warn] PICO_HOME is not set.",
    evidence: [],
  });
  assert.equal(environment.failureClass, "environment");
  assert.match(environment.note, /PICO_HOME/);
  assert.doesNotMatch(environment.note, /profiler payload/);

  const undiscovered = await refusal({
    operation: "watch-crash", state: "unknown", argvPrefix: ["app", "watch-crash"],
    reason: "no-discovery: no bounded help observation was recorded for `app watch-crash`",
    evidence: [],
  });
  assert.equal(undiscovered.failureClass, "cli-unusable");
  assert.equal(spawned, 0);
});

test("the wrapper no longer claims the CLI has no duration flag or streams indefinitely", async () => {
  const metadata = {};
  const { registerPicoCliTools } = await import("../dist/picoclitools.js");
  registerPicoCliTools({ registerTool: (name, meta) => { metadata[name] = meta; } });
  const description = metadata.watch_crash?.description ?? "";
  assert.doesNotMatch(description, /no duration flag/i);
  assert.doesNotMatch(description, /streams indefinitely/i);
  assert.match(description, /--monitor-timeout/);
  assert.match(description, /observed/i);
  const watchedSec = metadata.watch_crash?.outputSchema?.shape?.watchedSec?.description ?? "";
  assert.match(watchedSec, /observed/i);
});

test.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });
