import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { fileURLToPath } from "node:url";
import { writeUserBrief, findBriefPath, userBriefsDir } from "./briefstore.js";
import { hasSpatialNavigatorFullStageCall } from "./lint.js";
import { CANONICAL_APP_KEY_PATTERN, isPassingDeviceEvidence, isPassingDeviceEvidenceForReceipt, readLedger } from "./ledger.js";
import {
  findHistoricalRunReceipt,
  runReceiptBindingsEqual,
  validateHistoricalRunReceiptCaptureBinding,
} from "./runreceiptportable.js";

/**
 * doors.ts — THE DOORS (v21): an intent-level facade over the full tool surface.
 *
 * The full surface is a moat for us and a wall for everyone else. On the doors surface the
 * server registers 18 tools (16 doors + validate_toolchain + ensure_pico_cli);
 * each door orchestrates the full machinery through an internal client that
 * spawns the full-surface server on demand. Since v36.3 doors is also the CODED default
 * (env unset): the docs already told every host to set `PICO_MCP_SURFACE=doors`, but the old
 * `?? "full"` fallback meant one missed env var exposed the full schema payload (later measured
 * as 86,927 `o200k_base` tokens over `JSON.stringify(result.tools)` from `tools/list`). `PICO_MCP_SURFACE=full` is the explicit opt-in — nothing
 * is removed. Every internal self-spawn (this inner client, fleetbuild/hybridbuild/marbleingest/
 * semanticsplat selfClients) pins PICO_MCP_SURFACE=full explicitly, because the SDK's child env
 * is a whitelist that never inherits the variable.
 *
 * Door design rules:
 *  - one door = one developer intent ("build me an app", "what went wrong");
 *  - every failure returns a `fix` field pointing at the EXACT next step (fix-pointing errors,
 *    seeded from the retained-lessons corpus);
 *  - honesty invariants pass through untouched — a door never upgrades evidence, and verify/build
 *    doors return the same escalation language as the underlying loop.
 */

const SURFACE = () => process.env.PICO_MCP_SURFACE ?? "doors";

/** Public setup remedy shared by pico_loop failures. Resolution stays inside the MCP; setup stays
 * an explicit user-run argv invocation of the returned absolute executable. */
export function formatManualPicoCliSetupGuidance(context: string): string {
  return `${context.trim()} Call ensure_pico_cli, then manually run its returned absolute path with args ["setup"]; the MCP never runs setup.`;
}

const UNMEASURABLE_ACCEPTANCE_FIX = "A criterion cannot be measured on this machine (failing[].detail names the missing lane; structural criteria may need generate_agent_bridge injected). Fix the measurement lane or drop the criterion — replanning the app cannot help.";

export function picoFixDecision(error: string): { symptom: string | null; nextAction: string } {
  if (hasSpatialNavigatorFullStageCall(error)) {
    return {
      symptom: "world_disappears_on_walk",
      nextAction: "Use a manifest-declared style-1 DefaultStage, and validate the opaque Full route on hardware with Safeguard configured.",
    };
  }
  const keywords: Array<[RegExp, string, string]> = [
    [/world[_\s-]*disappears?[_\s-]*on[_\s-]*walk|dynamic\s+full.*(?:safety|disappear)/i, "world_disappears_on_walk", "Use a manifest-declared style-1 DefaultStage, and validate the opaque Full route on hardware with Safeguard configured."],
    [/androidx\.compose|compose.*(?:exclude|bom|fork)|(?:exclude|bom|fork).*compose/i, "compose_fork_conflict", "Run verify_gradle_config with the project directory; set resolveTransitives:true only if an explicit resolved-graph check is needed."],
    [/Default(?:Stage|WindowContainer)|pico\.spatial\.(?:stage|windowcontainer)|container.*mismatch/i, "container_mode_mismatch", "Run verify_gradle_config and align manifest metadata with the Kotlin container root."],
    [/unresolved reference|gradle|assembledebug|compil|build failed/i, "build_failed", "Read the diagnosis and fix the first concrete build error."],
    [/texture.*black|black.*texture/i, "texture_black", "Use the diagnosis's baked-bundle path."],
    [/black|very.?dark/i, "black_environment", "Use the diagnosis's environment fix."],
    [/white|unlit|displaycolor/i, "white_geometry", "Bind a real material as directed."],
  ];
  const found = keywords.find(([re]) => re.test(error));
  return found ? { symptom: found[1], nextAction: found[2] } : { symptom: null, nextAction: "Apply the highest-confidence lint or diagnosis match; if none applies, solve and record the new lesson." };
}

/** One acceptance criterion's outcome inside a pico_loop iteration. `unmeasurable` is an HONEST
 * third state: the criterion could not be checked on this machine (missing pico-cli perf
 * utilities, no Agent Bridge, …) — it never silently passes and it is not a repairable failure.
 * `needs-look` is the eye's ESCALATE: the machine cannot judge this frame class (measured: on
 * high-coverage passthrough frames count/color checks carry zero confidence) — not a defect to
 * repair, and never a pass; when it is the ONLY thing short of acceptance the loop exits
 * built-needs-look (first live-observed 2026-08-12: crystals brief, eye ESCALATE, a replan would
 * have mutated a correct app). */
export type LoopCriterionOutcome = {
  kind: string;
  status: "pass" | "fail" | "unmeasurable" | "needs-look";
  detail?: string;
  machineVerdict?: string;
  recordedEvidence?: boolean;
  failureClass?: string;
  machineChecks?: Array<{ name?: string; score?: number; detail?: string; hardFail?: boolean; advisory?: boolean }>;
};

/** A setup command is materially mutating and repairs only the CLI utility-provisioning refusal.
 * Other unmeasurable lanes keep their own diagnostic instead of receiving unrelated advice. */
export function loopUnmeasurableFix(failing: readonly LoopCriterionOutcome[]): string {
  return failing.some((outcome) => outcome.kind === "perf" && outcome.failureClass === "setup-required")
    ? formatManualPicoCliSetupGuidance(UNMEASURABLE_ACCEPTANCE_FIX)
    : UNMEASURABLE_ACCEPTANCE_FIX;
}

/** Signature of an iteration's failure state for the no-progress detector: failing/unmeasurable
 * criteria only, first line of each detail (tails carry paths/timings that vary run to run), with
 * digit runs normalized to '#' — a jittering measurement (appFps p5=43.2 vs 41.7, a pid, an
 * elapsed-seconds count) is the SAME wall, and leaving the numbers in defeated the detector.
 * Two consecutive identical signatures ⇒ the repair lane is not moving; the loop stops honestly
 * instead of burning the remaining budget on the same wall. */
export function loopFailureSignature(outcomes: LoopCriterionOutcome[]): string {
  return outcomes
    .filter((o) => o.status !== "pass")
    .map((o) => `${o.kind}:${o.status}:${(o.detail ?? "").split("\n")[0].trim().replace(/\d+(?:\.\d+)?/g, "#")}`)
    .join("|");
}

/** `assert_scene` clears logcat before requesting its Agent Bridge dump. Consume every launch-log
 * criterion first so a caller's criterion order cannot erase the evidence a later logcat assert
 * needs. The partition is stable within each group, keeping caller order everywhere it is safe. */
export function loopCriteriaInEvidenceSafeOrder<T extends Record<string, any>>(criteria: T[]): T[] {
  return [...criteria.filter((c) => c.kind === "logcat"), ...criteria.filter((c) => c.kind !== "logcat")];
}

/** recompileSubtree describes generated-code work, not every AppSpec mutation: camera-only repairs
 * legitimately leave it empty. Compare the complete JSON-shaped specs to decide whether replanning
 * made progress. */
