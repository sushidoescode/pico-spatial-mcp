import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeSceneDrift,
  executeQuerySceneAnchors as executeQuerySceneAnchorsRaw,
  exactForegroundComponent,
  normalizedSnapshotId,
  parseSceneBridgePayload,
  querySceneAnchorsOutputSchema,
  writeExternalGeometryArtifact,
} from "../dist/sceneanchors.js";

const agentBridge = await import("../dist/agentbridge.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repoRoot, "test", "fixtures", "sceneanchors", "museum-sweeps.v1.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const APK_SHA = "a".repeat(64);
const RECEIPT_ID = "b".repeat(64);
const REQUEST_ID = "request-id-0001";
const coordinateFrame = { id: "bridge-world-41", units: "metres", handedness: "sdk-reported" };
const defaultPolicy = {
  count: "advisory",
  maxTransformDeltaM: 0.02,
  maxTransformDeltaDeg: 1,
  maxExtentDeltaM: 0.03,
  topology: "strict",
};

test("navigation-guide revision catches an accidental scene-snapshot revision bump or overload", () => {
  assert.equal(agentBridge.AGENT_BRIDGE_SCENE_PAYLOAD_KIND, "pico.agent-bridge.scene-snapshot");
  assert.equal(agentBridge.AGENT_BRIDGE_SCENE_SCHEMA_VERSION, 1);
  assert.equal(agentBridge.AGENT_BRIDGE_SCENE_REVISION, 41);
  assert.equal(agentBridge.AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND, "query_scene_anchors");
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_PAYLOAD_KIND, "pico.agent-bridge.navigation-guide");
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_SCHEMA_VERSION, 1);
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION, 1);
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_COMMAND, "navigation_guide");
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL, "viewer-facing-planar-v1");
  assert.notEqual(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_COMMAND, agentBridge.AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND);
  assert.notEqual(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_CACHE_DIRECTORY, agentBridge.AGENT_BRIDGE_SCENE_SNAPSHOT_CACHE_DIRECTORY);
});

async function executeQuerySceneAnchors(...args) {
  const result = await executeQuerySceneAnchorsRaw(...args);
  const validated = querySceneAnchorsOutputSchema.safeParse(result);
  assert.equal(validated.success, true, validated.success ? "" : JSON.stringify(validated.error.issues));
  return result;
}

function positionOf(matrix) {
  return [matrix[3], matrix[7], matrix[11]];
}

function normalizedAnchor(anchor) {
  return {
    runtimeUuid: anchor.runtimeUuid,
    worldFromAnchor: [...anchor.worldFromAnchor],
    positionM: anchor.positionM ? [...anchor.positionM] : positionOf(anchor.worldFromAnchor),
    rotationQuaternionXyzw: [0, 0, 0, 1],
    boundsM: [...anchor.boundsM],
    vertices: anchor.vertices.flat(),
    indices: [...anchor.indices],
    semanticAssignments: [...anchor.semanticAssignments],
  };
}

function explicitAnchors(caseData, sample) {
  let anchors;
  if (sample.inheritExplicitAnchorsFrom) {
    const inherited = caseData.samples.find((candidate) => candidate.sampleId === sample.inheritExplicitAnchorsFrom);
    anchors = explicitAnchors(caseData, inherited).map((anchor) => structuredClone(anchor));
  } else {
    anchors = (sample.explicitAnchors ?? []).map((anchor) => structuredClone(anchor));
  }
  for (const override of sample.anchorOverrides ?? []) {
    const index = anchors.findIndex((anchor) => anchor.traceId === override.traceId);
    if (override.operation === "remove") {
      assert.notEqual(index, -1, `fixture override target ${override.traceId}`);
      anchors.splice(index, 1);
    } else if (override.operation === "update") {
      assert.notEqual(index, -1, `fixture override target ${override.traceId}`);
      const prior = anchors[index];
      anchors[index] = {
        ...prior,
        ...override,
        traceId: override.replacementTraceId ?? prior.traceId,
        vertices: override.vertices ?? prior.vertices,
        indices: override.indices ?? prior.indices,
        semanticAssignments: override.semanticAssignments ?? prior.semanticAssignments,
      };
      delete anchors[index].operation;
      delete anchors[index].replacementTraceId;
    } else if (override.operation === "add") {
      const added = { ...override };
      delete added.operation;
      anchors.push(added);
    }
  }
  return anchors;
}

