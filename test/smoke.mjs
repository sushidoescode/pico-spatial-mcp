// Smoke test: spawns the built server over stdio and exercises the non-emulator tools
// against the real local toolchain. Run: npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { materializeBuildRunSmokeFixture } from "./helpers/buildrun-smoke-fixture.mjs";

const CLAIMSIGHT = path.join(os.homedir(), "AndroidStudioProjects/claimsight");
const EXISTING_BUNDLE = path.join(CLAIMSIGHT, "editor-asset/build/spatial/bundle/editor-asset.bundle");
// The project root is the directory CONTAINING the <Name>.spatialproject file
const SCENE_PROJECT = path.join(CLAIMSIGHT, "editor-asset/src/main/res3d/SpatialPackContent");
const OUT_BUNDLE = path.join(os.tmpdir(), "pico-mcp-smoke", "smoke.bundle");

// The smoke exercises full-surface tools; since v36.3 the coded default (env unset) is doors.
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, PICO_MCP_SURFACE: "full" } });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
// CI runners have no PICO SDK/emulator payload — with SMOKE_SDK_OPTIONAL=1, checks that fail
// ONLY because the local toolchain is absent count as SKIP (environmental), not FAIL (code).
const SDK_OPTIONAL = !!process.env.SMOKE_SDK_OPTIONAL;
// S2: the packer consumers now fail with the toolchain resolver's structured code instead of a
// hand-written sentence, so this matcher names the codes that mean "this host has no PICO
// toolchain". Caller-error codes (override-*, android-project-*) are deliberately NOT listed —
// those are real failures even on a machine with no SDK.
const ENV_MISS = /No (spatialbundle binary|emulator payload) found under|unavailable\/(component-missing|root-unavailable|version-missing|unsupported-default-root|component-unsupported-platform)/;
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
  "validate_toolchain", "ensure_pico_cli", "emulator_boot", "pack_bundle", "inspect_bundle", "scene_schemas",
  "gradle_build", "xr_grpc_describe", "create_scene_project", "build_spatial_project",
  "preview_scene", "snapshot_save", "ui_dump", "wait_for_log", "check_crash",
  "controller_map", "controller_press", "screenrecord", "iterate_scene", "build_and_run",
  "compose_scene", "add_entity", "import_asset", "verify_scene", "xr_input_status",
  "gui_find_window", "gui_capture", "gui_camera", "gui_permissions",
  "compose_inspection_scene", "import_environment", "worldmodel_guide", "scaffold_spatial_app", "diagnose", "design_review", "prepare_environment", "list_environment_assets", "generate_spatial_ui",
  "run_visual_regression",
  "generate_layout_kotlin", "generate_interaction_kotlin", "generate_data_binding_kotlin",
  "list_capabilities", "plan_app_spec", "replan_spec", "compile_app_spec", "verify_app_spec",
  "preflight_lint", "record_lesson", "knowledge_api", "vault_api", "perf_diagnose", "resolve_semantic_placement", "calibrate_capture_camera", "measure_placement", "critique_capture",
  "record_verification", "ledger_report", "stack_new", "stack_verify", "stack_land",
  "run_brief_suite", "regression_gate",
  "list_templates", "instantiate_template", "remix_app",
  "generate_scene_router_kotlin", "generate_composition_scene",
  "generate_interactable_registry_kotlin", "plan_layout_and_camera", "import_model_catalog",
  "swan_verify_matrix", "run_factory", "virtual_camera_frame", "virtual_camera_surfaces", "virtual_camera_from_app",
  "generate_subwindow_kotlin", "generate_spatial_gestures_kotlin",
];
// gui_* tools register only on macOS (Quartz window capture/camera) — exempt them off-darwin.
const MAC_ONLY = new Set(["gui_find_window", "gui_camera", "gui_permissions", "gui_capture"]);
const missing = EXPECTED.filter((n) => !tools.tools.some((t) => t.name === n))
  .filter((n) => process.platform === "darwin" || !MAC_ONLY.has(n));
if (missing.length) { console.log("MISSING TOOLS:", missing.join(", ")); failures++; }
const prompts = await client.listPrompts().catch(() => ({ prompts: [] }));
console.log("Prompts:", prompts.prompts.map((p) => p.name).join(", ") || "(none)");

