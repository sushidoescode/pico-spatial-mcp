#!/usr/bin/env node

import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

export function resolvePluginRoot(metaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
}

export function npmExecutable(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function npmLaunch(args, platform = process.platform, env = process.env) {
  const npm = npmExecutable(platform);
  if (platform !== "win32") return { command: npm, args };

  const safeToken = /^[A-Za-z0-9_./:@=+-]+$/u;
  const commandTokens = [npm, ...args];
  if (commandTokens.some((token) => !safeToken.test(token))) {
    throw new Error("refusing an unsafe token in the fixed Windows npm bootstrap command");
  }
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandTokens.join(" ")],
  };
}

export function needsSourceBuild({ nodeModulesPresent, distEntryPresent }) {
  return !(nodeModulesPresent && distEntryPresent);
}

export function sourceSetupPlan(prerequisites) {
  if (!needsSourceBuild(prerequisites)) return [];
  return [
    ["ci", "--no-audit", "--no-fund"],
    ["run", "build"],
  ];
}

export function runBoundedChild(
  command,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    stdio = ["ignore", 2, 2],
    spawnImpl = spawn,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    let timedOut = false;
    let timeout;
    let killTimer;

    const clearTimers = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
    };

    try {
      child = spawnImpl(command, args, { cwd, env, stdio });
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimers();
      if (timedOut) {
        const error = new Error(
          `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
        );
        error.code = "BOOTSTRAP_TIMEOUT";
        error.exitCode = code;
        error.signal = signal;
        reject(error);
        return;
      }
      resolve({ code, signal });
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
  });
}

function pathIsDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function pathIsFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

async function requireSuccessfulCommand(command, args, options) {
  const result = await runBoundedChild(command, args, options);
  if (result.code === 0) return;

  const ending = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
  const error = new Error(`${command} ${args.join(" ")} failed with ${ending}`);
  error.code = "BOOTSTRAP_COMMAND_FAILED";
  error.exitCode = result.code;
  error.signal = result.signal;
  throw error;
}

export function runMcpChild(
  root,
  {
    env = process.env,
    execPath = process.execPath,
    spawnImpl = spawn,
  } = {},
) {
  const entry = path.join(root, "dist", "index.js");

  return new Promise((resolve, reject) => {
    let forwardedSignal;
    let settled = false;
    let child;

    const forward = (signal) => {
      forwardedSignal ??= signal;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    try {
      child = spawnImpl(execPath, [entry], {
        cwd: root,
        env,
        stdio: "inherit",
      });
    } catch (error) {
      reject(error);
      return;
    }

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal, forwardedSignal });
    });
  });
}

export async function runBootstrap({
  root = resolvePluginRoot(),
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  spawnImpl = spawn,
} = {}) {
  const nodeModulesPresent = pathIsDirectory(path.join(root, "node_modules"));
  const distEntryPresent = pathIsFile(path.join(root, "dist", "index.js"));

  const setupPlan = sourceSetupPlan({ nodeModulesPresent, distEntryPresent });
  if (setupPlan.length > 0) {
    for (const args of setupPlan) {
      const launch = npmLaunch(args, platform, env);
      await requireSuccessfulCommand(launch.command, launch.args, {
        cwd: root,
        env,
        timeoutMs: commandTimeoutMs,
        killGraceMs,
        stdio: ["ignore", 2, 2],
        spawnImpl,
      });
    }
  }

  return runMcpChild(root, { env, execPath, spawnImpl });
}

function conventionalSignalExit(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

async function main() {
  try {
    const result = await runBootstrap();
    if (result.forwardedSignal) {
      process.exitCode = conventionalSignalExit(result.forwardedSignal);
    } else if (typeof result.code === "number") {
      process.exitCode = result.code;
    } else {
      process.exitCode = conventionalSignalExit(result.signal);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pico-spatial-mcp bootstrap: ${message}\n`);
    process.exitCode = 1;
  }
}

function sameFile(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

if (process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url))) await main();
