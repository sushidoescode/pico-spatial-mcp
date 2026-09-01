import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CameraActionExecutionError,
  executeBoundCameraActions,
  executeRelativeCameraRoute,
} from "../dist/navigation.js";
import * as navigation from "../dist/navigation.js";
import {
  createBoundCameraActionAdapter,
  createCameraActionBindingReceipt,
  selectQemuWindowBinding,
} from "../dist/cameradrive.js";

const runtimeBinding = {
  serial: "emulator-5554",
  bootId: "12345678-1234-4234-8234-123456789abc",
  grpc: {
    discoveryFile: "/tmp/pico-emulator/pid_93013.ini",
    qemuPid: 93013,
    address: "127.0.0.1:8554",
    tokenFingerprint: "a".repeat(64),
  },
  qemuWindow: { ownerPid: 93013, windowId: 7 },
};

const applicationBinding = {
  packageName: "com.fleet.boundarylabmixed",
  apkSha256: "b".repeat(64),
  allowedResumedComponents: ["com.fleet.boundarylabmixed/.platform.LaunchActivity"],
  pid: 4242,
  pidStartTicks: "98765",
};

const defaultBudgets = {
  maxActions: 8,
  maxWaypoints: 4,
  maxHoldMsPerAction: 5_000,
  maxDragPxPerAction: 360,
  maxCumulativeHoldMs: 10_000,
  maxCumulativeDragPx: 1_000,
  maxDurationMs: 300_000,
  recoveryReserveMs: 1_000,
};

function routeInput(overrides = {}) {
  return {
    runtimeBinding,
    continuity: { kind: "not_requested" },
    priorCaptureSha256: "c".repeat(64),
    artifactSession: {
      runId: "route-test",
      absoluteRoot: "/tmp/pico-navigation-tests/route-test",
      ownerNonceHash: "c".repeat(64),
    },
    budgets: defaultBudgets,
    capture: { maxTries: 2, intervalMs: 10, attemptTimeoutMs: 100 },
    ...overrides,
  };
}

function applied(action, serial = runtimeBinding.serial, ack = {}, binding = runtimeBinding) {
  const hostWindow = {
    qemuWindowOwnerPid: binding.qemuWindow.ownerPid,
    qemuWindowId: binding.qemuWindow.windowId,
  };
  const actionAck = action.kind === "key_hold"
    ? {
        key: action.key,
        holdMs: action.holdMs,
        releaseCertain: true,
        grpc: {
          discoveryFile: binding.grpc.discoveryFile,
          discoveredSerial: binding.serial,
          qemuPid: binding.grpc.qemuPid,
          address: binding.grpc.address,
          tokenFingerprint: binding.grpc.tokenFingerprint,
        },
        hostWindow,
        focusAcknowledged: true,
      }
    : {
        requested: { dragDx: action.dxPx, dragDy: action.dyPx },
        hostWindow,
        focusAcknowledged: true,
        cgEventAcknowledged: true,
      };
  return {
    action: action.kind,
    serial,
    status: "applied",
    startedAtMonotonicNs: "1",
    endedAtMonotonicNs: "2",
    ack: { ...actionAck, ...ack },
  };
}

function noInputKeyFailure(action, ack = {}) {
  const base = applied(action);
  const { grpc: _grpc, ...withoutGrpc } = base.ack;
  return {
    ...base,
    status: "failed",
    ack: {
      ...withoutGrpc,
      connectionAttempts: 2,
      keydownAttempted: false,
      keydownAcknowledged: false,
      applicationUncertain: false,
      keyupAcknowledged: false,
      releaseCertain: true,
      ...ack,
    },
    error: "discovery unavailable; reconnect failed: discovery unavailable",
  };
}

function settled(path, sha256 = "d".repeat(64)) {
  const captureRef = {
    path,
    sha256,
    bytes: 128,
    width: 16,
    height: 8,
    dimensions: { width: 16, height: 8 },
    sourceSerial: runtimeBinding.serial,
    capturedAt: "2026-08-31T12:00:00.000Z",
  };
  return {
    status: "settled",
    serial: runtimeBinding.serial,
    path,
    sha256,
    attempts: 2,
    settlementSatisfied: true,
    comparison: "byte_exact",
    stablePair: [sha256, sha256],
    captureRuntimeBinding: {
      serial: runtimeBinding.serial,
      liveIdentity: {
        serial: runtimeBinding.serial,
        model: "PICO 4 Ultra Emulator",
        product: "PICO_6.0",
        fingerprint: "pico/PICO/PICO:6/test:userdebug/test-keys",
        bootQemu: "1",
        bootId: runtimeBinding.bootId,
        observedAt: "2026-08-31T12:00:00.000Z",
      },
      captureSource: "adb-exec-out-screencap",
      startedAtMonotonicNs: "20",
      endedAtMonotonicNs: "30",
    },
    captureRef,
    lastValidCaptureRef: null,
    actionReceipts: [],
    error: null,
    evidenceCeiling: "structural",
    lookRequired: true,
  };
}

function timeout(path) {
  const base = settled(path);
  return {
    ...base,
    status: "timeout",
    settlementSatisfied: false,
    stablePair: null,
    lastValidCaptureRef: base.captureRef,
    error: { code: "settle_timeout", detail: "not stable" },
  };
}

function continuitySample(overrides = {}) {
  return {
    observedAtMonotonicNs: "10",
    serial: runtimeBinding.serial,
    bootId: runtimeBinding.bootId,
    packageName: applicationBinding.packageName,
    allowedResumedComponents: applicationBinding.allowedResumedComponents,
    apkSha256: applicationBinding.apkSha256,
    pid: applicationBinding.pid,
    pidStartTicks: applicationBinding.pidStartTicks,
    resumedComponents: applicationBinding.allowedResumedComponents,
    foreground: "exact_allowed",
    probeEventsSincePrior: [],
    probeParse: "absent",
    probeSequence: "unknown",
    watchdog: { status: "absent" },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  let now = 0n;
  return {
    applyRelativeAction: async (action) => applied(action),
    captureSettled: async (capturePath) => settled(capturePath),
    sleep: async () => {},
    allocateWaypointPath: (seq) => `/tmp/pico-navigation-tests/route-test/waypoint-${String(seq).padStart(4, "0")}.png`,
    monotonicNs: () => {
      now += 1_000_000n;
      return now;
    },
    ...overrides,
  };
}

test("route preserves grouped waypoint and action order through injected action, capture, and allocation dependencies", async () => {
  const events = [];
  let captureSeq = 0;
  const priorContexts = [];
  const decisions = [
    [
      { kind: "key_hold", key: "w", holdMs: 100 },
      { kind: "look_drag", dxPx: 3, dyPx: 4 },
    ],
    [{ kind: "key_hold", key: "a", holdMs: 50 }],
    "stop",
  ];
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    (waypoints) => {
      events.push(`decide:${waypoints.length}`);
      return decisions.shift();
    },
    dependencies({
      applyRelativeAction: async (action) => {
        events.push(`action:${action.kind}:${action.kind === "key_hold" ? action.key : `${action.dxPx},${action.dyPx}`}`);
        return applied(action);
      },
      sleep: async (ms) => {
        events.push(`render-dwell:${ms}`);
      },
      allocateWaypointPath: (seq) => {
        const capturePath = `/tmp/pico-navigation-tests/route-test/waypoint-${String(seq).padStart(4, "0")}.png`;
        events.push(`allocate:${seq}`);
        return capturePath;
      },
      captureSettled: async (capturePath, context) => {
        events.push(`capture:${capturePath}`);
        priorContexts.push(context.priorSha256);
        captureSeq += 1;
        return settled(capturePath, captureSeq === 1 ? "d".repeat(64) : "e".repeat(64));
      },
    }),
  );

  assert.equal(trace.status, "controller_stop");
  assert.deepEqual(events, [
    "decide:0",
    "allocate:1",
    "action:key_hold:w",
    "action:look_drag:3,4",
    "render-dwell:10000",
    "capture:/tmp/pico-navigation-tests/route-test/waypoint-0001.png",
    "decide:1",
    "allocate:2",
    "action:key_hold:a",
    "render-dwell:10000",
    "capture:/tmp/pico-navigation-tests/route-test/waypoint-0002.png",
    "decide:2",
  ]);
  assert.deepEqual(trace.waypoints.map(({ seq }) => seq), [1, 2]);
  assert.deepEqual(priorContexts, ["c".repeat(64), "d".repeat(64)]);
  assert.deepEqual(trace.waypoints[0].actions, [
    { kind: "key_hold", key: "w", holdMs: 100 },
    { kind: "look_drag", dxPx: 3, dyPx: 4 },
  ]);
  assert.deepEqual(trace.waypoints.map(({ continuityBefore, continuityAfter }) => [continuityBefore, continuityAfter]), [
    [{ kind: "not_requested" }, { kind: "not_requested" }],
    [{ kind: "not_requested" }, { kind: "not_requested" }],
  ]);
  assert.deepEqual(trace.usage, {
    actions: 3,
    waypoints: 2,
    holdMs: 150,
    dragPx: 5,
    durationMs: trace.usage.durationMs,
  });
  assert.ok(trace.usage.durationMs >= 0);
});

