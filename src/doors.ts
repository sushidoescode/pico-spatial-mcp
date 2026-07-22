import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * doors.ts — v21 THE TWELVE DOORS: an intent-level facade over the full ~190-tool surface.
 *
 * 190 exposed tools is a moat for us and a wall for everyone else. With
 * `PICO_MCP_SURFACE=doors`, the server registers ONLY these twelve intent-level tools (plus
 * validate_toolchain); each door orchestrates the full machinery through an internal client that
 * spawns the full-surface server on demand. Default surface stays "full" (all tools + the doors,
 * additive and backward compatible).
 *
 * Door design rules:
 *  - one door = one developer intent ("build me an app", "what went wrong");
 *  - every failure returns a `fix` field pointing at the EXACT next step (fix-pointing errors,
 *    seeded from the retained-lessons corpus);
 *  - honesty invariants pass through untouched — a door never upgrades evidence, and verify/build
 *    doors return the same escalation language as the underlying loop.
 */

const SURFACE = () => process.env.PICO_MCP_SURFACE ?? "full";

let cached: { call: (name: string, args?: any) => Promise<any>; close: () => Promise<void> } | null = null;

async function inner() {
  if (cached) return cached;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const here = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(here, "index.js")],
    cwd: path.dirname(here),
    env: { ...process.env, PICO_MCP_SURFACE: "full" },
  });
  const client = new Client({ name: "doors", version: "1" });
  await client.connect(transport);
  cached = {
    call: async (name: string, args: any = {}) => {
      const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 2_700_000 });
      const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
      try { return JSON.parse(text); } catch { return text; }
    },
    close: async () => { await client.close().catch(() => {}); cached = null; },
  };
  return cached;
}

const fixOf = (hint: string) => hint;

/** Call a full-surface tool through the cached inner client (shared by the doors + spatialbench). */
export async function innerCall(name: string, args: any = {}) {
  const { call } = await inner();
  return call(name, args);
}

