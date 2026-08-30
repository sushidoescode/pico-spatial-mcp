import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseForegroundActivity,
  parseInstalledApkPath,
  parsePid,
  parseProcStartTicks,
  parseRemoteSha256,
  produceNativeFleetReceipt,
} from "../dist/nativefleetreceipt.js";
import { readNativeRunReceipt } from "../dist/runreceiptstore.js";
import {
  authoredSpec,
  effectiveSpec,
  effectiveSpecWithStoredBytes,
  makePng,
  sha256,
} from "./helpers/runreceipt-fixture.mjs";

const PACKAGE = "com.fleet.receipt";
const COMPONENT = `${PACKAGE}/.platform.LaunchActivity`;
const SPATIAL_SHELL_COMPONENT = "com.pxr.scenarioprovider/com.unity3d.player.UnityPlayerActivity";
const PID = 4242;
const PID_START_TICKS = "987654";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const EXPECTED_EFFECTIVE_SPEC_MAX_BYTES = 2 * 1024 * 1024;

const textResult = (stdout = "", overrides = {}) => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  ...overrides,
});

const binaryResult = (stdout, overrides = {}) => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  ...overrides,
});

function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function installFakeWatch() {
  const originalWatch = fs.watch;
  const watchers = [];
  fs.watch = function (directory, options, listener) {
    const callback = typeof options === "function" ? options : listener;
    const watcher = new EventEmitter();
    watcher.directory = path.resolve(directory);
    watcher.closed = false;
    watcher.callback = (...args) => {
      if (!watcher.closed) callback(...args);
    };
    watcher.closeCalls = 0;
    watcher.close = () => {
      watcher.closeCalls += 1;
      watcher.closed = true;
    };
    watchers.push(watcher);
    return watcher;
  };
  return { watchers, restore: () => { fs.watch = originalWatch; } };
}

async function produceWithClassifiedWatchEvents(fixture, events) {
  const fake = installFakeWatch();
  const originalRunText = fixture.deps.runText;
  fixture.deps.runText = async (...args) => {
    const result = await originalRunText(...args);
    if (args[0].endsWith("/gradlew")) {
      for (const [relativeDirectory, filename] of events) {
        const watchedDirectory = fs.realpathSync(path.join(fixture.projectDir, relativeDirectory));
        const watcher = fake.watchers.find((candidate) => candidate.directory === watchedDirectory);
        assert.ok(watcher, `${relativeDirectory || "project root"} must be watched before Gradle starts`);
        watcher.callback("rename", filename);
      }
    }
    return result;
  };
  try {
    return { out: await produceNativeFleetReceipt(fixture.input, fixture.deps), watchers: fake.watchers };
  } finally {
    fake.restore();
  }
}

function procStat(pid = PID, startTicks = PID_START_TICKS) {
  return `${pid} (Receipt worker (stage)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${startTicks} 20 21 22\n`;
}

function foregroundOutput(component = COMPONENT) {
  return `Display #0:\n  topResumedActivity=ActivityRecord{1a2b3c u0 ${component} t42}\n`;
}

function os6ForegroundOutput({
  includeTarget = true,
  additionalComponents = [],
  includeSpatialShell = true,
} = {}) {
  const targetLines = includeTarget
    ? [
      `  ResumedActivity: ActivityRecord{107623938 u0 ${COMPONENT} t42}`,
      `  topResumedActivity=ActivityRecord{107623938 u0 ${COMPONENT} t42}`,
    ]
    : [];
  const additionalLines = additionalComponents.map((component, index) =>
    `  topResumedActivity=ActivityRecord{${107623939 + index} u0 ${component} t${43 + index}}`);
  const shellLines = includeSpatialShell
    ? [`  topResumedActivity=ActivityRecord{84026429 u0 ${SPATIAL_SHELL_COMPONENT} t8}`]
    : [];
  return `ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\n${[
    ...targetLines,
    ...additionalLines,
    ...shellLines,
  ].join("\n")}\n`;
}

