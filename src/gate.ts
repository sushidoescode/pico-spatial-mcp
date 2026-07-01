import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, run } from "./util.js";
import { computeSuite } from "./eval.js";

/**
 * gate.ts — v5.5 REGRESSION GATE + reproducibility lockdown: block ship on any regression, make diffs meaningful.
 *
 * Two comparisons against committed goldens:
 *   1) SCORECARD (deterministic, primary, BLOCKS) — re-run the brief suite and compare to
 *      briefs/golden-scorecard.json. Any brief that regressed pass→fail, or a lower score, BLOCKS the merge.
 *      Fully headless + reproducible (plan+compile are byte-stable — proven by the v5.0 determinism gate;
 *      the generators are analytical with no RNG, so nothing to seed).
 *   2) GOLDEN FRAMES (emulator-gated, secondary, LOOK) — downscaled ImageMagick MAE between a committed
 *      golden PNG and a fresh capture. MAE is an ASSIST: ~0 = IDENTICAL (pass), nonzero = CHANGED → hand the
 *      pair back to be LOOKED at (vision is the verdict; MAE under-weights small objects; full-frame compare
 *      on 2160² TIMES OUT → we downscale first). C2: the free cam drifts, so a golden frame is only
 *      meaningful from a canonical pose — the reproducibility lock is a golden AVD snapshot (snapshot_load
 *      the pinned state before capturing), recorded in repro.lock.json.
 */

const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// goldens live OUTSIDE briefs/ so the suite never picks the scorecard up as a (broken) brief.
const goldenScorecardPath = () => path.join(repoRoot(), "golden", "scorecard.json");
const reproLockPath = () => path.join(repoRoot(), "repro.lock.json");

async function maeCompare(golden: string, fresh: string): Promise<{ ok: boolean; mae: number | null; note: string }> {
  if (!fs.existsSync(golden) || !fs.existsSync(fresh)) return { ok: false, mae: null, note: "missing golden or fresh image" };
  const g = "/tmp/pico-gate-g.png";
  const f = "/tmp/pico-gate-f.png";
  await run("magick", [golden, "-resize", "800x800!", g]);
  await run("magick", [fresh, "-resize", "800x800!", f]);
  const cmp = await run("magick", ["compare", "-metric", "MAE", g, f, "null:"]);
  const out = (cmp.stderr || cmp.stdout).trim();
  const m = /\(([0-9.eE+-]+)\)/.exec(out);
  const mae = m ? Number(m[1]) : null;
  return { ok: true, mae, note: out };
}

export function registerGateTools(server: McpServer) {
  server.registerTool(
    "regression_gate",
    {
      description:
        "Block ship on any regression against committed goldens. mode='save' recomputes the brief-suite scorecard and writes briefs/golden-scorecard.json + repro.lock.json (SDK pin + canonical pose + golden AVD snapshot name). mode='check' re-runs the suite and BLOCKS if any brief regressed pass→fail or the score dropped (deterministic, headless), and — if you pass frame pairs — runs a downscaled MAE compare of each committed golden PNG vs a fresh capture (MAE is an assist: nonzero = CHANGED → LOOK at the pair; vision is the verdict). Overall verdict PASS / LOOK / BLOCK.",
      inputSchema: {
        mode: z.enum(["save", "check"]).describe("save = write goldens; check = compare + gate."),
        briefsDir: z.string().optional().describe("Briefs dir (default the repo's briefs/)."),
        canonicalPose: z.object({ yawDeg: z.number(), pitchDeg: z.number() }).optional().describe("The canonical free-cam pose goldens were captured at (recorded in repro.lock)."),
        goldenAvdSnapshot: z.string().optional().describe("Named AVD snapshot to snapshot_load before capturing goldens (the true reproducibility lock)."),
        frames: z
          .array(z.object({ name: z.string(), golden: z.string().describe("committed golden PNG path"), fresh: z.string().describe("fresh capture PNG path to compare") }))
          .optional()
          .describe("Golden-frame pairs to MAE-compare (emulator-gated; capture the fresh frames at the canonical pose first)."),
        identicalEps: z.number().optional().describe("MAE below this = IDENTICAL (default 0.002)."),
      },
    },
    async ({ mode, briefsDir, canonicalPose, goldenAvdSnapshot, frames, identicalEps }) => {
      const suite = computeSuite(briefsDir);
      if (suite.status !== "ok") return okJson({ status: "error", error: suite.error });

      if (mode === "save") {
        fs.mkdirSync(path.dirname(goldenScorecardPath()), { recursive: true });
        fs.writeFileSync(goldenScorecardPath(), JSON.stringify({ scorecard: suite.scorecard, rows: suite.rows.map((r: any) => ({ id: r.id, pass: r.pass })) }, null, 2));
        const lock = {
          sdkVersion: "0.13.3",
          determinism: "generators are analytical (no RNG); plan+compile are byte-reproducible (v5.0 determinism gate).",
          canonicalPose: canonicalPose ?? { yawDeg: 0, pitchDeg: 0 },
          goldenAvdSnapshot: goldenAvdSnapshot ?? null,
          note: "Restore goldenAvdSnapshot (snapshot_load) + set canonicalPose (emulator_look) before capturing golden frames — the free cam drifts (C2), so goldens are only meaningful from a locked pose/state.",
        };
        fs.writeFileSync(reproLockPath(), JSON.stringify(lock, null, 2));
        return okJson({ status: "saved", goldenScorecard: goldenScorecardPath(), reproLock: reproLockPath(), scorecard: suite.scorecard });
      }

      // mode === "check"
      let golden: any = null;
      try {
        golden = JSON.parse(fs.readFileSync(goldenScorecardPath(), "utf8"));
      } catch {
        return okJson({ status: "error", error: `no golden scorecard at ${goldenScorecardPath()} — run mode='save' first.` });
      }
      const goldenPass = new Set(golden.rows.filter((r: any) => r.pass).map((r: any) => r.id));
      const nowPass = new Set(suite.rows.filter((r: any) => r.pass).map((r: any) => r.id));
      const regressed = [...goldenPass].filter((id) => !nowPass.has(id));
      const scoreDrop = suite.scorecard.score < golden.scorecard.score;

      // optional golden-frame MAE compare
      const eps = identicalEps ?? 0.002;
      const frameResults: any[] = [];
      for (const fr of frames ?? []) {
        const r = await maeCompare(fr.golden, fr.fresh);
        const verdict = !r.ok ? "MISSING" : r.mae == null ? "UNKNOWN" : r.mae <= eps ? "IDENTICAL" : "CHANGED";
        frameResults.push({ name: fr.name, mae: r.mae, verdict, detail: r.note });
      }
      const anyChanged = frameResults.some((f) => f.verdict === "CHANGED");

      const blocked = regressed.length > 0 || scoreDrop;
      const verdict = blocked ? "BLOCK" : anyChanged ? "LOOK" : "PASS";
      return okJson({
        status: "ok",
        verdict,
        blocked,
        scorecard: { golden: golden.scorecard.score, current: suite.scorecard.score, regressedBriefs: regressed, scoreDrop },
        frames: frameResults,
        note:
          verdict === "BLOCK"
            ? `REGRESSION — do not merge. Briefs regressed: [${regressed.join(", ")}]${scoreDrop ? "; score dropped" : ""}.`
            : verdict === "LOOK"
              ? "Scorecard clean, but a golden frame CHANGED — LOOK at the pair(s) and decide (MAE is only an assist)."
              : "No regression: scorecard matches golden and frames are identical.",
      });
    },
  );
}
