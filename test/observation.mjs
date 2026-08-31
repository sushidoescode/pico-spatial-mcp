import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureSettledFrames,
  executeCaptureSettled,
  SETTLE_COMPARISON,
  sha256Bytes,
} from "../dist/observation.js";
import { keyHold, selectQemuWindowBinding } from "../dist/cameradrive.js";
import { resolveGrpcEndpointBinding } from "../dist/grpc.js";

const frame = (value, capturedAt = "2026-08-28T12:00:00.000Z") => ({
  bytes: Buffer.from(value),
  capturedAt,
  width: 2160,
  height: 2158,
});

function settleDeps(sequence) {
  const sleeps = [];
  let index = 0;
  return {
    sleeps,
    deps: {
      capture: async () => {
        const next = sequence[index++];
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async (ms) => { sleeps.push(ms); },
      hash: sha256Bytes,
    },
  };
}

test("captureSettledFrames succeeds on the first identical pair", async () => {
  const a = frame("same");
  const fake = settleDeps([a, frame("same")]);
  const result = await captureSettledFrames({ maxTries: 12, intervalMs: 700, comparison: SETTLE_COMPARISON }, fake.deps);
  assert.equal(result.status, "settled");
  assert.equal(result.attempts, 2);
  assert.equal(result.settlementSatisfied, true);
  assert.deepEqual(result.stablePair, [sha256Bytes(a.bytes), sha256Bytes(a.bytes)]);
  assert.deepEqual(fake.sleeps, [700]);
});

test("captureSettledFrames waits through changed frames and stops at a delayed identical pair", async () => {
  const fake = settleDeps([frame("a"), frame("b"), frame("b")]);
  const result = await captureSettledFrames({ maxTries: 8, intervalMs: 11, comparison: SETTLE_COMPARISON }, fake.deps);
  assert.equal(result.status, "settled");
  assert.equal(result.attempts, 3);
  assert.deepEqual(fake.sleeps, [11, 11]);
});

test("captureSettledFrames timeout retains the last valid frame without a stable pair", async () => {
  const fake = settleDeps([frame("a"), frame("b"), frame("c")]);
  const result = await captureSettledFrames({ maxTries: 3, intervalMs: 9, comparison: SETTLE_COMPARISON }, fake.deps);
  assert.equal(result.status, "timeout");
  assert.equal(result.settlementSatisfied, false);
  assert.equal(result.sha256, sha256Bytes(Buffer.from("c")));
  assert.equal(result.frame.bytes.toString(), "c");
  assert.equal(result.stablePair, null);
  assert.deepEqual(fake.sleeps, [9, 9], "the primitive must not sleep after the last attempt");
});

test("captureSettledFrames capture failure retains an earlier valid frame", async () => {
  const fake = settleDeps([frame("last-valid"), new Error("fake screencap failed")]);
  const result = await captureSettledFrames({ maxTries: 4, intervalMs: 5, comparison: SETTLE_COMPARISON }, fake.deps);
  assert.equal(result.status, "capture_failed");
  assert.equal(result.attempts, 2);
  assert.equal(result.frame.bytes.toString(), "last-valid");
  assert.match(result.detail, /fake screencap failed/);
});

function executionDeps({
  sequence = [frame("stable"), frame("stable")],
  online = ["emulator-5554"],
  identity = {},
  identities,
  onCapture,
  writeFrame,
} = {}) {
  let monotonic = 1000n;
  let index = 0;
  let identityIndex = 0;
  return {
    monotonicNs: () => ++monotonic,
    listOnlineSerials: async () => online,
    probeIdentity: async (serial) => ({
      serial,
      model: "PICO Emulator",
      fingerprint: "pico/emulator/emulator:6/test:userdebug/dev-keys",
      bootQemu: "1",
      bootId: "12345678-1234-4234-8234-123456789abc",
      observedAt: "2026-08-28T12:00:00.000Z",
      ...identity,
      ...(identities?.[Math.min(identityIndex++, identities.length - 1)] ?? {}),
    }),
    capture: async () => {
      onCapture?.();
      const next = sequence[index++];
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async () => {},
    hash: sha256Bytes,
    writeFrame: writeFrame ?? ((target, bytes) => fs.writeFileSync(target, bytes)),
  };
}

test("executeCaptureSettled returns every settled contract field and external capture provenance", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-test-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const outPath = path.join(scratch, "settled.png");
  const { receipt } = await executeCaptureSettled(
    { serial: "emulator-5554", outPath, maxTries: 12, intervalMs: 700, comparison: SETTLE_COMPARISON },
    executionDeps(),
  );
  assert.equal(receipt.status, "settled");
  assert.equal(receipt.path, fs.realpathSync(outPath));
  assert.equal(receipt.sha256, sha256Bytes(Buffer.from("stable")));
  assert.equal(receipt.captureRef.sha256, receipt.sha256);
  assert.deepEqual(receipt.captureRef.dimensions, { width: 2160, height: 2158 });
  assert.equal(receipt.captureRuntimeBinding.serial, "emulator-5554");
  assert.equal(receipt.captureRuntimeBinding.captureSource, "adb-exec-out-screencap");
  assert.equal(receipt.evidenceCeiling, "structural");
  assert.equal(receipt.lookRequired, true);
  assert.deepEqual(receipt.actionReceipts, []);
  assert.equal(receipt.error, null);
});

test("executeCaptureSettled timeout persists and returns only the last valid frame", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-timeout-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const outPath = path.join(scratch, "timeout.png");
  const { receipt, frame: returned } = await executeCaptureSettled(
    { serial: "emulator-5554", outPath, maxTries: 3, intervalMs: 1, comparison: SETTLE_COMPARISON },
    executionDeps({ sequence: [frame("one"), frame("two"), frame("three")] }),
  );
  assert.equal(receipt.status, "timeout");
  assert.equal(receipt.settlementSatisfied, false);
  assert.equal(receipt.stablePair, null);
  assert.equal(receipt.sha256, sha256Bytes(Buffer.from("three")));
  assert.equal(receipt.lastValidCaptureRef.sha256, receipt.sha256);
  assert.equal(fs.readFileSync(outPath).toString(), "three");
  assert.equal(returned.toString(), "three");
  assert.equal(receipt.error.code, "settle_timeout");
});

