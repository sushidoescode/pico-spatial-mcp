import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
import {
  executeNavigateToSceneTarget,
  registerNavigationTargetTools,
} from "../dist/navigationtarget.js";
const navigationTargetModule = await import("../dist/navigationtarget.js");
import { readFreshCameraCalibrationProof } from "../dist/metricverify.js";

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
    { guide: { ...fixture.calibration.context.guide, projectionModel: "other-projection" } },
    { guide: { ...fixture.calibration.context.guide, colors: [[1, 2, 3], [4, 5, 6]] } },
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

async function generatedAgentBridgeKotlin() {
  let handler;
  agentBridge.registerAgentBridgeTools({
    registerTool: (name, _meta, candidate) => {
      if (name === "generate_agent_bridge") handler = candidate;
    },
  });
  assert.equal(typeof handler, "function");
  const payload = JSON.parse((await handler({ packageName: "com.test.navigation.agent" })).content[0].text);
  return payload.files.find((file) => file.path.endsWith("/AgentBridge.kt"))?.content ?? "";
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
  assert.equal(result.terminalGuideState, "visible");
  assert.equal(result.cleanupProven, false);
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
  assert.equal(result.terminalGuideState, "hidden");
  assert.equal(result.cleanupProven, true);
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
  assert.equal(result.terminalGuideState, "hidden");
  assert.equal(result.cleanupProven, true);
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

test("generated guest drops a SHOW that first reaches the mutex after HIDE acknowledgement and host sweep", async () => {
  const kotlin = await generatedAgentBridgeKotlin();
  const writer = /private suspend fun writeNavigationGuideAck[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(kotlin)?.[0] ?? "";
  const initialStaleBranch = /val binding = navigationGuideProducerBinding\(request\.generation\)[\s\S]*?if \(!binding\.generationIsCurrent\) \{([\s\S]*?)\n            \}/.exec(writer)?.[1] ?? "";

  // Deterministic inverted acquisition: SHOW(g1) is launched but paused before Mutex.lock; HIDE(g2)
  // locks, hides, acks, and both nonce files are swept. SHOW(g3) is then acknowledged visible before
  // the paused g1 coroutine is released. Interpreting the generated g1 pre-producer branch must leave
  // that current visible state and both swept nonce paths untouched.
  const files = new Set();
  const effects = { producerMutations: 0, cleanups: 0, obsoleteAcks: 0 };
  let guideState = "hidden";
  guideState = "hidden"; // HIDE(g2) producer mutation.
  files.add("hide-g2.json");
  files.delete("hide-g2.json");
  files.delete("show-g1.json"); // Host post-HIDE sweep while g1 has still not reached the mutex.
  guideState = "visible"; // A later SHOW(g3) has acquired, published, and been acknowledged.
  files.add("show-g3.json");
  files.delete("show-g3.json");

  const staleReturnsBeforeSideEffects = /\breturn\b/.test(initialStaleBranch) &&
    !/cleanupNavigationGuideAfterRejection|binding\.producer|writeNavigationGuideAckAtomically/.test(initialStaleBranch);
  if (!staleReturnsBeforeSideEffects) {
    if (/!binding\.generationIsCurrent[\s\S]*staleNavigationGuideResult/.test(writer)) {
      effects.cleanups++;
      guideState = "hidden";
    }
    if (/writeNavigationGuideAckAtomically\(context, request, target, result\)/.test(writer)) {
      effects.obsoleteAcks++;
      files.add("show-g1.json");
    }
  }

  assert.deepEqual(effects, { producerMutations: 0, cleanups: 0, obsoleteAcks: 0 });
  assert.equal(guideState, "visible", "releasing stale g1 cannot hide the acknowledged g3 SHOW");
  assert.deepEqual([...files], [], "releasing stale g1 cannot recreate its already-swept nonce");
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
  assert.equal(result.terminalGuideState, "unknown");
  assert.equal(result.cleanupProven, false);
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
  assert.equal(result.terminalGuideState, "unknown");
  assert.equal(result.cleanupProven, false);
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

const TARGET_SERIAL = "emulator-5554";
const TARGET_PACKAGE = "com.fleet.swanmissiontable";
const TARGET_BOOT = "12345678-1234-4234-8234-123456789abc";
const TARGET_APK_SHA = "b".repeat(64);
const TARGET_BUILD_RECEIPT = "e".repeat(64);
const TARGET_WINDOW = { id: 7, x: 101, y: 202, width: 1280, height: 720, scale: 2 };
const TARGET_CAMERA = {
  f: 1000,
  eyeHeight: 1.65,
  cx: 640,
  cy: 360,
  width: 1280,
  height: 720,
  residualPx: 0.5,
  solvedFrom: "fixture-camera-calibration",
  at: "2026-09-01T12:00:10.000Z",
};
const TARGET_CAMERA_BYTES = Buffer.from(JSON.stringify(TARGET_CAMERA), "utf8");
const TARGET_CAMERA_SHA = crypto.createHash("sha256").update(TARGET_CAMERA_BYTES).digest("hex");

function targetMotionPolicy(overrides = {}) {
  return {
    maxDragPxPerAction: 120,
    maxCumulativeDragPx: 1440,
    maxHoldMsPerAction: 250,
    maxCumulativeHoldMs: 3000,
    maxActions: 32,
    maxDurationSec: 5000,
    ...overrides,
  };
}

function targetInput(action = "navigate", overrides = {}) {
  return {
    action,
    serial: TARGET_SERIAL,
    scenario: {
      packageName: TARGET_PACKAGE,
      expectedBuildReceiptId: TARGET_BUILD_RECEIPT,
      expectedStageStyle: "Mixed",
      expectedRootContainer: "stage",
      sceneDriftPolicy: {
        count: "advisory",
        maxTransformDeltaM: 0.01,
        maxTransformDeltaDeg: 1,
        maxExtentDeltaM: 0.01,
        topology: "strict",
      },
    },
    target: {
      label: "TABLE",
      selector: {
        kind: "largest_horizontal",
        minUpDot: 0.85,
        ambiguity: { metric: "area_ratio", minSeparation: 0.15 },
      },
    },
    objective: "inspect",
    fiducial: {
      colors: structuredClone(GUIDE_COLORS),
      pattern: "nested-corners-v1",
      requireGuideOffOnDelta: true,
    },
    centerBandPx: { x: 90, y: 70 },
    targetAreaFraction: { min: 0.08, max: 0.25 },
    motionPolicy: targetMotionPolicy(),
    outDir: `/tmp/pico-navigationtarget-tests/${action}-run`,
    ...overrides,
  };
}

function rawTableAnchor(overrides = {}) {
  const x = overrides.x ?? 0;
  const y = overrides.y ?? 0.75;
  const z = overrides.z ?? -1.5;
  const worldFromAnchor = overrides.worldFromAnchor ?? [
    1, 0, 0, x,
    0, 1, 0, y,
    0, 0, 1, z,
    0, 0, 0, 1,
  ];
  return {
    runtimeUuid: overrides.runtimeUuid ?? "70dc90a0-8873-42de-b006-20c021381ecd",
    worldFromAnchor,
    positionM: overrides.positionM ?? [x, y, z],
    rotationQuaternionXyzw: overrides.rotationQuaternionXyzw ?? [0, 0, 0, 1],
    boundsM: overrides.boundsM ?? [1.2, 0.1, 0.8],
    vertices: overrides.vertices ?? [-0.6, 0, -0.4, 0.6, 0, -0.4, 0.6, 0, 0.4, -0.6, 0, 0.4],
    indices: overrides.indices ?? [0, 1, 2, 0, 2, 3],
    semanticAssignments: overrides.semanticAssignments ?? ["TABLE", "TABLE"],
  };
}

function noSceneDrift(policy) {
  return {
    effectivePolicy: structuredClone(policy),
    exactSnapshotChanged: false,
    withinPolicy: true,
    countDelta: 0,
    maxTransformDeltaM: 0,
    maxTransformDeltaDeg: 0,
    maxExtentDeltaM: 0,
    labelSetChanges: 0,
    topologyChanges: 0,
    unmatchedPrevious: 0,
    unmatchedCurrent: 0,
    ambiguities: [],
    deltas: [{ metric: "anchor_count", value: 0, policy: policy.count, withinPolicy: true }],
  };
}

function makeSceneQuery(artifacts, input, options = {}) {
  const anchors = options.anchors ?? [rawTableAnchor()];
  const requestId = options.requestId ?? "scene_query_0001";
  const raw = {
    kind: "pico.agent-bridge.scene-snapshot",
    schemaVersion: 1,
    bridgeRevision: 41,
    requestId,
    application: {
      packageName: TARGET_PACKAGE,
      buildIdentity: { kind: "apk-sha256", sha256: TARGET_APK_SHA },
      observedStageStyle: "Mixed",
      rootContainer: "stage",
      stageOpen: true,
    },
    coordinateFrame: { id: "bridge-world-41", units: "metres", handedness: "sdk-reported" },
    readiness: { maxRetries: 2, pollMs: 10, stabilityReads: 2, retries: 1, satisfied: true },
    reads: [0, 1].map((readIndex) => ({
      readIndex,
      queriedAtMonotonicNs: String(100 + readIndex),
      trackingState: "RUNNING",
      source: "loadAllAnchors",
      loadError: null,
      anchorCount: anchors.length,
      anchors: structuredClone(anchors),
    })),
    error: null,
  };
  const bytes = Buffer.from(JSON.stringify(raw), "utf8");
  const artifactPath = options.path ?? `/tmp/pico-navigationtarget-tests/geometry-${requestId}.json`;
  artifacts.set(artifactPath, bytes);
  const status = options.status ?? (anchors.some((anchor) => anchor.semanticAssignments.includes("TABLE")) ? "ready" : "label_absent");
  const outputAnchors = status === "ready" ? anchors
    .filter((anchor) => anchor.semanticAssignments.includes("TABLE"))
    .map((anchor, index) => ({
      traceId: `anchor-${String(index + 1).padStart(4, "0")}`,
      runtimeUuid: anchor.runtimeUuid,
      runtimeUuidRole: "diagnostic_only",
      labels: [...new Set(anchor.semanticAssignments)].sort(),
      worldFromAnchor: structuredClone(anchor.worldFromAnchor),
      boundsM: structuredClone(anchor.boundsM),
      geometrySlice: { vertexStart: index * 4, vertexCount: 4, indexStart: index * 6, indexCount: 6 },
      semanticAssignments: { domain: "unknown", rawCount: anchor.semanticAssignments.length, alignment: "unverified", relationEligible: false },
    })) : [];
  return {
    status,
    snapshotId: options.snapshotId ?? "a".repeat(64),
    applicationRuntimeBinding: {
      serial: TARGET_SERIAL,
      liveIdentity: {
        serial: TARGET_SERIAL,
        model: "PICO 4 Ultra Emulator",
        fingerprint: "pico/PICO/PICO:6/test:userdebug/test-keys",
        bootQemu: "1",
        bootId: TARGET_BOOT,
        observedAt: "2026-09-01T12:00:20.000Z",
      },
      captureSource: "agent-bridge-file-pull",
      startedAtMonotonicNs: "10",
      endedAtMonotonicNs: "20",
      packageName: TARGET_PACKAGE,
      buildReceiptId: TARGET_BUILD_RECEIPT,
      buildReceiptPath: "/tmp/native-run-receipt.json",
      apkSha256: TARGET_APK_SHA,
      foregroundProcess: {
        packageName: TARGET_PACKAGE,
        component: `${TARGET_PACKAGE}/.platform.LaunchActivity`,
        pid: 4242,
        pidStartTicks: "98765",
      },
      requestedStageStyle: "Mixed",
      requestedRootContainer: "stage",
      effectiveSceneDriftPolicy: structuredClone(input.scenario.sceneDriftPolicy),
      observedStageStyle: "Mixed",
      rootContainer: "stage",
      stageOpen: true,
      bridgePayloadKind: "pico.agent-bridge.scene-snapshot",
      bridgeSchemaVersion: 1,
      bridgeRevision: 41,
      requestId,
    },
    queriedAtMonotonicNs: "101",
    trackingState: "RUNNING",
    retries: 0,
    totalAnchorCount: anchors.length,
    matchedAnchorCount: outputAnchors.length,
    geometryRef: {
      path: artifactPath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      schemaVersion: 1,
      coordinateFrameId: "bridge-world-41",
      units: "metres",
      handedness: "sdk-reported",
      bridgeRevision: 41,
    },
    anchors: outputAnchors,
    histogram: Object.fromEntries([...new Set(anchors.flatMap((anchor) => anchor.semanticAssignments))].map((label) => [label, anchors.filter((anchor) => anchor.semanticAssignments.includes(label)).length])),
    drift: noSceneDrift(input.scenario.sceneDriftPolicy),
    requestedLabels: ["TABLE"],
    semanticRelationPolicy: { labelLevelSelection: true, triangleRelations: "refused", reason: "semantic_assignment_alignment_unverified" },
    actionReceipts: [],
    error: status === "ready" ? null : { code: status, detail: "ready mesh contains no TABLE anchor" },
    evidenceCeiling: "structural",
  };
}

function expectedCalibrationContext() {
  return {
    serial: TARGET_SERIAL,
    guest: {
      fingerprint: "pico/PICO/PICO:6/test:userdebug/test-keys",
      model: "PICO 4 Ultra Emulator",
    },
    bootId: TARGET_BOOT,
    qemu: { pid: 93013, window: structuredClone(TARGET_WINDOW) },
    capture: { width: 1280, height: 720 },
    cameraCalibrationSha256: TARGET_CAMERA_SHA,
    bridgeRevision: 1,
    guide: {
      pattern: "nested-corners-v1",
      projectionModel: GUIDE_PROJECTION_MODEL,
      colors: structuredClone(GUIDE_COLORS),
      widthM: 0.74,
      heightM: 0.44,
    },
  };
}

function calibrationScheduleFixture() {
  const schedule = [];
  for (const [sampleIndex, pixels] of [40, -40, 80, -80].entries()) {
    schedule.push(
      { axis: "yaw", kind: "trial", sampleIndex, action: { kind: "look_drag", dxPx: pixels, dyPx: 0 } },
      { axis: "yaw", kind: "restore", sampleIndex, action: { kind: "look_drag", dxPx: -pixels, dyPx: 0 } },
    );
  }
  for (const [sampleIndex, pixels] of [40, -40, 80, -80].entries()) {
    schedule.push(
      { axis: "pitch", kind: "trial", sampleIndex, action: { kind: "look_drag", dxPx: 0, dyPx: pixels } },
      { axis: "pitch", kind: "restore", sampleIndex, action: { kind: "look_drag", dxPx: 0, dyPx: -pixels } },
    );
  }
  for (const [sampleIndex, holdMs] of [50, 100, 150, 200].entries()) {
    schedule.push(
      { axis: "forward", kind: "trial", sampleIndex, action: { kind: "key_hold", key: "w", holdMs } },
      { axis: "forward", kind: "restore", sampleIndex, action: { kind: "key_hold", key: "s", holdMs } },
    );
  }
  return schedule;
}

function calibrationProfileFixture() {
  return {
    version: 1,
    schedule: calibrationScheduleFixture(),
    limits: { minSamples: 4, maxRmse: 0.5, maxAbsResidual: 1, minRSquared: 0.95 },
    minimumSlopes: { angularDegPerPx: 0.01, forwardMPerMs: 0.0005 },
    projection: { model: GUIDE_PROJECTION_MODEL, maxRelativeError: 0.12 },
    closure: {
      perPairAngularDeg: 0.5,
      perPairForwardM: 0.05,
      finalYawDeg: 0.5,
      finalPitchDeg: 0.5,
      finalDepthM: 0.05,
    },
  };
}

function storedCalibrationFixture(overrides = {}) {
  const context = structuredClone(overrides.context ?? expectedCalibrationContext());
  const record = structuredClone(overrides.record ?? validTargetCalibrationRecord(context));
  const calibration = {
    context,
    record,
    profile: structuredClone(overrides.profile ?? calibrationProfileFixture()),
    quality: {
      status: "accepted",
      reasons: [],
      axes: {
        yaw: { status: "accepted", reasons: [] },
        pitch: { status: "accepted", reasons: [] },
        forward: { status: "accepted", reasons: [] },
      },
    },
    projectionQuality: {
      status: "accepted",
      reasons: [],
      samples: Array.from({ length: 25 }, () => ({
        status: "accepted",
        depthM: 5,
        widthDepthM: 5,
        heightDepthM: 5,
        depthRelativeError: 0,
        aspectRelativeError: 0,
        clipped: false,
      })),
    },
    restoreClosure: { yaw: [0, 0, 0, 0], pitch: [0, 0, 0, 0], forward: [0, 0, 0, 0] },
    finalClosure: { yawDeg: 0, pitchDeg: 0, depthM: 0 },
    guideDelta: { initialOffSha256: "1".repeat(64), initialOnSha256: "2".repeat(64), repeatedAfterAcquisition: false },
    cameraCalibrationProof: { sha256: TARGET_CAMERA_SHA, bytes: TARGET_CAMERA_BYTES.length },
    ...(overrides.calibration ?? {}),
  };
  const receipt = {
    kind: "pico.navigation-calibration-receipt",
    schemaVersion: 1,
    createdAt: "2026-09-01T12:00:30.000Z",
    calibration,
    actions: [],
    captures: {},
    sceneQueries: [],
    evidenceCeiling: "structural",
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt), "utf8");
  const receiptRef = {
    path: overrides.receiptPath ?? `/tmp/pico-navigationtarget-tests/calibration-${record.contextKey}.json`,
    sha256: crypto.createHash("sha256").update(receiptBytes).digest("hex"),
    bytes: receiptBytes.length,
    ...(overrides.receiptRef ?? {}),
  };
  return {
    envelope: { schemaVersion: 1, contextKey: record.contextKey, record, receiptRef },
    receipt,
    receiptBytes,
  };
}

function mutateStoredReceipt(stored, mutate) {
  const next = structuredClone(stored);
  mutate(next.receipt);
  next.receiptBytes = Buffer.from(JSON.stringify(next.receipt), "utf8");
  next.envelope.receiptRef.sha256 = crypto.createHash("sha256").update(next.receiptBytes).digest("hex");
  next.envelope.receiptRef.bytes = next.receiptBytes.length;
  return next;
}

function validTargetCalibrationRecord(context = expectedCalibrationContext()) {
  const yawSamples = [{ x: -80, y: -8 }, { x: -40, y: -4 }, { x: 40, y: 4 }, { x: 80, y: 8 }];
  const pitchSamples = [{ x: -80, y: -8 }, { x: -40, y: -4 }, { x: 40, y: 4 }, { x: 80, y: 8 }];
  const forwardSamples = [{ x: 50, y: 0.25 }, { x: 100, y: 0.5 }, { x: 150, y: 0.75 }, { x: 200, y: 1 }];
  return {
    version: 1,
    contextKey: calibrationContextKey(context),
    yaw: { samples: yawSamples, fit: fitThroughOrigin(yawSamples) },
    pitch: { samples: pitchSamples, fit: fitThroughOrigin(pitchSamples) },
    forward: { samples: forwardSamples, fit: fitThroughOrigin(forwardSamples) },
    limits: { minSamples: 4, maxRmse: 0.5, maxAbsResidual: 1, minRSquared: 0.95 },
  };
}

function absentGuideDetections() {
  return {
    available: true,
    expected: ["outer", "inner"],
    found: [],
    missing: ["outer", "inner"],
    neutralSkipped: [],
    detections: { outer: null, inner: null },
  };
}

function measuredGuideDetections(snapshot, options = {}) {
  const f = TARGET_CAMERA.f;
  const width = f * 0.74 / snapshot.depthM;
  const height = options.badProjection ? width : f * 0.44 / snapshot.depthM;
  const centerX = options.clippedProjection
    ? width / 2
    : TARGET_CAMERA.cx + f * Math.tan((snapshot.yawDeg * Math.PI) / 180);
  const centerY = TARGET_CAMERA.cy - f * Math.tan((snapshot.pitchDeg * Math.PI) / 180);
  const outer = [centerX - width / 2, centerY - height / 2, centerX + width / 2, centerY + height / 2];
  const inner = [centerX - width * 0.38, centerY - height * 0.38, centerX + width * 0.38, centerY + height * 0.38];
  return {
    available: true,
    expected: ["outer", "inner"],
    found: ["outer", "inner"],
    missing: [],
    neutralSkipped: [],
    detections: {
      outer: { pixels: Math.max(1, Math.round(width * height * 0.08)), bbox: outer },
      inner: { pixels: Math.max(1, Math.round(width * height * 0.06)), bbox: inner },
    },
  };
}

function settledCaptureReceipt(outPath, bytes, capturedAt = "2026-09-01T12:00:30.000Z") {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const captureRef = {
    path: outPath,
    sha256,
    bytes: bytes.length,
    width: 1280,
    height: 720,
    dimensions: { width: 1280, height: 720 },
    sourceSerial: TARGET_SERIAL,
    capturedAt,
  };
  return {
    status: "settled",
    serial: TARGET_SERIAL,
    path: outPath,
    sha256,
    attempts: 2,
    settlementSatisfied: true,
    comparison: "byte_exact",
    stablePair: [sha256, sha256],
    captureRuntimeBinding: {
      serial: TARGET_SERIAL,
      liveIdentity: {
        serial: TARGET_SERIAL,
        model: "PICO 4 Ultra Emulator",
        fingerprint: "pico/PICO/PICO:6/test:userdebug/test-keys",
        bootQemu: "1",
        bootId: TARGET_BOOT,
        observedAt: capturedAt,
      },
      captureSource: "adb-exec-out-screencap",
      startedAtMonotonicNs: "30",
      endedAtMonotonicNs: "40",
    },
    captureRef,
    lastValidCaptureRef: null,
    actionReceipts: [],
    error: null,
    evidenceCeiling: "structural",
    lookRequired: true,
  };
}

function targetFake(input, options = {}) {
  const events = [];
  const artifacts = new Map();
  const effectiveStoredCalibration = options.storedCalibration
    ?? (!Object.prototype.hasOwnProperty.call(options, "calibrationRecord") ? storedCalibrationFixture() : null);
  if (effectiveStoredCalibration && options.storedCalibrationBytes !== false) {
    artifacts.set(
      effectiveStoredCalibration.envelope.receiptRef.path,
      Buffer.from(effectiveStoredCalibration.receiptBytes),
    );
  }
  const sceneOptions = options.sceneOptions ?? [{}];
  const sceneQueries = sceneOptions.map((scene, index) => makeSceneQuery(artifacts, input, {
    requestId: `scene_query_${String(index + 1).padStart(4, "0")}`,
    snapshotId: String.fromCharCode(97 + Math.min(index, 5)).repeat(64),
    ...scene,
  }));
  let queryIndex = 0;
  let guideVisible = false;
  let guideMayHaveApplied = false;
  let acquired = options.initialGuideAbsent !== true;
  let showCalls = 0;
  let releaseRepeatedShow;
  let markRepeatedShowStarted;
  const repeatedShowStarted = new Promise((resolve) => { markRepeatedShowStarted = resolve; });
  let actionCount = 0;
  let hideCalls = 0;
  let captureCount = 0;
  let clockJumped = false;
  let calibrationReceiptReads = 0;
  let continuityCount = 0;
  let randomCount = 0;
  let nowNs = 1_000_000_000n;
  const pose = {
    yawDeg: options.initialYawDeg ?? 0,
    pitchDeg: options.initialPitchDeg ?? 0,
    depthM: options.initialDepthM ?? 5,
  };
  const stored = { receipt: null, registry: null };
  const qemuBinding = {
    discoveryFile: "/tmp/pico-emulator/pid_93013.ini",
    discoveredSerial: TARGET_SERIAL,
    qemuPid: 93013,
    address: "127.0.0.1:8554",
    tokenPresent: true,
    tokenFingerprint: "a".repeat(64),
    onlineEmulatorSerials: [TARGET_SERIAL],
    qemuWindowOwnerPid: 93013,
    qemuWindowId: TARGET_WINDOW.id,
    qemuWindowX: TARGET_WINDOW.x,
    qemuWindowY: TARGET_WINDOW.y,
    qemuWindowWidth: TARGET_WINDOW.width,
    qemuWindowHeight: TARGET_WINDOW.height,
    qemuWindowScale: TARGET_WINDOW.scale,
    bindingMethod: "discovery-pid-window",
  };
  const continuity = {
    observedAtMonotonicNs: "50",
    serial: TARGET_SERIAL,
    bootId: TARGET_BOOT,
    packageName: TARGET_PACKAGE,
    allowedResumedComponents: [`${TARGET_PACKAGE}/.platform.LaunchActivity`],
    apkSha256: TARGET_APK_SHA,
    pid: 4242,
    pidStartTicks: "98765",
    resumedComponents: [`${TARGET_PACKAGE}/.platform.LaunchActivity`],
    foreground: "exact_allowed",
    probeEventsSincePrior: [],
    probeParse: "absent",
    probeSequence: "unknown",
    watchdog: { status: "absent" },
  };
  const applyAction = async (action) => {
    actionCount++;
    events.push(`action:${action.kind === "look_drag" ? `drag:${action.dxPx},${action.dyPx}` : `hold:${action.key}:${action.holdMs}`}`);
    if (options.actionFailureAt === actionCount) {
      return {
        action: action.kind,
        serial: TARGET_SERIAL,
        status: "failed",
        startedAtMonotonicNs: "60",
        endedAtMonotonicNs: "61",
        ack: action.kind === "look_drag" ? {
          requested: { dragDx: action.dxPx, dragDy: action.dyPx },
          hostWindow: qemuBinding,
          cgEventAcknowledged: false,
          focusAcknowledged: true,
        } : {
          key: action.key,
          holdMs: action.holdMs,
          releaseCertain: true,
          grpc: {
            discoveryFile: qemuBinding.discoveryFile,
            discoveredSerial: TARGET_SERIAL,
            qemuPid: qemuBinding.qemuPid,
            address: qemuBinding.address,
            tokenFingerprint: qemuBinding.tokenFingerprint,
          },
          hostWindow: qemuBinding,
        },
        error: "fixture input failure",
      };
    }
    if (action.kind === "look_drag") {
      pose.yawDeg += action.dxPx * (options.yawSlope ?? 0.1);
      pose.pitchDeg += action.dyPx * (options.pitchSlope ?? 0.1);
      if (options.initialGuideAbsent && actionCount >= (options.acquireAfterActions ?? 1)) acquired = true;
    } else if (action.key === "w") pose.depthM -= action.holdMs * (options.forwardSlope ?? 0.005);
    else if (action.key === "s") pose.depthM += action.holdMs * (options.forwardSlope ?? 0.005);
    if (options.restoreDriftAtAction === actionCount) pose.yawDeg += 1;
    if (options.cumulativeYawRestoreDrift && [2, 4, 6, 8].includes(actionCount)) {
      pose.yawDeg += options.cumulativeYawRestoreDrift;
    }
    return {
      action: action.kind,
      serial: TARGET_SERIAL,
      status: "applied",
      startedAtMonotonicNs: "60",
      endedAtMonotonicNs: "61",
      ack: action.kind === "look_drag" ? {
        requested: { dragDx: action.dxPx, dragDy: action.dyPx },
        hostWindow: qemuBinding,
        cgEventAcknowledged: true,
        focusAcknowledged: true,
      } : {
        key: action.key,
        holdMs: action.holdMs,
        releaseCertain: true,
        grpc: {
          discoveryFile: qemuBinding.discoveryFile,
          discoveredSerial: TARGET_SERIAL,
          qemuPid: qemuBinding.qemuPid,
          address: qemuBinding.address,
          tokenFingerprint: qemuBinding.tokenFingerprint,
        },
        hostWindow: qemuBinding,
      },
    };
  };
  const readFixtureArtifact = async (artifactPath) => {
    events.push(`read:${path.basename(artifactPath)}`);
    const bytes = artifacts.get(artifactPath);
    if (!bytes) throw new Error(`missing fixture artifact ${artifactPath}`);
    if (effectiveStoredCalibration?.envelope.receiptRef.path === artifactPath) {
      calibrationReceiptReads++;
      if (options.mutateReceiptAfterFirstRead && calibrationReceiptReads === 1) {
        artifacts.set(artifactPath, Buffer.from("receipt changed after initial validation", "utf8"));
      }
    }
    return Buffer.from(bytes);
  };
  const deps = {
    querySceneAnchors: async () => {
      events.push("query");
      const result = sceneQueries[Math.min(queryIndex, sceneQueries.length - 1)];
      queryIndex++;
      return structuredClone(result);
    },
    readArtifact: readFixtureArtifact,
    readCalibrationReceipt: (ref) => readFixtureArtifact(ref.path),
    bindQemuWindow: async () => {
      events.push("bind-qemu");
      return options.bindingResult ?? { ok: true, binding: structuredClone(qemuBinding) };
    },
    reserveArtifactSession: async (outDir, runId, ownerNonceHash) => {
      events.push("reserve");
      return { runId, absoluteRoot: outDir, ownerNonceHash };
    },
    captureSettled: async (captureInput) => {
      captureCount++;
      const base = path.basename(captureInput.outPath);
      events.push(`capture:${base}:${captureInput.priorSha256 ?? "none"}`);
      if (options.captureFailureAt === captureCount) {
        return {
          receipt: {
            ...settledCaptureReceipt(captureInput.outPath, Buffer.from("failed")),
            status: "timeout",
            settlementSatisfied: false,
            stablePair: null,
            lastValidCaptureRef: settledCaptureReceipt(captureInput.outPath, Buffer.from("failed")).captureRef,
            error: { code: "settle_timeout", detail: "fixture never settled" },
          },
          frame: Buffer.from("failed"),
        };
      }
      const snapshot = options.staticInitialGuideFrames && captureCount <= 2
        ? { guideVisible: false, acquired: false, yawDeg: 0, pitchDeg: 0, depthM: pose.depthM }
        : {
            captureCount,
            guideVisible,
            acquired,
            yawDeg: pose.yawDeg,
            pitchDeg: pose.pitchDeg,
            depthM: pose.depthM,
          };
      const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
      artifacts.set(captureInput.outPath, bytes);
      if (!clockJumped && options.clockJumpAfterAction === actionCount && actionCount > 0) {
        clockJumped = true;
        nowNs += BigInt(options.clockJumpMs ?? 4_640_000) * 1_000_000n;
      }
      return { receipt: settledCaptureReceipt(captureInput.outPath, bytes), frame: Buffer.from(bytes) };
    },
    requestGuide: async (request) => {
      events.push(`guide:${request.mode}`);
      assert.equal(request.maxPolls, 3, "orchestration guide polls must remain bounded");
      assert.equal(request.pollMs, 100);
      assert.equal(request.stabilityReads, 2);
      if (request.mode === "show") {
        showCalls++;
        if (options.delayRepeatedShow && showCalls === 2) {
          markRepeatedShowStarted();
          await new Promise((resolve) => { releaseRepeatedShow = resolve; });
          events.push("guide:show:released");
        }
        guideMayHaveApplied = true;
        guideVisible = true;
        if (options.showFailure) {
          if (options.showFailureCompensated !== false) guideVisible = false;
          return {
            ok: false,
            code: options.showFailureCompensated === false ? "bridge_unavailable" : "invalid_ack",
            detail: "fixture show failed",
            terminalGuideState: "unknown",
            cleanupProven: false,
            actionReceipts: options.showFailureCompensated === false ? [] : [{
              action: "navigation_guide_invalidation_broadcast",
              status: "applied",
              startedAtMonotonicNs: "70",
              endedAtMonotonicNs: "71",
              ack: { mode: "hide" },
            }],
            evidenceCeiling: "structural",
          };
        }
      } else {
        hideCalls++;
        if (!options.hideFailure) guideVisible = false;
        if (options.hideFailure) return {
          ok: false,
          code: "cleanup_failed",
          detail: "fixture hide failed",
          terminalGuideState: "unknown",
          cleanupProven: false,
          actionReceipts: [],
          evidenceCeiling: "structural",
        };
      }
      return {
        ok: true,
        ack: guideAck(request),
        terminalGuideState: request.mode === "show" ? "visible" : "hidden",
        cleanupProven: request.mode === "hide",
        actionReceipts: [],
        evidenceCeiling: "structural",
      };
    },
    detectColorKeys: async (imagePath) => {
      events.push(`detect:${path.basename(imagePath)}`);
      const bytes = artifacts.get(imagePath);
      if (!bytes) throw new Error(`detector missing ${imagePath}`);
      const snapshot = JSON.parse(bytes.toString("utf8"));
      if (options.mutateDuringDetection && /guide-on/.test(path.basename(imagePath))) {
        artifacts.set(imagePath, Buffer.from("mutated-after-detector-open", "utf8"));
      }
      const lost = options.guideLossAfterAction != null && actionCount >= options.guideLossAfterAction;
      if (!snapshot.guideVisible || !snapshot.acquired || lost) return absentGuideDetections();
      return measuredGuideDetections(snapshot, {
        badProjection: options.badProjection,
        clippedProjection: options.clippedProjection,
      });
    },
    readCameraCalibrationProof: async () => {
      events.push("read-camera-calibration");
      return options.cameraProof ?? {
        ok: true,
        proof: {
          path: "/tmp/camera-calibration.json",
          bytes: TARGET_CAMERA_BYTES.length,
          sha256: TARGET_CAMERA_SHA,
          calibration: structuredClone(TARGET_CAMERA),
          observedBootId: TARGET_BOOT,
          bootStartedAt: "2026-09-01T12:00:00.000Z",
          verifiedAt: "2026-09-01T12:00:20.000Z",
        },
      };
    },
    readCalibrationRecord: async () => {
      events.push("read-calibration-registry");
      if (effectiveStoredCalibration) return structuredClone(effectiveStoredCalibration.envelope);
      if (Object.prototype.hasOwnProperty.call(options, "calibrationRecord")) return options.calibrationRecord;
      return null;
    },
    writeImmutableJson: async (artifactPath, payload) => {
      events.push(`write-receipt:${path.basename(artifactPath)}`);
      const bytes = Buffer.from(JSON.stringify(payload), "utf8");
      artifacts.set(artifactPath, bytes);
      stored.receipt = { path: artifactPath, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
      return stored.receipt;
    },
    writeCalibrationRecord: async (contextKey, record, receiptRef) => {
      events.push("write-calibration-registry");
      stored.registry = { contextKey, record: structuredClone(record), receiptRef: structuredClone(receiptRef), path: `/tmp/registry/${contextKey}.json` };
      return { path: stored.registry.path, contextKey };
    },
    createActionAdapter: () => ({ applyRelativeAction: applyAction }),
    sampleContinuity: async () => {
      events.push("continuity");
      continuityCount++;
      if (!clockJumped && options.clockJumpAfterContinuity === continuityCount) {
        clockJumped = true;
        nowNs += BigInt(options.clockJumpMs ?? 4_640_000) * 1_000_000n;
      }
      return structuredClone(continuity);
    },
    sleep: async (ms) => {
      events.push(`dwell:${ms}`);
      nowNs += BigInt(ms) * 1_000_000n;
    },
    monotonicNs: () => {
      nowNs += 1_000_000n;
      return nowNs;
    },
    now: () => "2026-09-01T12:00:30.000Z",
    randomId: () => `navigation_target_${String(++randomCount).padStart(4, "0")}`,
  };
  return {
    deps,
    events,
    artifacts,
    pose,
    stored,
    get actionCount() { return actionCount; },
    get hideCalls() { return hideCalls; },
    get guideMayHaveApplied() { return guideMayHaveApplied; },
    get queryCount() { return queryIndex; },
    get calibrationReceiptReads() { return calibrationReceiptReads; },
    repeatedShowStarted,
    releaseRepeatedShow() { releaseRepeatedShow?.(); },
    get guideVisible() { return guideVisible; },
  };
}

function assertNoForbiddenNavigationClaims(result) {
  const keys = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      visit(child);
    }
  };
  visit(result);
  for (const forbidden of ["arrived", "pose", "walked", "deviceNavigation", "device_navigation"]) {
    assert.equal(keys.includes(forbidden), false, `forbidden navigation claim field '${forbidden}' escaped`);
  }
}

test("navigate orchestration catches normalized largest-horizontal ambiguity before qemu, guide, capture, or input", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, {
    sceneOptions: [{
      anchors: [
        rawTableAnchor({ runtimeUuid: "table-large", boundsM: [1.2, 0.1, 0.8] }),
        rawTableAnchor({ runtimeUuid: "table-near-tie", boundsM: [1.14, 0.1, 0.8], x: 0.4 }),
      ],
    }],
  });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "ambiguous_target");
  assert.equal(result.target.selectorReceipt.candidates[0].horizontalAreaM2, 0.96);
  assert.ok(Math.abs(result.target.selectorReceipt.candidates[1].horizontalAreaM2 - 0.912) < 1e-15);
  assert.ok(Math.abs(result.target.selectorReceipt.areaSeparation - 0.05) < 1e-12);
  assert.deepEqual(fake.events, ["query", "read:geometry-scene_query_0001.json"]);
  assert.equal(fake.actionCount, 0);
  assert.equal(fake.hideCalls, 0);
  assert.equal(result.evidenceCeiling, "structural");
  assertNoForbiddenNavigationClaims(result);
});

