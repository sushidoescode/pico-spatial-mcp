import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { makePng } from "./helpers/runreceipt-fixture.mjs";
import * as boundaryExperiment from "../dist/boundaryexperiment.js";

import {
  BoundaryPreparationFailure,
  BoundarySystemHomeError,
  boundaryExperimentInputSchema,
  canonicalBoundaryRouteScript,
  classifyBoundaryForegrounds,
  clearBoundarySystemHome,
  classifyActivityLaunchDisposition,
  createBoundaryExperimentOrchestrator,
  deriveBoundaryRouteOutcome,
  executeBoundaryRecoveryProtocol,
  hasExactDynamicOpenSequence,
  minimumRecoveryReserveMs,
  parseResumedPackages,
  parseThirdPartyPackages,
  readBoundReviewImage,
  readReceiptBoundEffectiveAppSpec,
  redactCapabilityFromLogArtifact,
  recoveryContinuityMatchesBinding,
  recoveryFrameMatchesExpected,
  recoveryReboundTupleChanged,
  recoveryStepExecutionBudgetMs,
  resolveCalibrationRouteRef,
  runWithFinalizedLog,
  scopeContinuityLogLines,
  shouldIncludeDynamicReopen,
  waypointPreflightAllowsMovement,
} from "../dist/boundaryexperiment.js";
import { formatBoundaryProbeEventV1 } from "../dist/runtimecontinuity.js";

const SERIAL = "emulator-5554";
const BOOT_ID = "12345678-1234-4234-8234-123456789abc";
const APK_SHA = "a".repeat(64);
const RECEIPT_ID = "b".repeat(64);
const PACKAGE = "com.fleet.boundarylabmixed";
const COMPONENT = `${PACKAGE}/.platform.LaunchActivity`;
const CLAIMSIGHT_APK_SHA = "7ecce31ec0a5ede24c88e97e0aca2ec82dc467f0a639402661b5749ee5678bbf";
const GATES = [1, 2, 4, 8, 16, 32];
const HEALTH_SHA = "6".repeat(64);
const M0_EFFECTIVE_SPEC_SHA = "b6443a1a679845613c2d6b974f7b1546deafbcda600c6ee460109615631c49ca";

function fakeM0ReceiptReader(app, receiptId) {
  return {
    status: "valid",
    receipt: {
      receiptId,
      app,
      source: { effectiveAppSpec: { sha256: M0_EFFECTIVE_SPEC_SHA } },
      apk: { packageName: app, sha256: APK_SHA },
      install: { packageName: app, remoteApkSha256: APK_SHA },
      runtime: { serial: SERIAL, component: `${app}/.platform.LaunchActivity` },
    },
  };
}

function fakeLogArtifact(sha256 = HEALTH_SHA) {
  return { rawArtifact: { path: path.join(os.tmpdir(), `${sha256}.log`), sha256, bytes: 1 } };
}

function quietRuntimeHealth(packageName = PACKAGE, sourceSha256 = HEALTH_SHA) {
  return {
    schemaVersion: 1,
    sourceSha256,
    packageName,
    expectedPids: [4242],
    marker: "test_marker",
    markerOccurrences: 1,
    status: "no_attributed_failure",
    incidents: [],
    ambiguousCandidateCount: 0,
    ignoredOtherPackageCount: 0,
    scannedBytes: 1,
    tagInventory: [],
  };
}

function failedRuntimeHealth(packageName = PACKAGE, sourceSha256 = HEALTH_SHA) {
  return {
    ...quietRuntimeHealth(packageName, sourceSha256),
    status: "attributed_failure",
    incidents: [{ kind: "anr", attribution: "exact_package", pid: 4242, firstLine: 2, evidenceSha256: "8".repeat(64) }],
  };
}

const budgets = {
  maxActions: 12,
  maxWaypoints: 6,
  maxHoldMsPerAction: 5_000,
  maxDragPxPerAction: 360,
  maxCumulativeHoldMs: 12_000,
  maxCumulativeDragPx: 720,
  maxDurationMs: 600_000,
  recoveryReserveMs: 525_000,
};

const capturePolicy = {
  maxTries: 4,
  intervalMs: 10,
  attemptTimeoutMs: 3_000,
  comparison: "byte_exact",
};

function scenario(entryRoute = "manifest_mixed") {
  if (entryRoute === "dynamic_full") {
    const dynamicPackage = "com.fleet.boundarylabdynamicfull";
    return {
      id: "boundarylab-dynamic-full",
      packageName: dynamicPackage,
      launchComponent: `${dynamicPackage}/.platform.LaunchActivity`,
      allowedResumedComponents: [`${dynamicPackage}/.platform.LaunchActivity`],
      entryRoute,
      expectedManifestStageStyle: "Mixed",
      requestedDynamicStageStyle: "Full",
      dynamicEntry: {
        receiverComponent: `${dynamicPackage}/.agent.BoundaryProbeReceiver`,
        action: `${dynamicPackage}.BOUNDARY_PROBE`,
        stageId: "dynamic-full",
        requireSessionCapability: true,
        expectedAcks: ["command_received", "stage_open_requested", "stage_open_returned"],
      },
    };
  }
  if (entryRoute === "manifest_full") {
    const fullPackage = "com.fleet.boundarylabmanifestfull";
    return {
      id: "boundarylab-manifest-full",
      packageName: fullPackage,
      launchComponent: `${fullPackage}/.platform.LaunchActivity`,
      allowedResumedComponents: [`${fullPackage}/.platform.LaunchActivity`],
      entryRoute,
      expectedManifestStageStyle: "Full",
    };
  }
  return {
    id: "boundarylab-mixed",
    packageName: PACKAGE,
    launchComponent: COMPONENT,
    allowedResumedComponents: [COMPONENT],
    entryRoute,
    expectedManifestStageStyle: "Mixed",
  };
}

function editorScenario() {
  return {
    id: "claimsight-e1",
    packageName: "com.example.claimsight",
    launchComponent: "com.example.claimsight/.platform.LaunchActivity",
    allowedResumedComponents: ["com.example.claimsight/.platform.LaunchActivity"],
    entryRoute: "editor_manifest_full",
    expectedManifestStageStyle: "Full",
  };
}

function waypoints(count = 6) {
  return GATES.slice(0, count).map((targetGateM, index) => ({
    seq: index + 1,
    targetGateM,
    actions: [{ kind: "key_hold", key: "w", holdMs: 100 * (index + 1) }],
  }));
}

function route(source = { kind: "calibration_seed", waypoints: waypoints() }) {
  return {
    direction: "forward",
    speedProfile: "staircase",
    requiredTraversalM: 32,
    gateSequenceM: GATES,
    source,
    budgets,
  };
}

const dummyReplaySource = {
  kind: "replay",
  calibrationRouteRef: {
    absolutePath: path.join(os.tmpdir(), "phase1-m0-route-script.json"),
    routeScriptSha256: "d".repeat(64),
    sourceRunManifestSha256: "e".repeat(64),
    sourceAdjudicationSha256: "f".repeat(64),
  },
};

function prepareInput(artifactRoot, overrides = {}) {
  return {
    action: "prepare",
    serial: SERIAL,
    scenario: scenario(),
    provenance: { kind: "native_run_receipt", receiptId: RECEIPT_ID, apkSha256: APK_SHA },
    artifactRoot,
    route: route(),
    capture: capturePolicy,
    ...overrides,
  };
}

function capture(sha256, capturePath, role) {
  return {
    role,
    path: capturePath,
    sha256,
    bytes: 128,
    width: 16,
    height: 8,
    settled: true,
    receipt: { status: "settled", settlementSatisfied: true, lookRequired: true },
  };
}

function continuity(overrides = {}) {
  return {
    observedAtMonotonicNs: "100",
    serial: SERIAL,
    bootId: BOOT_ID,
    packageName: PACKAGE,
    allowedResumedComponents: [COMPONENT],
    apkSha256: APK_SHA,
    pid: 4242,
    pidStartTicks: "9001",
    resumedComponents: [COMPONENT],
    foreground: "exact_allowed",
    probeEventsSincePrior: [],
    probeParse: "absent",
    probeSequence: "unknown",
    watchdog: { status: "absent" },
    ...overrides,
  };
}

function attestation(captureSha256, visibleState = "boundarylab_mixed", overrides = {}) {
  return {
    captureSha256,
    visibleState,
    sentinels: visibleState.startsWith("boundarylab_") ? ["MANIFEST MIXED ROOT"] : [],
    attestation: `LOOKed exact ${visibleState} frame`,
    ...overrides,
  };
}

function fakeDependencies() {
  const calls = { prepare: [], recapture: [], waypoint: [], recover: [] };
  let waypointOrdinal = 0;
  return {
    calls,
    deps: {
      randomBytes: () => Buffer.alloc(32, 7),
      now: () => "2026-08-31T12:00:00.000Z",
      monotonicNs: (() => { let value = 1000n; return () => ++value; })(),
      readNativeRunReceipt: fakeM0ReceiptReader,
      readReviewImage: () => Buffer.alloc(0),
      collectPreparation: async (context) => {
        calls.prepare.push(context);
        const dynamic = context.input.scenario.entryRoute === "dynamic_full";
        return {
          runtimeBinding: {
            serial: SERIAL,
            bootId: BOOT_ID,
            grpc: { discoveryFile: "/tmp/pico-emulator/pid_93013.ini", qemuPid: 93013, address: "127.0.0.1:8554" },
            qemuWindow: { ownerPid: 93013, windowId: 7 },
          },
          applicationBinding: {
            packageName: context.input.scenario.packageName,
            apkSha256: context.input.provenance.apkSha256,
            allowedResumedComponents: context.input.scenario.allowedResumedComponents,
            pid: 4242,
            pidStartTicks: "9001",
          },
          homeReference: capture("1".repeat(64), context.capturePaths.homeReference, "home_reference"),
          appBaseline: capture("2".repeat(64), context.capturePaths.appBaseline, "app_baseline"),
          continuity: [continuity({
            packageName: context.input.scenario.packageName,
            allowedResumedComponents: context.input.scenario.allowedResumedComponents,
            resumedComponents: context.input.scenario.allowedResumedComponents,
            ...(dynamic ? {
              probeParse: "ok",
              probeSequence: "complete",
              probeEventsSincePrior: [
                { kind: "command_received" },
                { kind: "stage_open_requested" },
                { kind: "stage_open_returned" },
              ],
            } : {}),
          })],
          logArtifact: fakeLogArtifact(),
          runtimeHealth: quietRuntimeHealth(context.input.scenario.packageName),
          probe: dynamic
            ? { sessionId: "12345678-1234-4234-8234-123456789abc", generation: 1, capabilitySha256: "c".repeat(64) }
            : { sessionId: null, generation: null, capabilitySha256: null },
        };
      },
      recaptureReviewedFrame: async (context) => {
        calls.recapture.push(context);
        return { matches: true, sha256: context.expectedSha256, continuity: continuity() };
      },
      executeWaypoint: async (context) => {
        calls.waypoint.push(context);
        const preflight = await context.recaptureReviewedFrame();
        waypointOrdinal += 1;
        const sha256 = (waypointOrdinal + 2).toString(16).repeat(64);
        if (!preflight.matches || preflight.sha256 !== context.state.lastRequiredHash) {
          return {
            preflight,
            routeTrace: {
              status: "binding_lost",
              waypoints: [],
              usage: { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 1 },
              preMovementReviewDrift: true,
            },
            capture: capture(sha256, context.capturePath, "transition"),
            continuity: [preflight.continuity],
            logArtifact: fakeLogArtifact(),
            runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
          };
        }
        return {
          preflight,
          routeTrace: {
            status: "controller_stop",
            waypoints: [{
              seq: 1,
              actions: context.waypoint.actions,
              actionReceipts: context.waypoint.actions.map((action) => ({
                action: action.kind,
                status: "applied",
                serial: SERIAL,
                ack: action.kind === "key_hold" ? { releaseCertain: true } : {},
              })),
              continuityBefore: { kind: "sampled", sample: continuity() },
              settle: { status: "settled", settlementSatisfied: true, sha256 },
              continuityAfter: { kind: "sampled", sample: continuity() },
            }],
            usage: {
              actions: context.waypoint.actions.length,
              waypoints: 1,
              holdMs: context.waypoint.actions.reduce((sum, action) => sum + (action.kind === "key_hold" ? action.holdMs : 0), 0),
              dragPx: 0,
              durationMs: 100,
            },
          },
          capture: capture(sha256, context.capturePath, "waypoint"),
          continuity: [continuity(), continuity()],
          logArtifact: fakeLogArtifact(),
          runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
        };
      },
      executeRecoveryStep: async (context) => {
        calls.recover.push(context);
        const hashes = {
          observe: ["a", "b"],
          reopen_stage: ["d", "e"],
          activity_launch: ["c", "f"],
          force_stop_relaunch: ["8", "9"],
        }[context.kind];
        return {
          kind: context.kind,
          structuralOk: context.kind === "activity_launch" || context.kind === "reopen_stage" || context.kind === "force_stop_relaunch",
          beforeCapture: capture(hashes[0].repeat(64), path.join(context.captureDirectory, `${context.stepOrdinal}-${context.kind}-before.png`), "recovery"),
          afterCapture: capture(hashes[1].repeat(64), path.join(context.captureDirectory, `${context.stepOrdinal}-${context.kind}-after.png`), "recovery"),
          continuity: [continuity()],
          receipt: context.kind === "observe"
            ? { observationMs: 2_000, logArtifact: fakeLogArtifact() }
            : { accepted: true, logArtifact: fakeLogArtifact() },
          runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
          durationMs: 1_000,
        };
      },
    },
  };
}

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-boundary-experiment-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function reachEjectedRoute(orchestrator, artifactRoot) {
  const prepared = await orchestrator.execute(prepareInput(artifactRoot, {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  const stepped = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(stepped.requiredReview.at(-1).captureSha256, "system_home"),
  });
  const routeResult = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    scope: "route",
    frameAttestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
      attestation(stepped.requiredReview.at(-1).captureSha256, "system_home"),
    ],
  });
  assert.equal(routeResult.outcome, "ejected_to_system_home");
  return { prepared, stepped, routeResult };
}

