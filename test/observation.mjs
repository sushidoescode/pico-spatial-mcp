import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureSettledFrames,
  executeCaptureSettled,
  executeLiveCaptureSettled,
  SETTLE_COMPARISON,
  SETTLE_MODES,
  sha256Bytes,
} from "../dist/observation.js";
import {
  createBoundCameraActionAdapter,
  focusQemuForActions,
  keyHold,
  selectQemuWindowBinding,
} from "../dist/cameradrive.js";
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
    get captures() { return index; },
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

function timedSettleDeps(sequence, { startMs = 0, captureCostMs = 0, sleepCostMs = 0 } = {}) {
  const captures = [];
  const sleeps = [];
  let index = 0;
  let nowMs = startMs;
  return {
    captures,
    sleeps,
    deps: {
      monotonicNs: () => BigInt(nowMs) * 1_000_000n,
      capture: async (timeoutMs) => {
        captures.push(timeoutMs);
        nowMs += captureCostMs;
        const next = sequence[index++];
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += sleepCostMs ?? ms;
      },
      hash: sha256Bytes,
    },
  };
}

test("captureSettledFrames defaults to stable mode and records its byte-exact trace", async () => {
  // Catches a production mutation that changes the no-prior compatibility default or drops trace evidence.
  const fake = timedSettleDeps([frame("same"), frame("same")]);
  const result = await captureSettledFrames(
    { maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON, deadlineMs: 100, attemptTimeoutMs: 40 },
    fake.deps,
  );
  assert.deepEqual(SETTLE_MODES, ["stable", "transition_then_stable"]);
  assert.equal(result.status, "settled");
  assert.equal(result.mode, "stable");
  assert.equal(result.timeoutPhase, null);
  assert.equal(result.timeoutCause, null);
  assert.deepEqual(result.trace.map((entry) => entry.relation), ["candidate", "stable"]);
  assert.deepEqual(fake.captures, [40, 40]);
});

test("captureSettledFrames rejects explicit transition mode without a prior SHA before capture", async () => {
  // Catches a production mutation that accepts stale prior pixels without an identity to reject them against.
  const fake = timedSettleDeps([frame("must-not-capture")]);
  const result = await captureSettledFrames(
    { maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON, mode: "transition_then_stable", deadlineMs: 100 },
    fake.deps,
  );
  assert.equal(result.status, "capture_failed");
  assert.equal(result.mode, "transition_then_stable");
  assert.match(result.detail, /transition_then_stable.*priorSha256/);
  assert.deepEqual(fake.captures, []);
});

test("captureSettledFrames requires a changed frame followed by its identical successor", async () => {
  // Catches a production mutation that accepts one changed frame as settled.
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const fake = timedSettleDeps([frame("prior"), frame("changed"), frame("changed")]);
  const result = await captureSettledFrames(
    { maxTries: 3, intervalMs: 0, comparison: SETTLE_COMPARISON, priorSha256, deadlineMs: 100 },
    fake.deps,
  );
  assert.equal(result.status, "settled");
  assert.equal(result.mode, "transition_then_stable");
  assert.deepEqual(result.trace.map((entry) => entry.relation), ["prior", "candidate", "stable"]);
  assert.equal(result.attempts, 3);
});

test("captureSettledFrames clears a changed candidate when pixels return to the prior frame", async () => {
  // Catches a production mutation that retains a stale candidate across a return to prior pixels.
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const fake = timedSettleDeps([frame("changed"), frame("prior"), frame("changed"), frame("changed")]);
  const result = await captureSettledFrames(
    { maxTries: 4, intervalMs: 0, comparison: SETTLE_COMPARISON, priorSha256, deadlineMs: 100 },
    fake.deps,
  );
  assert.equal(result.status, "settled");
  assert.equal(result.attempts, 4);
  assert.deepEqual(result.trace.map((entry) => entry.relation), ["candidate", "prior", "candidate", "stable"]);
});

