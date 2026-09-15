import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GATES, hostFamilyForPlatform } from "./gate-inventory.mjs";
import { npmLaunch } from "./plugin-bootstrap.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What this host can actually run, and what it cannot.
 *
 * The split is by SCOPE, not by host. `host` records which CI lane owns a gate — it is a lane
 * assignment, not an exclusivity claim: `fixture` and `installed-artifact` gates are deterministic
 * and cross-platform, and a developer on any OS should run all of them. Only `native-contract`
 * gates are genuinely OS-bound, and those are exactly the ones the battery used to run everywhere
 * by discovering `test:`-prefixed package scripts: off their own OS the two CMIO shell scripts
 * print "skipped" and exit 0 — green output for a contract that compiled nothing.
 *
 * So a native contract assigned to another OS is skipped and named, and the summary states how
 * many, which is the one case where a short PASS could otherwise read as a whole-battery PASS.
 */
export function batteryPlan({ platform = process.platform, gates = GATES } = {}) {
  const host = hostFamilyForPlatform(platform);
  const run = [];
  const skipped = [];
  for (const [name, gate] of Object.entries(gates)) {
    if (gate.scope !== "native-contract" || gate.host === host) run.push(name);
    else skipped.push({ name, host: gate.host });
  }
  return { host, run, skipped };
}

export function batteryNpmLaunch(name, platform = process.platform, env = process.env) {
  return npmLaunch(["run", name], platform, env);
}

function spawnNpm(name, { worktree }) {
  const launch = batteryNpmLaunch(name);
  return spawnSync(launch.command, launch.args, {
    cwd: worktree,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
}

/**
 * Claim a log path nobody else holds, creating it exclusively.
 *
 * A battery run is evidence. Writing over `<log>` because that name was passed twice destroys the
 * previous run's output, so the requested name is only used when it is free; otherwise the first
 * free `<log>.1`, `<log>.2`, … is reserved and returned.
 */
export function reserveBatteryLogPath(logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  for (let suffix = 0; suffix < 10_000; suffix++) {
    const candidate = suffix === 0 ? logPath : `${logPath}.${suffix}`;
    try {
      closeSync(openSync(candidate, "wx"));
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not reserve a fresh battery log beside ${logPath}`);
}

/**
 * Run every requested gate and return one aggregate result. A failed child is data, not control
 * flow: later gates still execute and the caller receives a non-zero exitCode only after summary.
 */
export function runBattery({
  worktree,
  logPath,
  commands,
  skipped = [],
  runCommand = spawnNpm,
  report = console.log,
  now = Date.now,
}) {
  const reservedLogPath = reserveBatteryLogPath(logPath);
  const skipNote = skipped.length ? `\nskipped (off-platform): ${skipped.map((entry) => `${entry.name} [${entry.host}]`).join(", ")}\n` : "";
  writeFileSync(reservedLogPath, `PICO gate battery (${commands.length} invocations)\ncheckout: ${worktree}\n${skipNote}`);

  const results = [];
  for (const [index, name] of commands.entries()) {
    const started = now();
    let child;
    try {
      child = runCommand(name, { worktree, index, total: commands.length });
    } catch (error) {
      child = { status: null, signal: null, error, stdout: "", stderr: "" };
    }
    const elapsed = ((now() - started) / 1000).toFixed(1);
    const stdout = child?.stdout == null ? "" : String(child.stdout);
    const stderr = child?.stderr == null ? "" : String(child.stderr);
    const combined = `${stdout}${stderr}`;
    const exitCode = child?.status === 0 ? 0 : (Number.isInteger(child?.status) ? child.status : 1);
    const signal = child?.signal ? String(child.signal) : null;
    const causeParts = [child?.error?.message, signal ? `signal ${signal}` : null].filter(Boolean);
    const cause = causeParts.join("; ");
    const loggedOutput = cause
      ? `${combined}${combined && !combined.endsWith("\n") ? "\n" : ""}[battery runner] ${cause}\n`
      : combined;
    const result = { index: index + 1, name, exitCode, signal, cause, elapsed, passed: exitCode === 0 };
    results.push(result);

    appendFileSync(
      reservedLogPath,
      `\n===== ${index + 1}/${commands.length} npm run ${name} (${elapsed}s; exit ${exitCode}${signal ? `; ${signal}` : ""}) =====\n${loggedOutput}`,
    );
    if (result.passed) {
      report(`PASS ${index + 1}/${commands.length} ${name} (${elapsed}s)`);
    } else {
      report(`FAIL ${index + 1}/${commands.length} ${name} (${elapsed}s)${cause ? `: ${cause}` : ""}`);
      if (combined) report(combined.split("\n").slice(-120).join("\n"));
    }
  }

  const failed = results.filter((result) => !result.passed);
  const passed = results.length - failed.length;
  const skippedByHost = new Map();
  for (const entry of skipped) skippedByHost.set(entry.host, (skippedByHost.get(entry.host) ?? 0) + 1);
  const skipSummary = skipped.length
    ? `; ${skipped.length} skipped off-platform (${[...skippedByHost].map(([host, count]) => `${host}: ${count}`).join(", ")})`
    : "";
  const summary = failed.length
    ? `BATTERY FAIL ${passed}/${results.length} passed; ${failed.length} failed: ${failed.map((result) => `${result.name} [exit ${result.exitCode}${result.signal ? `, ${result.signal}` : ""}]`).join(", ")}${skipSummary}`
    : `BATTERY PASS ${passed}/${results.length} (0 failed)${skipSummary}`;
  appendFileSync(reservedLogPath, `\n\n===== SUMMARY =====\n${summary}\n`);
  report(summary);
  report(`Full log: ${reservedLogPath}`);
  return { exitCode: failed.length ? 1 : 0, passed, failed, results, summary, logPath: reservedLogPath, skipped };
}

export function defaultBatteryLogPath(worktree, tempDir = os.tmpdir()) {
  return path.join(tempDir, `pico-battery-${path.basename(worktree)}.log`);
}

export function runBatteryCli(args = process.argv.slice(2), {
  defaultWorktree = repoRoot,
  gates = GATES,
  platform = process.platform,
  runCommand = spawnNpm,
  report = console.log,
} = {}) {
  const worktree = args[0] ? path.resolve(args[0]) : defaultWorktree;
  const logPath = args[1] ?? defaultBatteryLogPath(worktree);
  const plan = batteryPlan({ platform, gates });
  report(`battery checkout: ${worktree}\nhost: ${plan.host}\nlog: ${logPath} (a fresh file is reserved if that name is taken)\n`);
  return runBattery({ worktree, logPath, commands: plan.run, skipped: plan.skipped, runCommand, report }).exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runBatteryCli();
}
