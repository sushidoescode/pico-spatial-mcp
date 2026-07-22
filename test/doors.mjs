// v21 Twelve Doors test: PICO_MCP_SURFACE=doors exposes ONLY the intent facade; the doors
// orchestrate the full surface through the internal child server. Run: npm run test:doors
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, PICO_MCP_SURFACE: "doors" } });
const client = new Client({ name: "doors-test", version: "0.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
const DOORS = ["pico_build_app", "pico_scan_world", "pico_place", "pico_look", "pico_verify_app", "pico_measure", "pico_perf", "pico_sdk", "pico_doctor", "pico_ship", "pico_capabilities", "pico_fix"];
const expected = [...DOORS, "validate_toolchain"].sort();
if (JSON.stringify(tools) === JSON.stringify(expected)) ok(`doors surface exposes exactly ${expected.length} tools`);
else fail(`surface mismatch — got [${tools.join(", ")}]`);

// a door that orchestrates through the child server (vault lookup — fast, no emulator needed)
const sdk = await client.callTool({ name: "pico_sdk", arguments: { symbol: "RigidBodyComponent" } });
const sdkOut = JSON.parse(sdk.content[0].text);
if (sdkOut.status === "ok" || sdkOut.status === "unavailable") ok(`pico_sdk orchestrates the inner server (status: ${sdkOut.status})`);
else fail(`pico_sdk unexpected: ${JSON.stringify(sdkOut).slice(0, 120)}`);

// error path carries a fix pointer
const fx = await client.callTool({ name: "pico_place", arguments: { semanticScenePath: "/nonexistent.json", label: "counter" } });
const fxOut = JSON.parse(fx.content[0].text);
if (fxOut.status === "error" && fxOut.fix) ok("door errors carry a fix pointer");
else fail(`expected fix-pointing error, got ${JSON.stringify(fxOut).slice(0, 120)}`);

// DOOR 1 two-step contract: a brief-only call hands back the scaffold to author, never a dead end
// (v27-pre first-light finding: the old door misreported the planner's scaffold handoff as plan-failed)
const ba = await client.callTool({ name: "pico_build_app", arguments: { brief: "three spinning crystals over a stone floor with a start menu" } });
const baOut = JSON.parse(ba.content[0].text);
if (baOut.status === "needs-authoring" && baOut.scaffold?.meta && /draftSpec/.test(baOut.fix ?? ""))
  ok("pico_build_app brief-only call returns the scaffold + the draftSpec re-call fix");
else fail(`pico_build_app two-step broken: ${JSON.stringify(baOut).slice(0, 160)}`);

// pico_doctor carries the preflight checks, each non-pass with a fix pointer
const doc = await client.callTool({ name: "pico_doctor", arguments: {} });
const docOut = JSON.parse(doc.content[0].text);
const checks = docOut?.preflight?.checks;
if (Array.isArray(checks) && checks.length >= 7 && checks.every((c) => c.status === "pass" || (typeof c.fix === "string" && c.fix.length > 10)))
  ok(`pico_doctor surfaces ${checks.length} preflight checks, all fix-pointed`);
else fail(`pico_doctor preflight missing/unfixed: ${JSON.stringify(docOut).slice(0, 200)}`);

await client.close();
console.log(`\nDoors test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
