import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { computeSuite } from "./eval.js";
import { innerCall } from "./doors.js";
import { measurePerf, scorePerfAxis } from "./perfprobe.js";
import { runPerfDiagnose, scorePicoCliPerfAxis } from "./perfcli.js";
import { deriveVerificationRoute, structuralPanelCount, type VerificationRoute } from "./fleetbuild.js";

/**
 * spatialbench.ts — v23 SPATIALBENCH: the conformance corpus as a SCORED, public harness.
 *
 * The corpus (briefs/) already regression-gates the compiler; this module turns it into a
 * benchmark anyone can read and re-run: per-brief axes, a league table, and a static report.
 *
 * Six core axes per brief (each 0/1, honest by construction), plus panel/perf axes when applicable:
 *   planned   — the AppSpec validates + feasibility lint passes        (headless)
 *   compiled  — the build ledger emits compile steps                   (headless)
 *   shape     — node counts match the brief's expected shape           (headless)
 *   booted    — gradle-built, installed, launched, process alive       (emulator)
 *   captured  — the deterministic forward capture exists               (emulator)
 *   panelReady — OPTIONAL: the expected panel activity is caption-backed, ready, visible, and
 *                on-screen according to WindowManager                    (emulator, STRUCTURAL)
 *   eye       — the CALIBRATED JUDGE passes the stage frame — auto_judged, (emulator)
 *               NEVER vision_verified; panel-only routes leave it null/excluded
 *   perf      — OPTIONAL (tier=full + perfAxis:true): the frame-pacing axis.                     (emulator)
 *               Default source (perfSource:'gfxinfo') is measure_perf's UI/RenderThread p95 vs
 *               perfBudgetMs — scoped to what gfxinfo actually measures (Compose panels/2D
 *               activities), NOT the spatial engine's 3D frame pacing. perfSource:'pico-cli'
 *               closes that self-declared 3D blind spot when the official profiler is installed:
 *               it scores perf_diagnose's appFps LOW percentile (p5 — the 0.3.0 report has no
 *               appFps p95 field) against the budget's fps floor, falling back to gfxinfo when
 *               the CLI or appFps data is absent (appFps is 0 on this emulator — no_3d_frame,
 *               measured 2026-07-13 — so the pico-cli source proves out on real devices). Either
 *               source scores null — a SKIP, not a fail, excluded from the axis max, never
 *               zeroed — when its data is absent.
 *
 * The report says exactly which tier ran: a headless run scores /3 and never implies runtime
 * evidence. Skipped briefs (external-asset gates or explicit external implementations) are
 * reported as skipped, not as failed pipeline rows.
 */

// Emulator-tier core set: briefs whose assets are self-contained (no external splat/pano/GLB).
// Membership is FROZEN for league-table continuity — the MR tier below is additive, not a re-cut.
export const BENCH_CORE: readonly string[] = ["crystals", "boutique", "knockdown", "gallery", "console", "dashboard", "ambient", "affordance"];

// v32 MR tier (ADDITIVE): Mixed-stage (stageStyle "1") briefs, primitives-only and self-contained,
// scored alongside — never instead of — BENCH_CORE. On high-coverage passthrough frames,
// count/not-black/dominant-color checks are advisory and add zero confidence. At least two distinct
// authored colors can score through the color-key lane at its default 0.8 confidence threshold;
// otherwise MR rows escalate. A human LOOK remains the verification bar; auto_judged is weaker.
export const BENCH_MR: readonly string[] = ["mrtable", "mrpedestal", "mrknock"];

type BenchRow = {
  id: string;
  planned: 0 | 1 | null;
  compiled: 0 | 1 | null;
  shape: 0 | 1 | null;
  booted: 0 | 1 | null; // null = tier not run or skipped
  captured: 0 | 1 | null;
  panelReady: 0 | 1 | null; // structural WindowManager evidence; NEVER a substitute for eye
  eye: 0 | 1 | null;
  perf: 0 | 1 | null; // null = perf axis not requested, brief skipped, not booted, or no UI frame data
  score: number;
  max: number;
  skipped: string | null;
  expectedPanels: number;
  verificationRoute: VerificationRoute | null;
  notes: string[];
};

type PanelReadyInput = {
  expectedActivity?: string | null;
  expectedActivities?: string[] | null;
  expectedPanelCount?: number | null;
  nodeMappings?: Array<{ nodeId?: string; activity?: string; kind?: string }> | null;
  mappingMultiplicityMet?: boolean | null;
  discovery?: any;
};

