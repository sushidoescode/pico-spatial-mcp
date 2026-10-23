import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createManagedRuntimeHarness, writeCommand } from "./helpers/picocli-managed-fixture.mjs";

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

function createTokenStrippedDescendantFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-knowledge-tokenless-descendant-"));
  const fixturePath = path.join(root, "server.mjs");
  const descendantPidPath = path.join(root, "descendant.pid");
  const logPath = path.join(root, "events.jsonl");
  fs.writeFileSync(fixturePath, `
import { spawn } from "node:child_process";
import fs from "node:fs";
import { McpServer } from ${JSON.stringify(serverMcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(serverStdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const append = (event) => fs.appendFileSync(process.env.KNOWLEDGE_LIFECYCLE_LOG, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
append({ event: "start" });
const server = new McpServer({ name: "knowledge-tokenless-descendant-fixture", version: "0.0.0" });
server.registerTool("graph_stats", { inputSchema: z.object({}).strict() }, async () => {
  if (!fs.existsSync(process.env.KNOWLEDGE_LIFECYCLE_DESCENDANT_PID)) {
    const childEnv = { ...process.env };
    delete childEnv.PICO_MCP_KNOWLEDGE_GENERATION_TOKEN;
    const descendant = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
      env: childEnv,
      windowsHide: true,
    });
    fs.writeFileSync(process.env.KNOWLEDGE_LIFECYCLE_DESCENDANT_PID, String(descendant.pid));
    append({ event: "descendant", descendantPid: descendant.pid });
    descendant.unref();
  }
  return { content: [{ type: "text", text: JSON.stringify({ generationPid: process.pid }) }] };
});
await server.connect(new StdioServerTransport());
`);
  return { root, fixturePath, descendantPidPath, logPath };
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

