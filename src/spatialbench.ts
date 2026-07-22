import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { computeSuite, defaultBriefsDir } from "./eval.js";
import { innerCall } from "./doors.js";
import { measurePerf, scorePerfAxis } from "./perfprobe.js";

/**
 * spatialbench.ts — v23 SPATIALBENCH: the conformance corpus as a SCORED, public harness.
 *
 * The corpus (briefs/) already regression-gates the compiler; this module turns it into a
 * benchmark anyone can read and re-run: per-brief axes, a league table, and a static report.
 *
 * Six axes per brief (each 0/1, honest by construction), plus an optional 7th:
 *   planned   — the AppSpec validates + feasibility lint passes        (headless)
 *   compiled  — the build ledger emits compile steps                   (headless)
 *   shape     — node counts match the brief's expected shape           (headless)
 *   booted    — gradle-built, installed, launched, process alive       (emulator)
 *   captured  — the deterministic forward capture exists               (emulator)
 *   eye       — the CALIBRATED JUDGE passes the frame — auto_judged,   (emulator)
 *               NEVER vision_verified; escalations mean a human looks
 *   perf      — OPTIONAL (tier=full + perfAxis:true): measure_perf's UI/RenderThread frame       (emulator)
 *               p95 is under perfBudgetMs. This is scoped to what gfxinfo actually measures on
 *               this emulator (Compose panels/2D activities) — NOT the spatial engine's 3D frame
 *               pacing. A brief with no UI frame data (a spatial-only app has ~none) scores perf
 *               as null — a SKIP, not a fail — and is excluded from the axis max, never zeroed.
 *
 * The report says exactly which tier ran: a headless run scores /3 and never implies runtime
 * evidence. Skipped briefs (external-asset gates) are reported as skipped, not as zeros.
 */

// Emulator-tier core set: briefs whose assets are self-contained (no external splat/pano/GLB).
const BENCH_CORE = ["crystals", "boutique", "knockdown", "gallery", "console", "dashboard", "affordance"];

type BenchRow = {
  id: string;
  planned: 0 | 1;
  compiled: 0 | 1;
  shape: 0 | 1;
  booted: 0 | 1 | null; // null = tier not run or skipped
  captured: 0 | 1 | null;
  eye: 0 | 1 | null;
  perf: 0 | 1 | null; // null = perf axis not requested, brief skipped, not booted, or no UI frame data
  score: number;
  max: number;
  skipped: string | null;
  notes: string[];
};

export function headlessRows(briefIds?: string[]): { rows: BenchRow[]; briefsDir: string } {
  const suite = computeSuite();
  const rows: BenchRow[] = suite.rows
    .filter((r: any) => !briefIds?.length || briefIds.includes(r.id))
    .map((r: any) => ({
      id: r.id,
      planned: r.specValid !== false && r.planOk !== false ? 1 : 0,
      compiled: (r.compileSteps ?? 0) > 0 ? 1 : 0,
      shape: r.specValid !== false && (r.shapeMismatches ?? ["invalid"]).length === 0 ? 1 : 0,
      booted: null,
      captured: null,
      eye: null,
      perf: null,
      score: 0,
      max: 3,
      skipped: null,
      notes: [...(r.lintErrors ?? []), ...(r.shapeMismatches ?? [])].slice(0, 3),
    }));
  for (const r of rows) r.score = r.planned + r.compiled + r.shape;
  return { rows, briefsDir: suite.briefsDir };
}