test("executeCaptureSettled reports a first-attempt capture failure without inventing an artifact", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-first-failure-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const outPath = path.join(scratch, "absent.png");
  const { receipt, frame: returned } = await executeCaptureSettled(
    { serial: "emulator-5554", outPath, maxTries: 3, intervalMs: 1, comparison: SETTLE_COMPARISON },
    executionDeps({ sequence: [new Error("first capture failed")] }),
  );
  assert.equal(receipt.status, "capture_failed");
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.captureRef, null);
  assert.equal(receipt.lastValidCaptureRef, null);
  assert.equal(returned, null);
  assert.equal(fs.existsSync(outPath), false);
});

test("executeCaptureSettled atomically replaces a symlink without following its target", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-symlink-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const sentinel = path.join(scratch, "sentinel.bin");
  const outPath = path.join(scratch, "capture.png");
  fs.writeFileSync(sentinel, "do-not-touch");
  fs.symlinkSync(sentinel, outPath);
  const { receipt } = await executeCaptureSettled(
    { serial: "emulator-5554", outPath, maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON },
    executionDeps(),
  );
  assert.equal(receipt.status, "settled");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "do-not-touch");
  assert.equal(fs.lstatSync(outPath).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(outPath, "utf8"), "stable");
});

test("executeCaptureSettled atomically replaces a hard link without truncating its inode", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-hardlink-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const sentinel = path.join(scratch, "sentinel.bin");
  const outPath = path.join(scratch, "capture.png");
  fs.writeFileSync(sentinel, "do-not-touch");
  fs.linkSync(sentinel, outPath);
  const { receipt } = await executeCaptureSettled(
    { serial: "emulator-5554", outPath, maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON },
    executionDeps(),
  );
  assert.equal(receipt.status, "settled");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "do-not-touch");
  assert.equal(fs.readFileSync(outPath, "utf8"), "stable");
  assert.notEqual(fs.statSync(sentinel).ino, fs.statSync(outPath).ino);
});

