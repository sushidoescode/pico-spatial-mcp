// v31 pico-cli integration lane: shared probe, honest failure classes, perf-axis-v2 scoring,
// preflight warn-tier row, and the trace/crash/record helper parsers. Run: npm run test:picocli
// Pure-function/fixture checks plus isolated executable fixtures; no real pico-cli or device.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const { classifyPicoCliFailure, picoCliPath, parsePicoCliEnvelope } = await import("../dist/picocli.js");
const { scorePicoCliPerfAxis, registerPerfCliTools } = await import("../dist/perfcli.js");
const { parseTraceSessionId, registerPerfTraceTools } = await import("../dist/perftrace.js");
const { scanForCrashIndicators, registerPicoCliTools } = await import("../dist/picoclitools.js");
const { runPreflightChecks } = await import("../dist/preflight.js");

// Ambient/global probing is deliberately absent from this gate. Task 4 production behavior is
// exercised through fresh isolated MCP child processes in picocli-autoinstall.mjs.
typeof picoCliPath === "function"
  ? ok("legacy picoCliPath remains an inert compatibility export")
  : fail("picoCliPath missing");

// --- classifyPicoCliFailure: usage/unknown-option dumps are drift; everything else is runtime.
const driftCases = [
  ["error: unknown option '--nope'\nUsage: perf monitor run [options]", ""],
  ["", "Usage: perf trace record [options]"],
  ["error: missing required argument 'package'", ""],
];
for (const [stderr, stdout] of driftCases) {
  classifyPicoCliFailure(stderr, stdout) === "flag-or-version-drift"
    ? ok(`drift classified: ${JSON.stringify((stderr + stdout).slice(0, 40))}`)
    : fail(`should be flag-or-version-drift: ${JSON.stringify([stderr, stdout])}`);
}
classifyPicoCliFailure("adb: device 'emulator-5554' not found", "") === "runtime"
  ? ok("runtime failure classified as runtime")
  : fail("device-not-found should classify as runtime");
classifyPicoCliFailure("", "") === "runtime"
  ? ok("empty output defaults to runtime (never claims drift without evidence)")
  : fail("empty output should classify as runtime");
// 0.4.x utilities gate (verbatim message measured 2026-08-12 on 0.4.2): a one-time `pico-cli setup`
// is the exact remedy — not drift, not a device problem.
classifyPicoCliFailure("Error: Perf utilities 0.1.0 are not installed. Run `pico-cli setup` to install.", "") === "setup-required"
  ? ok("0.4.x utilities gate classified as setup-required")
  : fail("perf-utilities-gate message should classify as setup-required");
classifyPicoCliFailure("", "Error: Perf utilities 0.2.0 are not installed. Run `pico-cli setup` to install.") === "setup-required"
  ? ok("utilities gate on stdout with a future bundle version classifies as setup-required")
  : fail("stdout-side utilities gate should classify as setup-required");

// --- scorePicoCliPerfAxis: shaped like the REAL 0.3.0 report (appFps has p5/p10/p50, no p95).
const emulatorReport = { status: "ok", summary: { appFps: { avg: 0, max: 0, min: 0, p5: 0, p10: 0, p50: 0, dropsCount: 0 } } };
const emuScore = scorePicoCliPerfAxis(emulatorReport, 16.7);
emuScore.perf === null && /no app 3D frames/.test(emuScore.note)
  ? ok("appFps avg 0 (the measured emulator no_3d_frame case) scores null, not 0")
  : fail(`emulator report mis-scored: ${JSON.stringify(emuScore)}`);
const healthy = { status: "ok", summary: { appFps: { avg: 71.2, max: 72, min: 58, p5: 62, p10: 66, p50: 71, dropsCount: 1 } } };
scorePicoCliPerfAxis(healthy, 16.7).perf === 1
  ? ok("appFps p5=62 vs 60fps floor scores 1")
  : fail(`healthy report mis-scored: ${JSON.stringify(scorePicoCliPerfAxis(healthy, 16.7))}`);
