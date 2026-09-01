import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { measureTwoColorGuide } from "../dist/navigationguide.js";
import {
  calibrationContextKey,
  calibrationQuality,
  decideNavigationStep,
  fitThroughOrigin,
  validateNavigationCalibration,
} from "../dist/navigationcalibration.js";

const agentBridge = await import("../dist/agentbridge.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures/navigation/guide-controller.v1.json"), "utf8"));

test("measureTwoColorGuide catches a union that drops the outer nested-corners bbox", () => {
  const measured = measureTwoColorGuide(fixture.frame, fixture.guide.valid.detections, fixture.fiducial);
  assert.deepEqual(measured, {
    status: "measured",
    pattern: "nested-corners-v1",
    bbox: [420, 180, 860, 540],
    center: { x: 640, y: 360 },
    error: { x: 0, y: 0 },
    width: 440,
    height: 360,
    areaFraction: 0.171875,
  });
});

test("measureTwoColorGuide catches a center error calculated from the inner color only", () => {
  const measured = measureTwoColorGuide(fixture.frame, fixture.guide.offBand.detections, fixture.fiducial);
  assert.deepEqual(measured, {
    status: "measured",
    pattern: "nested-corners-v1",
    bbox: [550, 200, 990, 560],
    center: { x: 770, y: 380 },
    error: { x: 130, y: 20 },
    width: 440,
    height: 360,
    areaFraction: 0.171875,
  });
});

test("measureTwoColorGuide catches missing, duplicate, non-nested, equal, and neutral guide keys", () => {
  assert.deepEqual(measureTwoColorGuide(fixture.frame, fixture.guide.absent.detections, fixture.fiducial), { status: "rejected", reason: "missing_detection" });
  assert.deepEqual(measureTwoColorGuide(fixture.frame, fixture.guide.duplicate.detections, fixture.fiducial), { status: "rejected", reason: "duplicate_bbox" });
  assert.deepEqual(measureTwoColorGuide(fixture.frame, fixture.guide.nonNested.detections, fixture.fiducial), { status: "rejected", reason: "not_nested" });
  assert.deepEqual(measureTwoColorGuide(fixture.frame, fixture.guide.skewedNested.detections, fixture.fiducial), { status: "rejected", reason: "center_skew" });
  assert.deepEqual(measureTwoColorGuide(fixture.frame, fixture.guide.valid.detections, { ...fixture.fiducial, colors: fixture.guide.equalColors }), { status: "rejected", reason: "colors_not_distinct" });
  assert.deepEqual(measureTwoColorGuide(fixture.frame, fixture.guide.valid.detections, { ...fixture.fiducial, colors: fixture.guide.neutralColors }), { status: "rejected", reason: "colors_not_distinct" });
});

test("measureTwoColorGuide catches stale detector availability and contradictory expected/found maps", () => {
  assert.deepEqual(measureTwoColorGuide(fixture.frame, { ...fixture.guide.valid.detections, available: false }, fixture.fiducial), { status: "rejected", reason: "detector_unavailable" });
  assert.deepEqual(measureTwoColorGuide(fixture.frame, { ...fixture.guide.valid.detections, found: ["magenta"], missing: [] }, fixture.fiducial), { status: "rejected", reason: "detector_inconsistent" });
  assert.deepEqual(measureTwoColorGuide(fixture.frame, { ...fixture.guide.valid.detections, expected: ["magenta"], found: ["magenta", "cyan"], missing: [] }, fixture.fiducial), { status: "rejected", reason: "detector_inconsistent" });
  assert.deepEqual(measureTwoColorGuide(fixture.frame, { ...fixture.guide.valid.detections, missing: ["cyan"] }, fixture.fiducial), { status: "rejected", reason: "detector_inconsistent" });
});

test("fitThroughOrigin catches an intercept-based drag fit and preserves literal residual evidence", () => {
  assert.deepEqual(fitThroughOrigin(fixture.calibration.linearSamples), {
    slope: 0.1,
    sampleCount: 4,
    residuals: [0, 0, 0, 0],
    rmse: 0,
    maxAbsResidual: 0,
    rSquared: 1,
  });
  assert.deepEqual(fitThroughOrigin(fixture.calibration.noisySamples), {
    slope: 0.1,
    sampleCount: 4,
    residuals: [1, -1, -1, 1],
    rmse: 1,
    maxAbsResidual: 1,
    rSquared: 0.975609756097561,
  });
  assert.throws(() => fitThroughOrigin([{ x: 0, y: 1 }, { x: 0, y: 2 }]), /non-zero x/);
  assert.throws(() => fitThroughOrigin([{ x: 1, y: Number.NaN }]), /finite/);
});

