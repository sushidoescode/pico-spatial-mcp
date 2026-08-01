import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { okJson, run, tail } from "./util.js";
import { probePicoCli, classifyPicoCliFailure } from "./picocli.js";

/**
 * picoclitools.ts — v31: thin evidence primitives over the official pico-cli.
 *
 * watch_crash wraps `pico-cli app watch-crash <pkg>` — PICO's own crash monitor (PID-change
 * polling + surfaced exception logs) instead of our ad-hoc logcat grepping. Verified against
 * 0.3.0 --help (2026-08-01): it has NO duration flag and streams until killed, so this wrapper
 * bounds it by killing the child after durationSec and says so honestly.
 *
 * capture_record wraps `pico-cli capture record` — the official screen recorder (1-180s, pulls
 * the file locally). It gives the ledger a recording evidence lane and the demo a video fallback.
 *
 * HONESTY (load-bearing): output is the CLI's verbatim text; crash detection is a best-effort
 * keyword scan over that text, never a verdict — read outputTail before claiming a crash or its
 * absence. A recording artifact is stat-checked, and its pixels prove nothing until LOOKED at:
 * on immersive content the recorded display surface may not show the in-headset view (the v30.1
 * screencap lesson — adb screencap-class paths proved black for immersive Unity on device).
 */

const WATCH_HONESTY =
  "The watch window is bounded by THIS wrapper killing the child (pico-cli 0.3.0 has no duration " +
  "flag and streams indefinitely). crashIndicated is a best-effort keyword scan over the CLI's " +
  "verbatim output — read outputTail before claiming a crash or its absence; a quiet window is " +
  "evidence of no DETECTED crash during the window, nothing more. Evidence class: structural.";

const RECORD_HONESTY =
  "The artifact is a real recording pulled by the official CLI and stat-checked here — but its " +
  "pixels prove nothing until LOOKED at: on immersive content the recorded display surface may " +
  "not show the in-headset view (the v30.1 screencap lesson). Evidence class: a capture artifact " +
  "that still requires a LOOK before any visual claim.";

