import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalJson } from "./runreceiptidentity.js";
import { accumulateRunSnapshotBytes } from "./runrevisionlimits.js";
import {
  RUN_REVISION_MAX,
  RUN_REVISION_MAX_BYTES,
  boundedDiagnostic,
  parseRunHead,
  parseRunRevision,
  parseSnapshotEnvelope,
  type BoundedDiagnosticV1,
  type CanonicalUtcTimestamp,
  type LowercaseUuidV4,
  type RunControlResultV1,
  type RunHeadV1,
  type RunRevisionV1,
  type RunStoreMutationRequestV1,
  type SnapshotEnvelopeV1,
  type SnapshotRefV1,
} from "./runrevisiontypes.js";

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION_FILE = /^(0|[1-9][0-9]*)\.json$/;
const STAGING_UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const STAGING_PID = "[1-9][0-9]*";
const REVISION_STAGING = new RegExp(`^\\.(0|[1-9][0-9]*)\\.json\\.${STAGING_PID}\\.${STAGING_UUID}\\.tmp$`);
const HEAD_STAGING = new RegExp(`^\\.HEAD\\.json\\.${STAGING_PID}\\.${STAGING_UUID}\\.tmp$`);
const OBJECT_STAGING = new RegExp(`^\\.[a-f0-9]{64}\\.json\\.${STAGING_PID}\\.${STAGING_UUID}\\.tmp$`);
const OBJECT_FILE = new RegExp(`^${SHA256.source.slice(1, -1)}\\.json$`);
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_ROOT_ENTRIES = 4_096;
const MAX_RUN_ENTRIES = 1_024;
const MAX_NESTED_RUN_ENTRIES = 65_536;
const MAX_AGGREGATE_REVISIONS = 16_384;
const MAX_OBJECTS = 32_768;
const MAX_ROOT_CANONICAL_BYTES = 512 * 1024 * 1024;
const MAX_ISSUES = 64;

const SNAPSHOT_DIRECTORY: Readonly<Record<SnapshotRefV1["kind"], string>> = Object.freeze({
  goal: "goal",
  acceptance: "acceptance",
  "app-spec": "spec",
  "brief-payload": "brief",
  "external-input": "external",
  "compiler-ledger": "compiler",
  "public-result": "result",
});
const SNAPSHOT_KINDS = new Set(Object.keys(SNAPSHOT_DIRECTORY));
const DIRECTORY_SNAPSHOT_KIND = new Map(Object.entries(SNAPSHOT_DIRECTORY).map(([kind, directory]) => [directory, kind as SnapshotRefV1["kind"]]));
const SNAPSHOT_MAX_BYTES: Readonly<Record<SnapshotRefV1["kind"], number>> = Object.freeze({
  goal: 4 * 1024 * 1024,
  acceptance: 256 * 1024,
  "app-spec": 2 * 1024 * 1024,
  "brief-payload": 3 * 1024 * 1024,
  "external-input": 2 * 1024 * 1024,
  "compiler-ledger": 8 * 1024 * 1024,
  "public-result": 4 * 1024 * 1024,
});

export type RunRevisionStoreDependenciesV1 = Readonly<{
  assertMutationAuthority(
    request: RunStoreMutationRequestV1,
    target: { runId: LowercaseUuidV4; operation: "revision" | "head" },
  ): void;
  assertRecoveryAuthority(
    request: RunStoreMutationRequestV1,
    target: { runId: LowercaseUuidV4; tailRevision: number },
  ): void;
  nowUtc(): CanonicalUtcTimestamp;
}>;

export type RunStoreOptionsV1 = Readonly<{ rootDir?: string }>;

export type RunCoreValidatorsV1 = Readonly<{
  parseRevision(value: unknown): RunRevisionV1;
  parseHead(value: unknown): RunHeadV1;
  parseSnapshot(kind: SnapshotRefV1["kind"], value: unknown): SnapshotEnvelopeV1;
}>;

export type CoreRunChainV1 = Readonly<{
  head: RunHeadV1;
  revisions: readonly RunRevisionV1[];
  snapshots: ReadonlyMap<string, SnapshotEnvelopeV1>;
  issues: readonly BoundedDiagnosticV1[];
  validation: "core-only";
}>;

export type PublishedRevisionV1 = Readonly<{
  revision: RunRevisionV1;
  path: string;
  publication: "linked-head-pending";
}>;

export type RecoveryResultV1 =
  | { status: "unchanged"; chain: CoreRunChainV1 }
  | { status: "head-advanced"; chain: CoreRunChainV1; recoveredRevision: number }
  | (RunControlResultV1 & {
      status: "recovery-required" | "interrupted-in-doubt" |
        "invalid-store" | "state-write-failed";
    });

export type RunRevisionStoreV1 = Readonly<{
  publishSnapshot(kind: SnapshotRefV1["kind"], envelope: SnapshotEnvelopeV1): SnapshotRefV1;
  publishRevision(candidate: RunRevisionV1, request: RunStoreMutationRequestV1): PublishedRevisionV1;
  publishHead(expected: RunHeadV1 | null, next: RunHeadV1, request: RunStoreMutationRequestV1): void;
  readCommittedRun(runId: LowercaseUuidV4, validators: RunCoreValidatorsV1): CoreRunChainV1;
  recoverLinkedTail(runId: LowercaseUuidV4, request: RunStoreMutationRequestV1): RecoveryResultV1;
}>;

type StoreStatus = "invalid-store" | "limit-exceeded" | "recovery-required" | "run-busy" | "state-write-failed";

class RunStoreError extends Error {
  readonly status: StoreStatus;
  readonly issues: readonly BoundedDiagnosticV1[];

  constructor(status: StoreStatus, message: string, issues: readonly BoundedDiagnosticV1[] = []) {
    super(message);
    this.name = "RunStoreError";
    this.status = status;
    this.issues = issues;
  }
}

type StableFile = Readonly<{
  raw: unknown;
  canonical: string;
  storedBytes: number;
  identity: string;
}>;

type Inspection = Readonly<{
  chain: CoreRunChainV1 | null;
  tail: RunRevisionV1 | null;
  headless: boolean;
  directories: ReadonlyMap<string, fs.BigIntStats>;
}>;

type RootScan = Readonly<{
  rootEntries: number;
  nestedEntries: number;
  aggregateRevisions: number;
  canonicalBytes: number;
}>;

type CasCatalogEntry = Readonly<{
  kind: SnapshotRefV1["kind"];
  envelope: SnapshotEnvelopeV1;
  canonical: string;
  canonicalBytes: number;
  identity: string;
  path: string;
}>;

type ObjectsScan = Readonly<{
  count: number;
  canonicalBytes: number;
  objectsEntries: number;
  namespaceEntries: ReadonlyMap<string, number>;
  directories: ReadonlyMap<string, fs.BigIntStats>;
  leaves: ReadonlyMap<string, string>;
  catalog: ReadonlyMap<string, CasCatalogEntry>;
}>;

type HeadPublicationTracker = {
  stage: "before-rename" | "renamed" | "directory-flushed" | "confirmed";
};

