import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: "/Users/sushantsrikrish/PICO-MCP" });
const c = new Client({ name: "cold", version: "0" });
await c.connect(t);

const tools = await c.listTools();
const tl = tools.tools.find(x => x.name === "generate_agent_bridge");
console.log(JSON.stringify(tl.inputSchema, null, 2));
console.log("FULL DESC:", tl.description);

await c.close();
process.exit(0);
