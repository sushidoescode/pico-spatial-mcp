import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completeDependencies } from "./dependencies.js";
import {
  AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY,
  AGENT_BRIDGE_LOCOMOTION_ROOT_ID,
  AgentBridgeLocomotionNonceCleanupError,
  agentBridgeLocomotionMinimumEnvelopeMs,
  probeAgentBridgeLocomotionCapability,
  requestAgentBridgeHmdPose,
  requestAgentBridgeLocomotion,
  cleanupAgentBridgeLocomotionNonce,
  type AgentBridgeHmdPose,
  type AgentBridgeHmdPoseRequestInput,
  type AgentBridgeLocomotionAck,
  type AgentBridgeLocomotionNonceCleanupReceipt,
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
import { bindMacQemuWindow, frontmostQemu, type BoundQemuWindow, type QemuWindowBindingResult } from "./cameradrive.js";
import { hostWindowPrecondition, probeHostWindow, unavailableHostWindowProbe, type HostWindowProbe } from "./hostwindow.js";
import {
  parseForegroundActivities,
  parseInstalledApkPath,
  parsePid,
  parseProcStartTicks,
  parseRemoteSha256,
} from "./nativefleetreceipt.js";
import type { BoundApplicationIdentity, ReservedArtifactSession } from "./navigation.js";
import {
  CAPTURE_SOURCE,
  executeLiveCaptureSettled,
  resolveProspectivePath,
  sha256Bytes,
  type CaptureSettledInput,
  type CaptureSettledReceipt,
} from "./observation.js";
import { validateCaptureBuffer } from "./evidence.js";
import { canonicalJson } from "./runreceiptidentity.js";
import { readNativeRunReceipt } from "./runreceiptstore.js";
import {
  APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS,
  classifyResumedApplication,
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
const BRIDGE_STABILITY_READS = 2;
const BRIDGE_MIN_TRANSACTION_MS = agentBridgeLocomotionMinimumEnvelopeMs({
  maxPolls: BRIDGE_MAX_POLLS,
  pollMs: BRIDGE_POLL_MS,
  stabilityReads: BRIDGE_STABILITY_READS,
  executionDelayMs: 0,
});
// Bounded host-orchestration windows for final recovery. These are not SDK
// latency guarantees; each stage owns its window so one slow cleanup cannot
// consume the proof or action-publication window that follows it.
const FINAL_TARGET_STOP_RESERVE_MS = 5_000;
const FINAL_PROCESS_PROOF_RESERVE_MS = 5_000;
const FINAL_PRIOR_RELAUNCH_RESERVE_MS = 5_000;
const FINAL_SAFETY_RESERVE_MS = 5_000;
const FINAL_ACTION_PUBLICATION_RESERVE_MS = 5_000;
const PREPARE_ACTION_PUBLICATION_RESERVE_MS = 5_000;
/** CP2 experiment threshold, not an SDK freshness guarantee. */
export const IN_APP_LOCOMOTION_HMD_MAX_SAMPLE_AGE_MS = 250 as const;
const HMD_ACQUISITION_MAX_ATTEMPTS = 12;
const HMD_ACQUISITION_POLL_MS = 100;
// Retry cadence and quick completed transactions share 1.5s; the final transaction
// retains its existing minimum envelope. This is an observation policy, not SDK timing.
const HMD_ACQUISITION_WINDOW_MS = BRIDGE_MIN_TRANSACTION_MS + 1_500;
// Failure-safe stage allowances, not SDK timing guarantees. They keep each
// mandatory post-mutation proof independently admissible under one fixed step deadline.
const POST_HMD_SAFETY_RESERVE_MS = 5_000;
const STEP_BEGIN_MARKER_RESERVE_MS = 5_000;
const STEP_PRE_SAFETY_RESERVE_MS = 5_000;
const STEP_END_MARKER_RESERVE_MS = 5_000;
const STEP_LOG_FINALIZATION_RESERVE_MS = 10_000;
const STEP_ACTION_PUBLICATION_RESERVE_MS = 5_000;
const RESTORE_ENTRY_VALIDATION_RESERVE_MS = 5_000;
// Keep clock re-sampling/flooring at one stage from consuming the next stage's
// admitted window. These are host-orchestration guards, not SDK latency claims.
const STAGE_HANDOFF_GUARD_MS = 1;
const CAPTURE_COMPLETION_GUARD_MS = 1;
const STEP_FINALIZATION_RESERVE_MS = STEP_END_MARKER_RESERVE_MS + STAGE_HANDOFF_GUARD_MS
  + STEP_LOG_FINALIZATION_RESERVE_MS + STAGE_HANDOFF_GUARD_MS;
const POST_HMD_DOWNSTREAM_RESERVE_MS = POST_HMD_SAFETY_RESERVE_MS + STAGE_HANDOFF_GUARD_MS
  + APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS + STAGE_HANDOFF_GUARD_MS + STEP_FINALIZATION_RESERVE_MS;
const NONCE_CLEANUP_RESERVE_MS = 1_000 + BRIDGE_STABILITY_READS * 250
  + (BRIDGE_STABILITY_READS - 1) * BRIDGE_POLL_MS + 1_000 + 250;

function routeMutationFloorMs(captureDeadlineMs: number, glideDurationMs: number): number {
  return captureDeadlineMs + glideDurationMs + BRIDGE_MIN_TRANSACTION_MS + NONCE_CLEANUP_RESERVE_MS
    + 2 * HMD_ACQUISITION_WINDOW_MS + CAPTURE_COMPLETION_GUARD_MS
    + 4 * STAGE_HANDOFF_GUARD_MS + POST_HMD_DOWNSTREAM_RESERVE_MS;
}

function routeStepFloorMs(captureDeadlineMs: number, glideDurationMs: number): number {
  return STEP_BEGIN_MARKER_RESERVE_MS + STAGE_HANDOFF_GUARD_MS
    + STEP_PRE_SAFETY_RESERVE_MS + STAGE_HANDOFF_GUARD_MS
    + APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS + STAGE_HANDOFF_GUARD_MS
    + routeMutationFloorMs(captureDeadlineMs, glideDurationMs)
    + STEP_ACTION_PUBLICATION_RESERVE_MS + STAGE_HANDOFF_GUARD_MS;
}

function restorationFloorMs(captureDeadlineMs: number, glideDurationMs: number): number {
  return RESTORE_ENTRY_VALIDATION_RESERVE_MS + STAGE_HANDOFF_GUARD_MS
    + captureDeadlineMs + glideDurationMs + 3 * BRIDGE_MIN_TRANSACTION_MS
    + 2 * NONCE_CLEANUP_RESERVE_MS + 2 * APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS
    + FINAL_TARGET_STOP_RESERVE_MS + 2 * FINAL_PROCESS_PROOF_RESERVE_MS
    + FINAL_PRIOR_RELAUNCH_RESERVE_MS + FINAL_SAFETY_RESERVE_MS
    + FINAL_ACTION_PUBLICATION_RESERVE_MS + CAPTURE_COMPLETION_GUARD_MS
    + 13 * STAGE_HANDOFF_GUARD_MS;
}

function postPreHmdReserveMs(captureDeadlineMs: number, glideDurationMs: number): number {
  return routeMutationFloorMs(captureDeadlineMs, glideDurationMs) - HMD_ACQUISITION_WINDOW_MS;
}

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
]).describe("Declare the foreground displaced by prepare. A receipt-bound prior is withheld and is not relaunched because relaunch would orphan its immutable receipt; only a declared non-receipt-bound prior from a different package than the run-owned target may be relaunched during restore.");

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
  if (value.priorForeground.kind === "non_receipt_bound"
    && value.priorForeground.component.startsWith(`${value.scenario.packageName}/`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["priorForeground", "component"],
      message: "a non-receipt-bound prior must use a different package from the run-owned target",
    });
  }
  const prepareBudgetMs = value.budgets.maxDurationMs
    - value.budgets.routeReserveMs
    - value.budgets.restorationReserveMs;
  if (prepareBudgetMs <= 60_001 + value.capture.deadlineMs + 2 * BRIDGE_MIN_TRANSACTION_MS
    + HMD_ACQUISITION_WINDOW_MS + PREPARE_ACTION_PUBLICATION_RESERVE_MS + STAGE_HANDOFF_GUARD_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "maxDurationMs"],
      message: "prepare budget cannot fit bounded capability/HMD/post-capture-capability transactions, the mandatory >=60 second monitor, baseline capture, and action publication before reserves",
    });
  }
  if (value.budgets.routeReserveMs <= value.capture.deadlineMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "routeReserveMs"],
      message: "route reserve must exceed one complete settled-capture deadline",
    });
  }
  if (value.budgets.routeReserveMs <= routeStepFloorMs(value.capture.deadlineMs, value.route.glideDurationMs)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "routeReserveMs"],
      message: "route reserve cannot fit the admitted glide, bounded HMD acquisitions, nonce cleanup, settled capture, post probes, final evidence closure, and action publication",
    });
  }
  if (value.budgets.restorationReserveMs <= value.capture.deadlineMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "restorationReserveMs"],
      message: "restoration reserve must exceed one complete settled-capture deadline",
    });
  }
  if (value.budgets.restorationReserveMs <= restorationFloorMs(value.capture.deadlineMs, value.route.glideDurationMs)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "restorationReserveMs"],
      message: "restoration reserve cannot fit pre/post continuity and capability, admitted glide, locomotion nonce cleanup, settled capture, and final recovery proof",
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
  windowProbeStartedAtMonotonicNs: string;
  windowRetainedAtMonotonicNs: string;
  windowHandoffToken: string;
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

export interface FreshLaunchMonitorHandoff {
  rawWindowDump: LocomotionRawLogEvidence;
  probeStartedAtMonotonicNs: string;
  retainedAtMonotonicNs: string;
  handoffToken: string;
}

export interface FreshLaunchHandoffObservationSample {
  elapsedMs: number;
  observedAtMonotonicNs: string;
  dialogs: string[];
  rawWindowDump: LocomotionRawLogEvidence;
}

export interface FreshLaunchHandoffObservationReceipt {
  claim: "no_blocking_dialog_at_retained_samples";
  maxSampleGapMs: number;
  startedAtMonotonicNs: string;
  endedAtMonotonicNs: string;
  samples: FreshLaunchHandoffObservationSample[];
  rawWindowDumps: LocomotionRawLogEvidence[];
  dialogs: string[];
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

export interface LocomotionActionAuditMaintenance {
  /** Immutable action-record authority is committed even when its derived view needs repair. */
  authoritative: "committed";
  status: "current" | "repair_pending";
  errors: string[];
  publicationIncidents: LocomotionActionPublicationIncident[];
}

export interface LocomotionActionPublicationIncident {
  action: string;
  status: string | null;
  operationId: string;
  phase: "after_commit";
  committed: true;
  reason: "deadline_reached" | "clock_unavailable";
  deadlineMonotonicNs: string;
  observedAtMonotonicNs: string | null;
  clockError: string | null;
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
  actionAuditMaintenance?: LocomotionActionAuditMaintenance;
}

export interface LocomotionHmdDriftReceipt {
  freshness: {
    method: "guest_listener_arrival_age_and_strict_sequence_and_time";
    maximumSampleAgeMs: typeof IN_APP_LOCOMOTION_HMD_MAX_SAMPLE_AGE_MS;
    baseline: { sampleSequence: string; sampleObservedAtMonotonicNs: string; readAtMonotonicNs: string; sampleAgeMs: number };
    pre: { sampleSequence: string; sampleObservedAtMonotonicNs: string; readAtMonotonicNs: string; sampleAgeMs: number };
    post: { sampleSequence: string; sampleObservedAtMonotonicNs: string; readAtMonotonicNs: string; sampleAgeMs: number };
    sequencesStrictlyIncreasing: boolean;
    observationTimesStrictlyIncreasing: boolean;
    readTimesStrictlyIncreasing: boolean;
    pass: boolean;
  };
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
  actionAuditMaintenance?: LocomotionActionAuditMaintenance;
}

export interface LocomotionPriorForegroundDisposition {
  kind: "none" | "receipt_bound" | "non_receipt_bound";
  component: string | null;
  receiptId: string | null;
  receiptFreshness: "known_stale" | "unknown_after_stop_attempt" | "not_evaluated_cp1";
  relaunchDisposition: "not_applicable" | "withheld_receipt_bound" | "accepted" | "ignored" | "blocked" | "attempt_failed"
    | "state_proven_after_attempt_error" | "state_proven_without_attempt";
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
  restorationDisposition: "zero_proven" | "safe_release_without_zero_proof" | "unresolved" | "review_rejected";
  actionAuditMaintenance?: LocomotionActionAuditMaintenance;
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
  actionAuditMaintenance?: LocomotionActionAuditMaintenance;
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
  beforeActionRecordCommit?(context: { action: string; status: string | null; recordPath: string; stagedPath: string }): void;
  afterActionRecordLink?(context: { action: string; status: string | null; recordPath: string; stagedPath: string }): void;
  afterActionFirstDirectoryFsync?(context: { action: string; status: string | null; recordPath: string; stagedPath: string }): void;
  afterActionStageUnlink?(context: { action: string; status: string | null; recordPath: string; stagedPath: string }): void;
  afterActionRecordAdoption?(context: { action: string; status: string | null; recordPath: string; stagedPath: string }): void;
  afterActionViewMaterialization?(context: { action: string; status: string | null; path: string }): void;
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

export interface LocomotionTargetStopReceipt {
  status: "stop_command_completed";
  serial: string;
  packageName: string;
  reason: string;
}

export interface LocomotionCleanPidAbsenceReceipt {
  status: "clean_pidof_absence";
  serial: string;
  packageName: string;
  exitCode: 1;
  timedOut: false;
  stdout: "";
  stderr: "";
}

export interface LocomotionPrepareClearanceReceipt {
  status: "prepare_clearance_completed";
  stopReceipt: LocomotionTargetStopReceipt;
  pidAbsence: LocomotionCleanPidAbsenceReceipt;
}

export interface LocomotionPrepareClearanceProgress {
  status: "prepare_clearance_incomplete";
  stopReceipt: LocomotionTargetStopReceipt;
  pidAbsence: LocomotionCleanPidAbsenceReceipt | null;
}

export type LocomotionStopPackageReceipt = LocomotionTargetStopReceipt | LocomotionPrepareClearanceReceipt;

/** Untrusted partial-progress carrier; the orchestrator exact-validates both receipts. */
export class LocomotionStopClearanceError extends Error {
  readonly stopReceipt: LocomotionTargetStopReceipt;
  readonly pidAbsence: LocomotionCleanPidAbsenceReceipt | null;
  readonly clearanceError: unknown;

  constructor(
    clearanceError: unknown,
    stopReceipt: LocomotionTargetStopReceipt,
    pidAbsence: LocomotionCleanPidAbsenceReceipt | null,
  ) {
    super(errorText(clearanceError));
    this.name = "LocomotionStopClearanceError";
    this.stopReceipt = stopReceipt;
    this.pidAbsence = pidAbsence;
    this.clearanceError = clearanceError;
  }
}

interface LocomotionHostWindowEvidence {
  hostWindowFocusRequest: {
    status: "requested" | "failed" | "not_applicable";
    error: string | null;
    qemuWindowId: number | null;
    qemuWindowOwnerPid: number | null;
    durationMs: number;
  } | null;
  hostWindowProbe: HostWindowProbe;
  hostWindowProbes: Array<{ phase: string; probe: HostWindowProbe }>;
}

export interface InAppLocomotionDependencies {
  platform?: NodeJS.Platform;
  bindQemuWindow?(serial: string): Promise<QemuWindowBindingResult>;
  focusQemuWindow?(binding: BoundQemuWindow): Promise<string | null>;
  probeHostWindow?(serial: string, binding?: BoundQemuWindow): Promise<HostWindowProbe>;
  sleep?(durationMs: number): Promise<void>;
  randomBytes(size: number): Buffer;
  now(): string;
  monotonicNs(): bigint;
  readNativeRunReceipt(app: string, receiptId: string): ReceiptValidation;
  readEffectiveAppSpec(artifactPath: string, identity: { sha256: string; bytes: number }): unknown;
  snapshotPriorForeground(context: { serial: string; targetPackage: string } & LocomotionEffectBudget): Promise<LocomotionPriorForegroundSnapshot>;
  stopPackage(context: { serial: string; packageName: string; reason: string } & LocomotionEffectBudget): Promise<LocomotionStopPackageReceipt>;
  launchTarget(context: { serial: string; component: string } & LocomotionEffectBudget): Promise<{ disposition: "accepted" | "ignored" | "blocked"; component: string; outputSha256: string }>;
  captureLaunchHandoffWindow(context: {
    serial: string;
    runId: string;
    artifactRoot: string;
    packageName: string;
  } & LocomotionEffectBudget): Promise<FreshLaunchHandoffReceipt>;
  observeLaunchHandoff(context: {
    serial: string;
    runId: string;
    artifactRoot: string;
    packageName: string;
    signal: AbortSignal;
  } & LocomotionEffectBudget): Promise<FreshLaunchHandoffObservationReceipt>;
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
    onFirstWindowSample(sample: FreshLaunchMonitorHandoff): Promise<void>;
  } & LocomotionEffectBudget): Promise<FreshLaunchMonitorReceipt>;
  captureSettled(input: CaptureSettledInput, context?: { hostWindowBinding?: BoundQemuWindow }): Promise<{ receipt: CaptureSettledReceipt; frame: Buffer | null }>;
  readReviewImage(item: LocomotionReviewItem, artifactRoot: string): Buffer;
  sampleContinuity(context: {
    serial: string;
    phase: string;
    runtime: LocomotionRuntimeBinding;
    artifactRoot: string;
  } & LocomotionEffectBudget): Promise<ApplicationContinuitySample>;
  requestLocomotion(input: AgentBridgeLocomotionRequestInput): Promise<LocomotionResult>;
  cleanupLocomotionNonce(context: {
    serial: string;
    packageName: string;
    requestId: string;
    tag: string;
    rootGeneration: number;
    rootIncarnation: string;
    processStopped?: true;
    probeOnly?: true;
  } & LocomotionEffectBudget): Promise<AgentBridgeLocomotionNonceCleanupReceipt>;
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
    evidenceId: string;
    priorForeground: InAppLocomotionPrepareInput["priorForeground"];
  } & LocomotionEffectBudget): Promise<FinalProcessActivityReceipt>;
}

interface ArtifactFileIdentity {
  dev: number;
  ino: number;
  bytes: number;
  sha256: string;
}

interface ActionRecordBinding {
  sequence: number;
  operationId: string;
  previousRecordSha256: string;
  payloadSha256: string;
  recordSha256: string;
  identity: ArtifactFileIdentity;
}

interface OwnedActionStagingBinding {
  path: string;
  identity: ArtifactFileIdentity;
}

interface OwnedArtifactBinding extends ReservedArtifactSession {
  rootDev: number;
  rootIno: number;
  capturesDev: number;
  capturesIno: number;
  logsDev: number;
  logsIno: number;
  actionRecordsDev: number;
  actionRecordsIno: number;
  ownerFile: ArtifactFileIdentity;
  runManifest: ArtifactFileIdentity;
  routeManifest: ArtifactFileIdentity;
  actionLog: ArtifactFileIdentity;
  actionRecords: ActionRecordBinding[];
  pendingActionStages: OwnedActionStagingBinding[];
  actionViewDirty: boolean;
  actionDurabilityPending: boolean;
  actionMaintenanceErrors: string[];
  actionPublicationIncidents: LocomotionActionPublicationIncident[];
}

