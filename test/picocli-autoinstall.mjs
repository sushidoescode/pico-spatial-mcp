// Lazy pico-cli provisioning: present / absent-off / install / update / classified failure / bound.
// All commands are fakes on an isolated PATH; this test never contacts npm or a device.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  createManagedConvergenceWorker,
  createHarness,
  createManagedIO,
  launchManagedConvergenceWorker,
  publishManagedFixtureVersion,
  restoreEnvironment,
  saveEnvironment,
  tempRoots,
} from "./helpers/picocli-managed-fixture.mjs";
import {
  inspectManagedPicoCli,
  resolveManagedPicoCli,
  resolvePicoCliPolicy,
  PICO_CLI_PATH_ENV,
  PICO_CLI_POLICY_ENV,
} from "../dist/picoclimanaged.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    const publish = (version, { recordVersion = version, packageVersion = version, cliVersion = version, relativeCliPath = "node_modules/.bin/pico-cli", recordText } = {}) => {
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
    const publishedFiles = () => {
      const files = new Map();
      const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(entryPath);
          else if (entry.isFile()) files.set(path.relative(managedRoot, entryPath), fs.readFileSync(entryPath));
        }
      };
      visit(managedRoot);
      return files;
    };
    return { managedRoot, publish, io, calls, publishedFiles };
  }

  await t.test("cached policy picks the newest wholly validated immutable version without npm or writes", async () => {
    const fixture = managedFixture();
    fixture.publish("0.4.1");
    const newestShim = fixture.publish("0.4.2");
    const beforeInspection = fixture.publishedFiles();
    const result = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, fixture.io());
    assert.deepEqual(result, {
      status: "ok", source: "managed", policy: "managed-latest", action: "cached", path: newestShim,
      version: "0.4.2", raw: "pico-cli/0.4.2 (fixture)", latestVersion: null, checkedAt: null,
      freshness: "cached", deprecatedAliases: [],
    });
    assert.deepEqual(fixture.calls, [{ command: newestShim, args: ["-v"] }]);
    assert.deepEqual(fixture.publishedFiles(), beforeInspection, "inspection must not alter published files");
    assert.equal(fs.existsSync(path.join(fixture.managedRoot, "versions", "0.4.3")), false);
  });

  await t.test("a relative managedRoot resolves the published immutable version", async () => {
    const fixture = managedFixture();
    const newestShim = fixture.publish("0.4.2");
    const relativeManagedRoot = path.relative(process.cwd(), fixture.managedRoot);
    assert.equal(path.isAbsolute(relativeManagedRoot), false);
    const result = await inspectManagedPicoCli({ managedRoot: relativeManagedRoot }, fixture.io());
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.path, newestShim);
    assert.equal(result.version, "0.4.2");
  });

  await t.test("corrupt records and version disagreements are rejected before a cached version is selected", async () => {
    const cases = [
      { name: "corrupt record", options: { recordText: "not-json" } },
      { name: "noncanonical safe shim", options: { relativeCliPath: "bin/pico-cli" } },
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

test("cold managed and stale managed exact provisioning", { concurrency: false, timeout: 30_000 }, async (t) => {
  const canonicalRelativeCliPath = process.platform === "win32"
    ? path.join("node_modules", ".bin", "pico-cli.cmd")
    : path.join("node_modules", ".bin", "pico-cli");

  await t.test("cold managed install publishes the exact registry version without global mutation", async () => {
    const harness = createHarness({ installedVersion: "9.9.9", latestVersion: "0.4.2", separateGlobalBin: true });
    const managedRoot = path.join(harness.root, "managed");
    const io = createManagedIO(harness);
    const pathBefore = process.env.PATH ?? process.env.Path ?? "";
    const globalShimBefore = fs.readFileSync(harness.cliTarget);
    const globalStateBefore = fs.readFileSync(harness.statePath);

    const cold = await resolveManagedPicoCli({
      managedRoot,
      forceRefresh: true,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
      killGraceMs: 25,
    }, io);

    assert.equal(cold.status, "ok", JSON.stringify(cold));
    assert.equal(cold.action, "installed");
    assert.equal(cold.source, "managed");
    assert.equal(cold.version, "0.4.2");
    assert.equal(cold.latestVersion, "0.4.2");
    assert.equal(cold.freshness, "latest");
    assert.equal(cold.checkedAt, "2026-08-14T12:00:00.000Z");
    assert.ok(path.isAbsolute(cold.path));

    const npmCalls = harness.calls().filter((call) => call.role === "npm");
    assert.deepEqual(npmCalls[0].args, ["view", "@picoxr/pico-cli@latest", "version", "dist.integrity", "--json"]);
    const install = npmCalls.find((call) => call.args[0] === "install");
    assert.deepEqual(install.args, [
      "install", "--prefix", path.join(managedRoot, "staging", "fixture-staging-1"),
      "--no-save", "--package-lock=false", "--fund=false", "--audit=false", "@picoxr/pico-cli@0.4.2",
    ]);
    for (const call of harness.calls()) {
      assert.equal(call.args.includes("-g"), false, JSON.stringify(call));
      assert.equal(call.args.includes("--global"), false, JSON.stringify(call));
      assert.equal(call.args.includes("setup"), false, JSON.stringify(call));
      assert.equal(call.args.join(" ").includes("update --check"), false, JSON.stringify(call));
    }

    const versionRoot = path.join(managedRoot, "versions", "0.4.2");
    assert.equal(cold.path, path.join(versionRoot, canonicalRelativeCliPath));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(versionRoot, "install.json"), "utf8")), {
      schemaVersion: 1,
      version: "0.4.2",
      relativeCliPath: canonicalRelativeCliPath,
      registryIntegrity: "sha512-fixture",
      installedAt: "2026-08-14T12:00:00.000Z",
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(versionRoot, "node_modules", "@picoxr", "pico-cli", "package.json"), "utf8")), {
      name: "@picoxr/pico-cli",
      version: "0.4.2",
    });
    const stagingEntries = fs.existsSync(path.join(managedRoot, "staging"))
      ? fs.readdirSync(path.join(managedRoot, "staging"))
      : [];
    assert.deepEqual(stagingEntries, [], "a staging directory must never be exposed as a published version");
    assert.equal(process.env.PATH ?? process.env.Path ?? "", pathBefore);
    assert.deepEqual(fs.readFileSync(harness.cliTarget), globalShimBefore);
    assert.deepEqual(fs.readFileSync(harness.statePath), globalStateBefore);
  });

  await t.test("stale managed version provisions and executes the exact newer shim", async () => {
    const harness = createHarness({ latestVersion: "0.4.1" });
    const managedRoot = path.join(harness.root, "managed");
    const io = createManagedIO(harness);
    const seeded = await resolveManagedPicoCli({ managedRoot, forceRefresh: true, installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000 }, io);
    assert.equal(seeded.status, "ok", JSON.stringify(seeded));
    assert.equal(seeded.version, "0.4.1");

    process.env.FAKE_LATEST_VERSION = "0.4.2";
    const updated = await resolveManagedPicoCli({ managedRoot, forceRefresh: true, installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000 }, io);
    assert.equal(updated.status, "ok", JSON.stringify(updated));
    assert.equal(updated.action, "updated");
    assert.equal(updated.version, "0.4.2");
    assert.equal(updated.latestVersion, "0.4.2");
    assert.equal(updated.path, path.join(managedRoot, "versions", "0.4.2", canonicalRelativeCliPath));
    assert.ok(io.commands.some((call) => call.command === updated.path && call.args.length === 1 && call.args[0] === "-v"), JSON.stringify(io.commands));
  });

  await t.test("cold managed help canaries remain bounded diagnostics when one command drifts", async () => {
    const harness = createHarness({ latestVersion: "0.4.2", canaryFailure: "perf trace decode" });
    const managedRoot = path.join(harness.root, "managed");
    const io = createManagedIO(harness);
    const result = await resolveManagedPicoCli({
      managedRoot,
      forceRefresh: true,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
      killGraceMs: 25,
    }, io);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.action, "installed");

    const expectedArgv = [
      ["perf", "monitor", "run", "--help"],
      ["perf", "trace", "record", "--help"],
      ["perf", "trace", "decode", "--help"],
      ["perf", "trace", "load", "--help"],
      ["perf", "trace", "query", "--help"],
      ["app", "watch-crash", "--help"],
      ["capture", "record", "--help"],
      ["mcp", "dev-knowledge", "--help"],
      ["emulator", "status", "--help"],
    ];
    assert.deepEqual(result.compatibility?.map((item) => item.argv), expectedArgv);
    assert.ok(result.compatibility?.every((item) => item.argv.at(-1) === "--help"));
    assert.ok(result.compatibility?.every((item) => item.timedOut === false && item.outputTruncated === false));
    const decode = result.compatibility?.find((item) => item.argv.join(" ") === "perf trace decode --help");
    assert.equal(decode?.exitCode, 7);
    assert.equal(decode?.helpSha256, crypto.createHash("sha256").update("fixture incompatible: perf trace decode --help\n").digest("hex"));
    const monitor = result.compatibility?.find((item) => item.argv.join(" ") === "perf monitor run --help");
    assert.equal(monitor?.exitCode, 0);
    assert.equal(monitor?.helpSha256, crypto.createHash("sha256").update("fixture help: perf monitor run --help\n").digest("hex"));

    const canaryCalls = io.commands.filter((call) => call.args.at(-1) === "--help");
    assert.deepEqual(canaryCalls.map((call) => call.args), expectedArgv);
    assert.ok(canaryCalls.every((call) => call.options.timeoutMs === 2_000 && call.options.killGraceMs === 25), JSON.stringify(canaryCalls));
    const stored = JSON.parse(fs.readFileSync(path.join(managedRoot, "versions", "0.4.2", "compatibility.json"), "utf8"));
    assert.deepEqual(stored, { schemaVersion: 1, version: "0.4.2", diagnostics: result.compatibility });
  });
});