function writeLookedM0Replay(root, seedWaypoints = waypoints()) {
  const sourceRoot = path.join(root, "m0-source");
  fs.mkdirSync(sourceRoot, { recursive: true });
  const capturesRoot = path.join(sourceRoot, "captures");
  fs.mkdirSync(capturesRoot, { recursive: true });
  const calibratedWaypoints = seedWaypoints.map((waypoint, index) => index === seedWaypoints.length - 1
    ? { ...waypoint, targetGateM: 32 }
    : waypoint);
  const captureRecords = [32, 64, 96].map((shade, index) => {
    const capturePath = path.join(capturesRoot, `${index}.png`);
    const bytes = makePng(shade);
    fs.writeFileSync(capturePath, bytes, { mode: 0o600 });
    return { path: capturePath, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  });
  const routePath = path.join(sourceRoot, "route-script.json");
  const manifestPath = path.join(sourceRoot, "run.json");
  const adjudicationPath = path.join(sourceRoot, "adjudication.json");
  const sourceRunId = "d".repeat(64);
  const seed = canonicalBoundaryRouteScript({ scenarioId: "boundarylab-mixed", route: route({ kind: "calibration_seed", waypoints: calibratedWaypoints }) });
  const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(routePath, seed.json, { mode: 0o600 });
  const routeScriptSha256 = sha(routePath);
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    runId: sourceRunId,
    ownerNonceHash: "e".repeat(64),
    createdAt: "2026-08-31T12:00:00.000Z",
    serial: SERIAL,
    scenario: scenario(),
    provenance: { kind: "native_run_receipt", receiptId: RECEIPT_ID, apkSha256: APK_SHA },
    normalizedRoute: seed.script,
    routeScriptSha256,
    capture: capturePolicy,
  }), { mode: 0o600 });
  fs.writeFileSync(adjudicationPath, JSON.stringify({
    runId: sourceRunId,
    outcome: "retained_immersive_through_route",
    verdict: "PASS",
    evidenceCeiling: "vision_verified_eligible",
    witnessedGateM: 32,
    routeScriptSha256,
    frameAttestations: [
      attestation(captureRecords[0].sha256, "system_home"),
      attestation(captureRecords[1].sha256, "boundarylab_mixed"),
      attestation(captureRecords[2].sha256, "boundarylab_mixed", { witnessedGateM: 32 }),
    ],
    requiredReview: [
      { captureSha256: captureRecords[0].sha256, role: "home_reference", settled: true, path: captureRecords[0].path },
      { captureSha256: captureRecords[1].sha256, role: "app_baseline", settled: true, path: captureRecords[1].path },
      { captureSha256: captureRecords[2].sha256, role: "waypoint", waypointSeq: calibratedWaypoints.length, targetGateM: 32, settled: true, path: captureRecords[2].path },
    ],
    adjudicatedAt: "2026-08-31T12:10:00.000Z",
  }), { mode: 0o600 });
  return {
    kind: "replay",
    calibrationRouteRef: {
      absolutePath: routePath,
      routeScriptSha256,
      sourceRunManifestSha256: sha(manifestPath),
      sourceAdjudicationSha256: sha(adjudicationPath),
    },
  };
}

test("recovery envelopes reserve every ordered fallback and keep force-stop compensation reachable", () => {
  assert.equal(minimumRecoveryReserveMs("manifest_mixed"), 420_000);
  assert.equal(minimumRecoveryReserveMs("editor_manifest_full"), 420_000);
  assert.equal(minimumRecoveryReserveMs("dynamic_full"), 525_000);
  assert.deepEqual([
    recoveryStepExecutionBudgetMs("manifest_mixed", "observe"),
    recoveryStepExecutionBudgetMs("manifest_mixed", "activity_launch"),
    recoveryStepExecutionBudgetMs("manifest_mixed", "force_stop_relaunch"),
  ], [60_000, 100_000, 260_000]);
  assert.deepEqual([
    recoveryStepExecutionBudgetMs("dynamic_full", "observe"),
    recoveryStepExecutionBudgetMs("dynamic_full", "reopen_stage"),
    recoveryStepExecutionBudgetMs("dynamic_full", "activity_launch"),
    recoveryStepExecutionBudgetMs("dynamic_full", "force_stop_relaunch"),
  ], [60_000, 75_000, 100_000, 290_000]);
});

test("continuity log scope discards pre-cursor generations but retains post-cursor faults", () => {
  const marker = "boundary_probe_cursor_test_reopen_2";
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const event = (generation, seq, overrides = {}) => formatBoundaryProbeEventV1({
    schemaVersion: 1,
    sessionId,
    generation,
    seq,
    monotonicNs: String(1_000 + seq),
    kind: seq === 1 ? "command_received" : seq === 2 ? "stage_open_requested" : "stage_open_returned",
    ...(seq > 1 ? { requestedDynamicStageStyle: "Full" } : {}),
    ...overrides,
  });
  const line = (tag, message, pid = 4242, second = "01") =>
    `08-31 12:34:${second}.123  ${pid}  1300 I ${tag}: ${message}`;
  const cursorLine = line("BoundaryExperiment", marker, 900, "03");
  const raw = [
    line("BoundaryProbe", event(1, 1), 4100, "01"),
    line("BoundaryProbe", event(1, 2), 4100, "02"),
    cursorLine,
    line("BoundaryProbe", event(2, 1), 4242, "04"),
    line("BoundaryProbe", event(2, 2), 4242, "05"),
    line("BoundaryProbe", event(3, 1), 4242, "06"),
  ].join("\n");
  const scoped = scopeContinuityLogLines(raw, {
    marker,
    pid: 4242,
    sessionId,
    generation: 2,
    priorSeq: null,
  });
  assert.equal(scoped.truncated, false);
  assert.equal(scoped.markerObserved, true);
  assert.equal(scoped.lines.some((entry) => entry.includes(" 4100 ")), false);
  assert.equal(scoped.lines.length, 3, "new-generation events and a post-cursor wrong-generation event remain visible");
  assert.deepEqual(scopeContinuityLogLines(raw.replace(cursorLine, ""), {
    marker,
    pid: 4242,
    sessionId,
    generation: 2,
    priorSeq: null,
  }), { lines: [], truncated: true, markerObserved: false });
});

test("all four action schemas are strict and relational route/style contradictions fail before dependencies", () => {
  const root = path.join(os.tmpdir(), "pico-boundary-schema-run");
  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root)).success, true);
  assert.equal(boundaryExperimentInputSchema.safeParse({
    action: "step", runId: "c".repeat(64), reviewedPriorFrame: attestation("d".repeat(64)),
  }).success, true);
  assert.equal(boundaryExperimentInputSchema.safeParse({
    action: "adjudicate", runId: "c".repeat(64), scope: "route", frameAttestations: [attestation("d".repeat(64))],
  }).success, true);
  assert.equal(boundaryExperimentInputSchema.safeParse({ action: "recover", runId: "c".repeat(64) }).success, true);
  assert.equal(boundaryExperimentInputSchema.safeParse({
    action: "recover", runId: "c".repeat(64), reviewedPriorFrame: attestation("d".repeat(64)),
  }).success, true);

  const wrongStyle = prepareInput(root, { scenario: { ...scenario(), expectedManifestStageStyle: "Full" } });
  assert.equal(boundaryExperimentInputSchema.safeParse(wrongStyle).success, false);
  const missingDynamic = prepareInput(root, {
    scenario: { ...scenario("dynamic_full"), dynamicEntry: undefined },
  });
  assert.equal(boundaryExperimentInputSchema.safeParse(missingDynamic).success, false);
  for (const entryRoute of ["manifest_mixed", "manifest_full", "dynamic_full"]) {
    const exact = scenario(entryRoute);
    const exactRoute = route(entryRoute === "manifest_mixed"
      ? { kind: "calibration_seed", waypoints: waypoints() }
      : dummyReplaySource);
    assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, { scenario: exact, route: exactRoute })).success, true);
    assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
      scenario: { ...exact, id: `caller-invented-${entryRoute}` }, route: exactRoute,
    })).success, false);
    const imposterPackage = `com.fleet.imposter${entryRoute.replaceAll("_", "")}`;
    assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
      scenario: {
        ...exact,
        packageName: imposterPackage,
        launchComponent: `${imposterPackage}/.platform.LaunchActivity`,
        allowedResumedComponents: [`${imposterPackage}/.platform.LaunchActivity`],
        ...(entryRoute === "dynamic_full" ? {
          dynamicEntry: {
            ...exact.dynamicEntry,
            receiverComponent: `${imposterPackage}/.agent.BoundaryProbeReceiver`,
            action: `${imposterPackage}.BOUNDARY_PROBE`,
          },
        } : {}),
      },
      route: exactRoute,
    })).success, false);
    const callerActivity = `${exact.packageName}/.CallerChosenActivity`;
    assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
      scenario: { ...exact, launchComponent: callerActivity, allowedResumedComponents: [callerActivity] }, route: exactRoute,
    })).success, false);
  }
  const expandedAllowlist = prepareInput(root, {
    scenario: {
      ...scenario(),
      allowedResumedComponents: [COMPONENT, `${PACKAGE}/.CallerChosenActivity`],
    },
  });
  assert.equal(boundaryExperimentInputSchema.safeParse(expandedAllowlist).success, false);
  for (const dynamicScenario of [
    { ...scenario("dynamic_full"), requestedDynamicStageStyle: undefined },
    {
      ...scenario("dynamic_full"),
      dynamicEntry: {
        ...scenario("dynamic_full").dynamicEntry,
        receiverComponent: "com.attacker.receiver/.BoundaryProbeReceiver",
      },
    },
    {
      ...scenario("dynamic_full"),
      dynamicEntry: { ...scenario("dynamic_full").dynamicEntry, action: "caller.chosen.ACTION" },
    },
    {
      ...scenario("dynamic_full"),
      dynamicEntry: { ...scenario("dynamic_full").dynamicEntry, stageId: "caller-chosen-stage" },
    },
  ]) {
    assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, { scenario: dynamicScenario })).success, false);
  }
  const validEditor = prepareInput(root, {
    scenario: editorScenario(),
    route: route(dummyReplaySource),
    provenance: {
      kind: "imported_apk",
      apkPath: path.join(os.tmpdir(), "claimsight.apk"),
      apkSha256: CLAIMSIGHT_APK_SHA,
      inventoryObservedAt: "2026-08-31T12:00:00.000Z",
    },
  });
  assert.equal(boundaryExperimentInputSchema.safeParse(validEditor).success, true);
  assert.equal(boundaryExperimentInputSchema.safeParse({
    ...validEditor,
    provenance: { ...validEditor.provenance, apkSha256: "f".repeat(64) },
  }).success, false);
  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, { route: route(dummyReplaySource) })).success, false);
  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
    scenario: scenario("manifest_full"),
    route: route({ kind: "calibration_seed", waypoints: waypoints() }),
  })).success, false);
  const wrongGates = prepareInput(root, { route: { ...route(), gateSequenceM: [1, 2, 4, 8, 16] } });
  assert.equal(boundaryExperimentInputSchema.safeParse(wrongGates).success, false);
  const emptyGroup = prepareInput(root, {
    route: route({ kind: "calibration_seed", waypoints: [{ seq: 1, targetGateM: 1, actions: [] }] }),
  });
  assert.equal(boundaryExperimentInputSchema.safeParse(emptyGroup).success, false);
  const fuzzyCapture = prepareInput(root, { capture: { ...capturePolicy, comparison: "perceptual" } });
  assert.equal(boundaryExperimentInputSchema.safeParse(fuzzyCapture).success, false);
  assert.equal(boundaryExperimentInputSchema.safeParse({
    action: "recover", runId: "c".repeat(64), surprise: true,
  }).success, false);

  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
    route: { ...route(), budgets: { ...budgets, recoveryReserveMs: 419_999 } },
  })).success, false);
  const dynamicRoute = route(dummyReplaySource);
  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
    scenario: scenario("dynamic_full"),
    route: { ...dynamicRoute, budgets: { ...budgets, recoveryReserveMs: 524_999 } },
  })).success, false);
  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
    scenario: scenario("dynamic_full"),
    route: { ...dynamicRoute, budgets: { ...budgets, recoveryReserveMs: 525_000 } },
  })).success, true);
  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
    route: { ...route(), budgets: { ...budgets, maxDurationMs: 1_080_000 } },
  })).success, true, "18-minute total envelope conservatively admits the bounded six-gate seed beside dynamic recovery");
  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
    route: { ...route(), budgets: { ...budgets, maxDurationMs: 1_080_001 } },
  })).success, false, "Phase-1 total envelope remains bounded at 18 minutes");
  const multiActionOuterGate = waypoints();
  multiActionOuterGate[5] = {
    ...multiActionOuterGate[5],
    actions: [
      { kind: "key_hold", key: "w", holdMs: 5_000 },
      { kind: "key_hold", key: "w", holdMs: 5_000 },
      { kind: "key_hold", key: "w", holdMs: 4_500 },
      { kind: "key_hold", key: "s", holdMs: 1_500 },
    ],
  };
  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
    route: {
      ...route({ kind: "calibration_seed", waypoints: multiActionOuterGate }),
      budgets: { ...budgets, maxActions: 64, maxWaypoints: 10, maxCumulativeHoldMs: 60_000, maxDurationMs: 1_080_000 },
    },
  })).success, true, "one bounded waypoint may compose up to four individually capped actions");
  multiActionOuterGate[5].actions.push({ kind: "key_hold", key: "s", holdMs: 50 });
  assert.equal(boundaryExperimentInputSchema.safeParse(prepareInput(root, {
    route: {
      ...route({ kind: "calibration_seed", waypoints: multiActionOuterGate }),
      budgets: { ...budgets, maxActions: 64, maxWaypoints: 10, maxCumulativeHoldMs: 60_000, maxDurationMs: 1_080_000 },
    },
  })).success, false, "one waypoint still refuses a fifth action");
});

test("receipt-bound effective AppSpec recheck hashes canonical JSON beneath its required storage newline", (t) => {
  const root = scratch(t);
  const artifactPath = path.join(root, "effective-spec.json");
  const canonical = '{"a":1,"b":[2,3]}';
  const identity = {
    sha256: crypto.createHash("sha256").update(canonical).digest("hex"),
    bytes: Buffer.byteLength(canonical),
  };
  fs.writeFileSync(artifactPath, `${canonical}\n`, { mode: 0o600 });
  assert.deepEqual(readReceiptBoundEffectiveAppSpec(artifactPath, identity), { a: 1, b: [2, 3] });

  for (const [name, bytes] of [
    ["missing storage newline", canonical],
    ["extra storage newline", `${canonical}\n\n`],
    ["non-canonical key order", '{"b":[2,3],"a":1}\n'],
    ["changed canonical payload", '{"a":1,"b":[2,4]}\n'],
  ]) {
    fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
    assert.throws(() => readReceiptBoundEffectiveAppSpec(artifactPath, identity), /effective AppSpec|canonical|changed|identity/i, name);
  }
});