/** Score the deliberately STRUCTURAL panel axis. A caption/container join can prove that the OS
 * allocated and displayed the expected panel activity, but it cannot prove the panel's pixels,
 * text, layout, or legibility. Those remain visual claims and require a capture that is LOOKED at. */
export function scorePanelReadyEvidence(input: PanelReadyInput): 0 | 1 | null {
  const mappings = Array.isArray(input.nodeMappings) ? input.nodeMappings : [];
  const expected = (input.expectedActivities?.length
    ? input.expectedActivities
    : input.expectedActivity
      ? [input.expectedActivity]
      : mappings.map((mapping) => mapping.activity ?? ""))
    .map((s) => String(s).trim())
    .filter(Boolean);
  const expectedPanelCount = input.expectedPanelCount ?? (mappings.length || expected.length);
  if (!expected.length && expectedPanelCount === 0) return null;
  if (!expected.length || input.mappingMultiplicityMet === false) return 0;
  const discovery = input.discovery;
  if (discovery?.status !== "ok" || discovery?.evidenceType !== "structural" || !Array.isArray(discovery?.panels)) return 0;

  const activityOf = (panel: any): string => {
    if (typeof panel?.activity === "string") return panel.activity;
    const name = typeof panel?.name === "string" ? panel.name : "";
    return name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  };
  const healthyPanels = discovery.panels.filter((panel: any) => {
    const activity = activityOf(panel);
    const containerId = Number(panel?.containerId);
    const captionId = Number(panel?.captionBarContainerId);
    return Boolean(activity)
      && Number.isInteger(containerId)
      && containerId > 0
      && panel?.captionBacked === true
      && captionId === containerId
      && panel?.ready === true
      && (panel?.visible === true || panel?.wmVisible === true)
      && panel?.onScreen === true;
  });
  if (healthyPanels.length < expectedPanelCount) return 0;

  const available = new Map<string, number>();
  for (const panel of healthyPanels) {
    const activity = activityOf(panel);
    available.set(activity, (available.get(activity) ?? 0) + 1);
  }
  const required = new Map<string, number>();
  const multiplicitySource = mappings.length
    ? mappings.map((mapping) => String(mapping.activity ?? "").trim()).filter(Boolean)
    : expected;
  if (mappings.length && (multiplicitySource.length !== mappings.length || mappings.length !== expectedPanelCount)) return 0;
  for (const activity of multiplicitySource) required.set(activity, (required.get(activity) ?? 0) + 1);
  for (const [activity, count] of required) {
    if ((available.get(activity) ?? 0) < count) return 0;
  }
  return expected.every((activity) => (available.get(activity) ?? 0) > 0) ? 1 : 0;
}

/** Apply one fleet result to the emulator axes. This is deliberately shared by the live tool and
 * the headless regression suite so a panel-only route cannot quietly regain a false eye failure.
 * panelReady is an extra structural axis; it never copies into eye. */
export function applyFleetRuntimeEvidence(row: BenchRow, result: any): BenchRow {
  const out: BenchRow = { ...row, notes: [...(row.notes ?? [])] };
  out.verificationRoute = result?.verificationRoute ?? row.verificationRoute ?? null;
  const panelStructuralOnly = out.verificationRoute?.mode === "panel-structural";
  out.booted = result?.built && result?.installed ? 1 : 0;
  out.captured = result?.artifact && fs.existsSync(result.artifact) ? 1 : 0;
  out.eye = panelStructuralOnly ? null : result?.verdict === "PASS" ? 1 : 0;
  out.panelReady = null;
  out.max = 5 + (panelStructuralOnly ? 0 : 1);
  out.score = (out.planned ?? 0) + (out.compiled ?? 0) + (out.shape ?? 0) + out.booted + out.captured + (out.eye ?? 0);
  out.notes.push(...(result?.notes ?? []).slice(0, 2));

  const evidence = result?.panelEvidence;
  const expectedActivities = Array.isArray(evidence?.expectedActivities) ? evidence.expectedActivities : [];
  if (out.expectedPanels > 0 || expectedActivities.length > 0) {
    out.panelReady = scorePanelReadyEvidence({
      expectedActivities,
      expectedActivity: evidence?.expectedActivity ?? null,
      expectedPanelCount: out.expectedPanels || evidence?.expectedPanelCount || expectedActivities.length,
      nodeMappings: evidence?.nodeMappings,
      mappingMultiplicityMet: evidence?.mappingMultiplicityMet,
      discovery: evidence?.discovery ?? evidence,
    }) ?? 0;
    out.max += 1;
    out.score += out.panelReady;
    out.notes.push(out.panelReady
      ? "panelReady: structural WindowManager caption/container evidence (appearance unconfirmed)"
      : "panelReady: expected panel lacks healthy one-window-per-node structural evidence");
  }
  return out;
}

