// v31 pico-cli integration lane: shared probe, honest failure classes, perf-axis-v2 scoring,
// preflight warn-tier row, and the trace/crash/record helper parsers. Run: npm run test:picocli
// Deliberately spawns NO MCP server and NO pico-cli — everything here is pure-function/fixture.
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
  // Host-environment-derived fields are declared, never inherited: with these omitted the adb and
  // jdk rows would read this machine's $PICO_ADB / $JAVA_HOME. Every IO below spreads baseIO.
  adbOverride: null,
  javaHomeEnv: null,
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
// Real 0.4.2/0.5.0 envelopes carry tool_name (test/fixtures/picocli/emulator-status-*.json and the
// source-inspected EMULATOR_STATUS_RESULT excerpt); the consumer now requires it.
const successEnvelope = '{"tool_name":"emulator.status","tool_status":"SUCCESS","data":{},"errors":[]}';
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


// --- C1: per-operation capability classification from retained help bytes (help-observed fixtures).
// Every byte below is a verbatim copy of evidence/2026-09-15-cli050-sdk61-evolution-audit-001/raw-help-002
// (see test/fixtures/picocli/help/index.json for the invocation numbers, versions and hashes).
const fs = await import("node:fs");
const crypto = await import("node:crypto");
const {
  CLI_OPERATIONS,
  cliOperationRoutes,
  classifyHelpOutput,
  classifyOperation,
  capabilityCoverage,
  sameCliCapabilityIdentity,
  describeIdentityDrift,
  resolveOperationCapability,
  unknownCapability,
  parseCliCapabilitySet,
} = await import("../dist/clicapabilities.js");
const { describePicoCliEnvironmentFailure } = await import("../dist/picocli.js");

const helpIndex = JSON.parse(fs.readFileSync(new URL("./fixtures/picocli/help/index.json", import.meta.url), "utf8"));
const evidenceIndex = JSON.parse(fs.readFileSync(new URL("../evidence/2026-09-15-cli050-sdk61-evolution-audit-001/RAW_HELP_INDEX_002.json", import.meta.url), "utf8"));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fixture = (version, invocation) => {
  const entry = helpIndex.entries.find((item) => item.version === version && item.invocation === invocation);
  if (!entry) throw new Error(`missing help fixture ${version}/${invocation}`);
  const stdoutUrl = new URL(`./fixtures/picocli/help/${entry.files["stdout.txt"]}`, import.meta.url);
  const stderrUrl = new URL(`./fixtures/picocli/help/${entry.files["stderr.txt"]}`, import.meta.url);
  return {
    entry,
    stdoutPath: fs.realpathSync(stdoutUrl),
    stderrPath: fs.realpathSync(stderrUrl),
    stdout: fs.readFileSync(stdoutUrl),
    stderr: fs.readFileSync(stderrUrl),
  };
};

// Fixture integrity: the copied bytes must hash to the values the audit index recorded, and the
// six nonzero results named by the brief must be present as real failure cases.
let fixtureIntegrity = true;
for (const entry of helpIndex.entries) {
  const { stdout, stderr } = fixture(entry.version, entry.invocation);
  const source = evidenceIndex.invocations.find((item) => item.artifactStem.endsWith(`/${entry.invocation}`));
  if (sha256(stdout) !== entry.stdoutSha256 || sha256(stderr) !== entry.stderrSha256
    || !source || source.stdoutSha256 !== entry.stdoutSha256 || source.stderrSha256 !== entry.stderrSha256
    || source.code !== entry.code || JSON.stringify(source.argv) !== JSON.stringify(entry.argv)) {
    fixtureIntegrity = false;
    fail(`help fixture ${entry.version}/${entry.invocation} drifted from the retained evidence`);
  }
}
if (fixtureIntegrity) ok(`${helpIndex.entries.length} help fixtures hash to their retained evidence bytes`);
JSON.stringify(helpIndex.nonzeroInvocations) === JSON.stringify(evidenceIndex.summary.nonzero.map((item) => item.artifactStem.split("/").at(-1)))
  && helpIndex.nonzeroInvocations.every((invocation) => helpIndex.entries.some((entry) => entry.invocation === invocation && entry.code !== 0))
  ? ok("all six nonzero retained results are present as failure fixtures")
  : fail("the six nonzero retained results are not all captured as fixtures");

// Route tables are version-line specific and never resurrect removed or rejected routes.
const routes044 = Object.fromEntries(cliOperationRoutes("0.4.4").map((route) => [route.operation, route.argvPrefix]));
const routes050 = Object.fromEntries(cliOperationRoutes("0.5.0").map((route) => [route.operation, route.argvPrefix]));
JSON.stringify(routes044["knowledge-server"]) === JSON.stringify(["mcp", "dev-knowledge"])
  && JSON.stringify(routes050["knowledge-server"]) === JSON.stringify(["knowledge", "server"])
  ? ok("knowledge-server routes follow the retained 0.4.4 (062) and 0.5.0 (136) help evidence")
  : fail(`knowledge-server routes wrong: ${JSON.stringify({ routes044, routes050 })}`);
routes044["perf-live"] === null && JSON.stringify(routes050["perf-live"]) === JSON.stringify(["perf", "live", "run"])
  ? ok("perf-live is routed only on the 0.5.x line")
  : fail(`perf-live routes wrong: ${JSON.stringify({ routes044, routes050 })}`);
["record", "decode", "load", "query"].every((op) =>
  JSON.stringify(routes044[`trace-${op}`]) === JSON.stringify(["perf", "trace", op])
  && JSON.stringify(routes050[`trace-${op}`]) === JSON.stringify(["perf", "trace", op]))
  ? ok("trace-* routes are perf trace <op> on both lines")
  : fail(`trace routes wrong: ${JSON.stringify({ routes044, routes050 })}`);
const allRoutes = [...cliOperationRoutes("0.4.4"), ...cliOperationRoutes("0.5.0"), ...cliOperationRoutes("0.6.0")];
allRoutes.every((route) => route.argvPrefix === null
  || (!route.argvPrefix.includes("monitor") && !route.argvPrefix.some((token) => token.includes(":")) && route.argvPrefix.every((token) => !token.startsWith("-"))))
  && cliOperationRoutes("0.5.0").every((route) => route.argvPrefix === null || route.argvPrefix[0] !== "mcp")
  ? ok("no route uses the rejected perf monitor alias, colon aliases, flags, or the removed 0.5.x mcp group")
  : fail(`route table contains an unsupported alias: ${JSON.stringify(allRoutes)}`);
cliOperationRoutes("0.5.0").length === CLI_OPERATIONS.length && cliOperationRoutes("0.4.4").length === CLI_OPERATIONS.length
  ? ok("every CliOperation has exactly one route entry per version line")
  : fail("route tables do not cover the operation union");

const observation = (fx, argvPrefix, overrides = {}) => ({
  argv: [...argvPrefix, "--help"],
  exitCode: fx.entry.code,
  timedOut: fx.entry.timedOut,
  outputTruncated: fx.entry.outputTruncated,
  stdoutPath: fx.stdoutPath,
  stderrPath: fx.stderrPath,
  stdoutSha256: fx.entry.stdoutSha256,
  stderrSha256: fx.entry.stderrSha256,
  ...overrides,
});
const classify = (operation, argvPrefix, fx, overrides = {}, options = {}) =>
  classifyHelpOutput(operation, argvPrefix, observation(fx, argvPrefix, overrides), fx.stdout.toString("utf8"), fx.stderr.toString("utf8"), options);
const expectState = (label, outcome, state, reasonPattern) => {
  outcome.state === state && reasonPattern.test(outcome.reason)
    ? ok(`${label}: ${outcome.state} (${outcome.reason.split(":")[0]})`)
    : fail(`${label}: expected ${state} ${reasonPattern}, got ${JSON.stringify(outcome)}`);
};

