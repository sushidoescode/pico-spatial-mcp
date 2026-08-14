// Lazy pico-cli provisioning: present / absent-off / install / update / classified failure / bound.
// All commands are fakes on an isolated PATH; this test never contacts npm or a device.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPicoCliProvisionFailure,
  executableCandidates,
  picoCliFromEnsure,
  PICO_CLI_INSTALL_TIMEOUT_MS,
  runPicoCli,
  runPicoCliCommand,
} from "../dist/picocli.js";
import {
  createManagedConvergenceWorker,
  createHarness,
  createManagedIO,
  createManagedRuntimeHarness,
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
  managedContentIdentityForFixture,
} from "../dist/picoclimanaged.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function provisionManagedFixtureVersion(harness, managedRoot, version, {
  registryIntegrity = "sha512-fixture",
  afterInstall,
} = {}) {
  const keys = ["FAKE_LATEST_VERSION", "FAKE_REGISTRY_INTEGRITY", "FAKE_REGISTRY_MODE", "FAKE_NPM_MODE"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.FAKE_LATEST_VERSION = version;
  process.env.FAKE_REGISTRY_INTEGRITY = registryIntegrity;
  process.env.FAKE_REGISTRY_MODE = "success";
  process.env.FAKE_NPM_MODE = "success";
  const io = createManagedIO(harness);
  if (afterInstall) {
    const run = io.run;
    io.run = async (command, args, options) => {
      const result = await run(command, args, options);
      if (command === "npm" && args[0] === "install" && result.code === 0) {
        await afterInstall(args[args.indexOf("--prefix") + 1]);
      }
      return result;
    };
  }
  try {
    const result = await resolveManagedPicoCli({
      managedRoot,
      forceRefresh: true,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
      killGraceMs: 25,
    }, io);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.version, version, JSON.stringify(result));
    const versionRoot = path.join(managedRoot, "versions", version);
    return { result, io, versionRoot, shimPath: result.path };
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test("bounded runner compatibility helpers remain covered without ambient CLI access", () => {
  assert.equal(PICO_CLI_INSTALL_TIMEOUT_MS, 120_000);
  const candidates = executableCandidates("pico-cli", {
    Path: "C:\\Program Files\\npm;D:\\portable npm",
    PATHEXT: ".EXE;.CMD",
  }, "win32");
  assert.ok(candidates.includes("C:\\Program Files\\npm\\pico-cli.CMD"), JSON.stringify(candidates));
  assert.ok(candidates.includes("D:\\portable npm\\pico-cli.CMD"), JSON.stringify(candidates));

  assert.equal(classifyPicoCliProvisionFailure({ code: 1, signal: null, stdout: "", stderr: "EACCES permission denied", timedOut: false, outputTruncated: false }), "permissions");
  assert.equal(classifyPicoCliProvisionFailure({ code: 1, signal: null, stdout: "", stderr: "E404 404 Not Found - not in this registry", timedOut: false, outputTruncated: false }), "registry-404");
  assert.equal(classifyPicoCliProvisionFailure({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: "spawn npm ENOENT", outputTruncated: false }), "npm-unavailable");
  assert.equal(classifyPicoCliProvisionFailure({ code: null, signal: null, stdout: "", stderr: "", timedOut: true, outputTruncated: false }), "timeout");
});

test("the bounded runner rejects a failed synchronous pre-spawn identity check before execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico pre-spawn guard "));
  tempRoots.push(root);
  const marker = path.join(root, "executed");
  let checks = 0;
  const result = await runPicoCliCommand(process.execPath, [
    "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
  ], {
    timeoutMs: 2_000,
    beforeSpawn: () => {
      checks += 1;
      return "fixture identity changed";
    },
  });
  assert.equal(checks, 1);
  assert.equal(result.code, null);
  assert.match(result.spawnError ?? "", /fixture identity changed/);
  assert.equal(fs.existsSync(marker), false, "a rejected pre-spawn check must prevent process creation");
});

test("post-spawn detection kills a child before delayed work but is not a prevention claim", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico post-spawn guard "));
  tempRoots.push(root);
  const marker = path.join(root, "executed");
  let checks = 0;
  const result = await runPicoCliCommand(process.execPath, [
    "-e", `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'), 500)`,
  ], {
    timeoutMs: 2_000,
    afterSpawn: () => {
      checks += 1;
      return "fixture identity changed after spawn";
    },
  });
  assert.equal(checks, 1);
  assert.equal(result.code, null);
  assert.match(result.spawnError ?? "", /fixture identity changed after spawn/);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(fs.existsSync(marker), false, "a post-spawn rejection must kill the child before delayed work");
});

test("post-spawn detection reports an immediate child side effect instead of claiming prevention", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico post-spawn limitation "));
  tempRoots.push(root);
  const marker = path.join(root, "executed");
  const result = await runPicoCliCommand(process.execPath, [
    "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
  ], {
    timeoutMs: 2_000,
    afterSpawn: () => {
      const observationDeadline = Date.now() + 1_500;
      while (!fs.existsSync(marker) && Date.now() < observationDeadline) { /* child runs concurrently */ }
      return "fixture detected drift after spawn";
    },
  });
  assert.match(result.spawnError ?? "", /fixture detected drift after spawn/);
  assert.equal(fs.existsSync(marker), true, "post-spawn validation is detection/termination, not side-effect prevention");
});

test("a synchronous pre-spawn check that exhausts the command budget refuses to spawn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico slow pre-spawn guard "));
  tempRoots.push(root);
  const marker = path.join(root, "executed");
  const startedAt = Date.now();
  const result = await runPicoCliCommand(process.execPath, [
    "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
  ], {
    timeoutMs: 50,
    beforeSpawn: () => {
      while (Date.now() - startedAt < 150) { /* model an internal synchronous filesystem guard */ }
      return null;
    },
  });
  assert.equal(result.timedOut, true, JSON.stringify(result));
  assert.equal(result.code, null);
  assert.equal(fs.existsSync(marker), false, "an exhausted pre-spawn budget must refuse process creation");
});

test("a post-spawn check that exhausts the budget reports that process creation already happened", async () => {
  const result = await runPicoCliCommand(process.execPath, [
    "-e", "setTimeout(() => {}, 1000)",
  ], {
    timeoutMs: 25,
    afterSpawn: () => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 75) { /* model a slow synchronous post-spawn guard */ }
      return null;
    },
  });
  assert.equal(result.timedOut, true, JSON.stringify(result));
  assert.match(result.spawnError ?? "", /post-spawn validation exhausted.*after process creation/i);
  assert.doesNotMatch(result.spawnError ?? "", /before process creation/i);
});

