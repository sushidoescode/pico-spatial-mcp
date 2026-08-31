import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAdb } from "./emulatorlook.js";
import {
  classifyObservedHomeEnvironment,
  deriveFitRequest,
  fitRequirementSchema,
  fitRequestSchema,
  homeEnvironmentDatasetSchema,
  homeEnvironmentRankResultSchema,
  loadPackagedHomeEnvironmentDataset,
  rankHomeEnvironments,
  type FitRequest,
  type HomeEnvironment,
  type HomeEnvironmentDataset,
} from "./homeenvironmentcatalog.js";
import {
  executeGuardedHostSelection,
  type HostSelectionResult,
} from "./homeenvironmenthost.js";
import { canonicalIdentity } from "./runreceiptidentity.js";
import {
  executeLiveQuerySceneAnchors,
  isCoherentTwoReadSceneDrift,
  isExternalGeometryArtifactPath,
  querySceneAnchorsOutputSchema,
  type QuerySceneAnchorsInput,
  type SceneDriftPolicy,
} from "./sceneanchors.js";
import { run, sleep } from "./util.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const packageNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/);
const WORLDSPACE_TAG = "PICOHomeEnvironmentSelector";
const DISALLOWED_LOGCAT_CONTROL_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/u;

export const selectorRuntimeInputSchema = z.object({
  serial: z.string().min(1),
  packageName: packageNameSchema,
  expectedBuildReceiptId: sha256Schema,
  expectedStageStyle: z.enum(["Mixed", "Full"]),
}).strict();
export type SelectorRuntimeInput = z.infer<typeof selectorRuntimeInputSchema>;

export const verificationBaselineSchema = z.object({
  datasetId: z.string().min(1),
  datasetContentSha256: sha256Schema,
  serial: z.string().min(1),
  packageName: packageNameSchema,
  expectedBuildReceiptId: sha256Schema,
  bootId: z.string().min(1),
  snapshotId: sha256Schema,
}).strict();
export type VerificationBaseline = z.infer<typeof verificationBaselineSchema>;

type ParsedWorldSpaceMarkerLine = {
  observedAtEpochSeconds: number;
  nonce: string;
  tag: typeof WORLDSPACE_TAG;
  message: string;
  rawLine: string;
};

/** Parse exactly one epoch-formatted marker row emitted by this selector. */
export function parseWorldSpaceMarkerLine(line: string): ParsedWorldSpaceMarkerLine | null {
  if (typeof line !== "string" || DISALLOWED_LOGCAT_CONTROL_PATTERN.test(line)) return null;
  const rawLine = line;
  const matched = /^[ \t]*(\d+(?:\.\d+)?)[ \t]+([1-9]\d*)[ \t]+([1-9]\d*)[ \t]+I PICOHomeEnvironmentSelector: (MARK ([a-f0-9]{64}))$/.exec(rawLine);
  if (!matched) return null;
  const observedAtEpochSeconds = Number(matched[1]);
  if (!Number.isFinite(observedAtEpochSeconds) || observedAtEpochSeconds <= 0) return null;
  return {
    observedAtEpochSeconds,
    nonce: matched[5],
    tag: WORLDSPACE_TAG,
    message: matched[4],
    rawLine,
  };
}

const markerReceiptSchema = z.object({
  serial: z.string().min(1),
  nonce: sha256Schema,
  tag: z.literal(WORLDSPACE_TAG),
  message: z.string().min(1),
  status: z.literal("marked"),
  observedAtEpochSeconds: z.number().positive().finite(),
  rawLine: z.string().min(1),
}).strict().superRefine((receipt, ctx) => {
  const row = parseWorldSpaceMarkerLine(receipt.rawLine);
  if (
    row === null
    || row.rawLine !== receipt.rawLine
    || row.nonce !== receipt.nonce
    || row.tag !== receipt.tag
    || row.message !== receipt.message
    || row.observedAtEpochSeconds !== receipt.observedAtEpochSeconds
    || receipt.message !== `MARK ${receipt.nonce}`
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rawLine"],
      message: "marker receipt must exactly match its epoch-formatted emitted row",
    });
  }
});
export type WorldSpaceMarkerReceipt = z.infer<typeof markerReceiptSchema>;

const explicitRequirementsSchema = z.array(fitRequirementSchema).min(1).superRefine((requirements, ctx) => {
  if (new Set(requirements.map((requirement) => requirement.label)).size !== requirements.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "requirements must not duplicate labels" });
  }
});
const explicitSourceShape = { requirements: explicitRequirementsSchema };
const briefSourceShape = {
  briefId: z.string(),
};

export const selectHomeEnvironmentInputSchema = z.union([
  z.object({ action: z.literal("rank"), ...explicitSourceShape }).strict(),
  z.object({ action: z.literal("rank"), ...briefSourceShape }).strict(),
  z.object({ action: z.literal("switch"), ...explicitSourceShape, runtime: selectorRuntimeInputSchema }).strict(),
  z.object({ action: z.literal("switch"), ...briefSourceShape, runtime: selectorRuntimeInputSchema }).strict(),
  z.object({ action: z.literal("verify"), ...explicitSourceShape, runtime: selectorRuntimeInputSchema, baseline: verificationBaselineSchema, marker: markerReceiptSchema }).strict(),
  z.object({ action: z.literal("verify"), ...briefSourceShape, runtime: selectorRuntimeInputSchema, baseline: verificationBaselineSchema, marker: markerReceiptSchema }).strict(),
]);
export type SelectHomeEnvironmentInput = z.infer<typeof selectHomeEnvironmentInputSchema>;

type ParsedCurrentDefaultSpaceRow = {
  observedAtEpochSeconds: number;
  spaceId: number;
  spaceName: "Default Space";
  isCurrent: true;
  sceneId: string;
  spaceSession: string;
  source: "WorldSpaceDB getSpace";
  sceneIdentityRole: "coarse_consistency_only_non_discriminating";
  rawLine: string;
};

function parseCurrentDefaultSpaceRow(line: string): ParsedCurrentDefaultSpaceRow | null {
  if (typeof line !== "string" || DISALLOWED_LOGCAT_CONTROL_PATTERN.test(line)) return null;
  const rawLine = line;
  const matched = /^[ \t]*(\d+(?:\.\d+)?)[ \t]+([1-9]\d*)[ \t]+([1-9]\d*)[ \t]+I WorldSpace: WorldSpaceDB, getSpace: space=DBSpace\(([^\t]*)\)$/.exec(rawLine);
  if (!matched) return null;
  const observedAtEpochSeconds = Number(matched[1]);
  if (!Number.isFinite(observedAtEpochSeconds) || observedAtEpochSeconds <= 0) return null;

  const fields = new Map<string, string>();
  for (const field of matched[4].split(", ")) {
    const separator = field.indexOf("=");
    if (separator <= 0) return null;
    const key = field.slice(0, separator);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || fields.has(key)) return null;
    fields.set(key, field.slice(separator + 1));
  }
  if (fields.get("name") !== "Default Space" || fields.get("isCurrent") !== "true") return null;
  const rawSpaceId = fields.get("id");
  const sceneId = fields.get("envId");
  const spaceSession = fields.get("spaceSession");
  if (!rawSpaceId || !/^\d+$/.test(rawSpaceId) || !sceneId || !spaceSession) return null;
  const spaceId = Number(rawSpaceId);
  if (!Number.isSafeInteger(spaceId)) return null;
  return {
    observedAtEpochSeconds,
    spaceId,
    spaceName: "Default Space",
    isCurrent: true,
    sceneId,
    spaceSession,
    source: "WorldSpaceDB getSpace",
    sceneIdentityRole: "coarse_consistency_only_non_discriminating",
    rawLine,
  };
}

export const currentDefaultSpaceSchema = z.object({
  observedAtEpochSeconds: z.number().positive().finite(),
  spaceId: z.number().int().nonnegative(),
  spaceName: z.literal("Default Space"),
  isCurrent: z.literal(true),
  sceneId: z.string().min(1),
  spaceSession: z.string().min(1),
  source: z.literal("WorldSpaceDB getSpace"),
  sceneIdentityRole: z.literal("coarse_consistency_only_non_discriminating"),
  rawLine: z.string().min(1),
}).strict().superRefine((observation, ctx) => {
  const row = parseCurrentDefaultSpaceRow(observation.rawLine);
  if (
    row === null
    || row.rawLine !== observation.rawLine
    || row.observedAtEpochSeconds !== observation.observedAtEpochSeconds
    || row.spaceId !== observation.spaceId
    || row.spaceName !== observation.spaceName
    || row.isCurrent !== observation.isCurrent
    || row.sceneId !== observation.sceneId
    || row.spaceSession !== observation.spaceSession
    || row.source !== observation.source
    || row.sceneIdentityRole !== observation.sceneIdentityRole
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rawLine"],
      message: "WorldSpace observation must exactly match its epoch-formatted raw row",
    });
  }
});
export type CurrentDefaultSpace = z.infer<typeof currentDefaultSpaceSchema>;

const worldSpaceObservationPhaseSchema = z.enum(["pre_world_space", "post_world_space"]);
const worldSpaceObservationDiagnosticSchema = z.string().min(1).max(160);
const worldSpaceObservationAttemptSchema = z.discriminatedUnion("outcome", [
  z.object({
    phase: worldSpaceObservationPhaseSchema,
    outcome: z.literal("observed"),
    observation: currentDefaultSpaceSchema,
  }).strict(),
  z.object({
    phase: worldSpaceObservationPhaseSchema,
    outcome: z.literal("missing"),
  }).strict(),
  z.object({
    phase: worldSpaceObservationPhaseSchema,
    outcome: z.literal("invalid"),
    diagnostic: worldSpaceObservationDiagnosticSchema,
  }).strict(),
  z.object({
    phase: worldSpaceObservationPhaseSchema,
    outcome: z.literal("failed"),
    diagnostic: worldSpaceObservationDiagnosticSchema,
  }).strict(),
]);
type WorldSpaceObservationPhase = z.infer<typeof worldSpaceObservationPhaseSchema>;
type WorldSpaceObservationAttempt = z.infer<typeof worldSpaceObservationAttemptSchema>;