// Successful matching help (help-observed).
expectState("0.5.0 knowledge server help", classify("knowledge-server", ["knowledge", "server"], fixture("0.5.0", "136")), "supported", /^help-names-operation:/);
expectState("0.4.4 mcp dev-knowledge help", classify("knowledge-server", ["mcp", "dev-knowledge"], fixture("0.4.4", "062")), "supported", /^help-names-operation:/);
expectState("0.5.0 app watch-crash help", classify("watch-crash", ["app", "watch-crash"], fixture("0.5.0", "096")), "supported", /^help-names-operation:/);
expectState("0.4.4 capture record help", classify("capture-record", ["capture", "record"], fixture("0.4.4", "026")), "supported", /^help-names-operation:/);
// Generic parent help rendered instead of the child's (root help and the perf parent).
expectState("root help for knowledge-server", classify("knowledge-server", ["knowledge", "server"], fixture("0.5.0", "072")), "unavailable", /^generic-parent-help:/);
expectState("perf parent help for perf-live", classify("perf-live", ["perf", "live", "run"], fixture("0.5.0", "082")), "unavailable", /^generic-parent-help:/);
expectState("0.4.4 root help for the removed 0.5.x alias", classify("knowledge-server", ["mcp", "dev-knowledge"], fixture("0.5.0", "072")), "unavailable", /^generic-parent-help:/);
// Missing utilities: the real nonzero results (0.4.4 exit 1, 0.5.0 exit 3).
expectState("0.5.0 perf live gate (139)", classify("perf-live", ["perf", "live", "run"], fixture("0.5.0", "139")), "unavailable", /^utilities-not-installed:/);
expectState("0.5.0 perf trace gate (141)", classify("trace-record", ["perf", "trace", "record"], fixture("0.5.0", "141")), "unavailable", /^utilities-not-installed:/);
expectState("0.4.4 perf gate (012)", classify("trace-query", ["perf", "trace", "query"], fixture("0.4.4", "012")), "unavailable", /^utilities-not-installed:/);
// Malformed help, timeout, truncation and an incomplete process are unknown, never supported.
const emptyFixture = { entry: { code: 0, timedOut: false, outputTruncated: false, stdoutSha256: sha256(""), stderrSha256: sha256("") }, stdoutPath: "/dev/null", stderrPath: "/dev/null", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
expectState("empty exit-zero output", classify("knowledge-server", ["knowledge", "server"], emptyFixture), "unknown", /^malformed-help:/);
const fakeHelp = { ...emptyFixture, stdout: Buffer.from("fixture help: knowledge server --help\n") };
expectState("exit-zero text without a usage section", classify("knowledge-server", ["knowledge", "server"], fakeHelp), "unknown", /^malformed-help:/);
expectState("timed-out probe", classify("knowledge-server", ["knowledge", "server"], fixture("0.5.0", "136"), { timedOut: true, exitCode: null }, { timeoutMs: 2000 }), "unknown", /^timed-out:/);
expectState("truncated probe", classify("knowledge-server", ["knowledge", "server"], fixture("0.5.0", "136"), { outputTruncated: true }, { maxOutputBytes: 64 }), "unknown", /^output-truncated:/);
expectState("probe without an exit code", classify("knowledge-server", ["knowledge", "server"], emptyFixture, { exitCode: null }, { spawnError: "pre-spawn validation failed: fixture" }), "unknown", /^incomplete:/);
// Router rejections and environment gates (source-derived strings from PERF_ENV050; not help-observed).
const unknownSub = { ...emptyFixture, entry: { ...emptyFixture.entry, code: 3 }, stderr: Buffer.from("Error: Unknown perf subcommand: monitor. Expected one of: daemon, session, doctor, live, trace. Run `pico-cli perf --help` to see available commands.\n") };
expectState("unknown perf subcommand", classify("perf-live", ["perf", "monitor", "run"], unknownSub), "unavailable", /^unknown-command:/);
const picoHome = { ...emptyFixture, entry: { ...emptyFixture.entry, code: 3 }, stderr: Buffer.from("Error: [warn] PICO_HOME is not set. Set PICO_HOME or run pico-cli setup to install primer before running perf.\n") };
expectState("PICO_HOME unset", classify("trace-record", ["perf", "trace", "record"], picoHome), "unavailable", /^environment:/);
const otherFailure = { ...emptyFixture, entry: { ...emptyFixture.entry, code: 2 }, stderr: Buffer.from("boom\n") };
expectState("other nonzero exit", classify("trace-record", ["perf", "trace", "record"], otherFailure), "unavailable", /^nonzero-exit:/);

// classifyOperation: no route is unavailable without evidence; a supported record carries evidence.
const noRoute = classifyOperation(cliOperationRoutes("0.4.4").find((route) => route.operation === "perf-live"), []);
noRoute.state === "unavailable" && noRoute.argvPrefix === null && noRoute.evidence.length === 0 && /^no-route:/.test(noRoute.reason)
  ? ok("perf-live on 0.4.x is unavailable with a no-route reason and no evidence")
  : fail(`perf-live 0.4.x record wrong: ${JSON.stringify(noRoute)}`);
const ksFixture = fixture("0.5.0", "136");
const ksRoute = cliOperationRoutes("0.5.0").find((route) => route.operation === "knowledge-server");
const ksRecord = classifyOperation(ksRoute, [{ observation: observation(ksFixture, ksRoute.argvPrefix), stdout: ksFixture.stdout.toString("utf8"), stderr: ksFixture.stderr.toString("utf8") }]);
ksRecord.state === "supported" && ksRecord.evidence.length === 1 && ksRecord.evidence[0].stdoutSha256 === ksFixture.entry.stdoutSha256
  ? ok("classifyOperation binds the supported record to its help observation")
  : fail(`knowledge-server record wrong: ${JSON.stringify(ksRecord)}`);

// Aggregate coverage.
const identity = { version: "0.5.0", executablePath: "/x/pico-cli", packageJsonSha256: sha256("pkg"), executionTreeSha256: sha256("tree") };
const terminalSet = { schemaVersion: 1, identity, checkedAt: "2026-09-15T00:00:00.000Z", operations: [ksRecord, noRoute] };
capabilityCoverage(terminalSet) === "complete" && capabilityCoverage({ operations: [ksRecord, unknownCapability("trace-load", "timed-out: fixture")] }) === "partial"
  ? ok("coverage is complete only when every operation is terminal")
  : fail("coverage aggregation wrong");

// Identity binding: the entire identity must match, and drift names the field.
sameCliCapabilityIdentity(identity, { ...identity })
  && !sameCliCapabilityIdentity(identity, { ...identity, version: "0.5.1" })
  && !sameCliCapabilityIdentity(identity, { ...identity, executablePath: "/y/pico-cli" })
  && !sameCliCapabilityIdentity(identity, { ...identity, packageJsonSha256: sha256("other") })
  && !sameCliCapabilityIdentity(identity, { ...identity, executionTreeSha256: sha256("other") })
  && /executionTreeSha256/.test(describeIdentityDrift(identity, { ...identity, executionTreeSha256: sha256("other") }) ?? "")
  && describeIdentityDrift(identity, { ...identity }) === null
  ? ok("capability identity comparison covers every field and explains drift")
  : fail("identity comparison is incomplete");

// resolveOperationCapability: no evidence, stale identity, missing or mismatched bytes, and a
// tampered stored state all degrade to unknown; a help hash alone never enables an operation.
const readReal = (file) => { try { return fs.readFileSync(file); } catch { return null; } };
const resolved = resolveOperationCapability({ set: terminalSet, target: identity, operation: "knowledge-server", readEvidence: readReal });
resolved.state === "supported" && JSON.stringify(resolved.argvPrefix) === JSON.stringify(["knowledge", "server"])
  ? ok("a verified record with matching identity and evidence bytes resolves as supported")
  : fail(`verified resolution wrong: ${JSON.stringify(resolved)}`);
expectState("no discovery evidence", resolveOperationCapability({ set: null, target: identity, operation: "knowledge-server", readEvidence: readReal }), "unknown", /^no-discovery:/);
expectState("stale identity", resolveOperationCapability({ set: terminalSet, target: { ...identity, executionTreeSha256: sha256("replaced") }, operation: "knowledge-server", readEvidence: readReal }), "unknown", /^stale-identity:/);
expectState("missing evidence bytes", resolveOperationCapability({ set: terminalSet, target: identity, operation: "knowledge-server", readEvidence: () => null }), "unknown", /^evidence-missing:/);
expectState("mismatched evidence bytes", resolveOperationCapability({ set: terminalSet, target: identity, operation: "knowledge-server", readEvidence: () => Buffer.from("tampered") }), "unknown", /^evidence-mismatch:/);
const tamperedSet = { ...terminalSet, operations: [{ ...ksRecord, evidence: [observation(fixture("0.5.0", "141"), ksRoute.argvPrefix)] }] };
expectState("stored supported state contradicted by its bytes", resolveOperationCapability({ set: tamperedSet, target: identity, operation: "knowledge-server", readEvidence: readReal }), "unknown", /^report-inconsistent:/);
expectState("operation absent from the set", resolveOperationCapability({ set: terminalSet, target: identity, operation: "trace-load", readEvidence: readReal }), "unknown", /^no-discovery:/);
parseCliCapabilitySet(JSON.parse(JSON.stringify(terminalSet))) !== null
  && parseCliCapabilitySet({ ...terminalSet, schemaVersion: 2 }) === null
  && parseCliCapabilitySet({ ...terminalSet, operations: [{ ...ksRecord, state: "maybe" }] }) === null
  ? ok("parseCliCapabilitySet accepts schema 1 and rejects unknown schema/state values")
  : fail("parseCliCapabilitySet validation wrong");

// --- Fix round 1: an exit-0 help that fails the phrase rule is terminal only when the retained
// evidence proves the shape. Parent usage lines (002, 011, 072, 080, 082 all render
// `pico-cli <proper prefix> <placeholder>`) stay unavailable; routes with a retained exit-0 help
// (062/136, 025/096, 026/097) keep the terminal answer; the five perf routes have no exit-0
// example (012, 137-141 all exited at the utilities gate), so their unproven branch stays unknown.
expectState("0.4.4 mcp parent help for mcp dev-knowledge", classify("knowledge-server", ["mcp", "dev-knowledge"], fixture("0.4.4", "011")), "unavailable", /^generic-parent-help:/);
expectState("0.5.0 knowledge parent help for knowledge server", classify("knowledge-server", ["knowledge", "server"], fixture("0.5.0", "080")), "unavailable", /^generic-parent-help:/);
expectState("0.4.4 root help for mcp dev-knowledge", classify("knowledge-server", ["mcp", "dev-knowledge"], fixture("0.4.4", "002")), "unavailable", /^generic-parent-help:/);
expectState("perf parent help (082) for trace-record", classify("trace-record", ["perf", "trace", "record"], fixture("0.5.0", "082")), "unavailable", /^generic-parent-help:/);
expectState("perf parent help (082) for trace-query via the route flag", classify("trace-query", ["perf", "trace", "query"], fixture("0.5.0", "082"), {}, { exitZeroHelpObserved: false }), "unavailable", /^generic-parent-help:/);
// Synthetic provisioned-profiler help. Source-derived shape only (the 0.5.0 CLI re-renders
// profiler help under `pico-cli perf` per PERF_ROUTER050; option names from TRACE_RECORD_ARGS);
// never observed on this host, which is exactly why the no-phrase branch must not be terminal.
const provisionedTrace = { ...emptyFixture, stdout: Buffer.from("Description:\nRecord a Perfetto trace from the target device\n\nUsage:\n  $ pico-cli perf trace record [options]\n\nOptions:\n  -a, --package <package>   Target application package name\n  -t, --duration <seconds>  Recording duration in seconds (default: 60)\n  -o, --output <path>       Output trace file path\n") };
expectState("synthetic provisioned profiler help naming the route", classify("trace-record", ["perf", "trace", "record"], provisionedTrace), "supported", /^help-names-operation:/);
const unrenderedTrace = { ...emptyFixture, stdout: Buffer.from("Usage: pspp-profiler-cli trace record [options]\n\nOptions:\n  -t, --duration <seconds>  Recording duration in seconds\n") };
expectState("synthetic profiler help without the phrase stays unknown for an unproven route", classify("trace-record", ["perf", "trace", "record"], unrenderedTrace, {}, { exitZeroHelpObserved: false }), "unknown", /^generic-parent-help:.*unknown/);
expectState("the unproven branch is the conservative default", classify("trace-record", ["perf", "trace", "record"], unrenderedTrace), "unknown", /^generic-parent-help:/);
const rewrittenTrace = { ...emptyFixture, stdout: Buffer.from("Usage:\n  $ pico-cli perf record [options]\n") };
expectState("synthetic re-rendered help naming a different perf path stays unknown", classify("trace-record", ["perf", "trace", "record"], rewrittenTrace), "unknown", /^generic-parent-help:/);
const liveUnrendered = { ...emptyFixture, stdout: Buffer.from("Usage: profiler live run [options]\n\nOptions:\n  --package <package_name>  Target app package name\n") };
expectState("synthetic live help without the phrase stays unknown", classify("perf-live", ["perf", "live", "run"], liveUnrendered), "unknown", /^generic-parent-help:/);
const foreignKnowledge = { ...emptyFixture, stdout: Buffer.from("Usage:\n  $ pico-cli knowledge doctor\n\nOptions:\n  --format <format>  Output format\n") };
expectState("validated route: exit-0 help naming another child is unavailable", classify("knowledge-server", ["knowledge", "server"], foreignKnowledge, {}, { exitZeroHelpObserved: true }), "unavailable", /^generic-parent-help:/);
const observedFlags = Object.fromEntries(cliOperationRoutes("0.5.0").map((route) => [route.operation, route.exitZeroHelpObserved]));
const validatedOperations = ["knowledge-server", "watch-crash", "capture-record"];
CLI_OPERATIONS.every((operation) => observedFlags[operation] === validatedOperations.includes(operation))
  && cliOperationRoutes("0.4.4").every((route) => route.exitZeroHelpObserved === validatedOperations.includes(route.operation))
  ? ok("route tables record which routes have a retained exit-0 help example")
  : fail(`exitZeroHelpObserved wrong: ${JSON.stringify(observedFlags)}`);
const traceRoute = cliOperationRoutes("0.5.0").find((route) => route.operation === "trace-record");
const unknownTrace = classifyOperation(traceRoute, [{
  observation: { ...observation(emptyFixture, traceRoute.argvPrefix), stdoutPath: "trace.stdout", stderrPath: "trace.stderr", stdoutSha256: sha256(unrenderedTrace.stdout) },
  stdout: unrenderedTrace.stdout.toString("utf8"),
  stderr: "",
}]);
unknownTrace.state === "unknown" && /^generic-parent-help:/.test(unknownTrace.reason)
  && capabilityCoverage({ operations: [ksRecord, unknownTrace] }) === "partial"
  ? ok("an unproven exit-0 classification leaves the operation unknown and the coverage partial")
  : fail(`unproven exit-0 handling wrong: ${JSON.stringify(unknownTrace)}`);
const validatedKnowledge = classifyOperation(ksRoute, [{
  observation: { ...observation(emptyFixture, ksRoute.argvPrefix), stdoutSha256: sha256(fixture("0.5.0", "080").stdout) },
  stdout: fixture("0.5.0", "080").stdout.toString("utf8"),
  stderr: "",
}]);
validatedKnowledge.state === "unavailable" && capabilityCoverage({ operations: [ksRecord, validatedKnowledge] }) === "complete"
  ? ok("classifyOperation keeps the proven parent-help answer terminal")
  : fail(`proven parent-help handling wrong: ${JSON.stringify(validatedKnowledge)}`);
const staleUnavailable = { ...terminalSet, operations: [{ ...unknownTrace, state: "unavailable", reason: "generic-parent-help: stored by an older classifier" }] };
const readTraceEvidence = (file) => file === "trace.stdout" ? unrenderedTrace.stdout : file === "trace.stderr" ? Buffer.alloc(0) : null;
expectState("a stored terminal answer for an unproven byte shape is rejected on re-verification", resolveOperationCapability({ set: staleUnavailable, target: identity, operation: "trace-record", readEvidence: readTraceEvidence }), "unknown", /^report-inconsistent:/);

// --- classifyPicoCliFailure: retained bytes plus the 0.5.0 router/environment strings.
classifyPicoCliFailure(fixture("0.4.4", "012").stderr.toString("utf8"), "") === "setup-required"
  && classifyPicoCliFailure(fixture("0.5.0", "139").stderr.toString("utf8"), "") === "setup-required"
  ? ok("retained 0.4.4/0.5.0 utilities gates classify as setup-required")
  : fail("retained utilities gate bytes did not classify as setup-required");
classifyPicoCliFailure("Error: Unknown perf subcommand: monitor. Expected one of: daemon, session, doctor, live, trace. Run `pico-cli perf --help` to see available commands.", "") === "flag-or-version-drift"
  ? ok("0.5.0 router rejection (source-derived PERF_ENV050 text) classifies as flag-or-version-drift")
  : fail("Unknown perf subcommand should classify as flag-or-version-drift");
classifyPicoCliFailure("Error: [warn] PICO_HOME is not set. Set PICO_HOME or run pico-cli setup to install primer before running perf.", "") === "environment"
  && classifyPicoCliFailure("", 'Error: PICO_HOME must be an absolute path, got "sdk".') === "environment"
  ? ok("PICO_HOME problems classify as environment, not setup-required")
  : fail(`PICO_HOME classification wrong: ${classifyPicoCliFailure("Error: [warn] PICO_HOME is not set. Set PICO_HOME or run pico-cli setup to install primer before running perf.", "")}`);
const environmentGuidance = describePicoCliEnvironmentFailure("Error: [warn] PICO_HOME is not set. Set PICO_HOME or run pico-cli setup to install primer before running perf.", "");
typeof environmentGuidance === "string" && /PICO_HOME/.test(environmentGuidance) && /absolute/.test(environmentGuidance)
  && !/pico-cli\s+setup/i.test(environmentGuidance) && describePicoCliEnvironmentFailure("adb: device not found", "") === null
  ? ok("environment guidance names PICO_HOME exactly and never prescribes running setup")
  : fail(`environment guidance wrong: ${JSON.stringify(environmentGuidance)}`);

// --- C3: watch-crash observation coverage, native-timeout route facts and the shared failure map.
// The route fact is checked against the RETAINED HELP BYTES, not against a version string: 0.4.4
// invocation 025 advertises only --launch-timeout, 0.5.0 invocation 096 adds --monitor-timeout.
const {
  capabilityFailureClass,
  cliOperationNativeDurationFlag,
} = await import("../dist/clicapabilities.js");
const { watchArgv } = await import("../dist/cliobservations.js");

const watchHelp044 = fixture("0.4.4", "025").stdout.toString("utf8");
const watchHelp050 = fixture("0.5.0", "096").stdout.toString("utf8");
!/--monitor-timeout/.test(watchHelp044) && /--monitor-timeout <seconds>/.test(watchHelp050)
  && /Total wall-clock seconds to wait for the process and crash signals/.test(watchHelp050)
  ? ok("retained watch-crash help: 0.4.4 has no --monitor-timeout; 0.5.0 documents it as shared wall-clock budget")
  : fail("retained watch-crash help bytes do not match the recorded --monitor-timeout facts");
cliOperationNativeDurationFlag("0.4.4", "watch-crash") === null
  && cliOperationNativeDurationFlag("0.5.0", "watch-crash")?.flag === "--monitor-timeout"
  && /096/.test(cliOperationNativeDurationFlag("0.5.0", "watch-crash")?.provenance ?? "")
  ? ok("the native watch duration flag is a per-version route fact citing the retained 096 help")
  : fail(`native duration route fact wrong: ${JSON.stringify(cliOperationNativeDurationFlag("0.5.0", "watch-crash"))}`);
CLI_OPERATIONS.filter((operation) => operation !== "watch-crash")
  .every((operation) => cliOperationNativeDurationFlag("0.5.0", operation) === null
    && cliOperationNativeDurationFlag("0.4.4", operation) === null)
  ? ok("no other operation claims a native duration flag on either line")
  : fail("a non-watch operation claims a native duration flag");
JSON.stringify(watchArgv("com.example.fixture", "fixture-serial", 60, true))
    === JSON.stringify(["app", "watch-crash", "com.example.fixture", "-d", "fixture-serial", "--monitor-timeout", "60"])
  && JSON.stringify(watchArgv("com.example.fixture", "fixture-serial", 60, false))
    === JSON.stringify(["app", "watch-crash", "com.example.fixture", "-d", "fixture-serial"])
  ? ok("watchArgv passes --monitor-timeout only when the route facts say the flag exists")
  : fail(`watchArgv wrong: ${JSON.stringify(watchArgv("com.example.fixture", "fixture-serial", 60, true))}`);

// The reason-prefix -> failure-class map now lives beside capabilityNeedsFreshDiscovery so the
// knowledge, watch and (later) perf consumers all read one table.
capabilityFailureClass({ reason: "utilities-not-installed: `app watch-crash --help` exited 1" }) === "setup-required"
  && capabilityFailureClass({ reason: "environment: `app watch-crash --help` exited 3" }) === "environment"
  && capabilityFailureClass({ reason: "unknown-command: the installed CLI rejected `app watch-crash --help`" }) === "flag-or-version-drift"
  && capabilityFailureClass({ reason: "no-discovery: no bounded help observation was recorded" }) === "cli-unusable"
  ? ok("capabilityFailureClass maps the stable reason prefixes for every capability consumer")
  : fail("capabilityFailureClass reason-prefix mapping wrong");

// The environment remedy no longer asserts "profiler payload" for an operation that never
// resolves one (PERF_ENV050 places the PICO_HOME read inside profiler-entry resolution only).
const perfEnvironmentGuidance = describePicoCliEnvironmentFailure("Error: [warn] PICO_HOME is not set.", "", "trace-record");
const watchEnvironmentGuidance = describePicoCliEnvironmentFailure("Error: [warn] PICO_HOME is not set.", "", "watch-crash");
/profiler payload/.test(perfEnvironmentGuidance ?? "") && !/profiler payload/.test(watchEnvironmentGuidance ?? "")
  && /PICO_HOME/.test(watchEnvironmentGuidance ?? "") && !/pico-cli\s+setup/i.test(watchEnvironmentGuidance ?? "")
  ? ok("environment guidance names the profiler payload only for perf operations")
  : fail(`operation-conditional environment guidance wrong: ${JSON.stringify({ perfEnvironmentGuidance, watchEnvironmentGuidance })}`);

// The watch_crash surface no longer repeats the retired "no duration flag" claim.
const watchDescription = picoCliToolMetadata.watch_crash?.description ?? "";
!/no duration flag/i.test(watchDescription) && !/streams indefinitely/i.test(watchDescription)
  && /--monitor-timeout/.test(watchDescription) && /observed/i.test(watchDescription)
  ? ok("watch_crash description states the observed-window contract instead of the retired claim")
  : fail(`watch_crash description still carries retired wording: ${JSON.stringify(watchDescription.slice(0, 200))}`);


// --- C4: the perf command + report contract -----------------------------------------------
// Argv and schema facts below are SOURCE-INSPECTED: the official tarballs in
// evidence/2026-09-15-cli050-sdk61-evolution-audit-001/ were read in memory (never extracted, never
// run) down to the nested profiler package. Report fixtures are SYNTHETIC and labelled as such —
// test/fixtures/picocli/synthetic/README.md names the exact archive members they encode. No
// provisioned profiler help was ever observable on this host, so nothing here is help-observed.
const assert = (await import("node:assert/strict")).default;
const os = await import("node:os");
const pathMod = await import("node:path");
const expect = (label, fn) => {
  try { fn(); ok(label); } catch (e) { fail(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
};

const {
  cliOperationOptions,
} = await import("../dist/clicapabilities.js");
const {
  adaptPerfReport,
  collectPerfLive,
  perfLiveArgv,
} = await import("../dist/perfcli.js");
const {
  parseProfilerEnvelope,
  parseTraceLoadHumanSession,
  runPerfTrace,
  traceArgv,
  validateTraceLoadEnvelope,
  validateTraceQueryEnvelope,
} = await import("../dist/perftrace.js");
const { createFakePerfCli } = await import("./fixtures/picocli/synthetic/fake-perf-cli.mjs");

const syntheticDir = new URL("./fixtures/picocli/synthetic/", import.meta.url);
const syntheticReport = (name) => fs.realpathSync(new URL(`live-report-${name}.json`, syntheticDir));
const readSynthetic = (name) => fs.readFileSync(syntheticReport(name), "utf8");
const c4Tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), "pico-c4-"));

