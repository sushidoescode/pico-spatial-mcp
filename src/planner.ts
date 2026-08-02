import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema, exampleSpec, type AppSpec, type CapabilityClass } from "./appspec.js";
import { CAPABILITY_MANIFEST } from "./capabilities.js";
import { matchShapeArchetype } from "./fleetbuild.js";

/**
 * planner.ts — v5.0 `plan_app_spec` + `replan_spec`.
 *
 * The LLM agent is the PLANNER; these tools are the TYPECHECKER + FEASIBILITY LINTER + RECONCILER. Given a
 * draft AppSpec, plan_app_spec validates it, checks referential integrity, STAMPS each node's C1–C4
 * capability class (the honesty engine — decided at plan time), requires a forward-FOV pose for every C0/C2
 * visual claim, checks every node maps to a real tool in the manifest, flags budget overflow, and returns
 * the normalized spec + an honest emulator-vs-Swan preview. replan_spec mutates the spec in response to a
 * verification failure (move a slot out of the bed, downgrade a C3 interaction to broadcast, mark an env
 * asset for baking) and names the subtree to recompile. Side-effect-free — inspect/edit before compiling.
 */

// ── C-class inference (the plan-time honesty decision) ─────────────────────────────────────────────────
function interactionClass(trigger: string, driveChannel: string): CapabilityClass {
  // v9.2: a `press` interaction compiles to the in-world clickable GameMenu (generate_game_menu_kotlin),
  // stamped C0_emulator by the compiler — it is mouse-bridge clickable AND broadcast-drivable on the
  // emulator (vision-verified). Only controller_ray/grab stay Swan-only.
  if (trigger === "controller_ray" || trigger === "grab") return "C3";
  if (trigger === "press") return "C0_emulator";
  if (trigger === "gaze_dwell") return driveChannel === "broadcast" ? "C0_emulator" : "C3";
  return "C0_emulator"; // broadcast
}

function environmentClass(kind: string): CapabilityClass {
  if (kind === "homeEnvProxy") return "C1"; // real surfaces are Swan-only; floor y=0 is the only anchor
  return "C0_emulator";
}

const toolExists = (name: string) => CAPABILITY_MANIFEST.some((t) => t.tool === name);

// ── C-class reconciliation (v6.1 honesty fix) ──────────────────────────────────────────────────────────
// A verification node's capabilityClass used to be trusted verbatim, so a Swan-only C3/C1 feature
// relabelled C0_emulator sailed through as emulator vision_verified (ADVERSARIAL_FINDINGS C3). We now
// COMPUTE the true class from the node's targetRef and refuse an emulator-verifiable declaration for a
// target whose real class is Swan-only.
const VERIFIABLE_NOW = new Set<CapabilityClass>(["C0_emulator", "C2"]);
const SWAN_ONLY = new Set<CapabilityClass>(["C1", "C3", "C4_headset_only"]);

/** The true capability class of a verification node, derived from what it targets (null if unresolved). */
export function computeNodeClass(spec: AppSpec, v: { targetRef?: string }): CapabilityClass | null {
  const ref = v.targetRef;
  if (!ref) return null;
  const it = spec.interactions.find((i) => i.id === ref);
  if (it) return interactionClass(it.trigger, it.driveChannel);
  const sc = spec.scenes.find((s) => s.id === ref);
  if (sc) return environmentClass(sc.environment.kind);
  if (
    spec.layouts.some((l) => l.id === ref) ||
    spec.objects.some((o) => o.id === ref) ||
    spec.panels.some((p) => p.id === ref)
  ) return "C0_emulator";
  return null;
}

/** For a verification node, the class that must actually govern it: the STRICTER of declared vs computed. */
export function effectiveNodeClass(spec: AppSpec, v: { targetRef?: string; capabilityClass: CapabilityClass }): CapabilityClass {
  const computed = computeNodeClass(spec, v);
  if (!computed) return v.capabilityClass;
  // If either says Swan-only, the node is Swan-only (can't be honestly emulator-verified now).
  if (SWAN_ONLY.has(computed) || SWAN_ONLY.has(v.capabilityClass)) {
    // prefer the computed Swan class for specificity; else the declared one
    return SWAN_ONLY.has(computed) ? computed : v.capabilityClass;
  }
  return computed; // both verifiable-now: computed (C0/C2) is authoritative
}

