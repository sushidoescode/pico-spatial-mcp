import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS,
  AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN,
  AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL,
  AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION,
  AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M,
  AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M,
  requestAgentBridgeNavigationGuide,
  type AgentBridgeNavigationGuideRequestInput,
  type AgentBridgeNavigationGuideRequestResult,
} from "./agentbridge.js";
import {
  bindMacQemuWindow,
  createBoundCameraActionAdapter,
  frontmostQemu,
  type BoundQemuWindow,
  type QemuWindowBindingResult,
} from "./cameradrive.js";
import { resolveAdb } from "./emulatorlook.js";
import { hostWindowPrecondition, probeHostWindow, unavailableHostWindowProbe, type HostWindowProbe } from "./hostwindow.js";
import { analyzeColorKeys, type AuthoredColor, type ColorKeyMeasurements } from "./eye.js";
import {
  readFreshCameraCalibrationProof,
  type FreshCameraCalibrationProofResult,
} from "./metricverify.js";
import {
  createRelativeRouteExecution,
  estimateRelativeRouteDurationMs,
  type BoundApplicationIdentity,
  type BoundRelativeRouteInput,
  type RelativeCameraAction,
  type RelativeRouteActionAttempt,
  type RelativeRouteExecution,
  type RelativeRouteStepOutcome,
  type RelativeRouteTrace,
  type ReservedArtifactSession,
  type RuntimeBindingReceipt,
} from "./navigation.js";
import {
  calibrationClosureQuality,
  calibrationContextKey,
  calibrationQuality,
  decideNavigationStep,
  fitThroughOrigin,
  validateNavigationCalibration,
  type NavigationCalibrationContext,
  type NavigationCalibrationRecord,
  type NavigationStepState,
  type RegressionSample,
} from "./navigationcalibration.js";
import { measureTwoColorGuide, type GuideMeasurement } from "./navigationguide.js";
import {
  executeLiveCaptureSettled,
  SETTLE_COMPARISON,
  sha256Bytes,
  assertExternalCapturePath,
  type CaptureSettledInput,
  type CaptureSettledReceipt,
} from "./observation.js";
import {
  sampleApplicationContinuity,
  type ApplicationContinuityBinding,
  type ApplicationContinuitySample,
} from "./runtimecontinuity.js";
import {
  computeSceneDrift,
  executeLiveQuerySceneAnchors,
  parseSceneBridgePayload,
  querySceneAnchorsOutputSchema,
  type ApplicationRuntimeBinding,
  type QuerySceneAnchorsInput,
  type RawSceneAnchor,
  type SceneBridgePayload,
  type SceneDriftReport,
  type SceneRead,
} from "./sceneanchors.js";
import { run } from "./util.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const sceneDriftPolicySchema = z.object({
  count: z.enum(["strict", "advisory"]),
  maxTransformDeltaM: finite.nonnegative(),
  maxTransformDeltaDeg: finite.nonnegative(),
  maxExtentDeltaM: finite.nonnegative(),
  topology: z.enum(["strict", "advisory"]),
}).strict();
const scenarioSchema = z.object({
  packageName: z.string().min(1),
  expectedBuildReceiptId: sha256Schema,
  expectedStageStyle: z.enum(["Mixed", "Full"]),
  expectedRootContainer: z.literal("stage"),
  sceneDriftPolicy: sceneDriftPolicySchema,
}).strict();
const targetSchema = z.object({
  label: z.string().min(1),
  selector: z.object({
    kind: z.literal("largest_horizontal"),
    minUpDot: finite.min(-1).max(1),
    ambiguity: z.object({
      metric: z.literal("area_ratio"),
      minSeparation: finite.min(0).max(1),
    }).strict(),
  }).strict(),
}).strict();
const fiducialSchema = z.object({
  colors: z.tuple([
    z.tuple([z.literal(255), z.literal(0), z.literal(255)]),
    z.tuple([z.literal(0), z.literal(255), z.literal(255)]),
  ]),
  pattern: z.literal(AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN),
  requireGuideOffOnDelta: z.literal(true),
}).strict();
const motionPolicySchema = z.object({
  maxDragPxPerAction: z.number().int().positive(),
  maxCumulativeDragPx: z.number().int().positive(),
  maxHoldMsPerAction: z.number().int().positive(),
  maxCumulativeHoldMs: z.number().int().positive(),
  maxActions: z.number().int().positive().max(256),
  maxDurationSec: z.number().int().positive().max(7_200),
}).strict();
const DEFAULT_SCENE_READINESS = Object.freeze({ maxRetries: 15, pollMs: 1000 });
const sceneReadinessSchema = z.object({
  maxRetries: z.number().int().min(0).max(120)
    .describe("Unfiltered scene-readiness retry budget (default 15; maximum 120)."),
  pollMs: z.number().int().min(10).max(60_000)
    .describe("Scene-readiness polling interval in milliseconds (default 1000; maximum 60000)."),
}).strict().default(DEFAULT_SCENE_READINESS);
const sharedInput = {
  serial: z.string().min(1),
  scenario: scenarioSchema,
  target: targetSchema,
  objective: z.literal("inspect"),
  fiducial: fiducialSchema,
  centerBandPx: z.object({ x: finite.nonnegative(), y: finite.nonnegative() }).strict(),
  targetAreaFraction: z.object({ min: finite.positive().max(1), max: finite.positive().max(1) }).strict()
    .refine((value) => value.min <= value.max, "target area min must not exceed max"),
  sceneReadiness: sceneReadinessSchema,
  motionPolicy: motionPolicySchema,
  outDir: z.string().refine(path.isAbsolute, "outDir must be absolute"),
};
const navigationTargetToolInputSchema = z.object({
  action: z.enum(["calibrate", "navigate"]),
  ...sharedInput,
}).strict();

export const navigateToSceneTargetInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("calibrate"), ...sharedInput }).strict(),
  z.object({ action: z.literal("navigate"), ...sharedInput }).strict(),
]);

export type NavigateToSceneTargetInput = z.input<typeof navigateToSceneTargetInputSchema>;
type ParsedNavigateToSceneTargetInput = z.output<typeof navigateToSceneTargetInputSchema>;
export type NavigationTargetStopReason =
  | "objective_satisfied"
  | "ambiguous_target"
  | "label_absent"
  | "guide_not_acquired"
  | "unsettled"
  | "scene_drift"
  | "scene_not_ready"
  | "budget_exhausted"
  | "ambiguous_host_window"
  | "host_window_occluded"
  | "host_window_unavailable"
  | "unsupported_backend"
  | "input_failed"
  | "binding_failed"
  | "cleanup_failed";
export type NavigationTargetClaim = "target_visible" | "target_centered" | "free_camera_approached";
export type NavigationCalibrationStatus = "not_attempted" | "missing" | "stale" | "quality_rejected" | "valid" | "written";
export type NavigationRefusalReason = "insufficient_budget" | "missing" | "stale" | "quality_rejected" | "projection_divergence" | null;
export type NavigationCalibrationReasonCode = "calibration_policy_version_mismatch";

export interface NavigationArtifactRef {
  path: string;
  sha256: string;
  bytes: number;
}

export interface NavigationCalibrationRegistryEnvelope {
  schemaVersion: 1;
  contextKey: string;
  record: NavigationCalibrationRecord;
  receiptRef: NavigationArtifactRef;
}

export interface NavigationTargetDependencies {
  querySceneAnchors(input: QuerySceneAnchorsInput): Promise<Record<string, unknown>>;
  readArtifact(path: string): Promise<Buffer>;
  readCalibrationReceipt(ref: NavigationArtifactRef): Promise<Buffer>;
  bindQemuWindow(serial: string): Promise<QemuWindowBindingResult>;
  focusQemuWindow?(binding: BoundQemuWindow): Promise<string | null>;
  probeHostWindow?(serial: string, binding?: BoundQemuWindow): Promise<HostWindowProbe>;
  reserveArtifactSession(outDir: string, runId: string, ownerNonceHash: string): Promise<ReservedArtifactSession>;
  captureSettled(input: CaptureSettledInput, context?: { hostWindowBinding?: BoundQemuWindow }): Promise<{ receipt: CaptureSettledReceipt; frame: Buffer | null }>;
  requestGuide(input: AgentBridgeNavigationGuideRequestInput): Promise<AgentBridgeNavigationGuideRequestResult>;
  detectColorKeys(path: string, authored: AuthoredColor[]): Promise<ColorKeyMeasurements>;
  readCameraCalibrationProof(serial: string, expectedBootId: string): Promise<FreshCameraCalibrationProofResult>;
  readCalibrationRecord(contextKey: string): Promise<NavigationCalibrationRegistryEnvelope | null>;
  writeImmutableJson(path: string, payload: unknown): Promise<NavigationArtifactRef>;
  writeCalibrationRecord(
    contextKey: string,
    record: NavigationCalibrationRecord,
    receiptRef: NavigationArtifactRef,
  ): Promise<{ path: string; contextKey: string }>;
  createActionAdapter(serial: string, binding: BoundQemuWindow): {
    applyRelativeAction(action: RelativeCameraAction): Promise<any>;
  };
  sampleContinuity(binding: ApplicationContinuityBinding): Promise<ApplicationContinuitySample>;
  sleep(ms: number): Promise<void>;
  monotonicNs(): bigint;
  now(): string;
  randomId(): string;
}

const ROUTE_CAPTURE = { maxTries: 2, intervalMs: 0, attemptTimeoutMs: 30_000 } as const;
const GUIDE_MAX_POLLS = 30;
const GUIDE_ACK_READ_TIMEOUT_MS = 1_000;
const GUIDE_CONTROL_TIMEOUT_MS = 10_000;
// HIDE: 10s broadcast + 30 * 1s reads + 29 * 100ms sleeps + 10s cleanup < 55s.
// Failed SHOW: two such transactions plus one final 10s late-ack cleanup < 120s.
const GUIDE_HIDE_TRANSACTION_RESERVE_MS = 55_000;
const GUIDE_SHOW_TRANSACTION_RESERVE_MS = 120_000;
const DIRECT_SETTLED_CAPTURE_RESERVE_MS = 90_000;
const INVERSE_RECOVERY_RESERVE_MS = 180_000;
const INITIAL_GUIDE_DELTA_RESERVE_MS = 2 * DIRECT_SETTLED_CAPTURE_RESERVE_MS
  + GUIDE_HIDE_TRANSACTION_RESERVE_MS + GUIDE_SHOW_TRANSACTION_RESERVE_MS;
const REACQUIRED_GUIDE_DELTA_RESERVE_MS = 2 * DIRECT_SETTLED_CAPTURE_RESERVE_MS
  + GUIDE_HIDE_TRANSACTION_RESERVE_MS + GUIDE_SHOW_TRANSACTION_RESERVE_MS;
const FINAL_GUIDE_CLEANUP_RESERVE_MS = 2 * DIRECT_SETTLED_CAPTURE_RESERVE_MS
  + GUIDE_HIDE_TRANSACTION_RESERVE_MS;
const NAVIGATION_NON_ROUTE_RESERVE_MS = INITIAL_GUIDE_DELTA_RESERVE_MS + FINAL_GUIDE_CLEANUP_RESERVE_MS;
const CALIBRATION_NON_ROUTE_RESERVE_MS = INITIAL_GUIDE_DELTA_RESERVE_MS
  + REACQUIRED_GUIDE_DELTA_RESERVE_MS + FINAL_GUIDE_CLEANUP_RESERVE_MS;
const CALIBRATION_LIMITS = {
  minSamples: 4,
  maxNormalizedRmse: 0.20,
  maxNormalizedAbsResidual: 0.25,
  minRSquared: 0.95,
} as const;
const CALIBRATION_CLOSURE_LIMITS = { maxPairFraction: 0.25, maxFinalFraction: 0.125 } as const;
const MIN_ANGULAR_SLOPE_DEG_PER_PX = 0.01;
const MIN_FORWARD_SLOPE_M_PER_MS = 0.0005;
const MAX_PROJECTION_RELATIVE_ERROR = 0.12;
const GUIDE_AUTHORED_COLORS: AuthoredColor[] = [
  { name: "outer", color: [...AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS[0]] },
  { name: "inner", color: [...AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS[1]] },
];

type CalibrationAxis = "yaw" | "pitch" | "forward";
interface CalibrationStep {
  axis: CalibrationAxis;
  kind: "trial" | "restore";
  sampleIndex: number;
  action: RelativeCameraAction;
}