export function loopSpecMutated(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** A hardware LOOK with an explicit failing outcome is valuable negative evidence, but it must
 * never advance pico_next as though the app had earned positive visual proof. */
export function isPositiveLookedEntry(entry: any): boolean {
  return (entry?.evidenceType === "vision_verified" && entry?.deviceOutcome !== "fail")
    || isPassingDeviceEvidence(entry);
}

type LoopReplanFailure = { symptom: string };

/** Select only failures for which replan_spec has a concrete retained-lesson mutation. Generic
 * structural assertions, arbitrary log markers, and low-FPS measurements have no safe automatic
 * AppSpec edit; calling them build_failed made the advertised loop a misleading one-shot. */
export function loopRepairSelection(failing: LoopCriterionOutcome[]): { failures: LoopReplanFailure[]; unsupported: LoopCriterionOutcome[] } {
  const failures: LoopReplanFailure[] = [];
  const unsupported: LoopCriterionOutcome[] = [];

  for (const outcome of failing) {
    // The fleet judge measures count/coverage/color presence; it does not diagnose camera pose,
    // interaction wiring, or arbitrary log markers. Only a hard black/zero-object measurement maps
    // to replan_spec's real not_rendering mutation. Everything else stays manual rather than being
    // laundered into a symptom the loop cannot prove or drive on the next iteration.
    const hardChecks = (outcome.machineChecks ?? []).filter((check) => check.hardFail);
    const measuredEmpty = hardChecks.some((check) =>
      check.name === "notMostlyBlack"
      || (check.name === "objectCount" && /measured\s+0\b/i.test(check.detail ?? "")),
    );
    if (outcome.kind === "visual" && measuredEmpty) failures.push({ symptom: "not_rendering" });
    else unsupported.push(outcome);
  }
  return { failures, unsupported };
}

/** Preserve the calibrated eye's actual vocabulary. PASS is machine acceptance, FAIL is a
 * measured defect, ESCALATE is a calibrated refusal, and absent/unknown output is merely
 * unscored. The latter two both require a look but have different provenance. */
export function loopVisualOutcome(
  verdict: unknown,
  artifact: string | null | undefined,
  notes: unknown[],
  checks: LoopCriterionOutcome["machineChecks"] = [],
  judgeNote?: unknown,
  ledger?: unknown,
): LoopCriterionOutcome {
  const machineVerdict = typeof verdict === "string" && verdict.trim()
    ? verdict.trim().toUpperCase()
    : "unscored";
  if (machineVerdict === "PASS") {
    const recordedEvidence = !!ledger && typeof ledger === "object" && (ledger as any).status === "recorded";
    const writeStatus = recordedEvidence
      ? "durably recorded as auto_judged"
      : `NOT durably recorded (${typeof (ledger as any)?.reason === "string" ? (ledger as any).reason : `ledger status ${(ledger as any)?.status ?? "missing"}`})`;
    return { kind: "visual", status: "pass", machineVerdict, recordedEvidence, detail: `eye verdict PASS (measured); ${writeStatus}; capture ${artifact ?? "n/a"}` };
  }
  if (machineVerdict === "FAIL") {
    const measured = checks.length
      ? checks.map((check) => `${check.name ?? "check"}: ${check.detail ?? `score ${check.score ?? "?"}`}`).join(" | ")
      : "no structured checks returned";
    return {
      kind: "visual",
      status: "fail",
      machineVerdict,
      machineChecks: checks,
      detail: `eye verdict FAIL; measured checks: ${measured}${typeof judgeNote === "string" ? `; judge note: ${judgeNote}` : ""}; notes: ${notes.slice(-3).join(" | ") || "none"}`,
    };
  }
  return {
    kind: "visual",
    status: "needs-look",
    machineVerdict,
    detail: `eye verdict ${machineVerdict} — no PASS/FAIL machine judgment is available; capture ${artifact ?? "n/a"}`,
  };
}

/** Report only the strongest evidence actually earned by this iteration. The fleet may run its
 * eye even when the caller omitted a visual criterion; a real PASS still earns auto_judged, while
 * FAIL/ESCALATE/unscored can never be upgraded by passing structural/logcat/perf criteria. */
export function loopAcceptanceEvidence(outcomes: LoopCriterionOutcome[], fleetVerdict?: unknown, fleetLedger?: unknown): { ceiling: "auto_judged" | "structural"; honesty: string } {
  const visualPassed = outcomes.some((outcome) => outcome.kind === "visual" && outcome.status === "pass")
    || (typeof fleetVerdict === "string" && fleetVerdict.toUpperCase() === "PASS");
  const visualRecorded = outcomes.some((outcome) => outcome.kind === "visual" && outcome.status === "pass" && outcome.recordedEvidence === true)
    || (typeof fleetVerdict === "string" && fleetVerdict.toUpperCase() === "PASS"
      && !!fleetLedger && typeof fleetLedger === "object" && (fleetLedger as any).status === "recorded");
  if (visualRecorded) {
    return {
      ceiling: "auto_judged",
      honesty: "The calibrated eye returned PASS, so this iteration's ceiling is auto_judged — machine-measured, never human-seen. LOOK at every returned artifact before any vision_verified claim.",
    };
  }
  const observed = typeof fleetVerdict === "string" && fleetVerdict.trim() ? fleetVerdict.toUpperCase() : "unscored";
  if (visualPassed) {
    const why = typeof (fleetLedger as any)?.reason === "string"
      ? (fleetLedger as any).reason
      : `ledger status ${(fleetLedger as any)?.status ?? "missing"}`;
    return {
      ceiling: "structural",
      honesty: `The calibrated eye returned PASS, but its auto_judged evidence was not durably recorded (${why}); this iteration's on-file ceiling is structural. Repair the ledger and re-measure before claiming auto_judged. LOOK at the capture before any vision_verified claim.`,
    };
  }
  return {
    ceiling: "structural",
    honesty: `The passed acceptance criteria did not include a visual PASS (fleet eye: ${observed}); this iteration's ceiling is structural. No render-success claim was earned. LOOK at the capture before any vision_verified claim.`,
  };
}

/** Explain why the terminal look is owed without claiming the eye ran or escalated when its
 * result was absent, skipped, or outside the known vocabulary. */
export function loopNeedsLookHonesty(needsLook: LoopCriterionOutcome[]): string {
  const verdicts = Array.from(new Set(needsLook.map((outcome) => outcome.machineVerdict ?? "unscored")));
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === "ESCALATE")) {
    return "The calibrated eye ESCALATEd — this frame class cannot be machine-judged. Everything else measurable passed. LOOK at the capture (or have a vision-capable agent do it), then record what you actually saw with pico_record {evidenceType:'vision_verified'} — that look, not this loop, decides success.";
  }
  return `No PASS/FAIL visual score was available (${verdicts.join(", ") || "unscored"}). This is an unscored look obligation, not evidence that the calibrated eye classified the frame. Everything else measurable passed. LOOK at the capture (or have a vision-capable agent do it), then record what you actually saw with pico_record {evidenceType:'vision_verified'} — that look, not this loop, decides success.`;
}

type InnerCache = {
  call: (name: string, args?: any) => Promise<any>;
  close: () => Promise<void>;
};

let cached: InnerCache | null = null;

async function inner() {
  if (cached) return cached;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const childEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    PICO_MCP_SURFACE: "full",
    PICO_MCP_OUTER_SURFACE: "doors",
  };
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(here, "index.js")],
    cwd: path.dirname(here),
    // The inner server runs on the full surface, but remedies it produces are read by a DOORS user.
    // Carry the outer surface through so guidance can name the route out of it (see calibrationRoute).
    env: childEnv,
  });
  const client = new Client({ name: "doors", version: "1" });
  await client.connect(transport);
  const entry: InnerCache = {
    call: async (name: string, args: any = {}) => {
      const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 2_700_000 });
      const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
      try { return JSON.parse(text); } catch { return text; }
    },
    close: async () => {
      await client.close().catch(() => {});
      if (cached === entry) cached = null;
    },
  };
  cached = entry;
  return cached;
}

