import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GATES } from "../scripts/gate-inventory.mjs";
import { batteryPlan, reserveBatteryLogPath, runBattery } from "../scripts/run-battery.mjs";
import * as batteryRunner from "../scripts/run-battery.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const syntheticGates = {
  smoke: { host: "linux", scope: "fixture", commands: [["node", "smoke.mjs"]] },
  "test:linux": { host: "linux", scope: "fixture", commands: [["node", "linux.mjs"]] },
  "test:mac": { host: "macos", scope: "native-contract", commands: [["sh", "mac.sh"]] },
  "test:win": { host: "windows", scope: "fixture", commands: [["node", "win.mjs"]] },
};

test("the battery plan runs this host's gates and reports the rest as skipped", () => {
  assert.deepEqual(batteryPlan({ platform: "linux", gates: syntheticGates }), {
    host: "linux",
    run: ["smoke", "test:linux"],
    skipped: [{ name: "test:mac", host: "macos" }, { name: "test:win", host: "windows" }],
  });
  assert.deepEqual(batteryPlan({ platform: "darwin", gates: syntheticGates }).run, ["test:mac"]);
  assert.deepEqual(batteryPlan({ platform: "win32", gates: syntheticGates }).run, ["test:win"]);
});

test("the repository plan derives from the inventory, not from package-script discovery", () => {
  const linux = batteryPlan({ platform: "linux" });
  assert.ok(linux.run.includes("smoke"), linux.run.join(", "));
  assert.ok(linux.run.includes("test:knowledge-lifecycle"), "the focused Knowledge lifecycle regression must stay in the battery");
  assert.ok(linux.run.includes("test:runrevision"), "the revision suites must stay in the battery");
  assert.ok(linux.skipped.some((entry) => entry.name === "test:vcamtransport-native" && entry.host === "macos"));

  const macos = batteryPlan({ platform: "darwin" });
  assert.ok(macos.run.includes("test:vcamreader-native"));
  assert.ok(macos.skipped.some((entry) => entry.name === "smoke" && entry.host === "linux"));

  for (const plan of [linux, macos, batteryPlan({ platform: "win32" })]) {
    assert.equal(plan.run.length + plan.skipped.length, Object.keys(GATES).length, "every gate is either run or explicitly skipped");
  }
});

test("a reserved log never overwrites previous evidence", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "battery-reserve-"));
  const requested = path.join(scratch, "nested", "battery.log");
  assert.equal(reserveBatteryLogPath(requested), requested, "a free name is used as-is");
  fs.writeFileSync(requested, "previous evidence\n");
  assert.equal(reserveBatteryLogPath(requested), `${requested}.1`);
  assert.equal(reserveBatteryLogPath(requested), `${requested}.2`);
  assert.equal(fs.readFileSync(requested, "utf8"), "previous evidence\n");
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("runBattery reserves a new log rather than replacing the one already there", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "battery-test-"));
  const logPath = path.join(scratch, "battery.log");
  fs.writeFileSync(logPath, "first run\n");
  const result = runBattery({
    worktree: scratch,
    logPath,
    commands: ["smoke"],
    runCommand: () => ({ status: 0, stdout: "ok\n", stderr: "" }),
    report: () => {},
    now: () => 0,
  });
  assert.equal(result.logPath, `${logPath}.1`);
  assert.equal(fs.readFileSync(logPath, "utf8"), "first run\n");
  assert.match(fs.readFileSync(result.logPath, "utf8"), /BATTERY PASS 1\/1/);
  fs.rmSync(scratch, { recursive: true, force: true });
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

test("the summary states how many gates were skipped off-platform, so a short PASS cannot read as a full one", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "battery-test-"));
  const logPath = path.join(scratch, "battery.log");
  const lines = [];
  const result = runBattery({
    worktree: scratch,
    logPath,
    commands: ["test:mac"],
    skipped: [{ name: "smoke", host: "linux" }, { name: "test:linux", host: "linux" }, { name: "test:win", host: "windows" }],
    runCommand: () => ({ status: 0, stdout: "ok\n", stderr: "" }),
    report: (line) => lines.push(line),
    now: () => 0,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.summary, /^BATTERY PASS 1\/1 \(0 failed\); 3 skipped off-platform \(linux: 2, windows: 1\)$/);
  assert.match(lines.at(-2), /3 skipped off-platform/);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /skipped \(off-platform\): smoke \[linux\], test:linux \[linux\], test:win \[windows\]/);
  assert.match(log, /3 skipped off-platform/);
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

test("battery CLI runs the planned gates and writes the requested aggregate log", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "battery-cli-test-"));
  const logPath = path.join(scratch, "aggregate.log");
  const driver = path.join(scratch, "driver.mjs");
  const runnerUrl = pathToFileURL(path.join(repoRoot, "scripts", "run-battery.mjs")).href;
  fs.writeFileSync(driver, [
    `import { runBatteryCli } from ${JSON.stringify(runnerUrl)};`,
    "const gates = {",
    '  smoke: { host: "linux", scope: "fixture", commands: [["node", "smoke.mjs"]] },',
    '  "test:one": { host: "linux", scope: "fixture", commands: [["node", "one.mjs"]] },',
    '  "test:mac": { host: "macos", scope: "native-contract", commands: [["sh", "mac.sh"]] },',
    "};",
    "process.exitCode = runBatteryCli(process.argv.slice(2), {",
    '  gates, platform: "linux",',
    "  runCommand: (name) => ({ status: 0, stdout: `fixture ${name}\\n`, stderr: \"\" }),",
    "});",
    "",
  ].join("\n"));

  const result = spawnSync(process.execPath, [driver, scratch, logPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /host: linux/);
  assert.match(result.stdout, /BATTERY PASS 2\/2 \(0 failed\); 1 skipped off-platform \(macos: 1\)/);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /1\/2 npm run smoke/);
  assert.match(log, /2\/2 npm run test:one/);
  assert.match(log, /fixture test:one/);
  assert.match(log, /BATTERY PASS 2\/2 \(0 failed\); 1 skipped off-platform \(macos: 1\)/);
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
