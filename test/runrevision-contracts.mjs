import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../dist/runreceiptidentity.js";
import {
  RUN_ACCEPTANCE_MAX,
  RUN_ACCEPTANCE_MAX_BYTES,
  RUN_REVISION_MAX,
  RUN_REVISION_MAX_BYTES,
  boundedDiagnostic,
  normalizeAcceptance,
  normalizeGoal,
  normalizeLoopPolicy,
  parsePublicResult,
  parseRunControlResult,
  parseRunHead,
  parseRunRevision,
  parseSnapshotEnvelope,
} from "../dist/runrevisiontypes.js";
import {
  ATTEMPT_ID,
  RUN_ID,
  SHA_A,
  SHA_B,
  absentGeneration,
  authoredSpec,
  baseRevision,
  buildWork,
  diagnostic,
  goalEnvelope,
  loopCommon,
  parsedSpecCanonical,
  refreshRevisionId,
  revisionOne,
  revisionIdOf,
  sha,
  snapshotRef,
  transitionRevision,
} from "./helpers/runrevision-fixture.mjs";

const mustReject = (fn, pattern = /invalid|must|unsupported|unknown|limit|canonical|mismatch|cycle|impossible|exceed|lack|order|require|duplicate|sparse|accessor|cannot|only|broken/i) =>
  assert.throws(fn, pattern);

const externalEnvelope = (overrides = {}) => ({
  kind: "pico.workflow-external-input",
  schemaVersion: 1,
  policy: "pico-fleet-external-input-v1",
  appSpecSha256: SHA_A,
  briefPayloadSha256: SHA_B,
  resourceKey: SHA_A,
  projectResourceKey: SHA_B,
  physicalProjectDir: "/tmp/project",
  inputBaseDir: "/tmp",
  iblSelector: null,
  uses: [],
  files: [],
  iblChoices: [],
  uniqueFileCount: 0,
  totalBytes: 0,
  ...overrides,
});

test("goal normalization preserves raw target bytes while canonicalizing intent", () => {
  const got = normalizeGoal("  Cafe\u0301\r\nRoom  ");
  assert.equal(got.original, "  Cafe\u0301\r\nRoom  ");
  assert.equal(got.normalized, "Café\nRoom");
  assert.equal(got.digest, sha('{"goal":"Café\\nRoom","kind":"pico.workflow-goal","schemaVersion":1}'));
});

for (const { name, input, normalized } of [
  { name: "CRLF", input: "a\r\nb", normalized: "a\nb" },
  { name: "bare CR", input: "a\rb", normalized: "a\nb" },
  { name: "NFC", input: "Cafe\u0301", normalized: "Café" },
  { name: "outer whitespace", input: " \t goal \n", normalized: "goal" },
  { name: "internal tab and newline", input: "a\tb\n c", normalized: "a\tb\n c" },
]) {
  test(`goal normalization ${name} catches normalization drift`, () => {
    assert.equal(normalizeGoal(input).normalized, normalized);
  });
}

for (const { name, value } of [
  { name: "empty", value: " \r\n\t " },
  { name: "control", value: "goal\u0000tail" },
  { name: "oversize", value: "x".repeat(256 * 1024 + 1) },
]) {
  test(`goal ${name} rejects an unbounded or unsafe intent`, () => mustReject(() => normalizeGoal(value)));
}

test("goal bounds original bytes separately from normalized bytes", () => {
  const original = `${" ".repeat(70 * 1024)}x`;
  assert.equal(normalizeGoal(original).normalized, "x");
  mustReject(() => normalizeGoal("x".repeat(64 * 1024 + 1)));
});

test("acceptance preserves order and duplicates while digesting strict per-kind values", () => {
  const got = normalizeAcceptance([
    { kind: "visual", pattern: "ignored" },
    { kind: "visual" },
    { kind: "logcat", pattern: "READY" },
  ]);
  assert.deepEqual(got.envelope.criteria.map((x) => [x.inputIndex, x.kind]), [
    [0, "visual"], [1, "visual"], [2, "logcat"],
  ]);
  assert.notEqual(got.envelope.criteria[0].criterionDigest, got.envelope.criteria[1].criterionDigest);
});

test("ignored cross-kind fields do not consume the normalized acceptance byte budget", () => {
  const plain = normalizeAcceptance([{ kind: "visual" }]);
  const ignored = normalizeAcceptance([{ kind: "visual", pattern: "x".repeat(RUN_ACCEPTANCE_MAX_BYTES + 1) }]);
  assert.deepEqual(ignored, plain);
});

test("acceptance expands exact per-kind defaults and ignores cross-kind fields", () => {
  const got = normalizeAcceptance([
    { kind: "structural" },
    { kind: "visual", pattern: "ignored" },
    { kind: "logcat", pattern: "READY", tag: "" },
    { kind: "perf", durationSec: 0 },
  ]).envelope.criteria;
  assert.deepEqual(got.map(({ criterionDigest: _digest, ...criterion }) => criterion), [
    { kind: "structural", inputIndex: 0, entitiesPresent: [], minEntities: null, componentsPresent: [] },
    { kind: "visual", inputIndex: 1 },
    { kind: "logcat", inputIndex: 2, pattern: "READY", tag: null, timeoutSec: 20 },
    { kind: "perf", inputIndex: 3, minAppFpsP5: 60, durationSec: 15 },
  ]);
  for (const criterion of got) {
    const { criterionDigest, ...payload } = criterion;
    assert.equal(criterionDigest, sha(canonicalJson(payload)));
  }
});

