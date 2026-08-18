// End-to-end compatibility sweep tests. Every npm and pico-cli process is an isolated fake.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sweepScript = path.join(repoRoot, "scripts", "compare-picocli-surfaces.mjs");
const roots = [];

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function fixture(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-cli sweep "));
  roots.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const configPath = path.join(root, "fixture.json");
  const logPath = path.join(root, "invocations.jsonl");
  fs.writeFileSync(configPath, JSON.stringify(config));
  executable(path.join(bin, "npm"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(process.env.FAKE_SWEEP_CONFIG, "utf8"));
const args = process.argv.slice(2);
const isolation = { cwd: process.cwd(), home: process.env.HOME, userprofile: process.env.USERPROFILE, cacheUpper: process.env.NPM_CONFIG_CACHE, cacheLower: process.env.npm_config_cache };
fs.appendFileSync(process.env.FAKE_SWEEP_LOG, JSON.stringify({ role: "npm", args, isolation }) + "\\n");
if (args.length === 5 && args[0] === "view" && args[1] === "@picoxr/pico-cli@latest" && args[2] === "version" && args[3] === "dist.integrity" && args[4] === "--json") {
  if (config.registryStderr) process.stderr.write(config.registryStderr);
  if (config.registryExit) { process.stderr.write("fixture registry unavailable\\n"); process.exit(config.registryExit); }
  process.stdout.write(config.registryRaw ?? JSON.stringify({ version: config.latest, "dist.integrity": "sha512-fixture" }));
  process.exit(0);
}
const installTail = args.at(-1);
const legacyInstallShape = args.length === 8 && args[3] === "--no-save" && args[4] === "--package-lock=false" && args[5] === "--fund=false" && args[6] === "--audit=false";
const lifecycleSafeInstallShape = args.length === 9 && args[3] === "--ignore-scripts" && args[4] === "--no-save" && args[5] === "--package-lock=false" && args[6] === "--fund=false" && args[7] === "--audit=false";
if (args[0] !== "install" || args[1] !== "--prefix" || !path.isAbsolute(args[2]) || (!legacyInstallShape && !lifecycleSafeInstallShape) || !/^@picoxr\\/pico-cli@[0-9]+\\.[0-9]+\\.[0-9]+$/.test(installTail)) {
  process.stderr.write("unsafe or inexact npm argv: " + JSON.stringify(args) + "\\n"); process.exit(97);
}
if (config.postinstallProbe && !args.includes("--ignore-scripts")) {
  fs.writeFileSync(path.join(path.dirname(process.env.FAKE_SWEEP_CONFIG), "postinstall-ran"), "fixture lifecycle script ran\\n");
}
const version = installTail.slice("@picoxr/pico-cli@".length);
const spec = config.versions[version];
if (!spec || spec.installExit) { process.stderr.write("fixture install failed\\n"); process.exit(spec?.installExit ?? 98); }
const packageRoot = path.join(args[2], "node_modules", "@picoxr", "pico-cli");
const shim = path.join(args[2], "node_modules", ".bin", "pico-cli");
fs.mkdirSync(packageRoot, { recursive: true }); fs.mkdirSync(path.dirname(shim), { recursive: true });
fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@picoxr/pico-cli", version: spec.packageVersion ?? version }));
fs.writeFileSync(shim, \`#!\${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const config = JSON.parse(fs.readFileSync(process.env.FAKE_SWEEP_CONFIG, "utf8"));
const version = \${JSON.stringify(version)};
const spec = config.versions[version];
const args = process.argv.slice(2);
const isolation = { cwd: process.cwd(), home: process.env.HOME, userprofile: process.env.USERPROFILE, cacheUpper: process.env.NPM_CONFIG_CACHE, cacheLower: process.env.npm_config_cache };
fs.appendFileSync(process.env.FAKE_SWEEP_LOG, JSON.stringify({ role: "cli", pid: process.pid, version, args, isolation }) + "\\\\n");
if (args.length === 1 && args[0] === "-v") { process.stdout.write("pico-cli/" + (spec.reportedVersion ?? version) + "\\\\n"); process.exit(spec.versionExit ?? 0); }
const key = args.slice(0, -1).join(" ") || "pico-cli";
const entry = spec.tree[key];
if (!entry || args.at(-1) !== "--help") { process.stderr.write("unexpected CLI argv " + JSON.stringify(args) + "\\\\n"); process.exit(96); }
if (entry.spawnDetachedInheritedStdioMs) {
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, " + Number(entry.spawnDetachedInheritedStdioMs) + ")"], {
    detached: true,
    stdio: ["ignore", process.stdout, process.stderr],
  });
  fs.writeFileSync(path.join(path.dirname(process.env.FAKE_SWEEP_CONFIG), "descendant.pid"), String(descendant.pid));
  descendant.unref();
}
if (entry.signal) process.kill(process.pid, entry.signal);
if (entry.hangMs) setTimeout(() => {}, entry.hangMs);
if (entry.stdout) process.stdout.write(entry.stdout);
if (entry.stderr) process.stderr.write(entry.stderr);
if (!entry.hangMs) process.exit(entry.code ?? 0);
\`, { mode: 0o755 });
process.exit(0);
`);
  return {
    root,
    bin,
    configPath,
    logPath,
    postinstallMarkerPath: path.join(root, "postinstall-ran"),
    descendantPidPath: path.join(root, "descendant.pid"),
  };
}

function runSweep(fix, extraArgs = [], env = {}, hostTimeoutMs = 8_000) {
  const output = path.join(fix.root, "report.json");
  const result = spawnSync(process.execPath, [sweepScript,
    "--from", "1.0.0", "--to", "2.0.0", "--output", output, ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: hostTimeoutMs,
    env: {
      ...process.env,
      PATH: fix.bin,
      FAKE_SWEEP_CONFIG: fix.configPath,
      FAKE_SWEEP_LOG: fix.logPath,
      ...env,
    },
  });
  const calls = fs.existsSync(fix.logPath)
    ? fs.readFileSync(fix.logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return { ...result, output, calls };
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return !pidExists(pid);
}

function forceKillFixtureProcesses(fix) {
  const pids = new Set();
  if (fs.existsSync(fix.descendantPidPath)) pids.add(Number(fs.readFileSync(fix.descendantPidPath, "utf8")));
  if (fs.existsSync(fix.logPath)) {
    for (const line of fs.readFileSync(fix.logPath, "utf8").trim().split("\n").filter(Boolean)) {
      const call = JSON.parse(line);
      if (call.role === "cli" && Number.isInteger(call.pid) && call.args.length === 1 && call.args[0] === "--help") {
        pids.add(call.pid);
      }
    }
  }
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
}

function sha(stdout, stderr = "") {
  return crypto.createHash("sha256").update(stdout).update(stderr).digest("hex");
}

function help(commands, tail = "Options:\n  --help  Print help\n") {
  return `Usage: pico-cli\n\u001b[36mCommands:\u001b[0m\n${commands.map((line) => `  ${line}`).join("\n")}\n${tail}`;
}

const sharedTree = {
  deploy: { stdout: "deploy leaf\n" },
  inspect: { stdout: "inspect leaf\n" },
  doctor: { stdout: "doctor help only\n" },
  emulator: { stdout: help(["status  Read status"]) },
  "emulator status": { stdout: "emulator status help only\n" },
  device: { stdout: help(["list  List devices"]) },
  "device list": { stdout: "device list help only\n" },
  "plugin:doctor": { stdout: "colon command help only\n" },
};

test("compares the complete advertised safe help trees and hashes exact stdout plus stderr", () => {
  const fromRoot = help([
    "deploy <file>  Deploy a file", "inspect [target]  Inspect target", "shared  Shared leaf",
    "oldcmd  Removed later", "doctor  Diagnose", "emulator  Emulator help", "device  Device help",
    "setup  Prohibited subtree", "plugin:doctor  Colon command", "deploy <file>  Duplicate row",
  ], "Options:\n  optionlike  must not become a command\n  --help  Print help\n");
  const toRoot = help([
    "deploy <file>  Deploy a file", "inspect [target]  Inspect target", "shared  Shared leaf",
    "newcmd  Added now", "doctor  Diagnose", "emulator  Emulator help", "device  Device help",
    "setup  Prohibited subtree", "plugin:doctor  Colon command", "deploy <file>  Duplicate row",
  ], "Options:\n  optionlike  must not become a command\n  --help  Print help\n");
  const fix = fixture({
    latest: "2.0.0",
    versions: {
      "1.0.0": { tree: { "pico-cli": { stdout: fromRoot }, ...sharedTree, shared: { stdout: "same stdout\n", stderr: "old stderr\n", code: 7 }, oldcmd: { stdout: "old\n" } } },
      "2.0.0": { tree: { "pico-cli": { stdout: toRoot }, ...sharedTree, shared: { stdout: "same stdout\n", stderr: "new stderr\n", code: 9 }, newcmd: { stdout: "new\n" } } },
    },
  });

  const result = runSweep(fix);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), result.output);
  const report = JSON.parse(fs.readFileSync(result.output, "utf8"));
  assert.equal(report.schemaVersion, 1);
  assert.match(report.generatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(report.from, { requested: "1.0.0", version: "1.0.0", commandCount: 11 });
  assert.deepEqual(report.to, { requested: "2.0.0", version: "2.0.0", commandCount: 11 });
  assert.deepEqual(report.addedCommands, ["newcmd"]);
  assert.deepEqual(report.removedCommands, ["oldcmd"]);
  assert.deepEqual(report.changedHelp, [
    { command: "pico-cli", fromSha256: sha(fromRoot), toSha256: sha(toRoot) },
    { command: "shared", fromSha256: sha("same stdout\n", "old stderr\n"), toSha256: sha("same stdout\n", "new stderr\n") },
  ]);
  assert.deepEqual(report.unchangedCommands, ["deploy", "device", "device list", "doctor", "emulator", "emulator status", "inspect", "plugin:doctor"]);
  assert.deepEqual(report.safety, { setupInvoked: false, nonHelpCommandsInvoked: false });

  const cliCalls = result.calls.filter((call) => call.role === "cli");
  for (const call of cliCalls) {
    assert.ok(call.args.length === 1 && call.args[0] === "-v" || call.args.at(-1) === "--help", JSON.stringify(call));
    assert.notEqual(call.args[0], "setup", JSON.stringify(call));
    assert.equal(call.args.join(" ").includes("update --check"), false, JSON.stringify(call));
  }
  for (const version of ["1.0.0", "2.0.0"]) {
    const seen = new Set(cliCalls.filter((call) => call.version === version).map((call) => call.args.join(" ")));
    for (const argv of ["doctor --help", "emulator --help", "emulator status --help", "device --help", "device list --help", "plugin:doctor --help"])
      assert.ok(seen.has(argv), `${version} did not safely visit ${argv}`);
    assert.equal(seen.has("setup --help"), false);
    assert.equal(seen.has("optionlike --help"), false);
  }
  const npmCalls = result.calls.filter((call) => call.role === "npm");
  assert.deepEqual(npmCalls.map((call) => call.args.at(-1)), ["@picoxr/pico-cli@1.0.0", "@picoxr/pico-cli@2.0.0"]);
  for (const call of npmCalls) {
    assert.equal(call.args.includes("-g"), false);
    assert.equal(call.args.includes("--global"), false);
  }
  const isolation = result.calls[0].isolation;
  assert.ok(path.isAbsolute(isolation.cwd));
  assert.deepEqual(isolation, {
    cwd: isolation.cwd,
    home: path.join(path.dirname(isolation.cwd), "home"),
    userprofile: path.join(path.dirname(isolation.cwd), "home"),
    cacheUpper: path.join(path.dirname(isolation.cwd), "npm-cache"),
    cacheLower: path.join(path.dirname(isolation.cwd), "npm-cache"),
  });
  for (const call of result.calls) assert.deepEqual(call.isolation, isolation, JSON.stringify(call));
  for (const call of npmCalls) assert.ok(call.args[2].startsWith(`${path.dirname(isolation.cwd)}${path.sep}`), JSON.stringify(call));
  assert.equal(fs.existsSync(path.dirname(isolation.cwd)), false, "owned session root must be removed after the report is published");
});

test("resolves latest to an exact install and rejects unsafe arguments and invalid package evidence", async (t) => {
  const valid = () => fixture({ latest: "2.0.0", versions: {
    "1.0.0": { tree: { "pico-cli": { stdout: help([]) } } },
    "2.0.0": { tree: { "pico-cli": { stdout: help([]) } } },
  } });

  await t.test("latest registry response becomes an exact non-global package install", () => {
    const fix = valid();
    const result = runSweep(fix, ["--to", "latest"]);
    assert.equal(result.status, 1, "duplicate flags must be rejected before any process runs");
    assert.deepEqual(result.calls, []);
    const output = path.join(fix.root, "latest.json");
    const actual = spawnSync(process.execPath, [sweepScript, "--from", "1.0.0", "--to", "latest", "--output", output], {
      cwd: repoRoot, encoding: "utf8", env: { ...process.env, PATH: fix.bin, FAKE_SWEEP_CONFIG: fix.configPath, FAKE_SWEEP_LOG: fix.logPath },
    });
    assert.equal(actual.status, 0, actual.stderr);
    const calls = fs.readFileSync(fix.logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.filter((call) => call.role === "npm").map((call) => call.args), [
      ["view", "@picoxr/pico-cli@latest", "version", "dist.integrity", "--json"],
      ["install", "--prefix", calls[1].args[2], "--ignore-scripts", "--no-save", "--package-lock=false", "--fund=false", "--audit=false", "@picoxr/pico-cli@1.0.0"],
      ["install", "--prefix", calls[4].args[2], "--ignore-scripts", "--no-save", "--package-lock=false", "--fund=false", "--audit=false", "@picoxr/pico-cli@2.0.0"],
    ]);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).to.requested, "latest");
  });

  await t.test("exact scratch installs suppress package lifecycle scripts", () => {
    const fix = fixture({
      latest: "2.0.0",
      postinstallProbe: true,
      versions: {
        "1.0.0": { tree: { "pico-cli": { stdout: help([]) } } },
        "2.0.0": { tree: { "pico-cli": { stdout: help([]) } } },
      },
    });
    const result = runSweep(fix);
    assert.equal(result.status, 0, result.stderr);
    const npmCalls = result.calls.filter((call) => call.role === "npm");
    assert.deepEqual(npmCalls.map((call) => call.args), [
      ["install", "--prefix", npmCalls[0].args[2], "--ignore-scripts", "--no-save", "--package-lock=false", "--fund=false", "--audit=false", "@picoxr/pico-cli@1.0.0"],
      ["install", "--prefix", npmCalls[1].args[2], "--ignore-scripts", "--no-save", "--package-lock=false", "--fund=false", "--audit=false", "@picoxr/pico-cli@2.0.0"],
    ]);
    assert.equal(fs.existsSync(fix.postinstallMarkerPath), false, "fake package postinstall must not run");
  });

  await t.test("latest registry JSON is parsed from stdout despite an npm notice on stderr", () => {
    const fix = fixture({
      latest: "2.0.0",
      registryStderr: "npm notice New major version of npm available! 10.0.0 -> 11.0.0\\n",
      versions: {
        "1.0.0": { tree: { "pico-cli": { stdout: help([]) } } },
        "2.0.0": { tree: { "pico-cli": { stdout: help([]) } } },
      },
    });
    const output = path.join(fix.root, "notice.json");
    const result = spawnSync(process.execPath, [
      sweepScript, "--from", "1.0.0", "--to", "latest", "--output", output,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: fix.bin, FAKE_SWEEP_CONFIG: fix.configPath, FAKE_SWEEP_LOG: fix.logPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")).to, {
      requested: "latest",
      version: "2.0.0",
      commandCount: 1,
    });
  });

  await t.test("malformed registry stdout is rejected even when stderr is valid text", () => {
    const fix = valid();
    const value = JSON.parse(fs.readFileSync(fix.configPath, "utf8"));
    value.registryRaw = "{not-json";
    value.registryStderr = "npm notice This is not registry JSON\\n";
    fs.writeFileSync(fix.configPath, JSON.stringify(value));
    const output = path.join(fix.root, "malformed-stdout.json");
    const result = spawnSync(process.execPath, [
      sweepScript, "--from", "1.0.0", "--to", "latest", "--output", output,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: fix.bin, FAKE_SWEEP_CONFIG: fix.configPath, FAKE_SWEEP_LOG: fix.logPath },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /registry lookup returned malformed JSON/);
    assert.equal(fs.existsSync(output), false);
  });

  await t.test("failed registry lookup retains stderr in the surfaced error", () => {
    const fix = valid();
    const value = JSON.parse(fs.readFileSync(fix.configPath, "utf8"));
    value.registryExit = 2;
    value.registryStderr = "REGISTRY_FAILURE_MARKER_FROM_STDERR\\n";
    fs.writeFileSync(fix.configPath, JSON.stringify(value));
    const output = path.join(fix.root, "registry-error.json");
    const result = spawnSync(process.execPath, [
      sweepScript, "--from", "1.0.0", "--to", "latest", "--output", output,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: fix.bin, FAKE_SWEEP_CONFIG: fix.configPath, FAKE_SWEEP_LOG: fix.logPath },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REGISTRY_FAILURE_MARKER_FROM_STDERR/);
    assert.equal(fs.existsSync(output), false);
  });

  for (const item of [
    { name: "unknown flag", args: ["--bogus", "x"] },
    { name: "relative output", args: ["--output", "relative.json"] },
    { name: "prerelease from", args: ["--from", "1.0.0-beta.1"] },
  ]) await t.test(item.name, () => {
    const fix = valid();
    const result = runSweep(fix, item.args);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  });

  for (const item of [
    { name: "registry outage", latest: true, mutate: (fix) => fs.writeFileSync(fix.configPath, JSON.stringify({ latest: "2.0.0", registryExit: 2, versions: {} })) },
    { name: "malformed registry", latest: true, mutate: (fix) => fs.writeFileSync(fix.configPath, JSON.stringify({ latest: "2.0.0", registryRaw: "[]", versions: {} })) },
    { name: "package version mismatch", mutate: (fix) => { const value = JSON.parse(fs.readFileSync(fix.configPath)); value.versions["2.0.0"].packageVersion = "2.0.1"; fs.writeFileSync(fix.configPath, JSON.stringify(value)); } },
    { name: "reported version mismatch", mutate: (fix) => { const value = JSON.parse(fs.readFileSync(fix.configPath)); value.versions["2.0.0"].reportedVersion = "2.0.1"; fs.writeFileSync(fix.configPath, JSON.stringify(value)); } },
    { name: "install failure", mutate: (fix) => { const value = JSON.parse(fs.readFileSync(fix.configPath)); value.versions["2.0.0"].installExit = 3; fs.writeFileSync(fix.configPath, JSON.stringify(value)); } },
  ]) await t.test(item.name, () => {
    const fix = valid(); item.mutate(fix);
    const output = path.join(fix.root, "failure.json");
    const args = item.latest
      ? [sweepScript, "--from", "1.0.0", "--to", "latest", "--output", output]
      : [sweepScript, "--from", "1.0.0", "--to", "2.0.0", "--output", output];
    const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PATH: fix.bin, FAKE_SWEEP_CONFIG: fix.configPath, FAKE_SWEEP_LOG: fix.logPath } });
    assert.notEqual(result.status, 0, item.name);
    assert.equal(fs.existsSync(output), false, item.name);
  });
});