function receiptFiles(rootDir, packageName = PACKAGE) {
  const directory = path.join(rootDir, "native-v1", packageName);
  try {
    return fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}

async function createProducerFixture(t, mutation = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-native-receipt-"));
  const projectDir = path.join(scratch, "project");
  const captureDir = path.join(scratch, "captures");
  const receiptRoot = path.join(scratch, "receipt-store");
  const ledgerRoot = path.join(scratch, "ledger-store");
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

  writeFile(projectDir, "settings.gradle.kts", "rootProject.name = \"native-receipt\"\n");
  writeFile(projectDir, "build.gradle.kts", "plugins {}\n");
  writeFile(projectDir, "gradlew", "#!/bin/sh\n");
  writeFile(projectDir, "app/build.gradle.kts", `android { namespace = \"${PACKAGE}\" }\n`);
  writeFile(projectDir, "app/src/main/AndroidManifest.xml", `<manifest package=\"${PACKAGE}\" />\n`);
  writeFile(projectDir, "app/src/main/java/com/fleet/receipt/MainActivity.kt", `package ${PACKAGE}\nclass MainActivity\n`);
  if (["gradle-excluded-buildsrc-outputs", "gradle-excluded-plus-selected"].includes(mutation.kind)) {
    writeFile(projectDir, "buildSrc/src/main/kotlin/ReceiptPlugin.kt", "class ReceiptPlugin\n");
  }
  if (mutation.kind === "gradle-buildsrc-doc-file-directory-restored") {
    writeFile(projectDir, "buildSrc/README.md", "build logic documentation\n");
  }
  fs.writeFileSync(briefPath, JSON.stringify({ brief: "native receipt", spec: authoredSpec(PACKAGE) }));

  const apkBytes = Buffer.from("PK\u0003\u0004native-fleet-receipt-apk", "utf8");
  const apkSha256 = sha256(apkBytes);
  const sourceApkPath = writeFile(projectDir, "app/build/outputs/apk/debug/app-debug.apk", apkBytes);
  const metadata = {
    version: 3,
    applicationId: PACKAGE,
    variantName: "debug",
    elements: [{ type: "SINGLE", outputFile: "app-debug.apk" }],
  };
  const metadataPath = writeFile(
    projectDir,
    "app/build/outputs/apk/debug/output-metadata.json",
    `${JSON.stringify(metadata)}\n`,
  );
  if (mutation.kind === "missing-metadata") fs.rmSync(metadataPath);
  if (mutation.kind === "ambiguous-metadata") {
    writeFile(projectDir, "app/build/outputs/apk/second/app-debug.apk", apkBytes);
    writeFile(
      projectDir,
      "app/build/outputs/apk/second/output-metadata.json",
      `${JSON.stringify(metadata)}\n`,
    );
  }

  const captureBytes = mutation.kind === "invalid-png"
    ? Buffer.from("not a PNG")
    : makePng(51);
  const captureSha256 = sha256(captureBytes);
  const expectedApkCasPath = path.join(receiptRoot, "artifacts", "apk", `${apkSha256}.apk`);
  const expectedCaptureCasPath = path.join(ledgerRoot, "artifacts", `${captureSha256}.png`);
  const expectedCaptureSourcePath = path.join(captureDir, `${SESSION_ID}.png`);
  const remoteApkPath = `/data/app/~~receipt/${PACKAGE}/base.apk`;
  const replacementRemoteApkPath = `/data/app/~~replacement/${PACKAGE}/base.apk`;

  if (mutation.kind === "apk-cas-corruption") {
    fs.mkdirSync(path.dirname(expectedApkCasPath), { recursive: true });
    fs.writeFileSync(expectedApkCasPath, Buffer.from("corrupt APK CAS"));
  }
  if (mutation.kind === "capture-cas-corruption") {
    fs.mkdirSync(path.dirname(expectedCaptureCasPath), { recursive: true });
    fs.writeFileSync(expectedCaptureCasPath, makePng(99));
  }
  if (mutation.kind === "receipt-publication") {
    fs.mkdirSync(receiptRoot, { recursive: true });
    fs.writeFileSync(path.join(receiptRoot, "native-v1"), "blocks receipt directory");
  }

  const events = [];
  const sleeps = [];
  let pidCalls = 0;
  let statCalls = 0;
  let foregroundCalls = 0;
  let launchCalls = 0;
  let pmPathCalls = 0;
  let remoteDigestCalls = 0;
  let bootIdCalls = 0;
  let gradleCalls = 0;
  let clock = Date.parse("2026-08-14T11:59:00.000Z");
  let monotonicMs = 0;
  const projectRealDir = fs.realpathSync(projectDir);
  const selectedSourcePath = path.join(projectRealDir, "app/src/main/java/com/fleet/receipt/MainActivity.kt");

  const runText = async (command, args, options = {}) => {
    events.push({ type: "text", command, args: [...args], options: { ...options } });
    if (command === path.join(projectRealDir, "gradlew")) {
      gradleCalls += 1;
      if (mutation.kind === "build-nonzero") {
        const stdout = Array.from({ length: 100 }, (_, index) => `gradle-line-${index + 1}`).join("\n");
        return textResult(stdout, { code: 1, stderr: "gradle failed\n" });
      }
      if (mutation.kind === "build-timeout") return textResult("build stalled\n", { code: null, timedOut: true });
      if (mutation.kind === "gradle-selected-content-persistent") {
        fs.appendFileSync(selectedSourcePath, "// persistent build-interval mutation\n");
      }
      if (mutation.kind === "gradle-selected-content-restored") {
        const original = fs.readFileSync(selectedSourcePath);
        fs.writeFileSync(selectedSourcePath, Buffer.from("changed during Gradle"));
        fs.writeFileSync(selectedSourcePath, original);
      }
      if (mutation.kind === "gradle-selected-member-persistent") {
        writeFile(projectRealDir, "app/src/main/java/com/fleet/receipt/AddedDuringGradle.kt", `package ${PACKAGE}\nclass AddedDuringGradle\n`);
      }
      if (mutation.kind === "gradle-selected-member-restored") {
        const transient = writeFile(projectRealDir, "app/src/main/java/com/fleet/receipt/TransientDuringGradle.kt", `package ${PACKAGE}\nclass TransientDuringGradle\n`);
        fs.unlinkSync(transient);
      }
      if (mutation.kind === "gradle-root-atomic-restored") {
        const selected = path.join(projectRealDir, "settings.gradle.kts");
        const held = path.join(projectRealDir, "settings.gradle.kts.held");
        const replacement = writeFile(projectRealDir, "settings.gradle.kts.replacement", "rootProject.name = \"replacement\"\n");
        fs.renameSync(selected, held);
        fs.renameSync(replacement, selected);
        fs.unlinkSync(selected);
        fs.renameSync(held, selected);
      }
      if (mutation.kind === "gradle-absent-root-restored") {
        const transientRoot = path.join(projectRealDir, "app/libs");
        writeFile(projectRealDir, "app/libs/transient.jar", "transient selected member");
        fs.rmSync(transientRoot, { recursive: true });
      }
      if (mutation.kind === "gradle-excluded-output-mutations") {
        writeFile(projectRealDir, "app/build/intermediates/fixture/output.bin", "excluded build output");
        writeFile(projectRealDir, ".gradle/fixture/cache.bin", "excluded Gradle cache");
        writeFile(projectRealDir, "README.md", "excluded documentation");
      }
      if (mutation.kind === "gradle-excluded-plus-dropped-selected-first" && gradleCalls === 1) {
        writeFile(projectRealDir, ".gradle/fixture/cache.bin", "persistent excluded Gradle cache");
        const transientRoot = path.join(projectRealDir, "libs");
        writeFile(projectRealDir, "libs/Transient.jar", "transient selected member");
        fs.rmSync(transientRoot, { recursive: true });
      }
      if (["gradle-excluded-buildsrc-outputs", "gradle-excluded-plus-selected"].includes(mutation.kind)) {
        writeFile(projectRealDir, "buildSrc/build/classes/kotlin/main/ReceiptPlugin.class", "excluded buildSrc output");
        writeFile(projectRealDir, "buildSrc/.gradle/cache.bin", "excluded nested Gradle cache");
      }
      if (mutation.kind === "gradle-excluded-plus-selected") {
        const transient = writeFile(projectRealDir, "buildSrc/Transient.kt", "class Transient\n");
        fs.unlinkSync(transient);
      }
      if (mutation.kind === "gradle-buildsrc-doc-file-directory-restored") {
        const documentation = path.join(projectRealDir, "buildSrc/README.md");
        const held = path.join(projectRealDir, "buildSrc/README.md.held");
        fs.renameSync(documentation, held);
        writeFile(projectRealDir, "buildSrc/README.md/Plugin.kt", "class TransientPlugin\n");
        fs.rmSync(documentation, { recursive: true });
        fs.renameSync(held, documentation);
      }
      return textResult("BUILD SUCCESSFUL\n");
    }

    assert.equal(command, "/fixture/adb", `unexpected external command ${command}`);
    assert.deepEqual(args.slice(0, 2), ["-s", "emulator-5554"]);
    const adbArgs = args.slice(2);
    const key = adbArgs.join(" ");
    if (key === `install -r ${expectedApkCasPath}`) {
      if (mutation.kind === "install-nonzero") return textResult("Failure [INSTALL_FAILED]\n", { code: 1 });
      if (mutation.kind === "install-no-success") return textResult("Package replaced\n");
      return textResult("Success\n");
    }
    if (key === `shell pm path ${PACKAGE}`) {
      pmPathCalls += 1;
      if (mutation.kind === "pm-path-missing") return textResult("");
      if (mutation.kind === "pm-path-multiple") return textResult(`package:${remoteApkPath}\npackage:/data/app/duplicate/base.apk\n`);
      const changed = (mutation.kind === "installed-path-before-capture" && pmPathCalls >= 2)
        || (mutation.kind === "installed-path-after-capture" && pmPathCalls >= 3);
      return textResult(`package:${changed ? replacementRemoteApkPath : remoteApkPath}\n`);
    }
    if (key === `shell toybox sha256sum ${remoteApkPath}` || key === `shell toybox sha256sum ${replacementRemoteApkPath}`) {
      remoteDigestCalls += 1;
      const requestedPath = adbArgs.at(-1);
      const changed = mutation.kind === "remote-digest-mismatch"
        || (mutation.kind === "installed-digest-before-capture" && remoteDigestCalls >= 2)
        || (mutation.kind === "installed-digest-after-capture" && remoteDigestCalls >= 3);
      return textResult(`${changed ? "0".repeat(64) : apkSha256}  ${requestedPath}\n`);
    }
    if (key === "shell getprop ro.product.model") return textResult("PICO Emulator\n");
    if (key === "shell getprop ro.build.fingerprint") {
      return textResult(mutation.kind === "missing-fingerprint" ? "\n" : "PICO/PICO_Emulator/PICO_Emulator:14/fixture/test-keys\n");
    }
    if (key === "shell getprop ro.boot.qemu") {
      return textResult(mutation.kind === "empty-boot-qemu" ? "\n" : "1\n");
    }
    if (key === "shell cat /proc/sys/kernel/random/boot_id") {
      bootIdCalls += 1;
      if (mutation.kind === "missing-boot-id") return textResult("\n");
      const changed = (mutation.kind === "boot-change-before-launch" && bootIdCalls >= 2)
        || (mutation.kind === "boot-change-before-capture" && bootIdCalls >= 3)
        || (mutation.kind === "boot-change-after-capture" && bootIdCalls >= 4);
      return textResult(changed
        ? "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff\n"
        : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n");
    }
    if (key === "shell pm list packages com.fleet") {
      return textResult("package:com.fleet.previous\npackage:com.fleet.receiptextra\npackage:com.fleetish.not-listed\n");
    }
    if (adbArgs[0] === "shell" && adbArgs[1] === "am" && adbArgs[2] === "force-stop") {
      return textResult("");
    }
    if (key === `shell am start -n ${COMPONENT}`) {
      launchCalls += 1;
      if (mutation.kind === "launch-negative-ack") return textResult("Error: Activity class does not exist.\n");
      return textResult(`Starting: Intent { cmp=${COMPONENT} }\n`);
    }
    if (key === `shell pidof ${PACKAGE}`) {
      pidCalls += 1;
      if (mutation.kind === "slow-pid-missing") {
        monotonicMs += Math.min(19_000, options.timeoutMs ?? 19_000);
        return textResult("", { code: 1 });
      }
      if (mutation.kind === "slow-pid-then-foreground") {
        monotonicMs += Math.min(19_000, options.timeoutMs ?? 19_000);
      }
      if (mutation.kind === "pid-missing") return textResult("", { code: 1 });
      if (mutation.kind === "pid-multiple") return textResult(`${PID} ${PID + 1}\n`);
      return textResult(`${PID}\n`);
    }
    if (key === `shell cat /proc/${PID}/stat`) {
      statCalls += 1;
      if (mutation.kind === "stat-malformed") return textResult(`${PID} malformed proc stat\n`);
      if (mutation.kind === "pid-restarted" && statCalls >= 2) return textResult(procStat(PID, "987655"));
      return textResult(procStat());
    }
    if (key === "shell dumpsys activity activities") {
      foregroundCalls += 1;
      if (mutation.kind === "slow-pid-then-foreground") {
        monotonicMs += Math.min(19_000, options.timeoutMs ?? 19_000);
        return textResult("");
      }
      if (mutation.kind === "foreground-prefix-collision") {
        return textResult(foregroundOutput("com.fleet.receiptextra/.platform.LaunchActivity"));
      }
      if (mutation.kind === "foreground-wrong-activity") {
        return textResult(foregroundOutput(`${PACKAGE}/.OtherActivity`));
      }
      if (mutation.kind === "foreground-before" && foregroundCalls === 2) {
        return textResult(foregroundOutput("com.fleet.other/.platform.LaunchActivity"));
      }
      if (mutation.kind === "foreground-after" && foregroundCalls === 3) {
        return textResult(foregroundOutput("com.fleet.other/.platform.LaunchActivity"));
      }
      if (mutation.kind === "foreground-os6") {
        return textResult(os6ForegroundOutput());
      }
      if (mutation.kind === "foreground-os6-same-package-alternate") {
        return textResult(os6ForegroundOutput({
          additionalComponents: [`${PACKAGE}/.OtherActivity`],
        }));
      }
      if (mutation.kind === "foreground-os6-shell-only") {
        return textResult(os6ForegroundOutput({ includeTarget: false }));
      }
      if (mutation.kind === "foreground-os6-foreign-then-target") {
        return textResult(foregroundCalls <= 2
          ? os6ForegroundOutput({
            includeTarget: false,
            additionalComponents: ["com.pxr.systemui/.OverlayActivity"],
          })
          : os6ForegroundOutput());
      }
      if (mutation.kind?.startsWith("blocker-recovery") && launchCalls === 1) {
        return textResult(foregroundOutput("com.fleet.blocker/.platform.LaunchActivity"));
      }
      return textResult(foregroundOutput());
    }
    throw new Error(`unexpected adb arguments: ${key}`);
  };

  const runBinary = async (command, args, options = {}) => {
    events.push({ type: "binary", command, args: [...args], options: { ...options } });
    assert.equal(command, "/fixture/adb");
    assert.deepEqual(args, ["-s", "emulator-5554", "exec-out", "screencap", "-p"]);
    if (mutation.kind === "capture-command" || mutation.kind === "blocker-recovery-capture-command") {
      return binaryResult(Buffer.alloc(0), { code: 1, stderr: "screencap failed\n" });
    }
    return binaryResult(captureBytes);
  };

  const inspectedPackage = mutation.kind === "inspection-package-mismatch" ? "com.fleet.wrong" : PACKAGE;
  const deps = {
    runText,
    runBinary,
    adbPath: "/fixture/adb",
    gradleEnv: { JAVA_HOME: "/fixture/jbr" },
    now: () => {
      const value = new Date(clock);
      clock += 1_000;
      return value;
    },
    monotonicNow: () => monotonicMs,
    randomUUID: () => SESSION_ID,
    sleep: async (ms) => {
      sleeps.push(ms);
      monotonicMs += ms;
    },
    inspectApk: async (apkPath, inspectedProjectDir) => {
      assert.equal(apkPath, expectedApkCasPath);
      assert.equal(inspectedProjectDir, fs.realpathSync(projectDir));
      return {
        manifestInspection: {
          status: "inspected",
          tool: "aapt2",
          packageName: inspectedPackage,
          versionCode: "1",
          versionName: "1.0",
        },
        signingInspection: {
          status: "inspected",
          tool: "apksigner",
          certificateSha256: [sha256("fixture-debug-certificate")],
        },
      };
    },
  };

  const input = {
    briefPath,
    effectiveSpec: mutation.kind === "source-package-mismatch"
      ? effectiveSpec("com.fleet.wrong")
      : mutation.kind === "oversized-effective-spec"
        ? effectiveSpecWithStoredBytes(EXPECTED_EFFECTIVE_SPEC_MAX_BYTES + 1, PACKAGE)
        : effectiveSpec(PACKAGE),
    projectDir,
    packageName: PACKAGE,
    task: ":app:assembleDebug",
    serial: "emulator-5554",
    component: COMPONENT,
    captureDir,
    settleMs: mutation.kind === "invalid-settle" ? Number.POSITIVE_INFINITY : 2_750,
    ...(mutation.kind === "after-install"
      ? { afterInstall: async () => ({ status: "failed", reason: "fixture delivery failed" }) }
      : {}),
  };

  return {
    scratch,
    projectDir,
    receiptRoot,
    ledgerRoot,
    sourceApkPath,
    apkBytes,
    apkSha256,
    captureBytes,
    captureSha256,
    expectedApkCasPath,
    expectedCaptureCasPath,
    expectedCaptureSourcePath,
    input,
    deps,
    events,
    sleeps,
    monotonicNow: () => monotonicMs,
  };
}

test("pure Android parsers reject ambiguity and preserve exact identities", () => {
  const installed = "/data/app/~~receipt/com.fleet.receipt/base.apk";
  assert.equal(parseInstalledApkPath(`package:${installed}\r\n`), installed);
  assert.equal(parseInstalledApkPath(`package:${installed}\npackage:/data/app/other/base.apk\n`), null);
  assert.equal(parseInstalledApkPath("Error: package not found\n"), null);

  const digest = "A1".repeat(32);
  assert.equal(parseRemoteSha256(`${digest}  ${installed}\n`), digest.toLowerCase());
  assert.equal(parseRemoteSha256(`not-a-hash  ${installed}\n`), null);
  assert.equal(parseRemoteSha256(`${digest}  ${installed}\n${"b2".repeat(32)}  ${installed}\n`), null);

  assert.equal(parsePid("4242\n"), 4242);
  assert.equal(parsePid("4242 4243\n"), null);
  assert.equal(parsePid("4242x\n"), null);
  assert.equal(parsePid("0\n"), null);

  const literalStat = "4242 (Receipt worker (stage)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20 21 22\n";
  assert.equal(parseProcStartTicks(literalStat), "987654");
  assert.equal(parseProcStartTicks("4242 (truncated) S 1 2 3\n"), null);
  assert.equal(parseProcStartTicks("4242 malformed\n"), null);

  assert.deepEqual(parseForegroundActivity(foregroundOutput()), {
    packageName: PACKAGE,
    component: COMPONENT,
  });
  assert.deepEqual(parseForegroundActivity(foregroundOutput("com.fleet.receiptextra/.platform.LaunchActivity")), {
    packageName: "com.fleet.receiptextra",
    component: "com.fleet.receiptextra/.platform.LaunchActivity",
  });
  assert.equal(
    parseForegroundActivity(`${foregroundOutput()}${foregroundOutput("com.fleet.other/.platform.LaunchActivity")}`),
    null,
  );
  assert.equal(parseForegroundActivity("mCurrentFocus=null\n"), null);
});

test("foreground parser deduplicates one component repeated across resumed summaries", () => {
  assert.deepEqual(parseForegroundActivity(os6ForegroundOutput({ includeSpatialShell: false })), {
    packageName: PACKAGE,
    component: COMPONENT,
  });
  assert.equal(parseForegroundActivity(os6ForegroundOutput()), null);
});

test("successful producer binds installed bytes and brackets one exact capture", async (t) => {
  const fixture = await createProducerFixture(t);
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "recorded");
  assert.equal(out.built, true);
  assert.equal(out.installed, true);
  assert.equal(out.receipt.receipt.install.remoteApkSha256, fixture.apkSha256);
  assert.equal(out.receipt.receipt.runtime.pid, PID);
  assert.equal(out.receipt.receipt.capture.before.pidStartTicks, PID_START_TICKS);
  assert.equal(out.receipt.receipt.capture.after.pidStartTicks, PID_START_TICKS);
  assert.equal(out.receipt.receipt.capture.before.foregroundPackage, PACKAGE);
  assert.equal(out.receipt.receipt.capture.after.foregroundPackage, PACKAGE);
  assert.equal(out.receipt.receipt.capture.artifactPath, fixture.expectedCaptureCasPath);
  assert.equal(out.receipt.receipt.capture.sourcePath, fs.realpathSync(fixture.expectedCaptureSourcePath));

  assert.deepEqual(fs.readFileSync(fixture.expectedCaptureSourcePath), fixture.captureBytes);
  assert.deepEqual(fs.readFileSync(fixture.expectedCaptureCasPath), fixture.captureBytes);
  assert.deepEqual(fs.readFileSync(fixture.expectedApkCasPath), fixture.apkBytes);
  assert.equal(fs.existsSync(path.join(fixture.ledgerRoot, `${PACKAGE}.json`)), false);
  assert.deepEqual(receiptFiles(fixture.receiptRoot), [`${out.receipt.receiptId}.json`]);
  assert.equal(readNativeRunReceipt(PACKAGE, out.receipt.receiptId).status, "valid");

  const install = fixture.events.find((event) => event.type === "text" && event.args[2] === "install");
  assert.deepEqual(install.args.slice(2), ["install", "-r", fixture.expectedApkCasPath]);
  const forcedPackages = fixture.events
    .filter((event) => event.type === "text" && event.args.slice(2, 5).join(" ") === "shell am force-stop")
    .map((event) => event.args[5]);
  assert.deepEqual(forcedPackages, ["com.fleet.previous", "com.fleet.receiptextra"]);
  assert.equal(fixture.sleeps.filter((ms) => ms === fixture.input.settleMs).length, 1);
  assert.equal(fixture.sleeps.includes(2_000), true);
  for (const event of fixture.events) {
    assert.equal(Object.hasOwn(event.options, "timeout"), false);
    assert.equal(Object.hasOwn(event.options, "maxBuffer"), false);
  }
  const statIndexes = fixture.events
    .map((event, index) => event.type === "text" && event.args.join(" ").includes(`/proc/${PID}/stat`) ? index : -1)
    .filter((index) => index >= 0);
  const captureIndex = fixture.events.findIndex((event) => event.type === "binary");
  assert.equal(statIndexes.length, 3);
  assert.ok(statIndexes[1] < captureIndex && captureIndex < statIndexes[2]);
  assert.equal(fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2).join(" ") === `shell pm path ${PACKAGE}`).length, 3);
  assert.equal(fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2, 5).join(" ") === "shell toybox sha256sum").length, 3);
  assert.equal(fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2).join(" ") === "shell cat /proc/sys/kernel/random/boot_id").length, 4);
});