test("acceptance preserves public-schema signed integers for downstream validation", () => {
  const largeInteger = Number.MAX_SAFE_INTEGER + 1;
  const criteria = normalizeAcceptance([
    { kind: "structural", minEntities: -1 },
    { kind: "logcat", pattern: "READY", timeoutSec: -2 },
    { kind: "perf", durationSec: largeInteger },
  ]).envelope.criteria;
  assert.equal(criteria[0].minEntities, -1);
  assert.equal(criteria[1].timeoutSec, -2);
  assert.equal(criteria[2].durationSec, largeInteger);
});

test("acceptance allows 64 criteria and rejects 65", () => {
  assert.equal(normalizeAcceptance(Array.from({ length: RUN_ACCEPTANCE_MAX }, () => ({ kind: "visual" }))).envelope.criteria.length, 64);
  mustReject(() => normalizeAcceptance(Array.from({ length: RUN_ACCEPTANCE_MAX + 1 }, () => ({ kind: "visual" }))));
});

test("acceptance rejects empty, invalid logcat, and a canonical envelope over its byte cap", () => {
  mustReject(() => normalizeAcceptance([]));
  mustReject(() => normalizeAcceptance([{ kind: "logcat", pattern: "" }]));
  mustReject(() => normalizeAcceptance([{ kind: "structural", entitiesPresent: ["x".repeat(RUN_ACCEPTANCE_MAX_BYTES)] }]));
  mustReject(() => normalizeAcceptance(Array.from({ length: 5 }, () => ({ kind: "structural", entitiesPresent: ["x".repeat(60 * 1024)] }))));
});

for (const [name, budget, onFail, expected] of [
  ["defaults", undefined, undefined, { budget: { iterations: 3, timeMin: 20, toolCalls: "inert" }, onFail: "replan" }],
  ["lower iteration bound", { iterations: 1, toolCalls: 999 }, "stop", { budget: { iterations: 1, timeMin: 20, toolCalls: "inert" }, onFail: "stop" }],
  ["upper iteration bound", { iterations: 6, timeMin: 1440 }, "replan", { budget: { iterations: 6, timeMin: 1440, toolCalls: "inert" }, onFail: "replan" }],
  ["zero time", { timeMin: 0 }, undefined, { budget: { iterations: 3, timeMin: 0, toolCalls: "inert" }, onFail: "replan" }],
  ["fractional time", { timeMin: 0.5 }, undefined, { budget: { iterations: 3, timeMin: 0.5, toolCalls: "inert" }, onFail: "replan" }],
  ["signed inert toolCalls", { toolCalls: -9 }, undefined, { budget: { iterations: 3, timeMin: 20, toolCalls: "inert" }, onFail: "replan" }],
  ["large inert toolCalls", { toolCalls: Number.MAX_SAFE_INTEGER + 1 }, undefined, { budget: { iterations: 3, timeMin: 20, toolCalls: "inert" }, onFail: "replan" }],
]) {
  test(`loop policy ${name} catches default/bound drift`, () => assert.deepEqual(normalizeLoopPolicy(budget, onFail), expected));
}

for (const [name, budget, onFail] of [
  ["zero iterations", { iterations: 0 }, undefined],
  ["seven iterations", { iterations: 7 }, undefined],
  ["negative time", { timeMin: -1 }, undefined],
  ["above 1440", { timeMin: 1440 + Number.EPSILON * 1024 }, undefined],
  ["non-finite time", { timeMin: Infinity }, undefined],
  ["unknown budget key", { surprise: true }, undefined],
  ["unknown failure mode", undefined, "retry"],
]) {
  test(`loop policy rejects ${name}`, () => mustReject(() => normalizeLoopPolicy(budget, onFail)));
}

test("bounded diagnostics retain a digest of scrubbed pre-truncation detail", () => {
  const raw = `prefix\u001b[31m${"é".repeat(5000)}`;
  const got = boundedDiagnostic("compile.failed", raw);
  assert.equal(got.code, "compile.failed");
  assert.ok(Buffer.byteLength(got.detail) <= 4 * 1024);
  assert.equal(got.detailSha256, sha("prefix" + "é".repeat(5000)));
  assert.ok(Buffer.byteLength(boundedDiagnostic("utf8.boundary", `${"a".repeat(4095)}€`).detail) <= 4 * 1024);
});

test("snapshot parsers expand AppSpec defaults through the repository schema", () => {
  const parsed = parseSnapshotEnvelope("app-spec", {
    kind: "pico.workflow-app-spec",
    schemaVersion: 1,
    spec: authoredSpec,
  });
  assert.equal(canonicalJson(parsed.spec), parsedSpecCanonical);
  const cyclicSpec = structuredClone(authoredSpec);
  cyclicSpec.meta.self = cyclicSpec;
  mustReject(() => parseSnapshotEnvelope("app-spec", { kind: "pico.workflow-app-spec", schemaVersion: 1, spec: cyclicSpec }));
  const oversizedSpec = {
    ...structuredClone(authoredSpec),
    meta: {
      ...authoredSpec.meta,
      secondaryContainers: Array.from({ length: 40 }, (_, index) => ({ kind: "window", id: `w${index}`, content: "x".repeat(60 * 1024) })),
    },
  };
  mustReject(() => parseSnapshotEnvelope("app-spec", { kind: "pico.workflow-app-spec", schemaVersion: 1, spec: oversizedSpec }));
});

