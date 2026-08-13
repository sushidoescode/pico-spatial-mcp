import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import * as fixture from "./helpers/buildrun-smoke-fixture.mjs";
import {
  analyzePackageRuntimeLogs,
  launchResultSucceeded,
  parseAssembleTask,
  resolveAssembledApk,
} from "../dist/workflow.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows smoke-fixture contract selects cmd/bat wrappers without claiming build_and_run execution", () => {
  const root = path.join(os.tmpdir(), "pico buildrun fixture");
  const plan = fixture.buildRunSmokeFixturePlan({ root, platform: "win32" });
  assert.equal(plan.adbPath, path.join(root, "bin", "adb.cmd"));
  assert.equal(plan.gradlePath, path.join(root, "project", "gradlew.bat"));
  assert.equal(plan.executesMcpSuccessPath, false);
  assert.match(plan.scope, /wrapper-selection-only/i);
  assert.match(plan.scope, /no native build_and_run execution/i);
});

test("POSIX smoke-fixture contract retains the executable build_and_run success path", () => {
  const root = path.join(os.tmpdir(), "pico-buildrun-fixture");
  for (const platform of ["darwin", "linux"]) {
    const plan = fixture.buildRunSmokeFixturePlan({ root, platform });
    assert.equal(plan.adbPath, path.join(root, "bin", "adb"));
    assert.equal(plan.gradlePath, path.join(root, "project", "gradlew"));
    assert.equal(plan.executesMcpSuccessPath, true);
  }
});

test("Windows fixture materializes quoted adb.cmd and gradlew.bat launchers", () => {
  assert.equal(typeof fixture.materializeBuildRunSmokeFixture, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico buildrun wrappers "));
  try {
    const plan = fixture.materializeBuildRunSmokeFixture({
      root,
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      pngBase64: "fixture-png",
    });
    assert.equal(fs.existsSync(plan.adbPath), true);
    assert.equal(fs.existsSync(plan.gradlePath), true);
    assert.match(fs.readFileSync(plan.adbPath, "utf8"), /^@echo off\r?$/m);
    assert.match(fs.readFileSync(plan.adbPath, "utf8"), /"C:\\Program Files\\nodejs\\node\.exe"/);
    assert.match(fs.readFileSync(plan.gradlePath, "utf8"), /"C:\\Program Files\\nodejs\\node\.exe"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the native Windows CI lane owns the tracked wrapper-selection contract", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts["test:picocli-win"], /test\/buildrun-smoke-fixture\.mjs/);
  assert.match(pkg.scripts["test:picocli-win"], /test\/run-battery\.mjs/, "native Windows must exercise the battery CLI boundary too");
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "gates.yml"), "utf8");
  const windowsJob = workflow.match(/^  picocli-windows:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\n)/m)?.[1] ?? "";
  assert.match(windowsJob, /npm run test:picocli-win/);
  assert.match(windowsJob, /no native build_and_run execution/i);
});

test("assemble task parsing binds one module and variant", () => {
  assert.deepEqual(parseAssembleTask("assembleDebug"), { modulePath: "app", variantName: "debug" });
  assert.deepEqual(parseAssembleTask(":demo:phone:assembleRelease"), {
    modulePath: path.join("demo", "phone"),
    variantName: "release",
  });
  for (const unsafe of ["help", "build", "clean assembleDebug", ":demo:test", "assembledebug"])
    assert.equal(parseAssembleTask(unsafe), null, unsafe);
});