const hostReceiptSchema = z.object({
  action: z.enum(["bind", "focus", "open_picker", "dialog_guard", "capture_preflight", "click", "capture", "close", "close_verify"]),
  status: z.enum(["ok", "failed"]),
  detail: z.string(),
}).strict();
const hostSelectionOutputSchema = z.union([
  z.object({
    status: z.literal("manual_switch_required"),
    targetTile: z.string(),
    detail: z.string(),
    baselineSafe: z.literal(true),
  }).strict(),
  z.object({
    status: z.literal("host_selection_not_observed"),
    targetTile: z.string(),
    selectedTile: z.null(),
    detail: z.string(),
    receipts: z.array(hostReceiptSchema),
  }).strict(),
  z.object({
    status: z.literal("host_selection_observed"),
    targetTile: z.string(),
    afterDialogSha256: sha256Schema,
    receipts: z.array(hostReceiptSchema),
    close: z.object({ closed: z.literal(true) }).strict(),
  }).strict(),
]);

const classifiedEnvironmentOutputSchema = homeEnvironmentDatasetSchema
  .innerType()
  .shape.environments.element;
const classificationOutputSchema = z.object({
  status: z.enum(["unique", "no_match", "ambiguous", "terminal_status", "incomplete_requested_labels", "extent_mismatch"]),
  environment: classifiedEnvironmentOutputSchema.nullable(),
  histogramMatches: z.array(z.string()),
  predicates: z.object({
    bridgeStatus: z.enum(["ready", "label_absent", "not_ready", "stage_not_open", "bridge_unavailable", "stage_mismatch", "invalid_payload", "binding_failed"]),
    missingRequestedLabels: z.array(z.string()),
    surfaceExtentMultisetsMatch: z.boolean().nullable(),
    requirementsFit: z.boolean().nullable(),
  }).strict(),
}).strict();

const verificationTargetSchema = z.object({
  tile: z.string().min(1),
  sceneId: z.string().min(1),
  selectedDialogSha256: sha256Schema,
}).strict();
type VerificationTarget = z.infer<typeof verificationTargetSchema>;

const verificationOutputSchema = z.object({
  runtime: selectorRuntimeInputSchema,
  target: verificationTargetSchema,
  marker: markerReceiptSchema.nullable(),
  preWorldSpaceAttempt: worldSpaceObservationAttemptSchema.nullable(),
  postWorldSpaceAttempt: worldSpaceObservationAttemptSchema.nullable(),
  preQuery: querySceneAnchorsOutputSchema.nullable(),
  postQuery: querySceneAnchorsOutputSchema.nullable(),
  preSnapshotId: sha256Schema.nullable(),
  postSnapshotId: sha256Schema.nullable(),
  classification: classificationOutputSchema.nullable(),
  sceneIdentityRole: z.literal("coarse_consistency_only_non_discriminating"),
}).strict();
type VerificationOutput = z.infer<typeof verificationOutputSchema>;

const datasetReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.literal("pico-emulator-6.0-home-environments-v1"),
  datasetContentSha256: sha256Schema,
  measuredAt: z.string(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourcePath: z.string().min(1),
  capabilitySummarySha256: sha256Schema,
  selectionProvenanceSha256: sha256Schema,
}).strict();

const verificationFailurePhaseSchema = z.enum([
  "pre_world_space",
  "pre_query",
  "marker",
  "host_selection",
  "post_world_space",
  "post_query",
  "classification",
]);
type VerificationFailurePhase = z.infer<typeof verificationFailurePhaseSchema>;

const selectHomeEnvironmentOutputObjectSchema = z.object({
  status: z.enum(["ranked", "no_fit", "invalid_request", "manual_switch_required", "selected_verified", "verification_failed"]),
  action: z.enum(["rank", "switch", "verify"]).nullable(),
  dataset: datasetReceiptSchema,
  requirements: fitRequestSchema.nullable(),
  ranking: homeEnvironmentRankResultSchema.nullable(),
  selectedTarget: z.string().nullable(),
  baseline: verificationBaselineSchema.nullable(),
  hostSelection: hostSelectionOutputSchema.nullable(),
  verification: verificationOutputSchema.nullable(),
  failurePhase: verificationFailurePhaseSchema.nullable(),
  error: z.object({ code: z.string().min(1), detail: z.string().min(1) }).strict().nullable(),
  evidenceCeiling: z.literal("structural"),
}).strict();
type SelectHomeEnvironmentOutputObject = z.infer<typeof selectHomeEnvironmentOutputObjectSchema>;
type QueryReceipt = z.infer<typeof querySceneAnchorsOutputSchema>;

function verificationIdentityMatches(result: SelectHomeEnvironmentOutputObject): boolean {
  const verification = result.verification;
  return verification !== null
    && result.selectedTarget !== null
    && verification.target.tile === result.selectedTarget
    && result.ranking?.datasetId === result.dataset.datasetId
    && result.ranking.selectedTarget === result.selectedTarget;
}

function baselineReceiptMatches(result: SelectHomeEnvironmentOutputObject): boolean {
  const verification = result.verification;
  const baseline = result.baseline;
  return verification !== null
    && baseline !== null
    && baseline.datasetId === result.dataset.datasetId
    && baseline.datasetContentSha256 === result.dataset.datasetContentSha256
    && baseline.serial === verification.runtime.serial
    && baseline.packageName === verification.runtime.packageName
    && baseline.expectedBuildReceiptId === verification.runtime.expectedBuildReceiptId;
}

function queryReceiptMatchesSnapshot(query: QueryReceipt | null, snapshotId: string | null): query is QueryReceipt {
  return query !== null && snapshotId === query.snapshotId;
}

function completePreSnapshot(
  query: QueryReceipt | null,
  runtime: SelectorRuntimeInput,
  baseline: VerificationBaseline | null,
): boolean {
  if (
    query === null
    || (query.status !== "ready" && query.status !== "label_absent")
    || (query.status === "ready" ? query.error !== null : query.error?.code !== "label_absent")
    || query.snapshotId === null
    || query.queriedAtMonotonicNs === null
    || query.trackingState !== "RUNNING"
    || query.retries < 1
    || query.totalAnchorCount < 1
    || query.matchedAnchorCount !== query.anchors.length
    || query.requestedLabels.length !== SELECTOR_REQUESTED_LABELS.length
    || query.requestedLabels.some((label, index) => label !== SELECTOR_REQUESTED_LABELS[index])
    || identityDrift(query, runtime, baseline) !== null
    || sceneDriftFailure(query) !== null
    || query.drift.maxTransformDeltaM > SELECTOR_SCENE_DRIFT_POLICY.maxTransformDeltaM
    || query.drift.maxTransformDeltaDeg > SELECTOR_SCENE_DRIFT_POLICY.maxTransformDeltaDeg
    || query.drift.maxExtentDeltaM > SELECTOR_SCENE_DRIFT_POLICY.maxExtentDeltaM
    || query.drift.labelSetChanges !== 0
    || query.drift.topologyChanges !== 0
    || query.drift.unmatchedPrevious !== 0
    || query.drift.unmatchedCurrent !== 0
    || query.drift.ambiguities.length !== 0
    || !isCoherentTwoReadSceneDrift(query.drift, query.totalAnchorCount)
    || query.drift.deltas.length === 0
    || !query.drift.deltas.some((delta) => delta.metric === "anchor_count")
    || query.drift.deltas.some((delta) => !delta.withinPolicy)
    || query.drift.deltas.some((delta) => delta.metric === "anchor" && (
      delta.transformDeltaM > SELECTOR_SCENE_DRIFT_POLICY.maxTransformDeltaM
      || delta.transformDeltaDeg > SELECTOR_SCENE_DRIFT_POLICY.maxTransformDeltaDeg
      || delta.extentDeltaM > SELECTOR_SCENE_DRIFT_POLICY.maxExtentDeltaM
      || delta.labelsChanged
      || delta.topologyChanged
    ))
    || query.drift.deltas.some((delta) => delta.metric === "unmatched_anchors" || delta.metric === "geometric_match_ambiguity")
  ) return false;

  const binding = query.applicationRuntimeBinding;
  const geometry = query.geometryRef;
  if (
    !binding
    || !("requestId" in binding)
    || binding.liveIdentity.bootQemu !== "1"
    || !geometry
    || !isExternalGeometryArtifactPath(geometry.path, binding.bridgeRevision, binding.requestId)
    || geometry.bytes < 1
    || geometry.bridgeRevision !== binding.bridgeRevision
  ) return false;

  const [bindReceipt, broadcastReceipt, pullReceipt, cleanupReceipt, publishReceipt] = query.actionReceipts;
  if (
    query.actionReceipts.length !== 5
    || bindReceipt?.action !== "bind_application_runtime"
    || broadcastReceipt?.action !== "bridge_broadcast"
    || pullReceipt?.action !== "bridge_payload_pull"
    || cleanupReceipt?.action !== "bridge_payload_cleanup"
    || publishReceipt?.action !== "publish_geometry"
    || query.actionReceipts.some((receipt) => receipt.status !== "applied")
    || bindReceipt.ack.serial !== binding.serial
    || bindReceipt.ack.packageName !== binding.packageName
    || bindReceipt.ack.buildReceiptId !== binding.buildReceiptId
    || bindReceipt.ack.apkSha256 !== binding.apkSha256
    || bindReceipt.ack.pid !== binding.foregroundProcess.pid
    || bindReceipt.ack.pidStartTicks !== binding.foregroundProcess.pidStartTicks
    || broadcastReceipt.ack.serial !== binding.serial
    || broadcastReceipt.ack.action !== `${binding.packageName}.AGENT_CMD`
    || broadcastReceipt.ack.command !== "query_scene_anchors"
    || broadcastReceipt.ack.requestId !== binding.requestId
    || broadcastReceipt.ack.outcome !== "completed"
    || pullReceipt.ack.serial !== binding.serial
    || pullReceipt.ack.packageName !== binding.packageName
    || pullReceipt.ack.requestId !== binding.requestId
    || pullReceipt.ack.outcome !== "completed"
    || pullReceipt.ack.relativePath !== `cache/agentbridge/scene-snapshots/${binding.requestId}.json`
    || pullReceipt.ack.bytes !== geometry.bytes
    || cleanupReceipt.ack.serial !== binding.serial
    || cleanupReceipt.ack.packageName !== binding.packageName
    || cleanupReceipt.ack.requestId !== binding.requestId
    || cleanupReceipt.ack.outcome !== "completed"
    || cleanupReceipt.ack.relativePath !== pullReceipt.ack.relativePath
    || publishReceipt.ack.path !== geometry.path
    || publishReceipt.ack.sha256 !== geometry.sha256
    || publishReceipt.ack.bytes !== geometry.bytes
  ) return false;

  const histogramAssignments = Object.values(query.histogram).reduce((sum, count) => sum + count, 0);
  if (histogramAssignments < query.totalAnchorCount) return false;
  if (query.status === "label_absent") {
    return query.anchors.length === 0
      && query.matchedAnchorCount === 0
      && SELECTOR_REQUESTED_LABELS.every((label) => (query.histogram[label] ?? 0) === 0);
  }
  return query.anchors.length > 0
    && query.anchors.every((anchor) => anchor.labels.some((label) => SELECTOR_REQUESTED_LABELS.includes(label)));
}

