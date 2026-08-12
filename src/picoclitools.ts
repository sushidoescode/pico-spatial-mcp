import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { okJson, tail } from "./util.js";
import { ensurePicoCli, picoCliFromEnsure, runPicoCli, classifyPicoCliFailure } from "./picocli.js";

/**
 * picoclitools.ts — v31: thin evidence primitives over the official pico-cli.
 *
 * watch_crash wraps `pico-cli app watch-crash <pkg>` — PICO's own crash monitor (PID-change
 * polling + surfaced exception logs) instead of our ad-hoc logcat grepping. Verified against
 * 0.3.0 --help (2026-08-01) and re-verified against 0.4.2 --help (2026-08-12): STILL no duration
 * flag — 0.4.2 adds only --launch-timeout <seconds> (wait for the process to appear) — so this
 * wrapper's kill-bound after durationSec remains required, and it says so honestly.
 *
 * capture_record wraps `pico-cli capture record` — the official screen recorder (1-180s, pulls
 * the file locally). It gives the ledger a recording evidence lane and the demo a video fallback.
 * Flag surface byte-identical between 0.3.0 and 0.4.2 --help (re-verified 2026-08-12).
 *
 * HONESTY (load-bearing): output is the CLI's verbatim text; crash detection is a best-effort
 * keyword scan over that text, never a verdict — read outputTail before claiming a crash or its
 * absence. A recording artifact is stat-checked, and its pixels prove nothing until LOOKED at:
 * on immersive content the recorded display surface may not show the in-headset view (the v30.1
 * screencap lesson — adb screencap-class paths proved black for immersive Unity on device).
 */

