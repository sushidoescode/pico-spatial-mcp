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

const planText = fs.readFileSync("/Users/sushantsrikrish/PICO-MCP/scratch_plan.json", "utf8");
const plan = JSON.parse(planText);
const spec = plan.spec;

const compiled = await call("compile_app_spec", { spec, projectDir: "/Users/sushantsrikrish/AndroidStudioProjects/coldrun-native" });
fs.writeFileSync("/Users/sushantsrikrish/PICO-MCP/scratch_ledger.json", compiled.text);

await c.close();
process.exit(0);
