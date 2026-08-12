import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Node's native spawn/execFile cannot reliably execute npm's `.cmd` shims on Windows. cross-spawn
// does that without `shell:true` interpolation (some pico-cli argv, notably trace SQL, is user
// supplied). It is a direct runtime dependency even though the MCP SDK also happens to use it.
const require = createRequire(import.meta.url);
const crossSpawn = require("cross-spawn") as typeof nodeSpawn & { sync: typeof nodeSpawnSync };

export const PICO_CLI_PACKAGE = "@picoxr/pico-cli";
export const PICO_CLI_AUTOINSTALL_ENV = "PICO_MCP_AUTOINSTALL_CLI";
export const PICO_CLI_AUTOUPDATE_ENV = "PICO_MCP_AUTOUPDATE_CLI";
export const PICO_CLI_INSTALL_TIMEOUT_MS = 120_000;
const PICO_CLI_UPDATE_CHECK_TIMEOUT_MS = 30_000;
const PICO_CLI_PROBE_TIMEOUT_MS = 15_000;
const PICO_CLI_OUTPUT_CAP_BYTES = 64 * 1024;
const PICO_CLI_KILL_GRACE_MS = 1_000;
const PICO_CLI_UPDATE_CHECK_TTL_MS = 60 * 60 * 1_000;

/**
 * picocli.ts — the ONE shared probe/provisioning lane for the official @picoxr/pico-cli binary.
 *
 * Every wrapper (perf_diagnose, perf_trace, watch_crash, capture_record, preflight_env) answers
 * "is pico-cli here, and which one?" through this module so the answer is consistent and cheap.
 *
 * HARD RULE (measured 2026-08-01 on pico-cli 0.3.0): NEVER probe with `pico-cli doctor` or
 * `pico-cli plugin doctor` — both hang (>=90s zero output / 45s timeout). `-v` and
 * `emulator status` return in well under a second; `-v` is the probe here.
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
 * memoized (the vault.ts idiom): a server started before `npm install -g @picoxr/pico-cli` picks
 * the CLI up on the next call instead of staying blind until restart. This synchronous compatibility
 * form has Node's nominal 15s timeout; production tool paths use probePicoCliBounded below for hard
 * process-tree settlement.
 * Verified live 2026-08-01: `pico-cli -v` -> "pico-cli/0.3.0 (public) darwin-arm64 node-v25.8.1".
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
  | "runtime"
  | PicoCliProvisionFailureClass;

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

export type PicoCliEnsureResult =
  | ({ status: "ok"; action: "present" | "installed" | "updated" } & Omit<Extract<PicoCliProbe, { status: "ok" }>, "status"> & {
      previousVersion?: string | null;
      latestVersion?: string;
      note?: string;
    })
  | {
      status: "unavailable";
      action: "skipped";
      path: string | null;
      version: null;
      raw: string;
      failureClass: "cli-missing" | "cli-unusable";
      note: string;
    }
  | {
      status: "failed";
      action: "failed";
      path: string | null;
      version: string | null;
      raw: string;
      phase: "version-check" | "install" | "update" | "postinstall-probe";
      failureClass: PicoCliProvisionFailureClass;
      note: string;
      previousVersion?: string | null;
      latestVersion?: string;
      exitCode?: number | null;
      timedOut?: boolean;
      outputTail?: string;
    };

export type EnsurePicoCliOptions = {
  /** Dedicated ensure_pico_cli calls set explicit=true; that call itself is installation consent. */
  explicit?: boolean;
  /** Separate update consent. The environment alternative is PICO_MCP_AUTOUPDATE_CLI=1. */
  update?: boolean;
  /** Test seams; production callers use the bounded defaults. */
  installTimeoutMs?: number;
  updateCheckTimeoutMs?: number;
  killGraceMs?: number;
};

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

function parseLatestVersion(stdout: string): string | null {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parseSemver(parsed) ? parsed.replace(/^v/, "") : null;
    if (Array.isArray(parsed)) {
      const last = [...parsed].reverse().find((item) => typeof item === "string" && parseSemver(item));
      return typeof last === "string" ? last.replace(/^v/, "") : null;
    }
  } catch {
    // npm may be configured for non-JSON output despite --json; accept one plain semver line.
  }
  return parseSemver(trimmed) ? trimmed.replace(/^v/, "") : null;
}

