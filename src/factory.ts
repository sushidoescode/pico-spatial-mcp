import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema } from "./appspec.js";
import { lintSpec, emulatorVsSwanPreview } from "./planner.js";
import { buildLedger } from "./compiler.js";
import { computeSuite } from "./eval.js";
import { classifyBriefExecution } from "./briefroute.js";
import { readLedger } from "./ledger.js";

/**
 * factory.ts — v6.0 THE AUTONOMOUS SPATIAL FACTORY: a queue of briefs → verified, ledgered,
 * regression-gated, Swan-ready apps, with a reproducible fleet dashboard.
 *
 * `run_factory` composes the whole v5 stack per brief: PLAN (validate + feasibility lint) → COMPILE (build
 * ledger) → score the plan+compile tier → fold in the trust ledger (what's vision-verified) + the parity
 * ledger (what's built-for-Swan / device-verified) → emit a per-brief factory record + a fleet dashboard.
 * It runs the eval scorecard as CI, and reflects: aggregates recurring lint warnings across the fleet as
 * candidate new lessons (record_lesson) — the reflection-on-failure loop. The per-brief EMULATOR build +
 * vision pass (brief_to_app) and Swan flip (swan_verify_matrix) are driven by autonomous_spatial_build_v6;
 * this tool is the deterministic, headless fleet controller + dashboard. NO aggregate over-claim: a fleet
 * metric never upgrades any node's evidence class — vision_verified still comes only from the trust ledger.
 */

function ledgerCounts(pkg: string): { visionVerified: number; autoJudged: number; builtForHeadset: number } {
  try {
    const arr = readLedger(pkg).effectiveEntries;
    return {
      visionVerified: arr.filter((e: any) => e.evidenceType === "vision_verified").length,
      autoJudged: arr.filter((e: any) => e.evidenceType === "auto_judged").length,
      builtForHeadset: arr.filter((e: any) => e.evidenceType === "built_for_headset").length,
    };
  } catch {
    return { visionVerified: 0, autoJudged: 0, builtForHeadset: 0 };
  }
}

function corpusDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "briefs");
}

function declaredExecutionForId(id: string, dir: string): unknown | undefined {
  try {
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
      try {
        const candidate = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        if (candidate?.id === id && candidate.execution !== undefined) return candidate.execution;
      } catch {
        // A malformed unrelated corpus row is handled by the eval gate; it must not make a
        // caller-supplied queue silently lose the authoritative route for a different id.
      }
    }
  } catch {
    // A custom queue may intentionally run without a corpus directory.
  }
  return undefined;
}

export function processBrief(entry: { id: string; brief?: string; spec?: any; execution?: unknown }) {
  let execution;
  try {
    const declaredExecution = declaredExecutionForId(entry.id, corpusDir());
    const effectiveEntry = entry.execution === undefined && declaredExecution !== undefined
      ? { ...entry, execution: declaredExecution }
      : entry;
    execution = classifyBriefExecution(effectiveEntry);
    if (declaredExecution !== undefined && entry.execution !== undefined) {
      const declared = classifyBriefExecution({ execution: declaredExecution });
      if (JSON.stringify(execution) !== JSON.stringify(declared)) {
        throw new Error(`queue execution metadata for '${entry.id}' conflicts with the corpus declaration`);
      }
    }
  } catch (error: any) {
    return { id: entry.id, status: "invalid_execution", issues: [String(error.message)], lintWarnings: [] };
  }
  if (execution.route === "hand-authored-classic-android") {
    return {
      id: entry.id,
      app: entry.spec?.meta?.appName ?? entry.id,
      packageName: execution.packageName,
      status: "external_implementation",
      projectPath: execution.projectPath,
      launcherActivity: execution.launcherActivity,
      planOk: null,
      lintErrors: [],
      lintWarnings: [],
      compileSteps: 0,
      emulatorVerifiableNodes: 0,
      builtForSwanNodes: 0,
      ledger: ledgerCounts(execution.packageName),
      note: "Generic AppSpec factory intentionally skipped; build the declared hand-authored classic Android project.",
    };
  }
  const parsed = appSpecSchema.safeParse(entry.spec);
  if (!parsed.success) return { id: entry.id, status: "invalid_spec", issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) };
  const spec = parsed.data;
  const lint = lintSpec(spec);
  const ledger = buildLedger(spec, `/tmp/factory/${entry.id}`);
  const preview = emulatorVsSwanPreview(spec);
  const led = ledgerCounts(spec.meta.packageName);
  const planOk = lint.errors.length === 0;
  const compileOk = ledger.length > 0;
  return {
    id: entry.id,
    app: spec.meta.appName,
    packageName: spec.meta.packageName,
    status: planOk && compileOk ? "ready_to_build" : "blocked",
    planOk,
    lintErrors: lint.errors,
    lintWarnings: lint.warnings,
    compileSteps: ledger.length,
    emulatorVerifiableNodes: preview.verifiableNow.length,
    builtForSwanNodes: preview.builtForSwan.length,
    ledger: led, // ACTUAL verified counts (trust ledger) — never inflated by the fleet metric
  };
}