test("KnowledgeBridge snapshots a token-stripped descendant before requesting root EOF", {
  skip: process.platform === "win32" ? "native Windows lifecycle evidence belongs to the separate Windows lane" : false,
  timeout: 10_000,
}, async () => {
  const fixture = createTokenStrippedDescendantFixture();
  const { KnowledgeBridge } = await import(`${knowledgeUrl}?tokenless-descendant-snapshot=${Date.now()}`);
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fixture.fixturePath],
    cwd: repoRoot,
    env: {
      KNOWLEDGE_LIFECYCLE_LOG: fixture.logPath,
      KNOWLEDGE_LIFECYCLE_DESCENDANT_PID: fixture.descendantPidPath,
    },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 500,
    retirementTimeoutMs: 1_000,
  });

  let descendantPid = null;
  try {
    const first = await bridge.call("graph_stats", {});
    assert.equal(first.status, "ok", JSON.stringify(first));
    assert.equal(fs.existsSync(fixture.descendantPidPath), true, "the fixture did not publish its descendant PID");
    descendantPid = Number(fs.readFileSync(fixture.descendantPidPath, "utf8"));
    assert.equal(pidAlive(descendantPid), true, "the token-stripped descendant was not alive before retirement");

    await bridge.close();
    assert.equal(pidAlive(descendantPid), true, "retirement sent an unsafe signal to the token-stripped descendant");
    const blocked = await bridge.call("graph_stats", {});
    assert.equal(blocked.status, "unavailable", JSON.stringify(blocked));
    assert.match(blocked.lifecycleWarning ?? "", /token|ownership|blocked|quarantined/i, JSON.stringify(blocked));
    assert.equal(readEvents(fixture.logPath).filter((event) => event.event === "start").length, 1);
  } finally {
    await cleanupLifecycleFixture(bridge, fixture, descendantPid);
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

  let fixturePid = null;
  try {
    const first = await bridge.call("graph_stats", {});
    assert.equal(first.status, "ok", JSON.stringify(first));
    fixturePid = JSON.parse(first.text).generationPid;
    await bridge.close();
    await waitFor(
      () => !pidAlive(fixturePid),
      1_000,
      "the exact EOF-responsive Knowledge child survived identity-unavailable retirement",
    );
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

  let fixturePid = null;
  try {
    const first = await bridge.call("graph_stats", {});
    assert.equal(first.status, "ok", JSON.stringify(first));
    fixturePid = JSON.parse(first.text).generationPid;
    await bridge.close();
    await waitFor(
      () => !pidAlive(fixturePid),
      1_000,
      "the exact EOF-responsive Knowledge child survived simulated-Windows retirement",
    );
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

// ---------------------------------------------------------------------------------------------
// Task C2 — the managed transport dispatches the route the resolved CLI actually advertises.
//
// Every help reply below is a byte-for-byte retained observation (test/fixtures/picocli/help,
// indexed against evidence/2026-09-15-cli050-sdk61-evolution-audit-001/RAW_HELP_INDEX_002.json)
// replayed by a real fake child process, so argv selection is exercised on real CLI bytes.
// ---------------------------------------------------------------------------------------------

const helpFixtureRoot = path.join(repoRoot, "test", "fixtures", "picocli", "help");
const helpIndex = JSON.parse(fs.readFileSync(path.join(helpFixtureRoot, "index.json"), "utf8"));

function helpReplay(version, invocation) {
  const entry = helpIndex.entries.find((item) => item.version === version && item.invocation === invocation);
  assert.ok(entry, `missing help fixture ${version}/${invocation}`);
  return {
    stdoutFile: path.join(helpFixtureRoot, entry.files["stdout.txt"]),
    stderrFile: path.join(helpFixtureRoot, entry.files["stderr.txt"]),
    code: entry.code,
  };
}

const HELP_MAPS = {
  "0.4.4": {
    "mcp dev-knowledge": helpReplay("0.4.4", "062"),
    "app watch-crash": helpReplay("0.4.4", "025"),
    "capture record": helpReplay("0.4.4", "026"),
    // Source-inspected (PERF_ENV044): every 0.4.4 perf argv stops at the utilities gate before
    // delegation; invocation 012 (`perf --help`, exit 1) supplies the exact bytes.
    "perf trace record": helpReplay("0.4.4", "012"),
    "perf trace decode": helpReplay("0.4.4", "012"),
    "perf trace load": helpReplay("0.4.4", "012"),
    "perf trace query": helpReplay("0.4.4", "012"),
  },
  "0.5.0": {
    "knowledge server": helpReplay("0.5.0", "136"),
    "app watch-crash": helpReplay("0.5.0", "096"),
    "capture record": helpReplay("0.5.0", "097"),
    // Source-inspected (PERF_ROUTER050/PERF_ENV050): the child help stops at the utilities gate;
    // invocations 139 (`perf live --help`) and 141 (`perf trace --help`) are the exact exit-3 bytes.
    "perf live run": helpReplay("0.5.0", "139"),
    "perf trace record": helpReplay("0.5.0", "141"),
    "perf trace decode": helpReplay("0.5.0", "141"),
    "perf trace load": helpReplay("0.5.0", "141"),
    "perf trace query": helpReplay("0.5.0", "141"),
  },
};

/** Managed child spawns that are not the `-v` probe and not a bounded `--help` discovery probe. */
function knowledgeSpawns(harness) {
  return harness.calls()
    .filter((call) => call.role === "managed-cli")
    .map((call) => ({ version: call.args[0], args: call.args.slice(1) }))
    .filter((call) => call.args.at(-1) !== "--help" && call.args[0] !== "-v");
}

function runBridgeScript(harness, body, { env = {}, timeout = 25_000, cwd = repoRoot } = {}) {
  const script = `
const { KnowledgeBridge } = await import(${JSON.stringify(knowledgeUrl)});
${body}
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd,
    env: { ...harness.env, ...env },
    encoding: "utf8",
    timeout,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

const SINGLE_CALL_BODY = `
const bridge = new KnowledgeBridge({ startupTimeoutMs: 5000, callTimeoutMs: 2000, retirementTimeoutMs: 2000 });
let result;
try {
  result = await bridge.call("graph_stats", {});
} finally {
  await bridge.close().catch(() => undefined);
}
process.stdout.write(JSON.stringify(result));
`;

function cleanupManagedHarness(harness) {
  for (const pid of new Set(readEvents(harness.knowledgeLogPath).map((event) => event.pid))) killFixturePid(pid);
  fs.rmSync(harness.root, { recursive: true, force: true });
}

test("managed knowledge transport spawns only the capability-proven route for each CLI identity", {
  concurrency: false,
  timeout: 120_000,
}, async () => {
  const harnesses = [];
  try {
    // 0.5.0: the canonical route is `knowledge server` (retained invocation 136; the spaced
    // `mcp dev-knowledge` route was removed on this line, excerpt K050).
    const h050 = createManagedRuntimeHarness({ latestVersion: "0.5.0", helpMap: HELP_MAPS["0.5.0"] });
    harnesses.push(h050);
    const result050 = runBridgeScript(h050, SINGLE_CALL_BODY);
    assert.equal(result050.status, "ok", JSON.stringify(result050));
    assert.equal(result050.picoCli?.version, "0.5.0", JSON.stringify(result050));
    const spawnsFor050 = knowledgeSpawns(h050);

    // 0.4.4: the same operation routes through `mcp dev-knowledge` (retained invocation 062, K044).
    const h044 = createManagedRuntimeHarness({ latestVersion: "0.4.4", helpMap: HELP_MAPS["0.4.4"] });
    harnesses.push(h044);
    const result044 = runBridgeScript(h044, SINGLE_CALL_BODY);
    assert.equal(result044.status, "ok", JSON.stringify(result044));
    assert.equal(result044.picoCli?.version, "0.4.4", JSON.stringify(result044));
    const spawnsFor044 = knowledgeSpawns(h044);

    // An unclassifiable help leaves the operation `unknown`: no child may be started from it, and
    // no other alias may be tried instead.
    const unknownHarness = createManagedRuntimeHarness({
      latestVersion: "0.5.0",
      helpMap: { ...HELP_MAPS["0.5.0"], "knowledge server": { stdout: "fixture reply with no help section at all\n", code: 0 } },
    });
    harnesses.push(unknownHarness);
    const unknownResult = runBridgeScript(unknownHarness, SINGLE_CALL_BODY);
    const unknownCapabilitySpawns = knowledgeSpawns(unknownHarness);

    // A CLI that renders its `knowledge` parent help for the route (retained invocation 080) is a
    // terminal answer: the route is not there, so there is nothing to retry.
    const parentHelpHarness = createManagedRuntimeHarness({
      latestVersion: "0.5.0",
      helpMap: { ...HELP_MAPS["0.5.0"], "knowledge server": helpReplay("0.5.0", "080") },
    });
    harnesses.push(parentHelpHarness);
    const parentHelpResult = runBridgeScript(parentHelpHarness, SINGLE_CALL_BODY);

    // An explicitly configured command/args pair bypasses capability selection entirely.
    const externalHarness = createManagedRuntimeHarness({ latestVersion: "0.5.0", helpMap: HELP_MAPS["0.5.0"] });
    harnesses.push(externalHarness);
    const recorderPath = path.join(externalHarness.root, "external-recorder.mjs");
    const externalLog = path.join(externalHarness.root, "external-spawns.jsonl");
    fs.writeFileSync(recorderPath, `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
fs.appendFileSync(process.env.EXTERNAL_SPAWN_LOG, JSON.stringify({ args: process.argv.slice(3) }) + "\\n");
await import(pathToFileURL(process.env.FAKE_KNOWLEDGE_SERVER).href);
await new Promise(() => {});
`);
    const externalCommand = writeCommand(externalHarness.binDir, "custom-knowledge", recorderPath, "record");
    const externalResult = runBridgeScript(externalHarness, `
const bridge = new KnowledgeBridge({
  command: ${JSON.stringify(externalCommand)},
  args: ["custom-server", "--stdio"],
  startupTimeoutMs: 5000,
  callTimeoutMs: 2000,
  retirementTimeoutMs: 2000,
});
let result;
try {
  result = await bridge.call("graph_stats", {});
} finally {
  await bridge.close().catch(() => undefined);
}
process.stdout.write(JSON.stringify(result));
`, { env: { EXTERNAL_SPAWN_LOG: externalLog } });
    assert.equal(externalResult.status, "ok", JSON.stringify(externalResult));
    assert.equal(Object.hasOwn(externalResult, "picoCli"), false, "a configured command must not resolve the managed CLI");
    const externalSpawn = readEvents(externalLog).at(0);

    assert.deepEqual(spawnsFor050.map((x) => x.args), [["knowledge", "server"]]);
    assert.deepEqual(spawnsFor044.map((x) => x.args), [["mcp", "dev-knowledge"]]);
    assert.equal(unknownCapabilitySpawns.length, 0);
    assert.deepEqual(externalSpawn.args, ["custom-server", "--stdio"]);

    // The refusal is structured, names the capability reason and its retained evidence, and never
    // falls back to the other line's route.
    assert.equal(unknownResult.status, "unavailable", JSON.stringify(unknownResult));
    assert.match(unknownResult.error, /knowledge transport unavailable/i, JSON.stringify(unknownResult));
    assert.equal(unknownResult.transport?.operation, "knowledge-server", JSON.stringify(unknownResult));
    assert.equal(unknownResult.transport?.state, "unknown", JSON.stringify(unknownResult));
    assert.match(unknownResult.transport?.reason ?? "", /^malformed-help:/, JSON.stringify(unknownResult));
    assert.deepEqual(unknownResult.transport?.argvPrefix, ["knowledge", "server"]);
    assert.ok((unknownResult.transport?.evidence ?? []).length >= 2, JSON.stringify(unknownResult));
    for (const evidence of unknownResult.transport.evidence) {
      assert.equal(path.isAbsolute(evidence), true, evidence);
      assert.equal(fs.existsSync(evidence), true, evidence);
    }
    assert.equal(unknownResult.picoCli?.version, "0.5.0", JSON.stringify(unknownResult));
    assert.equal(readEvents(unknownHarness.knowledgeLogPath).length, 0, "a refused transport must start no child");
    const unknownLedger = unknownHarness.calls().map((call) => call.args.join(" "));
    assert.equal(unknownLedger.some((argv) => /(^|\s)mcp dev-knowledge(\s|$)/.test(argv)), false, JSON.stringify(unknownLedger));
    assert.equal(unknownLedger.some((argv) => /:/.test(argv.split(" ")[1] ?? "")), false, "no colon alias may be retried");
    assert.equal(
      unknownHarness.calls().filter((call) => call.role === "npm" && call.args[0] === "view").length,
      1,
      "an evidence-backed unknown must not trigger a second registry resolution",
    );

    assert.equal(parentHelpResult.status, "unavailable", JSON.stringify(parentHelpResult));
    assert.equal(parentHelpResult.transport?.state, "unavailable", JSON.stringify(parentHelpResult));
    assert.match(parentHelpResult.transport?.reason ?? "", /^generic-parent-help:/, JSON.stringify(parentHelpResult));
    assert.equal(parentHelpResult.failureClass, "cli-unusable", JSON.stringify(parentHelpResult));
    assert.equal(knowledgeSpawns(parentHelpHarness).length, 0, JSON.stringify(knowledgeSpawns(parentHelpHarness)));
    assert.equal(readEvents(parentHelpHarness.knowledgeLogPath).length, 0, "a terminal refusal must start no child");
    for (const harness of [h050, h044]) {
      assert.equal(harness.calls().some((call) => call.args.includes("setup")), false, JSON.stringify(harness.calls()));
    }
  } finally {
    for (const harness of harnesses) cleanupManagedHarness(harness);
  }
});

test("a managed startup failure never retries another knowledge alias", {
  concurrency: false,
  timeout: 40_000,
}, async () => {
  const harness = createManagedRuntimeHarness({ latestVersion: "0.5.0", helpMap: HELP_MAPS["0.5.0"] });
  const serverPath = path.join(harness.root, "rejecting-knowledge-server.mjs");
  fs.writeFileSync(serverPath, 'process.stderr.write("Error: unknown command server\\nUsage: pico-cli knowledge\\n"); process.exit(2);\n');
  try {
    const result = runBridgeScript(harness, SINGLE_CALL_BODY, { env: { FAKE_KNOWLEDGE_SERVER: serverPath } });
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    assert.equal(result.failureClass, "flag-or-version-drift", JSON.stringify(result));
    assert.equal(result.transport, undefined, "a server-side rejection is a startup failure, not a capability refusal");
    assert.match(result.outputTail ?? "", /unknown command server/, JSON.stringify(result));
    assert.deepEqual(knowledgeSpawns(harness).map((call) => call.args), [["knowledge", "server"]]);
  } finally {
    cleanupManagedHarness(harness);
  }
});

test("missing knowledge data and a transport startup failure stay distinct structured results", {
  concurrency: false,
  timeout: 60_000,
}, async () => {
  const dataHarness = createManagedRuntimeHarness({ latestVersion: "0.5.0", helpMap: HELP_MAPS["0.5.0"] });
  const startupHarness = createManagedRuntimeHarness({ latestVersion: "0.5.0", helpMap: HELP_MAPS["0.5.0"] });
  try {
    // The published knowledge server answers every tools/call with this exact sentence when it
    // resolves no graph/workspace. The transport started; the data is missing.
    const missingData = runBridgeScript(dataHarness, SINGLE_CALL_BODY, {
      env: {
        FAKE_KNOWLEDGE_DECLARED_SHAPE: "cli-degraded-stub",
        FAKE_KNOWLEDGE_STUB_REASON: "[0.13] not found. global .pico-env.json (/home/fixture/.pico/.pico-env.json) is stale. Fix: run `pico-cli setup --project .` (local) or `pico-cli setup` (global).",
        FAKE_KNOWLEDGE_STUB_PROJECT: "/fixture/project",
      },
    });
    assert.equal(missingData.status, "unavailable", JSON.stringify(missingData));
    assert.equal(missingData.remoteError, true, JSON.stringify(missingData));
    assert.equal(missingData.transport, undefined, "missing data is not a transport refusal");
    assert.equal(missingData.failureClass, undefined, "a started server is not a CLI failure class");
    assert.equal(missingData.knowledgeData?.available, false, JSON.stringify(missingData));
    assert.match(missingData.knowledgeData?.reason ?? "", /^\[0\.13\] not found\./, JSON.stringify(missingData));
    assert.match(missingData.knowledgeData?.reason ?? "", /\.pico-env\.json/, JSON.stringify(missingData));
    assert.equal(
      missingData.knowledgeData?.remediation,
      "Run `pico-cli setup --project /fixture/project` to initialize.",
      JSON.stringify(missingData),
    );
    assert.equal(missingData.picoCli?.version, "0.5.0", JSON.stringify(missingData));
    assert.equal(missingData.picoCli?.source, "managed", JSON.stringify(missingData));
    assert.deepEqual(knowledgeSpawns(dataHarness).map((call) => call.args), [["knowledge", "server"]]);

    // The same identity, but the child never completes its handshake: a transport startup failure.
    const startupServer = path.join(startupHarness.root, "exiting-knowledge-server.mjs");
    fs.writeFileSync(startupServer, 'process.stderr.write("fixture: knowledge server crashed before handshake\\n"); process.exit(9);\n');
    const startupFailure = runBridgeScript(startupHarness, SINGLE_CALL_BODY, { env: { FAKE_KNOWLEDGE_SERVER: startupServer } });
    assert.equal(startupFailure.status, "unavailable", JSON.stringify(startupFailure));
    assert.equal(startupFailure.knowledgeData, undefined, "a startup failure is not a knowledge-data gap");
    assert.equal(startupFailure.transport, undefined, JSON.stringify(startupFailure));
    assert.equal(startupFailure.remoteError, undefined, JSON.stringify(startupFailure));
    assert.equal(startupFailure.failureClass, "runtime", JSON.stringify(startupFailure));
    assert.match(startupFailure.outputTail ?? "", /crashed before handshake/, JSON.stringify(startupFailure));
    assert.equal(startupFailure.picoCli?.version, "0.5.0", JSON.stringify(startupFailure));
  } finally {
    cleanupManagedHarness(dataHarness);
    cleanupManagedHarness(startupHarness);
  }
});

test("a knowledge server that stops at the environment gate returns the exact PICO_HOME remedy", {
  concurrency: false,
  timeout: 40_000,
}, async () => {
  const harness = createManagedRuntimeHarness({ latestVersion: "0.5.0", helpMap: HELP_MAPS["0.5.0"] });
  const serverPath = path.join(harness.root, "environment-gated-knowledge-server.mjs");
  // Source-derived text (the 0.5.0 environment gate template, PERF_ENV050), not a retained
  // observation: no knowledge-server run has been observed hitting this gate.
  fs.writeFileSync(serverPath, 'process.stderr.write("[warn] PICO_HOME is not set\\n"); process.exit(1);\n');
  try {
    const result = runBridgeScript(harness, SINGLE_CALL_BODY, { env: { FAKE_KNOWLEDGE_SERVER: serverPath } });
    assert.equal(result.status, "unavailable", JSON.stringify(result));
    assert.equal(result.failureClass, "environment", JSON.stringify(result));
    assert.match(result.error, /PICO_HOME/, JSON.stringify(result));
    assert.match(result.error, /absolute PICO SDK root/, JSON.stringify(result));
    assert.doesNotMatch(result.error, /pico-cli\s+setup/, "an unset environment root is not evidence of a missing payload");
    assert.equal(result.setupCommand, undefined, JSON.stringify(result));
    assert.match(result.outputTail ?? "", /PICO_HOME is not set/, JSON.stringify(result));
    assert.deepEqual(knowledgeSpawns(harness).map((call) => call.args), [["knowledge", "server"]]);
  } finally {
    cleanupManagedHarness(harness);
  }
});

test("the canonical managed route keeps cold startup, concurrency, output caps and EOF retirement", {
  concurrency: false,
  timeout: 60_000,
}, async () => {
  const harness = createManagedRuntimeHarness({ latestVersion: "0.5.0", helpMap: HELP_MAPS["0.5.0"] });
  try {
    const out = runBridgeScript(harness, `
import fs from "node:fs";
const bridge = new KnowledgeBridge({ startupTimeoutMs: 5000, callTimeoutMs: 2000, retirementTimeoutMs: 2000, maxOutputBytes: 1024 });
const cold = await bridge.call("graph_stats", {});
const concurrent = await Promise.all([
  bridge.call("graph_stats", {}),
  bridge.call("get_node", { label: "Entity" }),
  bridge.call("god_nodes", { top_n: 3 }),
]);
const capped = await bridge.call("query_graph", { question: "large output" });
const timedOut = await bridge.call("get_community", { community_id: 1 });
const beforeClose = fs.readFileSync(process.env.FAKE_KNOWLEDGE_LOG, "utf8").split("\\n").filter(Boolean).map(JSON.parse);
const recovered = await bridge.call("graph_stats", {});
await bridge.close();
const afterClose = fs.readFileSync(process.env.FAKE_KNOWLEDGE_LOG, "utf8").split("\\n").filter(Boolean).map(JSON.parse);
process.stdout.write(JSON.stringify({ cold, concurrent, capped, timedOut, recovered, beforeClose, afterClose }));
`, {
      env: {
        FAKE_KNOWLEDGE_LARGE_CHARS: "8000",
        FAKE_KNOWLEDGE_HANG_ONCE_FILE: path.join(harness.root, "hang-once"),
        FAKE_KNOWLEDGE_HANG_ACTION: "get_community",
      },
      timeout: 40_000,
    });

    assert.equal(out.cold.status, "ok", JSON.stringify(out.cold));
    assert.ok(out.concurrent.every((result) => result.status === "ok"), JSON.stringify(out.concurrent));
    const pids = new Set([out.cold, ...out.concurrent].map((result) => JSON.parse(result.text).pid));
    assert.equal(pids.size, 1, "concurrent callers share one generation");
    assert.equal(out.beforeClose.filter((event) => event.event === "start").length, 1, JSON.stringify(out.beforeClose));
    assert.equal(out.capped.status, "ok", JSON.stringify(out.capped));
    assert.equal(out.capped.truncated, true, JSON.stringify(out.capped));
    assert.equal(Buffer.byteLength(out.capped.text, "utf8") <= 1024, true, String(out.capped.text.length));
    assert.equal(out.timedOut.status, "unavailable", JSON.stringify(out.timedOut));
    assert.equal(out.timedOut.failureClass, "timeout", JSON.stringify(out.timedOut));
    assert.equal(out.recovered.status, "ok", JSON.stringify(out.recovered));
    assert.notEqual(JSON.parse(out.recovered.text).pid, [...pids][0], "the timed-out generation must not be reused");
    assert.equal(out.afterClose.filter((event) => event.event === "exit").length >= 1, true, JSON.stringify(out.afterClose));
    assert.deepEqual(
      knowledgeSpawns(harness).map((call) => call.args),
      [["knowledge", "server"], ["knowledge", "server"]],
      "the timed-out generation is retired and replaced through the same capability-proven route",
    );
    const startPids = new Set(readEvents(harness.knowledgeLogPath).filter((event) => event.event === "start").map((event) => event.pid));
    await waitFor(() => [...startPids].every((pid) => !pidAlive(pid)), 2_000, "a managed knowledge generation survived close");
  } finally {
    cleanupManagedHarness(harness);
  }
});

test("a started knowledge transport declares no graph API of its own", { timeout: 20_000 }, async () => {
  // Graph-API reconciliation against the published bytes: the only knowledge-server tool
  // declaration inside @picoxr/pico-cli 0.4.4/0.5.0 is the degraded server's. The provisioned
  // server's declarations live in the external `graphify` binary the CLI spawns
  // (`graphify serve --graph <graph.json> --workspace <dir>`), so a successful transport start
  // establishes neither our eight actions' input shapes nor any SDK declaration.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico knowledge declarations "));
  const logPath = path.join(tempRoot, "server.jsonl");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "test", "fixtures", "fake-knowledge-server.mjs")],
    env: {
      ...process.env,
      FAKE_KNOWLEDGE_LOG: logPath,
      FAKE_KNOWLEDGE_DECLARED_SHAPE: "cli-degraded-stub",
      FAKE_KNOWLEDGE_STUB_REASON: "current directory is not a pico-cli setup project",
      FAKE_KNOWLEDGE_STUB_PROJECT: "/fixture/project",
    },
  });
  const client = new Client({ name: "c2-declaration-probe", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: 5_000, maxTotalTimeout: 5_000 });
    const listed = await client.listTools(undefined, { timeout: 5_000, maxTotalTimeout: 5_000 });
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["graph_stats"]);
    assert.equal(
      listed.tools[0].description,
      "[Unavailable] Knowledge graph not configured (current directory is not a pico-cli setup project). Run `pico-cli setup --project /fixture/project` to initialize.",
    );
    assert.deepEqual(listed.tools[0].inputSchema, { type: "object", properties: {} });
    const declared = new Set(listed.tools.map((tool) => tool.name));
    for (const action of ["query_graph", "get_node", "get_neighbors", "get_community", "god_nodes", "shortest_path", "switch_workspace"]) {
      assert.equal(declared.has(action), false, `${action} must not be treated as declared by a started transport`);
    }
    const called = await client.callTool({ name: "graph_stats", arguments: {} }, undefined, { timeout: 5_000, maxTotalTimeout: 5_000 });
    assert.equal(called.isError, true, JSON.stringify(called));
    assert.equal(
      called.content[0].text,
      "Knowledge graph not available (current directory is not a pico-cli setup project). Run `pico-cli setup --project /fixture/project` to initialize.",
    );
  } finally {
    await client.close().catch(() => undefined);
    for (const pid of new Set(readEvents(logPath).map((event) => event.pid))) killFixturePid(pid);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the exported legacy knowledge default is the 0.4.x route-table entry, not a second literal", async () => {
  const [{ DEFAULT_KNOWLEDGE_ARGS, DEFAULT_KNOWLEDGE_COMMAND }, { cliOperationRoutes }] = await Promise.all([
    import(pathToFileURL(path.join(repoRoot, "dist", "knowledge.js")).href),
    import(pathToFileURL(path.join(repoRoot, "dist", "clicapabilities.js")).href),
  ]);
  const route = cliOperationRoutes("0.4.4").find((candidate) => candidate.operation === "knowledge-server");
  assert.equal(DEFAULT_KNOWLEDGE_COMMAND, "pico-cli");
  assert.deepEqual([...DEFAULT_KNOWLEDGE_ARGS], route.argvPrefix);
  assert.deepEqual([...DEFAULT_KNOWLEDGE_ARGS], ["mcp", "dev-knowledge"]);
  const source = fs.readFileSync(path.join(repoRoot, "src", "knowledge.ts"), "utf8");
  assert.equal(/\[\s*"mcp"\s*,\s*"dev-knowledge"\s*\]/.test(source), false, "the route literal belongs to the capability route table only");
});

test("managed knowledge checks the actual child environment and selected project config before spawn", {
  concurrency: false,
  timeout: 90_000,
}, async () => {
  const harnesses=[];
  try {
    for(const variant of ["same-selection", "different-project-config", "different-environment"]) {
      const harness=createManagedRuntimeHarness({latestVersion:"0.5.0",helpMap:HELP_MAPS["0.5.0"]});
      harnesses.push(harness);
      const cwd=path.join(harness.root,"knowledge-project"); fs.mkdirSync(cwd);
      if(variant==="different-project-config") fs.writeFileSync(path.join(cwd,".pico-env.json"),JSON.stringify({version:"0.99",platform:"spatial"}));
      const options={cwd,startupTimeoutMs:5000,callTimeoutMs:2000,retirementTimeoutMs:2000,
        ...(variant==="different-environment"?{env:{PICO_HOME:path.join(harness.root,"other-sdk")}}:{})};
      const result=runBridgeScript(harness, `
const bridge=new KnowledgeBridge(${JSON.stringify(options)});
let result;
try { result=await bridge.call("graph_stats",{}); } finally { await bridge.close().catch(()=>undefined); }
process.stdout.write(JSON.stringify(result));
`, { cwd: harness.root });
      if(variant==="same-selection") {
        assert.equal(result.status,"ok",JSON.stringify(result));
        assert.equal(knowledgeSpawns(harness).length,1);
      } else {
        assert.notEqual(result.status,"ok",JSON.stringify(result));
        assert.match(JSON.stringify(result),/selected utility\/environment identity changed/);
        assert.equal(knowledgeSpawns(harness).length,0,"a mismatched actual child selection cannot spawn");
      }
    }
  } finally { for(const harness of harnesses) cleanupManagedHarness(harness); }
});
