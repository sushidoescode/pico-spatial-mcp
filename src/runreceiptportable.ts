import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MAX_CAPTURE_BYTES, validateCaptureBuffer, type CaptureCheck } from "./evidence.js";
import { ledgerDirectory } from "./ledger.js";
import {
  APK_ARTIFACT_DIRECTORY,
  APK_MAX_BYTES,
  EFFECTIVE_APP_SPEC_MAX_BYTES,
  RUN_RECEIPT_KIND,
  RUN_RECEIPT_MAX_BYTES,
  SPEC_ARTIFACT_DIRECTORY,
  readNativeRunReceipt,
  runReceiptDirectory,
  validateNativeRunReceiptLineageSnapshot,
  type NativeRunReceipt,
  type ReceiptStoreOptions,
} from "./runreceiptstore.js";
import { canonicalJson } from "./runreceiptidentity.js";

export const PORTABLE_RUN_RECEIPT_KIND = "pico.portable-native-run-receipt" as const;
export const PROMOTION_MANIFEST_KIND = "pico.run-receipt-promotion" as const;
export const PORTABLE_RUN_RECEIPT_SCHEMA_VERSION = 1 as const;
export const PORTABLE_LINEAGE_DIRECTORY = "portable-lineage-v1" as const;
export const PORTABLE_RECEIPT_DIRECTORY = "portable-v1" as const;
export const PROMOTION_DIRECTORY = "promotions-v1" as const;
export const PORTABLE_RUN_RECEIPT_MAX_BYTES = RUN_RECEIPT_MAX_BYTES;
export const PROMOTION_MANIFEST_MAX_BYTES = 64 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ANDROID_PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const ISO_MILLISECOND_Z_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOOL_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const HELPER_PROTOCOL = "pico.receipt-portability-helper" as const;
const HELPER_PROTOCOL_VERSION = 1 as const;
const HELPER_TIMEOUT_MS = 10 * 60 * 1000;
const HELPER_MAX_STDIN_BYTES = 5 * 1024 * 1024;
const HELPER_MAX_STDOUT_BYTES = 100 * 1024 * 1024;
const HELPER_MAX_STDERR_BYTES = 64 * 1024;
const PYTHON_OVERRIDE = "PICO_MCP_RECEIPT_PORTABILITY_PYTHON";
const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

const sha256Schema = z.string().regex(SHA256_PATTERN, "must be 64 lowercase hexadecimal characters");
const byteCountSchema = z.number().int().nonnegative();
const appSchema = z.string().regex(ANDROID_PACKAGE_PATTERN, "must be a canonical Android package name");

function isCanonicalStorePath(value: string): boolean {
  return value !== "/"
    && path.posix.isAbsolute(value)
    && !value.includes("\0")
    && !value.includes("\\")
    && path.posix.normalize(value) === value
    && !value.endsWith("/");
}

