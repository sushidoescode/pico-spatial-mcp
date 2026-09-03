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
  sampleApplicationContinuity,
  scanPackageRuntimeHealth,
  type ApplicationContinuitySample,
  type PackageRuntimeHealthReceiptV1,
  type RuntimeLogSnapshotReceipt,
} from "./runtimecontinuity.js";
import { okJson, run, sleep } from "./util.js";

const SHA256 = /^[a-f0-9]{64}$/;
const EMULATOR_SERIAL = /^emulator-[1-9][0-9]*$/;
const PACKAGE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const COMPONENT = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\/[A-Za-z0-9_.$]+$/;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const hashSchema = z.string().regex(SHA256);
const componentSchema = z.string().regex(COMPONENT);
const absolutePositionSchema = z.object({
  absolute: z.literal(true),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
}).strict();

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
  const targets = value.waypoints.map((waypoint) => `${waypoint.target.x}\0${waypoint.target.y}\0${waypoint.target.z}`);
  if (new Set(targets).size !== targets.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["waypoints"], message: "absolute waypoint targets must be unique" });
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
});

const stepSchema = z.object({
  action: z.literal("step"),
  runId: hashSchema,
  reviewedPriorFrame: reviewedFrameSchema,
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
  samples: FreshLaunchMonitorSample[];
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
}

type ReceiptValidation = ReturnType<typeof readNativeRunReceipt>;
type CapabilityResult = Awaited<ReturnType<typeof probeAgentBridgeLocomotionCapability>>;
type HmdResult = Awaited<ReturnType<typeof requestAgentBridgeHmdPose>>;
type LocomotionResult = Awaited<ReturnType<typeof requestAgentBridgeLocomotion>>;

export interface InAppLocomotionDependencies {
  randomBytes(size: number): Buffer;
  now(): string;
  monotonicNs(): bigint;
  readNativeRunReceipt(app: string, receiptId: string): ReceiptValidation;
  readEffectiveAppSpec(artifactPath: string, identity: { sha256: string; bytes: number }): unknown;
  snapshotPriorForeground(context: { serial: string; targetPackage: string }): Promise<LocomotionPriorForegroundSnapshot>;
  stopPackage(context: { serial: string; packageName: string; reason: string }): Promise<unknown>;
  launchTarget(context: { serial: string; component: string }): Promise<{ disposition: "accepted" | "ignored" | "blocked"; component: string; outputSha256: string }>;
  probeRuntimeBinding(context: {
    serial: string;
    scenario: InAppLocomotionPrepareInput["scenario"];
    expectedApkSha256: string;
  }): Promise<LocomotionRuntimeBinding>;
  sampleSafety(context: { serial: string; phase: string }): Promise<LocomotionSafetySnapshot>;
  probeCapability(input: AgentBridgeLocomotionTransactionInput): Promise<CapabilityResult>;
  requestHmdPose(input: AgentBridgeHmdPoseRequestInput): Promise<HmdResult>;
  monitorFreshLaunch(context: {
    serial: string;
    runId: string;
    artifactRoot: string;
    minimumDurationMs: 60_000;
    runtime: LocomotionRuntimeBinding;
  }): Promise<FreshLaunchMonitorReceipt>;
  captureSettled(input: CaptureSettledInput): Promise<{ receipt: CaptureSettledReceipt; frame: Buffer | null }>;
  readReviewImage(item: LocomotionReviewItem, artifactRoot: string): Buffer;
  sampleContinuity(context: {
    serial: string;
    phase: string;
    runtime: LocomotionRuntimeBinding;
    artifactRoot: string;
  }): Promise<ApplicationContinuitySample>;
  requestLocomotion(input: AgentBridgeLocomotionRequestInput): Promise<LocomotionResult>;
  emitMarker(context: { serial: string; marker: string }): Promise<void>;
  collectStepLogs(context: {
    serial: string;
    packageName: string;
    pid: number;
    beginMarker: string;
    endMarker: string;
    path: string;
    timeoutMs: number;
  }): Promise<LocomotionLogEvidence>;
  relaunchPrior(context: { serial: string; component: string }): Promise<{ disposition: "accepted" | "ignored" | "blocked"; component: string }>;
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
  runtime: LocomotionRuntimeBinding;
  prior: LocomotionPriorForegroundSnapshot;
  priorTerminatedByRun: boolean;
  targetOwned: boolean;
  rootGeneration: number;
  baselineHmd: AgentBridgeHmdPose;
  currentReview: LocomotionReviewItem;
  requiredReview: LocomotionReviewItem[];
  retainedLogs: Array<{ path: string; identity: ArtifactFileIdentity }>;
  nextWaypoint: number;
  startedAtNs: bigint;
  deadlineNs: bigint;
  usage: { waypointAttempts: number; successfulWaypoints: number; routeDurationMs: number };
  restoreAttempted: boolean;
  restoreCompleted: boolean;
  adjudicated: boolean;
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

function artifactFileIdentity(filePath: string, label: string, maxBytes: number): ArtifactFileIdentity {
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
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`${label} changed while its immutable identity was read`);
    }
    return { dev: after.dev, ino: after.ino, bytes: bytes.length, sha256: sha256Bytes(bytes) };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertSameArtifactFile(filePath: string, expected: ArtifactFileIdentity, label: string, maxBytes: number): void {
  const actual = artifactFileIdentity(filePath, label, maxBytes);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`${label} changed after immutable publication`);
  }
}

