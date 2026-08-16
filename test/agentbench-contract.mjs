import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  EVIDENCE_CLASSES,
  RESULT_SCHEMA_VERSION,
  RUBRIC_VERSION,
  RULE_DEFINITIONS,
  RUNTIME_PROTOCOL_VERSION,
  attachRuntimeProtocolEvidence,
  createDefaultRuntimeProtocolReceipts,
  createDefaultSubmissionTests,
  validateBuildQualification,
  validateRuntimeEnvironmentReceipt,
  validateRuntimeProtocolEvidenceReceipt,
  validateRuntimeProtocolReceipts,
  validateScoreResultV2,
  validateSubmissionTests,
  validateTestExecutionReceipt,
} from "../benchmarks/spatial-agent-bench/lib/contract.mjs";
import { canonicalJson } from "../benchmarks/spatial-agent-bench/lib/identity.mjs";

const H = {
  a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64),
  e: "e".repeat(64), f: "f".repeat(64), one: "1".repeat(64), two: "2".repeat(64),
  three: "3".repeat(64), four: "4".repeat(64), five: "5".repeat(64), six: "6".repeat(64),
  seven: "7".repeat(64), eight: "8".repeat(64), nine: "9".repeat(64), zero: "0".repeat(64),
};

function digest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function selfHash(value) {
  return { ...value, receiptSha256: digest(value) };
}

function submissionRecord(status = "pass") {
  const base = {
    evidenceClass: "submission_test",
    status,
    testCount: status === "pass" || status === "fail" ? 1 : 0,
    passedCount: status === "pass" ? 1 : 0,
    failureCount: status === "fail" ? 1 : 0,
    errorCount: 0,
    skippedCount: 0,
    preBuildResultsSha256: ["pass", "fail", "execution_failed", "no_source"].includes(status) ? H.a : null,
    resultFiles: ["pass", "fail"].includes(status) ? [{ path: "app/build/test-results/testDebugUnitTest/TEST-state.xml", bytes: 123, sha256: H.b }] : [],
    testExecutionReceiptSha256: ["pass", "fail", "execution_failed", "no_source"].includes(status) ? H.c : null,
    receiptSha256: null,
  };
  if (["pass", "fail", "execution_failed", "no_source"].includes(status)) {
    const without = { ...base };
    delete without.receiptSha256;
    base.receiptSha256 = digest(without);
  }
  return base;
}

function ruleRecord([id, axis, evidenceClass], index) {
  const evidence = [{ evidenceClass: "source", path: `src/rule-${String(index).padStart(2, "0")}.kt`, line: index + 1, excerpt: `source evidence ${index}` }];
  if (evidenceClass === "source_and_typed_fact") evidence.push({ evidenceClass: "typed_fact", kind: "plugin", value: `fact-${index}`, path: `src/rule-${String(index).padStart(2, "0")}.kt`, line: index + 1, excerpt: `typed evidence ${index}` });
  evidence.sort((left, right) => canonicalJson([left.evidenceClass, left.path, left.line, left.kind ?? "", left.key ?? "", left.value ?? "", left.excerpt]).localeCompare(canonicalJson([right.evidenceClass, right.path, right.line, right.kind ?? "", right.key ?? "", right.value ?? "", right.excerpt])));
  return { id, rubricVersion: 2, axis, evidenceClass, pass: true, evidence, reason: `Rule ${id} has structural evidence.` };
}

function scoreRecord() {
  return {
    resultSchemaVersion: 2,
    rubricVersion: 2,
    rules: RULE_DEFINITIONS.map(ruleRecord),
    structuralAxes: { spatialNative: 4, ecs: 4, statePassing: 4, planarTracking: 4 },
    structuralScore: 16,
    build: { status: "pass", receiptSha256: H.a },
    buildQualifiedStructuralScore: 16,
    submissionTests: createDefaultSubmissionTests("pass"),
    runtimeProtocolReceipts: createDefaultRuntimeProtocolReceipts("pass"),
    visual: { status: "not_performed", captureSha256: null },
  };
}

