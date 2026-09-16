/**
 * Marker-correlated bounded log windows (host completion T4, 2026-09-16).
 *
 * Incident 3 of docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md: ~20 irreversible global log
 * clears of the user's emulator, run by an observation path that cleared the buffer "to scope its
 * own scan". src/logwindow.ts replaces every such clear with a marker written into the device's
 * main buffer and a bounded dump sliced to the lines AFTER that marker. A read whose marker is not
 * in the dump is INCONCLUSIVE — never an empty window, never a match against the unscoped buffer.
 *
 * Pure unit tests here take an AdbRunner closure and never spawn anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sliceAfterMarker, openLogWindow, readLogWindow, LOG_WINDOW_TAG } from "../dist/logwindow.js";

test("sliceAfterMarker returns only lines after the marker line", () => {
  const out = ["old 1", "old 2", `09-16 00:00:00.000  1  1 I ${LOG_WINDOW_TAG}: pico-mcp-window-abc`, "new 1", "new 2"].join("\n");
  assert.deepEqual(sliceAfterMarker(out, "pico-mcp-window-abc"), { markerSeen: true, lines: ["new 1", "new 2"] });
});

test("a missing marker is reported, never silently treated as an empty window", () => {
  assert.deepEqual(sliceAfterMarker("a\nb\n", "pico-mcp-window-zzz"), { markerSeen: false, lines: [] });
});

test("openLogWindow writes exactly one `log -t pico-mcp <marker>` and never a clear", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  const window = await openLogWindow(run, "fixture-serial");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ["-s", "fixture-serial", "shell", "log", "-t"]);
  assert.equal(calls[0][5], LOG_WINDOW_TAG);
  assert.equal(calls[0][6], window.marker);
  assert.ok(!calls.some((a) => a.includes("-c")));
});

test("readLogWindow always includes the marker tag in its filter and bounds the dump", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code: 0, stdout: `x\nI ${LOG_WINDOW_TAG}: m1\nAgentBridge: dump_begin\n`, stderr: "" }; };
  const result = await readLogWindow(run, { serial: "fixture-serial", marker: "m1", openedAt: "t" }, { tags: ["AgentBridge"], maxLines: 500 });
  assert.equal(result.markerSeen, true);
  assert.deepEqual(result.lines, ["AgentBridge: dump_begin"]);
  assert.ok(calls[0].includes("-d") && calls[0].includes("-t") && calls[0].includes("500"));
  assert.ok(calls[0].includes("AgentBridge:V") && calls[0].includes(`${LOG_WINDOW_TAG}:V`) && calls[0].includes("*:S"));
  assert.ok(!calls[0].includes("-c"));
});

// ── every replaced site, against a RECORDING fixture adb ─────────────────────────────────────────
// The fake below is the only adb these cases can reach: process.env.PICO_ADB names it for the
// duration of each case (src/adb.ts re-walks its candidate chain on every call, so the override is
// observed immediately and restored afterwards). It records every argv, records every window
// marker it is asked to write and echoes those markers back inside its dumps, answers broadcasts,
// refuses untargeted commands (no `devices`: every site must name its serial), and trips — exit 97
// plus a violations record — on any `logcat … -c`, which is the command this task removes.
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const FIX = "fixture-logwindow-serial";
const FAKE_ADB_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.PICO_LOGWINDOW_FAKE_ARGV, JSON.stringify(args) + "\\n");
const scenario = JSON.parse(fs.readFileSync(env.PICO_LOGWINDOW_FAKE_SCENARIO, "utf8"));
const markersPath = env.PICO_LOGWINDOW_FAKE_MARKERS;
const markers = fs.existsSync(markersPath) ? fs.readFileSync(markersPath, "utf8").split("\\n").filter(Boolean) : [];
if (args.includes("logcat") && args.includes("-c")) {
  if (scenario.allowClear) process.exit(0);
  fs.appendFileSync(env.PICO_LOGWINDOW_FAKE_VIOLATIONS, JSON.stringify(args) + "\\n");
  process.stderr.write("FIXTURE VIOLATION: the global log was cleared\\n");
  process.exit(97);
}
if (args[0] !== "-s" || !args[1]) {
  process.stderr.write("fixture adb refuses untargeted command: " + args.join(" ") + "\\n");
  process.exit(98);
}
const op = args.slice(2);
if (op[0] === "shell" && op[1] === "log") {
  if (scenario.openFails) { process.stderr.write("log: fixture write failure\\n"); process.exit(1); }
  fs.appendFileSync(markersPath, op[op.length - 1] + "\\n");
  process.exit(0);
}
if (op[0] === "logcat") {
  if (scenario.dumpFails) { process.stderr.write("logcat: fixture dump failure\\n"); process.exit(1); }
  const out = [...(scenario.before ?? [])];
  if (!scenario.evict) for (const m of markers) out.push("09-16 00:00:00.500     1     1 I pico-mcp: " + m);
  out.push(...(scenario.after ?? []));
  process.stdout.write(out.join("\\n") + "\\n");
  process.exit(0);
}
if (op[0] === "shell" && op[1] === "am" && op[2] === "broadcast") {
  process.stdout.write("Broadcasting: Intent { act=fixture }\\nBroadcast completed: result=0\\n");
  process.exit(0);
}
process.stderr.write("fixture adb: unmodelled command: " + args.join(" ") + "\\n");
process.exit(2);
`;

async function withFakeAdb(scenario, operation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-logwindow-adb-"));
  const fake = path.join(dir, "fake-adb.mjs");
  fs.writeFileSync(fake, FAKE_ADB_SOURCE, { mode: 0o755 });
  fs.chmodSync(fake, 0o755);
  const files = {
    argv: path.join(dir, "argv.jsonl"),
    markers: path.join(dir, "markers.txt"),
    scenario: path.join(dir, "scenario.json"),
    violations: path.join(dir, "violations.jsonl"),
  };
  fs.writeFileSync(files.scenario, JSON.stringify(scenario));
  const previous = {
    PICO_ADB: process.env.PICO_ADB,
    PICO_LOGWINDOW_FAKE_ARGV: process.env.PICO_LOGWINDOW_FAKE_ARGV,
    PICO_LOGWINDOW_FAKE_MARKERS: process.env.PICO_LOGWINDOW_FAKE_MARKERS,
    PICO_LOGWINDOW_FAKE_SCENARIO: process.env.PICO_LOGWINDOW_FAKE_SCENARIO,
    PICO_LOGWINDOW_FAKE_VIOLATIONS: process.env.PICO_LOGWINDOW_FAKE_VIOLATIONS,
  };
  process.env.PICO_ADB = fake;
  process.env.PICO_LOGWINDOW_FAKE_ARGV = files.argv;
  process.env.PICO_LOGWINDOW_FAKE_MARKERS = files.markers;
  process.env.PICO_LOGWINDOW_FAKE_SCENARIO = files.scenario;
  process.env.PICO_LOGWINDOW_FAKE_VIOLATIONS = files.violations;
  const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  const handle = {
    readArgv: () => readLines(files.argv).map((line) => JSON.parse(line)),
    readMarkers: () => readLines(files.markers),
    violations: () => readLines(files.violations),
    seedMarker: (marker) => fs.appendFileSync(files.markers, `${marker}\n`),
    setScenario: (next) => fs.writeFileSync(files.scenario, JSON.stringify(next)),
    reset: () => { for (const file of [files.argv, files.markers, files.violations]) fs.rmSync(file, { force: true }); },
  };
  try {
    return await operation(handle);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const isOpen = (argv) => argv[2] === "shell" && argv[3] === "log" && argv[4] === "-t" && argv[5] === LOG_WINDOW_TAG;
const isDump = (argv) => argv[2] === "logcat";
const isBroadcast = (argv) => argv[2] === "shell" && argv[3] === "am" && argv[4] === "broadcast";

/** The claim every site must satisfy: no recorded argv contains `logcat` followed by `-c`, and the tripwire never fired. */
function assertNoClear(fake) {
  const argv = fake.readArgv();
  for (const call of argv) {
    const at = call.indexOf("logcat");
    assert.ok(!(at >= 0 && call.slice(at + 1).includes("-c")), `a global log clear was attempted: ${call.join(" ")}`);
  }
  assert.deepEqual(fake.violations(), [], "the fixture adb's clear tripwire fired");
  return argv;
}