function appendAction(binding: OwnedArtifactBinding, value: unknown): void {
  assertOwnedArtifacts(binding);
  const target = path.join(binding.absoluteRoot, "actions.jsonl");
  const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
    if (!stat.isFile() || stat.size + bytes.length > 16 * 1024 * 1024) throw new Error("action JSONL exceeded its bounded regular-file contract");
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const nextIdentity = artifactFileIdentity(target, "action JSONL", 16 * 1024 * 1024);
  if (nextIdentity.dev !== binding.actionLog.dev || nextIdentity.ino !== binding.actionLog.ino) {
    throw new Error("action JSONL identity changed during append");
  }
  binding.actionLog = nextIdentity;
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

function assertOwnedArtifacts(binding: OwnedArtifactBinding): void {
  sameDirectory(binding.absoluteRoot, { dev: binding.rootDev, ino: binding.rootIno }, "artifact root");
  sameDirectory(path.join(binding.absoluteRoot, "captures"), { dev: binding.capturesDev, ino: binding.capturesIno }, "capture directory");
  sameDirectory(path.join(binding.absoluteRoot, "logs"), { dev: binding.logsDev, ino: binding.logsIno }, "log directory");
  assertSameArtifactFile(path.join(binding.absoluteRoot, ".owner.json"), binding.ownerFile, "artifact ownership manifest", 64 * 1024);
  assertSameArtifactFile(path.join(binding.absoluteRoot, "run.json"), binding.runManifest, "run manifest", 1024 * 1024);
  assertSameArtifactFile(path.join(binding.absoluteRoot, "route.json"), binding.routeManifest, "route manifest", 1024 * 1024);
  assertSameArtifactFile(path.join(binding.absoluteRoot, "actions.jsonl"), binding.actionLog, "action JSONL", 16 * 1024 * 1024);
  const owner = JSON.parse(fs.readFileSync(path.join(binding.absoluteRoot, ".owner.json"), "utf8"));
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

function assertReceiptAndSpec(input: InAppLocomotionPrepareInput, dependencies: InAppLocomotionDependencies): Extract<ReceiptValidation, { status: "valid" }> {
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
  return validation;
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

function hmdPoseFrom(result: HmdResult, expectedGeneration: number): AgentBridgeHmdPose {
  if (!result.ok) throw new LocomotionStageError(result.code, result.primaryError ?? result.detail, result.cleanupError);
  const pose = result.ack.hmdPose;
  if (result.ack.root?.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID || result.ack.root.generation !== expectedGeneration || pose === null) {
    throw new Error("HMD result lost the exact root generation binding");
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

function validateMonitor(monitor: FreshLaunchMonitorReceipt, runtime: LocomotionRuntimeBinding): void {
  if (!Number.isFinite(monitor.durationMs) || monitor.durationMs < 60_000 || !Array.isArray(monitor.samples) || monitor.samples.length < 2) {
    throw new Error("fresh-launch monitor did not retain multiple samples through at least 60 seconds");
  }
  const elapsed = monitor.samples.map((sample) => sample.elapsedMs);
  if (elapsed.some((value, index) => !Number.isFinite(value) || value < 0 || (index > 0 && value <= elapsed[index - 1]))) {
    throw new Error("fresh-launch monitor sample times are invalid or non-monotonic");
  }
  if (elapsed.at(-1)! < 60_000) throw new Error("fresh-launch monitor final sample was earlier than 60 seconds");
  for (const sample of monitor.samples) {
    if (!Array.isArray(sample.dialogs) || sample.dialogs.length > 0) throw new Error("fresh-launch dialog monitor observed a blocking dialog");
    if (sample.runtimeHealth?.status !== "no_attributed_failure" || !Array.isArray(sample.runtimeHealth.incidents) || sample.runtimeHealth.incidents.length > 0) {
      throw new Error("fresh-launch runtime-health monitor found an attributed failure or inconclusive sample");
    }
    const unsafe = safetyProblem(sample.safety);
    if (unsafe) throw new Error(`fresh-launch safety drift: ${unsafe}`);
    const continuity = continuityProblem(sample.continuity, runtime);
    if (continuity) throw new Error(continuity);
  }
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
  const rounded = Math.fround(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

function samePosition(
  observed: { x: number; y: number; z: number },
  expected: { x: number; y: number; z: number },
): boolean {
  return observed.x === float32(expected.x) && observed.y === float32(expected.y) && observed.z === float32(expected.z);
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

function remainingRouteWorkMs(state: LocomotionState, dependencies: InAppLocomotionDependencies): number {
  const now = checkedMonotonic(dependencies);
  const beforeRestoreNs = state.deadlineNs - BigInt(state.input.budgets.restorationReserveMs) * 1_000_000n;
  const totalRemaining = Number((beforeRestoreNs - now) / 1_000_000n);
  const routeRemaining = state.input.budgets.routeReserveMs - state.usage.routeDurationMs;
  return Math.floor(Math.min(totalRemaining, routeRemaining));
}

function checkedLogEvidence(value: LocomotionLogEvidence, expectedPath: string): LocomotionLogEvidence {
  if (value.path !== expectedPath || !SHA256.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || value.bytes > 64 * 1024 * 1024 || value.truncated || value.beginCount !== 1 || value.endCount !== 1
    || Object.values(value.boundarySignals).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
    throw new Error("step log evidence is not one complete bounded BEGIN/END window with zero container/boundary transitions");
  }
  const stat = fs.lstatSync(expectedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== value.bytes) throw new Error("step log evidence path is not the exact bounded regular file");
  const bytes = fs.readFileSync(expectedPath);
  if (sha256Bytes(bytes) !== value.sha256) throw new Error("step log evidence bytes changed after collection");
  return value;
}

function assertStateArtifacts(state: LocomotionState): void {
  assertOwnedArtifacts(state.artifact);
  for (const [index, retained] of state.retainedLogs.entries()) {
    assertSameArtifactFile(retained.path, retained.identity, `retained step log ${index + 1}`, 64 * 1024 * 1024);
  }
}

function stepReviewFailure(state: LocomotionState, detail: string): LocomotionStepReceipt {
  return {
    status: "review_rejected",
    runId: state.artifact.runId,
    artifactRoot: state.artifact.absoluteRoot,
    rootGeneration: state.rootGeneration,
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

function priorForegroundDisposition(state: LocomotionState): LocomotionPriorForegroundDisposition {
  const declared = state.input.priorForeground;
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
      receiptFreshness: state.priorTerminatedByRun ? "known_stale" : "not_evaluated_cp1",
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

function restoreReviewFailure(state: LocomotionState, detail: string): LocomotionRestoreReceipt {
  return {
    status: "review_rejected",
    runId: state.artifact.runId,
    artifactRoot: state.artifact.absoluteRoot,
    rootGeneration: state.rootGeneration,
    structuralStop: null,
    primaryError: detail,
    cleanupError: null,
    evidenceCeiling: "structural",
    lookRequired: true,
    requiredReview: [state.currentReview],
    priorForeground: priorForegroundDisposition(state),
  };
}

function remainingRestorationMs(state: LocomotionState, dependencies: InAppLocomotionDependencies): number {
  const deadlineRemaining = Number((state.deadlineNs - checkedMonotonic(dependencies)) / 1_000_000n);
  return Math.floor(Math.min(deadlineRemaining, state.input.budgets.restorationReserveMs));
}

export function createInAppLocomotionOrchestrator(dependencies: InAppLocomotionDependencies) {
  const runs = new Map<string, LocomotionState>();
  const busyRuns = new Set<string>();
  const busySerials = new Set<string>();
  const preparingRoots = new Set<string>();

  const executePrepare = async (input: InAppLocomotionPrepareInput): Promise<LocomotionPrepareReceipt> => {
    let validation: Extract<ReceiptValidation, { status: "valid" }>;
    try {
      validation = assertReceiptAndSpec(input, dependencies);
    } catch (error) {
      return preparationFailure(error instanceof LocomotionStageError ? error.code : "preflight_failed", error, null, null, null);
    }
    if (preparingRoots.has(input.artifactRoot)) throw new Error("a prepare mutation is already in progress for this artifact root");
    preparingRoots.add(input.artifactRoot);
    let artifact: OwnedArtifactBinding | null = null;
    let runOwnedTarget = false;
    let prior: LocomotionPriorForegroundSnapshot = { component: null, packageName: null, userInstalled: false };
    let priorTerminatedByRun = false;
    try {
      const reserved = reserveArtifacts(input, dependencies);
      artifact = reserved.binding;
      const deadlineNs = reserved.startedAtNs + BigInt(input.budgets.maxDurationMs) * 1_000_000n;
      prior = await dependencies.snapshotPriorForeground({ serial: input.serial, targetPackage: input.scenario.packageName });
      expectedPrior(input, prior);
      await dependencies.stopPackage({ serial: input.serial, packageName: input.scenario.packageName, reason: "prepare_target_clearance" });
      if (prior.packageName && prior.packageName !== input.scenario.packageName) {
        await dependencies.stopPackage({ serial: input.serial, packageName: prior.packageName, reason: "prepare_declared_incumbent_clearance" });
      }
      priorTerminatedByRun = prior.packageName !== null;
      runOwnedTarget = true;
      const launch = await dependencies.launchTarget({ serial: input.serial, component: input.scenario.launchComponent });
      if (launch.disposition !== "accepted" || launch.component !== input.scenario.launchComponent || !SHA256.test(launch.outputSha256)) {
        throw new LocomotionStageError("launch_failed", "target launch did not return one exact accepted component acknowledgement");
      }
      const runtime = await dependencies.probeRuntimeBinding({
        serial: input.serial,
        scenario: input.scenario,
        expectedApkSha256: input.provenance.apkSha256,
      });
      validateRuntime(input, validation.receipt, runtime);
      const safety = await dependencies.sampleSafety({ serial: input.serial, phase: "prepare_baseline" });
      const unsafe = safetyProblem(safety);
      if (unsafe) throw new LocomotionStageError("safety_baseline_failed", `unsafe Full-stage baseline: ${unsafe}`);
      const capability = await dependencies.probeCapability({
        serial: input.serial,
        packageName: input.scenario.packageName,
        requestId: `prepare_capability_${artifact.runId.slice(0, 24)}`,
        tag: "prepare",
      });
      if (!capability.ok) throw new LocomotionStageError(capability.code, capability.primaryError ?? capability.detail, capability.cleanupError);
      const root = capability.ack.root;
      if (!root || root.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID || !Number.isSafeInteger(root.generation) || root.generation < 1) {
        throw new LocomotionStageError("capability_unavailable", "commands preflight did not bind one registered AgentWorldRoot generation");
      }
      const hmd = hmdPoseFrom(await dependencies.requestHmdPose({
        serial: input.serial,
        packageName: input.scenario.packageName,
        requestId: `prepare_hmd_pose_${artifact.runId.slice(0, 24)}`,
        tag: "prepare",
        expectedRootGeneration: root.generation,
      }), root.generation);
      const freshLaunchMonitor = await dependencies.monitorFreshLaunch({
        serial: input.serial,
        runId: artifact.runId,
        artifactRoot: artifact.absoluteRoot,
        minimumDurationMs: 60_000,
        runtime,
      });
      validateMonitor(freshLaunchMonitor, runtime);
      const baselinePath = path.join(artifact.absoluteRoot, "captures", "000-app-baseline.png");
      const captured = await dependencies.captureSettled({
        serial: input.serial,
        outPath: baselinePath,
        maxTries: input.capture.maxTries,
        intervalMs: input.capture.intervalMs,
        attemptTimeoutMs: input.capture.attemptTimeoutMs,
        deadlineMs: input.capture.deadlineMs,
        comparison: "byte_exact",
        mode: "stable",
      });
      const review = captureReview(captured, baselinePath, "app_baseline");
      dependencies.readReviewImage(review, artifact.absoluteRoot);
      const state: LocomotionState = {
        input,
        artifact,
        status: "prepared",
        receipt: validation.receipt,
        runtime,
        prior,
        priorTerminatedByRun,
        targetOwned: true,
        rootGeneration: root.generation,
        baselineHmd: hmd,
        currentReview: review,
        requiredReview: [review],
        retainedLogs: [],
        nextWaypoint: 0,
        startedAtNs: reserved.startedAtNs,
        deadlineNs,
        usage: { waypointAttempts: 0, successfulWaypoints: 0, routeDurationMs: 0 },
        restoreAttempted: false,
        restoreCompleted: false,
        adjudicated: false,
      };
      if (runs.has(artifact.runId)) throw new Error("run identifier collision");
      runs.set(artifact.runId, state);
      appendAction(artifact, {
        action: "prepare",
        status: "completed",
        runtime,
        receiptBinding: {
          receiptId: validation.receipt.receiptId,
          apkSha256: input.provenance.apkSha256,
          component: input.scenario.launchComponent,
        },
        safetyBaseline: safety,
        capability,
        hmdBaseline: hmd,
        freshLaunchMonitor,
        captureReceipt: captured.receipt,
        rootGeneration: root.generation,
        captureSha256: review.captureSha256,
      });
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
        applicationBinding: runtime.applicationBinding,
      };
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (error instanceof LocomotionStageError && error.cleanupError) cleanupErrors.push(error.cleanupError);
      if (runOwnedTarget) {
        try {
          await dependencies.stopPackage({ serial: input.serial, packageName: input.scenario.packageName, reason: "prepare_failure_cleanup" });
        } catch (cleanup) {
          cleanupErrors.push(errorText(cleanup));
        }
      }
      const cleanupError = cleanupErrors.length ? cleanupErrors.join("; ") : null;
      const code = error instanceof LocomotionStageError ? error.code : "preparation_failed";
      if (artifact) appendAction(artifact, { action: "prepare", status: "failed", structuralStop: code, primaryError: errorText(error), cleanupError });
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
    if (input.reviewedPriorFrame.captureSha256 !== state.currentReview.captureSha256) {
      return stepReviewFailure(state, "reviewed capture SHA does not match the exact current required frame");
    }
    try {
      dependencies.readReviewImage(state.currentReview, state.artifact.absoluteRoot);
    } catch (error) {
      return stepReviewFailure(state, `reviewed retained image failed its immutable sha256 check: ${errorText(error)}`);
    }
    assertStateArtifacts(state);
    const waypoint = state.input.route.waypoints[state.nextWaypoint];
    state.nextWaypoint += 1;
    state.usage.waypointAttempts += 1;
    const operationStarted = checkedMonotonic(dependencies);
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
    let captureReceipt: CaptureSettledReceipt | null = null;
    let postHmd: AgentBridgeHmdPose | null = null;
    let postSafety: LocomotionSafetySnapshot | null = null;
    let postContinuity: ApplicationContinuitySample | null = null;
    try {
      const initialRemainingMs = remainingRouteWorkMs(state, dependencies);
      if (initialRemainingMs <= state.input.capture.deadlineMs) {
        throw new LocomotionStageError("budget_exhausted", "route deadline cannot preserve the capture and restoration reserves");
      }
      await dependencies.emitMarker({ serial: state.input.serial, marker: beginMarker });
      began = true;
      preSafety = await dependencies.sampleSafety({ serial: state.input.serial, phase: `step_${waypoint.seq}_pre` });
      const preSafetyProblem = safetyProblem(preSafety);
      if (preSafetyProblem) throw new LocomotionStageError("safety_drift", `pre-step safety drift: ${preSafetyProblem}`);
      preContinuity = await dependencies.sampleContinuity({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_pre`,
        runtime: state.runtime,
        artifactRoot: state.artifact.absoluteRoot,
      });
      const preContinuityProblem = continuityProblem(preContinuity, state.runtime);
      if (preContinuityProblem) throw new LocomotionStageError("binding_lost", preContinuityProblem);
      preHmd = hmdPoseFrom(await dependencies.requestHmdPose({
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `step_${waypoint.seq}_pre_${state.artifact.runId.slice(0, 20)}`,
        tag: `step-${waypoint.seq}-pre`,
        expectedRootGeneration: state.rootGeneration,
      }), state.rootGeneration);
      if (translationDistance(state.baselineHmd.position, preHmd.position) > 0.02) {
        throw new LocomotionStageError("hmd_translation_drift", "pre-step Euclidean HMD translation drift exceeded exactly 0.02 m");
      }
      if (remainingRouteWorkMs(state, dependencies) <= state.input.capture.deadlineMs) {
        throw new LocomotionStageError("budget_exhausted", "route budget was exhausted before locomotion mutation");
      }
      const rootBefore = state.rootGeneration;
      locomotion = await dependencies.requestLocomotion({
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `step_${waypoint.seq}_move_${state.artifact.runId.slice(0, 20)}`,
        tag: `step-${waypoint.seq}`,
        mode: state.input.mechanism,
        target: { x: waypoint.target.x, y: waypoint.target.y, z: waypoint.target.z },
        rootGeneration: rootBefore,
        glideDurationMs: state.input.route.glideDurationMs,
        physicalWalk: false,
      });
      if (!locomotion.ok) {
        if (locomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${locomotion.cleanupError}`);
        throw new LocomotionStageError(locomotion.code, locomotion.primaryError ?? locomotion.detail);
      }
      const expectedGeneration = state.input.mechanism === "replacement" ? rootBefore + 1 : rootBefore;
      const ack = locomotion.ack;
      if (ack.mode !== state.input.mechanism || ack.target.absolute !== true || !samePosition(ack.target, waypoint.target)
        || ack.rootGenerationBefore !== rootBefore || ack.pose === null || ack.pose.rootGeneration !== expectedGeneration
        || !samePosition(ack.pose.position, waypoint.target) || ack.physicalWalk !== false) {
        throw new LocomotionStageError("root_readback_mismatch", "locomotion acknowledgement lost exact mechanism/target/root-generation readback binding");
      }
      state.rootGeneration = expectedGeneration;
      const captureRemainingMs = remainingRouteWorkMs(state, dependencies);
      if (captureRemainingMs < 1) throw new LocomotionStageError("budget_exhausted", "route budget was exhausted before transition capture");
      const capturePath = path.join(state.artifact.absoluteRoot, "captures", `${String(waypoint.seq).padStart(3, "0")}-waypoint.png`);
      const captured = await dependencies.captureSettled({
        serial: state.input.serial,
        outPath: capturePath,
        maxTries: state.input.capture.maxTries,
        intervalMs: state.input.capture.intervalMs,
        attemptTimeoutMs: Math.min(state.input.capture.attemptTimeoutMs, captureRemainingMs),
        deadlineMs: Math.min(state.input.capture.deadlineMs, captureRemainingMs),
        comparison: "byte_exact",
        mode: "transition_then_stable",
        priorSha256: state.currentReview.captureSha256,
      });
      captureReceipt = captured.receipt;
      if (captured.receipt.status !== "settled") {
        throw new LocomotionStageError(captured.receipt.error?.code ?? "route_unsettled", captured.receipt.error?.detail ?? "transition capture did not settle");
      }
      capturedReview = captureReview(captured, capturePath, "waypoint", waypoint.seq);
      postHmd = hmdPoseFrom(await dependencies.requestHmdPose({
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `step_${waypoint.seq}_post_${state.artifact.runId.slice(0, 20)}`,
        tag: `step-${waypoint.seq}-post`,
        expectedRootGeneration: state.rootGeneration,
      }), state.rootGeneration);
      drift = driftReceipt(state.baselineHmd, preHmd, postHmd);
      postSafety = await dependencies.sampleSafety({ serial: state.input.serial, phase: `step_${waypoint.seq}_post` });
      const postSafetyProblem = safetyProblem(postSafety);
      if (postSafetyProblem) throw new LocomotionStageError("safety_drift", `post-step safety drift: ${postSafetyProblem}`);
      postContinuity = await dependencies.sampleContinuity({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_post`,
        runtime: state.runtime,
        artifactRoot: state.artifact.absoluteRoot,
      });
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
    } finally {
      if (began) {
        try {
          await dependencies.emitMarker({ serial: state.input.serial, marker: endMarker });
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
            timeoutMs: Math.max(1, Math.min(10_000, remainingRouteWorkMs(state, dependencies))),
          }), logPath);
          const identity = artifactFileIdentity(collectedLog.path, "retained step log", 64 * 1024 * 1024);
          state.retainedLogs.push({ path: collectedLog.path, identity });
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
    const operationEnded = checkedMonotonic(dependencies);
    const durationMs = Math.max(0, Number((operationEnded - operationStarted) / 1_000_000n));
    state.usage.routeDurationMs += durationMs;
    if (capturedReview && capturedReviewValidated) {
      state.currentReview = capturedReview;
      state.requiredReview.push(capturedReview);
    }
    const succeeded = primaryError === null && cleanupErrors.length === 0 && capturedReviewValidated && drift !== null;
    if (succeeded) {
      state.status = "stepped";
      state.usage.successfulWaypoints += 1;
    } else {
      state.status = "stopped";
    }
    const structuralStop = succeeded ? null : primaryCode ?? "step_cleanup_failed";
    appendAction(state.artifact, {
      action: "step",
      waypointSeq: waypoint.seq,
      status: succeeded ? "completed" : "stopped",
      structuralStop,
      primaryError,
      cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
      rootGeneration: state.rootGeneration,
      captureSha256: capturedReview?.captureSha256 ?? null,
      waypointAttempts: state.usage.waypointAttempts,
      usage: state.usage,
      pre: { safety: preSafety, continuity: preContinuity, hmdPose: preHmd },
      locomotion,
      captureReceipt,
      post: { hmdPose: postHmd, safety: postSafety, continuity: postContinuity },
      hmdDrift: drift,
      logEvidence,
    });
    return {
      status: succeeded
        ? state.nextWaypoint >= state.input.route.waypoints.length ? "route_complete_needs_restore" : "needs_waypoint_review"
        : "stopped",
      runId: state.artifact.runId,
      artifactRoot: state.artifact.absoluteRoot,
      waypointSeq: waypoint.seq,
      rootGeneration: state.rootGeneration,
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
    try {
      dependencies.readReviewImage(state.currentReview, state.artifact.absoluteRoot);
    } catch (error) {
      return restoreReviewFailure(state, `reviewed retained image failed its immutable sha256 check: ${errorText(error)}`);
    }
    assertStateArtifacts(state);
    state.restoreAttempted = true;
    let primaryError: string | null = null;
    let primaryCode: string | null = null;
    const cleanupErrors: string[] = [];
    let restoredReview: LocomotionReviewItem | null = null;
    let locomotion: LocomotionResult | null = null;
    let captureReceipt: CaptureSettledReceipt | null = null;
    let postStopSafety: LocomotionSafetySnapshot | null = null;
    const priorDisposition = priorForegroundDisposition(state);
    try {
      const remainingMs = remainingRestorationMs(state, dependencies);
      if (remainingMs <= state.input.capture.deadlineMs) {
        throw new LocomotionStageError("budget_exhausted", "restoration deadline cannot fit the required transition-stable capture");
      }
      const rootBefore = state.rootGeneration;
      locomotion = await dependencies.requestLocomotion({
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `restore_move_${state.artifact.runId.slice(0, 20)}`,
        tag: "restore",
        mode: state.input.mechanism,
        target: { x: 0, y: 0, z: 0 },
        rootGeneration: rootBefore,
        glideDurationMs: state.input.route.glideDurationMs,
        physicalWalk: false,
      });
      if (!locomotion.ok) {
        if (locomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${locomotion.cleanupError}`);
        throw new LocomotionStageError(locomotion.code, locomotion.primaryError ?? locomotion.detail);
      }
      const expectedGeneration = state.input.mechanism === "replacement" ? rootBefore + 1 : rootBefore;
      const ack = locomotion.ack;
      if (ack.mode !== state.input.mechanism || ack.target.absolute !== true
        || !samePosition(ack.target, state.input.route.restoreTarget)
        || ack.rootGenerationBefore !== rootBefore || ack.pose === null
        || ack.pose.rootGeneration !== expectedGeneration
        || !samePosition(ack.pose.position, state.input.route.restoreTarget)
        || ack.physicalWalk !== false) {
        throw new LocomotionStageError("root_readback_mismatch", "restore acknowledgement lost exact mechanism/zero-target/root-generation readback binding");
      }
      state.rootGeneration = expectedGeneration;
      const captureRemainingMs = remainingRestorationMs(state, dependencies);
      if (captureRemainingMs < 1) throw new LocomotionStageError("budget_exhausted", "restoration deadline expired before capture");
      const capturePath = path.join(state.artifact.absoluteRoot, "captures", "999-restored.png");
      const captured = await dependencies.captureSettled({
        serial: state.input.serial,
        outPath: capturePath,
        maxTries: state.input.capture.maxTries,
        intervalMs: state.input.capture.intervalMs,
        attemptTimeoutMs: Math.min(state.input.capture.attemptTimeoutMs, captureRemainingMs),
        deadlineMs: Math.min(state.input.capture.deadlineMs, captureRemainingMs),
        comparison: "byte_exact",
        mode: "transition_then_stable",
        priorSha256: state.currentReview.captureSha256,
      });
      captureReceipt = captured.receipt;
      if (captured.receipt.status !== "settled") {
        throw new LocomotionStageError(captured.receipt.error?.code ?? "restoration_unsettled", captured.receipt.error?.detail ?? "restoration capture did not settle");
      }
      const candidateReview = captureReview(captured, capturePath, "recovery");
      dependencies.readReviewImage(candidateReview, state.artifact.absoluteRoot);
      restoredReview = candidateReview;
      state.currentReview = candidateReview;
      state.requiredReview.push(candidateReview);
    } catch (error) {
      primaryError = errorText(error);
      primaryCode = error instanceof LocomotionStageError ? error.code : "restore_failed";
      if (error instanceof LocomotionStageError && error.cleanupError) {
        cleanupErrors.push(`bridge acknowledgement cleanup: ${error.cleanupError}`);
      }
    } finally {
      if (state.targetOwned) {
        state.targetOwned = false;
        try {
          await dependencies.stopPackage({
            serial: state.input.serial,
            packageName: state.input.scenario.packageName,
            reason: "restore_run_owned_target",
          });
        } catch (error) {
          cleanupErrors.push(`owned target stop: ${errorText(error)}`);
        }
      }
      try {
        postStopSafety = await dependencies.sampleSafety({ serial: state.input.serial, phase: "restore_after_target_stop" });
        const unsafe = safetyProblem(postStopSafety);
        if (unsafe) cleanupErrors.push(`post-restore safety: ${unsafe}`);
      } catch (error) {
        cleanupErrors.push(`post-restore safety: ${errorText(error)}`);
      }
      if (state.input.priorForeground.kind === "non_receipt_bound") {
        try {
          const relaunched = await dependencies.relaunchPrior({
            serial: state.input.serial,
            component: state.input.priorForeground.component,
          });
          if (relaunched.component !== state.input.priorForeground.component) {
            cleanupErrors.push("prior relaunch returned a substituted component");
          } else {
            priorDisposition.relaunchDisposition = relaunched.disposition;
            if (relaunched.disposition !== "accepted") cleanupErrors.push(`prior relaunch was ${relaunched.disposition}`);
          }
        } catch (error) {
          priorDisposition.relaunchDisposition = "attempt_failed";
          cleanupErrors.push(`prior relaunch: ${errorText(error)}`);
        }
      }
    }
    const completed = primaryError === null && cleanupErrors.length === 0 && restoredReview !== null;
    state.restoreCompleted = completed;
    state.status = completed ? "restored" : "stopped";
    const structuralStop = completed ? null : primaryCode ?? "restore_cleanup_failed";
    appendAction(state.artifact, {
      action: "restore",
      status: completed ? "completed" : "failed",
      structuralStop,
      primaryError,
      cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
      rootGeneration: state.rootGeneration,
      captureSha256: restoredReview?.captureSha256 ?? null,
      locomotion,
      captureReceipt,
      postStopSafety,
      priorForeground: priorDisposition,
    });
    return {
      status: completed ? "restored_needs_review" : "restore_failed",
      runId: state.artifact.runId,
      artifactRoot: state.artifact.absoluteRoot,
      rootGeneration: state.rootGeneration,
      structuralStop,
      primaryError,
      cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
      evidenceCeiling: "structural",
      lookRequired: true,
      requiredReview: restoredReview ? [restoredReview] : [state.currentReview],
      priorForeground: priorDisposition,
    };
  };

  const adjudicationRejected = (state: LocomotionState, detail: string): LocomotionAdjudicateReceipt => ({
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
    assertStateArtifacts(state);
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
    appendAction(state.artifact, {
      action: "adjudicate",
      status: "structural_complete",
      captureCount: frames.length,
      captureSha256: frames.map((frame) => frame.captureSha256),
      evidenceCeiling: "structural",
      reviewDisposition: "eligible_for_external_vision_adjudication",
    });
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
    };
  };

  const execute = async (rawInput: InAppLocomotionInput): Promise<Record<string, any>> => {
    const input = inAppLocomotionInputSchema.parse(rawInput);
    if (input.action === "prepare") {
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
    if (busySerials.has(state.input.serial)) throw new Error(`a mutation is already in progress for exact serial '${state.input.serial}'`);
    busyRuns.add(input.runId);
    busySerials.add(state.input.serial);
    try {
      if (input.action === "step") return await executeStep(input, state);
      if (input.action === "restore") return await executeRestore(input, state);
      return await executeAdjudicate(input, state);
    } finally {
      busyRuns.delete(input.runId);
      busySerials.delete(state.input.serial);
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

function configurationValue(output: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const values = output.split(/\r?\n/).flatMap((line) => {
    const match = new RegExp(`(?:^|\\s)${escaped}\\s*[=:]\\s*(\\S+)`).exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw new Error(`ConfigurationService did not expose one exact '${key}' value`);
  return unique[0];
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

interface LiveContinuityCursor {
  sessionId: string;
  priorSeq: number | null;
  watchdogPrior: { focus: string; lastRenderTime: string } | null;
}

/**
 * Construct the production device adapter. Merely importing this module is inert: adb resolution
 * happens only when a caller explicitly requests live dependencies (or registers without fakes).
 */
export function createLiveInAppLocomotionDependencies(): InAppLocomotionDependencies {
  const adb = resolveAdb();
  const continuityCursors = new Map<string, LiveContinuityCursor>();
  const checked = async (
    serial: string,
    args: string[],
    label: string,
    timeoutMs = 15_000,
    maxOutputBytes = 8 * 1024 * 1024,
  ): Promise<string> => {
    requireExactLiveSerial(serial);
    return checkedLiveAdbResult(await run(adb, ["-s", serial, ...args], { timeoutMs, maxOutputBytes }), label);
  };
  const checkedAlreadySerialized = async (
    serial: string,
    args: string[],
    timeoutMs: number,
    label: string,
  ): Promise<string> => {
    requireExactLiveSerial(serial);
    if (args[0] !== "-s" || args[1] !== serial) throw new Error(`${label} lost exact serial qualification`);
    return checkedLiveAdbResult(await run(adb, args, { timeoutMs, maxOutputBytes: 8 * 1024 * 1024 }), label);
  };

  const sampleSafetyLive = async (context: { serial: string; phase: string }): Promise<LocomotionSafetySnapshot> => {
    const guardian = await checked(context.serial, ["shell", "getprop", "sys.guardian.vst.status"], `${context.phase} Guardian probe`, 10_000, 64 * 1024);
    const vstComponent = await checked(context.serial, ["shell", "getprop", "sys.pxr.vst.comp.state"], `${context.phase} VST component probe`, 10_000, 64 * 1024);
    const vstDebug = await checked(context.serial, ["shell", "getprop", "persist.pxr.see.vst.debug.enable"], `${context.phase} VST debug probe`, 10_000, 64 * 1024);
    const configuration = await checked(context.serial, ["shell", "dumpsys", "ConfigurationService"], `${context.phase} Full-stage configuration probe`, 15_000);
    return {
      guardian,
      vstComponent,
      vstDebug,
      stageStyle: configurationValue(configuration, "spatial_stage_style"),
      safeguard: configurationValue(configuration, "spatial_safeguard_enable"),
      safeguardCenter: configurationValue(configuration, "spatial_safeguard_center"),
      virtualContent: configurationValue(configuration, "spatial_virtual_content_detected"),
    };
  };

  const sampleContinuityLive = async (context: {
    serial: string;
    phase: string;
    runtime: LocomotionRuntimeBinding;
    artifactRoot: string;
  }): Promise<ApplicationContinuitySample> => {
    requireExactLiveSerial(context.serial);
    if (context.runtime.liveIdentity.serial !== context.serial) throw new Error("continuity runtime is bound to another serial");
    let cursor = continuityCursors.get(context.artifactRoot);
    if (!cursor) {
      cursor = {
        sessionId: `worldlocomotion_${sha256Bytes(Buffer.from(context.artifactRoot)).slice(0, 32)}`,
        priorSeq: null,
        watchdogPrior: null,
      };
      continuityCursors.set(context.artifactRoot, cursor);
    }
    const binding = context.runtime.applicationBinding;
    const sample = await sampleApplicationContinuity({
      adbPath: adb,
      binding: {
        serial: context.serial,
        bootId: context.runtime.liveIdentity.bootId,
        packageName: binding.packageName,
        apkSha256: binding.apkSha256,
        pid: binding.pid,
        pidStartTicks: binding.pidStartTicks,
        allowedResumedComponents: [...binding.allowedResumedComponents],
      },
      probe: { sessionId: cursor.sessionId, generation: 1, priorSeq: cursor.priorSeq },
      watchdogPrior: cursor.watchdogPrior,
    }, {
      runText: async (command, args, options) => {
        if (command !== adb || args[0] !== "-s" || args[1] !== context.serial) {
          throw new Error("continuity dependency attempted an unqualified or substituted adb command");
        }
        return run(command, args, options);
      },
      readLogLines: async () => {
        const result = await run(adb, ["-s", context.serial, "logcat", "-b", "all", "-d", "-v", "threadtime"], {
          timeoutMs: 8_000,
          maxOutputBytes: 8 * 1024 * 1024,
        });
        if (result.code !== 0 || result.timedOut) return { lines: [], truncated: true };
        return { lines: result.stdout.split(/\r?\n/).filter(Boolean), truncated: false };
      },
      monotonicNs: () => process.hrtime.bigint(),
    });
    const ownedEvents = sample.probeEventsSincePrior.filter((event) => event.sessionId === cursor!.sessionId && event.generation === 1);
    if (ownedEvents.length) cursor.priorSeq = ownedEvents.at(-1)!.seq;
    if (sample.watchdog.focus && sample.watchdog.lastRenderTime) {
      cursor.watchdogPrior = { focus: sample.watchdog.focus, lastRenderTime: sample.watchdog.lastRenderTime };
    }
    return sample;
  };

  const runtimeHealthSnapshot = async (context: {
    serial: string;
    artifactRoot: string;
    marker: string;
    sampleIndex: number;
    packageName: string;
    pid: number;
  }): Promise<PackageRuntimeHealthReceiptV1> => {
    const output = await checked(context.serial, ["logcat", "-b", "all", "-d", "-v", "threadtime"], "fresh-launch runtime-health snapshot", 10_000, 64 * 1024 * 1024);
    const artifactPath = path.join(context.artifactRoot, "logs", `fresh-launch-${String(context.sampleIndex).padStart(2, "0")}.log`);
    privateWrite(artifactPath, output.length ? `${output}\n` : "");
    const bytes = fs.readFileSync(artifactPath);
    const receipt: RuntimeLogSnapshotReceipt = {
      status: "snapshot_collected",
      truncated: false,
      observedBytes: bytes.length,
      appStartMarker: context.marker,
      appStartMarkerObserved: bytes.includes(Buffer.from(context.marker, "utf8")),
      rawArtifact: { path: fs.realpathSync(artifactPath), sha256: sha256Bytes(bytes), bytes: bytes.length },
    };
    return scanPackageRuntimeHealth(receipt, context.packageName, [context.pid]);
  };

  return {
    randomBytes: (size) => crypto.randomBytes(size),
    now: () => new Date().toISOString(),
    monotonicNs: () => process.hrtime.bigint(),
    readNativeRunReceipt,
    readEffectiveAppSpec: readReceiptBoundEffectiveAppSpec,
    snapshotPriorForeground: async ({ serial }) => {
      const activityOutput = await checked(serial, ["shell", "dumpsys", "activity", "activities"], "prior foreground activity snapshot", 20_000);
      const resumedPackages = parseResumedPackages(activityOutput);
      const thirdPartyPackages = parseThirdPartyPackages(await checked(
        serial,
        ["shell", "pm", "list", "packages", "-3"],
        "prior foreground third-party inventory",
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
    stopPackage: async ({ serial, packageName, reason }) => {
      await checked(serial, ["shell", "am", "force-stop", packageName], `${reason} force-stop ${packageName}`, 10_000, 64 * 1024);
      return { status: "stop_command_completed", serial, packageName, reason };
    },
    launchTarget: async ({ serial, component }) => {
      requireExactLiveSerial(serial);
      const result = await run(adb, ["-s", serial, "shell", "am", "start", "-W", "-n", component], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      return {
        disposition: classifyActivityLaunchDisposition(output, result.code === 0 && !result.timedOut),
        component,
        outputSha256: sha256Bytes(Buffer.from(output, "utf8")),
      };
    },
    probeRuntimeBinding: async ({ serial, scenario }) => {
      const liveIdentity = await probeBoundedCaptureIdentity(
        serial,
        (capMs) => capMs,
        (args, timeoutMs, label) => checkedAlreadySerialized(serial, args, timeoutMs, label),
      );
      const installedPath = parseInstalledApkPath(await checked(serial, ["shell", "pm", "path", scenario.packageName], "installed APK path", 10_000));
      if (!installedPath) throw new Error("installed APK path is missing or ambiguous");
      const digestOutput = await checked(serial, ["shell", "toybox", "sha256sum", installedPath], "installed APK sha256", 10_000);
      const digestLines = digestOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const apkSha256 = parseRemoteSha256(digestOutput);
      if (!apkSha256 || digestLines.length !== 1 || !digestLines[0].endsWith(` ${installedPath}`)) {
        throw new Error("installed APK digest did not bind the exact installed path");
      }
      const pid = parsePid(await checked(serial, ["shell", "pidof", scenario.packageName], "target PID", 10_000));
      if (pid === null) throw new Error("target PID is missing or ambiguous");
      const pidStartTicks = parseProcStartTicks(await checked(serial, ["shell", "cat", `/proc/${pid}/stat`], "target process start ticks", 10_000));
      if (pidStartTicks === null) throw new Error("target process start ticks are missing");
      const activities = parseForegroundActivities(await checked(serial, ["shell", "dumpsys", "activity", "activities"], "target foreground binding", 20_000));
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
    probeCapability: (input) => probeAgentBridgeLocomotionCapability(adb, input),
    requestHmdPose: (input) => requestAgentBridgeHmdPose(adb, input),
    monitorFreshLaunch: async (context) => {
      const marker = `PICO_LOCOMOTION_${context.runId.slice(0, 16)}_FRESH_LAUNCH`;
      await checked(context.serial, ["shell", "log", "-t", "WorldLocomotion", marker], "fresh-launch monitor marker", 5_000, 64 * 1024);
      const startedNs = process.hrtime.bigint();
      const samples: FreshLaunchMonitorSample[] = [];
      for (const [sampleIndex, targetElapsedMs] of [0, 15_000, 30_000, 45_000, 60_000].entries()) {
        const beforeSleepMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
        if (beforeSleepMs < targetElapsedMs) await sleep(targetElapsedMs - beforeSleepMs);
        const elapsedMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
        const windowState = await checked(context.serial, ["shell", "dumpsys", "window", "windows"], "fresh-launch dialog probe", 10_000);
        const dialogs = windowState.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
          /Application Error|isn't responding|has stopped|(?:^|\s)ANR(?:\s|$)|mCurrentFocus=.*(?:Dialog|Error)/i.test(line));
        const safety = await sampleSafetyLive({ serial: context.serial, phase: `fresh_launch_${sampleIndex}` });
        const continuity = await sampleContinuityLive({
          serial: context.serial,
          phase: `fresh_launch_${sampleIndex}`,
          runtime: context.runtime,
          artifactRoot: context.artifactRoot,
        });
        const runtimeHealth = await runtimeHealthSnapshot({
          serial: context.serial,
          artifactRoot: context.artifactRoot,
          marker,
          sampleIndex,
          packageName: context.runtime.applicationBinding.packageName,
          pid: context.runtime.applicationBinding.pid,
        });
        samples.push({ elapsedMs, dialogs, safety, continuity, runtimeHealth });
      }
      return { durationMs: Number((process.hrtime.bigint() - startedNs) / 1_000_000n), samples };
    },
    captureSettled: (input) => executeLiveCaptureSettled(input, { adbPath: adb }),
    readReviewImage: readBoundReviewImage,
    sampleContinuity: sampleContinuityLive,
    requestLocomotion: (input) => requestAgentBridgeLocomotion(adb, input),
    emitMarker: async ({ serial, marker }) => {
      await checked(serial, ["shell", "log", "-t", "WorldLocomotion", marker], `locomotion marker ${marker}`, 5_000, 64 * 1024);
    },
    collectStepLogs: async (context) => {
      requireExactLiveSerial(context.serial);
      const result = await run(adb, ["-s", context.serial, "logcat", "-b", "all", "-d", "-v", "threadtime"], {
        timeoutMs: context.timeoutMs,
        maxOutputBytes: 64 * 1024 * 1024,
      });
      const allLines = result.stdout.split(/\r?\n/).filter(Boolean);
      const beginIndexes = allLines.flatMap((line, index) => line.includes(context.beginMarker) ? [index] : []);
      const endIndexes = allLines.flatMap((line, index) => line.includes(context.endMarker) ? [index] : []);
      const completeWindow = beginIndexes.length === 1 && endIndexes.length === 1 && endIndexes[0] >= beginIndexes[0];
      const selectedLines = completeWindow ? allLines.slice(beginIndexes[0], endIndexes[0] + 1) : allLines;
      const bytes = Buffer.from(selectedLines.length ? `${selectedLines.join("\n")}\n` : "", "utf8");
      privateWrite(context.path, bytes);
      const retained = fs.readFileSync(context.path);
      const text = retained.toString("utf8");
      return {
        path: fs.realpathSync(context.path),
        sha256: sha256Bytes(retained),
        bytes: retained.length,
        truncated: result.code !== 0 || result.timedOut || !completeWindow,
        beginCount: countMatches(text, new RegExp(context.beginMarker, "g")),
        endCount: countMatches(text, new RegExp(context.endMarker, "g")),
        boundarySignals: {
          setSpatialContainerBoundary: countMatches(text, /setSpatialContainerBoundary/gi),
          containerInfoChanged: countMatches(text, /(?:on)?SpatialContainerInfoChanged/gi),
          boundaryMin: countMatches(text, /boundaryMin/gi),
          launcherResume: countMatches(text, /com\.(?:pvr|pxr)\.[A-Za-z0-9_.]*(?:launcher|home)[A-Za-z0-9_.\/]*.*(?:onResume|ON_RESUME|ResumedActivity)/gi),
          appPauseOrEjection: countMatches(text, new RegExp(`${context.packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*(?:ON_PAUSE|ON_STOP|onPause|onStop|eject)`, "gi")),
        },
      };
    },
    relaunchPrior: async ({ serial, component }) => {
      requireExactLiveSerial(serial);
      const result = await run(adb, ["-s", serial, "shell", "am", "start", "-W", "-n", component], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      return { disposition: classifyActivityLaunchDisposition(output, result.code === 0 && !result.timedOut), component };
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