test("route catches an async controller that is not awaited before allocation and exposes its remaining deadline", async () => {
  const events = [];
  let calls = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    async (waypoints, deadline) => {
      events.push(`decide-start:${waypoints.length}`);
      assert.equal(typeof deadline.remainingMs, "function");
      assert.ok(deadline.remainingMs() > 0);
      assert.equal(deadline.signal.aborted, false);
      await Promise.resolve();
      events.push(`decide-end:${waypoints.length}`);
      return calls++ === 0 ? [{ kind: "look_drag", dxPx: 4, dyPx: -3 }] : "stop";
    },
    dependencies({
      allocateWaypointPath: (seq) => {
        events.push(`allocate:${seq}`);
        return `/tmp/pico-navigation-tests/route-test/waypoint-${String(seq).padStart(4, "0")}.png`;
      },
      applyRelativeAction: async (action) => {
        events.push("action");
        return applied(action);
      },
      sleep: async () => events.push("dwell"),
      captureSettled: async (capturePath) => {
        events.push("capture");
        return settled(capturePath);
      },
    }),
  );
  assert.equal(trace.status, "controller_stop");
  assert.deepEqual(events, [
    "decide-start:0", "decide-end:0", "allocate:1", "action", "dwell", "capture",
    "decide-start:1", "decide-end:1",
  ]);
});

test("route catches an async controller rejection without allocating or applying input", async () => {
  let allocations = 0;
  let actions = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    async () => { await Promise.resolve(); throw new Error("detector deadline failed"); },
    dependencies({
      allocateWaypointPath: () => { allocations++; return "/tmp/pico-navigation-tests/route-test/unreachable.png"; },
      applyRelativeAction: async (action) => { actions++; return applied(action); },
    }),
  );
  assert.equal(trace.status, "action_failed");
  assert.equal(allocations, 0);
  assert.equal(actions, 0);
});

test("compatibility route returns at its deadline when a controller promise never settles", async () => {
  let dependencyCalls = 0;
  const route = executeRelativeCameraRoute(
    routeInput({ budgets: { ...defaultBudgets, maxDurationMs: 12_005, recoveryReserveMs: 0 } }),
    () => new Promise(() => {}),
    dependencies({
      allocateWaypointPath: () => { dependencyCalls++; throw new Error("must not allocate"); },
      applyRelativeAction: async () => { dependencyCalls++; throw new Error("must not apply"); },
      captureSettled: async () => { dependencyCalls++; throw new Error("must not capture"); },
    }),
  );
  const result = await Promise.race([
    route,
    new Promise((resolve) => setTimeout(() => resolve("test_timeout"), 100)),
  ]);
  assert.notEqual(result, "test_timeout", "the compatibility wrapper must not drain an untrusted async loser");
  assert.equal(result.status, "budget_exhausted");
  assert.equal(dependencyCalls, 0);
});

test("a late compatibility decision cannot schedule route work after the deadline result", async () => {
  let releaseDecision;
  let returned = false;
  const events = [];
  const routePromise = executeRelativeCameraRoute(
    routeInput({ budgets: { ...defaultBudgets, maxDurationMs: 12_005, recoveryReserveMs: 0 } }),
    () => new Promise((resolve) => { releaseDecision = resolve; }),
    dependencies({
      allocateWaypointPath: () => { events.push("allocate"); return "/tmp/pico-navigation-tests/route-test/late.png"; },
      applyRelativeAction: async (action) => { events.push("action"); return applied(action); },
      captureSettled: async (capturePath) => { events.push("capture"); return settled(capturePath); },
    }),
  ).then((trace) => {
    returned = true;
    return trace;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  const returnedBeforeRelease = returned;
  releaseDecision([{ kind: "look_drag", dxPx: 10, dyPx: 0 }]);
  const trace = await routePromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(returnedBeforeRelease, true, "deadline return must not wait for a late decision");
  assert.equal(trace.status, "budget_exhausted");
  assert.deepEqual(events, []);
  assert.deepEqual(trace.waypoints, []);
  assert.equal(trace.usage.actions, 0);
});

test("persistent route execution carries its original budgets, sequence, paths, and adopted settled baseline across continuations", async () => {
  assert.equal(typeof navigation.createRelativeRouteExecution, "function");
  const priors = [];
  let captureIndex = 0;
  const execution = navigation.createRelativeRouteExecution(
    routeInput({ budgets: { ...defaultBudgets, maxActions: 2, maxWaypoints: 2 } }),
    dependencies({
      captureSettled: async (capturePath, context) => {
        priors.push(context.priorSha256);
        return settled(capturePath, captureIndex++ === 0 ? "d".repeat(64) : "f".repeat(64));
      },
    }),
  );

  const first = await execution.executeStep([{ kind: "look_drag", dxPx: 10, dyPx: 0 }]);
  assert.equal(first.status, "settled");
  const adopted = settled(
    "/tmp/pico-navigation-tests/route-test/guide-on-rebaseline.png",
    "e".repeat(64),
  );
  assert.equal(execution.adoptSettledBaseline(adopted), true);
  const second = await execution.executeStep([{ kind: "look_drag", dxPx: -10, dyPx: 0 }]);
  assert.equal(second.status, "settled");
  const exhausted = await execution.executeStep([{ kind: "look_drag", dxPx: 1, dyPx: 0 }]);
  assert.equal(exhausted.status, "budget_exhausted");

  const trace = execution.finish("controller_stop");
  assert.deepEqual(trace.waypoints.map((waypoint) => waypoint.seq), [1, 2]);
  assert.deepEqual(priors, ["c".repeat(64), "e".repeat(64)]);
  assert.deepEqual(trace.usage.actions, 2);
  assert.deepEqual(trace.usage.waypoints, 2);
});

test("paired route step restores an applied outbound exactly once through the paid recovery lane after active time is consumed", async () => {
  assert.equal(typeof navigation.createRelativeRouteExecution, "function");
  const actions = [];
  let captures = 0;
  let continuitySamples = 0;
  let now = 0n;
  const execution = navigation.createRelativeRouteExecution(
    routeInput({
      continuity: { kind: "required", binding: applicationBinding },
      budgets: {
        ...defaultBudgets,
        maxActions: 2,
        maxWaypoints: 2,
        maxDurationMs: 400_000,
        recoveryReserveMs: 180_000,
      },
      capture: { maxTries: 2, intervalMs: 10, attemptTimeoutMs: 100 },
    }),
    dependencies({
      monotonicNs: () => now,
      sampleContinuity: async () => {
        continuitySamples++;
        if (continuitySamples === 2) now = 250_000_000_000n;
        return continuitySample();
      },
      applyRelativeAction: async (action) => {
        actions.push(action);
        return applied(action);
      },
      captureSettled: async (capturePath) => {
        captures++;
        return settled(capturePath, captures === 1 ? "d".repeat(64) : "e".repeat(64));
      },
    }),
  );

  const pair = await execution.executePairedStep(
    { kind: "look_drag", dxPx: 40, dyPx: 0 },
    { kind: "look_drag", dxPx: -40, dyPx: 0 },
    { pairId: "yaw-positive-40" },
  );
  assert.equal(pair.primaryStatus, "budget_exhausted");
  assert.equal(pair.restore?.status, "settled");
  assert.equal(pair.recoveryUsed, true);
  assert.deepEqual(actions, [
    { kind: "look_drag", dxPx: 40, dyPx: 0 },
    { kind: "look_drag", dxPx: -40, dyPx: 0 },
  ]);
  const trace = execution.finish("controller_stop");
  assert.deepEqual(trace.waypoints.map((waypoint) => waypoint.meta), [
    { lane: "active", pairId: "yaw-positive-40", pairRole: "outbound" },
    { lane: "recovery", pairId: "yaw-positive-40", pairRole: "restore" },
  ]);
});

test("paired route attempt ledger retains an applied outbound capture failure before its successful inverse", async () => {
  const requests = [
    { kind: "look_drag", dxPx: 40, dyPx: 0 },
    { kind: "look_drag", dxPx: -40, dyPx: 0 },
  ];
  for (const [name, firstCapture, evidenceStatus, detailPattern, continuityStatus, waypointSeqs] of [
    ["throw", async () => { throw new Error("fixture outbound capture threw"); }, null, /outbound capture threw/, "not_reached", [2]],
    ["timeout", async (capturePath) => timeout(capturePath), "timeout", /fresh baseline/, "succeeded", [1, 2]],
    ["invalid receipt", async (capturePath) => ({ ...settled(capturePath), path: `${capturePath}.wrong` }), "settled", /exact binding/, "not_reached", [2]],
  ]) {
    let captureCalls = 0;
    const execution = navigation.createRelativeRouteExecution(
      routeInput({
        budgets: {
          ...defaultBudgets,
          maxActions: 2,
          maxWaypoints: 2,
          maxDurationMs: 400_000,
          recoveryReserveMs: 180_000,
        },
      }),
      dependencies({
        captureSettled: async (capturePath) => {
          captureCalls++;
          if (captureCalls === 1) return firstCapture(capturePath);
          return settled(capturePath, "e".repeat(64));
        },
      }),
    );

    const pair = await execution.executePairedStep(requests[0], requests[1], { pairId: "yaw-positive-40" });
    assert.equal(pair.primaryStatus, "route_unsettled", name);
    assert.equal(pair.restore?.status, "settled", name);
    const trace = execution.finish("route_unsettled");

    assert.equal(trace.usage.actions, 2, name);
    assert.equal(trace.actionAttempts.length, 2, name);
    assert.deepEqual(trace.actionAttempts.map((attempt) => ({
      identity: attempt.identity,
      order: attempt.order,
      request: attempt.request,
      lane: attempt.lane,
      recoveryLane: attempt.recoveryLane,
      pairId: attempt.pairId,
      pairRole: attempt.pairRole,
    })), [
      {
        identity: { executionId: "route-test", stepSeq: 1, actionIndex: 0 },
        order: 1,
        request: requests[0],
        lane: "active",
        recoveryLane: false,
        pairId: "yaw-positive-40",
        pairRole: "outbound",
      },
      {
        identity: { executionId: "route-test", stepSeq: 2, actionIndex: 0 },
        order: 2,
        request: requests[1],
        lane: "active",
        recoveryLane: false,
        pairId: "yaw-positive-40",
        pairRole: "restore",
      },
    ], name);
    assert.equal(trace.actionAttempts[0].action.status, "succeeded", name);
    assert.equal(trace.actionAttempts[0].action.evidence.status, "applied", name);
    assert.equal(trace.actionAttempts[0].settle.status, "failed", name);
    assert.equal(trace.actionAttempts[0].settle.evidence?.status ?? null, evidenceStatus, name);
    assert.match(trace.actionAttempts[0].settle.detail, detailPattern, name);
    assert.equal(trace.actionAttempts[0].continuityAfter.status, continuityStatus, name);
    assert.equal(trace.actionAttempts[1].action.status, "succeeded", name);
    assert.equal(trace.actionAttempts[1].settle.status, "succeeded", name);
    assert.equal(trace.actionAttempts[1].continuityAfter.status, "succeeded", name);
    assert.deepEqual(trace.waypoints.map((waypoint) => waypoint.seq), waypointSeqs, name);
  }
});

test("paired route attempt ledger retains the outbound and a failed inverse without overwriting either", async () => {
  const requests = [
    { kind: "look_drag", dxPx: 40, dyPx: 0 },
    { kind: "look_drag", dxPx: -40, dyPx: 0 },
  ];
  let actions = 0;
  const execution = navigation.createRelativeRouteExecution(
    routeInput({
      budgets: {
        ...defaultBudgets,
        maxActions: 2,
        maxWaypoints: 2,
        maxDurationMs: 400_000,
        recoveryReserveMs: 180_000,
      },
    }),
    dependencies({
      applyRelativeAction: async (action) => {
        actions++;
        return actions === 1
          ? applied(action)
          : { ...applied(action), status: "failed", error: "fixture inverse application failed" };
      },
    }),
  );

  const pair = await execution.executePairedStep(requests[0], requests[1], { pairId: "yaw-positive-40" });
  assert.equal(pair.primaryStatus, "settled");
  assert.equal(pair.restore?.status, "action_failed");
  const trace = execution.finish("action_failed");

  assert.equal(trace.usage.actions, 2);
  assert.deepEqual(trace.actionAttempts.map((attempt) => attempt.request), requests);
  assert.deepEqual(trace.actionAttempts.map((attempt) => attempt.identity.stepSeq), [1, 2]);
  assert.equal(trace.actionAttempts[0].settle.status, "succeeded");
  assert.equal(trace.actionAttempts[1].action.status, "failed");
  assert.equal(trace.actionAttempts[1].action.evidence.status, "failed");
  assert.match(trace.actionAttempts[1].action.detail, /fixture inverse application failed/);
  assert.equal(trace.actionAttempts[1].settle.status, "not_reached");
  assert.equal(trace.terminalActionFailures.length, 1);
  assert.deepEqual(trace.terminalActionFailures[0].attemptIdentity,
    { executionId: "route-test", stepSeq: 2, actionIndex: 0 });
  assert.match(trace.terminalActionFailures[0].terminalError, /fixture inverse application failed/);
  assert.deepEqual(trace.terminalActionFailure, trace.terminalActionFailures[0]);
});

test("paired route step refuses before outbound when the exact inverse cannot fit the recovery reserve", async () => {
  assert.equal(typeof navigation.createRelativeRouteExecution, "function");
  let actions = 0;
  let allocations = 0;
  const execution = navigation.createRelativeRouteExecution(
    routeInput({
      continuity: { kind: "required", binding: applicationBinding },
      budgets: {
        ...defaultBudgets,
        maxActions: 2,
        maxWaypoints: 2,
        maxDurationMs: 400_000,
        recoveryReserveMs: 171_999,
      },
      capture: { maxTries: 4, intervalMs: 0, attemptTimeoutMs: 15_000 },
    }),
    dependencies({
      allocateWaypointPath: (seq) => {
        allocations++;
        return `/tmp/pico-navigation-tests/route-test/waypoint-${String(seq).padStart(4, "0")}.png`;
      },
      applyRelativeAction: async (action) => { actions++; return applied(action); },
    }),
  );
  const pair = await execution.executePairedStep(
    { kind: "look_drag", dxPx: 40, dyPx: 0 },
    { kind: "look_drag", dxPx: -40, dyPx: 0 },
    { pairId: "yaw-positive-40" },
  );
  assert.equal(pair.primaryStatus, "budget_exhausted");
  assert.equal(pair.restore, null);
  assert.equal(actions, 0);
  assert.equal(allocations, 0);
});

test("each action group waits once for rendered motion and passes the exact prior capture hash into settlement", async () => {
  const observed = [];
  let decisions = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => decisions++ === 0 ? [{ kind: "key_hold", key: "w", holdMs: 444 }] : "stop",
    dependencies({
      applyRelativeAction: async (action) => {
        observed.push("action");
        return applied(action);
      },
      sleep: async (ms) => observed.push(`dwell:${ms}`),
      captureSettled: async (capturePath, context) => {
        observed.push(`capture:${context?.priorSha256 ?? "missing"}`);
        assert.equal(typeof context?.remainingMs, "function");
        assert.ok(context.remainingMs() > 0);
        return settled(capturePath);
      },
    }),
  );
  assert.equal(trace.status, "controller_stop");
  assert.deepEqual(observed, [
    "action",
    "dwell:10000",
    `capture:${"c".repeat(64)}`,
  ]);
});

test("route rejects a dependency that falsely settles on the exact prior capture", async () => {
  const priorSha256 = "c".repeat(64);
  const trace = await executeRelativeCameraRoute(
    routeInput({ priorCaptureSha256: priorSha256 }),
    (prior) => prior.length === 0 ? [{ kind: "key_hold", key: "w", holdMs: 444 }] : "stop",
    dependencies({
      captureSettled: async (capturePath, context) => {
        assert.equal(context.priorSha256, priorSha256);
        return settled(capturePath, priorSha256);
      },
    }),
  );
  assert.equal(trace.status, "route_unsettled");
  assert.equal(trace.usage.actions, 1);
  assert.equal(trace.waypoints.length, 1);
  assert.equal(trace.waypoints[0].settle.sha256, priorSha256);
});

test("a failed post-action render dwell stops before capture or later movement", async () => {
  let actions = 0;
  let captures = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => [{ kind: "key_hold", key: "w", holdMs: 444 }],
    dependencies({
      applyRelativeAction: async (action) => {
        actions++;
        return applied(action);
      },
      sleep: async () => { throw new Error("render dwell interrupted"); },
      captureSettled: async (capturePath) => {
        captures++;
        return settled(capturePath);
      },
    }),
  );
  assert.equal(trace.status, "route_unsettled");
  assert.equal(actions, 1);
  assert.equal(captures, 0);
  assert.equal(trace.usage.actions, 1);
});

