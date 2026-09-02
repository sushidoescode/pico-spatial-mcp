import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bindMacQemuWindow, createBoundCameraActionAdapter, type BoundQemuWindow } from "./cameradrive.js";
import {
  executeRelativeCameraRoute,
  ROUTE_FINALIZATION_RESERVE_MS,
  type BoundApplicationIdentity,
  type RelativeCameraAction,
  type RouteBudgets,
  type RuntimeBindingReceipt,
} from "./navigation.js";
import {
  assertExternalCapturePath,
  captureAdbFrame,
  executeCaptureSettled,
  resolveProspectivePath,
  SETTLE_COMPARISON,
  sha256Bytes,
  type CaptureLiveIdentity,
} from "./observation.js";
import { validateCaptureBuffer } from "./evidence.js";
import {
  APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS,
  collectLogWindow,
  parseBoundaryProbeLogRecordV1,
  scanPackageRuntimeHealth,
  sampleApplicationContinuity,
  type ApplicationContinuitySample,
  type PackageRuntimeHealthReceiptV1,
  type RuntimeLogSnapshotReceipt,
} from "./runtimecontinuity.js";
import { probeDeviceIdentity } from "./deviceidentity.js";
import { parseInstalledApkPath, parsePid, parseProcStartTicks, parseRemoteSha256 } from "./nativefleetreceipt.js";
import { canonicalJson } from "./runreceiptidentity.js";
import { readNativeRunReceipt } from "./runreceiptstore.js";
import { resolveAdb } from "./emulatorlook.js";
import { okJson, run, sleep } from "./util.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const GATES = [1, 2, 4, 8, 16, 32] as const;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAIMSIGHT_PHASE1_APK_SHA256 = "7ecce31ec0a5ede24c88e97e0aca2ec82dc467f0a639402661b5749ee5678bbf";
const JSON_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const LOG_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const APK_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const REVIEW_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_ACTIVE_RUNS = 32;
const RUN_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_EXPERIMENT_DURATION_MS = 18 * 60_000;
const LOG_WINDOW_MAX_DURATION_MS = 10 * 60_000;
const PREPARATION_VISUAL_SETTLE_MS = 8_000;
type RecoveryKind = "observe" | "reopen_stage" | "activity_launch" | "force_stop_relaunch";
type RecoveryAttributionKind = RecoveryKind | "activity_launch_ignored";
type BoundaryEntryRoute = "manifest_mixed" | "manifest_full" | "dynamic_full" | "editor_manifest_full";
const LOG_FINALIZATION_RESERVE_MS = 6_500;
const WAYPOINT_COVERAGE_MARKER_RESERVE_MS = 5_000;
const WAYPOINT_HEALTH_SNAPSHOT_RESERVE_MS = 12_000;
// Worst-case post-force-stop command/capture/continuity/marker/log-finalization envelopes. The
// destructive command is withheld unless the whole compensating relaunch path still fits.
const FORCE_STOP_STATIC_COMPLETION_RESERVE_MS = 185_000;
const FORCE_STOP_DYNAMIC_COMPLETION_RESERVE_MS = 215_000;
const RECOVERY_OBSERVE_EXECUTION_BUDGET_MS = 60_000;
const RECOVERY_REOPEN_EXECUTION_BUDGET_MS = 75_000;
const RECOVERY_ACTIVITY_EXECUTION_BUDGET_MS = 100_000;
// Marker + bounded settled capture (including start/end identity) + continuity sampling all run
// before the destructive guard. Keep their advertised worst-case 68 s below this fixed slice.
const RECOVERY_FORCE_PREAMBLE_BUDGET_MS = 75_000;

export function recoveryStepExecutionBudgetMs(entryRoute: BoundaryEntryRoute, kind: RecoveryKind): number {
  if (kind === "observe") return RECOVERY_OBSERVE_EXECUTION_BUDGET_MS;
  if (kind === "reopen_stage") {
    if (entryRoute !== "dynamic_full") throw new Error("only dynamic_full has a reopen_stage recovery budget");
    return RECOVERY_REOPEN_EXECUTION_BUDGET_MS;
  }
  if (kind === "activity_launch") return RECOVERY_ACTIVITY_EXECUTION_BUDGET_MS;
  if (kind === "force_stop_relaunch") {
    return RECOVERY_FORCE_PREAMBLE_BUDGET_MS + (entryRoute === "dynamic_full"
      ? FORCE_STOP_DYNAMIC_COMPLETION_RESERVE_MS
      : FORCE_STOP_STATIC_COMPLETION_RESERVE_MS);
  }
  throw new Error("unknown recovery kind");
}

function recoveryEnvelopeOrder(entryRoute: BoundaryEntryRoute): RecoveryKind[] {
  return entryRoute === "dynamic_full"
    ? ["observe", "reopen_stage", "activity_launch", "force_stop_relaunch"]
    : ["observe", "activity_launch", "force_stop_relaunch"];
}

export function minimumRecoveryReserveMs(entryRoute: BoundaryEntryRoute): number {
  return recoveryEnvelopeOrder(entryRoute)
    .reduce((total, kind) => total + recoveryStepExecutionBudgetMs(entryRoute, kind), 0);
}

export async function captureAfterPreparationVisualSettle<T>(
  capture: () => Promise<T>,
  pause: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  await pause(PREPARATION_VISUAL_SETTLE_MS);
  return capture();
}

const MIN_RECOVERY_RESERVE_MS = minimumRecoveryReserveMs("manifest_mixed");
const GENERATED_SCENARIOS = {
  manifest_mixed: {
    id: "boundarylab-mixed",
    packageName: "com.fleet.boundarylabmixed",
    variant: "manifest_mixed",
    stageStyle: "1",
    effectiveSpecSha256: "b6443a1a679845613c2d6b974f7b1546deafbcda600c6ee460109615631c49ca",
  },
  manifest_full: {
    id: "boundarylab-manifest-full",
    packageName: "com.fleet.boundarylabmanifestfull",
    variant: "manifest_full",
    stageStyle: "3",
    effectiveSpecSha256: "8cd9f0e6b2f5233e224e2d62c1ac706f5a8d7bf6ffc321a2017945cbeed46825",
  },
  dynamic_full: {
    id: "boundarylab-dynamic-full",
    packageName: "com.fleet.boundarylabdynamicfull",
    variant: "dynamic_full",
    stageStyle: "1",
    effectiveSpecSha256: "f8ffde4140793c953ef73bce6711a41207a4704ad9f50034b4eafa8dfbfca384",
  },
} as const;
const BOUNDARY_PREPARATION_OWNED_PACKAGES = new Set([
  ...Object.values(GENERATED_SCENARIOS).map((scenario) => scenario.packageName),
  "com.example.claimsight",
  "com.fleet.calib",
]);

const hashSchema = z.string().regex(SHA256);
const packageSchema = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
const componentSchema = z.string().min(3).max(512);
const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key_hold"), key: z.enum(["w", "a", "s", "d", "q", "e"]), holdMs: z.number().int().min(50).max(5_000) }).strict(),
  z.object({ kind: z.literal("look_drag"), dxPx: z.number().int(), dyPx: z.number().int() }).strict(),
]);
const waypointSchema = z.object({
  seq: z.number().int().positive(),
  targetGateM: z.union(GATES.map((gate) => z.literal(gate)) as [z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<4>, z.ZodLiteral<8>, z.ZodLiteral<16>, z.ZodLiteral<32>]),
  actions: z.array(actionSchema).min(1).max(4),
}).strict();
const replayRefSchema = z.object({
  absolutePath: z.string().min(1),
  routeScriptSha256: hashSchema,
  sourceRunManifestSha256: hashSchema,
  sourceAdjudicationSha256: hashSchema,
}).strict();
const routeSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("calibration_seed"), waypoints: z.array(waypointSchema).min(1).max(32) }).strict(),
  z.object({ kind: z.literal("replay"), calibrationRouteRef: replayRefSchema }).strict(),
]);
const budgetsSchema = z.object({
  maxActions: z.number().int().positive().max(256),
  maxWaypoints: z.number().int().positive().max(32),
  maxHoldMsPerAction: z.number().int().positive().max(5_000),
  maxDragPxPerAction: z.number().int().positive().max(2_048),
  maxCumulativeHoldMs: z.number().int().positive().max(300_000),
  maxCumulativeDragPx: z.number().int().positive().max(32_768),
  maxDurationMs: z.number().int().positive().max(MAX_EXPERIMENT_DURATION_MS),
  recoveryReserveMs: z.number().int().nonnegative().max(10 * 60_000),
}).strict().superRefine((value, context) => {
  if (value.recoveryReserveMs > value.maxDurationMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recoveryReserveMs"], message: "recovery reserve exceeds the route duration budget" });
  }
  if (value.recoveryReserveMs < MIN_RECOVERY_RESERVE_MS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recoveryReserveMs"], message: `recovery reserve must be at least ${MIN_RECOVERY_RESERVE_MS} ms for the bounded Phase-1 protocol` });
  }
});
const routeSchema = z.object({
  direction: z.enum(["forward", "backward", "left", "right"]),
  speedProfile: z.enum(["slow", "medium", "fast", "staircase"]),
  requiredTraversalM: z.literal(32),
  gateSequenceM: z.tuple([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)]),
  source: routeSourceSchema,
  budgets: budgetsSchema,
}).strict().superRefine((value, context) => {
  if (value.source.kind !== "calibration_seed") return;
  const sequences = value.source.waypoints.map((waypoint) => waypoint.seq);
  if (sequences.some((seq, index) => seq !== index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "waypoints"], message: "waypoint sequence must be contiguous from one" });
  }
  const targets = value.source.waypoints.map((waypoint) => waypoint.targetGateM);
  if (targets.some((target, index) => index > 0 && target <= targets[index - 1])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "waypoints"], message: "waypoint gates must increase strictly" });
  }
});
const dynamicEntrySchema = z.object({
  receiverComponent: componentSchema,
  action: z.string().min(1).max(256),
  stageId: z.string().min(1).max(64),
  requireSessionCapability: z.literal(true),
  expectedAcks: z.tuple([z.literal("command_received"), z.literal("stage_open_requested"), z.literal("stage_open_returned")]),
}).strict();
const scenarioSchema = z.object({
  id: z.string().min(1).max(128),
  packageName: packageSchema,
  launchComponent: componentSchema,
  allowedResumedComponents: z.array(componentSchema).min(1).max(16),
  entryRoute: z.enum(["manifest_mixed", "manifest_full", "dynamic_full", "editor_manifest_full"]),
  expectedManifestStageStyle: z.enum(["Mixed", "Full"]),
  requestedDynamicStageStyle: z.literal("Full").optional(),
  dynamicEntry: dynamicEntrySchema.optional(),
}).strict().superRefine((value, context) => {
  if (!value.launchComponent.startsWith(`${value.packageName}/`)
    || value.allowedResumedComponents.some((component) => !component.startsWith(`${value.packageName}/`))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["launchComponent"], message: "scenario components must belong to packageName" });
  }
  if (!value.allowedResumedComponents.includes(value.launchComponent)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedResumedComponents"], message: "launchComponent must be explicitly allowed" });
  }
  if (value.allowedResumedComponents.length !== 1 || value.allowedResumedComponents[0] !== value.launchComponent) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedResumedComponents"], message: "Phase-1 scenarios allow exactly the stable launch component" });
  }
  const expectedStyle = value.entryRoute === "manifest_mixed" || value.entryRoute === "dynamic_full" ? "Mixed" : "Full";
  if (value.expectedManifestStageStyle !== expectedStyle) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedManifestStageStyle"], message: "manifest style contradicts entryRoute" });
  }
  if (value.entryRoute === "dynamic_full" && !value.dynamicEntry) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dynamicEntry"], message: "dynamic_full requires an exact dynamicEntry" });
  }
  if (value.entryRoute !== "dynamic_full" && (value.dynamicEntry || value.requestedDynamicStageStyle)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dynamicEntry"], message: "only dynamic_full may declare dynamic entry state" });
  }
  if (value.entryRoute === "dynamic_full") {
    if (value.requestedDynamicStageStyle !== "Full") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestedDynamicStageStyle"], message: "dynamic_full must declare requestedDynamicStageStyle Full" });
    }
    if (value.dynamicEntry?.receiverComponent !== `${value.packageName}/.agent.BoundaryProbeReceiver`
      || value.dynamicEntry?.action !== `${value.packageName}.BOUNDARY_PROBE`
      || value.dynamicEntry?.stageId !== "dynamic-full") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["dynamicEntry"], message: "dynamic entry must use the exact generated same-package receiver, action, and stage" });
    }
  }
  if (value.entryRoute !== "editor_manifest_full") {
    const expected = GENERATED_SCENARIOS[value.entryRoute];
    if (value.id !== expected.id || value.packageName !== expected.packageName
      || value.launchComponent !== `${expected.packageName}/.platform.LaunchActivity`) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "generated scenario identity must match the stable Boundary Lab matrix" });
    }
  } else if (value.id !== "claimsight-e1"
    || value.packageName !== "com.example.claimsight"
    || value.launchComponent !== "com.example.claimsight/.platform.LaunchActivity") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "Phase-1 editor row is the exact claimsight-e1 CP0-qualified APK" });
  }
});
const provenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native_run_receipt"), receiptId: hashSchema, apkSha256: hashSchema }).strict(),
  z.object({ kind: z.literal("imported_apk"), apkPath: z.string().min(1), apkSha256: hashSchema, inventoryObservedAt: z.string().datetime({ offset: true }) }).strict(),
]);
const capturePolicySchema = z.object({
  maxTries: z.number().int().min(2).max(4),
  intervalMs: z.number().int().nonnegative().max(1_000),
  attemptTimeoutMs: z.number().int().positive().max(5_000),
  comparison: z.literal("byte_exact"),
}).strict();
const visibleStateSchema = z.enum([
  "boundarylab_mixed",
  "boundarylab_manifest_full",
  "boundarylab_dynamic_full",
  "claimsight_environment",
  "system_home",
  "black_or_inconclusive",
]);
const attestationSchema = z.object({
  captureSha256: hashSchema,
  visibleState: visibleStateSchema,
  sentinels: z.array(z.string().min(1).max(256)).max(64),
  witnessedGateM: z.union([z.literal(0), ...GATES.map((gate) => z.literal(gate))] as [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<4>, z.ZodLiteral<8>, z.ZodLiteral<16>, z.ZodLiteral<32>]).optional(),
  attestation: z.string().min(1).max(4_096),
}).strict();

const prepareSchema = z.object({
  action: z.literal("prepare"),
  serial: z.string().min(1).max(255),
  scenario: scenarioSchema,
  provenance: provenanceSchema,
  artifactRoot: z.string().min(1),
  route: routeSchema,
  capture: capturePolicySchema,
}).strict().superRefine((value, context) => {
  if (value.scenario.entryRoute === "editor_manifest_full" && value.provenance.kind !== "imported_apk") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance"], message: "editor_manifest_full requires imported_apk provenance" });
  }
  if (value.scenario.entryRoute !== "editor_manifest_full" && value.provenance.kind !== "native_run_receipt") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance"], message: "generated Boundary Lab rows require a native_run_receipt" });
  }
  if (value.scenario.entryRoute === "editor_manifest_full"
    && value.provenance.kind === "imported_apk"
    && value.provenance.apkSha256 !== CLAIMSIGHT_PHASE1_APK_SHA256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance", "apkSha256"], message: "Phase-1 E1 must use the exact CP0-qualified Claimsight APK" });
  }
  if (value.provenance.kind === "imported_apk"
    && (!path.isAbsolute(value.provenance.apkPath) || path.resolve(value.provenance.apkPath) !== value.provenance.apkPath)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance", "apkPath"], message: "imported APK path must be normalized and absolute" });
  }
  const sourceKind = value.route.source.kind;
  if (value.scenario.entryRoute === "manifest_mixed" && sourceKind !== "calibration_seed") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["route", "source"], message: "M0 is the sole calibration_seed row" });
  }
  if (value.scenario.entryRoute !== "manifest_mixed" && sourceKind !== "replay") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["route", "source"], message: "F1, F2, and E1 must replay an adjudicated M0 route" });
  }
  const requiredRecoveryReserveMs = minimumRecoveryReserveMs(value.scenario.entryRoute);
  if (value.route.budgets.recoveryReserveMs < requiredRecoveryReserveMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["route", "budgets", "recoveryReserveMs"],
      message: `${value.scenario.entryRoute} recovery requires ${requiredRecoveryReserveMs} ms so every ordered fallback retains its own deadline and force-stop compensation remains reachable`,
    });
  }
});
const stepSchema = z.object({ action: z.literal("step"), runId: hashSchema, reviewedPriorFrame: attestationSchema }).strict();
const adjudicateSchema = z.object({
  action: z.literal("adjudicate"), runId: hashSchema, scope: z.enum(["route", "recovery"]), frameAttestations: z.array(attestationSchema).max(64),
}).strict();
const recoverSchema = z.object({
  action: z.literal("recover"),
  runId: hashSchema,
  reviewedPriorFrame: attestationSchema.optional(),
}).strict();

export const boundaryExperimentInputSchema = z.union([prepareSchema, stepSchema, adjudicateSchema, recoverSchema]);
export type BoundaryExperimentInput = z.infer<typeof boundaryExperimentInputSchema>;
type PrepareInput = z.infer<typeof prepareSchema>;
type VisualFrameAttestation = z.infer<typeof attestationSchema>;
type BoundaryScenario = z.infer<typeof scenarioSchema>;
type BoundaryWaypointPlan = z.infer<typeof waypointSchema>;
type BoundaryRoute = z.infer<typeof routeSchema>;

export interface RequiredReviewItem {
  captureSha256: string;
  role: "home_reference" | "app_baseline" | "waypoint" | "transition" | "recovery";
  waypointSeq?: number;
  targetGateM?: 1 | 2 | 4 | 8 | 16 | 32;
  recoveryStep?: RecoveryKind;
  settled: boolean;
  path?: string;
}

export interface BoundaryCapture {
  role: RequiredReviewItem["role"];
  path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  settled: boolean;
  receipt: unknown;
}

export interface BoundaryPreparationResult {
  runtimeBinding: RuntimeBindingReceipt;
  applicationBinding: BoundApplicationIdentity;
  homeClearance: BoundarySystemHomeReceipt;
  homeReference: BoundaryCapture;
  appBaseline: BoundaryCapture;
  continuity: ApplicationContinuitySample[];
  logArtifact: unknown;
  runtimeHealth: PackageRuntimeHealthReceiptV1;
  probe: { sessionId: string | null; generation: number | null; capabilitySha256: string | null };
  privateRuntime?: unknown;
}

export interface BoundaryPreparationFailureEvidence {
  homeClearance?: BoundarySystemHomeReceipt;
  homeReference?: BoundaryCapture;
  appBaseline?: BoundaryCapture;
  continuity?: ApplicationContinuitySample[];
  logArtifact?: unknown | null;
  runtimeHealth?: PackageRuntimeHealthReceiptV1;
  structuralStop?: "preparation_failed" | "route_unsettled" | "binding_lost" | "app_lifecycle_loss" | "runtime_health_inconclusive" | "terminal_signal_candidate";
}

export class BoundaryPreparationFailure extends Error {
  readonly evidence: BoundaryPreparationFailureEvidence;

  constructor(message: string, evidence: BoundaryPreparationFailureEvidence = {}) {
    super(message);
    this.name = "BoundaryPreparationFailure";
    this.evidence = evidence;
  }
}

export interface BoundaryExperimentDependencies {
  randomBytes(size: number): Buffer;
  now(): string;
  monotonicNs(): bigint;
  readNativeRunReceipt: typeof readNativeRunReceipt;
  readReviewImage: typeof readBoundReviewImage;
  collectPreparation(context: Record<string, any>): Promise<BoundaryPreparationResult>;
  recaptureReviewedFrame(context: Record<string, any>): Promise<{ matches: boolean; sha256: string; continuity: ApplicationContinuitySample }>;
  executeWaypoint(context: Record<string, any>): Promise<{
    preflight: { matches: boolean; sha256: string; continuity: ApplicationContinuitySample } | null;
    routeTrace: Record<string, any>;
    capture: BoundaryCapture | null;
    continuity: ApplicationContinuitySample[];
    logArtifact: unknown | null;
    preflightLogArtifact?: RuntimeLogSnapshotReceipt | null;
    preflightRuntimeHealth?: PackageRuntimeHealthReceiptV1;
    runtimeHealth: PackageRuntimeHealthReceiptV1;
    captureError?: string;
    executionError?: string;
  }>;
  executeRecoveryStep(context: Record<string, any>): Promise<{
    kind: RecoveryKind;
    attributionKind?: RecoveryAttributionKind;
    structuralOk: boolean;
    beforeCapture: BoundaryCapture | null;
    afterCapture: BoundaryCapture | null;
    continuity: ApplicationContinuitySample[];
    receipt: unknown;
    runtimeHealth: PackageRuntimeHealthReceiptV1;
    coverageRuntimeHealth?: PackageRuntimeHealthReceiptV1;
    durationMs: number;
    reserveExhausted?: boolean;
    protocolStopped?: boolean;
  }>;
}

interface Usage {
  actions: number;
  waypoints: number;
  holdMs: number;
  dragPx: number;
  durationMs: number;
}

interface ExperimentState {
  runId: string;
  ownerNonceHash: string;
  artifactRoot: string;
  artifactRootDev: number;
  artifactRootIno: number;
  captureDirDev: number;
  captureDirIno: number;
  expiresAtEpochMs: number;
  clockCorrelation: { wallClockIso: string; hostMonotonicNs: string; wallClockMinusMonotonicNs: string };
  input: PrepareInput;
  routeScript: ReturnType<typeof canonicalBoundaryRouteScript>;
  waypoints: BoundaryWaypointPlan[];
  preparation: BoundaryPreparationResult;
  requiredReview: RequiredReviewItem[];
  reviewed: Map<string, VisualFrameAttestation>;
  nextWaypoint: number;
  usage: Usage;
  lastRequiredHash: string;
  rebaselineOrdinal: number;
  structuralStop: string | null;
  routeAttempted: boolean;
  inputReleaseCertain: boolean;
  processAlive: boolean;
  bindingCoherent: boolean;
  lastForeground: ApplicationContinuitySample["foreground"];
  probeParse: string;
  probeSequence: string;
  probeEvents: string[];
  probeEventRecords: ApplicationContinuitySample["probeEventsSincePrior"];
  probeIssues: string[];
  continuityIssueHistory: string[];
  logArtifacts: unknown[];
  runtimeHealth: PackageRuntimeHealthReceiptV1[];
  runtimeHealthFailure: boolean;
  runtimeHealthInconclusive: boolean;
  routeAdjudication: Record<string, any> | null;
  recoveryAttempted: boolean;
  recovery: {
    order: RecoveryKind[];
    steps: Array<{
      kind: RecoveryKind;
      attributionKind: RecoveryAttributionKind;
      structuralOk: boolean;
      beforeItem: RequiredReviewItem | null;
      afterItem: RequiredReviewItem | null;
      beforeCapture: BoundaryCapture | null;
      afterCapture: BoundaryCapture | null;
      continuity: ApplicationContinuitySample[];
      runtimeHealth: PackageRuntimeHealthReceiptV1;
      coverageRuntimeHealth?: PackageRuntimeHealthReceiptV1;
      receipt: unknown;
    }>;
    reviewed: Map<string, VisualFrameAttestation>;
    usageMs: number;
    complete: boolean;
    failed: boolean;
    stopAfterCurrent: boolean;
  } | null;
  recoveryAdjudication: Record<string, any> | null;
}

