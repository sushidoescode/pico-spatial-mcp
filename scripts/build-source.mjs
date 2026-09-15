#!/usr/bin/env node
/**
 * build-source — compile `src/` into a staging directory and publish it as `dist/` only if the
 * compilation succeeded and the source never moved underneath it.
 *
 * `tsc` writes straight into `dist/` and never cleans it, so a failed run can leave a half-written
 * tree that still looks like output, and a deleted source leaves its stale `.js` behind forever.
 * Compiling into a sibling and renaming makes the published tree all-or-nothing, and the receipt
 * written next to it (see build-identity.mjs) lets anyone ask whether it still matches the source.
 *
 * Everything human goes to stderr: `npm run build` runs during MCP host bootstrap, where stdout
 * carries protocol frames.
 */
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RECEIPT_NAME, inputIdentity, writeReceipt } from "./build-identity.mjs";

export const LOCK_NAME = ".pico-source-setup.lock";
export const STAGING_PREFIX = ".dist-staging-";
export const BACKUP_PREFIX = ".dist-backup-";
const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 50;
const COMPILE_TIMEOUT_MS = 10 * 60 * 1000;

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"];

/**
 * Active leases, keyed by the lease object itself: a caller cannot forge one, only hold one. The
 * value is the scratch this process currently owns, which is what an interrupt has to clean up.
 */
const ACTIVE_LEASES = new Map();