/** Every dump must be bounded (-d, -t <n>); a tag-filtered dump must admit the marker tag beside the
 * site's own tags and silence the rest, while a tagless window read carries no filter at all (a
 * `pico-mcp:V *:S` filter there would hide the very lines being awaited). */
function assertBoundedWindowDumps(argv, ...tags) {
  const dumps = argv.filter(isDump);
  assert.ok(dumps.length > 0, "no dump was read");
  for (const dump of dumps) {
    assert.ok(dump.includes("-d"), `dump must not block: ${dump.join(" ")}`);
    const t = dump.indexOf("-t");
    assert.ok(t > 0 && Number(dump[t + 1]) > 0, `dump must be line-bounded: ${dump.join(" ")}`);
    const filtered = dump.some((a) => /:[VDIWEFS]$/.test(a));
    if (tags.length || filtered) {
      assert.ok(dump.includes(`${LOG_WINDOW_TAG}:V`) && dump.includes("*:S"), `a filtered dump must admit the marker tag: ${dump.join(" ")}`);
    }
    for (const tag of tags) assert.ok(dump.includes(`${tag}:V`), `dump must admit ${tag}: ${dump.join(" ")}`);
  }
  return dumps;
}

function assertOpenPrecedesBroadcast(argv) {
  const open = argv.findIndex(isOpen);
  const broadcast = argv.findIndex(isBroadcast);
  assert.ok(open >= 0, "no window was opened");
  assert.ok(broadcast >= 0, "no broadcast was sent");
  assert.ok(open < broadcast, "the window must open BEFORE the action that produces the lines");
}