test("snapshot parser accepts every exact envelope kind", () => {
  const acceptance = normalizeAcceptance([{ kind: "visual" }]).envelope;
  const cases = [
    ["goal", goalEnvelope()],
    ["acceptance", acceptance],
    ["app-spec", { kind: "pico.workflow-app-spec", schemaVersion: 1, spec: authoredSpec }],
    ["brief-payload", { kind: "pico.workflow-brief-payload", schemaVersion: 1, id: "door238151", brief: "Fixture", spec: authoredSpec }],
    ["external-input", { kind: "pico.workflow-external-input", schemaVersion: 1, policy: "pico-fleet-external-input-v1", appSpecSha256: SHA_A, briefPayloadSha256: SHA_B, resourceKey: SHA_A, projectResourceKey: SHA_B, physicalProjectDir: "/tmp/project", inputBaseDir: "/tmp", iblSelector: null, uses: [], files: [], iblChoices: [], uniqueFileCount: 0, totalBytes: 0 }],
    ["compiler-ledger", { kind: "pico.workflow-compiler-ledger", schemaVersion: 1, steps: [], projectWrites: [] }],
    ["public-result", { kind: "pico.workflow-public-result", schemaVersion: 1, workflow: "pico-build-app", status: "plan-failed", publicResult: { status: "plan-failed", detail: "fixture", fix: "fix" } }],
  ];
  for (const [kind, value] of cases) assert.equal(parseSnapshotEnvelope(kind, value).kind, value.kind);
});

test("brief payload preserves the 256 KiB caller brief exception", () => {
  const brief = "x".repeat(70 * 1024);
  const parsed = parseSnapshotEnvelope("brief-payload", {
    kind: "pico.workflow-brief-payload", schemaVersion: 1,
    id: "door-fixture", brief, spec: authoredSpec,
  });
  assert.equal(parsed.brief.length, brief.length);
  mustReject(() => parseSnapshotEnvelope("brief-payload", {
    kind: "pico.workflow-brief-payload", schemaVersion: 1,
    id: "door-fixture", brief: "x".repeat(256 * 1024 + 1), spec: authoredSpec,
  }));
});

test("snapshot parser rejects wrong kinds, versions, unknown keys, and canonical-unsafe inputs", () => {
  mustReject(() => parseSnapshotEnvelope("goal", { ...goalEnvelope(), extra: true }));
  mustReject(() => parseSnapshotEnvelope("goal", { ...goalEnvelope(), schemaVersion: 2 }));
  mustReject(() => parseSnapshotEnvelope("acceptance", goalEnvelope()));
  const custom = Object.create({ inherited: true });
  Object.assign(custom, goalEnvelope());
  mustReject(() => parseSnapshotEnvelope("goal", custom));
  const cyclic = goalEnvelope();
  cyclic.self = cyclic;
  mustReject(() => parseSnapshotEnvelope("goal", cyclic));
  const sparse = [];
  sparse[1] = "x";
  mustReject(() => parseSnapshotEnvelope("acceptance", { kind: "pico.workflow-acceptance", schemaVersion: 1, criteria: sparse }));
  const accessor = goalEnvelope();
  Object.defineProperty(accessor, "goal", { enumerable: true, get: () => "Fixture" });
  mustReject(() => parseSnapshotEnvelope("goal", accessor));
});

test("external-input files are canonical-path sorted and unique", () => {
  const envelope = externalEnvelope({
    files: [
      { status: "absent", resolvedPath: "/tmp/z.asset" },
      { status: "absent", resolvedPath: "/tmp/a.asset" },
    ],
    uniqueFileCount: 2,
  });
  mustReject(() => parseSnapshotEnvelope("external-input", envelope));
  mustReject(() => parseSnapshotEnvelope("external-input", { ...envelope, files: [envelope.files[0], envelope.files[0]] }));
});

test("external-input enforces IBL file bindings, safe relative paths, count caps, and bytes", () => {
  const file = { status: "absent", resolvedPath: "/tmp/generated.ktx" };
  const generated = externalEnvelope({
    files: [file], uniqueFileCount: 1,
    iblChoices: [{ ktxAssetPath: "environment/generated.ktx", resolution: "project-generation", externalFileIndex: 0 }],
  });
  assert.equal(parseSnapshotEnvelope("external-input", generated).iblChoices[0].externalFileIndex, 0);
  mustReject(() => parseSnapshotEnvelope("external-input", externalEnvelope({ iblChoices: [{ ktxAssetPath: "../escape.ktx", resolution: "unresolved", externalFileIndex: null }] })));
  mustReject(() => parseSnapshotEnvelope("external-input", externalEnvelope({ uses: Array.from({ length: 257 }, (_, index) => ({ order: index, jsonPointer: `/x/${index}`, role: "semantic-scene", declaredPath: "a", resolvedPath: `/tmp/${index}`, fileIndex: null })) })));
  mustReject(() => parseSnapshotEnvelope("external-input", externalEnvelope({
    iblChoices: Array.from({ length: 200 }, () => ({ ktxAssetPath: `${"a".repeat(12 * 1024)}.ktx`, resolution: "unresolved", externalFileIndex: null })),
  })));
  mustReject(() => parseSnapshotEnvelope("external-input", externalEnvelope({
    files: [{ status: "observed", resolvedPath: "/tmp/huge.ktx", realPath: "/tmp/huge.ktx", bytes: 256 * 1024 * 1024 + 1, sha256: SHA_A, validation: "ibl-ktx" }],
    uniqueFileCount: 1,
    totalBytes: 256 * 1024 * 1024 + 1,
  })));
});