export function registerDoorTools(server: McpServer) {
  const door = (name: string, description: string, inputSchema: any, handler: (args: any) => Promise<any>) =>
    server.registerTool(name, { description, inputSchema }, async (args: any) => {
      try {
        return okJson(await handler(args));
      } catch (e) {
        return okJson({ status: "error", error: e instanceof Error ? e.message : String(e), fix: "Run pico_doctor to check the local toolchain; if healthy, retry — the inner server log is on stderr." });
      }
    });

  door(
    "pico_build_app",
    "DOOR 1 — Build a verified spatial app from a brief. TWO-STEP by design: call with just {brief} to receive a scaffold AppSpec (the planner never guesses your intent — YOU author); adapt the scaffold to the brief, then call again with {brief, draftSpec} to compile through the full pipeline (scaffold → codegen → gradle → install → launch on the emulator), capture a frame, and judge it. Returns the verdict, the capture path (LOOK at it before claiming anything works), and the project dir. Escalations mean a human/agent must look — that is the honesty contract, not an error.",
    {
      brief: z.string().describe("What to build, e.g. 'three spinning crystals over a stone floor with a start menu'."),
      draftSpec: z.any().optional().describe("Your AppSpec, adapted from the scaffold a brief-only call returns. Omit on the first call."),
    },
    async ({ brief, draftSpec }) => {
      const { call } = await inner();
      const plan = await call("plan_app_spec", { brief, ...(draftSpec !== undefined ? { draftSpec } : {}) });
      if (plan?.status === "scaffold") return { status: "needs-authoring", scaffold: plan.scaffold, fix: "Adapt this scaffold to the brief (objects, layouts, counts, animation, menu — see each node's fields), then re-call pico_build_app with {brief, draftSpec: <adapted scaffold>}." };
      if (!plan?.spec) return { status: "plan-failed", detail: plan, fix: "Fix the validation problems named in detail and re-call with the corrected draftSpec; keep to concrete objects/layouts (e.g. 'N <things> on a floor with a menu')." };
      const id = `door${Math.abs([...brief].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 100000)}`;
      const briefsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../briefs");
      fs.writeFileSync(path.join(briefsDir, `${id}.json`), JSON.stringify({ id, brief, spec: plan.spec }, null, 2));
      const fleet = await call("fleet_build", { briefIds: [id], settleSec: 16 });
      const r = fleet?.results?.[0] ?? {};
      return {
        status: r.built ? (r.verdict === "PASS" ? "verified" : "built-needs-look") : "failed",
        briefId: id,
        built: !!r.built,
        installed: !!r.installed,
        verdict: r.verdict ?? null,
        capture: r.artifact ?? null,
        notes: r.notes ?? [],
        projectDir: `~/AndroidStudioProjects/fleet-${id}-native`,
        ...(r.built ? {} : { fix: fixOf(`Read the notes — asset-gated briefs name the missing prerequisite; build errors name the file. Then call pico_fix with the error text.`) }),
        honesty: "verdict PASS = the calibrated eye's count; 'built-needs-look' = LOOK at `capture` yourself before claiming success.",
      };
    },
  );

  door(
    "pico_scan_world",
    "DOOR 2 — Scan a Gaussian-splat world (.ply/.spz, e.g. a World Labs Marble export) into a LABELED semantic scene: geometric clusters + headless renders + OWL-v2 zero-shot labels + a relationship graph. Returns the semantic scene JSON path to feed pico_place / anchorTo briefs, plus the annotated views to spot-check (labels are detector opinions until you LOOK).",
    {
      splatPath: z.string().describe("Absolute path to the .ply/.spz splat."),
      labelQueries: z.array(z.string()).optional().describe("Scene-specific vocabulary ('bar counter', 'neon sign') — sharper labels than the generic default."),
    },
    async ({ splatPath, labelQueries }) => {
      const { call } = await inner();
      const scan = await call("semantic_splat_scan", { splatPath, autoLabel: true, ...(labelQueries ? { labelQueries } : {}) });
      if (!scan?.clusters) return { status: "scan-failed", detail: scan, fix: "Check the splat path; OWL-v2 needs the pico venv python (pico_doctor)." };
      const labels = scan.autoLabels?.labels ?? {};
      const objects = scan.clusters.filter((c: any) => labels[c.id]).map((c: any) => ({ id: c.id, label: labels[c.id].label, center: c.center, size: c.size, confidence: labels[c.id].score, labelEvidence: "auto_judged" }));
      if (!objects.length) return { status: "no-labels", views: scan.views, fix: "Pass scene-specific labelQueries and rescan; then LOOK at the annotated views." };
      const composed = await call("compose_semantic_scene", { objects: objects.map(({ confidence, labelEvidence, ...o }: any) => o), bounds: scan.bounds, floorY: scan.floorY });
      const out = { objects, floorY: scan.floorY, bounds: scan.bounds, relationships: composed?.relationships ?? [], autoFrame: composed?.autoFrame ?? null };
      const stem = path.basename(splatPath).replace(/\.(ply|spz)$/i, "").replace(/[^A-Za-z0-9._-]/g, "_");
      const outPath = path.join(process.env.HOME ?? "", ".pico-mcp", "artifacts", `${stem}-semantic.json`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
      return {
        status: "ok",
        semanticScenePath: outPath,
        labels: objects.map((o: any) => ({ id: o.id, label: o.label, confidence: o.confidence })),
        annotatedViews: (scan.views ?? []).map((v: any) => v.out),
        honesty: "Labels are OWL-v2 detector opinions (auto_judged). LOOK at an annotated view before anchoring hero content to a label.",
      };
    },
  );

  door(
    "pico_place",
    "DOOR 3 — Resolve a natural-language anchor against a scanned world: 'in front of the neon sign' → a concrete world position, with fuzzy matching and honest ambiguity/not-found reporting. Feed the result into an AppSpec object transform, or use anchorTo:{label} in a brief for the compiler to do this automatically.",
    {
      semanticScenePath: z.string().describe("The JSON from pico_scan_world."),
      label: z.string(),
      relation: z.enum(["on-top-of", "next-to", "in-front-of"]).optional(),
      childSize: z.array(z.number()).length(3).optional(),
    },
    async ({ semanticScenePath, label, relation, childSize }) => {
      const scene = JSON.parse(fs.readFileSync(semanticScenePath, "utf8"));
      const { call } = await inner();
      return call("resolve_semantic_placement", { objects: scene.objects, anchorTo: { label, ...(relation ? { relation } : {}) }, ...(childSize ? { childSize } : {}), floorY: scene.floorY, bounds: scene.bounds });
    },
  );

  door(
    "pico_look",
    "DOOR 4 — Capture the emulator's forward view deterministically and return the image path. READ the image; that look is what turns a claim into vision_verified (record it with pico_record).",
    {},
    async () => {
      const { call } = await inner();
      const cap = await call("capture_canonical", {});
      return typeof cap === "object" ? cap : { status: "ok", detail: cap };
    },
  );

  door(
    "pico_verify_app",
    "DOOR 5 — Verify ANY PICO APK through the honest loop (v22 pico-verify core): install → launch → settle → deterministic capture → calibrated-eye judgment. Works for apps this server never built (including official PICO samples). Returns verdict + capture; escalations require a look.",
    { apkPath: z.string(), packageName: z.string().describe("The APK's applicationId."), settleSec: z.number().optional() },
    async ({ apkPath, packageName, settleSec }) => {
      const { call } = await inner();
      return call("verify_pico_apk", { apkPath, packageName, ...(settleSec ? { settleSec } : {}) });
    },
  );

  door(
    "pico_measure",
    "DOOR 6 — MEASURE a placement in a capture (v20 metric layer): color-keyed detection + calibrated-camera projection → error in px and meters, box IoU. Requires a one-time calibrate_capture_camera run (pico_doctor reports calibration state). Refuses occluded/absent targets instead of guessing.",
    {
      capturePath: z.string(),
      targets: z.array(z.object({ name: z.string(), colorKey: z.array(z.number()).length(3), expectedPosition: z.array(z.number()).length(3), expectedSize: z.array(z.number()).length(3).optional() })).min(1),
    },
    async (args) => {
      const { call } = await inner();
      return call("measure_placement", args);
    },
  );

  door(
    "pico_perf",
    "DOOR 7 — Profile a running app with PICO's OFFICIAL profiler (pico-cli perf): FPS percentiles, CPU/GPU, jank windows, and PICO's own diagnosis engine. Structural evidence — numbers, not looks.",
    { packageName: z.string(), durationSec: z.number().optional() },
    async (args) => {
      const { call } = await inner();
      return call("perf_diagnose", args);
    },
  );

  door(
    "pico_sdk",
    "DOOR 8 — Look up the EXACT PICO Spatial SDK declaration (constructors with parameter order and unit docs, properties, enum values) from the official agent-vault before writing SDK code. All-Float signatures compile silently with swapped args — check first.",
    { symbol: z.string() },
    async (args) => {
      const { call } = await inner();
      return call("vault_api", args);
    },
  );

  door(
    "pico_doctor",
    "DOOR 9 — Health-check the local PICO environment: the read-only preflight (node/adb/emulator/gRPC/Accessibility/calibration/disk — every failure carries the exact fix), toolchain payloads, emulator state, and the v20 camera calibration. Run this FIRST on a new machine, and whenever anything smells off.",
    {},
    async () => {
      const { call } = await inner();
      const [tc, emu, pre] = await Promise.all([call("validate_toolchain", {}), call("emulator_status", {}), call("preflight_env", {})]);
      let calibration: any = null;
      try { calibration = JSON.parse(fs.readFileSync(path.join(process.env.HOME ?? "", ".pico-mcp", "camera-calibration.json"), "utf8")); } catch { /* uncalibrated */ }
      return {
        preflight: pre,
        toolchain: tc,
        emulator: { running: emu?.running ?? false, serial: emu?.serial ?? null },
        cameraCalibration: calibration ? { f: calibration.f, eyeHeight: calibration.eyeHeight, residualPx: calibration.residualPx, at: calibration.at } : "uncalibrated — run fleet_build(['calib']) then calibrate_capture_camera to enable pico_measure",
      };
    },
  );

  door(
    "pico_ship",
    "DOOR 10 — Run the honest ship checklist on a built app project: signing, icon, manifest, verified evidence. Returns READY or the exact gaps.",
    { projectDir: z.string(), packageName: z.string().optional() },
    async (args) => {
      const { call } = await inner();
      return call("ship_checklist", args);
    },
  );

  door(
    "pico_capabilities",
    "DOOR 11 — What can this toolchain actually do, and how is each capability PROVEN? Generated from the trust ledger: every row's best evidence class, with vision_verified meaning a human/agent looked at a rendered frame.",
    {},
    async () => {
      const { call } = await inner();
      return call("capability_matrix", {});
    },
  );

  door(
    "pico_fix",
    "DOOR 12 — Paste a build/runtime error (or describe a wrong render) and get the matched retained-lesson: the known root cause and the exact fix, from a corpus of verified past failures. Also lints provided Kotlin against the gotcha rulebook + the official SDK vault.",
    { error: z.string().describe("The error text, logcat excerpt, or symptom description."), kotlin: z.string().optional().describe("The suspect emitted Kotlin, if available.") },
    async ({ error, kotlin }) => {
      const { call } = await inner();
      const diag = await call("diagnose", { symptom: error });
      const lint = kotlin ? await call("preflight_lint", { content: kotlin, kind: "kotlin" }) : null;
      return { diagnosis: diag, ...(lint ? { lint } : {}), fix: "Apply the highest-confidence match; if nothing matches, this is a NEW gotcha — solve it, then record_lesson so it can never recur." };
    },
  );
}

export function doorsSurfaceActive(): boolean {
  return SURFACE() === "doors";
}
