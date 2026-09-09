import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
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
  AgentBridgeLocomotionNonceCleanupError,
  probeAgentBridgeLocomotionCapability,
  requestAgentBridgeHmdPose,
  requestAgentBridgeLocomotion,
} from "../dist/agentbridge.js";
import * as agentBridge from "../dist/agentbridge.js";
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
const ROOT_INCARNATION = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT_INCARNATION = "22222222-2222-4222-8222-222222222222";
const DEVICE_CALL_KINDS = new Set([
  "snapshotPrior", "stop", "launch", "launchWindow", "launchObservation", "probeRuntime",
  "safety", "capability", "hmd", "monitor", "capture", "continuity", "locomote",
  "nonceCleanup", "marker", "logs", "relaunchPrior", "finalProcess",
]);

function deviceCalls(calls) {
  return calls.filter((call) => DEVICE_CALL_KINDS.has(call.kind));
}

function completedStopReceipt(context) {
  return {
    status: "stop_command_completed",
    serial: context.serial,
    packageName: context.packageName,
    reason: context.reason,
  };
}

function cleanPidAbsenceReceipt(context, overrides = {}) {
  return {
    status: "clean_pidof_absence",
    serial: context.serial,
    packageName: context.packageName,
    exitCode: 1,
    timedOut: false,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function completedPrepareClearanceReceipt(context, pidOverrides = {}) {
  return {
    status: "prepare_clearance_completed",
    stopReceipt: completedStopReceipt(context),
    pidAbsence: cleanPidAbsenceReceipt(context, pidOverrides),
  };
}

function externalArtifactRoot(t, label = "run") {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pico-worldlocomotion-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, label);
}

function committedActionPayloads(artifactRoot) {
  return fs.readdirSync(path.join(artifactRoot, "action-records"))
    .filter((name) => /^[0-9]{6}\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(artifactRoot, "action-records", name), "utf8")).payload);
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
      maxDurationMs: 340_000,
      routeReserveMs: 110_000,
      restorationReserveMs: 110_000,
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
    { ...valid, budgets: { ...valid.budgets, maxDurationMs: 200_000 } },
    { ...valid, budgets: { maxDurationMs: 97_999, routeReserveMs: 20_000, restorationReserveMs: 10_000 } },
    { ...valid, budgets: { maxDurationMs: 98_000, routeReserveMs: 20_000, restorationReserveMs: 10_000 } },
    { ...valid, budgets: { ...valid.budgets, routeReserveMs: valid.capture.deadlineMs } },
    { ...valid, budgets: { ...valid.budgets, restorationReserveMs: valid.capture.deadlineMs } },
    { ...valid, priorForeground: { kind: "non_receipt_bound", component: "com.test.fullworld/.PriorActivity" } },
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
  await assert.rejects(
    orchestrator.execute(prepareRouteInput(t, {
      priorForeground: { kind: "non_receipt_bound", component: "com.test.fullworld/.PriorActivity" },
    })),
    /prior|package|same/i,
  );
  assert.equal(dependencyReads, 0);
});

function clearLocomotionHostWindow(overrides = {}) {
  return {
    status: "ok", occluded: false, frontmost: true, overlappingOwners: [],
    observedAt: "2026-09-08T12:00:00.000Z", qemuWindowId: 104,
    qemuWindowOwnerPid: 93013, detail: null, durationMs: 0, ...overrides,
  };
}

const LOCOMOTION_WINDOW = Object.freeze({
  discoveredSerial: "emulator-5554", discoveryFile: "/tmp/pico-emulator/pid_93013.ini",
  address: "127.0.0.1:8554", qemuPid: 93013, qemuWindowOwnerPid: 93013,
  qemuWindowId: 104, bindingMethod: "discovery-pid-window",
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

function successCapture(input, shade = 48, monotonicNs = undefined) {
  assert.equal(typeof monotonicNs, "function", "capture fixtures must share the route monotonic clock");
  const bytes = makePng(shade);
  fs.writeFileSync(input.outPath, bytes, { flag: "wx", mode: 0o600 });
  const digest = sha256(bytes);
  const captureStartedNs = monotonicNs();
  const settleStartedNs = monotonicNs();
  const firstCapturedNs = monotonicNs();
  const secondCapturedNs = monotonicNs();
  const captureEndedNs = monotonicNs();
  const deadlineMonotonicNs = settleStartedNs + BigInt(input.deadlineMs) * 1_000_000n;
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
      deadlineMonotonicNs: deadlineMonotonicNs.toString(),
      trace: [
        { attempt: 1, capturedAtMonotonicNs: firstCapturedNs.toString(), sha256: digest, relation: "candidate" },
        { attempt: 2, capturedAtMonotonicNs: secondCapturedNs.toString(), sha256: digest, relation: "stable" },
      ],
      timeoutPhase: null,
      timeoutCause: null,
      captureRuntimeBinding: {
        serial: input.serial,
        liveIdentity: {
          serial: input.serial,
          model: "PICO Emulator",
          fingerprint: "PICO/PICO_Emulator/PICO_Emulator:14/fixture/test-keys",
          bootQemu: "1",
          bootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          observedAt: "2026-09-02T12:01:01.000Z",
        },
        captureSource: "adb-exec-out-screencap",
        startedAtMonotonicNs: captureStartedNs.toString(),
        endedAtMonotonicNs: captureEndedNs.toString(),
      },
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

function shiftCaptureTimeline(result, deltaNs) {
  const shift = (value) => (BigInt(value) + deltaNs).toString();
  result.receipt.deadlineMonotonicNs = shift(result.receipt.deadlineMonotonicNs);
  result.receipt.captureRuntimeBinding.startedAtMonotonicNs = shift(
    result.receipt.captureRuntimeBinding.startedAtMonotonicNs,
  );
  result.receipt.captureRuntimeBinding.endedAtMonotonicNs = shift(
    result.receipt.captureRuntimeBinding.endedAtMonotonicNs,
  );
  for (const entry of result.receipt.trace) {
    entry.capturedAtMonotonicNs = shift(entry.capturedAtMonotonicNs);
  }
}

function assertCaptureInvocation(action) {
  const fence = action.captureInvocation;
  assert.ok(fence, "the action must retain its exact capture invocation fence");
  const phaseStartedNs = BigInt(fence.phaseStartedAtMonotonicNs);
  const admittedNs = BigInt(fence.admittedAtMonotonicNs);
  const completedNs = BigInt(fence.completedAtMonotonicNs);
  const phaseDeadlineNs = BigInt(fence.phaseDeadlineMonotonicNs);
  const bindingStartedNs = BigInt(action.captureReceipt.captureRuntimeBinding.startedAtMonotonicNs);
  const bindingEndedNs = BigInt(action.captureReceipt.captureRuntimeBinding.endedAtMonotonicNs);
  const settleDeadlineNs = BigInt(action.captureReceipt.deadlineMonotonicNs);
  const settleStartedNs = settleDeadlineNs - BigInt(action.captureReceipt.deadlineMs) * 1_000_000n;
  const traceNs = action.captureReceipt.trace.map((entry) => BigInt(entry.capturedAtMonotonicNs));
  assert.ok(phaseStartedNs <= admittedNs);
  assert.ok(admittedNs <= bindingStartedNs);
  assert.ok(bindingStartedNs <= settleStartedNs);
  assert.ok(settleStartedNs <= traceNs[0]);
  assert.ok(traceNs.at(-1) <= bindingEndedNs);
  assert.ok(bindingEndedNs <= completedNs);
  assert.ok(completedNs <= phaseDeadlineNs);
  assert.ok(settleDeadlineNs <= phaseDeadlineNs);
}

function routeOwnedNonceDisposition(input) {
  return {
    status: "route_owned",
    requestId: input.requestId,
    relativePath: `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${input.requestId}.json`,
    attempts: 0,
  };
}

function successfulNonceCleanupReceipt(context) {
  return {
    status: "removed_and_absent",
    requestId: context.requestId,
    relativePath: `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${context.requestId}.json`,
    attempts: 1,
    ...(context.processStopped === true ? {} : { finalizationSha256: "d".repeat(64) }),
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
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: ROOT_INCARNATION },
  };
  const pose = {
    sampleSequence: "1",
    sampleObservedAtMonotonicNs: "1000000",
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
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: ROOT_INCARNATION },
    hmdPose: pose,
  };
  delete hmdPoseAck.commands;
  delete hmdPoseAck.availability;

  let monotonicTick = 1_000_000_000n;
  let lastMonotonicNs = -1n;
  let captureShade = 48;
  let hmdIndex = 0;
  let safetyIndex = 0;
  let continuityIndex = 0;
  let handoffObservationStarted = false;
  let handoffPhase = null;
  const observedHandoffPhases = new Set();
  const healthLogs = [];
  const windowDumps = [];
  const waitImmediate = () => new Promise((resolve) => setImmediate(resolve));
  const holdHandoffPhase = async (phase) => {
    if (options.handoffDialogDuring !== phase || !handoffObservationStarted) return;
    handoffPhase = phase;
    for (let tries = 0; tries < 100 && !observedHandoffPhases.has(phase); tries++) await waitImmediate();
    handoffPhase = null;
  };
  const dependencies = {
    sleep: async (durationMs) => { monotonicTick += BigInt(durationMs) * 1_000_000n; },
    randomBytes: (size) => {
      calls.push({ kind: "randomBytes", size });
      return Buffer.alloc(size, 7);
    },
    now: () => "2026-09-02T12:00:00.000Z",
    monotonicNs: () => {
      const observed = options.monotonicNs ? options.monotonicNs() : ++monotonicTick;
      lastMonotonicNs = observed > lastMonotonicNs ? observed : lastMonotonicNs + 1n;
      return lastMonotonicNs;
    },
    readNativeRunReceipt: (app, receiptId) => {
      calls.push({ kind: "readReceipt", app, receiptId });
      return receiptStore.readNativeRunReceipt(app, receiptId, receiptFixture.storeOptions);
    },
    readEffectiveAppSpec: (artifactPath, identity) => {
      calls.push({ kind: "readSpec", artifactPath, identity });
      return readReceiptBoundEffectiveAppSpec(artifactPath, identity);
    },
    platform: "darwin",
    bindQemuWindow: async () => ({ ok: true, binding: LOCOMOTION_WINDOW }),
    focusQemuWindow: async () => null,
    probeHostWindow: async () => clearLocomotionHostWindow(),
    snapshotPriorForeground: async (context) => {
      calls.push({ kind: "snapshotPrior", context });
      return options.priorSnapshot ?? { component: null, packageName: null, userInstalled: false };
    },
    stopPackage: async (context) => {
      calls.push({ kind: "stop", context });
      if (options.stopError && context.reason === options.stopError.reason) throw new Error(options.stopError.message);
      return context.reason === "prepare_target_clearance" || context.reason === "prepare_declared_incumbent_clearance"
        ? completedPrepareClearanceReceipt(context)
        : completedStopReceipt(context);
    },
    launchTarget: async (context) => {
      calls.push({ kind: "launch", context });
      if (options.launchError) throw options.launchError;
      return { disposition: "accepted", component: context.component, outputSha256: sha256("Status: ok\n") };
    },
    captureLaunchHandoffWindow: async (context) => {
      calls.push({ kind: "launchWindow", context });
      const bytes = Buffer.from(options.launchHandoffWindowText ?? "WINDOW MANAGER WINDOWS post-launch handoff\n", "utf8");
      const dumpPath = path.join(context.artifactRoot, "logs", "fresh-launch-window-handoff.txt");
      fs.writeFileSync(dumpPath, bytes, { flag: "wx", mode: 0o600 });
      return {
        dialogs: options.launchHandoffDialogs ?? [],
        rawWindowDump: { path: fs.realpathSync(dumpPath), sha256: sha256(bytes), bytes: bytes.length },
      };
    },
    observeLaunchHandoff: async (context) => {
      calls.push({ kind: "launchObservation", context });
      handoffObservationStarted = true;
      const samples = [];
      const rawWindowDumps = [];
      let elapsedMs = 0;
      const capture = () => {
        const observedTimestampOffsetMs = samples.length === 0
          ? 0
          : (options.handoffObservationTimestampOffsetAfterFirstMs ?? 0);
        const phase = handoffPhase;
        const text = phase === null
          ? `WINDOW MANAGER WINDOWS handoff ${samples.length}\n`
          : `WINDOW MANAGER WINDOWS handoff ${samples.length}\nmCurrentFocus=Application Error: com.test.fullworld during ${phase}\n`;
        const bytes = Buffer.from(text, "utf8");
        const dumpPath = path.join(context.artifactRoot, "logs", `launch-handoff-${String(samples.length).padStart(3, "0")}.txt`);
        fs.writeFileSync(dumpPath, bytes, { flag: "wx", mode: 0o600 });
        const rawWindowDump = { path: fs.realpathSync(dumpPath), sha256: sha256(bytes), bytes: bytes.length };
        const dialogs = phase === null ? [] : [`Application Error: com.test.fullworld during ${phase}`];
        samples.push({
          elapsedMs,
          observedAtMonotonicNs: String(
            10_000_000n + BigInt(elapsedMs + observedTimestampOffsetMs) * 1_000_000n,
          ),
          dialogs,
          rawWindowDump,
        });
        rawWindowDumps.push(rawWindowDump);
        if (phase !== null) observedHandoffPhases.add(phase);
        elapsedMs += 5;
      };
      capture();
      while (!context.signal.aborted) {
        await waitImmediate();
        capture();
      }
      capture();
      return {
        claim: "no_blocking_dialog_at_retained_samples",
        maxSampleGapMs: 10,
        startedAtMonotonicNs: "10000000",
        endedAtMonotonicNs: String(
          10_000_000n + BigInt(elapsedMs + (options.handoffObservationTimestampOffsetAfterFirstMs ?? 0)) * 1_000_000n,
        ),
        samples,
        rawWindowDumps,
        dialogs: [...new Set(samples.flatMap((sample) => sample.dialogs))],
      };
    },
    probeRuntimeBinding: async (context) => {
      calls.push({ kind: "probeRuntime", context });
      await holdHandoffPhase("runtime");
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
      await holdHandoffPhase("safety");
      if (options.safetySequence) return options.safetySequence[Math.min(safetyIndex++, options.safetySequence.length - 1)];
      return options.safety ?? { ...cleanSafety };
    },
    probeCapability: async (bridgeInput) => {
      calls.push({ kind: "capability", input: bridgeInput });
      await holdHandoffPhase("capability");
      const result = options.capability ?? {
        ok: true,
        ack: capabilityAck,
        primaryError: null,
        cleanupError: null,
        motionQuiesced: true,
        actionReceipts: [],
        evidenceCeiling: "structural",
      };
      const changedRoot = bridgeInput.tag === "prepare-post-capture"
        ? options.postCaptureRoot
        : bridgeInput.tag === "restore-post-capture"
          ? options.restorePostCaptureRoot
          : undefined;
      if (!result.ok || !changedRoot) return result;
      return {
        ...result,
        ack: {
          ...result.ack,
          root: { ...result.ack.root, ...changedRoot },
        },
      };
    },
    requestHmdPose: async (bridgeInput) => {
      calls.push({ kind: "hmd", input: bridgeInput });
      await holdHandoffPhase("hmd");
      if (options.hmdSequence) return options.hmdSequence[Math.min(hmdIndex++, options.hmdSequence.length - 1)];
      if (options.hmd) return options.hmd;
      const sequenceOffset = BigInt(hmdIndex++);
      const sampleObservedAtMonotonicNs = BigInt(pose.sampleObservedAtMonotonicNs) + sequenceOffset * 1_000_000n;
      const freshPose = {
        ...pose,
        sampleSequence: (BigInt(pose.sampleSequence) + sequenceOffset).toString(),
        sampleObservedAtMonotonicNs: sampleObservedAtMonotonicNs.toString(),
        readAtMonotonicNs: (sampleObservedAtMonotonicNs + 1_000_000n).toString(),
      };
      return {
        ok: true,
        ack: {
          ...hmdPoseAck,
          root: {
            id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID,
            generation: bridgeInput.expectedRootGeneration,
            incarnation: bridgeInput.expectedRootIncarnation,
          },
          hmdPose: freshPose,
        },
        primaryError: null,
        cleanupError: null,
        motionQuiesced: true,
        actionReceipts: [],
        evidenceCeiling: "structural",
      };
    },
    monitorFreshLaunch: async (context) => {
      calls.push({ kind: "monitor", context });
      const marker = context.healthBoundaryMarker ?? `PICO_LOCOMOTION_${context.runId.slice(0, 16)}_PREPARE_BEGIN`;
      const elapsedValues = [0, 15_000, 30_000, 45_000, 60_000];
      const rawWindowDumps = elapsedValues.map((_, sampleIndex) => {
        const bytes = Buffer.from(`WINDOW MANAGER WINDOWS sample ${sampleIndex}\n`, "utf8");
        const dumpPath = path.join(context.artifactRoot, "logs", `fresh-launch-window-${String(sampleIndex).padStart(2, "0")}.txt`);
        fs.writeFileSync(dumpPath, bytes, { flag: "wx", mode: 0o600 });
        const evidence = { path: fs.realpathSync(dumpPath), sha256: sha256(bytes), bytes: bytes.length };
        windowDumps.push(evidence);
        return evidence;
      });
      await holdHandoffPhase("monitor_handoff");
      const sampleZeroProbeStartedAtMonotonicNs = options.monitorSampleZeroProbeStartedAtMonotonicNs ?? "9000000";
      const sampleZeroRetainedAtMonotonicNs = options.monitorSampleZeroRetainedAtMonotonicNs ?? "10000000";
      const sampleZeroHandoffToken = sha256(canonicalJson({
        runId: context.runId,
        rawWindowSha256: rawWindowDumps[0].sha256,
        probeStartedAtMonotonicNs: sampleZeroProbeStartedAtMonotonicNs,
        retainedAtMonotonicNs: sampleZeroRetainedAtMonotonicNs,
      }));
      const callbackWindow = options.monitorCallbackForgedWindow === true
        ? { ...rawWindowDumps[0], sha256: "f".repeat(64) }
        : rawWindowDumps[0];
      if (options.monitorCallbackBeforeRetention === true) fs.unlinkSync(rawWindowDumps[0].path);
      let callbackError = null;
      try {
        await context.onFirstWindowSample({
          rawWindowDump: callbackWindow,
          probeStartedAtMonotonicNs: sampleZeroProbeStartedAtMonotonicNs,
          retainedAtMonotonicNs: sampleZeroRetainedAtMonotonicNs,
          handoffToken: sampleZeroHandoffToken,
        });
      } catch (error) {
        callbackError = error;
      }
      if (options.monitorCallbackBeforeRetention === true) {
        fs.writeFileSync(rawWindowDumps[0].path, Buffer.from("WINDOW MANAGER WINDOWS sample 0\n", "utf8"), { flag: "wx", mode: 0o600 });
      }
      if (callbackError !== null) throw callbackError;
      const rawHealthLogs = elapsedValues.map((_, sampleIndex) => {
        const body = options.monitorLogBodyFactory?.(marker, sampleIndex)
          ?? options.monitorLogBodies?.[sampleIndex]
          ?? `${marker}\nfresh launch sample ${sampleIndex}\n`;
        const bytes = Buffer.from(body, "utf8");
        const logPath = path.join(context.artifactRoot, "logs", `fresh-launch-${String(sampleIndex).padStart(2, "0")}.log`);
        fs.writeFileSync(logPath, bytes, { flag: "wx", mode: 0o600 });
        const evidence = { path: fs.realpathSync(logPath), sha256: sha256(bytes), bytes: bytes.length };
        healthLogs.push(evidence);
        return evidence;
      });
      const samples = elapsedValues.map((elapsedMs, sampleIndex) => ({
        elapsedMs,
        windowProbeStartedAtMonotonicNs: sampleIndex === 0
          ? sampleZeroProbeStartedAtMonotonicNs
          : String(20_000_000n + BigInt(sampleIndex * 15_000) * 1_000_000n),
        windowRetainedAtMonotonicNs: sampleIndex === 0
          ? sampleZeroRetainedAtMonotonicNs
          : String(21_000_000n + BigInt(sampleIndex * 15_000) * 1_000_000n),
        windowHandoffToken: sampleIndex === 0 ? sampleZeroHandoffToken : sha256(canonicalJson({
          runId: context.runId,
          rawWindowSha256: rawWindowDumps[sampleIndex].sha256,
          probeStartedAtMonotonicNs: String(20_000_000n + BigInt(sampleIndex * 15_000) * 1_000_000n),
          retainedAtMonotonicNs: String(21_000_000n + BigInt(sampleIndex * 15_000) * 1_000_000n),
        })),
        dialogs: [],
        safety: { ...cleanSafety },
        continuity: exactContinuity(input, applicationBinding, bootId, String(3_000_000 + elapsedMs)),
        runtimeHealth: {
          schemaVersion: 1,
          sourceSha256: rawHealthLogs[sampleIndex].sha256,
          packageName: input.scenario.packageName,
          expectedPids: [applicationBinding.pid],
          marker,
          markerOccurrences: 1,
          status: "no_attributed_failure",
          incidents: [],
          ambiguousCandidateCount: 0,
          ignoredOtherPackageCount: 0,
          scannedBytes: rawHealthLogs[sampleIndex].bytes,
          tagInventory: [],
        },
      }));
      const receipt = options.monitor ?? {
        durationMs: 60_000,
        healthBoundaryMarker: marker,
        samples,
        rawHealthLogs,
        rawWindowDumps,
      };
      options.afterMonitor?.(receipt);
      return receipt;
    },
    captureSettled: async (captureInput) => {
      calls.push({ kind: "capture", input: captureInput });
      if (options.captureResult) return options.captureResult(captureInput, dependencies.monotonicNs);
      const result = successCapture(captureInput, captureShade, dependencies.monotonicNs);
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
      if (context.phase === "prepare_post_capture") return { ...exact, ...(options.preparePostCaptureContinuity ?? {}) };
      if (context.phase === "restore_post_capture") return { ...exact, ...(options.restorePostCaptureContinuity ?? {}) };
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
          requestControl: "execute",
          executionLeaseMs: bridgeInput.glideDurationMs + 2_000,
          mode: bridgeInput.mode,
          target: { absolute: true, ...target },
          glideDurationMs: bridgeInput.glideDurationMs,
          rootGenerationBefore: bridgeInput.rootGeneration,
          root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: bridgeInput.rootGeneration, incarnation: bridgeInput.rootIncarnation },
          pose: { rootGeneration: resultGeneration, position: target },
          hmdPose: null,
        },
        primaryError: null,
        cleanupError: null,
        motionQuiesced: true,
        nonceCleanup: routeOwnedNonceDisposition(bridgeInput),
        actionReceipts: [],
        evidenceCeiling: "structural",
      };
    },
    cleanupLocomotionNonce: async (context) => {
      calls.push({ kind: "nonceCleanup", context });
      if (options.nonceCleanupError) throw new Error(options.nonceCleanupError);
      return successfulNonceCleanupReceipt(context);
    },
    emitMarker: async (context) => {
      calls.push({ kind: "marker", context });
    },
    collectStepLogs: async (context) => {
      calls.push({ kind: "logs", context });
      const isPrepare = context.beginMarker.endsWith("_PREPARE_BEGIN");
      const injectedLines = isPrepare ? options.prepareLogLines : options.stepLogLines;
      const bytes = Buffer.from([
        context.beginMarker,
        ...(injectedLines ?? []),
        context.endMarker,
      ].join("\n") + "\n", "utf8");
      fs.writeFileSync(context.path, bytes, { flag: "wx", mode: 0o600 });
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
    probeFinalProcessState: async (context) => {
      calls.push({ kind: "finalProcess", context });
      const targetPids = options.finalTargetPresent ? [applicationBinding.pid] : [];
      const priorRelaunchAttempted = calls.some((call) => call.kind === "relaunchPrior");
      const resumedComponents = options.finalResumedComponents ?? (options.finalTargetPresent
        ? [input.scenario.launchComponent]
        : input.priorForeground.kind === "non_receipt_bound"
          ? priorRelaunchAttempted
            ? [input.priorForeground.component]
            : ["com.picoxr.launcher/.Launcher"]
          : ["com.picoxr.launcher/.Launcher"]);
      const pidofOutput = targetPids.join(" ");
      const activityOutput = resumedComponents.map((component) => `mResumedActivity: ActivityRecord{fixture u0 ${component} t1}`).join("\n");
      const bytes = Buffer.from(JSON.stringify({ pidofOutput, activityOutput, targetPids, resumedComponents }) + "\n", "utf8");
      const probePath = path.join(context.artifactRoot, "logs", `999-final-process-activity-${context.evidenceId}.json`);
      fs.writeFileSync(probePath, bytes, { flag: "wx", mode: 0o600 });
      return {
        serial: input.serial,
        targetPackage: input.scenario.packageName,
        targetPids,
        resumedComponents,
        rawProbe: { path: fs.realpathSync(probePath), sha256: sha256(bytes), bytes: bytes.length },
      };
    },
  };
  return { input, dependencies, calls, healthLogs, windowDumps, applicationBinding, bootId, pose, capabilityAck, publishedReceipt, effectiveSpec };
}

test("locomotion reuses one bound window through prepare and step and consumes capture observations", async (t) => {
  const fixture = await createPreparedFixture(t);
  let bindCalls = 0;
  let focused = false;
  let probeCalls = 0;
  let captureCalls = 0;
  fixture.dependencies.bindQemuWindow = async () => {
    bindCalls++;
    return { ok: true, binding: LOCOMOTION_WINDOW };
  };
  fixture.dependencies.focusQemuWindow = async (binding) => {
    assert.equal(binding, LOCOMOTION_WINDOW);
    focused = true;
    return null;
  };
  fixture.dependencies.probeHostWindow = async (serial, binding) => {
    probeCalls++;
    assert.equal(serial, fixture.input.serial);
    assert.equal(binding, LOCOMOTION_WINDOW);
    return clearLocomotionHostWindow({ occluded: !focused, overlappingOwners: focused ? [] : ["Terminal"] });
  };
  const capture = fixture.dependencies.captureSettled;
  fixture.dependencies.captureSettled = async (input, context) => {
    captureCalls++;
    assert.equal(context?.hostWindowBinding, LOCOMOTION_WINDOW);
    const captured = await capture(input);
    captured.receipt.hostWindowProbe = clearLocomotionHostWindow({ observedAt: `capture-${captureCalls}` });
    return captured;
  };
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
  const prepared = await orchestrator.execute(fixture.input);
  assert.equal(prepared.status, "needs_baseline_review");
  const stepped = await orchestrator.execute({
    action: "step", runId: prepared.runId, reviewedPriorFrame: reviewFor(prepared.requiredReview[0]),
    waypoint: structuredClone(fixture.input.route.waypoints[0]),
  });
  assert.equal(stepped.status, "needs_waypoint_review");
  assert.equal(bindCalls, 1);
  assert.equal(prepared.hostWindowFocusRequest.status, "requested");
  assert.equal(stepped.hostWindowFocusRequest.status, "requested");
  const samples = [...prepared.hostWindowProbes, ...stepped.hostWindowProbes];
  assert.equal(samples.length, probeCalls + captureCalls);
  assert.equal(samples.filter((sample) => sample.probe.observedAt.startsWith("capture-")).length, 2);
  assert.equal(probeCalls, 6, "prepare and step retain input/measurement gates without capture-only host queries");
});

test("prepare charges bound-window focus time to its original phase deadline", async (t) => {
  let nowNs = 0n;
  const fixture = await createPreparedFixture(t, {
    inputOverrides: { budgets: { maxDurationMs: 320_000, routeReserveMs: 105_000, restorationReserveMs: 105_000 } },
    monotonicNs: () => nowNs,
  });
  fixture.dependencies.focusQemuWindow = async () => { nowNs = 111_000_000_000n; return null; };
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /deadline|budget/i);
  assert.equal(fixture.calls.some((call) => call.kind === "snapshotPrior" || call.kind === "launch"), false,
    "focus must not restart a fresh preparation budget after the admitted phase has elapsed");
});

test("locomotion refuses a retained covered baseline capture before accepting its review", async (t) => {
  const fixture = await createPreparedFixture(t);
  const capture = fixture.dependencies.captureSettled;
  fixture.dependencies.captureSettled = async (input) => {
    const captured = await capture(input);
    captured.receipt.hostWindowProbe = clearLocomotionHostWindow({ occluded: true, overlappingOwners: ["Terminal"] });
    return captured;
  };
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "preparation_failed");
  assert.equal(result.structuralStop, "host_window_occluded");
  assert.equal(fixture.calls.some((call) => call.kind === "readReview"), false);
});

test("injected locomotion device runners cannot fall through capture or host operations into real processes", async (t) => {
  const liveEffects = [];
  const deny = (name) => () => {
    liveEffects.push(name);
    throw new Error(`forbidden live effect: ${name}`);
  };
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    t.mock.method(childProcess, name, deny(name));
  }
  t.mock.method(net.Socket.prototype, "connect", deny("socket.connect"));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const unused = () => { throw new Error("injected runner must not be needed for unsupported capability"); };
  const selfModifying = {
    resolveAdb: () => { delete selfModifying.resolveAdb; return "/fixture/adb"; },
    runText: unused, runBytes: unused, sleep: unused, monotonicNs: () => 1n,
  };
  for (const options of [
    { resolveAdb: () => "/fixture/adb", runText: unused, runBytes: unused, sleep: unused, monotonicNs: () => 1n },
    Object.create({ resolveAdb: () => "/fixture/adb", runText: unused, runBytes: unused, sleep: unused, monotonicNs: () => 1n }),
    selfModifying,
  ]) {
    const dependencies = worldLocomotion.createLiveInAppLocomotionDependencies(options);
    const capture = dependencies.captureSettled({ serial: "emulator-5554", outPath: path.join(os.tmpdir(), "injected-locomotion.png"), maxTries: 2, intervalMs: 0, comparison: "byte_exact" });
    await assert.rejects(capture, /capture is unavailable with injected device runners/);
    assert.equal((await dependencies.bindQemuWindow("emulator-5554")).ok, false);
    assert.match(await dependencies.focusQemuWindow(LOCOMOTION_WINDOW), /unavailable/);
    assert.equal((await dependencies.probeHostWindow("emulator-5554", LOCOMOTION_WINDOW)).status, "unavailable");
  }
  assert.deepEqual(liveEffects, [], "complete fake device runners cannot unlock omitted host or capture backends");
});

test("locomotion adb and bridge preparation is available off macOS without binding or focusing a host window", async (t) => {
  for (const platform of ["linux", "win32"]) await t.test(platform, async (t) => {
    const fixture = await createPreparedFixture(t);
    fixture.dependencies.platform = platform;
    fixture.dependencies.bindQemuWindow = async () => { throw new Error("host binding must not run"); };
    fixture.dependencies.focusQemuWindow = async () => { throw new Error("host focus must not run"); };
    fixture.dependencies.probeHostWindow = async () => { throw new Error("CoreGraphics must not run"); };
    const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
    assert.equal(result.status, "needs_baseline_review");
    assert.equal(result.hostWindowFocusRequest.status, "not_applicable");
    assert.ok(result.hostWindowProbes.every((sample) => sample.probe.status === "not_applicable"));
    assert.ok(fixture.calls.some((call) => call.kind === "launch"));
  });
});

test("prepare host-window precondition refuses occluded, missing, and unavailable windows before device effects", async (t) => {
  for (const [label, probe, code] of [
    ["covered despite frontmost", clearLocomotionHostWindow({ occluded: true, overlappingOwners: ["Terminal", "Codex"] }), "host_window_occluded"],
    ["no window", clearLocomotionHostWindow({ status: "no_window", occluded: null, frontmost: null, qemuWindowId: null, qemuWindowOwnerPid: null }), "host_window_unavailable"],
    ["missing dependency", null, "host_window_unavailable"],
    ["throwing dependency", new Error("window inventory failed"), "host_window_unavailable"],
  ]) await t.test(label, async (t) => {
    const fixture = await createPreparedFixture(t);
    if (probe === null) delete fixture.dependencies.probeHostWindow;
    else fixture.dependencies.probeHostWindow = async () => {
      if (probe instanceof Error) throw probe;
      return structuredClone(probe);
    };
    const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
    assert.equal(result.status, "preflight_rejected");
    assert.equal(result.structuralStop, code);
    if (code === "host_window_occluded") {
      assert.match(result.primaryError, /Terminal/);
      assert.match(result.primaryError, /Codex/);
    }
    assert.equal(result.hostWindowProbes.length, 1);
    assert.equal(result.hostWindowProbe.status, probe === null || probe instanceof Error ? "unavailable" : probe.status);
    assert.deepEqual(deviceCalls(fixture.calls), []);
    assert.equal(fs.existsSync(fixture.input.artifactRoot), false);
  });
});

test("prepare records non-frontmost clear-window probes in returned and immutable receipts", async (t) => {
  const fixture = await createPreparedFixture(t);
  fixture.dependencies.probeHostWindow = async () => clearLocomotionHostWindow({ frontmost: false });
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "needs_baseline_review");
  assert.equal(result.hostWindowProbe.frontmost, false);
  assert.ok(result.hostWindowProbes.length >= 3);
  assert.deepEqual(committedActionPayloads(fixture.input.artifactRoot)[0].hostWindowProbes, result.hostWindowProbes);
});

test("prepare refuses a covered baseline after capture and retains the probe in its failed receipt", async (t) => {
  const fixture = await createPreparedFixture(t);
  fixture.dependencies.probeHostWindow = async () => clearLocomotionHostWindow(
    fixture.calls.some((call) => call.kind === "capture")
      ? { occluded: true, overlappingOwners: ["Terminal"] } : {},
  );
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "preparation_failed");
  assert.equal(result.structuralStop, "host_window_occluded");
  assert.equal(result.hostWindowProbe.occluded, true);
  assert.deepEqual(result.requiredReview, []);
  const action = committedActionPayloads(fixture.input.artifactRoot)[0];
  assert.equal(action.status, "failed");
  assert.deepEqual(action.hostWindowProbes, result.hostWindowProbes);
});

test("step host-window precondition refuses covered or missing windows before movement and distance measurements", async (t) => {
  for (const [label, probe, code] of [
    ["occluded", clearLocomotionHostWindow({ occluded: true, overlappingOwners: ["Terminal"] }), "host_window_occluded"],
    ["no window", clearLocomotionHostWindow({ status: "no_window", occluded: null, frontmost: null, qemuWindowId: null, qemuWindowOwnerPid: null }), "host_window_unavailable"],
  ]) await t.test(label, async (t) => {
    const fixture = await prepareForSteps(t);
    fixture.calls.length = 0;
    fixture.dependencies.probeHostWindow = async () => structuredClone(probe);
    const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
    assert.equal(result.status, "stopped");
    assert.equal(result.structuralStop, code);
    assert.equal(result.hmdDrift, null);
    assert.equal(result.usage.successfulWaypoints, 0);
    assert.deepEqual(deviceCalls(fixture.calls), []);
    const action = committedActionPayloads(fixture.input.artifactRoot).find((entry) => entry.action === "step");
    assert.deepEqual(action.hostWindowProbes, result.hostWindowProbes);
  });
});

test("step refuses HMD distance proof if the host becomes covered after motion or capture", async (t) => {
  for (const moment of ["motion", "capture", "post-hmd"]) await t.test(moment, async (t) => {
    const fixture = await prepareForSteps(t);
    fixture.calls.length = 0;
    fixture.dependencies.probeHostWindow = async () => clearLocomotionHostWindow(
      fixture.calls.some((call) => moment === "motion" ? call.kind === "locomote"
        : moment === "capture" ? call.kind === "capture"
          : call.kind === "hmd" && call.input.tag.endsWith("-post"))
        ? { occluded: true, overlappingOwners: ["Terminal"] } : {},
    );
    const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
    assert.equal(result.status, "stopped");
    assert.equal(result.structuralStop, "host_window_occluded");
    assert.match(result.primaryError, /Terminal/);
    assert.equal(result.hmdDrift, null);
    assert.equal(result.usage.successfulWaypoints, 0);
    assert.equal(fixture.calls.filter((call) => call.kind === "locomote").length, 1);
    assert.equal(result.hostWindowProbe.occluded, true);
    const action = committedActionPayloads(fixture.input.artifactRoot).find((entry) => entry.action === "step");
    assert.equal(action.hmdDrift, null);
    assert.deepEqual(action.hostWindowProbes, result.hostWindowProbes);
  });
});

test("step rechecks its measurement deadline after a slow clear host-window probe", async (t) => {
  let nowNs = 2_000_000_000n;
  const fixture = await prepareForSteps(t, { monotonicNs: () => ++nowNs });
  fixture.calls.length = 0;
  fixture.dependencies.probeHostWindow = async () => {
    if (fixture.calls.some((call) => call.kind === "hmd" && call.input.tag.endsWith("-post"))) {
      nowNs += 1_000_000_000_000n;
    }
    return clearLocomotionHostWindow();
  };
  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(result.status, "stopped");
  assert.equal(result.hmdDrift, null, "expired host observation cannot authorize a distance proof");
  assert.equal(result.usage.successfulWaypoints, 0);
});

test("registered locomotion error receipts retain sampled host visibility and identify unknown visibility", async (t) => {
  const fixture = await createPreparedFixture(t);
  let handler;
  registerInAppLocomotionTools({ registerTool(_name, _definition, run) { handler = run; } }, fixture.dependencies);
  const receipt = (response) => JSON.parse(response.content.find((item) => item.type === "text").text);
  const prepared = receipt(await handler(fixture.input));
  assert.equal(prepared.status, "needs_baseline_review");
  fixture.calls.length = 0;
  const covered = clearLocomotionHostWindow({ occluded: true, overlappingOwners: ["Terminal"] });
  fixture.dependencies.probeHostWindow = async () => structuredClone(covered);

  for (const request of [
    { action: "step", runId: prepared.runId, reviewedPriorFrame: reviewFor(prepared.requiredReview[0]),
      waypoint: { ...structuredClone(fixture.input.route.waypoints[0]), seq: 2 } },
    { action: "adjudicate", runId: prepared.runId, frameAttestations: [reviewFor(prepared.requiredReview[0])] },
  ]) {
    const rejected = receipt(await handler(request));
    assert.equal(rejected.status, "error");
    assert.deepEqual(rejected.hostWindowProbe, covered, `${request.action} rejection must retain its observation`);
    assert.deepEqual(rejected.hostWindowProbes, [{ phase: `${request.action}_preflight`, probe: covered }]);
  }
  const unknown = receipt(await handler({ action: "adjudicate", runId: "f".repeat(64), frameAttestations: [reviewFor(prepared.requiredReview[0])] }));
  assert.equal(unknown.status, "error");
  assert.equal(unknown.hostWindowProbe.status, "unavailable");
  assert.equal(unknown.hostWindowProbe.occluded, null);
  assert.deepEqual(unknown.hostWindowProbes, []);
  assert.deepEqual(deviceCalls(fixture.calls), [], "rejected actions must not issue device commands");
});

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
    "readReceipt", "readSpec", "randomBytes", "snapshotPrior", "marker", "stop", "launch", "launchObservation", "launchWindow", "probeRuntime",
    "safety", "capability", "hmd", "monitor", "capture", "readReview", "continuity", "capability", "marker", "logs",
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
  assertCaptureInvocation(prepareAction);
  assert.equal(prepareAction.postCaptureContinuity.pid, fixture.applicationBinding.pid);
  assert.deepEqual(prepareAction.postCaptureCapability.ack.root, fixture.capabilityAck.root);
  assert.equal(prepareAction.preparationLogEvidence.beginCount, 1);
  assert.equal(prepareAction.preparationLogEvidence.endCount, 1);
  assert.equal(fixture.calls.some((call) => call.kind === "locomote"), false);
});

test("prepare rejects any capture receipt that is not exact evidence for the requested stable frame", async (t) => {
  const corruptions = [
    ["resolved mode", (result) => { result.receipt.mode = "transition_then_stable"; }],
    ["stable pair", (result) => { result.receipt.stablePair[0] = "f".repeat(64); }],
    ["receipt path", (result) => { result.receipt.path = `${result.receipt.path}.other`; }],
    ["receipt serial", (result) => { result.receipt.serial = "emulator-5556"; }],
    ["capture-ref path", (result) => { result.receipt.captureRef.path = `${result.receipt.captureRef.path}.other`; }],
    ["capture-ref source serial", (result) => { result.receipt.captureRef.sourceSerial = "emulator-5556"; }],
    ["capture-ref byte count", (result) => { result.receipt.captureRef.bytes += 1; }],
    ["capture-ref dimensions", (result) => { result.receipt.captureRef.dimensions.width += 1; }],
    ["runtime serial", (result) => { result.receipt.captureRuntimeBinding.serial = "emulator-5556"; }],
    ["runtime live serial", (result) => { result.receipt.captureRuntimeBinding.liveIdentity.serial = "emulator-5556"; }],
    ["runtime model", (result) => { result.receipt.captureRuntimeBinding.liveIdentity.model = "different model"; }],
    ["runtime fingerprint", (result) => { result.receipt.captureRuntimeBinding.liveIdentity.fingerprint = "different/fingerprint"; }],
    ["runtime boot-qemu", (result) => { result.receipt.captureRuntimeBinding.liveIdentity.bootQemu = "0"; }],
    ["runtime boot ID", (result) => { result.receipt.captureRuntimeBinding.liveIdentity.bootId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"; }],
    ["runtime capture source", (result) => { result.receipt.captureRuntimeBinding.captureSource = "forged-source"; }],
    ["replayed same-boot runtime interval", (result) => { shiftCaptureTimeline(result, -100_000_000n); }],
    ["future same-boot runtime interval", (result) => { shiftCaptureTimeline(result, 100_000_000n); }],
    ["settle start before runtime binding", (result) => {
      result.receipt.deadlineMonotonicNs = (
        BigInt(result.receipt.captureRuntimeBinding.startedAtMonotonicNs)
        + BigInt(result.receipt.deadlineMs) * 1_000_000n
        - 1n
      ).toString();
    }],
    ["runtime interval", (result) => {
      result.receipt.captureRuntimeBinding.endedAtMonotonicNs = (
        BigInt(result.receipt.captureRuntimeBinding.startedAtMonotonicNs) - 1n
      ).toString();
    }],
    ["trace length", (result) => { result.receipt.attempts = 3; }],
    ["attempts exceed request maximum", (result) => {
      const digest = result.receipt.sha256;
      result.receipt.attempts = 5;
      result.receipt.trace = [
        { attempt: 1, capturedAtMonotonicNs: "8000000001", sha256: "b".repeat(64), relation: "candidate" },
        { attempt: 2, capturedAtMonotonicNs: "8000000002", sha256: "c".repeat(64), relation: "candidate" },
        { attempt: 3, capturedAtMonotonicNs: "8000000003", sha256: "d".repeat(64), relation: "candidate" },
        { attempt: 4, capturedAtMonotonicNs: "8000000004", sha256: digest, relation: "candidate" },
        { attempt: 5, capturedAtMonotonicNs: "8000000005", sha256: digest, relation: "stable" },
      ];
    }],
    ["trace sequence", (result) => { result.receipt.trace[1].attempt = 3; }],
    ["trace relation vocabulary", (result) => { result.receipt.trace[0].relation = "forged"; }],
    ["trace monotonic order", (result) => { result.receipt.trace[1].capturedAtMonotonicNs = "8000000000"; }],
    ["early stable relation", (result) => {
      const digest = result.receipt.sha256;
      result.receipt.attempts = 3;
      result.receipt.trace = [
        { attempt: 1, capturedAtMonotonicNs: "8000000001", sha256: "b".repeat(64), relation: "stable" },
        { attempt: 2, capturedAtMonotonicNs: "8000000002", sha256: digest, relation: "candidate" },
        { attempt: 3, capturedAtMonotonicNs: "8000000003", sha256: digest, relation: "stable" },
      ];
    }],
    ["trace outside runtime binding", (result) => {
      result.receipt.captureRuntimeBinding.endedAtMonotonicNs = result.receipt.trace[0].capturedAtMonotonicNs;
    }],
    ["trace final relation", (result) => { result.receipt.trace[1].relation = "candidate"; }],
    ["settle deadline duration", (result) => { result.receipt.deadlineMs += 1; }],
    ["attempt timeout duration", (result) => { result.receipt.attemptTimeoutMs += 1; }],
    ["settle deadline outside phase", (result) => { result.receipt.deadlineMonotonicNs = "999999999999999999"; }],
    ["settled timeout residue", (result) => { result.receipt.timeoutPhase = "awaiting_stability"; }],
    ["settled error residue", (result) => { result.receipt.error = { code: "forged", detail: "not settled" }; }],
    ["returned frame bytes", (result) => { result.frame = makePng(99); }],
  ];
  for (const [label, corrupt] of corruptions) {
    await t.test(label, async (t) => {
      const fixture = await createPreparedFixture(t, {
        captureResult(captureInput, monotonicNs) {
          const result = successCapture(captureInput, 48, monotonicNs);
          corrupt(result);
          return result;
        },
      });
      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "preparation_failed");
      assert.match(result.primaryError, /capture|frame|runtime|trace|settle|serial|path|identity/i);
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
    });
  }
});

test("prepare rechecks exact application and root continuity after the baseline capture before publishing state", async (t) => {
  const cases = [
    ["target exited", { preparePostCaptureContinuity: { foreground: "missing", resumedComponents: [] } }],
    ["target restarted", { preparePostCaptureContinuity: { pid: 6161, pidStartTicks: "987654321" } }],
    ["root re-registered in the same process", { postCaptureRoot: { generation: 8, incarnation: REPLACEMENT_INCARNATION } }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async (t) => {
      const fixture = await createPreparedFixture(t, options);
      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "preparation_failed");
      assert.match(result.primaryError, /binding|continuity|root|generation|incarnation/i);
      const captureIndex = fixture.calls.findIndex((call) => call.kind === "capture");
      const continuityIndex = fixture.calls.findIndex((call) => call.kind === "continuity" && call.context.phase === "prepare_post_capture");
      assert.ok(captureIndex >= 0 && continuityIndex > captureIndex);
      const actions = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      const failedAction = actions.at(-1);
      assert.equal(failedAction.status, "failed");
      assert.equal(failedAction.postCaptureContinuity.pid, options.preparePostCaptureContinuity?.pid ?? fixture.applicationBinding.pid);
      if (label.includes("root")) assert.equal(failedAction.postCaptureCapability.ack.root.generation, 8);
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
    });
  }
});

test("prepare brackets and retains launch-handoff boundary evidence without applying the step zero-signal gate", async (t) => {
  const fixture = await createPreparedFixture(t, {
    prepareLogLines: [
      "09-02 I Spatial: setSpatialContainerBoundary applied",
      "09-02 I Spatial: container info changed for stage",
    ],
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
    ["dialog", { afterMonitor(receipt) { receipt.samples[0].dialogs = ["Application Error"]; } }],
    ["health", { afterMonitor(receipt) {
      receipt.samples[0].runtimeHealth.status = "attributed_failure";
      receipt.samples[0].runtimeHealth.incidents = [{ kind: "anr" }];
    } }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async (t) => {
      const fixture = await createPreparedFixture(t, options);
      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "preparation_failed");
      if (label === "dialog") assert.match(result.primaryError, /dialog/i);
      if (label === "health") assert.match(result.primaryError, /health|failure|incident/i);
      assert.equal(fixture.calls.filter((call) => call.kind === "locomote").length, 0);
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
    });
  }
});

async function prepareForSteps(t, options = {}) {
  const fixture = await createPreparedFixture(t, options);
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, options.artifactHooks);
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
    "readReview", "readReceipt", "readSpec", "marker", "safety", "continuity", "hmd", "locomote", "nonceCleanup", "capture",
    "hmd", "safety", "continuity", "marker", "logs", "readReview",
  ]);
  assert.match(fixture.calls[3].context.marker, /_BEGIN$/);
  assert.match(fixture.calls[13].context.marker, /_END$/);
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
  assert.deepEqual(result.hmdDrift.freshness, {
    method: "guest_listener_arrival_age_and_strict_sequence_and_time",
    maximumSampleAgeMs: 250,
    baseline: { sampleSequence: "1", sampleObservedAtMonotonicNs: "1000000", readAtMonotonicNs: "2000000", sampleAgeMs: 1 },
    pre: { sampleSequence: "2", sampleObservedAtMonotonicNs: "2000000", readAtMonotonicNs: "3000000", sampleAgeMs: 1 },
    post: { sampleSequence: "3", sampleObservedAtMonotonicNs: "3000000", readAtMonotonicNs: "4000000", sampleAgeMs: 1 },
    sequencesStrictlyIncreasing: true,
    observationTimesStrictlyIncreasing: true,
    readTimesStrictlyIncreasing: true,
    pass: true,
  });
  assert.equal(result.hmdDrift.quaternion.method, "2*acos(abs(normalized_dot))");
  assert.equal("threshold" in result.hmdDrift.quaternion, false);
  assert.equal(fs.existsSync(result.logEvidence.path), true);
  assert.equal(result.usage.waypointAttempts, 1);
  const stepAction = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.equal(stepAction.pre.safety.guardian, "1");
  assert.equal(stepAction.pre.continuity.pid, fixture.applicationBinding.pid);
  assert.deepEqual(stepAction.pre.hmdPose.position, fixture.pose.position);
  assert.equal(stepAction.locomotion.ack.mode, "direct");
  assert.deepEqual(stepAction.locomotionNonceCleanup, successfulNonceCleanupReceipt(
    fixture.calls.find((call) => call.kind === "nonceCleanup").context,
  ));
  assert.equal(stepAction.captureReceipt.mode, "transition_then_stable");
  assertCaptureInvocation(stepAction);
  assert.deepEqual(stepAction.post.hmdPose.position, fixture.pose.position);
  assert.equal(stepAction.post.safety.safeguard, "1");
  assert.equal(stepAction.post.continuity.foreground, "exact_allowed");
});

test("step rejects a settled pair whose final SHA never transitioned from the exact prior frame", async (t) => {
  const fixture = await prepareForSteps(t, {
    captureResult: (captureInput, monotonicNs) => successCapture(captureInput, 48, monotonicNs),
  });

  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(result.status, "stopped");
  assert.match(result.primaryError, /transition|prior|unchanged/i);
  assert.equal(result.requiredReview[0].captureSha256, fixture.baselineReview.captureSha256);
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
    requestControl: "execute",
    executionLeaseMs: input.glideDurationMs + 2_000,
    mode: input.mode,
    target: { absolute: true, ...target },
    glideDurationMs: input.glideDurationMs,
    rootGenerationBefore: input.rootGeneration,
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: input.rootGeneration, incarnation: input.rootIncarnation },
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
        motionQuiesced: true,
        nonceCleanup: routeOwnedNonceDisposition(input),
        actionReceipts: [],
        evidenceCeiling: "structural",
      }
    : {
        ok: true,
        ack,
        primaryError: null,
        cleanupError: null,
        motionQuiesced: true,
        nonceCleanup: routeOwnedNonceDisposition(input),
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
      fixture.dependencies.probeCapability = async (input) => {
        fixture.calls.push({ kind: "capability", input });
        const generation = input.tag === "restore-post-capture" && mechanism === "replacement"
          ? expectedGeneration + 1
          : expectedGeneration;
        return {
          ok: true,
          ack: { ...fixture.capabilityAck, requestId: input.requestId, root: { ...fixture.capabilityAck.root, generation } },
          primaryError: null,
          cleanupError: null,
          actionReceipts: [],
          evidenceCeiling: "structural",
        };
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
    restorePostCaptureRoot: { generation: 8 },
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
          outcome: "completed", requestControl: "execute", executionLeaseMs: input.glideDurationMs + 2_000,
          mode: input.mode, target: { absolute: true, ...input.target }, glideDurationMs: input.glideDurationMs,
          rootGenerationBefore: input.rootGeneration,
          root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: input.rootGeneration, incarnation: input.rootIncarnation },
          pose: { rootGeneration: input.rootGeneration + 9, position: input.target }, hmdPose: null,
        },
        primaryError: null, cleanupError: null, motionQuiesced: true, actionReceipts: [], evidenceCeiling: "structural",
      }),
    }],
    ["transition timeout", { captureResult: (input, monotonicNs) => input.mode === "stable" ? successCapture(input, 48, monotonicNs) : failedCapture(input, "transition_timeout") }],
    ["stability timeout", { captureResult: (input, monotonicNs) => input.mode === "stable" ? successCapture(input, 48, monotonicNs) : failedCapture(input, "stability_timeout") }],
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

test("prepare retries stale HMD ages with unique nonces and retains acquisition evidence", async (t) => {
  const fixture = await createPreparedFixture(t);
  const original = fixture.dependencies.requestHmdPose;
  const ages = [366.425, 305.271, 250];
  let index = 0;
  fixture.dependencies.requestHmdPose = async (input) => {
    const result = await original(input);
    const ageMs = ages[Math.min(index++, ages.length - 1)];
    result.ack.hmdPose.sampleObservedAtMonotonicNs = String(BigInt(index) * 1_000_000_000n);
    result.ack.hmdPose.readAtMonotonicNs = String(BigInt(result.ack.hmdPose.sampleObservedAtMonotonicNs) + BigInt(Math.round(ageMs * 1_000_000)));
    return result;
  };
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "needs_baseline_review", result.primaryError);
  const requests = fixture.calls.filter(({ kind }) => kind === "hmd");
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(({ input }) => input.requestId)).size, 3);
  const action = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.equal(action.hmdBaselineAcquisition.attemptCount, 3);
  assert.equal(action.hmdBaselineAcquisition.acceptedSampleAgeMs, 250);
  assert.deepEqual(action.hmdBaselineAcquisition.attempts.map(({ sampleAgeMs }) => sampleAgeMs), ages);
  assert.deepEqual(action.hmdBaselineAcquisition.attempts.map(({ outcome }) => outcome), ["hmd_pose_stale", "hmd_pose_stale", "accepted"]);
  assert.deepEqual(action.hmdBaselineAcquisition.attempts.map(({ requestId }) => requestId), requests.map(({ input }) => input.requestId));
});

test("step HMD retries preserve strict baseline-to-pre-to-post advancement and action evidence", async (t) => {
  const fixture = await prepareForSteps(t);
  const original = fixture.dependencies.requestHmdPose;
  const attempts = new Map();
  let acceptedPre;
  fixture.dependencies.requestHmdPose = async (input) => {
    const result = await original(input);
    const attempt = (attempts.get(input.tag) ?? 0) + 1;
    attempts.set(input.tag, attempt);
    if (input.tag.endsWith("-pre")) {
      if (attempt === 1) result.ack.hmdPose = { ...fixture.pose };
      else acceptedPre = result.ack.hmdPose;
    } else if (attempt === 1) result.ack.hmdPose = { ...acceptedPre };
    return result;
  };
  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(result.status, "needs_waypoint_review", result.primaryError);
  const requests = fixture.calls.filter(({ kind }) => kind === "hmd");
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests.map(({ input }) => input.requestId)).size, 4);
  const action = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  for (const phase of ["pre", "post"]) {
    assert.equal(action[phase].hmdAcquisition.attemptCount, 2);
    assert.equal(action[phase].hmdAcquisition.acceptedSampleAgeMs, 1);
    assert.deepEqual(action[phase].hmdAcquisition.attempts.map(({ outcome }) => outcome), ["hmd_pose_stale", "accepted"]);
  }
  assert.ok(BigInt(action.pre.hmdPose.sampleSequence) > BigInt(fixture.pose.sampleSequence));
  assert.ok(BigInt(action.post.hmdPose.sampleSequence) > BigInt(action.pre.hmdPose.sampleSequence));
  assert.ok(BigInt(action.post.hmdPose.sampleObservedAtMonotonicNs) > BigInt(action.pre.hmdPose.sampleObservedAtMonotonicNs));
  assert.ok(BigInt(action.post.hmdPose.readAtMonotonicNs) > BigInt(action.pre.hmdPose.readAtMonotonicNs));
  assert.equal(fixture.calls.filter(({ kind }) => kind === "locomote").length, 1);
});

test("HMD acquisition does not retry malformed, unbound, or failed transport results", async (t) => {
  for (const [label, mutate] of [
    ["nonfinite", (result) => { result.ack.hmdPose.position.x = NaN; return result; }],
    ["root changed", (result) => { result.ack.root.incarnation = REPLACEMENT_INCARNATION; return result; }],
    ["bridge failure", () => ({ ok: false, code: "bridge_unavailable", primaryError: "HMD transport unavailable", detail: "HMD transport unavailable", cleanupError: null })],
    ["stale with cleanup failure", (result) => ({ ...result, ok: false, code: "cleanup_failed", primaryError: null, detail: "HMD sampled but cleanup failed", cleanupError: "nonce removal failed" })],
  ]) {
    await t.test(label, async (t) => {
      const fixture = await createPreparedFixture(t);
      const original = fixture.dependencies.requestHmdPose;
      fixture.dependencies.requestHmdPose = async (input) => mutate(await original(input));
      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "preparation_failed");
      assert.equal(fixture.calls.filter(({ kind }) => kind === "hmd").length, 1);
      if (label === "stale with cleanup failure") assert.match(result.cleanupError, /nonce removal failed/);
    });
  }
});

test("persistent stale HMD retries stop under the phase deadline and retain failed acquisition evidence", async (t) => {
  let nowNs = 1_000_000_000n;
  const fixture = await createPreparedFixture(t, { monotonicNs: () => nowNs });
  fixture.dependencies.sleep = async (ms) => { nowNs += BigInt(ms) * 1_000_000n; };
  const original = fixture.dependencies.requestHmdPose;
  const starts = [];
  fixture.dependencies.requestHmdPose = async (input) => {
    starts.push({ at: nowNs, deadline: BigInt(input.deadlineMonotonicNs) });
    nowNs += 100_000_000n;
    const result = await original(input);
    result.ack.hmdPose.readAtMonotonicNs = String(BigInt(result.ack.hmdPose.sampleObservedAtMonotonicNs) + 366_425_000n);
    return result;
  };
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "preparation_failed");
  assert.ok(starts.length > 1);
  assert.ok(starts.every(({ at, deadline }) => at < deadline));
  assert.equal(fixture.calls.some(({ kind }) => kind === "monitor" || kind === "locomote"), false);
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(action.hmdBaselineAcquisition.attemptCount, starts.length);
  assert.equal(action.hmdBaselineAcquisition.acceptedSampleAgeMs, null);
  assert.ok(action.hmdBaselineAcquisition.attempts.some(({ sampleAgeMs }) => sampleAgeMs === 366.425));
  assert.equal(action.hmdBaselineAcquisition.policy.maxAttempts, 12);
  assert.equal(action.hmdBaselineAcquisition.policy.pollMs, 100);
  assert.ok(starts.length <= action.hmdBaselineAcquisition.policy.maxAttempts);
  assert.equal(action.hmdBaselineAcquisition.policy.reservedAfterMs, 79_651);
  assert.ok(BigInt(action.hmdBaselineAcquisition.policy.deadlineMonotonicNs) <= 31_349_000_000n);
});

test("HMD acquisition spans a full callback interval and retains bridge cleanup evidence", async (t) => {
  const fixture = await createPreparedFixture(t);
  const original = fixture.dependencies.requestHmdPose;
  let calls = 0;
  let waitedMs = 0;
  const originalSleep = fixture.dependencies.sleep;
  fixture.dependencies.sleep = async (ms) => { waitedMs += ms; await originalSleep(ms); };
  fixture.dependencies.requestHmdPose = async (input) => {
    const result = await original(input);
    calls += 1;
    const age = calls < 12 ? 300_000_000n : 250_000_000n;
    result.ack.hmdPose.sampleObservedAtMonotonicNs = String(BigInt(calls) * 1_000_000_000n);
    result.ack.hmdPose.readAtMonotonicNs = String(BigInt(result.ack.hmdPose.sampleObservedAtMonotonicNs) + age);
    result.actionReceipts = [{
      action: "locomotion_ack_cleanup", status: "applied", startedAtMonotonicNs: "1000000", endedAtMonotonicNs: "2000000",
      ack: { serial: input.serial, packageName: input.packageName, operation: "hmd_pose", requestId: input.requestId,
        relativePath: `cache/agentbridge/locomotion/${input.requestId}.json`, outcome: "completed" },
    }];
    return result;
  };
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "needs_baseline_review", result.primaryError);
  assert.ok(waitedMs >= 1_000);
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(action.hmdBaselineAcquisition.attemptCount, 12);
  assert.equal(action.hmdBaselineAcquisition.policy.maxSampleAgeMs, 250);
  for (const attempt of action.hmdBaselineAcquisition.attempts) {
    assert.deepEqual(attempt.actionReceipts, [{
      action: "locomotion_ack_cleanup", status: "applied", startedAtMonotonicNs: "1000000", endedAtMonotonicNs: "2000000",
      ack: { serial: "emulator-5554", packageName: "com.test.fullworld", operation: "hmd_pose", requestId: attempt.requestId,
        relativePath: `cache/agentbridge/locomotion/${attempt.requestId}.json`, outcome: "completed" },
    }]);
    assert.equal(attempt.cleanupError, null);
  }
});

test("HMD acquisition never retries temporal regression, incoherent advancement, or changed duplicate poses", async (t) => {
  for (const [label, modify] of [
    ["read before observation", (pose) => ({ ...pose, sampleSequence: "2", readAtMonotonicNs: "0" })],
    ["observation only advances", (pose) => ({ ...pose, sampleObservedAtMonotonicNs: "2000000", readAtMonotonicNs: "3000000" })],
    ["sequence only advances", (pose) => ({ ...pose, sampleSequence: "2", readAtMonotonicNs: "3000000" })],
    ["aged regression", (pose) => ({ ...pose, sampleSequence: "2", sampleObservedAtMonotonicNs: "0", readAtMonotonicNs: "300000000" })],
    ["duplicate changes pose", (pose) => ({ ...pose, position: { ...pose.position, x: pose.position.x + 0.001 } })],
  ]) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t);
      const original = fixture.dependencies.requestHmdPose;
      let requests = 0;
      fixture.dependencies.requestHmdPose = async (input) => {
        const result = await original(input);
        if (++requests === 1) result.ack.hmdPose = modify(fixture.pose);
        return result;
      };
      const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
      assert.equal(result.status, "stopped");
      assert.equal(requests, 1);
      assert.equal(fixture.calls.some(({ kind }) => kind === "locomote"), false);
    });
  }
});

test("prepare and route admission reserve bounded HMD acquisition plus downstream evidence work", (t) => {
  const tooShortPrepare = prepareRouteInput(t, { budgets: { maxDurationMs: 329_452, routeReserveMs: 110_000, restorationReserveMs: 110_000 } });
  const justLongEnoughPrepare = prepareRouteInput(t, {
    artifactRoot: externalArtifactRoot(t, "prepare-publication-budget"),
    budgets: { maxDurationMs: 329_453, routeReserveMs: 110_000, restorationReserveMs: 110_000 },
  });
  const tooShortRoute = prepareRouteInput(t, { budgets: { maxDurationMs: 350_000, routeReserveMs: 104_313, restorationReserveMs: 110_000 } });
  assert.equal(inAppLocomotionInputSchema.safeParse(tooShortPrepare).success, false);
  assert.equal(inAppLocomotionInputSchema.safeParse(justLongEnoughPrepare).success, true);
  assert.equal(inAppLocomotionInputSchema.safeParse(tooShortRoute).success, false);
});

test("HMD acquisition rejects rollback from an aged candidate without promoting that candidate to the accepted floor", async (t) => {
  const fixture = await prepareForSteps(t);
  const original = fixture.dependencies.requestHmdPose;
  let requests = 0;
  fixture.dependencies.requestHmdPose = async (input) => {
    const result = await original(input);
    result.ack.hmdPose = { ...fixture.pose, ...(requests++ === 0
      ? { sampleSequence: "100", sampleObservedAtMonotonicNs: "100000000", readAtMonotonicNs: "400000000" }
      : { sampleSequence: "99", sampleObservedAtMonotonicNs: "200000000", readAtMonotonicNs: "401000000" }) };
    return result;
  };
  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(result.status, "stopped");
  assert.equal(requests, 2);
  assert.equal(fixture.calls.some(({ kind }) => kind === "locomote"), false);
  assert.match(result.primaryError, /regress|candidate|incoherent/i);
});

test("step cannot complete when valid END or log evidence finishes after its fixed deadline", async (t) => {
  for (const [phase, priorFailure] of [["END", false], ["logs", false], ["logs", true]]) {
    await t.test(`${phase} priorFailure=${priorFailure}`, async (t) => {
      const fixture = await prepareForSteps(t, priorFailure ? { continuitySequence: [{ foreground: "different_package" }] } : {});
      let nowNs = 2_000_000_000n;
      fixture.dependencies.monotonicNs = () => ++nowNs;
      const emit = fixture.dependencies.emitMarker;
      const logs = fixture.dependencies.collectStepLogs;
      fixture.dependencies.emitMarker = async (context) => {
        const result = await emit(context);
        if (phase === "END" && context.marker.endsWith("_END")) nowNs = BigInt(context.deadlineMonotonicNs) + 1n;
        return result;
      };
      fixture.dependencies.collectStepLogs = async (context) => {
        const result = await logs(context);
        if (phase === "logs") nowNs = BigInt(context.deadlineMonotonicNs) + 1n;
        return result;
      };
      const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
      assert.equal(result.status, "stopped");
      assert.equal(result.structuralStop, priorFailure ? "binding_lost" : phase === "END" ? "step_cleanup_failed" : "budget_exhausted");
      assert.match(priorFailure || phase === "END" ? result.cleanupError : result.primaryError, /deadline/i);
      const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(action.status, "stopped");
      assert.ok(action.logEvidence, "late but valid bracket evidence must remain retained");
    });
  }
});

test("step subdeadlines preserve every post-mutation proof when each stage consumes its admitted window", async (t) => {
  const fixture = await prepareForSteps(t, {
    inputOverrides: {
      budgets: { maxDurationMs: 350_000, routeReserveMs: 104_314, restorationReserveMs: 110_000 },
    },
  });
  let nowNs = 2_000_000_000n;
  let preHmdBoundaryReads = 0;
  fixture.dependencies.monotonicNs = () => {
    const sampled = nowNs;
    if (preHmdBoundaryReads === 1) {
      nowNs += 1n;
      preHmdBoundaryReads = 2;
    } else if (preHmdBoundaryReads === 2) {
      // Complete the HMD wrapper one nanosecond before its strict deadline,
      // then model a sub-millisecond handoff before locomotion admission.
      nowNs += 2n;
      preHmdBoundaryReads = 0;
    } else {
      nowNs += 1n;
    }
    return sampled;
  };
  const consumeUntil = (deadline) => {
    const target = BigInt(deadline) - 1n;
    if (target > nowNs) nowNs = target;
  };
  const originalLocomotion = fixture.dependencies.requestLocomotion;
  fixture.dependencies.requestLocomotion = async (input) => {
    const result = await originalLocomotion(input);
    consumeUntil(input.deadlineMonotonicNs);
    return result;
  };
  const originalNonceCleanup = fixture.dependencies.cleanupLocomotionNonce;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    const result = await originalNonceCleanup(context);
    consumeUntil(context.deadlineMonotonicNs);
    return result;
  };
  const originalCapture = fixture.dependencies.captureSettled;
  fixture.dependencies.captureSettled = async (input) => {
    const result = await originalCapture(input);
    assert.equal(input.deadlineMs, fixture.input.capture.deadlineMs,
      "the settled capture keeps its complete caller-configured deadline");
    const target = BigInt(result.receipt.deadlineMonotonicNs) - 1n;
    if (target > nowNs) nowNs = target;
    return result;
  };
  const originalHmd = fixture.dependencies.requestHmdPose;
  fixture.dependencies.requestHmdPose = async (input) => {
    const result = await originalHmd(input);
    if (input.requestId.includes("_pre_")) {
      const target = BigInt(input.deadlineMonotonicNs) - 2n;
      if (target > nowNs) nowNs = target;
      preHmdBoundaryReads = 1;
    } else if (input.requestId.includes("_post_")) {
      const target = BigInt(input.deadlineMonotonicNs) - 2n;
      if (target > nowNs) nowNs = target;
    }
    return result;
  };
  const originalSafety = fixture.dependencies.sampleSafety;
  fixture.dependencies.sampleSafety = async (context) => {
    const result = await originalSafety(context);
    if (context.phase.endsWith("_pre") || context.phase.endsWith("_post")) consumeUntil(context.deadlineMonotonicNs);
    return result;
  };
  const originalContinuity = fixture.dependencies.sampleContinuity;
  fixture.dependencies.sampleContinuity = async (context) => {
    const result = await originalContinuity(context);
    if (context.phase.endsWith("_pre") || context.phase.endsWith("_post")) consumeUntil(context.deadlineMonotonicNs);
    return result;
  };
  const originalMarker = fixture.dependencies.emitMarker;
  fixture.dependencies.emitMarker = async (context) => {
    const result = await originalMarker(context);
    if (context.marker.endsWith("_BEGIN") || context.marker.endsWith("_END")) consumeUntil(context.deadlineMonotonicNs);
    return result;
  };
  const originalLogs = fixture.dependencies.collectStepLogs;
  fixture.dependencies.collectStepLogs = async (context) => {
    const result = await originalLogs(context);
    const target = BigInt(context.deadlineMonotonicNs) - 2n;
    if (target > nowNs) nowNs = target;
    return result;
  };
  fixture.calls.length = 0;

  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(result.status, "needs_waypoint_review", JSON.stringify(result));
  const locomotionInput = fixture.calls.find((call) => call.kind === "locomote").input;
  const beginDeadline = BigInt(fixture.calls.find((call) => call.kind === "marker" && call.context.marker.endsWith("_BEGIN")).context.deadlineMonotonicNs);
  const preSafetyDeadline = BigInt(fixture.calls.find((call) => call.kind === "safety" && call.context.phase.endsWith("_pre")).context.deadlineMonotonicNs);
  const preContinuityDeadline = BigInt(fixture.calls.find((call) => call.kind === "continuity" && call.context.phase.endsWith("_pre")).context.deadlineMonotonicNs);
  const preHmdDeadline = BigInt(fixture.calls.find((call) => call.kind === "hmd" && call.input.requestId.includes("_pre_")).input.deadlineMonotonicNs);
  const locomotionDeadline = BigInt(locomotionInput.deadlineMonotonicNs);
  const nonceDeadline = BigInt(fixture.calls.find((call) => call.kind === "nonceCleanup").context.deadlineMonotonicNs);
  const postHmdDeadline = BigInt(fixture.calls.find((call) => call.kind === "hmd" && call.input.requestId.includes("_post_")).input.deadlineMonotonicNs);
  const postSafetyDeadline = BigInt(fixture.calls.find((call) => call.kind === "safety" && call.context.phase.endsWith("_post")).context.deadlineMonotonicNs);
  const postContinuityDeadline = BigInt(fixture.calls.find((call) => call.kind === "continuity" && call.context.phase.endsWith("_post")).context.deadlineMonotonicNs);
  const endDeadline = BigInt(fixture.calls.find((call) => call.kind === "marker" && call.context.marker.endsWith("_END")).context.deadlineMonotonicNs);
  const logDeadline = BigInt(fixture.calls.find((call) => call.kind === "logs").context.deadlineMonotonicNs);
  const action = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  const captureDeadline = BigInt(action.captureInvocation.phaseDeadlineMonotonicNs);
  assert.ok(preSafetyDeadline - beginDeadline >= 5_001_000_000n);
  assert.ok(preContinuityDeadline - preSafetyDeadline >= 10_001_000_000n);
  assert.ok(preHmdDeadline - preContinuityDeadline >= 13_150_000_000n,
    "the pre-HMD transaction retains its complete acquisition window after continuity");
  assert.ok(locomotionDeadline - preHmdDeadline >= 12_151_000_000n);
  assert.ok(nonceDeadline - locomotionDeadline >= 2_851_000_000n);
  assert.equal(locomotionInput.controlTimeoutMs, 12_151,
    "the latest valid pre-HMD completion preserves the complete bridge-plus-glide envelope");
  assert.ok(captureDeadline - nonceDeadline >= 8_002_000_000n);
  assert.ok(postSafetyDeadline - captureDeadline >= 18_152_000_000n,
    "capture phase preserves one full HMD window, its handoff, and the safety window");
  assert.ok(postSafetyDeadline - postHmdDeadline >= 5_001_000_000n);
  assert.ok(postContinuityDeadline - postSafetyDeadline >= 10_001_000_000n);
  assert.ok(endDeadline - postContinuityDeadline >= 5_001_000_000n);
  assert.ok(logDeadline - endDeadline >= 10_001_000_000n);
  assert.deepEqual(
    fixture.calls.filter((call) => ["locomote", "nonceCleanup", "capture", "hmd", "safety", "continuity", "marker", "logs"].includes(call.kind))
      .slice(-8).map((call) => call.kind),
    ["locomote", "nonceCleanup", "capture", "hmd", "safety", "continuity", "marker", "logs"],
  );
});

test("pre-step continuity completing at its exact boundary starts no HMD read or movement", async (t) => {
  const fixture = await prepareForSteps(t, {
    inputOverrides: {
      budgets: { maxDurationMs: 350_000, routeReserveMs: 104_314, restorationReserveMs: 110_000 },
    },
  });
  let nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  const continuity = fixture.dependencies.sampleContinuity;
  fixture.dependencies.sampleContinuity = async (context) => {
    const result = await continuity(context);
    if (context.phase.endsWith("_pre")) nowNs = BigInt(context.deadlineMonotonicNs);
    return result;
  };
  fixture.calls.length = 0;

  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(result.status, "stopped");
  assert.equal(result.structuralStop, "budget_exhausted");
  assert.match(result.primaryError, /pre-step continuity.*deadline/i);
  assert.equal(fixture.calls.some((call) => call.kind === "hmd" || call.kind === "locomote"), false);
});

test("an operation completing exactly at its subdeadline cannot consume the next proof window", async (t) => {
  const fixture = await prepareForSteps(t, {
    inputOverrides: {
      budgets: { maxDurationMs: 340_000, routeReserveMs: 110_000, restorationReserveMs: 110_000 },
    },
  });
  let nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  const originalCleanup = fixture.dependencies.cleanupLocomotionNonce;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    const receipt = await originalCleanup(context);
    nowNs = BigInt(context.deadlineMonotonicNs);
    return receipt;
  };
  let captureCalls = 0;
  const originalCapture = fixture.dependencies.captureSettled;
  fixture.dependencies.captureSettled = async (input) => {
    captureCalls += 1;
    return originalCapture(input);
  };
  fixture.calls.length = 0;

  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(result.status, "stopped");
  assert.equal(result.structuralStop, "budget_exhausted");
  assert.match(result.primaryError, /nonce cleanup.*deadline/i);
  assert.equal(captureCalls, 0, "capture cannot inherit time from an exactly exhausted nonce-cleanup window");
});

test("step action publication cannot consume the protected restoration handoff", async (t) => {
  const fixture = await createPreparedFixture(t, {
    inputOverrides: {
      budgets: { maxDurationMs: 340_000, routeReserveMs: 110_000, restorationReserveMs: 110_000 },
    },
  });
  let nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  let proofDeadlineNs = null;
  const collectLogs = fixture.dependencies.collectStepLogs;
  fixture.dependencies.collectStepLogs = async (context) => {
    proofDeadlineNs = BigInt(context.deadlineMonotonicNs);
    return collectLogs(context);
  };
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    beforeActionRecordCommit({ action }) {
      if (action === "step") {
        assert.ok(proofDeadlineNs !== null);
        nowNs = proofDeadlineNs + 5_001_000_000n;
      }
    },
  });
  const prepared = await orchestrator.execute(fixture.input);
  assert.equal(prepared.status, "needs_baseline_review");

  const stepped = await orchestrator.execute(stepRequest(
    { ...fixture, prepared },
    reviewFor(prepared.requiredReview[0]),
  ));

  assert.equal(stepped.status, "stopped");
  assert.equal(stepped.structuralStop, "action_audit_failed");
  assert.match(stepped.primaryError, /action.*deadline/i);
  const recordsBeforeRestore = fs.readdirSync(path.join(fixture.input.artifactRoot, "action-records"))
    .filter((name) => /^\d{6}\.json$/.test(name));
  assert.deepEqual(recordsBeforeRestore, ["000001.json"], "late step action bytes cannot cross the commit fence");

  const restored = await orchestrator.execute({
    action: "restore",
    runId: prepared.runId,
    reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
});

test("completed step and restore defer every post-commit maintenance hook off their deadline handoffs", async (t) => {
  const fixture = await createPreparedFixture(t);
  let nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  let protectedActionDeadlineNs = null;
  let lateMaintenanceHooks = 0;
  let sawPendingStepStageAtRestoreEntry = false;
  const originalLogs = fixture.dependencies.collectStepLogs;
  fixture.dependencies.collectStepLogs = async (context) => {
    const receipt = await originalLogs(context);
    if (!context.beginMarker.endsWith("_PREPARE_BEGIN")) {
      protectedActionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
    }
    return receipt;
  };
  const originalContinuity = fixture.dependencies.sampleContinuity;
  fixture.dependencies.sampleContinuity = async (context) => {
    if (context.phase === "restore_pre") {
      sawPendingStepStageAtRestoreEntry = fs.readdirSync(path.join(fixture.input.artifactRoot, "action-records"))
        .some((name) => /^\.[0-9]{6}\.[a-f0-9]{32}\.tmp$/.test(name));
    }
    return originalContinuity(context);
  };
  const advanceIfProtected = ({ action }) => {
    if (action !== "step" && action !== "restore") return;
    lateMaintenanceHooks += 1;
    assert.ok(protectedActionDeadlineNs !== null);
    nowNs = protectedActionDeadlineNs;
  };
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    afterActionRecordLink: advanceIfProtected,
    afterActionViewMaterialization: advanceIfProtected,
  });
  const prepared = await orchestrator.execute(fixture.input);
  assert.equal(prepared.status, "needs_baseline_review");

  const stepped = await orchestrator.execute(stepRequest(
    { ...fixture, prepared },
    reviewFor(prepared.requiredReview[0]),
  ));

  assert.equal(stepped.status, "needs_waypoint_review", JSON.stringify(stepped));
  assert.equal(stepped.actionAuditMaintenance.status, "repair_pending");
  assert.equal(lateMaintenanceHooks, 0, "repair-only post-commit hooks must not run on the protected handoff");
  assert.equal(committedActionPayloads(fixture.input.artifactRoot).at(-1).status, "completed");

  const restored = await orchestrator.execute({
    action: "restore",
    runId: prepared.runId,
    reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  assert.equal(restored.actionAuditMaintenance.status, "repair_pending");
  assert.equal(sawPendingStepStageAtRestoreEntry, true,
    "restore entry validates but does not repair the prior committed step outside action-publication time");
  assert.equal(lateMaintenanceHooks, 0);
  assert.equal(committedActionPayloads(fixture.input.artifactRoot).at(-1).action, "restore");
});

test("minimum restoration reserve preserves every mandatory stage under boundary consumption", async (t) => {
  const priorComponent = "com.prior.unbound/.MainActivity";
  let nowNs = null;
  let restoreActionDeadlineNs = null;
  const fixture = await prepareForSteps(t, {
    inputOverrides: {
      budgets: { maxDurationMs: 370_000, routeReserveMs: 110_000, restorationReserveMs: 104_166 },
      priorForeground: { kind: "non_receipt_bound", component: priorComponent },
    },
    priorSnapshot: { component: priorComponent, packageName: "com.prior.unbound", userInstalled: true },
    artifactHooks: {
      beforeActionRecordCommit({ action }) {
        if (action === "restore" && nowNs !== null) {
          assert.ok(restoreActionDeadlineNs !== null);
          nowNs = restoreActionDeadlineNs - 2n;
        }
      },
    },
  });
  const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stepped.status, "needs_waypoint_review");

  nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  const finishBefore = (deadline) => {
    const target = BigInt(deadline) - 1n;
    if (target > nowNs) nowNs = target;
  };
  const continuity = fixture.dependencies.sampleContinuity;
  fixture.dependencies.sampleContinuity = async (context) => {
    const result = await continuity(context);
    if (context.phase === "restore_pre" || context.phase === "restore_post_capture") {
      finishBefore(context.deadlineMonotonicNs);
    }
    return result;
  };
  const capability = fixture.dependencies.probeCapability;
  fixture.dependencies.probeCapability = async (input) => {
    const result = await capability(input);
    if (input.tag === "restore-pre" || input.tag === "restore-post-capture") {
      finishBefore(input.deadlineMonotonicNs);
    }
    return result;
  };
  const locomote = fixture.dependencies.requestLocomotion;
  fixture.dependencies.requestLocomotion = async (input) => {
    const result = await locomote(input);
    if (input.tag === "restore") finishBefore(input.deadlineMonotonicNs);
    return result;
  };
  const nonceCleanup = fixture.dependencies.cleanupLocomotionNonce;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    const result = await nonceCleanup(context);
    if (context.tag === "restore") finishBefore(context.deadlineMonotonicNs);
    return result;
  };
  const capture = fixture.dependencies.captureSettled;
  fixture.dependencies.captureSettled = async (input) => {
    const result = await capture(input);
    if (input.outPath.includes("999-restored")) {
      assert.equal(input.deadlineMs, fixture.input.capture.deadlineMs,
        "restoration retains the complete caller-configured capture deadline");
      finishBefore(result.receipt.deadlineMonotonicNs);
    }
    return result;
  };
  const stop = fixture.dependencies.stopPackage;
  fixture.dependencies.stopPackage = async (context) => {
    const result = await stop(context);
    if (context.reason === "restore_run_owned_target") finishBefore(context.deadlineMonotonicNs);
    return result;
  };
  const finalProcess = fixture.dependencies.probeFinalProcessState;
  fixture.dependencies.probeFinalProcessState = async (context) => {
    const result = await finalProcess(context);
    finishBefore(context.deadlineMonotonicNs);
    return result;
  };
  const relaunch = fixture.dependencies.relaunchPrior;
  fixture.dependencies.relaunchPrior = async (context) => {
    const result = await relaunch(context);
    finishBefore(context.deadlineMonotonicNs);
    return result;
  };
  const safety = fixture.dependencies.sampleSafety;
  fixture.dependencies.sampleSafety = async (context) => {
    const result = await safety(context);
    if (context.phase === "restore_after_prior_disposition") {
      finishBefore(context.deadlineMonotonicNs);
      restoreActionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
    }
    return result;
  };
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
  });

  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  const preContinuityDeadline = BigInt(fixture.calls.find((call) => call.kind === "continuity" && call.context.phase === "restore_pre").context.deadlineMonotonicNs);
  const preCapabilityDeadline = BigInt(fixture.calls.find((call) => call.kind === "capability" && call.input.tag === "restore-pre").input.deadlineMonotonicNs);
  const locomotionDeadline = BigInt(fixture.calls.find((call) => call.kind === "locomote" && call.input.tag === "restore").input.deadlineMonotonicNs);
  const nonceDeadline = BigInt(fixture.calls.find((call) => call.kind === "nonceCleanup" && call.context.tag === "restore").context.deadlineMonotonicNs);
  const postContinuityDeadline = BigInt(fixture.calls.find((call) => call.kind === "continuity" && call.context.phase === "restore_post_capture").context.deadlineMonotonicNs);
  const postCapabilityDeadline = BigInt(fixture.calls.find((call) => call.kind === "capability" && call.input.tag === "restore-post-capture").input.deadlineMonotonicNs);
  const targetStopDeadline = BigInt(fixture.calls.find((call) => call.kind === "stop" && call.context.reason === "restore_run_owned_target").context.deadlineMonotonicNs);
  const finalProcessCalls = fixture.calls.filter((call) => call.kind === "finalProcess");
  assert.equal(finalProcessCalls.length, 2);
  const targetAbsenceDeadline = BigInt(finalProcessCalls[0].context.deadlineMonotonicNs);
  const priorRelaunchDeadline = BigInt(fixture.calls.find((call) => call.kind === "relaunchPrior").context.deadlineMonotonicNs);
  const finalProcessDeadline = BigInt(finalProcessCalls[1].context.deadlineMonotonicNs);
  const postStopSafetyDeadline = BigInt(fixture.calls.find((call) => call.kind === "safety" && call.context.phase === "restore_after_prior_disposition").context.deadlineMonotonicNs);
  const restoreAction = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  const captureDeadline = BigInt(restoreAction.captureInvocation.phaseDeadlineMonotonicNs);
  assert.ok(preCapabilityDeadline - preContinuityDeadline >= 11_651_000_000n);
  assert.ok(locomotionDeadline - preCapabilityDeadline >= 12_151_000_000n);
  assert.ok(nonceDeadline - locomotionDeadline >= 2_851_000_000n);
  assert.ok(captureDeadline - nonceDeadline >= 8_002_000_000n);
  assert.ok(postContinuityDeadline - captureDeadline >= 10_001_000_000n);
  assert.ok(postCapabilityDeadline - postContinuityDeadline >= 11_651_000_000n);
  assert.ok(targetStopDeadline - postCapabilityDeadline >= 5_001_000_000n);
  assert.ok(targetAbsenceDeadline - targetStopDeadline >= 5_001_000_000n);
  assert.ok(priorRelaunchDeadline - targetAbsenceDeadline >= 7_852_000_000n,
    "a skipped post-stop nonce stage keeps both its 2.851s window and the relaunch handoff");
  assert.ok(finalProcessDeadline - priorRelaunchDeadline >= 5_001_000_000n);
  assert.ok(postStopSafetyDeadline - finalProcessDeadline >= 5_001_000_000n);
  assert.equal(nowNs, restoreActionDeadlineNs,
    "pre-link and post-link fence samples finish at deadline-minus-two and deadline-minus-one");
  assert.equal(restored.actionAuditMaintenance.status, "repair_pending");
});

test("the minimum restoration reserve retains both live and post-stop nonce windows", async (t) => {
  let nowNs = null;
  let restoreActionDeadlineNs = null;
  const fixture = await prepareForSteps(t, {
    inputOverrides: {
      budgets: { maxDurationMs: 370_000, routeReserveMs: 110_000, restorationReserveMs: 104_166 },
    },
    artifactHooks: {
      beforeActionRecordCommit({ action }) {
        if (action === "restore" && nowNs !== null) {
          assert.ok(restoreActionDeadlineNs !== null);
          nowNs = restoreActionDeadlineNs - 3n;
        }
      },
    },
  });
  nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  const finishBefore = (deadline) => {
    const target = BigInt(deadline) - 1n;
    if (target > nowNs) nowNs = target;
  };
  const continuity = fixture.dependencies.sampleContinuity;
  fixture.dependencies.sampleContinuity = async (context) => {
    const result = await continuity(context);
    if (context.phase === "restore_pre") finishBefore(context.deadlineMonotonicNs);
    return result;
  };
  const capability = fixture.dependencies.probeCapability;
  fixture.dependencies.probeCapability = async (input) => {
    const result = await capability(input);
    if (input.tag === "restore-pre") finishBefore(input.deadlineMonotonicNs);
    return result;
  };
  const locomote = fixture.dependencies.requestLocomotion;
  fixture.dependencies.requestLocomotion = async (input) => {
    const result = await locomote(input);
    if (input.tag === "restore") finishBefore(input.deadlineMonotonicNs);
    return result;
  };
  const cleanup = fixture.dependencies.cleanupLocomotionNonce;
  let cleanupCount = 0;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    const result = await cleanup(context);
    finishBefore(context.deadlineMonotonicNs);
    cleanupCount += 1;
    if (cleanupCount === 1) delete result.finalizationSha256;
    return result;
  };
  const stop = fixture.dependencies.stopPackage;
  fixture.dependencies.stopPackage = async (context) => {
    const result = await stop(context);
    if (context.reason === "restore_run_owned_target") finishBefore(context.deadlineMonotonicNs);
    return result;
  };
  const finalProcess = fixture.dependencies.probeFinalProcessState;
  fixture.dependencies.probeFinalProcessState = async (context) => {
    const result = await finalProcess(context);
    finishBefore(context.deadlineMonotonicNs);
    return result;
  };
  const safety = fixture.dependencies.sampleSafety;
  fixture.dependencies.sampleSafety = async (context) => {
    const result = await safety(context);
    if (context.phase === "restore_after_prior_disposition") {
      finishBefore(context.deadlineMonotonicNs);
      restoreActionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
    }
    return result;
  };
  fixture.calls.length = 0;

  const failed = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });

  assert.equal(failed.status, "restore_failed");
  assert.match(failed.primaryError, /nonce|finalization/i);
  const cleanupCalls = fixture.calls.filter((call) => call.kind === "nonceCleanup");
  assert.equal(cleanupCalls.length, 2);
  assert.equal(cleanupCalls[0].context.processStopped, undefined);
  assert.equal(cleanupCalls[1].context.processStopped, true);
  assert.equal(cleanupCalls[1].context.probeOnly, true);
  assert.equal(nowNs, restoreActionDeadlineNs);
  const action = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.equal(action.status, "failed");
  assert.deepEqual(action.locomotionNonceCleanup, successfulNonceCleanupReceipt(cleanupCalls[1].context));
});

test("restore cannot complete when final safety reaches its exact subdeadline", async (t) => {
  const fixture = await prepareForSteps(t);
  const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stepped.status, "needs_waypoint_review");
  let nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  const safety = fixture.dependencies.sampleSafety;
  fixture.dependencies.sampleSafety = async (context) => {
    const result = await safety(context);
    if (context.phase === "restore_after_prior_disposition") nowNs = BigInt(context.deadlineMonotonicNs);
    return result;
  };
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
  });

  assert.equal(restored.status, "restore_failed");
  assert.match(restored.cleanupError, /global safety.*subdeadline/i);
  assert.notEqual(committedActionPayloads(fixture.input.artifactRoot).at(-1).status, "completed");
});

test("restore action cannot commit at its exact deadline and a fresh re-entrant attempt converges", async (t) => {
  const fixture = await createPreparedFixture(t);
  let nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  let restoreActionDeadlineNs = null;
  let expireFirstRestoreAction = true;
  const safety = fixture.dependencies.sampleSafety;
  fixture.dependencies.sampleSafety = async (context) => {
    const result = await safety(context);
    if (context.phase === "restore_after_prior_disposition") {
      restoreActionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
    }
    return result;
  };
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    beforeActionRecordCommit({ action }) {
      if (action === "restore" && expireFirstRestoreAction) {
        assert.ok(restoreActionDeadlineNs !== null);
        nowNs = restoreActionDeadlineNs;
        expireFirstRestoreAction = false;
      }
    },
  });
  const prepared = await orchestrator.execute(fixture.input);
  assert.equal(prepared.status, "needs_baseline_review");
  const stepped = await orchestrator.execute(stepRequest(
    { ...fixture, prepared },
    reviewFor(prepared.requiredReview[0]),
  ));
  assert.equal(stepped.status, "needs_waypoint_review");

  const first = await orchestrator.execute({
    action: "restore",
    runId: prepared.runId,
    reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
  });
  assert.equal(first.status, "restore_failed");
  assert.equal(first.structuralStop, "action_audit_failed");
  assert.match(first.primaryError, /restore action.*deadline/i);
  assert.equal(committedActionPayloads(fixture.input.artifactRoot).some((action) => action.action === "restore"), false);

  const retried = await orchestrator.execute({
    action: "restore",
    runId: prepared.runId,
    reviewedPriorFrame: reviewFor(first.requiredReview[0]),
  });
  assert.equal(retried.status, "restored_needs_review", JSON.stringify(retried));
  assert.equal(committedActionPayloads(fixture.input.artifactRoot).at(-1).action, "restore");
});

test("a semantic action link completing at its deadline is retained but reported as publication-unproven", async (t) => {
  await t.test("completed step", async (t) => {
    const fixture = await prepareForSteps(t);
    let nowNs = 2_000_000_000n;
    fixture.dependencies.monotonicNs = () => nowNs++;
    let actionDeadlineNs = null;
    const logs = fixture.dependencies.collectStepLogs;
    fixture.dependencies.collectStepLogs = async (context) => {
      const result = await logs(context);
      if (!context.beginMarker.endsWith("_PREPARE_BEGIN")) {
        actionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
      }
      return result;
    };
    const originalLinkSync = fs.linkSync;
    let arm = true;
    fs.linkSync = function linkThenExpire(source, target) {
      const result = originalLinkSync.apply(this, arguments);
      if (arm && path.basename(String(target)) === "000002.json") {
        arm = false;
        assert.ok(actionDeadlineNs !== null);
        nowNs = actionDeadlineNs;
      }
      return result;
    };
    t.after(() => { fs.linkSync = originalLinkSync; });
    fixture.calls.length = 0;

    const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.structuralStop, "action_audit_failed");
    assert.match(stopped.primaryError, /committed.*publication deadline.*unproven/i);
    assert.equal(stopped.usage.successfulWaypoints, 1,
      "the state must retain the physical facts already committed in the immutable completed action");
    const actions = committedActionPayloads(fixture.input.artifactRoot);
    assert.equal(actions.filter((entry) => entry.action === "step").length, 1);
    assert.equal(actions.at(-1).status, "completed");
    assert.equal(stopped.actionAuditMaintenance.status, "repair_pending");
    assert.equal(stopped.actionAuditMaintenance.publicationIncidents.at(-1).phase, "after_commit");

    fixture.calls.length = 0;
    const restored = await fixture.orchestrator.execute({
      action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
    });
    assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
    assert.equal(committedActionPayloads(fixture.input.artifactRoot).at(-1)
      .priorActionAuditMaintenance.publicationIncidents.length, 1);
  });

  await t.test("completed restore", async (t) => {
    const fixture = await prepareForSteps(t);
    let nowNs = 2_000_000_000n;
    fixture.dependencies.monotonicNs = () => nowNs++;
    let actionDeadlineNs = null;
    const safety = fixture.dependencies.sampleSafety;
    fixture.dependencies.sampleSafety = async (context) => {
      const result = await safety(context);
      if (context.phase === "restore_after_prior_disposition") {
        actionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
      }
      return result;
    };
    const originalLinkSync = fs.linkSync;
    let arm = true;
    fs.linkSync = function linkThenExpire(source, target) {
      const result = originalLinkSync.apply(this, arguments);
      if (arm && path.basename(String(target)) === "000002.json") {
        arm = false;
        assert.ok(actionDeadlineNs !== null);
        nowNs = actionDeadlineNs;
      }
      return result;
    };
    t.after(() => { fs.linkSync = originalLinkSync; });
    fixture.calls.length = 0;

    const failed = await fixture.orchestrator.execute({
      action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
    });

    assert.equal(failed.status, "restore_failed");
    assert.equal(failed.structuralStop, "action_audit_failed");
    assert.match(failed.primaryError, /committed.*publication deadline.*unproven/i);
    assert.equal(committedActionPayloads(fixture.input.artifactRoot).at(-1).status, "completed");
    assert.equal(failed.actionAuditMaintenance.publicationIncidents.length, 1);

    fixture.calls.length = 0;
    const retried = await fixture.orchestrator.execute({
      action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(failed.requiredReview[0]),
    });
    assert.equal(retried.status, "restored_needs_review", JSON.stringify(retried));
    assert.equal(committedActionPayloads(fixture.input.artifactRoot).filter((entry) => entry.action === "restore").length, 2);
  });

  await t.test("post-link clock unavailable", async (t) => {
    const fixture = await prepareForSteps(t);
    let nowNs = 2_000_000_000n;
    let failClock = false;
    fixture.dependencies.monotonicNs = () => {
      if (failClock) throw new Error("post-link clock unavailable");
      return nowNs++;
    };
    const originalLinkSync = fs.linkSync;
    let arm = true;
    fs.linkSync = function linkThenBreakClock(source, target) {
      const result = originalLinkSync.apply(this, arguments);
      if (arm && path.basename(String(target)) === "000002.json") {
        arm = false;
        failClock = true;
      }
      return result;
    };
    t.after(() => { fs.linkSync = originalLinkSync; });

    const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
    assert.equal(stopped.status, "stopped");
    assert.match(stopped.primaryError, /committed.*publication deadline.*unproven.*clock unavailable/i);
    assert.equal(stopped.actionAuditMaintenance.publicationIncidents.at(-1).reason, "clock_unavailable");
    assert.equal(committedActionPayloads(fixture.input.artifactRoot).at(-1).status, "completed");

    failClock = false;
    const restored = await fixture.orchestrator.execute({
      action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
    });
    assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  });
});

test("failed step and restore audit records remain inside their fixed publication fences", async (t) => {
  await t.test("failed step", async (t) => {
    const fixture = await createPreparedFixture(t);
    let nowNs = 2_000_000_000n;
    fixture.dependencies.monotonicNs = () => nowNs++;
    const safety = fixture.dependencies.sampleSafety;
    fixture.dependencies.sampleSafety = async (context) => {
      const result = await safety(context);
      return context.phase.endsWith("_pre") ? { ...result, guardian: "0" } : result;
    };
    let actionDeadlineNs = null;
    const logs = fixture.dependencies.collectStepLogs;
    fixture.dependencies.collectStepLogs = async (context) => {
      const result = await logs(context);
      if (!context.beginMarker.endsWith("_PREPARE_BEGIN")) {
        actionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
      }
      return result;
    };
    let expire = true;
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
      beforeActionRecordCommit({ action }) {
        if (action === "step" && expire) {
          expire = false;
          assert.ok(actionDeadlineNs !== null);
          nowNs = actionDeadlineNs;
        }
      },
    });
    const prepared = await orchestrator.execute(fixture.input);
    const stopped = await orchestrator.execute(stepRequest(
      { ...fixture, prepared }, reviewFor(prepared.requiredReview[0]),
    ));
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.structuralStop, "safety_drift");
    assert.match(stopped.primaryError, /Guardian/i);
    assert.match(stopped.cleanupError, /step action publication.*deadline/i);
    assert.equal(committedActionPayloads(fixture.input.artifactRoot).some((entry) => entry.action === "step"), false);

    fixture.dependencies.sampleSafety = safety;
    const restored = await orchestrator.execute({
      action: "restore", runId: prepared.runId, reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
    });
    assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  });

  await t.test("failed restore", async (t) => {
    const fixture = await createPreparedFixture(t);
    let nowNs = 2_000_000_000n;
    fixture.dependencies.monotonicNs = () => nowNs++;
    let failContinuity = true;
    const continuity = fixture.dependencies.sampleContinuity;
    fixture.dependencies.sampleContinuity = async (context) => {
      const result = await continuity(context);
      return failContinuity && context.phase === "restore_pre" ? { ...result, foreground: "different_package" } : result;
    };
    let actionDeadlineNs = null;
    const safety = fixture.dependencies.sampleSafety;
    fixture.dependencies.sampleSafety = async (context) => {
      const result = await safety(context);
      if (context.phase === "restore_after_prior_disposition") {
        actionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
      }
      return result;
    };
    let expire = true;
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
      beforeActionRecordCommit({ action }) {
        if (action === "restore" && expire) {
          expire = false;
          assert.ok(actionDeadlineNs !== null);
          nowNs = actionDeadlineNs;
        }
      },
    });
    const prepared = await orchestrator.execute(fixture.input);
    const failed = await orchestrator.execute({
      action: "restore", runId: prepared.runId, reviewedPriorFrame: reviewFor(prepared.requiredReview[0]),
    });
    assert.equal(failed.status, "restore_failed");
    assert.equal(failed.structuralStop, "binding_lost");
    assert.match(failed.primaryError, /continuity|foreground/i);
    assert.match(failed.cleanupError, /restore action publication.*deadline/i);
    assert.equal(committedActionPayloads(fixture.input.artifactRoot).some((entry) => entry.action === "restore"), false);

    failContinuity = false;
    const restored = await orchestrator.execute({
      action: "restore", runId: prepared.runId, reviewedPriorFrame: reviewFor(failed.requiredReview[0]),
    });
    assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  });
});

test("prepare rejects an HMD listener sample older than the experiment freshness threshold", async (t) => {
  const fixture = await createPreparedFixture(t);
  const originalHmd = fixture.dependencies.requestHmdPose;
  fixture.dependencies.requestHmdPose = async (input) => {
    const result = await originalHmd(input);
    return {
      ...result,
      ack: {
        ...result.ack,
        hmdPose: {
          ...result.ack.hmdPose,
          sampleSequence: "1",
          sampleObservedAtMonotonicNs: "1000000",
          readAtMonotonicNs: "252000000",
        },
      },
    };
  };

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /HMD|fresh|age|250/i);
  assert.equal(fixture.calls.some((call) => call.kind === "monitor" || call.kind === "capture"), false);
});

test("step gates safety, continuity, fresh finite HMD telemetry, 0.02m Euclidean drift, and route budget", async (t) => {
  const makeHmd = (input, position, metadata = {}) => ({
    ok: true,
    ack: {
      kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND, schemaVersion: 1, capabilityRevision: 1,
      requestId: input.requestId, tag: input.tag, application: { packageName: input.packageName },
      operation: AGENT_BRIDGE_HMD_POSE_COMMAND, physicalWalk: false, primaryError: null, cleanupError: null,
      outcome: "sampled", root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: input.expectedRootIncarnation },
      hmdPose: {
        sampleSequence: metadata.sampleSequence ?? "2",
        sampleObservedAtMonotonicNs: metadata.sampleObservedAtMonotonicNs ?? "3000000",
        readAtMonotonicNs: metadata.readAtMonotonicNs ?? "4000000",
        position,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    },
    primaryError: null, cleanupError: null, actionReceipts: [], evidenceCeiling: "structural",
  });
  const cases = [
    ["safety", { safetySequence: [cleanSafety, cleanSafety, { ...cleanSafety, safeguard: "0" }] }],
    ["continuity", { continuitySequence: [{ foreground: "different_package" }] }],
    ["nonfinite HMD", {}],
    ["stale HMD", {}],
    ["stale post HMD", {}],
    ["identical HMD timestamps", {}],
    ["aged HMD", {}],
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
          return makeHmd(
            input,
            index === 0 ? fixture.pose.position : { ...fixture.pose.position, x: fixture.pose.position.x + 0.0201 },
            {
              sampleSequence: String(2 + index),
              sampleObservedAtMonotonicNs: String(3_000_000 + index * 2_000_000),
              readAtMonotonicNs: String(4_000_000 + index * 2_000_000),
            },
          );
        };
      }
      if (label === "stale HMD") {
        fixture.dependencies.requestHmdPose = async (input) => {
          fixture.calls.push({ kind: "hmd", input });
          return makeHmd(input, fixture.pose.position, {
            sampleSequence: fixture.pose.sampleSequence,
            sampleObservedAtMonotonicNs: fixture.pose.sampleObservedAtMonotonicNs,
            readAtMonotonicNs: fixture.pose.readAtMonotonicNs,
          });
        };
      }
      if (label === "stale post HMD") {
        fixture.dependencies.requestHmdPose = async (input) => {
          fixture.calls.push({ kind: "hmd", input });
          return makeHmd(input, fixture.pose.position, {
            sampleSequence: "2",
            sampleObservedAtMonotonicNs: "3000000",
            readAtMonotonicNs: "4000000",
          });
        };
      }
      if (label === "identical HMD timestamps") {
        fixture.dependencies.requestHmdPose = async (input) => {
          const index = fixture.calls.filter((call) => call.kind === "hmd").length;
          fixture.calls.push({ kind: "hmd", input });
          return makeHmd(input, fixture.pose.position, {
            sampleSequence: String(2 + index),
            sampleObservedAtMonotonicNs: fixture.pose.sampleObservedAtMonotonicNs,
            readAtMonotonicNs: fixture.pose.readAtMonotonicNs,
          });
        };
      }
      if (label === "aged HMD") {
        fixture.dependencies.requestHmdPose = async (input) => {
          fixture.calls.push({ kind: "hmd", input });
          return makeHmd(input, fixture.pose.position, {
            sampleSequence: "2",
            sampleObservedAtMonotonicNs: "1000000",
            readAtMonotonicNs: "252000000",
          });
        };
      }
      options.afterPrepare?.(fixture);
      const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
      assert.equal(result.status, "stopped");
      assert.match(result.primaryError, label === "translation drift" ? /0\.02|drift/i : /safety|continuity|HMD|fresh|stale|budget|deadline|binding/i);
      assert.equal(fixture.calls.filter((call) => call.kind === "locomote" && call.input.mode !== fixture.input.mechanism).length, 0);
      if (label === "stale post HMD") assert.equal(fixture.calls.filter((call) => call.kind === "locomote").length, 1);
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
        physicalWalk: false, primaryError: null, cleanupError: null, outcome: "completed",
        requestControl: "execute", executionLeaseMs: input.glideDurationMs + 2_000, mode: input.mode,
        target: { absolute: true, ...target }, glideDurationMs: input.glideDurationMs, rootGenerationBefore: input.rootGeneration,
        root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: input.rootGeneration, incarnation: input.rootIncarnation },
        pose: { rootGeneration: input.rootGeneration, position: target }, hmdPose: null,
      },
      primaryError: null, cleanupError: null, motionQuiesced: true,
      nonceCleanup: routeOwnedNonceDisposition(input), actionReceipts: [], evidenceCeiling: "structural",
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
        "readReview", "readReceipt", "readSpec", "continuity", "capability", "locomote", "nonceCleanup", "capture", "readReview",
        "continuity", "capability", "stop", "finalProcess", "safety",
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
      const restoreAction = committedActionPayloads(fixture.input.artifactRoot).at(-1);
      assert.deepEqual(restoreAction.locomotion.ack.target, { absolute: true, x: 0, y: 0, z: 0 });
      assert.deepEqual(restoreAction.locomotionNonceCleanup, successfulNonceCleanupReceipt(
        fixture.calls.find((call) => call.kind === "nonceCleanup").context,
      ));
      assert.equal(restoreAction.captureReceipt.mode, reviewedMovedFrame ? "transition_then_stable" : "stable");
      assertCaptureInvocation(restoreAction);
      assert.equal(restoreAction.postCaptureContinuity.pid, fixture.applicationBinding.pid);
      assert.deepEqual(restoreAction.postCaptureCapability.ack.root, {
        id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID,
        generation: restored.rootGeneration,
        incarnation: restored.rootIncarnation,
      });
      assert.equal(restoreAction.postStopSafety.guardian, "1");
    });
  }
});

test("restore rechecks exact application and root continuity after recovery capture before adopting or stopping", async (t) => {
  const cases = [
    ["target exited", { restorePostCaptureContinuity: { foreground: "missing", resumedComponents: [] } }],
    ["target restarted", { restorePostCaptureContinuity: { pid: 6161, pidStartTicks: "987654321" } }],
    ["root re-registered in the same process", {
      restorePostCaptureRoot: { generation: 8, incarnation: REPLACEMENT_INCARNATION },
    }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t, options);
      fixture.calls.length = 0;

      const restored = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(fixture.baselineReview),
      });

      assert.equal(restored.status, "restore_failed");
      assert.match(restored.primaryError, /binding|continuity|root|generation|incarnation/i);
      assert.equal(restored.requiredReview[0].captureSha256, fixture.baselineReview.captureSha256,
        "an unbound recovery frame must not replace the reviewed prior frame");
      const captureIndex = fixture.calls.findIndex((call) => call.kind === "capture");
      const reviewIndex = fixture.calls.findIndex((call) => call.kind === "readReview" && call.item.role === "recovery");
      const continuityIndex = fixture.calls.findIndex((call) => call.kind === "continuity" && call.context.phase === "restore_post_capture");
      const postCapabilityIndex = fixture.calls.findIndex((call) => call.kind === "capability" && call.input.tag === "restore-post-capture");
      const stopIndex = fixture.calls.findIndex((call) => call.kind === "stop" && call.context.reason === "restore_run_owned_target");
      assert.ok(captureIndex >= 0 && reviewIndex > captureIndex && continuityIndex > reviewIndex && stopIndex > continuityIndex);
      if (label.includes("root")) assert.ok(postCapabilityIndex > continuityIndex && stopIndex > postCapabilityIndex);
      const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(action.status, "failed");
      assertCaptureInvocation(action);
      assert.equal(action.postCaptureContinuity.pid,
        options.restorePostCaptureContinuity?.pid ?? fixture.applicationBinding.pid);
      if (label.includes("root")) assert.equal(action.postCaptureCapability.ack.root.generation, 8);
      assert.equal(action.captureSha256, null);
    });
  }
});

test("a stopped retry cannot relabel a moved frame as zero after an unbound recovery capture", async (t) => {
  const fixtureOptions = {
    restorePostCaptureContinuity: { foreground: "missing", resumedComponents: [] },
  };
  const fixture = await prepareForSteps(t, fixtureOptions);
  const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stepped.status, "needs_waypoint_review");
  const movedReview = stepped.requiredReview[0];

  const failed = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(movedReview),
  });
  assert.equal(failed.status, "restore_failed");
  assert.match(failed.primaryError, /binding|continuity/i);
  assert.equal(failed.requiredReview[0].captureSha256, movedReview.captureSha256);

  fixtureOptions.restorePostCaptureContinuity = {};
  fixture.calls.length = 0;
  const retried = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(movedReview),
  });
  assert.equal(retried.status, "restore_failed");
  assert.match(retried.primaryError, /zero|restoration.*unproven|moved.*frame/i);
  assert.equal(retried.requiredReview[0].captureSha256, movedReview.captureSha256);
  assert.equal(retried.requiredReview[0].role, "waypoint");
  assert.equal(fixture.calls.some((call) => call.kind === "locomote" || call.kind === "capture"), false);
});

test("restore rejects a wrong caller SHA without effects and retries after the exact expected image is repaired", async (t) => {
  const wrong = await prepareForSteps(t);
  const wrongResult = await wrong.orchestrator.execute({
    action: "restore",
    runId: wrong.prepared.runId,
    reviewedPriorFrame: { captureSha256: "f".repeat(64), attestation: "LOOKed the wrong frame" },
  });
  assert.equal(wrongResult.status, "review_rejected");
  assert.equal(wrong.calls.length, 0);

  const tampered = await prepareForSteps(t);
  const originalBaseline = fs.readFileSync(tampered.baselineReview.path);
  fs.writeFileSync(tampered.baselineReview.path, makePng(99));
  const tamperedResult = await tampered.orchestrator.execute({
    action: "restore",
    runId: tampered.prepared.runId,
    reviewedPriorFrame: reviewFor(tampered.baselineReview),
  });
  assert.equal(tamperedResult.status, "restore_failed");
  assert.match(tamperedResult.primaryError, /retained image|sha256|immutable/i);
  assert.deepEqual(tamperedResult.requiredReview, []);
  assert.deepEqual(tampered.calls.map((call) => call.kind), ["readReview", "stop", "finalProcess", "safety"]);
  const tamperedCallCount = tampered.calls.length;
  const repeatedFailure = await tampered.orchestrator.execute({
    action: "restore",
    runId: tampered.prepared.runId,
    reviewedPriorFrame: reviewFor(tampered.baselineReview),
  });
  assert.equal(repeatedFailure.status, "restore_failed");
  assert.match(repeatedFailure.primaryError, /retained image|sha256|immutable/i);
  assert.equal(tampered.calls.filter((call) => call.kind === "stop").length, 1,
    "a failed retry must not repeat a stop already proven by the first attempt");
  assert.ok(tampered.calls.length > tamperedCallCount, "a failed restore remains safely retryable");
  fs.writeFileSync(tampered.baselineReview.path, originalBaseline);
  const recovered = await tampered.orchestrator.execute({
    action: "restore",
    runId: tampered.prepared.runId,
    reviewedPriorFrame: reviewFor(tampered.baselineReview),
  });
  assert.equal(recovered.status, "restored_needs_review");
  assert.equal(recovered.primaryError, null);

  const once = await prepareForSteps(t);
  const request = {
    action: "restore",
    runId: once.prepared.runId,
    reviewedPriorFrame: reviewFor(once.baselineReview),
  };
  const first = await once.orchestrator.execute(request);
  const effectCount = deviceCalls(once.calls).length;
  const replayed = await once.orchestrator.execute(request);
  assert.deepEqual({ ...replayed, actionAuditMaintenance: first.actionAuditMaintenance }, first);
  assert.equal(replayed.actionAuditMaintenance.status, "current");
  assert.equal(deviceCalls(once.calls).length, effectCount);
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
  const fixture = await prepareForSteps(t, { finalTargetPresent: true });
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

test("restore retries a transient owned-target stop failure and converges on an idempotent result", async (t) => {
  const fixtureOptions = { finalTargetPresent: true };
  const fixture = await prepareForSteps(t, fixtureOptions);
  let stopAttempts = 0;
  fixture.dependencies.stopPackage = async (context) => {
    fixture.calls.push({ kind: "stop", context });
    stopAttempts++;
    if (stopAttempts === 1) return { status: "failed", error: "transient owned target stop failure" };
    return completedStopReceipt(context);
  };
  fixture.calls.length = 0;
  const request = {
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  };

  const failed = await fixture.orchestrator.execute(request);
  assert.equal(failed.status, "restore_failed");
  assert.match(failed.cleanupError, /transient owned target stop failure/i);
  await assert.rejects(fixture.orchestrator.execute({
    ...fixture.input,
    artifactRoot: externalArtifactRoot(t, "quarantine-reason"),
  }), /target.*stop|stop.*target/i);
  const retryRequest = {
    ...request,
    reviewedPriorFrame: reviewFor(failed.requiredReview[0]),
  };

  fixtureOptions.finalTargetPresent = false;
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute(retryRequest);
  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  assert.equal(restored.primaryError, null);
  assert.equal(restored.cleanupError, null);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
  assert.equal(fixture.calls.some((call) => call.kind === "locomote" || call.kind === "capture"), false,
    "a retry must retain the already-validated zero-offset recovery instead of moving or capturing again");
  const replayEffectCount = deviceCalls(fixture.calls).length;
  const replayed = await fixture.orchestrator.execute(retryRequest);
  assert.deepEqual({ ...replayed, actionAuditMaintenance: restored.actionAuditMaintenance }, restored);
  assert.equal(replayed.actionAuditMaintenance.status, "current");
  assert.equal(deviceCalls(fixture.calls).length, replayEffectCount);
});

test("restore retry accepts the validated zero-offset recovery frame after a transient final-proof failure", async (t) => {
  const fixture = await prepareForSteps(t);
  const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stepped.status, "needs_waypoint_review");
  const movedReview = stepped.requiredReview[0];
  const originalFinalProcess = fixture.dependencies.probeFinalProcessState;
  let finalProcessAttempts = 0;
  fixture.dependencies.probeFinalProcessState = async (context) => {
    finalProcessAttempts += 1;
    if (finalProcessAttempts === 1) {
      fixture.calls.push({ kind: "finalProcess", context });
      throw new Error("transient final process proof failure");
    }
    return originalFinalProcess(context);
  };
  fixture.calls.length = 0;

  const failed = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(movedReview),
  });
  assert.equal(failed.status, "restore_failed");
  assert.match(failed.cleanupError, /transient final process proof failure/i);
  assert.equal(failed.requiredReview.length, 1);
  assert.notEqual(failed.requiredReview[0].captureSha256, movedReview.captureSha256,
    "the validated zero-offset recovery frame must replace the moved current frame");

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(failed.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  assert.equal(restored.requiredReview[0].captureSha256, failed.requiredReview[0].captureSha256);
  assert.equal(fixture.calls.some((call) => call.kind === "locomote" || call.kind === "capture"), false,
    "retry retains the validated zero-offset frame without repeating movement or capture");
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1,
    "a failed authoritative final probe keeps target absence unproven and re-arms a safe stop");
});

test("cleanup-only restore retries receive a fresh bounded recovery deadline after the original run deadline", async (t) => {
  const fixtureOptions = { finalTargetPresent: true };
  const fixture = await prepareForSteps(t, fixtureOptions);
  let stopAttempts = 0;
  fixture.dependencies.stopPackage = async (context) => {
    fixture.calls.push({ kind: "stop", context });
    stopAttempts += 1;
    if (stopAttempts === 1) throw new Error("transient stop before deadline rollover");
    return completedStopReceipt(context);
  };
  const first = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(first.status, "restore_failed");
  fixtureOptions.finalTargetPresent = false;
  let lateNowNs = 9_000_000_000_000_000n;
  fixture.dependencies.monotonicNs = () => ++lateNowNs;
  fixture.calls.length = 0;

  const retried = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(first.requiredReview[0]),
  });
  assert.equal(retried.status, "restored_needs_review", JSON.stringify(retried));
  assert.equal(retried.primaryError, null);
  assert.equal(retried.cleanupError, null);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
  assert.equal(fixture.calls.some((call) => call.kind === "locomote" || call.kind === "capture"), false);
});

test("a first restore whose original run deadline expired receives a fresh recovery envelope", async (t) => {
  const fixture = await prepareForSteps(t);
  let lateNowNs = 9_000_000_000_000_000n;
  fixture.dependencies.monotonicNs = () => ++lateNowNs;
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });

  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  assert.equal(fixture.calls.some((call) => call.kind === "locomote"), true);
  const action = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.equal(action.restoreDeadlineSource, "fresh_recovery_deadline");
});

test("restore entry validation owns a fixed window and expired cleanup stages still execute cleanup-only", async (t) => {
  for (const [label, validationDelayMs, expectCleanupOnly] of [
    ["entry boundary", 5_001, false],
    ["all cleanup subdeadlines", 200_000, true],
  ]) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t, {
        inputOverrides: {
          budgets: { maxDurationMs: 370_000, routeReserveMs: 110_000, restorationReserveMs: 104_166 },
        },
      });
      let nowNs = 9_000_000_000_000_000n;
      fixture.dependencies.monotonicNs = () => nowNs++;
      const readReview = fixture.dependencies.readReviewImage;
      let delayed = false;
      fixture.dependencies.readReviewImage = (...args) => {
        const bytes = readReview(...args);
        if (!delayed) {
          delayed = true;
          nowNs += BigInt(validationDelayMs) * 1_000_000n;
        }
        return bytes;
      };
      fixture.calls.length = 0;

      const failed = await fixture.orchestrator.execute({
        action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
      });

      assert.equal(failed.status, "restore_failed");
      assert.match(failed.primaryError, /restore entry validation.*deadline/i);
      assert.equal(fixture.calls.some((call) => call.kind === "continuity" || call.kind === "locomote" || call.kind === "capture"), false);
      const stop = fixture.calls.find((call) => call.kind === "stop" && call.context.reason === "restore_run_owned_target");
      const proof = fixture.calls.find((call) => call.kind === "finalProcess");
      const safety = fixture.calls.find((call) => call.kind === "safety" && call.context.phase === "restore_after_prior_disposition");
      assert.ok(stop);
      assert.ok(proof);
      assert.ok(safety);
      assert.equal(stop.context.cleanupOnly === true, expectCleanupOnly);
      assert.equal(proof.context.cleanupOnly === true, expectCleanupOnly);
      assert.equal(safety.context.cleanupOnly === true, expectCleanupOnly);
      if (expectCleanupOnly) assert.match(failed.cleanupError, /cannot begin.*subdeadline/i);
    });
  }
});

test("restore never relaunches a non-receipt prior until target shutdown is proven", async (t) => {
  const component = "com.prior.unbound/.MainActivity";
  const fixtureOptions = {
    inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
    priorSnapshot: { component, packageName: "com.prior.unbound", userInstalled: true },
    finalTargetPresent: true,
    safetySequence: [cleanSafety, cleanMixedSafety, cleanMixedSafety],
  };
  const fixture = await prepareForSteps(t, fixtureOptions);
  let stopAttempts = 0;
  fixture.dependencies.stopPackage = async (context) => {
    fixture.calls.push({ kind: "stop", context });
    stopAttempts += 1;
    if (stopAttempts === 1) throw new Error("transient target stop failure");
    return completedStopReceipt(context);
  };
  fixture.calls.length = 0;

  const failed = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(failed.status, "restore_failed");
  assert.equal(failed.priorForeground.relaunchDisposition, "blocked");
  assert.equal(fixture.calls.some((call) => call.kind === "relaunchPrior"), false);
  const failedAction = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.deepEqual(failedAction.priorRelaunch, {
    status: "blocked",
    reason: "target_absence_unproven",
  });

  fixtureOptions.finalTargetPresent = false;
  fixtureOptions.finalResumedComponents = [component];
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(failed.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  assert.equal(restored.priorForeground.relaunchDisposition, "state_proven_without_attempt");
  assert.equal(fixture.calls.filter((call) => call.kind === "relaunchPrior").length, 0,
    "the exact pre-relaunch process proof already showed the requested prior activity");
});

test("target absence cannot supersede a failed stop barrier and a retry converges", async (t) => {
  const fixture = await prepareForSteps(t);
  let stopFails = true;
  fixture.dependencies.stopPackage = async (context) => {
    fixture.calls.push({ kind: "stop", context });
    if (stopFails) throw new Error("stop transport failed after the process exited");
    return completedStopReceipt(context);
  };
  fixture.calls.length = 0;
  const request = {
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  };

  const failed = await fixture.orchestrator.execute(request);
  assert.equal(failed.status, "restore_failed");
  assert.equal(failed.restorationDisposition, "unresolved");
  assert.equal(failed.primaryError, null);
  assert.match(failed.cleanupError, /stop transport failed after the process exited/i);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "finalProcess").length, 1);
  const action = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.match(action.targetStop.error, /stop transport failed after the process exited/);
  assert.deepEqual(action.finalProcessProof.targetPids, []);
  await assert.rejects(fixture.orchestrator.execute({
    ...fixture.input,
    artifactRoot: externalArtifactRoot(t, "failed-stop-barrier-quarantine"),
  }), /serial.*(?:owned|quarantin|restore)|(?:owned|quarantin|restore).*serial/i);

  stopFails = false;
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    ...request,
    reviewedPriorFrame: reviewFor(failed.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  assert.equal(restored.restorationDisposition, "zero_proven");
  assert.deepEqual(deviceCalls(fixture.calls).map((call) => call.kind), ["stop", "finalProcess", "safety"]);
});

test("a stop receipt completing at its exact subdeadline cannot authorize shutdown cleanup", async (t) => {
  const fixture = await prepareForSteps(t);
  let nowNs = 2_000_000_000n;
  let expireStop = true;
  fixture.dependencies.monotonicNs = () => nowNs++;
  const originalStop = fixture.dependencies.stopPackage;
  fixture.dependencies.stopPackage = async (context) => {
    const result = await originalStop(context);
    if (expireStop && context.reason === "restore_run_owned_target") {
      expireStop = false;
      nowNs = BigInt(context.deadlineMonotonicNs);
    }
    return result;
  };
  fixture.calls.length = 0;
  const request = {
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  };

  const failed = await fixture.orchestrator.execute(request);
  assert.equal(failed.status, "restore_failed");
  assert.equal(failed.restorationDisposition, "unresolved");
  assert.match(failed.cleanupError, /owned target stop.*subdeadline/i);
  assert.deepEqual(committedActionPayloads(fixture.input.artifactRoot).at(-1).finalProcessProof.targetPids, []);
  assert.equal(fixture.calls.some((call) => call.kind === "nonceCleanup"
    && call.context.processStopped === true), false);

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    ...request,
    reviewedPriorFrame: reviewFor(failed.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  assert.deepEqual(deviceCalls(fixture.calls).map((call) => call.kind), ["stop", "finalProcess", "safety"]);
});

test("authoritative prior activity supersedes a failed relaunch transport after target absence is proven", async (t) => {
  const component = "com.prior.unbound/.MainActivity";
  const fixtureOptions = {
    inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
    priorSnapshot: { component, packageName: "com.prior.unbound", userInstalled: true },
    finalResumedComponents: ["com.picoxr.launcher/.Launcher"],
    safetySequence: [cleanSafety, cleanMixedSafety],
  };
  const fixture = await prepareForSteps(t, fixtureOptions);
  fixture.dependencies.relaunchPrior = async (context) => {
    fixture.calls.push({ kind: "relaunchPrior", context });
    fixtureOptions.finalResumedComponents = [component];
    throw new Error("relaunch transport failed after activity resumed");
  };
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  assert.equal(restored.primaryError, null);
  assert.equal(restored.cleanupError, null);
  assert.equal(restored.priorForeground.relaunchDisposition, "state_proven_after_attempt_error");
  const firstProbe = fixture.calls.findIndex((call) => call.kind === "finalProcess");
  const relaunch = fixture.calls.findIndex((call) => call.kind === "relaunchPrior");
  const lastProbe = fixture.calls.findLastIndex((call) => call.kind === "finalProcess");
  assert.ok(firstProbe >= 0 && firstProbe < relaunch && relaunch < lastProbe,
    "target absence must be proven before relaunch and prior activity must be proven afterward");
});

test("restore preserves final-state proof provenance across a later safety retry", async (t) => {
  const component = "com.prior.unbound/.MainActivity";
  const fixtureOptions = {
    inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
    priorSnapshot: { component, packageName: "com.prior.unbound", userInstalled: true },
    finalResumedComponents: ["com.picoxr.launcher/.Launcher"],
    safetySequence: [
      cleanSafety,
      { ...cleanMixedSafety, guardian: "0" },
      cleanMixedSafety,
    ],
  };
  const fixture = await prepareForSteps(t, fixtureOptions);
  fixture.dependencies.relaunchPrior = async (context) => {
    fixture.calls.push({ kind: "relaunchPrior", context });
    fixtureOptions.finalResumedComponents = [component];
    throw new Error("relaunch response lost after exact prior resumed");
  };

  const first = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(first.status, "restore_failed");
  assert.match(first.cleanupError, /guardian/i);
  assert.equal(first.priorForeground.relaunchDisposition, "state_proven_after_attempt_error");

  fixture.calls.length = 0;
  const retried = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(first.requiredReview[0]),
  });
  assert.equal(retried.status, "restored_needs_review", JSON.stringify(retried));
  assert.equal(retried.priorForeground.relaunchDisposition, "state_proven_after_attempt_error");
  assert.equal(fixture.calls.some((call) => call.kind === "relaunchPrior"), false);
  const action = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.deepEqual(action.priorRelaunch, {
    status: "not_attempted",
    reason: "prior_state_already_proven",
  });
  assert.equal(action.priorForeground.relaunchDisposition, "state_proven_after_attempt_error");
});

test("restore retries a prior relaunch when authoritative final proof contradicts its immediate receipt", async (t) => {
  const component = "com.prior.unbound/.MainActivity";
  const fixtureOptions = {
    inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
    priorSnapshot: { component, packageName: "com.prior.unbound", userInstalled: true },
    finalResumedComponents: ["com.picoxr.launcher/.Launcher"],
    safetySequence: [cleanSafety, cleanMixedSafety, cleanMixedSafety],
  };
  const fixture = await prepareForSteps(t, fixtureOptions);
  fixture.calls.length = 0;
  const first = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(first.status, "restore_failed");
  assert.match(first.cleanupError, /exact relaunched|prior component|final process/i);
  assert.equal(fixture.calls.filter((call) => call.kind === "relaunchPrior").length, 1);

  fixtureOptions.finalResumedComponents = [component];
  fixture.calls.length = 0;
  const retried = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(first.requiredReview[0]),
  });
  assert.equal(retried.status, "restored_needs_review", JSON.stringify(retried));
  assert.equal(retried.priorForeground.relaunchDisposition, "state_proven_without_attempt");
  assert.equal(fixture.calls.filter((call) => call.kind === "relaunchPrior").length, 0,
    "the retry's exact pre-relaunch proof makes another launch unnecessary");
});

test("proven nonce absence with an rm warning does not quarantine an otherwise complete restore", async (t) => {
  const fixture = await prepareForSteps(t, { locomotionResult: routeOwnedCompletedResult });
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    fixture.calls.push({ kind: "nonceCleanup", context });
    return { ...successfulNonceCleanupReceipt(context), removalError: "rm transport warning after exact absence" };
  };
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(restored.status, "restored_needs_review", JSON.stringify(restored));
  assert.equal(restored.primaryError, null);
  assert.equal(restored.cleanupError, null);
  const action = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.equal(action.locomotionNonceCleanup.removalError, "rm transport warning after exact absence");
});

test("a resolved failed target-stop receipt never proves prepare clearance or emergency quiescence", async (t) => {
  const preparing = await createPreparedFixture(t);
  preparing.dependencies.stopPackage = async (context) => {
    preparing.calls.push({ kind: "stop", context });
    return { status: "failed", error: "target stop was not accepted" };
  };
  const preparation = await createInAppLocomotionOrchestrator(preparing.dependencies).execute(preparing.input);
  assert.equal(preparation.status, "preparation_failed");
  assert.match(`${preparation.primaryError} ${preparation.cleanupError}`, /stop|accepted|receipt/i);
  assert.equal(preparing.calls.some((call) => call.kind === "launch"), false);

  const stepping = await prepareForSteps(t);
  stepping.dependencies.requestLocomotion = async (input) => {
    stepping.calls.push({ kind: "locomote", input });
    return deferredUnquiescedResult(input);
  };
  const successfulStop = stepping.dependencies.stopPackage;
  stepping.dependencies.stopPackage = async (context) => {
    stepping.calls.push({ kind: "stop", context });
    return { status: "failed", error: "emergency target stop was not accepted" };
  };
  stepping.calls.length = 0;
  const stopped = await stepping.orchestrator.execute(stepRequest(stepping, reviewFor(stepping.baselineReview)));
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.cleanupError, /stop|accepted|receipt/i);
  assert.equal(stepping.calls.some((call) => call.kind === "nonceCleanup"), false);
  const action = fs.readFileSync(path.join(stepping.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.deepEqual(action.emergencyStop, {
    attempted: true,
    stopCommandReceipt: null,
    targetAbsenceProven: false,
    error: action.emergencyStop.error,
  });
  assert.match(action.emergencyStop.error, /stop|accepted|receipt/i);

  stepping.calls.length = 0;
  const restored = await stepping.orchestrator.execute({
    action: "restore",
    runId: stepping.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.restorationDisposition, "unresolved");
  assert.deepEqual(
    stepping.calls.filter((call) => ["stop", "finalProcess", "nonceCleanup", "safety"].includes(call.kind))
      .map((call) => call.kind),
    ["stop", "finalProcess", "safety"],
  );
  assert.equal(stepping.calls.some((call) => call.kind === "nonceCleanup"), false);

  stepping.dependencies.stopPackage = successfulStop;
  stepping.calls.length = 0;
  const retried = await stepping.orchestrator.execute({
    action: "restore",
    runId: stepping.prepared.runId,
    reviewedPriorFrame: reviewFor(restored.requiredReview[0]),
  });
  assert.equal(retried.restorationDisposition, "safe_release_without_zero_proof");
  assert.deepEqual(
    stepping.calls.filter((call) => ["stop", "finalProcess", "nonceCleanup", "safety"].includes(call.kind))
      .map((call) => call.kind),
    ["stop", "finalProcess", "nonceCleanup", "safety"],
  );
  const cleanup = stepping.calls.find((call) => call.kind === "nonceCleanup");
  assert.equal(cleanup.context.processStopped, true);
  assert.equal(cleanup.context.probeOnly, undefined);
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
  assert.match(registrations[0].definition.description, /receipt-bound.*(?:withheld|not relaunch)|(?:withheld|not relaunch).*receipt-bound/i);
  const prepareArm = inAppLocomotionInputSchema.options
    .map((option) => option._def?.schema ?? option)
    .find((option) => option.shape.action.value === "prepare");
  assert.match(prepareArm.shape.priorForeground.description, /receipt-bound.*(?:withheld|not relaunch)|(?:withheld|not relaunch).*receipt-bound/i);
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
  const failedRestore = await restoreFixture.orchestrator.execute({
    action: "restore",
    runId: restoreFixture.prepared.runId,
    reviewedPriorFrame: reviewFor(restoreFixture.baselineReview),
  });
  assert.equal(failedRestore.status, "restore_failed");
  assert.match(failedRestore.primaryError, /AppSpec|spec|ENOENT|receipt|artifact/i);
  assert.equal(restoreFixture.calls.some((call) => call.kind === "locomote"), false);
  assert.equal(restoreFixture.calls.filter((call) => call.kind === "stop").length, 1);
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

  const failedRestore = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
  });
  assert.equal(failedRestore.status, "restore_failed");
  assert.match(failedRestore.primaryError, /log.*(?:changed|immutable)|immutable.*log/i);
  assert.equal(fixture.calls.some((call) => call.kind === "locomote"), false);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
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
    await assert.rejects(orchestrator.execute(secondInput), /serial.*(?:progress|mutation|active|owned)|(?:mutation|active|owned).*serial/i);
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

test("route and restoration admission reserve the full direct glide before any dependency read", async (t) => {
  let dependencyReads = 0;
  const dependencies = new Proxy({}, {
    get() {
      dependencyReads += 1;
      throw new Error("dependency should not be read");
    },
  });
  const orchestrator = createInAppLocomotionOrchestrator(dependencies);
  const valid = prepareRouteInput(t, {
    route: {
      waypoints: [{ seq: 1, target: { absolute: true, x: 1, y: 0, z: -2 } }],
      restoreTarget: { absolute: true, x: 0, y: 0, z: 0 },
      glideDurationMs: 10_000,
    },
  });
  for (const [label, budgets] of [
    ["route", { maxDurationMs: 180_000, routeReserveMs: 24_201, restorationReserveMs: 45_000 }],
    ["restore", { maxDurationMs: 180_000, routeReserveMs: 45_000, restorationReserveMs: 23_801 }],
  ]) {
    await assert.rejects(orchestrator.execute({
      ...valid,
      artifactRoot: externalArtifactRoot(t, `glide-${label}`),
      budgets,
    }), /glide|budget|reserve|envelope/i);
  }
  assert.equal(dependencyReads, 0);
});

test("route schema shares the exact rev-1 locomotion cancellation and finalization envelope", (t) => {
  const minimumBridgeEnvelopeMs = agentBridge.agentBridgeLocomotionMinimumEnvelopeMs({
    maxPolls: 10,
    pollMs: 100,
    stabilityReads: 2,
    executionDelayMs: 0,
  });
  assert.equal(minimumBridgeEnvelopeMs, 11_650);

  const valid = prepareRouteInput(t, {
    route: {
      waypoints: [{ seq: 1, target: { absolute: true, x: 1, y: 0, z: -2 } }],
      restoreTarget: { absolute: true, x: 0, y: 0, z: 0 },
      glideDurationMs: 500,
    },
    budgets: { maxDurationMs: 340_000, routeReserveMs: 110_000, restorationReserveMs: 110_000 },
  });
  // 5s BEGIN + 5s pre-safety + 10s pre-continuity + 8s capture + 0.5s glide
  // + 11.65s move + 2.85s nonce cleanup + two 13.15s HMD acquisitions
  // + 5s post-safety + 10s post-continuity + 15s finalization
  // + 5s action publication + 13ms of capture-completion and inter-stage handoff guards.
  const exactRouteFloor = 104_313;
  // 8s capture + 0.5s glide + three 11.65s bridge transactions + two 2.85s nonce-cleanup windows
  // + two 10s continuity samples + 5s target stop + two 5s process proofs + 5s prior relaunch
  // + 5s entry validation + 5s final safety + 5s action publication
  // + 15ms of completion/handoff guards.
  const exactRestorationFloor = 104_165;

  assert.equal(inAppLocomotionInputSchema.safeParse({
    ...valid,
    budgets: { ...valid.budgets, routeReserveMs: exactRouteFloor },
  }).success, false);
  assert.equal(inAppLocomotionInputSchema.safeParse({
    ...valid,
    budgets: { ...valid.budgets, routeReserveMs: exactRouteFloor + 1 },
  }).success, true);
  assert.equal(inAppLocomotionInputSchema.safeParse({
    ...valid,
    budgets: { ...valid.budgets, restorationReserveMs: exactRestorationFloor },
  }).success, false);
  assert.equal(inAppLocomotionInputSchema.safeParse({
    ...valid,
    budgets: { ...valid.budgets, restorationReserveMs: exactRestorationFloor + 1 },
  }).success, true);
});

test("the minimum schema-admitted route reserve remains executable after the entry clock re-read", async (t) => {
  const fixture = await prepareForSteps(t, {
    inputOverrides: {
      budgets: { maxDurationMs: 350_000, routeReserveMs: 104_314, restorationReserveMs: 110_000 },
    },
  });

  const result = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(result.status, "needs_waypoint_review", JSON.stringify(result));
  assert.equal(result.primaryError, null);
});

test("a maximum direct glide still completes all post-step evidence and the reviewed restore path", async (t) => {
  const fixture = await prepareForSteps(t, {
    inputOverrides: {
      budgets: { maxDurationMs: 380_000, routeReserveMs: 120_000, restorationReserveMs: 120_000 },
      route: {
        waypoints: [
          { seq: 1, target: { absolute: true, x: 1, y: 0, z: -2 } },
          { seq: 2, target: { absolute: true, x: 2, y: 0, z: -4 } },
        ],
        restoreTarget: { absolute: true, x: 0, y: 0, z: 0 },
        glideDurationMs: 10_000,
      },
    },
  });
  const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stepped.status, "needs_waypoint_review");
  const stepMoveIndex = fixture.calls.findIndex((call) => call.kind === "locomote");
  assert.equal(fixture.calls[stepMoveIndex].input.glideDurationMs, 10_000);
  for (const kind of ["capture", "hmd", "safety", "continuity"])
    assert.ok(fixture.calls.findIndex((call, index) => index > stepMoveIndex && call.kind === kind) > stepMoveIndex, `${kind} must follow the delayed move`);

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review");
  const restoreMove = fixture.calls.find((call) => call.kind === "locomote");
  assert.equal(restoreMove.input.glideDurationMs, 10_000);
  assert.equal(fixture.calls.some((call) => call.kind === "capture" && call.input.mode === "transition_then_stable"), true);
  assert.equal(fixture.calls.some((call) => call.kind === "finalProcess"), true);
  assert.equal(fixture.calls.some((call) => call.kind === "safety"), true);
});

test("ConfigurationService parser accepts embedded keyName/keyValue JSON and rejects ambiguity", () => {
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

test("an idempotent completed restore repairs audit maintenance without device effects and rejects later artifact damage", async (t) => {
  const fixture = await prepareForSteps(t);
  const request = {
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
  };
  const first = await fixture.orchestrator.execute(request);
  assert.equal(first.status, "restored_needs_review");
  assert.equal(first.actionAuditMaintenance.status, "repair_pending");
  assert.ok(fs.readdirSync(path.join(fixture.input.artifactRoot, "action-records"))
    .some((name) => /^\.[0-9]{6}\.[a-f0-9]{32}\.tmp$/.test(name)));

  fixture.calls.length = 0;
  const repeated = await fixture.orchestrator.execute(request);
  assert.equal(repeated.status, "restored_needs_review");
  assert.equal(repeated.actionAuditMaintenance.status, "current");
  assert.equal(deviceCalls(fixture.calls).length, 0,
    "idempotent maintenance repair performs no device effect or probe");
  assert.equal(fs.readdirSync(path.join(fixture.input.artifactRoot, "action-records"))
    .some((name) => /^\.[0-9]{6}\.[a-f0-9]{32}\.tmp$/.test(name)), false);
  assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8"),
    committedActionPayloads(fixture.input.artifactRoot).map((payload) => canonicalJson(payload)).join("\n") + "\n");

  const committedRecords = fs.readdirSync(path.join(fixture.input.artifactRoot, "action-records"))
    .filter((name) => /^\d{6}\.json$/.test(name)).sort();
  fs.appendFileSync(path.join(fixture.input.artifactRoot, "action-records", committedRecords.at(-1)), Buffer.from("damage"));
  const rejected = await fixture.orchestrator.execute({
    ...request, reviewedPriorFrame: reviewFor(repeated.requiredReview[0]),
  });
  assert.equal(rejected.status, "review_rejected");
  assert.match(rejected.primaryError, /action|artifact|sha256|changed|immutable/i);
});

test("a substituted derived action view is rebuilt from the immutable committed record", async (t) => {
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

  assert.equal(result.status, "needs_waypoint_review");
  assert.equal(result.primaryError, null);
  assert.equal(result.actionAuditMaintenance.status, "repair_pending");
  assert.equal(committedActionPayloads(fixture.input.artifactRoot).length, 2);
  assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl.original"), "utf8").trim().split("\n").length, 1);
  const restored = await orchestrator.execute({
    action: "restore", runId: prepared.runId, reviewedPriorFrame: reviewFor(result.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review");
  assert.equal(restored.actionAuditMaintenance.status, "repair_pending");
  assert.equal(committedActionPayloads(fixture.input.artifactRoot).length, 3);
  assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8"),
    committedActionPayloads(fixture.input.artifactRoot).slice(0, 2).map((payload) => canonicalJson(payload)).join("\n") + "\n");
  const adjudicated = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    frameAttestations: attestationsFor([
      prepared.requiredReview[0], result.requiredReview[0], restored.requiredReview[0],
    ]),
  });
  assert.equal(adjudicated.status, "structural_complete");
  assert.equal(adjudicated.actionAuditMaintenance.status, "current");
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

test("prepare success and failure audit publication cannot cross their fixed phase deadlines", async (t) => {
  await t.test("completed prepare pre-link deadline", async (t) => {
    let nowNs = 0n;
    const fixture = await createPreparedFixture(t, { monotonicNs: () => nowNs });
    const prepareActionDeadlineNs = BigInt(
      fixture.input.budgets.maxDurationMs
      - fixture.input.budgets.routeReserveMs
      - fixture.input.budgets.restorationReserveMs,
    ) * 1_000_000n;
    let expire = true;
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
      beforeActionRecordCommit({ action, status }) {
        if (action === "prepare" && status === "completed" && expire) {
          expire = false;
          nowNs = prepareActionDeadlineNs;
        }
      },
    });

    const failed = await orchestrator.execute(fixture.input);
    assert.equal(failed.status, "preparation_failed");
    assert.match(failed.primaryError, /prepare action publication.*deadline/i);
    const actions = committedActionPayloads(fixture.input.artifactRoot);
    assert.equal(actions.some((action) => action.status === "completed"), false);
    assert.equal(actions.at(-1).status, "failed");

    const retried = await orchestrator.execute({
      ...fixture.input,
      artifactRoot: externalArtifactRoot(t, "prepare-action-pre-link-retry"),
    });
    assert.equal(retried.status, "needs_baseline_review", JSON.stringify(retried));
  });

  await t.test("completed prepare post-link deadline", async (t) => {
    let nowNs = 0n;
    const fixture = await createPreparedFixture(t, { monotonicNs: () => nowNs });
    const prepareActionDeadlineNs = BigInt(
      fixture.input.budgets.maxDurationMs
      - fixture.input.budgets.routeReserveMs
      - fixture.input.budgets.restorationReserveMs,
    ) * 1_000_000n;
    const originalLinkSync = fs.linkSync;
    let expire = true;
    fs.linkSync = function linkThenExpirePrepare(source, target) {
      const result = originalLinkSync.apply(this, arguments);
      if (expire && path.basename(String(target)) === "000001.json") {
        expire = false;
        nowNs = prepareActionDeadlineNs;
      }
      return result;
    };
    t.after(() => { fs.linkSync = originalLinkSync; });
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);

    const failed = await orchestrator.execute(fixture.input);
    assert.equal(failed.status, "preparation_failed");
    assert.match(failed.primaryError, /committed.*publication deadline.*unproven/i);
    const actions = committedActionPayloads(fixture.input.artifactRoot);
    assert.equal(actions.length, 2);
    assert.equal(actions[0].status, "completed");
    assert.equal(actions[1].status, "failed");
    assert.equal(actions[1].compensatesActionOperationId, "prepare:terminal");
    assert.equal(actions[1].serialLease.status, "release_eligible_after_action_publication");
    assert.equal(fixture.calls.filter((call) => call.kind === "stop"
      && call.context.reason === "prepare_failure_cleanup").length, 1);
    const retried = await orchestrator.execute({
      ...fixture.input,
      artifactRoot: externalArtifactRoot(t, "prepare-action-post-link-retry"),
    });
    assert.equal(retried.status, "needs_baseline_review", JSON.stringify(retried));
  });

  await t.test("failed prepare audit deadline", async (t) => {
    let nowNs = 0n;
    const capabilityFailure = {
      ok: false,
      code: "capability_unavailable",
      detail: "capability stage fault",
      primaryError: "capability stage fault",
      cleanupError: null,
      actionReceipts: [],
      evidenceCeiling: "structural",
    };
    const fixture = await createPreparedFixture(t, { monotonicNs: () => nowNs, capability: capabilityFailure });
    const recoveryDeadlineNs = BigInt(fixture.input.budgets.maxDurationMs) * 1_000_000n;
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
      beforeActionRecordCommit({ action, status }) {
        if (action === "prepare" && status === "failed") nowNs = recoveryDeadlineNs;
      },
    });

    const failed = await orchestrator.execute(fixture.input);
    assert.equal(failed.status, "preparation_failed");
    assert.match(failed.primaryError, /capability stage fault/i);
    assert.match(failed.cleanupError, /failed action audit.*publication.*deadline/i);
    assert.deepEqual(committedActionPayloads(fixture.input.artifactRoot), []);
    await assert.rejects(orchestrator.execute({
      ...fixture.input,
      artifactRoot: externalArtifactRoot(t, "failed-prepare-action-quarantine"),
    }), /serial.*(?:quarantin|owned|audit)|(?:quarantin|owned|audit).*serial/i);
  });

  await t.test("failed prepare audit post-link deadline", async (t) => {
    let nowNs = 0n;
    const capabilityFailure = {
      ok: false,
      code: "capability_unavailable",
      detail: "capability stage fault",
      primaryError: "capability stage fault",
      cleanupError: null,
      actionReceipts: [],
      evidenceCeiling: "structural",
    };
    const fixture = await createPreparedFixture(t, { monotonicNs: () => nowNs, capability: capabilityFailure });
    const recoveryDeadlineNs = BigInt(fixture.input.budgets.maxDurationMs) * 1_000_000n;
    const originalLinkSync = fs.linkSync;
    let expire = true;
    fs.linkSync = function linkThenExpireFailedPrepare(source, target) {
      const result = originalLinkSync.apply(this, arguments);
      if (expire && path.basename(String(target)) === "000001.json") {
        expire = false;
        nowNs = recoveryDeadlineNs;
      }
      return result;
    };
    t.after(() => { fs.linkSync = originalLinkSync; });
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);

    const failed = await orchestrator.execute(fixture.input);
    assert.equal(failed.status, "preparation_failed");
    assert.match(failed.primaryError, /capability stage fault/i);
    assert.match(failed.cleanupError, /committed.*publication deadline.*unproven/i);
    const actions = committedActionPayloads(fixture.input.artifactRoot);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, "failed");
    assert.equal(actions[0].serialLease.status, "release_eligible_after_action_publication");
    await assert.rejects(orchestrator.execute({
      ...fixture.input,
      artifactRoot: externalArtifactRoot(t, "failed-prepare-post-link-quarantine"),
    }), /serial.*(?:quarantin|owned|audit)|(?:quarantin|owned|audit).*serial/i);
  });
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

test("an exact final resumed-component proof can supersede an invalid prior relaunch acknowledgement", async (t) => {
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
  assert.equal(result.status, "restored_needs_review", JSON.stringify(result));
  assert.equal(result.cleanupError, null);
  assert.equal(result.priorForeground.relaunchDisposition, "state_proven_after_attempt_error");
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

test("final safeguard-center drift blocks terminal safe release and quarantines the serial", async (t) => {
  const fixture = await prepareForSteps(t, {
    locomotionResult: deferredUnquiescedResult,
    safetySequence: [cleanSafety, cleanSafety, { ...cleanMixedSafety, safeguardCenter: "4,0,0" }],
  });
  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stopped.status, "stopped");

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.status, "restore_failed");
  assert.equal(restored.restorationDisposition, "unresolved");
  assert.match(restored.cleanupError, /safeguardCenter=4,0,0.*0,0,0/i);
  await assert.rejects(fixture.orchestrator.execute({
    ...fixture.input,
    artifactRoot: externalArtifactRoot(t, "center-drift-quarantine"),
  }), /serial.*(?:owned|quarantin|restore)|(?:owned|quarantin|restore).*serial/i);
});

test("prepare uses one fixed phase deadline, clamps baseline capture, and stops before capture after overrun", async (t) => {
  let nowNs = 0n;
  const clamped = await createPreparedFixture(t, {
    inputOverrides: {
      budgets: { maxDurationMs: 320_000, routeReserveMs: 105_000, restorationReserveMs: 105_000 },
    },
    monotonicNs: () => nowNs,
    afterMonitor: () => { nowNs = 89_348_000_000n; },
  });
  const prepared = await createInAppLocomotionOrchestrator(clamped.dependencies).execute(clamped.input);
  assert.equal(prepared.status, "needs_baseline_review");
  const clampedCapture = clamped.calls.find((call) => call.kind === "capture").input;
  assert.equal(clampedCapture.deadlineMs, 3_999);
  assert.equal(clampedCapture.attemptTimeoutMs, 1_000);

  nowNs = 0n;
  const overrun = await createPreparedFixture(t, {
    inputOverrides: {
      artifactRoot: externalArtifactRoot(t, "prepare-overrun"),
      budgets: { maxDurationMs: 320_000, routeReserveMs: 105_000, restorationReserveMs: 105_000 },
    },
    monotonicNs: () => nowNs,
    afterMonitor: () => { nowNs = 111_000_000_000n; },
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
    nowNs = BigInt(input.deadlineMonotonicNs) + 1n;
    return result;
  };
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(restored.status, "restore_failed");
  assert.match(restored.primaryError, /deadline|reserve|budget/i);
  assert.equal(fixture.calls.some((call) => call.kind === "capture"), false);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "finalProcess").length, 1);
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

test("failed prepare compensation owns or releases the serial only after auditable proof", async (t) => {
  const capabilityFailure = {
    ok: false,
    code: "capability_unavailable",
    detail: "capability stage fault",
    primaryError: "capability stage fault",
    cleanupError: null,
    actionReceipts: [],
    evidenceCeiling: "structural",
  };

  await t.test("target cleanup failure quarantines sequential prepare", async (t) => {
    const fixture = await createPreparedFixture(t, {
      capability: capabilityFailure,
      stopError: { reason: "prepare_failure_cleanup", message: "force-stop cleanup fault" },
    });
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
    const failed = await orchestrator.execute(fixture.input);
    assert.equal(failed.status, "preparation_failed");
    assert.match(failed.cleanupError, /force-stop cleanup fault/i);
    const action = JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim());
    assert.deepEqual(action.observedPriorForeground, { component: null, packageName: null, userInstalled: false });
    assert.equal(action.compensation.targetStop.status, "failed");
    assert.deepEqual(action.compensation.finalProcessProof.targetPids, [],
      "an absent snapshot cannot supersede the failed prepare cleanup barrier");
    assert.equal(action.serialLease.status, "quarantined");
    await assert.rejects(orchestrator.execute({
      ...fixture.input,
      artifactRoot: externalArtifactRoot(t, "target-cleanup-quarantine"),
    }), /serial.*(?:quarantin|owned|recovery)|(?:quarantin|owned|recovery).*serial/i);
  });

  await t.test("required prior relaunch failure quarantines sequential prepare", async (t) => {
    const component = "com.prior.unbound/.MainActivity";
    const fixture = await createPreparedFixture(t, {
      inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
      priorSnapshot: { component, packageName: "com.prior.unbound", userInstalled: true },
      capability: capabilityFailure,
      relaunchResult: {
        disposition: "accepted",
        component,
        outputSha256: sha256("Status: ok\n"),
        activityProbeSha256: sha256("topResumedActivity=com.other/.Main\n"),
        resumedComponents: ["com.other/.Main"],
      },
    });
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
    const failed = await orchestrator.execute(fixture.input);
    assert.equal(failed.status, "preparation_failed");
    assert.match(failed.cleanupError, /relaunch|resumed|component/i);
    const action = JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim());
    assert.equal(action.compensation.priorRelaunch.disposition, "accepted");
    assert.equal(action.serialLease.status, "quarantined");
    await assert.rejects(orchestrator.execute({
      ...fixture.input,
      artifactRoot: externalArtifactRoot(t, "prior-relaunch-quarantine"),
    }), /serial.*(?:quarantin|owned|recovery)|(?:quarantin|owned|recovery).*serial/i);
  });

  await t.test("failure audit fault quarantines even after otherwise successful compensation", async (t) => {
    const fixture = await createPreparedFixture(t, { capability: capabilityFailure });
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
      beforeActionAppendOpen({ action, status }) {
        if (action === "prepare" && status === "failed") throw new Error("failure audit unavailable");
      },
    });
    const failed = await orchestrator.execute(fixture.input);
    assert.equal(failed.status, "preparation_failed");
    assert.match(failed.cleanupError, /failure audit unavailable/i);
    await assert.rejects(orchestrator.execute({
      ...fixture.input,
      artifactRoot: externalArtifactRoot(t, "failure-audit-quarantine"),
    }), /serial.*(?:quarantin|owned|audit)|(?:quarantin|owned|audit).*serial/i);
  });

  await t.test("bracket failure records compensation and releases only after complete proof", async (t) => {
    const fixture = await createPreparedFixture(t);
    const originalLogs = fixture.dependencies.collectStepLogs;
    let failOnce = true;
    fixture.dependencies.collectStepLogs = async (context) => {
      if (failOnce && context.beginMarker.endsWith("_PREPARE_BEGIN")) {
        failOnce = false;
        throw new Error("prepare bracket collection fault");
      }
      return originalLogs(context);
    };
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
    const failed = await orchestrator.execute(fixture.input);
    assert.equal(failed.status, "preparation_failed");
    const action = JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim());
    assert.equal(action.compensation.targetStop.status, "stop_command_completed");
    assert.equal(action.compensation.finalProcessProof.targetPids.length, 0);
    assert.equal(action.serialLease.status, "release_eligible_after_action_publication");
    const retry = await orchestrator.execute({
      ...fixture.input,
      artifactRoot: externalArtifactRoot(t, "bracket-compensated-retry"),
    });
    assert.equal(retry.status, "needs_baseline_review");
  });
});

test("prepare failure cleanup spends the reserved recovery envelope instead of an expired prepare deadline", async (t) => {
  let nowNs = 0n;
  const fixture = await createPreparedFixture(t, { monotonicNs: () => nowNs });
  fixture.dependencies.probeCapability = async (input) => {
    fixture.calls.push({ kind: "capability", input });
    nowNs = 91_000_000_000n;
    return {
      ok: false, code: "capability_unavailable", detail: "late capability failure", primaryError: "late capability failure",
      cleanupError: null, actionReceipts: [], evidenceCeiling: "structural",
    };
  };
  const failed = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(failed.status, "preparation_failed");
  const cleanup = fixture.calls.find((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup");
  assert.ok(cleanup.context.timeoutMs >= 1_000, `cleanup timeout was ${cleanup.context.timeoutMs}`);
  assert.ok(cleanup.context.timeoutMs <= 89_000);
});

test("restore revalidates live continuity and capability before any zero-offset mutation", async (t) => {
  const cases = [
    ["boot", (sample) => ({ ...sample, bootId: "ffffffff-ffff-4fff-8fff-ffffffffffff" })],
    ["PID start", (sample) => ({ ...sample, pid: sample.pid + 1, pidStartTicks: "999999999" })],
    ["foreground", (sample) => ({ ...sample, resumedComponents: ["com.picoxr.launcher/.Launcher"], foreground: "different_package" })],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t);
      fixture.dependencies.sampleContinuity = async (context) => {
        fixture.calls.push({ kind: "continuity", context });
        return mutate(exactContinuity(fixture.input, fixture.applicationBinding, fixture.bootId));
      };
      fixture.calls.length = 0;
      const restored = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(fixture.baselineReview),
      });
      assert.equal(restored.status, "restore_failed");
      assert.match(restored.primaryError, /binding|continuity|boot|PID|foreground/i);
      assert.equal(fixture.calls.some((call) => call.kind === "locomote"), false);
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "restore_run_owned_target").length, 1);
    });
  }
});

test("a same-generation replacement process/root incarnation is rejected in step and restore", async (t) => {
  const stepFixture = await prepareForSteps(t);
  const originalHmd = stepFixture.dependencies.requestHmdPose;
  stepFixture.dependencies.requestHmdPose = async (input) => {
    const result = await originalHmd(input);
    return result.ok ? { ...result, ack: { ...result.ack, root: { ...result.ack.root, incarnation: REPLACEMENT_INCARNATION } } } : result;
  };
  const stepped = await stepFixture.orchestrator.execute(stepRequest(stepFixture, reviewFor(stepFixture.baselineReview)));
  assert.equal(stepped.status, "stopped");
  assert.match(stepped.primaryError, /incarnation|producer identity/i);
  assert.equal(stepFixture.calls.some((call) => call.kind === "locomote"), false);

  const restoreFixture = await prepareForSteps(t);
  restoreFixture.dependencies.probeCapability = async (input) => {
    restoreFixture.calls.push({ kind: "capability", input });
    return {
      ok: true,
      ack: {
        ...restoreFixture.capabilityAck,
        requestId: input.requestId,
        tag: input.tag,
        root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: REPLACEMENT_INCARNATION },
      },
      primaryError: null,
      cleanupError: null,
      actionReceipts: [],
      evidenceCeiling: "structural",
    };
  };
  restoreFixture.calls.length = 0;
  const restored = await restoreFixture.orchestrator.execute({
    action: "restore",
    runId: restoreFixture.prepared.runId,
    reviewedPriorFrame: reviewFor(restoreFixture.baselineReview),
  });
  assert.equal(restored.status, "restore_failed");
  assert.match(restored.primaryError, /incarnation|producer identity/i);
  assert.equal(restoreFixture.calls.some((call) => call.kind === "locomote"), false);
});

test("fresh-launch evidence uses PREPARE_BEGIN and binds every raw health/window artifact", async (t) => {
  const fixture = await createPreparedFixture(t);
  const prepared = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(prepared.status, "needs_baseline_review");
  const marker = fixture.calls.find((call) => call.kind === "marker").context.marker;
  const monitorContext = fixture.calls.find((call) => call.kind === "monitor").context;
  assert.equal(monitorContext.healthBoundaryMarker, marker);
  const action = JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim());
  assert.equal(action.freshLaunchMonitor.healthBoundaryMarker, marker);
  assert.equal(action.freshLaunchMonitor.rawWindowDumps.length, action.freshLaunchMonitor.samples.length);
  action.freshLaunchMonitor.samples.forEach((sample, index) => {
    assert.equal(sample.runtimeHealth.sourceSha256, action.freshLaunchMonitor.rawHealthLogs[index].sha256);
    assert.equal(sample.runtimeHealth.marker, marker);
    assert.equal(sample.runtimeHealth.packageName, fixture.input.scenario.packageName);
    assert.deepEqual(sample.runtimeHealth.expectedPids, [fixture.applicationBinding.pid]);
  });
});

test("fresh-launch source substitution and later raw-window tampering fail before mutation", async (t) => {
  const substituted = await createPreparedFixture(t, {
    afterMonitor(receipt) {
      receipt.samples[0].runtimeHealth.sourceSha256 = "f".repeat(64);
    },
  });
  const rejected = await createInAppLocomotionOrchestrator(substituted.dependencies).execute(substituted.input);
  assert.equal(rejected.status, "preparation_failed");
  assert.match(rejected.primaryError, /source|health|sha|binding/i);

  const tampered = await prepareForSteps(t);
  fs.writeFileSync(tampered.windowDumps[0].path, "substituted window bytes\n");
  tampered.calls.length = 0;
  await assert.rejects(tampered.orchestrator.execute(stepRequest(
    tampered,
    reviewFor(tampered.baselineReview),
  )), /window|dialog|immutable|changed|evidence/i);
  assert.equal(tampered.calls.some((call) => call.kind === "marker" || call.kind === "locomote"), false);
});

test("universal final process/activity proof blocks lease release after false-success stop", async (t) => {
  const policies = [
    ["none", { kind: "none" }, undefined],
    ["receipt-bound", { kind: "receipt_bound", component: "com.prior.receipted/.MainActivity", receiptId: "c".repeat(64) }, { component: "com.prior.receipted/.MainActivity", packageName: "com.prior.receipted", userInstalled: true }],
    ["non-receipt", { kind: "non_receipt_bound", component: "com.prior.unbound/.MainActivity" }, { component: "com.prior.unbound/.MainActivity", packageName: "com.prior.unbound", userInstalled: true }],
  ];
  for (const [label, priorForeground, priorSnapshot] of policies) {
    await t.test(label, async (t) => {
      const fixtureOptions = {
        inputOverrides: { priorForeground },
        ...(priorSnapshot ? { priorSnapshot } : {}),
        finalTargetPresent: true,
      };
      const fixture = await prepareForSteps(t, fixtureOptions);
      fixture.calls.length = 0;
      const restored = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(fixture.baselineReview),
      });
      assert.equal(restored.status, "restore_failed");
      assert.match(restored.cleanupError, /target.*(?:present|running|resumed)|final.*proof/i);
      assert.equal(fixture.calls.filter((call) => call.kind === "finalProcess").length, 1);
      if (label === "non-receipt") {
        assert.equal(fixture.calls.some((call) => call.kind === "relaunchPrior"), false,
          "a command-completed stop receipt cannot authorize prior relaunch before target absence is observed");
      }
      const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
      assert.deepEqual(action.finalProcessProof.targetPids, [fixture.applicationBinding.pid]);
      await assert.rejects(fixture.orchestrator.execute({
        ...fixture.input,
        artifactRoot: externalArtifactRoot(t, `false-stop-${label}`),
      }), /serial.*(?:owned|quarantin|restore)|(?:owned|quarantin|restore).*serial/i);

      fixtureOptions.finalTargetPresent = false;
      fixtureOptions.finalResumedComponents = priorForeground.kind === "non_receipt_bound"
        ? [priorForeground.component]
        : ["com.picoxr.launcher/.Launcher"];
      fixture.calls.length = 0;
      const retried = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(restored.requiredReview[0]),
      });
      assert.equal(retried.status, "restored_needs_review", JSON.stringify(retried));
      assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1,
        "authoritative target-presence proof must re-arm an exact stop on retry");
    });
  }
});

test("clock faults do not consume waypoints, mask primary errors, or bypass restore cleanup", async (t) => {
  await t.test("step start clock is retryable without consuming the waypoint", async (t) => {
    const fixture = await prepareForSteps(t);
    fixture.dependencies.monotonicNs = () => { throw new Error("step start clock fault"); };
    await assert.rejects(fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview))), /clock fault/i);
    let tick = 10_000_000_000n;
    fixture.dependencies.monotonicNs = () => ++tick;
    const retried = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
    assert.equal(retried.waypointSeq, 1);
    assert.equal(retried.usage.waypointAttempts, 1);
  });

  await t.test("step end clock retains the earlier safety primary and refuses an unfenced ledger entry", async (t) => {
    const fixture = await prepareForSteps(t);
    fixture.dependencies.sampleSafety = async (context) => {
      fixture.calls.push({ kind: "safety", context });
      return { ...cleanSafety, guardian: "0" };
    };
    const originalLogs = fixture.dependencies.collectStepLogs;
    let failClock = false;
    fixture.dependencies.collectStepLogs = async (context) => {
      const value = await originalLogs(context);
      if (!context.beginMarker.endsWith("_PREPARE_BEGIN")) failClock = true;
      return value;
    };
    let tick = 20_000_000_000n;
    fixture.dependencies.monotonicNs = () => {
      if (failClock) throw new Error("step end clock fault");
      return ++tick;
    };
    const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
    assert.equal(stopped.status, "stopped");
    assert.match(stopped.primaryError, /Guardian|safety/i);
    assert.match(stopped.cleanupError, /clock fault/i);
    const stepActions = committedActionPayloads(fixture.input.artifactRoot).filter((entry) => entry.action === "step");
    assert.equal(stepActions.length, 0);
  });

  await t.test("restore entry clock fault leaves retryable cleanup ownership", async (t) => {
    const fixture = await prepareForSteps(t);
    let clockFails = true;
    let tick = 30_000_000_000n;
    fixture.dependencies.monotonicNs = () => {
      if (clockFails) throw new Error("restore start clock fault");
      return ++tick;
    };
    const request = { action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview) };
    const restored = await fixture.orchestrator.execute(request);
    assert.equal(restored.status, "restore_failed");
    assert.match(`${restored.primaryError} ${restored.cleanupError}`, /clock fault/i);
    assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
    assert.equal(fixture.calls.filter((call) => call.kind === "finalProcess").length, 1);
    assert.equal(fixture.calls.filter((call) => call.kind === "safety").length, 1);
    clockFails = false;
    fixture.calls.length = 0;
    const retried = await fixture.orchestrator.execute(request);
    assert.equal(retried.status, "restored_needs_review");
    assert.equal(retried.primaryError, null);
    assert.equal(fixture.calls.some((call) => call.kind === "stop"), false,
      "retry must retain the first attempt's proven target stop");
  });

  await t.test("restore clock fault after transaction start performs cleanup but refuses an unfenced ledger", async (t) => {
    const fixture = await prepareForSteps(t);
    let failClock = false;
    fixture.dependencies.sampleContinuity = async (context) => {
      fixture.calls.push({ kind: "continuity", context });
      failClock = true;
      return exactContinuity(fixture.input, fixture.applicationBinding, fixture.bootId);
    };
    let tick = 40_000_000_000n;
    fixture.dependencies.monotonicNs = () => {
      if (failClock) throw new Error("restore transaction clock fault");
      return ++tick;
    };
    fixture.calls.length = 0;
    const restored = await fixture.orchestrator.execute({
      action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
    });
    assert.equal(restored.status, "restore_failed");
    assert.match(restored.primaryError, /clock fault/i);
    assert.equal(fixture.calls.some((call) => call.kind === "locomote"), false);
    assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "restore_run_owned_target").length, 1);
    const restoreActions = committedActionPayloads(fixture.input.artifactRoot).filter((entry) => entry.action === "restore");
    assert.equal(restoreActions.length, 0);
  });
});

test("a successful receipt-bound incumbent stop is recorded stale before a post-await clock fault", async (t) => {
  const component = "com.prior.receipted/.MainActivity";
  const fixture = await createPreparedFixture(t, {
    inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "c".repeat(64) } },
    priorSnapshot: { component, packageName: "com.prior.receipted", userInstalled: true },
  });
  let failNextClock = false;
  let tick = 80_000_000_000n;
  fixture.dependencies.monotonicNs = () => {
    if (failNextClock) {
      failNextClock = false;
      throw new Error("post-incumbent-stop clock fault");
    }
    return ++tick;
  };
  const originalStop = fixture.dependencies.stopPackage;
  fixture.dependencies.stopPackage = async (context) => {
    const receipt = await originalStop(context);
    if (context.reason === "prepare_declared_incumbent_clearance") failNextClock = true;
    return receipt;
  };

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /post-incumbent-stop clock fault/i);
  assert.equal(fixture.calls.some((call) => call.kind === "relaunchPrior"), false);
  const action = JSON.parse(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8").trim());
  assert.equal(action.priorForeground.receiptFreshness, "known_stale");
  assert.equal(action.priorForeground.relaunchDisposition, "withheld_receipt_bound");
});

test("fixed phase deadline rejects an operation that completes exactly one nanosecond late", async (t) => {
  const fixture = await createPreparedFixture(t);
  let nowNs = 0n;
  fixture.dependencies.monotonicNs = () => nowNs;
  fixture.dependencies.snapshotPriorForeground = async (context) => {
    fixture.calls.push({ kind: "snapshotPrior", context });
    nowNs = BigInt(context.deadlineMonotonicNs) + 1n;
    return { component: null, packageName: null, userInstalled: false };
  };

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /prior foreground snapshot exceeded its fixed phase deadline/i);
  assert.equal(fixture.calls.some((call) => call.kind === "marker"), false,
    "no later strict effect may be admitted after the one-nanosecond overrun");
});

test("capture completion one nanosecond past its route phase retains the returned receipt and fence but cannot publish it", async (t) => {
  let nowNs = 0n;
  const fixture = await createPreparedFixture(t, { monotonicNs: () => nowNs });
  const originalCapture = fixture.dependencies.captureSettled;
  fixture.dependencies.captureSettled = async (input) => {
    const captured = await originalCapture(input);
    const phaseDeadline = fixture.calls.find((call) => call.kind === "monitor").context.deadlineMonotonicNs;
    nowNs = BigInt(phaseDeadline) + 1n;
    return captured;
  };

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /baseline settled capture exceeded its fixed phase deadline/i);
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(action.captureReceipt.status, "settled");
  assert.equal(
    BigInt(action.captureInvocation.completedAtMonotonicNs),
    BigInt(action.captureInvocation.phaseDeadlineMonotonicNs) + 1n,
  );
  assert.deepEqual(result.requiredReview, []);
});

test("action ledger staging failures are atomic and cannot strand movement cleanup", async (t) => {
  for (const [label, hook] of [
    ["partial write", {
      writeActionStage({ action, descriptor, bytes }) {
        if (action !== "step") return false;
        fs.writeSync(descriptor, bytes, 0, Math.max(1, Math.floor(bytes.length / 2)), 0);
        throw new Error("injected partial stage write");
      },
    }],
    ["fsync", {
      beforeActionStageFsync({ action }) {
        if (action === "step") throw new Error("injected stage fsync fault");
      },
    }],
  ]) {
    await t.test(label, async (t) => {
      const fixture = await createPreparedFixture(t);
      const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, hook);
      const prepared = await orchestrator.execute(fixture.input);
      const before = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"));
      const stopped = await orchestrator.execute(stepRequest({ ...fixture, prepared }, reviewFor(prepared.requiredReview[0])));
      assert.equal(stopped.status, "stopped");
      assert.match(stopped.primaryError, /partial stage write|stage fsync fault/i);
      assert.deepEqual(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl")), before);
      const restored = await orchestrator.execute({
        action: "restore", runId: prepared.runId, reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
      });
      assert.equal(restored.status, "restored_needs_review");
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "restore_run_owned_target").length, 1);
    });
  }
});

test("shared artifact identity rejects a pathname swap after descriptor bytes were read", async (t) => {
  const fixture = await createPreparedFixture(t);
  let armed = false;
  let swapped = false;
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    afterArtifactReadBeforePathRecheck({ path: artifactPath, label }) {
      if (!armed || swapped || label !== "run manifest") return;
      swapped = true;
      const replacement = fs.readFileSync(artifactPath);
      fs.renameSync(artifactPath, `${artifactPath}.opened-original`);
      fs.writeFileSync(artifactPath, replacement, { flag: "wx", mode: 0o600 });
    },
  });
  const prepared = await orchestrator.execute(fixture.input);
  armed = true;
  fixture.calls.length = 0;
  await assert.rejects(orchestrator.execute(stepRequest(
    { ...fixture, prepared },
    reviewFor(prepared.requiredReview[0]),
  )), /path|identity|changed|manifest/i);
  assert.equal(fixture.calls.some((call) => call.kind === "marker" || call.kind === "locomote"), false);
});

test("a post-stage derived-view pathname swap is atomically repaired without reversing the committed step", async (t) => {
  const fixture = await createPreparedFixture(t);
  let swapped = false;
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    beforeActionPublish({ action, path: actionPath }) {
      if (action !== "step" || swapped) return;
      swapped = true;
      const bytes = fs.readFileSync(actionPath);
      fs.renameSync(actionPath, `${actionPath}.publication-original`);
      fs.writeFileSync(actionPath, bytes, { flag: "wx", mode: 0o600 });
    },
  });
  const prepared = await orchestrator.execute(fixture.input);
  const stopped = await orchestrator.execute(stepRequest({ ...fixture, prepared }, reviewFor(prepared.requiredReview[0])));
  assert.equal(stopped.status, "needs_waypoint_review");
  assert.equal(stopped.primaryError, null);
  assert.equal(stopped.actionAuditMaintenance.status, "repair_pending");
  fixture.calls.length = 0;
  const restored = await orchestrator.execute({
    action: "restore", runId: prepared.runId, reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review");
  assert.equal(restored.primaryError, null);
  assert.equal(restored.actionAuditMaintenance.status, "repair_pending");
  const adjudicated = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    frameAttestations: attestationsFor([
      prepared.requiredReview[0], stopped.requiredReview[0], restored.requiredReview[0],
    ]),
  });
  assert.equal(adjudicated.status, "structural_complete");
  assert.equal(adjudicated.actionAuditMaintenance.status, "current");
  assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "restore_run_owned_target").length, 1);
});

test("expected moved-frame corruption cannot be relabeled restored after cleanup stops the target", async (t) => {
  for (const [mechanism, damage] of [
    ["direct", "corrupt"],
    ["replacement", "delete"],
  ]) {
    await t.test(`${mechanism} ${damage}`, async (t) => {
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
      });
      const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
      assert.equal(stepped.status, "needs_waypoint_review");
      const moved = stepped.requiredReview[0];
      const originalMoved = fs.readFileSync(moved.path);
      if (damage === "corrupt") fs.writeFileSync(moved.path, makePng(117));
      else fs.unlinkSync(moved.path);
      fixture.calls.length = 0;

      const restored = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(moved),
      });

      assert.equal(restored.status, "restore_failed");
      assert.match(restored.primaryError, /retained|image|artifact|sha256|missing/i);
      assert.deepEqual(restored.requiredReview, [], "a known-corrupt PNG must never be re-embedded");
      assert.equal(fixture.calls.some((call) => call.kind === "locomote"), false);
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "restore_run_owned_target").length, 1);
      assert.equal(fixture.calls.filter((call) => call.kind === "finalProcess").length, 1);
      assert.equal(fixture.calls.filter((call) => call.kind === "safety").length, 1);
      fs.writeFileSync(moved.path, originalMoved);
      fixture.calls.length = 0;
      const retried = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(moved),
      });
      assert.equal(retried.status, "restore_failed");
      assert.match(retried.primaryError, /zero|restoration.*unproven|moved.*frame/i);
      assert.equal(retried.requiredReview[0].captureSha256, moved.captureSha256);
      assert.equal(retried.requiredReview[0].role, "waypoint");
      assert.equal(fixture.calls.some((call) => call.kind === "locomote" || call.kind === "stop"), false,
        "retry stays cleanup-only without inventing a zero-offset mutation");
    });
  }
});

test("post-launch window evidence is captured before runtime probes and rejects a transient dialog", async (t) => {
  const fixture = await createPreparedFixture(t, {
    launchHandoffWindowText: "WINDOW MANAGER WINDOWS\nmCurrentFocus=Application Error: com.test.fullworld\n",
    launchHandoffDialogs: [],
  });
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /dialog|window|handoff/i);
  const kinds = fixture.calls.map((call) => call.kind);
  assert.ok(kinds.indexOf("launchObservation") === kinds.indexOf("launch") + 1);
  assert.ok(kinds.indexOf("launchWindow") === kinds.indexOf("launchObservation") + 1);
  assert.equal(kinds.includes("probeRuntime"), false, "dialog proof must gate later multi-command preflights");
  assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
});

test("fresh-launch health claims are reproduced from exact descriptor bytes", async (t) => {
  for (const [label, body] of [
    ["attributed crash", (marker) => `${marker}\n09-02 12:00:00.000  5151  5151 E AndroidRuntime: FATAL EXCEPTION: main\nProcess: com.test.fullworld, PID: 5151\n`],
    ["duplicate marker", (marker) => `${marker}\n${marker}\nfresh launch sample\n`],
  ]) {
    await t.test(label, async (t) => {
      const fixture = await createPreparedFixture(t, {
        monitorLogBodyFactory: (marker, sampleIndex) => sampleIndex === 0
          ? body(marker)
          : `${marker}\nfresh launch sample ${sampleIndex}\n`,
      });
      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "preparation_failed");
      assert.match(result.primaryError, /runtime-health|health|marker|incident|claim|reproduce/i);
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
    });
  }
});

test("step bracket counters and boundary claims are reproduced from retained bytes", async (t) => {
  const fixture = await prepareForSteps(t, {
    stepLogLines: ["09-02 I Spatial: container info changed for stage"],
    stepBoundarySignals: {
      setSpatialContainerBoundary: 0,
      containerInfoChanged: 0,
      boundaryMin: 0,
      launcherResume: 0,
      appPauseOrEjection: 0,
    },
  });
  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stopped.status, "stopped");
  assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /boundary|container|log|reproduce|claim/i);
});

function rewriteSameInodeSameLength(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.ok(bytes.length > 0);
  const changed = Buffer.from(bytes);
  const index = Math.max(0, changed.length - 2);
  changed[index] = changed[index] === 0x78 ? 0x79 : 0x78;
  const descriptor = fs.openSync(filePath, "r+");
  try {
    fs.writeSync(descriptor, changed, 0, changed.length, 0);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

test("descriptor evidence resampling rejects same-inode same-length rewrites before mutation", async (t) => {
  for (const targetLabel of ["run manifest", "fresh-launch runtime-health log 1"]) {
    await t.test(targetLabel, async (t) => {
      const fixture = await createPreparedFixture(t);
      let armed = false;
      let rewritten = false;
      const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
        afterArtifactReadBeforePathRecheck({ path: artifactPath, label }) {
          if (!armed || rewritten || label !== targetLabel) return;
          rewritten = true;
          rewriteSameInodeSameLength(artifactPath);
        },
      });
      const prepared = await orchestrator.execute(fixture.input);
      armed = true;
      fixture.calls.length = 0;
      await assert.rejects(orchestrator.execute(stepRequest(
        { ...fixture, prepared },
        reviewFor(prepared.requiredReview[0]),
      )), /descriptor|bytes|identity|changed|immutable/i);
      assert.equal(fixture.calls.some((call) => call.kind === "marker" || call.kind === "locomote"), false);
    });
  }
});

test("same-inode derived-view rewrite is reported, repaired, and keeps committed movement reachable", async (t) => {
  const fixture = await createPreparedFixture(t);
  let actionAppend = false;
  let rewritten = false;
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    beforeActionAppendOpen({ action }) {
      if (action === "step") actionAppend = true;
    },
    afterArtifactReadBeforePathRecheck({ path: artifactPath, label }) {
      if (!actionAppend || rewritten || label !== "action JSONL") return;
      rewritten = true;
      rewriteSameInodeSameLength(artifactPath);
    },
  });
  const prepared = await orchestrator.execute(fixture.input);
  const stopped = await orchestrator.execute(stepRequest(
    { ...fixture, prepared },
    reviewFor(prepared.requiredReview[0]),
  ));
  assert.equal(stopped.status, "needs_waypoint_review");
  assert.equal(stopped.primaryError, null);
  assert.equal(stopped.actionAuditMaintenance.status, "repair_pending");
  assert.equal(rewritten, false, "the fenced commit performs no post-link derived-view read");
  fixture.calls.length = 0;
  const restored = await orchestrator.execute({
    action: "restore", runId: prepared.runId, reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.status, "restored_needs_review");
  assert.equal(rewritten, true);
  assert.equal(restored.actionAuditMaintenance.status, "repair_pending");
  assert.match(restored.actionAuditMaintenance.errors.join(" "), /action|descriptor|bytes|identity|changed/i);
  const adjudicated = await orchestrator.execute({
    action: "adjudicate",
    runId: prepared.runId,
    frameAttestations: attestationsFor([
      prepared.requiredReview[0], stopped.requiredReview[0], restored.requiredReview[0],
    ]),
  });
  assert.equal(adjudicated.status, "structural_complete");
  assert.equal(adjudicated.actionAuditMaintenance.status, "current");
  assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "restore_run_owned_target").length, 1);
});

test("an emergency stop command defers nonce cleanup until restore proves target absence", async (t) => {
  const fixture = await prepareForSteps(t, {
    locomotionResult: (input) => ({
      ok: false,
      code: "bridge_unavailable",
      detail: "terminal locomotion acknowledgement timed out",
      primaryError: "terminal locomotion acknowledgement timed out",
      cleanupError: "guest cancellation acknowledgement did not stabilize",
      motionQuiesced: false,
      nonceCleanup: {
        ...routeOwnedNonceDisposition(input),
        status: "deferred_until_stop",
      },
      actionReceipts: [],
      evidenceCeiling: "structural",
    }),
  });
  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.primaryError, /acknowledgement timed out/i);
  assert.match(stopped.cleanupError, /cancellation acknowledgement/i);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "step_unquiesced_locomotion").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup").length, 0,
    "a command-completed force-stop is not process-absence proof");
  const stepAction = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.deepEqual(stepAction.emergencyStop, {
    attempted: true,
    stopCommandReceipt: completedStopReceipt({
      serial: fixture.input.serial,
      packageName: fixture.input.scenario.packageName,
      reason: "step_unquiesced_locomotion",
    }),
    targetAbsenceProven: false,
    error: null,
  });
  assert.equal(stepAction.locomotionNonceCleanup, null);

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.status, "restore_failed");
  assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
  assert.match(restored.primaryError, /zero-offset|restoration/i);
  assert.equal(restored.cleanupError, null);
  assert.deepEqual(restored.requiredReview, [fixture.baselineReview],
    "the retained baseline remains reviewable but is not relabeled as a post-mutation zero proof");
  assert.equal(fixture.calls.some((call) => call.kind === "locomote"), false);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "restore_unquiesced_target").length, 1);
  const finalProcessIndex = fixture.calls.findIndex((call) => call.kind === "finalProcess");
  const nonceCleanupIndex = fixture.calls.findIndex((call) => call.kind === "nonceCleanup");
  assert.ok(finalProcessIndex >= 0 && nonceCleanupIndex > finalProcessIndex,
    "only the authoritative absence proof may authorize stopped-process nonce cleanup");
  assert.equal(fixture.calls[nonceCleanupIndex].context.processStopped, true);
  assert.equal(fixture.calls.some((call) => call.kind === "safety"), true);
});

test("a moved emergency stop converges to an idempotent safe release without claiming zero restoration", async (t) => {
  const fixture = await prepareForSteps(t);
  const first = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(first.status, "needs_waypoint_review");
  fixture.dependencies.requestLocomotion = async (input) => {
    fixture.calls.push({ kind: "locomote", input });
    return deferredUnquiescedResult(input);
  };
  fixture.calls.length = 0;

  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(first.requiredReview[0]), 1));
  assert.equal(stopped.status, "stopped");
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup").length, 0);

  fixture.calls.length = 0;
  const restoreRequest = {
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  };
  const released = await fixture.orchestrator.execute(restoreRequest);
  assert.equal(released.status, "restore_failed");
  assert.equal(released.restorationDisposition, "safe_release_without_zero_proof");
  assert.match(released.primaryError, /zero-offset|restoration/i);
  assert.equal(released.cleanupError, null);
  assert.deepEqual(released.requiredReview, [first.requiredReview[0]],
    "the moved frame remains the exact review; it is never relabeled as zero");
  const finalProcessIndex = fixture.calls.findIndex((call) => call.kind === "finalProcess");
  const nonceCleanupIndex = fixture.calls.findIndex((call) => call.kind === "nonceCleanup");
  assert.ok(finalProcessIndex >= 0 && nonceCleanupIndex > finalProcessIndex);
  assert.equal(fixture.calls[nonceCleanupIndex].context.processStopped, true);
  assert.equal(fixture.calls.some((call) => call.kind === "capture" || call.kind === "locomote"), false);

  const terminalAction = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.equal(terminalAction.action, "restore");
  assert.equal(terminalAction.status, "failed");
  assert.equal(terminalAction.safeReleaseEligibility, "eligible_after_action_publication");

  const secondInput = { ...fixture.input, artifactRoot: externalArtifactRoot(t, "after-safe-release") };
  const second = await fixture.orchestrator.execute(secondInput);
  assert.equal(second.status, "needs_baseline_review", "exact serial is released after safe terminal audit publication");

  fixture.calls.length = 0;
  const repeated = await fixture.orchestrator.execute(restoreRequest);
  assert.equal(repeated.status, "restore_failed");
  assert.equal(repeated.restorationDisposition, "safe_release_without_zero_proof");
  assert.equal(deviceCalls(fixture.calls).length, 0,
    "terminal safe-release replay validates artifacts but never touches a serial now owned by another run");
  await assert.rejects(fixture.orchestrator.execute({
    action: "adjudicate",
    runId: fixture.prepared.runId,
    frameAttestations: attestationsFor([first.requiredReview[0]]),
  }), /completed restore/i);
});

test("pre-link safe-release audit failure keeps the serial quarantined until a fenced retry", async (t) => {
  const fixture = await createPreparedFixture(t, { locomotionResult: deferredUnquiescedResult });
  let nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  let restoreActionDeadlineNs = null;
  const safety = fixture.dependencies.sampleSafety;
  fixture.dependencies.sampleSafety = async (context) => {
    const result = await safety(context);
    if (context.phase === "restore_after_prior_disposition") {
      restoreActionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
    }
    return result;
  };
  let expireFirstRestore = true;
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    beforeActionRecordCommit({ action }) {
      if (action === "restore" && expireFirstRestore) {
        assert.ok(restoreActionDeadlineNs !== null);
        nowNs = restoreActionDeadlineNs;
        expireFirstRestore = false;
      }
    },
  });
  const prepared = await orchestrator.execute(fixture.input);
  const stopped = await orchestrator.execute(stepRequest(
    { ...fixture, prepared }, reviewFor(prepared.requiredReview[0]),
  ));
  assert.equal(stopped.status, "stopped");

  const restoreRequest = {
    action: "restore",
    runId: prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  };
  fixture.calls.length = 0;
  const first = await orchestrator.execute(restoreRequest);
  assert.equal(first.status, "restore_failed");
  assert.equal(first.restorationDisposition, "unresolved");
  assert.match(first.cleanupError, /restore action.*deadline/i);
  assert.equal(committedActionPayloads(fixture.input.artifactRoot).some((entry) => entry.action === "restore"), false);

  const secondInput = { ...fixture.input, artifactRoot: externalArtifactRoot(t, "pre-link-safe-release-quarantine") };
  await assert.rejects(orchestrator.execute(secondInput), /serial.*(?:owned|quarantin|restore)|(?:owned|quarantin|restore).*serial/i);

  fixture.calls.length = 0;
  const retried = await orchestrator.execute({
    ...restoreRequest,
    reviewedPriorFrame: reviewFor(first.requiredReview[0]),
  });
  assert.equal(retried.restorationDisposition, "safe_release_without_zero_proof");
  assert.deepEqual(deviceCalls(fixture.calls).map((call) => call.kind), ["finalProcess", "safety"]);
  const second = await orchestrator.execute(secondInput);
  assert.equal(second.status, "needs_baseline_review");

  fixture.calls.length = 0;
  const replayed = await orchestrator.execute(restoreRequest);
  assert.equal(replayed.restorationDisposition, "safe_release_without_zero_proof");
  assert.equal(deviceCalls(fixture.calls).length, 0);
});

test("post-link safe-release publication failure cannot release before a later fenced action", async (t) => {
  const fixture = await createPreparedFixture(t, { locomotionResult: deferredUnquiescedResult });
  let nowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => nowNs++;
  let restoreActionDeadlineNs = null;
  const safety = fixture.dependencies.sampleSafety;
  fixture.dependencies.sampleSafety = async (context) => {
    const result = await safety(context);
    if (context.phase === "restore_after_prior_disposition") {
      restoreActionDeadlineNs = BigInt(context.deadlineMonotonicNs) + 5_001_000_000n;
    }
    return result;
  };
  const originalLinkSync = fs.linkSync;
  let expireFirstRestore = true;
  fs.linkSync = function linkThenExpire(source, target) {
    const result = originalLinkSync.apply(this, arguments);
    if (expireFirstRestore && path.basename(String(target)) === "000003.json") {
      assert.ok(restoreActionDeadlineNs !== null);
      nowNs = restoreActionDeadlineNs;
      expireFirstRestore = false;
    }
    return result;
  };
  t.after(() => { fs.linkSync = originalLinkSync; });
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
  const prepared = await orchestrator.execute(fixture.input);
  const stopped = await orchestrator.execute(stepRequest(
    { ...fixture, prepared }, reviewFor(prepared.requiredReview[0]),
  ));
  assert.equal(stopped.status, "stopped");

  const restoreRequest = {
    action: "restore",
    runId: prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  };
  fixture.calls.length = 0;
  const first = await orchestrator.execute(restoreRequest);
  assert.equal(first.status, "restore_failed");
  assert.equal(first.restorationDisposition, "unresolved");
  assert.match(first.cleanupError, /committed.*publication deadline.*unproven/i);
  const firstRestoreAction = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.equal(firstRestoreAction.action, "restore");
  assert.equal(firstRestoreAction.status, "failed");
  assert.equal(firstRestoreAction.safeReleaseEligibility, "eligible_after_action_publication");
  assert.equal(first.actionAuditMaintenance.status, "repair_pending");
  assert.equal(first.actionAuditMaintenance.publicationIncidents.at(-1).phase, "after_commit");

  const secondInput = { ...fixture.input, artifactRoot: externalArtifactRoot(t, "post-link-safe-release-quarantine") };
  await assert.rejects(orchestrator.execute(secondInput), /serial.*(?:owned|quarantin|restore)|(?:owned|quarantin|restore).*serial/i);

  fixture.calls.length = 0;
  const retried = await orchestrator.execute({
    ...restoreRequest,
    reviewedPriorFrame: reviewFor(first.requiredReview[0]),
  });
  assert.equal(retried.restorationDisposition, "safe_release_without_zero_proof");
  assert.deepEqual(deviceCalls(fixture.calls).map((call) => call.kind), ["finalProcess", "safety"]);
  const retryAction = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.equal(retryAction.restoreAttempt, 2);
  assert.equal(retryAction.priorActionAuditMaintenance.publicationIncidents.length, 1);
  const second = await orchestrator.execute(secondInput);
  assert.equal(second.status, "needs_baseline_review");

  fixture.calls.length = 0;
  const replayed = await orchestrator.execute(restoreRequest);
  assert.equal(replayed.restorationDisposition, "safe_release_without_zero_proof");
  assert.equal(deviceCalls(fixture.calls).length, 0);
});

test("persistent restore clock failure reaches the production cleanup-only force-stop runner", async (t) => {
  let clockFailed = false;
  let nowNs = 10_000_000_000n;
  const adbEffects = [];
  const live = worldLocomotion.createLiveInAppLocomotionDependencies({
    resolveAdb: () => "/fixture/injected-adb",
    monotonicNs: () => {
      if (clockFailed) throw new Error("persistent monotonic clock fault");
      return ++nowNs;
    },
    sleep: async () => {},
    runText: async (_cmd, args, options) => {
      adbEffects.push({ args, options });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
    runBytes: async () => { throw new Error("binary runner is unused"); },
  });
  const fixture = await prepareForSteps(t);
  const originalContinuity = fixture.dependencies.sampleContinuity;
  fixture.dependencies.sampleContinuity = async (context) => {
    const result = await originalContinuity(context);
    clockFailed = true;
    return result;
  };
  fixture.dependencies.monotonicNs = () => {
    if (clockFailed) throw new Error("persistent monotonic clock fault");
    return ++nowNs;
  };
  fixture.dependencies.stopPackage = live.stopPackage;
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });
  assert.equal(restored.status, "restore_failed");
  assert.match(`${restored.primaryError} ${restored.cleanupError}`, /clock fault/i);
  const forceStops = adbEffects.filter((effect) => effect.args.join(" ").includes("am force-stop com.test.fullworld"));
  assert.equal(forceStops.length, 1);
  assert.ok(forceStops[0].options.timeoutMs >= 1 && forceStops[0].options.timeoutMs <= 5_000);
});

test("the live final PID probe accepts only clean pidof exit 1 as target absence", async (t) => {
  const contextFor = (label) => {
    const artifactRoot = externalArtifactRoot(t, label);
    fs.mkdirSync(path.join(artifactRoot, "logs"), { recursive: true });
    return {
      serial: "emulator-5554",
      targetPackage: "com.test.fullworld",
      artifactRoot: fs.realpathSync(artifactRoot),
      evidenceId: label,
      priorForeground: { kind: "none" },
      timeoutMs: 10_000,
      deadlineMonotonicNs: "10000000000",
    };
  };
  const makeLive = (pidResult, calls) => {
    let nowNs = 1_000_000_000n;
    return worldLocomotion.createLiveInAppLocomotionDependencies({
      resolveAdb: () => "/fixture/injected-adb",
      monotonicNs: () => ++nowNs,
      sleep: async () => {},
      runText: async (_cmd, args) => {
        calls.push(args);
        if (args.includes("pidof")) return pidResult;
        return {
          code: 0,
          stdout: "mResumedActivity: ActivityRecord{fixture u0 com.picoxr.launcher/.Launcher t1}\n",
          stderr: "",
          timedOut: false,
        };
      },
      runBytes: async () => { throw new Error("binary runner is unused"); },
    });
  };

  const offlineCalls = [];
  const offline = makeLive({ code: 1, stdout: "", stderr: "adb: device offline", timedOut: false }, offlineCalls);
  await assert.rejects(offline.probeFinalProcessState(contextFor("pid-offline")), /PID probe.*device offline/i);
  assert.equal(offlineCalls.filter((args) => args.includes("dumpsys")).length, 0);

  for (const [label, pidResult] of [
    ["pid-zero-empty", { code: 0, stdout: "", stderr: "", timedOut: false }],
    ["pid-zero-stderr", { code: 0, stdout: "5151\n", stderr: "adb transport warning", timedOut: false }],
  ]) {
    const calls = [];
    const live = makeLive(pidResult, calls);
    await assert.rejects(live.probeFinalProcessState(contextFor(label)), /final target PID probe failed/i);
    assert.equal(calls.filter((args) => args.includes("dumpsys")).length, 0);
  }

  const absentCalls = [];
  const absent = makeLive({ code: 1, stdout: "", stderr: "", timedOut: false }, absentCalls);
  const receipt = await absent.probeFinalProcessState(contextFor("pid-clean-absent"));
  assert.deepEqual(receipt.targetPids, []);
  assert.deepEqual(receipt.resumedComponents, ["com.picoxr.launcher/.Launcher"]);
  assert.equal(absentCalls.filter((args) => args.includes("dumpsys")).length, 1);
});

const adb = "/fixture/adb";

const keptForUserLaunchOutput = "Starting: Intent { cmp=com.test.fullworld/.platform.LaunchActivity }\n"
  + "Warning: Activity not started because the  current activity is being kept for the user.\n"
  + "Status: ok\nLaunchState: UNKNOWN (0)\n";

function liveLaunchRetryFixture(results, onSleep = () => {}) {
  let nowNs = 0n;
  let index = 0;
  const effects = [];
  const live = worldLocomotion.createLiveInAppLocomotionDependencies({
    runBytes: async () => { throw new Error("binary runner is outside this fixture"); },
    resolveAdb: () => "/fixture/injected-adb",
    monotonicNs: () => nowNs,
    sleep: async (ms) => {
      effects.push({ kind: "sleep", at: nowNs, ms });
      nowNs += BigInt(ms) * 1_000_000n;
      onSleep();
    },
    runText: async (_cmd, args, options) => {
      effects.push({ kind: "run", at: nowNs, args, options });
      nowNs += 50_000_000n;
      return { code: 0, stdout: "Status: ok\nLaunchState: COLD\n", stderr: "", timedOut: false,
        ...results[Math.min(index++, results.length - 1)] };
    },
  });
  return { live, effects };
}

test("live target launch retries only kept-for-user before starting the accepted-launch observer", async (t) => {
  const fixture = await createPreparedFixture(t);
  const launch = liveLaunchRetryFixture([{ stdout: keptForUserLaunchOutput }, {}], () => {
    assert.equal(fixture.calls.some(({ kind }) => ["launchObservation", "launchWindow", "probeRuntime", "capability"].includes(kind)), false);
  });
  fixture.dependencies.launchTarget = launch.live.launchTarget;
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "needs_baseline_review", result.primaryError);
  const launches = launch.effects.filter(({ kind }) => kind === "run");
  assert.equal(launches.length, 2);
  assert.ok(launches.every(({ args }) => JSON.stringify(args) === JSON.stringify([
    "-s", fixture.input.serial, "shell", "am", "start", "-W", "-n", fixture.input.scenario.launchComponent,
  ])));
  assert.equal(fixture.calls.filter(({ kind }) => kind === "launchObservation").length, 1);
});

test("live target launch leaves accepted, ambiguous, and failing acknowledgements unretried", async (t) => {
  for (const [label, result] of [
    ["accepted", { stdout: "Status: ok\nLaunchState: COLD\n" }],
    ["other ignored", { stdout: "Warning: Activity not started, intent has been delivered to currently running top-most instance.\nStatus: ok\n" }],
    ["nonzero", { stdout: keptForUserLaunchOutput, code: 1 }],
    ["timeout", { stdout: keptForUserLaunchOutput, timedOut: true }],
    ["stderr", { stdout: keptForUserLaunchOutput, stderr: "adb: transport warning" }],
    ["missing status", { stdout: keptForUserLaunchOutput.replace("Status: ok\n", "") }],
    ["conflicting error", { stdout: `${keptForUserLaunchOutput}Error: launch permission denied\n` }],
    ["conflicting status", { stdout: `${keptForUserLaunchOutput}Status: timeout\n` }],
    ["conflicting launch state", { stdout: keptForUserLaunchOutput.replace("UNKNOWN (0)", "COLD") }],
    ["duplicate warning", { stdout: `${keptForUserLaunchOutput}Warning: Activity not started, intent delivered\n` }],
  ]) {
    await t.test(label, async () => {
      const fixture = liveLaunchRetryFixture([result, {}]);
      await fixture.live.launchTarget({
        serial: "emulator-5554", component: "com.test.fullworld/.platform.LaunchActivity",
        timeoutMs: 1_000, deadlineMonotonicNs: "1000000000",
      });
      assert.equal(fixture.effects.filter(({ kind }) => kind === "run").length, 1);
      assert.equal(fixture.effects.filter(({ kind }) => kind === "sleep").length, 0);
    });
  }
});

test("persistent kept-for-user launch stops at its deadline and preserves preparation cleanup", async (t) => {
  const fixture = await createPreparedFixture(t);
  const launch = liveLaunchRetryFixture([{ stdout: keptForUserLaunchOutput }]);
  fixture.dependencies.launchTarget = (context) => launch.live.launchTarget({
    ...context, timeoutMs: 350, deadlineMonotonicNs: "350000000",
  });
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "preparation_failed");
  assert.equal(result.structuralStop, "launch_failed");
  assert.match(result.primaryError, /kept.for.the.user.*(?:deadline|remaining)/i);
  const runs = launch.effects.filter(({ kind }) => kind === "run");
  assert.ok(runs.length > 1);
  assert.ok(runs.every(({ at, options }) => at < 350_000_000n && options.timeoutMs <= Number((350_000_000n - at) / 1_000_000n)));
  assert.ok(launch.effects.filter(({ kind }) => kind === "sleep").every(({ at, ms }) => at + BigInt(ms) * 1_000_000n <= 350_000_000n));
  assert.equal(fixture.calls.some(({ kind }) => ["launchObservation", "launchWindow", "probeRuntime", "locomote"].includes(kind)), false);
  assert.equal(fixture.calls.filter(({ kind, context }) => kind === "stop" && context.reason === "prepare_failure_cleanup").length, 1);
});

function liveSafetyReadinessFixture(snapshots, onSleep = async () => {}) {
  let nowNs = 0n;
  let sampleIndex = 0;
  const effects = [];
  const live = worldLocomotion.createLiveInAppLocomotionDependencies({
    runBytes: async () => { throw new Error("binary runner is outside this fixture"); },
    resolveAdb: () => "/fixture/injected-adb",
    monotonicNs: () => nowNs,
    sleep: async (ms) => {
      effects.push({ kind: "sleep", at: nowNs, ms });
      nowNs += BigInt(ms) * 1_000_000n;
      await onSleep();
    },
    runText: async (_cmd, args, options) => {
      effects.push({ kind: "run", args, options, at: nowNs });
      nowNs += 10_000_000n;
      const sample = snapshots[Math.min(sampleIndex, snapshots.length - 1)];
      const properties = {
        "sys.guardian.vst.status": sample.guardian,
        "sys.pxr.vst.comp.state": sample.vstComponent,
        "persist.pxr.see.vst.debug.enable": sample.vstDebug,
      };
      let stdout = properties[args.at(-1)];
      if (args.includes("ConfigurationService")) {
        sampleIndex += 1;
        stdout = JSON.stringify([
          { keyName: "spatial_stage_style", keyValue: sample.stageStyle },
          { keyName: "spatial_safeguard_enable", keyValue: sample.safeguard },
          { keyName: "spatial_safeguard_center", keyValue: sample.safeguardCenter },
          { keyName: "spatial_virtual_content_detected", keyValue: sample.virtualContent },
        ]);
      }
      assert.equal(typeof stdout, "string", `unexpected safety command: ${args.join(" ")}`);
      return { code: 0, stdout, stderr: "", timedOut: false };
    },
  });
  return { live, effects };
}

test("live prepare safety waits for exact Full readiness while the launch observer covers the transition", async (t) => {
  const fixture = await createPreparedFixture(t, {
    // Two yielded readiness polls advance the fixture observer by two 5ms samples.
    monitorSampleZeroProbeStartedAtMonotonicNs: "19000000",
    monitorSampleZeroRetainedAtMonotonicNs: "20000000",
  });
  let observerSignal;
  let readinessComplete = false;
  const observe = fixture.dependencies.observeLaunchHandoff;
  fixture.dependencies.observeLaunchHandoff = (context) => {
    observerSignal = context.signal;
    return observe(context);
  };
  const safety = liveSafetyReadinessFixture([
    { ...cleanSafety, stageStyle: "2" },
    { ...cleanSafety, virtualContent: "0" },
    cleanSafety,
  ], async () => {
    assert.ok(observerSignal && !observerSignal.aborted, "launch observer must remain active during readiness polling");
    assert.equal(fixture.calls.some(({ kind }) => kind === "capability" || kind === "monitor" || kind === "locomote"), false);
    await new Promise((resolve) => setImmediate(resolve));
  });
  fixture.dependencies.sampleSafety = async (context) => {
    const result = await safety.live.sampleSafety(context);
    if (context.phase === "prepare_baseline") {
      assert.deepEqual(result, cleanSafety);
      readinessComplete = true;
    }
    return result;
  };
  const monitor = fixture.dependencies.monitorFreshLaunch;
  fixture.dependencies.monitorFreshLaunch = async (context) => {
    assert.ok(readinessComplete);
    assert.equal(observerSignal.aborted, false);
    assert.equal(context.minimumDurationMs, 60_000);
    return monitor(context);
  };
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "needs_baseline_review", result.primaryError);
  assert.equal(safety.effects.filter(({ kind }) => kind === "sleep").length, 2);
  assert.ok(safety.effects.filter(({ kind }) => kind === "run").every(({ args }) => args[0] === "-s" && args[1] === fixture.input.serial));
  assert.equal(observerSignal.aborted, true, "observer hands off only after the monitor retains sample zero");
});

test("live prepare safety readiness remains deadline bounded and later safety samples never wait", async (t) => {
  await t.test("persistent non-Full state", async () => {
    const fixture = liveSafetyReadinessFixture([{ ...cleanSafety, stageStyle: "2" }]);
    await assert.rejects(fixture.live.sampleSafety({
      serial: "emulator-5554", phase: "prepare_baseline", timeoutMs: 500, deadlineMonotonicNs: "500000000",
    }), (error) => {
      assert.equal(error.code, "safety_baseline_failed");
      assert.match(error.message, /stageStyle=2.*(?:deadline|remaining)/i);
      return true;
    });
    assert.ok(fixture.effects.filter(({ kind }) => kind === "run").every(({ at, options }) =>
      at < 500_000_000n && options.timeoutMs <= Number((500_000_000n - at) / 1_000_000n)));
    assert.ok(fixture.effects.filter(({ kind }) => kind === "sleep").every(({ at, ms }) => at + BigInt(ms) * 1_000_000n <= 500_000_000n));
  });
  for (const [label, phase, snapshot] of [
    ["unsafe Guardian baseline", "prepare_baseline", { ...cleanSafety, guardian: "0" }],
    ["unsafe VST component baseline", "prepare_baseline", { ...cleanSafety, vstComponent: "0" }],
    ["unsafe VST debug baseline", "prepare_baseline", { ...cleanSafety, vstDebug: "0" }],
    ["monitor drift", "fresh_launch_1", { ...cleanSafety, stageStyle: "2" }],
    ["route drift", "step_baseline", { ...cleanSafety, safeguard: "0" }],
  ]) {
    await t.test(label, async () => {
      const fixture = liveSafetyReadinessFixture([snapshot, cleanSafety]);
      assert.deepEqual(await fixture.live.sampleSafety({
        serial: "emulator-5554", phase, timeoutMs: 5_000, deadlineMonotonicNs: "5000000000",
      }), snapshot);
      assert.equal(fixture.effects.filter(({ kind }) => kind === "sleep").length, 0);
    });
  }
});

function liveCurrentLogFixture(t, overrides = {}) {
  const marker = "PICO_LOCOMOTION_FIXTURE_PREPARE_BEGIN";
  const endMarker = "PICO_LOCOMOTION_FIXTURE_PREPARE_END";
  const cursor = "1788599574.657046";
  const window = `09-05 02:12:54.657  5000  5000 I WorldLocomotion: ${marker}\n`
    + "09-05 02:12:54.658  5151  5151 I Spatial: setSpatialContainerBoundary\n"
    + "09-05 02:12:54.659  5000  5000 I ActivityManager: onPause com.test.fullworld/.MainActivity\n"
    + `09-05 02:12:54.660  5000  5000 I WorldLocomotion: ${endMarker}\n`;
  const requestedArtifactRoot = externalArtifactRoot(t, "live-current-log");
  fs.mkdirSync(path.join(requestedArtifactRoot, "logs"), { recursive: true });
  const artifactRoot = fs.realpathSync(requestedArtifactRoot);
  let nowNs = 0n;
  const effects = [];
  const live = worldLocomotion.createLiveInAppLocomotionDependencies({
    runBytes: async () => { throw new Error("binary runner is outside this fixture"); },
    resolveAdb: () => "/fixture/injected-adb",
    monotonicNs: () => nowNs,
    sleep: async (ms) => { nowNs += BigInt(ms) * 1_000_000n; },
    runText: async (_cmd, args, options) => {
      effects.push({ args, options, at: nowNs });
      assert.deepEqual(args.slice(0, 2), ["-s", "emulator-5554"]);
      let stdout = "1\n";
      if (args.includes("logcat")) {
        const regexIndex = args.indexOf("--regex");
        const regex = regexIndex >= 0 ? args[regexIndex + 1] : args.find((arg) => arg.startsWith("--regex="))?.slice(8);
        if (regex !== undefined) {
          assert.ok(new RegExp(regex).test(marker), "cursor query must include the exact requested marker");
          assert.ok(!new RegExp(regex).test("old-history"), "cursor query must filter unrelated history on device");
          assert.ok(args.includes("epoch") && args.includes("usec"));
          stdout = overrides.markerOutput ?? `${cursor} 5000 5000 I WorldLocomotion: ${marker}\n`;
        } else if (args.includes("-T")) {
          assert.equal(args[args.indexOf("-T") + 1], cursor);
          assert.ok(args.includes("threadtime"), "retain scanner-compatible complete threadtime entries");
          assert.ok(args.includes("all"), "retain every buffer in the current window");
          stdout = overrides.windowOutput ?? window;
          if (overrides.windowResult) return { stdout, stderr: "", timedOut: false, code: 0, ...overrides.windowResult };
        } else {
          // A long-lived ring fills the bounded transport with history before BEGIN.
          stdout = "09-03 01:00:00.000  4000  4000 I Historical: old-history\n";
        }
      } else if (args.includes("ConfigurationService")) {
        stdout = JSON.stringify([
          { keyName: "spatial_stage_style", keyValue: "3" },
          { keyName: "spatial_safeguard_enable", keyValue: "1" },
          { keyName: "spatial_safeguard_center", keyValue: "0,0,0" },
          { keyName: "spatial_virtual_content_detected", keyValue: "1" },
        ]);
      } else if (args.includes("path")) stdout = "package:/data/app/base.apk\n";
      else if (args.includes("sha256sum")) stdout = `${"b".repeat(64)}  /data/app/base.apk\n`;
      else if (args.includes("pidof")) stdout = "5151\n";
      else if (args.includes("activities")) stdout = overrides.activityOutput ?? "mResumedActivity: ActivityRecord{fixture u0 com.test.fullworld/.MainActivity t1}\n";
      else if (args.includes("windows")) stdout = "WINDOW MANAGER WINDOWS\n";
      return { code: 0, stdout, stderr: "", timedOut: false };
    },
  });
  const budget = { serial: "emulator-5554", timeoutMs: 90_000, deadlineMonotonicNs: "90000000000" };
  return {
    live, effects, marker, endMarker, window, artifactRoot,
    bracketContext: { ...budget, path: path.join(artifactRoot, "logs", "bracket.log"), packageName: "com.test.fullworld", beginMarker: marker, endMarker },
    monitorContext: {
      ...budget, runId: HASH, artifactRoot, minimumDurationMs: 60_000, healthBoundaryMarker: marker,
      onFirstWindowSample: async () => {},
      runtime: {
        liveIdentity: { serial: "emulator-5554" },
        applicationBinding: { packageName: "com.test.fullworld", apkSha256: "b".repeat(64), allowedResumedComponents: ["com.test.fullworld/.MainActivity"], pid: 5151, pidStartTicks: "123" },
      },
    },
  };
}

test("live log brackets and fresh-launch health retain the complete current device window", async (t) => {
  const fixture = liveCurrentLogFixture(t);
  const monitor = await fixture.live.monitorFreshLaunch(fixture.monitorContext);
  assert.equal(monitor.samples.length, 5);
  for (const [index, sample] of monitor.samples.entries()) {
    assert.equal(sample.runtimeHealth.status, "no_attributed_failure");
    assert.equal(sample.runtimeHealth.markerOccurrences, 1);
    assert.equal(fs.readFileSync(monitor.rawHealthLogs[index].path, "utf8"), fixture.window);
  }
  const bracket = await fixture.live.collectStepLogs(fixture.bracketContext);
  assert.equal(bracket.truncated, false);
  assert.equal(bracket.beginCount, 1);
  assert.equal(bracket.endCount, 1);
  assert.equal(bracket.boundarySignals.setSpatialContainerBoundary, 1);
  assert.equal(bracket.boundarySignals.appPauseOrEjection, 1);
  assert.equal(fs.readFileSync(bracket.path, "utf8"), fixture.window);
  const logCommands = fixture.effects.filter(({ args }) => args.includes("logcat"));
  assert.equal(logCommands.filter(({ args }) => args.includes("-T")).length, 6);
  assert.ok(logCommands.every(({ args }) => args.includes("-T") || args.some((arg) => arg.startsWith("--regex"))));
  assert.ok(logCommands.every(({ args }) => !args.includes("-c") && !args.includes("--clear")));
});

test("live log cursor ambiguity and failed snapshots never become complete evidence", async (t) => {
  for (const [label, overrides, pattern] of [
    ["missing-marker", { markerOutput: "" }, /marker|cursor/i],
    ["duplicate-marker", { markerOutput: "1788599574.657046 1 1 I WorldLocomotion: PICO_LOCOMOTION_FIXTURE_PREPARE_BEGIN\n1788599575.657046 1 1 I WorldLocomotion: PICO_LOCOMOTION_FIXTURE_PREPARE_BEGIN\n" }, /marker|cursor/i],
    ["invalid-cursor", { markerOutput: "not-a-time 1 1 I WorldLocomotion: PICO_LOCOMOTION_FIXTURE_PREPARE_BEGIN\n" }, /marker|cursor/i],
    ["failed-window", { windowResult: { code: 1, stderr: "transport output limit" } }, /transport output limit/i],
  ]) {
    await t.test(label, async (t) => {
      const fixture = liveCurrentLogFixture(t, overrides);
      await assert.rejects(fixture.live.collectStepLogs(fixture.bracketContext), pattern);
      if (label !== "failed-window") assert.equal(fixture.effects.some(({ args }) => args.includes("-T")), false);
      assert.ok(fixture.effects.every(({ args }) => args.includes("-T") || args.some((arg) => arg.startsWith("--regex"))));
    });
  }
});

test("live log bracket extraction can reach BEGIN beyond historical ring output", async (t) => {
  const fixture = liveCurrentLogFixture(t);
  const result = await fixture.live.collectStepLogs(fixture.bracketContext);
  assert.equal(result.truncated, false);
  assert.equal(result.beginCount, 1);
  assert.equal(result.endCount, 1);
  assert.equal(fs.readFileSync(result.path, "utf8"), fixture.window);
});

test("live log marker cursors select an explicit base format despite ambient logcat preferences", async (t) => {
  const fixture = liveCurrentLogFixture(t);
  await fixture.live.collectStepLogs(fixture.bracketContext);
  const query = fixture.effects.find(({ args }) => args.some((arg) => arg.startsWith("--regex")));
  const formats = query.args.flatMap((arg, index) => arg === "-v" ? [query.args[index + 1]] : []);
  assert.ok(formats.includes("threadtime"), "cursor lookup must override ANDROID_PRINTF_LOG with an explicit base format");
  assert.ok(formats.includes("epoch") && formats.includes("usec"));
});

test("live log snapshots reject exact output-cap bytes even with exit zero and complete markers", async (t) => {
  const template = liveCurrentLogFixture(t);
  const capped = template.window + "x".repeat(64 * 1024 * 1024 - Buffer.byteLength(template.window));
  const fixture = liveCurrentLogFixture(t, { windowOutput: capped });
  await assert.rejects(fixture.live.collectStepLogs(fixture.bracketContext), /current window.*(?:bound|limit|truncat)/i);
  assert.equal(fs.existsSync(fixture.bracketContext.path), false);
});

test("live continuity permits only the existing exact spatial-shell companion beside allowed target activities", async (t) => {
  const target = "com.test.fullworld/.MainActivity";
  const shell = "com.pxr.scenarioprovider/com.unity3d.player.UnityPlayerActivity";
  const dump = (components) => components.map((component, index) =>
    `mResumedActivity: ActivityRecord{fixture${index} u0 ${component} t${index + 1}}\n`).join("");
  for (const [label, components, foreground] of [
    ["target alone", [target], "exact_allowed"],
    ["target and exact shell", [shell, target], "exact_allowed"],
    ["unlisted target beside shell", [shell, target, "com.test.fullworld/.UnexpectedActivity"], "same_package_unlisted"],
    ["shell without target", [shell], "different_package"],
    ["another shell component", [target, "com.pxr.scenarioprovider/.OtherActivity"], "different_package"],
    ["unrelated resumed app", [target, "com.test.other/.MainActivity"], "different_package"],
    ["unrelated system activity", [target, "com.android.settings/.Settings"], "different_package"],
    ["no resumed activity", [], "absent"],
  ]) {
    await t.test(label, async (t) => {
      const fixture = liveCurrentLogFixture(t, { activityOutput: components.length ? dump(components) : "mResumedActivity: null\n" });
      const sample = await fixture.live.sampleContinuity({ ...fixture.monitorContext, phase: "continuity_fixture" });
      assert.equal(sample.foreground, foreground);
      assert.deepEqual(sample.resumedComponents, components, "classification must retain all observed components as evidence");
      assert.deepEqual(sample.allowedResumedComponents, [target], "system companion must not enter the target allowlist");
      assert.equal(sample.pid, 5151);
      assert.equal(sample.apkSha256, "b".repeat(64));
    });
  }
});

test("live fresh-launch monitor retains exact target continuity with the spatial shell resumed", async (t) => {
  const shell = "com.pxr.scenarioprovider/com.unity3d.player.UnityPlayerActivity";
  const fixture = liveCurrentLogFixture(t, {
    activityOutput: "mResumedActivity: ActivityRecord{target u0 com.test.fullworld/.MainActivity t1}\n"
      + `mResumedActivity: ActivityRecord{shell u0 ${shell} t2}\n`,
  });
  const monitor = await fixture.live.monitorFreshLaunch(fixture.monitorContext);
  assert.equal(monitor.samples.length, 5);
  assert.ok(monitor.samples.at(-1).elapsedMs >= 60_000);
  for (const sample of monitor.samples) {
    assert.equal(sample.continuity.foreground, "exact_allowed");
    assert.ok(sample.continuity.resumedComponents.includes(shell));
  }
});

test("live prepare clearance waits for both exact process and foreground absence before launch", async (t) => {
  await t.test("same-package prior is rejected before live clearance", async (t) => {
    const component = "com.test.fullworld/.PriorActivity";
    const fixture = await createPreparedFixture(t, {
      priorSnapshot: { component, packageName: "com.test.fullworld", userInstalled: true },
      inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
    });
    await assert.rejects(
      createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input),
      /prior|package|same/i,
    );
    assert.equal(deviceCalls(fixture.calls).length, 0);
  });

  for (const priorPackage of ["com.test.incumbent"]) {
    await t.test(priorPackage, async (t) => {
      const component = `${priorPackage}/.MainActivity`;
      const fixture = await createPreparedFixture(t, {
        priorSnapshot: { component, packageName: priorPackage, userInstalled: true },
        inputOverrides: { priorForeground: { kind: "non_receipt_bound", component } },
      });
      let nowNs = 1_000_000_000n;
      let stoppedPackage;
      let polls = 0;
      const cleared = new Set();
      const effects = [];
      const live = worldLocomotion.createLiveInAppLocomotionDependencies({
        runBytes: async () => { throw new Error("binary runner is outside this fixture"); },
        resolveAdb: () => "/fixture/injected-adb",
        monotonicNs: () => nowNs,
        sleep: async (ms) => { nowNs += BigInt(ms) * 1_000_000n; },
        runText: async (_cmd, args, options) => {
          effects.push({ args, options, at: nowNs });
          assert.deepEqual(args.slice(0, 2), ["-s", "emulator-5554"]);
          if (args.includes("force-stop")) {
            stoppedPackage = args.at(-1);
            polls = 0;
            return { code: 0, stdout: "", stderr: "", timedOut: false };
          }
          if (args.includes("pidof")) {
            assert.equal(args.at(-1), stoppedPackage);
            polls += 1;
            return { code: polls < 2 ? 0 : 1, stdout: polls < 2 ? "5151\n" : "", stderr: "", timedOut: false };
          }
          if (args.includes("activities")) {
            // The process disappears before Android removes the resumed activity.
            if (polls >= 3) cleared.add(stoppedPackage);
            const foreground = polls < 3 ? stoppedPackage : `${stoppedPackage}.sibling`;
            return { code: 0, stdout: `mResumedActivity: ActivityRecord{fixture u0 ${foreground}/.MainActivity t1}\n`, stderr: "", timedOut: false };
          }
          throw new Error(`unexpected fixture command: ${args.join(" ")}`);
        },
      });
      fixture.dependencies.stopPackage = live.stopPackage;
      const launch = fixture.dependencies.launchTarget;
      fixture.dependencies.launchTarget = async (context) => {
        assert.ok(cleared.has("com.test.fullworld"), "target launch started before process and resumed-activity clearance");
        assert.ok(cleared.has(priorPackage), "target launch started before declared incumbent clearance");
        return launch(context);
      };
      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "needs_baseline_review", result.primaryError);
      assert.ok(effects.filter(({ args }) => args.includes("pidof")).length >= 3);
    });
  }
});

test("live prepare clearance rejects uncertain PID probes and obeys the absolute deadline", async (t) => {
  for (const [label, pidResult, pattern] of [
    ["offline", { code: 1, stdout: "", stderr: "adb: device offline", timedOut: false }, /PID.*offline/i],
    ["empty-success", { code: 0, stdout: "", stderr: "", timedOut: false }, /PID.*failed/i],
    ["whitespace-stdout", { code: 1, stdout: "\n", stderr: "", timedOut: false }, /PID.*failed/i],
    ["whitespace-stderr", { code: 1, stdout: "", stderr: " \n", timedOut: false }, /PID.*failed/i],
    ["malformed", { code: 0, stdout: "not-a-pid", stderr: "", timedOut: false }, /PID.*malformed/i],
    ["still-running", { code: 0, stdout: "5151\n", stderr: "", timedOut: false }, /deadline|remaining/i],
  ]) {
    await t.test(label, async () => {
      let nowNs = 0n;
      const effects = [];
      const live = worldLocomotion.createLiveInAppLocomotionDependencies({
        runBytes: async () => { throw new Error("binary runner is outside this fixture"); },
        resolveAdb: () => "/fixture/injected-adb",
        monotonicNs: () => nowNs,
        sleep: async (ms) => { nowNs += BigInt(ms) * 1_000_000n; },
        runText: async (_cmd, args, options) => {
          effects.push({ args, options, at: nowNs });
          nowNs += 100_000_000n;
          return args.includes("pidof") ? pidResult : { code: 0, stdout: "mResumedActivity: null\n", stderr: "", timedOut: false };
        },
      });
      await assert.rejects(live.stopPackage({
        serial: "emulator-5554", packageName: "com.test.fullworld", reason: "prepare_target_clearance",
        timeoutMs: 900, deadlineMonotonicNs: "900000000",
      }), pattern);
      assert.ok(effects.every(({ at, options }) => at < 900_000_000n && options.timeoutMs <= Number((900_000_000n - at) / 1_000_000n)));
      assert.equal(effects.filter(({ args }) => args.includes("force-stop")).length, 1);
    });
  }
});

test("prepare requires a separately receipted clean PID absence before declaring an incumbent stale", async (t) => {
  const component = "com.test.fullworld/.platform.LaunchActivity";
  const fixture = await createPreparedFixture(t, {
    priorSnapshot: { component, packageName: "com.test.fullworld", userInstalled: true },
    inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "b".repeat(64) } },
  });
  let launchCalled = false;
  fixture.dependencies.stopPackage = async (context) => {
    fixture.calls.push({ kind: "stop", context });
    return completedStopReceipt(context);
  };
  fixture.dependencies.launchTarget = async () => {
    launchCalled = true;
    throw new Error("launch must not follow an unproven prepare clearance");
  };

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /PID-absence.*receipt/i);
  assert.equal(launchCalled, false);
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(action.priorForeground.receiptFreshness, "unknown_after_stop_attempt");
  assert.deepEqual(action.prepareClearanceEvidence, [{
    status: "prepare_clearance_incomplete",
    stopReceipt: completedStopReceipt({
      serial: fixture.input.serial,
      packageName: fixture.input.scenario.packageName,
      reason: "prepare_target_clearance",
    }),
    pidAbsence: null,
  }]);
});

test("prepare rejects malformed PID-absence receipts without promoting freshness", async (t) => {
  const malformed = [
    ["serial", { serial: "emulator-9999" }],
    ["package", { packageName: "com.test.other" }],
    ["exit", { exitCode: 0 }],
    ["timeout", { timedOut: true }],
    ["stdout", { stdout: "5151\n" }],
    ["stderr", { stderr: "transport warning" }],
    ["extra key", { extra: true }],
  ];
  for (const [label, pidOverrides] of malformed) {
    await t.test(label, async (t) => {
      const component = "com.test.fullworld/.platform.LaunchActivity";
      const fixture = await createPreparedFixture(t, {
        priorSnapshot: { component, packageName: "com.test.fullworld", userInstalled: true },
        inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "e".repeat(64) } },
      });
      fixture.dependencies.stopPackage = async (context) => {
        fixture.calls.push({ kind: "stop", context });
        return completedPrepareClearanceReceipt(context, pidOverrides);
      };

      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

      assert.equal(result.status, "preparation_failed");
      assert.match(result.primaryError, /PID-absence.*receipt/i);
      const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(action.priorForeground.receiptFreshness, "unknown_after_stop_attempt");
      assert.deepEqual(action.prepareClearanceEvidence, [{
        status: "prepare_clearance_incomplete",
        stopReceipt: completedStopReceipt({
          serial: fixture.input.serial,
          packageName: fixture.input.scenario.packageName,
          reason: "prepare_target_clearance",
        }),
        pidAbsence: null,
      }]);
      assert.equal(fixture.calls.some((call) => call.kind === "launch"), false);
    });
  }
});

test("typed partial clearance retains exact stop evidence when its PID proof is malformed", async (t) => {
  const component = "com.test.fullworld/.platform.LaunchActivity";
  const fixture = await createPreparedFixture(t, {
    priorSnapshot: { component, packageName: "com.test.fullworld", userInstalled: true },
    inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "9".repeat(64) } },
  });
  fixture.dependencies.stopPackage = async (context) => {
    fixture.calls.push({ kind: "stop", context });
    throw new worldLocomotion.LocomotionStopClearanceError(
      new Error("injected activity-clearance failure"),
      completedStopReceipt(context),
      cleanPidAbsenceReceipt({ serial: context.serial, packageName: context.packageName }, { extra: true }),
    );
  };

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /exact clean PID-absence receipt/i);
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(action.priorForeground.receiptFreshness, "unknown_after_stop_attempt");
  assert.deepEqual(action.prepareClearanceEvidence, [{
    status: "prepare_clearance_incomplete",
    stopReceipt: completedStopReceipt({
      serial: fixture.input.serial,
      packageName: fixture.input.scenario.packageName,
      reason: "prepare_target_clearance",
    }),
    pidAbsence: null,
  }]);
  assert.equal(fixture.calls.some((call) => call.kind === "launch"), false);
});

test("receipt-bound stop failure before command completion remains explicit unknown for either incumbent layout", async (t) => {
  for (const priorPackage of ["com.test.fullworld", "com.test.incumbent"]) {
    await t.test(priorPackage, async (t) => {
      const component = priorPackage === "com.test.fullworld"
        ? "com.test.fullworld/.platform.LaunchActivity"
        : "com.test.incumbent/.MainActivity";
      const fixture = await createPreparedFixture(t, {
        priorSnapshot: { component, packageName: priorPackage, userInstalled: true },
        inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "8".repeat(64) } },
      });
      fixture.dependencies.stopPackage = async (context) => {
        fixture.calls.push({ kind: "stop", context });
        if (context.packageName === priorPackage) throw new Error("injected force-stop transport failure");
        return completedPrepareClearanceReceipt(context);
      };

      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

      assert.equal(result.status, "preparation_failed");
      assert.match(result.primaryError, /force-stop transport failure/i);
      const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(action.priorForeground.receiptFreshness, "unknown_after_stop_attempt");
      assert.equal(action.priorForeground.relaunchDisposition, "withheld_receipt_bound");
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.packageName === priorPackage).length, 1);
      assert.equal(fixture.calls.some((call) => call.kind === "launch" || call.kind === "relaunchPrior"), false);
      assert.deepEqual(
        action.prepareClearanceEvidence,
        priorPackage === fixture.input.scenario.packageName
          ? []
          : [completedPrepareClearanceReceipt({
            serial: fixture.input.serial,
            packageName: fixture.input.scenario.packageName,
            reason: "prepare_target_clearance",
          })],
      );
    });
  }
});

test("separate receipt-bound incumbent stays not-evaluated when target clearance fails first", async (t) => {
  const component = "com.test.incumbent/.MainActivity";
  const fixture = await createPreparedFixture(t, {
    priorSnapshot: { component, packageName: "com.test.incumbent", userInstalled: true },
    inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "7".repeat(64) } },
  });
  fixture.dependencies.stopPackage = async (context) => {
    fixture.calls.push({ kind: "stop", context });
    throw new Error("injected target-clearance transport failure");
  };

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(result.primaryError, /target-clearance transport failure/i);
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(action.priorForeground.receiptFreshness, "not_evaluated_cp1");
  assert.equal(action.priorForeground.relaunchDisposition, "withheld_receipt_bound");
  assert.deepEqual(action.prepareClearanceEvidence, []);
  assert.deepEqual(
    fixture.calls.filter((call) => call.kind === "stop").map((call) => call.context.packageName),
    [fixture.input.scenario.packageName],
  );
  assert.equal(fixture.calls.some((call) => call.kind === "launch" || call.kind === "relaunchPrior"), false);
});

test("normal prepare clearance persists exact PID-absence evidence for either incumbent layout", async (t) => {
  for (const priorPackage of ["com.test.fullworld", "com.test.incumbent"]) {
    await t.test(priorPackage, async (t) => {
      const component = priorPackage === "com.test.fullworld"
        ? "com.test.fullworld/.platform.LaunchActivity"
        : "com.test.incumbent/.MainActivity";
      const fixture = await createPreparedFixture(t, {
        priorSnapshot: { component, packageName: priorPackage, userInstalled: true },
        inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "f".repeat(64) } },
      });
      fixture.dependencies.stopPackage = async (context) => {
        fixture.calls.push({ kind: "stop", context });
        return context.reason === "prepare_target_clearance" || context.reason === "prepare_declared_incumbent_clearance"
          ? completedPrepareClearanceReceipt(context)
          : completedStopReceipt(context);
      };
      fixture.dependencies.launchTarget = async () => {
        throw new Error("injected post-clearance launch failure");
      };

      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

      assert.equal(result.status, "preparation_failed");
      assert.match(result.primaryError, /post-clearance launch failure/i);
      const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(action.priorForeground.receiptFreshness, "known_stale");
      const priorClearance = action.prepareClearanceEvidence.find((item) => item.stopReceipt.packageName === priorPackage);
      const priorReason = priorPackage === fixture.input.scenario.packageName
        ? "prepare_target_clearance"
        : "prepare_declared_incumbent_clearance";
      assert.deepEqual(priorClearance, completedPrepareClearanceReceipt({
        serial: fixture.input.serial,
        packageName: priorPackage,
        reason: priorReason,
      }));
      assert.equal(action.prepareClearanceEvidence.length, priorPackage === fixture.input.scenario.packageName ? 1 : 2);
    });
  }
});

test("receipt-bound prepare failure records known stale when PID absence preceded an activity-probe failure", async (t) => {
  for (const priorPackage of ["com.test.fullworld", "com.test.incumbent"]) {
    await t.test(priorPackage, async (t) => {
      const component = priorPackage === "com.test.fullworld"
        ? "com.test.fullworld/.platform.LaunchActivity"
        : "com.test.incumbent/.MainActivity";
      const fixture = await createPreparedFixture(t, {
        priorSnapshot: { component, packageName: priorPackage, userInstalled: true },
        inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "c".repeat(64) } },
      });
      let stoppingPackage = null;
      const effects = [];
      const live = worldLocomotion.createLiveInAppLocomotionDependencies({
        runBytes: async () => { throw new Error("binary runner is outside this fixture"); },
        resolveAdb: () => "/fixture/injected-adb",
        monotonicNs: () => 1_000_000_000n,
        sleep: async () => {},
        runText: async (_cmd, args, options) => {
          effects.push({ args, options });
          if (args.includes("force-stop")) {
            stoppingPackage = args.at(-1);
            return { code: 0, stdout: "", stderr: "", timedOut: false };
          }
          if (args.includes("pidof")) {
            return { code: 1, stdout: "", stderr: "", timedOut: false };
          }
          if (args.includes("activities")) {
            return stoppingPackage === priorPackage
              ? { code: 1, stdout: "", stderr: "activity manager unavailable", timedOut: false }
              : { code: 0, stdout: "ACTIVITY MANAGER ACTIVITIES\nmResumedActivity: null\n", stderr: "", timedOut: false };
          }
          throw new Error(`unexpected fixture command: ${args.join(" ")}`);
        },
      });
      fixture.dependencies.stopPackage = live.stopPackage;

      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

      assert.equal(result.status, "preparation_failed");
      assert.match(result.primaryError, /activity manager unavailable/i);
      assert.equal(fixture.calls.some((call) => call.kind === "relaunchPrior"), false);
      const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(action.priorForeground.receiptFreshness, "known_stale");
      assert.equal(action.priorForeground.relaunchDisposition, "withheld_receipt_bound");
      assert.deepEqual(
        action.prepareClearanceEvidence.find((item) => item.stopReceipt.packageName === priorPackage),
        {
          status: "prepare_clearance_incomplete",
          stopReceipt: completedStopReceipt({
            serial: fixture.input.serial,
            packageName: priorPackage,
            reason: priorPackage === fixture.input.scenario.packageName
              ? "prepare_target_clearance"
              : "prepare_declared_incumbent_clearance",
          }),
          pidAbsence: cleanPidAbsenceReceipt({ serial: fixture.input.serial, packageName: priorPackage }),
        },
      );
      assert.equal(effects.filter(({ args }) => args.includes("force-stop") && args.at(-1) === priorPackage).length, 1);
      assert.equal(effects.filter(({ args }) => args.includes("pidof") && args.at(-1) === priorPackage).length, 1);
    });
  }
});

test("receipt-bound prepare failure records explicit unknown freshness after a completed stop with uncertain PID state", async (t) => {
  for (const priorPackage of ["com.test.fullworld", "com.test.incumbent"]) {
    await t.test(priorPackage, async (t) => {
      const component = priorPackage === "com.test.fullworld"
        ? "com.test.fullworld/.platform.LaunchActivity"
        : "com.test.incumbent/.MainActivity";
      const fixture = await createPreparedFixture(t, {
        priorSnapshot: { component, packageName: priorPackage, userInstalled: true },
        inputOverrides: { priorForeground: { kind: "receipt_bound", component, receiptId: "d".repeat(64) } },
      });
      let stoppingPackage = null;
      const live = worldLocomotion.createLiveInAppLocomotionDependencies({
        runBytes: async () => { throw new Error("binary runner is outside this fixture"); },
        resolveAdb: () => "/fixture/injected-adb",
        monotonicNs: () => 1_000_000_000n,
        sleep: async () => {},
        runText: async (_cmd, args) => {
          if (args.includes("force-stop")) {
            stoppingPackage = args.at(-1);
            return { code: 0, stdout: "", stderr: "", timedOut: false };
          }
          if (args.includes("pidof")) {
            return stoppingPackage === priorPackage
              ? { code: 1, stdout: "", stderr: "adb: device offline", timedOut: false }
              : { code: 1, stdout: "", stderr: "", timedOut: false };
          }
          if (args.includes("activities")) {
            return { code: 0, stdout: "ACTIVITY MANAGER ACTIVITIES\nmResumedActivity: null\n", stderr: "", timedOut: false };
          }
          throw new Error(`unexpected fixture command: ${args.join(" ")}`);
        },
      });
      fixture.dependencies.stopPackage = live.stopPackage;

      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

      assert.equal(result.status, "preparation_failed");
      assert.match(result.primaryError, /PID.*offline/i);
      assert.equal(fixture.calls.some((call) => call.kind === "relaunchPrior"), false);
      const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(action.priorForeground.receiptFreshness, "unknown_after_stop_attempt");
      assert.equal(action.priorForeground.relaunchDisposition, "withheld_receipt_bound");
      assert.deepEqual(
        action.prepareClearanceEvidence.find((item) => item.stopReceipt.packageName === priorPackage),
        {
          status: "prepare_clearance_incomplete",
          stopReceipt: completedStopReceipt({
            serial: fixture.input.serial,
            packageName: priorPackage,
            reason: priorPackage === fixture.input.scenario.packageName
              ? "prepare_target_clearance"
              : "prepare_declared_incumbent_clearance",
          }),
          pidAbsence: null,
        },
      );
    });
  }
});

test("non-prepare live stops retain the unchanged exact four-key receipt", async () => {
  const live = worldLocomotion.createLiveInAppLocomotionDependencies({
    runBytes: async () => { throw new Error("binary runner is outside this fixture"); },
    resolveAdb: () => "/fixture/injected-adb",
    monotonicNs: () => 1_000_000_000n,
    sleep: async () => {},
    runText: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
  });
  const context = {
    serial: "emulator-5554",
    packageName: "com.test.fullworld",
    reason: "restore_run_owned_target",
    timeoutMs: 10_000,
    deadlineMonotonicNs: "11000000000",
  };
  const receipt = await live.stopPackage(context);
  assert.deepEqual(receipt, completedStopReceipt(context));
  assert.deepEqual(Object.keys(receipt).sort(), ["packageName", "reason", "serial", "status"]);
});

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
  expectedRootIncarnation: ROOT_INCARNATION,
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
  root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: ROOT_INCARNATION },
  ...overrides,
});

const hmdAck = (overrides = {}) => envelope(AGENT_BRIDGE_HMD_POSE_COMMAND, {
  outcome: "sampled",
  root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: ROOT_INCARNATION },
  hmdPose: {
    sampleSequence: "42",
    sampleObservedAtMonotonicNs: "9875543210",
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
  rootIncarnation: ROOT_INCARNATION,
  glideDurationMs: 500,
  deferNonceCleanup: true,
};

const locomotionAck = (overrides = {}) => envelope(AGENT_BRIDGE_LOCOMOTE_COMMAND, {
  outcome: "completed",
  requestControl: "execute",
  executionLeaseMs: 2_500,
  mode: "direct",
  target: { absolute: true, x: 2, y: 0, z: -4 },
  glideDurationMs: 500,
  rootGenerationBefore: 7,
  root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: ROOT_INCARNATION },
  pose: { rootGeneration: 7, position: { x: 2, y: 0, z: -4 } },
  hmdPose: null,
  ...overrides,
});

const textOk = { code: 0, stdout: "Broadcast completed: result=0", stderr: "", timedOut: false };
const cleanupOk = { code: 0, stdout: "", stderr: "", timedOut: false };

function fakeTransaction(payloads, options = {}) {
  const calls = [];
  let pull = 0;
  let cancellationInput = null;
  let finalizationInput = null;
  let nonceRemoved = false;
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
        if (args.includes("rm")) {
          const cleanupResult = options.cleanupResult ?? cleanupOk;
          nonceRemoved = cleanupResult.code === 0 && !cleanupResult.timedOut;
          return cleanupResult;
        }
        const valueAfter = (name) => args[args.indexOf(name) + 1];
        if (args.includes("requestControl") && args.includes("finalize")) {
          finalizationInput = {
            serial: baseInput.serial,
            packageName: baseInput.packageName,
            requestId: valueAfter("requestId"),
            tag: valueAfter("tag"),
            rootGeneration: Number(valueAfter("rootGeneration")),
            rootIncarnation: valueAfter("rootIncarnation"),
          };
        }
        if (args.includes("requestControl") && args.includes("cancel")) {
          cancellationInput = {
            serial: baseInput.serial,
            packageName: baseInput.packageName,
            requestId: valueAfter("requestId"),
            tag: valueAfter("tag"),
            rootGeneration: Number(valueAfter("rootGeneration")),
            rootIncarnation: valueAfter("rootIncarnation"),
          };
        }
        return options.broadcastResult ?? textOk;
      },
      runBytes: async (cmd, args, runOptions) => {
        calls.push({ kind: "bytes", cmd, args, options: runOptions });
        if (nonceRemoved) {
          return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
        }
        if (finalizationInput) {
          return {
            code: 0,
            stdout: Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(finalizeAckFor(finalizationInput)))]),
            stderr: "",
            timedOut: false,
          };
        }
        if (cancellationInput && !options.disableAutomaticCancelAck) {
          return {
            code: 0,
            stdout: Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(cancelAckFor(cancellationInput)))]),
            stderr: "",
            timedOut: false,
          };
        }
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

function assertRouteOwnedCleanup(result, calls, status = "route_owned") {
  assert.deepEqual(result.nonceCleanup, {
    status,
    requestId: baseInput.requestId,
    relativePath: `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${baseInput.requestId}.json`,
    attempts: 0,
  });
  assert.equal(calls.filter((call) => Array.isArray(call.args) && call.args.includes("rm")).length, 0);
  assert.equal(calls.filter((call) => Array.isArray(call.args)
    && call.args.includes("requestControl") && call.args.includes("finalize")).length, 0);
}

function assertPortableLocomotionActionReceipts(result, label) {
  assert.doesNotThrow(() => canonicalJson(result), `${label} result must have one portable canonical identity`);
  for (const receipt of result.actionReceipts) {
    if (receipt.status === "applied") {
      assert.equal(Object.hasOwn(receipt, "error"), false, `${label} applied ${receipt.action} must omit an absent error`);
    } else {
      assert.equal(Object.hasOwn(receipt, "error"), true, `${label} failed ${receipt.action} must retain its error`);
      assert.equal(typeof receipt.error, "string", `${label} failed ${receipt.action} error must be concrete`);
      assert.notEqual(receipt.error.length, 0, `${label} failed ${receipt.action} error must be non-empty`);
    }
  }
}

test("revision-1 capability, HMD, and locomotion successes return portable action receipts", async () => {
  const capability = availableAck();
  const sampled = hmdAck();
  const moved = locomotionAck();
  const cases = [
    ["capability", () => {
      const fake = fakeTransaction([capability, capability]);
      return probeAgentBridgeLocomotionCapability(adb, baseInput, fake.deps);
    }],
    ["HMD", () => {
      const fake = fakeTransaction([sampled, sampled]);
      return requestAgentBridgeHmdPose(adb, { ...baseInput, expectedRootGeneration: 7 }, fake.deps);
    }],
    ["locomotion", () => {
      const fake = fakeTransaction([moved, moved]);
      return requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);
    }],
  ];

  for (const [label, execute] of cases) {
    const result = await execute();
    assert.equal(result.ok, true, label);
    assertPortableLocomotionActionReceipts(result, label);
  }
});

test("revision-1 failed action receipts retain concrete errors without making sibling receipts nonportable", async () => {
  const broadcastFailure = fakeTransaction([], {
    broadcastResult: { code: 1, stdout: "", stderr: "receiver unavailable", timedOut: false },
  });
  const pullFailure = fakeTransaction([]);
  const cleanupFailure = fakeTransaction([hmdAck(), hmdAck()], {
    cleanupResult: { code: 1, stdout: "", stderr: "cleanup denied", timedOut: false },
  });
  const invalidPreflight = fakeTransaction([]);
  const cancelledLocomotion = fakeTransaction([]);
  const cases = [
    ["broadcast failure", requestAgentBridgeHmdPose(adb, baseInput, broadcastFailure.deps)],
    ["pull failure", requestAgentBridgeHmdPose(adb, baseInput, pullFailure.deps)],
    ["cleanup failure", requestAgentBridgeHmdPose(adb, baseInput, cleanupFailure.deps)],
    ["invalid-preflight cleanup", requestAgentBridgeHmdPose(adb, {
      ...baseInput,
      expectedRootIncarnation: "not-a-producer-incarnation",
    }, invalidPreflight.deps)],
    ["successful cancellation", requestAgentBridgeLocomotion(adb, {
      ...locomotionInput,
      maxPolls: 2,
      pollMs: 10,
    }, cancelledLocomotion.deps)],
  ];

  for (const [label, pending] of cases) {
    const result = await pending;
    assert.equal(result.ok, false, label);
    assertPortableLocomotionActionReceipts(result, label);
  }
});

function cancelAckFor(input, outcome = "cancelled") {
  return {
    kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
    schemaVersion: AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
    capabilityRevision: AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
    requestId: input.requestId,
    tag: input.tag ?? input.requestId,
    application: { packageName: input.packageName },
    operation: AGENT_BRIDGE_LOCOMOTE_COMMAND,
    physicalWalk: false,
    primaryError: null,
    cleanupError: null,
    requestControl: "cancel",
    outcome,
    rootGenerationBefore: input.rootGeneration,
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: input.rootGeneration, incarnation: input.rootIncarnation },
  };
}

function finalizeAckFor(input) {
  return {
    kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
    schemaVersion: AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
    capabilityRevision: AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
    requestId: input.requestId,
    tag: input.tag ?? input.requestId,
    application: { packageName: input.packageName },
    operation: AGENT_BRIDGE_LOCOMOTE_COMMAND,
    physicalWalk: false,
    primaryError: null,
    cleanupError: null,
    requestControl: "finalize",
    outcome: "finalized",
    rootGenerationBefore: input.rootGeneration,
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: input.rootGeneration, incarnation: input.rootIncarnation },
  };
}

test("maximum direct glide remains inside the terminal host window and transfers nonce cleanup", async () => {
  let nowNs = 0n;
  const calls = [];
  const input = {
    ...locomotionInput,
    glideDurationMs: 10_000,
    maxPolls: 10,
    pollMs: 100,
    deadlineMonotonicNs: "21650000000",
  };
  const ack = locomotionAck({
    glideDurationMs: 10_000,
    requestControl: "execute",
    executionLeaseMs: 12_000,
  });
  const deps = {
    monotonicNs: () => nowNs,
    sleep: async (durationMs) => {
      calls.push({ kind: "sleep", durationMs, startedAt: nowNs });
      nowNs += BigInt(durationMs) * 1_000_000n;
    },
    runText: async (_cmd, args, options) => {
      const kind = args.includes("cancel") ? "cancel" : "broadcast";
      calls.push({ kind, args, options, startedAt: nowNs });
      return textOk;
    },
    runBytes: async (_cmd, args, options) => {
      calls.push({ kind: "pull", args, options, startedAt: nowNs });
      return nowNs < 10_000_000_000n
        ? { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false }
        : { code: 0, stdout: Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(ack))]), stderr: "", timedOut: false };
    },
  };

  const result = await requestAgentBridgeLocomotion(adb, input, deps);

  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call.kind === "pull" && call.startedAt >= 10_000_000_000n));
  const execute = calls.find((call) => call.kind === "broadcast");
  assert.deepEqual(execute.args.slice(execute.args.indexOf("requestControl") - 1, execute.args.indexOf("requestControl") + 2), [
    "--es", "requestControl", "execute",
  ]);
  assert.ok(execute.args.includes("executionLeaseMs"));
  assert.equal(calls.filter((call) => call.kind === "broadcast" && call.args.includes("cancel")).length, 0);
  assertRouteOwnedCleanup(result, calls);
});

test("locomotion timeout obtains a guest cancel barrier before transferring nonce cleanup", async () => {
  let nowNs = 0n;
  let cancelled = false;
  let cancelPulls = 0;
  let mutated = false;
  const calls = [];
  const input = {
    ...locomotionInput,
    glideDurationMs: 10_000,
    maxPolls: 2,
    pollMs: 10,
    deadlineMonotonicNs: "16300000000",
  };
  const cancelAck = Buffer.from(JSON.stringify(cancelAckFor(input)));
  const deps = {
    monotonicNs: () => nowNs,
    sleep: async (durationMs) => { nowNs += BigInt(durationMs) * 1_000_000n; },
    runText: async (_cmd, args, options) => {
      const isCancel = args.includes("requestControl") && args.includes("cancel");
      calls.push({ kind: isCancel ? "cancel" : "execute", args, options });
      if (isCancel) cancelled = true;
      return textOk;
    },
    runBytes: async () => {
      if (!cancelled || cancelPulls++ === 0)
        return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
      return { code: 0, stdout: Buffer.concat([Buffer.from([1]), cancelAck]), stderr: "", timedOut: false };
    },
  };

  const result = await requestAgentBridgeLocomotion(adb, input, deps);
  nowNs += 20_000_000_000n;
  if (!cancelled) mutated = true;

  assert.equal(result.ok, false);
  assert.equal(result.motionQuiesced, true);
  assert.equal(mutated, false, "a timed-out producer must not retain authority to mutate later");
  assert.equal(calls.filter((call) => call.kind === "cancel").length, 1);
  assert.equal(cancelPulls, 3, "cancel polling must allow appearance followed by a stable pair");
  assertRouteOwnedCleanup(result, calls);
});

test("AgentBridge clock failure after guest-visible execute starts no strict effect and defers stop-first cleanup", async () => {
  let clockBroken = false;
  let cancelSeen = false;
  const calls = [];
  const input = { ...locomotionInput, deadlineMonotonicNs: "20000000000", deferNonceCleanup: true };
  const cancelAck = Buffer.from(JSON.stringify(cancelAckFor(input)));
  const deps = {
    monotonicNs: () => {
      if (clockBroken) throw new Error("permanent bridge clock fault");
      return 100n;
    },
    sleep: async () => {},
    runText: async (_cmd, args, options) => {
      const isRm = args.includes("rm");
      const isCancel = args.includes("requestControl") && args.includes("cancel");
      calls.push({ kind: isRm ? "rm" : isCancel ? "cancel" : "execute", args, options });
      if (!isRm && !isCancel) clockBroken = true;
      if (isCancel) cancelSeen = true;
      return isRm ? cleanupOk : textOk;
    },
    runBytes: async () => cancelSeen
      ? { code: 0, stdout: Buffer.concat([Buffer.from([1]), cancelAck]), stderr: "", timedOut: false }
      : { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false },
  };

  const result = await requestAgentBridgeLocomotion(adb, input, deps);

  assert.equal(result.ok, false);
  assert.match(`${result.primaryError} ${result.cleanupError}`, /clock fault/i);
  assert.equal(result.motionQuiesced, false);
  assert.equal(result.nonceCleanup.status, "deferred_until_stop");
  assert.equal(calls.filter((call) => call.kind === "cancel").length, 0);
  assert.equal(calls.filter((call) => call.kind === "rm").length, 0);
});

test("AgentBridge clock failure after non-mutating broadcast starts no pull or acknowledgement cleanup", async () => {
  for (const [label, request] of [
    ["capability", (deps) => probeAgentBridgeLocomotionCapability(adb, {
      ...baseInput,
      deadlineMonotonicNs: "20000000000",
    }, deps)],
    ["HMD", (deps) => requestAgentBridgeHmdPose(adb, {
      ...baseInput,
      deadlineMonotonicNs: "20000000000",
    }, deps)],
  ]) {
    let clockBroken = false;
    const calls = [];
    const deps = {
      monotonicNs: () => {
        if (clockBroken) throw new Error(`${label} post-broadcast clock fault`);
        return 100n;
      },
      sleep: async () => { throw new Error("sleep must not run after a clock fault"); },
      runBytes: async () => {
        calls.push({ kind: "pull" });
        throw new Error("pull must not run after a clock fault");
      },
      runText: async (_cmd, args, options) => {
        const kind = args.includes("rm") ? "cleanup" : "broadcast";
        calls.push({ kind, options });
        if (kind === "broadcast") clockBroken = true;
        return kind === "cleanup" ? cleanupOk : textOk;
      },
    };

    const result = await request(deps);

    assert.equal(result.ok, false, label);
    assert.match(`${result.primaryError} ${result.cleanupError}`, /post-broadcast clock fault/i, label);
    assert.deepEqual(calls.map((call) => call.kind), ["broadcast"],
      `${label} must not start another strict effect after its absolute deadline clock becomes unavailable`);
  }
});

test("AgentBridge deadline admission clock failure is transport-free", async () => {
  const calls = [];
  const result = await probeAgentBridgeLocomotionCapability(adb, {
    ...baseInput,
    deadlineMonotonicNs: "20000000000",
  }, {
    monotonicNs: () => { throw new Error("admission clock fault"); },
    sleep: async () => { calls.push("sleep"); },
    runBytes: async () => {
      calls.push("pull");
      return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
    },
    runText: async (_cmd, args) => {
      calls.push(args.includes("rm") ? "cleanup" : "broadcast");
      return args.includes("rm") ? cleanupOk : textOk;
    },
  });

  assert.equal(result.ok, false);
  assert.match(`${result.primaryError} ${result.cleanupError}`, /admission clock fault/i);
  assert.deepEqual(calls, [], "an unavailable deadline clock cannot authorize broadcast, polling, sleep, or cleanup");
});

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
  const first = availableAck({ root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 6, incarnation: ROOT_INCARNATION } });
  const final = availableAck();
  const fake = fakeTransaction([first, final, final]);

  const result = await probeAgentBridgeLocomotionCapability(adb, { ...baseInput, maxPolls: 3 }, fake.deps);

  assert.equal(result.ok, true);
  assert.equal(result.ack.root.generation, 7);
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 3);
  assertExactCleanup(fake.calls);
});

test("stable stale or malformed acknowledgement bytes never outrun a later exact stable pair", async () => {
  const good = hmdAck();
  const stale = hmdAck({ requestId: "substituted_nonce_9999" });
  for (const [label, invalid] of [["stale", stale], ["malformed", "{not-json"]]) {
    const fake = fakeTransaction([invalid, invalid, good, good]);

    const result = await requestAgentBridgeHmdPose(adb, { ...baseInput, maxPolls: 4 }, fake.deps);

    assert.equal(result.ok, true, label);
    assert.deepEqual(result.ack, good, label);
    assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 4, label);
    assertExactCleanup(fake.calls);
  }
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

test("HMD acknowledgement requires listener-derived sequence and ordered guest freshness clocks", async () => {
  const basePose = hmdAck().hmdPose;
  const invalidPoses = [
    { ...basePose, sampleSequence: undefined },
    { ...basePose, sampleSequence: "0" },
    { ...basePose, sampleObservedAtMonotonicNs: undefined },
    { ...basePose, sampleObservedAtMonotonicNs: "9877543210" },
  ];
  for (const invalidPose of invalidPoses) {
    const invalid = hmdAck({ hmdPose: invalidPose });
    const fake = fakeTransaction([invalid, invalid]);

    const result = await requestAgentBridgeHmdPose(adb, { ...baseInput, expectedRootGeneration: 7 }, fake.deps);

    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_ack");
    assert.match(result.primaryError, /HMD|sample|sequence|monotonic|schema/i);
    assertExactCleanup(fake.calls);
  }
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
  assertRouteOwnedCleanup(result, fake.calls);
});

test("locomotion requires an explicit route-owned nonce disposition before any transport", async () => {
  for (const deferNonceCleanup of [undefined, false]) {
    const input = { ...locomotionInput, deferNonceCleanup };
    const fake = fakeTransaction([locomotionAck(), locomotionAck()]);

    const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);

    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_request");
    assert.match(result.primaryError, /deferNonceCleanup|route.*cleanup|ownership/i);
    assert.equal(fake.calls.length, 0);
  }
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
  assertRouteOwnedCleanup(result, fake.calls);
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
    assertRouteOwnedCleanup(result, fake.calls);
  }
});

test("replacement success requires the next root generation and never accepts direct readback", async () => {
  const input = { ...locomotionInput, mode: "replacement", glideDurationMs: 0 };
  const ack = locomotionAck({
    mode: "replacement",
    glideDurationMs: 0,
    executionLeaseMs: 2_000,
    pose: { rootGeneration: 8, position: { x: 2, y: 0, z: -4 } },
  });
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);

  assert.equal(result.ok, true);
  assert.equal(result.ack.pose.rootGeneration, 8);
  assertRouteOwnedCleanup(result, fake.calls);
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
  test(`locomotion rejects substituted or stale ${name} acknowledgement and defers its cleanup`, async () => {
    const ack = locomotionAck();
    mutate(ack);
    const fake = fakeTransaction([ack, ack]);

    const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_ack");
    assert.match(result.primaryError, /acknowledgement|ack/i);
    assertRouteOwnedCleanup(result, fake.calls);
  });
}

test("a rejected guest result retains its primary failure and transfers nonce cleanup", async () => {
  const rejected = locomotionAck({ outcome: "rejected", pose: null, primaryError: "stale_generation" });
  const fake = fakeTransaction([rejected, rejected]);

  const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "guest_rejected");
  assert.equal(result.primaryError, "stale_generation");
  assert.equal(result.cleanupError, null);
  assertRouteOwnedCleanup(result, fake.calls);
});

test("guest cleanup failure remains visible while nonce cleanup stays route-owned", async () => {
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
  assertRouteOwnedCleanup(result, fake.calls);
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
  assertRouteOwnedCleanup(locomotionResult, locomotionFake.calls);
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
    { ...locomotionInput, rootIncarnation: "11111111-1111-1111-8111-111111111111" },
    { ...locomotionInput, physicalWalk: true },
  ]) {
    const fake = fakeTransaction([]);
    const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_request");
    assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 0);
    assert.equal(fake.calls.filter((call) => call.kind === "text" && call.args.includes("broadcast")).length, 0);
    assertRouteOwnedCleanup(result, fake.calls);
  }
});

test("finite doubles outside the Float32 transport domain are refused with route-owned cleanup before broadcast", async () => {
  const fake = fakeTransaction([]);

  const result = await requestAgentBridgeLocomotion(adb, {
    ...locomotionInput,
    target: { x: Number.MAX_VALUE, y: 0, z: -4 },
  }, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_request");
  assert.match(result.primaryError, /Float32/i);
  assert.equal(fake.calls.filter((call) => call.kind === "text" && call.args.includes("broadcast")).length, 0);
  assertRouteOwnedCleanup(result, fake.calls);
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

test("locomotion revision 1 binds one exact producer incarnation across capability, HMD, and locomotion", async () => {
  const capability = availableAck({
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: ROOT_INCARNATION },
  });
  const capabilityFake = fakeTransaction([capability, capability]);
  const capabilityResult = await probeAgentBridgeLocomotionCapability(adb, baseInput, capabilityFake.deps);
  assert.equal(capabilityResult.ok, true);
  assert.equal(capabilityResult.ack.root.incarnation, ROOT_INCARNATION);

  const sampled = hmdAck({
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: ROOT_INCARNATION },
  });
  const hmdFake = fakeTransaction([sampled, sampled]);
  const hmdResult = await requestAgentBridgeHmdPose(adb, {
    ...baseInput,
    expectedRootGeneration: 7,
    expectedRootIncarnation: ROOT_INCARNATION,
  }, hmdFake.deps);
  assert.equal(hmdResult.ok, true);
  const hmdBroadcast = hmdFake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast"));
  assert.deepEqual(hmdBroadcast.args.slice(hmdBroadcast.args.indexOf("rootIncarnation") - 1, hmdBroadcast.args.indexOf("rootIncarnation") + 2), [
    "--es", "rootIncarnation", ROOT_INCARNATION,
  ]);

  const moved = locomotionAck({
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: ROOT_INCARNATION },
  });
  const locomotionFake = fakeTransaction([moved, moved]);
  const locomotionResult = await requestAgentBridgeLocomotion(adb, {
    ...locomotionInput,
    rootIncarnation: ROOT_INCARNATION,
  }, locomotionFake.deps);
  assert.equal(locomotionResult.ok, true);
  const moveBroadcast = locomotionFake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast"));
  assert.deepEqual(moveBroadcast.args.slice(moveBroadcast.args.indexOf("rootIncarnation") - 1, moveBroadcast.args.indexOf("rootIncarnation") + 2), [
    "--es", "rootIncarnation", ROOT_INCARNATION,
  ]);
});

test("HMD rejects a non-v4 producer identity before broadcast", async () => {
  const fake = fakeTransaction([]);
  const result = await requestAgentBridgeHmdPose(adb, {
    ...baseInput,
    expectedRootGeneration: 7,
    expectedRootIncarnation: "11111111-1111-1111-8111-111111111111",
  }, fake.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_request");
  assert.match(result.primaryError, /UUID|identity|incarnation/i);
  assert.equal(fake.calls.filter((call) => call.kind === "text" && call.args.includes("broadcast")).length, 0);
  assertExactCleanup(fake.calls);
});

test("HMD and locomotion reject a same-generation acknowledgement from another producer incarnation", async () => {
  const sampled = hmdAck({
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: REPLACEMENT_INCARNATION },
  });
  const hmdFake = fakeTransaction([sampled, sampled]);
  const hmdResult = await requestAgentBridgeHmdPose(adb, {
    ...baseInput,
    expectedRootGeneration: 7,
    expectedRootIncarnation: ROOT_INCARNATION,
  }, hmdFake.deps);
  assert.equal(hmdResult.ok, false);
  assert.equal(hmdResult.code, "invalid_ack");
  assert.match(hmdResult.primaryError, /incarnation/i);

  const moved = locomotionAck({
    root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7, incarnation: REPLACEMENT_INCARNATION },
  });
  const moveFake = fakeTransaction([moved, moved]);
  const moveResult = await requestAgentBridgeLocomotion(adb, {
    ...locomotionInput,
    rootIncarnation: ROOT_INCARNATION,
  }, moveFake.deps);
  assert.equal(moveResult.ok, false);
  assert.equal(moveResult.code, "invalid_ack");
  assert.match(moveResult.primaryError, /incarnation/i);
});

test("AgentBridge transaction deadline reserves valid cleanup and starts no later non-cleanup effect", async () => {
  let nowNs = 0n;
  const calls = [];
  const deps = {
    monotonicNs: () => nowNs,
    sleep: async (durationMs) => {
      calls.push({ kind: "sleep", startedAt: nowNs, durationMs });
      nowNs += BigInt(durationMs) * 1_000_000n;
    },
    runText: async (_cmd, args, options) => {
      const cleanup = args.includes("rm");
      calls.push({ kind: cleanup ? "cleanup" : "broadcast", startedAt: nowNs, options });
      if (!cleanup) nowNs += 2_000_000_000n;
      return cleanup ? cleanupOk : textOk;
    },
    runBytes: async (_cmd, _args, options) => {
      calls.push({ kind: "pull", startedAt: nowNs, options });
      return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
    },
  };
  const result = await requestAgentBridgeHmdPose(adb, {
    ...baseInput,
    deadlineMonotonicNs: "3000000000",
  }, deps);
  assert.equal(result.ok, false);
  assert.equal(calls.filter((call) => call.kind === "pull").length, 0);
  assert.equal(calls.filter((call) => call.kind === "cleanup").length, 1);
  assert.ok(calls.filter((call) => call.kind !== "cleanup").every((call) => call.startedAt < 3_000_000_000n));
  assert.ok(calls.every((call) => call.kind === "sleep" || (call.options.timeoutMs >= (call.kind === "pull" ? 250 : 1_000)
    && call.options.timeoutMs <= Number((3_000_000_000n - call.startedAt) / 1_000_000n))));
});

test("AgentBridge refuses an impossible deadline envelope before broadcast and never uses a 15s invalid fallback", async () => {
  for (const input of [
    { ...baseInput, deadlineMonotonicNs: "2000000000" },
    { ...baseInput, controlTimeoutMs: 999, deadlineMonotonicNs: "2000000000" },
  ]) {
    let nowNs = 0n;
    const calls = [];
    const deps = {
      monotonicNs: () => nowNs,
      sleep: async () => { throw new Error("sleep must not run"); },
      runBytes: async () => { throw new Error("pull must not run"); },
      runText: async (_cmd, args, options) => {
        calls.push({ args, options, startedAt: nowNs });
        return cleanupOk;
      },
    };
    const result = await probeAgentBridgeLocomotionCapability(adb, input, deps);
    assert.equal(result.ok, false);
    assert.equal(calls.some((call) => call.args.includes("broadcast")), false);
    assert.equal(calls.filter((call) => call.args.includes("rm")).length, 1);
    assert.ok(calls[0].options.timeoutMs >= 1_000 && calls[0].options.timeoutMs <= 2_000);
    assert.notEqual(calls[0].options.timeoutMs, 15_000);
  }
});

test("production locomotion composites recompute one injected absolute deadline before every spawn and sleep", async (t) => {
  let resolverCalls = 0;
  let nowNs = 0n;
  const effects = [];
  const live = worldLocomotion.createLiveInAppLocomotionDependencies({
    resolveAdb: () => { resolverCalls += 1; return "/fixture/injected-adb"; },
    monotonicNs: () => nowNs,
    sleep: async (durationMs) => {
      effects.push({ kind: "sleep", startedAt: nowNs, durationMs });
      nowNs += BigInt(durationMs) * 1_000_000n;
    },
    runText: async (_cmd, args, options) => {
      effects.push({ kind: "run", args, options, startedAt: nowNs });
      nowNs += 600_000_000n;
      return { code: 0, stdout: args.includes("ConfigurationService")
        ? '[{"keyName":"spatial_stage_style","keyValue":"3"},{"keyName":"spatial_safeguard_enable","keyValue":"1"},{"keyName":"spatial_safeguard_center","keyValue":"0,0,0"},{"keyName":"spatial_virtual_content_detected","keyValue":"1"}]'
        : "1", stderr: "", timedOut: false };
    },
    runBytes: async () => { throw new Error("binary runner must not be used by safety sample"); },
  });
  assert.equal(resolverCalls, 1, "the injected adapter must resolve no ambient adb path");
  await assert.rejects(live.sampleSafety({
    serial: "emulator-5554",
    phase: "deadline_fixture",
    timeoutMs: 1_500,
    deadlineMonotonicNs: "1500000000",
  }), /deadline|budget|remaining/i);
  assert.ok(effects.length > 0);
  assert.ok(effects.every((effect) => effect.startedAt < 1_500_000_000n));
  assert.ok(effects.filter((effect) => effect.kind === "run").every((effect) =>
    effect.options.timeoutMs <= Number((1_500_000_000n - effect.startedAt) / 1_000_000n)));

  effects.length = 0;
  nowNs = 0n;
  await assert.rejects(live.monitorFreshLaunch({
    serial: "emulator-5554",
    runId: HASH,
    artifactRoot: externalArtifactRoot(t, "live-monitor-deadline"),
    minimumDurationMs: 60_000,
    healthBoundaryMarker: "PICO_LOCOMOTION_FIXTURE_PREPARE_BEGIN",
    runtime: {
      liveIdentity: { serial: "emulator-5554", model: "PICO", fingerprint: "fixture", bootQemu: "1", bootId: "boot", observedAt: "2026-09-02T12:00:00.000Z" },
      applicationBinding: { packageName: "com.test.fullworld", apkSha256: "b".repeat(64), allowedResumedComponents: ["com.test.fullworld/.platform.LaunchActivity"], pid: 5151, pidStartTicks: "123" },
      foregroundComponent: "com.test.fullworld/.platform.LaunchActivity",
    },
    timeoutMs: 5_000,
    deadlineMonotonicNs: "5000000000",
  }), /deadline|budget|60/i);
  assert.ok(effects.every((effect) => effect.startedAt < 5_000_000_000n));
  assert.ok(effects.filter((effect) => effect.kind === "sleep").every((effect) => effect.durationMs <= 5_000));
});

function deferredUnquiescedResult(input, detail = "guest cancellation barrier was not proven") {
  return {
    ok: false,
    code: "bridge_unavailable",
    detail,
    primaryError: detail,
    cleanupError: "locomotion nonce cleanup is deferred until the owned target is stopped",
    motionQuiesced: false,
    nonceCleanup: {
      status: "deferred_until_stop",
      requestId: input.requestId,
      relativePath: `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${input.requestId}.json`,
      attempts: 0,
    },
    actionReceipts: [],
    evidenceCeiling: "structural",
  };
}

function routeOwnedCompletedResult(input) {
  return {
    ...completedMovementResult(input),
    nonceCleanup: routeOwnedNonceDisposition(input),
  };
}

test("every deferred locomote result must transfer the exact nonce disposition before route progress", async (t) => {
  assert.equal(AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY, "agentbridge/locomotion");
  const cases = [
    ["omitted", (input) => {
      const result = completedMovementResult(input);
      delete result.nonceCleanup;
      return result;
    }],
    ["wrong status", (input) => ({
      ...completedMovementResult(input),
      nonceCleanup: { ...routeOwnedNonceDisposition(input), status: "removed_and_absent" },
    })],
    ["wrong request", (input) => ({
      ...completedMovementResult(input),
      nonceCleanup: { ...routeOwnedNonceDisposition(input), requestId: `wrong_${input.requestId}` },
    })],
    ["wrong path", (input) => ({
      ...completedMovementResult(input),
      nonceCleanup: { ...routeOwnedNonceDisposition(input), relativePath: `cache/pico-agent-locomotion/${input.requestId}.json` },
    })],
    ["wrong attempts", (input) => ({
      ...completedMovementResult(input),
      nonceCleanup: { ...routeOwnedNonceDisposition(input), attempts: 1 },
    })],
    ["unexpected finalization", (input) => ({
      ...completedMovementResult(input),
      nonceCleanup: { ...routeOwnedNonceDisposition(input), finalizationSha256: "d".repeat(64) },
    })],
    ["unexpected removal warning", (input) => ({
      ...completedMovementResult(input),
      nonceCleanup: { ...routeOwnedNonceDisposition(input), removalError: "no removal belongs to an attempts-zero disposition" },
    })],
  ];
  for (const [label, locomotionResult] of cases) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t, { locomotionResult });
      fixture.calls.length = 0;

      const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

      assert.equal(stopped.status, "stopped");
      assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /nonce|cleanup|ownership|disposition/i);
      assert.equal(fixture.calls.some((call) => call.kind === "capture"), false);
      const effects = fixture.calls.filter((call) => ["locomote", "stop", "nonceCleanup"].includes(call.kind));
      assert.deepEqual(effects.map((call) => call.kind), ["locomote", "stop"]);
      assert.equal(effects[1].context.reason, "step_unquiesced_locomotion");
      const stepAction = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(stepAction.locomotionNonceCleanup, null);

      fixture.calls.length = 0;
      const restored = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
      });
      assert.equal(restored.status, "restore_failed");
      assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
      const finalProcessIndex = fixture.calls.findIndex((call) => call.kind === "finalProcess");
      const nonceCleanupIndex = fixture.calls.findIndex((call) => call.kind === "nonceCleanup");
      assert.ok(finalProcessIndex >= 0 && nonceCleanupIndex > finalProcessIndex);
      const cleanup = fixture.calls[nonceCleanupIndex];
      assert.equal(cleanup.context.processStopped, true);
      assert.equal(cleanup.context.probeOnly, undefined);
      const restoreAction = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.deepEqual(restoreAction.locomotionNonceCleanup, successfulNonceCleanupReceipt(cleanup.context));
    });
  }
});

test("an unquiesced deferred disposition cannot claim finalization or removal", async (t) => {
  for (const [label, extra] of [
    ["finalization", { finalizationSha256: "d".repeat(64) }],
    ["removal", { removalError: "no removal belongs to an attempts-zero disposition" }],
  ]) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t, {
        locomotionResult: (input) => {
          const result = deferredUnquiescedResult(input);
          return { ...result, nonceCleanup: { ...result.nonceCleanup, ...extra } };
        },
      });
      fixture.calls.length = 0;

      const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

      assert.equal(stopped.status, "stopped");
      assert.match(stopped.primaryError, /exact deferred_until_stop nonce ownership disposition/i);
      assert.equal(fixture.calls.some((call) => call.kind === "capture"), false);
      assert.deepEqual(
        fixture.calls.filter((call) => ["locomote", "stop", "nonceCleanup"].includes(call.kind)).map((call) => call.kind),
        ["locomote", "stop"],
      );

      fixture.calls.length = 0;
      const restored = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
      });
      assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
      const finalProcessIndex = fixture.calls.findIndex((call) => call.kind === "finalProcess");
      const nonceCleanupIndex = fixture.calls.findIndex((call) => call.kind === "nonceCleanup");
      assert.ok(finalProcessIndex >= 0 && nonceCleanupIndex > finalProcessIndex);
      assert.equal(fixture.calls[nonceCleanupIndex].context.processStopped, true);
    });
  }
});

test("live nonce cleanup must prove exact one-removal absence and finalization before pending ownership clears", async (t) => {
  const cases = [
    ["wrong status", (receipt) => ({ ...receipt, status: "route_owned" })],
    ["wrong request", (receipt) => ({ ...receipt, requestId: `wrong_${receipt.requestId}` })],
    ["wrong path", (receipt) => ({ ...receipt, relativePath: `cache/pico-agent-locomotion/${receipt.requestId}.json` })],
    ["zero attempts", (receipt) => ({ ...receipt, attempts: 0 })],
    ["two attempts", (receipt) => ({ ...receipt, attempts: 2 })],
    ["missing finalization", (receipt) => {
      const malformed = { ...receipt };
      delete malformed.finalizationSha256;
      return malformed;
    }],
    ["non-lowercase finalization", (receipt) => ({ ...receipt, finalizationSha256: "D".repeat(64) })],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      const fixture = await prepareForSteps(t, { locomotionResult: routeOwnedCompletedResult });
      let cleanupCalls = 0;
      fixture.dependencies.cleanupLocomotionNonce = async (context) => {
        fixture.calls.push({ kind: "nonceCleanup", context });
        cleanupCalls++;
        const valid = successfulNonceCleanupReceipt(context);
        return cleanupCalls === 1 ? mutate(valid) : valid;
      };
      fixture.calls.length = 0;

      const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

      assert.equal(stopped.status, "stopped");
      assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /nonce|cleanup|finalization|absence|attempt/i);
      assert.equal(fixture.calls.some((call) => call.kind === "capture"), false);
      const liveCleanups = fixture.calls.filter((call) => call.kind === "nonceCleanup");
      assert.equal(liveCleanups.length, 1);
      assert.equal(liveCleanups[0].context.processStopped, undefined);
      assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
      const stepAction = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(stepAction.locomotionNonceCleanup, null);

      fixture.calls.length = 0;
      const restored = await fixture.orchestrator.execute({
        action: "restore",
        runId: fixture.prepared.runId,
        reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
      });
      assert.equal(restored.status, "restore_failed");
      assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
      const recovery = fixture.calls.filter((call) => call.kind === "nonceCleanup");
      assert.equal(recovery.length, 1);
      assert.equal(recovery[0].context.processStopped, true);
      assert.equal(recovery[0].context.probeOnly, true, "an invoked cleanup may never authorize a second removal");
      const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).at(-1);
      assert.deepEqual(action.locomotionNonceCleanup, successfulNonceCleanupReceipt(recovery[0].context));
      assert.equal("finalizationSha256" in action.locomotionNonceCleanup, false,
        "a proven process stop replaces live guest finalization");
    });
  }
});

test("restore retains nonce ownership when its deferred disposition is omitted", async (t) => {
  const fixture = await prepareForSteps(t);
  fixture.dependencies.requestLocomotion = async (input) => {
    fixture.calls.push({ kind: "locomote", input });
    const result = completedMovementResult(input);
    delete result.nonceCleanup;
    return result;
  };
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });

  assert.equal(restored.status, "restore_failed");
  assert.match(restored.primaryError, /nonce|cleanup|ownership|disposition/i);
  assert.equal(fixture.calls.some((call) => call.kind === "capture"), false);
  const effects = fixture.calls.filter((call) => ["locomote", "stop", "nonceCleanup"].includes(call.kind));
  assert.deepEqual(effects.map((call) => call.kind), ["locomote", "stop", "nonceCleanup"]);
  assert.equal(effects[2].context.processStopped, true);
  assert.equal(effects[2].context.probeOnly, undefined);
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.deepEqual(action.locomotionNonceCleanup, successfulNonceCleanupReceipt(effects[2].context));
});

test("restore keeps malformed live cleanup owned and recovers only by a post-stop absence probe", async (t) => {
  const fixture = await prepareForSteps(t, { locomotionResult: routeOwnedCompletedResult });
  let cleanupCalls = 0;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    fixture.calls.push({ kind: "nonceCleanup", context });
    cleanupCalls++;
    const receipt = successfulNonceCleanupReceipt(context);
    if (cleanupCalls === 1) delete receipt.finalizationSha256;
    return receipt;
  };
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.baselineReview),
  });

  assert.equal(restored.status, "restore_failed");
  assert.match(restored.primaryError, /finalization|nonce|cleanup/i);
  assert.equal(fixture.calls.some((call) => call.kind === "capture"), false);
  const cleanups = fixture.calls.filter((call) => call.kind === "nonceCleanup");
  assert.equal(cleanups.length, 2);
  assert.equal(cleanups[0].context.processStopped, undefined);
  assert.equal(cleanups[1].context.processStopped, true);
  assert.equal(cleanups[1].context.probeOnly, true);
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.deepEqual(action.locomotionNonceCleanup, successfulNonceCleanupReceipt(cleanups[1].context));
});

test("stopped-process cleanup forbids finalization evidence and converges through probe-only recovery", async (t) => {
  const fixture = await prepareForSteps(t, {
    locomotionResult: (input) => {
      const result = completedMovementResult(input);
      delete result.nonceCleanup;
      return result;
    },
  });
  let cleanupCalls = 0;
  let removalAttempts = 0;
  let restoreNowNs = null;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    fixture.calls.push({ kind: "nonceCleanup", context });
    cleanupCalls++;
    if (context.probeOnly !== true) removalAttempts++;
    const receipt = successfulNonceCleanupReceipt(context);
    if (context.processStopped === true && restoreNowNs !== null) {
      restoreNowNs = BigInt(context.deadlineMonotonicNs) - 1n;
    }
    return cleanupCalls === 1 ? { ...receipt, finalizationSha256: "d".repeat(64) } : receipt;
  };
  fixture.calls.length = 0;

  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(stopped.status, "stopped");
  assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /nonce|cleanup|finalization|absence/i);
  assert.equal(cleanupCalls, 0, "the step cannot clean until restore proves exact target absence");
  const stepAction = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(stepAction.locomotionNonceCleanup, null, "an impossible stopped-process SHA is not retained as proof");

  fixture.calls.length = 0;
  restoreNowNs = 2_000_000_000n;
  fixture.dependencies.monotonicNs = () => restoreNowNs++;
  const firstRestore = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });

  assert.equal(firstRestore.status, "restore_failed");
  assert.equal(firstRestore.restorationDisposition, "unresolved");
  assert.match(firstRestore.cleanupError, /nonce|finalization/i);
  const firstRecovery = fixture.calls.filter((call) => call.kind === "nonceCleanup");
  assert.equal(firstRecovery.length, 1);
  assert.equal(firstRecovery[0].context.processStopped, true);
  assert.equal(firstRecovery[0].context.probeOnly, undefined);
  assert.equal(removalAttempts, 1, "the first process-stopped cleanup owns the sole removal attempt");
  const targetAbsenceDeadline = BigInt(fixture.calls.find((call) => call.kind === "finalProcess").context.deadlineMonotonicNs);
  const stoppedNonceDeadline = BigInt(firstRecovery[0].context.deadlineMonotonicNs);
  assert.ok(stoppedNonceDeadline - targetAbsenceDeadline >= 2_851_000_000n,
    "stopped-process nonce recovery owns its complete independent deadline window");

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(firstRestore.requiredReview[0]),
  });
  assert.equal(restored.status, "restore_failed");
  assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
  assert.equal(restored.cleanupError, null);
  const recovery = fixture.calls.filter((call) => call.kind === "nonceCleanup");
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].context.processStopped, true);
  assert.equal(recovery[0].context.probeOnly, true);
  assert.equal(removalAttempts, 1, "the retry only probes after the sole removal attempt");
  const restoreAction = committedActionPayloads(fixture.input.artifactRoot).at(-1);
  assert.deepEqual(restoreAction.locomotionNonceCleanup, successfulNonceCleanupReceipt(recovery[0].context));
});

test("removed-and-absent cleanup retains an rm warning without reopening nonce ownership", async (t) => {
  const fixture = await prepareForSteps(t, { locomotionResult: routeOwnedCompletedResult });
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    fixture.calls.push({ kind: "nonceCleanup", context });
    return { ...successfulNonceCleanupReceipt(context), removalError: "rm timed out before exact absence was observed" };
  };
  fixture.calls.length = 0;

  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(stopped.status, "stopped");
  assert.match(stopped.cleanupError, /rm timed out before exact absence was observed/i);
  const requestId = fixture.calls.find((call) => call.kind === "locomote").input.requestId;
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup" && call.context.requestId === requestId).length, 1);
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(action.locomotionNonceCleanup.removalError, "rm timed out before exact absence was observed");
});

test("launch-handoff observation owns every blocking preflight and the HMD-to-monitor-sample-zero handoff", async (t) => {
  for (const phase of ["runtime", "capability", "monitor_handoff"]) {
    await t.test(phase, async (t) => {
      const fixture = await createPreparedFixture(t, { handoffDialogDuring: phase });
      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "preparation_failed");
      assert.match(`${result.primaryError} ${result.cleanupError}`, /dialog|handoff|window/i);
      const kinds = fixture.calls.map((call) => call.kind);
      assert.ok(kinds.indexOf("launchObservation") > kinds.indexOf("launch"));
      assert.ok(kinds.indexOf("launchObservation") < kinds.indexOf("probeRuntime"));
      assert.equal(kinds.filter((kind) => kind === "monitor").length, 1, "monitor sample zero owns the observer handoff");
      assert.equal(kinds.includes("capture"), false, "a sampled handoff dialog must stop before baseline capture");
      assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
    });
  }
});

test("launch-handoff cadence is reproduced from monotonic sample timestamps, not a claimed elapsed counter", async (t) => {
  const fixture = await createPreparedFixture(t, { handoffObservationTimestampOffsetAfterFirstMs: 20 });

  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);

  assert.equal(result.status, "preparation_failed");
  assert.match(`${result.primaryError} ${result.cleanupError}`, /maximum sample gap|cadence/i);
  assert.equal(fixture.calls.some((call) => call.kind === "capture"), false);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop" && call.context.reason === "prepare_failure_cleanup").length, 1);
});

test("post-request deadline failure defers nonce cleanup until restore proves target absence", async (t) => {
  const fixture = await prepareForSteps(t);
  let clockBroken = false;
  let tick = 50_000_000_000n;
  fixture.dependencies.monotonicNs = () => {
    if (clockBroken) throw new Error("post-request route clock failed");
    return ++tick;
  };
  fixture.dependencies.requestLocomotion = async (input) => {
    fixture.calls.push({ kind: "locomote", input });
    const result = deferredUnquiescedResult(input);
    clockBroken = true;
    return result;
  };
  fixture.calls.length = 0;

  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(stopped.status, "stopped");
  assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /clock|barrier|deferred/i);
  const effects = fixture.calls.filter((call) => call.kind === "locomote" || call.kind === "stop" || call.kind === "nonceCleanup");
  assert.deepEqual(effects.map((call) => call.kind), ["locomote", "stop"]);
  assert.equal(effects[1].context.reason, "step_unquiesced_locomotion");

  clockBroken = false;
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
  const cleanup = fixture.calls.find((call) => call.kind === "nonceCleanup");
  assert.equal(cleanup.context.requestId, effects[0].input.requestId);
  assert.equal(cleanup.context.processStopped, true);
  assert.ok(fixture.calls.indexOf(cleanup) > fixture.calls.findIndex((call) => call.kind === "finalProcess"));
});

test("post-request clock failure retains a terminal but not-yet-finalized nonce for restore", async (t) => {
  const fixture = await prepareForSteps(t);
  let clockBroken = false;
  let tick = 60_000_000_000n;
  fixture.dependencies.monotonicNs = () => {
    if (clockBroken) throw new Error("post-quiescence route clock failed");
    return ++tick;
  };
  fixture.dependencies.requestLocomotion = async (input) => {
    fixture.calls.push({ kind: "locomote", input });
    const result = routeOwnedCompletedResult(input);
    clockBroken = true;
    return result;
  };
  fixture.calls.length = 0;

  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(stopped.status, "stopped");
  assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /post-quiescence route clock failed/i);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup").length, 0);
  const requestId = fixture.calls.find((call) => call.kind === "locomote").input.requestId;

  clockBroken = false;
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
  const cleanup = fixture.calls.find((call) => call.kind === "nonceCleanup");
  assert.equal(cleanup.context.processStopped, true);
  assert.equal(cleanup.context.requestId, requestId);
});

test("a pre-removal finalization failure defers the sole removal until restore proves target absence", async (t) => {
  const fixture = await prepareForSteps(t, {
    locomotionResult: routeOwnedCompletedResult,
  });
  let removalAttempts = 0;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    fixture.calls.push({ kind: "nonceCleanup", context });
    if (context.processStopped !== true) {
      throw new AgentBridgeLocomotionNonceCleanupError("injected finalization barrier failure before removal", {
        finalizationProven: false,
        removalStarted: false,
      });
    }
    assert.equal(context.probeOnly, undefined);
    removalAttempts++;
    return successfulNonceCleanupReceipt(context);
  };
  fixture.calls.length = 0;
  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stopped.status, "stopped");
  assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /finalization barrier failure/i);
  assert.deepEqual(
    fixture.calls.filter((call) => ["locomote", "nonceCleanup", "stop"].includes(call.kind)).map((call) => call.kind),
    ["locomote", "nonceCleanup", "stop"],
  );
  assert.equal(removalAttempts, 0, "failure before removal preserves one restore-owned removal");

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
  const cleanup = fixture.calls.find((call) => call.kind === "nonceCleanup");
  assert.equal(cleanup.context.processStopped, true);
  assert.equal(cleanup.context.probeOnly, undefined);
  assert.ok(fixture.calls.indexOf(cleanup) > fixture.calls.findIndex((call) => call.kind === "finalProcess"));
  assert.equal(removalAttempts, 1, "restore performs exactly the one preserved removal");
});

test("a started removal with an unproven absence gets probe-only recovery and never a second rm", async (t) => {
  const fixture = await prepareForSteps(t, { locomotionResult: routeOwnedCompletedResult });
  let removalAttempts = 0;
  let probeOnlyAttempts = 0;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    fixture.calls.push({ kind: "nonceCleanup", context });
    if (context.probeOnly === true) {
      probeOnlyAttempts++;
      if (probeOnlyAttempts === 1) {
        throw new AgentBridgeLocomotionNonceCleanupError("injected absence probe remained ambiguous", {
          finalizationProven: true,
          removalStarted: true,
        });
      }
      return successfulNonceCleanupReceipt(context);
    }
    removalAttempts++;
    throw new AgentBridgeLocomotionNonceCleanupError("injected post-rm absence failure", {
      finalizationProven: true,
      removalStarted: true,
    });
  };
  fixture.calls.length = 0;
  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stopped.status, "stopped");
  assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /post-rm|absence/i);
  assert.equal(removalAttempts, 1);
  assert.equal(probeOnlyAttempts, 0);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup").length, 1);

  fixture.calls.length = 0;
  const firstRestore = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(firstRestore.status, "restore_failed");
  assert.equal(firstRestore.restorationDisposition, "unresolved");
  assert.match(firstRestore.cleanupError, /absence probe remained ambiguous/i);
  assert.equal(fixture.calls.some((call) => call.kind === "capability" || call.kind === "hmd" || call.kind === "locomote"), false);
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup").length, 1);
  assert.equal(fixture.calls.find((call) => call.kind === "nonceCleanup").context.probeOnly, true);
  assert.equal(removalAttempts, 1, "restore must not issue a second removal");
  assert.equal(probeOnlyAttempts, 1);

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(firstRestore.requiredReview[0]),
  });
  assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup").length, 1);
  assert.equal(fixture.calls.find((call) => call.kind === "nonceCleanup").context.probeOnly, true);
  assert.equal(removalAttempts, 1, "retry must not issue a second removal");
  assert.equal(probeOnlyAttempts, 2);
});

test("a spoofed cleanup error cannot authorize a second removal", async (t) => {
  const fixture = await prepareForSteps(t, { locomotionResult: routeOwnedCompletedResult });
  let removalAttempts = 0;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    fixture.calls.push({ kind: "nonceCleanup", context });
    if (context.probeOnly === true) return successfulNonceCleanupReceipt(context);
    removalAttempts++;
    throw Object.assign(new Error("untyped post-rm failure spoofed a pre-rm disposition"), {
      finalizationProven: false,
      removalStarted: false,
      absenceProven: false,
    });
  };
  fixture.calls.length = 0;

  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));

  assert.equal(stopped.status, "stopped");
  assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /spoofed a pre-rm disposition/i);
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup").length, 1);
  assert.equal(removalAttempts, 1, "an untyped failure can never authorize another rm");

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
  const cleanups = fixture.calls.filter((call) => call.kind === "nonceCleanup");
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0].context.processStopped, true);
  assert.equal(cleanups[0].context.probeOnly, true, "only the authentic cleanup error class can prove removal never began");
  assert.equal(removalAttempts, 1, "restore may only probe after the untyped failure");
  const action = fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).at(-1);
  assert.deepEqual(action.locomotionNonceCleanup, successfulNonceCleanupReceipt(cleanups[0].context));
});

test("nonce cleanup disposition is retained inside the deadline callback before a post-await clock fault", async (t) => {
  const fixture = await prepareForSteps(t, { locomotionResult: routeOwnedCompletedResult });
  let clockBroken = false;
  let tick = 70_000_000_000n;
  fixture.dependencies.monotonicNs = () => {
    if (clockBroken) throw new Error("post-cleanup route clock failed");
    return ++tick;
  };
  const originalCleanup = fixture.dependencies.cleanupLocomotionNonce;
  fixture.dependencies.cleanupLocomotionNonce = async (context) => {
    const receipt = await originalCleanup(context);
    if (context.requestId.startsWith("step_")) clockBroken = true;
    return receipt;
  };
  fixture.calls.length = 0;
  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stopped.status, "stopped");
  assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /post-cleanup route clock failed/i);
  const stepRequestId = fixture.calls.find((call) => call.kind === "locomote").input.requestId;
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup" && call.context.requestId === stepRequestId).length, 1);

  clockBroken = false;
  fixture.calls.length = 0;
  await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup" && call.context.requestId === stepRequestId).length, 0);
  assert.equal(fixture.calls.filter((call) => call.kind === "nonceCleanup").length, 1, "restore owns only its distinct nonce");
});

test("failed emergency stop persists unquiesced ownership and restore is cleanup-only", async (t) => {
  const fixture = await prepareForSteps(t);
  fixture.dependencies.requestLocomotion = async (input) => {
    fixture.calls.push({ kind: "locomote", input });
    return deferredUnquiescedResult(input);
  };
  let failedOnce = false;
  fixture.dependencies.stopPackage = async (context) => {
    fixture.calls.push({ kind: "stop", context });
    if (context.reason === "step_unquiesced_locomotion" && !failedOnce) {
      failedOnce = true;
      throw new Error("injected emergency stop failure");
    }
    return completedStopReceipt(context);
  };
  const stopped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.cleanupError, /emergency stop failure/i);
  assert.equal(fixture.calls.some((call) => call.kind === "nonceCleanup"), false, "nonce must remain while a guest writer may live");

  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.status, "restore_failed");
  assert.equal(restored.restorationDisposition, "safe_release_without_zero_proof");
  assert.match(restored.primaryError, /zero-offset|restoration/i);
  assert.equal(restored.cleanupError, null);
  assert.equal(fixture.calls.some((call) => call.kind === "capability" || call.kind === "hmd" || call.kind === "locomote"), false);
  assert.deepEqual(
    fixture.calls.filter((call) => ["stop", "nonceCleanup", "finalProcess", "safety"].includes(call.kind)).map((call) => call.kind),
    ["stop", "finalProcess", "nonceCleanup", "safety"],
  );
  assert.equal(fixture.calls.find((call) => call.kind === "stop").context.reason, "restore_unquiesced_target");
});

test("restore owns cleanup before a permanently failing entry clock", async (t) => {
  const fixture = await prepareForSteps(t);
  const stepped = await fixture.orchestrator.execute(stepRequest(fixture, reviewFor(fixture.baselineReview)));
  assert.equal(stepped.status, "needs_waypoint_review");
  const adbEffects = [];
  const live = worldLocomotion.createLiveInAppLocomotionDependencies({
    resolveAdb: () => "/fixture/injected-adb",
    monotonicNs: () => { throw new Error("permanent restore entry clock fault"); },
    sleep: async () => {},
    runText: async (_cmd, args, options) => {
      adbEffects.push({ args, options });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
    runBytes: async () => { throw new Error("binary runner is unused"); },
  });
  fixture.dependencies.monotonicNs = () => { throw new Error("permanent restore entry clock fault"); };
  fixture.dependencies.stopPackage = live.stopPackage;
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(stepped.requiredReview[0]),
  });

  assert.equal(restored.status, "restore_failed");
  assert.match(restored.primaryError, /entry clock fault/i);
  assert.equal(fixture.calls.some((call) => call.kind === "capability" || call.kind === "locomote" || call.kind === "capture"), false);
  assert.equal(adbEffects.filter((effect) => effect.args.includes("force-stop")).length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "finalProcess").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "safety").length, 1);
});

test("exact zero-baseline image corruption remains retryable after cleanup", async (t) => {
  const fixture = await createPreparedFixture(t);
  fixture.orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
  fixture.prepared = await fixture.orchestrator.execute(fixture.input);
  const baseline = fixture.prepared.requiredReview[0];
  const originalBaseline = fs.readFileSync(baseline.path);
  fs.writeFileSync(baseline.path, makePng(126));
  fixture.calls.length = 0;
  const restored = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(baseline),
  });
  assert.equal(restored.status, "restore_failed");
  assert.deepEqual(restored.requiredReview, []);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
  assert.equal(fixture.calls.filter((call) => call.kind === "finalProcess").length, 1);
  fs.writeFileSync(baseline.path, originalBaseline);
  fixture.calls.length = 0;
  const retried = await fixture.orchestrator.execute({
    action: "restore", runId: fixture.prepared.runId, reviewedPriorFrame: reviewFor(baseline),
  });
  assert.equal(retried.status, "restored_needs_review");
  assert.equal(retried.primaryError, null);
  assert.equal(fixture.calls.some((call) => call.kind === "stop"), false);
});

test("cancel polling ignores stable stale execute bytes until an exact cancel barrier", async () => {
  const input = {
    ...locomotionInput,
    glideDurationMs: 0,
    maxPolls: 2,
    pollMs: 10,
    deferNonceCleanup: true,
  };
  const staleExecute = Buffer.from(JSON.stringify(locomotionAck({
    requestId: input.requestId,
    tag: input.tag,
    glideDurationMs: 0,
    executionLeaseMs: 2_000,
  })));
  const cancel = Buffer.from(JSON.stringify(cancelAckFor(input)));
  let cancelSeen = false;
  let executePulls = 0;
  let cancelPulls = 0;
  const calls = [];
  const result = await requestAgentBridgeLocomotion(adb, input, {
    monotonicNs: (() => { let tick = 0n; return () => ++tick; })(),
    sleep: async () => {},
    runText: async (_cmd, args, options) => {
      const kind = args.includes("rm") ? "rm" : args.includes("cancel") ? "cancel" : "execute";
      calls.push({ kind, args, options });
      if (kind === "cancel") cancelSeen = true;
      return kind === "rm" ? cleanupOk : textOk;
    },
    runBytes: async () => {
      if (!cancelSeen) {
        executePulls += 1;
        return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
      }
      const payload = cancelPulls++ < 2 ? staleExecute : cancel;
      return { code: 0, stdout: Buffer.concat([Buffer.from([1]), payload]), stderr: "", timedOut: false };
    },
  });
  assert.equal(result.motionQuiesced, true);
  assert.equal(executePulls, 2);
  assert.equal(cancelPulls, 4);
  assert.equal(calls.filter((call) => call.kind === "rm").length, 0, "route owns the final locomote nonce cleanup");
  assert.equal(result.nonceCleanup.status, "route_owned");
});

test("locomotion request transfers the nonce without finalizing or removing it", async () => {
  const ack = locomotionAck();
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

  assert.equal(result.ok, true);
  assertRouteOwnedCleanup(result, fake.calls);
  assert.deepEqual(result.actionReceipts.map((receipt) => receipt.action), [
    "locomotion_broadcast", "locomotion_ack_pull",
  ]);
});

test("unproven cancellation defers final nonce removal until an owned stop", async () => {
  const input = { ...locomotionInput, maxPolls: 2, pollMs: 10, deferNonceCleanup: true };
  const calls = [];
  const result = await requestAgentBridgeLocomotion(adb, input, {
    monotonicNs: (() => { let tick = 0n; return () => ++tick; })(),
    sleep: async () => {},
    runText: async (_cmd, args, options) => {
      calls.push({ args, options });
      return args.includes("rm") ? cleanupOk : textOk;
    },
    runBytes: async () => ({ code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.motionQuiesced, false);
  assert.equal(result.nonceCleanup.status, "deferred_until_stop");
  assert.equal(calls.filter((call) => call.args.includes("rm")).length, 0);
});

test("route-owned locomotion never removes an unquiesced nonce ahead of a delayed cancel writer", async () => {
  const input = { ...locomotionInput, maxPolls: 2, pollMs: 10, deferNonceCleanup: true };
  const calls = [];
  const result = await requestAgentBridgeLocomotion(adb, input, {
    monotonicNs: (() => { let tick = 1n; return () => tick++; })(),
    sleep: async () => {},
    runText: async (_cmd, args, options) => {
      const kind = args.includes("rm") ? "rm" : args.includes("cancel") ? "cancel" : "execute";
      calls.push({ kind, args, options });
      return kind === "rm" ? cleanupOk : textOk;
    },
    runBytes: async () => ({ code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.motionQuiesced, false);
  assert.equal(result.nonceCleanup.status, "deferred_until_stop");
  assert.equal(calls.filter((call) => call.kind === "rm").length, 0,
    "only a proven guest fence or owned process stop may precede the sole removal");
});

test("a deferred locomote preflight failure remains route-owned and transport-free", async () => {
  const calls = [];
  const result = await requestAgentBridgeLocomotion(adb, {
    ...locomotionInput,
    target: { x: Number.MAX_VALUE, y: 0, z: 0 },
    deferNonceCleanup: true,
  }, {
    monotonicNs: () => 1n,
    sleep: async () => { throw new Error("sleep must not run"); },
    runText: async (_cmd, args) => { calls.push({ kind: "text", args }); return cleanupOk; },
    runBytes: async (_cmd, args) => { calls.push({ kind: "bytes", args }); return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_request");
  assert.equal(result.motionQuiesced, true);
  assert.equal(result.nonceCleanup.status, "route_owned");
  assert.equal(calls.length, 0);
});

test("exact locomotion nonce cleanup finalizes the original tuple before one removal and absence proof", async () => {
  const calls = [];
  const finalAck = Buffer.from(JSON.stringify(finalizeAckFor({
    ...baseInput,
    rootGeneration: 7,
    rootIncarnation: ROOT_INCARNATION,
  })), "utf8");
  let finalReads = 0;
  let guestState = "EXECUTE_TERMINAL";
  let publishedBytes = Buffer.from(JSON.stringify(locomotionAck()), "utf8");
  let guestWriterPublications = 0;
  const result = await agentBridge.cleanupAgentBridgeLocomotionNonce(adb, {
    serial: baseInput.serial,
    packageName: baseInput.packageName,
    requestId: baseInput.requestId,
    tag: baseInput.tag,
    rootGeneration: 7,
    rootIncarnation: ROOT_INCARNATION,
    controlTimeoutMs: 1_000,
    ackReadTimeoutMs: 250,
    pollMs: 1,
    stabilityReads: 2,
    deadlineMonotonicNs: "10000000000",
  }, {
    monotonicNs: (() => { let tick = 1n; return () => tick++; })(),
    sleep: async () => {},
    runText: async (_cmd, args, options) => {
      const kind = args.includes("requestControl") ? "finalize" : "rm";
      calls.push({ kind, args, options });
      if (kind === "finalize") {
        assert.equal(guestState, "EXECUTE_TERMINAL");
        guestState = "FINALIZED"; // Installed before final bytes become visible.
        publishedBytes = finalAck;
        guestWriterPublications++;
      } else {
        assert.equal(guestState, "FINALIZED", "host removal must follow the serialized final fence");
        publishedBytes = null;
      }
      return cleanupOk;
    },
    runBytes: async (_cmd, args, options) => {
      const kind = finalReads < 2 ? "finalize-read" : "verify";
      calls.push({ kind, args, options });
      if (finalReads++ < 2) {
        return { code: 0, stdout: Buffer.concat([Buffer.from([1]), publishedBytes]), stderr: "", timedOut: false };
      }
      return publishedBytes === null
        ? { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false }
        : { code: 0, stdout: Buffer.concat([Buffer.from([1]), publishedBytes]), stderr: "", timedOut: false };
    },
  });
  assert.equal(result.status, "removed_and_absent");
  assert.deepEqual(calls.map((call) => call.kind), ["finalize", "finalize-read", "finalize-read", "rm", "verify"]);
  assert.equal(calls.filter((call) => call.kind === "rm").length, 1);
  const finalize = calls[0].args;
  assert.ok(finalize.includes("finalize"));
  assert.ok(finalize.includes(ROOT_INCARNATION));
  const deliverAfterFinalization = (requestControl) => {
    assert.equal(guestState, "FINALIZED");
    assert.ok(["execute", "cancel", "finalize"].includes(requestControl));
    // The process-lifetime FINALIZED tombstone rejects every later delivery
    // before deletion/writer admission, including the exact repeated cancel.
  };
  deliverAfterFinalization("cancel");
  deliverAfterFinalization("finalize");
  deliverAfterFinalization("execute");
  assert.equal(publishedBytes, null, "no exact replay may resurrect the cleaned pathname");
  assert.equal(guestWriterPublications, 1, "the finalization writer is the last guest publication");
});

test("a failed sole removal still performs and retains the authoritative absence proof", async () => {
  let nowNs = 0n;
  const calls = [];
  const result = await agentBridge.cleanupAgentBridgeLocomotionNonce(adb, {
    serial: baseInput.serial,
    packageName: baseInput.packageName,
    requestId: baseInput.requestId,
    tag: baseInput.tag,
    rootGeneration: 7,
    rootIncarnation: ROOT_INCARNATION,
    controlTimeoutMs: 1_000,
    ackReadTimeoutMs: 250,
    pollMs: 1,
    stabilityReads: 2,
    deadlineMonotonicNs: "1250000000",
    processStopped: true,
  }, {
    monotonicNs: () => nowNs,
    sleep: async () => {},
    runText: async (_cmd, _args, options) => {
      calls.push({ kind: "rm", startedAt: nowNs, options });
      nowNs += BigInt(options.timeoutMs) * 1_000_000n;
      return { code: 1, stdout: "", stderr: "injected rm error", timedOut: false };
    },
    runBytes: async (_cmd, _args, options) => {
      calls.push({ kind: "absence", startedAt: nowNs, options });
      nowNs += BigInt(options.timeoutMs) * 1_000_000n;
      return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
    },
  });
  assert.equal(result.status, "removed_and_absent");
  assert.match(result.removalError, /rm error|cleanup failed/i);
  assert.deepEqual(calls.map((call) => call.kind), ["rm", "absence"]);
  assert.equal(calls[0].startedAt, 0n);
  assert.equal(calls[1].startedAt, 1_000_000_000n);
});

test("strict nonce cleanup starts no removal when its deadline cannot also reserve an absence probe", async () => {
  const calls = [];
  await assert.rejects(agentBridge.cleanupAgentBridgeLocomotionNonce(adb, {
    serial: baseInput.serial,
    packageName: baseInput.packageName,
    requestId: baseInput.requestId,
    tag: baseInput.tag,
    rootGeneration: 7,
    rootIncarnation: ROOT_INCARNATION,
    controlTimeoutMs: 1_000,
    ackReadTimeoutMs: 250,
    pollMs: 1,
    stabilityReads: 2,
    deadlineMonotonicNs: "1249000000",
    processStopped: true,
  }, {
    monotonicNs: () => 0n,
    sleep: async () => { calls.push("sleep"); },
    runText: async () => { calls.push("rm"); return cleanupOk; },
    runBytes: async () => { calls.push("absence"); return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false }; },
  }), (error) => {
    assert.equal(error.removalStarted, false);
    assert.match(error.message, /cannot fit|preserving.*proof/i);
    return true;
  });
  assert.deepEqual(calls, []);
});

test("cleanup-only nonce recovery requires a proven process stop before any transport", async () => {
  const calls = [];
  await assert.rejects(agentBridge.cleanupAgentBridgeLocomotionNonce(adb, {
    serial: baseInput.serial,
    packageName: baseInput.packageName,
    requestId: baseInput.requestId,
    tag: baseInput.tag,
    rootGeneration: 7,
    rootIncarnation: ROOT_INCARNATION,
    controlTimeoutMs: 1_000,
    ackReadTimeoutMs: 250,
    pollMs: 1,
    stabilityReads: 2,
    deadlineMonotonicNs: "4000000000",
    cleanupOnly: true,
  }, {
    monotonicNs: () => { calls.push("clock"); return 0n; },
    sleep: async () => { calls.push("sleep"); },
    runText: async () => { calls.push("text"); return textOk; },
    runBytes: async () => { calls.push("bytes"); return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false }; },
  }), /cleanupOnly.*processStopped|processStopped.*cleanupOnly/i);
  assert.deepEqual(calls, []);
});

test("worst-case cancellation and final cleanup never start an effect at or after their absolute deadlines", async () => {
  let nowNs = 0n;
  const deadlineNs = 6_800_000_000n;
  const calls = [];
  const advance = (options) => { nowNs += BigInt(options.timeoutMs) * 1_000_000n; };
  const result = await requestAgentBridgeLocomotion(adb, {
    ...locomotionInput,
    maxPolls: 2,
    pollMs: 10,
    stabilityReads: 2,
    ackReadTimeoutMs: 250,
    controlTimeoutMs: 1_000,
    deadlineMonotonicNs: deadlineNs.toString(),
    deferNonceCleanup: true,
  }, {
    monotonicNs: () => nowNs,
    sleep: async (durationMs) => {
      calls.push({ kind: "sleep", startedAt: nowNs, durationMs });
      nowNs += BigInt(durationMs) * 1_000_000n;
    },
    runText: async (_cmd, args, options) => {
      calls.push({ kind: args.includes("cancel") ? "cancel" : "execute", startedAt: nowNs, options });
      advance(options);
      return textOk;
    },
    runBytes: async (_cmd, _args, options) => {
      calls.push({ kind: "read", startedAt: nowNs, options });
      advance(options);
      return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.motionQuiesced, false);
  assert.equal(result.nonceCleanup.status, "deferred_until_stop");
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(call.startedAt < deadlineNs, `${call.kind} started at/after ${deadlineNs}: ${call.startedAt}`);
    if (call.options) {
      assert.ok(call.startedAt + BigInt(call.options.timeoutMs) * 1_000_000n <= deadlineNs,
        `${call.kind} timeout escaped ${deadlineNs}: ${call.startedAt}+${call.options.timeoutMs}`);
    } else {
      assert.ok(call.startedAt + BigInt(call.durationMs) * 1_000_000n <= deadlineNs,
        `${call.kind} sleep escaped ${deadlineNs}: ${call.startedAt}+${call.durationMs}`);
    }
  }

  nowNs = 0n;
  const cleanupDeadlineNs = 4_000_000_000n;
  const cleanupCalls = [];
  const finalAck = Buffer.from(JSON.stringify(finalizeAckFor({
    ...baseInput, rootGeneration: 7, rootIncarnation: ROOT_INCARNATION,
  })), "utf8");
  let reads = 0;
  await agentBridge.cleanupAgentBridgeLocomotionNonce(adb, {
    serial: baseInput.serial,
    packageName: baseInput.packageName,
    requestId: baseInput.requestId,
    tag: baseInput.tag,
    rootGeneration: 7,
    rootIncarnation: ROOT_INCARNATION,
    controlTimeoutMs: 1_000,
    ackReadTimeoutMs: 250,
    pollMs: 10,
    stabilityReads: 2,
    deadlineMonotonicNs: cleanupDeadlineNs.toString(),
  }, {
    monotonicNs: () => nowNs,
    sleep: async (durationMs) => {
      cleanupCalls.push({ kind: "sleep", startedAt: nowNs, durationMs });
      nowNs += BigInt(durationMs) * 1_000_000n;
    },
    runText: async (_cmd, args, options) => {
      cleanupCalls.push({ kind: args.includes("requestControl") ? "finalize" : "rm", startedAt: nowNs, options });
      advance(options);
      return cleanupOk;
    },
    runBytes: async (_cmd, _args, options) => {
      cleanupCalls.push({ kind: reads < 2 ? "finalize-read" : "absence", startedAt: nowNs, options });
      advance(options);
      if (reads++ < 2) return { code: 0, stdout: Buffer.concat([Buffer.from([1]), finalAck]), stderr: "", timedOut: false };
      return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
    },
  });
  for (const call of cleanupCalls) {
    assert.ok(call.startedAt < cleanupDeadlineNs, `${call.kind} started at/after cleanup deadline`);
    const durationMs = call.options?.timeoutMs ?? call.durationMs;
    assert.ok(call.startedAt + BigInt(durationMs) * 1_000_000n <= cleanupDeadlineNs,
      `${call.kind} escaped cleanup deadline`);
  }
});

test("immutable action records form the authoritative hash chain behind the JSONL view", async (t) => {
  const fixture = await createPreparedFixture(t);
  const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
  assert.equal(result.status, "needs_baseline_review");
  const recordsRoot = path.join(fixture.input.artifactRoot, "action-records");
  const names = fs.readdirSync(recordsRoot).sort();
  assert.deepEqual(names, ["000001.json"]);
  const record = JSON.parse(fs.readFileSync(path.join(recordsRoot, names[0]), "utf8"));
  assert.equal(record.sequence, 1);
  assert.equal(record.previousRecordSha256, "0".repeat(64));
  assert.equal(record.payload.action, "prepare");
  assert.equal(canonicalJson(record.payload) + "\n", fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8"));
});

test("an O_EXCL action-record commit conflict cannot erase an intervening writer and movement cleanup stays reachable", async (t) => {
  const fixture = await createPreparedFixture(t);
  const conflictBytes = Buffer.from('{"external":"commit-boundary-writer"}\n', "utf8");
  let conflictPath = null;
  const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
    beforeActionRecordCommit({ action, recordPath }) {
      if (action !== "step" || conflictPath !== null) return;
      conflictPath = recordPath;
      fs.writeFileSync(recordPath, conflictBytes, { flag: "wx", mode: 0o600 });
    },
  });
  const prepared = await orchestrator.execute(fixture.input);
  const stopped = await orchestrator.execute(stepRequest({ ...fixture, orchestrator, prepared }, reviewFor(prepared.requiredReview[0])));
  assert.equal(stopped.status, "stopped");
  assert.match(`${stopped.primaryError} ${stopped.cleanupError}`, /action|record|exist|conflict/i);
  assert.deepEqual(fs.readFileSync(conflictPath), conflictBytes);

  fixture.calls.length = 0;
  const restored = await orchestrator.execute({
    action: "restore", runId: prepared.runId, reviewedPriorFrame: reviewFor(stopped.requiredReview[0]),
  });
  assert.equal(restored.status, "restore_failed");
  assert.equal(fixture.calls.some((call) => call.kind === "locomote"), false);
  assert.equal(fixture.calls.filter((call) => call.kind === "stop").length, 1);
});

test("every post-link ledger maintenance fault preserves the one committed prepare outcome and reachable restore", async (t) => {
  for (const hookName of [
    "afterActionRecordLink",
    "afterActionFirstDirectoryFsync",
    "afterActionStageUnlink",
    "afterActionRecordAdoption",
    "afterActionViewMaterialization",
  ]) {
    await t.test(hookName, async (t) => {
      const fixture = await createPreparedFixture(t);
      let injected = false;
      const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies, {
        [hookName](context) {
          if (context.action !== "prepare" || injected) return;
          injected = true;
          throw new Error(`injected ${hookName}`);
        },
      });
      const prepared = await orchestrator.execute(fixture.input);
      assert.equal(injected, true, `${hookName} did not reach the intended committed boundary`);
      assert.equal(prepared.status, "needs_baseline_review");
      assert.match(prepared.actionAuditMaintenance.errors.join(" "), new RegExp(hookName, "i"));
      assert.ok(["current", "repair_pending"].includes(prepared.actionAuditMaintenance.status));
      const recordsRoot = path.join(fixture.input.artifactRoot, "action-records");
      assert.deepEqual(fs.readdirSync(recordsRoot).filter((name) => /^\d{6}\.json$/.test(name)), ["000001.json"]);
      const record = JSON.parse(fs.readFileSync(path.join(recordsRoot, "000001.json"), "utf8"));
      assert.equal(record.operationId, "prepare:terminal");
      assert.equal(record.payload.status, "completed");
      assert.equal(record.recordSha256, undefined);
      const restored = await orchestrator.execute({
        action: "restore",
        runId: prepared.runId,
        reviewedPriorFrame: reviewFor(prepared.requiredReview[0]),
      });
      assert.equal(restored.status, "restored_needs_review");
      assert.equal(restored.actionAuditMaintenance.status, "repair_pending",
        "the prior action is repaired before the completed restore commits its own deferred maintenance");
      assert.match(restored.actionAuditMaintenance.errors.join(" "), new RegExp(hookName, "i"));
      const records = fs.readdirSync(recordsRoot).filter((name) => /^\d{6}\.json$/.test(name)).sort();
      assert.deepEqual(records, ["000001.json", "000002.json"]);
      assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8"),
        `${canonicalJson(record.payload)}\n`);
      const adjudicated = await orchestrator.execute({
        action: "adjudicate",
        runId: prepared.runId,
        frameAttestations: attestationsFor([prepared.requiredReview[0], restored.requiredReview[0]]),
      });
      assert.equal(adjudicated.status, "structural_complete");
      assert.equal(adjudicated.actionAuditMaintenance.status, "current");
      const finalRecords = fs.readdirSync(recordsRoot).filter((name) => /^\d{6}\.json$/.test(name)).sort();
      assert.deepEqual(finalRecords, ["000001.json", "000002.json", "000003.json"]);
      const payloadLines = finalRecords
        .map((name) => canonicalJson(JSON.parse(fs.readFileSync(path.join(recordsRoot, name), "utf8")).payload))
        .join("\n") + "\n";
      assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8"), payloadLines);
    });
  }
});

test("a real post-link staging unlink failure is bound and repaired on the next authoritative replay", async (t) => {
  const fixture = await createPreparedFixture(t);
  const recordsRoot = path.join(fixture.input.artifactRoot, "action-records");
  const originalUnlinkSync = fs.unlinkSync;
  let injectedFailures = 0;
  let ownedStagingPath = null;
  fs.unlinkSync = function injectedActionStageUnlink(candidate) {
    const candidatePath = String(candidate);
    if (candidatePath.includes(`${path.sep}action-records${path.sep}.000001.`)
      && /^\.000001\.[a-f0-9]{32}\.tmp$/.test(path.basename(candidatePath))
      && injectedFailures < 1) {
      injectedFailures++;
      ownedStagingPath = candidatePath;
      throw Object.assign(new Error(`injected real action-stage unlink failure ${injectedFailures}`), { code: "EIO" });
    }
    return originalUnlinkSync.apply(this, arguments);
  };
  let prepared;
  try {
    const orchestrator = createInAppLocomotionOrchestrator(fixture.dependencies);
    prepared = await orchestrator.execute(fixture.input);
    assert.equal(prepared.status, "needs_baseline_review");
    assert.equal(injectedFailures, 1);
    assert.ok(ownedStagingPath);
    assert.equal(fs.existsSync(ownedStagingPath), true, "the failed owned stage remains for later repair");
    assert.equal(prepared.actionAuditMaintenance.status, "repair_pending");

    const restored = await orchestrator.execute({
      action: "restore",
      runId: prepared.runId,
      reviewedPriorFrame: reviewFor(prepared.requiredReview[0]),
    });
    assert.equal(restored.status, "restored_needs_review");
    assert.equal(fs.existsSync(ownedStagingPath), false);
    assert.deepEqual(fs.readdirSync(recordsRoot).filter((name) => /^\d{6}\.json$/.test(name)).sort(),
      ["000001.json", "000002.json"]);
    assert.equal(fs.readdirSync(recordsRoot).filter((name) => /^\.000002\.[a-f0-9]{32}\.tmp$/.test(name)).length, 1);
    assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8"),
      `${canonicalJson(committedActionPayloads(fixture.input.artifactRoot)[0])}\n`);
    assert.equal(restored.actionAuditMaintenance.status, "repair_pending");
    const adjudicated = await orchestrator.execute({
      action: "adjudicate",
      runId: prepared.runId,
      frameAttestations: attestationsFor([prepared.requiredReview[0], restored.requiredReview[0]]),
    });
    assert.equal(adjudicated.status, "structural_complete");
    assert.equal(adjudicated.actionAuditMaintenance.status, "current");
    assert.deepEqual(fs.readdirSync(recordsRoot).sort(), ["000001.json", "000002.json", "000003.json"]);
    const payloadLines = committedActionPayloads(fixture.input.artifactRoot)
      .map((payload) => canonicalJson(payload)).join("\n") + "\n";
    assert.equal(fs.readFileSync(path.join(fixture.input.artifactRoot, "actions.jsonl"), "utf8"), payloadLines);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
});

test("action replay repairs only bound owned stages and still rejects a foreign staging entry", async (t) => {
  const fixture = await prepareForSteps(t);
  const recordsRoot = path.join(fixture.input.artifactRoot, "action-records");
  const foreignPath = path.join(recordsRoot, ".000002.foreign.tmp");
  fs.writeFileSync(foreignPath, "foreign staging bytes\n", { flag: "wx", mode: 0o600 });
  fixture.calls.length = 0;

  const restored = await fixture.orchestrator.execute({
    action: "restore",
    runId: fixture.prepared.runId,
    reviewedPriorFrame: reviewFor(fixture.prepared.requiredReview[0]),
  });

  assert.equal(restored.status, "restore_failed");
  assert.match(`${restored.primaryError} ${restored.cleanupError}`, /action record|authoritative|slot|staging|changed/i);
  assert.equal(fs.existsSync(foreignPath), true, "foreign bytes must never be deleted as owned maintenance");
  assert.equal(fixture.calls.some((call) => call.kind === "locomote"), false);
});

test("monitor sample zero must be descriptor-retained and cross-bound to the launch observer handoff", async (t) => {
  for (const [label, options, pattern] of [
    ["callback before retention", { monitorCallbackBeforeRetention: true }, /sample zero|handoff|raw window|retain|exist|ENOENT|file/i],
    ["forged callback descriptor", { monitorCallbackForgedWindow: true }, /sample zero|handoff|raw window|SHA/i],
    ["forged callback timing", {
      monitorSampleZeroProbeStartedAtMonotonicNs: "22000000",
      monitorSampleZeroRetainedAtMonotonicNs: "21000000",
    }, /sample zero|handoff|monotonic|timing|retain/i],
  ]) {
    await t.test(label, async (t) => {
      const fixture = await createPreparedFixture(t, options);
      const result = await createInAppLocomotionOrchestrator(fixture.dependencies).execute(fixture.input);
      assert.equal(result.status, "preparation_failed");
      assert.match(`${result.primaryError} ${result.cleanupError}`, pattern);
    });
  }
});
