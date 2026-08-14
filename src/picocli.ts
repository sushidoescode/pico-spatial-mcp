import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  inspectManagedPicoCli,
  resolveManagedPicoCli,
  type ManagedPicoCliIO,
  type ManagedPicoCliOptions,
  type PicoCliEnsureResult,
} from "./picoclimanaged.js";

export {
  PICO_CLI_PACKAGE,
  PICO_CLI_PATH_ENV,
  PICO_CLI_POLICY_ENV,
} from "./picoclimanaged.js";
export type { ManagedPicoCliOptions, PicoCliEnsureResult } from "./picoclimanaged.js";

// Node's native spawn/execFile cannot reliably execute npm's `.cmd` shims on Windows. cross-spawn
// does that without `shell:true` interpolation (some pico-cli argv, notably trace SQL, is user
// supplied). It is a direct runtime dependency even though the MCP SDK also happens to use it.
const require = createRequire(import.meta.url);
const crossSpawn = require("cross-spawn") as typeof nodeSpawn & { sync: typeof nodeSpawnSync };

/** Deprecated 37.x compatibility aliases. Policy parsing lives in picoclimanaged.ts. */
export const PICO_CLI_AUTOINSTALL_ENV = "PICO_MCP_AUTOINSTALL_CLI";
export const PICO_CLI_AUTOUPDATE_ENV = "PICO_MCP_AUTOUPDATE_CLI";
export const PICO_CLI_INSTALL_TIMEOUT_MS = 120_000;
const PICO_CLI_PROBE_TIMEOUT_MS = 15_000;
const PICO_CLI_OUTPUT_CAP_BYTES = 64 * 1024;
const PICO_CLI_KILL_GRACE_MS = 1_000;

/**
 * picocli.ts — the ONE shared managed-resolution lane for the official @picoxr/pico-cli binary.
 *
 * Every wrapper (perf_diagnose, perf_trace, watch_crash, capture_record, preflight_env) answers
 * "is pico-cli here, and which one?" through this module so the answer is consistent and cheap.
 *
 * HARD RULE (measured 2026-08-01 on pico-cli 0.3.0): NEVER probe with `pico-cli doctor` or
 * `pico-cli plugin doctor` — both hang (>=90s zero output / 45s timeout). `-v` and
 * `emulator status` return in well under a second; `-v` is the probe here.
 * Re-measured 2026-08-12 on 0.4.2 (sandbox install): `doctor --format json` returns a structured
 * JSON envelope in ~10s, exit 0 — the hang is fixed upstream. The `-v` probe stays: 0.3.0 remains
 * the common installed version, and a sub-second probe beats a 10s one for a per-call gate.
 */

function envValue(env: NodeJS.ProcessEnv, name: string, platform = process.platform): string | undefined {
  if (platform !== "win32") return env[name];
  const actual = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return actual ? env[actual] : undefined;
}

/** Candidate paths for a command, implemented in JS so probing never depends on POSIX `which`. */
export function executableCandidates(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path;
  if (pathApi.isAbsolute(command) || command.includes("/") || (platform === "win32" && command.includes("\\"))) {
    return [command];
  }
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const entries = (envValue(env, "PATH", platform) ?? "")
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
  const extensions = platform === "win32"
    ? (envValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
    : [""];
  const hasWindowsExtension = platform === "win32" && path.win32.extname(command).length > 0;
  return entries.flatMap((entry) => {
    const base = pathApi.join(entry, command);
    return hasWindowsExtension ? [base] : extensions.map((ext) => `${base}${ext}`);
  });
}

/** Resolve the pico-cli executable/shim on PATH without spawning a platform-specific locator. */
export function resolvePicoCliPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const candidate of executableCandidates("pico-cli", env, platform)) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep walking PATH. A broken/non-executable shim is not a successful probe.
    }
  }
  return null;
}

