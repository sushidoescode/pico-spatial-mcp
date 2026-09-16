/**
 * Smoke: spawns the built server over stdio and checks that every tool registers, that the typed
 * contracts round-trip, and that `build_and_run` reaches its success path — all against fixtures.
 * Run: npm run smoke
 *
 * This gate is hermetic by construction, not by luck. It builds the server's whole environment
 * from scratch (`buildRunSmokeFixtureEnv`): an empty PICO tools root, a fixture home, a PATH whose
 * first entry holds a fake adb, a fake npm that refuses every call, and CLI-backed operations
 * switched off. Nothing here selects tooling by discovering it on the host, so the result is the
 * same on a clean CI runner and on a fully-equipped developer machine — which is the property
 * `test/smoke-isolation.mjs` measures by running this file twice under two different host homes.
 *
 * What this gate does NOT do is exercise a real toolchain. `validate_toolchain`, `emulator_list`,
 * real bundle pack/inspect and SDK/proto discovery live in `test/sdk-integration.mjs`, which is run
 * explicitly against paths the operator names. See the README's Testing section.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FIXTURE_SERIAL,
  buildRunSmokeFixtureEnv,
  materializeBuildRunSmokeFixture,
  readBuildRunSmokeFixtureLog,
} from "./helpers/buildrun-smoke-fixture.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-smoke-"));
const fixture = materializeBuildRunSmokeFixture({
  root: scratch,
  pngBase64: fs.readFileSync(path.join(repoRoot, "golden", "showcase-6cards.golden.png")).toString("base64"),
});
const fixtureEnv = buildRunSmokeFixtureEnv(fixture);

/** Every check this gate ran, in order, so a caller can compare two runs check-for-check. */
const checks = [];
let failures = 0;
const record = (name, status, detail = "") => {
  checks.push({ name, status });
  if (status === "FAIL") failures++;
  console.log(`\n=== ${name} [${status}] ===${detail ? `\n${detail.slice(0, 2500)}` : ""}`);
};
const expect = (name, condition, detail) => record(name, condition ? "ok" : "FAIL", condition ? "" : detail);

async function connect(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    env: fixtureEnv,
  });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const client = await connect("smoke");

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
expect("tool registration", missing.length === 0, `MISSING TOOLS: ${missing.join(", ")}`);

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
  expect("typed outputSchema", untyped.length === 0, `missing on: ${untyped.join(", ")}`);

  // preflight_env round-trips everywhere — the SDK validates its structuredContent server-side, so
  // a schema/payload mismatch turns this call into an error. Against this fixture environment the
  // individual checks report problems (no SDK payload, no device, CLI off); the contract is that
  // the envelope is typed and complete, not that the fixture host is healthy.
  const pf = await client.callTool({ name: "preflight_env", arguments: {} });
  expect("preflight_env structuredContent",
    !pf.isError && Array.isArray(pf.structuredContent?.checks) && ["ok", "problems"].includes(pf.structuredContent?.status),
    JSON.stringify(pf.structuredContent ?? null).slice(0, 200));

  const diag = await client.callTool({ name: "diagnose", arguments: { symptom: "white_geometry" } });
  expect("diagnose structuredContent",
    !diag.isError && diag.structuredContent?.rootCause && Array.isArray(diag.structuredContent?.fix),
    JSON.stringify(diag.structuredContent ?? null).slice(0, 200));

  const cap = await client.callTool({ name: "capability_report", arguments: { appName: "smoke", features: [{ name: "smoke check", status: "structural", evidence: "smoke test fixture" }] } });
  expect("capability_report structuredContent",
    !cap.isError && cap.structuredContent?.matrix?.structuralOnly?.length === 1 && typeof cap.structuredContent?.summary === "string",
    JSON.stringify(cap.structuredContent ?? null).slice(0, 200));

  const evidenceFrame = path.join(repoRoot, "golden", "showcase-6cards.golden.png");
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
  expect("capability_report rejects caller-forged producer tiers",
    !imageTiers.isError && imageTiers.structuredContent?.matrix?.autoJudged?.length === 0
      && imageTiers.structuredContent?.matrix?.usdHostRender?.length === 0
      && imageTiers.structuredContent?.matrix?.structuralOnly?.length === 2
      && imageTiers.structuredContent.matrix.structuralOnly.every((row) => /producer provenance/i.test(row.evidence ?? "")),
    JSON.stringify(imageTiers.structuredContent ?? imageTiers.content).slice(0, 300));

  const verifySkipped = await client.callTool({
    name: "verify",
    arguments: { applicationId: "com.example.contractfixture", skipStructural: true, skipVisual: true },
  });
  expect("verify structuredContent success path",
    !verifySkipped.isError && verifySkipped.structuredContent?.structural?.status === "skipped"
      && verifySkipped.structuredContent?.visual?.status === "skipped",
    JSON.stringify(verifySkipped.structuredContent ?? verifySkipped.content).slice(0, 300));
}