function fillerAnchor(label, ordinal, sampleId) {
  const labelOffset = { WALL_ART: 0, TABLE: 20, FLOOR: 40, OTHER: 60 }[label] ?? 80;
  const x = labelOffset + ordinal + 10;
  const z = -10 - labelOffset / 10;
  return {
    traceId: `filler-${label}-${ordinal}`,
    runtimeUuid: `diagnostic-${sampleId}-${label}-${ordinal}`,
    worldFromAnchor: [1, 0, 0, x, 0, 1, 0, 0.1, 0, 0, 1, z, 0, 0, 0, 1],
    positionM: [x, 0.1, z],
    boundsM: [0.4, 0.04, 0.4],
    vertices: [[0, 0, 0], [0.4, 0, 0], [0, 0, 0.4]],
    indices: [0, 1, 2],
    semanticAssignments: label === "OTHER" ? ["WALL"] : [label, label],
  };
}

function expandSample(caseData, sample) {
  const anchors = explicitAnchors(caseData, sample);
  const countLabel = (label) => anchors.filter((anchor) => new Set(anchor.semanticAssignments).has(label)).length;
  for (const [label, wanted] of Object.entries(sample.observedLabelCounts)) {
    const missing = wanted - countLabel(label);
    for (let ordinal = 0; ordinal < missing; ordinal++) anchors.push(fillerAnchor(label, ordinal, sample.sampleId));
  }
  for (let ordinal = 0; anchors.length < sample.observedTotalAnchorCount; ordinal++) {
    anchors.push(fillerAnchor("OTHER", ordinal, sample.sampleId));
  }
  assert.equal(anchors.length, sample.observedTotalAnchorCount, "fixture expander must reach the trace-local sample count");
  return anchors.map(normalizedAnchor);
}

function read(readIndex, anchors, trackingState = "RUNNING") {
  return {
    readIndex,
    queriedAtMonotonicNs: String(10_000 + readIndex),
    trackingState,
    anchorCount: anchors.length,
    anchors,
  };
}

function payload({
  requestId = REQUEST_ID,
  packageName = "com.example.sceneanchors.fixture.mixed",
  stageStyle = "Mixed",
  rootContainer = "stage",
  stageOpen = true,
  reads = [],
  satisfied = true,
  maxRetries = 15,
  pollMs = 1000,
  stabilityReads = 2,
  error = null,
} = {}) {
  return {
    kind: "pico.agent-bridge.scene-snapshot",
    schemaVersion: 1,
    bridgeRevision: 41,
    requestId,
    application: {
      packageName,
      buildIdentity: { kind: "apk-sha256", sha256: APK_SHA },
      observedStageStyle: stageStyle,
      rootContainer,
      stageOpen,
    },
    coordinateFrame,
    readiness: { maxRetries, pollMs, stabilityReads, retries: Math.max(0, reads.length - 1), satisfied },
    reads,
    error,
  };
}

function input(overrides = {}) {
  return {
    serial: "emulator-5554",
    scenario: {
      packageName: "com.example.sceneanchors.fixture.mixed",
      expectedBuildReceiptId: RECEIPT_ID,
      expectedStageStyle: "Mixed",
      expectedRootContainer: "stage",
      sceneDriftPolicy: { ...defaultPolicy },
    },
    labels: ["WALL_ART"],
    maxRetries: 15,
    pollMs: 1000,
    includeGeometry: "lossless_external_artifact",
    stabilityReads: 2,
    ...overrides,
  };
}

function bindingFor(queryInput, startedAtMonotonicNs) {
  return {
    serial: queryInput.serial,
    liveIdentity: {
      serial: queryInput.serial,
      model: "swan_arm64",
      fingerprint: "Pico/swan/fixture:user/test-keys",
      bootQemu: "1",
      bootId: "12345678-1234-4234-8234-123456789abc",
      observedAt: "2026-08-28T12:00:00.000Z",
    },
    captureSource: "agent-bridge-file-pull",
    startedAtMonotonicNs,
    endedAtMonotonicNs: String(BigInt(startedAtMonotonicNs) + 1n),
    packageName: queryInput.scenario.packageName,
    buildReceiptId: queryInput.scenario.expectedBuildReceiptId,
    buildReceiptPath: "/external/receipts/fixture.json",
    apkSha256: APK_SHA,
    foregroundProcess: { packageName: queryInput.scenario.packageName, component: `${queryInput.scenario.packageName}/.platform.LaunchActivity`, pid: 123, pidStartTicks: "456" },
    requestedStageStyle: queryInput.scenario.expectedStageStyle,
    requestedRootContainer: queryInput.scenario.expectedRootContainer,
    effectiveSceneDriftPolicy: { ...queryInput.scenario.sceneDriftPolicy },
  };
}