test("post-spawn rejection uses the bounded Windows process-tree cleanup seam", async () => {
  const { runPicoCliCommandWithProcessTreeForFixture } = await import("../dist/picocli.js");
  assert.equal(typeof runPicoCliCommandWithProcessTreeForFixture, "function",
    "the production runner must expose its process-tree adapter to this structural seam");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico post-spawn win-tree seam "));
  tempRoots.push(root);
  const marker = path.join(root, "orphaned-grandchild-work");
  const treeCalls = [];
  let treeCleanupSettled = false;
  const result = await runPicoCliCommandWithProcessTreeForFixture(process.execPath, [
    "-e", `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphaned'), 500)`,
  ], {
    timeoutMs: 2_000,
    killGraceMs: 25,
    baseEnv: { ...process.env, SystemRoot: "C:\\FixtureWindows" },
    afterSpawn: () => "fixture managed identity changed after spawn",
  }, {
    platform: "win32",
    spawnTreeKiller(command, args) {
      treeCalls.push({ command, args });
      const killer = new EventEmitter();
      killer.kill = () => true;
      killer.unref = () => killer;
      const pid = Number(args[1]);
      setImmediate(() => {
        try { process.kill(pid, "SIGKILL"); } catch { /* the fixture child may already be gone */ }
      });
      setTimeout(() => {
        treeCleanupSettled = true;
        killer.emit("close", 0);
      }, 200);
      return killer;
    },
  });

  assert.equal(result.code, null, JSON.stringify(result));
  assert.match(result.spawnError ?? "", /fixture managed identity changed after spawn/);
  assert.equal(treeCleanupSettled, true, "the rejected child closing must not bypass taskkill settlement ownership");
  assert.equal(treeCalls.length, 1, JSON.stringify(treeCalls));
  assert.deepEqual(treeCalls[0], {
    command: "C:\\FixtureWindows\\System32\\taskkill.exe",
    args: ["/pid", treeCalls[0].args[1], "/t", "/f"],
  });
  assert.match(treeCalls[0].args[1], /^\d+$/);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(fs.existsSync(marker), false, "the simulated .cmd payload must not survive tree cleanup");
});

test("post-completion rejection owns one Windows process-tree cleanup through settlement", async () => {
  const { runPicoCliCommandWithProcessTreeForFixture } = await import("../dist/picocli.js");
  const treeCalls = [];
  const result = await runPicoCliCommandWithProcessTreeForFixture(process.execPath, ["-e", "process.exit(0)"], {
    timeoutMs: 100,
    killGraceMs: 25,
    baseEnv: { ...process.env, SystemRoot: "C:\\FixtureWindows" },
    afterCompletion: () => "fixture managed identity changed at completion",
  }, {
    platform: "win32",
    spawnTreeKiller(command, args) {
      treeCalls.push({ command, args });
      const killer = new EventEmitter();
      killer.kill = () => true;
      killer.unref = () => killer;
      setTimeout(() => killer.emit("close", 0), 200);
      return killer;
    },
  });

  assert.equal(result.code, null, JSON.stringify(result));
  assert.match(result.spawnError ?? "", /fixture managed identity changed at completion/);
  assert.equal(treeCalls.length, 1,
    `completion rejection must cancel the command timer and retain sole cleanup ownership: ${JSON.stringify(treeCalls)}`);
});

test("a managed command timeout gets a fresh bounded post-completion validation deadline", async () => {
  const harness = createHarness({ latestVersion: "0.4.2" });
  const managedRoot = path.join(harness.root, "managed-timeout-validation");
  const { result: ensured } = await provisionManagedFixtureVersion(harness, managedRoot, "0.4.2");
  const cli = picoCliFromEnsure(ensured);
  assert.ok(cli, JSON.stringify(ensured));

  const result = await runPicoCli(cli, ["fixture-hang"], {
    timeoutMs: 100,
    killGraceMs: 25,
  });

  assert.equal(result.timedOut, true, JSON.stringify(result));
  assert.equal(result.spawnError, undefined,
    `the intentional command timeout must not exhaust a separate post-completion guard: ${JSON.stringify(result)}`);
  const invocation = harness.calls().find((call) => call.role === "managed-cli" && call.args[1] === "fixture-hang");
  assert.ok(invocation?.pid, JSON.stringify(harness.calls()));
  await waitForProcessExit(invocation.pid);
});

test("the separate post-completion validation deadline remains cooperatively bounded", async () => {
  let receivedBudgetMs = null;
  const result = await runPicoCliCommand(process.execPath, ["-e", "process.exit(0)"], {
    timeoutMs: 2_000,
    completionValidationTimeoutMs: 25,
    afterCompletion: (deadlineMs) => {
      receivedBudgetMs = deadlineMs - Date.now();
      while (Date.now() <= deadlineMs) { /* model a cooperative synchronous validation at its bound */ }
      return null;
    },
  });

  assert.ok(receivedBudgetMs > 0 && receivedBudgetMs <= 25, `unexpected guard budget: ${receivedBudgetMs}`);
  assert.equal(result.timedOut, false, JSON.stringify(result));
  assert.match(result.spawnError ?? "", /post-completion validation exhausted its validation deadline/i);
});

