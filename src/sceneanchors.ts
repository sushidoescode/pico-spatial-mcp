import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AGENT_BRIDGE_SCENE_PAYLOAD_KIND,
  AGENT_BRIDGE_SCENE_REVISION,
  AGENT_BRIDGE_SCENE_SCHEMA_VERSION,
  AGENT_BRIDGE_SCENE_COORDINATE_FRAME_ID,
  fetchAgentBridgeSceneSnapshot,
} from "./agentbridge.js";
import { probeDeviceIdentity } from "./deviceidentity.js";
import { resolveAdb } from "./emulatorlook.js";
import { parseOnlineAdbSerials, sha256Bytes } from "./observation.js";
import { readNativeRunReceipt } from "./runreceiptstore.js";
import { run } from "./util.js";
import {
  canonicalApkComponent,
  importedApkProvenanceSchema,
  importedApkReceiptSchema,
  validateImportedApk,
  type ImportedApkProvenance,
  type ImportedApkReceipt,
} from "./importedapk.js";

export const SCENE_HASH_FLOAT_DECIMALS = 6;
export const GEOMETRY_ARTIFACT_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const finiteNumber = z.number().refine(Number.isFinite, "must be finite");
const nonnegativeFiniteNumber = z.number().nonnegative().refine(Number.isFinite, "must be finite");
const vec3Schema = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
const quatSchema = z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]);
const matrixSchema = z.array(finiteNumber).length(16);

const rawAnchorSchema = z.object({
  runtimeUuid: z.string().min(1),
  worldFromAnchor: matrixSchema,
  positionM: vec3Schema,
  rotationQuaternionXyzw: quatSchema,
  boundsM: vec3Schema,
  vertices: z.array(finiteNumber),
  indices: z.array(z.number().int().nonnegative()),
  semanticAssignments: z.array(z.string().min(1)),
}).strict();

const sceneReadSchema = z.object({
  readIndex: z.number().int().nonnegative(),
  queriedAtMonotonicNs: z.string().regex(/^\d+$/),
  trackingState: z.string().min(1),
  source: z.enum(["loadAllAnchors", "subscription", "unavailable"]).optional(),
  loadError: z.string().min(1).nullable().optional(),
  anchorCount: z.number().int().nonnegative(),
  anchors: z.array(rawAnchorSchema),
}).strict();

export const sceneBridgePayloadSchema = z.object({
  kind: z.literal(AGENT_BRIDGE_SCENE_PAYLOAD_KIND),
  schemaVersion: z.literal(AGENT_BRIDGE_SCENE_SCHEMA_VERSION),
  bridgeRevision: z.literal(AGENT_BRIDGE_SCENE_REVISION),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,96}$/),
  application: z.object({
    packageName: z.string().min(1),
    buildIdentity: z.object({
      kind: z.literal("apk-sha256"),
      sha256: sha256Schema,
    }).strict().nullable(),
    observedStageStyle: z.enum(["Mixed", "Full"]).nullable(),
    rootContainer: z.string().min(1).nullable(),
    stageOpen: z.boolean(),
  }).strict(),
  coordinateFrame: z.object({
    id: z.literal(AGENT_BRIDGE_SCENE_COORDINATE_FRAME_ID),
    units: z.literal("metres"),
    handedness: z.literal("sdk-reported"),
  }).strict(),
  readiness: z.object({
    maxRetries: z.number().int().nonnegative(),
    pollMs: z.number().int().nonnegative(),
    stabilityReads: z.number().int().min(2),
    retries: z.number().int().nonnegative(),
    satisfied: z.boolean(),
  }).strict(),
  reads: z.array(sceneReadSchema),
  error: z.object({ code: z.string().min(1), detail: z.string().min(1) }).strict().nullable().optional(),
}).strict();

export type RawSceneAnchor = z.infer<typeof rawAnchorSchema>;
export type SceneBridgePayload = z.infer<typeof sceneBridgePayloadSchema>;
export type SceneRead = z.infer<typeof sceneReadSchema>;

export type SceneTerminalStatus =
  | "ready"
  | "label_absent"
  | "not_ready"
  | "stage_not_open"
  | "bridge_unavailable"
  | "stage_mismatch"
  | "invalid_payload"
  | "binding_failed";

export interface SceneDriftPolicy {
  count: "strict" | "advisory";
  maxTransformDeltaM: number;
  maxTransformDeltaDeg: number;
  maxExtentDeltaM: number;
  topology: "strict" | "advisory";
}

export interface SceneScenario {
  packageName: string;
  expectedBuildReceiptId?: string;
  provenance?: ImportedApkProvenance;
  expectedStageStyle: "Mixed" | "Full";
  expectedRootContainer: "stage";
  sceneDriftPolicy: SceneDriftPolicy;
}

export interface QuerySceneAnchorsInput {
  serial: string;
  scenario: SceneScenario;
  labels: string[];
  maxRetries: number;
  pollMs: number;
  includeGeometry: "lossless_external_artifact";
  stabilityReads: number;
}

export interface SceneActionReceipt {
  action: "bind_application_runtime" | "bridge_broadcast" | "bridge_payload_pull" | "bridge_payload_cleanup" | "publish_geometry";
  status: "applied" | "failed";
  startedAtMonotonicNs: string;
  endedAtMonotonicNs: string;
  ack: Record<string, unknown>;
  error?: string;
}

export interface ApplicationRuntimeBindingBase {
  serial: string;
  liveIdentity: {
    serial: string;
    model: string;
    fingerprint: string;
    bootQemu: string;
    bootId: string;
    observedAt: string;
  };
  captureSource: "agent-bridge-file-pull";
  startedAtMonotonicNs: string;
  endedAtMonotonicNs: string;
  packageName: string;
  buildReceiptId: string | null;
  buildReceiptPath: string | null;
  provenance?: ImportedApkReceipt;
  apkSha256: string;
  foregroundProcess: { packageName: string; component: string; pid: number; pidStartTicks: string };
  requestedStageStyle: "Mixed" | "Full";
  requestedRootContainer: "stage";
  effectiveSceneDriftPolicy: SceneDriftPolicy;
}

export interface ApplicationRuntimeBinding extends ApplicationRuntimeBindingBase {
  observedStageStyle: "Mixed" | "Full";
  rootContainer: string;
  stageOpen: boolean;
  bridgePayloadKind: typeof AGENT_BRIDGE_SCENE_PAYLOAD_KIND;
  bridgeSchemaVersion: typeof AGENT_BRIDGE_SCENE_SCHEMA_VERSION;
  bridgeRevision: typeof AGENT_BRIDGE_SCENE_REVISION;
  requestId: string;
}

export interface GeometryRef {
  path: string;
  sha256: string;
  bytes: number;
  schemaVersion: typeof GEOMETRY_ARTIFACT_SCHEMA_VERSION;
  coordinateFrameId: string;
  units: "metres";
  handedness: "sdk-reported";
  bridgeRevision: typeof AGENT_BRIDGE_SCENE_REVISION;
}

interface BoundRuntimeResult {
  ok: true;
  binding: ApplicationRuntimeBindingBase;
  actionReceipts: SceneActionReceipt[];
}

interface RuntimeBindingFailure {
  ok: false;
  detail: string;
  binding: ApplicationRuntimeBindingBase | null;
  actionReceipts: SceneActionReceipt[];
}

interface BridgeFetchSuccess {
  ok: true;
  bytes: Buffer;
  actionReceipts: SceneActionReceipt[];
}

interface BridgeFetchFailure {
  ok: false;
  code: "bridge_unavailable";
  detail: string;
  actionReceipts: SceneActionReceipt[];
}

export interface QuerySceneAnchorsDependencies {
  monotonicNs: () => bigint;
  requestId: () => string;
  bindRuntime: (input: QuerySceneAnchorsInput, startedAtMonotonicNs: string) => Promise<BoundRuntimeResult | RuntimeBindingFailure>;
  fetchPayload: (input: QuerySceneAnchorsInput, requestId: string) => Promise<BridgeFetchSuccess | BridgeFetchFailure>;
  writeGeometryArtifact: (
    payload: SceneBridgePayload,
    exactPayloadBytes: Buffer,
    monotonicNs: () => bigint,
  ) => { geometryRef: GeometryRef; receipt: SceneActionReceipt };
}

export type ParsedSceneBridgePayload =
  | { ok: true; payload: SceneBridgePayload }
  | { ok: false; detail: string };

