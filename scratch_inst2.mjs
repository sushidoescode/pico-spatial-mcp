import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: "/Users/sushantsrikrish/PICO-MCP" });
const c = new Client({ name: "cold", version: "0" });
await c.connect(t);

async function call(name, args) {
  const r = await c.callTool({ name, arguments: args || {} });
  console.log("=== " + name + " ===");
  let text = "";
  for (const item of r.content) {
    if (item.type === "text") { text += item.text; console.log(item.text); }
    else console.log("[non-text content: " + item.type + "]");
  }
  console.log("");
  return { raw: r, text };
}

const brief = "A physics knockdown game: throw a ball at racked targets from a clickable menu, with a live THROWS scoreboard.";

const inst = await call("instantiate_template", {
  name: "knockdown",
  brief,
  appName: "ColdRun",
  packageName: "com.example.coldrun",
  count: 6
});

fs.writeFileSync("/Users/sushantsrikrish/PICO-MCP/scratch_draftspec.json", inst.text);

await c.close();
process.exit(0);
