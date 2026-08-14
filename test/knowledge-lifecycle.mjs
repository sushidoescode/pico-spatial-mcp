import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createManagedRuntimeHarness } from "./helpers/picocli-managed-fixture.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const knowledgeUrl = pathToFileURL(path.join(repoRoot, "dist", "knowledge.js")).href;
const serverMcpUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const serverStdioUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
const zodUrl = import.meta.resolve("zod");

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(check(), true, message);
}

function killFixturePid(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch { /* the fixture may not lead a process group */ }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
}

function readEvents(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function createLifecycleFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-knowledge-lifecycle-"));
  const fixturePath = path.join(root, "server.mjs");
  const firstUsePath = path.join(root, "first-use");
  const descendantPidPath = path.join(root, "descendant.pid");
  const logPath = path.join(root, "events.jsonl");
  const fixtureSource = `
import { spawn } from "node:child_process";
import fs from "node:fs";
import { McpServer } from ${JSON.stringify(serverMcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(serverStdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const append = (event) => fs.appendFileSync(process.env.KNOWLEDGE_LIFECYCLE_LOG, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
const firstUse = !fs.existsSync(process.env.KNOWLEDGE_LIFECYCLE_FIRST_USE);
if (firstUse) fs.writeFileSync(process.env.KNOWLEDGE_LIFECYCLE_FIRST_USE, String(process.pid));
append({ event: "start", firstUse });
process.on("exit", () => append({ event: "exit" }));

const server = new McpServer({ name: "knowledge-lifecycle-fixture", version: "0.0.0" });
server.registerTool("graph_stats", { inputSchema: z.object({}).strict() }, async () => {
  if (firstUse) {
    const descendant = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: ["ignore", process.stdout, process.stderr],
      env: process.env,
      windowsHide: true,
    });
    fs.writeFileSync(process.env.KNOWLEDGE_LIFECYCLE_DESCENDANT_PID, String(descendant.pid));
    append({ event: "descendant", descendantPid: descendant.pid });
    descendant.unref();
    setTimeout(() => process.exit(23), 20);
    await new Promise(() => {});
  }
  return { content: [{ type: "text", text: JSON.stringify({ generationPid: process.pid }) }] };
});
await server.connect(new StdioServerTransport());
`;
  fs.writeFileSync(fixturePath, fixtureSource);
  return { root, fixturePath, firstUsePath, descendantPidPath, logPath };
}

function createTokenStrippingRootFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-knowledge-token-strip-"));
  const fixturePath = path.join(root, "server.mjs");
  const logPath = path.join(root, "events.jsonl");
  fs.writeFileSync(fixturePath, `
import fs from "node:fs";
import { McpServer } from ${JSON.stringify(serverMcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(serverStdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const append = (event) => fs.appendFileSync(process.env.KNOWLEDGE_LIFECYCLE_LOG, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
append({ event: "start", tokenPresent: Object.hasOwn(process.env, "PICO_MCP_KNOWLEDGE_GENERATION_TOKEN") });
process.on("SIGTERM", () => append({ event: "ignored-sigterm" }));
setInterval(() => {}, 1_000);

const server = new McpServer({ name: "knowledge-token-strip-fixture", version: "0.0.0" });
server.registerTool("graph_stats", { inputSchema: z.object({}).strict() }, async () => ({
  content: [{ type: "text", text: JSON.stringify({ generationPid: process.pid }) }],
}));
await server.connect(new StdioServerTransport());
`);
  return { root, fixturePath, logPath };
}

function createStableRootFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-knowledge-stable-root-"));
  const fixturePath = path.join(root, "server.mjs");
  const logPath = path.join(root, "events.jsonl");
  fs.writeFileSync(fixturePath, `
import fs from "node:fs";
import { McpServer } from ${JSON.stringify(serverMcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(serverStdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const append = (event) => fs.appendFileSync(process.env.KNOWLEDGE_LIFECYCLE_LOG, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
append({ event: "start" });
process.on("exit", () => append({ event: "exit" }));
const server = new McpServer({ name: "knowledge-stable-root-fixture", version: "0.0.0" });
server.registerTool("graph_stats", { inputSchema: z.object({}).strict() }, async () => ({
  content: [{ type: "text", text: JSON.stringify({ generationPid: process.pid }) }],
}));
await server.connect(new StdioServerTransport());
`);
  return { root, fixturePath, logPath };
}

function createExitAfterResponseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-knowledge-exit-after-response-"));
  const fixturePath = path.join(root, "server.mjs");
  const logPath = path.join(root, "events.jsonl");
  fs.writeFileSync(fixturePath, `
import fs from "node:fs";
import { McpServer } from ${JSON.stringify(serverMcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(serverStdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};
const append = (event) => fs.appendFileSync(process.env.KNOWLEDGE_LIFECYCLE_LOG, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
append({ event: "start" });
const server = new McpServer({ name: "knowledge-exit-after-response-fixture", version: "0.0.0" });
server.registerTool("graph_stats", { inputSchema: z.object({}).strict() }, async () => {
  setTimeout(() => process.exit(0), 20);
  return { content: [{ type: "text", text: JSON.stringify({ generationPid: process.pid }) }] };
});
await server.connect(new StdioServerTransport());
`);
  return { root, fixturePath, logPath };
}

function createInitializationHangFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-knowledge-init-hang-"));
  const fixturePath = path.join(root, "server.mjs");
  const logPath = path.join(root, "events.jsonl");
  fs.writeFileSync(fixturePath, `
import fs from "node:fs";
const append = (event) => fs.appendFileSync(process.env.KNOWLEDGE_LIFECYCLE_LOG, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
append({ event: "start" });
process.on("SIGTERM", () => append({ event: "ignored-sigterm" }));
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
  return { root, fixturePath, logPath };
}

function processRecord(pid, parentPid, birthIdentity, command = "fixture") {
  return { pid, parentPid, birthIdentity, command };
}

function createFakeProcessControl(mode) {
  const scans = [];
  const signals = [];
  let rootAlive = true;
  let descendantDiscoveries = 0;
  const descendantPid = 424_242;
  const control = {
    platform: mode === "windows" ? "win32" : "linux",
    scanPosix(request) {
      scans.push({ ...request });
      const rootPid = request.rootPid;
      if (mode === "unavailable") {
        if (request.purpose === "capture-root") {
          return { available: true, records: [processRecord(rootPid, process.pid, "root-birth-a")] };
        }
        return { available: false, records: [], reason: "fixture process table unavailable" };
      }
      if (mode === "hung-scan") {
        if (request.purpose === "capture-root") {
          return { available: true, records: [processRecord(rootPid, process.pid, "root-birth-a")] };
        }
        return new Promise(() => {});
      }
      if (mode === "root-reuse") {
        const birthIdentity = request.purpose === "capture-root" ? "root-birth-a" : "root-birth-reused";
        return { available: true, records: [processRecord(rootPid, process.pid, birthIdentity, "unrelated replacement")] };
      }
      if (mode === "capture-reuse") {
        return { available: true, records: [processRecord(rootPid, process.pid, "root-birth-reused", "unrelated replacement")] };
      }
      if (mode === "descendant-reuse" || mode === "descendant-same-birth-reuse") {
        const tokenAssignment = `PICO_MCP_KNOWLEDGE_GENERATION_TOKEN=${request.ownershipToken}`;
        const records = rootAlive
          ? [processRecord(rootPid, process.pid, "root-birth-a")]
          : [];
        if (request.purpose === "discover-generation" && descendantDiscoveries++ === 0) {
          records.push(processRecord(descendantPid, rootPid, "descendant-birth-a", `node ${tokenAssignment}`));
        } else {
          records.push(processRecord(
            descendantPid,
            1,
            mode === "descendant-same-birth-reuse" ? "descendant-birth-a" : "descendant-birth-reused",
            "unrelated replacement",
          ));
        }
        return { available: true, records };
      }
      return { available: true, records: [] };
    },
    signalPosix(pid, signal) {
      signals.push({ pid, signal });
      if (pid !== descendantPid) rootAlive = false;
      return { delivered: true };
    },
    ...(mode === "capture-reuse" ? { inspectRootProcess: () => "exited" } : {}),
  };
  return { control, scans, signals, descendantPid };
}

async function cleanupLifecycleFixture(bridge, fixture, descendantPid) {
  await bridge.close().catch(() => undefined);
  if (descendantPid !== null) killFixturePid(descendantPid);
  const fixturePids = new Set(readEvents(fixture.logPath).map((event) => event.pid));
  for (const pid of fixturePids) killFixturePid(pid);
  await waitFor(
    () => [descendantPid, ...fixturePids].filter((pid) => pid !== null).every((pid) => !pidAlive(pid)),
    1_500,
    "a knowledge lifecycle fixture process survived emergency cleanup",
  );
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("KnowledgeBridge retires an inherited-stdio descendant and starts a fresh generation after timeout", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 10_000,
}, async () => {
  const fixture = createLifecycleFixture();

  const { KnowledgeBridge } = await import(`${knowledgeUrl}?lifecycle=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: {
      KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath,
      KNOWLEDGE_LIFECYCLE_FIRST_USE: fixture.firstUsePath,
      KNOWLEDGE_LIFECYCLE_DESCENDANT_PID: fixture.descendantPidPath,
    },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 250,
    retirementTimeoutMs: 1_000,
  });

  let descendantPid = null;
  try {
    const failed = await bridge.call("graph_stats", {});
    assert.equal(failed.status, "unavailable", JSON.stringify(failed));
    assert.equal(failed.lifecycleWarning, undefined, JSON.stringify(failed));
    assert.equal(fs.existsSync(fixture.descendantPidPath), true, "the fixture did not create its inherited-stdio descendant");
    descendantPid = Number(fs.readFileSync(fixture.descendantPidPath, "utf8"));

    await waitFor(
      () => !pidAlive(descendantPid),
      1_500,
      `retired generation descendant ${descendantPid} survived bounded cleanup: ${JSON.stringify(failed)}`,
    );

    const recovered = await bridge.call("graph_stats", {});
    assert.equal(recovered.status, "ok", JSON.stringify(recovered));
    assert.equal(recovered.lifecycleWarning, undefined, JSON.stringify(recovered));
    const payload = JSON.parse(recovered.text);
    const starts = readEvents(fixture.logPath).filter((event) => event.event === "start");
    assert.equal(starts.length, 2, JSON.stringify(readEvents(fixture.logPath)));
    assert.notEqual(payload.generationPid, starts[0].pid, "the failed generation was reused");
  } finally {
    await cleanupLifecycleFixture(bridge, fixture, descendantPid);
  }
});