test("captureSettledFrames distinguishes stability exhaustion from transition exhaustion", async () => {
  // Catches a production mutation that conflates the timeout phase after a transition has occurred.
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const fake = timedSettleDeps([frame("prior"), frame("changed")]);
  const result = await captureSettledFrames(
    { maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON, priorSha256, deadlineMs: 100 },
    fake.deps,
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.timeoutPhase, "awaiting_stability");
  assert.equal(result.timeoutCause, "max_tries");
  assert.equal(result.frame.bytes.toString(), "changed");
});

test("captureSettledFrames stops at its monotonic deadline before another capture", async () => {
  // Catches a production mutation that starts capture work after the configured deadline.
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const fake = timedSettleDeps([frame("prior"), frame("must-not-capture")], { sleepCostMs: 10 });
  const result = await captureSettledFrames(
    { maxTries: 3, intervalMs: 99, comparison: SETTLE_COMPARISON, priorSha256, deadlineMs: 10, attemptTimeoutMs: 50 },
    fake.deps,
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.timeoutPhase, "awaiting_transition");
  assert.equal(result.timeoutCause, "deadline");
  assert.deepEqual(fake.captures, [10]);
  assert.deepEqual(fake.sleeps, [10]);
});

test("captureSettledFrames classifies a capture that returns after its deadline as a stability timeout", async () => {
  // Catches a production mutation that accepts an in-flight capture after the shared deadline.
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const fake = timedSettleDeps([frame("changed")], { captureCostMs: 10 });
  const result = await captureSettledFrames(
    { maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON, priorSha256, deadlineMs: 5, attemptTimeoutMs: 5 },
    fake.deps,
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.timeoutPhase, "awaiting_stability");
  assert.equal(result.timeoutCause, "deadline");
  assert.equal(result.frame.bytes.toString(), "changed");
  assert.deepEqual(result.trace.map((entry) => entry.relation), ["candidate"]);
});

test("captureSettledFrames classifies a capture failure after its deadline in the stability phase", async () => {
  // Catches a production mutation that reports an expired in-flight capture rejection as capture_failed.
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  let nowMs = 0;
  let captures = 0;
  const result = await captureSettledFrames(
    { maxTries: 3, intervalMs: 0, comparison: SETTLE_COMPARISON, priorSha256, deadlineMs: 5, attemptTimeoutMs: 5 },
    {
      monotonicNs: () => BigInt(nowMs) * 1_000_000n,
      capture: async () => {
        captures++;
        if (captures === 1) return frame("changed");
        nowMs = 5;
        throw new Error("expired screencap");
      },
      sleep: async () => {},
      hash: sha256Bytes,
    },
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.timeoutPhase, "awaiting_stability");
  assert.equal(result.timeoutCause, "deadline");
  assert.equal(result.frame.bytes.toString(), "changed");
  assert.deepEqual(result.trace.map((entry) => entry.relation), ["candidate"]);
});

test("captureSettledFrames counts a first capture rejection at its deadline without adding a frame trace", async () => {
  // Catches a production mutation that derives timeout attempts from successful trace entries instead of launched captures.
  let nowMs = 0;
  const result = await captureSettledFrames(
    { maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON, deadlineMs: 5, attemptTimeoutMs: 5 },
    {
      monotonicNs: () => BigInt(nowMs) * 1_000_000n,
      capture: async () => {
        nowMs = 5;
        throw new Error("expired first screencap");
      },
      sleep: async () => {},
      hash: sha256Bytes,
    },
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.attempts, 1);
  assert.equal(result.timeoutPhase, "awaiting_stability");
  assert.equal(result.timeoutCause, "deadline");
  assert.equal(result.frame, null);
  assert.deepEqual(result.trace, []);
});

test("captureSettledFrames returns a closed result for a fractional deadline", async () => {
  // Catches a production mutation that calls BigInt on an invalid deadline while constructing validation output.
  const fake = timedSettleDeps([frame("must-not-capture")]);
  const result = await captureSettledFrames(
    { maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON, deadlineMs: 1.5 },
    fake.deps,
  );
  assert.equal(result.status, "capture_failed");
  assert.match(result.detail, /deadlineMs.*positive safe integer/);
  assert.deepEqual(fake.captures, []);
});

