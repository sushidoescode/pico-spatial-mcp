import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { npmLaunch } from "./plugin-bootstrap.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function discoverBatteryCommands(packageJson) {
  return [
    "smoke",
    ...Object.keys(packageJson?.scripts ?? {}).filter((name) => name.startsWith("test:")),
  ];
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
 * Run every requested gate and return one aggregate result. A failed child is data, not control
 * flow: later gates still execute and the caller receives a non-zero exitCode only after summary.
 */
export function runBattery({
  worktree,
  logPath,
  commands,
  runCommand = spawnNpm,
  report = console.log,
  now = Date.now,
}) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, `PICO gate battery (${commands.length} invocations)\ncheckout: ${worktree}\n`);

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
      logPath,
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
  const summary = failed.length
    ? `BATTERY FAIL ${passed}/${results.length} passed; ${failed.length} failed: ${failed.map((result) => `${result.name} [exit ${result.exitCode}${result.signal ? `, ${result.signal}` : ""}]`).join(", ")}`
    : `BATTERY PASS ${passed}/${results.length} (0 failed)`;
  appendFileSync(logPath, `\n\n===== SUMMARY =====\n${summary}\n`);
  report(summary);
  report(`Full log: ${logPath}`);
  return { exitCode: failed.length ? 1 : 0, passed, failed, results, summary, logPath };
}

export function defaultBatteryLogPath(worktree, tempDir = os.tmpdir()) {
  return path.join(tempDir, `pico-battery-${path.basename(worktree)}.log`);
}

export function runBatteryCli(args = process.argv.slice(2), defaultWorktree = repoRoot) {
  const worktree = args[0] ? path.resolve(args[0]) : defaultWorktree;
  const logPath = args[1] ?? defaultBatteryLogPath(worktree);
  console.log(`battery checkout: ${worktree}\nlog: ${logPath}\n`);
  const packageJson = JSON.parse(readFileSync(path.join(worktree, "package.json"), "utf8"));
  const commands = discoverBatteryCommands(packageJson);
  return runBattery({ worktree, logPath, commands }).exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runBatteryCli();
}
