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

function privateShell(t, { decoder, androidExecOut = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pico-interaction-shell-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, "bin"), appRoot = path.join(temporary, "app");
  fs.mkdirSync(bin);
  const generationRoot = path.join(appRoot, INTERACTION_BRIDGE_ROOT, generation);
  fs.mkdirSync(path.join(generationRoot, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(generationRoot, "acks"));
  const executable = (name, source) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + source, { mode: 0o700 });
  executable("run-as", 'if test "$1" != "$PICO_FIXTURE_PACKAGE"; then echo "run-as: package not debuggable" >&2; exit 1; fi\nshift\ncd "$PICO_FIXTURE_PRIVATE_ROOT" || exit 1\nexec "$@"\n');
  executable("ln", 'printf attempted >> "$PICO_FIXTURE_ROOT/hard-link-attempts"\nprintf "ln: Permission denied\\n" >&2\nexit 1\n');
  // Android toybox supports mv -n -T. macOS mv lacks -T, so this fixture supplies that
  // narrow command contract over host rename. This is not Android filesystem/UID proof.
  executable("mv", 'test "$1" = "-n" && test "$2" = "-T" || exit 65\nshift 2\ntest "$#" = 2 || exit 65\nif test -d "$2"; then printf "mv: destination is a directory\\n" >&2; exit 1; fi\nexec /bin/mv -n "$@"\n');
  if (decoder) executable("base64", decoder);
  const calls = [];
  const execute = async (_adb, args, opts) => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 3), ["-s", "emulator-5554", "exec-out"]);
    const remote = await runBinary("/bin/sh", ["-c", args[3]], { ...opts, env: {
      PATH: `${bin}:/usr/bin:/bin`, PICO_FIXTURE_PACKAGE: packageName,
      PICO_FIXTURE_PRIVATE_ROOT: appRoot, PICO_FIXTURE_ROOT: temporary,
    } });
    return androidExecOut ? { ...remote, code: remote.code === null ? null : 0,
      stdout: Buffer.concat([remote.stdout, Buffer.from(remote.stderr)]), stderr: "" } : remote;
  };
  return { temporary, bin, appRoot, generationRoot, execute, calls,
    commandFile: path.join(generationRoot, "inbox", requestId + ".json") };
}

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
  assert.match(calls[0][1][3], /mkdir /);
  assert.match(calls[0][1][3], /mv -n -T /);
  assert.doesNotMatch(calls[0][1][3], /(?:^|[; ])(?:ln|rm) /);
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

test("host shell publication survives Android-like hard-link denial and refuses duplicates, stale generations, symlinks and foreign packages", { skip: process.platform === "win32" }, async t => {
    const { temporary, appRoot, generationRoot, execute, commandFile } = privateShell(t);
    await backend(execute).send(request, 1000);
    const original = fs.readFileSync(commandFile, "utf8");
    assert.deepEqual(JSON.parse(original), request);
    assert.equal(fs.existsSync(path.join(temporary, "hard-link-attempts")), false);
    assert.equal(fs.statSync(commandFile + ".claim").isDirectory(), true);
    await assert.rejects(backend(execute).send({ ...request, expectedRevision: 1 }, 1000), /in_doubt/);
    assert.equal(fs.readFileSync(commandFile, "utf8"), original);
    assert.equal(fs.existsSync(path.join(commandFile + ".claim", "request.tmp")), false);
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
});

test("concurrent publishers share one persistent request claim across backend reconstruction", { skip: process.platform === "win32" }, async t => {
  const f = privateShell(t, { androidExecOut: true });
  const requests = [request, { ...request, expectedRevision: 1 }];
  const results = await Promise.allSettled(requests.map(value => backend(f.execute).send(value, 1000)));
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(results.filter(value => value.status === "rejected").length, 1);
  const winner = results.findIndex(value => value.status === "fulfilled");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.commandFile)), requests[winner]);
  assert.equal(fs.statSync(f.commandFile + ".claim").isDirectory(), true);
  const finalBytes = fs.readFileSync(f.commandFile);
  await assert.rejects(backend(f.execute).send(request, 1000), /in_doubt/);
  assert.deepEqual(fs.readFileSync(f.commandFile), finalBytes);
});

test("interrupted decoding retains the claim and partial staging bytes without publishing or retrying", { skip: process.platform === "win32" }, async t => {
  const f = privateShell(t, { androidExecOut: true,
    decoder: 'printf decoded >> "$PICO_FIXTURE_ROOT/decode-attempts"\nprintf "{"\nprintf "decoder interrupted\\n" >&2\nexit 1\n' });
  const instance = backend(f.execute);
  await assert.rejects(instance.send(request, 1000), /in_doubt/);
  assert.equal(fs.existsSync(f.commandFile), false);
  assert.equal(fs.readFileSync(path.join(f.commandFile + ".claim", "request.tmp"), "utf8"), "{");
  assert.deepEqual(fs.readdirSync(path.dirname(f.commandFile)).filter(name => name.endsWith(".json")), []);
  const calls = f.calls.length;
  await assert.rejects(instance.send(request), /duplicate/);
  assert.equal(f.calls.length, calls);
  await assert.rejects(backend(f.execute).send(request, 1000), /in_doubt/);
  assert.equal(fs.readFileSync(path.join(f.temporary, "decode-attempts"), "utf8"), "decoded");
  assert.equal(fs.existsSync(f.commandFile), false);
});

test("legacy command/temp files and symlink claims refuse without overwriting evidence", { skip: process.platform === "win32" }, async t => {
  for (const suffix of ["", ".tmp"]) {
    const f = privateShell(t);
    fs.writeFileSync(f.commandFile + suffix, "retained older transport bytes");
    await assert.rejects(backend(f.execute).send(request, 1000), /in_doubt/);
    assert.equal(fs.readFileSync(f.commandFile + suffix, "utf8"), "retained older transport bytes");
    assert.equal(fs.existsSync(f.commandFile + ".claim"), false);
  }
  const f = privateShell(t), outside = path.join(f.temporary, "outside");fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.commandFile + ".claim");
  await assert.rejects(backend(f.execute).send(request, 1000), /in_doubt/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(f.commandFile), false);
});

test("publication failures retain bounded raw transport diagnostics even with adb exit zero", async () => {
  let error;
  const stdout = Buffer.from("mv: Permission denied\n" + "x".repeat(5000));
  try { await backend(async () => ({ code: 0, stdout, stderr: "host diagnostic".repeat(500), timedOut: false })).send(request); }
  catch (caught) { error = caught; }
  assert.match(error.message, /in_doubt/);
  const diagnostics = JSON.parse(error.message.split("; transport=")[1]);
  assert.equal(diagnostics.code, 0);
  assert.equal(diagnostics.stdoutBytes, stdout.length);
  assert.match(Buffer.from(diagnostics.stdoutBase64, "base64").toString(), /^mv: Permission denied/);
  assert.ok(Buffer.from(diagnostics.stdoutBase64, "base64").length <= 1024);
  assert.ok(Buffer.byteLength(diagnostics.stderr) <= 1024);
  assert.equal(diagnostics.truncated, true);
  assert.ok(error.message.length < 4000);
  await assert.rejects(backend(async () => ({ code: 0, stdout: Buffer.from("published\n"), stderr: "", timedOut: false })).send(request), /in_doubt/);
});
