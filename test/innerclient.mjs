// innerclient test (C5, 2026-09-15): the doors surface's single-flight / generation-aware inner
// client provider and its two result lanes, exercised with injected fakes only. No process is
// spawned here — test/doors.mjs holds the one real end-to-end case (20 concurrent door calls at a
// cold doors server against the hermetic full-surface dist/index.js, exactly one inner child).
// Run: node --test test/innerclient.mjs   (build first: tests import dist/)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSingleFlightClient,
  createInnerClientProvider,
  decodeDomainValue,
  domainValueText,
  isInnerToolError,
  textOf,
} from "../dist/innerclient.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A gate the test opens (or fails) explicitly, so a race is proven by ordering, not by sleeps. */
function barrier() {
  let release;
  let fail;
  const opened = new Promise((resolve, reject) => { release = resolve; fail = reject; });
  opened.catch(() => {});
  return { opened, release, fail };
}

function fakeClient(label) {
  const client = {
    label,
    closed: 0,
    calls: [],
    /** When set, close() blocks on this barrier so a retirement can be held open mid-flight. */
    slowClose: null,
    async callRaw(name, args = {}) {
      client.calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify({ echo: name, args, label }) }] };
    },
    async close() {
      client.closed += 1;
      if (client.slowClose) await client.slowClose.opened;
    },
  };
  return client;
}

/**
 * A connect whose every invocation blocks at its own barrier. `plan[n-1] === "fail"` makes the
 * n-th invocation reject once released. One invocation == one would-be child process.
 */
function gatedConnect(plan = []) {
  const gates = [];
  const clients = [];
  const sessions = [];
  const connect = (session) => {
    const n = gates.length + 1;
    const gate = barrier();
    gates.push(gate);
    sessions.push(session);
    return gate.opened.then(() => {
      if (plan[n - 1] === "fail") throw new Error(`fixture connect ${n} failed`);
      const client = fakeClient(`gen${n}`);
      clients.push(client);
      return client;
    });
  };
  return {
    connect,
    clients,
    sessions,
    invocations: () => gates.length,
    release: (n) => gates[n - 1].release(),
  };
}

test("createSingleFlightClient shares one in-flight connect across 20 concurrent callers", async () => {
  const fx = gatedConnect();
  const get = createSingleFlightClient(fx.connect);
  const waiters = Array.from({ length: 20 }, () => get());
  await tick();
  assert.equal(fx.invocations(), 1, "all 20 callers must wait on the single pending connect");
  fx.release(1);
  const clients = await Promise.all(waiters);
  assert.ok(clients.every((client) => client === clients[0]), "every waiter receives the same client identity");
  assert.equal(await get(), clients[0], "a warm call reuses the connected client");
  assert.equal(fx.invocations(), 1, "one connect == one child");
});

test("createSingleFlightClient clears the pending state after a failed first initialization so a retry connects again", async () => {
  const fx = gatedConnect(["fail"]);
  const get = createSingleFlightClient(fx.connect);
  const waiters = Array.from({ length: 20 }, () => get().then(() => null, (error) => error));
  await tick();
  fx.release(1);
  const outcomes = await Promise.all(waiters);
  assert.ok(outcomes.every((error) => error instanceof Error && error === outcomes[0]), "every concurrent waiter is rejected with the same error");
  assert.match(outcomes[0].message, /fixture connect 1 failed/);
  const retry = get();
  await tick();
  assert.equal(fx.invocations(), 2, "the failed attempt no longer occupies the pending slot");
  fx.release(2);
  assert.equal(await retry, fx.clients[0]);
});

test("provider: 20 concurrent acquires share one connect, one child and one identity in generation 1", async () => {
  const fx = gatedConnect();
  const provider = createInnerClientProvider(fx.connect);
  const waiters = Array.from({ length: 20 }, () => provider.acquire());
  await tick();
  assert.equal(fx.invocations(), 1);
  assert.equal(provider.generation(), 1);
  assert.equal(provider.current(), null, "no client is current until the connect resolves");
  fx.release(1);
  const clients = await Promise.all(waiters);
  assert.ok(clients.every((client) => client === clients[0]));
  assert.equal(provider.current(), clients[0]);
  assert.equal(fx.sessions[0].generation, 1);
  assert.equal(await provider.acquire(), clients[0]);
  assert.equal(fx.invocations(), 1);
});

test("provider: a failed first initialization rejects every waiter with the same error and the retry starts generation 2", async () => {
  const fx = gatedConnect(["fail"]);
  const provider = createInnerClientProvider(fx.connect);
  const waiters = Array.from({ length: 20 }, () => provider.acquire().then(() => null, (error) => error));
  await tick();
  fx.release(1);
  const outcomes = await Promise.all(waiters);
  assert.ok(outcomes.every((error) => error instanceof Error && error === outcomes[0]));
  assert.equal(provider.current(), null);
  const retry = provider.acquire();
  await tick();
  assert.equal(fx.invocations(), 2);
  assert.equal(provider.generation(), 2);
  fx.release(2);
  const client = await retry;
  assert.equal(client, fx.clients[0]);
  assert.equal(provider.current(), client);
});