function attachmentFixture() {
  const corpusIdentitySha256 = H.b;
  const attemptInputIdentitySha256 = H.c;
  const apkSha256 = H.d;
  const packageName = "com.agentbench.museum";
  const build = selfHash({ version: 1, status: "pass", corpusIdentitySha256, attemptInputIdentitySha256, apkSha256, packageName });
  const environment = selfHash({
    version: 1,
    status: "ready",
    hostPlatform: "macos",
    corpusIdentitySha256,
    attemptInputIdentitySha256,
    reasonCode: null,
    emulatorIdentitySha256: H.e,
    resetDriverSha256: H.f,
    tableFixtureSha256: H.one,
    floorFixtureSha256: H.two,
    probeTranscriptSha256: H.three,
  });
  const reset = (runName, fixtureKind, fixtureSha256, lifecycleHash) => selfHash({
    version: 1,
    runName,
    corpusIdentitySha256,
    attemptInputIdentitySha256,
    buildReceiptSha256: build.receiptSha256,
    apkSha256,
    packageName,
    resetDriverSha256: H.f,
    fixtureKind,
    fixtureSha256,
    orderedLifecycleTranscriptSha256: lifecycleHash,
  });
  const resets = {
    state: reset("state", "table-present", H.one, H.four),
    tick: reset("tick", "table-present", H.one, H.five),
    table_surface: reset("table_surface", "table-present", H.one, H.six),
    floor_surface: reset("floor_surface", "floor-only", H.two, H.seven),
  };
  const detailed = selfHash({
    version: 1,
    protocolVersion: 1,
    corpusIdentitySha256,
    attemptInputIdentitySha256,
    buildReceiptSha256: build.receiptSha256,
    apkSha256,
    packageName,
    protocolVectorsSha256: H.eight,
    environmentReceiptSha256: environment.receiptSha256,
    driverSha256: H.nine,
    validatorSha256: H.zero,
    transcriptSha256: H.f,
    resetInstallReceipts: {
      stateSha256: resets.state.receiptSha256,
      tickSha256: resets.tick.receiptSha256,
      tableSurfaceSha256: resets.table_surface.receiptSha256,
      floorSurfaceSha256: resets.floor_surface.receiptSha256,
    },
    checks: { stateTranscript: "pass", surfaceTranscript: "pass", tickTranscript: "pass" },
  });
  const records = new Map([
    [build.receiptSha256, build],
    [environment.receiptSha256, environment],
    ...Object.values(resets).map((value) => [value.receiptSha256, value]),
  ]);
  const score = scoreRecord();
  score.build.receiptSha256 = build.receiptSha256;
  return {
    corpusIdentitySha256,
    attemptInputIdentitySha256,
    protocolVectorsSha256: H.eight,
    build,
    environment,
    resets,
    detailed,
    score,
    receiptStore: { resolve(_kind, sha256) { return structuredClone(records.get(sha256)); } },
    records,
  };
}

