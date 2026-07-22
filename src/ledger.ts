import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { buildCapabilityMatrix } from "./capability.js";
import { validateCapture } from "./evidence.js";

/**
 * ledger.ts — v5.3 the TRUST LEDGER: make over-claims structurally impossible.
 *
 * A machine-readable, append-only verification ledger per app. Every claim is recorded with its
 * evidenceType, and the schema FORBIDS recording a `vision_verified` claim without a linked capture
 * artifact that EXISTS on disk + a LOOK attestation (what was seen). The capability_report and the ship
 * report are then GENERATED from the ledger — so a report can never assert "verified" for a node lacking a
 * linked, LOOKED-at frame. This is the honest-verification soul, enforced in the DATA MODEL rather than by
 * discipline alone (the user has caught the over-claim twice; now the ledger rejects it).
 *
 * evidenceType → capability_report status:
 *   vision_verified   -> vision_verified   (REQUIRES artifactPath (exists) + attestation)
 *   logcat            -> logcat_asserted
 *   structural        -> structural
 *   compiles          -> compiles
 *   built_for_headset -> built_for_headset (C1/C3/C4 — pre-built for Swan)
 */

const evidenceTypeSchema = z.enum(["device_verified", "vision_verified", "auto_judged", "usd_host_render", "logcat", "structural", "compiles", "built_for_headset"]);
const EVIDENCE_TO_STATUS: Record<string, string> = {
  device_verified: "device_verified", // v18 lane: a LOOKED-at capture from REAL PICO hardware — outranks emulator vision
  vision_verified: "vision_verified",
  auto_judged: "auto_judged",
  usd_host_render: "usd_host_render",
  logcat: "logcat_asserted",
  structural: "structural",
  compiles: "compiles",
  built_for_headset: "built_for_headset",
};