interface LocomotionState {
  hostWindowBinding?: BoundQemuWindow;
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
  lastHmdSample: AgentBridgeHmdPose;
  currentReview: LocomotionReviewItem;
  requiredReview: LocomotionReviewItem[];
  retainedLogs: Array<{ path: string; identity: ArtifactFileIdentity; label: string }>;
  nextWaypoint: number;
  startedAtNs: bigint;
  deadlineNs: bigint;
  usage: { waypointAttempts: number; successfulWaypoints: number; routeDurationMs: number };
  restoreAttempts: number;
  restoreCompleted: boolean;
  completedRestore: { reviewedPriorSha256: string; receipt: LocomotionRestoreReceipt; hostWindowEvidence: LocomotionHostWindowEvidence } | null;
  terminalSafeRelease: { reviewedPriorSha256: string; receipt: LocomotionRestoreReceipt; hostWindowEvidence: LocomotionHostWindowEvidence } | null;
  priorRestoreProofDisposition: "accepted" | "state_proven_after_attempt_error" | "state_proven_without_attempt" | null;
  zeroOffsetRecoveryProven: boolean;
  nonzeroMutationMayHaveApplied: boolean;
  adjudicated: boolean;
  currentReviewReflectsNonzeroMutation: boolean;
  unquiescedLocomotion: { requestId: string; relativePath: string } | null;
  pendingLocomotionNonce: {
    requestId: string;
    relativePath: string;
    tag: string;
    rootGeneration: number;
    rootIncarnation: string;
    attempts: 0 | 1;
  } | null;
  actionAuditConflict: boolean;
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

class ActionPublicationFenceError extends Error {
  constructor(
    message: string,
    readonly committed: boolean,
    readonly incident: LocomotionActionPublicationIncident | null,
  ) {
    super(message);
    this.name = "ActionPublicationFenceError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonceCleanupFailureDisposition(error: unknown): {
  finalizationProven: boolean;
  removalStarted: boolean;
  absenceProven: boolean;
} {
  if (error instanceof AgentBridgeLocomotionNonceCleanupError) {
    return {
      finalizationProven: error.finalizationProven,
      removalStarted: error.removalStarted,
      absenceProven: false,
    };
  }
  // An untyped dependency failure cannot prove that the sole rm never began.
  return { finalizationProven: false, removalStarted: true, absenceProven: false };
}

function locomotionNonceRelativePath(requestId: string): string {
  return `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${requestId}.json`;
}

function validateDeferredLocomotionNonceDisposition(
  result: LocomotionResult,
  pending: NonNullable<LocomotionState["pendingLocomotionNonce"]>,
): AgentBridgeLocomotionNonceCleanupReceipt {
  const receipt = result.nonceCleanup;
  const expectedStatus = result.motionQuiesced ? "route_owned" : "deferred_until_stop";
  if (receipt === undefined
    || receipt.status !== expectedStatus
    || receipt.requestId !== pending.requestId
    || receipt.relativePath !== pending.relativePath
    || receipt.attempts !== 0
    || receipt.finalizationSha256 !== undefined
    || receipt.removalError !== undefined) {
    throw new LocomotionStageError(
      "cleanup_failed",
      `deferred locomotion did not transfer the exact ${expectedStatus} nonce ownership disposition`,
    );
  }
  return receipt;
}

function validateLocomotionNonceCleanupReceipt(
  receipt: AgentBridgeLocomotionNonceCleanupReceipt,
  pending: NonNullable<LocomotionState["pendingLocomotionNonce"]>,
  processStopped: boolean,
): AgentBridgeLocomotionNonceCleanupReceipt {
  const finalizationValid = processStopped
    ? receipt.finalizationSha256 === undefined
    : receipt.finalizationSha256 !== undefined && SHA256.test(receipt.finalizationSha256);
  if (receipt.status !== "removed_and_absent"
    || receipt.requestId !== pending.requestId
    || receipt.relativePath !== pending.relativePath
    || receipt.attempts !== 1
    || !finalizationValid) {
    throw new LocomotionStageError(
      "cleanup_failed",
      processStopped
        ? "locomotion nonce cleanup did not prove the exact one-removal pathname absence disposition"
        : "locomotion nonce cleanup did not prove exact live finalization and one-removal pathname absence",
    );
  }
  return receipt;
}

function checkedTargetStopReceipt(
  receipt: unknown,
  expected: { serial: string; packageName: string; reason: string },
): LocomotionTargetStopReceipt {
  const record = receipt !== null && typeof receipt === "object" && !Array.isArray(receipt)
    ? receipt as Record<string, unknown>
    : null;
  const exactKeys = record === null ? [] : Object.keys(record).sort();
  if (record === null
    || exactKeys.join("\0") !== ["packageName", "reason", "serial", "status"].join("\0")
    || record.status !== "stop_command_completed"
    || record.serial !== expected.serial
    || record.packageName !== expected.packageName
    || record.reason !== expected.reason) {
    const detail = record && typeof record.error === "string" ? `: ${record.error}` : "";
    throw new Error(`target stop did not return the exact command-completed receipt${detail}`);
  }
  return record as unknown as LocomotionTargetStopReceipt;
}

function checkedCleanPidAbsenceReceipt(
  receipt: unknown,
  expected: { serial: string; packageName: string },
): LocomotionCleanPidAbsenceReceipt {
  const record = receipt !== null && typeof receipt === "object" && !Array.isArray(receipt)
    ? receipt as Record<string, unknown>
    : null;
  const exactKeys = record === null ? [] : Object.keys(record).sort();
  if (record === null
    || exactKeys.join("\0") !== ["exitCode", "packageName", "serial", "status", "stderr", "stdout", "timedOut"].join("\0")
    || record.status !== "clean_pidof_absence"
    || record.serial !== expected.serial
    || record.packageName !== expected.packageName
    || record.exitCode !== 1
    || record.timedOut !== false
    || record.stdout !== ""
    || record.stderr !== "") {
    throw new Error("prepare clearance did not return the exact clean PID-absence receipt");
  }
  return record as unknown as LocomotionCleanPidAbsenceReceipt;
}

function checkedPrepareClearanceReceipt(
  receipt: unknown,
  expected: { serial: string; packageName: string; reason: string },
): LocomotionPrepareClearanceReceipt {
  const record = receipt !== null && typeof receipt === "object" && !Array.isArray(receipt)
    ? receipt as Record<string, unknown>
    : null;
  const exactKeys = record === null ? [] : Object.keys(record).sort();
  if (record === null
    || exactKeys.join("\0") !== ["pidAbsence", "status", "stopReceipt"].join("\0")
    || record.status !== "prepare_clearance_completed") {
    throw new Error("prepare clearance did not return the exact clean PID-absence receipt envelope");
  }
  const stopReceipt = checkedTargetStopReceipt(record.stopReceipt, expected);
  const pidAbsence = checkedCleanPidAbsenceReceipt(record.pidAbsence, expected);
  return { status: "prepare_clearance_completed", stopReceipt, pidAbsence };
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

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function actionOperationId(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "unknown:terminal";
  const record = value as Record<string, unknown>;
  const action = String(record.action ?? "unknown");
  if (action === "step") return `step:${String(record.waypointSeq ?? "unknown")}:terminal`;
  if (action === "restore") return `restore:${String(record.restoreAttempt ?? "unknown")}:terminal`;
  if (action === "prepare" && record.compensatesActionOperationId === "prepare:terminal") {
    return "prepare:publication-compensation:terminal";
  }
  return `${action}:terminal`;
}

function removeOwnedActionStage(
  binding: OwnedArtifactBinding,
  owned: OwnedActionStagingBinding,
): void {
  const index = binding.pendingActionStages.indexOf(owned);
  if (index < 0) return;
  if (fs.existsSync(owned.path)) {
    unlinkExactArtifact(owned.path, owned.identity, "owned staged immutable action record", 16 * 1024 * 1024);
  }
  binding.pendingActionStages.splice(index, 1);
}

function reconcileOwnedActionStages(binding: OwnedArtifactBinding): void {
  if (binding.pendingActionStages.length === 0) return;
  const recordsRoot = path.join(binding.absoluteRoot, "action-records");
  for (const owned of [...binding.pendingActionStages]) removeOwnedActionStage(binding, owned);
  try {
    fsyncDirectory(recordsRoot);
    binding.actionDurabilityPending = false;
  } catch (error) {
    binding.actionDurabilityPending = true;
    noteActionMaintenance(binding, "owned staged action-record cleanup durability", error);
  }
}

function replayActionRecords(
  binding: OwnedArtifactBinding,
  hooks: InAppLocomotionArtifactHooks,
  allowBoundPendingStages = false,
): Buffer[] {
  sameDirectory(
    path.join(binding.absoluteRoot, "action-records"),
    { dev: binding.actionRecordsDev, ino: binding.actionRecordsIno },
    "action record directory",
  );
  const recordsRoot = path.join(binding.absoluteRoot, "action-records");
  const entries = fs.readdirSync(recordsRoot).sort();
  const expectedNames = binding.actionRecords.map((record) => `${String(record.sequence).padStart(6, "0")}.json`);
  if (allowBoundPendingStages) {
    const pendingPaths = new Set<string>();
    const pendingIdentities = new Set<string>();
    for (const pending of binding.pendingActionStages) {
      if (!isWithin(recordsRoot, pending.path)
        || !/^\.[0-9]{6}\.[a-f0-9]{32}\.tmp$/.test(path.basename(pending.path))
        || pendingPaths.has(pending.path)
        || pendingIdentities.has(`${pending.identity.dev}:${pending.identity.ino}`)) {
        throw new Error("bound pending action stage identity is invalid or duplicated");
      }
      pendingPaths.add(pending.path);
      pendingIdentities.add(`${pending.identity.dev}:${pending.identity.ino}`);
      assertSameArtifactFile(
        pending.path,
        pending.identity,
        "bound pending immutable action stage",
        16 * 1024 * 1024,
        hooks,
      );
      expectedNames.push(path.basename(pending.path));
    }
  }
  expectedNames.sort();
  if (canonicalJson(entries) !== canonicalJson(expectedNames)) throw new Error("authoritative action record slots changed after publication");
  let previous = "0".repeat(64);
  const payloads: Buffer[] = [];
  for (const bound of binding.actionRecords) {
    const recordPath = path.join(binding.absoluteRoot, "action-records", `${String(bound.sequence).padStart(6, "0")}.json`);
    const bytes = readSameArtifactFile(recordPath, bound.identity, `action record ${bound.sequence}`, 16 * 1024 * 1024, hooks);
    if (sha256Bytes(bytes) !== bound.recordSha256) throw new Error(`action record ${bound.sequence} hash changed`);
    let envelope: any;
    try { envelope = JSON.parse(bytes.toString("utf8")); } catch (error) {
      throw new Error(`action record ${bound.sequence} is invalid JSON: ${errorText(error)}`);
    }
    const payloadBytes = Buffer.from(`${canonicalJson(envelope.payload)}\n`, "utf8");
    if (envelope.schemaVersion !== 1 || envelope.runId !== binding.runId || envelope.sequence !== bound.sequence
      || envelope.operationId !== bound.operationId || envelope.previousRecordSha256 !== previous
      || envelope.previousRecordSha256 !== bound.previousRecordSha256
      || envelope.payloadSha256 !== sha256Bytes(Buffer.from(canonicalJson(envelope.payload), "utf8"))
      || envelope.payloadSha256 !== bound.payloadSha256) {
      throw new Error(`action record ${bound.sequence} lost its exact run/sequence/hash-chain binding`);
    }
    previous = bound.recordSha256;
    payloads.push(payloadBytes);
  }
  if (payloads.reduce((total, bytes) => total + bytes.length, 0) > 16 * 1024 * 1024) {
    throw new Error("derived action JSONL exceeds its bounded publication limit");
  }
  return payloads;
}

function materializeActionView(binding: OwnedArtifactBinding, payloads: Buffer[], hooks: InAppLocomotionArtifactHooks): void {
  const target = path.join(binding.absoluteRoot, "actions.jsonl");
  const intended = Buffer.concat(payloads);
  const stagedPath = path.join(binding.absoluteRoot, `.actions.view.${crypto.randomBytes(16).toString("hex")}.tmp`);
  try {
    privateWrite(stagedPath, intended);
    const staged = artifactFileIdentity(stagedPath, "staged action JSONL", 16 * 1024 * 1024, hooks);
    if (staged.bytes !== intended.length || staged.sha256 !== sha256Bytes(intended)) {
      throw new Error("derived action JSONL staging lost exact bytes");
    }
    // actions.jsonl is a replaceable derived view.  Its immutable action-record
    // chain is the authority, so a damaged/substituted view must not prevent a
    // descriptor-derived repair.
    fs.renameSync(stagedPath, target);
    // rename preserves the already verified staged inode.  Adopt it before any
    // fallible durability/re-stat work so a committed derived view remains
    // repairable instead of making its former pathname identity authoritative.
    binding.actionLog = staged;
    fsyncDirectory(binding.absoluteRoot);
    const published = artifactFileIdentity(target, "action JSONL", 16 * 1024 * 1024, hooks);
    if (published.dev !== staged.dev || published.ino !== staged.ino
      || published.bytes !== staged.bytes || published.sha256 !== staged.sha256) {
      throw new Error("derived action JSONL publication changed its verified staged identity");
    }
    binding.actionLog = published;
    binding.actionViewDirty = false;
  } finally {
    if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
  }
}

function actionAuditMaintenance(binding: OwnedArtifactBinding): LocomotionActionAuditMaintenance {
  return {
    authoritative: "committed",
    status: binding.actionViewDirty || binding.actionDurabilityPending || binding.pendingActionStages.length > 0
      ? "repair_pending" : "current",
    errors: [...binding.actionMaintenanceErrors],
    publicationIncidents: binding.actionPublicationIncidents.map((incident) => ({ ...incident })),
  };
}

function noteActionMaintenance(binding: OwnedArtifactBinding, phase: string, error: unknown): void {
  binding.actionMaintenanceErrors.push(`${phase}: ${errorText(error)}`);
}

function appendAction(
  binding: OwnedArtifactBinding,
  value: unknown,
  hooks: InAppLocomotionArtifactHooks,
  commitFence?: { deadlineNs: bigint; monotonicNs: () => bigint; label: string },
): LocomotionActionAuditMaintenance {
  assertOwnedArtifacts(binding, hooks);
  const target = path.join(binding.absoluteRoot, "actions.jsonl");
  const action = value && typeof value === "object" && !Array.isArray(value)
    ? String((value as Record<string, unknown>).action ?? "unknown") : "unknown";
  const status = value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).status === "string"
    ? String((value as Record<string, unknown>).status) : null;
  const operationId = actionOperationId(value);
  const payloadCanonical = canonicalJson(value);
  const payloadSha256 = sha256Bytes(Buffer.from(payloadCanonical, "utf8"));
  const existing = binding.actionRecords.find((record) => record.operationId === operationId);
  if (existing) {
    if (existing.payloadSha256 !== payloadSha256) throw new Error(`action operation '${operationId}' was already committed with different bytes`);
    try {
      materializeActionView(binding, replayActionRecords(binding, hooks), hooks);
    } catch (error) {
      binding.actionViewDirty = true;
      noteActionMaintenance(binding, "derived action JSONL repair after identical committed operation", error);
    }
    return actionAuditMaintenance(binding);
  }
  hooks.beforeActionAppendOpen?.({ action, status, path: target });
  const sequence = binding.actionRecords.length + 1;
  const previousRecordSha256 = binding.actionRecords.at(-1)?.recordSha256 ?? "0".repeat(64);
  const envelope = {
    schemaVersion: 1,
    runId: binding.runId,
    sequence,
    operationId,
    previousRecordSha256,
    payloadSha256,
    payload: value,
  };
  const recordBytes = Buffer.from(`${canonicalJson(envelope)}\n`, "utf8");
  const recordsRoot = path.join(binding.absoluteRoot, "action-records");
  const recordPath = path.join(recordsRoot, `${String(sequence).padStart(6, "0")}.json`);
  const stagedPath = path.join(recordsRoot, `.${String(sequence).padStart(6, "0")}.${crypto.randomBytes(16).toString("hex")}.tmp`);
  let authoritativeCommit = false;
  try {
    const descriptor = fs.openSync(stagedPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const handled = hooks.writeActionStage?.({ action, status, path: target, descriptor, bytes: recordBytes }) === true;
      if (!handled) {
        let offset = 0;
        while (offset < recordBytes.length) offset += fs.writeSync(descriptor, recordBytes, offset, recordBytes.length - offset, offset);
      }
      hooks.beforeActionStageFsync?.({ action, status, path: target });
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    const staged = artifactFileIdentity(stagedPath, "staged immutable action record", 16 * 1024 * 1024, hooks);
    const recordSha256 = sha256Bytes(recordBytes);
    if (staged.bytes !== recordBytes.length || staged.sha256 !== recordSha256) {
      throw new Error("staged immutable action record bytes were incomplete");
    }
    hooks.beforeActionPublish?.({ action, status, path: target, stagedPath });
    hooks.beforeActionRecordCommit?.({ action, status, recordPath, stagedPath });
    if (commitFence) {
      let admittedAtNs: bigint;
      try {
        admittedAtNs = commitFence.monotonicNs();
      } catch (error) {
        throw new ActionPublicationFenceError(
          `${commitFence.label} cannot prove admission before its fixed deadline: ${errorText(error)}`,
          false,
          null,
        );
      }
      if (admittedAtNs >= commitFence.deadlineNs) {
        throw new ActionPublicationFenceError(
          `${commitFence.label} cannot commit at or after its fixed deadline`,
          false,
          null,
        );
      }
    }
    let identity: ArtifactFileIdentity;
    try {
      fs.linkSync(stagedPath, recordPath);
      identity = { ...staged };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const actual = artifactFileIdentity(recordPath, `competing action record ${sequence}`, 16 * 1024 * 1024, hooks);
      const actualBytes = readSameArtifactFile(recordPath, actual, `competing action record ${sequence}`, 16 * 1024 * 1024, hooks);
      if (!actualBytes.equals(recordBytes)) throw new Error(`action record ${sequence} publication conflict`);
      identity = actual;
    }
    if (identity.sha256 !== recordSha256 || identity.bytes !== recordBytes.length) {
      throw new Error(`action record ${sequence} publication did not retain exact bytes`);
    }
    binding.actionRecords.push({ sequence, operationId, previousRecordSha256, payloadSha256, recordSha256, identity });
    binding.actionViewDirty = true;
    authoritativeCommit = true;
    const ownedStage: OwnedActionStagingBinding = { path: stagedPath, identity: staged };
    binding.pendingActionStages.push(ownedStage);
    // The hard link (or byte-identical EEXIST) is the semantic commit fence.
    // Everything below is repairable maintenance and must never reverse the
    // exact payload now stored in the immutable hash chain.
    const verifyCommittedFence = (): void => {
      if (!commitFence) return;
      let completedAtNs: bigint | null = null;
      let clockError: string | null = null;
      try {
        completedAtNs = commitFence.monotonicNs();
      } catch (error) {
        clockError = errorText(error);
      }
      if (clockError !== null || completedAtNs! >= commitFence.deadlineNs) {
        binding.actionDurabilityPending = true;
        const incident: LocomotionActionPublicationIncident = {
          action,
          status,
          operationId,
          phase: "after_commit",
          committed: true,
          reason: clockError === null ? "deadline_reached" : "clock_unavailable",
          deadlineMonotonicNs: commitFence.deadlineNs.toString(),
          observedAtMonotonicNs: completedAtNs?.toString() ?? null,
          clockError,
        };
        binding.actionPublicationIncidents.push(incident);
        throw new ActionPublicationFenceError(
          `${commitFence.label} committed but its publication deadline is unproven: ${clockError === null
            ? "semantic commit completed at or after the fixed deadline"
            : `post-commit clock unavailable: ${clockError}`}`,
          true,
          incident,
        );
      }
    };
    if (commitFence) {
      binding.actionDurabilityPending = true;
      verifyCommittedFence();
      if (status === "completed" && (action === "step" || action === "restore")) {
        // A completed route/restore action must hand control back without any
        // repair-only fsync, staging cleanup, derived-view materialization, or
        // test hook consuming the protected deadline that follows the commit.
        // Later state-bound calls validate this exact immutable record before
        // effects. A later action publication or a no-device terminal replay /
        // adjudication performs the retained filesystem-only maintenance.
        return actionAuditMaintenance(binding);
      }
      // A stopped/failed result still uses its remaining publication window
      // to preserve the pre-existing JSONL behavior. A second fence below
      // makes any maintenance overrun explicit without reversing the record.
    }
    try { hooks.afterActionRecordLink?.({ action, status, recordPath, stagedPath }); } catch (error) {
      noteActionMaintenance(binding, "post-link action maintenance", error);
    }
    try {
      fsyncDirectory(recordsRoot);
      binding.actionDurabilityPending = false;
      hooks.afterActionFirstDirectoryFsync?.({ action, status, recordPath, stagedPath });
    } catch (error) {
      binding.actionDurabilityPending = true;
      noteActionMaintenance(binding, "authoritative action-record directory durability", error);
    }
    try {
      removeOwnedActionStage(binding, ownedStage);
      hooks.afterActionStageUnlink?.({ action, status, recordPath, stagedPath });
    } catch (error) {
      noteActionMaintenance(binding, "staged action-record cleanup", error);
    }
    try { fsyncDirectory(recordsRoot); } catch (error) {
      binding.actionDurabilityPending = true;
      noteActionMaintenance(binding, "post-stage action-record directory durability", error);
    }
    try { hooks.afterActionRecordAdoption?.({ action, status, recordPath, stagedPath }); } catch (error) {
      noteActionMaintenance(binding, "post-adoption action maintenance", error);
    }
    if (binding.pendingActionStages.length === 0) {
      try {
        materializeActionView(binding, replayActionRecords(binding, hooks), hooks);
      } catch (error) {
        binding.actionViewDirty = true;
        noteActionMaintenance(binding, "derived action JSONL materialization", error);
      }
    } else {
      noteActionMaintenance(binding, "derived action JSONL materialization", "deferred until owned action staging cleanup");
    }
    try { hooks.afterActionViewMaterialization?.({ action, status, path: target }); } catch (error) {
      noteActionMaintenance(binding, "post-materialization action maintenance", error);
    }
    verifyCommittedFence();
  } finally {
    const ownedStage = binding.pendingActionStages.find((candidate) => candidate.path === stagedPath);
    if (ownedStage && !(authoritativeCommit && commitFence)) {
      try { removeOwnedActionStage(binding, ownedStage); } catch (error) {
        if (!authoritativeCommit) throw error;
        noteActionMaintenance(binding, "staged action-record final cleanup", error);
      }
    } else if (!authoritativeCommit && fs.existsSync(stagedPath)) {
      fs.unlinkSync(stagedPath);
    }
  }
  return actionAuditMaintenance(binding);
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
  sameDirectory(path.join(binding.absoluteRoot, "action-records"), {
    dev: binding.actionRecordsDev, ino: binding.actionRecordsIno,
  }, "action record directory");
  reconcileOwnedActionStages(binding);
  const ownerBytes = readSameArtifactFile(
    path.join(binding.absoluteRoot, ".owner.json"),
    binding.ownerFile,
    "artifact ownership manifest",
    64 * 1024,
    hooks,
  );
  assertSameArtifactFile(path.join(binding.absoluteRoot, "run.json"), binding.runManifest, "run manifest", 1024 * 1024, hooks);
  assertSameArtifactFile(path.join(binding.absoluteRoot, "route.json"), binding.routeManifest, "route manifest", 1024 * 1024, hooks);
  if (binding.actionDurabilityPending) {
    try {
      fsyncDirectory(path.join(binding.absoluteRoot, "action-records"));
      binding.actionDurabilityPending = false;
    } catch (error) {
      noteActionMaintenance(binding, "authoritative action-record directory durability repair", error);
    }
  }
  const payloads = replayActionRecords(binding, hooks);
  let viewBytes: Buffer | null = null;
  try {
    viewBytes = readSameArtifactFile(
      path.join(binding.absoluteRoot, "actions.jsonl"), binding.actionLog, "action JSONL", 16 * 1024 * 1024, hooks,
    );
  } catch (error) {
    binding.actionViewDirty = true;
    noteActionMaintenance(binding, "derived action JSONL validation", error);
  }
  const authoritativeView = Buffer.concat(payloads);
  if (binding.actionViewDirty || viewBytes === null || !viewBytes.equals(authoritativeView)) {
    materializeActionView(binding, payloads, hooks);
    viewBytes = readSameArtifactFile(
      path.join(binding.absoluteRoot, "actions.jsonl"), binding.actionLog, "repaired action JSONL", 16 * 1024 * 1024, hooks,
    );
  }
  if (!viewBytes.equals(authoritativeView)) throw new Error("derived action JSONL does not reproduce the authoritative action records");
  const owner = JSON.parse(ownerBytes.toString("utf8"));
  if (owner.schemaVersion !== 1 || owner.runId !== binding.runId || owner.ownerNonceHash !== binding.ownerNonceHash) {
    throw new Error("artifact ownership record changed after reservation");
  }
}

function validateOwnedArtifactsWithoutMaintenance(
  binding: OwnedArtifactBinding,
  hooks: InAppLocomotionArtifactHooks = {},
): void {
  sameDirectory(binding.absoluteRoot, { dev: binding.rootDev, ino: binding.rootIno }, "artifact root");
  sameDirectory(path.join(binding.absoluteRoot, "captures"), { dev: binding.capturesDev, ino: binding.capturesIno }, "capture directory");
  sameDirectory(path.join(binding.absoluteRoot, "logs"), { dev: binding.logsDev, ino: binding.logsIno }, "log directory");
  sameDirectory(path.join(binding.absoluteRoot, "action-records"), {
    dev: binding.actionRecordsDev, ino: binding.actionRecordsIno,
  }, "action record directory");
  const ownerBytes = readSameArtifactFile(
    path.join(binding.absoluteRoot, ".owner.json"),
    binding.ownerFile,
    "artifact ownership manifest",
    64 * 1024,
    hooks,
  );
  assertSameArtifactFile(path.join(binding.absoluteRoot, "run.json"), binding.runManifest, "run manifest", 1024 * 1024, hooks);
  assertSameArtifactFile(path.join(binding.absoluteRoot, "route.json"), binding.routeManifest, "route manifest", 1024 * 1024, hooks);
  const payloads = replayActionRecords(binding, hooks, true);
  let viewBytes: Buffer | null = null;
  try {
    viewBytes = readSameArtifactFile(
      path.join(binding.absoluteRoot, "actions.jsonl"), binding.actionLog, "action JSONL", 16 * 1024 * 1024, hooks,
    );
  } catch (error) {
    if (!binding.actionViewDirty) throw error;
    noteActionMaintenance(binding, "deferred derived action JSONL validation", error);
  }
  if (!binding.actionViewDirty && (viewBytes === null || !viewBytes.equals(Buffer.concat(payloads)))) {
    throw new Error("derived action JSONL diverged from the authoritative action records without retained repair ownership");
  }
  const owner = JSON.parse(ownerBytes.toString("utf8"));
  if (owner.schemaVersion !== 1 || owner.runId !== binding.runId || owner.ownerNonceHash !== binding.ownerNonceHash) {
    throw new Error("artifact ownership record changed after reservation");
  }
}

function reserveArtifacts(input: InAppLocomotionPrepareInput, dependencies: InAppLocomotionDependencies, admittedAtNs?: bigint): {
  binding: OwnedArtifactBinding;
  createdAt: string;
  startedAtNs: bigint;
} {
  const physical = resolveProspectivePath(input.artifactRoot);
  if (artifactRootIssue(physical)) throw new Error(artifactRootIssue(physical)!);
  const nonce = dependencies.randomBytes(32);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw new Error("random source must return exactly 32 bytes");
  const startedAtNs = admittedAtNs ?? checkedMonotonic(dependencies);
  const createdAt = checkedNow(dependencies);
  const runId = sha256Bytes(Buffer.concat([nonce, Buffer.from(input.serial), Buffer.from(startedAtNs.toString())]));
  const ownerNonceHash = sha256Bytes(nonce);
  fs.mkdirSync(physical, { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(physical, "captures"), { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(physical, "logs"), { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(physical, "action-records"), { recursive: false, mode: 0o700 });
  const root = directoryIdentity(physical, "artifact root");
  const captures = directoryIdentity(path.join(physical, "captures"), "capture directory");
  const logs = directoryIdentity(path.join(physical, "logs"), "log directory");
  const actionRecords = directoryIdentity(path.join(physical, "action-records"), "action record directory");
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
    actionRecordsDev: actionRecords.dev,
    actionRecordsIno: actionRecords.ino,
    ownerFile: artifactFileIdentity(path.join(physical, ".owner.json"), "artifact ownership manifest", 64 * 1024),
    runManifest: artifactFileIdentity(path.join(physical, "run.json"), "run manifest", 1024 * 1024),
    routeManifest: artifactFileIdentity(path.join(physical, "route.json"), "route manifest", 1024 * 1024),
    actionLog: artifactFileIdentity(path.join(physical, "actions.jsonl"), "action JSONL", 16 * 1024 * 1024),
    actionRecords: [],
    pendingActionStages: [],
    actionViewDirty: false,
    actionDurabilityPending: false,
    actionMaintenanceErrors: [],
    actionPublicationIncidents: [],
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
  for (const key of ["guardian", "vstComponent", "vstDebug", "safeguardCenter"] as const) {
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

function hmdSampleAgeMs(pose: AgentBridgeHmdPose): number {
  const observedAt = BigInt(pose.sampleObservedAtMonotonicNs);
  const readAt = BigInt(pose.readAtMonotonicNs);
  if (readAt < observedAt) throw new LocomotionStageError("hmd_pose_stale", "HMD listener sample observation time is later than its read time");
  return Number(readAt - observedAt) / 1_000_000;
}

function hmdPoseFrom(
  result: HmdResult,
  expectedGeneration: number,
  expectedIncarnation: string,
  strictlyAfterSample?: AgentBridgeHmdPose,
): AgentBridgeHmdPose {
  if (!result.ok) throw new LocomotionStageError(result.code, result.primaryError ?? result.detail, result.cleanupError);
  const pose = result.ack.hmdPose;
  if (result.ack.root?.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID || result.ack.root.generation !== expectedGeneration
    || result.ack.root.incarnation !== expectedIncarnation || pose === null) {
    throw new Error("HMD result lost the exact root generation/incarnation binding");
  }
  const values = [pose.position.x, pose.position.y, pose.position.z, pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w];
  if (!values.every(Number.isFinite)
    || !/^[1-9][0-9]*$/.test(pose.sampleSequence)
    || !/^(?:0|[1-9][0-9]*)$/.test(pose.sampleObservedAtMonotonicNs)
    || !/^(?:0|[1-9][0-9]*)$/.test(pose.readAtMonotonicNs)) {
    throw new Error("HMD pose is missing finite position/quaternion/listener freshness telemetry");
  }
  if (Math.hypot(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w) === 0) throw new Error("HMD quaternion has zero norm");
  const sampleAgeMs = hmdSampleAgeMs(pose);
  if (sampleAgeMs > IN_APP_LOCOMOTION_HMD_MAX_SAMPLE_AGE_MS) {
    throw new LocomotionStageError(
      "hmd_pose_stale",
      `HMD listener sample age ${sampleAgeMs}ms exceeds the ${IN_APP_LOCOMOTION_HMD_MAX_SAMPLE_AGE_MS}ms experiment threshold`,
    );
  }
  if (strictlyAfterSample !== undefined
    && (BigInt(pose.sampleSequence) <= BigInt(strictlyAfterSample.sampleSequence)
      || BigInt(pose.sampleObservedAtMonotonicNs) <= BigInt(strictlyAfterSample.sampleObservedAtMonotonicNs)
      || BigInt(pose.readAtMonotonicNs) <= BigInt(strictlyAfterSample.readAtMonotonicNs))) {
    throw new LocomotionStageError(
      "hmd_pose_stale",
      "HMD listener sequence, observation time, and read time must all advance strictly after the prior accepted sample",
    );
  }
  return pose;
}

interface HmdAcquisitionEvidence {
  attemptCount: number;
  acceptedSampleAgeMs: number | null;
  policy: {
    maxAttempts: number; pollMs: number; maxSampleAgeMs: number; maximumDurationMs: number;
    minimumTransactionMs: number; reservedAfterMs: number;
    phaseDeadlineMonotonicNs: string; deadlineMonotonicNs: string;
  } | null;
  attempts: Array<{
    requestId: string;
    outcome: "accepted" | "hmd_pose_stale" | "failed";
    sampleAgeMs: number | null;
    sampleSequence: string | null;
    sampleObservedAtMonotonicNs: string | null;
    readAtMonotonicNs: string | null;
    startedAtMonotonicNs: string | null;
    completedAtMonotonicNs: string | null;
    root: AgentBridgeLocomotionAck["root"] | null;
    retrySubtype: "aged_sample" | "retained_callback" | null;
    actionReceipts: HmdResult["actionReceipts"];
    cleanupError: string | null;
    error: string | null;
  }>;
}

function hmdAcquisitionEvidence(): HmdAcquisitionEvidence {
  return { attemptCount: 0, acceptedSampleAgeMs: null, policy: null, attempts: [] };
}

function hmdCandidateRelation(pose: AgentBridgeHmdPose, floor: AgentBridgeHmdPose): "advanced" | "retained_callback" | null {
  const sameCallback = pose.sampleSequence === floor.sampleSequence
    && pose.sampleObservedAtMonotonicNs === floor.sampleObservedAtMonotonicNs
    && BigInt(pose.readAtMonotonicNs) >= BigInt(floor.readAtMonotonicNs)
    && canonicalJson(pose.position) === canonicalJson(floor.position)
    && canonicalJson(pose.rotation) === canonicalJson(floor.rotation);
  if (sameCallback) return "retained_callback";
  if (BigInt(pose.sampleSequence) <= BigInt(floor.sampleSequence)
    || BigInt(pose.sampleObservedAtMonotonicNs) <= BigInt(floor.sampleObservedAtMonotonicNs)
    || BigInt(pose.readAtMonotonicNs) <= BigInt(floor.readAtMonotonicNs)) return null;
  return "advanced";
}

function retryableHmdFreshness(pose: AgentBridgeHmdPose, floor?: AgentBridgeHmdPose): "aged_sample" | "retained_callback" | null {
  if (BigInt(pose.readAtMonotonicNs) < BigInt(pose.sampleObservedAtMonotonicNs)) return null;
  const relation = floor ? hmdCandidateRelation(pose, floor) : "advanced";
  if (relation === null || relation === "retained_callback") return relation;
  return hmdSampleAgeMs(pose) > IN_APP_LOCOMOTION_HMD_MAX_SAMPLE_AGE_MS ? "aged_sample" : null;
}

async function acquireFreshHmdPose(
  dependencies: InAppLocomotionDependencies,
  phaseDeadlineNs: bigint,
  label: string,
  input: AgentBridgeHmdPoseRequestInput & { expectedRootGeneration: number; expectedRootIncarnation: string },
  evidence: HmdAcquisitionEvidence,
  reservedAfterMs: number,
  strictlyAfterSample?: AgentBridgeHmdPose,
): Promise<AgentBridgeHmdPose> {
  const deadlineNs = earlierDeadline(
    phaseDeadlineNs - BigInt(reservedAfterMs) * 1_000_000n,
    checkedMonotonic(dependencies) + BigInt(HMD_ACQUISITION_WINDOW_MS) * 1_000_000n,
  );
  evidence.policy = {
    maxAttempts: HMD_ACQUISITION_MAX_ATTEMPTS, pollMs: HMD_ACQUISITION_POLL_MS,
    maxSampleAgeMs: IN_APP_LOCOMOTION_HMD_MAX_SAMPLE_AGE_MS, maximumDurationMs: HMD_ACQUISITION_WINDOW_MS,
    minimumTransactionMs: BRIDGE_MIN_TRANSACTION_MS, reservedAfterMs,
    phaseDeadlineMonotonicNs: phaseDeadlineNs.toString(), deadlineMonotonicNs: deadlineNs.toString(),
  };
  let lastSeen: AgentBridgeHmdPose | null = null;
  for (let index = 0; index < HMD_ACQUISITION_MAX_ATTEMPTS; index += 1) {
    const attempt: HmdAcquisitionEvidence["attempts"][number] = {
      requestId: evidence.attemptCount === 0 ? input.requestId : `${input.requestId}_retry_${evidence.attemptCount + 1}`,
      outcome: "failed", sampleAgeMs: null, sampleSequence: null,
      sampleObservedAtMonotonicNs: null, readAtMonotonicNs: null, error: null,
      startedAtMonotonicNs: null, completedAtMonotonicNs: null, root: null,
      retrySubtype: null, actionReceipts: [], cleanupError: null,
    };
    let sampledPose: AgentBridgeHmdPose | null = null;
    try {
      const result = await withinDeadline(deadlineNs, dependencies, label, async (timeoutMs) => {
        const budget = bridgeBudgetFields(timeoutMs, deadlineNs);
        attempt.startedAtMonotonicNs = checkedMonotonic(dependencies).toString();
        evidence.attemptCount += 1;
        evidence.attempts.push(attempt);
        const result = await dependencies.requestHmdPose({ ...input, ...budget, requestId: attempt.requestId });
        attempt.actionReceipts = result.actionReceipts ?? [];
        attempt.cleanupError = result.cleanupError ?? null;
        const pose = result.ok ? result.ack.hmdPose : null;
        sampledPose = pose;
        attempt.root = result.ok ? result.ack.root : null;
        if (pose) {
          attempt.sampleSequence = typeof pose.sampleSequence === "string" ? pose.sampleSequence : null;
          attempt.sampleObservedAtMonotonicNs = typeof pose.sampleObservedAtMonotonicNs === "string" ? pose.sampleObservedAtMonotonicNs : null;
          attempt.readAtMonotonicNs = typeof pose.readAtMonotonicNs === "string" ? pose.readAtMonotonicNs : null;
          if (/^[0-9]+$/.test(pose.sampleObservedAtMonotonicNs) && /^[0-9]+$/.test(pose.readAtMonotonicNs)) {
            const age = Number(BigInt(pose.readAtMonotonicNs) - BigInt(pose.sampleObservedAtMonotonicNs)) / 1_000_000;
            if (Number.isFinite(age)) attempt.sampleAgeMs = age;
          }
        }
        attempt.completedAtMonotonicNs = checkedMonotonic(dependencies).toString();
        return result;
      });
      const pose = hmdPoseFrom(result, input.expectedRootGeneration, input.expectedRootIncarnation, strictlyAfterSample);
      if (lastSeen && hmdCandidateRelation(pose, lastSeen) === null) {
        throw new LocomotionStageError("hmd_pose_stale", "HMD candidate regressed or advanced incoherently after the prior observed candidate");
      }
      attempt.outcome = "accepted";
      evidence.acceptedSampleAgeMs = hmdSampleAgeMs(pose);
      return pose;
    } catch (error) {
      attempt.error = errorText(error);
      if (!(error instanceof LocomotionStageError) || error.code !== "hmd_pose_stale" || error.cleanupError || sampledPose === null) throw error;
      if (lastSeen && hmdCandidateRelation(sampledPose, lastSeen) === null) {
        attempt.error = "HMD candidate regressed or advanced incoherently after the prior observed candidate";
        throw new LocomotionStageError("hmd_pose_stale", attempt.error);
      }
      attempt.retrySubtype = retryableHmdFreshness(sampledPose, strictlyAfterSample);
      if (attempt.retrySubtype === null) throw error;
      attempt.outcome = "hmd_pose_stale";
      lastSeen = sampledPose;
      if (index + 1 === HMD_ACQUISITION_MAX_ATTEMPTS) {
        throw new LocomotionStageError("hmd_pose_stale", `${error.message}; HMD acquisition reached its ${HMD_ACQUISITION_MAX_ATTEMPTS}-attempt limit`);
      }
      try {
        // Poll listener freshness, without changing the age/sequence gate or moving the HMD.
        await withinDeadline(deadlineNs, dependencies, `${label} fresh-sample retry`, async (remainingMs) => {
          if (remainingMs < HMD_ACQUISITION_POLL_MS + BRIDGE_MIN_TRANSACTION_MS) {
            throw new Error("remaining phase deadline cannot fit another HMD transaction");
          }
          await (dependencies.sleep ?? sleep)(HMD_ACQUISITION_POLL_MS);
        });
      } catch (deadlineError) {
        throw new LocomotionStageError("hmd_pose_stale", `${error.message}; ${errorText(deadlineError)}`);
      }
    }
  }
  throw new Error("HMD acquisition exhausted without a terminal disposition");
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

function freshLaunchMonitorHandoffToken(runId: string, value: Omit<FreshLaunchMonitorHandoff, "handoffToken">): string {
  return sha256Bytes(Buffer.from(canonicalJson({
    runId,
    rawWindowSha256: value.rawWindowDump.sha256,
    probeStartedAtMonotonicNs: value.probeStartedAtMonotonicNs,
    retainedAtMonotonicNs: value.retainedAtMonotonicNs,
  }), "utf8"));
}

function validateFreshLaunchMonitorHandoff(
  value: FreshLaunchMonitorHandoff,
  runId: string,
  artifactRoot: string,
  hooks: InAppLocomotionArtifactHooks,
): { value: FreshLaunchMonitorHandoff; retained: { path: string; identity: ArtifactFileIdentity; label: string } } {
  if (!value || !/^(?:0|[1-9]\d*)$/.test(value.probeStartedAtMonotonicNs)
    || !/^(?:0|[1-9]\d*)$/.test(value.retainedAtMonotonicNs)
    || BigInt(value.retainedAtMonotonicNs) < BigInt(value.probeStartedAtMonotonicNs)) {
    throw new Error("fresh-launch monitor sample zero lost its post-retention monotonic handoff timing");
  }
  const retained = checkedRawLogEvidence(value.rawWindowDump, artifactRoot, "fresh-launch monitor sample zero handoff");
  readSameArtifactFile(retained.path, retained.identity, retained.label, 64 * 1024 * 1024, hooks);
  const expectedToken = freshLaunchMonitorHandoffToken(runId, {
    rawWindowDump: value.rawWindowDump,
    probeStartedAtMonotonicNs: value.probeStartedAtMonotonicNs,
    retainedAtMonotonicNs: value.retainedAtMonotonicNs,
  });
  if (value.handoffToken !== expectedToken) {
    throw new Error("fresh-launch monitor sample zero handoff token lost its descriptor/timing binding");
  }
  return { value: JSON.parse(canonicalJson(value)), retained };
}

function validateMonitor(
  monitor: FreshLaunchMonitorReceipt,
  runtime: LocomotionRuntimeBinding,
  expectedBoundaryMarker: string,
  runId: string,
  offeredHandoff: FreshLaunchMonitorHandoff | null,
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
  const sampleZero = monitor.samples[0];
  if (offeredHandoff === null
    || canonicalJson(monitor.rawWindowDumps[0]) !== canonicalJson(offeredHandoff.rawWindowDump)
    || sampleZero.windowProbeStartedAtMonotonicNs !== offeredHandoff.probeStartedAtMonotonicNs
    || sampleZero.windowRetainedAtMonotonicNs !== offeredHandoff.retainedAtMonotonicNs
    || sampleZero.windowHandoffToken !== offeredHandoff.handoffToken
    || freshLaunchMonitorHandoffToken(runId, {
      rawWindowDump: monitor.rawWindowDumps[0],
      probeStartedAtMonotonicNs: sampleZero.windowProbeStartedAtMonotonicNs,
      retainedAtMonotonicNs: sampleZero.windowRetainedAtMonotonicNs,
    }) !== sampleZero.windowHandoffToken) {
    throw new Error("fresh-launch monitor sample zero receipt does not reproduce the descriptor-bound observer handoff");
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

function checkedLaunchHandoffObservation(
  receipt: FreshLaunchHandoffObservationReceipt,
  artifactRoot: string,
  hooks: InAppLocomotionArtifactHooks,
): Array<{ path: string; identity: ArtifactFileIdentity; label: string }> {
  if (!Number.isSafeInteger(receipt?.maxSampleGapMs) || receipt.maxSampleGapMs < 1 || receipt.maxSampleGapMs > 10_000) {
    throw new Error("launch-handoff observation omitted one explicit bounded sampling cadence");
  }
  if (receipt.claim !== "no_blocking_dialog_at_retained_samples") {
    throw new Error("launch-handoff observation made an unsupported interval claim");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(receipt.startedAtMonotonicNs)
    || !/^(?:0|[1-9]\d*)$/.test(receipt.endedAtMonotonicNs)
    || BigInt(receipt.endedAtMonotonicNs) < BigInt(receipt.startedAtMonotonicNs)
    || !Array.isArray(receipt.samples) || receipt.samples.length < 2
    || !Array.isArray(receipt.rawWindowDumps) || receipt.rawWindowDumps.length !== receipt.samples.length) {
    throw new Error("launch-handoff observation interval/sample receipt is incomplete");
  }
  const startedNs = BigInt(receipt.startedAtMonotonicNs);
  const maxSampleGapNs = BigInt(receipt.maxSampleGapMs) * 1_000_000n;
  const retained: Array<{ path: string; identity: ArtifactFileIdentity; label: string }> = [];
  const allDialogs: string[] = [];
  let priorElapsed = -1;
  let priorObserved = -1n;
  for (const [index, sample] of receipt.samples.entries()) {
    const observedNs = /^(?:0|[1-9]\d*)$/.test(sample.observedAtMonotonicNs)
      ? BigInt(sample.observedAtMonotonicNs)
      : -1n;
    const observedGapNs = index === 0 ? observedNs - startedNs : observedNs - priorObserved;
    if (!Number.isSafeInteger(sample.elapsedMs) || sample.elapsedMs < 0 || sample.elapsedMs <= priorElapsed
      || (index > 0 && sample.elapsedMs - priorElapsed > receipt.maxSampleGapMs)
      || observedNs < startedNs || observedNs <= priorObserved || observedGapNs > maxSampleGapNs
      || BigInt(sample.elapsedMs) !== (observedNs - startedNs) / 1_000_000n) {
      throw new Error("launch-handoff observation exceeded its declared maximum sample gap or lost monotonic ordering");
    }
    if (canonicalJson(sample.rawWindowDump) !== canonicalJson(receipt.rawWindowDumps[index])) {
      throw new Error("launch-handoff observation raw-window index binding changed");
    }
    const item = checkedRawLogEvidence(sample.rawWindowDump, artifactRoot, `launch-handoff observation sample ${index}`);
    const dialogs = freshLaunchDialogs(readSameArtifactFile(
      item.path, item.identity, item.label, 64 * 1024 * 1024, hooks,
    ).toString("utf8"));
    if (canonicalJson(dialogs) !== canonicalJson(sample.dialogs)) {
      throw new Error("launch-handoff observation dialog claim does not reproduce from descriptor bytes");
    }
    allDialogs.push(...dialogs);
    retained.push(item);
    priorElapsed = sample.elapsedMs;
    priorObserved = observedNs;
  }
  if (new Set(retained.map((item) => `${item.identity.dev}:${item.identity.ino}`)).size !== retained.length) {
    throw new Error("launch-handoff observation samples must be unique exact files");
  }
  if (canonicalJson([...new Set(allDialogs)]) !== canonicalJson(receipt.dialogs)) {
    throw new Error("launch-handoff observation aggregate dialog claim changed");
  }
  const endedNs = BigInt(receipt.endedAtMonotonicNs);
  if (priorObserved > endedNs || endedNs - priorObserved > maxSampleGapNs) {
    throw new Error("launch-handoff observation end is not bound to its final retained sample");
  }
  if (allDialogs.length > 0) throw new LocomotionStageError("launch_dialog", "launch-handoff observation sampled a blocking dialog");
  return retained;
}

interface CaptureReviewExpectation {
  captureInput: CaptureSettledInput;
  captureInvocation: CaptureInvocationFence;
  phaseDeadlineNs: bigint;
  role: LocomotionReviewItem["role"];
  runtime: LocomotionRuntimeBinding;
  waypointSeq?: number;
}

function captureReview(
  captured: Awaited<ReturnType<InAppLocomotionDependencies["captureSettled"]>>,
  expectation: CaptureReviewExpectation,
): LocomotionReviewItem {
  const receipt = captured.receipt;
  const captureInput = expectation.captureInput;
  const expectedPath = captureInput.outPath;
  const expectedMode = captureInput.mode ?? "stable";
  const fail = (detail: string): never => {
    throw new Error(`${expectation.role} capture receipt is not exact settled-frame evidence: ${detail}`);
  };
  if (receipt.status !== "settled" || receipt.settlementSatisfied !== true
    || receipt.evidenceCeiling !== "structural" || receipt.lookRequired !== true
    || receipt.error !== null || receipt.timeoutPhase !== null || receipt.timeoutCause !== null
    || receipt.lastValidCaptureRef !== null || receipt.actionReceipts.length !== 0) {
    fail("status, settlement, timeout, error, or structural LOOK fields are inconsistent");
  }
  if (receipt.comparison !== captureInput.comparison || receipt.mode !== expectedMode) {
    fail(`resolved mode/comparison does not match requested ${expectedMode}/${captureInput.comparison} policy`);
  }
  if (receipt.deadlineMs !== captureInput.deadlineMs || receipt.attemptTimeoutMs !== captureInput.attemptTimeoutMs
    || !/^[1-9][0-9]*$/.test(receipt.deadlineMonotonicNs ?? "")) {
    fail("settlement deadlines do not exactly match the capture request");
  }
  const receiptDeadlineNs = BigInt(receipt.deadlineMonotonicNs!);
  if (receiptDeadlineNs > expectation.phaseDeadlineNs) {
    fail("settlement deadline exceeds the enclosing route phase deadline");
  }
  if (!SHA256.test(receipt.sha256 ?? "") || receipt.path !== expectedPath
    || receipt.serial !== expectation.runtime.liveIdentity.serial) {
    fail("final SHA, output path, or route serial changed");
  }
  const finalSha256 = receipt.sha256!;
  if (expectedMode === "transition_then_stable") {
    if (!SHA256.test(captureInput.priorSha256 ?? "")) fail("transition mode lacks its exact prior SHA");
    if (finalSha256 === captureInput.priorSha256) fail("transition result SHA is unchanged from the exact prior frame");
  } else if (captureInput.priorSha256 !== undefined) {
    fail("stable baseline unexpectedly supplied a prior SHA");
  }
  if (!receipt.stablePair || receipt.stablePair.length !== 2
    || receipt.stablePair[0] !== finalSha256 || receipt.stablePair[1] !== finalSha256) {
    fail("stablePair is not the exact adjacent final SHA pair");
  }
  if (!Number.isSafeInteger(receipt.attempts) || receipt.attempts < 2 || receipt.attempts > captureInput.maxTries
    || !Array.isArray(receipt.trace) || receipt.attempts !== receipt.trace.length) {
    fail("attempt count does not exactly bind the settlement trace");
  }
  let priorTraceNs: bigint | null = null;
  for (const [index, entry] of receipt.trace.entries()) {
    if (entry.attempt !== index + 1 || !/^(?:0|[1-9][0-9]*)$/.test(entry.capturedAtMonotonicNs)
      || !SHA256.test(entry.sha256)) {
      fail("trace attempts are not sequential valid frame observations");
    }
    if (entry.relation !== "prior" && entry.relation !== "candidate" && entry.relation !== "stable") {
      fail("trace contains an unknown settlement relation");
    }
    if (entry.relation === "stable" && index !== receipt.trace.length - 1) {
      fail("trace claims stability before its final observation");
    }
    const traceNs = BigInt(entry.capturedAtMonotonicNs);
    if ((priorTraceNs !== null && traceNs <= priorTraceNs) || traceNs >= receiptDeadlineNs) {
      fail("trace timestamps are not strictly increasing observations before the settlement deadline");
    }
    priorTraceNs = traceNs;
    if (entry.relation === "prior") {
      if (expectedMode !== "transition_then_stable" || entry.sha256 !== captureInput.priorSha256) {
        fail("trace prior relation is not bound to the exact requested prior SHA");
      }
    } else if (expectedMode === "transition_then_stable" && entry.sha256 === captureInput.priorSha256) {
      fail("trace labels the exact prior SHA as a transition candidate");
    }
  }
  const candidate = receipt.trace.at(-2)!;
  const stable = receipt.trace.at(-1)!;
  if (candidate.sha256 !== finalSha256 || candidate.relation !== "candidate"
    || stable.sha256 !== finalSha256 || stable.relation !== "stable") {
    fail("final trace entries are not the exact candidate/stable SHA pair");
  }
  const captureRef = receipt.captureRef;
  if (!captureRef) fail("settled receipt omitted captureRef");
  const exactCaptureRef = captureRef!;
  if (exactCaptureRef.path !== expectedPath || exactCaptureRef.path !== receipt.path
    || exactCaptureRef.sha256 !== finalSha256 || exactCaptureRef.sourceSerial !== expectation.runtime.liveIdentity.serial
    || !Number.isSafeInteger(exactCaptureRef.bytes) || exactCaptureRef.bytes < 1
    || !Number.isSafeInteger(exactCaptureRef.width) || exactCaptureRef.width < 1
    || !Number.isSafeInteger(exactCaptureRef.height) || exactCaptureRef.height < 1
    || exactCaptureRef.dimensions.width !== exactCaptureRef.width || exactCaptureRef.dimensions.height !== exactCaptureRef.height
    || !Number.isFinite(Date.parse(exactCaptureRef.capturedAt))) {
    fail("captureRef path/SHA/bytes/dimensions/source/timestamp is not exact");
  }
  const binding = receipt.captureRuntimeBinding;
  const routeIdentity = expectation.runtime.liveIdentity;
  if (!binding || binding.serial !== routeIdentity.serial || binding.captureSource !== CAPTURE_SOURCE
    || binding.liveIdentity.serial !== routeIdentity.serial
    || binding.liveIdentity.model !== routeIdentity.model
    || binding.liveIdentity.fingerprint !== routeIdentity.fingerprint
    || binding.liveIdentity.bootQemu !== routeIdentity.bootQemu
    || binding.liveIdentity.bootId !== routeIdentity.bootId
    || !Number.isFinite(Date.parse(binding.liveIdentity.observedAt))
    || !/^(?:0|[1-9][0-9]*)$/.test(binding.startedAtMonotonicNs)
    || !/^(?:0|[1-9][0-9]*)$/.test(binding.endedAtMonotonicNs)
    || BigInt(binding.endedAtMonotonicNs) < BigInt(binding.startedAtMonotonicNs)) {
    fail("capture runtime is not bound to the route serial/model/fingerprint/qemu/boot identity");
  }
  const captureStartedNs = BigInt(binding!.startedAtMonotonicNs);
  const captureEndedNs = BigInt(binding!.endedAtMonotonicNs);
  const invocation = expectation.captureInvocation;
  if (!/^(?:0|[1-9][0-9]*)$/.test(invocation.phaseStartedAtMonotonicNs)
    || !/^(?:0|[1-9][0-9]*)$/.test(invocation.admittedAtMonotonicNs)
    || !/^(?:0|[1-9][0-9]*)$/.test(invocation.completedAtMonotonicNs)
    || !/^(?:0|[1-9][0-9]*)$/.test(invocation.phaseDeadlineMonotonicNs)) {
    fail("route capture invocation fence is not an exact monotonic interval");
  }
  const phaseStartedNs = BigInt(invocation.phaseStartedAtMonotonicNs);
  const admittedAtNs = BigInt(invocation.admittedAtMonotonicNs);
  const completedAtNs = BigInt(invocation.completedAtMonotonicNs);
  const invocationDeadlineNs = BigInt(invocation.phaseDeadlineMonotonicNs);
  const requestedDurationNs = BigInt(captureInput.deadlineMs!) * 1_000_000n;
  if (receiptDeadlineNs < requestedDurationNs) fail("settlement deadline cannot encode its exact requested duration");
  const settleStartedNs = receiptDeadlineNs - requestedDurationNs;
  if (invocationDeadlineNs !== expectation.phaseDeadlineNs
    || phaseStartedNs > admittedAtNs || admittedAtNs >= invocationDeadlineNs
    || completedAtNs < admittedAtNs || completedAtNs >= invocationDeadlineNs
    || captureStartedNs < admittedAtNs || captureEndedNs > completedAtNs
    || settleStartedNs < captureStartedNs) {
    fail("capture runtime and settlement are outside the exact route invocation/phase fence");
  }
  if (receipt.trace.some((entry) => {
    const observedNs = BigInt(entry.capturedAtMonotonicNs);
    return observedNs < captureStartedNs || observedNs < settleStartedNs || observedNs > captureEndedNs;
  })) {
    fail("settlement trace falls outside the exact capture runtime/settle interval");
  }
  const frame = captured.frame;
  if (!Buffer.isBuffer(frame)) fail("settled receipt omitted its returned frame bytes");
  const validatedFrame = validateCaptureBuffer(frame!, expectedPath);
  if (!validatedFrame.ok || validatedFrame.format !== "png"
    || validatedFrame.sha256 !== finalSha256 || validatedFrame.bytes !== exactCaptureRef.bytes
    || validatedFrame.width !== exactCaptureRef.width || validatedFrame.height !== exactCaptureRef.height) {
    fail(validatedFrame.ok ? "returned frame bytes do not match captureRef" : validatedFrame.reason ?? "returned frame is invalid");
  }
  return {
    captureSha256: finalSha256,
    role: expectation.role,
    ...(expectation.waypointSeq === undefined ? {} : { waypointSeq: expectation.waypointSeq }),
    settled: true,
    path: expectedPath,
  };
}

function validateRetainedCaptureFrame(
  captured: Awaited<ReturnType<InAppLocomotionDependencies["captureSettled"]>>,
  retained: Buffer,
  role: LocomotionReviewItem["role"],
): void {
  if (!Buffer.isBuffer(captured.frame) || !Buffer.isBuffer(retained) || !captured.frame.equals(retained)) {
    throw new Error(`${role} retained capture bytes differ from the exact settled frame returned by the capture primitive`);
  }
}

function preparationFailure(
  code: string,
  error: unknown,
  runId: string | null,
  artifactRoot: string | null,
  cleanupError: string | null,
  actionMaintenance?: LocomotionActionAuditMaintenance,
): LocomotionPrepareReceipt {
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
    ...(actionMaintenance === undefined ? {} : { actionAuditMaintenance: actionMaintenance }),
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
  const sequencesStrictlyIncreasing = BigInt(baseline.sampleSequence) < BigInt(pre.sampleSequence)
    && BigInt(pre.sampleSequence) < BigInt(post.sampleSequence);
  const observationTimesStrictlyIncreasing = BigInt(baseline.sampleObservedAtMonotonicNs) < BigInt(pre.sampleObservedAtMonotonicNs)
    && BigInt(pre.sampleObservedAtMonotonicNs) < BigInt(post.sampleObservedAtMonotonicNs);
  const readTimesStrictlyIncreasing = BigInt(baseline.readAtMonotonicNs) < BigInt(pre.readAtMonotonicNs)
    && BigInt(pre.readAtMonotonicNs) < BigInt(post.readAtMonotonicNs);
  const baselineAgeMs = hmdSampleAgeMs(baseline);
  const preAgeMs = hmdSampleAgeMs(pre);
  const postAgeMs = hmdSampleAgeMs(post);
  return {
    freshness: {
      method: "guest_listener_arrival_age_and_strict_sequence_and_time",
      maximumSampleAgeMs: IN_APP_LOCOMOTION_HMD_MAX_SAMPLE_AGE_MS,
      baseline: {
        sampleSequence: baseline.sampleSequence,
        sampleObservedAtMonotonicNs: baseline.sampleObservedAtMonotonicNs,
        readAtMonotonicNs: baseline.readAtMonotonicNs,
        sampleAgeMs: baselineAgeMs,
      },
      pre: {
        sampleSequence: pre.sampleSequence,
        sampleObservedAtMonotonicNs: pre.sampleObservedAtMonotonicNs,
        readAtMonotonicNs: pre.readAtMonotonicNs,
        sampleAgeMs: preAgeMs,
      },
      post: {
        sampleSequence: post.sampleSequence,
        sampleObservedAtMonotonicNs: post.sampleObservedAtMonotonicNs,
        readAtMonotonicNs: post.readAtMonotonicNs,
        sampleAgeMs: postAgeMs,
      },
      sequencesStrictlyIncreasing,
      observationTimesStrictlyIncreasing,
      readTimesStrictlyIncreasing,
      pass: sequencesStrictlyIncreasing && observationTimesStrictlyIncreasing && readTimesStrictlyIncreasing
        && Math.max(baselineAgeMs, preAgeMs, postAgeMs) <= IN_APP_LOCOMOTION_HMD_MAX_SAMPLE_AGE_MS,
    },
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

function validateStateArtifactsWithoutMaintenance(
  state: LocomotionState,
  hooks: InAppLocomotionArtifactHooks = {},
): void {
  validateOwnedArtifactsWithoutMaintenance(state.artifact, hooks);
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
    actionAuditMaintenance: actionAuditMaintenance(state.artifact),
  };
}

function priorForegroundDispositionFor(
  input: InAppLocomotionPrepareInput,
  receiptFreshness: LocomotionPriorForegroundDisposition["receiptFreshness"],
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
      receiptFreshness,
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
  return priorForegroundDispositionFor(
    state.input,
    state.priorTerminatedByRun ? "known_stale" : "not_evaluated_cp1",
  );
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
    restorationDisposition: "review_rejected",
    actionAuditMaintenance: actionAuditMaintenance(state.artifact),
  };
}

function earlierDeadline(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function deadlineBefore(deadlineNs: bigint, reserveMs: number): bigint {
  return deadlineNs - BigInt(reserveMs) * 1_000_000n;
}

function remainingUntilMs(deadlineNs: bigint, dependencies: InAppLocomotionDependencies): number {
  const deltaNs = deadlineNs - checkedMonotonic(dependencies);
  if (deltaNs >= 0n) return Number(deltaNs / 1_000_000n);
  return -Number((-deltaNs + 999_999n) / 1_000_000n);
}

async function withinDeadline<T>(
  deadlineNs: bigint,
  dependencies: InAppLocomotionDependencies,
  label: string,
  operation: (remainingMs: number) => Promise<T>,
): Promise<T> {
  const admittedAtNs = checkedMonotonic(dependencies);
  if (admittedAtNs >= deadlineNs) {
    throw new LocomotionStageError("budget_exhausted", `${label} cannot begin at or after its fixed phase deadline`);
  }
  const before = Number((deadlineNs - admittedAtNs) / 1_000_000n);
  if (before < 1) throw new LocomotionStageError("budget_exhausted", `${label} cannot begin at or after its fixed phase deadline`);
  const value = await operation(before);
  if (checkedMonotonic(dependencies) >= deadlineNs) {
    throw new LocomotionStageError("budget_exhausted", `${label} exceeded its fixed phase deadline`);
  }
  return value;
}

interface CaptureInvocationFence {
  phaseStartedAtMonotonicNs: string;
  admittedAtMonotonicNs: string;
  completedAtMonotonicNs: string;
  phaseDeadlineMonotonicNs: string;
}

interface CaptureInvocationState {
  captureInput: CaptureSettledInput | null;
  fence: CaptureInvocationFence | null;
  receipt: CaptureSettledReceipt | null;
}

async function captureWithinDeadline(
  phaseStartedNs: bigint,
  phaseDeadlineNs: bigint,
  dependencies: InAppLocomotionDependencies,
  label: string,
  state: CaptureInvocationState,
  buildInput: (remainingMs: number) => CaptureSettledInput,
  hostWindowBinding?: BoundQemuWindow,
): Promise<{ receipt: CaptureSettledReceipt; frame: Buffer | null }> {
  const admittedAtNs = checkedMonotonic(dependencies);
  if (admittedAtNs < phaseStartedNs) {
    throw new LocomotionStageError("clock_failed", `${label} route clock regressed before capture admission`);
  }
  if (admittedAtNs >= phaseDeadlineNs) {
    throw new LocomotionStageError("budget_exhausted", `${label} cannot begin at or after its fixed phase deadline`);
  }
  const remainingMs = Number((phaseDeadlineNs - admittedAtNs) / 1_000_000n);
  if (remainingMs < 1) {
    throw new LocomotionStageError("budget_exhausted", `${label} cannot begin at or after its fixed phase deadline`);
  }
  state.captureInput = buildInput(remainingMs);
  let captured: { receipt: CaptureSettledReceipt; frame: Buffer | null };
  try {
    captured = await dependencies.captureSettled(state.captureInput, { hostWindowBinding });
  } catch (error) {
    try {
      const completedAtNs = checkedMonotonic(dependencies);
      state.fence = {
        phaseStartedAtMonotonicNs: phaseStartedNs.toString(),
        admittedAtMonotonicNs: admittedAtNs.toString(),
        completedAtMonotonicNs: completedAtNs.toString(),
        phaseDeadlineMonotonicNs: phaseDeadlineNs.toString(),
      };
    } catch {
      // The capture dependency's primary failure remains authoritative when the
      // completion-clock probe also fails.
    }
    throw error;
  }
  state.receipt = captured.receipt;
  const completedAtNs = checkedMonotonic(dependencies);
  state.fence = {
    phaseStartedAtMonotonicNs: phaseStartedNs.toString(),
    admittedAtMonotonicNs: admittedAtNs.toString(),
    completedAtMonotonicNs: completedAtNs.toString(),
    phaseDeadlineMonotonicNs: phaseDeadlineNs.toString(),
  };
  if (completedAtNs < admittedAtNs) {
    throw new LocomotionStageError("clock_failed", `${label} route clock regressed across capture completion`);
  }
  if (completedAtNs >= phaseDeadlineNs) {
    throw new LocomotionStageError("budget_exhausted", `${label} exceeded its fixed phase deadline`);
  }
  return captured;
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
    stabilityReads: BRIDGE_STABILITY_READS,
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
): {
  retained: { path: string; identity: ArtifactFileIdentity; label: string };
  targetAbsent: boolean;
  priorForegroundSatisfied: boolean;
  problem: string | null;
} {
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
  const targetAbsent = receipt.targetPids.length === 0
    && !receipt.resumedComponents.some((component) => component.startsWith(`${input.scenario.packageName}/`));
  const priorForegroundSatisfied = input.priorForeground.kind !== "non_receipt_bound"
    || (receipt.resumedComponents.length === 1 && receipt.resumedComponents[0] === input.priorForeground.component);
  let problem: string | null = null;
  if (!targetAbsent) {
    problem = "final process/activity proof shows the run-owned target still running or resumed";
  } else if (!priorForegroundSatisfied) {
    problem = "final process/activity proof did not show the one exact relaunched non-receipt prior component";
  }
  return { retained, targetAbsent, priorForegroundSatisfied, problem };
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
  const windowBindings = new WeakMap<LocomotionHostWindowEvidence, BoundQemuWindow>();
  const preparationStarts = new WeakMap<LocomotionHostWindowEvidence, bigint>();
  const hostWindowApplies = (): boolean => (dependencies.platform ?? process.platform) === "darwin";

  const observeHostWindow = async (
    serial: string,
    evidence: LocomotionHostWindowEvidence,
    phase: string,
    retainedProbe?: HostWindowProbe,
  ): Promise<void> => {
    let probe: HostWindowProbe;
    try {
      const binding = windowBindings.get(evidence);
      probe = !hostWindowApplies()
        ? { ...unavailableHostWindowProbe("host window visibility is not applicable on this platform"), status: "not_applicable" }
        : retainedProbe ?? (!binding
          ? unavailableHostWindowProbe(evidence.hostWindowProbe.detail ?? "host window binding is unavailable")
          : dependencies.probeHostWindow
            ? await dependencies.probeHostWindow(serial, binding)
            : unavailableHostWindowProbe("host window probe dependency is unavailable", binding));
    } catch (error) {
      probe = unavailableHostWindowProbe(errorText(error));
    }
    evidence.hostWindowProbe = structuredClone(probe);
    evidence.hostWindowProbes.push({ phase, probe: structuredClone(probe) });
  };
  const assertHostWindow = (evidence: LocomotionHostWindowEvidence): void => {
    const failure = hostWindowPrecondition(evidence.hostWindowProbe);
    if (failure) throw new LocomotionStageError(failure.code, failure.detail);
  };
  const requireHostWindow = async (
    serial: string,
    evidence: LocomotionHostWindowEvidence,
    phase: string,
    deadlineNs: bigint,
    retainedProbe?: HostWindowProbe,
  ): Promise<void> => {
    await observeHostWindow(serial, evidence, phase, retainedProbe);
    assertHostWindow(evidence);
    if (checkedMonotonic(dependencies) >= deadlineNs) {
      throw new LocomotionStageError("budget_exhausted", `${phase} host window probe exhausted the admitted deadline`);
    }
  };
  const initialHostWindowEvidence = async (serial: string, phase: string, initialBinding?: BoundQemuWindow): Promise<LocomotionHostWindowEvidence> => {
    const evidence: LocomotionHostWindowEvidence = {
      hostWindowFocusRequest: null,
      hostWindowProbe: unavailableHostWindowProbe("host window has not been sampled"),
      hostWindowProbes: [],
    };
    if (phase === "prepare_preflight") preparationStarts.set(evidence, checkedMonotonic(dependencies));
    if (!hostWindowApplies()) {
      evidence.hostWindowFocusRequest = {
        status: "not_applicable", error: null, qemuWindowId: null, qemuWindowOwnerPid: null, durationMs: 0,
      };
    } else {
      let binding = initialBinding;
      try {
        if (!binding && phase === "prepare_preflight") {
          const selected = dependencies.bindQemuWindow ? await dependencies.bindQemuWindow(serial) : null;
          if (!selected?.ok) throw new Error(selected?.detail ?? "host window binding dependency is unavailable");
          binding = selected.binding;
        }
        if (!binding || binding.discoveredSerial !== serial) throw new Error("the run has no exact serial-bound host window");
        windowBindings.set(evidence, binding);
        const startedNs = dependencies.monotonicNs();
        let error: string | null;
        try {
          error = dependencies.focusQemuWindow ? await dependencies.focusQemuWindow(binding) : "host window focus dependency is unavailable";
        } catch (cause) {
          error = errorText(cause);
        }
        evidence.hostWindowFocusRequest = {
          status: error ? "failed" : "requested", error,
          qemuWindowId: binding.qemuWindowId, qemuWindowOwnerPid: binding.qemuWindowOwnerPid,
          durationMs: Math.max(0, Number(dependencies.monotonicNs() - startedNs) / 1_000_000),
        };
      } catch (error) {
        evidence.hostWindowProbe = unavailableHostWindowProbe(errorText(error), binding);
      }
    }
    await observeHostWindow(serial, evidence, phase);
    return evidence;
  };
  const executeWithHostWindowEvidence = async (
    serial: string,
    phase: string,
    action: (evidence: LocomotionHostWindowEvidence) => Promise<Record<string, any>>,
    initialBinding?: BoundQemuWindow,
  ): Promise<Record<string, any>> => {
    const evidence = await initialHostWindowEvidence(serial, phase, initialBinding);
    try {
      return { ...await action(evidence), ...evidence };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(errorText(cause));
      Object.assign(error, { hostWindowEvidence: structuredClone(evidence) });
      throw error;
    }
  };

  const executePrepare = async (
    input: InAppLocomotionPrepareInput,
    hostWindows: LocomotionHostWindowEvidence,
  ): Promise<LocomotionPrepareReceipt> => {
    let authority: ReceiptAndSpecBinding;
    try {
      assertHostWindow(hostWindows);
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
    let priorStopAttemptedByRun = false;
    let priorStopCommandCompletedByRun = false;
    let priorPidAbsenceProvenByRun = false;
    const prepareClearanceEvidence: Array<LocomotionPrepareClearanceReceipt | LocomotionPrepareClearanceProgress> = [];
    let prepareActionDeadlineNs: bigint | null = null;
    let prepareDeadlineNs: bigint | null = null;
    let recoveryDeadlineNs: bigint | null = null;
    let recoveryWorkDeadlineNs: bigint | null = null;
    let leaseAcquired = false;
    let preparationBegan = false;
    let preparationFinalizationAttempted = false;
    let preparationLogEvidence: LocomotionLogEvidence | null = null;
    let freshLaunchMonitor: FreshLaunchMonitorReceipt | null = null;
    let launchHandoffWindow: FreshLaunchHandoffReceipt | null = null;
    let retainedLaunchHandoff: { path: string; identity: ArtifactFileIdentity; label: string } | null = null;
    let launchHandoffObservation: FreshLaunchHandoffObservationReceipt | null = null;
    let retainedHandoffObservation: Array<{ path: string; identity: ArtifactFileIdentity; label: string }> = [];
    let launchHandoffController: AbortController | null = null;
    let launchHandoffPromise: Promise<FreshLaunchHandoffObservationReceipt> | null = null;
    let monitorHandoff: FreshLaunchMonitorHandoff | null = null;
    let healthBoundaryMarker: string | null = null;
    let baselineCaptureReceipt: CaptureSettledReceipt | null = null;
    const baselineHmdAcquisition = hmdAcquisitionEvidence();
    const baselineCaptureInvocation: CaptureInvocationState = { captureInput: null, fence: null, receipt: null };
    let postCaptureContinuity: ApplicationContinuitySample | null = null;
    let postCaptureCapability: CapabilityResult | null = null;

    const stopForPrepareClearance = async (
      stopInput: { serial: string; packageName: string; reason: string } & LocomotionEffectBudget,
    ): Promise<LocomotionTargetStopReceipt> => {
      const stopsObservedPrior = prior.packageName === stopInput.packageName;
      if (stopsObservedPrior) priorStopAttemptedByRun = true;
      try {
        const returned = await dependencies.stopPackage(stopInput);
        const record = returned !== null && typeof returned === "object" && !Array.isArray(returned)
          ? returned as unknown as Record<string, unknown>
          : null;
        if (record?.status === "stop_command_completed") {
          const stopReceipt = checkedTargetStopReceipt(returned, stopInput);
          prepareClearanceEvidence.push({ status: "prepare_clearance_incomplete", stopReceipt, pidAbsence: null });
          if (stopsObservedPrior) priorStopCommandCompletedByRun = true;
          throw new Error("prepare clearance omitted the exact clean PID-absence receipt");
        }
        const stopReceipt = checkedTargetStopReceipt(record?.stopReceipt, stopInput);
        if (stopsObservedPrior) priorStopCommandCompletedByRun = true;
        let stopped: LocomotionPrepareClearanceReceipt;
        try {
          stopped = checkedPrepareClearanceReceipt(returned, stopInput);
        } catch (error) {
          prepareClearanceEvidence.push({ status: "prepare_clearance_incomplete", stopReceipt, pidAbsence: null });
          throw error;
        }
        prepareClearanceEvidence.push(stopped);
        if (stopsObservedPrior) {
          priorStopCommandCompletedByRun = true;
          priorPidAbsenceProvenByRun = true;
          priorTerminatedByRun = true;
        }
        return stopped.stopReceipt;
      } catch (error) {
        if (error instanceof LocomotionStopClearanceError) {
          const stopReceipt = checkedTargetStopReceipt(error.stopReceipt, stopInput);
          const progress: LocomotionPrepareClearanceProgress = {
            status: "prepare_clearance_incomplete",
            stopReceipt,
            pidAbsence: null,
          };
          prepareClearanceEvidence.push(progress);
          if (stopsObservedPrior) priorStopCommandCompletedByRun = true;
          if (error.pidAbsence !== null) {
            progress.pidAbsence = checkedCleanPidAbsenceReceipt(error.pidAbsence, stopInput);
            if (stopsObservedPrior) priorPidAbsenceProvenByRun = true;
          }
          throw error.clearanceError;
        }
        throw error;
      }
    };

    const finishLaunchHandoffObservation = async (offered?: FreshLaunchMonitorHandoff): Promise<void> => {
      if (offered !== undefined) {
        if (!artifact) throw new Error("fresh-launch monitor sample zero handoff lost its owned artifact session");
        if (monitorHandoff !== null) throw new Error("fresh-launch monitor sample zero handoff callback ran more than once");
        monitorHandoff = validateFreshLaunchMonitorHandoff(offered, artifact.runId, artifact.absoluteRoot, hooks).value;
      }
      const pending = launchHandoffPromise;
      if (pending === null) return;
      launchHandoffPromise = null;
      launchHandoffController?.abort();
      launchHandoffController = null;
      launchHandoffObservation = await pending;
      if (!artifact) throw new Error("launch-handoff observation lost its owned artifact session");
      retainedHandoffObservation = checkedLaunchHandoffObservation(launchHandoffObservation, artifact.absoluteRoot, hooks);
      if (offered !== undefined) {
        const finalObservedNs = BigInt(launchHandoffObservation.samples.at(-1)!.observedAtMonotonicNs);
        const retainedNs = BigInt(offered.retainedAtMonotonicNs);
        const maxGapNs = BigInt(launchHandoffObservation.maxSampleGapMs) * 1_000_000n;
        if (finalObservedNs < retainedNs || finalObservedNs - retainedNs > maxGapNs) {
          throw new Error("launch-handoff observer final retained sample did not cover monitor sample zero retention within its declared cadence");
        }
      }
    };

    const finalizePreparationBracket = async (strictDeadline: boolean): Promise<LocomotionLogEvidence | null> => {
      if (!artifact || !preparationBegan || preparationFinalizationAttempted) return preparationLogEvidence;
      preparationFinalizationAttempted = true;
      const beginMarker = `PICO_LOCOMOTION_${artifact.runId.slice(0, 16)}_PREPARE_BEGIN`;
      const endMarker = `PICO_LOCOMOTION_${artifact.runId.slice(0, 16)}_PREPARE_END`;
      const activeDeadlineNs = strictDeadline
        ? prepareDeadlineNs
        : recoveryWorkDeadlineNs ?? recoveryDeadlineNs ?? prepareDeadlineNs;
      const remaining = () => activeDeadlineNs === null ? 1 : Math.max(1, remainingUntilMs(activeDeadlineNs, dependencies));
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
          deadlineMonotonicNs: (activeDeadlineNs ?? 0n).toString(),
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
        deadlineMonotonicNs: (activeDeadlineNs ?? 0n).toString(),
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
      const reserved = reserveArtifacts(input, dependencies, preparationStarts.get(hostWindows));
      artifact = reserved.binding;
      healthBoundaryMarker = `PICO_LOCOMOTION_${artifact.runId.slice(0, 16)}_PREPARE_BEGIN`;
      const deadlineNs = reserved.startedAtNs + BigInt(input.budgets.maxDurationMs) * 1_000_000n;
      recoveryDeadlineNs = deadlineNs;
      recoveryWorkDeadlineNs = deadlineBefore(
        recoveryDeadlineNs,
        FINAL_ACTION_PUBLICATION_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      serialOwners.set(input.serial, { runId: artifact.runId, status: "active", reason: "prepare lifecycle active" });
      leaseAcquired = true;
      prepareActionDeadlineNs = deadlineNs
        - BigInt(input.budgets.routeReserveMs + input.budgets.restorationReserveMs) * 1_000_000n;
      prepareDeadlineNs = deadlineBefore(
        prepareActionDeadlineNs,
        PREPARE_ACTION_PUBLICATION_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
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
      await withinDeadline(prepareDeadlineNs, dependencies, "target clearance", async (timeoutMs) => {
        const stopInput = {
          serial: input.serial,
          packageName: input.scenario.packageName,
          reason: "prepare_target_clearance",
          timeoutMs,
          deadlineMonotonicNs: prepareDeadlineNs!.toString(),
        };
        return stopForPrepareClearance(stopInput);
      });
      if (prior.packageName && prior.packageName !== input.scenario.packageName) {
        priorStopMayHaveApplied = true;
        await withinDeadline(prepareDeadlineNs, dependencies, "declared incumbent clearance", async (timeoutMs) => {
          const stopInput = {
            serial: input.serial,
            packageName: prior.packageName!,
            reason: "prepare_declared_incumbent_clearance",
            timeoutMs,
            deadlineMonotonicNs: prepareDeadlineNs!.toString(),
          };
          return stopForPrepareClearance(stopInput);
        });
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
      launchHandoffController = new AbortController();
      launchHandoffPromise = dependencies.observeLaunchHandoff({
        serial: input.serial,
        runId: artifact.runId,
        artifactRoot: artifact.absoluteRoot,
        packageName: input.scenario.packageName,
        signal: launchHandoffController.signal,
        timeoutMs: Math.max(1, remainingUntilMs(prepareDeadlineNs, dependencies)),
        deadlineMonotonicNs: prepareDeadlineNs.toString(),
      });
      void launchHandoffPromise.catch(() => undefined);
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
      await requireHostWindow(input.serial, hostWindows, "prepare_before_hmd", prepareDeadlineNs);
      const hmd = await acquireFreshHmdPose(dependencies, prepareDeadlineNs, "baseline HMD pose", {
        serial: input.serial,
        packageName: input.scenario.packageName,
        requestId: `prepare_hmd_pose_${artifact!.runId.slice(0, 24)}`,
        tag: "prepare",
        expectedRootGeneration: root.generation,
        expectedRootIncarnation: root.incarnation,
      }, baselineHmdAcquisition, 60_001 + input.capture.deadlineMs + BRIDGE_MIN_TRANSACTION_MS);
      if (remainingUntilMs(prepareDeadlineNs, dependencies) < 60_001 + input.capture.deadlineMs + BRIDGE_MIN_TRANSACTION_MS) {
        throw new LocomotionStageError(
          "budget_exhausted",
          "prepare phase cannot preserve the mandatory >=60 second monitor, baseline capture, and post-capture capability recheck",
        );
      }
      freshLaunchMonitor = await withinDeadline(prepareDeadlineNs, dependencies, "fresh-launch monitor", (timeoutMs) => dependencies.monitorFreshLaunch({
        serial: input.serial,
        runId: artifact!.runId,
        artifactRoot: artifact!.absoluteRoot,
        minimumDurationMs: 60_000,
        healthBoundaryMarker: healthBoundaryMarker!,
        runtime,
        onFirstWindowSample: finishLaunchHandoffObservation,
        timeoutMs,
        deadlineMonotonicNs: prepareDeadlineNs!.toString(),
      }));
      validateMonitor(freshLaunchMonitor, runtime, healthBoundaryMarker, artifact.runId, monitorHandoff);
      const retainedHealthLogs = freshLaunchMonitor.rawHealthLogs.map((log, index) =>
        checkedRawLogEvidence(log, artifact!.absoluteRoot, `fresh-launch runtime-health log ${index + 1}`));
      const retainedWindowDumps = freshLaunchMonitor.rawWindowDumps.map((dump, index) =>
        checkedRawLogEvidence(dump, artifact!.absoluteRoot, `fresh-launch raw window dump ${index + 1}`));
      if (new Set(retainedHealthLogs.map((log) => `${log.identity.dev}:${log.identity.ino}`)).size !== retainedHealthLogs.length) {
        throw new Error("fresh-launch monitor raw runtime-health logs must be unique exact files");
      }
      const allMonitorArtifacts = [retainedLaunchHandoff, ...retainedHandoffObservation, ...retainedHealthLogs, ...retainedWindowDumps];
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
      const captured = await captureWithinDeadline(
        reserved.startedAtNs,
        prepareDeadlineNs,
        dependencies,
        "baseline settled capture",
        baselineCaptureInvocation,
        (remainingMs) => {
          const captureBudgetMs = remainingMs - BRIDGE_MIN_TRANSACTION_MS - 1;
          if (captureBudgetMs < 1) throw new LocomotionStageError("budget_exhausted", "baseline capture cannot fit strictly before the prepare deadline");
          return {
            serial: input.serial,
            outPath: baselinePath,
            maxTries: input.capture.maxTries,
            intervalMs: input.capture.intervalMs,
            attemptTimeoutMs: Math.min(input.capture.attemptTimeoutMs, captureBudgetMs),
            deadlineMs: Math.min(input.capture.deadlineMs, captureBudgetMs),
            comparison: "byte_exact",
            mode: "stable",
          };
        },
        windowBindings.get(hostWindows),
      );
      const baselineCaptureInput = baselineCaptureInvocation.captureInput;
      const baselineCaptureFence = baselineCaptureInvocation.fence;
      if (!baselineCaptureInput || !baselineCaptureFence) throw new Error("baseline capture request/invocation was not retained");
      baselineCaptureReceipt = captured.receipt;
      await requireHostWindow(input.serial, hostWindows, "prepare_after_capture", prepareDeadlineNs, captured.receipt.hostWindowProbe);
      const review = captureReview(captured, {
        captureInput: baselineCaptureInput,
        captureInvocation: baselineCaptureFence,
        phaseDeadlineNs: prepareDeadlineNs,
        role: "app_baseline",
        runtime,
      });
      validateRetainedCaptureFrame(captured, dependencies.readReviewImage(review, artifact.absoluteRoot), "app_baseline");
      postCaptureContinuity = await withinDeadline(prepareDeadlineNs, dependencies, "post-baseline-capture continuity", (timeoutMs) =>
        dependencies.sampleContinuity({
          serial: input.serial,
          phase: "prepare_post_capture",
          runtime,
          artifactRoot: artifact!.absoluteRoot,
          timeoutMs,
          deadlineMonotonicNs: prepareDeadlineNs!.toString(),
        }));
      const postCaptureContinuityProblem = continuityProblem(postCaptureContinuity, runtime);
      if (postCaptureContinuityProblem) throw new LocomotionStageError("binding_lost", postCaptureContinuityProblem);
      postCaptureCapability = await withinDeadline(prepareDeadlineNs, dependencies, "post-baseline-capture root capability", (timeoutMs) =>
        dependencies.probeCapability({
          serial: input.serial,
          packageName: input.scenario.packageName,
          requestId: `prepare_post_capture_${artifact!.runId.slice(0, 20)}`,
          tag: "prepare-post-capture",
          ...bridgeBudgetFields(timeoutMs, prepareDeadlineNs!),
        }));
      if (!postCaptureCapability.ok) {
        throw new LocomotionStageError(
          postCaptureCapability.code,
          postCaptureCapability.primaryError ?? postCaptureCapability.detail,
          postCaptureCapability.cleanupError,
        );
      }
      const postCaptureRoot = postCaptureCapability.ack.root;
      if (!postCaptureRoot || postCaptureRoot.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID
        || postCaptureRoot.generation !== root.generation || postCaptureRoot.incarnation !== root.incarnation) {
        throw new LocomotionStageError(
          "binding_lost",
          "post-baseline-capture root capability lost the exact generation/incarnation producer identity",
        );
      }
      const preparationLog = await finalizePreparationBracket(true);
      if (!preparationLog) throw new Error("preparation launch-handoff bracket was not retained");
      const state: LocomotionState = {
        hostWindowBinding: windowBindings.get(hostWindows),
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
        lastHmdSample: hmd,
        currentReview: review,
        requiredReview: [review],
        retainedLogs: [{
          path: preparationLog.path,
          identity: artifactFileIdentity(preparationLog.path, "retained preparation log", 64 * 1024 * 1024, hooks),
          label: "retained preparation log",
        }, retainedLaunchHandoff, ...retainedHandoffObservation, ...retainedHealthLogs, ...retainedWindowDumps],
        nextWaypoint: 0,
        startedAtNs: reserved.startedAtNs,
        deadlineNs,
        usage: { waypointAttempts: 0, successfulWaypoints: 0, routeDurationMs: 0 },
        restoreAttempts: 0,
        restoreCompleted: false,
        completedRestore: null,
        terminalSafeRelease: null,
        priorRestoreProofDisposition: null,
        zeroOffsetRecoveryProven: false,
        nonzeroMutationMayHaveApplied: false,
        adjudicated: false,
        currentReviewReflectsNonzeroMutation: false,
        unquiescedLocomotion: null,
        pendingLocomotionNonce: null,
        actionAuditConflict: false,
      };
      if (runs.has(artifact.runId)) throw new Error("run identifier collision");
      const actionAudit = appendAction(artifact, {
        action: "prepare",
        ...hostWindows,
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
        hmdBaselineAcquisition: baselineHmdAcquisition,
        freshLaunchMonitor,
        launchHandoffWindow,
        launchHandoffObservation,
        preparationLogEvidence: preparationLog,
        captureReceipt: baselineCaptureReceipt,
        captureInvocation: baselineCaptureInvocation.fence,
        postCaptureContinuity,
        postCaptureCapability,
        observedPriorForeground: prior,
        prepareClearanceEvidence,
        serialLease: { status: "active", reason: "reviewed route requires restore" },
        rootGeneration: root.generation,
        rootIncarnation: root.incarnation,
        captureSha256: review.captureSha256,
      }, hooks, {
        deadlineNs: prepareActionDeadlineNs,
        monotonicNs: () => checkedMonotonic(dependencies),
        label: "prepare action publication",
      });
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
        actionAuditMaintenance: actionAudit,
      };
    } catch (error) {
      const completedPrepareActionCommitted = error instanceof ActionPublicationFenceError && error.committed;
      const cleanupErrors: string[] = [];
      if (launchHandoffPromise !== null) {
        try { await finishLaunchHandoffObservation(); } catch (handoffError) {
          cleanupErrors.push(`launch-handoff observation finalization: ${errorText(handoffError)}`);
        }
      }
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
          const deadline = recoveryWorkDeadlineNs ?? recoveryDeadlineNs;
          const remaining = remainingUntilMs(deadline, dependencies);
          if (remaining < 1_000) throw new Error(`${label} cannot begin within the reserved recovery deadline`);
          return {
            timeoutMs: Math.min(10_000, remaining),
            deadlineMonotonicNs: deadline.toString(),
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
          const stopInput = {
            serial: input.serial,
            packageName: input.scenario.packageName,
            reason: "prepare_failure_cleanup",
            ...recoveryBudget("prepare target cleanup"),
          };
          const receipt = checkedTargetStopReceipt(await dependencies.stopPackage(stopInput), stopInput);
          compensation.targetStop = receipt;
          targetCleanupProven = true;
        } catch (cleanup) {
          compensation.targetStop = { status: "failed", error: errorText(cleanup) };
          cleanupErrors.push(errorText(cleanup));
        }
      }
      const priorReceiptFreshness: LocomotionPriorForegroundDisposition["receiptFreshness"] = priorPidAbsenceProvenByRun
        ? "known_stale"
        : priorStopAttemptedByRun || priorStopCommandCompletedByRun
          ? "unknown_after_stop_attempt"
          : "not_evaluated_cp1";
      const priorDisposition = priorForegroundDispositionFor(input, priorReceiptFreshness);
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
            evidenceId: "prepare-failure",
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
      let failureActionMaintenance: LocomotionActionAuditMaintenance | undefined;
      if (artifact) {
        try {
          failureActionMaintenance = appendAction(artifact, {
            action: "prepare",
            ...hostWindows,
            status: "failed",
            ...(completedPrepareActionCommitted
              ? { compensatesActionOperationId: "prepare:terminal" }
              : {}),
            structuralStop: code,
            primaryError: errorText(error),
            cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
            observedPriorForeground: prior,
            priorForeground: priorDisposition,
            prepareClearanceEvidence,
            compensation,
            serialLease: {
              status: compensationProven ? "release_eligible_after_action_publication" : "quarantined",
              reason: compensationProven
                ? "compensation and final proof completed; release requires this fixed-deadline action publication"
                : "prepare compensation remains unproven",
            },
            preparationLogEvidence,
            freshLaunchMonitor,
            launchHandoffWindow,
            launchHandoffObservation,
            hmdBaselineAcquisition: baselineHmdAcquisition,
            captureReceipt: baselineCaptureReceipt ?? baselineCaptureInvocation.receipt,
            captureInvocation: baselineCaptureInvocation.fence,
            postCaptureContinuity,
            postCaptureCapability,
          }, hooks, {
            deadlineNs: recoveryDeadlineNs!,
            monotonicNs: () => checkedMonotonic(dependencies),
            label: "failed prepare action publication",
          });
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
      return preparationFailure(
        code,
        error,
        artifact?.runId ?? null,
        artifact?.absoluteRoot ?? null,
        cleanupError,
        failureActionMaintenance,
      );
    } finally {
      preparingRoots.delete(input.artifactRoot);
    }
  };

  const executeStep = async (
    input: InAppLocomotionStepInput,
    state: LocomotionState,
    hostWindows: LocomotionHostWindowEvidence,
  ): Promise<LocomotionStepReceipt> => {
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
    validateStateArtifactsWithoutMaintenance(state, hooks);
    assertCurrentReceiptAndSpec(state, dependencies);
    const operationStarted = checkedMonotonic(dependencies);
    state.nextWaypoint += 1;
    state.usage.waypointAttempts += 1;
    const routeRemainingMs = state.input.budgets.routeReserveMs - state.usage.routeDurationMs;
    const beforeRestoreDeadlineNs = state.deadlineNs - BigInt(state.input.budgets.restorationReserveMs) * 1_000_000n;
    const actionPublicationDeadlineNs = earlierDeadline(
      beforeRestoreDeadlineNs,
      operationStarted + BigInt(Math.max(0, routeRemainingMs)) * 1_000_000n,
    );
    const stepDeadlineNs = deadlineBefore(
      actionPublicationDeadlineNs,
      STEP_ACTION_PUBLICATION_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const endMarkerDeadlineNs = deadlineBefore(
      stepDeadlineNs,
      STEP_LOG_FINALIZATION_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const nonFinalDeadlineNs = deadlineBefore(
      endMarkerDeadlineNs,
      STEP_END_MARKER_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const postContinuityDeadlineNs = nonFinalDeadlineNs;
    const postSafetyDeadlineNs = deadlineBefore(
      postContinuityDeadlineNs,
      APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const postHmdDeadlineNs = deadlineBefore(
      postSafetyDeadlineNs,
      POST_HMD_SAFETY_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const captureDeadlineNs = deadlineBefore(
      postHmdDeadlineNs,
      HMD_ACQUISITION_WINDOW_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const nonceCleanupDeadlineNs = deadlineBefore(
      captureDeadlineNs,
      state.input.capture.deadlineMs + CAPTURE_COMPLETION_GUARD_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const locomotionDeadlineNs = deadlineBefore(
      nonceCleanupDeadlineNs,
      NONCE_CLEANUP_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const preHmdDeadlineNs = deadlineBefore(
      locomotionDeadlineNs,
      BRIDGE_MIN_TRANSACTION_MS + state.input.route.glideDurationMs + STAGE_HANDOFF_GUARD_MS,
    );
    const preContinuityDeadlineNs = deadlineBefore(
      preHmdDeadlineNs,
      HMD_ACQUISITION_WINDOW_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const preSafetyDeadlineNs = deadlineBefore(
      preContinuityDeadlineNs,
      APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
    );
    const beginMarkerDeadlineNs = deadlineBefore(
      preSafetyDeadlineNs,
      STEP_PRE_SAFETY_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
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
    const preHmdAcquisition = hmdAcquisitionEvidence();
    const postHmdAcquisition = hmdAcquisitionEvidence();
    let locomotion: LocomotionResult | null = null;
    let locomotionMayHaveApplied = false;
    let pendingNonceRequestId: string | null = null;
    let emergencyStop: {
      attempted: boolean;
      stopCommandReceipt: LocomotionTargetStopReceipt | null;
      targetAbsenceProven: false;
      error: string | null;
    } | null = null;
    let captureReceipt: CaptureSettledReceipt | null = null;
    const captureInvocation: CaptureInvocationState = { captureInput: null, fence: null, receipt: null };
    let capturedFrame: Buffer | null = null;
    let postHmd: AgentBridgeHmdPose | null = null;
    let postSafety: LocomotionSafetySnapshot | null = null;
    let postContinuity: ApplicationContinuitySample | null = null;
    let locomotionNonceCleanup: AgentBridgeLocomotionNonceCleanupReceipt | null = null;
    try {
      assertHostWindow(hostWindows);
      const routeWorkFloorNs = BigInt(routeStepFloorMs(
        state.input.capture.deadlineMs,
        state.input.route.glideDurationMs,
      ) - STEP_ACTION_PUBLICATION_RESERVE_MS - STAGE_HANDOFF_GUARD_MS) * 1_000_000n;
      const initialRemainingNs = stepDeadlineNs - checkedMonotonic(dependencies);
      if (initialRemainingNs <= routeWorkFloorNs) {
        throw new LocomotionStageError("budget_exhausted", "route deadline cannot preserve the complete mutation, evidence, and restoration reserves");
      }
      began = true;
      await withinDeadline(beginMarkerDeadlineNs, dependencies, "step BEGIN marker", (timeoutMs) => dependencies.emitMarker({
        serial: state.input.serial,
        marker: beginMarker,
        timeoutMs,
        deadlineMonotonicNs: beginMarkerDeadlineNs.toString(),
      }));
      preSafety = await withinDeadline(preSafetyDeadlineNs, dependencies, "pre-step safety", (timeoutMs) => dependencies.sampleSafety({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_pre`,
        timeoutMs,
        deadlineMonotonicNs: preSafetyDeadlineNs.toString(),
      }));
      const preSafetyProblem = safetyProblem(preSafety);
      if (preSafetyProblem) throw new LocomotionStageError("safety_drift", `pre-step safety drift: ${preSafetyProblem}`);
      preContinuity = await withinDeadline(preContinuityDeadlineNs, dependencies, "pre-step continuity", (timeoutMs) => dependencies.sampleContinuity({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_pre`,
        runtime: state.runtime,
        artifactRoot: state.artifact.absoluteRoot,
        timeoutMs,
        deadlineMonotonicNs: preContinuityDeadlineNs.toString(),
      }));
      const preContinuityProblem = continuityProblem(preContinuity, state.runtime);
      if (preContinuityProblem) throw new LocomotionStageError("binding_lost", preContinuityProblem);
      await requireHostWindow(state.input.serial, hostWindows, "step_before_hmd", preHmdDeadlineNs);
      preHmd = await acquireFreshHmdPose(dependencies, stepDeadlineNs, "pre-step HMD pose", {
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `step_${waypoint.seq}_pre_${state.artifact.runId.slice(0, 20)}`,
        tag: `step-${waypoint.seq}-pre`,
        expectedRootGeneration: state.rootGeneration,
        expectedRootIncarnation: state.rootIncarnation,
      }, preHmdAcquisition, postPreHmdReserveMs(
        state.input.capture.deadlineMs,
        state.input.route.glideDurationMs,
      ), state.lastHmdSample);
      await requireHostWindow(state.input.serial, hostWindows, "step_before_distance_measurement", locomotionDeadlineNs);
      if (translationDistance(state.baselineHmd.position, preHmd.position) > 0.02) {
        throw new LocomotionStageError("hmd_translation_drift", "pre-step Euclidean HMD translation drift exceeded exactly 0.02 m");
      }
      if (remainingUntilMs(locomotionDeadlineNs, dependencies)
        < BRIDGE_MIN_TRANSACTION_MS + state.input.route.glideDurationMs) {
        throw new LocomotionStageError("budget_exhausted", "route budget was exhausted before locomotion mutation");
      }
      const rootBefore = state.rootGeneration;
      const locomotionRequestId = `step_${waypoint.seq}_move_${state.artifact.runId.slice(0, 20)}`;
      locomotionMayHaveApplied = true;
      if (nonzeroPosition(waypoint.target)) state.nonzeroMutationMayHaveApplied = true;
      pendingNonceRequestId = locomotionRequestId;
      state.pendingLocomotionNonce = {
        requestId: locomotionRequestId,
        relativePath: locomotionNonceRelativePath(locomotionRequestId),
        tag: `step-${waypoint.seq}`,
        rootGeneration: rootBefore,
        rootIncarnation: state.rootIncarnation,
        attempts: 0,
      };
      await withinDeadline(locomotionDeadlineNs, dependencies, "selected locomotion", async (timeoutMs) => {
        const retained = await dependencies.requestLocomotion({
          serial: state.input.serial,
          packageName: state.input.scenario.packageName,
          requestId: locomotionRequestId,
          tag: `step-${waypoint.seq}`,
          mode: state.input.mechanism,
          target: { x: waypoint.target.x, y: waypoint.target.y, z: waypoint.target.z },
          rootGeneration: rootBefore,
          rootIncarnation: state.rootIncarnation,
          glideDurationMs: state.input.route.glideDurationMs,
          physicalWalk: false,
          deferNonceCleanup: true,
          ...bridgeBudgetFields(timeoutMs, locomotionDeadlineNs),
        });
        locomotion = retained;
        validateDeferredLocomotionNonceDisposition(retained, state.pendingLocomotionNonce!);
        return retained;
      });
      const retainedLocomotion = locomotion as LocomotionResult | null;
      if (retainedLocomotion === null) throw new Error("selected locomotion returned without a retained result");
      if (retainedLocomotion.motionQuiesced && pendingNonceRequestId !== null) {
        await withinDeadline(nonceCleanupDeadlineNs, dependencies, "locomotion nonce cleanup", async (timeoutMs) => {
          const pending = state.pendingLocomotionNonce!;
          try {
            const receipt = await dependencies.cleanupLocomotionNonce({
              serial: state.input.serial,
              packageName: state.input.scenario.packageName,
              requestId: pendingNonceRequestId!,
              tag: pending.tag,
              rootGeneration: pending.rootGeneration,
              rootIncarnation: pending.rootIncarnation,
              timeoutMs,
              deadlineMonotonicNs: nonceCleanupDeadlineNs.toString(),
            });
            // Once a cleanup dependency resolves, its removal effect may have
            // started even when its receipt is malformed. Recovery is therefore
            // probe-only until exact absence is proven.
            pending.attempts = 1;
            locomotionNonceCleanup = validateLocomotionNonceCleanupReceipt(receipt, pending, false);
            pendingNonceRequestId = null;
            state.pendingLocomotionNonce = null;
            if (receipt.removalError) cleanupErrors.push(`locomotion nonce removal warning: ${receipt.removalError}`);
            return receipt;
          } catch (error) {
            pending.attempts = nonceCleanupFailureDisposition(error).removalStarted ? 1 : 0;
            throw error;
          }
        });
      }
      const ack = completedLocomotionAck(retainedLocomotion);
      if (!ack) {
        if (!retainedLocomotion.ok) {
          if (retainedLocomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${retainedLocomotion.cleanupError}`);
          throw new LocomotionStageError(retainedLocomotion.code, retainedLocomotion.primaryError ?? retainedLocomotion.detail);
        }
        throw new LocomotionStageError("root_readback_mismatch", "successful locomotion omitted its completed acknowledgement");
      }
      if (!retainedLocomotion.ok) {
        if (retainedLocomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${retainedLocomotion.cleanupError}`);
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
      const captureRemainingMs = remainingUntilMs(captureDeadlineNs, dependencies);
      if (captureRemainingMs < 2) throw new LocomotionStageError("budget_exhausted", "route budget was exhausted before transition capture");
      const capturePath = path.join(state.artifact.absoluteRoot, "captures", `${String(waypoint.seq).padStart(3, "0")}-waypoint.png`);
      const captured = await captureWithinDeadline(
        operationStarted,
        captureDeadlineNs,
        dependencies,
        "waypoint transition-stable capture",
        captureInvocation,
        (remainingMs) => {
          const captureBudgetMs = remainingMs - 1;
          if (captureBudgetMs < 1) throw new LocomotionStageError("budget_exhausted", "transition capture cannot fit strictly before the route deadline");
          return {
            serial: state.input.serial,
            outPath: capturePath,
            maxTries: state.input.capture.maxTries,
            intervalMs: state.input.capture.intervalMs,
            attemptTimeoutMs: Math.min(state.input.capture.attemptTimeoutMs, captureBudgetMs),
            deadlineMs: Math.min(state.input.capture.deadlineMs, captureBudgetMs),
            comparison: "byte_exact",
            mode: "transition_then_stable",
            priorSha256: state.currentReview.captureSha256,
          };
        },
        state.hostWindowBinding,
      );
      const waypointCaptureInput = captureInvocation.captureInput;
      const waypointCaptureFence = captureInvocation.fence;
      if (!waypointCaptureInput || !waypointCaptureFence) throw new Error("waypoint capture request/invocation was not retained");
      captureReceipt = captured.receipt;
      capturedFrame = captured.frame;
      if (captured.receipt.status !== "settled") {
        throw new LocomotionStageError(captured.receipt.error?.code ?? "route_unsettled", captured.receipt.error?.detail ?? "transition capture did not settle");
      }
      await requireHostWindow(state.input.serial, hostWindows, "step_after_capture", captureDeadlineNs, captured.receipt.hostWindowProbe);
      capturedReview = captureReview(captured, {
        captureInput: waypointCaptureInput,
        captureInvocation: waypointCaptureFence,
        phaseDeadlineNs: captureDeadlineNs,
        role: "waypoint",
        runtime: state.runtime,
        waypointSeq: waypoint.seq,
      });
      postHmd = await acquireFreshHmdPose(dependencies, stepDeadlineNs, "post-step HMD pose", {
        serial: state.input.serial,
        packageName: state.input.scenario.packageName,
        requestId: `step_${waypoint.seq}_post_${state.artifact.runId.slice(0, 20)}`,
        tag: `step-${waypoint.seq}-post`,
        expectedRootGeneration: state.rootGeneration,
        expectedRootIncarnation: state.rootIncarnation,
      }, postHmdAcquisition, POST_HMD_DOWNSTREAM_RESERVE_MS, preHmd);
      await requireHostWindow(state.input.serial, hostWindows, "step_before_drift_measurement", postSafetyDeadlineNs);
      drift = driftReceipt(state.baselineHmd, preHmd, postHmd);
      postSafety = await withinDeadline(postSafetyDeadlineNs, dependencies, "post-step safety", (timeoutMs) => dependencies.sampleSafety({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_post`,
        timeoutMs,
        deadlineMonotonicNs: postSafetyDeadlineNs.toString(),
      }));
      const postSafetyProblem = safetyProblem(postSafety);
      if (postSafetyProblem) throw new LocomotionStageError("safety_drift", `post-step safety drift: ${postSafetyProblem}`);
      postContinuity = await withinDeadline(postContinuityDeadlineNs, dependencies, "post-step continuity", (timeoutMs) => dependencies.sampleContinuity({
        serial: state.input.serial,
        phase: `step_${waypoint.seq}_post`,
        runtime: state.runtime,
        artifactRoot: state.artifact.absoluteRoot,
        timeoutMs,
        deadlineMonotonicNs: postContinuityDeadlineNs.toString(),
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
      let recoveryBudget: LocomotionEffectBudget | null = null;
      const stepRecoveryBudget = (): LocomotionEffectBudget => {
        if (recoveryBudget !== null) return recoveryBudget;
        try {
          const remaining = remainingUntilMs(nonFinalDeadlineNs, dependencies);
          if (remaining < 1) throw new Error("step recovery reached the fixed non-final route deadline");
          recoveryBudget = {
            timeoutMs: Math.min(5_000, remaining),
            deadlineMonotonicNs: nonFinalDeadlineNs.toString(),
          };
        } catch (clockError) {
          cleanupErrors.push(`step recovery budget clock: ${errorText(clockError)}`);
          recoveryBudget = {
            timeoutMs: 5_000,
            deadlineMonotonicNs: nonFinalDeadlineNs.toString(),
            cleanupOnly: true,
          };
        }
        return recoveryBudget;
      };
      if (locomotionMayHaveApplied && state.targetOwned
        && ((locomotion as LocomotionResult | null)?.motionQuiesced !== true || state.pendingLocomotionNonce !== null)) {
        emergencyStop = {
          attempted: true,
          stopCommandReceipt: null,
          targetAbsenceProven: false,
          error: null,
        };
        try {
          const stopInput = {
            serial: state.input.serial,
            packageName: state.input.scenario.packageName,
            reason: "step_unquiesced_locomotion",
            ...stepRecoveryBudget(),
          };
          emergencyStop.stopCommandReceipt = checkedTargetStopReceipt(
            await dependencies.stopPackage(stopInput),
            stopInput,
          );
          // A force-stop command receipt is not process-absence proof. Keep the
          // target, writer, and nonce cleanup owned until restore's exact
          // PID/activity probe proves that no guest writer remains.
          state.unquiescedLocomotion = pendingNonceRequestId === null ? null : {
            requestId: pendingNonceRequestId,
            relativePath: locomotionNonceRelativePath(pendingNonceRequestId),
          };
        } catch (stopError) {
          emergencyStop.error = errorText(stopError);
          cleanupErrors.push(`step emergency target stop: ${emergencyStop.error}`);
          state.unquiescedLocomotion = pendingNonceRequestId === null ? null : {
            requestId: pendingNonceRequestId,
            relativePath: locomotionNonceRelativePath(pendingNonceRequestId),
          };
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
          await withinDeadline(endMarkerDeadlineNs, dependencies, "step END marker", (timeoutMs) => dependencies.emitMarker({
            serial: state.input.serial,
            marker: endMarker,
            timeoutMs,
            deadlineMonotonicNs: endMarkerDeadlineNs.toString(),
          }));
        } catch (error) {
          cleanupErrors.push(`END marker: ${errorText(error)}`);
        }
        try {
          const admittedAtNs = checkedMonotonic(dependencies);
          if (admittedAtNs >= stepDeadlineNs) {
            throw new LocomotionStageError("budget_exhausted", "step bounded log finalization cannot begin at or after its fixed phase deadline");
          }
          const timeoutMs = Number((stepDeadlineNs - admittedAtNs) / 1_000_000n);
          if (timeoutMs < 1) {
            throw new LocomotionStageError("budget_exhausted", "step bounded log finalization cannot begin at or after its fixed phase deadline");
          }
          const collectedLog = checkedLogEvidence(await dependencies.collectStepLogs({
            serial: state.input.serial,
            packageName: state.input.scenario.packageName,
            pid: state.runtime.applicationBinding.pid,
            beginMarker,
            endMarker,
            path: logPath,
            timeoutMs: Math.min(STEP_LOG_FINALIZATION_RESERVE_MS, timeoutMs),
            deadlineMonotonicNs: stepDeadlineNs.toString(),
          }), logPath, state.input.scenario.packageName, beginMarker, endMarker, hooks);
          const identity = artifactFileIdentity(collectedLog.path, "retained step log", 64 * 1024 * 1024);
          state.retainedLogs.push({ path: collectedLog.path, identity, label: `retained step ${waypoint.seq} log` });
          logEvidence = collectedLog;
          if (checkedMonotonic(dependencies) >= stepDeadlineNs) {
            throw new LocomotionStageError("budget_exhausted", "step bounded log finalization exceeded its fixed phase deadline");
          }
        } catch (error) {
          cleanupErrors.push(`bounded log finalization: ${errorText(error)}`);
        }
      }
    }
    let capturedReviewValidated = false;
    if (capturedReview) {
      try {
        const retained = dependencies.readReviewImage(capturedReview, state.artifact.absoluteRoot);
        validateRetainedCaptureFrame({ receipt: captureReceipt!, frame: capturedFrame }, retained, "waypoint");
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
      if (operationEnded >= stepDeadlineNs) {
        const detail = "step evidence finalization exceeded its fixed phase deadline";
        if (primaryError === null) {
          primaryError = detail;
          primaryCode = "budget_exhausted";
        } else cleanupErrors.push(detail);
      }
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
    const immutableActionCompleted = succeeded;
    let committedCompletedAction = false;
    let structuralStop = succeeded ? null : primaryCode ?? "step_cleanup_failed";
    let actionAudit = actionAuditMaintenance(state.artifact);
    try {
      actionAudit = appendAction(state.artifact, {
        action: "step",
        ...hostWindows,
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
        pre: { safety: preSafety, continuity: preContinuity, hmdPose: preHmd, hmdAcquisition: preHmdAcquisition },
        locomotion,
        locomotionNonceCleanup,
        emergencyStop,
        captureReceipt: captureReceipt ?? captureInvocation.receipt,
        captureInvocation: captureInvocation.fence,
        post: { hmdPose: postHmd, hmdAcquisition: postHmdAcquisition, safety: postSafety, continuity: postContinuity },
        hmdDrift: drift,
        logEvidence,
        priorActionAuditMaintenance: actionAuditMaintenance(state.artifact),
      }, hooks, {
        deadlineNs: actionPublicationDeadlineNs,
        monotonicNs: () => checkedMonotonic(dependencies),
        label: "step action publication",
      });
    } catch (auditError) {
      committedCompletedAction = auditError instanceof ActionPublicationFenceError
        && auditError.committed && immutableActionCompleted;
      if (/conflict|changed after immutable publication|authoritative action record|derived action JSONL/i.test(errorText(auditError))) {
        state.actionAuditConflict = true;
      }
      if (primaryError === null) {
        primaryError = `step action audit: ${errorText(auditError)}`;
        primaryCode = "action_audit_failed";
      } else {
        cleanupErrors.push(`step action audit: ${errorText(auditError)}`);
      }
      succeeded = false;
      structuralStop = primaryCode ?? "action_audit_failed";
      actionAudit = actionAuditMaintenance(state.artifact);
    }
    if (succeeded || committedCompletedAction) {
      state.usage.successfulWaypoints = publishedUsage.successfulWaypoints;
      state.lastHmdSample = postHmd!;
    }
    state.status = succeeded ? "stepped" : "stopped";
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
      actionAuditMaintenance: actionAudit,
    };
  };

  const executeRestore = async (input: InAppLocomotionRestoreInput, state: LocomotionState, hostWindows: LocomotionHostWindowEvidence): Promise<LocomotionRestoreReceipt> => {
    const terminalRestore = state.completedRestore ?? state.terminalSafeRelease;
    if (terminalRestore !== null) {
      if (input.reviewedPriorFrame.captureSha256 !== terminalRestore.reviewedPriorSha256
        && input.reviewedPriorFrame.captureSha256 !== state.currentReview.captureSha256) {
        return restoreReviewFailure(state, "reviewed capture SHA does not match the terminal restore request or exact retained frame");
      }
      try {
        assertStateArtifacts(state, hooks);
        for (const item of state.requiredReview) dependencies.readReviewImage(item, state.artifact.absoluteRoot);
        assertCurrentReceiptAndSpec(state, dependencies);
      } catch (error) {
        return restoreReviewFailure(
          state,
          `terminal restore artifact validation failed: ${errorText(error)}`,
        );
      }
      return {
        ...terminalRestore.receipt,
        actionAuditMaintenance: actionAuditMaintenance(state.artifact),
      };
    }
    if (state.status !== "prepared" && state.status !== "stepped" && state.status !== "stopped") {
      throw new Error(`restore is out of order from state '${state.status}'`);
    }
    if (input.reviewedPriorFrame.captureSha256 !== state.currentReview.captureSha256) {
      return restoreReviewFailure(state, "reviewed capture SHA does not match the exact current required frame");
    }
    const reviewedMovedFrame = state.currentReviewReflectsNonzeroMutation;
    const restoreAttempt = ++state.restoreAttempts;
    let restoreStartedNs = state.startedAtNs;
    let restoreDeadlineNs = state.deadlineNs;
    let restoreDeadlineSource: "original_run_deadline" | "restoration_reserve_cap" | "fresh_recovery_deadline" | "unavailable" = "unavailable";
    let entryValidationDeadlineNs = restoreDeadlineNs;
    let preContinuityDeadlineNs = restoreDeadlineNs;
    let preCapabilityDeadlineNs = restoreDeadlineNs;
    let locomotionDeadlineNs = restoreDeadlineNs;
    let nonceCleanupDeadlineNs = restoreDeadlineNs;
    let captureDeadlineNs = restoreDeadlineNs;
    let postContinuityDeadlineNs = restoreDeadlineNs;
    let postCapabilityDeadlineNs = restoreDeadlineNs;
    let targetStopDeadlineNs = restoreDeadlineNs;
    let targetAbsenceDeadlineNs = restoreDeadlineNs;
    let postStopNonceDeadlineNs = restoreDeadlineNs;
    let priorRelaunchDeadlineNs = restoreDeadlineNs;
    let finalProcessDeadlineNs = restoreDeadlineNs;
    let postStopSafetyDeadlineNs = restoreDeadlineNs;
    let restoreActionDeadlineNs = restoreDeadlineNs;
    let primaryError: string | null = null;
    let primaryCode: string | null = null;
    const cleanupErrors: string[] = [];
    let restoredReview: LocomotionReviewItem | null = null;
    let locomotion: LocomotionResult | null = null;
    let restorationMayHaveApplied = false;
    let captureReceipt: CaptureSettledReceipt | null = null;
    const captureInvocation: CaptureInvocationState = { captureInput: null, fence: null, receipt: null };
    let postStopSafety: LocomotionSafetySnapshot | null = null;
    let preRestoreContinuity: ApplicationContinuitySample | null = null;
    let preRestoreCapability: CapabilityResult | null = null;
    let postCaptureContinuity: ApplicationContinuitySample | null = null;
    let postCaptureCapability: CapabilityResult | null = null;
    let targetAbsenceProof: FinalProcessActivityReceipt | null = null;
    let finalProcessProof: FinalProcessActivityReceipt | null = null;
    let finalProcessProven = false;
    let finalSafetyProven = false;
    let targetStopCommandProven = !state.targetOwned;
    let targetShutdownProven = !state.targetOwned;
    let currentReviewTrusted = true;
    let locomotionNonceCleanup: AgentBridgeLocomotionNonceCleanupReceipt | null = null;
    let targetStop: LocomotionTargetStopReceipt | { status: "not_attempted"; reason: string }
      | { status: "failed"; error: string } = {
      status: "not_attempted",
      reason: state.targetOwned ? "restore_cleanup_not_started" : "target_previously_proven_absent",
    };
    let priorRelaunch: PriorRelaunchReceipt | { status: "not_required" }
      | { status: "not_attempted" | "blocked"; reason: string } | { status: "failed"; error: string } = {
      status: "not_required",
    };
    const priorDisposition = priorForegroundDisposition(state);
    try {
      restoreStartedNs = checkedMonotonic(dependencies);
      const restorationFloorNs = BigInt(restorationFloorMs(
        state.input.capture.deadlineMs,
        state.input.route.glideDurationMs,
      )) * 1_000_000n;
      const freshRecoveryDeadlineNs = restoreStartedNs
        + BigInt(state.input.budgets.restorationReserveMs) * 1_000_000n;
      const originalDeadlineCanAdmitRestore = state.deadlineNs - restoreStartedNs > restorationFloorNs;
      const useFreshRecoveryDeadline = restoreAttempt > 1 || state.status === "stopped" || !originalDeadlineCanAdmitRestore;
      restoreDeadlineNs = useFreshRecoveryDeadline
        ? freshRecoveryDeadlineNs
        : earlierDeadline(state.deadlineNs, freshRecoveryDeadlineNs);
      restoreDeadlineSource = useFreshRecoveryDeadline
        ? "fresh_recovery_deadline"
        : state.deadlineNs <= freshRecoveryDeadlineNs ? "original_run_deadline" : "restoration_reserve_cap";
      restoreActionDeadlineNs = restoreDeadlineNs;
      postStopSafetyDeadlineNs = deadlineBefore(
        restoreActionDeadlineNs,
        FINAL_ACTION_PUBLICATION_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      finalProcessDeadlineNs = deadlineBefore(
        postStopSafetyDeadlineNs,
        FINAL_SAFETY_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      priorRelaunchDeadlineNs = deadlineBefore(
        finalProcessDeadlineNs,
        FINAL_PROCESS_PROOF_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      postStopNonceDeadlineNs = deadlineBefore(
        priorRelaunchDeadlineNs,
        FINAL_PRIOR_RELAUNCH_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      targetAbsenceDeadlineNs = deadlineBefore(
        postStopNonceDeadlineNs,
        NONCE_CLEANUP_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      targetStopDeadlineNs = deadlineBefore(
        targetAbsenceDeadlineNs,
        FINAL_PROCESS_PROOF_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      postCapabilityDeadlineNs = deadlineBefore(
        targetStopDeadlineNs,
        FINAL_TARGET_STOP_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      postContinuityDeadlineNs = deadlineBefore(
        postCapabilityDeadlineNs,
        BRIDGE_MIN_TRANSACTION_MS + STAGE_HANDOFF_GUARD_MS,
      );
      captureDeadlineNs = deadlineBefore(
        postContinuityDeadlineNs,
        APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      nonceCleanupDeadlineNs = deadlineBefore(
        captureDeadlineNs,
        state.input.capture.deadlineMs + CAPTURE_COMPLETION_GUARD_MS + STAGE_HANDOFF_GUARD_MS,
      );
      locomotionDeadlineNs = deadlineBefore(
        nonceCleanupDeadlineNs,
        NONCE_CLEANUP_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      preCapabilityDeadlineNs = deadlineBefore(
        locomotionDeadlineNs,
        BRIDGE_MIN_TRANSACTION_MS + state.input.route.glideDurationMs + STAGE_HANDOFF_GUARD_MS,
      );
      preContinuityDeadlineNs = deadlineBefore(
        preCapabilityDeadlineNs,
        BRIDGE_MIN_TRANSACTION_MS + STAGE_HANDOFF_GUARD_MS,
      );
      entryValidationDeadlineNs = deadlineBefore(
        preContinuityDeadlineNs,
        APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS + STAGE_HANDOFF_GUARD_MS,
      );
      if (restoreDeadlineNs - checkedMonotonic(dependencies) <= restorationFloorNs) {
        throw new LocomotionStageError(
          "budget_exhausted",
          "restoration deadline cannot preserve every continuity, capability, mutation, capture, nonce-cleanup, and final-recovery stage",
        );
      }
      if (state.actionAuditConflict) {
        throw new LocomotionStageError(
          "cleanup_only_restore",
          "action publication conflict requires cleanup-only restore",
        );
      }
      await withinDeadline(entryValidationDeadlineNs, dependencies, "restore entry validation", async () => {
        try {
          dependencies.readReviewImage(state.currentReview, state.artifact.absoluteRoot);
        } catch (error) {
          currentReviewTrusted = false;
          throw new LocomotionStageError(
            "review_artifact_failed",
            `reviewed retained image failed its immutable sha256 check: ${errorText(error)}`,
          );
        }
        validateStateArtifactsWithoutMaintenance(state, hooks);
        assertCurrentReceiptAndSpec(state, dependencies);
      });
      const cleanupOnlyRestore = !state.targetOwned || state.unquiescedLocomotion !== null
        || state.pendingLocomotionNonce !== null || state.zeroOffsetRecoveryProven;
      if (cleanupOnlyRestore) {
        if (state.nonzeroMutationMayHaveApplied && !state.zeroOffsetRecoveryProven) {
          throw new LocomotionStageError(
            "restoration_unproven",
            "cleanup-only restoration has no bound zero-offset recovery and may not relabel the retained frame as zero proof",
          );
        }
        restoredReview = state.currentReview;
      } else {
        preRestoreContinuity = await withinDeadline(preContinuityDeadlineNs, dependencies, "pre-restore live continuity", (timeoutMs) =>
          dependencies.sampleContinuity({
            serial: state.input.serial,
            phase: "restore_pre",
            runtime: state.runtime,
            artifactRoot: state.artifact.absoluteRoot,
            timeoutMs,
            deadlineMonotonicNs: preContinuityDeadlineNs.toString(),
          }));
      const continuity = continuityProblem(preRestoreContinuity, state.runtime);
      if (continuity) throw new LocomotionStageError("binding_lost", continuity);
      preRestoreCapability = await withinDeadline(preCapabilityDeadlineNs, dependencies, "pre-restore root capability", (timeoutMs) =>
        dependencies.probeCapability({
          serial: state.input.serial,
          packageName: state.input.scenario.packageName,
          requestId: `restore_capability_${state.artifact.runId.slice(0, 20)}`,
          tag: "restore-pre",
          ...bridgeBudgetFields(timeoutMs, preCapabilityDeadlineNs),
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
      const remainingMs = remainingUntilMs(locomotionDeadlineNs, dependencies);
      if (remainingMs < BRIDGE_MIN_TRANSACTION_MS + state.input.route.glideDurationMs) {
        throw new LocomotionStageError(
          "budget_exhausted",
          "restoration deadline cannot fit the complete bridge-plus-glide mutation envelope",
        );
      }
      const rootBefore = state.rootGeneration;
      const restoreRequestId = `restore_move_${state.artifact.runId.slice(0, 20)}`;
      restorationMayHaveApplied = true;
      state.pendingLocomotionNonce = {
        requestId: restoreRequestId,
        relativePath: locomotionNonceRelativePath(restoreRequestId),
        tag: "restore",
        rootGeneration: rootBefore,
        rootIncarnation: state.rootIncarnation,
        attempts: 0,
      };
      await withinDeadline(locomotionDeadlineNs, dependencies, "zero-offset restoration", async (timeoutMs) => {
        const retained = await dependencies.requestLocomotion({
          serial: state.input.serial,
          packageName: state.input.scenario.packageName,
          requestId: restoreRequestId,
          tag: "restore",
          mode: state.input.mechanism,
          target: { x: 0, y: 0, z: 0 },
          rootGeneration: rootBefore,
          rootIncarnation: state.rootIncarnation,
          glideDurationMs: state.input.route.glideDurationMs,
          physicalWalk: false,
          deferNonceCleanup: true,
          ...bridgeBudgetFields(timeoutMs, locomotionDeadlineNs),
        });
        locomotion = retained;
        validateDeferredLocomotionNonceDisposition(retained, state.pendingLocomotionNonce!);
        return retained;
      });
      const retainedLocomotion = locomotion as LocomotionResult | null;
      if (retainedLocomotion === null) throw new Error("zero-offset restoration returned without a retained result");
      if (retainedLocomotion.motionQuiesced && state.pendingLocomotionNonce?.attempts === 0) {
        await withinDeadline(nonceCleanupDeadlineNs, dependencies, "restore locomotion nonce cleanup", async (timeoutMs) => {
          const pending = state.pendingLocomotionNonce!;
          try {
            const receipt = await dependencies.cleanupLocomotionNonce({
              serial: state.input.serial,
              packageName: state.input.scenario.packageName,
              requestId: pending.requestId,
              tag: pending.tag,
              rootGeneration: pending.rootGeneration,
              rootIncarnation: pending.rootIncarnation,
              timeoutMs,
              deadlineMonotonicNs: nonceCleanupDeadlineNs.toString(),
            });
            pending.attempts = 1;
            locomotionNonceCleanup = validateLocomotionNonceCleanupReceipt(receipt, pending, false);
            state.pendingLocomotionNonce = null;
            return receipt;
          } catch (error) {
            pending.attempts = nonceCleanupFailureDisposition(error).removalStarted ? 1 : 0;
            throw error;
          }
        });
      }
      const ack = completedLocomotionAck(retainedLocomotion);
      if (!ack) {
        if (!retainedLocomotion.ok) {
          if (retainedLocomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${retainedLocomotion.cleanupError}`);
          throw new LocomotionStageError(retainedLocomotion.code, retainedLocomotion.primaryError ?? retainedLocomotion.detail);
        }
        throw new LocomotionStageError("root_readback_mismatch", "successful restore omitted its completed acknowledgement");
      }
      if (!retainedLocomotion.ok) {
        if (retainedLocomotion.cleanupError) cleanupErrors.push(`locomotion acknowledgement cleanup: ${retainedLocomotion.cleanupError}`);
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
      const captureRemainingMs = remainingUntilMs(captureDeadlineNs, dependencies);
      if (captureRemainingMs < 2) {
        throw new LocomotionStageError("budget_exhausted", "restoration deadline expired before capture and post-capture binding checks");
      }
      const capturePath = path.join(
        state.artifact.absoluteRoot,
        "captures",
        `999-restored-${String(restoreAttempt).padStart(3, "0")}.png`,
      );
      const captured = await captureWithinDeadline(
        restoreStartedNs,
        captureDeadlineNs,
        dependencies,
        "restoration settled capture",
        captureInvocation,
        (remainingCaptureMs) => {
          const captureBudgetMs = remainingCaptureMs - 1;
          if (captureBudgetMs < 1) throw new LocomotionStageError("budget_exhausted", "restoration capture cannot fit strictly before its mutation deadline");
          return {
            serial: state.input.serial,
            outPath: capturePath,
            maxTries: state.input.capture.maxTries,
            intervalMs: state.input.capture.intervalMs,
            attemptTimeoutMs: Math.min(state.input.capture.attemptTimeoutMs, captureBudgetMs),
            deadlineMs: Math.min(state.input.capture.deadlineMs, captureBudgetMs),
            comparison: "byte_exact",
            mode: reviewedMovedFrame ? "transition_then_stable" : "stable",
            ...(reviewedMovedFrame ? { priorSha256: state.currentReview.captureSha256 } : {}),
          };
        },
        state.hostWindowBinding,
      );
      const restoreCaptureInput = captureInvocation.captureInput;
      const restoreCaptureFence = captureInvocation.fence;
      if (!restoreCaptureInput || !restoreCaptureFence) throw new Error("restore capture request/invocation was not retained");
      captureReceipt = captured.receipt;
      await observeHostWindow(state.input.serial, hostWindows, "restore_after_capture", captured.receipt.hostWindowProbe);
      if (captured.receipt.status !== "settled") {
        throw new LocomotionStageError(captured.receipt.error?.code ?? "restoration_unsettled", captured.receipt.error?.detail ?? "restoration capture did not settle");
      }
      const candidateReview = captureReview(captured, {
        captureInput: restoreCaptureInput,
        captureInvocation: restoreCaptureFence,
        phaseDeadlineNs: captureDeadlineNs,
        role: "recovery",
        runtime: state.runtime,
      });
      validateRetainedCaptureFrame(captured, dependencies.readReviewImage(candidateReview, state.artifact.absoluteRoot), "recovery");
      postCaptureContinuity = await withinDeadline(
        postContinuityDeadlineNs,
        dependencies,
        "post-restoration-capture continuity",
        (timeoutMs) => dependencies.sampleContinuity({
          serial: state.input.serial,
          phase: "restore_post_capture",
          runtime: state.runtime,
          artifactRoot: state.artifact.absoluteRoot,
          timeoutMs,
          deadlineMonotonicNs: postContinuityDeadlineNs.toString(),
        }),
      );
      const postCaptureContinuityProblem = continuityProblem(postCaptureContinuity, state.runtime);
      if (postCaptureContinuityProblem) throw new LocomotionStageError("binding_lost", postCaptureContinuityProblem);
      postCaptureCapability = await withinDeadline(
        postCapabilityDeadlineNs,
        dependencies,
        "post-restoration-capture root capability",
        (timeoutMs) => dependencies.probeCapability({
          serial: state.input.serial,
          packageName: state.input.scenario.packageName,
          requestId: `restore_post_capture_${state.artifact.runId.slice(0, 20)}`,
          tag: "restore-post-capture",
          ...bridgeBudgetFields(timeoutMs, postCapabilityDeadlineNs),
        }),
      );
      if (!postCaptureCapability.ok) {
        throw new LocomotionStageError(
          postCaptureCapability.code,
          postCaptureCapability.primaryError ?? postCaptureCapability.detail,
          postCaptureCapability.cleanupError,
        );
      }
      const postCaptureRoot = postCaptureCapability.ack.root;
      if (!postCaptureRoot || postCaptureRoot.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID
        || postCaptureRoot.generation !== state.rootGeneration
        || postCaptureRoot.incarnation !== state.rootIncarnation) {
        throw new LocomotionStageError(
          "binding_lost",
          "post-restoration-capture root capability lost the exact generation/incarnation producer identity",
        );
      }
        restoredReview = candidateReview;
        if (candidateReview.captureSha256 !== state.currentReview.captureSha256) {
          state.requiredReview.push(candidateReview);
        }
        state.currentReview = candidateReview;
        state.currentReviewReflectsNonzeroMutation = false;
        state.zeroOffsetRecoveryProven = true;
        state.nonzeroMutationMayHaveApplied = false;
      }
    } catch (error) {
      primaryError = errorText(error);
      primaryCode = error instanceof LocomotionStageError ? error.code : "restore_failed";
      if (restorationMayHaveApplied && (locomotion as LocomotionResult | null)?.motionQuiesced !== true && state.pendingLocomotionNonce !== null) {
        state.unquiescedLocomotion = {
          requestId: state.pendingLocomotionNonce.requestId,
          relativePath: state.pendingLocomotionNonce.relativePath,
        };
      }
      if (error instanceof LocomotionStageError && error.cleanupError) {
        cleanupErrors.push(`bridge acknowledgement cleanup: ${error.cleanupError}`);
      }
    } finally {
      const runCleanupStage = async <T>(
        stageDeadlineNs: bigint,
        stageReserveMs: number,
        label: string,
        effect: (budget: LocomotionEffectBudget) => Promise<T>,
      ): Promise<T> => {
        let strictClock = true;
        let budget!: LocomotionEffectBudget;
        let remaining: number | null = null;
        try {
          remaining = remainingUntilMs(stageDeadlineNs, dependencies);
        } catch (clockError) {
          strictClock = false;
          cleanupErrors.push(`${label} budget clock: ${errorText(clockError)}`);
          budget = {
            timeoutMs: stageReserveMs,
            deadlineMonotonicNs: stageDeadlineNs.toString(),
            cleanupOnly: true,
          };
        }
        if (remaining !== null) {
          if (remaining < 1) {
            strictClock = false;
            cleanupErrors.push(`${label} budget: ${label} cannot begin at or after its fixed restoration subdeadline`);
            budget = {
              timeoutMs: stageReserveMs,
              deadlineMonotonicNs: stageDeadlineNs.toString(),
              cleanupOnly: true,
            };
          } else {
            budget = {
              timeoutMs: Math.min(stageReserveMs, remaining),
              deadlineMonotonicNs: stageDeadlineNs.toString(),
            };
          }
        }
        const result = await effect(budget);
        if (strictClock && checkedMonotonic(dependencies) >= stageDeadlineNs) {
          throw new Error(`${label} completed at or after its fixed restoration subdeadline`);
        }
        return result;
      };
      let targetStopError: string | null = null;
      let priorRelaunchError: string | null = null;
      if (state.targetOwned) {
        try {
          targetStop = await runCleanupStage(
            targetStopDeadlineNs,
            FINAL_TARGET_STOP_RESERVE_MS,
            "owned target stop",
            async (budget) => {
              const stopInput = {
                serial: state.input.serial,
                packageName: state.input.scenario.packageName,
                reason: state.unquiescedLocomotion === null ? "restore_run_owned_target" : "restore_unquiesced_target",
                ...budget,
              };
              return checkedTargetStopReceipt(await dependencies.stopPackage(stopInput), stopInput);
            },
          );
          targetStopCommandProven = true;
        } catch (error) {
          targetStopError = errorText(error);
          targetStop = { status: "failed", error: targetStopError };
        }
      }

      const priorToRelaunch = state.input.priorForeground.kind === "non_receipt_bound"
        && state.priorTerminatedByRun
        ? state.input.priorForeground
        : null;
      const needsPriorRelaunch = priorToRelaunch !== null;
      if (needsPriorRelaunch) {
        priorRelaunch = { status: "not_attempted", reason: "awaiting_target_absence" };
      }
      let targetAbsenceChecked: ReturnType<typeof checkedFinalProcessProof> | null = null;
      try {
        const targetProofStage = await runCleanupStage(
          targetAbsenceDeadlineNs,
          FINAL_PROCESS_PROOF_RESERVE_MS,
          "target absence proof",
          async (budget) => {
            const proof = await dependencies.probeFinalProcessState({
              serial: state.input.serial,
              targetPackage: state.input.scenario.packageName,
              artifactRoot: state.artifact.absoluteRoot,
              evidenceId: needsPriorRelaunch
                ? `restore-${String(restoreAttempt).padStart(3, "0")}-target-absence`
                : `restore-${String(restoreAttempt).padStart(3, "0")}`,
              priorForeground: state.input.priorForeground,
              ...budget,
            });
            return {
              proof,
              checked: checkedFinalProcessProof(proof, state.input, state.artifact.absoluteRoot),
            };
          },
        );
        const proof = targetProofStage.proof;
        targetAbsenceChecked = targetProofStage.checked;
        state.retainedLogs.push(targetAbsenceChecked.retained);
        targetShutdownProven = targetStopCommandProven && targetAbsenceChecked.targetAbsent;
        state.targetOwned = !targetShutdownProven;
        if (needsPriorRelaunch) targetAbsenceProof = proof;
        else finalProcessProof = proof;
        if (!needsPriorRelaunch) {
          if (targetAbsenceChecked.problem) cleanupErrors.push(targetAbsenceChecked.problem);
          else if (targetShutdownProven) finalProcessProven = true;
        } else if (!targetShutdownProven) {
          finalProcessProof = proof;
          if (targetAbsenceChecked.problem) cleanupErrors.push(targetAbsenceChecked.problem);
        }
      } catch (error) {
        targetShutdownProven = false;
        state.targetOwned = true;
        cleanupErrors.push(`target absence proof: ${errorText(error)}`);
      }

      if (targetShutdownProven && state.pendingLocomotionNonce !== null) {
        const pending = state.pendingLocomotionNonce;
        try {
          const receipt = await runCleanupStage(
            postStopNonceDeadlineNs,
            NONCE_CLEANUP_RESERVE_MS,
            "locomotion nonce cleanup",
            async (budget) => validateLocomotionNonceCleanupReceipt(
              await dependencies.cleanupLocomotionNonce({
                serial: state.input.serial,
                packageName: state.input.scenario.packageName,
                requestId: pending.requestId,
                tag: pending.tag,
                rootGeneration: pending.rootGeneration,
                rootIncarnation: pending.rootIncarnation,
                processStopped: true,
                ...(pending.attempts === 1 ? { probeOnly: true as const } : {}),
                ...budget,
              }),
              pending,
              true,
            ),
          );
          pending.attempts = 1;
          locomotionNonceCleanup = receipt;
          state.pendingLocomotionNonce = null;
          state.unquiescedLocomotion = null;
        } catch (error) {
          pending.attempts = nonceCleanupFailureDisposition(error).removalStarted ? 1 : pending.attempts;
          cleanupErrors.push(`locomotion nonce cleanup: ${errorText(error)}`);
        }
      }

      if (priorToRelaunch !== null) {
        if (!targetShutdownProven) {
          priorDisposition.relaunchDisposition = "blocked";
          priorRelaunch = { status: "blocked", reason: "target_absence_unproven" };
        } else if (targetAbsenceChecked?.priorForegroundSatisfied === true) {
          const disposition = state.priorRestoreProofDisposition ?? "state_proven_without_attempt";
          state.priorRestoreProofDisposition = disposition;
          priorDisposition.relaunchDisposition = disposition;
          priorRelaunch = { status: "not_attempted", reason: "prior_state_already_proven" };
          finalProcessProof = targetAbsenceProof;
          finalProcessProven = true;
        } else {
          state.priorRestoreProofDisposition = null;
          try {
            const relaunchStage = await runCleanupStage(
              priorRelaunchDeadlineNs,
              FINAL_PRIOR_RELAUNCH_RESERVE_MS,
              "prior relaunch",
              async (budget) => {
                const receipt = await dependencies.relaunchPrior({
                  serial: state.input.serial,
                  component: priorToRelaunch.component,
                  ...budget,
                });
                return {
                  receipt,
                  problem: validatePriorRelaunchReceipt(receipt, priorToRelaunch.component),
                };
              },
            );
            const relaunched = relaunchStage.receipt;
            priorRelaunch = relaunched;
            const problem = relaunchStage.problem;
            if (problem) {
              priorDisposition.relaunchDisposition = relaunched.disposition === "accepted" ? "attempt_failed" : relaunched.disposition;
              priorRelaunchError = problem;
            } else {
              priorDisposition.relaunchDisposition = "accepted";
            }
          } catch (error) {
            priorDisposition.relaunchDisposition = "attempt_failed";
            priorRelaunchError = errorText(error);
            priorRelaunch = { status: "failed", error: priorRelaunchError };
          }

          try {
            const finalProofStage = await runCleanupStage(
              finalProcessDeadlineNs,
              FINAL_PROCESS_PROOF_RESERVE_MS,
              "final process/activity proof",
              async (budget) => {
                const proof = await dependencies.probeFinalProcessState({
                  serial: state.input.serial,
                  targetPackage: state.input.scenario.packageName,
                  artifactRoot: state.artifact.absoluteRoot,
                  evidenceId: `restore-${String(restoreAttempt).padStart(3, "0")}-final`,
                  priorForeground: state.input.priorForeground,
                  ...budget,
                });
                return {
                  proof,
                  checked: checkedFinalProcessProof(proof, state.input, state.artifact.absoluteRoot),
                };
              },
            );
            finalProcessProof = finalProofStage.proof;
            const checked = finalProofStage.checked;
            state.retainedLogs.push(checked.retained);
            targetShutdownProven = targetStopCommandProven && checked.targetAbsent;
            state.targetOwned = !targetShutdownProven;
            state.priorRestoreProofDisposition = checked.priorForegroundSatisfied
              ? priorRelaunchError !== null
                ? "state_proven_after_attempt_error"
                : "accepted"
              : null;
            if (state.priorRestoreProofDisposition !== null) {
              priorDisposition.relaunchDisposition = state.priorRestoreProofDisposition;
            }
            if (checked.problem) {
              if (!checked.priorForegroundSatisfied) priorDisposition.relaunchDisposition = "attempt_failed";
              cleanupErrors.push(checked.problem);
            } else {
              finalProcessProven = true;
            }
          } catch (error) {
            state.targetOwned = true;
            state.priorRestoreProofDisposition = null;
            cleanupErrors.push(`final process/activity proof: ${errorText(error)}`);
          }
        }
      }
      if (targetStopError !== null && state.targetOwned) {
        cleanupErrors.push(`owned target stop: ${targetStopError}`);
      }
      if (priorRelaunchError !== null && state.priorRestoreProofDisposition === null) {
        cleanupErrors.push(`prior relaunch: ${priorRelaunchError}`);
      }
      try {
        const safetyStage = await runCleanupStage(
          postStopSafetyDeadlineNs,
          FINAL_SAFETY_RESERVE_MS,
          "post-restore global safety",
          async (budget) => {
            const snapshot = await dependencies.sampleSafety({
              serial: state.input.serial,
              phase: "restore_after_prior_disposition",
              ...budget,
            });
            return { snapshot, unsafe: finalGlobalSafetyProblem(snapshot) };
          },
        );
        postStopSafety = safetyStage.snapshot;
        const unsafe = safetyStage.unsafe;
        if (unsafe) cleanupErrors.push(`post-restore global safety: ${unsafe}`);
        else finalSafetyProven = true;
      } catch (error) {
        cleanupErrors.push(`post-restore global safety: ${errorText(error)}`);
      }
    }
    let completed = primaryError === null && cleanupErrors.length === 0 && restoredReview !== null
      && !state.targetOwned && finalProcessProven && finalSafetyProven
      && (!state.nonzeroMutationMayHaveApplied || state.zeroOffsetRecoveryProven);
    const safeReleaseEligible = !completed && primaryCode === "restoration_unproven"
      && cleanupErrors.length === 0 && restoredReview === null && currentReviewTrusted
      && state.nonzeroMutationMayHaveApplied && !state.zeroOffsetRecoveryProven
      && !state.targetOwned && state.pendingLocomotionNonce === null
      && state.unquiescedLocomotion === null && finalProcessProven && finalSafetyProven;
    let safeRelease = false;
    let structuralStop = completed ? null : primaryCode ?? "restore_cleanup_failed";
    let actionAudit = actionAuditMaintenance(state.artifact);
    try {
      actionAudit = appendAction(state.artifact, {
        action: "restore",
        ...hostWindows,
        restoreAttempt,
        restoreDeadlineSource,
        status: completed ? "completed" : "failed",
        structuralStop,
        primaryError,
        cleanupError: cleanupErrors.length ? cleanupErrors.join("; ") : null,
        rootGeneration: state.rootGeneration,
        rootIncarnation: state.rootIncarnation,
        captureSha256: restoredReview?.captureSha256 ?? null,
        captureMode: reviewedMovedFrame ? "transition_then_stable" : "stable",
        locomotion,
        locomotionNonceCleanup,
        captureReceipt: captureReceipt ?? captureInvocation.receipt,
        captureInvocation: captureInvocation.fence,
        preRestoreContinuity,
        preRestoreCapability,
        postCaptureContinuity,
        postCaptureCapability,
        targetStop,
        targetAbsenceProof,
        priorRelaunch,
        finalProcessProof,
        postStopSafety,
        priorForeground: priorDisposition,
        safeReleaseEligibility: safeReleaseEligible ? "eligible_after_action_publication" : "not_eligible",
        priorActionAuditMaintenance: actionAuditMaintenance(state.artifact),
      }, hooks, {
        deadlineNs: restoreActionDeadlineNs,
        monotonicNs: () => checkedMonotonic(dependencies),
        label: "restore action publication",
      });
      safeRelease = safeReleaseEligible;
    } catch (auditError) {
      if (primaryError === null) {
        primaryError = `restore action audit: ${errorText(auditError)}`;
        primaryCode = "action_audit_failed";
      } else {
        cleanupErrors.push(`restore action audit: ${errorText(auditError)}`);
      }
      completed = false;
      structuralStop = primaryCode ?? "action_audit_failed";
      actionAudit = actionAuditMaintenance(state.artifact);
    }
    state.restoreCompleted = completed;
    if (completed && restoredReview !== null) {
      if (restoredReview !== state.currentReview) {
        state.currentReview = restoredReview;
        state.requiredReview.push(restoredReview);
      }
      state.currentReviewReflectsNonzeroMutation = false;
    }
    state.status = completed ? "restored" : "stopped";
    if ((completed || safeRelease) && serialOwners.get(state.input.serial)?.runId === state.artifact.runId) {
      serialOwners.delete(state.input.serial);
    } else if (serialOwners.get(state.input.serial)?.runId === state.artifact.runId) {
      serialOwners.set(state.input.serial, {
        runId: state.artifact.runId,
        status: "quarantined",
        reason: [
          state.targetOwned ? "run-owned target stop remains unproven" : null,
          state.pendingLocomotionNonce !== null ? "locomotion nonce cleanup remains unproven" : null,
          !finalProcessProven ? "final process/activity proof remains unproven" : null,
          !finalSafetyProven ? "post-restore safety remains unproven" : null,
          restoredReview === null ? "restoration state/review remains unproven" : null,
          primaryError !== null ? `${primaryCode ?? "restore_failed"}: ${primaryError}` : null,
          cleanupErrors.length ? `cleanup: ${cleanupErrors.join("; ")}` : null,
        ].filter((value): value is string => value !== null).join("; "),
      });
    }
    const receipt: LocomotionRestoreReceipt = {
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
      restorationDisposition: completed
        ? "zero_proven"
        : safeRelease ? "safe_release_without_zero_proof" : "unresolved",
      actionAuditMaintenance: actionAudit,
    };
    if (completed) {
      state.completedRestore = {
        reviewedPriorSha256: input.reviewedPriorFrame.captureSha256,
        receipt,
        hostWindowEvidence: structuredClone(hostWindows),
      };
    } else if (safeRelease) {
      state.terminalSafeRelease = {
        reviewedPriorSha256: input.reviewedPriorFrame.captureSha256,
        receipt,
        hostWindowEvidence: structuredClone(hostWindows),
      };
    }
    return receipt;
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
    actionAuditMaintenance: actionAuditMaintenance(state.artifact),
  });

  const executeAdjudicate = async (input: InAppLocomotionAdjudicateInput, state: LocomotionState, hostWindows: LocomotionHostWindowEvidence): Promise<LocomotionAdjudicateReceipt> => {
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
      ...hostWindows,
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
    let actionAudit = actionAuditMaintenance(state.artifact);
    try {
      actionAudit = appendAction(state.artifact, {
        action: "adjudicate",
        ...hostWindows,
        status: "structural_complete",
        captureCount: frames.length,
        captureSha256: frames.map((frame) => frame.captureSha256),
        evidenceCeiling: "structural",
        reviewDisposition: "eligible_for_external_vision_adjudication",
        priorActionAuditMaintenance: actionAuditMaintenance(state.artifact),
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
      actionAuditMaintenance: actionAudit,
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
        return await executeWithHostWindowEvidence(input.serial, "prepare_preflight",
          (hostWindows) => executePrepare(input, hostWindows));
      } finally {
        busySerials.delete(input.serial);
      }
    }
    const state = runs.get(input.runId);
    if (!state) throw new Error("unknown in-app locomotion runId");
    if (busyRuns.has(input.runId)) throw new Error("a mutation is already in progress for this run");
    const mutatesSerial = input.action !== "adjudicate"
      && !(input.action === "restore" && (state.completedRestore !== null || state.terminalSafeRelease !== null));
    if (mutatesSerial && serialOwners.get(state.input.serial)?.runId !== input.runId) {
      throw new Error(`run '${input.runId}' does not own exact serial '${state.input.serial}'`);
    }
    if (mutatesSerial && busySerials.has(state.input.serial)) throw new Error(`a mutation is already in progress for exact serial '${state.input.serial}'`);
    busyRuns.add(input.runId);
    if (mutatesSerial) busySerials.add(state.input.serial);
    try {
      const terminalRestore = state.completedRestore ?? state.terminalSafeRelease;
      if (input.action === "restore" && terminalRestore) {
        const retainedHostWindows = structuredClone(terminalRestore.hostWindowEvidence);
        return { ...await executeRestore(input, state, retainedHostWindows), ...retainedHostWindows };
      }
      return await executeWithHostWindowEvidence(state.input.serial, `${input.action}_preflight`, (hostWindows) => {
        if (input.action === "step") return executeStep(input, state, hostWindows);
        if (input.action === "restore") return executeRestore(input, state, hostWindows);
        return executeAdjudicate(input, state, hostWindows);
      }, state.hostWindowBinding);
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
  let useLiveBackends = false;
  const selected = completeDependencies<Required<LiveInAppLocomotionOptions>>(
    "createLiveInAppLocomotionDependencies", options,
    { resolveAdb: true, runText: true, runBytes: true, sleep: true, monotonicNs: true },
    () => {
      useLiveBackends = true;
      return { resolveAdb, runText: run, runBytes: runBinary, sleep, monotonicNs: () => process.hrtime.bigint() };
    },
  );
  const adb = selected.resolveAdb();
  const liveRunText = selected.runText;
  const liveRunBytes = selected.runBytes;
  const liveSleep = selected.sleep;
  const liveClock = selected.monotonicNs;

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
    const activityOutput = await checked(
      context.serial,
      ["shell", "dumpsys", "activity", "activities"],
      `${context.phase} foreground activities`,
      context,
      20_000,
    );
    const { resumedComponents, foreground } = classifyResumedApplication(
      activityOutput, binding.packageName, binding.allowedResumedComponents,
    );
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

  const currentLogWindow = async (
    context: LocomotionEffectBudget & { serial: string },
    marker: string,
    label: string,
  ): Promise<Awaited<ReturnType<typeof run>>> => {
    // Filter history on the device before transferring it. -T consumes epoch time,
    // even when the output format is monotonic; preserve microseconds at BEGIN.
    const markerOutput = await checked(
      context.serial,
      ["logcat", "-b", "all", "-d", "-v", "threadtime", "-v", "epoch", "-v", "usec", "--regex", `^${escapedRegex(marker)}$`],
      `${label} BEGIN cursor`, context, 10_000, 64 * 1024,
    );
    const markerLines = markerOutput.split(/\r?\n/).filter((line) => line.includes(marker));
    const cursor = markerLines.length === 1
      ? new RegExp(`^\\s*([1-9][0-9]*\\.[0-9]{6})\\s+[0-9]+\\s+[0-9]+\\s+[VDIWEFS]\\s+WorldLocomotion\\s*:\\s*${escapedRegex(marker)}\\s*$`).exec(markerLines[0])?.[1]
      : undefined;
    if (!cursor) throw new Error(`${label} requires one exact BEGIN marker with an epoch microsecond cursor`);
    const result = await runBounded(
      context.serial,
      ["logcat", "-b", "all", "-d", "-v", "threadtime", "-T", cursor],
      label, context, 10_000, 64 * 1024 * 1024,
    );
    checkedLiveAdbResult(result, label);
    if (Buffer.byteLength(result.stdout, "utf8") >= 64 * 1024 * 1024) {
      throw new Error(`${label} current window reaches the bounded log output limit`);
    }
    return result;
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
    const result = await currentLogWindow(context, context.marker, "fresh-launch runtime-health snapshot");
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
    platform: process.platform,
    bindQemuWindow: useLiveBackends
      ? (serial) => bindMacQemuWindow(adb, serial)
      : async () => ({ ok: false, code: "binding_failed", detail: "host window binding is unavailable with injected device runners" }),
    focusQemuWindow: useLiveBackends
      ? frontmostQemu
      : async () => "host window focus is unavailable with injected device runners",
    sleep: liveSleep,
    randomBytes: (size) => crypto.randomBytes(size),
    now: () => new Date().toISOString(),
    monotonicNs: clockNs,
    readNativeRunReceipt,
    readEffectiveAppSpec: readReceiptBoundEffectiveAppSpec,
    probeHostWindow: useLiveBackends
      ? probeHostWindow
      : async (_serial, binding) => unavailableHostWindowProbe("host window probe is unavailable with injected device runners", binding),
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
      const stopReceipt: LocomotionTargetStopReceipt = { status: "stop_command_completed", serial, packageName, reason };
      if (reason === "prepare_target_clearance" || reason === "prepare_declared_incumbent_clearance") {
        // Command completion can precede process/activity teardown. Launch only after an
        // observed clearance; the interval is polling cadence, not an SDK timing guarantee.
        let pidAbsence: LocomotionCleanPidAbsenceReceipt | null = null;
        try {
          for (;;) {
            const pidResult = await runBounded(serial, ["shell", "pidof", packageName], "prepare clearance PID probe", context, 10_000, 64 * 1024);
            const output = pidResult.stdout.trim();
            const absent = pidResult.code === 1 && !pidResult.timedOut
              && pidResult.stdout === "" && pidResult.stderr === "";
            if (pidResult.timedOut || pidResult.stderr !== ""
              || (!absent && !(pidResult.code === 0 && output !== ""))) {
              throw new Error(`prepare clearance PID probe failed: ${pidResult.stderr.trim() || output || `exit ${String(pidResult.code)}`}`);
            }
            if (!absent && (!/^[1-9][0-9]*(?:\s+[1-9][0-9]*)*$/.test(output)
              || output.split(/\s+/).some((pid) => !Number.isSafeInteger(Number(pid))))) {
              throw new Error("prepare clearance PID probe returned malformed process identities");
            }
            if (absent) {
              pidAbsence = {
                status: "clean_pidof_absence",
                serial,
                packageName,
                exitCode: 1,
                timedOut: false,
                stdout: "",
                stderr: "",
              };
            }
            const activities = await checked(serial, ["shell", "dumpsys", "activity", "activities"], "prepare clearance foreground probe", context, 20_000);
            if (!activities) throw new Error("prepare clearance foreground probe returned no activity-manager evidence");
            if (absent && !parseResumedPackages(activities).includes(packageName)) break;
            await sleepWithin(context, 100, "prepare process/foreground clearance polling");
          }
        } catch (error) {
          throw new LocomotionStopClearanceError(error, stopReceipt, pidAbsence);
        }
        if (pidAbsence === null) throw new Error("prepare clearance completed without an exact clean PID-absence receipt");
        return { status: "prepare_clearance_completed", stopReceipt, pidAbsence };
      }
      return stopReceipt;
    },
    launchTarget: async (context) => {
      const { serial, component } = context;
      requireExactLiveSerial(serial);
      const attempt = () => runBounded(serial, ["shell", "am", "start", "-W", "-n", component], "target launch", context, 30_000, 1024 * 1024);
      let result = await attempt();
      for (;;) {
        const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
        const disposition = classifyActivityLaunchDisposition(output, result.code === 0 && !result.timedOut);
        const lines = output.split(/\r?\n/).map((line) => line.trim());
        const warnings = lines.filter((line) => /^Warning:/i.test(line));
        const statuses = lines.filter((line) => /^Status:/i.test(line));
        const launchStates = lines.filter((line) => /^LaunchState:/i.test(line));
        const keptForUser = disposition === "ignored" && result.stderr.trim() === ""
          && warnings.length === 1 && /^Warning:\s*Activity not started because the\s+current activity is being kept for the user\.$/i.test(warnings[0])
          && statuses.length === 1 && /^Status:\s*ok$/i.test(statuses[0])
          && (launchStates.length === 0 || (launchStates.length === 1 && /^LaunchState:\s*UNKNOWN\s+\(0\)$/i.test(launchStates[0])))
          && !lines.some((line) => /^(?:Error\b|\S*Exception\b)/i.test(line));
        if (!keptForUser) return { disposition, component, outputSha256: sha256Bytes(Buffer.from(output, "utf8")) };
        // Process clearance does not prove Android has re-enabled app switches.
        // Retry only this explicit rejection, with an observation cadence and the same deadline.
        try {
          await sleepWithin(context, 100, "target kept-for-user launch retry");
          result = await attempt();
        } catch (error) {
          throw new LocomotionStageError("launch_failed", `target launch remained kept for the user: ${errorText(error)}`);
        }
      }
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
    observeLaunchHandoff: async (context) => {
      const maxSampleGapMs = 2_000;
      const startedAt = clockNs();
      const samples: FreshLaunchHandoffObservationSample[] = [];
      const rawWindowDumps: LocomotionRawLogEvidence[] = [];
      const sample = async () => {
        const sampleStarted = clockNs();
        if (samples.length > 0) {
          const prior = BigInt(samples.at(-1)!.observedAtMonotonicNs);
          if (sampleStarted - prior > BigInt(maxSampleGapMs) * 1_000_000n) {
            throw new Error("launch-handoff observation exceeded its declared maximum sampling cadence");
          }
        }
        const result = await runBounded(
          context.serial,
          ["shell", "dumpsys", "window", "windows"],
          "launch-handoff observation window sample",
          { ...context, timeoutMs: Math.min(context.timeoutMs, 1_000) },
          1_000,
        );
        checkedLiveAdbResult(result, "launch-handoff observation window sample");
        const artifactPath = path.join(
          context.artifactRoot,
          "logs",
          `fresh-launch-handoff-observation-${String(samples.length).padStart(3, "0")}.txt`,
        );
        privateWrite(artifactPath, result.stdout);
        const identity = artifactFileIdentity(artifactPath, "launch-handoff observation raw window", 64 * 1024 * 1024);
        const bytes = readSameArtifactFile(artifactPath, identity, "launch-handoff observation raw window", 64 * 1024 * 1024);
        const observedAt = clockNs();
        const rawWindowDump = { path: fs.realpathSync(artifactPath), sha256: identity.sha256, bytes: identity.bytes };
        rawWindowDumps.push(rawWindowDump);
        samples.push({
          elapsedMs: Number((observedAt - startedAt) / 1_000_000n),
          observedAtMonotonicNs: observedAt.toString(),
          dialogs: freshLaunchDialogs(bytes.toString("utf8")),
          rawWindowDump,
        });
      };
      await sample();
      while (!context.signal.aborted) {
        await sleepWithin(context, 250, "launch-handoff observation cadence");
        if (!context.signal.aborted) await sample();
      }
      await sample();
      return {
        claim: "no_blocking_dialog_at_retained_samples",
        maxSampleGapMs,
        startedAtMonotonicNs: startedAt.toString(),
        endedAtMonotonicNs: clockNs().toString(),
        samples,
        rawWindowDumps,
        dialogs: [...new Set(samples.flatMap((entry) => entry.dialogs))],
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
    sampleSafety: async (context) => {
      let snapshot = await sampleSafetyLive(context);
      if (context.phase !== "prepare_baseline") return snapshot;
      // Cold-launch configuration may still be transitioning after am start returns.
      // Observe readiness under the caller's deadline; 100ms is sampling cadence,
      // not a promised SDK transition time. The launch observer remains active.
      for (;;) {
        const unsafe = safetyProblem(snapshot);
        if (!unsafe || finalGlobalSafetyProblem(snapshot)) return snapshot;
        try {
          await sleepWithin(context, 100, "prepare Full-stage readiness polling");
          snapshot = await sampleSafetyLive(context);
        } catch (error) {
          throw new LocomotionStageError(
            "safety_baseline_failed",
            `unsafe Full-stage baseline: ${unsafe}; readiness observation failed: ${errorText(error)}`,
          );
        }
      }
    },
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
        const windowProbeStartedAt = clockNs();
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
        const rawWindowDump = { path: fs.realpathSync(windowPath), sha256: windowIdentity.sha256, bytes: windowIdentity.bytes };
        rawWindowDumps.push(rawWindowDump);
        const dialogs = freshLaunchDialogs(windowBytes.toString("utf8"));
        const windowRetainedAt = clockNs();
        const windowHandoffToken = freshLaunchMonitorHandoffToken(context.runId, {
          rawWindowDump,
          probeStartedAtMonotonicNs: windowProbeStartedAt.toString(),
          retainedAtMonotonicNs: windowRetainedAt.toString(),
        });
        if (sampleIndex === 0) await context.onFirstWindowSample({
          rawWindowDump,
          probeStartedAtMonotonicNs: windowProbeStartedAt.toString(),
          retainedAtMonotonicNs: windowRetainedAt.toString(),
          handoffToken: windowHandoffToken,
        });
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
        samples.push({
          elapsedMs,
          windowProbeStartedAtMonotonicNs: windowProbeStartedAt.toString(),
          windowRetainedAtMonotonicNs: windowRetainedAt.toString(),
          windowHandoffToken,
          dialogs,
          safety,
          continuity,
          runtimeHealth: runtimeHealth.health,
        });
      }
      return {
        durationMs: Number((clockNs() - startedNs) / 1_000_000n),
        healthBoundaryMarker: marker,
        samples,
        rawHealthLogs,
        rawWindowDumps,
      };
    },
    captureSettled: useLiveBackends
      ? (input, context) => executeLiveCaptureSettled(input, {
        adbPath: adb, monotonicNs: clockNs, hostWindowBinding: context?.hostWindowBinding,
      })
      : async () => { throw new Error("settled capture is unavailable with injected device runners"); },
    readReviewImage: readBoundReviewImage,
    sampleContinuity: sampleContinuityLive,
    requestLocomotion: (input) => requestAgentBridgeLocomotion(adb, input, {
      runText: liveRunText,
      runBytes: liveRunBytes,
      sleep: liveSleep,
      monotonicNs: clockNs,
    }),
    cleanupLocomotionNonce: (context) => cleanupAgentBridgeLocomotionNonce(adb, {
      serial: context.serial,
      packageName: context.packageName,
      requestId: context.requestId,
      tag: context.tag,
      rootGeneration: context.rootGeneration,
      rootIncarnation: context.rootIncarnation,
      controlTimeoutMs: Math.max(1_000, Math.min(15_000, context.timeoutMs)),
      ackReadTimeoutMs: Math.max(250, Math.min(15_000, context.timeoutMs)),
      pollMs: 100,
      stabilityReads: 2,
      deadlineMonotonicNs: context.deadlineMonotonicNs,
      ...(context.processStopped ? { processStopped: true as const } : {}),
      ...(context.probeOnly ? { probeOnly: true as const } : {}),
      ...(context.cleanupOnly ? { cleanupOnly: true as const } : {}),
    }, { runText: liveRunText, runBytes: liveRunBytes, sleep: liveSleep, monotonicNs: clockNs }),
    emitMarker: async (context) => {
      const { serial, marker } = context;
      await checked(serial, ["shell", "log", "-t", "WorldLocomotion", marker], `locomotion marker ${marker}`, context, 5_000, 64 * 1024);
    },
    collectStepLogs: async (context) => {
      requireExactLiveSerial(context.serial);
      const result = await currentLogWindow(context, context.beginMarker, "locomotion bracket log");
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
      const normalizedPidOutput = pidResult.stdout.trim();
      const normalizedPidError = pidResult.stderr.trim();
      const cleanPresentExit = pidResult.code === 0 && normalizedPidOutput !== "" && normalizedPidError === "";
      const cleanAbsentExit = pidResult.code === 1 && normalizedPidOutput === "" && normalizedPidError === "";
      if (pidResult.timedOut || (!cleanPresentExit && !cleanAbsentExit)) {
        throw new Error(`final target PID probe failed: ${pidResult.stderr.trim() || pidResult.stdout.trim() || `exit ${String(pidResult.code)}`}`);
      }
      const pidofOutput = pidResult.stdout;
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
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(context.evidenceId)) {
        throw new Error("final process/activity evidenceId must be one lowercase dash-delimited identifier");
      }
      const artifactPath = path.join(context.artifactRoot, "logs", `999-final-process-activity-${context.evidenceId}.json`);
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
      description: "Run one receipt-bound Full-stage in-app world-root route as strict prepare, reviewed step, restore, and structural adjudicate actions. A receipt-bound prior foreground is withheld and not relaunched because relaunch would orphan its immutable receipt. Every mutation uses one explicit direct or replacement mechanism, exact serial and runtime binding, stable captures, safety/continuity evidence, and a caller-reserved external artifact root. On macOS, request focus for the run's bound qemu window and require clear visibility before measurement; other hosts record host-window checks as not_applicable. Returned captures still require LOOK; the tool does not award visual or device verification.",
      inputSchema: inAppLocomotionInputSchema,
    },
    async (args) => {
      let responseEvidence: LocomotionHostWindowEvidence | null = null;
      try {
        const result = await orchestrator.execute(args as InAppLocomotionInput);
        responseEvidence = {
          hostWindowFocusRequest: result.hostWindowFocusRequest,
          hostWindowProbe: result.hostWindowProbe,
          hostWindowProbes: result.hostWindowProbes,
        };
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
        const evidence = (error as { hostWindowEvidence?: LocomotionHostWindowEvidence } | null)?.hostWindowEvidence
          ?? responseEvidence ?? {
            hostWindowFocusRequest: null,
            hostWindowProbe: unavailableHostWindowProbe("locomotion action failed before a host-window observation was retained"),
            hostWindowProbes: [],
          };
        return okJson({ status: "error", error: errorText(error), evidenceCeiling: "structural", lookRequired: true, ...evidence });
      }
    },
  );
}
