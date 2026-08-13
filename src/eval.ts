import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema } from "./appspec.js";
import { lintSpec, emulatorVsSwanPreview } from "./planner.js";
import { buildLedger } from "./compiler.js";
import { classifyBriefExecution } from "./briefroute.js";
import { isPassingDeviceEvidence, readLedger } from "./ledger.js";

/**
 * eval.ts — v5.4 EVAL CORPUS + scorecard: measure brief-generality as a DISTRIBUTION, not one anecdote.
 *
 * `run_brief_suite` walks a curated briefs/ corpus (each entry = brief + a draft AppSpec + an expected
 * shape) and, per brief, headlessly PLANS (validate + feasibility lint) and COMPILES (build the ledger),
 * scoring each against its expected node counts + C-class split, then emits a scorecard. A broken generator
 * (a spec that no longer validates, or references a tool missing from the manifest) visibly drops the score.
 * It reads the v5.3 trust ledger to fold in any nodes already vision-verified on the emulator. The visual
 * nodes themselves need a per-brief emulator build to turn PASS — this suite scores the PLAN+COMPILE tier
 * (fully headless + reproducible); the batched-montage visual pass is the emulator-gated extension.
 */

export function summarizeLookedEvidence(entries: any[]): { visionVerified: number; deviceVerified: number; deviceFailed: number; lookedVerified: number } {
  const visionVerified = entries.filter((entry) => entry?.evidenceType === "vision_verified").length;
  const deviceVerified = entries.filter(isPassingDeviceEvidence).length;
  const deviceFailed = entries.filter((entry) => entry?.evidenceType === "device_verified" && entry?.deviceOutcome === "fail" && entry?.deviceLineage?.status === "validated").length;
  return { visionVerified, deviceVerified, deviceFailed, lookedVerified: visionVerified + deviceVerified };
}

function ledgerLookedCounts(pkg: string): ReturnType<typeof summarizeLookedEvidence> {
  try {
    return summarizeLookedEvidence(readLedger(pkg).effectiveEntries);
  } catch {
    return { visionVerified: 0, deviceVerified: 0, deviceFailed: 0, lookedVerified: 0 };
  }
}

export function defaultBriefsDir(): string {
  // dist/eval.js -> ../briefs == repo/briefs
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "briefs");
}

/** Compute the full suite (scorecard + rows) over a briefs dir. Exported so regression_gate reuses it. */
export function computeSuite(briefsDir?: string): { status: string; briefsDir: string; scorecard: any; rows: any[]; error?: string } {
  const dir = briefsDir ?? defaultBriefsDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch (e: any) {
    return { status: "error", briefsDir: dir, scorecard: null, rows: [], error: `cannot read briefs dir ${dir}: ${e.message}` };
  }
  const rows = files.map((f) => {
    try {
      return scoreBrief(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch (e: any) {
      return { id: f, pass: false, specValid: false, issues: [String(e.message)] };
    }
  });
  const skippedRows = rows.filter((r: any) => Boolean(r.skipped));
  const scoredRows = rows.filter((r: any) => !r.skipped);
  const passed = scoredRows.filter((r) => r.pass).length;
  const scorecard = {
    total: scoredRows.length,
    corpusTotal: rows.length,
    passed,
    failed: scoredRows.length - passed,
    skipped: skippedRows.length,
    planFailures: rows.filter((r) => r.specValid === false || r.planOk === false).length,
    totalCompileSteps: rows.reduce((a, r: any) => a + (r.compileSteps ?? 0), 0),
    totalVisionVerified: rows.reduce((a, r: any) => a + (r.visionVerifiedInLedger ?? 0), 0),
    totalDeviceVerified: rows.reduce((a, r: any) => a + (r.deviceVerifiedInLedger ?? 0), 0),
    totalDeviceFailed: rows.reduce((a, r: any) => a + (r.deviceFailedInLedger ?? 0), 0),
    totalLookedVerified: rows.reduce((a, r: any) => a + (r.lookedVerifiedInLedger ?? 0), 0),
    score: scoredRows.length ? Number((passed / scoredRows.length).toFixed(3)) : null,
  };
  return { status: "ok", briefsDir: dir, scorecard, rows };
}

function scoreBrief(entry: any) {
  let execution;
  try {
    execution = classifyBriefExecution(entry);
  } catch (error: any) {
    return { id: entry.id, pass: false, specValid: false, issues: [String(error.message)] };
  }
  const parsed = appSpecSchema.safeParse(entry.spec);
  if (!parsed.success) {
    return { id: entry.id, pass: false, specValid: false, issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const spec = parsed.data;
  const lint = lintSpec(spec);
  const external = execution.route === "hand-authored-classic-android";
  const ledger = external ? [] : buildLedger(spec, "/tmp/eval-dummy");
  const preview = emulatorVsSwanPreview(spec);
  const exp = entry.expected ?? {};
  const counts = {
    scenes: spec.scenes.length,
    layouts: spec.layouts.length,
    objects: spec.objects.length,
    data: spec.data.length,
    interactions: spec.interactions.length,
    panels: spec.panels.length,
  };
  const mism: string[] = [];
  for (const k of ["scenes", "layouts", "objects", "data", "interactions", "panels"] as const) {
    if (exp[k] != null && counts[k] !== exp[k]) mism.push(`${k}: got ${counts[k]}, expected ${exp[k]}`);
  }
  if (exp.verifiableNowMin != null && preview.verifiableNow.length < exp.verifiableNowMin) mism.push(`verifiableNow ${preview.verifiableNow.length} < ${exp.verifiableNowMin}`);
  if (exp.swanMin != null && preview.builtForSwan.length < exp.swanMin) mism.push(`builtForSwan ${preview.builtForSwan.length} < ${exp.swanMin}`);
  const planOk = lint.errors.length === 0;
  const compileOk = ledger.length > 0;
  const shapeOk = mism.length === 0;
  const looked = ledgerLookedCounts(spec.meta.packageName);
  return {
    id: entry.id,
    pass: external ? null : planOk && compileOk && shapeOk,
    skipped: external ? `execution route ${execution.route}; generic AppSpec compile/build intentionally skipped` : null,
    specValid: true,
    planOk,
    compileSteps: ledger.length,
    lintErrors: lint.errors,
    lintWarnings: lint.warnings.length,
    counts,
    verifiableNow: preview.verifiableNow.length,
    builtForSwan: preview.builtForSwan.length,
    visionVerifiedInLedger: looked.visionVerified,
    deviceVerifiedInLedger: looked.deviceVerified,
    deviceFailedInLedger: looked.deviceFailed,
    lookedVerifiedInLedger: looked.lookedVerified,
    shapeMismatches: mism,
  };
}

export function registerEvalTools(server: McpServer) {
  server.registerTool(
    "run_brief_suite",
    {
      description:
        "Run the brief-generality eval corpus: for each brief in briefs/ (brief + draft AppSpec + expected shape), headlessly PLAN (validate + feasibility lint) and COMPILE (build ledger), score against the expected node counts + C-class split, and emit a scorecard (planned/compiled/shape-match/verifiableNow/builtForSwan + ledger evidence counts). Positive device_verified PASS and looked-at device FAIL findings are counted separately; FAIL never contributes to lookedVerified proof. Fully headless + reproducible; per-brief emulator builds + a visual montage are the emulator-gated extension.",
      inputSchema: {
        briefsDir: z.string().optional().describe("Directory of brief JSON files (default the repo's briefs/)."),
      },
    },
    async ({ briefsDir }) => okJson(computeSuite(briefsDir)),
  );
}
