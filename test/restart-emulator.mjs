import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const restartScript = join(repoRoot, "scripts", "restart-emulator.sh");

function executable(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

function decodeArgv(stdout) {
  assert.ok(stdout.length > 0, "dry-run must print the emulator argv");
  assert.equal(stdout.at(-1), 0, "dry-run argv must end with a NUL delimiter");
  return stdout.subarray(0, -1).toString("utf8").split("\0");
}

function assertFixtureRouting(source) {
  assert.match(
    source,
    /^EMU_ROOT="\$\{PICO_EMU_SDK_ROOT:-\$DEFAULT_EMU_ROOT\}"$/m,
    "safety: executable paths must derive from the isolated SDK root",
  );
  assert.match(source, /^EMU="\$EMU_ROOT\/emulator"$/m);
  assert.match(source, /^ADB="\$EMU_ROOT\/system-images\/platform-tools\/adb"$/m);
  assert.match(
    source,
    /^EMU_LOG_PATH="\$\{PICO_EMU_LOG_PATH:-\/tmp\/pico-emu\.log\}"$/m,
    "safety: emulator log must expose the isolated path override",
  );
  assert.match(
    source,
    /^nohup\s+"\$\{EMU_ARGV\[@\]\}"\s+>\s+"\$EMU_LOG_PATH"\s+2>&1\s+&$/m,
    "safety: lifecycle output must use the isolated emulator log path",
  );
}

function decodeRecordedCalls(path) {
  if (!existsSync(path)) return [];
  const tokens = readFileSync(path).toString("utf8").split("\0");
  assert.equal(tokens.pop(), "", "argv call log must end with a NUL delimiter");
  const calls = [];
  let current = null;
  for (const token of tokens) {
    if (token === "CALL") {
      assert.equal(current, null, "argv call records must not overlap");
      current = [];
    } else if (token === "END") {
      assert.notEqual(current, null, "argv call record must begin with CALL");
      calls.push(current);
      current = null;
    } else {
      assert.notEqual(current, null, "argv tokens must be inside a call record");
      current.push(token);
    }
  }
  assert.equal(current, null, "argv call record must end with END");
  return calls;
}

function waitForPidGone(pid, timeoutMs = 1_000) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    Atomics.wait(sleeper, 0, 0, 20);
  }
  return false;
}

