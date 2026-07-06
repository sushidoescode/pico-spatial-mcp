import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: "/Users/sushantsrikrish/PICO-MCP" });
const c = new Client({ name: "cold", version: "0" });
await c.connect(t);

async function call(name, args) {
  const r = await c.callTool({ name, arguments: args || {} });
  let text = "";
  for (const item of r.content) if (item.type === "text") text += item.text;
  return text;
}

const res = await call("build_and_run", {
  projectDir: "/Users/sushantsrikrish/AndroidStudioProjects/coldrun-native",
  packageName: "com.example.coldrun",
  settleSec: 8
});
console.log(res);

await c.close();
process.exit(0);