function completeReadySnapshot(
  query: QueryReceipt | null,
  runtime: SelectorRuntimeInput,
  baseline: VerificationBaseline | null,
): query is QueryReceipt {
  return query?.status === "ready" && completePreSnapshot(query, runtime, baseline);
}

function worldSpaceMatchesTarget(observation: CurrentDefaultSpace | null, target: VerificationTarget): boolean {
  return observation !== null && observation.sceneId === target.sceneId;
}

function observationAttemptForPhase(
  verification: VerificationOutput,
  phase: WorldSpaceObservationPhase,
): WorldSpaceObservationAttempt | null {
  return phase === "pre_world_space"
    ? verification.preWorldSpaceAttempt
    : verification.postWorldSpaceAttempt;
}

function observedWorldSpaceForPhase(
  verification: VerificationOutput,
  phase: WorldSpaceObservationPhase,
): CurrentDefaultSpace | null {
  const attempt = observationAttemptForPhase(verification, phase);
  return attempt?.phase === phase && attempt.outcome === "observed"
    ? attempt.observation
    : null;
}

function markerReceiptMatches(
  marker: WorldSpaceMarkerReceipt | null,
  runtime: SelectorRuntimeInput,
  baseline: VerificationBaseline,
): marker is WorldSpaceMarkerReceipt {
  return marker !== null
    && markerReceiptSchema.safeParse(marker).success
    && marker.serial === runtime.serial
    && marker.nonce === baseline.snapshotId
    && marker.tag === WORLDSPACE_TAG
    && marker.message === `MARK ${baseline.snapshotId}`;
}

function markerReceiptsExactlyMatch(
  returned: WorldSpaceMarkerReceipt,
  caller: WorldSpaceMarkerReceipt,
): boolean {
  return returned.serial === caller.serial
    && returned.nonce === caller.nonce
    && returned.tag === caller.tag
    && returned.message === caller.message
    && returned.status === caller.status
    && returned.observedAtEpochSeconds === caller.observedAtEpochSeconds
    && returned.rawLine === caller.rawLine;
}

function baselinesExactlyMatch(
  returned: VerificationBaseline,
  caller: VerificationBaseline,
): boolean {
  return returned.datasetId === caller.datasetId
    && returned.datasetContentSha256 === caller.datasetContentSha256
    && returned.serial === caller.serial
    && returned.packageName === caller.packageName
    && returned.expectedBuildReceiptId === caller.expectedBuildReceiptId
    && returned.bootId === caller.bootId
    && returned.snapshotId === caller.snapshotId;
}

function runtimesExactlyMatch(
  returned: SelectorRuntimeInput,
  caller: SelectorRuntimeInput,
): boolean {
  return returned.serial === caller.serial
    && returned.packageName === caller.packageName
    && returned.expectedBuildReceiptId === caller.expectedBuildReceiptId
    && returned.expectedStageStyle === caller.expectedStageStyle;
}

function hostObservedReceiptMatches(
  hostSelection: HostSelectionResult | null,
  target: VerificationTarget,
): boolean {
  return hostSelection?.status === "host_selection_observed"
    && hostSelection.targetTile === target.tile
    && hostSelection.afterDialogSha256 === target.selectedDialogSha256
    && hostSelection.close.closed;
}

function hostManualReceiptMatches(
  hostSelection: HostSelectionResult | null,
  target: VerificationTarget,
): boolean {
  return hostSelection?.status === "manual_switch_required"
    && hostSelection.targetTile === target.tile
    && hostSelection.baselineSafe;
}

function noPostEvidence(verification: VerificationOutput): boolean {
  return verification.postWorldSpaceAttempt === null
    && verification.postQuery === null
    && verification.postSnapshotId === null
    && verification.classification === null;
}

function switchPreQueryReceiptsMatch(result: SelectHomeEnvironmentOutputObject): boolean {
  const verification = result.verification;
  const baseline = result.baseline;
  if (
    result.action !== "switch"
    || !verificationIdentityMatches(result)
    || !baselineReceiptMatches(result)
    || !verification
    || !baseline
  ) return false;
  return worldSpaceMatchesTarget(
    observedWorldSpaceForPhase(verification, "pre_world_space"),
    verification.target,
  )
    && verification.preQuery !== null
    && completePreSnapshot(verification.preQuery, verification.runtime, baseline)
    && verification.preSnapshotId === verification.preQuery.snapshotId
    && verification.preSnapshotId === baseline.snapshotId
    && baseline.bootId === verification.preQuery.applicationRuntimeBinding?.liveIdentity.bootId;
}

function switchMarkerReceiptsMatch(result: SelectHomeEnvironmentOutputObject): boolean {
  const verification = result.verification;
  const baseline = result.baseline;
  const preObservation = verification === null
    ? null
    : observedWorldSpaceForPhase(verification, "pre_world_space");
  return switchPreQueryReceiptsMatch(result)
    && verification !== null
    && baseline !== null
    && markerReceiptMatches(verification.marker, verification.runtime, baseline)
    && preObservation !== null
    && preObservation.observedAtEpochSeconds < verification.marker.observedAtEpochSeconds;
}

function switchPostPrerequisitesMatch(result: SelectHomeEnvironmentOutputObject): boolean {
  return switchMarkerReceiptsMatch(result)
    && result.verification !== null
    && hostObservedReceiptMatches(result.hostSelection, result.verification.target);
}

function verifyPostPrerequisitesMatch(result: SelectHomeEnvironmentOutputObject): boolean {
  const verification = result.verification;
  const baseline = result.baseline;
  return result.action === "verify"
    && verificationIdentityMatches(result)
    && baselineReceiptMatches(result)
    && verification !== null
    && baseline !== null
    && result.hostSelection === null
    && verification.preWorldSpaceAttempt === null
    && verification.preQuery === null
    && markerReceiptMatches(verification.marker, verification.runtime, baseline)
    && verification.preSnapshotId === baseline.snapshotId;
}

function postPrerequisitesMatch(result: SelectHomeEnvironmentOutputObject): boolean {
  return switchPostPrerequisitesMatch(result) || verifyPostPrerequisitesMatch(result);
}

function observedPostWorldSpaceReceiptMatches(result: SelectHomeEnvironmentOutputObject): boolean {
  const verification = result.verification;
  const baseline = result.baseline;
  if (verification === null || baseline === null) return false;
  const observation = observedWorldSpaceForPhase(verification, "post_world_space");
  return markerReceiptMatches(verification.marker, verification.runtime, baseline)
    && observation !== null
    && currentDefaultSpaceSchema.safeParse(observation).success
    && observation.observedAtEpochSeconds > verification.marker.observedAtEpochSeconds;
}

function postWorldSpaceReceiptMatches(result: SelectHomeEnvironmentOutputObject): boolean {
  const verification = result.verification;
  if (verification === null || !observedPostWorldSpaceReceiptMatches(result)) return false;
  const observation = observedWorldSpaceForPhase(verification, "post_world_space");
  return observation !== null
    && worldSpaceMatchesTarget(observation, verification.target);
}

function changedPostQueryReceiptsMatch(result: SelectHomeEnvironmentOutputObject): boolean {
  const verification = result.verification;
  const baseline = result.baseline;
  return verification !== null
    && baseline !== null
    && completeReadySnapshot(verification.postQuery, verification.runtime, baseline)
    && verification.postSnapshotId === verification.postQuery.snapshotId
    && verification.postSnapshotId !== baseline.snapshotId;
}

function classificationPredicatesAreReady(
  classification: z.infer<typeof classificationOutputSchema>,
): boolean {
  return classification.predicates.bridgeStatus === "ready";
}

function uniqueClassificationReceiptMatches(
  classification: z.infer<typeof classificationOutputSchema> | null,
  target: VerificationTarget,
  expectTarget: boolean,
): boolean {
  const environment = classification?.environment;
  if (
    classification?.status !== "unique"
    || !environment
    || !classificationPredicatesAreReady(classification)
    || classification.predicates.missingRequestedLabels.length !== 0
    || classification.predicates.surfaceExtentMultisetsMatch !== true
    || classification.predicates.requirementsFit !== true
    || classification.histogramMatches.length !== 1
    || classification.histogramMatches[0] !== environment.tile
  ) return false;
  if (!expectTarget) return environment.tile !== target.tile;
  return environment.tile === target.tile
    && environment.sceneId === target.sceneId
    && environment.selectedDialogSha256 === target.selectedDialogSha256;
}

function completeManualReceiptsMatch(result: SelectHomeEnvironmentOutputObject): boolean {
  return switchMarkerReceiptsMatch(result)
    && result.verification !== null
    && hostManualReceiptMatches(result.hostSelection, result.verification.target)
    && noPostEvidence(result.verification);
}

function completeSelectedReceiptsMatch(result: SelectHomeEnvironmentOutputObject): boolean {
  return postPrerequisitesMatch(result)
    && postWorldSpaceReceiptMatches(result)
    && changedPostQueryReceiptsMatch(result)
    && result.verification !== null
    && uniqueClassificationReceiptMatches(result.verification.classification, result.verification.target, true);
}

type FailureMatchState = {
  result: SelectHomeEnvironmentOutputObject;
  verification: VerificationOutput;
  phase: VerificationFailurePhase;
  code: string;
};
type FailureReceiptMatcher = (state: FailureMatchState) => boolean;