/** Resolve the pico-cli binary on PATH, or null. Kept async for backward compatibility. */
export async function picoCliPath(): Promise<string | null> {
  return resolvePicoCliPath();
}

export type PicoCliProbe =
  | { status: "ok"; path: string; version: string | null; raw: string }
  | { status: "unusable"; path: string; version: null; raw: string }
  | { status: "missing"; path: null; version: null; raw: string };

let probeMemo: PicoCliProbe | null = null;

/**
 * Probe `pico-cli -v` into {path, version, raw}, memoized per process. Only SUCCESSFUL probes are
 * memoized (the vault.ts idiom). This PATH-based synchronous compatibility
 * form has Node's nominal 15s timeout; production tool paths use probePicoCliBounded below for hard
 * process-tree settlement.
 * Verified live 2026-08-01: `pico-cli -v` -> "pico-cli/0.3.0 (public) darwin-arm64 node-v25.8.1".
 * Re-verified 2026-08-12 against a sandboxed 0.4.2: same one-line `-v` shape ("pico-cli/0.4.2
 * (public) darwin-arm64 node-v25.8.1"), so version parsing holds across the 0.4.x line.
 */
export function probePicoCli(force = false): PicoCliProbe {
  if (force) probeMemo = null;
  if (probeMemo && !force) return probeMemo;
  const cliPath = resolvePicoCliPath();
  if (!cliPath) {
    return { status: "missing", path: null, version: null, raw: "pico-cli executable not found on PATH" };
  }
  const v = crossSpawn.sync(cliPath, ["-v"], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: PICO_CLI_PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const raw = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim();
  if (v.status !== 0 || v.error) {
    const detail = [v.error?.message, raw].filter(Boolean).join("; ");
    return { status: "unusable", path: cliPath, version: null, raw: detail || "pico-cli -v failed" };
  }
  const version = raw.match(/pico-cli\/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
  probeMemo = { status: "ok", path: cliPath, version, raw };
  return probeMemo;
}

export type PicoCliProvisionFailureClass =
  | "network"
  | "permissions"
  | "registry-404"
  | "timeout"
  | "npm-unavailable"
  | "install-failed"
  | "version-check-failed"
  | "postinstall-probe-failed";

export type PicoCliFailureClass =
  | "cli-missing"
  | "cli-unusable"
  | "flag-or-version-drift"
  | "setup-required"
  | "latest-unknown"
  | "update-failed"
  | "cli-disabled"
  | "configuration"
  | "runtime"
  | PicoCliProvisionFailureClass;

/** The de-facto standardized result core every CLI wrapper returns (2026-07-28 revision lane —
 * declared as outputSchema so hosts get the typed contract instead of description prose). All
 * optional: which fields appear depends on the status branch; tools spread tool-specific fields
 * on top and declare the whole object with .passthrough(). */
export const cliWrapperContractShape = {
  failureClass: z.string().optional().describe("Why the CLI lane failed: managed policy/freshness, setup-required, flag/version drift, or runtime."),
  note: z.string().optional().describe("This wrapper's guidance in plain words — remedies included, causes never guessed."),
  outputTail: z.string().optional().describe("The CLI's own words (verbatim tail) — read before assuming a cause."),
  outputTruncated: z.boolean().optional().describe("True when CLI output exceeded the capture cap; scans over it are partial."),
  honesty: z.string().optional().describe("The wrapper's standing honesty contract for this result."),
  picoCli: z.record(z.unknown()).optional().describe("Managed/external CLI identity and freshness provenance for every successful ensure-backed result."),
  setupCommand: z.object({ path: z.string(), args: z.array(z.string()) }).optional().describe("Absolute manual setup guidance. This server never executes it."),
  error: z.string().optional(),
} as const;

export type PicoCliCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  outputTruncated: boolean;
};

export type PicoCliRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
};