test("largest-horizontal ambiguity uses the exact bounds product without decimal rounding", async () => {
  const input = targetInput("navigate", {
    target: {
      label: "TABLE",
      selector: {
        kind: "largest_horizontal",
        minUpDot: 0.85,
        ambiguity: { metric: "area_ratio", minSeparation: 5e-14 },
      },
    },
  });
  const fake = targetFake(input, {
    sceneOptions: [{
      anchors: [
        rawTableAnchor({ runtimeUuid: "table-exact-large", boundsM: [1, 0.1, 1] }),
        rawTableAnchor({ runtimeUuid: "table-exact-second", boundsM: [1 - 1e-13, 0.1, 1], x: 0.4 }),
      ],
    }],
    bindingResult: { ok: false, code: "binding_failed", detail: "fixture stops after exact selection" },
  });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.stopReason, "binding_failed");
  assert.equal(result.target.selectorReceipt.selectedRawIndex, 0);
  assert.ok(result.target.selectorReceipt.areaSeparation > input.target.selector.ambiguity.minSeparation);
  assert.deepEqual(fake.events.slice(-1), ["bind-qemu"]);
});

test("navigate orchestration catches a row-major non-horizontal target before qemu or guide work", async () => {
  const input = targetInput("navigate");
  const vertical = rawTableAnchor({
    worldFromAnchor: [1, 0, 0, 0, 0, 0, -1, 0.75, 0, 1, 0, -1.5, 0, 0, 0, 1],
    rotationQuaternionXyzw: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  });
  const fake = targetFake(input, { sceneOptions: [{ anchors: [vertical] }] });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "label_absent");
  assert.equal(result.target.selectorReceipt.candidates[0].upDot, 0);
  assert.deepEqual(fake.events, ["query", "read:geometry-scene_query_0001.json"]);
});