test("calibrationQuality catches residual and explained-variance gates", () => {
  const noisy = fitThroughOrigin(fixture.calibration.noisySamples);
  assert.deepEqual(calibrationQuality(noisy, fixture.calibration.limits), { status: "accepted", reasons: [] });
  assert.deepEqual(calibrationQuality(noisy, { ...fixture.calibration.limits, maxRmse: 0.9 }), { status: "rejected", reasons: ["rmse"] });
  assert.deepEqual(calibrationQuality(noisy, { ...fixture.calibration.limits, minRSquared: 0.98 }), { status: "rejected", reasons: ["r_squared"] });
});

function calibrationRecord() {
  return {
    version: 1,
    contextKey: "aa7f0527e087602636e14e49452f3ccedf1ad3c2c994e55dba13e18208d0526d",
    yaw: { samples: fixture.calibration.linearSamples, fit: fixture.calibration.wantLinear },
    pitch: { samples: fixture.calibration.linearSamples, fit: fixture.calibration.wantLinear },
    forward: { samples: fixture.calibration.forwardSamples, fit: fixture.calibration.wantForward },
    limits: fixture.calibration.limits,
  };
}

test("calibrationContextKey catches identity changes while ignoring path and timestamp noise", () => {
  assert.equal(calibrationContextKey(fixture.calibration.context), "aa7f0527e087602636e14e49452f3ccedf1ad3c2c994e55dba13e18208d0526d");
  assert.equal(calibrationContextKey({ ...fixture.calibration.context, cameraCalibrationPath: "/different/path.json", at: "2026-09-01T11:00:00.000Z" }), "aa7f0527e087602636e14e49452f3ccedf1ad3c2c994e55dba13e18208d0526d");
  for (const changed of [
    { bootId: "wrong-boot" },
    { serial: "emulator-5556" },
    { guest: { ...fixture.calibration.context.guest, fingerprint: "wrong-guest" } },
    { guest: { ...fixture.calibration.context.guest, model: "different-guest-model" } },
    { qemu: { ...fixture.calibration.context.qemu, pid: 93014 } },
    { qemu: { ...fixture.calibration.context.qemu, window: { ...fixture.calibration.context.qemu.window, x: 101 } } },
    { qemu: { ...fixture.calibration.context.qemu, window: { ...fixture.calibration.context.qemu.window, y: 201 } } },
    { qemu: { ...fixture.calibration.context.qemu, window: { ...fixture.calibration.context.qemu.window, width: 1279 } } },
    { qemu: { ...fixture.calibration.context.qemu, window: { ...fixture.calibration.context.qemu.window, scale: 1 } } },
    { capture: { ...fixture.calibration.context.capture, height: 719 } },
    { cameraCalibrationSha256: "d".repeat(64) },
    { bridgeRevision: 2 },
    { guide: { ...fixture.calibration.context.guide, pattern: "other-pattern" } },
    { guide: { ...fixture.calibration.context.guide, widthM: 2.1 } },
    { guide: { ...fixture.calibration.context.guide, heightM: 1.3 } },
  ]) assert.notEqual(calibrationContextKey({ ...fixture.calibration.context, ...changed }), "aa7f0527e087602636e14e49452f3ccedf1ad3c2c994e55dba13e18208d0526d");
});

test("validateNavigationCalibration catches stale identity, unsigned drags, backward motion, and forged fit quality", () => {
  const record = calibrationRecord();
  assert.deepEqual(validateNavigationCalibration(record, fixture.calibration.context), { status: "valid", contextKey: "aa7f0527e087602636e14e49452f3ccedf1ad3c2c994e55dba13e18208d0526d" });
  assert.deepEqual(validateNavigationCalibration(record, { ...fixture.calibration.context, bootId: "wrong-boot" }), { status: "invalid", reason: "context_mismatch" });
  assert.deepEqual(validateNavigationCalibration({ ...record, yaw: { ...record.yaw, samples: [{ x: 40, y: 4 }, { x: 80, y: 8 }, { x: 120, y: 12 }, { x: 160, y: 16 }] } }, fixture.calibration.context), { status: "invalid", reason: "insufficient_signed_drag_trials" });
  assert.deepEqual(validateNavigationCalibration({ ...record, forward: { ...record.forward, samples: [{ x: 100, y: -0.5 }, { x: 200, y: 1 }, { x: 300, y: 1.5 }, { x: 400, y: 2 }] } }, fixture.calibration.context), { status: "invalid", reason: "non_positive_forward_displacement" });
  assert.deepEqual(validateNavigationCalibration({ ...record, yaw: { ...record.yaw, fit: { ...record.yaw.fit, rmse: 1.1 } } }, fixture.calibration.context), { status: "invalid", reason: "quality_rejected" });
  assert.deepEqual(validateNavigationCalibration({ ...record, yaw: { ...record.yaw, fit: { ...record.yaw.fit, slope: 0.2 } } }, fixture.calibration.context), { status: "invalid", reason: "fit_mismatch" });
  assert.doesNotThrow(() => validateNavigationCalibration({ ...record, forward: { ...record.forward, fit: undefined } }, fixture.calibration.context));
  assert.deepEqual(validateNavigationCalibration({ ...record, forward: { ...record.forward, fit: undefined } }, fixture.calibration.context), { status: "invalid", reason: "invalid_record" });
  assert.deepEqual(validateNavigationCalibration({ ...record, yaw: { ...record.yaw, samples: undefined } }, fixture.calibration.context), { status: "invalid", reason: "invalid_record" });
  assert.deepEqual(validateNavigationCalibration({ ...record, forward: undefined }, fixture.calibration.context), { status: "invalid", reason: "invalid_record" });
});