async function withTools(register, operation) {
  const server = new McpServer({ name: "logwindow-fixture", version: "0.0.0" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "logwindow-fixture", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

const textOf = (result) => result.content?.map((c) => c.text ?? "").join("\n") ?? "";
const jsonOf = (result) => JSON.parse(result.content[0].text);

const bridgeLine = (body) => `09-16 00:00:01.000  8531  8531 I AgentBridge: AGENTBRIDGE| ${body}`;
const STALE_BRIDGE_DUMP = [
  bridgeLine("event=dump_begin root=Root"),
  bridgeLine("event=entity d=1 name=stale_from_previous_run children=0 pos=0.0,0.0,0.0 comps=TransformComponent"),
  bridgeLine("event=dump_end entities=1"),
];
const FRESH_BRIDGE_DUMP = [
  bridgeLine("event=dump_begin root=Root"),
  bridgeLine("event=entity d=1 name=crate children=0 pos=0.7,1.0,-2.0 comps=CollisionComponent,TransformComponent"),
  bridgeLine("event=dump_end entities=1"),
];

// ── assert_scene ──
test("assert_scene opens a window before its broadcast and matches only the dump inside it", async () => {
  await withFakeAdb({ before: STALE_BRIDGE_DUMP, after: FRESH_BRIDGE_DUMP }, async (fake) => {
    const { runAssertScene } = await import("../dist/assertscene.js");
    const fresh = await runAssertScene({ applicationId: "com.example.fixture", serial: FIX, entitiesPresent: ["crate"] });
    assert.equal(fresh.pass, true, JSON.stringify(fresh));
    assert.equal(fresh.serial, FIX);
    assert.equal(fresh.logWindow?.markerSeen, true);
    assert.deepEqual(fake.readMarkers(), [fresh.logWindow.marker], "exactly the reported marker was written");
    const stale = await runAssertScene({ applicationId: "com.example.fixture", serial: FIX, entitiesPresent: ["stale_from_previous_run"] });
    assert.equal(stale.pass, false, "an entity dumped BEFORE the window must not satisfy the assertion");
    const argv = assertNoClear(fake);
    assertOpenPrecedesBroadcast(argv);
    assert.equal(argv.filter(isOpen).length, 2, "one window per call");
    assertBoundedWindowDumps(argv, "AgentBridge");
  });
});

test("assert_scene reports an evicted marker as an inconclusive error, never as a dump", async () => {
  await withFakeAdb({ before: STALE_BRIDGE_DUMP, after: FRESH_BRIDGE_DUMP, evict: true }, async (fake) => {
    const { runAssertScene } = await import("../dist/assertscene.js");
    const result = await runAssertScene({ applicationId: "com.example.fixture", serial: FIX, entitiesPresent: ["crate"] });
    assert.ok("error" in result, JSON.stringify(result));
    assert.match(result.error, /evicted/);
    assert.match(result.error, /not cleared/);
    assert.equal(result.serial, FIX);
    assert.equal(result.logWindow?.markerSeen, false);
    assert.equal(result.logWindow?.marker, fake.readMarkers()[0]);
    assertNoClear(fake);
  });
});

test("assert_scene refuses when the window cannot be opened and reads no dump at all", async () => {
  await withFakeAdb({ after: FRESH_BRIDGE_DUMP, openFails: true }, async (fake) => {
    const { runAssertScene } = await import("../dist/assertscene.js");
    const result = await runAssertScene({ applicationId: "com.example.fixture", serial: FIX });
    assert.ok("error" in result, JSON.stringify(result));
    assert.match(result.error, /log window/);
    assert.equal(result.serial, FIX);
    const argv = assertNoClear(fake);
    assert.equal(argv.filter(isDump).length, 0, "no dump may be read without a window");
    assert.equal(argv.filter(isBroadcast).length, 0, "no action is driven without a window");
  });
});

// ── probe_planes ──
const planesLine = (body) => `09-16 00:00:02.000  8531  8531 I SceneUnderstanding: PLANES| ${body}`;
const STALE_PLANES = [planesLine("count=1 retries=0"), planesLine("idx=0 label=STALE orient=HORIZONTAL pos=0,0,0 bbox=1,1")];
const FRESH_PLANES = [
  planesLine("count=2 retries=3"),
  planesLine("idx=0 label=FLOOR orient=HORIZONTAL pos=0,0.4,0 bbox=4,4"),
  planesLine("idx=1 label=WALL orient=VERTICAL pos=0,1.5,-2 bbox=3,2.5"),
];

test("probe_planes opens a window before its broadcast and parses only the inventory inside it", async () => {
  await withFakeAdb({ before: STALE_PLANES, after: FRESH_PLANES }, async (fake) => {
    const { registerSenseTools } = await import("../dist/sense.js");
    await withTools(registerSenseTools, async (client) => {
      const result = await client.callTool({ name: "probe_planes", arguments: { applicationId: "com.example.fixture", serial: FIX, waitSec: 3 } });
      assert.equal(result.isError, undefined, textOf(result));
      const out = jsonOf(result);
      assert.equal(out.count, 2);
      assert.deepEqual(out.planes.map((p) => p.label), ["FLOOR", "WALL"]);
      assert.equal(out.serial, FIX);
      assert.equal(out.logWindow?.markerSeen, true);
      assert.deepEqual(fake.readMarkers(), [out.logWindow.marker]);
    });
    const argv = assertNoClear(fake);
    assertOpenPrecedesBroadcast(argv);
    assertBoundedWindowDumps(argv, "SceneUnderstanding", "AgentBridge");
  });
});

test("probe_planes reports an evicted marker as inconclusive instead of reading the stale inventory", async () => {
  await withFakeAdb({ before: STALE_PLANES, after: FRESH_PLANES, evict: true }, async (fake) => {
    const { registerSenseTools } = await import("../dist/sense.js");
    await withTools(registerSenseTools, async (client) => {
      const result = await client.callTool({ name: "probe_planes", arguments: { applicationId: "com.example.fixture", serial: FIX, waitSec: 3 } });
      assert.equal(result.isError, true, textOf(result));
      const out = JSON.parse(textOf(result));
      assert.equal(out.status, "inconclusive");
      assert.equal(out.serial, FIX);
      assert.equal(out.logWindow?.markerSeen, false);
      assert.equal(out.logWindow?.marker, fake.readMarkers()[0]);
    });
    assertNoClear(fake);
  });
});

// ── live_scene_snapshot (copilot) ──
test("live_scene_snapshot opens a window before its dump_scene broadcast and returns only the fresh scene", async () => {
  await withFakeAdb({ before: STALE_BRIDGE_DUMP, after: FRESH_BRIDGE_DUMP }, async (fake) => {
    const { registerCopilotTools } = await import("../dist/copilot.js");
    await withTools(registerCopilotTools, async (client) => {
      const result = await client.callTool({ name: "live_scene_snapshot", arguments: { serial: FIX, packageName: "com.example.fixture" } });
      assert.equal(result.isError, undefined, textOf(result));
      const out = jsonOf(result);
      assert.equal(out.status, "ok");
      assert.deepEqual(out.entities.map((e) => e.name), ["crate"]);
      assert.equal(out.serial, FIX);
      assert.equal(out.logWindow?.markerSeen, true);
      assert.deepEqual(fake.readMarkers(), [out.logWindow.marker]);
    });
    const argv = assertNoClear(fake);
    assertOpenPrecedesBroadcast(argv);
    assertBoundedWindowDumps(argv, "AgentBridge");
  });
});

test("live_scene_snapshot reports an evicted marker as inconclusive rather than parsing the stale dump", async () => {
  await withFakeAdb({ before: STALE_BRIDGE_DUMP, after: FRESH_BRIDGE_DUMP, evict: true }, async (fake) => {
    const { registerCopilotTools } = await import("../dist/copilot.js");
    await withTools(registerCopilotTools, async (client) => {
      const result = await client.callTool({ name: "live_scene_snapshot", arguments: { serial: FIX, packageName: "com.example.fixture" } });
      const out = jsonOf(result);
      assert.equal(out.status, "inconclusive", textOf(result));
      assert.equal(out.serial, FIX);
      assert.equal(out.logWindow?.markerSeen, false);
      assert.equal(out.entities, undefined, "no entities may be reported from an unscoped buffer");
    });
    assertNoClear(fake);
  });
});

// ── assert_logcat / logcat (src/adb.ts) ──
const fixtureLine = (stamp, body) => `09-16 00:00:0${stamp}.000     2     2 I Fixture: ${body}`;
const STALE_LOG = [fixtureLine(0, "STALE_READY")];
const FRESH_LOG = [fixtureLine(3, "APP_READY")];

test("assert_logcat sinceMarker adopts a caller-written marker and matches only lines after it", async () => {
  await withFakeAdb({ before: STALE_LOG, after: FRESH_LOG }, async (fake) => {
    const marker = "pico-mcp-window-preseeded-by-caller";
    fake.seedMarker(marker);
    const { registerAdbTools } = await import("../dist/adb.js");
    await withTools(registerAdbTools, async (client) => {
      const hit = jsonOf(await client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "APP_READY", sinceMarker: marker, timeoutSec: 1, pollMs: 200 } }));
      assert.equal(hit.matched, true, JSON.stringify(hit));
      assert.match(hit.line, /APP_READY/);
      assert.equal(hit.serial, FIX);
      assert.deepEqual(hit.logWindow, { marker, markerSeen: true });
      const miss = jsonOf(await client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "STALE_READY", sinceMarker: marker, timeoutSec: 1, pollMs: 200 } }));
      assert.equal(miss.matched, false, "a line logged BEFORE the marker must not match");
      assert.notEqual(miss.status, "inconclusive");
      assert.deepEqual(miss.logWindow, { marker, markerSeen: true });
      const argv = assertNoClear(fake);
      assert.equal(argv.filter(isOpen).length, 0, "an adopted marker is not re-written");
      assertBoundedWindowDumps(argv);

      // A tag filter must still admit the marker tag, or the window could never be confirmed.
      fake.reset();
      fake.seedMarker(marker);
      const tagged = jsonOf(await client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "APP_READY", tag: "Fixture", sinceMarker: marker, timeoutSec: 1, pollMs: 200 } }));
      assert.equal(tagged.matched, true, JSON.stringify(tagged));
      assertBoundedWindowDumps(assertNoClear(fake), "Fixture");
    });
  });
});