await client.close();

// Exercise build_and_run's actual non-error MCP return with the fake Gradle/adb programs on POSIX.
// Windows materializes and gates its .cmd/.bat wrapper-selection contract separately, but does not
// claim native build_and_run execution: production command orchestration remains unproven.
if (!fixture.executesMcpSuccessPath) {
  record("build_and_run structuredContent success path", "SKIP", fixture.scope);
} else {
  const fakeClient = await connect("buildrun-contract-smoke");
  try {
    const built = await fakeClient.callTool({
      name: "build_and_run",
      arguments: { projectDir: fixture.projectDir, packageName: "com.example.contractfixture", serial: FIXTURE_SERIAL, settleSec: 0 },
    });
    const sc = built.structuredContent;
    expect("build_and_run structuredContent success path",
      !built.isError && sc?.installed === true && sc?.launched === true && sc?.health === "ok"
        && sc?.screenshotIncluded === true && typeof sc?.appearanceRule === "string",
      JSON.stringify(sc ?? built.content).slice(0, 500));
  } catch (error) {
    record("build_and_run structuredContent success path", "FAIL", error instanceof Error ? error.stack : String(error));
  } finally {
    await fakeClient.close().catch(() => {});
  }
}

// The isolation claim itself, asserted by this gate rather than only by its caller: nothing the
// server did during this run touched a device other than the fixture one, and nothing reached npm.
const log = readBuildRunSmokeFixtureLog(fixture);
expect("fixture invocation log targets only the fixture",
  log.calls.every((call) => call.serial === FIXTURE_SERIAL || call.kind === "fixture-gradle")
    && log.entries.every((entry) => entry.serial === null || entry.serial === FIXTURE_SERIAL),
  JSON.stringify(log.entries).slice(0, 800));
expect("no npm invocation", log.npmCalls.length === 0, JSON.stringify(log.npmCalls).slice(0, 500));
// The device's global log is never cleared by ordinary verification (host completion T4): no
// recorded argv carries `logcat` followed by `-c`, and the fixture adb's clear tripwire never fired.
expect("no global log clear",
  log.entries.every((entry) => entry.kind !== "fixture-adb-cleared-log")
    && log.entries.every((entry) => { const at = entry.argv.indexOf("logcat"); return !(at >= 0 && entry.argv.slice(at + 1).includes("-c")); }),
  JSON.stringify(log.entries.filter((entry) => entry.argv.includes("logcat"))).slice(0, 800));
// build_and_run's global crash-correlation read spans its whole settle, so it is one of the LONG
// pollers that read with the long-poll bound (src/logwindow.ts LONG_POLL_LOG_WINDOW_MAX_LINES),
// not the 4000-line module default: logd applies -t before the tag filter, so a small tail on a
// chatty device evicts the marker and turns every run inconclusive. A window dump is the
// `logcat -d -v threadtime -t <n>` shape; the PID-scoped dump is not a window read and is excluded.
if (!fixture.executesMcpSuccessPath) {
  record("build_and_run window dump carries the long-poll bound", "SKIP", fixture.scope);
} else {
  const windowDumps = log.entries.filter((entry) => entry.kind === "fixture-adb" && entry.argv.includes("logcat")
    && entry.argv.includes("threadtime") && entry.argv.includes("-t") && !entry.argv.includes("--pid"));
  expect("build_and_run window dump carries the long-poll bound",
    windowDumps.length > 0 && windowDumps.every((entry) => entry.argv.includes("-d") && entry.argv[entry.argv.indexOf("-t") + 1] === "20000"),
    JSON.stringify(windowDumps).slice(0, 800));
}

fs.rmSync(scratch, { recursive: true, force: true });

// A machine-readable record of the run. test/smoke-isolation.mjs compares two of these check-for-
// check; the fixture log travels with it so the isolation proof needs no shared temp directory.
console.log(`\nSMOKE_SUMMARY ${JSON.stringify({ checks, failures, fixture: { calls: log.calls, probes: log.probes, refused: log.refused, npmCalls: log.npmCalls } })}`);
console.log(`\nSmoke test done. Failures: ${failures}`);
// exitCode, not exit(): stdout to a pipe is asynchronous, and test/smoke-isolation.mjs parses the
// SMOKE_SUMMARY line above. Exiting here can truncate it. Both clients are closed, so the loop
// drains on its own and the process still ends promptly.
process.exitCode = failures ? 1 : 0;