function failure(status: StoreStatus, detail: string, issues: readonly BoundedDiagnosticV1[] = []): never {
  throw new RunStoreError(status, detail, issues);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asStoreError(error: unknown, fallback: StoreStatus = "invalid-store"): RunStoreError {
  return error instanceof RunStoreError ? error : new RunStoreError(fallback, errorText(error));
}

function assertRunId(runId: string): asserts runId is LowercaseUuidV4 {
  if (!UUID_V4.test(runId)) failure("invalid-store", "run ID is not a canonical lowercase UUIDv4");
}

function addIssue(issues: BoundedDiagnosticV1[], code: string, detail: string): void {
  if (issues.length < MAX_ISSUES) issues.push(boundedDiagnostic(code, detail));
}

function statIdentity(stat: fs.BigIntStats): string {
  return [
    stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.rdev,
    stat.size, stat.blksize, stat.blocks, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs,
  ].join(":");
}

function sameDescriptor(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.uid === right.uid && left.gid === right.gid
    && left.rdev === right.rdev && left.size === right.size && left.blksize === right.blksize
    && left.blocks === right.blocks && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs;
}

function samePathDescriptorMetadata(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameDescriptor(left, right) && left.atimeNs === right.atimeNs;
}

function sameObjectIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function lstatDirectory(directory: string): fs.BigIntStats {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    failure("invalid-store", `required directory '${directory}' is unavailable: ${errorText(error)}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) failure("invalid-store", `path '${directory}' is not a no-follow directory`);
  return stat;
}

function lstatDirectoryComponents(directory: string): fs.BigIntStats {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let latest = lstatDirectory(current);
  for (const component of relative) {
    current = path.join(current, component);
    latest = lstatDirectory(current);
  }
  return latest;
}

function captureDirectories(paths: readonly string[]): Map<string, fs.BigIntStats> {
  const captured = new Map<string, fs.BigIntStats>();
  for (const directory of paths) captured.set(directory, lstatDirectory(directory));
  return captured;
}

function assertDirectoriesStable(
  before: ReadonlyMap<string, fs.BigIntStats>,
  after: ReadonlyMap<string, fs.BigIntStats>,
  status: StoreStatus = "run-busy",
): void {
  if (before.size !== after.size) failure(status, "store authority directory set changed during validation");
  for (const [directory, stat] of before) {
    const later = after.get(directory);
    if (later === undefined || !sameDescriptor(stat, later)) {
      failure(status, `store authority directory '${directory}' changed during validation`);
    }
  }
}

function assertPublicationDirectories(
  before: ReadonlyMap<string, fs.BigIntStats>,
  after: ReadonlyMap<string, fs.BigIntStats>,
  mutatedDirectory: string,
): void {
  if (before.size !== after.size) failure("state-write-failed", "publication directory set changed");
  for (const [directory, stat] of before) {
    const later = after.get(directory);
    const stable = later !== undefined && (directory === mutatedDirectory
      ? sameObjectIdentity(stat, later)
      : sameDescriptor(stat, later));
    if (!stable) failure("state-write-failed", `publication authority directory '${directory}' was replaced or changed`);
  }
}

function assertDirectoryObjectsStable(
  before: ReadonlyMap<string, fs.BigIntStats>,
  after: ReadonlyMap<string, fs.BigIntStats>,
  status: StoreStatus = "state-write-failed",
): void {
  if (before.size !== after.size) failure(status, "directory identity set changed");
  for (const [directory, stat] of before) {
    const later = after.get(directory);
    if (later === undefined || !sameObjectIdentity(stat, later)) {
      failure(status, `directory '${directory}' was replaced`);
    }
  }
}

function ensureDirectory(directory: string): fs.BigIntStats {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const component of relative) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) failure("invalid-store", `path component '${current}' is not a no-follow directory`);
    } catch (error) {
      if (error instanceof RunStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure("state-write-failed", `cannot inspect '${current}': ${errorText(error)}`);
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        fsyncDirectory(path.dirname(current));
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") failure("state-write-failed", `cannot create '${current}': ${errorText(mkdirError)}`);
      }
      const created = fs.lstatSync(current, { bigint: true });
      if (!created.isDirectory() || created.isSymbolicLink()) failure("invalid-store", `created path '${current}' is not a directory`);
    }
  }
  return lstatDirectory(resolved);
}

function ensureChildDirectory(parent: string, name: string): fs.BigIntStats {
  if (name.length === 0 || name === "." || name === ".." || name.includes(path.sep) || name.includes("/")) {
    failure("invalid-store", "unsafe directory component");
  }
  lstatDirectory(parent);
  const child = path.join(parent, name);
  let created = false;
  try {
    fs.mkdirSync(child, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") failure("state-write-failed", `cannot create '${child}': ${errorText(error)}`);
  }
  if (created) fsyncDirectory(parent);
  return lstatDirectory(child);
}

function optionalDirectory(directory: string): fs.BigIntStats | null {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    failure("invalid-store", `directory '${directory}' cannot be inspected: ${errorText(error)}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) failure("invalid-store", `path '${directory}' is not a no-follow directory`);
  return stat;
}

function optionalLeaf(filePath: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    failure("invalid-store", `leaf '${filePath}' cannot be inspected: ${errorText(error)}`);
  }
}

function assertCapacity(actual: number, maximum: number, detail: string, issues: readonly BoundedDiagnosticV1[] = []): void {
  if (actual > maximum) failure("limit-exceeded", detail, issues);
}

function chargeDeclaredSnapshotBytes(aggregate: { declared: number }, bytes: number): void {
  const next = accumulateRunSnapshotBytes(aggregate.declared, bytes);
  if (next === null) failure("limit-exceeded", "run declared snapshot-byte aggregate exceeded");
  aggregate.declared = next;
}

function chargeActualSnapshotBytes(aggregate: { actual: number }, bytes: number): void {
  const next = accumulateRunSnapshotBytes(aggregate.actual, bytes);
  if (next === null) failure("limit-exceeded", "run actual snapshot-byte aggregate exceeded");
  aggregate.actual = next;
}

function openNoFollow(filePath: string): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  return fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
}

