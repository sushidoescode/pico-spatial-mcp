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
  type BoundQemuWindow,
  type QemuWindowBindingResult,
} from "./cameradrive.js";
import { resolveAdb } from "./emulatorlook.js";
import { analyzeColorKeys, type AuthoredColor, type ColorKeyMeasurements } from "./eye.js";
import {
  readFreshCameraCalibrationProof,
  type FreshCameraCalibrationProofResult,
} from "./metricverify.js";
import {
  estimateRelativeRouteDurationMs,
  executeRelativeCameraRoute,
  type BoundApplicationIdentity,
  type BoundRelativeRouteInput,
  type RelativeCameraAction,
  type RelativeRouteTrace,
  type ReservedArtifactSession,
  type RuntimeBindingReceipt,
} from "./navigation.js";
import {
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
const sharedInput = {
  serial: z.string().min(1),
  scenario: scenarioSchema,
  target: targetSchema,
  objective: z.literal("inspect"),
  fiducial: fiducialSchema,
  centerBandPx: z.object({ x: finite.nonnegative(), y: finite.nonnegative() }).strict(),
  targetAreaFraction: z.object({ min: finite.positive().max(1), max: finite.positive().max(1) }).strict()
    .refine((value) => value.min <= value.max, "target area min must not exceed max"),
  motionPolicy: motionPolicySchema,
  outDir: z.string().refine(path.isAbsolute, "outDir must be absolute"),
};

export const navigateToSceneTargetInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("calibrate"), ...sharedInput }).strict(),
  z.object({ action: z.literal("navigate"), ...sharedInput }).strict(),
]);

export type NavigateToSceneTargetInput = z.infer<typeof navigateToSceneTargetInputSchema>;
export type NavigationTargetStopReason =
  | "objective_satisfied"
  | "ambiguous_target"
  | "label_absent"
  | "guide_not_acquired"
  | "unsettled"
  | "scene_drift"
  | "budget_exhausted"
  | "ambiguous_host_window"
  | "unsupported_backend"
  | "input_failed"
  | "binding_failed"
  | "cleanup_failed";
export type NavigationTargetClaim = "target_visible" | "target_centered" | "free_camera_approached";
export type NavigationCalibrationStatus = "not_attempted" | "missing" | "stale" | "quality_rejected" | "valid" | "written";
export type NavigationRefusalReason = "insufficient_budget" | "missing" | "stale" | "quality_rejected" | null;

export interface NavigationArtifactRef {
  path: string;
  sha256: string;
  bytes: number;
}

