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
import { computeSuite } from "./eval.js";

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

function ledgerCounts(pkg: string): { visionVerified: number; builtForHeadset: number } {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pico-mcp", "ledgers", `${pkg.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), "utf8"));
    if (!Array.isArray(arr)) return { visionVerified: 0, builtForHeadset: 0 };
    return { visionVerified: arr.filter((e: any) => e.evidenceType === "vision_verified").length, builtForHeadset: arr.filter((e: any) => e.evidenceType === "built_for_headset").length };
  } catch {
    return { visionVerified: 0, builtForHeadset: 0 };
  }
}

function corpusDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "briefs");
}

function processBrief(entry: { id: string; brief?: string; spec?: any }) {
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

export function registerFactoryTools(server: McpServer) {
  server.registerTool(
    "run_factory",
    {
      description:
        "The v6.0 autonomous spatial factory: take a QUEUE of briefs (each with a draft AppSpec) and run the whole pipeline headlessly per brief — PLAN (validate + feasibility lint) → COMPILE (build ledger) → fold in the trust ledger (vision-verified nodes) + parity ledger (built-for-Swan) — then emit a per-brief factory record + a reproducible FLEET DASHBOARD, run the eval scorecard as CI, and reflect (recurring lint warnings across the fleet → candidate record_lesson entries). Deterministic + headless; the per-brief emulator build + vision pass and the Swan flip are driven by the autonomous_spatial_build_v6 prompt. NO aggregate over-claim — a fleet metric never upgrades any node's evidence class; vision_verified counts come only from the trust ledger.",
      inputSchema: {
        queue: z.array(z.object({ id: z.string(), brief: z.string().optional(), spec: z.any() })).optional().describe("Briefs with draft AppSpecs. Omit to run the repo's briefs/ corpus."),
        briefsDir: z.string().optional().describe("Corpus dir (default the repo's briefs/) used when queue is omitted."),
      },
    },
    async ({ queue, briefsDir }) => {
      // build the work queue
      let work: { id: string; brief?: string; spec?: any }[] = queue ?? [];
      if (!work.length) {
        const dir = briefsDir ?? corpusDir();
        try {
          work = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
            const b = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            return { id: b.id ?? f, brief: b.brief, spec: b.spec };
          });
        } catch (e: any) {
          return okJson({ status: "error", error: `cannot read briefs dir ${dir}: ${e.message}` });
        }
      }
      if (!work.length) return okJson({ status: "error", error: "empty queue (pass `queue` or a `briefsDir`)." });

      const records = work.map(processBrief);
      const ready = records.filter((r: any) => r.status === "ready_to_build").length;
      // reflection: recurring lint warnings across the fleet -> candidate lessons
      const warnCounts: Record<string, number> = {};
      for (const r of records as any[]) for (const w of r.lintWarnings ?? []) warnCounts[w] = (warnCounts[w] ?? 0) + 1;
      const reflections = Object.entries(warnCounts).filter(([, n]) => n >= 2).map(([w, n]) => `${n}× "${w}" — consider a record_lesson rule`);
      // CI: the regression scorecard over the corpus
      const ci = computeSuite(briefsDir);

      const dashboard = {
        queued: records.length,
        readyToBuild: ready,
        blocked: records.length - ready,
        invalid: records.filter((r: any) => r.status === "invalid_spec").length,
        totalCompileSteps: records.reduce((a, r: any) => a + (r.compileSteps ?? 0), 0),
        totalEmulatorVerifiableNodes: records.reduce((a, r: any) => a + (r.emulatorVerifiableNodes ?? 0), 0),
        totalBuiltForSwanNodes: records.reduce((a, r: any) => a + (r.builtForSwanNodes ?? 0), 0),
        totalVisionVerifiedInLedger: records.reduce((a, r: any) => a + (r.ledger?.visionVerified ?? 0), 0),
        ciScore: ci.status === "ok" ? ci.scorecard.score : null,
      };
      return okJson({
        status: "ok",
        fleetDashboard: dashboard,
        records,
        reflections: reflections.length ? reflections : ["no recurring warnings across the fleet"],
        note: `Factory processed ${records.length} briefs: ${ready} ready-to-build, CI score ${dashboard.ciScore}. Drive the per-brief emulator build + vision pass via autonomous_spatial_build_v6; Swan flip via swan_verify_matrix. Reproducible + headless; vision_verified counts are the trust ledger's, never inflated.`,
      });
    },
  );
}
