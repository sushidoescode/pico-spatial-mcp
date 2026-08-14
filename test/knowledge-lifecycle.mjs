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

test("KnowledgeBridge quarantines unproved retirement without poisoning the next generation", {
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

    const recovered = await bridge.call("graph_stats", {});
    assert.equal(recovered.status, "ok", JSON.stringify(recovered));
    assert.match(recovered.lifecycleWarning ?? "", /not fully observed|quarantined/i, JSON.stringify(recovered));
    const starts = readEvents(fixture.logPath).filter((event) => event.event === "start");
    assert.equal(starts.length, 2, JSON.stringify(readEvents(fixture.logPath)));
    assert.notEqual(JSON.parse(recovered.text).generationPid, starts[0].pid, "the quarantined generation was reused");
  } finally {
    await cleanupLifecycleFixture(bridge, fixture, descendantPid);
  }
});

test("KnowledgeBridge retains managed execution guards through process retirement", {
  concurrency: false,
  timeout: 30_000,
}, () => {
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
let observed;
try {
  first = await bridge.call("graph_stats", {});
  await bridge.close();
  process.env.PICO_MCP_CLI_POLICY = "disabled";
  observed = await bridge.call("graph_stats", {});
} finally {
  await bridge.close();
}
process.stdout.write(JSON.stringify({ first, observed }));
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
    assert.equal(result.observed.status, "unavailable", JSON.stringify(result));
    assert.equal(result.observed.failureClass, "cli-disabled", JSON.stringify(result));
    assert.match(
      result.observed.lifecycleWarning ?? "",
      /post-completion managed pico-cli validation failed/i,
      JSON.stringify(result),
    );
    assert.equal(harness.calls().some((call) => call.args.includes("setup")), false, JSON.stringify(harness.calls()));
  } finally {
    const fixturePids = new Set(readEvents(harness.knowledgeLogPath).map((event) => event.pid));
    for (const pid of fixturePids) killFixturePid(pid);
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});