const fixOf = (hint: string) => hint;

/** ~/.pico-mcp/camera-calibration.json (the v20 metric layer's one-time solve) — read by pico_doctor
 * and pico_next. Null = uncalibrated. */
function readCameraCalibration(): any | null {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.HOME ?? "", ".pico-mcp", "camera-calibration.json"), "utf8")); } catch { return null; }
}

/** Deterministic brief id for Door 1. The reduce is modular PER STEP: the old unbounded
 * `a*31 + charCode` accumulator lost Number precision and reached Infinity around ~205 chars, so
 * `Math.abs(Infinity % 100000)` went NaN and EVERY long brief collided on briefId 'doorNaN'
 * (whose capital N then failed scaffold's lowercase package regex). The modulus keeps the id
 * matching /^door\d+$/ so `com.fleet.<id>` is always a valid Android package. */
export function briefIdOf(brief: string): string {
  return `door${[...brief].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000003, 7)}`;
}

function fleetProjectDirectory(id: string): string {
  return path.join(os.homedir(), "AndroidStudioProjects", `fleet-${id}-native`);
}

/** Door 1 has not performed the human/agent LOOK, so no branch may call itself `verified`.
 * A producer-recorded eye PASS is still useful, but its terminal state keeps the remaining LOOK
 * obligation explicit. Build/install/capture failures are kept distinct instead of being folded
 * into a success-shaped status. */
export function buildAppDoorStatus(result: any): "failed" | "built-not-installed" | "built-no-capture" | "auto-judged-needs-look" | "built-needs-look" {
  if (!result?.built) return "failed";
  if (!result?.installed) return "built-not-installed";
  if (result?.receipt?.status !== "recorded"
      || typeof result.receipt.receiptId !== "string"
      || typeof result.receipt.receiptPath !== "string"
      || typeof result.receipt.capturePath !== "string"
      || result.artifact !== result.receipt.capturePath)
    return "built-no-capture";
  if (result?.verdict === "PASS" && result?.visualLedger?.status === "recorded")
    return "auto-judged-needs-look";
  return "built-needs-look";
}

/** Call a full-surface tool through the cached inner client (shared by the doors + spatialbench). */
export async function innerCall(name: string, args: any = {}) {
  const { call } = await inner();
  return call(name, args);
}

export interface DoorToolDependencies {
  call: (name: string, args?: any) => Promise<any>;
}

