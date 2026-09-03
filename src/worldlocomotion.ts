import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AGENT_BRIDGE_LOCOMOTION_ROOT_ID,
  probeAgentBridgeLocomotionCapability,
  requestAgentBridgeHmdPose,
  requestAgentBridgeLocomotion,
  type AgentBridgeHmdPose,
  type AgentBridgeHmdPoseRequestInput,
  type AgentBridgeLocomotionAck,
  type AgentBridgeLocomotionRequestInput,
  type AgentBridgeLocomotionTransactionInput,
} from "./agentbridge.js";
import {
  classifyActivityLaunchDisposition,
  parseResumedPackages,
  parseThirdPartyPackages,
  probeBoundedCaptureIdentity,
  readBoundReviewImage,
  readReceiptBoundEffectiveAppSpec,
  type RequiredReviewItem,
} from "./boundaryexperiment.js";
import { resolveAdb } from "./emulatorlook.js";
import {
  parseForegroundActivities,
  parseInstalledApkPath,
  parsePid,
  parseProcStartTicks,
  parseRemoteSha256,
} from "./nativefleetreceipt.js";
import type { BoundApplicationIdentity, ReservedArtifactSession } from "./navigation.js";
import {
  executeLiveCaptureSettled,
  resolveProspectivePath,
  sha256Bytes,
  type CaptureSettledInput,
  type CaptureSettledReceipt,
} from "./observation.js";
import { canonicalJson } from "./runreceiptidentity.js";
import { readNativeRunReceipt } from "./runreceiptstore.js";
import {
  scanPackageRuntimeHealth,
  type ApplicationContinuitySample,
  type PackageRuntimeHealthReceiptV1,
  type RuntimeLogSnapshotReceipt,
} from "./runtimecontinuity.js";
import { okJson, run, runBinary, sleep } from "./util.js";

const SHA256 = /^[a-f0-9]{64}$/;
const EMULATOR_SERIAL = /^emulator-[1-9][0-9]*$/;
const PACKAGE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const COMPONENT = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\/[A-Za-z0-9_.$]+$/;
const ROOT_INCARNATION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_MAX_POLLS = 10;
const BRIDGE_POLL_MS = 100;
const BRIDGE_MIN_TRANSACTION_MS = 1_000 + BRIDGE_MAX_POLLS * 250 + (BRIDGE_MAX_POLLS - 1) * BRIDGE_POLL_MS + 1_000;
const FINAL_RECOVERY_RESERVE_MS = 5_000;

const hashSchema = z.string().regex(SHA256);
const componentSchema = z.string().regex(COMPONENT);
const finiteFloat32Schema = z.number().finite().refine(
  (value) => Number.isFinite(Math.fround(value)),
  "coordinate must be representable as one finite Float32 transport value",
);
const absolutePositionSchema = z.object({
  absolute: z.literal(true),
  x: finiteFloat32Schema,
  y: finiteFloat32Schema,
  z: finiteFloat32Schema,
}).strict();

function canonicalFloat32(value: number): number {
  const rounded = Math.fround(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

const scenarioSchema = z.object({
  id: z.string().min(1).max(128),
  packageName: z.string().regex(PACKAGE),
  launchComponent: componentSchema,
  allowedResumedComponents: z.array(componentSchema).min(1).max(16),
  stageStyle: z.literal("3"),
  rootContainer: z.literal("stage"),
}).strict().superRefine((value, context) => {
  if (!value.launchComponent.startsWith(`${value.packageName}/`)
    || value.allowedResumedComponents.some((component) => !component.startsWith(`${value.packageName}/`))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["launchComponent"], message: "scenario components must belong to packageName" });
  }
  if (!value.allowedResumedComponents.includes(value.launchComponent)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedResumedComponents"], message: "launchComponent must be explicitly allowed" });
  }
  if (new Set(value.allowedResumedComponents).size !== value.allowedResumedComponents.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedResumedComponents"], message: "allowed resumed components must be unique" });
  }
});

const waypointSchema = z.object({
  seq: z.number().int().positive().max(64),
  target: absolutePositionSchema,
}).strict();

const routeSchema = z.object({
  waypoints: z.array(waypointSchema).min(1).max(64),
  restoreTarget: z.object({
    absolute: z.literal(true),
    x: z.literal(0),
    y: z.literal(0),
    z: z.literal(0),
  }).strict(),
  glideDurationMs: z.number().int().min(0).max(10_000),
}).strict().superRefine((value, context) => {
  if (value.waypoints.some((waypoint, index) => waypoint.seq !== index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["waypoints"], message: "waypoint sequence must be contiguous from one" });
  }
  const targets = value.waypoints.map((waypoint) => [
    canonicalFloat32(waypoint.target.x),
    canonicalFloat32(waypoint.target.y),
    canonicalFloat32(waypoint.target.z),
  ].join("\0"));
  if (new Set(targets).size !== targets.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["waypoints"], message: "absolute waypoint targets must be unique in the Float32 transport domain" });
  }
});

const capturePolicySchema = z.object({
  maxTries: z.number().int().min(2).max(20),
  intervalMs: z.number().int().nonnegative().max(10_000),
  attemptTimeoutMs: z.number().int().positive().max(30_000),
  deadlineMs: z.number().int().positive().max(120_000),
  comparison: z.literal("byte_exact"),
}).strict();

const budgetsSchema = z.object({
  maxDurationMs: z.number().int().positive().max(30 * 60_000),
  routeReserveMs: z.number().int().positive().max(20 * 60_000),
  restorationReserveMs: z.number().int().positive().max(10 * 60_000),
}).strict().superRefine((value, context) => {
  if (value.routeReserveMs + value.restorationReserveMs > value.maxDurationMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["restorationReserveMs"], message: "route and restoration reserves exceed maxDurationMs" });
  }
});

const priorForegroundSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("receipt_bound"), component: componentSchema, receiptId: hashSchema }).strict(),
  z.object({ kind: z.literal("non_receipt_bound"), component: componentSchema }).strict(),
]);

const reviewedFrameSchema = z.object({
  captureSha256: hashSchema,
  attestation: z.string().min(1).max(4_096),
}).strict();

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function artifactRootIssue(candidate: string): string | null {
  if (!path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) return "artifactRoot must be normalized and absolute";
  if (fs.existsSync(candidate)) return "artifactRoot must not already exist";
  if (isWithin(REPOSITORY_ROOT, candidate) || isWithin(candidate, REPOSITORY_ROOT)) return "artifactRoot must be external to the repository";
  try {
    const parent = fs.lstatSync(path.dirname(candidate));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return "artifactRoot parent must be a regular directory";
  } catch {
    return "artifactRoot parent must already exist";
  }
  return null;
}

const prepareSchema = z.object({
  action: z.literal("prepare"),
  serial: z.string().regex(EMULATOR_SERIAL),
  scenario: scenarioSchema,
  provenance: z.object({
    kind: z.literal("native_run_receipt"),
    receiptId: hashSchema,
    apkSha256: hashSchema,
  }).strict(),
  mechanism: z.enum(["direct", "replacement"]),
  route: routeSchema,
  translationDriftThresholdM: z.literal(0.02),
  capture: capturePolicySchema,
  budgets: budgetsSchema,
  priorForeground: priorForegroundSchema,
  artifactRoot: z.string().min(1),
}).strict().superRefine((value, context) => {
  const rootIssue = artifactRootIssue(value.artifactRoot);
  if (rootIssue) context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifactRoot"], message: rootIssue });
  if (value.mechanism === "replacement" && value.route.glideDurationMs !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["route", "glideDurationMs"], message: "replacement requires a zero glide duration" });
  }
  const prepareBudgetMs = value.budgets.maxDurationMs
    - value.budgets.routeReserveMs
    - value.budgets.restorationReserveMs;
  if (prepareBudgetMs <= 60_000 + value.capture.deadlineMs + 2 * BRIDGE_MIN_TRANSACTION_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "maxDurationMs"],
      message: "prepare budget cannot fit bounded capability/HMD transactions, the mandatory >=60 second monitor, and baseline capture before reserves",
    });
  }
  if (value.budgets.routeReserveMs <= value.capture.deadlineMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "routeReserveMs"],
      message: "route reserve must exceed one complete settled-capture deadline",
    });
  }
  if (value.budgets.routeReserveMs <= value.capture.deadlineMs + value.route.glideDurationMs + 3 * BRIDGE_MIN_TRANSACTION_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "routeReserveMs"],
      message: "route reserve cannot fit the admitted glide, three bounded bridge transactions, and one complete settled capture",
    });
  }
  if (value.budgets.restorationReserveMs <= value.capture.deadlineMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "restorationReserveMs"],
      message: "restoration reserve must exceed one complete settled-capture deadline",
    });
  }
  if (value.budgets.restorationReserveMs <= value.capture.deadlineMs + value.route.glideDurationMs
    + 2 * BRIDGE_MIN_TRANSACTION_MS + FINAL_RECOVERY_RESERVE_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "restorationReserveMs"],
      message: "restoration reserve cannot fit capability, admitted glide, locomotion, settled capture, and final recovery proof",
    });
  }
});

const stepSchema = z.object({
  action: z.literal("step"),
  runId: hashSchema,
  reviewedPriorFrame: reviewedFrameSchema,
  waypoint: waypointSchema,
}).strict();

const restoreSchema = z.object({
  action: z.literal("restore"),
  runId: hashSchema,
  reviewedPriorFrame: reviewedFrameSchema,
}).strict();

const adjudicateSchema = z.object({
  action: z.literal("adjudicate"),
  runId: hashSchema,
  frameAttestations: z.array(reviewedFrameSchema).min(1).max(66),
}).strict();

export const inAppLocomotionInputSchema = z.union([
  prepareSchema,
  stepSchema,
  restoreSchema,
  adjudicateSchema,
]);

export type InAppLocomotionInput = z.infer<typeof inAppLocomotionInputSchema>;
export type InAppLocomotionPrepareInput = z.infer<typeof prepareSchema>;
export type InAppLocomotionStepInput = z.infer<typeof stepSchema>;
export type InAppLocomotionRestoreInput = z.infer<typeof restoreSchema>;
export type InAppLocomotionAdjudicateInput = z.infer<typeof adjudicateSchema>;

export interface LocomotionSafetySnapshot {
  guardian: string;
  vstComponent: string;
  vstDebug: string;
  stageStyle: string;
  safeguard: string;
  safeguardCenter: string;
  virtualContent: string;
}

export interface LocomotionPriorForegroundSnapshot {
  component: string | null;
  packageName: string | null;
  userInstalled: boolean;
}

export interface LocomotionRuntimeBinding {
  liveIdentity: {
    serial: string;
    model: string;
    fingerprint: string;
    bootQemu: string;
    bootId: string;
    observedAt: string;
  };
  applicationBinding: BoundApplicationIdentity;
  foregroundComponent: string;
}

export interface FreshLaunchMonitorSample {
  elapsedMs: number;
  dialogs: string[];
  safety: LocomotionSafetySnapshot;
  continuity: ApplicationContinuitySample;
  runtimeHealth: Pick<PackageRuntimeHealthReceiptV1, "status" | "incidents"> & Partial<PackageRuntimeHealthReceiptV1>;
}

export interface FreshLaunchMonitorReceipt {
  durationMs: number;
  healthBoundaryMarker: string;
  samples: FreshLaunchMonitorSample[];
  rawHealthLogs: LocomotionRawLogEvidence[];
  rawWindowDumps: LocomotionRawLogEvidence[];
}

export interface FreshLaunchHandoffReceipt {
  dialogs: string[];
  rawWindowDump: LocomotionRawLogEvidence;
}

export interface LocomotionRawLogEvidence {
  path: string;
  sha256: string;
  bytes: number;
}

export interface LocomotionLogEvidence {
  path: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
  beginCount: number;
  endCount: number;
  boundarySignals: {
    setSpatialContainerBoundary: number;
    containerInfoChanged: number;
    boundaryMin: number;
    launcherResume: number;
    appPauseOrEjection: number;
  };
}

export interface LocomotionReviewItem extends RequiredReviewItem {
  role: "app_baseline" | "waypoint" | "recovery";
}

export interface LocomotionCaptureReceipt {
  review: LocomotionReviewItem;
  receipt: CaptureSettledReceipt;
}

export interface LocomotionPrepareReceipt {
  status: "needs_baseline_review" | "preflight_rejected" | "preparation_failed";
  runId: string | null;
  artifactRoot: string | null;
  structuralStop: string | null;
  primaryError: string | null;
  cleanupError: string | null;
  evidenceCeiling: "structural";
  lookRequired: true;
  requiredReview: LocomotionReviewItem[];
  rootGeneration?: number;
  rootIncarnation?: string;
  applicationBinding?: BoundApplicationIdentity;
}

export interface LocomotionHmdDriftReceipt {
  translation: {
    method: "euclidean_3d";
    thresholdM: 0.02;
    baselineToPreM: number;
    baselineToPostM: number;
    preToPostM: number;
    pass: boolean;
  };
  quaternion: {
    method: "2*acos(abs(normalized_dot))";
    baseline: AgentBridgeHmdPose["rotation"];
    pre: AgentBridgeHmdPose["rotation"];
    post: AgentBridgeHmdPose["rotation"];
    baselineToPreRadians: number;
    baselineToPostRadians: number;
    preToPostRadians: number;
  };
}

export interface LocomotionStepReceipt {
  status: "needs_waypoint_review" | "route_complete_needs_restore" | "review_rejected" | "stopped";
  runId: string;
  artifactRoot: string;
  waypointSeq?: number;
  rootGeneration: number;
  rootIncarnation: string;
  structuralStop: string | null;
  primaryError: string | null;
  cleanupError: string | null;
  evidenceCeiling: "structural";
  lookRequired: true;
  requiredReview: LocomotionReviewItem[];
  hmdDrift: LocomotionHmdDriftReceipt | null;
  logEvidence: LocomotionLogEvidence | null;
  usage: { waypointAttempts: number; successfulWaypoints: number; routeDurationMs: number };
}

export interface LocomotionPriorForegroundDisposition {
  kind: "none" | "receipt_bound" | "non_receipt_bound";
  component: string | null;
  receiptId: string | null;
  receiptFreshness: "known_stale" | "not_evaluated_cp1";
  relaunchDisposition: "not_applicable" | "withheld_receipt_bound" | "accepted" | "ignored" | "blocked" | "attempt_failed";
}

export interface LocomotionRestoreReceipt {
  status: "restored_needs_review" | "review_rejected" | "restore_failed";
  runId: string;
  artifactRoot: string;
  rootGeneration: number;
  rootIncarnation: string;
  structuralStop: string | null;
  primaryError: string | null;
  cleanupError: string | null;
  evidenceCeiling: "structural";
  lookRequired: true;
  requiredReview: LocomotionReviewItem[];
  priorForeground: LocomotionPriorForegroundDisposition;
}

export interface LocomotionAdjudicateReceipt {
  status: "structural_complete" | "adjudication_rejected";
  runId: string;
  artifactRoot: string;
  artifactPath: string | null;
  evidenceCeiling: "structural";
  lookRequired: true;
  visionEligible: boolean;
  reviewDisposition: "eligible_for_external_vision_adjudication" | "not_eligible";
  captureCount: number;
  primaryError: string | null;
  cleanupError: string | null;
}

export interface PriorRelaunchReceipt {
  disposition: "accepted" | "ignored" | "blocked";
  component: string;
  outputSha256: string;
  activityProbeSha256: string;
  resumedComponents: string[];
}

export interface FinalProcessActivityReceipt {
  serial: string;
  targetPackage: string;
  targetPids: number[];
  resumedComponents: string[];
  rawProbe: LocomotionRawLogEvidence;
}

export interface InAppLocomotionArtifactHooks {
  beforeActionAppendOpen?(context: {
    action: string;
    status: string | null;
    path: string;
  }): void;
  writeActionStage?(context: {
    action: string;
    status: string | null;
    path: string;
    descriptor: number;
    bytes: Buffer;
  }): boolean | void;
  beforeActionStageFsync?(context: { action: string; status: string | null; path: string }): void;
  beforeActionPublish?(context: { action: string; status: string | null; path: string; stagedPath: string }): void;
  afterArtifactReadBeforePathRecheck?(context: { path: string; label: string }): void;
}

type ReceiptValidation = ReturnType<typeof readNativeRunReceipt>;
type CapabilityResult = Awaited<ReturnType<typeof probeAgentBridgeLocomotionCapability>>;
type HmdResult = Awaited<ReturnType<typeof requestAgentBridgeHmdPose>>;
type LocomotionResult = Awaited<ReturnType<typeof requestAgentBridgeLocomotion>>;

interface LocomotionEffectBudget {
  timeoutMs: number;
  deadlineMonotonicNs: string;
  /** Recovery-only fallback: use the already bounded timeout without consulting a failed clock. */
  cleanupOnly?: true;
}

export interface InAppLocomotionDependencies {
  randomBytes(size: number): Buffer;
  now(): string;
  monotonicNs(): bigint;
  readNativeRunReceipt(app: string, receiptId: string): ReceiptValidation;
  readEffectiveAppSpec(artifactPath: string, identity: { sha256: string; bytes: number }): unknown;
  snapshotPriorForeground(context: { serial: string; targetPackage: string } & LocomotionEffectBudget): Promise<LocomotionPriorForegroundSnapshot>;
  stopPackage(context: { serial: string; packageName: string; reason: string } & LocomotionEffectBudget): Promise<unknown>;
  launchTarget(context: { serial: string; component: string } & LocomotionEffectBudget): Promise<{ disposition: "accepted" | "ignored" | "blocked"; component: string; outputSha256: string }>;
  captureLaunchHandoffWindow(context: {
    serial: string;
    runId: string;
    artifactRoot: string;
    packageName: string;
  } & LocomotionEffectBudget): Promise<FreshLaunchHandoffReceipt>;
  probeRuntimeBinding(context: {
    serial: string;
    scenario: InAppLocomotionPrepareInput["scenario"];
    expectedApkSha256: string;
  } & LocomotionEffectBudget): Promise<LocomotionRuntimeBinding>;
  sampleSafety(context: { serial: string; phase: string } & LocomotionEffectBudget): Promise<LocomotionSafetySnapshot>;
  probeCapability(input: AgentBridgeLocomotionTransactionInput): Promise<CapabilityResult>;
  requestHmdPose(input: AgentBridgeHmdPoseRequestInput): Promise<HmdResult>;
  monitorFreshLaunch(context: {
    serial: string;
    runId: string;
    artifactRoot: string;
    minimumDurationMs: 60_000;
    healthBoundaryMarker: string;
    runtime: LocomotionRuntimeBinding;
  } & LocomotionEffectBudget): Promise<FreshLaunchMonitorReceipt>;
  captureSettled(input: CaptureSettledInput): Promise<{ receipt: CaptureSettledReceipt; frame: Buffer | null }>;
  readReviewImage(item: LocomotionReviewItem, artifactRoot: string): Buffer;
  sampleContinuity(context: {
    serial: string;
    phase: string;
    runtime: LocomotionRuntimeBinding;
    artifactRoot: string;
  } & LocomotionEffectBudget): Promise<ApplicationContinuitySample>;
  requestLocomotion(input: AgentBridgeLocomotionRequestInput): Promise<LocomotionResult>;
  emitMarker(context: { serial: string; marker: string } & LocomotionEffectBudget): Promise<void>;
  collectStepLogs(context: {
    serial: string;
    packageName: string;
    pid: number;
    beginMarker: string;
    endMarker: string;
    path: string;
  } & LocomotionEffectBudget): Promise<LocomotionLogEvidence>;
  relaunchPrior(context: { serial: string; component: string } & LocomotionEffectBudget): Promise<PriorRelaunchReceipt>;
  probeFinalProcessState(context: {
    serial: string;
    targetPackage: string;
    artifactRoot: string;
    priorForeground: InAppLocomotionPrepareInput["priorForeground"];
  } & LocomotionEffectBudget): Promise<FinalProcessActivityReceipt>;
}