function failureQuery(state: FailureMatchState): {
  query: QueryReceipt | null;
  snapshotId: string | null;
  baseline: VerificationBaseline | null;
} | null {
  if (state.phase === "pre_query") {
    return {
      query: state.verification.preQuery,
      snapshotId: state.verification.preSnapshotId,
      baseline: null,
    };
  }
  if (state.phase === "post_query") {
    return {
      query: state.verification.postQuery,
      snapshotId: state.verification.postSnapshotId,
      baseline: state.result.baseline,
    };
  }
  return null;
}

function runtimeCheckableFailureQuery(state: FailureMatchState): {
  query: QueryReceipt;
  baseline: VerificationBaseline | null;
} | null {
  const receipt = failureQuery(state);
  if (!receipt || !queryReceiptMatchesSnapshot(receipt.query, receipt.snapshotId)) return null;
  const hasCheckableStatus = receipt.query.status === "ready"
    ? receipt.query.error === null
    : state.phase === "pre_query"
      && receipt.query.status === "label_absent"
      && receipt.query.error?.code === "label_absent";
  if (!hasCheckableStatus) return null;
  return { query: receipt.query, baseline: receipt.baseline };
}

function observationOutcomeReceiptMatcher(
  outcome: Exclude<WorldSpaceObservationAttempt["outcome"], "observed">,
): FailureReceiptMatcher {
  return (state) => {
    if (state.phase !== "pre_world_space" && state.phase !== "post_world_space") return false;
    const attempt = observationAttemptForPhase(state.verification, state.phase);
    return attempt?.phase === state.phase && attempt.outcome === outcome;
  };
}

function bridgeTerminalReceiptMatcher(status: QueryReceipt["status"]): FailureReceiptMatcher {
  return (state) => {
    const receipt = failureQuery(state);
    if (
      receipt === null
      || !queryReceiptMatchesSnapshot(receipt.query, receipt.snapshotId)
      || receipt.query.status !== status
      || receipt.query.error?.code !== status
    ) return false;
    if (status !== "label_absent" || state.phase !== "pre_query") return true;
    return identityDrift(receipt.query, state.verification.runtime, null) === null
      && sceneDriftFailure(receipt.query) === null
      && receipt.query.snapshotId !== null
      && !completePreSnapshot(receipt.query, state.verification.runtime, null);
  };
}

function identityFailureReceiptMatcher(identity: string): FailureReceiptMatcher {
  return (state) => {
    const receipt = runtimeCheckableFailureQuery(state);
    return receipt !== null
      && identityDrift(receipt.query, state.verification.runtime, receipt.baseline) === identity;
  };
}

function sceneDriftFailureReceiptMatcher(code: string): FailureReceiptMatcher {
  return (state) => {
    const receipt = runtimeCheckableFailureQuery(state);
    return receipt !== null
      && identityDrift(receipt.query, state.verification.runtime, receipt.baseline) === null
      && sceneDriftFailure(receipt.query)?.code === code;
  };
}

function classificationNoMatchReceiptMatches(classification: z.infer<typeof classificationOutputSchema>): boolean {
  return classification.status === "no_match"
    && classification.environment === null
    && classification.histogramMatches.length === 0
    && classificationPredicatesAreReady(classification)
    && classification.predicates.missingRequestedLabels.length === 0
    && classification.predicates.surfaceExtentMultisetsMatch === null
    && classification.predicates.requirementsFit === null;
}

function classificationAmbiguousReceiptMatches(classification: z.infer<typeof classificationOutputSchema>): boolean {
  return classification.status === "ambiguous"
    && classification.environment === null
    && classification.histogramMatches.length > 1
    && new Set(classification.histogramMatches).size === classification.histogramMatches.length
    && classificationPredicatesAreReady(classification)
    && classification.predicates.missingRequestedLabels.length === 0
    && classification.predicates.surfaceExtentMultisetsMatch === null
    && classification.predicates.requirementsFit === null;
}

function classificationIncompleteReceiptMatches(classification: z.infer<typeof classificationOutputSchema>): boolean {
  return classification.status === "incomplete_requested_labels"
    && classification.environment === null
    && classification.histogramMatches.length === 1
    && classificationPredicatesAreReady(classification)
    && classification.predicates.missingRequestedLabels.length > 0
    && classification.predicates.surfaceExtentMultisetsMatch === null
    && classification.predicates.requirementsFit === null;
}

function classificationExtentMismatchReceiptMatches(classification: z.infer<typeof classificationOutputSchema>): boolean {
  return classification.status === "extent_mismatch"
    && classification.environment === null
    && classification.histogramMatches.length === 1
    && classificationPredicatesAreReady(classification)
    && classification.predicates.missingRequestedLabels.length === 0
    && (
      (classification.predicates.surfaceExtentMultisetsMatch === false
        && classification.predicates.requirementsFit === null)
      || (classification.predicates.surfaceExtentMultisetsMatch === true
        && classification.predicates.requirementsFit === false)
    );
}

const FAILURE_RECEIPT_MATCHERS: Readonly<Record<string, FailureReceiptMatcher>> = {
  world_space_observation_failed: observationOutcomeReceiptMatcher("failed"),
  world_space_observation_invalid: observationOutcomeReceiptMatcher("invalid"),
  world_space_observation_missing: observationOutcomeReceiptMatcher("missing"),
  coarse_scene_mismatch: (state) => {
    if (state.phase === "pre_query") {
      const receipt = runtimeCheckableFailureQuery(state);
      return receipt !== null
        && completePreSnapshot(receipt.query, state.verification.runtime, null)
        && !worldSpaceMatchesTarget(
          observedWorldSpaceForPhase(state.verification, "pre_world_space"),
          state.verification.target,
        );
    }
    const observed = observedWorldSpaceForPhase(state.verification, "post_world_space");
    return state.phase === "post_world_space"
      && observed !== null
      && observedPostWorldSpaceReceiptMatches(state.result)
      && !worldSpaceMatchesTarget(observed, state.verification.target);
  },
  bridge_result_invalid: (state) => {
    const receipt = failureQuery(state);
    if (receipt === null) return false;
    if (receipt.query === null) return receipt.snapshotId === null;
    const hasChangedPostSnapshot = state.phase !== "post_query"
      || (receipt.baseline !== null && receipt.query.snapshotId !== receipt.baseline.snapshotId);
    return (state.phase === "pre_query" || state.phase === "post_query")
      && queryReceiptMatchesSnapshot(receipt.query, receipt.snapshotId)
      && receipt.query.status === "ready"
      && receipt.query.error === null
      && receipt.query.snapshotId !== null
      && hasChangedPostSnapshot
      && identityDrift(receipt.query, state.verification.runtime, receipt.baseline) === null
      && sceneDriftFailure(receipt.query) === null
      && !completeReadySnapshot(receipt.query, state.verification.runtime, receipt.baseline);
  },
  bridge_label_absent: bridgeTerminalReceiptMatcher("label_absent"),
  bridge_not_ready: bridgeTerminalReceiptMatcher("not_ready"),
  bridge_stage_not_open: bridgeTerminalReceiptMatcher("stage_not_open"),
  bridge_bridge_unavailable: bridgeTerminalReceiptMatcher("bridge_unavailable"),
  bridge_stage_mismatch: bridgeTerminalReceiptMatcher("stage_mismatch"),
  bridge_invalid_payload: bridgeTerminalReceiptMatcher("invalid_payload"),
  bridge_binding_failed: bridgeTerminalReceiptMatcher("binding_failed"),
  identity_drift_binding: identityFailureReceiptMatcher("binding"),
  identity_drift_serial: identityFailureReceiptMatcher("serial"),
  identity_drift_package: identityFailureReceiptMatcher("package"),
  identity_drift_receipt: identityFailureReceiptMatcher("receipt"),
  identity_drift_boot: identityFailureReceiptMatcher("boot"),
  identity_drift_stage: identityFailureReceiptMatcher("stage"),
  identity_drift_root: identityFailureReceiptMatcher("root"),
  scene_drift_policy_mismatch: sceneDriftFailureReceiptMatcher("scene_drift_policy_mismatch"),
  scene_drift_out_of_policy: sceneDriftFailureReceiptMatcher("scene_drift_out_of_policy"),
  snapshot_missing: (state) => {
    const receipt = runtimeCheckableFailureQuery(state);
    return receipt !== null
      && identityDrift(receipt.query, state.verification.runtime, receipt.baseline) === null
      && sceneDriftFailure(receipt.query) === null
      && receipt.query.snapshotId === null;
  },
  snapshot_unchanged: (state) => {
    const receipt = runtimeCheckableFailureQuery(state);
    return state.phase === "post_query"
      && receipt !== null
      && receipt.baseline !== null
      && identityDrift(receipt.query, state.verification.runtime, receipt.baseline) === null
      && sceneDriftFailure(receipt.query) === null
      && receipt.query.snapshotId === receipt.baseline.snapshotId;
  },
  world_space_marker_failed: (state) => state.verification.marker === null,
  world_space_marker_mismatch: (state) => {
    const baseline = state.result.baseline;
    const marker = state.verification.marker;
    const preObservation = observedWorldSpaceForPhase(state.verification, "pre_world_space");
    return baseline !== null
      && marker !== null
      && (
        !markerReceiptMatches(marker, state.verification.runtime, baseline)
        || preObservation === null
        || preObservation.observedAtEpochSeconds >= marker.observedAtEpochSeconds
      );
  },
  host_selection_invalid: (state) => state.result.hostSelection === null,
  host_selection_wrong_target: (state) => state.result.hostSelection !== null
    && state.result.hostSelection.targetTile !== state.verification.target.tile,
  host_selection_not_observed: (state) => {
    const hostSelection = state.result.hostSelection;
    if (!hostSelection || hostSelection.targetTile !== state.verification.target.tile) return false;
    if (hostSelection.status === "host_selection_not_observed") return true;
    return hostSelection.status === "host_selection_observed"
      && (hostSelection.afterDialogSha256 !== state.verification.target.selectedDialogSha256
        || !hostSelection.close.closed);
  },
  classification_no_match: (state) => state.verification.classification !== null
    && classificationNoMatchReceiptMatches(state.verification.classification),
  classification_ambiguous: (state) => state.verification.classification !== null
    && classificationAmbiguousReceiptMatches(state.verification.classification),
  classification_incomplete_requested_labels: (state) => state.verification.classification !== null
    && classificationIncompleteReceiptMatches(state.verification.classification),
  classification_extent_mismatch: (state) => state.verification.classification !== null
    && classificationExtentMismatchReceiptMatches(state.verification.classification),
  wrong_unique_environment: (state) => uniqueClassificationReceiptMatches(
    state.verification.classification,
    state.verification.target,
    false,
  ),
};

