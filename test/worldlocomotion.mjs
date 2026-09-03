import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_BRIDGE_COMMANDS_COMMAND,
  AGENT_BRIDGE_HMD_POSE_COMMAND,
  AGENT_BRIDGE_LOCOMOTE_COMMAND,
  AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY,
  AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
  AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
  AGENT_BRIDGE_LOCOMOTION_ROOT_ID,
  AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
  probeAgentBridgeLocomotionCapability,
  requestAgentBridgeHmdPose,
  requestAgentBridgeLocomotion,
} from "../dist/agentbridge.js";
import {
  createInAppLocomotionOrchestrator,
  inAppLocomotionInputSchema,
  registerInAppLocomotionTools,
} from "../dist/worldlocomotion.js";
import * as worldLocomotion from "../dist/worldlocomotion.js";
import { readBoundReviewImage, readReceiptBoundEffectiveAppSpec } from "../dist/boundaryexperiment.js";
import { canonicalJson } from "../dist/runreceiptidentity.js";
import * as receiptStore from "../dist/runreceiptstore.js";
import { createRunReceiptFixture, makePng, sha256 } from "./helpers/runreceipt-fixture.mjs";

const HASH = "a".repeat(64);

function externalArtifactRoot(t, label = "run") {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pico-worldlocomotion-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, label);
}

function prepareRouteInput(t, overrides = {}) {
  return {
    action: "prepare",
    serial: "emulator-5554",
    scenario: {
      id: "fixture-full-stage",
      packageName: "com.test.fullworld",
      launchComponent: "com.test.fullworld/.platform.LaunchActivity",
      allowedResumedComponents: ["com.test.fullworld/.platform.LaunchActivity"],
      stageStyle: "3",
      rootContainer: "stage",
    },
    provenance: { kind: "native_run_receipt", receiptId: HASH, apkSha256: "b".repeat(64) },
    mechanism: "direct",
    route: {
      waypoints: [
        { seq: 1, target: { absolute: true, x: 1, y: 0, z: -2 } },
        { seq: 2, target: { absolute: true, x: 2, y: 0, z: -4 } },
      ],
      restoreTarget: { absolute: true, x: 0, y: 0, z: 0 },
      glideDurationMs: 500,
    },
    translationDriftThresholdM: 0.02,
    capture: {
      maxTries: 4,
      intervalMs: 25,
      attemptTimeoutMs: 1_000,
      deadlineMs: 8_000,
      comparison: "byte_exact",
    },
    budgets: {
      maxDurationMs: 180_000,
      routeReserveMs: 60_000,
      restorationReserveMs: 30_000,
    },
    priorForeground: { kind: "none" },
    artifactRoot: externalArtifactRoot(t),
    ...overrides,
  };
}

const reviewedFrame = { captureSha256: HASH, attestation: "LOOKed the exact retained PNG" };

test("in-app locomotion schema exposes exactly prepare, step, restore, and adjudicate strict arms", (t) => {
  const prepare = prepareRouteInput(t);
  for (const input of [
    prepare,
    { action: "step", runId: HASH, reviewedPriorFrame: reviewedFrame, waypoint: prepare.route.waypoints[0] },
    { action: "restore", runId: HASH, reviewedPriorFrame: reviewedFrame },
    { action: "adjudicate", runId: HASH, frameAttestations: [reviewedFrame] },
  ]) assert.equal(inAppLocomotionInputSchema.safeParse(input).success, true, input.action);

  for (const input of [
    { action: "recover", runId: HASH },
    { ...prepare, entityId: "arbitrary-root" },
    { ...prepare, physicalWalk: true },
    { action: "step", runId: HASH, reviewedPriorFrame: reviewedFrame, waypoint: prepare.route.waypoints[0], unknown: true },
  ]) assert.equal(inAppLocomotionInputSchema.safeParse(input).success, false);
});

test("prepare schema pins a Full stage, absolute finite contiguous route, zero restore, and exact policy literals", (t) => {
  const valid = prepareRouteInput(t);
  const badInputs = [
    { ...valid, serial: "2G0YC5ZF7Z056Q" },
    { ...valid, scenario: { ...valid.scenario, stageStyle: "1" } },
    { ...valid, scenario: { ...valid.scenario, rootContainer: "windowContainer" } },
    { ...valid, provenance: { ...valid.provenance, receiptId: "not-a-hash" } },
    { ...valid, mechanism: "implicit" },
    { ...valid, route: { ...valid.route, waypoints: [valid.route.waypoints[0], { ...valid.route.waypoints[1], seq: 1 }] } },
    { ...valid, route: { ...valid.route, waypoints: [{ ...valid.route.waypoints[0], seq: 2 }] } },
    { ...valid, route: { ...valid.route, waypoints: [valid.route.waypoints[0], { seq: 2, target: { absolute: true, x: 1.00000001, y: 0, z: -2 } }] } },
    { ...valid, route: { ...valid.route, waypoints: [{ seq: 1, target: { absolute: true, x: Number.MIN_VALUE, y: 0, z: 0 } }, { seq: 2, target: { absolute: true, x: -0, y: 0, z: 0 } }] } },
    { ...valid, route: { ...valid.route, waypoints: [{ ...valid.route.waypoints[0], target: { absolute: false, x: 1, y: 0, z: 0 } }] } },
    { ...valid, route: { ...valid.route, waypoints: [{ ...valid.route.waypoints[0], target: { absolute: true, x: Number.NaN, y: 0, z: 0 } }] } },
    { ...valid, route: { ...valid.route, waypoints: [{ ...valid.route.waypoints[0], target: { absolute: true, x: Number.MAX_VALUE, y: 0, z: 0 } }] } },
    { ...valid, route: { ...valid.route, restoreTarget: { absolute: true, x: 0, y: 0, z: 0.001 } } },
    { ...valid, translationDriftThresholdM: 0.021 },
    { ...valid, capture: { ...valid.capture, deadlineMs: 0 } },
    { ...valid, budgets: { ...valid.budgets, restorationReserveMs: valid.budgets.maxDurationMs } },
    { ...valid, budgets: { maxDurationMs: 97_999, routeReserveMs: 20_000, restorationReserveMs: 10_000 } },
    { ...valid, budgets: { maxDurationMs: 98_000, routeReserveMs: 20_000, restorationReserveMs: 10_000 } },
    { ...valid, budgets: { ...valid.budgets, routeReserveMs: valid.capture.deadlineMs } },
    { ...valid, budgets: { ...valid.budgets, restorationReserveMs: valid.capture.deadlineMs } },
    { ...valid, artifactRoot: path.join(process.cwd(), "owned-inside-repository") },
  ];
  for (const input of badInputs) assert.equal(inAppLocomotionInputSchema.safeParse(input).success, false);
});

test("non-Full and unknown-key prepare requests fail before any injected dependency is read", async (t) => {
  let dependencyReads = 0;
  const dependencies = new Proxy({}, {
    get() {
      dependencyReads += 1;
      throw new Error("dependency should not be read");
    },
  });
  const orchestrator = createInAppLocomotionOrchestrator(dependencies);
  await assert.rejects(
    orchestrator.execute(prepareRouteInput(t, {
      scenario: { ...prepareRouteInput(t).scenario, stageStyle: "1" },
      arbitraryEntityId: "AgentWorldRoot",
    })),
  );
  assert.equal(dependencyReads, 0);
});

const cleanSafety = Object.freeze({
  guardian: "1",
  vstComponent: "1",
  vstDebug: "1",
  stageStyle: "3",
  safeguard: "1",
  safeguardCenter: "0,0,0",
  virtualContent: "1",
});

const cleanMixedSafety = Object.freeze({
  ...cleanSafety,
  stageStyle: "1",
  safeguard: "0",
});

function exactContinuity(input, applicationBinding, bootId, observedAtMonotonicNs = "1000000") {
  return {
    observedAtMonotonicNs,
    serial: input.serial,
    bootId,
    packageName: applicationBinding.packageName,
    allowedResumedComponents: [...applicationBinding.allowedResumedComponents],
    apkSha256: applicationBinding.apkSha256,
    pid: applicationBinding.pid,
    pidStartTicks: applicationBinding.pidStartTicks,
    resumedComponents: [input.scenario.launchComponent],
    foreground: "exact_allowed",
    probeEventsSincePrior: [],
    probeParse: "absent",
    probeSequence: "unknown",
    watchdog: { status: "absent" },
  };
}

function successCapture(input, shade = 48) {
  const bytes = makePng(shade);
  fs.writeFileSync(input.outPath, bytes, { flag: "wx", mode: 0o600 });
  const digest = sha256(bytes);
  const captureRef = {
    path: fs.realpathSync(input.outPath),
    sha256: digest,
    bytes: bytes.length,
    width: 64,
    height: 64,
    dimensions: { width: 64, height: 64 },
    sourceSerial: input.serial,
    capturedAt: "2026-09-02T12:01:01.000Z",
  };
  return {
    receipt: {
      status: "settled",
      serial: input.serial,
      path: captureRef.path,
      sha256: digest,
      attempts: 2,
      settlementSatisfied: true,
      comparison: "byte_exact",
      stablePair: [digest, digest],
      mode: input.mode ?? "stable",
      deadlineMs: input.deadlineMs,
      attemptTimeoutMs: input.attemptTimeoutMs,
      deadlineMonotonicNs: "9000000000",
      trace: [],
      timeoutPhase: null,
      timeoutCause: null,
      captureRuntimeBinding: null,
      captureRef,
      lastValidCaptureRef: null,
      actionReceipts: [],
      error: null,
      evidenceCeiling: "structural",
      lookRequired: true,
    },
    frame: bytes,
  };
}