test("recognizes the advertised root command heading and fails closed when root enumeration is unavailable", async (t) => {
  await t.test("Available Commands is traversed as a complete root command section", () => {
    const rootHelp = [
      "Usage: pico-cli",
      "Available Commands:",
      "  app  Application operations",
      "  device list  List attached devices",
      "Options:",
      "  --help  Print help",
      "",
    ].join("\n");
    const tree = {
      "pico-cli": { stdout: rootHelp },
      app: { stdout: "app leaf without a command heading\n" },
      "device list": { stdout: "device list leaf without a command heading\n" },
    };
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(result.output, "utf8"));
    assert.deepEqual(report.from, { requested: "1.0.0", version: "1.0.0", commandCount: 3 });
    assert.deepEqual(report.to, { requested: "2.0.0", version: "2.0.0", commandCount: 3 });
    assert.deepEqual(report.unchangedCommands, ["app", "device list", "pico-cli"]);
  });

  for (const item of [
    {
      name: "missing heading",
      rootHelp: "Usage: pico-cli\nOptions:\n  --help  Print help\n",
      errorPattern: /recognized root command heading/,
    },
    {
      name: "unrecognized heading",
      rootHelp: "Usage: pico-cli\nSubcommands:\n  app  Application operations\nOptions:\n  --help  Print help\n",
      errorPattern: /unrecognized command-section-like heading/,
    },
  ]) await t.test(item.name, () => {
    const tree = { "pico-cli": { stdout: item.rootHelp }, app: { stdout: "must not be reached\n" } };
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, item.errorPattern);
    assert.equal(fs.existsSync(result.output), false);
    assert.deepEqual(result.calls.filter((call) => call.role === "cli").map((call) => call.args), [["-v"], ["--help"]]);
  });

  await t.test("an unrecognized nested command-like heading fails closed", () => {
    const tree = {
      "pico-cli": { stdout: help(["app  Application operations"]) },
      app: {
        stdout: [
          "Usage: pico-cli app",
          "  Subcommands:",
          "    build  Build an application",
          "  Options:",
          "    --help  Print help",
          "",
        ].join("\n"),
      },
      "app build": { stdout: "must not be reached\n" },
    };
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrecognized command-section-like heading/);
    assert.equal(fs.existsSync(result.output), false);
    assert.deepEqual(result.calls.filter((call) => call.role === "cli").map((call) => call.args), [
      ["-v"],
      ["--help"],
      ["app", "--help"],
    ]);
  });

  await t.test("an indented recognized nested command heading is traversed", () => {
    const tree = {
      "pico-cli": { stdout: help(["app  Application operations"]) },
      app: {
        stdout: [
          "Usage: pico-cli app",
          "  Commands:",
          "    build  Build an application",
          "  Options:",
          "    --help  Print help",
          "",
        ].join("\n"),
      },
      "app build": { stdout: "Usage: pico-cli app build\n" },
    };
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.output, "utf8")).unchangedCommands, [
      "app",
      "app build",
      "pico-cli",
    ]);
  });

  await t.test("a same-indent row under an indented command heading fails closed", () => {
    const tree = {
      "pico-cli": { stdout: help(["app  Application operations"]) },
      app: {
        stdout: [
          "Usage: pico-cli app",
          "  Commands:",
          "  build  Build an application",
          "  Options:",
          "    --help  Print help",
          "",
        ].join("\n"),
      },
      "app build": { stdout: "must not be reached\n" },
    };
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported command-section indentation or boundary/);
    assert.equal(fs.existsSync(result.output), false);
    assert.deepEqual(result.calls.filter((call) => call.role === "cli").map((call) => call.args), [
      ["-v"],
      ["--help"],
      ["app", "--help"],
    ]);
  });

  await t.test("a nested leaf without any command heading remains a valid leaf", () => {
    const tree = {
      "pico-cli": { stdout: help(["app  Application operations"]) },
      app: { stdout: "Usage: pico-cli app\nOptions:\n  --help  Print help\n" },
    };
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.output, "utf8")).unchangedCommands, ["app", "pico-cli"]);
  });
});