test("captureSettledFrames clamps every capture timeout to its remaining deadline", async () => {
  // Catches a production mutation that lets one capture overrun the shared deadline budget.
  const fake = timedSettleDeps([frame("a"), frame("b"), frame("b")], { captureCostMs: 10, sleepCostMs: 5 });
  const result = await captureSettledFrames(
    { maxTries: 3, intervalMs: 5, comparison: SETTLE_COMPARISON, deadlineMs: 50, attemptTimeoutMs: 100 },
    fake.deps,
  );
  assert.equal(result.status, "settled");
  assert.deepEqual(fake.captures, [50, 35, 20]);
  assert.deepEqual(fake.sleeps, [5, 5]);
});

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

test("captureSettledFrames ignores a stable stale pair matching the required prior SHA", async () => {
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const fake = settleDeps([frame("prior"), frame("prior"), frame("moved"), frame("moved")]);
  const result = await captureSettledFrames(
    { maxTries: 4, intervalMs: 11, comparison: SETTLE_COMPARISON, priorSha256 },
    fake.deps,
  );
  assert.equal(result.status, "settled");
  assert.equal(result.attempts, 4);
  assert.equal(result.sha256, "5edd1832df25e2f1a72585c0ee55c1e585e7f4902eb1d15f7abf1c71c1b296ae");
  assert.deepEqual(result.stablePair, [
    "5edd1832df25e2f1a72585c0ee55c1e585e7f4902eb1d15f7abf1c71c1b296ae",
    "5edd1832df25e2f1a72585c0ee55c1e585e7f4902eb1d15f7abf1c71c1b296ae",
  ]);
  assert.deepEqual(fake.sleeps, [11, 11, 11]);
});

test("captureSettledFrames times out and retains the last frame when every stable pair matches the required prior SHA", async () => {
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const fake = settleDeps([frame("prior"), frame("prior"), frame("prior")]);
  const result = await captureSettledFrames(
    { maxTries: 3, intervalMs: 9, comparison: SETTLE_COMPARISON, priorSha256 },
    fake.deps,
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.attempts, 3);
  assert.equal(result.sha256, priorSha256);
  assert.equal(result.frame.bytes.toString(), "prior");
  assert.equal(result.stablePair, null);
  assert.deepEqual(fake.sleeps, [9, 9]);
});

