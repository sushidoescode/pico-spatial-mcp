import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: "/Users/sushantsrikrish/PICO-MCP" });
const c = new Client({ name: "cold", version: "0" });
await c.connect(t);

async function call(name, args) {
  const r = await c.callTool({ name, arguments: args || {} });
  console.log("=== " + name + " ===");
  for (const item of r.content) {
    if (item.type === "text") console.log(item.text);
    else console.log("[non-text content: " + item.type + "]");
  }
  console.log("");
  return r;
}

await call("list_capabilities");
await call("list_templates");

await c.close();
process.exit(0);
