import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { projectResourceKey, revalidateProjectLocator } from "./fleetinputidentity.js";
import { canonicalJson } from "./runreceiptidentity.js";
import {
  createRunRevisionStore,
  type CoreRunChainV1,
  type RecoveryResultV1,
  type RunRevisionStoreV1,
  type RunStoreOptionsV1,
} from "./runrevisionstore.js";
import type {
  BoundedDiagnosticV1,
  CanonicalUtcTimestamp,
  ExternalPhaseV1,
  LowercaseUuidV4,
  ProjectLocatorV1,
  RunHeadV1,
  RunRevisionV1,
  RunStoreMutationRequestV1,
  Sha256,
  SnapshotEnvelopeV1,
  SnapshotRefV1,
} from "./runrevisiontypes.js";
import { RUN_REVISION_MAX_BYTES, parseRunHead, parseRunRevision, parseSnapshotEnvelope } from "./runrevisiontypes.js";

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL_PID = /^[1-9][0-9]*$/;
const MAX_NAMESPACE_ENTRIES = 4_096;
const MAX_COORDINATION_ENTRIES = 12_288;
const MAX_RECOVERY_ELECTION_ENTRIES = 4_096;
const MAX_AGGREGATE_RECOVERY_ELECTION_ENTRIES = 12_288;
const MAX_PHYSICAL_NAMESPACE_ENTRIES = MAX_NAMESPACE_ENTRIES + MAX_RECOVERY_ELECTION_ENTRIES;
const MAX_DIRECTORY_ENTRIES = 8;
const MAX_CAPACITY_ENTRIES = 8;
const MAX_CAPACITY_STAGING_ENTRIES = 1;
const MAX_OWNER_BYTES = 64 * 1024;
const ACQUIRE_BUDGET_MS = 15_000;
const WAIT_WORD = new Int32Array(new SharedArrayBuffer(4));

export type RunOwnerRecordV1 = Readonly<{
  pid: number;
  processIdentity: string;
  token: LowercaseUuidV4;
  createdAt: CanonicalUtcTimestamp;
  mode: "coordination" | "execution";
  scope: "run" | "application" | "project";
  runId: LowercaseUuidV4 | null;
  attemptId: LowercaseUuidV4 | null;
  resourceKey: Sha256 | null;
  projectResourceKey: Sha256 | null;
  physicalProjectDir: string | null;
}>;

export type PublicFleetExecutionMarkerV1 = Readonly<{
  kind: "pico.public-fleet-execution-started";
  schemaVersion: 1;
  createdAt: CanonicalUtcTimestamp;
  applicationOwnerToken: LowercaseUuidV4;
  projectOwnerToken: LowercaseUuidV4;
  attemptId: LowercaseUuidV4;
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  physicalProjectDir: string;
  briefPayloadSha256: Sha256;
  inputMode: "sealed" | "legacy-mutable";
  externalInputSha256: Sha256 | null;
}>;

export type PublicFleetCompletionMarkerV1 = Readonly<{
  kind: "pico.public-fleet-execution-completed";
  schemaVersion: 1;
  completedAt: CanonicalUtcTimestamp;
  applicationOwnerToken: LowercaseUuidV4;
  projectOwnerToken: LowercaseUuidV4;
  attemptId: LowercaseUuidV4;
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  physicalProjectDir: string;
  briefPayloadSha256: Sha256;
  inputMode: "sealed" | "legacy-mutable";
  externalInputSha256: Sha256 | null;
  executionDisposition: "definitely-completed";
  phase: "complete" | ExternalPhaseV1;
  externalMutationDisposition: "none" | "possible" | "confirmed";
  resultSha256: Sha256;
}>;

export type RunOwnerAcquireInputV1 = Readonly<{
  runId: LowercaseUuidV4;
  mode: "coordination" | "execution";
  attemptId: LowercaseUuidV4 | null;
  resourceKey: Sha256;
  projectResourceKey: Sha256;
  projectLocator: ProjectLocatorV1;
  deadlineMonotonicMs: number;
}>;

export type PublicFleetOwnerAcquireInputV1 = Readonly<
  Omit<RunOwnerAcquireInputV1, "runId" | "mode"> & {
    runId: null;
    mode: "execution";
    attemptId: LowercaseUuidV4;
  }
>;

export type RunLockDependenciesV1 = Readonly<{
  rootDir: string;
  pid: number;
  processIdentity(): string;
  isProcessIdentityLive(pid: number, identity: string): boolean;
  monotonicMs(): number;
  nowUtc(): CanonicalUtcTimestamp;
  uuid(): LowercaseUuidV4;
}>;

const ownerCapabilityBrand: unique symbol = Symbol("pico.run-owner-capability");
export type OwnerCapabilityV1<S extends "run" | "application" | "project"> = Readonly<{
  scope: S;
  token: LowercaseUuidV4;
  record: RunOwnerRecordV1;
  readonly [ownerCapabilityBrand]: true;
}>;
export type ApplicationOwnerCapabilityV1 = OwnerCapabilityV1<"application">;
export type RunOwnerSetV1 = Readonly<{
  run: OwnerCapabilityV1<"run">;
  application: ApplicationOwnerCapabilityV1;
  project: OwnerCapabilityV1<"project">;
}>;
export type PublicFleetOwnerSetV1 = Readonly<{
  run: null;
  application: ApplicationOwnerCapabilityV1;
  project: OwnerCapabilityV1<"project">;
}>;

const ownerReleaseAuthorityBrand: unique symbol = Symbol("pico.run-owner-release-authority");
export type DurableOwnerReleaseAuthorityV1 = Readonly<{
  kind: "run-head" | "public-fleet-completion";
  runId: LowercaseUuidV4 | null;
  attemptId: LowercaseUuidV4 | null;
  applicationOwnerToken: LowercaseUuidV4;
  projectOwnerToken: LowercaseUuidV4;
  runOwnerToken: LowercaseUuidV4 | null;
  authorityDigest: Sha256;
  readonly [ownerReleaseAuthorityBrand]: true;
}>;

const retainedOwnerBrand: unique symbol = Symbol("pico.retained-run-owners");
export type RetainedOwnerSetV1 = Readonly<{
  status: "retained-in-doubt";
  runId: LowercaseUuidV4;
  attemptId: LowercaseUuidV4;
  owners: RunOwnerSetV1;
  readonly [retainedOwnerBrand]: true;
}>;

export type DeadOwnerPrefixClassificationV1 =
  | { kind: "run-prefix"; owners:
      | readonly [RunOwnerRecordV1]
      | readonly [RunOwnerRecordV1, RunOwnerRecordV1]
      | readonly [RunOwnerRecordV1, RunOwnerRecordV1, RunOwnerRecordV1];
      chain: CoreRunChainV1 | null;
      classification: "pre-target" | "coordination-head" |
        "definite-outcome-head" | "attempt-in-doubt" | "invalid-store" }
  | { kind: "public-fleet-prefix"; owners:
      | readonly [RunOwnerRecordV1]
      | readonly [RunOwnerRecordV1, RunOwnerRecordV1];
      started: PublicFleetExecutionMarkerV1 | null;
      completed: PublicFleetCompletionMarkerV1 | null;
      classification: "pre-started" | "completed" |
        "interrupted-in-doubt" | "invalid-store" };

export type RunLockStatusV1 =
  | "run-busy" | "recovery-required" | "interrupted-in-doubt"
  | "external-state-conflict" | "target-conflict"
  | "invalid-store" | "limit-exceeded" | "state-write-failed";

export class RunLockError extends Error {
  readonly status: RunLockStatusV1;

  constructor(status: RunLockStatusV1, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RunLockError";
    this.status = status;
  }
}

type Scope = "run" | "application" | "project";
type OwnerOrigin = Readonly<{
  rootDir: string;
  lockPath: string;
  canonical: string;
  record: RunOwnerRecordV1;
}>;
type AuthorityOrigin = Readonly<{
  owners: RunOwnerSetV1 | PublicFleetOwnerSetV1;
  digest: Sha256;
  runHeadCanonical: string | null;
  publicCompletionCanonical: string | null;
}>;
type ElectionRecordV1 = Readonly<{
  kind: "pico.run-owner-recovery-election";
  schemaVersion: 1;
  pid: number;
  processIdentity: string;
  token: LowercaseUuidV4;
  createdAt: CanonicalUtcTimestamp;
  scope: Scope;
  ownerToken: LowercaseUuidV4;
  lockPath: string;
}>;
type ElectionLease = Readonly<{
  path: string;
  record: ElectionRecordV1;
  canonical: string;
}>;
type CapacityEnrollmentRecordV1 = Readonly<{
  kind: "pico.run-lock-capacity-enrollment";
  schemaVersion: 1;
  pid: number;
  processIdentity: string;
  token: LowercaseUuidV4;
  createdAt: CanonicalUtcTimestamp;
}>;
type CapacityEnrollmentLease = Readonly<{
  path: string;
  record: CapacityEnrollmentRecordV1;
  canonical: string;
}>;
type LocalRunGeneration = Readonly<{
  rootDir: string;
  runId: LowercaseUuidV4;
  mode: "coordination" | "execution";
  run: OwnerOrigin;
  application: OwnerOrigin;
  project: OwnerOrigin;
}>;
type ActiveRecovery = Readonly<{
  rootDir: string;
  runId: LowercaseUuidV4;
  ownerToken: LowercaseUuidV4;
  owners: readonly RunOwnerRecordV1[];
  elections: readonly ElectionLease[];
}>;

const OWNER_ORIGINS = new WeakMap<object, OwnerOrigin>();
const AUTHORITY_ORIGINS = new WeakMap<object, AuthorityOrigin>();
const RETAINED_ORIGINS = new WeakSet<object>();
const LOCAL_RUN_GENERATIONS = new Map<string, LocalRunGeneration>();
const ACTIVE_RECOVERY = new Map<string, ActiveRecovery>();

function fail(status: RunLockStatusV1, message: string, cause?: unknown): never {
  throw new RunLockError(status, message, cause);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateUuid(value: unknown, label: string): LowercaseUuidV4 {
  if (typeof value !== "string" || !UUID_V4.test(value)) fail("invalid-store", `${label} is not a lowercase UUIDv4`);
  return value;
}

function validateSha(value: unknown, label: string): Sha256 {
  if (typeof value !== "string" || !SHA256.test(value)) fail("invalid-store", `${label} is not a lowercase SHA-256`);
  return value;
}

function validateTimestamp(value: unknown, label: string): CanonicalUtcTimestamp {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("invalid-store", `${label} is not a timestamp`);
  let canonical: string;
  try { canonical = new Date(value).toISOString(); } catch { fail("invalid-store", `${label} is not a timestamp`); }
  if (canonical !== value) fail("invalid-store", `${label} is not a canonical UTC timestamp`);
  return value;
}

function validateAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail("invalid-store", `${label} is not a canonical absolute path`);
  }
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid-store", `${label} is not an object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) {
    fail("invalid-store", `${label} has unknown or missing keys`);
  }
  return object;
}

function strictProcessIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4_096 || value.includes("\0")) {
    fail("invalid-store", `${label} is missing or invalid`);
  }
  return value;
}

function runGenerationKey(rootDir: string, runId: LowercaseUuidV4, token: LowercaseUuidV4): string {
  return `${path.resolve(rootDir)}\0${runId}\0${token}`;
}

function scopeKey(record: RunOwnerRecordV1): string {
  if (record.scope === "run") return record.runId!;
  if (record.scope === "application") return record.resourceKey!;
  return record.projectResourceKey!;
}

function lockDirectory(rootDir: string, scope: Scope, key: string): string {
  return path.join(path.resolve(rootDir), "locks", scope, `${key}.lock`);
}

function recordLockPath(rootDir: string, record: RunOwnerRecordV1): string {
  return lockDirectory(rootDir, record.scope, scopeKey(record));
}

function shaToken(token: LowercaseUuidV4): Sha256 {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function ensureNoFollowDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid-store", `path component '${current}' is not a no-follow directory`);
    } catch (error) {
      if (error instanceof RunLockError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("state-write-failed", `cannot inspect '${current}': ${errorText(error)}`);
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        fsyncDirectory(path.dirname(current));
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          fail("state-write-failed", `cannot create '${current}': ${errorText(mkdirError)}`);
        }
      }
      const created = fs.lstatSync(current);
      if (!created.isDirectory() || created.isSymbolicLink()) fail("invalid-store", `created path '${current}' is unsafe`);
    }
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
}

function directoryNamesBounded(directory: string, label: string, maximum = MAX_DIRECTORY_ENTRIES): string[] {
  const before = fs.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) fail("invalid-store", `${label} is not a no-follow directory`);
  const names: string[] = [];
  const handle = fs.opendirSync(directory);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (names.length === maximum) fail("limit-exceeded", `${label} exceeds its ${maximum}-entry bound`);
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  const after = fs.lstatSync(directory, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    fail("run-busy", `${label} changed during enumeration`);
  }
  return names;
}