test("captureSettledFrames fails closed before capture for a malformed required prior SHA", async () => {
  const fake = settleDeps([frame("must-not-capture"), frame("must-not-capture")]);
  const result = await captureSettledFrames(
    { maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON, priorSha256: "not-a-sha256" },
    fake.deps,
  );
  assert.equal(result.status, "capture_failed");
  assert.equal(result.attempts, 0);
  assert.equal(result.frame, null);
  assert.equal(result.sha256, null);
  assert.equal(result.stablePair, null);
  assert.match(result.detail, /priorSha256.*64 lowercase hexadecimal/);
  assert.equal(fake.captures, 0);
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
  clock,
  onCapture,
  writeFrame,
} = {}) {
  let monotonic = 1000n;
  let index = 0;
  let identityIndex = 0;
  return {
    monotonicNs: clock ?? (() => ++monotonic),
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
    capture: async (_serial, timeoutMs) => {
      onCapture?.(timeoutMs);
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

test("executeLiveCaptureSettled catches an internal caller that forks the public settled-capture implementation", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-live-wrapper-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const outPath = path.join(scratch, "live-wrapper.png");
  const result = await executeLiveCaptureSettled(
    { serial: "emulator-5554", outPath, maxTries: 2, intervalMs: 0, comparison: SETTLE_COMPARISON },
    { dependencies: executionDeps() },
  );
  assert.equal(result.receipt.status, "settled");
  assert.equal(result.receipt.captureRef.path, fs.realpathSync(outPath));
  assert.equal(result.receipt.sha256, sha256Bytes(Buffer.from("stable")));
  assert.equal(result.frame.toString("utf8"), "stable");
});

test("executeLiveCaptureSettled uses one explicitly injected monotonic clock for its complete runtime and settlement", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-live-clock-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  let nowNs = 10_000n;
  const result = await executeLiveCaptureSettled(
    {
      serial: "emulator-5554",
      outPath: path.join(scratch, "live-clock.png"),
      maxTries: 2,
      intervalMs: 0,
      deadlineMs: 100,
      comparison: SETTLE_COMPARISON,
    },
    {
      dependencies: executionDeps({
        clock: () => { throw new Error("the dependency clock must be replaced by the live clock override"); },
      }),
      monotonicNs: () => ++nowNs,
    },
  );

  assert.equal(result.receipt.status, "settled");
  assert.equal(result.receipt.captureRuntimeBinding.startedAtMonotonicNs, "10001");
  assert.equal(result.receipt.deadlineMonotonicNs, "100010002");
  assert.deepEqual(result.receipt.trace.map((entry) => entry.capturedAtMonotonicNs), ["10004", "10006"]);
  assert.equal(result.receipt.captureRuntimeBinding.endedAtMonotonicNs, "10007");
});

test("executeCaptureSettled threads the required prior SHA into internal settlement", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-prior-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const outPath = path.join(scratch, "moved.png");
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const { receipt } = await executeCaptureSettled(
    {
      serial: "emulator-5554",
      outPath,
      maxTries: 4,
      intervalMs: 0,
      comparison: SETTLE_COMPARISON,
      priorSha256,
    },
    executionDeps({ sequence: [frame("prior"), frame("prior"), frame("moved"), frame("moved")] }),
  );
  assert.equal(receipt.status, "settled");
  assert.equal(receipt.attempts, 4);
  assert.equal(receipt.sha256, "5edd1832df25e2f1a72585c0ee55c1e585e7f4902eb1d15f7abf1c71c1b296ae");
  assert.equal(fs.readFileSync(outPath).toString(), "moved");
});

test("executeCaptureSettled returns transition timeout evidence and the diagnostic last frame", async (t) => {
  // Catches a production mutation that collapses transition exhaustion into the old generic timeout receipt.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-transition-receipt-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const captureTimeouts = [];
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const { receipt } = await executeCaptureSettled(
    {
      serial: "emulator-5554",
      outPath: path.join(scratch, "prior.png"),
      maxTries: 2,
      intervalMs: 0,
      comparison: SETTLE_COMPARISON,
      priorSha256,
      deadlineMs: 100,
      attemptTimeoutMs: 17,
    },
    executionDeps({ sequence: [frame("prior"), frame("prior")], onCapture: (timeoutMs) => captureTimeouts.push(timeoutMs) }),
  );
  assert.equal(receipt.status, "timeout");
  assert.equal(receipt.mode, "transition_then_stable");
  assert.equal(receipt.deadlineMs, 100);
  assert.equal(receipt.attemptTimeoutMs, 17);
  assert.deepEqual(receipt.trace.map((entry) => entry.relation), ["prior", "prior"]);
  assert.equal(receipt.timeoutPhase, "awaiting_transition");
  assert.equal(receipt.timeoutCause, "max_tries");
  assert.equal(receipt.error.code, "transition_timeout");
  assert.equal(receipt.lastValidCaptureRef.sha256, priorSha256);
  assert.equal(receipt.evidenceCeiling, "structural");
  assert.equal(receipt.lookRequired, true);
  assert.deepEqual(captureTimeouts, [17, 17]);
});

