import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { fileURLToPath } from "node:url";
import { writeUserBrief, findBriefPath } from "./briefstore.js";

/**
 * doors.ts — THE DOORS (v21): an intent-level facade over the full tool surface.
 *
 * The full surface is a moat for us and a wall for everyone else. With
 * `PICO_MCP_SURFACE=doors`, the server registers 15 tools (14 doors + validate_toolchain);
 * each door orchestrates the full machinery through an internal client that
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
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(here, "index.js")],
    cwd: path.dirname(here),
    // The inner server runs on the full surface, but remedies it produces are read by a DOORS user.
    // Carry the outer surface through so guidance can name the route out of it (see calibrationRoute).
    env: { ...process.env, PICO_MCP_SURFACE: "full", PICO_MCP_OUTER_SURFACE: "doors" },
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

/** Deterministic brief id for Door 1. The reduce is modular PER STEP: the old unbounded
 * `a*31 + charCode` accumulator lost Number precision and reached Infinity around ~205 chars, so
 * `Math.abs(Infinity % 100000)` went NaN and EVERY long brief collided on briefId 'doorNaN'
 * (whose capital N then failed scaffold's lowercase package regex). The modulus keeps the id
 * matching /^door\d+$/ so `com.fleet.<id>` is always a valid Android package. */