function readCanonicalLeaf(
  filePath: string,
  maximum = MAX_OWNER_BYTES,
  allowedLinks: readonly bigint[] = [1n],
): { raw: unknown; canonical: string } {
  const beforePath = fs.lstatSync(filePath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || !allowedLinks.includes(beforePath.nlink)
    || beforePath.size <= 0n || beforePath.size > BigInt(maximum + 1)) {
    fail("invalid-store", `ownership leaf '${filePath}' is unsafe or exceeds its byte bound`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.size !== beforePath.size
      || !allowedLinks.includes(before.nlink)) {
      fail("invalid-store", `ownership leaf '${filePath}' changed before open`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) fail("invalid-store", `ownership leaf '${filePath}' ended during read`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || after.dev !== afterPath.dev || after.ino !== afterPath.ino || after.size !== afterPath.size
      || !allowedLinks.includes(after.nlink) || !allowedLinks.includes(afterPath.nlink)) {
      fail("invalid-store", `ownership leaf '${filePath}' changed during read`);
    }
    if (bytes.at(-1) !== 0x0a) fail("invalid-store", `ownership leaf '${filePath}' lacks its publication newline`);
    const content = bytes.subarray(0, -1);
    let canonical: string;
    try { canonical = new TextDecoder("utf-8", { fatal: true }).decode(content); } catch (error) {
      fail("invalid-store", `ownership leaf '${filePath}' is not valid UTF-8`, error);
    }
    let raw: unknown;
    try { raw = JSON.parse(canonical); } catch (error) { fail("invalid-store", `ownership leaf '${filePath}' is not JSON`, error); }
    if (canonicalJson(raw) !== canonical) fail("invalid-store", `ownership leaf '${filePath}' is not canonical JSON plus one newline`);
    return { raw, canonical };
  } finally {
    fs.closeSync(descriptor);
  }
}

const OWNER_KEYS = [
  "pid", "processIdentity", "token", "createdAt", "mode", "scope", "runId", "attemptId",
  "resourceKey", "projectResourceKey", "physicalProjectDir",
] as const;

function parseOwnerRecord(value: unknown): RunOwnerRecordV1 {
  const object = exactRecord(value, OWNER_KEYS, "owner record");
  if (!Number.isSafeInteger(object.pid) || (object.pid as number) <= 0) fail("invalid-store", "owner pid is invalid");
  const processIdentity = strictProcessIdentity(object.processIdentity, "owner processIdentity");
  const token = validateUuid(object.token, "owner token");
  const createdAt = validateTimestamp(object.createdAt, "owner createdAt");
  if (object.mode !== "coordination" && object.mode !== "execution") fail("invalid-store", "owner mode is invalid");
  if (object.scope !== "run" && object.scope !== "application" && object.scope !== "project") fail("invalid-store", "owner scope is invalid");
  const mode = object.mode;
  const scope = object.scope;
  const runId = object.runId === null ? null : validateUuid(object.runId, "owner runId");
  const attemptId = object.attemptId === null ? null : validateUuid(object.attemptId, "owner attemptId");
  const resourceKey = object.resourceKey === null ? null : validateSha(object.resourceKey, "owner resourceKey");
  const projectResourceKey = object.projectResourceKey === null ? null : validateSha(object.projectResourceKey, "owner projectResourceKey");
  const physicalProjectDir = object.physicalProjectDir === null ? null
    : validateAbsolutePath(object.physicalProjectDir, "owner physicalProjectDir");

  if ((mode === "coordination") !== (attemptId === null)) fail("invalid-store", "coordination/attempt owner fields disagree");
  if (runId === null && (mode !== "execution" || attemptId === null || scope === "run")) {
    fail("invalid-store", "nullable-run owner form is not a public execution application/project owner");
  }
  if (scope === "run") {
    if (runId === null || resourceKey !== null || projectResourceKey !== null || physicalProjectDir !== null) {
      fail("invalid-store", "run owner resource fields are invalid");
    }
  } else if (resourceKey === null || projectResourceKey === null || physicalProjectDir === null) {
    fail("invalid-store", `${scope} owner resource fields are incomplete`);
  } else if (projectResourceKey !== projectResourceKeyForOwner(physicalProjectDir)) {
    fail("invalid-store", `${scope} owner projectResourceKey does not derive from physicalProjectDir`);
  }
  return Object.freeze({
    pid: object.pid as number,
    processIdentity,
    token,
    createdAt,
    mode,
    scope,
    runId,
    attemptId,
    resourceKey,
    projectResourceKey,
    physicalProjectDir,
  });
}

function projectResourceKeyForOwner(physicalProjectDir: string): Sha256 {
  try { return projectResourceKey(physicalProjectDir); } catch (error) {
    fail("invalid-store", `owner physical project resource key cannot be derived: ${errorText(error)}`, error);
  }
}

function parseExternalPhase(value: unknown): "complete" | ExternalPhaseV1 {
  const phases = new Set<string>([
    "complete", "fleet-build", "scaffold", "compiler", "generator", "native-build", "install",
    "asset-delivery", "launch", "capture", "receipt-publication", "visual-judge", "mouse-bridge",
    "panel-launch", "panel-probe", "panel-capture", "acceptance-logcat", "acceptance-structural",
    "acceptance-perf", "structural-ledger", "replan",
  ]);
  if (typeof value !== "string" || !phases.has(value)) fail("invalid-store", "public completion marker phase is invalid");
  return value as "complete" | ExternalPhaseV1;
}

function parseStartedMarker(value: unknown): PublicFleetExecutionMarkerV1 {
  const keys = [
    "kind", "schemaVersion", "createdAt", "applicationOwnerToken", "projectOwnerToken", "attemptId",
    "resourceKey", "projectResourceKey", "physicalProjectDir", "briefPayloadSha256", "inputMode",
    "externalInputSha256",
  ] as const;
  const object = exactRecord(value, keys, "public execution marker");
  if (object.kind !== "pico.public-fleet-execution-started" || object.schemaVersion !== 1) {
    fail("invalid-store", "public execution marker identity is invalid");
  }
  const inputMode = object.inputMode;
  if (inputMode !== "sealed" && inputMode !== "legacy-mutable") fail("invalid-store", "public execution marker inputMode is invalid");
  const externalInputSha256 = object.externalInputSha256 === null ? null
    : validateSha(object.externalInputSha256, "public execution externalInputSha256");
  if ((inputMode === "sealed") !== (externalInputSha256 !== null)) fail("invalid-store", "public execution marker input binding is invalid");
  return Object.freeze({
    kind: "pico.public-fleet-execution-started",
    schemaVersion: 1,
    createdAt: validateTimestamp(object.createdAt, "public execution createdAt"),
    applicationOwnerToken: validateUuid(object.applicationOwnerToken, "application owner token"),
    projectOwnerToken: validateUuid(object.projectOwnerToken, "project owner token"),
    attemptId: validateUuid(object.attemptId, "public execution attemptId"),
    resourceKey: validateSha(object.resourceKey, "public execution resourceKey"),
    projectResourceKey: validateSha(object.projectResourceKey, "public execution projectResourceKey"),
    physicalProjectDir: validateAbsolutePath(object.physicalProjectDir, "public execution physicalProjectDir"),
    briefPayloadSha256: validateSha(object.briefPayloadSha256, "public execution briefPayloadSha256"),
    inputMode,
    externalInputSha256,
  });
}

function parseCompletionMarker(value: unknown): PublicFleetCompletionMarkerV1 {
  const keys = [
    "kind", "schemaVersion", "completedAt", "applicationOwnerToken", "projectOwnerToken", "attemptId",
    "resourceKey", "projectResourceKey", "physicalProjectDir", "briefPayloadSha256", "inputMode",
    "externalInputSha256", "executionDisposition", "phase", "externalMutationDisposition", "resultSha256",
  ] as const;
  const object = exactRecord(value, keys, "public completion marker");
  if (object.kind !== "pico.public-fleet-execution-completed" || object.schemaVersion !== 1
    || object.executionDisposition !== "definitely-completed") {
    fail("invalid-store", "public completion marker identity is invalid");
  }
  const inputMode = object.inputMode;
  if (inputMode !== "sealed" && inputMode !== "legacy-mutable") fail("invalid-store", "public completion marker inputMode is invalid");
  const externalInputSha256 = object.externalInputSha256 === null ? null
    : validateSha(object.externalInputSha256, "public completion externalInputSha256");
  if ((inputMode === "sealed") !== (externalInputSha256 !== null)) fail("invalid-store", "public completion marker input binding is invalid");
  if (object.externalMutationDisposition !== "none" && object.externalMutationDisposition !== "possible"
    && object.externalMutationDisposition !== "confirmed") {
    fail("invalid-store", "public completion externalMutationDisposition is invalid");
  }
  return Object.freeze({
    kind: "pico.public-fleet-execution-completed",
    schemaVersion: 1,
    completedAt: validateTimestamp(object.completedAt, "public completion completedAt"),
    applicationOwnerToken: validateUuid(object.applicationOwnerToken, "application owner token"),
    projectOwnerToken: validateUuid(object.projectOwnerToken, "project owner token"),
    attemptId: validateUuid(object.attemptId, "public completion attemptId"),
    resourceKey: validateSha(object.resourceKey, "public completion resourceKey"),
    projectResourceKey: validateSha(object.projectResourceKey, "public completion projectResourceKey"),
    physicalProjectDir: validateAbsolutePath(object.physicalProjectDir, "public completion physicalProjectDir"),
    briefPayloadSha256: validateSha(object.briefPayloadSha256, "public completion briefPayloadSha256"),
    inputMode,
    externalInputSha256,
    executionDisposition: "definitely-completed",
    phase: parseExternalPhase(object.phase),
    externalMutationDisposition: object.externalMutationDisposition,
    resultSha256: validateSha(object.resultSha256, "public completion resultSha256"),
  });
}

function parseElectionRecord(value: unknown): ElectionRecordV1 {
  const keys = [
    "kind", "schemaVersion", "pid", "processIdentity", "token", "createdAt", "scope", "ownerToken", "lockPath",
  ] as const;
  const object = exactRecord(value, keys, "recovery election record");
  if (object.kind !== "pico.run-owner-recovery-election" || object.schemaVersion !== 1
    || !Number.isSafeInteger(object.pid) || (object.pid as number) <= 0
    || (object.scope !== "run" && object.scope !== "application" && object.scope !== "project")) {
    fail("invalid-store", "recovery election record identity is invalid");
  }
  return Object.freeze({
    kind: "pico.run-owner-recovery-election",
    schemaVersion: 1,
    pid: object.pid as number,
    processIdentity: strictProcessIdentity(object.processIdentity, "election processIdentity"),
    token: validateUuid(object.token, "election token"),
    createdAt: validateTimestamp(object.createdAt, "election createdAt"),
    scope: object.scope,
    ownerToken: validateUuid(object.ownerToken, "election ownerToken"),
    lockPath: validateAbsolutePath(object.lockPath, "election lockPath"),
  });
}

function parseCapacityEnrollmentRecord(value: unknown): CapacityEnrollmentRecordV1 {
  const object = exactRecord(
    value,
    ["kind", "schemaVersion", "pid", "processIdentity", "token", "createdAt"] as const,
    "capacity enrollment record",
  );
  if (object.kind !== "pico.run-lock-capacity-enrollment" || object.schemaVersion !== 1
    || !Number.isSafeInteger(object.pid) || (object.pid as number) <= 0) {
    fail("invalid-store", "capacity enrollment record identity is invalid");
  }
  return Object.freeze({
    kind: "pico.run-lock-capacity-enrollment",
    schemaVersion: 1,
    pid: object.pid as number,
    processIdentity: strictProcessIdentity(object.processIdentity, "capacity enrollment processIdentity"),
    token: validateUuid(object.token, "capacity enrollment token"),
    createdAt: validateTimestamp(object.createdAt, "capacity enrollment createdAt"),
  });
}

type OwnerDirectoryObservation = Readonly<{
  record: RunOwnerRecordV1;
  canonical: string;
  started: PublicFleetExecutionMarkerV1 | null;
  completed: PublicFleetCompletionMarkerV1 | null;
}>;

function markerMatchesApplicationOwner(
  marker: PublicFleetExecutionMarkerV1 | PublicFleetCompletionMarkerV1,
  record: RunOwnerRecordV1,
): boolean {
  return record.scope === "application" && record.runId === null && record.attemptId !== null
    && marker.applicationOwnerToken === record.token
    && marker.attemptId === record.attemptId
    && marker.resourceKey === record.resourceKey
    && marker.projectResourceKey === record.projectResourceKey
    && marker.physicalProjectDir === record.physicalProjectDir;
}

function completionMatchesStarted(
  completed: PublicFleetCompletionMarkerV1,
  started: PublicFleetExecutionMarkerV1,
): boolean {
  return completed.applicationOwnerToken === started.applicationOwnerToken
    && completed.projectOwnerToken === started.projectOwnerToken
    && completed.attemptId === started.attemptId
    && completed.resourceKey === started.resourceKey
    && completed.projectResourceKey === started.projectResourceKey
    && completed.physicalProjectDir === started.physicalProjectDir
    && completed.briefPayloadSha256 === started.briefPayloadSha256
    && completed.inputMode === started.inputMode
    && completed.externalInputSha256 === started.externalInputSha256;
}

function readOwnerDirectory(directory: string): OwnerDirectoryObservation {
  const names = directoryNamesBounded(directory, `owner directory '${directory}'`);
  const ownerNames = names.filter((name) => name.endsWith(".owner.json"));
  if (ownerNames.length !== 1) fail("invalid-store", `owner directory '${directory}' does not contain exactly one owner record`);
  const leaf = readCanonicalLeaf(path.join(directory, ownerNames[0]));
  const record = parseOwnerRecord(leaf.raw);
  if (ownerNames[0] !== `${record.token}.owner.json` || canonicalJson(record) !== leaf.canonical) {
    fail("invalid-store", `owner directory '${directory}' filename or canonical projection is invalid`);
  }
  const allowed = new Set<string>([ownerNames[0]]);
  if (record.scope === "application" && record.runId === null) {
    allowed.add("EXECUTION_STARTED.json");
    allowed.add("EXECUTION_COMPLETED.json");
    if (record.attemptId !== null) {
      allowed.add(`.EXECUTION_STARTED.${record.token}.${record.attemptId}.staging`);
      allowed.add(`.EXECUTION_COMPLETED.${record.token}.${record.attemptId}.staging`);
    }
  }
  let started: PublicFleetExecutionMarkerV1 | null = null;
  let completed: PublicFleetCompletionMarkerV1 | null = null;
  for (const name of names) {
    if (!allowed.has(name)) fail("invalid-store", `owner directory '${directory}' contains unknown entry '${name}'`);
    if (name === "EXECUTION_STARTED.json") {
      const marker = readCanonicalLeaf(path.join(directory, name));
      started = parseStartedMarker(marker.raw);
      if (canonicalJson(started) !== marker.canonical || !markerMatchesApplicationOwner(started, record)) {
        fail("invalid-store", "started marker projection or application-owner binding is invalid");
      }
    } else if (name === "EXECUTION_COMPLETED.json") {
      const marker = readCanonicalLeaf(path.join(directory, name));
      completed = parseCompletionMarker(marker.raw);
      if (canonicalJson(completed) !== marker.canonical || !markerMatchesApplicationOwner(completed, record)) {
        fail("invalid-store", "completion marker projection or application-owner binding is invalid");
      }
    } else if (name.endsWith(".staging")) {
      readCanonicalLeaf(path.join(directory, name));
    }
  }
  if (completed !== null && (started === null || !completionMatchesStarted(completed, started))) {
    fail("invalid-store", "completion marker lacks its exact matching started marker");
  }
  return { record, canonical: leaf.canonical, started, completed };
}

function readElectionDirectory(directory: string): { record: ElectionRecordV1; canonical: string } {
  const names = directoryNamesBounded(directory, `recovery election '${directory}'`);
  const electionNames = names.filter((name) => name.endsWith(".election.json"));
  if (names.length !== 1 || electionNames.length !== 1) fail("invalid-store", `recovery election '${directory}' has invalid entries`);
  const leaf = readCanonicalLeaf(path.join(directory, electionNames[0]));
  const record = parseElectionRecord(leaf.raw);
  if (electionNames[0] !== `${record.token}.election.json` || canonicalJson(record) !== leaf.canonical) {
    fail("invalid-store", `recovery election '${directory}' filename or canonical projection is invalid`);
  }
  return { record, canonical: leaf.canonical };
}

function capacityEnrollmentDirectory(rootDir: string): string {
  return path.join(rootDir, "locks", "capacity-enrollment");
}

function capacityEnrollmentPath(rootDir: string): string {
  return path.join(capacityEnrollmentDirectory(rootDir), "ACTIVE.json");
}

function capacityEnrollmentStagingDirectory(rootDir: string): string {
  return path.join(rootDir, "locks", "capacity-enrollment-staging");
}

function capacityEnrollmentStagingPath(rootDir: string): string {
  return path.join(capacityEnrollmentStagingDirectory(rootDir), "STAGING.json");
}

function readCapacityEnrollment(
  filePath: string,
  allowedLinks: readonly bigint[] = [1n],
): CapacityEnrollmentLease {
  const leaf = readCanonicalLeaf(filePath, MAX_OWNER_BYTES, allowedLinks);
  const record = parseCapacityEnrollmentRecord(leaf.raw);
  if (canonicalJson(record) !== leaf.canonical) fail("invalid-store", "capacity enrollment is not its strict canonical projection");
  return Object.freeze({ path: filePath, record, canonical: leaf.canonical });
}

function unlinkExactCapacityStaging(staging: string, selected: fs.BigIntStats): void {
  let current: fs.BigIntStats;
  try { current = fs.lstatSync(staging, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (current.dev !== selected.dev || current.ino !== selected.ino) {
    fail("invalid-store", "capacity enrollment staging was replaced before cleanup");
  }
  fs.unlinkSync(staging);
  fsyncDirectory(path.dirname(staging));
}

function recoverCapacityEnrollmentStaging(rootDir: string, deps: RunLockDependenciesV1): void {
  const directory = capacityEnrollmentStagingDirectory(rootDir);
  const names = directoryNamesBounded(
    directory,
    "capacity enrollment staging namespace",
    MAX_CAPACITY_STAGING_ENTRIES,
  );
  if (names.length === 0) return;
  if (names.length !== 1 || names[0] !== "STAGING.json") {
    fail("invalid-store", "capacity enrollment staging namespace has an unknown entry");
  }
  const staging = capacityEnrollmentStagingPath(rootDir);
  let selected: fs.BigIntStats;
  try { selected = fs.lstatSync(staging, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!selected.isFile() || selected.isSymbolicLink() || (selected.nlink !== 1n && selected.nlink !== 2n)
    || selected.size > BigInt(MAX_OWNER_BYTES + 1)) {
    fail("invalid-store", "capacity enrollment staging leaf is unsafe");
  }

  if (selected.nlink === 2n) {
    const activePath = capacityEnrollmentPath(rootDir);
    let active: fs.BigIntStats;
    try { active = fs.lstatSync(activePath, { bigint: true }); } catch (error) {
      fail("invalid-store", `capacity enrollment staging alias lacks its active target: ${errorText(error)}`, error);
    }
    if (!active.isFile() || active.isSymbolicLink() || active.dev !== selected.dev || active.ino !== selected.ino) {
      fail("invalid-store", "capacity enrollment staging alias does not name ACTIVE.json");
    }
    const lease = readCapacityEnrollment(staging, [2n]);
    if (processIdentityIsLive(lease.record.pid, lease.record.processIdentity, deps)) {
      fail("run-busy", "a live capacity enrollment is completing atomic publication");
    }
    unlinkExactCapacityStaging(staging, selected);
    fsyncDirectory(capacityEnrollmentDirectory(rootDir));
    return;
  }

  if (selected.size > 0n) {
    try {
      const lease = readCapacityEnrollment(staging);
      if (processIdentityIsLive(lease.record.pid, lease.record.processIdentity, deps)) {
        fail("run-busy", "a live capacity enrollment still owns its unpublished staging leaf");
      }
    } catch (error) {
      if (error instanceof RunLockError && error.status === "run-busy") throw error;
      // An unlinked zero/partial/malformed staging leaf is never authority. Removing the
      // selected inode makes any concurrent publisher fail its own link/confirmation path.
    }
  }
  unlinkExactCapacityStaging(staging, selected);
}

function scanCapacityEnrollments(rootDir: string): Readonly<{
  active: CapacityEnrollmentLease | null;
  residues: readonly CapacityEnrollmentLease[];
}> {
  const directory = capacityEnrollmentDirectory(rootDir);
  const names = directoryNamesBounded(directory, "capacity enrollment namespace", MAX_CAPACITY_ENTRIES);
  let active: CapacityEnrollmentLease | null = null;
  const residues: CapacityEnrollmentLease[] = [];
  const tokens = new Set<string>();
  const residuePattern = new RegExp(`^ACTIVE\\.released\\.(${SHA256.source.slice(1, -1)})\\.(${UUID_V4.source.slice(1, -1)})\\.json$`);
  for (const name of names) {
    const filePath = path.join(directory, name);
    if (name === "ACTIVE.json") {
      if (active !== null) fail("invalid-store", "capacity enrollment namespace has duplicate active records");
      try { active = readCapacityEnrollment(filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("run-busy", "capacity enrollment changed during scan", error);
        throw error;
      }
      continue;
    }
    const match = residuePattern.exec(name);
    if (match === null) fail("invalid-store", `capacity enrollment namespace contains unknown entry '${name}'`);
    let residue: CapacityEnrollmentLease;
    try { residue = readCapacityEnrollment(filePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("run-busy", "capacity enrollment residue changed during scan", error);
      throw error;
    }
    if (shaToken(residue.record.token) !== match[1]) fail("invalid-store", "capacity enrollment residue name disagrees with its token");
    if (tokens.has(residue.record.token)) fail("invalid-store", "capacity enrollment namespace has duplicate token residue");
    tokens.add(residue.record.token);
    residues.push(residue);
  }
  if (active !== null && tokens.has(active.record.token)) fail("invalid-store", "active capacity enrollment also has a residue");
  return Object.freeze({ active, residues: Object.freeze(residues) });
}

function assertCapacityEnrollmentCurrent(
  lease: CapacityEnrollmentLease,
  deps: RunLockDependenciesV1,
): CapacityEnrollmentLease {
  if (deps.pid !== lease.record.pid) fail("state-write-failed", "capacity enrollment pid no longer names the current process");
  let identity: string;
  try { identity = strictProcessIdentity(deps.processIdentity(), "capacity enrollment current processIdentity"); } catch (error) {
    fail("state-write-failed", `capacity enrollment identity probe failed: ${errorText(error)}`, error);
  }
  if (identity !== lease.record.processIdentity) fail("state-write-failed", "capacity enrollment process identity drifted");
  const current = readCapacityEnrollment(lease.path);
  if (current.canonical !== lease.canonical || current.record.token !== lease.record.token) {
    fail("invalid-store", "capacity enrollment token fence no longer names the current generation");
  }
  return current;
}

function releaseCapacityEnrollment(
  lease: CapacityEnrollmentLease,
  deps: RunLockDependenciesV1,
  currentProcess: boolean,
): void {
  if (currentProcess) {
    assertCapacityEnrollmentCurrent(lease, deps);
  } else if (processIdentityIsLive(lease.record.pid, lease.record.processIdentity, deps)) {
    fail("run-busy", "a live capacity enrollment cannot be reaped");
  }
  const current = readCapacityEnrollment(lease.path);
  if (current.canonical !== lease.canonical || current.record.token !== lease.record.token) {
    fail("invalid-store", "capacity enrollment changed before token-specific release");
  }
  const cleanupToken = checkedUuid(deps, "capacity enrollment cleanup token");
  const target = path.join(
    path.dirname(lease.path),
    `ACTIVE.released.${shaToken(lease.record.token)}.${cleanupToken}.json`,
  );
  if (fs.existsSync(target)) fail("invalid-store", "capacity enrollment cleanup target collides");
  if (readCapacityEnrollment(lease.path).canonical !== lease.canonical) {
    fail("invalid-store", "capacity enrollment changed immediately before release");
  }
  try { fs.renameSync(lease.path, target); } catch (error) {
    fail("state-write-failed", `capacity enrollment release failed: ${errorText(error)}`, error);
  }
  fsyncDirectory(path.dirname(lease.path));
  const moved = readCapacityEnrollment(target);
  if (moved.canonical !== lease.canonical) {
    let restored = false;
    try {
      if (!fs.existsSync(lease.path)) {
        fs.renameSync(target, lease.path);
        fsyncDirectory(path.dirname(lease.path));
        restored = true;
      }
    } catch {}
    if (!restored) {
      try {
        const replacement = readCapacityEnrollment(target);
        if (replacement.canonical === moved.canonical) {
          fs.unlinkSync(target);
          fsyncDirectory(path.dirname(target));
        }
      } catch {}
    }
    fail("invalid-store", "capacity enrollment release captured a replacement generation");
  }
  try {
    fs.unlinkSync(target);
    fsyncDirectory(path.dirname(lease.path));
  } catch (error) {
    fail("state-write-failed", `capacity enrollment residue cleanup failed: ${errorText(error)}`, error);
  }
}

function tryCreateCapacityEnrollment(
  rootDir: string,
  deps: RunLockDependenciesV1,
  identity: string,
): CapacityEnrollmentLease | null {
  recoverCapacityEnrollmentStaging(rootDir, deps);
  const observed = scanCapacityEnrollments(rootDir);
  if (observed.active !== null) return null;
  if (observed.residues.length >= MAX_CAPACITY_ENTRIES) {
    fail("limit-exceeded", "capacity enrollment namespace has no safe active slot");
  }
  const target = capacityEnrollmentPath(rootDir);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let targetDescriptor: number | undefined;
  try {
    targetDescriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("invalid-store", `capacity enrollment target absence cannot be proven: ${errorText(error)}`, error);
    }
  } finally {
    if (targetDescriptor !== undefined) fs.closeSync(targetDescriptor);
  }
  const record: CapacityEnrollmentRecordV1 = Object.freeze({
    kind: "pico.run-lock-capacity-enrollment",
    schemaVersion: 1,
    pid: deps.pid,
    processIdentity: identity,
    token: checkedUuid(deps, "capacity enrollment token"),
    createdAt: checkedNow(deps),
  });
  if (observed.residues.some((residue) => residue.record.token === record.token)
    || scanLockNamespaces(rootDir).residueTokens.has(record.token)) {
    fail("invalid-store", "fresh capacity enrollment token collides with a recognized residue generation");
  }
  const canonical = canonicalJson(record);
  const bytes = Buffer.from(`${canonical}\n`, "utf8");
  const staging = capacityEnrollmentStagingPath(rootDir);
  let descriptor: number | undefined;
  let opened: fs.BigIntStats | null = null;
  let linked = false;
  try {
    descriptor = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    opened = fs.fstatSync(descriptor, { bigint: true });
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const staged = readCapacityEnrollment(staging);
    if (staged.canonical !== canonical) fail("state-write-failed", "capacity enrollment staging changed before publication");
    const decisive = scanCapacityEnrollments(rootDir);
    if (decisive.active !== null) return null;
    if (decisive.residues.length >= MAX_CAPACITY_ENTRIES) {
      fail("limit-exceeded", "capacity enrollment namespace has no safe active slot");
    }
    if (decisive.residues.some((residue) => residue.record.token === record.token)
      || scanLockNamespaces(rootDir).residueTokens.has(record.token)) {
      fail("invalid-store", "fresh capacity enrollment token collides with a recognized residue generation");
    }
    try {
      fs.linkSync(staging, target);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    fs.unlinkSync(staging);
    fsyncDirectory(path.dirname(staging));
    fsyncDirectory(path.dirname(target));
    const lease = readCapacityEnrollment(target);
    if (lease.canonical !== canonical) fail("state-write-failed", "capacity enrollment changed during publication");
    return lease;
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    if (!linked && opened !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
      // A concurrent recovery pass may remove the selected staging inode while this
      // publisher is still completing it. That inode never became authority; retry
      // enrollment instead of surfacing a write failure to a legitimate contender.
      return null;
    }
    if (opened !== null) {
      try {
        const current = fs.lstatSync(staging, { bigint: true });
        if (current.dev === opened.dev && current.ino === opened.ino) {
          fs.unlinkSync(staging);
          fsyncDirectory(path.dirname(staging));
        }
      } catch {}
    }
    if (linked) {
      try {
        const current = readCapacityEnrollment(target);
        if (current.canonical !== canonical) fail("invalid-store", "capacity enrollment target was replaced after link");
      } catch (confirmationError) {
        if (confirmationError instanceof RunLockError) throw confirmationError;
      }
    }
    if (error instanceof RunLockError) throw error;
    return fail("state-write-failed", `capacity enrollment publication failed: ${errorText(error)}`, error);
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    if (opened !== null) {
      try {
        const current = fs.lstatSync(staging, { bigint: true });
        if (current.dev === opened.dev && current.ino === opened.ino) {
          fs.unlinkSync(staging);
          fsyncDirectory(path.dirname(staging));
        }
      } catch {}
    }
  }
}

function acquireCapacityEnrollment(
  rootDir: string,
  deps: RunLockDependenciesV1,
  identity: string,
  deadline: number,
): CapacityEnrollmentLease {
  for (;;) {
    let observed: ReturnType<typeof scanCapacityEnrollments>;
    try {
      recoverCapacityEnrollmentStaging(rootDir, deps);
      observed = scanCapacityEnrollments(rootDir);
    } catch (error) {
      if (!(error instanceof RunLockError) || error.status !== "run-busy") throw error;
      let now: number;
      try { now = deps.monotonicMs(); } catch (clockError) {
        fail("state-write-failed", `capacity enrollment monotonic clock failed: ${errorText(clockError)}`, clockError);
      }
      if (!Number.isFinite(now)) fail("state-write-failed", "capacity enrollment monotonic clock returned a nonfinite value");
      if (now >= deadline) throw error;
      Atomics.wait(WAIT_WORD, 0, 0, Math.max(1, Math.min(8, deadline - now)));
      continue;
    }
    if (observed.active === null) {
      let created: CapacityEnrollmentLease | null;
      try { created = tryCreateCapacityEnrollment(rootDir, deps, identity); } catch (error) {
        if (!(error instanceof RunLockError) || error.status !== "run-busy") throw error;
        continue;
      }
      if (created !== null) return created;
      continue;
    }
    if (!processIdentityIsLive(observed.active.record.pid, observed.active.record.processIdentity, deps)) {
      releaseCapacityEnrollment(observed.active, deps, false);
      continue;
    }
    let now: number;
    try { now = deps.monotonicMs(); } catch (error) {
      fail("state-write-failed", `capacity enrollment monotonic clock failed: ${errorText(error)}`, error);
    }
    if (!Number.isFinite(now)) fail("state-write-failed", "capacity enrollment monotonic clock returned a nonfinite value");
    if (now >= deadline) fail("run-busy", "shared acquisition budget expired behind a live capacity enrollment");
    Atomics.wait(WAIT_WORD, 0, 0, Math.max(1, Math.min(8, deadline - now)));
  }
}

function validateOwnerPath(rootDir: string, directory: string, record: RunOwnerRecordV1): void {
  const expected = recordLockPath(rootDir, record);
  if (directory !== expected) fail("invalid-store", `owner scope/key does not derive lock path '${directory}'`);
}

function namespaceBasePattern(scope: Scope): string {
  return scope === "run" ? "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}" : "[a-f0-9]{64}";
}

type NamespaceObservation = Readonly<{
  kind: "owner-active" | "owner-residue" | "other";
  capacityClass: "owner-evidence" | "recovery-election";
  generation: string | null;
  record: RunOwnerRecordV1 | null;
  residueToken: LowercaseUuidV4 | null;
}>;

function validateNamespaceEntry(rootDir: string, scope: Scope, namespace: string, name: string): NamespaceObservation {
  const basePattern = namespaceBasePattern(scope);
  const active = new RegExp(`^(${basePattern})\\.lock$`).exec(name);
  const claim = new RegExp(`^(${basePattern})\\.lock\\.claim\\.(${DECIMAL_PID.source.slice(1, -1)})\\.(${UUID_V4.source.slice(1, -1)})$`).exec(name);
  const released = new RegExp(`^(${basePattern})\\.lock\\.released\\.(${SHA256.source.slice(1, -1)})\\.(${UUID_V4.source.slice(1, -1)})$`).exec(name);
  const recovery = new RegExp(`^(${basePattern})\\.lock\\.recover\\.(${SHA256.source.slice(1, -1)})$`).exec(name);
  const recoveryClaim = new RegExp(`^(${basePattern})\\.lock\\.recover\\.(${SHA256.source.slice(1, -1)})\\.claim\\.(${DECIMAL_PID.source.slice(1, -1)})\\.(${UUID_V4.source.slice(1, -1)})$`).exec(name);
  const recoveryReleased = new RegExp(`^(${basePattern})\\.lock\\.recover\\.(${SHA256.source.slice(1, -1)})\\.released\\.(${SHA256.source.slice(1, -1)})\\.(${UUID_V4.source.slice(1, -1)})$`).exec(name);
  const directory = path.join(namespace, name);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid-store", `lock namespace entry '${directory}' is unsafe`);
  if (active !== null || claim !== null || released !== null) {
    const { record } = readOwnerDirectory(directory);
    if (record.scope !== scope) fail("invalid-store", `owner scope disagrees with namespace '${scope}'`);
    const key = active?.[1] ?? claim?.[1] ?? released?.[1];
    if (scopeKey(record) !== key) fail("invalid-store", `owner key disagrees with namespace entry '${name}'`);
    if (claim !== null && (String(record.pid) !== claim[2] || record.token !== claim[3])) fail("invalid-store", `owner claim name disagrees with its record`);
    if (released !== null && shaToken(record.token) !== released[2]) fail("invalid-store", `owner quarantine name disagrees with its token`);
    if (active !== null) validateOwnerPath(rootDir, directory, record);
    const generation = `${scope}\0${key}\0${record.token}`;
    return active !== null
      ? { kind: "owner-active", capacityClass: "owner-evidence", generation, record, residueToken: null }
      : released !== null
        ? { kind: "owner-residue", capacityClass: "owner-evidence", generation, record: null, residueToken: record.token }
        : { kind: "other", capacityClass: "owner-evidence", generation: null, record: null, residueToken: null };
  }
  if (recovery !== null || recoveryClaim !== null || recoveryReleased !== null) {
    const { record } = readElectionDirectory(directory);
    if (record.scope !== scope) fail("invalid-store", `election scope disagrees with namespace '${scope}'`);
    const key = recovery?.[1] ?? recoveryClaim?.[1] ?? recoveryReleased?.[1];
    const expectedLock = lockDirectory(rootDir, scope, key!);
    if (record.lockPath !== expectedLock) fail("invalid-store", `election lock path disagrees with namespace entry '${name}'`);
    const ownerDigest = recovery?.[2] ?? recoveryClaim?.[2] ?? recoveryReleased?.[2];
    if (shaToken(record.ownerToken) !== ownerDigest) fail("invalid-store", `election owner digest disagrees with namespace entry '${name}'`);
    if (recoveryClaim !== null && (String(record.pid) !== recoveryClaim[3] || record.token !== recoveryClaim[4])) {
      fail("invalid-store", `election claim name disagrees with its record`);
    }
    if (recoveryReleased !== null && shaToken(record.token) !== recoveryReleased[3]) {
      fail("invalid-store", `election quarantine name disagrees with its token`);
    }
    return {
      kind: "other",
      capacityClass: "recovery-election",
      generation: null,
      record: null,
      residueToken: recoveryReleased === null ? null : record.token,
    };
  }
  fail("invalid-store", `unknown lock namespace entry '${name}'`);
}

function ensureLockLayout(rootDir: string): void {
  ensureNoFollowDirectory(rootDir);
  ensureNoFollowDirectory(path.join(rootDir, "locks"));
  ensureNoFollowDirectory(capacityEnrollmentDirectory(rootDir));
  ensureNoFollowDirectory(capacityEnrollmentStagingDirectory(rootDir));
  for (const scope of ["run", "application", "project"] as const) {
    ensureNoFollowDirectory(path.join(rootDir, "locks", scope));
  }
}

function scanLockNamespaces(
  rootDir: string,
  prospective: Readonly<{
    scope: Scope;
    capacityClass: "owner-evidence" | "recovery-election";
    entries: number;
    token?: LowercaseUuidV4;
  }> | null = null,
): Readonly<{
  counts: Readonly<Record<Scope, number>>;
  activeOwners: readonly RunOwnerRecordV1[];
  residueTokens: ReadonlySet<LowercaseUuidV4>;
}> {
  let aggregate = 0;
  let recoveryElectionAggregate = 0;
  const counts: Record<Scope, number> = { run: 0, application: 0, project: 0 };
  const recoveryElectionCounts: Record<Scope, number> = { run: 0, application: 0, project: 0 };
  const active = new Set<string>();
  const activeOwners: RunOwnerRecordV1[] = [];
  const residues = new Map<string, number>();
  const residueTokens = new Set<LowercaseUuidV4>();
  for (const scope of ["run", "application", "project"] as const) {
    const namespace = path.join(rootDir, "locks", scope);
    const names = directoryNamesBounded(namespace, `${scope} lock namespace`, MAX_PHYSICAL_NAMESPACE_ENTRIES);
    for (const name of names) {
      const observed = validateNamespaceEntry(rootDir, scope, namespace, name);
      if (observed.capacityClass === "owner-evidence") {
        counts[scope] += 1;
        aggregate += 1;
        if (counts[scope] > MAX_NAMESPACE_ENTRIES) {
          fail("limit-exceeded", `${scope} owner/evidence namespace exceeds 4,096 entries`);
        }
        if (aggregate > MAX_COORDINATION_ENTRIES) {
          fail("limit-exceeded", "aggregate owner/evidence namespace exceeds 12,288 entries");
        }
      } else {
        recoveryElectionCounts[scope] += 1;
        recoveryElectionAggregate += 1;
        if (recoveryElectionCounts[scope] > MAX_RECOVERY_ELECTION_ENTRIES) {
          fail("limit-exceeded", `${scope} recovery-election namespace exceeds 4,096 entries`);
        }
        if (recoveryElectionAggregate > MAX_AGGREGATE_RECOVERY_ELECTION_ENTRIES) {
          fail("limit-exceeded", "aggregate recovery-election namespace exceeds 12,288 entries");
        }
      }
      if (observed.residueToken !== null) residueTokens.add(observed.residueToken);
      if (observed.generation === null) continue;
      if (observed.kind === "owner-active") {
        active.add(observed.generation);
        activeOwners.push(observed.record!);
      }
      if (observed.kind === "owner-residue") residues.set(observed.generation, (residues.get(observed.generation) ?? 0) + 1);
    }
  }
  for (const [generation, count] of residues) {
    if (count !== 1 || active.has(generation)) fail("invalid-store", "duplicate or active-generation owner quarantine is unexpected");
  }
  if (prospective !== null) {
    if (!Number.isSafeInteger(prospective.entries) || prospective.entries <= 0) fail("state-write-failed", "invalid internal prospective namespace charge");
    if (prospective.capacityClass === "owner-evidence") {
      if (counts[prospective.scope] + prospective.entries > MAX_NAMESPACE_ENTRIES
        || aggregate + prospective.entries > MAX_COORDINATION_ENTRIES) {
        fail("limit-exceeded", "owner/evidence namespace capacity is exhausted before prospective publication");
      }
    } else if (recoveryElectionCounts[prospective.scope] + prospective.entries > MAX_RECOVERY_ELECTION_ENTRIES
        || recoveryElectionAggregate + prospective.entries > MAX_AGGREGATE_RECOVERY_ELECTION_ENTRIES) {
      fail("limit-exceeded", "recovery-election namespace capacity is exhausted before prospective publication");
    }
    if (prospective.token !== undefined && residueTokens.has(prospective.token)) {
      fail("invalid-store", "fresh lock token collides with a recognized owner/election residue generation");
    }
  }
  return Object.freeze({
    counts: Object.freeze(counts),
    activeOwners: Object.freeze(activeOwners),
    residueTokens,
  });
}

function checkedDependencies(deps: RunLockDependenciesV1): { rootDir: string; identity: string } {
  if (deps === null || typeof deps !== "object" || !Number.isSafeInteger(deps.pid) || deps.pid <= 0
    || typeof deps.processIdentity !== "function" || typeof deps.isProcessIdentityLive !== "function"
    || typeof deps.monotonicMs !== "function" || typeof deps.nowUtc !== "function" || typeof deps.uuid !== "function") {
    fail("state-write-failed", "run lock dependencies are incomplete");
  }
  const rootDir = validateAbsolutePath(path.resolve(deps.rootDir), "run lock rootDir");
  let identity: string;
  try { identity = strictProcessIdentity(deps.processIdentity(), "current process identity"); } catch (error) {
    if (error instanceof RunLockError) fail("state-write-failed", error.message, error);
    fail("state-write-failed", `current process identity probe failed: ${errorText(error)}`, error);
  }
  return { rootDir, identity };
}

function checkedUuid(deps: RunLockDependenciesV1, label: string): LowercaseUuidV4 {
  try { return validateUuid(deps.uuid(), label); } catch (error) {
    if (error instanceof RunLockError) fail("state-write-failed", error.message, error);
    fail("state-write-failed", `${label} generation failed: ${errorText(error)}`, error);
  }
}

function checkedNow(deps: RunLockDependenciesV1): CanonicalUtcTimestamp {
  try { return validateTimestamp(deps.nowUtc(), "owner createdAt"); } catch (error) {
    if (error instanceof RunLockError) fail("state-write-failed", error.message, error);
    fail("state-write-failed", `owner timestamp generation failed: ${errorText(error)}`, error);
  }
}

function checkedInput(
  input: RunOwnerAcquireInputV1 | PublicFleetOwnerAcquireInputV1,
  publicFleet: boolean,
): { input: RunOwnerAcquireInputV1 | PublicFleetOwnerAcquireInputV1; physicalProjectDir: string } {
  if (input === null || typeof input !== "object") fail("invalid-store", "run owner input is not an object");
  if (publicFleet) {
    if (input.runId !== null || input.mode !== "execution" || input.attemptId === null) {
      fail("invalid-store", "public Fleet owner input must use nullable-run execution form");
    }
  } else {
    if (input.runId === null) fail("invalid-store", "run owner input requires a runId");
    validateUuid(input.runId, "run owner input runId");
    if ((input.mode === "coordination") !== (input.attemptId === null)) {
      fail("invalid-store", "run owner input mode/attempt fields disagree");
    }
  }
  if (input.mode !== "coordination" && input.mode !== "execution") fail("invalid-store", "run owner input mode is invalid");
  if (input.attemptId !== null) validateUuid(input.attemptId, "run owner input attemptId");
  validateSha(input.resourceKey, "run owner input resourceKey");
  validateSha(input.projectResourceKey, "run owner input projectResourceKey");
  if (typeof input.deadlineMonotonicMs !== "number" || Number.isNaN(input.deadlineMonotonicMs)) {
    fail("invalid-store", "run owner deadlineMonotonicMs must be a number");
  }
  let locator: ProjectLocatorV1;
  try { locator = revalidateProjectLocator(input.projectLocator); } catch (error) {
    const status = (error as { status?: string }).status;
    if (status === "limit-exceeded") fail("limit-exceeded", errorText(error), error);
    if (status === "target-conflict") fail("target-conflict", errorText(error), error);
    fail("external-state-conflict", `project locator failed revalidation: ${errorText(error)}`, error);
  }
  const expectedProjectKey = crypto.createHash("sha256").update(canonicalJson({
    kind: "pico.physical-project-resource",
    schemaVersion: 1,
    physicalProjectDir: locator.physicalProjectDir,
  })).digest("hex");
  if (input.projectResourceKey !== expectedProjectKey) fail("invalid-store", "run owner projectResourceKey disagrees with its locator");
  return { input, physicalProjectDir: locator.physicalProjectDir };
}

function makeOwnerRecord(
  scope: Scope,
  input: RunOwnerAcquireInputV1 | PublicFleetOwnerAcquireInputV1,
  physicalProjectDir: string,
  deps: RunLockDependenciesV1,
  identity: string,
): RunOwnerRecordV1 {
  const token = checkedUuid(deps, `${scope} owner token`);
  return Object.freeze({
    pid: deps.pid,
    processIdentity: identity,
    token,
    createdAt: checkedNow(deps),
    mode: input.mode,
    scope,
    runId: input.runId,
    attemptId: input.attemptId,
    resourceKey: scope === "run" ? null : input.resourceKey,
    projectResourceKey: scope === "run" ? null : input.projectResourceKey,
    physicalProjectDir: scope === "run" ? null : physicalProjectDir,
  });
}

function removeOwnedClaim(claim: string, record: RunOwnerRecordV1 | ElectionRecordV1, extension: "owner" | "election"): void {
  try {
    const parsed = extension === "owner" ? readOwnerDirectory(claim) : readElectionDirectory(claim);
    if (parsed.canonical !== canonicalJson(record)) return;
    const names = directoryNamesBounded(claim, `owned ${extension} claim '${claim}'`);
    for (const name of names) fs.unlinkSync(path.join(claim, name));
    fs.rmdirSync(claim);
    fsyncDirectory(path.dirname(claim));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function publishOwnedDirectory(
  target: string,
  record: RunOwnerRecordV1 | ElectionRecordV1,
  extension: "owner" | "election",
  assertFence: () => void,
  onCommitted: () => void,
): boolean {
  const namespace = path.dirname(target);
  const claim = `${target}.claim.${record.pid}.${record.token}`;
  const canonical = canonicalJson(record);
  const bytes = Buffer.from(`${canonical}\n`, "utf8");
  let descriptor: number | undefined;
  try {
    assertFence();
    fs.mkdirSync(claim, { mode: 0o700 });
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const filePath = path.join(claim, `${record.token}.${extension}.json`);
    descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(claim);
    const parsed = extension === "owner" ? readOwnerDirectory(claim) : readElectionDirectory(claim);
    if (parsed.canonical !== canonical) fail("state-write-failed", `${extension} claim bytes changed before publication`);
    assertFence();
    try {
      fs.renameSync(claim, target);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
    onCommitted();
    fsyncDirectory(namespace);
    const published = extension === "owner" ? readOwnerDirectory(target) : readElectionDirectory(target);
    if (published.canonical !== canonical) fail("state-write-failed", `${extension} target changed after publication`);
    assertFence();
    return true;
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    if (error instanceof RunLockError) throw error;
    throw new RunLockError(
      "state-write-failed",
      `cannot publish ${extension} directory '${target}': ${errorText(error)}`,
      error,
    );
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    removeOwnedClaim(claim, record, extension);
  }
}

function processIdentityIsLive(pid: number, identity: string, deps: RunLockDependenciesV1): boolean {
  try { return deps.isProcessIdentityLive(pid, identity) === true; } catch (error) {
    fail("state-write-failed", `owner process identity probe failed: ${errorText(error)}`, error);
  }
}

function ownerIsLive(record: RunOwnerRecordV1, deps: RunLockDependenciesV1): boolean {
  return processIdentityIsLive(record.pid, record.processIdentity, deps);
}

function mintCapability<S extends Scope>(rootDir: string, lockPath: string, record: RunOwnerRecordV1 & { scope: S }): OwnerCapabilityV1<S> {
  const canonical = canonicalJson(record);
  const capability = Object.freeze({
    scope: record.scope,
    token: record.token,
    record,
    [ownerCapabilityBrand]: true as const,
  });
  const origin = Object.freeze({ rootDir, lockPath, canonical, record });
  OWNER_ORIGINS.set(capability, origin);
  return capability;
}

function assertCurrentIdentity(record: RunOwnerRecordV1, deps: RunLockDependenciesV1): void {
  if (deps.pid !== record.pid) fail("state-write-failed", "owner mutation pid does not equal the current process dependency");
  let identity: string;
  try { identity = strictProcessIdentity(deps.processIdentity(), "current process identity"); } catch (error) {
    fail("state-write-failed", `owner mutation process identity probe failed: ${errorText(error)}`, error);
  }
  if (identity !== record.processIdentity) fail("state-write-failed", "owner mutation process identity no longer matches its generation");
}

function assertCapabilityCurrent<S extends Scope>(
  capability: OwnerCapabilityV1<S>,
  deps: RunLockDependenciesV1,
): OwnerOrigin {
  const origin = OWNER_ORIGINS.get(capability);
  if (origin === undefined || capability[ownerCapabilityBrand] !== true
    || capability.scope !== origin.record.scope || capability.token !== origin.record.token
    || canonicalJson(capability.record) !== origin.canonical) {
    fail("state-write-failed", "owner capability brand or runtime origin is invalid");
  }
  if (path.resolve(deps.rootDir) !== origin.rootDir) fail("state-write-failed", "owner capability root does not match mutation dependencies");
  assertCurrentIdentity(origin.record, deps);
  const current = readOwnerDirectory(origin.lockPath);
  if (current.canonical !== origin.canonical || current.record.token !== origin.record.token) {
    fail("invalid-store", "owner capability no longer names the current exact owner generation");
  }
  validateOwnerPath(origin.rootDir, origin.lockPath, current.record);
  return origin;
}

function acquireOne<S extends Scope>(
  scope: S,
  input: RunOwnerAcquireInputV1 | PublicFleetOwnerAcquireInputV1,
  physicalProjectDir: string,
  deps: RunLockDependenciesV1,
  rootDir: string,
  identity: string,
  deadline: number,
): OwnerCapabilityV1<S> {
  const record = makeOwnerRecord(scope, input, physicalProjectDir, deps, identity) as RunOwnerRecordV1 & { scope: S };
  const target = recordLockPath(rootDir, record);
  for (;;) {
    let exists = false;
    try { fs.lstatSync(target); exists = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let published = false;
    if (exists) {
      scanLockNamespaces(rootDir);
    } else {
      const enrollment = acquireCapacityEnrollment(rootDir, deps, identity, deadline);
      let committed = false;
      let acquisitionError: unknown = null;
      try {
        assertCapacityEnrollmentCurrent(enrollment, deps);
        let appeared = false;
        try { fs.lstatSync(target); appeared = true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        scanLockNamespaces(rootDir, appeared ? null : {
          scope,
          capacityClass: "owner-evidence",
          entries: 1,
          token: record.token,
        });
        assertCapacityEnrollmentCurrent(enrollment, deps);
        if (!appeared) {
          published = publishOwnedDirectory(
            target,
            record,
            "owner",
            () => assertCapacityEnrollmentCurrent(enrollment, deps),
            () => { committed = true; },
          );
        }
      } catch (error) {
        acquisitionError = error;
      }
      try {
        releaseCapacityEnrollment(enrollment, deps, true);
      } catch (error) {
        if (acquisitionError === null) acquisitionError = error;
      }
      if (acquisitionError !== null) {
        if (committed) {
          try {
            quarantineCapability(mintCapability(rootDir, target, record), deps);
          } catch (cleanupError) {
            fail(
              "state-write-failed",
              `owner publication committed, later failed, and exact cleanup failed: ${errorText(cleanupError)}`,
              cleanupError,
            );
          }
        }
        throw acquisitionError;
      }
    }
    if (published) return mintCapability(rootDir, target, record);
    let occupied: RunOwnerRecordV1;
    try { occupied = readOwnerDirectory(target).record; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    validateOwnerPath(rootDir, target, occupied);
    if (!ownerIsLive(occupied, deps)) {
      fail("recovery-required", `dead or PID-reused ${scope} owner requires token-specific recovery before acquisition`);
    }
    let now: number;
    try { now = deps.monotonicMs(); } catch (error) { fail("state-write-failed", `monotonic clock failed: ${errorText(error)}`, error); }
    if (!Number.isFinite(now)) fail("state-write-failed", "monotonic clock returned a nonfinite value");
    if (now >= deadline) fail("run-busy", `shared 15-second acquisition budget expired behind a live ${scope} owner`);
    Atomics.wait(WAIT_WORD, 0, 0, Math.max(1, Math.min(8, deadline - now)));
  }
}

function quarantineCapability<S extends Scope>(capability: OwnerCapabilityV1<S>, deps: RunLockDependenciesV1): void {
  const origin = assertCapabilityCurrent(capability, deps);
  scanLockNamespaces(origin.rootDir);
  const cleanupToken = checkedUuid(deps, `${capability.scope} owner cleanup token`);
  const quarantine = `${origin.lockPath}.released.${shaToken(origin.record.token)}.${cleanupToken}`;
  if (fs.existsSync(quarantine)) fail("invalid-store", `owner quarantine collision '${quarantine}'`);
  assertCapabilityCurrent(capability, deps);
  try {
    fs.renameSync(origin.lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("invalid-store", "owner generation disappeared before quarantine", error);
    fail("state-write-failed", `owner quarantine rename failed: ${errorText(error)}`, error);
  }
  fsyncDirectory(path.dirname(origin.lockPath));
  const moved = readOwnerDirectory(quarantine);
  if (moved.canonical !== origin.canonical) {
    try {
      if (!fs.existsSync(origin.lockPath)) {
        fs.renameSync(quarantine, origin.lockPath);
        fsyncDirectory(path.dirname(origin.lockPath));
      }
    } catch {}
    fail("invalid-store", "quarantined owner was not the selected token generation");
  }
  if (origin.record.scope === "run" && origin.record.runId !== null) {
    LOCAL_RUN_GENERATIONS.delete(runGenerationKey(origin.rootDir, origin.record.runId, origin.record.token));
  }
  // The exact no-follow quarantine remains as bounded, non-owning crash evidence. A later
  // complete coordination scan may prove and remove it; the canonical lock path is already free.
}

function releasePreTargetPrefix(
  capabilities: readonly OwnerCapabilityV1<Scope>[],
  deps: RunLockDependenciesV1,
): void {
  for (let index = capabilities.length - 1; index >= 0; index -= 1) {
    quarantineCapability(capabilities[index], deps);
  }
}

function sharedDeadline(inputDeadline: number, deps: RunLockDependenciesV1): number {
  let start: number;
  try { start = deps.monotonicMs(); } catch (error) { fail("state-write-failed", `monotonic clock failed: ${errorText(error)}`, error); }
  if (!Number.isFinite(start)) fail("state-write-failed", "monotonic clock returned a nonfinite value");
  const maximum = start + ACQUIRE_BUDGET_MS;
  return Number.isFinite(inputDeadline) ? Math.min(maximum, inputDeadline) : maximum;
}

async function acquireOwners(
  input: RunOwnerAcquireInputV1 | PublicFleetOwnerAcquireInputV1,
  deps: RunLockDependenciesV1,
  publicFleet: boolean,
): Promise<RunOwnerSetV1 | PublicFleetOwnerSetV1> {
  const { rootDir, identity } = checkedDependencies(deps);
  const checked = checkedInput(input, publicFleet);
  const deadline = sharedDeadline(input.deadlineMonotonicMs, deps);
  ensureLockLayout(rootDir);
  scanLockNamespaces(rootDir);
  const acquired: OwnerCapabilityV1<Scope>[] = [];
  try {
    let run: OwnerCapabilityV1<"run"> | null = null;
    if (!publicFleet) {
      run = acquireOne("run", checked.input, checked.physicalProjectDir, deps, rootDir, identity, deadline);
      acquired.push(run);
    }
    const application = acquireOne("application", checked.input, checked.physicalProjectDir, deps, rootDir, identity, deadline);
    acquired.push(application);
    const project = acquireOne("project", checked.input, checked.physicalProjectDir, deps, rootDir, identity, deadline);
    acquired.push(project);
    try {
      const finalLocator = revalidateProjectLocator(input.projectLocator);
      if (finalLocator.physicalProjectDir !== checked.physicalProjectDir) {
        fail("external-state-conflict", "project locator changed after ordered owner acquisition");
      }
    } catch (error) {
      if (error instanceof RunLockError) throw error;
      const status = (error as { status?: string }).status;
      if (status === "limit-exceeded") fail("limit-exceeded", errorText(error), error);
      fail("external-state-conflict", `project locator changed after ordered owner acquisition: ${errorText(error)}`, error);
    }
    if (publicFleet) return Object.freeze({ run: null, application, project });
    const owners = Object.freeze({ run: run!, application, project });
    const runOrigin = OWNER_ORIGINS.get(run!);
    const applicationOrigin = OWNER_ORIGINS.get(application);
    const projectOrigin = OWNER_ORIGINS.get(project);
    if (runOrigin === undefined || applicationOrigin === undefined || projectOrigin === undefined) {
      fail("state-write-failed", "completed owner acquisition lost its local runtime origin");
    }
    LOCAL_RUN_GENERATIONS.set(runGenerationKey(rootDir, run!.record.runId!, run!.token), Object.freeze({
      rootDir,
      runId: run!.record.runId!,
      mode: run!.record.mode,
      run: runOrigin,
      application: applicationOrigin,
      project: projectOrigin,
    }));
    return owners;
  } catch (error) {
    try { releasePreTargetPrefix(acquired, deps); } catch (cleanupError) {
      fail("state-write-failed", `ordered acquisition failed and exact prefix cleanup also failed: ${errorText(cleanupError)}`, cleanupError);
    }
    throw error;
  }
}

export async function acquireRunOwners(
  input: RunOwnerAcquireInputV1,
  deps: RunLockDependenciesV1,
): Promise<RunOwnerSetV1> {
  return await acquireOwners(input, deps, false) as RunOwnerSetV1;
}

export async function acquirePublicFleetOwners(
  input: PublicFleetOwnerAcquireInputV1,
  deps: RunLockDependenciesV1,
): Promise<PublicFleetOwnerSetV1> {
  return await acquireOwners(input, deps, true) as PublicFleetOwnerSetV1;
}

function ownerSetRecords(owners: RunOwnerSetV1 | PublicFleetOwnerSetV1): readonly RunOwnerRecordV1[] {
  if (owners === null || typeof owners !== "object") fail("state-write-failed", "owner set is not an object");
  const records: RunOwnerRecordV1[] = [];
  if (owners.run !== null) {
    if (OWNER_ORIGINS.get(owners.run) === undefined || owners.run[ownerCapabilityBrand] !== true) {
      fail("state-write-failed", "run owner capability brand or runtime origin is invalid");
    }
    records.push(owners.run.record);
  }
  if (OWNER_ORIGINS.get(owners.application) === undefined || owners.application[ownerCapabilityBrand] !== true
    || OWNER_ORIGINS.get(owners.project) === undefined || owners.project[ownerCapabilityBrand] !== true) {
    fail("state-write-failed", "application/project owner capability brand or runtime origin is invalid");
  }
  records.push(owners.application.record, owners.project.record);
  const expected = owners.run === null ? ["application", "project"] : ["run", "application", "project"];
  if (records.some((record, index) => record.scope !== expected[index])) fail("invalid-store", "owner set is not an ordered strict prefix");
  return records;
}

function recordsAgree(records: readonly RunOwnerRecordV1[]): boolean {
  const nonRun = records.filter((record) => record.scope !== "run");
  const first = records[0];
  return records.every((record) => record.mode === first.mode && record.runId === first.runId
    && record.attemptId === first.attemptId && record.pid === first.pid
    && record.processIdentity === first.processIdentity)
    && nonRun.every((record) => record.resourceKey === nonRun[0]?.resourceKey
      && record.projectResourceKey === nonRun[0]?.projectResourceKey
      && record.physicalProjectDir === nonRun[0]?.physicalProjectDir);
}

const SNAPSHOT_KINDS = new Set<SnapshotRefV1["kind"]>([
  "goal", "acceptance", "app-spec", "brief-payload", "external-input", "compiler-ledger", "public-result",
]);

function strictSuppliedCoreChain(chainValue: CoreRunChainV1): CoreRunChainV1 {
  const object = exactRecord(
    chainValue,
    ["head", "revisions", "snapshots", "issues", "validation"],
    "supplied core run chain",
  );
  if (object.validation !== "core-only" || !Array.isArray(object.revisions)
    || object.revisions.length === 0 || !(object.snapshots instanceof Map)
    || !Array.isArray(object.issues)) {
    fail("invalid-store", "run owner release requires a validated nonempty core chain");
  }
  let head: RunHeadV1;
  try { head = parseRunHead(object.head); } catch (error) {
    fail("invalid-store", `supplied run HEAD is invalid: ${errorText(error)}`, error);
  }
  if (canonicalJson(head) !== canonicalJson(object.head)) {
    fail("invalid-store", "supplied run HEAD is not its strict canonical projection");
  }
  const revisions: RunRevisionV1[] = [];
  for (const [index, value] of object.revisions.entries()) {
    let revision: RunRevisionV1;
    try { revision = parseRunRevision(value); } catch (error) {
      fail("invalid-store", `supplied run release chain revision ${index} is invalid: ${errorText(error)}`, error);
    }
    if (canonicalJson(revision) !== canonicalJson(value) || revision.revision !== index
      || revision.runId !== head.runId) {
      fail("invalid-store", `supplied run revision ${index} is not its exact chain coordinate`);
    }
    if (index === 0 ? revision.parent !== null
      : revision.parent?.revision !== revisions[index - 1]?.revision
        || revision.parent.revisionId !== revisions[index - 1]?.revisionId) {
      fail("invalid-store", `supplied run revision ${index} has a noncontiguous parent`);
    }
    revisions.push(revision);
  }
  const last = revisions.at(-1)!;
  if (revisions.length !== head.revision + 1 || last.revision !== head.revision
    || last.revisionId !== head.revisionId) {
    fail("invalid-store", "supplied run HEAD is not the exact last core revision");
  }

  const snapshots = new Map<string, SnapshotEnvelopeV1>();
  for (const [keyValue, envelopeValue] of object.snapshots as Map<unknown, unknown>) {
    if (typeof keyValue !== "string") fail("invalid-store", "supplied run snapshot key is not a string");
    const separator = keyValue.indexOf(":");
    const kind = keyValue.slice(0, separator) as SnapshotRefV1["kind"];
    const digest = keyValue.slice(separator + 1);
    if (separator <= 0 || !SNAPSHOT_KINDS.has(kind) || !SHA256.test(digest)) {
      fail("invalid-store", `supplied run snapshot key '${keyValue}' is invalid`);
    }
    let envelope: SnapshotEnvelopeV1;
    try { envelope = parseSnapshotEnvelope(kind, envelopeValue); } catch (error) {
      fail("invalid-store", `supplied run snapshot '${keyValue}' is invalid: ${errorText(error)}`, error);
    }
    const canonical = canonicalJson(envelope);
    if (canonical !== canonicalJson(envelopeValue)
      || crypto.createHash("sha256").update(canonical).digest("hex") !== digest) {
      fail("invalid-store", `supplied run snapshot '${keyValue}' is not its exact canonical CAS object`);
    }
    snapshots.set(keyValue, envelope);
  }

  const issues: BoundedDiagnosticV1[] = object.issues.map((value, index) => {
    const issue = exactRecord(value, ["code", "detail", "detailSha256"], `supplied run issue ${index}`);
    if (typeof issue.code !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(issue.code)
      || typeof issue.detail !== "string" || Buffer.byteLength(issue.detail) > 4_096) {
      fail("invalid-store", `supplied run issue ${index} is not bounded`);
    }
    return Object.freeze({
      code: issue.code,
      detail: issue.detail,
      detailSha256: validateSha(issue.detailSha256, `supplied run issue ${index} digest`),
    });
  });
  return Object.freeze({
    head,
    revisions: Object.freeze(revisions),
    snapshots,
    issues: Object.freeze(issues),
    validation: "core-only" as const,
  });
}

function validateChainCoordinate(chainValue: CoreRunChainV1, owners: RunOwnerSetV1): {
  chain: CoreRunChainV1;
  transition: Record<string, unknown>;
} {
  const chain = strictSuppliedCoreChain(chainValue);
  const last = chain.revisions.at(-1)!;
  if (chain.head.runId !== owners.run.record.runId) {
    fail("invalid-store", "run owner release HEAD is not the exact last core revision");
  }
  if (last.target.resourceKey !== owners.application.record.resourceKey
    || last.target.projectResourceKey !== owners.project.record.projectResourceKey
    || last.target.projectLocator.physicalProjectDir !== owners.project.record.physicalProjectDir) {
    fail("invalid-store", "run owner release target does not match application/project owners");
  }
  return { chain, transition: last.transition as unknown as Record<string, unknown> };
}

function authorityPayload(
  kind: "run-head" | "public-fleet-completion",
  owners: RunOwnerSetV1 | PublicFleetOwnerSetV1,
  authorityDigest: Sha256,
): Omit<DurableOwnerReleaseAuthorityV1, typeof ownerReleaseAuthorityBrand> {
  const records = ownerSetRecords(owners);
  if (!recordsAgree(records)) fail("invalid-store", "owner generations disagree");
  return {
    kind,
    runId: owners.run?.record.runId ?? null,
    attemptId: owners.application.record.attemptId,
    applicationOwnerToken: owners.application.token,
    projectOwnerToken: owners.project.token,
    runOwnerToken: owners.run?.token ?? null,
    authorityDigest,
  };
}

function mintAuthority(
  kind: "run-head" | "public-fleet-completion",
  owners: RunOwnerSetV1 | PublicFleetOwnerSetV1,
  digest: Sha256,
  binding: Readonly<{ runHeadCanonical: string | null; publicCompletionCanonical: string | null }>,
): DurableOwnerReleaseAuthorityV1 {
  const authority = Object.freeze({ ...authorityPayload(kind, owners, digest), [ownerReleaseAuthorityBrand]: true as const });
  AUTHORITY_ORIGINS.set(authority, { owners, digest, ...binding });
  return authority;
}

export function authorizeRunOwnerRelease(
  owners: RunOwnerSetV1,
  chain: CoreRunChainV1,
): DurableOwnerReleaseAuthorityV1 {
  const records = ownerSetRecords(owners);
  if (owners.run === null || records.length !== 3 || !recordsAgree(records)) fail("invalid-store", "run release requires one exact three-owner generation");
  const origins = [OWNER_ORIGINS.get(owners.run), OWNER_ORIGINS.get(owners.application), OWNER_ORIGINS.get(owners.project)];
  if (origins.some((origin) => origin === undefined)) fail("state-write-failed", "run release owner runtime origin is unavailable");
  for (const origin of origins as OwnerOrigin[]) {
    if (readExactOwnerGeneration(origin.rootDir, origin.record).canonical !== origin.canonical) {
      fail("invalid-store", "run release owner generation changed before authorization");
    }
  }
  const supplied = validateChainCoordinate(chain, owners);
  const stored = assertStoredChainMatches(origins[0]!.rootDir, supplied.chain);
  const { transition } = validateChainCoordinate(stored, owners);
  if (owners.run.record.mode === "coordination") {
    if (owners.run.record.attemptId !== null || transition.type === "attempt-started" || transition.type === "attempt-in-doubt") {
      fail("invalid-store", "coordination owner release lacks a durable state-only HEAD");
    }
  } else {
    const definite = new Set(["attempt-paused", "attempt-conflicted", "iteration-completed", "run-terminal"]);
    if (!definite.has(String(transition.type)) || transition.attemptId !== owners.run.record.attemptId) {
      fail("invalid-store", "execution owner release requires a matching definite outcome HEAD, not attempt-started/in-doubt");
    }
  }
  const digest = crypto.createHash("sha256").update(canonicalJson({
    kind: "pico.run-owner-release-authority",
    schemaVersion: 1,
    head: stored.head,
    runOwnerToken: owners.run.token,
    applicationOwnerToken: owners.application.token,
    projectOwnerToken: owners.project.token,
  })).digest("hex");
  return mintAuthority("run-head", owners, digest, {
    runHeadCanonical: canonicalJson(stored.head),
    publicCompletionCanonical: null,
  });
}

function markerMatchesOwners(marker: PublicFleetCompletionMarkerV1, owners: PublicFleetOwnerSetV1): boolean {
  return marker.applicationOwnerToken === owners.application.token
    && marker.projectOwnerToken === owners.project.token
    && marker.attemptId === owners.application.record.attemptId
    && marker.resourceKey === owners.application.record.resourceKey
    && marker.projectResourceKey === owners.project.record.projectResourceKey
    && marker.physicalProjectDir === owners.project.record.physicalProjectDir;
}

export function authorizePublicFleetOwnerRelease(
  owners: PublicFleetOwnerSetV1,
  marker: PublicFleetCompletionMarkerV1,
): DurableOwnerReleaseAuthorityV1 {
  const records = ownerSetRecords(owners);
  if (owners.run !== null || records.length !== 2 || !recordsAgree(records)) fail("invalid-store", "public Fleet release requires one exact owner pair");
  const parsed = parseCompletionMarker(marker);
  const applicationOrigin = OWNER_ORIGINS.get(owners.application);
  const projectOrigin = OWNER_ORIGINS.get(owners.project);
  if (applicationOrigin === undefined || projectOrigin === undefined) fail("state-write-failed", "public owner runtime origin is unavailable");
  const application = readOwnerDirectory(applicationOrigin.lockPath);
  const project = readOwnerDirectory(projectOrigin.lockPath);
  if (application.canonical !== applicationOrigin.canonical || project.canonical !== projectOrigin.canonical) {
    fail("invalid-store", "public owner generation changed before completion authorization");
  }
  if (application.started === null || application.completed === null
    || canonicalJson(application.completed) !== canonicalJson(parsed)
    || application.started.projectOwnerToken !== owners.project.token
    || !completionMatchesStarted(parsed, application.started)
    || canonicalJson(parsed) !== canonicalJson(marker) || !markerMatchesOwners(parsed, owners)) {
    fail("invalid-store", "public completion marker does not match exact owner tokens and resources");
  }
  const digest = crypto.createHash("sha256").update(canonicalJson(parsed)).digest("hex");
  return mintAuthority("public-fleet-completion", owners, digest, {
    runHeadCanonical: null,
    publicCompletionCanonical: canonicalJson(parsed),
  });
}

function assertDurableReleaseAuthorityCurrent(origin: AuthorityOrigin): void {
  if (origin.runHeadCanonical !== null) {
    const run = origin.owners.run;
    if (run === null || origin.publicCompletionCanonical !== null) {
      fail("state-write-failed", "run release authority has an inconsistent runtime binding");
    }
    const ownerOrigin = OWNER_ORIGINS.get(run);
    if (ownerOrigin === undefined || run.record.runId === null) {
      fail("state-write-failed", "run release authority lost its owner runtime origin");
    }
    let stored: CoreRunChainV1;
    try {
      stored = readStoredCoreChain(ownerOrigin.rootDir, run.record.runId, origin.runHeadCanonical);
    } catch (error) {
      if (error instanceof RunLockError) throw error;
      fail("invalid-store", `durable run HEAD changed before owner release: ${errorText(error)}`, error);
    }
    if (canonicalJson(stored.head) !== origin.runHeadCanonical) {
      fail("invalid-store", "durable run HEAD changed after release authorization");
    }
    return;
  }

  if (origin.publicCompletionCanonical === null || origin.owners.run !== null) {
    fail("state-write-failed", "public release authority has an inconsistent runtime binding");
  }
  const applicationOrigin = OWNER_ORIGINS.get(origin.owners.application);
  const projectOrigin = OWNER_ORIGINS.get(origin.owners.project);
  if (applicationOrigin === undefined || projectOrigin === undefined) {
    fail("state-write-failed", "public release authority lost its owner runtime origin");
  }
  const application = readOwnerDirectory(applicationOrigin.lockPath);
  const project = readOwnerDirectory(projectOrigin.lockPath);
  if (application.canonical !== applicationOrigin.canonical || project.canonical !== projectOrigin.canonical
    || application.completed === null
    || canonicalJson(application.completed) !== origin.publicCompletionCanonical
    || !markerMatchesOwners(application.completed, origin.owners)) {
    fail("invalid-store", "durable public completion marker changed after release authorization");
  }
}

export async function releaseDefiniteOwners(
  owners: RunOwnerSetV1 | PublicFleetOwnerSetV1,
  durableAuthority: DurableOwnerReleaseAuthorityV1,
  deps: RunLockDependenciesV1,
): Promise<void> {
  checkedDependencies(deps);
  const origin = AUTHORITY_ORIGINS.get(durableAuthority);
  if (origin === undefined || durableAuthority[ownerReleaseAuthorityBrand] !== true
    || origin.owners !== owners || durableAuthority.authorityDigest !== origin.digest) {
    fail("state-write-failed", "durable owner release authority brand or runtime origin is invalid");
  }
  const expected = authorityPayload(durableAuthority.kind, owners, origin.digest);
  if (canonicalJson(expected) !== canonicalJson({
    kind: durableAuthority.kind,
    runId: durableAuthority.runId,
    attemptId: durableAuthority.attemptId,
    applicationOwnerToken: durableAuthority.applicationOwnerToken,
    projectOwnerToken: durableAuthority.projectOwnerToken,
    runOwnerToken: durableAuthority.runOwnerToken,
    authorityDigest: durableAuthority.authorityDigest,
  })) fail("state-write-failed", "durable owner release authority fields changed after minting");
  const ordered: OwnerCapabilityV1<Scope>[] = owners.run === null
    ? [owners.application, owners.project]
    : [owners.run, owners.application, owners.project];
  for (const owner of ordered) assertCapabilityCurrent(owner, deps);
  assertDurableReleaseAuthorityCurrent(origin);
  for (const owner of ordered) assertCapabilityCurrent(owner, deps);
  for (let index = ordered.length - 1; index >= 0; index -= 1) quarantineCapability(ordered[index], deps);
}

export function retainInDoubtOwners(owners: RunOwnerSetV1): RetainedOwnerSetV1 {
  const records = ownerSetRecords(owners);
  if (records.length !== 3 || !recordsAgree(records) || owners.run.record.mode !== "execution"
    || owners.run.record.attemptId === null) {
    fail("invalid-store", "in-doubt retention requires one exact execution owner generation");
  }
  const retained = Object.freeze({
    status: "retained-in-doubt" as const,
    runId: owners.run.record.runId!,
    attemptId: owners.run.record.attemptId,
    owners,
    [retainedOwnerBrand]: true as const,
  });
  RETAINED_ORIGINS.add(retained);
  return retained;
}

function controlRecovery(
  status: "recovery-required" | "interrupted-in-doubt" | "invalid-store" | "state-write-failed",
  detail: string,
  runId: LowercaseUuidV4 | null,
  chain: CoreRunChainV1 | null = null,
): RecoveryResultV1 {
  const last = chain?.revisions.at(-1) ?? null;
  const prior = status === "interrupted-in-doubt"
    ? last?.transition.type === "attempt-in-doubt"
      ? last.transition.externalMutationDisposition
      : last?.transition.type === "attempt-started" ? "possible" : null
    : null;
  return {
    status,
    runId,
    revision: chain?.head.revision ?? null,
    revisionId: chain?.head.revisionId ?? null,
    expectedRevision: null,
    actualRevision: null,
    actualRevisionId: null,
    runStateByThisCall: "unchanged",
    externalSideEffectsByThisCall: "none",
    priorAttemptExternalSideEffects: prior,
    activeAttemptExternalSideEffects: null,
    inDoubtAttemptCompletion: null,
    runRevisionCommitted: null,
    runRevisionPublication: null,
    expectedGeneration: null,
    observedGeneration: null,
    historicalResult: null,
    issues: [],
    detail,
    fix: status === "interrupted-in-doubt"
      ? "Retain the exact execution-owner generation; V1 has no unlock or replay path for an interrupted attempt."
      : "Inspect the bounded owner/store state and retry only after the exact token generation is understood.",
  } as RecoveryResultV1;
}

function checkedClassificationOwners(values: readonly RunOwnerRecordV1[]): RunOwnerRecordV1[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 3) fail("invalid-store", "dead owner classification has an invalid owner count");
  return values.map((value, index) => {
    const parsed = parseOwnerRecord(value);
    if (canonicalJson(parsed) !== canonicalJson(value)) fail("invalid-store", `dead owner ${index} is not its strict canonical projection`);
    return parsed;
  });
}

function readExactOwnerGeneration(
  rootDir: string,
  expected: RunOwnerRecordV1,
): OwnerDirectoryObservation {
  const target = recordLockPath(rootDir, expected);
  let observed: OwnerDirectoryObservation;
  try { observed = readOwnerDirectory(target); } catch (error) {
    if (error instanceof RunLockError) throw error;
    fail("invalid-store", `selected ${expected.scope} owner generation cannot be read: ${errorText(error)}`, error);
  }
  validateOwnerPath(rootDir, target, observed.record);
  if (observed.canonical !== canonicalJson(expected) || observed.record.token !== expected.token) {
    fail("invalid-store", `selected ${expected.scope} owner is no longer the byte-identical token generation`);
  }
  return observed;
}

function assertDeadOwnerGeneration(
  rootDir: string,
  expected: RunOwnerRecordV1,
  deps: RunLockDependenciesV1,
): OwnerDirectoryObservation {
  const observed = readExactOwnerGeneration(rootDir, expected);
  if (ownerIsLive(observed.record, deps)) fail("run-busy", `selected ${expected.scope} owner is still live`);
  return observed;
}

function electionPathFor(rootDir: string, owner: RunOwnerRecordV1): string {
  return `${recordLockPath(rootDir, owner)}.recover.${shaToken(owner.token)}`;
}

function makeElectionRecord(
  owner: RunOwnerRecordV1,
  deps: RunLockDependenciesV1,
  identity: string,
  rootDir: string,
): ElectionRecordV1 {
  return Object.freeze({
    kind: "pico.run-owner-recovery-election" as const,
    schemaVersion: 1 as const,
    pid: deps.pid,
    processIdentity: identity,
    token: checkedUuid(deps, `${owner.scope} recovery election token`),
    createdAt: checkedNow(deps),
    scope: owner.scope,
    ownerToken: owner.token,
    lockPath: recordLockPath(rootDir, owner),
  });
}

function assertOwnedElectionCurrent(lease: ElectionLease, deps: RunLockDependenciesV1): void {
  if (deps.pid !== lease.record.pid) fail("state-write-failed", "recovery election pid no longer names the current process");
  let identity: string;
  try { identity = strictProcessIdentity(deps.processIdentity(), "current recovery process identity"); } catch (error) {
    fail("state-write-failed", `recovery process identity probe failed: ${errorText(error)}`, error);
  }
  if (identity !== lease.record.processIdentity) fail("state-write-failed", "recovery election process identity drifted");
  let current: { record: ElectionRecordV1; canonical: string };
  try { current = readElectionDirectory(lease.path); } catch (error) {
    if (error instanceof RunLockError) throw error;
    fail("invalid-store", `recovery election disappeared or became unsafe: ${errorText(error)}`, error);
  }
  if (current.canonical !== lease.canonical || current.record.token !== lease.record.token) {
    fail("invalid-store", "recovery election no longer contains the exact selected token generation");
  }
}

function quarantineElection(
  lease: ElectionLease,
  deps: RunLockDependenciesV1,
  ownedByCurrentProcess: boolean,
): void {
  if (ownedByCurrentProcess) assertOwnedElectionCurrent(lease, deps);
  else {
    const current = readElectionDirectory(lease.path);
    if (current.canonical !== lease.canonical) fail("invalid-store", "dead recovery election changed before selection");
    if (processIdentityIsLive(current.record.pid, current.record.processIdentity, deps)) fail("run-busy", "a live recovery election cannot be replaced");
  }
  const cleanupToken = checkedUuid(deps, `${lease.record.scope} recovery election cleanup token`);
  if (ownedByCurrentProcess) assertOwnedElectionCurrent(lease, deps);
  else if (readElectionDirectory(lease.path).canonical !== lease.canonical) fail("invalid-store", "dead recovery election changed before quarantine");
  const target = `${lease.path}.released.${shaToken(lease.record.token)}.${cleanupToken}`;
  if (fs.existsSync(target)) fail("invalid-store", "recovery election quarantine collides with an existing path");
  try { fs.renameSync(lease.path, target); } catch (error) {
    fail("state-write-failed", `recovery election quarantine failed: ${errorText(error)}`, error);
  }
  fsyncDirectory(path.dirname(lease.path));
  const moved = readElectionDirectory(target);
  if (moved.canonical !== lease.canonical) {
    try {
      if (!fs.existsSync(lease.path)) {
        fs.renameSync(target, lease.path);
        fsyncDirectory(path.dirname(lease.path));
      }
    } catch {}
    fail("invalid-store", "recovery election quarantine contains a different generation");
  }
}

function acquireElection(
  owner: RunOwnerRecordV1,
  deps: RunLockDependenciesV1,
  rootDir: string,
  identity: string,
  deadline: number,
): ElectionLease {
  const target = electionPathFor(rootDir, owner);
  for (;;) {
    assertDeadOwnerGeneration(rootDir, owner, deps);
    let exists = false;
    try { fs.lstatSync(target); exists = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const record = makeElectionRecord(owner, deps, identity, rootDir);
    let published = false;
    if (exists) {
      scanLockNamespaces(rootDir);
    } else {
      const enrollment = acquireCapacityEnrollment(rootDir, deps, identity, deadline);
      let committed = false;
      let acquisitionError: unknown = null;
      try {
        assertCapacityEnrollmentCurrent(enrollment, deps);
        let appeared = false;
        try { fs.lstatSync(target); appeared = true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        scanLockNamespaces(rootDir, appeared ? null : {
          scope: owner.scope,
          capacityClass: "recovery-election",
          entries: 1,
          token: record.token,
        });
        assertCapacityEnrollmentCurrent(enrollment, deps);
        if (!appeared) {
          published = publishOwnedDirectory(
            target,
            record,
            "election",
            () => assertCapacityEnrollmentCurrent(enrollment, deps),
            () => { committed = true; },
          );
        }
      } catch (error) {
        acquisitionError = error;
      }
      try {
        releaseCapacityEnrollment(enrollment, deps, true);
      } catch (error) {
        if (acquisitionError === null) acquisitionError = error;
      }
      if (acquisitionError !== null) {
        if (committed) {
          const committedLease = Object.freeze({ path: target, record, canonical: canonicalJson(record) });
          try {
            quarantineElection(committedLease, deps, true);
          } catch (cleanupError) {
            fail(
              "state-write-failed",
              `election publication committed, later failed, and exact cleanup failed: ${errorText(cleanupError)}`,
              cleanupError,
            );
          }
        }
        throw acquisitionError;
      }
    }
    if (published) {
      const lease = Object.freeze({ path: target, record, canonical: canonicalJson(record) });
      assertOwnedElectionCurrent(lease, deps);
      assertDeadOwnerGeneration(rootDir, owner, deps);
      return lease;
    }
    let occupied: { record: ElectionRecordV1; canonical: string };
    try { occupied = readElectionDirectory(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (occupied.record.scope !== owner.scope || occupied.record.ownerToken !== owner.token
      || occupied.record.lockPath !== recordLockPath(rootDir, owner)) {
      fail("invalid-store", "recovery election path is occupied by a mismatched generation");
    }
    const stale = Object.freeze({ path: target, record: occupied.record, canonical: occupied.canonical });
    quarantineElection(stale, deps, false);
  }
}

function acquireElections(
  owners: readonly RunOwnerRecordV1[],
  deps: RunLockDependenciesV1,
  rootDir: string,
): ElectionLease[] {
  const { identity } = checkedDependencies(deps);
  const deadline = sharedDeadline(Number.POSITIVE_INFINITY, deps);
  const leases: ElectionLease[] = [];
  try {
    for (const owner of owners) {
      for (const lease of leases) assertOwnedElectionCurrent(lease, deps);
      leases.push(acquireElection(owner, deps, rootDir, identity, deadline));
    }
    return leases;
  } catch (error) {
    for (let index = leases.length - 1; index >= 0; index -= 1) {
      try { quarantineElection(leases[index], deps, true); } catch {}
    }
    throw error;
  }
}

function releaseElections(leases: readonly ElectionLease[], deps: RunLockDependenciesV1): void {
  for (let index = leases.length - 1; index >= 0; index -= 1) quarantineElection(leases[index], deps, true);
}

function quarantineDeadOwner(
  owner: RunOwnerRecordV1,
  deps: RunLockDependenciesV1,
  rootDir: string,
): void {
  const selected = assertDeadOwnerGeneration(rootDir, owner, deps);
  const cleanupToken = checkedUuid(deps, `${owner.scope} recovered-owner cleanup token`);
  assertDeadOwnerGeneration(rootDir, owner, deps);
  const source = recordLockPath(rootDir, owner);
  const target = `${source}.released.${shaToken(owner.token)}.${cleanupToken}`;
  if (fs.existsSync(target)) fail("invalid-store", "recovered owner quarantine collides with an existing path");
  try { fs.renameSync(source, target); } catch (error) {
    fail("state-write-failed", `recovered owner quarantine failed: ${errorText(error)}`, error);
  }
  fsyncDirectory(path.dirname(source));
  const moved = readOwnerDirectory(target);
  if (moved.canonical !== selected.canonical) {
    try {
      if (!fs.existsSync(source)) {
        fs.renameSync(target, source);
        fsyncDirectory(path.dirname(source));
      }
    } catch {}
    fail("invalid-store", "recovered owner quarantine contained a replacement generation and was restored");
  }
}

function quarantineDeadOwnersReverse(
  owners: readonly RunOwnerRecordV1[],
  deps: RunLockDependenciesV1,
  rootDir: string,
): void {
  for (let index = owners.length - 1; index >= 0; index -= 1) quarantineDeadOwner(owners[index], deps, rootDir);
}

function strictChainForRecords(
  chainValue: CoreRunChainV1,
  owners: readonly RunOwnerRecordV1[],
): { transition: Record<string, unknown>; chain: CoreRunChainV1 } {
  const chain = strictSuppliedCoreChain(chainValue);
  const head = chain.head;
  const revisions = chain.revisions;
  const last = revisions.at(-1)!;
  const run = owners[0].scope === "run" ? owners[0] : null;
  const application = owners.find((owner) => owner.scope === "application") ?? null;
  const project = owners.find((owner) => owner.scope === "project") ?? null;
  if (run === null || head.runId !== run.runId || last.revision !== head.revision || last.revisionId !== head.revisionId) {
    fail("invalid-store", "recovery chain HEAD does not match the selected run owner");
  }
  if (application !== null && (last.target.resourceKey !== application.resourceKey
      || last.target.projectResourceKey !== application.projectResourceKey
      || last.target.projectLocator.physicalProjectDir !== application.physicalProjectDir)) {
    fail("invalid-store", "recovery chain target does not match the selected application owner");
  }
  if (project !== null && (last.target.projectResourceKey !== project.projectResourceKey
      || last.target.projectLocator.physicalProjectDir !== project.physicalProjectDir)) {
    fail("invalid-store", "recovery chain target does not match the selected project owner");
  }
  return { transition: last.transition as unknown as Record<string, unknown>, chain };
}

function readStoredCoreChain(
  rootDir: string,
  runId: LowercaseUuidV4,
  expectedHeadCanonical: string | null = null,
): CoreRunChainV1 {
  const store = createRunRevisionStore({
    assertMutationAuthority: () => fail("state-write-failed", "read-only recovery store cannot mutate"),
    assertRecoveryAuthority: () => fail("state-write-failed", "read-only recovery store cannot mutate"),
    nowUtc: () => "1970-01-01T00:00:00.000Z" as CanonicalUtcTimestamp,
  }, { rootDir });
  try {
    const stored = store.readCommittedRun(runId, {
      parseRevision: parseRunRevision,
      parseHead: parseRunHead,
      parseSnapshot: parseSnapshotEnvelope,
    });
    if (expectedHeadCanonical !== null && canonicalJson(stored.head) !== expectedHeadCanonical) {
      fail("invalid-store", "durable run HEAD no longer equals the authorized coordinate");
    }
    return stored;
  } catch (error) {
    if (error instanceof RunLockError) throw error;
    fail("invalid-store", `durable run chain cannot be reopened: ${errorText(error)}`, error);
  }
}

function assertStoredChainPrefixMatches(rootDir: string, chainValue: CoreRunChainV1): CoreRunChainV1 {
  const chain = strictSuppliedCoreChain(chainValue);
  const headPath = path.join(rootDir, chain.head.runId, "HEAD.json");
  const headLeaf = readCanonicalLeaf(headPath);
  const durableHead = parseRunHead(headLeaf.raw);
  if (canonicalJson(durableHead) !== headLeaf.canonical
    || headLeaf.canonical !== canonicalJson(chain.head)) {
    fail("invalid-store", "supplied recovery HEAD is not the exact current durable HEAD");
  }
  for (const revision of chain.revisions) {
    const leaf = readCanonicalLeaf(
      path.join(rootDir, chain.head.runId, "revisions", `${revision.revision}.json`),
      RUN_REVISION_MAX_BYTES,
    );
    const durable = parseRunRevision(leaf.raw);
    if (canonicalJson(durable) !== leaf.canonical || leaf.canonical !== canonicalJson(revision)) {
      fail("invalid-store", `supplied recovery revision ${revision.revision} is not the exact durable revision`);
    }
  }
  return chain;
}

function assertStoredChainMatches(rootDir: string, chainValue: CoreRunChainV1): CoreRunChainV1 {
  const chain = strictSuppliedCoreChain(chainValue);
  const stored = readStoredCoreChain(rootDir, chain.head.runId, canonicalJson(chain.head));
  if (stored.revisions.length !== chain.revisions.length
    || stored.revisions.some((revision, index) => canonicalJson(revision) !== canonicalJson(chain.revisions[index]))) {
    fail("invalid-store", "supplied recovery chain is not the exact durable committed chain");
  }
  if (stored.snapshots.size !== chain.snapshots.size) {
    fail("invalid-store", "supplied recovery chain snapshot set is not the exact durable set");
  }
  for (const [key, envelope] of stored.snapshots) {
    const supplied = chain.snapshots.get(key);
    if (supplied === undefined || canonicalJson(supplied) !== canonicalJson(envelope)) {
      fail("invalid-store", `supplied recovery snapshot '${key}' is not the exact durable CAS object`);
    }
  }
  return stored;
}

function assertRecoveryRevisionMatchesOwners(
  rootDir: string,
  revisionNumber: number,
  owners: readonly RunOwnerRecordV1[],
): void {
  const run = owners.find((owner) => owner.scope === "run");
  const application = owners.find((owner) => owner.scope === "application");
  const project = owners.find((owner) => owner.scope === "project");
  if (run === undefined || application === undefined || project === undefined
    || run.runId === null || run.attemptId === null) {
    fail("invalid-store", "recovery revision validation requires one complete execution-owner generation");
  }
  const target = path.join(rootDir, run.runId, "revisions", `${revisionNumber}.json`);
  const leaf = readCanonicalLeaf(target, RUN_REVISION_MAX_BYTES);
  const revision = parseRunRevision(leaf.raw);
  const headLeaf = readCanonicalLeaf(path.join(rootDir, run.runId, "HEAD.json"));
  const head = parseRunHead(headLeaf.raw);
  const revisionCoordinateMatches = revisionNumber === head.revision
    ? revision.revisionId === head.revisionId
    : revisionNumber === head.revision + 1
      && revision.parent?.revision === head.revision
      && revision.parent.revisionId === head.revisionId;
  if (canonicalJson(revision) !== leaf.canonical || revision.runId !== run.runId
    || canonicalJson(head) !== headLeaf.canonical || head.runId !== run.runId
    || revision.revision !== revisionNumber || !revisionCoordinateMatches
    || !("attemptId" in revision.transition)
    || revision.transition.attemptId !== run.attemptId
    || revision.target.resourceKey !== application.resourceKey
    || revision.target.projectResourceKey !== application.projectResourceKey
    || revision.target.projectLocator.physicalProjectDir !== application.physicalProjectDir
    || revision.target.projectResourceKey !== project.projectResourceKey
    || revision.target.projectLocator.physicalProjectDir !== project.physicalProjectDir) {
    fail("invalid-store", "recovery revision does not match the exact execution owner attempt and target");
  }
}

function assertPresentRecoveryTailMatchesOwners(
  rootDir: string,
  headRevision: number,
  owners: readonly RunOwnerRecordV1[],
): void {
  const run = owners[0];
  if (run.runId === null) fail("invalid-store", "recovery owner has no run ID");
  const candidate = path.join(rootDir, run.runId, "revisions", `${headRevision + 1}.json`);
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertRecoveryRevisionMatchesOwners(rootDir, headRevision + 1, owners);
}

function validateRunPrefix(records: readonly RunOwnerRecordV1[]): void {
  const expected = ["run", "application", "project"] as const;
  if (records.some((record, index) => record.scope !== expected[index]) || !recordsAgree(records)) {
    fail("invalid-store", "run recovery owner set is not one agreeing strict acquisition/release prefix");
  }
  if (records[0].runId === null) fail("invalid-store", "run recovery prefix has a nullable run ID");
}

function validatePublicPrefix(records: readonly RunOwnerRecordV1[]): void {
  const expected = ["application", "project"] as const;
  if (records.length > 2 || records.some((record, index) => record.scope !== expected[index]) || !recordsAgree(records)
    || records.some((record) => record.runId !== null || record.mode !== "execution" || record.attemptId === null)) {
    fail("invalid-store", "public Fleet recovery owner set is not one agreeing strict application/project prefix");
  }
}

function assertOmittedLaterScopesAbsent(rootDir: string, records: readonly RunOwnerRecordV1[]): void {
  const orderedScopes: readonly Scope[] = records[0].scope === "run"
    ? ["run", "application", "project"]
    : ["application", "project"];
  if (records.length === orderedScopes.length) return;
  const omitted = new Set(orderedScopes.slice(records.length));
  const first = records[0];
  const knownTarget = records.find((record) => record.scope !== "run") ?? null;
  const { activeOwners } = scanLockNamespaces(rootDir);
  for (const candidate of activeOwners) {
    if (!omitted.has(candidate.scope)) continue;
    if (knownTarget === null && candidate.runId === first.runId) {
      fail("invalid-store", `run-only recovery prefix omitted an extant or mismatched ${candidate.scope} owner for the selected run`);
    }
    const occupiesKnownTarget = knownTarget !== null && (candidate.scope === "application"
      ? candidate.resourceKey === knownTarget.resourceKey
      : candidate.scope === "project" && candidate.projectResourceKey === knownTarget.projectResourceKey);
    if (occupiesKnownTarget) {
      fail("invalid-store", `recovery prefix omitted an extant or mismatched ${candidate.scope} owner at the selected target`);
    }
    if (candidate.mode !== first.mode || candidate.runId !== first.runId
      || candidate.attemptId !== first.attemptId || candidate.pid !== first.pid
      || candidate.processIdentity !== first.processIdentity) continue;
    if (knownTarget !== null && (candidate.resourceKey !== knownTarget.resourceKey
      || candidate.projectResourceKey !== knownTarget.projectResourceKey
      || candidate.physicalProjectDir !== knownTarget.physicalProjectDir)) continue;
    fail("invalid-store", `recovery prefix omitted an extant matching ${candidate.scope} owner`);
  }
}

function markerMatchesPublicRecords(
  marker: PublicFleetExecutionMarkerV1 | PublicFleetCompletionMarkerV1,
  records: readonly RunOwnerRecordV1[],
): boolean {
  const application = records[0];
  const project = records[1] ?? null;
  return markerMatchesApplicationOwner(marker, application)
    && (project === null || (marker.projectOwnerToken === project.token
      && marker.resourceKey === project.resourceKey
      && marker.projectResourceKey === project.projectResourceKey
      && marker.physicalProjectDir === project.physicalProjectDir));
}

const RUN_RECOVERY_CLASSIFICATIONS = new Set([
  "pre-target", "coordination-head", "definite-outcome-head", "attempt-in-doubt", "invalid-store",
]);
const PUBLIC_RECOVERY_CLASSIFICATIONS = new Set([
  "pre-started", "completed", "interrupted-in-doubt", "invalid-store",
]);

function assertRunStateAbsent(rootDir: string, runId: LowercaseUuidV4): void {
  const target = path.join(rootDir, runId);
  try {
    fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    fail("invalid-store", `cannot prove pre-target run state absence: ${errorText(error)}`, error);
  }
  fail("invalid-store", "pre-target recovery found a durable run target");
}

function validatePublicRecoveryState(
  classification: Extract<DeadOwnerPrefixClassificationV1, { kind: "public-fleet-prefix" }>,
  owners: readonly RunOwnerRecordV1[],
  deps: RunLockDependenciesV1,
  rootDir: string,
): void {
  const observations = owners.map((owner) => assertDeadOwnerGeneration(rootDir, owner, deps));
  const actualStarted = observations[0].started;
  const actualCompleted = observations[0].completed;
  const suppliedStarted = classification.started === null ? null : parseStartedMarker(classification.started);
  const suppliedCompleted = classification.completed === null ? null : parseCompletionMarker(classification.completed);
  if ((actualStarted === null) !== (suppliedStarted === null)
    || (actualCompleted === null) !== (suppliedCompleted === null)
    || (actualStarted !== null && canonicalJson(actualStarted) !== canonicalJson(suppliedStarted))
    || (actualCompleted !== null && canonicalJson(actualCompleted) !== canonicalJson(suppliedCompleted))) {
    fail("invalid-store", "public recovery marker inputs do not equal the exact visible marker targets");
  }
  if (actualStarted !== null && !markerMatchesPublicRecords(actualStarted, owners)) {
    fail("invalid-store", "started marker does not match the exact public owner generation");
  }
  if (actualCompleted !== null && (!markerMatchesPublicRecords(actualCompleted, owners)
      || actualStarted === null || !completionMatchesStarted(actualCompleted, actualStarted))) {
    fail("invalid-store", "completed marker does not match the exact started/public owner generation");
  }
  if (classification.classification === "pre-started" && (actualStarted !== null || actualCompleted !== null)) {
    fail("invalid-store", "pre-started classification has a visible execution marker");
  }
  if (classification.classification === "interrupted-in-doubt"
    && (owners.length !== 2 || actualStarted === null || actualCompleted !== null)) {
    fail("invalid-store", "public interrupted classification requires the complete pair and only a started target");
  }
  if (classification.classification === "completed" && (actualStarted === null || actualCompleted === null)) {
    fail("invalid-store", "public completed classification lacks exact durable started/completed targets");
  }
}

async function recoverRunPrefix(
  classification: Extract<DeadOwnerPrefixClassificationV1, { kind: "run-prefix" }>,
  deps: RunLockDependenciesV1,
  rootDir: string,
): Promise<RecoveryResultV1> {
  const owners = checkedClassificationOwners(classification.owners);
  validateRunPrefix(owners);
  assertOmittedLaterScopesAbsent(rootDir, owners);
  if (!RUN_RECOVERY_CLASSIFICATIONS.has(classification.classification)) {
    fail("invalid-store", "run recovery classification is unknown");
  }
  if (classification.classification === "invalid-store") fail("invalid-store", "caller classified the run prefix as invalid-store");
  for (const owner of owners) assertDeadOwnerGeneration(rootDir, owner, deps);

  let validated: { transition: Record<string, unknown>; chain: CoreRunChainV1 } | null = null;
  if (classification.chain !== null) validated = strictChainForRecords(classification.chain, owners);
  if (classification.classification === "pre-target") {
    if (classification.chain !== null) fail("invalid-store", "pre-target owner recovery unexpectedly carries a run chain");
    assertRunStateAbsent(rootDir, owners[0].runId!);
  } else {
    if (validated === null) fail("invalid-store", "state-authorized owner recovery lacks its durable chain");
    validated = {
      ...validated,
      chain: classification.classification === "attempt-in-doubt"
        ? assertStoredChainPrefixMatches(rootDir, validated.chain)
        : assertStoredChainMatches(rootDir, validated.chain),
    };
  }

  if (classification.classification === "coordination-head") {
    if (owners[0].mode !== "coordination" || owners[0].attemptId !== null
      || validated!.transition.type === "attempt-started" || validated!.transition.type === "attempt-in-doubt") {
      fail("invalid-store", "coordination recovery lacks a matching durable state-only HEAD");
    }
  }
  if (classification.classification === "definite-outcome-head") {
    const definite = new Set(["attempt-paused", "attempt-conflicted", "iteration-completed", "run-terminal"]);
    if (owners[0].mode !== "execution" || owners[0].attemptId === null
      || !definite.has(String(validated!.transition.type))
      || validated!.transition.attemptId !== owners[0].attemptId) {
      fail("invalid-store", "definite-outcome recovery lacks its exact attempt outcome HEAD");
    }
  }
  if (classification.classification === "attempt-in-doubt") {
    if (owners.length !== 3 || owners[0].mode !== "execution" || owners[0].attemptId === null || validated === null) {
      fail("invalid-store", "attempt-in-doubt recovery requires the complete execution-owner generation and chain");
    }
    assertPresentRecoveryTailMatchesOwners(rootDir, validated.chain.head.revision, owners);
  }

  const elections = acquireElections(owners, deps, rootDir);
  try {
    assertOmittedLaterScopesAbsent(rootDir, owners);
    for (const owner of owners) assertDeadOwnerGeneration(rootDir, owner, deps);
    if (classification.classification === "pre-target") {
      assertRunStateAbsent(rootDir, owners[0].runId!);
    } else if (classification.classification === "attempt-in-doubt") {
      assertStoredChainPrefixMatches(rootDir, validated!.chain);
      assertPresentRecoveryTailMatchesOwners(rootDir, validated!.chain.head.revision, owners);
    } else {
      assertStoredChainMatches(rootDir, validated!.chain);
    }
    if (classification.classification === "attempt-in-doubt") {
      const active: ActiveRecovery = Object.freeze({
        rootDir,
        runId: owners[0].runId!,
        ownerToken: owners[0].token,
        owners,
        elections,
      });
      const key = runGenerationKey(rootDir, active.runId, active.ownerToken);
      ACTIVE_RECOVERY.set(key, active);
      let result: RecoveryResultV1;
      try {
        const store = createLockBackedRunRevisionStore(deps, { rootDir });
        result = store.recoverLinkedTail(active.runId, {
          runId: active.runId,
          expectedRevision: validated!.chain.head.revision,
          ownerToken: active.ownerToken,
          mode: "recovery",
        });
      } finally {
        ACTIVE_RECOVERY.delete(key);
      }
      if (result.status === "head-advanced") {
        const final = result.chain.revisions.at(-1)!;
        const definite = new Set(["attempt-paused", "attempt-conflicted", "iteration-completed", "run-terminal"]);
        if (definite.has(final.transition.type)) {
          quarantineDeadOwnersReverse(owners, deps, rootDir);
          return result;
        }
        return controlRecovery("interrupted-in-doubt", "recovered attempt boundary remains interrupted in doubt", active.runId, result.chain);
      }
      return result;
    }

    quarantineDeadOwnersReverse(owners, deps, rootDir);
    if (classification.classification === "pre-target") {
      return controlRecovery("recovery-required", "dead pre-target owner prefix was quarantined; retry acquisition", owners[0].runId);
    }
    return { status: "unchanged", chain: validated!.chain };
  } finally {
    releaseElections(elections, deps);
  }
}

async function recoverPublicPrefix(
  classification: Extract<DeadOwnerPrefixClassificationV1, { kind: "public-fleet-prefix" }>,
  deps: RunLockDependenciesV1,
  rootDir: string,
): Promise<RecoveryResultV1> {
  const owners = checkedClassificationOwners(classification.owners);
  validatePublicPrefix(owners);
  assertOmittedLaterScopesAbsent(rootDir, owners);
  if (!PUBLIC_RECOVERY_CLASSIFICATIONS.has(classification.classification)) {
    fail("invalid-store", "public Fleet recovery classification is unknown");
  }
  if (classification.classification === "invalid-store") fail("invalid-store", "caller classified the public prefix as invalid-store");
  validatePublicRecoveryState(classification, owners, deps, rootDir);

  const elections = acquireElections(owners, deps, rootDir);
  try {
    assertOmittedLaterScopesAbsent(rootDir, owners);
    for (const owner of owners) assertDeadOwnerGeneration(rootDir, owner, deps);
    validatePublicRecoveryState(classification, owners, deps, rootDir);
    if (classification.classification === "interrupted-in-doubt") {
      return controlRecovery("interrupted-in-doubt", "public Fleet started without durable completion; both owners remain retained", null);
    }
    quarantineDeadOwnersReverse(owners, deps, rootDir);
    return controlRecovery("recovery-required", "dead public Fleet owner prefix was quarantined; retry the public call", null);
  } finally {
    releaseElections(elections, deps);
  }
}

export async function recoverDeadPrefix(
  classification: DeadOwnerPrefixClassificationV1,
  deps: RunLockDependenciesV1,
): Promise<RecoveryResultV1> {
  let rootDir: string | null = null;
  let runId: LowercaseUuidV4 | null = null;
  try {
    ({ rootDir } = checkedDependencies(deps));
    ensureLockLayout(rootDir);
    scanLockNamespaces(rootDir);
    if (classification === null || typeof classification !== "object") fail("invalid-store", "dead owner classification is not an object");
    if (classification.kind === "run-prefix") {
      runId = classification.owners[0]?.runId ?? null;
      return await recoverRunPrefix(classification, deps, rootDir);
    }
    if (classification.kind === "public-fleet-prefix") return await recoverPublicPrefix(classification, deps, rootDir);
    fail("invalid-store", "dead owner classification kind is unknown");
  } catch (error) {
    if (error instanceof RunLockError) {
      if (error.status === "run-busy" || error.status === "limit-exceeded") throw error;
      return controlRecovery(error.status === "state-write-failed" ? "state-write-failed" : "invalid-store", error.message, runId);
    }
    return controlRecovery("state-write-failed", `owner recovery failed: ${errorText(error)}`, runId);
  }
}

function checkedStoreRequest(request: RunStoreMutationRequestV1): RunStoreMutationRequestV1 {
  const object = exactRecord(request, ["runId", "expectedRevision", "ownerToken", "mode"], "run-store mutation request");
  const runId = validateUuid(object.runId, "run-store request runId");
  const ownerToken = validateUuid(object.ownerToken, "run-store request ownerToken");
  const expectedRevision = object.expectedRevision;
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0)) {
    fail("state-write-failed", "run-store request expectedRevision is invalid");
  }
  if (object.mode !== "coordination" && object.mode !== "execution" && object.mode !== "recovery") {
    fail("state-write-failed", "run-store request mode is invalid");
  }
  return { runId, expectedRevision: expectedRevision as number | null, ownerToken, mode: object.mode };
}

function assertOriginCurrent(origin: OwnerOrigin, deps: RunLockDependenciesV1, currentProcess: boolean): void {
  if (currentProcess) assertCurrentIdentity(origin.record, deps);
  const observed = readExactOwnerGeneration(origin.rootDir, origin.record);
  if (observed.canonical !== origin.canonical) fail("invalid-store", "registered owner origin no longer matches current bytes");
}

function currentHeadRevision(rootDir: string, runId: LowercaseUuidV4): number | null {
  const target = path.join(rootDir, runId, "HEAD.json");
  try {
    const leaf = readCanonicalLeaf(target);
    const head = parseRunHead(leaf.raw);
    if (head.runId !== runId || canonicalJson(head) !== leaf.canonical) fail("invalid-store", "current HEAD is not its exact canonical run coordinate");
    return head.revision;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertLocalStoreAuthority(
  requestValue: RunStoreMutationRequestV1,
  target: { runId: LowercaseUuidV4; operation: "revision" | "head" },
  deps: RunLockDependenciesV1,
  rootDir: string,
): void {
  checkedDependencies(deps);
  const request = checkedStoreRequest(requestValue);
  if (request.mode === "recovery" || request.runId !== target.runId) fail("state-write-failed", "mutation authority request mode/run does not match target");
  const generation = LOCAL_RUN_GENERATIONS.get(runGenerationKey(rootDir, request.runId, request.ownerToken));
  if (generation === undefined || generation.mode !== request.mode || generation.run.record.token !== request.ownerToken) {
    fail("state-write-failed", "mutation request lacks a local run-owner generation authority");
  }
  if (request.expectedRevision !== currentHeadRevision(rootDir, request.runId)) {
    fail("state-write-failed", "mutation request expectedRevision does not equal the current authoritative HEAD coordinate");
  }
  const origins = [generation.run, generation.application, generation.project];
  for (const origin of origins) assertOriginCurrent(origin, deps, true);
  if (!recordsAgree(origins.map((origin) => origin.record))) fail("invalid-store", "local store owner generations disagree");
  if (target.operation === "head") {
    const revisionNumber = request.expectedRevision === null ? 0 : request.expectedRevision + 1;
    const leaf = readCanonicalLeaf(
      path.join(rootDir, request.runId, "revisions", `${revisionNumber}.json`),
      RUN_REVISION_MAX_BYTES,
    );
    const revision = parseRunRevision(leaf.raw);
    if (canonicalJson(revision) !== leaf.canonical || revision.revision !== revisionNumber) {
      fail("invalid-store", "linked revision is not its exact canonical mutation coordinate");
    }
    assertRevisionCandidateOwned(revision, request, rootDir);
  }
}

function assertRevisionCandidateOwned(
  candidateValue: Parameters<RunRevisionStoreV1["publishRevision"]>[0],
  requestValue: RunStoreMutationRequestV1,
  rootDir: string,
): void {
  const request = checkedStoreRequest(requestValue);
  let candidate: ReturnType<typeof parseRunRevision>;
  try { candidate = parseRunRevision(candidateValue); } catch (error) {
    fail("invalid-store", `run revision candidate is invalid: ${errorText(error)}`, error);
  }
  const generation = LOCAL_RUN_GENERATIONS.get(runGenerationKey(rootDir, request.runId, request.ownerToken));
  if (generation === undefined || generation.mode !== request.mode
    || candidate.runId !== request.runId || candidate.runId !== generation.runId) {
    fail("state-write-failed", "revision candidate lacks its local run-owner generation");
  }
  const attemptBound = new Set([
    "attempt-started", "attempt-in-doubt", "attempt-paused", "attempt-conflicted",
    "iteration-completed", "run-terminal",
  ]).has(candidate.transition.type);
  if (generation.mode === "coordination" && (attemptBound || "attemptId" in candidate.transition)) {
    fail("state-write-failed", "coordination owners cannot publish an attempt-bound revision candidate");
  }
  if (request.expectedRevision === null) {
    if (candidate.revision !== 0 || candidate.parent !== null) {
      fail("state-write-failed", "initial revision candidate is not bound to the null expected coordinate");
    }
  } else if (candidate.revision !== request.expectedRevision + 1
      || candidate.parent?.revision !== request.expectedRevision) {
    fail("state-write-failed", "revision candidate is not the exact successor of expectedRevision");
  }
  const application = generation.application.record;
  const project = generation.project.record;
  if (candidate.target.resourceKey !== application.resourceKey
    || candidate.target.projectResourceKey !== application.projectResourceKey
    || candidate.target.projectLocator.physicalProjectDir !== application.physicalProjectDir
    || candidate.target.projectResourceKey !== project.projectResourceKey
    || candidate.target.projectLocator.physicalProjectDir !== project.physicalProjectDir) {
    fail("state-write-failed", "revision candidate target is not owned by the exact application/project generation");
  }
  if (generation.mode === "execution" && (!attemptBound || !("attemptId" in candidate.transition)
      || candidate.transition.attemptId !== generation.run.record.attemptId)) {
    fail("state-write-failed", "revision candidate attempt does not match its execution owner generation");
  }
}

function assertRecoveryStoreAuthority(
  requestValue: RunStoreMutationRequestV1,
  target: { runId: LowercaseUuidV4; tailRevision: number },
  deps: RunLockDependenciesV1,
  rootDir: string,
): void {
  checkedDependencies(deps);
  const request = checkedStoreRequest(requestValue);
  if (request.mode !== "recovery" || request.runId !== target.runId || request.expectedRevision === null
    || (target.tailRevision !== request.expectedRevision && target.tailRevision !== request.expectedRevision + 1)) {
    fail("state-write-failed", "recovery request coordinate/mode does not match linked-tail authority");
  }
  const active = ACTIVE_RECOVERY.get(runGenerationKey(rootDir, request.runId, request.ownerToken));
  if (active === undefined || active.ownerToken !== request.ownerToken || active.runId !== request.runId
    || active.elections.length !== active.owners.length) {
    fail("state-write-failed", "recovery request lacks active exact token elections");
  }
  assertRecoveryRevisionMatchesOwners(rootDir, target.tailRevision, active.owners);
  for (const election of active.elections) assertOwnedElectionCurrent(election, deps);
  for (const owner of active.owners) assertDeadOwnerGeneration(rootDir, owner, deps);
}

export function createLockBackedRunRevisionStore(
  lockDeps: RunLockDependenciesV1,
  storeOptions: RunStoreOptionsV1 = {},
): RunRevisionStoreV1 {
  const checked = checkedDependencies(lockDeps);
  const rootDir = path.resolve(storeOptions.rootDir ?? checked.rootDir);
  if (rootDir !== checked.rootDir) fail("state-write-failed", "run-store root must equal the run-lock dependency root");
  const store = createRunRevisionStore({
    assertMutationAuthority: (request, target) => assertLocalStoreAuthority(request, target, lockDeps, rootDir),
    assertRecoveryAuthority: (request, target) => assertRecoveryStoreAuthority(request, target, lockDeps, rootDir),
    nowUtc: () => checkedNow(lockDeps),
  }, { rootDir });
  const wrapped: RunRevisionStoreV1 = Object.freeze({
    publishSnapshot: store.publishSnapshot,
    publishRevision: (candidate, request) => {
      assertRevisionCandidateOwned(candidate, request, rootDir);
      return store.publishRevision(candidate, request);
    },
    publishHead: store.publishHead,
    readCommittedRun: store.readCommittedRun,
    recoverLinkedTail: store.recoverLinkedTail,
  });
  return wrapped;
}