function calibrationSchedule(): CalibrationStep[] {
  const steps: CalibrationStep[] = [];
  for (const [sampleIndex, pixels] of [40, -40, 80, -80].entries()) {
    steps.push(
      { axis: "yaw", kind: "trial", sampleIndex, action: { kind: "look_drag", dxPx: pixels, dyPx: 0 } },
      { axis: "yaw", kind: "restore", sampleIndex, action: { kind: "look_drag", dxPx: -pixels, dyPx: 0 } },
    );
  }
  for (const [sampleIndex, pixels] of [40, -40, 80, -80].entries()) {
    steps.push(
      { axis: "pitch", kind: "trial", sampleIndex, action: { kind: "look_drag", dxPx: 0, dyPx: pixels } },
      { axis: "pitch", kind: "restore", sampleIndex, action: { kind: "look_drag", dxPx: 0, dyPx: -pixels } },
    );
  }
  for (const [sampleIndex, holdMs] of [50, 100, 150, 200].entries()) {
    steps.push(
      { axis: "forward", kind: "trial", sampleIndex, action: { kind: "key_hold", key: "w", holdMs } },
      { axis: "forward", kind: "restore", sampleIndex, action: { kind: "key_hold", key: "s", holdMs } },
    );
  }
  return steps;
}

const CALIBRATION_SCHEDULE = calibrationSchedule();

export const NAVIGATION_CALIBRATION_PROFILE = Object.freeze({
  version: 2,
  schedule: Object.freeze(CALIBRATION_SCHEDULE.map((step) => Object.freeze({
    ...step,
    action: Object.freeze({ ...step.action }),
  }))),
  limits: Object.freeze({ ...CALIBRATION_LIMITS }),
  minimumSlopes: Object.freeze({
    angularDegPerPx: MIN_ANGULAR_SLOPE_DEG_PER_PX,
    forwardMPerMs: MIN_FORWARD_SLOPE_M_PER_MS,
  }),
  projection: Object.freeze({
    model: AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL,
    maxRelativeError: MAX_PROJECTION_RELATIVE_ERROR,
  }),
  closure: Object.freeze({
    normalization: "pair=restore-residual/abs(fitted-slope*trial); final=final-residual/min-abs-fitted-trial",
    ...CALIBRATION_CLOSURE_LIMITS,
  }),
});

interface SelectedScene {
  output: z.infer<typeof querySceneAnchorsOutputSchema>;
  payload: SceneBridgePayload;
  read: SceneRead;
  selectedAnchor: RawSceneAnchor;
  selectedRawIndex: number;
  snapshotId: string;
  traceId: string;
  runtimeUuid: string;
  selectorReceipt: Record<string, unknown>;
  crossQueryDrift: SceneDriftReport | null;
}

interface MeasuredGuideFrame {
  receipt: CaptureSettledReceipt;
  detections: ColorKeyMeasurements;
  guide: GuideMeasurement | null;
  immutableBytes: NavigationArtifactRef;
}

interface ProjectionMeasurement {
  status: "accepted" | "rejected";
  depthM: number;
  widthDepthM: number;
  heightDepthM: number;
  depthRelativeError: number;
  aspectRelativeError: number;
  clipped: boolean;
}

interface NavigationControlAudit {
  rawDesired: Record<string, number | string>;
  gain: number;
  applied: Record<string, number | string>;
  policyLimits: Record<string, number>;
  wasClamped: boolean;
}

class NavigationTargetStop extends Error {
  constructor(
    readonly reason: NavigationTargetStopReason,
    message: string,
  ) {
    super(message);
    this.name = "NavigationTargetStop";
  }
}

function exactApplicationBinding(
  left: ApplicationRuntimeBinding,
  right: ApplicationRuntimeBinding,
): boolean {
  return left.serial === right.serial
    && left.liveIdentity.model === right.liveIdentity.model
    && left.liveIdentity.fingerprint === right.liveIdentity.fingerprint
    && left.liveIdentity.bootQemu === right.liveIdentity.bootQemu
    && left.liveIdentity.bootId === right.liveIdentity.bootId
    && left.packageName === right.packageName
    && left.buildReceiptId === right.buildReceiptId
    && left.apkSha256 === right.apkSha256
    && left.foregroundProcess.packageName === right.foregroundProcess.packageName
    && left.foregroundProcess.component === right.foregroundProcess.component
    && left.foregroundProcess.pid === right.foregroundProcess.pid
    && left.foregroundProcess.pidStartTicks === right.foregroundProcess.pidStartTicks
    && left.observedStageStyle === right.observedStageStyle
    && left.rootContainer === right.rootContainer
    && left.stageOpen === right.stageOpen
    && left.bridgePayloadKind === right.bridgePayloadKind
    && left.bridgeSchemaVersion === right.bridgeSchemaVersion
    && left.bridgeRevision === right.bridgeRevision;
}

function sceneQueryInput(input: ParsedNavigateToSceneTargetInput): QuerySceneAnchorsInput {
  return {
    serial: input.serial,
    scenario: input.scenario,
    labels: [input.target.label],
    maxRetries: input.sceneReadiness.maxRetries,
    pollMs: input.sceneReadiness.pollMs,
    includeGeometry: "lossless_external_artifact",
    stabilityReads: 2,
  };
}

function selectorCandidates(read: SceneRead, label: string, minUpDot: number) {
  return read.anchors
    .map((anchor, rawIndex) => {
      const upX = anchor.worldFromAnchor[1];
      const upY = anchor.worldFromAnchor[5];
      const upZ = anchor.worldFromAnchor[9];
      const upDot = upY / Math.hypot(upX, upY, upZ);
      const horizontalAreaM2 = Math.abs(anchor.boundsM[0] * anchor.boundsM[2]);
      return {
        rawIndex,
        runtimeUuid: anchor.runtimeUuid,
        upDot,
        horizontalAreaM2,
        labelMatched: anchor.semanticAssignments.includes(label),
        eligible: anchor.semanticAssignments.includes(label) && upDot >= minUpDot,
      };
    })
    .filter((candidate) => candidate.labelMatched)
    .sort((left, right) => right.horizontalAreaM2 - left.horizontalAreaM2 || left.rawIndex - right.rawIndex);
}

async function queryAndSelectScene(
  input: ParsedNavigateToSceneTargetInput,
  deps: NavigationTargetDependencies,
  previous: SelectedScene | null,
): Promise<SelectedScene> {
  let rawOutput: Record<string, unknown>;
  try {
    rawOutput = await deps.querySceneAnchors(sceneQueryInput(input));
  } catch (error: any) {
    throw new NavigationTargetStop("binding_failed", `scene query failed: ${error?.message ?? String(error)}`);
  }
  const parsedOutput = querySceneAnchorsOutputSchema.safeParse(rawOutput);
  if (!parsedOutput.success) {
    throw new NavigationTargetStop("binding_failed", `scene query receipt is invalid: ${parsedOutput.error.message}`);
  }
  const output = parsedOutput.data;
  if (output.status === "label_absent") {
    throw new NavigationTargetStop("label_absent", output.error?.detail ?? `label '${input.target.label}' is absent`);
  }
  if (output.status !== "ready" || !output.snapshotId || !output.geometryRef || !output.applicationRuntimeBinding
    || !("bridgeRevision" in output.applicationRuntimeBinding)) {
    throw new NavigationTargetStop(
      output.status === "not_ready"
        ? "scene_not_ready"
        : output.status === "binding_failed" ? "binding_failed" : "unsupported_backend",
      output.error?.detail ?? `scene query stopped with ${output.status}`,
    );
  }
  let exact: Buffer;
  try {
    exact = await deps.readArtifact(output.geometryRef.path);
  } catch (error: any) {
    throw new NavigationTargetStop("binding_failed", `geometry artifact read failed: ${error?.message ?? String(error)}`);
  }
  if (!Buffer.isBuffer(exact)
    || exact.length !== output.geometryRef.bytes
    || sha256Bytes(exact) !== output.geometryRef.sha256) {
    throw new NavigationTargetStop("binding_failed", "geometry artifact bytes or SHA-256 changed after scene publication");
  }
  const parsedPayload = parseSceneBridgePayload(exact);
  if (!parsedPayload.ok) {
    throw new NavigationTargetStop("binding_failed", `geometry artifact is invalid: ${parsedPayload.detail}`);
  }
  const payload = parsedPayload.payload;
  const application = output.applicationRuntimeBinding as ApplicationRuntimeBinding;
  if (payload.requestId !== application.requestId
    || payload.application.packageName !== application.packageName
    || payload.application.buildIdentity?.sha256 !== application.apkSha256
    || payload.application.observedStageStyle !== application.observedStageStyle
    || payload.application.rootContainer !== application.rootContainer
    || payload.application.stageOpen !== application.stageOpen
    || payload.bridgeRevision !== output.geometryRef.bridgeRevision
    || payload.coordinateFrame.id !== output.geometryRef.coordinateFrameId
    || payload.coordinateFrame.units !== output.geometryRef.units
    || payload.coordinateFrame.handedness !== output.geometryRef.handedness) {
    throw new NavigationTargetStop("binding_failed", "geometry artifact does not match the scene runtime/frame binding");
  }
  const read = payload.reads.at(-1);
  if (!read || !payload.readiness.satisfied) {
    throw new NavigationTargetStop("binding_failed", "geometry artifact has no accepted fresh readiness read");
  }
  const candidates = selectorCandidates(read, input.target.label, input.target.selector.minUpDot);
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const top = eligible[0];
  const second = eligible[1];
  const areaSeparation = top && second && top.horizontalAreaM2 > 0
    ? (top.horizontalAreaM2 - second.horizontalAreaM2) / top.horizontalAreaM2
    : top ? 1 : 0;
  const selectorReceipt = {
    kind: input.target.selector.kind,
    matrixConvention: "row-major",
    upAxisIndices: [1, 5, 9],
    areaMetric: "abs(boundsM[0]*boundsM[2])",
    ambiguityMetric: "normalized_area_separation",
    minUpDot: input.target.selector.minUpDot,
    minimumAreaSeparation: input.target.selector.ambiguity.minSeparation,
    areaSeparation,
    candidates,
    selectedRawIndex: top?.rawIndex ?? null,
  };
  if (!top) {
    const stop = new NavigationTargetStop("label_absent", `no '${input.target.label}' candidate meets the horizontal up-axis gate`);
    (stop as any).selectorReceipt = selectorReceipt;
    (stop as any).output = output;
    throw stop;
  }
  if (!(top.horizontalAreaM2 > 0)) {
    const stop = new NavigationTargetStop("ambiguous_target", "largest horizontal target has no positive-area geometry");
    (stop as any).selectorReceipt = selectorReceipt;
    (stop as any).output = output;
    throw stop;
  }
  if (second && areaSeparation < input.target.selector.ambiguity.minSeparation) {
    const stop = new NavigationTargetStop("ambiguous_target", "largest horizontal target candidates are not sufficiently separated");
    (stop as any).selectorReceipt = selectorReceipt;
    (stop as any).output = output;
    throw stop;
  }
  const selectedAnchor = read.anchors[top.rawIndex];
  const publicMatches = output.anchors.filter((anchor) => anchor.runtimeUuid === selectedAnchor.runtimeUuid);
  if (publicMatches.length !== 1) {
    throw new NavigationTargetStop("binding_failed", "selected raw target has no unique trace-local public anchor binding");
  }
  let crossQueryDrift: SceneDriftReport | null = null;
  if (previous) {
    if (!exactApplicationBinding(previous.output.applicationRuntimeBinding as ApplicationRuntimeBinding, application)) {
      throw new NavigationTargetStop("binding_failed", "application runtime identity changed between scene queries");
    }
    crossQueryDrift = computeSceneDrift(previous.read, read, payload.coordinateFrame, input.scenario.sceneDriftPolicy);
    const selectedDelta = crossQueryDrift.deltas.find((delta) =>
      delta.metric === "anchor"
      && delta.previousIndex === previous.selectedRawIndex
      && delta.currentIndex === top.rawIndex);
    if (!selectedDelta || !selectedDelta.withinPolicy) {
      crossQueryDrift = { ...crossQueryDrift, withinPolicy: false };
    }
  }
  return {
    output,
    payload,
    read,
    selectedAnchor,
    selectedRawIndex: top.rawIndex,
    snapshotId: output.snapshotId,
    traceId: publicMatches[0].traceId,
    runtimeUuid: selectedAnchor.runtimeUuid,
    selectorReceipt,
    crossQueryDrift,
  };
}

function settledOrThrow(receipt: CaptureSettledReceipt, label: string): CaptureSettledReceipt {
  if (receipt.status !== "settled" || !receipt.settlementSatisfied || !receipt.sha256 || !receipt.captureRef) {
    throw new NavigationTargetStop("unsettled", `${label} did not produce a settled capture`);
  }
  return receipt;
}

