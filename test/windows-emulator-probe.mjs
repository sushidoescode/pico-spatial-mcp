import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectWindowsEmulatorProbe,
  parseProbeArguments,
  resolveManagedProbeCli,
} from "../scripts/probe-windows-emulator.mjs";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const cliPath = "C:\\Users\\runner\\.pico-mcp\\cli\\versions\\0.5.0\\node_modules\\.bin\\pico-cli.cmd";
const identity = {
  schemaVersion: 1,
  resolvedAt: "2026-09-15T10:00:00.000Z",
  policy: "managed-latest",
  source: "managed",
  action: "installed",
  freshness: "latest",
  version: "0.5.0",
  latestVersion: "0.5.0",
  checkedAt: "2026-09-15T09:59:58.000Z",
  executablePath: cliPath,
  executableSha256: sha256("fixture shim bytes"),
  capabilities: {
    version: "0.5.0",
    executablePath: cliPath,
    packageJsonSha256: sha256("package.json"),
    executionTreeSha256: sha256("tree"),
  },
};
const env = {
  RUNNER_OS: "Windows",
  ImageOS: "windows-2025",
  RUNNER_ARCH: "X64",
  ImageVersion: "20250824.1.0",
  PICO_WINDOWS_PROBE_SHA: "abc123def456",
  GITHUB_WORKFLOW: "windows-emulator-probe",
  GITHUB_RUN_ID: "1234567890",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_JOB: "probe",
  GITHUB_REPOSITORY: "sushidoescode/pico-spatial-mcp",
  GITHUB_SERVER_URL: "https://github.com",
};
const completed = (stdout, code = 0) => ({ code, signal: null, timedOut: false, stdout, stderr: "", outputTruncated: false });

test("the probe targets only the supplied validated executable and never installs anything", async () => {
  const calls = [];
  const hashed = [];
  const results = [
    completed("pico-cli/0.5.0 (public) win32-x64 node-v22.0.0\n"),
    completed("Usage: pico-cli emulator install\n"),
    { code: 1, signal: "SIGTERM", timedOut: true, stdout: "partial status\n", stderr: "offline\n", spawnError: "timed out", outputTruncated: true },
  ];
  const report = await collectWindowsEmulatorProbe({
    env,
    platform: "win32",
    cliPath,
    identity,
    now: () => new Date("2026-09-15T10:01:00.000Z"),
    hashFile: (file) => { hashed.push(file); return identity.executableSha256; },
    runCommand: async (command, arguments_, options) => {
      calls.push({ command, arguments: arguments_, options });
      return results[calls.length - 1];
    },
  });

  assert.deepEqual(hashed, [cliPath], "integrity is checked on the exact supplied path");
  assert.deepEqual(calls, [
    { command: cliPath, arguments: ["-v"], options: { env, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 } },
    { command: cliPath, arguments: ["emulator", "install", "--source", "auto", "--yes", "--help"], options: { env, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 } },
    { command: cliPath, arguments: ["emulator", "status", "--format", "json"], options: { env, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 } },
  ]);
  assert.equal(calls.some((call) => call.command === "npm" || call.arguments.includes("-g") || call.arguments.includes("--global")), false, "no npm or global install may run");
  assert.equal(calls.every((call) => call.command === cliPath), true, "every observation targets the exact supplied executable");
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.commitSha, "abc123def456");
  assert.equal(report.observedAtUtc, "2026-09-15T10:01:00.000Z");
  assert.deepEqual(report.npm, { calls: 0, globalInstall: false });
  assert.deepEqual(report.cli, {
    targeting: "explicit-absolute-path",
    executablePath: cliPath,
    requested: identity,
    integrity: { expectedSha256: identity.executableSha256, observedSha256: identity.executableSha256, ok: true },
    versionCheck: { requested: "0.5.0", reported: "0.5.0", ok: true },
    skipped: null,
  });
  assert.deepEqual(report.runner, { os: "Windows", image: "windows-2025", architecture: "X64", osVersion: "20250824.1.0", node: process.version });
  assert.deepEqual(report.workflow, {
    name: "windows-emulator-probe",
    runId: "1234567890",
    runAttempt: "2",
    job: "probe",
    repository: "sushidoescode/pico-spatial-mcp",
    serverUrl: "https://github.com",
    runUrl: "https://github.com/sushidoescode/pico-spatial-mcp/actions/runs/1234567890/attempts/2",
  });
  assert.deepEqual(report.cliVersion, {
    command: cliPath, arguments: ["-v"], timeoutMs: 30_000, exitCode: 0, signal: null, timedOut: false,
    stdout: "pico-cli/0.5.0 (public) win32-x64 node-v22.0.0\n", stderr: "", spawnError: null, outputTruncated: false,
  });
  assert.deepEqual(report.emulatorStatus, {
    command: cliPath, arguments: ["emulator", "status", "--format", "json"], timeoutMs: 30_000, exitCode: 1, signal: "SIGTERM",
    timedOut: true, stdout: "partial status\n", stderr: "offline\n", spawnError: "timed out", outputTruncated: true,
  });
});