function fakeGeometry(payloadValue, _exactPayloadBytes, monotonicNs) {
  const bytes = Buffer.from(JSON.stringify(payloadValue));
  return {
    geometryRef: {
      path: "/private/tmp/pico-scene-fixture/scene-41.json",
      sha256: "c".repeat(64),
      bytes: bytes.length,
      schemaVersion: 1,
      coordinateFrameId: payloadValue.coordinateFrame.id,
      units: "metres",
      handedness: "sdk-reported",
      bridgeRevision: 41,
    },
    receipt: {
      action: "publish_geometry",
      status: "applied",
      startedAtMonotonicNs: monotonicNs().toString(),
      endedAtMonotonicNs: monotonicNs().toString(),
      ack: { bytes: bytes.length },
    },
  };
}

function depsFor(payloadValue, options = {}) {
  let clock = 1000n;
  return {
    monotonicNs: () => ++clock,
    requestId: () => REQUEST_ID,
    bindRuntime: async (queryInput, startedAt) => options.bindingFailure
      ? { ok: false, detail: options.bindingFailure, binding: null, actionReceipts: [] }
      : { ok: true, binding: bindingFor(queryInput, startedAt), actionReceipts: [] },
    fetchPayload: async () => options.bridgeFailure
      ? { ok: false, code: "bridge_unavailable", detail: options.bridgeFailure, actionReceipts: [] }
      : { ok: true, bytes: options.rawBytes ?? Buffer.from(JSON.stringify(payloadValue)), actionReceipts: [] },
    writeGeometryArtifact: options.writeGeometryArtifact ?? fakeGeometry,
  };
}

const mixedCase = fixture.cases.find((entry) => entry.id === "mixed-day-reselection-and-wall-art-ambiguity");
const dayA = expandSample(mixedCase, mixedCase.samples[0]);
const dayB = expandSample(mixedCase, mixedCase.samples[1]);
const readyDayPayload = payload({ reads: [read(0, []), read(1, dayA), read(2, dayA)] });

test("Museum fixture expectations are ranges and tolerate re-selection count instability", () => {
  assert.equal(fixture.countSemantics.exactEnvironmentCountAssertionAllowed, false);
  for (const caseData of fixture.cases) {
    const profile = fixture.environmentProfiles[caseData.environmentProfile];
    for (const sample of caseData.samples) {
      assert.ok(sample.observedTotalAnchorCount >= profile.totalAnchorCountRange.min);
      assert.ok(sample.observedTotalAnchorCount <= profile.totalAnchorCountRange.max);
      for (const [label, range] of Object.entries(profile.labelCountRanges)) {
        assert.ok(sample.observedLabelCounts[label] >= range.min, `${sample.sampleId} ${label} lower range`);
        assert.ok(sample.observedLabelCounts[label] <= range.max, `${sample.sampleId} ${label} upper range`);
      }
      assert.equal(sample.expectedCountAssertion.kind, "profile_range");
    }
  }
  assert.notEqual(dayA.length, dayB.length, "re-selection fixture intentionally changes its trace-local count");
  assert.deepEqual(new Set(fixture.cases.map((entry) => entry.application.observedStageStyle)), new Set(["Mixed", "Full"]));
});

test("versioned bridge parser preserves a would-be-truncated per-face assignment payload losslessly", () => {
  const stress = fixture.stressCases[0];
  const assignments = Array.from({ length: stress.anchor.semanticAssignmentsDescriptor.repeatCount }, () => stress.anchor.semanticAssignmentsDescriptor.cycle).flat();
  const faces = stress.anchor.indicesDescriptor.faceCount;
  const stressAnchor = normalizedAnchor({
    ...stress.anchor,
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    indices: Array.from({ length: faces }, () => [0, 1, 2]).flat(),
    semanticAssignments: assignments,
  });
  const bytes = Buffer.from(JSON.stringify(payload({ reads: [read(0, [stressAnchor]), read(1, [stressAnchor])] })));
  assert.ok(Buffer.byteLength(JSON.stringify(assignments)) > stress.expected.serializedSemanticAssignmentsBytesGreaterThan);
  const parsed = parseSceneBridgePayload(bytes);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload.reads[1].anchors[0].semanticAssignments, assignments);
  assert.equal(parsed.payload.reads[1].anchors[0].semanticAssignments.length, stress.expected.expandedSemanticAssignmentCount);
  assert.deepEqual([...new Set(assignments)].sort(), stress.expected.anchorLevelDeduplicatedLabels);
});