test("default managed calls snapshot one call-time environment and home after import", { timeout: 15_000 }, () => {
  const harness = createManagedRuntimeHarness();
  const importHome = path.join(harness.root, "import-home");
  const inspectHome = path.join(harness.root, "inspect-home");
  const policyRoot = path.join(harness.root, "policy-root");
  fs.mkdirSync(importHome);
  fs.mkdirSync(inspectHome);
  const runtimeKeys = new Set([
    "HOME", "USERPROFILE", "PATH", "Path", "PATHEXT", "ComSpec", "SystemRoot",
    "PICO_HOME", "PICO_MCP_CLI_POLICY",
  ]);
  const runtimeEnv = Object.fromEntries(Object.entries(harness.env).filter(
    ([key]) => runtimeKeys.has(key) || key.startsWith("FAKE_"),
  ));
  runtimeEnv.FAKE_PICO_VIEW_DELAY_MS = "100";
  const moduleUrl = new URL("../dist/picocli.js", import.meta.url).href;
  const script = `
const { ensurePicoCli, inspectPicoCliCached } = await import(${JSON.stringify(moduleUrl)});
Object.assign(process.env, ${JSON.stringify(runtimeEnv)});
const pendingEnsure = ensurePicoCli({ forceRefresh: true, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 });
process.env.PICO_TEST_LATE_ENV = "must-not-reach-snapshotted-children";
const ensured = await pendingEnsure;
process.env.HOME = ${JSON.stringify(inspectHome)};
process.env.USERPROFILE = ${JSON.stringify(inspectHome)};
const inspected = await inspectPicoCliCached();
delete process.env.PICO_TEST_LATE_ENV;
process.env.PICO_MCP_CLI_POLICY = "disabled";
const disabledPromise = ensurePicoCli({ managedRoot: ${JSON.stringify(policyRoot)}, forceRefresh: true, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 });
process.env.PICO_MCP_CLI_POLICY = "managed-latest";
const enabledPromise = ensurePicoCli({ managedRoot: ${JSON.stringify(policyRoot)}, forceRefresh: true, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 });
const [disabled, enabled] = await Promise.all([disabledPromise, enabledPromise]);
process.stdout.write(JSON.stringify({ ensured, inspected, disabled, enabled }));
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, HOME: importHome, USERPROFILE: importHome },
    encoding: "utf8",
    timeout: 12_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const out = JSON.parse(child.stdout);
  assert.equal(out.ensured.status, "ok", JSON.stringify(out.ensured));
  assert.equal(out.ensured.path, path.join(
    harness.managedRoot,
    "versions", "0.4.2", "node_modules", ".bin",
    process.platform === "win32" ? "pico-cli.cmd" : "pico-cli",
  ));
  assert.equal(out.inspected.status, "unavailable", JSON.stringify(out.inspected));
  assert.equal(out.disabled.status, "unavailable", JSON.stringify(out.disabled));
  assert.equal(out.disabled.policy, "disabled", JSON.stringify(out.disabled));
  assert.equal(out.enabled.status, "ok", JSON.stringify(out.enabled));
  assert.equal(out.enabled.policy, "managed-latest", JSON.stringify(out.enabled));
  assert.equal(fs.existsSync(path.join(importHome, ".pico-mcp", "cli")), false,
    "the import-time home must never receive call-time fake npm output");
  assert.equal(fs.existsSync(harness.managedRoot), true, "default ensure must use its call-time home");
  assert.equal(harness.calls().every((call) => call.lateEnv === null), true,
    `managed children must retain the call-time environment snapshot: ${JSON.stringify(harness.calls())}`);
  assert.equal(fs.existsSync(path.join(inspectHome, ".pico-mcp", "cli")), false,
    "default cached inspection must use its own call-time home without creating it");
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
    const harness = createHarness({ latestVersion: "0.4.2" });
    const root = harness.root;
    const managedRoot = path.join(harness.root, "managed");
    const calls = [];
    const publish = async (version, {
      recordVersion = version,
      packageVersion = version,
      cliVersion = version,
      relativeCliPath = path.join("node_modules", ".bin", process.platform === "win32" ? "pico-cli.cmd" : "pico-cli"),
      recordText,
    } = {}) => {
      const published = await provisionManagedFixtureVersion(harness, managedRoot, version);
      const recordPath = path.join(published.versionRoot, "install.json");
      const packagePath = path.join(published.versionRoot, "node_modules", "@picoxr", "pico-cli", "package.json");
      if (recordText !== undefined) fs.writeFileSync(recordPath, recordText);
      else if (recordVersion !== version || relativeCliPath !== path.join("node_modules", ".bin", process.platform === "win32" ? "pico-cli.cmd" : "pico-cli")) {
        const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        fs.writeFileSync(recordPath, JSON.stringify({ ...record, version: recordVersion, relativeCliPath }));
      }
      if (packageVersion !== version) {
        fs.writeFileSync(packagePath, JSON.stringify({ name: "@picoxr/pico-cli", version: packageVersion }));
      }
      if (cliVersion !== version) {
        const shim = fs.readFileSync(published.shimPath, "utf8");
        assert.match(shim, new RegExp(version.replaceAll(".", "\\.")));
        fs.writeFileSync(published.shimPath, shim.replace(version, cliVersion), { mode: 0o755 });
      }
      return published.shimPath;
    };
    const baseIo = createManagedIO(harness);
    const io = (env = {}) => ({
      env,
      platform: process.platform,
      homeDir: path.join(root, "unused-home"),
      now: () => 0,
      randomUUID: () => "unused",
      run: async (command, args) => {
        calls.push({ command, args });
        return baseIo.run(command, args);
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
    await fixture.publish("0.4.1");
    const newestShim = await fixture.publish("0.4.2");
    const beforeInspection = fixture.publishedFiles();
    const result = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, fixture.io());
    const { compatibility, ...summary } = result;
    assert.deepEqual(summary, {
      status: "ok", source: "managed", policy: "managed-latest", action: "cached", path: newestShim,
      version: "0.4.2", raw: "pico-cli/0.4.2 (managed fixture)", latestVersion: null, checkedAt: null,
      freshness: "cached", deprecatedAliases: [],
    });
    assert.equal(compatibility?.length, 9);
    assert.deepEqual(fixture.calls, [{ command: newestShim, args: ["-v"] }]);
    assert.deepEqual(fixture.publishedFiles(), beforeInspection, "inspection must not alter published files");
    assert.equal(fs.existsSync(path.join(fixture.managedRoot, "versions", "0.4.3")), false);
  });

  await t.test("a relative managedRoot resolves the published immutable version", async () => {
    const fixture = managedFixture();
    const newestShim = await fixture.publish("0.4.2");
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
      const fallbackShim = await fixture.publish("0.4.1");
      const rejectedShim = await fixture.publish("0.4.2", item.options);
      const result = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, fixture.io());
      assert.equal(result.status, "ok", `${item.name}: ${JSON.stringify(result)}`);
      assert.equal(result.path, fallbackShim, item.name);
      assert.equal(result.version, "0.4.1", item.name);
      const expectedCalls = [{ command: fallbackShim, args: ["-v"] }];
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
    const postinstallMarker = path.join(harness.root, "postinstall-ran");
    const run = io.run;
    io.run = async (command, args, options) => {
      if (command === "npm" && args[0] === "install" && !args.includes("--ignore-scripts")) {
        fs.writeFileSync(postinstallMarker, "fixture package lifecycle executed");
      }
      return run(command, args, options);
    };
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
      "--no-save", "--package-lock=false", "--ignore-scripts", "--fund=false", "--audit=false", "@picoxr/pico-cli@0.4.2",
    ]);
    assert.equal(fs.existsSync(postinstallMarker), false, "managed exact install must suppress package lifecycle scripts");
    for (const call of harness.calls()) {
      assert.equal(call.args.includes("-g"), false, JSON.stringify(call));
      assert.equal(call.args.includes("--global"), false, JSON.stringify(call));
      assert.equal(call.args.includes("setup"), false, JSON.stringify(call));
      assert.equal(call.args.join(" ").includes("update --check"), false, JSON.stringify(call));
    }

    const versionRoot = path.join(managedRoot, "versions", "0.4.2");
    assert.equal(cold.path, path.join(versionRoot, canonicalRelativeCliPath));
    const installRecord = JSON.parse(fs.readFileSync(path.join(versionRoot, "install.json"), "utf8"));
    assert.deepEqual(Object.keys(installRecord).sort(), [
      "contentManifestEntryCount", "contentManifestSchemaVersion", "contentManifestSha256",
      "contentManifestTotalBytes", "installedAt", "registryIntegrity", "relativeCliPath", "schemaVersion", "version",
    ]);
    assert.equal(installRecord.schemaVersion, 2);
    assert.equal(installRecord.version, "0.4.2");
    assert.equal(installRecord.relativeCliPath, canonicalRelativeCliPath);
    assert.equal(installRecord.registryIntegrity, "sha512-fixture");
    assert.equal(installRecord.installedAt, "2026-08-14T12:00:00.000Z");
    assert.equal(installRecord.contentManifestSchemaVersion, 1);
    assert.match(installRecord.contentManifestSha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(installRecord.contentManifestEntryCount) && installRecord.contentManifestEntryCount > 0);
    assert.ok(Number.isSafeInteger(installRecord.contentManifestTotalBytes) && installRecord.contentManifestTotalBytes > 0);
    const publicationRecord = JSON.parse(fs.readFileSync(path.join(versionRoot, "publication.json"), "utf8"));
    assert.equal(publicationRecord.contentManifestSchemaVersion, installRecord.contentManifestSchemaVersion);
    assert.equal(publicationRecord.contentManifestSha256, installRecord.contentManifestSha256);
    assert.equal(publicationRecord.contentManifestEntryCount, installRecord.contentManifestEntryCount);
    assert.equal(publicationRecord.contentManifestTotalBytes, installRecord.contentManifestTotalBytes);
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
  await t.test("a dangling exact-version target fails before install with complete recovery guidance", async (context) => {
    if (process.platform === "win32") {
      context.skip("native Windows symlink creation is outside this macOS structural lane");
      return;
    }
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const versionsRoot = path.join(managedRoot, "versions");
    const target = path.join(versionsRoot, "0.4.2");
    const claim = path.join(versionsRoot, ".0.4.2.publish");
    fs.mkdirSync(versionsRoot, { recursive: true });
    fs.symlinkSync(path.join(harness.root, "missing-version-directory"), target);
    const targetBefore = fs.lstatSync(target);

    const result = await resolveManagedPicoCli({
      managedRoot,
      forceRefresh: true,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
    }, createManagedIO(harness));

    assert.equal(result.status, "unavailable", JSON.stringify(result));
    assert.equal(harness.calls().filter((call) => call.role === "npm" && call.args[0] === "install").length, 0,
      `a non-directory target must fail before package installation: ${JSON.stringify(harness.calls())}`);
    assert.equal(harness.calls().filter((call) => call.role === "managed-cli").length, 0,
      `a non-directory target must fail before probe/canary execution: ${JSON.stringify(harness.calls())}`);
    assert.match(result.note, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.note, new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.note, /remove both/i);
    assert.equal(fs.lstatSync(target).ino, targetBefore.ino, "the dangling target must be preserved exactly");
    assert.equal(fs.existsSync(claim), false, "pre-install rejection must not create a publication claim");
  });

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

test("managed publication content identity rejects post-publication byte and path drift", { concurrency: false, timeout: 45_000 }, async (t) => {
  async function publish({ afterInstall } = {}) {
    const harness = createHarness({ latestVersion: "0.4.2", registryIntegrity: "sha512-fixture" });
    const managedRoot = path.join(harness.root, "managed");
    const published = await provisionManagedFixtureVersion(harness, managedRoot, "0.4.2", { afterInstall });
    return { harness, managedRoot, ...published };
  }

  await t.test("an unchanged finalized publication remains accepted", async () => {
    const fixture = await publish();
    const before = fs.readFileSync(path.join(fixture.versionRoot, "install.json"));
    const inspected = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, createManagedIO(fixture.harness));
    assert.equal(inspected.status, "ok", JSON.stringify(inspected));
    assert.equal(inspected.path, fixture.shimPath);
    assert.equal(inspected.version, "0.4.2");
    assert.deepEqual(fs.readFileSync(path.join(fixture.versionRoot, "install.json")), before);
  });

  for (const legacy of [
    { name: "schema-1", schemaVersion: 1 },
    { name: "schema-2 missing content identity", schemaVersion: 2 },
  ]) {
    await t.test(`${legacy.name} install records fail closed with exact manual recovery`, async () => {
      const fixture = await publish();
      const relativeCliPath = path.join("node_modules", ".bin", process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
      fs.writeFileSync(path.join(fixture.versionRoot, "install.json"), JSON.stringify({
        schemaVersion: legacy.schemaVersion,
        version: "0.4.2",
        relativeCliPath,
        registryIntegrity: "sha512-fixture",
        installedAt: "2026-08-14T12:00:00.000Z",
      }));
      const claim = path.join(fixture.managedRoot, "versions", ".0.4.2.publish");
      const io = createManagedIO(fixture.harness);
      const inspected = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, io);
      assert.equal(inspected.status, "unavailable", JSON.stringify(inspected));
      assert.equal(inspected.failureClass, "cli-missing");
      assert.match(inspected.note, new RegExp(fixture.versionRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(inspected.note, new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(inspected.note, /after confirming no managed resolver process is active/i);
      assert.match(inspected.note, /remove both/i);
      assert.match(inspected.note, /retry/i);
      assert.deepEqual(io.commands, [], "an unbound install record must fail before executing the shim");
    });
  }

  await t.test("same-version shim byte replacement is rejected before execution", async () => {
    const fixture = await publish();
    const original = fs.readFileSync(fixture.shimPath, "utf8");
    const replacement = process.platform === "win32"
      ? original.replace("@echo off", "@ECHO OFF")
      : original.replace("exec ", "exec\t");
    assert.notEqual(replacement, original, "fixture must change executable bytes");
    assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original), "fixture must preserve executable size");
    fs.writeFileSync(fixture.shimPath, replacement, process.platform === "win32" ? undefined : { mode: 0o755 });
    const io = createManagedIO(fixture.harness);
    const callsBefore = io.commands.length;
    const inspected = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, io);
    assert.equal(inspected.status, "unavailable", JSON.stringify(inspected));
    assert.equal(inspected.failureClass, "cli-missing");
    assert.equal(io.commands.length, callsBefore, "a content-mismatched shim must not be executed even when it still reports the same version");
  });

  await t.test("an in-root shim symlink retargeted outside the version root is rejected before execution", async (context) => {
    if (process.platform === "win32") {
      context.skip("native Windows symlink creation requires privileges not established by this structural lane");
      return;
    }
    const fixture = await publish();
    const outside = path.join(fixture.harness.root, "outside-same-version-pico-cli");
    fs.copyFileSync(fixture.shimPath, outside);
    fs.chmodSync(outside, 0o755);
    fs.unlinkSync(fixture.shimPath);
    fs.symlinkSync(outside, fixture.shimPath);
    const io = createManagedIO(fixture.harness);
    const inspected = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, io);
    assert.equal(inspected.status, "unavailable", JSON.stringify(inspected));
    assert.equal(inspected.failureClass, "cli-missing");
    assert.deepEqual(io.commands, [], "an out-of-root symlink target must never be executed");
  });

  await t.test("a cached shim swapped to an out-of-root same-version executable inside io.run is rejected before spawn", async (context) => {
    if (process.platform === "win32") {
      context.skip("native Windows symlink creation requires privileges not established by this structural lane");
      return;
    }
    const fixture = await publish();
    const marker = path.join(fixture.harness.root, "cached-outside-executed");
    const outside = path.join(fixture.harness.root, "cached-outside-same-version-pico-cli");
    fs.writeFileSync(outside, `#!/bin/sh\nprintf executed > '${marker.replaceAll("'", `'\\''`)}'\nexec '${process.execPath.replaceAll("'", `'\\''`)}' '${fixture.harness.driverPath.replaceAll("'", `'\\''`)}' managed-cli 0.4.2 "$@"\n`, { mode: 0o755 });
    const io = createManagedIO(fixture.harness);
    const run = io.run;
    let swapped = false;
    io.run = (command, args, options) => {
      if (!swapped && command === fixture.shimPath && args.length === 1 && args[0] === "-v") {
        fs.unlinkSync(fixture.shimPath);
        fs.symlinkSync(outside, fixture.shimPath);
        swapped = true;
      }
      return run(command, args, options);
    };
    const inspected = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, io);
    assert.equal(swapped, true, "fixture must swap at the validation-to-run boundary");
    assert.equal(inspected.status, "unavailable", JSON.stringify(inspected));
    assert.equal(fs.existsSync(marker), false, "the out-of-root replacement must not execute");
  });

  await t.test("a staged shim swapped to an out-of-root same-version executable inside io.run is rejected before spawn", async (context) => {
    if (process.platform === "win32") {
      context.skip("native Windows symlink creation requires privileges not established by this structural lane");
      return;
    }
    const harness = createHarness({ latestVersion: "0.4.2", registryIntegrity: "sha512-fixture" });
    const managedRoot = path.join(harness.root, "managed");
    const marker = path.join(harness.root, "staged-outside-executed");
    const outside = path.join(harness.root, "staged-outside-same-version-pico-cli");
    fs.writeFileSync(outside, `#!/bin/sh\nprintf executed > '${marker.replaceAll("'", `'\\''`)}'\nexec '${process.execPath.replaceAll("'", `'\\''`)}' '${harness.driverPath.replaceAll("'", `'\\''`)}' managed-cli 0.4.2 "$@"\n`, { mode: 0o755 });
    const io = createManagedIO(harness);
    const run = io.run;
    let swapped = false;
    io.run = (command, args, options) => {
      if (!swapped && command.includes(path.join(managedRoot, "staging")) && args.length === 1 && args[0] === "-v") {
        fs.unlinkSync(command);
        fs.symlinkSync(outside, command);
        swapped = true;
      }
      return run(command, args, options);
    };
    const resolved = await resolveManagedPicoCli({
      managedRoot,
      forceRefresh: true,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
      killGraceMs: 25,
    }, io);
    assert.equal(swapped, true, "fixture must swap the staged shim at the validation-to-run boundary");
    assert.equal(resolved.status, "unavailable", JSON.stringify(resolved));
    assert.equal(fs.existsSync(marker), false, "the staged out-of-root replacement must not execute");
  });

  await t.test("queued relative paths are charged before traversal", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico managed path budget "));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, "long-child-name"));
    assert.throws(
      () => managedContentIdentityForFixture(root, { maxPathBytes: 2 }),
      /path.*bound/i,
    );
  });

  await t.test("registry failure still reports exact recovery for a legacy managed target", async () => {
    const harness = createHarness({ registryMode: "failure" });
    const managedRoot = path.join(harness.root, "managed");
    const fixture = publishManagedFixtureVersion(harness, managedRoot, "0.4.2");
    fs.writeFileSync(path.join(fixture.versionRoot, "install.json"), JSON.stringify({
      schemaVersion: 1,
      version: "0.4.2",
      relativeCliPath: path.join("node_modules", ".bin", process.platform === "win32" ? "pico-cli.cmd" : "pico-cli"),
      registryIntegrity: null,
      installedAt: "2026-08-14T12:00:00.000Z",
    }));
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const result = await resolveManagedPicoCli({
      managedRoot,
      forceRefresh: true,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
      killGraceMs: 25,
    }, createManagedIO(harness));
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    assert.match(result.note, new RegExp(fixture.versionRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.note, new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.note, /after confirming no managed resolver process is active/i);
    assert.match(result.note, /remove both/i);
    assert.match(result.note, /retry/i);
  });

  await t.test("the hard-linked publication claim rejects changed bytes even when install.json is rewritten with their digest", async () => {
    const fixture = await publish();
    const packagePath = path.join(fixture.versionRoot, "node_modules", "@picoxr", "pico-cli", "package.json");
    fs.writeFileSync(packagePath, JSON.stringify({
      name: "@picoxr/pico-cli",
      version: "0.4.2",
      rewrittenAfterPublication: true,
    }));
    const installPath = path.join(fixture.versionRoot, "install.json");
    const install = JSON.parse(fs.readFileSync(installPath, "utf8"));
    const rewrittenIdentity = managedContentIdentityForFixture(fixture.versionRoot);
    install.contentManifestSchemaVersion = rewrittenIdentity.schemaVersion;
    install.contentManifestSha256 = rewrittenIdentity.digest;
    install.contentManifestEntryCount = rewrittenIdentity.entryCount;
    install.contentManifestTotalBytes = rewrittenIdentity.totalBytes;
    fs.writeFileSync(installPath, JSON.stringify(install));
    const io = createManagedIO(fixture.harness);
    const inspected = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, io);
    assert.equal(inspected.status, "unavailable", JSON.stringify(inspected));
    assert.deepEqual(io.commands, [], "publication/content mismatch must fail before executable probing");
  });

  await t.test("a changed hard-linked publication manifest binding is rejected before execution", async () => {
    const fixture = await publish();
    const publicationPath = path.join(fixture.versionRoot, "publication.json");
    const claimPath = path.join(fixture.managedRoot, "versions", ".0.4.2.publish");
    const publication = JSON.parse(fs.readFileSync(publicationPath, "utf8"));
    publication.contentManifestSha256 = "0".repeat(64);
    fs.writeFileSync(publicationPath, `${JSON.stringify(publication)}\n`);
    assert.deepEqual(
      fs.readFileSync(claimPath),
      fs.readFileSync(publicationPath),
      "the fixture must corrupt the shared hard-linked publication record",
    );
    const io = createManagedIO(fixture.harness);
    const inspected = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, io);
    assert.equal(inspected.status, "unavailable", JSON.stringify(inspected));
    assert.deepEqual(io.commands, [], "a publication-record binding mismatch must fail before executable probing");
  });

  for (const mutation of [
    {
      name: "same-version package metadata bytes",
      mutate: ({ versionRoot }) => fs.writeFileSync(
        path.join(versionRoot, "node_modules", "@picoxr", "pico-cli", "package.json"),
        JSON.stringify({ name: "@picoxr/pico-cli", version: "0.4.2", changedAfterPublication: true }),
      ),
    },
    {
      name: "installed dependency bytes",
      afterInstall: (staging) => {
        const dependency = path.join(staging, "node_modules", "fixture-dependency", "index.js");
        fs.mkdirSync(path.dirname(dependency), { recursive: true });
        fs.writeFileSync(dependency, "export const value = 'original';\n");
      },
      mutate: ({ versionRoot }) => fs.writeFileSync(
        path.join(versionRoot, "node_modules", "fixture-dependency", "index.js"),
        "export const value = 'tampered';\n",
      ),
    },
  ]) {
    await t.test(`${mutation.name} are rejected even though pico-cli -v is unchanged`, async () => {
      const fixture = await publish({ afterInstall: mutation.afterInstall });
      mutation.mutate(fixture);
      const io = createManagedIO(fixture.harness);
      const inspected = await inspectManagedPicoCli({ managedRoot: fixture.managedRoot }, io);
      assert.equal(inspected.status, "unavailable", `${mutation.name}: ${JSON.stringify(inspected)}`);
      assert.equal(inspected.failureClass, "cli-missing");
      assert.deepEqual(io.commands, [], `${mutation.name} must fail before executing the shim`);
    });
  }
});

