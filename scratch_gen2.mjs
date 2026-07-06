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

function writeFilesFromResult(resultText, label) {
  const j = JSON.parse(resultText);
  const manifestBits = [];
  if (j.files) {
    for (const f of j.files) {
      const full = path.join(projRoot, f.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content);
      console.log(label + ": wrote " + full);
    }
  } else if (j.path && j.content) {
    const full = path.join(projRoot, j.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, j.content);
    console.log(label + ": wrote " + full);
  } else {
    console.log(label + ": UNRECOGNIZED SHAPE, keys=" + Object.keys(j));
  }
  if (j.manifestProvider) manifestBits.push(j.manifestProvider);
  if (j.manifestEntry) manifestBits.push(j.manifestEntry);
  return j;
}

// Step 2: rigidbody
let r2 = await call("generate_rigidbody_kotlin", { packageName: "com.example.coldrun.content", gravity: [0,-9.81,0] });
fs.writeFileSync(projRoot + "/../coldrun_gen_rigidbody.json", r2);
writeFilesFromResult(r2, "rigidbody");

// Step 3: lighting
let r3 = await call("generate_lighting_kotlin", { packageName: "com.example.coldrun.content" });
writeFilesFromResult(r3, "lighting");

// Step 4: panel
let r4 = await call("generate_panel_compose_kotlin", {
  packageName: "com.example.coldrun.content",
  title: "KNOCKDOWN",
  fields: [ { key: "throws", label: "THROWS", initial: "0" }, { key: "status", label: "STATUS", initial: "READY" } ]
});
fs.writeFileSync(projRoot + "/../coldrun_gen_panel.json", r4);
const j4 = writeFilesFromResult(r4, "panel");
console.log("PANEL manifestEntry present?", !!j4.manifestEntry, "keys:", Object.keys(j4));

// Step 5: game menu
let r5 = await call("generate_game_menu_kotlin", { packageName: "com.example.coldrun.gen" });
fs.writeFileSync(projRoot + "/../coldrun_gen_menu.json", r5);
const j5 = writeFilesFromResult(r5, "gamemenu");
console.log("MENU keys:", Object.keys(j5));

// Step 6: interaction
let r6 = await call("generate_interaction_kotlin", { packageName: "com.example.coldrun.content" });
writeFilesFromResult(r6, "interaction");

await c.close();
process.exit(0);