test("receipt-bound effective AppSpec regular-to-FIFO replacement cannot block before authoritative fstat", (t) => {
  const root = scratch(t);
  const artifactPath = path.join(root, "effective-spec.json");
  const canonical = '{"a":1}';
  fs.writeFileSync(artifactPath, `${canonical}\n`, { mode: 0o600 });
  const moduleUrl = new URL("../dist/boundaryexperiment.js", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import { spawnSync } from "node:child_process";
    import { readReceiptBoundEffectiveAppSpec } from ${JSON.stringify(moduleUrl)};
    const artifactPath = process.argv[1];
    const identity = JSON.parse(process.argv[2]);
    let swapped = false;
    try {
      readReceiptBoundEffectiveAppSpec(artifactPath, identity, {
        onBeforeOpen(filePath) {
          if (swapped) return;
          swapped = true;
          fs.unlinkSync(filePath);
          const fifo = spawnSync("mkfifo", [filePath], { encoding: "utf8" });
          if (fifo.status !== 0) throw new Error(fifo.stderr || "mkfifo failed");
        },
      });
      process.exitCode = 2;
    } catch (error) {
      if (swapped && /regular|changed|FIFO|special/i.test(String(error))) process.exitCode = 0;
      else { console.error(error); process.exitCode = 3; }
    }
  `;
  const identity = {
    sha256: crypto.createHash("sha256").update(canonical).digest("hex"),
    bytes: Buffer.byteLength(canonical),
  };
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, artifactPath, JSON.stringify(identity)], {
    encoding: "utf8",
    timeout: 1_200,
    killSignal: "SIGTERM",
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `child signal: ${child.signal}\n${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
});

test("system-home preparation force-stops a user-installed Full-space incumbent without opening the Home dialog", async () => {
  const calls = [];
  const foreground = [
    [
      { packageName: "com.picoxr.launcher", userInstalled: false },
      { packageName: "com.fleet.calib", userInstalled: true },
    ],
    [{ packageName: "com.picoxr.systemui", userInstalled: false }],
  ];
  const result = await clearBoundarySystemHome(PACKAGE, {
    forceStop: async (packageName) => { calls.push(["forceStop", packageName]); },
    inspectForegrounds: async () => {
      calls.push(["inspectForegrounds"]);
      return foreground.shift() ?? [];
    },
    sleep: async (ms) => { calls.push(["sleep", ms]); },
  });

  assert.deepEqual(calls, [
    ["forceStop", PACKAGE],
    ["sleep", 2_000],
    ["inspectForegrounds"],
    ["forceStop", "com.fleet.calib"],
    ["sleep", 2_000],
    ["inspectForegrounds"],
  ]);
  assert.deepEqual(result, {
    status: "cleared",
    attemptedPackages: [PACKAGE, "com.fleet.calib"],
    stoppedPackages: [PACKAGE, "com.fleet.calib"],
    foregroundAfter: ["com.picoxr.systemui"],
    classificationSource: "pm_list_packages_-3_exact",
    error: null,
  });
});

test("system-home preparation never force-stops a system foreground and bounds stubborn user-app teardown", async () => {
  const systemStops = [];
  const system = await clearBoundarySystemHome(PACKAGE, {
    forceStop: async (packageName) => { systemStops.push(packageName); },
    inspectForegrounds: async () => [{ packageName: "com.picoxr.systemui", userInstalled: false }],
    sleep: async () => {},
  });
  assert.deepEqual(systemStops, [PACKAGE]);
  assert.deepEqual(system.foregroundAfter, ["com.picoxr.systemui"]);

  let stops = 0;
  await assert.rejects(() => clearBoundarySystemHome(PACKAGE, {
    forceStop: async () => { stops++; },
    inspectForegrounds: async () => [{ packageName: "com.fleet.calib", userInstalled: true }],
    sleep: async () => {},
  }), (error) => {
    assert.equal(error instanceof BoundarySystemHomeError, true);
    assert.equal(error.receipt.status, "failed");
    assert.equal(error.receipt.attemptedPackages.length, 4);
    assert.equal(error.receipt.stoppedPackages.length, 4);
    assert.match(error.receipt.error, /did not yield|bounded/i);
    return true;
  });
  assert.equal(stops, 4, "one target stop plus exactly three bounded incumbent stops");
});

test("system-home preparation refuses an unowned third-party foreground before stopping it", async () => {
  const stops = [];
  await assert.rejects(() => clearBoundarySystemHome(PACKAGE, {
    forceStop: async (packageName) => { stops.push(packageName); },
    inspectForegrounds: async () => [{ packageName: "com.example.browser", userInstalled: true }],
    sleep: async () => {},
  }), (error) => {
    assert.equal(error instanceof BoundarySystemHomeError, true);
    assert.deepEqual(error.receipt.attemptedPackages, [PACKAGE]);
    assert.deepEqual(error.receipt.stoppedPackages, [PACKAGE]);
    assert.deepEqual(error.receipt.foregroundAfter, ["com.example.browser"]);
    assert.match(error.receipt.error, /unowned|refus/i);
    return true;
  });
  assert.deepEqual(stops, [PACKAGE]);
});

test("system-home preparation distinguishes an attempted stop from a confirmed stop", async () => {
  await assert.rejects(() => clearBoundarySystemHome(PACKAGE, {
    forceStop: async () => { throw new Error("adb transport closed"); },
    inspectForegrounds: async () => [],
    sleep: async () => {},
  }), (error) => {
    assert.equal(error instanceof BoundarySystemHomeError, true);
    assert.deepEqual(error.receipt.attemptedPackages, [PACKAGE]);
    assert.deepEqual(error.receipt.stoppedPackages, []);
    assert.match(error.receipt.error, /transport closed/);
    return true;
  });
});

test("resumed parser preserves legitimate multi-display packages and accepts explicit null state", () => {
  assert.deepEqual(parseResumedPackages([
    "Display #0:",
    "  topResumedActivity=ActivityRecord{aaa u0 com.picoxr.launcher/.MainActivity t3}",
    "Display #2:",
    "  topResumedActivity=ActivityRecord{bbb u0 com.fleet.calib/.platform.LaunchActivity t21}",
    "ResumedActivity: ActivityRecord{aaa u0 com.picoxr.launcher/.MainActivity t3}",
  ].join("\n")), ["com.picoxr.launcher", "com.fleet.calib"]);
  assert.deepEqual(parseResumedPackages("topResumedActivity=null\n"), []);
  assert.deepEqual(parseResumedPackages("ACTIVITY MANAGER ACTIVITIES\n  mCurrentFocus=null\n"), []);
  assert.throws(() => parseResumedPackages("ACTIVITY MANAGER ACTIVITIES\n"), /missing|resumed/i);
  assert.throws(() => parseResumedPackages("activity state unavailable\n"), /missing|resumed/i);
  assert.throws(() => parseResumedPackages("topResumedActivity=ActivityRecord{malformed}"), /malformed/i);
});

test("third-party package classification is exact and rejects malformed pm output", () => {
  assert.deepEqual(parseThirdPartyPackages([
    "package:com.fleet.calib",
    "package:com.fleet.boundarylabmixed",
  ].join("\n")), new Set(["com.fleet.calib", "com.fleet.boundarylabmixed"]));
  assert.equal(parseThirdPartyPackages("package:com.fleet.calib.helper\n").has("com.fleet.calib"), false);
  assert.throws(() => parseThirdPartyPackages("warning: package list unavailable"), /malformed/i);
  assert.deepEqual(classifyBoundaryForegrounds(
    ["com.picoxr.launcher", "com.fleet.calib"],
    new Set([PACKAGE, "com.fleet.calib"]),
    PACKAGE,
  ), [
    { packageName: "com.picoxr.launcher", userInstalled: false },
    { packageName: "com.fleet.calib", userInstalled: true },
  ]);
  assert.throws(() => classifyBoundaryForegrounds(
    ["com.picoxr.launcher", "com.fleet.calib"],
    new Set(),
    PACKAGE,
  ), /target package.*missing|third-party.*target/i);
});

test("prepare reserves one external run, publishes complete baseline review, and performs zero movement", async (t) => {
  const parent = scratch(t);
  const artifactRoot = path.join(parent, "run");
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const result = await orchestrator.execute(prepareInput(artifactRoot));
  assert.equal(result.status, "needs_baseline_review");
  assert.match(result.runId, /^[a-f0-9]{64}$/);
  assert.equal(fake.calls.prepare.length, 1);
  assert.equal(fake.calls.waypoint.length, 0);
  assert.equal(result.visualReviewRequired, true);
  assert.deepEqual(result.requiredReview.map((item) => item.role), ["home_reference", "app_baseline"]);
  assert.equal(result.requiredReview.every((item) => item.settled), true);
  assert.equal(fs.lstatSync(artifactRoot).isDirectory(), true);
  for (const file of ["run.json", "state.json", "required-review.json", "route-script.json", "actions.jsonl", "continuity.jsonl"]) {
    assert.equal(fs.lstatSync(path.join(artifactRoot, file)).isFile(), true, file);
  }
  assert.equal(JSON.stringify(result).includes("capability"), false);
  assert.equal(fs.readFileSync(path.join(artifactRoot, "run.json"), "utf8").includes("capability\""), false);
});

test("prepare returns retained diagnostic frames and scrubs runtime state when a baseline is unsettled", async (t) => {
  const fake = fakeDependencies();
  const collect = fake.deps.collectPreparation;
  let retainedPreparation;
  fake.deps.collectPreparation = async (context) => {
    const preparation = await collect(context);
    preparation.appBaseline = { ...preparation.appBaseline, settled: false, receipt: { status: "unsettled" } };
    preparation.privateRuntime = { secret: "must-be-scrubbed" };
    retainedPreparation = preparation;
    return preparation;
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const result = await orchestrator.execute(prepareInput(path.join(scratch(t), "unsettled")));
  assert.equal(result.status, "preparation_failed");
  assert.equal(result.structuralStop, "route_unsettled");
  assert.equal(result.responseReview.length, 2);
  assert.equal(result.responseReview.some((item) => item.settled === false), true);
  assert.equal(retainedPreparation.privateRuntime, undefined);
  assert.equal(fs.existsSync(path.join(result.artifactRoot, "preparation-failure.json")), true);
  await assert.rejects(() => orchestrator.execute({
    action: "step",
    runId: result.runId,
    reviewedPriorFrame: attestation(result.responseReview.at(-1).captureSha256),
  }), /unknown|expired/i);
});

test("a thrown live preparation failure returns and indexes every retained diagnostic frame", async (t) => {
  const fake = fakeDependencies();
  const homeClearance = {
    status: "failed",
    attemptedPackages: [PACKAGE, "com.fleet.calib"],
    stoppedPackages: [PACKAGE, "com.fleet.calib"],
    foregroundAfter: ["com.example.browser"],
    classificationSource: "pm_list_packages_-3_exact",
    error: "refusing to force-stop unowned foreground package(s): com.example.browser",
  };
  fake.deps.collectPreparation = async (context) => {
    const bytes = makePng(77);
    fs.writeFileSync(context.capturePaths.homeReference, bytes, { mode: 0o600, flag: "wx" });
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    throw new BoundaryPreparationFailure("dynamic open failed after sanitized log finalization", {
      homeClearance,
      homeReference: {
        role: "home_reference",
        path: context.capturePaths.homeReference,
        sha256,
        bytes: bytes.length,
        width: 2,
        height: 2,
        settled: true,
        receipt: { status: "settled", settlementSatisfied: true },
      },
      structuralStop: "terminal_signal_candidate",
    });
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const result = await orchestrator.execute(prepareInput(path.join(scratch(t), "thrown-prepare")));
  assert.equal(result.status, "preparation_failed");
  assert.equal(result.structuralStop, "terminal_signal_candidate");
  assert.deepEqual(result.homeClearance, homeClearance);
  assert.equal(result.responseReview.length, 1);
  assert.equal(result.responseReview[0].role, "home_reference");
  assert.equal(fs.existsSync(path.join(result.artifactRoot, "preparation.json")), true);
  assert.equal(fs.existsSync(path.join(result.artifactRoot, "preparation-failure.json")), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.artifactRoot, "required-review.json"), "utf8")), result.requiredReview);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.artifactRoot, "logcat-index.json"), "utf8")).artifacts, []);
  await assert.rejects(() => orchestrator.execute({
    action: "step",
    runId: result.runId,
    reviewedPriorFrame: attestation(result.responseReview[0].captureSha256),
  }), /unknown|expired/i);
});

test("prepare refuses repository-contained, existing, and symlink-resolved artifact roots before collection", async (t) => {
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  await assert.rejects(() => orchestrator.execute(prepareInput(path.join(repositoryRoot, ".boundary-run"))), /outside|repository/i);

  const parent = scratch(t);
  const existing = path.join(parent, "existing");
  fs.mkdirSync(existing);
  await assert.rejects(() => orchestrator.execute(prepareInput(existing)), /exist|reserve/i);

  const link = path.join(parent, "link");
  fs.symlinkSync(repositoryRoot, link, "dir");
  await assert.rejects(() => orchestrator.execute(prepareInput(path.join(link, "escape"))), /outside|repository|symlink/i);
  assert.equal(fake.calls.prepare.length, 0);
});

test("published logs redact raw capabilities and response image reads are hash-bound, PNG-only, and no-follow", (t) => {
  const root = scratch(t);
  const secret = "never-persist-this-capability";
  const logPath = path.join(root, "window.txt");
  fs.writeFileSync(logPath, `before ${secret} after ${secret}\n`, { mode: 0o600 });
  const receipt = redactCapabilityFromLogArtifact({
    rawArtifact: { path: logPath, sha256: "0".repeat(64), bytes: fs.statSync(logPath).size },
  }, secret);
  const redacted = fs.readFileSync(logPath, "utf8");
  assert.equal(redacted.includes(secret), false);
  assert.equal(receipt.capabilityScan.occurrencesRedacted, 2);
  assert.equal(receipt.capabilityScan.rawSecretPresent, false);
  assert.equal(receipt.rawArtifact.sha256, crypto.createHash("sha256").update(fs.readFileSync(logPath)).digest("hex"));

  const captures = path.join(root, "captures");
  fs.mkdirSync(captures);
  const pngPath = path.join(captures, "frame.png");
  fs.copyFileSync(path.resolve("golden/showcase-6cards.golden.png"), pngPath);
  const pngSha = crypto.createHash("sha256").update(fs.readFileSync(pngPath)).digest("hex");
  const item = { captureSha256: pngSha, role: "waypoint", settled: true, path: pngPath };
  assert.deepEqual(readBoundReviewImage(item, root), fs.readFileSync(pngPath));
  assert.throws(() => readBoundReviewImage({ ...item, captureSha256: "9".repeat(64) }, root), /sha|match/i);
  const linkPath = path.join(captures, "frame-link.png");
  fs.symlinkSync(pngPath, linkPath);
  assert.throws(() => readBoundReviewImage({ ...item, path: linkPath }, root), /symlink|regular/i);
  assert.throws(() => readBoundReviewImage({ ...item, path: logPath }, root), /strict child|capture directory/i);
});

test("secret-bearing log finalization sanitizes operation failures and deletes exact artifacts on collection failure", async (t) => {
  const root = scratch(t);
  const secret = "failure-path-capability";
  const marker = "boundary_failure_marker";
  const completeReceipt = (artifactPath) => ({
    status: "collected",
    stopReason: "caller_stop",
    termination: "sigterm",
    truncated: false,
    observedBytes: fs.statSync(artifactPath).size,
    appStartMarker: marker,
    appStartMarkerObserved: true,
    child: {
      pid: 123,
      startedAtMonotonicNs: "1",
      endedAtMonotonicNs: "2",
      command: "/absolute/adb",
      args: [],
      exitCode: 0,
      signal: null,
    },
    rawArtifact: {
      path: artifactPath,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex"),
      bytes: fs.statSync(artifactPath).size,
    },
    stderrTail: "",
  });

  const sanitizedPath = path.join(root, "sanitized.txt");
  fs.writeFileSync(sanitizedPath, `${marker} ${secret}\n`, { mode: 0o600 });
  await assert.rejects(() => runWithFinalizedLog({
    promise: Promise.resolve(completeReceipt(sanitizedPath)),
    stop: () => {},
    artifactPath: sanitizedPath,
    label: "failure-finalization",
    secrets: () => [secret],
    tailMs: 0,
    operation: async () => { throw new Error(`operation exposed ${secret}`); },
  }), (error) => {
    assert.equal(error.message.includes(secret), false);
    assert.match(error.message, /capability-sha256|sanitized/i);
    return true;
  });
  assert.equal(fs.readFileSync(sanitizedPath, "utf8").includes(secret), false);

  const deletedPath = path.join(root, "deleted.txt");
  fs.writeFileSync(deletedPath, `${marker} ${secret}\n`, { mode: 0o600 });
  const collectionFailure = Promise.reject(new Error("collector failed"));
  await assert.rejects(() => runWithFinalizedLog({
    promise: collectionFailure,
    stop: () => {},
    artifactPath: deletedPath,
    label: "collection-finalization",
    secrets: () => [secret],
    tailMs: 0,
    operation: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return true;
    },
  }), /no retained raw capability log/i);
  assert.equal(fs.existsSync(deletedPath), false);

  const durationPath = path.join(root, "duration-ended-before-operation.txt");
  fs.writeFileSync(durationPath, `${marker} ${secret}\n`, { mode: 0o600 });
  await assert.rejects(() => runWithFinalizedLog({
    promise: Promise.resolve({ ...completeReceipt(durationPath), stopReason: "duration_cap" }),
    stop: () => {},
    artifactPath: durationPath,
    label: "duration-finalization",
    secrets: () => [secret],
    tailMs: 0,
    operation: async () => true,
  }), /caller.stop|complete marker-bound|duration/i);
  assert.equal(fs.existsSync(durationPath), false);

  const unremovablePath = path.join(root, "not-a-regular-artifact");
  fs.mkdirSync(unremovablePath);
  const unprovableFailure = Promise.reject(new Error("collector failed after unsafe publication"));
  await assert.rejects(() => runWithFinalizedLog({
    promise: unprovableFailure,
    stop: () => {},
    artifactPath: unremovablePath,
    label: "unprovable-finalization",
    secrets: () => [secret],
    tailMs: 0,
    operation: async () => true,
  }), /raw capability artifact absence could not be proven/i);
});