test("ready is derived from consecutive unfiltered non-empty reads and returns every ambiguous label match", async () => {
  const result = await executeQuerySceneAnchors(input(), depsFor(readyDayPayload));
  assert.equal(result.status, "ready");
  assert.equal(result.totalAnchorCount, dayA.length);
  assert.ok(result.matchedAnchorCount >= mixedCase.ambiguityExpectation.minimumSameLabelCandidates);
  assert.equal(result.anchors.length, result.matchedAnchorCount);
  assert.ok(result.anchors.every((anchor) => anchor.labels.includes("WALL_ART")));
  for (const anchor of result.anchors) {
    assert.deepEqual(anchor.labels, [...new Set(anchor.labels)].sort(), "anchor-level labels are unique and sorted");
  }
  assert.ok(result.anchors.every((anchor) => anchor.semanticAssignments.alignment === "unverified"));
  assert.ok(result.anchors.every((anchor) => anchor.semanticAssignments.relationEligible === false));
  assert.ok(result.anchors.every((anchor) => anchor.runtimeUuidRole === "diagnostic_only"));
  assert.equal(result.semanticRelationPolicy.triangleRelations, "refused");
  assert.equal(result.evidenceCeiling, "structural");
});

test("Full-space fixture also returns every same-label candidate instead of hiding ambiguity", async () => {
  const fullCase = fixture.cases.find((entry) => entry.id === "full-night-update-removal-and-policy-drift");
  const anchors = expandSample(fullCase, fullCase.samples[0]);
  const queryInput = input({
    scenario: {
      packageName: fullCase.application.packageName,
      expectedBuildReceiptId: RECEIPT_ID,
      expectedStageStyle: "Full",
      expectedRootContainer: "stage",
      sceneDriftPolicy: { ...fullCase.sceneDriftPolicy },
    },
    labels: [fullCase.ambiguityExpectation.label],
  });
  const fullPayload = payload({
    packageName: fullCase.application.packageName,
    stageStyle: "Full",
    reads: [read(0, anchors), read(1, anchors)],
  });
  const result = await executeQuerySceneAnchors(queryInput, depsFor(fullPayload));
  assert.equal(result.status, fullCase.ambiguityExpectation.queryStatus);
  assert.ok(result.matchedAnchorCount >= fullCase.ambiguityExpectation.minimumSameLabelCandidates);
  assert.equal(result.anchors.length, result.matchedAnchorCount);
  assert.ok(result.anchors.every((anchor) => anchor.labels.includes(fullCase.ambiguityExpectation.label)));
});

test("label filtering occurs after readiness, producing label_absent instead of not_ready", async () => {
  const result = await executeQuerySceneAnchors(input({ labels: ["NONEXISTENT_FIXTURE_LABEL"] }), depsFor(readyDayPayload));
  assert.equal(result.status, "label_absent");
  assert.equal(result.totalAnchorCount, dayA.length);
  assert.equal(result.matchedAnchorCount, 0);
  assert.ok(result.snapshotId);
  assert.ok(result.geometryRef);
});

test("not_ready is returned when RUNNING reads never establish an unfiltered non-empty streak", async () => {
  const empty = payload({ reads: [read(0, []), read(1, []), read(2, [])], satisfied: false, error: { code: "not_ready", detail: "budget exhausted" } });
  const result = await executeQuerySceneAnchors(input(), depsFor(empty));
  assert.equal(result.status, "not_ready");
  assert.equal(result.trackingState, "RUNNING");
  assert.equal(result.queriedAtMonotonicNs, "10002");
  assert.equal(result.totalAnchorCount, 0);
});

test("stage_not_open is a distinct terminal status", async () => {
  const unopened = payload({ stageOpen: false, reads: [], satisfied: false, error: { code: "stage_not_open", detail: "Stage is closed" } });
  const result = await executeQuerySceneAnchors(input(), depsFor(unopened));
  assert.equal(result.status, "stage_not_open");
  assert.match(result.error.detail, /closed/);
});

