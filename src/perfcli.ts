import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { okJson, okJsonStructured } from "./util.js";
import {
  ensurePicoCli,
  picoCliFromEnsure,
  runPicoCli,
  classifyPicoCliFailure,
  type PicoCliEnsureResult,
  type PicoCliFailureClass,
  cliWrapperContractShape,
} from "./picocli.js";

export { picoCliPath } from "./picocli.js";

/**
 * perfcli.ts — v14.8 perf_diagnose: PICO's OFFICIAL perf profiler routed through our loop.
 * (v31: CLI probing moved to the shared picocli.ts module; the diagnose core is exported so
 * SpatialBench's perfSource:'pico-cli' axis reuses it directly instead of round-tripping a tool.)
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

export type PerfDiagnoseResult = {
  status: "ok" | "unavailable" | "failed";
  failureClass?: PicoCliFailureClass;
  note?: string;
  error?: string;
  outputTail?: string;
  source?: string;
  reportPath?: string;
  metadata?: any;
  diagnosis?: any;
  summary?: any;
  jankWindowCount?: number;
  jankWindows?: any[];
  honesty?: string;
  cliProvisioning?: PicoCliEnsureResult;
  outputTruncated?: boolean;
};

/** Core diagnose, shared by the `perf_diagnose` tool and SpatialBench's perfSource:'pico-cli'
 * axis. Callers that need the numbers call this directly — never innerCall the tool. */
export async function runPerfDiagnose(
  packageName: string,
  opts: { durationSec?: number; device?: string } = {},
): Promise<PerfDiagnoseResult> {
  const ensured = await ensurePicoCli();
  const cli = picoCliFromEnsure(ensured);
  if (!cli) {
    if (ensured.action === "failed") {
      return {
        status: "unavailable",
        failureClass: ensured.failureClass,
        note: ensured.note,
        ...(ensured.outputTail ? { outputTail: ensured.outputTail } : {}),
        cliProvisioning: ensured,
      };
    }
    if (ensured.status === "unavailable" && ensured.failureClass === "cli-unusable") {
      return {
        status: "unavailable",
        failureClass: "cli-unusable",
        note: ensured.note,
      };
    }
    return {
      status: "unavailable",
      failureClass: "cli-missing",
      note: "pico-cli not found on PATH — install with `npm install -g @picoxr/pico-cli`; perf diagnosis skipped.",
    };
  }
  const provisioning = ensured.action === "present" ? {} : { cliProvisioning: ensured };
  const sec = Math.min(120, Math.max(5, Math.round(opts.durationSec ?? 15)));
  const serial = opts.device ?? "emulator-5554";
  const outDir = path.join(os.homedir(), ".pico-mcp", "perf");
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, `${packageName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  const runResult = await runPicoCli(
    cli,
    ["perf", "monitor", "run", "--app", packageName, "-d", String(sec), "--device", serial, "-o", reportPath],
    { timeoutMs: (sec + 90) * 1000 },
  );
  if (runResult.timedOut || runResult.code !== 0) {
    // Three honest failure classes: cli-missing is handled above; a usage/unknown-option dump means
    // OUR wrapped flags drifted from the installed CLI (retrying unchanged cannot help); everything
    // else is a runtime failure whose cause is in the CLI's own words — never assert "device not
    // connected" for it, that was a guess this wrapper used to present as fact.
    const stderrText = runResult.stderr;
    const stdoutText = runResult.stdout;
    const failureClass = classifyPicoCliFailure(stderrText, stdoutText);
    const tail = `${stderrText}\n${stdoutText}`.trim().split("\n").slice(-6).join("\n");
    return {
      status: "failed",
      failureClass,
      note: failureClass === "flag-or-version-drift"
        ? `pico-cli rejected the invocation (installed: ${cli.raw || "unknown"}) — the flags this wrapper passes were verified against 0.3.0 and no longer match; report outputTail upstream instead of retrying.`
        : failureClass === "not-provisioned"
          ? `the installed pico-cli (${cli.raw || "unknown"}) gates its perf utilities behind a one-time \`pico-cli setup\` (0.4.x behavior, measured 2026-08-12) — run \`pico-cli setup\` yourself and retry; this wrapper never runs setup (it mutates the machine).`
          : "pico-cli perf monitor run failed at runtime — read outputTail (the CLI's own words) before assuming a cause; a stopped app or wrong device serial are common but NOT proven by this wrapper.",
      error: runResult.spawnError ?? (runResult.timedOut
        ? `pico-cli perf monitor run timed out after ${sec + 90}s and was killed.`
        : `pico-cli perf monitor run exited with code ${runResult.code}.`),
      ...(tail ? { outputTail: tail } : {}),
      ...(runResult.outputTruncated ? { outputTruncated: true } : {}),
      ...provisioning,
    };
  }

  let report: any;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (e) {
    return {
      status: "failed",
      failureClass: "runtime",
      note: `pico-cli reported success but the report at ${reportPath} is missing/unparseable.`,
      error: e instanceof Error ? e.message : String(e),
      ...(runResult.outputTruncated ? { outputTruncated: true } : {}),
      ...provisioning,
    };
  }

  const jank = Array.isArray(report.jankWindows) ? report.jankWindows : [];
  return {
    status: "ok",
    source: "pico-cli perf monitor run (official PICO profiler + diagnosis engine)",
    reportPath,
    metadata: report.metadata ?? null,
    diagnosis: report.diagnosis ?? null,
    summary: report.summary ?? null,
    jankWindowCount: jank.length,
    jankWindows: jank.slice(0, 5),
    honesty: HONESTY,
    ...(runResult.outputTruncated ? { outputTruncated: true } : {}),
    ...provisioning,
  };
}