function isExactMillisecondTimestamp(value: string): boolean {
  if (!ISO_MILLISECOND_Z_PATTERN.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

const rootIdentitySchema = z.object({
  realPath: z.string().refine(isCanonicalStorePath, "must be a resolved absolute POSIX store path without a trailing slash"),
  deviceId: z.string().regex(UNSIGNED_DECIMAL_PATTERN, "must be unsigned base-10 without leading zeroes"),
  inode: z.string().regex(UNSIGNED_DECIMAL_PATTERN, "must be unsigned base-10 without leading zeroes"),
}).strict();

const receiptArtifactSchema = z.object({
  store: z.literal("receipt"),
  algorithm: z.literal("sha256"),
  sha256: sha256Schema,
  bytes: byteCountSchema,
}).strict();

const captureArtifactSchema = z.object({
  store: z.literal("ledger"),
  algorithm: z.literal("sha256"),
  sha256: sha256Schema,
  bytes: byteCountSchema.max(MAX_CAPTURE_BYTES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.literal("png"),
}).strict();

const portableArtifactsSchema = z.object({
  apk: receiptArtifactSchema.extend({ bytes: byteCountSchema.positive().max(APK_MAX_BYTES) }).strict(),
  effectiveAppSpec: receiptArtifactSchema.extend({ bytes: byteCountSchema.max(EFFECTIVE_APP_SPEC_MAX_BYTES - 1) }).strict(),
  capture: captureArtifactSchema,
}).strict();

const sourceReceiptSchema = z.object({
  kind: z.literal(RUN_RECEIPT_KIND),
  schemaVersion: z.literal(1),
  receiptId: sha256Schema,
  fileSha256: sha256Schema,
}).strict();

const portableRunReceiptPayloadSchema = z.object({
  kind: z.literal(PORTABLE_RUN_RECEIPT_KIND),
  schemaVersion: z.literal(PORTABLE_RUN_RECEIPT_SCHEMA_VERSION),
  app: appSchema,
  sourceReceipt: sourceReceiptSchema,
  artifacts: portableArtifactsSchema,
}).strict();

const promotionCoreSchema = z.object({
  app: appSchema,
  portableReceiptId: sha256Schema,
  sourceReceiptId: sha256Schema,
  sourceRoots: z.object({ receipt: rootIdentitySchema, ledger: rootIdentitySchema }).strict(),
  targetRoots: z.object({ receipt: rootIdentitySchema, ledger: rootIdentitySchema }).strict(),
  artifacts: portableArtifactsSchema,
}).strict();

const auditValueSchema = z.object({
  promotionId: sha256Schema,
  recordedAt: z.string().refine(isExactMillisecondTimestamp, "must be an exact ISO-8601 millisecond-Z timestamp"),
  toolVersion: z.string().max(64).regex(TOOL_VERSION_PATTERN, "must be a semantic tool version"),
}).strict();

export type RootIdentity = z.infer<typeof rootIdentitySchema>;
export type PortableRunReceipt = z.infer<typeof portableRunReceiptPayloadSchema> & { receiptId: string };
export type PromotionManifest = {
  kind: typeof PROMOTION_MANIFEST_KIND;
  schemaVersion: 1;
  promotionId: string;
  auditId: string;
  core: z.infer<typeof promotionCoreSchema>;
  recordedAt: string;
  toolVersion: string;
};
export type NativeLedgerBinding = {
  kind: typeof RUN_RECEIPT_KIND;
  schemaVersion: 1;
  receiptId: string;
  captureSha256: string;
};
export type PortableLedgerBinding = {
  kind: typeof PORTABLE_RUN_RECEIPT_KIND;
  schemaVersion: 1;
  receiptId: string;
  sourceReceiptId: string;
  promotionId: string;
  auditId: string;
  captureSha256: string;
};
export type ReceiptSelector =
  | { kind: typeof RUN_RECEIPT_KIND; schemaVersion: 1; receiptId: string }
  | { kind: typeof PORTABLE_RUN_RECEIPT_KIND; schemaVersion: 1; receiptId: string; promotionId: string };
export type RunReceiptBinding = NativeLedgerBinding | PortableLedgerBinding;
export type PromoteNativeRunReceiptInput = {
  app: string;
  sourceReceiptId: string;
  sourceReceiptRoot: string;
  sourceLedgerRoot: string;
  targetReceiptRoot: string;
  targetLedgerRoot: string;
};
export type PromotionResult =
  | {
      status: "promoted";
      portableReceiptId: string;
      promotionId: string;
      auditId: string;
      recordedAt: string;
      apkArtifactPath: string;
      effectiveAppSpecArtifactPath: string;
      captureArtifactPath: string;
      lineageReceiptPath: string;
      portableReceiptPath: string;
      promotionManifestPath: string;
    }
  | { status: "refused"; reason: string }
  | { status: "unavailable"; reason: string };
export type PortableRunReceiptValidation =
  | {
      status: "valid";
      receipt: PortableRunReceipt;
      manifest: PromotionManifest;
      lineageReceipt: NativeRunReceipt;
      apkArtifactPath: string;
      effectiveAppSpecArtifactPath: string;
      captureArtifactPath: string;
      lineageReceiptPath: string;
      portableReceiptPath: string;
      promotionManifestPath: string;
    }
  | { status: "invalid"; receiptId: string; promotionId: string; issues: string[] }
  | { status: "unavailable"; reason: string };

function domainSeparatedId(domain: string, value: unknown): string {
  return crypto.createHash("sha256")
    .update(Buffer.from(domain, "utf8"))
    .update(Buffer.from([0]))
    .update(Buffer.from(canonicalJson(value), "utf8"))
    .digest("hex");
}

export function portableReceiptIdOf(payload: unknown): string {
  return domainSeparatedId("pico.portable-native-run-receipt/v1", portableRunReceiptPayloadSchema.parse(payload));
}

export function promotionIdOf(core: unknown): string {
  return domainSeparatedId("pico.run-receipt-promotion-core/v1", promotionCoreSchema.parse(core));
}

export function auditIdOf(value: unknown): string {
  return domainSeparatedId("pico.run-receipt-promotion-audit/v1", auditValueSchema.parse(value));
}

const portableRunReceiptSchema = portableRunReceiptPayloadSchema.extend({
  receiptId: sha256Schema,
}).strict().superRefine((value, context) => {
  const { receiptId, ...payload } = value;
  if (portableReceiptIdOf(payload) !== receiptId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptId"], message: "must match the domain-separated portable receipt payload identity" });
  }
});

const promotionManifestSchema = z.object({
  kind: z.literal(PROMOTION_MANIFEST_KIND),
  schemaVersion: z.literal(1),
  promotionId: sha256Schema,
  auditId: sha256Schema,
  core: promotionCoreSchema,
  recordedAt: auditValueSchema.shape.recordedAt,
  toolVersion: auditValueSchema.shape.toolVersion,
}).strict().superRefine((value, context) => {
  if (promotionIdOf(value.core) !== value.promotionId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["promotionId"], message: "must match the domain-separated promotion core identity" });
  }
  if (auditIdOf({ promotionId: value.promotionId, recordedAt: value.recordedAt, toolVersion: value.toolVersion }) !== value.auditId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["auditId"], message: "must match the domain-separated promotion audit identity" });
  }
});