test("navigate orchestration catches geometryRef byte or SHA substitution before selector-dependent side effects", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input);
  const geometryPath = [...fake.artifacts.keys()].find((candidate) => /geometry-/.test(candidate));
  fake.artifacts.set(geometryPath, Buffer.from("substituted after query publication", "utf8"));
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "binding_failed");
  assert.match(result.error.detail, /geometry|sha|bytes/i);
  assert.deepEqual(fake.events, ["query", "read:geometry-scene_query_0001.json"]);
  assert.equal(fake.actionCount, 0);
});

test("navigate orchestration catches missing exact qemu geometry before reserving, guide work, capture, or input", async () => {
  const input = targetInput("navigate");
  const legacy = {
    discoveryFile: "/tmp/pico-emulator/pid_93013.ini",
    discoveredSerial: TARGET_SERIAL,
    qemuPid: 93013,
    address: "127.0.0.1:8554",
    tokenPresent: false,
    tokenFingerprint: null,
    onlineEmulatorSerials: [TARGET_SERIAL],
    qemuWindowOwnerPid: 93013,
    qemuWindowId: 7,
    bindingMethod: "discovery-pid-window",
  };
  const fake = targetFake(input, { bindingResult: { ok: true, binding: legacy } });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "binding_failed");
  assert.deepEqual(fake.events, ["query", "read:geometry-scene_query_0001.json", "bind-qemu"]);
  assert.equal(fake.actionCount, 0);
});