type Lint = { errors: string[]; warnings: string[] };

export function lintSpec(spec: AppSpec): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sceneIds = new Set(spec.scenes.map((s) => s.id));
  const layoutIds = new Set(spec.layouts.map((l) => l.id));
  const objectIds = new Set(spec.objects.map((o) => o.id));
  const dataIds = new Set(spec.data.map((d) => d.id));
  const panelIds = new Set(spec.panels.map((p) => p.id));

  // referential integrity
  for (const l of spec.layouts) if (!sceneIds.has(l.sceneId)) errors.push(`layout '${l.id}' references unknown scene '${l.sceneId}'`);
  for (const o of spec.objects) {
    if (!sceneIds.has(o.sceneId)) errors.push(`object '${o.id}' references unknown scene '${o.sceneId}'`);
    if (o.layoutRef && !layoutIds.has(o.layoutRef)) errors.push(`object '${o.id}' references unknown layout '${o.layoutRef}'`);
    if (o.dataBindRef && !dataIds.has(o.dataBindRef)) errors.push(`object '${o.id}' references unknown data '${o.dataBindRef}'`);
  }
  for (const d of spec.data) for (const b of d.bindsTo) if (!objectIds.has(b)) errors.push(`data '${d.id}' binds to unknown object '${b}'`);
  for (const it of spec.interactions) if (!objectIds.has(it.target) && !layoutIds.has(it.target)) warnings.push(`interaction '${it.id}' target '${it.target}' is not a known object/layout id`);
  if (!sceneIds.has(spec.navigation.startScene)) errors.push(`navigation.startScene '${spec.navigation.startScene}' is not a scene`);
  for (const p of spec.navigation.portals) {
    if (!sceneIds.has(p.from)) errors.push(`portal from unknown scene '${p.from}'`);
    if (!sceneIds.has(p.to)) errors.push(`portal to unknown scene '${p.to}'`);
  }

  // tool availability
  if (spec.layouts.length && !toolExists("generate_layout_kotlin")) errors.push("layouts require generate_layout_kotlin (missing from manifest)");
  if (spec.interactions.length && !toolExists("generate_interaction_kotlin")) errors.push("interactions require generate_interaction_kotlin (missing from manifest)");
  if (spec.data.some((d) => d.source === "json") && !toolExists("generate_data_binding_kotlin")) errors.push("json data requires generate_data_binding_kotlin (missing from manifest)");
  if (spec.panels.length && !toolExists("generate_panel_compose_kotlin")) errors.push("panels require generate_panel_compose_kotlin (missing from manifest)");

  // C2: every C0/C2 capture claim needs a forward-FOV pose (content outside the forward view can't be captured)
  for (const v of spec.verificationPlan) {
    const visualNow = v.capabilityClass === "C0_emulator" || v.capabilityClass === "C2";
    if (v.method === "capture" && visualNow && !v.forwardFOVpose)
      errors.push(`verification '${v.claim}' is a ${v.capabilityClass} capture but has no forwardFOVpose — it can't be honestly verified (C2). Add a pose or tag it Swan-only.`);
    if (v.targetRef && !sceneIds.has(v.targetRef) && !layoutIds.has(v.targetRef) && !objectIds.has(v.targetRef) && !panelIds.has(v.targetRef) && !spec.interactions.some((i) => i.id === v.targetRef))
      warnings.push(`verification '${v.claim}' targetRef '${v.targetRef}' resolves to no spec node`);
    // v6.1 class reconciliation: an emulator-verifiable declaration for a Swan-only target is an over-claim.
    const computed = computeNodeClass(spec, v);
    if (computed && VERIFIABLE_NOW.has(v.capabilityClass) && SWAN_ONLY.has(computed))
      errors.push(`verification '${v.claim}' is declared ${v.capabilityClass} (emulator-verifiable) but its target '${v.targetRef}' is truly ${computed} (Swan-only) — this would over-claim emulator verification. Set capabilityClass to ${computed} (built-for-Swan) or drive it via broadcast.`);
  }

  // gated api is network-flagged
  for (const d of spec.data) if (d.source === "gated_api") warnings.push(`data '${d.id}' is a gated_api node — network-gated; verify with one live call and flag it, don't fake it`);

  return { errors, warnings };
}