test("compiler ledger rejects impossible execution evidence and broken write chains", () => {
  const omittedNote = {
    kind: "pico.workflow-compiler-ledger",
    schemaVersion: 1,
    steps: [{
      order: 0, node: "generator", tool: "generate", args: {}, targetPath: "project", cClass: "structural", status: "planned",
      execution: { disposition: "executed-success", outputConfirmation: "confirmed", detailDigest: null },
    }],
    projectWrites: [],
  };
  assert.equal(parseSnapshotEnvelope("compiler-ledger", omittedNote).steps[0].note, null);
  const badExecution = {
    kind: "pico.workflow-compiler-ledger",
    schemaVersion: 1,
    steps: [{
      order: 0, node: "scaffold", tool: "scaffold_native_project", args: {},
      targetPath: "project", cClass: "structural", status: "planned", note: null,
      execution: { disposition: "scaffolded", outputConfirmation: "unconfirmed", detailDigest: null },
    }],
    projectWrites: [],
  };
  mustReject(() => parseSnapshotEnvelope("compiler-ledger", badExecution));
  const brokenChain = {
    kind: "pico.workflow-compiler-ledger",
    schemaVersion: 1,
    steps: [],
    projectWrites: [
      { path: "app/a.kt", origin: "fleet-runtime", stepOrder: null, before: null, after: { bytes: 1, sha256: SHA_A } },
      { path: "app/a.kt", origin: "fleet-runtime", stepOrder: null, before: { bytes: 1, sha256: SHA_B }, after: null },
    ],
  };
  mustReject(() => parseSnapshotEnvelope("compiler-ledger", brokenChain));
});

test("canonical value grammar enforces depth 32, finite numbers, and collection bounds", () => {
  let depth32 = null;
  for (let index = 0; index < 31; index += 1) depth32 = { value: depth32 };
  assert.equal(parsePublicResult("pico-build-app", { status: "plan-failed", detail: depth32, fix: "fix" }).status, "plan-failed");
  let depth33 = depth32;
  depth33 = { value: depth33 };
  mustReject(() => parsePublicResult("pico-build-app", { status: "plan-failed", detail: depth33, fix: "fix" }));
  mustReject(() => parsePublicResult("pico-build-app", { status: "plan-failed", detail: NaN, fix: "fix" }));
  mustReject(() => parsePublicResult("pico-build-app", { status: "plan-failed", detail: Array(4097).fill(null), fix: "fix" }));
  mustReject(() => parsePublicResult("pico-build-app", { status: "plan-failed", detail: Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`k${index}`, null])), fix: "fix" }));
  mustReject(() => parsePublicResult("pico-build-app", { status: "plan-failed", detail: null, fix: "x".repeat(64 * 1024 + 1) }));
});

test("build public results accept only workflow-specific strict status shapes", () => {
  assert.equal(parsePublicResult("pico-build-app", { status: "needs-authoring", scaffold: authoredSpec, fix: "author it" }).status, "needs-authoring");
  assert.equal(parsePublicResult("pico-build-app", { status: "plan-failed", detail: null, fix: "fix" }).status, "plan-failed");
  for (const status of ["failed", "built-not-installed", "built-no-capture", "auto-judged-needs-look", "built-needs-look"]) {
    assert.equal(parsePublicResult("pico-build-app", buildWork(status)).status, status);
  }
  mustReject(() => parsePublicResult("pico-build-app", { ...buildWork("built-needs-look"), fix: "cross-status" }));
  mustReject(() => parsePublicResult("pico-build-app", buildWork("failed", { built: true })));
  mustReject(() => parsePublicResult("pico-build-app", buildWork("built-not-installed", { installed: true })));
  mustReject(() => parsePublicResult("pico-build-app", buildWork("built-no-capture", { receiptId: SHA_A })));
  mustReject(() => parsePublicResult("pico-build-app", buildWork("built-needs-look", { receiptPath: null })));
  mustReject(() => parsePublicResult("pico-build-app", { status: "accepted", ...loopCommon() }));
});