test("assert_logcat clearFirst opens a marker window instead of clearing, and an evicted marker is inconclusive", async () => {
  await withFakeAdb({ before: STALE_LOG, after: FRESH_LOG }, async (fake) => {
    const { registerAdbTools } = await import("../dist/adb.js");
    await withTools(registerAdbTools, async (client) => {
      const hit = jsonOf(await client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "APP_READY", clearFirst: true, timeoutSec: 1, pollMs: 200 } }));
      assert.equal(hit.matched, true, JSON.stringify(hit));
      assert.equal(hit.logWindow?.markerSeen, true);
      assert.deepEqual(fake.readMarkers(), [hit.logWindow.marker]);
      let argv = assertNoClear(fake);
      assert.equal(argv.filter(isOpen).length, 1);
      assertBoundedWindowDumps(argv);

      fake.reset();
      fake.setScenario({ before: STALE_LOG, after: FRESH_LOG, evict: true });
      const evicted = jsonOf(await client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "APP_READY", clearFirst: true, timeoutSec: 1, pollMs: 200 } }));
      assert.equal(evicted.matched, false, JSON.stringify(evicted));
      assert.equal(evicted.status, "inconclusive");
      assert.equal(evicted.serial, FIX);
      assert.equal(evicted.logWindow?.markerSeen, false);
      argv = assertNoClear(fake);

      fake.reset();
      fake.setScenario({ before: STALE_LOG, after: FRESH_LOG });
      const unscoped = jsonOf(await client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "STALE_READY", timeoutSec: 1, pollMs: 200 } }));
      assert.equal(unscoped.matched, true, "without a window the whole buffer is still the (compatible) scope");
      assert.equal(unscoped.serial, FIX);
      assert.equal(unscoped.logWindow, null);
      assertNoClear(fake);
    });
  });
});

test("the logcat tool's clear:true is the one destructive clear and requires an explicit serial", async () => {
  await withFakeAdb({ allowClear: true }, async (fake) => {
    const { registerAdbTools } = await import("../dist/adb.js");
    await withTools(registerAdbTools, async (client) => {
      const tools = await client.listTools();
      const logcat = tools.tools.find((t) => t.name === "logcat");
      assert.match(logcat.inputSchema.properties.clear.description, /destructive/i);
      assert.match(logcat.inputSchema.properties.clear.description, /explicit serial/i);
      const refused = await client.callTool({ name: "logcat", arguments: { clear: true } });
      assert.equal(refused.isError, true, textOf(refused));
      assert.match(textOf(refused), /explicit serial/i);
      assert.deepEqual(fake.readArgv(), [], "a refused clear resolves no device and runs nothing");
      const blank = await client.callTool({ name: "logcat", arguments: { clear: true, serial: "   " } });
      assert.equal(blank.isError, true, textOf(blank));
      assert.deepEqual(fake.readArgv(), []);
      const cleared = await client.callTool({ name: "logcat", arguments: { clear: true, serial: FIX } });
      assert.equal(cleared.isError, undefined, textOf(cleared));
      assert.match(textOf(cleared), new RegExp(FIX));
      assert.deepEqual(fake.readArgv(), [["-s", FIX, "logcat", "-c"]], "exactly the explicit-serial clear, nothing else");
    });
  });
});

// ── wait_for_log (src/agentloop.ts) ──
test("wait_for_log's default opens a marker window instead of clearing and reports the window it matched in", async () => {
  await withFakeAdb({ before: STALE_LOG, after: FRESH_LOG }, async (fake) => {
    const { registerAgentLoopTools } = await import("../dist/agentloop.js");
    await withTools(registerAgentLoopTools, async (client) => {
      const hit = await client.callTool({ name: "wait_for_log", arguments: { serial: FIX, pattern: "APP_READY", timeoutSec: 1 } });
      assert.equal(hit.isError, undefined, textOf(hit));
      const out = jsonOf(hit);
      assert.equal(out.matched, true);
      assert.equal(out.serial, FIX);
      assert.equal(out.logWindow?.markerSeen, true);
      assert.deepEqual(fake.readMarkers(), [out.logWindow.marker]);
      assert.ok(out.lines.some((l) => /APP_READY/.test(l)));
      let argv = assertNoClear(fake);
      assert.equal(argv.filter(isOpen).length, 1);
      assertBoundedWindowDumps(argv);

      fake.reset();
      const stale = await client.callTool({ name: "wait_for_log", arguments: { serial: FIX, pattern: "STALE_READY", timeoutSec: 1 } });
      assert.equal(stale.isError, true, "a line logged BEFORE the window must not satisfy the wait");
      assert.match(textOf(stale), new RegExp(FIX));
      assertNoClear(fake);

      fake.reset();
      fake.setScenario({ before: STALE_LOG, after: FRESH_LOG, evict: true });
      const evicted = await client.callTool({ name: "wait_for_log", arguments: { serial: FIX, pattern: "APP_READY", timeoutSec: 1 } });
      assert.equal(evicted.isError, true, textOf(evicted));
      assert.match(textOf(evicted), /inconclusive/i);
      assert.match(textOf(evicted), /not cleared/i);
      assertNoClear(fake);

      fake.reset();
      fake.setScenario({ before: STALE_LOG, after: FRESH_LOG });
      const unscoped = await client.callTool({ name: "wait_for_log", arguments: { serial: FIX, pattern: "STALE_READY", timeoutSec: 1, clearFirst: false } });
      assert.equal(unscoped.isError, undefined, textOf(unscoped));
      assert.equal(jsonOf(unscoped).logWindow, null);
      argv = assertNoClear(fake);
      assert.equal(argv.filter(isOpen).length, 0);
    });
  });
});