test("fails closed at depth eight and 256 help invocations", async (t) => {
  await t.test("depth overflow", () => {
    const tree = { "pico-cli": { stdout: help(["d1  next"]) } };
    for (let depth = 1; depth <= 9; depth += 1) {
      const key = Array.from({ length: depth }, (_, index) => `d${index + 1}`).join(" ");
      tree[key] = { stdout: depth === 9 ? "leaf\n" : help([`d${depth + 1}  next`]) };
    }
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(result.output), false);
    assert.ok(result.calls.some((call) => call.role === "cli" && call.args.join(" ") === "d1 d2 d3 d4 d5 d6 d7 d8 --help"));
    assert.equal(result.calls.some((call) => call.role === "cli" && call.args.join(" ").includes("d9 --help")), false);
  });

  await t.test("command-count overflow", () => {
    const rows = Array.from({ length: 256 }, (_, index) => `c${String(index).padStart(3, "0")}  child`);
    const tree = { "pico-cli": { stdout: help(rows) } };
    for (let index = 0; index < 256; index += 1) tree[`c${String(index).padStart(3, "0")}`] = { stdout: "leaf\n" };
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(result.output), false);
    assert.ok(result.calls.filter((call) => call.role === "cli" && call.version === "1.0.0" && call.args.at(-1) === "--help").length <= 256);
  });
});

