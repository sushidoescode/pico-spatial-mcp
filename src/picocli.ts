import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  externalCliCapabilityIdentity,
  inspectManagedPicoCli,
  managedPicoCliCapabilityIdentity,
  managedPicoCliExecutionHandle,
  readCliCapabilityEvidence,
  resolveManagedPicoCli,
  validateManagedPicoCliExecution,
  type CliCapabilityReport,
  type ManagedPicoCliExecutionHandle,
  type ManagedPicoCliIO,
  type ManagedPicoCliOptions,
  type PicoCliEnsureResult,
} from "./picoclimanaged.js";
import {
  PICO_CLI_ENVIRONMENT_PATTERN,
  PICO_CLI_USAGE_DRIFT_PATTERN,
  PICO_CLI_UTILITIES_GATE_PATTERN,
  resolveOperationCapability,
  unknownCapability,
  type CliOperation,
  type OperationCapability,
} from "./clicapabilities.js";

export {
  PICO_CLI_PACKAGE,
  PICO_CLI_PATH_ENV,
  PICO_CLI_POLICY_ENV,
} from "./picoclimanaged.js";
export type { CliCapabilityReport, ManagedPicoCliOptions, PicoCliEnsureResult } from "./picoclimanaged.js";
export type { CliOperation, OperationCapability } from "./clicapabilities.js";

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
const PICO_CLI_COMPLETION_VALIDATION_TIMEOUT_MS = 15_000;

/**
 * picocli.ts — the ONE shared managed-resolution lane for the official @picoxr/pico-cli binary.
 *
 * Every wrapper (perf_diagnose, perf_trace, watch_crash, capture_record, preflight_env) answers
 * "is pico-cli here, and which one?" through this module so the answer is consistent and cheap.
 *
 * HARD RULE (measured 2026-08-01 on pico-cli 0.3.0): NEVER probe with `pico-cli doctor` or
 * `pico-cli plugin doctor` — both hang (>=90s zero output / 45s timeout). `-v` and
 * `emulator status` return in well under a second; `-v` is the probe here.
 * Re-measured 2026-08-12 on one macOS arm64 machine with a sandboxed 0.4.2 install:
 * `doctor --format json` returned a structured JSON envelope in ~10s, exit 0. That does not
 * establish behavior on other machines or releases. The bounded `-v` probe remains the correct
 * version check because it is sub-second on both measured versions and avoids running doctor.
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

function resolvedCommandIdentity(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  for (const candidate of executableCandidates(command, env, platform)) {
    try {
      const canonical = fs.lstatSync(candidate);
      if (!canonical.isFile() && !canonical.isSymbolicLink()) continue;
      if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
      const realPath = fs.realpathSync(candidate);
      const real = fs.statSync(realPath);
      if (!real.isFile() || real.size < 0 || real.size > 32 * 1024 * 1024) continue;
      const bytes = fs.readFileSync(realPath);
      return createHash("sha256").update(JSON.stringify({
        candidate: path.resolve(candidate),
        canonicalType: canonical.isSymbolicLink() ? "symlink" : "file",
        canonicalMode: canonical.mode & 0o7777,
        canonicalTarget: canonical.isSymbolicLink() ? fs.readlinkSync(candidate) : null,
        realPath,
        realMode: real.mode & 0o7777,
        realSize: real.size,
        realSha256: createHash("sha256").update(bytes).digest("hex"),
      })).digest("hex");
    } catch {
      // Keep walking exactly as cross-platform command lookup does.
    }
  }
  return createHash("sha256").update(JSON.stringify({
    unresolved: command,
    path: envValue(env, "PATH", platform) ?? "",
    pathExt: platform === "win32" ? envValue(env, "PATHEXT", platform) ?? "" : "",
  })).digest("hex");
}

/** Resolve the pico-cli binary on PATH, or null. Kept async for backward compatibility. */
export async function picoCliPath(): Promise<string | null> {
  return resolvePicoCliPath();
}