test("executeCaptureSettled refuses a writer whose staged bytes do not match the capture", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-integrity-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const outPath = path.join(scratch, "capture.png");
  const { receipt } = await executeCaptureSettled(
    { serial: "emulator-5554", outPath, maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON },
    executionDeps({ writeFrame: (target) => fs.writeFileSync(target, "wrong-bytes") }),
  );
  assert.equal(receipt.status, "capture_failed");
  assert.equal(receipt.error.code, "artifact_write_failed");
  assert.match(receipt.error.detail, /do not match/);
  assert.equal(fs.existsSync(outPath), false);
});

test("executeCaptureSettled fails closed when live identity changes across the capture", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-reboot-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const outPath = path.join(scratch, "last-valid.png");
  const { receipt } = await executeCaptureSettled(
    { serial: "emulator-5554", outPath, maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON },
    executionDeps({ identities: [{}, { bootId: "87654321-4321-4321-8321-cba987654321" }] }),
  );
  assert.equal(receipt.status, "capture_failed");
  assert.equal(receipt.error.code, "binding_failed");
  assert.match(receipt.error.detail, /changed during capture/);
  assert.equal(receipt.captureRef.sha256, sha256Bytes(Buffer.from("stable")));
  assert.equal(receipt.lastValidCaptureRef.sha256, receipt.captureRef.sha256);
});

test("executeCaptureSettled refuses an unbound serial before any capture", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-refusal-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  let captures = 0;
  const { receipt } = await executeCaptureSettled(
    { serial: "emulator-5556", outPath: path.join(scratch, "no.png"), maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON },
    executionDeps({ online: ["emulator-5554", "2G0YC5ZF7Z056Q"], onCapture: () => captures++ }),
  );
  assert.equal(receipt.status, "capture_failed");
  assert.equal(receipt.error.code, "binding_failed");
  assert.match(receipt.error.detail, /refusing to guess/);
  assert.equal(receipt.attempts, 0);
  assert.equal(captures, 0);
});

test("executeCaptureSettled refuses UNVERIFIED byte-exact hardware settlement", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-hardware-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  let captures = 0;
  const serial = "2G0YC5ZF7Z056Q";
  const { receipt } = await executeCaptureSettled(
    { serial, outPath: path.join(scratch, "hardware.png"), maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON },
    executionDeps({
      online: [serial],
      identity: { model: "PICO 4", fingerprint: "pico/PICO/PICO:6/test:user/release-keys", bootQemu: "" },
      onCapture: () => captures++,
    }),
  );
  assert.equal(receipt.status, "capture_failed");
  assert.equal(receipt.error.code, "comparison_policy_unverified");
  assert.match(receipt.error.detail, /UNVERIFIED/);
  assert.equal(receipt.captureRuntimeBinding.serial, serial);
  assert.equal(captures, 0);
});

const discovery = (serial, port, token, pid = 93013, suffix = "a") => ({
  file: `/tmp/discovery/pid_${pid}_${suffix}.ini`,
  pid,
  serial,
  entries: {
    "port.serial": serial.replace("emulator-", ""),
    "grpc.port": String(port),
    ...(token === undefined ? {} : { "grpc.token": token }),
  },
});

test("gRPC endpoint binding is exact and retains only token presence plus fingerprint", () => {
  const token = "secret-never-returned";
  const result = resolveGrpcEndpointBinding([
    discovery("emulator-5554", 8554, token, 93013, "one"),
    discovery("emulator-5556", 8556, "other", 93014, "two"),
  ], "emulator-5554");
  assert.equal(result.discoveredSerial, "emulator-5554");
  assert.equal(result.address, "127.0.0.1:8554");
  assert.equal(result.tokenPresent, true);
  assert.equal(result.tokenFingerprint, sha256Bytes(Buffer.from(token)));
  assert.doesNotMatch(JSON.stringify(result), /secret-never-returned/);
});

test("gRPC endpoint binding accepts a token-absent discovered endpoint", () => {
  const result = resolveGrpcEndpointBinding([discovery("emulator-5554", 8554, undefined)], "emulator-5554");
  assert.equal(result.tokenPresent, false);
  assert.equal(result.tokenFingerprint, null);
});