const janky = { status: "ok", summary: { appFps: { avg: 45, max: 72, min: 12, p5: 20, p10: 28, p50: 50, dropsCount: 9 } } };
scorePicoCliPerfAxis(janky, 16.7).perf === 0
  ? ok("appFps p5=20 vs 60fps floor scores 0")
  : fail(`janky report mis-scored: ${JSON.stringify(scorePicoCliPerfAxis(janky, 16.7))}`);
scorePicoCliPerfAxis({ status: "failed" }, 16.7).perf === null
  ? ok("failed diagnose scores null (not counted), never 0")
  : fail("failed diagnose should score null");
scorePicoCliPerfAxis({ status: "ok", summary: {} }, 16.7).perf === null
  ? ok("absent appFps block scores null")
  : fail("absent appFps should score null");
// 33.4ms budget -> ~29.9fps floor: p5=30 meets it.
scorePicoCliPerfAxis({ status: "ok", summary: { appFps: { avg: 31, p5: 30 } } }, 33.4).perf === 1
  ? ok("budget-to-fps-floor conversion honors a 30fps-class budget")
  : fail("33.4ms budget should floor at ~29.9fps");

// --- preflight: the pico-cli row is warn-tier (absence is NEVER a failure) and parses the version.
const baseIO = {
  nodeVersion: "v20.11.0",
  exec: () => ({ ok: false, stdout: "", stderr: "not found" }),
  readFile: () => null,
  statMtimeMs: () => null,
  now: () => 1_800_000_000_000,
  home: "/fake-home",
  detectJavaHome: () => null,
};
const noCliRow = runPreflightChecks(baseIO).find((c) => c.name === "pico-cli");
noCliRow && noCliRow.status === "warn" && /first CLI use/i.test(`${noCliRow.detail} ${noCliRow.fix}`)
  ? ok("preflight pico-cli row warns that first CLI use provisions the managed store")
  : fail(`preflight pico-cli absent row: ${JSON.stringify(noCliRow)}`);
const withCliIO = {
  ...baseIO,
  exec: (cmd, args) => cmd === "pico-cli" && args[0] === "-v"
    ? { ok: true, stdout: "pico-cli/0.3.0 (public) darwin-arm64 node-v25.8.1\n" }
    : { ok: false, stdout: "", stderr: "not found" },
};
const cliRow = runPreflightChecks(withCliIO).find((c) => c.name === "pico-cli");
cliRow && cliRow.status === "pass" && /0\.3\.0/.test(cliRow.detail)
  ? ok("preflight pico-cli row passes with the parsed version when present")
  : fail(`preflight pico-cli present row: ${JSON.stringify(cliRow)}`);
const unparsedIO = { ...baseIO, exec: (cmd, args) => cmd === "pico-cli" && args[0] === "-v" ? { ok: true, stdout: "something-else\n" } : { ok: false, stdout: "", stderr: "" } };
const unparsedRow = runPreflightChecks(unparsedIO).find((c) => c.name === "pico-cli");
unparsedRow && unparsedRow.status === "pass" && /unparsed/.test(unparsedRow.detail)
  ? ok("preflight pico-cli row admits an unparsed version instead of inventing one")
  : fail(`preflight pico-cli unparsed row: ${JSON.stringify(unparsedRow)}`);

// A successful version probe is followed by the exact read-only structured status argv, never doctor.
const successEnvelope = '{"tool_status":"SUCCESS","data":{},"errors":[]}';
const calls = [];
const structuredIO = { ...baseIO, exec: (cmd, args) => {
  calls.push([cmd, args]);
  if (cmd === "pico-cli" && args[0] === "-v") return { ok: true, stdout: "pico-cli/0.3.0\n" };
  if (cmd === "pico-cli" && args.join(" ") === "emulator status --format json") return { ok: true, stdout: successEnvelope };
  return { ok: false, stdout: "", stderr: "not found" };
} };
const structured = runPreflightChecks(structuredIO).find((c) => c.name === "pico-cli-emulator-status");
structured?.status === "pass" && calls.some(([cmd, args]) => cmd === "pico-cli" && args.join(" ") === "emulator status --format json") && !calls.some(([cmd, args]) => cmd === "pico-cli" && /doctor/.test(args.join(" ")))
  ? ok("preflight uses exact structured emulator-status argv and never pico-cli doctor")
  : fail(`structured preflight argv/status wrong: ${JSON.stringify({ structured, calls })}`);
