import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { runBinary } from "../dist/util.js";
import {
  createInteractionBridgeBackend, parseInteractionBridgeAck, parseInteractionBridgeRequest,
  parseBridgeSemanticState, emitAgentInteractionBridgeKt, INTERACTION_BRIDGE_ROOT,
} from "../dist/interactionbridge.js";

const packageName = "com.example.picofixture.iteration.debug";
const generation = "22222222-2222-4222-8222-222222222222";
const requestId = "11111111-1111-4111-8111-111111111111";
const state = { panel: { id: "fixture.panel", visible: false }, counter: 0 };
const observation = { schemaVersion: 1, kind: "pico.agent-bridge.semantic-state", packageName,
  generation, revision: 0, observedAtEpochMs: 1_800_000_000_000, pid: 42,
  pidStartTicks: "1000", state, actions: ["panel.show"] };
const request = { schemaVersion: 1, packageName, requestId, expectedGeneration: generation,
  expectedRevision: 0, actionId: "panel.show", args: { panelId: "fixture.panel" }, deadlineEpochMs: 1_800_000_010_000 };
const ack = { schemaVersion: 1, packageName, requestId, generation, expectedRevision: 0,
  actionId: "panel.show", args: { panelId: "fixture.panel" }, status: "completed", revision: 1,
  acknowledgedAtEpochMs: 1_800_000_000_001, state: { panel: { id: "fixture.panel", visible: true }, counter: 1 } };
const result = (value, prefix = 1) => ({ code: 0, stdout: Buffer.concat([Buffer.from([prefix]), Buffer.from(value === null ? "" : JSON.stringify(value))]), stderr: "", timedOut: false });
const backend = (runBytes) => createInteractionBridgeBackend({ adb: "/fixture/adb", serial: "emulator-5554", packageName, runBytes });

test("strict schemas allow only named panel action and bounded identities", () => {
  assert.deepEqual(parseInteractionBridgeRequest(request), request);
  assert.deepEqual(parseBridgeSemanticState(observation), observation);
  for (const change of [{ actionId: "execute" }, { args: { panelId: "../escape" } },
    { args: { panelId: "fixture.panel", shell: "id" } }, { expectedRevision: -1 },
    { requestId: "../../outside" }, { unexpected: true }, { packageName: "a; id" }]) {
    assert.throws(() => parseInteractionBridgeRequest({ ...request, ...change }));
  }
});

test("ACK matching rejects wrong caller, generation, request, action and contradictions", () => {
  assert.deepEqual(parseInteractionBridgeAck(ack, request), ack);
  for (const change of [{ packageName: "com.other.app" }, { generation: "33333333-3333-4333-8333-333333333333" },
    { requestId: "33333333-3333-4333-8333-333333333333" }, { expectedRevision: 7 },
    { actionId: "execute" }, { revision: 0 }, { state },
    { error: { code: "bad", detail: "contradiction" } }]) {
    assert.throws(() => parseInteractionBridgeAck({ ...ack, ...change }, request));
  }
  assert.throws(() => parseInteractionBridgeAck({ ...ack, status: "refused" }, request));
  assert.throws(() => parseInteractionBridgeAck({ ...ack, status: "accepted", revision: 1 }, request));
});

test("backend rejects unsafe target before spawning", () => {
  for (const serial of ["", "emulator-5554; id", "$(id)", "two devices", "-s"]) {
    assert.throws(() => createInteractionBridgeBackend({ adb: "/fixture/adb", serial, packageName }));
  }
  assert.throws(() => createInteractionBridgeBackend({ adb: "adb", serial: "emulator-5554", packageName }));
});

test("app-private observation uses explicit serial, bounded output and no receiver", async () => {
  const calls = [];
  const instance = backend(async (...call) => { calls.push(call); return result(observation); });
  assert.deepEqual(await instance.observe(500), observation);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/fixture/adb");
  assert.deepEqual(calls[0][1].slice(0, 3), ["-s", "emulator-5554", "exec-out"]);
  assert.match(calls[0][1][3], /run-as/);
  assert.match(calls[0][1][3], /files\/agentbridge\/interaction-v1\/state\.json/);
  assert.equal(calls[0][2].timeoutMs, 500);
  assert.ok(calls[0][2].maxOutputBytes <= 65537);
  assert.doesNotMatch(calls[0][1].join(" "), /broadcast|logcat/);
});