// Route option facts: every flag comes from the vendored profiler's own registerOptions/params.
const live050Options = cliOperationOptions("0.5.0", "perf-live");
live050Options?.names.package === "--package" && live050Options?.names.duration === "--duration"
  && live050Options?.names.device === "--device" && live050Options?.names.output === "--output"
  && live050Options?.names.save === "--save"
  ? ok("perf-live option names are the canonical 0.2.0 long options (--package/--duration/--save/--output)")
  : fail(`perf-live option facts wrong: ${JSON.stringify(live050Options)}`);
cliOperationOptions("0.4.4", "perf-live") === null
  ? ok("perf-live has no option facts on the 0.4.x line (it has no route there)")
  : fail("perf-live must not carry option facts on a line with no route");
cliOperationOptions("0.4.4", "trace-record")?.names.package === "--app"
  && cliOperationOptions("0.5.0", "trace-record")?.names.package === "--package"
  ? ok("trace-record's package option follows each line's bundled profiler (0.1.0 --app, 0.2.0 --package)")
  : fail(`trace-record package option wrong: ${JSON.stringify([cliOperationOptions("0.4.4", "trace-record"), cliOperationOptions("0.5.0", "trace-record")])}`);
cliOperationOptions("0.5.0", "trace-load")?.names.envelope === "--envelope"
  && cliOperationOptions("0.4.4", "trace-load")?.names.envelope === "--envelope"
  ? ok("trace-load declares the global --envelope flag on both lines")
  : fail("trace-load envelope option fact missing");