test("contract freezes rubric-v2 structural-only vocabulary", () => {
  assert.equal(RESULT_SCHEMA_VERSION, 2);
  assert.equal(RUBRIC_VERSION, 2);
  assert.equal(RUNTIME_PROTOCOL_VERSION, 1);
  assert.deepEqual(RULE_DEFINITIONS, [
    ["spatial.project-entry", "spatialNative", "source_and_typed_fact"],
    ["spatial.container-topology", "spatialNative", "source_and_typed_fact"],
    ["spatial.entity-content", "spatialNative", "source"],
    ["spatial.ui-lifecycle", "spatialNative", "source"],
    ["ecs.component-clone", "ecs", "source"],
    ["ecs.system-query", "ecs", "source"],
    ["ecs.frame-update", "ecs", "source"],
    ["ecs.lifecycle", "ecs", "source"],
    ["state.single-source", "statePassing", "source"],
    ["state.typed-handoff", "statePassing", "source"],
    ["state.shared-read-write", "statePassing", "source"],
    ["state.reopen-wiring", "statePassing", "source"],
    ["plane.retry-readiness", "planarTracking", "source"],
    ["plane.semantic-fallback", "planarTracking", "source"],
    ["plane.anchor-pose", "planarTracking", "source"],
    ["plane.cleanup-errors", "planarTracking", "source"],
  ]);
  assert.deepEqual(EVIDENCE_CLASSES, ["source", "typed_fact", "source_and_typed_fact", "submission_test", "app_self_reported_protocol", "external_observation"]);
  assert.equal(Object.isFrozen(RULE_DEFINITIONS), true);
  assert.equal(Object.isFrozen(RULE_DEFINITIONS[0]), true);
  assert.equal(RULE_DEFINITIONS.some(([id]) => id === "state.round-trip"), false);
  assert.equal(RULE_DEFINITIONS.some(([, , evidence]) => ["submission_test", "app_self_reported_protocol"].includes(evidence)), false);
});

test("build qualification and default evidence records fail closed", () => {
  assert.deepEqual(validateBuildQualification({ status: "pass", receiptSha256: H.a }), { status: "pass", receiptSha256: H.a });
  assert.deepEqual(validateBuildQualification({ status: "fail", receiptSha256: H.a }), { status: "fail", receiptSha256: H.a });
  assert.deepEqual(validateBuildQualification({ status: "not_run", receiptSha256: null }), { status: "not_run", receiptSha256: null });
  assert.throws(() => validateBuildQualification({ status: "pass", receiptSha256: null }), /receipt/i);
  assert.throws(() => validateBuildQualification({ status: "not_run", receiptSha256: H.a }), /receipt/i);
  assert.throws(() => validateBuildQualification({ status: "pass", receiptSha256: H.a, extra: true }), /unknown/i);
  assert.equal(createDefaultSubmissionTests("pass").status, "not_run");
  assert.equal(createDefaultSubmissionTests("fail").status, "not_run_build_failed");
  assert.equal(createDefaultSubmissionTests("not_run").status, "not_run");
  assert.equal(createDefaultRuntimeProtocolReceipts("pass").runStatus, "not_run");
  assert.equal(createDefaultRuntimeProtocolReceipts("fail").runStatus, "not_run_build_failed");
  assert.throws(() => createDefaultSubmissionTests("blocked"), /build status/i);
  assert.throws(() => createDefaultRuntimeProtocolReceipts("blocked"), /build status/i);
  assert.equal(Object.isFrozen(createDefaultRuntimeProtocolReceipts("pass").checks), true);
});

test("submission-test validator keeps model-authored tests separate and provenance-bound", () => {
  for (const status of ["pass", "fail", "execution_failed", "no_source"]) {
    const value = validateSubmissionTests(submissionRecord(status), "pass");
    assert.equal(value.status, status);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isFrozen(value.resultFiles), true);
  }
  assert.deepEqual(validateSubmissionTests(createDefaultSubmissionTests("fail"), "fail"), createDefaultSubmissionTests("fail"));
  assert.deepEqual(validateSubmissionTests(createDefaultSubmissionTests("not_run"), "not_run"), createDefaultSubmissionTests("not_run"));
  const bad = submissionRecord("pass");
  bad.failureCount = 1;
  assert.throws(() => validateSubmissionTests(bad, "pass"), /count|pass/i);
  assert.throws(() => validateSubmissionTests(submissionRecord("pass"), "fail"), /build/i);
  const reordered = submissionRecord("pass");
  reordered.resultFiles = [
    { path: "z.xml", bytes: 1, sha256: H.d },
    { path: "a.xml", bytes: 1, sha256: H.e },
  ];
  const noDigest = { ...reordered }; delete noDigest.receiptSha256; reordered.receiptSha256 = digest(noDigest);
  assert.throws(() => validateSubmissionTests(reordered, "pass"), /sorted/i);
  const forged = submissionRecord("pass"); forged.receiptSha256 = H.zero;
  assert.throws(() => validateSubmissionTests(forged, "pass"), /digest|receipt/i);
});