// ── the bound a LONG poller reads with (fix wave FW1, Important 1) ───────────────────────────────
// logd applies `-t <count>` to the raw selected buffers BEFORE the client-side tag filter, so the
// count bounds the device's raw output, not the lines a caller sees: a chatty XR runtime pushes the
// marker out of a small tail while the filtered output stays tiny, and the read turns inconclusive.
// The module default (4000) suits a short tag-filtered read. The pollers that wait for tens of
// seconds — assert_logcat (up to 180 s), wait_for_log, build_and_run's whole settle — read with
// 20000, and pico_loop, whose marker precedes a multi-minute fleet_build, asks assert_logcat for
// 50000. An explicit `maxLines` input on the two tools is sent verbatim. readLogWindow itself is
// unchanged: it sends exactly the bound it is given (the unit case above pins that).
const dumpBound = (argv) => argv[argv.indexOf("-t") + 1];
/** True when the call was refused by the tool's input schema, whichever way the SDK reports it. */
const refusedByInputSchema = (promise) => promise.then((result) => result.isError === true, () => true);

test("assert_logcat reads with the long-poll bound (-t 20000) by default and sends an explicit maxLines verbatim", async () => {
  await withFakeAdb({ before: STALE_LOG, after: FRESH_LOG }, async (fake) => {
    const marker = "pico-mcp-window-bound-fixture";
    const { registerAdbTools } = await import("../dist/adb.js");
    await withTools(registerAdbTools, async (client) => {
      const schema = (await client.listTools()).tools.find((t) => t.name === "assert_logcat").inputSchema.properties.maxLines;
      assert.equal(schema?.type, "integer", `maxLines must be an optional integer input: ${JSON.stringify(schema)}`);
      assert.equal(schema?.minimum, 100);
      assert.equal(schema?.maximum, 200000);
      assert.match(schema?.description ?? "", /before the tag filter/i, "the input must say why the bound matters");

      fake.seedMarker(marker);
      const hit = jsonOf(await client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "APP_READY", sinceMarker: marker, timeoutSec: 1, pollMs: 200 } }));
      assert.equal(hit.matched, true, JSON.stringify(hit));
      let dumps = assertBoundedWindowDumps(assertNoClear(fake));
      for (const dump of dumps) assert.equal(dumpBound(dump), "20000", `default long-poll bound: ${dump.join(" ")}`);

      for (const maxLines of [500, 50000]) {
        fake.reset();
        fake.seedMarker(marker);
        const explicit = jsonOf(await client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "APP_READY", tag: "Fixture", sinceMarker: marker, timeoutSec: 1, pollMs: 200, maxLines } }));
        assert.equal(explicit.matched, true, JSON.stringify(explicit));
        dumps = assertBoundedWindowDumps(assertNoClear(fake), "Fixture");
        for (const dump of dumps) assert.equal(dumpBound(dump), String(maxLines), `explicit bound ${maxLines}: ${dump.join(" ")}`);
      }

      fake.reset();
      assert.equal(await refusedByInputSchema(client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "APP_READY", sinceMarker: marker, timeoutSec: 1, maxLines: 10 } })), true, "a bound under 100 lines is refused by the schema");
      assert.deepEqual(fake.readArgv(), [], "a refused input runs nothing");
    });
  });
});

test("wait_for_log reads with the long-poll bound (-t 20000) by default and sends an explicit maxLines verbatim", async () => {
  await withFakeAdb({ before: STALE_LOG, after: FRESH_LOG }, async (fake) => {
    const { registerAgentLoopTools } = await import("../dist/agentloop.js");
    await withTools(registerAgentLoopTools, async (client) => {
      const schema = (await client.listTools()).tools.find((t) => t.name === "wait_for_log").inputSchema.properties.maxLines;
      assert.equal(schema?.type, "integer", `maxLines must be an optional integer input: ${JSON.stringify(schema)}`);
      assert.equal(schema?.minimum, 100);
      assert.equal(schema?.maximum, 200000);

      const hit = await client.callTool({ name: "wait_for_log", arguments: { serial: FIX, pattern: "APP_READY", timeoutSec: 1 } });
      assert.equal(hit.isError, undefined, textOf(hit));
      let dumps = assertBoundedWindowDumps(assertNoClear(fake));
      for (const dump of dumps) assert.equal(dumpBound(dump), "20000", `default long-poll bound: ${dump.join(" ")}`);

      fake.reset();
      const explicit = await client.callTool({ name: "wait_for_log", arguments: { serial: FIX, pattern: "APP_READY", tag: "Fixture", timeoutSec: 1, maxLines: 500 } });
      assert.equal(explicit.isError, undefined, textOf(explicit));
      dumps = assertBoundedWindowDumps(assertNoClear(fake), "Fixture");
      for (const dump of dumps) assert.equal(dumpBound(dump), "500", `explicit bound: ${dump.join(" ")}`);

      fake.reset();
      assert.equal(await refusedByInputSchema(client.callTool({ name: "wait_for_log", arguments: { serial: FIX, pattern: "APP_READY", timeoutSec: 1, maxLines: 10 } })), true, "a bound under 100 lines is refused by the schema");
      assert.deepEqual(fake.readArgv(), [], "a refused input runs nothing");
    });
  });
});

test("the long-poll bounds are named constants of the module, and build_and_run's settle-long read uses one", async () => {
  const mod = await import("../dist/logwindow.js");
  assert.equal(mod.DEFAULT_LOG_WINDOW_MAX_LINES, 4000, "the module default is unchanged");
  assert.equal(mod.LONG_POLL_LOG_WINDOW_MAX_LINES, 20000, "assert_logcat / wait_for_log / build_and_run");
  assert.equal(mod.BUILD_LENGTH_LOG_WINDOW_MAX_LINES, 50000, "pico_loop, whose marker precedes fleet_build");
  // build_and_run needs a Gradle build to reach its read, so its argv is proven where that fixture
  // exists — the hermetic smoke gate (test/smoke.mjs, "build_and_run window dump carries the
  // long-poll bound"). This pins the source so the site cannot silently fall back to the default.
  const workflow = fs.readFileSync(new URL("../src/workflow.ts", import.meta.url), "utf8");
  const reads = workflow.match(/readLogWindow\(runner, window, \{[^}]*\}\)/g) ?? [];
  assert.equal(reads.length, 1, `exactly one window read in build_and_run: ${reads.join(" | ")}`);
  assert.match(reads[0], /maxLines: LONG_POLL_LOG_WINDOW_MAX_LINES/, `build_and_run must read with the long-poll bound: ${reads[0]}`);
});

// ── a dead adb is a dump failure, not an eviction (fix wave FW1, Minor 1) ─────────────────────────
// readLogWindow throws when the dump command itself fails, and every polling site retried until its
// deadline while discarding that error — then blamed "evicted by log volume" for a marker no dump had
// ever looked for. Each site now keeps the last dump error; when no dump succeeded it names the
// failure and claims nothing about eviction, and when some dump did succeed the eviction finding
// stands with the last failure appended. The fixture adb's `dumpFails` makes every dump exit 1.
const DUMP_FAILURE = /every dump failed: .*fixture dump failure/;

