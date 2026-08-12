import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { okJson } from "./util.js";
import { ensurePicoCli, picoCliFromEnsure, runPicoCli, classifyPicoCliFailure } from "./picocli.js";

/**
 * perftrace.ts — v31 perf_trace: PICO's Perfetto trace pipeline routed through our loop.
 *
 * Wraps `pico-cli perf trace` record / decode / load / query — the official path to the spatial
 * engine's REAL 3D frame pacing, the blind spot gfxinfo/measure_perf declares it cannot see.
 * Flag surface verified verbatim against pico-cli 0.3.0 `--help` (2026-08-01): record (-a app,
 * -t duration, -o output, -d device), decode (trace-file, -f json|systrace|ctrace, -o output),
 * load (trace-file, returns a sessionId for trace_processor_shell), query (--session, --sql).
 * `--live` (Ctrl+C-terminated streaming) is deliberately NOT wrapped — every action is bounded.
 *
 * HONESTY (load-bearing): outputs are pico-cli's own, quoted verbatim (outputTail) plus artifact
 * paths whose existence is stat-checked, never asserted. sessionId parsing is best-effort with
 * the raw output alongside. Absent CLI degrades to status:'unavailable' — null/absent, never
 * fabricated. Caveats: `decode` may auto-download traceconv on first use (network); `load`/`query`
 * need the CLI's own perf daemon + trace_processor_shell. The wrapper is FLAG-verified against
 * 0.3.0; an end-to-end record on this emulator is not yet ledgered. Evidence class: structural —
 * traces are numbers, not looks.
 */

const HONESTY =
  "Everything returned is pico-cli's own output (verbatim tail) plus stat-checked artifact paths; " +
  "sessionId parsing is best-effort with the raw output included. The flag surface was verified " +
  "against pico-cli 0.3.0 --help (2026-08-01); an end-to-end record on this emulator is not yet " +
  "ledgered. Evidence class: structural — trace numbers are not a substitute for LOOKING at frames.";

/** Best-effort sessionId extraction from `perf trace load` output: prefer a JSON body carrying a
 * sessionId field (whole-output, then per-line), fall back to a labeled token. NOT runtime-verified
 * against 0.3.0 (needs a recorded trace + the perf daemon) — the raw output always rides along. */