[...cliOperationRoutes("0.4.4"), ...cliOperationRoutes("0.5.0")]
  .every((route) => !JSON.stringify(cliOperationOptions("0.4.4", route.operation) ?? {}).includes("monitor")
    && !JSON.stringify(cliOperationOptions("0.5.0", route.operation) ?? {}).includes("monitor"))
  ? ok("no route option fact mentions the rejected `monitor` resource")
  : fail("a route option fact still mentions monitor");

// The exact dispatched argv. `perf monitor run` is rejected by the 0.5.0 router (PERF_ROUTER050),
// so the fake CLI refuses it; this asserts what we actually send instead.
const liveCapability = {
  operation: "perf-live",
  state: "supported",
  argvPrefix: ["perf", "live", "run"],
  reason: "help-names-operation: `perf live run --help` exited 0 and a pico-cli usage line names `perf live run`",
  evidence: [],
};
const fakeLiveRunner = createFakePerfCli({ reportFixture: syntheticReport("0.2.0-complete") });
const reportPath = pathMod.join(c4Tmp, "live-report-dispatch.json");
const dispatched = await collectPerfLive(
  { packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath },
  {
    capability: () => liveCapability,
    options: () => cliOperationOptions("0.5.0", "perf-live"),
    run: fakeLiveRunner.run,
    retain: () => ({ retained: false, error: "retention disabled in this fixture" }),
    cliPath: "/fixture/pico-cli",
    cliRaw: "pico-cli/0.5.0 (fixture)",
    cliVersion: "0.5.0",
  },
);
const capturedRun = fakeLiveRunner.calls[0] ?? { args: [] };
expect("collectPerfLive dispatches the source-derived perf live run argv verbatim", () => {
  assert.deepEqual(capturedRun.args, ["perf", "live", "run", "--package", "com.example.fixture",
    "--duration", "15", "--device", "fixture-serial", "--save", "--output", reportPath]);
});
dispatched.status === "ok" && dispatched.measurement === "complete" && dispatched.reportVersion === "0.2.0"
  && dispatched.summary?.appFps?.p5 === 62 && dispatched.view?.diagnosis?.result === "PASS"
  && typeof dispatched.rawReportSha256 === "string" && dispatched.rawReportPath === reportPath
  ? ok("a saved 0.2.0 report adapts to status ok / measurement complete with a bounded view")
  : fail(`dispatched perf result wrong: ${JSON.stringify({ ...dispatched, view: undefined, jankWindows: undefined })}`);