export type PicoCliProbe =
  | { status: "ok"; path: string; version: string | null; raw: string }
  | { status: "unusable"; path: string; version: null; raw: string }
  | { status: "missing"; path: null; version: null; raw: string };

export type PicoCliExecutionTarget = Extract<PicoCliProbe, { status: "ok" }> & {
  /** Managed targets are guarded by an opaque in-process binding; external is intentionally unbound. */
  source: "managed" | "external";
};

export type PicoCliExecutionGuards = {
  beforeSpawn?: (deadlineMs: number) => string | null;
  afterSpawn?: (deadlineMs: number) => string | null;
  afterCompletion?: (deadlineMs: number) => string | null;
};

const executionTargetHandles = new WeakMap<object, ManagedPicoCliExecutionHandle>();
const executionTargetCapabilities = new WeakMap<object, CliCapabilityReport>();

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
  | "environment"
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

export type PicoCliArtifactInspection = {
  /** null means the stat itself failed for a reason other than a definite missing path. */
  exists: boolean | null;
  regularFile: boolean;
  bytes: number | null;
  statError?: string;
};

/** One point-in-time, non-throwing artifact check shared by exit-zero CLI wrappers. */
export function inspectPicoCliArtifact(artifactPath: string): PicoCliArtifactInspection {
  try {
    const stat = fs.statSync(artifactPath);
    return {
      exists: true,
      regularFile: stat.isFile(),
      bytes: stat.size,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { exists: false, regularFile: false, bytes: null };
    }
    return {
      exists: null,
      regularFile: false,
      bytes: null,
      statError: error instanceof Error ? error.message : String(error),
    };
  }
}

export type PicoCliRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Internal exact environment baseline; `env` remains the per-command override layer. */
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  /**
   * Internal cooperative bound for the post-completion managed-store validation. It is capped at
   * 15 seconds and starts only after the command/process-tree cleanup has completed, so an
   * intentional command timeout cannot consume the validation's budget.
   */
  completionValidationTimeoutMs?: number;
  /**
   * Internal managed-store guards. They run synchronously adjacent to process creation and must
   * cooperate with the supplied deadline; JavaScript cannot interrupt a blocked synchronous call.
   * A post-spawn failure is detection/termination, not proof that the child had no side effects.
   */
  beforeSpawn?: (deadlineMs: number) => string | null;
  afterSpawn?: (deadlineMs: number) => string | null;
  afterCompletion?: (deadlineMs: number) => string | null;
};

type PicoCliTreeKiller = {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal: NodeJS.Signals): unknown;
  unref(): unknown;
};

export type PicoCliProcessTreeRuntime = {
  platform: NodeJS.Platform;
  spawnTreeKiller: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: "ignore"; windowsHide: true },
  ) => PicoCliTreeKiller;
};