export function emulatorVsSwanPreview(spec: AppSpec) {
  const verifiableNow: string[] = [];
  const builtForSwan: string[] = [];
  for (const it of spec.interactions) {
    const cls = interactionClass(it.trigger, it.driveChannel);
    (cls === "C0_emulator" ? verifiableNow : builtForSwan).push(`interaction ${it.id} (${it.trigger}) → ${cls}`);
  }
  for (const s of spec.scenes) {
    const cls = environmentClass(s.environment.kind);
    (cls === "C0_emulator" ? verifiableNow : builtForSwan).push(`scene ${s.id} env ${s.environment.kind} → ${cls}`);
  }
  for (const v of spec.verificationPlan) {
    const now = v.capabilityClass === "C0_emulator" || v.capabilityClass === "C2";
    (now ? verifiableNow : builtForSwan).push(`verify "${v.claim}" → ${v.capabilityClass}`);
  }
  for (const h of spec.headsetLayer) builtForSwan.push(`headset: ${h.feature} → ${h.capabilityClass}`);
  return { verifiableNow, builtForSwan };
}

// ── v27.6: scaffold archetypes ──────────────────────────────────────────────────────────────────────────
// The two-step plan_app_spec authoring flow used to hand every brief-only caller the SAME generic
// showcase scaffold (6-card shelf + data binding) regardless of what they asked for — a stranger
// authoring "three spinning crystals" got flat cards and no steer toward the pipeline's proven patterns
// (display grid+spin, physics knockdown, HUD data-panel). pickArchetype keyword-matches the brief so the
// scaffold ALREADY resembles the corpus brief closest to the ask; the author adapts counts/names instead
// of inventing structure from a mismatched template.
export type Archetype = "game" | "datapanel" | "display" | "generic";

const GAME_WORDS = ["bowling", "knock", "throw", "launch", "pins", "ball", "strike", "shoot", "game", "putt"];
const DATAPANEL_WORDS = ["dashboard", "panel", "hud", "monitor", "feed", "stats", "data", "live"];
const DISPLAY_WORDS = ["crystal", "gem", "display", "gallery", "showcase", "spin", "orbit", "grid of", "shelf", "museum", "exhibit", "pedestal"];
// Within display: these steer the museum/gallery variant (arc + inspect) instead of the crystals grid.
const MUSEUM_WORDS = ["museum", "gallery", "exhibit", "pedestal"];

/** Pick the archetype closest to the brief, WITH the keyword(s) that fired — the scaffold response
 *  names them so the author can see why the steer happened and override a wrong one. Priority on
 *  overlap: game > datapanel > display (a "bowling game dashboard" is a game — the physics/interaction
 *  pattern dominates a HUD word). No keyword match → generic, always. */
export function matchArchetype(brief: string): { archetype: Archetype; matched: string[] } {
  const b = brief.toLowerCase();
  const table: Array<[Archetype, string[]]> = [["game", GAME_WORDS], ["datapanel", DATAPANEL_WORDS], ["display", DISPLAY_WORDS]];
  for (const [archetype, words] of table) {
    const matched = words.filter((w) => b.includes(w));
    if (matched.length) return { archetype, matched };
  }
  return { archetype: "generic", matched: [] };
}

export function pickArchetype(brief: string): Archetype {
  return matchArchetype(brief).archetype;
}

/** display: grid layout + data-bound objects with a spin tween, modeled on briefs/crystals.json. The
 *  data node's id/asset is derived from a shape word named in the brief (matchShapeArchetype — the same
 *  table fleet_build's v27.1 procedural provisioning checks) so a stranger's "crystals"/"gems"/"cubes"
 *  brief gets REAL baked geometry instead of a flat tinted card; falls back to "items" when no shape word
 *  is present. Museum/gallery briefs (MUSEUM_WORDS) instead get the corpus exhibition shape: an ARC
 *  layout (briefs/gallery.json) + a gaze-dwell showDetail inspect interaction (briefs/museum.json,
 *  broadcast-driven so it stays C0/emulator-verifiable) — the closest proven "tour the exhibits"
 *  pattern; the compiler has no dedicated 'tour' action. */