test("producer rejects an oversized effective AppSpec before Gradle or live runners", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "oversized-effective-spec" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "source-identity");
  assert.equal(out.built, false);
  assert.equal(out.installed, false);
  assert.match(out.reason, /effective AppSpec|stored|byte|limit|2097152/i);
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
});

test("producer discards a late setup callback and records only a freshly guarded second build", async (t) => {
  const fixture = await createProducerFixture(t);
  const projectRealDir = fs.realpathSync(fixture.projectDir);
  const lateSelectedPath = writeFile(projectRealDir, "gradlew.bat", "@echo off\r\n");
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalWatch = fs.watch;
  const watchers = [];
  const lateFileDescriptors = new Set();
  let lateFileClosed = false;
  let mutated = false;

  fs.watch = function (directory, options, listener) {
    const callback = typeof options === "function" ? options : listener;
    const directoryPath = path.resolve(directory);
    const watcher = {
      directory: directoryPath,
      callback,
      close() {},
      on() { return watcher; },
    };
    if (!mutated && directoryPath === projectRealDir && lateFileClosed) {
      mutated = true;
      const original = fs.readFileSync(lateSelectedPath);
      fs.writeFileSync(lateSelectedPath, "changed before the root watcher was established\r\n");
      fs.writeFileSync(lateSelectedPath, original);
    }
    watchers.push(watcher);
    if (!mutated && directoryPath === projectRealDir) {
      mutated = true;
      const original = fs.readFileSync(lateSelectedPath);
      fs.writeFileSync(lateSelectedPath, "changed after the root watcher was established\r\n");
      fs.writeFileSync(lateSelectedPath, original);
      callback("change", "gradlew.bat");
    }
    return watcher;
  };
  fs.openSync = function (filePath, ...args) {
    const fd = originalOpenSync.call(this, filePath, ...args);
    if (path.resolve(filePath) === path.resolve(lateSelectedPath)) lateFileDescriptors.add(fd);
    return fd;
  };
  fs.closeSync = function (fd) {
    if (lateFileDescriptors.delete(fd)) lateFileClosed = true;
    return originalCloseSync.call(this, fd);
  };

  let out;
  try {
    out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fs.watch = originalWatch;
  }

  assert.equal(mutated, true);
  assert.equal(out.status, "recorded", JSON.stringify(out, null, 2));
  assert.equal(fixture.events.filter((event) => event.command.endsWith("/gradlew")).length, 2);
  assert.ok(out.completedStages.includes("build-input-continuity:first-attempt-inconclusive"));
  assert.ok(out.completedStages.includes("build-input-continuity:second-attempt-proved"));
});

