import crypto from "node:crypto";

export type RegressionSample = { x: number; y: number };
export type ThroughOriginFit = { slope: number; sampleCount: number; residuals: number[]; rmse: number; maxAbsResidual: number; rSquared: number };
export type CalibrationLimits = { minSamples: number; maxRmse: number; maxAbsResidual: number; minRSquared: number };
export type CalibrationQuality = { status: "accepted" | "rejected"; reasons: ("sample_count" | "rmse" | "max_abs_residual" | "r_squared" | "invalid_fit" | "invalid_limits")[] };
export type NavigationCalibrationContext = {
  serial: string;
  guest: { fingerprint: string; model: string };
  bootId: string;
  qemu: { pid: number; window: { id: number | string; x: number; y: number; width: number; height: number; scale: number } };
  capture: { width: number; height: number };
  cameraCalibrationSha256: string;
  bridgeRevision: number;
  guide: {
    pattern: string;
    projectionModel: string;
    colors: [[number, number, number], [number, number, number]];
    widthM: number;
    heightM: number;
  };
};
export type NavigationCalibrationRecord = {
  version: number;
  contextKey: string;
  yaw: { samples: RegressionSample[]; fit: ThroughOriginFit };
  pitch: { samples: RegressionSample[]; fit: ThroughOriginFit };
  forward: { samples: RegressionSample[]; fit: ThroughOriginFit };
  limits: CalibrationLimits;
};
export type NavigationCalibrationValidation =
  | { status: "valid"; contextKey: string }
  | { status: "invalid"; reason: "context_mismatch" | "invalid_record" | "insufficient_signed_drag_trials" | "non_positive_forward_displacement" | "quality_rejected" | "fit_mismatch" };

function finiteSamples(samples: RegressionSample[]): boolean {
  return Array.isArray(samples) && samples.length > 0 && samples.every((sample) => Number.isFinite(sample?.x) && Number.isFinite(sample?.y));
}

/** Least-squares linear fit constrained through the origin; residuals are signed observed-minus-predicted values. */
export function fitThroughOrigin(samples: RegressionSample[]): ThroughOriginFit {
  if (!finiteSamples(samples)) throw new Error("fit samples must be finite");
  const denominator = samples.reduce((sum, sample) => sum + sample.x * sample.x, 0);
  if (!Number.isFinite(denominator) || denominator <= 0) throw new Error("fit requires non-zero x variance");
  const slope = samples.reduce((sum, sample) => sum + sample.x * sample.y, 0) / denominator;
  if (!Number.isFinite(slope)) throw new Error("fit slope must be finite");
  const residuals = samples.map((sample) => sample.y - slope * sample.x);
  const sse = residuals.reduce((sum, residual) => sum + residual * residual, 0);
  const meanY = samples.reduce((sum, sample) => sum + sample.y, 0) / samples.length;
  const total = samples.reduce((sum, sample) => sum + (sample.y - meanY) ** 2, 0);
  return { slope, sampleCount: samples.length, residuals, rmse: Math.sqrt(sse / samples.length), maxAbsResidual: Math.max(...residuals.map(Math.abs)), rSquared: total === 0 ? (sse === 0 ? 1 : 0) : 1 - sse / total };
}

function validLimits(limits: CalibrationLimits): boolean {
  return Number.isInteger(limits?.minSamples) && limits.minSamples > 0
    && Number.isFinite(limits.maxRmse) && limits.maxRmse >= 0
    && Number.isFinite(limits.maxAbsResidual) && limits.maxAbsResidual >= 0
    && Number.isFinite(limits.minRSquared) && limits.minRSquared >= -1 && limits.minRSquared <= 1;
}