async function createPreparedFixture(t, options = {}) {
  const input = prepareRouteInput(t, options.inputOverrides ?? {});
  const receiptFixture = await createRunReceiptFixture(t, receiptStore, { app: input.scenario.packageName });
  const effectiveSpec = {
    ...receiptFixture.effectiveSpec,
    meta: {
      ...receiptFixture.effectiveSpec.meta,
      packageName: input.scenario.packageName,
      stageStyle: options.effectiveStageStyle ?? "3",
      rootContainer: options.effectiveRootContainer ?? "stage",
      secondaryContainers: [],
    },
  };
  const publishedSpec = receiptStore.publishEffectiveSpecArtifact(effectiveSpec, receiptFixture.storeOptions);
  const payload = structuredClone(receiptFixture.payload);
  payload.source.effectiveAppSpec = publishedSpec;
  payload.runtime.component = input.scenario.launchComponent;
  payload.capture.before.foregroundComponent = input.scenario.launchComponent;
  payload.capture.after.foregroundComponent = input.scenario.launchComponent;
  const publishedReceipt = receiptStore.publishNativeRunReceipt(payload, receiptFixture.storeOptions);
  input.provenance = {
    kind: "native_run_receipt",
    receiptId: publishedReceipt.receiptId,
    apkSha256: publishedReceipt.receipt.apk.sha256,
  };

  const calls = [];
  const applicationBinding = {
    packageName: input.scenario.packageName,
    apkSha256: input.provenance.apkSha256,
    allowedResumedComponents: [...input.scenario.allowedResumedComponents],
    pid: 5151,
    pidStartTicks: "123456789",
  };
  const bootId = publishedReceipt.receipt.runtime.bootId;
  const capabilityAck = {
    kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
    schemaVersion: AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
    capabilityRevision: AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
    requestId: "prepare_capability_0001",
    tag: "prepare",
    application: { packageName: input.scenario.packageName },
    operation: AGENT_BRIDGE_COMMANDS_COMMAND,
    physicalWalk: false,
    primaryError: null,
    cleanupError: null,
    outcome: "available",
    commands: [AGENT_BRIDGE_COMMANDS_COMMAND, AGENT_BRIDGE_HMD_POSE_COMMAND, AGENT_BRIDGE_LOCOMOTE_COMMAND],
    availability: {
      debuggable: true,
      observedStageStyle: "Full",
      rootContainer: "stage",
      rootRegistered: true,
      hmdAvailable: true,
      locomotionAvailable: true,
    },
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7 },
  };
  const pose = {
    readAtMonotonicNs: "2000000",
    position: { x: 0.1, y: 1.62, z: -0.2 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  const hmdPoseAck = {
    ...capabilityAck,
    requestId: "prepare_hmd_pose_0001",
    operation: AGENT_BRIDGE_HMD_POSE_COMMAND,
    outcome: "sampled",
    commands: undefined,
    availability: undefined,
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7 },
    hmdPose: pose,
  };
  delete hmdPoseAck.commands;
  delete hmdPoseAck.availability;

  let monotonicTick = 1_000_000_000n;
  let captureShade = 48;
  let hmdIndex = 0;
  let safetyIndex = 0;
  let continuityIndex = 0;
  const healthLogs = [];
  const dependencies = {
    randomBytes: (size) => {
      calls.push({ kind: "randomBytes", size });
      return Buffer.alloc(size, 7);
    },
    now: () => "2026-09-02T12:00:00.000Z",
    monotonicNs: () => {
      if (options.monotonicNs) return options.monotonicNs();
      monotonicTick += 1_000_000n;
      return monotonicTick;
    },
    readNativeRunReceipt: (app, receiptId) => {
      calls.push({ kind: "readReceipt", app, receiptId });
      return receiptStore.readNativeRunReceipt(app, receiptId, receiptFixture.storeOptions);
    },
    readEffectiveAppSpec: (artifactPath, identity) => {
      calls.push({ kind: "readSpec", artifactPath, identity });
      return readReceiptBoundEffectiveAppSpec(artifactPath, identity);
    },
    snapshotPriorForeground: async (context) => {
      calls.push({ kind: "snapshotPrior", context });
      return options.priorSnapshot ?? { component: null, packageName: null, userInstalled: false };
    },
    stopPackage: async (context) => {
      calls.push({ kind: "stop", context });
      if (options.stopError && context.reason === options.stopError.reason) throw new Error(options.stopError.message);
      return { status: "stopped", packageName: context.packageName };
    },
    launchTarget: async (context) => {
      calls.push({ kind: "launch", context });
      if (options.launchError) throw options.launchError;
      return { disposition: "accepted", component: context.component, outputSha256: sha256("Status: ok\n") };
    },
    probeRuntimeBinding: async (context) => {
      calls.push({ kind: "probeRuntime", context });
      if (options.bindingError) throw options.bindingError;
      return {
        liveIdentity: {
          serial: input.serial,
          model: publishedReceipt.receipt.runtime.model,
          fingerprint: publishedReceipt.receipt.runtime.fingerprint,
          bootQemu: "1",
          bootId,
          observedAt: "2026-09-02T12:00:01.000Z",
        },
        applicationBinding,
        foregroundComponent: input.scenario.launchComponent,
      };
    },
    sampleSafety: async (context) => {
      calls.push({ kind: "safety", context });
      if (options.safetySequence) return options.safetySequence[Math.min(safetyIndex++, options.safetySequence.length - 1)];
      return options.safety ?? { ...cleanSafety };
    },
    probeCapability: async (bridgeInput) => {
      calls.push({ kind: "capability", input: bridgeInput });
      return options.capability ?? {
        ok: true,
        ack: capabilityAck,
        primaryError: null,
        cleanupError: null,
        actionReceipts: [],
        evidenceCeiling: "structural",
      };
    },
    requestHmdPose: async (bridgeInput) => {
      calls.push({ kind: "hmd", input: bridgeInput });
      if (options.hmdSequence) return options.hmdSequence[Math.min(hmdIndex++, options.hmdSequence.length - 1)];
      if (options.hmd) return options.hmd;
      return {
        ok: true,
        ack: {
          ...hmdPoseAck,
          root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: bridgeInput.expectedRootGeneration },
        },
        primaryError: null,
        cleanupError: null,
        actionReceipts: [],
        evidenceCeiling: "structural",
      };
    },
    monitorFreshLaunch: async (context) => {
      calls.push({ kind: "monitor", context });
      const sample = (elapsedMs) => ({
        elapsedMs,
        dialogs: [],
        safety: { ...cleanSafety },
        continuity: exactContinuity(input, applicationBinding, bootId, String(3_000_000 + elapsedMs)),
        runtimeHealth: { status: "no_attributed_failure", incidents: [] },
      });
      const rawHealthLogs = [0, 1, 2, 3, 4].map((sampleIndex) => {
        const bytes = Buffer.from(`fresh launch sample ${sampleIndex}\n`, "utf8");
        const logPath = path.join(context.artifactRoot, "logs", `fresh-launch-${String(sampleIndex).padStart(2, "0")}.log`);
        fs.writeFileSync(logPath, bytes, { flag: "wx", mode: 0o600 });
        const evidence = { path: fs.realpathSync(logPath), sha256: sha256(bytes), bytes: bytes.length };
        healthLogs.push(evidence);
        return evidence;
      });
      const receipt = options.monitor ?? {
        durationMs: 60_000,
        samples: [sample(0), sample(15_000), sample(30_000), sample(45_000), sample(60_000)],
        rawHealthLogs,
      };
      options.afterMonitor?.(receipt);
      return receipt;
    },
    captureSettled: async (captureInput) => {
      calls.push({ kind: "capture", input: captureInput });
      if (options.captureResult) return options.captureResult(captureInput);
      const result = successCapture(captureInput, captureShade);
      captureShade += 1;
      return result;
    },
    readReviewImage: (item, artifactRoot) => {
      calls.push({ kind: "readReview", item, artifactRoot });
      return readBoundReviewImage(item, artifactRoot);
    },
    sampleContinuity: async (context) => {
      calls.push({ kind: "continuity", context });
      const exact = exactContinuity(input, applicationBinding, bootId);
      if (options.continuitySequence) return { ...exact, ...options.continuitySequence[Math.min(continuityIndex++, options.continuitySequence.length - 1)] };
      return exact;
    },
    requestLocomotion: async (bridgeInput) => {
      calls.push({ kind: "locomote", input: bridgeInput });
      if (typeof options.locomotionResult === "function") return options.locomotionResult(bridgeInput);
      if (options.locomotionResult) return options.locomotionResult;
      const target = Object.fromEntries(Object.entries(bridgeInput.target).map(([key, value]) => [key, Math.fround(value)]));
      const resultGeneration = bridgeInput.mode === "replacement" ? bridgeInput.rootGeneration + 1 : bridgeInput.rootGeneration;
      return {
        ok: true,
        ack: {
          kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
          schemaVersion: AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
          capabilityRevision: AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
          requestId: bridgeInput.requestId,
          tag: bridgeInput.tag,
          application: { packageName: bridgeInput.packageName },
          operation: AGENT_BRIDGE_LOCOMOTE_COMMAND,
          physicalWalk: false,
          primaryError: null,
          cleanupError: null,
          outcome: "completed",
          mode: bridgeInput.mode,
          target: { absolute: true, ...target },
          glideDurationMs: bridgeInput.glideDurationMs,
          rootGenerationBefore: bridgeInput.rootGeneration,
          pose: { rootGeneration: resultGeneration, position: target },
          hmdPose: null,
        },
        primaryError: null,
        cleanupError: null,
        actionReceipts: [],
        evidenceCeiling: "structural",
      };
    },
    emitMarker: async (context) => {
      calls.push({ kind: "marker", context });
    },
    collectStepLogs: async (context) => {
      calls.push({ kind: "logs", context });
      const bytes = Buffer.from(`${context.beginMarker}\n${context.endMarker}\n`, "utf8");
      fs.writeFileSync(context.path, bytes, { flag: "wx", mode: 0o600 });
      const isPrepare = context.beginMarker.endsWith("_PREPARE_BEGIN");
      return {
        path: fs.realpathSync(context.path),
        sha256: sha256(bytes),
        bytes: bytes.length,
        truncated: false,
        beginCount: 1,
        endCount: 1,
        boundarySignals: isPrepare && options.prepareBoundarySignals
          ? options.prepareBoundarySignals
          : !isPrepare && options.stepBoundarySignals
            ? options.stepBoundarySignals
            : {
          setSpatialContainerBoundary: 0,
          containerInfoChanged: 0,
          boundaryMin: 0,
          launcherResume: 0,
          appPauseOrEjection: 0,
        },
      };
    },
    relaunchPrior: async (context) => {
      calls.push({ kind: "relaunchPrior", context });
      return options.relaunchResult ?? {
        disposition: "accepted",
        component: context.component,
        outputSha256: sha256("Status: ok\n"),
        activityProbeSha256: sha256(`topResumedActivity=${context.component}\n`),
        resumedComponents: [context.component],
      };
    },
  };
  return { input, dependencies, calls, healthLogs, applicationBinding, bootId, pose, capabilityAck, publishedReceipt, effectiveSpec };
}

test("prepare binds the receipt/runtime in order, proves 60-second health, and returns one structural baseline review", async (t) => {
  const fixture = await createPreparedFixture(t);
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);

  const result = await orchestrator.execute(fixture.input);

  assert.equal(result.status, "needs_baseline_review");
  assert.equal(result.evidenceCeiling, "structural");
  assert.equal(result.lookRequired, true);
  assert.equal(result.requiredReview.length, 1);
  assert.equal(result.requiredReview[0].role, "app_baseline");
  assert.equal(result.rootGeneration, 7);
  assert.deepEqual(fixture.calls.map((call) => call.kind), [
    "readReceipt", "readSpec", "randomBytes", "snapshotPrior", "marker", "stop", "launch", "probeRuntime",
    "safety", "capability", "hmd", "monitor", "capture", "readReview", "marker", "logs",
  ]);
  const capabilityCall = fixture.calls.find((call) => call.kind === "capability").input;
  assert.equal(capabilityCall.serial, fixture.input.serial);
  assert.equal(capabilityCall.packageName, fixture.input.scenario.packageName);
  const monitorCall = fixture.calls.find((call) => call.kind === "monitor").context;
  assert.equal(monitorCall.minimumDurationMs, 60_000);
  const captureCall = fixture.calls.find((call) => call.kind === "capture").input;
  assert.equal(captureCall.mode, "stable");
  assert.equal("priorSha256" in captureCall, false);
  for (const entry of [".owner.json", "run.json", "route.json", "actions.jsonl", "captures", "logs"])
    assert.equal(fs.existsSync(path.join(fixture.input.artifactRoot, entry)), true, entry);
  assert.equal(fs.statSync(path.join(fixture.input.artifactRoot, "run.json")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "run.json"), "utf8")).evidenceCeiling, "structural");
  const prepareAction = JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim());
  assert.equal(prepareAction.runtime.liveIdentity.bootId, fixture.bootId);
  assert.equal(prepareAction.safetyBaseline.guardian, "1");
  assert.equal(prepareAction.capability.ack.root.generation, 7);
  assert.deepEqual(prepareAction.hmdBaseline.position, fixture.pose.position);
  assert.ok(prepareAction.freshLaunchMonitor.samples.at(-1).elapsedMs >= 60_000);
  assert.equal(prepareAction.captureReceipt.status, "settled");
  assert.equal(prepareAction.preparationLogEvidence.beginCount, 1);
  assert.equal(prepareAction.preparationLogEvidence.endCount, 1);
  assert.equal(fixture.calls.some((call) => call.kind === "locomote"), false);
});

test("prepare brackets and retains launch-handoff boundary evidence without applying the step zero-signal gate", async (t) => {
  const fixture = await createPreparedFixture(t, {
    prepareBoundarySignals: {
      setSpatialContainerBoundary: 1,
      containerInfoChanged: 1,
      boundaryMin: 0,
      launcherResume: 0,
      appPauseOrEjection: 0,
    },
  });
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "needs_baseline_review");
  const markers = fixture.calls.filter((call) => call.kind === "marker").map((call) => call.context.marker);
  assert.equal(markers.length, 2);
  assert.match(markers[0], /_PREPARE_BEGIN$/);
  assert.match(markers[1], /_PREPARE_END$/);
  const logCall = fixture.calls.find((call) => call.kind === "logs");
  assert.equal(logCall.context.beginMarker, markers[0]);
  assert.equal(logCall.context.endMarker, markers[1]);
  const action = JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim());
  assert.equal(action.preparationLogEvidence.boundarySignals.setSpatialContainerBoundary, 1);
  assert.equal(action.preparationLogEvidence.boundarySignals.containerInfoChanged, 1);
});