test("stage_mismatch is returned from the app-observed style, never inferred from the scenario", async () => {
  const full = payload({ stageStyle: "Full", reads: [read(0, dayA), read(1, dayA)] });
  const result = await executeQuerySceneAnchors(input(), depsFor(full));
  assert.equal(result.status, "stage_mismatch");
  assert.equal(result.applicationRuntimeBinding.observedStageStyle, "Full");
});

test("bridge_unavailable retains the resolved application binding and transport refusal", async () => {
  const result = await executeQuerySceneAnchors(input(), depsFor(null, { bridgeFailure: "nonce payload never appeared" }));
  assert.equal(result.status, "bridge_unavailable");
  assert.equal(result.applicationRuntimeBinding.serial, "emulator-5554");
  assert.match(result.error.detail, /never appeared/);
});

test("invalid_payload covers malformed bytes and contradictory producer readiness", async (t) => {
  await t.test("malformed JSON", async () => {
    const result = await executeQuerySceneAnchors(input(), depsFor(null, { rawBytes: Buffer.from("MESH| truncated geometry line") }));
    assert.equal(result.status, "invalid_payload");
    assert.match(result.error.detail, /valid JSON/);
  });
  await t.test("contradictory readiness", async () => {
    const contradictory = payload({ reads: [read(0, dayA), read(1, dayA)], satisfied: false });
    const result = await executeQuerySceneAnchors(input(), depsFor(contradictory));
    assert.equal(result.status, "invalid_payload");
    assert.match(result.error.detail, /contradicts/);
  });
  await t.test("not_ready error after a satisfied streak", async () => {
    const contradictory = payload({
      reads: [read(0, dayA), read(1, dayA)],
      satisfied: true,
      error: { code: "not_ready", detail: "impossible terminal" },
    });
    const result = await executeQuerySceneAnchors(input(), depsFor(contradictory));
    assert.equal(result.status, "invalid_payload");
    assert.match(result.error.detail, /not_ready after satisfying/);
  });
  await t.test("stage_not_open error while Stage is open", async () => {
    const contradictory = payload({
      reads: [],
      satisfied: false,
      error: { code: "stage_not_open", detail: "impossible terminal" },
    });
    const result = await executeQuerySceneAnchors(input(), depsFor(contradictory));
    assert.equal(result.status, "invalid_payload");
    assert.match(result.error.detail, /stage_not_open while/);
  });
  await t.test("read trace retries, ordering, and time are versioned invariants", async () => {
    const corruptions = [
      { mutate: (value) => { value.readiness.retries = 99; }, expected: /retries/ },
      { mutate: (value) => { value.reads[1].readIndex = 7; }, expected: /out of sequence/ },
      { mutate: (value) => { value.reads[1].queriedAtMonotonicNs = "1"; }, expected: /moves backwards/ },
      {
        mutate: (value) => {
          const matrix = value.reads[1].anchors[0].worldFromAnchor;
          [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]] =
            [0, -1, 0, 1, 0, 0, 0, 0, 1];
        },
        expected: /rotationQuaternionXyzw contradicts/,
      },
    ];
    for (const corruption of corruptions) {
      const corrupted = structuredClone(payload({ reads: [read(0, dayA), read(1, dayA)] }));
      corruption.mutate(corrupted);
      const result = await executeQuerySceneAnchors(input(), depsFor(corrupted));
      assert.equal(result.status, "invalid_payload");
      assert.match(result.error.detail, corruption.expected);
    }
  });
  await t.test("reads after first readiness satisfaction are rejected", async () => {
    const late = payload({ reads: [read(0, dayA), read(1, dayA), read(2, dayA)] });
    const result = await executeQuerySceneAnchors(input(), depsFor(late));
    assert.equal(result.status, "invalid_payload");
    assert.match(result.error.detail, /reads after/);
  });
  await t.test("coordinate frame is pinned to bridge revision 41", async () => {
    const wrongFrame = structuredClone(readyDayPayload);
    wrongFrame.coordinateFrame.id = "unrelated-frame";
    const result = await executeQuerySceneAnchors(input(), depsFor(wrongFrame));
    assert.equal(result.status, "invalid_payload");
    assert.match(result.error.detail, /coordinateFrame\.id/);
  });
});

test("binding_failed stops before bridge fetch", async () => {
  let fetched = false;
  const dependencies = depsFor(null, { bindingFailure: "receipt serial mismatch" });
  dependencies.fetchPayload = async () => { fetched = true; throw new Error("must not fetch"); };
  const result = await executeQuerySceneAnchors(input(), dependencies);
  assert.equal(result.status, "binding_failed");
  assert.equal(fetched, false);
});