for (const [name, calibrationRecord, wantStatus] of [
  ["missing", null, "missing"],
  ["stale", { ...validTargetCalibrationRecord(), contextKey: "f".repeat(64) }, "stale"],
]) {
  test(`navigate orchestration catches ${name} exact-context calibration before W while retaining visible/centered claims and cleanup`, async () => {
    const input = targetInput("navigate");
    const fake = targetFake(input, { calibrationRecord });
    const result = await executeNavigateToSceneTarget(input, fake.deps);
    assert.equal(result.executionStatus, "stopped");
    assert.equal(result.stopReason, "unsupported_backend");
    assert.equal(result.calibrationStatus, wantStatus);
    assert.equal(result.refusalReason, wantStatus);
    assert.deepEqual(result.achievedClaims, ["target_visible", "target_centered"]);
    assert.equal(fake.events.some((event) => event.startsWith("action:hold:w")), false);
    assert.equal(fake.actionCount, 0);
    assert.equal(fake.hideCalls, 1);
    assert.equal(result.cleanup.guideHide.ok, true);
    assert.equal(result.captures.finalClean.status, "settled");
    assert.equal(result.sameViewEvidence, "no_backend_action_requested");
    assert.equal(result.evidenceCeiling, "structural");
    assert.ok(result.lookObligations.some((obligation) => /open/i.test(obligation)));
    assertNoForbiddenNavigationClaims(result);
  });
}

