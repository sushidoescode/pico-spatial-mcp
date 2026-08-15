import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { buildCapabilityMatrix } from "./capability.js";
import { readCaptureBytes, validateCapture, validateCaptureBuffer, type CaptureCheck } from "./evidence.js";
import {
  probeDeviceIdentity,
  probeDeviceCapture,
  resolveDeviceAdb,
  validateRecordedDeviceLineage,
  verifyLiveDeviceLineage,
  type DeviceIdentityProbe,
  type DeviceCaptureProbe,
} from "./deviceidentity.js";

/**
 * The trust ledger has two independent provenance gates:
 *
 * 1. At record time, image-grounded evidence is copied into a ledger-owned content-addressed
 *    store. A later fleet run may overwrite its deterministic /tmp capture without touching proof.
 * 2. At report time, the stored bytes are revalidated and rehashed against the recorded metadata.
 *    Missing, malformed, or changed evidence becomes `provenance-broken`; it can never be emitted
 *    as visual proof.
 *
 * Retractions are events appended to the same array. Legacy inline `retracted:true` rows remain
 * readable, but new corrections never mutate or delete the original claim.
 */

const evidenceTypeSchema = z.enum(["device_verified", "vision_verified", "auto_judged", "usd_host_render", "logcat", "structural", "compiles", "built_for_headset"]);
const IMAGE_EVIDENCE = new Set(["device_verified", "vision_verified", "auto_judged", "usd_host_render"]);
const DEVICE_PROBE_RECEIPT = Symbol("device-probe-receipt");
const AUTO_JUDGE_RECEIPT = Symbol("auto-judge-producer-receipt");
const USD_RENDER_RECEIPT = Symbol("usd-render-producer-receipt");
const IMMUTABLE_CAPTURE_BYTES = Symbol("producer-owned-immutable-capture-bytes");
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
export const CANONICAL_APP_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const DEVICE_FEATURE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EVIDENCE_TO_STATUS: Record<string, string> = {
  device_verified: "device_verified",
  vision_verified: "vision_verified",
  auto_judged: "auto_judged",
  usd_host_render: "usd_host_render",
  logcat: "logcat_asserted",
  structural: "structural",
  compiles: "compiles",
  built_for_headset: "built_for_headset",
  "provenance-broken": "provenance-broken",
};

export type ValidatedRunReceiptBinding = {
  kind: "pico.native-run-receipt";
  schemaVersion: 1;
  receiptId: string;
  captureSha256: string;
};

export type ReceiptCaptureBindingResult =
  | { status: "valid"; binding: ValidatedRunReceiptBinding }
  | { status: "invalid"; reason: string };

export interface LedgerToolDependencies {
  resolveRunReceiptBinding?: (
    app: string,
    receiptId: string,
    artifactPath: string,
  ) => ReceiptCaptureBindingResult;
}

export type RegisterLedgerTools = (server: McpServer, deps?: LedgerToolDependencies) => void;

function validateRunReceiptBinding(
  value: unknown,
  expectedCaptureSha256?: string,
): { ok: true; binding: ValidatedRunReceiptBinding } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "runReceipt binding is not an object" };
  }
  const fields = Object.keys(value as Record<string, unknown>).sort();
  const expectedFields = ["captureSha256", "kind", "receiptId", "schemaVersion"];
  if (fields.length !== expectedFields.length || fields.some((field, index) => field !== expectedFields[index])) {
    return { ok: false, reason: "runReceipt binding contains missing or caller-authored fields" };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "pico.native-run-receipt" || candidate.schemaVersion !== 1) {
    return { ok: false, reason: "runReceipt binding kind or schemaVersion is invalid" };
  }
  if (typeof candidate.receiptId !== "string" || !SHA256_PATTERN.test(candidate.receiptId)) {
    return { ok: false, reason: "runReceipt binding receiptId is not a canonical sha256" };
  }
  if (typeof candidate.captureSha256 !== "string" || !SHA256_PATTERN.test(candidate.captureSha256)) {
    return { ok: false, reason: "runReceipt binding captureSha256 is not a canonical sha256" };
  }
  if (expectedCaptureSha256 !== undefined && candidate.captureSha256 !== expectedCaptureSha256) {
    return { ok: false, reason: `runReceipt capture sha256 ${candidate.captureSha256} does not match the materialized ledger capture sha256 ${expectedCaptureSha256}` };
  }
  return {
    ok: true,
    binding: Object.freeze({
      kind: "pico.native-run-receipt",
      schemaVersion: 1,
      receiptId: candidate.receiptId,
      captureSha256: candidate.captureSha256,
    }),
  };
}

export function ledgerDirectory(): string {
  return process.env.PICO_MCP_LEDGER_DIR
    ? path.resolve(process.env.PICO_MCP_LEDGER_DIR)
    : path.join(os.homedir(), ".pico-mcp", "ledgers");
}

export function assertCanonicalAppKey(app: string): void {
  if (!CANONICAL_APP_KEY_PATTERN.test(app)) {
    throw new Error(`invalid app ledger key '${app}': use 1-200 lowercase ASCII letters, digits, dot, underscore, or hyphen, beginning with a letter or digit`);
  }
}

export function ledgerFilePath(app: string): string {
  assertCanonicalAppKey(app);
  return path.join(ledgerDirectory(), `${app}.json`);
}

function loadLedgerEvents(app: string): any[] {
  const file = ledgerFilePath(app);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`cannot read trust ledger '${file}': ${error?.message ?? String(error)}`);
  }
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (error: any) {
    throw new Error(`trust ledger '${file}' is not valid JSON; refusing to overwrite its history: ${error?.message ?? String(error)}`);
  }
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.entries)) return raw.entries;
  throw new Error(`trust ledger '${file}' has an unsupported shape; refusing to overwrite its history`);
}