test("loop public results accept every exact status arm", () => {
  const buildFailure = { kind: "build", status: "fail", detail: "build failed" };
  const common = loopCommon();
  const cases = [
    { status: "plan-failed", iterations: 0, detail: null, fix: "fix" },
    { ...common, status: "plan-failed", detail: null, fix: "fix" },
    { ...common, status: "budget-exhausted", failing: [buildFailure], fix: "fix" },
    { ...common, status: "accepted", ceiling: "structural", acceptanceScope: "declared criteria", fleetVisualVerdict: "unscored", remainingLookObligation: [], honesty: "structural only" },
    { ...common, status: "built-needs-look", needsLook: [common.iterationsLog[0].outcomes[0]], remainingLookObligation: [], honesty: "look required" },
    { ...common, status: "unmeasurable-acceptance", failing: [buildFailure], fix: "fix" },
    { ...common, status: "no-progress", failing: [buildFailure], fix: "fix" },
    { ...common, status: "failed", failing: [buildFailure], fix: "fix" },
    { ...common, status: "manual-repair-required", failing: [buildFailure], fix: "fix" },
  ];
  for (const value of cases) assert.equal(parsePublicResult("pico-loop", value).status, value.status);
});

test("loop public results reject partial receipt triples, partial perf pairs, wrong order, and cross-status keys", () => {
  const common = loopCommon();
  mustReject(() => parsePublicResult("pico-loop", { ...common, status: "failed", failing: [], fix: "fix", capture: "/tmp/capture.png" }));
  mustReject(() => parsePublicResult("pico-loop", { ...common, status: "failed", failing: [], fix: "fix", perfTrend: [] }));
  mustReject(() => parsePublicResult("pico-loop", { ...common, status: "failed", failing: [], fix: "fix", ceiling: "structural" }));
  mustReject(() => parsePublicResult("pico-loop", { ...common, status: "plan-failed", fix: "fix" }));
  const reordered = structuredClone(common);
  reordered.iterationsLog[0].outcomes = [
    { ...reordered.iterationsLog[0].outcomes[0], inputIndex: 1, criterionDigest: SHA_B },
    reordered.iterationsLog[0].outcomes[0],
  ];
  mustReject(() => parsePublicResult("pico-loop", { ...reordered, status: "failed", failing: [], fix: "fix" }));
  const partitionOrder = structuredClone(common);
  partitionOrder.iterationsLog[0].outcomes = [
    partitionOrder.iterationsLog[0].outcomes[0],
    { ...partitionOrder.iterationsLog[0].outcomes[0], inputIndex: 1, criterionDigest: SHA_B, kind: "logcat" },
  ];
  mustReject(() => parsePublicResult("pico-loop", { ...partitionOrder, status: "failed", failing: [], fix: "fix" }));
  const evidence = structuredClone(common);
  evidence.iterationsLog[0].outcomes[0].recordedEvidence = true;
  mustReject(() => parsePublicResult("pico-loop", { ...evidence, status: "failed", failing: [], fix: "fix" }));
});

test("run head is strict and bounded", () => {
  const head = { kind: "pico.workflow-run-head", schemaVersion: 1, runId: RUN_ID, revision: RUN_REVISION_MAX, revisionId: SHA_A, updatedAt: "2026-08-16T12:00:00.000Z" };
  assert.deepEqual(parseRunHead(head), head);
  mustReject(() => parseRunHead({ ...head, revision: RUN_REVISION_MAX + 1 }));
  mustReject(() => parseRunHead({ ...head, runId: RUN_ID.toUpperCase() }));
  mustReject(() => parseRunHead({ ...head, updatedAt: "2026-08-16T12:00:00Z" }));
  mustReject(() => parseRunHead({ ...head, extra: null }));
});

test("run revision verifies its derived identity and workflow intent shape", () => {
  const build = baseRevision();
  assert.equal(build.revisionId, "bb45b47ab2b30e6688899d0a5602314369cba6f0424143e24d1047d88cb3a405");
  assert.equal(parseRunRevision(build).revisionId, revisionIdOf(build));
  mustReject(() => parseRunRevision({ ...build, createdAt: "2026-08-16T12:00:01.000Z" }));
  const loop = baseRevision({
    workflow: "pico-loop",
    intent: {
      ...baseRevision().intent,
      acceptance: snapshotRef("acceptance", SHA_B),
      budget: { iterations: 3, timeMin: 20, toolCalls: "inert" },
      onFail: "replan",
    },
  });
  assert.equal(parseRunRevision(loop).workflow, "pico-loop");
  mustReject(() => parseRunRevision(refreshRevisionId({ ...build, workflow: "pico-loop" })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...build, storedEvidenceCeiling: "vision_verified" })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...build, storedEvidenceCeiling: "device_verified" })));
  const oversized = structuredClone(build);
  oversized.target.projectLocator.missingSuffix = Array.from({ length: 9 }, (_, index) => `${index}${"x".repeat(60 * 1024)}`);
  oversized.revisionId = revisionIdOf(oversized);
  mustReject(() => parseRunRevision(oversized));
  const longLocator = structuredClone(build);
  longLocator.target.projectLocator.missingSuffix = ["x".repeat(16 * 1024 + 1)];
  mustReject(() => parseRunRevision(refreshRevisionId(longLocator)));
  assert.ok(Buffer.byteLength(canonicalJson(build)) < RUN_REVISION_MAX_BYTES);
});