const defaultPicoCliProcessTreeRuntime: PicoCliProcessTreeRuntime = {
  platform: process.platform,
  spawnTreeKiller: (command, args, options) => crossSpawn(command, args, options),
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
 * Run a child with captured, capped output and bounded cleanup once synchronous internal
 * validation returns. All children receive the complete server environment plus explicit
 * overrides. On timeout, kill the process group on POSIX or the process tree on Windows, then
 * settle even if a grandchild inherited stdio. Pre/post-spawn validation shares the command
 * deadline. Post-completion validation gets its own bounded window after ordinary completion or
 * cleanup, because an intentional duration timeout must not consume the guard's entire budget.
 * Node cannot preempt a blocked synchronous callback; every guard must cooperate with its deadline.
 */
function runPicoCliCommandWithRuntime(
  command: string,
  args: string[],
  opts: PicoCliRunOptions = {},
  processTreeRuntime: PicoCliProcessTreeRuntime = defaultPicoCliProcessTreeRuntime,
): Promise<PicoCliCommandResult> {
  const timeoutMs = opts.timeoutMs ?? PICO_CLI_INSTALL_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? PICO_CLI_KILL_GRACE_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? PICO_CLI_OUTPUT_CAP_BYTES;
  const childEnv = { ...(opts.baseEnv ?? process.env), ...opts.env };
  const platform = processTreeRuntime.platform;
  const commandDeadlineMs = Date.now() + Math.max(0, timeoutMs);
  const requestedCompletionValidationTimeoutMs = opts.completionValidationTimeoutMs
    ?? PICO_CLI_COMPLETION_VALIDATION_TIMEOUT_MS;
  const completionValidationTimeoutMs = Number.isFinite(requestedCompletionValidationTimeoutMs)
    ? Math.max(1, Math.min(
        PICO_CLI_COMPLETION_VALIDATION_TIMEOUT_MS,
        Math.trunc(requestedCompletionValidationTimeoutMs),
      ))
    : PICO_CLI_COMPLETION_VALIDATION_TIMEOUT_MS;

  const synchronousSpawnCheck = (
    check: ((deadlineMs: number) => string | null) | undefined,
    phase: "pre-spawn" | "post-spawn" | "post-completion",
    deadlineMs = commandDeadlineMs,
  ): { failure: string | null; exhausted: boolean } => {
    if (!check) return { failure: null, exhausted: Date.now() >= deadlineMs };
    try {
      const failure = check(deadlineMs);
      const exhausted = Date.now() >= deadlineMs;
      return {
        failure: failure
          ? `${phase} validation failed: ${failure}`
          : exhausted
            ? phase === "pre-spawn"
              ? "pre-spawn validation exhausted the command timeout before process creation"
              : phase === "post-spawn"
                ? "post-spawn validation exhausted the command timeout after process creation, before validation could settle"
                : "post-completion validation exhausted its validation deadline after process completion"
            : null,
        exhausted,
      };
    } catch (error) {
      return {
        failure: `${phase} validation failed: ${error instanceof Error ? error.message : String(error)}`,
        exhausted: Date.now() >= deadlineMs,
      };
    }
  };

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
    let treeKiller: PicoCliTreeKiller | undefined;
    let spawnValidationFailure: string | null = null;
    let completionValidationRan = false;

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

    const runCompletionValidation = (): string | null => {
      if (completionValidationRan) return null;
      completionValidationRan = true;
      if (!opts.afterCompletion) return null;
      const validationDeadlineMs = Date.now() + completionValidationTimeoutMs;
      const completed = synchronousSpawnCheck(
        opts.afterCompletion,
        "post-completion",
        validationDeadlineMs,
      );
      return completed.failure;
    };

    const settleTreeCleanup = (cleanupFailure?: string) => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      treeKiller?.unref();
      const completionFailure = runCompletionValidation();
      const failure = cleanupFailure ?? completionFailure ?? undefined;
      finish(
        failure ? null : observedCode ?? child.exitCode,
        observedSignal ?? child.signalCode,
        failure,
      );
    };

    const beginTreeCleanup = (cleanupFailure?: string) => {
      if (timeoutCleanupPending) return;
      timeoutCleanupPending = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (platform === "win32") {
        if (!child.pid) {
          kill("SIGKILL");
          hardTimer = setTimeout(() => settleTreeCleanup(cleanupFailure), 250);
          return;
        }

        // `.cmd` shims normally own a Node grandchild. Walk the tree before touching cmd.exe so
        // validation rejection and ordinary timeout cannot orphan that payload.
        const systemRoot = envValue(childEnv, "SystemRoot", "win32") ?? "C:\\Windows";
        const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
        try {
          treeKiller = processTreeRuntime.spawnTreeKiller(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
            env: childEnv,
            stdio: "ignore",
            windowsHide: true,
          });
          treeKiller.once("error", () => {
            kill("SIGKILL");
          });
          treeKiller.once("close", (code) => {
            if (code !== 0) kill("SIGKILL");
            settleTreeCleanup(cleanupFailure);
          });
        } catch {
          kill("SIGKILL");
        }
        hardTimer = setTimeout(() => {
          try { treeKiller?.kill("SIGKILL"); } catch { /* already exited */ }
          kill("SIGKILL");
          settleTreeCleanup(cleanupFailure);
        }, Math.max(killGraceMs, 1_000) + 250);
        return;
      }

      kill("SIGTERM");
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        hardTimer = setTimeout(() => settleTreeCleanup(cleanupFailure), 250);
      }, killGraceMs);
    };

    const beforeSpawn = synchronousSpawnCheck(opts.beforeSpawn, "pre-spawn");
    spawnValidationFailure = beforeSpawn.failure;
    timedOut ||= beforeSpawn.exhausted;
    if (spawnValidationFailure) {
      finish(null, null, spawnValidationFailure);
      return;
    }

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
      if (spawnValidationFailure) {
        finish(null, null, spawnValidationFailure);
        return;
      }
      finish(null, null, error.message);
    });
    child.once("close", (code, signal) => {
      observedCode = code;
      observedSignal = signal;
      // Cleanup owns settlement even if the `.cmd` parent or POSIX group leader closes first.
      if (timeoutCleanupPending) return;
      if (spawnValidationFailure) {
        finish(null, signal, spawnValidationFailure);
        return;
      }
      // Once a timeout begins, do not let a `.cmd` parent (or POSIX group leader) closing early
      // cancel process-tree cleanup. The cleanup path owns settlement from this point onward.
      const completionFailure = runCompletionValidation();
      if (completionFailure) {
        spawnValidationFailure = completionFailure;
        beginTreeCleanup(completionFailure);
        return;
      }
      finish(code, signal);
    });

    const afterSpawn = synchronousSpawnCheck(opts.afterSpawn, "post-spawn");
    spawnValidationFailure = afterSpawn.failure;
    timedOut ||= afterSpawn.exhausted;
    if (spawnValidationFailure) {
      beginTreeCleanup(spawnValidationFailure);
      return;
    }

    timeout = setTimeout(() => {
      timedOut = true;
      beginTreeCleanup();
    }, Math.max(0, commandDeadlineMs - Date.now()));
  });
}

