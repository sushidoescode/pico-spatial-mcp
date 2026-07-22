import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson, sleep } from "./util.js";

const run = promisify(execFile);
const ADB = process.env.PICO_ADB ?? path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb");
const SERIAL = "emulator-5554";

/**
 * perfprobe.ts — a smoothness/performance probe for AAA claims.
 *
 * Samples `dumpsys gfxinfo <pkg>` frame statistics over a window (optionally resetting first) plus
 * `dumpsys meminfo <pkg>` PSS, and renders a frame-time verdict. Parsing is strict: any field the
 * emulator does not report comes back null — never fabricated.
 *
 * HONESTY (load-bearing): gfxinfo covers the app's UI/RenderThread frames (Compose panels,
 * WebViews, 2D activities). The immersive Filament/OpenXR scene path may NOT be measured by
 * gfxinfo on this emulator — if frame data is absent or tiny while the app runs, that means
 * exactly that: only the measured UI surfaces are reported; never extrapolate to the 3D scene.
 * Evidence class: structural. This is NOT a substitute for LOOKING at captured frames.
 */

const HONESTY =
  "gfxinfo covers the app's UI/RenderThread frames (Compose panels, WebViews, 2D activities). " +
  "The immersive Filament/OpenXR scene path may NOT be measured by gfxinfo on this emulator — " +
  "if frame data is absent or tiny while the app runs, that means exactly that: only the measured " +
  "UI surfaces are reported; do not extrapolate this verdict to the 3D scene. " +
  "Evidence class: structural — not a substitute for LOOKING at a capture.";

function matchNum(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Parse total PSS (KB) from dumpsys meminfo output -> MB, or null if absent. */
function parseTotalPssMb(text: string): number | null {
  // Newer format: "TOTAL PSS:   123456            TOTAL RSS: ...".
  let kb = matchNum(text, /TOTAL PSS:\s*(\d+)/);
  if (kb === null) {
    // Older format: a summary row "      TOTAL   123456   ..." in the App Summary table.
    kb = matchNum(text, /^\s*TOTAL\s+(\d+)/m);
  }
  return kb === null ? null : Math.round((kb / 1024) * 10) / 10;
}

export type PerfProbeResult = {
  status: "ok" | "partial";
  packageName: string;
  sampleSec: number;
  totalFrames: number | null;
  jankyFrames: number | null;
  jankyPct: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  totalPssMb: number | null;
  verdict: string;
  honesty: string;
  errors?: string[];
};

/**
 * Core probe, shared by the `measure_perf` tool and SpatialBench's optional perf axis: reset +
 * sample `dumpsys gfxinfo <pkg>` frame stats and `dumpsys meminfo` PSS on the emulator. Do not
 * duplicate this parsing elsewhere — callers that need the numbers should call this directly.
 */
export async function measurePerf(
  packageName: string,
  opts: { resetFirst?: boolean; sampleSec?: number } = {},
): Promise<PerfProbeResult> {
  const sec = Math.min(60, Math.max(1, Math.round(opts.sampleSec ?? 10)));
  const errors: string[] = [];

  if (opts.resetFirst ?? true) {
    try {
      await run(ADB, ["-s", SERIAL, "shell", "dumpsys", "gfxinfo", packageName, "reset"]);
    } catch (e) {
      errors.push(`gfxinfo reset failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await sleep(sec * 1000);

  let gfx = "";
  try {
    gfx = (await run(ADB, ["-s", SERIAL, "shell", "dumpsys", "gfxinfo", packageName])).stdout;
  } catch (e) {
    errors.push(`gfxinfo read failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const totalFrames = matchNum(gfx, /Total frames rendered:\s*(\d+)/);
  const jankyFrames = matchNum(gfx, /Janky frames:\s*(\d+)\s*\(/);
  const jankyPct = matchNum(gfx, /Janky frames:\s*\d+\s*\(([\d.]+)%\)/);
  const p50 = matchNum(gfx, /50th percentile:\s*([\d.]+)ms/);
  const p90 = matchNum(gfx, /90th percentile:\s*([\d.]+)ms/);
  const p95 = matchNum(gfx, /95th percentile:\s*([\d.]+)ms/);
  const p99 = matchNum(gfx, /99th percentile:\s*([\d.]+)ms/);

  let totalPssMb: number | null = null;
  try {
    const mem = (await run(ADB, ["-s", SERIAL, "shell", "dumpsys", "meminfo", packageName])).stdout;
    totalPssMb = parseTotalPssMb(mem);
  } catch (e) {
    errors.push(`meminfo read failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let verdict: string;
  if (totalFrames === null || totalFrames === 0 || p90 === null || jankyPct === null) {
    verdict = "no-frame-data";
  } else if (p90 <= 16.7 && jankyPct < 10) {
    verdict = "smooth (60fps-class UI frames)";
  } else if (p90 <= 33.4) {
    verdict = "acceptable (30fps-class)";
  } else {
    verdict = "janky";
  }

  return {
    status: errors.length === 0 ? "ok" : "partial",
    packageName,
    sampleSec: sec,
    totalFrames,
    jankyFrames,
    jankyPct,
    p50,
    p90,
    p95,
    p99,
    totalPssMb,
    verdict,
    honesty: HONESTY,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * Score the optional SpatialBench perf axis from a probe result: 1 = parsed UI frame data with
 * p95 at or under budget, 0 = parsed data but over budget, null = no UI frame data at all (the
 * documented emulator honesty case — e.g. a spatial-only app has ~no gfxinfo frames; that is a
 * SKIP, not a fail, and must not be counted against the axis max).
 */
export function scorePerfAxis(probe: Pick<PerfProbeResult, "verdict" | "p95"> | null | undefined, budgetMs: number): 0 | 1 | null {
  if (!probe || probe.verdict === "no-frame-data" || probe.p95 === null || probe.p95 === undefined) return null;
  return probe.p95 <= budgetMs ? 1 : 0;
}

export function registerPerfProbeTools(server: McpServer) {
  server.registerTool(
    "measure_perf",
    {
      description:
        "Performance/smoothness probe for AAA claims: reset + sample `dumpsys gfxinfo <pkg>` frame stats " +
        "(total/janky frames, 50/90/95/99th percentile frame times) and `dumpsys meminfo` PSS on the emulator, " +
        "then verdict: p90<=16.7ms & janky<10% -> smooth (60fps-class), p90<=33.4ms -> acceptable (30fps-class), " +
        "else janky; no stats -> no-frame-data. Missing fields are null, never fabricated. " +
        "HONESTY: " + HONESTY,
      inputSchema: {
        packageName: z.string().describe("App package to probe, e.g. com.example.showroomxr"),
        resetFirst: z.boolean().optional().describe("Reset gfxinfo stats before sampling (default true) so numbers cover only the sample window."),
        sampleSec: z.number().min(1).max(60).optional().describe("Seconds to sample before reading stats (default 10, max 60)."),
      },
    },
    async ({ packageName, resetFirst, sampleSec }) => okJson(await measurePerf(packageName, { resetFirst, sampleSec })),
  );
}
