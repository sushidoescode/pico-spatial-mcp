import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema } from "./appspec.js";
import { lintSpec, emulatorVsSwanPreview } from "./planner.js";
import { buildLedger } from "./compiler.js";
import { classifyBriefExecution } from "./briefroute.js";

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

const LEDGER_DIR = path.join(os.homedir(), ".pico-mcp", "ledgers");
function ledgerVisionCount(pkg: string): number {
  try {
    const p = path.join(LEDGER_DIR, `${pkg.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr.filter((e: any) => e.evidenceType === "vision_verified").length : 0;
  } catch {
    return 0;
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
    score: scoredRows.length ? Number((passed / scoredRows.length).toFixed(3)) : 0,
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
  const compileOk = external || ledger.length > 0;
  const shapeOk = mism.length === 0;
  return {
    id: entry.id,
    pass: planOk && compileOk && shapeOk,
    skipped: external ? `execution route ${execution.route}; generic AppSpec compile/build intentionally skipped` : null,
    specValid: true,
    planOk,
    compileSteps: ledger.length,
    lintErrors: lint.errors,
    lintWarnings: lint.warnings.length,
    counts,
    verifiableNow: preview.verifiableNow.length,
    builtForSwan: preview.builtForSwan.length,
    visionVerifiedInLedger: ledgerVisionCount(spec.meta.packageName),
    shapeMismatches: mism,
  };
}

export function registerEvalTools(server: McpServer) {
  server.registerTool(
    "run_brief_suite",
    {
      description:
        "Run the brief-generality eval corpus: for each brief in briefs/ (brief + draft AppSpec + expected shape), headlessly PLAN (validate + feasibility lint) and COMPILE (build ledger), score against the expected node counts + C-class split, and emit a scorecard (planned/compiled/shape-match/verifiableNow/builtForSwan + ledger vision counts). Measures brief-generality as a distribution; a broken generator (spec fails to validate or references a missing tool) visibly drops the score. Fully headless + reproducible; per-brief emulator builds + a visual montage are the emulator-gated extension.",
      inputSchema: {
        briefsDir: z.string().optional().describe("Directory of brief JSON files (default the repo's briefs/)."),
      },
    },
    async ({ briefsDir }) => okJson(computeSuite(briefsDir)),
  );
}