function controllerState(overrides = {}) {
  return {
    centerBandPx: fixture.controller.centerBandPx,
    targetAreaFraction: fixture.controller.targetAreaFraction,
    motionPolicy: fixture.controller.motionPolicy,
    actionCount: 0,
    elapsedMs: 0,
    cumulativeDragPx: 0,
    cumulativeHoldMs: 0,
    phase: "acquire",
    areaHistory: [],
    ...overrides,
  };
}

const validApproachCalibration = { status: "valid" };
const invalidApproachCalibration = { status: "invalid" };
const centeredSmall = { guide: { status: "measured", error: { x: 0, y: 0 }, areaFraction: 0.05 } };

test("decideNavigationStep catches an acquisition search that includes a vertical drag", () => {
  assert.deepEqual(decideNavigationStep(controllerState(), { guide: null }, invalidApproachCalibration), {
    kind: "drag", mode: "search_horizontal", dxPx: 120, dyPx: 0, gain: 1, achievedClaims: [],
  });
});

test("decideNavigationStep catches a search drag that exceeds the remaining cumulative drag budget", () => {
  assert.deepEqual(decideNavigationStep(controllerState({ cumulativeDragPx: 1439 }), { guide: null }, invalidApproachCalibration), {
    kind: "drag", mode: "search_horizontal", dxPx: 1, dyPx: 0, gain: 1, achievedClaims: [],
  });
});

test("decideNavigationStep catches a fractional drag remainder that cannot form a route-valid action", () => {
  assert.deepEqual(decideNavigationStep(controllerState({ cumulativeDragPx: 1439.5 }), { guide: null }, invalidApproachCalibration), {
    kind: "stop", reason: "budget_exhausted", achievedClaims: [],
  });
});

test("decideNavigationStep catches a center-band target that fails to retain target_centered", () => {
  assert.deepEqual(decideNavigationStep(controllerState(), centeredSmall, invalidApproachCalibration), {
    kind: "calibration_required", reason: "approach_requires_calibration", achievedClaims: ["target_visible", "target_centered"],
  });
});

test("decideNavigationStep catches unclamped yaw and pitch centering", () => {
  assert.deepEqual(decideNavigationStep(controllerState(), { guide: { status: "measured", error: { x: 400, y: -200 }, areaFraction: 0.05 } }, validApproachCalibration), {
    kind: "drag", mode: "center", dxPx: 107, dyPx: -53, gain: 1, achievedClaims: ["target_visible"],
  });
});

test("decideNavigationStep catches an overshoot that does not reduce centering gain", () => {
  assert.deepEqual(decideNavigationStep(controllerState({ lastError: { x: 100, y: 0 } }), { guide: { status: "measured", error: { x: -100, y: 0 }, areaFraction: 0.05 } }, validApproachCalibration), {
    kind: "drag", mode: "center", dxPx: -50, dyPx: 0, gain: 0.5, achievedClaims: ["target_visible"],
  });
});

test("decideNavigationStep catches a pitch-guard violation that issues forward hold", () => {
  assert.deepEqual(decideNavigationStep(controllerState(), { guide: { status: "measured", error: { x: 0, y: 100 }, areaFraction: 0.05 } }, validApproachCalibration), {
    kind: "drag", mode: "center", dxPx: 0, dyPx: 100, gain: 1, achievedClaims: ["target_visible"],
  });
});

test("decideNavigationStep catches a growing guide that does not approach forward", () => {
  assert.deepEqual(decideNavigationStep(controllerState({ phase: "approach", areaHistory: [0.03, 0.05, 0.07] }), { guide: { status: "measured", error: { x: 0, y: 0 }, areaFraction: 0.07 } }, validApproachCalibration), {
    kind: "hold", key: "w", holdMs: 100, achievedClaims: ["target_visible", "target_centered"],
  });
});