test("managed publication no-clobber fix round", { concurrency: false, timeout: 30_000 }, async (t) => {
  await t.test("a pre-existing empty target created at publication claim survives unchanged", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const target = path.join(managedRoot, "versions", "0.4.2");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const originalOpenSync = fs.openSync;
    let targetBefore = null;
    let injected = false;
    fs.openSync = function patchedOpenSync(file, flags, ...rest) {
      if (!injected && flags === "wx" && path.basename(String(file)) === ".0.4.2.publish") {
        fs.mkdirSync(target);
        targetBefore = fs.statSync(target);
        injected = true;
      }
      return originalOpenSync.call(this, file, flags, ...rest);
    };
    try {
      const result = await resolveManagedPicoCli({
        managedRoot,
        forceRefresh: true,
        installTimeoutMs: 2_000,
        updateCheckTimeoutMs: 2_000,
      }, createManagedIO(harness));
      assert.equal(injected, true, "publication must acquire the exclusive adjacent claim");
      assert.equal(result.status, "unavailable", JSON.stringify(result));
      assert.equal(fs.existsSync(claim), true, "an ambiguous owned claim must fail closed and remain preserved");
      assert.match(result.note, /only after confirming no managed resolver process is active/i);
      const targetAfter = fs.statSync(target);
      assert.equal(targetAfter.ino, targetBefore.ino, "the empty target identity must not be replaced");
      assert.equal(targetAfter.birthtimeMs, targetBefore.birthtimeMs);
      assert.deepEqual(fs.readdirSync(target), [], "the pre-existing empty target must remain empty");
    } finally {
      fs.openSync = originalOpenSync;
    }
  });
});