test("fails closed when a minimum-indent advertised command row uses unsupported grammar", async (t) => {
  const cases = [
    { name: "alias syntax", rows: ["foo|f  Alias row"] },
    { name: "unsupported punctuation", rows: ["foo.bar  Dotted row"] },
    { name: "mixed valid and unsupported rows", rows: ["safe  Valid row", "bad|b  Unsupported alias"], tree: { safe: { stdout: "safe leaf\n" } } },
  ];
  for (const item of cases) await t.test(item.name, () => {
    const tree = { "pico-cli": { stdout: help(item.rows) }, ...(item.tree ?? {}) };
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.notEqual(result.status, 0, `${item.name} must make the advertised tree incomplete`);
    assert.equal(fs.existsSync(result.output), false, `${item.name} must not publish a partial report`);
    const cliArgv = result.calls.filter((call) => call.role === "cli").map((call) => call.args);
    assert.deepEqual(cliArgv, [["-v"], ["--help"]], `${item.name} must fail before traversing any partial child set`);
  });
});

test("an indented Options heading terminates the Commands section without becoming a command", () => {
  const rootHelp = [
    "Usage: pico-cli",
    "Commands:",
    "  safe  Description may mention foo|f and foo.bar",
    "        wrapped description may also mention bad|b",
    "  plugin:doctor  Colon command remains valid",
    "  Options:",
    "    optionrow  Must remain outside Commands",
    "",
  ].join("\n");
  const tree = {
    "pico-cli": { stdout: rootHelp },
    safe: { stdout: "safe leaf\n" },
    "plugin:doctor": { stdout: "colon leaf\n" },
  };
  const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
  const result = runSweep(fix);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(result.output, "utf8"));
  assert.deepEqual(report.from, { requested: "1.0.0", version: "1.0.0", commandCount: 3 });
  assert.deepEqual(report.to, { requested: "2.0.0", version: "2.0.0", commandCount: 3 });
  const cliArgv = result.calls.filter((call) => call.role === "cli").map((call) => call.args.join(" "));
  assert.equal(cliArgv.includes("safe --help"), true);
  assert.equal(cliArgv.includes("plugin:doctor --help"), true);
  assert.equal(cliArgv.some((argv) => argv.startsWith("Options:")), false);
  assert.equal(cliArgv.some((argv) => argv.includes("optionrow")), false);
});

