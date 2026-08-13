import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { buildCapabilityMatrix } from "./capability.js";
import { validateCapture, validateCaptureBuffer, type CaptureCheck } from "./evidence.js";

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

export function ledgerDirectory(): string {
  return process.env.PICO_MCP_LEDGER_DIR
    ? path.resolve(process.env.PICO_MCP_LEDGER_DIR)
    : path.join(os.homedir(), ".pico-mcp", "ledgers");
}

export function ledgerFilePath(app: string): string {
  return path.join(ledgerDirectory(), `${app.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
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
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
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

/** Snapshot one image from one read into the content-addressed evidence store. */
export function materializeCapture(sourcePath: string): { artifactPath: string; sourceArtifactPath: string; capture: ReturnType<typeof captureMetadata> } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    throw new Error(`artifact '${sourcePath}' does not exist`);
  }
  if (!stat.isFile()) throw new Error(`artifact '${sourcePath}' is not a regular file`);

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(sourcePath);
  } catch (error: any) {
    throw new Error(`artifact '${sourcePath}' could not be read: ${error?.message ?? String(error)}`);
  }
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

/** Validate an input without writing it. Exported for the focused gate. */
export function validateEntry(e: {
  claim: string;
  evidenceType: string;
  artifactPath?: string;
  attestation?: string;
  cClass?: string;
}): { ok: boolean; error?: string; entry?: any } {
  let capture: CaptureCheck | undefined;
  if (IMAGE_EVIDENCE.has(e.evidenceType)) {
    if (!e.artifactPath) return { ok: false, error: `${e.evidenceType} REQUIRES artifactPath (the real frame) — rejected as an over-claim.` };
    capture = validateCapture(e.artifactPath);
    if (!capture.ok) return { ok: false, error: `${capture.reason} — a ${e.evidenceType} claim must link a real rendered frame.` };
    if (!e.attestation || e.attestation.trim().length < 8) return { ok: false, error: `${e.evidenceType} REQUIRES an attestation (${e.evidenceType === "vision_verified" ? "a sentence describing what you saw" : "the measurement summary"}).` };
  }
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
  input: { claim: string; evidenceType: string; artifactPath?: string; attestation?: string; cClass?: string; reproHash?: string; extra?: Record<string, any> },
): { status: string; reason?: string; entry?: any; warning?: string; totalEntries?: number } {
  let events: any[];
  try {
    events = loadLedgerEvents(app);
  } catch (error: any) {
    return { status: "rejected", reason: error?.message ?? String(error) };
  }

  let validated: any;
  if (IMAGE_EVIDENCE.has(input.evidenceType)) {
    if (!input.artifactPath) return { status: "rejected", reason: `${input.evidenceType} REQUIRES artifactPath (the real frame) — rejected as an over-claim.` };
    if (!input.attestation || input.attestation.trim().length < 8) return { status: "rejected", reason: `${input.evidenceType} REQUIRES an attestation (${input.evidenceType === "vision_verified" ? "a sentence describing what you saw" : "the measurement summary"}).` };
    try {
      const materialized = materializeCapture(input.artifactPath);
      validated = {
        claim: input.claim,
        evidenceType: input.evidenceType,
        artifactPath: materialized.artifactPath,
        sourceArtifactPath: materialized.sourceArtifactPath,
        attestation: input.attestation,
        cClass: input.cClass ?? null,
        capture: materialized.capture,
      };
    } catch (error: any) {
      return { status: "rejected", reason: `${error?.message ?? String(error)} — a ${input.evidenceType} claim must be copied into intact ledger-owned evidence.` };
    }
  } else {
    const check = validateEntry(input);
    if (!check.ok) return { status: "rejected", reason: check.error };
    validated = check.entry;
  }

  const sha = validated.capture?.sha256;
  const reused = sha ? events.find((event) => event?.eventType !== "retraction" && event.capture?.sha256 === sha && event.claim !== input.claim) : undefined;
  // Only the two metadata payloads used by in-repo callers are accepted. `extra` must never be
  // able to overwrite seq, evidenceType, capture, or inject an inline retraction.
  const metadata = {
    ...(typeof input.extra?.deviceSerial === "string" ? { deviceSerial: input.extra.deviceSerial } : {}),
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
  try {
    atomicSaveLedger(app, events);
  } catch (error: any) {
    return { status: "rejected", reason: `could not append trust ledger: ${error?.message ?? String(error)}` };
  }
  return {
    status: "recorded",
    entry,
    totalEntries: events.length,
    ...(reused ? { warning: `this capture (sha ${sha.slice(0, 12)}) is already linked to a different claim ("${reused.claim}") — flagged reusedArtifact for audit.` } : {}),
  };
}

export function appendLedgerRetraction(
  app: string,
  input: { targetSeq: number; reason: string; note?: string; recordedAt?: string },
): { status: string; reason?: string; event?: any; totalEntries?: number } {
  let events: any[];
  try {
    events = loadLedgerEvents(app);
  } catch (error: any) {
    return { status: "rejected", reason: error?.message ?? String(error) };
  }
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
  try {
    atomicSaveLedger(app, events);
  } catch (error: any) {
    return { status: "rejected", reason: `could not append trust-ledger retraction: ${error?.message ?? String(error)}` };
  }
  return { status: "recorded", event, totalEntries: events.length };
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

export type LedgerReadResult = {
  events: any[];
  effectiveEntries: any[];
  retractions: any[];
  integrityIssues: Array<{ seq: number; claim: string; claimedEvidenceType: string; provenance: any }>;
};

/** Read append-only history and derive the evidence that is safe to consume now. */
export function readLedger(app: string): LedgerReadResult {
  const events = loadLedgerEvents(app);
  const retractions = events.filter((event) => event?.eventType === "retraction");
  const retracted = new Set(retractions.map((event) => event.retracts));
  const integrityIssues: LedgerReadResult["integrityIssues"] = [];
  const effectiveEntries: any[] = [];

  for (const raw of events) {
    if (!raw || raw.eventType === "retraction" || raw.retracted || retracted.has(raw.seq)) continue;
    const entry = { ...raw };
    if (IMAGE_EVIDENCE.has(entry.evidenceType)) {
      const provenance = checkProvenance(entry);
      entry.provenance = provenance;
      if (provenance.status !== "intact") {
        entry.claimedEvidenceType = entry.evidenceType;
        entry.evidenceType = "provenance-broken";
        integrityIssues.push({ seq: entry.seq, claim: entry.claim, claimedEvidenceType: entry.claimedEvidenceType, provenance });
      }
    }
    effectiveEntries.push(entry);
  }
  return { events, effectiveEntries, retractions, integrityIssues };
}

export function buildLedgerReport(app: string) {
  const read = readLedger(app);
  const features = read.effectiveEntries.map((entry) => ({
    name: entry.claim,
    status: EVIDENCE_TO_STATUS[entry.evidenceType] ?? "structural",
    evidence: entry.evidenceType === "provenance-broken"
      ? `${entry.claimedEvidenceType} provenance ${entry.provenance?.status}: ${entry.provenance?.reason}`
      : IMAGE_EVIDENCE.has(entry.evidenceType)
        ? `${entry.artifactPath} — ${entry.attestation}`
        : entry.attestation ?? entry.evidenceType,
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
    capabilityReport: buildCapabilityMatrix(app, features),
  };
}

export function registerLedgerTools(server: McpServer) {
  server.registerTool(
    "record_verification",
    {
      description:
        "Append a verification claim to an app's trust ledger. Image-grounded evidence is rejected without a real PNG/JPEG plus an attestation, then copied into a ledger-owned content-addressed store. The stored sha256 and image metadata are revalidated whenever reports read the claim; missing or changed bytes become provenance-broken, never visual proof. Other evidence types record existence honestly. Record one entry per verificationPlan node.",
      inputSchema: {
        app: z.string().describe("App name or package (the ledger key)."),
        claim: z.string().describe("The claim, e.g. '6 shelf cards render in the forward FOV'."),
        evidenceType: evidenceTypeSchema.describe("How it was verified. Image-grounded classes require a linked capture + attestation."),
        artifactPath: z.string().optional().describe("Path to the capture that was LOOKED at or measured; copied into immutable ledger-owned storage."),
        attestation: z.string().optional().describe("What was seen or measured (required for image-grounded evidence)."),
        cClass: z.enum(["C0_emulator", "C1", "C2", "C3", "C4_headset_only"]).optional().describe("The node's capability class."),
        reproHash: z.string().optional().describe("Canonical pose + seed hash (v5.5 reproducibility)."),
        deviceSerial: z.string().optional().describe("Real-device serial — set when the capture came from hardware."),
      },
    },
    async ({ app, claim, evidenceType, artifactPath, attestation, cClass, reproHash, deviceSerial }) => {
      const res = appendLedgerEntry(app, { claim, evidenceType, artifactPath, attestation, cClass, reproHash, extra: deviceSerial ? { deviceSerial } : undefined });
      return okJson({ ...res, app });
    },
  );

  server.registerTool(
    "ledger_report",
    {
      description:
        "Read an app's complete append-only trust-ledger history, honor retraction events, revalidate every linked image against its recorded hash/metadata, and generate the capability report from only effective evidence. Missing, malformed, or changed captures are explicit provenance-broken structural rows and never print as vision_verified/device_verified/auto_judged/usd_host_render.",
      inputSchema: { app: z.string().describe("App name or package (the ledger key).") },
    },
    async ({ app }) => {
      try {
        return okJson(buildLedgerReport(app));
      } catch (error: any) {
        return okJson({ status: "error", app, entryCount: 0, ledger: [], integrityIssues: [{ reason: error?.message ?? String(error) }], capabilityReport: buildCapabilityMatrix(app, []) });
      }
    },
  );
}