interface ArtifactFileIdentity {
  dev: number;
  ino: number;
  bytes: number;
  sha256: string;
}

interface OwnedArtifactBinding extends ReservedArtifactSession {
  rootDev: number;
  rootIno: number;
  capturesDev: number;
  capturesIno: number;
  logsDev: number;
  logsIno: number;
  ownerFile: ArtifactFileIdentity;
  runManifest: ArtifactFileIdentity;
  routeManifest: ArtifactFileIdentity;
  actionLog: ArtifactFileIdentity;
}

interface LocomotionState {
  input: InAppLocomotionPrepareInput;
  artifact: OwnedArtifactBinding;
  status: "prepared" | "stepped" | "stopped" | "restored" | "adjudicated";
  receipt: Extract<ReceiptValidation, { status: "valid" }>["receipt"];
  receiptCanonical: string;
  effectiveSpecCanonical: string;
  runtime: LocomotionRuntimeBinding;
  prior: LocomotionPriorForegroundSnapshot;
  priorTerminatedByRun: boolean;
  targetOwned: boolean;
  rootGeneration: number;
  rootIncarnation: string;
  baselineHmd: AgentBridgeHmdPose;
  currentReview: LocomotionReviewItem;
  requiredReview: LocomotionReviewItem[];
  retainedLogs: Array<{ path: string; identity: ArtifactFileIdentity; label: string }>;
  nextWaypoint: number;
  startedAtNs: bigint;
  deadlineNs: bigint;
  usage: { waypointAttempts: number; successfulWaypoints: number; routeDurationMs: number };
  restoreAttempted: boolean;
  restoreCompleted: boolean;
  adjudicated: boolean;
  currentReviewReflectsNonzeroMutation: boolean;
}

interface SerialLease {
  runId: string;
  status: "active" | "quarantined";
  reason: string;
}