test("receipt-bound non-Full effective specs stop before foreground inspection or any live mutation", async (t) => {
  const fixture = await createPreparedFixture(t, { effectiveStageStyle: "1" });
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preflight_rejected");
  assert.equal(result.lookRequired, true);
  assert.match(result.primaryError, /Full.*stage|stageStyle/i);
  assert.deepEqual(fixture.calls.map((call) => call.kind), ["readReceipt", "readSpec"]);
  assert.equal(fs.existsSync(fixture.input.artifactRoot), false);
});

test("legacy capability fails as capability_unavailable before route mutation and cleans only the launched target", async (t) => {
  const fixture = await createPreparedFixture(t, {
    capability: {
      ok: false,
      code: "capability_unavailable",
      detail: "locomotion capability revision is unavailable",
      primaryError: "missing capability revision",
      cleanupError: null,
      actionReceipts: [],
      evidenceCeiling: "structural",
    },
  });
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.equal(result.structuralStop, "capability_unavailable");
  assert.match(result.primaryError, /capability revision/i);
  assert.equal(result.cleanupError, null);
  assert.equal(fixture.calls.filter((call) => call.kind === "locomote").length, 0);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
});

test("prepare retains bridge acknowledgement cleanup failure separately from its primary preflight failure", async (t) => {
  const fixture = await createPreparedFixture(t, {
    capability: {
      ok: false,
      code: "bridge_unavailable",
      detail: "capability command failed; acknowledgement cleanup failed",
      primaryError: "capability command failed",
      cleanupError: "acknowledgement rm failed",
      actionReceipts: [],
      evidenceCeiling: "structural",
    },
  });

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /capability command failed/i);
  assert.match(result.cleanupError, /acknowledgement rm failed/i);
});

test("binding, safety, dialog, and runtime-health failures all stop before route mutation", async (t) => {
  const cases = [
    ["binding", { bindingError: new Error("PID start identity changed") }],
    ["safety", { safety: { ...cleanSafety, guardian: "0" } }],
    ["dialog", { monitor: { durationMs: 60_000, samples: [{ elapsedMs: 60_000, dialogs: ["Application Error"], safety: cleanSafety, continuity: {}, runtimeHealth: { status: "no_attributed_failure", incidents: [] } }] } }],
    ["health", { monitor: { durationMs: 60_000, samples: [{ elapsedMs: 60_000, dialogs: [], safety: cleanSafety, continuity: {}, runtimeHealth: { status: "attributed_failure", incidents: [{ kind: "anr" }] } }] } }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async (t) => {
      const fixture = await createPreparedFixture(t, options);
      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "preparation_failed");
      assert.equal(fixture.calls.filter((call) => call.kind === "locomote").length, 0);
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
    });
  }
});

async function prepareForSteps(t, options = {}) {
  const fixture = await createPreparedFixture(t, options);
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
  const prepared = await orchestrator.execute(fixture.input);
  assert.equal(prepared.status, "needs_baseline_review");
  fixture.calls.length = 0;
  return { ...fixture, orchestrator, prepared, baselineReview: prepared.requiredReview[0] };
}

function reviewFor(item) {
  return { captureSha256: item.captureSha256, attestation: `LOOKed ${item.role} exact retained PNG` };
}

function stepRequest(fixture, review, waypointIndex = 0, overrides = {}) {
  return {
    action: "step",
    runId: fixture.prepared?.runId,
    reviewedPriorFrame: review,
    waypoint: structuredClone(fixture.input.route.waypoints[waypointIndex]),
    ...overrides,
  };
}

test("step follows the exact BEGIN-to-END evidence order and consumes one selected absolute waypoint", async (t) => {
  const fixture = await prepareForSteps(t);

  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(result.status, "needs_waypoint_review");
  assert.equal(result.waypointSeq, 1);
  assert.equal(result.rootGeneration, 7);
  assert.equal(result.requiredReview.length, 1);
  assert.equal(result.requiredReview[0].role, "waypoint");
  assert.equal(result.evidenceCeiling, "structural");
  assert.equal(result.lookRequired, true);
  assert.deepEqual(fixture.calls.map((call) => call.kind), [
    "readReview", "readReceipt", "readSpec", "marker", "safety", "continuity", "hmd", "locomote", "capture",
    "hmd", "safety", "continuity", "marker", "logs", "readReview",
  ]);
  assert.match(fixture.calls[3].context.marker, /_BEGIN$/);
  assert.match(fixture.calls[12].context.marker, /_END$/);
  const locomote = fixture.calls.find((call) => call.kind === "locomote").input;
  assert.equal(locomote.mode, "direct");
  assert.deepEqual(locomote.target, { x: 1, y: 0, z: -2 });
  assert.equal(locomote.rootGeneration, 7);
  assert.equal(locomote.glideDurationMs, 500);
  assert.equal(locomote.physicalWalk, false);
  const capture = fixture.calls.find((call) => call.kind === "capture").input;
  assert.equal(capture.mode, "transition_then_stable");
  assert.equal(capture.priorSha256, fixture.baselineReview.captureSha256);
  assert.equal(result.hmdDrift.translation.thresholdM, 0.02);
  assert.equal(result.hmdDrift.translation.pass, true);
  assert.equal(result.hmdDrift.quaternion.method, "2*acos(abs(normalized_dot))");
  assert.equal("threshold" in result.hmdDrift.quaternion, false);
  assert.equal(fs.existsSync(result.logEvidence.path), true);
  assert.equal(result.usage.waypointAttempts, 1);
  const stepAction = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(stepAction.pre.safety.guardian, "1");
  assert.equal(stepAction.pre.continuity.pid, fixture.applicationBinding.pid);
  assert.deepEqual(stepAction.pre.hmdPose.position, fixture.pose.position);
  assert.equal(stepAction.locomotion.ack.mode, "direct");
  assert.equal(stepAction.captureReceipt.mode, "transition_then_stable");
  assert.deepEqual(stepAction.post.hmdPose.position, fixture.pose.position);
  assert.equal(stepAction.post.safety.safeguard, "1");
  assert.equal(stepAction.post.continuity.foreground, "exact_allowed");
});

test("step refuses a wrong or byte-changed reviewed SHA before BEGIN or locomotion", async (t) => {
  const wrong = await prepareForSteps(t);
  const wrongResult = await wrong.orchestrator.execute(stepRequest(
    wrong,
    { captureSha256: "f".repeat(64), attestation: "LOOKed another frame" },
  ));
  assert.equal(wrongResult.status, "review_rejected");
  assert.equal(wrong.calls.length, 0);

  const tampered = await prepareForSteps(t);
  fs.writeFileSync(tampered.baselineReview.path, makePng(99));
  const tamperedResult = await tampered.orchestrator.execute(stepRequest(tampered, reviewFor(tampered.baselineReview)));
  assert.equal(tamperedResult.status, "review_rejected");
  assert.match(tamperedResult.primaryError, /retained|sha256|match/i);
  assert.deepEqual(tampered.calls.map((call) => call.kind), ["readReview"]);
});

test("step binds the caller-supplied exact next waypoint before every dependency and rejects stale selection", async (t) => {
  for (const [label, mutate] of [
    ["wrong sequence", (waypoint) => ({ ...waypoint, seq: 2 })],
    ["wrong target", (waypoint) => ({ ...waypoint, target: { ...waypoint.target, x: 1.25 } })],
  ]) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t);
      const waypoint = mutate(structuredClone(fixture.input.route.waypoints[0]));
      await assert.rejects(fixture.orchestrator.execute(stepRequest(
        fixture,
        reviewFor(fixture.baselineReview),
        0,
        { waypoint },
      )), /waypoint|sequence|target|planned/i);
      assert.equal(fixture.calls.length, 0);
    });
  }

  const canonical = await prepareForSteps(t);
  const canonicalized = await canonical.orchestrator.execute(stepRequest(
    canonical,
    reviewFor(canonical.baselineReview),
    0,
    { waypoint: { seq: 1, target: { absolute: true, x: 1.00000001, y: 0, z: -2 } } },
  ));
  assert.equal(canonicalized.status, "needs_waypoint_review");
  assert.deepEqual(canonical.calls.find((call) => call.kind === "locomote").input.target, { x: 1, y: 0, z: -2 });

  const stale = await prepareForSteps(t);
  const first = await stale.orchestrator.execute(stepRequest(stale, reviewFor(stale.baselineReview)));
  stale.calls.length = 0;
  await assert.rejects(stale.orchestrator.execute(stepRequest(
    stale,
    reviewFor(first.requiredReview[0]),
    0,
  )), /waypoint|sequence|target|planned/i);
  assert.equal(stale.calls.length, 0);
});

test("a returned waypoint SHA must be explicitly reviewed before the next route mutation", async (t) => {
  const fixture = await prepareForSteps(t);
  const first = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  fixture.calls.length = 0;

  const stale = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview), 1));
  assert.equal(stale.status, "review_rejected");
  assert.equal(fixture.calls.length, 0);

  const second = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(first.requiredReview[0]), 1));
  assert.equal(second.waypointSeq, 2);
  assert.equal(fixture.calls.filter((call) => call.kind === "locomote").length, 1);
});

function failedCapture(captureInput, code = "transition_timeout") {
  return {
    receipt: {
      status: "timeout",
      serial: captureInput.serial,
      path: null,
      sha256: null,
      attempts: 4,
      settlementSatisfied: false,
      comparison: "byte_exact",
      stablePair: null,
      mode: "transition_then_stable",
      deadlineMs: captureInput.deadlineMs,
      attemptTimeoutMs: captureInput.attemptTimeoutMs,
      deadlineMonotonicNs: "9000000000",
      trace: [],
      timeoutPhase: code === "transition_timeout" ? "awaiting_transition" : "awaiting_stability",
      timeoutCause: "deadline",
      captureRuntimeBinding: null,
      captureRef: null,
      lastValidCaptureRef: null,
      actionReceipts: [],
      error: { code, detail: `${code} fixture` },
      evidenceCeiling: "structural",
      lookRequired: true,
    },
    frame: null,
  };
}

function completedMovementResult(input, { cleanupOnly = false } = {}) {
  const target = Object.fromEntries(Object.entries(input.target).map(([key, value]) => [key, Math.fround(value)]));
  const resultGeneration = input.mode === "replacement" ? input.rootGeneration + 1 : input.rootGeneration;
  const ack = {
    kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
    schemaVersion: AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
    capabilityRevision: AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
    requestId: input.requestId,
    tag: input.tag,
    application: { packageName: input.packageName },
    operation: AGENT_BRIDGE_LOCOMOTE_COMMAND,
    physicalWalk: false,
    primaryError: null,
    cleanupError: null,
    outcome: "completed",
    mode: input.mode,
    target: { absolute: true, ...target },
    glideDurationMs: input.glideDurationMs,
    rootGenerationBefore: input.rootGeneration,
    pose: { rootGeneration: resultGeneration, position: target },
    hmdPose: null,
  };
  return cleanupOnly
    ? {
        ok: false,
        code: "cleanup_failed",
        detail: "acknowledgement cleanup failed",
        ack,
        primaryError: null,
        cleanupError: "acknowledgement rm failed",
        actionReceipts: [],
        evidenceCeiling: "structural",
      }
    : {
        ok: true,
        ack,
        primaryError: null,
        cleanupError: null,
        actionReceipts: [],
        evidenceCeiling: "structural",
      };
}

test("cleanup-only completed step adopts direct/replacement readback, captures evidence, and restores from the new generation", async (t) => {
  for (const mechanism of ["direct", "replacement"]) {
    await t.test(mechanism, async (t) => {
      const fixture = await prepareForSteps(t, {
        inputOverrides: {
          mechanism,
          route: {
            waypoints: [
              { seq: 1, target: { absolute: true, x: 1, y: 0, z: -2 } },
              { seq: 2, target: { absolute: true, x: 2, y: 0, z: -4 } },
            ],
            restoreTarget: { absolute: true, x: 0, y: 0, z: 0 },
            glideDurationMs: mechanism === "replacement" ? 0 : 500,
          },
        },
        locomotionResult: (input) => completedMovementResult(input, { cleanupOnly: true }),
      });
      const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
      const expectedGeneration = mechanism === "replacement" ? 8 : 7;
      assert.equal(stepped.status, "stopped");
      assert.equal(stepped.structuralStop, "cleanup_failed");
      assert.equal(stepped.primaryError, null);
      assert.match(stepped.cleanupError, /acknowledgement rm failed/i);
      assert.equal(stepped.rootGeneration, expectedGeneration);
      assert.equal(stepped.requiredReview[0].role, "waypoint");
      assert.equal(fixture.calls.filter((call) => call.kind === "capture").length, 1);
      assert.equal(fixture.calls.filter((call) => call.kind === "hmd").length, 2);

      fixture.dependencies.requestLocomotion = async (input) => {
        fixture.calls.push({ kind: "locomote", input });
        return completedMovementResult(input);
      };
      fixture.calls.length = 0;
      const restored = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
      });
      assert.equal(restored.status, "restored_needs_review");
      assert.equal(fixture.calls.find((call) => call.kind === "locomote").input.rootGeneration, expectedGeneration);
    });
  }
});

