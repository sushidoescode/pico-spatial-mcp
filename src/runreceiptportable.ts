import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { MAX_CAPTURE_BYTES } from "./evidence.js";
import {
  APK_MAX_BYTES,
  EFFECTIVE_APP_SPEC_MAX_BYTES,
  RUN_RECEIPT_KIND,
  RUN_RECEIPT_MAX_BYTES,
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