test("KnowledgeBridge retires its exact root before restart when that root removed the ownership token", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 10_000,
}, async () => {
  const fixture = createTokenStrippingRootFixture();
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?token-strip=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: "/bin/sh",
    args: [
      "-c",
      'unset PICO_MCP_KNOWLEDGE_GENERATION_TOKEN; exec "$@"',
      "pico-knowledge-token-strip",
      process.execPath,
      fixture.fixturePath,
    ],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    retirementTimeoutMs: 1_000,
  });

  let firstPid = null;
  try {
    const first = await bridge.call("graph_stats", {});
    assert.equal(first.status, "ok", JSON.stringify(first));
    assert.equal(first.lifecycleWarning, undefined, JSON.stringify(first));
    firstPid = JSON.parse(first.text).generationPid;
    const firstStart = readEvents(fixture.logPath).find((event) => event.event === "start");
    assert.equal(firstStart?.pid, firstPid, JSON.stringify(readEvents(fixture.logPath)));
    assert.equal(firstStart?.tokenPresent, false, "the shell wrapper did not remove the ownership token");

    await bridge.close();
    assert.equal(
      readEvents(fixture.logPath).some((event) => event.pid === firstPid && event.event === "ignored-sigterm"),
      true,
      `token-stripped root ${firstPid} did not exercise the SIGTERM-resistant fixture path`,
    );
    assert.equal(pidAlive(firstPid), false, `bridge.close returned while token-stripped root ${firstPid} was still alive`);

    const recovered = await bridge.call("graph_stats", {});
    assert.equal(recovered.status, "ok", JSON.stringify(recovered));
    assert.equal(recovered.lifecycleWarning, undefined, JSON.stringify(recovered));
    const secondPid = JSON.parse(recovered.text).generationPid;
    assert.notEqual(secondPid, firstPid, "the retired generation was reused");
    assert.equal(pidAlive(firstPid), false, `old root ${firstPid} was alive after generation ${secondPid} started`);
  } finally {
    await cleanupLifecycleFixture(bridge, fixture, null);
  }
});

