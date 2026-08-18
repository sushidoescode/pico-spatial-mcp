import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFleetReceiptStage } from "../dist/fleetbuild.js";
import {
  authoredSpec,
  effectiveSpec,
  makePng,
  sha256,
} from "./helpers/runreceipt-fixture.mjs";

const PACKAGE = "com.fleet.adapter";
const COMPONENT = `${PACKAGE}/.platform.LaunchActivity`;
const PID = 4242;
const PID_START_TICKS = "987654";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";

const textResult = (stdout = "", overrides = {}) => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  ...overrides,
});

const writeFile = (root, relativePath, contents) => {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
};

const procStat = () => `${PID} (Fleet adapter) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${PID_START_TICKS} 20\n`;
const foreground = () => `topResumedActivity=ActivityRecord{1a2b3c u0 ${COMPONENT} t42}\n`;

async function createFleetStageFixture(t, { failAfterInstall = false } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-fleet-stage-"));
  const projectDir = path.join(scratch, "project");
  const captureDir = path.join(scratch, "captures");
  const receiptRoot = path.join(scratch, "receipts");
  const ledgerRoot = path.join(scratch, "ledger");
  const briefPath = path.join(scratch, "brief.json");
  const previousReceiptRoot = process.env.PICO_MCP_RUN_RECEIPT_DIR;
  const previousLedgerRoot = process.env.PICO_MCP_LEDGER_DIR;
  process.env.PICO_MCP_RUN_RECEIPT_DIR = receiptRoot;
  process.env.PICO_MCP_LEDGER_DIR = ledgerRoot;
  t.after(() => {
    if (previousReceiptRoot === undefined) delete process.env.PICO_MCP_RUN_RECEIPT_DIR;
    else process.env.PICO_MCP_RUN_RECEIPT_DIR = previousReceiptRoot;
    if (previousLedgerRoot === undefined) delete process.env.PICO_MCP_LEDGER_DIR;
    else process.env.PICO_MCP_LEDGER_DIR = previousLedgerRoot;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  writeFile(projectDir, "settings.gradle.kts", "rootProject.name = \"fleet-adapter\"\n");
  writeFile(projectDir, "build.gradle.kts", "plugins {}\n");
  writeFile(projectDir, "gradlew", "#!/bin/sh\n");
  writeFile(projectDir, "app/build.gradle.kts", `android { namespace = "${PACKAGE}" }\n`);
  writeFile(projectDir, "app/src/main/AndroidManifest.xml", `<manifest package="${PACKAGE}" />\n`);
  writeFile(projectDir, "app/src/main/java/com/fleet/adapter/MainActivity.kt", `package ${PACKAGE}\nclass MainActivity\n`);
  fs.writeFileSync(briefPath, JSON.stringify({ brief: "fleet adapter", spec: authoredSpec(PACKAGE) }));

  const apkBytes = Buffer.from("PK\u0003\u0004fleet-adapter-apk", "utf8");
  const apkSha256 = sha256(apkBytes);
  writeFile(projectDir, "app/build/outputs/apk/debug/app-debug.apk", apkBytes);
  writeFile(projectDir, "app/build/outputs/apk/debug/output-metadata.json", `${JSON.stringify({
    version: 3,
    applicationId: PACKAGE,
    variantName: "debug",
    elements: [{ type: "SINGLE", outputFile: "app-debug.apk" }],
  })}\n`);

  const captureBytes = makePng(61);
  const captureSha256 = sha256(captureBytes);
  const expectedApkCasPath = path.join(receiptRoot, "artifacts", "apk", `${apkSha256}.apk`);
  const expectedCapturePath = path.join(ledgerRoot, "artifacts", `${captureSha256}.png`);
  const expectedSourceCapturePath = path.join(captureDir, `${SESSION_ID}.png`);
  const remoteApkPath = `/data/app/~~adapter/${PACKAGE}/base.apk`;
  const events = [];

  const runText = async (command, args) => {
    events.push({ command, args: [...args] });
    if (command === fs.realpathSync(path.join(projectDir, "gradlew"))) return textResult("BUILD SUCCESSFUL\n");
    assert.equal(command, "/fixture/adb");
    const key = args.slice(2).join(" ");
    if (key === `install -r ${expectedApkCasPath}`) return textResult("Success\n");
    if (key === `shell pm path ${PACKAGE}`) return textResult(`package:${remoteApkPath}\n`);
    if (key === `shell toybox sha256sum ${remoteApkPath}`) return textResult(`${apkSha256}  ${remoteApkPath}\n`);
    if (key === "shell getprop ro.product.model") return textResult("PICO Emulator\n");
    if (key === "shell getprop ro.build.fingerprint") return textResult("PICO/emulator/fixture:14/test-keys\n");
    if (key === "shell getprop ro.boot.qemu") return textResult("1\n");
    if (key === "shell cat /proc/sys/kernel/random/boot_id") return textResult("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n");
    if (key === "shell pm list packages com.fleet") return textResult("");
    if (key === `shell am start -n ${COMPONENT}`) return textResult(`Starting: Intent { cmp=${COMPONENT} }\n`);
    if (key === `shell pidof ${PACKAGE}`) return textResult(`${PID}\n`);
    if (key === `shell cat /proc/${PID}/stat`) return textResult(procStat());
    if (key === "shell dumpsys activity activities") return textResult(foreground());
    throw new Error(`unexpected injected command: ${key}`);
  };

  const visualJudgeCalls = [];
  return {
    input: {
      nativeRun: {
        briefPath,
        effectiveSpec: effectiveSpec(PACKAGE),
        projectDir,
        packageName: PACKAGE,
        task: ":app:assembleDebug",
        serial: "emulator-5554",
        component: COMPONENT,
        captureDir,
        settleMs: 25,
        ...(failAfterInstall ? { afterInstall: async () => ({ status: "failed", reason: "fixture splat delivery failed" }) } : {}),
      },
      visualJudgeInput: {
        claim: "one exact fleet frame",
        expect: { minObjects: 1, notMostlyBlack: true },
        app: PACKAGE,
        record: true,
        cClass: "C0_emulator",
      },
    },
    deps: {
      nativeRun: {
        runText,
        runBinary: async (command, args) => {
          events.push({ command, args: [...args], binary: true });
          assert.equal(command, "/fixture/adb");
          assert.deepEqual(args, ["-s", "emulator-5554", "exec-out", "screencap", "-p"]);
          return { code: 0, stdout: captureBytes, stderr: "", timedOut: false };
        },
        adbPath: "/fixture/adb",
        gradleEnv: { JAVA_HOME: "/fixture/jbr" },
        now: () => new Date("2026-08-14T12:00:00.000Z"),
        randomUUID: () => SESSION_ID,
        sleep: async () => {},
        inspectApk: async () => ({
          manifestInspection: { status: "inspected", tool: "aapt2", packageName: PACKAGE, versionCode: "1", versionName: "1.0" },
          signingInspection: { status: "inspected", tool: "apksigner", certificateSha256: [sha256("fixture-certificate")] },
        }),
      },
      visualJudge: async (input) => {
        visualJudgeCalls.push(input);
        return {
          verdict: "PASS",
          confidence: 0.91,
          checks: [{ name: "objectCount", score: 1 }],
          note: "fixture measurement",
          ledger: { status: "recorded" },
        };
      },
    },
    events,
    visualJudgeCalls,
    expectedCapturePath,
    expectedSourceCapturePath,
  };
}

test("fleet stage judges only the receipt-bound unique capture", async (t) => {
  const fixture = await createFleetStageFixture(t);
  const result = await runFleetReceiptStage(fixture.input, fixture.deps);

  assert.equal(result.receipt.evidenceType, "structural");
  assert.equal(result.receipt.lookRequired, true);
  assert.equal(result.artifact, result.receipt.capturePath);
  assert.notEqual(path.basename(result.artifact), "forward.png");
  assert.equal(result.visualJudgeArtifact, result.receipt.capturePath);
  assert.equal(fixture.visualJudgeCalls.length, 1);
  assert.equal(fixture.visualJudgeCalls[0].imagePath, fixture.expectedCapturePath);
  assert.equal(result.receipt.sourceCapturePath, fs.realpathSync(fixture.expectedSourceCapturePath));
  assert.equal(result.concluded, true);
});

test("a failed receipt stage cannot be reported as a concluded fleet run", async (t) => {
  const fixture = await createFleetStageFixture(t, { failAfterInstall: true });
  const result = await runFleetReceiptStage(fixture.input, fixture.deps);

  assert.equal(result.receipt, null);
  assert.equal(result.concluded, false);
  assert.equal(result.verdict, null);
  assert.equal(result.nativeFailure.stage, "after-install");
  assert.equal(fixture.visualJudgeCalls.length, 0);
});

test("a visual judge failure preserves the recorded structural receipt without concluding", async (t) => {
  const fixture = await createFleetStageFixture(t);
  fixture.deps.visualJudge = async () => { throw new Error("fixture eye unavailable"); };
  const result = await runFleetReceiptStage(fixture.input, fixture.deps);

  assert.equal(result.receipt.status, "recorded");
  assert.equal(result.receipt.evidenceType, "structural");
  assert.equal(result.artifact, result.receipt.capturePath);
  assert.equal(result.visualJudgeArtifact, result.receipt.capturePath);
  assert.equal(result.verdict, null);
  assert.equal(result.concluded, false);
  assert.match(result.visualJudgeNote, /fixture eye unavailable/);
});
