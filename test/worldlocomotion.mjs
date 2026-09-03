import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_BRIDGE_COMMANDS_COMMAND,
  AGENT_BRIDGE_HMD_POSE_COMMAND,
  AGENT_BRIDGE_LOCOMOTE_COMMAND,
  AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY,
  AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
  AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
  AGENT_BRIDGE_LOCOMOTION_ROOT_ID,
  AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
  probeAgentBridgeLocomotionCapability,
  requestAgentBridgeHmdPose,
  requestAgentBridgeLocomotion,
} from "../dist/agentbridge.js";

const adb = "/fixture/adb";
const baseInput = {
  serial: "fixture-serial",
  packageName: "com.test.fullworld",
  requestId: "locomotion_nonce_0001",
  tag: "route-step-0001",
  maxPolls: 2,
  pollMs: 10,
  stabilityReads: 2,
  ackReadTimeoutMs: 250,
  controlTimeoutMs: 1_000,
};

const envelope = (operation, overrides = {}) => ({
  kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
  schemaVersion: AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
  capabilityRevision: AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
  requestId: baseInput.requestId,
  tag: baseInput.tag,
  application: { packageName: baseInput.packageName },
  operation,
  physicalWalk: false,
  primaryError: null,
  cleanupError: null,
  ...overrides,
});

const availableAck = (overrides = {}) => envelope(AGENT_BRIDGE_COMMANDS_COMMAND, {
  outcome: "available",
  commands: [AGENT_BRIDGE_COMMANDS_COMMAND, AGENT_BRIDGE_HMD_POSE_COMMAND, AGENT_BRIDGE_LOCOMOTE_COMMAND],
  availability: {
    debuggable: true,
    observedStageStyle: "Full",
    rootContainer: "stage",
    rootRegistered: true,
    hmdAvailable: true,
    locomotionAvailable: true,
  },
  root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7 },
  ...overrides,
});

const hmdAck = (overrides = {}) => envelope(AGENT_BRIDGE_HMD_POSE_COMMAND, {
  outcome: "sampled",
  root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 7 },
  hmdPose: {
    readAtMonotonicNs: "9876543210",
    position: { x: 0.1, y: 1.62, z: -0.2 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  },
  ...overrides,
});

const locomotionInput = {
  ...baseInput,
  mode: "direct",
  target: { x: 2, y: 0, z: -4 },
  rootGeneration: 7,
  glideDurationMs: 500,
};

const locomotionAck = (overrides = {}) => envelope(AGENT_BRIDGE_LOCOMOTE_COMMAND, {
  outcome: "completed",
  mode: "direct",
  target: { absolute: true, x: 2, y: 0, z: -4 },
  glideDurationMs: 500,
  rootGenerationBefore: 7,
  pose: { rootGeneration: 7, position: { x: 2, y: 0, z: -4 } },
  hmdPose: null,
  ...overrides,
});

const textOk = { code: 0, stdout: "Broadcast completed: result=0", stderr: "", timedOut: false };
const cleanupOk = { code: 0, stdout: "", stderr: "", timedOut: false };

function fakeTransaction(payloads, options = {}) {
  const calls = [];
  let pull = 0;
  const bytes = payloads.map((payload) => Buffer.from(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8",
  ));
  return {
    calls,
    deps: {
      monotonicNs: (() => { let tick = 100n; return () => tick++; })(),
      sleep: async () => {},
      runText: async (cmd, args, runOptions) => {
        calls.push({ kind: "text", cmd, args, options: runOptions });
        if (args.includes("rm")) return options.cleanupResult ?? cleanupOk;
        return options.broadcastResult ?? textOk;
      },
      runBytes: async (cmd, args, runOptions) => {
        calls.push({ kind: "bytes", cmd, args, options: runOptions });
        const payload = bytes[Math.min(pull++, bytes.length - 1)];
        if (payload === undefined) return { code: 0, stdout: Buffer.from([0]), stderr: "", timedOut: false };
        return { code: 0, stdout: Buffer.concat([Buffer.from([1]), payload]), stderr: "", timedOut: false };
      },
    },
  };
}

function cleanupCalls(calls) {
  return calls.filter((call) => call.kind === "text" && call.args.includes("rm"));
}