test("cleanup-only completed restore keeps primary null while adopting replacement generation and capture", async (t) => {
  const fixture = await prepareForSteps(t, {
    inputOverrides: {
      mechanism: "replacement",
      route: {
        waypoints: [
          { seq: 1, target: { absolute: true, x: 1, y: 0, z: -2 } },
          { seq: 2, target: { absolute: true, x: 2, y: 0, z: -4 } },
        ],
        restoreTarget: { absolute: true, x: 0, y: 0, z: 0 },
        glideDurationMs: 0,
      },
    },
    locomotionResult: (input) => completedMovementResult(input, { cleanupOnly: true }),
  });
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(restored.status, "restore_failed");
  assert.equal(restored.primaryError, null);
  assert.match(restored.cleanupError, /acknowledgement rm failed/i);
  assert.equal(restored.rootGeneration, 8);
  assert.equal(restored.requiredReview[0].role, "recovery");
  assert.equal(fixture.calls.filter((call) => call.kind === "capture").length, 1);
});

test("step failures stop structurally, retain usage, and never try another mechanism or physical route", async (t) => {
  const cases = [
    ["root readback", {
      locomotionResult: (input) => ({
        ok: true,
        ack: {
          kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND, schemaVersion: 1, capabilityRevision: 1,
          requestId: input.requestId, tag: input.tag, application: { packageName: input.packageName },
          operation: AGENT_BRIDGE_LOCOMOTE_COMMAND, physicalWalk: false, primaryError: null, cleanupError: null,
          outcome: "completed", mode: input.mode, target: { absolute: true, ...input.target }, glideDurationMs: input.glideDurationMs,
          rootGenerationBefore: input.rootGeneration, pose: { rootGeneration: input.rootGeneration + 9, position: input.target }, hmdPose: null,
        },
        primaryError: null, cleanupError: null, actionReceipts: [], evidenceCeiling: "structural",
      }),
    }],
    ["transition timeout", { captureResult: (input) => input.mode === "stable" ? successCapture(input, 48) : failedCapture(input, "transition_timeout") }],
    ["stability timeout", { captureResult: (input) => input.mode === "stable" ? successCapture(input, 48) : failedCapture(input, "stability_timeout") }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t, options);
      const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
      assert.equal(result.status, "stopped");
      assert.equal(result.usage.waypointAttempts, 1);
      const moves = fixture.calls.filter((call) => call.kind === "locomote");
      assert.ok(moves.length <= 1);
      assert.ok(moves.every((call) => call.input.mode === fixture.input.mechanism && call.input.physicalWalk === false));
      assert.equal(fixture.calls.filter((call) => call.kind === "marker" && /_END$/.test(call.context.marker)).length, 1);
      assert.equal(fixture.calls.filter((call) => call.kind === "logs").length, 1);
      assert.ok(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").includes("waypointAttempts"));
    });
  }
});

test("one verified boundary phrase inside a step bracket structurally stops the route", async (t) => {
  const fixture = await prepareForSteps(t, {
    stepBoundarySignals: {
      setSpatialContainerBoundary: 0,
      containerInfoChanged: 1,
      boundaryMin: 0,
      launcherResume: 0,
      appPauseOrEjection: 0,
    },
  });
  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(result.status, "stopped");
  assert.match(result.cleanupError, /boundary|container|log/i);
});

test("step gates safety, continuity, finite HMD telemetry, 0.02m Euclidean drift, and route budget", async (t) => {
  const makeHmd = (input, position) => ({
    ok: true,
    ack: {
      kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND, schemaVersion: 1, capabilityRevision: 1,
      requestId: input.requestId, tag: input.tag, application: { packageName: input.packageName },
      operation: AGENT_BRIDGE_HMD_POSE_COMMAND, physicalWalk: false, primaryError: null, cleanupError: null,
      outcome: "sampled", root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7 },
      hmdPose: { readAtMonotonicNs: "4000000", position, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    },
    primaryError: null, cleanupError: null, actionReceipts: [], evidenceCeiling: "structural",
  });
  const cases = [
    ["safety", { safetySequence: [cleanSafety, cleanSafety, { ...cleanSafety, safeguard: "0" }] }],
    ["continuity", { continuitySequence: [{ foreground: "different_package" }] }],
    ["nonfinite HMD", {}],
    ["translation drift", {}],
    ["budget", { afterPrepare: (fixture) => { fixture.dependencies.monotonicNs = () => 9_000_000_000_000_000n; } }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t, options);
      if (label === "nonfinite HMD") {
        fixture.dependencies.requestHmdPose = async (input) => {
          fixture.calls.push({ kind: "hmd", input });
          return makeHmd(input, { x: Number.NaN, y: 1.62, z: -0.2 });
        };
      }
      if (label === "translation drift") {
        fixture.dependencies.requestHmdPose = async (input) => {
          const index = fixture.calls.filter((call) => call.kind === "hmd").length;
          fixture.calls.push({ kind: "hmd", input });
          return makeHmd(input, index === 0 ? fixture.pose.position : { ...fixture.pose.position, x: fixture.pose.position.x + 0.0201 });
        };
      }
      options.afterPrepare?.(fixture);
      const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
      assert.equal(result.status, "stopped");
      assert.match(result.primaryError, label === "translation drift" ? /0\.02|drift/i : /safety|continuity|HMD|budget|deadline|binding/i);
      assert.equal(fixture.calls.filter((call) => call.kind === "locomote" && call.input.mode !== fixture.input.mechanism).length, 0);
    });
  }
});

test("concurrent step mutation is rejected while the first selected locomotion is in flight", async (t) => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const fixture = await prepareForSteps(t, { locomotionResult: async (input) => {
    await barrier;
    const target = input.target;
    return {
      ok: true,
      ack: {
        kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND, schemaVersion: 1, capabilityRevision: 1,
        requestId: input.requestId, tag: input.tag, application: { packageName: input.packageName }, operation: AGENT_BRIDGE_LOCOMOTE_COMMAND,
        physicalWalk: false, primaryError: null, cleanupError: null, outcome: "completed", mode: input.mode,
        target: { absolute: true, ...target }, glideDurationMs: input.glideDurationMs, rootGenerationBefore: input.rootGeneration,
        pose: { rootGeneration: input.rootGeneration, position: target }, hmdPose: null,
      },
      primaryError: null, cleanupError: null, actionReceipts: [], evidenceCeiling: "structural",
    };
  } });
  const first = fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  const firstSettled = first.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  for (let attempt = 0; attempt < 100 && !fixture.calls.some((call) => call.kind === "locomote"); attempt += 1)
    await new Promise((resolve) => setImmediate(resolve));
  if (!fixture.calls.some((call) => call.kind === "locomote")) {
    const settled = await firstSettled;
    assert.fail(`first step never reached locomotion: ${settled.ok ? "completed early" : settled.error.message}`);
  }
  await assert.rejects(
    fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview))),
    /already in progress/i,
  );
  release();
  const settled = await firstSettled;
  if (!settled.ok) throw settled.error;
  assert.equal(settled.value.status, "needs_waypoint_review");
});

test("restore is available from prepared, stepped, and stopped and selects capture mode from the reviewed frame", async (t) => {
  for (const startingState of ["prepared", "stepped", "stopped"]) {
    await t.test(startingState, async (t) => {
      const fixture = await prepareForSteps(t);
      let currentReview = fixture.baselineReview;
      if (startingState === "stepped") {
        const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(currentReview)));
        assert.equal(stepped.status, "needs_waypoint_review");
        currentReview = stepped.requiredReview[0];
      }
      if (startingState === "stopped") {
        const normalCapture = fixture.dependencies.captureSettled;
        fixture.dependencies.captureSettled = async (input) => {
          fixture.calls.push({ kind: "capture", input });
          return failedCapture(input, "transition_timeout");
        };
        const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(currentReview)));
        assert.equal(stopped.status, "stopped");
        fixture.dependencies.captureSettled = normalCapture;
      }
      fixture.calls.length = 0;

      const restored = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(currentReview),
      });

      assert.equal(restored.status, "restored_needs_review");
      assert.equal(restored.evidenceCeiling, "structural");
      assert.equal(restored.lookRequired, true);
      assert.equal(restored.requiredReview.length, 1);
      assert.equal(restored.requiredReview[0].role, "recovery");
      assert.deepEqual(fixture.calls.map((call) => call.kind), [
        "readReview", "readReceipt", "readSpec", "locomote", "capture", "readReview", "stop", "safety",
      ]);
      const move = fixture.calls.find((call) => call.kind === "locomote").input;
      assert.equal(move.mode, fixture.input.mechanism);
      assert.deepEqual(move.target, { x: 0, y: 0, z: 0 });
      assert.equal(move.physicalWalk, false);
      const capture = fixture.calls.find((call) => call.kind === "capture").input;
      const reviewedMovedFrame = startingState === "stepped";
      assert.equal(capture.mode, reviewedMovedFrame ? "transition_then_stable" : "stable");
      assert.equal("priorSha256" in capture, reviewedMovedFrame);
      if (reviewedMovedFrame) assert.equal(capture.priorSha256, currentReview.captureSha256);
      const stops = fixture.calls.filter((call) => call.kind === "stop");
      assert.equal(stops.length, 1);
      assert.deepEqual({
        serial: stops[0].context.serial,
        packageName: stops[0].context.packageName,
        reason: stops[0].context.reason,
      }, {
        serial: fixture.input.serial,
        packageName: fixture.input.scenario.packageName,
        reason: "restore_run_owned_target",
      });
      assert.ok(stops[0].context.timeoutMs > 0);
      assert.equal(restored.priorForeground.receiptFreshness, "not_evaluated_cp1");
      const restoreAction = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.deepEqual(restoreAction.locomotion.ack.target, { absolute: true, x: 0, y: 0, z: 0 });
      assert.equal(restoreAction.captureReceipt.mode, reviewedMovedFrame ? "transition_then_stable" : "stable");
      assert.equal(restoreAction.postStopSafety.guardian, "1");
    });
  }
});

test("restore rejects a wrong or changed current review before any mutation and is once-only after an attempt", async (t) => {
  const wrong = await prepareForSteps(t);
  const wrongResult = await wrong.orchestrator.execute({
    action: "restore",
    runId: wrong.prepared.runId,
    reviewedPriorFrame: { captureSha256: "f".repeat(64), attestation: "LOOKed the wrong frame" },
  });
  assert.equal(wrongResult.status, "review_rejected");
  assert.equal(wrong.calls.length, 0);

  const tampered = await prepareForSteps(t);
  fs.writeFileSync(tampered.baselineReview.path, makePng(99));
  const tamperedResult = await tampered.orchestrator.execute({
    action: "restore",
    runId: tampered.prepared.runId,
    reviewedPriorFrame: reviewFor(tampered.baselineReview),
  });
  assert.equal(tamperedResult.status, "review_rejected");
  assert.deepEqual(tampered.calls.map((call) => call.kind), ["readReview"]);

  const once = await prepareForSteps(t);
  await once.orchestrator.execute({
    action: "restore",
    runId: once.prepared.runId,
    reviewedPriorFrame: reviewFor(once.baselineReview),
  });
  const callCount = once.calls.length;
  await assert.rejects(
    once.orchestrator.execute({
      action: "restore",
      runId: once.prepared.runId,
      reviewedPriorFrame: reviewFor(once.baselineReview),
    }),
    /once|already|out of order|does not own/i,
  );
  assert.equal(once.calls.length, callCount);
});