const FAILURE_CODE_PHASES: Readonly<Record<string, readonly VerificationFailurePhase[]>> = {
  world_space_observation_failed: ["pre_world_space", "post_world_space"],
  world_space_observation_invalid: ["pre_world_space", "post_world_space"],
  world_space_observation_missing: ["pre_world_space", "post_world_space"],
  coarse_scene_mismatch: ["pre_query", "post_world_space"],
  bridge_result_invalid: ["pre_query", "post_query"],
  bridge_label_absent: ["pre_query", "post_query"],
  bridge_not_ready: ["pre_query", "post_query"],
  bridge_stage_not_open: ["pre_query", "post_query"],
  bridge_bridge_unavailable: ["pre_query", "post_query"],
  bridge_stage_mismatch: ["pre_query", "post_query"],
  bridge_invalid_payload: ["pre_query", "post_query"],
  bridge_binding_failed: ["pre_query", "post_query"],
  identity_drift_binding: ["pre_query", "post_query"],
  identity_drift_serial: ["pre_query", "post_query"],
  identity_drift_package: ["pre_query", "post_query"],
  identity_drift_receipt: ["pre_query", "post_query"],
  identity_drift_boot: ["post_query"],
  identity_drift_stage: ["pre_query", "post_query"],
  identity_drift_root: ["pre_query", "post_query"],
  scene_drift_policy_mismatch: ["pre_query", "post_query"],
  scene_drift_out_of_policy: ["pre_query", "post_query"],
  snapshot_missing: ["pre_query", "post_query"],
  snapshot_unchanged: ["post_query"],
  world_space_marker_failed: ["marker"],
  world_space_marker_mismatch: ["marker"],
  host_selection_invalid: ["host_selection"],
  host_selection_wrong_target: ["host_selection"],
  host_selection_not_observed: ["host_selection"],
  classification_no_match: ["classification"],
  classification_ambiguous: ["classification"],
  classification_incomplete_requested_labels: ["classification"],
  classification_extent_mismatch: ["classification"],
  wrong_unique_environment: ["classification"],
};

const FAILURE_PHASE_FRONTIERS: Readonly<Record<VerificationFailurePhase, FailureReceiptMatcher>> = {
  pre_world_space: ({ result, verification }) => result.action === "switch"
    && verificationIdentityMatches(result)
    && result.baseline === null
    && result.hostSelection === null
    && verification.marker === null
    && verification.preWorldSpaceAttempt !== null
    && verification.preWorldSpaceAttempt.phase === "pre_world_space"
    && verification.preQuery === null
    && verification.preSnapshotId === null
    && noPostEvidence(verification),
  pre_query: ({ result, verification }) => result.action === "switch"
    && verificationIdentityMatches(result)
    && result.baseline === null
    && result.hostSelection === null
    && verification.marker === null
    && observedWorldSpaceForPhase(verification, "pre_world_space") !== null
    && noPostEvidence(verification),
  marker: ({ result, verification }) => switchPreQueryReceiptsMatch(result)
    && result.hostSelection === null
    && noPostEvidence(verification),
  host_selection: ({ result, verification }) => switchMarkerReceiptsMatch(result)
    && noPostEvidence(verification),
  post_world_space: ({ result, verification }) => postPrerequisitesMatch(result)
    && verification.postWorldSpaceAttempt !== null
    && verification.postWorldSpaceAttempt.phase === "post_world_space"
    && verification.postQuery === null
    && verification.postSnapshotId === null
    && verification.classification === null,
  post_query: ({ result, verification }) => postPrerequisitesMatch(result)
    && postWorldSpaceReceiptMatches(result)
    && verification.classification === null,
  classification: ({ result }) => postPrerequisitesMatch(result)
    && postWorldSpaceReceiptMatches(result)
    && changedPostQueryReceiptsMatch(result),
};

/** Pure exact phase/error-to-receipt relation used by both direct parsing and the MCP handler. */
export function verificationFailureReceiptsMatch(result: SelectHomeEnvironmentOutputObject): boolean {
  if (
    result.status !== "verification_failed"
    || result.verification === null
    || result.failurePhase === null
    || result.error === null
    || !verificationIdentityMatches(result)
  ) return false;
  const state: FailureMatchState = {
    result,
    verification: result.verification,
    phase: result.failurePhase,
    code: result.error.code,
  };
  const allowedPhases = FAILURE_CODE_PHASES[state.code];
  const frontier = FAILURE_PHASE_FRONTIERS[state.phase];
  const receiptMatcher = FAILURE_RECEIPT_MATCHERS[state.code];
  return !!allowedPhases?.includes(state.phase)
    && frontier(state)
    && !!receiptMatcher
    && receiptMatcher(state);
}

