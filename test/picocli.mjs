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

console.log(`\npico-cli lane test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