const defaultClock = {
  now: () => performance.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const log = (message) => process.stderr.write(`${message}\n`);

function scratchName(prefix) {
  return `${prefix}${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Throw unless `target` is exactly a `<prefix><random>` scratch path directly inside `root`. Every
 * destructive step goes through this, so a build can only ever delete scratch it created itself.
 */
export function assertOwnedScratch(root, target, prefix) {
  const base = path.basename(target);
  if (path.dirname(target) !== root || !base.startsWith(prefix) || base.length === prefix.length) {
    throw new Error(`${target} is not a ${prefix}* path owned by ${root}`);
  }
}

function removeOwnedScratch(root, target, prefix) {
  assertOwnedScratch(root, target, prefix);
  fs.rmSync(target, { recursive: true, force: true });
}

function readOwnerRecord(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { return null; }
}

/** true / false / null when the platform will not say. EPERM means it exists but is not ours. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return null;
  }
}

/** Drop this process's own lock, and only ever this process's own lock. */
function releaseLock({ lockPath, token }) {
  if (readOwnerRecord(lockPath)?.token !== token) return;
  try { fs.rmSync(lockPath, { force: true }); } catch {}
}

/**
 * Remove scratch that an earlier, interrupted build left behind.
 *
 * Deleting other builds' directories is only safe because this runs while we hold the setup lock:
 * holding it proves no other build owns scratch in this root right now. Names are matched against
 * the same `<prefix><random>` shape every removal uses, and `readdirSync` on the root means nothing
 * outside it is ever a candidate.
 */
export function sweepStaleScratch(root) {
  const swept = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return swept; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const prefix = entry.name.startsWith(STAGING_PREFIX) ? STAGING_PREFIX
      : entry.name.startsWith(BACKUP_PREFIX) ? BACKUP_PREFIX
      : null;
    if (!prefix || entry.name.length === prefix.length) continue;
    try {
      removeOwnedScratch(root, path.join(root, entry.name), prefix);
      swept.push(entry.name);
    } catch {}
  }
  return swept;
}

/**
 * Say whether the recorded holder is still running. A dead pid is never grounds for taking the lock
 * — the waiter cannot know the file is not about to be rewritten — but it is exactly what the
 * person reading the failure needs, so the message names it and hands over the recovery command.
 */
function lockTimeoutError(lockPath, waitMs) {
  const holder = readOwnerRecord(lockPath);
  const alive = holder ? pidAlive(holder.pid) : null;
  const who = holder?.pid ? ` (pid ${holder.pid}${alive === false ? ", which is no longer running" : ""})` : "";
  const remedy = alive === false
    ? `That build did not finish. Remove the stale lock: ${removeCommand(lockPath)}`
    : "Wait for it to finish, or remove the lock only if that process is gone.";
  return new Error(`another build is holding ${lockPath}${who}; waited ${waitMs}ms. ${remedy}`);
}

function removeCommand(target) {
  return process.platform === "win32" ? `del "${target}"` : `rm ${target}`;
}

const interruptListener = (signal) => handleInterrupt(signal);
let interruptArmed = false;

/** Stand down, then re-raise: with no listener left the signal takes its default course. */
function raiseDefaultSignal(signal) {
  for (const name of INTERRUPT_SIGNALS) process.removeListener(name, interruptListener);
  interruptArmed = false;
  process.kill(process.pid, signal);
}

/**
 * Ctrl-C during a build: `finally` blocks never run, so without this a killed build leaves its lock
 * and a full copy of the emitted tree behind, and every later build waits out the full deadline
 * against a pid that is already gone. Release what this process owns, then let the signal take its
 * normal course so `npm` still sees the interruption (exit 128+signal) rather than a clean exit.
 */
export function handleInterrupt(signal, { raise = raiseDefaultSignal } = {}) {
  for (const record of [...ACTIVE_LEASES.values()]) {
    if (record.staging) {
      try { removeOwnedScratch(record.checkout, record.staging, STAGING_PREFIX); } catch {}
      record.staging = null;
    }
    releaseLock(record);
  }
  raise(signal);
}

function armInterruptCleanup() {
  if (interruptArmed) return;
  interruptArmed = true;
  for (const name of INTERRUPT_SIGNALS) process.once(name, interruptListener);
}

function disarmInterruptCleanup() {
  if (!interruptArmed || ACTIVE_LEASES.size > 0) return;
  interruptArmed = false;
  for (const name of INTERRUPT_SIGNALS) process.removeListener(name, interruptListener);
}

/**
 * Hold the source-setup lock for `root` while `work(lease)` runs.
 *
 * A caller already holding the lease passes it back as `owner` and the nested call reuses it; any
 * other value — a string, a plain object, a retired lease, a lease for another checkout — is
 * rejected rather than silently treated as ownership. An independent writer polls for at most
 * `waitMs` and then fails; it never deletes a lock it does not own.
 */
export async function withSourceSetup({ root, owner, waitMs = DEFAULT_WAIT_MS, clock = defaultClock }, work) {
  const checkout = fs.realpathSync(path.resolve(root));

  if (owner !== undefined) {
    if (typeof owner !== "object" || owner === null || ACTIVE_LEASES.get(owner)?.checkout !== checkout) {
      throw new Error(`the supplied owner is not an active source-setup lease for ${checkout}`);
    }
    return work(owner);
  }

  const lockPath = path.join(checkout, LOCK_NAME);
  const token = crypto.randomBytes(16).toString("hex");
  const record = `${JSON.stringify({ pid: process.pid, token })}\n`;
  const deadline = clock.now() + waitMs;

  for (;;) {
    try {
      fs.writeFileSync(lockPath, record, { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const remaining = deadline - clock.now();
      if (remaining <= 0) throw lockTimeoutError(lockPath, waitMs);
      await clock.wait(Math.min(POLL_MS, remaining));
    }
  }

  const lease = Object.freeze({ kind: "pico-source-setup-owner" });
  const held = { checkout, lockPath, token, staging: null };
  ACTIVE_LEASES.set(lease, held);
  armInterruptCleanup();
  try {
    return await work(lease);
  } finally {
    ACTIVE_LEASES.delete(lease);
    disarmInterruptCleanup();
    // Only ever release our own lock: a lock we lost is someone else's to clear.
    releaseLock(held);
  }
}

/**
 * Run the checkout's own TypeScript, as a child of this exact Node binary, emitting into `outDir`.
 * Resolves only on exit 0; compiler diagnostics are forwarded to stderr.
 */
export function runCompiler({ root, outDir, timeoutMs = COMPILE_TIMEOUT_MS, spawn = childProcess.spawn }) {
  const checkout = path.resolve(root);
  const tscEntry = path.join(checkout, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tscEntry)) {
    return Promise.reject(new Error(`no typescript compiler at ${tscEntry}; run npm ci in ${checkout} first`));
  }

  const args = [tscEntry, "-p", path.join(checkout, "tsconfig.json"), "--outDir", outDir];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: checkout, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error(`the TypeScript compiler did not finish within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`the TypeScript compiler exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

/**
 * Swap `staging` in as `dist`, keeping the previous tree under a backup name until the swap has
 * actually landed. A failed swap puts the previous tree back; if even that fails the backup is
 * kept and named in the error, because a build must never be the reason output disappears.
 */
export function publishStaging(root, staging) {
  assertOwnedScratch(root, staging, STAGING_PREFIX);
  const distDir = path.join(root, "dist");
  const backup = path.join(root, scratchName(BACKUP_PREFIX));
  let backedUp = false;

  if (fs.existsSync(distDir)) {
    fs.renameSync(distDir, backup);
    backedUp = true;
  }
  try {
    fs.renameSync(staging, distDir);
  } catch (error) {
    if (backedUp) {
      try { fs.renameSync(backup, distDir); backedUp = false; } catch {}
    }
    if (backedUp) {
      throw new Error(`${error.message}; the previous dist/ is preserved as ${path.basename(backup)} and must be renamed back by hand`);
    }
    throw error;
  }
  if (backedUp) removeOwnedScratch(root, backup, BACKUP_PREFIX);
}

/**
 * Compile `root` and publish the result, binding the emitted bytes to the source identity that
 * produced them. Rejects — leaving the previous `dist/` untouched — if compilation fails or if the
 * source changed while the compiler was running.
 */
export async function buildSource({ root, runCompiler: compile = runCompiler, owner }) {
  return withSourceSetup({ root, owner }, async (lease) => {
    const checkout = fs.realpathSync(path.resolve(root));
    const recovered = sweepStaleScratch(checkout);
    if (recovered.length) log(`build-source: recovered scratch from an interrupted build: ${recovered.join(", ")}`);

    const held = ACTIVE_LEASES.get(lease);
    const staging = path.join(checkout, scratchName(STAGING_PREFIX));
    const before = inputIdentity(checkout);
    held.staging = staging;
    try {
      fs.mkdirSync(staging, { recursive: true });
      await compile({ root: checkout, outDir: staging });

      const after = inputIdentity(checkout);
      if (after.sha256 !== before.sha256) {
        throw new Error("the source changed during compilation; the output was discarded rather than published");
      }
      writeReceipt(checkout, staging, after);
      publishStaging(checkout, staging);
    } finally {
      held.staging = null;
      // Cleanup is best-effort reporting: it must never mask the failure that brought us here.
      try {
        if (fs.existsSync(staging)) removeOwnedScratch(checkout, staging, STAGING_PREFIX);
      } catch (cleanupError) {
        log(`build-source: could not remove ${path.basename(staging)}: ${cleanupError.message}`);
      }
    }
  });
}

export async function buildSourceCli(root) {
  await buildSource({ root });
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "dist", RECEIPT_NAME), "utf8"));
  log(`build-source: published ${receipt.output.files.length} file(s) for source ${receipt.input.sha256.slice(0, 12)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  buildSourceCli(repoRoot).catch((error) => {
    log(`build-source: ${error.message}`);
    process.exitCode = 1;
  });
}