test("producer binds one unchanged Gradle input generation across the awaited build", async (t) => {
  const mutations = [
    ["persistent selected-file content change", "gradle-selected-content-persistent"],
    ["selected file changed and restored to identical bytes", "gradle-selected-content-restored"],
    ["persistent selected membership addition", "gradle-selected-member-persistent"],
    ["selected source added and removed", "gradle-selected-member-restored"],
    ["root-selected file atomically replaced and restored", "gradle-root-atomic-restored"],
    ["initially absent selected root created and removed", "gradle-absent-root-restored"],
  ];
  for (const [name, kind] of mutations) {
    await t.test(name, async (child) => {
      const fixture = await createProducerFixture(child, { kind });
      const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
      assert.equal(out.status, "failed");
      assert.equal(out.stage, "build-input-continuity");
      assert.equal(out.built, false);
      assert.equal(out.installed, false);
      assert.match(out.reason, /Gradle input|generation|changed|continuity/i);
      const gradleInvocations = fixture.events.filter((event) => event.command.endsWith("/gradlew")).length;
      if (kind === "gradle-absent-root-restored") {
        assert.ok([1, 2].includes(gradleInvocations), `selected evidence may fail definitively on attempt 1 or repeat on bounded attempt 2; got ${gradleInvocations}`);
      } else {
        assert.equal(gradleInvocations, 1);
      }
      assert.equal(fixture.events.some((event) => event.command === "/fixture/adb"), false);
      assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
    });
  }

  await t.test("excluded build outputs and documentation do not invalidate the generation", async (child) => {
    const fixture = await createProducerFixture(child, { kind: "gradle-excluded-output-mutations" });
    const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
    assert.equal(out.status, "recorded");
    assert.equal(out.receipt.receipt.source.gradleInputs.entries.some((entry) => entry.path.startsWith("app/build/")), false);
    assert.equal(out.receipt.receipt.source.gradleInputs.entries.some((entry) => entry.path.startsWith(".gradle/")), false);
    assert.equal(out.receipt.receipt.source.gradleInputs.entries.some((entry) => entry.path === "README.md"), false);
  });

  await t.test("buildSrc build and nested metadata outputs do not invalidate or enter the generation", async (child) => {
    const fixture = await createProducerFixture(child, { kind: "gradle-excluded-buildsrc-outputs" });
    const { out, watchers } = await produceWithClassifiedWatchEvents(fixture, [
      ["buildSrc", "build"],
      ["buildSrc", ".gradle"],
    ]);
    assert.equal(out.status, "recorded", JSON.stringify(out, null, 2));
    assert.equal(out.receipt.receipt.source.gradleInputs.entries.some((entry) => entry.path.startsWith("buildSrc/build/")), false);
    assert.equal(out.receipt.receipt.source.gradleInputs.entries.some((entry) => entry.path.includes("/.gradle/")), false);
    assert.deepEqual(watchers.map((watcher) => watcher.closeCalls), watchers.map(() => 1));
  });

  await t.test("excluded buildSrc output cannot mask a simultaneous selected transient member", async (child) => {
    const fixture = await createProducerFixture(child, { kind: "gradle-excluded-plus-selected" });
    const { out, watchers } = await produceWithClassifiedWatchEvents(fixture, [
      ["buildSrc", "build"],
      ["buildSrc", ".gradle"],
      ["buildSrc", "Transient.kt"],
    ]);
    assert.equal(out.status, "failed");
    assert.equal(out.stage, "build-input-continuity", JSON.stringify(out, null, 2));
    assert.equal(out.built, false);
    assert.equal(out.installed, false);
    assert.equal(fixture.events.some((event) => event.command === "/fixture/adb"), false);
    assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
    assert.deepEqual(watchers.map((watcher) => watcher.closeCalls), watchers.map(() => 1));
  });

  await t.test("restored buildSrc documentation file cannot hide a transient same-named selected directory", async (child) => {
    const fixture = await createProducerFixture(child, { kind: "gradle-buildsrc-doc-file-directory-restored" });
    const { out, watchers } = await produceWithClassifiedWatchEvents(fixture, [
      ["buildSrc", "README.md"],
    ]);
    assert.equal(out.status, "failed");
    assert.equal(out.stage, "build-input-continuity", JSON.stringify(out, null, 2));
    assert.equal(out.built, false);
    assert.equal(out.installed, false);
    assert.equal(fixture.events.some((event) => event.command === "/fixture/adb"), false);
    assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
    assert.deepEqual(watchers.map((watcher) => watcher.closeCalls), watchers.map(() => 1));
  });
});