const nativeReceiptSelectorSchema = z.object({
  kind: z.literal(RUN_RECEIPT_KIND),
  schemaVersion: z.literal(1),
  receiptId: sha256Schema,
}).strict();
const portableReceiptSelectorSchema = z.object({
  kind: z.literal(PORTABLE_RUN_RECEIPT_KIND),
  schemaVersion: z.literal(1),
  receiptId: sha256Schema,
  promotionId: sha256Schema,
}).strict();
const nativeLedgerBindingSchema = z.object({
  kind: z.literal(RUN_RECEIPT_KIND),
  schemaVersion: z.literal(1),
  receiptId: sha256Schema,
  captureSha256: sha256Schema,
}).strict();
const portableLedgerBindingSchema = z.object({
  kind: z.literal(PORTABLE_RUN_RECEIPT_KIND),
  schemaVersion: z.literal(1),
  receiptId: sha256Schema,
  sourceReceiptId: sha256Schema,
  promotionId: sha256Schema,
  auditId: sha256Schema,
  captureSha256: sha256Schema,
}).strict();

export function parsePortableRunReceipt(value: unknown): PortableRunReceipt {
  return portableRunReceiptSchema.parse(value) as PortableRunReceipt;
}

export function parsePromotionManifest(value: unknown): PromotionManifest {
  return promotionManifestSchema.parse(value) as PromotionManifest;
}

export function parseReceiptSelector(value: unknown): ReceiptSelector {
  return z.discriminatedUnion("kind", [nativeReceiptSelectorSchema, portableReceiptSelectorSchema]).parse(value) as ReceiptSelector;
}

export function parseRunReceiptBinding(value: unknown): RunReceiptBinding {
  return z.discriminatedUnion("kind", [nativeLedgerBindingSchema, portableLedgerBindingSchema]).parse(value) as RunReceiptBinding;
}

const promotionInputSchema = z.object({
  app: appSchema,
  sourceReceiptId: sha256Schema,
  sourceReceiptRoot: z.string().refine(isCanonicalStorePath, "must be a canonical absolute non-root POSIX store path"),
  sourceLedgerRoot: z.string().refine(isCanonicalStorePath, "must be a canonical absolute non-root POSIX store path"),
  targetReceiptRoot: z.string().refine(isCanonicalStorePath, "must be a canonical absolute non-root POSIX store path"),
  targetLedgerRoot: z.string().refine(isCanonicalStorePath, "must be a canonical absolute non-root POSIX store path"),
}).strict();

const readOptionsSchema = z.object({
  rootDir: z.string().refine(isCanonicalStorePath, "must be a canonical absolute non-root POSIX store path").optional(),
  ledgerDir: z.string().refine(isCanonicalStorePath, "must be a canonical absolute non-root POSIX store path").optional(),
}).strict();

const measuredApkSchema = z.object({
  sha256: sha256Schema,
  bytes: byteCountSchema.positive().max(APK_MAX_BYTES),
}).strict();
const measuredStoredSpecSchema = z.object({
  storedSha256: sha256Schema,
  storedBytes: byteCountSchema.max(EFFECTIVE_APP_SPEC_MAX_BYTES),
}).strict();
const measuredCaptureSchema = z.object({
  sha256: sha256Schema,
  bytes: byteCountSchema.max(MAX_CAPTURE_BYTES),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  format: z.literal("png"),
}).strict();

