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
    else console.log("[non-text: " + item.type + "]");
  }
  console.log("");
  return r;
}

await call("scaffold_spatial_app", {
  templateProject: "/Users/sushantsrikrish/AndroidStudioProjects/galleryxr-native",
  targetDir: "/Users/sushantsrikrish/AndroidStudioProjects/coldrun-native",
  packageName: "com.example.coldrun",
  appName: "ColdRun",
  stageStyle: "3"
});

await c.close();
process.exit(0);
