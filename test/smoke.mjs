// Smoke test: spawns the built server over stdio and exercises the non-emulator tools
// against the real local toolchain. Run: npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import os from "node:os";
import path from "node:path";

const CLAIMSIGHT = path.join(os.homedir(), "AndroidStudioProjects/claimsight");
const EXISTING_BUNDLE = path.join(CLAIMSIGHT, "editor-asset/build/spatial/bundle/editor-asset.bundle");
// The project root is the directory CONTAINING the <Name>.spatialproject file
const SCENE_PROJECT = path.join(CLAIMSIGHT, "editor-asset/src/main/res3d/SpatialPackContent");
const OUT_BUNDLE = path.join(os.tmpdir(), "pico-mcp-smoke", "smoke.bundle");

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
// CI runners have no PICO SDK/emulator payload — with SMOKE_SDK_OPTIONAL=1, checks that fail
// ONLY because the local toolchain is absent count as SKIP (environmental), not FAIL (code).
const SDK_OPTIONAL = !!process.env.SMOKE_SDK_OPTIONAL;
const ENV_MISS = /No (spatialbundle binary|emulator payload) found under/;
const show = (name, res) => {
  const text = res.content
    .map((c) => (c.type === "text" ? c.text : `[${c.type} ${c.data ? Math.round(c.data.length * 0.75) + " bytes" : ""}]`))
    .join("\n");
  const envMiss = res.isError && SDK_OPTIONAL && ENV_MISS.test(text);
  const status = envMiss ? "SKIP (no local PICO SDK)" : res.isError ? "FAIL" : "ok";
  if (res.isError && !envMiss) failures++;
  console.log(`\n=== ${name} [${status}] ===\n${text.slice(0, 2500)}`);
};

const tools = await client.listTools();
console.log(`Tools registered (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));

const EXPECTED = [
  "validate_toolchain", "emulator_boot", "pack_bundle", "inspect_bundle", "scene_schemas",
  "gradle_build", "xr_grpc_describe", "create_scene_project", "build_spatial_project",
  "preview_scene", "snapshot_save", "ui_dump", "wait_for_log", "check_crash",
  "controller_map", "controller_press", "screenrecord", "iterate_scene", "build_and_run",
  "compose_scene", "add_entity", "import_asset", "verify_scene", "xr_input_status",
  "gui_find_window", "gui_capture", "gui_camera", "gui_permissions",
  "compose_inspection_scene", "import_environment", "worldmodel_guide", "scaffold_spatial_app", "diagnose", "design_review", "prepare_environment", "list_environment_assets", "generate_spatial_ui",
  "run_visual_regression",
  "generate_layout_kotlin", "generate_interaction_kotlin", "generate_data_binding_kotlin",
  "list_capabilities", "plan_app_spec", "replan_spec", "compile_app_spec", "verify_app_spec",
  "preflight_lint", "record_lesson", "vault_api", "perf_diagnose", "resolve_semantic_placement", "calibrate_capture_camera", "measure_placement", "critique_capture",
  "record_verification", "ledger_report", "stack_new", "stack_verify", "stack_land",
  "run_brief_suite", "regression_gate",
  "list_templates", "instantiate_template", "remix_app",
  "generate_scene_router_kotlin", "generate_composition_scene",
  "generate_interactable_registry_kotlin", "plan_layout_and_camera", "import_model_catalog",
  "swan_verify_matrix", "run_factory", "virtual_camera_frame",
];
// gui_* tools register only on macOS (Quartz window capture/camera) — exempt them off-darwin.
const MAC_ONLY = new Set(["gui_find_window", "gui_camera", "gui_permissions", "gui_capture"]);
const missing = EXPECTED.filter((n) => !tools.tools.some((t) => t.name === n))
  .filter((n) => process.platform === "darwin" || !MAC_ONLY.has(n));
if (missing.length) { console.log("MISSING TOOLS:", missing.join(", ")); failures++; }
const prompts = await client.listPrompts().catch(() => ({ prompts: [] }));
console.log("Prompts:", prompts.prompts.map((p) => p.name).join(", ") || "(none)");

show("validate_toolchain", await client.callTool({ name: "validate_toolchain", arguments: {} }));
show("emulator_list", await client.callTool({ name: "emulator_list", arguments: {} }));
show("inspect_bundle (existing claimsight bundle)", await client.callTool({
  name: "inspect_bundle",
  arguments: { bundlePath: EXISTING_BUNDLE },
}));
show("pack_bundle (claimsight scenes -> /tmp)", await client.callTool({
  name: "pack_bundle",
  arguments: {
    sceneDir: path.join(SCENE_PROJECT, "Sources", "Scenes"),
    projectDir: SCENE_PROJECT,
    output: OUT_BUNDLE,
    forceBuild: true,
  },
}));
show("inspect_bundle (freshly packed)", await client.callTool({
  name: "inspect_bundle",
  arguments: { bundlePath: OUT_BUNDLE },
}));
show("scene_schemas (first 1k chars)", await client.callTool({ name: "scene_schemas", arguments: {} }));
show("xr_grpc_describe (proto introspection, no emulator needed)", await client.callTool({
  name: "xr_grpc_describe",
  arguments: {},
}));

await client.close();
console.log(`\nSmoke test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