test("managed winner completeness fix round", { concurrency: false, timeout: 30_000 }, async (t) => {
  async function raceWithWinner(mutateWinner = () => {}) {
    const harness = createHarness({ latestVersion: "0.4.2", registryIntegrity: "sha512-fixture" });
    const seedRoot = path.join(harness.root, "seed-managed");
    const seed = await resolveManagedPicoCli({
      managedRoot: seedRoot,
      forceRefresh: true,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
    }, createManagedIO(harness));
    assert.equal(seed.status, "ok", JSON.stringify(seed));
    const heldWinner = path.join(harness.root, "held-winner");
    fs.renameSync(path.join(seedRoot, "versions", "0.4.2"), heldWinner);
    mutateWinner(heldWinner);
    const heldIdentity = fs.statSync(heldWinner);

    const managedRoot = path.join(harness.root, "racing-managed");
    const target = path.join(managedRoot, "versions", "0.4.2");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const originalOpenSync = fs.openSync;
    let injected = false;
    fs.openSync = function patchedOpenSync(file, flags, ...rest) {
      if (!injected && flags === "wx" && String(file) === claim) {
        fs.renameSync(heldWinner, target);
        fs.linkSync(path.join(target, "publication.json"), claim);
        injected = true;
      }
      return originalOpenSync.call(this, file, flags, ...rest);
    };
    try {
      const result = await resolveManagedPicoCli({
        managedRoot,
        forceRefresh: true,
        installTimeoutMs: 2_000,
        updateCheckTimeoutMs: 2_000,
      }, createManagedIO(harness));
      assert.equal(injected, true, "test must inject the competing winner at claim acquisition");
      assert.equal(fs.statSync(target).ino, heldIdentity.ino, "resolver must preserve the competing target identity");
      return { result, target };
    } finally {
      fs.openSync = originalOpenSync;
    }
  }

  await t.test("a complete collision winner is validated and reused", async () => {
    const { result, target } = await raceWithWinner();
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.version, "0.4.2");
    assert.equal(result.path, path.join(target, "node_modules", ".bin", process.platform === "win32" ? "pico-cli.cmd" : "pico-cli"));
    assert.equal(result.compatibility?.length, 9);
  });

  await t.test("a collision winner without compatibility diagnostics is rejected and preserved", async () => {
    const { result, target } = await raceWithWinner((winner) => {
      fs.unlinkSync(path.join(winner, "compatibility.json"));
    });
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(target, "compatibility.json")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "install.json"), "utf8")).registryIntegrity, "sha512-fixture");
  });

  await t.test("a collision winner with mismatched registry integrity is rejected and preserved", async () => {
    const { result, target } = await raceWithWinner((winner) => {
      const installPath = path.join(winner, "install.json");
      const install = JSON.parse(fs.readFileSync(installPath, "utf8"));
      fs.writeFileSync(installPath, JSON.stringify({ ...install, registryIntegrity: "sha512-other" }));
    });
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "install.json"), "utf8")).registryIntegrity, "sha512-other");
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "compatibility.json"), "utf8")).diagnostics.length, 9);
  });
});