export function runPicoCliCommand(
  command: string,
  args: string[],
  opts: PicoCliRunOptions = {},
): Promise<PicoCliCommandResult> {
  return runPicoCliCommandWithRuntime(command, args, opts, defaultPicoCliProcessTreeRuntime);
}

/** Structural cross-platform seam. It exercises the production cleanup state machine without
 * claiming that the supplied platform ran natively on this host. */
export function runPicoCliCommandWithProcessTreeForFixture(
  command: string,
  args: string[],
  opts: PicoCliRunOptions,
  processTreeRuntime: PicoCliProcessTreeRuntime,
): Promise<PicoCliCommandResult> {
  return runPicoCliCommandWithRuntime(command, args, opts, processTreeRuntime);
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

export function picoCliExecutionGuards(cli: PicoCliExecutionTarget): PicoCliExecutionGuards {
  if (cli.source === "external") return {};
  const handle = executionTargetHandles.get(cli);
  const validate = handle
    ? (deadlineMs: number) => validateManagedPicoCliExecution(handle, deadlineMs)
    : () => "managed pico-cli execution target lost its opaque publication identity";
  return { beforeSpawn: validate, afterSpawn: validate, afterCompletion: validate };
}

function chainExecutionGuards(
  first: ((deadlineMs: number) => string | null) | undefined,
  second: ((deadlineMs: number) => string | null) | undefined,
): ((deadlineMs: number) => string | null) | undefined {
  if (!first) return second;
  if (!second) return first;
  return (deadlineMs) => first(deadlineMs) ?? second(deadlineMs);
}

export function runPicoCli(
  cli: PicoCliExecutionTarget,
  args: string[],
  opts: PicoCliRunOptions = {},
): Promise<PicoCliCommandResult> {
  const guards = picoCliExecutionGuards(cli);
  return runPicoCliCommand(cli.path, args, {
    ...opts,
    beforeSpawn: chainExecutionGuards(guards.beforeSpawn, opts.beforeSpawn),
    afterSpawn: chainExecutionGuards(guards.afterSpawn, opts.afterSpawn),
    afterCompletion: chainExecutionGuards(guards.afterCompletion, opts.afterCompletion),
  });
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

export function picoCliFromEnsure(result: PicoCliEnsureResult): PicoCliExecutionTarget | null {
  if (result.status !== "ok") return null;
  const target: PicoCliExecutionTarget = {
    status: "ok",
    source: result.source,
    path: result.path,
    version: result.version,
    raw: result.raw,
  };
  if (result.source === "managed") {
    const handle = managedPicoCliExecutionHandle(result);
    if (!handle) return null;
    executionTargetHandles.set(target, handle);
  }
  if (result.capabilities) executionTargetCapabilities.set(target, result.capabilities);
  return target;
}

/**
 * Per-operation availability for an execution target. The bound report is honored only when the
 * target's freshly derived identity matches the report's entire identity and the operation's
 * evidence bytes still verify; anything else is `unknown` with the exact reason, so a wrapper can
 * refuse dispatch or ask for fresh bounded discovery (ensure_pico_cli).
 */
export function picoCliOperationCapability(cli: PicoCliExecutionTarget, operation: CliOperation): OperationCapability {
  const report = executionTargetCapabilities.get(cli) ?? null;
  const handle = cli.source === "managed" ? executionTargetHandles.get(cli) : undefined;
  const identity = cli.source === "managed"
    ? (handle ? managedPicoCliCapabilityIdentity(handle) : null)
    : externalCliCapabilityIdentity(cli.path, cli.version ?? "");
  if (!identity) {
    return unknownCapability(operation, "stale-identity: the execution target's package identity could not be derived; request fresh bounded discovery (ensure_pico_cli)");
  }
  return resolveOperationCapability({ set: report, target: identity, operation, readEvidence: readCliCapabilityEvidence });
}

function managedHomeFromSnapshot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const profile = envValue(env, "USERPROFILE", platform);
    if (profile) return profile;
    const drive = envValue(env, "HOMEDRIVE", platform);
    const homePath = envValue(env, "HOMEPATH", platform);
    if (drive && homePath) return path.win32.join(drive, homePath);
  } else {
    const home = envValue(env, "HOME", platform);
    if (home) return home;
  }
  return os.homedir();
}