test("APK resolution trusts only requested AGP metadata and package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-apk-resolution-"));
  try {
    const requested = path.join(root, "app", "build", "outputs", "apk", "debug");
    const unrelated = path.join(root, "other", "build", "outputs", "apk", "debug");
    fs.mkdirSync(requested, { recursive: true });
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(requested, "app-debug.apk"), "requested apk");
    fs.writeFileSync(path.join(unrelated, "newer.apk"), "unrelated and newer");
    fs.writeFileSync(path.join(requested, "output-metadata.json"), JSON.stringify({
      variantName: "debug",
      applicationId: "com.example.fixture",
      elements: [{ outputFile: "app-debug.apk" }],
    }));
    fs.writeFileSync(path.join(unrelated, "output-metadata.json"), JSON.stringify({
      variantName: "debug",
      applicationId: "com.example.other",
      elements: [{ outputFile: "newer.apk" }],
    }));

    const resolved = resolveAssembledApk(root, "assembleDebug", "com.example.fixture");
    assert.equal(resolved.apk, path.join(requested, "app-debug.apk"));
    assert.match(resolved.metadataPath ?? "", /output-metadata\.json$/);
    assert.match(resolveAssembledApk(root, "assembleDebug", "com.example.wrong").reason ?? "", /no AGP output metadata/i);
    assert.match(resolveAssembledApk(root, "help", "com.example.fixture").reason ?? "", /not a scoped Android assemble task/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launch success requires exit zero and a positive am/monkey signal", () => {
  const result = (code, stdout, stderr = "") => ({ code, stdout, stderr, timedOut: false });
  assert.equal(launchResultSucceeded(result(0, "Events injected: 1\n"), undefined), true);
  assert.equal(launchResultSucceeded(result(0, "Starting: Intent {...}\n"), ".MainActivity"), true);
  assert.equal(launchResultSucceeded(result(1, "", "device offline"), undefined), false);
  assert.equal(launchResultSucceeded(result(0, "", ""), undefined), false);
});

test("runtime analysis scopes render markers to the app PID and correlates multiline crashes", () => {
  const clean = analyzePackageRuntimeLogs(
    "08-13 I SpatialView: RenderEntity create texture success\n",
    "08-13 I OtherApp: FirstFrameRelease(Displayed)\n",
    "com.example.fixture",
  );
  assert.equal(clean.rendered, true);
  assert.deepEqual(clean.crashes, []);

  const unrelated = analyzePackageRuntimeLogs(
    "",
    "08-13 E AndroidRuntime: FATAL EXCEPTION: main\n08-13 E AndroidRuntime: Process: com.example.other, PID: 9\n",
    "com.example.fixture",
  );
  assert.equal(unrelated.rendered, false);
  assert.deepEqual(unrelated.crashes, []);

  const crashed = analyzePackageRuntimeLogs(
    "",
    "08-13 E AndroidRuntime: FATAL EXCEPTION: main\n08-13 E AndroidRuntime: Process: com.example.fixture, PID: 42\n08-13 E AndroidRuntime: java.lang.IllegalStateException\n",
    "com.example.fixture",
  );
  assert.match(crashed.crashes.join("\n"), /FATAL EXCEPTION/);
  assert.match(crashed.crashes.join("\n"), /Process: com\.example\.fixture/);
});

test("public build_and_run contract is explicitly POSIX-only", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src", "workflow.ts"), "utf8");
  assert.match(source, /build_and_run currently supports POSIX hosts only/i);
  assert.match(source, /native Windows execution remains unmeasured/i);
});

test("POSIX MCP path rejects failed launch and never reports installed/running success", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-buildrun-launch-fail-"));
  const pngBase64 = fs.readFileSync(path.join(repoRoot, "golden", "showcase-6cards.golden.png")).toString("base64");
  const plan = fixture.materializeBuildRunSmokeFixture({ root, pngBase64, scenario: "launch-failure" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    env: {
      ...process.env,
      PATH: `${plan.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PICO_HOME: path.join(root, "empty-pico-home"),
      PICO_MCP_SURFACE: "full",
    },
  });
  const client = new Client({ name: "buildrun-launch-negative", version: "0.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "build_and_run",
      arguments: { projectDir: plan.projectDir, packageName: "com.example.contractfixture", serial: "fixture-serial", settleSec: 0 },
    });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /launch failed|device offline/i);
    assert.equal(result.structuredContent?.launched, undefined);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX MCP path rejects an acknowledged launch with no live package PID", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-buildrun-dead-pid-"));
  const pngBase64 = fs.readFileSync(path.join(repoRoot, "golden", "showcase-6cards.golden.png")).toString("base64");
  const plan = fixture.materializeBuildRunSmokeFixture({ root, pngBase64, scenario: "dead-process" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    env: {
      ...process.env,
      PATH: `${plan.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PICO_HOME: path.join(root, "empty-pico-home"),
      PICO_MCP_SURFACE: "full",
    },
  });
  const client = new Client({ name: "buildrun-dead-pid-negative", version: "0.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "build_and_run",
      arguments: { projectDir: plan.projectDir, packageName: "com.example.contractfixture", serial: "fixture-serial", settleSec: 0 },
    });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /no live PID/i);
    assert.equal(result.structuredContent?.health, undefined);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