class LocomotionStageError extends Error {
  constructor(readonly code: string, message: string, readonly cleanupError: string | null = null) {
    super(message);
    this.name = "LocomotionStageError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkedNow(dependencies: InAppLocomotionDependencies): string {
  const value = dependencies.now();
  if (!Number.isFinite(Date.parse(value))) throw new Error("wall clock dependency returned an invalid timestamp");
  return value;
}

function checkedMonotonic(dependencies: InAppLocomotionDependencies): bigint {
  const value = dependencies.monotonicNs();
  if (typeof value !== "bigint" || value < 0n) throw new Error("monotonic clock dependency returned an invalid value");
  return value;
}

function privateWrite(filePath: string, value: string | Buffer): void {
  const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function privateJson(filePath: string, value: unknown): void {
  privateWrite(filePath, `${canonicalJson(value)}\n`);
}

function artifactFileIdentity(
  filePath: string,
  label: string,
  maxBytes: number,
  hooks: InAppLocomotionArtifactHooks = {},
): ArtifactFileIdentity {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes || fs.realpathSync(filePath) !== filePath) {
      throw new Error(`${label} is not one exact bounded non-symlink file`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error(`${label} ended while its immutable identity was read`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} changed while its immutable identity was read`);
    }
    hooks.afterArtifactReadBeforePathRecheck?.({ path: filePath, label });
    const published = fs.lstatSync(filePath);
    if (!published.isFile() || published.isSymbolicLink() || fs.realpathSync(filePath) !== filePath
      || published.dev !== after.dev || published.ino !== after.ino || published.size !== after.size) {
      throw new Error(`${label} pathname identity changed after its descriptor bytes were read`);
    }
    const finalBytes = descriptorBytes(descriptor, after.size, label);
    const final = fs.fstatSync(descriptor);
    if (final.dev !== after.dev || final.ino !== after.ino || final.size !== after.size
      || final.mtimeMs !== after.mtimeMs || final.ctimeMs !== after.ctimeMs || !finalBytes.equals(bytes)) {
      throw new Error(`${label} descriptor bytes changed after pathname identity recheck`);
    }
    return { dev: final.dev, ino: final.ino, bytes: finalBytes.length, sha256: sha256Bytes(finalBytes) };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertSameArtifactFile(
  filePath: string,
  expected: ArtifactFileIdentity,
  label: string,
  maxBytes: number,
  hooks: InAppLocomotionArtifactHooks = {},
): void {
  const actual = artifactFileIdentity(filePath, label, maxBytes, hooks);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`${label} changed after immutable publication`);
  }
}

function readSameArtifactFile(
  filePath: string,
  expected: ArtifactFileIdentity,
  label: string,
  maxBytes: number,
  hooks: InAppLocomotionArtifactHooks = {},
): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino
      || before.size !== expected.bytes || before.size > maxBytes) {
      throw new Error(`${label} opened descriptor identity changed after immutable publication`);
    }
    const bytes = descriptorBytes(descriptor, before.size, label);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || sha256Bytes(bytes) !== expected.sha256) {
      throw new Error(`${label} descriptor bytes changed after immutable publication`);
    }
    hooks.afterArtifactReadBeforePathRecheck?.({ path: filePath, label });
    const published = fs.lstatSync(filePath);
    if (!published.isFile() || published.isSymbolicLink() || fs.realpathSync(filePath) !== filePath
      || published.dev !== after.dev || published.ino !== after.ino || published.size !== after.size) {
      throw new Error(`${label} pathname identity changed after its descriptor bytes were read`);
    }
    const finalBytes = descriptorBytes(descriptor, after.size, label);
    const final = fs.fstatSync(descriptor);
    if (final.dev !== after.dev || final.ino !== after.ino || final.size !== after.size
      || final.mtimeMs !== after.mtimeMs || final.ctimeMs !== after.ctimeMs
      || !finalBytes.equals(bytes) || sha256Bytes(finalBytes) !== expected.sha256) {
      throw new Error(`${label} descriptor bytes changed after pathname identity recheck`);
    }
    return finalBytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function unlinkExactArtifact(filePath: string, expected: ArtifactFileIdentity, label: string, maxBytes: number): void {
  assertSameArtifactFile(filePath, expected, label, maxBytes);
  fs.unlinkSync(filePath);
  if (fs.existsSync(filePath)) throw new Error(`${label} still exists after exact cleanup`);
}

function descriptorBytes(descriptor: number, size: number, label: string): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error(`${label} ended while descriptor bytes were read`);
    offset += count;
  }
  return bytes;
}

function appendAction(binding: OwnedArtifactBinding, value: unknown, hooks: InAppLocomotionArtifactHooks): void {
  assertOwnedArtifacts(binding, hooks);
  const target = path.join(binding.absoluteRoot, "actions.jsonl");
  const action = value && typeof value === "object" && !Array.isArray(value)
    ? String((value as Record<string, unknown>).action ?? "unknown")
    : "unknown";
  const status = value && typeof value === "object" && !Array.isArray(value)
    ? typeof (value as Record<string, unknown>).status === "string" ? String((value as Record<string, unknown>).status) : null
    : null;
  hooks.beforeActionAppendOpen?.({ action, status, path: target });
  const priorBytes = readSameArtifactFile(target, binding.actionLog, "action JSONL", 16 * 1024 * 1024, hooks);
  const appended = Buffer.concat([priorBytes, Buffer.from(`${canonicalJson(value)}\n`, "utf8")]);
  if (appended.length > 16 * 1024 * 1024) throw new Error("action JSONL exceeds its bounded publication limit");
  const stagedPath = path.join(binding.absoluteRoot, `.actions.jsonl.${crypto.randomBytes(16).toString("hex")}.tmp`);
  try {
    const descriptor = fs.openSync(stagedPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const handled = hooks.writeActionStage?.({ action, status, path: target, descriptor, bytes: appended }) === true;
      if (!handled) {
        let offset = 0;
        while (offset < appended.length) offset += fs.writeSync(descriptor, appended, offset, appended.length - offset, offset);
      }
      hooks.beforeActionStageFsync?.({ action, status, path: target });
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const staged = artifactFileIdentity(stagedPath, "staged action JSONL", 16 * 1024 * 1024, hooks);
    if (staged.bytes !== appended.length || staged.sha256 !== sha256Bytes(appended)) {
      throw new Error("staged action JSONL bytes did not match the complete intended ledger");
    }
    hooks.beforeActionPublish?.({ action, status, path: target, stagedPath });
    assertSameArtifactFile(target, binding.actionLog, "action JSONL", 16 * 1024 * 1024, hooks);
    fs.renameSync(stagedPath, target);
    const published = artifactFileIdentity(target, "action JSONL", 16 * 1024 * 1024, hooks);
    if (published.bytes !== appended.length || published.sha256 !== sha256Bytes(appended)) {
      throw new Error("action JSONL atomic publication did not retain the complete staged ledger");
    }
    binding.actionLog = published;
    const directoryDescriptor = fs.openSync(binding.absoluteRoot, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
  }
}

function directoryIdentity(directory: string, label: string): { dev: number; ino: number } {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${label} is not one exact owned non-symlink directory`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function sameDirectory(directory: string, identity: { dev: number; ino: number }, label: string): void {
  const actual = directoryIdentity(directory, label);
  if (actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error(`${label} identity changed after reservation`);
}

function assertOwnedArtifacts(binding: OwnedArtifactBinding, hooks: InAppLocomotionArtifactHooks = {}): void {
  sameDirectory(binding.absoluteRoot, { dev: binding.rootDev, ino: binding.rootIno }, "artifact root");
  sameDirectory(path.join(binding.absoluteRoot, "captures"), { dev: binding.capturesDev, ino: binding.capturesIno }, "capture directory");
  sameDirectory(path.join(binding.absoluteRoot, "logs"), { dev: binding.logsDev, ino: binding.logsIno }, "log directory");
  const ownerBytes = readSameArtifactFile(
    path.join(binding.absoluteRoot, ".owner.json"),
    binding.ownerFile,
    "artifact ownership manifest",
    64 * 1024,
    hooks,
  );
  assertSameArtifactFile(path.join(binding.absoluteRoot, "run.json"), binding.runManifest, "run manifest", 1024 * 1024, hooks);
  assertSameArtifactFile(path.join(binding.absoluteRoot, "route.json"), binding.routeManifest, "route manifest", 1024 * 1024, hooks);
  assertSameArtifactFile(path.join(binding.absoluteRoot, "actions.jsonl"), binding.actionLog, "action JSONL", 16 * 1024 * 1024, hooks);
  const owner = JSON.parse(ownerBytes.toString("utf8"));
  if (owner.schemaVersion !== 1 || owner.runId !== binding.runId || owner.ownerNonceHash !== binding.ownerNonceHash) {
    throw new Error("artifact ownership record changed after reservation");
  }
}

function reserveArtifacts(input: InAppLocomotionPrepareInput, dependencies: InAppLocomotionDependencies): {
  binding: OwnedArtifactBinding;
  createdAt: string;
  startedAtNs: bigint;
} {
  const physical = resolveProspectivePath(input.artifactRoot);
  if (artifactRootIssue(physical)) throw new Error(artifactRootIssue(physical)!);
  const nonce = dependencies.randomBytes(32);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw new Error("random source must return exactly 32 bytes");
  const startedAtNs = checkedMonotonic(dependencies);
  const createdAt = checkedNow(dependencies);
  const runId = sha256Bytes(Buffer.concat([nonce, Buffer.from(input.serial), Buffer.from(startedAtNs.toString())]));
  const ownerNonceHash = sha256Bytes(nonce);
  fs.mkdirSync(physical, { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(physical, "captures"), { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(physical, "logs"), { recursive: false, mode: 0o700 });
  const root = directoryIdentity(physical, "artifact root");
  const captures = directoryIdentity(path.join(physical, "captures"), "capture directory");
  const logs = directoryIdentity(path.join(physical, "logs"), "log directory");
  privateJson(path.join(physical, ".owner.json"), { schemaVersion: 1, runId, ownerNonceHash });
  privateJson(path.join(physical, "run.json"), {
    schemaVersion: 1,
    runId,
    createdAt,
    serial: input.serial,
    scenario: input.scenario,
    provenance: input.provenance,
    mechanism: input.mechanism,
    capture: input.capture,
    budgets: input.budgets,
    translationDriftThresholdM: input.translationDriftThresholdM,
    priorForeground: input.priorForeground,
    evidenceCeiling: "structural",
    lookRequired: true,
  });
  privateJson(path.join(physical, "route.json"), {
    schemaVersion: 1,
    mechanism: input.mechanism,
    waypoints: input.route.waypoints,
    restoreTarget: input.route.restoreTarget,
    glideDurationMs: input.route.glideDurationMs,
  });
  privateWrite(path.join(physical, "actions.jsonl"), "");
  const binding: OwnedArtifactBinding = {
    runId,
    absoluteRoot: physical,
    ownerNonceHash,
    rootDev: root.dev,
    rootIno: root.ino,
    capturesDev: captures.dev,
    capturesIno: captures.ino,
    logsDev: logs.dev,
    logsIno: logs.ino,
    ownerFile: artifactFileIdentity(path.join(physical, ".owner.json"), "artifact ownership manifest", 64 * 1024),
    runManifest: artifactFileIdentity(path.join(physical, "run.json"), "run manifest", 1024 * 1024),
    routeManifest: artifactFileIdentity(path.join(physical, "route.json"), "route manifest", 1024 * 1024),
    actionLog: artifactFileIdentity(path.join(physical, "actions.jsonl"), "action JSONL", 16 * 1024 * 1024),
  };
  assertOwnedArtifacts(binding);
  return { binding, createdAt, startedAtNs };
}

interface ReceiptAndSpecBinding {
  validation: Extract<ReceiptValidation, { status: "valid" }>;
  receiptCanonical: string;
  effectiveSpecCanonical: string;
}

function assertReceiptAndSpec(input: InAppLocomotionPrepareInput, dependencies: InAppLocomotionDependencies): ReceiptAndSpecBinding {
  const validation = dependencies.readNativeRunReceipt(input.scenario.packageName, input.provenance.receiptId);
  if (validation.status !== "valid") throw new LocomotionStageError("receipt_invalid", `native run receipt is invalid: ${validation.issues.join("; ")}`);
  const receipt = validation.receipt;
  if (receipt.receiptId !== input.provenance.receiptId
    || receipt.app !== input.scenario.packageName
    || receipt.apk.packageName !== input.scenario.packageName
    || receipt.install.packageName !== input.scenario.packageName
    || receipt.apk.sha256 !== input.provenance.apkSha256
    || receipt.install.remoteApkSha256 !== input.provenance.apkSha256
    || receipt.runtime.serial !== input.serial
    || receipt.runtime.component !== input.scenario.launchComponent) {
    throw new LocomotionStageError("receipt_binding_failed", "native run receipt does not bind the exact serial, package, component, and APK");
  }
  const spec = dependencies.readEffectiveAppSpec(receipt.source.effectiveAppSpec.artifactPath, receipt.source.effectiveAppSpec) as any;
  if (spec?.meta?.packageName !== input.scenario.packageName
    || spec?.meta?.stageStyle !== "3"
    || spec?.meta?.rootContainer !== "stage") {
    throw new LocomotionStageError("capability_unavailable", "receipt-bound effective AppSpec is not an eligible Full stage (stageStyle 3, rootContainer stage)");
  }
  return {
    validation,
    receiptCanonical: canonicalJson(receipt),
    effectiveSpecCanonical: canonicalJson(spec),
  };
}

function assertCurrentReceiptAndSpec(state: LocomotionState, dependencies: InAppLocomotionDependencies): void {
  const current = assertReceiptAndSpec(state.input, dependencies);
  if (current.receiptCanonical !== state.receiptCanonical
    || current.effectiveSpecCanonical !== state.effectiveSpecCanonical) {
    throw new Error("authoritative native receipt or effective AppSpec binding changed after prepare");
  }
}

function expectedPrior(input: InAppLocomotionPrepareInput, observed: LocomotionPriorForegroundSnapshot): void {
  if ((observed.component === null) !== (observed.packageName === null)) throw new Error("prior foreground snapshot has contradictory component/package identity");
  if (observed.component !== null && !observed.component.startsWith(`${observed.packageName}/`)) throw new Error("prior foreground component does not belong to its package");
  if (input.priorForeground.kind === "none") {
    if (observed.component !== null) throw new Error(`unexpected prior foreground '${observed.component}' was not declared`);
    return;
  }
  if (observed.component !== input.priorForeground.component) {
    throw new Error(`declared prior foreground '${input.priorForeground.component}' does not match '${observed.component ?? "none"}'`);
  }
  if (!observed.userInstalled) throw new Error("declared prior foreground is not in the exact third-party package inventory");
}

const CLEAN_FULL_SAFETY: LocomotionSafetySnapshot = {
  guardian: "1",
  vstComponent: "1",
  vstDebug: "1",
  stageStyle: "3",
  safeguard: "1",
  safeguardCenter: "0,0,0",
  virtualContent: "1",
};

function safetyProblem(value: LocomotionSafetySnapshot): string | null {
  for (const key of Object.keys(CLEAN_FULL_SAFETY) as Array<keyof LocomotionSafetySnapshot>) {
    if (value?.[key] !== CLEAN_FULL_SAFETY[key]) return `${key}=${String(value?.[key])}, expected ${CLEAN_FULL_SAFETY[key]}`;
  }
  return null;
}

function finalGlobalSafetyProblem(value: LocomotionSafetySnapshot): string | null {
  for (const key of ["guardian", "vstComponent", "vstDebug"] as const) {
    if (value?.[key] !== CLEAN_FULL_SAFETY[key]) return `${key}=${String(value?.[key])}, expected ${CLEAN_FULL_SAFETY[key]}`;
  }
  return null;
}

function continuityProblem(sample: ApplicationContinuitySample, runtime: LocomotionRuntimeBinding): string | null {
  const binding = runtime.applicationBinding;
  if (sample.serial !== runtime.liveIdentity.serial || sample.bootId !== runtime.liveIdentity.bootId
    || sample.packageName !== binding.packageName || sample.apkSha256 !== binding.apkSha256
    || sample.pid !== binding.pid || sample.pidStartTicks !== binding.pidStartTicks
    || canonicalJson([...sample.allowedResumedComponents].sort()) !== canonicalJson([...binding.allowedResumedComponents].sort())
    || sample.foreground !== "exact_allowed"
    || !sample.resumedComponents.includes(runtime.foregroundComponent)) {
    return "continuity sample lost the exact boot/APK/PID/start/foreground binding";
  }
  return null;
}

function hmdPoseFrom(result: HmdResult, expectedGeneration: number, expectedIncarnation: string): AgentBridgeHmdPose {
  if (!result.ok) throw new LocomotionStageError(result.code, result.primaryError ?? result.detail, result.cleanupError);
  const pose = result.ack.hmdPose;
  if (result.ack.root?.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID || result.ack.root.generation !== expectedGeneration
    || result.ack.root.incarnation !== expectedIncarnation || pose === null) {
    throw new Error("HMD result lost the exact root generation/incarnation binding");
  }
  const values = [pose.position.x, pose.position.y, pose.position.z, pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w];
  if (!values.every(Number.isFinite) || !/^(?:0|[1-9][0-9]*)$/.test(pose.readAtMonotonicNs)) throw new Error("HMD pose is missing finite position/quaternion telemetry");
  if (Math.hypot(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w) === 0) throw new Error("HMD quaternion has zero norm");
  return pose;
}

function validateRuntime(input: InAppLocomotionPrepareInput, receipt: Extract<ReceiptValidation, { status: "valid" }>["receipt"], runtime: LocomotionRuntimeBinding): void {
  const binding = runtime.applicationBinding;
  if (runtime.liveIdentity.serial !== input.serial || runtime.liveIdentity.bootQemu !== "1"
    || runtime.liveIdentity.bootId !== receipt.runtime.bootId
    || runtime.liveIdentity.model !== receipt.runtime.model
    || runtime.liveIdentity.fingerprint !== receipt.runtime.fingerprint
    || binding.packageName !== input.scenario.packageName
    || binding.apkSha256 !== input.provenance.apkSha256
    || !Number.isSafeInteger(binding.pid) || binding.pid < 1
    || !/^[1-9][0-9]*$/.test(binding.pidStartTicks)
    || canonicalJson([...binding.allowedResumedComponents].sort()) !== canonicalJson([...input.scenario.allowedResumedComponents].sort())
    || !input.scenario.allowedResumedComponents.includes(runtime.foregroundComponent)) {
    throw new Error("fresh launch does not bind the exact receipt boot/APK/PID/start/foreground identity");
  }
}

function freshLaunchDialogs(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    /Application Error|isn't responding|has stopped|(?:^|\s)ANR(?:\s|$)|mCurrentFocus=.*(?:Dialog|Error)/i.test(line));
}

function validateMonitor(
  monitor: FreshLaunchMonitorReceipt,
  runtime: LocomotionRuntimeBinding,
  expectedBoundaryMarker: string,
): void {
  if (!Number.isFinite(monitor.durationMs) || monitor.durationMs < 60_000 || !Array.isArray(monitor.samples) || monitor.samples.length < 2) {
    throw new Error("fresh-launch monitor did not retain multiple samples through at least 60 seconds");
  }
  const elapsed = monitor.samples.map((sample) => sample.elapsedMs);
  if (elapsed.some((value, index) => !Number.isFinite(value) || value < 0 || (index > 0 && value <= elapsed[index - 1]))) {
    throw new Error("fresh-launch monitor sample times are invalid or non-monotonic");
  }
  if (elapsed.at(-1)! < 60_000) throw new Error("fresh-launch monitor final sample was earlier than 60 seconds");
  if (!Array.isArray(monitor.rawHealthLogs) || monitor.rawHealthLogs.length !== monitor.samples.length) {
    throw new Error("fresh-launch monitor did not retain one exact raw runtime-health log per sample");
  }
  if (monitor.healthBoundaryMarker !== expectedBoundaryMarker) {
    throw new Error("fresh-launch monitor did not use the authenticated preparation BEGIN boundary");
  }
  if (!Array.isArray(monitor.rawWindowDumps) || monitor.rawWindowDumps.length !== monitor.samples.length) {
    throw new Error("fresh-launch monitor did not retain one exact raw window dump per sample");
  }
  for (const [index, sample] of monitor.samples.entries()) {
    if (!Array.isArray(sample.dialogs) || sample.dialogs.length > 0) throw new Error("fresh-launch dialog monitor observed a blocking dialog");
    const health = sample.runtimeHealth;
    if (health?.schemaVersion !== 1 || health.sourceSha256 !== monitor.rawHealthLogs[index].sha256
      || health.marker !== expectedBoundaryMarker || health.markerOccurrences !== 1
      || health.packageName !== runtime.applicationBinding.packageName
      || canonicalJson(health.expectedPids) !== canonicalJson([runtime.applicationBinding.pid])) {
      throw new Error("fresh-launch runtime-health receipt lost exact source SHA/marker/package/PID binding");
    }
    if (health.status !== "no_attributed_failure" || !Array.isArray(health.incidents) || health.incidents.length > 0) {
      throw new Error("fresh-launch runtime-health monitor found an attributed failure or inconclusive sample");
    }
    const unsafe = safetyProblem(sample.safety);
    if (unsafe) throw new Error(`fresh-launch safety drift: ${unsafe}`);
    const continuity = continuityProblem(sample.continuity, runtime);
    if (continuity) throw new Error(continuity);
  }
}

function checkedRawLogEvidence(value: LocomotionRawLogEvidence, artifactRoot: string, label: string): {
  path: string;
  identity: ArtifactFileIdentity;
  label: string;
} {
  if (!value || typeof value.path !== "string") throw new Error(`${label} omitted its exact raw log path`);
  if (!isWithin(path.join(artifactRoot, "logs"), value.path)) throw new Error(`${label} path is outside the owned logs directory`);
  if (!SHA256.test(value.sha256)) throw new Error(`${label} omitted its exact raw log SHA-256`);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 64 * 1024 * 1024) {
    throw new Error(`${label} byte length is invalid or exceeds its bound`);
  }
  const identity = artifactFileIdentity(value.path, label, 64 * 1024 * 1024);
  if (identity.bytes !== value.bytes || identity.sha256 !== value.sha256) {
    throw new Error(`${label} bytes do not match the published runtime-health reference`);
  }
  return { path: value.path, identity, label };
}

function captureReview(captured: Awaited<ReturnType<InAppLocomotionDependencies["captureSettled"]>>, expectedPath: string, role: LocomotionReviewItem["role"], waypointSeq?: number): LocomotionReviewItem {
  const receipt = captured.receipt;
  if (receipt.status !== "settled" || !receipt.settlementSatisfied || receipt.evidenceCeiling !== "structural"
    || receipt.lookRequired !== true || !receipt.path || !receipt.sha256 || receipt.path !== expectedPath
    || receipt.captureRef?.sha256 !== receipt.sha256) {
    throw new Error(`${role} capture did not return one settled structural LOOK-required retained PNG`);
  }
  return {
    captureSha256: receipt.sha256,
    role,
    ...(waypointSeq === undefined ? {} : { waypointSeq }),
    settled: true,
    path: receipt.path,
  };
}

function preparationFailure(code: string, error: unknown, runId: string | null, artifactRoot: string | null, cleanupError: string | null): LocomotionPrepareReceipt {
  return {
    status: runId === null ? "preflight_rejected" : "preparation_failed",
    runId,
    artifactRoot,
    structuralStop: code,
    primaryError: errorText(error),
    cleanupError,
    evidenceCeiling: "structural",
    lookRequired: true,
    requiredReview: [],
  };
}

function float32(value: number): number {
  return canonicalFloat32(value);
}

function nonzeroPosition(position: { x: number; y: number; z: number }): boolean {
  return canonicalFloat32(position.x) !== 0 || canonicalFloat32(position.y) !== 0 || canonicalFloat32(position.z) !== 0;
}

function samePosition(
  observed: { x: number; y: number; z: number },
  expected: { x: number; y: number; z: number },
): boolean {
  return float32(observed.x) === float32(expected.x)
    && float32(observed.y) === float32(expected.y)
    && float32(observed.z) === float32(expected.z);
}

function translationDistance(
  left: AgentBridgeHmdPose["position"],
  right: AgentBridgeHmdPose["position"],
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function quaternionDistance(
  left: AgentBridgeHmdPose["rotation"],
  right: AgentBridgeHmdPose["rotation"],
): number {
  const leftNorm = Math.hypot(left.x, left.y, left.z, left.w);
  const rightNorm = Math.hypot(right.x, right.y, right.z, right.w);
  if (!Number.isFinite(leftNorm) || !Number.isFinite(rightNorm) || leftNorm === 0 || rightNorm === 0) {
    throw new Error("quaternion angular drift requires finite non-zero inputs");
  }
  const dot = (left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w) / (leftNorm * rightNorm);
  return 2 * Math.acos(Math.min(1, Math.max(0, Math.abs(dot))));
}

function driftReceipt(baseline: AgentBridgeHmdPose, pre: AgentBridgeHmdPose, post: AgentBridgeHmdPose): LocomotionHmdDriftReceipt {
  const baselineToPreM = translationDistance(baseline.position, pre.position);
  const baselineToPostM = translationDistance(baseline.position, post.position);
  const preToPostM = translationDistance(pre.position, post.position);
  return {
    translation: {
      method: "euclidean_3d",
      thresholdM: 0.02,
      baselineToPreM,
      baselineToPostM,
      preToPostM,
      pass: Math.max(baselineToPreM, baselineToPostM, preToPostM) <= 0.02,
    },
    quaternion: {
      method: "2*acos(abs(normalized_dot))",
      baseline: { ...baseline.rotation },
      pre: { ...pre.rotation },
      post: { ...post.rotation },
      baselineToPreRadians: quaternionDistance(baseline.rotation, pre.rotation),
      baselineToPostRadians: quaternionDistance(baseline.rotation, post.rotation),
      preToPostRadians: quaternionDistance(pre.rotation, post.rotation),
    },
  };
}

function checkedLogEvidence(
  value: LocomotionLogEvidence,
  expectedPath: string,
  packageName: string,
  beginMarker: string,
  endMarker: string,
  hooks: InAppLocomotionArtifactHooks = {},
): LocomotionLogEvidence {
  if (value.path !== expectedPath || !SHA256.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || value.bytes > 64 * 1024 * 1024 || value.truncated || value.beginCount !== 1 || value.endCount !== 1
    || Object.values(value.boundarySignals).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
    throw new Error("step log evidence is not one complete bounded BEGIN/END window with zero container/boundary transitions");
  }
  const identity = artifactFileIdentity(expectedPath, "retained step log", 64 * 1024 * 1024, hooks);
  if (identity.bytes !== value.bytes || identity.sha256 !== value.sha256) throw new Error("step log evidence bytes changed after collection");
  const bytes = readSameArtifactFile(expectedPath, identity, "retained step log", 64 * 1024 * 1024, hooks);
  const text = bytes.toString("utf8");
  const replayed = {
    beginCount: text.split(beginMarker).length - 1,
    endCount: text.split(endMarker).length - 1,
    boundarySignals: parseLocomotionBracketSignals(text, packageName, { beginMarker, endMarker }),
  };
  if (replayed.beginCount !== value.beginCount || replayed.endCount !== value.endCount
    || canonicalJson(replayed.boundarySignals) !== canonicalJson(value.boundarySignals)) {
    throw new Error("step log marker/boundary claims do not reproduce from retained descriptor bytes");
  }
  return value;
}

function checkedPreparationLogEvidence(
  value: LocomotionLogEvidence,
  expectedPath: string,
  packageName: string,
  beginMarker: string,
  endMarker: string,
  hooks: InAppLocomotionArtifactHooks = {},
): LocomotionLogEvidence {
  if (value.path !== expectedPath || !SHA256.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || value.bytes > 64 * 1024 * 1024 || value.truncated || value.beginCount !== 1 || value.endCount !== 1
    || Object.values(value.boundarySignals).some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("preparation log evidence is not one complete bounded BEGIN/END launch-handoff window");
  }
  const identity = artifactFileIdentity(expectedPath, "retained preparation log", 64 * 1024 * 1024, hooks);
  if (identity.bytes !== value.bytes || identity.sha256 !== value.sha256) {
    throw new Error("preparation log evidence bytes changed after collection");
  }
  const bytes = readSameArtifactFile(expectedPath, identity, "retained preparation log", 64 * 1024 * 1024, hooks);
  const text = bytes.toString("utf8");
  const replayed = {
    beginCount: text.split(beginMarker).length - 1,
    endCount: text.split(endMarker).length - 1,
    boundarySignals: parseLocomotionBracketSignals(text, packageName, { beginMarker, endMarker }),
  };
  if (replayed.beginCount !== value.beginCount || replayed.endCount !== value.endCount
    || canonicalJson(replayed.boundarySignals) !== canonicalJson(value.boundarySignals)) {
    throw new Error("preparation log marker/boundary claims do not reproduce from retained descriptor bytes");
  }
  return value;
}

function assertStateArtifacts(state: LocomotionState, hooks: InAppLocomotionArtifactHooks = {}): void {
  assertOwnedArtifacts(state.artifact, hooks);
  for (const [index, retained] of state.retainedLogs.entries()) {
    assertSameArtifactFile(retained.path, retained.identity, retained.label || `retained evidence log ${index + 1}`, 64 * 1024 * 1024, hooks);
  }
}

function stepReviewFailure(state: LocomotionState, detail: string): LocomotionStepReceipt {
  return {
    status: "review_rejected",
    runId: state.artifact.runId,
    artifactRoot: state.artifact.absoluteRoot,
    rootGeneration: state.rootGeneration,
    rootIncarnation: state.rootIncarnation,
    structuralStop: null,
    primaryError: detail,
    cleanupError: null,
    evidenceCeiling: "structural",
    lookRequired: true,
    requiredReview: [state.currentReview],
    hmdDrift: null,
    logEvidence: null,
    usage: { ...state.usage },
  };
}

function priorForegroundDispositionFor(
  input: InAppLocomotionPrepareInput,
  priorTerminatedByRun: boolean,
): LocomotionPriorForegroundDisposition {
  const declared = input.priorForeground;
  if (declared.kind === "none") {
    return {
      kind: "none",
      component: null,
      receiptId: null,
      receiptFreshness: "not_evaluated_cp1",
      relaunchDisposition: "not_applicable",
    };
  }
  if (declared.kind === "receipt_bound") {
    return {
      kind: "receipt_bound",
      component: declared.component,
      receiptId: declared.receiptId,
      receiptFreshness: priorTerminatedByRun ? "known_stale" : "not_evaluated_cp1",
      relaunchDisposition: "withheld_receipt_bound",
    };
  }
  return {
    kind: "non_receipt_bound",
    component: declared.component,
    receiptId: null,
    receiptFreshness: "not_evaluated_cp1",
    relaunchDisposition: "not_applicable",
  };
}

function priorForegroundDisposition(state: LocomotionState): LocomotionPriorForegroundDisposition {
  return priorForegroundDispositionFor(state.input, state.priorTerminatedByRun);
}

function restoreReviewFailure(state: LocomotionState, detail: string): LocomotionRestoreReceipt {
  return {
    status: "review_rejected",
    runId: state.artifact.runId,
    artifactRoot: state.artifact.absoluteRoot,
    rootGeneration: state.rootGeneration,
    rootIncarnation: state.rootIncarnation,
    structuralStop: null,
    primaryError: detail,
    cleanupError: null,
    evidenceCeiling: "structural",
    lookRequired: true,
    requiredReview: [state.currentReview],
    priorForeground: priorForegroundDisposition(state),
  };
}

function earlierDeadline(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function remainingUntilMs(deadlineNs: bigint, dependencies: InAppLocomotionDependencies): number {
  return Math.floor(Number((deadlineNs - checkedMonotonic(dependencies)) / 1_000_000n));
}

async function withinDeadline<T>(
  deadlineNs: bigint,
  dependencies: InAppLocomotionDependencies,
  label: string,
  operation: (remainingMs: number) => Promise<T>,
): Promise<T> {
  const before = remainingUntilMs(deadlineNs, dependencies);
  if (before < 1) throw new LocomotionStageError("budget_exhausted", `${label} cannot begin at or after its fixed phase deadline`);
  const value = await operation(before);
  if (remainingUntilMs(deadlineNs, dependencies) < 0) {
    throw new LocomotionStageError("budget_exhausted", `${label} exceeded its fixed phase deadline`);
  }
  return value;
}

function bridgeBudgetFields(remainingMs: number, deadlineNs: bigint): Pick<
  AgentBridgeLocomotionTransactionInput,
  "maxPolls" | "pollMs" | "stabilityReads" | "controlTimeoutMs" | "ackReadTimeoutMs" | "deadlineMonotonicNs"
> {
  if (remainingMs < BRIDGE_MIN_TRANSACTION_MS) {
    throw new LocomotionStageError(
      "budget_exhausted",
      `remaining phase budget cannot fit the ${BRIDGE_MIN_TRANSACTION_MS}ms minimum AgentBridge transaction envelope`,
    );
  }
  return {
    maxPolls: BRIDGE_MAX_POLLS,
    pollMs: BRIDGE_POLL_MS,
    stabilityReads: 2,
    controlTimeoutMs: Math.min(15_000, remainingMs),
    ackReadTimeoutMs: Math.min(2_000, remainingMs),
    deadlineMonotonicNs: deadlineNs.toString(),
  };
}

function completedLocomotionAck(result: LocomotionResult): AgentBridgeLocomotionAck | null {
  if (result.ok) return result.ack;
  if (result.code === "cleanup_failed" && result.primaryError === null && result.ack?.outcome === "completed") {
    return result.ack;
  }
  return null;
}

function validatePriorRelaunchReceipt(receipt: PriorRelaunchReceipt, component: string): string | null {
  if (receipt.component !== component || !SHA256.test(receipt.outputSha256)
    || !SHA256.test(receipt.activityProbeSha256)) {
    return "prior relaunch receipt lost exact component/output/probe identity";
  }
  if (receipt.disposition !== "accepted") return `prior relaunch was ${receipt.disposition}`;
  if (!Array.isArray(receipt.resumedComponents) || receipt.resumedComponents.length !== 1
    || receipt.resumedComponents[0] !== component) {
    return "prior relaunch did not prove one exact resumed component in the activity re-probe";
  }
  return null;
}

function checkedFinalProcessProof(
  receipt: FinalProcessActivityReceipt,
  input: InAppLocomotionPrepareInput,
  artifactRoot: string,
): { retained: { path: string; identity: ArtifactFileIdentity; label: string }; problem: string | null } {
  if (receipt?.serial !== input.serial || receipt.targetPackage !== input.scenario.packageName
    || !Array.isArray(receipt.targetPids) || receipt.targetPids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
    || new Set(receipt.targetPids).size !== receipt.targetPids.length
    || !Array.isArray(receipt.resumedComponents) || receipt.resumedComponents.some((component) => !COMPONENT.test(component))
    || new Set(receipt.resumedComponents).size !== receipt.resumedComponents.length) {
    throw new Error("final process/activity proof is malformed or lost exact serial/target identity");
  }
  const retained = checkedRawLogEvidence(receipt.rawProbe, artifactRoot, "final process/activity raw probe");
  const rawBytes = readSameArtifactFile(
    retained.path,
    retained.identity,
    retained.label,
    64 * 1024 * 1024,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(rawBytes.toString("utf8"));
  } catch {
    throw new Error("final process/activity raw probe is not valid JSON");
  }
  const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const pidofOutput = typeof record?.pidofOutput === "string" ? record.pidofOutput : null;
  const activityOutput = typeof record?.activityOutput === "string" ? record.activityOutput : null;
  const rawTargetPids = Array.isArray(record?.targetPids) ? record.targetPids : null;
  const rawResumedComponents = Array.isArray(record?.resumedComponents) ? record.resumedComponents : null;
  const parsedTargetPids = pidofOutput === null ? null : pidofOutput.trim() === "" ? [] : pidofOutput.trim().split(/\s+/).map(Number);
  const parsedResumedComponents = activityOutput === null ? null
    : parseForegroundActivities(activityOutput).map((activity) => activity.component);
  if (pidofOutput === null || activityOutput === null
    || canonicalJson(rawTargetPids) !== canonicalJson(receipt.targetPids)
    || canonicalJson(rawResumedComponents) !== canonicalJson(receipt.resumedComponents)
    || canonicalJson(parsedTargetPids) !== canonicalJson(receipt.targetPids)
    || canonicalJson(parsedResumedComponents) !== canonicalJson(receipt.resumedComponents)) {
    throw new Error("final process/activity fields do not reproduce from the retained exact command outputs");
  }
  let problem: string | null = null;
  if (receipt.targetPids.length > 0 || receipt.resumedComponents.some((component) => component.startsWith(`${input.scenario.packageName}/`))) {
    problem = "final process/activity proof shows the run-owned target still running or resumed";
  } else if (input.priorForeground.kind === "non_receipt_bound"
    && (receipt.resumedComponents.length !== 1 || receipt.resumedComponents[0] !== input.priorForeground.component)) {
    problem = "final process/activity proof did not show the one exact relaunched non-receipt prior component";
  }
  return { retained, problem };
}

export function createInAppLocomotionOrchestrator(
  dependencies: InAppLocomotionDependencies,
  hooks: InAppLocomotionArtifactHooks = {},
) {
  const runs = new Map<string, LocomotionState>();
  const busyRuns = new Set<string>();
  const busySerials = new Set<string>();
  const serialOwners = new Map<string, SerialLease>();
  const preparingRoots = new Set<string>();

  const executePrepare = async (input: InAppLocomotionPrepareInput): Promise<LocomotionPrepareReceipt> => {
    let authority: ReceiptAndSpecBinding;
    try {
      authority = assertReceiptAndSpec(input, dependencies);
    } catch (error) {
      return preparationFailure(error instanceof LocomotionStageError ? error.code : "preflight_failed", error, null, null, null);
    }
    if (preparingRoots.has(input.artifactRoot)) throw new Error("a prepare mutation is already in progress for this artifact root");
    preparingRoots.add(input.artifactRoot);
    let artifact: OwnedArtifactBinding | null = null;
    let runOwnedTarget = false;
    let prior: LocomotionPriorForegroundSnapshot = { component: null, packageName: null, userInstalled: false };
    let priorTerminatedByRun = false;
    let priorStopMayHaveApplied = false;
    let prepareDeadlineNs: bigint | null = null;
    let recoveryDeadlineNs: bigint | null = null;
    let leaseAcquired = false;
    let preparationBegan = false;
    let preparationFinalizationAttempted = false;
    let preparationLogEvidence: LocomotionLogEvidence | null = null;
    let freshLaunchMonitor: FreshLaunchMonitorReceipt | null = null;
    let launchHandoffWindow: FreshLaunchHandoffReceipt | null = null;
    let retainedLaunchHandoff: { path: string; identity: ArtifactFileIdentity; label: string } | null = null;
    let healthBoundaryMarker: string | null = null;

    const finalizePreparationBracket = async (strictDeadline: boolean): Promise<LocomotionLogEvidence | null> => {
      if (!artifact || !preparationBegan || preparationFinalizationAttempted) return preparationLogEvidence;
      preparationFinalizationAttempted = true;
      const beginMarker = `PICO_LOCOMOTION_${artifact.runId.slice(0, 16)}_PREPARE_BEGIN`;
      const endMarker = `PICO_LOCOMOTION_${artifact.runId.slice(0, 16)}_PREPARE_END`;
      const remaining = () => prepareDeadlineNs === null ? 1 : Math.max(1, remainingUntilMs(prepareDeadlineNs, dependencies));
      if (strictDeadline && prepareDeadlineNs !== null) {
        await withinDeadline(prepareDeadlineNs, dependencies, "prepare END marker", (timeoutMs) => dependencies.emitMarker({
          serial: input.serial,
          marker: endMarker,
          timeoutMs,
          deadlineMonotonicNs: prepareDeadlineNs!.toString(),
        }));
      } else {
        await dependencies.emitMarker({
          serial: input.serial,
          marker: endMarker,
          timeoutMs: remaining(),
          deadlineMonotonicNs: (recoveryDeadlineNs ?? prepareDeadlineNs ?? 0n).toString(),
        });
      }
      const logPath = path.join(artifact.absoluteRoot, "logs", "000-prepare.log");
      const collect = (timeoutMs: number) => dependencies.collectStepLogs({
        serial: input.serial,
        packageName: input.scenario.packageName,
        pid: 0,
        beginMarker,
        endMarker,
        path: logPath,
        timeoutMs: Math.max(1, Math.min(10_000, timeoutMs)),
        deadlineMonotonicNs: (strictDeadline ? prepareDeadlineNs : recoveryDeadlineNs ?? prepareDeadlineNs ?? 0n)!.toString(),
      });
      const collected = strictDeadline && prepareDeadlineNs !== null
        ? await withinDeadline(prepareDeadlineNs, dependencies, "prepare bounded log", collect)
        : await collect(remaining());
      preparationLogEvidence = checkedPreparationLogEvidence(
        collected,
        logPath,
        input.scenario.packageName,
        beginMarker,
        endMarker,
        hooks,
      );
      return preparationLogEvidence;
    };

    try {
      const reserved = reserveArtifacts(input, dependencies);
      artifact = reserved.binding;
      healthBoundaryMarker = `PICO_LOCOMOTION_${artifact.runId.slice(0, 16)}_PREPARE_BEGIN`;
      const deadlineNs = reserved.startedAtNs + BigInt(input.budgets.maxDurationMs) * 1_000_000n;
      recoveryDeadlineNs = deadlineNs;
      serialOwners.set(input.serial, { runId: artifact.runId, status: "active", reason: "prepare lifecycle active" });
      leaseAcquired = true;
      prepareDeadlineNs = deadlineNs
        - BigInt(input.budgets.routeReserveMs + input.budgets.restorationReserveMs) * 1_000_000n;
      prior = await withinDeadline(prepareDeadlineNs, dependencies, "prior foreground snapshot", (timeoutMs) =>
        dependencies.snapshotPriorForeground({
          serial: input.serial,
          targetPackage: input.scenario.packageName,
          timeoutMs,
          deadlineMonotonicNs: prepareDeadlineNs!.toString(),
        }));
      expectedPrior(input, prior);
      preparationBegan = true;
      await withinDeadline(prepareDeadlineNs, dependencies, "prepare BEGIN marker", (timeoutMs) => dependencies.emitMarker({
        serial: input.serial,
        marker: healthBoundaryMarker!,
        timeoutMs,
        deadlineMonotonicNs: prepareDeadlineNs!.toString(),
      }));
      if (prior.packageName === input.scenario.packageName) priorStopMayHaveApplied = true;
      await withinDeadline(prepareDeadlineNs, dependencies, "target clearance", (timeoutMs) => dependencies.stopPackage({
        serial: input.serial,
        packageName: input.scenario.packageName,
        reason: "prepare_target_clearance",
        timeoutMs,
        deadlineMonotonicNs: prepareDeadlineNs!.toString(),
      }));
      if (prior.packageName === input.scenario.packageName) priorTerminatedByRun = true;
      if (prior.packageName && prior.packageName !== input.scenario.packageName) {
        priorStopMayHaveApplied = true;
        await withinDeadline(prepareDeadlineNs, dependencies, "declared incumbent clearance", (timeoutMs) => dependencies.stopPackage({
          serial: input.serial,
          packageName: prior.packageName!,
          reason: "prepare_declared_incumbent_clearance",
          timeoutMs,
          deadlineMonotonicNs: prepareDeadlineNs!.toString(),
        }));
        priorTerminatedByRun = true;
      }
      runOwnedTarget = true;
      const launch = await withinDeadline(prepareDeadlineNs, dependencies, "target launch", (timeoutMs) => dependencies.launchTarget({
        serial: input.serial,
        component: input.scenario.launchComponent,
        timeoutMs,
        deadlineMonotonicNs: prepareDeadlineNs!.toString(),
      }));
      if (launch.disposition !== "accepted" || launch.component !== input.scenario.launchComponent || !SHA256.test(launch.outputSha256)) {
        throw new LocomotionStageError("launch_failed", "target launch did not return one exact accepted component acknowledgement");
      }
      launchHandoffWindow = await withinDeadline(prepareDeadlineNs, dependencies, "post-launch window handoff", (timeoutMs) =>
        dependencies.captureLaunchHandoffWindow({
          serial: input.serial,
          runId: artifact!.runId,
          artifactRoot: artifact!.absoluteRoot,
          packageName: input.scenario.packageName,
          timeoutMs,
          deadlineMonotonicNs: prepareDeadlineNs!.toString(),
        }));
      retainedLaunchHandoff = checkedRawLogEvidence(
        launchHandoffWindow.rawWindowDump,
        artifact.absoluteRoot,
        "post-launch raw window handoff",
      );
      const handoffDialogs = freshLaunchDialogs(readSameArtifactFile(
        retainedLaunchHandoff.path,
        retainedLaunchHandoff.identity,
        retainedLaunchHandoff.label,
        64 * 1024 * 1024,
        hooks,
      ).toString("utf8"));
      if (canonicalJson(handoffDialogs) !== canonicalJson(launchHandoffWindow.dialogs)) {
        throw new Error("post-launch dialog claim does not reproduce from its retained raw window handoff");
      }
      if (handoffDialogs.length > 0) throw new LocomotionStageError("launch_dialog", "post-launch window handoff observed a blocking dialog");
      const runtime = await withinDeadline(prepareDeadlineNs, dependencies, "runtime binding probe", (timeoutMs) => dependencies.probeRuntimeBinding({
        serial: input.serial,
        scenario: input.scenario,
        expectedApkSha256: input.provenance.apkSha256,
        timeoutMs,
        deadlineMonotonicNs: prepareDeadlineNs!.toString(),
      }));
      validateRuntime(input, authority.validation.receipt, runtime);
      const safety = await withinDeadline(prepareDeadlineNs, dependencies, "prepare Full-stage safety", (timeoutMs) =>
        dependencies.sampleSafety({
          serial: input.serial,
          phase: "prepare_baseline",
          timeoutMs,
          deadlineMonotonicNs: prepareDeadlineNs!.toString(),
        }));
      const unsafe = safetyProblem(safety);
      if (unsafe) throw new LocomotionStageError("safety_baseline_failed", `unsafe Full-stage baseline: ${unsafe}`);
      const capability = await withinDeadline(prepareDeadlineNs, dependencies, "AgentBridge capability", (timeoutMs) => dependencies.probeCapability({
        serial: input.serial,
        packageName: input.scenario.packageName,
        requestId: `prepare_capability_${artifact!.runId.slice(0, 24)}`,
        tag: "prepare",
        ...bridgeBudgetFields(timeoutMs, prepareDeadlineNs!),
      }));
      if (!capability.ok) throw new LocomotionStageError(capability.code, capability.primaryError ?? capability.detail, capability.cleanupError);
      const root = capability.ack.root;
      if (!root || root.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID || !Number.isSafeInteger(root.generation) || root.generation < 1
        || !ROOT_INCARNATION.test(root.incarnation)) {
        throw new LocomotionStageError("capability_unavailable", "commands preflight did not bind one registered AgentWorldRoot generation/incarnation");
      }
      const hmd = hmdPoseFrom(await withinDeadline(prepareDeadlineNs, dependencies, "baseline HMD pose", (timeoutMs) => dependencies.requestHmdPose({
        serial: input.serial,
        packageName: input.scenario.packageName,
        requestId: `prepare_hmd_pose_${artifact!.runId.slice(0, 24)}`,
        tag: "prepare",
        expectedRootGeneration: root.generation,
        expectedRootIncarnation: root.incarnation,
        ...bridgeBudgetFields(timeoutMs, prepareDeadlineNs!),
      })), root.generation, root.incarnation);
      if (remainingUntilMs(prepareDeadlineNs, dependencies) < 60_001) {
        throw new LocomotionStageError("budget_exhausted", "prepare phase cannot preserve the mandatory >=60 second monitor plus baseline capture");
      }
      freshLaunchMonitor = await withinDeadline(prepareDeadlineNs, dependencies, "fresh-launch monitor", (timeoutMs) => dependencies.monitorFreshLaunch({
        serial: input.serial,
        runId: artifact!.runId,
        artifactRoot: artifact!.absoluteRoot,
        minimumDurationMs: 60_000,
        healthBoundaryMarker: healthBoundaryMarker!,
        runtime,
        timeoutMs,
        deadlineMonotonicNs: prepareDeadlineNs!.toString(),
      }));
      validateMonitor(freshLaunchMonitor, runtime, healthBoundaryMarker);
      const retainedHealthLogs = freshLaunchMonitor.rawHealthLogs.map((log, index) =>
        checkedRawLogEvidence(log, artifact!.absoluteRoot, `fresh-launch runtime-health log ${index + 1}`));
      const retainedWindowDumps = freshLaunchMonitor.rawWindowDumps.map((dump, index) =>
        checkedRawLogEvidence(dump, artifact!.absoluteRoot, `fresh-launch raw window dump ${index + 1}`));
      if (new Set(retainedHealthLogs.map((log) => `${log.identity.dev}:${log.identity.ino}`)).size !== retainedHealthLogs.length) {
        throw new Error("fresh-launch monitor raw runtime-health logs must be unique exact files");
      }
      const allMonitorArtifacts = [retainedLaunchHandoff, ...retainedHealthLogs, ...retainedWindowDumps];
      if (new Set(allMonitorArtifacts.map((log) => `${log.identity.dev}:${log.identity.ino}`)).size !== allMonitorArtifacts.length) {
        throw new Error("fresh-launch raw health/window evidence must be unique exact files");
      }
      for (const [index, retained] of retainedHealthLogs.entries()) {
        const sourceBytes = readSameArtifactFile(
          retained.path,
          retained.identity,
          retained.label,
          64 * 1024 * 1024,
          hooks,
        );
        const replayed = scanPackageRuntimeHealth({
          status: "snapshot_collected",
          truncated: false,
          observedBytes: sourceBytes.length,
          appStartMarker: healthBoundaryMarker,
          appStartMarkerObserved: sourceBytes.includes(Buffer.from(healthBoundaryMarker, "utf8")),
          rawArtifact: {
            path: retained.path,
            sha256: retained.identity.sha256,
            bytes: retained.identity.bytes,
          },
        }, runtime.applicationBinding.packageName, [runtime.applicationBinding.pid], sourceBytes);
        if (canonicalJson(replayed) !== canonicalJson(freshLaunchMonitor.samples[index].runtimeHealth)) {
          throw new Error("fresh-launch runtime-health claim does not reproduce from its retained descriptor bytes");
        }
      }
      for (const [index, retained] of retainedWindowDumps.entries()) {
        const observedDialogs = freshLaunchDialogs(readSameArtifactFile(
          retained.path,
          retained.identity,
          retained.label,
          64 * 1024 * 1024,
          hooks,
        ).toString("utf8"));
        if (canonicalJson(observedDialogs) !== canonicalJson(freshLaunchMonitor.samples[index].dialogs)) {
          throw new Error("fresh-launch dialog result does not reproduce from its retained raw window dump");
        }
      }
      const baselinePath = path.join(artifact.absoluteRoot, "captures", "000-app-baseline.png");
      const captured = await withinDeadline(prepareDeadlineNs, dependencies, "baseline settled capture", (remainingMs) => dependencies.captureSettled({
        serial: input.serial,
        outPath: baselinePath,
        maxTries: input.capture.maxTries,
        intervalMs: input.capture.intervalMs,
        attemptTimeoutMs: Math.max(1, Math.min(input.capture.attemptTimeoutMs, remainingMs)),
        deadlineMs: Math.max(1, Math.min(input.capture.deadlineMs, remainingMs)),
        comparison: "byte_exact",
        mode: "stable",
      }));
      const review = captureReview(captured, baselinePath, "app_baseline");
      dependencies.readReviewImage(review, artifact.absoluteRoot);
      const preparationLog = await finalizePreparationBracket(true);
      if (!preparationLog) throw new Error("preparation launch-handoff bracket was not retained");
      const state: LocomotionState = {
        input,
        artifact,
        status: "prepared",
        receipt: authority.validation.receipt,
        receiptCanonical: authority.receiptCanonical,
        effectiveSpecCanonical: authority.effectiveSpecCanonical,
        runtime,
        prior,
        priorTerminatedByRun,
        targetOwned: true,
        rootGeneration: root.generation,
        rootIncarnation: root.incarnation,
        baselineHmd: hmd,
        currentReview: review,
        requiredReview: [review],
        retainedLogs: [{
          path: preparationLog.path,
          identity: artifactFileIdentity(preparationLog.path, "retained preparation log", 64 * 1024 * 1024, hooks),
          label: "retained preparation log",
        }, retainedLaunchHandoff, ...retainedHealthLogs, ...retainedWindowDumps],
        nextWaypoint: 0,
        startedAtNs: reserved.startedAtNs,
        deadlineNs,
        usage: { waypointAttempts: 0, successfulWaypoints: 0, routeDurationMs: 0 },
        restoreAttempted: false,
        restoreCompleted: false,
        adjudicated: false,
        currentReviewReflectsNonzeroMutation: false,
      };
      if (runs.has(artifact.runId)) throw new Error("run identifier collision");
      appendAction(artifact, {
        action: "prepare",
        status: "completed",
        runtime,
        receiptBinding: {
          receiptId: authority.validation.receipt.receiptId,
          apkSha256: input.provenance.apkSha256,
          component: input.scenario.launchComponent,
        },
        safetyBaseline: safety,
        capability,
        hmdBaseline: hmd,
        freshLaunchMonitor,
        launchHandoffWindow,
        preparationLogEvidence: preparationLog,
        captureReceipt: captured.receipt,
        observedPriorForeground: prior,
        serialLease: { status: "active", reason: "reviewed route requires restore" },
        rootGeneration: root.generation,
        rootIncarnation: root.incarnation,
        captureSha256: review.captureSha256,
      }, hooks);
      runs.set(artifact.runId, state);
      return {
        status: "needs_baseline_review",
        runId: artifact.runId,
        artifactRoot: artifact.absoluteRoot,
        structuralStop: null,
        primaryError: null,
        cleanupError: null,
        evidenceCeiling: "structural",
        lookRequired: true,
        requiredReview: [review],
        rootGeneration: root.generation,
        rootIncarnation: root.incarnation,
        applicationBinding: runtime.applicationBinding,
      };
    } catch (error) {
      const cleanupErrors: string[] = [];
      const compensation: Record<string, unknown> = {
        targetStop: { status: runOwnedTarget ? "not_attempted" : "not_required" },
        priorRelaunch: { status: "not_required" },
        finalProcessProof: null,
        globalSafety: null,
      };
      let targetCleanupProven = !runOwnedTarget;
      let priorDispositionProven = !(input.priorForeground.kind === "non_receipt_bound" && priorStopMayHaveApplied);
      let finalProcessProven = !leaseAcquired;
      let finalSafetyProven = !leaseAcquired;
      let failureAuditProven = false;
      if (error instanceof LocomotionStageError && error.cleanupError) cleanupErrors.push(error.cleanupError);
      const recoveryBudget = (label: string): LocomotionEffectBudget => {
        if (recoveryDeadlineNs === null) return {
          timeoutMs: 5_000,
          deadlineMonotonicNs: "5000000000",
          cleanupOnly: true,
        };
        try {
          const remaining = remainingUntilMs(recoveryDeadlineNs, dependencies);
          if (remaining < 1_000) throw new Error(`${label} cannot begin within the reserved recovery deadline`);
          return {
            timeoutMs: Math.min(10_000, remaining),
            deadlineMonotonicNs: recoveryDeadlineNs.toString(),
          };
        } catch (clockError) {
          cleanupErrors.push(`${label} budget clock: ${errorText(clockError)}`);
          return {
            timeoutMs: 5_000,
            deadlineMonotonicNs: recoveryDeadlineNs.toString(),
            cleanupOnly: true,
          };
        }
      };
      if (runOwnedTarget) {
        try {
          const receipt = await dependencies.stopPackage({
            serial: input.serial,
            packageName: input.scenario.packageName,
            reason: "prepare_failure_cleanup",
            ...recoveryBudget("prepare target cleanup"),
          });
          compensation.targetStop = receipt;
          targetCleanupProven = true;
        } catch (cleanup) {
          compensation.targetStop = { status: "failed", error: errorText(cleanup) };
          cleanupErrors.push(errorText(cleanup));
        }
      }
      const priorDisposition = priorForegroundDispositionFor(input, priorTerminatedByRun);
      if (input.priorForeground.kind === "non_receipt_bound" && priorStopMayHaveApplied) {
        try {
          const relaunched = await dependencies.relaunchPrior({
            serial: input.serial,
            component: input.priorForeground.component,
            ...recoveryBudget("prepare prior relaunch"),
          });
          compensation.priorRelaunch = relaunched;
          const problem = validatePriorRelaunchReceipt(relaunched, input.priorForeground.component);
          if (problem) {
            priorDisposition.relaunchDisposition = relaunched.disposition === "accepted" ? "attempt_failed" : relaunched.disposition;
            cleanupErrors.push(problem);
          } else {
            priorDisposition.relaunchDisposition = "accepted";
            priorDispositionProven = true;
          }
        } catch (cleanup) {
          compensation.priorRelaunch = { status: "failed", error: errorText(cleanup) };
          priorDisposition.relaunchDisposition = "attempt_failed";
          cleanupErrors.push(`prior relaunch: ${errorText(cleanup)}`);
        }
      }
      if (artifact && preparationBegan && !preparationFinalizationAttempted) {
        try {
          await finalizePreparationBracket(false);
        } catch (cleanup) {
          cleanupErrors.push(`preparation bracket finalization: ${errorText(cleanup)}`);
        }
      }
      if (artifact && leaseAcquired) {
        try {
          const finalProof = await dependencies.probeFinalProcessState({
            serial: input.serial,
            targetPackage: input.scenario.packageName,
            artifactRoot: artifact.absoluteRoot,
            priorForeground: input.priorForeground,
            ...recoveryBudget("prepare final process/activity proof"),
          });
          compensation.finalProcessProof = finalProof;
          const checked = checkedFinalProcessProof(finalProof, input, artifact.absoluteRoot);
          if (checked.problem) cleanupErrors.push(checked.problem);
          else finalProcessProven = true;
        } catch (cleanup) {
          compensation.finalProcessProof = { status: "failed", error: errorText(cleanup) };
          cleanupErrors.push(`final process/activity proof: ${errorText(cleanup)}`);
        }
        try {
          const safety = await dependencies.sampleSafety({
            serial: input.serial,
            phase: "prepare_failure_after_prior_disposition",
            ...recoveryBudget("prepare final global safety"),
          });
          compensation.globalSafety = safety;
          const problem = finalGlobalSafetyProblem(safety);
          if (problem) cleanupErrors.push(`prepare final global safety: ${problem}`);
          else finalSafetyProven = true;
        } catch (cleanup) {
          compensation.globalSafety = { status: "failed", error: errorText(cleanup) };
          cleanupErrors.push(`prepare final global safety: ${errorText(cleanup)}`);
        }
      }
      const code = error instanceof LocomotionStageError ? error.code : "preparation_failed";
      const compensationProven = targetCleanupProven && priorDispositionProven && finalProcessProven && finalSafetyProven;
      if (artifact) {
        try {
          appendAction(artifact, {
            action: "prepare",
            status: "failed",
            structuralStop: code,
            primaryError: errorText(error),
            cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
            observedPriorForeground: prior,
            priorForeground: priorDisposition,
            compensation,
            serialLease: {
              status: compensationProven ? "released" : "quarantined",
              reason: compensationProven ? "compensation and final proof completed" : "prepare compensation remains unproven",
            },
            preparationLogEvidence,
            freshLaunchMonitor,
            launchHandoffWindow,
          }, hooks);
          failureAuditProven = true;
        } catch (auditError) {
          cleanupErrors.push(`failed action audit: ${errorText(auditError)}`);
        }
        const lease = serialOwners.get(input.serial);
        if (lease?.runId === artifact.runId) {
          if (compensationProven && failureAuditProven) serialOwners.delete(input.serial);
          else serialOwners.set(input.serial, {
            runId: artifact.runId,
            status: "quarantined",
            reason: failureAuditProven ? "prepare compensation remains unproven" : "prepare failure audit is unproven",
          });
        }
      }
      const cleanupError = cleanupErrors.length ? cleanupErrors.join("; ") : null;
      return preparationFailure(code, error, artifact?.runId ?? null, artifact?.absoluteRoot ?? null, cleanupError);
    } finally {
      preparingRoots.delete(input.artifactRoot);
    }
  };

  const executeStep = async (input: InAppLocomotionStepInput, state: LocomotionState): Promise<LocomotionStepReceipt> => {
    if (state.status !== "prepared" && state.status !== "stepped") throw new Error(`step is out of order from state '${state.status}'`);
    if (state.nextWaypoint >= state.input.route.waypoints.length) {
      throw new Error("step is out of order because the planned route is complete and requires restore");
    }
    const waypoint = state.input.route.waypoints[state.nextWaypoint];
    if (input.waypoint.seq !== waypoint.seq || input.waypoint.target.absolute !== true
      || !samePosition(input.waypoint.target, waypoint.target)) {
      throw new Error("step waypoint does not match the exact immutable planned next sequence and Float32 target");
    }
    if (input.reviewedPriorFrame.captureSha256 !== state.currentReview.captureSha256) {
      return stepReviewFailure(state, "reviewed capture SHA does not match the exact current required frame");
    }
    try {
      dependencies.readReviewImage(state.currentReview, state.artifact.absoluteRoot);
    } catch (error) {
      return stepReviewFailure(state, `reviewed retained image failed its immutable sha256 check: ${errorText(error)}`);
    }
    assertStateArtifacts(state, hooks);
    assertCurrentReceiptAndSpec(state, dependencies);
    const operationStarted = checkedMonotonic(dependencies);
    state.nextWaypoint += 1;
    state.usage.waypointAttempts += 1;
    const routeRemainingMs = state.input.budgets.routeReserveMs - state.usage.routeDurationMs;
    const beforeRestoreDeadlineNs = state.deadlineNs - BigInt(state.input.budgets.restorationReserveMs) * 1_000_000n;
    const stepDeadlineNs = earlierDeadline(
      beforeRestoreDeadlineNs,
      operationStarted + BigInt(Math.max(0, routeRemainingMs)) * 1_000_000n,
    );
    const beginMarker = `PICO_LOCOMOTION_${state.artifact.runId.slice(0, 16)}_${waypoint.seq}_BEGIN`;
    const endMarker = `PICO_LOCOMOTION_${state.artifact.runId.slice(0, 16)}_${waypoint.seq}_END`;
    const logPath = path.join(state.artifact.absoluteRoot, "logs", `${String(waypoint.seq).padStart(3, "0")}-step.log`);
    let began = false;
    let primaryError: string | null = null;
    let primaryCode: string | null = null;
    const cleanupErrors: string[] = [];
    let capturedReview: LocomotionReviewItem | null = null;
    let drift: LocomotionHmdDriftReceipt | null = null;
    let logEvidence: LocomotionLogEvidence | null = null;
    let preSafety: LocomotionSafetySnapshot | null = null;
    let preContinuity: ApplicationContinuitySample | null = null;
    let preHmd: AgentBridgeHmdPose | null = null;
    let locomotion: LocomotionResult | null = null;
    let emergencyStop: { attempted: boolean; proven: boolean; error: string | null } | null = null;
    let captureReceipt: CaptureSettledReceipt | null = null;
    let postHmd: AgentBridgeHmdPose | null = null;
    let postSafety: LocomotionSafetySnapshot | null = null;
    let postContinuity: ApplicationContinuitySample | null = null;
    try {
      const initialRemainingMs = remainingUntilMs(stepDeadlineNs, dependencies);
      if (initialRemainingMs <= state.input.capture.deadlineMs) {
        throw new LocomotionStageError("budget_exhausted", "route deadline cannot preserve the capture and restoration reserves");
      }
      began = true;
      await withinDeadline(stepDeadlineNs, dependencies, "step BEGIN marker", (timeoutMs) => dependencies.emitMarker({
        serial: state.input.serial,
        marker: beginMarker,
        timeoutMs,
        deadlineMonotonicNs: stepDeadlineNs.toString(),
      }));
      preSafety = await withinDeadline(stepDeadlineNs, dependencies, "pre-step safety", (timeoutMs) => dependencies.sampleSafety({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_pre`,
        timeoutMs,
        deadlineMonotonicNs: stepDeadlineNs.toString(),
      }));
      const preSafetyProblem = safetyProblem(preSafety);
      if (preSafetyProblem) throw new LocomotionStageError("safety_drift", `pre-step safety drift: ${preSafetyProblem}`);
      preContinuity = await withinDeadline(stepDeadlineNs, dependencies, "pre-step continuity", (timeoutMs) => dependencies.sampleContinuity({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_pre`,
        runtime: state.runtime,
        artifactRoot: state.artifact.absoluteRoot,
        timeoutMs,
        deadlineMonotonicNs: stepDeadlineNs.toString(),
      }));
      const preContinuityProblem = continuityProblem(preContinuity, state.runtime);
      if (preContinuityProblem) throw new LocomotionStageError("binding_lost", preContinuityProblem);
      preHmd = hmdPoseFrom(await withinDeadline(stepDeadlineNs, dependencies, "pre-step HMD pose", (timeoutMs) => dependencies.requestHmdPose({
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `step_${waypoint.seq}_pre_${state.artifact.runId.slice(0, 20)}`,
        tag: `step-${waypoint.seq}-pre`,
        expectedRootGeneration: state.rootGeneration,
        expectedRootIncarnation: state.rootIncarnation,
        ...bridgeBudgetFields(timeoutMs, stepDeadlineNs),
      })), state.rootGeneration, state.rootIncarnation);
      if (translationDistance(state.baselineHmd.position, preHmd.position) > 0.02) {
        throw new LocomotionStageError("hmd_translation_drift", "pre-step Euclidean HMD translation drift exceeded exactly 0.02 m");
      }
      if (remainingUntilMs(stepDeadlineNs, dependencies) <= state.input.capture.deadlineMs) {
        throw new LocomotionStageError("budget_exhausted", "route budget was exhausted before locomotion mutation");
      }
      const rootBefore = state.rootGeneration;
      locomotion = await withinDeadline(stepDeadlineNs, dependencies, "selected locomotion", (timeoutMs) => dependencies.requestLocomotion({
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `step_${waypoint.seq}_move_${state.artifact.runId.slice(0, 20)}`,
        tag: `step-${waypoint.seq}`,
        mode: state.input.mechanism,
        target: { x: waypoint.target.x, y: waypoint.target.y, z: waypoint.target.z },
        rootGeneration: rootBefore,
        rootIncarnation: state.rootIncarnation,
        glideDurationMs: state.input.route.glideDurationMs,
        physicalWalk: false,
        ...bridgeBudgetFields(timeoutMs, stepDeadlineNs),
      }));
      const ack = completedLocomotionAck(locomotion);
      if (!ack) {
        if (!locomotion.ok) {
          if (locomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${locomotion.cleanupError}`);
          throw new LocomotionStageError(locomotion.code, locomotion.primaryError ?? locomotion.detail);
        }
        throw new LocomotionStageError("root_readback_mismatch", "successful locomotion omitted its completed acknowledgement");
      }
      if (!locomotion.ok) {
        if (locomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${locomotion.cleanupError}`);
        primaryCode = "cleanup_failed";
      }
      const expectedGeneration = state.input.mechanism === "replacement" ? rootBefore + 1 : rootBefore;
      if (ack.mode !== state.input.mechanism || ack.target.absolute !== true || !samePosition(ack.target, waypoint.target)
        || ack.requestControl !== "execute" || ack.executionLeaseMs !== state.input.route.glideDurationMs + 2_000
        || ack.glideDurationMs !== state.input.route.glideDurationMs
        || ack.rootGenerationBefore !== rootBefore || ack.root?.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID
        || ack.root.generation !== rootBefore || ack.root.incarnation !== state.rootIncarnation
        || ack.pose === null || ack.pose.rootGeneration !== expectedGeneration
        || !samePosition(ack.pose.position, waypoint.target) || ack.physicalWalk !== false) {
        throw new LocomotionStageError("root_readback_mismatch", "locomotion acknowledgement lost exact mechanism/target/root-generation readback binding");
      }
      state.rootGeneration = expectedGeneration;
      const captureRemainingMs = remainingUntilMs(stepDeadlineNs, dependencies);
      if (captureRemainingMs < 1) throw new LocomotionStageError("budget_exhausted", "route budget was exhausted before transition capture");
      const capturePath = path.join(state.artifact.absoluteRoot, "captures", `${String(waypoint.seq).padStart(3, "0")}-waypoint.png`);
      const captured = await withinDeadline(stepDeadlineNs, dependencies, "waypoint transition-stable capture", (remainingMs) => dependencies.captureSettled({
        serial: state.input.serial,
        outPath: capturePath,
        maxTries: state.input.capture.maxTries,
        intervalMs: state.input.capture.intervalMs,
        attemptTimeoutMs: Math.max(1, Math.min(state.input.capture.attemptTimeoutMs, remainingMs)),
        deadlineMs: Math.max(1, Math.min(state.input.capture.deadlineMs, remainingMs)),
        comparison: "byte_exact",
        mode: "transition_then_stable",
        priorSha256: state.currentReview.captureSha256,
      }));
      captureReceipt = captured.receipt;
      if (captured.receipt.status !== "settled") {
        throw new LocomotionStageError(captured.receipt.error?.code ?? "route_unsettled", captured.receipt.error?.detail ?? "transition capture did not settle");
      }
      capturedReview = captureReview(captured, capturePath, "waypoint", waypoint.seq);
      postHmd = hmdPoseFrom(await withinDeadline(stepDeadlineNs, dependencies, "post-step HMD pose", (timeoutMs) => dependencies.requestHmdPose({
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `step_${waypoint.seq}_post_${state.artifact.runId.slice(0, 20)}`,
        tag: `step-${waypoint.seq}-post`,
        expectedRootGeneration: state.rootGeneration,
        expectedRootIncarnation: state.rootIncarnation,
        ...bridgeBudgetFields(timeoutMs, stepDeadlineNs),
      })), state.rootGeneration, state.rootIncarnation);
      drift = driftReceipt(state.baselineHmd, preHmd, postHmd);
      postSafety = await withinDeadline(stepDeadlineNs, dependencies, "post-step safety", (timeoutMs) => dependencies.sampleSafety({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_post`,
        timeoutMs,
        deadlineMonotonicNs: stepDeadlineNs.toString(),
      }));
      const postSafetyProblem = safetyProblem(postSafety);
      if (postSafetyProblem) throw new LocomotionStageError("safety_drift", `post-step safety drift: ${postSafetyProblem}`);
      postContinuity = await withinDeadline(stepDeadlineNs, dependencies, "post-step continuity", (timeoutMs) => dependencies.sampleContinuity({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_post`,
        runtime: state.runtime,
        artifactRoot: state.artifact.absoluteRoot,
        timeoutMs,
        deadlineMonotonicNs: stepDeadlineNs.toString(),
      }));
      const postContinuityProblem = continuityProblem(postContinuity, state.runtime);
      if (postContinuityProblem) throw new LocomotionStageError("binding_lost", postContinuityProblem);
      if (!drift.translation.pass) {
        throw new LocomotionStageError("hmd_translation_drift", "Euclidean 3D HMD translation drift exceeded exactly 0.02 m");
      }
    } catch (error) {
      primaryError = errorText(error);
      primaryCode = error instanceof LocomotionStageError ? error.code : "step_failed";
      if (error instanceof LocomotionStageError && error.cleanupError) {
        cleanupErrors.push(`bridge acknowledgement cleanup: ${error.cleanupError}`);
      }
      if (locomotion !== null && !locomotion.ok && locomotion.motionQuiesced === false && state.targetOwned) {
        emergencyStop = { attempted: true, proven: false, error: null };
        let stopBudget: LocomotionEffectBudget;
        try {
          const remaining = remainingUntilMs(stepDeadlineNs, dependencies);
          if (remaining < 1) throw new Error("step recovery reached the fixed route deadline");
          stopBudget = {
            timeoutMs: Math.min(5_000, remaining),
            deadlineMonotonicNs: stepDeadlineNs.toString(),
          };
        } catch (clockError) {
          cleanupErrors.push(`step emergency-stop budget clock: ${errorText(clockError)}`);
          stopBudget = {
            timeoutMs: 5_000,
            deadlineMonotonicNs: stepDeadlineNs.toString(),
            cleanupOnly: true,
          };
        }
        try {
          await dependencies.stopPackage({
            serial: state.input.serial,
            packageName: state.input.scenario.packageName,
            reason: "step_unquiesced_locomotion",
            ...stopBudget,
          });
          state.targetOwned = false;
          emergencyStop.proven = true;
        } catch (stopError) {
          emergencyStop.error = errorText(stopError);
          cleanupErrors.push(`step emergency target stop: ${emergencyStop.error}`);
          const lease = serialOwners.get(state.input.serial);
          if (lease?.runId === state.artifact.runId) {
            serialOwners.set(state.input.serial, {
              runId: state.artifact.runId,
              status: "quarantined",
              reason: "unquiesced locomotion and emergency target stop remain unproven",
            });
          }
        }
      }
    } finally {
      if (began) {
        try {
          await dependencies.emitMarker({
            serial: state.input.serial,
            marker: endMarker,
            timeoutMs: Math.max(1, remainingUntilMs(stepDeadlineNs, dependencies)),
            deadlineMonotonicNs: stepDeadlineNs.toString(),
          });
        } catch (error) {
          cleanupErrors.push(`END marker: ${errorText(error)}`);
        }
        try {
          const collectedLog = checkedLogEvidence(await dependencies.collectStepLogs({
            serial: state.input.serial,
            packageName: state.input.scenario.packageName,
            pid: state.runtime.applicationBinding.pid,
            beginMarker,
            endMarker,
            path: logPath,
            timeoutMs: Math.max(1, Math.min(10_000, remainingUntilMs(stepDeadlineNs, dependencies))),
            deadlineMonotonicNs: stepDeadlineNs.toString(),
          }), logPath, state.input.scenario.packageName, beginMarker, endMarker, hooks);
          const identity = artifactFileIdentity(collectedLog.path, "retained step log", 64 * 1024 * 1024);
          state.retainedLogs.push({ path: collectedLog.path, identity, label: `retained step ${waypoint.seq} log` });
          logEvidence = collectedLog;
        } catch (error) {
          cleanupErrors.push(`bounded log finalization: ${errorText(error)}`);
        }
      }
    }
    let capturedReviewValidated = false;
    if (capturedReview) {
      try {
        dependencies.readReviewImage(capturedReview, state.artifact.absoluteRoot);
        capturedReviewValidated = true;
      } catch (error) {
        const detail = `new waypoint image failed retained-byte validation: ${errorText(error)}`;
        if (primaryError === null) {
          primaryError = detail;
          primaryCode = "route_unsettled";
        } else {
          cleanupErrors.push(detail);
        }
      }
    }
    let operationEnded = operationStarted;
    try {
      operationEnded = checkedMonotonic(dependencies);
    } catch (clockError) {
      const detail = `step end clock: ${errorText(clockError)}`;
      if (primaryError === null) {
        primaryError = detail;
        primaryCode = "clock_failed";
      } else {
        cleanupErrors.push(detail);
      }
    }
    const durationMs = Math.max(0, Number((operationEnded - operationStarted) / 1_000_000n));
    state.usage.routeDurationMs += durationMs;
    if (capturedReview && capturedReviewValidated) {
      state.currentReview = capturedReview;
      state.requiredReview.push(capturedReview);
      state.currentReviewReflectsNonzeroMutation = nonzeroPosition(waypoint.target);
    }
    let succeeded = primaryError === null && cleanupErrors.length === 0 && capturedReviewValidated && drift !== null;
    const publishedUsage = {
      ...state.usage,
      successfulWaypoints: state.usage.successfulWaypoints + (succeeded ? 1 : 0),
    };
    let structuralStop = succeeded ? null : primaryCode ?? "step_cleanup_failed";
    try {
      appendAction(state.artifact, {
        action: "step",
        waypointSeq: waypoint.seq,
        waypoint: input.waypoint,
        status: succeeded ? "completed" : "stopped",
        structuralStop,
        primaryError,
        cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
        rootGeneration: state.rootGeneration,
        rootIncarnation: state.rootIncarnation,
        captureSha256: capturedReview?.captureSha256 ?? null,
        waypointAttempts: state.usage.waypointAttempts,
        usage: publishedUsage,
        pre: { safety: preSafety, continuity: preContinuity, hmdPose: preHmd },
        locomotion,
        emergencyStop,
        captureReceipt,
        post: { hmdPose: postHmd, safety: postSafety, continuity: postContinuity },
        hmdDrift: drift,
        logEvidence,
      }, hooks);
    } catch (auditError) {
      if (primaryError === null) {
        primaryError = `step action audit: ${errorText(auditError)}`;
        primaryCode = "action_audit_failed";
      } else {
        cleanupErrors.push(`step action audit: ${errorText(auditError)}`);
      }
      succeeded = false;
      structuralStop = primaryCode ?? "action_audit_failed";
    }
    if (succeeded) {
      state.status = "stepped";
      state.usage.successfulWaypoints = publishedUsage.successfulWaypoints;
    } else {
      state.status = "stopped";
    }
    return {
      status: succeeded
        ? state.nextWaypoint >= state.input.route.waypoints.length ? "route_complete_needs_restore" : "needs_waypoint_review"
        : "stopped",
      runId: state.artifact.runId,
      artifactRoot: state.artifact.absoluteRoot,
      waypointSeq: waypoint.seq,
      rootGeneration: state.rootGeneration,
      rootIncarnation: state.rootIncarnation,
      structuralStop,
      primaryError,
      cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
      evidenceCeiling: "structural",
      lookRequired: true,
      requiredReview: capturedReviewValidated ? [capturedReview!] : [state.currentReview],
      hmdDrift: drift,
      logEvidence,
      usage: { ...state.usage },
    };
  };

  const executeRestore = async (input: InAppLocomotionRestoreInput, state: LocomotionState): Promise<LocomotionRestoreReceipt> => {
    if (state.restoreAttempted) throw new Error("restore is once-only and was already attempted for this run");
    if (state.status !== "prepared" && state.status !== "stepped" && state.status !== "stopped") {
      throw new Error(`restore is out of order from state '${state.status}'`);
    }
    if (input.reviewedPriorFrame.captureSha256 !== state.currentReview.captureSha256) {
      return restoreReviewFailure(state, "reviewed capture SHA does not match the exact current required frame");
    }
    const reviewedMovedFrame = state.currentReviewReflectsNonzeroMutation;
    if (!reviewedMovedFrame) {
      try {
        dependencies.readReviewImage(state.currentReview, state.artifact.absoluteRoot);
      } catch (error) {
        return restoreReviewFailure(state, `reviewed retained image failed its immutable sha256 check: ${errorText(error)}`);
      }
    }
    const restoreStartedNs = checkedMonotonic(dependencies);
    const restoreDeadlineNs = earlierDeadline(
      state.deadlineNs,
      restoreStartedNs + BigInt(state.input.budgets.restorationReserveMs) * 1_000_000n,
    );
    const mutationDeadlineNs = restoreDeadlineNs - 5_000_000_000n;
    state.restoreAttempted = true;
    let primaryError: string | null = null;
    let primaryCode: string | null = null;
    const cleanupErrors: string[] = [];
    let restoredReview: LocomotionReviewItem | null = null;
    let locomotion: LocomotionResult | null = null;
    let captureReceipt: CaptureSettledReceipt | null = null;
    let postStopSafety: LocomotionSafetySnapshot | null = null;
    let preRestoreContinuity: ApplicationContinuitySample | null = null;
    let preRestoreCapability: CapabilityResult | null = null;
    let finalProcessProof: FinalProcessActivityReceipt | null = null;
    let finalProcessProven = false;
    let finalSafetyProven = false;
    let currentReviewTrusted = true;
    const priorDisposition = priorForegroundDisposition(state);
    try {
      if (reviewedMovedFrame) {
        try {
          dependencies.readReviewImage(state.currentReview, state.artifact.absoluteRoot);
        } catch (error) {
          currentReviewTrusted = false;
          throw new LocomotionStageError(
            "review_artifact_failed",
            `reviewed moved-state image failed its immutable sha256 check: ${errorText(error)}`,
          );
        }
      }
      if (!state.targetOwned) {
        throw new LocomotionStageError("target_already_stopped", "run-owned target was already stopped after an unquiesced locomotion failure");
      }
      assertStateArtifacts(state, hooks);
      assertCurrentReceiptAndSpec(state, dependencies);
      preRestoreContinuity = await withinDeadline(mutationDeadlineNs, dependencies, "pre-restore live continuity", (timeoutMs) =>
        dependencies.sampleContinuity({
          serial: state.input.serial,
          phase: "restore_pre",
          runtime: state.runtime,
          artifactRoot: state.artifact.absoluteRoot,
          timeoutMs,
          deadlineMonotonicNs: mutationDeadlineNs.toString(),
        }));
      const continuity = continuityProblem(preRestoreContinuity, state.runtime);
      if (continuity) throw new LocomotionStageError("binding_lost", continuity);
      preRestoreCapability = await withinDeadline(mutationDeadlineNs, dependencies, "pre-restore root capability", (timeoutMs) =>
        dependencies.probeCapability({
          serial: state.input.serial,
          packageName: state.input.scenario.packageName,
          requestId: `restore_capability_${state.artifact.runId.slice(0, 20)}`,
          tag: "restore-pre",
          ...bridgeBudgetFields(timeoutMs, mutationDeadlineNs),
        }));
      if (!preRestoreCapability.ok) {
        throw new LocomotionStageError(
          preRestoreCapability.code,
          preRestoreCapability.primaryError ?? preRestoreCapability.detail,
          preRestoreCapability.cleanupError,
        );
      }
      const liveRoot = preRestoreCapability.ack.root;
      if (!liveRoot || liveRoot.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID
        || liveRoot.generation !== state.rootGeneration || liveRoot.incarnation !== state.rootIncarnation) {
        throw new LocomotionStageError("binding_lost", "pre-restore root capability lost the exact generation/incarnation producer identity");
      }
      const remainingMs = remainingUntilMs(mutationDeadlineNs, dependencies);
      if (remainingMs <= state.input.capture.deadlineMs) {
        throw new LocomotionStageError("budget_exhausted", "restoration deadline cannot fit the required settled capture");
      }
      const rootBefore = state.rootGeneration;
      locomotion = await withinDeadline(mutationDeadlineNs, dependencies, "zero-offset restoration", (timeoutMs) => dependencies.requestLocomotion({
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `restore_move_${state.artifact.runId.slice(0, 20)}`,
        tag: "restore",
        mode: state.input.mechanism,
        target: { x: 0, y: 0, z: 0 },
        rootGeneration: rootBefore,
        rootIncarnation: state.rootIncarnation,
        glideDurationMs: state.input.route.glideDurationMs,
        physicalWalk: false,
        ...bridgeBudgetFields(timeoutMs, mutationDeadlineNs),
      }));
      const ack = completedLocomotionAck(locomotion);
      if (!ack) {
        if (!locomotion.ok) {
          if (locomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${locomotion.cleanupError}`);
          throw new LocomotionStageError(locomotion.code, locomotion.primaryError ?? locomotion.detail);
        }
        throw new LocomotionStageError("root_readback_mismatch", "successful restore omitted its completed acknowledgement");
      }
      if (!locomotion.ok) {
        if (locomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${locomotion.cleanupError}`);
        primaryCode = "cleanup_failed";
      }
      const expectedGeneration = state.input.mechanism === "replacement" ? rootBefore + 1 : rootBefore;
      if (ack.mode !== state.input.mechanism || ack.target.absolute !== true
        || !samePosition(ack.target, state.input.route.restoreTarget)
        || ack.requestControl !== "execute" || ack.executionLeaseMs !== state.input.route.glideDurationMs + 2_000
        || ack.glideDurationMs !== state.input.route.glideDurationMs
        || ack.rootGenerationBefore !== rootBefore || ack.root?.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID
        || ack.root.generation !== rootBefore || ack.root.incarnation !== state.rootIncarnation || ack.pose === null
        || ack.pose.rootGeneration !== expectedGeneration
        || !samePosition(ack.pose.position, state.input.route.restoreTarget)
        || ack.physicalWalk !== false) {
        throw new LocomotionStageError("root_readback_mismatch", "restore acknowledgement lost exact mechanism/zero-target/root-generation readback binding");
      }
      state.rootGeneration = expectedGeneration;
      const captureRemainingMs = remainingUntilMs(mutationDeadlineNs, dependencies);
      if (captureRemainingMs < 1) throw new LocomotionStageError("budget_exhausted", "restoration deadline expired before capture");
      const capturePath = path.join(state.artifact.absoluteRoot, "captures", "999-restored.png");
      const captured = await withinDeadline(mutationDeadlineNs, dependencies, "restoration settled capture", (remainingCaptureMs) => dependencies.captureSettled({
        serial: state.input.serial,
        outPath: capturePath,
        maxTries: state.input.capture.maxTries,
        intervalMs: state.input.capture.intervalMs,
        attemptTimeoutMs: Math.max(1, Math.min(state.input.capture.attemptTimeoutMs, remainingCaptureMs)),
        deadlineMs: Math.max(1, Math.min(state.input.capture.deadlineMs, remainingCaptureMs)),
        comparison: "byte_exact",
        mode: reviewedMovedFrame ? "transition_then_stable" : "stable",
        ...(reviewedMovedFrame ? { priorSha256: state.currentReview.captureSha256 } : {}),
      }));
      captureReceipt = captured.receipt;
      if (captured.receipt.status !== "settled") {
        throw new LocomotionStageError(captured.receipt.error?.code ?? "restoration_unsettled", captured.receipt.error?.detail ?? "restoration capture did not settle");
      }
      const candidateReview = captureReview(captured, capturePath, "recovery");
      dependencies.readReviewImage(candidateReview, state.artifact.absoluteRoot);
      restoredReview = candidateReview;
      state.currentReview = candidateReview;
      state.requiredReview.push(candidateReview);
      state.currentReviewReflectsNonzeroMutation = false;
    } catch (error) {
      primaryError = errorText(error);
      primaryCode = error instanceof LocomotionStageError ? error.code : "restore_failed";
      if (error instanceof LocomotionStageError && error.cleanupError) {
        cleanupErrors.push(`bridge acknowledgement cleanup: ${error.cleanupError}`);
      }
    } finally {
      const cleanupBudget = (label: string): LocomotionEffectBudget => {
        try {
          const remaining = remainingUntilMs(restoreDeadlineNs, dependencies);
          if (remaining < 1) throw new Error(`${label} reached the fixed restoration deadline`);
          return {
            timeoutMs: Math.min(10_000, remaining),
            deadlineMonotonicNs: restoreDeadlineNs.toString(),
          };
        } catch (clockError) {
          cleanupErrors.push(`${label} budget clock: ${errorText(clockError)}`);
          return {
            timeoutMs: 5_000,
            deadlineMonotonicNs: restoreDeadlineNs.toString(),
            cleanupOnly: true,
          };
        }
      };
      if (state.targetOwned) {
        try {
          await dependencies.stopPackage({
            serial: state.input.serial,
            packageName: state.input.scenario.packageName,
            reason: "restore_run_owned_target",
            ...cleanupBudget("owned target stop"),
          });
          state.targetOwned = false;
        } catch (error) {
          cleanupErrors.push(`owned target stop: ${errorText(error)}`);
        }
      }
      if (state.input.priorForeground.kind === "non_receipt_bound" && state.priorTerminatedByRun) {
        try {
          const relaunched = await dependencies.relaunchPrior({
            serial: state.input.serial,
            component: state.input.priorForeground.component,
            ...cleanupBudget("prior relaunch"),
          });
          const problem = validatePriorRelaunchReceipt(relaunched, state.input.priorForeground.component);
          if (problem) {
            priorDisposition.relaunchDisposition = relaunched.disposition === "accepted" ? "attempt_failed" : relaunched.disposition;
            cleanupErrors.push(problem);
          } else {
            priorDisposition.relaunchDisposition = "accepted";
          }
        } catch (error) {
          priorDisposition.relaunchDisposition = "attempt_failed";
          cleanupErrors.push(`prior relaunch: ${errorText(error)}`);
        }
      }
      try {
        finalProcessProof = await dependencies.probeFinalProcessState({
          serial: state.input.serial,
          targetPackage: state.input.scenario.packageName,
          artifactRoot: state.artifact.absoluteRoot,
          priorForeground: state.input.priorForeground,
          ...cleanupBudget("final process/activity proof"),
        });
        const checked = checkedFinalProcessProof(finalProcessProof, state.input, state.artifact.absoluteRoot);
        state.retainedLogs.push(checked.retained);
        if (checked.problem) cleanupErrors.push(checked.problem);
        else finalProcessProven = true;
      } catch (error) {
        cleanupErrors.push(`final process/activity proof: ${errorText(error)}`);
      }
      try {
        postStopSafety = await dependencies.sampleSafety({
          serial: state.input.serial,
          phase: "restore_after_prior_disposition",
          ...cleanupBudget("post-restore global safety"),
        });
        const unsafe = finalGlobalSafetyProblem(postStopSafety);
        if (unsafe) cleanupErrors.push(`post-restore global safety: ${unsafe}`);
        else finalSafetyProven = true;
      } catch (error) {
        cleanupErrors.push(`post-restore global safety: ${errorText(error)}`);
      }
    }
    let completed = primaryError === null && cleanupErrors.length === 0 && restoredReview !== null
      && !state.targetOwned && finalProcessProven && finalSafetyProven;
    let structuralStop = completed ? null : primaryCode ?? "restore_cleanup_failed";
    try {
      appendAction(state.artifact, {
        action: "restore",
        status: completed ? "completed" : "failed",
        structuralStop,
        primaryError,
        cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
        rootGeneration: state.rootGeneration,
        rootIncarnation: state.rootIncarnation,
        captureSha256: restoredReview?.captureSha256 ?? null,
        captureMode: reviewedMovedFrame ? "transition_then_stable" : "stable",
        locomotion,
        captureReceipt,
        preRestoreContinuity,
        preRestoreCapability,
        finalProcessProof,
        postStopSafety,
        priorForeground: priorDisposition,
      }, hooks);
    } catch (auditError) {
      if (primaryError === null) {
        primaryError = `restore action audit: ${errorText(auditError)}`;
        primaryCode = "action_audit_failed";
      } else {
        cleanupErrors.push(`restore action audit: ${errorText(auditError)}`);
      }
      completed = false;
      structuralStop = primaryCode ?? "action_audit_failed";
    }
    state.restoreCompleted = completed;
    state.status = completed ? "restored" : "stopped";
    if (completed && serialOwners.get(state.input.serial)?.runId === state.artifact.runId) {
      serialOwners.delete(state.input.serial);
    } else if (serialOwners.get(state.input.serial)?.runId === state.artifact.runId) {
      serialOwners.set(state.input.serial, {
        runId: state.artifact.runId,
        status: "quarantined",
        reason: "restore cleanup, final proof, safety, or audit remains unproven",
      });
    }
    return {
      status: completed ? "restored_needs_review" : "restore_failed",
      runId: state.artifact.runId,
      artifactRoot: state.artifact.absoluteRoot,
      rootGeneration: state.rootGeneration,
      rootIncarnation: state.rootIncarnation,
      structuralStop,
      primaryError,
      cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
      evidenceCeiling: "structural",
      lookRequired: true,
      requiredReview: restoredReview ? [restoredReview] : currentReviewTrusted ? [state.currentReview] : [],
      priorForeground: priorDisposition,
    };
  };

  const adjudicationRejected = (
    state: LocomotionState,
    detail: string,
    cleanupError: string | null = null,
  ): LocomotionAdjudicateReceipt => ({
    status: "adjudication_rejected",
    runId: state.artifact.runId,
    artifactRoot: state.artifact.absoluteRoot,
    artifactPath: null,
    evidenceCeiling: "structural",
    lookRequired: true,
    visionEligible: false,
    reviewDisposition: "not_eligible",
    captureCount: state.requiredReview.length,
    primaryError: detail,
    cleanupError,
  });

  const executeAdjudicate = async (input: InAppLocomotionAdjudicateInput, state: LocomotionState): Promise<LocomotionAdjudicateReceipt> => {
    if (!state.restoreCompleted || state.status !== "restored") {
      throw new Error("adjudicate is out of order until one completed restore");
    }
    if (state.adjudicated) throw new Error("adjudication is once-only and was already completed for this run");
    const expectedHashes = state.requiredReview.map((item) => item.captureSha256);
    const suppliedHashes = input.frameAttestations.map((item) => item.captureSha256);
    if (new Set(suppliedHashes).size !== suppliedHashes.length) {
      return adjudicationRejected(state, "frame attestations must be one unique capture-hash set");
    }
    const expectedSet = [...new Set(expectedHashes)].sort();
    const suppliedSet = [...suppliedHashes].sort();
    if (canonicalJson(expectedSet) !== canonicalJson(suppliedSet)) {
      return adjudicationRejected(state, "frame attestations are not the complete exact retained capture-hash set (missing or extra hash)");
    }
    assertStateArtifacts(state, hooks);
    const immutableErrors: string[] = [];
    for (const item of state.requiredReview) {
      try {
        dependencies.readReviewImage(item, state.artifact.absoluteRoot);
      } catch (error) {
        immutableErrors.push(`${item.captureSha256}: ${errorText(error)}`);
      }
    }
    if (immutableErrors.length) {
      return adjudicationRejected(state, `retained immutable PNG bytes failed sha256 validation: ${immutableErrors.join("; ")}`);
    }
    const attestationByHash = new Map(input.frameAttestations.map((item) => [item.captureSha256, item.attestation]));
    const frames = state.requiredReview.map((item) => ({ ...item, attestation: attestationByHash.get(item.captureSha256)! }));
    const artifactPath = path.join(state.artifact.absoluteRoot, "adjudication.json");
    const aggregate = {
      schemaVersion: 1,
      runId: state.artifact.runId,
      evidenceCeiling: "structural" as const,
      lookRequired: true as const,
      visionEligible: true,
      reviewDisposition: "eligible_for_external_vision_adjudication" as const,
      captureCount: frames.length,
      frames,
    };
    privateJson(artifactPath, aggregate);
    const adjudicationIdentity = artifactFileIdentity(artifactPath, "adjudication artifact", 16 * 1024 * 1024);
    try {
      appendAction(state.artifact, {
        action: "adjudicate",
        status: "structural_complete",
        captureCount: frames.length,
        captureSha256: frames.map((frame) => frame.captureSha256),
        evidenceCeiling: "structural",
        reviewDisposition: "eligible_for_external_vision_adjudication",
      }, hooks);
    } catch (auditError) {
      let cleanupError: string | null = null;
      try {
        unlinkExactArtifact(artifactPath, adjudicationIdentity, "unpublished adjudication artifact", 16 * 1024 * 1024);
      } catch (cleanup) {
        cleanupError = errorText(cleanup);
      }
      return adjudicationRejected(state, `adjudication action audit: ${errorText(auditError)}`, cleanupError);
    }
    state.adjudicated = true;
    state.status = "adjudicated";
    return {
      status: "structural_complete",
      runId: state.artifact.runId,
      artifactRoot: state.artifact.absoluteRoot,
      artifactPath,
      evidenceCeiling: "structural",
      lookRequired: true,
      visionEligible: true,
      reviewDisposition: "eligible_for_external_vision_adjudication",
      captureCount: frames.length,
      primaryError: null,
      cleanupError: null,
    };
  };

  const execute = async (rawInput: InAppLocomotionInput): Promise<Record<string, any>> => {
    const input = inAppLocomotionInputSchema.parse(rawInput);
    if (input.action === "prepare") {
      const lease = serialOwners.get(input.serial);
      if (lease) {
        throw new Error(`exact serial '${input.serial}' is ${lease.status} by run '${lease.runId}' until safe recovery: ${lease.reason}`);
      }
      if (busySerials.has(input.serial)) throw new Error(`a mutation is already in progress for exact serial '${input.serial}'`);
      busySerials.add(input.serial);
      try {
        return await executePrepare(input);
      } finally {
        busySerials.delete(input.serial);
      }
    }
    const state = runs.get(input.runId);
    if (!state) throw new Error("unknown in-app locomotion runId");
    if (busyRuns.has(input.runId)) throw new Error("a mutation is already in progress for this run");
    const mutatesSerial = input.action !== "adjudicate";
    if (mutatesSerial && serialOwners.get(state.input.serial)?.runId !== input.runId) {
      throw new Error(`run '${input.runId}' does not own exact serial '${state.input.serial}'`);
    }
    if (mutatesSerial && busySerials.has(state.input.serial)) throw new Error(`a mutation is already in progress for exact serial '${state.input.serial}'`);
    busyRuns.add(input.runId);
    if (mutatesSerial) busySerials.add(state.input.serial);
    try {
      if (input.action === "step") return await executeStep(input, state);
      if (input.action === "restore") return await executeRestore(input, state);
      return await executeAdjudicate(input, state);
    } finally {
      busyRuns.delete(input.runId);
      if (mutatesSerial) busySerials.delete(state.input.serial);
    }
  };
  return { execute };
}

function checkedLiveAdbResult(
  result: Awaited<ReturnType<typeof run>>,
  label: string,
): string {
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`}`);
  }
  return result.stdout.trim();
}

function requireExactLiveSerial(serial: string): void {
  if (!EMULATOR_SERIAL.test(serial)) throw new Error("live in-app locomotion requires one explicit emulator serial");
}

function embeddedJsonArrays(output: string): unknown[][] {
  if (Buffer.byteLength(output, "utf8") > 8 * 1024 * 1024) throw new Error("ConfigurationService output exceeds the bounded parser limit");
  const arrays: unknown[][] = [];
  for (let start = 0; start < output.length; start += 1) {
    if (output[start] !== "[") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "[") depth += 1;
      else if (character === "]") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(output.slice(start, end + 1));
      if (Array.isArray(parsed)) arrays.push(parsed);
    } catch {
      // Continue scanning: only a complete parseable array can be authoritative.
    }
    start = end;
  }
  return arrays;
}

export function parseConfigurationServiceValues(output: string, requestedKeys: readonly string[]): Record<string, string> {
  if (!Array.isArray(requestedKeys) || requestedKeys.length === 0 || new Set(requestedKeys).size !== requestedKeys.length
    || requestedKeys.some((key) => typeof key !== "string" || key.length === 0)) {
    throw new Error("ConfigurationService requested keys must be one non-empty unique string set");
  }
  const requested = new Set(requestedKeys);
  const rows: Array<Record<string, unknown>> = [];
  for (const array of embeddedJsonArrays(output)) {
    const relevant = array.some((row) => row !== null && typeof row === "object" && !Array.isArray(row)
      && requested.has(String((row as Record<string, unknown>).keyName ?? "")));
    if (!relevant) continue;
    for (const row of array) {
      if (row === null || typeof row !== "object" || Array.isArray(row)
        || typeof (row as Record<string, unknown>).keyName !== "string"
        || typeof (row as Record<string, unknown>).keyValue !== "string") {
        throw new Error("ConfigurationService JSON rows require string keyName and keyValue fields");
      }
      rows.push(row as Record<string, unknown>);
    }
  }
  const result: Record<string, string> = {};
  for (const key of requestedKeys) {
    const matches = rows.filter((row) => row.keyName === key);
    if (matches.length !== 1) throw new Error(`ConfigurationService did not expose exactly one unambiguous string value for '${key}'`);
    result[key] = matches[0].keyValue as string;
  }
  return result;
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseLocomotionBracketSignals(
  text: string,
  packageName: string,
  bracket?: { beginMarker: string; endMarker: string },
): LocomotionLogEvidence["boundarySignals"] {
  if (!PACKAGE.test(packageName) || Buffer.byteLength(text, "utf8") > 64 * 1024 * 1024) {
    throw new Error("locomotion bracket parser input is invalid or exceeds its bound");
  }
  let lines = text.split(/\r?\n/);
  if (bracket) {
    const beginIndexes = lines.flatMap((line, index) => line.includes(bracket.beginMarker) ? [index] : []);
    const endIndexes = lines.flatMap((line, index) => line.includes(bracket.endMarker) ? [index] : []);
    if (beginIndexes.length !== 1 || endIndexes.length !== 1 || endIndexes[0] < beginIndexes[0]) {
      throw new Error("locomotion log requires one exact ordered BEGIN/END marker bracket");
    }
    lines = lines.slice(beginIndexes[0], endIndexes[0] + 1);
  }
  const app = escapedRegex(packageName);
  const countLines = (pattern: RegExp) => lines.filter((line) => pattern.test(line)).length;
  return {
    setSpatialContainerBoundary: countLines(/setSpatialContainerBoundary/i),
    containerInfoChanged: countLines(/container info changed|(?:on)?SpatialContainerInfoChanged/i),
    boundaryMin: countLines(/boundary min|boundaryMin/i),
    launcherResume: countLines(/onResume\s+com\.picoxr\.launcher(?:[/.]|\b)/i),
    appPauseOrEjection: countLines(new RegExp(
      `(?:onPause|onStop|ON_PAUSE|ON_STOP)\\s+${app}(?:[/.]|\\b)|${app}[^\\r\\n]*(?:onPause|onStop|ON_PAUSE|ON_STOP|eject(?:ed|ion)?)`,
      "i",
    )),
  };
}

export function buildPriorRelaunchCommandArgs(serial: string, component: string): string[] {
  requireExactLiveSerial(serial);
  if (!COMPONENT.test(component)) throw new Error("prior relaunch requires one exact component");
  return [
    "-s", serial, "shell", "am", "start", "-W",
    "-a", "android.intent.action.MAIN",
    "-c", "android.intent.category.LAUNCHER",
    "-f", "0x10000000",
    "-n", component,
  ];
}

/**
 * Construct the production device adapter. Merely importing this module is inert: adb resolution
 * happens only when a caller explicitly requests live dependencies (or registers without fakes).
 */
export interface LiveInAppLocomotionOptions {
  resolveAdb?: () => string;
  runText?: typeof run;
  runBytes?: typeof runBinary;
  sleep?: typeof sleep;
  monotonicNs?: () => bigint;
}

export function createLiveInAppLocomotionDependencies(
  options: LiveInAppLocomotionOptions = {},
): InAppLocomotionDependencies {
  const adb = (options.resolveAdb ?? resolveAdb)();
  const liveRunText = options.runText ?? run;
  const liveRunBytes = options.runBytes ?? runBinary;
  const liveSleep = options.sleep ?? sleep;
  const liveClock = options.monotonicNs ?? (() => process.hrtime.bigint());

  const clockNs = (): bigint => {
    const value = liveClock();
    if (typeof value !== "bigint" || value < 0n) throw new Error("live in-app locomotion monotonic clock is invalid");
    return value;
  };
  const deadlineNs = (value: string, label: string): bigint => {
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} requires one positive absolute monotonic deadline`);
    return BigInt(value);
  };
  const boundedTimeout = (
    context: LocomotionEffectBudget,
    desiredMs: number,
    label: string,
    minimumMs = 1,
  ): number => {
    if (context.cleanupOnly === true) {
      if (!Number.isSafeInteger(context.timeoutMs) || context.timeoutMs < minimumMs
        || !Number.isSafeInteger(desiredMs) || desiredMs < minimumMs) {
        throw new Error(`${label} refused an invalid cleanup-only timeout`);
      }
      return Math.min(desiredMs, context.timeoutMs);
    }
    const deadline = deadlineNs(context.deadlineMonotonicNs, label);
    const remainingNs = deadline - clockNs();
    const remainingMs = remainingNs <= 0n ? 0 : Number(remainingNs / 1_000_000n);
    const available = Math.min(context.timeoutMs, remainingMs);
    if (!Number.isSafeInteger(context.timeoutMs) || context.timeoutMs < minimumMs
      || !Number.isSafeInteger(desiredMs) || desiredMs < minimumMs || available < minimumMs) {
      throw new Error(`${label} refused because the absolute deadline has less than ${minimumMs}ms remaining`);
    }
    return Math.min(desiredMs, available);
  };
  const sleepWithin = async (
    context: LocomotionEffectBudget,
    durationMs: number,
    label: string,
  ): Promise<void> => {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new Error(`${label} sleep duration is invalid`);
    if (durationMs === 0) return;
    const timeoutMs = boundedTimeout(context, durationMs, label);
    if (timeoutMs !== durationMs) throw new Error(`${label} would exceed the absolute deadline`);
    await liveSleep(durationMs);
  };
  const runBounded = async (
    serial: string,
    args: string[],
    label: string,
    context: LocomotionEffectBudget,
    desiredMs: number,
    maxOutputBytes = 8 * 1024 * 1024,
  ): Promise<Awaited<ReturnType<typeof run>>> => {
    requireExactLiveSerial(serial);
    const timeoutMs = boundedTimeout(context, desiredMs, label);
    return liveRunText(adb, ["-s", serial, ...args], { timeoutMs, maxOutputBytes });
  };
  const checked = async (
    serial: string,
    args: string[],
    label: string,
    context: LocomotionEffectBudget,
    desiredMs: number,
    maxOutputBytes = 8 * 1024 * 1024,
  ): Promise<string> => {
    return checkedLiveAdbResult(await runBounded(serial, args, label, context, desiredMs, maxOutputBytes), label);
  };
  const checkedAlreadySerialized = async (
    serial: string,
    args: string[],
    requestedTimeoutMs: number,
    label: string,
    context: { timeoutMs: number; deadlineMonotonicNs: string },
  ): Promise<string> => {
    requireExactLiveSerial(serial);
    if (args[0] !== "-s" || args[1] !== serial) throw new Error(`${label} lost exact serial qualification`);
    const timeoutMs = boundedTimeout(context, requestedTimeoutMs, label);
    return checkedLiveAdbResult(await liveRunText(adb, args, { timeoutMs, maxOutputBytes: 8 * 1024 * 1024 }), label);
  };

  const sampleSafetyLive = async (context: {
    serial: string;
    phase: string;
    timeoutMs: number;
    deadlineMonotonicNs: string;
  }): Promise<LocomotionSafetySnapshot> => {
    const guardian = await checked(context.serial, ["shell", "getprop", "sys.guardian.vst.status"], `${context.phase} Guardian probe`, context, 10_000, 64 * 1024);
    const vstComponent = await checked(context.serial, ["shell", "getprop", "sys.pxr.vst.comp.state"], `${context.phase} VST component probe`, context, 10_000, 64 * 1024);
    const vstDebug = await checked(context.serial, ["shell", "getprop", "persist.pxr.see.vst.debug.enable"], `${context.phase} VST debug probe`, context, 10_000, 64 * 1024);
    const configuration = await checked(context.serial, ["shell", "dumpsys", "ConfigurationService"], `${context.phase} spatial configuration probe`, context, 15_000);
    const values = parseConfigurationServiceValues(configuration, [
      "spatial_stage_style",
      "spatial_safeguard_enable",
      "spatial_safeguard_center",
      "spatial_virtual_content_detected",
    ]);
    return {
      guardian,
      vstComponent,
      vstDebug,
      stageStyle: values.spatial_stage_style,
      safeguard: values.spatial_safeguard_enable,
      safeguardCenter: values.spatial_safeguard_center,
      virtualContent: values.spatial_virtual_content_detected,
    };
  };

  const sampleContinuityLive = async (context: {
    serial: string;
    phase: string;
    runtime: LocomotionRuntimeBinding;
    artifactRoot: string;
    timeoutMs: number;
    deadlineMonotonicNs: string;
  }): Promise<ApplicationContinuitySample> => {
    requireExactLiveSerial(context.serial);
    if (context.runtime.liveIdentity.serial !== context.serial) throw new Error("continuity runtime is bound to another serial");
    const binding = context.runtime.applicationBinding;
    const bootId = await checked(context.serial, ["shell", "cat", "/proc/sys/kernel/random/boot_id"], `${context.phase} boot identity`, context, 10_000);
    const installedPath = parseInstalledApkPath(await checked(
      context.serial,
      ["shell", "pm", "path", binding.packageName],
      `${context.phase} installed APK path`,
      context,
      10_000,
    ));
    let apkSha256 = "";
    if (installedPath) {
      apkSha256 = parseRemoteSha256(await checked(
        context.serial,
        ["shell", "toybox", "sha256sum", installedPath],
        `${context.phase} installed APK digest`,
        context,
        10_000,
      )) ?? "";
    }
    const pid = parsePid(await checked(context.serial, ["shell", "pidof", binding.packageName], `${context.phase} PID`, context, 10_000));
    const pidStartTicks = pid === null ? null : parseProcStartTicks(await checked(
      context.serial,
      ["shell", "cat", `/proc/${pid}/stat`],
      `${context.phase} process start ticks`,
      context,
      10_000,
    ));
    const activities = parseForegroundActivities(await checked(
      context.serial,
      ["shell", "dumpsys", "activity", "activities"],
      `${context.phase} foreground activities`,
      context,
      20_000,
    ));
    const resumedComponents = activities.map((activity) => activity.component);
    const packageActivities = activities.filter((activity) => activity.packageName === binding.packageName);
    const exactAllowedForeground = activities.length > 0 && activities.every((activity) =>
      activity.packageName === binding.packageName && binding.allowedResumedComponents.includes(activity.component));
    const foreground: ApplicationContinuitySample["foreground"] = activities.length === 0
      ? "absent"
      : packageActivities.length === 0
        ? "different_package"
        : exactAllowedForeground
          ? "exact_allowed"
          : "same_package_unlisted";
    return {
      observedAtMonotonicNs: clockNs().toString(),
      serial: context.serial,
      bootId,
      packageName: binding.packageName,
      allowedResumedComponents: [...binding.allowedResumedComponents],
      apkSha256,
      pid,
      pidStartTicks,
      resumedComponents,
      foreground,
      probeEventsSincePrior: [],
      probeParse: "absent",
      probeSequence: "unknown",
      watchdog: { status: "absent" },
    };
  };

  const runtimeHealthSnapshot = async (context: {
    serial: string;
    artifactRoot: string;
    marker: string;
    sampleIndex: number;
    packageName: string;
    pid: number;
    timeoutMs: number;
    deadlineMonotonicNs: string;
  }): Promise<{ health: PackageRuntimeHealthReceiptV1; rawArtifact: LocomotionRawLogEvidence }> => {
    const result = await runBounded(
      context.serial,
      ["logcat", "-b", "all", "-d", "-v", "threadtime"],
      "fresh-launch runtime-health snapshot",
      context,
      10_000,
      64 * 1024 * 1024,
    );
    checkedLiveAdbResult(result, "fresh-launch runtime-health snapshot");
    const output = result.stdout;
    const artifactPath = path.join(context.artifactRoot, "logs", `fresh-launch-${String(context.sampleIndex).padStart(2, "0")}.log`);
    privateWrite(artifactPath, output);
    const identity = artifactFileIdentity(artifactPath, "fresh-launch runtime-health raw log", 64 * 1024 * 1024);
    const bytes = readSameArtifactFile(artifactPath, identity, "fresh-launch runtime-health raw log", 64 * 1024 * 1024);
    const receipt: RuntimeLogSnapshotReceipt = {
      status: "snapshot_collected",
      truncated: false,
      observedBytes: bytes.length,
      appStartMarker: context.marker,
      appStartMarkerObserved: bytes.includes(Buffer.from(context.marker, "utf8")),
      rawArtifact: { path: fs.realpathSync(artifactPath), sha256: identity.sha256, bytes: identity.bytes },
    };
    return {
      health: scanPackageRuntimeHealth(receipt, context.packageName, [context.pid]),
      rawArtifact: receipt.rawArtifact,
    };
  };

  return {
    randomBytes: (size) => crypto.randomBytes(size),
    now: () => new Date().toISOString(),
    monotonicNs: clockNs,
    readNativeRunReceipt,
    readEffectiveAppSpec: readReceiptBoundEffectiveAppSpec,
    snapshotPriorForeground: async (context) => {
      const { serial } = context;
      const activityOutput = await checked(serial, ["shell", "dumpsys", "activity", "activities"], "prior foreground activity snapshot", context, 20_000);
      const resumedPackages = parseResumedPackages(activityOutput);
      const thirdPartyPackages = parseThirdPartyPackages(await checked(
        serial,
        ["shell", "pm", "list", "packages", "-3"],
        "prior foreground third-party inventory",
        context,
        20_000,
        2 * 1024 * 1024,
      ));
      const activities = parseForegroundActivities(activityOutput);
      const candidates = activities.filter((activity) => thirdPartyPackages.has(activity.packageName));
      const unique = [...new Map(candidates.map((activity) => [activity.component, activity])).values()];
      const userResumed = resumedPackages.filter((packageName) => thirdPartyPackages.has(packageName));
      if (unique.length !== 1 || new Set(userResumed).size !== 1 || unique[0].packageName !== userResumed[0]) {
        if (unique.length === 0 && userResumed.length === 0) return { component: null, packageName: null, userInstalled: false };
        throw new Error("prior foreground snapshot is ambiguous across resumed third-party applications");
      }
      return { component: unique[0].component, packageName: unique[0].packageName, userInstalled: true };
    },
    stopPackage: async (context) => {
      const { serial, packageName, reason } = context;
      await checked(serial, ["shell", "am", "force-stop", packageName], `${reason} force-stop ${packageName}`, context, 10_000, 64 * 1024);
      return { status: "stop_command_completed", serial, packageName, reason };
    },
    launchTarget: async (context) => {
      const { serial, component } = context;
      requireExactLiveSerial(serial);
      const result = await runBounded(serial, ["shell", "am", "start", "-W", "-n", component], "target launch", context, 30_000, 1024 * 1024);
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      return {
        disposition: classifyActivityLaunchDisposition(output, result.code === 0 && !result.timedOut),
        component,
        outputSha256: sha256Bytes(Buffer.from(output, "utf8")),
      };
    },
    captureLaunchHandoffWindow: async (context) => {
      const result = await runBounded(
        context.serial,
        ["shell", "dumpsys", "window", "windows"],
        "post-launch window handoff",
        context,
        10_000,
      );
      checkedLiveAdbResult(result, "post-launch window handoff");
      const artifactPath = path.join(context.artifactRoot, "logs", "fresh-launch-window-handoff.txt");
      privateWrite(artifactPath, result.stdout);
      const identity = artifactFileIdentity(artifactPath, "post-launch raw window handoff", 64 * 1024 * 1024);
      const bytes = readSameArtifactFile(artifactPath, identity, "post-launch raw window handoff", 64 * 1024 * 1024);
      return {
        dialogs: freshLaunchDialogs(bytes.toString("utf8")),
        rawWindowDump: { path: fs.realpathSync(artifactPath), sha256: identity.sha256, bytes: identity.bytes },
      };
    },
    probeRuntimeBinding: async (context) => {
      const { serial, scenario } = context;
      const cap = (requested: number, label: string) => boundedTimeout(context, requested, label);
      const liveIdentity = await probeBoundedCaptureIdentity(
        serial,
        cap,
        (args, timeoutMs, label) => checkedAlreadySerialized(serial, args, timeoutMs, label, context),
      );
      const installedPath = parseInstalledApkPath(await checked(serial, ["shell", "pm", "path", scenario.packageName], "installed APK path", context, 10_000));
      if (!installedPath) throw new Error("installed APK path is missing or ambiguous");
      const digestOutput = await checked(serial, ["shell", "toybox", "sha256sum", installedPath], "installed APK sha256", context, 10_000);
      const digestLines = digestOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const apkSha256 = parseRemoteSha256(digestOutput);
      if (!apkSha256 || digestLines.length !== 1 || !digestLines[0].endsWith(` ${installedPath}`)) {
        throw new Error("installed APK digest did not bind the exact installed path");
      }
      const pid = parsePid(await checked(serial, ["shell", "pidof", scenario.packageName], "target PID", context, 10_000));
      if (pid === null) throw new Error("target PID is missing or ambiguous");
      const pidStartTicks = parseProcStartTicks(await checked(serial, ["shell", "cat", `/proc/${pid}/stat`], "target process start ticks", context, 10_000));
      if (pidStartTicks === null) throw new Error("target process start ticks are missing");
      const activities = parseForegroundActivities(await checked(serial, ["shell", "dumpsys", "activity", "activities"], "target foreground binding", context, 20_000));
      const targetComponents = [...new Set(activities.filter((activity) => activity.packageName === scenario.packageName).map((activity) => activity.component))];
      if (targetComponents.length !== 1 || !scenario.allowedResumedComponents.includes(targetComponents[0])) {
        throw new Error("target foreground activity is absent, ambiguous, or outside the allowed component set");
      }
      return {
        liveIdentity,
        applicationBinding: {
          packageName: scenario.packageName,
          apkSha256,
          allowedResumedComponents: [...scenario.allowedResumedComponents],
          pid,
          pidStartTicks,
        },
        foregroundComponent: targetComponents[0],
      };
    },
    sampleSafety: sampleSafetyLive,
    probeCapability: (input) => probeAgentBridgeLocomotionCapability(adb, input, {
      runText: liveRunText,
      runBytes: liveRunBytes,
      sleep: liveSleep,
      monotonicNs: clockNs,
    }),
    requestHmdPose: (input) => requestAgentBridgeHmdPose(adb, input, {
      runText: liveRunText,
      runBytes: liveRunBytes,
      sleep: liveSleep,
      monotonicNs: clockNs,
    }),
    monitorFreshLaunch: async (context) => {
      const initialRemainingMs = Number((deadlineNs(context.deadlineMonotonicNs, "fresh-launch monitor") - clockNs()) / 1_000_000n);
      if (initialRemainingMs < context.minimumDurationMs + 1) {
        throw new Error("fresh-launch monitor absolute deadline cannot cover the mandatory 60-second window");
      }
      const marker = context.healthBoundaryMarker;
      const startedNs = clockNs();
      const samples: FreshLaunchMonitorSample[] = [];
      const rawHealthLogs: LocomotionRawLogEvidence[] = [];
      const rawWindowDumps: LocomotionRawLogEvidence[] = [];
      for (const [sampleIndex, targetElapsedMs] of [0, 15_000, 30_000, 45_000, 60_000].entries()) {
        const beforeSleepMs = Number((clockNs() - startedNs) / 1_000_000n);
        if (beforeSleepMs < targetElapsedMs) {
          await sleepWithin(context, targetElapsedMs - beforeSleepMs, `fresh-launch sample ${sampleIndex} delay`);
        }
        const elapsedMs = Number((clockNs() - startedNs) / 1_000_000n);
        const windowResult = await runBounded(
          context.serial,
          ["shell", "dumpsys", "window", "windows"],
          "fresh-launch dialog probe",
          context,
          10_000,
        );
        checkedLiveAdbResult(windowResult, "fresh-launch dialog probe");
        const windowState = windowResult.stdout;
        const windowPath = path.join(context.artifactRoot, "logs", `fresh-launch-window-${String(sampleIndex).padStart(2, "0")}.txt`);
        privateWrite(windowPath, windowState);
        const windowIdentity = artifactFileIdentity(windowPath, "fresh-launch raw window dump", 64 * 1024 * 1024);
        const windowBytes = readSameArtifactFile(windowPath, windowIdentity, "fresh-launch raw window dump", 64 * 1024 * 1024);
        rawWindowDumps.push({ path: fs.realpathSync(windowPath), sha256: windowIdentity.sha256, bytes: windowIdentity.bytes });
        const dialogs = freshLaunchDialogs(windowBytes.toString("utf8"));
        const safety = await sampleSafetyLive({
          serial: context.serial,
          phase: `fresh_launch_${sampleIndex}`,
          timeoutMs: context.timeoutMs,
          deadlineMonotonicNs: context.deadlineMonotonicNs,
        });
        const continuity = await sampleContinuityLive({
          serial: context.serial,
          phase: `fresh_launch_${sampleIndex}`,
          runtime: context.runtime,
          artifactRoot: context.artifactRoot,
          timeoutMs: context.timeoutMs,
          deadlineMonotonicNs: context.deadlineMonotonicNs,
        });
        const runtimeHealth = await runtimeHealthSnapshot({
          serial: context.serial,
          artifactRoot: context.artifactRoot,
          marker,
          sampleIndex,
          packageName: context.runtime.applicationBinding.packageName,
          pid: context.runtime.applicationBinding.pid,
          timeoutMs: context.timeoutMs,
          deadlineMonotonicNs: context.deadlineMonotonicNs,
        });
        rawHealthLogs.push(runtimeHealth.rawArtifact);
        samples.push({ elapsedMs, dialogs, safety, continuity, runtimeHealth: runtimeHealth.health });
      }
      return {
        durationMs: Number((clockNs() - startedNs) / 1_000_000n),
        healthBoundaryMarker: marker,
        samples,
        rawHealthLogs,
        rawWindowDumps,
      };
    },
    captureSettled: (input) => executeLiveCaptureSettled(input, { adbPath: adb }),
    readReviewImage: readBoundReviewImage,
    sampleContinuity: sampleContinuityLive,
    requestLocomotion: (input) => requestAgentBridgeLocomotion(adb, input, {
      runText: liveRunText,
      runBytes: liveRunBytes,
      sleep: liveSleep,
      monotonicNs: clockNs,
    }),
    emitMarker: async (context) => {
      const { serial, marker } = context;
      await checked(serial, ["shell", "log", "-t", "WorldLocomotion", marker], `locomotion marker ${marker}`, context, 5_000, 64 * 1024);
    },
    collectStepLogs: async (context) => {
      requireExactLiveSerial(context.serial);
      const result = await runBounded(
        context.serial,
        ["logcat", "-b", "all", "-d", "-v", "threadtime"],
        "locomotion bracket log",
        context,
        context.timeoutMs,
        64 * 1024 * 1024,
      );
      const allLines = result.stdout.split(/\r?\n/).filter(Boolean);
      const beginIndexes = allLines.flatMap((line, index) => line.includes(context.beginMarker) ? [index] : []);
      const endIndexes = allLines.flatMap((line, index) => line.includes(context.endMarker) ? [index] : []);
      const completeWindow = beginIndexes.length === 1 && endIndexes.length === 1 && endIndexes[0] >= beginIndexes[0];
      const selectedLines = completeWindow ? allLines.slice(beginIndexes[0], endIndexes[0] + 1) : allLines;
      const bytes = Buffer.from(selectedLines.length ? `${selectedLines.join("\n")}\n` : "", "utf8");
      privateWrite(context.path, bytes);
      const identity = artifactFileIdentity(context.path, "locomotion bracket log", 64 * 1024 * 1024);
      const retained = readSameArtifactFile(context.path, identity, "locomotion bracket log", 64 * 1024 * 1024);
      const text = retained.toString("utf8");
      return {
        path: fs.realpathSync(context.path),
        sha256: sha256Bytes(retained),
        bytes: retained.length,
        truncated: result.code !== 0 || result.timedOut || !completeWindow,
        beginCount: text.split(context.beginMarker).length - 1,
        endCount: text.split(context.endMarker).length - 1,
        boundarySignals: parseLocomotionBracketSignals(text, context.packageName, {
          beginMarker: context.beginMarker,
          endMarker: context.endMarker,
        }),
      };
    },
    relaunchPrior: async (context) => {
      const { serial, component } = context;
      requireExactLiveSerial(serial);
      const timeoutMs = boundedTimeout(context, 30_000, "prior relaunch");
      const result = await liveRunText(adb, buildPriorRelaunchCommandArgs(serial, component), {
        timeoutMs,
        maxOutputBytes: 1024 * 1024,
      });
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      const activityResult = await runBounded(
        serial,
        ["shell", "dumpsys", "activity", "activities"],
        "prior relaunch exact resumed-component probe",
        context,
        20_000,
      );
      checkedLiveAdbResult(activityResult, "prior relaunch exact resumed-component probe");
      const activityOutput = activityResult.stdout;
      return {
        disposition: classifyActivityLaunchDisposition(output, result.code === 0 && !result.timedOut),
        component,
        outputSha256: sha256Bytes(Buffer.from(output, "utf8")),
        activityProbeSha256: sha256Bytes(Buffer.from(activityOutput, "utf8")),
        resumedComponents: parseForegroundActivities(activityOutput).map((activity) => activity.component),
      };
    },
    probeFinalProcessState: async (context) => {
      const pidResult = await runBounded(
        context.serial,
        ["shell", "pidof", context.targetPackage],
        "final target PID probe",
        context,
        10_000,
        64 * 1024,
      );
      if (pidResult.timedOut || (pidResult.code !== 0 && pidResult.code !== 1)) {
        throw new Error(`final target PID probe failed: ${pidResult.stderr.trim() || pidResult.stdout.trim() || `exit ${String(pidResult.code)}`}`);
      }
      const pidofOutput = pidResult.stdout;
      const normalizedPidOutput = pidofOutput.trim();
      const targetPids = normalizedPidOutput === "" ? [] : normalizedPidOutput.split(/\s+/).map((value) => Number(value));
      if (targetPids.some((pid) => !Number.isSafeInteger(pid) || pid < 1) || new Set(targetPids).size !== targetPids.length) {
        throw new Error("final target PID probe returned malformed or duplicate process identities");
      }
      const activityResult = await runBounded(
        context.serial,
        ["shell", "dumpsys", "activity", "activities"],
        "final foreground activity probe",
        context,
        20_000,
        8 * 1024 * 1024,
      );
      checkedLiveAdbResult(activityResult, "final foreground activity probe");
      const activityOutput = activityResult.stdout;
      const resumedComponents = parseForegroundActivities(activityOutput).map((activity) => activity.component);
      const rawBytes = Buffer.from(`${canonicalJson({ pidofOutput, activityOutput, targetPids, resumedComponents })}\n`, "utf8");
      const artifactPath = path.join(context.artifactRoot, "logs", "999-final-process-activity.json");
      privateWrite(artifactPath, rawBytes);
      const identity = artifactFileIdentity(artifactPath, "final process/activity raw probe", 64 * 1024 * 1024);
      return {
        serial: context.serial,
        targetPackage: context.targetPackage,
        targetPids,
        resumedComponents,
        rawProbe: { path: fs.realpathSync(artifactPath), sha256: identity.sha256, bytes: identity.bytes },
      };
    },
  };
}

export function registerInAppLocomotionTools(
  server: McpServer,
  dependencies?: InAppLocomotionDependencies,
): void {
  const selectedDependencies = dependencies ?? createLiveInAppLocomotionDependencies();
  const orchestrator = createInAppLocomotionOrchestrator(selectedDependencies);
  server.registerTool(
    "run_in_app_locomotion_route",
    {
      description: "Run one receipt-bound Full-stage in-app world-root route as strict prepare, reviewed step, restore, and structural adjudicate actions. Every mutation uses one explicit direct or replacement mechanism, exact serial and runtime binding, stable captures, safety/continuity evidence, and a caller-reserved external artifact root. Returned captures still require LOOK; the tool does not award visual or device verification.",
      inputSchema: inAppLocomotionInputSchema,
    },
    async (args) => {
      try {
        const result = await orchestrator.execute(args as InAppLocomotionInput);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }> = [];
        const reviews = Array.isArray(result.requiredReview) ? result.requiredReview as LocomotionReviewItem[] : [];
        let responseBytes = 0;
        for (const item of reviews) {
          const bytes = selectedDependencies.readReviewImage(item, result.artifactRoot);
          responseBytes += bytes.length;
          if (responseBytes > 128 * 1024 * 1024) throw new Error("locomotion review images exceed the 128 MiB response cap");
          content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
        }
        content.push({ type: "text", text: JSON.stringify(result, null, 2) });
        return { content };
      } catch (error) {
        return okJson({ status: "error", error: errorText(error), evidenceCeiling: "structural", lookRequired: true });
      }
    },
  );
}