for (const [toolStatus, expected] of [["PARTIAL", "warn"], ["FAILED", "warn"], ["garbage", "warn"]]) {
  const io = { ...baseIO, exec: (cmd, args) => {
    if (cmd === "pico-cli" && args[0] === "-v") return { ok: true, stdout: "pico-cli/0.3.0\n" };
    if (cmd === "pico-cli" && args.join(" ") === "emulator status --format json") return { ok: toolStatus !== "garbage", stdout: toolStatus === "garbage" ? "not-json" : JSON.stringify({ tool_status: toolStatus }) };
    return { ok: false, stdout: "", stderr: "not found" };
  } };
  const row = runPreflightChecks(io).find((c) => c.name === "pico-cli-emulator-status");
  row?.status === expected ? ok(`preflight ${toolStatus} structured status degrades honestly`) : fail(`preflight ${toolStatus} status wrong: ${JSON.stringify(row)}`);
}
parsePicoCliEnvelope(successEnvelope).outcome === "operational"
  ? ok("total pico-cli envelope parser is exported for fixture callers")
  : fail("pico-cli envelope parser did not normalize SUCCESS");

// --- parseTraceSessionId: best-effort, never throws, null on garbage.
parseTraceSessionId('{"sessionId":"abc-123"}') === "abc-123"
  ? ok("sessionId parsed from a JSON body")
  : fail("JSON-body sessionId parse failed");
parseTraceSessionId('loading trace...\n{"sessionId": 42, "ok": true}') === "42"
  ? ok("sessionId parsed from a JSON line amid log noise")
  : fail("per-line JSON sessionId parse failed");
parseTraceSessionId("Session id: sess_9f2\ndone") === "sess_9f2"
  ? ok("sessionId parsed from a labeled token")
  : fail("labeled-token sessionId parse failed");
parseTraceSessionId("no ids here at all") === null
  ? ok("garbage yields null, not an invented sessionId")
  : fail("garbage should parse to null");

// --- scanForCrashIndicators: named indicators, benign text yields none.
const crashText = "07-31 11:02:01 E AndroidRuntime: FATAL EXCEPTION: main\nProcess com.fleet.demo has died";
const found = scanForCrashIndicators(crashText);
found.includes("fatal-exception") && found.includes("process-died")
  ? ok(`crash markers detected: ${found.join(", ")}`)
  : fail(`crash markers missed: ${JSON.stringify(found)}`);
scanForCrashIndicators("watching com.fleet.demo (pid 1234)... still alive").length === 0
  ? ok("benign watch output yields zero indicators")
  : fail("benign text should yield no indicators");
scanForCrashIndicators("Fatal signal 11 (SIGSEGV), code 1").includes("native-crash")
  ? ok("native crash marker detected")
  : fail("Fatal signal should register as native-crash");

// --- register functions exist and are callable shapes (server wiring is the integrator's gate).
for (const [name, fn] of [["registerPerfTraceTools", registerPerfTraceTools], ["registerPicoCliTools", registerPicoCliTools], ["registerPerfCliTools", registerPerfCliTools]]) {
  typeof fn === "function" ? ok(`${name} exported`) : fail(`${name} missing`);
}
const picoCliToolMetadata = {};
registerPicoCliTools({ registerTool: (name, metadata) => { picoCliToolMetadata[name] = metadata; } });
const captureDescription = picoCliToolMetadata.capture_record?.description ?? "";
for (const required of ["adb screenrecord", "pico-cli capture record", "empty/invalid", "this emulator display", "screencapture -V -l<windowId>"]) {
  captureDescription.includes(required)
    ? ok(`capture_record description names ${required}`)
    : fail(`capture_record description is missing ${required}`);
}

const perfArgvRegression = spawnSync(process.execPath, ["--test", fileURLToPath(new URL("./perfcli-argv.mjs", import.meta.url))], { encoding: "utf8" });
if (perfArgvRegression.status === 0) ok("profiler version selection and exact argv receipts pass executable fixtures");
else fail(`profiler argv regression failed: ${perfArgvRegression.stderr || perfArgvRegression.stdout || perfArgvRegression.error}`);

console.log(`\npico-cli lane test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