function currentPathKey(): string {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

async function exposeNpmGlobalBin(timeoutMs: number, killGraceMs: number): Promise<PicoCliCommandResult> {
  const prefixResult = await runPicoCliCommand("npm", ["prefix", "-g"], {
    timeoutMs,
    killGraceMs,
  });
  if (prefixResult.code !== 0 || prefixResult.timedOut) return prefixResult;
  const prefix = prefixResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!prefix || !path.isAbsolute(prefix)) return prefixResult;
  const bin = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const key = currentPathKey();
  const existing = process.env[key] ?? "";
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  if (!existing.split(delimiter).includes(bin)) process.env[key] = existing ? `${bin}${delimiter}${existing}` : bin;
  return prefixResult;
}

function failedEnsure(
  probe: Extract<PicoCliProbe, { status: "ok" }> | null,
  phase: Extract<PicoCliEnsureResult, { status: "failed" }>["phase"],
  failureClass: PicoCliProvisionFailureClass,
  note: string,
  result?: PicoCliCommandResult,
  extra: Partial<Pick<Extract<PicoCliEnsureResult, { status: "failed" }>, "previousVersion" | "latestVersion">> = {},
): Extract<PicoCliEnsureResult, { status: "failed" }> {
  return {
    status: "failed",
    action: "failed",
    path: probe?.path ?? null,
    version: probe?.version ?? null,
    raw: probe?.raw ?? "",
    phase,
    failureClass,
    note,
    ...extra,
    ...(result ? {
      exitCode: result.code,
      timedOut: result.timedOut,
      ...(outputTail(result) ? { outputTail: outputTail(result) } : {}),
    } : {}),
  };
}

function readyProbe(result: PicoCliEnsureResult): Extract<PicoCliProbe, { status: "ok" }> | null {
  if (result.status === "unavailable" || !result.path) return null;
  return { status: "ok", path: result.path, version: result.version, raw: result.raw };
}

/** A failed auto-update still leaves the old CLI usable when its post-failure `-v` probe passes. */
export function picoCliFromEnsure(result: PicoCliEnsureResult): Extract<PicoCliProbe, { status: "ok" }> | null {
  return readyProbe(result);
}

let ensureInFlight: Promise<PicoCliEnsureResult> | null = null;
let successfulUpdateCheck: { installedVersion: string; latestVersion: string; checkedAt: number } | null = null;

