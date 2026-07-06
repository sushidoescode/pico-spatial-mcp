import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: "/Users/sushantsrikrish/PICO-MCP" });
const c = new Client({ name: "cold", version: "0" });
await c.connect(t);

const tools = await c.listTools();
console.log("=== TOOLS (" + tools.tools.length + ") ===");
for (const tl of tools.tools) {
  console.log("- " + tl.name + ": " + (tl.description || "").slice(0, 300));
}

const prompts = await c.listPrompts();
console.log("\n=== PROMPTS (" + prompts.prompts.length + ") ===");
for (const p of prompts.prompts) {
  console.log("- " + p.name + ": " + (p.description || "").slice(0, 300));
}

await c.close();
process.exit(0);