test("every transition has exactly one lifecycle family", () => {
  const d = diagnostic();
  const cases = [
    [{ type: "created" }, { status: "open", phase: "ready-to-plan", publicStatus: null }],
    [{ type: "spec-authored", previousSpec: SHA_A, currentSpec: SHA_B }, { status: "open", phase: "ready-to-plan", publicStatus: null }],
    [{ type: "spec-amended", previousSpec: null, currentSpec: SHA_B }, { status: "open", phase: "ready-to-plan", publicStatus: null }],
    [{ type: "plan-completed", outcome: "awaiting-authoring", diagnostic: null }, { status: "open", phase: "awaiting-authoring", publicStatus: "needs-authoring" }],
    [{ type: "plan-completed", outcome: "ready-to-build", diagnostic: null }, { status: "open", phase: "ready-to-build", publicStatus: null }],
    [{ type: "plan-completed", outcome: "plan-failed", diagnostic: d }, { status: "paused", publicStatus: "plan-failed" }],
    [{ type: "attempt-started", attemptId: ATTEMPT_ID, phase: "build", iteration: null, generation: absentGeneration, inputs: SHA_A }, { status: "running", phase: "attempt-started", attemptId: ATTEMPT_ID }],
    [{ type: "attempt-in-doubt", attemptId: ATTEMPT_ID, phase: "fleet-build", reason: d, externalMutationDisposition: "possible" }, { status: "running", phase: "attempt-in-doubt", attemptId: ATTEMPT_ID }],
    [{ type: "attempt-paused", attemptId: ATTEMPT_ID, phase: "native-build", publicStatus: "failed", failure: d, externalMutationDisposition: "possible" }, { status: "paused", publicStatus: "failed" }],
    [{ type: "attempt-conflicted", attemptId: ATTEMPT_ID, reason: d, observed: absentGeneration, externalMutationDisposition: "confirmed" }, { status: "blocked", reason: "external-state-conflict", attemptId: ATTEMPT_ID }],
    [{ type: "iteration-completed", attemptId: ATTEMPT_ID, iteration: 1, next: "ready-to-build", externalMutationDisposition: "confirmed" }, { status: "open", phase: "ready-to-build", publicStatus: null }],
    [{ type: "run-terminal", attemptId: ATTEMPT_ID, publicStatus: "built-needs-look", externalMutationDisposition: "confirmed" }, { status: "terminal", publicStatus: "built-needs-look" }],
    [{ type: "policy-terminal", reason: "time-budget-exhausted", publicStatus: "budget-exhausted" }, { status: "terminal", publicStatus: "budget-exhausted" }],
  ];
  for (const [transition, lifecycle] of cases) {
    const revision = transitionRevision(transition, lifecycle);
    assert.equal(parseRunRevision(revision).transition.type, transition.type);
    const wrong = refreshRevisionId({ ...revision, lifecycle: { status: "open", phase: "ready-to-plan", publicStatus: null } });
    if (!["created", "spec-authored", "spec-amended"].includes(transition.type)) mustReject(() => parseRunRevision(wrong));
  }
});