test("bound action execution is ordered, exact-serial, and stops at the first failed receipt", async () => {
  const attempted = [];
  const actions = [
    { kind: "key_hold", key: "w", holdMs: 50 },
    { kind: "look_drag", dxPx: 20, dyPx: 0 },
    { kind: "key_hold", key: "s", holdMs: 50 },
  ];
  const receipts = await executeBoundCameraActions(runtimeBinding, actions, {
    applyRelativeAction: async (action) => {
      attempted.push(action);
      return action === actions[1]
        ? { ...applied(action), status: "failed", error: "drag refused" }
        : applied(action);
    },
  });
  assert.deepEqual(attempted, actions.slice(0, 2));
  assert.deepEqual(receipts.map(({ status }) => status), ["applied", "failed"]);
});

test("bound action receipts must retain exact gRPC and host-window binding evidence before later input", async () => {
  const key = { kind: "key_hold", key: "w", holdMs: 50 };
  const drag = { kind: "look_drag", dxPx: 20, dyPx: -10 };
  const later = { kind: "key_hold", key: "s", holdMs: 50 };
  const keyBase = applied(key).ack;
  const dragBase = applied(drag).ack;
  const drifts = [
    ["discovery file", key, { ...keyBase, grpc: { ...keyBase.grpc, discoveryFile: "/tmp/other.ini" } }],
    ["qemu pid", key, { ...keyBase, grpc: { ...keyBase.grpc, qemuPid: 93014 } }],
    ["gRPC address", key, { ...keyBase, grpc: { ...keyBase.grpc, address: "127.0.0.1:9554" } }],
    ["token fingerprint", key, { ...keyBase, grpc: { ...keyBase.grpc, tokenFingerprint: "f".repeat(64) } }],
    ["discovered serial", key, { ...keyBase, grpc: { ...keyBase.grpc, discoveredSerial: "emulator-5556" } }],
    ["key host window", key, { ...keyBase, hostWindow: { ...keyBase.hostWindow, qemuWindowId: 8 } }],
    ["look host window", drag, { ...dragBase, hostWindow: { ...dragBase.hostWindow, qemuWindowOwnerPid: 93014 } }],
  ];
  for (const [name, first, driftedAck] of drifts) {
    const attempted = [];
    await assert.rejects(
      executeBoundCameraActions(runtimeBinding, [first, later], {
        applyRelativeAction: async (action) => {
          attempted.push(action);
          return action === first ? applied(action, runtimeBinding.serial, driftedAck) : applied(action);
        },
      }),
      /binding mismatch/,
      name,
    );
    assert.deepEqual(attempted, [first], name);
  }
});

test("bound action core retains the exact proven no-input discovery failure and stops before later input", async () => {
  const key = { kind: "key_hold", key: "w", holdMs: 50 };
  const later = { kind: "key_hold", key: "s", holdMs: 50 };
  const failure = noInputKeyFailure(key);
  const attempted = [];
  const receipts = await executeBoundCameraActions(runtimeBinding, [key, later], {
    applyRelativeAction: async (action) => {
      attempted.push(action);
      return action === key ? failure : applied(action);
    },
  });
  assert.deepEqual(attempted, [key]);
  assert.deepEqual(receipts, [failure]);
  assert.equal("grpc" in receipts[0].ack, false);
});