// v36.3 outputSchema wave: the five highest-value tools advertise a typed contract, and every
// non-error call must carry matching structuredContent (the SDK enforces it server-side — a
// missing/mismatched payload turns the call into an error, so these calls double as validation).
{
  const TYPED = [
    "validate_toolchain", "capability_report", "diagnose", "build_and_run", "verify",
    // wave 2 (v36.6): the JSON-contract CLI wrappers + the doctor
    "perf_diagnose", "perf_trace", "watch_crash", "capture_record", "preflight_env",
  ];
  const untyped = TYPED.filter((n) => !tools.tools.find((t) => t.name === n)?.outputSchema);
  if (untyped.length) { console.log(`\n=== typed outputSchema [FAIL] ===\nmissing on: ${untyped.join(", ")}`); failures++; }
  else console.log(`\n=== typed outputSchema [ok] === advertised on all ${TYPED.length} contract tools`);

  // preflight_env round-trips live everywhere (CI included) — the SDK validates its
  // structuredContent server-side, so a schema/payload mismatch turns this call into an error.
  const pf = await client.callTool({ name: "preflight_env", arguments: {} });
  if (!pf.isError && Array.isArray(pf.structuredContent?.checks) && ["ok", "problems"].includes(pf.structuredContent?.status))
    console.log("=== preflight_env structuredContent [ok] ===");
  else { console.log(`=== preflight_env structuredContent [FAIL] === ${JSON.stringify(pf.structuredContent ?? null).slice(0, 200)}`); failures++; }

  const diag = await client.callTool({ name: "diagnose", arguments: { symptom: "white_geometry" } });
  if (!diag.isError && diag.structuredContent?.rootCause && Array.isArray(diag.structuredContent?.fix))
    console.log("=== diagnose structuredContent [ok] ===");
  else { console.log(`=== diagnose structuredContent [FAIL] === ${JSON.stringify(diag.structuredContent ?? null).slice(0, 200)}`); failures++; }

  const cap = await client.callTool({ name: "capability_report", arguments: { appName: "smoke", features: [{ name: "smoke check", status: "structural", evidence: "smoke test fixture" }] } });
  if (!cap.isError && cap.structuredContent?.matrix?.structuralOnly?.length === 1 && typeof cap.structuredContent?.summary === "string")
    console.log("=== capability_report structuredContent [ok] ===");
  else { console.log(`=== capability_report structuredContent [FAIL] === ${JSON.stringify(cap.structuredContent ?? null).slice(0, 200)}`); failures++; }

  const evidenceFrame = path.resolve("golden/showcase-6cards.golden.png");
  const imageTiers = await client.callTool({
    name: "capability_report",
    arguments: {
      appName: "smoke-image-tiers",
      features: [
        { name: "machine-scored fixture", status: "auto_judged", evidence: `${evidenceFrame} — fixture measurement` },
        { name: "host-rendered fixture", status: "usd_host_render", evidence: `${evidenceFrame} — fixture host render` },
      ],
    },
  });
  if (!imageTiers.isError && imageTiers.structuredContent?.matrix?.autoJudged?.length === 0
      && imageTiers.structuredContent?.matrix?.usdHostRender?.length === 0
      && imageTiers.structuredContent?.matrix?.structuralOnly?.length === 2
      && imageTiers.structuredContent.matrix.structuralOnly.every((row) => /producer provenance/i.test(row.evidence ?? "")))
    console.log("=== capability_report rejects caller-forged producer tiers [ok] ===");
  else { console.log(`=== capability_report image-tier input contract [FAIL] === ${JSON.stringify(imageTiers.structuredContent ?? imageTiers.content).slice(0, 300)}`); failures++; }

  const verifySkipped = await client.callTool({
    name: "verify",
    arguments: { applicationId: "com.example.contractfixture", skipStructural: true, skipVisual: true },
  });
  if (!verifySkipped.isError && verifySkipped.structuredContent?.structural?.status === "skipped"
      && verifySkipped.structuredContent?.visual?.status === "skipped")
    console.log("=== verify structuredContent success path [ok] ===");
  else { console.log(`=== verify structuredContent success path [FAIL] === ${JSON.stringify(verifySkipped.structuredContent ?? verifySkipped.content).slice(0, 300)}`); failures++; }
}

const vt = await client.callTool({ name: "validate_toolchain", arguments: {} });
if (!vt.isError && !Array.isArray(vt.structuredContent?.problems)) {
  console.log("=== validate_toolchain structuredContent [FAIL] === missing typed problems array"); failures++;
}
show("validate_toolchain", vt);
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

// Exercise build_and_run's actual non-error MCP return with hermetic fake Gradle/adb programs on
// POSIX. Windows materializes and gates its .cmd/.bat wrapper-selection contract separately, but
// does not claim native build_and_run execution: production command orchestration remains unproven.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-buildrun-contract-"));
  const pngBase64 = fs.readFileSync(path.resolve("golden/showcase-6cards.golden.png")).toString("base64");
  const fixture = materializeBuildRunSmokeFixture({ root: scratch, pngBase64 });
  const { binDir, projectDir } = fixture;

  if (!fixture.executesMcpSuccessPath) {
    console.log(`=== build_and_run structuredContent success path [SKIP] === ${fixture.scope}`);
    fs.rmSync(scratch, { recursive: true, force: true });
  } else {
    const fakeTransport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PICO_HOME: path.join(scratch, "empty-pico-home"),
        PICO_MCP_SURFACE: "full",
      },
    });
    const fakeClient = new Client({ name: "buildrun-contract-smoke", version: "0.0.0" });
    try {
      await fakeClient.connect(fakeTransport);
      const built = await fakeClient.callTool({
        name: "build_and_run",
        arguments: { projectDir, packageName: "com.example.contractfixture", serial: "fixture-serial", settleSec: 0 },
      });
      const sc = built.structuredContent;
      if (!built.isError && sc?.installed === true && sc?.launched === true && sc?.health === "ok"
          && sc?.screenshotIncluded === true && typeof sc?.appearanceRule === "string")
        console.log("=== build_and_run structuredContent success path [ok] ===");
      else { console.log(`=== build_and_run structuredContent success path [FAIL] === ${JSON.stringify(sc ?? built.content).slice(0, 500)}`); failures++; }
    } catch (error) {
      console.log(`=== build_and_run structuredContent success path [FAIL] === ${error instanceof Error ? error.stack : String(error)}`);
      failures++;
    } finally {
      await fakeClient.close().catch(() => {});
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

console.log(`\nSmoke test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