test("later actions reject a replaced run root before touching dependencies or attacker-owned files", async (t) => {
  const parent = scratch(t);
  const artifactRoot = path.join(parent, "run");
  const displacedRoot = path.join(parent, "displaced-owned-run");
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(artifactRoot));

  fs.renameSync(artifactRoot, displacedRoot);
  fs.mkdirSync(artifactRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(artifactRoot, "actions.jsonl"), "attacker-owned\n", { mode: 0o600 });

  await assert.rejects(() => orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  }), /artifact|owner|identity|replace|inode/i);
  assert.equal(fake.calls.recapture.length, 0);
  assert.equal(fake.calls.waypoint.length, 0);
  assert.equal(fs.readFileSync(path.join(artifactRoot, "actions.jsonl"), "utf8"), "attacker-owned\n");
});

test("only one state-changing call may operate on a run at a time", async (t) => {
  const fake = fakeDependencies();
  let releaseRecapture;
  let enteredRecapture;
  const recaptureEntered = new Promise((resolve) => { enteredRecapture = resolve; });
  const recaptureRelease = new Promise((resolve) => { releaseRecapture = resolve; });
  fake.deps.recaptureReviewedFrame = async (context) => {
    fake.calls.recapture.push(context);
    enteredRecapture();
    await recaptureRelease;
    return { matches: true, sha256: context.expectedSha256, continuity: continuity() };
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run")));
  const first = orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  await recaptureEntered;
  try {
    const concurrent = await orchestrator.execute({
      action: "step",
      runId: prepared.runId,
      reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
    });
    assert.equal(concurrent.status, "action_in_progress");
    assert.equal(concurrent.runId, prepared.runId);
    assert.equal(fake.calls.recapture.length, 1);
    assert.equal(fake.calls.waypoint.length, 1);
  } finally {
    releaseRecapture();
  }
  const completed = await first;
  assert.equal(completed.status, "needs_waypoint_review");
  assert.equal(fake.calls.recapture.length, 1);
  assert.equal(fake.calls.waypoint.length, 1);
});

test("step requires the exact prior reviewed hash, recaptures it, executes one immutable group, and emits no visual verdict", async (t) => {
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run")));

  const wrong = await orchestrator.execute({
    action: "step", runId: prepared.runId, reviewedPriorFrame: attestation("9".repeat(64)),
  });
  assert.equal(wrong.status, "review_rejected");
  assert.equal(fake.calls.waypoint.length, 0);

  const result = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(result.status, "needs_waypoint_review");
  assert.equal(fake.calls.recapture.length, 1);
  assert.equal(fake.calls.waypoint.length, 1);
  assert.deepEqual(fake.calls.waypoint[0].waypoint, waypoints()[0]);
  assert.equal(Object.hasOwn(result, "outcome"), false);
  assert.equal(Object.hasOwn(result, "passed"), false);
  assert.equal(result.visualReviewRequired, true);
  assert.equal(result.requiredReview.at(-1).waypointSeq, 1);
  const persistedAction = JSON.parse(fs.readFileSync(path.join(result.artifactRoot, "actions.jsonl"), "utf8").trim());
  assert.equal(persistedAction.capture.sha256, result.requiredReview.at(-1).captureSha256);
  assert.equal(persistedAction.capture.width, 16);
  assert.equal(persistedAction.capture.receipt.status, "settled");
});

test("step refuses a reviewed hash whose retained PNG can no longer be revalidated", async (t) => {
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "retention-drift")));
  fake.deps.readReviewImage = () => { throw new Error("review image bytes no longer match"); };
  const result = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(result.status, "review_rejected");
  assert.match(result.reason, /no longer retained byte-exact/i);
  assert.equal(fake.calls.waypoint.length, 0);
});

test("marker-window prior-frame drift retains a transition and executes zero movement", async (t) => {
  const fake = fakeDependencies();
  fake.deps.recaptureReviewedFrame = async (context) => {
    fake.calls.recapture.push(context);
    return { matches: false, sha256: "7".repeat(64), continuity: continuity({ foreground: "different_package" }) };
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run")));
  const result = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(result.status, "needs_waypoint_review");
  assert.equal(result.structuralStop, "terminal_signal_candidate");
  assert.equal(result.routeTrace.usage.actions, 0);
  assert.equal(result.routeTrace.usage.waypoints, 0);
  assert.equal(result.requiredReview.at(-1).role, "transition");
  assert.equal(fake.calls.recapture.length, 1);
  assert.equal(fake.calls.waypoint.length, 1);
});

function hashOnlyDriftExecution(context, sha256, preflightContinuity, laterContinuity = []) {
  const preflightLogSha = "4".repeat(64);
  const stepLogSha = "5".repeat(64);
  const stepLogPath = context.stepLogPath ?? path.join(context.state.artifactRoot, "test-step-log.txt");
  const preflightLogPath = context.preflightLogPath ?? path.join(context.state.artifactRoot, "test-preflight-log.txt");
  return {
    preflight: { matches: false, sha256, continuity: preflightContinuity },
    routeTrace: {
      status: "binding_lost",
      waypoints: [],
      usage: { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 1 },
      preMovementReviewDrift: true,
    },
    capture: capture(sha256, context.capturePath, "transition"),
    continuity: laterContinuity,
    logArtifact: { rawArtifact: { path: stepLogPath, sha256: stepLogSha, bytes: 1 } },
    preflightLogArtifact: { rawArtifact: { path: preflightLogPath, sha256: preflightLogSha, bytes: 1 } },
    preflightRuntimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName, preflightLogSha),
    runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName, stepLogSha),
  };
}

test("a hash-only initial drift pauses once, preserves both attempt artifacts, and resumes the same waypoint", async (t) => {
  const fake = fakeDependencies();
  const attemptContexts = [];
  const normalWaypoint = fakeDependencies().deps.executeWaypoint;
  const firstCaptureBytes = makePng(96);
  const driftSha = crypto.createHash("sha256").update(firstCaptureBytes).digest("hex");
  fake.deps.executeWaypoint = async (context) => {
    fake.calls.waypoint.push(context);
    attemptContexts.push(context);
    if (attemptContexts.length === 1) {
      fs.writeFileSync(context.capturePath, firstCaptureBytes, { mode: 0o600, flag: "wx" });
      return hashOnlyDriftExecution(context, driftSha, continuity());
    }
    fs.writeFileSync(context.capturePath, makePng(128 + attemptContexts.length), { mode: 0o600 });
    return normalWaypoint(context);
  };

  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "hash-only-drift"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(2) }),
  }));
  const paused = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(paused.status, "needs_baseline_review");
  assert.equal(paused.structuralStop, null);
  assert.equal(paused.rebaselineReason, "reviewed_frame_bytes_changed_without_binding_drift");
  assert.equal(paused.requiredReview.at(-1).captureSha256, driftSha);
  assert.equal(paused.requiredReview.at(-1).role, "transition");
  assert.equal(paused.usage.durationMs, 1);

  const resumed = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(driftSha, "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(resumed.status, "needs_waypoint_review");
  assert.equal(resumed.structuralStop, null);
  assert.equal(resumed.usage.actions, 1);
  assert.equal(resumed.usage.waypoints, 1);
  assert.equal(attemptContexts.length, 2);
  assert.equal(attemptContexts[0].attemptOrdinal, 1);
  assert.equal(attemptContexts[1].attemptOrdinal, 2);
  assert.notEqual(attemptContexts[0].capturePath, attemptContexts[1].capturePath);
  assert.notEqual(attemptContexts[0].stepLogPath, attemptContexts[1].stepLogPath);
  assert.notEqual(attemptContexts[0].preflightLogPath, attemptContexts[1].preflightLogPath);
  assert.match(attemptContexts[1].capturePath, /attempt-2/);
  assert.match(attemptContexts[1].stepLogPath, /attempt-2/);
  assert.match(attemptContexts[1].preflightLogPath, /attempt-2/);
  assert.deepEqual(fs.readFileSync(attemptContexts[0].capturePath), firstCaptureBytes);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(attemptContexts[0].capturePath)).digest("hex"), driftSha);
  const secondWaypoint = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(resumed.requiredReview.at(-1).captureSha256, "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(secondWaypoint.status, "needs_waypoint_review");
  assert.equal(secondWaypoint.usage.waypoints, 2);
  assert.equal(attemptContexts.length, 3);
  assert.equal(attemptContexts[2].attemptOrdinal, 1);
  assert.doesNotMatch(attemptContexts[2].capturePath, /attempt-/);
  assert.doesNotMatch(attemptContexts[2].stepLogPath, /attempt-/);
  assert.doesNotMatch(attemptContexts[2].preflightLogPath, /attempt-/);
  assert.deepEqual(fs.readFileSync(attemptContexts[0].capturePath), firstCaptureBytes);
  const requiredReview = JSON.parse(fs.readFileSync(path.join(prepared.artifactRoot, "required-review.json"), "utf8"));
  assert.deepEqual(requiredReview.map((item) => item.captureSha256), ["1".repeat(64), "2".repeat(64), driftSha, "3".repeat(64), "4".repeat(64)]);
  assert.deepEqual(requiredReview.slice(2).map((item) => item.path), [attemptContexts[0].capturePath, attemptContexts[1].capturePath, attemptContexts[2].capturePath]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.artifactRoot, "state.json"), "utf8")).rebaselineOrdinal, 1);
});

test("a second unique initial-frame drift terminalizes after the persisted one-shot rebaseline", async (t) => {
  const fake = fakeDependencies();
  let attempt = 0;
  fake.deps.executeWaypoint = async (context) => {
    fake.calls.waypoint.push(context);
    attempt += 1;
    return hashOnlyDriftExecution(context, `${attempt + 6}`.repeat(64), continuity());
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "second-drift"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  const paused = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(paused.status, "needs_baseline_review");
  const terminal = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("7".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(terminal.status, "needs_waypoint_review");
  assert.equal(terminal.structuralStop, "binding_lost");
  assert.equal(terminal.requiredReview.at(-1).captureSha256, "8".repeat(64));
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.artifactRoot, "state.json"), "utf8")).rebaselineOrdinal, 1);
});

test("a bad preflight foreground cannot rebaseline even if a later sample is clean", async (t) => {
  const fake = fakeDependencies();
  fake.deps.executeWaypoint = async (context) => {
    fake.calls.waypoint.push(context);
    return hashOnlyDriftExecution(context, "7".repeat(64), continuity({ foreground: "different_package" }), [continuity()]);
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "bad-preflight-foreground"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  const result = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(result.status, "needs_waypoint_review");
  assert.notEqual(result.structuralStop, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.artifactRoot, "state.json"), "utf8")).rebaselineOrdinal, 0);
});

test("a dynamic explicit-close probe event cannot rebaseline a hash-only frame drift", async (t) => {
  const root = scratch(t);
  const dynamicScenario = scenario("dynamic_full");
  const dynamicContinuity = (overrides = {}) => continuity({
    packageName: dynamicScenario.packageName,
    allowedResumedComponents: dynamicScenario.allowedResumedComponents,
    resumedComponents: dynamicScenario.allowedResumedComponents,
    probeParse: "ok",
    probeSequence: "complete",
    ...overrides,
  });
  const fake = fakeDependencies();
  fake.deps.executeWaypoint = async (context) => {
    fake.calls.waypoint.push(context);
    return hashOnlyDriftExecution(context, "7".repeat(64), dynamicContinuity({
      probeEventsSincePrior: [{ kind: "explicit_close_returned" }],
    }));
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(root, "dynamic-close"), {
    scenario: dynamicScenario,
    route: route(writeLookedM0Replay(root, waypoints(1))),
  }));
  const result = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_dynamic_full", { sentinels: ["DYNAMIC FULL"], witnessedGateM: 0 }),
  });
  assert.equal(result.status, "needs_waypoint_review");
  assert.notEqual(result.structuralStop, null);
  const state = JSON.parse(fs.readFileSync(path.join(prepared.artifactRoot, "state.json"), "utf8"));
  assert.equal(state.rebaselineOrdinal, 0);
  assert.deepEqual(state.probeIssues, ["event:explicit_close_returned"]);
});

test("a non-dynamic truncated probe diagnostic resumes through the live movement predicate after hash-only rebaseline", async (t) => {
  const fake = fakeDependencies();
  const normalWaypoint = fakeDependencies().deps.executeWaypoint;
  let execution = 0;
  fake.deps.executeWaypoint = async (context) => {
    fake.calls.waypoint.push(context);
    execution += 1;
    if (execution === 1) return hashOnlyDriftExecution(context, "7".repeat(64), continuity({ probeParse: "truncated" }));
    const preflight = {
      matches: true,
      sha256: context.state.lastRequiredHash,
      continuity: continuity({ probeParse: "truncated" }),
    };
    const permitted = waypointPreflightAllowsMovement(
      preflight,
      context.state.lastRequiredHash,
      context.state.preparation.runtimeBinding,
      context.state.preparation.applicationBinding,
      context.state.input.scenario.entryRoute,
    );
    if (!permitted) return hashOnlyDriftExecution(context, "8".repeat(64), preflight.continuity);
    return { ...(await normalWaypoint(context)), preflight, continuity: [preflight.continuity] };
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "non-dynamic-truncated"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  const result = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(result.status, "needs_baseline_review");
  const state = JSON.parse(fs.readFileSync(path.join(prepared.artifactRoot, "state.json"), "utf8"));
  assert.equal(state.rebaselineOrdinal, 1);
  assert.deepEqual(state.probeIssues, ["parse:truncated"]);
  const resumed = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("7".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(resumed.status, "needs_waypoint_review");
  assert.equal(resumed.usage.waypoints, 1);
  assert.equal(resumed.structuralStop, null);
});

test("zero-waypoint input uncertainty and action failure retain a transition frame, stop permanently, and cannot retry", async (t) => {
  for (const traceStatus of ["input_release_uncertain", "action_failed"]) {
    const expectedStop = traceStatus === "action_failed" ? "route_unsettled" : traceStatus;
    const retainedFailure = traceStatus === "action_failed" ? {
      kind: "reported_action_failure",
      receiptsSoFar: [{ action: "key_hold", status: "applied" }],
      terminalReceipt: { action: "look_drag", status: "failed", error: "focus mismatch" },
      terminalError: "focus mismatch",
      attemptedCount: 2,
      attemptedAction: { kind: "look_drag", dxPx: 20, dyPx: 0 },
    } : undefined;
    const fake = fakeDependencies();
    let preparationRef;
    if (traceStatus === "input_release_uncertain") {
      const collectPreparation = fake.deps.collectPreparation;
      fake.deps.collectPreparation = async (context) => {
        preparationRef = await collectPreparation(context);
        preparationRef.privateRuntime = { secret: "release-uncertain-secret" };
        return preparationRef;
      };
    }
    fake.deps.executeWaypoint = async (context) => {
      fake.calls.waypoint.push(context);
      const preflight = await context.recaptureReviewedFrame();
      return {
        preflight,
        routeTrace: {
          status: traceStatus,
          waypoints: [],
          usage: { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 75 },
          ...(retainedFailure ? { terminalActionFailure: retainedFailure } : {}),
        },
        capture: capture("3".repeat(64), context.capturePath, "transition"),
        continuity: [continuity()],
        logArtifact: fakeLogArtifact(),
        runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
      };
    };
    const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
    const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), `run-${traceStatus}`), {
      route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
    }));
    const stopped = await orchestrator.execute({
      action: "step",
      runId: prepared.runId,
      reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
    });
    assert.equal(stopped.status, "needs_waypoint_review");
    assert.equal(stopped.structuralStop, expectedStop);
    assert.equal(stopped.usage.waypoints, 0);
    assert.equal(stopped.requiredReview.at(-1).role, "transition");
    assert.equal(Object.hasOwn(stopped.requiredReview.at(-1), "waypointSeq"), false);
    const diskState = JSON.parse(fs.readFileSync(path.join(stopped.artifactRoot, "state.json"), "utf8"));
    assert.equal(diskState.nextWaypoint, 0);
    assert.equal(diskState.structuralStop, expectedStop);
    if (retainedFailure) {
      assert.deepEqual(stopped.routeTrace.terminalActionFailure, retainedFailure);
      const actionRecord = JSON.parse(fs.readFileSync(path.join(stopped.artifactRoot, "actions.jsonl"), "utf8").trim());
      assert.deepEqual(actionRecord.routeTrace.terminalActionFailure, retainedFailure);
    }
    if (traceStatus === "input_release_uncertain") {
      assert.equal(diskState.inputReleaseCertain, false);
      assert.equal(preparationRef.privateRuntime, undefined);
    }

    const noRetry = await orchestrator.execute({
      action: "step",
      runId: prepared.runId,
      reviewedPriorFrame: attestation("3".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
    });
    assert.equal(noRetry.status, "ready_for_route_adjudication");
    assert.equal(noRetry.structuralStop, expectedStop);
    assert.equal(fake.calls.waypoint.length, 1);
  }
});