test("bridge-reported missing root identity is binding_failed and persists no geometry", async () => {
  let published = false;
  const missingRoot = payload({
    rootContainer: null,
    stageOpen: false,
    reads: [],
    satisfied: false,
    error: { code: "binding_failed", detail: "root identity absent" },
  });
  const dependencies = depsFor(missingRoot, {
    writeGeometryArtifact: () => { published = true; throw new Error("must not publish"); },
  });
  const result = await executeQuerySceneAnchors(input(), dependencies);
  assert.equal(result.status, "binding_failed");
  assert.equal(result.geometryRef, null);
  assert.equal(published, false);
});

test("foreground binding tolerates a foreign OS shell but refuses same-package ambiguity", () => {
  const packageName = "com.example.sceneanchors.fixture.mixed";
  const expected = `${packageName}/.platform.LaunchActivity`;
  const shell = "com.pxr.scenarioprovider/com.unity3d.player.UnityPlayerActivity";
  const line = (component, id) => `topResumedActivity=ActivityRecord{${id} u0 ${component} t8}`;
  assert.equal(exactForegroundComponent(`${line(expected, "a")}\n${line(shell, "b")}`, packageName), expected);
  assert.equal(exactForegroundComponent(`${line(expected, "a")}\n${line(`${packageName}/.OtherActivity`, "b")}`, packageName), null);
  assert.equal(exactForegroundComponent(line(shell, "a"), packageName), null);
});

test("normalized snapshot hashes ignore bounded float formatting jitter while exact drift still reports it", () => {
  const before = read(0, [structuredClone(dayA[0])]);
  const afterAnchor = structuredClone(dayA[0]);
  afterAnchor.positionM[0] += 0.0000001;
  afterAnchor.worldFromAnchor[3] += 0.0000001;
  afterAnchor.vertices[0] += 0.0000001;
  afterAnchor.runtimeUuid = "diagnostic-runtime-reselected";
  const after = read(1, [afterAnchor]);
  assert.equal(normalizedSnapshotId(before, coordinateFrame), normalizedSnapshotId(after, coordinateFrame));
  const drift = computeSceneDrift(before, after, coordinateFrame, defaultPolicy);
  assert.equal(drift.exactSnapshotChanged, true);
  assert.equal(drift.withinPolicy, true);
  assert.ok(drift.maxTransformDeltaM > 0);

  const positiveZeroAnchor = structuredClone(dayA[0]);
  const negativeZeroAnchor = structuredClone(dayA[0]);
  positiveZeroAnchor.vertices[2] = 0;
  negativeZeroAnchor.vertices[2] = -0;
  assert.equal(normalizedSnapshotId(read(0, [positiveZeroAnchor]), coordinateFrame), normalizedSnapshotId(read(1, [negativeZeroAnchor]), coordinateFrame));
  assert.equal(computeSceneDrift(read(0, [positiveZeroAnchor]), read(1, [negativeZeroAnchor]), coordinateFrame, defaultPolicy).exactSnapshotChanged, true);

  positiveZeroAnchor.runtimeUuid = "diagnostic-positive-zero";
  negativeZeroAnchor.runtimeUuid = "diagnostic-negative-zero";
  const reordered = computeSceneDrift(
    read(0, [positiveZeroAnchor, negativeZeroAnchor]),
    read(1, [negativeZeroAnchor, positiveZeroAnchor]),
    coordinateFrame,
    defaultPolicy,
  );
  assert.equal(reordered.exactSnapshotChanged, false, "exact multiset identity must not depend on runtime anchor order");
});

test("float normalization is hash-only and does not determine trace-local ordering", async () => {
  const lower = structuredClone(dayA[0]);
  const upper = structuredClone(dayA[0]);
  lower.runtimeUuid = "diagnostic-lower";
  upper.runtimeUuid = "diagnostic-upper";
  lower.positionM[0] = 0.00000011;
  lower.worldFromAnchor[3] = 0.00000011;
  upper.positionM[0] = 0.00000012;
  upper.worldFromAnchor[3] = 0.00000012;
  const first = await executeQuerySceneAnchors(input(), depsFor(payload({ reads: [read(0, [upper, lower]), read(1, [upper, lower])] })));
  const second = await executeQuerySceneAnchors(input(), depsFor(payload({ reads: [read(0, [lower, upper]), read(1, [lower, upper])] })));
  assert.equal(first.snapshotId, second.snapshotId);
  assert.deepEqual(first.anchors.map((anchor) => anchor.worldFromAnchor[3]), [0.00000011, 0.00000012]);
  assert.deepEqual(second.anchors.map((anchor) => anchor.worldFromAnchor[3]), [0.00000011, 0.00000012]);
});