async function ensurePicoCliOnce(opts: EnsurePicoCliOptions): Promise<PicoCliEnsureResult> {
  const initial = await probePicoCliBounded();
  const autoInstall = process.env[PICO_CLI_AUTOINSTALL_ENV] === "1";
  const autoUpdate = process.env[PICO_CLI_AUTOUPDATE_ENV] === "1";
  // Update consent is deliberately not first-install consent. A missing CLI still requires the
  // dedicated ensure tool or AUTOINSTALL=1; AUTOUPDATE alone only applies to an existing install.
  const allowInstall = opts.explicit === true || autoInstall;
  const allowUpdate = opts.update === true || autoUpdate;
  const installTimeoutMs = opts.installTimeoutMs ?? PICO_CLI_INSTALL_TIMEOUT_MS;
  const updateCheckTimeoutMs = opts.updateCheckTimeoutMs ?? PICO_CLI_UPDATE_CHECK_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? PICO_CLI_KILL_GRACE_MS;

  if (initial.status === "missing") {
    if (!allowInstall) {
      return {
        status: "unavailable",
        action: "skipped",
        path: null,
        version: null,
        raw: initial.raw,
        failureClass: "cli-missing",
        note: `pico-cli not found on PATH — install with \`npm install -g ${PICO_CLI_PACKAGE}\` or opt in with ${PICO_CLI_AUTOINSTALL_ENV}=1.`,
      };
    }

    const installed = await runPicoCliCommand("npm", ["install", "-g", PICO_CLI_PACKAGE], {
      timeoutMs: installTimeoutMs,
      killGraceMs,
    });
    if (installed.timedOut || installed.code !== 0) {
      const failureClass = classifyPicoCliProvisionFailure(installed);
      return failedEnsure(
        null,
        "install",
        failureClass,
        failureClass === "timeout"
          ? `npm install -g ${PICO_CLI_PACKAGE} exceeded ${installTimeoutMs}ms and was killed; pico-cli remains unavailable.`
          : `npm install -g ${PICO_CLI_PACKAGE} failed (${failureClass}); pico-cli remains unavailable.`,
        installed,
      );
    }

    let after = await probePicoCliBounded(true);
    if (after.status !== "ok") {
      await exposeNpmGlobalBin(Math.min(15_000, updateCheckTimeoutMs), killGraceMs);
      after = await probePicoCliBounded(true);
    }
    if (after.status !== "ok") {
      return failedEnsure(
        null,
        "postinstall-probe",
        "postinstall-probe-failed",
        `npm exited 0, but the required \`pico-cli -v\` re-probe still failed; check npm's global prefix and PATH.`,
        installed,
      );
    }
    return { status: "ok", action: "installed", path: after.path, version: after.version, raw: after.raw };
  }

  if (initial.status === "unusable" && !allowUpdate) {
    return {
      status: "unavailable",
      action: "skipped",
      path: initial.path,
      version: null,
      raw: initial.raw,
      failureClass: "cli-unusable",
      note: `Found pico-cli at ${initial.path}, but the bounded \`pico-cli -v\` probe failed. Missing-only auto-install was not allowed to replace it; use ${PICO_CLI_AUTOUPDATE_ENV}=1 or ensure_pico_cli {update:true} to consent to repair/update it.`,
    };
  }

  if (!allowUpdate) {
    return { status: "ok", action: "present", path: initial.path, version: initial.version, raw: initial.raw };
  }

  const usableInitial = initial.status === "ok" ? initial : null;

  if (
    initial.status === "ok" && initial.version &&
    successfulUpdateCheck?.installedVersion === initial.version &&
    Date.now() - successfulUpdateCheck.checkedAt < PICO_CLI_UPDATE_CHECK_TTL_MS
  ) {
    return {
      status: "ok",
      action: "present",
      path: initial.path,
      version: initial.version,
      raw: initial.raw,
      latestVersion: successfulUpdateCheck.latestVersion,
    };
  }

  const latestResult = await runPicoCliCommand("npm", ["view", PICO_CLI_PACKAGE, "version", "--json"], {
    timeoutMs: updateCheckTimeoutMs,
    killGraceMs,
  });
  if (latestResult.timedOut || latestResult.code !== 0) {
    const failureClass = classifyPicoCliProvisionFailure(latestResult, "version-check-failed");
    return failedEnsure(
      usableInitial,
      "version-check",
      failureClass,
      `Could not check the latest ${PICO_CLI_PACKAGE} version (${failureClass}); ${usableInitial
        ? "the installed CLI remains available and was not changed."
        : "the found CLI still does not pass -v and was not changed."}`,
      latestResult,
      { previousVersion: initial.version },
    );
  }
  const latestVersion = parseLatestVersion(latestResult.stdout);
  const comparison = initial.status === "ok"
    ? comparePicoCliVersions(initial.version, latestVersion)
    : -1;
  if (!latestVersion || (initial.status === "ok" && comparison === null)) {
    return failedEnsure(
      usableInitial,
      "version-check",
      "version-check-failed",
      `Could not compare installed pico-cli version ${initial.version ?? "(unparsed)"} with npm's ${latestVersion ?? "unparsed response"}; no update was attempted.`,
      latestResult,
      { previousVersion: initial.version, ...(latestVersion ? { latestVersion } : {}) },
    );
  }
  if (initial.status === "ok" && comparison !== null && comparison >= 0) {
    successfulUpdateCheck = { installedVersion: initial.version!, latestVersion, checkedAt: Date.now() };
    return {
      status: "ok",
      action: "present",
      path: initial.path,
      version: initial.version,
      raw: initial.raw,
      latestVersion,
      ...(comparison > 0 ? { note: "Installed pico-cli is newer than the registry version; no downgrade attempted." } : {}),
    };
  }

  const updated = await runPicoCliCommand("npm", ["install", "-g", `${PICO_CLI_PACKAGE}@latest`], {
    timeoutMs: installTimeoutMs,
    killGraceMs,
  });
  if (updated.timedOut || updated.code !== 0) {
    const afterFailure = await probePicoCliBounded(true);
    const usable = afterFailure.status === "ok" ? afterFailure : null;
    const failureClass = classifyPicoCliProvisionFailure(updated);
    return failedEnsure(
      usable,
      "update",
      failureClass,
      `Updating ${PICO_CLI_PACKAGE} failed (${failureClass}); ${usable ? "the installed CLI still passes -v and remains usable." : "pico-cli no longer passes -v."}`,
      updated,
      { previousVersion: initial.version, latestVersion },
    );
  }

  let after = await probePicoCliBounded(true);
  if (after.status !== "ok") {
    await exposeNpmGlobalBin(Math.min(15_000, updateCheckTimeoutMs), killGraceMs);
    after = await probePicoCliBounded(true);
  }
  if (after.status !== "ok") {
    return failedEnsure(
      null,
      "postinstall-probe",
      "postinstall-probe-failed",
      "npm reported a successful update, but the required `pico-cli -v` re-probe failed.",
      updated,
      { previousVersion: initial.version, latestVersion },
    );
  }
  const installedVsLatest = comparePicoCliVersions(after.version, latestVersion);
  if (installedVsLatest === null || installedVsLatest < 0) {
    return failedEnsure(
      after,
      "postinstall-probe",
      "postinstall-probe-failed",
      `npm exited 0, but ${after.path} still reports pico-cli ${after.version ?? "with an unparsed version"}; expected ${latestVersion} or newer. The update was not claimed, and the re-probed CLI remains usable.`,
      updated,
      { previousVersion: initial.version, latestVersion },
    );
  }
  if (after.version) successfulUpdateCheck = { installedVersion: after.version, latestVersion, checkedAt: Date.now() };
  return {
    status: "ok",
    action: "updated",
    path: after.path,
    version: after.version,
    raw: after.raw,
    previousVersion: initial.version,
    latestVersion,
  };
}