export function calibrationQuality(fit: ThroughOriginFit, limits: CalibrationLimits): CalibrationQuality {
  if (!validLimits(limits)) return { status: "rejected", reasons: ["invalid_limits"] };
  if (!fit || !Number.isFinite(fit.slope) || !Number.isInteger(fit.sampleCount) || fit.sampleCount < 1
    || !Array.isArray(fit.residuals) || fit.residuals.length !== fit.sampleCount || !fit.residuals.every(Number.isFinite)
    || !Number.isFinite(fit.rmse) || !Number.isFinite(fit.maxAbsResidual) || !Number.isFinite(fit.rSquared)) return { status: "rejected", reasons: ["invalid_fit"] };
  const reasons: CalibrationQuality["reasons"] = [];
  if (fit.sampleCount < limits.minSamples) reasons.push("sample_count");
  if (fit.rmse > limits.maxRmse) reasons.push("rmse");
  if (fit.maxAbsResidual > limits.maxAbsResidual) reasons.push("max_abs_residual");
  if (fit.rSquared < limits.minRSquared) reasons.push("r_squared");
  return reasons.length ? { status: "rejected", reasons } : { status: "accepted", reasons };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  return value;
}

function calibrationIdentity(context: NavigationCalibrationContext): Record<string, unknown> {
  return {
    serial: context.serial,
    guest: { fingerprint: context.guest?.fingerprint, model: context.guest?.model },
    bootId: context.bootId,
    qemu: { pid: context.qemu?.pid, window: { id: context.qemu?.window?.id, x: context.qemu?.window?.x, y: context.qemu?.window?.y, width: context.qemu?.window?.width, height: context.qemu?.window?.height, scale: context.qemu?.window?.scale } },
    capture: { width: context.capture?.width, height: context.capture?.height },
    cameraCalibrationSha256: context.cameraCalibrationSha256,
    bridgeRevision: context.bridgeRevision,
    guide: {
      pattern: context.guide?.pattern,
      projectionModel: context.guide?.projectionModel,
      colors: context.guide?.colors,
      widthM: context.guide?.widthM,
      heightM: context.guide?.heightM,
    },
  };
}

/** Hashes only same-boot camera/action identity. Paths and timestamps deliberately cannot make a calibration valid. */
export function calibrationContextKey(context: NavigationCalibrationContext): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(calibrationIdentity(context)))).digest("hex");
}

function hasSignedTrials(samples: RegressionSample[], minimum: number): boolean {
  return finiteSamples(samples) && samples.length >= minimum && samples.some((sample) => sample.x < 0) && samples.some((sample) => sample.x > 0);
}

function positiveForwardSamples(samples: RegressionSample[], minimum: number): boolean {
  return finiteSamples(samples) && samples.length >= minimum && samples.every((sample) => sample.x > 0 && sample.y > 0);
}

function wellFormedFit(fit: unknown): fit is ThroughOriginFit {
  const candidate = fit as ThroughOriginFit | null;
  return !!candidate && typeof candidate === "object" && Number.isFinite(candidate.slope)
    && Number.isInteger(candidate.sampleCount) && Array.isArray(candidate.residuals)
    && Number.isFinite(candidate.rmse) && Number.isFinite(candidate.maxAbsResidual) && Number.isFinite(candidate.rSquared);
}

function wellFormedAxis(axis: unknown): axis is { samples: RegressionSample[]; fit: ThroughOriginFit } {
  const candidate = axis as { samples?: RegressionSample[]; fit?: ThroughOriginFit } | null;
  return !!candidate && typeof candidate === "object" && finiteSamples(candidate.samples ?? []) && wellFormedFit(candidate.fit);
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left), Math.abs(right));
}

function fitMatchesSamples(fit: ThroughOriginFit, samples: RegressionSample[]): boolean {
  try {
    const measured = fitThroughOrigin(samples);
    return nearlyEqual(fit.slope, measured.slope) && fit.sampleCount === measured.sampleCount
      && fit.residuals.length === measured.residuals.length && fit.residuals.every((residual, index) => nearlyEqual(residual, measured.residuals[index]))
      && nearlyEqual(fit.rmse, measured.rmse) && nearlyEqual(fit.maxAbsResidual, measured.maxAbsResidual) && nearlyEqual(fit.rSquared, measured.rSquared);
  } catch {
    return false;
  }
}