test("fixture-driven drift reports exact change and policy-bounded count/transform/extent/topology deltas", () => {
  const fullCase = fixture.cases.find((entry) => entry.id === "full-night-update-removal-and-policy-drift");
  const before = read(0, expandSample(fullCase, fullCase.samples[0]));
  const after = read(1, expandSample(fullCase, fullCase.samples[1]));
  const drift = computeSceneDrift(before, after, coordinateFrame, fullCase.sceneDriftPolicy);
  assert.equal(drift.exactSnapshotChanged, fullCase.expectedDrift.exactChanged);
  assert.equal(drift.countDelta, fullCase.expectedDrift.countDelta);
  assert.ok(
    Math.abs(drift.maxTransformDeltaM - fullCase.expectedDrift.maxTransformDeltaM) < 1e-9,
    `transform delta ${drift.maxTransformDeltaM} did not match ${fullCase.expectedDrift.maxTransformDeltaM}: ${JSON.stringify(drift)}`,
  );
  assert.ok(Math.abs(drift.maxTransformDeltaDeg - fullCase.expectedDrift.maxTransformDeltaDeg) < 1e-9);
  assert.ok(Math.abs(drift.maxExtentDeltaM - fullCase.expectedDrift.maxExtentDeltaM) < 1e-9);
  assert.ok(drift.topologyChanges > 0);
  assert.equal(drift.withinPolicy, fullCase.expectedDrift.withinPolicy);
  assert.ok(drift.deltas.some((delta) => delta.metric === "anchor_count" && delta.policy === "advisory"));
  assert.ok(drift.deltas.some((delta) => delta.metric === "unmatched_anchors"));
});

test("strict topology detects same-length index connectivity changes", () => {
  const beforeAnchor = structuredClone(dayA[0]);
  const afterAnchor = structuredClone(dayA[0]);
  afterAnchor.runtimeUuid = "diagnostic-connectivity-change";
  afterAnchor.indices = [1, 0, 2, 0, 2, 3];
  const drift = computeSceneDrift(read(0, [beforeAnchor]), read(1, [afterAnchor]), coordinateFrame, defaultPolicy);
  assert.equal(drift.exactSnapshotChanged, true);
  assert.equal(drift.topologyChanges, 1);
  assert.equal(drift.withinPolicy, false);
});

test("advisory topology cannot hide a transform beyond the numeric policy", () => {
  const beforeAnchor = structuredClone(dayA[0]);
  const afterAnchor = structuredClone(dayA[0]);
  afterAnchor.runtimeUuid = "diagnostic-far-move";
  afterAnchor.positionM[0] += 10;
  afterAnchor.worldFromAnchor[3] += 10;
  const policy = { ...defaultPolicy, topology: "advisory" };
  const drift = computeSceneDrift(read(0, [beforeAnchor]), read(1, [afterAnchor]), coordinateFrame, policy);
  assert.equal(drift.maxTransformDeltaM, 10);
  assert.equal(drift.withinPolicy, false);
});

test("geometric re-match exposes label swaps under strict and advisory topology policies", () => {
  const at = (template, runtimeUuid, x, label) => {
    const anchor = structuredClone(template);
    anchor.runtimeUuid = runtimeUuid;
    anchor.positionM[0] = x;
    anchor.worldFromAnchor[3] = x;
    anchor.semanticAssignments = [label, label];
    return anchor;
  };
  const before = read(0, [
    at(dayA[0], "diagnostic-before-left", 0, "TABLE"),
    at(dayA[0], "diagnostic-before-right", 0.001, "WALL_ART"),
  ]);
  const after = read(1, [
    at(dayA[0], "diagnostic-after-left", 0, "WALL_ART"),
    at(dayA[0], "diagnostic-after-right", 0.001, "TABLE"),
  ]);
  const strict = computeSceneDrift(before, after, coordinateFrame, defaultPolicy);
  assert.equal(strict.labelSetChanges, 2);
  assert.equal(strict.maxTransformDeltaM, 0);
  assert.equal(strict.withinPolicy, false);
  const advisory = computeSceneDrift(before, after, coordinateFrame, { ...defaultPolicy, topology: "advisory" });
  assert.equal(advisory.labelSetChanges, 2);
  assert.equal(advisory.maxTransformDeltaM, 0);
  assert.equal(advisory.withinPolicy, true);
});