test("a post-movement evidence failure retains the frame as a non-gate transition", async (t) => {
  const fake = fakeDependencies();
  fake.deps.executeWaypoint = async (context) => {
    fake.calls.waypoint.push(context);
    const preflight = await context.recaptureReviewedFrame();
    return {
      preflight,
      routeTrace: {
        status: "controller_stop",
        waypoints: [{
          seq: 1,
          actions: context.waypoint.actions,
          actionReceipts: [],
          continuityBefore: { kind: "sampled", sample: continuity() },
          settle: { status: "settled", settlementSatisfied: true, sha256: "3".repeat(64) },
          continuityAfter: { kind: "sampled", sample: continuity() },
        }],
        usage: { actions: 1, waypoints: 1, holdMs: 100, dragPx: 0, durationMs: 75 },
      },
      capture: capture("3".repeat(64), context.capturePath, "waypoint"),
      continuity: [continuity(), continuity()],
      logArtifact: fakeLogArtifact(),
      runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
      executionError: "marker-bound log finalization failed after movement",
    };
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  const stopped = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed"),
  });
  assert.equal(stopped.structuralStop, "action_failed");
  assert.equal(stopped.requiredReview.at(-1).role, "transition");
  assert.equal(Object.hasOwn(stopped.requiredReview.at(-1), "targetGateM"), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stopped.artifactRoot, "state.json"), "utf8")).nextWaypoint, 0);
});

test("the app baseline cannot supply a terminal state, an inconclusive state, or a route gate", async (t) => {
  for (const [visibleState, overrides] of [
    ["system_home", {}],
    ["black_or_inconclusive", {}],
    ["boundarylab_mixed", { witnessedGateM: 32 }],
  ]) {
    const fake = fakeDependencies();
    const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
    const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), `run-${visibleState}-${overrides.witnessedGateM ?? 0}`)));
    const rejected = await orchestrator.execute({
      action: "step",
      runId: prepared.runId,
      reviewedPriorFrame: attestation("2".repeat(64), visibleState, overrides),
    });
    assert.equal(rejected.status, "review_rejected");
    assert.equal(fake.calls.recapture.length, 0);
    assert.equal(fake.calls.waypoint.length, 0);
  }
});

test("route adjudication is rejected until a reviewed terminal condition or completed movement exists", async (t) => {
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run")));
  const result = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    scope: "route",
    frameAttestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
    ],
  });
  assert.equal(result.status, "adjudication_rejected");
  assert.match(result.reason, /movement|terminal|route/i);
  assert.equal(fake.calls.recapture.length, 0);
  assert.equal(fake.calls.waypoint.length, 0);
  assert.equal(fs.existsSync(path.join(result.artifactRoot, "adjudication.json")), false);
});

test("aggregate route budgets persist across staged step calls and cannot reset at the CP1 boundary", async (t) => {
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const input = prepareInput(path.join(scratch(t), "run"), {
    route: { ...route(), budgets: { ...budgets, maxActions: 1, maxWaypoints: 1 } },
  });
  const prepared = await orchestrator.execute(input);
  const first = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(first.status, "needs_waypoint_review");
  const second = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("3".repeat(64), "boundarylab_mixed", { witnessedGateM: 1 }),
  });
  assert.equal(second.status, "ready_for_route_adjudication");
  assert.equal(second.structuralStop, "budget_exhausted");
  assert.equal(fake.calls.waypoint.length, 1);
});

test("the bounded four-action outer gate remains reachable after five staged waypoint reviews", async (t) => {
  const calibratedWaypoints = waypoints();
  calibratedWaypoints[5] = {
    ...calibratedWaypoints[5],
    actions: [
      { kind: "key_hold", key: "w", holdMs: 5_000 },
      { kind: "key_hold", key: "w", holdMs: 5_000 },
      { kind: "key_hold", key: "w", holdMs: 4_500 },
      { kind: "key_hold", key: "s", holdMs: 1_500 },
    ],
  };
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run"), {
    route: {
      ...route({ kind: "calibration_seed", waypoints: calibratedWaypoints }),
      budgets: {
        ...budgets,
        maxActions: 64,
        maxWaypoints: 10,
        maxCumulativeHoldMs: 60_000,
        maxCumulativeDragPx: 1_440,
        maxDurationMs: 1_080_000,
      },
    },
  }));

  let priorHash = "2".repeat(64);
  let priorGate = 0;
  let stepped;
  for (let index = 0; index < calibratedWaypoints.length; index++) {
    stepped = await orchestrator.execute({
      action: "step",
      runId: prepared.runId,
      reviewedPriorFrame: attestation(priorHash, "boundarylab_mixed", { witnessedGateM: priorGate }),
    });
    assert.equal(stepped.status, "needs_waypoint_review", `waypoint ${index + 1}`);
    priorHash = stepped.requiredReview.at(-1).captureSha256;
    priorGate = GATES[index];
  }

  assert.equal(fake.calls.waypoint.length, 6);
  assert.deepEqual(fake.calls.waypoint.at(-1).waypoint.actions, calibratedWaypoints[5].actions);
  assert.equal(stepped.usage.actions, 9);
  assert.equal(stepped.usage.holdMs, 17_500);
  assert.equal(stepped.usage.durationMs, 600);
  const ready = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(priorHash, "boundarylab_mixed", { witnessedGateM: 32 }),
  });
  assert.equal(ready.status, "ready_for_route_adjudication");
  assert.equal(ready.structuralStop, "reviewed_terminal_or_outer_gate");
});

test("a same-process transition to system home remains an ejection candidate instead of becoming a binding mismatch", async (t) => {
  const fake = fakeDependencies();
  fake.deps.executeWaypoint = async (context) => {
    fake.calls.waypoint.push(context);
    const preflight = await context.recaptureReviewedFrame();
    const systemHomeContinuity = continuity({
      foreground: "different_package",
      resumedComponents: ["com.pico.launcher/.Launcher"],
    });
    return {
      preflight,
      routeTrace: {
        status: "binding_lost",
        waypoints: [{
          seq: 1,
          actions: context.waypoint.actions,
          actionReceipts: [{ action: "key_hold", status: "applied", serial: SERIAL, ack: { releaseCertain: true } }],
          continuityBefore: { kind: "sampled", sample: continuity() },
          settle: { status: "settled", settlementSatisfied: true, sha256: "3".repeat(64) },
          continuityAfter: { kind: "sampled", sample: systemHomeContinuity },
        }],
        usage: { actions: 1, waypoints: 1, holdMs: 100, dragPx: 0, durationMs: 100 },
      },
      capture: capture("3".repeat(64), context.capturePath, "waypoint"),
      continuity: [systemHomeContinuity],
      logArtifact: fakeLogArtifact(),
      runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
    };
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  const stepped = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(stepped.structuralStop, "terminal_signal_candidate");
  assert.notEqual(stepped.structuralStop, "binding_lost");

  const ready = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("3".repeat(64), "system_home"),
  });
  assert.equal(ready.status, "ready_for_route_adjudication");
  const adjudicated = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    scope: "route",
    frameAttestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
      attestation("3".repeat(64), "system_home"),
    ],
  });
  assert.equal(adjudicated.outcome, "ejected_to_system_home");
  assert.equal(adjudicated.verdict, "FAIL");
});

test("an attributed ANR dominates a live PID and looked pixels as app_lifecycle_loss", async (t) => {
  const fake = fakeDependencies();
  const executeWaypoint = fake.deps.executeWaypoint;
  fake.deps.executeWaypoint = async (context) => ({
    ...(await executeWaypoint(context)),
    runtimeHealth: failedRuntimeHealth(context.state.input.scenario.packageName),
  });
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  const stepped = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(stepped.structuralStop, "app_lifecycle_loss");
  await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(stepped.requiredReview.at(-1).captureSha256, "system_home"),
  });
  const result = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    scope: "route",
    frameAttestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
      attestation(stepped.requiredReview.at(-1).captureSha256, "system_home"),
    ],
  });
  assert.equal(result.outcome, "app_lifecycle_loss");
  assert.equal(result.visualTransition, "system_home");
  assert.equal(result.evidenceCeiling, "structural");
});

test("a dynamic probe sequence gap is sticky even if a later continuity sample says complete", async (t) => {
  const root = scratch(t);
  const dynamicScenario = scenario("dynamic_full");
  const dynamicContinuity = (overrides = {}) => continuity({
    packageName: dynamicScenario.packageName,
    allowedResumedComponents: dynamicScenario.allowedResumedComponents,
    resumedComponents: dynamicScenario.allowedResumedComponents,
    ...overrides,
  });
  const fake = fakeDependencies();
  fake.deps.recaptureReviewedFrame = async (context) => {
    fake.calls.recapture.push(context);
    return { matches: true, sha256: context.expectedSha256, continuity: dynamicContinuity() };
  };
  fake.deps.executeWaypoint = async (context) => {
    fake.calls.waypoint.push(context);
    const preflight = await context.recaptureReviewedFrame();
    return {
      preflight,
      routeTrace: {
        status: "controller_stop",
        waypoints: [{
          seq: 1,
          actions: context.waypoint.actions,
          actionReceipts: [{ action: "key_hold", status: "applied", serial: SERIAL, ack: { releaseCertain: true } }],
          continuityBefore: { kind: "sampled", sample: dynamicContinuity() },
          settle: { status: "settled", settlementSatisfied: true, sha256: "3".repeat(64) },
          continuityAfter: { kind: "sampled", sample: dynamicContinuity() },
        }],
        usage: { actions: 1, waypoints: 1, holdMs: 100, dragPx: 0, durationMs: 100 },
      },
      capture: capture("3".repeat(64), context.capturePath, "waypoint"),
      continuity: [
        dynamicContinuity({
          probeParse: "ok",
          probeSequence: "gap",
          probeEventsSincePrior: [
            { kind: "command_received" },
            { kind: "stage_open_requested" },
            { kind: "stage_open_returned" },
          ],
        }),
        dynamicContinuity({ probeParse: "ok", probeSequence: "complete", probeEventsSincePrior: [] }),
      ],
      logArtifact: fakeLogArtifact(),
      runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
    };
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(root, "run"), {
    scenario: dynamicScenario,
    route: route(writeLookedM0Replay(root, waypoints(1))),
  }));
  const stepped = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_dynamic_full", {
      sentinels: ["DYNAMIC FULL"], witnessedGateM: 0,
    }),
  });
  await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(stepped.requiredReview.at(-1).captureSha256, "boundarylab_dynamic_full", {
      sentinels: ["DYNAMIC FULL"], witnessedGateM: 32,
    }),
  });
  const result = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    scope: "route",
    frameAttestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_dynamic_full", { sentinels: ["DYNAMIC FULL"], witnessedGateM: 0 }),
      attestation("3".repeat(64), "boundarylab_dynamic_full", { sentinels: ["DYNAMIC FULL"], witnessedGateM: 32 }),
    ],
  });
  assert.equal(result.outcome, "stage_self_closed_or_lifecycle_teardown");
  assert.equal(result.verdict, "CHARACTERIZE");
});

function outcomeInput(overrides = {}) {
  const requiredReview = [
    { captureSha256: "1".repeat(64), role: "home_reference", settled: true },
    { captureSha256: "2".repeat(64), role: "app_baseline", settled: true },
    { captureSha256: "3".repeat(64), role: "waypoint", waypointSeq: 1, settled: true },
  ];
  return {
    scenario: scenario(),
    requiredReview,
    attestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
      attestation("3".repeat(64), "boundarylab_mixed", { witnessedGateM: 32 }),
    ],
    structural: {
      stop: null,
      inputReleaseCertain: true,
      processAlive: true,
      bindingCoherent: true,
      routeComplete: true,
      lastForeground: "exact_allowed",
      probeParse: "absent",
      probeSequence: "unknown",
      probeEvents: [],
      probeEventRecords: [],
      runtimeHealthFailure: false,
      runtimeHealthInconclusive: false,
    },
    ...overrides,
  };
}

test("route adjudication requires the complete exact review manifest and rejects duplicates or incompatible states", () => {
  const base = outcomeInput();
  assert.equal(deriveBoundaryRouteOutcome(base).outcome, "retained_immersive_through_route");
  assert.throws(() => deriveBoundaryRouteOutcome({ ...base, attestations: base.attestations.slice(1) }), /missing|exact|required/i);
  assert.throws(() => deriveBoundaryRouteOutcome({ ...base, attestations: [...base.attestations, base.attestations[2]] }), /duplicate|exact/i);
  assert.throws(() => deriveBoundaryRouteOutcome({
    ...base,
    attestations: base.attestations.map((item, index) => index === 1 ? attestation(item.captureSha256, "claimsight_environment") : item),
  }), /incompatible|scenario|baseline/i);
  assert.throws(() => deriveBoundaryRouteOutcome({
    ...base,
    requiredReview: base.requiredReview.map((item, index) => index === 2 ? { ...item, settled: false } : item),
  }), /unsettled|settled/i);
  assert.throws(() => deriveBoundaryRouteOutcome({
    ...base,
    attestations: base.attestations.map((item, index) => index === 1
      ? attestation(item.captureSha256, "boundarylab_mixed", { witnessedGateM: 32 })
      : index === 2
        ? attestation(item.captureSha256, "boundarylab_mixed", { witnessedGateM: 1 })
        : item),
  }), /baseline|gate|waypoint|witness/i);
});