function appendCapped(current: string, chunk: Buffer | string, cap: number): { text: string; truncated: boolean } {
  const combined = current + chunk.toString();
  if (Buffer.byteLength(combined, "utf8") <= cap) return { text: combined, truncated: false };
  const bytes = Buffer.from(combined, "utf8");
  let start = Math.max(0, bytes.length - cap);
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), truncated: true };
}

/**
 * Run a child with captured, capped output and a hard settlement bound. All children receive the
 * complete server environment plus explicit overrides. On timeout, kill the process group on
 * POSIX or the process tree on Windows, then settle even if a grandchild inherited stdio.
 */
export function runPicoCliCommand(
  command: string,
  args: string[],
  opts: PicoCliRunOptions = {},
): Promise<PicoCliCommandResult> {
  const timeoutMs = opts.timeoutMs ?? PICO_CLI_INSTALL_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? PICO_CLI_KILL_GRACE_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? PICO_CLI_OUTPUT_CAP_BYTES;
  const childEnv = { ...process.env, ...opts.env };
  const platform = process.platform;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let timeoutCleanupPending = false;
    let observedCode: number | null = null;
    let observedSignal: NodeJS.Signals | null = null;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof crossSpawn>;
    let treeKiller: ReturnType<typeof crossSpawn> | undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({ code, signal, stdout, stderr, timedOut, ...(spawnError ? { spawnError } : {}), outputTruncated });
    };

    const kill = (signal: NodeJS.Signals) => {
      if (platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The group may already be gone; fall back to the direct child.
        }
      }
      try { child.kill(signal); } catch { /* already exited */ }
    };

    const settleTimedOut = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      treeKiller?.unref();
      finish(observedCode ?? child.exitCode, observedSignal ?? child.signalCode);
    };

    try {
      child = crossSpawn(command, args, {
        cwd: opts.cwd,
        env: childEnv,
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish(null, null, error instanceof Error ? error.message : String(error));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const appended = appendCapped(stdout, chunk, maxOutputBytes);
      stdout = appended.text;
      outputTruncated ||= appended.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const appended = appendCapped(stderr, chunk, maxOutputBytes);
      stderr = appended.text;
      outputTruncated ||= appended.truncated;
    });
    child.once("error", (error) => {
      if (timeoutCleanupPending) {
        const appended = appendCapped(stderr, error.message, maxOutputBytes);
        stderr = appended.text;
        outputTruncated ||= appended.truncated;
        return;
      }
      finish(null, null, error.message);
    });
    child.once("close", (code, signal) => {
      observedCode = code;
      observedSignal = signal;
      // Once a timeout begins, do not let a `.cmd` parent (or POSIX group leader) closing early
      // cancel process-tree cleanup. The cleanup path owns settlement from this point onward.
      if (!timeoutCleanupPending) finish(code, signal);
    });

    timeout = setTimeout(() => {
      timedOut = true;
      timeoutCleanupPending = true;
      if (platform === "win32") {
        if (!child.pid) {
          kill("SIGKILL");
          hardTimer = setTimeout(settleTimedOut, 250);
          return;
        }

        // npm global commands and pico-cli are normally `.cmd` shims on Windows. Kill the tree
        // FIRST: killing cmd.exe directly can orphan the Node/npm grandchild before taskkill walks
        // it. taskkill is bounded too, and every event has a listener so this failure path cannot
        // crash the MCP on a restricted PATH/SystemRoot.
        const systemRoot = envValue(childEnv, "SystemRoot", "win32") ?? "C:\\Windows";
        const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
        try {
          treeKiller = crossSpawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
            env: childEnv,
            stdio: "ignore",
            windowsHide: true,
          });
          treeKiller.once("error", () => {
            // Best-effort fallback if taskkill itself is unavailable; the hard timer still settles.
            kill("SIGKILL");
          });
          treeKiller.once("close", (code) => {
            if (code !== 0) kill("SIGKILL");
            settleTimedOut();
          });
        } catch {
          kill("SIGKILL");
        }
        hardTimer = setTimeout(() => {
          try { treeKiller?.kill("SIGKILL"); } catch { /* already exited */ }
          kill("SIGKILL");
          settleTimedOut();
        }, Math.max(killGraceMs, 1_000) + 250);
        return;
      }

      kill("SIGTERM");
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        hardTimer = setTimeout(settleTimedOut, 250);
      }, killGraceMs);
    }, timeoutMs);
  });
}