async function immutableGuideMeasurement(
  receipt: CaptureSettledReceipt,
  input: ParsedNavigateToSceneTargetInput,
  deps: NavigationTargetDependencies,
): Promise<MeasuredGuideFrame> {
  const settled = settledOrThrow(receipt, "guide observation");
  const capture = settled.captureRef!;
  let before: Buffer;
  let after: Buffer;
  try {
    before = await deps.readArtifact(capture.path);
    if (before.length !== capture.bytes || sha256Bytes(before) !== capture.sha256) {
      throw new Error("saved capture bytes do not match the settled receipt");
    }
    const detections = await deps.detectColorKeys(capture.path, GUIDE_AUTHORED_COLORS);
    after = await deps.readArtifact(capture.path);
    if (!after.equals(before) || after.length !== capture.bytes || sha256Bytes(after) !== capture.sha256) {
      throw new Error("saved capture changed during detector analysis; immutable bytes were not preserved");
    }
    const measured = measureTwoColorGuide(
      { width: capture.width, height: capture.height },
      detections,
      { colors: input.fiducial.colors, pattern: input.fiducial.pattern },
    );
    return {
      receipt: settled,
      detections,
      guide: measured.status === "measured" ? measured : null,
      immutableBytes: { path: capture.path, sha256: capture.sha256, bytes: capture.bytes },
    };
  } catch (error: any) {
    throw new NavigationTargetStop("guide_not_acquired", `immutable guide detector failed: ${error?.message ?? String(error)}`);
  }
}

function guideIsAbsent(measured: MeasuredGuideFrame): boolean {
  const detections = measured.detections;
  return detections.available === true
    && detections.expected.length === 2
    && detections.found.length === 0
    && detections.missing.length === 2
    && Object.values(detections.detections ?? {}).every((detection) => detection === null);
}

function projectGuide(
  guide: GuideMeasurement,
  calibration: { f: number; cx: number; cy: number; width: number; height: number },
): ProjectionMeasurement {
  const widthDepthM = calibration.f * AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M / guide.width;
  const heightDepthM = calibration.f * AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M / guide.height;
  const depthM = (widthDepthM + heightDepthM) / 2;
  const depthRelativeError = Math.abs(widthDepthM - heightDepthM) / Math.max(widthDepthM, heightDepthM);
  const expectedAspect = AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M / AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M;
  const observedAspect = guide.width / guide.height;
  const aspectRelativeError = Math.abs(observedAspect - expectedAspect) / expectedAspect;
  const clipped = guide.bbox[0] <= 0 || guide.bbox[1] <= 0
    || guide.bbox[2] >= calibration.width || guide.bbox[3] >= calibration.height;
  return {
    status: Number.isFinite(depthM) && depthM > 0 && !clipped
      && depthRelativeError <= MAX_PROJECTION_RELATIVE_ERROR
      && aspectRelativeError <= MAX_PROJECTION_RELATIVE_ERROR ? "accepted" : "rejected",
    depthM,
    widthDepthM,
    heightDepthM,
    depthRelativeError,
    aspectRelativeError,
    clipped,
  };
}

function angularObservation(
  guide: GuideMeasurement,
  calibration: { f: number; cx: number; cy: number },
): { yawDeg: number; pitchDeg: number } {
  const error = principalPointError(guide, calibration);
  return {
    yawDeg: Math.atan(error.x / calibration.f) * 180 / Math.PI,
    pitchDeg: Math.atan(-error.y / calibration.f) * 180 / Math.PI,
  };
}

function principalPointError(
  guide: GuideMeasurement,
  calibration: { cx: number; cy: number },
): { x: number; y: number } {
  return { x: guide.center.x - calibration.cx, y: guide.center.y - calibration.cy };
}

function controllerGuide(
  guide: GuideMeasurement | null,
  calibration: { cx: number; cy: number },
): GuideMeasurement | null {
  return guide ? { ...guide, error: principalPointError(guide, calibration) } : null;
}

function guideRequestFor(
  input: ParsedNavigateToSceneTargetInput,
  scene: SelectedScene,
  requestId: string,
  mode: "show" | "hide",
): AgentBridgeNavigationGuideRequestInput {
  return {
    serial: input.serial,
    packageName: input.scenario.packageName,
    requestId,
    mode,
    sceneSnapshotId: scene.snapshotId,
    targetTraceId: scene.traceId,
    targetRuntimeUuid: scene.runtimeUuid,
    pattern: AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN,
    projectionModel: AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL,
    colors: AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS,
    widthM: AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M,
    heightM: AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M,
    maxPolls: GUIDE_MAX_POLLS,
    pollMs: 100,
    stabilityReads: 2,
    ackReadTimeoutMs: GUIDE_ACK_READ_TIMEOUT_MS,
    controlTimeoutMs: GUIDE_CONTROL_TIMEOUT_MS,
  };
}

function exactQemuGeometry(binding: BoundQemuWindow): NavigationCalibrationContext["qemu"] | null {
  const values = [
    binding.qemuWindowX,
    binding.qemuWindowY,
    binding.qemuWindowWidth,
    binding.qemuWindowHeight,
    binding.qemuWindowScale,
  ];
  if (!Number.isSafeInteger(binding.qemuPid) || binding.qemuPid! <= 0
    || !values.every((value) => typeof value === "number" && Number.isFinite(value))
    || binding.qemuWindowWidth! < 100 || binding.qemuWindowHeight! < 100 || binding.qemuWindowScale! <= 0) return null;
  return {
    pid: binding.qemuPid!,
    window: {
      id: binding.qemuWindowId,
      x: binding.qemuWindowX!,
      y: binding.qemuWindowY!,
      width: binding.qemuWindowWidth!,
      height: binding.qemuWindowHeight!,
      scale: binding.qemuWindowScale!,
    },
  };
}

function routeRuntimeBinding(scene: SelectedScene, qemu: BoundQemuWindow): RuntimeBindingReceipt {
  const application = scene.output.applicationRuntimeBinding as ApplicationRuntimeBinding;
  const geometry = exactQemuGeometry(qemu);
  if (!geometry) throw new NavigationTargetStop("binding_failed", "qemu binding lacks exact measured x/y/width/height/scale geometry");
  if (qemu.discoveredSerial !== application.serial || qemu.qemuPid !== geometry.pid
    || qemu.qemuWindowOwnerPid !== geometry.pid || !qemu.discoveryFile || !qemu.address) {
    throw new NavigationTargetStop("binding_failed", "qemu endpoint/window does not match the selected application runtime");
  }
  return {
    serial: application.serial,
    bootId: application.liveIdentity.bootId,
    grpc: {
      discoveryFile: qemu.discoveryFile,
      qemuPid: geometry.pid,
      address: qemu.address,
      ...(qemu.tokenFingerprint ? { tokenFingerprint: qemu.tokenFingerprint } : {}),
    },
    qemuWindow: {
      ownerPid: qemu.qemuWindowOwnerPid,
      windowId: qemu.qemuWindowId,
      x: geometry.window.x,
      y: geometry.window.y,
      width: geometry.window.width,
      height: geometry.window.height,
      scale: geometry.window.scale,
    },
  };
}

function continuityBinding(scene: SelectedScene): BoundApplicationIdentity {
  const application = scene.output.applicationRuntimeBinding as ApplicationRuntimeBinding;
  return {
    packageName: application.packageName,
    apkSha256: application.apkSha256,
    allowedResumedComponents: [application.foregroundProcess.component],
    pid: application.foregroundProcess.pid,
    pidStartTicks: application.foregroundProcess.pidStartTicks,
  };
}

function calibrationContext(
  scene: SelectedScene,
  qemu: BoundQemuWindow,
  capture: CaptureSettledReceipt,
  proof: Extract<FreshCameraCalibrationProofResult, { ok: true }>["proof"],
): NavigationCalibrationContext {
  const application = scene.output.applicationRuntimeBinding as ApplicationRuntimeBinding;
  const qemuContext = exactQemuGeometry(qemu);
  if (!qemuContext || !capture.captureRef) throw new NavigationTargetStop("binding_failed", "calibration context lacks exact qemu/capture geometry");
  if (proof.observedBootId !== application.liveIdentity.bootId
    || proof.calibration.width !== capture.captureRef.width
    || proof.calibration.height !== capture.captureRef.height) {
    throw new NavigationTargetStop("unsupported_backend", "camera calibration proof does not match this boot and capture geometry");
  }
  return {
    serial: application.serial,
    guest: {
      fingerprint: application.liveIdentity.fingerprint,
      model: application.liveIdentity.model,
    },
    bootId: application.liveIdentity.bootId,
    qemu: qemuContext,
    capture: { width: capture.captureRef.width, height: capture.captureRef.height },
    cameraCalibrationSha256: proof.sha256,
    bridgeRevision: AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION,
    guide: {
      pattern: AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN,
      projectionModel: AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL,
      colors: [
        [...AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS[0]],
        [...AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS[1]],
      ],
      widthM: AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M,
      heightM: AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M,
    },
  };
}

function claimOrder(claims: Set<NavigationTargetClaim>): NavigationTargetClaim[] {
  return (["target_visible", "target_centered", "free_camera_approached"] as NavigationTargetClaim[])
    .filter((claim) => claims.has(claim));
}

function routeStopReason(trace: RelativeRouteTrace): NavigationTargetStopReason {
  switch (trace.status) {
    case "action_failed":
    case "input_release_uncertain": return "input_failed";
    case "route_unsettled": return "unsettled";
    case "binding_lost": return "binding_failed";
    case "budget_exhausted": return "budget_exhausted";
    default: return "budget_exhausted";
  }
}

function newResult(input: ParsedNavigateToSceneTargetInput) {
  return {
    executionStatus: "stopped" as "completed" | "stopped" | "error",
    action: input.action,
    achievedClaims: [] as NavigationTargetClaim[],
    stopReason: null as NavigationTargetStopReason | null,
    calibrationStatus: "not_attempted" as NavigationCalibrationStatus,
    calibrationReasonCode: null as NavigationCalibrationReasonCode | null,
    refusalReason: null as NavigationRefusalReason,
    applicationRuntimeBinding: null as ApplicationRuntimeBinding | null,
    target: {
      snapshotId: null as string | null,
      traceId: null as string | null,
      runtimeUuid: null as string | null,
      selectorReceipt: { candidates: [] } as Record<string, any>,
    },
    qemuBinding: null as BoundQemuWindow | null,
    hostWindowFocusRequest: null as {
      status: "requested" | "failed" | "not_applicable";
      error: string | null;
      qemuWindowId: number | null;
      qemuWindowOwnerPid: number | null;
      durationMs: number;
    } | null,
    hostWindowProbe: unavailableHostWindowProbe("host window has not been sampled"),
    hostWindowProbes: [] as Array<{ phase: string; probe: HostWindowProbe }>,
    sceneQueries: [] as Record<string, any>[],
    guideTransitions: {
      preflightHide: null as AgentBridgeNavigationGuideRequestResult | null,
      show: null as AgentBridgeNavigationGuideRequestResult | null,
      hide: null as AgentBridgeNavigationGuideRequestResult | null,
      transactions: [] as AgentBridgeNavigationGuideRequestResult[],
    },
    routeTraces: [] as RelativeRouteTrace[],
    actions: [] as Array<{
      seq: number;
      actionIndex: number;
      request: RelativeCameraAction;
      ack: unknown | null;
      settle: CaptureSettledReceipt | null;
      attempt: RelativeRouteActionAttempt;
      routeMeta?: { lane: "active" | "recovery"; pairId?: string; pairRole?: "outbound" | "restore" };
      controlAudit?: NavigationControlAudit;
    }>,
    captures: {
      guideOff: null as CaptureSettledReceipt | null,
      guideOn: null as CaptureSettledReceipt | null,
      acquisition: [] as CaptureSettledReceipt[],
      guideOffRebaseline: null as CaptureSettledReceipt | null,
      guideOnRebaseline: null as CaptureSettledReceipt | null,
      finalDiagnostic: null as CaptureSettledReceipt | null,
      finalClean: null as CaptureSettledReceipt | null,
    },
    cleanup: {
      attempted: false,
      hideTransactions: 0,
      guideHide: null as AgentBridgeNavigationGuideRequestResult | null,
      finalCleanAttempted: false,
    },
    sameViewEvidence: null as "no_backend_action_requested" | null,
    calibration: null as Record<string, any> | null,
    evidenceCeiling: "structural" as const,
    lookObligations: [
      "Open the final available guide-visible diagnostic frame and judge its pixels before making a visual claim.",
      "Open the final clean frame and confirm the guide is absent before recording vision_verified evidence.",
    ],
    error: null as { code: string; detail: string } | null,
    primaryError: null as { code: "unexpected_exception"; detail: string } | null,
  };
}