test("producer settles a spaced excluded-only watcher backlog without invalidating continuity", { timeout: 4_000 }, async (t) => {
  const fixture = await createProducerFixture(t, { kind: "gradle-excluded-output-mutations" });
  const fake = installFakeWatch();
  const originalRunText = fixture.deps.runText;
  fixture.deps.runText = async (...args) => {
    const result = await originalRunText(...args);
    if (args[0].endsWith("/gradlew")) {
      const projectDirectory = fs.realpathSync(fixture.projectDir);
      const projectWatcher = fake.watchers.find((watcher) => watcher.directory === projectDirectory);
      assert.ok(projectWatcher, "project root must be watched before Gradle starts");
      for (let index = 0; index < 20; index += 1) {
        setTimeout(() => projectWatcher.callback("rename", index % 2 ? ".gradle" : "README.md"), index * 2);
      }
    }
    return result;
  };
  let out;
  try {
    out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  } finally {
    fake.restore();
  }
  assert.equal(out.status, "recorded", JSON.stringify(out, null, 2));
  assert.deepEqual(fake.watchers.map((watcher) => watcher.closeCalls), fake.watchers.map(() => 1));
});

test("producer discards one inconclusive excluded-output build and records only a freshly guarded second build", { timeout: 5_000 }, async (t) => {
  const fixture = await createProducerFixture(t, { kind: "gradle-excluded-output-mutations" });
  const fake = installFakeWatch();
  let out;
  try {
    out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  } finally {
    fake.restore();
  }
  assert.equal(out.status, "recorded", JSON.stringify(out, null, 2));
  assert.equal(fixture.events.filter((event) => event.command.endsWith("/gradlew")).length, 2);
  assert.ok(out.completedStages.includes("build-input-continuity:first-attempt-inconclusive"));
  assert.ok(out.completedStages.includes("build-input-continuity:second-attempt-proved"));
  assert.deepEqual(fake.watchers.map((watcher) => watcher.closeCalls), fake.watchers.map(() => 1));
});