function runDry(cameraBack) {
  const root = mkdtempSync(join(tmpdir(), "pico-restart-test-"));
  const fakeBin = join(root, "bin");
  const callLog = join(root, "lifecycle-calls.log");
  const marker = join(root, "injection-marker");
  const sdkRoot = join(root, "sdk");
  const emulator = join(sdkRoot, "emulator");
  const adb = join(sdkRoot, "system-images/platform-tools/adb");
  const sysdir = join(sdkRoot, "system-images/system-images");

  // These sentinels make an ignored dry-run fail closed before the real script
  // can reach nohup. Every executable target resolves inside this temp fixture.
  const record = (name, status = 0) =>
    `printf '${name}\\n' >> "$PICO_TEST_CALL_LOG"\nexit ${status}`;
  executable(adb, record("adb"));
  executable(emulator, record("emulator", 98));
  executable(join(fakeBin, "pkill"), record("pkill"));
  executable(join(fakeBin, "sleep"), record("sleep", 97));
  executable(join(fakeBin, "nohup"), record("nohup", 98));

  const env = {
    ...process.env,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    PICO_EMU_DRY_RUN: "1",
    PICO_EMU_SDK_ROOT: sdkRoot,
    PICO_TEST_CALL_LOG: callLog,
  };
  delete env.PICO_EMU_CAMERA_BACK;
  const resolvedCameraBack =
    typeof cameraBack === "function" ? cameraBack(marker) : cameraBack;
  if (resolvedCameraBack !== undefined) {
    env.PICO_EMU_CAMERA_BACK = resolvedCameraBack;
  }

  let command = "/bin/bash";
  let args = [restartScript];
  if (process.platform === "darwin") {
    // Defense in depth for the initial RED run: the old script ignores the
    // fixture root, so deny its real absolute SDK executables at the OS layer.
    const realSdkRoot = join(homedir(), "Library/PICO/sdk/0.13/emulator");
    const quote = (value) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const profile = `(version 1)\n(allow default)\n(deny process-exec (literal "${quote(
      join(realSdkRoot, "emulator"),
    )}"))\n(deny process-exec (literal "${quote(
      join(realSdkRoot, "system-images/platform-tools/adb"),
    )}"))`;
    command = "/usr/bin/sandbox-exec";
    args = ["-p", profile, "/bin/bash", restartScript];
  } else {
    // Without a host process sandbox, refuse to exercise an old script that
    // has no fixture-root contract. This is a harness safety guard, not a
    // product assertion.
    assertFixtureRouting(readFileSync(restartScript, "utf8"));
  }

  const result = spawnSync(command, args, {
    env,
    encoding: null,
    timeout: 5_000,
  });
  const calls = existsSync(callLog) ? readFileSync(callLog, "utf8") : "";

  return {
    result,
    calls,
    marker,
    baseArgv: [
      emulator,
      "-avd",
      "PICO_0.13",
      "-sysdir",
      sysdir,
      "-kernel",
      join(sysdir, "kernel-ranchu"),
      "-gpu",
      "angle_indirect",
      "-no-snapshot-load",
    ],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function assertSuccessfulDryRun(run) {
  assert.equal(
    run.result.status,
    0,
    `dry-run must exit successfully; stderr=${run.result.stderr.toString("utf8")}`,
  );
  assert.equal(run.result.signal, null, "dry-run must not time out");
  assert.equal(
    run.calls,
    "",
    `dry-run must not call adb/pkill/sleep/nohup/emulator; called:\n${run.calls}`,
  );
}

function runLifecycle(bootMode, hangMode = "none") {
  const root = mkdtempSync(join(tmpdir(), "pico-restart-lifecycle-test-"));
  const fakeBin = join(root, "bin");
  const sdkRoot = join(root, "sdk");
  const adb = join(sdkRoot, "system-images/platform-tools/adb");
  const emulator = join(sdkRoot, "emulator");
  const adbLog = join(root, "adb-calls.log");
  const bootCountPath = join(root, "boot-count");
  const lifecycleLog = join(root, "lifecycle-calls.log");
  const emulatorLog = join(root, "pico-emu.log");
  const childPidPath = join(root, "descendant-pid");
  const discoveryDir = join(root, "pico-running");
  mkdirSync(discoveryDir, { recursive: true });
  writeFileSync(join(discoveryDir, "pid_987654321.ini"), "port.serial=5554\n", "utf8");
  writeFileSync(join(discoveryDir, "pid_987654322.ini"), "port.serial=5556\n", "utf8");

  // Refuse to execute lifecycle mode until all output is redirected into the
  // fixture. This guard prevents the test from truncating the operator's log.
  assertFixtureRouting(readFileSync(restartScript, "utf8"));

  executable(
    adb,
    `printf 'CALL\\0' >> "$PICO_TEST_ADB_LOG"
printf '%s\\0' "$@" >> "$PICO_TEST_ADB_LOG"
printf 'END\\0' >> "$PICO_TEST_ADB_LOG"
if [[ "$PICO_TEST_ADB_HANG" == "wait" && "$*" == "-s emulator-5554 wait-for-device" ]]; then
  exec /bin/sleep 30
fi
if [[ "$*" == "-s emulator-5554 shell getprop sys.boot_completed" ]]; then
  count=0
  if [[ -f "$PICO_TEST_BOOT_COUNT" ]]; then read -r count < "$PICO_TEST_BOOT_COUNT"; fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$PICO_TEST_BOOT_COUNT"
  if [[ "$PICO_TEST_ADB_HANG" == "first-getprop" && "$count" == "1" ]]; then exec /bin/sleep 30; fi
  if [[ "$PICO_TEST_ADB_HANG" == "first-getprop-after-output" && "$count" == "1" ]]; then
    printf '1\\n'
    exec /bin/sleep 30
  fi
  if [[ "$PICO_TEST_ADB_HANG" == "first-getprop-term-success" && "$count" == "1" ]]; then
    trap 'exit 0' TERM
    printf '1\\n'
    while :; do :; done
  fi
  if [[ "$PICO_TEST_ADB_HANG" == "first-getprop-ignore-term" && "$count" == "1" ]]; then
    trap '' TERM
    printf '1\\n'
    while :; do :; done
  fi
  if [[ "$PICO_TEST_ADB_HANG" == "first-getprop-child-output" && "$count" == "1" ]]; then
    ( /bin/sleep 2; printf '1\\n' ) &
    exit 0
  fi
  if [[ "$PICO_TEST_ADB_HANG" == "first-getprop-child-ignore-term" && "$count" == "1" ]]; then
    /bin/bash -c 'printf "%s\\n" "$$" > "$PICO_TEST_CHILD_PID"; trap "" TERM; /bin/sleep 30; printf "1\\n"' &
    while [[ ! -s "$PICO_TEST_CHILD_PID" ]]; do :; done
    exit 0
  fi
  if [[ "$PICO_TEST_ADB_HANG" == "first-getprop-parent-exit-race" && "$count" == "1" ]]; then
    parent_pid="$BASHPID"
    /bin/bash -c 'while kill -0 "$1" 2>/dev/null; do :; done; printf "1\\n"' _ "$parent_pid" &
    exit 0
  fi
  if [[ "$PICO_TEST_BOOT_MODE" == "ready" ]]; then printf '1\\r\\n'; fi
fi
exit 0`,
  );
  executable(emulator, `printf 'emulator %s\\n' "$*" >> "$PICO_TEST_LIFECYCLE_LOG"`);
  executable(
    join(fakeBin, "pkill"),
    `printf 'pkill %s\\n' "$*" >> "$PICO_TEST_LIFECYCLE_LOG"`,
  );
  executable(
    join(fakeBin, "ps"),
    `printf 'ps %s\\n' "$*" >> "$PICO_TEST_LIFECYCLE_LOG"
if [[ "$*" == "-p 987654321 -o command=" ]]; then
  printf '/fixture/qemu-system-aarch64 -avd PICO_0.13\\n'
fi`,
  );
  executable(
    join(fakeBin, "kill"),
    `printf 'kill %s\\n' "$*" >> "$PICO_TEST_LIFECYCLE_LOG"`,
  );
  executable(
    join(fakeBin, "sleep"),
    `printf 'sleep %s\\n' "$*" >> "$PICO_TEST_LIFECYCLE_LOG"`,
  );
  executable(
    join(fakeBin, "nohup"),
    `printf 'nohup %s\\n' "$*" >> "$PICO_TEST_LIFECYCLE_LOG"`,
  );

  const env = {
    ...process.env,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    PICO_EMU_LOG_PATH: emulatorLog,
    PICO_EMU_SDK_ROOT: sdkRoot,
    PICO_EMU_WAIT_TIMEOUT_SEC: "1",
    PICO_EMU_ADB_TIMEOUT_SEC: "1",
    PICO_EMU_DISCOVERY_DIR: discoveryDir,
    PICO_EMU_KILL_BIN: join(fakeBin, "kill"),
    PICO_TEST_ADB_LOG: adbLog,
    PICO_TEST_ADB_HANG: hangMode,
    PICO_TEST_BOOT_COUNT: bootCountPath,
    PICO_TEST_BOOT_MODE: bootMode,
    PICO_TEST_CHILD_PID: childPidPath,
    PICO_TEST_LIFECYCLE_LOG: lifecycleLog,
  };
  delete env.PICO_EMU_CAMERA_BACK;
  delete env.PICO_EMU_DRY_RUN;

  const result = spawnSync("/bin/bash", [restartScript], {
    env,
    encoding: "utf8",
    timeout: 5_000,
  });
  const adbCalls = decodeRecordedCalls(adbLog);
  const bootCount = existsSync(bootCountPath)
    ? Number.parseInt(readFileSync(bootCountPath, "utf8"), 10)
    : 0;
  const lifecycleCalls = existsSync(lifecycleLog)
    ? readFileSync(lifecycleLog, "utf8")
    : "";
  const childPid = existsSync(childPidPath)
    ? Number.parseInt(readFileSync(childPidPath, "utf8"), 10)
    : null;

  return {
    result,
    adbCalls,
    bootCount,
    childPid,
    lifecycleCalls,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("dry-run preserves the default emulator argv and performs no lifecycle work", () => {
  const run = runDry(undefined);
  try {
    assertSuccessfulDryRun(run);
    assert.deepEqual(decodeArgv(run.result.stdout), run.baseArgv);
  } finally {
    run.cleanup();
  }
});

test("an empty camera-back value is the unchanged default", () => {
  const run = runDry("");
  try {
    assertSuccessfulDryRun(run);
    assert.deepEqual(decodeArgv(run.result.stdout), run.baseArgv);
  } finally {
    run.cleanup();
  }
});

test("webcam0 appends exactly two argv elements", () => {
  const run = runDry("webcam0");
  try {
    assertSuccessfulDryRun(run);
    assert.deepEqual(decodeArgv(run.result.stdout), [
      ...run.baseArgv,
      "-camera-back",
      "webcam0",
    ]);
  } finally {
    run.cleanup();
  }
});

test("every supported backend changes only the final camera-back pair", () => {
  for (const backend of [
    "emulated",
    "webcam1",
    "webcam12",
    "virtualscene",
    "videoplayback",
    "none",
  ]) {
    const run = runDry(backend);
    try {
      assertSuccessfulDryRun(run);
      assert.deepEqual(decodeArgv(run.result.stdout), [
        ...run.baseArgv,
        "-camera-back",
        backend,
      ]);
    } finally {
      run.cleanup();
    }
  }
});

test("unsafe or unsupported camera-back values fail before lifecycle work", () => {
  for (const [label, backend] of [
    ["unsupported backend", "rear"],
    ["shell metacharacters", (marker) => `webcam0; touch ${marker}`],
    ["embedded whitespace", "webcam 0"],
  ]) {
    const run = runDry(backend);
    try {
      assert.notEqual(run.result.status, 0, `${label} must be rejected`);
      assert.match(
        run.result.stderr.toString("utf8"),
        /invalid PICO_EMU_CAMERA_BACK/i,
        `${label} must report the invalid variable`,
      );
      assert.equal(run.calls, "", `${label} must fail before lifecycle commands`);
      assert.equal(existsSync(run.marker), false, `${label} must never be evaluated`);
    } finally {
      run.cleanup();
    }
  }
});

test("wait-for-device is scoped explicitly to emulator-5554", () => {
  const run = runLifecycle("ready");
  try {
    assert.equal(
      run.result.status,
      0,
      `ready fake must complete; stderr=${run.result.stderr}`,
    );
    assert.equal(run.result.signal, null, "fake lifecycle must not time out");
    assert.deepEqual(run.adbCalls.at(0), ["-s", "emulator-5554", "emu", "kill"]);
    assert.deepEqual(
      run.adbCalls.filter((call) => call.at(-1) === "wait-for-device"),
      [["-s", "emulator-5554", "wait-for-device"]],
    );
    assert.equal(run.bootCount, 1);
    assert.match(run.result.stdout, /boot_completed=1 — emulator ready/);
  } finally {
    run.cleanup();
  }
});

test("fallback termination resolves only the emulator-5554 discovery record", () => {
  const run = runLifecycle("ready");
  try {
    assert.equal(run.result.status, 0, `ready fake must complete; stderr=${run.result.stderr}`);
    assert.deepEqual(
      run.lifecycleCalls.match(/^ps .*$/gm),
      ["ps -p 987654321 -o command="],
      "only the PID whose discovery record says port.serial=5554 may be inspected",
    );
    assert.doesNotMatch(
      run.lifecycleCalls,
      /^pkill /m,
      "restart must never broadly pkill every PICO_0.13 qemu",
    );
    assert.match(
      run.lifecycleCalls,
      /^kill -TERM 987654321$/m,
      "the validated emulator-5554 qemu PID must be the only fallback kill target",
    );
  } finally {
    run.cleanup();
  }
});

test("forty empty boot polls fail without claiming the emulator is ready", () => {
  const run = runLifecycle("never");
  try {
    assert.notEqual(run.result.status, 0, "boot timeout must exit nonzero");
    assert.equal(run.result.signal, null, "fake lifecycle must not time out");
    assert.equal(run.bootCount, 40, "boot timeout must perform the bounded 40 polls");
    assert.equal(
      run.adbCalls.filter((call) =>
        call.at(-1) === "sys.boot_completed",
      ).length,
      40,
    );
    assert.equal(
      run.result.stderr.trim(),
      "emulator-5554 did not report sys.boot_completed=1 before timeout",
    );
    assert.doesNotMatch(run.result.stdout, /boot_completed=1|emulator ready/i);
  } finally {
    run.cleanup();
  }
});

test("a hung wait-for-device is bounded and fails honestly", () => {
  const run = runLifecycle("ready", "wait");
  try {
    assert.notEqual(run.result.status, 0, "hung wait must exit nonzero");
    assert.equal(run.result.signal, null, "script must enforce its own timeout");
    assert.match(run.result.stderr, /emulator-5554.*(?:appear|wait-for-device|timeout)/i);
    assert.doesNotMatch(run.result.stdout, /boot_completed=1|emulator ready/i);
  } finally {
    run.cleanup();
  }
});

test("a hung getprop poll is bounded and the next poll can observe ready", () => {
  const run = runLifecycle("ready", "first-getprop");
  try {
    assert.equal(run.result.status, 0, `bounded poll should recover; stderr=${run.result.stderr}`);
    assert.equal(run.result.signal, null, "script must enforce its own timeout");
    assert.equal(run.bootCount, 2, "first poll times out; second poll observes boot");
    assert.match(run.result.stdout, /boot_completed=1 — emulator ready/);
  } finally {
    run.cleanup();
  }
});

test("output from a timed-out getprop poll is discarded", () => {
  const run = runLifecycle("ready", "first-getprop-after-output");
  try {
    assert.equal(run.result.status, 0, `bounded poll should recover; stderr=${run.result.stderr}`);
    assert.equal(run.result.signal, null, "script must enforce its own timeout");
    assert.equal(
      run.bootCount,
      2,
      "a timed-out poll must not become ready from its partial output",
    );
    assert.match(run.result.stdout, /boot_completed=1 — emulator ready/);
  } finally {
    run.cleanup();
  }
});

test("a timed-out getprop cannot turn partial output into success by trapping TERM", () => {
  const run = runLifecycle("ready", "first-getprop-term-success");
  try {
    assert.equal(run.result.status, 0, `bounded poll should recover; stderr=${run.result.stderr}`);
    assert.equal(run.result.signal, null, "script must enforce its own timeout");
    assert.equal(
      run.bootCount,
      2,
      "watchdog expiry must override a command that handles TERM and exits zero",
    );
    assert.match(run.result.stdout, /boot_completed=1 — emulator ready/);
  } finally {
    run.cleanup();
  }
});

test("a getprop that ignores TERM is killed within the watchdog bound", () => {
  const run = runLifecycle("ready", "first-getprop-ignore-term");
  try {
    assert.equal(run.result.status, 0, `bounded poll should recover; stderr=${run.result.stderr}`);
    assert.equal(run.result.signal, null, "the harness timeout must not be reached");
    assert.equal(
      run.bootCount,
      2,
      "watchdog expiry must force-stop a TERM-ignoring command before retrying",
    );
    assert.match(run.result.stdout, /boot_completed=1 — emulator ready/);
  } finally {
    run.cleanup();
  }
});

test("a child cannot publish late output after its successful parent exits", () => {
  const run = runLifecycle("ready", "first-getprop-child-output");
  try {
    assert.equal(run.result.status, 0, `bounded poll should recover; stderr=${run.result.stderr}`);
    assert.equal(run.result.signal, null, "the harness timeout must not be reached");
    assert.equal(
      run.bootCount,
      2,
      "the command result must not wait for or accept late descendant output",
    );
    assert.match(run.result.stdout, /boot_completed=1 — emulator ready/);
  } finally {
    run.cleanup();
  }
});

test("a TERM-ignoring child cannot hold the output channel open", () => {
  const run = runLifecycle("ready", "first-getprop-child-ignore-term");
  try {
    assert.equal(run.result.status, 0, `bounded poll should recover; stderr=${run.result.stderr}`);
    assert.equal(run.result.signal, null, "the harness timeout must not be reached");
    assert.equal(run.bootCount, 2, "the child process group must be force-cleaned before retry");
    assert.ok(Number.isSafeInteger(run.childPid), "fixture must expose its descendant PID");
    assert.equal(
      waitForPidGone(run.childPid),
      true,
      `descendant ${run.childPid} must not survive the bounded invocation`,
    );
    assert.match(run.result.stdout, /boot_completed=1 — emulator ready/);
  } finally {
    if (Number.isSafeInteger(run.childPid) && !waitForPidGone(run.childPid, 50)) {
      process.kill(run.childPid, "SIGKILL");
    }
    run.cleanup();
  }
});

test("a child racing parent reaping cannot publish a false ready value", () => {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const run = runLifecycle("ready", "first-getprop-parent-exit-race");
    try {
      assert.equal(run.result.status, 0, `attempt ${attempt} should recover; stderr=${run.result.stderr}`);
      assert.equal(run.result.signal, null, `attempt ${attempt} must stay inside the watchdog`);
      assert.equal(
        run.bootCount,
        2,
        `attempt ${attempt}: output emitted only after the direct parent vanished must be discarded`,
      );
    } finally {
      run.cleanup();
    }
  }
});