test("multi-token advertised commands become separate argv tokens with notation stripped and paths deduplicated", () => {
  const rootHelp = help([
    "sync  Sync namespace",
    "sync component  Sync component data without traversing description words",
    "sync asset <source> [target]  Sync asset data with required and optional arguments",
    "sync component  Duplicate compound path",
    "setup component  Prohibited multi-token setup subtree",
  ]);
  const tree = {
    "pico-cli": { stdout: rootHelp },
    sync: { stdout: help(["component  Duplicate path advertised by its ancestor"]) },
    "sync component": { stdout: "sync component leaf\n" },
    "sync asset": { stdout: "sync asset leaf\n" },
  };
  const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
  const result = runSweep(fix);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(result.output, "utf8"));
  assert.deepEqual(report.from, { requested: "1.0.0", version: "1.0.0", commandCount: 4 });
  assert.deepEqual(report.to, { requested: "2.0.0", version: "2.0.0", commandCount: 4 });
  assert.deepEqual(report.unchangedCommands, ["pico-cli", "sync", "sync asset", "sync component"]);

  for (const version of ["1.0.0", "2.0.0"]) {
    const helpArgv = result.calls
      .filter((call) => call.role === "cli" && call.version === version && call.args.at(-1) === "--help")
      .map((call) => call.args);
    assert.deepEqual(helpArgv, [
      ["--help"],
      ["sync", "--help"],
      ["sync", "asset", "--help"],
      ["sync", "component", "--help"],
    ]);
    assert.equal(helpArgv.filter((argv) => argv.join(" ") === "sync component --help").length, 1);
    assert.equal(helpArgv.some((argv) => argv[0] === "setup"), false);
    assert.equal(helpArgv.some((argv) => argv.includes("<source>") || argv.includes("[target]")), false);
    assert.equal(helpArgv.some((argv) => argv.some((token) => /^(Sync|data|without|traversing|description|words)$/.test(token))), false);
  }
});