test("decideNavigationStep catches a forward hold that exceeds the remaining cumulative hold budget", () => {
  assert.deepEqual(decideNavigationStep(controllerState({ phase: "approach", cumulativeHoldMs: 2999 }), centeredSmall, validApproachCalibration), {
    kind: "hold", key: "w", holdMs: 1, achievedClaims: ["target_visible", "target_centered"],
  });
});

test("decideNavigationStep catches a fractional hold remainder that cannot form a route-valid action", () => {
  assert.deepEqual(decideNavigationStep(controllerState({ phase: "approach", cumulativeHoldMs: 2999.5 }), centeredSmall, validApproachCalibration), {
    kind: "stop", reason: "budget_exhausted", achievedClaims: [],
  });
});

test("decideNavigationStep catches two shrinking observations that continue approach", () => {
  assert.deepEqual(decideNavigationStep(controllerState({ phase: "approach", areaHistory: fixture.controller.shrinkingAreas }), { guide: { status: "measured", error: { x: 0, y: 0 }, areaFraction: 0.08 } }, validApproachCalibration), {
    kind: "requery", reason: "guide_shrank_twice", achievedClaims: ["target_visible", "target_centered"],
  });
});

test("decideNavigationStep catches a disappeared approach guide that keeps searching", () => {
  assert.deepEqual(decideNavigationStep(controllerState({ phase: "approach" }), { guide: null }, validApproachCalibration), {
    kind: "requery", reason: "guide_disappeared", achievedClaims: ["target_visible", "target_centered"],
  });
});

test("decideNavigationStep catches target-area completion, action/time exhaustion, scene drift, and cleanup status", () => {
  assert.deepEqual(decideNavigationStep(controllerState(), { guide: { status: "measured", error: { x: 0, y: 0 }, areaFraction: 0.1 } }, validApproachCalibration), {
    kind: "stop", reason: "objective_satisfied", achievedClaims: ["target_visible", "target_centered", "free_camera_approached"],
  });
  assert.deepEqual(decideNavigationStep(controllerState({ actionCount: 24 }), centeredSmall, invalidApproachCalibration), { kind: "stop", reason: "budget_exhausted", achievedClaims: [] });
  assert.deepEqual(decideNavigationStep(controllerState({ elapsedMs: 180000 }), centeredSmall, invalidApproachCalibration), { kind: "stop", reason: "budget_exhausted", achievedClaims: [] });
  assert.deepEqual(decideNavigationStep(controllerState(), { ...centeredSmall, sceneDrift: true }, validApproachCalibration), { kind: "stop", reason: "scene_drift", achievedClaims: [] });
  assert.deepEqual(decideNavigationStep(controllerState({ cleanup: "required" }), centeredSmall, invalidApproachCalibration), { kind: "cleanup", status: "required", achievedClaims: [] });
  assert.deepEqual(decideNavigationStep(controllerState({ cleanup: "failed" }), centeredSmall, invalidApproachCalibration), { kind: "stop", reason: "cleanup_failed", achievedClaims: [] });
});

const GUIDE_KIND = "pico.agent-bridge.navigation-guide";
const GUIDE_COLORS = [[255, 0, 255], [0, 255, 255]];
const GUIDE_PROJECTION_MODEL = "viewer-facing-planar-v1";

function guideRequest(overrides = {}) {
  return {
    serial: "emulator-5554",
    packageName: "com.fleet.swanmissiontable",
    requestId: "guide_nonce_20260901",
    mode: "show",
    sceneSnapshotId: "a".repeat(64),
    targetTraceId: "anchor-0007",
    targetRuntimeUuid: "70dc90a0-8873-42de-b006-20c021381ecd",
    pattern: "nested-corners-v1",
    projectionModel: GUIDE_PROJECTION_MODEL,
    colors: structuredClone(GUIDE_COLORS),
    widthM: 0.74,
    heightM: 0.44,
    maxPolls: 3,
    pollMs: 10,
    stabilityReads: 2,
    ...overrides,
  };
}

function guideAck(request, overrides = {}) {
  return {
    kind: GUIDE_KIND,
    schemaVersion: 1,
    bridgeRevision: 1,
    requestId: request.requestId,
    application: { packageName: request.packageName },
    mode: request.mode,
    sceneSnapshotId: request.sceneSnapshotId,
    targetTraceId: request.targetTraceId,
    targetRuntimeUuid: request.targetRuntimeUuid,
    pattern: request.pattern,
    projectionModel: request.projectionModel,
    colors: structuredClone(request.colors),
    widthM: request.widthM,
    heightM: request.heightM,
    outcome: request.mode === "show" ? "shown" : "hidden",
    guideState: request.mode === "show" ? "visible" : "hidden",
    cleanupState: request.mode === "show" ? "not_required" : "completed",
    error: null,
    ...overrides,
  };
}