test("restore withholds a receipt-bound prior and records exact known-stale provenance", async (t) => {
  const component = "com.prior.receipted/.MainActivity";
  const receiptId = "b".repeat(64);
  const fixture = await prepareForSteps(t, {
    inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId } },
    priorSnapshot: { component, packageName: "com.prior.receipted", userInstalled: true },
    safetySequence: [cleanSafety, cleanMixedSafety],
  });
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });

  assert.deepEqual(restored.priorForeground, {
    kind: "receipt_bound",
    component,
    receiptId,
    receiptFreshness: "known_stale",
    relaunchDisposition: "withheld_receipt_bound",
  });
  assert.equal(fixture.calls.some((call) => call.kind === "relaunchPrior"), false);
});

test("restore may relaunch one explicitly declared non-receipt-bound prior component and records disposition", async (t) => {
  const component = "com.prior.unbound/.MainActivity";
  const fixture = await prepareForSteps(t, {
    inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
    priorSnapshot: { component, packageName: "com.prior.unbound", userInstalled: true },
    safetySequence: [cleanSafety, cleanMixedSafety],
  });
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });

  const launches = fixture.calls.filter((call) => call.kind === "relaunchPrior");
  assert.equal(launches.length, 1);
  assert.equal(launches[0].context.serial, fixture.input.serial);
  assert.equal(launches[0].context.component, component);
  assert.ok(launches[0].context.timeoutMs > 0);
  assert.deepEqual(restored.priorForeground, {
    kind: "non_receipt_bound",
    component,
    receiptId: null,
    receiptFreshness: "not_evaluated_cp1",
    relaunchDisposition: "accepted",
  });
  assert.ok(fixture.calls.findIndex((call) => call.kind === "relaunchPrior")
    < fixture.calls.findIndex((call) => call.kind === "safety"), "final safety is sampled after prior disposition");
});

test("restore retains the primary restoration failure separately from exactly-once cleanup failures", async (t) => {
  const fixture = await prepareForSteps(t);
  fixture.dependencies.requestLocomotion = async (input) => {
    fixture.calls.push({ kind: "locomote", input });
    throw new Error("restore locomotion transport failed");
  };
  fixture.dependencies.stopPackage = async (context) => {
    fixture.calls.push({ kind: "stop", context });
    throw new Error("owned target stop failed");
  };
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });

  assert.equal(restored.status, "restore_failed");
  assert.match(restored.primaryError, /locomotion transport failed/i);
  assert.match(restored.cleanupError, /owned target stop failed/i);
  assert.equal(fixture.calls.filter((call) => call.kind === "locomote").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "safety").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "capture").length, 0);
});

async function prepareAndRestoreForAdjudication(t, { step = true } = {}) {
  const fixture = await prepareForSteps(t);
  let currentReview = fixture.baselineReview;
  if (step) {
    const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(currentReview)));
    assert.equal(stepped.status, "needs_waypoint_review");
    currentReview = stepped.requiredReview[0];
  }
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(currentReview),
  });
  assert.equal(restored.status, "restored_needs_review");
  const retained = [fixture.baselineReview];
  if (step) retained.push(currentReview);
  retained.push(restored.requiredReview[0]);
  fixture.calls.length = 0;
  return { ...fixture, restored, retained };
}

function attestationsFor(items) {
  return items.map((item) => ({
    captureSha256: item.captureSha256,
    attestation: `Human LOOK attestation for ${item.role}${item.waypointSeq ?? ""}`,
  }));
}

test("adjudicate requires completed restore and a complete unique exact capture-hash set", async (t) => {
  const beforeRestore = await prepareForSteps(t);
  await assert.rejects(
    beforeRestore.orchestrator.execute({
      action: "adjudicate",
      runId: beforeRestore.prepared.runId,
      frameAttestations: attestationsFor([beforeRestore.baselineReview]),
    }),
    /completed restore|out of order/i,
  );
  assert.equal(beforeRestore.calls.length, 0);

  const fixture = await prepareAndRestoreForAdjudication(t);
  const valid = attestationsFor(fixture.retained);
  for (const frameAttestations of [
    valid.slice(0, -1),
    [valid[0], valid[0], ...valid.slice(2)],
    [...valid, { captureSha256: "f".repeat(64), attestation: "LOOKed unrelated frame" }],
  ]) {
    const rejected = await fixture.orchestrator.execute({
      action: "adjudicate",
      runId: fixture.prepared.runId,
      frameAttestations,
    });
    assert.equal(rejected.status, "adjudication_rejected");
    assert.match(rejected.primaryError, /complete|unique|exact|missing|extra/i);
    assert.equal(fixture.calls.length, 0);
  }
});

test("adjudicate re-hashes every retained PNG and rejects any immutable-byte change", async (t) => {
  const fixture = await prepareAndRestoreForAdjudication(t);
  fs.writeFileSync(fixture.retained[0].path, makePng(111));

  const result = await fixture.orchestrator.execute({
    action: "adjudicate",
    runId: fixture.prepared.runId,
    frameAttestations: attestationsFor(fixture.retained),
  });

  assert.equal(result.status, "adjudication_rejected");
  assert.match(result.primaryError, /retained|sha256|immutable|bytes/i);
  assert.equal(fixture.calls.filter((call) => call.kind === "readReview").length, fixture.retained.length);
  assert.equal(fs.existsSync(path.join(fixture.input.artifactRoot, "adjudication.json")), false);
});

test("adjudicate emits immutable structural-only aggregation with external-vision eligibility wording", async (t) => {
  const fixture = await prepareAndRestoreForAdjudication(t);

  const result = await fixture.orchestrator.execute({
    action: "adjudicate",
    runId: fixture.prepared.runId,
    frameAttestations: attestationsFor(fixture.retained),
  });

  assert.equal(result.status, "structural_complete");
  assert.equal(result.evidenceCeiling, "structural");
  assert.equal(result.lookRequired, true);
  assert.equal(result.visionEligible, true);
  assert.equal(result.reviewDisposition, "eligible_for_external_vision_adjudication");
  assert.equal(result.captureCount, fixture.retained.length);
  assert.equal(fixture.calls.filter((call) => call.kind === "readReview").length, fixture.retained.length);
  assert.equal(result.artifactPath, path.join(fixture.restored.artifactRoot, "adjudication.json"));
  assert.equal(fs.statSync(result.artifactPath).mode & 0o777, 0o600);
  const manifest = JSON.parse(fs.readFileSync(result.artifactPath, "utf8"));
  assert.equal(manifest.captureCount, fixture.retained.length);
  assert.equal(manifest.evidenceCeiling, "structural");
  for (const serialized of [JSON.stringify(result), JSON.stringify(manifest)]) {
    assert.doesNotMatch(serialized, /vision_verified|device_verified/);
  }
  const callCount = fixture.calls.length;
  await assert.rejects(
    fixture.orchestrator.execute({
      action: "adjudicate",
      runId: fixture.prepared.runId,
      frameAttestations: attestationsFor(fixture.retained),
    }),
    /once|already|out of order/i,
  );
  assert.equal(fixture.calls.length, callCount);
});

test("registration adds one named tool and executes entirely through supplied fake dependencies", async (t) => {
  const fixture = await createPreparedFixture(t);
  const registrations = [];
  const server = {
    registerTool(name, definition, handler) {
      registrations.push({ name, definition, handler });
    },
  };

  registerInAppLocomotionTools(server, fixture.dependencies);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "run_in_app_locomotion_route");
  assert.equal(registrations[0].definition.inputSchema, inAppLocomotionInputSchema);
  assert.equal(fixture.calls.length, 0, "registration must not construct or touch live adb dependencies");
  const response = await registrations[0].handler(fixture.input);
  assert.equal(response.content.filter((item) => item.type === "image").length, 1);
  const text = response.content.find((item) => item.type === "text").text;
  assert.match(text, /needs_baseline_review/);
  assert.match(text, /"evidenceCeiling": "structural"/);
  assert.equal(fixture.calls.some((call) => call.kind === "adb" || call.kind === "live"), false);
});

test("immutable run manifests are revalidated before a reviewed route mutation", async (t) => {
  const fixture = await prepareForSteps(t);
  fs.writeFileSync(path.join(fixture.input.artifactRoot, "run.json"), "{}\n");

  await assert.rejects(
    fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview))),
    /manifest|artifact|changed|immutable/i,
  );
  assert.equal(fixture.calls.some((call) => call.kind === "marker" || call.kind === "locomote"), false);
});

test("step and restore re-read authoritative receipt/AppSpec bytes before any command", async (t) => {
  const stepFixture = await prepareForSteps(t);
  fs.writeFileSync(stepFixture.publishedReceipt.receiptPath, "{}\n");
  await assert.rejects(stepFixture.orchestrator.execute(stepRequest(
    stepFixture,
    reviewFor(stepFixture.baselineReview),
  )), /receipt|invalid|binding|immutable|sha/i);
  assert.equal(stepFixture.calls.some((call) => call.kind === "marker" || call.kind === "locomote"), false);

  const restoreFixture = await prepareForSteps(t);
  fs.unlinkSync(restoreFixture.publishedReceipt.receipt.source.effectiveAppSpec.artifactPath);
  await assert.rejects(restoreFixture.orchestrator.execute({
    action: "restore",
    runId: restoreFixture.prepared.runId,
    reviewedPriorFrame: reviewFor(restoreFixture.baselineReview),
  }), /AppSpec|spec|ENOENT|receipt|artifact/i);
  assert.equal(restoreFixture.calls.some((call) => call.kind === "locomote" || call.kind === "stop"), false);
});

test("a substituted still-valid receipt object cannot change the cached prepare binding", async (t) => {
  const fixture = await prepareForSteps(t);
  const original = fixture.dependencies.readNativeRunReceipt;
  fixture.dependencies.readNativeRunReceipt = (app, receiptId) => {
    const validation = original(app, receiptId);
    assert.equal(validation.status, "valid");
    return {
      ...validation,
      receipt: {
        ...validation.receipt,
        runtime: { ...validation.receipt.runtime, bootId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
      },
    };
  };
  fixture.calls.length = 0;
  await assert.rejects(fixture.orchestrator.execute(stepRequest(
    fixture,
    reviewFor(fixture.baselineReview),
  )), /receipt|binding|changed|cached|boot/i);
  assert.equal(fixture.calls.some((call) => call.kind === "marker" || call.kind === "locomote"), false);
});

test("retained bounded step logs are re-hashed before a later restoration mutation", async (t) => {
  const fixture = await prepareForSteps(t);
  const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stepped.status, "needs_waypoint_review");
  fs.writeFileSync(stepped.logEvidence.path, "substituted log bytes\n");
  fixture.calls.length = 0;

  await assert.rejects(
    fixture.orchestrator.execute({
      action: "restore",
      runId: fixture.prepared.runId,
      reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
    }),
    /log.*(?:changed|immutable)|immutable.*log/i,
  );
  assert.deepEqual(fixture.calls.map((call) => call.kind), ["readReview"]);
});

test("concurrent mutations on one exact serial are rejected even across distinct artifact roots", async (t) => {
  const fixture = await createPreparedFixture(t);
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
  const secondInput = { ...fixture.input, artifactRoot: externalArtifactRoot(t, "second-run") };
  const originalSnapshot = fixture.dependencies.snapshotPriorForeground;
  let releaseFirst;
  let signalFirst;
  let snapshotCount = 0;
  const firstEntered = new Promise((resolve) => { signalFirst = resolve; });
  const firstBarrier = new Promise((resolve) => { releaseFirst = resolve; });
  fixture.dependencies.snapshotPriorForeground = async (context) => {
    snapshotCount += 1;
    if (snapshotCount === 1) {
      signalFirst();
      await firstBarrier;
    }
    return originalSnapshot(context);
  };

  const first = orchestrator.execute(fixture.input);
  await firstEntered;
  let rejectionAssertion;
  try {
    await assert.rejects(orchestrator.execute(secondInput), /serial.*(?:progress|mutation)|mutation.*serial/i);
  } catch (error) {
    rejectionAssertion = error;
  } finally {
    releaseFirst();
  }
  assert.equal((await first).status, "needs_baseline_review");
  if (rejectionAssertion) throw rejectionAssertion;
});