test("KnowledgeBridge blocks replacement when retirement cannot prove the old generation ended", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 10_000,
}, async () => {
  const fixture = createLifecycleFixture();
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?quarantine=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: {
      KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath,
      KNOWLEDGE_LIFECYCLE_FIRST_USE: fixture.firstUsePath,
      KNOWLEDGE_LIFECYCLE_DESCENDANT_PID: fixture.descendantPidPath,
    },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 250,
    // Deliberately too short for a bounded host process-table scan. This exercises the honest
    // quarantine branch rather than making a false process-retirement claim.
    retirementTimeoutMs: 1,
  });

  let descendantPid = null;
  try {
    const failed = await bridge.call("graph_stats", {});
    assert.equal(failed.status, "unavailable", JSON.stringify(failed));
    assert.match(failed.lifecycleWarning ?? "", /not fully observed|quarantined/i, JSON.stringify(failed));
    assert.equal(fs.existsSync(fixture.descendantPidPath), true, "the fixture did not create its inherited-stdio descendant");
    descendantPid = Number(fs.readFileSync(fixture.descendantPidPath, "utf8"));

    const blocked = await bridge.call("graph_stats", {});
    assert.equal(blocked.status, "unavailable", JSON.stringify(blocked));
    assert.match(blocked.lifecycleWarning ?? "", /not fully observed|quarantined|blocked/i, JSON.stringify(blocked));
    const starts = readEvents(fixture.logPath).filter((event) => event.event === "start");
    assert.equal(starts.length, 1, JSON.stringify(readEvents(fixture.logPath)));
  } finally {
    await cleanupLifecycleFixture(bridge, fixture, descendantPid);
  }
});

test("KnowledgeBridge never signals a reused root PID whose birth identity changed", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 12_000,
}, async () => {
  const fixture = createExitAfterResponseFixture();
  const fake = createFakeProcessControl("root-reuse");
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?root-reuse=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    retirementTimeoutMs: 1_000,
    processControl: fake.control,
  });

  try {
    const first = await bridge.call("graph_stats", {});
    assert.equal(first.status, "ok", JSON.stringify(first));
    const firstPid = JSON.parse(first.text).generationPid;
    await waitFor(() => !pidAlive(firstPid), 1_000, "the exact first root did not exit before the reuse mutation");
    await bridge.close();
    assert.ok(fake.scans.some((scan) => scan.purpose === "capture-root"), JSON.stringify(fake.scans));
    assert.equal(fake.signals.some((entry) => entry.pid === firstPid), false, JSON.stringify(fake.signals));
    const recovered = await bridge.call("graph_stats", {});
    assert.equal(recovered.status, "ok", JSON.stringify(recovered));
  } finally {
    await cleanupLifecycleFixture(bridge, fixture, null);
  }
});