test("no-gRPC receipts are rejected if input was attempted, uncertain, applied, release-uncertain, or not the exact producer shape", async () => {
  const key = { kind: "key_hold", key: "w", holdMs: 50 };
  const later = { kind: "key_hold", key: "s", holdMs: 50 };
  const nearMisses = [
    ["applied", { ...noInputKeyFailure(key), status: "applied", error: undefined }],
    ["keydown attempted", noInputKeyFailure(key, { keydownAttempted: true })],
    ["application uncertain", noInputKeyFailure(key, { applicationUncertain: true })],
    ["release uncertain", noInputKeyFailure(key, { releaseCertain: false })],
    ["wrong reconnect count", noInputKeyFailure(key, { connectionAttempts: 3 })],
    ["explicit null gRPC", noInputKeyFailure(key, { grpc: null })],
  ];
  for (const [name, receipt] of nearMisses) {
    const attempted = [];
    await assert.rejects(
      executeBoundCameraActions(runtimeBinding, [key, later], {
        applyRelativeAction: async (action) => {
          attempted.push(action);
          return action === key ? receipt : applied(action);
        },
      }),
      /binding mismatch/,
      name,
    );
    assert.deepEqual(attempted, [key], name);
  }
});

test("bound action core validates every action before invoking the adapter", async () => {
  const valid = { kind: "key_hold", key: "w", holdMs: 50 };
  const invalidActions = [
    { kind: "key_hold", key: "x", holdMs: 50 },
    { kind: "key_hold", key: "w", holdMs: 0 },
    { kind: "key_hold", key: "w", holdMs: 50.5 },
    { kind: "key_hold", key: "w", holdMs: Number.POSITIVE_INFINITY },
    { kind: "key_hold", key: "w", holdMs: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "look_drag", dxPx: 1.5, dyPx: 2 },
    { kind: "look_drag", dxPx: Number.NaN, dyPx: 0 },
    { kind: "look_drag", dxPx: 0, dyPx: Number.POSITIVE_INFINITY },
  ];
  for (const invalid of invalidActions) {
    let adapterCalls = 0;
    await assert.rejects(
      executeBoundCameraActions(runtimeBinding, [valid, invalid], {
        applyRelativeAction: async (action) => {
          adapterCalls++;
          return applied(action);
        },
      }),
      /invalid relative camera action/,
    );
    assert.equal(adapterCalls, 0, JSON.stringify(invalid));
  }
});

test("bound action core validates complete binding and dependency shape before invoking the adapter", async () => {
  const key = { kind: "key_hold", key: "w", holdMs: 50 };
  const invalidBindings = [
    { ...runtimeBinding, serial: "" },
    { ...runtimeBinding, grpc: { ...runtimeBinding.grpc, discoveryFile: "relative.ini" } },
    { ...runtimeBinding, grpc: { ...runtimeBinding.grpc, qemuPid: 0 } },
    { ...runtimeBinding, grpc: { ...runtimeBinding.grpc, address: "" } },
    { ...runtimeBinding, grpc: { ...runtimeBinding.grpc, tokenFingerprint: "not-a-sha256" } },
    { ...runtimeBinding, qemuWindow: { ...runtimeBinding.qemuWindow, ownerPid: 93014 } },
    { ...runtimeBinding, qemuWindow: { ...runtimeBinding.qemuWindow, windowId: 0 } },
  ];
  for (const binding of invalidBindings) {
    let adapterCalls = 0;
    await assert.rejects(
      executeBoundCameraActions(binding, [key], {
        applyRelativeAction: async (action) => {
          adapterCalls++;
          return applied(action);
        },
      }),
      /invalid camera action binding/,
    );
    assert.equal(adapterCalls, 0, JSON.stringify(binding));
  }

  for (const deps of [null, {}, { applyRelativeAction: 42 }]) {
    await assert.rejects(
      executeBoundCameraActions(runtimeBinding, [key], deps),
      /invalid camera action dependencies/,
    );
  }
});

test("selector-qualified single-window fallbacks retain null or mismatched discovery PID provenance", async () => {
  const action = { kind: "key_hold", key: "w", holdMs: 50 };
  for (const [name, discoveryPid] of [["null PID", null], ["non-null mismatched PID", 93013]]) {
    const selected = selectQemuWindowBinding(
      runtimeBinding.serial,
      [runtimeBinding.serial, "2G0YC5ZF7Z056Q"],
      [{
        file: "/tmp/pico-emulator/fallback.ini",
        pid: discoveryPid,
        serial: runtimeBinding.serial,
        entries: { "port.serial": "5554", "grpc.port": "8554", "grpc.token": "fallback-secret" },
      }],
      [{ ownerPid: 12345, windowId: 9, area: 700 }],
    );
    assert.equal(selected.ok, true, name);
    assert.equal(selected.binding.bindingMethod, "single-online-serial-plus-matching-discovery-plus-single-window", name);
    const fallbackBinding = createCameraActionBindingReceipt(runtimeBinding.serial, selected.binding);
    assert.equal(fallbackBinding.grpc.qemuPid, discoveryPid, name);
    assert.equal(fallbackBinding.qemuWindow.ownerPid, 12345, name);
    assert.equal(fallbackBinding.bindingMethod, "single-online-serial-plus-matching-discovery-plus-single-window", name);
    assert.deepEqual(fallbackBinding.onlineEmulatorSerials, [runtimeBinding.serial], name);

    const receipt = applied(action, fallbackBinding.serial, {}, fallbackBinding);
    const receipts = await executeBoundCameraActions(fallbackBinding, [action], {
      applyRelativeAction: async () => receipt,
    });
    assert.equal(receipts[0].ack.grpc.qemuPid, discoveryPid, name);
    assert.equal(receipts[0].ack.hostWindow.qemuWindowOwnerPid, 12345, name);

    let adapterCalls = 0;
    await assert.rejects(
      executeBoundCameraActions({
        ...fallbackBinding,
        onlineEmulatorSerials: [runtimeBinding.serial, "emulator-5556"],
      }, [action], {
        applyRelativeAction: async () => { adapterCalls++; return receipt; },
      }),
      /invalid camera action binding/,
      `${name} qualification drift`,
    );
    assert.equal(adapterCalls, 0, name);

    await assert.rejects(
      executeBoundCameraActions(fallbackBinding, [action], {
        applyRelativeAction: async () => applied(action, fallbackBinding.serial, {
          hostWindow: { qemuWindowOwnerPid: 12346, qemuWindowId: 9 },
        }, fallbackBinding),
      }),
      /binding mismatch/,
      `${name} receipt drift`,
    );
  }
});

test("qemu binding catches geometry or backing-scale drift while legacy id/pid receipts remain accepted", async () => {
  const selected = selectQemuWindowBinding(
    runtimeBinding.serial,
    [runtimeBinding.serial],
    [{
      file: runtimeBinding.grpc.discoveryFile,
      pid: runtimeBinding.grpc.qemuPid,
      serial: runtimeBinding.serial,
      entries: { "port.serial": "5554", "grpc.port": "8554", "grpc.token": "geometry-secret" },
    }],
    [{ windowId: 7, ownerPid: 93013, x: 101, y: 202, width: 1280, height: 720, scale: 2, area: 921600 }],
  );
  assert.equal(selected.ok, true);
  assert.deepEqual({
    x: selected.binding.qemuWindowX,
    y: selected.binding.qemuWindowY,
    width: selected.binding.qemuWindowWidth,
    height: selected.binding.qemuWindowHeight,
    scale: selected.binding.qemuWindowScale,
  }, { x: 101, y: 202, width: 1280, height: 720, scale: 2 });

  const actionBinding = createCameraActionBindingReceipt(runtimeBinding.serial, selected.binding);
  assert.deepEqual(actionBinding.qemuWindow, {
    ownerPid: 93013,
    windowId: 7,
    x: 101,
    y: 202,
    width: 1280,
    height: 720,
    scale: 2,
  });
  const strict = { ...actionBinding, bootId: runtimeBinding.bootId };
  delete strict.bindingMethod;
  delete strict.onlineEmulatorSerials;
  const drag = { kind: "look_drag", dxPx: 20, dyPx: 0 };
  await assert.rejects(
    executeBoundCameraActions(strict, [drag], {
      applyRelativeAction: async () => applied(drag, strict.serial, {
        hostWindow: {
          qemuWindowOwnerPid: 93013,
          qemuWindowId: 7,
          qemuWindowX: 102,
          qemuWindowY: 202,
          qemuWindowWidth: 1280,
          qemuWindowHeight: 720,
          qemuWindowScale: 2,
        },
      }, strict),
    }),
    /binding mismatch/,
  );

  const legacy = selectQemuWindowBinding(
    runtimeBinding.serial,
    [runtimeBinding.serial],
    [{
      file: runtimeBinding.grpc.discoveryFile,
      pid: runtimeBinding.grpc.qemuPid,
      serial: runtimeBinding.serial,
      entries: { "port.serial": "5554", "grpc.port": "8554" },
    }],
    [{ windowId: 7, ownerPid: 93013, area: 921600 }],
  );
  assert.equal(legacy.ok, true);
  assert.deepEqual(createCameraActionBindingReceipt(runtimeBinding.serial, legacy.binding).qemuWindow, {
    ownerPid: 93013,
    windowId: 7,
  });
});