/**
 * Score SpatialBench's perf axis from a diagnose result. HONESTY: the pico-cli report exposes
 * appFps percentiles p5/p10/p50 — FPS LOWS, where p5 is the frame-time-p95 analog ("95% of
 * sampled seconds ran at least this fast"). There is NO appFps p95 field in the 0.3.0 report
 * (shape verified against a real report, 2026-07-13); do not invent one. appFps avg 0/absent
 * means the profiler saw no app 3D frames (diagnosis "no_3d_frame" — the measured emulator
 * behavior) -> null, a SKIP that must never be counted against the axis max, never a 0.
 */
export function scorePicoCliPerfAxis(
  result: Pick<PerfDiagnoseResult, "status" | "summary"> | null | undefined,
  budgetMs: number,
): { perf: 0 | 1 | null; note: string } {
  if (!result || result.status !== "ok") {
    return { perf: null, note: `perf(pico-cli): source ${result?.status ?? "absent"} — not measured` };
  }
  const app = result.summary?.appFps;
  const p5 = typeof app?.p5 === "number" ? app.p5 : null;
  const avg = typeof app?.avg === "number" ? app.avg : null;
  if (p5 === null || avg === null || avg === 0) {
    return { perf: null, note: "perf(pico-cli): profiler reports no app 3D frames (appFps 0/absent — the emulator's no_3d_frame case) — not measured, not a fail" };
  }
  const floorFps = 1000 / budgetMs;
  const perf: 0 | 1 = p5 >= floorFps ? 1 : 0;
  return { perf, note: `perf(pico-cli): appFps p5=${p5} vs floor ${floorFps.toFixed(1)}fps (${budgetMs}ms budget) -> ${perf ? "meets" : "misses"} budget` };
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
        "Uses @picoxr/pico-cli from PATH. If it is missing, default behavior remains status:'unavailable'; set " +
        "PICO_MCP_AUTOINSTALL_CLI=1 or call ensure_pico_cli for a lazy bounded install and same-call retry. Failures carry an " +
        "honest failureClass for provisioning, cli-missing, cli-unusable, flag-or-version-drift (the CLI rejected our flags), or runtime (read the CLI's " +
        "outputTail — the cause is not guessed for you). The full report is saved to reportPath for deep dives. " +
        "HONESTY: " + HONESTY,
      // Typed contract (2026-07-28 revision lane): the shared CLI-wrapper core + the report fields.
      outputSchema: z.object({
        status: z.enum(["ok", "failed", "unavailable"]).describe("ok = a report was produced and parsed; failed = the run or report failed (see failureClass/outputTail); unavailable = pico-cli absent/unusable."),
        ...cliWrapperContractShape,
        source: z.string().optional(),
        reportPath: z.string().optional().describe("The full pico-cli report JSON, persisted for deep dives."),
        metadata: z.unknown().optional(),
        diagnosis: z.unknown().optional().describe("pico-cli's OWN rule-engine verdict, verbatim (rule + evidence)."),
        summary: z.unknown().optional().describe("pico-cli's summary: appFps percentiles p5/p10/p50 (FPS LOWS — there is no p95), CPU/GPU counters. appFps 0/absent = the emulator's no_3d_frame case: not measured, never 'GPU idle'."),
        jankWindowCount: z.number().optional(),
        jankWindows: z.array(z.unknown()).optional().describe("Top jank windows (at most 5)."),
      }).passthrough(),
      inputSchema: {
        packageName: z.string().describe("Target app package (must be running), e.g. com.example.knockdownxr"),
        durationSec: z.number().min(5).max(120).optional().describe("Sampling window in seconds (default 15)."),
        device: z.string().optional().describe("Device serial (default emulator-5554)."),
      },
    },
    async ({ packageName, durationSec, device }) => okJsonStructured(await runPerfDiagnose(packageName, { durationSec, device }) as unknown as Record<string, unknown>),
  );
}
