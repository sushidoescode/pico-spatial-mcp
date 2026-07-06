import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: "/Users/sushantsrikrish/PICO-MCP" });
const c = new Client({ name: "cold", version: "0" });
await c.connect(t);

const tools = await c.listTools();
const names = ["generate_rigidbody_kotlin", "generate_lighting_kotlin", "generate_panel_compose_kotlin", "generate_game_menu_kotlin", "generate_interaction_kotlin", "generate_app_wiring", "build_and_run"];
for (const n of names) {
  const tl = tools.tools.find(x => x.name === n);
  console.log("=== " + n + " schema ===");
  console.log(JSON.stringify(tl.inputSchema, null, 2));
  console.log("");
}

await c.close();
process.exit(0);