test("bound action adapter freshly revalidates every endpoint and exact window field before each input", async () => {
  const selected = selectQemuWindowBinding(
    runtimeBinding.serial,
    [runtimeBinding.serial],
    [{
      file: runtimeBinding.grpc.discoveryFile,
      pid: runtimeBinding.grpc.qemuPid,
      serial: runtimeBinding.serial,
      entries: { "port.serial": "5554", "grpc.port": "8554", "grpc.token": "geometry-secret" },
    }],
    [{ windowId: 7, ownerPid: 93013, x: 101, y: 202, width: 1280, height: 720, scale: 2, area: 921600 }],
  );
  assert.equal(selected.ok, true);

  const mutations = [
    ["discovery file", { discoveryFile: "/tmp/pico-emulator/pid_93014.ini" }],
    ["discovered serial", { discoveredSerial: "emulator-5556" }],
    ["endpoint pid", { qemuPid: 93014 }],
    ["endpoint address", { address: "127.0.0.1:8555" }],
    ["endpoint token presence", { tokenPresent: false }],
    ["endpoint token", { tokenFingerprint: "f".repeat(64) }],
    ["online serial set", { onlineEmulatorSerials: [runtimeBinding.serial, "emulator-5556"] }],
    ["binding method", { bindingMethod: "single-online-serial-plus-matching-discovery-plus-single-window" }],
    ["window owner", { qemuWindowOwnerPid: 93014 }],
    ["window id", { qemuWindowId: 8 }],
    ["window x", { qemuWindowX: 102 }],
    ["window y", { qemuWindowY: 203 }],
    ["window width", { qemuWindowWidth: 1279 }],
    ["window height", { qemuWindowHeight: 719 }],
    ["window scale", { qemuWindowScale: 1 }],
  ];
  for (const [name, mutation] of mutations) {
    let revalidations = 0;
    let drags = 0;
    const changed = { ...selected.binding, ...mutation };
    const adapter = createBoundCameraActionAdapter(runtimeBinding.serial, selected.binding, {
      revalidateWindow: async () => ({
        ok: true,
        binding: structuredClone(revalidations++ === 0 ? selected.binding : changed),
      }),
      focusQemu: async () => null,
      rightDrag: async () => { drags++; return null; },
    });
    const action = { kind: "look_drag", dxPx: 20, dyPx: 0 };
    const first = await adapter.applyRelativeAction(action);
    const second = await adapter.applyRelativeAction(action);
    assert.equal(first.status, "applied", name);
    assert.equal(second.status, "failed", name);
    assert.equal(second.ack.bindingRevalidation.status, "mismatch", name);
    assert.deepEqual(second.ack.bindingRevalidation.observed, changed, name);
    assert.equal(revalidations, 2, name);
    assert.equal(drags, 1, name);
  }

  let keyCalls = 0;
  let keyRevalidations = 0;
  const moved = { ...selected.binding, qemuWindowX: selected.binding.qemuWindowX + 1 };
  const keyAdapter = createBoundCameraActionAdapter(runtimeBinding.serial, selected.binding, {
    revalidateWindow: async () => ({
      ok: true,
      binding: structuredClone(keyRevalidations++ === 0 ? selected.binding : moved),
    }),
    keyHold: async (serial, key, holdMs) => {
      keyCalls++;
      return applied({ kind: "key_hold", key, holdMs }, serial, {}, createCameraActionBindingReceipt(serial, selected.binding));
    },
  });
  const keyAction = { kind: "key_hold", key: "w", holdMs: 50 };
  assert.equal((await keyAdapter.applyRelativeAction(keyAction)).status, "applied");
  const refusedKey = await keyAdapter.applyRelativeAction(keyAction);
  assert.equal(refusedKey.status, "failed");
  assert.equal(refusedKey.ack.connectionAttempts, 0, "window revalidation does not pretend to attempt gRPC discovery");
  assert.equal(refusedKey.ack.keydownAttempted, false);
  assert.equal(keyCalls, 1);
  const strict = { ...createCameraActionBindingReceipt(runtimeBinding.serial, selected.binding), bootId: runtimeBinding.bootId };
  delete strict.bindingMethod;
  delete strict.onlineEmulatorSerials;
  await assert.doesNotReject(async () => {
    const receipts = await executeBoundCameraActions(strict, [keyAction], {
      applyRelativeAction: async () => refusedKey,
    });
    assert.deepEqual(receipts, [refusedKey]);
  });
});

test("bound action failures retain prior receipts and the terminal attempt", async () => {
  const actions = [
    { kind: "key_hold", key: "w", holdMs: 50 },
    { kind: "look_drag", dxPx: 8, dyPx: -3 },
    { kind: "key_hold", key: "s", holdMs: 50 },
  ];
  const firstReceipt = applied(actions[0]);
  let caught;
  await assert.rejects(
    executeBoundCameraActions(runtimeBinding, actions, {
      applyRelativeAction: async (action) => {
        if (action === actions[0]) return firstReceipt;
        throw new Error("adapter exploded");
      },
    }),
    (error) => {
      caught = error;
      return error instanceof CameraActionExecutionError;
    },
  );
  assert.deepEqual(caught.receiptsSoFar, [firstReceipt]);
  assert.equal(caught.terminalReceipt, null);
  assert.match(caught.terminalError, /adapter exploded/);
  assert.equal(caught.attemptedCount, 2);
  assert.deepEqual(caught.attemptedAction, actions[1]);
  assert.deepEqual(caught.retainedReceipts, [firstReceipt]);

  const driftedReceipt = applied(actions[1], runtimeBinding.serial, {
    hostWindow: { qemuWindowOwnerPid: runtimeBinding.qemuWindow.ownerPid, qemuWindowId: 99 },
  });
  await assert.rejects(
    executeBoundCameraActions(runtimeBinding, actions, {
      applyRelativeAction: async (action) => action === actions[0] ? firstReceipt : driftedReceipt,
    }),
    (error) => {
      assert.ok(error instanceof CameraActionExecutionError);
      assert.deepEqual(error.receiptsSoFar, [firstReceipt]);
      assert.equal(error.terminalReceipt, driftedReceipt);
      assert.equal(error.attemptedCount, 2);
      assert.deepEqual(error.retainedReceipts, [firstReceipt, driftedReceipt]);
      return true;
    },
  );
});

test("per-action hold and drag caps reject the whole waypoint before input", async () => {
  for (const [name, action, budgets] of [
    ["hold", { kind: "key_hold", key: "w", holdMs: 101 }, { maxHoldMsPerAction: 100 }],
    ["drag", { kind: "look_drag", dxPx: 6, dyPx: 8 }, { maxDragPxPerAction: 9 }],
  ]) {
    let appliedCount = 0;
    let captureCount = 0;
    const trace = await executeRelativeCameraRoute(
      routeInput({ budgets: { ...defaultBudgets, ...budgets } }),
      () => [action],
      dependencies({
        applyRelativeAction: async (candidate) => {
          appliedCount++;
          return applied(candidate);
        },
        captureSettled: async (capturePath) => {
          captureCount++;
          return settled(capturePath);
        },
      }),
    );
    assert.equal(trace.status, "budget_exhausted", `${name} cap status`);
    assert.equal(appliedCount, 0, `${name} cap input count`);
    assert.equal(captureCount, 0, `${name} cap capture count`);
  }
});

test("cumulative hold, drag, and action caps reject a later group before partial application", async () => {
  for (const [name, first, second, budgets] of [
    [
      "hold",
      { kind: "key_hold", key: "w", holdMs: 60 },
      { kind: "key_hold", key: "w", holdMs: 41 },
      { maxCumulativeHoldMs: 100 },
    ],
    [
      "drag",
      { kind: "look_drag", dxPx: 3, dyPx: 4 },
      { kind: "look_drag", dxPx: 6, dyPx: 8 },
      { maxCumulativeDragPx: 14 },
    ],
    [
      "actions",
      { kind: "key_hold", key: "a", holdMs: 50 },
      { kind: "key_hold", key: "d", holdMs: 50 },
      { maxActions: 1 },
    ],
  ]) {
    let decision = 0;
    const appliedActions = [];
    const trace = await executeRelativeCameraRoute(
      routeInput({ budgets: { ...defaultBudgets, ...budgets } }),
      () => [decision++ === 0 ? first : second],
      dependencies({
        applyRelativeAction: async (action) => {
          appliedActions.push(action);
          return applied(action);
        },
      }),
    );
    assert.equal(trace.status, "budget_exhausted", `${name} cumulative status`);
    assert.deepEqual(appliedActions, [first], `${name} must not partially apply the rejected group`);
    assert.equal(trace.waypoints.length, 1);
  }
});

test("waypoint cap stops before allocating or moving a second waypoint", async () => {
  let allocations = 0;
  let actions = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({ budgets: { ...defaultBudgets, maxWaypoints: 1 } }),
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      applyRelativeAction: async (action) => {
        actions++;
        return applied(action);
      },
      allocateWaypointPath: (seq) => {
        allocations++;
        return `/tmp/pico-navigation-tests/route-test/waypoint-${String(seq).padStart(4, "0")}.png`;
      },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(actions, 1);
  assert.equal(allocations, 1);
  assert.equal(trace.waypoints.length, 1);
});