export function parseTraceSessionId(stdout: string): string | null {
  const fromJson = (text: string): string | null => {
    try {
      const parsed = JSON.parse(text);
      const id = parsed?.sessionId ?? parsed?.session_id ?? parsed?.data?.sessionId;
      return typeof id === "string" || typeof id === "number" ? String(id) : null;
    } catch {
      return null;
    }
  };
  const whole = fromJson(stdout.trim());
  if (whole) return whole;
  for (const line of stdout.trim().split("\n")) {
    const perLine = fromJson(line.trim());
    if (perLine) return perLine;
  }
  const m = stdout.match(/session[_ ]?id["'\s:=]+([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

export function registerPerfTraceTools(server: McpServer) {
  server.registerTool(
    "perf_trace",
    {
      description:
        "Drive PICO's OFFICIAL Perfetto trace pipeline (`pico-cli perf trace`) — the real 3D frame-pacing evidence that " +
        "gfxinfo/measure_perf cannot see. action='record' traces the device for durationSec (bounded — the CLI's " +
        "Ctrl+C --live mode is not wrapped) and returns the .perfetto-trace path; 'decode' converts a trace to " +
        "json/systrace/ctrace (may auto-download traceconv on first use); 'load' starts a trace_processor session and " +
        "returns its sessionId (best-effort parse, raw output included); 'query' runs SQL against a loaded session. " +
        "Uses @picoxr/pico-cli from PATH. Missing defaults to status:'unavailable'; PICO_MCP_AUTOINSTALL_CLI=1 or " +
        "ensure_pico_cli enables a lazy bounded install and same-call retry. Failures carry an honest provisioning, " +
        "cli-missing, cli-unusable, flag-or-version-drift, or runtime failureClass with the CLI's own outputTail. " +
        "HONESTY: " + HONESTY,
      inputSchema: {
        action: z.enum(["record", "decode", "load", "query"]).describe("record = capture a .perfetto-trace from the device; decode = convert it; load = open a SQL session on it; query = run SQL in that session."),
        packageName: z.string().optional().describe("record: target app package (-a). Optional — omitting it records a whole-device trace."),
        durationSec: z.number().min(5).max(300).optional().describe("record: seconds to trace (default 15; the CLI's own default is 60 — shorter suits the loop)."),
        tracePath: z.string().optional().describe("decode/load: path to a .perfetto-trace file (required for those actions — pass the record result's artifact)."),
        sessionId: z.string().optional().describe("query: session id returned by a prior load."),
        sql: z.string().optional().describe("query: SQL for trace_processor, e.g. \"select name, dur from slice order by dur desc limit 20\"."),
        format: z.enum(["json", "systrace", "ctrace"]).optional().describe("decode: output format (default json)."),
        device: z.string().optional().describe("record: device serial (default emulator-5554)."),
        outputPath: z.string().optional().describe("record/decode: output file path (default under ~/.pico-mcp/perf/)."),
      },
    },
    async ({ action, packageName, durationSec, tracePath, sessionId, sql, format, device, outputPath }) => {
      const outDir = path.join(os.homedir(), ".pico-mcp", "perf");

      let args: string[];
      let timeoutMs = 120_000;
      let artifact: string | null = null;
      if (action === "record") {
        const sec = Math.min(300, Math.max(5, Math.round(durationSec ?? 15)));
        artifact = outputPath ?? path.join(outDir, `trace-${new Date().toISOString().replace(/[:.]/g, "-")}.perfetto-trace`);
        args = ["perf", "trace", "record", "-t", String(sec), "-o", artifact, "-d", device ?? "emulator-5554"];
        if (packageName) args.push("-a", packageName);
        timeoutMs = (sec + 90) * 1000;
      } else if (action === "decode") {
        if (!tracePath) return okJson({ status: "failed", note: "decode needs tracePath (a .perfetto-trace file from record)." });
        artifact = outputPath ?? `${tracePath}.${format ?? "json"}`;
        args = ["perf", "trace", "decode", tracePath, "-f", format ?? "json", "-o", artifact];
        timeoutMs = 300_000; // traceconv may auto-download on first use
      } else if (action === "load") {
        if (!tracePath) return okJson({ status: "failed", note: "load needs tracePath (a .perfetto-trace file from record)." });
        args = ["perf", "trace", "load", tracePath];
        timeoutMs = 180_000; // starts trace_processor_shell via the CLI's daemon
      } else {
        if (!sessionId || !sql) return okJson({ status: "failed", note: "query needs sessionId (from load) and sql." });
        args = ["perf", "trace", "query", "--session", sessionId, "--sql", sql];
      }

      const ensured = await ensurePicoCli();
      const cli = picoCliFromEnsure(ensured);
      if (!cli) {
        if (ensured.action === "failed") {
          return okJson({
            status: "unavailable",
            failureClass: ensured.failureClass,
            note: ensured.note,
            ...(ensured.outputTail ? { outputTail: ensured.outputTail } : {}),
            cliProvisioning: ensured,
          });
        }
        const unavailable = ensured.status === "unavailable" ? ensured : null;
        return okJson({
          status: "unavailable",
          failureClass: unavailable?.failureClass ?? "cli-missing",
          note: unavailable?.failureClass === "cli-missing"
            ? "pico-cli not found on PATH — install with `npm install -g @picoxr/pico-cli`; perf tracing skipped."
            : unavailable?.note ?? "pico-cli did not become usable.",
        });
      }
      const provisioning = ensured.action === "present" ? {} : { cliProvisioning: ensured };
      fs.mkdirSync(outDir, { recursive: true });

      const runResult = await runPicoCli(cli, args, { timeoutMs, maxOutputBytes: 32 * 1024 * 1024 });
      const stdout = runResult.stdout;
      const stderr = runResult.stderr;
      if (runResult.timedOut || runResult.code !== 0) {
        const stderrText = stderr;
        const stdoutText = stdout;
        const failureClass = classifyPicoCliFailure(stderrText, stdoutText);
        const failTail = `${stderrText}\n${stdoutText}`.trim().split("\n").slice(-8).join("\n");
        return okJson({
          status: "failed",
          failureClass,
          note: failureClass === "flag-or-version-drift"
              ? `pico-cli rejected the invocation (installed: ${cli.raw || "unknown"}) — its trace surface drifted from the 0.3.0 flags this wrapper was verified against; report outputTail upstream instead of retrying.`
              : "pico-cli perf trace failed at runtime — read outputTail (the CLI's own words) before assuming a cause.",
          command: ["pico-cli", ...args].join(" "),
          error: runResult.spawnError ?? (runResult.timedOut
            ? `pico-cli perf trace exceeded ${timeoutMs}ms and was killed.`
            : `pico-cli perf trace exited with code ${runResult.code}.`),
          ...(failTail ? { outputTail: failTail } : {}),
          ...(runResult.outputTruncated ? { outputTruncated: true } : {}),
          ...provisioning,
        });
      }

      const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-12).join("\n");
      const out: Record<string, unknown> = {
        status: "ok",
        action,
        command: ["pico-cli", ...args].join(" "),
        ...(tail ? { outputTail: tail } : {}),
        ...(runResult.outputTruncated ? { outputTruncated: true } : {}),
        honesty: HONESTY,
        ...provisioning,
      };
      if (artifact) {
        // Exit 0 is not evidence the artifact exists — stat it and say which.
        const exists = fs.existsSync(artifact);
        out.artifact = artifact;
        out.artifactExists = exists;
        out.artifactBytes = exists ? fs.statSync(artifact).size : null;
        if (!exists) {
          out.status = "failed";
          out.note = `pico-cli exited 0 but the expected output file is missing at ${artifact} — treat as failed.`;
        }
      }
      if (action === "load") {
        const parsed = parseTraceSessionId(stdout);
        out.sessionId = parsed;
        if (parsed === null) out.note = "sessionId not found in pico-cli output — parsing is best-effort; read outputTail for the real value.";
      }
      if (action === "query") {
        try {
          out.rows = JSON.parse(stdout);
        } catch {
          out.rows = null;
          out.note = "query output was not JSON — the raw text is in outputTail.";
        }
      }
      return okJson(out);
    },
  );
}
