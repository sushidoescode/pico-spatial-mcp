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
  for (const item of r.content) if (item.type === "text") text += item.text;
  return text;
}

function writeFile(relPath, content) {
  const full = path.join(projRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  console.log("wrote " + full + " (" + content.length + " bytes)");
}

// rigidbody (RAW kotlin)
const rigidbody = await call("generate_rigidbody_kotlin", { packageName: "com.example.coldrun.content", gravity: [0,-9.81,0] });
writeFile("app/src/main/java/com/example/coldrun/content/ScenePhysics.kt", rigidbody);

// lighting (RAW kotlin) - overwrite template's existing SceneLighting.kt
const lighting = await call("generate_lighting_kotlin", { packageName: "com.example.coldrun.content" });
writeFile("app/src/main/java/com/example/coldrun/content/SceneLighting.kt", lighting);

// panel (JSON: kotlin + manifestEntry)
const panelRaw = await call("generate_panel_compose_kotlin", {
  packageName: "com.example.coldrun.content",
  title: "KNOCKDOWN",
  fields: [ { key: "throws", label: "THROWS", initial: "0" }, { key: "status", label: "STATUS", initial: "READY" } ]
});
const panelJ = JSON.parse(panelRaw);
writeFile("app/src/main/java/com/example/coldrun/content/HudPanel.kt", panelJ.kotlin);
console.log("PANEL manifestEntry:", panelJ.manifestEntry);
fs.writeFileSync("/Users/sushantsrikrish/PICO-MCP/panel_manifest_entry.txt", panelJ.manifestEntry);

// game menu (RAW kotlin)
const menu = await call("generate_game_menu_kotlin", { packageName: "com.example.coldrun.gen" });
writeFile("app/src/main/java/com/example/coldrun/gen/GameMenu.kt", menu);

// interaction (RAW kotlin) - not directly wired but part of ledger; write for completeness
const interaction = await call("generate_interaction_kotlin", { packageName: "com.example.coldrun.content" });
writeFile("app/src/main/java/com/example/coldrun/content/SceneInteraction.kt", interaction);

// wiring (JSON: files[])
const planText = fs.readFileSync("/Users/sushantsrikrish/PICO-MCP/scratch_plan.json", "utf8");
const spec = JSON.parse(planText).spec;
const wiringRaw = await call("generate_app_wiring", { spec });
const wiringJ = JSON.parse(wiringRaw);
for (const f of wiringJ.files) {
  writeFile(f.path.replace(/^app\/src\/main\/java\/com\/example\/coldrun\//, "app/src/main/java/com/example/coldrun/"), f.content);
}

await c.close();
process.exit(0);