function displayScaffold(brief: string, appName: string, packageName: string): AppSpec {
  const shape = matchShapeArchetype(brief) ?? "items";
  const museum = MUSEUM_WORDS.some((w) => brief.toLowerCase().includes(w));
  const layoutId = museum ? "arc1" : "grid1";
  return appSpecSchema.parse({
    // v32 MR default: Mixed ("1") — the showpieces float at eye level in front of the user with the
    // real room as the backdrop (explicit centerY/centerZ document the placement; the values are the
    // proven layout-generator defaults, unchanged geometry). Fully-virtual briefs opt into "3".
    meta: { appName, packageName, stageStyle: "1", brief },
    scenes: [
      {
        id: "main",
        environment: { kind: "homeEnvProxy" },
        lighting: { rig: "sun" },
        colliders: { props: [] },
      },
    ],
    layouts: [
      museum
        ? { id: layoutId, sceneId: "main", pattern: "arc", count: 3, params: { radius: 2.2, centerY: 1.4 } }
        : { id: layoutId, sceneId: "main", pattern: "grid", count: 3, params: { columns: 3, centerY: 1.4, centerZ: -2.5 } },
    ],
    objects: [
      {
        id: "showpieces",
        sceneId: "main",
        source: "model",
        layoutRef: layoutId,
        dataBindRef: shape,
        transform: { scale: [1.2, 1.2, 1.2] },
        // exhibits sit still (gallery.json's works are static); the crystals variant spins
        ...(museum ? {} : { anim: { type: "tween", property: "rotation", from: [0, 0, 0], to: [0, 360, 0], duration: 6, loop: true } }),
      },
    ],
    data: [{ id: shape, source: "json", asset: `data/${shape}.json`, bindsTo: ["showpieces"] }],
    interactions: museum
      ? [{ id: "inspect", trigger: "gaze_dwell", target: "showpieces", action: "showDetail", driveChannel: "broadcast" }]
      : [],
    navigation: { startScene: "main", portals: [] },
    verificationPlan: [
      museum
        ? {
            claim: "3 exhibits render in an arc",
            method: "capture",
            capabilityClass: "C0_emulator",
            targetRef: layoutId,
            forwardFOVpose: { yawDeg: 0, pitchDeg: 0, targetZ: -2.2 },
          }
        : {
            claim: "3 objects render spinning in a grid",
            method: "capture",
            capabilityClass: "C0_emulator",
            targetRef: layoutId,
            forwardFOVpose: { yawDeg: 0, pitchDeg: 0, targetZ: -2.5 },
          },
    ],
    headsetLayer: [],
  });
}

/** game: an MR TABLETOP knockdown modeled on briefs/mrtable.json (the proven Mixed-stage pattern):
 *  a static primitive table standing in the user's real room (the exact mrtable table — base at
 *  y=0.4, the emulator room's measured FLOOR plane height), 3 pins racked on the tabletop rear edge,
 *  a ball at the near edge launched across the top (press-menu launch:ball / resetWorld), and a
 *  2-field HUD panel. The old floating lane over passthrough was Full-Space geometry; the table IS
 *  the lane now. Table + settle-on-tabletop physics are capture-proven (the mrtable MR-lane proof
 *  run — human-LOOKed forward capture); the
 *  pins-on-tabletop rack composes that with knockdown's proven rack offsets (+0.21 above surface)
 *  and awaits its own fleet capture. */