test("a reported version that disagrees with the requested one stops dependent observations", async () => {
  const calls = [];
  const report = await collectWindowsEmulatorProbe({
    env,
    platform: "win32",
    cliPath,
    identity,
    hashFile: () => identity.executableSha256,
    runCommand: async (command, arguments_) => {
      calls.push({ command, arguments: arguments_ });
      return completed("pico-cli/0.4.4 (public) win32-x64 node-v22.0.0\n");
    },
  });
  assert.deepEqual(calls.map((call) => call.arguments), [["-v"]]);
  assert.deepEqual(report.cli.versionCheck, { requested: "0.5.0", reported: "0.4.4", ok: false });
  assert.equal(report.cli.skipped, "version-mismatch");
  assert.equal(report.emulatorInstallHelp, null);
  assert.equal(report.emulatorStatus, null);
  assert.equal(report.cliVersion.stdout, "pico-cli/0.4.4 (public) win32-x64 node-v22.0.0\n");
});

test("a rejected version probe also stops dependent observations", async () => {
  const calls = [];
  const report = await collectWindowsEmulatorProbe({
    env,
    platform: "win32",
    cliPath,
    identity,
    hashFile: () => identity.executableSha256,
    runCommand: async (command, arguments_) => {
      calls.push({ command, arguments: arguments_ });
      throw new Error("version runner rejected");
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(report.cliVersion.spawnError, "version runner rejected");
  assert.deepEqual(report.cli.versionCheck, { requested: "0.5.0", reported: null, ok: false });
  assert.equal(report.cli.skipped, "version-mismatch");
  assert.equal(report.emulatorStatus, null);
});

test("an integrity mismatch refuses to execute the supplied path at all", async () => {
  const calls = [];
  const report = await collectWindowsEmulatorProbe({
    env,
    platform: "win32",
    cliPath,
    identity,
    hashFile: () => sha256("different bytes on disk"),
    runCommand: async (command, arguments_) => { calls.push({ command, arguments: arguments_ }); return completed("pico-cli/0.5.0\n"); },
  });
  assert.deepEqual(calls, [], "nothing may run when the executable bytes do not match the resolved identity");
  assert.deepEqual(report.cli.integrity, { expectedSha256: identity.executableSha256, observedSha256: sha256("different bytes on disk"), ok: false });
  assert.equal(report.cli.skipped, "integrity-mismatch");
  assert.equal(report.cliVersion, null);
  assert.equal(report.emulatorInstallHelp, null);
  assert.equal(report.emulatorStatus, null);
});

test("the probe rejects relative, mismatched, or ambient executable targeting", async () => {
  const runCommand = async () => completed("pico-cli/0.5.0\n");
  const hashFile = () => identity.executableSha256;
  await assert.rejects(collectWindowsEmulatorProbe({ env, platform: "win32", cliPath: "pico-cli", identity, hashFile, runCommand }), /absolute/);
  await assert.rejects(collectWindowsEmulatorProbe({ env, platform: "win32", cliPath: "C:\\other\\pico-cli.cmd", identity, hashFile, runCommand }), /identity/);
  await assert.rejects(collectWindowsEmulatorProbe({ env, platform: "win32", cliPath, identity: null, hashFile, runCommand }), /identity/);
  await assert.rejects(collectWindowsEmulatorProbe({ env, platform: "win32", cliPath, identity: { ...identity, executableSha256: "nope" }, hashFile, runCommand }), /identity/);
  await assert.rejects(collectWindowsEmulatorProbe({ env, platform: "darwin", cliPath, identity, hashFile, runCommand }), /Windows/);
});

test("resolveManagedProbeCli records the managed identity and refuses unavailable results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico windows probe "));
  try {
    const identityOut = path.join(root, "identity.json");
    const ensured = {
      status: "ok", source: "managed", policy: "managed-latest", action: "installed", path: cliPath, version: "0.5.0",
      raw: "pico-cli/0.5.0", latestVersion: "0.5.0", checkedAt: "2026-09-15T09:59:58.000Z", freshness: "latest", deprecatedAliases: [],
      capabilities: { schemaVersion: 1, identity: identity.capabilities, checkedAt: "2026-09-15T09:59:59.000Z", operations: [], coverage: "complete", reportPath: "C:\\report.json" },
    };
    const ensureCalls = [];
    const written = await resolveManagedProbeCli({
      ensure: async (options) => { ensureCalls.push(options); return ensured; },
      hashFile: (file) => { assert.equal(file, cliPath); return identity.executableSha256; },
      identityOut,
      now: () => new Date("2026-09-15T10:00:00.000Z"),
    });
    assert.deepEqual(ensureCalls, [{ forceRefresh: true }], "the probe resolves through the force-refresh managed boundary");
    assert.deepEqual(written, identity);
    assert.deepEqual(JSON.parse(fs.readFileSync(identityOut, "utf8")), identity);
    await assert.rejects(resolveManagedProbeCli({ ensure: async () => ensured, hashFile: () => identity.executableSha256, identityOut }), /EEXIST|exists/);

    const unavailableOut = path.join(root, "unavailable.json");
    await assert.rejects(resolveManagedProbeCli({
      ensure: async () => ({ status: "unavailable", failureClass: "latest-unknown", note: "registry unreachable", source: "managed", policy: "managed-latest", action: "skipped", path: null, version: null, raw: "", latestVersion: null, checkedAt: null, freshness: null, deprecatedAliases: [] }),
      hashFile: () => { throw new Error("must not hash"); },
      identityOut: unavailableOut,
    }), /latest-unknown.*registry unreachable/);
    assert.equal(fs.existsSync(unavailableOut), false);

    const externalOut = path.join(root, "external.json");
    await assert.rejects(resolveManagedProbeCli({
      ensure: async () => ({ ...ensured, source: "external", policy: "external", action: "external" }),
      hashFile: () => identity.executableSha256,
      identityOut: externalOut,
    }), /managed/);
    assert.equal(fs.existsSync(externalOut), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseProbeArguments distinguishes resolve and probe modes and rejects anything else", () => {
  assert.deepEqual(parseProbeArguments(["resolve", "--identity-out", "C:\\temp\\identity.json"]), { mode: "resolve", identityOut: "C:\\temp\\identity.json" });
  assert.deepEqual(parseProbeArguments(["probe", "--cli", cliPath, "--identity", "C:\\temp\\identity.json"]), { mode: "probe", cliPath, identityPath: "C:\\temp\\identity.json" });
  for (const argv of [[], ["resolve"], ["probe", "--cli", cliPath], ["probe", "--identity", "x"], ["install"], ["probe", "--cli", cliPath, "--identity", "x", "--extra"]]) {
    assert.throws(() => parseProbeArguments(argv), /usage/i, JSON.stringify(argv));
  }
});