export function validateNavigationCalibration(record: NavigationCalibrationRecord, context: NavigationCalibrationContext): NavigationCalibrationValidation {
  if (!record || typeof record !== "object" || record.version !== 1 || typeof record.contextKey !== "string"
    || !wellFormedAxis(record.yaw) || !wellFormedAxis(record.pitch) || !wellFormedAxis(record.forward)) return { status: "invalid", reason: "invalid_record" };
  const contextKey = calibrationContextKey(context);
  if (record.contextKey !== contextKey) return { status: "invalid", reason: "context_mismatch" };
  if (!validLimits(record.limits)) return { status: "invalid", reason: "invalid_record" };
  if (!hasSignedTrials(record.yaw.samples, record.limits.minSamples) || !hasSignedTrials(record.pitch.samples, record.limits.minSamples)) return { status: "invalid", reason: "insufficient_signed_drag_trials" };
  if (!positiveForwardSamples(record.forward.samples, record.limits.minSamples) || record.forward.fit.slope <= 0) return { status: "invalid", reason: "non_positive_forward_displacement" };
  if ([record.yaw.fit, record.pitch.fit, record.forward.fit].some((fit) => calibrationQuality(fit, record.limits).status !== "accepted")) return { status: "invalid", reason: "quality_rejected" };
  if (!fitMatchesSamples(record.yaw.fit, record.yaw.samples) || !fitMatchesSamples(record.pitch.fit, record.pitch.samples) || !fitMatchesSamples(record.forward.fit, record.forward.samples)) return { status: "invalid", reason: "fit_mismatch" };
  return { status: "valid", contextKey };
}

export type NavigationStepState = {
  centerBandPx: { x: number; y: number };
  targetAreaFraction: { min: number; max: number };
  motionPolicy: { maxDragPxPerAction: number; maxCumulativeDragPx: number; maxHoldMsPerAction: number; maxCumulativeHoldMs: number; maxActions: number; maxDurationSec: number };
  actionCount: number;
  elapsedMs: number;
  cumulativeDragPx: number;
  cumulativeHoldMs: number;
  phase: "acquire" | "center" | "approach";
  areaHistory: number[];
  lastError?: { x: number; y: number };
  cleanup?: "required" | "failed";
};
export type NavigationObservation = {
  guide: { status: "measured"; error: { x: number; y: number }; areaFraction: number } | null;
  sceneDrift?: boolean;
};
export type NavigationApproachCalibration = { status: "valid" | "invalid" } | null | undefined;
export type NavigationIntent =
  | { kind: "drag"; mode: "search_horizontal" | "center"; dxPx: number; dyPx: number; gain: number; achievedClaims: ("target_visible" | "target_centered")[] }
  | { kind: "hold"; key: "w"; holdMs: number; achievedClaims: ("target_visible" | "target_centered")[] }
  | { kind: "calibration_required"; reason: "approach_requires_calibration"; achievedClaims: ("target_visible" | "target_centered")[] }
  | { kind: "requery"; reason: "guide_shrank_twice" | "guide_disappeared" | "target_area_exceeded"; achievedClaims: ("target_visible" | "target_centered")[] }
  | { kind: "cleanup"; status: "required"; achievedClaims: [] }
  | { kind: "stop"; reason: "objective_satisfied" | "budget_exhausted" | "scene_drift" | "cleanup_failed"; achievedClaims: ("target_visible" | "target_centered" | "free_camera_approached")[] };

function boundedDrag(dxPx: number, dyPx: number, state: NavigationStepState): { dxPx: number; dyPx: number } | null {
  const remaining = state.motionPolicy.maxCumulativeDragPx - state.cumulativeDragPx;
  const cap = Math.min(state.motionPolicy.maxDragPxPerAction, remaining);
  const magnitude = Math.hypot(dxPx, dyPx);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(magnitude) || magnitude <= 0) return null;
  const scale = Math.min(1, cap / magnitude);
  const bounded = { dxPx: Math.trunc(dxPx * scale), dyPx: Math.trunc(dyPx * scale) };
  return bounded.dxPx === 0 && bounded.dyPx === 0 ? null : bounded;
}