function managedIoSnapshot(): ManagedPicoCliIO {
  const env = { ...process.env };
  const platform = process.platform;
  return {
    env,
    platform,
    homeDir: managedHomeFromSnapshot(env, platform),
    npmCommandIdentity: resolvedCommandIdentity("npm", env, platform),
    now: () => Date.now(),
    randomUUID,
    run: (command, args, options) => runPicoCliCommand(command, args, { ...options, baseEnv: env }),
  };
}

type CompatibleManagedOptions = ManagedPicoCliOptions & {
  /** Deprecated 37.x inputs accepted but intentionally inert. */
  explicit?: boolean;
  update?: boolean;
};

type ResolvedManagedOptions = ManagedPicoCliOptions & { managedRoot: string };

type EnsureFlight = { forceRefresh: boolean; promise: Promise<PicoCliEnsureResult> };
const ensureFlights = new Map<string, EnsureFlight>();

function resolvedManagedOptions(
  options: CompatibleManagedOptions,
  io: ManagedPicoCliIO,
): ResolvedManagedOptions {
  return {
    managedRoot: path.resolve(options.managedRoot ?? path.join(io.homeDir, ".pico-mcp", "cli")),
    ...(options.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}),
    ...(options.installTimeoutMs !== undefined ? { installTimeoutMs: options.installTimeoutMs } : {}),
    ...(options.updateCheckTimeoutMs !== undefined ? { updateCheckTimeoutMs: options.updateCheckTimeoutMs } : {}),
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
  };
}

