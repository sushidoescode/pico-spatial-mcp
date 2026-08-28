import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as emulator from "../dist/emulator.js";

const emulatorModuleUrl = new URL("../dist/emulator.js", import.meta.url).href;

function executable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, "utf8");
  fs.chmodSync(file, 0o755);
}

function runBootFixture(t, {
  launcherExit = 0,
  launcherSignal,
  deviceAppears = true,
  bootTimeoutSec = 10,
  staleDiscovery = false,
} = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-emulator-boot-test-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const home = path.join(scratch, "home");
  const toolsRoot = path.join(scratch, "sdk");
  const emulatorBin = path.join(toolsRoot, "6.0", "emulator", "emulator");
  const fakeBin = path.join(scratch, "bin");
  const fakeAdb = path.join(fakeBin, "adb");
  const marker = path.join(scratch, "device-online");
  const envLog = path.join(scratch, "child-env.txt");
  const discoveryDir = path.join(home, "Library/Caches/TemporaryItems/avd/pico_running");
  const avdHome = path.join(home, ".pico/avd");
  fs.mkdirSync(avdHome, { recursive: true });
  fs.writeFileSync(path.join(avdHome, "PICO_6.ini"), "path=fixture\n", "utf8");
  if (staleDiscovery) {
    fs.mkdirSync(discoveryDir, { recursive: true });
    fs.writeFileSync(path.join(discoveryDir, "pid_93013.ini"), "port.serial=5556\ngrpc.token=stale-token\n", "utf8");
  }

  executable(fakeAdb, `
if [[ "$*" == "devices" ]]; then
  printf 'List of devices attached\\n'
  if [[ -f "$PICO_TEST_DEVICE_MARKER" ]]; then printf 'emulator-5554\\tdevice\\n'; fi
  exit 0
fi
if [[ "$*" == "-s emulator-5554 shell getprop sys.boot_completed" ]]; then
  printf '1\\n'
  exit 0
fi
printf 'unexpected fake adb argv: %s\\n' "$*" >&2
exit 98`);
  executable(emulatorBin, `
printf '%s\\n%s\\n%s\\n' "\${ANDROID_AVD_HOME:-}" "\${ANDROID_HOME:-}" "\${ANDROID_SDK_ROOT:-}" > "$PICO_TEST_ENV_LOG"
if [[ -n "$PICO_TEST_LAUNCHER_SIGNAL" ]]; then kill "-$PICO_TEST_LAUNCHER_SIGNAL" "$$"; fi
if [[ "$PICO_TEST_LAUNCHER_EXIT" != "0" ]]; then exit "$PICO_TEST_LAUNCHER_EXIT"; fi
mkdir -p "$PICO_TEST_DISCOVERY_DIR"
printf 'port.serial=5554\\ngrpc.port=8554\\ngrpc.token=fixture-token\\n' > "$PICO_TEST_DISCOVERY_DIR/pid_93013.ini"
if [[ "$PICO_TEST_DEVICE_APPEARS" == "1" ]]; then : > "$PICO_TEST_DEVICE_MARKER"; fi
exit 0`);

  const program = `
    import { registerEmulatorTools } from ${JSON.stringify(emulatorModuleUrl)};
    const handlers = {};
    registerEmulatorTools({ registerTool(name, _metadata, handler) { handlers[name] = handler; } });
    const result = await handlers.emulator_boot({
      avd: "PICO_6",
      headless: true,
      wipeData: false,
      snapshot: undefined,
      toolsVersion: "6.0",
      bootTimeoutSec: ${JSON.stringify(bootTimeoutSec)},
      extraArgs: [],
    });
    process.stdout.write(JSON.stringify({
      result,
      serverEnv: {
        ANDROID_HOME: process.env.ANDROID_HOME,
        ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
      },
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: home,
      PICO_HOME: toolsRoot,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      ANDROID_HOME: "/poisoned/server/sdk",
      ANDROID_SDK_ROOT: "/poisoned/server/sdk",
      PICO_TEST_DEVICE_MARKER: marker,
      PICO_TEST_DISCOVERY_DIR: discoveryDir,
      PICO_TEST_DEVICE_APPEARS: deviceAppears ? "1" : "0",
      PICO_TEST_LAUNCHER_EXIT: String(launcherExit),
      PICO_TEST_LAUNCHER_SIGNAL: launcherSignal ?? "",
      PICO_TEST_ENV_LOG: envLog,
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `boot fixture timed out: ${result.stderr}`);
  assert.equal(result.status, 0, `boot fixture failed: ${result.stderr}`);
  return {
    output: JSON.parse(result.stdout),
    childEnv: fs.existsSync(envLog) ? fs.readFileSync(envLog, "utf8").trim().split("\n") : [],
    expectedAvdHome: avdHome,
    expectedSdkRoot: path.join(path.dirname(emulatorBin), "system-images"),
  };
}

test("emulator child env derives Android roots from the selected payload without mutating its parent", () => {
  assert.equal(typeof emulator.buildEmulatorChildEnv, "function");

  const inheritedEnv = {
    PATH: "/fixture/bin",
    ANDROID_HOME: "/host/android-sdk",
    ANDROID_SDK_ROOT: "/host/android-sdk",
  };
  const before = { ...inheritedEnv };

  for (const [emulatorBin, expectedSdkRoot] of [
    ["/Library/PICO/sdk/0.13/emulator/emulator", "/Library/PICO/sdk/0.13/emulator/system-images"],
    ["/Library/PICO/sdk/6.0/emulator/emulator", "/Library/PICO/sdk/6.0/emulator/system-images"],
  ]) {
    const childEnv = emulator.buildEmulatorChildEnv(
      emulatorBin,
      "/fixture/home/.pico/avd",
      inheritedEnv,
    );
    assert.deepEqual(childEnv, {
      PATH: "/fixture/bin",
      ANDROID_AVD_HOME: "/fixture/home/.pico/avd",
      ANDROID_HOME: expectedSdkRoot,
      ANDROID_SDK_ROOT: expectedSdkRoot,
    });
  }

  assert.deepEqual(inheritedEnv, before);
});

test("discovery records expose the qemu PID and adb serial while malformed records fail closed", (t) => {
  assert.equal(typeof emulator.parseEmulatorDiscoveryRecord, "function");

  const valid = emulator.parseEmulatorDiscoveryRecord(
    "/fixture/pico_running/pid_93013.ini",
    "port.serial=5554\r\ngrpc.port=8554\r\ngrpc.token=fixture-token\r\n",
  );
  assert.deepEqual(valid, {
    file: "/fixture/pico_running/pid_93013.ini",
    pid: 93013,
    serial: "emulator-5554",
    entries: {
      "port.serial": "5554",
      "grpc.port": "8554",
      "grpc.token": "fixture-token",
    },
  });

  const malformed = emulator.parseEmulatorDiscoveryRecord(
    "/fixture/pico_running/pid_not-a-pid.ini",
    "missing delimiter\n=missing-key\nport.serial=not-a-port\ngrpc.port=8554\n",
  );
  assert.deepEqual(malformed, {
    file: "/fixture/pico_running/pid_not-a-pid.ini",
    pid: null,
    serial: null,
    entries: {
      "port.serial": "not-a-port",
      "grpc.port": "8554",
    },
  });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-emulator-discovery-test-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  assert.deepEqual(emulator.readDiscovery(path.join(scratch, "missing")), []);
});

test("discovery directory races and non-file ini entries are ignored per record", (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-emulator-discovery-race-test-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.mkdirSync(path.join(scratch, "broken.ini"));
  fs.writeFileSync(path.join(scratch, "pid_24680.ini"), "port.serial=5556\ngrpc.port=8556\n", "utf8");

  assert.deepEqual(emulator.readDiscovery(scratch), [{
    file: path.join(scratch, "pid_24680.ini"),
    pid: 24680,
    serial: "emulator-5556",
    entries: {
      "port.serial": "5556",
      "grpc.port": "8556",
    },
  }]);
});

test("emulator boot defaults cold starts to a 600-second overridable timeout", () => {
  const registrations = new Map();
  emulator.registerEmulatorTools({
    registerTool(name, metadata, handler) {
      registrations.set(name, { metadata, handler });
    },
  });

  const timeoutSchema = registrations.get("emulator_boot")?.metadata.inputSchema.bootTimeoutSec;
  assert.ok(timeoutSchema);
  assert.equal(timeoutSchema.parse(undefined), 600);
  assert.equal(timeoutSchema.parse(37), 37);
});

test("a zero-exit launcher hands off to the discovered qemu process without leaking Android roots", (t) => {
  const fixture = runBootFixture(t);
  assert.equal(fixture.output.result.isError, undefined);
  const payload = JSON.parse(fixture.output.result.content[0].text);
  assert.equal(payload.serial, "emulator-5554");
  assert.equal(payload.pid, 93013);
  assert.equal(payload.qemuPid, 93013);
  assert.equal(typeof payload.launcherPid, "number");
  assert.deepEqual(fixture.childEnv, [fixture.expectedAvdHome, fixture.expectedSdkRoot, fixture.expectedSdkRoot]);
  assert.deepEqual(fixture.output.serverEnv, {
    ANDROID_HOME: "/poisoned/server/sdk",
    ANDROID_SDK_ROOT: "/poisoned/server/sdk",
  });
});

test("a replaced stale discovery pathname is recognized as the new qemu record", (t) => {
  const fixture = runBootFixture(t, { staleDiscovery: true, bootTimeoutSec: 5 });
  assert.equal(fixture.output.result.isError, undefined);
  const payload = JSON.parse(fixture.output.result.content[0].text);
  assert.equal(payload.serial, "emulator-5554");
  assert.equal(payload.qemuPid, 93013);
});

test("a boot timeout reports the qemu PID discovered after launcher handoff", (t) => {
  const fixture = runBootFixture(t, { deviceAppears: false, bootTimeoutSec: 1 });
  assert.equal(fixture.output.result.isError, true);
  assert.match(fixture.output.result.content[0].text, /Timed out after 1s/);
  assert.match(fixture.output.result.content[0].text, /QEMU PID 93013/);
});

test("a nonzero launcher exit remains an immediate boot failure", (t) => {
  const fixture = runBootFixture(t, { launcherExit: 7, deviceAppears: false });
  assert.equal(fixture.output.result.isError, true);
  assert.match(fixture.output.result.content[0].text, /exited early \(code 7\)/);
});

test("a signaled launcher remains an immediate boot failure", (t) => {
  const fixture = runBootFixture(t, { launcherSignal: "TERM", deviceAppears: false });
  assert.equal(fixture.output.result.isError, true);
  assert.match(fixture.output.result.content[0].text, /exited early \(signal SIGTERM\)/);
});