test("conservative duration preflight reserves capture attempts, intervals, and recovery before movement", async () => {
  let appliedCount = 0;
  let captureCount = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({
      budgets: { ...defaultBudgets, maxDurationMs: 100, recoveryReserveMs: 90 },
      capture: { maxTries: 2, intervalMs: 5, attemptTimeoutMs: 10 },
    }),
    () => [{ kind: "key_hold", key: "w", holdMs: 1 }],
    dependencies({
      applyRelativeAction: async (action) => {
        appliedCount++;
        return applied(action);
      },
      captureSettled: async (capturePath) => {
        captureCount++;
        return settled(capturePath);
      },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(appliedCount, 0);
  assert.equal(captureCount, 0);
});

test("a look drag is admitted only when the duration budget covers fresh focus verification and CGEvent delivery", async () => {
  const exactConservativeMs = 93_210;

  for (const [name, maxDurationMs, expectedStatus, expectedActions] of [
    ["exact bound", exactConservativeMs, "controller_stop", 1],
    ["one millisecond short", exactConservativeMs - 1, "budget_exhausted", 0],
  ]) {
    let appliedCount = 0;
    let captureCount = 0;
    const trace = await executeRelativeCameraRoute(
      routeInput({
        budgets: { ...defaultBudgets, maxDurationMs },
      }),
      (prior) => prior.length === 0 ? [{ kind: "look_drag", dxPx: 20, dyPx: 0 }] : "stop",
      dependencies({
        monotonicNs: () => 0n,
        applyRelativeAction: async (action) => {
          appliedCount++;
          return applied(action);
        },
        captureSettled: async (capturePath) => {
          captureCount++;
          return settled(capturePath);
        },
      }),
    );
    assert.equal(trace.status, expectedStatus, name);
    assert.equal(appliedCount, expectedActions, `${name} action count`);
    assert.equal(captureCount, expectedActions, `${name} capture count`);
  }
});

test("a four-action outer-gate group is admitted only at its exact conservative live-duration bound", async () => {
  const actions = [
    { kind: "key_hold", key: "w", holdMs: 5_000 },
    { kind: "key_hold", key: "w", holdMs: 5_000 },
    { kind: "key_hold", key: "w", holdMs: 4_500 },
    { kind: "key_hold", key: "s", holdMs: 1_500 },
  ];
  const capture = { maxTries: 4, intervalMs: 500, attemptTimeoutMs: 3_000 };
  const exactConservativeMs = 701_700;

  for (const [name, maxDurationMs, expectedStatus, expectedActions] of [
    ["exact bound", exactConservativeMs, "controller_stop", 4],
    ["one millisecond short", exactConservativeMs - 1, "budget_exhausted", 0],
  ]) {
    let appliedCount = 0;
    let captureCount = 0;
    let continuityCount = 0;
    const trace = await executeRelativeCameraRoute(
      routeInput({
        continuity: { kind: "required", binding: applicationBinding },
        budgets: {
          ...defaultBudgets,
          maxActions: 4,
          maxWaypoints: 1,
          maxCumulativeHoldMs: 16_000,
          maxDurationMs,
          recoveryReserveMs: 525_000,
        },
        capture,
      }),
      (prior) => prior.length === 0 ? actions : "stop",
      dependencies({
        monotonicNs: () => 0n,
        sampleContinuity: async () => {
          continuityCount++;
          return continuitySample();
        },
        applyRelativeAction: async (action) => {
          appliedCount++;
          return applied(action);
        },
        captureSettled: async (capturePath) => {
          captureCount++;
          return settled(capturePath);
        },
      }),
    );
    assert.equal(trace.status, expectedStatus, name);
    assert.equal(appliedCount, expectedActions, `${name} action count`);
    assert.equal(captureCount, expectedActions === 0 ? 0 : 1, `${name} capture count`);
    assert.equal(continuityCount, expectedActions === 0 ? 0 : 2, `${name} continuity count`);
  }
});

test("controller stop returns without sampling, input, allocation, or capture", async () => {
  let dependencyCalls = 0;
  const trace = await executeRelativeCameraRoute(routeInput(), () => "stop", dependencies({
    applyRelativeAction: async () => { dependencyCalls++; throw new Error("must not run"); },
    sampleContinuity: async () => { dependencyCalls++; throw new Error("must not run"); },
    allocateWaypointPath: () => { dependencyCalls++; throw new Error("must not run"); },
    captureSettled: async () => { dependencyCalls++; throw new Error("must not run"); },
  }));
  assert.equal(trace.status, "controller_stop");
  assert.equal(dependencyCalls, 0);
  assert.deepEqual(trace.waypoints, []);
  assert.equal(trace.usage.actions, 0);
});

test("uncertain paired release stops before settlement and no later recovery-like action runs", async () => {
  const attemptedKeys = [];
  let captures = 0;
  let decisions = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => {
      decisions++;
      return decisions === 1
        ? [{ kind: "key_hold", key: "w", holdMs: 50 }]
        : [{ kind: "key_hold", key: "s", holdMs: 50 }];
    },
    dependencies({
      applyRelativeAction: async (action) => {
        attemptedKeys.push(action.key);
        return { ...applied(action, runtimeBinding.serial, { releaseCertain: false }), status: "applied" };
      },
      captureSettled: async (capturePath) => {
        captures++;
        return settled(capturePath);
      },
    }),
  );
  assert.equal(trace.status, "input_release_uncertain");
  assert.deepEqual(attemptedKeys, ["w"]);
  assert.equal(decisions, 1);
  assert.equal(captures, 0);
  assert.equal(trace.terminalActionFailure.kind, "release_uncertain");
  assert.deepEqual(trace.terminalActionFailure.receiptsSoFar, []);
  assert.equal(trace.terminalActionFailure.terminalReceipt.status, "applied");
  assert.equal(trace.terminalActionFailure.terminalReceipt.ack.releaseCertain, false);
  assert.equal(trace.terminalActionFailure.attemptedCount, 1);
});

test("an unsettled capture is retained in the trace but stops every later action", async () => {
  const attemptedKeys = [];
  let decisions = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => {
      decisions++;
      return decisions === 1
        ? [{ kind: "key_hold", key: "w", holdMs: 50 }]
        : [{ kind: "key_hold", key: "s", holdMs: 50 }];
    },
    dependencies({
      applyRelativeAction: async (action) => {
        attemptedKeys.push(action.key);
        return applied(action);
      },
      captureSettled: async (capturePath) => timeout(capturePath),
    }),
  );
  assert.equal(trace.status, "route_unsettled");
  assert.deepEqual(attemptedKeys, ["w"]);
  assert.equal(decisions, 1);
  assert.equal(trace.waypoints.length, 1);
  assert.equal(trace.waypoints[0].settle.status, "timeout");
});

test("required continuity fails closed when missing, mismatched before input, or lost after settlement", async () => {
  const required = routeInput({ continuity: { kind: "required", binding: applicationBinding } });

  let missingApplied = 0;
  const missing = await executeRelativeCameraRoute(
    required,
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      applyRelativeAction: async (action) => {
        missingApplied++;
        return applied(action);
      },
      sampleContinuity: undefined,
    }),
  );
  assert.equal(missing.status, "binding_lost");
  assert.equal(missingApplied, 0);

  let mismatchedApplied = 0;
  const mismatch = await executeRelativeCameraRoute(
    required,
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      applyRelativeAction: async (action) => {
        mismatchedApplied++;
        return applied(action);
      },
      sampleContinuity: async () => continuitySample({ bootId: "87654321-4321-4321-8321-cba987654321" }),
    }),
  );
  assert.equal(mismatch.status, "binding_lost");
  assert.equal(mismatchedApplied, 0);

  let samples = 0;
  let decisions = 0;
  const lostAfter = await executeRelativeCameraRoute(
    required,
    () => {
      decisions++;
      return [{ kind: "key_hold", key: "w", holdMs: 50 }];
    },
    dependencies({
      sampleContinuity: async () => ++samples === 1
        ? continuitySample()
        : continuitySample({ foreground: "different_package", resumedComponents: ["com.pico.launcher/.Launcher"] }),
    }),
  );
  assert.equal(lostAfter.status, "binding_lost");
  assert.equal(samples, 2);
  assert.equal(decisions, 1);
  assert.equal(lostAfter.waypoints.length, 1);
  assert.equal(lostAfter.waypoints[0].continuityBefore.kind, "sampled");
  assert.equal(lostAfter.waypoints[0].continuityAfter.kind, "sampled");
});

test("route rechecks its elapsed deadline after pre-action continuity and refuses late input", async () => {
  let clockCalls = 0;
  let samples = 0;
  let appliedCount = 0;
  let captureCount = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({
      continuity: { kind: "required", binding: applicationBinding },
      budgets: { ...defaultBudgets, maxDurationMs: 100_000 },
    }),
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      monotonicNs: () => {
        clockCalls += 1;
        return clockCalls <= 2 ? 0n : 100_000_000_000n;
      },
      sampleContinuity: async () => {
        samples += 1;
        return continuitySample();
      },
      applyRelativeAction: async (action) => {
        appliedCount += 1;
        return applied(action);
      },
      captureSettled: async (capturePath) => {
        captureCount += 1;
        return settled(capturePath);
      },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(samples, 1);
  assert.equal(appliedCount, 0);
  assert.equal(captureCount, 0);
});