test("provider: retiring generation 1 while generation 2 is connecting never retires generation 2", async () => {
  const fx = gatedConnect();
  const provider = createInnerClientProvider(fx.connect);
  const first = provider.acquire();
  fx.release(1);
  const c1 = await first;
  c1.slowClose = barrier();
  const retiring = provider.retire(c1, new Error("fixture retire"));
  await tick();
  assert.equal(c1.closed, 1, "the old generation's close is in flight");
  assert.equal(provider.current(), null, "generation 1 left the provider synchronously");
  const second = provider.acquire();
  await tick();
  assert.equal(fx.invocations(), 2, "a new acquire reconnects while the old close is still pending");
  fx.release(2);
  const c2 = await second;
  assert.notEqual(c2, c1);
  c1.slowClose.release();
  await retiring;
  assert.equal(provider.current(), c2, "the late-finishing old close must not clear the new generation");
  assert.equal(c2.closed, 0);
  assert.equal(await provider.acquire(), c2);
  assert.equal(provider.generation(), 2);
  assert.equal(fx.invocations(), 2);
});

test("provider: close during initialization never hands out the client and the next acquire reconnects", async () => {
  const fx = gatedConnect();
  const provider = createInnerClientProvider(fx.connect);
  const first = provider.acquire();
  await tick();
  const closing = provider.close();
  fx.release(1);
  await assert.rejects(first, /retired during initialization/);
  await closing;
  assert.equal(fx.clients[0].closed, 1, "the late-connected client is closed, not leaked");
  assert.equal(provider.current(), null);
  const second = provider.acquire();
  await tick();
  assert.equal(fx.invocations(), 2);
  fx.release(2);
  const c2 = await second;
  assert.equal(provider.current(), c2);
});

test("provider: a transport-driven retirement through the session reconnects on the next acquire", async () => {
  const fx = gatedConnect();
  const provider = createInnerClientProvider(fx.connect);
  const first = provider.acquire();
  fx.release(1);
  const c1 = await first;
  await fx.sessions[0].retire(new Error("inner transport closed"));
  assert.equal(c1.closed, 1, "the retired generation's client is closed exactly once");
  assert.equal(provider.current(), null);
  const second = provider.acquire();
  await tick();
  assert.equal(fx.invocations(), 2);
  fx.release(2);
  const c2 = await second;
  assert.notEqual(c2, c1);
  assert.equal(fx.sessions[1].generation, 2);
});

test("provider: retire is idempotent and a stale client cannot retire the live generation", async () => {
  const fx = gatedConnect();
  const provider = createInnerClientProvider(fx.connect);
  const first = provider.acquire();
  fx.release(1);
  const c1 = await first;
  await provider.retire(c1);
  await provider.retire(c1);
  await fx.sessions[0].retire();
  assert.equal(c1.closed, 1);
  const second = provider.acquire();
  await tick();
  fx.release(2);
  const c2 = await second;
  await provider.retire(c1, new Error("stale"));
  assert.equal(provider.current(), c2, "a stale retire leaves the live generation alone");
  assert.equal(c2.closed, 0);
  await provider.close();
  assert.equal(c2.closed, 1);
  assert.equal(provider.current(), null);
});

test("provider: a connect that retires its session synchronously is never installed as the live generation; the next acquire reconnects", async () => {
  // Fix round 1: `active = generation` used to be assigned unconditionally AFTER connect() returned,
  // so a connect that called session.retire() before its first await installed a retired
  // generation whose attempt rejects — and every later acquire returned that same rejection.
  let invocations = 0;
  const clients = [];
  const connect = (session) => {
    invocations += 1;
    if (invocations === 1) session.retire(new Error("transport died before the first await"));
    const client = fakeClient(`gen${invocations}`);
    clients.push(client);
    return Promise.resolve(client);
  };
  const provider = createInnerClientProvider(connect);
  const first = provider.acquire();
  assert.equal(provider.current(), null);
  await assert.rejects(first, /retired during initialization/);
  assert.equal(clients[0].closed, 1, "the late client of the retired generation is closed, not leaked");
  assert.equal(provider.current(), null, "a retired generation is never installed as active");
  const second = provider.acquire();
  assert.equal(invocations, 2, "the next acquire reconnects instead of returning the wedged rejection");
  const c2 = await second;
  assert.equal(c2, clients[1]);
  assert.equal(provider.current(), c2);
  assert.equal(provider.generation(), 2);
  const again = await Promise.all(Array.from({ length: 20 }, () => provider.acquire()));
  assert.ok(again.every((client) => client === c2), "20 concurrent acquires after the retired attempt still share generation 2");
  assert.equal(invocations, 2);
});