test("managed fallback, corruption, and concurrent managed convergence", { concurrency: false, timeout: 90_000 }, async (t) => {
  const stagingOwnerRecord = ({
    version = "0.4.2",
    token = "fixture-owner-token",
    ownerPid,
    createdAt,
  }) => ({ schemaVersion: 1, kind: "pico-managed-staging", version, token, ownerPid, createdAt });
  const writeStagingOwner = (directory, record) => {
    fs.writeFileSync(path.join(directory, "staging-owner.json"), `${JSON.stringify(record)}\n`);
  };
  const definitelyDeadPid = () => {
    for (const candidate of [999_999, 9_999_999, 99_999_999, 2_147_483_647]) {
      try { process.kill(candidate, 0); }
      catch (error) { if (error?.code === "ESRCH") return candidate; }
    }
    assert.fail("fixture could not identify a definitively dead PID");
  };
  const optionsFor = (managedRoot, overrides = {}) => ({
    managedRoot,
    forceRefresh: true,
    installTimeoutMs: 2_000,
    updateCheckTimeoutMs: 2_000,
    killGraceMs: 25,
    ...overrides,
  });

  await t.test("registry failure falls back to a validated cache with latest-unknown freshness", async () => {
    const harness = createHarness({ registryMode: "failure" });
    const managedRoot = path.join(harness.root, "managed");
    const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const registryDown = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(registryDown.status, "ok", JSON.stringify(registryDown));
    assert.equal(registryDown.action, "cached");
    assert.equal(registryDown.path, cached.shimPath);
    assert.equal(registryDown.version, "0.4.1");
    assert.equal(registryDown.latestVersion, null);
    assert.equal(registryDown.freshness, "unknown");
    assert.equal(registryDown.warning?.failureClass, "latest-unknown");
    assert.match(registryDown.warning?.outputTail ?? "", /registry unavailable/);
    assert.equal(fs.existsSync(path.join(managedRoot, "versions", "0.4.2")), false);
  });

  await t.test("registry failure without a validated cache is unavailable as latest-unknown", async () => {
    const harness = createHarness({ registryMode: "failure" });
    const managedRoot = path.join(harness.root, "managed");
    const noRegistryNoCache = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(noRegistryNoCache.status, "unavailable", JSON.stringify(noRegistryNoCache));
    assert.equal(noRegistryNoCache.failureClass, "latest-unknown");
    assert.equal(noRegistryNoCache.version, null);
    assert.equal(noRegistryNoCache.latestVersion, null);
    assert.equal(noRegistryNoCache.checkedAt, "2026-08-14T12:00:00.000Z");
    assert.match(noRegistryNoCache.outputTail ?? "", /registry unavailable/);
    assert.equal(noRegistryNoCache.raw, "");
    assert.equal(fs.existsSync(path.join(managedRoot, "versions")), false);
  });

  for (const failure of [
    {
      name: "npm timeout",
      result: { code: null, signal: "SIGTERM", stdout: "", stderr: "registry request exceeded bound", timedOut: true, outputTruncated: false },
      tail: /exceeded bound/,
    },
    {
      name: "npm unavailable",
      result: { code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: "spawn npm ENOENT", outputTruncated: false },
      tail: /spawn npm ENOENT/,
    },
  ]) {
    await t.test(`${failure.name} fallback preserves the validated cache and failure output`, async () => {
      const harness = createHarness();
      const managedRoot = path.join(harness.root, "managed");
      const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
      const io = createManagedIO(harness);
      const realRun = io.run;
      io.run = async (command, args, runOptions) => {
        if (command === "npm" && args[0] === "view") return failure.result;
        return realRun(command, args, runOptions);
      };
      const result = await resolveManagedPicoCli(optionsFor(managedRoot), io);
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.equal(result.path, cached.shimPath);
      assert.equal(result.version, "0.4.1");
      assert.equal(result.freshness, "unknown");
      assert.equal(result.warning?.failureClass, "latest-unknown");
      assert.match(result.warning?.outputTail ?? "", failure.tail);
    });
  }

  await t.test("malformed registry JSON falls back without caching or publishing it", async () => {
    const harness = createHarness({ registryMode: "malformed" });
    const managedRoot = path.join(harness.root, "managed");
    const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const malformed = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(malformed.status, "ok", JSON.stringify(malformed));
    assert.equal(malformed.path, cached.shimPath);
    assert.equal(malformed.freshness, "unknown");
    assert.equal(malformed.warning?.failureClass, "latest-unknown");
    assert.match(malformed.warning?.outputTail ?? "", /\{"version":/);
    assert.equal(fs.existsSync(path.join(managedRoot, "versions", "0.4.2")), false);
  });

  for (const failure of [
    { name: "npm timeout", npmMode: "hang", overrides: { installTimeoutMs: 300 }, tail: null },
    { name: "successful npm exit without a shim", npmMode: "no-cli", tail: /claimed success without a CLI/ },
    { name: "mismatched staged -v", npmMode: "mismatched-cli", tail: /pico-cli\/0\.4\.1/ },
    { name: "package version mismatch", npmMode: "mismatched-package", tail: null },
  ]) {
    await t.test(`${failure.name} fallback retains the validated old version as outdated`, async () => {
      const harness = createHarness({ latestVersion: "0.4.2", npmMode: failure.npmMode });
      const managedRoot = path.join(harness.root, "managed");
      const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
      const beforeRecord = fs.readFileSync(path.join(cached.versionRoot, "install.json"));
      const beforeShim = fs.readFileSync(cached.shimPath);
      const updateFailed = await resolveManagedPicoCli(optionsFor(managedRoot, failure.overrides), createManagedIO(harness));
      assert.equal(updateFailed.status, "ok", JSON.stringify(updateFailed));
      assert.equal(updateFailed.action, "cached");
      assert.equal(updateFailed.path, cached.shimPath);
      assert.equal(updateFailed.version, "0.4.1");
      assert.equal(updateFailed.latestVersion, "0.4.2");
      assert.equal(updateFailed.freshness, "outdated");
      assert.equal(updateFailed.warning?.failureClass, "update-failed");
      if (failure.tail) assert.match(updateFailed.warning?.outputTail ?? "", failure.tail);
      assert.deepEqual(fs.readFileSync(path.join(cached.versionRoot, "install.json")), beforeRecord);
      assert.deepEqual(fs.readFileSync(cached.shimPath), beforeShim);
      assert.equal(fs.existsSync(path.join(managedRoot, "versions", "0.4.2")), false);
      assert.deepEqual(fs.existsSync(path.join(managedRoot, "staging")) ? fs.readdirSync(path.join(managedRoot, "staging")) : [], []);
    });
  }

  await t.test("fallback is revalidated after a failing install mutates the previously valid shim", async () => {
    const harness = createHarness({ latestVersion: "0.4.2", npmMode: "network" });
    const managedRoot = path.join(harness.root, "managed");
    const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const io = createManagedIO(harness);
    const realRun = io.run;
    io.run = async (command, args, runOptions) => {
      const result = await realRun(command, args, runOptions);
      if (command === "npm" && args[0] === "install") fs.unlinkSync(cached.shimPath);
      return result;
    };
    const result = await resolveManagedPicoCli(optionsFor(managedRoot), io);
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    assert.equal(result.version, null);
    assert.equal(result.failureClass, "cli-unusable");
    assert.equal(fs.existsSync(cached.shimPath), false);
    assert.equal(fs.existsSync(path.join(managedRoot, "versions", "0.4.2")), false);
  });

  await t.test("known-latest install failure without fallback preserves attempted provenance", async () => {
    const harness = createHarness({ latestVersion: "0.4.2", npmMode: "no-cli" });
    const managedRoot = path.join(harness.root, "managed");
    const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    assert.equal(result.failureClass, "cli-unusable");
    assert.equal(result.latestVersion, "0.4.2");
    assert.equal(result.checkedAt, "2026-08-14T12:00:00.000Z");
    assert.match(result.outputTail ?? "", /claimed success without a CLI/);
    assert.equal(result.raw, "", "raw is reserved for actual CLI -v output");
    assert.equal(fs.existsSync(path.join(managedRoot, "versions", "0.4.2")), false);
  });

  for (const corruption of [
    { name: "corrupt install record", options: { recordText: "not-json" }, mutate: () => {} },
    { name: "corrupt package version mismatch", options: { packageVersion: "0.4.1" }, mutate: () => {} },
    {
      name: "corrupt shim mutation",
      options: {},
      mutate: ({ shimPath }) => fs.writeFileSync(shimPath, "#!/bin/sh\nexit 9\n", { mode: 0o755 }),
    },
  ]) {
    await t.test(`${corruption.name} is skipped without erasing it or the valid fallback`, async () => {
      const harness = createHarness({ registryMode: "failure" });
      const managedRoot = path.join(harness.root, "managed");
      const fallback = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
      const rejected = publishManagedFixtureVersion(harness, managedRoot, "0.4.2", corruption.options);
      corruption.mutate(rejected);
      const rejectedRecord = fs.readFileSync(path.join(rejected.versionRoot, "install.json"));
      const rejectedShim = fs.readFileSync(rejected.shimPath);
      const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.equal(result.path, fallback.shimPath);
      assert.equal(result.version, "0.4.1");
      assert.equal(result.freshness, "unknown");
      assert.equal(result.warning?.failureClass, "latest-unknown");
      assert.deepEqual(fs.readFileSync(path.join(rejected.versionRoot, "install.json")), rejectedRecord);
      assert.deepEqual(fs.readFileSync(rejected.shimPath), rejectedShim);
      assert.equal(fs.existsSync(fallback.versionRoot), true);
    });
  }

  await t.test("abandoned staging cleanup isolates only a valid dead-owner record older than seven days", async () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const harness = createHarness({ latestVersion: "0.4.2", npmMode: "no-cli" });
    const managedRoot = path.join(harness.root, "managed");
    const published = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const stagingRoot = path.join(managedRoot, "staging");
    const deadPid = definitelyDeadPid();
    const oldOwned = path.join(stagingRoot, "old-owned-dead-process");
    const boundary = path.join(stagingRoot, "exactly-seven-days");
    const fresh = path.join(stagingRoot, "fresh-staging");
    for (const directory of [oldOwned, boundary, fresh]) fs.mkdirSync(directory, { recursive: true });
    writeStagingOwner(oldOwned, stagingOwnerRecord({ ownerPid: deadPid, createdAt: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString() }));
    writeStagingOwner(boundary, stagingOwnerRecord({ ownerPid: deadPid, token: "boundary", createdAt: new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString() }));
    writeStagingOwner(fresh, stagingOwnerRecord({ ownerPid: deadPid, token: "fresh", createdAt: new Date(now - 6 * 24 * 60 * 60 * 1_000).toISOString() }));
    const setAge = (target, ageMs) => fs.utimesSync(target, new Date(now - ageMs), new Date(now - ageMs));
    setAge(oldOwned, 8 * 24 * 60 * 60 * 1_000);
    setAge(boundary, 7 * 24 * 60 * 60 * 1_000);
    setAge(fresh, 6 * 24 * 60 * 60 * 1_000);
    setAge(published.versionRoot, 30 * 24 * 60 * 60 * 1_000);

    const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness, { now }));
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.version, "0.4.1");
    assert.equal(fs.existsSync(oldOwned), false);
    const quarantines = fs.readdirSync(stagingRoot).filter((entry) => entry.startsWith(".cleanup-"));
    assert.equal(quarantines.length, 1, JSON.stringify(quarantines));
    assert.equal(JSON.parse(fs.readFileSync(path.join(stagingRoot, quarantines[0], "staging-owner.json"), "utf8")).token, "fixture-owner-token");
    assert.equal(fs.existsSync(boundary), true);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(published.versionRoot), true);
    assert.equal(fs.existsSync(path.join(managedRoot, "versions", "0.4.2")), false);

    const rescanned = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness, { now }));
    assert.equal(rescanned.status, "ok", JSON.stringify(rescanned));
    assert.deepEqual(
      fs.readdirSync(stagingRoot).filter((entry) => entry.startsWith(".cleanup-")),
      quarantines,
      "later resolvers must skip the retained quarantine namespace",
    );
  });

  await t.test("cleanup preserves active, unowned, malformed, and symlink staging entries", async () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const harness = createHarness({ registryMode: "failure" });
    const managedRoot = path.join(harness.root, "managed");
    const stagingRoot = path.join(managedRoot, "staging");
    const active = path.join(stagingRoot, "active-owner");
    const unowned = path.join(stagingRoot, "unowned");
    const malformed = path.join(stagingRoot, "malformed-owner");
    const symlinkTarget = path.join(stagingRoot, "symlink-target");
    const symlinkEntry = path.join(stagingRoot, "symlink-entry");
    for (const directory of [active, unowned, malformed, symlinkTarget]) fs.mkdirSync(directory, { recursive: true });
    const oldCreatedAt = new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString();
    writeStagingOwner(active, stagingOwnerRecord({ ownerPid: process.pid, createdAt: oldCreatedAt }));
    fs.writeFileSync(path.join(malformed, "staging-owner.json"), "not-json");
    fs.symlinkSync(symlinkTarget, symlinkEntry, "dir");
    for (const directory of [active, unowned, malformed, symlinkTarget]) {
      fs.utimesSync(directory, new Date(now - 8 * 24 * 60 * 60 * 1_000), new Date(now - 8 * 24 * 60 * 60 * 1_000));
    }

    const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness, { now }));
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    for (const entry of [active, unowned, malformed, symlinkTarget, symlinkEntry]) {
      assert.equal(fs.existsSync(entry), true, `cleanup must preserve ${entry}`);
    }
  });

  await t.test("cleanup detects a quarantine replacement and leaves it isolated without deletion", async () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const harness = createHarness({ registryMode: "failure" });
    const managedRoot = path.join(harness.root, "managed");
    const stagingRoot = path.join(managedRoot, "staging");
    const candidate = path.join(stagingRoot, "old-owned-raced");
    fs.mkdirSync(candidate, { recursive: true });
    writeStagingOwner(candidate, stagingOwnerRecord({
      ownerPid: definitelyDeadPid(),
      token: "raced-owner",
      createdAt: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString(),
    }));
    fs.utimesSync(candidate, new Date(now - 8 * 24 * 60 * 60 * 1_000), new Date(now - 8 * 24 * 60 * 60 * 1_000));
    const originalRenameSync = fs.renameSync;
    let heldOwned = null;
    let quarantinePath = null;
    let injected = false;
    fs.renameSync = function patchedRenameSync(source, destination, ...rest) {
      const renamed = originalRenameSync.call(this, source, destination, ...rest);
      if (!injected && source === candidate && path.basename(String(destination)).startsWith(".cleanup-")) {
        quarantinePath = destination;
        heldOwned = `${destination}.held-owned`;
        originalRenameSync.call(this, destination, heldOwned);
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, "unowned-replacement"), "preserve-me");
        injected = true;
      }
      return renamed;
    };
    try {
      const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness, { now }));
      assert.equal(result.status, "unavailable", JSON.stringify(result));
      assert.equal(injected, true, "fixture must replace the quarantined directory after rename");
      assert.equal(fs.existsSync(heldOwned), true, "the originally owned directory remains preserved by the fixture");
      assert.equal(fs.existsSync(candidate), false, "the abandoned public staging name must remain isolated");
      assert.equal(fs.readFileSync(path.join(quarantinePath, "unowned-replacement"), "utf8"), "preserve-me");

      await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness, { now }));
      assert.equal(fs.readFileSync(path.join(quarantinePath, "unowned-replacement"), "utf8"), "preserve-me");
    } finally {
      fs.renameSync = originalRenameSync;
    }
  });

  await t.test("cleanup never recursively deletes a replacement swapped in after quarantine verification", async () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const harness = createHarness({ registryMode: "failure" });
    const managedRoot = path.join(harness.root, "managed");
    const stagingRoot = path.join(managedRoot, "staging");
    const candidate = path.join(stagingRoot, "old-owned-delete-boundary");
    fs.mkdirSync(candidate, { recursive: true });
    writeStagingOwner(candidate, stagingOwnerRecord({
      ownerPid: definitelyDeadPid(),
      token: "delete-boundary-owner",
      createdAt: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString(),
    }));
    const originalRmSync = fs.rmSync;
    const originalRenameSync = fs.renameSync;
    let deleteAttempted = false;
    let heldOwned = null;
    let replacementMarker = null;
    fs.rmSync = function patchedRmSync(target, options, ...rest) {
      if (!deleteAttempted && path.dirname(String(target)) === stagingRoot
        && path.basename(String(target)).startsWith(".cleanup-") && options?.recursive === true) {
        heldOwned = path.join(harness.root, "held-verified-owned-quarantine");
        originalRenameSync.call(this, target, heldOwned);
        fs.mkdirSync(target);
        replacementMarker = path.join(target, "unowned-replacement");
        fs.writeFileSync(replacementMarker, "must-survive");
        deleteAttempted = true;
      }
      return originalRmSync.call(this, target, options, ...rest);
    };
    try {
      const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness, { now }));
      assert.equal(result.status, "unavailable", JSON.stringify(result));
      assert.equal(deleteAttempted, false, "verified quarantine pathnames must never be passed to recursive deletion");
      assert.equal(fs.existsSync(candidate), false, "the abandoned public staging name must be isolated");
      const quarantines = fs.readdirSync(stagingRoot).filter((entry) => entry.startsWith(".cleanup-"));
      assert.equal(quarantines.length, 1, JSON.stringify(quarantines));
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(stagingRoot, quarantines[0], "staging-owner.json"), "utf8")).token,
        "delete-boundary-owner",
      );
      if (replacementMarker !== null) assert.equal(fs.existsSync(replacementMarker), true, "an injected replacement must never be deleted");
      assert.equal(heldOwned, null, "no post-verification delete boundary should be reached");
    } finally {
      fs.rmSync = originalRmSync;
    }
  });

  await t.test("a stale publication claim fails closed with manual recovery guidance and is preserved", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    fs.writeFileSync(claim, "stale-owner-token");
    const claimIdentity = fs.statSync(claim);
    const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.path, cached.shimPath);
    assert.equal(result.version, "0.4.1");
    assert.equal(result.freshness, "outdated");
    assert.equal(result.warning?.failureClass, "update-failed");
    assert.match(result.warning?.note ?? "", new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.warning?.note ?? "", /only after confirming no managed resolver process is active/i);
    assert.equal(fs.statSync(claim).ino, claimIdentity.ino);
    assert.equal(fs.readFileSync(claim, "utf8"), "stale-owner-token");
    assert.equal(fs.existsSync(path.join(managedRoot, "versions", "0.4.2")), false);
  });

  await t.test("publication finalization preserves a claim replacement instead of unlinking it", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const target = path.join(managedRoot, "versions", "0.4.2");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const publicationRecord = path.join(target, "publication.json");
    const heldOwner = path.join(harness.root, "held-original-publication-claim");
    const originalRenameSync = fs.renameSync;
    const originalLinkSync = fs.linkSync;
    let injected = false;
    const injectSourceReplacement = (source, destination) => {
      if (!injected && source === claim && destination === publicationRecord) {
        originalRenameSync.call(this, source, heldOwner);
        fs.writeFileSync(source, "replacement-owner-token");
        injected = true;
      }
    };
    fs.renameSync = function patchedRenameSync(source, destination, ...rest) {
      injectSourceReplacement.call(this, source, destination);
      return originalRenameSync.call(this, source, destination, ...rest);
    };
    fs.linkSync = function patchedLinkSync(source, destination, ...rest) {
      injectSourceReplacement.call(this, source, destination);
      return originalLinkSync.call(this, source, destination, ...rest);
    };
    try {
      const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
      assert.equal(injected, true, "fixture must replace the acquired claim during finalization");
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.equal(result.path, cached.shimPath);
      assert.equal(result.version, "0.4.1");
      assert.equal(result.freshness, "outdated");
      assert.equal(result.warning?.failureClass, "update-failed");
      assert.match(result.warning?.note ?? "", /publication claim finalization/i);
      assert.equal(fs.existsSync(heldOwner), true, "the original owner claim must remain preserved");
      assert.equal(fs.readFileSync(publicationRecord, "utf8"), "replacement-owner-token");
      assert.equal(fs.readFileSync(claim, "utf8"), "replacement-owner-token", "the replacement source must remain preserved");
      assert.equal(fs.existsSync(target), true, "the complete published target remains immutable");
    } finally {
      fs.renameSync = originalRenameSync;
      fs.linkSync = originalLinkSync;
    }
  });

  await t.test("publication finalization never overwrites a destination created at the atomic boundary", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const target = path.join(managedRoot, "versions", "0.4.2");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const publicationRecord = path.join(target, "publication.json");
    const originalRenameSync = fs.renameSync;
    const originalLinkSync = fs.linkSync;
    let injected = false;
    const injectDestination = (source, destination) => {
      if (!injected && source === claim && destination === publicationRecord) {
        fs.writeFileSync(destination, "late-unowned-publication-record");
        injected = true;
      }
    };
    fs.renameSync = function patchedRenameSync(source, destination, ...rest) {
      injectDestination(source, destination);
      return originalRenameSync.call(this, source, destination, ...rest);
    };
    fs.linkSync = function patchedLinkSync(source, destination, ...rest) {
      injectDestination(source, destination);
      return originalLinkSync.call(this, source, destination, ...rest);
    };
    try {
      const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
      assert.equal(injected, true, "fixture must create an unowned destination immediately before finalization");
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.equal(result.path, cached.shimPath);
      assert.equal(result.version, "0.4.1");
      assert.equal(result.freshness, "outdated");
      assert.equal(result.warning?.failureClass, "update-failed");
      assert.match(result.warning?.note ?? "", /publication claim finalization/i);
      assert.equal(fs.readFileSync(publicationRecord, "utf8"), "late-unowned-publication-record");
      assert.equal(fs.existsSync(claim), true, "the owned source claim must remain preserved after EEXIST");
      assert.equal(fs.existsSync(target), true, "the complete published target remains immutable");
    } finally {
      fs.renameSync = originalRenameSync;
      fs.linkSync = originalLinkSync;
    }
  });

  await t.test("a legacy complete target remains valid only when no adjacent publication claim exists", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const seeded = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(seeded.status, "ok", JSON.stringify(seeded));
    const legacyPath = seeded.path;
    const versionRoot = path.join(managedRoot, "versions", "0.4.2");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const publicationRecord = path.join(versionRoot, "publication.json");
    fs.unlinkSync(claim);
    fs.unlinkSync(publicationRecord);
    assert.equal(fs.existsSync(claim), false);
    assert.equal(fs.existsSync(publicationRecord), false);

    const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.path, legacyPath);
    assert.equal(result.version, "0.4.2");
    assert.equal(result.action, "present");
    assert.equal(result.freshness, "latest");
  });

  await t.test("a target left before failed link finalization remains incomplete on the next resolver", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const target = path.join(managedRoot, "versions", "0.4.2");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const publicationRecord = path.join(target, "publication.json");
    const originalLinkSync = fs.linkSync;
    let failedAtLink = false;
    fs.linkSync = function failingPublicationLink(source, destination, ...rest) {
      if (!failedAtLink && source === claim && destination === publicationRecord) {
        failedAtLink = true;
        const error = new Error("fixture link failure after target publication");
        error.code = "EIO";
        throw error;
      }
      return originalLinkSync.call(this, source, destination, ...rest);
    };
    let first;
    try {
      first = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    } finally {
      fs.linkSync = originalLinkSync;
    }
    assert.equal(failedAtLink, true, "fixture must fail after target rename and before publication linking");
    assert.equal(first.status, "ok", JSON.stringify(first));
    assert.equal(first.path, cached.shimPath);
    assert.equal(first.version, "0.4.1");
    assert.equal(first.freshness, "outdated");
    assert.equal(first.warning?.failureClass, "update-failed");
    assert.match(first.warning?.note ?? "", /publication claim finalization/i);
    const targetIdentity = fs.statSync(target);
    const claimIdentity = fs.statSync(claim);
    const claimBytes = fs.readFileSync(claim);
    assert.equal(fs.existsSync(publicationRecord), false);

    const second = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(second.status, "ok", JSON.stringify(second));
    assert.equal(second.path, cached.shimPath);
    assert.equal(second.version, "0.4.1");
    assert.equal(second.action, "cached");
    assert.equal(second.freshness, "outdated");
    assert.equal(second.warning?.failureClass, "update-failed");
    assert.match(second.warning?.note ?? "", /only after confirming no managed resolver process is active/i);
    assert.equal(fs.statSync(target).ino, targetIdentity.ino, "incomplete target must remain preserved");
    assert.equal(fs.statSync(claim).ino, claimIdentity.ino, "owned claim must remain preserved");
    assert.deepEqual(fs.readFileSync(claim), claimBytes);
    assert.equal(fs.existsSync(publicationRecord), false);
  });

  await t.test("finalization rejects a source claim swapped after the real hard link is created", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const target = path.join(managedRoot, "versions", "0.4.2");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const publicationRecord = path.join(target, "publication.json");
    const heldOwner = path.join(harness.root, "held-post-link-owner-claim");
    const originalLinkSync = fs.linkSync;
    const originalRenameSync = fs.renameSync;
    let swappedAfterLink = false;
    fs.linkSync = function swappingPublicationLink(source, destination, ...rest) {
      const linked = originalLinkSync.call(this, source, destination, ...rest);
      if (!swappedAfterLink && source === claim && destination === publicationRecord) {
        originalRenameSync.call(this, source, heldOwner);
        fs.writeFileSync(source, "post-link-unowned-source");
        swappedAfterLink = true;
      }
      return linked;
    };
    let first;
    try {
      first = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    } finally {
      fs.linkSync = originalLinkSync;
    }
    assert.equal(swappedAfterLink, true, "fixture must swap the source after the real hard link is created");
    assert.equal(first.status, "ok", JSON.stringify(first));
    assert.equal(first.path, cached.shimPath);
    assert.equal(first.version, "0.4.1");
    assert.equal(first.freshness, "outdated");
    assert.equal(first.warning?.failureClass, "update-failed");
    assert.match(first.warning?.note ?? "", /ownership replacement/i);
    assert.equal(fs.readFileSync(claim, "utf8"), "post-link-unowned-source");
    assert.equal(fs.statSync(heldOwner).ino, fs.statSync(publicationRecord).ino, "original owner links must remain preserved");
    const targetIdentity = fs.statSync(target);

    const second = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(second.status, "ok", JSON.stringify(second));
    assert.equal(second.path, cached.shimPath);
    assert.equal(second.version, "0.4.1");
    assert.equal(second.freshness, "outdated");
    assert.equal(second.warning?.failureClass, "update-failed");
    assert.match(second.warning?.note ?? "", /only after confirming no managed resolver process is active/i);
    assert.equal(fs.statSync(target).ino, targetIdentity.ino);
    assert.equal(fs.readFileSync(claim, "utf8"), "post-link-unowned-source");
    assert.equal(fs.statSync(heldOwner).ino, fs.statSync(publicationRecord).ino);
  });

  await t.test("finalization binds source record bytes to the opened claim inode", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const cached = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
    const target = path.join(managedRoot, "versions", "0.4.2");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const publicationRecord = path.join(target, "publication.json");
    const heldOwner = path.join(harness.root, "held-same-bytes-owner-claim");
    const originalLinkSync = fs.linkSync;
    const originalLstatSync = fs.lstatSync;
    const originalRenameSync = fs.renameSync;
    let linked = false;
    let swappedBetweenStatAndRead = false;
    fs.linkSync = function observingPublicationLink(source, destination, ...rest) {
      const result = originalLinkSync.call(this, source, destination, ...rest);
      if (source === claim && destination === publicationRecord) linked = true;
      return result;
    };
    fs.lstatSync = function swappingAfterSourceStat(entryPath, ...rest) {
      const stat = originalLstatSync.call(this, entryPath, ...rest);
      if (linked && !swappedBetweenStatAndRead && String(entryPath) === claim) {
        originalRenameSync.call(this, claim, heldOwner);
        fs.copyFileSync(publicationRecord, claim);
        swappedBetweenStatAndRead = true;
      }
      return stat;
    };
    let result;
    try {
      result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    } finally {
      fs.linkSync = originalLinkSync;
      fs.lstatSync = originalLstatSync;
    }
    assert.equal(swappedBetweenStatAndRead, true, "fixture must replace the claim after its old inode is observed");
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.path, cached.shimPath);
    assert.equal(result.version, "0.4.1");
    assert.equal(result.freshness, "outdated");
    assert.equal(result.warning?.failureClass, "update-failed");
    assert.match(result.warning?.note ?? "", /ownership replacement/i);
    assert.deepEqual(fs.readFileSync(claim), fs.readFileSync(publicationRecord), "same bytes must not hide inode replacement");
    assert.notEqual(fs.statSync(claim).ino, fs.statSync(publicationRecord).ino);
    assert.equal(fs.statSync(heldOwner).ino, fs.statSync(publicationRecord).ino);
  });

  await t.test("12 concurrent managed workers converge on one complete immutable version", { timeout: 45_000 }, async () => {
    const participants = 12;
    const harness = createHarness({ latestVersion: "0.4.2", registryIntegrity: "sha512-fixture" });
    const managedRoot = path.join(harness.root, "managed");
    const { workerPath, barrierRoot } = createManagedConvergenceWorker(harness, repoRoot, participants);
    const settlements = await Promise.allSettled(Array.from(
      { length: participants },
      () => launchManagedConvergenceWorker(workerPath, managedRoot, barrierRoot, participants),
    ));
    const rejected = settlements.filter((settlement) => settlement.status === "rejected");
    assert.deepEqual(rejected.map((settlement) => String(settlement.reason)), [], "all workers must settle successfully");
    const results = settlements.map((settlement) => settlement.value);
    const expectedPath = path.join(managedRoot, "versions", "0.4.2", "node_modules", ".bin", process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
    const readyWorkers = fs.readdirSync(barrierRoot).filter((entry) => /^\d+$/.test(entry));
    assert.equal(readyWorkers.length, participants, "every worker must finish staging before claim contention");
    const contentionPath = path.join(barrierRoot, "claim-contention.jsonl");
    assert.equal(fs.existsSync(contentionPath), true, "a loser must observe EEXIST while the winning claim is held");
    const contentionEvents = fs.readFileSync(contentionPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(contentionEvents.some((event) => event.event === "claim-eexist"), JSON.stringify(contentionEvents));
    for (const result of results) {
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.equal(result.version, "0.4.2");
      assert.equal(result.path, expectedPath);
      assert.equal(result.compatibility?.length, 9, JSON.stringify(result));
    }
    assert.equal(new Set(results.map((result) => result.path)).size, 1);
    const versionsRoot = path.join(managedRoot, "versions");
    assert.deepEqual(fs.readdirSync(versionsRoot), [".0.4.2.publish", "0.4.2"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(versionsRoot, "0.4.2", "install.json"), "utf8")).version, "0.4.2");
    assert.equal(JSON.parse(fs.readFileSync(path.join(versionsRoot, "0.4.2", "compatibility.json"), "utf8")).diagnostics.length, 9);
    const claimPath = path.join(versionsRoot, ".0.4.2.publish");
    const publicationPath = path.join(versionsRoot, "0.4.2", "publication.json");
    assert.equal(JSON.parse(fs.readFileSync(publicationPath, "utf8")).version, "0.4.2");
    assert.equal(fs.statSync(claimPath).ino, fs.statSync(publicationPath).ino, "durable publication must retain its owned claim hard link");
    assert.deepEqual(fs.readFileSync(claimPath), fs.readFileSync(publicationPath));
    assert.equal(JSON.parse(fs.readFileSync(path.join(versionsRoot, "0.4.2", "node_modules", "@picoxr", "pico-cli", "package.json"), "utf8")).version, "0.4.2");
    assert.deepEqual(fs.readdirSync(path.join(managedRoot, "staging")), []);
    assert.equal(harness.calls().filter((call) => call.role === "npm" && call.args[0] === "install").length, participants);
  });
});