test("gRPC endpoint binding refuses missing, mismatched, duplicate, and unqualified multi-endpoint discovery", () => {
  const a = discovery("emulator-5554", 8554, "a", 93013, "one");
  const duplicate = discovery("emulator-5554", 9554, "b", 93013, "two");
  const other = discovery("emulator-5556", 8556, "c", 93014, "three");
  assert.match(resolveGrpcEndpointBinding([], "emulator-5554").error, /no matching record/);
  assert.match(resolveGrpcEndpointBinding([other], "emulator-5554").error, /no matching record/);
  assert.match(resolveGrpcEndpointBinding([a, duplicate], "emulator-5554").error, /2 matching records/);
  assert.match(resolveGrpcEndpointBinding([a, other]).error, /multiple emulator gRPC endpoints/);
});

test("gRPC endpoint binding refuses malformed matching discovery instead of discarding it", () => {
  const malformed = discovery("emulator-5554", 70000, "a", 93013, "bad");
  const valid = discovery("emulator-5554", 8554, "a", 93013, "good");
  assert.match(resolveGrpcEndpointBinding([malformed], "emulator-5554").error, /malformed serial or gRPC port/);
  assert.match(resolveGrpcEndpointBinding([valid, malformed], "emulator-5554").error, /refusing to discard contradictory/);
});

test("qemu window binding uses a discovery PID match and the strict single-window fallback", () => {
  const exact = selectQemuWindowBinding(
    "emulator-5554",
    ["emulator-5554", "emulator-5556", "2G0YC5ZF7Z056Q"],
    [discovery("emulator-5554", 8554, "a", 93013), discovery("emulator-5556", 8556, "b", 93014)],
    [{ windowId: 7, ownerPid: 93013, area: 900 }, { windowId: 8, ownerPid: 93014, area: 800 }],
  );
  assert.equal(exact.ok, true);
  assert.equal(exact.binding.qemuWindowId, 7);
  assert.equal(exact.binding.bindingMethod, "discovery-pid-window");

  const fallback = selectQemuWindowBinding(
    "emulator-5554",
    ["emulator-5554", "2G0YC5ZF7Z056Q"],
    [discovery("emulator-5554", 8554, undefined, null)],
    [{ windowId: 9, ownerPid: 12345, area: 700 }],
  );
  assert.equal(fallback.ok, true);
  assert.equal(fallback.binding.bindingMethod, "single-online-serial-plus-matching-discovery-plus-single-window");
  assert.equal(fallback.binding.qemuPid, null, "the discovery PID must remain faithful to discovery");
  assert.equal(fallback.binding.qemuWindowOwnerPid, 12345, "fallback focus/drag uses the sole bound window owner PID");
});

test("qemu window binding refuses ambiguous windows and a headless second emulator fallback", () => {
  const record = discovery("emulator-5554", 8554, undefined, null);
  const twoWindows = selectQemuWindowBinding(
    "emulator-5554",
    ["emulator-5554"],
    [record],
    [{ windowId: 1, ownerPid: 10, area: 1 }, { windowId: 2, ownerPid: 11, area: 1 }],
  );
  assert.equal(twoWindows.ok, false);
  assert.equal(twoWindows.code, "ambiguous_host_window");
  const secondEmulator = selectQemuWindowBinding(
    "emulator-5554",
    ["emulator-5554", "emulator-5556"],
    [record],
    [{ windowId: 1, ownerPid: 10, area: 1 }],
  );
  assert.equal(secondEmulator.ok, false);
  assert.equal(secondEmulator.code, "ambiguous_host_window");
});

const fakeConnection = (serial, id) => ({
  client: { id },
  metadata: {},
  serial,
  binding: {
    discoveryFile: `/tmp/${id}.ini`, discoveredSerial: serial, qemuPid: 93013,
    address: "127.0.0.1:8554", tokenPresent: false, tokenFingerprint: null,
  },
});

test("keyHold re-reads discovery with the exact serial before input when initial discovery fails", async () => {
  const clientCalls = [];
  const events = [];
  let clients = 0;
  const receipt = await keyHold("emulator-5554", "w", 100, {
    getClient: (_version, serial) => {
      clientCalls.push(serial);
      clients++;
      return clients === 1 ? { error: "discovery temporarily unavailable" } : fakeConnection(serial, "stable");
    },
    unary: async (client, _method, request) => {
      events.push([client.id, request.eventType]);
    },
    sleep: async () => {},
    monotonicNs: (() => { let n = 0n; return () => ++n; })(),
  });
  assert.equal(receipt.status, "applied");
  assert.deepEqual(clientCalls, ["emulator-5554", "emulator-5554"]);
  assert.deepEqual(events, [["stable", "keydown"], ["stable", "keyup"]]);
  assert.equal(receipt.ack.releaseCertain, true);
});

