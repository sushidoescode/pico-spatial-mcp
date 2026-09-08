// Production wrapper + real child-process argv, with an isolated executable standing in for
// the external profiler. No npm requests, device operations, or writes to the user's home.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPerfDiagnose } from "../dist/perfcli.js";

const fixtureDriver = fileURLToPath(new URL("./fixtures/fake-perf-cli.mjs", import.meta.url));

function perfFixture(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-perf argv-"));
  const configPath = path.join(root, "config.json");
  const logPath = path.join(root, "calls.jsonl");
  const cliPath = path.join(root, process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
  fs.writeFileSync(configPath, JSON.stringify({ cliVersion: "0.4.4", ...config, logPath }));
  fs.writeFileSync(logPath, "");
  if (process.platform === "win32") {
    fs.writeFileSync(cliPath, '@echo off\r\n"' + process.execPath + '" "' + fixtureDriver + '" "' + configPath + '" %*\r\n');
  } else {
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(cliPath, "#!/bin/sh\nexec " + [process.execPath, fixtureDriver, configPath].map(quote).join(" ") + ' "$@"\n', { mode: 0o755 });
  }
  const overrides = {
    PICO_MCP_CLI_POLICY: "external",
    PICO_MCP_CLI_PATH: cliPath,
    PICO_MCP_AUTOINSTALL_CLI: undefined,
    PICO_MCP_AUTOUPDATE_CLI: undefined,
  };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.mock.method(os, "homedir", () => root);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, cliPath, calls: () => fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
}

function assertRunReceipt(result, fixture, expectedArgs) {
  assert.deepEqual(result.command, { path: fixture.cliPath, args: expectedArgs });
  const runs = fixture.calls().filter((args) => args[0] === "perf" && args[2] === "run" && args.at(-1) !== "--help");
  assert.deepEqual(runs, [expectedArgs], "receipt must equal the single invocation actually executed");
}

test("profiler 0.1.0 produces a report through live run with --save and retains exact argv", async (t) => {
  const fixture = perfFixture(t, { profilerVersion: "0.1.0", runMode: "live" });
  const result = await runPerfDiagnose("com.fleet.swanmissiontable", { durationSec: 60, device: "emulator-5554" });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assertRunReceipt(result, fixture, ["perf", "live", "run", "--app", "com.fleet.swanmissiontable", "-d", "60", "--device", "emulator-5554", "--save", "-o", result.reportPath]);
  assert.equal(result.profiler.version, "0.1.0");
  assert.equal(result.profiler.identity, "profiler-cli");
  assert.deepEqual(result.profiler.versionProbe.args, ["perf", "-V"]);
  assert.equal(result.profiler.versionProbe.path, fixture.cliPath);
  assert.equal(result.summary.sysFps.avg, 59.97);
  assert.equal(result.summary.appCpu.avg, 4.85);
});

test("known embedded pico-cli 0.3.0 keeps its supported monitor invocation after exact help confirmation", async (t) => {
  const fixture = perfFixture(t, { cliVersion: "0.3.0", versionError: "error: unknown option '-V'", runMode: "monitor" });
  const result = await runPerfDiagnose("com.fleet.legacy", { durationSec: 2 });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assertRunReceipt(result, fixture, ["perf", "monitor", "run", "--app", "com.fleet.legacy", "-d", "5", "--device", "emulator-5554", "-o", result.reportPath]);
  assert.equal(result.profiler.version, null, "the embedded helper has no independently measured version");
  assert.equal(result.profiler.identity, "pico-cli-0.3.0-embedded");
  assert.deepEqual(result.profiler.legacyHelpProbe.args, ["perf", "monitor", "run", "--help"]);
});

test("a detected supported standalone helper takes precedence over the old host CLI version", async (t) => {
  const fixture = perfFixture(t, { cliVersion: "0.3.0", profilerVersion: "0.1.0", runMode: "live" });
  const result = await runPerfDiagnose("com.fleet.demo", { durationSec: 200, device: "serial with spaces" });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assertRunReceipt(result, fixture, ["perf", "live", "run", "--app", "com.fleet.demo", "-d", "120", "--device", "serial with spaces", "--save", "-o", result.reportPath]);
  assert.equal(result.profiler.version, "0.1.0");
});

for (const cliVersion of ["0.4.4", "0.3.0"]) {
  test("unsupported profiler version refuses to sample even on pico-cli " + cliVersion, async (t) => {
    const fixture = perfFixture(t, { cliVersion, profilerVersion: "0.2.0" });
    const result = await runPerfDiagnose("com.fleet.demo");
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.failureClass, "flag-or-version-drift");
    assert.equal(result.profiler.version, "0.2.0");
    assert.equal(result.command, undefined, "no sampling invocation may be invented in a refusal");
    assert.deepEqual(fixture.calls(), [["-v"], ["perf", "-V"]]);
    assert.equal(fs.existsSync(path.join(fixture.root, ".pico-mcp", "perf")), false);
  });
}

test("root help from a successful version probe is unrecognized and does not start sampling", async (t) => {
  const fixture = perfFixture(t, { versionOutput: "Usage: perf [options] [command]\n  live\n  trace" });
  const result = await runPerfDiagnose("com.fleet.demo");
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.failureClass, "flag-or-version-drift");
  assert.equal(result.profiler.version, null);
  assert.deepEqual(fixture.calls(), [["-v"], ["perf", "-V"]]);
});

test("legacy host root help cannot masquerade as a supported monitor command", async (t) => {
  const fixture = perfFixture(t, {
    cliVersion: "0.3.0", versionError: "error: unknown option '-V'",
    legacyHelp: "Usage: perf [options] [command]\n  live\n  trace\n  --app <package>\n  -d, --duration <seconds>\n  --device <serial>\n  -o, --output <path>",
  });
  const result = await runPerfDiagnose("com.fleet.demo");
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.failureClass, "flag-or-version-drift");
  assert.equal(result.command, undefined);
  assert.deepEqual(fixture.calls(), [["-v"], ["perf", "-V"], ["perf", "monitor", "run", "--help"]]);
});

test("unprovisioned profiler returns manual setup guidance without a sampling invocation", async (t) => {
  const fixture = perfFixture(t, { versionError: "Error: Perf utilities 0.1.0 are not installed. Run `pico-cli setup` to install." });
  const result = await runPerfDiagnose("com.fleet.demo");
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.failureClass, "setup-required");
  assert.deepEqual(result.setupCommand, { path: fixture.cliPath, args: ["setup"] });
  assert.deepEqual(fixture.calls(), [["-v"], ["perf", "-V"]]);
});

for (const failure of [
  { name: "runtime refusal", runError: "adb: device 'emulator-5554' not found" },
  { name: "missing report", reportMode: "missing" },
  { name: "malformed report", reportMode: "malformed" },
]) {
  test("live invocation receipt survives " + failure.name, async (t) => {
    const fixture = perfFixture(t, { profilerVersion: "0.1.0", runMode: "live", ...failure });
    const result = await runPerfDiagnose("com.fleet.demo");
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.failureClass, "runtime");
    const run = fixture.calls().find((args) => args[0] === "perf" && args[1] === "live" && args[2] === "run");
    assert.ok(run, "live run must have been attempted before its runtime/report failure");
    assertRunReceipt(result, fixture, ["perf", "live", "run", "--app", "com.fleet.demo", "-d", "15", "--device", "emulator-5554", "--save", "-o", run.at(-1)]);
    assert.equal(result.profiler.version, "0.1.0");
  });
}