test("route rechecks its elapsed deadline after the render dwell and refuses a late capture", async () => {
  let clockCalls = 0;
  let appliedCount = 0;
  let captureCount = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({
      budgets: { ...defaultBudgets, maxDurationMs: 80_000 },
    }),
    (prior) => prior.length === 0 ? [{ kind: "key_hold", key: "w", holdMs: 50 }] : "stop",
    dependencies({
      monotonicNs: () => {
        clockCalls += 1;
        return clockCalls <= 3 ? 0n : 100_000_000_000n;
      },
      applyRelativeAction: async (action) => {
        appliedCount += 1;
        return applied(action);
      },
      captureSettled: async (capturePath) => {
        captureCount += 1;
        return settled(capturePath);
      },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(appliedCount, 1);
  assert.equal(captureCount, 0);
  assert.equal(trace.usage.actions, 1);
});

test("route rechecks its elapsed deadline after capture and preserves post-capture reserves", async () => {
  let clockCalls = 0;
  let appliedCount = 0;
  let captureCount = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({
      budgets: { ...defaultBudgets, maxDurationMs: 100_000 },
    }),
    (prior) => prior.length === 0 ? [{ kind: "key_hold", key: "w", holdMs: 50 }] : "stop",
    dependencies({
      monotonicNs: () => {
        clockCalls += 1;
        return clockCalls <= 4 ? 0n : 100_000_000_000n;
      },
      applyRelativeAction: async (action) => {
        appliedCount += 1;
        return applied(action);
      },
      captureSettled: async (capturePath, context) => {
        captureCount += 1;
        assert.equal(typeof context.remainingMs, "function");
        return settled(capturePath);
      },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(appliedCount, 1);
  assert.equal(captureCount, 1);
  assert.equal(trace.usage.waypoints, 0);
});

test("route rechecks its elapsed deadline after final continuity before accepting the waypoint", async () => {
  let clockCalls = 0;
  let continuityCount = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({
      continuity: { kind: "required", binding: applicationBinding },
      budgets: { ...defaultBudgets, maxDurationMs: 150_000 },
    }),
    (prior) => prior.length === 0 ? [{ kind: "key_hold", key: "w", holdMs: 50 }] : "stop",
    dependencies({
      monotonicNs: () => {
        clockCalls += 1;
        return clockCalls <= 5 ? 0n : 200_000_000_000n;
      },
      sampleContinuity: async () => {
        continuityCount += 1;
        return continuitySample();
      },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(continuityCount, 2);
  assert.equal(trace.usage.actions, 1);
  assert.equal(trace.usage.waypoints, 1, "completed capture and continuity evidence stays retained");
});

test("malformed prior capture, numeric budgets, capture policies, holds, and drags fail closed before dependencies", async () => {
  const cases = [
    ["malformed prior capture", { priorCaptureSha256: "not-a-sha" }, [{ kind: "key_hold", key: "w", holdMs: 50 }]],
    ["fractional max actions", { budgets: { ...defaultBudgets, maxActions: 1.5 } }, [{ kind: "key_hold", key: "w", holdMs: 50 }]],
    ["NaN drag cap", { budgets: { ...defaultBudgets, maxDragPxPerAction: Number.NaN } }, [{ kind: "look_drag", dxPx: 1, dyPx: 1 }]],
    ["infinite cumulative drag", { budgets: { ...defaultBudgets, maxCumulativeDragPx: Number.POSITIVE_INFINITY } }, [{ kind: "look_drag", dxPx: 1, dyPx: 1 }]],
    ["negative recovery", { budgets: { ...defaultBudgets, recoveryReserveMs: -1 } }, [{ kind: "key_hold", key: "w", holdMs: 50 }]],
    ["fractional capture attempts", { capture: { maxTries: 1.5, intervalMs: 10, attemptTimeoutMs: 100 } }, [{ kind: "key_hold", key: "w", holdMs: 50 }]],
    ["infinite capture interval", { capture: { maxTries: 2, intervalMs: Number.POSITIVE_INFINITY, attemptTimeoutMs: 100 } }, [{ kind: "key_hold", key: "w", holdMs: 50 }]],
    ["fractional hold", {}, [{ kind: "key_hold", key: "w", holdMs: 50.5 }]],
    ["negative hold", {}, [{ kind: "key_hold", key: "w", holdMs: -1 }]],
    ["fractional drag", {}, [{ kind: "look_drag", dxPx: 1.5, dyPx: 2 }]],
    ["infinite drag", {}, [{ kind: "look_drag", dxPx: Number.POSITIVE_INFINITY, dyPx: 0 }]],
  ];
  for (const [name, overrides, actions] of cases) {
    let calls = 0;
    const trace = await executeRelativeCameraRoute(
      routeInput(overrides),
      () => actions,
      dependencies({
        applyRelativeAction: async (action) => { calls++; return applied(action); },
        allocateWaypointPath: () => { calls++; return "/tmp/pico-navigation-tests/route-test/no.png"; },
        captureSettled: async (capturePath) => { calls++; return settled(capturePath); },
      }),
    );
    assert.equal(trace.status, "budget_exhausted", name);
    assert.equal(calls, 0, name);
  }
});

test("application-aware route requires a numeric discovery PID before dependencies", async () => {
  let calls = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({
      runtimeBinding: {
        ...runtimeBinding,
        grpc: { ...runtimeBinding.grpc, qemuPid: null },
      },
    }),
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      allocateWaypointPath: () => { calls++; return "/tmp/pico-navigation-tests/route-test/waypoint-0001.png"; },
      applyRelativeAction: async (action) => { calls++; return applied(action); },
      captureSettled: async (capturePath) => { calls++; return settled(capturePath); },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(calls, 0);
});

test("compatibility fallback provenance cannot downgrade strict route PID-window validation", async () => {
  let controllerCalls = 0;
  let dependencyCalls = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({
      runtimeBinding: {
        ...runtimeBinding,
        qemuWindow: { ownerPid: 12345, windowId: 9 },
        bindingMethod: "single-online-serial-plus-matching-discovery-plus-single-window",
        onlineEmulatorSerials: [runtimeBinding.serial],
      },
    }),
    () => { controllerCalls++; return "stop"; },
    dependencies({
      monotonicNs: () => { dependencyCalls++; return 0n; },
      sampleContinuity: async () => { dependencyCalls++; return continuitySample(); },
      allocateWaypointPath: () => { dependencyCalls++; return "/tmp/pico-navigation-tests/route-test/waypoint-0001.png"; },
      applyRelativeAction: async (action) => { dependencyCalls++; return applied(action); },
      captureSettled: async (capturePath) => { dependencyCalls++; return settled(capturePath); },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(controllerCalls, 0);
  assert.equal(dependencyCalls, 0);
});

test("an empty action group is rejected rather than silently becoming controller stop", async () => {
  const trace = await executeRelativeCameraRoute(routeInput(), () => [], dependencies());
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(trace.usage.actions, 0);
});

test("a non-monotonic injected clock fails closed before movement", async () => {
  const times = [10_000_000n, 9_000_000n, 8_000_000n];
  let appliedCount = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      monotonicNs: () => times.shift() ?? 8_000_000n,
      applyRelativeAction: async (action) => { appliedCount++; return applied(action); },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(appliedCount, 0);
});

test("not_requested continuity never invokes an injected sampler during a real waypoint", async () => {
  let samplerCalls = 0;
  let decisions = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => decisions++ === 0 ? [{ kind: "key_hold", key: "w", holdMs: 50 }] : "stop",
    dependencies({
      sampleContinuity: async () => { samplerCalls++; throw new Error("must not sample"); },
    }),
  );
  assert.equal(trace.status, "controller_stop");
  assert.equal(samplerCalls, 0);
  assert.equal(trace.waypoints.length, 1);
});

test("required continuity rejects a sampler that changes its exact allowed-component contract", async () => {
  let appliedCount = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({ continuity: { kind: "required", binding: applicationBinding } }),
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      sampleContinuity: async () => continuitySample({
        allowedResumedComponents: [
          ...applicationBinding.allowedResumedComponents,
          "com.fleet.boundarylabmixed/.UnexpectedActivity",
        ],
      }),
      applyRelativeAction: async (action) => { appliedCount++; return applied(action); },
    }),
  );
  assert.equal(trace.status, "binding_lost");
  assert.equal(appliedCount, 0);
});

test("waypoint allocation is single-call and must return the canonical path below the reserved root", async () => {
  let calls = 0;
  let decisions = 0;
  const success = await executeRelativeCameraRoute(
    routeInput(),
    () => decisions++ === 0 ? [{ kind: "key_hold", key: "w", holdMs: 50 }] : "stop",
    dependencies({
      allocateWaypointPath: (seq) => {
        calls++;
        return calls === 1
          ? `/tmp/pico-navigation-tests/route-test/waypoint-${String(seq).padStart(4, "0")}.png`
          : "/tmp/pico-navigation-tests/route-test/nondeterministic.png";
      },
    }),
  );
  assert.equal(success.status, "controller_stop");
  assert.equal(calls, 1);

  for (const [name, allocator] of [
    ["noncanonical", () => "/tmp/pico-navigation-tests/route-test/nested/../1.png"],
    ["escapes root", () => "/tmp/pico-navigation-tests/escaped.png"],
  ]) {
    let captures = 0;
    let appliedCount = 0;
    const trace = await executeRelativeCameraRoute(
      routeInput(),
      () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
      dependencies({
        allocateWaypointPath: allocator,
        applyRelativeAction: async (action) => { appliedCount++; return applied(action); },
        captureSettled: async (capturePath) => { captures++; return settled(capturePath); },
      }),
    );
    assert.equal(trace.status, "route_unsettled", name);
    assert.equal(appliedCount, 0, name);
    assert.equal(captures, 0, name);
  }
});

test("symlinked session roots and nearest existing ancestors resolving into the repository fail before continuity or input", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pico-navigation-root-link-"));
  try {
    const directLink = path.join(temporary, "repo-root");
    const ancestorLink = path.join(temporary, "repo-ancestor");
    fs.symlinkSync(process.cwd(), directLink, "dir");
    fs.symlinkSync(process.cwd(), ancestorLink, "dir");
    for (const absoluteRoot of [directLink, path.join(ancestorLink, "future-session")]) {
      let dependencyCalls = 0;
      const trace = await executeRelativeCameraRoute(
        routeInput({
          artifactSession: {
            runId: "symlinked-repo-root",
            absoluteRoot,
            ownerNonceHash: "c".repeat(64),
          },
          continuity: { kind: "required", binding: applicationBinding },
        }),
        () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
        dependencies({
          sampleContinuity: async () => { dependencyCalls++; return continuitySample(); },
          allocateWaypointPath: () => { dependencyCalls++; return path.join(absoluteRoot, "waypoint-0001.png"); },
          applyRelativeAction: async (action) => { dependencyCalls++; return applied(action); },
        }),
      );
      assert.equal(trace.status, "budget_exhausted");
      assert.equal(dependencyCalls, 0, absoluteRoot);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a canonical allocated filename that resolves through a symlink into the repository fails before continuity or input", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pico-navigation-path-link-"));
  const sessionRoot = path.join(temporary, "session");
  fs.mkdirSync(sessionRoot);
  const allocatedPath = path.join(sessionRoot, "waypoint-0001.png");
  fs.symlinkSync(path.join(process.cwd(), "package.json"), allocatedPath, "file");
  try {
    let dependencyCalls = 0;
    let allocationCalls = 0;
    const trace = await executeRelativeCameraRoute(
      routeInput({
        artifactSession: {
          runId: "symlinked-waypoint",
          absoluteRoot: sessionRoot,
          ownerNonceHash: "c".repeat(64),
        },
        continuity: { kind: "required", binding: applicationBinding },
      }),
      () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
      dependencies({
        sampleContinuity: async () => { dependencyCalls++; return continuitySample(); },
        allocateWaypointPath: () => { allocationCalls++; return allocatedPath; },
        applyRelativeAction: async (action) => { dependencyCalls++; return applied(action); },
      }),
    );
    assert.equal(trace.status, "route_unsettled");
    assert.equal(allocationCalls, 1);
    assert.equal(dependencyCalls, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("an artifact session rooted inside the repository is rejected before movement", async () => {
  let appliedCount = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({
      artifactSession: {
        runId: "inside-repo",
        absoluteRoot: `${process.cwd()}/tmp/navigation`,
        ownerNonceHash: "c".repeat(64),
      },
    }),
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      applyRelativeAction: async (action) => { appliedCount++; return applied(action); },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(appliedCount, 0);
});

test("an artifact root that contains the repository is rejected before allocation or movement", async () => {
  let dependencyCalls = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput({
      artifactSession: {
        runId: "contains-repo",
        absoluteRoot: path.dirname(process.cwd()),
        ownerNonceHash: "c".repeat(64),
      },
    }),
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      allocateWaypointPath: () => { dependencyCalls++; return `${process.cwd()}/frame.png`; },
      applyRelativeAction: async (action) => { dependencyCalls++; return applied(action); },
    }),
  );
  assert.equal(trace.status, "budget_exhausted");
  assert.equal(dependencyCalls, 0);
});

test("an allocated waypoint inside the repository is rejected independently of the session root", async () => {
  let appliedCount = 0;
  let captures = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => [{ kind: "key_hold", key: "w", holdMs: 50 }],
    dependencies({
      allocateWaypointPath: () => `${process.cwd()}/frame.png`,
      applyRelativeAction: async (action) => { appliedCount++; return applied(action); },
      captureSettled: async (capturePath) => { captures++; return settled(capturePath); },
    }),
  );
  assert.equal(trace.status, "route_unsettled");
  assert.equal(appliedCount, 0);
  assert.equal(captures, 0);
});

test("settled receipt path, serial, capture reference, and boot binding must match the allocated waypoint", async () => {
  const capturePath = "/tmp/pico-navigation-tests/route-test/waypoint-0001.png";
  const badReceipts = [
    ["path", { ...settled(capturePath), path: `${capturePath}.other` }],
    ["serial", { ...settled(capturePath), serial: "emulator-5556" }],
    ["capture ref", { ...settled(capturePath), captureRef: { ...settled(capturePath).captureRef, path: `${capturePath}.other` } }],
    ["boot", {
      ...settled(capturePath),
      captureRuntimeBinding: {
        ...settled(capturePath).captureRuntimeBinding,
        liveIdentity: {
          ...settled(capturePath).captureRuntimeBinding.liveIdentity,
          bootId: "87654321-4321-4321-8321-cba987654321",
        },
      },
    }],
    ["malformed path", { ...settled(capturePath), path: 42 }],
  ];
  for (const [name, receipt] of badReceipts) {
    let decisions = 0;
    let trace;
    await assert.doesNotReject(async () => {
      trace = await executeRelativeCameraRoute(
        routeInput(),
        () => decisions++ === 0 ? [{ kind: "key_hold", key: "w", holdMs: 50 }] : "stop",
        dependencies({ captureSettled: async () => receipt }),
      );
    }, name);
    assert.equal(trace.status, "route_unsettled", name);
    assert.equal(decisions, 1, name);
  }
});

test("controller and dependency exceptions fail closed without any later action", async () => {
  await assert.doesNotReject(async () => {
    const trace = await executeRelativeCameraRoute(
      routeInput(),
      () => { throw new Error("controller failed"); },
      dependencies(),
    );
    assert.equal(trace.status, "action_failed");
  });

  let attempts = 0;
  let captures = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => [
      { kind: "key_hold", key: "w", holdMs: 50 },
      { kind: "key_hold", key: "s", holdMs: 50 },
    ],
    dependencies({
      applyRelativeAction: async () => {
        attempts++;
        throw new Error("input adapter failed");
      },
      captureSettled: async (capturePath) => { captures++; return settled(capturePath); },
    }),
  );
  assert.equal(trace.status, "action_failed");
  assert.equal(attempts, 1);
  assert.equal(captures, 0);
});

test("route accounts for every attempted action and exposes retained evidence on a mid-group failure", async () => {
  const actions = [
    { kind: "key_hold", key: "w", holdMs: 50 },
    { kind: "look_drag", dxPx: 3, dyPx: 4 },
    { kind: "key_hold", key: "s", holdMs: 50 },
  ];
  const firstReceipt = applied(actions[0]);
  let attempts = 0;
  let captures = 0;
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => actions,
    dependencies({
      applyRelativeAction: async () => {
        attempts++;
        if (attempts === 1) return firstReceipt;
        throw new Error("adapter exploded after first receipt");
      },
      captureSettled: async (capturePath) => { captures++; return settled(capturePath); },
    }),
  );
  assert.equal(trace.status, "action_failed");
  assert.equal(attempts, 2);
  assert.equal(captures, 0);
  assert.deepEqual(trace.usage, {
    actions: 2,
    waypoints: 0,
    holdMs: 50,
    dragPx: 5,
    durationMs: trace.usage.durationMs,
  });
  assert.equal(trace.terminalActionFailure.kind, "adapter_exception");
  assert.equal(trace.terminalActionFailure.attemptedCount, 2);
  assert.deepEqual(trace.terminalActionFailure.attemptedAction, actions[1]);
  assert.deepEqual(trace.terminalActionFailure.receiptsSoFar, [firstReceipt]);
  assert.equal(trace.terminalActionFailure.terminalReceipt, null);
  assert.match(trace.terminalActionFailure.terminalError, /adapter exploded after first receipt/);
});

test("route retains an applied key and the terminal focus-refused drag receipt from a mixed group", async () => {
  const actions = [
    { kind: "key_hold", key: "w", holdMs: 50 },
    { kind: "look_drag", dxPx: 20, dyPx: 0 },
  ];
  const windowBinding = {
    discoveryFile: runtimeBinding.grpc.discoveryFile,
    discoveredSerial: runtimeBinding.serial,
    qemuPid: runtimeBinding.grpc.qemuPid,
    address: runtimeBinding.grpc.address,
    tokenPresent: true,
    tokenFingerprint: runtimeBinding.grpc.tokenFingerprint,
    onlineEmulatorSerials: [runtimeBinding.serial],
    qemuWindowOwnerPid: runtimeBinding.qemuWindow.ownerPid,
    qemuWindowId: runtimeBinding.qemuWindow.windowId,
    bindingMethod: "discovery-pid-window",
  };
  let captures = 0;
  let dragCalls = 0;
  const adapter = createBoundCameraActionAdapter(runtimeBinding.serial, windowBinding, {
    keyHold: async () => applied(actions[0]),
    focusQemu: async () => "frontmost PID readback mismatch: expected 93013, observed 416",
    rightDrag: async () => { dragCalls++; return null; },
  });
  const trace = await executeRelativeCameraRoute(
    routeInput(),
    () => actions,
    dependencies({
      ...adapter,
      captureSettled: async (capturePath) => { captures++; return settled(capturePath); },
    }),
  );

  assert.equal(trace.status, "action_failed");
  assert.equal(captures, 0);
  assert.equal(dragCalls, 0);
  assert.equal(trace.usage.actions, 2);
  assert.equal(trace.usage.holdMs, 50);
  assert.equal(trace.usage.dragPx, 20);
  assert.equal(trace.terminalActionFailure.kind, "reported_action_failure");
  assert.equal(trace.terminalActionFailure.attemptedCount, 2);
  assert.deepEqual(trace.terminalActionFailure.attemptedAction, actions[1]);
  assert.equal(trace.terminalActionFailure.receiptsSoFar.length, 1);
  assert.equal(trace.terminalActionFailure.receiptsSoFar[0].status, "applied");
  assert.equal(trace.terminalActionFailure.terminalReceipt.status, "failed");
  assert.equal(trace.terminalActionFailure.terminalReceipt.ack.focusAcknowledged, false);
  assert.match(trace.terminalActionFailure.terminalError, /frontmost PID readback mismatch/);
});

test("bound action execution rejects serial and action-kind receipt mismatches", async () => {
  const key = { kind: "key_hold", key: "w", holdMs: 50 };
  await assert.rejects(
    executeBoundCameraActions(runtimeBinding, [key], {
      applyRelativeAction: async (action) => applied(action, "emulator-5556"),
    }),
    /binding mismatch/,
  );
  await assert.rejects(
    executeBoundCameraActions(runtimeBinding, [key], {
      applyRelativeAction: async (action) => ({ ...applied(action), action: "look_drag" }),
    }),
    /binding mismatch/,
  );
});
