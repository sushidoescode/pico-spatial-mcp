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

const projRoot = "/Users/sushantsrikrish/AndroidStudioProjects/coldrun-native/app/src/main/java/com/example/coldrun";
const files = [
  "content/ScenePhysics.kt",
  "content/SceneComposition.kt",
  "content/HomeStage.kt",
  "gen/GameMenu.kt",
  "content/HudPanel.kt",
];
for (const f of files) {
  const content = fs.readFileSync(projRoot + "/" + f, "utf8");
  const res = await call("preflight_lint", { content, kind: "kotlin" });
  console.log("=== " + f + " ===");
  console.log(res);
  console.log("");
}

await c.close();
process.exit(0);