const LEDGER_DIR = path.join(os.homedir(), ".pico-mcp", "ledgers");
const ledgerPath = (app: string) => path.join(LEDGER_DIR, `${app.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

function loadLedger(app: string): any[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(app), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function saveLedger(app: string, entries: any[]) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.writeFileSync(ledgerPath(app), JSON.stringify(entries, null, 2));
}

/** The enforcement gate, exported so the fixture test can call it directly. Returns {ok, error?, entry?}. */
export function validateEntry(e: {
  claim: string;
  evidenceType: string;
  artifactPath?: string;
  attestation?: string;
  cClass?: string;
}): { ok: boolean; error?: string; entry?: any } {
  let capture: ReturnType<typeof validateCapture> | undefined;
  // Human vision, the automated eye, the off-device USD render, and REAL-DEVICE vision must all
  // be grounded in a REAL image.
  if (e.evidenceType === "device_verified" || e.evidenceType === "vision_verified" || e.evidenceType === "auto_judged" || e.evidenceType === "usd_host_render") {
    const label = e.evidenceType;
    if (!e.artifactPath) return { ok: false, error: `${label} REQUIRES artifactPath (the real frame) — rejected as an over-claim.` };
    // The artifact must be a REAL rendered image, not just a path that resolves. A .txt file,
    // /etc/hosts, a 0-byte file, or a directory used to pass fs.existsSync — they no longer do.
    capture = validateCapture(e.artifactPath);
    if (!capture.ok) return { ok: false, error: `${capture.reason} — a ${label} claim must link a real rendered frame (v6.1 evidence gate).` };
    if (!e.attestation || e.attestation.trim().length < 8) return { ok: false, error: `${label} REQUIRES an attestation (${label === "vision_verified" ? "a sentence describing what you saw" : "the measurement summary"}).` };
  }
  return {
    ok: true,
    entry: {
      claim: e.claim,
      evidenceType: e.evidenceType,
      artifactPath: e.artifactPath ?? null,
      attestation: e.attestation ?? null,
      cClass: e.cClass ?? null,
      ...(capture?.ok ? { capture: { sha256: capture.sha256, width: capture.width, height: capture.height, bytes: capture.bytes, format: capture.format } } : {}),
    },
  };
}

/**
 * Append an entry to an app's ledger THROUGH the honesty gate (validateEntry). Shared by
 * record_verification and the automated eye (visual_judge), so every write is gated identically.
 * Returns {status, entry?, reason?, warning?, totalEntries?}.
 */
export function appendLedgerEntry(
  app: string,
  input: { claim: string; evidenceType: string; artifactPath?: string; attestation?: string; cClass?: string; reproHash?: string; extra?: Record<string, any> },
): { status: string; reason?: string; entry?: any; warning?: string; totalEntries?: number } {
  const v = validateEntry(input);
  if (!v.ok) return { status: "rejected", reason: v.error };
  const entries = loadLedger(app);
  const sha = v.entry?.capture?.sha256;
  const reused = sha ? entries.find((x) => x.capture?.sha256 === sha && x.claim !== input.claim) : undefined;
  const entry = { seq: entries.length, ...v.entry, reproHash: input.reproHash ?? null, ...(input.extra ?? {}), ...(reused ? { reusedArtifact: true } : {}) };
  entries.push(entry);
  saveLedger(app, entries);
  return {
    status: "recorded",
    entry,
    totalEntries: entries.length,
    ...(reused ? { warning: `this capture (sha ${sha!.slice(0, 12)}) is already linked to a different claim ("${reused.claim}") — flagged reusedArtifact for audit.` } : {}),
  };
}

export function registerLedgerTools(server: McpServer) {
  server.registerTool(
    "record_verification",
    {
      description:
        "Append a verification claim to an app's trust ledger. THE HONESTY GATE (v6.1): a `vision_verified` entry is REJECTED unless artifactPath links a REAL rendered image — a valid PNG/JPEG with real dimensions, not merely a path that resolves (a .txt file, /etc/hosts, a 0-byte file, or a directory are all rejected) — plus an attestation (what you saw). The entry records the frame's sha256+dimensions for provenance, and reusing one frame across different claims is flagged (reusedArtifact) for audit. This makes the trivial spoofs impossible; it still cannot prove the frame shows the right thing (that is the calibrated visual judge). Other evidence types (logcat / structural / compiles / built_for_headset) record existence honestly. The ship report + capability_report are GENERATED from this ledger (ledger_report), never hand-written. Record one entry per verificationPlan node as you verify it.",
      inputSchema: {
        app: z.string().describe("App name or package (the ledger key)."),
        claim: z.string().describe("The claim, e.g. '6 shelf cards render in the forward FOV'."),
        evidenceType: evidenceTypeSchema.describe("How it was verified. vision_verified needs a linked, existing capture + attestation."),
        artifactPath: z.string().optional().describe("Path to the capture you LOOKED at (REQUIRED for vision_verified; must exist)."),
        attestation: z.string().optional().describe("What you saw in the capture (REQUIRED for vision_verified)."),
        cClass: z.enum(["C0_emulator", "C1", "C2", "C3", "C4_headset_only"]).optional().describe("The node's capability class."),
        reproHash: z.string().optional().describe("Canonical pose + seed hash (v5.5 reproducibility)."),
        deviceSerial: z.string().optional().describe("Real-device serial (adb devices -l) — set when the capture came from hardware, e.g. for device_verified entries."),
      },
    },
    async ({ app, claim, evidenceType, artifactPath, attestation, cClass, reproHash, deviceSerial }) => {
      // reuse detection + the honesty gate live in the shared helper (also used by the automated eye).
      const res = appendLedgerEntry(app, { claim, evidenceType, artifactPath, attestation, cClass, reproHash, extra: deviceSerial ? { deviceSerial } : undefined });
      return okJson({ ...res, app });
    },
  );

  server.registerTool(
    "ledger_report",
    {
      description:
        "Read an app's trust ledger and GENERATE the honest capability_report from it (verified-on-emulator vs structural vs built-for-Swan). Because vision_verified entries were gated at record time (they must link an existing capture + attestation), this report cannot over-claim by construction. Use this to produce the ship report instead of writing capability_report by hand.",
      inputSchema: {
        app: z.string().describe("App name or package (the ledger key)."),
      },
    },
    async ({ app }) => {
      const entries = loadLedger(app);
      const features = entries.map((e) => ({
        name: e.claim,
        status: EVIDENCE_TO_STATUS[e.evidenceType] ?? "structural",
        evidence: e.evidenceType === "vision_verified" ? `${e.artifactPath} — ${e.attestation}` : e.attestation ?? e.evidenceType,
        ...(e.cClass && e.cClass !== "C0_emulator" ? { ceiling: e.cClass.replace("_headset_only", "").replace("_emulator", "") } : {}),
      }));
      const report = buildCapabilityMatrix(app, features);
      return okJson({ app, entryCount: entries.length, ledger: entries, capabilityReport: report });
    },
  );
}