function assertExactCleanup(calls, requestId = baseInput.requestId) {
  const cleanup = cleanupCalls(calls);
  assert.equal(cleanup.length, 1);
  assert.deepEqual(cleanup[0].args, [
    "-s", baseInput.serial, "shell", "run-as", baseInput.packageName,
    "rm", "-f", `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${requestId}.json`,
  ]);
}

test("legacy commands acknowledgement without capability revision is capability_unavailable and cleaned", async () => {
  const legacy = availableAck();
  delete legacy.capabilityRevision;
  const fake = fakeTransaction([legacy, legacy]);

  const result = await probeAgentBridgeLocomotionCapability(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "capability_unavailable");
  assert.match(result.primaryError, /capability revision/i);
  assert.equal(result.cleanupError, null);
  assertExactCleanup(fake.calls);
});

test("a substituted revisionless commands file is invalid rather than treated as a legacy capability", async () => {
  const substituted = availableAck({ requestId: "substituted_nonce_9999" });
  delete substituted.capabilityRevision;
  const fake = fakeTransaction([substituted, substituted]);

  const result = await probeAgentBridgeLocomotionCapability(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_ack");
  assert.match(result.primaryError, /schema|requestId/i);
  assertExactCleanup(fake.calls);
});

test("broadcast acceptance without a stable exact-file acknowledgement is never success and is cleaned", async () => {
  const fake = fakeTransaction([]);

  const result = await requestAgentBridgeHmdPose(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "bridge_unavailable");
  assert.match(result.primaryError, /stable|acknowledgement/i);
  assertExactCleanup(fake.calls);
});

test("malformed acknowledgement fails closed and preserves cleanup evidence", async () => {
  const fake = fakeTransaction(["{not-json", "{not-json"]);

  const result = await requestAgentBridgeHmdPose(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_ack");
  assert.match(result.primaryError, /JSON/i);
  assert.equal(result.cleanupError, null);
  assertExactCleanup(fake.calls);
});

test("commands capability success is nonce/package/operation/root bound and uses exact transport metadata", async () => {
  const ack = availableAck();
  const fake = fakeTransaction([ack, ack]);

  const result = await probeAgentBridgeLocomotionCapability(adb, baseInput, fake.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ack, ack);
  const broadcast = fake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast"));
  assert.ok(broadcast);
  for (const value of [
    AGENT_BRIDGE_COMMANDS_COMMAND,
    AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
    String(AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION),
    String(AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION),
    baseInput.requestId,
    baseInput.tag,
  ]) assert.ok(broadcast.args.includes(value), `broadcast omitted ${value}`);
  assert.ok(fake.calls.filter((call) => call.kind === "bytes").every((call) =>
    call.args.at(-1) === `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${baseInput.requestId}.json`));
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 2,
    "success requires two byte-identical reads rather than accepting the first present file");
  assertExactCleanup(fake.calls);
});

test("one present acknowledgement read is insufficient for stability and still cleans", async () => {
  const ack = availableAck();
  const fake = fakeTransaction([ack]);

  const result = await probeAgentBridgeLocomotionCapability(adb, { ...baseInput, maxPolls: 1 }, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "capability_unavailable");
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 1);
  assertExactCleanup(fake.calls);
});

test("changed acknowledgement bytes reset stability before an identical pair succeeds", async () => {
  const first = availableAck({ root: { id: AGENT_BRIDGE_LOCOMOTION_ROOT_ID, generation: 6 } });
  const final = availableAck();
  const fake = fakeTransaction([first, final, final]);

  const result = await probeAgentBridgeLocomotionCapability(adb, { ...baseInput, maxPolls: 3 }, fake.deps);

  assert.equal(result.ok, true);
  assert.equal(result.ack.root.generation, 7);
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 3);
  assertExactCleanup(fake.calls);
});

test("broadcast failure retains the primary error and attempts exact cleanup once", async () => {
  const fake = fakeTransaction([], {
    broadcastResult: { code: 1, stdout: "", stderr: "receiver unavailable", timedOut: false },
  });

  const result = await requestAgentBridgeHmdPose(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "bridge_unavailable");
  assert.match(result.primaryError, /broadcast failed/i);
  assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 0);
  assertExactCleanup(fake.calls);
});

test("HMD success requires finite position/quaternion and exact root generation", async () => {
  const ack = hmdAck();
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeHmdPose(adb, { ...baseInput, expectedRootGeneration: 7 }, fake.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ack, ack);
  assertExactCleanup(fake.calls);
});