export interface NavigationTargetDependencies {
  querySceneAnchors(input: QuerySceneAnchorsInput): Promise<Record<string, unknown>>;
  readArtifact(path: string): Promise<Buffer>;
  bindQemuWindow(serial: string): Promise<QemuWindowBindingResult>;
  reserveArtifactSession(outDir: string, runId: string, ownerNonceHash: string): Promise<ReservedArtifactSession>;
  captureSettled(input: CaptureSettledInput): Promise<{ receipt: CaptureSettledReceipt; frame: Buffer | null }>;
  requestGuide(input: AgentBridgeNavigationGuideRequestInput): Promise<AgentBridgeNavigationGuideRequestResult>;
  detectColorKeys(path: string, authored: AuthoredColor[]): Promise<ColorKeyMeasurements>;
  readCameraCalibrationProof(serial: string, expectedBootId: string): Promise<FreshCameraCalibrationProofResult>;
  readCalibrationRecord(contextKey: string): Promise<NavigationCalibrationRecord | null>;
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
const GUIDE_MAX_POLLS = 3;
const GUIDE_TRANSACTION_RESERVE_MS = 80_000;
const DIRECT_SETTLED_CAPTURE_RESERVE_MS = 90_000;
const CLEANUP_RESERVE_MS = 180_000;
const INITIAL_GUIDE_DELTA_RESERVE_MS = 2 * DIRECT_SETTLED_CAPTURE_RESERVE_MS + GUIDE_TRANSACTION_RESERVE_MS;
const REACQUIRED_GUIDE_DELTA_RESERVE_MS = 2 * DIRECT_SETTLED_CAPTURE_RESERVE_MS + 2 * GUIDE_TRANSACTION_RESERVE_MS;
const CALIBRATION_NON_ROUTE_RESERVE_MS = INITIAL_GUIDE_DELTA_RESERVE_MS + REACQUIRED_GUIDE_DELTA_RESERVE_MS;
const CALIBRATION_LIMITS = { minSamples: 4, maxRmse: 0.5, maxAbsResidual: 1, minRSquared: 0.95 } as const;
const MIN_ANGULAR_SLOPE_DEG_PER_PX = 0.01;
const MIN_FORWARD_SLOPE_M_PER_MS = 0.0005;
const MAX_PROJECTION_RELATIVE_ERROR = 0.12;
const MAX_ANGULAR_RESTORE_RESIDUAL_DEG = 0.5;
const MAX_FORWARD_RESTORE_RESIDUAL_M = 0.05;
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

function sceneQueryInput(input: NavigateToSceneTargetInput): QuerySceneAnchorsInput {
  return {
    serial: input.serial,
    scenario: input.scenario,
    labels: [input.target.label],
    maxRetries: 2,
    pollMs: 10,
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
  input: NavigateToSceneTargetInput,
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
      output.status === "binding_failed" ? "binding_failed" : "unsupported_backend",
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
  input: NavigateToSceneTargetInput,
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
  return {
    yawDeg: Math.atan((guide.center.x - calibration.cx) / calibration.f) * 180 / Math.PI,
    pitchDeg: Math.atan((calibration.cy - guide.center.y) / calibration.f) * 180 / Math.PI,
  };
}

function guideRequestFor(
  input: NavigateToSceneTargetInput,
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

function newResult(input: NavigateToSceneTargetInput) {
  return {
    executionStatus: "stopped" as "completed" | "stopped" | "error",
    action: input.action,
    achievedClaims: [] as NavigationTargetClaim[],
    stopReason: null as NavigationTargetStopReason | null,
    calibrationStatus: "not_attempted" as NavigationCalibrationStatus,
    refusalReason: null as NavigationRefusalReason,
    applicationRuntimeBinding: null as ApplicationRuntimeBinding | null,
    target: {
      snapshotId: null as string | null,
      traceId: null as string | null,
      runtimeUuid: null as string | null,
      selectorReceipt: { candidates: [] } as Record<string, any>,
    },
    qemuBinding: null as BoundQemuWindow | null,
    sceneQueries: [] as Record<string, any>[],
    guideTransitions: {
      show: null as AgentBridgeNavigationGuideRequestResult | null,
      hide: null as AgentBridgeNavigationGuideRequestResult | null,
      transactions: [] as AgentBridgeNavigationGuideRequestResult[],
    },
    routeTraces: [] as RelativeRouteTrace[],
    actions: [] as Array<{ seq: number; request: RelativeCameraAction; ack: unknown; settle: CaptureSettledReceipt }>,
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
  input: NavigateToSceneTargetInput,
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
      recoveryReserveMs: Math.min(CLEANUP_RESERVE_MS, maxDurationMs),
    },
    capture: { ...ROUTE_CAPTURE },
  };
}

function calibrationScheduleFitsPolicy(input: NavigateToSceneTargetInput): boolean {
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
) {
  const axes = {
    yaw: calibrationQuality(record.yaw.fit, record.limits),
    pitch: calibrationQuality(record.pitch.fit, record.limits),
    forward: calibrationQuality(record.forward.fit, record.limits),
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
  if (closure.yaw.some((value) => Math.abs(value) > MAX_ANGULAR_RESTORE_RESIDUAL_DEG)) reasons.push("yaw_restore_closure");
  if (closure.pitch.some((value) => Math.abs(value) > MAX_ANGULAR_RESTORE_RESIDUAL_DEG)) reasons.push("pitch_restore_closure");
  if (closure.forward.some((value) => Math.abs(value) > MAX_FORWARD_RESTORE_RESIDUAL_M)) reasons.push("forward_restore_closure");
  return {
    status: reasons.length ? "rejected" as const : "accepted" as const,
    reasons,
    axes,
    projection: projected,
  };
}

/**
 * Complete fakeable target-navigation action. Motion is admitted and executed exclusively by one
 * executeRelativeCameraRoute invocation; its async controller consumes the preceding settled
 * waypoint, immutable detector result, and fresh scene re-query before choosing another action.
 */
export async function executeNavigateToSceneTarget(
  rawInput: NavigateToSceneTargetInput,
  deps: NavigationTargetDependencies = defaultNavigationTargetDependencies(),
): Promise<Record<string, any>> {
  const input = navigateToSceneTargetInputSchema.parse(rawInput);
  const result = newResult(input);
  const claims = new Set<NavigationTargetClaim>();
  const operationStartedAt = deps.monotonicNs();
  let scene: SelectedScene | null = null;
  let qemu: BoundQemuWindow | null = null;
  let session: ReservedArtifactSession | null = null;
  let guideMayHaveApplied = false;
  let guideCompensated = false;
  let finalHideNeeded = false;
  let lastVisibleCapture: CaptureSettledReceipt | null = null;
  let publishCalibration: { record: NavigationCalibrationRecord; payload: Record<string, any> } | null = null;
  let terminalReason: NavigationTargetStopReason | null = null;
  let terminalDetail: string | null = null;

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
  const operationElapsedMs = () => {
    const now = deps.monotonicNs();
    if (now < operationStartedAt) return input.motionPolicy.maxDurationSec * 1000;
    return Number((now - operationStartedAt) / 1_000_000n);
  };
  const capture = async (name: string, priorSha256?: string): Promise<CaptureSettledReceipt> => {
    if (!session) throw new NavigationTargetStop("binding_failed", "artifact session was not reserved");
    const outPath = path.join(session.absoluteRoot, `${name}.png`);
    const captured = await deps.captureSettled({
      serial: input.serial,
      outPath,
      maxTries: ROUTE_CAPTURE.maxTries,
      intervalMs: ROUTE_CAPTURE.intervalMs,
      comparison: SETTLE_COMPARISON,
      ...(priorSha256 ? { priorSha256 } : {}),
    });
    const receipt = settledOrThrow(captured.receipt, name);
    if (!scene || !captureMatchesScene(receipt, scene)) {
      throw new NavigationTargetStop("binding_failed", `${name} capture runtime does not match the selected scene runtime`);
    }
    return receipt;
  };
  const setTerminal = (reason: NavigationTargetStopReason, detail: string) => {
    if (terminalReason === null || reason === "cleanup_failed") {
      terminalReason = reason;
      terminalDetail = detail;
    }
  };

  try {
    const initialScene = await queryAndSelectScene(input, deps, null);
    rememberScene(initialScene);

    const bound = await deps.bindQemuWindow(input.serial);
    if (!bound.ok) throw new NavigationTargetStop(bound.code, bound.detail);
    qemu = bound.binding;
    if (!exactQemuGeometry(qemu)) {
      throw new NavigationTargetStop("binding_failed", "qemu binding lacks exact measured x/y/width/height/scale geometry");
    }
    result.qemuBinding = qemu;

    const ownerNonceHash = crypto.createHash("sha256").update(deps.randomId()).digest("hex");
    const prospectiveSession: ReservedArtifactSession = {
      runId: deps.randomId(),
      absoluteRoot: assertExternalCapturePath(input.outDir),
      ownerNonceHash,
    };
    if (input.action === "calibrate") {
      const preflightInput = routeInput(
        input,
        initialScene,
        qemu,
        prospectiveSession,
        "0".repeat(64),
        input.motionPolicy.maxDurationSec * 1000,
      );
      const worstCaseGroups = [
        [{ kind: "look_drag", dxPx: input.motionPolicy.maxDragPxPerAction, dyPx: 0 } as RelativeCameraAction],
        ...CALIBRATION_SCHEDULE.map((step) => [step.action]),
      ];
      const estimatedRouteMs = estimateRelativeRouteDurationMs(preflightInput, worstCaseGroups);
      if (!calibrationScheduleFitsPolicy(input)
        || !Number.isFinite(estimatedRouteMs)
        || operationElapsedMs() + estimatedRouteMs + CALIBRATION_NON_ROUTE_RESERVE_MS
          > input.motionPolicy.maxDurationSec * 1000) {
        result.refusalReason = "insufficient_budget";
        throw new NavigationTargetStop(
          "budget_exhausted",
          "calibration budget cannot admit guide off/on, acquisition rebaseline, 24 settled trial/restore waypoints, and cleanup",
        );
      }
    }

    session = await deps.reserveArtifactSession(prospectiveSession.absoluteRoot, prospectiveSession.runId, ownerNonceHash);
    if (session.runId !== prospectiveSession.runId || session.ownerNonceHash !== ownerNonceHash
      || path.resolve(session.absoluteRoot) !== path.resolve(prospectiveSession.absoluteRoot)) {
      throw new NavigationTargetStop("binding_failed", "reserved artifact session does not match the requested external session identity");
    }

    const guideOff = await capture("guide-off");
    result.captures.guideOff = guideOff;
    const offMeasured = await immutableGuideMeasurement(guideOff, input, deps);
    if (!guideIsAbsent(offMeasured)) {
      throw new NavigationTargetStop("guide_not_acquired", "guide-off frame contains one or more authored guide colors");
    }

    const showRequestId = deps.randomId();
    guideMayHaveApplied = true;
    const show = await deps.requestGuide(guideRequestFor(input, scene!, showRequestId, "show"));
    result.guideTransitions.show = show;
    result.guideTransitions.transactions.push(show);
    if (!show.ok) {
      guideCompensated = show.actionReceipts.some((receipt) =>
        receipt.action === "navigation_guide_invalidation_broadcast" && receipt.status === "applied");
      if (guideCompensated) {
        result.cleanup.hideTransactions++;
        finalHideNeeded = false;
      } else {
        finalHideNeeded = true;
      }
      throw new NavigationTargetStop("guide_not_acquired", show.detail);
    }
    finalHideNeeded = true;

    let guideOn = await capture("guide-on", guideOff.sha256!);
    result.captures.guideOn = guideOn;
    let measured = await immutableGuideMeasurement(guideOn, input, deps);
    if (measured.guide) lastVisibleCapture = guideOn;
    if (guideOn.sha256 === guideOff.sha256) {
      throw new NavigationTargetStop("guide_not_acquired", "guide SHOW produced no exact off/on frame delta");
    }

    const application = scene!.output.applicationRuntimeBinding as ApplicationRuntimeBinding;
    const cameraProof = await deps.readCameraCalibrationProof(input.serial, application.liveIdentity.bootId);
    if (!cameraProof.ok) {
      result.calibrationStatus = cameraProof.code === "missing"
        ? "missing"
        : cameraProof.code === "stale" ? "stale" : "quality_rejected";
      result.refusalReason = result.calibrationStatus === "missing" || result.calibrationStatus === "stale"
        ? result.calibrationStatus
        : "quality_rejected";
      throw new NavigationTargetStop("unsupported_backend", `fresh camera calibration is unavailable: ${cameraProof.detail}`);
    }
    const context = calibrationContext(scene!, qemu, guideOn, cameraProof.proof);
    const contextKey = calibrationContextKey(context);
    let approachCalibration: { status: "valid" | "invalid" } = { status: "invalid" };
    if (input.action === "navigate") {
      const stored = await deps.readCalibrationRecord(contextKey);
      if (!stored) {
        result.calibrationStatus = "missing";
        result.refusalReason = "missing";
      } else {
        const validation = validateNavigationCalibration(stored, context);
        if (validation.status === "valid") {
          result.calibrationStatus = "valid";
          approachCalibration = { status: "valid" };
        } else {
          result.calibrationStatus = "stale";
          result.refusalReason = "stale";
        }
      }
    }

    const maximumDurationMs = input.motionPolicy.maxDurationSec * 1000;
    const remainingForRoute = maximumDurationMs - operationElapsedMs();
    if (remainingForRoute <= CLEANUP_RESERVE_MS) {
      throw new NavigationTargetStop("budget_exhausted", "whole-action deadline leaves no route plus cleanup budget");
    }
    const boundRouteInput = routeInput(input, scene!, qemu, session, guideOn.sha256!, remainingForRoute);
    if (input.action === "calibrate") {
      const remainingSchedule = [
        ...(measured.guide ? [] : [[{
          kind: "look_drag",
          dxPx: input.motionPolicy.maxDragPxPerAction,
          dyPx: 0,
        } as RelativeCameraAction]]),
        ...CALIBRATION_SCHEDULE.map((step) => [step.action]),
      ];
      const scheduleEstimateMs = estimateRelativeRouteDurationMs(boundRouteInput, remainingSchedule)
        + (measured.guide ? 0 : REACQUIRED_GUIDE_DELTA_RESERVE_MS);
      if (!Number.isFinite(scheduleEstimateMs) || scheduleEstimateMs > remainingForRoute) {
        result.refusalReason = "insufficient_budget";
        throw new NavigationTargetStop(
          "budget_exhausted",
          "remaining whole-action budget cannot safely admit the calibration route and acquisition rebaseline",
        );
      }
    }
    const adapter = deps.createActionAdapter(input.serial, qemu);
    let processedWaypointCount = 0;
    let waypointFileSequence = 0;
    let controllerReason: NavigationTargetStopReason | null = null;
    let controllerDetail = "controller stopped";
    let acquisitionPending = measured.guide === null;
    let repeatedAfterAcquisition = false;
    let calibrationStepIndex = 0;
    let approachProven = false;
    let pendingApproachBaseline: { areaFraction: number; depthM: number } | null = null;
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
    const controllerState: NavigationStepState = {
      centerBandPx: input.centerBandPx,
      targetAreaFraction: input.targetAreaFraction,
      motionPolicy: input.motionPolicy,
      actionCount: 0,
      elapsedMs: operationElapsedMs(),
      cumulativeDragPx: 0,
      cumulativeHoldMs: 0,
      phase: acquisitionPending ? "acquire" : "center",
      areaHistory: measured.guide ? [measured.guide.areaFraction] : [],
    };

    const repeatGuideDelta = async (
      priorVisible: CaptureSettledReceipt,
      decisionContext: { remainingMs(): number; signal: AbortSignal },
    ) => {
      if (!scene) throw new NavigationTargetStop("binding_failed", "scene binding disappeared before guide rebaseline");
      if (decisionContext.signal.aborted || decisionContext.remainingMs() < REACQUIRED_GUIDE_DELTA_RESERVE_MS) {
        throw new NavigationTargetStop("budget_exhausted", "whole-action deadline cannot admit the same-view guide rebaseline");
      }
      const intermediateHide = await deps.requestGuide(guideRequestFor(input, scene, deps.randomId(), "hide"));
      if (decisionContext.signal.aborted) throw new NavigationTargetStop("budget_exhausted", "guide rebaseline HIDE exceeded the route deadline");
      result.guideTransitions.transactions.push(intermediateHide);
      result.cleanup.hideTransactions++;
      if (!intermediateHide.ok) throw new NavigationTargetStop("cleanup_failed", intermediateHide.detail);
      finalHideNeeded = false;
      const rebaselineOff = await capture("guide-off-rebaseline", priorVisible.sha256!);
      if (decisionContext.signal.aborted) throw new NavigationTargetStop("budget_exhausted", "guide-off rebaseline capture exceeded the route deadline");
      result.captures.guideOffRebaseline = rebaselineOff;
      const rebaselineOffMeasured = await immutableGuideMeasurement(rebaselineOff, input, deps);
      if (!guideIsAbsent(rebaselineOffMeasured)) throw new NavigationTargetStop("guide_not_acquired", "guide persisted after rebaseline HIDE");
      const repeatedShow = await deps.requestGuide(guideRequestFor(input, scene, deps.randomId(), "show"));
      if (decisionContext.signal.aborted) throw new NavigationTargetStop("budget_exhausted", "repeated guide SHOW exceeded the route deadline");
      result.guideTransitions.transactions.push(repeatedShow);
      guideMayHaveApplied = true;
      if (!repeatedShow.ok) {
        guideCompensated = repeatedShow.actionReceipts.some((receipt) =>
          receipt.action === "navigation_guide_invalidation_broadcast" && receipt.status === "applied");
        if (guideCompensated) result.cleanup.hideTransactions++;
        else finalHideNeeded = true;
        throw new NavigationTargetStop("guide_not_acquired", repeatedShow.detail);
      }
      finalHideNeeded = true;
      const rebaselineOn = await capture("guide-on-rebaseline", rebaselineOff.sha256!);
      if (decisionContext.signal.aborted) throw new NavigationTargetStop("budget_exhausted", "guide-on rebaseline capture exceeded the route deadline");
      result.captures.guideOnRebaseline = rebaselineOn;
      const remeasured = await immutableGuideMeasurement(rebaselineOn, input, deps);
      if (!remeasured.guide || rebaselineOn.sha256 === rebaselineOff.sha256) {
        throw new NavigationTargetStop("guide_not_acquired", "repeated same-view guide off/on delta was not proven");
      }
      repeatedAfterAcquisition = true;
      guideOn = rebaselineOn;
      lastVisibleCapture = rebaselineOn;
      measured = remeasured;
      baseline = measurePose(measured);
    };

    const decide = async (waypoints: readonly any[], decisionContext: { remainingMs(): number; signal: AbortSignal }) => {
      try {
        if (decisionContext.signal.aborted) {
          controllerReason = "budget_exhausted";
          controllerDetail = "route decision deadline was aborted";
          return "stop" as const;
        }
        if (waypoints.length > processedWaypointCount) {
          const waypoint = waypoints.at(-1)!;
          const wasAcquisitionPending = acquisitionPending;
          processedWaypointCount = waypoints.length;
          const observed = await immutableGuideMeasurement(waypoint.settle, input, deps);
          measured = observed;
          if (observed.guide) lastVisibleCapture = waypoint.settle;
          if (wasAcquisitionPending) result.captures.acquisition.push(waypoint.settle);
          const previousScene = scene!;
          const refreshed = await queryAndSelectScene(input, deps, previousScene);
          rememberScene(refreshed);
          if (!refreshed.crossQueryDrift?.withinPolicy) {
            controllerReason = "scene_drift";
            controllerDetail = "scene geometry exceeded the cross-query drift policy";
            return "stop" as const;
          }

          if (input.action === "navigate"
            && waypoint.actions.length === 1
            && waypoint.actions[0].kind === "key_hold"
            && waypoint.actions[0].key === "w") {
            const receipt = waypoint.actionReceipts[0];
            const afterProjection = measured.guide
              ? projectGuide(measured.guide, cameraProof.proof.calibration)
              : null;
            if (approachCalibration.status === "valid"
              && receipt?.status === "applied"
              && pendingApproachBaseline
              && measured.guide
              && afterProjection?.status === "accepted"
              && measured.guide.areaFraction > pendingApproachBaseline.areaFraction
              && afterProjection.depthM < pendingApproachBaseline.depthM) {
              approachProven = true;
            }
            pendingApproachBaseline = null;
          }

          if (acquisitionPending) {
            if (!measured.guide) {
              controllerReason = "guide_not_acquired";
              controllerDetail = "guide was still absent after the bounded acquisition waypoint";
              return "stop" as const;
            }
            await repeatGuideDelta(waypoint.settle, decisionContext);
            acquisitionPending = false;
            controllerState.phase = "center";
          } else if (input.action === "calibrate") {
            const step = CALIBRATION_SCHEDULE[calibrationStepIndex - 1];
            if (!step || !measured.guide || !baseline) {
              controllerReason = "guide_not_acquired";
              controllerDetail = "calibration guide was lost at a settled waypoint";
              return "stop" as const;
            }
            const observedPose = measurePose(measured)!;
            if (step.kind === "trial") {
              const x = step.action.kind === "look_drag"
                ? step.axis === "yaw" ? step.action.dxPx : step.action.dyPx
                : step.action.holdMs;
              const y = step.axis === "yaw"
                ? observedPose.yawDeg - baseline.yawDeg
                : step.axis === "pitch"
                  ? observedPose.pitchDeg - baseline.pitchDeg
                  : baseline.depthM - observedPose.depthM;
              samples[step.axis].push({ x, y });
            } else {
              const residual = step.axis === "yaw"
                ? observedPose.yawDeg - baseline.yawDeg
                : step.axis === "pitch"
                  ? observedPose.pitchDeg - baseline.pitchDeg
                  : observedPose.depthM - baseline.depthM;
              closure[step.axis].push(residual);
              baseline = observedPose;
            }
          }

          controllerState.actionCount = waypoint.seq;
          controllerState.cumulativeDragPx = waypoints.reduce((sum: number, candidate: any) => sum
            + candidate.actions.reduce((inner: number, action: RelativeCameraAction) => inner
              + (action.kind === "look_drag" ? Math.hypot(action.dxPx, action.dyPx) : 0), 0), 0);
          controllerState.cumulativeHoldMs = waypoints.reduce((sum: number, candidate: any) => sum
            + candidate.actions.reduce((inner: number, action: RelativeCameraAction) => inner
              + (action.kind === "key_hold" ? action.holdMs : 0), 0), 0);
          controllerState.elapsedMs = maximumDurationMs - Math.max(0, decisionContext.remainingMs());
        }

        if (input.action === "calibrate") {
          if (acquisitionPending) {
            const intent = decideNavigationStep(controllerState, { guide: null }, { status: "invalid" });
            if (intent.kind !== "drag") {
              controllerReason = intent.kind === "stop" ? intent.reason : "guide_not_acquired";
              controllerDetail = "calibration acquisition could not admit a search action";
              return "stop" as const;
            }
            return [{ kind: "look_drag", dxPx: intent.dxPx, dyPx: intent.dyPx } as RelativeCameraAction];
          }
          if (calibrationStepIndex >= CALIBRATION_SCHEDULE.length) return "stop" as const;
          return [CALIBRATION_SCHEDULE[calibrationStepIndex++].action];
        }

        const intent = decideNavigationStep(
          controllerState,
          { guide: measured.guide },
          approachCalibration,
        );
        for (const claim of intent.achievedClaims) {
          if (claim !== "free_camera_approached" || approachProven) claims.add(claim);
        }
        if (measured.guide) {
          controllerState.areaHistory.push(measured.guide.areaFraction);
          controllerState.lastError = measured.guide.error;
        }
        const admitNavigationAction = (action: RelativeCameraAction): RelativeCameraAction[] | "stop" => {
          const actionGroups = [
            ...waypoints.map((waypoint: any) => waypoint.actions as RelativeCameraAction[]),
            [action],
          ];
          const nonRouteReserveMs = acquisitionPending ? REACQUIRED_GUIDE_DELTA_RESERVE_MS : 0;
          if (estimateRelativeRouteDurationMs(boundRouteInput, actionGroups) + nonRouteReserveMs
            > boundRouteInput.budgets.maxDurationMs) {
            controllerReason = "budget_exhausted";
            controllerDetail = "conservative whole-route estimate cannot admit another settled waypoint";
            return "stop";
          }
          return [action];
        };
        if (intent.kind === "drag") {
          controllerState.phase = intent.mode === "search_horizontal" ? "acquire" : "center";
          return admitNavigationAction({ kind: "look_drag", dxPx: intent.dxPx, dyPx: intent.dyPx });
        }
        if (intent.kind === "hold") {
          if (approachCalibration.status !== "valid") {
            controllerReason = "unsupported_backend";
            controllerDetail = "approach is disabled until exact-context calibration is valid";
            return "stop" as const;
          }
          controllerState.phase = "approach";
          const beforeProjection = measured.guide
            ? projectGuide(measured.guide, cameraProof.proof.calibration)
            : null;
          if (!measured.guide || beforeProjection?.status !== "accepted") {
            controllerReason = "guide_not_acquired";
            controllerDetail = "approach refused because the guide projection was invalid before W input";
            return "stop" as const;
          }
          pendingApproachBaseline = {
            areaFraction: measured.guide.areaFraction,
            depthM: beforeProjection.depthM,
          };
          return admitNavigationAction({ kind: "key_hold", key: "w", holdMs: intent.holdMs });
        }
        if (intent.kind === "calibration_required") {
          controllerReason = "unsupported_backend";
          controllerDetail = "approach is disabled until exact-context calibration is valid";
          return "stop" as const;
        }
        if (intent.kind === "requery") {
          controllerReason = intent.reason === "guide_disappeared" ? "guide_not_acquired" : "scene_drift";
          controllerDetail = `navigation controller requested re-query: ${intent.reason}`;
          return "stop" as const;
        }
        if (intent.kind === "stop") {
          controllerReason = intent.reason;
          controllerDetail = `navigation controller stopped: ${intent.reason}`;
          return "stop" as const;
        }
        controllerReason = "cleanup_failed";
        controllerDetail = "navigation controller entered cleanup state before terminal settlement";
        return "stop" as const;
      } catch (error: any) {
        if (error instanceof NavigationTargetStop) {
          controllerReason = error.reason;
          controllerDetail = error.message;
          return "stop" as const;
        }
        controllerReason = "binding_failed";
        controllerDetail = error?.message ?? String(error);
        return "stop" as const;
      }
    };

    const trace = await executeRelativeCameraRoute(boundRouteInput, decide, {
      applyRelativeAction: adapter.applyRelativeAction,
      sampleContinuity: () => deps.sampleContinuity({
        serial: application.serial,
        bootId: application.liveIdentity.bootId,
        packageName: application.packageName,
        apkSha256: application.apkSha256,
        pid: application.foregroundProcess.pid,
        pidStartTicks: application.foregroundProcess.pidStartTicks,
        allowedResumedComponents: [application.foregroundProcess.component],
      }),
      captureSettled: async (capturePath, context) => {
        if (context.remainingMs() <= 0) throw new Error("route capture deadline exhausted");
        const captured = await deps.captureSettled({
          serial: input.serial,
          outPath: capturePath,
          maxTries: ROUTE_CAPTURE.maxTries,
          intervalMs: ROUTE_CAPTURE.intervalMs,
          comparison: SETTLE_COMPARISON,
          priorSha256: context.priorSha256,
        });
        return captured.receipt;
      },
      allocateWaypointPath: () => path.join(session!.absoluteRoot, `waypoint-${String(++waypointFileSequence).padStart(4, "0")}.png`),
      sleep: deps.sleep,
      monotonicNs: deps.monotonicNs,
    });
    result.routeTraces.push(trace);
    result.actions = trace.waypoints.flatMap((waypoint) => waypoint.actions.map((request, index) => ({
      seq: waypoint.seq,
      request,
      ack: waypoint.actionReceipts[index],
      settle: waypoint.settle,
    })));
    if (trace.status !== "controller_stop") {
      throw new NavigationTargetStop(routeStopReason(trace), `shared camera route stopped with ${trace.status}`);
    }
    if (controllerReason && controllerReason !== "objective_satisfied") {
      throw new NavigationTargetStop(controllerReason, controllerDetail);
    }

    if (input.action === "navigate") {
      result.stopReason = "objective_satisfied";
      result.executionStatus = "completed";
    } else {
      const record: NavigationCalibrationRecord = {
        version: 1,
        contextKey,
        yaw: { samples: samples.yaw, fit: fitThroughOrigin(samples.yaw) },
        pitch: { samples: samples.pitch, fit: fitThroughOrigin(samples.pitch) },
        forward: { samples: samples.forward, fit: fitThroughOrigin(samples.forward) },
        limits: { ...CALIBRATION_LIMITS },
      };
      const quality = aggregateCalibrationQuality(record, projections, closure);
      result.calibration = {
        context,
        record,
        quality: { status: quality.status, reasons: quality.reasons, axes: quality.axes },
        projectionQuality: quality.projection,
        restoreClosure: closure,
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
    }
  } catch (error: any) {
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
      setTerminal("binding_failed", error?.message ?? String(error));
    }
  } finally {
    if (guideMayHaveApplied) {
      result.cleanup.attempted = true;
      result.captures.finalDiagnostic = lastVisibleCapture;
      if (finalHideNeeded && scene) {
        try {
          const hide = await deps.requestGuide(guideRequestFor(input, scene, deps.randomId(), "hide"));
          result.guideTransitions.hide = hide;
          result.guideTransitions.transactions.push(hide);
          result.cleanup.guideHide = hide;
          result.cleanup.hideTransactions++;
          finalHideNeeded = false;
          if (!hide.ok) setTerminal("cleanup_failed", hide.detail);
        } catch (error: any) {
          setTerminal("cleanup_failed", `guide HIDE transaction failed: ${error?.message ?? String(error)}`);
        }
      } else if (guideCompensated) {
        result.cleanup.guideHide = {
          ok: true,
          ack: undefined,
          actionReceipts: result.guideTransitions.show?.actionReceipts ?? [],
          evidenceCeiling: "structural",
          compensated: true,
        } as any;
      }
      if (session && scene) {
        result.cleanup.finalCleanAttempted = true;
        try {
          const prior = lastVisibleCapture?.sha256 ?? result.captures.guideOff?.sha256 ?? undefined;
          result.captures.finalClean = await capture("final-clean", prior ?? undefined);
        } catch (error: any) {
          setTerminal("cleanup_failed", error instanceof Error ? error.message : String(error));
        }
      }
      if (result.cleanup.guideHide?.ok === true
        && result.captures.finalDiagnostic?.status === "settled"
        && result.captures.finalClean?.status === "settled") {
        result.sameViewEvidence = "no_backend_action_requested";
      }
    }
  }

  if (terminalReason) {
    result.executionStatus = "stopped";
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
        evidenceCeiling: "structural",
      });
      const registry = await deps.writeCalibrationRecord(
        publishCalibration.record.contextKey,
        publishCalibration.record,
        receiptRef,
      );
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

function defaultNavigationTargetDependencies(): NavigationTargetDependencies {
  const adb = resolveAdb();
  return {
    querySceneAnchors: executeLiveQuerySceneAnchors,
    readArtifact: (artifactPath) => fs.promises.readFile(artifactPath),
    bindQemuWindow: (serial) => bindMacQemuWindow(adb, serial),
    reserveArtifactSession: async (outDir, runId, ownerNonceHash) => {
      const absoluteRoot = assertExternalCapturePath(outDir);
      fs.mkdirSync(path.dirname(absoluteRoot), { recursive: true, mode: 0o700 });
      fs.mkdirSync(absoluteRoot, { recursive: false, mode: 0o700 });
      const marker = path.join(absoluteRoot, ".pico-navigation-session.json");
      fs.writeFileSync(marker, `${JSON.stringify({ runId, ownerNonceHash })}\n`, { flag: "wx", mode: 0o600 });
      return { runId, absoluteRoot: fs.realpathSync(absoluteRoot), ownerNonceHash };
    },
    captureSettled: (input) => executeLiveCaptureSettled(input, { adbPath: adb, attemptTimeoutMs: ROUTE_CAPTURE.attemptTimeoutMs }),
    requestGuide: (input) => requestAgentBridgeNavigationGuide(adb, input),
    detectColorKeys: analyzeColorKeys,
    readCameraCalibrationProof: (serial, expectedBootId) => readFreshCameraCalibrationProof({
      adbPath: adb,
      serial,
      expectedBootId,
    }),
    readCalibrationRecord: async (contextKey) => {
      try {
        const decoded = JSON.parse(await fs.promises.readFile(calibrationRegistryPath(contextKey), "utf8"));
        return (decoded?.record ?? decoded) as NavigationCalibrationRecord;
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
    createActionAdapter: (serial, binding) => createBoundCameraActionAdapter(serial, binding),
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
        "Select one fresh largest-horizontal scene target, bind its exact runtime and qemu window, and run bounded guide acquisition/calibration/navigation through settled shared camera routes. Output remains structural and every returned diagnostic requires an explicit LOOK.",
      inputSchema: navigateToSceneTargetInputSchema,
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