test("producer discards mixed coalesced callbacks and records only a freshly guarded second build", { timeout: 5_000 }, async (t) => {
  const fixture = await createProducerFixture(t, { kind: "gradle-excluded-output-mutations" });
  const fake = installFakeWatch();
  const originalRunText = fixture.deps.runText;
  let gradleAttempt = 0;
  fixture.deps.runText = async (...args) => {
    const result = await originalRunText(...args);
    if (args[0].endsWith("/gradlew")) {
      gradleAttempt += 1;
      if (gradleAttempt === 1) {
        const projectDirectory = fs.realpathSync(fixture.projectDir);
        const appDirectory = fs.realpathSync(path.join(fixture.projectDir, "app"));
        const projectWatcher = fake.watchers.find((watcher) => watcher.directory === projectDirectory && !watcher.closed);
        const appWatcher = fake.watchers.find((watcher) => watcher.directory === appDirectory && !watcher.closed);
        assert.ok(projectWatcher, "first project-root guard must still be live after Gradle");
        assert.ok(appWatcher, "first app guard must still be live after Gradle");
        for (const filename of ["settings.gradle.kts", "build.gradle.kts", "gradlew", "app", ".gradle", "README.md"]) {
          projectWatcher.callback("rename", filename);
        }
        for (const filename of ["build.gradle.kts", "src", "build"]) {
          appWatcher.callback("rename", filename);
        }
      }
    }
    return result;
  };
  let out;
  try {
    out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  } finally {
    fake.restore();
  }
  assert.equal(out.status, "recorded", JSON.stringify(out, null, 2));
  assert.equal(gradleAttempt, 2);
  assert.ok(out.completedStages.includes("build-input-continuity:first-attempt-inconclusive"));
  assert.ok(out.completedStages.includes("build-input-continuity:second-attempt-proved"));
  assert.deepEqual(fake.watchers.map((watcher) => watcher.closeCalls), fake.watchers.map(() => 1));
});

test("an excluded callback cannot mask a dropped selected transient on the discarded first build", { timeout: 5_000 }, async (t) => {
  const fixture = await createProducerFixture(t, { kind: "gradle-excluded-plus-dropped-selected-first" });
  const fake = installFakeWatch();
  const originalRunText = fixture.deps.runText;
  let gradleAttempt = 0;
  fixture.deps.runText = async (...args) => {
    const result = await originalRunText(...args);
    if (args[0].endsWith("/gradlew")) {
      gradleAttempt += 1;
      if (gradleAttempt === 1) {
        const projectDirectory = fs.realpathSync(fixture.projectDir);
        const projectWatcher = fake.watchers.find((watcher) => watcher.directory === projectDirectory && !watcher.closed);
        assert.ok(projectWatcher, "first project-root guard must still be live after Gradle");
        projectWatcher.callback("rename", ".gradle");
      }
    }
    return result;
  };
  let out;
  try {
    out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  } finally {
    fake.restore();
  }
  assert.equal(out.status, "recorded", JSON.stringify(out, null, 2));
  assert.equal(gradleAttempt, 2);
  assert.ok(out.completedStages.includes("build-input-continuity:first-attempt-inconclusive"));
  assert.ok(out.completedStages.includes("build-input-continuity:second-attempt-proved"));
  assert.deepEqual(fake.watchers.map((watcher) => watcher.closeCalls), fake.watchers.map(() => 1));
});

test("producer fails closed when an uncorroborated selected-looking callback repeats on both guarded builds", { timeout: 4_000 }, async (t) => {
  const fixture = await createProducerFixture(t);
  const fake = installFakeWatch();
  const originalRunText = fixture.deps.runText;
  let gradleAttempt = 0;
  fixture.deps.runText = async (...args) => {
    const result = await originalRunText(...args);
    if (args[0].endsWith("/gradlew")) {
      gradleAttempt += 1;
      const projectDirectory = fs.realpathSync(fixture.projectDir);
      const projectWatcher = fake.watchers.find((watcher) => watcher.directory === projectDirectory && !watcher.closed);
      assert.ok(projectWatcher, `guard for Gradle attempt ${gradleAttempt} must still be live after Gradle`);
      setImmediate(() => setImmediate(() => projectWatcher.callback("rename", "app")));
    }
    return result;
  };
  let out;
  try {
    out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  } finally {
    fake.restore();
  }
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "build-input-continuity");
  assert.equal(out.built, false);
  assert.equal(out.installed, false);
  assert.equal(gradleAttempt, 2);
  assert.match(out.reason, /inconclusive/i);
  assert.ok(out.completedStages.includes("build-input-continuity:first-attempt-inconclusive"));
  assert.equal(out.completedStages.includes("build-input-continuity:second-attempt-proved"), false);
  assert.equal(fixture.events.some((event) => event.command === "/fixture/adb"), false);
  assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
  assert.deepEqual(fake.watchers.map((watcher) => watcher.closeCalls), fake.watchers.map(() => 1));
});

test("producer converts a watcher error into one bounded continuity failure and closes cleanly", { timeout: 4_000 }, async (t) => {
  const fixture = await createProducerFixture(t);
  const fake = installFakeWatch();
  const originalRunText = fixture.deps.runText;
  fixture.deps.runText = async (...args) => {
    const result = await originalRunText(...args);
    if (args[0].endsWith("/gradlew")) {
      for (let index = 0; index < 64; index += 1) fake.watchers[0].emit("error", new Error(`fixture watcher failure ${index}`));
    }
    return result;
  };
  let out;
  try {
    out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  } finally {
    fake.restore();
  }
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "build-input-continuity");
  assert.equal(out.built, false);
  assert.equal(out.installed, false);
  assert.match(out.reason, /watcher-error|watcher failure/i);
  assert.ok(out.reason.length < 2_000, `watcher failure must stay bounded: ${out.reason.length}`);
  assert.equal(fixture.events.filter((event) => event.command.endsWith("/gradlew")).length, 1);
  assert.equal(fixture.events.some((event) => event.command === "/fixture/adb"), false);
  assert.ok(fake.watchers.length >= 2);
  assert.deepEqual(fake.watchers.map((watcher) => watcher.closeCalls), fake.watchers.map(() => 1));
});

test("producer converts a watcher close error into a bounded failure without retry or hang", { timeout: 4_000 }, async (t) => {
  const fixture = await createProducerFixture(t);
  const fake = installFakeWatch();
  const originalRunText = fixture.deps.runText;
  fixture.deps.runText = async (...args) => {
    const result = await originalRunText(...args);
    if (args[0].endsWith("/gradlew")) {
      const watcher = fake.watchers[0];
      watcher.close = () => {
        watcher.closeCalls += 1;
        watcher.closed = true;
        throw new Error("fixture watcher close failure");
      };
    }
    return result;
  };
  let out;
  try {
    out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  } finally {
    fake.restore();
  }
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "build-input-continuity");
  assert.match(out.reason, /watcher-close-error|watcher close failure/i);
  assert.ok(out.reason.length < 2_000, `watcher close failure must stay bounded: ${out.reason.length}`);
  assert.equal(fixture.events.filter((event) => event.command.endsWith("/gradlew")).length, 1);
  assert.equal(fixture.events.some((event) => event.command === "/fixture/adb"), false);
  assert.deepEqual(fake.watchers.map((watcher) => watcher.closeCalls), fake.watchers.map(() => 1));
});

