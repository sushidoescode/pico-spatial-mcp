import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import { okJson } from "./util.js";
import { ledgerDirectory, readLedger } from "./ledger.js";

/**
 * capabilityreport.ts — v10.17 (P15): the honest CAPABILITY MATRIX.
 *
 * Reads the whole trust ledger (~/.pico-mcp/ledgers/*.json) into one honest report: every proven
 * capability grouped by category, with its STRONGEST evidence class — vision_verified (a human/agent
 * LOOKED) ranks above auto_judged (the calibrated eye) above usd_host_render / structural /
 * built_for_headset (deferred to Swan/OS6). The honesty invariant made visible at a glance: the
 * report can never show 'verified' for something without a linked, looked-at capture in the ledger.
 */
const RANK: Record<string, number> = { device_verified: 6, vision_verified: 5, auto_judged: 4, usd_host_render: 3, logcat: 2, structural: 2, compiles: 1, built_for_headset: 1, built_for_os6: 1 };

const CATS: { cat: string; kw: RegExp }[] = [
  { cat: "Real physics (native)", kw: /physic|rigid|\bball\b|strike|\bpin\b|bowl|launch|collision/i },
  { cat: "Interactive menus", kw: /menu|clickable|\bpress\b|gamemenu|button|mouse bridge/i },
  { cat: "Live-text / HUD panels", kw: /\bhud\b|scoreboard|live[- ]?text|live metrics|panel compose|throws/i },
  { cat: "Web panels (live DOM)", kw: /web ?panel|webview|live dom|webgl|browser|web content/i },
  { cat: "Multi-panel web workspace", kw: /workspace|multi-panel|panel_cmd|spatial panels/i },
  { cat: "WebSpatial (React, OS6)", kw: /webspatial|2d projection|react/i },
  { cat: "Web↔3D bridge", kw: /bridge|native\.send|control panel/i },
  { cat: "Web 3D (three.js)", kw: /three\.js|galaxy|orrery.*web|web3d|webgl2.*render/i },
  { cat: "AAA fidelity", kw: /\bpbr\b|shadow|\bibl\b|metal|emissi|lighting|shine|studio/i },
  { cat: "Pipeline (brief→app)", kw: /pipeline|compile_app_spec|knockdown template|generate_app_wiring|100% by the pipeline/i },
  { cat: "Unattended fleet", kw: /fleet|factory|unattended|auto_judged/i },
  { cat: "Editor integration", kw: /editor|palette|gamestats|add component|spatialeditorcomponent/i },
  { cat: "Custom worlds / env", kw: /splat|world lab|marble|skybox|environment|pano/i },
  { cat: "Off-device render", kw: /off-device|usdrecord|usd_host_render|usd composition|lathe|pin\b.*silhouette/i },
];

export function registerCapabilityReportTools(server: McpServer) {
  server.registerTool(
    "capability_matrix",
    {
      description:
        "THE HONEST CROSS-LEDGER CAPABILITY MATRIX (P15, distinct from per-app capability_report): reads the whole trust ledger (~/.pico-mcp/ledgers) into one report — every proven capability by category, with its STRONGEST evidence class (vision_verified > auto_judged > usd_host_render/structural > built-for-Swan/OS6). Makes the honesty invariant visible at a glance: nothing shows 'verified' without a linked, looked-at capture. Returns the headline counts, the per-category matrix (with the best evidence + a sample claim), and the honest deferrals (Swan/OS6). Read-only. Use it to answer 'what can this MCP actually do, and how do we know'.",
      inputSchema: {
        category: z.string().optional().describe("Filter to one category substring (e.g. 'physics', 'web')."),
        appFilter: z.string().optional().describe("Only ledgers whose app id contains this."),
      },
    },
    async ({ category, appFilter }) => {
      const ledgerDir = ledgerDirectory();
      if (!fs.existsSync(ledgerDir)) return okJson({ status: "ok", note: "no ledgers yet", categories: [] });
      const files = fs.readdirSync(ledgerDir).filter((f) => f.endsWith(".json"));
      const all: any[] = [];
      const unreadableLedgers: string[] = [];
      for (const f of files) {
        const app = f.replace(/\.json$/, "");
        if (appFilter && !app.includes(appFilter)) continue;
        try {
          for (const e of readLedger(app).effectiveEntries) all.push({ ...e, app });
        } catch (error: any) { unreadableLedgers.push(`${app}: ${error?.message ?? String(error)}`); }
      }
      const byType: Record<string, number> = {};
      for (const e of all) byType[e.evidenceType] = (byType[e.evidenceType] ?? 0) + 1;
      const broken = all.filter((entry) => entry.evidenceType === "provenance-broken");
      const proofs = all.filter((entry) => entry.evidenceType !== "provenance-broken");

      const cats = CATS.map(({ cat, kw }) => {
        const hits = proofs.filter((e) => kw.test(e.claim ?? "") || kw.test(e.attestation ?? ""));
        if (!hits.length) return null;
        const best = hits.reduce((a, b) => ((RANK[b.evidenceType] ?? 0) > (RANK[a.evidenceType] ?? 0) ? b : a));
        return {
          category: cat,
          proofs: hits.length,
          bestEvidence: best.evidenceType,
          apps: [...new Set(hits.map((h) => h.app))],
          sampleClaim: (best.claim ?? "").slice(0, 140),
          artifact: best.artifactPath ?? null,
        };
      }).filter(Boolean).filter((c: any) => !category || c.category.toLowerCase().includes(category.toLowerCase()));

      const visionN = byType.vision_verified ?? 0;
      return okJson({
        status: "ok",
        headline: `${cats.length} capability categories with active proof across ${new Set(proofs.map((e) => e.app)).size} apps; ${proofs.length} effective proof entries (${visionN} vision_verified — a human/agent LOOKED); ${broken.length} provenance-broken visual claim(s) excluded.`,
        evidenceTotals: byType,
        categories: cats,
        integrityIssues: broken.map((entry) => ({ app: entry.app, seq: entry.seq, claim: entry.claim, claimedEvidenceType: entry.claimedEvidenceType, provenance: entry.provenance })),
        unreadableLedgers,
        honesty: "Ranking: vision_verified > auto_judged > usd_host_render/structural > built-for-Swan/OS6. Every image-grounded row is rehashed on this read. Broken provenance is excluded from categories and reported separately; unreadable ledgers are disclosed, never treated as proof.",
      });
    },
  );
}