test("executeCaptureSettled returns stability timeout evidence after the transition", async (t) => {
  // Catches a production mutation that conflates the stability phase with transition timeout handling.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-stability-receipt-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const { receipt } = await executeCaptureSettled(
    {
      serial: "emulator-5554",
      outPath: path.join(scratch, "changed.png"),
      maxTries: 2,
      intervalMs: 0,
      comparison: SETTLE_COMPARISON,
      mode: "transition_then_stable",
      priorSha256,
      deadlineMs: 100,
      attemptTimeoutMs: 17,
    },
    executionDeps({ sequence: [frame("prior"), frame("changed")] }),
  );
  assert.equal(receipt.status, "timeout");
  assert.equal(receipt.timeoutPhase, "awaiting_stability");
  assert.equal(receipt.timeoutCause, "max_tries");
  assert.equal(receipt.error.code, "stability_timeout");
  assert.equal(receipt.lastValidCaptureRef.sha256, sha256Bytes(Buffer.from("changed")));
});

test("executeCaptureSettled preserves explicit transition validation evidence without a frame", async (t) => {
  // Catches a production mutation that replaces core validation evidence with a stable empty receipt.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-missing-prior-receipt-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const { receipt } = await executeCaptureSettled(
    {
      serial: "emulator-5554",
      outPath: path.join(scratch, "absent.png"),
      maxTries: 2,
      intervalMs: 0,
      comparison: SETTLE_COMPARISON,
      mode: "transition_then_stable",
      deadlineMs: 100,
      attemptTimeoutMs: 17,
    },
    executionDeps(),
  );
  assert.equal(receipt.status, "capture_failed");
  assert.equal(receipt.mode, "transition_then_stable");
  assert.equal(receipt.deadlineMs, 100);
  assert.equal(receipt.attemptTimeoutMs, 17);
  assert.deepEqual(receipt.trace, []);
  assert.equal(receipt.timeoutPhase, null);
  assert.equal(receipt.timeoutCause, null);
  assert.match(receipt.error.detail, /transition_then_stable.*priorSha256/);
});

test("executeCaptureSettled preserves a pre-capture deadline timeout receipt", async (t) => {
  // Catches a production mutation that relabels a no-frame deadline timeout as generic capture_failed.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-pre-capture-deadline-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  let clockCalls = 0;
  const { receipt } = await executeCaptureSettled(
    {
      serial: "emulator-5554",
      outPath: path.join(scratch, "absent.png"),
      maxTries: 2,
      intervalMs: 0,
      comparison: SETTLE_COMPARISON,
      priorSha256,
      deadlineMs: 1,
      attemptTimeoutMs: 1,
    },
    executionDeps({ clock: () => (clockCalls++ < 2 ? 0n : 1_000_000n) }),
  );
  assert.equal(receipt.status, "timeout");
  assert.equal(receipt.mode, "transition_then_stable");
  assert.equal(receipt.deadlineMs, 1);
  assert.equal(receipt.attemptTimeoutMs, 1);
  assert.deepEqual(receipt.trace, []);
  assert.equal(receipt.timeoutPhase, "awaiting_transition");
  assert.equal(receipt.timeoutCause, "deadline");
  assert.equal(receipt.error.code, "transition_timeout");
  assert.equal(receipt.captureRef, null);
});