test("locomotion success binds mode, absolute target, glide budget, and root-generation transition", async () => {
  const ack = locomotionAck();
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ack, ack);
  const broadcast = fake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast"));
  for (const value of ["direct", "2", "0", "-4", "7", "500", "false"])
    assert.ok(broadcast.args.includes(value), `locomote broadcast omitted ${value}`);
  assertExactCleanup(fake.calls);
});

test("locomotion canonicalizes a finite JavaScript target to its exact Float32 transport value", async () => {
  const input = { ...locomotionInput, target: { x: 0.10000000000000002, y: 0, z: -4 } };
  const ack = locomotionAck({
    target: { absolute: true, x: 0.1, y: 0, z: -4 },
    pose: { rootGeneration: 7, position: { x: 0.1, y: 0, z: -4 } },
  });
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);

  assert.equal(result.ok, true);
  const broadcast = fake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast"));
  assert.equal(broadcast.args[broadcast.args.indexOf("x") + 1], "0.1");
  assert.deepEqual(result.ack.target, { absolute: true, x: 0.1, y: 0, z: -4 });
  assertExactCleanup(fake.calls);
});

test("locomotion acknowledgement binding compares exact Float32 values and normalizes signed zero", async () => {
  const smallestSubnormal = 2 ** -149;
  const largestFinite = Math.fround(3.4028234663852886e38);
  const cases = [
    {
      input: { x: smallestSubnormal, y: -smallestSubnormal, z: -0 },
      acknowledged: { x: 1.4e-45, y: -1.4e-45, z: 0 },
      broadcast: ["1e-45", "-1e-45", "0"],
    },
    {
      input: { x: largestFinite, y: 2 ** -126, z: 0 },
      acknowledged: { x: 3.4028235e38, y: 1.1754944e-38, z: -0 },
      broadcast: ["3.4028235e+38", "1.1754944e-38", "0"],
    },
  ];

  for (const edge of cases) {
    const input = { ...locomotionInput, target: edge.input };
    const ack = locomotionAck({
      target: { absolute: true, ...edge.acknowledged },
      pose: { rootGeneration: 7, position: edge.acknowledged },
    });
    const fake = fakeTransaction([ack, ack]);

    const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);

    assert.equal(result.ok, true);
    const args = fake.calls.find((call) => call.kind === "text" && call.args.includes("broadcast")).args;
    assert.deepEqual(["x", "y", "z"].map((axis) => args[args.indexOf(axis) + 1]), edge.broadcast);
    assertExactCleanup(fake.calls);
  }
});

test("replacement success requires the next root generation and never accepts direct readback", async () => {
  const input = { ...locomotionInput, mode: "replacement", glideDurationMs: 0 };
  const ack = locomotionAck({
    mode: "replacement",
    glideDurationMs: 0,
    pose: { rootGeneration: 8, position: { x: 2, y: 0, z: -4 } },
  });
  const fake = fakeTransaction([ack, ack]);

  const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);

  assert.equal(result.ok, true);
  assert.equal(result.ack.pose.rootGeneration, 8);
  assertExactCleanup(fake.calls);
});

for (const [name, mutate] of [
  ["request nonce", (ack) => { ack.requestId = "substituted_nonce_9999"; }],
  ["package", (ack) => { ack.application.packageName = "com.attacker.substitute"; }],
  ["operation", (ack) => { ack.operation = AGENT_BRIDGE_HMD_POSE_COMMAND; }],
  ["mode", (ack) => { ack.mode = "replacement"; ack.pose.rootGeneration = 8; }],
  ["target", (ack) => { ack.target.x = 2.001; ack.pose.position.x = 2.001; }],
  ["prior root generation", (ack) => { ack.rootGenerationBefore = 6; }],
  ["direct result generation", (ack) => { ack.pose.rootGeneration = 8; }],
]) {
  test(`locomotion rejects substituted or stale ${name} acknowledgement and cleans it`, async () => {
    const ack = locomotionAck();
    mutate(ack);
    const fake = fakeTransaction([ack, ack]);

    const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_ack");
    assert.match(result.primaryError, /acknowledgement|ack/i);
    assertExactCleanup(fake.calls);
  });
}

