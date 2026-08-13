import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverBatteryCommands, runBattery } from "../scripts/run-battery.mjs";

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
  const calls = [];
  const result = runBattery({
    worktree: scratch,
    logPath: path.join(scratch, "battery.log"),
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