test("navigate consumes only a strict receipt-linked exact-context calibration and re-reads it immediately before W", async () => {
  const input = targetInput("navigate");
  const storedCalibration = storedCalibrationFixture();
  const fake = targetFake(input, { initialDepthM: 2.2, storedCalibration });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.stopReason, "objective_satisfied");
  assert.equal(result.calibrationStatus, "valid");
  assert.ok(fake.calibrationReceiptReads >= 2, "receipt bytes are validated on load and re-read before W");
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].request.kind, "key_hold");
  assert.equal(result.actions[0].request.key, "w");
  assert.ok(result.actions[0].request.holdMs > 0 && result.actions[0].request.holdMs < 100,
    "the accepted forward fit must replace the fixed 100ms hold");
  const audit = result.actions[0].controlAudit;
  assert.deepEqual(Object.keys(audit).sort(), ["applied", "gain", "policyLimits", "rawDesired", "wasClamped"]);
  assert.ok(audit.rawDesired.holdMs > 0);
  assert.ok(audit.applied.holdMs <= audit.rawDesired.holdMs);
});

test("navigate catches a receipt changed after initial validation immediately before W", async () => {
  const input = targetInput("navigate");
  const storedCalibration = storedCalibrationFixture();
  const fake = targetFake(input, {
    initialDepthM: 2.2,
    storedCalibration,
    mutateReceiptAfterFirstRead: true,
  });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "unsupported_backend");
  assert.equal(result.calibrationStatus, "stale");
  assert.equal(result.refusalReason, "stale");
  assert.equal(fake.calibrationReceiptReads, 2);
  assert.equal(fake.events.some((event) => event.startsWith("action:hold:w")), false);
});

test("navigate rejects missing, tampered, orphaned, weakened-profile, weakened-limit, and tiny-slope calibration receipts before W", async () => {
  const context = expectedCalibrationContext();
  const tinyYaw = validTargetCalibrationRecord(context);
  tinyYaw.yaw.samples = tinyYaw.yaw.samples.map(({ x }) => ({ x, y: x * 0.001 }));
  tinyYaw.yaw.fit = fitThroughOrigin(tinyYaw.yaw.samples);
  const weakLimits = validTargetCalibrationRecord(context);
  weakLimits.limits = { ...weakLimits.limits, minSamples: 1 };
  const orphaned = mutateStoredReceipt(storedCalibrationFixture(), (receipt) => {
    receipt.calibration.record.contextKey = "f".repeat(64);
  });
  const cases = [
    ["deleted receipt", storedCalibrationFixture(), { storedCalibrationBytes: false }, "stale"],
    ["tampered receipt ref", storedCalibrationFixture({ receiptRef: { sha256: "f".repeat(64) } }), {}, "stale"],
    ["orphaned receipt", orphaned, {}, "stale"],
    ["weakened profile", storedCalibrationFixture({
      profile: { ...calibrationProfileFixture(), limits: { ...calibrationProfileFixture().limits, minSamples: 1 } },
    }), {}, "quality_rejected"],
    ["weakened record limits", storedCalibrationFixture({ record: weakLimits }), {}, "quality_rejected"],
    ["tiny accepted yaw slope", storedCalibrationFixture({ record: tinyYaw }), {}, "quality_rejected"],
  ];
  for (const [name, storedCalibration, extra, wantStatus] of cases) {
    const inputCase = targetInput("navigate");
    const fake = targetFake(inputCase, { initialDepthM: 2.2, storedCalibration, ...extra });
    const result = await executeNavigateToSceneTarget(inputCase, fake.deps);
    assert.equal(result.executionStatus, "stopped", name);
    assert.equal(result.stopReason, "unsupported_backend", name);
    assert.equal(result.calibrationStatus, wantStatus, name);
    assert.equal(result.refusalReason, wantStatus, name);
    assert.equal(fake.events.some((event) => event.startsWith("action:hold:w")), false, name);
  }
});