function successfulGuideTransport(ack, options = {}) {
  const calls = [];
  const ackBytes = Buffer.from(JSON.stringify(ack), "utf8");
  let activeRequestId = ack.requestId;
  let activeMode = ack.mode;
  let cleanupAttempts = 0;
  let ticks = 500n;
  return {
    calls,
    deps: {
      monotonicNs: () => ticks++,
      runText: async (cmd, args) => {
        calls.push({ kind: "text", cmd, args });
        if (args.includes("rm")) {
          cleanupAttempts++;
          return (options.cleanupFailure && cleanupAttempts === 1) || options.cleanupFailureAt === cleanupAttempts
            ? { code: 1, stdout: "", stderr: "permission denied", timedOut: false }
            : { code: 0, stdout: "", stderr: "", timedOut: false };
        }
        const requestIndex = args.findIndex((arg, index) => arg === "requestId" && args[index - 1] === "--es");
        const modeIndex = args.findIndex((arg, index) => arg === "mode" && args[index - 1] === "--es");
        if (requestIndex >= 0) activeRequestId = args[requestIndex + 1];
        if (modeIndex >= 0) activeMode = args[modeIndex + 1];
        return { code: 0, stdout: "Broadcast completed: result=0", stderr: "", timedOut: false };
      },
      runBytes: async (cmd, args) => {
        calls.push({ kind: "bytes", cmd, args });
        const bytes = activeMode === "hide" && options.invalidationBase
          ? Buffer.from(JSON.stringify(guideAck({ ...options.invalidationBase, requestId: activeRequestId, mode: "hide" })), "utf8")
          : ackBytes;
        return { code: 0, stdout: Buffer.concat([Buffer.from([0x01]), bytes]), stderr: "", timedOut: false };
      },
      sleep: async () => {},
    },
  };
}

function guideAdapter() {
  assert.equal(typeof agentBridge.requestAgentBridgeNavigationGuide, "function", "navigation-guide host adapter must be exported");
  return agentBridge.requestAgentBridgeNavigationGuide;
}

test("navigation-guide transport catches a broadcast that omits an identity or fiducial field", async () => {
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_PAYLOAD_KIND, GUIDE_KIND);
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_SCHEMA_VERSION, 1);
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION, 1);
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_COMMAND, "navigation_guide");
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_CACHE_DIRECTORY, "agentbridge/navigation-guides");
  assert.deepEqual(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS, GUIDE_COLORS);
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL, GUIDE_PROJECTION_MODEL);
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M, 0.74);
  assert.equal(agentBridge.AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M, 0.44);

  const request = guideRequest();
  const expectedAck = guideAck(request);
  const fake = successfulGuideTransport(expectedAck);
  const result = await guideAdapter()("/fixture/adb", request, fake.deps);

  assert.equal(result.ok, true);
  assert.equal(result.evidenceCeiling, "structural");
  assert.deepEqual(result.ack, expectedAck);
  assert.deepEqual(fake.calls[0], {
    kind: "text",
    cmd: "/fixture/adb",
    args: [
      "-s", "emulator-5554", "shell", "am", "broadcast",
      "-a", "com.fleet.swanmissiontable.AGENT_CMD", "-p", "com.fleet.swanmissiontable",
      "--es", "cmd", "navigation_guide",
      "--es", "kind", GUIDE_KIND,
      "--ei", "schemaVersion", "1",
      "--ei", "bridgeRevision", "1",
      "--es", "requestId", "guide_nonce_20260901",
      "--es", "mode", "show",
      "--es", "sceneSnapshotId", "a".repeat(64),
      "--es", "targetTraceId", "anchor-0007",
      "--es", "targetRuntimeUuid", "70dc90a0-8873-42de-b006-20c021381ecd",
      "--es", "pattern", "nested-corners-v1",
      "--es", "projectionModel", GUIDE_PROJECTION_MODEL,
      "--es", "color0", "255,0,255",
      "--es", "color1", "0,255,255",
      "--ef", "widthM", "0.74",
      "--ef", "heightM", "0.44",
    ],
  });
  const privatePath = "cache/agentbridge/navigation-guides/guide_nonce_20260901.json";
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 2, "two byte-identical reads make the atomic ack stable");
  assert.ok(fake.calls.filter((call) => call.kind === "bytes").every((call) =>
    call.args[0] === "-s" && call.args[1] === request.serial
    && call.args.join(" ").includes("exec-out run-as com.fleet.swanmissiontable sh -c")
    && call.args.at(-1) === privatePath));
  assert.deepEqual(fake.calls.at(-1), {
    kind: "text",
    cmd: "/fixture/adb",
    args: ["-s", request.serial, "shell", "run-as", request.packageName, "rm", "-f", privatePath],
  });
  assert.deepEqual(result.actionReceipts.map((receipt) => [receipt.action, receipt.status]), [
    ["navigation_guide_broadcast", "applied"],
    ["navigation_guide_ack_pull", "applied"],
    ["navigation_guide_ack_cleanup", "applied"],
  ]);
  assert.equal(result.actionReceipts[1].ack.stabilityReads, 2);
  assert.equal(result.actionReceipts[2].ack.relativePath, privatePath);
  assert.ok(result.actionReceipts.every((receipt) => /^\d+$/.test(receipt.startedAtMonotonicNs) && /^\d+$/.test(receipt.endedAtMonotonicNs)));
  assert.equal(fake.calls.some((call) => call.args.includes("logcat")), false);
});