test("Section 7 outcome precedence preserves every failure and characterization class", () => {
  const retained = outcomeInput();
  assert.deepEqual(deriveBoundaryRouteOutcome(retained), {
    outcome: "retained_immersive_through_route", verdict: "PASS", evidenceCeiling: "vision_verified_eligible", witnessedGateM: 32, visualTransition: "expected_app",
  });

  const dynamicScenario = scenario("dynamic_full");
  const dynamicBase = outcomeInput({
    scenario: dynamicScenario,
    attestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_dynamic_full", { sentinels: ["DYNAMIC FULL"] }),
      attestation("3".repeat(64), "boundarylab_mixed", { sentinels: ["MANIFEST MIXED ROOT"], witnessedGateM: 8 }),
    ],
    structural: {
      ...retained.structural,
      routeComplete: false,
      probeParse: "ok",
      probeSequence: "complete",
      probeEvents: ["command_received", "stage_open_requested", "stage_open_returned"],
      probeEventRecords: [
        { kind: "command_received" },
        { kind: "stage_open_requested" },
        { kind: "stage_open_returned" },
      ],
    },
  });
  assert.equal(deriveBoundaryRouteOutcome(dynamicBase).outcome, "returned_to_app_default_stage");
  assert.equal(deriveBoundaryRouteOutcome(dynamicBase).verdict, "FAIL");

  const ejected = outcomeInput({
    attestations: retained.attestations.map((item, index) => index === 2 ? attestation(item.captureSha256, "system_home") : item),
  });
  assert.equal(deriveBoundaryRouteOutcome(ejected).outcome, "ejected_to_system_home");

  for (const structural of [
    { probeParse: "absent", probeSequence: "unknown" },
    { probeParse: "malformed" },
    { probeSequence: "gap" },
    { probeSequence: "wrong_session" },
    { probeSequence: "wrong_generation" },
    { probeEvents: ["command_received", "stage_open_requested", "stage_open_returned", "explicit_close_requested"] },
    { probeEvents: ["command_received", "stage_open_requested"] },
    { probeEventRecords: [{ kind: "stage_open_returned" }, { kind: "stage_open_requested" }, { kind: "command_received" }] },
    { probeEventRecords: [{ kind: "command_received" }, { kind: "stage_open_requested" }, { kind: "stage_open_requested" }, { kind: "stage_open_returned" }] },
  ]) {
    const mergedStructural = {
      ...dynamicBase.structural,
      ...structural,
      ...(structural.probeEvents && !structural.probeEventRecords
        ? { probeEventRecords: structural.probeEvents.map((kind) => ({ kind })) }
        : {}),
    };
    const result = deriveBoundaryRouteOutcome({
      ...dynamicBase,
      structural: mergedStructural,
    });
    assert.equal(result.outcome, "stage_self_closed_or_lifecycle_teardown");
    assert.equal(result.verdict, "CHARACTERIZE");
  }

  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({ structural: { ...retained.structural, processAlive: false } })).outcome, "app_lifecycle_loss");
  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({ structural: { ...retained.structural, processAlive: false, stop: "route_unsettled" } })).outcome, "app_lifecycle_loss");
  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({ structural: { ...retained.structural, runtimeHealthFailure: true } })).outcome, "app_lifecycle_loss");
  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({ structural: { ...retained.structural, runtimeHealthInconclusive: true } })).outcome, "binding_lost");
  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({ structural: { ...retained.structural, stop: "route_unsettled" } })).outcome, "route_unsettled");
  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({ structural: { ...retained.structural, stop: "binding_lost" } })).outcome, "binding_lost");
  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({ structural: { ...retained.structural, lastForeground: "different_package" } })).outcome, "binding_lost");
  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({ structural: { ...retained.structural, inputReleaseCertain: false } })).outcome, "input_release_uncertain");
  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({
    attestations: retained.attestations.map((item, index) => index === 2 ? attestation(item.captureSha256, "black_or_inconclusive") : item),
  })).outcome, "capture_inconclusive");
  assert.equal(deriveBoundaryRouteOutcome(outcomeInput({
    structural: { ...retained.structural, routeComplete: false },
    attestations: retained.attestations.map((item, index) => index === 2 ? attestation(item.captureSha256, "boundarylab_mixed", { witnessedGateM: 16 }) : item),
  })).outcome, "no_ejection_within_observed_budget");
});

test("dynamic open evidence requires the exact authenticated command-request-return ordering", () => {
  const expected = ["command_received", "stage_open_requested", "stage_open_returned"];
  assert.equal(hasExactDynamicOpenSequence(expected.map((kind) => ({ kind })), expected), true);
  assert.equal(hasExactDynamicOpenSequence([expected[2], expected[1], expected[0]].map((kind) => ({ kind })), expected), false);
  assert.equal(hasExactDynamicOpenSequence([...expected, expected[2]].map((kind) => ({ kind })), expected), false);
});

test("normal activity recovery classifies accepted, ignored, and blocked am-start dispositions", () => {
  assert.equal(classifyActivityLaunchDisposition("Starting: Intent { cmp=com.fleet/.Main }\nStatus: ok", true), "accepted");
  assert.equal(classifyActivityLaunchDisposition("Warning: Activity not started, intent has been delivered", true), "ignored");
  assert.equal(classifyActivityLaunchDisposition("Status: timeout", true), "blocked");
  assert.equal(classifyActivityLaunchDisposition("Starting: Intent { cmp=com.fleet/.Main }\nStatus: timeout", true), "blocked");
  assert.equal(classifyActivityLaunchDisposition("Starting: Intent { cmp=com.fleet/.Main }", true), "blocked");
  assert.equal(classifyActivityLaunchDisposition("Error: activity launch rejected\nStatus: ok", true), "blocked");
  assert.equal(classifyActivityLaunchDisposition("Status: ok", false), "blocked");
});

test("recovery candidates require the exact bound process and the exact expected visual state", () => {
  const runtimeBinding = {
    serial: SERIAL,
    bootId: BOOT_ID,
    grpc: { discoveryFile: "/tmp/pico-emulator/pid_93013.ini", qemuPid: 93013, address: "127.0.0.1:8554" },
    qemuWindow: { ownerPid: 93013, windowId: 7 },
  };
  const applicationBinding = {
    packageName: PACKAGE,
    apkSha256: APK_SHA,
    allowedResumedComponents: [COMPONENT],
    pid: 4242,
    pidStartTicks: "9001",
  };
  assert.equal(recoveryContinuityMatchesBinding(continuity(), runtimeBinding, applicationBinding), true);
  assert.equal(recoveryContinuityMatchesBinding(continuity({ pid: 4343 }), runtimeBinding, applicationBinding), false);
  assert.equal(recoveryContinuityMatchesBinding(continuity({ pidStartTicks: "9002" }), runtimeBinding, applicationBinding), false);
  assert.equal(recoveryContinuityMatchesBinding(continuity({ foreground: "different_package" }), runtimeBinding, applicationBinding), false);
  const exactPreflight = { matches: true, sha256: "1".repeat(64), continuity: continuity() };
  assert.equal(waypointPreflightAllowsMovement(exactPreflight, "1".repeat(64), runtimeBinding, applicationBinding), true);
  assert.equal(waypointPreflightAllowsMovement({
    ...exactPreflight,
    continuity: continuity({
      probeParse: "ok",
      probeSequence: "complete",
      probeEventsSincePrior: [{ kind: "explicit_close_requested" }],
    }),
  }, "1".repeat(64), runtimeBinding, applicationBinding), false);
  assert.equal(waypointPreflightAllowsMovement({
    ...exactPreflight,
    continuity: continuity({ probeParse: "truncated" }),
  }, "1".repeat(64), runtimeBinding, applicationBinding), false);
  assert.equal(waypointPreflightAllowsMovement({
    ...exactPreflight,
    continuity: continuity({ probeParse: "truncated" }),
  }, "1".repeat(64), runtimeBinding, applicationBinding, "manifest_mixed"), true);

  const dynamic = scenario("dynamic_full");
  assert.equal(recoveryFrameMatchesExpected(dynamic, attestation("a".repeat(64), "boundarylab_mixed")), false);
  assert.equal(recoveryFrameMatchesExpected(dynamic, attestation("b".repeat(64), "boundarylab_dynamic_full", { sentinels: ["DYNAMIC FULL"] })), true);
  const reopenBase = {
    entryRoute: "dynamic_full",
    observedFrame: attestation("c".repeat(64), "boundarylab_mixed", { sentinels: ["MANIFEST MIXED ROOT"] }),
    observeStructuralOk: true,
    exactBinding: true,
  };
  assert.equal(shouldIncludeDynamicReopen(reopenBase), true);
  for (const changed of [
    { observedFrame: attestation("c".repeat(64), "system_home") },
    { observedFrame: attestation("c".repeat(64), "boundarylab_dynamic_full", { sentinels: ["DYNAMIC FULL"] }) },
    { observeStructuralOk: false },
    { exactBinding: false },
    { entryRoute: "manifest_full" },
  ]) assert.equal(shouldIncludeDynamicReopen({ ...reopenBase, ...changed }), false);

  assert.equal(recoveryReboundTupleChanged(applicationBinding, applicationBinding), false);
  assert.equal(recoveryReboundTupleChanged(applicationBinding, { ...applicationBinding, pid: 4343 }), true);
  assert.equal(recoveryReboundTupleChanged(applicationBinding, { ...applicationBinding, pidStartTicks: "9002" }), true);
});

test("the live preflight-drift trace charges elapsed monotonic preflight, health, and capture work", () => {
  assert.equal(typeof boundaryExperiment.chargePreflightDriftDuration, "function");
  const trace = boundaryExperiment.chargePreflightDriftDuration({
    status: "binding_lost",
    waypoints: [],
    usage: { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 0 },
    preMovementReviewDrift: true,
  }, 1_000_000_000n, 1_001_500_001n);
  assert.equal(trace.usage.durationMs, 2);
  assert.equal(trace.preMovementReviewDrift, true);
});

test("live waypoint coverage markers are unique across a rebaseline retry and leave the next waypoint viable", () => {
  assert.equal(typeof boundaryExperiment.waypointCoverageMarker, "function");
  const first = boundaryExperiment.waypointCoverageMarker("a".repeat(64), 1, 1);
  const retry = boundaryExperiment.waypointCoverageMarker("a".repeat(64), 1, 2);
  const nextWaypoint = boundaryExperiment.waypointCoverageMarker("a".repeat(64), 2, 1);
  assert.notEqual(first, retry);
  assert.notEqual(retry, nextWaypoint);
  assert.match(retry, /step_1_2$/);
  assert.match(nextWaypoint, /step_2_1$/);
});

test("adjudicate stores one immutable route result and never promotes its evidence ceiling automatically", async (t) => {
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  const stepped = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  const ready = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation(stepped.requiredReview.at(-1).captureSha256, "boundarylab_mixed", { witnessedGateM: 32 }),
  });
  assert.equal(ready.status, "ready_for_route_adjudication");
  const result = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    scope: "route",
    frameAttestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
      attestation(stepped.requiredReview.at(-1).captureSha256, "boundarylab_mixed", { witnessedGateM: 32 }),
    ],
  });
  assert.equal(result.status, "route_adjudicated");
  assert.equal(result.outcome, "retained_immersive_through_route");
  assert.equal(result.evidenceCeiling, "vision_verified_eligible");
  assert.equal(Object.hasOwn(result, "ledgerEntry"), false);
  assert.equal(Object.hasOwn(result, "passed"), false);
  assert.equal(fs.existsSync(path.join(result.artifactRoot, "adjudication.json")), true);
  const repeated = await orchestrator.execute({
    action: "adjudicate", runId: prepared.runId, scope: "route", frameAttestations: [],
  });
  assert.equal(repeated.status, "already_adjudicated");
});

test("canonical route scripts are deterministic and reject mutable or controller-synthesized groups", () => {
  const first = canonicalBoundaryRouteScript({ scenarioId: "boundarylab-mixed", route: route() });
  const second = canonicalBoundaryRouteScript({ scenarioId: "boundarylab-mixed", route: route() });
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.json, second.json);
  assert.deepEqual(first.script.waypoints, waypoints());
  assert.throws(() => canonicalBoundaryRouteScript({
    scenarioId: "boundarylab-mixed",
    route: route({ kind: "calibration_seed", waypoints: [{ seq: 1, targetGateM: 1, actions: [] }] }),
  }), /action|empty/i);
});

