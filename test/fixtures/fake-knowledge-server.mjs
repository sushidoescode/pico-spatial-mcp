#!/usr/bin/env node

import fs from "node:fs";
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

if (firstUse(process.env.FAKE_KNOWLEDGE_STARTUP_HANG_ONCE_FILE)) {
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