export const selectHomeEnvironmentOutputSchema = selectHomeEnvironmentOutputObjectSchema.superRefine((result, ctx) => {
  const require = (condition: boolean, path: (string | number)[], message: string) => {
    if (!condition) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  const requireRankedSelection = () => {
    require(result.requirements !== null, ["requirements"], `${result.status} requires normalized requirements`);
    require(result.ranking?.status === "ranked", ["ranking"], `${result.status} requires a ranked selection`);
    require(result.selectedTarget !== null, ["selectedTarget"], `${result.status} requires a selected target`);
    if (result.ranking) {
      require(result.ranking.selectedTarget === result.selectedTarget, ["selectedTarget"], "selected target must match the ranking receipt");
    }
  };
  const hasRankedSelection = result.requirements !== null
    && result.ranking?.status === "ranked"
    && result.selectedTarget !== null
    && result.ranking.selectedTarget === result.selectedTarget;
  const hasCompleteManualReceipts = hasRankedSelection && completeManualReceiptsMatch(result);
  const hasCompleteSelectedReceipts = hasRankedSelection && completeSelectedReceiptsMatch(result);
  const carriesUnvalidatedBaselineMismatch = result.status === "invalid_request"
    && result.error?.code === "baseline_mismatch";

  if (result.baseline !== null && !carriesUnvalidatedBaselineMismatch) {
    require(result.baseline.datasetId === result.dataset.datasetId, ["baseline", "datasetId"], "validated baseline dataset ID must match the dataset receipt");
    require(
      result.baseline.datasetContentSha256 === result.dataset.datasetContentSha256,
      ["baseline", "datasetContentSha256"],
      "validated baseline dataset content hash must match the dataset receipt",
    );
  }

  if (result.status !== "verification_failed") {
    require(result.failurePhase === null, ["failurePhase"], `${result.status} cannot carry a failure phase`);
  }

  if (result.status === "invalid_request") {
    require(result.error !== null, ["error"], "invalid_request requires an error receipt");
    require(result.requirements === null, ["requirements"], "invalid_request cannot carry normalized requirements");
    require(result.ranking === null, ["ranking"], "invalid_request cannot carry a ranking receipt");
    require(result.selectedTarget === null, ["selectedTarget"], "invalid_request cannot carry a selected target");
    require(result.hostSelection === null, ["hostSelection"], "invalid_request cannot carry a host receipt");
    require(result.verification === null, ["verification"], "invalid_request cannot carry verification receipts");
    if (result.action !== "verify") {
      require(result.baseline === null, ["baseline"], "only an invalid verify request can carry a parsed baseline");
    }
    return;
  }

  if (result.status === "ranked") {
    require(result.action === "rank", ["action"], "ranked requires rank action");
    requireRankedSelection();
    require(result.baseline === null, ["baseline"], "ranked cannot carry a baseline");
    require(result.hostSelection === null, ["hostSelection"], "ranked cannot carry a host receipt");
    require(result.verification === null, ["verification"], "ranked cannot carry verification receipts");
    require(result.error === null, ["error"], "ranked cannot carry an error receipt");
    return;
  }

  if (result.status === "no_fit") {
    require(result.action !== null, ["action"], "no_fit requires a parsed action");
    require(result.requirements !== null, ["requirements"], "no_fit requires normalized requirements");
    require(result.ranking?.status === "no_fit", ["ranking"], "no_fit requires a no-fit ranking receipt");
    require(result.selectedTarget === null, ["selectedTarget"], "no_fit cannot carry a selected target");
    require(result.hostSelection === null, ["hostSelection"], "no_fit cannot carry a host receipt");
    require(result.verification === null, ["verification"], "no_fit cannot carry verification receipts");
    require(result.error === null, ["error"], "no_fit cannot carry an error receipt");
    if (result.action === "verify") {
      require(result.baseline !== null, ["baseline"], "verify no_fit requires its validated baseline");
    } else {
      require(result.baseline === null, ["baseline"], "rank/switch no_fit cannot carry a baseline");
    }
    return;
  }

  if (result.status === "manual_switch_required") {
    require(result.action === "switch", ["action"], "manual_switch_required requires switch action");
    requireRankedSelection();
    require(result.baseline !== null, ["baseline"], "manual_switch_required requires a pre-switch baseline");
    require(result.hostSelection?.status === "manual_switch_required", ["hostSelection"], "manual_switch_required requires a manual host receipt");
    require(result.verification !== null, ["verification"], "manual_switch_required requires pre-switch verification receipts");
    require(result.error === null, ["error"], "manual_switch_required cannot carry an error receipt");
    require(hasCompleteManualReceipts, ["status"], "manual_switch_required requires one complete, target-bound manual constructor state");
    if (result.baseline && result.verification) {
      require(
        observedWorldSpaceForPhase(result.verification, "pre_world_space") !== null,
        ["verification", "preWorldSpaceAttempt"],
        "manual switching requires an observed pre-switch WorldSpace attempt receipt",
      );
      require(
        completePreSnapshot(result.verification.preQuery, result.verification.runtime, result.baseline),
        ["verification", "preQuery"],
        "manual switching requires a complete ready or exact label-absent pre-switch snapshot",
      );
      require(result.verification.preSnapshotId === result.baseline.snapshotId, ["verification", "preSnapshotId"], "manual baseline must match the pre-switch snapshot");
      require(result.verification.marker !== null, ["verification", "marker"], "manual switching requires the marker receipt");
      require(result.verification.postWorldSpaceAttempt === null && result.verification.postQuery === null
        && result.verification.postSnapshotId === null && result.verification.classification === null,
      ["verification"], "manual switching cannot carry post-switch verification receipts");
    }
    return;
  }

  if (result.status === "selected_verified") {
    require(result.action === "switch" || result.action === "verify", ["action"], "selected_verified requires switch or verify action");
    requireRankedSelection();
    require(result.baseline !== null, ["baseline"], "selected_verified requires a receipt-bound baseline");
    require(result.verification !== null, ["verification"], "selected_verified requires complete verification receipts");
    require(result.error === null, ["error"], "selected_verified cannot carry an error receipt");
    require(hasCompleteSelectedReceipts, ["status"], "selected_verified requires one complete, target-bound verified constructor state");
    if (result.action === "switch") {
      require(result.hostSelection?.status === "host_selection_observed", ["hostSelection"], "selected switch requires an observed host action receipt");
    } else if (result.action === "verify") {
      require(result.hostSelection === null, ["hostSelection"], "verify cannot carry a host action receipt");
    }
    if (result.baseline && result.verification) {
      const verification = result.verification;
      require(verification.preSnapshotId === result.baseline.snapshotId, ["verification", "preSnapshotId"], "selected baseline must match the pre-switch snapshot");
      require(
        observedWorldSpaceForPhase(verification, "post_world_space") !== null,
        ["verification", "postWorldSpaceAttempt"],
        "selected verification requires an observed post-switch WorldSpace attempt receipt",
      );
      require(verification.postQuery?.status === "ready", ["verification", "postQuery"], "selected verification requires a ready post-switch query");
      require(verification.postSnapshotId !== null && verification.postSnapshotId === verification.postQuery?.snapshotId,
        ["verification", "postSnapshotId"], "selected verification requires the post-query snapshot receipt");
      require(verification.postSnapshotId !== result.baseline.snapshotId, ["verification", "postSnapshotId"], "selected verification requires a changed snapshot");
      require(verification.classification?.status === "unique", ["verification", "classification"], "selected verification requires a unique classification receipt");
      require(verification.classification?.environment?.tile === result.selectedTarget,
        ["verification", "classification", "environment"], "selected classification must match the selected target");
      if (result.action === "switch") {
        require(observedWorldSpaceForPhase(verification, "pre_world_space") !== null
          && completePreSnapshot(verification.preQuery, verification.runtime, result.baseline)
          && verification.marker !== null,
          ["verification"], "selected switch requires complete pre-switch and marker receipts");
      } else {
        require(verification.preWorldSpaceAttempt === null
          && verification.preQuery === null
          && markerReceiptMatches(verification.marker, verification.runtime, result.baseline),
          ["verification"], "verify requires the exact caller marker and cannot invent pre-switch receipts");
      }
    }
    return;
  }

  require(result.action === "switch" || result.action === "verify", ["action"], "verification_failed requires switch or verify action");
  requireRankedSelection();
  require(result.verification !== null, ["verification"], "verification_failed requires a verification receipt container");
  require(result.failurePhase !== null, ["failurePhase"], "verification_failed requires an exact causal phase");
  require(result.error !== null, ["error"], "verification_failed requires an error receipt");
  if (result.action === "verify") {
    require(result.baseline !== null, ["baseline"], "failed verify requires its receipt-bound baseline");
    require(result.hostSelection === null, ["hostSelection"], "verify cannot carry a host action receipt");
  }
  require(
    verificationFailureReceiptsMatch(result),
    ["error", "code"],
    "verification failure code must match its exact phase, prerequisites, and observable failure receipt",
  );
});
export type SelectHomeEnvironmentOutput = z.infer<typeof selectHomeEnvironmentOutputSchema>;

export interface HomeEnvironmentSelectorDependencies {
  dataset: HomeEnvironmentDataset;
  observeCurrentDefaultSpace(serial: string, afterMarker?: WorldSpaceMarkerReceipt): Promise<CurrentDefaultSpace | null>;
  querySceneAnchors(input: QuerySceneAnchorsInput): Promise<unknown>;
  markWorldSpace(serial: string, nonce: string): Promise<WorldSpaceMarkerReceipt>;
  selectHost(target: HomeEnvironment & { serial: string }, picker: HomeEnvironmentDataset["picker"]): Promise<HostSelectionResult>;
}

/** Parse exactly one epoch-formatted WorldSpaceDB current Default Space observation. */
export function parseCurrentDefaultSpace(line: string): CurrentDefaultSpace | null {
  const row = parseCurrentDefaultSpaceRow(line);
  return row === null ? null : currentDefaultSpaceSchema.parse(row);
}

function datasetReceipt(dataset: HomeEnvironmentDataset): z.infer<typeof datasetReceiptSchema> {
  return {
    schemaVersion: dataset.schemaVersion,
    datasetId: dataset.datasetId,
    datasetContentSha256: canonicalIdentity(dataset).sha256,
    measuredAt: dataset.measurement.measuredAt,
    sourceCommit: dataset.measurement.sourceCommit,
    sourcePath: dataset.measurement.sourcePath,
    capabilitySummarySha256: dataset.measurement.capabilitySummarySha256,
    selectionProvenanceSha256: dataset.measurement.selectionProvenanceSha256,
  };
}

function emptyVerification(runtime: SelectorRuntimeInput, target: HomeEnvironment): VerificationOutput {
  return {
    runtime: { ...runtime },
    target: {
      tile: target.tile,
      sceneId: target.sceneId,
      selectedDialogSha256: target.selectedDialogSha256,
    },
    marker: null,
    preWorldSpaceAttempt: null,
    postWorldSpaceAttempt: null,
    preQuery: null,
    postQuery: null,
    preSnapshotId: null,
    postSnapshotId: null,
    classification: null,
    sceneIdentityRole: "coarse_consistency_only_non_discriminating",
  };
}

type ResultContext = {
  action: "rank" | "switch" | "verify" | null;
  dataset: HomeEnvironmentDataset;
  requirements: FitRequest | null;
  ranking: z.infer<typeof homeEnvironmentRankResultSchema> | null;
  selectedTarget: string | null;
  baseline: VerificationBaseline | null;
  hostSelection: HostSelectionResult | null;
  verification: VerificationOutput | null;
};

function output(
  status: SelectHomeEnvironmentOutput["status"],
  context: ResultContext,
  error: SelectHomeEnvironmentOutput["error"] = null,
  failurePhase: VerificationFailurePhase | null = null,
): SelectHomeEnvironmentOutput {
  return selectHomeEnvironmentOutputSchema.parse({
    status,
    action: context.action,
    dataset: datasetReceipt(context.dataset),
    requirements: context.requirements,
    ranking: context.ranking,
    selectedTarget: context.selectedTarget,
    baseline: context.baseline,
    hostSelection: context.hostSelection,
    verification: context.verification,
    failurePhase,
    error,
    evidenceCeiling: "structural",
  });
}

function failure(
  context: ResultContext,
  failurePhase: VerificationFailurePhase,
  code: string,
  detail: string,
): SelectHomeEnvironmentOutput {
  return output("verification_failed", context, { code, detail }, failurePhase);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SELECTOR_SCENE_DRIFT_POLICY: SceneDriftPolicy = {
  count: "advisory",
  maxTransformDeltaM: 0.01,
  maxTransformDeltaDeg: 1,
  maxExtentDeltaM: 0.01,
  topology: "strict",
};
const SELECTOR_REQUESTED_LABELS: readonly string[] = ["FLOOR", "TABLE", "WALL_ART"];

function sceneQueryInput(runtime: SelectorRuntimeInput): QuerySceneAnchorsInput {
  return {
    serial: runtime.serial,
    scenario: {
      packageName: runtime.packageName,
      expectedBuildReceiptId: runtime.expectedBuildReceiptId,
      expectedStageStyle: runtime.expectedStageStyle,
      expectedRootContainer: "stage",
      sceneDriftPolicy: { ...SELECTOR_SCENE_DRIFT_POLICY },
    },
    labels: ["TABLE", "FLOOR", "WALL_ART"],
    maxRetries: 15,
    pollMs: 1000,
    includeGeometry: "lossless_external_artifact",
    stabilityReads: 2,
  };
}

function identityDrift(
  query: z.infer<typeof querySceneAnchorsOutputSchema>,
  runtime: SelectorRuntimeInput,
  baseline: VerificationBaseline | null,
): string | null {
  const binding = query.applicationRuntimeBinding;
  if (!binding) return "binding";
  if (binding.serial !== runtime.serial || binding.liveIdentity.serial !== runtime.serial) return "serial";
  if (
    binding.packageName !== runtime.packageName
    || binding.foregroundProcess.packageName !== runtime.packageName
    || !binding.foregroundProcess.component.startsWith(`${runtime.packageName}/`)
  ) return "package";
  if (binding.buildReceiptId !== runtime.expectedBuildReceiptId) return "receipt";
  if (baseline && binding.liveIdentity.bootId !== baseline.bootId) return "boot";
  if (
    binding.requestedStageStyle !== runtime.expectedStageStyle
    || !("observedStageStyle" in binding)
    || binding.observedStageStyle !== runtime.expectedStageStyle
    || !("stageOpen" in binding)
    || !binding.stageOpen
  ) return "stage";
  if (
    binding.requestedRootContainer !== "stage"
    || !("rootContainer" in binding)
    || binding.rootContainer !== "stage"
  ) return "root";
  return null;
}

function matchesSelectorDriftPolicy(policy: SceneDriftPolicy): boolean {
  return policy.count === SELECTOR_SCENE_DRIFT_POLICY.count
    && policy.maxTransformDeltaM === SELECTOR_SCENE_DRIFT_POLICY.maxTransformDeltaM
    && policy.maxTransformDeltaDeg === SELECTOR_SCENE_DRIFT_POLICY.maxTransformDeltaDeg
    && policy.maxExtentDeltaM === SELECTOR_SCENE_DRIFT_POLICY.maxExtentDeltaM
    && policy.topology === SELECTOR_SCENE_DRIFT_POLICY.topology;
}

function sceneDriftFailure(query: z.infer<typeof querySceneAnchorsOutputSchema>): { code: string; detail: string } | null {
  const bindingPolicy = query.applicationRuntimeBinding?.effectiveSceneDriftPolicy;
  if (
    !bindingPolicy
    || !matchesSelectorDriftPolicy(bindingPolicy)
    || !matchesSelectorDriftPolicy(query.drift.effectivePolicy)
  ) {
    return {
      code: "scene_drift_policy_mismatch",
      detail: "scene query did not echo the selector's complete configured drift policy",
    };
  }
  if (!query.drift.withinPolicy) {
    return {
      code: "scene_drift_out_of_policy",
      detail: "scene query exceeded the selector's numeric or strict-topology drift policy",
    };
  }
  return null;
}

function baselineMatches(dataset: HomeEnvironmentDataset, runtime: SelectorRuntimeInput, baseline: VerificationBaseline): boolean {
  return baseline.datasetId === dataset.datasetId
    && baseline.datasetContentSha256 === canonicalIdentity(dataset).sha256
    && baseline.serial === runtime.serial
    && baseline.packageName === runtime.packageName
    && baseline.expectedBuildReceiptId === runtime.expectedBuildReceiptId;
}

async function validatedQuery(
  deps: HomeEnvironmentSelectorDependencies,
  runtime: SelectorRuntimeInput,
): Promise<z.infer<typeof querySceneAnchorsOutputSchema>> {
  const query = querySceneAnchorsOutputSchema.parse(await deps.querySceneAnchors(sceneQueryInput(runtime)));
  const errorMatchesStatus = query.status === "ready"
    ? query.error === null
    : query.error?.code === query.status;
  if (!errorMatchesStatus) {
    throw new Error(`bridge status '${query.status}' does not carry its exact terminal error`);
  }
  return query;
}

const WORLD_SPACE_OBSERVATION_FAILED_DIAGNOSTIC = "WorldSpace observation dependency failed";
const WORLD_SPACE_OBSERVATION_INVALID_DIAGNOSTIC = "WorldSpace observation did not match the strict current Default Space schema";

async function observeCurrentDefaultSpaceAttempt(
  deps: HomeEnvironmentSelectorDependencies,
  serial: string,
  phase: WorldSpaceObservationPhase,
  afterMarker?: WorldSpaceMarkerReceipt,
): Promise<WorldSpaceObservationAttempt> {
  let observedInput: unknown;
  try {
    observedInput = await deps.observeCurrentDefaultSpace(serial, afterMarker);
  } catch {
    return worldSpaceObservationAttemptSchema.parse({
      phase,
      outcome: "failed",
      diagnostic: WORLD_SPACE_OBSERVATION_FAILED_DIAGNOSTIC,
    });
  }
  const observedResult = currentDefaultSpaceSchema.nullable().safeParse(observedInput);
  if (!observedResult.success) {
    return worldSpaceObservationAttemptSchema.parse({
      phase,
      outcome: "invalid",
      diagnostic: WORLD_SPACE_OBSERVATION_INVALID_DIAGNOSTIC,
    });
  }
  if (observedResult.data === null) {
    return worldSpaceObservationAttemptSchema.parse({ phase, outcome: "missing" });
  }
  if (afterMarker && observedResult.data.observedAtEpochSeconds <= afterMarker.observedAtEpochSeconds) {
    return worldSpaceObservationAttemptSchema.parse({ phase, outcome: "missing" });
  }
  return worldSpaceObservationAttemptSchema.parse({
    phase,
    outcome: "observed",
    observation: observedResult.data,
  });
}

function observationFailureCode(
  attempt: Exclude<WorldSpaceObservationAttempt, { outcome: "observed" }>,
): string {
  return `world_space_observation_${attempt.outcome}`;
}

function observationFailureDetail(
  attempt: Exclude<WorldSpaceObservationAttempt, { outcome: "observed" }>,
): string {
  if (attempt.outcome === "failed" || attempt.outcome === "invalid") return attempt.diagnostic;
  return attempt.phase === "pre_world_space"
    ? "no current Default Space WorldSpaceDB observation was found"
    : "no later current Default Space WorldSpaceDB observation was found";
}

async function verifyPostSwitch(
  context: ResultContext,
  runtime: SelectorRuntimeInput,
  baseline: VerificationBaseline,
  marker: WorldSpaceMarkerReceipt,
  target: HomeEnvironment,
  fitRequest: FitRequest,
  deps: HomeEnvironmentSelectorDependencies,
): Promise<SelectHomeEnvironmentOutput> {
  const verification = context.verification!;
  const postAttempt = await observeCurrentDefaultSpaceAttempt(
    deps,
    runtime.serial,
    "post_world_space",
    marker,
  );
  verification.postWorldSpaceAttempt = postAttempt;
  if (postAttempt.outcome !== "observed") {
    return failure(
      context,
      "post_world_space",
      observationFailureCode(postAttempt),
      observationFailureDetail(postAttempt),
    );
  }
  const observed = postAttempt.observation;
  const referenceScene = observedWorldSpaceForPhase(verification, "pre_world_space")?.sceneId
    ?? target.sceneId;
  if (observed.sceneId !== referenceScene || observed.sceneId !== target.sceneId) {
    return failure(context, "post_world_space", "coarse_scene_mismatch", `coarse scene '${observed.sceneId}' does not match '${referenceScene}'`);
  }

  let post: z.infer<typeof querySceneAnchorsOutputSchema>;
  try {
    post = await validatedQuery(deps, runtime);
  } catch (error) {
    return failure(context, "post_query", "bridge_result_invalid", errorDetail(error));
  }
  verification.postQuery = post;
  verification.postSnapshotId = post.snapshotId;
  if (post.status !== "ready") {
    return failure(context, "post_query", `bridge_${post.status}`, post.error?.detail ?? `bridge returned ${post.status}`);
  }
  const drift = identityDrift(post, runtime, baseline);
  if (drift) return failure(context, "post_query", `identity_drift_${drift}`, `post-switch ${drift} identity does not match the receipt-bound baseline`);
  const postSceneDriftFailure = sceneDriftFailure(post);
  if (postSceneDriftFailure) return failure(context, "post_query", postSceneDriftFailure.code, postSceneDriftFailure.detail);
  if (!post.snapshotId) return failure(context, "post_query", "snapshot_missing", "ready post-switch query did not carry a snapshot ID");
  if (post.snapshotId === baseline.snapshotId) return failure(context, "post_query", "snapshot_unchanged", "post-switch snapshot equals the receipt-bound baseline");
  if (!completeReadySnapshot(post, runtime, baseline)) {
    return failure(
      context,
      "post_query",
      "bridge_result_invalid",
      "post-switch query did not carry a complete stable lossless snapshot receipt",
    );
  }

  const classification = classifyObservedHomeEnvironment(context.dataset, post, fitRequest);
  verification.classification = classification;
  if (classification.status !== "unique") {
    return failure(context, "classification", `classification_${classification.status}`, `post-switch classification returned ${classification.status}`);
  }
  if (!classification.environment || classification.environment.tile !== target.tile) {
    return failure(context, "classification", "wrong_unique_environment", `unique environment '${classification.environment?.tile ?? "none"}' does not match target '${target.tile}'`);
  }
  return output("selected_verified", context);
}

/** Pure selector orchestration; all live and host boundaries are injected. */
export async function executeSelectHomeEnvironment(
  input: unknown,
  deps: HomeEnvironmentSelectorDependencies = defaultHomeEnvironmentSelectorDependencies(),
): Promise<SelectHomeEnvironmentOutput> {
  const dataset = homeEnvironmentDatasetSchema.parse(deps.dataset);
  const parsed = selectHomeEnvironmentInputSchema.safeParse(input);
  const candidateAction = typeof input === "object" && input !== null && "action" in input
    ? (input as { action?: unknown }).action
    : null;
  const rawAction = typeof candidateAction === "string"
    && ["rank", "switch", "verify"].includes(candidateAction)
    ? candidateAction as "rank" | "switch" | "verify"
    : null;
  const initial: ResultContext = {
    action: rawAction,
    dataset,
    requirements: null,
    ranking: null,
    selectedTarget: null,
    baseline: null,
    hostSelection: null,
    verification: null,
  };
  if (!parsed.success) {
    return output("invalid_request", initial, {
      code: "invalid_request",
      detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
    });
  }

  const request = parsed.data;
  initial.action = request.action;
  if (request.action === "verify") {
    initial.baseline = request.baseline;
    if (!baselineMatches(dataset, request.runtime, request.baseline)) {
      return output("invalid_request", initial, { code: "baseline_mismatch", detail: "baseline dataset/runtime identity does not match the verify request" });
    }
    if (!markerReceiptMatches(request.marker, request.runtime, request.baseline)) {
      return output("invalid_request", initial, { code: "marker_mismatch", detail: "marker receipt does not match the exact verify runtime and baseline" });
    }
  }
  let fitRequest: FitRequest;
  try {
    fitRequest = deriveFitRequest("requirements" in request
      ? { requirements: request.requirements }
      : { briefId: request.briefId });
  } catch (error) {
    return output("invalid_request", initial, { code: "invalid_request", detail: errorDetail(error) });
  }
  initial.requirements = fitRequest;
  const ranking = rankHomeEnvironments(dataset, fitRequest);
  initial.ranking = ranking;
  initial.selectedTarget = ranking.selectedTarget;
  if (ranking.status === "no_fit" || !ranking.selectedTarget) return output("no_fit", initial);
  if (request.action === "rank") return output("ranked", initial);

  const target = dataset.environments.find((environment) => environment.tile === ranking.selectedTarget);
  if (!target) return output("invalid_request", initial, { code: "invalid_dataset", detail: "ranked target is absent from the packaged dataset" });
  const runtime = request.runtime;
  const verification = emptyVerification(runtime, target);
  initial.verification = verification;

  if (request.action === "verify") {
    verification.preSnapshotId = request.baseline.snapshotId;
    verification.marker = request.marker;
    return verifyPostSwitch(initial, runtime, request.baseline, request.marker, target, fitRequest, deps);
  }

  const preAttempt = await observeCurrentDefaultSpaceAttempt(
    deps,
    runtime.serial,
    "pre_world_space",
  );
  verification.preWorldSpaceAttempt = preAttempt;
  if (preAttempt.outcome !== "observed") {
    return failure(
      initial,
      "pre_world_space",
      observationFailureCode(preAttempt),
      observationFailureDetail(preAttempt),
    );
  }
  const preObservation = preAttempt.observation;

  let pre: z.infer<typeof querySceneAnchorsOutputSchema>;
  try {
    pre = await validatedQuery(deps, runtime);
  } catch (error) {
    return failure(initial, "pre_query", "bridge_result_invalid", errorDetail(error));
  }
  verification.preQuery = pre;
  verification.preSnapshotId = pre.snapshotId;
  if (pre.status !== "ready" && pre.status !== "label_absent") {
    return failure(initial, "pre_query", `bridge_${pre.status}`, pre.error?.detail ?? `bridge returned ${pre.status}`);
  }
  const preDrift = identityDrift(pre, runtime, null);
  if (preDrift) return failure(initial, "pre_query", `identity_drift_${preDrift}`, `pre-switch ${preDrift} identity does not match the runtime request`);
  const preSceneDriftFailure = sceneDriftFailure(pre);
  if (preSceneDriftFailure) return failure(initial, "pre_query", preSceneDriftFailure.code, preSceneDriftFailure.detail);
  if (!pre.snapshotId || !pre.applicationRuntimeBinding) return failure(initial, "pre_query", "snapshot_missing", "pre-switch query did not carry a receipt-bound snapshot");
  if (!completePreSnapshot(pre, runtime, null)) {
    const code = pre.status === "label_absent" ? "bridge_label_absent" : "bridge_result_invalid";
    return failure(initial, "pre_query", code, "pre-switch query did not carry a complete stable lossless snapshot receipt");
  }
  if (preObservation.sceneId !== target.sceneId) {
    return failure(initial, "pre_query", "coarse_scene_mismatch", `coarse scene '${preObservation.sceneId}' does not match target context '${target.sceneId}'`);
  }
  const baseline: VerificationBaseline = {
    datasetId: dataset.datasetId,
    datasetContentSha256: canonicalIdentity(dataset).sha256,
    serial: runtime.serial,
    packageName: runtime.packageName,
    expectedBuildReceiptId: runtime.expectedBuildReceiptId,
    bootId: pre.applicationRuntimeBinding.liveIdentity.bootId,
    snapshotId: pre.snapshotId,
  };
  initial.baseline = baseline;

  let marker: WorldSpaceMarkerReceipt;
  try {
    marker = markerReceiptSchema.parse(await deps.markWorldSpace(runtime.serial, baseline.snapshotId));
    verification.marker = marker;
  } catch (error) {
    return failure(initial, "marker", "world_space_marker_failed", errorDetail(error));
  }
  if (
    !markerReceiptMatches(marker, runtime, baseline)
    || preObservation.observedAtEpochSeconds >= marker.observedAtEpochSeconds
  ) {
    return failure(initial, "marker", "world_space_marker_mismatch", "WorldSpace marker receipt does not match the exact serial and pre-switch snapshot");
  }

  let hostSelection: HostSelectionResult;
  try {
    hostSelection = hostSelectionOutputSchema.parse(await deps.selectHost({ ...target, serial: runtime.serial }, dataset.picker));
  } catch (error) {
    return failure(initial, "host_selection", "host_selection_invalid", errorDetail(error));
  }
  initial.hostSelection = hostSelection;
  if (hostSelection.targetTile !== target.tile) {
    return failure(initial, "host_selection", "host_selection_wrong_target", `host selection target '${hostSelection.targetTile}' does not match '${target.tile}'`);
  }
  if (hostSelection.status === "manual_switch_required") return output("manual_switch_required", initial);
  if (
    hostSelection.status !== "host_selection_observed"
    || hostSelection.afterDialogSha256 !== target.selectedDialogSha256
    || !hostSelection.close.closed
  ) {
    const detail = hostSelection.status === "host_selection_not_observed"
      ? hostSelection.detail
      : "host selection receipt does not match the exact guarded target";
    return failure(initial, "host_selection", "host_selection_not_observed", detail);
  }
  return verifyPostSwitch(initial, runtime, baseline, marker, target, fitRequest, deps);
}

const WORLDSPACE_POLL_ATTEMPTS = 60;
const WORLDSPACE_POLL_MS = 500;

async function logcatDump(adb: string, serial: string): Promise<string> {
  const result = await run(adb, ["-s", serial, "logcat", "-d", "-v", "epoch"], {
    timeoutMs: 15_000,
    maxOutputBytes: 32 * 1024 * 1024,
  });
  if (result.code !== 0 || result.timedOut) throw new Error(`exact-serial WorldSpace logcat failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function liveCurrentDefaultSpace(serial: string, afterMarker?: WorldSpaceMarkerReceipt): Promise<CurrentDefaultSpace | null> {
  const adb = resolveAdb();
  const marker = afterMarker === undefined ? undefined : markerReceiptSchema.parse(afterMarker);
  if (marker && marker.serial !== serial) throw new Error("WorldSpace marker serial does not match the exact observation serial");
  const attempts = marker ? WORLDSPACE_POLL_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const lines = (await logcatDump(adb, serial)).split(/\r?\n/);
    if (!marker) {
      const observations = lines.map(parseCurrentDefaultSpace).filter((value): value is CurrentDefaultSpace => value !== null);
      return observations.at(-1) ?? null;
    }
    for (const line of lines) {
      const observation = parseCurrentDefaultSpace(line);
      if (observation && observation.observedAtEpochSeconds > marker.observedAtEpochSeconds) {
        return observation;
      }
    }
    if (attempt + 1 < attempts) await sleep(WORLDSPACE_POLL_MS);
  }
  return null;
}

async function liveWorldSpaceMarker(serial: string, nonce: string): Promise<WorldSpaceMarkerReceipt> {
  const adb = resolveAdb();
  const message = `MARK ${nonce}`;
  const existingMatches = (await logcatDump(adb, serial))
    .split(/\r?\n/)
    .map(parseWorldSpaceMarkerLine)
    .filter((row): row is ParsedWorldSpaceMarkerLine => row !== null && row.nonce === nonce);
  const preEmissionEpoch = existingMatches.reduce(
    (latest, row) => Math.max(latest, row.observedAtEpochSeconds),
    0,
  );
  const result = await run(adb, ["-s", serial, "shell", "log", "-p", "i", "-t", WORLDSPACE_TAG, message], { timeoutMs: 10_000 });
  if (result.code !== 0 || result.timedOut) throw new Error(`exact-serial WorldSpace marker failed: ${result.stderr || result.stdout}`);
  for (let attempt = 0; attempt < WORLDSPACE_POLL_ATTEMPTS; attempt++) {
    const lines = (await logcatDump(adb, serial)).split(/\r?\n/);
    for (const line of lines) {
      const row = parseWorldSpaceMarkerLine(line);
      if (
        row
        && row.nonce === nonce
        && row.message === message
        && row.observedAtEpochSeconds > preEmissionEpoch
      ) {
        return markerReceiptSchema.parse({
          serial,
          nonce,
          tag: row.tag,
          message: row.message,
          status: "marked",
          observedAtEpochSeconds: row.observedAtEpochSeconds,
          rawLine: row.rawLine,
        });
      }
    }
    if (attempt + 1 < WORLDSPACE_POLL_ATTEMPTS) await sleep(WORLDSPACE_POLL_MS);
  }
  throw new Error("exact-serial WorldSpace marker row was not observed after emission");
}

export function defaultHomeEnvironmentSelectorDependencies(): HomeEnvironmentSelectorDependencies {
  return {
    dataset: loadPackagedHomeEnvironmentDataset(),
    observeCurrentDefaultSpace: liveCurrentDefaultSpace,
    querySceneAnchors: executeLiveQuerySceneAnchors,
    markWorldSpace: liveWorldSpaceMarker,
    selectHost: (target, picker) => executeGuardedHostSelection(target, picker),
  };
}

/** Defines the full-surface tool; Task 5 owns calling this registration function. */
export function registerHomeEnvironmentSelectorTools(
  server: McpServer,
  executeSelector: (input: unknown) => Promise<unknown> = executeSelectHomeEnvironment,
) {
  server.registerTool(
    "select_home_environment",
    {
      description:
        "Rank measured PICO Emulator 6.0 home environments, optionally perform one guarded host selection, and report success only after a changed receipt-bound mesh uniquely classifies as the target. Scene ID and host clicks are non-discriminating; evidence ceiling is structural.",
      inputSchema: selectHomeEnvironmentInputSchema,
      // SDK 1.30 advertises/validates only a root ZodObject or raw shape here;
      // the handler applies the relational superRefine before publishing content.
      outputSchema: selectHomeEnvironmentOutputObjectSchema.shape,
    },
    async (input) => {
      const request = selectHomeEnvironmentInputSchema.parse(input);
      const result = selectHomeEnvironmentOutputSchema.parse(await executeSelector(request));
      if (result.action !== request.action) {
        throw new Error("selector output action must exactly match the caller action");
      }
      if (request.action === "verify") {
        if (result.baseline === null || !baselinesExactlyMatch(result.baseline, request.baseline)) {
          throw new Error("verify output baseline must exactly match the exact caller baseline receipt");
        }
        const returnedRuntime = result.verification?.runtime ?? null;
        if (returnedRuntime !== null && !runtimesExactlyMatch(returnedRuntime, request.runtime)) {
          throw new Error("verify output runtime must exactly match the exact caller runtime receipt");
        }
        const returnedMarker = result.verification?.marker ?? null;
        if (returnedMarker !== null && !markerReceiptsExactlyMatch(returnedMarker, request.marker)) {
          throw new Error("verify output marker must exactly match the exact caller marker receipt");
        }
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        ...(["invalid_request", "verification_failed"].includes(result.status) ? { isError: true } : {}),
      };
    },
  );
}