test("replay is fully cross-bound to one looked M0 run and preserves its route metadata", (t) => {
  const root = scratch(t);
  const routePath = path.join(root, "route-script.json");
  const manifestPath = path.join(root, "run.json");
  const adjudicationPath = path.join(root, "adjudication.json");
  const capturesRoot = path.join(root, "captures");
  fs.mkdirSync(capturesRoot);
  const captureRecords = [40, 80, 120].map((shade, index) => {
    const capturePath = path.join(capturesRoot, `${index}.png`);
    const bytes = makePng(shade);
    fs.writeFileSync(capturePath, bytes, { mode: 0o600 });
    return { path: capturePath, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  });
  const sourceRunId = "d".repeat(64);
  const ownerNonceHash = "e".repeat(64);
  const seedArtifact = canonicalBoundaryRouteScript({ scenarioId: "boundarylab-mixed", route: route() });
  const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const writeFixture = ({
    routeJson = seedArtifact.json,
    manifestOverrides = {},
    adjudicationOverrides = {},
  } = {}) => {
    fs.writeFileSync(routePath, routeJson, { mode: 0o600 });
    const routeScriptSha256 = sha(routePath);
    const manifest = {
      schemaVersion: 1,
      runId: sourceRunId,
      ownerNonceHash,
      createdAt: "2026-08-31T12:00:00.000Z",
      serial: SERIAL,
      scenario: scenario(),
      provenance: { kind: "native_run_receipt", receiptId: RECEIPT_ID, apkSha256: APK_SHA },
      normalizedRoute: JSON.parse(routeJson),
      routeScriptSha256,
      capture: capturePolicy,
      ...manifestOverrides,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const adjudication = {
      runId: sourceRunId,
      outcome: "retained_immersive_through_route",
      verdict: "PASS",
      evidenceCeiling: "vision_verified_eligible",
      witnessedGateM: 32,
      routeScriptSha256,
      frameAttestations: [
        attestation(captureRecords[0].sha256, "system_home"),
        attestation(captureRecords[1].sha256, "boundarylab_mixed", { witnessedGateM: 0 }),
        attestation(captureRecords[2].sha256, "boundarylab_mixed", { witnessedGateM: 32 }),
      ],
      requiredReview: [
        { captureSha256: captureRecords[0].sha256, role: "home_reference", settled: true, path: captureRecords[0].path },
        { captureSha256: captureRecords[1].sha256, role: "app_baseline", settled: true, path: captureRecords[1].path },
        { captureSha256: captureRecords[2].sha256, role: "waypoint", waypointSeq: 6, targetGateM: 32, settled: true, path: captureRecords[2].path },
      ],
      adjudicatedAt: "2026-08-31T12:10:00.000Z",
      ...adjudicationOverrides,
    };
    fs.writeFileSync(adjudicationPath, JSON.stringify(adjudication), { mode: 0o600 });
    return {
      absolutePath: routePath,
      routeScriptSha256,
      sourceRunManifestSha256: sha(manifestPath),
      sourceAdjudicationSha256: sha(adjudicationPath),
    };
  };

  let ref = writeFixture();
  const resolved = resolveCalibrationRouteRef(ref, fakeM0ReceiptReader);
  assert.deepEqual(resolved.waypoints, waypoints());
  assert.equal(resolved.direction, "forward");
  assert.equal(resolved.speedProfile, "staircase");
  assert.equal(resolved.requiredTraversalM, 32);
  assert.deepEqual(resolved.gateSequenceM, GATES);
  assert.deepEqual(resolved.budgets, budgets);

  assert.throws(() => resolveCalibrationRouteRef(ref, () => ({ status: "invalid", issues: ["missing producer receipt"] })), /native M0 receipt|producer|invalid/i);
  const retainedOuterBytes = fs.readFileSync(captureRecords[2].path);
  fs.writeFileSync(captureRecords[2].path, makePng(121), { mode: 0o600 });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /capture|sha|review image|bytes/i);
  fs.writeFileSync(captureRecords[2].path, retainedOuterBytes, { mode: 0o600 });

  assert.throws(() => resolveCalibrationRouteRef({ ...ref, routeScriptSha256: "f".repeat(64) }, fakeM0ReceiptReader), /hash|sha/i);
  fs.appendFileSync(routePath, "\n");
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /hash|sha|tamper/i);
  ref = writeFixture();
  const symlinkPath = path.join(root, "route-link.json");
  fs.symlinkSync(routePath, symlinkPath);
  assert.throws(() => resolveCalibrationRouteRef({ ...ref, absolutePath: symlinkPath }, fakeM0ReceiptReader), /symlink|regular/i);

  ref = writeFixture({ manifestOverrides: { scenario: scenario("manifest_full") } });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /M0|manifest.mixed|scenario|source/i);
  ref = writeFixture({ manifestOverrides: { provenance: { kind: "imported_apk", apkPath: "/tmp/forged.apk", apkSha256: APK_SHA, inventoryObservedAt: "2026-08-31T12:00:00.000Z" } } });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /native M0|native.*receipt|provenance/i);
  ref = writeFixture({ adjudicationOverrides: { runId: "9".repeat(64) } });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /run.?id|cross|bind|source/i);
  ref = writeFixture({ manifestOverrides: { routeScriptSha256: "8".repeat(64) } });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /route|hash|bind|manifest/i);
  ref = writeFixture({
    adjudicationOverrides: {
      frameAttestations: [
        attestation(captureRecords[0].sha256, "system_home"),
        attestation(captureRecords[1].sha256, "boundarylab_mixed", { witnessedGateM: 32 }),
      ],
    },
  });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /waypoint|outer|32|attestation|baseline/i);
  ref = writeFixture({ adjudicationOverrides: { verdict: "CHARACTERIZE" } });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /looked|PASS|adjudication|gate/i);
  ref = writeFixture({ adjudicationOverrides: { evidenceCeiling: "structural" } });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /looked|evidence|adjudication|gate/i);
  ref = writeFixture({
    adjudicationOverrides: {
      requiredReview: [
        { captureSha256: captureRecords[0].sha256, role: "home_reference", settled: true, path: captureRecords[0].path },
        { captureSha256: captureRecords[1].sha256, role: "app_baseline", settled: true, path: captureRecords[1].path },
      ],
    },
  });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /manifest|missing|unexpected|outer|gate/i);

  const foreignScript = JSON.stringify({ ...seedArtifact.script, scenarioId: "boundarylab-manifest-full" });
  ref = writeFixture({ routeJson: foreignScript });
  assert.throws(() => resolveCalibrationRouteRef(ref, fakeM0ReceiptReader), /M0|scenario|route script|source/i);

  ref = writeFixture();
  const replaySource = { kind: "replay", calibrationRouteRef: ref };
  assert.deepEqual(
    canonicalBoundaryRouteScript({ scenarioId: "boundarylab-manifest-full", route: route(replaySource) }, fakeM0ReceiptReader).script.waypoints,
    waypoints(),
  );
  assert.throws(() => canonicalBoundaryRouteScript({
    scenarioId: "boundarylab-manifest-full",
    route: { ...route(replaySource), direction: "backward" },
  }, fakeM0ReceiptReader), /direction|metadata|source|match/i);
  assert.throws(() => canonicalBoundaryRouteScript({
    scenarioId: "boundarylab-manifest-full",
    route: { ...route(replaySource), speedProfile: "fast" },
  }, fakeM0ReceiptReader), /speed|metadata|source|match/i);
  assert.throws(() => canonicalBoundaryRouteScript({
    scenarioId: "boundarylab-manifest-full",
    route: { ...route(replaySource), budgets: { ...budgets, maxActions: budgets.maxActions + 1 } },
  }, fakeM0ReceiptReader), /budget|metadata|source|match/i);
});

test("recovery has four bounded once-only branches and short-circuits at the first proven result", async () => {
  async function runCase({ dynamic, inputReleaseCertain = true, answers }) {
    const order = [];
    const count = { observe: 0, reopen: 0, launch: 0, force: 0 };
    const dependency = (name) => async () => {
      order.push(name);
      count[name] += 1;
      assert.ok(count[name] <= 1, `${name} recovery branch repeated`);
      return answers[name] ?? false;
    };
    const value = await executeBoundaryRecoveryProtocol({ dynamic, inputReleaseCertain }, {
      observe: dependency("observe"),
      reopenStage: dependency("reopen"),
      launchActivity: dependency("launch"),
      forceStopRelaunch: dependency("force"),
    });
    return { value, order };
  }

  let result = await runCase({ dynamic: true, answers: { observe: true } });
  assert.equal(result.value.result, "auto_resumed");
  assert.deepEqual(result.order, ["observe"]);

  result = await runCase({ dynamic: true, answers: { reopen: true } });
  assert.equal(result.value.result, "stage_reopened");
  assert.deepEqual(result.order, ["observe", "reopen"]);

  result = await runCase({ dynamic: true, answers: { launch: true } });
  assert.equal(result.value.result, "activity_relaunch");
  assert.deepEqual(result.order, ["observe", "reopen", "launch"]);

  result = await runCase({ dynamic: false, answers: { launch: true } });
  assert.equal(result.value.result, "activity_relaunch");
  assert.deepEqual(result.order, ["observe", "launch"]);

  result = await runCase({ dynamic: true, answers: { force: true } });
  assert.equal(result.value.result, "force_stop_relaunch");
  assert.deepEqual(result.order, ["observe", "reopen", "launch", "force"]);

  result = await runCase({ dynamic: false, answers: {} });
  assert.equal(result.value.result, "unrecovered");
  assert.deepEqual(result.order, ["observe", "launch", "force"]);

  result = await runCase({ dynamic: true, inputReleaseCertain: false, answers: { observe: true, reopen: true, launch: true, force: true } });
  assert.equal(result.value.result, "input_release_uncertain");
  assert.deepEqual(result.order, []);
});

test("recover is once-only, route-adjudication-gated, and recovery pixels require a separate adjudication", async (t) => {
  const fake = fakeDependencies();
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  assert.equal((await orchestrator.execute({ action: "recover", runId: prepared.runId })).status, "recovery_rejected");

  const stepped = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
  });
  assert.equal(stepped.status, "needs_waypoint_review");
  const ready = await orchestrator.execute({
    action: "step", runId: prepared.runId,
    reviewedPriorFrame: attestation(stepped.requiredReview.at(-1).captureSha256, "system_home"),
  });
  assert.equal(ready.status, "ready_for_route_adjudication");
  const routeResult = await orchestrator.execute({
    action: "adjudicate", runId: prepared.runId, scope: "route",
    frameAttestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_mixed", { witnessedGateM: 0 }),
      attestation(stepped.requiredReview.at(-1).captureSha256, "system_home"),
    ],
  });
  assert.equal(routeResult.outcome, "ejected_to_system_home");

  const recovery = await orchestrator.execute({ action: "recover", runId: prepared.runId });
  assert.equal(recovery.status, "needs_recovery_review");
  assert.equal(fake.calls.recover.length, 1);
  assert.equal(fake.calls.recover[0].remainingRecoveryMs, 60_000);
  assert.equal((await orchestrator.execute({ action: "recover", runId: prepared.runId })).status, "recovery_review_rejected");
  assert.equal(fake.calls.recover.length, 1);
  const observeAfter = recovery.recoverySteps.at(-1).afterItem;
  const activity = await orchestrator.execute({
    action: "recover",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(observeAfter.captureSha256, "black_or_inconclusive"),
  });
  assert.equal(activity.status, "needs_recovery_review");
  assert.equal(activity.recoverySteps.at(-1).kind, "activity_launch");
  assert.equal(fake.calls.recover.length, 2);
  assert.equal(fake.calls.recover[1].remainingRecoveryMs, 100_000);
  const recoveryArtifact = JSON.parse(fs.readFileSync(path.join(activity.artifactRoot, "recovery.json"), "utf8"));
  assert.equal(recoveryArtifact.steps.length, 2);
  assert.equal(recoveryArtifact.steps[0].beforeCapture.width, 16);
  assert.equal(recoveryArtifact.steps[0].afterCapture.receipt.status, "settled");
  const recoveryActions = fs.readFileSync(path.join(activity.artifactRoot, "actions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(recoveryActions.at(-1).beforeCapture.bytes, 128);
  assert.equal(recoveryActions.at(-1).afterCapture.height, 8);
  const activityAfter = activity.recoverySteps.at(-1).afterItem;
  const recoveryReady = await orchestrator.execute({
    action: "recover",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(activityAfter.captureSha256, "boundarylab_mixed"),
  });
  assert.equal(recoveryReady.status, "ready_for_recovery_adjudication");
  assert.equal(fake.calls.recover.length, 2);
  const recoveryReview = await orchestrator.execute({
    action: "adjudicate", runId: prepared.runId, scope: "recovery",
    frameAttestations: recoveryReady.requiredReview.map((item) => item.captureSha256 === "f".repeat(64)
      ? attestation(item.captureSha256, "boundarylab_mixed")
      : attestation(item.captureSha256, "black_or_inconclusive")),
  });
  assert.equal(recoveryReview.status, "recovery_adjudicated");
  assert.equal(recoveryReview.recoveryResult, "activity_relaunch");
  assert.equal(fs.existsSync(path.join(recoveryReview.artifactRoot, "recovery-adjudication.json")), true);
});

test("F2 inserts reopen only from the current LOOKed observe Mixed root with a fresh exact binding", async (t) => {
  async function runCase(observedVisibleState, observeContinuityOverrides = {}) {
    const root = scratch(t);
    const dynamicScenario = scenario("dynamic_full");
    const dynamicContinuity = (overrides = {}) => continuity({
      packageName: dynamicScenario.packageName,
      allowedResumedComponents: dynamicScenario.allowedResumedComponents,
      resumedComponents: dynamicScenario.allowedResumedComponents,
      ...overrides,
    });
    const fake = fakeDependencies();
    fake.deps.recaptureReviewedFrame = async (context) => {
      fake.calls.recapture.push(context);
      return { matches: true, sha256: context.expectedSha256, continuity: dynamicContinuity() };
    };
    fake.deps.executeWaypoint = async (context) => {
      fake.calls.waypoint.push(context);
      const preflight = await context.recaptureReviewedFrame();
      return {
        preflight,
        routeTrace: {
          status: "controller_stop",
          waypoints: [{
            seq: 1,
            actions: context.waypoint.actions,
            actionReceipts: [{ action: "key_hold", status: "applied", serial: SERIAL, ack: { releaseCertain: true } }],
            continuityBefore: { kind: "sampled", sample: dynamicContinuity() },
            settle: { status: "settled", settlementSatisfied: true, sha256: "3".repeat(64) },
            continuityAfter: { kind: "sampled", sample: dynamicContinuity() },
          }],
          usage: { actions: 1, waypoints: 1, holdMs: 100, dragPx: 0, durationMs: 100 },
        },
        capture: capture("3".repeat(64), context.capturePath, "waypoint"),
        continuity: [dynamicContinuity()],
        logArtifact: fakeLogArtifact(),
        runtimeHealth: quietRuntimeHealth(dynamicScenario.packageName),
      };
    };
    fake.deps.executeRecoveryStep = async (context) => {
      fake.calls.recover.push(context);
      const ordinal = fake.calls.recover.length;
      return {
        kind: context.kind,
        structuralOk: true,
        beforeCapture: capture(`${ordinal + 3}`.repeat(64), path.join(context.captureDirectory, `${ordinal}-before.png`), "recovery"),
        afterCapture: capture(`${ordinal + 4}`.repeat(64), path.join(context.captureDirectory, `${ordinal}-after.png`), "recovery"),
        continuity: [dynamicContinuity(context.kind === "observe" ? observeContinuityOverrides : {})],
        receipt: { accepted: true, logArtifact: fakeLogArtifact() },
        runtimeHealth: quietRuntimeHealth(dynamicScenario.packageName),
        durationMs: 1_000,
      };
    };
    const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
    const prepared = await orchestrator.execute(prepareInput(path.join(root, "run"), {
      scenario: dynamicScenario,
      route: route(writeLookedM0Replay(root, waypoints(1))),
    }));
    const stepped = await orchestrator.execute({
      action: "step",
      runId: prepared.runId,
      reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_dynamic_full", { sentinels: ["DYNAMIC FULL"] }),
    });
    await orchestrator.execute({
      action: "step",
      runId: prepared.runId,
      reviewedPriorFrame: attestation(stepped.requiredReview.at(-1).captureSha256, "boundarylab_mixed", { sentinels: ["MANIFEST MIXED ROOT"] }),
    });
    const routeResult = await orchestrator.execute({
      action: "adjudicate",
      runId: prepared.runId,
      scope: "route",
      frameAttestations: [
        attestation("1".repeat(64), "system_home"),
        attestation("2".repeat(64), "boundarylab_dynamic_full", { sentinels: ["DYNAMIC FULL"] }),
        attestation("3".repeat(64), "boundarylab_mixed", { sentinels: ["MANIFEST MIXED ROOT"] }),
      ],
    });
    assert.equal(routeResult.outcome, "returned_to_app_default_stage");
    const observed = await orchestrator.execute({ action: "recover", runId: prepared.runId });
    const advanced = await orchestrator.execute({
      action: "recover",
      runId: prepared.runId,
      reviewedPriorFrame: attestation(
        observed.recoverySteps.at(-1).afterItem.captureSha256,
        observedVisibleState,
        observedVisibleState === "boundarylab_mixed" ? { sentinels: ["MANIFEST MIXED ROOT"] } : {},
      ),
    });
    return { advanced, fake };
  }

  let result = await runCase("system_home");
  assert.equal(result.advanced.recoverySteps.at(-1).kind, "activity_launch");
  assert.deepEqual(result.fake.calls.recover.map((call) => call.kind), ["observe", "activity_launch"]);

  result = await runCase("boundarylab_mixed");
  assert.equal(result.advanced.recoverySteps.at(-1).kind, "reopen_stage");
  assert.deepEqual(result.fake.calls.recover.map((call) => call.kind), ["observe", "reopen_stage"]);

  result = await runCase("boundarylab_mixed", { pidStartTicks: "9002" });
  assert.equal(result.advanced.recoverySteps.at(-1).kind, "activity_launch");
});