test("transition state matrix requires matching intent, attempt, result, compiler, and iteration fields", () => {
  const d = diagnostic();
  const started = transitionRevision(
    { type: "attempt-started", attemptId: ATTEMPT_ID, phase: "build", iteration: null, generation: absentGeneration, inputs: SHA_A },
    { status: "running", phase: "attempt-started", attemptId: ATTEMPT_ID },
  );
  assert.equal(parseRunRevision(started).transition.type, "attempt-started");
  mustReject(() => parseRunRevision(refreshRevisionId({ ...started, attemptInputs: null })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...started, projectGeneration: { expected: absentGeneration, lastAttempt: null } })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...started, compiler: {
    status: "failed", ledger: null, phase: "compiler", failure: d,
    plannedCount: 1, completedCount: 0, elapsedMs: 1,
    executionDisposition: "definitely-completed",
  } })));

  const inDoubt = transitionRevision(
    { type: "attempt-in-doubt", attemptId: ATTEMPT_ID, phase: "fleet-build", reason: d, externalMutationDisposition: "possible" },
    { status: "running", phase: "attempt-in-doubt", attemptId: ATTEMPT_ID },
  );
  assert.equal(parseRunRevision(inDoubt).compiler.status, "in-doubt");
  mustReject(() => parseRunRevision(refreshRevisionId({ ...inDoubt, compiler: { status: "not-run" } })));
  const wrongAfter = structuredClone(inDoubt);
  wrongAfter.projectGeneration.lastAttempt.after = absentGeneration;
  mustReject(() => parseRunRevision(refreshRevisionId(wrongAfter)));

  const conflicted = transitionRevision(
    { type: "attempt-conflicted", attemptId: ATTEMPT_ID, reason: d, observed: absentGeneration, externalMutationDisposition: "confirmed" },
    { status: "blocked", reason: "external-state-conflict", attemptId: ATTEMPT_ID },
  );
  assert.equal(parseRunRevision(conflicted).transition.type, "attempt-conflicted");
  const attributedConflict = structuredClone(conflicted);
  attributedConflict.projectGeneration.lastAttempt.attribution = { status: "unchanged", compilerLedger: null, receiptId: null };
  mustReject(() => parseRunRevision(refreshRevisionId(attributedConflict)));

  const paused = transitionRevision(
    { type: "attempt-paused", attemptId: ATTEMPT_ID, phase: "native-build", publicStatus: "failed", failure: d, externalMutationDisposition: "possible" },
    { status: "paused", publicStatus: "failed" },
  );
  assert.equal(parseRunRevision(paused).publicResult.kind, "public-result");
  mustReject(() => parseRunRevision(refreshRevisionId({ ...paused, publicResult: null })));
  const noAfter = structuredClone(paused);
  noAfter.projectGeneration.lastAttempt.after = null;
  noAfter.projectGeneration.lastAttempt.attribution = null;
  mustReject(() => parseRunRevision(refreshRevisionId(noAfter)));

  const terminal = transitionRevision(
    { type: "run-terminal", attemptId: ATTEMPT_ID, publicStatus: "built-needs-look", externalMutationDisposition: "confirmed" },
    { status: "terminal", publicStatus: "built-needs-look" },
  );
  assert.equal(parseRunRevision(terminal).compiler.status, "succeeded");
  mustReject(() => parseRunRevision(refreshRevisionId({ ...terminal, publicResult: null })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...terminal, receiptReferences: [] })));

  const awaiting = transitionRevision(
    { type: "plan-completed", outcome: "awaiting-authoring", diagnostic: null },
    { status: "open", phase: "awaiting-authoring", publicStatus: "needs-authoring" },
  );
  assert.equal(parseRunRevision(awaiting).intent.currentSpec.snapshot.sha256, SHA_B);
  mustReject(() => parseRunRevision(refreshRevisionId({ ...awaiting, publicResult: null })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...awaiting, attemptInputs: snapshotRef("external-input") })));

  const authored = transitionRevision(
    { type: "spec-authored", previousSpec: SHA_A, currentSpec: SHA_B },
    { status: "open", phase: "ready-to-plan", publicStatus: null },
  );
  assert.equal(parseRunRevision(authored).intent.currentSpec.snapshot.sha256, SHA_B);
  const wrongSpec = structuredClone(authored);
  wrongSpec.intent.currentSpec.snapshot.sha256 = SHA_A;
  mustReject(() => parseRunRevision(refreshRevisionId(wrongSpec)));
  const oversizedSpecRef = structuredClone(authored);
  oversizedSpecRef.intent.currentSpec.snapshot.bytes = 2 * 1024 * 1024 + 1;
  mustReject(() => parseRunRevision(refreshRevisionId(oversizedSpecRef)));

  const iteration = transitionRevision(
    { type: "iteration-completed", attemptId: ATTEMPT_ID, iteration: 1, next: "ready-to-build", externalMutationDisposition: "confirmed" },
    { status: "open", phase: "ready-to-build", publicStatus: null },
  );
  assert.equal(parseRunRevision(iteration).iteration.status, "blocked");
  mustReject(() => parseRunRevision(refreshRevisionId({ ...iteration, iteration: baseRevision().iteration })));

  const policy = transitionRevision(
    { type: "policy-terminal", reason: "time-budget-exhausted", publicStatus: "budget-exhausted" },
    { status: "terminal", publicStatus: "budget-exhausted" },
  );
  assert.equal(parseRunRevision(policy).workflow, "pico-loop");
  mustReject(() => parseRunRevision(refreshRevisionId({ ...policy, attemptInputs: snapshotRef("external-input") })));
});

test("compiler and iteration strict unions reject impossible pairing fields", () => {
  const base = baseRevision();
  const compilerCases = [
    { status: "not-run" },
    { status: "succeeded", ledger: snapshotRef("compiler-ledger"), plannedCount: 2, completedCount: 2, elapsedMs: 1, executionDisposition: "definitely-completed" },
    { status: "failed", ledger: null, phase: "compiler", failure: diagnostic(), plannedCount: 2, completedCount: 1, elapsedMs: 1, executionDisposition: "definitely-completed" },
    { status: "in-doubt", ledger: null, phase: "fleet-build", reason: diagnostic(), plannedCount: null, completedCount: null, elapsedMs: null, executionDisposition: "in-doubt" },
  ];
  const iterationCases = [
    { status: "not-run", nextIndex: 1, completedCount: 0, previousFailureSignature: null },
    { status: "blocked", index: 1, completedCount: 1, nextIndex: 2, failure: diagnostic(), previousFailureSignature: null, structuralLedger: { status: "not-recorded", reason: diagnostic() } },
    { status: "completed", index: 1, completedCount: 1, nextIndex: 2, outcomes: [], previousFailureSignature: null, perfSamples: [], structuralLedger: { status: "recorded", seq: 0 } },
  ];
  assert.equal(parseRunRevision(baseRevision({ compiler: compilerCases[0] })).compiler.status, "not-run");
  assert.equal(parseRunRevision(baseRevision({ iteration: iterationCases[0] })).iteration.status, "not-run");
  for (const compiler of compilerCases.slice(1)) mustReject(() => parseRunRevision(baseRevision({ compiler })));
  for (const iteration of iterationCases.slice(1)) mustReject(() => parseRunRevision(baseRevision({ iteration })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...base, compiler: { ...compilerCases[0], ledger: null } })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...base, iteration: { ...iterationCases[0], index: 1 } })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...base, compiler: { ...compilerCases[1], completedCount: 3 } })));
  mustReject(() => parseRunRevision(refreshRevisionId({ ...base, iteration: { ...iterationCases[1], nextIndex: 1 } })));
});