function gameScaffold(brief: string, appName: string, packageName: string): AppSpec {
  // tabletop surface: table center y 0.8 + half-height 0.4 = 1.2
  const pin = (id: string, x: number) => ({
    id,
    sceneId: "table",
    source: "primitive" as const,
    transform: { position: [x, 1.41, -1.85] },
    body: { mode: "dynamic" as const, shape: "capsule" as const, dims: [0.3, 0.06], mass: 0.35, color: [0.95, 0.95, 0.92] },
  });
  return appSpecSchema.parse({
    meta: { appName, packageName, stageStyle: "1", brief },
    scenes: [
      {
        id: "table",
        environment: { kind: "procedural" },
        lighting: { rig: "sun" },
        colliders: { props: [] },
        physics: { gravity: [0, -9.81, 0] },
      },
    ],
    layouts: [],
    objects: [
      {
        id: "tableTop",
        sceneId: "table",
        source: "primitive",
        transform: { position: [0, 0.8, -1.6] },
        body: { mode: "static", shape: "box", dims: [1.2, 0.8, 0.7], color: [0.55, 0.4, 0.22] },
      },
      {
        id: "ball",
        sceneId: "table",
        source: "primitive",
        transform: { position: [0, 1.3, -1.35] },
        body: { mode: "dynamic", shape: "sphere", dims: [0.08], mass: 0.5, color: [0.1, 0.08, 0.2] },
      },
      pin("pin0", -0.16),
      pin("pin1", 0),
      pin("pin2", 0.16),
    ],
    data: [],
    interactions: [
      { id: "btnLaunch", trigger: "press", target: "ball", action: "launch:ball", driveChannel: "broadcast", params: { velocity: [0, 0, -3], angular: [-8, 0, 0], button: "start" } },
      { id: "btnReset", trigger: "press", target: "ball", action: "resetWorld", driveChannel: "broadcast", params: { button: "reset" } },
    ],
    panels: [
      {
        id: "hud",
        title: "GAME",
        kind: "hud",
        fields: [
          { key: "throws", label: "THROWS", initial: "0" },
          { key: "status", label: "STATUS", initial: "READY" },
        ],
      },
    ],
    navigation: { startScene: "table", portals: [] },
    verificationPlan: [
      {
        claim: "a primitive table stands in the room with the ball and 3 pins racked on the tabletop",
        method: "capture",
        capabilityClass: "C0_emulator",
        targetRef: "table",
        forwardFOVpose: { yawDeg: 0, pitchDeg: 0, targetZ: -1.6 },
      },
    ],
    headsetLayer: [],
  });
}

/** datapanel: a HUD panel with 3 live fields + a data node + one modest display object, modeled on
 *  briefs/console.json. */
function datapanelScaffold(brief: string, appName: string, packageName: string): AppSpec {
  return appSpecSchema.parse({
    // v32 MR default: Mixed ("1") — the metric quad already sits at eye level in front of the user
    // ([0, 1.4, -2]), so the real room is the backdrop; the HUD panel docks as before.
    meta: { appName, packageName, stageStyle: "1", brief },
    scenes: [
      {
        id: "wall",
        environment: { kind: "procedural" },
        lighting: { rig: "sun" },
        colliders: { props: [] },
      },
    ],
    layouts: [],
    objects: [{ id: "metric", sceneId: "wall", source: "quad", dataBindRef: "feed", transform: { position: [0, 1.4, -2] } }],
    data: [{ id: "feed", source: "json", asset: "data/items.json", bindsTo: ["metric"] }],
    interactions: [],
    panels: [
      {
        id: "sys",
        title: "SYSTEM",
        kind: "hud",
        fields: [
          { key: "uptime", label: "UPTIME", initial: "0m" },
          { key: "state", label: "STATE", initial: "NOMINAL" },
          { key: "load", label: "LOAD", initial: "0%" },
        ],
      },
    ],
    navigation: { startScene: "wall", portals: [] },
    verificationPlan: [
      {
        claim: "the SYSTEM panel shows UPTIME/STATE/LOAD",
        method: "capture",
        capabilityClass: "C0_emulator",
        targetRef: "sys",
        forwardFOVpose: { yawDeg: 0, pitchDeg: 0, targetZ: -2.5 },
      },
    ],
    headsetLayer: [],
  });
}

/** Named in every scaffold response so authors see the stage decision AND the Full-Space opt-in.
 *  The Guardian-boundary caveat is PARTNER-STATED (PICO, fix in progress) — not measured by us. */
export const SCAFFOLD_STAGE_NOTE =
  "All scaffolds default to stageStyle '1' (Mixed — the MR default: content renders in the user's real room). Fully-virtual briefs opt in with meta.stageStyle '3' (Full — first-class and fully supported; carries a partner-stated Guardian-boundary issue on hardware, per PICO, fix in progress).";

/** Build the scaffold whose shape matches the brief's closest proven pattern; "generic" keeps the
 *  original exampleSpec (unchanged fallback). */