const WATCH_HONESTY =
  "The watch window is bounded by THIS wrapper killing the child (pico-cli has no duration " +
  "flag through 0.4.2 and streams indefinitely). crashIndicated is a best-effort keyword scan over the CLI's " +
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
        "polling + surfaced exception logs) for a bounded window. The CLI (through 0.4.2) has NO duration flag and streams until " +
        "killed, so this wrapper kills the watcher after durationSec — a timed-out child is the EXPECTED healthy end of " +
        "the window, reported as endedBy:'duration-cap'. Optionally starts the app first (--start/--activity). Uses " +
        "@picoxr/pico-cli from PATH; missing defaults to status:'unavailable', while PICO_MCP_AUTOINSTALL_CLI=1 or " +
        "ensure_pico_cli enables a lazy bounded install and same-call retry. HONESTY: " + WATCH_HONESTY,
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
            ? "pico-cli not found on PATH — install with `npm install -g @picoxr/pico-cli`; crash watching skipped."
            : unavailable?.note ?? "pico-cli did not become usable.",
        });
      }
      const provisioning = ensured.action === "present" ? {} : { cliProvisioning: ensured };
      const sec = Math.min(300, Math.max(5, Math.round(durationSec ?? 30)));
      const args = ["app", "watch-crash", packageName, "-d", device ?? "emulator-5554"];
      if (start) args.push("--start");
      if (activity) args.push("--activity", activity);
      if (intervalSec) args.push("--interval", String(Math.round(intervalSec)));

      const r = await runPicoCli(cli, args, { timeoutMs: sec * 1000 });
      const output = `${r.stdout}\n${r.stderr}`.trim();
      if (!r.timedOut && r.code !== 0) {
        const failureClass = classifyPicoCliFailure(r.stderr, r.stdout);
        return okJson({
          status: "failed",
          failureClass,
          note: failureClass === "flag-or-version-drift"
            ? `pico-cli rejected the invocation (installed: ${cli.raw || "unknown"}) — its watch-crash surface drifted from the 0.3.0/0.4.2 flags this wrapper was verified against.`
            : failureClass === "not-provisioned"
              ? `the installed pico-cli (${cli.raw || "unknown"}) reports a required utility bundle is not installed — run \`pico-cli setup\` yourself and retry; this wrapper never runs setup (it mutates the machine).`
              : "pico-cli app watch-crash exited before the window elapsed — read outputTail (the CLI's own words) before assuming a cause.",
          exitCode: r.code,
          ...(output ? { outputTail: tail(output, 20) } : {}),
          ...(r.outputTruncated ? { outputTruncated: true } : {}),
          ...provisioning,
        });
      }
      const indicators = scanForCrashIndicators(output);
      return okJson({
        status: "ok",
        packageName,
        watchedSec: sec,
        endedBy: r.timedOut ? "duration-cap (watcher killed by this wrapper — pico-cli has no duration flag)" : `cli-exit code ${r.code}`,
        crashIndicated: indicators.length > 0,
        crashScanComplete: !r.outputTruncated,
        indicators,
        ...(output ? { outputTail: tail(output, 40) } : { outputTail: "(no output during the window)" }),
        ...(r.outputTruncated ? {
          outputTruncated: true,
          note: "pico-cli output exceeded the capture cap; crash indicators were scanned only in the retained tail, so crashIndicated:false does not prove the full window was quiet.",
        } : {}),
        honesty: WATCH_HONESTY,
        ...provisioning,
      });
    },
  );

  server.registerTool(
    "capture_record",
    {
      description:
        "Record the device screen with PICO's OFFICIAL recorder (`pico-cli capture record`, 1-180s) and pull the file " +
        "locally as a RECORDING evidence artifact — the video lane for demos and ledger evidence that single-frame " +
        "captures lack. Returns the stat-checked output path + size. Uses @picoxr/pico-cli from PATH; missing defaults " +
        "to status:'unavailable', while PICO_MCP_AUTOINSTALL_CLI=1 or ensure_pico_cli enables a lazy bounded install " +
        "and same-call retry. HONESTY: " + RECORD_HONESTY,
      inputSchema: {
        durationSec: z.number().min(1).max(180).optional().describe("Recording length in seconds (CLI range 1-180; default 15)."),
        device: z.string().optional().describe("Device serial (default emulator-5554)."),
        outputPath: z.string().optional().describe("Local output path (default ~/.pico-mcp/recordings/rec-<timestamp>.mp4)."),
      },
    },
    async ({ durationSec, device, outputPath }) => {
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
            ? "pico-cli not found on PATH — install with `npm install -g @picoxr/pico-cli`; screen recording skipped."
            : unavailable?.note ?? "pico-cli did not become usable.",
        });
      }
      const provisioning = ensured.action === "present" ? {} : { cliProvisioning: ensured };
      const sec = Math.min(180, Math.max(1, Math.round(durationSec ?? 15)));
      const outDir = path.join(os.homedir(), ".pico-mcp", "recordings");
      fs.mkdirSync(outDir, { recursive: true });
      const artifact = outputPath ?? path.join(outDir, `rec-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`);
      const args = ["capture", "record", "-t", String(sec), "-o", artifact, "-d", device ?? "emulator-5554"];

      // The CLI blocks for the recording duration, then pulls the file — allow generous pull time.
      const r = await runPicoCli(cli, args, { timeoutMs: (sec + 120) * 1000 });
      const output = `${r.stdout}\n${r.stderr}`.trim();
      if (r.timedOut || r.code !== 0) {
        const failureClass = classifyPicoCliFailure(r.stderr, r.stdout);
        return okJson({
          status: "failed",
          failureClass,
          note: r.timedOut
            ? `pico-cli capture record did not finish within ${sec + 120}s and was killed — read outputTail.`
            : failureClass === "flag-or-version-drift"
              ? `pico-cli rejected the invocation (installed: ${cli.raw || "unknown"}) — its capture surface drifted from the 0.3.0/0.4.2 flags this wrapper was verified against.`
              : failureClass === "not-provisioned"
                ? `the installed pico-cli (${cli.raw || "unknown"}) reports a required utility bundle is not installed — run \`pico-cli setup\` yourself and retry; this wrapper never runs setup (it mutates the machine).`
                : "pico-cli capture record failed at runtime — read outputTail (the CLI's own words) before assuming a cause.",
          exitCode: r.code,
          ...(output ? { outputTail: tail(output, 20) } : {}),
          ...(r.outputTruncated ? { outputTruncated: true } : {}),
          ...provisioning,
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
        ...(r.outputTruncated ? { outputTruncated: true } : {}),
        honesty: RECORD_HONESTY,
        ...provisioning,
      });
    },
  );
}