function base64Schema(maximumBytes: number): z.ZodString {
  return z.string()
    .max(Math.ceil(maximumBytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "must be canonical base64");
}

const helperInspectionSchema = z.object({
  rootIdentities: z.object({ receipt: rootIdentitySchema, ledger: rootIdentitySchema }).strict(),
  lineageReceiptBase64: base64Schema(RUN_RECEIPT_MAX_BYTES),
  effectiveAppSpecBase64: base64Schema(EFFECTIVE_APP_SPEC_MAX_BYTES),
  captureBase64: base64Schema(MAX_CAPTURE_BYTES),
  portableReceiptBase64: base64Schema(PORTABLE_RUN_RECEIPT_MAX_BYTES),
  manifestBase64: base64Schema(PROMOTION_MANIFEST_MAX_BYTES),
  artifacts: z.object({
    apk: measuredApkSchema,
    effectiveAppSpec: measuredStoredSpecSchema,
    capture: measuredCaptureSchema,
  }).strict(),
}).strict();

const helperOkSchema = z.object({
  protocol: z.literal(HELPER_PROTOCOL),
  version: z.literal(HELPER_PROTOCOL_VERSION),
  status: z.literal("ok"),
  operation: z.union([z.literal("promote"), z.literal("inspect")]),
  inspection: helperInspectionSchema,
}).strict();
const helperErrorSchema = z.object({
  protocol: z.literal(HELPER_PROTOCOL),
  version: z.literal(HELPER_PROTOCOL_VERSION),
  status: z.literal("error"),
  operation: z.union([z.literal("promote"), z.literal("inspect"), z.literal("unknown")]),
  reason: z.string().min(1).max(4096),
}).strict();
const helperUnavailableSchema = z.object({
  protocol: z.literal(HELPER_PROTOCOL),
  version: z.literal(HELPER_PROTOCOL_VERSION),
  status: z.literal("unavailable"),
  operation: z.union([z.literal("promote"), z.literal("inspect"), z.literal("unknown")]),
  reason: z.string().min(1).max(4096),
}).strict();
const helperResponseSchema = z.discriminatedUnion("status", [helperOkSchema, helperErrorSchema, helperUnavailableSchema]);

type HelperInspection = z.infer<typeof helperInspectionSchema>;
type HelperResult =
  | { status: "ok"; inspection: HelperInspection }
  | { status: "error"; reason: string }
  | { status: "unavailable"; reason: string };
type HelperRuntime = { python: string; helper: string };

function issueText(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : String(error);
}

function rootIdentityAt(locator: string, label: string): RootIdentity {
  let resolved: string;
  let stats: fs.BigIntStats;
  try {
    resolved = fs.realpathSync(locator);
    stats = fs.lstatSync(locator, { bigint: true });
  } catch (error) {
    throw new Error(`${label} could not be opened: ${issueText(error)}`);
  }
  if (resolved !== locator) throw new Error(`${label} must already be resolved and contain no symbolic-link component`);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} is not a no-follow directory`);
  return rootIdentitySchema.parse({ realPath: resolved, deviceId: stats.dev.toString(), inode: stats.ino.toString() });
}

function toolVersion(): string {
  return auditValueSchema.shape.toolVersion.parse(packageMetadata.version);
}

function boundedFile(pathname: string, maximumBytes: number, label: string): Buffer {
  const stats = fs.statSync(pathname);
  if (!stats.isFile() || stats.size > maximumBytes) throw new Error(`${label} is not a bounded regular file`);
  const bytes = fs.readFileSync(pathname);
  if (bytes.length !== stats.size || bytes.length > maximumBytes) throw new Error(`${label} changed while being read`);
  return bytes;
}

function sha256Bytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function encodeBase64(bytes: Buffer): string {
  return bytes.toString("base64");
}

function decodeBase64(value: string, maximumBytes: number, label: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximumBytes || bytes.toString("base64") !== value) throw new Error(`${label} is not canonical bounded base64`);
  return bytes;
}

function helperRuntime(): { status: "available"; runtime: HelperRuntime } | { status: "unavailable"; reason: string } {
  if (process.platform === "win32") return { status: "unavailable", reason: "portable receipt promotion requires POSIX descriptor APIs" };
  let helper: string;
  try {
    const candidate = fileURLToPath(new URL("../scripts/receipt-portability-helper.py", import.meta.url));
    helper = fs.realpathSync(candidate);
    if (!path.isAbsolute(helper) || !fs.statSync(helper).isFile()) throw new Error("helper is not a regular file");
  } catch (error) {
    return { status: "unavailable", reason: `receipt portability helper is unavailable: ${issueText(error)}` };
  }

  const override = process.env[PYTHON_OVERRIDE];
  const candidates: string[] = [];
  if (override !== undefined) {
    if (!path.isAbsolute(override)) return { status: "unavailable", reason: `${PYTHON_OVERRIDE} must be an absolute executable path` };
    candidates.push(override);
  } else {
    for (const component of (process.env.PATH ?? "").split(path.delimiter)) {
      if (component && path.isAbsolute(component)) candidates.push(path.join(component, "python3"));
    }
  }
  for (const candidate of candidates) {
    try {
      const python = fs.realpathSync(candidate);
      const stats = fs.statSync(python);
      fs.accessSync(python, fs.constants.X_OK);
      if (path.isAbsolute(python) && stats.isFile()) return { status: "available", runtime: { python, helper } };
    } catch {
      // Continue through absolute PATH candidates; a supplied override has only one candidate.
    }
  }
  return { status: "unavailable", reason: override === undefined
    ? "no absolute executable python3 was found on an absolute PATH component"
    : `${PYTHON_OVERRIDE} is not an executable regular file` };
}

async function runHelper(runtime: HelperRuntime, request: unknown, expectedOperation: "promote" | "inspect"): Promise<HelperResult> {
  const input = Buffer.from(JSON.stringify(request), "utf8");
  if (input.length > HELPER_MAX_STDIN_BYTES) return { status: "error", reason: "receipt portability helper request exceeds its bound" };
  return await new Promise<HelperResult>((resolve) => {
    const child = spawn(runtime.python, ["-I", "-S", "-B", runtime.helper], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let overflow: string | undefined;
    const finish = (result: HelperResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      overflow = `receipt portability helper timed out after ${HELPER_TIMEOUT_MS}ms`;
      child.kill("SIGKILL");
    }, HELPER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > HELPER_MAX_STDOUT_BYTES) {
        overflow = "receipt portability helper stdout exceeded its bound";
        child.kill("SIGKILL");
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > HELPER_MAX_STDERR_BYTES) {
        overflow = "receipt portability helper stderr exceeded its bound";
        child.kill("SIGKILL");
      } else stderr.push(chunk);
    });
    child.on("error", (error) => finish({ status: "error", reason: `receipt portability helper could not start: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (overflow) return finish({ status: "error", reason: overflow });
      if (signal || code !== 0) return finish({ status: "error", reason: `receipt portability helper terminated with ${signal ?? `exit ${code}`}` });
      if (stderrBytes !== 0) return finish({ status: "error", reason: "receipt portability helper emitted unexpected stderr" });
      let parsed: unknown;
      try {
        const raw = Buffer.concat(stdout);
        const text = raw.toString("utf8");
        if (!raw.equals(Buffer.from(text, "utf8")) || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
          throw new Error("stdout is not one UTF-8 JSON line");
        }
        parsed = JSON.parse(text);
        const response = helperResponseSchema.parse(parsed);
        if (response.operation !== expectedOperation) throw new Error("helper operation did not match its request");
        return finish(response.status === "ok"
          ? { status: "ok", inspection: response.inspection }
          : response.status === "unavailable"
            ? { status: "unavailable", reason: response.reason }
            : { status: "error", reason: response.reason });
      } catch (error) {
        return finish({ status: "error", reason: `receipt portability helper returned an invalid response: ${issueText(error)}` });
      }
    });
    child.stdin.on("error", () => { /* close reports the authoritative outcome */ });
    child.stdin.end(input);
  });
}

