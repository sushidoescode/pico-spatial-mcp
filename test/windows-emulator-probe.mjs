import assert from "node:assert/strict";
import test from "node:test";

import { collectWindowsEmulatorProbe } from "../scripts/probe-windows-emulator.mjs";

test("collectWindowsEmulatorProbe records the bounded Windows install-channel contract", async () => {
  const calls = [];
  const env = {
    RUNNER_OS: "Windows",
    ImageOS: "windows-2025",
    RUNNER_ARCH: "X64",
    ImageVersion: "20250824.1.0",
    PICO_WINDOWS_PROBE_SHA: "abc123def456",
  };
  const results = [
    { code: 0, signal: null, timedOut: false, stdout: '"0.4.2"\n', stderr: "", outputTruncated: false },
    { code: 0, signal: null, timedOut: false, stdout: "added 1 package\n", stderr: "", outputTruncated: false },
    { code: 0, signal: null, timedOut: false, stdout: "pico-cli/0.4.2\n", stderr: "", outputTruncated: false },
    { code: 0, signal: null, timedOut: false, stdout: "Usage: pico-cli emulator install\n", stderr: "", outputTruncated: false },
    { code: 1, signal: "SIGTERM", timedOut: true, stdout: "partial status\n", stderr: "offline\n", spawnError: "timed out", outputTruncated: true },
  ];

  const report = await collectWindowsEmulatorProbe({
    env,
    platform: "win32",
    now: () => new Date("2026-08-12T17:20:30.000Z"),
    resolveCli: (receivedEnv, receivedPlatform) => {
      assert.equal(receivedEnv, env);
      assert.equal(receivedPlatform, "win32");
      return "C:\\npm\\pico-cli.CMD";
    },
    runCommand: async (command, arguments_, options) => {
      calls.push({ command, arguments: arguments_, options });
      return results[calls.length - 1];
    },
  });

  assert.deepEqual(calls, [
    {
      command: "npm",
      arguments: ["view", "@picoxr/pico-cli", "version", "--json"],
      options: { env, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
    },
    {
      command: "npm",
      arguments: ["install", "-g", "@picoxr/pico-cli"],
      options: { env, timeoutMs: 120_000, maxOutputBytes: 64 * 1024 },
    },
    {
      command: "C:\\npm\\pico-cli.CMD",
      arguments: ["-v"],
      options: { env, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
    },
    {
      command: "C:\\npm\\pico-cli.CMD",
      arguments: ["emulator", "install", "--help"],
      options: { env, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
    },
    {
      command: "C:\\npm\\pico-cli.CMD",
      arguments: ["emulator", "status", "--format", "json"],
      options: { env, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
    },
  ]);
  assert.deepEqual(report.runner, {
    os: "Windows",
    image: "windows-2025",
    architecture: "X64",
    osVersion: "20250824.1.0",
    node: process.version,
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.commitSha, "abc123def456");
  assert.equal(report.observedAtUtc, "2026-08-12T17:20:30.000Z");
  assert.deepEqual(report.emulatorStatus, {
    command: "C:\\npm\\pico-cli.CMD",
    arguments: ["emulator", "status", "--format", "json"],
    exitCode: 1,
    signal: "SIGTERM",
    timedOut: true,
    stdout: "partial status\n",
    stderr: "offline\n",
    spawnError: "timed out",
    outputTruncated: true,
  });
});

test("collectWindowsEmulatorProbe rejects non-Windows platforms", async () => {
  await assert.rejects(
    collectWindowsEmulatorProbe({ platform: "darwin" }),
    /Windows/,
  );
});