fakeLiveRunner.calls.every((call) => !call.args.includes("monitor"))
  ? ok("no dispatched perf argv contains `monitor`")
  : fail("a perf dispatch still uses the rejected monitor route");

// Explicit target identity (host completion T5): the device the run was ASKED to profile is part
// of the result, on every outcome — a graded run and a refusal alike. Without it a caller who
// named a device (pico_perf now forwards one) cannot tell from the result which one was profiled.
dispatched.requestedDevice === "fixture-serial"
  ? ok("a graded perf result names the device it was asked to profile")
  : fail(`a graded perf result does not name its target: ${JSON.stringify(dispatched.requestedDevice)}`);

// The WHOLE raw report is copied into the immutable observation run directory, so the evidence
// survives even if the CLI's own output path is later overwritten.
const { retainPicoCliObservation } = await import("../dist/picocli.js");
const retentionRoot = pathMod.join(c4Tmp, "observations");
const retainedRunner = createFakePerfCli({ reportFixture: syntheticReport("0.2.0-complete") });
const retainedReportPath = pathMod.join(c4Tmp, "retained-dispatch.json");
const retainedResult = await collectPerfLive(
  { packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: retainedReportPath },
  {
    capability: () => liveCapability,
    options: () => cliOperationOptions("0.5.0", "perf-live"),
    run: retainedRunner.run,
    retain: (input) => retainPicoCliObservation({ operation: "perf-live", runId: "fixture-run", ...input }, retentionRoot),
    cliPath: "/fixture/pico-cli", cliRaw: "pico-cli/0.5.0", cliVersion: "0.5.0",
  },
);
const retainedCopy = pathMod.join(retentionRoot, "perf-live", "fixture-run", "live-report.json");
fs.existsSync(retainedCopy)
  && fs.readFileSync(retainedCopy, "utf8") === readSynthetic("0.2.0-complete")
  && retainedResult.rawReportPath === retainedCopy
  && retainedResult.retainedLog?.reportSha256 === retainedResult.rawReportSha256
  && fs.existsSync(pathMod.join(retentionRoot, "perf-live", "fixture-run", "stdout.txt"))
  ? ok("the whole raw report and both raw streams are retained immutably beside the run record")
  : fail(`report retention wrong: ${JSON.stringify({ retainedCopy, exists: fs.existsSync(retainedCopy), rawReportPath: retainedResult.rawReportPath, retainedLog: retainedResult.retainedLog })}`);
JSON.parse(fs.readFileSync(pathMod.join(retentionRoot, "perf-live", "fixture-run", "observation.json"), "utf8"))
  .artifacts?.[0]?.sourcePath === retainedReportPath
  ? ok("the retained run record names the CLI's own output path as the artifact's source")
  : fail("the retained observation record does not name the report's source path");
perfLiveArgv(["perf", "live", "run"], cliOperationOptions("0.5.0", "perf-live"),
  { packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: "/tmp/r.json" })
  .join(" ").includes("--save --output")
  ? ok("perfLiveArgv keeps --output paired with --save (LIVE050 refuses an unpaired --output)")
  : fail("perfLiveArgv emitted --output without --save");

// The router's own refusal of `monitor`, replayed through the fake CLI from the retained template.
const monitorProbe = createFakePerfCli({});
const monitorReply = await monitorProbe.run(["perf", "monitor", "run", "--app", "com.example.fixture"], {});
monitorReply.code === 3 && /Unknown perf subcommand: monitor\./.test(monitorReply.stderr)
  && classifyPicoCliFailure(monitorReply.stderr, "") === "flag-or-version-drift"
  ? ok("the fake CLI rejects `perf monitor run` exactly as the 0.5.0 router does, and we classify it as drift")
  : fail(`monitor rejection wrong: ${JSON.stringify(monitorReply)}`);

// Capability refusal: no spawn, the CLI's own reason, and the byte-pinned setup sentence.
const refusalRuntime = (capability) => ({
  capability: () => capability,
  options: () => cliOperationOptions("0.5.0", "perf-live"),
  run: async () => { throw new Error("a refused capability must never spawn"); },
  retain: () => ({ retained: false, error: "unused" }),
  cliPath: "/fixture/pico-cli",
  cliRaw: "pico-cli/0.5.0 (fixture)",
  cliVersion: "0.5.0",
});
const gatedCapability = {
  operation: "perf-live",
  state: "unavailable",
  argvPrefix: ["perf", "live", "run"],
  reason: "utilities-not-installed: `perf live run --help` exited 3 at the CLI's utilities gate: Error: Perf utilities 0.2.0 are not installed. Run `pico-cli setup` to install.",
  evidence: [{ argv: ["perf", "live", "run", "--help"], exitCode: 3, timedOut: false, outputTruncated: false, stdoutPath: "/fixture/evidence/stdout.txt", stderrPath: "/fixture/evidence/stderr.txt", stdoutSha256: "0".repeat(64), stderrSha256: "1".repeat(64) }],
};
const gatedResult = await collectPerfLive({ packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: pathMod.join(c4Tmp, "never.json") }, refusalRuntime(gatedCapability));
gatedResult.status === "failed" && gatedResult.failureClass === "setup-required"
  && gatedResult.note === "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry."
  && gatedResult.setupCommand?.path === "/fixture/pico-cli"
  && gatedResult.measurement === "missing"
  && gatedResult.capability?.reason === gatedCapability.reason
  && JSON.stringify(gatedResult.capability?.evidence) === JSON.stringify(["/fixture/evidence/stdout.txt", "/fixture/evidence/stderr.txt"])
  ? ok("an unprovisioned profiler refuses without spawning and returns the neutral setup sentence plus its evidence paths")
  : fail(`gated perf refusal wrong: ${JSON.stringify(gatedResult)}`);
gatedResult.requestedDevice === "fixture-serial"
  ? ok("a perf REFUSAL names the device it was asked to profile too")
  : fail(`a perf refusal does not name its target: ${JSON.stringify(gatedResult.requestedDevice)}`);
gatedResult.capability?.operation === "perf-live" && gatedResult.familyGate === undefined
  && gatedResult.remediationLimit === undefined
  ? ok("an evidence-backed perf-live gate needs no family answer and claims no remediation limit")
  : fail(`gated perf disclosure wrong: ${JSON.stringify({ capability: gatedResult.capability, familyGate: gatedResult.familyGate, remediationLimit: gatedResult.remediationLimit })}`);
