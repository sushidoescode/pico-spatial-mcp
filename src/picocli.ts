import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * picocli.ts — v31: the ONE shared probe for the official @picoxr/pico-cli binary.
 *
 * Every wrapper (perf_diagnose, perf_trace, watch_crash, capture_record, preflight_env) answers
 * "is pico-cli here, and which one?" through this module so the answer is consistent and cheap.
 *
 * HARD RULE (measured 2026-08-01 on pico-cli 0.3.0): NEVER probe with `pico-cli doctor` or
 * `pico-cli plugin doctor` — both hang (>=90s zero output / 45s timeout). `-v` and
 * `emulator status` return in well under a second; `-v` is the probe here.
 */

/** Resolve the pico-cli binary on PATH, or null. (Moved verbatim from perfcli.ts.) */
export async function picoCliPath(): Promise<string | null> {
  try {
    const { stdout } = await run("which", ["pico-cli"]);
    const p = stdout.trim();
    return p.length ? p : null;
  } catch {
    return null;
  }
}

export type PicoCliProbe =
  | { status: "ok"; path: string; version: string | null; raw: string }
  | { status: "missing"; path: null; version: null; raw: string };

let probeMemo: PicoCliProbe | null = null;

/**
 * Probe `pico-cli -v` into {path, version, raw}, memoized per process. Only SUCCESSFUL probes are
 * memoized (the vault.ts idiom): a server started before `npm install -g @picoxr/pico-cli` picks
 * the CLI up on the next call instead of staying blind until restart. Both spawns carry a 15s cap
 * (the preflight pattern) so a wedged binary can never hang a tool call.
 * Verified live 2026-08-01: `pico-cli -v` -> "pico-cli/0.3.0 (public) darwin-arm64 node-v25.8.1".
 */
export function probePicoCli(force = false): PicoCliProbe {
  if (probeMemo && !force) return probeMemo;
  const which = spawnSync("which", ["pico-cli"], { encoding: "utf8", timeout: 15_000 });
  const cliPath = which.status === 0 ? (which.stdout ?? "").trim() : "";
  if (!cliPath) {
    return { status: "missing", path: null, version: null, raw: (which.stderr ?? "").trim() };
  }
  const v = spawnSync(cliPath, ["-v"], { encoding: "utf8", timeout: 15_000 });
  const raw = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim();
  const version = raw.match(/pico-cli\/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
  probeMemo = { status: "ok", path: cliPath, version, raw };
  return probeMemo;
}

export type PicoCliFailureClass = "cli-missing" | "flag-or-version-drift" | "runtime";

/**
 * Classify a FAILED pico-cli invocation honestly. Usage dumps / unknown-option complaints mean the
 * wrapped flags no longer match the installed CLI (drift — retrying unchanged cannot help); anything
 * else is a runtime failure whose cause lives in the CLI's own output, not in a guess of ours.
 */
export function classifyPicoCliFailure(stderr: string, stdout: string): Exclude<PicoCliFailureClass, "cli-missing"> {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return /unknown option|unknown command|unknown argument|missing required|\busage:/.test(text)
    ? "flag-or-version-drift"
    : "runtime";
}