test("KnowledgeBridge prevents SDK teardown from signalling a PID after root identity reuse", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 8_000,
}, async () => {
  const fixture = createTokenStrippingRootFixture();
  const fake = createFakeProcessControl("root-reuse");
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?sdk-root-reuse=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    retirementTimeoutMs: 1_000,
    processControl: fake.control,
  });
  let fixturePid = null;

  try {
    const first = await bridge.call("graph_stats", {});
    assert.equal(first.status, "ok", JSON.stringify(first));
    fixturePid = JSON.parse(first.text).generationPid;
    await bridge.close();
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    assert.equal(
      readEvents(fixture.logPath).some((event) => event.event === "ignored-sigterm"),
      false,
      "the SDK issued a delayed unchecked SIGTERM after the process table reported root PID reuse",
    );
    assert.equal(pidAlive(fixturePid), true, "the fake reused-PID victim was terminated outside the validated signal seam");
  } finally {
    if (fixturePid !== null) killFixturePid(fixturePid);
    await bridge.close().catch(() => undefined);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("KnowledgeBridge prevents SDK-internal startup cleanup from signalling a reused PID", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 8_000,
}, async () => {
  const fixture = createInitializationHangFixture();
  const fake = createFakeProcessControl("root-reuse");
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?sdk-startup-root-reuse=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 150,
    callTimeoutMs: 150,
    retirementTimeoutMs: 500,
    processControl: fake.control,
  });
  let fixturePid = null;

  try {
    const result = await bridge.call("graph_stats", {});
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    fixturePid = readEvents(fixture.logPath).find((event) => event.event === "start")?.pid ?? null;
    assert.ok(fixturePid, JSON.stringify(readEvents(fixture.logPath)));
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    assert.equal(
      readEvents(fixture.logPath).some((event) => event.event === "ignored-sigterm"),
      false,
      "SDK initialization cleanup issued a delayed unchecked SIGTERM",
    );
    assert.equal(pidAlive(fixturePid), true, "the fake reused-PID victim was terminated by SDK-internal cleanup");
    assert.deepEqual(fake.signals, []);
  } finally {
    if (fixturePid !== null) killFixturePid(fixturePid);
    await bridge.close().catch(() => undefined);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("KnowledgeBridge refuses a reused root row when the exact child handle reports exit before capture", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 5_000,
}, async () => {
  const fixture = createTokenStrippingRootFixture();
  const fake = createFakeProcessControl("capture-reuse");
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?capture-root-reuse=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 500,
    callTimeoutMs: 200,
    retirementTimeoutMs: 500,
    processControl: fake.control,
  });

  let fixturePid = null;
  try {
    const result = await bridge.call("graph_stats", {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    fixturePid = JSON.parse(result.text).generationPid;
    await bridge.close();
    assert.deepEqual(fake.signals, [], "a replacement occupying the just-exited root PID was signalled");
    assert.equal(
      fake.scans.some((scan) => scan.purpose === "discover-generation"),
      false,
      "retirement treated a post-exit PID-table row as the spawned root's captured identity",
    );
    const blocked = await bridge.call("graph_stats", {});
    assert.equal(blocked.status, "unavailable", JSON.stringify(blocked));
    assert.match(blocked.lifecycleWarning ?? "", /exact spawned root|identity|blocked|quarantined/i, JSON.stringify(blocked));
  } finally {
    if (fixturePid !== null) killFixturePid(fixturePid);
    await bridge.close().catch(() => undefined);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("KnowledgeBridge never signals a remembered descendant PID after birth-identity reuse", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 12_000,
}, async () => {
  const fixture = createTokenStrippingRootFixture();
  const fake = createFakeProcessControl("descendant-reuse");
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?descendant-reuse=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    retirementTimeoutMs: 1_000,
    processControl: fake.control,
  });

  let firstPid = null;
  try {
    const first = await bridge.call("graph_stats", {});
    assert.equal(first.status, "ok", JSON.stringify(first));
    firstPid = JSON.parse(first.text).generationPid;
    await bridge.close();
    assert.ok(fake.scans.some((scan) => scan.purpose === "validate-signal"), JSON.stringify(fake.scans));
    assert.equal(fake.signals.some((entry) => entry.pid === fake.descendantPid), false, JSON.stringify(fake.signals));
    assert.equal(fake.signals.some((entry) => entry.pid === firstPid), true, JSON.stringify(fake.signals));
  } finally {
    if (firstPid !== null) killFixturePid(firstPid);
    await bridge.close().catch(() => undefined);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("KnowledgeBridge requires the generation token before signalling a same-birth remembered descendant", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 12_000,
}, async () => {
  const fixture = createStableRootFixture();
  const fake = createFakeProcessControl("descendant-same-birth-reuse");
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?descendant-same-birth-reuse=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    retirementTimeoutMs: 1_000,
    processControl: fake.control,
  });

  try {
    assert.equal((await bridge.call("graph_stats", {})).status, "ok");
    await bridge.close();
    assert.equal(fake.signals.some((entry) => entry.pid === fake.descendantPid), false, JSON.stringify(fake.signals));
    const blocked = await bridge.call("graph_stats", {});
    assert.equal(blocked.status, "unavailable", JSON.stringify(blocked));
    assert.match(blocked.lifecycleWarning ?? "", /token|ownership|blocked|quarantined/i, JSON.stringify(blocked));
  } finally {
    await cleanupLifecycleFixture(bridge, fixture, null);
  }
});

test("KnowledgeBridge does not signal or replace when POSIX process identity is unavailable", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 10_000,
}, async () => {
  const fixture = createStableRootFixture();
  const fake = createFakeProcessControl("unavailable");
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?identity-unavailable=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    retirementTimeoutMs: 500,
    processControl: fake.control,
  });

  try {
    assert.equal((await bridge.call("graph_stats", {})).status, "ok");
    await bridge.close();
    assert.deepEqual(fake.signals, []);
    const blocked = await bridge.call("graph_stats", {});
    assert.equal(blocked.status, "unavailable", JSON.stringify(blocked));
    assert.match(blocked.lifecycleWarning ?? "", /identity|process table|quarantined|blocked/i, JSON.stringify(blocked));
    assert.equal(readEvents(fixture.logPath).filter((event) => event.event === "start").length, 1);
  } finally {
    await cleanupLifecycleFixture(bridge, fixture, null);
  }
});