test("receipt and auto-event evidence combinations are closed and capped", () => {
  const receipt = { kind: "pico.native-run-receipt", schemaVersion: 1, app: "com.fleet.door238151", receiptId: SHA_A, captureSha256: SHA_B };
  const auto = { kind: "pico.auto-judge-ledger-event", schemaVersion: 1, app: "com.fleet.door238151", seq: 0, eventDigest: SHA_A, receiptId: SHA_A, captureSha256: SHA_B };
  const state = transitionRevision(
    { type: "spec-amended", previousSpec: null, currentSpec: SHA_B },
    { status: "open", phase: "ready-to-plan", publicStatus: null },
  );
  const withEvidence = (overrides) => refreshRevisionId({ ...structuredClone(state), ...overrides });
  assert.equal(parseRunRevision(withEvidence({ receiptReferences: [receipt] })).receiptReferences.length, 1);
  assert.equal(parseRunRevision(withEvidence({ receiptReferences: [receipt], autoJudgeEvidence: auto, storedEvidenceCeiling: "auto_judged" })).storedEvidenceCeiling, "auto_judged");
  mustReject(() => parseRunRevision(withEvidence({ autoJudgeEvidence: auto, storedEvidenceCeiling: "auto_judged" })));
  mustReject(() => parseRunRevision(withEvidence({ receiptReferences: [receipt], autoJudgeEvidence: null, storedEvidenceCeiling: "auto_judged" })));
  mustReject(() => parseRunRevision(withEvidence({ receiptReferences: [receipt, receipt] })));
  mustReject(() => parseRunRevision(withEvidence({ receiptReferences: Array.from({ length: 7 }, (_, index) => ({ ...receipt, receiptId: String(index).padStart(64, "0") })) })));
  mustReject(() => parseRunRevision(baseRevision({ receiptReferences: [receipt] })));
  mustReject(() => parseRunRevision(baseRevision({ receiptReferences: [receipt], autoJudgeEvidence: auto, storedEvidenceCeiling: "auto_judged" })));
});

test("run-control result is exact and status-specific", () => {
  const base = {
    status: "invalid-invocation",
    runId: null,
    revision: null,
    revisionId: null,
    expectedRevision: null,
    actualRevision: null,
    actualRevisionId: null,
    runStateByThisCall: "unchanged",
    externalSideEffectsByThisCall: "none",
    priorAttemptExternalSideEffects: null,
    activeAttemptExternalSideEffects: null,
    inDoubtAttemptCompletion: null,
    runRevisionCommitted: null,
    runRevisionPublication: null,
    expectedGeneration: null,
    observedGeneration: null,
    historicalResult: null,
    issues: [],
    detail: "invalid shape",
    fix: "supply one invocation mode",
  };
  assert.deepEqual(parseRunControlResult(base), base);
  mustReject(() => parseRunControlResult({ ...base, runStateByThisCall: "durably-advanced" }));
  mustReject(() => parseRunControlResult({ ...base, externalSideEffectsByThisCall: "confirmed" }));
  mustReject(() => parseRunControlResult({ ...base, extra: true }));
  mustReject(() => parseRunControlResult({ ...base, historicalResult: { status: "plan-failed", detail: null, fix: "fix" } }));
  mustReject(() => parseRunControlResult({ ...base, expectedRevision: 0 }));
  const conflict = { ...base, status: "revision-conflict", runId: RUN_ID, revision: 2, revisionId: SHA_A, expectedRevision: 1, actualRevision: 2, actualRevisionId: SHA_A };
  assert.equal(parseRunControlResult(conflict).status, "revision-conflict");
  mustReject(() => parseRunControlResult({ ...conflict, actualRevisionId: null }));
  const publication = { ...base, status: "state-write-failed", runId: RUN_ID, revision: 2, revisionId: SHA_A, runStateByThisCall: "publication-in-doubt", runRevisionCommitted: null, runRevisionPublication: "unknown" };
  assert.equal(parseRunControlResult(publication).runRevisionPublication, "unknown");
  mustReject(() => parseRunControlResult({ ...publication, runRevisionCommitted: false, runRevisionPublication: "head-authoritative" }));
  assert.equal(parseRunControlResult({ ...publication, runStateByThisCall: "unchanged", runRevisionCommitted: false, runRevisionPublication: "not-linked" }).runRevisionCommitted, false);
  assert.equal(parseRunControlResult({ ...publication, runStateByThisCall: "durably-advanced", runRevisionCommitted: true, runRevisionPublication: "head-authoritative" }).runRevisionCommitted, true);
});

test("runtime discriminants reject unknown snapshot kinds and workflows", () => {
  mustReject(() => parseSnapshotEnvelope("bogus", { kind: "pico.workflow-public-result", schemaVersion: 1, workflow: "pico-build-app", status: "plan-failed", publicResult: { status: "plan-failed", detail: null, fix: "fix" } }));
  mustReject(() => parsePublicResult("bogus", { status: "plan-failed", iterations: 0, detail: null, fix: "fix" }));
});