test("navigate converts fresh angular guide error through accepted yaw and pitch fits", async () => {
  const input = targetInput("navigate");
  const storedCalibration = storedCalibrationFixture();
  const fake = targetFake(input, { initialDepthM: 2, initialYawDeg: 6, storedCalibration });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].request, { kind: "look_drag", dxPx: -60, dyPx: 0 });
  assert.ok(Math.abs(result.actions[0].controlAudit.rawDesired.dxPx + 60) < 1e-9);
  assert.equal(result.actions[0].controlAudit.gain, 1);
  assert.deepEqual(result.actions[0].controlAudit.applied, { dxPx: -60, dyPx: 0 });
  assert.equal(result.actions[0].controlAudit.wasClamped, false);
});

test("navigate orchestration never forwards an initial in-band free-camera claim without an acknowledged W plus growing projection trend", async () => {
  for (const [name, calibrationRecord] of [
    ["valid calibration", validTargetCalibrationRecord()],
    ["missing calibration", null],
  ]) {
    const input = targetInput("navigate");
    const fake = targetFake(input, { initialDepthM: 2, calibrationRecord });
    const result = await executeNavigateToSceneTarget(input, fake.deps);
    assert.equal(result.executionStatus, "completed", name);
    assert.equal(result.stopReason, "objective_satisfied", name);
    assert.deepEqual(result.achievedClaims, ["target_visible", "target_centered"], name);
    assert.equal(result.achievedClaims.includes("free_camera_approached"), false, name);
    assert.equal(fake.actionCount, 0, name);
    assert.equal(fake.events.some((event) => event.startsWith("action:hold:w")), false, name);
    assert.equal(fake.hideCalls, 1, name);
  }
});

test("byte-identical absent guide-off/on frames run a bounded horizontal acquisition series and then repeat the same-view delta", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, {
    initialDepthM: 2,
    initialGuideAbsent: true,
    staticInitialGuideFrames: true,
    acquireAfterActions: 3,
    yawSlope: 0,
  });
  const result = await executeNavigateToSceneTarget(input, fake.deps);

  assert.equal(result.executionStatus, "completed");
  assert.equal(result.stopReason, "objective_satisfied");
  assert.equal(result.captures.guideOff.sha256, result.captures.guideOn.sha256,
    "byte identity is detector evidence, not an automatic acquisition failure");
  assert.equal(result.captures.acquisition.length, 3);
  assert.equal(fake.actionCount, 3);
  assert.deepEqual(fake.events.filter((event) => event.startsWith("action:")), [
    "action:drag:120,0",
    "action:drag:120,0",
    "action:drag:120,0",
  ]);
  assert.deepEqual(fake.events.filter((event) => event === "guide:show" || event === "guide:hide"), [
    "guide:show", "guide:hide", "guide:show", "guide:hide",
  ]);
  const acquired = fake.events.findIndex((event) => event.startsWith("capture:waypoint-0003"));
  const rebaselineOff = fake.events.findIndex((event) => event.startsWith("capture:guide-off-rebaseline"));
  const repeatedShow = fake.events.indexOf("guide:show", fake.events.indexOf("guide:show") + 1);
  const rebaselineOn = fake.events.findIndex((event) => event.startsWith("capture:guide-on-rebaseline"));
  assert.ok(acquired < rebaselineOff && rebaselineOff < repeatedShow && repeatedShow < rebaselineOn);
});

test("a timed-out repeated SHOW is drained before result cleanup and cannot mutate guide or input afterward", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, {
    initialDepthM: 2,
    initialGuideAbsent: true,
    yawSlope: 0,
    delayRepeatedShow: true,
  });
  const originalSetTimeout = globalThis.setTimeout;
  let operationSettled = false;
  let result;
  try {
    globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
      callback,
      typeof delay === "number" && delay > 1_000 ? 1 : delay,
      ...args,
    );
    const operation = executeNavigateToSceneTarget(input, fake.deps);
    operation.then(() => { operationSettled = true; }, () => { operationSettled = true; });
    await fake.repeatedShowStarted;
    await new Promise((resolve) => originalSetTimeout(resolve, 20));
    const settledBeforeRelease = operationSettled;
    fake.releaseRepeatedShow();
    result = await operation;
    await new Promise((resolve) => originalSetTimeout(resolve, 20));
    assert.equal(settledBeforeRelease, false, "the operation must drain an in-flight SHOW before it returns");
  } finally {
    fake.releaseRepeatedShow();
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(fake.guideVisible, false, "cleanup must run after any SHOW that actually applied");
  const releaseIndex = fake.events.indexOf("guide:show:released");
  const finalHideIndex = fake.events.lastIndexOf("guide:hide");
  assert.ok(releaseIndex >= 0 && releaseIndex < finalHideIndex);
  assert.equal(fake.events.slice(finalHideIndex + 1).some((event) => event.startsWith("action:")), false);
  assert.equal(result.cleanup.guideHide.cleanupProven, true);
});

test("navigate orchestration catches reordered capture/input/cleanup and retains independent achieved claims", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, { initialDepthM: 2.2 });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.stopReason, "objective_satisfied");
  assert.deepEqual(result.achievedClaims, ["target_visible", "target_centered", "free_camera_approached"]);
  assert.equal(result.calibrationStatus, "valid");
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].request, { kind: "key_hold", key: "w", holdMs: 20 });
  assert.deepEqual(result.actions[0].controlAudit.applied, { key: "w", holdMs: 20 });
  assert.equal(result.actions[0].settle.status, "settled");
  assert.notEqual(result.captures.finalDiagnostic.sha256, result.actions[0].settle.sha256,
    "the final diagnostic must be a fresh post-action settled capture");
  assert.equal(result.captures.finalClean.status, "settled");
  assert.equal(result.sameViewEvidence, "no_backend_action_requested");
  assert.equal(result.evidenceCeiling, "structural");
  assert.ok(result.lookObligations.length >= 2);

  const first = (prefix) => fake.events.findIndex((event) => event.startsWith(prefix));
  assert.ok(first("query") < first("bind-qemu"));
  assert.ok(first("bind-qemu") < first("reserve"));
  assert.ok(first("capture:guide-off") < first("detect:guide-off"));
  assert.ok(first("detect:guide-off") < first("guide:show"));
  assert.ok(first("guide:show") < first("capture:guide-on"));
  assert.ok(first("capture:guide-on") < first("detect:guide-on"));
  assert.ok(first("read-calibration-registry") < first("action:hold:w:20"));
  assert.ok(first("action:hold:w:20") < first("capture:waypoint-0001"));
  assert.ok(first("capture:waypoint-0001") < first("capture:final-diagnostic"));
  assert.ok(first("capture:final-diagnostic") < fake.events.lastIndexOf("guide:hide"));
  assert.ok(fake.events.lastIndexOf("guide:hide") < first("capture:final-clean"));
  assert.equal(fake.events[first("capture:final-diagnostic")], "capture:final-diagnostic.png:none");
  assert.equal(fake.events[first("capture:final-clean")], `capture:final-clean.png:${result.captures.finalDiagnostic.sha256}`);
  const actionIndex = first("action:hold:w:20");
  assert.equal(fake.events.slice(actionIndex + 1).find((event) => event.startsWith("action:")), undefined,
    "the only state-changing action is settled before any later action");
  assert.equal(fake.hideCalls, 1);
  assertNoForbiddenNavigationClaims(result);
});

test("navigate orchestration catches detector bytes mutated during path-based analysis and still performs bounded cleanup", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, { mutateDuringDetection: true });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "guide_not_acquired");
  assert.match(result.error.detail, /changed|immutable|sha/i);
  assert.equal(fake.actionCount, 0);
  assert.equal(fake.hideCalls, 1);
  assert.equal(result.cleanup.attempted, true);
  assert.equal(result.captures.finalClean.status, "settled");
  assert.equal(result.evidenceCeiling, "structural");
});

test("navigate orchestration retains an unsettled guide-on receipt and still hides then settles clean", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, { captureFailureAt: 2 });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "unsettled");
  assert.equal(result.captures.guideOn, null);
  assert.equal(fake.actionCount, 0);
  assert.equal(fake.hideCalls, 1);
  assert.equal(result.cleanup.attempted, true);
  assert.equal(result.captures.finalClean.status, "settled");
  assert.equal(result.captures.finalDiagnostic.status, "settled",
    "cleanup may establish a new valid visible diagnostic after the failed initial settle");
  assert.ok(fake.events.includes(`capture:final-clean.png:${result.captures.finalDiagnostic.sha256}`));
});

test("navigate orchestration catches input failure without erasing pre-action claims or terminal receipt evidence", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, { initialDepthM: 2.2, actionFailureAt: 1 });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "input_failed");
  assert.deepEqual(result.achievedClaims, ["target_visible", "target_centered"]);
  assert.equal(result.routeTraces[0].status, "action_failed");
  assert.equal(result.routeTraces[0].terminalActionFailure.terminalReceipt.status, "failed");
  assert.match(result.routeTraces[0].terminalActionFailure.terminalError, /fixture input failure/);
  assert.equal(result.captures.finalDiagnostic, null,
    "a failed action cannot reuse its pre-action guide frame as a terminal diagnostic");
  assert.equal(fake.hideCalls, 1);
  assert.equal(result.captures.finalClean.status, "settled");
  assert.ok(fake.events.includes("capture:final-clean.png:none"));
});

