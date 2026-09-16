#!/usr/bin/env node
/**
 * plugin-bootstrap — what a host runs instead of the server, so a plugin cache is always the build
 * of the source it currently holds.
 *
 * This used to decide setup from two existence checks — is there a `node_modules/`, is there a
 * `dist/index.js` — which answers "has this ever been built" and not "is this build still the
 * source". A cache whose source or lockfile moved underneath it therefore served stale output
 * forever, across every host restart, with nothing on screen to say so. The decision now runs on
 * the receipts from build-identity.mjs, and the actions on the lease from build-source.mjs.
 *
 * Two shapes arrive here and they are not the same program. A source checkout (the host plugin
 * cache: `src/` plus `tsconfig.json`) can install and compile, so it is made current before the
 * server starts. An installed tarball has neither source nor compiler, so it is only ever checked
 * against the receipt that shipped with it — never installed into, never compiled.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCEPTED_BY,
  RECORDED_SOURCE,
  dependencyIdentity,
  verifyBuild,
  verifyDependencies,
  verifyEmittedOutput,
  writeDependencyReceipt,
} from "./build-identity.mjs";
import { buildSource, runCompiler, withSourceSetup } from "./build-source.mjs";

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_SETUP_WAIT_MS = 30 * 1_000;

/** The one install this bootstrap ever runs, and the token that stands for the in-process build. */
const INSTALL_ARGS = ["ci", "--no-audit", "--no-fund"];
const BUILD_ACTION = ["run", "build"];

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

/**
 * The setup actions a source checkout still needs, in the order they must run.
 *
 * Split on purpose: Claude Code pre-installs deps into the plugin cache (npm ci --ignore-scripts),
 * so the common cold start only needs the tsc build — a full npm ci would push first launch toward
 * the host's MCP startup timeout. Each action is a fresh array, so a caller that edits the plan it
 * was handed cannot rewrite the next caller's.
 */
export function sourceSetupPlan({ dependenciesCurrent, buildCurrent }) {
  const plan = [];
  if (!dependenciesCurrent) plan.push([...INSTALL_ARGS]);
  if (!buildCurrent) plan.push([...BUILD_ACTION]);
  return plan;
}