function managedEnvironmentDigest(env: NodeJS.ProcessEnv): string {
  const entries = Object.entries(env).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

function ensureOptionsKey(options: ResolvedManagedOptions, io: ManagedPicoCliIO): string {
  return JSON.stringify([
    options.managedRoot,
    options.installTimeoutMs ?? null,
    options.updateCheckTimeoutMs ?? null,
    options.killGraceMs ?? null,
    managedEnvironmentDigest(io.env),
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

function ensurePicoCliWithSnapshot(
  normalized: ResolvedManagedOptions,
  io: ManagedPicoCliIO,
): Promise<PicoCliEnsureResult> {
  const key = ensureOptionsKey(normalized, io);
  const active = ensureFlights.get(key);
  if (active) {
    if (active.forceRefresh || !normalized.forceRefresh) return active.promise;
    return active.promise.then(() => ensurePicoCliWithSnapshot({ ...normalized, forceRefresh: true }, io));
  }
  const pending = resolveManagedPicoCli(normalized, io).catch(unexpectedManagedFailure);
  ensureFlights.set(key, { forceRefresh: normalized.forceRefresh === true, promise: pending });
  void pending.finally(() => {
    if (ensureFlights.get(key)?.promise === pending) ensureFlights.delete(key);
  });
  return pending;
}

/** Lazy managed resolution. Registration/startup never calls this. */
export function ensurePicoCli(options: CompatibleManagedOptions = {}): Promise<PicoCliEnsureResult> {
  const io = managedIoSnapshot();
  return ensurePicoCliWithSnapshot(resolvedManagedOptions(options, io), io);
}

export function inspectPicoCliCached(options: ManagedPicoCliOptions = {}): Promise<PicoCliEnsureResult> {
  const io = managedIoSnapshot();
  return inspectManagedPicoCli(resolvedManagedOptions(options, io), io).catch(unexpectedManagedFailure);
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
 * refusal is the utilities gate (measured 2026-08-12 on 0.4.2; retained 2026-09-15 as 0.4.4
 * invocation 012 exit 1 and 0.5.0 invocations 137-141 exit 3): a provisioning gap with an exact
 * user-run remedy, not drift and not a device problem. "PICO_HOME is not set" / "must be an
 * absolute path" (0.5.0 profiler resolution, source-inspected PERF_ENV050) is an environment
 * problem: the CLI read its environment before locating any payload, so provisioning is not
 * assumed to be its fix. Usage dumps, unknown-option complaints and the 0.5.0 router's
 * "Unknown perf subcommand" mean the wrapped argv no longer matches the installed CLI (drift —
 * retrying unchanged cannot help); anything else is a runtime failure whose cause lives in the
 * CLI's own output, not in a guess of ours.
 */
export function classifyPicoCliFailure(
  stderr: string,
  stdout: string,
): "flag-or-version-drift" | "setup-required" | "environment" | "runtime" {
  const text = `${stderr}\n${stdout}`;
  if (PICO_CLI_UTILITIES_GATE_PATTERN.test(text)) return "setup-required";
  if (PICO_CLI_ENVIRONMENT_PATTERN.test(text)) return "environment";
  return PICO_CLI_USAGE_DRIFT_PATTERN.test(text) ? "flag-or-version-drift" : "runtime";
}

/**
 * Exact guidance for an `environment` failure, or null when the output shows no such condition.
 * It names the variable the CLI read and what it must contain; it never prescribes running
 * setup, because an unset environment root is not evidence that the payload is absent.
 */
export function describePicoCliEnvironmentFailure(stderr: string, stdout: string): string | null {
  const text = `${stderr}\n${stdout}`;
  if (!PICO_CLI_ENVIRONMENT_PATTERN.test(text)) return null;
  return "pico-cli read PICO_HOME before locating its profiler payload and found it unset or not absolute. "
    + "Set PICO_HOME to the absolute PICO SDK root for the MCP server process (the root validate_toolchain resolves), "
    + "restart the MCP server, and retry. This server never sets PICO_HOME implicitly; whether the profiler payload "
    + "itself is provisioned is a separate question answered by the CLI's own utilities message, not by this classification.";
}