/** Strict, versioned parser for exact file bytes. It never accepts MESH|/logcat text. */
export function parseSceneBridgePayload(bytes: Buffer | string): ParsedSceneBridgePayload {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  if (buffer.length === 0) return { ok: false, detail: "bridge payload is empty" };
  if (buffer.length > 128 * 1024 * 1024) return { ok: false, detail: "bridge payload exceeds the 128 MiB parser bound" };
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) return { ok: false, detail: "bridge payload is not lossless UTF-8" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error: any) {
    return { ok: false, detail: `bridge payload is not valid JSON: ${error?.message ?? String(error)}` };
  }
  const checked = sceneBridgePayloadSchema.safeParse(decoded);
  if (!checked.success) {
    return {
      ok: false,
      detail: checked.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`).join("; "),
    };
  }
  const seenReads = new Set<number>();
  let previousQueryNs: bigint | null = null;
  for (const [readPosition, read] of checked.data.reads.entries()) {
    if (seenReads.has(read.readIndex)) return { ok: false, detail: `duplicate readIndex ${read.readIndex}` };
    seenReads.add(read.readIndex);
    if (read.readIndex !== readPosition) {
      return { ok: false, detail: `readIndex ${read.readIndex} is out of sequence at position ${readPosition}` };
    }
    const queryNs = BigInt(read.queriedAtMonotonicNs);
    if (previousQueryNs !== null && queryNs < previousQueryNs) {
      return { ok: false, detail: `read ${read.readIndex} queriedAtMonotonicNs moves backwards` };
    }
    previousQueryNs = queryNs;
    if (read.anchorCount !== read.anchors.length) {
      return { ok: false, detail: `read ${read.readIndex} anchorCount ${read.anchorCount} does not match ${read.anchors.length} anchors` };
    }
    const uuids = new Set<string>();
    for (const [anchorIndex, anchor] of read.anchors.entries()) {
      if (uuids.has(anchor.runtimeUuid)) return { ok: false, detail: `read ${read.readIndex} repeats runtimeUuid '${anchor.runtimeUuid}'` };
      uuids.add(anchor.runtimeUuid);
      if (anchor.vertices.length === 0 || anchor.vertices.length % 3 !== 0) {
        return { ok: false, detail: `read ${read.readIndex} anchor ${anchorIndex} vertices are not a non-empty flat xyz array` };
      }
      if (anchor.indices.length === 0 || anchor.indices.length % 3 !== 0) {
        return { ok: false, detail: `read ${read.readIndex} anchor ${anchorIndex} indices are not a non-empty triangle array` };
      }
      const vertexCount = anchor.vertices.length / 3;
      if (anchor.indices.some((index) => index >= vertexCount)) {
        return { ok: false, detail: `read ${read.readIndex} anchor ${anchorIndex} has an out-of-range vertex index` };
      }
      if (anchor.boundsM.some((extent) => extent < 0)) {
        return { ok: false, detail: `read ${read.readIndex} anchor ${anchorIndex} has a negative bound` };
      }
      const quaternionLength = Math.hypot(...anchor.rotationQuaternionXyzw);
      if (quaternionLength < 1e-9) return { ok: false, detail: `read ${read.readIndex} anchor ${anchorIndex} has a zero quaternion` };
      const matrixPosition = [anchor.worldFromAnchor[3], anchor.worldFromAnchor[7], anchor.worldFromAnchor[11]];
      if (distance3(matrixPosition, anchor.positionM) > 1e-5) {
        return { ok: false, detail: `read ${read.readIndex} anchor ${anchorIndex} positionM contradicts row-major worldFromAnchor translation` };
      }
      if (!matrixRotationMatchesQuaternion(anchor.worldFromAnchor, anchor.rotationQuaternionXyzw)) {
        return { ok: false, detail: `read ${read.readIndex} anchor ${anchorIndex} rotationQuaternionXyzw contradicts row-major worldFromAnchor rotation` };
      }
    }
  }
  const expectedRetries = Math.max(0, checked.data.reads.length - 1);
  if (checked.data.readiness.retries !== expectedRetries) {
    return { ok: false, detail: `readiness retries ${checked.data.readiness.retries} does not match ${expectedRetries} retries in the read trace` };
  }
  if (checked.data.readiness.retries > checked.data.readiness.maxRetries) {
    return { ok: false, detail: "readiness retries exceed maxRetries" };
  }
  return { ok: true, payload: checked.data };
}

function normalizeFloat(value: number): number {
  if (!Number.isFinite(value)) throw new Error("snapshot contains a non-finite float");
  const normalized = Number(value.toFixed(SCENE_HASH_FLOAT_DECIMALS));
  return Object.is(normalized, -0) ? 0 : normalized;
}

function anchorProjection(anchor: RawSceneAnchor, normalize: boolean): Record<string, unknown> {
  const floats = (values: number[]) => normalize ? values.map(normalizeFloat) : [...values];
  return {
    worldFromAnchor: floats(anchor.worldFromAnchor),
    positionM: floats(anchor.positionM),
    rotationQuaternionXyzw: floats(anchor.rotationQuaternionXyzw),
    boundsM: floats(anchor.boundsM),
    vertices: floats(anchor.vertices),
    indices: [...anchor.indices],
    // Ordering and repetition may encode face/region association. Never deduplicate the raw list.
    semanticAssignments: [...anchor.semanticAssignments],
  };
}

function canonicalAnchorList(read: SceneRead, normalize: boolean): Array<Record<string, unknown>> {
  const sortIdentity = (value: Record<string, unknown>) => normalize ? JSON.stringify(value) : exactJson(value);
  return read.anchors
    .map((anchor) => anchorProjection(anchor, normalize))
    .sort((left, right) => {
      const leftIdentity = sortIdentity(left);
      const rightIdentity = sortIdentity(right);
      return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
    });
}

function exactJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => Object.is(entry, -0) ? { __picoNumber: "-0" } : entry);
}

export function normalizedSnapshotId(read: SceneRead, coordinateFrame: SceneBridgePayload["coordinateFrame"]): string {
  const normalized = {
    coordinateFrame,
    anchors: canonicalAnchorList(read, true),
  };
  return sha256Bytes(Buffer.from(JSON.stringify(normalized), "utf8"));
}

function rawSnapshotIdentity(read: SceneRead, coordinateFrame: SceneBridgePayload["coordinateFrame"]): string {
  return exactJson({ coordinateFrame, anchors: canonicalAnchorList(read, false) });
}

function labelSet(anchor: RawSceneAnchor): string[] {
  return [...new Set(anchor.semanticAssignments)].sort();
}

function distance3(left: number[], right: number[]): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function matrixRotationMatchesQuaternion(matrix: number[], quaternionRaw: number[]): boolean {
  const affineTolerance = 1e-4;
  if (
    Math.abs(matrix[12]) > affineTolerance
    || Math.abs(matrix[13]) > affineTolerance
    || Math.abs(matrix[14]) > affineTolerance
    || Math.abs(matrix[15] - 1) > affineTolerance
  ) return false;
  const scales = [
    Math.hypot(matrix[0], matrix[4], matrix[8]),
    Math.hypot(matrix[1], matrix[5], matrix[9]),
    Math.hypot(matrix[2], matrix[6], matrix[10]),
  ];
  if (scales.some((scale) => scale < 1e-9)) return false;
  const actual = [
    matrix[0] / scales[0], matrix[1] / scales[1], matrix[2] / scales[2],
    matrix[4] / scales[0], matrix[5] / scales[1], matrix[6] / scales[2],
    matrix[8] / scales[0], matrix[9] / scales[1], matrix[10] / scales[2],
  ];
  const length = Math.hypot(...quaternionRaw);
  const [x, y, z, w] = quaternionRaw.map((value) => value / length);
  const expected = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  return actual.every((value, index) => Math.abs(value - expected[index]) <= affineTolerance);
}

function quaternionDeltaDeg(leftRaw: number[], rightRaw: number[]): number {
  const leftLength = Math.hypot(...leftRaw);
  const rightLength = Math.hypot(...rightRaw);
  const dot = Math.abs(leftRaw.reduce((sum, value, index) => sum + (value / leftLength) * (rightRaw[index] / rightLength), 0));
  return 2 * Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
}

interface GeometricMatch {
  previousIndex: number;
  currentIndex: number;
  score: number;
}

function matchScore(previous: RawSceneAnchor, current: RawSceneAnchor): number {
  return distance3(previous.positionM, current.positionM)
    + distance3(previous.boundsM, current.boundsM) * 0.1;
}

function geometricallyMatch(previous: SceneRead, current: SceneRead, policy: SceneDriftPolicy): {
  matches: GeometricMatch[];
  unmatchedPrevious: number[];
  unmatchedCurrent: number[];
  ambiguities: Array<{ previousIndex: number; candidateCurrentIndices: number[]; score: number }>;
} {
  const candidateRows = previous.anchors.map((anchor, previousIndex) => {
    const candidates = current.anchors
      .map((other, currentIndex) => ({ previousIndex, currentIndex, score: matchScore(anchor, other) }))
      .sort((left, right) => left.score - right.score || left.currentIndex - right.currentIndex);
    return candidates;
  });
  const ambiguities = candidateRows.flatMap((candidates, previousIndex) => {
    if (candidates.length < 2 || Math.abs(candidates[0].score - candidates[1].score) > 1e-12) return [];
    return [{
      previousIndex,
      candidateCurrentIndices: candidates.filter((candidate) => Math.abs(candidate.score - candidates[0].score) <= 1e-12).map((candidate) => candidate.currentIndex),
      score: candidates[0].score,
    }];
  });
  const maximumMatchDistance = Math.max(0.5, policy.maxTransformDeltaM * 10, policy.maxExtentDeltaM * 10);
  const pairs = candidateRows.flat().sort((left, right) => left.score - right.score || left.previousIndex - right.previousIndex || left.currentIndex - right.currentIndex);
  const usedPrevious = new Set<number>();
  const usedCurrent = new Set<number>();
  const matches: GeometricMatch[] = [];
  const accept = (pair: GeometricMatch) => {
    usedPrevious.add(pair.previousIndex);
    usedCurrent.add(pair.currentIndex);
    matches.push(pair);
  };
  // Preserve genuine additions/removals by taking plausible nearby geometric matches first.
  for (const pair of pairs) {
    if (usedPrevious.has(pair.previousIndex) || usedCurrent.has(pair.currentIndex)) continue;
    if (distance3(previous.anchors[pair.previousIndex].positionM, current.anchors[pair.currentIndex].positionM) <= maximumMatchDistance) accept(pair);
  }
  // Then conservatively pair any remaining anchors. Otherwise a large move can masquerade as an
  // advisory remove/add pair and bypass the mandatory numeric transform bound.
  for (const pair of pairs) {
    if (usedPrevious.has(pair.previousIndex) || usedCurrent.has(pair.currentIndex)) continue;
    accept(pair);
  }
  return {
    matches: matches.sort((left, right) => left.previousIndex - right.previousIndex),
    unmatchedPrevious: previous.anchors.map((_, index) => index).filter((index) => !usedPrevious.has(index)),
    unmatchedCurrent: current.anchors.map((_, index) => index).filter((index) => !usedCurrent.has(index)),
    ambiguities,
  };
}

export interface SceneDriftAmbiguity {
  previousIndex: number;
  candidateCurrentIndices: number[];
  score: number;
}

export type SceneDriftDelta =
  | { metric: "anchor_count"; value: number; policy: "strict" | "advisory"; withinPolicy: boolean }
  | {
    metric: "anchor";
    previousIndex: number;
    currentIndex: number;
    geometricMatchScore: number;
    transformDeltaM: number;
    transformDeltaDeg: number;
    extentDeltaM: number;
    labelsChanged: boolean;
    previousLabels: string[];
    currentLabels: string[];
    topologyChanged: boolean;
    withinPolicy: boolean;
  }
  | {
    metric: "unmatched_anchors";
    previous: number[];
    current: number[];
    policy: "strict" | "advisory";
    withinPolicy: boolean;
  }
  | {
    metric: "geometric_match_ambiguity";
    candidates: SceneDriftAmbiguity[];
    policy: "strict" | "advisory";
    withinPolicy: boolean;
  };

export interface SceneDriftReport {
  effectivePolicy: SceneDriftPolicy;
  exactSnapshotChanged: boolean;
  withinPolicy: boolean;
  countDelta: number;
  maxTransformDeltaM: number;
  maxTransformDeltaDeg: number;
  maxExtentDeltaM: number;
  labelSetChanges: number;
  topologyChanges: number;
  unmatchedPrevious: number;
  unmatchedCurrent: number;
  ambiguities: SceneDriftAmbiguity[];
  deltas: SceneDriftDelta[];
}

/** Compare consecutive runtime reads by geometry, never UUID or list index. */
export function computeSceneDrift(
  previous: SceneRead,
  current: SceneRead,
  coordinateFrame: SceneBridgePayload["coordinateFrame"],
  policy: SceneDriftPolicy,
): SceneDriftReport {
  const matched = geometricallyMatch(previous, current, policy);
  let maxTransformDeltaM = 0;
  let maxTransformDeltaDeg = 0;
  let maxExtentDeltaM = 0;
  let labelSetChanges = 0;
  let topologyChanges = 0;
  const deltas: SceneDriftDelta[] = [];
  const countDelta = current.anchors.length - previous.anchors.length;
  const countWithin = countDelta === 0 || policy.count === "advisory";
  deltas.push({ metric: "anchor_count", value: countDelta, policy: policy.count, withinPolicy: countWithin });

  for (const match of matched.matches) {
    const before = previous.anchors[match.previousIndex];
    const after = current.anchors[match.currentIndex];
    const transformM = distance3(before.positionM, after.positionM);
    const transformDeg = quaternionDeltaDeg(before.rotationQuaternionXyzw, after.rotationQuaternionXyzw);
    const extentM = Math.max(...before.boundsM.map((value, index) => Math.abs(value - after.boundsM[index])));
    const beforeLabels = labelSet(before);
    const afterLabels = labelSet(after);
    const labelsChanged = JSON.stringify(beforeLabels) !== JSON.stringify(afterLabels);
    const topologyChanged = before.vertices.length !== after.vertices.length
      || before.indices.length !== after.indices.length
      || before.indices.some((value, index) => value !== after.indices[index]);
    if (labelsChanged) labelSetChanges++;
    if (topologyChanged) topologyChanges++;
    maxTransformDeltaM = Math.max(maxTransformDeltaM, transformM);
    maxTransformDeltaDeg = Math.max(maxTransformDeltaDeg, transformDeg);
    maxExtentDeltaM = Math.max(maxExtentDeltaM, extentM);
    deltas.push({
      metric: "anchor",
      previousIndex: match.previousIndex,
      currentIndex: match.currentIndex,
      geometricMatchScore: match.score,
      transformDeltaM: transformM,
      transformDeltaDeg: transformDeg,
      extentDeltaM: extentM,
      labelsChanged,
      previousLabels: beforeLabels,
      currentLabels: afterLabels,
      topologyChanged,
      withinPolicy:
        transformM <= policy.maxTransformDeltaM
        && transformDeg <= policy.maxTransformDeltaDeg
        && extentM <= policy.maxExtentDeltaM
        // The plan has one structural-drift switch. Treat SDK label-set changes as semantic
        // topology: strict refuses them; advisory reports them without hiding numeric violations.
        && (!(labelsChanged || topologyChanged) || policy.topology === "advisory"),
    });
  }

  const unmatched = matched.unmatchedPrevious.length + matched.unmatchedCurrent.length;
  if (unmatched) {
    topologyChanges += unmatched;
    deltas.push({
      metric: "unmatched_anchors",
      previous: matched.unmatchedPrevious,
      current: matched.unmatchedCurrent,
      policy: policy.topology,
      withinPolicy: policy.topology === "advisory",
    });
  }
  if (matched.ambiguities.length) {
    deltas.push({
      metric: "geometric_match_ambiguity",
      candidates: matched.ambiguities,
      policy: policy.topology,
      withinPolicy: policy.topology === "advisory",
    });
  }
  const withinPolicy = countWithin
    && maxTransformDeltaM <= policy.maxTransformDeltaM
    && maxTransformDeltaDeg <= policy.maxTransformDeltaDeg
    && maxExtentDeltaM <= policy.maxExtentDeltaM
    && (policy.topology === "advisory" || (labelSetChanges === 0 && topologyChanges === 0 && matched.ambiguities.length === 0));
  return {
    effectivePolicy: { ...policy },
    exactSnapshotChanged: rawSnapshotIdentity(previous, coordinateFrame) !== rawSnapshotIdentity(current, coordinateFrame),
    withinPolicy,
    countDelta,
    maxTransformDeltaM,
    maxTransformDeltaDeg,
    maxExtentDeltaM,
    labelSetChanges,
    topologyChanges,
    unmatchedPrevious: matched.unmatchedPrevious.length,
    unmatchedCurrent: matched.unmatchedCurrent.length,
    ambiguities: matched.ambiguities,
    deltas,
  };
}

function completeIndexCoverage(total: number, matched: number[], unmatched: number[]): boolean {
  const covered = [...matched, ...unmatched];
  return covered.length === total
    && covered.every((index) => Number.isInteger(index) && index >= 0 && index < total)
    && new Set(covered).size === total;
}

/** Validate the self-contained receipt emitted for one transition between exactly two reads. */
export function isCoherentTwoReadSceneDrift(
  drift: SceneDriftReport,
  currentAnchorCount: number,
): boolean {
  if (
    !Number.isInteger(currentAnchorCount)
    || currentAnchorCount < 0
    || !Number.isInteger(drift.countDelta)
  ) return false;

  const countDeltas = drift.deltas.filter((delta) => delta.metric === "anchor_count");
  const anchorDeltas = drift.deltas.filter((delta) => delta.metric === "anchor");
  const unmatchedDeltas = drift.deltas.filter((delta) => delta.metric === "unmatched_anchors");
  const ambiguityDeltas = drift.deltas.filter((delta) => delta.metric === "geometric_match_ambiguity");
  if (countDeltas.length !== 1 || unmatchedDeltas.length > 1 || ambiguityDeltas.length > 1) return false;

  const countDelta = countDeltas[0];
  const previousAnchorCount = currentAnchorCount - drift.countDelta;
  const countWithinPolicy = countDelta.value === 0 || drift.effectivePolicy.count === "advisory";
  if (
    !Number.isInteger(previousAnchorCount)
    || previousAnchorCount < 0
    || countDelta.value !== drift.countDelta
    || countDelta.policy !== drift.effectivePolicy.count
    || countDelta.withinPolicy !== countWithinPolicy
  ) return false;

  const unmatchedDelta = unmatchedDeltas[0];
  const unmatchedPrevious = unmatchedDelta?.previous ?? [];
  const unmatchedCurrent = unmatchedDelta?.current ?? [];
  if (
    Boolean(unmatchedDelta) !== (unmatchedPrevious.length + unmatchedCurrent.length > 0)
    || (unmatchedDelta !== undefined && (
      unmatchedDelta.policy !== drift.effectivePolicy.topology
      || unmatchedDelta.withinPolicy !== (drift.effectivePolicy.topology === "advisory")
    ))
  ) return false;

  const previousMatches = anchorDeltas.map((delta) => delta.previousIndex);
  const currentMatches = anchorDeltas.map((delta) => delta.currentIndex);
  if (
    !completeIndexCoverage(previousAnchorCount, previousMatches, unmatchedPrevious)
    || !completeIndexCoverage(currentAnchorCount, currentMatches, unmatchedCurrent)
  ) return false;

  for (const delta of anchorDeltas) {
    const numericDeltas = [
      delta.geometricMatchScore,
      delta.transformDeltaM,
      delta.transformDeltaDeg,
      delta.extentDeltaM,
    ];
    if (numericDeltas.some((value) => !Number.isFinite(value) || value < 0)) return false;
    const labelsChanged = JSON.stringify(delta.previousLabels) !== JSON.stringify(delta.currentLabels);
    const withinPolicy = delta.transformDeltaM <= drift.effectivePolicy.maxTransformDeltaM
      && delta.transformDeltaDeg <= drift.effectivePolicy.maxTransformDeltaDeg
      && delta.extentDeltaM <= drift.effectivePolicy.maxExtentDeltaM
      && (!(labelsChanged || delta.topologyChanged) || drift.effectivePolicy.topology === "advisory");
    if (delta.labelsChanged !== labelsChanged || delta.withinPolicy !== withinPolicy) return false;
  }

  const ambiguityDelta = ambiguityDeltas[0];
  const ambiguityCandidates = ambiguityDelta?.candidates ?? [];
  if (
    Boolean(ambiguityDelta) !== (drift.ambiguities.length > 0)
    || JSON.stringify(ambiguityCandidates) !== JSON.stringify(drift.ambiguities)
    || (ambiguityDelta !== undefined && (
      ambiguityDelta.policy !== drift.effectivePolicy.topology
      || ambiguityDelta.withinPolicy !== (drift.effectivePolicy.topology === "advisory")
      || ambiguityCandidates.some((ambiguity) => (
        !Number.isInteger(ambiguity.previousIndex)
        || ambiguity.previousIndex < 0
        || ambiguity.previousIndex >= previousAnchorCount
        || !Number.isFinite(ambiguity.score)
        || ambiguity.score < 0
        || ambiguity.candidateCurrentIndices.some((index) => (
          !Number.isInteger(index) || index < 0 || index >= currentAnchorCount
        ))
        || new Set(ambiguity.candidateCurrentIndices).size !== ambiguity.candidateCurrentIndices.length
      ))
    ))
  ) return false;

  const maxTransformDeltaM = anchorDeltas.reduce((maximum, delta) => Math.max(maximum, delta.transformDeltaM), 0);
  const maxTransformDeltaDeg = anchorDeltas.reduce((maximum, delta) => Math.max(maximum, delta.transformDeltaDeg), 0);
  const maxExtentDeltaM = anchorDeltas.reduce((maximum, delta) => Math.max(maximum, delta.extentDeltaM), 0);
  const labelSetChanges = anchorDeltas.filter((delta) => delta.labelsChanged).length;
  const topologyChanges = anchorDeltas.filter((delta) => delta.topologyChanged).length
    + unmatchedPrevious.length
    + unmatchedCurrent.length;
  if (
    drift.maxTransformDeltaM !== maxTransformDeltaM
    || drift.maxTransformDeltaDeg !== maxTransformDeltaDeg
    || drift.maxExtentDeltaM !== maxExtentDeltaM
    || drift.labelSetChanges !== labelSetChanges
    || drift.topologyChanges !== topologyChanges
    || drift.unmatchedPrevious !== unmatchedPrevious.length
    || drift.unmatchedCurrent !== unmatchedCurrent.length
  ) return false;

  const withinPolicy = countWithinPolicy
    && maxTransformDeltaM <= drift.effectivePolicy.maxTransformDeltaM
    && maxTransformDeltaDeg <= drift.effectivePolicy.maxTransformDeltaDeg
    && maxExtentDeltaM <= drift.effectivePolicy.maxExtentDeltaM
    && (
      drift.effectivePolicy.topology === "advisory"
      || (labelSetChanges === 0 && topologyChanges === 0 && ambiguityCandidates.length === 0)
    );
  return drift.withinPolicy === withinPolicy;
}

/** Aggregate every consecutive transition in the accepted non-empty readiness streak. */
function computeReadinessStreakDrift(
  reads: SceneRead[],
  coordinateFrame: SceneBridgePayload["coordinateFrame"],
  policy: SceneDriftPolicy,
): SceneDriftReport {
  if (reads.length < 2) throw new Error("readiness drift requires at least two reads");
  const reports = reads.slice(1).map((current, index) => computeSceneDrift(reads[index], current, coordinateFrame, policy));
  const drift = {
    effectivePolicy: { ...policy },
    exactSnapshotChanged: reports.some((report) => report.exactSnapshotChanged),
    withinPolicy: reports.every((report) => report.withinPolicy),
    countDelta: reads.at(-1)!.anchors.length - reads[0].anchors.length,
    maxTransformDeltaM: Math.max(...reports.map((report) => report.maxTransformDeltaM)),
    maxTransformDeltaDeg: Math.max(...reports.map((report) => report.maxTransformDeltaDeg)),
    maxExtentDeltaM: Math.max(...reports.map((report) => report.maxExtentDeltaM)),
    labelSetChanges: reports.reduce((sum, report) => sum + report.labelSetChanges, 0),
    topologyChanges: reports.reduce((sum, report) => sum + report.topologyChanges, 0),
    unmatchedPrevious: reports.reduce((sum, report) => sum + report.unmatchedPrevious, 0),
    unmatchedCurrent: reports.reduce((sum, report) => sum + report.unmatchedCurrent, 0),
    ambiguities: reports.flatMap((report) => report.ambiguities),
    deltas: reports.flatMap((report) => report.deltas),
  };
  if (reads.length === 2 && !isCoherentTwoReadSceneDrift(drift, reads.at(-1)!.anchors.length)) {
    throw new Error("producer generated an incoherent two-read scene drift receipt");
  }
  return drift;
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** Pure structural counterpart to the producer's realpath-enforced external publication boundary. */
export function isExternalGeometryArtifactPath(
  candidate: string,
  bridgeRevision: number,
  requestId: string,
): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const resolved = path.resolve(candidate);
  const sessionDirectory = path.basename(path.dirname(resolved));
  return !isWithin(repositoryRoot(), resolved)
    && sessionDirectory.startsWith("pico-scene-session-")
    && sessionDirectory.length > "pico-scene-session-".length
    && path.basename(resolved) === `scene-${bridgeRevision}-${requestId}.json`;
}

export function writeExternalGeometryArtifact(
  payload: SceneBridgePayload,
  exactPayloadBytes: Buffer,
  monotonicNs: () => bigint = () => process.hrtime.bigint(),
): { geometryRef: GeometryRef; receipt: SceneActionReceipt } {
  const startedAtMonotonicNs = monotonicNs().toString();
  const repo = fs.realpathSync(repositoryRoot());
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (isWithin(repo, temporaryRoot)) throw new Error("external geometry root resolves inside the repository");
  const sessionDir = fs.mkdtempSync(path.join(temporaryRoot, "pico-scene-session-"));
  const realSession = fs.realpathSync(sessionDir);
  if (isWithin(repo, realSession)) throw new Error("geometry session resolved inside the repository");
  const artifactPath = path.join(realSession, `scene-${payload.bridgeRevision}-${payload.requestId}.json`);
  if (!isExternalGeometryArtifactPath(artifactPath, payload.bridgeRevision, payload.requestId)) {
    throw new Error("geometry artifact path does not match the external session boundary");
  }
  const temporary = path.join(realSession, `.scene-${crypto.randomUUID()}.tmp`);
  const reparsed = parseSceneBridgePayload(exactPayloadBytes);
  if (!reparsed.ok || reparsed.payload.requestId !== payload.requestId) {
    throw new Error("exact bridge bytes do not match the validated payload identity");
  }
  // Publish the exact pulled bytes. Re-serializing parsed JSON would change lexical float details
  // such as -0, violating the lossless bridge/artifact contract.
  const bytes = Buffer.from(exactPayloadBytes);
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, artifactPath);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
  const exact = fs.readFileSync(artifactPath);
  if (!exact.equals(bytes)) throw new Error("published geometry artifact differs from the serialized payload");
  const geometryRef: GeometryRef = {
    path: fs.realpathSync(artifactPath),
    sha256: sha256Bytes(exact),
    bytes: exact.length,
    schemaVersion: GEOMETRY_ARTIFACT_SCHEMA_VERSION,
    coordinateFrameId: payload.coordinateFrame.id,
    units: payload.coordinateFrame.units,
    handedness: payload.coordinateFrame.handedness,
    bridgeRevision: payload.bridgeRevision,
  };
  return {
    geometryRef,
    receipt: {
      action: "publish_geometry",
      status: "applied",
      startedAtMonotonicNs,
      endedAtMonotonicNs: monotonicNs().toString(),
      ack: { path: geometryRef.path, sha256: geometryRef.sha256, bytes: geometryRef.bytes },
    },
  };
}

function noDrift(policy: SceneDriftPolicy): SceneDriftReport {
  return {
    effectivePolicy: { ...policy },
    exactSnapshotChanged: false,
    withinPolicy: false,
    countDelta: 0,
    maxTransformDeltaM: 0,
    maxTransformDeltaDeg: 0,
    maxExtentDeltaM: 0,
    labelSetChanges: 0,
    topologyChanges: 0,
    unmatchedPrevious: 0,
    unmatchedCurrent: 0,
    ambiguities: [],
    deltas: [],
  };
}

function terminalResult(
  status: SceneTerminalStatus,
  input: QuerySceneAnchorsInput,
  detail: string,
  options: {
    binding?: ApplicationRuntimeBindingBase | ApplicationRuntimeBinding | null;
    actionReceipts?: SceneActionReceipt[];
    geometryRef?: GeometryRef | null;
    retries?: number;
    queriedAtMonotonicNs?: string | null;
    trackingState?: string | null;
    totalAnchorCount?: number;
  } = {},
): Record<string, unknown> {
  return {
    status,
    snapshotId: null,
    applicationRuntimeBinding: options.binding ?? null,
    queriedAtMonotonicNs: options.queriedAtMonotonicNs ?? null,
    trackingState: options.trackingState ?? null,
    retries: options.retries ?? 0,
    totalAnchorCount: options.totalAnchorCount ?? 0,
    matchedAnchorCount: 0,
    geometryRef: options.geometryRef ?? null,
    anchors: [],
    histogram: {},
    drift: noDrift(input.scenario.sceneDriftPolicy),
    requestedLabels: [...input.labels],
    semanticRelationPolicy: {
      labelLevelSelection: true,
      triangleRelations: "refused",
      reason: "semantic_assignment_alignment_unverified",
    },
    actionReceipts: options.actionReceipts ?? [],
    error: { code: status, detail },
    evidenceCeiling: "structural",
  };
}

function completeBinding(
  base: ApplicationRuntimeBindingBase,
  payload: SceneBridgePayload,
  endedAtMonotonicNs: string,
): ApplicationRuntimeBinding | null {
  if (!payload.application.observedStageStyle || !payload.application.rootContainer) return null;
  return {
    ...base,
    endedAtMonotonicNs,
    observedStageStyle: payload.application.observedStageStyle,
    rootContainer: payload.application.rootContainer,
    stageOpen: payload.application.stageOpen,
    bridgePayloadKind: payload.kind,
    bridgeSchemaVersion: payload.schemaVersion,
    bridgeRevision: payload.bridgeRevision,
    requestId: payload.requestId,
  };
}

function payloadTrace(payload: SceneBridgePayload): {
  retries: number;
  queriedAtMonotonicNs: string | null;
  trackingState: string | null;
  totalAnchorCount: number;
} {
  const last = payload.reads.at(-1);
  return {
    retries: payload.readiness.retries,
    queriedAtMonotonicNs: last?.queriedAtMonotonicNs ?? null,
    trackingState: last?.trackingState ?? null,
    totalAnchorCount: last?.anchorCount ?? 0,
  };
}

/** Pure orchestration entrypoint. All adb/bridge/filesystem dependencies are injectable. */
export async function executeQuerySceneAnchors(
  input: QuerySceneAnchorsInput,
  deps: QuerySceneAnchorsDependencies,
): Promise<Record<string, unknown>> {
  const startedAtMonotonicNs = deps.monotonicNs().toString();
  const requestId = deps.requestId();
  const bound = await deps.bindRuntime(input, startedAtMonotonicNs);
  if (!bound.ok) {
    return terminalResult("binding_failed", input, bound.detail, {
      binding: bound.binding,
      actionReceipts: bound.actionReceipts,
    });
  }
  const actionReceipts = [...bound.actionReceipts];
  const fetched = await deps.fetchPayload(input, requestId);
  actionReceipts.push(...fetched.actionReceipts);
  if (!fetched.ok) {
    return terminalResult("bridge_unavailable", input, fetched.detail, {
      binding: bound.binding,
      actionReceipts,
    });
  }
  const parsed = parseSceneBridgePayload(fetched.bytes);
  if (!parsed.ok) {
    return terminalResult("invalid_payload", input, parsed.detail, {
      binding: bound.binding,
      actionReceipts,
    });
  }
  const payload = parsed.payload;
  if (payload.requestId !== requestId) {
    return terminalResult("invalid_payload", input, `payload requestId '${payload.requestId}' does not match '${requestId}'`, {
      binding: bound.binding,
      actionReceipts,
    });
  }
  const application = payload.application;
  const trace = payloadTrace(payload);
  if (application.packageName !== input.scenario.packageName) {
    return terminalResult("binding_failed", input, `bridge package '${application.packageName}' does not match '${input.scenario.packageName}'`, {
      binding: bound.binding, actionReceipts, ...trace,
    });
  }
  if (!application.buildIdentity) {
    return terminalResult("binding_failed", input, "bridge did not report its APK build identity", {
      binding: bound.binding, actionReceipts, ...trace,
    });
  }
  if (application.buildIdentity.sha256 !== bound.binding.apkSha256) {
    return terminalResult("binding_failed", input, "bridge-reported APK sha256 does not match the provenance-bound live APK", {
      binding: bound.binding, actionReceipts, ...trace,
    });
  }
  if (!application.observedStageStyle || !application.rootContainer) {
    return terminalResult("binding_failed", input, "bridge could not report stage style/root-container identity", {
      binding: bound.binding, actionReceipts, ...trace,
    });
  }
  const applicationRuntimeBinding = completeBinding(bound.binding, payload, deps.monotonicNs().toString())!;
  if (
    payload.readiness.maxRetries !== input.maxRetries
    || payload.readiness.pollMs !== input.pollMs
    || payload.readiness.stabilityReads !== input.stabilityReads
  ) {
    return terminalResult("invalid_payload", input, "payload readiness policy does not echo the requested policy", {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  if (application.observedStageStyle !== input.scenario.expectedStageStyle) {
    return terminalResult("stage_mismatch", input, `observed ${application.observedStageStyle}, expected ${input.scenario.expectedStageStyle}`, {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  if (application.rootContainer !== input.scenario.expectedRootContainer) {
    return terminalResult("binding_failed", input, `observed root container '${application.rootContainer}', expected '${input.scenario.expectedRootContainer}'`, {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  if (!application.stageOpen) {
    return terminalResult("stage_not_open", input, payload.error?.detail ?? "the application reports that Stage is not open", {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  if (payload.error?.code === "bridge_unavailable") {
    return terminalResult("bridge_unavailable", input, payload.error.detail, {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  if (payload.error?.code === "binding_failed") {
    return terminalResult("binding_failed", input, payload.error.detail, {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  if (payload.error?.code === "stage_not_open") {
    return terminalResult("invalid_payload", input, "bridge reported stage_not_open while application.stageOpen is true", {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  if (payload.error && !["not_ready"].includes(payload.error.code)) {
    return terminalResult("invalid_payload", input, `bridge reported ${payload.error.code}: ${payload.error.detail}`, {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  let streak = 0;
  let readyIndex = -1;
  for (let index = 0; index < payload.reads.length; index++) {
    streak = payload.reads[index].anchors.length > 0 ? streak + 1 : 0;
    if (streak >= input.stabilityReads) {
      readyIndex = index;
      break;
    }
  }
  if (payload.readiness.satisfied !== (readyIndex >= 0)) {
    return terminalResult("invalid_payload", input, "producer readiness flag contradicts the unfiltered read trace", {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  if (payload.error?.code === "not_ready" && readyIndex >= 0) {
    return terminalResult("invalid_payload", input, "bridge reported not_ready after satisfying the unfiltered readiness streak", {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  if (readyIndex >= 0 && readyIndex !== payload.reads.length - 1) {
    return terminalResult("invalid_payload", input, "bridge emitted reads after the first satisfied readiness streak", {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }

  // Room geometry is materialized only after protocol, package/build, stage/root, and readiness
  // coherence are established. A wrong or contradictory payload is refused without persisting it.
  let published: { geometryRef: GeometryRef; receipt: SceneActionReceipt };
  const publicationStartedAt = deps.monotonicNs().toString();
  try {
    published = deps.writeGeometryArtifact(payload, fetched.bytes, deps.monotonicNs);
    actionReceipts.push(published.receipt);
  } catch (error: any) {
    const detail = `geometry artifact publication failed: ${error?.message ?? String(error)}`;
    actionReceipts.push(receipt(
      "publish_geometry", "failed", publicationStartedAt, deps.monotonicNs().toString(),
      { requestId: payload.requestId }, detail,
    ));
    return terminalResult("invalid_payload", input, detail, {
      binding: applicationRuntimeBinding, actionReceipts, ...trace,
    });
  }
  const geometryRef = published.geometryRef;
  if (readyIndex < 0) {
    const last = payload.reads.at(-1);
    return terminalResult("not_ready", input, payload.error?.detail ?? "unfiltered non-empty mesh readiness budget was exhausted", {
      binding: applicationRuntimeBinding,
      actionReceipts,
      geometryRef,
      retries: payload.readiness.retries,
      queriedAtMonotonicNs: last?.queriedAtMonotonicNs ?? null,
      trackingState: last?.trackingState ?? null,
      totalAnchorCount: last?.anchorCount ?? 0,
    });
  }

  const current = payload.reads[readyIndex];
  const acceptedStreak = payload.reads.slice(readyIndex - input.stabilityReads + 1, readyIndex + 1);
  const drift = computeReadinessStreakDrift(acceptedStreak, payload.coordinateFrame, input.scenario.sceneDriftPolicy);
  const requestedLabels = [...new Set(input.labels)].sort();
  let vertexStart = 0;
  let indexStart = 0;
  const decorated = current.anchors.map((anchor, sourceIndex) => {
    const geometrySlice = {
      vertexStart,
      vertexCount: anchor.vertices.length / 3,
      indexStart,
      indexCount: anchor.indices.length,
    };
    vertexStart += geometrySlice.vertexCount;
    indexStart += geometrySlice.indexCount;
    return {
      anchor,
      sourceIndex,
      labels: labelSet(anchor),
      geometrySlice,
      // Float rounding is reserved exclusively for snapshotId. Trace-local ordering uses raw
      // runtime values so hash normalization cannot silently become an identity rule.
      sortKey: exactJson(anchorProjection(anchor, false)),
    };
  }).sort((left, right) => (left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0) || left.sourceIndex - right.sourceIndex);
  const withTraceIds = decorated.map((entry, index) => ({ ...entry, traceId: `anchor-${String(index + 1).padStart(4, "0")}` }));
  const matched = withTraceIds.filter((entry) => entry.labels.some((label) => requestedLabels.includes(label)));
  const anchors = matched.map((entry) => ({
    traceId: entry.traceId,
    runtimeUuid: entry.anchor.runtimeUuid,
    runtimeUuidRole: "diagnostic_only",
    labels: entry.labels,
    worldFromAnchor: entry.anchor.worldFromAnchor,
    boundsM: entry.anchor.boundsM,
    geometrySlice: entry.geometrySlice,
    semanticAssignments: {
      domain: "unknown",
      rawCount: entry.anchor.semanticAssignments.length,
      alignment: "unverified",
      relationEligible: false,
    },
  }));
  const histogram: Record<string, number> = {};
  for (const entry of withTraceIds) {
    for (const label of entry.labels) histogram[label] = (histogram[label] ?? 0) + 1;
  }
  const status: SceneTerminalStatus = anchors.length ? "ready" : "label_absent";
  return {
    status,
    snapshotId: normalizedSnapshotId(current, payload.coordinateFrame),
    applicationRuntimeBinding,
    queriedAtMonotonicNs: current.queriedAtMonotonicNs,
    trackingState: current.trackingState,
    retries: payload.readiness.retries,
    totalAnchorCount: current.anchorCount,
    matchedAnchorCount: anchors.length,
    geometryRef,
    anchors,
    histogram,
    drift,
    requestedLabels,
    semanticRelationPolicy: {
      labelLevelSelection: true,
      triangleRelations: "refused",
      reason: "semantic_assignment_alignment_unverified",
    },
    actionReceipts,
    error: status === "ready" ? null : { code: "label_absent", detail: `ready mesh contains none of [${requestedLabels.join(", ")}]` },
    evidenceCeiling: "structural",
  };
}

function receipt(
  action: SceneActionReceipt["action"],
  status: SceneActionReceipt["status"],
  startedAtMonotonicNs: string,
  endedAtMonotonicNs: string,
  ack: Record<string, unknown>,
  error?: string,
): SceneActionReceipt {
  return { action, status, startedAtMonotonicNs, endedAtMonotonicNs, ack, ...(error ? { error } : {}) };
}

export function exactForegroundComponent(output: string, packageName: string): string | null {
  const components = new Set<string>();
  for (const match of output.matchAll(
    /(?:topResumedActivity=|mResumedActivity:\s*|ResumedActivity:\s*)ActivityRecord\{\S+\s+u\d+\s+([A-Za-z][A-Za-z0-9_.]*)\/([A-Za-z0-9_.$]+)/g,
  )) {
    if (match[1] === packageName) components.add(`${match[1]}/${match[2]}`);
  }
  return components.size === 1 ? [...components][0] : null;
}

export async function bindSceneApplicationRuntime(
  adb: string,
  input: QuerySceneAnchorsInput,
  startedAtMonotonicNs: string,
): Promise<BoundRuntimeResult | RuntimeBindingFailure> {
  const actionStart = process.hrtime.bigint().toString();
  const failBinding = (detail: string, binding: ApplicationRuntimeBindingBase | null = null): RuntimeBindingFailure => ({
    ok: false,
    detail,
    binding,
    actionReceipts: [receipt(
      "bind_application_runtime", "failed", actionStart, process.hrtime.bigint().toString(),
      { serial: input.serial, packageName: input.scenario.packageName, buildReceiptId: input.scenario.expectedBuildReceiptId }, detail,
    )],
  });
  let imported: ImportedApkReceipt | null = null;
  if (input.scenario.provenance) {
    if (input.scenario.expectedBuildReceiptId !== undefined) return failBinding("imported APK cannot also claim a native build receipt");
    try {
      imported = await validateImportedApk(input.scenario.provenance, {
        packageName: input.scenario.packageName,
        declaredStageStyle: input.scenario.expectedStageStyle === "Mixed" ? "1" : "3",
      });
    } catch (error) {
      return failBinding(error instanceof Error ? error.message : String(error));
    }
  }
  const stored = imported ? null : readNativeRunReceipt(input.scenario.packageName, input.scenario.expectedBuildReceiptId ?? "");
  if (stored && stored.status !== "valid") return failBinding(`native run receipt is invalid: ${stored.issues.join("; ")}`);
  const native = stored?.status === "valid" ? stored.receipt : null;
  if (!native && !imported) return failBinding("an explicit imported APK or native run receipt is required");
  if (native && native.runtime.serial !== input.serial) return failBinding(`run receipt serial '${native.runtime.serial}' does not match '${input.serial}'`);
  const listed = await run(adb, ["devices", "-l"], { timeoutMs: 10_000 });
  if (listed.code !== 0 || listed.timedOut) return failBinding(`adb devices failed: ${listed.stderr || listed.stdout}`);
  const online = parseOnlineAdbSerials(listed.stdout);
  if (!online.includes(input.serial)) return failBinding(`requested serial '${input.serial}' is not online; refusing to guess from [${online.join(", ") || "none"}]`);
  let identity;
  try {
    identity = await probeDeviceIdentity(adb, input.serial);
  } catch (error: any) {
    return failBinding(`live identity probe failed: ${error?.message ?? String(error)}`);
  }
  const boot = await run(adb, ["-s", input.serial, "shell", "cat", "/proc/sys/kernel/random/boot_id"], { timeoutMs: 10_000 });
  if (boot.code !== 0 || boot.timedOut || !boot.stdout.trim()) return failBinding("live boot ID probe failed");
  const bootId = boot.stdout.trim();
  if (native && (
    identity.model !== native.runtime.model
    || identity.fingerprint !== native.runtime.fingerprint
    || identity.bootQemu !== native.runtime.bootQemu
    || bootId !== native.runtime.bootId
  )) return failBinding("live adb identity does not match the native run receipt runtime");
  const packagePath = await run(adb, ["-s", input.serial, "shell", "pm", "path", input.scenario.packageName], { timeoutMs: 10_000 });
  const packageLines = packagePath.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const installedPath = packageLines.length === 1 ? /^package:(\S+)$/.exec(packageLines[0])?.[1] : undefined;
  if (packagePath.code !== 0 || packagePath.timedOut || !installedPath) return failBinding("could not bind exactly one installed base APK path");
  const digest = await run(adb, ["-s", input.serial, "shell", "sha256sum", installedPath], { timeoutMs: 30_000 });
  const digestLines = digest.stdout.trim().split(/\r?\n/);
  const digestLine = digestLines.length === 1 ? /^([a-f0-9]{64})[ \t]+\*?(\S+)$/.exec(digestLines[0]) : null;
  const apkSha256 = digestLine?.[1];
  if (digest.code !== 0 || digest.timedOut || !apkSha256 || digestLine?.[2] !== installedPath
    || apkSha256 !== (native?.apk.sha256 ?? imported!.apkSha256)) return failBinding("installed APK path/sha256 does not match the requested provenance");
  const pidResult = await run(adb, ["-s", input.serial, "shell", "pidof", input.scenario.packageName], { timeoutMs: 10_000 });
  const pids = pidResult.stdout.trim().split(/\s+/).filter((value) => /^[1-9]\d*$/.test(value)).map(Number).filter(Number.isSafeInteger);
  if (pidResult.code !== 0 || pidResult.timedOut || pids.length !== 1) return failBinding("could not bind exactly one running application process");
  const pid = pids[0];
  const stat = await run(adb, ["-s", input.serial, "shell", "cat", `/proc/${pid}/stat`], { timeoutMs: 10_000 });
  const closeParen = stat.stdout.lastIndexOf(")");
  const afterName = closeParen >= 0 ? stat.stdout.slice(closeParen + 2).trim().split(/\s+/) : [];
  const pidStartTicks = afterName[19];
  if (stat.code !== 0 || stat.timedOut || !pidStartTicks || !/^[1-9]\d*$/.test(pidStartTicks)) return failBinding("could not bind application process start ticks");
  if (native && (pid !== native.runtime.pid || pidStartTicks !== native.runtime.pidStartTicks)) return failBinding("live process identity does not match the native run receipt session");
  const foreground = await run(adb, ["-s", input.serial, "shell", "dumpsys", "activity", "activities"], { timeoutMs: 15_000 });
  const foregroundComponent = exactForegroundComponent(foreground.stdout, input.scenario.packageName);
  if (foreground.code !== 0 || foreground.timedOut || !foregroundComponent || (native && foregroundComponent !== native.runtime.component)) {
    return failBinding("application is not the exact receipt-bound resumed foreground component");
  }
  if (imported?.manifestInspection.launchComponent
    && canonicalApkComponent(input.scenario.packageName, foregroundComponent) !== imported.manifestInspection.launchComponent) {
    return failBinding("application foreground does not match the imported APK manifest launch component");
  }
  const binding: ApplicationRuntimeBindingBase = {
    serial: input.serial,
    liveIdentity: {
      ...identity,
      bootId,
      observedAt: new Date().toISOString(),
    },
    captureSource: "agent-bridge-file-pull",
    startedAtMonotonicNs,
    endedAtMonotonicNs: process.hrtime.bigint().toString(),
    packageName: input.scenario.packageName,
    buildReceiptId: native?.receiptId ?? null,
    buildReceiptPath: stored?.status === "valid" ? stored.receiptPath : null,
    ...(imported ? { provenance: imported } : {}),
    apkSha256,
    foregroundProcess: { packageName: input.scenario.packageName, component: foregroundComponent, pid, pidStartTicks },
    requestedStageStyle: input.scenario.expectedStageStyle,
    requestedRootContainer: input.scenario.expectedRootContainer,
    effectiveSceneDriftPolicy: { ...input.scenario.sceneDriftPolicy },
  };
  return {
    ok: true,
    binding,
    actionReceipts: [receipt(
      "bind_application_runtime", "applied", actionStart, binding.endedAtMonotonicNs,
      { serial: input.serial, packageName: input.scenario.packageName, buildReceiptId: native?.receiptId ?? null, apkSha256, pid, pidStartTicks, ...(imported ? { provenance: imported } : {}) },
    )],
  };
}

function defaultDependencies(adb: string): QuerySceneAnchorsDependencies {
  return {
    monotonicNs: () => process.hrtime.bigint(),
    requestId: () => crypto.randomUUID().replaceAll("-", ""),
    bindRuntime: (input, startedAt) => bindSceneApplicationRuntime(adb, input, startedAt),
    fetchPayload: async (input, requestId) => fetchAgentBridgeSceneSnapshot(adb, {
      serial: input.serial,
      packageName: input.scenario.packageName,
      requestId,
      maxRetries: input.maxRetries,
      pollMs: input.pollMs,
      stabilityReads: input.stabilityReads,
    }) as Promise<BridgeFetchSuccess | BridgeFetchFailure>,
    writeGeometryArtifact: writeExternalGeometryArtifact,
  };
}

/** Live entrypoint shared by public and internal orchestrators. */
export async function executeLiveQuerySceneAnchors(input: QuerySceneAnchorsInput) {
  return executeQuerySceneAnchors(input, defaultDependencies(resolveAdb()));
}

const sceneDriftPolicySchema = z.object({
  count: z.enum(["strict", "advisory"]),
  maxTransformDeltaM: z.number().nonnegative(),
  maxTransformDeltaDeg: z.number().nonnegative(),
  maxExtentDeltaM: z.number().nonnegative(),
  topology: z.enum(["strict", "advisory"]),
}).strict();

const scenarioSchema = z.object({
  packageName: z.string().min(1),
  expectedBuildReceiptId: sha256Schema.optional(),
  provenance: importedApkProvenanceSchema.optional(),
  expectedStageStyle: z.enum(["Mixed", "Full"]),
  expectedRootContainer: z.literal("stage"),
  sceneDriftPolicy: sceneDriftPolicySchema,
}).strict().superRefine((value, context) => {
  if ((value.expectedBuildReceiptId === undefined) === (value.provenance === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "provide exactly one native build receipt ID or imported APK provenance" });
  }
});

const geometryRefOutputSchema = z.object({
  path: z.string(), sha256: sha256Schema, bytes: z.number().int().nonnegative(),
  schemaVersion: z.literal(GEOMETRY_ARTIFACT_SCHEMA_VERSION), coordinateFrameId: z.literal(AGENT_BRIDGE_SCENE_COORDINATE_FRAME_ID),
  units: z.literal("metres"), handedness: z.literal("sdk-reported"),
  bridgeRevision: z.literal(AGENT_BRIDGE_SCENE_REVISION),
}).strict();

const monotonicNsSchema = z.string().regex(/^\d+$/);
const liveIdentityOutputSchema = z.object({
  serial: z.string().min(1),
  model: z.string().min(1),
  fingerprint: z.string().min(1),
  bootQemu: z.string(),
  bootId: z.string().min(1),
  observedAt: z.string().min(1),
}).strict();
const applicationBindingBaseOutputSchema = z.object({
  serial: z.string().min(1),
  liveIdentity: liveIdentityOutputSchema,
  captureSource: z.literal("agent-bridge-file-pull"),
  startedAtMonotonicNs: monotonicNsSchema,
  endedAtMonotonicNs: monotonicNsSchema,
  packageName: z.string().min(1),
  buildReceiptId: sha256Schema.nullable(),
  buildReceiptPath: z.string().min(1).nullable(),
  provenance: importedApkReceiptSchema.optional(),
  apkSha256: sha256Schema,
  foregroundProcess: z.object({
    packageName: z.string().min(1),
    component: z.string().min(1),
    pid: z.number().int().positive(),
    pidStartTicks: z.string().regex(/^[1-9]\d*$/),
  }).strict(),
  requestedStageStyle: z.enum(["Mixed", "Full"]),
  requestedRootContainer: z.literal("stage"),
  effectiveSceneDriftPolicy: sceneDriftPolicySchema,
}).strict();
const applicationBindingOutputSchema = applicationBindingBaseOutputSchema.extend({
  observedStageStyle: z.enum(["Mixed", "Full"]),
  rootContainer: z.string().min(1),
  stageOpen: z.boolean(),
  bridgePayloadKind: z.literal(AGENT_BRIDGE_SCENE_PAYLOAD_KIND),
  bridgeSchemaVersion: z.literal(AGENT_BRIDGE_SCENE_SCHEMA_VERSION),
  bridgeRevision: z.literal(AGENT_BRIDGE_SCENE_REVISION),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,96}$/),
}).strict();

function refineApplicationProvenance(binding: ApplicationRuntimeBindingBase, context: z.RefinementCtx): void {
  const imported = binding.provenance;
  if (imported) {
    if (binding.buildReceiptId !== null || binding.buildReceiptPath !== null
      || binding.apkSha256 !== imported.apkSha256 || binding.packageName !== imported.packageName
      || imported.declaredStageStyle !== (binding.requestedStageStyle === "Mixed" ? "1" : "3")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "imported APK binding must match its inspected provenance and cannot claim a native receipt" });
    }
  } else if (binding.buildReceiptId === null || binding.buildReceiptPath === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "runtime binding requires a native receipt or inspected imported APK provenance" });
  }
}

const geometrySliceOutputSchema = z.object({
  vertexStart: z.number().int().nonnegative(),
  vertexCount: z.number().int().positive(),
  indexStart: z.number().int().nonnegative(),
  indexCount: z.number().int().positive(),
}).strict();
const anchorOutputSchema = z.object({
  traceId: z.string().regex(/^anchor-\d{4}$/),
  runtimeUuid: z.string().min(1),
  runtimeUuidRole: z.literal("diagnostic_only"),
  labels: z.array(z.string().min(1)).min(1),
  worldFromAnchor: matrixSchema,
  boundsM: vec3Schema,
  geometrySlice: geometrySliceOutputSchema,
  semanticAssignments: z.object({
    domain: z.literal("unknown"),
    rawCount: z.number().int().nonnegative(),
    alignment: z.literal("unverified"),
    relationEligible: z.literal(false),
  }).strict(),
}).strict();

const ambiguityOutputSchema = z.object({
  previousIndex: z.number().int().nonnegative(),
  candidateCurrentIndices: z.array(z.number().int().nonnegative()).min(2),
  score: nonnegativeFiniteNumber,
}).strict();
const driftDeltaOutputSchema = z.union([
  z.object({
    metric: z.literal("anchor_count"), value: z.number().int(),
    policy: z.enum(["strict", "advisory"]), withinPolicy: z.boolean(),
  }).strict(),
  z.object({
    metric: z.literal("anchor"),
    previousIndex: z.number().int().nonnegative(),
    currentIndex: z.number().int().nonnegative(),
    geometricMatchScore: nonnegativeFiniteNumber,
    transformDeltaM: nonnegativeFiniteNumber,
    transformDeltaDeg: nonnegativeFiniteNumber,
    extentDeltaM: nonnegativeFiniteNumber,
    labelsChanged: z.boolean(),
    previousLabels: z.array(z.string()),
    currentLabels: z.array(z.string()),
    topologyChanged: z.boolean(),
    withinPolicy: z.boolean(),
  }).strict(),
  z.object({
    metric: z.literal("unmatched_anchors"),
    previous: z.array(z.number().int().nonnegative()),
    current: z.array(z.number().int().nonnegative()),
    policy: z.enum(["strict", "advisory"]),
    withinPolicy: z.boolean(),
  }).strict(),
  z.object({
    metric: z.literal("geometric_match_ambiguity"),
    candidates: z.array(ambiguityOutputSchema),
    policy: z.enum(["strict", "advisory"]),
    withinPolicy: z.boolean(),
  }).strict(),
]);
const driftOutputSchema = z.object({
  effectivePolicy: sceneDriftPolicySchema,
  exactSnapshotChanged: z.boolean(),
  withinPolicy: z.boolean(),
  countDelta: z.number().int(),
  maxTransformDeltaM: nonnegativeFiniteNumber,
  maxTransformDeltaDeg: nonnegativeFiniteNumber,
  maxExtentDeltaM: nonnegativeFiniteNumber,
  labelSetChanges: z.number().int().nonnegative(),
  topologyChanges: z.number().int().nonnegative(),
  unmatchedPrevious: z.number().int().nonnegative(),
  unmatchedCurrent: z.number().int().nonnegative(),
  ambiguities: z.array(ambiguityOutputSchema),
  deltas: z.array(driftDeltaOutputSchema),
}).strict();
const actionReceiptOutputSchema = z.object({
  action: z.enum(["bind_application_runtime", "bridge_broadcast", "bridge_payload_pull", "bridge_payload_cleanup", "publish_geometry"]),
  status: z.enum(["applied", "failed"]),
  startedAtMonotonicNs: monotonicNsSchema,
  endedAtMonotonicNs: monotonicNsSchema,
  ack: z.record(z.string(), z.unknown()),
  error: z.string().optional(),
}).strict();
const sceneTerminalStatusSchema = z.enum([
  "ready", "label_absent", "not_ready", "stage_not_open", "bridge_unavailable", "stage_mismatch", "invalid_payload", "binding_failed",
]);

export const querySceneAnchorsOutputSchema = z.object({
  status: sceneTerminalStatusSchema,
  snapshotId: sha256Schema.nullable(),
  applicationRuntimeBinding: z.union([
    applicationBindingOutputSchema.superRefine(refineApplicationProvenance),
    applicationBindingBaseOutputSchema.superRefine(refineApplicationProvenance),
  ]).nullable(),
  queriedAtMonotonicNs: monotonicNsSchema.nullable(),
  trackingState: z.string().nullable(),
  retries: z.number().int().nonnegative(),
  totalAnchorCount: z.number().int().nonnegative(),
  matchedAnchorCount: z.number().int().nonnegative(),
  geometryRef: geometryRefOutputSchema.nullable(),
  anchors: z.array(anchorOutputSchema),
  histogram: z.record(z.string(), z.number().int().nonnegative()),
  drift: driftOutputSchema,
  requestedLabels: z.array(z.string()),
  semanticRelationPolicy: z.object({
    labelLevelSelection: z.literal(true),
    triangleRelations: z.literal("refused"),
    reason: z.literal("semantic_assignment_alignment_unverified"),
  }).strict(),
  actionReceipts: z.array(actionReceiptOutputSchema),
  error: z.object({ code: sceneTerminalStatusSchema, detail: z.string() }).strict().nullable(),
  evidenceCeiling: z.literal("structural"),
}).strict();

export function registerSceneAnchorTools(server: McpServer) {
  server.registerTool(
    "query_scene_anchors",
    {
      description:
        "Query one running app bound by a native build receipt or inspected imported_apk provenance for a versioned, lossless Agent Bridge mesh snapshot. For imported APKs, supply scenario.provenance and omit scenario.expectedBuildReceiptId: Android SDK aapt2 inspects the compiled manifest before installed APK bytes and foreground-process identity are bound. Imported bindings retain inspected provenance and null native receipt ID/path. Readiness is established from consecutive UNFILTERED non-empty reads before labels are applied, and drift covers every transition in that accepted streak. Raw geometry and repeated semantic assignments go only to a private external artifact; returned labels may select anchors, but semantic alignment stays unverified and triangle relations are refused. The topology policy also governs reported SDK label-set changes; numeric transform and extent bounds always remain mandatory. Terminal statuses are ready, label_absent, not_ready, stage_not_open, bridge_unavailable, stage_mismatch, invalid_payload, or binding_failed. Evidence ceiling is structural.",
      inputSchema: {
        serial: z.string().min(1).describe("Exact online adb serial; never inferred."),
        scenario: scenarioSchema,
        labels: z.array(z.string().min(1)).min(1).describe("SDK label names applied only after unfiltered mesh readiness."),
        maxRetries: z.number().int().min(0).max(120).optional().describe("Unfiltered readiness retry budget (default 15)."),
        pollMs: z.number().int().min(10).max(60_000).optional().describe("Readiness polling interval in milliseconds (default 1000)."),
        includeGeometry: z.literal("lossless_external_artifact").optional().describe("Required Phase-1 geometry handling mode."),
        stabilityReads: z.number().int().min(2).max(8).optional().describe("Required consecutive unfiltered non-empty reads (default 2)."),
      },
      outputSchema: querySceneAnchorsOutputSchema.shape,
    },
    async ({ serial, scenario, labels, maxRetries, pollMs, includeGeometry, stabilityReads }) => {
      const result = await executeLiveQuerySceneAnchors({
        serial,
        scenario,
        labels,
        maxRetries: maxRetries ?? 15,
        pollMs: pollMs ?? 1000,
        includeGeometry: includeGeometry ?? "lossless_external_artifact",
        stabilityReads: stabilityReads ?? 2,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        ...(["ready", "label_absent"].includes(String(result.status)) ? {} : { isError: true }),
      };
    },
  );
}