test("executeCaptureSettled describes an all-prior timeout without denying the observed stable pairs", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-observation-prior-timeout-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const outPath = path.join(scratch, "prior.png");
  const priorSha256 = sha256Bytes(Buffer.from("prior"));
  const { receipt } = await executeCaptureSettled(
    {
      serial: "emulator-5554",
      outPath,
      maxTries: 3,
      intervalMs: 0,
      comparison: SETTLE_COMPARISON,
      priorSha256,
    },
    executionDeps({ sequence: [frame("prior"), frame("prior"), frame("prior")] }),
  );
  assert.equal(receipt.status, "timeout");
  assert.match(receipt.error.detail, /no byte-identical consecutive pair different from the required prior frame/);
  assert.equal(fs.readFileSync(outPath).toString(), "prior");
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

test("host focus is required only for CGEvent look actions, not exact-bound gRPC keys", async () => {
  const binding = {
    discoveryFile: "/tmp/pico_running/pid_93013.ini",
    discoveredSerial: "emulator-5554",
    qemuPid: 93013,
    address: "127.0.0.1:8554",
    tokenPresent: true,
    tokenFingerprint: "a".repeat(64),
    onlineEmulatorSerials: ["emulator-5554"],
    qemuWindowOwnerPid: 93013,
    qemuWindowId: 601,
    bindingMethod: "discovery-pid-window",
  };
  const calls = [];
  const focus = async (received) => {
    calls.push(received);
    return "frontmost PID readback mismatch";
  };

  assert.equal(await focusQemuForActions([
    { kind: "key_hold", key: "w", holdMs: 444 },
    { kind: "key_hold", key: "w", holdMs: 889 },
  ], binding, focus), null);
  assert.deepEqual(calls, []);

  assert.equal(await focusQemuForActions([
    { kind: "key_hold", key: "w", holdMs: 444 },
    { kind: "look_drag", dxPx: 20, dyPx: 0 },
  ], binding, focus), "frontmost PID readback mismatch");
  assert.deepEqual(calls, [binding]);
});

test("bound action receipts distinguish focus-independent gRPC keys from acknowledged CGEvent focus", async () => {
  const binding = {
    discoveryFile: "/tmp/pico_running/pid_93013.ini",
    discoveredSerial: "emulator-5554",
    qemuPid: 93013,
    address: "127.0.0.1:8554",
    tokenPresent: true,
    tokenFingerprint: "a".repeat(64),
    onlineEmulatorSerials: ["emulator-5554"],
    qemuWindowOwnerPid: 93013,
    qemuWindowId: 601,
    bindingMethod: "discovery-pid-window",
  };
  let dragCalls = 0;
  let focusCalls = 0;
  const keyReceipt = await createBoundCameraActionAdapter("emulator-5554", binding, {
    keyHold: async () => ({
      action: "key_hold",
      serial: "emulator-5554",
      status: "applied",
      startedAtMonotonicNs: "1",
      endedAtMonotonicNs: "2",
      ack: { releaseCertain: true },
    }),
    rightDrag: async () => { dragCalls++; return null; },
    focusQemu: async () => { focusCalls++; return null; },
  }).applyRelativeAction({ kind: "key_hold", key: "w", holdMs: 444 });
  assert.equal(keyReceipt.ack.hostFocusRequired, false);
  assert.equal(keyReceipt.ack.hostFocusAttempted, false);
  assert.equal(keyReceipt.ack.focusAcknowledged, false);
  assert.equal(focusCalls, 0);

  const refusedDrag = await createBoundCameraActionAdapter("emulator-5554", binding, {
    keyHold: async () => { throw new Error("not reached"); },
    rightDrag: async () => { dragCalls++; return null; },
    focusQemu: async (received) => {
      focusCalls++;
      assert.equal(received, binding);
      return "frontmost PID readback mismatch";
    },
  }).applyRelativeAction({ kind: "look_drag", dxPx: 20, dyPx: 0 });
  assert.equal(refusedDrag.status, "failed");
  assert.equal(refusedDrag.ack.hostFocusRequired, true);
  assert.equal(refusedDrag.ack.hostFocusAttempted, true);
  assert.equal(refusedDrag.ack.focusAcknowledged, false);
  assert.equal(dragCalls, 0);
  assert.equal(focusCalls, 1);

  const appliedDrag = await createBoundCameraActionAdapter("emulator-5554", binding, {
    keyHold: async () => { throw new Error("not reached"); },
    rightDrag: async () => { dragCalls++; return null; },
    focusQemu: async (received) => {
      focusCalls++;
      assert.equal(received, binding);
      return null;
    },
  }).applyRelativeAction({ kind: "look_drag", dxPx: 20, dyPx: 0 });
  assert.equal(appliedDrag.status, "applied");
  assert.equal(appliedDrag.ack.hostFocusRequired, true);
  assert.equal(appliedDrag.ack.hostFocusAttempted, true);
  assert.equal(appliedDrag.ack.focusAcknowledged, true);
  assert.equal(dragCalls, 1);
  assert.equal(focusCalls, 2);
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
