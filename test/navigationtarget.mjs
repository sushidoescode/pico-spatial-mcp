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
    { guest: { ...fixture.calibration.context.guest, fingerprint: "wrong-guest" } },
    { qemu: { ...fixture.calibration.context.qemu, window: { ...fixture.calibration.context.qemu.window, width: 1279 } } },
    { capture: { ...fixture.calibration.context.capture, height: 719 } },
    { cameraCalibrationSha256: "d".repeat(64) },
    { bridgeRevision: 2 },
    { guide: { ...fixture.calibration.context.guide, pattern: "other-pattern" } },
    { guide: { ...fixture.calibration.context.guide, widthM: 2.1 } },
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

test("decideNavigationStep catches a center-band target that fails to retain target_centered", () => {
  assert.deepEqual(decideNavigationStep(controllerState(), centeredSmall, invalidApproachCalibration), {
    kind: "calibration_required", reason: "approach_requires_calibration", achievedClaims: ["target_visible", "target_centered"],
  });
});

test("decideNavigationStep catches unclamped yaw and pitch centering", () => {
  assert.deepEqual(decideNavigationStep(controllerState(), { guide: { status: "measured", error: { x: 400, y: -200 }, areaFraction: 0.05 } }, validApproachCalibration), {
    kind: "drag", mode: "center", dxPx: 120, dyPx: -120, gain: 1, achievedClaims: ["target_visible"],
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