test("trusted test-execution receipts bind the exact command and output bytes", () => {
  const receipt = selfHash({
    version: 1,
    launcherSha256: H.a,
    gradleExecutableSha256: H.b,
    command: ["$PINNED_GRADLE/bin/gradle", "--offline", "--no-daemon", "--no-configuration-cache", "--console=plain", ":app:testDebugUnitTest"],
    workingDirectory: "submission",
    exitCode: 0,
    stdoutBytes: 42,
    stdoutSha256: H.c,
    stderrBytes: 0,
    stderrSha256: H.d,
  });
  assert.deepEqual(validateTestExecutionReceipt(receipt), receipt);
  const wrapper = structuredClone(receipt); wrapper.command[0] = "./gradlew";
  assert.throws(() => validateTestExecutionReceipt(wrapper), /command/i);
  const forged = structuredClone(receipt); forged.stdoutBytes = 43;
  assert.throws(() => validateTestExecutionReceipt(forged), /digest|receipt/i);
});

test("runtime receipt validators distinguish blocked, not-run, and complete records", () => {
  const blocked = selfHash({
    version: 1,
    status: "blocked",
    hostPlatform: "macos",
    corpusIdentitySha256: H.a,
    attemptInputIdentitySha256: H.b,
    reasonCode: "emulator_unreachable",
    emulatorIdentitySha256: null,
    resetDriverSha256: null,
    tableFixtureSha256: null,
    floorFixtureSha256: null,
    probeTranscriptSha256: H.c,
  });
  assert.deepEqual(validateRuntimeEnvironmentReceipt(blocked), blocked);
  const fixture = attachmentFixture();
  assert.deepEqual(validateRuntimeEnvironmentReceipt(fixture.environment), fixture.environment);
  assert.deepEqual(validateRuntimeProtocolEvidenceReceipt(fixture.detailed), fixture.detailed);
  const attached = attachRuntimeProtocolEvidence({
    score: fixture.score,
    receipt: fixture.detailed,
    loadedCorpusIdentitySha256: fixture.corpusIdentitySha256,
    loadedProtocolVectorsSha256: fixture.protocolVectorsSha256,
    attemptInputIdentitySha256: fixture.attemptInputIdentitySha256,
    receiptStore: fixture.receiptStore,
  });
  assert.equal(attached.runtimeProtocolReceipts.runStatus, "complete");
  assert.deepEqual(attached.runtimeProtocolReceipts.checks, fixture.detailed.checks);
  assert.equal(attached.runtimeProtocolReceipts.apkSha256, fixture.build.apkSha256);
  assert.equal(attached.runtimeProtocolReceipts.packageName, fixture.build.packageName);
  assert.equal(attached.runtimeProtocolReceipts.receiptSha256, fixture.detailed.receiptSha256);
  assert.equal(fixture.score.runtimeProtocolReceipts.runStatus, "not_run", "attachment must not mutate its input score");
  assert.equal(Object.isFrozen(attached), true);
  assert.deepEqual(validateRuntimeProtocolReceipts(attached.runtimeProtocolReceipts, "pass"), attached.runtimeProtocolReceipts);
});

