import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { validateCapture, type CaptureCheck } from "./evidence.js";
import { assertCanonicalAppKey, ledgerDirectory } from "./ledger.js";
import {
  canonicalIdentity,
  canonicalJson,
  collectGradleInputIdentity,
  gradleInputManifestPathIssues,
  GRADLE_INPUT_MAX_ENTRIES,
  GRADLE_INPUT_MAX_FILE_BYTES,
  GRADLE_INPUT_MAX_TOTAL_BYTES,
  readAuthoredAppSpecIdentity,
  type AuthoredAppSpecIdentity,
  type CanonicalIdentity,
  type GradleInputIdentity,
} from "./runreceiptidentity.js";

export const RUN_RECEIPT_KIND = "pico.native-run-receipt" as const;
export const RUN_RECEIPT_SCHEMA_VERSION = 1 as const;
export const RUN_RECEIPT_SCOPE = "fleet-native-debug" as const;
export const RUN_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
export const EFFECTIVE_APP_SPEC_MAX_BYTES = 2 * 1024 * 1024;
export const RUN_RECEIPT_MAX_PER_APP = 4_096;
export const APK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const NATIVE_RECEIPT_DIRECTORY = "native-v1" as const;
export const APK_ARTIFACT_DIRECTORY = "artifacts/apk" as const;
export const SPEC_ARTIFACT_DIRECTORY = "artifacts/spec" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ANDROID_PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const ANDROID_COMPONENT_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\/(?:\.[A-Za-z_$][A-Za-z0-9_.$]*|[A-Za-z_$][A-Za-z0-9_.$]*)$/;
const ANDROID_FINGERPRINT_PATTERN = /^[^\s/:]+\/[^\s/:]+\/[^\s/:]+:[^\s/]+\/[^\s/]+(?:[:/][^\s/]+)*$/;
const RESERVED_IDENTITY_PATTERN = /^(?:unknown|unset|unavailable|pending|placeholder|inferred|optimistic|none|null|undefined|n\/?a|not[-_ ]?(?:available|set|known|observed))$/i;
const hashSchema = z.string().regex(SHA256_PATTERN);
const nonemptyStringSchema = z.string().min(1);
const timestampSchema = z.string().datetime({ offset: true });
const byteCountSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();

function observedIdentitySchema(
  label: string,
  maxLength: number,
  grammar: RegExp,
  grammarMessage: string,
): z.ZodType<string> {
  return z.string()
    .min(1)
    .max(maxLength)
    .regex(grammar, grammarMessage)
    .refine((value) => value === value.trim(), `${label} must not contain surrounding whitespace`)
    .refine((value) => !RESERVED_IDENTITY_PATTERN.test(value), `${label} must not use a reserved placeholder`);
}

const packageNameSchema = z.string().regex(ANDROID_PACKAGE_PATTERN, "must be an Android package name");
const sessionIdSchema = observedIdentitySchema(
  "sessionId", 36,
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  "must be a canonical UUIDv4",
);
const serialSchema = observedIdentitySchema("serial", 255, /^[\x21-\x7e]+$/, "must be one printable adb serial token");
const modelSchema = observedIdentitySchema("model", 256, /^[^\u0000-\u001f\u007f]+$/, "must not contain control characters");
const fingerprintSchema = observedIdentitySchema("fingerprint", 1024, ANDROID_FINGERPRINT_PATTERN, "must be an Android build fingerprint");
const bootQemuSchema = z.union([
  z.literal(""),
  observedIdentitySchema("bootQemu", 1, /^[01]$/, "must be the exact observed value '', 0, or 1"),
]);
const bootIdSchema = observedIdentitySchema(
  "bootId", 36,
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  "must be a canonical UUID",
);
const componentSchema = observedIdentitySchema("component", 512, ANDROID_COMPONENT_PATTERN, "must be an Android package/activity component");
const pidStartTicksSchema = observedIdentitySchema(
  "pidStartTicks", 64, /^[1-9][0-9]*$/,
  "must contain positive decimal Linux process-start ticks",
);

const canonicalIdentitySchema = z.object({
  algorithm: z.literal("sha256"),
  sha256: hashSchema,
  bytes: byteCountSchema,
}).strict();

const authoredAppSpecIdentitySchema = z.object({
  algorithm: z.literal("sha256"),
  sha256: hashSchema,
  bytes: byteCountSchema,
  sourcePath: nonemptyStringSchema,
}).strict();

const gradleInputEntrySchema = z.object({
  path: nonemptyStringSchema,
  bytes: byteCountSchema.max(GRADLE_INPUT_MAX_FILE_BYTES),
  sha256: hashSchema,
}).strict();

const gradleInputIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  projectDir: nonemptyStringSchema,
  algorithm: z.literal("sha256"),
  sha256: hashSchema,
  entryCount: z.number().int().nonnegative().max(GRADLE_INPUT_MAX_ENTRIES),
  totalBytes: byteCountSchema.max(GRADLE_INPUT_MAX_TOTAL_BYTES),
  entries: z.array(gradleInputEntrySchema).max(GRADLE_INPUT_MAX_ENTRIES),
}).strict().superRefine((value, context) => {
  if (value.entryCount !== value.entries.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entryCount"],
      message: "Gradle input entryCount must match the entries array length",
    });
  }
  const totalBytes = value.entries.reduce((total, entry) => total + entry.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || value.totalBytes !== totalBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["totalBytes"],
      message: "Gradle input totalBytes must match the entries array byte total",
    });
  }
  if (canonicalIdentity(value.entries).sha256 !== value.sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sha256"],
      message: "Gradle input manifest sha256 must match its canonical entries",
    });
  }
  const entryPaths = value.entries.map((entry) => entry.path);
  const sortedPaths = [...entryPaths].sort();
  if (entryPaths.some((entryPath, index) => entryPath !== sortedPaths[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "Gradle input entries must be sorted by path",
    });
  }
  if (new Set(entryPaths).size !== entryPaths.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "Gradle input entries must not contain duplicate paths",
    });
  }
  for (const message of gradleInputManifestPathIssues(value.entries)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message,
    });
  }
});