test("navigation-guide transport accepts an exact hide acknowledgement", async () => {
  const request = guideRequest({ mode: "hide" });
  const expectedAck = guideAck(request);
  const fake = successfulGuideTransport(expectedAck);
  const result = await guideAdapter()("/fixture/adb", request, fake.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ack, expectedAck);
  assert.equal(result.ack.outcome, "hidden");
  assert.equal(result.ack.guideState, "hidden");
  assert.equal(result.ack.cleanupState, "completed");
  const broadcastArgs = fake.calls[0].args;
  assert.ok(broadcastArgs.some((arg, index) => arg === "mode" && broadcastArgs[index + 1] === "hide"));
  assert.deepEqual(result.actionReceipts.map((receipt) => [receipt.action, receipt.status]), [
    ["navigation_guide_broadcast", "applied"],
    ["navigation_guide_ack_pull", "applied"],
    ["navigation_guide_ack_cleanup", "applied"],
  ]);
});

test("navigation-guide transport rejects unsupported producer inputs before broadcast", async (t) => {
  const invalidRequests = [
    ["pattern", { pattern: "solid-box-v1" }],
    ["projection model", { projectionModel: "table-plane-v1" }],
    ["palette", { colors: [[0, 255, 255], [255, 0, 255]] }],
    ["width", { widthM: 0.73 }],
    ["height", { heightM: 0.43 }],
  ];
  for (const [name, overrides] of invalidRequests) {
    await t.test(name, async () => {
      let transportCalls = 0;
      const request = guideRequest(overrides);
      const result = await guideAdapter()("/fixture/adb", request, {
        runText: async () => { transportCalls++; throw new Error("must not broadcast"); },
        runBytes: async () => { transportCalls++; throw new Error("must not pull"); },
        sleep: async () => { transportCalls++; },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "bridge_unavailable");
      assert.equal(result.evidenceCeiling, "structural");
      assert.deepEqual(result.actionReceipts, []);
      assert.equal(transportCalls, 0);
    });
  }
});

test("navigation-guide transport catches malformed, stale, contradictory, partial, or substituted terminal acks", async (t) => {
  const request = guideRequest();
  const mutations = [
    ["malformed JSON", null],
    ["extra field", (ack) => { ack.untrusted = true; }],
    ["wrong kind", (ack) => { ack.kind = "pico.agent-bridge.scene-snapshot"; }],
    ["wrong schema", (ack) => { ack.schemaVersion = 2; }],
    ["wrong revision", (ack) => { ack.bridgeRevision = 41; }],
    ["wrong request", (ack) => { ack.requestId = "guide_nonce_stale_20260901"; }],
    ["wrong package", (ack) => { ack.application.packageName = "com.attacker.other"; }],
    ["wrong mode", (ack) => { ack.mode = "hide"; }],
    ["stale snapshot", (ack) => { ack.sceneSnapshotId = "b".repeat(64); }],
    ["wrong trace", (ack) => { ack.targetTraceId = "anchor-0008"; }],
    ["wrong runtime UUID", (ack) => { ack.targetRuntimeUuid = "807c3532-b135-45aa-a181-34d6c7612ab6"; }],
    ["wrong pattern", (ack) => { ack.pattern = "solid-box-v1"; }],
    ["wrong projection model", (ack) => { ack.projectionModel = "table-plane-v1"; }],
    ["wrong color order", (ack) => { ack.colors.reverse(); }],
    ["wrong width", (ack) => { ack.widthM = 0.73; }],
    ["wrong height", (ack) => { ack.heightM = 0.43; }],
    ["contradictory shown state", (ack) => { ack.guideState = "hidden"; ack.cleanupState = "completed"; }],
    ["partial", (ack) => { delete ack.targetTraceId; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const ack = guideAck(request);
      if (mutate) mutate(ack);
      const fake = successfulGuideTransport(ack, { invalidationBase: request });
      if (!mutate) {
        const bytes = Buffer.from("AGENTBRIDGE| event=navigation_guide_ack outcome=shown", "utf8");
        const invalidationRunBytes = fake.deps.runBytes;
        fake.deps.runBytes = async (cmd, args) => {
          if (args.at(-1) !== `cache/agentbridge/navigation-guides/${request.requestId}.json`) {
            return invalidationRunBytes(cmd, args);
          }
          fake.calls.push({ kind: "bytes", cmd, args });
          return { code: 0, stdout: Buffer.concat([Buffer.from([0x01]), bytes]), stderr: "", timedOut: false };
        };
      }
      const result = await guideAdapter()("/fixture/adb", request, fake.deps);
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid_ack");
      assert.deepEqual(result.actionReceipts.map((receipt) => receipt.action), [
        "navigation_guide_broadcast",
        "navigation_guide_ack_pull",
        "navigation_guide_ack_cleanup",
        "navigation_guide_invalidation_broadcast",
        "navigation_guide_invalidation_ack_pull",
        "navigation_guide_invalidation_ack_cleanup",
        "navigation_guide_late_ack_cleanup",
      ]);
      assert.equal(result.actionReceipts.at(-1)?.status, "applied");
    });
  }
});

test("navigation-guide transport catches guest rejection and host cleanup loss without erasing evidence", async () => {
  const request = guideRequest();
  const rejectedAck = guideAck(request, {
    outcome: "rejected",
    guideState: "hidden",
    cleanupState: "completed",
    error: { code: "target_drift", detail: "selected TABLE runtime UUID changed" },
  });
  const rejectedFake = successfulGuideTransport(rejectedAck);
  const rejected = await guideAdapter()("/fixture/adb", request, rejectedFake.deps);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "guest_rejected");
  assert.deepEqual(rejected.ack, rejectedAck);
  assert.deepEqual(rejected.actionReceipts.map((receipt) => receipt.action), [
    "navigation_guide_broadcast", "navigation_guide_ack_pull", "navigation_guide_ack_cleanup",
  ]);

  const acceptedAck = guideAck(request);
  const cleanupFake = successfulGuideTransport(acceptedAck, { cleanupFailure: true, invalidationBase: request });
  const cleanupFailed = await guideAdapter()("/fixture/adb", request, cleanupFake.deps);
  assert.equal(cleanupFailed.ok, false);
  assert.equal(cleanupFailed.code, "cleanup_failed");
  assert.deepEqual(cleanupFailed.ack, acceptedAck);
  assert.equal(cleanupFailed.actionReceipts[2]?.action, "navigation_guide_ack_cleanup");
  assert.equal(cleanupFailed.actionReceipts[2]?.status, "failed");
  assert.match(cleanupFailed.actionReceipts[2]?.error ?? "", /permission denied/);
  assert.deepEqual(cleanupFailed.actionReceipts.slice(3).map((receipt) => [receipt.action, receipt.status]), [
    ["navigation_guide_invalidation_broadcast", "applied"],
    ["navigation_guide_invalidation_ack_pull", "applied"],
    ["navigation_guide_invalidation_ack_cleanup", "applied"],
    ["navigation_guide_late_ack_cleanup", "applied"],
  ]);
});

