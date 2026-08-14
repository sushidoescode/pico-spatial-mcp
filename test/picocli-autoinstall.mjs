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
  createHarness,
  createManagedIO,
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
      updateCheckTimeoutMs: 250,
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
    assert.ok(canaryCalls.every((call) => call.options.timeoutMs === 250 && call.options.killGraceMs === 25), JSON.stringify(canaryCalls));
    const stored = JSON.parse(fs.readFileSync(path.join(managedRoot, "versions", "0.4.2", "compatibility.json"), "utf8"));
    assert.deepEqual(stored, { schemaVersion: 1, version: "0.4.2", diagnostics: result.compatibility });
  });
});

test.after(() => {
  restoreEnvironment();
  probePicoCli(true);
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});