const runtimeCaptureObservationSchema = z.object({
  observedAt: timestampSchema,
  foregroundPackage: packageNameSchema,
  foregroundComponent: componentSchema,
  pid: positiveIntegerSchema,
  pidStartTicks: pidStartTicksSchema,
}).strict();

const manifestInspectionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("inspected"),
    tool: nonemptyStringSchema,
    packageName: packageNameSchema,
    versionCode: nonemptyStringSchema,
    versionName: nonemptyStringSchema,
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: nonemptyStringSchema,
  }).strict(),
]);

const signingInspectionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("inspected"),
    tool: z.literal("apksigner"),
    certificateSha256: z.array(hashSchema).min(1),
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: nonemptyStringSchema,
  }).strict(),
]);

const nativeRunReceiptPayloadSchema = z.object({
  kind: z.literal(RUN_RECEIPT_KIND),
  schemaVersion: z.literal(RUN_RECEIPT_SCHEMA_VERSION),
  createdAt: timestampSchema,
  scope: z.literal(RUN_RECEIPT_SCOPE),
  app: packageNameSchema,
  source: z.object({
    authoredAppSpec: authoredAppSpecIdentitySchema,
    effectiveAppSpec: canonicalIdentitySchema.extend({
      bytes: byteCountSchema.max(EFFECTIVE_APP_SPEC_MAX_BYTES - 1),
      artifactPath: nonemptyStringSchema,
    }).strict(),
    gradleInputs: gradleInputIdentitySchema,
  }).strict(),
  build: z.object({
    task: z.literal(":app:assembleDebug"),
    outcome: z.literal("success"),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    outputMetadata: z.object({
      path: nonemptyStringSchema,
      sha256: hashSchema,
      bytes: byteCountSchema,
    }).strict(),
  }).strict(),
  apk: z.object({
    sourcePath: nonemptyStringSchema,
    artifactPath: nonemptyStringSchema,
    sha256: hashSchema,
    bytes: byteCountSchema,
    packageName: packageNameSchema,
    manifestInspection: manifestInspectionSchema,
    signingInspection: signingInspectionSchema,
  }).strict(),
  install: z.object({
    status: z.literal("success"),
    method: z.literal("adb-install-replace"),
    completedAt: timestampSchema,
    packageName: packageNameSchema,
    remoteApkPath: nonemptyStringSchema,
    remoteApkSha256: hashSchema,
    acknowledgementSha256: hashSchema,
  }).strict(),
  runtime: z.object({
    sessionId: sessionIdSchema,
    serial: serialSchema,
    model: modelSchema,
    fingerprint: fingerprintSchema,
    bootQemu: bootQemuSchema,
    bootId: bootIdSchema,
    component: componentSchema,
    launchedAt: timestampSchema,
    launchAcknowledgementSha256: hashSchema,
    pid: positiveIntegerSchema,
    pidStartTicks: pidStartTicksSchema,
  }).strict(),
  capture: z.object({
    capturedAt: timestampSchema,
    sourcePath: nonemptyStringSchema,
    artifactPath: nonemptyStringSchema,
    sha256: hashSchema,
    bytes: byteCountSchema,
    width: positiveIntegerSchema,
    height: positiveIntegerSchema,
    format: z.literal("png"),
    before: runtimeCaptureObservationSchema,
    after: runtimeCaptureObservationSchema,
  }).strict(),
}).strict();

const nativeRunReceiptSchema = nativeRunReceiptPayloadSchema.extend({
  receiptId: hashSchema,
}).strict();

export interface ReceiptStoreOptions {
  rootDir?: string;
  ledgerDir?: string;
}

export interface ReadReceiptOptions extends ReceiptStoreOptions {
  mode?: "historical" | "current";
  projectDir?: string;
}

export interface ApkArtifact {
  sourcePath: string;
  artifactPath: string;
  sha256: string;
  bytes: number;
}

export interface PublishedSpecArtifact extends CanonicalIdentity {
  artifactPath: string;
}

export interface RuntimeCaptureObservation {
  observedAt: string;
  foregroundPackage: string;
  foregroundComponent: string;
  pid: number;
  pidStartTicks: string;
}

export interface NativeRunReceiptPayload {
  kind: "pico.native-run-receipt";
  schemaVersion: 1;
  createdAt: string;
  scope: "fleet-native-debug";
  app: string;
  source: {
    authoredAppSpec: AuthoredAppSpecIdentity;
    effectiveAppSpec: CanonicalIdentity & { artifactPath: string };
    gradleInputs: GradleInputIdentity;
  };
  build: {
    task: ":app:assembleDebug";
    outcome: "success";
    startedAt: string;
    finishedAt: string;
    outputMetadata: { path: string; sha256: string; bytes: number };
  };
  apk: {
    sourcePath: string;
    artifactPath: string;
    sha256: string;
    bytes: number;
    packageName: string;
    manifestInspection:
      | { status: "inspected"; tool: string; packageName: string; versionCode: string; versionName: string }
      | { status: "unavailable"; reason: string };
    signingInspection:
      | { status: "inspected"; tool: "apksigner"; certificateSha256: string[] }
      | { status: "unavailable"; reason: string };
  };
  install: {
    status: "success";
    method: "adb-install-replace";
    completedAt: string;
    packageName: string;
    remoteApkPath: string;
    remoteApkSha256: string;
    acknowledgementSha256: string;
  };
  runtime: {
    sessionId: string;
    serial: string;
    model: string;
    fingerprint: string;
    bootQemu: string;
    bootId: string;
    component: string;
    launchedAt: string;
    launchAcknowledgementSha256: string;
    pid: number;
    pidStartTicks: string;
  };
  capture: {
    capturedAt: string;
    sourcePath: string;
    artifactPath: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    format: "png";
    before: RuntimeCaptureObservation;
    after: RuntimeCaptureObservation;
  };
}

