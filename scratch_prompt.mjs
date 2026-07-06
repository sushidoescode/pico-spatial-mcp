import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: "/Users/sushantsrikrish/PICO-MCP" });
const c = new Client({ name: "cold", version: "0" });
await c.connect(t);

const p = await c.getPrompt({ name: "brief_to_app", arguments: { brief: "A physics knockdown game: throw a ball at racked targets from a clickable menu, with a live THROWS scoreboard." } });
console.log("=== brief_to_app PROMPT ===");
for (const m of p.messages) {
  console.log("--- role:", m.role, "---");
  console.log(typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2));
}

await c.close();
process.exit(0);