export function registerDoorTools(server: McpServer, dependencies?: DoorToolDependencies) {
  const doorCall = async (): Promise<DoorToolDependencies["call"]> =>
    dependencies?.call ?? (await inner()).call;
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
    "DOOR 1 — Build an evidence-scoped spatial app from a brief. TWO-STEP by design: call with just {brief} to receive a scaffold AppSpec (the planner never guesses your intent — YOU author); adapt the scaffold to the brief, then call again with {brief, draftSpec} to compile through the full pipeline (scaffold → codegen → a fail-closed native run receipt). Apps default to the Mixed stage (stageStyle '1' — the passthrough home environment is the backdrop and content seats ON the room, mrtable-style); a fully-virtual app remains a first-class opt-in via meta.stageStyle '3' (Full). A recorded receipt is structural provenance for one exact build/install/session/capture, not visual proof. Returns its receiptId, receiptPath, and exact immutable capture; LOOK at that capture before claiming how it renders. Even a recorded calibrated-eye PASS returns 'auto-judged-needs-look', never 'verified': only the later human/agent LOOK can earn vision_verified.",
    {
      brief: z.string().describe("What to build, e.g. 'a primitive table standing on my real floor with bodies dropping onto it from a clickable menu' (Mixed-stage MR, the default; a fully-virtual brief opts into stage style 3)."),
      draftSpec: z.any().optional().describe("Your AppSpec, adapted from the scaffold a brief-only call returns. Omit on the first call."),
    },
    async ({ brief, draftSpec }) => {
      const call = await doorCall();
      const plan = await call("plan_app_spec", { brief, ...(draftSpec !== undefined ? { draftSpec } : {}) });
      if (plan?.status === "scaffold") return { status: "needs-authoring", scaffold: plan.scaffold, ...(plan.archetype ? { archetype: plan.archetype, archetypeWhy: plan.archetypeWhy } : {}), fix: "Adapt this scaffold to the brief (objects, layouts, counts, animation, menu — see each node's fields), then re-call pico_build_app with {brief, draftSpec: <adapted scaffold>}." };
      if (!plan?.spec) return { status: "plan-failed", detail: plan, fix: "Fix the problems named in detail (each detail.issues entry names the failing path, the expected shape, and a known-good example fragment to copy-adapt), then re-call with the corrected draftSpec." };
      // needs_fix = schema-valid but blocking lint errors (broken references, unposed capture claims,
      // over-claimed C-classes). Building it anyway ships a broken/unverifiable app — stop here.
      if (plan.status === "needs_fix") return { status: "plan-failed", detail: { lint: plan.lint, rationale: plan.rationale }, fix: "The draftSpec parsed but has blocking lint errors — fix each detail.lint.errors entry (they name the exact node and remedy) and re-call with the corrected draftSpec." };
      const id = briefIdOf(brief);
      writeUserBrief(id, { id, brief, spec: plan.spec });
      const fleet = await call("fleet_build", { briefIds: [id], settleSec: 16 });
      const r = fleet?.results?.[0] ?? {};
      const identity = (r.notes ?? []).find((n: any) => typeof n === "string" && n.startsWith("authored identity"));
      const status = buildAppDoorStatus(r);
      const autoJudgedRecorded = status === "auto-judged-needs-look";
      const receipt = r.receipt?.status === "recorded" ? r.receipt : null;
      return {
        status,
        briefId: id,
        built: !!r.built,
        installed: !!r.installed,
        verdict: r.verdict ?? null,
        autoJudgedRecorded,
        receiptId: receipt?.receiptId ?? null,
        receiptPath: receipt?.receiptPath ?? null,
        capture: receipt?.capturePath ?? null,
        notes: r.notes ?? [],
        projectDir: fleetProjectDirectory(id),
        ...(identity ? { identity } : {}),
        ...(["failed", "built-not-installed", "built-no-capture"].includes(status) ? { fix: fixOf(`Read the notes — asset-gated briefs name the missing prerequisite; build/install/capture errors name the failing step. Then call pico_fix with the error text.`) } : {}),
        honesty: "The returned receipt is structural provenance only. No Door 1 status means human-verified: even 'auto-judged-needs-look' is a calibrated machine PASS, not sight. LOOK at the exact receipt-bound `capture` before any vision_verified claim.",
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
    "DOOR 4 — Capture the emulator's forward view deterministically and return the image path. READ the image; that look is what turns a claim into vision_verified (record it with pico_record). NO pose control exists on this path: deterministic = the fixed forward screencap; the multi-angle alternatives are Accessibility-gated GUI drags whose free-cam drifts — so bring content into the forward FOV instead of moving the camera. OCCLUSION: a docked HUD/menu panel can cover the scene; when the app's generated wiring routes the panel DEBUG_CMDs, drive 'panel:hide' before a scene capture and 'panel:show' after (adb shell am broadcast -a <pkg>.DEBUG_CMD --es cmd panel:hide). Apps without that route ignore the broadcast — confirm with the capture itself, never by assumption.",
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
    "DOOR 8 — Look up the EXACT PICO Spatial SDK declaration (constructors with parameter order and unit docs, properties, enum values) from the official 0.13.3 agent-vault before writing SDK code. The app skeleton builds on SDK 6.0.0; consult docs/SDK_6_0_0_DRIFT.md for the measured near-zero public-API drift caveat. All-Float signatures compile silently with swapped args — check first.",
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
      const calibration = readCameraCalibration();
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
    "DOOR 10 — Transparently run the honest ship checklist for an app/lane/project. Native debug provenance clears only when current bytes match a digest-bound v1 run receipt and its exact capture has an effective receipt-linked LOOK. The debug receipt never clears release APK, release signing, store, web-deploy, Swan-hardware, or Windows boundaries.",
    {
      app: z.string().regex(CANONICAL_APP_KEY_PATTERN).describe("Canonical native applicationId or web app ledger key."),
      lane: z.enum(["native", "web", "hybrid"]).optional().describe("Checklist lane (default native)."),
      projectDir: z.string().optional().describe("Current project directory whose bytes the checklist must validate (uses ship_checklist's lane default when omitted)."),
    },
    async (args) => {
      const call = await doorCall();
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
      const decision = picoFixDecision(error);
      const symptom = decision.symptom ?? SYMPTOM_KEYWORDS.find(([re]) => re.test(error))?.[1] ?? null;
      const diag = symptom
        ? await call("diagnose", { symptom })
        : { status: "no-symptom-match", note: "The error text matched no diagnosis-KB symptom — the retained-lessons lint below still applies." };
      const errorLint = await call("preflight_lint", { content: error, kind: "any" });
      const lint = kotlin ? await call("preflight_lint", { content: kotlin, kind: "kotlin" }) : null;
      const lesson = recordLesson ? await call("record_lesson", recordLesson) : null;
      return { matchedSymptom: symptom, nextAction: decision.nextAction, diagnosis: diag, errorLessons: errorLint, ...(lint ? { lint } : {}), ...(lesson ? { recordedLesson: lesson } : {}), fix: "Apply the highest-confidence match; if nothing matches, this is a NEW gotcha — solve it, then re-call pico_fix with {recordLesson:{...}} so it can never recur." };
    },
  );

  door(
    "pico_record",
    "DOOR 13 — RECORD a caller-attested verification claim AFTER you LOOKED, append an honest RETRACTION, or explicitly PROMOTE a native receipt into portable one-hop provenance without creating evidence. The three actions are mutually exclusive. Portable record binding requires both runReceiptId and runReceiptPromotionId; native binding omits the promotion ID. Image evidence needs a real PNG/JPEG plus attestation. device_verified additionally requires live hardware/capture binding plus structured deviceFeature and explicit pass/fail outcome.",
    {
      app: z.string().regex(CANONICAL_APP_KEY_PATTERN).describe("Canonical lowercase app/package ledger key: ASCII lowercase letters, digits, dot, underscore, or hyphen; no paths, spaces, or case aliases."),
      action: z.enum(["record", "retract", "promote"]).optional().describe("Default record; retract appends a correction; promote publishes portable one-hop receipt objects without evidence."),
      claim: z.string().optional().describe("Record action: the claim, e.g. '6 shelf cards render in the forward FOV'."),
      evidenceType: z.enum(["device_verified", "vision_verified", "logcat", "structural", "compiles", "built_for_headset"]).optional().describe("Record action: a caller-recordable evidence tier. vision_verified needs a linked capture + attestation; device_verified additionally uses live device/capture provenance. auto_judged and usd_host_render are producer-only and must come from visual_judge or render_usd_offscreen."),
      artifactPath: z.string().optional().describe("Path to the capture you LOOKED at (REQUIRED for vision_verified)."),
      attestation: z.string().optional().describe("What you saw in the capture (REQUIRED for vision_verified)."),
      cClass: z.enum(["C0_emulator", "C1", "C2", "C3", "C4_headset_only"]).optional().describe("The claim's capability class."),
      runReceiptId: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Record action only: receiptId returned by pico_build_app. Pass it after LOOKING at that receipt's exact capture; it binds provenance without promoting the evidence class."),
      runReceiptPromotionId: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Record action only: promotionId returned with a portable receipt. Omit it for native receipt binding."),
      deviceSerial: z.string().optional().describe("Attached adb serial (REQUIRED for device_verified; probed live)."),
      deviceModel: z.string().optional().describe("Optional expected model; mismatch with live probe rejects."),
      deviceFingerprint: z.string().optional().describe("Optional expected fingerprint; mismatch with live probe rejects."),
      deviceBootQemu: z.string().optional().describe("Optional expected ro.boot.qemu; mismatch rejects and live '1' is never hardware."),
      deviceFeature: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).optional().describe("device_verified only: exact lowercase feature slug measured on-device (for example controller_ray); required with deviceOutcome."),
      deviceOutcome: z.enum(["pass", "fail"]).optional().describe("device_verified only: explicit observed outcome. Swan parity closes only an exact deviceFeature with pass; claim prose is never interpreted."),
      targetSeq: z.number().int().nonnegative().optional().describe("Retract action: sequence number of the claim being corrected."),
      retractionReason: z.string().optional().describe("Retract action: why the earlier claim is withdrawn."),
      retractionNote: z.string().optional().describe("Retract action: optional nuance retained with the correction."),
      sourceReceiptId: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Promote action only: exact native source receipt identity."),
      sourceReceiptRoot: z.string().optional().describe("Promote action only: explicit canonical source receipt-store root."),
      sourceLedgerRoot: z.string().optional().describe("Promote action only: explicit canonical source ledger-store root."),
      targetReceiptRoot: z.string().optional().describe("Promote action only: explicit canonical target receipt-store root."),
      targetLedgerRoot: z.string().optional().describe("Promote action only: explicit canonical target ledger-store root."),
      report: z.boolean().optional().describe("Also return ledger_report's generated capability report for the app."),
    },
    async ({ app, action, claim, evidenceType, artifactPath, attestation, cClass, runReceiptId, runReceiptPromotionId, deviceSerial, deviceModel, deviceFingerprint, deviceBootQemu, deviceFeature, deviceOutcome, targetSeq, retractionReason, retractionNote, sourceReceiptId, sourceReceiptRoot, sourceLedgerRoot, targetReceiptRoot, targetLedgerRoot, report }) => {
      if (action === "promote" && report !== undefined) {
        return { status: "rejected", reason: "promote accepts only its exact promotion fields; report is record/retract-only and would read the ledger" };
      }
      const call = await doorCall();
      const recorded = await call("record_verification", {
        app,
        ...(action !== undefined ? { action } : {}),
        ...(claim !== undefined ? { claim } : {}),
        ...(evidenceType !== undefined ? { evidenceType } : {}),
        ...(artifactPath !== undefined ? { artifactPath } : {}),
        ...(attestation !== undefined ? { attestation } : {}),
        ...(cClass !== undefined ? { cClass } : {}),
        ...(runReceiptId !== undefined ? { runReceiptId } : {}),
        ...(runReceiptPromotionId !== undefined ? { runReceiptPromotionId } : {}),
        ...(deviceSerial !== undefined ? { deviceSerial } : {}),
        ...(deviceModel !== undefined ? { deviceModel } : {}),
        ...(deviceFingerprint !== undefined ? { deviceFingerprint } : {}),
        ...(deviceBootQemu !== undefined ? { deviceBootQemu } : {}),
        ...(deviceFeature !== undefined ? { deviceFeature } : {}),
        ...(deviceOutcome !== undefined ? { deviceOutcome } : {}),
        ...(targetSeq !== undefined ? { targetSeq } : {}),
        ...(retractionReason !== undefined ? { retractionReason } : {}),
        ...(retractionNote !== undefined ? { retractionNote } : {}),
        ...(sourceReceiptId !== undefined ? { sourceReceiptId } : {}),
        ...(sourceReceiptRoot !== undefined ? { sourceReceiptRoot } : {}),
        ...(sourceLedgerRoot !== undefined ? { sourceLedgerRoot } : {}),
        ...(targetReceiptRoot !== undefined ? { targetReceiptRoot } : {}),
        ...(targetLedgerRoot !== undefined ? { targetLedgerRoot } : {}),
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

  door(
    "pico_next",
    "DOOR 15 — What should I do NOW? Reads the ACTUAL local state — preflight checks, emulator, camera calibration, your generated briefs with their build/capture/trust-ledger progress — and returns {situation, nextAction:{door,argsExample,why}, alternatives}. Every recommendation names a real door on this surface; nothing is executed for you, and a LOOK step still means YOU read the capture.",
    {},
    async () => {
      const { call } = await inner();
      // a probe that cannot run (e.g. no adb) reads as its unhealthy state, not as a door error
      const [pre, emu] = await Promise.all([call("preflight_env", {}).catch(() => null), call("emulator_status", {}).catch(() => null)]);
      const failing = (Array.isArray(pre?.checks) ? pre.checks : []).filter((c: any) => c.status === "fail");
      const emulatorRunning = emu?.running === true;
      const calibration = readCameraCalibration();

      // briefstore + trust-ledger state, straight from the same files pico_build_app / fleet_build /
      // record_verification write (userBriefsDir, ~/.pico-mcp/ledgers, digest-bound run receipts).
      const home = os.homedir();
      const readLedgerEntries = (app: string): any[] => {
        try { return readLedger(app, validateHistoricalRunReceiptCaptureBinding).effectiveEntries; } catch { return []; }
      };
      let briefFiles: Array<{ id: string; brief: string; mtime: number }> = [];
      try {
        briefFiles = fs.readdirSync(userBriefsDir()).filter((f) => f.endsWith(".json")).map((f) => {
          const p = path.join(userBriefsDir(), f);
          let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch {}
          let brief = ""; try { brief = String(JSON.parse(fs.readFileSync(p, "utf8")).brief ?? ""); } catch {}
          return { id: f.replace(/\.json$/, ""), brief, mtime };
        });
      } catch { /* no user briefs yet */ }
      const briefs = briefFiles
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5)
        .map(({ id, brief }) => {
          const projectDir = path.join(home, "AndroidStudioProjects", `fleet-${id}-native`);
          const app = `com.fleet.${id}`;
          const entries = readLedgerEntries(app);
          const historical = findHistoricalRunReceipt(app);
          const selectedReceipt = historical.status === "valid" ? historical.receipt : null;
          const capture = selectedReceipt?.captureArtifactPath;
          const receiptId = selectedReceipt?.receiptId;
          const promotionId = selectedReceipt?.kind === "pico.portable-native-run-receipt"
            ? selectedReceipt.promotionId
            : undefined;
          const deviceFailures = entries.filter((entry) =>
            (entry.evidenceType === "device_verified" || entry.claimedEvidenceType === "device_verified")
            && entry.deviceOutcome === "fail",
          );
          const looked = selectedReceipt !== null && entries.some((entry) =>
            ((entry?.evidenceType === "vision_verified" && entry?.deviceOutcome !== "fail")
              || isPassingDeviceEvidenceForReceipt(entry, selectedReceipt.receiptRuntime))
            && runReceiptBindingsEqual(entry.runReceipt, selectedReceipt.binding)
            && entry.capture?.sha256 === selectedReceipt.captureSha256,
          );
          const autoJudgedForReceipt = selectedReceipt !== null && entries.some((entry) =>
            entry?.evidenceType === "auto_judged"
            && runReceiptBindingsEqual(entry.runReceipt, selectedReceipt.binding)
            && entry.capture?.sha256 === selectedReceipt.captureSha256,
          );
          const state = deviceFailures.length ? "device-verified-failure"
            : looked ? "vision-recorded"
            : selectedReceipt ? (autoJudgedForReceipt ? "auto-judged-needs-look" : "built-needs-look")
            : fs.existsSync(path.join(projectDir, "app/build/outputs/apk/debug/app-debug.apk")) ? "built-no-capture"
            : fs.existsSync(projectDir) ? "scaffolded-no-apk"
            : "planned-not-built";
          // brief stays FULL here: argsExample re-feeds it to pico_build_app, and a truncated brief
          // would hash to a DIFFERENT briefIdOf (a new project instead of resuming this one).
          return {
            id,
            brief,
            state,
            ...(deviceFailures.length ? { deviceFailures: deviceFailures.map((entry) => ({ seq: entry.seq, feature: entry.deviceFeature, claim: entry.claim })) } : {}),
            ...(capture && receiptId ? { capture, receiptId, ...(promotionId ? { promotionId } : {}) } : {}),
          };
        });
      const needsLook = briefs.filter((b) => b.state === "built-needs-look" || b.state === "auto-judged-needs-look");
      const deviceFailed = briefs.filter((b) => b.state === "device-verified-failure");
      const unbuilt = briefs.filter((b) => ["planned-not-built", "scaffolded-no-apk", "built-no-capture"].includes(b.state));

      const actions: Array<{ door: string; argsExample: any; why: string }> = [];
      if (failing.length)
        actions.push({ door: "pico_doctor", argsExample: {}, why: `preflight reports ${failing.length} failing check(s) (${failing.map((c: any) => c.name).join(", ")}) — each carries the exact fix; nothing downstream is trustworthy until they pass.` });
      for (const b of needsLook.slice(0, 2))
        actions.push({ door: "pico_record", argsExample: { app: `com.fleet.${b.id}`, claim: "<what the brief promised, as observed>", evidenceType: "vision_verified", artifactPath: b.capture, runReceiptId: b.receiptId, ...(b.promotionId ? { runReceiptPromotionId: b.promotionId } : {}), attestation: "<what you actually saw in the frame>" }, why: `'${b.id}' is ${b.state}: historical receipt ${b.receiptId}${b.promotionId ? ` promoted under ${b.promotionId}` : ""} preserves the exact capture at ${b.capture}, but its trust ledger has no matching human-LOOKED entry — READ that exact image first, then record what you saw with the exact receipt identity.` });
      for (const b of deviceFailed.slice(0, 1))
        actions.push({ door: "pico_build_app", argsExample: { brief: b.brief, draftSpec: `<the stored spec — ${path.join(userBriefsDir(), `${b.id}.json`)}>` }, why: `'${b.id}' has a device-verified FAIL finding (${(b as any).deviceFailures?.map((failure: any) => failure.feature ?? failure.claim).join(", ") ?? "feature unknown"}). The LOOK is already recorded, but it is negative evidence: repair the authored spec/app and re-measure rather than calling it vision-recorded.` });
      if (unbuilt.length) {
        const b = unbuilt[0];
        if (!emulatorRunning)
          actions.push({ door: "pico_emulator", argsExample: { action: "boot" }, why: `brief '${b.id}' is ${b.state} and the emulator is not running — the build pipeline (install/launch/capture) needs it.` });
        actions.push({ door: "pico_build_app", argsExample: { brief: b.brief, draftSpec: `<the stored spec — ${path.join(userBriefsDir(), `${b.id}.json`)}>` }, why: `brief '${b.id}' is ${b.state} — re-run the build with its stored spec; if it fails again, hand the failing note's error text to pico_fix.` });
      }
      if (!calibration && emulatorRunning)
        actions.push({ door: "pico_doctor", argsExample: { calibrate: true }, why: "the capture camera is uncalibrated — pico_measure refuses metric claims until the one-time calibration runs (takes minutes; the emulator is already up)." });
      if (!actions.length) {
        if (!briefs.length)
          actions.push({ door: "pico_build_app", argsExample: { brief: "a primitive table standing on my real floor with bodies dropping onto it from a clickable menu" }, why: "no generated briefs exist yet — a brief-only call returns a scaffold AppSpec to author (the two-step contract), the front door of the whole pipeline. The suggested brief is the Mixed-stage MR lane (the default: content seated on the passthrough room); a fully-virtual scene stays a first-class opt-in via meta.stageStyle '3'." });
        else
          actions.push({ door: "pico_build_app", argsExample: { brief: "<your next brief>" }, why: `all ${briefs.length} recent brief(s) are vision-recorded — nothing is pending; start the next app, or run pico_ship on a finished project to see what shipping still needs.` });
      }
      if (!emulatorRunning && !actions.some((a) => a.door === "pico_emulator"))
        actions.push({ door: "pico_emulator", argsExample: { action: "status" }, why: "the emulator is not running — status reports adb/boot/gRPC state before you decide to boot." });
      actions.push({ door: "pico_capabilities", argsExample: {}, why: "the ledger-generated capability matrix shows what this toolchain has actually PROVEN, per evidence class." });

      const [nextAction, ...rest] = actions;
      return {
        situation: [
          failing.length ? `${failing.length} preflight check(s) FAILING` : "preflight healthy",
          emulatorRunning ? `emulator running (${emu?.serial ?? "?"})` : "emulator not running",
          calibration ? `camera calibrated (${calibration.at ?? "date unknown"})` : "camera UNCALIBRATED (pico_measure blocked)",
          briefs.length ? `${briefs.length} recent brief(s): ${briefs.map((b) => `${b.id}=${b.state}`).join(", ")}` : "no generated briefs yet",
        ].join("; "),
        nextAction,
        alternatives: rest.slice(0, 3),
        state: { preflightFailing: failing.map((c: any) => c.name), emulatorRunning, cameraCalibrated: !!calibration, briefs: briefs.map((b) => ({ ...b, brief: b.brief.length > 90 ? `${b.brief.slice(0, 90)}…` : b.brief })) },
      };
    },
  );

  door(
    "pico_loop",
    "DOOR 16 — Declarative build→verify→repair loop (2026-08 Loop Engineering lane): state a goal, " +
      "acceptance criteria (structural / visual / logcat / perf), and a budget; the loop plans, builds " +
      "through the fleet pipeline, machine-checks every criterion, and when a failure matches a " +
      "retained lesson with a concrete AppSpec mutation, applies replan_spec and iterates. Failures " +
      "without a safe automatic mutation exit manual-repair-required with their measured detail; the " +
      "loop never relabels them build_failed or pretends an unattended fix occurred. Logcat criteria " +
      "are evaluated before structural asserts because assert_scene clears logcat for its own dump. " +
      "HONESTY CEILING BY EVIDENCE: a calibrated-eye PASS earns `auto_judged` only when the matching " +
      "ledger write succeeds; a measured PASS with a rejected/missing write remains `structural`. An iteration " +
      "whose requested structural/logcat/perf criteria pass while the eye FAILs, ESCALATEs, or is " +
      "unscored remains `structural` — it never inherits a visual tier from the word accepted. The loop " +
      "returns a remainingLookObligation naming the artifacts a person or vision-capable agent must " +
      "still LOOK at before any vision_verified claim. A no-progress detector stops after two " +
      "consecutive iterations failing with the identical signature; an unmeasurable criterion " +
      "(missing perf utilities, no Agent Bridge) stops the loop honestly instead of silently passing; " +
      "an eye ESCALATE (a frame class the machine cannot judge, e.g. high-coverage passthrough) exits " +
      "built-needs-look once everything measurable passes — escalation is a look obligation, never a " +
      "defect to repair. An absent or unknown eye score uses the same terminal status but is labeled " +
      "unscored, never misreported as an escalation. " +
      "PERF LOOP LANE: a perf criterion measures with pico-cli and carries its diagnosis into the " +
      "failure detail. It re-measures only when another applicable retained lesson actually mutates " +
      "the AppSpec; a generic low-FPS result has no safe automatic quality tradeoff and exits for " +
      "manual repair. Every measured iteration's " +
      "pico-cli appFps numbers are ledgered and returned as perfTrend (before→after, structural " +
      "evidence), and a perf failure carries pico-cli's own diagnosis engine verdict, never a guess. " +
      "Every iteration writes a structural trust-ledger entry. Each native run also returns a " +
      "structural receiptId/receiptPath and its exact immutable " +
      "capture; the receipt proves identity and continuity, never what the pixels look like, so " +
      "the returned capture still requires a LOOK. Budget uses meta.budget semantics " +
      "(iterations, timeMin). Builds take minutes each — configure your host's MCP timeout accordingly " +
      "(≥ 10 minutes, more for multi-iteration budgets). Prefer authoring a draftSpec first " +
      "(pico_build_app's two-step); goal-only runs start from the planner's archetype scaffold, " +
      "declared in the result.",
    {
      goal: z.string().describe("What to build/achieve, e.g. 'a knockdown game with three stacked crates on my real table'. Used as the brief; also keys the fleet project + ledger."),
      draftSpec: z.any().optional().describe("An authored AppSpec to iterate from (recommended — the planner never guesses intent as well as you author it). Omitted: the loop starts from the planner's archetype scaffold and says so."),
      acceptance: z
        .array(z.object({
          kind: z.enum(["structural", "visual", "logcat", "perf"]).describe("structural = Agent Bridge scene asserts; visual = the calibrated eye's PASS on the canonical capture (auto_judged; ESCALATE becomes built-needs-look, while a missing/unknown result is explicitly unscored); logcat = assert_logcat pattern; perf = pico-cli appFps p5 floor."),
          entitiesPresent: z.array(z.string()).optional().describe("structural: entity names that must exist."),
          minEntities: z.number().int().optional().describe("structural: minimum entity count."),
          componentsPresent: z.array(z.string()).optional().describe("structural: component class names that must exist."),
          pattern: z.string().optional().describe("logcat: case-insensitive regex that must appear (REQUIRED for kind:'logcat')."),
          tag: z.string().optional().describe("logcat: restrict to this tag."),
          timeoutSec: z.number().int().optional().describe("logcat: wait window (default 20)."),
          minAppFpsP5: z.number().optional().describe("perf: required appFps p5 floor (default 60)."),
          durationSec: z.number().int().optional().describe("perf: profiling window (default perf_diagnose's)."),
        }))
        .min(1)
        .describe("The exit bar. Every criterion must pass in the SAME iteration for the loop to accept."),
      budget: z
        .object({
          iterations: z.number().int().min(1).max(6).optional().describe("Max build+verify iterations (default 3)."),
          timeMin: z.number().optional().describe("Soft wall-clock budget in minutes (default 20; checked between iterations)."),
          toolCalls: z.number().int().optional().describe("Accepted for meta.budget parity; iterations is the effective cap here."),
        })
        .optional()
        .describe("meta.budget semantics (same shape as an AppSpec's meta.budget)."),
      onFail: z.enum(["replan", "stop"]).optional().describe("replan (default): apply the retained-lesson repair and iterate. stop: return after the first failing iteration."),
    },
    async ({ goal, draftSpec, acceptance, budget, onFail }) => {
      const call = await doorCall();
      const started = Date.now();
      const maxIterations = budget?.iterations ?? 3;
      const timeMs = (budget?.timeMin ?? 20) * 60_000;
      const repair = onFail ?? "replan";
      const id = briefIdOf(goal);
      const app = `com.fleet.${id}`;
      const projectDir = fleetProjectDirectory(id);
      const iterationsLog: Array<{ iteration: number; outcomes: LoopCriterionOutcome[]; capture: string | null; receiptId: string | null; receiptPath: string | null; ledger: string }> = [];
      const scaffoldStarted = draftSpec === undefined;

      // Criterion pre-flight: a misconfigured criterion must be rejected BEFORE the first
      // multi-minute build, not discovered as unmeasurable after it (zod cannot express
      // per-kind required fields without effects, so the gate lives here).
      const patternless = acceptance.filter((c: any) => c.kind === "logcat" && !c.pattern);
      if (patternless.length)
        return { status: "invalid-acceptance", iterations: 0, fix: "kind:'logcat' requires a pattern (the regex that must appear). Add one to each logcat criterion and re-call — nothing was built." };

      // Plan. A goal-only call takes the planner's archetype scaffold as the starting spec —
      // weaker than an authored draftSpec, and the result says so (scaffoldStarted).
      let plan = await call("plan_app_spec", { brief: goal, ...(draftSpec !== undefined ? { draftSpec } : {}) });
      if (plan?.status === "scaffold") plan = await call("plan_app_spec", { brief: goal, draftSpec: plan.scaffold });
      if (plan?.status === "needs_fix")
        return { status: "plan-failed", iterations: 0, detail: { lint: plan.lint, rationale: plan.rationale }, fix: "The starting spec has blocking lint errors — fix each detail.lint.errors entry and re-call (author via pico_build_app's two-step if needed)." };
      if (!plan?.spec)
        return { status: "plan-failed", iterations: 0, detail: plan, fix: "Fix the problems named in detail (each issues entry names the failing path and a known-good fragment), or author a draftSpec with pico_build_app's two-step first, then re-call." };
      let spec = plan.spec;

      let prevSignature: string | null = null;
      let lastOutcomes: LoopCriterionOutcome[] = [];
      let lastCapture: string | null = null;
      let lastReceiptId: string | null = null;
      let lastReceiptPath: string | null = null;
      let ranFleet = false;
      // The perf loop lane (2026-08-12 call, lane 2): every measured perf iteration lands here, so
      // every exit carries the before→after trail — measure → fix → re-measure, ledgered.
      const perfTrail: Array<Record<string, unknown>> = [];

      const exit = (status: string, iteration: number, extra: Record<string, unknown>) => ({
        status,
        iterations: iteration,
        briefId: id,
        projectDir,
        scaffoldStarted,
        iterationsLog,
        ...(ranFleet ? { capture: lastCapture, receiptId: lastReceiptId, receiptPath: lastReceiptPath } : {}),
        ...(perfTrail.length ? {
          perfTrend: perfTrail,
          perfEvidence: "structural — pico-cli-measured appFps numbers (the official profiler); a delta proves the numbers moved, never how anything looks",
        } : {}),
        ...extra,
      });

      for (let i = 1; i <= maxIterations; i++) {
        if (Date.now() - started > timeMs)
          return exit("budget-exhausted", i - 1, { failing: lastOutcomes.filter((o) => o.status !== "pass"), fix: `timeMin ${budget?.timeMin ?? 20} elapsed before acceptance — raise budget.timeMin/iterations or fix the failing criteria by hand (pico_fix names the next action), then re-call.` });

        // Any logcat criterion: clear the buffer BEFORE the build/launch, so this iteration's
        // assert can only match lines this iteration's app emitted (launch-time markers included).
        // Asserting against an uncleared buffer false-PASSed on lines from a previous run.
        if (acceptance.some((c: any) => c.kind === "logcat"))
          await call("adb_shell", { command: "logcat -c" }).catch(() => {});

        writeUserBrief(id, { id, brief: goal, spec });
        const fleet = await call("fleet_build", { briefIds: [id], settleSec: 16 });
        ranFleet = true;
        const r = fleet?.results?.[0] ?? {};
        const recordedReceipt = r.receipt?.status === "recorded"
          && typeof r.receipt.receiptId === "string"
          && typeof r.receipt.receiptPath === "string"
          && typeof r.receipt.capturePath === "string"
          && r.artifact === r.receipt.capturePath
          ? r.receipt
          : null;
        if (recordedReceipt) {
          lastCapture = recordedReceipt.capturePath;
          lastReceiptId = recordedReceipt.receiptId;
          lastReceiptPath = recordedReceipt.receiptPath;
        }

        const outcomes: LoopCriterionOutcome[] = [];
        if (!r.built || !r.installed || !recordedReceipt || r.concluded !== true) {
          outcomes.push({
            kind: "build",
            status: "fail",
            detail: (r.notes ?? []).join("\n") || (!recordedReceipt
              ? "native run produced no receipt-bound capture"
              : "native receipt was recorded, but the verification route did not conclude"),
          });
        } else {
          // assert_scene clears logcat for its isolated dump, so launch-log evidence must be
          // consumed before any structural criterion regardless of the caller's array order.
          for (const c of loopCriteriaInEvidenceSafeOrder(acceptance)) {
            if (c.kind === "visual") {
              // Three-way, matching the eye's own vocabulary: PASS = auto_judged; FAIL = the eye
              // AFFIRMATIVELY judged the content wrong (repairable); anything else (ESCALATE /
              // unknown / unscored) = the machine cannot judge this frame class — needs-look,
              // never a repairable failure (replanning a possibly-correct app is worse than
              // stopping and asking for the look).
              outcomes.push(loopVisualOutcome(r.verdict, recordedReceipt.capturePath, r.notes ?? [], r.visualChecks ?? [], r.visualJudgeNote, r.visualLedger));
            } else if (c.kind === "structural") {
              // assert_scene, not the "verify" orchestrator: verify's TEXT content is prose for a
              // reading agent (its JSON lives in structuredContent, which innerCall's text-parse
              // never sees), while assert_scene returns a parseable {pass, results, scene} body.
              const v = await call("assert_scene", { applicationId: app, ...(c.entitiesPresent ? { entitiesPresent: c.entitiesPresent } : {}), ...(c.minEntities != null ? { minEntities: c.minEntities } : {}), ...(c.componentsPresent ? { componentsPresent: c.componentsPresent } : {}) });
              if (v && typeof v === "object" && typeof v.pass === "boolean") {
                outcomes.push(v.pass
                  ? { kind: "structural", status: "pass", detail: `${v.scene?.entityCount ?? "?"} entities; all asserts hold` }
                  : { kind: "structural", status: "fail", detail: JSON.stringify((v.results ?? []).filter((x: any) => !x.pass)).slice(0, 400) });
              } else {
                // isError text (no Agent Bridge, broadcast failed) comes back as a raw string.
                outcomes.push({ kind: "structural", status: "unmeasurable", detail: (typeof v === "string" ? v : JSON.stringify(v ?? null)).slice(0, 300) });
              }
            } else if (c.kind === "logcat") {
              if (!c.pattern) { outcomes.push({ kind: "logcat", status: "unmeasurable", detail: "kind:'logcat' requires a pattern" }); continue; }
              const l = await call("assert_logcat", { pattern: c.pattern, ...(c.tag ? { tag: c.tag } : {}), timeoutSec: c.timeoutSec ?? 20 });
              if (l && typeof l === "object" && typeof l.matched === "boolean") {
                outcomes.push(l.matched
                  ? { kind: "logcat", status: "pass", detail: l.line }
                  : { kind: "logcat", status: "fail", detail: `no logcat match for '${c.pattern}' within ${c.timeoutSec ?? 20}s` });
              } else {
                // isError text (bad regex, no device) — the tool's own words, never a fabricated
                // "no match" measurement that replanning would then chase.
                outcomes.push({ kind: "logcat", status: "unmeasurable", detail: (typeof l === "string" ? l : JSON.stringify(l ?? null)).slice(0, 300) });
              }
            } else if (c.kind === "perf") {
              const p = await call("perf_diagnose", { packageName: app, ...(c.durationSec ? { durationSec: c.durationSec } : {}) });
              const appFps = p?.summary?.appFps;
              const p5 = typeof appFps?.p5 === "number" ? appFps.p5 : null;
              const avg = typeof appFps?.avg === "number" ? appFps.avg : null;
              if (p5 === null || avg === null || avg === 0) {
                outcomes.push({
                  kind: "perf",
                  status: "unmeasurable",
                  detail: p?.note ?? p?.error ?? "profiler reports no app 3D frames (or pico-cli/perf utilities unavailable) — not measured, never assumed",
                  ...(typeof p?.failureClass === "string" ? { failureClass: p.failureClass } : {}),
                });
              } else {
                // Perf loop lane: record the measurement (before→after evidence) and ground any
                // failure in pico-cli's OWN diagnosis engine — never a guess from code structure.
                perfTrail.push({
                  iteration: i,
                  p5,
                  ...(typeof appFps?.p10 === "number" ? { p10: appFps.p10 } : {}),
                  ...(typeof appFps?.p50 === "number" ? { p50: appFps.p50 } : {}),
                  avg,
                  ...(typeof p?.jankWindowCount === "number" ? { jankWindows: p.jankWindowCount } : {}),
                  ...(p?.reportPath ? { reportPath: p.reportPath } : {}),
                });
                const floor = c.minAppFpsP5 ?? 60;
                const diagTop = p?.diagnosis
                  ? (typeof p.diagnosis === "string" ? p.diagnosis : JSON.stringify(p.diagnosis)).slice(0, 220)
                  : null;
                outcomes.push(p5 >= floor
                  ? { kind: "perf", status: "pass", detail: `appFps p5=${p5} >= floor ${floor} (avg ${avg})` }
                  : { kind: "perf", status: "fail", detail: `appFps p5=${p5} below floor ${floor} (avg ${avg})${diagTop ? `; pico-cli diagnosis: ${diagTop}` : ""}${p?.reportPath ? `; report: ${p.reportPath}` : ""}` });
              }
            }
          }
        }
        lastOutcomes = outcomes;
        // Per-iteration ledger entry — structural BY DESIGN: the machine ran checks; nothing was
        // human-seen. A failed write is DISCLOSED in the iteration log (never silently swallowed:
        // the door's contract promises an entry per iteration, so a broken ledger lane must show).
        const perfNow = perfTrail.length && (perfTrail[perfTrail.length - 1] as any).iteration === i ? perfTrail[perfTrail.length - 1] as any : null;
        const led = await call("record_verification", { app, claim: `pico_loop iteration ${i}/${maxIterations} [${goal.slice(0, 80)}]: ${outcomes.map((o) => `${o.kind}=${o.status}`).join(" ")}${perfNow ? ` | appFps p5=${perfNow.p5} avg=${perfNow.avg} (pico-cli measured)` : ""}`, evidenceType: "structural" }).catch((e) => `record_verification threw: ${e instanceof Error ? e.message : String(e)}`);
        const ledger = led && typeof led === "object" && led.status === "recorded"
          ? "recorded"
          : `NOT recorded: ${(typeof led === "string" ? led : JSON.stringify(led ?? null)).slice(0, 200)}`;
        iterationsLog.push({
          iteration: i,
          outcomes,
          capture: recordedReceipt?.capturePath ?? null,
          receiptId: recordedReceipt?.receiptId ?? null,
          receiptPath: recordedReceipt?.receiptPath ?? null,
          ledger,
        });

        const needsLook = outcomes.filter((o) => o.status === "needs-look");
        const failing = outcomes.filter((o) => o.status === "fail" || o.status === "unmeasurable");
        if (!failing.length && !needsLook.length) {
          const acceptedEvidence = loopAcceptanceEvidence(outcomes, r.verdict, r.visualLedger);
          return exit("accepted", i, {
            ceiling: acceptedEvidence.ceiling,
            acceptanceScope: "the caller's requested criteria in this iteration",
            fleetVisualVerdict: typeof r.verdict === "string" ? r.verdict : "unscored",
            remainingLookObligation: [
              { artifact: recordedReceipt?.capturePath ?? null, whatToConfirm: `the running app actually shows the goal: ${goal}` },
              ...(r.panelArtifact ? [{ artifact: r.panelArtifact, whatToConfirm: "panel content renders as intended (panel captures are returned unjudged)" }] : []),
            ],
            honesty: acceptedEvidence.honesty,
          });
        }
        if (!failing.length) {
          // Everything measurable passed; what remains is either an explicit eye ESCALATE or an
          // absent/unknown score. Both require a look, but only the former may claim escalation.
          // Repair would mutate an app nothing has judged wrong.
          return exit("built-needs-look", i, {
            needsLook,
            remainingLookObligation: [
              { artifact: recordedReceipt?.capturePath ?? null, whatToConfirm: `the running app actually shows the goal: ${goal}` },
              ...(r.panelArtifact ? [{ artifact: r.panelArtifact, whatToConfirm: "panel content renders as intended (panel captures are returned unjudged)" }] : []),
            ],
            honesty: loopNeedsLookHonesty(needsLook),
          });
        }
        if (failing.some((o) => o.status === "unmeasurable"))
          return exit("unmeasurable-acceptance", i, { failing, fix: loopUnmeasurableFix(failing) });

        const signature = loopFailureSignature(outcomes);
        if (prevSignature !== null && signature === prevSignature)
          return exit("no-progress", i, { failing, fix: "Two consecutive iterations failed with the identical signature — the repair lane is not moving. Read failing[].detail, run pico_fix on the concrete error text, or adjust the draftSpec/acceptance, then re-call." });
        prevSignature = signature;

        if (repair === "stop")
          return exit("failed", i, { failing, fix: "onFail:'stop' — read failing[].detail; pico_fix maps the error text to a known fix, then re-call." });
        if (i === maxIterations) break;

        // Repair only failures for which replan_spec owns a concrete AppSpec mutation. Arbitrary
        // structural/logcat/perf failures are measurements, not generic build failures; pretending
        // otherwise immediately selected a symptom replan_spec cannot handle.
        const repairSelection = loopRepairSelection(failing);
        if (!repairSelection.failures.length)
          return exit("manual-repair-required", i, {
            failing,
            fix: "No failing criterion maps to a retained lesson with a safe AppSpec mutation. Read failing[].detail and use pico_fix/the named profiler or assertion output to repair it manually, then re-call; the loop will not invent a build_failed mutation.",
          });
        const beforeReplan = spec;
        const rp = await call("replan_spec", { spec, failures: repairSelection.failures });
        if (rp?.status === "invalid" || !rp?.spec)
          return exit("no-progress", i, { failing, detail: rp, fix: "replan_spec could not patch the spec (see detail) — repair by hand (pico_fix names the next action), then re-call." });
        // A camera-pose repair changes verification metadata without recompiling generated code, so
        // recompileSubtree may correctly be empty. Only a full-spec equality check proves no change.
        if (!loopSpecMutated(beforeReplan, rp.spec))
          return exit("manual-repair-required", i, { failing, detail: { replanChanges: rp.changes ?? [], unsupported: repairSelection.unsupported }, fix: "replan_spec found no applicable retained lesson that changed the AppSpec (see detail.replanChanges). The loop cannot move on its own: read failing[].detail, repair the spec by hand, then re-call." });
        const replanned = await call("plan_app_spec", { brief: goal, draftSpec: rp.spec });
        // Mirror the entry gate: needs_fix carries a spec BUT with blocking lint errors —
        // building it anyway ships a broken app, so it is a plan failure here too.
        if (replanned?.status === "needs_fix")
          return exit("plan-failed", i, { detail: { lint: replanned.lint, rationale: replanned.rationale }, fix: "The patched spec re-lints with blocking errors — fix each detail.lint.errors entry and re-call with the corrected draftSpec." });
        if (!replanned?.spec)
          return exit("plan-failed", i, { detail: replanned, fix: "The patched spec no longer lints — fix detail.issues (or detail.lint.errors) and re-call with the corrected draftSpec." });
        spec = replanned.spec;
      }
      return exit("budget-exhausted", maxIterations, { failing: lastOutcomes.filter((o) => o.status !== "pass"), fix: `budget.iterations (${maxIterations}) exhausted before acceptance — raise the budget or fix the failing criteria by hand (failing[].detail + pico_fix), then re-call.` });
    },
  );
}

export function doorsSurfaceActive(): boolean {
  return SURFACE() === "doors";
}