test("a terminal post-capture step makes its returned frame the exact stopped-state restore review", async (t) => {
  const fixture = await prepareForSteps(t, {
    safetySequence: [cleanSafety, cleanSafety, { ...cleanSafety, safeguard: "0" }],
  });
  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.requiredReview[0].role, "waypoint");
  fixture.dependencies.sampleSafety = async (context) => {
    fixture.calls.push({ kind: "safety", context });
    return { ...cleanSafety };
  };
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });

  assert.equal(restored.status, "restored_needs_review");
  assert.equal(fixture.calls[0].kind, "readReview");
  assert.equal(fixture.calls[0].item.captureSha256, stopped.requiredReview[0].captureSha256);
});

test("a target launch attempt is cleanup-owned even when the launch dependency throws", async (t) => {
  const fixture = await createPreparedFixture(t, { launchError: new Error("launch transport failed") });

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /launch transport failed/i);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
});

test("step rejects an additional mutation once every planned waypoint has been consumed", async (t) => {
  const fixture = await prepareForSteps(t);
  const first = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  const second = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(first.requiredReview[0]), 1));
  assert.equal(second.status, "route_complete_needs_restore");
  fixture.calls.length = 0;

  await assert.rejects(
    fixture.orchestrator.execute(stepRequest(fixture, reviewFor(second.requiredReview[0]), 1)),
    /route.*complete|out of order/i,
  );
  assert.equal(fixture.calls.length, 0);
});

test("prepare preflight rejects Float32 overflow and impossible total budget without reading dependencies", async (t) => {
  let dependencyReads = 0;
  const dependencies = new Proxy({}, {
    get() {
      dependencyReads += 1;
      throw new Error("dependency should not be read");
    },
  });
  const orchestrator = createInAppLocomotionOrchestrator(dependencies);
  const valid = prepareRouteInput(t);
  for (const input of [
    { ...valid, route: { ...valid.route, waypoints: [{ ...valid.route.waypoints[0], target: { absolute: true, x: Number.MAX_VALUE, y: 0, z: 0 } }] } },
    { ...valid, artifactRoot: externalArtifactRoot(t, "budget"), budgets: { maxDurationMs: 97_999, routeReserveMs: 20_000, restorationReserveMs: 10_000 } },
    { ...valid, artifactRoot: externalArtifactRoot(t, "exact-budget"), budgets: { maxDurationMs: 98_000, routeReserveMs: 20_000, restorationReserveMs: 10_000 } },
    { ...valid, artifactRoot: externalArtifactRoot(t, "route-reserve"), budgets: { ...valid.budgets, routeReserveMs: valid.capture.deadlineMs } },
    { ...valid, artifactRoot: externalArtifactRoot(t, "restore-reserve"), budgets: { ...valid.budgets, restorationReserveMs: valid.capture.deadlineMs } },
  ]) await assert.rejects(orchestrator.execute(input));
  assert.equal(dependencyReads, 0);
});

test("ConfigurationService parser accepts the observed embedded keyName/keyValue JSON and rejects ambiguity", () => {
  assert.equal(typeof worldLocomotion.parseConfigurationServiceValues, "function");
  const output = `ConfigurationService state:\n  values=[{"keyName":"spatial_stage_style","keyValue":"3"},{"keyName":"spatial_safeguard_enable","keyValue":"1"},{"keyName":"spatial_safeguard_center","keyValue":"0,0,0"},{"keyName":"spatial_virtual_content_detected","keyValue":"1"}]\nend`;
  assert.deepEqual(worldLocomotion.parseConfigurationServiceValues(output, [
    "spatial_stage_style",
    "spatial_safeguard_enable",
    "spatial_safeguard_center",
    "spatial_virtual_content_detected",
  ]), {
    spatial_stage_style: "3",
    spatial_safeguard_enable: "1",
    spatial_safeguard_center: "0,0,0",
    spatial_virtual_content_detected: "1",
  });
  assert.throws(() => worldLocomotion.parseConfigurationServiceValues(
    `[{"keyName":"spatial_stage_style","keyValue":"3"},{"keyName":"spatial_stage_style","keyValue":"3"}]`,
    ["spatial_stage_style"],
  ), /exact|ambiguous|one/i);
  assert.throws(() => worldLocomotion.parseConfigurationServiceValues(
    `[{"keyName":"spatial_stage_style","keyValue":3}]`,
    ["spatial_stage_style"],
  ), /string|exact|value/i);
  assert.throws(() => worldLocomotion.parseConfigurationServiceValues(
    `ConfigurationService state: values=[{"keyName":"spatial_stage_style","keyValue":"3"}`,
    ["spatial_stage_style"],
  ), /exact|missing|unambiguous/i);
  assert.throws(() => worldLocomotion.parseConfigurationServiceValues(
    `[{"keyName":"another_key","keyValue":"3"}]`,
    ["spatial_stage_style"],
  ), /exact|missing|unambiguous/i);
});

test("bracket parser recognizes the verified L0 phrases and app pause/ejection variants", () => {
  assert.equal(typeof worldLocomotion.parseLocomotionBracketSignals, "function");
  const text = [
    "09-02 I Spatial: setSpatialContainerBoundary applied",
    "09-02 I Spatial: container info changed for stage",
    "09-02 I Spatial: boundary min = (-1,-1,-1)",
    "09-02 I Activity: onResume com.picoxr.launcher/.Launcher",
    "09-02 I Activity: onPause com.test.fullworld/.platform.LaunchActivity",
    "09-02 I Activity: com.test.fullworld ejected from spatial stage",
  ].join("\n");
  assert.deepEqual(worldLocomotion.parseLocomotionBracketSignals(text, "com.test.fullworld"), {
    setSpatialContainerBoundary: 1,
    containerInfoChanged: 1,
    boundaryMin: 1,
    launcherResume: 1,
    appPauseOrEjection: 2,
  });

  const beginMarker = "PICO_LOCOMOTION_FIXTURE_BEGIN";
  const endMarker = "PICO_LOCOMOTION_FIXTURE_END";
  const bracketed = [
    "outside setSpatialContainerBoundary",
    beginMarker,
    "inside boundary min = (-1,-1,-1)",
    endMarker,
    "outside onResume com.picoxr.launcher/.Launcher",
  ].join("\n");
  assert.deepEqual(worldLocomotion.parseLocomotionBracketSignals(bracketed, "com.test.fullworld", { beginMarker, endMarker }), {
    setSpatialContainerBoundary: 0,
    containerInfoChanged: 0,
    boundaryMin: 1,
    launcherResume: 0,
    appPauseOrEjection: 0,
  });
  assert.throws(() => worldLocomotion.parseLocomotionBracketSignals(
    `${beginMarker}\n${beginMarker}\n${endMarker}`,
    "com.test.fullworld",
    { beginMarker, endMarker },
  ), /exact|marker|bracket/i);
});

test("prior relaunch command is explicit MAIN, LAUNCHER, NEW_TASK, exact serial and component", () => {
  assert.equal(typeof worldLocomotion.buildPriorRelaunchCommandArgs, "function");
  assert.deepEqual(worldLocomotion.buildPriorRelaunchCommandArgs(
    "emulator-5554",
    "com.prior.unbound/.MainActivity",
  ), [
    "-s", "emulator-5554", "shell", "am", "start", "-W",
    "-a", "android.intent.action.MAIN",
    "-c", "android.intent.category.LAUNCHER",
    "-f", "0x10000000",
    "-n", "com.prior.unbound/.MainActivity",
  ]);
});

test("one serial remains owned after prepare and is released only by a safely completed restore", async (t) => {
  const fixture = await createPreparedFixture(t);
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
  const first = await orchestrator.execute(fixture.input);
  assert.equal(first.status, "needs_baseline_review");
  const secondInput = { ...fixture.input, artifactRoot: externalArtifactRoot(t, "sequential-second") };

  await assert.rejects(orchestrator.execute(secondInput), /serial.*(?:owned|active|restore)|(?:owned|active).*serial/i);
  assert.equal(fs.existsSync(secondInput.artifactRoot), false);

  const restored = await orchestrator.execute({
    action: "restore",
    runId: first.runId,
    reviewedPriorFrame: reviewFor(first.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review");
  const second = await orchestrator.execute(secondInput);
  assert.equal(second.status, "needs_baseline_review");
});

test("action append validates the opened descriptor identity before writing substituted bytes", async (t) => {
  const fixture = await createPreparedFixture(t);
  let swapped = false;
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    beforeActionAppendOpen({ action, path: actionPath }) {
      if (action !== "step" || swapped) return;
      swapped = true;
      fs.renameSync(actionPath, `${actionPath}.original`);
      fs.writeFileSync(actionPath, "", { flag: "wx", mode: 0o600 });
    },
  });
  const prepared = await orchestrator.execute(fixture.input);
  fixture.calls.length = 0;

  const result = await orchestrator.execute(stepRequest(
    { ...fixture, prepared },
    reviewFor(prepared.requiredReview[0]),
  ));

  assert.equal(result.status, "stopped");
  assert.match(result.primaryError, /action.*identity|descriptor|substitut/i);
  assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl.original"), "utf8").trim().split("\n").length, 1);
});

test("prepare publishes its success audit before state and contains failure-audit errors", async (t) => {
  const fixture = await createPreparedFixture(t);
  let failCompletedAudit = true;
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    beforeActionAppendOpen({ action, status }) {
      if (action === "prepare" && status === "completed" && failCompletedAudit) {
        failCompletedAudit = false;
        throw new Error("prepare completion audit unavailable");
      }
    },
  });
  const failed = await orchestrator.execute(fixture.input);
  assert.equal(failed.status, "preparation_failed");
  assert.match(failed.primaryError, /completion audit unavailable/i);
  await assert.rejects(orchestrator.execute({
    action: "step",
    runId: failed.runId,
    reviewedPriorFrame: reviewedFrame,
    waypoint: fixture.input.route.waypoints[0],
  }), /unknown.*runId/i);
  const retry = await orchestrator.execute({ ...fixture.input, artifactRoot: externalArtifactRoot(t, "prepare-audit-retry") });
  assert.equal(retry.status, "needs_baseline_review");

  const primary = await createPreparedFixture(t, {
    capability: {
      ok: false,
      code: "capability_unavailable",
      detail: "capability is absent",
      primaryError: "capability primary failure",
      cleanupError: null,
      actionReceipts: [],
      evidenceCeiling: "structural",
    },
  });
  const auditFails = createInAppLocomotionOrchestrator(primary.dependencies, {
    beforeActionAppendOpen({ action, status }) {
      if (action === "prepare" && status === "failed") throw new Error("failed audit append fault");
    },
  });
  const retained = await auditFails.execute(primary.input);
  assert.match(retained.primaryError, /capability primary failure/i);
  assert.match(retained.cleanupError, /failed audit append fault/i);
});

test("step and restore audit failures return honest stopped state and retain serial ownership", async (t) => {
  const stepFixture = await createPreparedFixture(t);
  const stepOrchestrator = createInAppLocomotionOrchestrator(stepFixture.dependencies, {
    beforeActionAppendOpen({ action }) {
      if (action === "step") throw new Error("step audit append fault");
    },
  });
  const prepared = await stepOrchestrator.execute(stepFixture.input);
  const stopped = await stepOrchestrator.execute(stepRequest(
    { ...stepFixture, prepared },
    reviewFor(prepared.requiredReview[0]),
  ));
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.primaryError, /step audit append fault/i);

  const restoreFixture = await createPreparedFixture(t);
  const restoreOrchestrator = createInAppLocomotionOrchestrator(restoreFixture.dependencies, {
    beforeActionAppendOpen({ action }) {
      if (action === "restore") throw new Error("restore audit append fault");
    },
  });
  const restorePrepared = await restoreOrchestrator.execute(restoreFixture.input);
  const restoreFailed = await restoreOrchestrator.execute({
    action: "restore",
    runId: restorePrepared.runId,
    reviewedPriorFrame: reviewFor(restorePrepared.requiredReview[0]),
  });
  assert.equal(restoreFailed.status, "restore_failed");
  assert.match(restoreFailed.primaryError, /restore audit append fault/i);
  await assert.rejects(restoreOrchestrator.execute({
    ...restoreFixture.input,
    artifactRoot: externalArtifactRoot(t, "restore-audit-second"),
  }), /serial.*(?:owned|active|restore)|(?:owned|active).*serial/i);
});