test("navigate orchestration re-queries after a settled waypoint and catches cross-query scene drift", async () => {
  const input = targetInput("navigate");
  const moved = rawTableAnchor({
    x: 0.2,
    positionM: [0.2, 0.75, -1.5],
    worldFromAnchor: [1, 0, 0, 0.2, 0, 1, 0, 0.75, 0, 0, 1, -1.5, 0, 0, 0, 1],
  });
  const fake = targetFake(input, {
    initialDepthM: 2.2,
    sceneOptions: [{ anchors: [rawTableAnchor()] }, { anchors: [moved] }],
  });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(fake.queryCount, 2);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "scene_drift");
  assert.deepEqual(result.achievedClaims, ["target_visible", "target_centered"]);
  assert.equal(result.sceneQueries.length, 2);
  assert.equal(result.sceneQueries[1].crossQueryDrift.withinPolicy, false);
  assert.equal(fake.events.filter((event) => event.startsWith("read:geometry-")).length, 2,
    "every re-query geometryRef is independently read and SHA-verified");
  assert.equal(fake.hideCalls, 1);
});

test("navigate orchestration catches action and duration exhaustion without claiming a waypoint that was not admitted", async () => {
  for (const [name, motionPolicy] of [
    ["action", targetMotionPolicy({ maxActions: 1, maxDurationSec: 5000 })],
    ["duration", targetMotionPolicy({ maxActions: 32, maxDurationSec: 180 })],
  ]) {
    const input = targetInput("navigate", { motionPolicy });
    const fake = targetFake(input, { initialDepthM: 5 });
    const result = await executeNavigateToSceneTarget(input, fake.deps);
    assert.equal(result.executionStatus, "stopped", name);
    assert.equal(result.stopReason, "budget_exhausted", name);
    assert.ok(fake.actionCount <= 1, name);
    assert.equal(fake.hideCalls, 1, name);
    assert.equal(result.evidenceCeiling, "structural", name);
  }
});

test("navigate orchestration re-queries a guide lost after approach and never compounds W input", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, { initialDepthM: 2.2, guideLossAfterAction: 1 });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(fake.queryCount, 2);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "guide_not_acquired");
  assert.deepEqual(result.achievedClaims, ["target_visible", "target_centered"]);
  assert.equal(fake.events.filter((event) => event.startsWith("action:hold:w")).length, 1);
  assert.equal(result.captures.finalDiagnostic, null,
    "guide loss after the last action cannot pair a pre-action frame with final cleanup");
  assert.equal(fake.hideCalls, 1);
});

test("calibration refuses a 24-action or 180-second budget before the first motion and writes no valid registry", async () => {
  for (const [name, motionPolicy] of [
    ["no acquisition reserve", targetMotionPolicy({ maxActions: 24, maxDurationSec: 5000 })],
    ["duration", targetMotionPolicy({ maxActions: 32, maxDurationSec: 180 })],
  ]) {
    const input = targetInput("calibrate", { motionPolicy });
    const fake = targetFake(input);
    const result = await executeNavigateToSceneTarget(input, fake.deps);
    assert.equal(result.executionStatus, "stopped", name);
    assert.equal(result.stopReason, "budget_exhausted", name);
    assert.equal(result.calibrationStatus, "not_attempted", name);
    assert.equal(result.refusalReason, "insufficient_budget", name);
    assert.equal(fake.actionCount, 0, name);
    assert.equal(fake.stored.receipt, null, name);
    assert.equal(fake.stored.registry, null, name);
    assert.equal(fake.events.some((event) => event.startsWith("guide:")), false, name);
  }
});

test("calibration catches missing signed magnitudes, restore settlement, projection gates, or premature registry publication", async () => {
  const input = targetInput("calibrate");
  const fake = targetFake(input);
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.stopReason, "objective_satisfied");
  assert.equal(result.calibrationStatus, "written");
  assert.equal(result.routeTraces.length, 1, "the full calibration operation uses one shared route invocation");
  assert.equal(fake.actionCount, 24);
  assert.equal(result.actions.length, 24);
  assert.deepEqual(result.actions.map((action) => action.routeMeta?.pairRole),
    Array.from({ length: 12 }, () => ["outbound", "restore"]).flat());
  for (let index = 0; index < result.actions.length; index += 2) {
    assert.equal(result.actions[index].routeMeta.pairId, result.actions[index + 1].routeMeta.pairId);
    assert.deepEqual(Object.keys(result.actions[index].controlAudit).sort(),
      ["applied", "gain", "policyLimits", "rawDesired", "wasClamped"]);
    assert.deepEqual(Object.keys(result.actions[index + 1].controlAudit).sort(),
      ["applied", "gain", "policyLimits", "rawDesired", "wasClamped"]);
  }
  assert.deepEqual(result.calibration.record.yaw.samples.map((sample) => sample.x), [40, -40, 80, -80]);
  assert.deepEqual(result.calibration.record.pitch.samples.map((sample) => sample.x), [40, -40, 80, -80]);
  assert.deepEqual(result.calibration.record.forward.samples.map((sample) => sample.x), [50, 100, 150, 200]);
  assert.ok(Math.abs(result.calibration.record.yaw.fit.slope - 0.1) < 1e-10);
  assert.ok(Math.abs(result.calibration.record.pitch.fit.slope - 0.1) < 1e-10);
  assert.ok(Math.abs(result.calibration.record.forward.fit.slope - 0.005) < 1e-10);
  for (const axis of ["yaw", "pitch", "forward"]) {
    const fit = result.calibration.record[axis].fit;
    assert.equal(fit.sampleCount, 4);
    assert.equal(fit.residuals.length, 4);
    assert.ok(fit.rmse < 1e-10);
    assert.ok(fit.maxAbsResidual < 1e-10);
    assert.ok(fit.rSquared > 0.999999999);
  }
  assert.equal(result.calibration.quality.status, "accepted");
  assert.equal(result.calibration.projectionQuality.status, "accepted");
  assert.ok(result.calibration.restoreClosure.yaw.every((residual) => Math.abs(residual) < 1e-10));
  assert.ok(result.calibration.restoreClosure.pitch.every((residual) => Math.abs(residual) < 1e-10));
  assert.ok(result.calibration.restoreClosure.forward.every((residual) => Math.abs(residual) < 1e-10));
  assert.deepEqual(result.calibration.finalClosure, { yawDeg: 0, pitchDeg: 0, depthM: 0 });
  assert.deepEqual(result.calibration.profile, calibrationProfileFixture());
  assert.equal(validateNavigationCalibration(result.calibration.record, expectedCalibrationContext()).status, "valid");

  const actions = fake.events.filter((event) => event.startsWith("action:"));
  assert.deepEqual(actions, [
    "action:drag:40,0", "action:drag:-40,0", "action:drag:-40,0", "action:drag:40,0",
    "action:drag:80,0", "action:drag:-80,0", "action:drag:-80,0", "action:drag:80,0",
    "action:drag:0,40", "action:drag:0,-40", "action:drag:0,-40", "action:drag:0,40",
    "action:drag:0,80", "action:drag:0,-80", "action:drag:0,-80", "action:drag:0,80",
    "action:hold:w:50", "action:hold:s:50", "action:hold:w:100", "action:hold:s:100",
    "action:hold:w:150", "action:hold:s:150", "action:hold:w:200", "action:hold:s:200",
  ]);
  const actionIndexes = fake.events.map((event, index) => event.startsWith("action:") ? index : -1).filter((index) => index >= 0);
  for (const index of actionIndexes) {
    const actionEvent = fake.events[index];
    const nextStateChange = fake.events.slice(index + 1).find((event) => event.startsWith("action:") || event.startsWith("capture:waypoint"));
    assert.ok(nextStateChange?.startsWith("capture:waypoint"), `${actionEvent} must settle before the next action`);
  }
  const hideIndex = fake.events.lastIndexOf("guide:hide");
  const cleanIndex = fake.events.findIndex((event) => event.startsWith("capture:final-clean"));
  const receiptIndex = fake.events.findIndex((event) => event.startsWith("write-receipt:"));
  const registryIndex = fake.events.indexOf("write-calibration-registry");
  assert.ok(hideIndex < cleanIndex && cleanIndex < receiptIndex && receiptIndex < registryIndex);
  assert.equal(fake.hideCalls, 1);
  assert.equal(result.sameViewEvidence, "no_backend_action_requested");
  assert.equal(result.evidenceCeiling, "structural");
  assertNoForbiddenNavigationClaims(result);
});

test("calibration rejects inconsistent viewer-facing depth/aspect or restore closure without publishing a record", async () => {
  for (const [name, options] of [
    ["projection", { badProjection: true }],
    ["occlusion/clipping", { clippedProjection: true }],
    ["restore closure", { restoreDriftAtAction: 2 }],
    ["nontrivial yaw slope", { yawSlope: 0.001 }],
  ]) {
    const input = targetInput("calibrate");
    const fake = targetFake(input, options);
    const result = await executeNavigateToSceneTarget(input, fake.deps);
    assert.equal(result.executionStatus, "stopped", name);
    assert.equal(result.stopReason, "unsupported_backend", name);
    assert.equal(result.calibrationStatus, "quality_rejected", name);
    assert.equal(result.refusalReason, "quality_rejected", name);
    assert.equal(fake.stored.receipt, null, name);
    assert.equal(fake.stored.registry, null, name);
    assert.equal(fake.hideCalls, 1, name);
    assert.equal(result.captures.finalClean.status, "settled", name);
  }
});