export type NativeRunReceipt = NativeRunReceiptPayload & { receiptId: string };

export type NativeRunReceiptLineageSnapshot = {
  app: string;
  receiptId: string;
  receiptBytes: Buffer;
  sourceReceiptRoot: string;
  sourceLedgerRoot: string;
  apk: { sha256: string; bytes: number };
  effectiveAppSpecBytes: Buffer;
  capture: CaptureCheck;
};

export interface PublishedNativeRunReceipt {
  receipt: NativeRunReceipt;
  receiptId: string;
  receiptPath: string;
}

export type NativeRunReceiptValidation =
  | { status: "valid"; mode: "historical" | "current"; receipt: NativeRunReceipt; receiptPath: string }
  | { status: "invalid"; mode: "historical" | "current"; receiptId: string; issues: string[] };

export type NativeRunReceiptSelection =
  | { status: "valid"; receipt: NativeRunReceipt; receiptPath: string; rejectedCandidates: Array<{ receiptId: string; issues: string[] }> }
  | { status: "none"; rejectedCandidates: Array<{ receiptId: string; issues: string[] }> }
  | { status: "invalid-store"; issues: string[] };

export type ReceiptRuntimeIdentity = Readonly<{
  serial: string;
  model: string;
  fingerprint: string;
  bootQemu: string;
}>;

export type ReceiptCaptureBindingResult =
  | {
      status: "valid";
      binding: Readonly<{ kind: "pico.native-run-receipt"; schemaVersion: 1; receiptId: string; captureSha256: string }>;
      receiptRuntime: ReceiptRuntimeIdentity;
    }
  | { status: "invalid"; reason: string };

type FileSnapshot = { bytes: Buffer; sha256: string; size: number };
type HashSnapshot = { sha256: string; size: number };

export function runReceiptDirectory(): string {
  return process.env.PICO_MCP_RUN_RECEIPT_DIR
    ? path.resolve(process.env.PICO_MCP_RUN_RECEIPT_DIR)
    : path.join(os.homedir(), ".pico-mcp", "run-receipts");
}

function receiptRoot(options: ReceiptStoreOptions = {}): string {
  return options.rootDir ? path.resolve(options.rootDir) : runReceiptDirectory();
}

function receiptLedgerRoot(options: ReceiptStoreOptions = {}): string {
  return options.ledgerDir ? path.resolve(options.ledgerDir) : ledgerDirectory();
}

function apkArtifactDirectory(root: string): string {
  return path.join(root, ...APK_ARTIFACT_DIRECTORY.split("/"));
}