test("keyHold reports the bounded no-input diagnostic when initial discovery and reconnect both fail", async () => {
  const clientCalls = [];
  let unaryCalls = 0;
  const receipt = await keyHold("emulator-5554", "w", 100, {
    getClient: (_version, serial) => {
      clientCalls.push(serial);
      return { error: "discovery unavailable" };
    },
    unary: async () => { unaryCalls++; throw new Error("must not send input"); },
    sleep: async () => {},
    monotonicNs: (() => { let n = 0n; return () => ++n; })(),
  });
  assert.equal(receipt.status, "failed");
  assert.deepEqual(clientCalls, ["emulator-5554", "emulator-5554"]);
  assert.equal(unaryCalls, 0);
  assert.equal(receipt.ack.connectionAttempts, 2);
  assert.equal(receipt.ack.keydownAttempted, false);
  assert.equal(receipt.ack.keydownAcknowledged, false);
  assert.equal(receipt.ack.applicationUncertain, false);
  assert.equal(receipt.ack.keyupAcknowledged, false);
  assert.equal(receipt.ack.releaseCertain, true);
  assert.equal("grpc" in receipt.ack, false);
});

test("keyHold never replays keydown after an ambiguous transport failure", async () => {
  const events = [];
  const receipt = await keyHold("emulator-5554", "w", 100, {
    getClient: (_version, serial) => fakeConnection(serial, "stable"),
    unary: async (_client, _method, request) => {
      events.push(request.eventType);
      if (request.eventType === "keydown") throw new Error("UNAVAILABLE after dispatch");
    },
    sleep: async () => {},
    monotonicNs: (() => { let n = 0n; return () => ++n; })(),
  });
  assert.equal(receipt.status, "failed");
  assert.deepEqual(events, ["keydown", "keyup"]);
  assert.equal(receipt.ack.applicationUncertain, true);
  assert.equal(receipt.ack.releaseCertain, true);
});

test("keyHold retries only keyup when the exact discovery binding is unchanged", async () => {
  const events = [];
  let keyups = 0;
  let clients = 0;
  const receipt = await keyHold("emulator-5554", "d", 50, {
    getClient: (_version, serial) => ({ ...fakeConnection(serial, "same"), client: { id: ++clients } }),
    unary: async (client, _method, request) => {
      events.push([client.id, request.eventType]);
      if (request.eventType === "keyup" && ++keyups === 1) throw new Error("release channel unavailable");
    },
    sleep: async () => {},
    monotonicNs: (() => { let n = 0n; return () => ++n; })(),
  });
  assert.equal(receipt.status, "applied");
  assert.deepEqual(events, [[1, "keydown"], [1, "keyup"], [2, "keyup"]]);
  assert.equal(receipt.ack.releaseRecoveredAfterReconnect, true);
  assert.equal(receipt.ack.releaseReconnectBindingMatched, true);
});

test("keyHold reports uncertain release and never repeats an accepted keydown", async () => {
  const events = [];
  let clients = 0;
  const receipt = await keyHold("emulator-5554", "a", 50, {
    getClient: (_version, serial) => fakeConnection(serial, ++clients),
    unary: async (_client, _method, request) => {
      events.push(request.eventType);
      if (request.eventType === "keyup") throw new Error("release channel unavailable");
    },
    sleep: async () => {},
    monotonicNs: (() => { let n = 0n; return () => ++n; })(),
  });
  assert.equal(receipt.status, "release_uncertain");
  assert.equal(events.filter((event) => event === "keydown").length, 1);
  assert.equal(receipt.ack.releaseCertain, false);
  assert.equal(receipt.ack.releaseReconnectBindingMatched, false);
});