/**
 * Lazily make pico-cli ready for a real CLI-backed operation. Imports/registration never call this.
 * Concurrent callers share one bounded npm attempt; failures are not memoized, while the underlying
 * `probePicoCli` continues to memoize only successful `-v` probes.
 */
export function ensurePicoCli(opts: EnsurePicoCliOptions = {}): Promise<PicoCliEnsureResult> {
  if (ensureInFlight) {
    const active = ensureInFlight;
    return active.then((result) => {
      const installConsent = opts.explicit === true || process.env[PICO_CLI_AUTOINSTALL_ENV] === "1";
      const updateConsent = opts.update === true || process.env[PICO_CLI_AUTOUPDATE_ENV] === "1";
      const needsStrongerAttempt =
        (installConsent && result.action === "skipped") ||
        (updateConsent && result.status === "unavailable" && result.failureClass === "cli-unusable") ||
        (updateConsent && result.status === "ok" && result.action === "present" && result.latestVersion === undefined);
      if (!needsStrongerAttempt) return result;
      if (ensureInFlight === active) ensureInFlight = null;
      return ensurePicoCli(opts);
    });
  }
  const pending = ensurePicoCliOnce(opts).catch((error) => failedEnsure(
    null,
    "install",
    "install-failed",
    `Unexpected pico-cli provisioning failure: ${error instanceof Error ? error.message : String(error)}`,
  ));
  ensureInFlight = pending;
  void pending.then(
    () => { if (ensureInFlight === pending) ensureInFlight = null; },
    () => { if (ensureInFlight === pending) ensureInFlight = null; },
  );
  return pending;
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
 * Classify a FAILED pico-cli invocation honestly. Usage dumps / unknown-option complaints mean the
 * wrapped flags no longer match the installed CLI (drift — retrying unchanged cannot help); anything
 * else is a runtime failure whose cause lives in the CLI's own output, not in a guess of ours.
 */
export function classifyPicoCliFailure(stderr: string, stdout: string): "flag-or-version-drift" | "runtime" {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return /unknown option|unknown command|unknown argument|missing required|\busage:/.test(text)
    ? "flag-or-version-drift"
    : "runtime";
}