test("multi-read readiness drift retains an earlier policy violation", async () => {
  const moved = structuredClone(dayA[0]);
  moved.runtimeUuid = "diagnostic-moved";
  moved.positionM[0] += 10;
  moved.worldFromAnchor[3] += 10;
  const quiet = structuredClone(moved);
  quiet.runtimeUuid = "diagnostic-quiet";
  quiet.positionM[0] += 0.001;
  quiet.worldFromAnchor[3] += 0.001;
  const reads = [read(0, [dayA[0]]), read(1, [moved]), read(2, [quiet])];
  const result = await executeQuerySceneAnchors(
    input({ stabilityReads: 3 }),
    depsFor(payload({ reads, stabilityReads: 3 })),
  );
  assert.equal(result.status, "ready");
  assert.equal(result.drift.withinPolicy, false);
  assert.equal(result.drift.maxTransformDeltaM, 10);
  assert.equal(result.drift.deltas.filter((delta) => delta.metric === "anchor").length, 2);
});

test("geometric re-match reports equidistant ambiguity instead of choosing silently", () => {
  const beforeAnchor = structuredClone(dayA[0]);
  const candidateA = structuredClone(dayA[0]);
  const candidateB = structuredClone(dayA[0]);
  candidateA.runtimeUuid = "diagnostic-ambiguous-a";
  candidateB.runtimeUuid = "diagnostic-ambiguous-b";
  const drift = computeSceneDrift(read(0, [beforeAnchor]), read(1, [candidateA, candidateB]), coordinateFrame, defaultPolicy);
  assert.equal(drift.ambiguities.length, 1);
  assert.deepEqual(drift.ambiguities[0].candidateCurrentIndices, [0, 1]);
  assert.equal(drift.withinPolicy, false);
});

test("quaternion drift arithmetic reports degrees and enforces its numeric bound", () => {
  const beforeAnchor = structuredClone(dayA[0]);
  const afterAnchor = structuredClone(dayA[0]);
  afterAnchor.runtimeUuid = "diagnostic-quarter-turn";
  afterAnchor.rotationQuaternionXyzw = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const drift = computeSceneDrift(read(0, [beforeAnchor]), read(1, [afterAnchor]), coordinateFrame, {
    ...defaultPolicy,
    maxTransformDeltaDeg: 45,
  });
  assert.ok(Math.abs(drift.maxTransformDeltaDeg - 90) < 1e-9);
  assert.equal(drift.withinPolicy, false);
});

test("raw geometry is published to a private external session artifact with lossless semantics", async (t) => {
  const sessions = [];
  t.after(() => sessions.forEach((session) => fs.rmSync(session, { recursive: true, force: true })));
  const exactPayloadBytes = Buffer.from(JSON.stringify(readyDayPayload).replace('"vertices":[-0.7', '"vertices":[-0'));
  assert.match(exactPayloadBytes.toString("utf8"), /"vertices":\[-0,/);
  const result = await executeQuerySceneAnchors(input(), depsFor(readyDayPayload, {
    rawBytes: exactPayloadBytes,
    writeGeometryArtifact: (payloadValue, rawBytes, monotonicNs) => {
      const published = writeExternalGeometryArtifact(payloadValue, rawBytes, monotonicNs);
      sessions.push(path.dirname(published.geometryRef.path));
      return published;
    },
  }));
  assert.equal(result.status, "ready");
  assert.equal(path.isAbsolute(result.geometryRef.path), true);
  assert.equal(result.geometryRef.path.startsWith(`${repoRoot}${path.sep}`), false);
  const artifactBytes = fs.readFileSync(result.geometryRef.path);
  assert.equal(result.geometryRef.sha256.length, 64);
  assert.equal(result.geometryRef.bytes, artifactBytes.length);
  assert.equal(fs.statSync(result.geometryRef.path).mode & 0o777, 0o600);
  assert.deepEqual(artifactBytes, exactPayloadBytes, "geometry artifact must preserve exact bridge bytes, including lexical -0");
  const artifact = JSON.parse(artifactBytes);
  assert.deepEqual(artifact.reads[1].anchors[0].semanticAssignments, readyDayPayload.reads[1].anchors[0].semanticAssignments);
});