test("KnowledgeBridge bounds a hung process-table provider and blocks replacement", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 5_000,
}, async () => {
  const fixture = createStableRootFixture();
  const fake = createFakeProcessControl("hung-scan");
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?identity-hung=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    retirementTimeoutMs: 500,
    processControl: fake.control,
  });
  let fixturePid = null;

  try {
    const first = await bridge.call("graph_stats", {});
    assert.equal(first.status, "ok", JSON.stringify(first));
    fixturePid = JSON.parse(first.text).generationPid;
    const closeResult = await Promise.race([
      bridge.close().then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 800)),
    ]);
    assert.equal(closeResult, "settled", "retirement inherited an unbounded process-table promise");
    assert.deepEqual(fake.signals, []);
    const blocked = await bridge.call("graph_stats", {});
    assert.equal(blocked.status, "unavailable", JSON.stringify(blocked));
    assert.match(blocked.lifecycleWarning ?? "", /process-table|provider|blocked|quarantined/i, JSON.stringify(blocked));
    assert.equal(readEvents(fixture.logPath).filter((event) => event.event === "start").length, 1);
  } finally {
    if (fixturePid !== null) killFixturePid(fixturePid);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("KnowledgeBridge simulated Windows retirement fails closed without numeric-PID signals", {
  skip: process.platform === "win32" ? "this is a structural simulation; native Windows evidence belongs to its separate lane" : false,
  timeout: 10_000,
}, async () => {
  const fixture = createStableRootFixture();
  const fake = createFakeProcessControl("windows");
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?windows-fail-closed=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: { KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    retirementTimeoutMs: 500,
    processControl: fake.control,
  });

  try {
    assert.equal((await bridge.call("graph_stats", {})).status, "ok");
    await bridge.close();
    assert.deepEqual(fake.signals, []);
    const blocked = await bridge.call("graph_stats", {});
    assert.equal(blocked.status, "unavailable", JSON.stringify(blocked));
    assert.match(blocked.lifecycleWarning ?? "", /Windows|birth identity|blocked|quarantined/i, JSON.stringify(blocked));
    assert.equal(readEvents(fixture.logPath).filter((event) => event.event === "start").length, 1);
  } finally {
    await cleanupLifecycleFixture(bridge, fixture, null);
  }
});

