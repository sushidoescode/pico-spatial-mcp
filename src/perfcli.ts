import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";

const run = promisify(execFile);

/**
 * perfcli.ts — v14.8 perf_diagnose: PICO's OFFICIAL perf profiler routed through our loop.
 *
 * Wraps `pico-cli perf monitor run` (the PICO Spatial Performance Profiler: per-second sampling,
 * app/system FPS percentiles, CPU/GPU counters, jank windows, and a DIAGNOSIS engine that
 * attributes the bottleneck — e.g. category "no_3d_frame" with the rule and evidence it fired on).
 * This deliberately builds ON the official toolchain instead of rebuilding it; our own
 * measure_perf (gfxinfo UI-frame probe) stays as the complementary 2D-surface view.
 *
 * HONESTY (load-bearing): all numbers are real measurements from pico-cli; anything the device
 * does not report arrives as 0/absent — on the EMULATOR the GPU counters are typically
 * unparseable (verified 2026-07-12), so gpu* zeros mean "not measured", never "GPU idle". The
 * diagnosis is pico-cli's own rule engine, quoted verbatim with its rule + evidence. Evidence
 * class: structural — perf numbers are NOT a substitute for LOOKING at captured frames.
 */

const HONESTY =
  "All metrics are real pico-cli measurements; absent counters arrive as 0/absent — on the emulator " +
  "GPU counters are typically unparseable, so gpu* zeros mean 'not measured', never 'GPU idle'. The " +
  "diagnosis block is pico-cli's own rule engine quoted verbatim (rule + evidence included). " +
  "Evidence class: structural — not a substitute for LOOKING at a capture.";

async function picoCliPath(): Promise<string | null> {
  try {
    const { stdout } = await run("which", ["pico-cli"]);
    const p = stdout.trim();
    return p.length ? p : null;
  } catch {
    return null;
  }
}

export function registerPerfCliTools(server: McpServer) {
  server.registerTool(
    "perf_diagnose",
    {
      description:
        "Run PICO's OFFICIAL performance profiler (`pico-cli perf monitor run`) against a running app for a fixed window " +
        "and return its JSON report: app/system FPS percentiles, CPU/GPU usage, jank windows, and pico-cli's DIAGNOSIS " +
        "(bottleneck category + rule + evidence — e.g. no_3d_frame, app-bound, compositor-bound). Prefer this over " +
        "measure_perf for engine/3D-pipeline analysis; keep measure_perf for the 2D UI-frame (gfxinfo) view. " +
        "Requires @picoxr/pico-cli on PATH (degrades to status:'unavailable' with the install hint). The full report is " +
        "saved to reportPath for deep dives. HONESTY: " + HONESTY,
      inputSchema: {
        packageName: z.string().describe("Target app package (must be running), e.g. com.example.knockdownxr"),
        durationSec: z.number().min(5).max(120).optional().describe("Sampling window in seconds (default 15)."),
        device: z.string().optional().describe("Device serial (default emulator-5554)."),
      },
    },
    async ({ packageName, durationSec, device }) => {
      const cli = await picoCliPath();
      if (!cli) {
        return okJson({
          status: "unavailable",
          note: "pico-cli not found on PATH — install with `npm install -g @picoxr/pico-cli` (and run `pico-cli perf doctor` once); perf diagnosis skipped.",
        });
      }
      const sec = Math.min(120, Math.max(5, Math.round(durationSec ?? 15)));
      const serial = device ?? "emulator-5554";
      const outDir = path.join(os.homedir(), ".pico-mcp", "perf");
      fs.mkdirSync(outDir, { recursive: true });
      const reportPath = path.join(outDir, `${packageName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

      try {
        await run(cli, ["perf", "monitor", "run", "--app", packageName, "-d", String(sec), "--device", serial, "-o", reportPath], {
          timeout: (sec + 90) * 1000,
        });
      } catch (e: any) {
        const tail = `${e?.stderr ?? ""}\n${e?.stdout ?? ""}`.trim().split("\n").slice(-6).join("\n");
        return okJson({
          status: "failed",
          note: "pico-cli perf monitor run failed — is the device connected and the app running?",
          error: e instanceof Error ? e.message : String(e),
          ...(tail ? { outputTail: tail } : {}),
        });
      }

      let report: any;
      try {
        report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      } catch (e) {
        return okJson({
          status: "failed",
          note: `pico-cli reported success but the report at ${reportPath} is missing/unparseable.`,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      const jank = Array.isArray(report.jankWindows) ? report.jankWindows : [];
      return okJson({
        status: "ok",
        source: "pico-cli perf monitor run (official PICO profiler + diagnosis engine)",
        reportPath,
        metadata: report.metadata ?? null,
        diagnosis: report.diagnosis ?? null,
        summary: report.summary ?? null,
        jankWindowCount: jank.length,
        jankWindows: jank.slice(0, 5),
        honesty: HONESTY,
      });
    },
  );
}