test("adjudication audit failure removes its staged artifact and remains retryable", async (t) => {
  const fixture = await createPreparedFixture(t);
  let failAudit = true;
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    beforeActionAppendOpen({ action }) {
      if (action === "adjudicate" && failAudit) {
        failAudit = false;
        throw new Error("adjudication audit append fault");
      }
    },
  });
  const prepared = await orchestrator.execute(fixture.input);
  const stepped = await orchestrator.execute(stepRequest({ ...fixture, prepared }, reviewFor(prepared.requiredReview[0])));
  const restored = await orchestrator.execute({ action: "restore", runId: prepared.runId, reviewedPriorFrame: reviewFor(stepped.requiredReview[0]) });
  const frames = [prepared.requiredReview[0], stepped.requiredReview[0], restored.requiredReview[0]];
  const first = await orchestrator.execute({ action: "adjudicate", runId: prepared.runId, frameAttestations: attestationsFor(frames) });
  assert.equal(first.status, "adjudication_rejected");
  assert.match(first.primaryError, /adjudication audit append fault/i);
  assert.equal(fs.existsSync(path.join(fixture.input.artifactRoot, "adjudication.json")), false);

  const retry = await orchestrator.execute({ action: "adjudicate", runId: prepared.runId, frameAttestations: attestationsFor(frames) });
  assert.equal(retry.status, "structural_complete");
});

test("prepare failure restores one explicitly non-receipt prior after target cleanup at every post-stop failure stage", async (t) => {
  for (const stage of ["launch", "capability", "monitor", "capture"]) {
    await t.test(stage, async (t) => {
      const component = "com.prior.unbound/.MainActivity";
      const fixture = await createPreparedFixture(t, {
        inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
        priorSnapshot: { component, packageName: "com.prior.unbound", userInstalled: true },
        ...(stage === "launch" ? { launchError: new Error("launch stage fault") } : {}),
        ...(stage === "capability" ? {
          capability: {
            ok: false, code: "capability_unavailable", detail: "capability stage fault", primaryError: "capability stage fault",
            cleanupError: null, actionReceipts: [], evidenceCeiling: "structural",
          },
        } : {}),
        ...(stage === "capture" ? { captureResult: (input) => failedCapture(input, "stability_timeout") } : {}),
      });
      if (stage === "monitor") {
        fixture.dependencies.monitorFreshLaunch = async (context) => {
          fixture.calls.push({ kind: "monitor", context });
          throw new Error("monitor stage fault");
        };
      }

      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "preparation_failed");
      const cleanupIndex = fixture.calls.findIndex((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup");
      const relaunches = fixture.calls.filter((call) => call.kind === "relaunchPrior");
      assert.equal(relaunches.length, 1);
      assert.ok(cleanupIndex >= 0 && cleanupIndex < fixture.calls.findIndex((call) => call.kind === "relaunchPrior"));
      const action = JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim().split("\n").at(-1));
      assert.equal(action.priorForeground.relaunchDisposition, "accepted");
    });
  }
});

test("prepare failure never relaunches a receipt-bound prior and records known-stale withholding", async (t) => {
  const component = "com.prior.receipted/.MainActivity";
  const fixture = await createPreparedFixture(t, {
    inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "c".repeat(64) } },
    priorSnapshot: { component, packageName: "com.prior.receipted", userInstalled: true },
    launchError: new Error("launch failed after incumbent stop"),
  });
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "preparation_failed");
  assert.equal(fixture.calls.some((call) => call.kind === "relaunchPrior"), false);
  const action = JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim());
  assert.equal(action.priorForeground.receiptFreshness, "known_stale");
  assert.equal(action.priorForeground.relaunchDisposition, "withheld_receipt_bound");
});

test("accepted prior launch output is insufficient without one exact resumed-component re-probe", async (t) => {
  const component = "com.prior.unbound/.MainActivity";
  const fixture = await prepareForSteps(t, {
    inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
    priorSnapshot: { component, packageName: "com.prior.unbound", userInstalled: true },
    relaunchResult: {
      disposition: "accepted",
      component,
      outputSha256: sha256("Status: ok\n"),
      activityProbeSha256: sha256("topResumedActivity=com.other/.Main\n"),
      resumedComponents: ["com.other/.Main"],
    },
    safetySequence: [cleanSafety, cleanMixedSafety],
  });
  const result = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(result.status, "restore_failed");
  assert.match(result.cleanupError, /exact resumed|relaunch.*component|probe/i);
  assert.equal(result.priorForeground.relaunchDisposition, "attempt_failed");
  assert.equal(fixture.calls.filter((call) => call.kind === "relaunchPrior").length, 1);
  assert.ok(fixture.calls.findIndex((call) => call.kind === "relaunchPrior") < fixture.calls.findIndex((call) => call.kind === "safety"));
});

test("final global safety accepts clean Full-to-Mixed stop state with no prior foreground", async (t) => {
  const fixture = await prepareForSteps(t, { safetySequence: [cleanSafety, cleanMixedSafety] });
  const result = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(result.status, "restored_needs_review");
  assert.equal(result.priorForeground.relaunchDisposition, "not_applicable");
  assert.equal(fixture.calls.some((call) => call.kind === "relaunchPrior"), false);
});

test("prepare uses one fixed phase deadline, clamps baseline capture, and stops before capture after overrun", async (t) => {
  let nowNs = 0n;
  const clamped = await createPreparedFixture(t, {
    monotonicNs: () => nowNs,
    afterMonitor: () => { nowNs = 86_000_000_000n; },
  });
  const prepared = await createInAppLocomotionOrchestrator(clamped.dependencies).execute(clamped.input);
  assert.equal(prepared.status, "needs_baseline_review");
  const clampedCapture = clamped.calls.find((call) => call.kind === "capture").input;
  assert.equal(clampedCapture.deadlineMs, 4_000);
  assert.equal(clampedCapture.attemptTimeoutMs, 1_000);

  nowNs = 0n;
  const overrun = await createPreparedFixture(t, {
    inputOverrides: { artifactRoot: externalArtifactRoot(t, "prepare-overrun") },
    monotonicNs: () => nowNs,
    afterMonitor: () => { nowNs = 91_000_000_000n; },
  });
  const failed = await createInAppLocomotionOrchestrator(overrun.dependencies).execute(overrun.input);
  assert.equal(failed.status, "preparation_failed");
  assert.match(failed.primaryError, /budget|deadline|phase/i);
  assert.equal(overrun.calls.some((call) => call.kind === "capture"), false);
  assert.equal(overrun.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
});

test("restoration reserve is one fixed absolute deadline and does not reset after locomotion", async (t) => {
  let nowNs = 0n;
  const fixture = await prepareForSteps(t, { monotonicNs: () => nowNs });
  const originalLocomotion = fixture.dependencies.requestLocomotion;
  fixture.dependencies.requestLocomotion = async (input) => {
    const result = await originalLocomotion(input);
    nowNs = 25_000_000_000n;
    return result;
  };
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(restored.status, "restored_needs_review");
  assert.equal(fixture.calls.find((call) => call.kind === "capture").input.deadlineMs, 5_000);
});

test("fresh-launch raw health logs are retained and re-hashed before mutation and adjudication", async (t) => {
  const mutation = await prepareForSteps(t);
  assert.ok(mutation.healthLogs.length >= 2);
  fs.writeFileSync(mutation.healthLogs[0].path, "tampered health evidence\n");
  await assert.rejects(mutation.orchestrator.execute(stepRequest(mutation, reviewFor(mutation.baselineReview))), /health|log|evidence|immutable|changed/i);
  assert.equal(mutation.calls.some((call) => call.kind === "marker" || call.kind === "locomote"), false);

  const adjudication = await prepareAndRestoreForAdjudication(t);
  assert.ok(adjudication.healthLogs.length >= 2);
  fs.writeFileSync(adjudication.healthLogs[0].path, "tampered after restore\n");
  await assert.rejects(adjudication.orchestrator.execute({
    action: "adjudicate",
    runId: adjudication.prepared.runId,
    frameAttestations: attestationsFor(adjudication.retained),
  }), /health|log|evidence|immutable|changed/i);
});

test("prepare rejects duplicate raw health-log references before publishing run state", async (t) => {
  const fixture = await createPreparedFixture(t, {
    afterMonitor(receipt) {
      receipt.rawHealthLogs = receipt.rawHealthLogs.map(() => receipt.rawHealthLogs[0]);
    },
  });
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);

  const result = await orchestrator.execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /health|log|unique|duplicate/i);
  await assert.rejects(orchestrator.execute({
    action: "adjudicate",
    runId: sha256(Buffer.alloc(16, 7)),
    frameAttestations: [reviewedFrame],
  }), /unknown.*run/i);
});

const adb = "/fixture/adb";
const baseInput = {
  serial: "fixture-serial",
  packageName: "com.test.fullworld",
  requestId: "locomotion_nonce_0001",
  tag: "route-step-0001",
  maxPolls: 2,
  pollMs: 10,
  stabilityReads: 2,
  ackReadTimeoutMs: 250,
  controlTimeoutMs: 1_000,
};

const envelope = (operation, overrides = {}) => ({
  kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
  schemaVersion: AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
  capabilityRevision: AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
  requestId: baseInput.requestId,
  tag: baseInput.tag,
  application: { packageName: baseInput.packageName },
  operation,
  physicalWalk: false,
  primaryError: null,
  cleanupError: null,
  ...overrides,
});

const availableAck = (overrides = {}) => envelope(AGENT_BRIDGE_COMMANDS_COMMAND, {
  outcome: "available",
  commands: [AGENT_BRIDGE_COMMANDS_COMMAND, AGENT_BRIDGE_HMD_POSE_COMMAND, AGENT_BRIDGE_LOCOMOTE_COMMAND],
  availability: {
    debuggable: true,
    observedStageStyle: "Full",
    rootContainer: "stage",
    rootRegistered: true,
    hmdAvailable: true,
    locomotionAvailable: true,
  },
  root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7 },
  ...overrides,
});

const hmdAck = (overrides = {}) => envelope(AGENT_BRIDGE_HMD_POSE_COMMAND, {
  outcome: "sampled",
  root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7 },
  hmdPose: {
    readAtMonotonicNs: "9876543210",
    position: { x: 0.1, y: 1.62, z: -0.2 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  },
  ...overrides,
});

const locomotionInput = {
  ...baseInput,
  mode: "direct",
  target: { x: 2, y: 0, z: -4 },
  rootGeneration: 7,
  glideDurationMs: 500,
};

const locomotionAck = (overrides = {}) => envelope(AGENT_BRIDGE_LOCOMOTE_COMMAND, {
  outcome: "completed",
  mode: "direct",
  target: { absolute: true, x: 2, y: 0, z: -4 },
  glideDurationMs: 500,
  rootGenerationBefore: 7,
  pose: { rootGeneration: 7, position: { x: 2, y: 0, z: -4 } },
  hmdPose: null,
  ...overrides,
});

const textOk = { code: 0, stdout: "Broadcast completed: result=0", stderr: "", timedOut: false };
const cleanupOk = { code: 0, stdout: "", stderr: "", timedOut: false };

function fakeTransaction(payloads, options = {}) {
  const calls = [];
  let pull = 0;
  const bytes = payloads.map((payload) => Buffer.from(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8",
  ));
  return {
    calls,
    deps: {
      monotonicNs: (() => { let tick = 100n; return () => tick++; })(),
      sleep: async () => {},
      runText: async (cmd, args, runOptions) => {
        calls.push({ kind: "text", cmd, args, options: runOptions });
        if (args.includes("rm")) return options.cleanupResult ?? cleanupOk;
        return options.broadcastResult ?? textOk;
      },
      runBytes: async (cmd, args, runOptions) => {
        calls.push({ kind: "bytes", cmd, args, options: runOptions });
        const payload = bytes[Math.min(pull++, bytes.length - 1)];
        if (payload === undefined) return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
        return { code: 0, stdout: Buffer.concat([Buffer.from([1]), payload]), stderr: "", timedOut: false };
      },
    },
  };
}

function cleanupCalls(calls) {
  return calls.filter((call) => call.kind === "text" && call.args.includes("rm"));
}