export function briefIdOf(brief: string): string {
  return `door${[...brief].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000003, 7)}`;
}

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
      const id = briefIdOf(brief);
      writeUserBrief(id, { id, brief, spec: plan.spec });
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
    "DOOR 6 — MEASURE a placement in a capture (v20 metric layer): color-keyed detection + calibrated-camera projection → error in px and meters, box IoU. Requires a one-time camera calibration — pico_doctor reports calibration state, and pico_doctor {calibrate:true} performs it end-to-end through the full-surface inner server. Refuses occluded/absent targets instead of guessing.",
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
    "DOOR 9 — Health-check the local PICO environment: the read-only preflight (node/adb/emulator/gRPC/Accessibility/calibration/disk — every failure carries the exact fix), toolchain payloads, emulator state, and the v20 camera calibration. Run this FIRST on a new machine, and whenever anything smells off. Pass {calibrate:true} to also RUN the one-time camera calibration end-to-end (fleet_build(['calib']) → calibrate_capture_camera): the inner child server already runs the FULL surface, so no surface switch or client restart is needed — it does need a running emulator and takes a few minutes.",
    { calibrate: z.boolean().optional().describe("Build+launch the calib brief and solve the capture camera through the full-surface inner server. Requires a running emulator; takes minutes.") },
    async ({ calibrate }) => {
      const { call } = await inner();
      const [tc, emu, pre] = await Promise.all([call("validate_toolchain", {}), call("emulator_status", {}), call("preflight_env", {})]);
      const readCalibration = () => {
        try { return JSON.parse(fs.readFileSync(path.join(process.env.HOME ?? "", ".pico-mcp", "camera-calibration.json"), "utf8")); } catch { return null; }
      };
      let calibrationRun: any = null;
      if (calibrate) {
        if (!(emu?.running ?? false)) {
          calibrationRun = { status: "skipped", fix: "Boot the emulator first (pico_emulator {action:'boot'}), then re-run pico_doctor {calibrate:true}." };
        } else {
          const fleet = await call("fleet_build", { briefIds: ["calib"], settleSec: 16 });
          const r = fleet?.results?.[0] ?? {};
          if (!r.artifact) {
            calibrationRun = { status: "failed", stage: "fleet_build", notes: r.notes ?? [], fix: "Read the notes — they name the failing step; fix it and re-run pico_doctor {calibrate:true}." };
          } else {
            // marker truth lives in the calib brief itself: color-keyed cubes at known positions
            const calibBrief = findBriefPath("calib");
            const calibSpec = calibBrief ? JSON.parse(fs.readFileSync(calibBrief, "utf8")).spec : null;
            const markers = (calibSpec?.objects ?? [])
              .filter((o: any) => Array.isArray(o?.body?.color) && Array.isArray(o?.transform?.position))
              .map((o: any) => ({ name: o.id, colorKey: o.body.color, position: o.transform.position }));
            calibrationRun = markers.length >= 3
              ? await call("calibrate_capture_camera", { capturePath: r.artifact, markers })
              : { status: "failed", stage: "markers", error: `calib brief provides ${markers.length} color-keyed markers; calibrate_capture_camera needs at least 3` };
          }
        }
      }
      const calibration = readCalibration();
      return {
        preflight: pre,
        toolchain: tc,
        emulator: { running: emu?.running ?? false, serial: emu?.serial ?? null },
        ...(calibrationRun ? { calibrationRun } : {}),
        cameraCalibration: calibration ? { f: calibration.f, eyeHeight: calibration.eyeHeight, residualPx: calibration.residualPx, at: calibration.at } : "uncalibrated — pico_measure needs a one-time calibration: re-run pico_doctor with {calibrate:true} and it runs fleet_build(['calib']) + calibrate_capture_camera for you through the full-surface inner server (emulator must be running)",
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
    "DOOR 12 — Paste a build/runtime error (or describe a wrong render) and get the matched retained-lesson: the known root cause and the exact fix, from a corpus of verified past failures. Free text is fine — it is mapped to the diagnosis knowledge base by keyword, and always run through the retained-lessons rulebook. Also lints provided Kotlin against the gotcha rulebook + the official SDK vault. Once you SOLVE a novel gotcha, re-call with {recordLesson:{...}} to persist it as a new lint rule (passed through to record_lesson on the full-surface inner server).",
    {
      error: z.string().describe("The error text, logcat excerpt, or symptom description."),
      kotlin: z.string().optional().describe("The suspect emitted Kotlin, if available."),
      recordLesson: z.object({
        id: z.string().describe("Unique kebab-case rule id, e.g. 'my-new-gotcha'."),
        pattern: z.string().describe("A JS regex source string that detects the anti-pattern."),
        message: z.string().describe("What's wrong (the verified failure)."),
        fix: z.string().describe("The concrete fix."),
        severity: z.enum(["error", "warn"]).optional().describe("Default 'error'."),
        kinds: z.array(z.enum(["kotlin", "command", "gradle", "usd", "any"])).optional().describe("Which content kinds this applies to (default ['any'])."),
        designRule: z.string().optional().describe("The DESIGN.md rule / diagnose symptom it maps to."),
        positiveFixture: z.string().optional().describe("A sample that MUST trigger the rule."),
        negativeFixture: z.string().optional().describe("A sample that MUST NOT trigger the rule."),
      }).optional().describe("After you SOLVE a novel gotcha: persist it as a retained-lessons lint rule. Passed through unchanged to record_lesson, which validates the regex + fixtures before persisting."),
    },
    async ({ error, kotlin, recordLesson }) => {
      const { call } = await inner();
      // v27-pre first-light fix: diagnose takes a strict symptom enum — piping free text into it
      // leaked a raw schema error at the stranger. Map keywords -> symptom; no match is honest.
      const SYMPTOM_KEYWORDS: Array<[RegExp, string]> = [
        [/unresolved reference|gradle|assembledebug|compil|build failed/i, "build_failed"],
        [/texture.*black|black.*texture/i, "texture_black"],
        [/black|very.?dark/i, "black_environment"],
        [/white|unlit|displaycolor/i, "white_geometry"],
        [/not rendering|nothing renders|empty scene|invisible/i, "not_rendering"],
        [/dead button|button.* (dead|ignored)|menu.*(no|not).*(click|respond)/i, "dead_buttons"],
        [/pins? hover/i, "pins_hovering"],
        [/fall(ing)? (out|through)/i, "falling_out"],
        [/physics|rigid|not simulating/i, "physics_not_simulating"],
        [/activity not started|launch.*block|blocked.*launch/i, "launch_blocked"],
        [/frozen|viewport/i, "frozen_viewport"],
        [/focus|wedge/i, "emu_focus_wedge"],
        [/drift|free.?cam|camera/i, "emulator_camera_drift"],
        [/raycast|no.?hit|hit.?test/i, "raycast_no_hit"],
        [/controller|pose/i, "no_controller_pose"],
        [/tiny panel|panel.*tiny/i, "tiny_panels"],
      ];
      const symptom = SYMPTOM_KEYWORDS.find(([re]) => re.test(error))?.[1] ?? null;
      const diag = symptom
        ? await call("diagnose", { symptom })
        : { status: "no-symptom-match", note: "The error text matched no diagnosis-KB symptom — the retained-lessons lint below still applies." };
      const errorLint = await call("preflight_lint", { content: error, kind: "any" });
      const lint = kotlin ? await call("preflight_lint", { content: kotlin, kind: "kotlin" }) : null;
      const lesson = recordLesson ? await call("record_lesson", recordLesson) : null;
      return { matchedSymptom: symptom, diagnosis: diag, errorLessons: errorLint, ...(lint ? { lint } : {}), ...(lesson ? { recordedLesson: lesson } : {}), fix: "Apply the highest-confidence match; if nothing matches, this is a NEW gotcha — solve it, then re-call pico_fix with {recordLesson:{...}} so it can never recur." };
    },
  );

  door(
    "pico_record",
    "DOOR 13 — RECORD a verification claim in the app's trust ledger AFTER you LOOKED (closes the pico_look loop: capture → LOOK → record). Passes through the ledger's honesty gate UNTOUCHED: a vision_verified/device_verified/auto_judged/usd_host_render entry is REJECTED unless artifactPath links a real rendered image (valid PNG/JPEG) plus an attestation of what you saw; other evidence classes record honestly without upgrades. Set report:true to also return the ledger-generated capability report for the app.",
    {
      app: z.string().describe("App name or package (the ledger key)."),
      claim: z.string().describe("The claim, e.g. '6 shelf cards render in the forward FOV'."),
      evidenceType: z.enum(["device_verified", "vision_verified", "auto_judged", "usd_host_render", "logcat", "structural", "compiles", "built_for_headset"]).describe("How it was verified. vision_verified needs a linked, existing capture + attestation."),
      artifactPath: z.string().optional().describe("Path to the capture you LOOKED at (REQUIRED for vision_verified)."),
      attestation: z.string().optional().describe("What you saw in the capture (REQUIRED for vision_verified)."),
      cClass: z.enum(["C0_emulator", "C1", "C2", "C3", "C4_headset_only"]).optional().describe("The claim's capability class."),
      report: z.boolean().optional().describe("Also return ledger_report's generated capability report for the app."),
    },
    async ({ app, claim, evidenceType, artifactPath, attestation, cClass, report }) => {
      const { call } = await inner();
      const recorded = await call("record_verification", {
        app,
        claim,
        evidenceType,
        ...(artifactPath ? { artifactPath } : {}),
        ...(attestation ? { attestation } : {}),
        ...(cClass ? { cClass } : {}),
      });
      const out: any = typeof recorded === "object" && recorded !== null ? recorded : { status: String(recorded) };
      if (report) out.report = await call("ledger_report", { app });
      return out;
    },
  );

  door(
    "pico_emulator",
    "DOOR 14 — Emulator lifecycle without leaving the doors surface. {action:'status'} reports adb/boot/gRPC state; {action:'boot'} boots the PICO OS6 emulator headless and waits for Android (fails honestly if one is already online); {action:'restart'} returns the documented COLD-restart command instead of running it — the cold restart kills the qemu process by PID and relaunches with explicit -sysdir/-kernel (adb reboot is insufficient for a wedged ContainerManager), which touches the host process table, so a human runs it.",
    { action: z.enum(["status", "boot", "restart"]).describe("status = report state; boot = boot + wait for Android; restart = get the exact cold-restart command (NOT executed).") },
    async ({ action }) => {
      if (action === "restart") {
        const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
        const script = path.resolve(here, "..", "scripts", "restart-emulator.sh");
        return {
          status: "manual-restart-required",
          script: fs.existsSync(script) ? script : null,
          fix: `Run in a terminal: bash ${script} — it kills the qemu process (adb emu kill + discovery-pid TERM fallback) and relaunches with the explicit -sysdir/-kernel flags the AVD needs outside the PICO app wrapper, then waits for sys.boot_completed=1. Afterwards RECALIBRATE before any pico_measure (pico_doctor {calibrate:true}) — a cold restart moves the capture camera.`,
          honesty: "Not executed by this tool: the cold restart kills a host process by PID, so it stays a human-run command.",
        };
      }
      const { call } = await inner();
      const out = await call(action === "boot" ? "emulator_boot" : "emulator_status", {});
      return typeof out === "object" && out !== null ? out : { status: "ok", detail: out };
    },
  );
}

export function doorsSurfaceActive(): boolean {
  return SURFACE() === "doors";
}