interface LiveBoundaryRuntime {
  window: BoundQemuWindow;
  secret: string;
  sampler: () => Promise<ApplicationContinuitySample>;
  samplerState: ExperimentState;
  samplerCursor: ContinuitySamplerCursor;
  recoveryBinding: BoundApplicationIdentity;
  /**
   * Emitted at the end of the preceding collected window. The next collector starts from this
   * marker without clearing logcat, so lifecycle/crash evidence produced while a frame is being
   * LOOKed at remains inside the next authenticated evidence window.
   */
  coverageMarker: string;
}

function hashBytes(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
}

function privateWrite(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function privateWriteBytes(filePath: string, bytes: Buffer): void {
  const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicPrivateJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function replacePrivateJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function appendJsonLine(filePath: string, value: unknown): void {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size + BigInt(bytes.length) > BigInt(LOG_ARTIFACT_MAX_BYTES)) {
      throw new Error(`append target '${filePath}' is not a bounded regular file`);
    }
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function reserveArtifactRoot(candidate: string): string {
  if (!path.isAbsolute(candidate)) throw new Error("artifactRoot must be an absolute external path");
  const lexical = path.resolve(candidate);
  if (lexical !== candidate) throw new Error("artifactRoot must be a normalized absolute path");
  if (fs.existsSync(lexical)) throw new Error(`cannot reserve existing artifactRoot '${lexical}'`);
  const physical = resolveProspectivePath(lexical);
  assertExternalCapturePath(physical);
  const repository = fs.realpathSync(REPOSITORY_ROOT);
  if (isWithin(repository, physical) || isWithin(physical, repository)) throw new Error("artifactRoot must remain outside the repository");
  const parent = path.dirname(lexical);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory()) throw new Error("artifactRoot parent must be an existing directory");
  fs.mkdirSync(lexical, { recursive: false, mode: 0o700 });
  const reserved = fs.lstatSync(lexical);
  if (!reserved.isDirectory() || reserved.isSymbolicLink()) throw new Error("artifactRoot reservation did not create one owned regular directory");
  fs.chmodSync(lexical, 0o700);
  if (fs.realpathSync(lexical) !== physical) throw new Error("reserved artifactRoot changed during creation");
  return physical;
}

function ownedDirectoryIdentity(directory: string, label: string): { dev: number; ino: number } {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not an owned non-symlink directory`);
  return { dev: stat.dev, ino: stat.ino };
}

function assertDirectoryIdentity(directory: string, expected: { dev: number; ino: number }, label: string): void {
  const actual = ownedDirectoryIdentity(directory, label);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || fs.realpathSync(directory) !== directory) {
    throw new Error(`${label} identity changed after reservation`);
  }
}

function assertOwnedRootValues(input: {
  artifactRoot: string; artifactRootDev: number; artifactRootIno: number; captureDirDev: number; captureDirIno: number; runId: string; ownerNonceHash: string;
}): void {
  assertDirectoryIdentity(input.artifactRoot, { dev: input.artifactRootDev, ino: input.artifactRootIno }, "artifactRoot");
  assertDirectoryIdentity(path.join(input.artifactRoot, "captures"), { dev: input.captureDirDev, ino: input.captureDirIno }, "capture directory");
  const repository = fs.realpathSync(REPOSITORY_ROOT);
  if (isWithin(repository, input.artifactRoot) || isWithin(input.artifactRoot, repository)) throw new Error("artifactRoot moved into or over the repository");
  const ownerBytes = regularExternalFile(path.join(input.artifactRoot, ".owner.json"), "run owner record", 4_096);
  const owner = parseJsonArtifact(ownerBytes, "run owner record");
  if (owner?.schemaVersion !== 1 || owner?.runId !== input.runId || owner?.ownerNonceHash !== input.ownerNonceHash) {
    throw new Error("artifactRoot owner binding changed");
  }
}

function assertOwnedRunRoot(state: ExperimentState): void {
  assertOwnedRootValues(state);
}

function regularExternalFile(
  filePath: string,
  label: string,
  maxBytes = JSON_ARTIFACT_MAX_BYTES,
  testHooks: { onBeforeOpen?: (filePath: string) => void } = {},
): Buffer {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute external path`);
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(maxBytes)) throw new Error(`${label} must be a bounded regular non-symlink file`);
  const real = fs.realpathSync(filePath);
  assertExternalCapturePath(real);
  testHooks.onBeforeOpen?.(filePath);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > BigInt(maxBytes)) {
      throw new Error(`${label} changed while it was opened`);
    }
    const length = Number(opened.size);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = fs.readSync(descriptor, bytes, offset, length - offset, offset);
      if (count === 0) throw new Error(`${label} became shorter while it was read`);
      offset += count;
    }
    const growth = Buffer.alloc(1);
    if (fs.readSync(descriptor, growth, 0, 1, length) !== 0) throw new Error(`${label} grew while it was read`);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) throw new Error(`${label} changed while it was read`);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function hashRegularExternalFile(filePath: string, label: string, maxBytes: number): { sha256: string; bytes: number } {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute external path`);
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(maxBytes)) throw new Error(`${label} must be a bounded regular non-symlink file`);
  const real = fs.realpathSync(filePath);
  assertExternalCapturePath(real);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > BigInt(maxBytes)) throw new Error(`${label} changed while it was opened`);
    const digest = crypto.createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    const size = Number(opened.size);
    while (offset < size) {
      const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (count === 0) throw new Error(`${label} became shorter while it was hashed`);
      digest.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) throw new Error(`${label} changed while it was hashed`);
    return { sha256: digest.digest("hex"), bytes: size };
  } finally {
    fs.closeSync(descriptor);
  }
}

function replacePrivateBytes(filePath: string, bytes: Buffer): void {
  const current = fs.lstatSync(filePath);
  if (!current.isFile() || current.isSymbolicLink()) throw new Error(`refusing to replace non-regular artifact '${filePath}'`);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function redactCapabilityFromLogArtifact(receipt: any, secret: string): any {
  const artifactPath = receipt?.rawArtifact?.path;
  if (!artifactPath || typeof artifactPath !== "string" || !secret) throw new Error("capability scan requires one published log artifact and non-empty secret");
  const original = regularExternalFile(artifactPath, "raw log artifact", LOG_ARTIFACT_MAX_BYTES);
  const text = original.toString("utf8");
  const occurrences = text.split(secret).length - 1;
  const capabilitySha256 = hashBytes(secret);
  const replacement = `[capability-sha256:${capabilitySha256}]`;
  const sanitized = Buffer.from(occurrences === 0 ? text : text.split(secret).join(replacement), "utf8");
  if (occurrences > 0) replacePrivateBytes(artifactPath, sanitized);
  const verified = regularExternalFile(artifactPath, "redacted raw log artifact", LOG_ARTIFACT_MAX_BYTES);
  if (verified.includes(Buffer.from(secret))) throw new Error("raw session capability remained after log redaction");
  return {
    ...receipt,
    rawArtifact: { ...receipt.rawArtifact, sha256: hashBytes(verified), bytes: verified.length },
    capabilityScan: { capabilitySha256, occurrencesRedacted: occurrences, rawSecretPresent: false },
  };
}

export function readBoundReviewImage(item: RequiredReviewItem, artifactRoot: string): Buffer {
  if (!item.path || !path.isAbsolute(item.path)) throw new Error("review image has no absolute retained path");
  const capturesRoot = path.join(artifactRoot, "captures");
  if (!isWithin(capturesRoot, item.path) || path.resolve(item.path) === path.resolve(capturesRoot)) {
    throw new Error("review image is not a strict child of the run capture directory");
  }
  const bytes = regularExternalFile(item.path, "review image", REVIEW_IMAGE_MAX_BYTES);
  if (hashBytes(bytes) !== item.captureSha256) throw new Error("review image bytes no longer match the retained capture sha256");
  const validated = validateCaptureBuffer(bytes, item.path);
  if (!validated.ok || validated.format !== "png") throw new Error(validated.ok ? "review image is not PNG" : validated.reason);
  return bytes;
}

function parseJsonArtifact(bytes: Buffer, label: string): any {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readReceiptBoundEffectiveAppSpec(
  artifactPath: string,
  identity: { sha256: string; bytes: number },
  testHooks: { onBeforeOpen?: (filePath: string) => void } = {},
): any {
  if (!SHA256.test(identity?.sha256 ?? "") || !Number.isSafeInteger(identity?.bytes) || identity.bytes < 1) {
    throw new Error("effective AppSpec receipt identity is invalid");
  }
  const storedBytes = regularExternalFile(artifactPath, "effective AppSpec", JSON_ARTIFACT_MAX_BYTES, testHooks);
  const spec = parseJsonArtifact(storedBytes, "effective AppSpec");
  let canonical: string;
  try {
    canonical = canonicalJson(spec);
  } catch (error) {
    throw new Error(`effective AppSpec cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`);
  }
  const canonicalBytes = Buffer.from(canonical, "utf8");
  const expectedStoredBytes = Buffer.from(`${canonical}\n`, "utf8");
  if (!storedBytes.equals(expectedStoredBytes)
    || canonicalBytes.length !== identity.bytes
    || hashBytes(canonicalBytes) !== identity.sha256) {
    throw new Error("effective AppSpec artifact changed after receipt validation");
  }
  return spec;
}

interface ResolvedCalibrationRoute {
  waypoints: BoundaryWaypointPlan[];
  direction: BoundaryRoute["direction"];
  speedProfile: BoundaryRoute["speedProfile"];
  requiredTraversalM: 32;
  gateSequenceM: [1, 2, 4, 8, 16, 32];
  budgets: z.infer<typeof budgetsSchema>;
  sourceRunId: string;
}

export function resolveCalibrationRouteRef(
  ref: z.infer<typeof replayRefSchema>,
  receiptReader: typeof readNativeRunReceipt = readNativeRunReceipt,
): ResolvedCalibrationRoute {
  const parsed = replayRefSchema.parse(ref);
  const routeBytes = regularExternalFile(parsed.absolutePath, "calibration route script");
  if (hashBytes(routeBytes) !== parsed.routeScriptSha256) throw new Error("calibration route script sha256 mismatch or tamper");
  const directory = path.dirname(parsed.absolutePath);
  const manifestBytes = regularExternalFile(path.join(directory, "run.json"), "source run manifest");
  if (hashBytes(manifestBytes) !== parsed.sourceRunManifestSha256) throw new Error("source run manifest sha256 mismatch");
  const adjudicationBytes = regularExternalFile(path.join(directory, "adjudication.json"), "source route adjudication");
  if (hashBytes(adjudicationBytes) !== parsed.sourceAdjudicationSha256) throw new Error("source adjudication sha256 mismatch");
  const script = z.object({
    schemaVersion: z.literal(1),
    scenarioId: z.literal("boundarylab-mixed"),
    direction: z.enum(["forward", "backward", "left", "right"]),
    speedProfile: z.enum(["slow", "medium", "fast", "staircase"]),
    requiredTraversalM: z.literal(32),
    gateSequenceM: z.tuple([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)]),
    budgets: budgetsSchema,
    waypoints: z.array(waypointSchema).min(1).max(32),
  }).strict().parse(parseJsonArtifact(routeBytes, "calibration route script"));
  const manifest = parseJsonArtifact(manifestBytes, "source run manifest");
  const adjudication = parseJsonArtifact(adjudicationBytes, "source route adjudication");
  const sourceRunId = hashSchema.parse(manifest?.runId);
  const sourceScenario = scenarioSchema.parse(manifest?.scenario);
  const exactM0Scenario: BoundaryScenario = {
    id: GENERATED_SCENARIOS.manifest_mixed.id,
    packageName: GENERATED_SCENARIOS.manifest_mixed.packageName,
    launchComponent: `${GENERATED_SCENARIOS.manifest_mixed.packageName}/.platform.LaunchActivity`,
    allowedResumedComponents: [`${GENERATED_SCENARIOS.manifest_mixed.packageName}/.platform.LaunchActivity`],
    entryRoute: "manifest_mixed",
    expectedManifestStageStyle: "Mixed",
  };
  if (manifest?.schemaVersion !== 1
    || manifest?.serial === undefined
    || canonicalJson(sourceScenario) !== canonicalJson(exactM0Scenario)) {
    throw new Error("calibration replay source is not the exact M0 manifest-mixed run identity");
  }
  const sourceProvenance = provenanceSchema.parse(manifest?.provenance);
  if (sourceProvenance.kind !== "native_run_receipt") {
    throw new Error("calibration replay source must carry one native M0 run receipt");
  }
  const nativeReceipt = receiptReader(sourceScenario.packageName, sourceProvenance.receiptId);
  if (nativeReceipt.status !== "valid") {
    throw new Error(`calibration replay native M0 receipt is invalid: ${nativeReceipt.issues.join("; ")}`);
  }
  if (nativeReceipt.receipt.receiptId !== sourceProvenance.receiptId
    || nativeReceipt.receipt.app !== sourceScenario.packageName
    || nativeReceipt.receipt.apk.packageName !== sourceScenario.packageName
    || nativeReceipt.receipt.install.packageName !== sourceScenario.packageName
    || nativeReceipt.receipt.apk.sha256 !== sourceProvenance.apkSha256
    || nativeReceipt.receipt.install.remoteApkSha256 !== sourceProvenance.apkSha256
    || nativeReceipt.receipt.runtime.serial !== manifest.serial
    || nativeReceipt.receipt.runtime.component !== sourceScenario.launchComponent
    || nativeReceipt.receipt.source.effectiveAppSpec.sha256 !== GENERATED_SCENARIOS.manifest_mixed.effectiveSpecSha256) {
    throw new Error("calibration replay native receipt does not bind the exact M0 package, component, serial, APK, and effective AppSpec");
  }
  if (!manifest.normalizedRoute || manifest.routeScriptSha256 !== parsed.routeScriptSha256
    || canonicalJson(manifest.normalizedRoute) !== canonicalJson(script)) {
    throw new Error("source run manifest does not bind the exact normalized route script");
  }
  if (adjudication?.outcome !== "retained_immersive_through_route"
    || adjudication?.verdict !== "PASS"
    || adjudication?.evidenceCeiling !== "vision_verified_eligible"
    || adjudication?.witnessedGateM !== 32) {
    throw new Error("calibration replay requires a looked retained M0 outer 32 m gate adjudication");
  }
  if (adjudication?.runId !== sourceRunId) throw new Error("source adjudication does not bind the source runId");
  if (adjudication?.routeScriptSha256 !== parsed.routeScriptSha256) throw new Error("source adjudication does not bind the exact route script hash");
  const sourceRequiredReview = z.array(z.object({
    captureSha256: hashSchema,
    role: z.enum(["home_reference", "app_baseline", "waypoint", "transition", "recovery"]),
    waypointSeq: z.number().int().positive().optional(),
    targetGateM: z.union(GATES.map((gate) => z.literal(gate)) as [z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<4>, z.ZodLiteral<8>, z.ZodLiteral<16>, z.ZodLiteral<32>]).optional(),
    recoveryStep: z.enum(["observe", "reopen_stage", "activity_launch", "force_stop_relaunch"]).optional(),
    settled: z.boolean(),
    path: z.string().min(1),
  }).strict()).max(64).parse(adjudication?.requiredReview) as RequiredReviewItem[];
  const sourceAttestations = z.array(attestationSchema).max(64).parse(adjudication?.frameAttestations);
  const sourceReviewed = exactReviewManifest(sourceRequiredReview, sourceAttestations, sourceScenario);
  for (const required of sourceRequiredReview) readBoundReviewImage(required, directory);
  const attestedOuterGate = sourceRequiredReview.some((required) => required.role === "waypoint"
    && required.targetGateM === 32
    && sourceReviewed.get(required.captureSha256)?.witnessedGateM === 32);
  if (!attestedOuterGate) throw new Error("source adjudication lacks an exact looked outer-gate frame attestation");
  return {
    waypoints: script.waypoints.map((waypoint) => ({ ...waypoint, actions: waypoint.actions.map((action) => ({ ...action })) })),
    direction: script.direction,
    speedProfile: script.speedProfile,
    requiredTraversalM: script.requiredTraversalM,
    gateSequenceM: [...script.gateSequenceM],
    budgets: { ...script.budgets },
    sourceRunId,
  };
}

export function canonicalBoundaryRouteScript(
  input: { scenarioId: string; route: BoundaryRoute },
  receiptReader: typeof readNativeRunReceipt = readNativeRunReceipt,
): {
  script: Record<string, any> & { waypoints: BoundaryWaypointPlan[] };
  json: string;
  sha256: string;
} {
  const parsedRoute = routeSchema.parse(input.route);
  const resolved = parsedRoute.source.kind === "calibration_seed"
    ? null
    : resolveCalibrationRouteRef(parsedRoute.source.calibrationRouteRef, receiptReader);
  if (resolved && (resolved.direction !== parsedRoute.direction
    || resolved.speedProfile !== parsedRoute.speedProfile
    || resolved.requiredTraversalM !== parsedRoute.requiredTraversalM
    || canonicalJson(resolved.gateSequenceM) !== canonicalJson(parsedRoute.gateSequenceM)
    || canonicalJson(resolved.budgets) !== canonicalJson(parsedRoute.budgets))) {
    throw new Error("replay direction, speed profile, traversal gates, and budgets must exactly match the calibrated M0 source");
  }
  const waypoints = resolved?.waypoints ?? (parsedRoute.source as Extract<BoundaryRoute["source"], { kind: "calibration_seed" }>).waypoints;
  const script = {
    schemaVersion: 1,
    scenarioId: input.scenarioId,
    direction: parsedRoute.direction,
    speedProfile: parsedRoute.speedProfile,
    requiredTraversalM: parsedRoute.requiredTraversalM,
    gateSequenceM: parsedRoute.gateSequenceM,
    budgets: parsedRoute.budgets,
    waypoints: waypoints.map((waypoint) => ({ ...waypoint, actions: waypoint.actions.map((action) => ({ ...action })) })),
  };
  const json = canonicalJson(script);
  return { script, json, sha256: hashBytes(json) };
}

function expectedAppState(scenario: BoundaryScenario): VisualFrameAttestation["visibleState"] {
  if (scenario.entryRoute === "manifest_mixed") return "boundarylab_mixed";
  if (scenario.entryRoute === "manifest_full") return "boundarylab_manifest_full";
  if (scenario.entryRoute === "dynamic_full") return "boundarylab_dynamic_full";
  return "claimsight_environment";
}

function compatibleAttestation(item: RequiredReviewItem, attestation: VisualFrameAttestation, scenario: BoundaryScenario): boolean {
  const gate = attestation.witnessedGateM ?? 0;
  if (scenario.entryRoute === "editor_manifest_full" && gate !== 0) return false;
  if (item.role !== "waypoint" && gate !== 0) return false;
  if (item.role === "home_reference") {
    return (attestation.visibleState === "system_home" || attestation.visibleState === "black_or_inconclusive")
      && attestation.sentinels.length === 0;
  }
  if (item.role === "app_baseline") {
    return attestation.visibleState === expectedAppState(scenario) && carriesExpectedSentinel(attestation);
  }
  if (attestation.visibleState === "system_home" || attestation.visibleState === "black_or_inconclusive") {
    return attestation.sentinels.length === 0;
  }
  if (scenario.entryRoute === "dynamic_full" && attestation.visibleState === "boundarylab_mixed") {
    return carriesExpectedSentinel(attestation);
  }
  return attestation.visibleState === expectedAppState(scenario) && carriesExpectedSentinel(attestation);
}

function carriesExpectedSentinel(attestation: VisualFrameAttestation): boolean {
  if (attestation.visibleState === "boundarylab_mixed") {
    return attestation.sentinels.includes("MANIFEST MIXED ROOT") && !attestation.sentinels.includes("DYNAMIC FULL");
  }
  if (attestation.visibleState === "boundarylab_manifest_full") {
    return attestation.sentinels.includes("MANIFEST FULL") && !attestation.sentinels.includes("MANIFEST MIXED ROOT");
  }
  if (attestation.visibleState === "boundarylab_dynamic_full") {
    return attestation.sentinels.includes("DYNAMIC FULL") && !attestation.sentinels.includes("MANIFEST MIXED ROOT");
  }
  if (attestation.visibleState === "claimsight_environment") return attestation.sentinels.length > 0;
  return true;
}

export function recoveryFrameMatchesExpected(
  scenario: BoundaryScenario,
  frame: VisualFrameAttestation,
  claimsightLandmarks: readonly string[] = [],
): boolean {
  return frame.visibleState === expectedAppState(scenario)
    && carriesExpectedSentinel(frame)
    && (scenario.entryRoute !== "editor_manifest_full"
      || (claimsightLandmarks.length > 0 && claimsightLandmarks.every((landmark) => frame.sentinels.includes(landmark))));
}

export function shouldIncludeDynamicReopen(input: {
  entryRoute: BoundaryScenario["entryRoute"];
  observedFrame: Pick<VisualFrameAttestation, "visibleState" | "sentinels">;
  observeStructuralOk: boolean;
  exactBinding: boolean;
}): boolean {
  return input.entryRoute === "dynamic_full"
    && input.observeStructuralOk
    && input.exactBinding
    && input.observedFrame.visibleState === "boundarylab_mixed"
    && input.observedFrame.sentinels.includes("MANIFEST MIXED ROOT")
    && !input.observedFrame.sentinels.includes("DYNAMIC FULL");
}

export function recoveryReboundTupleChanged(
  before: Pick<BoundApplicationIdentity, "pid" | "pidStartTicks">,
  after: Pick<BoundApplicationIdentity, "pid" | "pidStartTicks">,
): boolean {
  return before.pid !== after.pid || before.pidStartTicks !== after.pidStartTicks;
}

export function hasExactDynamicOpenSequence(
  records: ReadonlyArray<Pick<ApplicationContinuitySample["probeEventsSincePrior"][number], "kind">>,
  expected: readonly string[],
): boolean {
  const expectedSet = new Set(expected);
  const openKinds = records.map((record) => record.kind).filter((kind) => expectedSet.has(kind));
  return canonicalJson(openKinds) === canonicalJson(expected);
}

function retainsReviewedClaimsightLandmarks(state: ExperimentState, attestation: VisualFrameAttestation): boolean {
  if (state.input.scenario.entryRoute !== "editor_manifest_full" || attestation.visibleState !== "claimsight_environment") return true;
  const baseline = state.reviewed.get(state.preparation.appBaseline.sha256);
  if (!baseline) return attestation.sentinels.length > 0;
  return baseline.sentinels.length > 0 && baseline.sentinels.every((landmark) => attestation.sentinels.includes(landmark));
}

function exactReviewManifest(
  requiredReview: RequiredReviewItem[],
  attestations: VisualFrameAttestation[],
  scenario: BoundaryScenario,
  options: { allowUnsettledTransition?: boolean } = {},
): Map<string, VisualFrameAttestation> {
  if (requiredReview.some((item) => !item.settled
    && item.role !== "recovery"
    && !(options.allowUnsettledTransition && item.role === "transition"))) {
    throw new Error("required review manifest contains an unsettled frame");
  }
  const requiredHashes = requiredReview.map((item) => item.captureSha256);
  if (new Set(requiredHashes).size !== requiredHashes.length) throw new Error("required review manifest contains duplicate capture hashes");
  const attestedHashes = attestations.map((item) => item.captureSha256);
  if (new Set(attestedHashes).size !== attestedHashes.length) throw new Error("duplicate capture attestation violates exact review manifest");
  if (requiredHashes.length !== attestedHashes.length
    || requiredHashes.some((hash) => !attestedHashes.includes(hash))
    || attestedHashes.some((hash) => !requiredHashes.includes(hash))) {
    throw new Error("missing or unexpected capture attestation; the complete exact required review manifest is mandatory");
  }
  const byHash = new Map(attestations.map((item) => [item.captureSha256, item]));
  for (const item of requiredReview) {
    const attestation = byHash.get(item.captureSha256)!;
    if (item.role !== "waypoint" && (attestation.witnessedGateM ?? 0) !== 0) {
      throw new Error(`${item.role.replace("_", " ")} cannot witness a route gate; only retained waypoint frames can carry distance gates`);
    }
    if (!compatibleAttestation(item, attestation, scenario)) {
      throw new Error(`${item.role.replace("_", " ")} capture ${item.captureSha256} has a visible state incompatible with scenario ${scenario.id}`);
    }
  }
  if (scenario.entryRoute === "editor_manifest_full") {
    const baselineItem = requiredReview.find((item) => item.role === "app_baseline");
    const landmarks = baselineItem ? byHash.get(baselineItem.captureSha256)?.sentinels ?? [] : [];
    if (baselineItem && landmarks.length === 0) throw new Error("Claimsight baseline requires a stable scene-specific landmark set");
    for (const item of requiredReview.filter((candidate) => candidate.role === "waypoint" || candidate.role === "transition")) {
      const attestation = byHash.get(item.captureSha256)!;
      if (attestation.visibleState === "claimsight_environment" && landmarks.some((landmark) => !attestation.sentinels.includes(landmark))) {
        throw new Error("Claimsight route frame does not retain the baseline landmark set");
      }
    }
  }
  return byHash;
}

export interface BoundaryOutcomeInput {
  scenario: BoundaryScenario;
  requiredReview: RequiredReviewItem[];
  attestations: VisualFrameAttestation[];
  structural: {
    stop: string | null;
    inputReleaseCertain: boolean;
    processAlive: boolean;
    bindingCoherent: boolean;
    routeComplete: boolean;
    lastForeground: ApplicationContinuitySample["foreground"];
    probeParse: string;
    probeSequence: string;
    probeEvents: string[];
    probeEventRecords: ApplicationContinuitySample["probeEventsSincePrior"];
    probeIssues?: string[];
    runtimeHealthFailure: boolean;
    runtimeHealthInconclusive: boolean;
  };
}

export function deriveBoundaryRouteOutcome(input: BoundaryOutcomeInput): {
  outcome: string;
  verdict: "PASS" | "FAIL" | "CHARACTERIZE";
  evidenceCeiling: "structural" | "vision_verified_eligible";
  witnessedGateM: number;
  visualTransition: "system_home" | "app_default_stage" | "expected_app" | "inconclusive" | null;
} {
  const reviewed = exactReviewManifest(input.requiredReview, input.attestations, input.scenario, {
    allowUnsettledTransition: ["route_unsettled", "input_release_uncertain", "action_failed"].includes(input.structural.stop ?? ""),
  });
  const attestations = input.requiredReview.map((item) => reviewed.get(item.captureSha256)!);
  const routeFrames = input.requiredReview
    .map((item, index) => ({ item, attestation: attestations[index] }))
    .filter(({ item }) => item.role === "waypoint" || item.role === "transition");
  const terminal = routeFrames.at(-1)?.attestation;
  const witnessedGateM = input.scenario.entryRoute === "editor_manifest_full"
    ? 0
    : Math.max(0, ...routeFrames.filter(({ item }) => item.role === "waypoint").map(({ attestation }) => attestation.witnessedGateM ?? 0));
  const visualTransition: "system_home" | "app_default_stage" | "expected_app" | "inconclusive" | null = !terminal ? null
    : terminal.visibleState === "system_home" ? "system_home"
      : terminal.visibleState === "black_or_inconclusive" ? "inconclusive"
        : input.scenario.entryRoute === "dynamic_full" && terminal.visibleState === "boundarylab_mixed" ? "app_default_stage"
          : "expected_app";
  const result = (
    outcome: string,
    verdict: "PASS" | "FAIL" | "CHARACTERIZE",
    evidenceCeiling: "structural" | "vision_verified_eligible",
  ) => ({ outcome, verdict, evidenceCeiling, witnessedGateM, visualTransition });

  if (!input.structural.inputReleaseCertain || input.structural.stop === "input_release_uncertain") {
    return result("input_release_uncertain", "FAIL", "structural");
  }
  if (!input.structural.processAlive || input.structural.runtimeHealthFailure) return result("app_lifecycle_loss", "FAIL", "structural");
  if (input.structural.runtimeHealthInconclusive) return result("binding_lost", "CHARACTERIZE", "structural");
  if (input.structural.stop === "route_unsettled" || input.structural.stop === "action_failed") return result("route_unsettled", "CHARACTERIZE", "structural");
  if (input.structural.stop === "binding_lost" || !input.structural.bindingCoherent) return result("binding_lost", "CHARACTERIZE", "structural");
  if (input.scenario.entryRoute === "dynamic_full") {
    const expectedAcks = input.scenario.dynamicEntry?.expectedAcks ?? [];
    const probeInvalid = input.structural.probeParse !== "ok"
      || input.structural.probeSequence !== "complete"
      || (input.structural.probeIssues?.length ?? 0) > 0
      || !hasExactDynamicOpenSequence(input.structural.probeEventRecords, expectedAcks)
      || input.structural.probeEvents.includes("explicit_close_requested")
      || input.structural.probeEvents.includes("explicit_close_returned");
    if (probeInvalid) return result("stage_self_closed_or_lifecycle_teardown", "CHARACTERIZE", "structural");
  }
  if (!terminal || terminal.visibleState === "black_or_inconclusive") {
    return result("capture_inconclusive", "CHARACTERIZE", "structural");
  }
  if (terminal.visibleState === "system_home") return result("ejected_to_system_home", "FAIL", "vision_verified_eligible");
  if (input.structural.lastForeground !== "exact_allowed") return result("binding_lost", "CHARACTERIZE", "structural");
  if (input.scenario.entryRoute === "dynamic_full" && terminal.visibleState === "boundarylab_mixed") {
    return result("returned_to_app_default_stage", "FAIL", "vision_verified_eligible");
  }
  const expected = expectedAppState(input.scenario);
  const allExpected = routeFrames.length > 0
    && routeFrames.every(({ attestation }) => attestation.visibleState === expected && carriesExpectedSentinel(attestation));
  const traversalWitnessed = input.scenario.entryRoute === "editor_manifest_full" || witnessedGateM === 32;
  if (input.structural.routeComplete && traversalWitnessed && allExpected) {
    return result("retained_immersive_through_route", "PASS", "vision_verified_eligible");
  }
  return result("no_ejection_within_observed_budget", "CHARACTERIZE", "vision_verified_eligible");
}

export async function executeBoundaryRecoveryProtocol(
  input: { dynamic: boolean; inputReleaseCertain: boolean },
  dependencies: {
    observe(): Promise<boolean>;
    reopenStage(): Promise<boolean>;
    launchActivity(): Promise<boolean>;
    forceStopRelaunch(): Promise<boolean>;
  },
): Promise<{ result: "input_release_uncertain" | "auto_resumed" | "stage_reopened" | "activity_relaunch" | "force_stop_relaunch" | "unrecovered"; steps: Array<{ kind: string; recovered: boolean }> }> {
  if (!input.inputReleaseCertain) return { result: "input_release_uncertain", steps: [] };
  const steps: Array<{ kind: string; recovered: boolean }> = [];
  const observed = await dependencies.observe();
  steps.push({ kind: "observe", recovered: observed });
  if (observed) return { result: "auto_resumed", steps };
  if (input.dynamic) {
    const reopened = await dependencies.reopenStage();
    steps.push({ kind: "reopen_stage", recovered: reopened });
    if (reopened) return { result: "stage_reopened", steps };
  }
  const launched = await dependencies.launchActivity();
  steps.push({ kind: "activity_launch", recovered: launched });
  if (launched) return { result: "activity_relaunch", steps };
  const forceStopped = await dependencies.forceStopRelaunch();
  steps.push({ kind: "force_stop_relaunch", recovered: forceStopped });
  return { result: forceStopped ? "force_stop_relaunch" : "unrecovered", steps };
}

function publicState(state: ExperimentState): Record<string, unknown> {
  return {
    runId: state.runId,
    status: state.routeAdjudication ? "route_adjudicated" : state.structuralStop ? "ready_for_route_adjudication" : "active",
    nextWaypoint: state.nextWaypoint,
    usage: state.usage,
    routeAttempted: state.routeAttempted,
    lastRequiredHash: state.lastRequiredHash,
    rebaselineOrdinal: state.rebaselineOrdinal,
    structuralStop: state.structuralStop,
    inputReleaseCertain: state.inputReleaseCertain,
    processAlive: state.processAlive,
    bindingCoherent: state.bindingCoherent,
    lastForeground: state.lastForeground,
    probeParse: state.probeParse,
    probeSequence: state.probeSequence,
    probeIssues: state.probeIssues,
    runtimeHealthFailure: state.runtimeHealthFailure,
    runtimeHealthInconclusive: state.runtimeHealthInconclusive,
    runtimeHealthWindows: state.runtimeHealth.length,
    routeAdjudicated: state.routeAdjudication !== null,
    recoveryStarted: state.recoveryAttempted,
    recoveryAttempted: state.recoveryAttempted,
    recoveryComplete: state.recovery?.complete ?? false,
    recoveryFailed: state.recovery?.failed ?? false,
    recoverySteps: state.recovery?.steps.map((step) => step.kind) ?? [],
    recoveryUsageMs: state.recovery?.usageMs ?? 0,
    recoveryAdjudicated: state.recoveryAdjudication !== null,
  };
}

function recoveryReviewItems(state: ExperimentState): RequiredReviewItem[] {
  if (!state.recovery) return [];
  return [...new Map(state.recovery.steps
    .flatMap((step) => [step.beforeItem, step.afterItem])
    .filter((item): item is RequiredReviewItem => item !== null)
    .map((item) => [item.captureSha256, item])).values()];
}

function persistRecovery(state: ExperimentState): void {
  if (!state.recovery) return;
  replacePrivateJson(path.join(state.artifactRoot, "recovery.json"), {
    order: state.recovery.order,
    steps: state.recovery.steps.map((step) => ({
      kind: step.kind,
      attributionKind: step.attributionKind,
      structuralOk: step.structuralOk,
      beforeItem: step.beforeItem,
      afterItem: step.afterItem,
      beforeCapture: step.beforeCapture,
      afterCapture: step.afterCapture,
      continuity: step.continuity,
      runtimeHealth: step.runtimeHealth,
      ...(step.coverageRuntimeHealth ? { coverageRuntimeHealth: step.coverageRuntimeHealth } : {}),
      receipt: step.receipt,
    })),
    reviewedAfterFrames: [...state.recovery.reviewed.values()],
    usageMs: state.recovery.usageMs,
    complete: state.recovery.complete,
    failed: state.recovery.failed,
    stopAfterCurrent: state.recovery.stopAfterCurrent,
  });
}

function persistState(state: ExperimentState): void {
  assertOwnedRunRoot(state);
  replacePrivateJson(path.join(state.artifactRoot, "state.json"), publicState(state));
  replacePrivateJson(path.join(state.artifactRoot, "required-review.json"), state.requiredReview);
  replacePrivateJson(path.join(state.artifactRoot, "logcat-index.json"), {
    schemaVersion: 1,
    clockCorrelation: {
      runStart: state.clockCorrelation,
      note: "runStart binds wall clock to host monotonic time; each artifact receipt carries its owned child's host-monotonic bounds",
    },
    artifacts: state.logArtifacts,
    runtimeHealth: state.runtimeHealth,
    tagInventory: state.runtimeHealth.map((receipt) => ({ sourceSha256: receipt.sourceSha256, tags: receipt.tagInventory })),
  });
  assertOwnedRunRoot(state);
}

function checkedRuntimeHealth(
  receipt: PackageRuntimeHealthReceiptV1,
  packageName: string,
  logArtifact: any,
): PackageRuntimeHealthReceiptV1 {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.packageName !== packageName
    || !["no_attributed_failure", "attributed_failure", "inconclusive"].includes(receipt.status)
    || !Array.isArray(receipt.expectedPids) || !Array.isArray(receipt.incidents)
    || !Array.isArray(receipt.tagInventory) || !Number.isInteger(receipt.markerOccurrences)
    || !Number.isInteger(receipt.scannedBytes) || receipt.scannedBytes < 0) {
    throw new Error("runtime-health receipt is missing or malformed");
  }
  const artifactSha256 = logArtifact?.rawArtifact?.sha256;
  if (artifactSha256) {
    if (receipt.sourceSha256 !== artifactSha256 || !SHA256.test(receipt.sourceSha256 ?? "")) {
      throw new Error("runtime-health receipt does not bind the finalized log artifact");
    }
  } else if (receipt.status !== "inconclusive" || receipt.sourceSha256 !== null) {
    throw new Error("runtime-health receipt without a finalized log must be explicitly inconclusive");
  }
  if (receipt.status === "attributed_failure" && receipt.incidents.length === 0) {
    throw new Error("runtime-health failure has no attributed incident");
  }
  if (receipt.status === "no_attributed_failure" && (receipt.incidents.length > 0 || receipt.ambiguousCandidateCount !== 0 || receipt.markerOccurrences !== 1)) {
    throw new Error("runtime-health quiet receipt contradicts its incident or marker inventory");
  }
  return receipt;
}

function recordRuntimeHealth(
  state: ExperimentState,
  receipt: PackageRuntimeHealthReceiptV1,
  logArtifact: unknown,
): void {
  const checked = checkedRuntimeHealth(receipt, state.input.scenario.packageName, logArtifact);
  state.runtimeHealth.push(checked);
  if (checked.status === "attributed_failure") state.runtimeHealthFailure = true;
  if (checked.status === "inconclusive") state.runtimeHealthInconclusive = true;
}

function aggregateContinuity(state: ExperimentState, samples: ApplicationContinuitySample[]): void {
  for (const sample of samples) {
    assertOwnedRunRoot(state);
    appendJsonLine(path.join(state.artifactRoot, "continuity.jsonl"), sample);
    if (sample.pid !== state.preparation.applicationBinding.pid || sample.pidStartTicks !== state.preparation.applicationBinding.pidStartTicks) {
      state.processAlive = false;
      state.continuityIssueHistory.push(`process:${sample.pid ?? "absent"}/${sample.pidStartTicks ?? "absent"}`);
    }
    if (sample.serial !== state.preparation.runtimeBinding.serial
      || sample.bootId !== state.preparation.runtimeBinding.bootId
      || sample.apkSha256 !== state.preparation.applicationBinding.apkSha256
      || sample.packageName !== state.preparation.applicationBinding.packageName
      || canonicalJson(sample.allowedResumedComponents) !== canonicalJson(state.preparation.applicationBinding.allowedResumedComponents)) {
      state.bindingCoherent = false;
      state.continuityIssueHistory.push("identity_mismatch");
    }
    state.lastForeground = sample.foreground;
    if (sample.foreground !== "exact_allowed") state.continuityIssueHistory.push(`foreground:${sample.foreground}`);
    if (sample.probeParse === "malformed" || sample.probeParse === "truncated") {
      state.probeIssues.push(`parse:${sample.probeParse}`);
    } else if (sample.probeParse === "ok" && state.probeParse === "absent") {
      state.probeParse = "ok";
    }
    if (["gap", "wrong_session", "wrong_generation"].includes(sample.probeSequence)) {
      state.probeIssues.push(`sequence:${sample.probeSequence}`);
    } else if (sample.probeSequence === "complete" && state.probeSequence === "unknown") {
      state.probeSequence = "complete";
    }
    for (const event of sample.probeEventsSincePrior) {
      state.probeEvents.push(event.kind);
      state.probeEventRecords.push(event);
      if (event.kind === "explicit_close_requested" || event.kind === "explicit_close_returned") {
        state.probeIssues.push(`event:${event.kind}`);
      }
    }
    state.probeIssues = [...new Set(state.probeIssues)];
    assertOwnedRunRoot(state);
  }
}

function preflightHasExactBoundIdentity(state: ExperimentState, sample: ApplicationContinuitySample): boolean {
  const application = state.preparation.applicationBinding;
  return sample.serial === state.preparation.runtimeBinding.serial
    && sample.bootId === state.preparation.runtimeBinding.bootId
    && sample.packageName === application.packageName
    && sample.apkSha256 === application.apkSha256
    && sample.pid === application.pid
    && sample.pidStartTicks === application.pidStartTicks
    && canonicalJson(sample.allowedResumedComponents) === canonicalJson(application.allowedResumedComponents)
    && sample.resumedComponents.some((component) => application.allowedResumedComponents.includes(component))
    && sample.foreground === "exact_allowed";
}

function dynamicPreflightProbeAllowsMovement(state: ExperimentState, sample: ApplicationContinuitySample): boolean {
  return state.input.scenario.entryRoute !== "dynamic_full"
    || (sample.probeParse === "ok"
      && sample.probeSequence === "complete"
      && state.probeIssues.length === 0
      && !sample.probeEventsSincePrior.some((event) =>
        event.kind === "explicit_close_requested" || event.kind === "explicit_close_returned"));
}

function recordRecoveryContinuity(state: ExperimentState, samples: ApplicationContinuitySample[]): void {
  for (const sample of samples) {
    assertOwnedRunRoot(state);
    appendJsonLine(path.join(state.artifactRoot, "continuity.jsonl"), { scope: "recovery", sample });
    assertOwnedRunRoot(state);
  }
}

function captureToReview(
  capture: BoundaryCapture,
  options: { waypointSeq?: number; targetGateM?: BoundaryWaypointPlan["targetGateM"]; recoveryStep?: RequiredReviewItem["recoveryStep"] } = {},
): RequiredReviewItem {
  if (!SHA256.test(capture.sha256) || !path.isAbsolute(capture.path)) throw new Error("capture lacks an exact external path and sha256");
  return {
    captureSha256: capture.sha256,
    role: capture.role,
    ...(options.waypointSeq === undefined ? {} : { waypointSeq: options.waypointSeq }),
    ...(options.targetGateM === undefined ? {} : { targetGateM: options.targetGateM }),
    ...(options.recoveryStep === undefined ? {} : { recoveryStep: options.recoveryStep }),
    settled: capture.settled,
    path: capture.path,
  };
}

function budgetProblem(state: ExperimentState, waypoint: BoundaryWaypointPlan): boolean {
  const budgets = state.input.route.budgets;
  const preflightReserveMs = WAYPOINT_COVERAGE_MARKER_RESERVE_MS
    + state.input.capture.attemptTimeoutMs
    + APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS
    + WAYPOINT_HEALTH_SNAPSHOT_RESERVE_MS
    + ROUTE_FINALIZATION_RESERVE_MS;
  const groupActions = waypoint.actions.length;
  const groupHold = waypoint.actions.reduce((sum, action) => sum + (action.kind === "key_hold" ? action.holdMs : 0), 0);
  const groupDrag = waypoint.actions.reduce((sum, action) => sum + (action.kind === "look_drag" ? Math.hypot(action.dxPx, action.dyPx) : 0), 0);
  return state.usage.actions + groupActions > budgets.maxActions
    || state.usage.waypoints + 1 > budgets.maxWaypoints
    || state.usage.holdMs + groupHold > budgets.maxCumulativeHoldMs
    || state.usage.dragPx + groupDrag > budgets.maxCumulativeDragPx
    || state.usage.durationMs >= budgets.maxDurationMs - budgets.recoveryReserveMs
    || state.usage.durationMs + preflightReserveMs > budgets.maxDurationMs - budgets.recoveryReserveMs
    || waypoint.actions.some((action) => action.kind === "key_hold" ? action.holdMs > budgets.maxHoldMsPerAction : Math.hypot(action.dxPx, action.dyPx) > budgets.maxDragPxPerAction);
}

function remainingBudgets(state: ExperimentState): RouteBudgets {
  const budgets = state.input.route.budgets;
  return {
    ...budgets,
    maxActions: budgets.maxActions - state.usage.actions,
    maxWaypoints: budgets.maxWaypoints - state.usage.waypoints,
    maxCumulativeHoldMs: budgets.maxCumulativeHoldMs - state.usage.holdMs,
    maxCumulativeDragPx: budgets.maxCumulativeDragPx - state.usage.dragPx,
    maxDurationMs: Math.max(1, budgets.maxDurationMs - state.usage.durationMs),
  };
}

export function createBoundaryExperimentOrchestrator(dependencies: BoundaryExperimentDependencies) {
  const runs = new Map<string, ExperimentState>();
  const busyRuns = new Set<string>();
  let preparing = 0;

  const scrubRuntime = (state: ExperimentState): void => {
    state.preparation.privateRuntime = undefined;
  };

  const sweepExpired = (): void => {
    const now = Date.now();
    for (const [runId, state] of runs) {
      if (state.expiresAtEpochMs <= now) {
        scrubRuntime(state);
        runs.delete(runId);
        busyRuns.delete(runId);
      }
    }
  };

  const terminalResponse = (state: ExperimentState): Record<string, any> => ({
    status: "ready_for_route_adjudication",
    runId: state.runId,
    artifactRoot: state.artifactRoot,
    structuralStop: state.structuralStop,
    requiredReview: state.requiredReview,
    responseReview: [],
    visualReviewRequired: true,
  });

  const execute = async (rawInput: BoundaryExperimentInput): Promise<Record<string, any>> => {
    const input = boundaryExperimentInputSchema.parse(rawInput);
    if (input.action === "prepare") {
      sweepExpired();
      if (runs.size + preparing >= MAX_ACTIVE_RUNS) throw new Error(`active boundary run cap (${MAX_ACTIVE_RUNS}) reached; adjudicate or wait for expiry before preparing another run`);
      preparing += 1;
      try {
        const routeScript = canonicalBoundaryRouteScript(
          { scenarioId: input.scenario.id, route: input.route },
          dependencies.readNativeRunReceipt,
        );
        const ownerNonce = dependencies.randomBytes(32);
        if (!Buffer.isBuffer(ownerNonce) || ownerNonce.length < 32) throw new Error("random source did not provide a 256-bit owner nonce");
        const startMonotonicNs = dependencies.monotonicNs().toString();
        const wallClockIso = dependencies.now();
        const wallClockEpochMs = Date.parse(wallClockIso);
        if (!Number.isFinite(wallClockEpochMs) || !/^\d+$/.test(startMonotonicNs)) throw new Error("run clock correlation sample is invalid");
        const clockCorrelation = {
          wallClockIso,
          hostMonotonicNs: startMonotonicNs,
          wallClockMinusMonotonicNs: (BigInt(Math.trunc(wallClockEpochMs)) * 1_000_000n - BigInt(startMonotonicNs)).toString(),
        };
        const runId = hashBytes(Buffer.concat([ownerNonce, Buffer.from(input.serial), Buffer.from(startMonotonicNs)]));
        if (runs.has(runId)) throw new Error("run identifier collision");
        const ownerNonceHash = hashBytes(ownerNonce);
        const artifactRoot = reserveArtifactRoot(input.artifactRoot);
        const rootIdentity = ownedDirectoryIdentity(artifactRoot, "artifactRoot");
        const captureDirectory = path.join(artifactRoot, "captures");
        fs.mkdirSync(captureDirectory, { recursive: false, mode: 0o700 });
        const captureIdentity = ownedDirectoryIdentity(captureDirectory, "capture directory");
        const rootBinding = {
          artifactRoot,
          artifactRootDev: rootIdentity.dev,
          artifactRootIno: rootIdentity.ino,
          captureDirDev: captureIdentity.dev,
          captureDirIno: captureIdentity.ino,
          runId,
          ownerNonceHash,
        };
        privateWrite(path.join(artifactRoot, ".owner.json"), `${canonicalJson({ schemaVersion: 1, runId, ownerNonceHash })}\n`);
        assertOwnedRootValues(rootBinding);
        const capturePaths = {
          homeReference: path.join(captureDirectory, "000-home-reference.png"),
          appBaseline: path.join(captureDirectory, "010-app-baseline.png"),
        };
        const manifest = {
          schemaVersion: 1,
          runId,
          ownerNonceHash,
          createdAt: wallClockIso,
          clockCorrelation,
          serial: input.serial,
          scenario: input.scenario,
          provenance: input.provenance,
          normalizedRoute: routeScript.script,
          routeScriptSha256: routeScript.sha256,
          replaySource: input.route.source.kind === "replay" ? input.route.source.calibrationRouteRef : null,
          capture: input.capture,
        };
        privateWrite(path.join(artifactRoot, "run.json"), `${canonicalJson(manifest)}\n`);
        privateWrite(path.join(artifactRoot, "route-script.json"), routeScript.json);
        privateWrite(path.join(artifactRoot, "actions.jsonl"), "");
        privateWrite(path.join(artifactRoot, "continuity.jsonl"), "");
        privateWrite(path.join(artifactRoot, "logcat-index.json"), `${canonicalJson({ schemaVersion: 1, clockCorrelation: manifest.clockCorrelation, artifacts: [] })}\n`);
        assertOwnedRootValues(rootBinding);
        let preparation: BoundaryPreparationResult;
        try {
          preparation = await dependencies.collectPreparation({ input, runId, ownerNonceHash, artifactRoot, capturePaths, routeScript });
        } catch (error) {
          assertOwnedRootValues(rootBinding);
          const partial = error instanceof BoundaryPreparationFailure ? error.evidence : {};
          const failureText = redactSensitiveText(error, []);
          const captures = [partial.homeReference, partial.appBaseline]
            .filter((capture): capture is BoundaryCapture => capture !== undefined)
            .filter((capture) => {
              const expectedPath = capture.role === "home_reference" ? capturePaths.homeReference
                : capture.role === "app_baseline" ? capturePaths.appBaseline : null;
              if (expectedPath === null || capture.path !== expectedPath) throw new Error("preparation failure returned an unexpected diagnostic capture path or role");
              readBoundReviewImage(captureToReview(capture), artifactRoot);
              return true;
            });
          const requiredReview = [...new Map(captures.map((capture) => {
            const item = captureToReview(capture);
            return [item.captureSha256, item] as const;
          })).values()];
          const logArtifacts = partial.logArtifact ? [partial.logArtifact] : [];
          let runtimeHealth: PackageRuntimeHealthReceiptV1 | null = null;
          if (partial.runtimeHealth) runtimeHealth = checkedRuntimeHealth(partial.runtimeHealth, input.scenario.packageName, partial.logArtifact);
          for (const sample of partial.continuity ?? []) appendJsonLine(path.join(artifactRoot, "continuity.jsonl"), { scope: "preparation_failure", sample });
          const structuralStop = partial.structuralStop ?? "preparation_failed";
          const publicFailure = {
            status: "preparation_failed",
            runId,
            artifactRoot,
            routeScriptSha256: routeScript.sha256,
            structuralStop,
            error: failureText,
            homeClearance: partial.homeClearance ?? null,
            requiredReview,
            logArtifacts,
            runtimeHealth,
          };
          privateWrite(path.join(artifactRoot, "preparation.json"), `${canonicalJson(publicFailure)}\n`);
          privateWrite(path.join(artifactRoot, "preparation-failure.json"), `${canonicalJson(publicFailure)}\n`);
          atomicPrivateJson(path.join(artifactRoot, "state.json"), publicFailure);
          atomicPrivateJson(path.join(artifactRoot, "required-review.json"), requiredReview);
          replacePrivateJson(path.join(artifactRoot, "logcat-index.json"), {
            schemaVersion: 1,
            clockCorrelation: {
              runStart: clockCorrelation,
              note: "preparation failed after run reservation; retained logs and diagnostic frames remain hash-bound",
            },
            artifacts: logArtifacts,
            runtimeHealth: runtimeHealth ? [runtimeHealth] : [],
            tagInventory: runtimeHealth ? [{ sourceSha256: runtimeHealth.sourceSha256, tags: runtimeHealth.tagInventory }] : [],
          });
          assertOwnedRootValues(rootBinding);
          return {
            ...publicFailure,
            responseReview: requiredReview,
            visualReviewRequired: requiredReview.length > 0,
          };
        }
        assertOwnedRootValues(rootBinding);
        const { privateRuntime: _privateRuntime, ...publicPreparation } = preparation;
        privateWrite(path.join(artifactRoot, "preparation.json"), `${canonicalJson(publicPreparation)}\n`);
        const requiredReview = [captureToReview(preparation.homeReference), captureToReview(preparation.appBaseline)];
        for (const item of requiredReview) dependencies.readReviewImage(item, artifactRoot);
        const state: ExperimentState = {
          ...rootBinding,
          expiresAtEpochMs: Date.now() + RUN_TTL_MS,
          clockCorrelation,
          input,
          routeScript,
          waypoints: routeScript.script.waypoints,
          preparation,
          requiredReview,
          reviewed: new Map(),
          nextWaypoint: 0,
          usage: { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 0 },
          lastRequiredHash: preparation.appBaseline.sha256,
          rebaselineOrdinal: 0,
          structuralStop: null,
          routeAttempted: false,
          inputReleaseCertain: true,
          processAlive: true,
          bindingCoherent: true,
          lastForeground: "unknown",
          probeParse: "absent",
          probeSequence: "unknown",
          probeEvents: [],
          probeEventRecords: [],
          probeIssues: [],
          continuityIssueHistory: [],
          logArtifacts: preparation.logArtifact ? [preparation.logArtifact] : [],
          runtimeHealth: [],
          runtimeHealthFailure: false,
          runtimeHealthInconclusive: false,
          routeAdjudication: null,
          recoveryAttempted: false,
          recovery: null,
          recoveryAdjudication: null,
        };
        try {
          recordRuntimeHealth(state, preparation.runtimeHealth, preparation.logArtifact);
          aggregateContinuity(state, preparation.continuity);
          let preparationFailure: string | null = null;
          if (requiredReview.some((item) => !item.settled)) {
            state.structuralStop = "route_unsettled";
            preparationFailure = "prepare baseline capture did not settle";
          } else if (new Set(requiredReview.map((item) => item.captureSha256)).size !== requiredReview.length) {
            state.structuralStop = "route_unsettled";
            preparationFailure = "prepare produced ambiguous duplicate required capture hashes";
          } else if (!state.processAlive || state.runtimeHealthFailure) {
            state.structuralStop = "app_lifecycle_loss";
            preparationFailure = "prepared application reported process loss, crash, or ANR";
          } else if (state.runtimeHealthInconclusive) {
            state.structuralStop = "runtime_health_inconclusive";
            preparationFailure = "prepared application runtime-health scan was inconclusive";
          } else if (!state.bindingCoherent || state.lastForeground !== "exact_allowed") {
            state.structuralStop = "binding_lost";
            preparationFailure = "prepared application continuity does not match the exact bound foreground runtime";
          } else if (input.scenario.entryRoute === "dynamic_full"
            && (state.probeParse !== "ok" || state.probeSequence !== "complete" || state.probeIssues.length > 0
              || !hasExactDynamicOpenSequence(state.probeEventRecords, input.scenario.dynamicEntry!.expectedAcks))) {
            state.structuralStop = "terminal_signal_candidate";
            preparationFailure = "prepared dynamic Full probe history is incomplete, reordered, duplicated, or invalid";
          }
          atomicPrivateJson(path.join(artifactRoot, "state.json"), publicState(state));
          atomicPrivateJson(path.join(artifactRoot, "required-review.json"), requiredReview);
          persistState(state);
          if (preparationFailure) {
            scrubRuntime(state);
            persistState(state);
            privateWrite(path.join(artifactRoot, "preparation-failure.json"), `${canonicalJson({
              runId,
              structuralStop: state.structuralStop,
              error: preparationFailure,
              requiredReview,
              runtimeHealth: preparation.runtimeHealth,
            })}\n`);
            return {
              status: "preparation_failed",
              runId,
              artifactRoot,
              routeScriptSha256: routeScript.sha256,
              structuralStop: state.structuralStop,
              error: preparationFailure,
              requiredReview,
              responseReview: [...new Map(requiredReview.map((item) => [item.captureSha256, item])).values()],
              visualReviewRequired: true,
            };
          }
          runs.set(runId, state);
        } catch (error) {
          scrubRuntime(state);
          throw error;
        }
        return {
          status: "needs_baseline_review",
          runId,
          artifactRoot,
          routeScriptSha256: routeScript.sha256,
          requiredReview,
          responseReview: requiredReview,
          visualReviewRequired: true,
          structural: { runtimeBinding: preparation.runtimeBinding, applicationBinding: preparation.applicationBinding, logArtifact: preparation.logArtifact },
        };
      } finally {
        preparing -= 1;
      }
    }

    sweepExpired();
    const state = runs.get(input.runId);
    if (!state) throw new Error("unknown or expired boundary experiment runId");
    if (busyRuns.has(state.runId)) return { status: "action_in_progress", runId: state.runId, artifactRoot: state.artifactRoot };
    busyRuns.add(state.runId);
    try {
      assertOwnedRunRoot(state);
      if (input.action === "step") {
        if (state.routeAdjudication) return { status: "already_adjudicated", runId: state.runId, artifactRoot: state.artifactRoot };
        if (state.structuralStop) return terminalResponse(state);
        if (input.reviewedPriorFrame.captureSha256 !== state.lastRequiredHash) {
          return { status: "review_rejected", runId: state.runId, expectedCaptureSha256: state.lastRequiredHash, visualReviewRequired: true };
        }
        const priorItem = state.requiredReview.find((item) => item.captureSha256 === state.lastRequiredHash);
        if (!priorItem || !compatibleAttestation(priorItem, input.reviewedPriorFrame, state.input.scenario)
          || !retainsReviewedClaimsightLandmarks(state, input.reviewedPriorFrame)) {
          return { status: "review_rejected", runId: state.runId, expectedCaptureSha256: state.lastRequiredHash, visualReviewRequired: true };
        }
        try {
          dependencies.readReviewImage(priorItem, state.artifactRoot);
        } catch (error) {
          return {
            status: "review_rejected",
            runId: state.runId,
            expectedCaptureSha256: state.lastRequiredHash,
            reason: `reviewed evidence is no longer retained byte-exact: ${redactSensitiveText(error, [])}`,
            visualReviewRequired: true,
          };
        }
        state.reviewed.set(input.reviewedPriorFrame.captureSha256, input.reviewedPriorFrame);
        const reviewMayTerminate = priorItem.role === "waypoint" || priorItem.role === "transition";
        const terminalVisual = reviewMayTerminate && (
          input.reviewedPriorFrame.visibleState === "system_home"
          || input.reviewedPriorFrame.visibleState === "black_or_inconclusive"
          || input.reviewedPriorFrame.witnessedGateM === 32
          || (state.input.scenario.entryRoute === "dynamic_full" && input.reviewedPriorFrame.visibleState === "boundarylab_mixed")
        );
        if (terminalVisual || state.nextWaypoint >= state.waypoints.length) {
          state.structuralStop = terminalVisual ? "reviewed_terminal_or_outer_gate" : "script_exhausted";
          persistState(state);
          return terminalResponse(state);
        }
        const waypoint = state.waypoints[state.nextWaypoint];
        if (budgetProblem(state, waypoint)) {
          state.structuralStop = "budget_exhausted";
          persistState(state);
          return terminalResponse(state);
        }
        const retryingInitialWaypoint = state.nextWaypoint === 0 && state.rebaselineOrdinal > 0;
        const attemptOrdinal = retryingInitialWaypoint ? state.rebaselineOrdinal + 1 : 1;
        const attemptSuffix = attemptOrdinal === 1 ? "" : `-attempt-${attemptOrdinal}`;
        const capturePath = path.join(state.artifactRoot, "captures", `${100 + waypoint.seq}-waypoint-${waypoint.seq}${attemptSuffix}.png`);
        const stepLogPath = path.join(state.artifactRoot, `step-${100 + waypoint.seq}${attemptSuffix}-logcat-all.txt`);
        const preflightLogPath = path.join(state.artifactRoot, `step-${100 + waypoint.seq}${attemptSuffix}-preflight-logcat-all.txt`);
        state.routeAttempted = true;
        persistState(state);
        let executed: Awaited<ReturnType<BoundaryExperimentDependencies["executeWaypoint"]>>;
        try {
          executed = await dependencies.executeWaypoint({
            state,
            waypoint: structuredClone(waypoint),
            capturePath,
            stepLogPath,
            preflightLogPath,
            attemptOrdinal,
            remainingBudgets: remainingBudgets(state),
            recaptureReviewedFrame: (limits: Record<string, any> = {}) => dependencies.recaptureReviewedFrame({
              state,
              expectedSha256: state.lastRequiredHash,
              attestation: input.reviewedPriorFrame,
              ...limits,
            }),
          });
        } catch (error) {
          assertOwnedRunRoot(state);
          state.structuralStop = "action_failed";
          appendJsonLine(path.join(state.artifactRoot, "actions.jsonl"), { waypointSeq: waypoint.seq, status: "dependency_failed", error: error instanceof Error ? error.message : String(error) });
          persistState(state);
          return { ...terminalResponse(state), executionError: error instanceof Error ? error.message : String(error) };
        }
        assertOwnedRunRoot(state);
        appendJsonLine(path.join(state.artifactRoot, "actions.jsonl"), {
          waypointSeq: waypoint.seq,
          routeTrace: executed.routeTrace,
          capture: executed.capture,
          logArtifact: executed.logArtifact,
          preflightLogArtifact: executed.preflightLogArtifact ?? null,
          preflightRuntimeHealth: executed.preflightRuntimeHealth ?? null,
          ...(executed.captureError ? { captureError: executed.captureError } : {}),
          ...(executed.executionError ? { executionError: executed.executionError } : {}),
        });
        if (executed.preflightLogArtifact) state.logArtifacts.push(executed.preflightLogArtifact);
        if (executed.logArtifact) state.logArtifacts.push(executed.logArtifact);
        if (executed.preflightRuntimeHealth) recordRuntimeHealth(state, executed.preflightRuntimeHealth, executed.preflightLogArtifact);
        recordRuntimeHealth(state, executed.runtimeHealth, executed.logArtifact);
        const validPreflight = executed.preflight !== null
          && typeof executed.preflight.matches === "boolean"
          && SHA256.test(executed.preflight.sha256);
        if (validPreflight) aggregateContinuity(state, [executed.preflight!.continuity]);
        aggregateContinuity(state, executed.continuity);
        const usage = executed.routeTrace.usage ?? {};
        for (const key of ["actions", "waypoints", "holdMs", "dragPx", "durationMs"] as const) {
          const amount = Number(usage[key] ?? 0);
          if (!Number.isFinite(amount) || amount < 0) throw new Error(`route trace published invalid ${key} usage`);
          state.usage[key] += amount;
        }
        const traceStop = String(executed.routeTrace.status ?? "binding_lost");
        const preflightDrift = !validPreflight || !executed.preflight!.matches || executed.preflight!.sha256 !== state.lastRequiredHash
          || executed.preflight!.continuity.foreground !== "exact_allowed"
          || !state.processAlive || !state.bindingCoherent;
        if (preflightDrift && (Number(usage.actions ?? 0) !== 0 || Number(usage.waypoints ?? 0) !== 0
          || Number(usage.holdMs ?? 0) !== 0 || Number(usage.dragPx ?? 0) !== 0)) {
          throw new Error("waypoint dependency moved after its reviewed-frame preflight drifted");
        }
        if (traceStop === "input_release_uncertain") {
          state.inputReleaseCertain = false;
          state.structuralStop = "input_release_uncertain";
          scrubRuntime(state);
        }
        if (!executed.capture) {
          const exhaustedBeforeInput = traceStop === "budget_exhausted"
            && Number(usage.actions ?? 0) === 0
            && Number(usage.waypoints ?? 0) === 0;
          if (!state.structuralStop) state.structuralStop = exhaustedBeforeInput ? "budget_exhausted" : "route_unsettled";
          persistState(state);
          return { ...terminalResponse(state), routeTrace: executed.routeTrace, captureError: executed.captureError ?? "no transition capture was published" };
        }
        const completedWaypoint = Number(usage.waypoints ?? 0) === 1
          && executed.capture.settled
          && traceStop !== "route_unsettled"
          && !executed.executionError;
        const item = captureToReview({ ...executed.capture, role: completedWaypoint ? "waypoint" : "transition" }, completedWaypoint
          ? { waypointSeq: waypoint.seq, targetGateM: waypoint.targetGateM }
          : {});
        const duplicate = state.requiredReview.some((prior) => prior.captureSha256 === item.captureSha256);
        if (!duplicate) {
          state.requiredReview.push(item);
          state.lastRequiredHash = item.captureSha256;
        }
        if (completedWaypoint) state.nextWaypoint += 1;
        const hashOnlyReviewedFrameDrift = traceStop === "binding_lost"
          && executed.routeTrace.preMovementReviewDrift === true
          && validPreflight
          && executed.preflight!.matches === false
          && executed.preflight!.sha256 !== priorItem.captureSha256
          && executed.preflight!.sha256 === item.captureSha256
          && state.nextWaypoint === 0
          && state.rebaselineOrdinal === 0
          && state.usage.actions === 0
          && state.usage.waypoints === 0
          && state.usage.holdMs === 0
          && state.usage.dragPx === 0
          && Number(usage.actions ?? 0) === 0
          && Number(usage.waypoints ?? 0) === 0
          && Number(usage.holdMs ?? 0) === 0
          && Number(usage.dragPx ?? 0) === 0
          && Array.isArray(executed.routeTrace.waypoints)
          && executed.routeTrace.waypoints.length === 0
          && item.role === "transition"
          && item.settled
          && !duplicate
          && !executed.executionError
          && state.inputReleaseCertain
          && state.processAlive
          && state.bindingCoherent
          && !state.runtimeHealthFailure
          && !state.runtimeHealthInconclusive
          && executed.preflightRuntimeHealth?.status === "no_attributed_failure"
          && executed.runtimeHealth.status === "no_attributed_failure"
          && preflightHasExactBoundIdentity(state, executed.preflight!.continuity)
          && dynamicPreflightProbeAllowsMovement(state, executed.preflight!.continuity);
        if (hashOnlyReviewedFrameDrift) {
          state.rebaselineOrdinal = 1;
          state.structuralStop = null;
          persistState(state);
          return {
            status: "needs_baseline_review",
            runId: state.runId,
            artifactRoot: state.artifactRoot,
            structuralStop: null,
            rebaselineReason: "reviewed_frame_bytes_changed_without_binding_drift",
            usage: state.usage,
            routeTrace: executed.routeTrace,
            requiredReview: state.requiredReview,
            responseReview: [item],
            visualReviewRequired: true,
          };
        }
        if (traceStop === "input_release_uncertain") {
          state.inputReleaseCertain = false;
          state.structuralStop = "input_release_uncertain";
          scrubRuntime(state);
        } else if (!item.settled || traceStop === "route_unsettled" || traceStop === "action_failed" || duplicate) {
          state.structuralStop = "route_unsettled";
        } else if (traceStop === "binding_lost") {
          state.structuralStop = state.processAlive && state.bindingCoherent && state.lastForeground !== "exact_allowed"
            ? "terminal_signal_candidate"
            : "binding_lost";
        } else if (["budget_exhausted", "terminal_signal_candidate"].includes(traceStop)) {
          state.structuralStop = traceStop;
        }
        if (executed.executionError) state.structuralStop = "action_failed";
        if (!state.processAlive || state.runtimeHealthFailure) state.structuralStop = "app_lifecycle_loss";
        else if (state.runtimeHealthInconclusive) state.structuralStop = "runtime_health_inconclusive";
        else if (!state.bindingCoherent) state.structuralStop = "binding_lost";
        else if (preflightDrift) state.structuralStop = executed.preflight?.continuity.foreground === "exact_allowed"
          ? "binding_lost"
          : "terminal_signal_candidate";
        else if (state.input.scenario.entryRoute === "dynamic_full" && state.probeIssues.length > 0) state.structuralStop = "terminal_signal_candidate";
        persistState(state);
        return {
          status: "needs_waypoint_review",
          runId: state.runId,
          artifactRoot: state.artifactRoot,
          structuralStop: state.structuralStop,
          usage: state.usage,
          routeTrace: executed.routeTrace,
          requiredReview: state.requiredReview,
          responseReview: duplicate ? [] : [item],
          visualReviewRequired: true,
        };
      }

      if (input.action === "adjudicate") {
        if (input.scope === "route") {
          if (state.routeAdjudication) return { status: "already_adjudicated", runId: state.runId, artifactRoot: state.artifactRoot, ...state.routeAdjudication };
          if (!state.routeAttempted || (!state.structuralStop && state.nextWaypoint < state.waypoints.length)) {
            return { status: "adjudication_rejected", runId: state.runId, artifactRoot: state.artifactRoot, reason: "route has not reached an adjudication boundary" };
          }
          try {
            for (const item of state.requiredReview) dependencies.readReviewImage(item, state.artifactRoot);
          } catch (error) {
            return { status: "adjudication_rejected", runId: state.runId, artifactRoot: state.artifactRoot, reason: `required review evidence is no longer retained byte-exact: ${redactSensitiveText(error, [])}` };
          }
          for (const [captureSha256, prior] of state.reviewed) {
            const submitted = input.frameAttestations.find((item) => item.captureSha256 === captureSha256);
            if (!submitted || canonicalJson(submitted) !== canonicalJson(prior)) throw new Error("final adjudication changed or omitted a previously accepted frame review");
          }
          const attestedOuterWaypoint = state.requiredReview.some((item) => item.role === "waypoint"
            && input.frameAttestations.some((attestation) => attestation.captureSha256 === item.captureSha256 && attestation.witnessedGateM === 32));
          const outcome = deriveBoundaryRouteOutcome({
            scenario: state.input.scenario,
            requiredReview: state.requiredReview,
            attestations: input.frameAttestations,
            structural: {
              stop: state.structuralStop,
              inputReleaseCertain: state.inputReleaseCertain,
              processAlive: state.processAlive,
              bindingCoherent: state.bindingCoherent,
              routeComplete: state.usage.waypoints > 0 && (state.nextWaypoint >= state.waypoints.length || attestedOuterWaypoint),
              lastForeground: state.lastForeground,
              probeParse: state.probeParse,
              probeSequence: state.probeSequence,
              probeEvents: state.probeEvents,
              probeEventRecords: state.probeEventRecords,
              probeIssues: state.probeIssues,
              runtimeHealthFailure: state.runtimeHealthFailure,
              runtimeHealthInconclusive: state.runtimeHealthInconclusive,
            },
          });
          const adjudication = { runId: state.runId, ...outcome, routeScriptSha256: state.routeScript.sha256, requiredReview: state.requiredReview, frameAttestations: input.frameAttestations, adjudicatedAt: dependencies.now() };
          privateWrite(path.join(state.artifactRoot, "adjudication.json"), `${canonicalJson(adjudication)}\n`);
          state.routeAdjudication = adjudication;
          if (["retained_immersive_through_route", "no_ejection_within_observed_budget", "input_release_uncertain"].includes(outcome.outcome)) scrubRuntime(state);
          persistState(state);
          return { status: "route_adjudicated", runId: state.runId, artifactRoot: state.artifactRoot, ...outcome };
        }
        if (state.recoveryAdjudication) return { status: "already_adjudicated", runId: state.runId, artifactRoot: state.artifactRoot, ...state.recoveryAdjudication };
        if (!state.recovery || !state.recovery.complete || state.recovery.failed) {
          return { status: "recovery_rejected", runId: state.runId, reason: "the once-only recovery attempt has not reached a review-complete adjudication boundary" };
        }
        const uniqueItems = recoveryReviewItems(state);
        try {
          for (const item of uniqueItems) dependencies.readReviewImage(item, state.artifactRoot);
        } catch (error) {
          return { status: "adjudication_rejected", runId: state.runId, artifactRoot: state.artifactRoot, reason: `required recovery evidence is no longer retained byte-exact: ${redactSensitiveText(error, [])}` };
        }
        for (const [captureSha256, prior] of state.recovery.reviewed) {
          const submitted = input.frameAttestations.find((item) => item.captureSha256 === captureSha256);
          if (!submitted || canonicalJson(submitted) !== canonicalJson(prior)) throw new Error("final recovery adjudication changed or omitted a previously accepted fallback review");
        }
        const reviewed = exactReviewManifest(uniqueItems, input.frameAttestations, state.input.scenario);
        let recoveryResult = "recovery_inconclusive";
        let recoveredAtStep: string | null = null;
        const claimsightLandmarks = state.input.scenario.entryRoute === "editor_manifest_full"
          ? (state.routeAdjudication?.frameAttestations as VisualFrameAttestation[] | undefined)
            ?.find((frame) => frame.captureSha256 === state.preparation.appBaseline.sha256)?.sentinels ?? []
          : [];
        for (const step of state.recovery.steps) {
          if (!step.structuralOk) continue;
          if (!step.afterItem) continue;
          const frame = reviewed.get(step.afterItem.captureSha256)!;
          const exactExpected = recoveryFrameMatchesExpected(state.input.scenario, frame, claimsightLandmarks);
          if (!exactExpected) continue;
          recoveredAtStep = step.attributionKind;
          recoveryResult = step.attributionKind === "observe" ? "auto_resumed"
            : step.attributionKind === "reopen_stage" ? "stage_reopened"
              : step.attributionKind === "activity_launch" ? "activity_relaunch"
                : step.attributionKind === "activity_launch_ignored" ? "recovered_after_ignored_activity_launch"
                  : "force_stop_relaunch";
          break;
        }
        if (recoveredAtStep === null) {
          const terminal = state.recovery.steps.at(-1);
          const terminalFrame = terminal?.afterItem ? reviewed.get(terminal.afterItem.captureSha256) : undefined;
          const lookedStableWrongState = terminalFrame?.visibleState === "system_home"
            || (state.input.scenario.entryRoute === "dynamic_full" && terminalFrame?.visibleState === "boundarylab_mixed");
          if (terminal?.kind === "force_stop_relaunch"
            && terminal.attributionKind === "force_stop_relaunch"
            && terminal.structuralOk
            && terminal.afterItem?.settled === true
            && terminal.afterCapture?.settled === true
            && lookedStableWrongState) {
            recoveryResult = "unrecovered";
          }
        }
        const recoveryAdjudication = {
          runId: state.runId,
          recoveryResult,
          recoveredAtStep,
          requiredReview: uniqueItems,
          frameAttestations: input.frameAttestations,
          adjudicatedAt: dependencies.now(),
        };
        privateWrite(path.join(state.artifactRoot, "recovery-adjudication.json"), `${canonicalJson(recoveryAdjudication)}\n`);
        state.recoveryAdjudication = recoveryAdjudication;
        scrubRuntime(state);
        persistState(state);
        return { status: "recovery_adjudicated", artifactRoot: state.artifactRoot, ...recoveryAdjudication };
      }

      if (!state.routeAdjudication) return { status: "recovery_rejected", runId: state.runId, reason: "route adjudication is required first" };
      if (!state.inputReleaseCertain) return { status: "recovery_rejected", runId: state.runId, reason: "input release is uncertain" };
      if (["retained_immersive_through_route", "no_ejection_within_observed_budget"].includes(String(state.routeAdjudication.outcome))) {
        return { status: "recovery_rejected", runId: state.runId, reason: "adjudicated route has no terminal recovery condition" };
      }

      const readyForRecoveryAdjudication = (responseReview: RequiredReviewItem[] = []): Record<string, any> => ({
        status: "ready_for_recovery_adjudication",
        runId: state.runId,
        artifactRoot: state.artifactRoot,
        recoverySteps: state.recovery?.steps ?? [],
        requiredReview: recoveryReviewItems(state),
        responseReview,
        visualReviewRequired: true,
      });

      if (!state.recovery) {
        if (state.recoveryAttempted) return { status: "recovery_rejected", runId: state.runId, reason: "the once-only recovery attempt failed and cannot be repeated" };
        if (input.reviewedPriorFrame) return { status: "recovery_rejected", runId: state.runId, reason: "the first recovery call cannot attest a fallback frame that does not exist" };
        const order: RecoveryKind[] = state.input.scenario.entryRoute === "dynamic_full"
          ? ["observe", "activity_launch", "force_stop_relaunch"]
          : ["observe", "activity_launch", "force_stop_relaunch"];
        state.recoveryAttempted = true;
        state.recovery = { order, steps: [], reviewed: new Map(), usageMs: 0, complete: false, failed: false, stopAfterCurrent: false };
        try {
          persistRecovery(state);
          persistState(state);
        } catch (error) {
          const runtimeSecret = (state.preparation.privateRuntime as { secret?: string } | undefined)?.secret ?? "";
          state.recovery.failed = true;
          state.recovery.complete = true;
          state.recovery.stopAfterCurrent = true;
          scrubRuntime(state);
          return {
            status: "recovery_failed",
            runId: state.runId,
            artifactRoot: state.artifactRoot,
            reason: "the once-only recovery reservation could not be persisted",
            error: redactSensitiveText(error, [runtimeSecret]),
          };
        }
      } else {
        if (state.recovery.failed) return { status: "recovery_rejected", runId: state.runId, reason: "the once-only recovery attempt failed and cannot be repeated" };
        if (state.recovery.complete) return readyForRecoveryAdjudication();
        const priorStep = state.recovery.steps.at(-1);
        if (!priorStep?.afterItem || !input.reviewedPriorFrame
          || input.reviewedPriorFrame.captureSha256 !== priorStep.afterItem.captureSha256
          || !compatibleAttestation(priorStep.afterItem, input.reviewedPriorFrame, state.input.scenario)
          || !retainsReviewedClaimsightLandmarks(state, input.reviewedPriorFrame)) {
          return {
            status: "recovery_review_rejected",
            runId: state.runId,
            expectedCaptureSha256: priorStep?.afterItem?.captureSha256 ?? null,
            visualReviewRequired: true,
          };
        }
        try {
          dependencies.readReviewImage(priorStep.afterItem, state.artifactRoot);
        } catch (error) {
          return {
            status: "recovery_review_rejected",
            runId: state.runId,
            expectedCaptureSha256: priorStep.afterItem.captureSha256,
            reason: `reviewed recovery evidence is no longer retained byte-exact: ${redactSensitiveText(error, [])}`,
            visualReviewRequired: true,
          };
        }
        state.recovery.reviewed.set(input.reviewedPriorFrame.captureSha256, input.reviewedPriorFrame);
        if (priorStep.kind === "observe" && !state.recovery.order.includes("reopen_stage")) {
          const current = priorStep.continuity.at(-1);
          const includeReopen = shouldIncludeDynamicReopen({
            entryRoute: state.input.scenario.entryRoute,
            observedFrame: input.reviewedPriorFrame,
            observeStructuralOk: priorStep.structuralOk,
            exactBinding: current !== undefined && recoveryContinuityMatchesBinding(
              current,
              state.preparation.runtimeBinding,
              state.preparation.applicationBinding,
            ),
          });
          if (includeReopen) state.recovery.order.splice(1, 0, "reopen_stage");
        }
        const claimsightLandmarks = state.input.scenario.entryRoute === "editor_manifest_full"
          ? (state.routeAdjudication.frameAttestations as VisualFrameAttestation[] | undefined)
            ?.find((frame) => frame.captureSha256 === state.preparation.appBaseline.sha256)?.sentinels ?? []
          : [];
        if (priorStep.structuralOk && recoveryFrameMatchesExpected(state.input.scenario, input.reviewedPriorFrame, claimsightLandmarks)) {
          state.recovery.complete = true;
        } else if (state.recovery.stopAfterCurrent || state.recovery.steps.length >= state.recovery.order.length) {
          state.recovery.complete = true;
        }
        if (state.recovery.complete) {
          scrubRuntime(state);
          persistRecovery(state);
          persistState(state);
          return readyForRecoveryAdjudication();
        }
      }

      const recovery = state.recovery;
      const stepIndex = recovery.steps.length;
      const kind = recovery.order[stepIndex];
      const totalRemainingRecoveryMs = state.input.route.budgets.recoveryReserveMs - recovery.usageMs;
      if (!kind || totalRemainingRecoveryMs <= 0) {
        recovery.complete = true;
        recovery.stopAfterCurrent = true;
        scrubRuntime(state);
        persistRecovery(state);
        persistState(state);
        return readyForRecoveryAdjudication();
      }
      const remainingRecoveryMs = recoveryStepExecutionBudgetMs(state.input.scenario.entryRoute, kind);
      if (totalRemainingRecoveryMs < remainingRecoveryMs) {
        recovery.failed = true;
        recovery.complete = true;
        recovery.stopAfterCurrent = true;
        scrubRuntime(state);
        persistRecovery(state);
        persistState(state);
        return {
          status: "recovery_failed",
          runId: state.runId,
          artifactRoot: state.artifactRoot,
          reason: "the scenario recovery envelope no longer contains the exact next fallback budget",
          requiredMs: remainingRecoveryMs,
          remainingMs: totalRemainingRecoveryMs,
        };
      }

      let recovered: Awaited<ReturnType<BoundaryExperimentDependencies["executeRecoveryStep"]>>;
      const runtimeSecret = (state.preparation.privateRuntime as { secret?: string } | undefined)?.secret ?? "";
      try {
        recovered = await dependencies.executeRecoveryStep({
          state,
          kind,
          stepOrdinal: stepIndex + 1,
          captureDirectory: path.join(state.artifactRoot, "captures"),
          remainingRecoveryMs,
        });
      } catch (error) {
        const recoveryError = redactSensitiveText(error, [runtimeSecret]);
        recovery.failed = true;
        recovery.complete = true;
        recovery.stopAfterCurrent = true;
        scrubRuntime(state);
        let artifactError: string | null = null;
        try {
          assertOwnedRunRoot(state);
          appendJsonLine(path.join(state.artifactRoot, "actions.jsonl"), { recovery: "partial_failed", recoveryStep: kind, error: recoveryError });
          persistRecovery(state);
          persistState(state);
        } catch (persistenceError) {
          artifactError = redactSensitiveText(persistenceError, [runtimeSecret]);
        }
        return {
          status: "recovery_failed",
          runId: state.runId,
          artifactRoot: state.artifactRoot,
          reason: "the once-only recovery attempt failed after it was reserved; it will not be repeated",
          error: [recoveryError, artifactError ? `failure evidence could not be persisted: ${artifactError}` : null].filter(Boolean).join("; "),
        };
      }
      const recoveredCandidate = recovered as Partial<Awaited<ReturnType<BoundaryExperimentDependencies["executeRecoveryStep"]>>> | null;
      const terminalDependencyStep = stepIndex === recovery.order.length - 1
        || recoveredCandidate?.reserveExhausted === true
        || recoveredCandidate?.protocolStopped === true
        || recoveredCandidate?.afterCapture == null;
      if (terminalDependencyStep) scrubRuntime(state);
      try {
        assertOwnedRunRoot(state);
        if (recovered.kind !== kind) throw new Error("recovery dependency returned a different fallback kind");
        if (!Number.isFinite(recovered.durationMs) || recovered.durationMs < 0 || recovered.durationMs > remainingRecoveryMs) {
          throw new Error("recovery dependency exceeded or malformed its remaining reserve usage");
        }
        const captureDirectory = path.join(state.artifactRoot, "captures");
        for (const retained of [recovered.beforeCapture, recovered.afterCapture].filter((item): item is BoundaryCapture => item !== null)) {
          if (retained.role !== "recovery" || !isWithin(captureDirectory, retained.path)) throw new Error("recovery dependency returned a capture outside the owned recovery directory");
        }
        recordRecoveryContinuity(state, recovered.continuity);
        const recoveryLogArtifact = (recovered.receipt as any)?.logArtifact;
        if (recoveryLogArtifact) state.logArtifacts.push(recoveryLogArtifact);
        if (recovered.coverageRuntimeHealth) recordRuntimeHealth(state, recovered.coverageRuntimeHealth, recoveryLogArtifact);
        recordRuntimeHealth(state, recovered.runtimeHealth, recoveryLogArtifact);
        const effectiveStructuralOk = recovered.structuralOk && recovered.runtimeHealth.status === "no_attributed_failure";
        const beforeItem = recovered.beforeCapture ? captureToReview(recovered.beforeCapture, { recoveryStep: kind }) : null;
        const afterItem = recovered.afterCapture ? captureToReview(recovered.afterCapture, { recoveryStep: kind }) : null;
        recovery.steps.push({
          kind,
          attributionKind: recovered.attributionKind ?? kind,
          structuralOk: effectiveStructuralOk,
          beforeItem,
          afterItem,
          beforeCapture: recovered.beforeCapture,
          afterCapture: recovered.afterCapture,
          continuity: recovered.continuity,
          runtimeHealth: recovered.runtimeHealth,
          ...(recovered.coverageRuntimeHealth ? { coverageRuntimeHealth: recovered.coverageRuntimeHealth } : {}),
          receipt: recovered.receipt,
        });
        recovery.usageMs += Math.ceil(recovered.durationMs);
        recovery.stopAfterCurrent = terminalDependencyStep;
        if (afterItem === null) recovery.complete = true;
        appendJsonLine(path.join(state.artifactRoot, "actions.jsonl"), {
          recoveryStep: kind,
          structuralOk: effectiveStructuralOk,
          dependencyStructuralOk: recovered.structuralOk,
          runtimeHealth: recovered.runtimeHealth,
          coverageRuntimeHealth: recovered.coverageRuntimeHealth ?? null,
          durationMs: recovered.durationMs,
          receipt: recovered.receipt,
          beforeCapture: recovered.beforeCapture,
          afterCapture: recovered.afterCapture,
          reserveExhausted: recovered.reserveExhausted === true,
          protocolStopped: recovered.protocolStopped === true,
        });
        persistRecovery(state);
        persistState(state);
      } catch (error) {
        recovery.failed = true;
        recovery.complete = true;
        recovery.stopAfterCurrent = true;
        scrubRuntime(state);
        const recoveryError = redactSensitiveText(error, [runtimeSecret]);
        let artifactError: string | null = null;
        try {
          assertOwnedRunRoot(state);
          appendJsonLine(path.join(state.artifactRoot, "actions.jsonl"), { recovery: "invalid_dependency_receipt", recoveryStep: kind, error: recoveryError });
          persistRecovery(state);
          persistState(state);
        } catch (persistenceError) {
          artifactError = redactSensitiveText(persistenceError, [runtimeSecret]);
        }
        return {
          status: "recovery_failed",
          runId: state.runId,
          artifactRoot: state.artifactRoot,
          reason: "the once-only recovery dependency returned invalid evidence",
          error: [recoveryError, artifactError ? `failure evidence could not be persisted: ${artifactError}` : null].filter(Boolean).join("; "),
        };
      }
      const step = recovery.steps.at(-1)!;
      const responseReview = [...new Map([step.beforeItem, step.afterItem]
        .filter((item): item is RequiredReviewItem => item !== null)
        .map((item) => [item.captureSha256, item])).values()];
      if (recovery.complete) return readyForRecoveryAdjudication(responseReview);
      return {
        status: "needs_recovery_review",
        runId: state.runId,
        artifactRoot: state.artifactRoot,
        recoverySteps: recovery.steps,
        requiredReview: recoveryReviewItems(state),
        responseReview,
        visualReviewRequired: true,
      };
    } finally {
      busyRuns.delete(state.runId);
    }
  };
  return { execute };
}

/* Live dependencies are deliberately below the pure state machine so tests can replace every side
 * effect. They select one explicit adb serial, one qemu window and one app identity. */
function checkedAdb(result: Awaited<ReturnType<typeof run>>, label: string): string {
  if (result.code !== 0 || result.timedOut) throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  return result.stdout.trim();
}

export function parseResumedPackages(output: string): string[] {
  if (typeof output !== "string") throw new Error("activity state must be text");
  const indicator = /(?:topResumedActivity=|mResumedActivity:\s*|ResumedActivity:\s*)/;
  const rows = output.split(/\r?\n/).filter((line) => indicator.test(line));
  if (!rows.length) {
    if (/\bmCurrentFocus=null\b/.test(output)) return [];
    throw new Error("activity state is missing a recognized resumed-activity record");
  }
  const packages = rows.map((line) => {
    if (/(?:topResumedActivity=|mResumedActivity:\s*|ResumedActivity:\s*)null\b/.test(line)) return null;
    const matched = /(?:topResumedActivity=|mResumedActivity:\s*|ResumedActivity:\s*)ActivityRecord\{\S+\s+u\d+\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\//.exec(line);
    if (!matched) throw new Error("resumed activity state is malformed");
    return matched[1];
  }).filter((packageName): packageName is string => packageName !== null);
  return [...new Set(packages)];
}

export function parseThirdPartyPackages(output: string): Set<string> {
  if (typeof output !== "string") throw new Error("third-party package list must be text");
  const packages = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const matched = /^package:([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)$/.exec(line);
    if (!matched) throw new Error("third-party package list is malformed");
    return matched[1];
  });
  return new Set(packages);
}

export function classifyBoundaryForegrounds(
  resumedPackages: string[],
  thirdPartyPackages: Set<string>,
  targetPackage: string,
): Array<{ packageName: string; userInstalled: boolean }> {
  packageSchema.parse(targetPackage);
  if (!thirdPartyPackages.has(targetPackage)) {
    throw new Error(`third-party package inspection is missing target package '${targetPackage}'`);
  }
  return resumedPackages.map((packageName) => {
    packageSchema.parse(packageName);
    return { packageName, userInstalled: thirdPartyPackages.has(packageName) };
  });
}

export interface BoundarySystemHomeAdapter {
  forceStop(packageName: string): Promise<void>;
  inspectForegrounds(): Promise<Array<{ packageName: string; userInstalled: boolean }>>;
  sleep(ms: number): Promise<void>;
}

export interface BoundarySystemHomeReceipt {
  status: "cleared" | "failed";
  attemptedPackages: string[];
  stoppedPackages: string[];
  foregroundAfter: string[];
  classificationSource: "pm_list_packages_-3_exact";
  error: string | null;
}

export class BoundarySystemHomeError extends Error {
  readonly receipt: BoundarySystemHomeReceipt;

  constructor(message: string, receipt: BoundarySystemHomeReceipt) {
    super(message);
    this.name = "BoundarySystemHomeError";
    this.receipt = receipt;
  }
}

export async function clearBoundarySystemHome(
  targetPackage: string,
  adapter: BoundarySystemHomeAdapter,
): Promise<BoundarySystemHomeReceipt> {
  const attemptedPackages: string[] = [];
  const stoppedPackages: string[] = [];
  let foregroundAfter: string[] = [];
  try {
    packageSchema.parse(targetPackage);
    attemptedPackages.push(targetPackage);
    await adapter.forceStop(targetPackage);
    stoppedPackages.push(targetPackage);
    await adapter.sleep(2_000);
    let incumbentStops = 0;
    while (true) {
      const inspected = await adapter.inspectForegrounds();
      const foregrounds = new Map<string, boolean>();
      for (const foreground of inspected) {
        packageSchema.parse(foreground.packageName);
        const prior = foregrounds.get(foreground.packageName);
        if (prior !== undefined && prior !== foreground.userInstalled) {
          throw new Error(`foreground classification for '${foreground.packageName}' is contradictory`);
        }
        foregrounds.set(foreground.packageName, foreground.userInstalled);
      }
      foregroundAfter = [...foregrounds.keys()];
      const userPackages = [...foregrounds].filter(([, userInstalled]) => userInstalled).map(([packageName]) => packageName);
      const unowned = userPackages.filter((packageName) => !BOUNDARY_PREPARATION_OWNED_PACKAGES.has(packageName));
      if (unowned.length) {
        throw new Error(`refusing to force-stop unowned foreground package(s): ${unowned.join(", ")}`);
      }
      if (!userPackages.length) {
        return {
          status: "cleared",
          attemptedPackages,
          stoppedPackages,
          foregroundAfter,
          classificationSource: "pm_list_packages_-3_exact",
          error: null,
        };
      }
      if (incumbentStops + userPackages.length > 3) {
        throw new Error(`bounded incumbent teardown did not yield to system home; owned foreground package(s) remain: ${userPackages.join(", ")}`);
      }
      for (const packageName of userPackages) {
        attemptedPackages.push(packageName);
        await adapter.forceStop(packageName);
        stoppedPackages.push(packageName);
        incumbentStops++;
      }
      await adapter.sleep(2_000);
    }
  } catch (error) {
    if (error instanceof BoundarySystemHomeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new BoundarySystemHomeError(message, {
      status: "failed",
      attemptedPackages,
      stoppedPackages,
      foregroundAfter,
      classificationSource: "pm_list_packages_-3_exact",
      error: message,
    });
  }
}

async function clearLiveBoundarySystemHome(adb: string, serial: string, targetPackage: string): Promise<BoundarySystemHomeReceipt> {
  return clearBoundarySystemHome(targetPackage, {
    forceStop: async (packageName) => {
      checkedAdb(
        await run(adb, ["-s", serial, "shell", "am", "force-stop", packageName], { timeoutMs: 10_000 }),
        `force-stop ${packageName}`,
      );
    },
    inspectForegrounds: async () => {
      const activities = checkedAdb(
        await run(adb, ["-s", serial, "shell", "dumpsys", "activity", "activities"], { timeoutMs: 20_000, maxOutputBytes: 8 * 1024 * 1024 }),
        "foreground activity inspection",
      );
      const resumedPackages = parseResumedPackages(activities);
      const thirdPartyPackages = parseThirdPartyPackages(checkedAdb(
        await run(adb, ["-s", serial, "shell", "pm", "list", "packages", "-3"], { timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }),
        "third-party package inspection",
      ));
      return classifyBoundaryForegrounds(resumedPackages, thirdPartyPackages, targetPackage);
    },
    sleep,
  });
}

async function collectRuntimeHealthSnapshot(input: {
  adb: string;
  serial: string;
  artifactPath: string;
  marker: string;
  packageName: string;
  expectedPids: readonly number[];
  secrets: readonly string[];
  timeoutMs?: number;
}): Promise<{ receipt: RuntimeLogSnapshotReceipt; health: PackageRuntimeHealthReceiptV1 }> {
  const timeoutMs = input.timeoutMs === undefined
    ? WAYPOINT_HEALTH_SNAPSHOT_RESERVE_MS
    : Math.max(1, Math.min(WAYPOINT_HEALTH_SNAPSHOT_RESERVE_MS, Math.floor(input.timeoutMs)));
  const result = await run(input.adb, ["-s", input.serial, "logcat", "-b", "all", "-d", "-v", "threadtime"], {
    timeoutMs,
    maxOutputBytes: LOG_ARTIFACT_MAX_BYTES,
  });
  if (result.code !== 0 || result.timedOut || result.stderr.includes("output exceeded maxOutputBytes")) {
    throw new Error(`pre-movement runtime-health snapshot failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
  let sanitized = result.stdout;
  for (const secret of [...new Set(input.secrets.filter(Boolean))]) {
    sanitized = sanitized.split(secret).join(`[capability-sha256:${hashBytes(secret)}]`);
  }
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.length > LOG_ARTIFACT_MAX_BYTES) throw new Error("pre-movement runtime-health snapshot exceeded its byte cap after redaction");
  assertExternalCapturePath(input.artifactPath);
  privateWriteBytes(input.artifactPath, bytes);
  const retained = regularExternalFile(input.artifactPath, "pre-movement runtime-health snapshot", LOG_ARTIFACT_MAX_BYTES);
  const receipt: RuntimeLogSnapshotReceipt = {
    status: "snapshot_collected",
    truncated: false,
    observedBytes: retained.length,
    appStartMarker: input.marker,
    appStartMarkerObserved: retained.includes(Buffer.from(input.marker, "utf8")),
    rawArtifact: { path: input.artifactPath, sha256: hashBytes(retained), bytes: retained.length },
  };
  return { receipt, health: scanPackageRuntimeHealth(receipt, input.packageName, input.expectedPids) };
}

