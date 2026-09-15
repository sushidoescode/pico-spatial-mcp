#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const logPath = process.env.FAKE_KNOWLEDGE_LOG;
const append = (event) => {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
};
const firstUse = (statePath) => {
  if (!statePath || fs.existsSync(statePath)) return false;
  fs.writeFileSync(statePath, String(process.pid));
  return true;
};

append({ event: "start" });
process.on("exit", () => append({ event: "exit" }));

if (process.env.FAKE_KNOWLEDGE_DECLARED_SHAPE === "cli-degraded-stub") {
  // The published pico-cli knowledge server's degraded mode, transcribed from the shipped bytes
  // (0.4.4 package/dist/index.js `Zw`, 0.5.0 package/dist/chunk-BLCMTNZL.js `Re` — both reached
  // from `serveGraphify` when no graph.json/workspace resolves). It is a raw stdio JSON-RPC
  // responder, not an McpServer: initialize succeeds, tools/list declares only an "[Unavailable]"
  // graph_stats, and every tools/call answers isError with the same sentence. The reason text is
  // the only version-specific part (0.4.4 reports a graph.json path or "current directory is not
  // a pico-cli setup project"; 0.5.0 reports its .pico-env.json diagnosis).
  const reason = process.env.FAKE_KNOWLEDGE_STUB_REASON ?? "graph.json not found at /missing/agent-vault/graphify-out/graph.json";
  const project = process.env.FAKE_KNOWLEDGE_STUB_PROJECT ?? process.cwd();
  const callText = `Knowledge graph not available (${reason}). Run \`pico-cli setup --project ${project}\` to initialize.`;
  const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === "initialize") {
      respond(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pico-dev-knowledge", version: "0.0.0" },
      });
    } else if (message.method === "notifications/initialized") {
      // no response, exactly as published
    } else if (message.method === "tools/list") {
      respond(message.id, {
        tools: [{
          name: "graph_stats",
          description: `[Unavailable] Knowledge graph not configured (${reason}). Run \`pico-cli setup --project ${project}\` to initialize.`,
          inputSchema: { type: "object", properties: {} },
        }],
      });
    } else if (message.method === "tools/call") {
      append({ event: "call", action: message.params?.name ?? null, args: message.params?.arguments ?? null, workspace: null });
      respond(message.id, { content: [{ type: "text", text: callText }], isError: true });
    } else if (message.id !== undefined) {
      respond(message.id, {});
    }
  });
  lines.on("close", () => process.exit(0));
} else if (firstUse(process.env.FAKE_KNOWLEDGE_STARTUP_HANG_ONCE_FILE)) {
  const delayedCloseMs = Number(process.env.FAKE_KNOWLEDGE_DELAYED_CLOSE_MS ?? 0);
  if (delayedCloseMs > 0) {
    process.on("SIGTERM", () => {
      append({ event: "sigterm" });
      setTimeout(() => process.exit(0), delayedCloseMs);
    });
  }
  setInterval(() => {}, 1_000);
} else {
  let workspace = "default";
  const server = new McpServer({ name: "fake-spatial-knowledge", version: "0.0.0" });
  const inputSchema = z.object({}).passthrough();
  const actions = [
    "query_graph",
    "get_node",
    "get_neighbors",
    "get_community",
    "god_nodes",
    "graph_stats",
    "shortest_path",
    "switch_workspace",
  ];

  for (const action of actions) {
    server.registerTool(action, { inputSchema }, async (args) => {
      append({ event: "call", action, args, workspace });

      if (action === process.env.FAKE_KNOWLEDGE_HANG_ACTION && firstUse(process.env.FAKE_KNOWLEDGE_HANG_ONCE_FILE)) {
        await new Promise(() => {});
      }
      if (action === process.env.FAKE_KNOWLEDGE_PROTOCOL_ACTION && firstUse(process.env.FAKE_KNOWLEDGE_PROTOCOL_ONCE_FILE)) {
        process.stdout.write("deliberately-not-json\n");
        setTimeout(() => process.exit(31), 10);
        await new Promise(() => {});
      }

      if (action === "switch_workspace") workspace = String(args.workspace);
      const text = args.question === "large output"
        ? "x".repeat(Number(process.env.FAKE_KNOWLEDGE_LARGE_CHARS ?? 20_000))
        : JSON.stringify({
            action,
            args,
            workspace,
            pid: process.pid,
            picoHome: process.env.PICO_HOME ?? null,
            testSecret: process.env.PICO_KNOWLEDGE_TEST_SECRET ?? null,
          });
      return { content: [{ type: "text", text }] };
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