test("unseenMarkerCause blames eviction only when a dump actually succeeded", async () => {
  const { unseenMarkerCause } = await import("../dist/logwindow.js");
  const allFailed = unseenMarkerCause({ successfulDumps: 0, lastReadError: "bounded log dump failed on s (exit 1): dead adb" });
  assert.match(allFailed, /every dump failed: bounded log dump failed on s \(exit 1\): dead adb/);
  assert.doesNotMatch(allFailed, /evict/i, "no dump succeeded, so nothing is known about the marker");
  const mixed = unseenMarkerCause({ successfulDumps: 3, lastReadError: "dead adb" });
  assert.match(mixed, /evicted by log volume, or never written/);
  assert.match(mixed, /last dump also failed: dead adb \(3 dump\(s\) succeeded without the marker\)/);
  const clean = unseenMarkerCause({ successfulDumps: 2, lastReadError: null });
  assert.equal(clean, "evicted by log volume, or never written");
});

test("assert_logcat names the dump failure when every poll's dump failed, instead of blaming eviction", async () => {
  await withFakeAdb({ before: STALE_LOG, after: FRESH_LOG, dumpFails: true }, async (fake) => {
    const { registerAdbTools } = await import("../dist/adb.js");
    await withTools(registerAdbTools, async (client) => {
      const out = jsonOf(await client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "APP_READY", clearFirst: true, timeoutSec: 1, pollMs: 200 } }));
      assert.equal(out.matched, false, JSON.stringify(out));
      assert.equal(out.status, "inconclusive");
      assert.equal(out.serial, FIX);
      assert.equal(out.logWindow?.markerSeen, false);
      assert.match(out.hint, DUMP_FAILURE, out.hint);
      assert.doesNotMatch(out.hint, /evicted/, "no dump succeeded, so eviction is not a finding");
      assert.match(out.hint, /not cleared/i);
      const argv = assertNoClear(fake);
      assert.ok(argv.filter(isDump).length >= 2, "the dump is retried until the deadline");
    });
  });
});

test("assert_logcat keeps the eviction finding, with the last failure appended, when a dump did succeed", async () => {
  await withFakeAdb({ before: STALE_LOG, after: FRESH_LOG, evict: true }, async (fake) => {
    const { registerAdbTools } = await import("../dist/adb.js");
    await withTools(registerAdbTools, async (client) => {
      const pending = client.callTool({ name: "assert_logcat", arguments: { serial: FIX, pattern: "APP_READY", clearFirst: true, timeoutSec: 2, pollMs: 200 } });
      // Once the first (successful, marker-less) dump is on record, every later dump fails.
      while (fake.readArgv().filter(isDump).length < 1) await new Promise((r) => setTimeout(r, 25));
      fake.setScenario({ before: STALE_LOG, after: FRESH_LOG, evict: true, dumpFails: true });
      const out = jsonOf(await pending);
      assert.equal(out.status, "inconclusive", JSON.stringify(out));
      assert.match(out.hint, /evicted by log volume, or never written/, out.hint);
      assert.match(out.hint, /last dump also failed: .*fixture dump failure \(\d+ dump\(s\) succeeded without the marker\)/, out.hint);
      assertNoClear(fake);
    });
  });
});

test("wait_for_log names the dump failure when every poll's dump failed, instead of blaming eviction", async () => {
  await withFakeAdb({ before: STALE_LOG, after: FRESH_LOG, dumpFails: true }, async (fake) => {
    const { registerAgentLoopTools } = await import("../dist/agentloop.js");
    await withTools(registerAgentLoopTools, async (client) => {
      const result = await client.callTool({ name: "wait_for_log", arguments: { serial: FIX, pattern: "APP_READY", timeoutSec: 1 } });
      assert.equal(result.isError, true, textOf(result));
      const text = textOf(result);
      assert.match(text, /inconclusive/i);
      assert.match(text, DUMP_FAILURE, text);
      assert.doesNotMatch(text, /evicted/);
      assert.match(text, /not cleared/i);
      assertNoClear(fake);
    });
  });
});

test("probe_planes names the dump failure when every poll's dump failed, instead of blaming eviction", async () => {
  await withFakeAdb({ before: STALE_PLANES, after: FRESH_PLANES, dumpFails: true }, async (fake) => {
    const { registerSenseTools } = await import("../dist/sense.js");
    await withTools(registerSenseTools, async (client) => {
      const result = await client.callTool({ name: "probe_planes", arguments: { applicationId: "com.example.fixture", serial: FIX, waitSec: 3 } });
      assert.equal(result.isError, true, textOf(result));
      const out = JSON.parse(textOf(result));
      assert.equal(out.status, "inconclusive");
      assert.equal(out.serial, FIX);
      assert.equal(out.logWindow?.markerSeen, false);
      assert.match(out.error, DUMP_FAILURE, out.error);
      assert.doesNotMatch(out.error, /evicted/);
      assertNoClear(fake);
    });
  });
});

test("live_scene_snapshot names the dump failure when every poll's dump failed, instead of blaming eviction", async () => {
  await withFakeAdb({ before: STALE_BRIDGE_DUMP, after: FRESH_BRIDGE_DUMP, dumpFails: true }, async (fake) => {
    const { registerCopilotTools } = await import("../dist/copilot.js");
    await withTools(registerCopilotTools, async (client) => {
      const result = await client.callTool({ name: "live_scene_snapshot", arguments: { serial: FIX, packageName: "com.example.fixture" } });
      const out = jsonOf(result);
      assert.equal(out.status, "inconclusive", textOf(result));
      assert.equal(out.serial, FIX);
      assert.equal(out.logWindow?.markerSeen, false);
      assert.match(out.error, DUMP_FAILURE, out.error);
      assert.doesNotMatch(out.error, /evicted/);
      assert.equal(out.entities, undefined, "no entities may be reported when nothing was read");
      assertNoClear(fake);
    });
  });
});