/**
 * Async hard-bounded form used by provisioning and every CLI-backed operation. The legacy sync
 * probe remains for the synchronous preflight fixture API, but it cannot provide the runner's
 * process-tree settlement guarantee when a hostile executable ignores its timeout signal.
 */
export async function probePicoCliBounded(force = false): Promise<PicoCliProbe> {
  if (force) probeMemo = null;
  if (probeMemo && !force) return probeMemo;
  const cliPath = resolvePicoCliPath();
  if (!cliPath) {
    return { status: "missing", path: null, version: null, raw: "pico-cli executable not found on PATH" };
  }
  const result = await runPicoCliCommand(cliPath, ["-v"], {
    timeoutMs: PICO_CLI_PROBE_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
  });
  const raw = `${result.stdout}${result.stderr}`.trim();
  if (result.timedOut || result.code !== 0 || result.spawnError) {
    const detail = [
      result.spawnError,
      result.timedOut ? `pico-cli -v exceeded ${PICO_CLI_PROBE_TIMEOUT_MS}ms and was killed` : null,
      raw,
    ].filter(Boolean).join("; ");
    return { status: "unusable", path: cliPath, version: null, raw: detail || "pico-cli -v failed" };
  }
  const version = raw.match(/pico-cli\/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
  probeMemo = { status: "ok", path: cliPath, version, raw };
  return probeMemo;
}

export function runPicoCli(
  cli: Extract<PicoCliProbe, { status: "ok" }>,
  args: string[],
  opts: PicoCliRunOptions = {},
): Promise<PicoCliCommandResult> {
  return runPicoCliCommand(cli.path, args, opts);
}

/** Read-only synchronous invocation for preflight's injected IO contract (also handles .cmd). */
export function runPicoCliSync(
  args: string[],
  timeoutMs = PICO_CLI_PROBE_TIMEOUT_MS,
): { ok: boolean; stdout: string; stderr: string } {
  const cliPath = resolvePicoCliPath();
  if (!cliPath) return { ok: false, stdout: "", stderr: "pico-cli executable not found on PATH" };
  const result = crossSpawn.sync(cliPath, args, {
    encoding: "utf8",
    env: { ...process.env },
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? "",
    stderr: [result.error?.message, result.stderr ?? ""].filter(Boolean).join("\n"),
  };
}

function outputTail(result: PicoCliCommandResult, lines = 20): string | undefined {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  if (!text) return result.spawnError;
  const selected = text.split("\n").slice(-lines).join("\n");
  return result.outputTruncated ? `[earlier output truncated]\n${selected}` : selected;
}

export function classifyPicoCliProvisionFailure(
  result: PicoCliCommandResult,
  fallback: "install-failed" | "version-check-failed" = "install-failed",
): PicoCliProvisionFailureClass {
  if (result.timedOut) return "timeout";
  const text = `${result.spawnError ?? ""}\n${result.stderr}\n${result.stdout}`.toLowerCase();
  if (/\be404\b|404\s+(?:not\s+found|error)|not in (?:the )?registry/.test(text)) return "registry-404";
  if (/\beacces\b|\beperm\b|permission denied|operation not permitted|access is denied/.test(text)) return "permissions";
  if (/\benet(?:unreach|down)\b|\beconn(?:reset|refused|aborted)\b|\beai_again\b|\benotfound\b|\betimedout\b|network (?:error|request)|fetch failed|socket hang up|certificate (?:has expired|error)|getaddrinfo/.test(text)) return "network";
  if (result.spawnError || (result.code === null && /enoent|not found|cannot find/.test(text))) return "npm-unavailable";
  return fallback;
}

type Semver = { major: number; minor: number; patch: number; prerelease: string | null };

function parseSemver(value: string | null | undefined): Semver | null {
  const match = value?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null }
    : null;
}

/** -1 = left older, 0 = equal, 1 = left newer, null = either version is not semver. */
export function comparePicoCliVersions(left: string | null, right: string | null): -1 | 0 | 1 | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const leftIds = a.prerelease.split(".");
  const rightIds = b.prerelease.split(".");
  for (let i = 0; i < Math.max(leftIds.length, rightIds.length); i += 1) {
    const leftId = leftIds[i];
    const rightId = rightIds[i];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    if (leftId === rightId) continue;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) return Number(leftId) < Number(rightId) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftId.localeCompare(rightId) < 0 ? -1 : 1;
  }
  return 0;
}