const envCapability = { ...gatedCapability, reason: "environment: `perf live run --help` exited 3 because the CLI's environment is incomplete: Error: [warn] PICO_HOME is not set." };
const envResult = await collectPerfLive({ packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: pathMod.join(c4Tmp, "never2.json") }, refusalRuntime(envCapability));
envResult.failureClass === "environment" && /profiler payload/.test(envResult.note ?? "")
  && /PICO_HOME/.test(envResult.note ?? "") && !/pico-cli\s+setup/i.test(envResult.note ?? "")
  && envResult.setupCommand === undefined
  ? ok("an environment refusal returns the PICO_HOME remedy for perf-live and never prescribes setup")
  : fail(`environment perf refusal wrong: ${JSON.stringify(envResult)}`);
// PERF_ENV050's resolver checks PICO_CLI_PROFILER_ENTRY_PATH before reading PICO_HOME, so the
// remedy names it as the explicit alternative and keeps it distinct from SDK tools-root selection.
/PICO_CLI_PROFILER_ENTRY_PATH/.test(envResult.note ?? "") && /separate selection/.test(envResult.note ?? "")
  ? ok("the perf environment remedy names the explicit profiler-entry alternative and keeps it separate from the SDK tools root")
  : fail(`profiler-entry reconciliation missing from the environment remedy: ${JSON.stringify(envResult.note)}`);
const noRouteResult = await collectPerfLive(
  { packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: pathMod.join(c4Tmp, "never3.json") },
  {
    ...refusalRuntime({ operation: "perf-live", state: "unavailable", argvPrefix: null, reason: "no-route: 0.4.x: no 0.4.x live-collection route is dispatched", evidence: [] }),
    options: () => cliOperationOptions("0.4.4", "perf-live"),
    familyEvidence: () => [{
      operation: "trace-record",
      state: "unavailable",
      argvPrefix: ["perf", "trace", "record"],
      reason: "utilities-not-installed: `perf trace record --help` exited 1 at the CLI's utilities gate",
      evidence: [],
    }],
  },
);
noRouteResult.status === "failed" && noRouteResult.failureClass === "setup-required"
  && noRouteResult.note === "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry."
  ? ok("a line with no live route adopts the perf family's own utilities-gate answer (one gate per family: PERF_ENV044/PERF_ENV050)")
  : fail(`no-route family classification wrong: ${JSON.stringify(noRouteResult)}`);
// The adopted gate must never REPLACE the probed operation's own evidence: `capability` always
// describes perf-live (with its no-route reason), the sibling gate is disclosed separately, and the
// limit sentence says what the byte-pinned setup note cannot — that provisioning the payload would
// still leave this line without a live route.
noRouteResult.capability?.operation === "perf-live"
  && /^no-route:/.test(noRouteResult.capability?.reason ?? "")
  && noRouteResult.capability?.argvPrefix === null
  && noRouteResult.familyGate?.operation === "trace-record"
  && /^utilities-not-installed:/.test(noRouteResult.familyGate?.reason ?? "")
  && JSON.stringify(noRouteResult.familyGate?.argvPrefix) === JSON.stringify(["perf", "trace", "record"])
  && /no live-collection route at all/.test(noRouteResult.remediationLimit ?? "")
  && /would still leave this wrapper without a route/.test(noRouteResult.remediationLimit ?? "")
  ? ok("the adopted family gate is disclosed beside — never instead of — the probed perf-live capability, with the remediation limit stated")
  : fail(`family-gate disclosure wrong: ${JSON.stringify({ capability: noRouteResult.capability, familyGate: noRouteResult.familyGate, remediationLimit: noRouteResult.remediationLimit })}`);
const noRouteNoFamily = await collectPerfLive(
  { packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: pathMod.join(c4Tmp, "never4.json") },
  { ...refusalRuntime({ operation: "perf-live", state: "unavailable", argvPrefix: null, reason: "no-route: 0.4.x: no 0.4.x live-collection route is dispatched", evidence: [] }), options: () => null, familyEvidence: () => [] },
);
noRouteNoFamily.failureClass === "flag-or-version-drift" && noRouteNoFamily.status === "failed"
  && noRouteNoFamily.capability?.operation === "perf-live" && noRouteNoFamily.familyGate === undefined
  && /no live-collection route at all/.test(noRouteNoFamily.remediationLimit ?? "")
  && noRouteNoFamily.setupCommand === undefined
  ? ok("without perf-family evidence a missing live route is reported as version drift, never as setup-required")
  : fail(`no-route drift classification wrong: ${JSON.stringify(noRouteNoFamily)}`);
let rediscoveries = 0;
const unknownResult = await collectPerfLive(
  { packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: pathMod.join(c4Tmp, "never5.json") },
  {
    ...refusalRuntime({ operation: "perf-live", state: "unknown", argvPrefix: null, reason: "no-discovery: no bounded discovery evidence is bound to this execution target", evidence: [] }),
    rediscover: async () => { rediscoveries += 1; return { operation: "perf-live", state: "unknown", argvPrefix: null, reason: "no-discovery: still nothing", evidence: [] }; },
  },
);
rediscoveries === 1 && unknownResult.status === "failed"
  ? ok("an unknown capability triggers exactly one bounded rediscovery and then refuses")
  : fail(`unknown-capability rediscovery wrong: ${JSON.stringify({ rediscoveries, unknownResult })}`);
// A supported route whose line declares no option spellings must never dispatch a half-built argv.
const optionlessRunner = createFakePerfCli({ reportFixture: syntheticReport("0.2.0-complete") });
const optionlessResult = await collectPerfLive(
  { packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: pathMod.join(c4Tmp, "never6.json") },
  { capability: () => liveCapability, options: () => null, run: optionlessRunner.run, retain: () => ({ retained: false, error: "unused" }), cliPath: "/fixture/pico-cli", cliRaw: "pico-cli/9.9.9", cliVersion: "9.9.9" },
);
optionlessResult.status === "failed" && optionlessResult.failureClass === "flag-or-version-drift"
  && optionlessRunner.calls.length === 0 && /package\/duration\/device\/save\/output/.test(optionlessResult.note ?? "")
  ? ok("a live route with no declared option spellings refuses instead of dispatching a half-built argv")
  : fail(`argv-completeness guard wrong: ${JSON.stringify({ optionlessResult, calls: optionlessRunner.calls.length })}`);
const optionlessTrace = await runPerfTrace({ action: "query", sessionId: "s", sql: "select 1;" }, {
  capability: () => ({ operation: "trace-query", state: "supported", argvPrefix: ["perf", "trace", "query"], reason: "help-names-operation: ok", evidence: [] }),
  options: () => null,
  run: async () => { throw new Error("an incomplete trace argv must never spawn"); },
  retain: () => ({ retained: false, error: "unused" }),
  inspectArtifact: () => ({ exists: true, regularFile: true, bytes: 1 }),
  cliPath: "/fixture/pico-cli", cliRaw: "pico-cli/9.9.9", cliVersion: "9.9.9",
});
optionlessTrace.status === "failed" && optionlessTrace.failureClass === "flag-or-version-drift"
  ? ok("a trace route with no declared option spellings refuses without spawning")
  : fail(`trace argv-completeness guard wrong: ${JSON.stringify(optionlessTrace)}`);

// Stale pre-existing output must never be read as this run's measurement.
const stalePath = pathMod.join(c4Tmp, "stale-report.json");
fs.writeFileSync(stalePath, readSynthetic("0.2.0-complete"));
const staleRunner = createFakePerfCli({ reportFixture: syntheticReport("0.2.0-complete") });
const staleResult = await collectPerfLive(
  { packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: stalePath },
  { capability: () => liveCapability, options: () => cliOperationOptions("0.5.0", "perf-live"), run: staleRunner.run, retain: () => ({ retained: false, error: "unused" }), cliPath: "/fixture/pico-cli", cliRaw: "pico-cli/0.5.0", cliVersion: "0.5.0" },
);
staleResult.status === "failed" && staleResult.measurement === "missing" && staleRunner.calls.length === 0
  && /already existed/i.test(staleResult.note ?? "")
  ? ok("a report path that already existed before the run is refused, and nothing is spawned")
  : fail(`stale-output refusal wrong: ${JSON.stringify({ staleResult, calls: staleRunner.calls.length })}`);

// A profiler that exits 0 without writing the report is a failed measurement, never an ok one.
const silentRunner = createFakePerfCli({ reportFixture: null });
const silentResult = await collectPerfLive(
  { packageName: "com.example.fixture", durationSec: 15, device: "fixture-serial", reportPath: pathMod.join(c4Tmp, "missing-report.json") },
  { capability: () => liveCapability, options: () => cliOperationOptions("0.5.0", "perf-live"), run: silentRunner.run, retain: () => ({ retained: false, error: "unused" }), cliPath: "/fixture/pico-cli", cliRaw: "pico-cli/0.5.0", cliVersion: "0.5.0" },
);
silentResult.status === "failed" && silentResult.measurement === "missing"
  ? ok("exit 0 with no report file is a failed measurement (a nonempty file is not assumed)")
  : fail(`missing-report handling wrong: ${JSON.stringify(silentResult)}`);