test("a rejected guest result is distinct from an acknowledgement cleanup failure", async () => {
  const rejected = locomotionAck({ outcome: "rejected", pose: null, primaryError: "stale_generation" });
  const fake = fakeTransaction([rejected, rejected], {
    cleanupResult: { code: 1, stdout: "", stderr: "permission denied", timedOut: false },
  });

  const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "guest_rejected");
  assert.equal(result.primaryError, "stale_generation");
  assert.match(result.cleanupError, /permission denied/i);
  assertExactCleanup(fake.calls);
});

test("guest cleanup failure remains visible when exact acknowledgement-file cleanup succeeds", async () => {
  const rejected = locomotionAck({
    outcome: "failed",
    pose: null,
    primaryError: "replacement_publish_failed",
    cleanupError: "candidate_root_destroy_failed",
  });
  const fake = fakeTransaction([rejected, rejected]);

  const result = await requestAgentBridgeLocomotion(adb, locomotionInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "guest_rejected");
  assert.equal(result.primaryError, "replacement_publish_failed");
  assert.equal(result.cleanupError, "candidate_root_destroy_failed");
  assertExactCleanup(fake.calls);
});

test("failed HMD and locomotion acknowledgements carrying success payloads are invalid", async () => {
  const failedHmd = hmdAck({ outcome: "failed", primaryError: "provider_failed" });
  const hmdFake = fakeTransaction([failedHmd, failedHmd]);
  const hmdResult = await requestAgentBridgeHmdPose(adb, baseInput, hmdFake.deps);
  assert.equal(hmdResult.ok, false);
  assert.equal(hmdResult.code, "invalid_ack");
  assertExactCleanup(hmdFake.calls);

  const failedLocomotion = locomotionAck({ outcome: "failed", primaryError: "producer_failed" });
  const locomotionFake = fakeTransaction([failedLocomotion, failedLocomotion]);
  const locomotionResult = await requestAgentBridgeLocomotion(adb, locomotionInput, locomotionFake.deps);
  assert.equal(locomotionResult.ok, false);
  assert.equal(locomotionResult.code, "invalid_ack");
  assertExactCleanup(locomotionFake.calls);
});

test("cleanup-only host failure has no invented primary failure", async () => {
  const ack = hmdAck();
  const fake = fakeTransaction([ack, ack], {
    cleanupResult: { code: 1, stdout: "", stderr: "cleanup denied", timedOut: false },
  });

  const result = await requestAgentBridgeHmdPose(adb, baseInput, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "cleanup_failed");
  assert.equal(result.primaryError, null);
  assert.match(result.cleanupError, /cleanup denied/i);
  assertExactCleanup(fake.calls);
});

test("locomotion rejects incomplete, non-finite, implicit-mode, or physical-walk input before broadcast", async () => {
  for (const input of [
    { ...locomotionInput, target: { x: 2, y: 0 } },
    { ...locomotionInput, target: { x: Number.NaN, y: 0, z: -4 } },
    { ...locomotionInput, mode: undefined },
    { ...locomotionInput, physicalWalk: true },
  ]) {
    const fake = fakeTransaction([]);
    const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_request");
    assert.equal(fake.calls.filter((call) => call.kind === "bytes").length, 0);
    assert.equal(fake.calls.filter((call) => call.kind === "text" && call.args.includes("broadcast")).length, 0);
    assertExactCleanup(fake.calls);
  }
});

test("finite doubles outside the Float32 transport domain are refused with exact cleanup before broadcast", async () => {
  const fake = fakeTransaction([]);

  const result = await requestAgentBridgeLocomotion(adb, {
    ...locomotionInput,
    target: { x: Number.MAX_VALUE, y: 0, z: -4 },
  }, fake.deps);

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_request");
  assert.match(result.primaryError, /Float32/i);
  assert.equal(fake.calls.filter((call) => call.kind === "text" && call.args.includes("broadcast")).length, 0);
  assertExactCleanup(fake.calls);
});

test("unsafe serial, package, or nonce remains fully transport-free", async () => {
  for (const input of [
    { ...locomotionInput, serial: "two serials" },
    { ...locomotionInput, packageName: "../unsafe" },
    { ...locomotionInput, requestId: "../unsafe" },
  ]) {
    const fake = fakeTransaction([]);
    const result = await requestAgentBridgeLocomotion(adb, input, fake.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_request");
    assert.equal(fake.calls.length, 0);
  }
});