export type PicoCliProvenance = Pick<Extract<PicoCliEnsureResult, { status: "ok" }>,
  "source" | "policy" | "path" | "version" | "latestVersion" | "checkedAt" | "freshness" | "action" | "warning"
>;

export function picoCliProvenance(result: Extract<PicoCliEnsureResult, { status: "ok" }>): PicoCliProvenance {
  return {
    source: result.source,
    policy: result.policy,
    path: result.path,
    version: result.version,
    latestVersion: result.latestVersion,
    checkedAt: result.checkedAt,
    freshness: result.freshness,
    action: result.action,
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

export function picoCliFromEnsure(result: PicoCliEnsureResult): Extract<PicoCliProbe, { status: "ok" }> | null {
  return result.status === "ok"
    ? { status: "ok", path: result.path, version: result.version, raw: result.raw }
    : null;
}

const managedIo: ManagedPicoCliIO = {
  env: process.env,
  platform: process.platform,
  homeDir: os.homedir(),
  now: () => Date.now(),
  randomUUID,
  run: (command, args, options) => runPicoCliCommand(command, args, options),
};

type CompatibleManagedOptions = ManagedPicoCliOptions & {
  /** Deprecated 37.x inputs accepted but intentionally inert. */
  explicit?: boolean;
  update?: boolean;
};

type EnsureFlight = { forceRefresh: boolean; promise: Promise<PicoCliEnsureResult> };
const ensureFlights = new Map<string, EnsureFlight>();

function ensureOptionsKey(options: CompatibleManagedOptions): string {
  const managedRoot = path.resolve(options.managedRoot ?? path.join(managedIo.homeDir, ".pico-mcp", "cli"));
  return JSON.stringify([
    managedRoot,
    options.installTimeoutMs ?? null,
    options.updateCheckTimeoutMs ?? null,
    options.killGraceMs ?? null,
  ]);
}

function unexpectedManagedFailure(error: unknown): PicoCliEnsureResult {
  return {
    status: "unavailable",
    source: null,
    policy: null,
    action: "skipped",
    path: null,
    version: null,
    raw: "",
    latestVersion: null,
    checkedAt: null,
    freshness: null,
    failureClass: "configuration",
    note: `Unexpected managed pico-cli resolution failure: ${error instanceof Error ? error.message : String(error)}`,
    deprecatedAliases: [],
  };
}

/** Lazy managed resolution. Registration/startup never calls this. */
export function ensurePicoCli(options: CompatibleManagedOptions = {}): Promise<PicoCliEnsureResult> {
  const normalized: ManagedPicoCliOptions = {
    ...(options.managedRoot !== undefined ? { managedRoot: options.managedRoot } : {}),
    ...(options.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}),
    ...(options.installTimeoutMs !== undefined ? { installTimeoutMs: options.installTimeoutMs } : {}),
    ...(options.updateCheckTimeoutMs !== undefined ? { updateCheckTimeoutMs: options.updateCheckTimeoutMs } : {}),
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
  };
  const key = ensureOptionsKey(options);
  const active = ensureFlights.get(key);
  if (active) {
    if (active.forceRefresh || !normalized.forceRefresh) return active.promise;
    return active.promise.then(() => ensurePicoCli({ ...normalized, forceRefresh: true }));
  }
  const pending = resolveManagedPicoCli(normalized, managedIo).catch(unexpectedManagedFailure);
  ensureFlights.set(key, { forceRefresh: normalized.forceRefresh === true, promise: pending });
  void pending.finally(() => {
    if (ensureFlights.get(key)?.promise === pending) ensureFlights.delete(key);
  });
  return pending;
}

export function inspectPicoCliCached(options: ManagedPicoCliOptions = {}): Promise<PicoCliEnsureResult> {
  return inspectManagedPicoCli(options, managedIo).catch(unexpectedManagedFailure);
}

export type PicoCliEnvelope =
  | { status: "ok"; toolStatus: "SUCCESS" | "PARTIAL" | "FAILED"; outcome: "operational" | "degraded" | "failed"; summary: string | null; data: unknown; errors: unknown[]; envelope: Record<string, unknown>; raw: string }
  | { status: "invalid"; detail: string };

/** Total parser for pico-cli's machine envelope: callers can safely turn malformed output into a warn. */
export function parsePicoCliEnvelope(raw: string): PicoCliEnvelope {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { status: "invalid", detail: "pico-cli did not return JSON." }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "invalid", detail: "pico-cli JSON envelope is not an object." };
  const envelope = parsed as Record<string, unknown>;
  const toolStatus = envelope.tool_status;
  if (toolStatus !== "SUCCESS" && toolStatus !== "PARTIAL" && toolStatus !== "FAILED") return { status: "invalid", detail: "pico-cli JSON envelope has no recognized tool_status." };
  return {
    status: "ok",
    toolStatus,
    outcome: toolStatus === "SUCCESS" ? "operational" : toolStatus === "PARTIAL" ? "degraded" : "failed",
    summary: typeof envelope.summary === "string" ? envelope.summary : null,
    data: envelope.data,
    errors: Array.isArray(envelope.errors) ? envelope.errors : [],
    envelope,
    raw: raw.slice(0, 50_000),
  };
}