/** Score a fleet transport/build exception without losing the brief's precomputed surface route.
 * Runtime failures still score zero for attempted axes, but a panel-only brief has no stage eye to
 * fail and therefore keeps eye=null/excluded. */
export function applyFleetRuntimeFailure(row: BenchRow, error: unknown): BenchRow {
  const out: BenchRow = { ...row, notes: [...(row.notes ?? [])] };
  const panelStructuralOnly = out.verificationRoute?.mode === "panel-structural";
  out.booted = 0;
  out.captured = 0;
  out.panelReady = null;
  out.eye = panelStructuralOnly ? null : 0;
  out.max = 5 + (panelStructuralOnly ? 0 : 1);
  out.score = (out.planned ?? 0) + (out.compiled ?? 0) + (out.shape ?? 0);
  if (out.expectedPanels > 0) {
    out.panelReady = 0;
    out.max += 1;
  }
  out.notes.push(`fleet error: ${error instanceof Error ? error.message : String(error)}`);
  return out;
}

export function headlessRows(briefIds?: string[]): { rows: BenchRow[]; briefsDir: string } {
  const suite = computeSuite();
  const rows: BenchRow[] = suite.rows
    .filter((r: any) => !briefIds?.length || briefIds.includes(r.id))
    .map((r: any) => {
      let entry: any = null;
      let expectedPanels = Number(r.counts?.panels ?? 0);
      try {
        entry = JSON.parse(fs.readFileSync(path.join(suite.briefsDir, `${r.id}.json`), "utf8"));
        expectedPanels = structuralPanelCount(entry.spec);
      } catch { /* malformed rows retain the scoreBrief count; planning already fails closed */ }
      if (typeof r.skipped === "string" && r.skipped) {
        return {
          id: r.id,
          planned: null,
          compiled: null,
          shape: null,
          booted: null,
          captured: null,
          panelReady: null,
          eye: null,
          perf: null,
          score: 0,
          max: 0,
          skipped: r.skipped,
          expectedPanels,
          verificationRoute: null,
          notes: [r.skipped],
        } satisfies BenchRow;
      }
      let verificationRoute: VerificationRoute | null = null;
      try {
        verificationRoute = deriveVerificationRoute(entry?.spec);
      } catch { /* malformed rows already fail planned/shape; default runtime scoring stays stage-eye */ }
      return {
        id: r.id,
        planned: r.specValid !== false && r.planOk !== false ? 1 : 0,
        compiled: (r.compileSteps ?? 0) > 0 ? 1 : 0,
        shape: r.specValid !== false && (r.shapeMismatches ?? ["invalid"]).length === 0 ? 1 : 0,
        booted: null,
        captured: null,
        panelReady: null,
        eye: null,
        perf: null,
        score: 0,
        max: 3,
        skipped: null,
        expectedPanels,
        verificationRoute,
        notes: [...(r.lintErrors ?? []), ...(r.shapeMismatches ?? [])].slice(0, 3),
      };
    });
  for (const r of rows) r.score = (r.planned ?? 0) + (r.compiled ?? 0) + (r.shape ?? 0);
  return { rows, briefsDir: suite.briefsDir };
}