export function renderBenchHtml(report: any): string {
  const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dot = (v: 0 | 1 | null) => (v === null ? '<span class="na">—</span>' : v ? '<span class="y">●</span>' : '<span class="n">○</span>');
  const rows = report.rows
    .map((r: BenchRow) => `<tr><td>${esc(r.id)}</td><td>${dot(r.planned)}</td><td>${dot(r.compiled)}</td><td>${dot(r.shape)}</td><td>${dot(r.booted)}</td><td>${dot(r.captured)}</td><td>${dot(r.eye)}</td><td>${dot(r.perf ?? null)}</td><td><b>${r.score}/${r.max}</b>${r.skipped ? ` <small>skipped: ${esc(r.skipped)}</small>` : ""}</td><td class="notes">${esc(r.notes.join("; "))}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SpatialBench — pico-spatial-mcp</title>
<style>
:root{color-scheme:dark}body{margin:0;padding:2rem;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,"Segoe UI",sans-serif;max-width:66rem;margin-inline:auto}
h1{font-size:1.6rem}table{border-collapse:collapse;width:100%;font-size:.86rem}
th,td{padding:.45rem .6rem;border-bottom:1px solid #21262d;text-align:left;vertical-align:top}
th{color:#8b949e;font-weight:600}.y{color:#7ce38b}.n{color:#f85149}.na{color:#484f58}
.notes{color:#8b949e;font-size:.78rem}small{color:#d29922}
.how{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:.9rem 1.1rem;font-size:.88rem;margin:1rem 0}
footer{color:#8b949e;font-size:.78rem;margin-top:2rem;border-top:1px solid #21262d;padding-top:.8rem}
code{font-family:ui-monospace,monospace;color:#79c0ff}
</style></head><body>
<h1>SpatialBench</h1>
<p><b>${report.summary.total} briefs · tier: ${esc(report.tier)} · aggregate ${report.summary.aggregate}/${report.summary.maxAggregate} (${Math.round((report.summary.aggregate / Math.max(1, report.summary.maxAggregate)) * 100)}%)</b> — the pico-spatial-mcp conformance corpus, scored per axis. Re-run it yourself: <code>run_spatialbench</code>.</p>
<div class="how"><b>Reading the axes:</b> planned/compiled/shape are headless (spec validity, ledger emission, expected node counts). booted/captured/eye need the PICO emulator. <b>eye = the calibrated visual judge (auto_judged)</b> — a machine verdict, deliberately NOT vision_verified; escalations name the frames a human must look at. Skipped briefs gate on external assets (splats/panos) and are marked, not zeroed. <b>perf</b> (optional, tier=full with perfAxis:true) measures only the app's UI/RenderThread frames via <code>dumpsys gfxinfo</code> on the emulator, verdicting p95 against a budget in ms — this is structural evidence about 2D/Compose surfaces, NOT the spatial engine's 3D frame pacing (that needs <code>pico-cli perf</code> / perf_diagnose on a real device); a brief with no UI frame data (expected for spatial-only content) shows as — and is not counted against the axis max.</div>
<table><thead><tr><th>brief</th><th>planned</th><th>compiled</th><th>shape</th><th>booted</th><th>captured</th><th>eye</th><th>perf</th><th>score</th><th>notes</th></tr></thead>
<tbody>${rows}</tbody></table>
<footer>Generated ${esc(report.generatedAt)} by pico-spatial-mcp <code>run_spatialbench</code> · corpus: ${esc(report.briefsDir)} · escalations: ${report.summary.escalations.length ? esc(report.summary.escalations.join(", ")) : "none"}</footer>
</body></html>\n`;
}

export function registerSpatialBenchTools(server: McpServer) {
  server.tool(
    "run_spatialbench",
    "v23 SPATIALBENCH: score the conformance corpus (briefs/) as a public benchmark and emit a static league-table report (docs/spatialbench/). tier='headless' (default, CI-safe) scores planned/compiled/shape per brief from the spec+ledger alone — /3, no runtime claims. tier='full' additionally fleet-builds each brief on the emulator and scores booted/captured/eye — /6, where eye is the CALIBRATED JUDGE (auto_judged, never vision_verified; escalations name frames for a human LOOK). Asset-gated briefs are reported as skipped, not zeroed. perfAxis:true (tier='full' only) adds a 7th 'perf' axis via measure_perf: 1 = UI/RenderThread frame p95 under perfBudgetMs, 0 = over budget, null (not counted) when the emulator reports no UI frame data for the app — scoped honestly to gfxinfo's UI surfaces only, not the spatial engine's 3D pacing. Returns the report paths + the league table.",
    {
      tier: z.enum(["headless", "full"]).default("headless").describe("headless = spec+ledger axes only; full = also emulator boot/capture/eye per brief (slow, serial)"),
      briefIds: z.array(z.string()).optional().describe(`full tier defaults to the self-contained core set [${BENCH_CORE.join(", ")}]; headless defaults to every brief`),
      settleSec: z.number().min(0).max(120).default(14).describe("full tier: seconds to settle after launch before capture"),
      outDir: z.string().optional().describe("report dir (default <repo>/docs/spatialbench)"),
      perfAxis: z.boolean().default(false).describe("tier='full' only: after boot/capture/eye, sample measure_perf for the brief's package and score a 7th 'perf' axis (0/1/null)"),
      perfBudgetMs: z.number().default(16.7).describe("perfAxis frame budget in ms for the UI/RenderThread p95 (default 16.7ms = 60fps-class)"),
    },
    async ({ tier, briefIds, settleSec, outDir, perfAxis, perfBudgetMs }) => {
      const emulatorIds = briefIds?.length ? briefIds : BENCH_CORE;
      // full tier keeps EVERY brief's headless row and adds emulator axes for the core set only
      const { rows, briefsDir } = headlessRows(tier === "full" ? undefined : briefIds);
      if (tier === "full") {
        for (const row of rows) {
          if (!emulatorIds.includes(row.id)) continue;
          try {
            const fleet = await innerCall("fleet_build", { briefIds: [row.id], settleSec });
            const r = fleet?.results?.[0] ?? {};
            const skipNote = (r.notes ?? []).find((n: string) => /skip/i.test(n));
            if (!r.built && skipNote) {
              row.skipped = skipNote.replace(/^skip\w*:\s*/i, "");
              continue; // asset-gated: axes stay null, max stays 3
            }
            row.max = 6;
            row.booted = r.built && r.installed ? 1 : 0;
            row.captured = r.artifact && fs.existsSync(r.artifact) ? 1 : 0;
            row.eye = r.verdict === "PASS" ? 1 : 0;
            row.score = row.planned + row.compiled + row.shape + row.booted + row.captured + row.eye;
            row.notes.push(...(r.notes ?? []).slice(0, 2));

            if (perfAxis) {
              if (row.booted !== 1) {
                row.notes.push("perf: skipped (app never booted, nothing to measure)");
              } else {
                try {
                  // v27.5: fleet_build always installs each brief under com.fleet.<id> — reuse
                  // that identity rather than re-deriving it from the (already-mutated) spec.
                  const probe = await measurePerf(`com.fleet.${row.id}`, { sampleSec: 10 });
                  row.perf = scorePerfAxis(probe, perfBudgetMs);
                  if (row.perf === null) {
                    row.notes.push("perf: no UI frame data on this emulator (spatial-only content — not a failure; see honesty note)");
                  } else {
                    row.max += 1;
                    row.score += row.perf;
                    row.notes.push(`perf: UI p95=${probe.p95 ?? "?"}ms vs budget ${perfBudgetMs}ms -> ${row.perf ? "under" : "over"}`);
                  }
                } catch (e) {
                  row.notes.push(`perf probe error: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            }
          } catch (e) {
            row.max = 6;
            row.booted = 0;
            row.captured = 0;
            row.eye = 0;
            row.notes.push(`fleet error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      const summary = {
        total: rows.length,
        aggregate: rows.reduce((a, r) => a + r.score, 0),
        maxAggregate: rows.reduce((a, r) => a + r.max, 0),
        skipped: rows.filter((r) => r.skipped).map((r) => r.id),
        escalations: rows.filter((r) => r.eye === 0 && r.captured === 1).map((r) => r.id),
      };
      const dir = outDir ?? path.join(process.cwd(), "docs", "spatialbench");
      fs.mkdirSync(dir, { recursive: true });
      const report = { generatedAt: new Date().toISOString(), tier, briefsDir, summary, rows };
      const htmlPath = path.join(dir, "index.html");
      const jsonPath = path.join(dir, "results.json");
      fs.writeFileSync(htmlPath, renderBenchHtml(report));
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
      return okJson({ status: "ok", tier, htmlPath, jsonPath, summary, league: rows.map((r) => ({ id: r.id, score: `${r.score}/${r.max}`, skipped: r.skipped })) });
    },
  );
}