test("a visually rejected structural recovery candidate unlocks exactly the next fallback", async (t) => {
  const fake = fakeDependencies();
  fake.deps.executeRecoveryStep = async (context) => {
    fake.calls.recover.push(context);
    const ordinal = fake.calls.recover.length;
    return {
      kind: context.kind,
      structuralOk: true,
      beforeCapture: capture(`${ordinal + 3}`.repeat(64), path.join(context.captureDirectory, `${ordinal}-${context.kind}-before.png`), "recovery"),
      afterCapture: capture(`${ordinal + 5}`.repeat(64), path.join(context.captureDirectory, `${ordinal}-${context.kind}-after.png`), "recovery"),
      continuity: [continuity()],
      receipt: { accepted: true, logArtifact: fakeLogArtifact() },
      runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
      durationMs: 1_000,
    };
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const { prepared } = await reachEjectedRoute(orchestrator, path.join(scratch(t), "run"));
  const observed = await orchestrator.execute({ action: "recover", runId: prepared.runId });
  assert.equal(observed.recoverySteps.at(-1).kind, "observe");
  const wrong = await orchestrator.execute({
    action: "recover",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("9".repeat(64), "black_or_inconclusive"),
  });
  assert.equal(wrong.status, "recovery_review_rejected");
  assert.equal(fake.calls.recover.length, 1);

  const advanced = await orchestrator.execute({
    action: "recover",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(observed.recoverySteps.at(-1).afterItem.captureSha256, "black_or_inconclusive"),
  });
  assert.equal(advanced.status, "needs_recovery_review");
  assert.equal(advanced.recoverySteps.at(-1).kind, "activity_launch");
  assert.equal(fake.calls.recover.length, 2);

  const ready = await orchestrator.execute({
    action: "recover",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(advanced.recoverySteps.at(-1).afterItem.captureSha256, "boundarylab_mixed"),
  });
  assert.equal(ready.status, "ready_for_recovery_adjudication");
  assert.equal(fake.calls.recover.length, 2);
});

test("an ignored normal launch can stop on recovered pixels without being mislabeled activity_relaunch", async (t) => {
  const fake = fakeDependencies();
  const executeRecoveryStep = fake.deps.executeRecoveryStep;
  fake.deps.executeRecoveryStep = async (context) => {
    const result = await executeRecoveryStep(context);
    if (context.kind !== "activity_launch") return result;
    return {
      ...result,
      attributionKind: "activity_launch_ignored",
      structuralOk: true,
      receipt: { disposition: "ignored", samePidStartSurvived: true, logArtifact: fakeLogArtifact() },
    };
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const { prepared } = await reachEjectedRoute(orchestrator, path.join(scratch(t), "ignored-launch"));
  const observed = await orchestrator.execute({ action: "recover", runId: prepared.runId });
  const activity = await orchestrator.execute({
    action: "recover",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(observed.recoverySteps.at(-1).afterItem.captureSha256, "system_home"),
  });
  assert.equal(activity.recoverySteps.at(-1).receipt.disposition, "ignored");
  const ready = await orchestrator.execute({
    action: "recover",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(activity.recoverySteps.at(-1).afterItem.captureSha256, "boundarylab_mixed"),
  });
  assert.equal(ready.status, "ready_for_recovery_adjudication");
  assert.equal(fake.calls.recover.length, 2, "a recovered ignored-launch frame must not trigger destructive force-stop");
  const activityAfterHash = activity.recoverySteps.at(-1).afterItem.captureSha256;
  const adjudicated = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    scope: "recovery",
    frameAttestations: ready.requiredReview.map((item) => item.captureSha256 === activityAfterHash
      ? attestation(item.captureSha256, "boundarylab_mixed")
      : attestation(item.captureSha256, "system_home")),
  });
  assert.equal(adjudicated.recoveryResult, "recovered_after_ignored_activity_launch");
  assert.equal(adjudicated.recoveredAtStep, "activity_launch_ignored");
});

test("runtime-health failure prevents a dependency-claimed recovery from earning success", async (t) => {
  const fake = fakeDependencies();
  const executeRecoveryStep = fake.deps.executeRecoveryStep;
  fake.deps.executeRecoveryStep = async (context) => ({
    ...(await executeRecoveryStep(context)),
    structuralOk: true,
    runtimeHealth: failedRuntimeHealth(context.state.input.scenario.packageName),
  });
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const { prepared } = await reachEjectedRoute(orchestrator, path.join(scratch(t), "run"));
  const observed = await orchestrator.execute({ action: "recover", runId: prepared.runId });
  assert.equal(observed.recoverySteps.at(-1).structuralOk, false);
  const advanced = await orchestrator.execute({
    action: "recover",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(observed.recoverySteps.at(-1).afterItem.captureSha256, "boundarylab_mixed"),
  });
  assert.equal(advanced.status, "needs_recovery_review");
  assert.equal(advanced.recoverySteps.at(-1).kind, "activity_launch");
  const persisted = JSON.parse(fs.readFileSync(path.join(advanced.artifactRoot, "recovery.json"), "utf8"));
  assert.equal(persisted.steps[0].structuralOk, false);
  assert.equal(persisted.steps[0].runtimeHealth.status, "attributed_failure");
});

test("pre-intervention gap failures remain recorded without invalidating a healthy recovery operation", async (t) => {
  const fake = fakeDependencies();
  const executeRecoveryStep = fake.deps.executeRecoveryStep;
  fake.deps.executeRecoveryStep = async (context) => ({
    ...(await executeRecoveryStep(context)),
    structuralOk: true,
    runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
    coverageRuntimeHealth: failedRuntimeHealth(context.state.input.scenario.packageName),
  });
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const { prepared } = await reachEjectedRoute(orchestrator, path.join(scratch(t), "coverage-failure"));
  const observed = await orchestrator.execute({ action: "recover", runId: prepared.runId });
  assert.equal(observed.recoverySteps[0].structuralOk, true);
  assert.equal(observed.recoverySteps[0].coverageRuntimeHealth.status, "attributed_failure");
  assert.equal(observed.recoverySteps[0].runtimeHealth.status, "no_attributed_failure");
  const persisted = JSON.parse(fs.readFileSync(path.join(observed.artifactRoot, "recovery.json"), "utf8"));
  assert.equal(persisted.steps[0].coverageRuntimeHealth.status, "attributed_failure");
});

test("recovery is negative only from a LOOKed settled final post-frame; missing or unsettled posts stay inconclusive", async (t) => {
  for (const mode of ["missing", "unsettled", "withheld", "settled"]) {
    const fake = fakeDependencies();
    fake.deps.executeRecoveryStep = async (context) => {
      fake.calls.recover.push(context);
      const ordinal = fake.calls.recover.length;
      const before = capture(`${ordinal}`.repeat(64), path.join(context.captureDirectory, `${ordinal}-${context.kind}-before.png`), "recovery");
      let after = capture(`${ordinal + 6}`.repeat(64), path.join(context.captureDirectory, `${ordinal}-${context.kind}-after.png`), "recovery");
      if (context.kind === "force_stop_relaunch" && mode === "missing") after = null;
      if (context.kind === "force_stop_relaunch" && mode === "unsettled") after = { ...after, settled: false };
      return {
        kind: context.kind,
        ...(context.kind === "force_stop_relaunch" && mode === "withheld" ? { attributionKind: "observe" } : {}),
        structuralOk: context.kind === "force_stop_relaunch" && ["settled", "withheld"].includes(mode),
        beforeCapture: before,
        afterCapture: after,
        continuity: [continuity()],
        receipt: { accepted: false, logArtifact: fakeLogArtifact() },
        runtimeHealth: quietRuntimeHealth(context.state.input.scenario.packageName),
        durationMs: 1_000,
        ...(after === null ? { protocolStopped: true } : {}),
      };
    };
    const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
    const { prepared } = await reachEjectedRoute(orchestrator, path.join(scratch(t), `run-${mode}`));
    let recovery = await orchestrator.execute({ action: "recover", runId: prepared.runId });
    for (const expectedKind of ["activity_launch", "force_stop_relaunch"]) {
      recovery = await orchestrator.execute({
        action: "recover",
        runId: prepared.runId,
        reviewedPriorFrame: attestation(recovery.recoverySteps.at(-1).afterItem.captureSha256, "system_home"),
      });
      assert.equal(recovery.recoverySteps.at(-1).kind, expectedKind);
    }
    if (mode !== "missing") {
      recovery = await orchestrator.execute({
        action: "recover",
        runId: prepared.runId,
        reviewedPriorFrame: attestation(recovery.recoverySteps.at(-1).afterItem.captureSha256, "system_home"),
      });
    }
    assert.equal(recovery.status, "ready_for_recovery_adjudication");
    assert.deepEqual(fake.calls.recover.map((call) => [call.kind, call.remainingRecoveryMs]), [
      ["observe", 60_000],
      ["activity_launch", 100_000],
      ["force_stop_relaunch", 260_000],
    ]);
    if (mode === "missing") assert.equal(recovery.responseReview.length, 1);
    const adjudicated = await orchestrator.execute({
      action: "adjudicate",
      runId: prepared.runId,
      scope: "recovery",
      frameAttestations: recovery.requiredReview.map((item) => attestation(item.captureSha256, "system_home")),
    });
    assert.equal(adjudicated.recoveryResult, mode === "settled" ? "unrecovered" : "recovery_inconclusive");
  }
});

test("a partial recovery dependency failure consumes the once-only attempt", async (t) => {
  const fake = fakeDependencies();
  fake.deps.executeRecoveryStep = async (context) => {
    fake.calls.recover.push(context);
    throw new Error("injected failure after recovery side effect");
  };
  const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
  const prepared = await orchestrator.execute(prepareInput(path.join(scratch(t), "run"), {
    route: route({ kind: "calibration_seed", waypoints: waypoints(1) }),
  }));
  const stepped = await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation("2".repeat(64), "boundarylab_mixed"),
  });
  await orchestrator.execute({
    action: "step",
    runId: prepared.runId,
    reviewedPriorFrame: attestation(stepped.requiredReview.at(-1).captureSha256, "system_home"),
  });
  await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    scope: "route",
    frameAttestations: [
      attestation("1".repeat(64), "system_home"),
      attestation("2".repeat(64), "boundarylab_mixed"),
      attestation(stepped.requiredReview.at(-1).captureSha256, "system_home"),
    ],
  });
  const failed = await orchestrator.execute({ action: "recover", runId: prepared.runId });
  assert.equal(failed.status, "recovery_failed");
  assert.equal(fake.calls.recover.length, 1);
  const retried = await orchestrator.execute({ action: "recover", runId: prepared.runId });
  assert.equal(retried.status, "recovery_rejected");
  assert.equal(fake.calls.recover.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(failed.artifactRoot, "state.json"), "utf8")).recoveryAttempted, true);
});

test("recovery scrubs capability state before ownership failures can bypass terminal handling", async (t) => {
  for (const mode of ["throw", "return"]) {
    const fake = fakeDependencies();
    const collectPreparation = fake.deps.collectPreparation;
    const secret = `recovery-secret-${mode}`;
    fake.deps.collectPreparation = async (context) => ({
      ...(await collectPreparation(context)),
      privateRuntime: { secret },
    });
    let stateRef;
    const parent = scratch(t);
    const artifactRoot = path.join(parent, `run-${mode}`);
    const displaced = path.join(parent, `owned-${mode}`);
    const orchestrator = createBoundaryExperimentOrchestrator(fake.deps);
    const { prepared } = await reachEjectedRoute(orchestrator, artifactRoot);
    fake.deps.executeRecoveryStep = async (context) => {
      stateRef = context.state;
      fs.renameSync(artifactRoot, displaced);
      fs.mkdirSync(artifactRoot, { mode: 0o700 });
      fs.writeFileSync(path.join(artifactRoot, "actions.jsonl"), "attacker-owned\n", { mode: 0o600 });
      if (mode === "throw") throw new Error(`dependency exposed ${secret}`);
      return {
        kind: context.kind,
        structuralOk: true,
        beforeCapture: capture("7".repeat(64), path.join(context.captureDirectory, "before.png"), "recovery"),
        afterCapture: capture("8".repeat(64), path.join(context.captureDirectory, "after.png"), "recovery"),
        continuity: [continuity()],
        receipt: { logArtifact: fakeLogArtifact() },
        runtimeHealth: quietRuntimeHealth(),
        durationMs: 1,
      };
    };
    const failed = await orchestrator.execute({ action: "recover", runId: prepared.runId });
    assert.equal(failed.status, "recovery_failed");
    assert.equal(stateRef.preparation.privateRuntime, undefined);
    assert.equal(failed.error.includes(secret), false);
    assert.equal(fs.readFileSync(path.join(artifactRoot, "actions.jsonl"), "utf8"), "attacker-owned\n");
  }
});

test("the implementation imports the shared CP1 executor and registers exactly one full-only public tool", () => {
  const source = fs.readFileSync(new URL("../src/boundaryexperiment.ts", import.meta.url), "utf8");
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /executeRelativeCameraRoute/);
  assert.match(source, /sampleApplicationContinuity/);
  assert.match(source, /collectLogWindow/);
  assert.match(source, /executeCaptureSettled/);
  assert.equal((source.match(/runWithFinalizedLog\(\{/g) ?? []).length, 3);
  assert.equal((source.match(/const ownedLog = startOwnedLogWindow\(\{/g) ?? []).length, 3);
  assert.equal((source.match(/if \(!ownedLog\.started\(\)\)/g) ?? []).length, 3);
  assert.equal((source.match(/Math\.min\(LOG_WINDOW_MAX_DURATION_MS,/g) ?? []).length, 3,
    "prepare, waypoint, and recovery collectors must independently clamp their owned log lifetime");
  assert.equal(source.includes("collect: () =>"), false);
  assert.match(source, /executeRecoveryStep/);
  assert.match(source, /LOG_FINALIZATION_RESERVE_MS/);
  assert.match(source, /reboundTupleChanged: true/);
  const waypointCollector = source.indexOf("const ownedLog = startOwnedLogWindow({", source.indexOf("executeWaypoint:"));
  const waypointRecapture = source.indexOf("context.recaptureReviewedFrame()", source.indexOf("executeWaypoint:"));
  const waypointHealthSnapshot = source.indexOf("collectRuntimeHealthSnapshot({", waypointRecapture);
  const waypointMovement = source.indexOf("executeRelativeCameraRoute({", waypointHealthSnapshot);
  assert.ok(waypointCollector >= 0 && waypointCollector < waypointRecapture, "waypoint log child must start before the reviewed-frame recapture");
  assert.ok(waypointRecapture < waypointHealthSnapshot && waypointHealthSnapshot < waypointMovement, "gap crash/ANR snapshot must gate movement after recapture");
  const recoveryCollector = source.indexOf("const ownedLog = startOwnedLogWindow({", source.indexOf("executeRecoveryStep:"));
  const recoveryBeforeCapture = source.indexOf("`${prefix}-before.png`", recoveryCollector);
  assert.ok(recoveryCollector >= 0 && recoveryCollector < recoveryBeforeCapture, "recovery log child must start before its intervention pre-frame");
  assert.equal((source.match(/"logcat", "-b", "all", "-c"/g) ?? []).length, 1, "only fresh prepare may destructively reset logcat");
  assert.equal((source.match(/appStartMarker: coverageMarker/g) ?? []).length, 2, "waypoint and recovery windows start from the preceding end marker");
  assert.match(source, /live\.coverageMarker = nextCoverageMarker/);
  const forceReserveCheck = source.indexOf("if (remainingRecoveryMs() < forceCompletionReserveMs)");
  const destructiveForceStop = source.indexOf('"am", "force-stop"', forceReserveCheck);
  assert.ok(forceReserveCheck >= 0 && forceReserveCheck < destructiveForceStop, "the compensating completion reserve must be proven before force-stop");
  assert.equal((source.match(/server\.registerTool\(/g) ?? []).length, 1);
  assert.match(source, /"run_immersive_boundary_experiment"/);
  assert.match(index, /if \(!doorsSurfaceActive\(\)\)[\s\S]*registerBoundaryExperimentTools\(server\)[\s\S]*\}\s*registerDoorTools/);
});
