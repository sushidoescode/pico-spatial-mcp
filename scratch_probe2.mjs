import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: "/Users/sushantsrikrish/PICO-MCP" });
const c = new Client({ name: "cold", version: "0" });
await c.connect(t);

async function call(name, args) {
  const r = await c.callTool({ name, arguments: args || {} });
  let text = "";
  for (const item of r.content) if (item.type === "text") text += item.text;
  return text;
}

async function probe(name, args, outFile) {
  const r = await call(name, args);
  fs.writeFileSync(outFile, r);
  let kind = "RAW";
  try { JSON.parse(r); kind = "JSON"; } catch(e) {}
  console.log(name, "->", kind, "len=" + r.length, "first80=" + JSON.stringify(r.slice(0,80)));
}

await probe("generate_lighting_kotlin", { packageName: "com.example.coldrun.content" }, "/Users/sushantsrikrish/PICO-MCP/probe_lighting.txt");
await probe("generate_panel_compose_kotlin", { packageName: "com.example.coldrun.content", title: "KNOCKDOWN", fields: [ { key: "throws", label: "THROWS", initial: "0" }, { key: "status", label: "STATUS", initial: "READY" } ] }, "/Users/sushantsrikrish/PICO-MCP/probe_panel.txt");
await probe("generate_game_menu_kotlin", { packageName: "com.example.coldrun.gen" }, "/Users/sushantsrikrish/PICO-MCP/probe_menu.txt");
await probe("generate_interaction_kotlin", { packageName: "com.example.coldrun.content" }, "/Users/sushantsrikrish/PICO-MCP/probe_interaction.txt");
await probe("generate_app_wiring", { spec: JSON.parse(fs.readFileSync("/Users/sushantsrikrish/PICO-MCP/scratch_plan.json","utf8")).spec }, "/Users/sushantsrikrish/PICO-MCP/probe_wiring.txt");

await c.close();
process.exit(0);
