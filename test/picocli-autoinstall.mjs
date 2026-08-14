// Lazy pico-cli provisioning: present / absent-off / install / update / classified failure / bound.
// All commands are fakes on an isolated PATH; this test never contacts npm or a device.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPicoCliProvisionFailure,
  ensurePicoCli,
  executableCandidates,
  picoCliFromEnsure,
  probePicoCli,
  PICO_CLI_AUTOINSTALL_ENV,
  PICO_CLI_AUTOUPDATE_ENV,
  PICO_CLI_INSTALL_TIMEOUT_MS,
} from "../dist/picocli.js";
import { registerPicoCliHealthTool } from "../dist/picoclihealth.js";
import { registerPicoCliTools } from "../dist/picoclitools.js";
import { runPerfDiagnose } from "../dist/perfcli.js";
import {
  inspectManagedPicoCli,
  resolvePicoCliPolicy,
  PICO_CLI_PATH_ENV,
  PICO_CLI_POLICY_ENV,
} from "../dist/picoclimanaged.js";

const savedEnv = new Map();
const tempRoots = [];
const trackedEnv = [
  "PATH",
  "Path",
  PICO_CLI_AUTOINSTALL_ENV,
  PICO_CLI_AUTOUPDATE_ENV,
  "PICO_TEST_FULL_ENV",
  "FAKE_PICO_STATE",
  "FAKE_PICO_LOG",
  "FAKE_PICO_BIN",
  "FAKE_PICO_CLI_TEMPLATE",
  "FAKE_PICO_CLI_TARGET",
  "FAKE_PICO_PREFIX",
  "FAKE_NPM_MODE",
  "FAKE_LATEST_VERSION",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function saveEnvironment() {
  for (const key of trackedEnv) savedEnv.set(key, process.env[key]);
}

function restoreEnvironment() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeCommand(binDir, name, driverPath, role) {
  if (process.platform === "win32") {
    const command = path.join(binDir, `${name}.cmd`);
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${driverPath}" ${role} %*\r\n`);
    return command;
  }
  const command = path.join(binDir, name);
  fs.writeFileSync(command, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(driverPath)} ${shQuote(role)} "$@"\n`, { mode: 0o755 });
  return command;
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function createHarness({
  installedVersion = null,
  cliPresent = installedVersion !== null,
  npmMode = "success",
  latestVersion = "0.3.0",
  separateGlobalBin = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico cli auto "));
  tempRoots.push(root);
  const binDir = path.join(root, "bin");
  const templateDir = path.join(root, "template");
  const globalPrefix = path.join(root, "global-prefix");
  const cliBinDir = separateGlobalBin
    ? (process.platform === "win32" ? globalPrefix : path.join(globalPrefix, "bin"))
    : binDir;
  const statePath = path.join(root, "installed.version");
  const logPath = path.join(root, "calls.jsonl");
  const driverPath = path.join(root, "fake-command.mjs");
  fs.mkdirSync(binDir);
  fs.mkdirSync(templateDir);
  if (separateGlobalBin) fs.mkdirSync(cliBinDir, { recursive: true });
  if (installedVersion) fs.writeFileSync(statePath, installedVersion);
  fs.writeFileSync(driverPath, `
import fs from "node:fs";
import { spawn } from "node:child_process";
const [role, ...args] = process.argv.slice(2);
const state = process.env.FAKE_PICO_STATE;
const log = process.env.FAKE_PICO_LOG;
const record = (extra = {}) => fs.appendFileSync(log, JSON.stringify({ role, args, sentinel: process.env.PICO_TEST_FULL_ENV ?? null, ...extra }) + "\\n");
record();
if (role === "cli") {
  if (!fs.existsSync(state)) { process.stderr.write("pico-cli absent\\n"); process.exit(127); }
  const version = fs.readFileSync(state, "utf8").trim();
  if (args[0] === "-v") process.stdout.write("pico-cli/" + version + " (fake)\\n");
  else process.stdout.write("fake pico-cli operation complete\\n");
  process.exit(0);
}
if (args[0] === "prefix" && args[1] === "-g") {
  process.stdout.write(process.env.FAKE_PICO_PREFIX + "\\n");
  process.exit(0);
}
if (args[0] === "view") {
  process.stdout.write(JSON.stringify(process.env.FAKE_LATEST_VERSION) + "\\n");
  process.exit(0);
}
if (args[0] === "install") {
  const mode = process.env.FAKE_NPM_MODE;
  if (mode === "hang") {
    process.on("SIGTERM", () => {});
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),2500); setInterval(()=>{},1000)"], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    record({ event: "descendant", descendantPid: descendant.pid });
    descendant.unref();
    await new Promise(() => { setInterval(() => {}, 1_000); });
  }
  else if (mode === "network") { process.stderr.write("npm ERR! code ENETUNREACH network request failed\\n"); process.exit(1); }
  else if (mode === "permissions") { process.stderr.write("npm ERR! code EACCES permission denied\\n"); process.exit(1); }
  else if (mode === "registry-404") { process.stderr.write("npm ERR! code E404 404 Not Found - not in this registry\\n"); process.exit(1); }
  else if (mode === "no-cli") { process.stdout.write("npm claimed success without a CLI\\n"); process.exit(0); }
  else if (mode === "update-noop") { process.stdout.write("npm claimed update success without changing pico-cli\\n"); process.exit(0); }
  else {
    fs.copyFileSync(process.env.FAKE_PICO_CLI_TEMPLATE, process.env.FAKE_PICO_CLI_TARGET);
    if (process.platform !== "win32") fs.chmodSync(process.env.FAKE_PICO_CLI_TARGET, 0o755);
    fs.writeFileSync(state, process.env.FAKE_LATEST_VERSION);
    process.stdout.write("installed fake pico-cli\\n");
    process.exit(0);
  }
}
process.stderr.write("unexpected fake npm argv: " + JSON.stringify(args) + "\\n");
process.exit(2);
`);
  const cliTemplate = writeCommand(templateDir, "pico-cli", driverPath, "cli");
  const cliTarget = path.join(cliBinDir, process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
  if (cliPresent) {
    fs.copyFileSync(cliTemplate, cliTarget);
    if (process.platform !== "win32") fs.chmodSync(cliTarget, 0o755);
  }
  writeCommand(binDir, "npm", driverPath, "npm");
  const pathKey = process.platform === "win32" ? (Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path") : "PATH";
  const supportPath = process.platform === "win32"
    ? [path.win32.dirname(process.env.ComSpec ?? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`)]
    : [];
  process.env[pathKey] = [binDir, ...supportPath].join(path.delimiter);
  process.env.FAKE_PICO_STATE = statePath;
  process.env.FAKE_PICO_LOG = logPath;
  process.env.FAKE_PICO_BIN = binDir;
  process.env.FAKE_PICO_CLI_TEMPLATE = cliTemplate;
  process.env.FAKE_PICO_CLI_TARGET = cliTarget;
  process.env.FAKE_PICO_PREFIX = separateGlobalBin
    ? globalPrefix
    : (process.platform === "win32" ? binDir : root);
  process.env.FAKE_NPM_MODE = npmMode;
  process.env.FAKE_LATEST_VERSION = latestVersion;
  process.env.PICO_TEST_FULL_ENV = "full-env-reached-child";
  delete process.env[PICO_CLI_AUTOINSTALL_ENV];
  delete process.env[PICO_CLI_AUTOUPDATE_ENV];
  probePicoCli(true);
  fs.writeFileSync(logPath, "");
  return { root, binDir, cliBinDir, statePath, logPath, cliTarget, calls: () => readLog(logPath) };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} still exists ${timeoutMs}ms after taskkill completed`);
}

saveEnvironment();

test("pico-cli auto-install contract", { concurrency: false, timeout: 45_000 }, async (t) => {
  await t.test("Windows PATH candidates include npm-style .CMD shims and preserve spaces", () => {
    assert.equal(PICO_CLI_INSTALL_TIMEOUT_MS, 120_000);
    const candidates = executableCandidates("pico-cli", {
      Path: "C:\\Program Files\\npm;D:\\portable npm",
      PATHEXT: ".EXE;.CMD",
    }, "win32");
    assert.ok(candidates.includes("C:\\Program Files\\npm\\pico-cli.CMD"), JSON.stringify(candidates));
    assert.ok(candidates.includes("D:\\portable npm\\pico-cli.CMD"), JSON.stringify(candidates));
  });

  await t.test("present is a fast no-op and missing with default OFF preserves the old degrade", async () => {
    const present = createHarness({ installedVersion: "0.3.0" });
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const found = await ensurePicoCli();
    assert.equal(found.status, "ok");
    assert.equal(found.action, "present");
    assert.equal(found.version, "0.3.0");
    assert.equal(present.calls().filter((call) => call.role === "npm").length, 0);
    await nextTurn();

    const missing = createHarness();
    const unavailable = await runPerfDiagnose("com.example.absent", { durationSec: 5 });
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.failureClass, "cli-missing");
    assert.match(unavailable.note, /npm install -g @picoxr\/pico-cli/);
    assert.equal(missing.calls().filter((call) => call.role === "npm").length, 0);
    assert.ok(missing.calls().every((call) => !call.args.some((arg) => /doctor/.test(arg))), JSON.stringify(missing.calls()));
    await nextTurn();
  });

  await t.test("a present but unusable CLI is not overwritten by missing-only auto-install", async () => {
    const harness = createHarness({ cliPresent: true });
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const unusable = await ensurePicoCli();
    assert.equal(unusable.status, "unavailable", JSON.stringify(unusable));
    assert.equal(unusable.action, "skipped");
    assert.equal(unusable.failureClass, "cli-unusable");
    // Windows resolves the shim via PATHEXT and may report the extension in PATHEXT's
    // canonical casing (.CMD) while the fixture wrote .cmd — same file on a
    // case-insensitive filesystem, so compare accordingly there.
    if (process.platform === "win32") {
      assert.equal(String(unusable.path).toLowerCase(), String(harness.cliTarget).toLowerCase());
    } else {
      assert.equal(unusable.path, harness.cliTarget);
    }
    const calls = harness.calls();
    assert.equal(calls.filter((call) => call.role === "npm").length, 0, JSON.stringify(calls));
    assert.ok(calls.some((call) => call.role === "cli" && call.args.length === 1 && call.args[0] === "-v"), JSON.stringify(calls));
    assert.ok(calls.every((call) => !call.args.some((arg) => /doctor/.test(arg))), JSON.stringify(calls));
    await nextTurn();
  });

  await t.test("AUTOUPDATE alone does not install a missing CLI", async () => {
    const harness = createHarness();
    process.env[PICO_CLI_AUTOUPDATE_ENV] = "1";
    const missing = await ensurePicoCli();
    assert.equal(missing.status, "unavailable", JSON.stringify(missing));
    assert.equal(missing.failureClass, "cli-missing");
    assert.equal(harness.calls().filter((call) => call.role === "npm").length, 0, JSON.stringify(harness.calls()));
    await nextTurn();
  });

  await t.test("explicit ensure installs once, re-probes with -v, and receives the full env", async () => {
    const harness = createHarness({ separateGlobalBin: true });
    const handlers = {};
    registerPicoCliHealthTool({ registerTool: (name, _meta, handler) => { handlers[name] = handler; } });
    assert.deepEqual(Object.keys(handlers), ["ensure_pico_cli"]);
    assert.equal(harness.calls().length, 0, "registration/import must not start npm");
    const toolResult = await handlers.ensure_pico_cli({});
    const ensured = JSON.parse(toolResult.content[0].text);
    assert.equal(ensured.status, "ok");
    assert.equal(ensured.action, "installed");
    assert.equal(ensured.version, "0.3.0");
    const calls = harness.calls();
    const installs = calls.filter((call) => call.role === "npm" && call.args[0] === "install");
    assert.equal(installs.length, 1, JSON.stringify(calls));
    assert.deepEqual(installs[0].args, ["install", "-g", "@picoxr/pico-cli"]);
    assert.equal(installs[0].sentinel, "full-env-reached-child");
    assert.ok(calls.some((call) => call.role === "npm" && call.args.join(" ") === "prefix -g"), JSON.stringify(calls));
    assert.equal((process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)[0], harness.cliBinDir);
    const reProbes = calls.filter((call) => call.role === "cli" && call.args.length === 1 && call.args[0] === "-v");
    assert.ok(reProbes.length > 0, JSON.stringify(calls));
    assert.ok(reProbes.every((call) => call.sentinel === "full-env-reached-child"), JSON.stringify(reProbes));
    assert.ok(calls.every((call) => !call.args.some((arg) => /doctor/.test(arg))), JSON.stringify(calls));
    await nextTurn();
  });

  await t.test("full server startup under AUTOINSTALL registers CLI tools without running npm", async () => {
    const harness = createHarness();
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "dist", "index.js")],
      cwd: repoRoot,
      env: { ...process.env, PICO_MCP_SURFACE: "full" },
    });
    const client = new Client({ name: "pico-cli-no-startup-install", version: "1" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "ensure_pico_cli"));
      assert.ok(listed.tools.some((tool) => tool.name === "perf_trace"), "full-only CLI tool must register without provisioning");
    } finally {
      await client.close().catch(() => {});
    }
    assert.equal(harness.calls().filter((call) => call.role === "npm").length, 0, JSON.stringify(harness.calls()));
    await nextTurn();
  });

  await t.test("watch_crash installs lazily under the env opt-in and continues in the same call", async () => {
    const harness = createHarness();
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const handlers = {};
    registerPicoCliTools({ registerTool: (name, _meta, handler) => { handlers[name] = handler; } });
    const result = await handlers.watch_crash({ packageName: "com.example.fake", durationSec: 5 });
    const out = JSON.parse(result.content[0].text);
    assert.equal(out.status, "ok", JSON.stringify(out));
    assert.equal(out.cliProvisioning.action, "installed");
    assert.equal(out.cliProvisioning.version, "0.3.0");
    const calls = harness.calls();
    assert.equal(calls.filter((call) => call.role === "npm" && call.args[0] === "install").length, 1);
    const watchCall = calls.find((call) => call.role === "cli" && call.args.slice(0, 2).join(" ") === "app watch-crash");
    assert.ok(watchCall, JSON.stringify(calls));
    assert.equal(watchCall.sentinel, "full-env-reached-child");
    assert.ok(calls.filter((call) => call.role === "cli").every((call) => call.sentinel === "full-env-reached-child"), JSON.stringify(calls));
    await nextTurn();
  });

  await t.test("concurrent callers share one global install", async () => {
    const harness = createHarness();
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const [left, right] = await Promise.all([ensurePicoCli(), ensurePicoCli()]);
    assert.equal(left.action, "installed");
    assert.equal(right.action, "installed");
    assert.equal(harness.calls().filter((call) => call.role === "npm" && call.args[0] === "install").length, 1);
    await nextTurn();
  });

  await t.test("stronger concurrent waiters are not suppressed by a weaker in-flight result", async () => {
    const installHarness = createHarness();
    const [weakInstall, strongInstall] = await Promise.all([
      ensurePicoCli(),
      ensurePicoCli({ explicit: true }),
    ]);
    assert.equal(weakInstall.action, "skipped", JSON.stringify(weakInstall));
    assert.equal(strongInstall.action, "installed", JSON.stringify(strongInstall));
    assert.equal(installHarness.calls().filter((call) => call.role === "npm" && call.args[0] === "install").length, 1);
    await nextTurn();

    const updateHarness = createHarness({ installedVersion: "0.1.0", latestVersion: "0.1.1" });
    const [weakUpdate, strongUpdate] = await Promise.all([
      ensurePicoCli(),
      ensurePicoCli({ explicit: true, update: true }),
    ]);
    assert.equal(weakUpdate.action, "present", JSON.stringify(weakUpdate));
    assert.equal(strongUpdate.action, "updated", JSON.stringify(strongUpdate));
    assert.equal(updateHarness.calls().filter((call) => call.role === "npm" && call.args[0] === "view").length, 1);
    assert.equal(updateHarness.calls().filter((call) => call.role === "npm" && call.args[0] === "install").length, 1);
    await nextTurn();

    const repairHarness = createHarness({ cliPresent: true, latestVersion: "0.3.0" });
    const [weakRepair, strongRepair] = await Promise.all([
      ensurePicoCli(),
      ensurePicoCli({ update: true }),
    ]);
    assert.equal(weakRepair.failureClass, "cli-unusable", JSON.stringify(weakRepair));
    assert.equal(strongRepair.action, "updated", JSON.stringify(strongRepair));
    assert.equal(repairHarness.calls().filter((call) => call.role === "npm" && call.args[0] === "install").length, 1);
    await nextTurn();
  });

  await t.test("install failures are classified and a hung npm settles at the hard bound", { timeout: 10_000 }, async () => {
    const networkHarness = createHarness({ npmMode: "network" });
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const network = await ensurePicoCli({ installTimeoutMs: 2_000, killGraceMs: 25 });
    assert.equal(network.status, "failed");
    assert.equal(network.action, "failed");
    assert.equal(network.failureClass, "network");
    assert.match(network.outputTail, /ENETUNREACH/);
    assert.equal(networkHarness.calls().filter((call) => call.role === "npm").length, 1);
    await nextTurn();

    const wrapperHarness = createHarness({ npmMode: "network" });
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const handlers = {};
    registerPicoCliTools({ registerTool: (name, _meta, handler) => { handlers[name] = handler; } });
    const wrapperFailure = JSON.parse((await handlers.watch_crash({ packageName: "com.example.fake", durationSec: 5 })).content[0].text);
    assert.equal(wrapperFailure.status, "unavailable", JSON.stringify(wrapperFailure));
    assert.equal(wrapperFailure.failureClass, "network");
    assert.equal(wrapperFailure.cliProvisioning?.phase, "install");
    assert.equal(wrapperHarness.calls().filter((call) => call.role === "npm" && call.args[0] === "install").length, 1);
    await nextTurn();

    createHarness({ npmMode: "no-cli" });
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const missingAfterSuccess = await ensurePicoCli({ installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000, killGraceMs: 25 });
    assert.equal(missingAfterSuccess.status, "failed");
    assert.equal(missingAfterSuccess.failureClass, "postinstall-probe-failed");
    assert.equal(missingAfterSuccess.phase, "postinstall-probe");
    await nextTurn();

    const hungHarness = createHarness({ npmMode: "hang" });
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const started = Date.now();
    const hung = await ensurePicoCli({ installTimeoutMs: 300, killGraceMs: 25 });
    const elapsed = Date.now() - started;
    assert.equal(hung.status, "failed");
    assert.equal(hung.failureClass, "timeout");
    assert.equal(hung.timedOut, true);
    assert.ok(elapsed < 3_000, `timeout took ${elapsed}ms`);
    assert.ok(hungHarness.calls().every((call) => !call.args.some((arg) => /doctor/.test(arg))), JSON.stringify(hungHarness.calls()));
    if (process.platform === "win32") {
      const descendantPid = hungHarness.calls().find((call) => call.event === "descendant")?.descendantPid;
      assert.equal(typeof descendantPid, "number", JSON.stringify(hungHarness.calls()));
      await waitForProcessExit(descendantPid);
    }
    assert.equal(classifyPicoCliProvisionFailure({ code: 1, signal: null, stdout: "", stderr: "EACCES permission denied", timedOut: false, outputTruncated: false }), "permissions");
    assert.equal(classifyPicoCliProvisionFailure({ code: 1, signal: null, stdout: "", stderr: "E404 404 Not Found - not in this registry", timedOut: false, outputTruncated: false }), "registry-404");
    assert.equal(classifyPicoCliProvisionFailure({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: "spawn npm ENOENT", outputTruncated: false }), "npm-unavailable");
    assert.equal(classifyPicoCliProvisionFailure({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: "spawn npm EACCES: permission denied", outputTruncated: false }), "permissions");
    await nextTurn();
  });

  await t.test("a successful npm update that leaves the old version is a failed postinstall probe but keeps the CLI usable", async () => {
    const harness = createHarness({ installedVersion: "0.2.5", latestVersion: "0.2.6", npmMode: "update-noop" });
    process.env[PICO_CLI_AUTOUPDATE_ENV] = "1";
    const unchanged = await ensurePicoCli({ installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000, killGraceMs: 25 });
    assert.equal(unchanged.status, "failed", JSON.stringify(unchanged));
    assert.equal(unchanged.phase, "postinstall-probe");
    assert.equal(unchanged.failureClass, "postinstall-probe-failed");
    assert.equal(unchanged.previousVersion, "0.2.5");
    assert.equal(unchanged.latestVersion, "0.2.6");
    assert.equal(unchanged.version, "0.2.5");
    assert.equal(picoCliFromEnsure(unchanged)?.version, "0.2.5");
    const calls = harness.calls();
    assert.equal(calls.filter((call) => call.role === "npm" && call.args[0] === "view").length, 1, JSON.stringify(calls));
    assert.equal(calls.filter((call) => call.role === "npm" && call.args[0] === "install").length, 1, JSON.stringify(calls));
    assert.ok(calls.some((call) => call.role === "cli" && call.args[0] === "-v"), JSON.stringify(calls));
    await nextTurn();
  });

  await t.test("auto-install never updates; the separate update opt-in updates only when stale", async () => {
    const harness = createHarness({ installedVersion: "0.2.0", latestVersion: "0.3.0" });
    process.env[PICO_CLI_AUTOINSTALL_ENV] = "1";
    const installOnly = await ensurePicoCli();
    assert.equal(installOnly.action, "present");
    assert.equal(harness.calls().filter((call) => call.role === "npm").length, 0);
    await nextTurn();

    process.env[PICO_CLI_AUTOUPDATE_ENV] = "1";
    const updated = await ensurePicoCli();
    assert.equal(updated.status, "ok", JSON.stringify(updated));
    assert.equal(updated.action, "updated");
    assert.equal(updated.previousVersion, "0.2.0");
    assert.equal(updated.version, "0.3.0");
    const calls = harness.calls();
    assert.equal(calls.filter((call) => call.role === "npm" && call.args[0] === "view").length, 1);
    assert.deepEqual(calls.find((call) => call.role === "npm" && call.args[0] === "install").args, ["install", "-g", "@picoxr/pico-cli@latest"]);
    assert.ok(calls.every((call) => !call.args.some((arg) => /doctor/.test(arg))), JSON.stringify(calls));
    await nextTurn();
  });
});

test("managed pico-cli policy and immutable-store inspection", { concurrency: false }, async (t) => {
  await t.test("policy parsing rejects contradictory configuration", () => {
    const cases = [
      [{}, { status: "ok", policy: "managed-latest", externalPath: null, deprecatedAliases: [] }],
      [{ [PICO_CLI_POLICY_ENV]: "disabled" }, { status: "ok", policy: "disabled", externalPath: null, deprecatedAliases: [] }],
      [{ [PICO_CLI_POLICY_ENV]: "external" }, { status: "invalid", policy: null, externalPath: null, deprecatedAliases: [] }],
      [{ [PICO_CLI_POLICY_ENV]: "external", [PICO_CLI_PATH_ENV]: "relative/pico-cli" }, { status: "invalid", policy: null, externalPath: null, deprecatedAliases: [] }],
      [{ [PICO_CLI_POLICY_ENV]: "managed-cached", PICO_MCP_AUTOUPDATE_CLI: "1" }, { status: "invalid", policy: null, externalPath: null, deprecatedAliases: ["PICO_MCP_AUTOUPDATE_CLI"] }],
    ];
    for (const [env, expected] of cases) {
      const actual = resolvePicoCliPolicy(env, "linux");
      assert.equal(actual.status, expected.status, JSON.stringify(actual));
      assert.equal(actual.policy, expected.policy, JSON.stringify(actual));
      assert.equal(actual.externalPath, expected.externalPath, JSON.stringify(actual));
      assert.deepEqual(actual.deprecatedAliases, expected.deprecatedAliases);
    }
    for (const policy of [undefined, "managed-latest", "managed-cached", "disabled"]) {
      const env = {
        ...(policy ? { [PICO_CLI_POLICY_ENV]: policy } : {}),
        [PICO_CLI_PATH_ENV]: "/absolute/cli-that-must-not-be-used",
      };
      assert.equal(resolvePicoCliPolicy(env, "linux").status, "invalid");
    }
  });

  function managedFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico managed cli "));
    tempRoots.push(root);
    const managedRoot = path.join(root, "managed");
    const versionsRoot = path.join(managedRoot, "versions");
    const responses = new Map();
    const calls = [];
    const publish = (version, { recordVersion = version, packageVersion = version, cliVersion = version, relativeCliPath = "bin/pico-cli", recordText } = {}) => {
      const versionRoot = path.join(versionsRoot, version);
      const shim = path.join(versionRoot, relativeCliPath);
      fs.mkdirSync(path.dirname(shim), { recursive: true });
      fs.writeFileSync(shim, "fixture shim", { mode: 0o755 });
      fs.mkdirSync(path.join(versionRoot, "node_modules", "@picoxr", "pico-cli"), { recursive: true });
      fs.writeFileSync(path.join(versionRoot, "node_modules", "@picoxr", "pico-cli", "package.json"), JSON.stringify({ name: "@picoxr/pico-cli", version: packageVersion }));
      fs.writeFileSync(path.join(versionRoot, "install.json"), recordText ?? JSON.stringify({ schemaVersion: 1, version: recordVersion, relativeCliPath, registryIntegrity: null, installedAt: "2026-08-14T12:00:00.000Z" }));
      responses.set(shim, `pico-cli/${cliVersion} (fixture)\n`);
      return shim;
    };
    const io = (env = {}) => ({
      env,
      platform: "linux",
      homeDir: path.join(root, "unused-home"),
      now: () => 0,
      randomUUID: () => "unused",
      run: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, signal: null, stdout: responses.get(command) ?? "pico-cli/0.0.0\n", stderr: "", timedOut: false, outputTruncated: false };
      },
    });
    return { managedRoot, publish, io, calls };
  }

  await t.test("cached policy picks the newest wholly validated immutable version without npm or writes", async () => {
    const fixture = managedFixture();
    fixture.publish("0.4.1");
    const newestShim = fixture.publish("0.4.2");
    const result = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, fixture.io());
    assert.deepEqual(result, {
      status: "ok", source: "managed", policy: "managed-latest", action: "cached", path: newestShim,
      version: "0.4.2", raw: "pico-cli/0.4.2 (fixture)", latestVersion: null, checkedAt: null,
      freshness: "cached", deprecatedAliases: [],
    });
    assert.deepEqual(fixture.calls, [{ command: newestShim, args: ["-v"] }]);
    assert.equal(fs.existsSync(path.join(fixture.managedRoot, "versions", "0.4.3")), false);
  });

  await t.test("corrupt records and version disagreements are rejected before a cached version is selected", async () => {
    const cases = [
      { name: "corrupt record", options: { recordText: "not-json" } },
      { name: "mismatched package version", options: { packageVersion: "0.4.1" } },
      { name: "mismatched -v version", options: { cliVersion: "0.4.1" } },
    ];
    for (const item of cases) {
      const fixture = managedFixture();
      const fallbackShim = fixture.publish("0.4.1");
      const rejectedShim = fixture.publish("0.4.2", item.options);
      const result = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, fixture.io());
      assert.equal(result.status, "ok", `${item.name}: ${JSON.stringify(result)}`);
      assert.equal(result.path, fallbackShim, item.name);
      assert.equal(result.version, "0.4.1", item.name);
      const expectedCalls = item.name === "mismatched -v version"
        ? [{ command: rejectedShim, args: ["-v"] }, { command: fallbackShim, args: ["-v"] }]
        : [{ command: fallbackShim, args: ["-v"] }];
      assert.deepEqual(fixture.calls, expectedCalls, item.name);
    }
  });

  await t.test("disabled, external, and missing-cache policies expose their read-only outcomes", async () => {
    const disabled = managedFixture();
    const disabledResult = await inspectManagedPicoCli({ managedRoot: disabled.managedRoot }, disabled.io({ [PICO_CLI_POLICY_ENV]: "disabled" }));
    assert.equal(disabledResult.status, "unavailable");
    assert.equal(disabledResult.failureClass, "cli-disabled");
    assert.deepEqual(disabled.calls, []);

    const external = managedFixture();
    const externalPath = path.join(external.managedRoot, "external-pico-cli");
    external.publish("0.0.1");
    const externalIo = external.io({ [PICO_CLI_POLICY_ENV]: "external", [PICO_CLI_PATH_ENV]: externalPath });
    externalIo.run = async (command, args) => {
      external.calls.push({ command, args });
      return { code: 0, signal: null, stdout: "pico-cli/0.4.2 (external fixture)\n", stderr: "", timedOut: false, outputTruncated: false };
    };
    const externalResult = await inspectManagedPicoCli({ managedRoot: external.managedRoot }, externalIo);
    assert.deepEqual(externalResult, {
      status: "ok", source: "external", policy: "external", action: "external", path: externalPath,
      version: "0.4.2", raw: "pico-cli/0.4.2 (external fixture)", latestVersion: null, checkedAt: null,
      freshness: "external", deprecatedAliases: [],
    });
    assert.deepEqual(external.calls, [{ command: externalPath, args: ["-v"] }]);

    const missing = managedFixture();
    const missingResult = await inspectManagedPicoCli({ managedRoot: missing.managedRoot }, missing.io());
    assert.equal(missingResult.status, "unavailable");
    assert.equal(missingResult.failureClass, "cli-missing");
    assert.equal(missingResult.path, null);
    assert.deepEqual(missing.calls, []);
    assert.equal(fs.existsSync(missing.managedRoot), false, "inspection must not create a missing managed root");
  });
});

test.after(() => {
  restoreEnvironment();
  probePicoCli(true);
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});