test("unsafe grammar anywhere in multi-token syntax fails before partial child traversal", async (t) => {
  const cases = [
    { name: "alias in first token", row: "bad|b child  Unsupported alias" },
    { name: "alias in later token", row: "bad child|c  Unsupported alias" },
    { name: "punctuation in middle token", row: "bad child.name leaf  Unsupported punctuation" },
    { name: "more than eight command tokens", row: "a b c d e f g h i  Overlong path" },
  ];
  for (const item of cases) await t.test(item.name, () => {
    const tree = {
      "pico-cli": { stdout: help(["safe  Valid row before invalid grammar", item.row]) },
      safe: { stdout: "safe leaf must never be visited\n" },
    };
    const fix = fixture({ latest: "2.0.0", versions: { "1.0.0": { tree }, "2.0.0": { tree } } });
    const result = runSweep(fix);
    assert.notEqual(result.status, 0, `${item.name} must make the advertised tree incomplete`);
    assert.equal(fs.existsSync(result.output), false, `${item.name} must not publish a partial report`);
    const cliArgv = result.calls.filter((call) => call.role === "cli").map((call) => call.args);
    assert.deepEqual(cliArgv, [["-v"], ["--help"]], `${item.name} must fail before traversing the valid row`);
  });
});

test("timeout, spawn failure, and output truncation are fatal and atomic output is never ambiguous", async (t) => {
  function failing(entry) {
    return fixture({ latest: "2.0.0", versions: {
      "1.0.0": { tree: { "pico-cli": entry } }, "2.0.0": { tree: { "pico-cli": { stdout: help([]) } } },
    } });
  }

  await t.test("timeout", () => {
    const fix = failing({ hangMs: 10_000 });
    const result = runSweep(fix, [], { PICO_CLI_SWEEP_TIMEOUT_MS: "50" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /timed out/);
    assert.equal(fs.existsSync(result.output), false);
  });

  await t.test("timeout hard-settles and reaps a detached descendant that inherited stdio", () => {
    const fix = failing({
      hangMs: 10_000,
      spawnDetachedInheritedStdioMs: 10_000,
      stderr: "DETACHED_DESCENDANT_TIMEOUT_OUTPUT\n",
    });
    const startedAt = Date.now();
    let descendantPid = null;
    try {
      const result = runSweep(fix, [], {
        PICO_CLI_SWEEP_TIMEOUT_MS: "1500",
        PICO_CLI_SWEEP_KILL_GRACE_MS: "50",
      }, 4_000);
      const elapsedMs = Date.now() - startedAt;
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /timed out/);
      assert.match(result.stderr, /DETACHED_DESCENDANT_TIMEOUT_OUTPUT/);
      assert.ok(elapsedMs < 3_000, `sweep settled after ${elapsedMs}ms instead of its timeout plus bounded grace`);
      assert.equal(fs.existsSync(result.output), false);
      assert.equal(fs.existsSync(fix.descendantPidPath), true, "fixture descendant was not created");
      descendantPid = Number(fs.readFileSync(fix.descendantPidPath, "utf8"));
      assert.equal(waitForPidExit(descendantPid, 750), true, `detached descendant ${descendantPid} survived sweep cleanup`);
    } finally {
      forceKillFixtureProcesses(fix);
    }
  });

  await t.test("truncation", () => {
    const fix = failing({ stdout: "x".repeat(2_000) });
    const result = runSweep(fix, [], { PICO_CLI_SWEEP_MAX_OUTPUT_BYTES: "256" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeded the output capture limit/);
    assert.match(result.stderr, /x{64}/, "retained capped output must remain visible in the diagnostic");
    assert.equal(fs.existsSync(result.output), false);
  });

  await t.test("output cap reaps a detached inherited-stdio descendant after its parent exits", () => {
    const fix = failing({
      spawnDetachedInheritedStdioMs: 10_000,
      stdout: "FAST_EXIT_OUTPUT_CAP_MARKER\n" + "x".repeat(2_000),
    });
    let descendantPid = null;
    try {
      const result = runSweep(fix, [], {
        PICO_CLI_SWEEP_KILL_GRACE_MS: "50",
        PICO_CLI_SWEEP_MAX_OUTPUT_BYTES: "256",
      }, 2_500);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /exceeded the output capture limit/);
      assert.match(result.stderr, /FAST_EXIT_OUTPUT_CAP_MARKER/);
      assert.equal(fs.existsSync(result.output), false);
      assert.equal(fs.existsSync(fix.descendantPidPath), true, "fixture descendant was not created");
      descendantPid = Number(fs.readFileSync(fix.descendantPidPath, "utf8"));
      assert.equal(waitForPidExit(descendantPid, 750), true, `detached descendant ${descendantPid} survived output-cap cleanup`);
    } finally {
      forceKillFixtureProcesses(fix);
    }
  });

  await t.test("signal termination", () => {
    const fix = failing({ signal: "SIGTERM" });
    const result = runSweep(fix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /terminated without an exit code \(SIGTERM\)/);
    assert.equal(fs.existsSync(result.output), false);
  });

  await t.test("npm spawn error", () => {
    const fix = failing({ stdout: help([]) });
    const emptyBin = path.join(fix.root, "empty-bin"); fs.mkdirSync(emptyBin);
    const result = runSweep({ ...fix, bin: emptyBin });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not start/);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(fs.existsSync(result.output), false);
  });

  await t.test("a preexisting output is preserved and no atomic temporary is leaked", () => {
    const fix = failing({ stdout: help([]) });
    const output = path.join(fix.root, "report.json");
    fs.writeFileSync(output, "keep me");
    const result = runSweep(fix);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(output, "utf8"), "keep me");
    assert.deepEqual(fs.readdirSync(fix.root).filter((name) => name.includes("report.json.tmp")), []);
    assert.deepEqual(result.calls, []);
  });
});