// --- the report adapter, on synthetic bytes built from the published reporter.d.ts ---------
const adapt = (raw, overrides = {}) => adaptPerfReport({
  raw,
  requestedPackage: "com.example.fixture",
  requestedDevice: "fixture-serial",
  producerVersion: "0.5.0",
  preexisting: false,
  ...overrides,
});
const adaptCases = [
  ["missing file", adapt(null, { readError: "ENOENT: no such file or directory" }), "failed", "missing", null],
  ["empty JSON object", adapt("{}"), "failed", "missing", null],
  ["malformed JSON", adapt("{not json"), "failed", "missing", null],
  ["truncated JSON", adapt(readSynthetic("0.2.0-complete").slice(0, 200)), "failed", "missing", null],
  ["unknown report version", adapt(readSynthetic("unknown-version")), "failed", "missing", null],
  // The schema line IS identified here (metadata.package exists); only the identity check fails.
  ["mismatched package", adapt(readSynthetic("0.2.0-wrong-package")), "failed", "missing", "0.2.0"],
  ["0.2.0 complete", adapt(readSynthetic("0.2.0-complete")), "ok", "complete", "0.2.0"],
  ["0.1.0 complete", adapt(readSynthetic("0.1.0-complete")), "ok", "complete", "0.1.0"],
  ["0.2.0 SKIP / INSUFFICIENT_DATA", adapt(readSynthetic("0.2.0-skip")), "ok", "missing", "0.2.0"],
  ["0.2.0 runtime FPS without app frames", adapt(readSynthetic("0.2.0-no-app-frames")), "ok", "missing", "0.2.0"],
];
for (const [label, result, status, measurement, version] of adaptCases) {
  result.status === status && result.measurement === measurement && result.reportVersion === version
    ? ok(`report adapter: ${label} -> ${status}/${measurement}`)
    : fail(`report adapter ${label} wrong: ${JSON.stringify({ status: result.status, measurement: result.measurement, reportVersion: result.reportVersion, reason: result.reason })}`);
}
adapt(readSynthetic("0.2.0-complete"), { preexisting: true }).status === "failed"
  ? ok("report adapter refuses a report file that predates the run even when its contents parse")
  : fail("preexisting report was accepted");
adapt(readSynthetic("0.2.0-no-app-frames")).view?.summary?.sysFps?.avg === 88.6
  && adapt(readSynthetic("0.2.0-no-app-frames")).measurement === "missing"
  ? ok("Spatial Runtime FPS is reported but never counted as an app-FPS measurement")
  : fail("runtime FPS was treated as an app measurement");
const gpuBlindAdaptation = adapt(readSynthetic("0.2.0-no-app-frames"));
gpuBlindAdaptation.missingCounters.includes("gpuUsage") && gpuBlindAdaptation.missingCounters.includes("appFps")
  ? ok("all-zero GPU counters are reported as missing counters, never as an idle GPU")
  : fail(`missing-counter reporting wrong: ${JSON.stringify(gpuBlindAdaptation.missingCounters)}`);
adapt(readSynthetic("0.2.0-complete")).view?.rawData === undefined
  && JSON.stringify(adapt(readSynthetic("0.2.0-complete")).view ?? {}).length < 4000
  ? ok("the returned view is bounded and excludes the unbounded rawData array")
  : fail("the report view is not bounded");
adapt(readSynthetic("0.2.0-complete"), { requestedDevice: "other-serial" }).status === "ok"
  ? ok("a device serial the 0.2.0 schema never records is not treated as a mismatch")
  : fail("an absent device field was treated as a mismatch");
adapt(JSON.stringify({ ...JSON.parse(readSynthetic("0.2.0-complete")), metadata: { ...JSON.parse(readSynthetic("0.2.0-complete")).metadata, device: "other-serial" } })).status === "failed"
  ? ok("a device field that IS present and disagrees with the requested serial fails the identity check")
  : fail("a mismatched device serial was accepted");

// --- the observable score boundary (unchanged contract) ------------------------------------
expect("scorePicoCliPerfAxis keeps its documented null boundaries", () => {
  assert.equal(scorePicoCliPerfAxis({ status: "ok", summary: {} }, 16.7).perf, null);
  assert.equal(scorePicoCliPerfAxis({ status: "ok", summary: { appFps: { p5: 0, avg: 0 } } }, 16.7).perf, null);
});
scorePicoCliPerfAxis({ status: "ok", measurement: "missing", summary: { appFps: { avg: 71.2, p5: 62 } } }, 16.7).perf === null
  ? ok("an explicit missing measurement scores null even when an appFps block is present")
  : fail("measurement:'missing' was scored");
scorePicoCliPerfAxis(adapt(readSynthetic("0.2.0-skip")), 16.7).perf === null
  ? ok("a SKIP / INSUFFICIENT_DATA report is never a passing budget")
  : fail("SKIP report scored against the budget");
scorePicoCliPerfAxis({ status: "ok", measurement: "partial", summary: { appFps: { avg: 71.2, p5: 62 } } }, 16.7).perf === 1
  ? ok("a partial measurement still scores its measured app FPS")
  : fail("partial measurement was not scored");

// --- trace load / query envelopes ----------------------------------------------------------
const queryEnvelope = {success:true, exitCode:0, resource:"trace", action:"query",
  data:{sessionId:"fixture-session", rpcEndpoint:"http://127.0.0.1:19001", rows:[{value:1}]}};
const validatedQueryResult = validateTraceQueryEnvelope(`${JSON.stringify(queryEnvelope)}\n`, { sessionId: "fixture-session" });
expect("trace query unwraps data.rows and never returns the envelope as rows", () => {
  assert.deepEqual(validatedQueryResult.rows, queryEnvelope.data.rows);
  assert.notDeepEqual(validatedQueryResult.rows, queryEnvelope);
});
validatedQueryResult.status === "ok" && validatedQueryResult.sessionId === "fixture-session"
  ? ok("a successful query envelope validates success/resource/action/session before unwrapping")
  : fail(`query envelope validation wrong: ${JSON.stringify(validatedQueryResult)}`);
const emptyRows = validateTraceQueryEnvelope(JSON.stringify({ ...queryEnvelope, data: { ...queryEnvelope.data, rows: [] } }), { sessionId: "fixture-session" });
emptyRows.status === "ok" && Array.isArray(emptyRows.rows) && emptyRows.rows.length === 0
  ? ok("an empty successful rows array is a measurement, distinct from unavailable rows")
  : fail(`empty rows mishandled: ${JSON.stringify(emptyRows)}`);
const queryFailureCases = [
  ["success:false with exit/error metadata", JSON.stringify({ success: false, exitCode: 1, resource: "trace", action: "query", data: null, error: "Session not found: fixture-session" }), /Session not found/],
  ["wrong session", JSON.stringify({ ...queryEnvelope, data: { ...queryEnvelope.data, sessionId: "other-session" } }), /session/i],
  ["wrong resource", JSON.stringify({ ...queryEnvelope, resource: "live" }), /resource/i],
  ["wrong action", JSON.stringify({ ...queryEnvelope, action: "load" }), /action/i],
  ["rows absent", JSON.stringify({ ...queryEnvelope, data: { sessionId: "fixture-session", rpcEndpoint: "x" } }), /rows/i],
  ["empty output", "", /no .*envelope|empty/i],
  ["malformed output", "Daemon is not running on port 9500", /envelope/i],
  ["truncated JSON", JSON.stringify(queryEnvelope).slice(0, 40), /envelope/i],
];
for (const [label, stdout, pattern] of queryFailureCases) {
  const outcome = validateTraceQueryEnvelope(stdout, { sessionId: "fixture-session" });
  outcome.status === "failed" && pattern.test(outcome.reason ?? "") && outcome.rows === undefined
    ? ok(`trace query rejects ${label} without inventing rows`)
    : fail(`trace query ${label} wrong: ${JSON.stringify(outcome)}`);
}

const loadEnvelope = { success: true, exitCode: 0, resource: "trace", action: "load", data: { sessionId: "sess-42", rpcEndpoint: "http://127.0.0.1:19001", traceFile: "/tmp/t.perfetto-trace", spatialDiagnose: true }, error: null, formattedOutput: null };
const validatedLoad = validateTraceLoadEnvelope(`${JSON.stringify(loadEnvelope)}\n`);
validatedLoad.status === "ok" && validatedLoad.sessionId === "sess-42" && validatedLoad.rpcEndpoint === "http://127.0.0.1:19001"
  ? ok("trace load validates its envelope's success/resource/action before trusting data.sessionId")
  : fail(`load envelope validation wrong: ${JSON.stringify(validatedLoad)}`);