test("KnowledgeBridge rechecks a retirement block before a managed identity transition can spawn", {
  concurrency: false,
  timeout: 25_000,
}, () => {
  const harness = createManagedRuntimeHarness({ latestVersion: "0.4.1" });
  const picoCliUrl = pathToFileURL(path.join(repoRoot, "dist", "picocli.js")).href;
  const script = `
import fs from "node:fs";
const { KnowledgeBridge } = await import(${JSON.stringify(knowledgeUrl)});
const { ensurePicoCli } = await import(${JSON.stringify(picoCliUrl)});
const signals = [];
const processControl = {
  platform: "linux",
  scanPosix(request) {
    if (request.purpose === "capture-root") {
      return { available: true, records: [{
        pid: request.rootPid,
        parentPid: process.pid,
        birthIdentity: "managed-root-birth",
        command: "managed fixture",
      }] };
    }
    return { available: false, records: [], reason: "identity transition retirement unavailable" };
  },
  signalPosix(pid, signal) { signals.push({ pid, signal }); return { delivered: true }; },
};
const bridge = new KnowledgeBridge({
  startupTimeoutMs: 3000,
  callTimeoutMs: 2000,
  retirementTimeoutMs: 500,
  processControl,
});
const first = await bridge.call("graph_stats", {});
fs.writeFileSync(process.env.FAKE_LATEST_VERSION_FILE, "0.4.2");
const activated = await ensurePicoCli({ forceRefresh: true, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 });
const second = await bridge.call("graph_stats", {});
const events = fs.readFileSync(process.env.FAKE_KNOWLEDGE_LOG, "utf8").split("\\n").filter(Boolean).map(JSON.parse);
for (const pid of new Set(events.filter((event) => event.event === "start").map((event) => event.pid))) {
  try { process.kill(pid, "SIGKILL"); } catch {}
}
await bridge.close().catch(() => undefined);
process.stdout.write(JSON.stringify({ first, activated, second, events, signals }));
`;

  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const out = JSON.parse(child.stdout);
    assert.equal(out.first.status, "ok", JSON.stringify(out));
    assert.equal(out.activated.version, "0.4.2", JSON.stringify(out));
    assert.equal(out.second.status, "unavailable", JSON.stringify(out));
    assert.match(out.second.lifecycleWarning ?? "", /blocked|quarantined|not fully observed/i, JSON.stringify(out));
    assert.equal(out.events.filter((event) => event.event === "start").length, 1, JSON.stringify(out));
    assert.deepEqual(out.signals, []);
    assert.equal(harness.calls().some((call) => call.args.includes("setup")), false, JSON.stringify(harness.calls()));
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "managed startup drift",
    expectedFailureClass: "flag-or-version-drift",
    action: "graph_stats",
    input: {},
    startupTimeoutMs: 1_000,
    callTimeoutMs: 500,
    configure(harness, env) {
      const serverPath = path.join(harness.root, "knowledge-drift.mjs");
      fs.writeFileSync(serverPath, 'process.stderr.write("Error: unknown command dev-knowledge\\nUsage: pico-cli mcp\\n"); process.exit(2);\n');
      env.FAKE_KNOWLEDGE_SERVER = serverPath;
    },
  },
  {
    name: "managed startup timeout",
    expectedFailureClass: "timeout",
    action: "graph_stats",
    input: {},
    startupTimeoutMs: 200,
    callTimeoutMs: 500,
    configure(harness, env) {
      env.FAKE_KNOWLEDGE_STARTUP_HANG_ONCE_FILE = path.join(harness.root, "startup-timeout-once");
    },
  },
  {
    name: "managed call timeout",
    expectedFailureClass: "timeout",
    action: "query_graph",
    input: { question: "hang under managed provenance" },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 150,
    configure(harness, env) {
      env.FAKE_KNOWLEDGE_HANG_ONCE_FILE = path.join(harness.root, "call-timeout-once");
      env.FAKE_KNOWLEDGE_HANG_ACTION = "query_graph";
    },
  },
  {
    name: "managed protocol failure",
    expectedFailureClass: "runtime",
    action: "get_node",
    input: { label: "break managed protocol" },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    configure(harness, env) {
      env.FAKE_KNOWLEDGE_PROTOCOL_ONCE_FILE = path.join(harness.root, "protocol-failure-once");
      env.FAKE_KNOWLEDGE_PROTOCOL_ACTION = "get_node";
    },
  },
]) {
  test(`KnowledgeBridge returns provenance and classification for ${scenario.name}`, {
    concurrency: false,
    timeout: 25_000,
  }, async () => {
    const harness = createManagedRuntimeHarness({ latestVersion: "0.4.2" });
    const env = { ...harness.env };
    scenario.configure(harness, env);
    const script = `
const { KnowledgeBridge } = await import(${JSON.stringify(knowledgeUrl)});
const bridge = new KnowledgeBridge({
  startupTimeoutMs: ${scenario.startupTimeoutMs},
  callTimeoutMs: ${scenario.callTimeoutMs},
  retirementTimeoutMs: 1000,
});
let result;
try {
  result = await bridge.call(${JSON.stringify(scenario.action)}, ${JSON.stringify(scenario.input)});
} finally {
  await bridge.close();
}
process.stdout.write(JSON.stringify(result));
`;

    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const result = JSON.parse(child.stdout);
      assert.equal(result.status, "unavailable", JSON.stringify(result));
      assert.equal(result.failureClass, scenario.expectedFailureClass, JSON.stringify(result));
      assert.equal(result.picoCli?.source, "managed", JSON.stringify(result));
      assert.equal(result.picoCli?.policy, "managed-latest", JSON.stringify(result));
      assert.equal(result.picoCli?.version, "0.4.2", JSON.stringify(result));
      assert.equal(result.picoCli?.freshness, "latest", JSON.stringify(result));
      assert.equal(path.isAbsolute(result.picoCli?.path ?? ""), true, JSON.stringify(result));
      assert.equal(harness.calls().some((call) => call.args.includes("setup")), false, JSON.stringify(harness.calls()));
      const knowledgePids = new Set(harness.knowledgeCalls().map((event) => event.pid));
      await waitFor(
        () => [...knowledgePids].every((pid) => !pidAlive(pid)),
        1_500,
        `${scenario.name} left a managed knowledge fixture alive`,
      );
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  });
}