export function summarizeFactoryStatuses(records: Array<{ status?: string }>) {
  return {
    readyToBuild: records.filter((record) => record.status === "ready_to_build").length,
    blocked: records.filter((record) => record.status === "blocked").length,
    externalImplementations: records.filter((record) => record.status === "external_implementation").length,
    invalid: records.filter((record) => record.status === "invalid_spec" || record.status === "invalid_execution").length,
  };
}

export function registerFactoryTools(server: McpServer) {
  server.registerTool(
    "run_factory",
    {
      description:
        "The v6.0 autonomous spatial factory: take a QUEUE of briefs (each with a draft AppSpec) and run the whole pipeline headlessly per brief — PLAN (validate + feasibility lint) → COMPILE (build ledger) → fold in the trust ledger (vision-verified nodes) + parity ledger (built-for-Swan) — then emit a per-brief factory record + a reproducible FLEET DASHBOARD, run the eval scorecard as CI, and reflect (recurring lint warnings across the fleet → candidate record_lesson entries). Deterministic + headless; the per-brief emulator build + vision pass and the Swan flip are driven by the autonomous_spatial_build_v6 prompt. NO aggregate over-claim — a fleet metric never upgrades any node's evidence class; vision_verified counts come only from the trust ledger.",
      inputSchema: {
        queue: z.array(z.object({ id: z.string(), brief: z.string().optional(), spec: z.any(), execution: z.any().optional() })).optional().describe("Briefs with draft AppSpecs. Omit to run the repo's briefs/ corpus."),
        briefsDir: z.string().optional().describe("Corpus dir (default the repo's briefs/) used when queue is omitted."),
      },
    },
    async ({ queue, briefsDir }) => {
      // build the work queue
      let work: { id: string; brief?: string; spec?: any; execution?: unknown }[] = queue ?? [];
      if (!work.length) {
        const dir = briefsDir ?? corpusDir();
        try {
          work = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
            const b = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            return { id: b.id ?? f, brief: b.brief, spec: b.spec, execution: b.execution };
          });
        } catch (e: any) {
          return okJson({ status: "error", error: `cannot read briefs dir ${dir}: ${e.message}` });
        }
      }
      if (!work.length) return okJson({ status: "error", error: "empty queue (pass `queue` or a `briefsDir`)." });

      // Queue callers cannot override the repository's declared route by pairing a known id with
      // an unrelated briefsDir. Entries loaded from a custom corpus already carry their own
      // execution metadata; the repository corpus remains authoritative for known queue ids.
      const records = work.map((entry) => processBrief(entry));
      const statusSummary = summarizeFactoryStatuses(records);
      const ready = statusSummary.readyToBuild;
      // reflection: recurring lint warnings across the fleet -> candidate lessons
      const warnCounts: Record<string, number> = {};
      for (const r of records as any[]) for (const w of r.lintWarnings ?? []) warnCounts[w] = (warnCounts[w] ?? 0) + 1;
      const reflections = Object.entries(warnCounts).filter(([, n]) => n >= 2).map(([w, n]) => `${n}× "${w}" — consider a record_lesson rule`);
      // CI: the regression scorecard over the corpus
      const ci = computeSuite(briefsDir);

      const dashboard = {
        queued: records.length,
        ...statusSummary,
        totalCompileSteps: records.reduce((a, r: any) => a + (r.compileSteps ?? 0), 0),
        totalEmulatorVerifiableNodes: records.reduce((a, r: any) => a + (r.emulatorVerifiableNodes ?? 0), 0),
        totalBuiltForSwanNodes: records.reduce((a, r: any) => a + (r.builtForSwanNodes ?? 0), 0),
        totalVisionVerifiedInLedger: records.reduce((a, r: any) => a + (r.ledger?.visionVerified ?? 0), 0),
        totalAutoJudgedInLedger: records.reduce((a, r: any) => a + (r.ledger?.autoJudged ?? 0), 0),
        ciScore: ci.status === "ok" ? ci.scorecard.score : null,
      };
      return okJson({
        status: "ok",
        fleetDashboard: dashboard,
        records,
        reflections: reflections.length ? reflections : ["no recurring warnings across the fleet"],
        note: `Factory processed ${records.length} briefs: ${ready} ready-to-build (=plan+compile OK, NOT built/run), CI score ${dashboard.ciScore}. Drive the per-brief emulator build + vision pass via autonomous_spatial_build_v6; Swan flip via swan_verify_matrix. Reproducible + headless. Evidence counts come only from the trust ledger and stay DISTINCT: vision_verified (human-seen) and auto_judged (calibrated eye, measured) are never merged and never inflated by any fleet metric.`,
      });
    },
  );
}