test("provider: a connect that retires its session synchronously and then fails leaves no wedged slot either", async () => {
  let invocations = 0;
  const connect = (session) => {
    invocations += 1;
    if (invocations === 1) {
      session.retire(new Error("transport died before the first await"));
      return Promise.reject(new Error("fixture connect 1 failed after retiring"));
    }
    return Promise.resolve(fakeClient(`gen${invocations}`));
  };
  const provider = createInnerClientProvider(connect);
  await assert.rejects(provider.acquire(), /fixture connect 1 failed after retiring/);
  assert.equal(provider.current(), null);
  const c2 = await provider.acquire();
  assert.equal(invocations, 2);
  assert.equal(provider.current(), c2);
});

test("provider: calls go through the live generation's client", async () => {
  const fx = gatedConnect();
  const provider = createInnerClientProvider(fx.connect);
  const first = provider.acquire();
  fx.release(1);
  const client = await first;
  const result = await client.callRaw("vault_api", { symbol: "Entity" });
  assert.deepEqual(client.calls, [{ name: "vault_api", args: { symbol: "Entity" } }]);
  assert.deepEqual(JSON.parse(result.content[0].text), { echo: "vault_api", args: { symbol: "Entity" }, label: "gen1" });
});

// ── result lanes ──

test("domain lane: a successful text result keeps today's decoding (JSON text → object, other text → string)", () => {
  const object = decodeDomainValue("emulator_status", { content: [{ type: "text", text: JSON.stringify({ running: false, grpcDiscovery: null }) }] });
  assert.deepEqual(object, { running: false, grpcDiscovery: null });
  assert.equal(isInnerToolError(object), false);
  assert.equal(decodeDomainValue("x", { content: [{ type: "text", text: "plain words" }] }), "plain words");
  // pre-C5 semantics kept exactly: a non-text block contributes an EMPTY segment to the "\n" join
  assert.equal(decodeDomainValue("x", { content: [{ type: "text", text: "line 1" }, { type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "line 2" }] }), "line 1\n\nline 2");
});

test("domain lane: a successful structured result decodes the TEXT block (structuredContent is not merged — that is the raw lane's job)", () => {
  const decoded = decodeDomainValue("emulator_status", {
    content: [{ type: "text", text: JSON.stringify({ running: true, serial: "emulator-5554" }) }],
    structuredContent: { running: true, serial: "emulator-5554", extra: "structured-only" },
  });
  assert.deepEqual(decoded, { running: true, serial: "emulator-5554" });
});

test("domain lane: isError is never a success object — it becomes the documented status:error payload carrying the inner text", () => {
  const payload = decodeDomainValue("assert_scene", { content: [{ type: "text", text: "Agent Bridge unavailable: broadcast failed" }], isError: true });
  assert.equal(isInnerToolError(payload), true);
  assert.deepEqual(Object.keys(payload), ["status", "tool", "error", "fix"]);
  assert.equal(payload.status, "error");
  assert.equal(payload.tool, "assert_scene");
  assert.equal(payload.error, "Agent Bridge unavailable: broadcast failed");
  assert.match(payload.fix, /assert_scene/);
  // the marker is out-of-band: it never reaches JSON, and a door that reshapes the payload owns its own status
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(payload))), ["status", "tool", "error", "fix"]);
  assert.equal(isInnerToolError({ ...payload }), false);
  assert.equal(isInnerToolError({ status: "error", tool: "x", error: "y", fix: "z" }), false);
});

test("domain lane: a structured failure carries structuredContent beside the inner text", () => {
  const payload = decodeDomainValue("emulator_boot", {
    content: [{ type: "text", text: "boot refused" }],
    structuredContent: { running: false, reason: "already-online" },
    isError: true,
  });
  assert.equal(isInnerToolError(payload), true);
  assert.deepEqual(Object.keys(payload), ["status", "tool", "error", "structuredContent", "fix"]);
  assert.equal(payload.error, "boot refused");
  assert.deepEqual(payload.structuredContent, { running: false, reason: "already-online" });
});

test("domain lane: an isError result without text still names the tool and never reads as success", () => {
  const payload = decodeDomainValue("capture_canonical", { content: [], isError: true });
  assert.equal(payload.status, "error");
  assert.equal(payload.tool, "capture_canonical");
  assert.equal(typeof payload.error, "string");
  assert.ok(payload.error.length > 0);
});

test("textOf joins text blocks (non-text blocks are empty segments, as before C5); domainValueText yields the tool's own words for a lane error", () => {
  assert.equal(textOf({ content: [{ type: "text", text: "a" }, { type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "b" }] }), "a\n\nb");
  assert.equal(textOf({ content: [] }), "");
  const payload = decodeDomainValue("assert_logcat", { content: [{ type: "text", text: "bad regex" }], isError: true });
  assert.equal(domainValueText(payload), "bad regex");
  assert.equal(domainValueText("raw words"), "raw words");
  assert.equal(domainValueText({ matched: false }), JSON.stringify({ matched: false }));
  assert.equal(domainValueText(undefined), "null");
  assert.equal(domainValueText(null), "null");
});