function checkedDynamicBroadcast(result: Awaited<ReturnType<typeof run>>, label: string): string {
  const output = checkedAdb(result, label);
  if (!/Broadcast completed:\s*result=-1,\s*data="accepted"/.test(output)) {
    throw new Error(`${label} was not accepted by the exact BoundaryProbe receiver: ${output || "empty acknowledgement"}`);
  }
  return output;
}

export function classifyActivityLaunchDisposition(
  output: string,
  commandSucceeded: boolean,
): "accepted" | "ignored" | "blocked" {
  if (!commandSucceeded) return "blocked";
  if (/Warning:\s*Activity not started/i.test(output)) return "ignored";
  if (/(?:^|\n)(?:Error|Exception):|(?:^|\n)Status:\s*(?!ok\b)\S+/i.test(output)) return "blocked";
  if (/(?:^|\n)Status:\s*ok\b/i.test(output)) return "accepted";
  return "blocked";
}

function checkedLogWindow(receipt: Awaited<ReturnType<typeof collectLogWindow>>, label: string): typeof receipt {
  if (receipt.status !== "collected" || !receipt.appStartMarkerObserved || receipt.termination === "unconfirmed"
    || receipt.truncated || receipt.stopReason !== "caller_stop") {
    throw new Error(`${label} did not publish a complete marker-bound log window (${receipt.status}/${receipt.termination}/marker=${receipt.appStartMarkerObserved})`);
  }
  return receipt;
}