test("navigation-guide transport orders a newer hide after a delayed show timeout and sweeps its late ack", async () => {
  const request = guideRequest({ maxPolls: 2 });
  const originalPath = "cache/agentbridge/navigation-guides/guide_nonce_20260901.json";
  const invalidationRequestId = "navigation_guide_hide_0c21bb6fc0256852d5a82fc5f1ad122f";
  const invalidationPath = `cache/agentbridge/navigation-guides/${invalidationRequestId}.json`;
  const files = new Map();
  const calls = [];
  const removals = [];
  let ticks = 900n;

  const result = await guideAdapter()("/fixture/adb", request, {
    monotonicNs: () => ticks++,
    runText: async (cmd, args) => {
      calls.push({ kind: "text", cmd, args: [...args] });
      if (args.includes("rm")) {
        const target = args.at(-1);
        removals.push({ target, existed: files.delete(target) });
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      const modeIndex = args.findIndex((arg, index) => arg === "mode" && args[index - 1] === "--es");
      const requestIndex = args.findIndex((arg, index) => arg === "requestId" && args[index - 1] === "--es");
      const mode = args[modeIndex + 1];
      const requestId = args[requestIndex + 1];
      if (mode === "hide") {
        assert.equal(requestId, invalidationRequestId, "the compensating hide uses its own deterministic safe nonce");
        files.set(originalPath, Buffer.from(JSON.stringify(guideAck(request)), "utf8"));
        files.set(invalidationPath, Buffer.from(JSON.stringify(guideAck({ ...request, requestId, mode: "hide" })), "utf8"));
      }
      return { code: 0, stdout: "Broadcast completed: result=0", stderr: "", timedOut: false };
    },
    runBytes: async (cmd, args) => {
      calls.push({ kind: "bytes", cmd, args: [...args] });
      const bytes = files.get(args.at(-1));
      return bytes
        ? { code: 0, stdout: Buffer.concat([Buffer.from([0x01]), bytes]), stderr: "", timedOut: false }
        : { code: 0, stdout: Buffer.from([0x00]), stderr: "", timedOut: false };
    },
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "bridge_unavailable", "a successful invalidation cannot erase the timed-out show result");
  const broadcasts = calls.filter((call) => call.kind === "text" && call.args.includes("broadcast"));
  assert.equal(broadcasts.length, 2, "one failed show triggers exactly one non-recursive hide");
  assert.ok(broadcasts[0].args.some((arg, index) => arg === "mode" && broadcasts[0].args[index + 1] === "show"));
  assert.ok(broadcasts[1].args.some((arg, index) => arg === "mode" && broadcasts[1].args[index + 1] === "hide"));
  for (const field of [
    "kind", "schemaVersion", "bridgeRevision", "sceneSnapshotId", "targetTraceId",
    "targetRuntimeUuid", "pattern", "projectionModel", "color0", "color1", "widthM", "heightM",
  ]) {
    const originalIndex = broadcasts[0].args.indexOf(field);
    const hideIndex = broadcasts[1].args.indexOf(field);
    assert.equal(broadcasts[1].args[hideIndex + 1], broadcasts[0].args[originalIndex + 1], `hide retains ${field}`);
  }
  assert.deepEqual(result.actionReceipts.map((receipt) => [receipt.action, receipt.status]), [
    ["navigation_guide_broadcast", "applied"],
    ["navigation_guide_ack_pull", "failed"],
    ["navigation_guide_ack_cleanup", "applied"],
    ["navigation_guide_invalidation_broadcast", "applied"],
    ["navigation_guide_invalidation_ack_pull", "applied"],
    ["navigation_guide_invalidation_ack_cleanup", "applied"],
    ["navigation_guide_late_ack_cleanup", "applied"],
  ]);
  assert.deepEqual(removals, [
    { target: originalPath, existed: false },
    { target: invalidationPath, existed: true },
    { target: originalPath, existed: true },
  ], "the post-hide sweep removes an original ack that arrived after the first cleanup");
  assert.equal(files.size, 0);
});

test("navigation-guide transport keeps invalidation ack cleanup failure terminal", async () => {
  const request = guideRequest();
  const malformedShowAck = guideAck(request, { projectionModel: "horizontal-plane-v1" });
  const fake = successfulGuideTransport(malformedShowAck, {
    cleanupFailureAt: 2,
    invalidationBase: request,
  });
  const result = await guideAdapter()("/fixture/adb", request, fake.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, "cleanup_failed");
  assert.deepEqual(result.actionReceipts.slice(3).map((receipt) => [receipt.action, receipt.status]), [
    ["navigation_guide_invalidation_broadcast", "applied"],
    ["navigation_guide_invalidation_ack_pull", "applied"],
    ["navigation_guide_invalidation_ack_cleanup", "failed"],
    ["navigation_guide_late_ack_cleanup", "applied"],
  ]);
  assert.match(result.actionReceipts[5]?.error ?? "", /permission denied/);
});

test("navigation-guide transport catches an unbounded poll or logcat-shaped fallback", async () => {
  const request = guideRequest({ maxPolls: 3 });
  const calls = [];
  let pulls = 0;
  let sleeps = 0;
  const result = await guideAdapter()("/fixture/adb", request, {
    runText: async (cmd, args) => {
      calls.push({ kind: "text", cmd, args });
      return {
        code: 0,
        stdout: `AGENTBRIDGE| event=navigation_guide_ack requestId=${request.requestId} outcome=shown`,
        stderr: "",
        timedOut: false,
      };
    },
    runBytes: async (cmd, args) => {
      calls.push({ kind: "bytes", cmd, args });
      pulls++;
      return { code: 0, stdout: Buffer.from([0x00]), stderr: "", timedOut: false };
    },
    sleep: async () => { sleeps++; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "cleanup_failed");
  assert.equal(pulls, 6, "the original and one compensating transaction each keep the three-poll bound");
  assert.equal(sleeps, 4);
  assert.equal(calls.some((call) => call.args.includes("logcat")), false);
  assert.deepEqual(result.actionReceipts.map((receipt) => [receipt.action, receipt.status]), [
    ["navigation_guide_broadcast", "applied"],
    ["navigation_guide_ack_pull", "failed"],
    ["navigation_guide_ack_cleanup", "applied"],
    ["navigation_guide_invalidation_broadcast", "applied"],
    ["navigation_guide_invalidation_ack_pull", "failed"],
    ["navigation_guide_invalidation_ack_cleanup", "applied"],
    ["navigation_guide_late_ack_cleanup", "applied"],
  ]);
  assert.equal(calls.filter((call) => call.kind === "text" && call.args.includes("broadcast")).length, 2,
    "a failed compensating hide never recursively schedules another hide");
});
