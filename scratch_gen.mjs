import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: "/Users/sushantsrikrish/PICO-MCP" });
const c = new Client({ name: "cold", version: "0" });
await c.connect(t);

const projRoot = "/Users/sushantsrikrish/AndroidStudioProjects/coldrun-native";

async function call(name, args) {
  const r = await c.callTool({ name, arguments: args || {} });
  let text = "";
  for (const item of r.content) {
    if (item.type === "text") text += item.text;
  }
  return text;
}

function extractKotlinAndMeta(text) {
  // Try JSON first
  try {
    const j = JSON.parse(text);
    return j;
  } catch (e) {
    return null;
  }
}

// Step 1: generate_agent_bridge
let out = await call("generate_agent_bridge", { packageName: "com.example.coldrun" });
fs.writeFileSync("/Users/sushantsrikrish/PICO-MCP/gen_agentbridge.json", out);
console.log("=== agent_bridge output keys ===");
try { console.log(Object.keys(JSON.parse(out))); } catch(e) { console.log("not json, len=" + out.length); }

await c.close();
process.exit(0);
