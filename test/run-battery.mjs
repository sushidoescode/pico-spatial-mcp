import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { discoverBatteryCommands, runBattery } from "../scripts/run-battery.mjs";
import * as batteryRunner from "../scripts/run-battery.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("discoverBatteryCommands returns smoke plus every test script", () => {
  assert.deepEqual(
    discoverBatteryCommands({ scripts: { build: "tsc", smoke: "node smoke", "test:z": "z", "test:a": "a" } }),
    ["smoke", "test:z", "test:a"],
  );
});

test("runBattery continues after failures, retains every section, and summarizes", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "battery-test-"));
  const logPath = path.join(scratch, "battery.log");
  const calls = [];
  const lines = [];
  const responses = {
    smoke: { status: 0, stdout: "smoke out\n", stderr: "" },
    "test:first": { status: 7, stdout: "first out\n", stderr: "first err\n" },
    "test:last": { status: 0, stdout: "last out\n", stderr: "" },
  };
  const result = runBattery({
    worktree: scratch,
    logPath,
    commands: ["smoke", "test:first", "test:last"],
    runCommand: (name) => { calls.push(name); return responses[name]; },
    report: (line) => lines.push(line),
    now: (() => { let value = 0; return () => (value += 1000); })(),
  });

  assert.deepEqual(calls, ["smoke", "test:first", "test:last"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.passed, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, "test:first");
  assert.match(lines.at(-2), /^BATTERY FAIL 2\/3 passed; 1 failed: test:first \[exit 7\]$/);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /1\/3 npm run smoke/);
  assert.match(log, /2\/3 npm run test:first/);
  assert.match(log, /3\/3 npm run test:last/);
  assert.match(log, /smoke out/);
  assert.match(log, /first out/);
  assert.match(log, /first err/);
  assert.match(log, /last out/);
  assert.match(log, /BATTERY FAIL 2\/3 passed; 1 failed/);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("null status, spawn error, and signal count as one failure without aborting", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "battery-test-"));
  const logPath = path.join(scratch, "battery.log");
  const calls = [];
  const result = runBattery({
    worktree: scratch,
    logPath,
    commands: ["smoke", "test:after"],
    runCommand: (name) => {
      calls.push(name);
      return name === "smoke"
        ? { status: null, signal: "SIGTERM", error: new Error("spawn failed"), stdout: "", stderr: "partial\n" }
        : { status: 0, stdout: "after\n", stderr: "" };
    },
    report: () => {},
    now: () => 0,
  });
  assert.deepEqual(calls, ["smoke", "test:after"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failed[0].exitCode, 1);
  assert.equal(result.failed[0].signal, "SIGTERM");
  assert.match(result.failed[0].cause, /spawn failed/);
  assert.match(fs.readFileSync(logPath, "utf8"), /spawn failed/, "spawn diagnostics must survive in the full log");
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("battery npm launch is argv-safe and portable across POSIX and Windows", () => {
  assert.equal(typeof batteryRunner.batteryNpmLaunch, "function", "runner must expose its platform launch boundary");
  assert.deepEqual(batteryRunner.batteryNpmLaunch("test:ledger", "linux", {}), {
    command: "npm",
    args: ["run", "test:ledger"],
  });
  assert.deepEqual(batteryRunner.batteryNpmLaunch("test:ledger", "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd run test:ledger"],
  });
});

test("default battery log path is rooted in the host temp directory", () => {
  assert.equal(typeof batteryRunner.defaultBatteryLogPath, "function", "runner must expose its default log boundary");
  const worktree = path.join(os.tmpdir(), "some checkout");
  assert.equal(
    batteryRunner.defaultBatteryLogPath(worktree, path.join(os.tmpdir(), "explicit-host-temp")),
    path.join(os.tmpdir(), "explicit-host-temp", "pico-battery-some checkout.log"),
  );
});

test("battery CLI runs every discovered command and writes the requested aggregate log", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "battery-cli-test-"));
  const logPath = path.join(scratch, "aggregate.log");
  fs.writeFileSync(path.join(scratch, "pass.mjs"), "process.stdout.write(`fixture pass\\n`);\n");
  fs.writeFileSync(path.join(scratch, "package.json"), JSON.stringify({
    scripts: {
      smoke: "node pass.mjs",
      "test:one": "node pass.mjs",
    },
  }));
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "run-battery.mjs"), scratch, logPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /BATTERY PASS 2\/2 \(0 failed\)/);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /1\/2 npm run smoke/);
  assert.match(log, /2\/2 npm run test:one/);
  assert.match(log, /BATTERY PASS 2\/2 \(0 failed\)/);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("all-pass run reports an exact zero-failure summary", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "battery-test-"));
  const lines = [];
  const result = runBattery({
    worktree: scratch,
    logPath: path.join(scratch, "battery.log"),
    commands: ["smoke", "test:one"],
    runCommand: () => ({ status: 0, stdout: "ok\n", stderr: "" }),
    report: (line) => lines.push(line),
    now: () => 0,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.passed, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(lines.at(-2), "BATTERY PASS 2/2 (0 failed)");
  fs.rmSync(scratch, { recursive: true, force: true });
});
