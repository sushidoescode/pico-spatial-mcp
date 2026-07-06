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

const r2 = await call("generate_rigidbody_kotlin", { packageName: "com.example.coldrun.content", gravity: [0,-9.81,0] });
fs.writeFileSync("/Users/sushantsrikrish/PICO-MCP/probe_rigidbody.txt", r2);
console.log("rigidbody first 200 chars:", r2.slice(0,200));
console.log("rigidbody last 200 chars:", r2.slice(-200));

await c.close();
process.exit(0);