test("send is once-only even when its transport failed or timed out", async () => {
  let calls = 0;
  const instance = backend(async () => { calls++; return { code: null, stdout: Buffer.alloc(0), stderr: "lost", timedOut: true }; });
  await assert.rejects(instance.send(request, 500), /in_doubt|timed out/);
  await assert.rejects(instance.send(request, 500), /duplicate/);
  assert.equal(calls, 1);
});

test("pre-dispatch cancellation sends nothing and does not reserve an attempted request", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  let calls = 0;
  const options = { adb: "/fixture/adb", serial: "emulator-5554", packageName, signal: cancellation.signal,
    runBytes: async () => { calls++; return { code: 0, stdout: Buffer.from("published"), stderr: "", timedOut: false }; } };
  const instance = createInteractionBridgeBackend(options);
  await assert.rejects(instance.send(request), /cancelled before/);
  await assert.rejects(instance.observe(), /cancelled before/);
  await assert.rejects(instance.readAck(request), /cancelled before/);
  assert.equal(calls, 0);
  // An explicit test-only fresh signal demonstrates that a known-undispatched ID was not consumed.
  options.signal = new AbortController().signal;
  await instance.send(request);
  assert.equal(calls, 1);
});

test("in-flight cancellation reaches the child runner and leaves the request uncertain and non-retryable", async () => {
  const cancellation = new AbortController();
  let calls = 0;
  const options = { adb: "/fixture/adb", serial: "emulator-5554", packageName, signal: cancellation.signal,
    runBytes: async (_adb, _args, opts) => {
      calls++;
      assert.equal(opts.signal, cancellation.signal);
      await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));
      return { code: null, stdout: Buffer.alloc(0), stderr: "cancelled", timedOut: false };
    } };
  const instance = createInteractionBridgeBackend(options);
  const result = instance.send(request);
  cancellation.abort();
  await assert.rejects(result, /in_doubt/);
  options.signal = new AbortController().signal;
  await assert.rejects(instance.send(request), /duplicate/);
  assert.equal(calls, 1);
});

test("publication is app-generation scoped and atomically refuses duplicate file names", async () => {
  const calls = [];
  const instance = backend(async (...call) => { calls.push(call); return { code: 0, stdout: Buffer.from("published"), stderr: "", timedOut: false }; });
  await instance.send(request, 500);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1][3], new RegExp(`${generation}/inbox/${requestId}\\.json`));
  assert.match(calls[0][1][3], /ln /);
  assert.match(calls[0][1][3], /test ! -L/);
  await assert.rejects(instance.send(request), /duplicate/);
  assert.equal(calls.length, 1);
});

test("missing ACK remains absent and invalid ACK never becomes completion", async () => {
  assert.equal(await backend(async () => result(null, 0)).readAck(request), null);
  await assert.rejects(backend(async () => result({ ...ack, packageName: "com.forged.app" })).readAck(request));
  await assert.rejects(backend(async () => result({ ...ack, generation: "33333333-3333-4333-8333-333333333333" })).readAck(request));
});

test("ACK read is path-bound; release/foreign UID denial stays a transport failure", async () => {
  const calls = [];
  const instance = backend(async (...call) => { calls.push(call); return result(ack); });
  assert.deepEqual(await instance.readAck(request, 400), ack);
  assert.match(calls[0][1][3], new RegExp(`${generation}/acks/${requestId}\\.json`));
  await assert.rejects(backend(async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "run-as: package not debuggable", timedOut: false })).observe(), /not debuggable/);
});

test("read rejects malformed framing, oversized payloads and mismatched observed package", async () => {
  for (const value of [Buffer.from("{}"), Buffer.alloc(65538), Buffer.from([0, 0])]) {
    await assert.rejects(backend(async () => ({ code: 0, stdout: value, stderr: "", timedOut: false })).observe());
  }
  await assert.rejects(backend(async () => result({ ...observation, packageName: "com.other.app" })).observe());
});