/** Can anything here actually be compiled? A tarball has `dist/` and `scripts/` and no more. */
export function isSourceCheckout(root) {
  return pathIsDirectory(path.join(root, "src")) && pathIsFile(path.join(root, "tsconfig.json"));
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

/**
 * Install dependencies once, then record what was installed — but only once the lockfile it was
 * installed from is still the lockfile on disk. A receipt written over a lockfile that moved during
 * the install would certify a tree nobody ever installed, and every later start would trust it.
 */
async function installDependencies(root, { platform, env, commandTimeoutMs, killGraceMs, spawnImpl }) {
  const before = dependencyIdentity(root);
  if (before === null) {
    const error = new Error(`no readable package-lock.json in ${root}; there is nothing for npm ci to install from`);
    error.code = "BOOTSTRAP_NO_LOCKFILE";
    throw error;
  }

  const launch = npmLaunch(INSTALL_ARGS, platform, env);
  await requireSuccessfulCommand(launch.command, launch.args, {
    cwd: root,
    env,
    timeoutMs: commandTimeoutMs,
    killGraceMs,
    stdio: ["ignore", 2, 2], // stdout carries MCP protocol frames; npm chatter goes to stderr.
    spawnImpl,
  });

  const after = dependencyIdentity(root);
  if (after !== before) {
    const error = new Error(
      `package-lock.json changed while npm ci was running in ${root}; the install was not recorded and will be retried on the next start`,
    );
    error.code = "BOOTSTRAP_LOCKFILE_RACED";
    throw error;
  }
  writeDependencyReceipt(root, { identity: after, npmArgv: INSTALL_ARGS, source: RECORDED_SOURCE.npmCi });
}

/**
 * Write down an install npm made and we did not, so the next start reads one small receipt instead
 * of comparing two lockfiles again. Best effort on purpose: the evidence that accepted this tree is
 * already good, so failing to record it must never be the reason a server does not start.
 *
 * What the receipt records is npm's evidence, not ours: `source: "hidden-lockfile"`, no `npmArgv`,
 * and the Node major this adoption ran under. The stderr line says the same thing, because a line
 * reading like an install report is how an adopted tree gets mistaken for one this bootstrap laid
 * down and checked. Exported so a test can drive the adoption step on its own.
 */
export function adoptInstalledDependencies(root, verdict) {
  try {
    writeDependencyReceipt(root, { identity: verdict.identity, source: RECORDED_SOURCE.hiddenLockfile });
    process.stderr.write(
      "pico-spatial-mcp bootstrap: dependencies accepted on npm's hidden lockfile "
      + "(provenance recorded as hidden-lockfile; this bootstrap did not perform the install)\n",
    );
  } catch (error) {
    process.stderr.write(
      `pico-spatial-mcp bootstrap: could not record the dependencies npm had already installed (${error.message}); the next start will check them again\n`,
    );
  }
}

const isInstallAction = (args) => args[0] === INSTALL_ARGS[0];
const isBuildAction = (args) => args[0] === BUILD_ACTION[0];

/**
 * Bring a source checkout up to date, doing as little as it truthfully can.
 *
 * The overwhelmingly common start is an unchanged cache, and that path must cost nothing but two
 * digests: no lock file written, no npm, no registry request, no CLI resolution. Only when
 * something is genuinely stale is the setup lease taken — and both identities are then re-read
 * *under* it, because the owner we waited behind may already have done the whole job.
 *
 * A tree accepted on npm's own evidence rather than on a receipt of ours is one step short of that:
 * it takes the lease once to write the receipt down, and is receipt-fast from then on.
 */
async function prepareSourceCheckout(root, options) {
  if (verifyDependencies(root).acceptedBy === ACCEPTED_BY.receipt && verifyBuild(root).current) return;

  await withSourceSetup({ root, waitMs: options.setupWaitMs, clock: options.clock }, async (owner) => {
    let dependencies = verifyDependencies(root);
    if (dependencies.acceptedBy === ACCEPTED_BY.hiddenLockfile) {
      adoptInstalledDependencies(root, dependencies);
      // Read it back: a receipt that does not verify leaves us exactly where we were, which is a
      // tree npm still vouches for — or, if even that has moved since, one we reinstall.
      dependencies = verifyDependencies(root);
    }

    const plan = sourceSetupPlan({
      dependenciesCurrent: dependencies.current,
      buildCurrent: verifyBuild(root).current,
    });

    const installing = plan.some(isInstallAction);
    if (installing) await installDependencies(root, options);

    // `npm ci` rewrites node_modules, and the installed TypeScript version is part of the build
    // identity — so an install can satisfy a build that was planned AND invalidate one that was
    // not. Either way the only honest thing to do afterwards is ask the question again, rather
    // than act on a verdict taken before the tree underneath it changed.
    const mustBuild = installing ? !verifyBuild(root).current : plan.some(isBuildAction);
    // In-process on the lease we already hold. Spawning `npm run build` here would send a second
    // process to queue for the same lock we are standing on, and deadlock until it timed out.
    if (mustBuild) await buildSource({ root, runCompiler: options.runCompilerImpl, owner });
  });
}

/**
 * An installed package can prove only that its payload is the one that shipped. If it is not, the
 * answer is a reinstall: there is no source here to rebuild from and no compiler to rebuild with.
 */
function requireIntactPackagedPayload(root) {
  const verdict = verifyEmittedOutput(root);
  if (verdict.current) return;
  const error = new Error(
    `the installed payload in ${root} does not match the build receipt that shipped with it, so the server was not started: `
    + `${verdict.reasons.join("; ")}. Reinstall pico-spatial-mcp to restore the published files.`,
  );
  error.code = "BOOTSTRAP_PAYLOAD_INVALID";
  throw error;
}

export async function runBootstrap({
  root = resolvePluginRoot(),
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  setupWaitMs = DEFAULT_SETUP_WAIT_MS,
  clock,
  spawnImpl = spawn,
  // The production compiler, bounded by this bootstrap's own command timeout. Its terminate grace
  // is left at build-source's own: that wait is a blocking sleep inside a signal handler.
  runCompilerImpl = (compile) => runCompiler({ ...compile, timeoutMs: commandTimeoutMs, spawn: spawnImpl }),
} = {}) {
  if (isSourceCheckout(root)) {
    await prepareSourceCheckout(root, {
      platform, env, commandTimeoutMs, killGraceMs, setupWaitMs, clock, spawnImpl, runCompilerImpl,
    });
  } else {
    requireIntactPackagedPayload(root);
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