// ── pico_loop (src/doors.ts) — through the door's dependency seam, no process ──
async function withScratchHome(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pico-logwindow-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await operation(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function loopFixture(assertLogcatResponse) {
  const calls = [];
  const capture = "/fixture/ledger/artifacts/" + "a".repeat(64) + ".png";
  const receiptId = "b".repeat(64);
  const fleetResult = {
    id: "fixture", built: true, installed: true, concluded: true, verdict: "ESCALATE", artifact: capture,
    receipt: { status: "recorded", receiptId, receiptPath: `/fixture/run-receipts/${receiptId}.json`, capturePath: capture, sourceCapturePath: "/fixture/captures/unique.png", captureSha256: "a".repeat(64), evidenceType: "structural", lookRequired: true },
    visualChecks: [], visualJudgeNote: "fixture", visualLedger: null, notes: [],
  };
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === "plan_app_spec") return { status: "ok", spec: { meta: { packageName: "com.example.fixture" } } };
    if (name === "adb_shell") return "(no output)";
    if (name === "fleet_build") return { status: "ok", results: [fleetResult] };
    if (name === "assert_logcat") return assertLogcatResponse(args);
    if (name === "record_verification") return { status: "recorded", entry: { evidenceType: "structural" } };
    throw new Error(`unexpected injected door call: ${name}`);
  };
  return { calls, call };
}

test("pico_loop writes a marker through adb_shell before the build and scopes every assert_logcat to it", async () => {
  await withScratchHome(async () => {
    const fixture = loopFixture((args) => ({ matched: true, line: "I Fixture: APP_READY", serial: FIX, logWindow: { marker: args.sinceMarker, markerSeen: true } }));
    const { registerDoorTools } = await import("../dist/doors.js");
    await withTools((server) => registerDoorTools(server, { call: fixture.call }), async (client) => {
      const result = await client.callTool({
        name: "pico_loop",
        arguments: { goal: "log window loop fixture", draftSpec: { meta: { packageName: "com.example.fixture" } }, acceptance: [{ kind: "logcat", pattern: "APP_READY" }, { kind: "logcat", pattern: "rayCast HIT", tag: "Fixture" }], budget: { iterations: 1 } },
      });
      const out = jsonOf(result);
      assert.equal(out.status, "accepted", textOf(result));
      const shell = fixture.calls.find((c) => c.name === "adb_shell");
      assert.equal(out.iterationsLog?.[0]?.logWindow?.marker, shell?.args.command.split(" ").at(-1), "the iteration log must record the window its logcat criteria were scoped to");
    });
    const shells = fixture.calls.filter((c) => c.name === "adb_shell");
    for (const shell of shells) assert.ok(!/logcat\s+-c/.test(shell.args.command), `pico_loop cleared the global log: ${shell.args.command}`);
    assert.equal(shells.length, 1, JSON.stringify(shells));
    const marker = /^log -t pico-mcp (pico-mcp-window-[0-9a-f-]{36})$/.exec(shells[0].args.command)?.[1];
    assert.ok(marker, `the one adb_shell call must write the window marker: ${shells[0].args.command}`);
    const openAt = fixture.calls.findIndex((c) => c.name === "adb_shell");
    const buildAt = fixture.calls.findIndex((c) => c.name === "fleet_build");
    assert.ok(openAt < buildAt, "the window must open before the build/launch that produces the lines");
    const asserts = fixture.calls.filter((c) => c.name === "assert_logcat");
    assert.equal(asserts.length, 2);
    for (const a of asserts) {
      assert.equal(a.args.sinceMarker, marker, JSON.stringify(a.args));
      // The marker was written BEFORE a multi-minute fleet_build (Gradle + install + launch + settle):
      // a default-bound tail would evict it on a real device, so the loop asks for the build-length bound.
      assert.equal(a.args.maxLines, 50000, `pico_loop must pass the build-length bound to assert_logcat: ${JSON.stringify(a.args)}`);
    }
  });
});

test("pico_loop treats an inconclusive (evicted-window) assert_logcat as unmeasurable, never as a fail to replan", async () => {
  await withScratchHome(async () => {
    const fixture = loopFixture((args) => ({ matched: false, status: "inconclusive", serial: FIX, logWindow: { marker: args.sinceMarker, markerSeen: false } }));
    const { registerDoorTools } = await import("../dist/doors.js");
    await withTools((server) => registerDoorTools(server, { call: fixture.call }), async (client) => {
      const result = await client.callTool({
        name: "pico_loop",
        arguments: { goal: "log window evicted fixture", draftSpec: { meta: { packageName: "com.example.fixture" } }, acceptance: [{ kind: "logcat", pattern: "APP_READY" }], budget: { iterations: 2 } },
      });
      const out = jsonOf(result);
      assert.equal(out.status, "unmeasurable-acceptance", textOf(result));
      assert.equal(out.failing?.[0]?.status, "unmeasurable");
      assert.match(out.failing?.[0]?.detail ?? "", /inconclusive|marker/i);
    });
    assert.equal(fixture.calls.filter((c) => c.name === "replan_spec").length, 0, "an inconclusive read must not drive a replan");
  });
});