function assertExactCleanup(calls, requestId = baseInput.requestId) {
  const cleanup = cleanupCalls(calls);
  assert.equal(cleanup.length, 1);
  assert.deepEqual(cleanup[0].args, [
    "-s", baseInput.serial, "shell", "run-as", baseInput.packageName,
    "rm", "-f", `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${requestId}.json`,
  ]);
}

test("legacy commands acknowledgement without capability revision is capability_unavailable and cleaned", async () => {
  const legacy = availableAck();
  delete legacy.capabilityRevision;
  const fake = fakeTransaction([legacy, legacy]);

  const result = await probeAgentBridgeLocomotionCapability(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "capability_unavailable");
  assert.match(result.primaryError, /capability revision/i);
  assert.equal(result.cleanupError, null);
  assertExactCleanup(fake.calls);
});

test("a substituted revisionless commands file is invalid rather than treated as a legacy capability", async () => {
  const substituted = availableAck({ requestId: "substituted_nonce_9999" });
  delete substituted.capabilityRevision;
  const fake = fakeTransaction([substituted, substituted]);

  const result = await probeAgentBridgeLocomotionCapability(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_ack");
  assert.match(result.primaryError, /schema|requestId/i);
  assertExactCleanup(fake.calls);
});

test("broadcast acceptance without a stable exact-file acknowledgement is never success and is cleaned", async () => {
  const fake = fakeTransaction([]);

  const result = await requestAgentBridgeHmdPose(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "bridge_unavailable");
  assert.match(result.primaryError, /stable|acknowledgement/i);
  assertExactCleanup(fake.calls);
});

test("malformed acknowledgement fails closed and preserves cleanup evidence", async () => {
  const fake = fakeTransaction(["{not-json", "{not-json"]);

  const result = await requestAgentBridgeHmdPose(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_ack");
  assert.match(result.primaryError, /JSON/i);
  assert.equal(result.cleanupError, null);
  assertExactCleanup(fake.calls);
});

test("commands capability success is nonce/package/operation/root bound and uses exact transport metadata", async () => {
  const ack = availableAck();
  const fake = fakeTransaction([ack, ack]);

  const result = await probeAgentBridgeLocomotionCapability(adb, baseInput, fake.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ack, ack);
  const broadcast = fake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast"));
  assert.ok(broadcast);
  for (const value of [
    AGENT_BRIDGE_COMMANDS_COMMAND,
    AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
    String(AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION),
    String(AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION),
    baseInput.requestId,
    baseInput.tag,
  ]) assert.ok(broadcast.args.includes(value), `broadcast omitted ${value}`);
  assert.ok(fake.calls.filter((call) => call.kind === "bytes").every((call) =>
    call.args.at(-1) === `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${baseInput.requestId}.json`));
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 2,
    "success requires two byte-identical reads rather than accepting the first present file");
  assertExactCleanup(fake.calls);
});

test("one present acknowledgement read is insufficient for stability and still cleans", async () => {
  const ack = availableAck();
  const fake = fakeTransaction([ack]);

  const result = await probeAgentBridgeLocomotionCapability(adb, { ...baseInput, maxPolls: 1 }, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "capability_unavailable");
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 1);
  assertExactCleanup(fake.calls);
});

test("changed acknowledgement bytes reset stability before an identical pair succeeds", async () => {
  const first = availableAck({ root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 6 } });
  const final = availableAck();
  const fake = fakeTransaction([first, final, final]);

  const result = await probeAgentBridgeLocomotionCapability(adb, { ...baseInput, maxPolls: 3 }, fake.deps);

  assert.equal(result.ok, true);
  assert.equal(result.ack.root.generation, 7);
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 3);
  assertExactCleanup(fake.calls);
});

test("broadcast failure retains the primary error and attempts exact cleanup once", async () => {
  const fake = fakeTransaction([], {
    broadcastResult: { code: 1, stdout: "", stderr: "receiver unavailable", timedOut: false },
  });

  const result = await requestAgentBridgeHmdPose(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "bridge_unavailable");
  assert.match(result.primaryError, /broadcast failed/i);
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 0);
  assertExactCleanup(fake.calls);
});

test("HMD success requires finite position/quaternion and exact root generation", async () => {
  const ack = hmdAck();
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeHmdPose(adb, { ...baseInput, expectedRootGeneration: 7 }, fake.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ack, ack);
  assertExactCleanup(fake.calls);
});

test("locomotion success binds mode, absolute target, glide budget, and root-generation transition", async () => {
  const ack = locomotionAck();
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ack, ack);
  const broadcast = fake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast"));
  for (const value of ["direct", "2", "0", "-4", "7", "500", "false"])
    assert.ok(broadcast.args.includes(value), `locomote broadcast omitted ${value}`);
  assertExactCleanup(fake.calls);
});

test("locomotion canonicalizes a finite JavaScript target to its exact Float32 transport value", async () => {
  const input = { ...locomotionInput, target: { x: 0.10000000000000002, y: 0, z: -4 } };
  const ack = locomotionAck({
    target: { absolute: true, x: 0.1, y: 0, z: -4 },
    pose: { rootGeneration: 7, position: { x: 0.1, y: 0, z: -4 } },
  });
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);

  assert.equal(result.ok, true);
  const broadcast = fake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast"));
  assert.equal(broadcast.args[broadcast.args.indexOf("x") + 1], "0.1");
  assert.deepEqual(result.ack.target, { absolute: true, x: 0.1, y: 0, z: -4 });
  assertExactCleanup(fake.calls);
});

test("locomotion acknowledgement binding compares exact Float32 values and normalizes signed zero", async () => {
  const smallestSubnormal = 2 ** -149;
  const largestFinite = Math.fround(3.4028234663852886e38);
  const cases = [
    {
      input: { x: smallestSubnormal, y: -smallestSubnormal, z: -0 },
      acknowledged: { x: 1.4e-45, y: -1.4e-45, z: 0 },
      broadcast: ["1e-45", "-1e-45", "0"],
    },
    {
      input: { x: largestFinite, y: 2 ** -126, z: 0 },
      acknowledged: { x: 3.4028235e38, y: 1.1754944e-38, z: -0 },
      broadcast: ["3.4028235e+38", "1.1754944e-38", "0"],
    },
  ];

  for (const edge of cases) {
    const input = { ...locomotionInput, target: edge.input };
    const ack = locomotionAck({
      target: { absolute: true, ...edge.acknowledged },
      pose: { rootGeneration: 7, position: edge.acknowledged },
    });
    const fake = fakeTransaction([ack, ack]);

    const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);

    assert.equal(result.ok, true);
    const args = fake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast")).args;
    assert.deepEqual(["x", "y", "z"].map((axis) => args[args.indexOf(axis) + 1]), edge.broadcast);
    assertExactCleanup(fake.calls);
  }
});

test("replacement success requires the next root generation and never accepts direct readback", async () => {
  const input = { ...locomotionInput, mode: "replacement", glideDurationMs: 0 };
  const ack = locomotionAck({
    mode: "replacement",
    glideDurationMs: 0,
    pose: { rootGeneration: 8, position: { x: 2, y: 0, z: -4 } },
  });
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);

  assert.equal(result.ok, true);
  assert.equal(result.ack.pose.rootGeneration, 8);
  assertExactCleanup(fake.calls);
});

for (const [name, mutate] of [
  ["request nonce", (ack) => { ack.requestId = "substituted_nonce_9999"; }],
  ["package", (ack) => { ack.application.packageName = "com.attacker.substitute"; }],
  ["operation", (ack) => { ack.operation = AGENT_BRIDGE_HMD_POSE_COMMAND; }],
  ["mode", (ack) => { ack.mode = "replacement"; ack.pose.rootGeneration = 8; }],
  ["target", (ack) => { ack.target.x = 2.001; ack.pose.position.x = 2.001; }],
  ["prior root generation", (ack) => { ack.rootGenerationBefore = 6; }],
  ["direct result generation", (ack) => { ack.pose.rootGeneration = 8; }],
]) {
  test(`locomotion rejects substituted or stale ${name} acknowledgement and cleans it`, async () => {
    const ack = locomotionAck();
    mutate(ack);
    const fake = fakeTransaction([ack, ack]);

    const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_ack");
    assert.match(result.primaryError, /acknowledgement|ack/i);
    assertExactCleanup(fake.calls);
  });
}

test("a rejected guest result is distinct from an acknowledgement cleanup failure", async () => {
  const rejected = locomotionAck({ outcome: "rejected", pose: null, primaryError: "stale_generation" });
  const fake = fakeTransaction([rejected, rejected], {
    cleanupResult: { code: 1, stdout: "", stderr: "permission denied", timedOut: false },
  });

  const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "guest_rejected");
  assert.equal(result.primaryError, "stale_generation");
  assert.match(result.cleanupError, /permission denied/i);
  assertExactCleanup(fake.calls);
});

test("guest cleanup failure remains visible when exact acknowledgement-file cleanup succeeds", async () => {
  const rejected = locomotionAck({
    outcome: "failed",
    pose: null,
    primaryError: "replacement_publish_failed",
    cleanupError: "candidate_root_destroy_failed",
  });
  const fake = fakeTransaction([rejected, rejected]);

  const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "guest_rejected");
  assert.equal(result.primaryError, "replacement_publish_failed");
  assert.equal(result.cleanupError, "candidate_root_destroy_failed");
  assertExactCleanup(fake.calls);
});

test("failed HMD and locomotion acknowledgements carrying success payloads are invalid", async () => {
  const failedHmd = hmdAck({ outcome: "failed", primaryError: "provider_failed" });
  const hmdFake = fakeTransaction([failedHmd, failedHmd]);
  const hmdResult = await requestAgentBridgeHmdPose(adb, baseInput, hmdFake.deps);
  assert.equal(hmdResult.ok, false);
  assert.equal(hmdResult.code, "invalid_ack");
  assertExactCleanup(hmdFake.calls);

  const failedLocomotion = locomotionAck({ outcome: "failed", primaryError: "producer_failed" });
  const locomotionFake = fakeTransaction([failedLocomotion, failedLocomotion]);
  const locomotionResult = await requestAgentBridgeLocomotion(adb, locomotionInput, locomotionFake.deps);
  assert.equal(locomotionResult.ok, false);
  assert.equal(locomotionResult.code, "invalid_ack");
  assertExactCleanup(locomotionFake.calls);
});

test("cleanup-only host failure has no invented primary failure", async () => {
  const ack = hmdAck();
  const fake = fakeTransaction([ack, ack], {
    cleanupResult: { code: 1, stdout: "", stderr: "cleanup denied", timedOut: false },
  });

  const result = await requestAgentBridgeHmdPose(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "cleanup_failed");
  assert.equal(result.primaryError, null);
  assert.match(result.cleanupError, /cleanup denied/i);
  assertExactCleanup(fake.calls);
});

test("locomotion rejects incomplete, non-finite, implicit-mode, or physical-walk input before broadcast", async () => {
  for (const input of [
    { ...locomotionInput, target: { x: 2, y: 0 } },
    { ...locomotionInput, target: { x: Number.NaN, y: 0, z: -4 } },
    { ...locomotionInput, mode: undefined },
    { ...locomotionInput, physicalWalk: true },
  ]) {
    const fake = fakeTransaction([]);
    const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_request");
    assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 0);
    assert.equal(fake.calls.filter((call) => call.kind === "text" && call.args.includes("broadcast")).length, 0);
    assertExactCleanup(fake.calls);
  }
});

test("finite doubles outside the Float32 transport domain are refused with exact cleanup before broadcast", async () => {
  const fake = fakeTransaction([]);

  const result = await requestAgentBridgeLocomotion(adb, {
    ...locomotionInput,
    target: { x: Number.MAX_VALUE, y: 0, z: -4 },
  }, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_request");
  assert.match(result.primaryError, /Float32/i);
  assert.equal(fake.calls.filter((call) => call.kind === "text" && call.args.includes("broadcast")).length, 0);
  assertExactCleanup(fake.calls);
});

test("unsafe serial, package, or nonce remains fully transport-free", async () => {
  for (const input of [
    { ...locomotionInput, serial: "two serials" },
    { ...locomotionInput, packageName: "../unsafe" },
    { ...locomotionInput, requestId: "../unsafe" },
  ]) {
    const fake = fakeTransaction([]);
    const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_request");
    assert.equal(fake.calls.length, 0);
  }
});