test("managed wrapper execution retains publication identity", { concurrency: false, timeout: 45_000 }, async (t) => {
  await t.test("a provisioned shim rewritten before runPicoCli never executes the replacement payload", async () => {
    const harness = createHarness({ latestVersion: "0.4.2", registryIntegrity: "sha512-fixture" });
    const managedRoot = path.join(harness.root, "managed");
    const provisioned = await provisionManagedFixtureVersion(harness, managedRoot, "0.4.2");
    const marker = path.join(harness.root, "replacement-executed");
    const replacement = process.platform === "win32"
      ? `@echo off\r\n>"${marker}" echo replacement\r\nexit /b 0\r\n`
      : `#!/bin/sh\nprintf replacement > '${marker.replaceAll("'", `'\\''`)}'\nexit 0\n`;
    fs.writeFileSync(provisioned.shimPath, replacement, process.platform === "win32" ? undefined : { mode: 0o755 });

    const ready = picoCliFromEnsure(provisioned.result);
    assert.ok(ready, JSON.stringify(provisioned.result));
    const executed = await runPicoCli(ready, ["fixture-operation"], { timeoutMs: 2_000, killGraceMs: 25 });

    assert.equal(executed.code, null, JSON.stringify(executed));
    assert.match(executed.spawnError ?? "", /managed pico-cli.*identity|managed publication/i);
    assert.equal(fs.existsSync(marker), false, "the rewritten payload must be rejected before process creation");
  });

  await t.test("a managed tree changed by the child is rejected after command completion", async () => {
    const harness = createHarness({ latestVersion: "0.4.2", registryIntegrity: "sha512-fixture" });
    const managedRoot = path.join(harness.root, "managed");
    const provisioned = await provisionManagedFixtureVersion(harness, managedRoot, "0.4.2");
    const packageJson = path.join(provisioned.versionRoot, "node_modules", "@picoxr", "pico-cli", "package.json");
    const ready = picoCliFromEnsure(provisioned.result);
    assert.ok(ready, JSON.stringify(provisioned.result));

    const executed = await runPicoCli(ready, ["fixture-mutate-managed-file"], {
      timeoutMs: 2_000,
      killGraceMs: 25,
      env: { FAKE_MANAGED_MUTATION_TARGET: packageJson },
    });

    assert.equal(executed.code, null, JSON.stringify(executed));
    assert.match(executed.spawnError ?? "", /post-completion validation failed.*managed pico-cli publication identity/i);
    assert.match(fs.readFileSync(packageJson, "utf8"), /fixture post-spawn mutation/,
      "the fixture must prove post-completion detection rather than pre-spawn prevention");
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
      const startedAt = Date.now();
      const updateFailed = await resolveManagedPicoCli(optionsFor(managedRoot, failure.overrides), createManagedIO(harness));
      const elapsedMs = Date.now() - startedAt;
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
      if (failure.name === "npm timeout") {
        assert.ok(elapsedMs < 3_000, `managed npm timeout took ${elapsedMs}ms`);
        if (process.platform === "win32") {
          const descendantPid = harness.calls().find((call) => call.event === "descendant")?.descendantPid;
          assert.equal(typeof descendantPid, "number", JSON.stringify(harness.calls()));
          await waitForProcessExit(descendantPid);
        }
      }
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
    {
      name: "corrupt install record",
      mutate: ({ versionRoot }) => fs.writeFileSync(path.join(versionRoot, "install.json"), "not-json"),
    },
    {
      name: "corrupt package version mismatch",
      mutate: ({ versionRoot }) => fs.writeFileSync(
        path.join(versionRoot, "node_modules", "@picoxr", "pico-cli", "package.json"),
        JSON.stringify({ name: "@picoxr/pico-cli", version: "0.4.1" }),
      ),
    },
    {
      name: "corrupt shim mutation",
      mutate: ({ shimPath }) => fs.writeFileSync(shimPath, "#!/bin/sh\nexit 9\n", { mode: 0o755 }),
    },
  ]) {
    await t.test(`${corruption.name} is skipped without erasing it or the valid fallback`, async () => {
      const harness = createHarness({ registryMode: "failure" });
      const managedRoot = path.join(harness.root, "managed");
      const fallback = publishManagedFixtureVersion(harness, managedRoot, "0.4.1");
      const rejected = publishManagedFixtureVersion(harness, managedRoot, "0.4.2");
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

  await t.test("a target missing both publication control records fails closed with exact manual recovery", async () => {
    const harness = createHarness({ latestVersion: "0.4.2" });
    const managedRoot = path.join(harness.root, "managed");
    const seeded = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(seeded.status, "ok", JSON.stringify(seeded));
    const versionRoot = path.join(managedRoot, "versions", "0.4.2");
    const claim = path.join(managedRoot, "versions", ".0.4.2.publish");
    const publicationRecord = path.join(versionRoot, "publication.json");
    fs.unlinkSync(claim);
    fs.unlinkSync(publicationRecord);
    assert.equal(fs.existsSync(claim), false);
    assert.equal(fs.existsSync(publicationRecord), false);

    const result = await resolveManagedPicoCli(optionsFor(managedRoot), createManagedIO(harness));
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    assert.equal(result.failureClass, "cli-unusable");
    assert.match(result.note, new RegExp(versionRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.note, new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.note, /after confirming no managed resolver process is active/i);
    assert.match(result.note, /remove both/i);
    assert.match(result.note, /retry/i);
    assert.equal(fs.existsSync(versionRoot), true, "the resolver must preserve the incomplete target for manual recovery");
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

  await t.test("sequential registry environments sharing one npm identity never share latest metadata", async () => {
    const firstHarness = createHarness({ latestVersion: "0.4.1", registryIntegrity: "sha512-registry-a" });
    const firstRoot = path.join(firstHarness.root, "managed");
    const firstIo = createManagedIO(firstHarness, {
      env: { NPM_CONFIG_REGISTRY: "https://registry-a.invalid/" },
      npmCommandIdentity: "shared-fixture-npm",
    });
    const first = await resolveManagedPicoCli({
      managedRoot: firstRoot,
      forceRefresh: true,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
    }, firstIo);
    assert.equal(first.status, "ok", JSON.stringify(first));
    assert.equal(first.version, "0.4.1");
    assert.equal(viewCalls(firstHarness), 1, JSON.stringify(firstHarness.calls()));

    const secondHarness = createHarness({ latestVersion: "0.4.2", registryIntegrity: "sha512-registry-b" });
    const secondRoot = path.join(secondHarness.root, "managed");
    const secondIo = createManagedIO(secondHarness, {
      env: { NPM_CONFIG_REGISTRY: "https://registry-b.invalid/" },
      npmCommandIdentity: "shared-fixture-npm",
    });
    const second = await resolveManagedPicoCli({
      managedRoot: secondRoot,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
    }, secondIo);

    assert.equal(second.status, "ok", JSON.stringify(second));
    assert.equal(second.version, "0.4.2", JSON.stringify(second));
    assert.equal(second.latestVersion, "0.4.2", JSON.stringify(second));
    assert.equal(viewCalls(secondHarness), 1,
      `the second registry/npm context must perform its own latest lookup: ${JSON.stringify(secondHarness.calls())}`);
  });

  await t.test("sequential npm identities sharing one registry environment never share latest metadata", async () => {
    const env = { NPM_CONFIG_REGISTRY: "https://registry-shared.invalid/" };
    const firstHarness = createHarness({ latestVersion: "0.4.3", registryIntegrity: "sha512-npm-a" });
    const first = await resolveManagedPicoCli({
      managedRoot: path.join(firstHarness.root, "managed"),
      forceRefresh: true,
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
    }, createManagedIO(firstHarness, { env, npmCommandIdentity: "fixture-npm-a" }));
    assert.equal(first.status, "ok", JSON.stringify(first));
    assert.equal(first.version, "0.4.3");
    assert.equal(viewCalls(firstHarness), 1, JSON.stringify(firstHarness.calls()));

    const secondHarness = createHarness({ latestVersion: "0.4.4", registryIntegrity: "sha512-npm-b" });
    const second = await resolveManagedPicoCli({
      managedRoot: path.join(secondHarness.root, "managed"),
      installTimeoutMs: 2_000,
      updateCheckTimeoutMs: 2_000,
    }, createManagedIO(secondHarness, { env, npmCommandIdentity: "fixture-npm-b" }));
    assert.equal(second.status, "ok", JSON.stringify(second));
    assert.equal(second.version, "0.4.4", JSON.stringify(second));
    assert.equal(second.latestVersion, "0.4.4", JSON.stringify(second));
    assert.equal(viewCalls(secondHarness), 1,
      `the second npm identity must perform its own latest lookup: ${JSON.stringify(secondHarness.calls())}`);
  });

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

test("Task 4 production adapters use the managed absolute CLI without eager provisioning", { concurrency: false, timeout: 45_000 }, async (t) => {
  async function withServer(harness, surface, callback) {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "dist", "index.js")],
      cwd: repoRoot,
      env: { ...harness.env, PICO_MCP_SURFACE: surface },
      stderr: "pipe",
    });
    const client = new Client({ name: "managed-task-4-test", version: "1" });
    try {
      await client.connect(transport);
      return await callback(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  await t.test("startup and tools/list neither contact npm nor create the managed root", async () => {
    const harness = createManagedRuntimeHarness();
    await withServer(harness, "full", async (client) => {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "ensure_pico_cli"));
      assert.equal(fs.existsSync(harness.managedRoot), false);
      assert.equal(harness.calls().filter((call) => call.role === "npm").length, 0, JSON.stringify(harness.calls()));
    });
  });

  await t.test("a default wrapper provisions the managed absolute path and always returns provenance", async () => {
    const harness = createManagedRuntimeHarness();
    await withServer(harness, "full", async (client) => {
      const invoke = async () => JSON.parse((await client.callTool({
        name: "watch_crash",
        arguments: { packageName: "com.example.fixture", durationSec: 5 },
      })).content[0].text);
      const installed = await invoke();
      const present = await invoke();
      for (const out of [installed, present]) {
        assert.equal(out.status, "ok", JSON.stringify(out));
        assert.equal(out.picoCli.source, "managed");
        assert.equal(out.picoCli.policy, "managed-latest");
        assert.equal(out.picoCli.version, "0.4.2");
        assert.equal(out.picoCli.latestVersion, "0.4.2");
        assert.equal(out.picoCli.freshness, "latest");
        assert.ok(path.isAbsolute(out.picoCli.path));
      }
      assert.equal(present.picoCli.action, "present");
      const runtime = harness.calls().filter((call) => call.role === "managed-cli" && call.args[1] === "app");
      assert.ok(runtime.length >= 2, JSON.stringify(harness.calls()));
      assert.ok(runtime.every((call) => path.isAbsolute(present.picoCli.path)));
      assert.equal(harness.calls().some((call) => call.args.includes("-g") || call.args.includes("--global")), false, JSON.stringify(harness.calls()));
    });
  });

  await t.test("exit-zero missing capture and trace artifacts are runtime failures", async () => {
    const harness = createManagedRuntimeHarness();
    await withServer(harness, "full", async (client) => {
      const missingArtifactPath = path.join(harness.root, "recording-that-fixture-does-not-create.mp4");
      const artifactFailure = JSON.parse((await client.callTool({
        name: "capture_record",
        arguments: { durationSec: 1, outputPath: missingArtifactPath },
      })).content[0].text);

      const missingTracePath = path.join(harness.root, "trace-that-fixture-does-not-create.perfetto-trace");
      const traceFailure = JSON.parse((await client.callTool({
        name: "perf_trace",
        arguments: { action: "record", durationSec: 5, outputPath: missingTracePath },
      })).content[0].text);
      const missingDecodedPath = path.join(harness.root, "decoded-trace-that-fixture-does-not-create.json");
      const decodeFailure = JSON.parse((await client.callTool({
        name: "perf_trace",
        arguments: {
          action: "decode",
          tracePath: path.join(harness.root, "fixture-input.perfetto-trace"),
          outputPath: missingDecodedPath,
        },
      })).content[0].text);

      assert.deepEqual([
        {
          status: artifactFailure.status,
          failureClass: artifactFailure.failureClass,
          artifactExists: artifactFailure.artifactExists,
          artifactBytes: artifactFailure.artifactBytes,
        },
        {
          status: traceFailure.status,
          failureClass: traceFailure.failureClass,
          artifactExists: traceFailure.artifactExists,
          artifactBytes: traceFailure.artifactBytes,
        },
        {
          status: decodeFailure.status,
          failureClass: decodeFailure.failureClass,
          artifactExists: decodeFailure.artifactExists,
          artifactBytes: decodeFailure.artifactBytes,
        },
      ], [
        { status: "failed", failureClass: "runtime", artifactExists: false, artifactBytes: null },
        { status: "failed", failureClass: "runtime", artifactExists: false, artifactBytes: null },
        { status: "failed", failureClass: "runtime", artifactExists: false, artifactBytes: null },
      ]);
      assert.ok(path.isAbsolute(artifactFailure.picoCli.path));
      assert.equal(traceFailure.picoCli.path, artifactFailure.picoCli.path);
      assert.equal(decodeFailure.picoCli.path, artifactFailure.picoCli.path);
      assert.equal(harness.calls().some((call) => call.args.includes("-g") || call.args.includes("--global")), false, JSON.stringify(harness.calls()));
    });
  });

  await t.test("exit-zero empty capture and trace artifacts are runtime failures", async () => {
    const harness = createManagedRuntimeHarness({ operationMode: "empty-artifact" });
    await withServer(harness, "full", async (client) => {
      const capturePath = path.join(harness.root, "empty-capture.mp4");
      const capture = JSON.parse((await client.callTool({
        name: "capture_record",
        arguments: { durationSec: 1, outputPath: capturePath },
      })).content[0].text);

      const tracePath = path.join(harness.root, "empty-trace.perfetto-trace");
      const trace = JSON.parse((await client.callTool({
        name: "perf_trace",
        arguments: { action: "record", durationSec: 5, outputPath: tracePath },
      })).content[0].text);
      const decodedPath = path.join(harness.root, "empty-decoded-trace.json");
      const decoded = JSON.parse((await client.callTool({
        name: "perf_trace",
        arguments: {
          action: "decode",
          tracePath: path.join(harness.root, "fixture-input.perfetto-trace"),
          outputPath: decodedPath,
        },
      })).content[0].text);

      assert.deepEqual([
        {
          status: capture.status,
          failureClass: capture.failureClass,
          artifactExists: capture.artifactExists,
          artifactBytes: capture.artifactBytes,
        },
        {
          status: trace.status,
          failureClass: trace.failureClass,
          artifactExists: trace.artifactExists,
          artifactBytes: trace.artifactBytes,
        },
        {
          status: decoded.status,
          failureClass: decoded.failureClass,
          artifactExists: decoded.artifactExists,
          artifactBytes: decoded.artifactBytes,
        },
      ], [
        { status: "failed", failureClass: "runtime", artifactExists: true, artifactBytes: 0 },
        { status: "failed", failureClass: "runtime", artifactExists: true, artifactBytes: 0 },
        { status: "failed", failureClass: "runtime", artifactExists: true, artifactBytes: 0 },
      ]);
    });
  });

  await t.test("exit-zero directory capture and trace outputs are runtime failures", async () => {
    const harness = createManagedRuntimeHarness({ operationMode: "directory-artifact" });
    await withServer(harness, "full", async (client) => {
      const capture = JSON.parse((await client.callTool({
        name: "capture_record",
        arguments: { durationSec: 1, outputPath: path.join(harness.root, "capture-directory") },
      })).content[0].text);
      const trace = JSON.parse((await client.callTool({
        name: "perf_trace",
        arguments: {
          action: "record",
          durationSec: 5,
          outputPath: path.join(harness.root, "trace-directory"),
        },
      })).content[0].text);
      const decoded = JSON.parse((await client.callTool({
        name: "perf_trace",
        arguments: {
          action: "decode",
          tracePath: path.join(harness.root, "fixture-input.perfetto-trace"),
          outputPath: path.join(harness.root, "decoded-directory"),
        },
      })).content[0].text);

      assert.deepEqual([capture, trace, decoded].map((result) => ({
        status: result.status,
        failureClass: result.failureClass,
        artifactExists: result.artifactExists,
      })), [
        { status: "failed", failureClass: "runtime", artifactExists: true },
        { status: "failed", failureClass: "runtime", artifactExists: true },
        { status: "failed", failureClass: "runtime", artifactExists: true },
      ]);
      for (const result of [capture, trace, decoded]) {
        assert.match(result.note ?? "", /not a regular file/i, JSON.stringify(result));
      }
    });
  });

  await t.test("watch_crash accepts a clean duration cap only when no runner or guard error exists", async () => {
    const healthyHarness = createManagedRuntimeHarness({ operationMode: "hang" });
    await withServer(healthyHarness, "full", async (client) => {
      const healthy = JSON.parse((await client.callTool({
        name: "watch_crash",
        arguments: { packageName: "com.example.fixture", durationSec: 5 },
      })).content[0].text);
      assert.equal(healthy.status, "ok", JSON.stringify(healthy));
      assert.match(healthy.endedBy ?? "", /^duration-cap/);
      assert.equal(Object.hasOwn(healthy, "failureClass"), false, JSON.stringify(healthy));
      assert.equal(Object.hasOwn(healthy, "error"), false, JSON.stringify(healthy));
    });
  });

  await t.test("watch_crash rejects a post-completion managed guard failure", {
    skip: process.platform === "win32"
      ? "this public fixture mutates from POSIX SIGTERM; Windows cleanup remains covered by the structural taskkill seam"
      : false,
  }, async () => {
    const driftHarness = createManagedRuntimeHarness({ operationMode: "hang-tamper" });
    await withServer(driftHarness, "full", async (client) => {
      const rejected = JSON.parse((await client.callTool({
        name: "watch_crash",
        arguments: { packageName: "com.example.fixture", durationSec: 5 },
      })).content[0].text);
      assert.equal(rejected.status, "failed", JSON.stringify(rejected));
      assert.equal(rejected.failureClass, "runtime", JSON.stringify(rejected));
      assert.match(rejected.error ?? "", /post-completion validation failed.*managed pico-cli publication identity/i);
      assert.equal(Object.hasOwn(rejected, "endedBy"), false, JSON.stringify(rejected));
    });
  });

  await t.test("managed resolution failures propagate without falling back to PATH or global npm", async () => {
    const harness = createManagedRuntimeHarness();
    harness.env.FAKE_REGISTRY_MODE = "failure";
    await withServer(harness, "full", async (client) => {
      const out = JSON.parse((await client.callTool({
        name: "watch_crash",
        arguments: { packageName: "com.example.fixture", durationSec: 5 },
      })).content[0].text);
      assert.equal(out.status, "unavailable", JSON.stringify(out));
      assert.equal(out.failureClass, "latest-unknown");
      assert.equal(Object.hasOwn(out, "picoCli"), false);
      assert.equal(harness.calls().some((call) => call.role === "managed-cli" && call.args[1] === "app"), false, JSON.stringify(harness.calls()));
      assert.equal(harness.calls().some((call) => call.args.includes("-g") || call.args.includes("--global")), false, JSON.stringify(harness.calls()));
    });
  });

  await t.test("setup-required failures keep provenance and return an absolute manual command without executing it", async () => {
    const harness = createManagedRuntimeHarness({ operationMode: "setup-required" });
    await withServer(harness, "full", async (client) => {
      const out = JSON.parse((await client.callTool({
        name: "watch_crash",
        arguments: { packageName: "com.example.fixture", durationSec: 5 },
      })).content[0].text);
      assert.equal(out.status, "failed", JSON.stringify(out));
      assert.equal(out.failureClass, "setup-required");
      assert.deepEqual(out.setupCommand, { path: out.picoCli.path, args: ["setup"] });
      assert.ok(path.isAbsolute(out.setupCommand.path));
      assert.equal(out.picoCli.version, "0.4.2");
      assert.equal(harness.calls().some((call) => call.role === "managed-cli" && call.args.slice(1).join(" ") === "setup"), false, JSON.stringify(harness.calls()));
    });
  });

  await t.test("ensure_pico_cli force-refreshes regardless of inert legacy update input", async () => {
    const harness = createManagedRuntimeHarness({ latestVersion: "0.4.1" });
    await withServer(harness, "full", async (client) => {
      const invoke = async (update) => JSON.parse((await client.callTool({ name: "ensure_pico_cli", arguments: { update } })).content[0].text);
      const first = await invoke(false);
      harness.setLatest("0.4.2");
      const second = await invoke(false);
      const third = await invoke(true);
      assert.equal(first.version, "0.4.1", JSON.stringify(first));
      assert.equal(second.version, "0.4.2", JSON.stringify(second));
      assert.equal(third.version, "0.4.2", JSON.stringify(third));
      for (const out of [first, second, third]) {
        assert.equal(out.policy, "managed-latest");
        assert.equal(out.freshness, "latest");
      }
      assert.equal(harness.calls().filter((call) => call.role === "npm" && call.args[0] === "view").length, 3, JSON.stringify(harness.calls()));
      assert.equal(harness.calls().some((call) => call.args.includes("update") && call.args.includes("--check")), false, JSON.stringify(harness.calls()));
    });
  });

  await t.test("coalescing is option-keyed and force-refresh strength aware", () => {
    const harness = createManagedRuntimeHarness();
    const moduleUrl = new URL("../dist/picocli.js", import.meta.url).href;
    const roots = ["strength", "forced", "left", "right"].map((name) => path.join(harness.root, name));
    const script = `
import { ensurePicoCli } from ${JSON.stringify(moduleUrl)};
const [strength, forced, left, right] = ${JSON.stringify(roots)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const weakPromise = ensurePicoCli({ managedRoot: strength, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 });
await wait(20);
const strongPromise = ensurePicoCli({ managedRoot: strength, forceRefresh: true, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 });
const strengthResults = await Promise.all([weakPromise, strongPromise]);
const forcedPromise = ensurePicoCli({ managedRoot: forced, forceRefresh: true, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 });
await wait(20);
const sharedWeak = ensurePicoCli({ managedRoot: forced, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 });
const sharedResults = await Promise.all([forcedPromise, sharedWeak]);
const distinctResults = await Promise.all([
  ensurePicoCli({ managedRoot: left, forceRefresh: true, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 }),
  ensurePicoCli({ managedRoot: right, forceRefresh: true, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 }),
]);
process.stdout.write(JSON.stringify({ strengthResults, sharedResults, distinctResults }));
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      env: { ...harness.env, FAKE_PICO_VIEW_DELAY_MS: "100" },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.ok([...output.strengthResults, ...output.sharedResults, ...output.distinctResults].every((entry) => entry.status === "ok"), result.stdout);
    assert.equal(harness.calls().filter((call) => call.role === "npm" && call.args[0] === "view").length, 5, JSON.stringify(harness.calls()));
    for (const root of roots) assert.equal(fs.existsSync(path.join(root, "versions", "0.4.2")), true, root);
  });
});

test.after(() => {
  restoreEnvironment();
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});