test("KnowledgeBridge retains managed execution guards through process retirement", {
  concurrency: false,
  timeout: 30_000,
}, async () => {
  const harness = createManagedRuntimeHarness({ latestVersion: "0.4.2" });
  const serverPath = path.join(harness.root, "mutating-knowledge-server.mjs");
  const mutationTarget = path.join(
    harness.managedRoot,
    "versions",
    "0.4.2",
    "node_modules",
    "@picoxr",
    "pico-cli",
    "package.json",
  );
  fs.writeFileSync(serverPath, `
import fs from "node:fs";
import { McpServer } from ${JSON.stringify(serverMcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(serverStdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};
const append = (event) => fs.appendFileSync(process.env.FAKE_KNOWLEDGE_LOG, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
append({ event: "start" });
process.on("exit", () => append({ event: "exit" }));
const server = new McpServer({ name: "managed-guard-knowledge-fixture", version: "0.0.0" });
server.registerTool("graph_stats", { inputSchema: z.object({}).strict() }, async () => {
  fs.appendFileSync(process.env.KNOWLEDGE_MANAGED_MUTATION_TARGET, "\\n ");
  return { content: [{ type: "text", text: JSON.stringify({ mutated: true, pid: process.pid }) }] };
});
await server.connect(new StdioServerTransport());
`);

  const script = `
const { KnowledgeBridge } = await import(${JSON.stringify(knowledgeUrl)});
const bridge = new KnowledgeBridge({ startupTimeoutMs: 3000, callTimeoutMs: 2000, retirementTimeoutMs: 2000 });
let first;
let second;
let observed;
try {
  first = await bridge.call("graph_stats", {});
  second = await bridge.call("graph_stats", {});
  await bridge.close();
  process.env.PICO_MCP_CLI_POLICY = "disabled";
  observed = await bridge.call("graph_stats", {});
} finally {
  await bridge.close();
}
process.stdout.write(JSON.stringify({ first, second, observed }));
`;

  let child;
  try {
    child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      env: {
        ...harness.env,
        FAKE_KNOWLEDGE_SERVER: serverPath,
        KNOWLEDGE_MANAGED_MUTATION_TARGET: mutationTarget,
      },
      encoding: "utf8",
      timeout: 25_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    assert.equal(result.first.status, "ok", JSON.stringify(result));
    assert.equal(JSON.parse(result.first.text).mutated, true, JSON.stringify(result));
    assert.equal(result.second.status, "unavailable", JSON.stringify(result));
    assert.equal(result.second.failureClass, "cli-unusable", JSON.stringify(result));
    assert.match(result.second.error, /failed content-bound immutable-store validation/i, JSON.stringify(result));
    assert.match(result.second.error, /remove both .* manually/i, JSON.stringify(result));
    assert.match(
      result.second.lifecycleWarning ?? "",
      /post-completion managed pico-cli validation failed/i,
      JSON.stringify(result),
    );
    assert.equal(result.observed.status, "unavailable", JSON.stringify(result));
    assert.equal(result.observed.failureClass, "cli-disabled", JSON.stringify(result));
    assert.match(
      result.observed.lifecycleWarning ?? "",
      /post-completion managed pico-cli validation failed/i,
      JSON.stringify(result),
    );
    assert.equal(
      harness.knowledgeCalls().filter((event) => event.event === "start").length,
      1,
      JSON.stringify(harness.knowledgeCalls()),
    );
    assert.equal(harness.calls().some((call) => call.args.includes("setup")), false, JSON.stringify(harness.calls()));
  } finally {
    const fixturePids = new Set(readEvents(harness.knowledgeLogPath).map((event) => event.pid));
    for (const pid of fixturePids) killFixturePid(pid);
    await waitFor(
      () => [...fixturePids].every((pid) => !pidAlive(pid)),
      1_500,
      "a managed Knowledge execution-guard fixture process survived emergency cleanup",
    );
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});