function inconclusiveRuntimeHealth(
  packageName: string,
  marker: string,
  expectedPids: readonly number[],
): PackageRuntimeHealthReceiptV1 {
  return {
    schemaVersion: 1,
    sourceSha256: null,
    packageName,
    expectedPids: [...new Set(expectedPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))],
    marker,
    markerOccurrences: 0,
    status: "inconclusive",
    incidents: [],
    ambiguousCandidateCount: 0,
    ignoredOtherPackageCount: 0,
    scannedBytes: 0,
    tagInventory: [],
  };
}

function redactSensitiveText(value: unknown, secrets: readonly string[]): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join(`[capability-sha256:${hashBytes(secret)}]`);
  return text;
}

function removeFailedSecretArtifact(artifactPath: string): { absent: true } | { absent: false; detail: string } {
  try {
    const stat = fs.lstatSync(artifactPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { absent: false, detail: "exact path exists but is not the expected regular artifact" };
    }
    fs.unlinkSync(artifactPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { absent: true };
    return { absent: false, detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    fs.lstatSync(artifactPath);
    return { absent: false, detail: "exact path still exists after unlink" };
  } catch (error: any) {
    return error?.code === "ENOENT"
      ? { absent: true }
      : { absent: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

class FinalizedLogOperationError extends Error {
  readonly logArtifact: any;

  constructor(message: string, logArtifact: any) {
    super(message);
    this.name = "FinalizedLogOperationError";
    this.logArtifact = logArtifact;
  }
}

export async function runWithFinalizedLog<T>(input: {
  promise: ReturnType<typeof collectLogWindow>;
  stop: () => void;
  artifactPath: string;
  label: string;
  secrets: () => readonly string[];
  operation: () => Promise<T>;
  tailMs?: number;
}): Promise<{ value: T; logArtifact: any }> {
  const settledLog = input.promise.then(
    (receipt) => ({ ok: true as const, receipt }),
    (error) => ({ ok: false as const, error }),
  );
  let value: T | undefined;
  let operationError: unknown;
  try {
    value = await input.operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await sleep(input.tailMs ?? 500);
  } catch (error) {
    operationError ??= error;
  }
  try {
    input.stop();
  } catch (error) {
    operationError ??= error;
  }
  let receipt: Awaited<ReturnType<typeof collectLogWindow>>;
  try {
    const outcome = await settledLog;
    if (!outcome.ok) throw outcome.error;
    receipt = outcome.receipt;
    let sanitized: any = receipt;
    for (const secret of [...new Set(input.secrets().filter(Boolean))]) sanitized = redactCapabilityFromLogArtifact(sanitized, secret);
    receipt = checkedLogWindow(sanitized, input.label);
  } catch (error) {
    const cleanup = removeFailedSecretArtifact(input.artifactPath);
    const collectorFailure = redactSensitiveText(error, input.secrets());
    const first = operationError ?? error;
    if (!cleanup.absent) {
      throw new Error(`${input.label} failed and raw capability artifact absence could not be proven at the exact path (${cleanup.detail}): ${redactSensitiveText(first, input.secrets())}`);
    }
    if (collectorFailure.includes("raw staging artifact absence could not be proven")) {
      throw new Error(`${input.label} failed: ${collectorFailure}`);
    }
    throw new Error(`${input.label} failed with no retained raw capability log: ${redactSensitiveText(first, input.secrets())}`);
  }
  if (operationError !== undefined) {
    throw new FinalizedLogOperationError(
      `${input.label} operation failed after its log was capability-sanitized: ${redactSensitiveText(operationError, input.secrets())}`,
      receipt,
    );
  }
  return { value: value as T, logArtifact: receipt };
}

function startOwnedLogWindow(input: Omit<Parameters<typeof collectLogWindow>[0], "stopSignal" | "onStarted">): {
  promise: ReturnType<typeof collectLogWindow>;
  stop: () => void;
  started: () => boolean;
} {
  const controller = new AbortController();
  let childStarted = false;
  const promise = collectLogWindow({
    ...input,
    stopSignal: controller.signal,
    onStarted: () => { childStarted = true; },
  });
  return {
    promise,
    stop: () => controller.abort(),
    started: () => childStarted,
  };
}

type CheckedAdbRunner = (args: string[], timeoutMs: number, label: string) => Promise<string>;

export async function probeBoundedCaptureIdentity(
  serial: string,
  boundedTimeout: (capMs: number, label: string) => number,
  checkedRun: CheckedAdbRunner,
): Promise<CaptureLiveIdentity> {
  const prop = async (name: string, label: string): Promise<string> => checkedRun(
    ["-s", serial, "shell", "getprop", name],
    boundedTimeout(10_000, label),
    label,
  );
  const bootId = async (): Promise<string> => checkedRun(
    ["-s", serial, "shell", "cat", "/proc/sys/kernel/random/boot_id"],
    boundedTimeout(10_000, "bounded boot identity probe"),
    "bounded boot identity probe",
  );
  const results = await Promise.allSettled([
    prop("ro.product.model", "bounded model identity probe"),
    prop("ro.build.fingerprint", "bounded fingerprint identity probe"),
    prop("ro.boot.qemu", "bounded qemu identity probe"),
    bootId(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  const [model, fingerprint, bootQemu, boot] = results.map((result) => {
    if (result.status !== "fulfilled") throw new Error("bounded identity probe settlement is inconsistent");
    return result.value;
  });
  return { serial, model, fingerprint, bootQemu, bootId: boot, observedAt: new Date().toISOString() };
}

async function liveCapture(
  adb: string,
  input: PrepareInput,
  outPath: string,
  role: BoundaryCapture["role"],
  remainingMs?: () => number,
  priorSha256?: string,
): Promise<BoundaryCapture> {
  const boundedTimeout = (capMs: number, label: string): number => {
    if (!remainingMs) return capMs;
    const remaining = Math.floor(remainingMs());
    if (!Number.isFinite(remaining) || remaining < 1) throw new Error(`${label} refused because the recovery reserve is exhausted`);
    return Math.max(1, Math.min(capMs, remaining));
  };
  const identity = async (serial: string) => {
    if (!remainingMs) {
      const probed = await probeDeviceIdentity(adb, serial);
      const bootId = checkedAdb(await run(adb, ["-s", serial, "shell", "cat", "/proc/sys/kernel/random/boot_id"], { timeoutMs: 10_000 }), "boot identity probe");
      return { ...probed, bootId, observedAt: new Date().toISOString() };
    }
    return probeBoundedCaptureIdentity(serial, boundedTimeout, async (args, timeoutMs, label) => checkedAdb(
      await run(adb, args, { timeoutMs }),
      label,
    ));
  };
  const captured = await executeCaptureSettled({
    serial: input.serial,
    outPath,
    maxTries: input.capture.maxTries,
    intervalMs: input.capture.intervalMs,
    comparison: SETTLE_COMPARISON,
    ...(priorSha256 ? { priorSha256 } : {}),
  }, {
    monotonicNs: () => process.hrtime.bigint(),
    listOnlineSerials: async () => {
      const output = checkedAdb(await run(adb, ["devices", "-l"], { timeoutMs: boundedTimeout(10_000, "adb devices") }), "adb devices");
      return output.split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter((fields) => fields[1] === "device").map((fields) => fields[0]);
    },
    probeIdentity: identity,
    capture: (serial) => captureAdbFrame(adb, serial, boundedTimeout(input.capture.attemptTimeoutMs, "bounded recovery screencap")),
    sleep: async (milliseconds) => {
      if (remainingMs && remainingMs() < milliseconds) throw new Error("capture settlement delay would exceed the recovery reserve");
      await sleep(milliseconds);
    },
    hash: sha256Bytes,
    writeFrame: (absolutePath, bytes) => fs.writeFileSync(absolutePath, bytes, { mode: 0o600 }),
  });
  const ref = captured.receipt.captureRef;
  if (!ref || !captured.receipt.sha256 || !captured.receipt.path) throw new Error(`${role} capture failed: ${captured.receipt.error?.detail ?? captured.receipt.status}`);
  return {
    role,
    path: captured.receipt.path,
    sha256: captured.receipt.sha256,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    settled: captured.receipt.status === "settled" && captured.receipt.settlementSatisfied,
    receipt: captured.receipt,
  };
}

async function currentApplicationBinding(
  adb: string,
  input: PrepareInput,
  checkedRun: CheckedAdbRunner = async (args, timeoutMs, label) => checkedAdb(await run(adb, args, { timeoutMs }), label),
): Promise<{ binding: BoundApplicationIdentity; bootId: string }> {
  const serialArgs = ["-s", input.serial];
  const bootId = await checkedRun([...serialArgs, "shell", "cat", "/proc/sys/kernel/random/boot_id"], 10_000, "boot identity");
  const packagePathOutput = await checkedRun([...serialArgs, "shell", "pm", "path", input.scenario.packageName], 10_000, "installed package path");
  const installedPath = parseInstalledApkPath(packagePathOutput);
  if (!installedPath) throw new Error("installed package path was not uniquely parseable");
  const digestOutput = await checkedRun([...serialArgs, "shell", "toybox", "sha256sum", installedPath], 10_000, "installed APK digest");
  const apkSha256 = parseRemoteSha256(digestOutput);
  const digestLines = digestOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (digestLines.length !== 1 || !digestLines[0].endsWith(` ${installedPath}`) || apkSha256 !== input.provenance.apkSha256) {
    throw new Error("installed APK path/digest does not match prepare provenance");
  }
  const pid = parsePid(await checkedRun([...serialArgs, "shell", "pidof", input.scenario.packageName], 10_000, "application PID"));
  if (!pid) throw new Error("application PID was not uniquely parseable");
  const pidStartTicks = parseProcStartTicks(await checkedRun([...serialArgs, "shell", "cat", `/proc/${pid}/stat`], 10_000, "application start ticks"));
  if (!pidStartTicks) throw new Error("application PID start ticks were not parseable");
  return {
    bootId,
    binding: { packageName: input.scenario.packageName, apkSha256, allowedResumedComponents: [...input.scenario.allowedResumedComponents], pid, pidStartTicks },
  };
}

export function recoveryContinuityMatchesBinding(
  sample: ApplicationContinuitySample,
  runtimeBinding: RuntimeBindingReceipt,
  applicationBinding: BoundApplicationIdentity,
): boolean {
  return sample.serial === runtimeBinding.serial
    && sample.bootId === runtimeBinding.bootId
    && sample.packageName === applicationBinding.packageName
    && sample.apkSha256 === applicationBinding.apkSha256
    && sample.pid === applicationBinding.pid
    && sample.pidStartTicks === applicationBinding.pidStartTicks
    && canonicalJson([...sample.allowedResumedComponents].sort()) === canonicalJson([...applicationBinding.allowedResumedComponents].sort())
    && sample.foreground === "exact_allowed"
    && sample.resumedComponents.some((component) => applicationBinding.allowedResumedComponents.includes(component));
}

export function waypointPreflightAllowsMovement(
  preflight: { matches: boolean; sha256: string; continuity: ApplicationContinuitySample },
  expectedSha256: string,
  runtimeBinding: RuntimeBindingReceipt,
  applicationBinding: BoundApplicationIdentity,
  entryRoute: BoundaryScenario["entryRoute"] = "dynamic_full",
): boolean {
  return preflight.matches
    && preflight.sha256 === expectedSha256
    && recoveryContinuityMatchesBinding(preflight.continuity, runtimeBinding, applicationBinding)
    && (entryRoute !== "dynamic_full" || (
      !["malformed", "truncated"].includes(preflight.continuity.probeParse)
      && !["gap", "wrong_session", "wrong_generation"].includes(preflight.continuity.probeSequence)
      && !preflight.continuity.probeEventsSincePrior.some((event) =>
        event.kind === "explicit_close_requested" || event.kind === "explicit_close_returned")
    ));
}

export function chargeWaypointElapsedDuration(
  routeTrace: Record<string, any>,
  startedNs: bigint,
  finishedNs: bigint,
): Record<string, any> {
  if (finishedNs < startedNs) throw new Error("monotonic waypoint duration cannot be negative");
  const existingDurationMs = Number(routeTrace.usage?.durationMs ?? 0);
  if (!Number.isFinite(existingDurationMs) || existingDurationMs < 0) throw new Error("waypoint trace published invalid duration usage");
  const elapsedNs = finishedNs - startedNs;
  const elapsedMs = elapsedNs === 0n ? 0 : Number((elapsedNs + 999_999n) / 1_000_000n);
  return {
    ...routeTrace,
    usage: { ...routeTrace.usage, durationMs: Math.max(existingDurationMs, elapsedMs) },
  };
}

export function remainingWaypointOperationMs(
  deadlineNs: bigint,
  observedNs: bigint,
  reserveMs: readonly number[],
): number {
  if (typeof deadlineNs !== "bigint" || typeof observedNs !== "bigint" || observedNs < 0n
    || !Array.isArray(reserveMs)
    || reserveMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("invalid waypoint deadline or reserve envelope");
  }
  if (observedNs >= deadlineNs) return 0;
  const remainingNs = deadlineNs - observedNs;
  const remainingMs = Number(remainingNs / 1_000_000n);
  const reservedMs = reserveMs.reduce((sum, value) => sum + value, 0);
  return Math.max(0, remainingMs - reservedMs);
}

export function waypointTransitionCapturePath(waypointCapturePath: string): string {
  if (!path.isAbsolute(waypointCapturePath) || path.extname(waypointCapturePath) !== ".png") {
    throw new Error("waypoint capture path must be an absolute PNG path");
  }
  const parsed = path.parse(waypointCapturePath);
  return path.join(parsed.dir, `${parsed.name}-transition.png`);
}

export function waypointCoverageMarker(runId: string, waypointSeq: number, attemptOrdinal: number): string {
  return `boundary_gap_${runId.slice(0, 12)}_step_${waypointSeq}_${attemptOrdinal}`;
}

export function finalizedWaypointRuntimeHealth(
  receipt: Parameters<typeof scanPackageRuntimeHealth>[0],
  packageName: string,
  expectedPids: readonly number[],
  marker: string,
): PackageRuntimeHealthReceiptV1 {
  return scanPackageRuntimeHealth({
    ...receipt,
    appStartMarker: marker,
    appStartMarkerObserved: true,
  }, packageName, expectedPids);
}

async function dumpRelevantLogLines(
  adb: string,
  serial: string,
  pid: number,
  sessionId: string,
  generation: number,
  priorSeq: number | null,
  logStartMarker: string,
  timeoutMs = 12_000,
): Promise<{ lines: string[]; truncated: boolean }> {
  const result = await run(adb, ["-s", serial, "logcat", "-b", "all", "-d", "-v", "threadtime"], { timeoutMs, maxOutputBytes: LOG_ARTIFACT_MAX_BYTES });
  if (result.code !== 0 || result.timedOut || result.stderr.includes("output exceeded maxOutputBytes")) return { lines: [], truncated: true };
  const scoped = scopeContinuityLogLines(result.stdout, { marker: logStartMarker, pid, sessionId, generation, priorSeq });
  return { lines: scoped.lines, truncated: scoped.truncated };
}

export function scopeContinuityLogLines(
  output: string,
  options: { marker: string; pid: number; sessionId: string; generation: number; priorSeq: number | null },
): { lines: string[]; truncated: boolean; markerObserved: boolean } {
  if (typeof output !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(options.marker)) {
    return { lines: [], truncated: true, markerObserved: false };
  }
  const allLines = output.split(/\r?\n/).filter(Boolean);
  const markerIndexes = allLines.flatMap((line, index) => {
    const record = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+[1-9]\d*\s+\d+\s+[VDIWEF]\s+BoundaryExperiment\s*:\s?(.*)$/.exec(line);
    return record?.[1]?.trim() === options.marker ? [index] : [];
  });
  if (markerIndexes.length !== 1) return { lines: [], truncated: true, markerObserved: false };
  const lines = allLines.slice(markerIndexes[0] + 1).filter((line) => {
    const parsed = parseBoundaryProbeLogRecordV1(line, options.pid);
    if (parsed.status !== "ok") return true;
    return parsed.event.sessionId !== options.sessionId
      || parsed.event.generation !== options.generation
      || options.priorSeq === null
      || parsed.event.seq > options.priorSeq;
  });
  return { lines, truncated: false, markerObserved: true };
}

interface ContinuitySamplerCursor {
  sessionId: string;
  generation: number;
  priorSeq: number | null;
  watchdogPrior: { focus: string; lastRenderTime: string } | null;
  logStartMarker: string;
}

function continuitySamplerCursor(state: ExperimentState, logStartMarker: string): ContinuitySamplerCursor {
  return {
    sessionId: state.preparation.probe.sessionId ?? crypto.randomUUID(),
    generation: state.preparation.probe.generation ?? 1,
    priorSeq: null,
    watchdogPrior: null,
    logStartMarker,
  };
}

function sampleContinuityFactory(
  adb: string,
  state: ExperimentState,
  cursor: ContinuitySamplerCursor,
  remainingMs?: () => number,
) {
  const expectedSessionId = state.preparation.probe.sessionId;
  const expectedGeneration = state.preparation.probe.generation;
  if ((expectedSessionId !== null && cursor.sessionId !== expectedSessionId)
    || (expectedGeneration !== null && cursor.generation !== expectedGeneration)) {
    throw new Error("continuity sampler cursor does not match the bound probe session/generation");
  }
  return async (): Promise<ApplicationContinuitySample> => {
    if (remainingMs && remainingMs() < APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS) {
      throw new Error("application continuity sampling refused because its bounded reserve is unavailable");
    }
    const sample = await sampleApplicationContinuity({
      adbPath: adb,
      binding: { serial: state.input.serial, bootId: state.preparation.runtimeBinding.bootId, ...state.preparation.applicationBinding },
      probe: { sessionId: cursor.sessionId, generation: cursor.generation, priorSeq: cursor.priorSeq },
      watchdogPrior: cursor.watchdogPrior,
    }, {
      runText: run,
      readLogLines: () => dumpRelevantLogLines(
        adb,
        state.input.serial,
        state.preparation.applicationBinding.pid,
        cursor.sessionId,
        cursor.generation,
        cursor.priorSeq,
        cursor.logStartMarker,
        remainingMs ? Math.max(1, Math.min(8_000, Math.floor(remainingMs()))) : 12_000,
      ),
      monotonicNs: () => process.hrtime.bigint(),
    });
    if (remainingMs && remainingMs() < 1) throw new Error("application continuity sampling exceeded the recovery reserve");
    const events = sample.probeEventsSincePrior.filter((event) => event.sessionId === cursor.sessionId && event.generation === cursor.generation);
    if (events.length) cursor.priorSeq = events.at(-1)!.seq;
    if (sample.watchdog.focus && sample.watchdog.lastRenderTime) cursor.watchdogPrior = { focus: sample.watchdog.focus, lastRenderTime: sample.watchdog.lastRenderTime };
    return sample;
  };
}

function runtimeReceipt(serial: string, bootId: string, window: BoundQemuWindow): RuntimeBindingReceipt {
  if (!window.qemuPid) throw new Error("qemu discovery binding did not expose a concrete PID");
  return {
    serial,
    bootId,
    grpc: { discoveryFile: window.discoveryFile, qemuPid: window.qemuPid, address: window.address, ...(window.tokenFingerprint ? { tokenFingerprint: window.tokenFingerprint } : {}) },
    qemuWindow: { ownerPid: window.qemuWindowOwnerPid, windowId: window.qemuWindowId },
  };
}

function createLiveBoundaryExperimentDependencies(): BoundaryExperimentDependencies {
  const adb = resolveAdb();
  return {
    randomBytes: (size) => crypto.randomBytes(size),
    now: () => new Date().toISOString(),
    monotonicNs: () => process.hrtime.bigint(),
    readNativeRunReceipt,
    readReviewImage: readBoundReviewImage,
    collectPreparation: async (context) => {
      const input = context.input as PrepareInput;
      if (input.provenance.kind === "native_run_receipt") {
        const receipt = readNativeRunReceipt(input.scenario.packageName, input.provenance.receiptId);
        if (receipt.status !== "valid") throw new Error(`native run receipt is invalid: ${receipt.issues.join("; ")}`);
        const expected = GENERATED_SCENARIOS[input.scenario.entryRoute as keyof typeof GENERATED_SCENARIOS];
        if (!expected) throw new Error("native receipt provenance is available only for a generated Boundary Lab row");
        if (receipt.receipt.receiptId !== input.provenance.receiptId
          || receipt.receipt.app !== input.scenario.packageName
          || receipt.receipt.apk.packageName !== input.scenario.packageName
          || receipt.receipt.install.packageName !== input.scenario.packageName
          || receipt.receipt.apk.sha256 !== input.provenance.apkSha256
          || receipt.receipt.install.remoteApkSha256 !== input.provenance.apkSha256
          || receipt.receipt.runtime.component !== input.scenario.launchComponent
          || receipt.receipt.runtime.serial !== input.serial) {
          throw new Error("native run receipt does not bind the requested package, component, APK, and serial");
        }
        if (receipt.receipt.source.effectiveAppSpec.sha256 !== expected.effectiveSpecSha256) {
          throw new Error("native run receipt does not bind the CP2-qualified effective Boundary Lab AppSpec");
        }
        const spec = readReceiptBoundEffectiveAppSpec(
          receipt.receipt.source.effectiveAppSpec.artifactPath,
          receipt.receipt.source.effectiveAppSpec,
        );
        if (spec?.meta?.packageName !== expected.packageName
          || spec?.meta?.stageStyle !== expected.stageStyle
          || spec?.boundaryLab?.variant !== expected.variant
          || canonicalJson(spec?.boundaryLab?.gateSequenceM) !== canonicalJson(GATES)) {
          throw new Error("effective AppSpec route, variant, or Boundary Lab gates contradict the exact scenario");
        }
      } else {
        const identity = hashRegularExternalFile(input.provenance.apkPath, "imported APK", APK_ARTIFACT_MAX_BYTES);
        if (identity.sha256 !== input.provenance.apkSha256) throw new Error("imported APK sha256 does not match provenance");
      }
      const selected = await bindMacQemuWindow(adb, input.serial);
      if (!selected.ok) throw new Error(`${selected.code}: ${selected.detail}`);
      if (selected.binding.bindingMethod !== "discovery-pid-window"
        || !selected.binding.qemuPid
        || selected.binding.qemuWindowOwnerPid !== selected.binding.qemuPid) {
        throw new Error("application-aware boundary preparation requires an exact discovery PID to qemu-window binding");
      }
      let homeClearance: BoundarySystemHomeReceipt;
      try {
        homeClearance = await clearLiveBoundarySystemHome(adb, input.serial, input.scenario.packageName);
      } catch (error) {
        if (error instanceof BoundarySystemHomeError) {
          throw new BoundaryPreparationFailure(error.message, { homeClearance: error.receipt, structuralStop: "preparation_failed" });
        }
        throw new BoundaryPreparationFailure(redactSensitiveText(error, []), { structuralStop: "preparation_failed" });
      }
      let homeReference: BoundaryCapture;
      try {
        homeReference = await captureAfterPreparationVisualSettle(
          () => liveCapture(adb, input, context.capturePaths.homeReference, "home_reference"),
        );
      } catch (error) {
        throw new BoundaryPreparationFailure(redactSensitiveText(error, []), { homeClearance, structuralStop: "preparation_failed" });
      }
      const marker = `boundary_prepare_${context.runId.slice(0, 16)}`;
      const coverageMarker = `boundary_gap_${context.runId.slice(0, 16)}_prepare`;
      const logPath = path.join(context.artifactRoot, "prepare-logcat-all.txt");
      const sessionId = crypto.randomUUID();
      const generation = 1;
      const secret = input.scenario.entryRoute === "dynamic_full" ? crypto.randomBytes(32).toString("base64url") : "";
      try {
        checkedAdb(await run(adb, ["-s", input.serial, "logcat", "-b", "all", "-c"], { timeoutMs: 10_000 }), "prepare log reset");
      } catch (error) {
        throw new BoundaryPreparationFailure(redactSensitiveText(error, [secret]), { homeClearance, homeReference, structuralStop: "preparation_failed" });
      }
      const partial: {
        current: Awaited<ReturnType<typeof currentApplicationBinding>> | null;
        runtimeBinding: RuntimeBindingReceipt | null;
        sampler: (() => Promise<ApplicationContinuitySample>) | null;
        samplerState: ExperimentState | null;
        continuity: ApplicationContinuitySample[];
        appBaseline: BoundaryCapture | null;
      } = { current: null, runtimeBinding: null, sampler: null, samplerState: null, continuity: [], appBaseline: null };
      const ownedLog = startOwnedLogWindow({
        adbPath: adb,
        serial: input.serial,
        artifactPath: logPath,
        appStartMarker: marker,
        maxDurationMs: Math.max(1, Math.min(LOG_WINDOW_MAX_DURATION_MS, input.route.budgets.maxDurationMs)),
      });
      let finalized: Awaited<ReturnType<typeof runWithFinalizedLog<{
        current: Awaited<ReturnType<typeof currentApplicationBinding>>;
        runtimeBinding: RuntimeBindingReceipt;
        sampler: () => Promise<ApplicationContinuitySample>;
        samplerState: ExperimentState;
        samplerCursor: ContinuitySamplerCursor;
        continuity: ApplicationContinuitySample[];
        appBaseline: BoundaryCapture;
        coverageMarker: string;
      }>>>;
      try {
        finalized = await runWithFinalizedLog({
          promise: ownedLog.promise,
          stop: ownedLog.stop,
          artifactPath: logPath,
          label: "prepare",
          secrets: () => [secret],
          operation: async () => {
          if (!ownedLog.started()) throw new Error("prepare log collector did not own a live child before application launch");
          checkedAdb(await run(adb, ["-s", input.serial, "shell", "log", "-t", "BoundaryExperiment", marker], { timeoutMs: 5_000 }), "prepare log marker");
          const launchArgs = ["-s", input.serial, "shell", "am", "start", "-W", "-n", input.scenario.launchComponent];
          if (input.scenario.entryRoute === "dynamic_full") {
            launchArgs.push("--es", "pico.boundary.session", sessionId, "--es", "pico.boundary.capability", secret, "--el", "pico.boundary.generation", String(generation));
          }
          checkedAdb(await run(adb, launchArgs, { timeoutMs: 30_000 }), "application launch");
          if (input.scenario.entryRoute === "dynamic_full") {
            const dynamic = input.scenario.dynamicEntry!;
            checkedDynamicBroadcast(await run(adb, [
              "-s", input.serial, "shell", "am", "broadcast", "-a", dynamic.action, "-n", dynamic.receiverComponent,
              "--es", "pico.boundary.session", sessionId,
              "--es", "pico.boundary.capability", secret,
              "--el", "pico.boundary.generation", String(generation),
              "--es", "pico.boundary.command", "open",
              "--es", "pico.boundary.stage", dynamic.stageId,
            ], { timeoutMs: 30_000 }), "dynamic Full open command");
          }
          const appBaseline = await captureAfterPreparationVisualSettle(
            () => liveCapture(adb, input, context.capturePaths.appBaseline, "app_baseline"),
          );
          partial.appBaseline = appBaseline;
          const current = await currentApplicationBinding(adb, input);
          partial.current = current;
          const runtimeBinding = runtimeReceipt(input.serial, current.bootId, selected.binding);
          partial.runtimeBinding = runtimeBinding;
          const temporaryState = {
            input,
            preparation: {
              runtimeBinding,
              applicationBinding: current.binding,
              probe: { sessionId: input.scenario.entryRoute === "dynamic_full" ? sessionId : null, generation: input.scenario.entryRoute === "dynamic_full" ? generation : null },
            },
          } as ExperimentState;
          const samplerCursor = continuitySamplerCursor(temporaryState, marker);
          const sampler = sampleContinuityFactory(adb, temporaryState, samplerCursor);
          partial.sampler = sampler;
          partial.samplerState = temporaryState;
          const continuity = [await sampler()];
          partial.continuity = continuity;
          if (continuity[0].foreground !== "exact_allowed"
            || continuity[0].bootId !== current.bootId
            || continuity[0].apkSha256 !== current.binding.apkSha256
            || continuity[0].pid !== current.binding.pid
            || continuity[0].pidStartTicks !== current.binding.pidStartTicks) {
            throw new Error("post-launch application continuity did not retain the exact prepared binding");
          }
          if (input.scenario.entryRoute === "dynamic_full") {
            const kinds = continuity[0].probeEventsSincePrior.map((event) => event.kind);
            const expected = input.scenario.dynamicEntry!.expectedAcks;
            if (continuity[0].probeParse !== "ok"
              || continuity[0].probeSequence !== "complete"
              || !hasExactDynamicOpenSequence(continuity[0].probeEventsSincePrior, expected)
              || kinds.includes("explicit_close_requested")
              || kinds.includes("explicit_close_returned")) {
              throw new Error(`dynamic Full preparation lacks a complete open-without-close probe sequence (${continuity[0].probeParse}/${continuity[0].probeSequence}: ${kinds.join(",") || "none"})`);
            }
          }
          checkedAdb(
            await run(adb, ["-s", input.serial, "shell", "log", "-t", "BoundaryExperiment", coverageMarker], { timeoutMs: 5_000 }),
            "prepare coverage marker",
          );
          return { current, runtimeBinding, sampler, samplerState: temporaryState, samplerCursor, continuity, appBaseline, coverageMarker };
          },
        });
      } catch (error) {
        const logArtifact = error instanceof FinalizedLogOperationError ? error.logArtifact : null;
        let runtimeHealth: PackageRuntimeHealthReceiptV1 | undefined;
        let healthError: string | null = null;
        if (logArtifact) {
          try {
            runtimeHealth = scanPackageRuntimeHealth(logArtifact, input.scenario.packageName, [partial.current?.binding.pid ?? 0]);
          } catch (scanError) {
            healthError = redactSensitiveText(scanError, [secret]);
          }
        }
        const structuralStop = runtimeHealth?.status === "attributed_failure" ? "app_lifecycle_loss"
          : runtimeHealth?.status === "inconclusive" ? "runtime_health_inconclusive"
            : input.scenario.entryRoute === "dynamic_full" && /dynamic Full|probe|open command/i.test(redactSensitiveText(error, [secret]))
              ? "terminal_signal_candidate"
              : partial.current ? "binding_lost" : "preparation_failed";
        throw new BoundaryPreparationFailure(
          [redactSensitiveText(error, [secret]), healthError ? `runtime-health scan: ${healthError}` : null].filter(Boolean).join("; "),
          {
          homeClearance,
          homeReference,
          ...(partial.appBaseline ? { appBaseline: partial.appBaseline } : {}),
          continuity: partial.continuity,
          logArtifact,
          ...(runtimeHealth ? { runtimeHealth } : {}),
          structuralStop,
          },
        );
      }
      const { current, runtimeBinding, sampler, samplerState, samplerCursor, continuity, appBaseline, coverageMarker: retainedCoverageMarker } = finalized.value;
      const runtimeHealth = scanPackageRuntimeHealth(finalized.logArtifact, input.scenario.packageName, [current.binding.pid]);
      return {
        runtimeBinding,
        applicationBinding: current.binding,
        homeClearance,
        homeReference,
        appBaseline,
        continuity,
        logArtifact: finalized.logArtifact,
        runtimeHealth,
        probe: {
          sessionId: input.scenario.entryRoute === "dynamic_full" ? sessionId : null,
          generation: input.scenario.entryRoute === "dynamic_full" ? generation : null,
          capabilitySha256: input.scenario.entryRoute === "dynamic_full" ? hashBytes(secret) : null,
        },
        privateRuntime: {
          window: selected.binding,
          secret,
          sampler,
          samplerState,
          samplerCursor,
          recoveryBinding: current.binding,
          coverageMarker: retainedCoverageMarker,
        } satisfies LiveBoundaryRuntime,
      };
    },
    recaptureReviewedFrame: async (context) => {
      const state = context.state as ExperimentState;
      const remainingMs = typeof context.remainingMs === "function" ? context.remainingMs as () => number : null;
      const boundedTimeout = (capMs: number, label: string): number => {
        if (!remainingMs) return capMs;
        const remaining = Math.floor(remainingMs());
        if (!Number.isFinite(remaining) || remaining < 1) throw new Error(`${label} refused because the waypoint deadline is exhausted`);
        return Math.max(1, Math.min(capMs, remaining));
      };
      const frame = await captureAdbFrame(
        adb,
        state.input.serial,
        boundedTimeout(state.input.capture.attemptTimeoutMs, "reviewed-frame recapture"),
      );
      const sha256 = hashBytes(frame.bytes);
      const sampler = (state.preparation.privateRuntime as LiveBoundaryRuntime).sampler;
      if (remainingMs && remainingMs() < APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS) {
        throw new Error("reviewed-frame continuity sample refused because the waypoint deadline is exhausted");
      }
      const continuity = await sampler();
      const coherent = continuity.serial === state.input.serial
        && continuity.bootId === state.preparation.runtimeBinding.bootId
        && continuity.apkSha256 === state.preparation.applicationBinding.apkSha256
        && continuity.pid === state.preparation.applicationBinding.pid
        && continuity.pidStartTicks === state.preparation.applicationBinding.pidStartTicks;
      return { matches: sha256 === context.expectedSha256 && coherent, sha256, continuity };
    },
    executeWaypoint: async (context) => {
      const waypointStartedNs = process.hrtime.bigint();
      const state = context.state as ExperimentState;
      const waypoint = context.waypoint as BoundaryWaypointPlan;
      const live = state.preparation.privateRuntime as LiveBoundaryRuntime;
      const remainingDurationBudgetMs = Number(context.remainingBudgets.maxDurationMs);
      const recoveryReserveMs = Number(context.remainingBudgets.recoveryReserveMs);
      const nonRecoveryBudgetMs = remainingDurationBudgetMs - recoveryReserveMs;
      if (!Number.isSafeInteger(remainingDurationBudgetMs) || !Number.isSafeInteger(recoveryReserveMs)
        || nonRecoveryBudgetMs < 1) {
        throw new Error("waypoint has no positive work deadline outside the protected recovery reserve");
      }
      const waypointDeadlineNs = waypointStartedNs + BigInt(nonRecoveryBudgetMs) * 1_000_000n;
      const remainingWaypointWorkMs = (): number => remainingWaypointOperationMs(
        waypointDeadlineNs,
        process.hrtime.bigint(),
        [],
      );
      const marker = `boundary_step_${state.runId.slice(0, 12)}_${waypoint.seq}_${context.attemptOrdinal}`;
      const coverageMarker = live.coverageMarker;
      const nextCoverageMarker = waypointCoverageMarker(state.runId, waypoint.seq, context.attemptOrdinal);
      const logPath = context.stepLogPath as string;
      const ownedLog = startOwnedLogWindow({
        adbPath: adb,
        serial: state.input.serial,
        artifactPath: logPath,
        appStartMarker: coverageMarker,
        maxDurationMs: Math.max(1, Math.min(LOG_WINDOW_MAX_DURATION_MS,
          remainingWaypointOperationMs(waypointDeadlineNs, process.hrtime.bigint(), [LOG_FINALIZATION_RESERVE_MS]),
        )),
      });
      type WaypointResult = Awaited<ReturnType<BoundaryExperimentDependencies["executeWaypoint"]>>;
      const retainedHolder: { value: WaypointResult | null } = { value: null };
      try {
        const finalized = await runWithFinalizedLog({
          promise: ownedLog.promise,
          stop: ownedLog.stop,
          artifactPath: logPath,
          label: `waypoint ${waypoint.seq}`,
          secrets: () => [live.secret],
          operation: async () => {
            if (!ownedLog.started()) throw new Error(`waypoint ${waypoint.seq} log collector did not own a live child before movement`);
            const initialMarkerTimeoutMs = remainingWaypointOperationMs(
              waypointDeadlineNs,
              process.hrtime.bigint(),
              [
                state.input.capture.attemptTimeoutMs,
                APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS,
                WAYPOINT_HEALTH_SNAPSHOT_RESERVE_MS,
                ROUTE_FINALIZATION_RESERVE_MS,
              ],
            );
            if (initialMarkerTimeoutMs < 1) throw new Error("waypoint log marker refused because the preflight envelope is exhausted");
            checkedAdb(await run(
              adb,
              ["-s", state.input.serial, "shell", "log", "-t", "BoundaryExperiment", marker],
              { timeoutMs: Math.min(WAYPOINT_COVERAGE_MARKER_RESERVE_MS, initialMarkerTimeoutMs) },
            ), "waypoint log marker");
            let preflight: Awaited<ReturnType<BoundaryExperimentDependencies["recaptureReviewedFrame"]>> | null = null;
            let preflightLogArtifact: RuntimeLogSnapshotReceipt | null = null;
            let preflightRuntimeHealth = inconclusiveRuntimeHealth(
              state.input.scenario.packageName,
              coverageMarker,
              [state.preparation.applicationBinding.pid],
            );
            let routeTrace: Record<string, any> | null = null;
            let capture: BoundaryCapture | null = null;
            const movementCaptureHolder: { value: BoundaryCapture | null } = { value: null };
            let captureError: string | undefined;
            let executionError: string | undefined;
            let decided = false;
            try {
              const collectedPreflight = await context.recaptureReviewedFrame({
                remainingMs: () => remainingWaypointOperationMs(
                  waypointDeadlineNs,
                  process.hrtime.bigint(),
                  [WAYPOINT_HEALTH_SNAPSHOT_RESERVE_MS, ROUTE_FINALIZATION_RESERVE_MS],
                ),
              }) as Awaited<ReturnType<BoundaryExperimentDependencies["recaptureReviewedFrame"]>>;
              preflight = collectedPreflight;
              try {
                const healthTimeoutMs = remainingWaypointOperationMs(
                  waypointDeadlineNs,
                  process.hrtime.bigint(),
                  [ROUTE_FINALIZATION_RESERVE_MS],
                );
                if (healthTimeoutMs < 1) throw new Error("runtime-health snapshot refused because the waypoint deadline is exhausted");
                const snapshot = await collectRuntimeHealthSnapshot({
                  adb,
                  serial: state.input.serial,
                  artifactPath: context.preflightLogPath as string,
                  marker: coverageMarker,
                  packageName: state.input.scenario.packageName,
                  expectedPids: [state.preparation.applicationBinding.pid, collectedPreflight.continuity.pid ?? 0],
                  secrets: [live.secret],
                  timeoutMs: healthTimeoutMs,
                });
                preflightLogArtifact = snapshot.receipt;
                preflightRuntimeHealth = snapshot.health;
              } catch (error) {
                executionError = redactSensitiveText(error, [live.secret]);
              }
              const preflightExact = waypointPreflightAllowsMovement(
                collectedPreflight,
                state.lastRequiredHash,
                state.preparation.runtimeBinding,
                state.preparation.applicationBinding,
                state.input.scenario.entryRoute,
              ) && preflightRuntimeHealth.status === "no_attributed_failure";
              if (!preflightExact) {
                routeTrace = {
                  status: "binding_lost",
                  waypoints: [],
                  usage: { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 0 },
                  preMovementReviewDrift: true,
                  preflightRuntimeHealth,
                };
              } else {
                const routeBudgets = {
                  ...context.remainingBudgets,
                  maxDurationMs: Math.max(1, remainingWaypointWorkMs() + recoveryReserveMs),
                } as RouteBudgets;
                routeTrace = await executeRelativeCameraRoute({
                  runtimeBinding: state.preparation.runtimeBinding,
                  continuity: { kind: "required", binding: state.preparation.applicationBinding },
                  artifactSession: { runId: state.runId, absoluteRoot: state.artifactRoot, ownerNonceHash: state.ownerNonceHash },
                  priorCaptureSha256: state.lastRequiredHash,
                  budgets: routeBudgets,
                  capture: state.input.capture,
                }, () => {
                  // Compatibility decisions are synchronous and pure; all input/capture mutation is
                  // owned by executeRelativeCameraRoute after this literal action selection returns.
                  if (decided) return "stop";
                  decided = true;
                  return waypoint.actions as RelativeCameraAction[];
                }, {
                  ...createBoundCameraActionAdapter(state.input.serial, live.window),
                  sampleContinuity: live.sampler,
                  captureSettled: async (capturePath, captureContext) => {
                    const captured = await liveCapture(
                      adb,
                      state.input,
                      capturePath,
                      "waypoint",
                      captureContext.remainingMs,
                      captureContext.priorSha256,
                    );
                    movementCaptureHolder.value = captured;
                    return captured.receipt as any;
                  },
                  allocateWaypointPath: () => context.capturePath as string,
                  sleep,
                  monotonicNs: () => process.hrtime.bigint(),
                });
              }
            } catch (error) {
              executionError = redactSensitiveText(error, [live.secret]);
            }
            const completed = routeTrace?.waypoints?.at?.(-1);
            if (completed?.settle?.path && completed.settle.sha256 && completed.settle.captureRef) {
              const ref = completed.settle.captureRef;
              capture = {
                role: "waypoint",
                path: completed.settle.path,
                sha256: completed.settle.sha256,
                bytes: ref.bytes,
                width: ref.width,
                height: ref.height,
                settled: completed.settle.status === "settled" && completed.settle.settlementSatisfied,
                receipt: completed.settle,
              };
            } else if (movementCaptureHolder.value !== null) {
              capture = { ...movementCaptureHolder.value, role: "transition" };
            } else {
              try {
                const remainingTransitionMs = (): number => remainingWaypointOperationMs(
                  waypointDeadlineNs,
                  process.hrtime.bigint(),
                  [
                    APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS,
                    WAYPOINT_COVERAGE_MARKER_RESERVE_MS,
                    LOG_FINALIZATION_RESERVE_MS,
                  ],
                );
                capture = await liveCapture(
                  adb,
                  state.input,
                  waypointTransitionCapturePath(context.capturePath as string),
                  "transition",
                  remainingTransitionMs,
                );
              } catch (error) {
                captureError = redactSensitiveText(error, [live.secret]);
              }
            }
            const continuity: ApplicationContinuitySample[] = routeTrace?.waypoints?.flatMap((entry: any) => [entry.continuityBefore, entry.continuityAfter])
              .filter((entry: any) => entry?.kind === "sampled")
              .map((entry: any) => entry.sample) ?? [];
            if (continuity.length === 0) {
              try {
                const continuityBudgetMs = remainingWaypointOperationMs(
                  waypointDeadlineNs,
                  process.hrtime.bigint(),
                  [WAYPOINT_COVERAGE_MARKER_RESERVE_MS, LOG_FINALIZATION_RESERVE_MS],
                );
                if (continuityBudgetMs < APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS) {
                  throw new Error("fallback continuity refused because the waypoint deadline is exhausted");
                }
                continuity.push(await live.sampler());
              } catch (error) {
                executionError = executionError ?? redactSensitiveText(error, [live.secret]);
              }
            }
            routeTrace ??= {
              status: "action_failed",
              waypoints: [],
              usage: { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 0 },
              terminalDependencyError: executionError ?? "route dependency failed before publishing its trace",
            };
            try {
              const coverageMarkerTimeoutMs = remainingWaypointOperationMs(
                waypointDeadlineNs,
                process.hrtime.bigint(),
                [LOG_FINALIZATION_RESERVE_MS],
              );
              if (coverageMarkerTimeoutMs < 1) throw new Error("waypoint coverage marker refused because the log-finalization reserve is exhausted");
              checkedAdb(
                await run(adb, ["-s", state.input.serial, "shell", "log", "-t", "BoundaryExperiment", nextCoverageMarker], {
                  timeoutMs: Math.min(WAYPOINT_COVERAGE_MARKER_RESERVE_MS, coverageMarkerTimeoutMs),
                }),
                `waypoint ${waypoint.seq} coverage marker`,
              );
              live.coverageMarker = nextCoverageMarker;
            } catch (error) {
              executionError = [executionError, redactSensitiveText(error, [live.secret])].filter(Boolean).join("; ");
              routeTrace = {
                ...routeTrace,
                status: "action_failed",
                terminalDependencyError: executionError,
              };
            }
            retainedHolder.value = {
              preflight,
              routeTrace,
              capture,
              continuity,
              logArtifact: null,
              preflightLogArtifact,
              preflightRuntimeHealth,
              runtimeHealth: inconclusiveRuntimeHealth(state.input.scenario.packageName, marker, [state.preparation.applicationBinding.pid]),
              ...(captureError ? { captureError } : {}),
              ...(executionError ? { executionError } : {}),
            };
            return retainedHolder.value;
          },
        });
        const completed = {
          ...finalized.value,
          logArtifact: finalized.logArtifact,
          runtimeHealth: finalizedWaypointRuntimeHealth(
            finalized.logArtifact,
            state.input.scenario.packageName,
            [state.preparation.applicationBinding.pid],
            marker,
          ),
        };
        const finishedNs = process.hrtime.bigint();
        const chargedTrace = chargeWaypointElapsedDuration(completed.routeTrace, waypointStartedNs, finishedNs);
        const deadlineTrace = finishedNs > waypointDeadlineNs
          ? {
              ...chargedTrace,
              status: "budget_exhausted",
              terminalDependencyError: "waypoint finalization exceeded the absolute non-recovery deadline",
            }
          : chargedTrace;
        return {
          ...completed,
          routeTrace: deadlineTrace,
        };
      } catch (error) {
        const retained = retainedHolder.value;
        if (retained === null) throw error;
        return {
          ...retained,
          routeTrace: chargeWaypointElapsedDuration(retained.routeTrace, waypointStartedNs, process.hrtime.bigint()),
          logArtifact: null,
          executionError: [retained.executionError, redactSensitiveText(error, [live.secret])].filter(Boolean).join("; "),
        };
      }
    },
    executeRecoveryStep: async (context) => {
      const state = context.state as ExperimentState;
      const live = state.preparation.privateRuntime as LiveBoundaryRuntime;
      const captureDirectory = context.captureDirectory as string;
      const kind = context.kind as RecoveryKind;
      const stepNumber = context.stepOrdinal as number;
      const recoveryBudgetMs = context.remainingRecoveryMs as number;
      if (!state.recovery?.order.includes(kind) || state.recovery.order[stepNumber - 1] !== kind
        || !Number.isInteger(stepNumber) || stepNumber < 1
        || !Number.isFinite(recoveryBudgetMs) || recoveryBudgetMs < 1) {
        throw new Error("recovery step context is not the exact next ordered fallback with a positive reserve");
      }
      let reserveExhausted = false;
      let protocolStopped = false;
      const recoveryStartedNs = process.hrtime.bigint();
      const recoveryDeadlineNs = recoveryStartedNs + BigInt(Math.floor(recoveryBudgetMs)) * 1_000_000n;
      const remainingRecoveryMs = (): number => Math.max(0, Number((recoveryDeadlineNs - process.hrtime.bigint()) / 1_000_000n));
      let logFinalizationReserved = false;
      const remainingWorkMs = (): number => Math.max(0, remainingRecoveryMs() - (logFinalizationReserved ? LOG_FINALIZATION_RESERVE_MS : 0));
      const boundedRun: CheckedAdbRunner = async (args, timeoutMs, label) => {
        const remaining = remainingWorkMs();
        if (remaining < 1) throw new Error(`${label} refused because the recovery reserve is exhausted`);
        return checkedAdb(await run(adb, args, { timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)) }), label);
      };
      const boundedSleep = async (milliseconds: number, label: string): Promise<void> => {
        if (remainingWorkMs() < milliseconds) throw new Error(`${label} refused because it would exceed the recovery reserve`);
        await sleep(milliseconds);
      };

      type RecoveryOperationResult = {
        accepted: boolean;
        expectedBinding: BoundApplicationIdentity;
        receipt: Record<string, unknown>;
        requireProbeOpen?: boolean;
        attributionKind?: RecoveryAttributionKind;
      };

      const collectStep = async (
        operation: (rememberSecret: (secret: string) => void) => Promise<RecoveryOperationResult>,
      ): ReturnType<BoundaryExperimentDependencies["executeRecoveryStep"]> => {
        const prefix = `${950 + stepNumber * 10}-${kind}`;
        const marker = `boundary_recovery_${state.runId.slice(0, 10)}_${stepNumber}`;
        const coverageMarker = live.coverageMarker;
        const nextCoverageMarker = `boundary_gap_${state.runId.slice(0, 10)}_recovery_${stepNumber}`;
        const logPath = path.join(state.artifactRoot, `${prefix}-logcat-all.txt`);
        const secrets = [live.secret];
        const rememberSecret = (secret: string): void => {
          if (secret && !secrets.includes(secret)) secrets.push(secret);
        };
        let operationResult: RecoveryOperationResult = {
          accepted: false,
          expectedBinding: state.preparation.applicationBinding,
          receipt: { operation: "not_started" },
        };
        const observed: {
          beforeCapture: BoundaryCapture | null;
          afterCapture: BoundaryCapture | null;
          beforeSample: ApplicationContinuitySample | null;
          afterSample: ApplicationContinuitySample | null;
        } = {
          beforeCapture: null,
          afterCapture: null,
          beforeSample: null,
          afterSample: null,
        };
        const errors: string[] = [];
        let logArtifact: unknown | null = null;
        let runtimeHealth = inconclusiveRuntimeHealth(
          state.input.scenario.packageName,
          marker,
          [state.preparation.applicationBinding.pid],
        );
        let coverageRuntimeHealth = inconclusiveRuntimeHealth(
          state.input.scenario.packageName,
          coverageMarker,
          [state.preparation.applicationBinding.pid],
        );
        if (remainingRecoveryMs() <= LOG_FINALIZATION_RESERVE_MS) {
          try {
            observed.beforeCapture = await liveCapture(
              adb,
              state.input,
              path.join(captureDirectory, `${prefix}-before.png`),
              "recovery",
              remainingRecoveryMs,
            );
          } catch (error) {
            errors.push(`before capture: ${redactSensitiveText(error, secrets)}`);
          }
          const durationMs = Math.ceil(Number(process.hrtime.bigint() - recoveryStartedNs) / 1_000_000);
          return {
            kind,
            structuralOk: false,
            beforeCapture: observed.beforeCapture,
            afterCapture: null,
            continuity: [],
            receipt: { setupError: "recovery reserve cannot cover owned log-child teardown", errors, reserveExhausted: true, logArtifact: null },
            runtimeHealth,
            durationMs,
            reserveExhausted: true,
            protocolStopped: true,
          };
        }
        logFinalizationReserved = true;
        const ownedLog = startOwnedLogWindow({
          adbPath: adb,
          serial: state.input.serial,
          artifactPath: logPath,
          appStartMarker: coverageMarker,
          maxDurationMs: Math.max(1, Math.min(LOG_WINDOW_MAX_DURATION_MS, Math.floor(remainingRecoveryMs() - 6_000))),
        });
        try {
          const finalized = await runWithFinalizedLog({
            promise: ownedLog.promise,
            stop: ownedLog.stop,
            artifactPath: logPath,
            label: `recovery ${kind}`,
            secrets: () => secrets,
            tailMs: 250,
            operation: async () => {
              if (!ownedLog.started()) throw new Error(`${kind} log collector did not own a live child before the fallback`);
              await boundedRun(["-s", state.input.serial, "shell", "log", "-t", "BoundaryExperiment", marker], 5_000, `${kind} log marker`);
              try {
                observed.beforeCapture = await liveCapture(
                  adb,
                  state.input,
                  path.join(captureDirectory, `${prefix}-before.png`),
                  "recovery",
                  remainingWorkMs,
                );
              } catch (error) {
                errors.push(`before capture: ${redactSensitiveText(error, secrets)}`);
              }
              try {
                if (remainingWorkMs() < APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS) {
                  throw new Error("pre-fallback continuity sampling refused because the recovery reserve cannot cover its bounded work budget");
                }
                live.sampler = sampleContinuityFactory(adb, live.samplerState, live.samplerCursor, remainingWorkMs);
                observed.beforeSample = await live.sampler();
              } catch (error) {
                errors.push(`before continuity: ${redactSensitiveText(error, secrets)}`);
              }
              if (kind === "observe") {
                try {
                  operationResult = await operation(rememberSecret);
                } catch (error) {
                  errors.push(redactSensitiveText(error, secrets));
                }
              } else {
                const priorStep = state.recovery?.steps.at(-1);
                const priorHash = priorStep?.afterItem?.captureSha256 ?? null;
                const priorReview = priorHash ? state.recovery?.reviewed.get(priorHash) : undefined;
                const sameReviewedPixels = observed.beforeCapture !== null
                  && observed.beforeCapture.settled
                  && priorHash !== null
                  && observed.beforeCapture.sha256 === priorHash;
                const exactBinding = observed.beforeSample !== null && recoveryContinuityMatchesBinding(
                  observed.beforeSample,
                  state.preparation.runtimeBinding,
                  state.preparation.applicationBinding,
                );
                const staticBinding = observed.beforeSample !== null
                  && observed.beforeSample.serial === state.preparation.runtimeBinding.serial
                  && observed.beforeSample.bootId === state.preparation.runtimeBinding.bootId
                  && observed.beforeSample.packageName === state.preparation.applicationBinding.packageName
                  && observed.beforeSample.apkSha256 === state.preparation.applicationBinding.apkSha256
                  && canonicalJson([...observed.beforeSample.allowedResumedComponents].sort())
                    === canonicalJson([...state.preparation.applicationBinding.allowedResumedComponents].sort());
                const currentBindingEligible = kind === "reopen_stage"
                  ? exactBinding
                  : staticBinding;
                const dynamicRootEligible = kind !== "reopen_stage" || (priorReview !== undefined && shouldIncludeDynamicReopen({
                  entryRoute: state.input.scenario.entryRoute,
                  observedFrame: priorReview,
                  observeStructuralOk: priorStep?.structuralOk === true,
                  exactBinding,
                }));
                if (!sameReviewedPixels || !currentBindingEligible || !dynamicRootEligible) {
                  operationResult = {
                    accepted: exactBinding,
                    expectedBinding: state.preparation.applicationBinding,
                    attributionKind: "observe",
                    receipt: {
                      intervention: "withheld_precondition_drift",
                      reviewedPriorSha256: priorHash,
                      immediateBeforeSha256: observed.beforeCapture?.sha256 ?? null,
                      sameReviewedPixels,
                      currentBindingEligible,
                      dynamicRootEligible,
                    },
                  };
                } else {
                  try {
                    operationResult = await operation(rememberSecret);
                  } catch (error) {
                    errors.push(redactSensitiveText(error, secrets));
                  }
                }
              }
              try {
                observed.afterCapture = await liveCapture(
                  adb,
                  state.input,
                  path.join(captureDirectory, `${prefix}-after.png`),
                  "recovery",
                  remainingWorkMs,
                );
              } catch (error) {
                errors.push(`after capture: ${redactSensitiveText(error, secrets)}`);
              }
              try {
                if (remainingWorkMs() < APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS) {
                  throw new Error("continuity sampling refused because the recovery reserve cannot cover its bounded work budget");
                }
                observed.afterSample = await live.sampler();
              } catch (error) {
                errors.push(`continuity: ${redactSensitiveText(error, secrets)}`);
              }
              try {
                await boundedRun(
                  ["-s", state.input.serial, "shell", "log", "-t", "BoundaryExperiment", nextCoverageMarker],
                  5_000,
                  `${kind} coverage marker`,
                );
                live.coverageMarker = nextCoverageMarker;
              } catch (error) {
                errors.push(`coverage marker: ${redactSensitiveText(error, secrets)}`);
              }
              return null;
            },
          });
          logArtifact = finalized.logArtifact;
          coverageRuntimeHealth = scanPackageRuntimeHealth(
            finalized.logArtifact,
            state.input.scenario.packageName,
            [state.preparation.applicationBinding.pid, operationResult.expectedBinding.pid, observed.beforeSample?.pid ?? 0, observed.afterSample?.pid ?? 0],
          );
          const logBytes = regularExternalFile(finalized.logArtifact.rawArtifact.path, "recovery raw log artifact", LOG_ARTIFACT_MAX_BYTES);
          runtimeHealth = scanPackageRuntimeHealth(
            {
              ...finalized.logArtifact,
              appStartMarker: marker,
              appStartMarkerObserved: logBytes.includes(Buffer.from(marker, "utf8")),
            },
            state.input.scenario.packageName,
            [state.preparation.applicationBinding.pid, operationResult.expectedBinding.pid, observed.beforeSample?.pid ?? 0, observed.afterSample?.pid ?? 0],
          );
        } catch (error) {
          const redacted = redactSensitiveText(error, secrets);
          errors.push(redacted);
        }
        reserveExhausted ||= remainingRecoveryMs() <= LOG_FINALIZATION_RESERVE_MS;
        protocolStopped ||= observed.afterCapture === null || observed.afterSample === null || logArtifact === null;
        const identityOk = observed.afterSample !== null
          && recoveryContinuityMatchesBinding(observed.afterSample, state.preparation.runtimeBinding, operationResult.expectedBinding);
        const probeKinds = observed.afterSample?.probeEventsSincePrior.map((event) => event.kind) ?? [];
        const probeOk = !operationResult.requireProbeOpen || (observed.afterSample?.probeParse === "ok"
          && observed.afterSample.probeSequence === "complete"
          && hasExactDynamicOpenSequence(observed.afterSample.probeEventsSincePrior, state.input.scenario.dynamicEntry!.expectedAcks)
          && !probeKinds.includes("explicit_close_requested")
          && !probeKinds.includes("explicit_close_returned"));
        const structuralOk = operationResult.accepted
          && identityOk
          && probeOk
          && observed.beforeCapture?.settled === true
          && observed.afterCapture?.settled === true
          && logArtifact !== null
          && errors.length === 0;
        const durationMs = Math.ceil(Number(process.hrtime.bigint() - recoveryStartedNs) / 1_000_000);
        return {
          kind,
          attributionKind: operationResult.attributionKind,
          structuralOk,
          beforeCapture: observed.beforeCapture,
          afterCapture: observed.afterCapture,
          continuity: [observed.beforeSample, observed.afterSample].filter((sample): sample is ApplicationContinuitySample => sample !== null),
          receipt: { ...operationResult.receipt, identityOk, probeOk, logArtifact, errors, reserveExhausted },
          runtimeHealth,
          coverageRuntimeHealth,
          durationMs,
          ...(reserveExhausted ? { reserveExhausted: true } : {}),
          ...(protocolStopped ? { protocolStopped: true } : {}),
        };
      };

      let operation: (rememberSecret: (secret: string) => void) => Promise<RecoveryOperationResult>;
      if (kind === "observe") {
        operation = async () => {
          await boundedSleep(2_000, "recovery observation");
          return {
            accepted: true,
            expectedBinding: state.preparation.applicationBinding,
            receipt: { observationMs: 2_000, intervention: "none" },
          };
        };
      } else if (kind === "reopen_stage") {
        operation = async () => {
          const dynamic = state.input.scenario.dynamicEntry!;
          const generation = (state.preparation.probe.generation ?? 1) + 1;
          const probeCursorMarker = `boundary_probe_cursor_${state.runId.slice(0, 10)}_reopen_${generation}`;
          await boundedRun(
            ["-s", state.input.serial, "shell", "log", "-t", "BoundaryExperiment", probeCursorMarker],
            5_000,
            "dynamic reopen probe cursor marker",
          );
          const output = await boundedRun([
            "-s", state.input.serial, "shell", "am", "broadcast", "-a", dynamic.action, "-n", dynamic.receiverComponent,
            "--es", "pico.boundary.session", state.preparation.probe.sessionId!,
            "--es", "pico.boundary.capability", live.secret,
            "--el", "pico.boundary.generation", String(generation),
            "--es", "pico.boundary.command", "open",
            "--es", "pico.boundary.stage", dynamic.stageId,
          ], 30_000, "dynamic recovery reopen");
          if (!/Broadcast completed:\s*result=-1,\s*data="accepted"/.test(output)) throw new Error("dynamic recovery reopen was not accepted by the exact receiver");
          await boundedSleep(3_000, "dynamic recovery reopen dwell");
          const reopenState = {
            ...state,
            preparation: { ...state.preparation, probe: { ...state.preparation.probe, generation } },
          } as ExperimentState;
          live.samplerState = reopenState;
          live.samplerCursor = continuitySamplerCursor(reopenState, probeCursorMarker);
          live.sampler = sampleContinuityFactory(adb, reopenState, live.samplerCursor, remainingWorkMs);
          return {
            accepted: true,
            expectedBinding: state.preparation.applicationBinding,
            receipt: { generation, command: "open", stageId: dynamic.stageId, unchangedBindingRequired: true, probeCursorMarker },
            requireProbeOpen: true,
          };
        };
      } else if (kind === "activity_launch") {
        operation = async () => {
          const beforeBinding = live.recoveryBinding;
          const probeCursorMarker = `boundary_probe_cursor_${state.runId.slice(0, 10)}_activity_${stepNumber}`;
          let output = "";
          let disposition: "accepted" | "ignored" | "blocked" = "blocked";
          let blockedDetail: string | null = null;
          try {
            await boundedRun(
              ["-s", state.input.serial, "shell", "log", "-t", "BoundaryExperiment", probeCursorMarker],
              5_000,
              "normal activity probe cursor marker",
            );
            output = await boundedRun(["-s", state.input.serial, "shell", "am", "start", "-W", "-n", state.input.scenario.launchComponent], 30_000, "normal recovery activity launch");
            disposition = classifyActivityLaunchDisposition(output, true);
            if (disposition === "blocked") blockedDetail = "successful am exit lacked an accepted or ignored launch disposition";
          } catch (error) {
            blockedDetail = redactSensitiveText(error, [live.secret]);
          }
          await boundedSleep(2_000, "normal recovery launch dwell");
          let afterBinding = beforeBinding;
          if (disposition !== "blocked") {
            try {
              const rebound = await currentApplicationBinding(adb, state.input, boundedRun);
              if (rebound.bootId !== state.preparation.runtimeBinding.bootId) throw new Error("device rebooted during normal activity recovery");
              afterBinding = rebound.binding;
              const reboundState = {
                ...state,
                preparation: { ...state.preparation, applicationBinding: afterBinding },
              } as ExperimentState;
              live.recoveryBinding = afterBinding;
              live.samplerState = reboundState;
              if (recoveryReboundTupleChanged(beforeBinding, afterBinding)) {
                live.samplerCursor = continuitySamplerCursor(reboundState, probeCursorMarker);
                live.sampler = sampleContinuityFactory(adb, reboundState, live.samplerCursor, remainingWorkMs);
              }
            } catch (error) {
              blockedDetail = redactSensitiveText(error, [live.secret]);
              disposition = "blocked";
            }
          }
          const samePidStartSurvived = !recoveryReboundTupleChanged(beforeBinding, afterBinding);
          return {
            accepted: disposition !== "blocked",
            expectedBinding: afterBinding,
            ...(disposition === "ignored" ? { attributionKind: "activity_launch_ignored" as const } : {}),
            receipt: {
              component: state.input.scenario.launchComponent,
              disposition,
              outputSha256: hashBytes(output),
              outputTail: output.slice(-4_096),
              blockedDetail,
              beforePid: beforeBinding.pid,
              beforePidStartTicks: beforeBinding.pidStartTicks,
              afterPid: afterBinding.pid,
              afterPidStartTicks: afterBinding.pidStartTicks,
              samePidStartSurvived,
              probeCursorMarker,
            },
          };
        };
      } else {
        operation = async (rememberSecret) => {
          const forceCompletionReserveMs = state.input.scenario.entryRoute === "dynamic_full"
            ? FORCE_STOP_DYNAMIC_COMPLETION_RESERVE_MS
            : FORCE_STOP_STATIC_COMPLETION_RESERVE_MS;
          if (remainingRecoveryMs() < forceCompletionReserveMs) {
            throw new Error(`force-stop withheld before destructive input because ${forceCompletionReserveMs} ms of compensating completion reserve is required`);
          }
          const previousBinding = live.recoveryBinding;
          const previousSecret = live.secret;
          const probeCursorMarker = `boundary_probe_cursor_${state.runId.slice(0, 10)}_force_${stepNumber}`;
          await boundedRun(["-s", state.input.serial, "shell", "am", "force-stop", state.input.scenario.packageName], 10_000, "exact recovery package force-stop");
          let probeCursorMarkerError: string | null = null;
          try {
            await boundedRun(
              ["-s", state.input.serial, "shell", "log", "-t", "BoundaryExperiment", probeCursorMarker],
              5_000,
              "post-force-stop probe cursor marker",
            );
          } catch (error) {
            // The package has already been stopped. Continue the compensating relaunch, but keep
            // the missing cursor explicit so the resulting evidence cannot earn structural success.
            probeCursorMarkerError = redactSensitiveText(error, [previousSecret]);
          }
          const launchArgs = ["-s", state.input.serial, "shell", "am", "start", "-W", "-n", state.input.scenario.launchComponent];
          let nextSessionId: string | null = null;
          let nextSecret = previousSecret;
          if (state.input.scenario.entryRoute === "dynamic_full") {
            nextSessionId = crypto.randomUUID();
            nextSecret = crypto.randomBytes(32).toString("base64url");
            rememberSecret(nextSecret);
            live.secret = nextSecret;
            launchArgs.push("--es", "pico.boundary.session", nextSessionId, "--es", "pico.boundary.capability", nextSecret, "--el", "pico.boundary.generation", "1");
          }
          await boundedRun(launchArgs, 30_000, "force-stop recovery activity launch");
          if (state.input.scenario.entryRoute === "dynamic_full") {
            const dynamic = state.input.scenario.dynamicEntry!;
            const output = await boundedRun([
              "-s", state.input.serial, "shell", "am", "broadcast", "-a", dynamic.action, "-n", dynamic.receiverComponent,
              "--es", "pico.boundary.session", nextSessionId!,
              "--es", "pico.boundary.capability", nextSecret,
              "--el", "pico.boundary.generation", "1",
              "--es", "pico.boundary.command", "open",
              "--es", "pico.boundary.stage", dynamic.stageId,
            ], 30_000, "force-stop recovery dynamic Full open");
            if (!/Broadcast completed:\s*result=-1,\s*data="accepted"/.test(output)) throw new Error("force-stop recovery dynamic Full open was not accepted by the exact receiver");
          }
          await boundedSleep(state.input.scenario.entryRoute === "dynamic_full" ? 3_000 : 2_000, "force-stop recovery dwell");
          const rebound = await currentApplicationBinding(adb, state.input, boundedRun);
          if (rebound.bootId !== state.preparation.runtimeBinding.bootId) throw new Error("device rebooted during recovery rebind");
          if (!recoveryReboundTupleChanged(previousBinding, rebound.binding)) {
            throw new Error("force-stop recovery did not establish a distinct rebound PID/start tuple");
          }
          const reboundState = {
            ...state,
            preparation: {
              ...state.preparation,
              applicationBinding: rebound.binding,
              probe: {
                sessionId: nextSessionId,
                generation: nextSessionId ? 1 : null,
                capabilitySha256: nextSessionId ? hashBytes(nextSecret) : null,
              },
            },
          } as ExperimentState;
          live.samplerState = reboundState;
          live.samplerCursor = continuitySamplerCursor(reboundState, probeCursorMarker);
          live.sampler = sampleContinuityFactory(adb, reboundState, live.samplerCursor, remainingWorkMs);
          live.recoveryBinding = rebound.binding;
          return {
            accepted: probeCursorMarkerError === null,
            expectedBinding: rebound.binding,
            receipt: {
              component: state.input.scenario.launchComponent,
              priorPid: previousBinding.pid,
              priorPidStartTicks: previousBinding.pidStartTicks,
              rebound: rebound.binding,
              reboundTupleChanged: true,
              bootId: rebound.bootId,
              probeCursorMarker,
              probeCursorMarkerObserved: probeCursorMarkerError === null,
              probeCursorMarkerError,
              ...(nextSessionId ? { sessionId: nextSessionId, generation: 1, capabilitySha256: hashBytes(nextSecret), command: "open", stageId: state.input.scenario.dynamicEntry!.stageId } : {}),
            },
            requireProbeOpen: state.input.scenario.entryRoute === "dynamic_full",
          };
        };
      }
      return collectStep(operation);
    },
  };
}

const liveOrchestrator = createBoundaryExperimentOrchestrator(createLiveBoundaryExperimentDependencies());

export function registerBoundaryExperimentTools(server: McpServer): void {
  server.registerTool(
    "run_immersive_boundary_experiment",
    {
      description: "Run one receipt-bound immersive boundary experiment as staged prepare → reviewed step(s) → exact-hash adjudication → one logical once-only recovery attempt. Recovery executes at most one ordered fallback per call; each continuation supplies reviewedPriorFrame for the preceding fallback's post-frame, so a structural candidate cannot suppress LOOK or unlock a later intervention by itself. Collection never assigns pixel semantics. Full-surface only; explicit serial and an external non-existing artifact root are mandatory.",
      inputSchema: boundaryExperimentInputSchema,
    },
    async (args) => {
      try {
        const result = await liveOrchestrator.execute(args as BoundaryExperimentInput);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        const responseReview = Array.isArray(result.responseReview) ? result.responseReview as RequiredReviewItem[] : [];
        if (responseReview.length > 10) throw new Error("one response may return at most ten newly collected review frames");
        let responseImageBytes = 0;
        for (const item of responseReview) {
          const bytes = readBoundReviewImage(item, result.artifactRoot);
          responseImageBytes += bytes.length;
          if (responseImageBytes > 128 * 1024 * 1024) throw new Error("new review frames exceed the 128 MiB response cap");
          content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
        }
        const { responseReview: _responseReview, ...publicResult } = result;
        content.push({ type: "text", text: JSON.stringify(publicResult, null, 2) });
        return { content };
      } catch (error) {
        return okJson({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    },
  );
}