test("debug emitter has app-private IPC and bounded replay/deadline guards", () => {
  const source = emitAgentInteractionBridgeKt("com.example.picofixture.iteration");
  assert.match(source, /FLAG_DEBUGGABLE/);
  assert.match(source, /canonicalFile/);
  assert.match(source, /MAX_REQUESTS/);
  assert.match(source, /deadlineEpochMs/);
  assert.match(source, /expectedGeneration/);
  assert.match(source, /expectedRevision/);
  assert.match(source, /UUID.randomUUID/);
  assert.match(source, /"accepted"/);
  assert.match(source, /"completed"/);
  assert.match(source, /"refused"/);
  assert.doesNotMatch(source, /registerReceiver|ServerSocket|Runtime.getRuntime|ProcessBuilder|DexClassLoader/);
  assert.throws(() => emitAgentInteractionBridgeKt("bad;package"));
});

test("debug source set contains IPC; release source set contains only an inert adapter", () => {
  const root = path.resolve("examples/agent-iteration-fixture/app/src");
  const debug = fs.readFileSync(path.join(root, "debug/java/com/example/picofixture/iteration/AgentInteractionBridge.kt"), "utf8");
  const release = fs.readFileSync(path.join(root, "release/java/com/example/picofixture/iteration/FixtureBridge.kt"), "utf8");
  assert.equal(debug, emitAgentInteractionBridgeKt("com.example.picofixture.iteration"));
  assert.doesNotMatch(release, /run-as|interaction-v1|AgentInteractionBridge|JSONObject|Handler/);
  const manifest = fs.readFileSync(path.join(root, "main/AndroidManifest.xml"), "utf8");
  assert.doesNotMatch(manifest, /<receiver|<provider|android:debuggable="true"/);
  assert.equal(INTERACTION_BRIDGE_ROOT, "files/agentbridge/interaction-v1");
});

test("actual host shell publication refuses duplicate commands, stale generation, symlinks and foreign package", { skip: process.platform === "win32" }, async () => {
  // Exercise the exact remote shell command against a private directory. This is not Android UID proof.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pico-interaction-shell-"));
  try {
    const bin = path.join(temporary, "bin");
    const appRoot = path.join(temporary, "app");
    fs.mkdirSync(bin);
    const generationRoot = path.join(appRoot, INTERACTION_BRIDGE_ROOT, generation);
    fs.mkdirSync(path.join(generationRoot, "inbox"), { recursive: true });
    fs.mkdirSync(path.join(generationRoot, "acks"));
    fs.writeFileSync(path.join(bin, "run-as"), '#!/bin/sh\nif test "$1" != "$PICO_FIXTURE_PACKAGE"; then echo "run-as: package not debuggable" >&2; exit 1; fi\nshift\ncd "$PICO_FIXTURE_PRIVATE_ROOT" || exit 1\nexec "$@"\n', { mode: 0o700 });
    const execute = (_adb, args, opts) => {
      assert.deepEqual(args.slice(0, 3), ["-s", "emulator-5554", "exec-out"]);
      return runBinary("/bin/sh", ["-c", args[3]], { ...opts, env: {
        PATH: `${bin}:/usr/bin:/bin`, PICO_FIXTURE_PACKAGE: packageName, PICO_FIXTURE_PRIVATE_ROOT: appRoot,
      } });
    };
    await backend(execute).send(request, 1000);
    const commandFile = path.join(generationRoot, "inbox", requestId + ".json");
    const original = fs.readFileSync(commandFile, "utf8");
    assert.deepEqual(JSON.parse(original), request);
    await assert.rejects(backend(execute).send({ ...request, expectedRevision: 1 }, 1000), /in_doubt/);
    assert.equal(fs.readFileSync(commandFile, "utf8"), original);
    assert.equal(fs.existsSync(commandFile + ".tmp"), false);
    await assert.rejects(backend(execute).send({ ...request, expectedGeneration: "33333333-3333-4333-8333-333333333333" }, 1000), /in_doubt/);
    const observationFile = path.join(appRoot, INTERACTION_BRIDGE_ROOT, "state.json");
    fs.writeFileSync(observationFile, JSON.stringify(observation));
    assert.deepEqual(await backend(execute).observe(1000), observation);
    fs.unlinkSync(observationFile);
    fs.writeFileSync(path.join(temporary, "outside.json"), JSON.stringify(observation));
    fs.symlinkSync(path.join(temporary, "outside.json"), observationFile);
    await assert.rejects(backend(execute).observe(1000), /read failed/);
    const forged = createInteractionBridgeBackend({ adb: "/fixture/adb", serial: "emulator-5554", packageName: "com.other.app", runBytes: execute });
    await assert.rejects(forged.observe(1000), /not debuggable/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