// ── boundary experiment prepare step (src/boundaryexperiment.ts) ──
test("the boundary prepare step opens a -b all window, writes its sidecar, and stops on an evicted marker", async () => {
  const { collectPreparationLogWindow, LogWindowEvictedError } = await import("../dist/boundaryexperiment.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-logwindow-boundary-"));
  try {
    const calls = [];
    let written = null;
    const runner = async (args) => {
      calls.push(args);
      if (args[2] === "shell" && args[3] === "log") { written = args[6]; return { code: 0, stdout: "", stderr: "" }; }
      if (args[2] === "logcat") return { code: 0, stdout: `old line\n09-16 00:00:00.500 1 1 I pico-mcp: ${written}\nnew 1\nnew 2\n`, stderr: "" };
      throw new Error(`unmodelled: ${args.join(" ")}`);
    };
    const artifactPath = path.join(dir, "prepare-log-window.txt");
    const result = await collectPreparationLogWindow(runner, FIX, artifactPath);
    assert.equal(result.window.serial, FIX);
    assert.equal(result.window.marker, written);
    assert.deepEqual(result.lines, ["new 1", "new 2"]);
    const text = fs.readFileSync(artifactPath, "utf8").split("\n");
    assert.equal(text[0], `# window marker ${written} seen=true`);
    assert.deepEqual(text.slice(1, 3), ["new 1", "new 2"]);
    for (const call of calls) {
      const at = call.indexOf("logcat");
      assert.ok(!(at >= 0 && call.slice(at + 1).includes("-c")), `prepare cleared the log: ${call.join(" ")}`);
    }
    const dump = calls.find((c) => c[2] === "logcat");
    assert.ok(dump.includes("-b") && dump[dump.indexOf("-b") + 1] === "all", `prepare must read every buffer: ${dump.join(" ")}`);
    assert.ok(dump.includes("-d") && dump.includes("-t"), `prepare's dump must be bounded: ${dump.join(" ")}`);
    assert.ok(calls.findIndex((c) => c[3] === "log") < calls.findIndex((c) => c[2] === "logcat"));

    let evictedMarker = null;
    const evictedRunner = async (args) => {
      if (args[2] === "shell" && args[3] === "log") { evictedMarker = args[6]; return { code: 0, stdout: "", stderr: "" }; }
      if (args[2] === "logcat") return { code: 0, stdout: "old line\nnewer line\n", stderr: "" };
      throw new Error(`unmodelled: ${args.join(" ")}`);
    };
    const evictedPath = path.join(dir, "prepare-log-window-evicted.txt");
    await assert.rejects(() => collectPreparationLogWindow(evictedRunner, FIX, evictedPath), (error) => {
      assert.ok(error instanceof LogWindowEvictedError, String(error));
      assert.equal(error.window.marker, evictedMarker);
      assert.match(error.message, /evicted/);
      return true;
    });
    assert.equal(fs.readFileSync(evictedPath, "utf8").split("\n")[0], `# window marker ${evictedMarker} seen=false`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the source-level guard ───────────────────────────────────────────────────────────────────────
// Inverted rather than line-pinned (fix wave FW1, Minor 3): every `logcat … -c` spelling the old
// guard covered — a `"logcat", "-c"` argv, its `-b <buffer>` variant, the shell text `logcat -c` —
// is collected from every src/*.ts, and there must be exactly ONE, in src/adb.ts, in the
// explicit-serial form `["-s", target, "logcat", "-c"]`, inside the `if (clear) {` branch that has
// already refused a missing serial. No other site clears, whatever line the allowed one moves to.
const CLEAR_SPELLINGS = [/"logcat",\s*(?:"-b",\s*"[a-z]+",\s*)?"-c"/, /logcat -c/];
const EXPLICIT_SERIAL_CLEAR = /await adb\(\["-s", target, "logcat", "-c"\]\)/;

/** Every line of every file that spells a logcat clear: `{ file, line, text }`. */
function findLogcatClearSites(files) {
  const sites = [];
  for (const { name, text } of files) {
    for (const [index, line] of text.split("\n").entries()) {
      if (CLEAR_SPELLINGS.some((re) => re.test(line))) sites.push({ file: name, line: index + 1, text: line });
    }
  }
  return sites;
}

/**
 * The guard: exactly one clear, in adb.ts, in the explicit-serial argv form, and the statement sits
 * inside an `if (clear) {` branch (at most 20 lines above) that has already refused an empty serial —
 * `const target = serial?.trim() ?? ""`, `if (!target)`, and a `fail(...)` naming the requirement.
 */
function assertOnlyExplicitSerialClear(files) {
  const sites = findLogcatClearSites(files);
  const named = sites.map((s) => `${s.file}:${s.line}`);
  assert.equal(sites.length, 1, `exactly one logcat clear may exist in src/, found ${sites.length}: ${named.join(", ") || "none"}`);
  const [site] = sites;
  assert.equal(site.file, "adb.ts", `the one clear must be the logcat tool's explicit clear in adb.ts, not ${named[0]}`);
  assert.match(site.text, EXPLICIT_SERIAL_CLEAR, `${named[0]} is not the explicit-serial clear: ${site.text.trim()}`);
  const lines = files.find((f) => f.name === "adb.ts").text.split("\n");
  const above = lines.slice(Math.max(0, site.line - 1 - 20), site.line - 1);
  const branchAt = above.findLastIndex((l) => /^\s*if \(clear\) \{\s*$/.test(l));
  assert.ok(branchAt >= 0, `${named[0]} must sit inside the logcat tool's \`if (clear) {\` branch (none within 20 lines above)`);
  const guard = above.slice(branchAt).join("\n");
  assert.match(guard, /const target = serial\?\.trim\(\) \?\? "";/, `${named[0]}: the branch must derive the target from the explicit serial only`);
  assert.match(guard, /if \(!target\) \{/, `${named[0]}: the branch must refuse a missing serial before clearing`);
  assert.match(guard, /return fail\([^\n]*explicit serial/, `${named[0]}: the refusal must name the explicit-serial requirement`);
  return site;
}

const readSrcFiles = () => {
  const src = new URL("../src/", import.meta.url);
  return fs.readdirSync(src).filter((n) => n.endsWith(".ts")).map((name) => ({ name, text: fs.readFileSync(new URL(name, src), "utf8") }));
};

test("no src file clears logcat implicitly; the explicit logcat tool is the only clear", () => {
  const site = assertOnlyExplicitSerialClear(readSrcFiles());
  assert.equal(site.file, "adb.ts");
});

test("the inverted guard rejects a second clear, a clear outside adb.ts, and a clear without the explicit-serial refusal", () => {
  const real = readSrcFiles();
  const adb = real.find((f) => f.name === "adb.ts");
  // a second site anywhere — in each spelling the old guard covered
  for (const text of ['await adb(["-s", s, "logcat", "-c"]);', 'await adb(["-s", s, "logcat", "-b", "main", "-c"]);', 'await adb(["-s", s, "shell", "logcat -c"]);']) {
    assert.throws(
      () => assertOnlyExplicitSerialClear([...real, { name: "rogue.ts", text: `export async function rogue(s) {\n  ${text}\n}\n` }]),
      (error) => /exactly one logcat clear/.test(error.message) && /rogue\.ts:2/.test(error.message) && /adb\.ts:\d+/.test(error.message),
      text,
    );
  }
  // the one clear living somewhere other than the logcat tool
  const moved = real.filter((f) => f.name !== "adb.ts").concat(
    { name: "adb.ts", text: adb.text.replace(EXPLICIT_SERIAL_CLEAR, 'await adb(["-s", target, "logcat", "-d"])') },
    { name: "elsewhere.ts", text: 'const r = await adb(["-s", target, "logcat", "-c"]);\n' },
  );
  assert.throws(() => assertOnlyExplicitSerialClear(moved), /must be the logcat tool's explicit clear in adb\.ts, not elsewhere\.ts:1/);
  // the explicit-serial derivation replaced by sole-device resolution above the clear
  const unguarded = real.map((f) => (f.name === "adb.ts" ? { name: f.name, text: f.text.replace(/const target = serial\?\.trim\(\) \?\? "";/, "const target = await resolveSerial(serial);") } : f));
  assert.throws(() => assertOnlyExplicitSerialClear(unguarded), /derive the target from the explicit serial only/);
  // a clear that names a resolved serial instead of the explicit target
  const resolved = real.map((f) => (f.name === "adb.ts" ? { name: f.name, text: f.text.replace(EXPLICIT_SERIAL_CLEAR, 'await adb(["-s", s, "logcat", "-c"])') } : f));
  assert.throws(() => assertOnlyExplicitSerialClear(resolved), /is not the explicit-serial clear/);
});