test("runtime attachment rejects every identity transplant after private-store resolution", async (t) => {
  const mutations = [
    ["corpus", (f) => { f.detailed.corpusIdentitySha256 = H.zero; }],
    ["attempt", (f) => { f.detailed.attemptInputIdentitySha256 = H.zero; }],
    ["build receipt", (f) => { f.detailed.buildReceiptSha256 = H.zero; }],
    ["APK", (f) => { f.detailed.apkSha256 = H.zero; }],
    ["package", (f) => { f.detailed.packageName = "com.agentbench.other"; }],
    ["vectors", (f) => { f.detailed.protocolVectorsSha256 = H.zero; }],
    ["environment", (f) => { f.detailed.environmentReceiptSha256 = H.zero; }],
    ["driver", (f) => { f.detailed.driverSha256 = H.a; }],
    ["validator", (f) => { f.detailed.validatorSha256 = H.a; }],
    ["transcript", (f) => { f.detailed.transcriptSha256 = H.a; }],
    ["state reset", (f) => { f.detailed.resetInstallReceipts.stateSha256 = H.zero; }],
    ["tick reset", (f) => { f.detailed.resetInstallReceipts.tickSha256 = H.zero; }],
    ["table reset", (f) => { f.detailed.resetInstallReceipts.tableSurfaceSha256 = H.zero; }],
    ["floor reset", (f) => { f.detailed.resetInstallReceipts.floorSurfaceSha256 = H.zero; }],
    ["check", (f) => { f.detailed.checks.tickTranscript = "fail"; }],
    ["receipt digest", (f) => { f.detailed.receiptSha256 = H.zero; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const fixture = attachmentFixture();
    mutate(fixture);
    assert.throws(() => attachRuntimeProtocolEvidence({
      score: fixture.score,
      receipt: fixture.detailed,
      loadedCorpusIdentitySha256: fixture.corpusIdentitySha256,
      loadedProtocolVectorsSha256: fixture.protocolVectorsSha256,
      attemptInputIdentitySha256: fixture.attemptInputIdentitySha256,
      receiptStore: fixture.receiptStore,
    }));
    assert.equal(fixture.score.runtimeProtocolReceipts.runStatus, "not_run");
  });
});

test("runtime attachment joins artifacts, fixtures, and distinct run names rather than trusting caller strings", async (t) => {
  for (const field of ["apkSha256", "packageName"]) await t.test(`build artifact ${field}`, () => {
    const fixture = attachmentFixture();
    const transplanted = { ...fixture.resets.state, [field]: field === "apkSha256" ? H.zero : "com.agentbench.other" };
    delete transplanted.receiptSha256;
    const validTransplant = selfHash(transplanted);
    fixture.detailed.resetInstallReceipts.stateSha256 = validTransplant.receiptSha256;
    fixture.receiptStore = { resolve(_kind, sha256) { return structuredClone(sha256 === validTransplant.receiptSha256 ? validTransplant : fixture.records.get(sha256)); } };
    const detail = { ...fixture.detailed }; delete detail.receiptSha256; fixture.detailed = selfHash(detail);
    assert.throws(() => attachRuntimeProtocolEvidence({ score: fixture.score, receipt: fixture.detailed, loadedCorpusIdentitySha256: fixture.corpusIdentitySha256, loadedProtocolVectorsSha256: fixture.protocolVectorsSha256, attemptInputIdentitySha256: fixture.attemptInputIdentitySha256, receiptStore: fixture.receiptStore }), /apk|package|artifact|reset/i);
  });
  await t.test("environment fixture transplant", () => {
    const fixture = attachmentFixture();
    const env = { ...fixture.environment, tableFixtureSha256: H.zero }; delete env.receiptSha256;
    const transplanted = selfHash(env);
    const detail = { ...fixture.detailed, environmentReceiptSha256: transplanted.receiptSha256 }; delete detail.receiptSha256;
    fixture.detailed = selfHash(detail);
    fixture.receiptStore = { resolve(_kind, sha256) { return structuredClone(sha256 === transplanted.receiptSha256 ? transplanted : fixture.records.get(sha256)); } };
    assert.throws(() => attachRuntimeProtocolEvidence({ score: fixture.score, receipt: fixture.detailed, loadedCorpusIdentitySha256: fixture.corpusIdentitySha256, loadedProtocolVectorsSha256: fixture.protocolVectorsSha256, attemptInputIdentitySha256: fixture.attemptInputIdentitySha256, receiptStore: fixture.receiptStore }), /fixture/i);
  });
  await t.test("valid reset receipts swapped between run names", () => {
    const fixture = attachmentFixture();
    [fixture.detailed.resetInstallReceipts.stateSha256, fixture.detailed.resetInstallReceipts.tickSha256] = [fixture.detailed.resetInstallReceipts.tickSha256, fixture.detailed.resetInstallReceipts.stateSha256];
    const detail = { ...fixture.detailed }; delete detail.receiptSha256; fixture.detailed = selfHash(detail);
    assert.throws(() => attachRuntimeProtocolEvidence({ score: fixture.score, receipt: fixture.detailed, loadedCorpusIdentitySha256: fixture.corpusIdentitySha256, loadedProtocolVectorsSha256: fixture.protocolVectorsSha256, attemptInputIdentitySha256: fixture.attemptInputIdentitySha256, receiptStore: fixture.receiptStore }), /run name|runName/i);
  });
});

test("score-result v2 validates complete structural evidence and retains no caller reference", () => {
  const input = scoreRecord();
  const validated = validateScoreResultV2(input);
  assert.deepEqual(validated, input);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.rules[0].evidence[0]), true);
  input.rules[0].reason = "mutated after validation";
  assert.notEqual(validated.rules[0].reason, input.rules[0].reason);
  for (const forbidden of ["deliveryScore", "runtime", "behavior", "behaviorPass", "signoffCandidate", "behaviorallyQualified"]) {
    const mutated = scoreRecord(); mutated[forbidden] = null;
    assert.throws(() => validateScoreResultV2(mutated), /unknown/i, forbidden);
  }
});