/** Returns returned remediation strings in deterministic depth-first/key order; never invents one. */
export function extractPicoCliRemediations(value: unknown, cap = 32): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (out.length >= cap || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    const obj = node as Record<string, unknown>;
    for (const key of ["fix", "nextAction"]) if (typeof obj[key] === "string" && !out.includes(obj[key] as string)) out.push(obj[key] as string);
    const keys = Object.keys(obj).filter((key) => key !== "fix" && key !== "nextAction");
    const ordered = ["errors", "checks", "data", ...keys.filter((key) => !["errors", "checks", "data"].includes(key)).sort()];
    for (const key of ordered) visit(obj[key]);
  };
  visit(value);
  return out;
}

/**
 * Classify a FAILED pico-cli invocation honestly. A "…are not installed. Run `pico-cli setup`"
 * refusal is the 0.4.x utilities gate (measured 2026-08-12 on 0.4.2: the whole perf family exits 1
 * with "Perf utilities 0.1.0 are not installed" until a one-time `pico-cli setup`) — that is a
 * provisioning gap with an exact user-run remedy, not drift and not a device problem. Usage dumps /
 * unknown-option complaints mean the wrapped flags no longer match the installed CLI (drift —
 * retrying unchanged cannot help); anything else is a runtime failure whose cause lives in the
 * CLI's own output, not in a guess of ours.
 */
export function classifyPicoCliFailure(
  stderr: string,
  stdout: string,
): "flag-or-version-drift" | "setup-required" | "runtime" {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  if (/not installed[\s\S]{0,120}pico-cli setup/.test(text)) return "setup-required";
  return /unknown option|unknown command|unknown argument|missing required|\busage:/.test(text)
    ? "flag-or-version-drift"
    : "runtime";
}