function rootProtocol(identity: RootIdentity): RootIdentity {
  return { realPath: identity.realPath, deviceId: identity.deviceId, inode: identity.inode };
}

function canonicalFileBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function portableSourceExists(app: string, receiptId: string, sourceReceiptRoot: string): boolean {
  try {
    const candidate = path.join(sourceReceiptRoot, PORTABLE_RECEIPT_DIRECTORY, app, `${receiptId}.json`);
    const bytes = boundedFile(candidate, PORTABLE_RUN_RECEIPT_MAX_BYTES, "portable source candidate");
    const raw = JSON.parse(bytes.toString("utf8"));
    if (!bytes.equals(canonicalFileBytes(raw))) return false;
    return parsePortableRunReceipt(raw).receiptId === receiptId;
  } catch {
    return false;
  }
}

function expectedTargetPaths(
  targetReceiptRoot: string,
  targetLedgerRoot: string,
  app: string,
  sourceReceiptId: string,
  receipt: PortableRunReceipt,
  promotionId: string,
): Omit<Extract<PromotionResult, { status: "promoted" }>, "status" | "portableReceiptId" | "promotionId" | "auditId" | "recordedAt"> {
  return {
    apkArtifactPath: path.join(targetReceiptRoot, ...APK_ARTIFACT_DIRECTORY.split("/"), `${receipt.artifacts.apk.sha256}.apk`),
    effectiveAppSpecArtifactPath: path.join(targetReceiptRoot, ...SPEC_ARTIFACT_DIRECTORY.split("/"), `${receipt.artifacts.effectiveAppSpec.sha256}.json`),
    captureArtifactPath: path.join(targetLedgerRoot, "artifacts", `${receipt.artifacts.capture.sha256}.png`),
    lineageReceiptPath: path.join(targetReceiptRoot, PORTABLE_LINEAGE_DIRECTORY, app, `${sourceReceiptId}.json`),
    portableReceiptPath: path.join(targetReceiptRoot, PORTABLE_RECEIPT_DIRECTORY, app, `${receipt.receiptId}.json`),
    promotionManifestPath: path.join(targetReceiptRoot, PROMOTION_DIRECTORY, app, `${promotionId}.json`),
  };
}