/** Best-effort crash-marker scan over watch-crash output. Named indicators, not a verdict. */
export function scanForCrashIndicators(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["fatal-exception", /FATAL EXCEPTION/i],
    ["crash-buffer", /beginning of crash/i],
    ["process-died", /Process .+ (died|has died)/i],
    ["anr", /ANR in /i],
    ["native-crash", /Fatal signal|\*\*\* \*\*\*/i],
  ];
  return patterns.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export function registerPicoCliTools(server: McpServer) {
  server.registerTool(
    "watch_crash",
    {
      description:
        "Monitor a package for crashes with PICO's OFFICIAL crash watcher (`pico-cli app watch-crash <pkg>`: PID-change " +
        "polling + surfaced exception logs) for a bounded window. The 0.3.0 CLI has NO duration flag and streams until " +
        "killed, so this wrapper kills the watcher after durationSec — a timed-out child is the EXPECTED healthy end of " +
        "the window, reported as endedBy:'duration-cap'. Optionally starts the app first (--start/--activity). Requires " +
        "@picoxr/pico-cli on PATH (degrades to status:'unavailable'). HONESTY: " + WATCH_HONESTY,
      inputSchema: {
        packageName: z.string().describe("Package to watch, e.g. com.example.knockdownxr"),
        durationSec: z.number().min(5).max(300).optional().describe("Watch window in seconds (default 30) — this wrapper kills the watcher when it elapses."),
        device: z.string().optional().describe("Device serial (default emulator-5554)."),
        start: z.boolean().optional().describe("Pass --start so pico-cli launches the app before watching (default false)."),
        activity: z.string().optional().describe("Optional activity for --start, e.g. .MainActivity"),
        intervalSec: z.number().min(1).max(30).optional().describe("PID-poll interval seconds (CLI default 2)."),
      },
    },
    async ({ packageName, durationSec, device, start, activity, intervalSec }) => {
      const cli = probePicoCli();
      if (cli.status !== "ok") {
        return okJson({
          status: "unavailable",
          failureClass: "cli-missing",
          note: "pico-cli not found on PATH — install with `npm install -g @picoxr/pico-cli`; crash watching skipped.",
        });
      }
      const sec = Math.min(300, Math.max(5, Math.round(durationSec ?? 30)));
      const args = ["app", "watch-crash", packageName, "-d", device ?? "emulator-5554"];
      if (start) args.push("--start");
      if (activity) args.push("--activity", activity);
      if (intervalSec) args.push("--interval", String(Math.round(intervalSec)));

      const r = await run(cli.path, args, { timeoutMs: sec * 1000 });
      const output = `${r.stdout}\n${r.stderr}`.trim();
      if (!r.timedOut && r.code !== 0) {
        const failureClass = classifyPicoCliFailure(r.stderr, r.stdout);
        return okJson({
          status: "failed",
          failureClass,
          note: failureClass === "flag-or-version-drift"
            ? `pico-cli rejected the invocation (installed: ${cli.raw || "unknown"}) — its watch-crash surface drifted from the 0.3.0 flags this wrapper was verified against.`
            : "pico-cli app watch-crash exited before the window elapsed — read outputTail (the CLI's own words) before assuming a cause.",
          exitCode: r.code,
          ...(output ? { outputTail: tail(output, 20) } : {}),
        });
      }
      const indicators = scanForCrashIndicators(output);
      return okJson({
        status: "ok",
        packageName,
        watchedSec: sec,
        endedBy: r.timedOut ? "duration-cap (watcher killed by this wrapper — pico-cli has no duration flag)" : `cli-exit code ${r.code}`,
        crashIndicated: indicators.length > 0,
        indicators,
        ...(output ? { outputTail: tail(output, 40) } : { outputTail: "(no output during the window)" }),
        honesty: WATCH_HONESTY,
      });
    },
  );

  server.registerTool(
    "capture_record",
    {
      description:
        "Record the device screen with PICO's OFFICIAL recorder (`pico-cli capture record`, 1-180s) and pull the file " +
        "locally as a RECORDING evidence artifact — the video lane for demos and ledger evidence that single-frame " +
        "captures lack. Returns the stat-checked output path + size. Requires @picoxr/pico-cli on PATH (degrades to " +
        "status:'unavailable'). HONESTY: " + RECORD_HONESTY,
      inputSchema: {
        durationSec: z.number().min(1).max(180).optional().describe("Recording length in seconds (CLI range 1-180; default 15)."),
        device: z.string().optional().describe("Device serial (default emulator-5554)."),
        outputPath: z.string().optional().describe("Local output path (default ~/.pico-mcp/recordings/rec-<timestamp>.mp4)."),
      },
    },
    async ({ durationSec, device, outputPath }) => {
      const cli = probePicoCli();
      if (cli.status !== "ok") {
        return okJson({
          status: "unavailable",
          failureClass: "cli-missing",
          note: "pico-cli not found on PATH — install with `npm install -g @picoxr/pico-cli`; screen recording skipped.",
        });
      }
      const sec = Math.min(180, Math.max(1, Math.round(durationSec ?? 15)));
      const outDir = path.join(os.homedir(), ".pico-mcp", "recordings");
      fs.mkdirSync(outDir, { recursive: true });
      const artifact = outputPath ?? path.join(outDir, `rec-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`);
      const args = ["capture", "record", "-t", String(sec), "-o", artifact, "-d", device ?? "emulator-5554"];

      // The CLI blocks for the recording duration, then pulls the file — allow generous pull time.
      const r = await run(cli.path, args, { timeoutMs: (sec + 120) * 1000 });
      const output = `${r.stdout}\n${r.stderr}`.trim();
      if (r.timedOut || r.code !== 0) {
        const failureClass = classifyPicoCliFailure(r.stderr, r.stdout);
        return okJson({
          status: "failed",
          failureClass,
          note: r.timedOut
            ? `pico-cli capture record did not finish within ${sec + 120}s and was killed — read outputTail.`
            : failureClass === "flag-or-version-drift"
              ? `pico-cli rejected the invocation (installed: ${cli.raw || "unknown"}) — its capture surface drifted from the 0.3.0 flags this wrapper was verified against.`
              : "pico-cli capture record failed at runtime — read outputTail (the CLI's own words) before assuming a cause.",
          exitCode: r.code,
          ...(output ? { outputTail: tail(output, 20) } : {}),
        });
      }
      // Exit 0 is not evidence the recording exists — stat it and say which.
      const exists = fs.existsSync(artifact);
      const bytes = exists ? fs.statSync(artifact).size : null;
      return okJson({
        status: exists && (bytes ?? 0) > 0 ? "ok" : "failed",
        artifact,
        artifactExists: exists,
        artifactBytes: bytes,
        durationSec: sec,
        ...(exists && (bytes ?? 0) > 0
          ? {}
          : { note: `pico-cli exited 0 but the recording at ${artifact} is ${exists ? "empty" : "missing"} — treat as failed.` }),
        ...(output ? { outputTail: tail(output, 12) } : {}),
        honesty: RECORD_HONESTY,
      });
    },
  );
}