test("producer fails closed on a dropped event for an initially absent selected root", { timeout: 4_000 }, async (t) => {
  const fixture = await createProducerFixture(t, { kind: "gradle-absent-root-restored" });
  const fake = installFakeWatch();
  let out;
  try {
    out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  } finally {
    fake.restore();
  }
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "build-input-continuity");
  assert.equal(out.built, false);
  assert.equal(out.installed, false);
  assert.match(out.reason, /parent|directory|generation|continuity|mutation|ambiguous/i);
  assert.equal(fixture.events.filter((event) => event.command.endsWith("/gradlew")).length, 2);
  assert.equal(fixture.events.some((event) => event.command === "/fixture/adb"), false);
  assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
  assert.deepEqual(fake.watchers.map((watcher) => watcher.closeCalls), fake.watchers.map(() => 1));
});

test("producer preserves an exact empty ro.boot.qemu observation", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "empty-boot-qemu" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "recorded");
  assert.equal(out.receipt.receipt.runtime.bootQemu, "");
});

test("OS 6 co-resumed shell does not defeat the exact fleet foreground component", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "foreground-os6" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "recorded");
  assert.equal(out.receipt.receipt.capture.before.foregroundComponent, COMPONENT);
  assert.equal(out.receipt.receipt.capture.after.foregroundComponent, COMPONENT);
  const shellStops = fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2, 5).join(" ") === "shell am force-stop"
    && event.args[5]?.startsWith("com.pxr."));
  assert.deepEqual(shellStops, []);
});

test("a same-package alternate resumed component remains a hard foreground failure", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "foreground-os6-same-package-alternate" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "foreground");
  assert.equal(out.completedStages.some((stage) => stage.startsWith("foreground-recovery:")), false);
  assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
});

test("an OS 6 shell cannot be force-stopped when the fleet target is absent", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "foreground-os6-shell-only" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "foreground");
  const shellStops = fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2, 5).join(" ") === "shell am force-stop"
    && event.args[5]?.startsWith("com.pxr."));
  assert.deepEqual(shellStops, []);
  assert.equal(out.completedStages.some((stage) => stage.startsWith("foreground-recovery:")), false);
  assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
});

test("multiple foreign OS 6 activities keep polling until the fleet target appears", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "foreground-os6-foreign-then-target" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "recorded");
  assert.equal(out.receipt.receipt.capture.before.foregroundComponent, COMPONENT);
  assert.equal(out.receipt.receipt.capture.after.foregroundComponent, COMPONENT);
  const probes = fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2).join(" ") === "shell dumpsys activity activities");
  assert.equal(probes.length, 5);
  assert.deepEqual(fixture.sleeps, [2_000, 2_000, 2_000, 2_750]);
});

test("one foreign foreground blocker can be stopped and relaunched once with disclosure", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "blocker-recovery" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "recorded");
  assert.equal(out.receipt.receipt.runtime.pid, PID);
  const blockerStops = fixture.events.filter((event) =>
    event.type === "text" && event.args.join(" ") === "-s emulator-5554 shell am force-stop com.fleet.blocker");
  assert.equal(blockerStops.length, 1);
  const launches = fixture.events.filter((event) =>
    event.type === "text" && event.args.join(" ") === `-s emulator-5554 shell am start -n ${COMPONENT}`);
  assert.equal(launches.length, 2);
});

test("a recovered run discloses the one blocker recovery if a later stage fails", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "blocker-recovery-capture-command" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "capture");
  assert.deepEqual(
    out.completedStages.filter((stage) => stage.startsWith("foreground-recovery:")),
    ["foreground-recovery:blocker=com.fleet.blocker"],
  );
  assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
});

test("PID polling caps child calls and sleeps to one monotonic 24000ms deadline", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "slow-pid-missing" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "pid");
  const pidEvents = fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2).join(" ") === `shell pidof ${PACKAGE}`);
  assert.deepEqual(pidEvents.map((event) => event.options.timeoutMs), [20_000, 3_000]);
  assert.deepEqual(fixture.sleeps, [2_000, 2_000]);
  assert.equal(fixture.monotonicNow(), 26_000);
  assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
});

test("PID and foreground polling share one monotonic 24000ms deadline per launch attempt", async (t) => {
  const fixture = await createProducerFixture(t, { kind: "slow-pid-then-foreground" });
  const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
  assert.equal(out.status, "failed");
  assert.equal(out.stage, "foreground");
  const pidEvents = fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2).join(" ") === `shell pidof ${PACKAGE}`);
  const statEvents = fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2).join(" ") === `shell cat /proc/${PID}/stat`);
  const foregroundEvents = fixture.events.filter((event) => event.type === "text"
    && event.args.slice(2).join(" ") === "shell dumpsys activity activities");
  assert.deepEqual(pidEvents.map((event) => event.options.timeoutMs), [20_000]);
  assert.deepEqual(statEvents.map((event) => event.options.timeoutMs), [5_000]);
  assert.deepEqual(foregroundEvents.map((event) => event.options.timeoutMs), [5_000]);
  assert.deepEqual(fixture.sleeps, [2_000]);
  assert.equal(fixture.monotonicNow(), 26_000);
  assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
});