function jsonCanonicalBytes(bytes: Buffer, maximum: number, label: string): unknown {
  if (bytes.length > maximum) throw new Error(`${label} exceeds its byte limit`);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${issueText(error)}`);
  }
  if (!bytes.equals(canonicalFileBytes(raw))) throw new Error(`${label} is not canonical JSON plus one newline`);
  return raw;
}

function captureFacts(capture: CaptureCheck): z.infer<typeof measuredCaptureSchema> {
  if (!capture.ok || capture.format !== "png" || capture.sha256 === undefined || capture.bytes === undefined ||
      capture.width === undefined || capture.height === undefined) {
    throw new Error(capture.reason ?? "capture validation returned incomplete facts");
  }
  return measuredCaptureSchema.parse({
    sha256: capture.sha256,
    bytes: capture.bytes,
    width: capture.width,
    height: capture.height,
    format: capture.format,
  });
}

function validateInspection(
  inspectionValue: HelperInspection,
  app: string,
  portableReceiptId: string,
  promotionId: string,
  targetReceipt: RootIdentity,
  targetLedger: RootIdentity,
): Extract<PortableRunReceiptValidation, { status: "valid" }> {
  const inspection = helperInspectionSchema.parse(inspectionValue);
  const manifestBytes = decodeBase64(inspection.manifestBase64, PROMOTION_MANIFEST_MAX_BYTES, "promotion manifest bytes");
  const manifest = parsePromotionManifest(jsonCanonicalBytes(manifestBytes, PROMOTION_MANIFEST_MAX_BYTES, "promotion manifest"));
  if (manifest.core.app !== app || manifest.core.portableReceiptId !== portableReceiptId || manifest.promotionId !== promotionId) {
    throw new Error("promotion manifest app or requested identities do not match");
  }
  if (canonicalJson(manifest.core.targetRoots.receipt) !== canonicalJson(targetReceipt) ||
      canonicalJson(manifest.core.targetRoots.ledger) !== canonicalJson(targetLedger) ||
      canonicalJson(inspection.rootIdentities.receipt) !== canonicalJson(targetReceipt) ||
      canonicalJson(inspection.rootIdentities.ledger) !== canonicalJson(targetLedger)) {
    throw new Error("promotion target root identities do not match the opened target stores");
  }

  const portableBytes = decodeBase64(inspection.portableReceiptBase64, PORTABLE_RUN_RECEIPT_MAX_BYTES, "portable receipt bytes");
  const receipt = parsePortableRunReceipt(jsonCanonicalBytes(portableBytes, PORTABLE_RUN_RECEIPT_MAX_BYTES, "portable receipt"));
  if (receipt.app !== app || receipt.receiptId !== portableReceiptId || receipt.sourceReceipt.receiptId !== manifest.core.sourceReceiptId) {
    throw new Error("portable receipt app/source/request identity does not match the manifest");
  }
  if (canonicalJson(receipt.artifacts) !== canonicalJson(manifest.core.artifacts)) {
    throw new Error("portable receipt artifacts do not match the promotion manifest");
  }

  const lineageBytes = decodeBase64(inspection.lineageReceiptBase64, RUN_RECEIPT_MAX_BYTES, "native lineage receipt bytes");
  jsonCanonicalBytes(lineageBytes, RUN_RECEIPT_MAX_BYTES, "native lineage receipt");
  if (sha256Bytes(lineageBytes) !== receipt.sourceReceipt.fileSha256) throw new Error("native lineage receipt file hash does not match the portable receipt");
  const specBytes = decodeBase64(inspection.effectiveAppSpecBase64, EFFECTIVE_APP_SPEC_MAX_BYTES, "effective AppSpec bytes");
  jsonCanonicalBytes(specBytes, EFFECTIVE_APP_SPEC_MAX_BYTES, "effective AppSpec");
  if (sha256Bytes(specBytes) !== inspection.artifacts.effectiveAppSpec.storedSha256 ||
      specBytes.length !== inspection.artifacts.effectiveAppSpec.storedBytes) {
    throw new Error("effective AppSpec returned bytes do not match the helper's measured stored facts");
  }
  const canonicalSpecBytes = specBytes.subarray(0, specBytes.length - 1);
  if (sha256Bytes(canonicalSpecBytes) !== receipt.artifacts.effectiveAppSpec.sha256 ||
      canonicalSpecBytes.length !== receipt.artifacts.effectiveAppSpec.bytes) {
    throw new Error("target effective AppSpec facts do not match the portable receipt");
  }
  const captureBytes = decodeBase64(inspection.captureBase64, MAX_CAPTURE_BYTES, "capture bytes");
  const capture = validateCaptureBuffer(captureBytes, "portable target capture");
  const checkedCapture = captureFacts(capture);
  if (canonicalJson(checkedCapture) !== canonicalJson(inspection.artifacts.capture)) {
    throw new Error("capture returned bytes do not match the helper's independently measured facts");
  }
  if (canonicalJson(inspection.artifacts.apk) !== canonicalJson({ sha256: receipt.artifacts.apk.sha256, bytes: receipt.artifacts.apk.bytes }) ||
      canonicalJson(checkedCapture) !== canonicalJson({
        sha256: receipt.artifacts.capture.sha256,
        bytes: receipt.artifacts.capture.bytes,
        width: receipt.artifacts.capture.width,
        height: receipt.artifacts.capture.height,
        format: receipt.artifacts.capture.format,
      })) {
    throw new Error("target APK or capture facts do not match the portable receipt");
  }

  const lineage = validateNativeRunReceiptLineageSnapshot({
    app,
    receiptId: manifest.core.sourceReceiptId,
    receiptBytes: lineageBytes,
    sourceReceiptRoot: manifest.core.sourceRoots.receipt.realPath,
    sourceLedgerRoot: manifest.core.sourceRoots.ledger.realPath,
    apk: inspection.artifacts.apk,
    effectiveAppSpecBytes: specBytes,
    capture,
  });
  if (lineage.status === "invalid") throw new Error(`native lineage receipt is invalid: ${lineage.issues.join("; ")}`);
  if (lineage.receiptFileSha256 !== receipt.sourceReceipt.fileSha256) throw new Error("validated native lineage file identity is mismatched");

  const targetPaths = expectedTargetPaths(targetReceipt.realPath, targetLedger.realPath, app,
    manifest.core.sourceReceiptId, receipt, manifest.promotionId);
  return {
    status: "valid",
    receipt,
    manifest,
    lineageReceipt: lineage.receipt,
    ...targetPaths,
  };
}

export async function promoteNativeRunReceipt(inputValue: PromoteNativeRunReceiptInput): Promise<PromotionResult> {
  const runtime = helperRuntime();
  if (runtime.status === "unavailable") return runtime;
  let input: PromoteNativeRunReceiptInput;
  let sourceReceipt: RootIdentity;
  let sourceLedger: RootIdentity;
  let targetReceipt: RootIdentity;
  let targetLedger: RootIdentity;
  try {
    input = promotionInputSchema.parse(inputValue);
    sourceReceipt = rootIdentityAt(input.sourceReceiptRoot, "sourceReceiptRoot");
    sourceLedger = rootIdentityAt(input.sourceLedgerRoot, "sourceLedgerRoot");
    targetReceipt = rootIdentityAt(input.targetReceiptRoot, "targetReceiptRoot");
    targetLedger = rootIdentityAt(input.targetLedgerRoot, "targetLedgerRoot");
  } catch (error) {
    return { status: "refused", reason: issueText(error) };
  }

  const native = readNativeRunReceipt(input.app, input.sourceReceiptId, {
    rootDir: input.sourceReceiptRoot,
    ledgerDir: input.sourceLedgerRoot,
    mode: "historical",
  });
  if (native.status === "invalid") {
    if (portableSourceExists(input.app, input.sourceReceiptId, input.sourceReceiptRoot)) {
      return { status: "refused", reason: "portable receipts are one-hop lineage projections and cannot be promoted recursively" };
    }
    return { status: "refused", reason: `source native receipt is invalid: ${native.issues.join("; ")}` };
  }

  try {
    const lineageBytes = boundedFile(native.receiptPath, RUN_RECEIPT_MAX_BYTES, "source native receipt");
    const specBytes = boundedFile(native.receipt.source.effectiveAppSpec.artifactPath, EFFECTIVE_APP_SPEC_MAX_BYTES, "source effective AppSpec");
    const sourceReceiptFileSha256 = sha256Bytes(lineageBytes);
    const portablePayload = portableRunReceiptPayloadSchema.parse({
      kind: PORTABLE_RUN_RECEIPT_KIND,
      schemaVersion: PORTABLE_RUN_RECEIPT_SCHEMA_VERSION,
      app: input.app,
      sourceReceipt: {
        kind: RUN_RECEIPT_KIND,
        schemaVersion: 1,
        receiptId: input.sourceReceiptId,
        fileSha256: sourceReceiptFileSha256,
      },
      artifacts: {
        apk: { store: "receipt", algorithm: "sha256", sha256: native.receipt.apk.sha256, bytes: native.receipt.apk.bytes },
        effectiveAppSpec: {
          store: "receipt", algorithm: "sha256",
          sha256: native.receipt.source.effectiveAppSpec.sha256,
          bytes: native.receipt.source.effectiveAppSpec.bytes,
        },
        capture: {
          store: "ledger", algorithm: "sha256", sha256: native.receipt.capture.sha256,
          bytes: native.receipt.capture.bytes, width: native.receipt.capture.width,
          height: native.receipt.capture.height, format: native.receipt.capture.format,
        },
      },
    });
    const portableReceiptId = portableReceiptIdOf(portablePayload);
    const receipt = parsePortableRunReceipt({ ...portablePayload, receiptId: portableReceiptId });
    const core = promotionCoreSchema.parse({
      app: input.app,
      portableReceiptId,
      sourceReceiptId: input.sourceReceiptId,
      sourceRoots: { receipt: sourceReceipt, ledger: sourceLedger },
      targetRoots: { receipt: targetReceipt, ledger: targetLedger },
      artifacts: receipt.artifacts,
    });
    const promotionId = promotionIdOf(core);
    const recordedAt = new Date().toISOString();
    const currentToolVersion = toolVersion();
    const auditId = auditIdOf({ promotionId, recordedAt, toolVersion: currentToolVersion });
    const manifest = parsePromotionManifest({
      kind: PROMOTION_MANIFEST_KIND,
      schemaVersion: 1,
      promotionId,
      auditId,
      core,
      recordedAt,
      toolVersion: currentToolVersion,
    });
    const helper = await runHelper(runtime.runtime, {
      protocol: HELPER_PROTOCOL,
      version: HELPER_PROTOCOL_VERSION,
      operation: "promote",
      app: input.app,
      sourceReceiptId: input.sourceReceiptId,
      roots: {
        sourceReceipt: rootProtocol(sourceReceipt), sourceLedger: rootProtocol(sourceLedger),
        targetReceipt: rootProtocol(targetReceipt), targetLedger: rootProtocol(targetLedger),
      },
      expected: {
        sourceReceiptFileSha256,
        apk: { sha256: receipt.artifacts.apk.sha256, bytes: receipt.artifacts.apk.bytes },
        effectiveAppSpec: {
          sha256: receipt.artifacts.effectiveAppSpec.sha256,
          bytes: receipt.artifacts.effectiveAppSpec.bytes,
          storedSha256: sha256Bytes(specBytes),
          storedBytes: specBytes.length,
        },
        capture: {
          sha256: receipt.artifacts.capture.sha256,
          bytes: receipt.artifacts.capture.bytes,
          width: receipt.artifacts.capture.width,
          height: receipt.artifacts.capture.height,
          format: receipt.artifacts.capture.format,
        },
      },
      publications: {
        portableReceiptBase64: encodeBase64(canonicalFileBytes(receipt)),
        manifestBase64: encodeBase64(canonicalFileBytes(manifest)),
      },
    }, "promote");
    if (helper.status === "unavailable") return helper;
    if (helper.status === "error") return { status: "refused", reason: helper.reason };
    const validated = validateInspection(helper.inspection, input.app, portableReceiptId, promotionId, targetReceipt, targetLedger);
    return {
      status: "promoted",
      portableReceiptId,
      promotionId,
      auditId: validated.manifest.auditId,
      recordedAt: validated.manifest.recordedAt,
      apkArtifactPath: validated.apkArtifactPath,
      effectiveAppSpecArtifactPath: validated.effectiveAppSpecArtifactPath,
      captureArtifactPath: validated.captureArtifactPath,
      lineageReceiptPath: validated.lineageReceiptPath,
      portableReceiptPath: validated.portableReceiptPath,
      promotionManifestPath: validated.promotionManifestPath,
    };
  } catch (error) {
    return { status: "refused", reason: issueText(error) };
  }
}

export async function readPortableRunReceipt(
  appValue: string,
  receiptIdValue: string,
  promotionIdValue: string,
  optionsValue: ReceiptStoreOptions = {},
): Promise<PortableRunReceiptValidation> {
  const runtime = helperRuntime();
  if (runtime.status === "unavailable") return runtime;
  let app: string;
  let receiptId: string;
  let promotionId: string;
  let targetReceipt: RootIdentity;
  let targetLedger: RootIdentity;
  try {
    app = appSchema.parse(appValue);
    receiptId = sha256Schema.parse(receiptIdValue);
    promotionId = sha256Schema.parse(promotionIdValue);
    const options = readOptionsSchema.parse(optionsValue);
    targetReceipt = rootIdentityAt(options.rootDir ?? runReceiptDirectory(), "target receipt root");
    targetLedger = rootIdentityAt(options.ledgerDir ?? ledgerDirectory(), "target ledger root");
  } catch (error) {
    return { status: "invalid", receiptId: String(receiptIdValue ?? ""), promotionId: String(promotionIdValue ?? ""), issues: [issueText(error)] };
  }
  const helper = await runHelper(runtime.runtime, {
    protocol: HELPER_PROTOCOL,
    version: HELPER_PROTOCOL_VERSION,
    operation: "inspect",
    app,
    portableReceiptId: receiptId,
    promotionId,
    roots: { targetReceipt: rootProtocol(targetReceipt), targetLedger: rootProtocol(targetLedger) },
  }, "inspect");
  if (helper.status === "unavailable") return helper;
  if (helper.status === "error") return { status: "invalid", receiptId, promotionId, issues: [helper.reason] };
  try {
    return validateInspection(helper.inspection, app, receiptId, promotionId, targetReceipt, targetLedger);
  } catch (error) {
    return { status: "invalid", receiptId, promotionId, issues: [issueText(error)] };
  }
}