function atomicSaveLedger(app: string, events: any[]): void {
  const dir = ledgerDirectory();
  const file = ledgerFilePath(app);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(events, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function fsyncDirectory(dir: string): void {
  // Directory fsync is the POSIX durability boundary for a successful rename/link. Windows does
  // not support opening directories through this API; its rename semantics remain unmeasured here.
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

type LedgerLockRecord = { pid: number; token: string; createdAt: string; processIdentity?: string };

function parseLedgerLock(text: string): LedgerLockRecord | undefined {
  try {
    const value = JSON.parse(text);
    if (!Number.isInteger(value?.pid) || value.pid <= 0 || typeof value.token !== "string" || !value.token) return undefined;
    if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
    if (value.processIdentity !== undefined && (typeof value.processIdentity !== "string" || !value.processIdentity)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** OS process-start identity distinguishes a live PID reuse from the process that made the lock. */
function processIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startTicks = afterCommand[19]; // proc(5) field 22; this slice begins at field 3.
      return startTicks ? `linux-start-ticks:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform !== "win32") {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000 });
    const start = result.status === 0 ? result.stdout.trim() : "";
    return start ? `${process.platform}-lstart:${start}` : undefined;
  }
  return undefined;
}

function lockOwnerIsAlive(record: LedgerLockRecord): boolean {
  if (!processIsAlive(record.pid)) return false;
  if (!record.processIdentity) return true; // legacy lock: fail closed while its PID is live
  const current = processIdentity(record.pid);
  return current === undefined || current === record.processIdentity;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

function readLockDirectory(lockDir: string): { ownerName: string; record: LedgerLockRecord } | undefined {
  const owners = fs.readdirSync(lockDir).filter((name) => name.endsWith(".owner.json"));
  if (owners.length !== 1) return undefined;
  const record = parseLedgerLock(fs.readFileSync(path.join(lockDir, owners[0]), "utf8"));
  return record ? { ownerName: owners[0], record } : undefined;
}

function publishOwnedDirectory(target: string, prefix: string): { path: string; token: string } {
  const token = crypto.randomUUID();
  const claimant = `${target}.${process.pid}.${token}.${prefix}`;
  const owner = path.join(claimant, `${token}.owner.json`);
  let fd: number | undefined;
  try {
    fs.mkdirSync(claimant, { mode: 0o700 });
    fd = fs.openSync(owner, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), processIdentity: processIdentity(process.pid) })}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fsyncDirectory(claimant);
    fs.renameSync(claimant, target);
    fsyncDirectory(path.dirname(target));
    return { path: target, token };
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(claimant, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function releaseOwnedDirectory(lock: { path: string; token: string }, suffix: string): void {
  const current = readLockDirectory(lock.path);
  if (current?.record.token !== lock.token) return;
  const quarantine = `${lock.path}.${suffix}.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(lock.path, quarantine);
    fsyncDirectory(path.dirname(lock.path));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch {}
  }
}

/** One recoverable reaper election per dead owner token prevents delayed reapers moving replacements. */
function acquireReaperElection(lockPath: string, ownerToken: string): { path: string; token: string } | undefined {
  const marker = `${lockPath}.reap.${crypto.createHash("sha256").update(ownerToken).digest("hex")}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return publishOwnedDirectory(marker, "reaper-claim");
    } catch (error: any) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
    }
    let existing: { ownerName: string; record: LedgerLockRecord } | undefined;
    try {
      existing = readLockDirectory(marker);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      return undefined;
    }
    if (!existing || lockOwnerIsAlive(existing.record)) return undefined;
    const quarantine = `${marker}.abandoned.${process.pid}.${crypto.randomUUID()}`;
    try {
      fs.renameSync(marker, quarantine);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      return undefined;
    }
    const moved = readLockDirectory(quarantine);
    if (!moved || moved.record.token !== existing.record.token || lockOwnerIsAlive(moved.record)) {
      try { fs.renameSync(quarantine, marker); } catch {}
      return undefined;
    }
    try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch {}
  }
  return undefined;
}

function reapDeadLedgerLock(lockPath: string): boolean {
  let quarantine: string | undefined;
  let election: { path: string; token: string } | undefined;
  try {
    const stat = fs.statSync(lockPath);
    // Pre-directory locks from an interrupted older server fail closed. Removing a legacy fixed
    // file safely while a new process may replace it needs compare-and-unlink, which Node does not
    // expose. The timeout names the exact path for deliberate operator recovery.
    if (!stat.isDirectory()) return false;
    const initial = readLockDirectory(lockPath);
    const record = initial?.record;
    // Malformed ownership is external corruption: acquisition only publishes a completely written
    // owner. Never use elapsed time to steal from a possibly live writer.
    if (!initial || !record || lockOwnerIsAlive(record)) return false;
    if (initial.ownerName !== `${record.token}.owner.json`) return false;
    election = acquireReaperElection(lockPath, record.token);
    if (!election) return false;
    // Election may have been delayed behind the winning reaper. Re-check the fixed generation
    // before moving it; a replacement token is never a stale instance of the original lock.
    const current = readLockDirectory(lockPath);
    if (!current || current.record.token !== record.token || lockOwnerIsAlive(current.record)) return false;
    quarantine = `${lockPath}.reaped.${process.pid}.${crypto.randomUUID()}`;
    try {
      // Move the WHOLE nonempty directory atomically. There is never an empty fixed-path directory
      // for a claimant to replace, and cleanup touches only this unique quarantine path.
      fs.renameSync(lockPath, quarantine);
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    const movedOwner = path.join(quarantine, initial.ownerName);
    const moved = parseLedgerLock(fs.readFileSync(movedOwner, "utf8"));
    if (!moved || moved.token !== record.token) {
      // A delayed reaper must never delete a replacement generation. Restore it only when the
      // fixed name is still free; otherwise fail loudly and leave the unique quarantine intact.
      try { fs.renameSync(quarantine, lockPath); quarantine = undefined; } catch {}
      return false;
    }
    return true;
  } catch (error: any) {
    return error?.code === "ENOENT";
  } finally {
    if (quarantine) try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch {}
    if (election) releaseOwnedDirectory(election, "released");
  }
}

function acquireLedgerLock(app: string): { path: string; token: string } {
  fs.mkdirSync(ledgerDirectory(), { recursive: true });
  const lockPath = `${ledgerFilePath(app)}.lock`;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      return publishOwnedDirectory(lockPath, "claim");
    } catch (error: any) {
      if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error?.code)) throw error;
      if (reapDeadLedgerLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`timed out after ${LOCK_ACQUIRE_TIMEOUT_MS}ms waiting for trust-ledger lock '${lockPath}'`);
      Atomics.wait(LOCK_WAIT, 0, 0, 4 + Math.floor(Math.random() * 12));
    }
  }
}

function releaseLedgerLock(lock: { path: string; token: string }): void {
  releaseOwnedDirectory(lock, "released");
}

function withLedgerLock<T>(app: string, operation: () => T): T {
  const lock = acquireLedgerLock(app);
  try {
    return operation();
  } finally {
    releaseLedgerLock(lock);
  }
}

function nextSequence(events: any[]): number {
  return events.reduce((max, event) => Number.isInteger(event?.seq) ? Math.max(max, event.seq) : max, -1) + 1;
}

function captureMetadata(check: CaptureCheck) {
  return {
    sha256: check.sha256!,
    width: check.width!,
    height: check.height!,
    bytes: check.bytes!,
    format: check.format!,
  };
}

/** Materialize an already-owned byte snapshot. Producer paths use this so the bytes they measured
 * are the exact bytes copied into CAS; a mutable source pathname is never re-read after measuring. */
export function materializeCaptureBytes(sourcePath: string, immutableBytes: Buffer): { artifactPath: string; sourceArtifactPath: string; capture: ReturnType<typeof captureMetadata> } {
  const bytes = Buffer.from(immutableBytes);
  const checked = validateCaptureBuffer(bytes, sourcePath);
  if (!checked.ok) throw new Error(checked.reason ?? `artifact '${sourcePath}' is not a valid capture`);

  const artifactsDir = path.join(ledgerDirectory(), "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const extension = checked.format === "jpeg" ? "jpg" : "png";
  const destination = path.join(artifactsDir, `${checked.sha256}.${extension}`);

  const verifyExisting = () => {
    const existing = validateCapture(destination);
    if (!existing.ok || existing.sha256 !== checked.sha256) {
      throw new Error(`content-addressed artifact '${destination}' already exists but does not contain sha256 ${checked.sha256}; refusing to overwrite it`);
    }
  };

  if (fs.existsSync(destination)) {
    verifyExisting();
  } else {
    const tmp = path.join(artifactsDir, `.${checked.sha256}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try {
        // Linking a complete same-directory temporary file is atomic and cannot overwrite an
        // existing hash path. A racing writer either wins with the same bytes or is rejected.
        fs.linkSync(tmp, destination);
        fsyncDirectory(artifactsDir);
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        verifyExisting();
      }
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  }

  return { artifactPath: destination, sourceArtifactPath: sourcePath, capture: captureMetadata(checked) };
}

/** Snapshot one image from one bounded descriptor read into the content-addressed evidence store. */
export function materializeCapture(sourcePath: string): { artifactPath: string; sourceArtifactPath: string; capture: ReturnType<typeof captureMetadata> } {
  const read = readCaptureBytes(sourcePath);
  if (!read.ok) throw new Error(read.reason);
  return materializeCaptureBytes(sourcePath, read.bytes);
}

/** Validate an input without writing it. Exported for the focused gate. */
export function validateEntry(e: {
  claim: string;
  evidenceType: string;
  artifactPath?: string;
  attestation?: string;
  cClass?: string;
  deviceSerial?: string;
  deviceModel?: string;
  deviceFingerprint?: string;
  deviceBootQemu?: string;
  deviceIdentitySource?: string;
  deviceIdentityObservedAt?: string;
  deviceCaptureSource?: string;
  deviceCaptureSha256?: string;
}): { ok: boolean; error?: string; entry?: any } {
  let capture: CaptureCheck | undefined;
  if (IMAGE_EVIDENCE.has(e.evidenceType)) {
    if (!e.artifactPath) return { ok: false, error: `${e.evidenceType} REQUIRES artifactPath (the real frame) — rejected as an over-claim.` };
    capture = validateCapture(e.artifactPath);
    if (!capture.ok) return { ok: false, error: `${capture.reason} — a ${e.evidenceType} claim must link a real rendered frame.` };
    if (!e.attestation || e.attestation.trim().length < 8) return { ok: false, error: `${e.evidenceType} REQUIRES an attestation (${e.evidenceType === "vision_verified" ? "a sentence describing what you saw" : "the measurement summary"}).` };
  }
  if (e.evidenceType === "device_verified") return { ok: false, error: "device_verified cannot be minted by pure metadata validation; use record_verification so the server probes adb identity and the same-serial screencap live." };
  return {
    ok: true,
    entry: {
      claim: e.claim,
      evidenceType: e.evidenceType,
      artifactPath: e.artifactPath ?? null,
      attestation: e.attestation ?? null,
      cClass: e.cClass ?? null,
      ...(capture?.ok ? { capture: captureMetadata(capture) } : {}),
    },
  };
}

export function appendLedgerEntry(
  app: string,
  input: { claim: string; evidenceType: string; artifactPath?: string; attestation?: string; cClass?: string; reproHash?: string; extra?: Record<string, any>; runReceiptBinding?: ValidatedRunReceiptBinding },
): { status: string; reason?: string; entry?: any; warning?: string; totalEntries?: number } {
  try {
    assertCanonicalAppKey(app);
    let runReceiptBinding: ValidatedRunReceiptBinding | undefined;
    if (input.runReceiptBinding !== undefined) {
      if (!IMAGE_EVIDENCE.has(input.evidenceType)) {
        return { status: "rejected", reason: "a run receipt can bind only image-grounded evidence; it never promotes structural evidence" };
      }
      const checkedBinding = validateRunReceiptBinding(input.runReceiptBinding);
      if (!checkedBinding.ok) return { status: "rejected", reason: checkedBinding.reason };
      runReceiptBinding = checkedBinding.binding;
    }
    // Image validation/materialization is deliberately outside the short ledger transaction. It
    // can involve an arbitrarily slow filesystem read/fsync; holding a synchronous mtime-based lock
    // across that work prevents its heartbeat from running and lets another process reap a live
    // owner as stale. CAS materialization is independently race-safe (atomic link + rehash).
    let validated: any;
    if (IMAGE_EVIDENCE.has(input.evidenceType)) {
      if (!input.artifactPath) return { status: "rejected", reason: `${input.evidenceType} REQUIRES artifactPath (the real frame) — rejected as an over-claim.` };
      if (!input.attestation || input.attestation.trim().length < 8) return { status: "rejected", reason: `${input.evidenceType} REQUIRES an attestation (${input.evidenceType === "vision_verified" ? "a sentence describing what you saw" : "the measurement summary"}).` };
      if (input.evidenceType === "device_verified" && (input.extra as any)?.[DEVICE_PROBE_RECEIPT] !== true) {
        return { status: "rejected", reason: "device_verified can only be recorded through the live adb identity + same-serial screencap path; caller-supplied metadata is not hardware provenance." };
      }
      if (input.evidenceType === "auto_judged" && (input.extra as any)?.[AUTO_JUDGE_RECEIPT] !== true) {
        return { status: "rejected", reason: "auto_judged can only be recorded by the calibrated visual_judge producer after a measured PASS; caller-supplied image + prose is not a measurement receipt." };
      }
      if (input.evidenceType === "usd_host_render" && (input.extra as any)?.[USD_RENDER_RECEIPT] !== true) {
        return { status: "rejected", reason: "usd_host_render can only be recorded by the render_usd_offscreen producer after Hydra output exists; caller-supplied image + prose is not a renderer receipt." };
      }
      const lineage = input.evidenceType === "device_verified"
        ? validateRecordedDeviceLineage({
            serial: input.extra?.deviceSerial,
            model: input.extra?.deviceModel,
            fingerprint: input.extra?.deviceFingerprint,
            bootQemu: input.extra?.deviceBootQemu,
            source: input.extra?.deviceIdentitySource,
            observedAt: input.extra?.deviceIdentityObservedAt,
            captureSource: input.extra?.deviceCaptureSource,
            deviceCaptureSha256: input.extra?.deviceCaptureSha256,
            artifactSha256: input.extra?.deviceCaptureSha256,
          })
        : null;
      if (lineage && !lineage.ok) return { status: "rejected", reason: `device_verified REQUIRES validated live PICO-shaped non-emulator lineage: ${lineage.reason}.` };
      try {
        const immutableProducerBytes = (input.extra as any)?.[IMMUTABLE_CAPTURE_BYTES];
        const materialized = Buffer.isBuffer(immutableProducerBytes)
          ? materializeCaptureBytes(input.artifactPath, immutableProducerBytes)
          : materializeCapture(input.artifactPath);
        if (runReceiptBinding) {
          const checkedBinding = validateRunReceiptBinding(runReceiptBinding, materialized.capture.sha256);
          if (!checkedBinding.ok) return { status: "rejected", reason: checkedBinding.reason };
          runReceiptBinding = checkedBinding.binding;
        }
        if (lineage?.ok && materialized.capture.sha256 !== lineage.captureSha256) {
          return { status: "rejected", reason: "device_verified artifact changed after the live same-serial capture comparison; refusing to bind different bytes." };
        }
        validated = {
          claim: input.claim,
          evidenceType: input.evidenceType,
          artifactPath: materialized.artifactPath,
          sourceArtifactPath: materialized.sourceArtifactPath,
          attestation: input.attestation,
          cClass: input.cClass ?? null,
          capture: materialized.capture,
          ...(runReceiptBinding ? { runReceipt: runReceiptBinding } : {}),
          ...(input.evidenceType === "auto_judged" ? {
            evidenceProducer: {
              kind: "visual_judge",
              schemaVersion: 1,
              producedAt: new Date().toISOString(),
              artifactSha256: materialized.capture.sha256,
            },
          } : {}),
          ...(input.evidenceType === "usd_host_render" ? {
            evidenceProducer: {
              kind: "render_usd_offscreen",
              schemaVersion: 1,
              producedAt: new Date().toISOString(),
              artifactSha256: materialized.capture.sha256,
            },
            ...(input.extra?.usdRender ? { usdRender: input.extra.usdRender } : {}),
          } : {}),
          ...(lineage?.ok ? {
            deviceSerial: lineage.lineage.serial,
            deviceModel: lineage.lineage.model,
            deviceFingerprint: lineage.lineage.fingerprint,
            deviceBootQemu: lineage.lineage.bootQemu,
            deviceIdentitySource: "adb-live-probe",
            deviceIdentityObservedAt: lineage.observedAt,
            deviceCaptureSource: "adb-exec-out-screencap",
            deviceCaptureSha256: lineage.captureSha256,
            deviceFeature: input.extra?.deviceFeature,
            deviceOutcome: input.extra?.deviceOutcome,
          } : {}),
        };
      } catch (error: any) {
        return { status: "rejected", reason: `${error?.message ?? String(error)} — a ${input.evidenceType} claim must be copied into intact ledger-owned evidence.` };
      }
    } else {
      const check = validateEntry(input);
      if (!check.ok) return { status: "rejected", reason: check.error };
      validated = check.entry;
    }

    return withLedgerLock(app, () => {
      const events = loadLedgerEvents(app);

      const sha = validated.capture?.sha256;
      const reused = sha ? events.find((event) => event?.eventType !== "retraction" && event.capture?.sha256 === sha && event.claim !== input.claim) : undefined;
      // Only explicitly named metadata payloads are accepted. `extra` must never be
      // able to overwrite seq, evidenceType, capture, or inject an inline retraction.
      const metadata = {
        ...(input.extra?.autoJudge && typeof input.extra.autoJudge === "object" ? { autoJudge: input.extra.autoJudge } : {}),
      };
      const entry = {
        ...metadata,
        seq: nextSequence(events),
        ...validated,
        reproHash: input.reproHash ?? null,
        ...(reused ? { reusedArtifact: true } : {}),
      };
      events.push(entry);
      atomicSaveLedger(app, events);
      return {
        status: "recorded",
        entry,
        totalEntries: events.length,
        ...(reused ? { warning: `this capture (sha ${sha.slice(0, 12)}) is already linked to a different claim ("${reused.claim}") — flagged reusedArtifact for audit.` } : {}),
      };
    });
  } catch (error: any) {
    return { status: "rejected", reason: `could not append trust ledger: ${error?.message ?? String(error)}` };
  }
}

/** Producer-only persistence path used by visual_judge after it has computed a PASS. */
export function appendAutoJudgedEntry(
  app: string,
  input: { claim: string; artifactPath: string; artifactBytes: Buffer; attestation: string; cClass?: string; reproHash?: string; autoJudge: Record<string, any> },
) {
  const capture = validateCaptureBuffer(input.artifactBytes, input.artifactPath);
  if (!capture.ok) return { status: "rejected", reason: `visual_judge immutable artifact snapshot is invalid: ${capture.reason}` };
  return appendLedgerEntry(app, {
    claim: input.claim,
    evidenceType: "auto_judged",
    artifactPath: input.artifactPath,
    attestation: input.attestation,
    cClass: input.cClass,
    reproHash: input.reproHash,
    extra: {
      [AUTO_JUDGE_RECEIPT]: true,
      [IMMUTABLE_CAPTURE_BYTES]: Buffer.from(input.artifactBytes),
      autoJudge: { ...input.autoJudge, artifactSha256: capture.sha256 },
    },
  });
}

/** Producer-only persistence path used after render_usd_offscreen produced its output. */
export type UsdRenderMeasurement = {
  schemaVersion: 1;
  assetSha256: string;
  outputSha256: string;
  objectCount: number;
  nonBlackCoverage: number;
  dominantColors: string[];
  callerContext: { text: string; verified: false };
};

export function appendUsdHostRenderEntry(
  app: string,
  input: { claim: string; artifactPath: string; artifactBytes: Buffer; attestation: string; cClass?: string; reproHash?: string; usdRender?: UsdRenderMeasurement },
) {
  const capture = validateCaptureBuffer(input.artifactBytes, input.artifactPath);
  if (!capture.ok) return { status: "rejected", reason: `usd_host_render immutable output snapshot is invalid: ${capture.reason}` };
  if (input.usdRender) {
    const measured = input.usdRender;
    const valid = measured.schemaVersion === 1
      && SHA256_PATTERN.test(measured.assetSha256)
      && SHA256_PATTERN.test(measured.outputSha256)
      && Number.isInteger(measured.objectCount) && measured.objectCount >= 0
      && Number.isFinite(measured.nonBlackCoverage) && measured.nonBlackCoverage >= 0 && measured.nonBlackCoverage <= 1
      && Array.isArray(measured.dominantColors) && measured.dominantColors.every((color) => typeof color === "string")
      && typeof measured.callerContext?.text === "string"
      && measured.callerContext.verified === false;
    if (!valid) return { status: "rejected", reason: "usd_host_render producer metadata is malformed; refusing an unbound renderer receipt." };
    if (capture.sha256 !== measured.outputSha256) {
      return { status: "rejected", reason: `usd_host_render outputSha256 does not match the immutable rendered bytes (expected ${measured.outputSha256}, read ${capture.sha256}).` };
    }
  }
  return appendLedgerEntry(app, {
    claim: input.claim,
    evidenceType: "usd_host_render",
    artifactPath: input.artifactPath,
    attestation: input.attestation,
    cClass: input.cClass,
    reproHash: input.reproHash,
    extra: {
      [USD_RENDER_RECEIPT]: true,
      [IMMUTABLE_CAPTURE_BYTES]: Buffer.from(input.artifactBytes),
      ...(input.usdRender ? { usdRender: input.usdRender } : {}),
    },
  });
}

/**
 * Strongest-tier append path. Production supplies the real adb probe; tests inject a fixture probe
 * and therefore verify only the schema/data flow, never a Swan observation.
 */
export async function appendDeviceVerifiedEntry(
  app: string,
  input: {
    claim: string;
    artifactPath?: string;
    attestation?: string;
    cClass?: string;
    reproHash?: string;
    deviceSerial?: string;
    deviceModel?: string;
    deviceFingerprint?: string;
    deviceBootQemu?: string;
    deviceFeature?: string;
    deviceOutcome?: "pass" | "fail";
    runReceiptBinding?: ValidatedRunReceiptBinding;
  },
  probe: DeviceIdentityProbe = (serial) => probeDeviceIdentity(resolveDeviceAdb(), serial),
  captureProbe: DeviceCaptureProbe = (serial) => probeDeviceCapture(resolveDeviceAdb(), serial),
): Promise<{ status: string; reason?: string; entry?: any; warning?: string; totalEntries?: number }> {
  try {
    assertCanonicalAppKey(app);
  } catch (error: any) {
    return { status: "rejected", reason: error?.message ?? String(error) };
  }
  if (typeof input.deviceFeature !== "string" || !DEVICE_FEATURE_PATTERN.test(input.deviceFeature)) {
    return { status: "rejected", reason: "device_verified requires a structured deviceFeature slug (lowercase words joined by underscores); free-text claim matching cannot close device parity." };
  }
  if (input.deviceOutcome !== "pass" && input.deviceOutcome !== "fail") {
    return { status: "rejected", reason: "device_verified requires explicit deviceOutcome:'pass' or 'fail'; prose polarity is not inferred." };
  }
  const observed = await verifyLiveDeviceLineage({
    serial: input.deviceSerial,
    model: input.deviceModel,
    fingerprint: input.deviceFingerprint,
    bootQemu: input.deviceBootQemu,
  }, probe);
  if (!observed.ok) return { status: "rejected", reason: `device_verified REQUIRES live-probed PICO-shaped non-emulator lineage: ${observed.reason}.` };
  if (!input.artifactPath) return { status: "rejected", reason: "device_verified REQUIRES artifactPath (the exact frame LOOKED at)." };
  let liveCapture: Buffer;
  try {
    liveCapture = await captureProbe(observed.lineage.serial);
  } catch (error: any) {
    return { status: "rejected", reason: `device_verified REQUIRES a live screencap from the same probed serial: ${error?.message ?? String(error)}.` };
  }
  const liveCheck = validateCaptureBuffer(liveCapture, `live adb screencap from ${observed.lineage.serial}`);
  if (!liveCheck.ok) return { status: "rejected", reason: `device_verified live screencap was invalid: ${liveCheck.reason}.` };
  const artifactCheck = validateCapture(input.artifactPath);
  if (!artifactCheck.ok) return { status: "rejected", reason: `${artifactCheck.reason} — device_verified requires the exact live device capture.` };
  if (liveCheck.sha256 !== artifactCheck.sha256) {
    return { status: "rejected", reason: `device_verified artifact did not match the live capture from serial '${observed.lineage.serial}' (artifact sha256 ${artifactCheck.sha256}, device sha256 ${liveCheck.sha256}). Use the exact stable device screencap that you LOOKED at; arbitrary emulator/host images cannot earn device_verified.` };
  }
  return appendLedgerEntry(app, {
    claim: input.claim,
    evidenceType: "device_verified",
    artifactPath: input.artifactPath,
    attestation: input.attestation,
    cClass: input.cClass,
    reproHash: input.reproHash,
    runReceiptBinding: input.runReceiptBinding,
    extra: {
      [DEVICE_PROBE_RECEIPT]: true,
      deviceSerial: observed.lineage.serial,
      deviceModel: observed.lineage.model,
      deviceFingerprint: observed.lineage.fingerprint,
      deviceBootQemu: observed.lineage.bootQemu,
      deviceIdentitySource: observed.source,
      deviceIdentityObservedAt: observed.observedAt,
      deviceCaptureSource: "adb-exec-out-screencap",
      deviceCaptureSha256: liveCheck.sha256,
      deviceFeature: input.deviceFeature,
      deviceOutcome: input.deviceOutcome,
    } as any,
  });
}

export function appendLedgerRetraction(
  app: string,
  input: { targetSeq: number; reason: string; note?: string; recordedAt?: string },
): { status: string; reason?: string; event?: any; totalEntries?: number } {
  try {
    return withLedgerLock(app, () => {
      const events = loadLedgerEvents(app);
      const target = events.find((event) => event?.seq === input.targetSeq && event?.eventType !== "retraction");
      if (!target) return { status: "rejected", reason: `no claim entry with seq ${input.targetSeq} exists in '${app}'` };
      if (target.retracted || events.some((event) => event?.eventType === "retraction" && event.retracts === input.targetSeq)) {
        return { status: "rejected", reason: `claim seq ${input.targetSeq} is already retracted` };
      }
      if (!input.reason?.trim()) return { status: "rejected", reason: "a retraction requires a reason" };
      const event = {
        seq: nextSequence(events),
        eventType: "retraction",
        retracts: input.targetSeq,
        reason: input.reason.trim(),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        recordedAt: input.recordedAt ?? new Date().toISOString(),
      };
      events.push(event);
      atomicSaveLedger(app, events);
      return { status: "recorded", event, totalEntries: events.length };
    });
  } catch (error: any) {
    return { status: "rejected", reason: `could not append trust-ledger retraction: ${error?.message ?? String(error)}` };
  }
}

function checkProvenance(entry: any): { status: "intact" | "missing" | "mismatch" | "unverifiable"; reason?: string; expectedSha256?: string; actualSha256?: string } {
  const expected = entry?.capture;
  if (!expected?.sha256) {
    return { status: "unverifiable", reason: "the ledger row has no recorded capture sha256; current bytes cannot be backfilled as historical proof" };
  }
  const actual = validateCapture(entry?.artifactPath);
  if (!actual.ok) {
    return {
      status: /does not exist/.test(actual.reason ?? "") ? "missing" : "mismatch",
      reason: actual.reason ?? "linked evidence is not a readable image",
      expectedSha256: expected.sha256,
    };
  }
  const metadataMatches = actual.sha256 === expected.sha256
    && actual.width === expected.width
    && actual.height === expected.height
    && actual.bytes === expected.bytes
    && actual.format === expected.format;
  if (!metadataMatches) {
    return {
      status: "mismatch",
      reason: `linked evidence no longer matches recorded capture metadata (expected sha256 ${expected.sha256}, read ${actual.sha256})`,
      expectedSha256: expected.sha256,
      actualSha256: actual.sha256,
    };
  }
  return { status: "intact", expectedSha256: expected.sha256, actualSha256: actual.sha256 };
}

function checkProducerProvenance(entry: any): { status: "validated" | "unverifiable"; reason?: string; kind?: string } {
  const expectedKind = entry?.evidenceType === "auto_judged"
    ? "visual_judge"
    : entry?.evidenceType === "usd_host_render"
      ? "render_usd_offscreen"
      : undefined;
  if (!expectedKind) return { status: "unverifiable", reason: "this evidence class has no producer receipt contract" };
  const producer = entry?.evidenceProducer;
  if (!producer || producer.kind !== expectedKind || producer.schemaVersion !== 1) {
    return { status: "unverifiable", reason: `missing ${expectedKind} producer provenance; historical caller-authored metadata cannot prove this evidence class`, kind: expectedKind };
  }
  if (typeof producer.producedAt !== "string" || !Number.isFinite(Date.parse(producer.producedAt))) {
    return { status: "unverifiable", reason: `${expectedKind} producer timestamp is missing or invalid`, kind: expectedKind };
  }
  if (producer.artifactSha256 !== entry?.capture?.sha256) {
    return { status: "unverifiable", reason: `${expectedKind} producer receipt is not bound to the recorded artifact sha256`, kind: expectedKind };
  }
  if (expectedKind === "visual_judge" && entry?.autoJudge?.artifactSha256 !== entry?.capture?.sha256) {
    return { status: "unverifiable", reason: "visual_judge measurement metadata is not bound to the recorded artifact sha256", kind: expectedKind };
  }
  if (expectedKind === "render_usd_offscreen" && entry?.usdRender?.outputSha256 !== entry?.capture?.sha256) {
    return { status: "unverifiable", reason: "render_usd_offscreen measured output hash is not bound to the recorded artifact sha256", kind: expectedKind };
  }
  return { status: "validated", kind: expectedKind };
}

export type LedgerReadResult = {
  events: any[];
  effectiveEntries: any[];
  retractions: any[];
  integrityIssues: Array<{ seq: number; claim: string; claimedEvidenceType: string; provenance: any }>;
  deviceLineageIssues: Array<{ seq: number; claim: string; reason: string; claimedDeviceSerial: string | null }>;
  producerProvenanceIssues: Array<{ seq: number; claim: string; claimedEvidenceType: string; reason: string }>;
  runReceiptIssues: Array<{ seq: number; claim: string; reason: string }>;
};

/** Read append-only history and derive the evidence that is safe to consume now. */
export function readLedger(app: string): LedgerReadResult {
  const events = loadLedgerEvents(app);
  const retractions = events.filter((event) => event?.eventType === "retraction");
  const retracted = new Set(retractions.map((event) => event.retracts));
  const integrityIssues: LedgerReadResult["integrityIssues"] = [];
  const deviceLineageIssues: LedgerReadResult["deviceLineageIssues"] = [];
  const producerProvenanceIssues: LedgerReadResult["producerProvenanceIssues"] = [];
  const runReceiptIssues: LedgerReadResult["runReceiptIssues"] = [];
  const effectiveEntries: any[] = [];

  for (const raw of events) {
    if (!raw || raw.eventType === "retraction" || raw.retracted || retracted.has(raw.seq)) continue;
    const entry = { ...raw };
    if (Object.prototype.hasOwnProperty.call(entry, "runReceipt")) {
      const binding = IMAGE_EVIDENCE.has(entry.evidenceType)
        ? validateRunReceiptBinding(entry.runReceipt, entry.capture?.sha256)
        : { ok: false as const, reason: "runReceipt binding is attached to non-image evidence" };
      if (binding.ok) {
        entry.runReceipt = binding.binding;
      } else {
        entry.claimedRunReceipt = entry.runReceipt;
        delete entry.runReceipt;
        entry.runReceiptProvenance = { status: "unverifiable", reason: binding.reason };
        runReceiptIssues.push({ seq: entry.seq, claim: entry.claim, reason: binding.reason });
      }
    }
    if (IMAGE_EVIDENCE.has(entry.evidenceType)) {
      const provenance = checkProvenance(entry);
      entry.provenance = provenance;
      if (provenance.status !== "intact") {
        entry.claimedEvidenceType = entry.evidenceType;
        entry.evidenceType = "provenance-broken";
        integrityIssues.push({ seq: entry.seq, claim: entry.claim, claimedEvidenceType: entry.claimedEvidenceType, provenance });
        if (entry.runReceipt) {
          const reason = "runReceipt binding cannot be consumed because the linked capture provenance is not intact";
          entry.claimedRunReceipt = entry.runReceipt;
          delete entry.runReceipt;
          entry.runReceiptProvenance = { status: "unverifiable", reason };
          runReceiptIssues.push({ seq: entry.seq, claim: entry.claim, reason });
        }
      }
    }
    if (entry.evidenceType === "device_verified") {
      const lineage = validateRecordedDeviceLineage({
        serial: entry.deviceSerial,
        model: entry.deviceModel,
        fingerprint: entry.deviceFingerprint,
        bootQemu: entry.deviceBootQemu,
        source: entry.deviceIdentitySource,
        observedAt: entry.deviceIdentityObservedAt,
        captureSource: entry.deviceCaptureSource,
        deviceCaptureSha256: entry.deviceCaptureSha256,
        artifactSha256: entry.capture?.sha256,
      });
      if (lineage.ok) {
        entry.deviceLineage = { status: "validated", ...lineage.lineage, source: "adb-live-probe", observedAt: lineage.observedAt, captureSource: "adb-exec-out-screencap", captureSha256: lineage.captureSha256 };
      } else {
        // The immutable image and LOOK still earn vision_verified. What fails is only the stronger
        // assertion that those pixels came from real PICO hardware.
        entry.claimedEvidenceType = "device_verified";
        entry.evidenceType = "vision_verified";
        entry.deviceLineage = { status: "unverifiable", reason: lineage.reason };
        deviceLineageIssues.push({ seq: entry.seq, claim: entry.claim, reason: lineage.reason, claimedDeviceSerial: entry.deviceSerial ?? null });
      }
    }
    if (entry.evidenceType === "auto_judged" || entry.evidenceType === "usd_host_render") {
      const producer = checkProducerProvenance(entry);
      entry.producerProvenance = producer;
      if (producer.status !== "validated") {
        entry.claimedEvidenceType = entry.evidenceType;
        entry.evidenceType = "structural";
        producerProvenanceIssues.push({ seq: entry.seq, claim: entry.claim, claimedEvidenceType: entry.claimedEvidenceType, reason: producer.reason ?? "producer provenance is unverifiable" });
      }
    }
    effectiveEntries.push(entry);
  }
  return { events, effectiveEntries, retractions, integrityIssues, deviceLineageIssues, producerProvenanceIssues, runReceiptIssues };
}

export function buildLedgerReport(app: string) {
  const read = readLedger(app);
  const features = read.effectiveEntries.map((entry) => ({
    name: entry.claim,
    status: entry.evidenceType === "device_verified" && entry.deviceOutcome !== "pass"
      ? "structural"
      : EVIDENCE_TO_STATUS[entry.evidenceType] ?? "structural",
    evidence: entry.evidenceType === "provenance-broken"
      ? `${entry.claimedEvidenceType} provenance ${entry.provenance?.status}: ${entry.provenance?.reason}`
      : entry.evidenceType === "device_verified" && entry.deviceOutcome !== "pass"
        ? `${entry.artifactPath} — DEVICE-OBSERVED ${entry.deviceOutcome ?? "outcome-unstructured"}: ${entry.attestation}; not positive capability proof`
      : (entry.claimedEvidenceType === "auto_judged" || entry.claimedEvidenceType === "usd_host_render") && entry.producerProvenance?.status !== "validated"
        ? `${entry.artifactPath} — DOWNGRADED from ${entry.claimedEvidenceType}: ${entry.producerProvenance?.reason}`
      : entry.claimedEvidenceType === "device_verified" && entry.deviceLineage?.status !== "validated"
        ? `${entry.artifactPath} — ${entry.attestation} — DOWNGRADED from device_verified: ${entry.deviceLineage?.reason}`
      : IMAGE_EVIDENCE.has(entry.evidenceType)
        ? `${entry.artifactPath} — ${entry.attestation}`
        : entry.attestation ?? entry.evidenceType,
    ...(entry.evidenceType === "device_verified" ? {
      deviceSerial: entry.deviceSerial,
      deviceModel: entry.deviceModel,
      deviceFingerprint: entry.deviceFingerprint,
      deviceBootQemu: entry.deviceBootQemu,
    } : {}),
    ...(entry.cClass && entry.cClass !== "C0_emulator" ? { ceiling: entry.cClass.replace("_headset_only", "").replace("_emulator", "") } : {}),
  }));
  return {
    app,
    entryCount: read.effectiveEntries.length,
    historyEntryCount: read.events.length,
    ledger: read.effectiveEntries,
    history: read.events,
    retractions: read.retractions,
    integrityIssues: read.integrityIssues,
    deviceLineageIssues: read.deviceLineageIssues,
    producerProvenanceIssues: read.producerProvenanceIssues,
    runReceiptIssues: read.runReceiptIssues,
    capabilityReport: buildCapabilityMatrix(app, features),
  };
}

export function isPassingDeviceEvidence(entry: any): boolean {
  return entry?.evidenceType === "device_verified"
    && entry?.deviceOutcome === "pass"
    && typeof entry?.deviceFeature === "string"
    && DEVICE_FEATURE_PATTERN.test(entry.deviceFeature)
    && entry?.deviceLineage?.status === "validated";
}

export const registerLedgerTools: RegisterLedgerTools = (server, deps = {}) => {
  server.registerTool(
    "record_verification",
    {
      description:
        "Append a verification claim or an append-only retraction event to an app's trust ledger. Record and retract fields are mutually exclusive. For a retraction, explicitly set action:'retract', targetSeq, and retractionReason; the original row remains immutable but is excluded from effective proof. Image evidence needs a structurally complete PNG/JPEG plus attestation and is copied into content-addressed storage. To bind an exact LOOK to native-run provenance, pass the runReceiptId returned by pico_build_app with that receipt's exact capture; the receipt never changes the requested evidence class. device_verified additionally uses live identity + same-serial screencap probes. auto_judged and usd_host_render are producer-only: use visual_judge or render_usd_offscreen. Stored bytes are revalidated on every report read.",
      inputSchema: {
        app: z.string().regex(CANONICAL_APP_KEY_PATTERN).describe("Canonical app/package ledger key: lowercase ASCII letters, digits, dot, underscore, or hyphen; no paths or spaces."),
        action: z.enum(["record", "retract"]).optional().describe("Default record. Use retract to append a correction that excludes targetSeq without mutating it."),
        claim: z.string().optional().describe("Record action: the claim, e.g. '6 shelf cards render in the forward FOV'."),
        evidenceType: evidenceTypeSchema.optional().describe("Record action: how it was verified. Image-grounded classes require a linked capture + attestation. auto_judged/usd_host_render cannot be minted here; use their producer tools."),
        artifactPath: z.string().optional().describe("Path to the capture that was LOOKED at or measured; copied into immutable ledger-owned storage."),
        attestation: z.string().optional().describe("What was seen or measured (required for image-grounded evidence)."),
        cClass: z.enum(["C0_emulator", "C1", "C2", "C3", "C4_headset_only"]).optional().describe("The node's capability class."),
        reproHash: z.string().optional().describe("Canonical pose + seed hash (v5.5 reproducibility)."),
        runReceiptId: z.string().regex(SHA256_PATTERN).optional().describe("Record action only: receiptId returned by pico_build_app. Pass it only after LOOKING at that receipt's exact capture; binding records provenance and never promotes the evidence class."),
        deviceSerial: z.string().optional().describe("Attached adb serial (REQUIRED for device_verified; the server probes this serial live)."),
        deviceModel: z.string().optional().describe("Optional expected ro.product.model; if supplied it must match the live probe."),
        deviceFingerprint: z.string().optional().describe("Optional expected ro.build.fingerprint; if supplied it must match the live probe."),
        deviceBootQemu: z.string().optional().describe("Optional expected ro.boot.qemu; if supplied it must match the live probe. Live value '1' is rejected."),
        deviceFeature: z.string().regex(DEVICE_FEATURE_PATTERN).optional().describe("device_verified only: structured feature slug measured on-device (for example controller_ray); required with deviceOutcome."),
        deviceOutcome: z.enum(["pass", "fail"]).optional().describe("device_verified only: explicit observed outcome. Parity closes only an exact deviceFeature with pass; claim prose is never interpreted as polarity."),
        targetSeq: z.number().int().nonnegative().optional().describe("Retract action: sequence of the earlier claim to correct."),
        retractionReason: z.string().optional().describe("Retract action: why the earlier claim can no longer be relied on."),
        retractionNote: z.string().optional().describe("Retract action: optional nuance retained in history."),
      },
    },
    async ({ app, action, claim, evidenceType, artifactPath, attestation, cClass, reproHash, runReceiptId, deviceSerial, deviceModel, deviceFingerprint, deviceBootQemu, deviceFeature, deviceOutcome, targetSeq, retractionReason, retractionNote }) => {
      const mode = action ?? "record";
      const recordFields = { claim, evidenceType, artifactPath, attestation, cClass, reproHash, runReceiptId, deviceSerial, deviceModel, deviceFingerprint, deviceBootQemu, deviceFeature, deviceOutcome };
      const retractionFields = { targetSeq, retractionReason, retractionNote };
      if (mode === "retract") {
        const mixed = Object.entries(recordFields).filter(([, value]) => value !== undefined).map(([name]) => name);
        if (mixed.length) {
          return okJson({ status: "rejected", app, reason: `record and retract are mutually exclusive; retract action received record-only field(s): ${mixed.join(", ")}` });
        }
        if (targetSeq === undefined || !retractionReason?.trim()) {
          return okJson({ status: "rejected", app, reason: "a retraction requires targetSeq and retractionReason" });
        }
        return okJson({ ...appendLedgerRetraction(app, { targetSeq, reason: retractionReason, note: retractionNote }), app });
      }
      const mixed = Object.entries(retractionFields).filter(([, value]) => value !== undefined).map(([name]) => name);
      if (mixed.length) {
        return okJson({ status: "rejected", app, reason: `record and retract are mutually exclusive; record action received retraction-only field(s): ${mixed.join(", ")}. Set action:'retract' and omit record fields to append a correction.` });
      }
      if (!claim?.trim() || !evidenceType) {
        return okJson({ status: "rejected", app, reason: "record action requires claim and evidenceType" });
      }
      let runReceiptBinding: ValidatedRunReceiptBinding | undefined;
      if (runReceiptId !== undefined) {
        if (!IMAGE_EVIDENCE.has(evidenceType)) {
          return okJson({ status: "rejected", app, reason: "runReceiptId can bind only image-grounded evidence and never promotes structural evidence" });
        }
        if (!artifactPath) {
          return okJson({ status: "rejected", app, reason: "runReceiptId requires artifactPath for the exact receipt-bound capture" });
        }
        if (!deps.resolveRunReceiptBinding) {
          return okJson({ status: "rejected", app, reason: "run receipt binding resolver is not configured; refusing to record an unbound receipt ID" });
        }
        let resolved: ReceiptCaptureBindingResult;
        try {
          resolved = deps.resolveRunReceiptBinding(app, runReceiptId, artifactPath);
        } catch (error: any) {
          return okJson({ status: "rejected", app, reason: `run receipt binding could not be resolved: ${error?.message ?? String(error)}` });
        }
        if (resolved.status !== "valid") {
          return okJson({ status: "rejected", app, reason: `run receipt binding rejected: ${resolved.reason}` });
        }
        const checked = validateRunReceiptBinding(resolved.binding);
        if (!checked.ok || checked.binding.receiptId !== runReceiptId) {
          return okJson({ status: "rejected", app, reason: checked.ok ? "run receipt resolver returned a different receiptId" : `run receipt resolver returned an invalid binding: ${checked.reason}` });
        }
        runReceiptBinding = checked.binding;
      }
      const res = evidenceType === "device_verified"
        ? await appendDeviceVerifiedEntry(app, { claim, artifactPath, attestation, cClass, reproHash, deviceSerial, deviceModel, deviceFingerprint, deviceBootQemu, deviceFeature, deviceOutcome, runReceiptBinding })
        : appendLedgerEntry(app, { claim, evidenceType, artifactPath, attestation, cClass, reproHash, runReceiptBinding });
      return okJson({ ...res, app });
    },
  );

  server.registerTool(
    "ledger_report",
    {
      description:
        "Read an app's complete append-only trust-ledger history, honor retraction events, revalidate every linked image against its recorded hash/metadata, and generate the capability report from only effective evidence. Missing, malformed, or changed captures are explicit provenance-broken structural rows and never print as vision_verified/device_verified/auto_judged/usd_host_render.",
      inputSchema: { app: z.string().regex(CANONICAL_APP_KEY_PATTERN).describe("Canonical app/package ledger key: lowercase ASCII letters, digits, dot, underscore, or hyphen; no paths or spaces.") },
    },
    async ({ app }) => {
      try {
        return okJson(buildLedgerReport(app));
      } catch (error: any) {
        return okJson({ status: "error", app, entryCount: 0, ledger: [], integrityIssues: [{ reason: error?.message ?? String(error) }], capabilityReport: buildCapabilityMatrix(app, []) });
      }
    },
  );
};