test("frontmostQemu refuses a successful focus request when fresh frontmost-PID readback disagrees", { skip: process.platform !== "darwin" }, () => {
  const utilUrl = new URL("../dist/util.js", import.meta.url).href;
  const cameradriveUrl = new URL("../dist/cameradrive.js", import.meta.url).href;
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mock } from "node:test";

    const calls = [];
    let responses = [];
    const nextRun = async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      const response = responses.shift();
      assert.ok(response, "unexpected command execution");
      return response;
    };
    mock.module(${JSON.stringify(utilUrl)}, {
      namedExports: {
        run: nextRun,
        runBinary: async () => { throw new Error("unexpected binary command execution"); },
        expandHome: (value) => value,
        sleep: async () => {},
        tail: (value) => value,
        ok: (text) => ({ content: [{ type: "text", text }] }),
        okJson: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
        okJsonStructured: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }),
        fail: (text) => ({ content: [{ type: "text", text }], isError: true }),
        image: (data, mimeType) => ({ content: [{ type: "image", data, mimeType }] }),
      },
    });
    const { frontmostQemu } = await import(${JSON.stringify(cameradriveUrl)});
    const binding = {
      discoveryFile: "/tmp/pico-emulator/pid_93013.ini",
      discoveredSerial: "emulator-5554",
      qemuPid: 93013,
      address: "127.0.0.1:8554",
      tokenPresent: true,
      tokenFingerprint: "a".repeat(64),
      onlineEmulatorSerials: ["emulator-5554"],
      qemuWindowOwnerPid: 93013,
      qemuWindowId: 7,
      bindingMethod: "discovery-pid-window",
    };
    const success = { code: 0, stdout: "", stderr: "", timedOut: false };

    responses = [success, { code: 0, stdout: "416\n", stderr: "", timedOut: false }];
    assert.equal(
      await frontmostQemu(binding),
      "frontmost PID readback mismatch: expected 93013, observed 416",
    );

    responses = [success, { code: 0, stdout: "not-a-pid\n", stderr: "", timedOut: false }];
    assert.equal(
      await frontmostQemu(binding),
      "frontmost PID readback malformed: expected one positive integer",
    );

    responses = [success, { code: 1, stdout: "", stderr: "permission denied", timedOut: false }];
    assert.equal(
      await frontmostQemu(binding),
      "frontmost PID readback failed: command exited 1",
    );

    responses = [success, { code: 0, stdout: "93013\n", stderr: "", timedOut: false }];
    assert.equal(await frontmostQemu(binding), null);

    responses = [{ code: 1, stdout: "", stderr: "not permitted", timedOut: false }];
    assert.equal(await frontmostQemu(binding), "osascript frontmost failed: not permitted");
    assert.equal(responses.length, 0);
    assert.equal(calls.filter(({ cmd }) => cmd === "osascript").length, 5);
    assert.equal(calls.filter(({ cmd }) => cmd === "swift").length, 4);
  `;
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
});

test("frontmostQemu returns null without command execution off Darwin", { skip: process.platform === "darwin" }, () => {
  const utilUrl = new URL("../dist/util.js", import.meta.url).href;
  const cameradriveUrl = new URL("../dist/cameradrive.js", import.meta.url).href;
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mock } from "node:test";

    const calls = [];
    mock.module(${JSON.stringify(utilUrl)}, {
      namedExports: {
        run: async (...args) => {
          calls.push(args);
          throw new Error("frontmostQemu must not execute commands off Darwin");
        },
        runBinary: async () => { throw new Error("unexpected binary command execution"); },
        expandHome: (value) => value,
        sleep: async () => {},
        tail: (value) => value,
        ok: (text) => ({ content: [{ type: "text", text }] }),
        okJson: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
        okJsonStructured: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }),
        fail: (text) => ({ content: [{ type: "text", text }], isError: true }),
        image: (data, mimeType) => ({ content: [{ type: "image", data, mimeType }] }),
      },
    });
    const { frontmostQemu } = await import(${JSON.stringify(cameradriveUrl)});
    const result = await frontmostQemu({
      discoveryFile: "/tmp/pico-emulator/pid_93013.ini",
      discoveredSerial: "emulator-5554",
      qemuPid: 93013,
      address: "127.0.0.1:8554",
      tokenPresent: true,
      tokenFingerprint: "a".repeat(64),
      onlineEmulatorSerials: ["emulator-5554"],
      qemuWindowOwnerPid: 93013,
      qemuWindowId: 7,
      bindingMethod: "discovery-pid-window",
    });
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  `;
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
});