export function archetypeScaffold(brief: string, archetype: Archetype, appName = "ShowcaseXR", packageName = "com.example.showcasexr"): AppSpec {
  switch (archetype) {
    case "display":
      return displayScaffold(brief, appName, packageName);
    case "game":
      return gameScaffold(brief, appName, packageName);
    case "datapanel":
      return datapanelScaffold(brief, appName, packageName);
    default:
      return exampleSpec(brief, appName, packageName);
  }
}

// ── v31.3: schema hints on validation failure ──────────────────────────────────────────────────────────
// The Haiku experiment proved actionable errors self-resolve — but a bare "path: message" line still
// made the author re-derive the shape from the schema source. Each zod issue now carries the expected
// shape AND a known-good fragment lifted from the brief's own archetype scaffold at the same path, so
// the fix is copy-adapt instead of re-derive.
function expectedShapeOf(issue: z.ZodIssue): string {
  const i = issue as any;
  switch (issue.code) {
    case "invalid_type": return `expected ${i.expected}, received ${i.received}`;
    case "invalid_enum_value": return `one of ${(i.options ?? []).map((o: unknown) => JSON.stringify(o)).join(" | ")}`;
    case "unrecognized_keys": return `unknown key(s) ${(i.keys ?? []).join(", ")} — remove them`;
    case "invalid_union": return "none of the allowed variants matched — compare against the example fragment";
    case "invalid_string": return `a string matching the '${typeof i.validation === "string" ? i.validation : JSON.stringify(i.validation)}' rule`;
    default: return issue.message;
  }
}

/** The known-good value at (or at the nearest resolvable ancestor of) an issue path in the scaffold.
 *  Draft array indices beyond the scaffold's length clamp to the last scaffold sibling — any sibling
 *  demonstrates the same shape. */
export function scaffoldExampleAt(scaffold: unknown, issuePath: (string | number)[]): { path: string; fragment: unknown } {
  let node: any = scaffold;
  const walked: (string | number)[] = [];
  for (const seg of issuePath) {
    const key = typeof seg === "number" && Array.isArray(node) ? Math.min(seg, Math.max(node.length - 1, 0)) : seg;
    if (node !== null && typeof node === "object" && key in node) { node = node[key]; walked.push(seg); }
    else break;
  }
  return { path: walked.join(".") || "(root)", fragment: node };
}

export function schemaHints(issues: z.ZodIssue[], brief: string) {
  const good = archetypeScaffold(brief, pickArchetype(brief));
  return issues.map((issue) => {
    const at = issue.path.join(".") || "(root)";
    const ex = scaffoldExampleAt(good, issue.path);
    const json = JSON.stringify(ex.fragment);
    return {
      path: at,
      problem: issue.message,
      expected: expectedShapeOf(issue),
      example: json !== undefined && json.length <= 600
        ? ex.fragment
        : `the known-good '${ex.path}' fragment is large — call plan_app_spec with {brief} only for the full scaffold shape`,
      ...(ex.path !== at ? { exampleFrom: ex.path } : {}),
    };
  });
}