function captureMatchesScene(receipt: CaptureSettledReceipt, scene: SelectedScene): boolean {
  const application = scene.output.applicationRuntimeBinding as ApplicationRuntimeBinding;
  return receipt.serial === application.serial
    && receipt.captureRuntimeBinding?.serial === application.serial
    && receipt.captureRuntimeBinding.liveIdentity.serial === application.serial
    && receipt.captureRuntimeBinding.liveIdentity.bootId === application.liveIdentity.bootId
    && receipt.captureRuntimeBinding.liveIdentity.model === application.liveIdentity.model
    && receipt.captureRuntimeBinding.liveIdentity.fingerprint === application.liveIdentity.fingerprint
    && receipt.captureRef?.sourceSerial === application.serial;
}

function routeInput(
  input: ParsedNavigateToSceneTargetInput,
  scene: SelectedScene,
  qemu: BoundQemuWindow,
  session: ReservedArtifactSession,
  priorCaptureSha256: string,
  maxDurationMs: number,
): BoundRelativeRouteInput {
  return {
    runtimeBinding: routeRuntimeBinding(scene, qemu),
    continuity: { kind: "required", binding: continuityBinding(scene) },
    artifactSession: session,
    priorCaptureSha256,
    budgets: {
      maxActions: input.motionPolicy.maxActions,
      maxWaypoints: input.motionPolicy.maxActions,
      maxHoldMsPerAction: input.motionPolicy.maxHoldMsPerAction,
      maxDragPxPerAction: input.motionPolicy.maxDragPxPerAction,
      maxCumulativeHoldMs: input.motionPolicy.maxCumulativeHoldMs,
      maxCumulativeDragPx: input.motionPolicy.maxCumulativeDragPx,
      maxDurationMs,
      recoveryReserveMs: Math.min(INVERSE_RECOVERY_RESERVE_MS, maxDurationMs),
    },
    capture: { ...ROUTE_CAPTURE },
  };
}

function calibrationScheduleFitsPolicy(input: ParsedNavigateToSceneTargetInput): boolean {
  const actionCount = CALIBRATION_SCHEDULE.length + 1;
  const dragPx = CALIBRATION_SCHEDULE.reduce((sum, step) => sum + (
    step.action.kind === "look_drag" ? Math.hypot(step.action.dxPx, step.action.dyPx) : 0
  ), input.motionPolicy.maxDragPxPerAction);
  const holdMs = CALIBRATION_SCHEDULE.reduce((sum, step) => sum + (
    step.action.kind === "key_hold" ? step.action.holdMs : 0
  ), 0);
  return input.motionPolicy.maxActions >= actionCount
    && CALIBRATION_SCHEDULE.every((step) => step.action.kind === "look_drag"
      ? Math.hypot(step.action.dxPx, step.action.dyPx) <= input.motionPolicy.maxDragPxPerAction
      : step.action.holdMs <= input.motionPolicy.maxHoldMsPerAction)
    && dragPx <= input.motionPolicy.maxCumulativeDragPx
    && holdMs <= input.motionPolicy.maxCumulativeHoldMs;
}

function projectionQuality(projections: ProjectionMeasurement[]) {
  const reasons: string[] = [];
  if (projections.length < CALIBRATION_SCHEDULE.length + 1) reasons.push("insufficient_projection_samples");
  if (projections.some((projection) => projection.status !== "accepted")) reasons.push("projection_or_aspect_inconsistent");
  return { status: reasons.length ? "rejected" as const : "accepted" as const, reasons, samples: projections };
}

function aggregateCalibrationQuality(
  record: NavigationCalibrationRecord,
  projections: ProjectionMeasurement[],
  closure: Record<CalibrationAxis, number[]>,
  finalClosure?: { yawDeg: number; pitchDeg: number; depthM: number },
) {
  const axes = {
    yaw: calibrationQuality(record.yaw.samples, record.yaw.fit, record.limits),
    pitch: calibrationQuality(record.pitch.samples, record.pitch.fit, record.limits),
    forward: calibrationQuality(record.forward.samples, record.forward.fit, record.limits),
  };
  const closureQuality = {
    yaw: calibrationClosureQuality(
      record.yaw.samples, record.yaw.fit, closure.yaw,
      finalClosure?.yawDeg ?? Number.POSITIVE_INFINITY, CALIBRATION_CLOSURE_LIMITS,
    ),
    pitch: calibrationClosureQuality(
      record.pitch.samples, record.pitch.fit, closure.pitch,
      finalClosure?.pitchDeg ?? Number.POSITIVE_INFINITY, CALIBRATION_CLOSURE_LIMITS,
    ),
    forward: calibrationClosureQuality(
      record.forward.samples, record.forward.fit, closure.forward,
      finalClosure?.depthM ?? Number.POSITIVE_INFINITY, CALIBRATION_CLOSURE_LIMITS,
    ),
  };
  const reasons: string[] = [];
  for (const [axis, quality] of Object.entries(axes)) {
    if (quality.status !== "accepted") reasons.push(`${axis}_fit_${quality.reasons.join("+")}`);
  }
  if (Math.abs(record.yaw.fit.slope) < MIN_ANGULAR_SLOPE_DEG_PER_PX) reasons.push("yaw_slope_too_small");
  if (Math.abs(record.pitch.fit.slope) < MIN_ANGULAR_SLOPE_DEG_PER_PX) reasons.push("pitch_slope_too_small");
  if (record.forward.fit.slope < MIN_FORWARD_SLOPE_M_PER_MS) reasons.push("forward_slope_too_small");
  const projected = projectionQuality(projections);
  if (projected.status !== "accepted") reasons.push(...projected.reasons);
  if (closureQuality.yaw.reasons.includes("pair_closure") || closureQuality.yaw.reasons.includes("invalid_closure")) reasons.push("yaw_restore_closure");
  if (closureQuality.pitch.reasons.includes("pair_closure") || closureQuality.pitch.reasons.includes("invalid_closure")) reasons.push("pitch_restore_closure");
  if (closureQuality.forward.reasons.includes("pair_closure") || closureQuality.forward.reasons.includes("invalid_closure")) reasons.push("forward_restore_closure");
  if (closureQuality.yaw.reasons.includes("final_closure") || closureQuality.yaw.reasons.includes("invalid_closure")) reasons.push("final_yaw_closure");
  if (closureQuality.pitch.reasons.includes("final_closure") || closureQuality.pitch.reasons.includes("invalid_closure")) reasons.push("final_pitch_closure");
  if (closureQuality.forward.reasons.includes("final_closure") || closureQuality.forward.reasons.includes("invalid_closure")) reasons.push("final_depth_closure");
  return {
    status: reasons.length ? "rejected" as const : "accepted" as const,
    reasons,
    axes,
    projection: projected,
    closure: closureQuality,
  };
}

type StoredCalibrationValidation =
  | { status: "valid"; envelope: NavigationCalibrationRegistryEnvelope; record: NavigationCalibrationRecord }
  | {
      status: "stale" | "quality_rejected";
      detail: string;
      reasonCode?: NavigationCalibrationReasonCode;
    };

function exactKeys(value: unknown, keys: string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) === JSON.stringify([...keys].sort());
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

async function validateStoredCalibrationReceipt(
  candidate: NavigationCalibrationRegistryEnvelope,
  context: NavigationCalibrationContext,
  deps: Pick<NavigationTargetDependencies, "readCalibrationReceipt">,
): Promise<StoredCalibrationValidation> {
  if (!exactKeys(candidate, ["schemaVersion", "contextKey", "record", "receiptRef"])
    || candidate.schemaVersion !== 1
    || candidate.contextKey !== calibrationContextKey(context)
    || candidate.record?.contextKey !== candidate.contextKey
    || !exactKeys(candidate.receiptRef, ["path", "sha256", "bytes"])
    || typeof candidate.receiptRef.path !== "string" || !path.isAbsolute(candidate.receiptRef.path)
    || !/^[a-f0-9]{64}$/.test(candidate.receiptRef.sha256)
    || !Number.isSafeInteger(candidate.receiptRef.bytes) || candidate.receiptRef.bytes <= 0) {
    return { status: "stale", detail: "calibration registry envelope or receipt link is invalid" };
  }
  let bytes: Buffer;
  try {
    bytes = await deps.readCalibrationReceipt(candidate.receiptRef);
  } catch (error: any) {
    return { status: "stale", detail: `calibration receipt is unavailable: ${error?.message ?? String(error)}` };
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== candidate.receiptRef.bytes
    || sha256Bytes(bytes) !== candidate.receiptRef.sha256) {
    return { status: "stale", detail: "calibration receipt bytes or SHA-256 changed" };
  }
  let receipt: Record<string, any>;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { status: "stale", detail: "calibration receipt is not valid JSON" };
  }
  const receiptKeys = ["kind", "schemaVersion", "createdAt", "calibration", "actions", "captures", "sceneQueries", "evidenceCeiling"];
  if (!(exactKeys(receipt, receiptKeys) || exactKeys(receipt, [...receiptKeys, "hostWindowProbe", "hostWindowProbes"])
    || exactKeys(receipt, [...receiptKeys, "hostWindowFocusRequest", "hostWindowProbe", "hostWindowProbes"]))
    || receipt.kind !== "pico.navigation-calibration-receipt"
    || receipt.schemaVersion !== 1 || receipt.evidenceCeiling !== "structural"
    || !receipt.calibration || typeof receipt.calibration !== "object"
    || !canonicalEqual(receipt.calibration.context, context)
    || !canonicalEqual(receipt.calibration.record, candidate.record)
    || receipt.calibration.record?.contextKey !== candidate.contextKey
    || receipt.calibration.cameraCalibrationProof?.sha256 !== context.cameraCalibrationSha256) {
    return { status: "stale", detail: "calibration receipt is orphaned from its registry/context record" };
  }
  const observedProfileVersion = receipt.calibration.profile?.version;
  const observedRecordVersion = candidate.record?.version;
  if (observedProfileVersion !== NAVIGATION_CALIBRATION_PROFILE.version
    || observedRecordVersion !== NAVIGATION_CALIBRATION_PROFILE.version) {
    return {
      status: "quality_rejected",
      reasonCode: "calibration_policy_version_mismatch",
      detail: `calibration_policy_version_mismatch: observed profile version ${String(observedProfileVersion)} and record version ${String(observedRecordVersion)}; required profile/record version ${NAVIGATION_CALIBRATION_PROFILE.version}`,
    };
  }
  if (!canonicalEqual(receipt.calibration.profile, NAVIGATION_CALIBRATION_PROFILE)
    || !canonicalEqual(candidate.record.limits, CALIBRATION_LIMITS)) {
    return { status: "quality_rejected", detail: "calibration policy does not match the code-owned profile" };
  }
  const recordValidation = validateNavigationCalibration(candidate.record, context);
  if (recordValidation.status !== "valid") {
    return {
      status: recordValidation.reason === "context_mismatch" || recordValidation.reason === "invalid_record" || recordValidation.reason === "fit_mismatch"
        ? "stale" : "quality_rejected",
      detail: `calibration record validation failed: ${recordValidation.reason}`,
    };
  }
  if (Math.abs(candidate.record.yaw.fit.slope) < MIN_ANGULAR_SLOPE_DEG_PER_PX
    || Math.abs(candidate.record.pitch.fit.slope) < MIN_ANGULAR_SLOPE_DEG_PER_PX
    || candidate.record.forward.fit.slope < MIN_FORWARD_SLOPE_M_PER_MS) {
    return { status: "quality_rejected", detail: "calibration slope is below the code-owned minimum" };
  }
  const quality = receipt.calibration.quality;
  const recomputedAxes = {
    yaw: calibrationQuality(candidate.record.yaw.samples, candidate.record.yaw.fit, candidate.record.limits),
    pitch: calibrationQuality(candidate.record.pitch.samples, candidate.record.pitch.fit, candidate.record.limits),
    forward: calibrationQuality(candidate.record.forward.samples, candidate.record.forward.fit, candidate.record.limits),
  };
  if (quality?.status !== "accepted" || !Array.isArray(quality.reasons) || quality.reasons.length !== 0
    || Object.values(recomputedAxes).some((axis) => axis.status !== "accepted")
    || !canonicalEqual(quality.axes, recomputedAxes)) {
    return { status: "quality_rejected", detail: "calibration receipt fit quality was not accepted" };
  }
  const projected = receipt.calibration.projectionQuality;
  if (projected?.status !== "accepted" || !Array.isArray(projected.reasons) || projected.reasons.length !== 0
    || !Array.isArray(projected.samples) || projected.samples.length < CALIBRATION_SCHEDULE.length + 1
    || projected.samples.some((sample: any) => sample?.status !== "accepted" || sample.clipped !== false
      || !Number.isFinite(sample.depthRelativeError) || sample.depthRelativeError > MAX_PROJECTION_RELATIVE_ERROR
      || !Number.isFinite(sample.aspectRelativeError) || sample.aspectRelativeError > MAX_PROJECTION_RELATIVE_ERROR)) {
    return { status: "quality_rejected", detail: "calibration projection/aspect evidence was not accepted" };
  }
  const closure = receipt.calibration.restoreClosure;
  const finalClosure = receipt.calibration.finalClosure;
  const recomputedClosure = exactKeys(finalClosure, ["yawDeg", "pitchDeg", "depthM"]) ? {
    yaw: calibrationClosureQuality(
      candidate.record.yaw.samples, candidate.record.yaw.fit, closure?.yaw,
      finalClosure.yawDeg, CALIBRATION_CLOSURE_LIMITS,
    ),
    pitch: calibrationClosureQuality(
      candidate.record.pitch.samples, candidate.record.pitch.fit, closure?.pitch,
      finalClosure.pitchDeg, CALIBRATION_CLOSURE_LIMITS,
    ),
    forward: calibrationClosureQuality(
      candidate.record.forward.samples, candidate.record.forward.fit, closure?.forward,
      finalClosure.depthM, CALIBRATION_CLOSURE_LIMITS,
    ),
  } : null;
  if (!recomputedClosure || Object.values(recomputedClosure).some((axis) => axis.status !== "accepted")
    || !canonicalEqual(receipt.calibration.restoreClosureQuality, recomputedClosure)) {
    return { status: "quality_rejected", detail: "calibration restore closure exceeds the code-owned profile" };
  }
  return { status: "valid", envelope: candidate, record: candidate.record };
}