export function renderBenchHtml(report: any): string {
  const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dot = (v: 0 | 1 | null) => (v === null ? '<span class="na">—</span>' : v ? '<span class="y">●</span>' : '<span class="n">○</span>');
  const aggregatePercent = report.summary.maxAggregate > 0
    ? `${Math.round((report.summary.aggregate / report.summary.maxAggregate) * 100)}%`
    : "n/a";
  const rows = report.rows
    .map((r: BenchRow) => `<tr><td>${esc(r.id)}</td><td>${dot(r.planned)}</td><td>${dot(r.compiled)}</td><td>${dot(r.shape)}</td><td>${dot(r.booted)}</td><td>${dot(r.captured)}</td><td>${dot(r.panelReady ?? null)}</td><td>${dot(r.eye)}</td><td>${dot(r.perf ?? null)}</td><td><b>${r.score}/${r.max}</b>${r.skipped ? ` <small>skipped: ${esc(r.skipped)}</small>` : ""}</td><td class="notes">${esc(r.notes.join("; "))}</td></tr>`)
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
<p><b>${report.summary.total} briefs · tier: ${esc(report.tier)} · aggregate ${report.summary.aggregate}/${report.summary.maxAggregate} (${aggregatePercent})</b> — the pico-spatial-mcp conformance corpus, scored per axis. Re-run it yourself: <code>run_spatialbench</code>.</p>
<div class="how"><b>Reading the axes:</b> planned/compiled/shape are headless (spec validity, ledger emission, expected node counts). booted/captured/eye need the PICO emulator. panelReady is structural WindowManager evidence that an expected caption-backed panel is allocated, ready, visible, and on-screen; it does NOT prove the panel's pixels or appearance and never becomes an eye pass. <b>eye = the calibrated stage-frame visual judge (auto_judged)</b> — a machine verdict, deliberately NOT vision_verified; panel-only routes show — and exclude eye from their maximum instead of false-failing an off-view panel. Escalations name only stage frames a human must look at. Skipped briefs gate on external assets (splats/panos) or explicitly declare an external implementation and are marked 0/0, not failed. <b>perf</b> (optional, tier=full with perfAxis:true) has two sources: the default <code>gfxinfo</code> measures only the app's UI/RenderThread frames, verdicting p95 against a budget in ms — structural evidence about 2D/Compose surfaces, NOT the spatial engine's 3D frame pacing; <code>perfSource:'pico-cli'</code> closes that gap via the official profiler (perf_diagnose), verdicting appFps p5 — the report's frame-time-p95 analog — against the budget's fps floor, falling back to gfxinfo when the CLI or appFps data is absent (on this emulator appFps measures 0 / no_3d_frame, so the pico-cli source proves out on real devices). Either source shows — and is not counted against the axis max when its data is absent.</div>
<table><thead><tr><th>brief</th><th>planned</th><th>compiled</th><th>shape</th><th>booted</th><th>captured</th><th>panelReady</th><th>eye</th><th>perf</th><th>score</th><th>notes</th></tr></thead>
<tbody>${rows}</tbody></table>
<footer>Generated ${esc(report.generatedAt)} by pico-spatial-mcp <code>run_spatialbench</code> · corpus: ${esc(report.briefsDir)} · escalations: ${report.summary.escalations.length ? esc(report.summary.escalations.join(", ")) : "none"}</footer>
</body></html>\n`;
}

export function registerSpatialBenchTools(server: McpServer) {
  server.tool(
    "run_spatialbench",
    "v23 SPATIALBENCH: score the conformance corpus (briefs/) as a public benchmark and emit a static league-table report (docs/spatialbench/). tier='headless' (default, CI-safe) scores planned/compiled/shape per brief from the spec+ledger alone — /3, no runtime claims. tier='full' additionally fleet-builds each brief on the emulator and scores booted/captured plus the stage eye when applicable. v32 adds the ADDITIVE MR tier (BENCH_MR: Mixed-stage briefs, reported as their own mrTier section) alongside the frozen BENCH_CORE; on high-coverage passthrough frames count/not-black/dominant-color checks are advisory with zero confidence, while at least two authored colors can score through the color-key lane at the default 0.8 threshold; other MR rows escalate. eye is the CALIBRATED JUDGE (auto_judged, never vision_verified; escalations name stage frames for a human LOOK). Briefs that declare panels gain a separate panelReady axis backed only by structural WindowManager caption/container evidence; it never becomes eye or vision proof. Panel-only routes leave eye null and exclude it from the maximum rather than false-failing an off-view panel. Asset-gated or explicitly external-implementation briefs are reported as skipped, not failed. perfAxis:true (tier='full' only) adds an optional perf axis: perfSource='gfxinfo' (default) scores measure_perf's UI/RenderThread p95 under perfBudgetMs — gfxinfo's UI surfaces only, not the spatial engine's 3D pacing; perfSource='pico-cli' closes that gap via the official profiler (perf_diagnose), scoring appFps p5 (the report's frame-time-p95 analog — it has no appFps p95 field) against the budget's fps floor, and falls back to gfxinfo with the reason in notes when the CLI or appFps data is absent (on this emulator appFps measures 0/no_3d_frame). Either source scores null (not counted, never zeroed) without data. Returns the report paths + the league table.",
    {
      tier: z.enum(["headless", "full"]).default("headless").describe("headless = spec+ledger axes only; full = also emulator boot/capture/eye per brief (slow, serial)"),
      briefIds: z.array(z.string()).optional().describe(`full tier defaults to the self-contained core set [${BENCH_CORE.join(", ")}] plus the additive MR tier [${BENCH_MR.join(", ")}]; headless defaults to every brief`),
      settleSec: z.number().min(0).max(120).default(14).describe("full tier: seconds to settle after launch before capture"),
      outDir: z.string().optional().describe("report dir (default <repo>/docs/spatialbench)"),
      perfAxis: z.boolean().default(false).describe("tier='full' only: after boot/capture/eye, sample the perfSource for the brief's package and score a 7th 'perf' axis (0/1/null)"),
      perfBudgetMs: z.number().default(16.7).describe("perfAxis frame budget in ms (default 16.7ms = 60fps-class): gfxinfo verdicts the UI/RenderThread p95 against it; pico-cli verdicts appFps p5 against its fps floor (1000/budget)"),
      perfSource: z.enum(["gfxinfo", "pico-cli"]).default("gfxinfo").describe("perfAxis source: 'gfxinfo' = measure_perf UI-frame p95 (emulator-safe default); 'pico-cli' = perf_diagnose's appFps p5 via the official profiler (real 3D pacing — the managed resolver supplies a runnable absolute path; falls back to gfxinfo, with the reason in notes, when resolution or appFps data is absent)"),
    },
    async ({ tier, briefIds, settleSec, outDir, perfAxis, perfBudgetMs, perfSource }) => {
      const emulatorIds = briefIds?.length ? briefIds : [...BENCH_CORE, ...BENCH_MR];
      // An explicit selection scopes the report itself. Without one, full tier keeps every
      // brief's headless row and adds emulator axes for the core set only.
      const { rows, briefsDir } = headlessRows(briefIds?.length ? briefIds : undefined);
      if (tier === "full") {
        for (const row of rows) {
          if (!emulatorIds.includes(row.id) || row.skipped) continue;
          try {
            const fleet = await innerCall("fleet_build", { briefIds: [row.id], settleSec });
            const r = fleet?.results?.[0] ?? {};
            const skipNote = (r.notes ?? []).find((n: string) => /skip/i.test(n));
            if (!r.built && skipNote) {
              row.skipped = skipNote.replace(/^skip\w*:\s*/i, "");
              continue; // asset-gated: axes stay null, max stays 3
            }
            Object.assign(row, applyFleetRuntimeEvidence(row, r));

            if (perfAxis) {
              if (row.booted !== 1) {
                row.notes.push("perf: skipped (app never booted, nothing to measure)");
              } else {
                // v27.5: fleet_build always installs each brief under com.fleet.<id> — reuse
                // that identity rather than re-deriving it from the (already-mutated) spec.
                const pkg = `com.fleet.${row.id}`;
                let scoredByCli = false;
                if (perfSource === "pico-cli") {
                  // v31: the official profiler's 3D pacing, called directly (module function,
                  // not innerCall). Any null — CLI missing, run failed, appFps 0/absent — falls
                  // back to the gfxinfo UI view with the reason kept in notes.
                  try {
                    const diag = await runPerfDiagnose(pkg, { durationSec: 10 });
                    const cliScore = scorePicoCliPerfAxis(diag, perfBudgetMs);
                    if (cliScore.perf === null) {
                      row.notes.push(`${cliScore.note} — falling back to the gfxinfo UI view`);
                    } else {
                      row.perf = cliScore.perf;
                      row.max += 1;
                      row.score += row.perf;
                      row.notes.push(cliScore.note);
                      scoredByCli = true;
                    }
                  } catch (e) {
                    row.notes.push(`perf(pico-cli) probe error: ${e instanceof Error ? e.message : String(e)} — falling back to the gfxinfo UI view`);
                  }
                }
                if (!scoredByCli) {
                  try {
                    const probe = await measurePerf(pkg, { sampleSec: 10 });
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
            }
          } catch (e) {
            Object.assign(row, applyFleetRuntimeFailure(row, e));
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
      const mrRows = rows.filter((r) => BENCH_MR.includes(r.id));
      return okJson({
        status: "ok",
        tier,
        htmlPath,
        jsonPath,
        summary,
        league: rows.map((r) => ({ id: r.id, score: `${r.score}/${r.max}`, skipped: r.skipped })),
        // The MR tier is ADDITIVE: BENCH_CORE membership (and its league history) is unchanged.
        mrTier: {
          briefIds: [...BENCH_MR],
          league: mrRows.map((r) => ({ id: r.id, score: `${r.score}/${r.max}`, skipped: r.skipped })),
          honesty:
            "Mixed-stage (stageStyle '1') briefs use the same axes. On high-coverage passthrough frames, count/not-black/dominant-color checks are advisory with zero confidence. At least two distinct authored colors can score via the color-key lane at the default 0.8 threshold; otherwise eye escalation means 'a human must LOOK', not 'the app failed'. auto_judged remains weaker than vision_verified.",
        },
      });
    },
  );
}