for (const [label, stdout] of [
  ["a failure envelope", JSON.stringify({ success: false, exitCode: 1, resource: "trace", action: "load", data: null, error: "Trace file not found: /tmp/missing" })],
  ["a wrong-action envelope", JSON.stringify({ ...loadEnvelope, action: "query" })],
  ["a missing sessionId", JSON.stringify({ ...loadEnvelope, data: { rpcEndpoint: "x" } })],
  ["empty output", ""],
  ["truncated JSON", JSON.stringify(loadEnvelope).slice(0, 30)],
]) {
  const outcome = validateTraceLoadEnvelope(stdout);
  outcome.status === "failed" && outcome.sessionId === undefined
    ? ok(`trace load refuses ${label} instead of extracting an id`)
    : fail(`trace load ${label} wrong: ${JSON.stringify(outcome)}`);
}
// LEGACY contract, kept separately: the default human renderer's exact label (TRACE_LOAD_HUMAN).
const humanLoadOutput = [
  "[TraceLoad] Session: 9f2c1b7e",
  "[TraceLoad] RPC endpoint: http://127.0.0.1:19001",
  "[TraceLoad] Trace file: /tmp/t.perfetto-trace",
  "[TraceLoad] Next:",
  '  perf trace query --session 9f2c1b7e --sql "select 1;"',
  "  perf session close 9f2c1b7e",
].join("\n");
parseTraceLoadHumanSession(humanLoadOutput) === "9f2c1b7e"
  && parseTraceLoadHumanSession("[TraceLoad] Failed: Trace file not found: /tmp/missing") === null
  && parseTraceLoadHumanSession("session id: guessed-from-prose") === null
  ? ok("the legacy human-label parser reads the exact [TraceLoad] Session: line and nothing else")
  : fail(`legacy load label parser wrong: ${JSON.stringify(parseTraceLoadHumanSession(humanLoadOutput))}`);
validateTraceLoadEnvelope(humanLoadOutput).status === "failed"
  ? ok("the default human load output is not accepted as a JSON session result")
  : fail("human load output was accepted as an envelope");
parseProfilerEnvelope("noise\n" + JSON.stringify(loadEnvelope) + "\nmore noise").status === "ok"
  ? ok("the envelope parser finds the envelope line amid the CLI's own prose")
  : fail("envelope line was not located amid prose");

// Trace argv: explicit long options, per-line package flag, --envelope before the resource.
const traceRecordArgs = traceArgv("record", ["perf", "trace", "record"], cliOperationOptions("0.5.0", "trace-record"),
  { packageName: "com.example.fixture", durationSec: 20, device: "fixture-serial", outputPath: "/tmp/t.perfetto-trace" });
expect("trace record uses the 0.2.0 canonical long options", () => {
  assert.deepEqual(traceRecordArgs, ["perf", "trace", "record", "--duration", "20", "--output", "/tmp/t.perfetto-trace",
    "--device", "fixture-serial", "--package", "com.example.fixture"]);
});
expect("trace record on the 0.4.x line uses --app (profiler 0.1.0 declares no --package)", () => {
  assert.deepEqual(
    traceArgv("record", ["perf", "trace", "record"], cliOperationOptions("0.4.4", "trace-record"),
      { packageName: "com.example.fixture", durationSec: 20, device: "fixture-serial", outputPath: "/tmp/t.perfetto-trace" }),
    ["perf", "trace", "record", "--duration", "20", "--output", "/tmp/t.perfetto-trace", "--device", "fixture-serial", "--app", "com.example.fixture"],
  );
});
expect("trace decode keeps its positional file with explicit --format/--output", () => {
  assert.deepEqual(
    traceArgv("decode", ["perf", "trace", "decode"], cliOperationOptions("0.5.0", "trace-decode"),
      { tracePath: "/tmp/t.perfetto-trace", format: "json", outputPath: "/tmp/t.json" }),
    ["perf", "trace", "decode", "/tmp/t.perfetto-trace", "--format", "json", "--output", "/tmp/t.json"],
  );
});
expect("trace load requests the machine envelope, and the global flag precedes the resource", () => {
  assert.deepEqual(
    traceArgv("load", ["perf", "trace", "load"], cliOperationOptions("0.5.0", "trace-load"), { tracePath: "/tmp/t.perfetto-trace" }),
    ["perf", "--envelope", "trace", "load", "/tmp/t.perfetto-trace"],
  );
});
expect("trace query requests the envelope and passes --session/--sql", () => {
  assert.deepEqual(
    traceArgv("query", ["perf", "trace", "query"], cliOperationOptions("0.5.0", "trace-query"), { sessionId: "sess-42", sql: "select 1;" }),
    ["perf", "--envelope", "trace", "query", "--session", "sess-42", "--sql", "select 1;"],
  );
});

// runPerfTrace: capability refusal, envelope success and a preserved raw failure.
const traceCapability = (state, reason) => ({ operation: "trace-load", state, argvPrefix: ["perf", "trace", "load"], reason, evidence: [] });
const traceRuntime = (overrides = {}) => ({
  capability: () => traceCapability("supported", "help-names-operation: `perf trace load --help` exited 0"),
  options: (operation) => cliOperationOptions("0.5.0", operation),
  run: async () => ({ code: 0, signal: null, stdout: JSON.stringify(loadEnvelope), stderr: "", timedOut: false, outputTruncated: false }),
  retain: () => ({ retained: false, error: "unused" }),
  inspectArtifact: () => ({ exists: true, regularFile: true, bytes: 128 }),
  cliPath: "/fixture/pico-cli",
  cliRaw: "pico-cli/0.5.0 (fixture)",
  cliVersion: "0.5.0",
  ...overrides,
});
const loadResult = await runPerfTrace({ action: "load", tracePath: "/tmp/t.perfetto-trace" }, traceRuntime());
loadResult.status === "ok" && loadResult.sessionId === "sess-42" && loadResult.sessionSource === "envelope"
  ? ok("runPerfTrace load returns the validated envelope session id and names its source")
  : fail(`runPerfTrace load wrong: ${JSON.stringify(loadResult)}`);
const traceRefusal = await runPerfTrace({ action: "load", tracePath: "/tmp/t.perfetto-trace" }, traceRuntime({
  capability: () => traceCapability("unavailable", "utilities-not-installed: `perf trace load --help` exited 3 at the CLI's utilities gate"),
  run: async () => { throw new Error("a refused trace capability must never spawn"); },
}));
traceRefusal.status === "failed" && traceRefusal.failureClass === "setup-required"
  && traceRefusal.note === "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry."
  ? ok("runPerfTrace refuses an unprovisioned trace route without spawning, with the neutral setup sentence")
  : fail(`runPerfTrace refusal wrong: ${JSON.stringify(traceRefusal)}`);
const queryResult = await runPerfTrace({ action: "query", sessionId: "fixture-session", sql: "select 1;" }, traceRuntime({
  capability: () => ({ operation: "trace-query", state: "supported", argvPrefix: ["perf", "trace", "query"], reason: "help-names-operation: ok", evidence: [] }),
  run: async () => ({ code: 0, signal: null, stdout: JSON.stringify(queryEnvelope), stderr: "", timedOut: false, outputTruncated: false }),
}));
JSON.stringify(queryResult.rows) === JSON.stringify([{ value: 1 }]) && queryResult.status === "ok"
  ? ok("runPerfTrace query returns data.rows, not the profiler envelope")
  : fail(`runPerfTrace query wrong: ${JSON.stringify(queryResult)}`);
const truncatedQuery = await runPerfTrace({ action: "query", sessionId: "fixture-session", sql: "select 1;" }, traceRuntime({
  capability: () => ({ operation: "trace-query", state: "supported", argvPrefix: ["perf", "trace", "query"], reason: "help-names-operation: ok", evidence: [] }),
  run: async () => ({ code: 0, signal: null, stdout: JSON.stringify(queryEnvelope).slice(0, 30), stderr: "", timedOut: false, outputTruncated: true }),
}));
truncatedQuery.status === "failed" && truncatedQuery.rows === undefined && truncatedQuery.outputTruncated === true
  ? ok("a truncated query stream fails with the raw output preserved and no invented rows")
  : fail(`truncated query wrong: ${JSON.stringify(truncatedQuery)}`);
fs.rmSync(c4Tmp, { recursive: true, force: true });

console.log(`\npico-cli lane test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
