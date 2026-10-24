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
const TERMINATE_GRACE_MS = 200;

/** Blocking sleeps live on their own word, as in src/runlocks.ts. */
const SYNC_WAIT_WORD = new Int32Array(new SharedArrayBuffer(4));

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

/** Is this exact path scratch that some build in this process is using right now? */
function isLiveScratch(target) {
  for (const record of ACTIVE_LEASES.values()) if (record.live.has(target)) return true;
  return false;
}

/**
 * Remove scratch that an earlier, interrupted build left behind.
 *
 * Deleting directories this build did not create is safe on two conditions, and it needs both.
 * Holding the setup lock rules out another *process* owning scratch here. It does not rule out
 * another build in *this* process: a caller may share one lease across several `buildSource`
 * calls, so a sibling's staging tree can be on disk and in use. Anything a live lease has
 * recorded is therefore skipped. Beyond that, names must match the `<prefix><random>` shape every
 * removal uses, and `readdirSync` on the root means nothing outside it is ever a candidate.
 */
export function sweepStaleScratch(root) {
  const checkout = path.resolve(root);
  const swept = [];
  let entries;
  try { entries = fs.readdirSync(checkout, { withFileTypes: true }); } catch { return swept; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const prefix = entry.name.startsWith(STAGING_PREFIX) ? STAGING_PREFIX
      : entry.name.startsWith(BACKUP_PREFIX) ? BACKUP_PREFIX
      : null;
    if (!prefix || entry.name.length === prefix.length) continue;
    const target = path.join(checkout, entry.name);
    if (isLiveScratch(target)) continue;
    try {
      removeOwnedScratch(checkout, target, prefix);
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
    // Stop the compiler FIRST. Deleting the staging tree out from under a process that is still
    // writing into it just means the process re-creates it after we are gone.
    record.abort?.abort();
    // Every in-flight staging tree, not just the newest: one lease can have several.
    for (const target of [...record.live]) {
      if (!path.basename(target).startsWith(STAGING_PREFIX)) continue;
      try { removeOwnedScratch(record.checkout, target, STAGING_PREFIX); } catch {}
      record.live.delete(target);
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
  const held = { checkout, lockPath, token, live: new Set(), chain: Promise.resolve(), abort: null };
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
export function runCompiler({
  root,
  outDir,
  signal,
  timeoutMs = COMPILE_TIMEOUT_MS,
  terminateGraceMs = TERMINATE_GRACE_MS,
  tscEntry,
  spawn = childProcess.spawn,
}) {
  const checkout = path.resolve(root);
  const compilerEntry = tscEntry ?? path.join(checkout, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(compilerEntry)) {
    return Promise.reject(new Error(`no typescript compiler at ${compilerEntry}; run npm ci in ${checkout} first`));
  }
  if (signal?.aborted) return Promise.reject(interruptedError());

  const args = [compilerEntry, "-p", path.join(checkout, "tsconfig.json"), "--outDir", outDir];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: checkout, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      stopChildSync(child, terminateGraceMs);
      finish(new Error(`the TypeScript compiler did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    function onAbort() {
      stopChildSync(child, terminateGraceMs);
      finish(interruptedError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal_) => {
      if (code === 0) finish();
      else finish(new Error(`the TypeScript compiler exited with ${signal_ ? `signal ${signal_}` : `code ${code}`}`));
    });
  });
}

function interruptedError() {
  return new Error("the build was interrupted; the TypeScript compiler was stopped");
}

/**
 * Stop the compiler, synchronously, before the caller deletes the tree it is writing into.
 *
 * Synchronous on purpose: this runs from a signal handler that re-raises immediately afterwards,
 * so an awaited exit would never get a turn on the event loop. Polling for the pid to disappear
 * would not work either — a killed child stays a zombie until libuv reaps it, and libuv needs the
 * very event loop this is blocking. So the guarantee comes from the kernel rather than a poll:
 * SIGTERM for a courtesy grace, then SIGKILL, which cannot be caught, blocked or ignored. Once it
 * is delivered the compiler runs no further instructions and cannot re-create the staging tree.
 */
function stopChildSync(child, graceMs = TERMINATE_GRACE_MS) {
  if (!child?.pid) return;
  try { child.kill("SIGTERM"); } catch {}
  if (graceMs > 0) Atomics.wait(SYNC_WAIT_WORD, 0, 0, graceMs);
  try { child.kill("SIGKILL"); } catch {}
}

/**
 * Swap `staging` in as `dist`, keeping the previous tree under a backup name until the swap has
 * actually landed. A failed swap puts the previous tree back; if even that fails the backup is
 * kept and named in the error, because a build must never be the reason output disappears.
 */
export function publishStaging(root, staging, live = null) {
  assertOwnedScratch(root, staging, STAGING_PREFIX);
  const distDir = path.join(root, "dist");
  const backup = path.join(root, scratchName(BACKUP_PREFIX));
  let backedUp = false;

  // The swap is deliberately synchronous, so no sibling build can observe the backup mid-flight.
  // It is still recorded as live, so the invariant survives anyone making this async later.
  live?.add(backup);
  try {
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
  } finally {
    live?.delete(backup);
  }
}

/**
 * Compile `root` and publish the result, binding the emitted bytes to the source identity that
 * produced them. Rejects — leaving the previous `dist/` untouched — if compilation fails or if the
 * source changed while the compiler was running.
 */
export async function buildSource({ root, runCompiler: compile = runCompiler, owner }) {
  return withSourceSetup({ root, owner }, (lease) => {
    const held = ACTIVE_LEASES.get(lease);
    return serializeUnderLease(held, () => compileAndPublish(held, compile));
  });
}

/**
 * Builds sharing one lease run one at a time. Without this a second concurrent call's synchronous
 * prefix lands while the first is awaiting its compiler, and the two interleave over one `dist/`.
 * Sequential and nested reuse are unaffected: they simply find an already-settled queue.
 */
function serializeUnderLease(held, work) {
  const run = held.chain.then(work);
  held.chain = run.then(() => {}, () => {}); // a failed build must not poison the queue behind it
  return run;
}

async function compileAndPublish(held, compile) {
  const { checkout, live } = held;
  const recovered = sweepStaleScratch(checkout);
  if (recovered.length) log(`build-source: recovered scratch from an interrupted build: ${recovered.join(", ")}`);

  const staging = path.join(checkout, scratchName(STAGING_PREFIX));
  const before = inputIdentity(checkout);
  const abort = new AbortController();
  live.add(staging);
  held.abort = abort;
  try {
    fs.mkdirSync(staging, { recursive: true });
    await compile({ root: checkout, outDir: staging, signal: abort.signal });

    const after = inputIdentity(checkout);
    if (after.sha256 !== before.sha256) {
      throw new Error("the source changed during compilation; the output was discarded rather than published");
    }
    writeReceipt(checkout, staging, after);
    publishStaging(checkout, staging, live);
  } finally {
    live.delete(staging);
    if (held.abort === abort) held.abort = null;
    // Cleanup is best-effort reporting: it must never mask the failure that brought us here.
    try {
      if (fs.existsSync(staging)) removeOwnedScratch(checkout, staging, STAGING_PREFIX);
    } catch (cleanupError) {
      log(`build-source: could not remove ${path.basename(staging)}: ${cleanupError.message}`);
    }
  }
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