test("calibration restores an applied outbound once through recovery after an active-deadline clock jump", async () => {
  const input = targetInput("calibrate");
  const fake = targetFake(input, { clockJumpAfterContinuity: 2, clockJumpMs: 4_625_000 });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "budget_exhausted");
  assert.equal(fake.actionCount, 2, "the exact inverse is the only action admitted after the clock jump");
  assert.deepEqual(fake.events.filter((event) => event.startsWith("action:")), [
    "action:drag:40,0",
    "action:drag:-40,0",
  ]);
  assert.deepEqual(result.routeTraces[0].waypoints.map((waypoint) => waypoint.meta), [
    { lane: "active", pairId: "yaw-0", pairRole: "outbound" },
    { lane: "recovery", pairId: "yaw-0", pairRole: "restore" },
  ]);
  assert.equal(fake.stored.receipt, null);
  assert.equal(fake.stored.registry, null);
  assert.equal(fake.hideCalls, 1);
});

test("calibration rejects individually acceptable restore residuals that accumulate against the original pose", async () => {
  const input = targetInput("calibrate");
  const fake = targetFake(input, { cumulativeYawRestoreDrift: 0.2 });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "unsupported_backend");
  assert.equal(result.calibrationStatus, "quality_rejected");
  assert.ok(result.calibration.restoreClosure.yaw.every((residual) => Math.abs(residual) <= 0.5));
  assert.ok(Math.abs(result.calibration.finalClosure.yawDeg) > 0.5);
  assert.ok(result.calibration.quality.reasons.includes("final_yaw_closure"));
  assert.equal(fake.stored.receipt, null);
  assert.equal(fake.stored.registry, null);
});

test("calibration reacquisition repeats a same-view guide off/on delta before all 24 trials", async () => {
  const input = targetInput("calibrate");
  const fake = targetFake(input, { initialGuideAbsent: true });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.calibrationStatus, "written");
  assert.equal(fake.actionCount, 25, "one bounded acquisition action precedes the 24 trials");
  assert.deepEqual(fake.events.filter((event) => event.startsWith("guide:")), [
    "guide:show", "guide:hide", "guide:show", "guide:hide",
  ]);
  const rebaselineOff = fake.events.findIndex((event) => event.startsWith("capture:guide-off-rebaseline"));
  const secondShow = fake.events.indexOf("guide:show", fake.events.indexOf("guide:show") + 1);
  const rebaselineOn = fake.events.findIndex((event) => event.startsWith("capture:guide-on-rebaseline"));
  const firstTrial = fake.events.findIndex((event) => event === "action:drag:40,0");
  assert.ok(rebaselineOff > 0 && rebaselineOff < secondShow && secondShow < rebaselineOn && rebaselineOn < firstTrial);
  assert.equal(result.calibration.guideDelta.repeatedAfterAcquisition, true);
});

test("an applied invalidation broadcast without a validated hidden ack still requires one explicit cleanup HIDE", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, { showFailure: true, showFailureCompensated: true });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "guide_not_acquired");
  assert.equal(fake.guideMayHaveApplied, true);
  assert.equal(fake.hideCalls, 1, "an applied broadcast alone is not proof that the guide is hidden");
  assert.equal(result.cleanup.hideTransactions, 1);
  assert.equal(result.cleanup.attempted, true);
  assert.equal(result.cleanup.guideHide.cleanupProven, true);
  assert.equal(result.sameViewEvidence, null);
  assert.equal(result.captures.finalClean.status, "settled");
  assert.equal(result.captures.finalDiagnostic, null);
  assert.ok(fake.events.includes("capture:final-clean.png:none"),
    "an unproven internal invalidation cannot promote guide-off into a visible prior");
});

test("orchestration sends one explicit HIDE after an uncompensated SHOW failure and retains final-clean evidence", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, { showFailure: true, showFailureCompensated: false });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "guide_not_acquired");
  assert.equal(fake.hideCalls, 1);
  assert.equal(result.cleanup.hideTransactions, 1);
  assert.equal(result.captures.finalClean.status, "settled");
});

test("cleanup failure remains terminal without erasing achieved claims, final diagnostic, or the clean-settle attempt", async () => {
  const input = targetInput("navigate");
  const fake = targetFake(input, { initialDepthM: 2.2, hideFailure: true });
  const result = await executeNavigateToSceneTarget(input, fake.deps);
  assert.equal(result.executionStatus, "stopped");
  assert.equal(result.stopReason, "cleanup_failed");
  assert.deepEqual(result.achievedClaims, ["target_visible", "target_centered", "free_camera_approached"]);
  assert.equal(result.captures.finalDiagnostic.status, "settled");
  assert.equal(result.cleanup.guideHide.ok, false);
  assert.ok(result.captures.finalClean, "clean settlement is attempted even after a failed hide acknowledgement");
  assert.equal(result.sameViewEvidence, null);
  assert.equal(fake.hideCalls, 1);
});

test("fresh camera-calibration proof catches stale boots and hashes exact bytes rather than a path assertion", async () => {
  const calls = [];
  const nowMs = Date.parse("2026-09-01T12:01:00.000Z");
  const deps = {
    readFile: () => Buffer.from(TARGET_CAMERA_BYTES),
    stat: () => ({ isFile: () => true, mtimeMs: Date.parse("2026-09-01T12:00:10.000Z") }),
    runText: async (cmd, args) => {
      calls.push({ cmd, args });
      return args.at(-1) === "/proc/uptime"
        ? { code: 0, stdout: "60.00 20.00\n", stderr: "", timedOut: false }
        : { code: 0, stdout: `${TARGET_BOOT}\n`, stderr: "", timedOut: false };
    },
    nowMs: () => nowMs,
  };
  const valid = await readFreshCameraCalibrationProof({
    adbPath: "/fixture/adb",
    serial: TARGET_SERIAL,
    expectedBootId: TARGET_BOOT,
    calibrationPath: "/fixture/camera-calibration.json",
  }, deps);
  assert.equal(valid.ok, true);
  assert.equal(valid.proof.sha256, TARGET_CAMERA_SHA);
  assert.equal(valid.proof.bytes, TARGET_CAMERA_BYTES.length);
  assert.equal(valid.proof.observedBootId, TARGET_BOOT);
  assert.equal(valid.proof.bootStartedAt, "2026-09-01T12:00:00.000Z");
  assert.deepEqual(calls.map(({ cmd, args }) => [cmd, args]), [
    ["/fixture/adb", ["-s", TARGET_SERIAL, "shell", "cat", "/proc/sys/kernel/random/boot_id"]],
    ["/fixture/adb", ["-s", TARGET_SERIAL, "shell", "cat", "/proc/uptime"]],
  ]);

  const stale = await readFreshCameraCalibrationProof({
    adbPath: "/fixture/adb",
    serial: TARGET_SERIAL,
    expectedBootId: "87654321-4321-4321-8321-cba987654321",
    calibrationPath: "/fixture/camera-calibration.json",
  }, { ...deps, runText: deps.runText });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale");
  assert.match(stale.detail, /boot/i);
});

test("navigation calibration receipt proof reads exact regular-file bytes and rejects symlinks or substitution", async () => {
  assert.equal(typeof navigationTargetModule.readNavigationCalibrationReceiptBytes, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-navigation-receipt-proof-"));
  try {
    const receiptPath = path.join(root, "receipt.json");
    const bytes = Buffer.from('{"kind":"fixture"}\n', "utf8");
    fs.writeFileSync(receiptPath, bytes);
    const ref = {
      path: receiptPath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    assert.deepEqual(await navigationTargetModule.readNavigationCalibrationReceiptBytes(ref), bytes);
    fs.writeFileSync(receiptPath, Buffer.from("substituted", "utf8"));
    await assert.rejects(navigationTargetModule.readNavigationCalibrationReceiptBytes(ref), /bytes|SHA|size/i);

    const targetPath = path.join(root, "target.json");
    fs.writeFileSync(targetPath, bytes);
    const symlinkPath = path.join(root, "symlink.json");
    fs.symlinkSync(targetPath, symlinkPath);
    await assert.rejects(navigationTargetModule.readNavigationCalibrationReceiptBytes({ ...ref, path: symlinkPath }), /regular|symlink/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registerNavigationTargetTools registers one strict discriminated full-surface contract", () => {
  const registrations = [];
  registerNavigationTargetTools({
    registerTool: (name, definition, handler) => registrations.push({ name, definition, handler }),
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "navigate_to_scene_target");
  assert.equal(typeof registrations[0].handler, "function");
  assert.equal(registrations[0].definition.inputSchema.parse(targetInput("navigate")).action, "navigate");
  assert.equal(registrations[0].definition.inputSchema.parse(targetInput("calibrate")).action, "calibrate");
  assert.throws(
    () => registrations[0].definition.inputSchema.parse({ ...targetInput("navigate"), unknownEscape: true }),
    /unrecognized|unknown/i,
  );
});