export function registerPlannerTools(server: McpServer) {
  server.registerTool(
    "plan_app_spec",
    {
      description:
        "Validate + feasibility-lint a draft AppSpec (the brief-to-app plan). You (the agent) author the AppSpec from the brief against list_capabilities; this tool zod-validates it, checks referential integrity (every scene/layout/object/data/interaction reference resolves), STAMPS each interaction & scene with its C1–C4 capability class, REQUIRES a forward-FOV camera pose for every C0/C2 visual capture claim (C2 honesty), verifies every node maps to a real tool, flags budget overflow, and returns the normalized spec + rationale + an honest emulator-vs-Swan preview. Side-effect-free: inspect/edit before compile_app_spec. Omit draftSpec to get a well-formed scaffold spec to fill in.",
      inputSchema: {
        brief: z.string().describe("The natural-language product brief."),
        draftSpec: z.any().optional().describe("Your candidate AppSpec (see appSpec shape). Omit to receive a scaffold to fill in."),
        budget: z
          .object({ iterations: z.number().int().optional(), timeMin: z.number().optional(), toolCalls: z.number().int().optional() })
          .optional()
          .describe("Optional soft budget."),
      },
    },
    async ({ brief, draftSpec, budget }) => {
      if (draftSpec === undefined) {
        const { archetype, matched } = matchArchetype(brief);
        return okJson({
          status: "scaffold",
          message: `No draftSpec supplied — brief steered toward the '${archetype}' archetype (closest proven pattern to the brief); here is a well-formed scaffold AppSpec to adapt. Author against list_capabilities, then call plan_app_spec again with draftSpec.`,
          archetype,
          archetypeWhy: matched.length
            ? `matched keyword(s): ${matched.join(", ")}. A wrong steer is cheap to override — adapt any part of the scaffold, or restate the brief without the keyword.`
            : "no archetype keywords matched — generic scaffold (the safe fallback).",
          stage: SCAFFOLD_STAGE_NOTE,
          scaffold: archetypeScaffold(brief, archetype),
        });
      }
      const parsed = appSpecSchema.safeParse(draftSpec);
      if (!parsed.success) {
        return okJson({
          status: "invalid",
          message: "draftSpec failed schema validation — each issue names the failing path, the expected shape, and a known-good example fragment from this brief's scaffold. Fix and retry.",
          issues: schemaHints(parsed.error.issues, brief),
        });
      }
      const spec = parsed.data;
      if (budget) spec.meta.budget = { ...spec.meta.budget, ...budget };
      // v6.1: an under-declared class surfaces as a lint ERROR (see lintSpec) so the author must fix it;
      // we do NOT silently rewrite it. verify_app_spec independently reconciles (effectiveNodeClass) as a
      // structural backstop, so a mislabeled spec can never over-claim even if it skips plan.
      const lint = lintSpec(spec);

      // budget overflow (rough: each scene/layout/object/data/interaction/verify node ≈ one authoring step)
      const nodeCount = spec.scenes.length + spec.layouts.length + spec.objects.length + spec.data.length + spec.interactions.length;
      if (spec.meta.budget?.toolCalls && nodeCount > spec.meta.budget.toolCalls)
        lint.warnings.push(`plan has ~${nodeCount} authoring nodes but budget.toolCalls is ${spec.meta.budget.toolCalls} — likely to overflow`);

      const preview = emulatorVsSwanPreview(spec);
      return okJson({
        status: lint.errors.length ? "needs_fix" : "ok",
        spec,
        lint,
        emulatorVsSwanPreview: preview,
        rationale: [
          `Plan for "${spec.meta.appName}" (${spec.meta.packageName}): ${spec.scenes.length} scene(s), ${spec.layouts.length} layout(s), ${spec.objects.length} object(s), ${spec.data.length} data node(s), ${spec.interactions.length} interaction(s).`,
          `${preview.verifiableNow.length} node(s) emulator-verifiable now; ${preview.builtForSwan.length} built-for-Swan.`,
          lint.errors.length ? `${lint.errors.length} error(s) MUST be fixed before compile_app_spec.` : `No blocking errors — ready for compile_app_spec.`,
        ].join(" "),
      });
    },
  );

  server.registerTool(
    "replan_spec",
    {
      description:
        "Mutate an AppSpec in response to a verification failure and name the subtree to recompile. Pass the current spec + the failed claims (each with a symptom drawn from the diagnose vocabulary, e.g. 'slot_in_bed', 'texture_black', 'dim'/'unlit', 'no_hit'/'C3'/'dead_buttons'). Applies the retained-lesson fix (move a layout out of the bed, mark an env asset for baking, ensure a lighting rig, downgrade a controller/gaze interaction to a broadcast drive so it's emulator-verifiable) and returns the patched spec + the list of node ids to re-compile. Re-run plan_app_spec on the result to re-lint.",
      inputSchema: {
        spec: z.any().describe("The current AppSpec."),
        failures: z
          .array(z.object({ targetRef: z.string().optional(), claim: z.string().optional(), symptom: z.string().describe("diagnose-style symptom keyword") }))
          .describe("The failed verification nodes and their symptoms."),
      },
    },
    async ({ spec: raw, failures }) => {
      const parsed = appSpecSchema.safeParse(raw);
      if (!parsed.success) return okJson({ status: "invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      const spec = parsed.data;
      const recompile = new Set<string>();
      const changes: string[] = [];

      for (const f of failures) {
        const sym = f.symptom.toLowerCase();
        // placement: slot in the bed / bad position → push the layout further out & up
        if (sym.includes("bed") || sym.includes("slot") || sym.includes("sunk")) {
          for (const l of spec.layouts) {
            if (f.targetRef && l.id !== f.targetRef) continue;
            l.params = { ...(l.params ?? {}), centerZ: -3.0, centerY: 1.5 };
            recompile.add(l.id);
            changes.push(`layout '${l.id}': moved out of the bed (centerZ=-3.0, centerY=1.5)`);
          }
        }
        // dim/unlit clusters → ensure a lighting rig on the scene
        if (sym.includes("dim") || sym.includes("unlit") || sym.includes("dark")) {
          for (const s of spec.scenes) {
            if (s.lighting.rig === "none") { s.lighting.rig = "fullRig"; recompile.add(s.id); changes.push(`scene '${s.id}': lighting rig none→fullRig`); }
          }
        }
        // raw-GLB black → the env asset must be baked
        if (sym.includes("black") || sym.includes("texture")) {
          for (const s of spec.scenes) {
            if (s.environment.kind === "texturedMesh") {
              s.environment.baseColorImage = s.environment.baseColorImage ?? "REQUIRES_BAKE.png";
              recompile.add(s.id);
              changes.push(`scene '${s.id}': env must use a BAKED bundle (bake_textured_model), never a raw GLB`);
            }
          }
        }
        // C3 / no controller / dead buttons → downgrade to a broadcast-driven interaction (emulator-verifiable)
        if (sym.includes("c3") || sym.includes("controller") || sym.includes("no_hit") || sym.includes("dead")) {
          for (const it of spec.interactions) {
            if (f.targetRef && it.id !== f.targetRef && it.target !== f.targetRef) continue;
            if (it.driveChannel !== "broadcast") { it.driveChannel = "broadcast"; recompile.add(it.id); changes.push(`interaction '${it.id}': drive controller→broadcast (emulator-verifiable; keep the controller path in headsetLayer)`); }
          }
        }
        // nothing rendered → ensure a lighting rig + flag the main-thread/camera checks (v5.2 critique symptom)
        if (sym.includes("not_render") || sym.includes("empty") || sym.includes("blank")) {
          for (const s of spec.scenes) {
            if (s.lighting.rig === "none") { s.lighting.rig = "sun"; recompile.add(s.id); changes.push(`scene '${s.id}': lighting rig none→sun`); }
          }
          changes.push("not_rendering: confirm entities are added on the MAIN thread (broadcast handlers arrive off-main) and lie in the forward FOV before re-capture");
        }
        // occlusion / crowding → widen the layout spacing
        if (sym.includes("placement") || sym.includes("occlud") || sym.includes("overlap") || sym.includes("crowd")) {
          for (const l of spec.layouts) {
            if (f.targetRef && l.id !== f.targetRef) continue;
            const cur = Number((l.params ?? {}).spacing ?? 0.6);
            l.params = { ...(l.params ?? {}), spacing: Math.round((cur + 0.2) * 100) / 100 };
            recompile.add(l.id);
            changes.push(`layout '${l.id}': spacing ${cur}→${(l.params as any).spacing} to reduce occlusion`);
          }
        }
        // wrong forward view / off-screen → snap the verification node's camera pose forward (C2)
        if (sym.includes("camera") || sym.includes("offscreen") || sym.includes("off_screen") || sym.includes("away")) {
          for (const v of spec.verificationPlan) {
            if (f.claim && v.claim !== f.claim) continue;
            if (v.method === "capture") { v.forwardFOVpose = { yawDeg: 0, pitchDeg: 0, targetZ: -2.0 }; changes.push(`verification '${v.claim}': camera pose snapped to forward (yaw0/pitch0/z-2.0)`); }
          }
        }
        // data-bound color mismatch → can't auto-fix a JSON, flag it
        if (sym.includes("color") || sym.includes("mismatch")) {
          changes.push(`color mismatch${f.targetRef ? ` on '${f.targetRef}'` : ""}: verify the JSON color entry + the RGB(0..1) order in the data node — manual check`);
        }
      }

      if (!changes.length) changes.push("no automatic mutation matched the symptoms — needs manual triage (see diagnose).");
      return okJson({ status: changes.length ? "patched" : "unchanged", spec, changes, recompileSubtree: Array.from(recompile) });
    },
  );
}