test("score-result v2 rejects incomplete, malformed, duplicated, or reordered evidence", async (t) => {
  const mutations = [
    ["pass without evidence", (s) => { s.rules[2].evidence = []; }],
    ["failure with evidence", (s) => { s.rules[2].pass = false; }],
    ["forbidden evidence class", (s) => { s.rules[2].evidence[0].evidenceClass = "submission_test"; }],
    ["mixed without typed fact", (s) => { s.rules[0].evidence = s.rules[0].evidence.filter((row) => row.evidenceClass === "source"); }],
    ["mixed without source", (s) => { s.rules[0].evidence = s.rules[0].evidence.filter((row) => row.evidenceClass === "typed_fact"); }],
    ["absolute path", (s) => { s.rules[2].evidence[0].path = "/tmp/source.kt"; }],
    ["traversal path", (s) => { s.rules[2].evidence[0].path = "src/../source.kt"; }],
    ["backslash path", (s) => { s.rules[2].evidence[0].path = "src\\source.kt"; }],
    ["zero line", (s) => { s.rules[2].evidence[0].line = 0; }],
    ["fractional line", (s) => { s.rules[2].evidence[0].line = 1.5; }],
    ["blank excerpt", (s) => { s.rules[2].evidence[0].excerpt = " "; }],
    ["multiline excerpt", (s) => { s.rules[2].evidence[0].excerpt = "one\ntwo"; }],
    ["oversize excerpt", (s) => { s.rules[2].evidence[0].excerpt = "x".repeat(513); }],
    ["blank reason", (s) => { s.rules[2].reason = " "; }],
    ["multiline reason", (s) => { s.rules[2].reason = "one\ntwo"; }],
    ["oversize reason", (s) => { s.rules[2].reason = "x".repeat(513); }],
    ["unknown typed fact key", (s) => { s.rules[0].evidence.find((row) => row.evidenceClass === "typed_fact").original = "bait"; }],
    ["null typed fact key", (s) => { s.rules[0].evidence.find((row) => row.evidenceClass === "typed_fact").key = null; }],
    ["duplicate evidence", (s) => { s.rules[2].evidence.push(structuredClone(s.rules[2].evidence[0])); }],
    ["reordered evidence", (s) => { s.rules[0].evidence.reverse(); }],
    ["reordered rules", (s) => { [s.rules[0], s.rules[1]] = [s.rules[1], s.rules[0]]; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const score = scoreRecord(); mutate(score);
    assert.throws(() => validateScoreResultV2(score));
  });
});