test("default SDK inspection records available facts and explicit tool absence", async (t) => {
  await t.test("available aapt2 and apksigner", async (child) => {
    const fixture = await createProducerFixture(child);
    const sdkRoot = path.join(fixture.scratch, "android-sdk");
    writeFile(sdkRoot, "build-tools/35.0.0/aapt2", "fixture tool");
    writeFile(sdkRoot, "build-tools/35.0.0/apksigner", "fixture tool");
    const previousSdkRoot = process.env.ANDROID_SDK_ROOT;
    process.env.ANDROID_SDK_ROOT = sdkRoot;
    child.after(() => {
      if (previousSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
      else process.env.ANDROID_SDK_ROOT = previousSdkRoot;
    });
    const baseRunText = fixture.deps.runText;
    fixture.deps.runText = async (command, args, options) => {
      if (command.endsWith("/aapt2")) {
        return textResult(`package: name='${PACKAGE}' versionCode='7' versionName='7.0'\n`);
      }
      if (command.endsWith("/apksigner")) {
        assert.equal(options.env.JAVA_HOME, "/fixture/jbr");
        assert.ok(options.env.PATH.startsWith(`/fixture/jbr/bin${path.delimiter}`));
        return textResult(`Signer #1 certificate SHA-256 digest: ${sha256("default-inspection-certificate")}\n`);
      }
      return baseRunText(command, args, options);
    };
    delete fixture.deps.inspectApk;

    const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
    assert.equal(out.status, "recorded");
    assert.deepEqual(out.receipt.receipt.apk.manifestInspection, {
      status: "inspected",
      tool: "aapt2",
      packageName: PACKAGE,
      versionCode: "7",
      versionName: "7.0",
    });
    assert.deepEqual(out.receipt.receipt.apk.signingInspection, {
      status: "inspected",
      tool: "apksigner",
      certificateSha256: [sha256("default-inspection-certificate")],
    });
  });

  await t.test("missing build tools", async (child) => {
    const fixture = await createProducerFixture(child);
    const sdkRoot = path.join(fixture.scratch, "empty-android-sdk");
    fs.mkdirSync(sdkRoot, { recursive: true });
    const previousSdkRoot = process.env.ANDROID_SDK_ROOT;
    process.env.ANDROID_SDK_ROOT = sdkRoot;
    child.after(() => {
      if (previousSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
      else process.env.ANDROID_SDK_ROOT = previousSdkRoot;
    });
    delete fixture.deps.inspectApk;

    const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
    assert.equal(out.status, "recorded");
    assert.equal(out.receipt.receipt.apk.manifestInspection.status, "unavailable");
    assert.match(out.receipt.receipt.apk.manifestInspection.reason, /aapt2.*not found/i);
    assert.equal(out.receipt.receipt.apk.signingInspection.status, "unavailable");
    assert.match(out.receipt.receipt.apk.signingInspection.reason, /apksigner.*not found/i);
  });

  await t.test("apksigner inspection is unavailable when the resolved JDK is absent", async (child) => {
    const fixture = await createProducerFixture(child);
    const sdkRoot = path.join(fixture.scratch, "android-sdk-without-jdk");
    writeFile(sdkRoot, "build-tools/35.0.0/aapt2", "fixture tool");
    writeFile(sdkRoot, "build-tools/35.0.0/apksigner", "fixture tool");
    const previousSdkRoot = process.env.ANDROID_SDK_ROOT;
    process.env.ANDROID_SDK_ROOT = sdkRoot;
    child.after(() => {
      if (previousSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
      else process.env.ANDROID_SDK_ROOT = previousSdkRoot;
    });
    const baseRunText = fixture.deps.runText;
    fixture.deps.gradleEnv = {};
    fixture.deps.runText = async (command, args, options) => {
      if (command.endsWith("/aapt2")) {
        return textResult(`package: name='${PACKAGE}' versionCode='7' versionName='7.0'\n`);
      }
      if (command.endsWith("/apksigner")) {
        throw new Error("apksigner must not run when the JDK is unresolved");
      }
      return baseRunText(command, args, options);
    };
    delete fixture.deps.inspectApk;

    const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
    assert.equal(out.status, "recorded");
    assert.equal(out.receipt.receipt.apk.signingInspection.status, "unavailable");
    assert.match(out.receipt.receipt.apk.signingInspection.reason, /JDK.*apksigner inspection/i);
  });
});

test("producer fails closed at every mandatory stage and never publishes a receipt", async (t) => {
  const cases = [
    ["invalid settle", "invalid-settle", "source-identity", false, false],
    ["effective package mismatch", "source-package-mismatch", "source-identity", false, false],
    ["Gradle nonzero", "build-nonzero", "build", false, false],
    ["Gradle timeout", "build-timeout", "build", false, false],
    ["missing metadata APK", "missing-metadata", "apk-resolution", true, false],
    ["ambiguous metadata APK", "ambiguous-metadata", "apk-resolution", true, false],
    ["APK CAS corruption", "apk-cas-corruption", "apk-publication", true, false],
    ["inspected package mismatch", "inspection-package-mismatch", "apk-inspection", true, false],
    ["install nonzero", "install-nonzero", "install", true, false],
    ["install lacks Success", "install-no-success", "install", true, false],
    ["pm path missing", "pm-path-missing", "installed-byte-identity", true, true],
    ["pm path multiple", "pm-path-multiple", "installed-byte-identity", true, true],
    ["remote digest mismatch", "remote-digest-mismatch", "installed-byte-identity", true, true],
    ["installed path replacement before capture", "installed-path-before-capture", "installed-byte-identity", true, true],
    ["installed path replacement after capture", "installed-path-after-capture", "installed-byte-identity", true, true],
    ["installed digest replacement before capture", "installed-digest-before-capture", "installed-byte-identity", true, true],
    ["installed digest replacement after capture", "installed-digest-after-capture", "installed-byte-identity", true, true],
    ["after-install hook", "after-install", "after-install", true, true],
    ["missing fingerprint", "missing-fingerprint", "device-identity", true, true],
    ["missing boot ID", "missing-boot-id", "device-identity", true, true],
    ["boot ID changed before launch", "boot-change-before-launch", "device-identity", true, true],
    ["boot ID changed before capture", "boot-change-before-capture", "device-identity", true, true],
    ["boot ID changed after capture", "boot-change-after-capture", "device-identity", true, true],
    ["launch negative acknowledgement", "launch-negative-ack", "launch", true, true],
    ["missing PID", "pid-missing", "pid", true, true],
    ["multiple PID", "pid-multiple", "pid", true, true],
    ["malformed PID stat", "stat-malformed", "pid", true, true],
    ["PID restarted before capture", "pid-restarted", "pid", true, true],
    ["foreground package prefix collision", "foreground-prefix-collision", "foreground", true, true],
    ["wrong foreground activity", "foreground-wrong-activity", "foreground", true, true],
    ["wrong foreground before capture", "foreground-before", "foreground", true, true],
    ["wrong foreground after capture", "foreground-after", "foreground", true, true],
    ["binary capture command", "capture-command", "capture", true, true],
    ["invalid PNG", "invalid-png", "capture-publication", true, true],
    ["capture CAS corruption", "capture-cas-corruption", "capture-publication", true, true],
    ["receipt publication", "receipt-publication", "receipt-publication", true, true],
  ];

  for (const [name, kind, stage, built, installed] of cases) {
    await t.test(name, async (child) => {
      const fixture = await createProducerFixture(child, { kind });
      const out = await produceNativeFleetReceipt(fixture.input, fixture.deps);
      assert.equal(out.status, "failed");
      assert.equal(out.stage, stage);
      assert.equal(out.built, built);
      assert.equal(out.installed, installed);
      assert.equal(typeof out.reason, "string");
      assert.ok(out.reason.length > 0);
      assert.deepEqual(receiptFiles(fixture.receiptRoot), []);
      assert.equal(out.completedStages.includes("receipt-publication"), false);
      if (kind === "pid-missing") {
        assert.equal(fixture.sleeps.filter((ms) => ms === 2_000).length, 12);
      }
    });
  }
});

test("command failures report bounded factual exit and timeout state", async (t) => {
  const nonzeroFixture = await createProducerFixture(t, { kind: "build-nonzero" });
  const nonzero = await produceNativeFleetReceipt(nonzeroFixture.input, nonzeroFixture.deps);
  assert.equal(nonzero.status, "failed");
  assert.match(nonzero.reason, /gradlew|assembleDebug/);
  assert.match(nonzero.reason, /exit=1/);
  assert.match(nonzero.reason, /timedOut=false/);
  assert.match(nonzero.reason, /gradle-line-100/);
  assert.doesNotMatch(nonzero.reason, /gradle-line-1(?:\D|$)/);
  assert.ok(nonzero.reason.length <= 64 * 1024 + 1_024);

  const timeoutFixture = await createProducerFixture(t, { kind: "build-timeout" });
  const timedOut = await produceNativeFleetReceipt(timeoutFixture.input, timeoutFixture.deps);
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.reason, /exit=null/);
  assert.match(timedOut.reason, /timedOut=true/);
});