test("managed registry cache fix round", { concurrency: false, timeout: 45_000 }, async (t) => {
  const viewCalls = (harness) => harness.calls().filter((call) => call.role === "npm" && call.args[0] === "view").length;

  await t.test("a successful registry result is reused only within one hour", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    let clock = Date.parse("2030-01-01T00:00:00.000Z");
    const io = createManagedIO(harness, { now: () => clock });
    const first = await resolveManagedPicoCli({ managedRoot, forceRefresh: true, installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000 }, io);
    assert.equal(first.status, "ok", JSON.stringify(first));
    clock += 60 * 60 * 1_000 - 1;
    const cached = await resolveManagedPicoCli({ managedRoot, installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000 }, io);
    assert.equal(cached.status, "ok", JSON.stringify(cached));
    assert.equal(cached.checkedAt, "2030-01-01T00:00:00.000Z");
    assert.equal(viewCalls(harness), 1, JSON.stringify(harness.calls()));

    clock += 1;
    const expired = await resolveManagedPicoCli({ managedRoot, installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000 }, io);
    assert.equal(expired.status, "ok", JSON.stringify(expired));
    assert.equal(expired.checkedAt, "2030-01-01T01:00:00.000Z");
    assert.equal(viewCalls(harness), 2, JSON.stringify(harness.calls()));
  });

  await t.test("forceRefresh bypasses a successful unexpired registry cache", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const io = createManagedIO(harness, { now: Date.parse("2031-01-01T00:00:00.000Z") });
    const first = await resolveManagedPicoCli({ managedRoot, forceRefresh: true, installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000 }, io);
    const refreshed = await resolveManagedPicoCli({ managedRoot, forceRefresh: true, installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000 }, io);
    assert.equal(first.status, "ok", JSON.stringify(first));
    assert.equal(refreshed.status, "ok", JSON.stringify(refreshed));
    assert.equal(viewCalls(harness), 2, JSON.stringify(harness.calls()));
  });

  for (const registryMode of ["failure", "malformed"]) {
    await t.test(`${registryMode} registry responses do not populate the successful cache`, async () => {
      const year = registryMode === "failure" ? 2032 : 2033;
      const harness = createHarness({ latestVersion: "0.4.2", registryMode });
      const managedRoot = path.join(harness.root, "managed");
      const io = createManagedIO(harness, { now: Date.parse(`${year}-01-01T00:00:00.000Z`) });
      const rejected = await resolveManagedPicoCli({ managedRoot, installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000 }, io);
      assert.equal(rejected.status, "unavailable", JSON.stringify(rejected));
      process.env.FAKE_REGISTRY_MODE = "success";
      const recovered = await resolveManagedPicoCli({ managedRoot, installTimeoutMs: 2_000, updateCheckTimeoutMs: 2_000 }, io);
      assert.equal(recovered.status, "ok", JSON.stringify(recovered));
      assert.equal(viewCalls(harness), 2, JSON.stringify(harness.calls()));
    });
  }
});

test.after(() => {
  restoreEnvironment();
  probePicoCli(true);
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});