function stableLeafIdentity(filePath: string): string {
  let beforePath: fs.BigIntStats;
  try {
    beforePath = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    failure("invalid-store", `leaf '${filePath}' cannot be inspected: ${errorText(error)}`);
  }
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) {
    failure("invalid-store", `leaf '${filePath}' must be a regular one-link file`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openNoFollow(filePath);
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    if (!descriptorStat.isFile() || descriptorStat.nlink !== 1n || !samePathDescriptorMetadata(beforePath, descriptorStat)) {
      failure("invalid-store", `leaf '${filePath}' changed before open`);
    }
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1n
      || !samePathDescriptorMetadata(afterPath, descriptorStat)) {
      failure("invalid-store", `leaf '${filePath}' changed during inspection`);
    }
    return statIdentity(descriptorStat);
  } catch (error) {
    throw asStoreError(error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readStableCanonical(filePath: string, maxBytes: number, chargeBeforeAllocation?: (bytes: number) => void): StableFile {
  let pathBefore: fs.BigIntStats;
  try {
    pathBefore = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    failure("invalid-store", `required leaf '${filePath}' is unavailable: ${errorText(error)}`);
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1n) {
    failure("invalid-store", `leaf '${filePath}' must be a regular one-link file`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openNoFollow(filePath);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !samePathDescriptorMetadata(pathBefore, before)) {
      failure("invalid-store", `leaf '${filePath}' changed before open`);
    }
    if (before.size <= 0n || before.size > BigInt(maxBytes + 1)) failure("invalid-store", `leaf '${filePath}' exceeds its byte bound`);
    const size = Number(before.size);
    chargeBeforeAllocation?.(size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(descriptor, bytes, offset, size - offset, null);
      if (count === 0) failure("invalid-store", `leaf '${filePath}' ended during read`);
      offset += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, growthProbe, 0, 1, null) !== 0) failure("invalid-store", `leaf '${filePath}' grew during read`);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameDescriptor(before, after)) failure("invalid-store", `leaf '${filePath}' changed during read`);
    const pathAfter = fs.lstatSync(filePath, { bigint: true });
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1n
      || !samePathDescriptorMetadata(pathAfter, after)) failure("invalid-store", `leaf '${filePath}' was replaced during read`);
    if (bytes[bytes.length - 1] !== 0x0a) failure("invalid-store", `leaf '${filePath}' lacks its publication newline`);
    const canonicalBytes = bytes.subarray(0, bytes.length - 1);
    if (canonicalBytes.includes(0x0a) || canonicalBytes.includes(0x0d)) failure("invalid-store", `leaf '${filePath}' has noncanonical line breaks`);
    const canonical = canonicalBytes.toString("utf8");
    let raw: unknown;
    try { raw = JSON.parse(canonical); } catch (error) { failure("invalid-store", `leaf '${filePath}' is not JSON: ${errorText(error)}`); }
    if (canonicalJson(raw) !== canonical) failure("invalid-store", `leaf '${filePath}' bytes are not canonical JSON plus one newline`);
    return { raw, canonical, storedBytes: size, identity: statIdentity(after) };
  } catch (error) {
    throw asStoreError(error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
}

function createStaging(directory: string, basename: string, bytes: Buffer): string {
  const staging = path.join(directory, `.${basename}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
  try {
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return staging;
}

function publishCreateOnly(target: string, bytes: Buffer, allowIdentical: boolean): void {
  const directory = path.dirname(target);
  const directoryBefore = lstatDirectory(directory);
  const staging = createStaging(directory, path.basename(target), bytes);
  let linked = false;
  try {
    try {
      fs.linkSync(staging, target);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !allowIdentical) {
        throw new Error(`immutable target '${target}' already exists or could not be linked: ${errorText(error)}`);
      }
      const existing = readStableCanonical(target, Math.max(bytes.length, RUN_REVISION_MAX_BYTES));
      if (!Buffer.from(`${existing.canonical}\n`, "utf8").equals(bytes)) {
        throw new Error(`content-addressed target '${target}' already exists with different bytes`);
      }
    }
    fs.unlinkSync(staging);
    fsyncDirectory(directory);
    const directoryAfter = lstatDirectory(directory);
    if (!sameObjectIdentity(directoryBefore, directoryAfter)) {
      failure("state-write-failed", `publication directory '${directory}' was replaced`);
    }
  } finally {
    if (!linked) {
      let removed = false;
      try { fs.unlinkSync(staging); removed = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (removed) fsyncDirectory(directory);
    }
  }
}

function exactHead(left: RunHeadV1, right: RunHeadV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function scanDirectory(directory: string, maximum: number, visit: (name: string) => void): number {
  const before = lstatDirectory(directory);
  const handle = fs.opendirSync(directory);
  let count = 0;
  try {
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      count += 1;
      if (count > maximum) failure("limit-exceeded", `directory '${directory}' exceeds its ${maximum}-entry bound`);
      visit(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  const after = lstatDirectory(directory);
  if (!sameDescriptor(before, after)) failure("run-busy", `directory '${directory}' changed during streaming enumeration`);
  return count;
}

function scanRoot(root: string, issues: BoundedDiagnosticV1[]): RootScan {
  let nestedEntries = 0;
  let aggregateRevisions = 0;
  let canonicalBytes = 0;
  const rootEntries = scanDirectory(root, MAX_ROOT_ENTRIES, (name) => {
    const target = path.join(root, name);
    const stat = fs.lstatSync(target, { bigint: true });
    if (stat.isSymbolicLink()) failure("invalid-store", `root entry '${name}' is a symbolic link`, issues);
    if (name === "objects") {
      if (!stat.isDirectory()) failure("invalid-store", "root objects entry is not a directory", issues);
      return;
    }
    if (name === "locks" || name === "staging") {
      if (!stat.isDirectory()) failure("invalid-store", `reserved root entry '${name}' is not a directory`, issues);
      addIssue(issues, "reserved-root-entry", `reserved root entry '${name}' was encountered`);
      return;
    }
    if (name.startsWith(".")) failure("invalid-store", `unknown or unsafe root entry '${name}'`, issues);
    if (!UUID_V4.test(name) || !stat.isDirectory()) failure("invalid-store", `unknown or unsafe root entry '${name}'`, issues);
    const runDirectory = target;
    scanDirectory(runDirectory, MAX_RUN_ENTRIES, (runName) => {
      nestedEntries += 1;
      if (nestedEntries > MAX_NESTED_RUN_ENTRIES) failure("limit-exceeded", "aggregate nested run-entry bound exceeded", issues);
      const runTarget = path.join(runDirectory, runName);
      const runStat = fs.lstatSync(runTarget, { bigint: true });
      if (runStat.isSymbolicLink()) failure("invalid-store", `unsafe run entry '${runTarget}'`, issues);
      if (runName === "revisions") {
        if (!runStat.isDirectory()) failure("invalid-store", `revisions path '${runTarget}' is not a directory`, issues);
        scanDirectory(runTarget, MAX_RUN_ENTRIES, (revisionName) => {
          nestedEntries += 1;
          if (nestedEntries > MAX_NESTED_RUN_ENTRIES) failure("limit-exceeded", "aggregate nested run-entry bound exceeded", issues);
          const revisionTarget = path.join(runTarget, revisionName);
          const revisionStat = fs.lstatSync(revisionTarget, { bigint: true });
          if (!revisionStat.isFile() || revisionStat.isSymbolicLink() || revisionStat.nlink !== 1n) failure("invalid-store", `unsafe revision entry '${revisionTarget}'`, issues);
          stableLeafIdentity(revisionTarget);
          if (REVISION_FILE.test(revisionName)) {
            if (revisionStat.size <= 0n || revisionStat.size > BigInt(RUN_REVISION_MAX_BYTES + 1)) failure("invalid-store", `revision leaf '${revisionTarget}' exceeds its byte bound`, issues);
            aggregateRevisions += 1;
            if (aggregateRevisions > MAX_AGGREGATE_REVISIONS) failure("limit-exceeded", "aggregate revision-envelope bound exceeded", issues);
            if (revisionStat.size > BigInt(MAX_ROOT_CANONICAL_BYTES)) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
            canonicalBytes += Number(revisionStat.size - 1n);
            if (canonicalBytes > MAX_ROOT_CANONICAL_BYTES) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
          } else if (REVISION_STAGING.test(revisionName)) {
            if (revisionStat.size > BigInt(MAX_ROOT_CANONICAL_BYTES)) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
            canonicalBytes += Number(revisionStat.size);
            if (canonicalBytes > MAX_ROOT_CANONICAL_BYTES) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
            addIssue(issues, "revision-staging-leftover", `unpublished revision staging leaf '${revisionName}' was preserved`);
          } else failure("invalid-store", `unknown revision entry '${revisionTarget}'`, issues);
        });
        return;
      }
      if (runName === "HEAD.json") {
        if (!runStat.isFile() || runStat.nlink !== 1n) failure("invalid-store", `unsafe HEAD leaf '${runTarget}'`, issues);
        if (runStat.size <= 0n || runStat.size > BigInt(MAX_HEAD_BYTES + 1)) failure("invalid-store", `HEAD leaf '${runTarget}' exceeds its byte bound`, issues);
        canonicalBytes += Number(runStat.size - 1n);
        if (canonicalBytes > MAX_ROOT_CANONICAL_BYTES) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
        stableLeafIdentity(runTarget);
        return;
      }
      if (HEAD_STAGING.test(runName) && runStat.isFile() && runStat.nlink === 1n) {
        stableLeafIdentity(runTarget);
        if (runStat.size > BigInt(MAX_ROOT_CANONICAL_BYTES)) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
        canonicalBytes += Number(runStat.size);
        if (canonicalBytes > MAX_ROOT_CANONICAL_BYTES) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
        addIssue(issues, "head-staging-leftover", `unpublished HEAD staging leaf '${runName}' was preserved`);
        return;
      }
      failure("invalid-store", `unknown run entry '${runTarget}'`, issues);
    });
  });
  return { rootEntries, nestedEntries, aggregateRevisions, canonicalBytes };
}

function scanObjects(
  root: string,
  issues: BoundedDiagnosticV1[],
  validators: RunCoreValidatorsV1,
  initialCanonicalBytes = 0,
  runRefs: ReadonlyMap<string, SnapshotRefV1> | null = null,
  runAggregate: { actual: number } | null = null,
): ObjectsScan {
  const objects = path.join(root, "objects");
  lstatDirectory(objects);
  const identities = new Set<string>();
  const namespaceEntries = new Map<string, number>();
  const directories = new Map<string, fs.BigIntStats>();
  const leaves = new Map<string, string>();
  const catalog = new Map<string, CasCatalogEntry>();
  let bytes = initialCanonicalBytes;
  const objectsEntries = scanDirectory(objects, Object.keys(SNAPSHOT_DIRECTORY).length, (directoryName) => {
    const kind = DIRECTORY_SNAPSHOT_KIND.get(directoryName);
    if (kind === undefined) failure("invalid-store", `unknown CAS namespace '${directoryName}'`, issues);
    const directory = path.join(objects, directoryName);
    lstatDirectory(directory);
    const entryCount = scanDirectory(directory, MAX_OBJECTS + 1, (name) => {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) failure("invalid-store", `CAS leaf '${target}' is not a regular one-link file`, issues);
      const identity = `${stat.dev}:${stat.ino}`;
      if (!identities.has(identity)) {
        identities.add(identity);
        if (identities.size > MAX_OBJECTS) failure("limit-exceeded", `CAS object aggregate exceeds ${MAX_OBJECTS}`, issues);
      }
      if (OBJECT_STAGING.test(name)) {
        if (stat.size > BigInt(MAX_ROOT_CANONICAL_BYTES)) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
        bytes += Number(stat.size);
        if (bytes > MAX_ROOT_CANONICAL_BYTES) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
        leaves.set(target, stableLeafIdentity(target));
        addIssue(issues, "cas-staging-leftover", `unpublished CAS staging leaf '${name}' was preserved`);
        return;
      }
      if (!OBJECT_FILE.test(name)) failure("invalid-store", `unknown CAS leaf '${name}'`, issues);
      const digest = name.slice(0, -".json".length);
      const key = `${kind}:${digest}`;
      const stable = readStableCanonical(target, SNAPSHOT_MAX_BYTES[kind], (storedBytes) => {
        const canonicalBytes = Math.max(0, storedBytes - 1);
        if (runRefs?.has(key) && runAggregate !== null) chargeActualSnapshotBytes(runAggregate, canonicalBytes);
        bytes += canonicalBytes;
        if (bytes > MAX_ROOT_CANONICAL_BYTES) failure("limit-exceeded", "root canonical-byte aggregate exceeded", issues);
      });
      if (crypto.createHash("sha256").update(stable.canonical).digest("hex") !== digest) {
        failure("invalid-store", `CAS leaf '${name}' filename digest mismatch`, issues);
      }
      let envelope: SnapshotEnvelopeV1;
      try { envelope = validators.parseSnapshot(kind, stable.raw); } catch (error) {
        failure("invalid-store", `${kind} snapshot '${name}' is invalid: ${errorText(error)}`, issues);
      }
      if (canonicalJson(envelope) !== stable.canonical) {
        failure("invalid-store", `${kind} snapshot '${name}' parser projection is noncanonical`, issues);
      }
      catalog.set(key, {
        kind,
        envelope,
        canonical: stable.canonical,
        canonicalBytes: Buffer.byteLength(stable.canonical),
        identity: stable.identity,
        path: target,
      });
      leaves.set(target, stable.identity);
    });
    namespaceEntries.set(directoryName, entryCount);
    directories.set(directory, lstatDirectory(directory));
  });
  directories.set(objects, lstatDirectory(objects));
  return {
    count: identities.size,
    canonicalBytes: bytes,
    objectsEntries,
    namespaceEntries,
    directories,
    leaves,
    catalog,
  };
}

function collectSnapshotRefs(value: unknown, refs: Map<string, SnapshotRefV1>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSnapshotRefs(item, refs);
    return;
  }
  const object = value as Record<string, unknown>;
  if (typeof object.kind === "string" && SNAPSHOT_KINDS.has(object.kind)
    && object.algorithm === "sha256" && typeof object.sha256 === "string" && typeof object.bytes === "number") {
    const ref = object as SnapshotRefV1;
    const key = `${ref.kind}:${ref.sha256}`;
    const prior = refs.get(key);
    if (prior !== undefined && prior.bytes !== ref.bytes) {
      failure("invalid-store", `snapshot ref '${key}' has conflicting declared byte counts`);
    }
    if (prior === undefined) refs.set(key, ref);
  }
  for (const child of Object.values(object)) collectSnapshotRefs(child, refs);
}

function collectRunSnapshotRefs(
  revisions: readonly RunRevisionV1[],
  aggregate: { declared: number },
): Map<string, SnapshotRefV1> {
  const refs = new Map<string, SnapshotRefV1>();
  for (const revision of revisions) collectSnapshotRefs(revision, refs);
  for (const [key, ref] of refs) {
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || !SHA256.test(ref.sha256)) failure("invalid-store", `snapshot ref '${key}' is malformed`);
    chargeDeclaredSnapshotBytes(aggregate, ref.bytes);
  }
  return refs;
}

function validateSnapshots(
  refs: ReadonlyMap<string, SnapshotRefV1>,
  catalog: ReadonlyMap<string, CasCatalogEntry>,
): Map<string, SnapshotEnvelopeV1> {
  const snapshots = new Map<string, SnapshotEnvelopeV1>();
  for (const [key, ref] of refs) {
    const entry = catalog.get(key);
    if (entry === undefined) failure("invalid-store", `required snapshot '${key}' is unavailable from the CAS catalog`);
    if (entry.canonicalBytes !== ref.bytes) failure("invalid-store", `snapshot '${key}' declared byte count mismatch`);
    snapshots.set(key, entry.envelope);
  }
  return snapshots;
}

function readRevisionFile(filePath: string, number: number, validator: RunCoreValidatorsV1["parseRevision"]): RunRevisionV1 {
  const stable = readStableCanonical(filePath, RUN_REVISION_MAX_BYTES);
  let parsed: RunRevisionV1;
  try { parsed = validator(stable.raw); } catch (error) { failure("invalid-store", `revision ${number} is invalid: ${errorText(error)}`); }
  if (parsed.revision !== number || canonicalJson(parsed) !== stable.canonical) failure("invalid-store", `revision filename or canonical projection mismatch at ${number}`);
  return parsed;
}

function revalidateLeaves(leaves: ReadonlyMap<string, string>): void {
  for (const [filePath, identity] of leaves) {
    if (stableLeafIdentity(filePath) !== identity) failure("run-busy", `CAS leaf '${filePath}' changed after enumeration`);
  }
}

function completeInspectionDirectories(
  root: string,
  rootBefore: fs.BigIntStats,
  runDirectory: string,
  runBefore: fs.BigIntStats,
  revisionsDirectory: string,
  revisionsBefore: fs.BigIntStats,
  objects: ObjectsScan,
): Map<string, fs.BigIntStats> {
  const before = new Map<string, fs.BigIntStats>([
    [root, rootBefore],
    [runDirectory, runBefore],
    [revisionsDirectory, revisionsBefore],
  ]);
  for (const [directory, stat] of objects.directories) before.set(directory, stat);
  const after = captureDirectories([...before.keys()]);
  assertDirectoriesStable(before, after);
  revalidateLeaves(objects.leaves);
  return after;
}

function inspectRun(root: string, runId: LowercaseUuidV4, validators: RunCoreValidatorsV1): Inspection {
  assertRunId(runId);
  const issues: BoundedDiagnosticV1[] = [];
  lstatDirectoryComponents(root);
  const rootBefore = lstatDirectory(root);
  const rootScan = scanRoot(root, issues);
  const runDirectory = path.join(root, runId);
  const runBefore = lstatDirectory(runDirectory);
  const revisionsDirectory = path.join(runDirectory, "revisions");
  const revisionsBefore = lstatDirectory(revisionsDirectory);
  const headFile = path.join(runDirectory, "HEAD.json");
  const selectedLeaves = new Map<string, string>();
  let headExists = false;
  let directEntries = 0;
  scanDirectory(runDirectory, MAX_RUN_ENTRIES, (name) => {
    directEntries += 1;
    if (name === "HEAD.json" || name === "revisions") return;
    const target = path.join(runDirectory, name);
    const stat = fs.lstatSync(target, { bigint: true });
    if (HEAD_STAGING.test(name) && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n) {
      selectedLeaves.set(target, stableLeafIdentity(target));
      addIssue(issues, "head-staging-leftover", `unpublished HEAD staging leaf '${name}' was preserved`);
      return;
    }
    failure("invalid-store", `unknown or unsafe run entry '${name}'`, issues);
  });
  void directEntries;
  try {
    const stat = fs.lstatSync(headFile, { bigint: true });
    headExists = stat.isFile() && !stat.isSymbolicLink();
    if (!headExists || stat.nlink !== 1n) failure("invalid-store", "HEAD must be a regular one-link leaf", issues);
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure("invalid-store", `HEAD inspection failed: ${errorText(error)}`, issues);
  }
  const numbers = new Set<number>();
  let stagingCount = 0;
  scanDirectory(revisionsDirectory, MAX_RUN_ENTRIES, (name) => {
    const target = path.join(revisionsDirectory, name);
    const stat = fs.lstatSync(target, { bigint: true });
    if (REVISION_STAGING.test(name)) {
      stagingCount += 1;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) failure("invalid-store", `revision staging leaf '${name}' is unsafe or aliases a target`, issues);
      selectedLeaves.set(target, stableLeafIdentity(target));
      addIssue(issues, "revision-staging-leftover", `unpublished revision staging leaf '${name}' was preserved`);
      return;
    }
    const match = REVISION_FILE.exec(name);
    if (match === null || !stat.isFile() || stat.isSymbolicLink()) failure("invalid-store", `unknown or unsafe revision entry '${name}'`, issues);
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number >= RUN_REVISION_MAX || stat.nlink !== 1n) failure("invalid-store", `revision leaf '${name}' is out of range or multiply linked`, issues);
    if (numbers.has(number)) failure("invalid-store", `duplicate revision number ${number}`, issues);
    selectedLeaves.set(target, stableLeafIdentity(target));
    numbers.add(number);
  });
  void stagingCount;
  if (!headExists) {
    if (numbers.size !== 1 || !numbers.has(0)) failure("invalid-store", "headless run is not the recoverable revision-zero cut", issues);
    const zero = readRevisionFile(path.join(revisionsDirectory, "0.json"), 0, validators.parseRevision);
    if (zero.runId !== runId || zero.parent !== null) failure("invalid-store", "headless revision zero coordinate mismatch", issues);
    const aggregate = { declared: 0, actual: 0 };
    const refs = collectRunSnapshotRefs([zero], aggregate);
    const objects = scanObjects(root, issues, validators, rootScan.canonicalBytes, refs, aggregate);
    validateSnapshots(refs, objects.catalog);
    revalidateLeaves(selectedLeaves);
    const directories = completeInspectionDirectories(
      root, rootBefore, runDirectory, runBefore, revisionsDirectory, revisionsBefore, objects,
    );
    return { chain: null, tail: zero, headless: true, directories };
  }
  const firstHead = readStableCanonical(headFile, MAX_HEAD_BYTES);
  selectedLeaves.set(headFile, firstHead.identity);
  let head: RunHeadV1;
  try { head = validators.parseHead(firstHead.raw); } catch (error) { failure("invalid-store", `HEAD is invalid: ${errorText(error)}`, issues); }
  if (head.runId !== runId || canonicalJson(head) !== firstHead.canonical) failure("invalid-store", "HEAD coordinate or canonical projection mismatch", issues);
  const revisions: RunRevisionV1[] = [];
  for (let number = 0; number <= head.revision; number += 1) {
    if (!numbers.has(number)) failure("invalid-store", `revision chain gap at ${number}`, issues);
    const revision = readRevisionFile(path.join(revisionsDirectory, `${number}.json`), number, validators.parseRevision);
    if (revision.runId !== runId) failure("invalid-store", `revision ${number} run ID mismatch`, issues);
    if (number === 0) {
      if (revision.parent !== null) failure("invalid-store", "revision zero has a parent", issues);
    } else {
      const previous = revisions[number - 1];
      if (revision.parent?.revision !== previous.revision || revision.parent.revisionId !== previous.revisionId) {
        failure("invalid-store", `revision ${number} parent mismatch`, issues);
      }
    }
    revisions.push(revision);
  }
  const committed = revisions[revisions.length - 1];
  if (committed.revisionId !== head.revisionId) failure("invalid-store", "HEAD revision identity mismatch", issues);
  const later = [...numbers].filter((number) => number > head.revision);
  let tail: RunRevisionV1 | null = null;
  if (later.length > 0) {
    if (later.length !== 1 || later[0] !== head.revision + 1) failure("invalid-store", "revision chain has a gap or more than one unexplained tail", issues);
    tail = readRevisionFile(path.join(revisionsDirectory, `${later[0]}.json`), later[0], validators.parseRevision);
    if (tail.runId !== runId || tail.parent?.revision !== head.revision || tail.parent.revisionId !== head.revisionId) {
      failure("invalid-store", "linked tail parent mismatch", issues);
    }
  }
  const allValidated = tail === null ? revisions : [...revisions, tail];
  const aggregate = { declared: 0, actual: 0 };
  const refs = collectRunSnapshotRefs(allValidated, aggregate);
  const objects = scanObjects(root, issues, validators, rootScan.canonicalBytes, refs, aggregate);
  const snapshots = validateSnapshots(refs, objects.catalog);
  const secondHead = readStableCanonical(headFile, MAX_HEAD_BYTES);
  if (firstHead.identity !== secondHead.identity || firstHead.canonical !== secondHead.canonical) failure("run-busy", "HEAD changed during validation", issues);
  revalidateLeaves(selectedLeaves);
  const directories = completeInspectionDirectories(
    root, rootBefore, runDirectory, runBefore, revisionsDirectory, revisionsBefore, objects,
  );
  const chain: CoreRunChainV1 = { head, revisions, snapshots, issues, validation: "core-only" };
  return { chain, tail, headless: false, directories };
}

function readForPublic(root: string, runId: LowercaseUuidV4, validators: RunCoreValidatorsV1): CoreRunChainV1 {
  const inspected = inspectRun(root, runId, validators);
  if (inspected.tail !== null) failure("recovery-required", "one publication-complete linked revision is ahead of HEAD", inspected.chain?.issues);
  if (inspected.chain === null) failure("recovery-required", "revision zero is linked without HEAD");
  return inspected.chain;
}

function controlResult(
  status: "recovery-required" | "interrupted-in-doubt" | "invalid-store" | "state-write-failed",
  detail: string,
  request: RunStoreMutationRequestV1,
  head: RunHeadV1 | null,
  issues: readonly BoundedDiagnosticV1[],
  options: Readonly<{
    publication?: "unchanged" | "unknown" | "advanced";
    inDoubtRevision?: RunRevisionV1 | null;
  }> = {},
): RunControlResultV1 & { status: typeof status } {
  const publication = options.publication ?? "unchanged";
  const inDoubtRevision = options.inDoubtRevision ?? null;
  const priorAttemptExternalSideEffects = inDoubtRevision?.transition.type === "attempt-in-doubt"
    ? inDoubtRevision.transition.externalMutationDisposition
    : inDoubtRevision?.transition.type === "attempt-started" ? "possible" : null;
  return {
    status,
    runId: head?.runId ?? null,
    revision: head?.revision ?? null,
    revisionId: head?.revisionId ?? null,
    expectedRevision: null,
    actualRevision: null,
    actualRevisionId: null,
    runStateByThisCall: publication === "advanced" ? "durably-advanced"
      : publication === "unknown" ? "publication-in-doubt" : "unchanged",
    externalSideEffectsByThisCall: "none",
    priorAttemptExternalSideEffects,
    activeAttemptExternalSideEffects: null,
    inDoubtAttemptCompletion: null,
    runRevisionCommitted: publication === "advanced" ? true : null,
    runRevisionPublication: publication === "advanced" ? "head-authoritative"
      : publication === "unknown" ? "unknown" : null,
    expectedGeneration: null,
    observedGeneration: null,
    historicalResult: null,
    issues: [...issues].slice(0, MAX_ISSUES),
    detail,
    fix: status === "interrupted-in-doubt"
      ? `Retain the run execution owners and inspect run ${request.runId}; V1 cannot replay an interrupted attempt.`
      : `Inspect and repair the bounded run store for ${request.runId}; do not delete immutable history by hand.`,
  };
}

function isInDoubtRevision(revision: RunRevisionV1): boolean {
  return revision.transition.type === "attempt-started" || revision.transition.type === "attempt-in-doubt";
}

export function runStoreRoot(options: RunStoreOptionsV1 = {}): string {
  if (options.rootDir !== undefined) return path.resolve(options.rootDir);
  if (process.env.PICO_MCP_RUN_DIR) return path.resolve(process.env.PICO_MCP_RUN_DIR);
  return path.join(os.homedir(), ".pico-mcp", "runs");
}

export function createRunRevisionStore(
  deps: RunRevisionStoreDependenciesV1,
  options: RunStoreOptionsV1 = {},
): RunRevisionStoreV1 {
  if (typeof deps?.assertMutationAuthority !== "function" || typeof deps?.assertRecoveryAuthority !== "function"
    || typeof deps?.nowUtc !== "function") throw new Error("run revision store requires explicit mutation and recovery authority dependencies");
  const root = runStoreRoot(options);
  const builtinValidators: RunCoreValidatorsV1 = {
    parseRevision: parseRunRevision,
    parseHead: parseRunHead,
    parseSnapshot: parseSnapshotEnvelope,
  };

  const ensureStoreRoot = (): void => { ensureDirectory(root); };

  const scanStore = (
    issues: BoundedDiagnosticV1[],
    refs: ReadonlyMap<string, SnapshotRefV1> | null = null,
    aggregate: { actual: number } | null = null,
  ): { rootScan: RootScan; objects: ObjectsScan | null } => {
    lstatDirectoryComponents(root);
    const rootScan = scanRoot(root, issues);
    const objectsDirectory = path.join(root, "objects");
    const objects = optionalDirectory(objectsDirectory) === null
      ? null
      : scanObjects(root, issues, builtinValidators, rootScan.canonicalBytes, refs, aggregate);
    return { rootScan, objects };
  };

  const publishSnapshot = (kind: SnapshotRefV1["kind"], envelope: SnapshotEnvelopeV1): SnapshotRefV1 => {
    if (!Object.hasOwn(SNAPSHOT_DIRECTORY, kind)) throw new Error(`unknown snapshot kind '${kind}'`);
    let parsed: SnapshotEnvelopeV1;
    try { parsed = parseSnapshotEnvelope(kind, envelope); } catch (error) { throw new Error(`invalid ${kind} snapshot: ${errorText(error)}`); }
    const canonical = canonicalJson(parsed);
    const bytes = Buffer.byteLength(canonical);
    const digest = crypto.createHash("sha256").update(canonical).digest("hex");
    ensureStoreRoot();
    const objects = path.join(root, "objects");
    const directory = path.join(objects, SNAPSHOT_DIRECTORY[kind]);
    const target = path.join(directory, `${digest}.json`);
    const issues: BoundedDiagnosticV1[] = [];
    const current = scanStore(issues);
    const existing = current.objects?.catalog.get(`${kind}:${digest}`);
    if (existing !== undefined) {
      if (existing.canonical !== canonical) failure("invalid-store", `content-addressed target '${target}' has different canonical bytes`, issues);
      return { kind, algorithm: "sha256", sha256: digest, bytes };
    }
    const objectsMissing = current.objects === null;
    const namespaceMissing = optionalDirectory(directory) === null;
    assertCapacity(
      current.rootScan.rootEntries + (objectsMissing ? 1 : 0),
      MAX_ROOT_ENTRIES,
      `root entry capacity ${MAX_ROOT_ENTRIES} is exhausted before objects creation`,
      issues,
    );
    assertCapacity(
      (current.objects?.objectsEntries ?? 0) + (namespaceMissing ? 1 : 0),
      Object.keys(SNAPSHOT_DIRECTORY).length,
      "CAS namespace directory capacity is exhausted",
      issues,
    );
    const namespaceEntryCount = current.objects?.namespaceEntries.get(SNAPSHOT_DIRECTORY[kind]) ?? 0;
    assertCapacity(
      namespaceEntryCount + 2,
      MAX_OBJECTS + 1,
      `CAS namespace staging/link capacity ${MAX_OBJECTS + 1} is exhausted`,
      issues,
    );
    assertCapacity(
      (current.objects?.count ?? 0) + 1,
      MAX_OBJECTS,
      `CAS object aggregate capacity ${MAX_OBJECTS} is exhausted`,
      issues,
    );
    const currentCanonicalBytes = current.objects?.canonicalBytes ?? current.rootScan.canonicalBytes;
    assertCapacity(
      currentCanonicalBytes + (bytes + 1) + bytes,
      MAX_ROOT_CANONICAL_BYTES,
      "root canonical-byte aggregate staging/link capacity is exhausted",
      issues,
    );
    ensureChildDirectory(root, "objects");
    ensureChildDirectory(objects, SNAPSHOT_DIRECTORY[kind]);
    const publicationDirectories = captureDirectories([root, objects, directory]);
    publishCreateOnly(target, Buffer.from(`${canonical}\n`, "utf8"), true);
    assertPublicationDirectories(publicationDirectories, captureDirectories([...publicationDirectories.keys()]), directory);
    return { kind, algorithm: "sha256", sha256: digest, bytes };
  };

  const assertRevisionAdmission = (
    revision: RunRevisionV1,
    canonicalBytes: number,
    priorRevisions: readonly RunRevisionV1[],
  ): { issues: BoundedDiagnosticV1[]; directories: readonly string[] } => {
    const issues: BoundedDiagnosticV1[] = [];
    const declared = { declared: 0 };
    const refs = collectRunSnapshotRefs([...priorRevisions, revision], declared);
    const actual = { actual: 0 };
    const current = scanStore(issues, refs, actual);
    if (current.objects === null) failure("invalid-store", "run revision references a missing objects directory", issues);
    validateSnapshots(refs, current.objects.catalog);
    const runDirectory = path.join(root, revision.runId);
    const revisionsDirectory = path.join(runDirectory, "revisions");
    const runMissing = optionalDirectory(runDirectory) === null;
    const revisionsMissing = optionalDirectory(revisionsDirectory) === null;
    const runEntries = runMissing ? 0 : scanDirectory(runDirectory, MAX_RUN_ENTRIES, () => {});
    const revisionEntries = revisionsMissing ? 0 : scanDirectory(revisionsDirectory, MAX_RUN_ENTRIES, () => {});
    const target = path.join(revisionsDirectory, `${revision.revision}.json`);
    if (optionalLeaf(target) !== null) throw new Error(`immutable revision target '${target}' already exists`);
    assertCapacity(
      current.rootScan.rootEntries + (runMissing ? 1 : 0),
      MAX_ROOT_ENTRIES,
      `root entry capacity ${MAX_ROOT_ENTRIES} is exhausted before run creation`,
      issues,
    );
    assertCapacity(
      runEntries + (revisionsMissing ? 1 : 0),
      MAX_RUN_ENTRIES,
      `run entry capacity ${MAX_RUN_ENTRIES} is exhausted before revisions creation`,
      issues,
    );
    assertCapacity(
      revisionEntries + 2,
      MAX_RUN_ENTRIES,
      `revision staging/link capacity ${MAX_RUN_ENTRIES} is exhausted`,
      issues,
    );
    assertCapacity(
      current.rootScan.nestedEntries + (revisionsMissing ? 1 : 0) + 2,
      MAX_NESTED_RUN_ENTRIES,
      "aggregate nested run-entry capacity is exhausted by revision staging/link",
      issues,
    );
    assertCapacity(
      current.rootScan.aggregateRevisions + 1,
      MAX_AGGREGATE_REVISIONS,
      "aggregate revision-envelope capacity is exhausted",
      issues,
    );
    assertCapacity(
      current.objects.canonicalBytes + (canonicalBytes + 1) + canonicalBytes,
      MAX_ROOT_CANONICAL_BYTES,
      "root canonical-byte aggregate revision staging/link capacity is exhausted",
      issues,
    );
    return {
      issues,
      directories: [root, ...current.objects.directories.keys(), ...(runMissing ? [] : [runDirectory]), ...(revisionsMissing ? [] : [revisionsDirectory])],
    };
  };

  const publishRevision = (candidate: RunRevisionV1, request: RunStoreMutationRequestV1): PublishedRevisionV1 => {
    let revision: RunRevisionV1;
    try { revision = parseRunRevision(candidate); } catch (error) { throw new Error(`invalid run revision candidate: ${errorText(error)}`); }
    assertRunId(revision.runId);
    deps.assertMutationAuthority(request, { runId: revision.runId, operation: "revision" });
    if (request.runId !== revision.runId) throw new Error("mutation request run ID does not match revision target");
    ensureStoreRoot();
    const runDirectory = path.join(root, revision.runId);
    const revisionsDirectory = path.join(runDirectory, "revisions");
    let expectedHead: RunHeadV1 | null = null;
    let priorRevisions: readonly RunRevisionV1[] = [];
    if (revision.revision === 0) {
      if (optionalLeaf(path.join(runDirectory, "HEAD.json")) !== null) throw new Error("revision zero cannot be appended to an existing HEAD");
    } else {
      const chain = readForPublic(root, revision.runId, builtinValidators);
      expectedHead = chain.head;
      priorRevisions = chain.revisions;
      if (chain.head.revision !== revision.revision - 1 || revision.parent?.revision !== chain.head.revision
        || revision.parent.revisionId !== chain.head.revisionId) throw new Error("revision parent does not equal the authoritative HEAD");
    }
    const canonical = canonicalJson(revision);
    const canonicalBytes = Buffer.byteLength(canonical);
    if (canonicalBytes > RUN_REVISION_MAX_BYTES) throw new Error("run revision exceeds canonical byte bound");
    assertRevisionAdmission(revision, canonicalBytes, priorRevisions);
    ensureChildDirectory(root, revision.runId);
    ensureChildDirectory(runDirectory, "revisions");
    if (revision.revision === 0) {
      const entries = scanDirectory(revisionsDirectory, MAX_RUN_ENTRIES, () => {});
      if (entries !== 0) throw new Error("revision-zero target is not an empty immutable run");
    }
    const beforeAuthorityAdmission = assertRevisionAdmission(revision, canonicalBytes, priorRevisions);
    const beforeAuthority = captureDirectories(beforeAuthorityAdmission.directories);
    deps.assertMutationAuthority(request, { runId: revision.runId, operation: "revision" });
    assertDirectoriesStable(beforeAuthority, captureDirectories([...beforeAuthority.keys()]));
    assertRevisionAdmission(revision, canonicalBytes, priorRevisions);
    readExpectedHead(runDirectory, expectedHead);
    if (revision.revision === 0) {
      const entries = scanDirectory(revisionsDirectory, MAX_RUN_ENTRIES, () => {});
      if (entries !== 0) throw new Error("revision-zero target changed before immutable publication");
    } else {
      const final = inspectRun(root, revision.runId, builtinValidators);
      if (final.tail !== null || final.chain === null || !exactHead(final.chain.head, expectedHead!)) {
        throw new Error("authoritative revision chain changed before immutable publication");
      }
    }
    const target = path.join(revisionsDirectory, `${revision.revision}.json`);
    const publicationDirectories = captureDirectories([...beforeAuthority.keys()]);
    publishCreateOnly(target, Buffer.from(`${canonical}\n`, "utf8"), false);
    assertPublicationDirectories(
      publicationDirectories,
      captureDirectories([...publicationDirectories.keys()]),
      revisionsDirectory,
    );
    return { revision, path: target, publication: "linked-head-pending" };
  };

  const readExpectedHead = (runDirectory: string, expected: RunHeadV1 | null): void => {
    const target = path.join(runDirectory, "HEAD.json");
    let exists = true;
    try { fs.lstatSync(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
      else throw error;
    }
    if (expected === null) {
      if (exists) throw new Error("expected absent HEAD but one already exists");
      return;
    }
    if (!exists) throw new Error("expected HEAD is missing");
    const stable = readStableCanonical(target, MAX_HEAD_BYTES);
    const actual = parseRunHead(stable.raw);
    if (!exactHead(actual, expected) || canonicalJson(actual) !== stable.canonical) throw new Error("authoritative HEAD does not match the complete expected coordinate");
  };

  const writeHead = (
    expected: RunHeadV1 | null,
    next: RunHeadV1,
    request: RunStoreMutationRequestV1,
    authority: "mutation" | "recovery",
    tracker: HeadPublicationTracker = { stage: "before-rename" },
  ): void => {
    const runDirectory = path.join(root, next.runId);
    if (expected === null) {
      if (next.revision !== 0) throw new Error("first HEAD must name revision zero");
    } else if (next.revision !== expected.revision + 1) throw new Error("HEAD must advance exactly one revision and never move backward");
    const assertNextInspection = (inspected: Inspection): void => {
      const current = inspected.chain?.head ?? null;
      if ((expected === null) !== (current === null) || (expected !== null && (current === null || !exactHead(current, expected)))) {
        throw new Error("authoritative HEAD does not match the complete expected coordinate");
      }
      const revision = inspected.tail;
      if (revision === null || revision.revision !== next.revision || revision.runId !== next.runId || revision.revisionId !== next.revisionId) {
        throw new Error("next HEAD does not name the exact validated immutable revision tail");
      }
      if (expected === null) {
        if (!inspected.headless || revision.parent !== null) throw new Error("first HEAD is not the narrow revision-zero headless cut");
      } else if (revision.parent?.revision !== expected.revision || revision.parent.revisionId !== expected.revisionId) {
        throw new Error("next revision parent does not match expected HEAD");
      }
    };
    const initial = inspectRun(root, next.runId, builtinValidators);
    assertNextInspection(initial);
    const canonical = canonicalJson(next);
    const canonicalBytes = Buffer.byteLength(canonical);
    {
      const issues: BoundedDiagnosticV1[] = [];
      const current = scanStore(issues);
      if (current.objects === null) failure("invalid-store", "HEAD publication requires the objects directory", issues);
      const runEntries = scanDirectory(runDirectory, MAX_RUN_ENTRIES, () => {});
      assertCapacity(runEntries + 1, MAX_RUN_ENTRIES, "HEAD staging exceeds the run directory entry capacity", issues);
      assertCapacity(current.rootScan.nestedEntries + 1, MAX_NESTED_RUN_ENTRIES, "HEAD staging exceeds the aggregate nested run-entry capacity", issues);
      const replacedBytes = expected === null ? 0 : Buffer.byteLength(canonicalJson(expected));
      assertCapacity(
        current.objects.canonicalBytes + canonicalBytes + 1,
        MAX_ROOT_CANONICAL_BYTES,
        "HEAD staging exceeds the root canonical-byte aggregate",
        issues,
      );
      assertCapacity(
        current.objects.canonicalBytes - replacedBytes + canonicalBytes,
        MAX_ROOT_CANONICAL_BYTES,
        "HEAD publication exceeds the root canonical-byte aggregate",
        issues,
      );
    }
    const staging = createStaging(runDirectory, "HEAD.json", Buffer.from(`${canonical}\n`, "utf8"));
    try {
      const beforeAuthority = captureDirectories([...initial.directories.keys()]);
      assertDirectoryObjectsStable(initial.directories, beforeAuthority);
      if (authority === "mutation") deps.assertMutationAuthority(request, { runId: next.runId, operation: "head" });
      else deps.assertRecoveryAuthority(request, { runId: next.runId, tailRevision: next.revision });
      assertDirectoriesStable(beforeAuthority, captureDirectories([...beforeAuthority.keys()]));
      const final = inspectRun(root, next.runId, builtinValidators);
      assertNextInspection(final);
      const target = path.join(runDirectory, "HEAD.json");
      fs.renameSync(staging, target);
      tracker.stage = "renamed";
      fsyncDirectory(runDirectory);
      tracker.stage = "directory-flushed";
      const committed = readStableCanonical(target, MAX_HEAD_BYTES);
      if (committed.canonical !== canonical) failure("state-write-failed", "HEAD changed after publication");
      assertPublicationDirectories(
        beforeAuthority,
        captureDirectories([...beforeAuthority.keys()]),
        runDirectory,
      );
      tracker.stage = "confirmed";
    } finally {
      let removed = false;
      try { fs.unlinkSync(staging); removed = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (removed) fsyncDirectory(runDirectory);
    }
  };

  const publishHead = (expected: RunHeadV1 | null, candidate: RunHeadV1, request: RunStoreMutationRequestV1): void => {
    let next: RunHeadV1 | null = null;
    try { next = parseRunHead(candidate); } catch (error) { throw new Error(`invalid next HEAD: ${errorText(error)}`); }
    deps.assertMutationAuthority(request, { runId: next.runId, operation: "head" });
    if (request.runId !== next.runId) throw new Error("mutation request run ID does not match HEAD target");
    if (expected !== null) {
      const parsedExpected = parseRunHead(expected);
      if (parsedExpected.runId !== next.runId) throw new Error("expected and next HEAD run IDs differ");
      expected = parsedExpected;
    }
    writeHead(expected, next, request, "mutation");
  };

  const readCommittedRun = (runId: LowercaseUuidV4, validators: RunCoreValidatorsV1): CoreRunChainV1 => {
    return readForPublic(root, runId, validators);
  };

  const recoverLinkedTail = (runId: LowercaseUuidV4, request: RunStoreMutationRequestV1): RecoveryResultV1 => {
    if (request.runId !== runId) {
      return controlResult("invalid-store", "recovery request run ID does not match target", request, null, []);
    }
    let inspected: Inspection;
    try {
      inspected = inspectRun(root, runId, builtinValidators);
    } catch (error) {
      const storeError = asStoreError(error);
      return controlResult(
        storeError.status === "state-write-failed" ? "state-write-failed" : "invalid-store",
        storeError.message,
        request,
        null,
        storeError.issues,
      );
    }
    const currentHead = inspected.chain?.head ?? null;
    const authorityRevision = inspected.tail?.revision ?? currentHead?.revision ?? 0;
    try {
      deps.assertRecoveryAuthority(request, { runId, tailRevision: authorityRevision });
    } catch (error) {
      return controlResult("state-write-failed", `recovery authority rejected: ${errorText(error)}`, request, currentHead, inspected.chain?.issues ?? []);
    }
    if (inspected.tail === null) {
      if (inspected.chain === null) return controlResult("invalid-store", "run has neither HEAD nor recoverable tail", request, null, []);
      const authoritative = inspected.chain.revisions[inspected.chain.revisions.length - 1];
      if (isInDoubtRevision(authoritative)) {
        return controlResult(
          "interrupted-in-doubt",
          "authoritative HEAD retains an interrupted attempt",
          request,
          inspected.chain.head,
          inspected.chain.issues,
          { inDoubtRevision: authoritative },
        );
      }
      return { status: "unchanged", chain: inspected.chain };
    }
    const tail = inspected.tail;
    let next: RunHeadV1 | null = null;
    const tracker: HeadPublicationTracker = { stage: "before-rename" };
    try {
      next = parseRunHead({
        kind: "pico.workflow-run-head",
        schemaVersion: 1,
        runId,
        revision: tail.revision,
        revisionId: tail.revisionId,
        updatedAt: deps.nowUtc(),
      });
      writeHead(currentHead, next, request, "recovery", tracker);
      const chain = readForPublic(root, runId, builtinValidators);
      if (isInDoubtRevision(tail)) {
        return controlResult(
          "interrupted-in-doubt",
          "linked attempt tail became authoritative and remains interrupted in doubt",
          request,
          chain.head,
          chain.issues,
          { publication: "advanced", inDoubtRevision: tail },
        );
      }
      return { status: "head-advanced", chain, recoveredRevision: tail.revision };
    } catch (error) {
      const storeError = asStoreError(error, "state-write-failed");
      const publication = tracker.stage === "renamed" ? "unknown"
        : tracker.stage === "directory-flushed" || tracker.stage === "confirmed" ? "advanced"
          : "unchanged";
      const coordinate = publication === "unchanged" ? currentHead : next;
      return controlResult(
        "state-write-failed",
        storeError.message,
        request,
        coordinate,
        storeError.issues,
        { publication, inDoubtRevision: isInDoubtRevision(tail) ? tail : null },
      );
    }
  };

  return { publishSnapshot, publishRevision, publishHead, readCommittedRun, recoverLinkedTail };
}