function approachClaims(): ("target_visible" | "target_centered")[] {
  return ["target_visible", "target_centered"];
}

function shrankTwice(history: number[]): boolean {
  if (history.length < 3) return false;
  const [first, second, third] = history.slice(-3);
  return Number.isFinite(first) && Number.isFinite(second) && Number.isFinite(third) && first > second && second > third;
}

/**
 * Produces exactly one bounded camera-control intent. The caller owns acknowledgements, capture,
 * settling, and any input backend; this pure transition function never performs those operations.
 */
export function decideNavigationStep(state: NavigationStepState, observation: NavigationObservation, calibration: NavigationApproachCalibration): NavigationIntent {
  if (state.cleanup === "failed") return { kind: "stop", reason: "cleanup_failed", achievedClaims: [] };
  if (state.cleanup === "required") return { kind: "cleanup", status: "required", achievedClaims: [] };
  if (observation.sceneDrift) return { kind: "stop", reason: "scene_drift", achievedClaims: [] };
  const policy = state.motionPolicy;
  if (state.actionCount >= policy.maxActions || state.elapsedMs >= policy.maxDurationSec * 1000
    || state.cumulativeDragPx >= policy.maxCumulativeDragPx || state.cumulativeHoldMs >= policy.maxCumulativeHoldMs) {
    return { kind: "stop", reason: "budget_exhausted", achievedClaims: [] };
  }
  if (!observation.guide || observation.guide.status !== "measured") {
    if (state.phase === "approach") return { kind: "requery", reason: "guide_disappeared", achievedClaims: approachClaims() };
    const drag = boundedDrag(policy.maxDragPxPerAction, 0, state);
    return drag ? { kind: "drag", mode: "search_horizontal", ...drag, gain: 1, achievedClaims: [] } : { kind: "stop", reason: "budget_exhausted", achievedClaims: [] };
  }

  const { error, areaFraction } = observation.guide;
  const inHorizontalBand = Math.abs(error.x) <= state.centerBandPx.x;
  const inVerticalBand = Math.abs(error.y) <= state.centerBandPx.y;
  if (!inHorizontalBand || !inVerticalBand) {
    const overshotX = state.lastError != null && state.lastError.x !== 0 && error.x !== 0 && Math.sign(state.lastError.x) !== Math.sign(error.x);
    const overshotY = state.lastError != null && state.lastError.y !== 0 && error.y !== 0 && Math.sign(state.lastError.y) !== Math.sign(error.y);
    const gain = overshotX || overshotY ? 0.5 : 1;
    const drag = boundedDrag(inHorizontalBand ? 0 : error.x * gain, inVerticalBand ? 0 : error.y * gain, state);
    if (!drag) return { kind: "stop", reason: "budget_exhausted", achievedClaims: [] };
    return {
      kind: "drag",
      mode: "center",
      ...drag,
      gain,
      achievedClaims: ["target_visible"],
    };
  }

  const claims = approachClaims();
  if (shrankTwice(state.areaHistory)) return { kind: "requery", reason: "guide_shrank_twice", achievedClaims: claims };
  if (areaFraction > state.targetAreaFraction.max) return { kind: "requery", reason: "target_area_exceeded", achievedClaims: claims };
  if (areaFraction >= state.targetAreaFraction.min) {
    return { kind: "stop", reason: "objective_satisfied", achievedClaims: ["target_visible", "target_centered", "free_camera_approached"] };
  }
  if (calibration?.status !== "valid") return { kind: "calibration_required", reason: "approach_requires_calibration", achievedClaims: claims };
  const remainingHoldMs = policy.maxCumulativeHoldMs - state.cumulativeHoldMs;
  if (!(remainingHoldMs > 0)) return { kind: "stop", reason: "budget_exhausted", achievedClaims: [] };
  const holdMs = Math.floor(Math.min(100, policy.maxHoldMsPerAction, remainingHoldMs));
  return holdMs > 0 ? { kind: "hold", key: "w", holdMs, achievedClaims: claims } : { kind: "stop", reason: "budget_exhausted", achievedClaims: [] };
}