/**
 * Complete fakeable target-navigation action. Motion is admitted and executed by one persistent
 * RelativeRouteExecution; immutable detector work and fresh scene queries run only between explicit
 * shared steps, while the route session owns every action, settle, recovery, and cumulative budget.
 */
export async function executeNavigateToSceneTarget(
  rawInput: NavigateToSceneTargetInput,
  deps: NavigationTargetDependencies = defaultNavigationTargetDependencies(),
): Promise<Record<string, any>> {
  const input = navigateToSceneTargetInputSchema.parse(rawInput);
  const result = newResult(input);
  const claims = new Set<NavigationTargetClaim>();
  const startedAt = deps.monotonicNs();
  const maximumDurationMs = input.motionPolicy.maxDurationSec * 1000;
  let scene: SelectedScene | null = null;
  let qemu: BoundQemuWindow | null = null;
  let session: ReservedArtifactSession | null = null;
  let execution: RelativeRouteExecution | null = null;
  let routeStatus: RelativeRouteTrace["status"] = "controller_stop";
  let routeSealed = false;
  let guideMayHaveApplied = false;
  let finalHideNeeded = false;
  let hiddenProof: AgentBridgeNavigationGuideRequestResult | null = null;
  let attemptedGeneration = 0;
  let settledGeneration = 0;
  let terminalReason: NavigationTargetStopReason | null = null;
  let terminalDetail: string | null = null;
  let publishCalibration: { record: NavigationCalibrationRecord; payload: Record<string, any> } | null = null;
  let inputPreconditionFailure: { code: NavigationTargetStopReason; detail: string } | null = null;
  const requireHostWindow = async (phase: string, remainingMs?: () => number, retainedProbe?: HostWindowProbe): Promise<void> => {
    let probe: HostWindowProbe;
    try {
      probe = retainedProbe ?? (deps.probeHostWindow
        ? await deps.probeHostWindow(input.serial, qemu ?? undefined)
        : unavailableHostWindowProbe("host window probe dependency is unavailable", qemu ?? undefined));
    } catch (error) {
      probe = unavailableHostWindowProbe(error instanceof Error ? error.message : String(error), qemu ?? undefined);
    }
    result.hostWindowProbe = structuredClone(probe);
    result.hostWindowProbes.push({ phase, probe: structuredClone(probe) });
    const failure = hostWindowPrecondition(probe);
    if (failure) {
      inputPreconditionFailure ??= failure;
      throw new NavigationTargetStop(failure.code, failure.detail);
    }
    if (remainingMs && remainingMs() <= 0) {
      const failure = { code: "budget_exhausted" as const, detail: `${phase} host window probe exhausted the admitted deadline` };
      inputPreconditionFailure ??= failure;
      throw new NavigationTargetStop(failure.code, failure.detail);
    }
  };
  const controlAudits = new Map<string, NavigationControlAudit>();
  const accountedAttempts = new Set<string>();
  const attemptKey = (attempt: Pick<RelativeRouteActionAttempt, "identity">) =>
    `${attempt.identity.executionId}:${attempt.identity.stepSeq}:${attempt.identity.actionIndex}`;

  const elapsedMs = () => {
    const observed = deps.monotonicNs();
    if (observed < startedAt) return maximumDurationMs;
    const elapsed = Number((observed - startedAt) / 1_000_000n);
    return Number.isSafeInteger(elapsed) ? elapsed : maximumDurationMs;
  };
  const rememberScene = (selected: SelectedScene) => {
    scene = selected;
    result.applicationRuntimeBinding = selected.output.applicationRuntimeBinding as ApplicationRuntimeBinding;
    result.target = {
      snapshotId: selected.snapshotId,
      traceId: selected.traceId,
      runtimeUuid: selected.runtimeUuid,
      selectorReceipt: selected.selectorReceipt,
    };
    result.sceneQueries.push({
      status: selected.output.status,
      snapshotId: selected.snapshotId,
      traceId: selected.traceId,
      runtimeUuid: selected.runtimeUuid,
      geometryRef: selected.output.geometryRef,
      selectorReceipt: selected.selectorReceipt,
      crossQueryDrift: selected.crossQueryDrift,
    });
  };
  const setTerminal = (reason: NavigationTargetStopReason, detail: string) => {
    if (terminalReason === null || reason === "cleanup_failed") {
      terminalReason = reason;
      terminalDetail = detail;
    }
  };
  const capture = async (name: string, priorSha256?: string): Promise<CaptureSettledReceipt> => {
    if (!session) throw new NavigationTargetStop("binding_failed", "artifact session was not reserved");
    if (maximumDurationMs - elapsedMs() <= 0) throw new NavigationTargetStop("budget_exhausted", `${name} capture deadline exhausted`);
    const captured = await deps.captureSettled({
      serial: input.serial,
      outPath: path.join(session.absoluteRoot, `${name}.png`),
      maxTries: ROUTE_CAPTURE.maxTries,
      intervalMs: ROUTE_CAPTURE.intervalMs,
      comparison: SETTLE_COMPARISON,
      ...(priorSha256 ? { priorSha256 } : {}),
    }, { hostWindowBinding: qemu ?? undefined });
    await requireHostWindow(`${name}_after_capture`, () => maximumDurationMs - elapsedMs(), captured.receipt.hostWindowProbe);
    const receipt = settledOrThrow(captured.receipt, name);
    if (!scene || !captureMatchesScene(receipt, scene)) {
      throw new NavigationTargetStop("binding_failed", `${name} capture runtime does not match the selected scene runtime`);
    }
    return receipt;
  };
  const sealRoute = () => {
    if (!execution || routeSealed) return;
    routeSealed = true;
    const trace = execution.finish(routeStatus);
    result.routeTraces = [trace];
    result.actions = trace.actionAttempts.map((attempt) => {
      const controlAudit = controlAudits.get(attemptKey(attempt));
      const routeMeta = attempt.pairId || attempt.pairRole || attempt.recoveryLane
        ? {
            lane: attempt.lane,
            ...(attempt.pairId ? { pairId: attempt.pairId } : {}),
            ...(attempt.pairRole ? { pairRole: attempt.pairRole } : {}),
          }
        : null;
      return {
        seq: attempt.identity.stepSeq,
        actionIndex: attempt.identity.actionIndex,
        request: attempt.request,
        ack: attempt.action.evidence,
        settle: attempt.settle.evidence,
        attempt,
        ...(routeMeta ? { routeMeta } : {}),
        ...(controlAudit ? { controlAudit } : {}),
      };
    });
  };
  const accountStepAttempts = (step: RelativeRouteStepOutcome) => {
    for (const attempt of step.actionAttempts) {
      const key = attemptKey(attempt);
      if (accountedAttempts.has(key)) continue;
      accountedAttempts.add(key);
      attemptedGeneration = Math.max(attemptedGeneration, attempt.order);
    }
    if (step.waypoint?.settle.status === "settled" && step.waypoint.settle.settlementSatisfied) {
      const settledOrder = step.actionAttempts.at(-1)?.order;
      if (settledOrder !== undefined) settledGeneration = Math.max(settledGeneration, settledOrder);
    }
  };
  const failStep = (step: RelativeRouteStepOutcome): never => {
    accountStepAttempts(step);
    routeStatus = step.status === "settled" ? "controller_stop" : step.status;
    if (inputPreconditionFailure) throw new NavigationTargetStop(inputPreconditionFailure.code, inputPreconditionFailure.detail);
    const trace: RelativeRouteTrace = {
      status: routeStatus,
      waypoints: [],
      actionAttempts: [],
      terminalActionFailures: [],
      usage: { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 0 },
    };
    throw new NavigationTargetStop(routeStopReason(trace), `shared camera route stopped with ${step.status}`);
  };

  try {
    const initialScene = await queryAndSelectScene(input, deps, null);
    rememberScene(initialScene);
    const bound = await deps.bindQemuWindow(input.serial);
    if (!bound.ok) throw new NavigationTargetStop(bound.code, bound.detail);
    qemu = bound.binding;
    if (!exactQemuGeometry(qemu)) throw new NavigationTargetStop("binding_failed", "qemu binding lacks exact measured x/y/width/height/scale geometry");
    result.qemuBinding = qemu;
    const focusStartedNs = deps.monotonicNs();
    let focusError: string | null;
    try {
      focusError = deps.focusQemuWindow ? await deps.focusQemuWindow(qemu) : "host window focus dependency is unavailable";
    } catch (error) {
      focusError = error instanceof Error ? error.message : String(error);
    }
    result.hostWindowFocusRequest = {
      status: focusError ? "failed" : "requested",
      error: focusError,
      qemuWindowId: qemu.qemuWindowId,
      qemuWindowOwnerPid: qemu.qemuWindowOwnerPid,
      durationMs: Math.max(0, Number(deps.monotonicNs() - focusStartedNs) / 1_000_000),
    };
    await requireHostWindow("bound_preflight");

    const ownerNonceHash = crypto.createHash("sha256").update(deps.randomId()).digest("hex");
    const prospective: ReservedArtifactSession = {
      runId: deps.randomId(),
      absoluteRoot: assertExternalCapturePath(input.outDir),
      ownerNonceHash,
    };
    if (input.action === "calibrate") {
      const preflight = routeInput(input, initialScene, qemu, prospective, "0".repeat(64), maximumDurationMs);
      const groups = [
        [{ kind: "look_drag", dxPx: input.motionPolicy.maxDragPxPerAction, dyPx: 0 } as RelativeCameraAction],
        ...CALIBRATION_SCHEDULE.map((step) => [step.action]),
      ];
      const estimated = estimateRelativeRouteDurationMs(preflight, groups);
      if (!calibrationScheduleFitsPolicy(input) || !Number.isFinite(estimated)
        || elapsedMs() + estimated + CALIBRATION_NON_ROUTE_RESERVE_MS > maximumDurationMs) {
        result.refusalReason = "insufficient_budget";
        throw new NavigationTargetStop("budget_exhausted", "calibration budget cannot admit guide work, acquisition, 24 trial/restore waypoints, and cleanup");
      }
    } else {
      const preflight = routeInput(input, initialScene, qemu, prospective, "0".repeat(64), maximumDurationMs);
      const dragEstimate = estimateRelativeRouteDurationMs(preflight, [[{
        kind: "look_drag",
        dxPx: input.motionPolicy.maxDragPxPerAction,
        dyPx: 0,
      }]]);
      const keyEstimate = estimateRelativeRouteDurationMs(preflight, [[{
        kind: "key_hold",
        key: "w",
        holdMs: input.motionPolicy.maxHoldMsPerAction,
      }]]);
      const estimatedWaypoint = Math.max(dragEstimate, keyEstimate);
      if (!Number.isFinite(estimatedWaypoint)
        || elapsedMs() + estimatedWaypoint + NAVIGATION_NON_ROUTE_RESERVE_MS > maximumDurationMs) {
        result.refusalReason = "insufficient_budget";
        throw new NavigationTargetStop(
          "budget_exhausted",
          "navigation budget cannot admit preflight HIDE, guide-off/SHOW/on, one settled route waypoint, and final guide cleanup",
        );
      }
    }
    session = await deps.reserveArtifactSession(prospective.absoluteRoot, prospective.runId, ownerNonceHash);
    if (session.runId !== prospective.runId || session.ownerNonceHash !== ownerNonceHash
      || path.resolve(session.absoluteRoot) !== path.resolve(prospective.absoluteRoot)) {
      throw new NavigationTargetStop("binding_failed", "reserved artifact session does not match the requested identity");
    }

    result.cleanup.hideTransactions++;
    const preflightHide = await deps.requestGuide(guideRequestFor(input, scene!, deps.randomId(), "hide"));
    result.guideTransitions.preflightHide = preflightHide;
    result.guideTransitions.transactions.push(preflightHide);
    if (!preflightHide.ok || !preflightHide.cleanupProven || preflightHide.terminalGuideState !== "hidden") {
      throw new NavigationTargetStop(
        "guide_not_acquired",
        `navigation-guide capability preflight failed: ${preflightHide.ok ? "HIDE lacked exact hidden cleanup proof" : preflightHide.detail}`,
      );
    }
    hiddenProof = preflightHide;

    const guideOff = await capture("guide-off");
    result.captures.guideOff = guideOff;
    if (!guideIsAbsent(await immutableGuideMeasurement(guideOff, input, deps))) {
      throw new NavigationTargetStop("guide_not_acquired", "guide-off frame contains authored guide colors");
    }
    finalHideNeeded = true;
    guideMayHaveApplied = true;
    const show = await deps.requestGuide(guideRequestFor(input, scene!, deps.randomId(), "show"));
    result.guideTransitions.show = show;
    result.guideTransitions.transactions.push(show);
    if (!show.ok) {
      if (show.cleanupProven && show.terminalGuideState === "hidden") {
        finalHideNeeded = false;
        hiddenProof = show;
        result.cleanup.guideHide = show;
        result.cleanup.hideTransactions++;
      }
      throw new NavigationTargetStop("guide_not_acquired", show.detail);
    }

    // Equal bytes are valid settled evidence when both detectors say the guide is absent.
    let guideOn = await capture("guide-on");
    result.captures.guideOn = guideOn;
    let measured = await immutableGuideMeasurement(guideOn, input, deps);
    if (measured.guide && guideOn.sha256 === guideOff.sha256) {
      throw new NavigationTargetStop("guide_not_acquired", "guide detector contradicted byte-identical off/on frames");
    }

    const application = scene!.output.applicationRuntimeBinding as ApplicationRuntimeBinding;
    const cameraProof = await deps.readCameraCalibrationProof(input.serial, application.liveIdentity.bootId);
    if (!cameraProof.ok) {
      result.calibrationStatus = cameraProof.code === "missing" ? "missing" : cameraProof.code === "stale" ? "stale" : "quality_rejected";
      result.refusalReason = result.calibrationStatus === "missing" || result.calibrationStatus === "stale"
        ? result.calibrationStatus : "quality_rejected";
      throw new NavigationTargetStop("unsupported_backend", `fresh camera calibration is unavailable: ${cameraProof.detail}`);
    }
    const context = calibrationContext(scene!, qemu, guideOn, cameraProof.proof);
    const contextKey = calibrationContextKey(context);
    let approachCalibration: { status: "valid" | "invalid" } = { status: "invalid" };
    let approachCalibrationDetail: string | null = null;
    let storedCalibration: NavigationCalibrationRegistryEnvelope | null = null;
    let acceptedCalibrationRecord: NavigationCalibrationRecord | null = null;
    if (input.action === "navigate") {
      try {
        storedCalibration = await deps.readCalibrationRecord(contextKey);
      } catch {
        result.calibrationStatus = "stale";
        result.refusalReason = "stale";
      }
      if (!storedCalibration) {
        if (result.calibrationStatus !== "stale") {
          result.calibrationStatus = "missing";
          result.refusalReason = "missing";
        }
      } else {
        const validation = await validateStoredCalibrationReceipt(storedCalibration, context, deps);
        if (validation.status === "valid") {
          acceptedCalibrationRecord = validation.record;
          result.calibrationStatus = "valid";
          approachCalibration = { status: "valid" };
        } else {
          result.calibrationStatus = validation.status;
          result.calibrationReasonCode = validation.reasonCode ?? null;
          result.refusalReason = validation.status;
          approachCalibrationDetail = validation.detail;
        }
      }
      if (acceptedCalibrationRecord) {
        result.calibrationStatus = "valid";
        approachCalibration = { status: "valid" };
      }
    }

    const remainingRouteMs = maximumDurationMs - elapsedMs() - FINAL_GUIDE_CLEANUP_RESERVE_MS;
    if (remainingRouteMs <= INVERSE_RECOVERY_RESERVE_MS) throw new NavigationTargetStop("budget_exhausted", "whole-action deadline leaves no route, recovery, and cleanup budget");
    const boundRoute = routeInput(input, scene!, qemu, session, guideOn.sha256!, remainingRouteMs);
    const adapter = deps.createActionAdapter(input.serial, qemu);
    let waypointSequence = 0;
    execution = createRelativeRouteExecution(boundRoute, {
      applyRelativeAction: async (action, budget) => {
        await requireHostWindow("before_camera_action", () => maximumDurationMs - elapsedMs() - FINAL_GUIDE_CLEANUP_RESERVE_MS);
        if (budget?.canStart() !== true) {
          inputPreconditionFailure ??= {
            code: "budget_exhausted",
            detail: "insufficient remaining budget for the complete action and settlement envelope",
          };
          throw new NavigationTargetStop(inputPreconditionFailure.code, inputPreconditionFailure.detail);
        }
        return adapter.applyRelativeAction(action);
      },
      sampleContinuity: () => deps.sampleContinuity({
        serial: application.serial,
        bootId: application.liveIdentity.bootId,
        packageName: application.packageName,
        apkSha256: application.apkSha256,
        pid: application.foregroundProcess.pid,
        pidStartTicks: application.foregroundProcess.pidStartTicks,
        allowedResumedComponents: [application.foregroundProcess.component],
      }),
      captureSettled: async (capturePath, deadline) => {
        if (deadline.remainingMs() <= 0) throw new Error("route capture deadline exhausted");
        const captured = await deps.captureSettled({
          serial: input.serial,
          outPath: capturePath,
          maxTries: ROUTE_CAPTURE.maxTries,
          intervalMs: ROUTE_CAPTURE.intervalMs,
          comparison: SETTLE_COMPARISON,
          priorSha256: deadline.priorSha256,
        }, { hostWindowBinding: qemu ?? undefined });
        await requireHostWindow("waypoint_after_capture", deadline.remainingMs, captured.receipt.hostWindowProbe);
        return captured.receipt;
      },
      allocateWaypointPath: () => path.join(session!.absoluteRoot, `waypoint-${String(++waypointSequence).padStart(4, "0")}.png`),
      sleep: deps.sleep,
      monotonicNs: deps.monotonicNs,
    });

    const controllerState: NavigationStepState = {
      centerBandPx: input.centerBandPx,
      targetAreaFraction: input.targetAreaFraction,
      motionPolicy: input.motionPolicy,
      actionCount: 0,
      elapsedMs: elapsedMs(),
      cumulativeDragPx: 0,
      cumulativeHoldMs: 0,
      phase: measured.guide ? "center" : "acquire",
      areaHistory: measured.guide ? [measured.guide.areaFraction] : [],
    };
    const auditAction = (
      rawDesired: Record<string, number | string>,
      gain: number,
      action: RelativeCameraAction,
      usageOffset: { actions?: number; dragPx?: number; holdMs?: number } = {},
    ): NavigationControlAudit => {
      const applied: Record<string, number | string> = action.kind === "look_drag"
        ? { dxPx: action.dxPx, dyPx: action.dyPx }
        : { key: action.key, holdMs: action.holdMs };
      const rawDx = typeof rawDesired.dxPx === "number" ? rawDesired.dxPx : null;
      const rawDy = typeof rawDesired.dyPx === "number" ? rawDesired.dyPx : null;
      const rawHold = typeof rawDesired.holdMs === "number" ? rawDesired.holdMs : null;
      return {
        rawDesired,
        gain,
        applied,
        policyLimits: {
          maxDragPxPerAction: input.motionPolicy.maxDragPxPerAction,
          remainingCumulativeDragPx: Math.max(0, input.motionPolicy.maxCumulativeDragPx
            - controllerState.cumulativeDragPx - (usageOffset.dragPx ?? 0)),
          maxHoldMsPerAction: input.motionPolicy.maxHoldMsPerAction,
          remainingCumulativeHoldMs: Math.max(0, input.motionPolicy.maxCumulativeHoldMs
            - controllerState.cumulativeHoldMs - (usageOffset.holdMs ?? 0)),
          remainingActions: Math.max(0, input.motionPolicy.maxActions
            - controllerState.actionCount - (usageOffset.actions ?? 0)),
        },
        wasClamped: action.kind === "look_drag"
          ? rawDx === null || rawDy === null
            || Math.abs(rawDx * gain - action.dxPx) > 1e-9
            || Math.abs(rawDy * gain - action.dyPx) > 1e-9
          : rawHold === null || Math.abs(rawHold * gain - action.holdMs) > 1e-9,
      };
    };
    const bindControlAudit = (
      step: RelativeRouteStepOutcome,
      audits: readonly NavigationControlAudit[],
    ) => {
      for (let index = 0; index < step.actionAttempts.length && index < audits.length; index++) {
        controlAudits.set(attemptKey(step.actionAttempts[index]), audits[index]);
      }
    };
    const observeStep = async (
      step: RelativeRouteStepOutcome,
      action: RelativeCameraAction,
      acquisition: boolean,
      acceptTerminalSettledWaypoint = false,
    ) => {
      accountStepAttempts(step);
      if (!step.waypoint || (step.status !== "settled" && !acceptTerminalSettledWaypoint)) failStep(step);
      const waypoint = step.waypoint!;
      controllerState.actionCount++;
      if (action.kind === "look_drag") controllerState.cumulativeDragPx += Math.hypot(action.dxPx, action.dyPx);
      else controllerState.cumulativeHoldMs += action.holdMs;
      controllerState.elapsedMs = elapsedMs();
      await requireHostWindow("before_waypoint_measurement", () => maximumDurationMs - elapsedMs());
      const observed = await immutableGuideMeasurement(waypoint.settle, input, deps);
      if (acquisition) result.captures.acquisition.push(waypoint.settle);
      const refreshed = await queryAndSelectScene(input, deps, scene!);
      rememberScene(refreshed);
      if (!refreshed.crossQueryDrift?.withinPolicy) throw new NavigationTargetStop("scene_drift", "scene geometry exceeded cross-query drift policy");
      return observed;
    };

    let repeatedAfterAcquisition = false;
    const repeatGuideDelta = async (priorVisible: CaptureSettledReceipt) => {
      if (!scene || !execution) throw new NavigationTargetStop("binding_failed", "route/scene disappeared before rebaseline");
      if (maximumDurationMs - elapsedMs() < REACQUIRED_GUIDE_DELTA_RESERVE_MS + FINAL_GUIDE_CLEANUP_RESERVE_MS) {
        throw new NavigationTargetStop("budget_exhausted", "deadline cannot admit same-view rebaseline and cleanup");
      }
      result.cleanup.hideTransactions++;
      const hide = await deps.requestGuide(guideRequestFor(input, scene, deps.randomId(), "hide"));
      result.guideTransitions.transactions.push(hide);
      if (!hide.cleanupProven || hide.terminalGuideState !== "hidden") {
        finalHideNeeded = true;
        throw new NavigationTargetStop("cleanup_failed", hide.ok ? "rebaseline HIDE lacked hidden cleanup proof" : hide.detail);
      }
      finalHideNeeded = false;
      hiddenProof = hide;
      const off = await capture("guide-off-rebaseline", priorVisible.sha256!);
      result.captures.guideOffRebaseline = off;
      if (!guideIsAbsent(await immutableGuideMeasurement(off, input, deps))) {
        throw new NavigationTargetStop("guide_not_acquired", "guide persisted after rebaseline HIDE");
      }
      finalHideNeeded = true;
      guideMayHaveApplied = true;
      const repeatedShow = await deps.requestGuide(guideRequestFor(input, scene, deps.randomId(), "show"));
      result.guideTransitions.transactions.push(repeatedShow);
      if (!repeatedShow.ok) {
        if (repeatedShow.cleanupProven && repeatedShow.terminalGuideState === "hidden") {
          finalHideNeeded = false;
          hiddenProof = repeatedShow;
          result.cleanup.hideTransactions++;
        }
        throw new NavigationTargetStop("guide_not_acquired", repeatedShow.detail);
      }
      const on = await capture("guide-on-rebaseline", off.sha256!);
      result.captures.guideOnRebaseline = on;
      const onMeasured = await immutableGuideMeasurement(on, input, deps);
      if (!onMeasured.guide || on.sha256 === off.sha256) throw new NavigationTargetStop("guide_not_acquired", "repeated same-view delta was not proven");
      if (!execution.adoptSettledBaseline(on)) throw new NavigationTargetStop("binding_failed", "route rejected exact rebaseline capture");
      repeatedAfterAcquisition = true;
      guideOn = on;
      measured = onMeasured;
    };

    while (!measured.guide) {
      controllerState.phase = "acquire";
      const intent = decideNavigationStep(controllerState, { guide: null }, { status: "invalid" });
      if (intent.kind !== "drag") {
        throw new NavigationTargetStop(intent.kind === "stop" ? intent.reason : "guide_not_acquired", "bounded horizontal acquisition exhausted");
      }
      const action: RelativeCameraAction = { kind: "look_drag", dxPx: intent.dxPx, dyPx: intent.dyPx };
      const audit = auditAction({ dxPx: intent.dxPx, dyPx: intent.dyPx }, intent.gain, action);
      const step = await execution.executeStep([action]);
      bindControlAudit(step, [audit]);
      measured = await observeStep(step, action, true);
    }
    if (result.captures.acquisition.length) await repeatGuideDelta(result.captures.acquisition.at(-1)!);

    const samples: Record<CalibrationAxis, RegressionSample[]> = { yaw: [], pitch: [], forward: [] };
    const closure: Record<CalibrationAxis, number[]> = { yaw: [], pitch: [], forward: [] };
    const projections: ProjectionMeasurement[] = [];
    const measurePose = (frame: MeasuredGuideFrame) => {
      if (!frame.guide) return null;
      const projection = projectGuide(frame.guide, cameraProof.proof.calibration);
      projections.push(projection);
      return { ...angularObservation(frame.guide, cameraProof.proof.calibration), depthM: projection.depthM };
    };
    let baseline = measurePose(measured);
    const originalBaseline = baseline ? { ...baseline } : null;

    if (input.action === "calibrate") {
      for (let index = 0; index < CALIBRATION_SCHEDULE.length; index += 2) {
        const outbound = CALIBRATION_SCHEDULE[index];
        const restore = CALIBRATION_SCHEDULE[index + 1];
        const pairId = `${outbound.axis}-${outbound.sampleIndex}`;
        const outboundAudit = auditAction(
          outbound.action.kind === "look_drag"
            ? { dxPx: outbound.action.dxPx, dyPx: outbound.action.dyPx }
            : { key: outbound.action.key, holdMs: outbound.action.holdMs },
          1,
          outbound.action,
        );
        const outboundUsage = outbound.action.kind === "look_drag"
          ? { actions: 1, dragPx: Math.hypot(outbound.action.dxPx, outbound.action.dyPx) }
          : { actions: 1, holdMs: outbound.action.holdMs };
        const restoreAudit = auditAction(
          restore.action.kind === "look_drag"
            ? { dxPx: restore.action.dxPx, dyPx: restore.action.dyPx }
            : { key: restore.action.key, holdMs: restore.action.holdMs },
          1,
          restore.action,
          outboundUsage,
        );
        const pair = await execution.executePairedStep(outbound.action, restore.action, { pairId });
        bindControlAudit(pair.outbound, [outboundAudit]);
        accountStepAttempts(pair.outbound);
        if (pair.restore) {
          bindControlAudit(pair.restore, [restoreAudit]);
          accountStepAttempts(pair.restore);
        }
        if (!pair.outbound.waypoint) failStep(pair.outbound);
        const outboundFrame = await observeStep(pair.outbound, outbound.action, false, true);
        if (!outboundFrame.guide || !baseline) {
          throw new NavigationTargetStop("guide_not_acquired", "calibration guide was lost after an outbound trial");
        }
        const outboundPose = measurePose(outboundFrame)!;
        if (!pair.restore || pair.restore.status !== "settled" || !pair.restore.waypoint) {
          routeStatus = pair.restore && pair.restore.status !== "settled"
            ? pair.restore.status
            : pair.primaryStatus !== "settled" ? pair.primaryStatus : "route_unsettled";
          throw new NavigationTargetStop("cleanup_failed", `calibration inverse restore failed after ${pair.primaryStatus}`);
        }
        const restoredFrame = await observeStep(pair.restore, restore.action, false);
        if (!restoredFrame.guide) {
          throw new NavigationTargetStop("cleanup_failed", "calibration inverse settled without a valid guide restoration measurement");
        }
        const restoredPose = measurePose(restoredFrame)!;
        const x = outbound.action.kind === "look_drag"
          ? outbound.axis === "yaw" ? outbound.action.dxPx : outbound.action.dyPx
          : outbound.action.holdMs;
        const y = outbound.axis === "yaw" ? outboundPose.yawDeg - baseline.yawDeg
          : outbound.axis === "pitch" ? outboundPose.pitchDeg - baseline.pitchDeg
            : baseline.depthM - outboundPose.depthM;
        samples[outbound.axis].push({ x, y });
        const residual = outbound.axis === "yaw" ? restoredPose.yawDeg - baseline.yawDeg
          : outbound.axis === "pitch" ? restoredPose.pitchDeg - baseline.pitchDeg
            : restoredPose.depthM - baseline.depthM;
        closure[outbound.axis].push(residual);
        baseline = restoredPose;
        if (pair.primaryStatus !== "settled") failStep(pair.outbound);
      }
      sealRoute();
      const finalClosure = originalBaseline && baseline ? {
        yawDeg: baseline.yawDeg - originalBaseline.yawDeg,
        pitchDeg: baseline.pitchDeg - originalBaseline.pitchDeg,
        depthM: baseline.depthM - originalBaseline.depthM,
      } : { yawDeg: Number.POSITIVE_INFINITY, pitchDeg: Number.POSITIVE_INFINITY, depthM: Number.POSITIVE_INFINITY };
      const record: NavigationCalibrationRecord = {
        version: 2,
        contextKey,
        yaw: { samples: samples.yaw, fit: fitThroughOrigin(samples.yaw) },
        pitch: { samples: samples.pitch, fit: fitThroughOrigin(samples.pitch) },
        forward: { samples: samples.forward, fit: fitThroughOrigin(samples.forward) },
        limits: { ...CALIBRATION_LIMITS },
      };
      const quality = aggregateCalibrationQuality(record, projections, closure, finalClosure);
      result.calibration = {
        context,
        record,
        profile: NAVIGATION_CALIBRATION_PROFILE,
        quality: { status: quality.status, reasons: quality.reasons, axes: quality.axes },
        projectionQuality: quality.projection,
        restoreClosure: closure,
        restoreClosureQuality: quality.closure,
        finalClosure,
        guideDelta: {
          initialOffSha256: guideOff.sha256,
          initialOnSha256: result.captures.guideOn?.sha256,
          repeatedAfterAcquisition,
        },
        cameraCalibrationProof: cameraProof.proof,
      };
      if (quality.status !== "accepted" || validateNavigationCalibration(record, context).status !== "valid") {
        result.calibrationStatus = "quality_rejected";
        result.refusalReason = "quality_rejected";
        throw new NavigationTargetStop("unsupported_backend", `calibration quality rejected: ${quality.reasons.join(", ") || "record validation"}`);
      }
      publishCalibration = { record, payload: result.calibration };
      result.stopReason = "objective_satisfied";
      result.executionStatus = "completed";
    } else {
      let approachProven = false;
      let pendingApproach: { areaFraction: number; depthM: number } | null = null;
      while (true) {
        const observedGuide = controllerGuide(measured.guide, cameraProof.proof.calibration);
        const intent = decideNavigationStep(controllerState, { guide: observedGuide }, approachCalibration);
        for (const claim of intent.achievedClaims) {
          if (claim !== "free_camera_approached" || approachProven) claims.add(claim);
        }
        if (observedGuide) {
          controllerState.lastError = observedGuide.error;
        }
        let action: RelativeCameraAction;
        let actionAudit: NavigationControlAudit;
        if (intent.kind === "drag") {
          controllerState.phase = intent.mode === "search_horizontal" ? "acquire" : "center";
          if (intent.mode === "center" && acceptedCalibrationRecord && measured.guide) {
            const angular = angularObservation(measured.guide, cameraProof.proof.calibration);
            const raw = {
              dxPx: -angular.yawDeg / acceptedCalibrationRecord.yaw.fit.slope,
              dyPx: -angular.pitchDeg / acceptedCalibrationRecord.pitch.fit.slope,
            };
            const desired = { dxPx: raw.dxPx * intent.gain, dyPx: raw.dyPx * intent.gain };
            const remaining = Math.max(0, input.motionPolicy.maxCumulativeDragPx - controllerState.cumulativeDragPx);
            const cap = Math.min(input.motionPolicy.maxDragPxPerAction, remaining);
            const magnitude = Math.hypot(desired.dxPx, desired.dyPx);
            if (!(cap > 0) || !(magnitude > 0) || !Number.isFinite(magnitude)) {
              throw new NavigationTargetStop("budget_exhausted", "calibrated centering cannot form a bounded drag");
            }
            const scale = Math.min(1, cap / magnitude);
            const roundedDx = Math.round(desired.dxPx * scale);
            const roundedDy = Math.round(desired.dyPx * scale);
            const dxPx = roundedDx === 0 ? 0 : roundedDx;
            const dyPx = roundedDy === 0 ? 0 : roundedDy;
            if (dxPx === 0 && dyPx === 0) throw new NavigationTargetStop("budget_exhausted", "calibrated centering rounded to zero");
            action = { kind: "look_drag", dxPx, dyPx };
            actionAudit = auditAction(raw, intent.gain, action);
          } else {
            action = { kind: "look_drag", dxPx: intent.dxPx, dyPx: intent.dyPx };
            actionAudit = auditAction(
              { dxPx: intent.dxPx / intent.gain, dyPx: intent.dyPx / intent.gain },
              intent.gain,
              action,
            );
          }
        } else if (intent.kind === "hold") {
          if (approachCalibration.status !== "valid" || !acceptedCalibrationRecord || !storedCalibration) {
            throw new NavigationTargetStop("unsupported_backend", "approach is disabled until exact-context calibration is valid");
          }
          const replay = await validateStoredCalibrationReceipt(storedCalibration, context, deps);
          if (replay.status !== "valid") {
            result.calibrationStatus = replay.status;
            result.calibrationReasonCode = replay.reasonCode ?? null;
            result.refusalReason = replay.status;
            approachCalibration = { status: "invalid" };
            throw new NavigationTargetStop("unsupported_backend", `approach calibration became ${replay.status}: ${replay.detail}`);
          }
          acceptedCalibrationRecord = replay.record;
          controllerState.phase = "approach";
          const projection = measured.guide ? projectGuide(measured.guide, cameraProof.proof.calibration) : null;
          if (!measured.guide || projection?.status !== "accepted") {
            throw new NavigationTargetStop("guide_not_acquired", "guide projection was invalid before W input");
          }
          pendingApproach = { areaFraction: measured.guide.areaFraction, depthM: projection.depthM };
          const desiredDepthM = projection.depthM
            * Math.sqrt(measured.guide.areaFraction / input.targetAreaFraction.min);
          const desiredDisplacementM = Math.max(0, projection.depthM - desiredDepthM);
          const rawHoldMs = Math.ceil(desiredDisplacementM / acceptedCalibrationRecord.forward.fit.slope);
          const remaining = Math.max(0, input.motionPolicy.maxCumulativeHoldMs - controllerState.cumulativeHoldMs);
          const appliedHoldMs = Math.floor(Math.min(rawHoldMs, input.motionPolicy.maxHoldMsPerAction, remaining));
          if (!(appliedHoldMs > 0)) throw new NavigationTargetStop("budget_exhausted", "calibrated approach cannot form a bounded W hold");
          action = { kind: "key_hold", key: "w", holdMs: appliedHoldMs };
          actionAudit = auditAction({ key: "w", holdMs: rawHoldMs }, 1, action);
        } else if (intent.kind === "calibration_required") {
          throw new NavigationTargetStop(
            "unsupported_backend",
            approachCalibrationDetail ?? "approach is disabled until exact-context calibration is valid",
          );
        } else if (intent.kind === "requery") {
          const refreshed = await queryAndSelectScene(input, deps, scene!);
          rememberScene(refreshed);
          if (!refreshed.crossQueryDrift?.withinPolicy) {
            throw new NavigationTargetStop("scene_drift", `scene geometry drifted while checking ${intent.reason}`);
          }
          if (intent.reason === "guide_disappeared") {
            throw new NavigationTargetStop("guide_not_acquired", "guide disappeared while scene geometry remained stable");
          }
          result.refusalReason = "projection_divergence";
          throw new NavigationTargetStop(
            "unsupported_backend",
            `guide projection diverged while scene geometry remained stable: ${intent.reason}`,
          );
        } else if (intent.kind === "stop") {
          if (intent.reason !== "objective_satisfied") throw new NavigationTargetStop(intent.reason, `navigation controller stopped: ${intent.reason}`);
          break;
        } else {
          throw new NavigationTargetStop("cleanup_failed", "navigation controller entered cleanup before terminal settlement");
        }
        const step = await execution.executeStep([action]);
        bindControlAudit(step, [actionAudit]);
        measured = await observeStep(step, action, false);
        if (measured.guide) controllerState.areaHistory.push(measured.guide.areaFraction);
        if (action.kind === "key_hold" && action.key === "w") {
          const projection = measured.guide ? projectGuide(measured.guide, cameraProof.proof.calibration) : null;
          if (approachCalibration.status === "valid" && step.actionReceipts[0]?.status === "applied" && pendingApproach
            && measured.guide && projection?.status === "accepted"
            && measured.guide.areaFraction > pendingApproach.areaFraction && projection.depthM < pendingApproach.depthM) {
            approachProven = true;
          }
          pendingApproach = null;
        }
      }
      sealRoute();
      result.stopReason = "objective_satisfied";
      result.executionStatus = "completed";
    }
  } catch (error: any) {
    sealRoute();
    if (error instanceof NavigationTargetStop) {
      setTerminal(error.reason, error.message);
      if ((error as any).selectorReceipt) {
        result.target.selectorReceipt = (error as any).selectorReceipt;
        const output = (error as any).output as z.infer<typeof querySceneAnchorsOutputSchema> | undefined;
        if (output) {
          result.applicationRuntimeBinding = output.applicationRuntimeBinding as ApplicationRuntimeBinding | null;
          result.target.snapshotId = output.snapshotId;
        }
      }
    } else {
      result.executionStatus = "error";
      const detail = error?.message ?? String(error);
      result.primaryError = { code: "unexpected_exception", detail };
      setTerminal("binding_failed", detail);
    }
  } finally {
    if (guideMayHaveApplied) {
      result.cleanup.attempted = true;
      if (session && scene && finalHideNeeded) {
        try {
          const diagnostic = await capture("final-diagnostic");
          const observed = await immutableGuideMeasurement(diagnostic, input, deps);
          if (observed.guide && attemptedGeneration === settledGeneration) {
            result.captures.finalDiagnostic = diagnostic;
          } else if (terminalReason === null) {
            setTerminal("guide_not_acquired", observed.guide
              ? "last action did not have a settled post-action diagnostic generation"
              : "fresh final diagnostic did not contain a valid guide");
          }
        } catch (error: any) {
          if (terminalReason === null) {
            setTerminal(error instanceof NavigationTargetStop ? error.reason : "unsettled", error?.message ?? String(error));
          }
        }
      }
      if (finalHideNeeded && scene) {
        try {
          result.cleanup.hideTransactions++;
          const hide = await deps.requestGuide(guideRequestFor(input, scene, deps.randomId(), "hide"));
          result.guideTransitions.hide = hide;
          result.guideTransitions.transactions.push(hide);
          result.cleanup.guideHide = hide;
          if (hide.cleanupProven && hide.terminalGuideState === "hidden") {
            finalHideNeeded = false;
            hiddenProof = hide;
          } else {
            setTerminal("cleanup_failed", hide.ok ? "guide HIDE lacked exact hidden cleanup proof" : hide.detail);
          }
        } catch (error: any) {
          setTerminal("cleanup_failed", `guide HIDE transaction failed: ${error?.message ?? String(error)}`);
        }
      } else if (hiddenProof) {
        result.cleanup.guideHide = hiddenProof;
      }
      if (session && scene) {
        result.cleanup.finalCleanAttempted = true;
        try {
          result.captures.finalClean = await capture("final-clean", result.captures.finalDiagnostic?.sha256 ?? undefined);
        } catch (error: any) {
          setTerminal(error instanceof NavigationTargetStop
            && (error.reason === "host_window_occluded" || error.reason === "host_window_unavailable"
              || error.reason === "budget_exhausted")
              ? error.reason : "cleanup_failed", error instanceof Error ? error.message : String(error));
        }
      }
      if (result.cleanup.guideHide?.cleanupProven === true
        && result.cleanup.guideHide.terminalGuideState === "hidden"
        && result.captures.finalDiagnostic?.status === "settled"
        && result.captures.finalClean?.status === "settled") {
        result.sameViewEvidence = "no_backend_action_requested";
      }
    }
  }

  if (terminalReason) {
    if (result.executionStatus !== "error") result.executionStatus = "stopped";
    result.stopReason = terminalReason;
    result.error = { code: terminalReason, detail: terminalDetail ?? terminalReason };
  }
  result.achievedClaims = claimOrder(claims);
  if (!terminalReason && publishCalibration && session) {
    try {
      const receiptPath = path.join(session.absoluteRoot, `navigation-calibration-${publishCalibration.record.contextKey}.json`);
      const receiptRef = await deps.writeImmutableJson(receiptPath, {
        kind: "pico.navigation-calibration-receipt",
        schemaVersion: 1,
        createdAt: deps.now(),
        calibration: publishCalibration.payload,
        actions: result.actions,
        captures: result.captures,
        sceneQueries: result.sceneQueries,
        hostWindowFocusRequest: result.hostWindowFocusRequest,
        hostWindowProbe: result.hostWindowProbe,
        hostWindowProbes: result.hostWindowProbes,
        evidenceCeiling: "structural",
      });
      const registry = await deps.writeCalibrationRecord(publishCalibration.record.contextKey, publishCalibration.record, receiptRef);
      result.calibration!.receiptRef = receiptRef;
      result.calibration!.registry = registry;
      result.calibrationStatus = "written";
    } catch (error: any) {
      result.executionStatus = "stopped";
      result.stopReason = "cleanup_failed";
      result.error = { code: "cleanup_failed", detail: `calibration publication failed: ${error?.message ?? String(error)}` };
      result.calibrationStatus = "quality_rejected";
    }
  }
  return result;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function writeImmutableJsonFile(artifactPath: string, payload: unknown): NavigationArtifactRef {
  const absolute = assertExternalCapturePath(artifactPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(payload), null, 2)}\n`, "utf8");
  fs.writeFileSync(absolute, bytes, { flag: "wx", mode: 0o600 });
  const exact = fs.readFileSync(absolute);
  if (!exact.equals(bytes)) throw new Error("immutable navigation artifact changed during publication");
  return { path: fs.realpathSync(absolute), sha256: sha256Bytes(exact), bytes: exact.length };
}

function calibrationRegistryPath(contextKey: string): string {
  return path.join(os.homedir(), ".pico-mcp", "navigation-calibrations", "v1", `${contextKey}.json`);
}

export async function readNavigationCalibrationReceiptBytes(
  ref: NavigationArtifactRef,
  injected: {
    lstat(path: string): Promise<fs.Stats>;
    readFile(path: string): Promise<Buffer>;
  } = fs.promises,
): Promise<Buffer> {
  if (!exactKeys(ref, ["path", "sha256", "bytes"])
    || typeof ref.path !== "string" || !path.isAbsolute(ref.path)
    || !/^[a-f0-9]{64}$/.test(ref.sha256)
    || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
    throw new Error("navigation calibration receipt reference is invalid");
  }
  const before = await injected.lstat(ref.path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("navigation calibration receipt must be an exact regular file, not a symlink");
  }
  const bytes = await injected.readFile(ref.path);
  const after = await injected.lstat(ref.path);
  if (!after.isFile() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || after.size !== ref.bytes
    || bytes.length !== ref.bytes || sha256Bytes(bytes) !== ref.sha256) {
    throw new Error("navigation calibration receipt regular-file bytes, size, or SHA-256 changed");
  }
  return bytes;
}

function defaultNavigationTargetDependencies(): NavigationTargetDependencies {
  const adb = resolveAdb();
  return {
    querySceneAnchors: executeLiveQuerySceneAnchors,
    readArtifact: (artifactPath) => fs.promises.readFile(artifactPath),
    readCalibrationReceipt: (ref) => readNavigationCalibrationReceiptBytes(ref),
    bindQemuWindow: (serial) => bindMacQemuWindow(adb, serial),
    focusQemuWindow: frontmostQemu,
    probeHostWindow,
    reserveArtifactSession: async (outDir, runId, ownerNonceHash) => {
      const absoluteRoot = assertExternalCapturePath(outDir);
      fs.mkdirSync(path.dirname(absoluteRoot), { recursive: true, mode: 0o700 });
      fs.mkdirSync(absoluteRoot, { recursive: false, mode: 0o700 });
      const marker = path.join(absoluteRoot, ".pico-navigation-session.json");
      fs.writeFileSync(marker, `${JSON.stringify({ runId, ownerNonceHash })}\n`, { flag: "wx", mode: 0o600 });
      return { runId, absoluteRoot: fs.realpathSync(absoluteRoot), ownerNonceHash };
    },
    captureSettled: (input, context) => executeLiveCaptureSettled(input, {
      adbPath: adb, attemptTimeoutMs: ROUTE_CAPTURE.attemptTimeoutMs, hostWindowBinding: context?.hostWindowBinding,
    }),
    requestGuide: (input) => requestAgentBridgeNavigationGuide(adb, input),
    detectColorKeys: analyzeColorKeys,
    readCameraCalibrationProof: (serial, expectedBootId) => readFreshCameraCalibrationProof({
      adbPath: adb,
      serial,
      expectedBootId,
    }),
    readCalibrationRecord: async (contextKey) => {
      try {
        const registryPath = calibrationRegistryPath(contextKey);
        const registryStat = await fs.promises.lstat(registryPath);
        if (!registryStat.isFile() || registryStat.isSymbolicLink()
          || path.resolve(await fs.promises.realpath(registryPath)) !== path.resolve(registryPath)) {
          throw new Error("navigation calibration registry is not an exact regular file");
        }
        const decoded = JSON.parse(await fs.promises.readFile(registryPath, "utf8")) as NavigationCalibrationRegistryEnvelope;
        return decoded;
      } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    writeImmutableJson: async (artifactPath, payload) => writeImmutableJsonFile(artifactPath, payload),
    writeCalibrationRecord: async (contextKey, record, receiptRef) => {
      const registryPath = calibrationRegistryPath(contextKey);
      const registryDirectory = path.dirname(registryPath);
      fs.mkdirSync(registryDirectory, { recursive: true, mode: 0o700 });
      const temporary = path.join(registryDirectory, `.${contextKey}.${crypto.randomUUID()}.tmp`);
      const bytes = Buffer.from(`${JSON.stringify(canonicalize({
        schemaVersion: 1,
        contextKey,
        record,
        receiptRef,
      }), null, 2)}\n`, "utf8");
      try {
        fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        const staged = fs.readFileSync(temporary);
        if (!staged.equals(bytes)) throw new Error("navigation calibration registry staging bytes changed");
        fs.renameSync(temporary, registryPath);
      } finally {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
      }
      return { path: fs.realpathSync(registryPath), contextKey };
    },
    createActionAdapter: (serial, binding) => createBoundCameraActionAdapter(serial, binding, {
      revalidateWindow: () => bindMacQemuWindow(adb, serial),
    }),
    sampleContinuity: (binding) => sampleApplicationContinuity({
      adbPath: adb,
      binding,
      probe: {
        sessionId: crypto.createHash("sha256").update(`${binding.packageName}:${binding.pid}:${binding.bootId}`).digest("hex").slice(0, 32),
        generation: 1,
        priorSeq: null,
      },
      watchdogPrior: null,
    }, {
      runText: run,
      readLogLines: async () => ({ lines: [], truncated: false }),
      monotonicNs: () => process.hrtime.bigint(),
    }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    monotonicNs: () => process.hrtime.bigint(),
    now: () => new Date().toISOString(),
    randomId: () => crypto.randomUUID().replaceAll("-", ""),
  };
}

export function registerNavigationTargetTools(server: McpServer) {
  server.registerTool(
    "navigate_to_scene_target",
    {
      description:
        "Select one fresh largest-horizontal scene target on macOS, bind its exact runtime and qemu window, request focus, then probe visibility before bounded guide acquisition/calibration/navigation through settled shared camera routes. Output remains structural and every returned diagnostic requires an explicit LOOK.",
      inputSchema: navigationTargetToolInputSchema,
    },
    async (candidate: unknown) => {
      const input = navigateToSceneTargetInputSchema.parse(candidate);
      const result = await executeNavigateToSceneTarget(input);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        ...(result.executionStatus === "error" ? { isError: true } : {}),
      };
    },
  );
}