function specArtifactDirectory(root: string): string {
  return path.join(root, ...SPEC_ARTIFACT_DIRECTORY.split("/"));
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameDescriptor(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function openReadOnlyNoFollow(filePath: string): number {
  return fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
}

function snapshotFile(filePath: string, maxBytes: number): FileSnapshot {
  let descriptor: number | undefined;
  try {
    descriptor = openReadOnlyNoFollow(filePath);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`'${filePath}' is not a regular file`);
    if (before.size > BigInt(maxBytes)) throw new Error(`'${filePath}' exceeds the ${maxBytes}-byte limit`);
    const size = Number(before.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(descriptor, bytes, offset, size - offset, null);
      if (count === 0) throw new Error(`'${filePath}' ended while being read`);
      offset += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, growthProbe, 0, 1, null) !== 0) {
      throw new Error(`'${filePath}' grew while being read`);
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameDescriptor(before, after)) throw new Error(`'${filePath}' changed while being read`);
    return { bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function hashFile(filePath: string, maxBytes: number): HashSnapshot {
  let descriptor: number | undefined;
  try {
    descriptor = openReadOnlyNoFollow(filePath);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`'${filePath}' is not a regular file`);
    if (before.size > BigInt(maxBytes)) throw new Error(`'${filePath}' exceeds the ${maxBytes}-byte limit`);
    const size = Number(before.size);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (bytes < size) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - bytes), null);
      if (count === 0) throw new Error(`'${filePath}' ended while being hashed`);
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, growthProbe, 0, 1, null) !== 0) throw new Error(`'${filePath}' grew while being hashed`);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameDescriptor(before, after)) throw new Error(`'${filePath}' changed while being hashed`);
    return { sha256: digest.digest("hex"), size };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function verifyExistingTarget(target: string, expectedSha256: string, expectedBytes: number, maxBytes: number): void {
  let actual: HashSnapshot;
  try {
    actual = hashFile(target, maxBytes);
  } catch (error) {
    throw new Error(`content-addressed target '${target}' already exists but cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actual.sha256 !== expectedSha256 || actual.size !== expectedBytes) {
    throw new Error(`content-addressed target '${target}' already exists with different bytes; refusing to overwrite it`);
  }
}

function publishCanonicalBytes(target: string, bytes: Buffer): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const expectedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const stagingPath = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(stagingPath, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(stagingPath, target);
      fsyncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verifyExistingTarget(target, expectedSha256, bytes.length, Math.max(RUN_RECEIPT_MAX_BYTES, bytes.length));
    }
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(stagingPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function publishApkArtifact(sourcePath: string, options: ReceiptStoreOptions = {}): Promise<ApkArtifact> {
  const sourceRealPath = fs.realpathSync(path.resolve(sourcePath));
  const directory = apkArtifactDirectory(receiptRoot(options));
  fs.mkdirSync(directory, { recursive: true });
  const stagingPath = path.join(directory, `.apk.${process.pid}.${crypto.randomUUID()}.tmp`);
  let sourceDescriptor: number | undefined;
  let stagingDescriptor: number | undefined;
  try {
    sourceDescriptor = fs.openSync(sourceRealPath, "r");
    const before = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`APK source '${sourceRealPath}' is not a regular file`);
    if (before.size <= 0n) throw new Error(`APK source '${sourceRealPath}' is empty`);
    if (before.size > BigInt(APK_MAX_BYTES)) throw new Error(`APK source '${sourceRealPath}' exceeds the ${APK_MAX_BYTES}-byte limit`);
    const size = Number(before.size);
    stagingDescriptor = fs.openSync(stagingPath, "wx", 0o600);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (bytes < size) {
      const count = fs.readSync(sourceDescriptor, buffer, 0, Math.min(buffer.length, size - bytes), null);
      if (count === 0) throw new Error(`APK source '${sourceRealPath}' ended while being copied`);
      let written = 0;
      while (written < count) written += fs.writeSync(stagingDescriptor, buffer, written, count - written);
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (fs.readSync(sourceDescriptor, growthProbe, 0, 1, null) !== 0) {
      throw new Error(`APK source '${sourceRealPath}' grew while being copied`);
    }
    const after = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (!sameDescriptor(before, after)) throw new Error(`APK source '${sourceRealPath}' changed while being copied`);
    fs.fsyncSync(stagingDescriptor);
    fs.closeSync(stagingDescriptor);
    stagingDescriptor = undefined;
    const sha256 = digest.digest("hex");
    const artifactPath = path.join(directory, `${sha256}.apk`);
    try {
      fs.linkSync(stagingPath, artifactPath);
      fsyncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verifyExistingTarget(artifactPath, sha256, bytes, APK_MAX_BYTES);
    }
    return { sourcePath: sourceRealPath, artifactPath, sha256, bytes };
  } finally {
    if (sourceDescriptor !== undefined) {
      try { fs.closeSync(sourceDescriptor); } catch {}
    }
    if (stagingDescriptor !== undefined) {
      try { fs.closeSync(stagingDescriptor); } catch {}
    }
    try { fs.unlinkSync(stagingPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function publishEffectiveSpecArtifact(spec: unknown, options: ReceiptStoreOptions = {}): PublishedSpecArtifact {
  const canonical = canonicalJson(spec);
  const identity = canonicalIdentity(spec);
  const storedBytes = Buffer.from(`${canonical}\n`, "utf8");
  if (storedBytes.length > EFFECTIVE_APP_SPEC_MAX_BYTES) {
    throw new Error(`effective AppSpec stored bytes exceed the ${EFFECTIVE_APP_SPEC_MAX_BYTES}-byte limit`);
  }
  const artifactPath = path.join(specArtifactDirectory(receiptRoot(options)), `${identity.sha256}.json`);
  publishCanonicalBytes(artifactPath, storedBytes);
  return { ...identity, artifactPath };
}

export function publishNativeRunReceipt(payload: NativeRunReceiptPayload, options: ReceiptStoreOptions = {}): PublishedNativeRunReceipt {
  if (payload !== null && typeof payload === "object" && typeof (payload as { app?: unknown }).app === "string") {
    assertCanonicalAppKey((payload as { app: string }).app);
  }
  const parsed = nativeRunReceiptPayloadSchema.parse(payload) as NativeRunReceiptPayload;
  assertCanonicalAppKey(parsed.app);
  const receiptId = crypto.createHash("sha256").update(canonicalJson(parsed)).digest("hex");
  const receipt = { ...parsed, receiptId } as NativeRunReceipt;
  const receiptPath = path.join(receiptRoot(options), NATIVE_RECEIPT_DIRECTORY, parsed.app, `${receiptId}.json`);
  const receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
  if (receiptBytes.length > RUN_RECEIPT_MAX_BYTES) throw new Error(`native run receipt exceeds the ${RUN_RECEIPT_MAX_BYTES}-byte limit`);
  publishCanonicalBytes(receiptPath, receiptBytes);
  return { receipt, receiptId, receiptPath };
}

function invalidResult(mode: "historical" | "current", receiptId: string, issues: string[]): NativeRunReceiptValidation {
  return { status: "invalid", mode, receiptId, issues };
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "receipt"}: ${issue.message}`);
}

function addSnapshotIssues(
  issues: string[],
  label: string,
  filePath: string,
  expectedSha256: string,
  expectedBytes: number,
  maxBytes: number,
): FileSnapshot | undefined {
  try {
    const snapshot = snapshotFile(filePath, maxBytes);
    if (snapshot.sha256 !== expectedSha256) issues.push(`${label} sha256 does not match the receipt`);
    if (snapshot.size !== expectedBytes) issues.push(`${label} byte length does not match the receipt`);
    return snapshot;
  } catch (error) {
    issues.push(`${label} could not be validated: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function addHashIssues(
  issues: string[],
  label: string,
  filePath: string,
  expectedSha256: string,
  expectedBytes: number,
  maxBytes: number,
): HashSnapshot | undefined {
  try {
    const snapshot = hashFile(filePath, maxBytes);
    if (snapshot.sha256 !== expectedSha256) issues.push(`${label} sha256 does not match the receipt`);
    if (snapshot.size !== expectedBytes) issues.push(`${label} byte length does not match the receipt`);
    return snapshot;
  } catch (error) {
    issues.push(`${label} could not be validated: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function expectedApkPath(receipt: NativeRunReceipt, options: ReceiptStoreOptions): string {
  return path.join(apkArtifactDirectory(receiptRoot(options)), `${receipt.apk.sha256}.apk`);
}

function expectedSpecPath(receipt: NativeRunReceipt, options: ReceiptStoreOptions): string {
  return path.join(specArtifactDirectory(receiptRoot(options)), `${receipt.source.effectiveAppSpec.sha256}.json`);
}

function expectedCapturePath(receipt: NativeRunReceipt, options: ReceiptStoreOptions): string {
  return path.join(receiptLedgerRoot(options), "artifacts", `${receipt.capture.sha256}.png`);
}

function validateCrossFieldBindings(receipt: NativeRunReceipt, effectiveSpec: unknown, issues: string[]): void {
  const packageName = receipt.app;
  if (receipt.apk.packageName !== packageName) issues.push("APK packageName must match receipt app");
  if (receipt.install.packageName !== packageName) issues.push("install packageName must match receipt app");
  if (receipt.install.remoteApkSha256 !== receipt.apk.sha256) issues.push("installed remote APK sha256 must match immutable APK sha256");
  if (receipt.apk.manifestInspection.status === "inspected" && receipt.apk.manifestInspection.packageName !== packageName) {
    issues.push("inspected manifest packageName must match receipt app");
  }
  const effectivePackage = effectiveSpec !== null && typeof effectiveSpec === "object" && !Array.isArray(effectiveSpec)
    ? (effectiveSpec as { meta?: { packageName?: unknown } }).meta?.packageName
    : undefined;
  if (effectivePackage !== packageName) issues.push("effective AppSpec packageName must match receipt app");
  const gradleInputs = receipt.source.gradleInputs;
  if (gradleInputs.entries.length > GRADLE_INPUT_MAX_ENTRIES) issues.push(`Gradle input entries exceed the ${GRADLE_INPUT_MAX_ENTRIES}-entry limit`);
  if (gradleInputs.entryCount > GRADLE_INPUT_MAX_ENTRIES) issues.push(`Gradle input entryCount exceeds the ${GRADLE_INPUT_MAX_ENTRIES}-entry limit`);
  if (gradleInputs.totalBytes > GRADLE_INPUT_MAX_TOTAL_BYTES) issues.push(`Gradle input totalBytes exceeds the ${GRADLE_INPUT_MAX_TOTAL_BYTES}-byte limit`);
  if (gradleInputs.entries.some((entry) => entry.bytes > GRADLE_INPUT_MAX_FILE_BYTES)) {
    issues.push(`Gradle input entry bytes exceed the ${GRADLE_INPUT_MAX_FILE_BYTES}-byte per-file limit`);
  }
  if (gradleInputs.entryCount !== gradleInputs.entries.length) issues.push("Gradle input entryCount must match the entries array length");
  const gradleTotalBytes = gradleInputs.entries.reduce((total, entry) => total + entry.bytes, 0);
  if (!Number.isSafeInteger(gradleTotalBytes) || gradleInputs.totalBytes !== gradleTotalBytes) {
    issues.push("Gradle input totalBytes must match the entries array byte total");
  }
  const gradleManifestIdentity = canonicalIdentity(gradleInputs.entries);
  if (gradleManifestIdentity.sha256 !== gradleInputs.sha256) issues.push("Gradle input manifest sha256 must match its canonical entries");
  const gradlePaths = gradleInputs.entries.map((entry) => entry.path);
  const sortedGradlePaths = [...gradlePaths].sort();
  if (gradlePaths.some((entryPath, index) => entryPath !== sortedGradlePaths[index])) issues.push("Gradle input entries must be sorted by path");
  if (new Set(gradlePaths).size !== gradlePaths.length) issues.push("Gradle input entries must not contain duplicate paths");
  const orderedObservations = [
    ["build startedAt", receipt.build.startedAt],
    ["build finishedAt", receipt.build.finishedAt],
    ["install completedAt", receipt.install.completedAt],
    ["runtime launchedAt", receipt.runtime.launchedAt],
    ["capture before observedAt", receipt.capture.before.observedAt],
    ["capture capturedAt", receipt.capture.capturedAt],
    ["capture after observedAt", receipt.capture.after.observedAt],
    ["receipt createdAt", receipt.createdAt],
  ] as const;
  for (let index = 1; index < orderedObservations.length; index += 1) {
    if (Date.parse(orderedObservations[index - 1][1]) > Date.parse(orderedObservations[index][1])) {
      issues.push(`${orderedObservations[index - 1][0]} must not be later than ${orderedObservations[index][0]}`);
    }
  }
  const componentPackage = receipt.runtime.component.split("/", 1)[0];
  if (componentPackage !== packageName) issues.push("runtime component package must match receipt app");
  for (const [label, observation] of [["before", receipt.capture.before], ["after", receipt.capture.after]] as const) {
    if (observation.foregroundPackage !== packageName) issues.push(`${label} foreground package must match receipt app`);
    if (observation.foregroundComponent !== receipt.runtime.component) issues.push(`${label} foreground component must match runtime component`);
    if (observation.pid !== receipt.runtime.pid) issues.push(`${label} PID must match runtime PID`);
    if (observation.pidStartTicks !== receipt.runtime.pidStartTicks) issues.push(`${label} PID start ticks must match runtime PID start ticks`);
  }
}

function isCanonicalPortableStoreRoot(value: unknown): value is string {
  return typeof value === "string"
    && value !== "/"
    && path.posix.isAbsolute(value)
    && !value.includes("\0")
    && !value.includes("\\")
    && !value.endsWith("/")
    && path.posix.normalize(value) === value;
}

export function validateNativeRunReceiptLineageSnapshot(input: NativeRunReceiptLineageSnapshot):
  | { status: "valid"; receipt: NativeRunReceipt; receiptFileSha256: string }
  | { status: "invalid"; receiptId: string; issues: string[] } {
  const receiptId = typeof input?.receiptId === "string" ? input.receiptId : "";
  const issues: string[] = [];
  if (!input || typeof input !== "object") return { status: "invalid", receiptId, issues: ["native lineage snapshot must be an object"] };
  try {
    assertCanonicalAppKey(input.app);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (!SHA256_PATTERN.test(receiptId)) issues.push("receiptId must be 64 lowercase hexadecimal characters");
  if (!Buffer.isBuffer(input.receiptBytes)) {
    issues.push("receipt bytes must be a Buffer");
    return { status: "invalid", receiptId, issues };
  }
  if (input.receiptBytes.length > RUN_RECEIPT_MAX_BYTES) issues.push(`receipt file exceeds the ${RUN_RECEIPT_MAX_BYTES}-byte limit`);

  let raw: unknown;
  try {
    raw = JSON.parse(input.receiptBytes.toString("utf8"));
  } catch (error) {
    issues.push(`receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "invalid", receiptId, issues };
  }
  try {
    if (!input.receiptBytes.equals(Buffer.from(`${canonicalJson(raw)}\n`, "utf8"))) {
      issues.push("receipt file bytes are not canonical JSON plus one newline");
    }
  } catch (error) {
    issues.push(`receipt cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = nativeRunReceiptSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", receiptId, issues: [...issues, ...zodIssues(parsed.error)] };
  const receipt = parsed.data as NativeRunReceipt;
  if (receipt.receiptId !== receiptId) issues.push("receipt filename/requested receipt ID does not match receipt.receiptId");
  if (receipt.app !== input.app) issues.push("receipt app does not match its canonical app directory");
  const { receiptId: storedReceiptId, ...payload } = receipt;
  if (crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex") !== storedReceiptId) {
    issues.push("recomputed receipt ID does not match receipt.receiptId");
  }
  if (!isCanonicalPortableStoreRoot(input.sourceReceiptRoot)) {
    issues.push("sourceReceiptRoot must be a resolved absolute non-root canonical POSIX store path");
  }
  if (!isCanonicalPortableStoreRoot(input.sourceLedgerRoot)) {
    issues.push("sourceLedgerRoot must be a resolved absolute non-root canonical POSIX store path");
  }
  if (issues.length) return { status: "invalid", receiptId, issues };

  const requiredApkPath = path.join(input.sourceReceiptRoot, ...APK_ARTIFACT_DIRECTORY.split("/"), `${receipt.apk.sha256}.apk`);
  if (receipt.apk.artifactPath !== requiredApkPath) issues.push("APK artifactPath is not the exact receipt-store CAS path");
  if (input.apk.sha256 !== receipt.apk.sha256) issues.push("APK CAS sha256 does not match the receipt");
  if (input.apk.bytes !== receipt.apk.bytes) issues.push("APK CAS byte length does not match the receipt");

  const requiredSpecPath = path.join(input.sourceReceiptRoot, ...SPEC_ARTIFACT_DIRECTORY.split("/"), `${receipt.source.effectiveAppSpec.sha256}.json`);
  if (receipt.source.effectiveAppSpec.artifactPath !== requiredSpecPath) issues.push("effective AppSpec artifactPath is not the exact receipt-store CAS path");
  let effectiveSpec: unknown;
  try {
    effectiveSpec = JSON.parse(input.effectiveAppSpecBytes.toString("utf8"));
    const canonical = canonicalJson(effectiveSpec);
    if (!input.effectiveAppSpecBytes.equals(Buffer.from(`${canonical}\n`, "utf8"))) {
      issues.push("effective AppSpec snapshot is not canonical JSON plus one newline");
    }
    const identity = canonicalIdentity(effectiveSpec);
    if (identity.sha256 !== receipt.source.effectiveAppSpec.sha256) issues.push("effective AppSpec sha256 does not match the receipt");
    if (identity.bytes !== receipt.source.effectiveAppSpec.bytes) issues.push("effective AppSpec canonical byte length does not match the receipt");
    if (receipt.source.effectiveAppSpec.algorithm !== "sha256") issues.push("effective AppSpec algorithm is not sha256");
  } catch (error) {
    issues.push(`effective AppSpec snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const requiredCapturePath = path.join(input.sourceLedgerRoot, "artifacts", `${receipt.capture.sha256}.png`);
  if (receipt.capture.artifactPath !== requiredCapturePath) issues.push("capture artifactPath is not the exact ledger CAS path");
  if (!input.capture.ok) {
    issues.push(`capture CAS could not be validated: ${input.capture.reason ?? "unknown capture error"}`);
  } else {
    if (input.capture.format !== receipt.capture.format) issues.push("capture format does not match the receipt");
    if (input.capture.sha256 !== receipt.capture.sha256) issues.push("capture sha256 does not match the receipt");
    if (input.capture.bytes !== receipt.capture.bytes) issues.push("capture byte length does not match the receipt");
    if (input.capture.width !== receipt.capture.width || input.capture.height !== receipt.capture.height) {
      issues.push("capture dimensions do not match the receipt");
    }
  }
  validateCrossFieldBindings(receipt, effectiveSpec, issues);
  return issues.length
    ? { status: "invalid", receiptId, issues }
    : { status: "valid", receipt, receiptFileSha256: crypto.createHash("sha256").update(input.receiptBytes).digest("hex") };
}

function readHistoricalNativeRunReceipt(app: string, receiptId: string, options: ReceiptStoreOptions): NativeRunReceiptValidation {
  const mode = "historical" as const;
  const issues: string[] = [];
  try {
    assertCanonicalAppKey(app);
  } catch (error) {
    return invalidResult(mode, receiptId, [error instanceof Error ? error.message : String(error)]);
  }
  if (!SHA256_PATTERN.test(receiptId)) return invalidResult(mode, receiptId, ["receiptId must be 64 lowercase hexadecimal characters"]);
  const receiptPath = path.join(receiptRoot(options), NATIVE_RECEIPT_DIRECTORY, app, `${receiptId}.json`);
  let file: FileSnapshot;
  try {
    file = snapshotFile(receiptPath, RUN_RECEIPT_MAX_BYTES);
  } catch (error) {
    return invalidResult(mode, receiptId, [`receipt file could not be read: ${error instanceof Error ? error.message : String(error)}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(file.bytes.toString("utf8"));
  } catch (error) {
    return invalidResult(mode, receiptId, [`receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  try {
    if (!file.bytes.equals(Buffer.from(`${canonicalJson(raw)}\n`, "utf8"))) issues.push("receipt file bytes are not canonical JSON plus one newline");
  } catch (error) {
    issues.push(`receipt cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = nativeRunReceiptSchema.safeParse(raw);
  if (!parsed.success) return invalidResult(mode, receiptId, [...issues, ...zodIssues(parsed.error)]);
  const receipt = parsed.data as NativeRunReceipt;
  if (receipt.receiptId !== receiptId) issues.push("receipt filename/requested receipt ID does not match receipt.receiptId");
  if (receipt.app !== app) issues.push("receipt app does not match its canonical app directory");
  const { receiptId: storedReceiptId, ...payload } = receipt;
  const recomputedReceiptId = crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (recomputedReceiptId !== storedReceiptId) issues.push("recomputed receipt ID does not match receipt.receiptId");

  const requiredApkPath = expectedApkPath(receipt, options);
  if (receipt.apk.artifactPath !== requiredApkPath) issues.push("APK artifactPath is not the exact receipt-store CAS path");
  addHashIssues(issues, "APK CAS", requiredApkPath, receipt.apk.sha256, receipt.apk.bytes, APK_MAX_BYTES);

  const requiredSpecPath = expectedSpecPath(receipt, options);
  if (receipt.source.effectiveAppSpec.artifactPath !== requiredSpecPath) issues.push("effective AppSpec artifactPath is not the exact receipt-store CAS path");
  const specSnapshot = (() => {
    try {
      return snapshotFile(requiredSpecPath, EFFECTIVE_APP_SPEC_MAX_BYTES);
    } catch (error) {
      issues.push(`effective AppSpec snapshot could not be validated: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  })();
  let effectiveSpec: unknown;
  if (specSnapshot) {
    try {
      effectiveSpec = JSON.parse(specSnapshot.bytes.toString("utf8"));
      const canonical = canonicalJson(effectiveSpec);
      if (!specSnapshot.bytes.equals(Buffer.from(`${canonical}\n`, "utf8"))) issues.push("effective AppSpec snapshot is not canonical JSON plus one newline");
      const identity = canonicalIdentity(effectiveSpec);
      if (identity.sha256 !== receipt.source.effectiveAppSpec.sha256) issues.push("effective AppSpec sha256 does not match the receipt");
      if (identity.bytes !== receipt.source.effectiveAppSpec.bytes) issues.push("effective AppSpec canonical byte length does not match the receipt");
      if (receipt.source.effectiveAppSpec.algorithm !== "sha256") issues.push("effective AppSpec algorithm is not sha256");
    } catch (error) {
      issues.push(`effective AppSpec snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const requiredCapturePath = expectedCapturePath(receipt, options);
  if (receipt.capture.artifactPath !== requiredCapturePath) issues.push("capture artifactPath is not the exact ledger CAS path");
  const capture = validateCapture(requiredCapturePath);
  if (!capture.ok) {
    issues.push(`capture CAS could not be validated: ${capture.reason ?? "unknown capture error"}`);
  } else {
    if (capture.format !== receipt.capture.format) issues.push("capture format does not match the receipt");
    if (capture.sha256 !== receipt.capture.sha256) issues.push("capture sha256 does not match the receipt");
    if (capture.bytes !== receipt.capture.bytes) issues.push("capture byte length does not match the receipt");
    if (capture.width !== receipt.capture.width || capture.height !== receipt.capture.height) issues.push("capture dimensions do not match the receipt");
  }
  validateCrossFieldBindings(receipt, effectiveSpec, issues);
  return issues.length ? invalidResult(mode, receiptId, issues) : { status: "valid", mode, receipt, receiptPath };
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function validateCurrentProject(receipt: NativeRunReceipt, projectDir: string | undefined, issues: string[]): void {
  if (!projectDir) {
    issues.push("current receipt validation requires projectDir");
    return;
  }
  let projectRealPath: string;
  try {
    projectRealPath = fs.realpathSync(path.resolve(projectDir));
  } catch (error) {
    issues.push(`current project real path could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (projectRealPath !== receipt.source.gradleInputs.projectDir) issues.push("current project real path does not match receipt Gradle projectDir");

  try {
    const authored = readAuthoredAppSpecIdentity(receipt.source.authoredAppSpec.sourcePath);
    if (!canonicalValuesEqual(authored, receipt.source.authoredAppSpec)) issues.push("current authored AppSpec identity does not match the receipt");
  } catch (error) {
    issues.push(`current authored AppSpec could not be validated: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const gradleInputs = collectGradleInputIdentity(projectRealPath);
    if (!canonicalValuesEqual(gradleInputs, receipt.source.gradleInputs)) issues.push("current Gradle input identity does not match the receipt");
  } catch (error) {
    issues.push(`current Gradle inputs could not be validated: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sourceApk = addHashIssues(issues, "current source APK", receipt.apk.sourcePath, receipt.apk.sha256, receipt.apk.bytes, APK_MAX_BYTES);
  if (sourceApk && sourceApk.size === 0) issues.push("current source APK is empty");

  const metadata = addSnapshotIssues(
    issues,
    "current AGP output metadata",
    receipt.build.outputMetadata.path,
    receipt.build.outputMetadata.sha256,
    receipt.build.outputMetadata.bytes,
    RUN_RECEIPT_MAX_BYTES,
  );
  if (!metadata) return;
  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(metadata.bytes.toString("utf8"));
  } catch (error) {
    issues.push(`current AGP output metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const metadataObject = parsedMetadata !== null && typeof parsedMetadata === "object" && !Array.isArray(parsedMetadata)
    ? parsedMetadata as { applicationId?: unknown; variantName?: unknown; elements?: unknown }
    : undefined;
  if (metadataObject?.applicationId !== receipt.app) issues.push("current AGP output metadata applicationId does not match receipt app");
  if (metadataObject?.variantName !== "debug") issues.push("current AGP output metadata variantName is not debug");
  let metadataRealPath: string;
  try {
    metadataRealPath = fs.realpathSync(receipt.build.outputMetadata.path);
    if (!isWithin(projectRealPath, metadataRealPath)) issues.push("current AGP output metadata path is outside the current project real path");
  } catch (error) {
    issues.push(`current AGP output metadata real path could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const outputFiles = Array.isArray(metadataObject?.elements)
    ? metadataObject.elements.flatMap((element) => {
        if (element === null || typeof element !== "object" || Array.isArray(element)) return [];
        const outputFile = (element as { outputFile?: unknown }).outputFile;
        return typeof outputFile === "string" && path.basename(outputFile) === outputFile ? [outputFile] : [];
      })
    : [];
  const matchingOutputs = outputFiles.filter((outputFile) => {
    try {
      return fs.realpathSync(path.join(path.dirname(metadataRealPath), outputFile)) === fs.realpathSync(receipt.apk.sourcePath);
    } catch {
      return false;
    }
  });
  if (matchingOutputs.length !== 1) issues.push("current AGP output metadata does not bind exactly one output to the receipt source APK");
}

export function readNativeRunReceipt(app: string, receiptId: string, options: ReadReceiptOptions = {}): NativeRunReceiptValidation {
  const historical = readHistoricalNativeRunReceipt(app, receiptId, options);
  if (options.mode !== "current") return historical;
  if (historical.status === "invalid") return { ...historical, mode: "current" };
  const issues: string[] = [];
  validateCurrentProject(historical.receipt, options.projectDir, issues);
  return issues.length
    ? invalidResult("current", receiptId, issues)
    : { ...historical, mode: "current" };
}

function findNativeRunReceipt(
  app: string,
  options: ReceiptStoreOptions,
  mode: "historical" | "current",
  projectDir?: string,
): NativeRunReceiptSelection {
  try {
    assertCanonicalAppKey(app);
  } catch (error) {
    return { status: "invalid-store", issues: [error instanceof Error ? error.message : String(error)] };
  }
  const appDirectory = path.join(receiptRoot(options), NATIVE_RECEIPT_DIRECTORY, app);
  let entries: fs.Dirent[];
  try {
    const stat = fs.lstatSync(appDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: "invalid-store", issues: [`receipt app path '${appDirectory}' is not a regular directory`] };
    entries = fs.readdirSync(appDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none", rejectedCandidates: [] };
    return { status: "invalid-store", issues: [`receipt app directory could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const candidates = entries.filter((entry) => entry.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name));
  if (candidates.length > RUN_RECEIPT_MAX_PER_APP) {
    return { status: "invalid-store", issues: [`receipt app directory contains ${candidates.length} candidates, exceeding the ${RUN_RECEIPT_MAX_PER_APP} limit`] };
  }
  const rejectedCandidates: Array<{ receiptId: string; issues: string[] }> = [];
  const valid: Array<{ receipt: NativeRunReceipt; receiptPath: string }> = [];
  for (const candidate of candidates) {
    const receiptId = candidate.name.slice(0, -".json".length);
    if (!candidate.isFile() || !SHA256_PATTERN.test(receiptId)) {
      rejectedCandidates.push({ receiptId, issues: ["candidate filename is not a canonical receipt ID JSON file"] });
      continue;
    }
    const result = readNativeRunReceipt(app, receiptId, { ...options, mode, projectDir });
    if (result.status === "invalid") rejectedCandidates.push({ receiptId, issues: result.issues });
    else valid.push({ receipt: result.receipt, receiptPath: result.receiptPath });
  }
  valid.sort((left, right) => {
    const created = Date.parse(right.receipt.createdAt) - Date.parse(left.receipt.createdAt);
    return created || left.receipt.receiptId.localeCompare(right.receipt.receiptId);
  });
  return valid.length
    ? { status: "valid", ...valid[0], rejectedCandidates }
    : { status: "none", rejectedCandidates };
}

export function findHistoricalNativeRunReceipt(app: string, options: ReceiptStoreOptions = {}): NativeRunReceiptSelection {
  return findNativeRunReceipt(app, options, "historical");
}

export function findCurrentNativeRunReceipt(app: string, projectDir: string, options: ReceiptStoreOptions = {}): NativeRunReceiptSelection {
  return findNativeRunReceipt(app, options, "current", projectDir);
}

export function validateNativeRunReceiptCaptureBinding(
  app: string,
  receiptId: string,
  artifactPath: string,
  options: ReceiptStoreOptions = {},
): ReceiptCaptureBindingResult {
  const result = readNativeRunReceipt(app, receiptId, options);
  if (result.status === "invalid") return { status: "invalid", reason: result.issues.join("; ") };
  const capture = validateCapture(artifactPath);
  if (!capture.ok) return { status: "invalid", reason: capture.reason ?? "capture could not be validated" };
  if (capture.sha256 !== result.receipt.capture.sha256) return { status: "invalid", reason: "capture sha256 does not match the run receipt" };
  const resolved = {
    status: "valid",
    binding: Object.freeze({
      kind: RUN_RECEIPT_KIND,
      schemaVersion: RUN_RECEIPT_SCHEMA_VERSION,
      receiptId,
      captureSha256: result.receipt.capture.sha256,
    }),
  } as Extract<ReceiptCaptureBindingResult, { status: "valid" }>;
  Object.defineProperty(resolved, "receiptRuntime", {
    value: Object.freeze({
      serial: result.receipt.runtime.serial,
      model: result.receipt.runtime.model,
      fingerprint: result.receipt.runtime.fingerprint,
      bootQemu: result.receipt.runtime.bootQemu,
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(resolved);
}
