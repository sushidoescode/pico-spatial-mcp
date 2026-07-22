import { z } from "zod";

/**
 * appspec.ts — v5.0 KEYSTONE: the typed AppSpec IR.
 *
 * One abstraction that is simultaneously the BUILD PLAN (what the compiler drives node-by-node) and the
 * VERIFICATION CONTRACT (what the plan-level gate scores the assembled app against). Every node that makes
 * a checkable claim carries its own acceptance predicate PLUS its C1–C4 capability class PLUS (for visual
 * claims) a required forward-FOV camera pose — so over-claims are structurally impossible: the plan already
 * knows, at plan time, what it can prove on the emulator now vs. what is only built-for-Swan.
 *
 * This module is PURE (zod only) — no MCP, no I/O — so planner/compiler/verify all import the same types.
 */

// ── Capability classes (the honesty engine) ──────────────────────────────────────────────────────────
// C0_emulator      — fully verifiable on the emulator now (renders in a forward capture / broadcast-drivable).
// C1               — needs native scene-understanding/hand-tracking (0 planes on emulator) → Swan-only.
// C2               — camera-decoupled; verifiable ONLY with a forward-FOV pose (content outside it can't be seen).
// C3               — needs a controller/gaze pointer (none on emulator) → broadcast-emulate now / Swan for real.
// C4_headset_only  — stage-vs-window dichotomy (in-front Compose panels etc.) → Swan-only.
export const capabilityClassSchema = z.enum([
  "C0_emulator",
  "C1",
  "C2",
  "C3",
  "C4_headset_only",
]);
export type CapabilityClass = z.infer<typeof capabilityClassSchema>;

// A canonical forward-FOV pose the free cam must be aimed at before a visual capture (honors C2). Degrees.
export const cameraPoseSchema = z.object({
  yawDeg: z.number().default(0).describe("Free-cam yaw (deg) via emulator_look; content lives near -Z forward."),
  pitchDeg: z.number().default(0).describe("Free-cam pitch (deg)."),
  targetZ: z.number().default(-2.5).describe("Approx forward distance (m) of the content being verified."),
  note: z.string().optional().describe("Human note, e.g. 'aim at the shelf row'."),
});
export type CameraPose = z.infer<typeof cameraPoseSchema>;

const vec3 = z.array(z.number()).length(3);
export const captureFrustumSchema = z.object({
  f: z.number().positive().describe("Calibrated focal length in pixels."),
  cx: z.number().describe("Calibrated principal point X in pixels."),
  cy: z.number().describe("Calibrated principal point Y in pixels."),
  width: z.number().int().positive().describe("Capture width in pixels."),
  height: z.number().int().positive().describe("Capture height in pixels."),
  minVisibleFraction: z.number().min(0).max(1).optional().describe("Minimum clipped/full projected child-box area (default 0.5)."),
}).strict();

// ── meta ──────────────────────────────────────────────────────────────────────────────────────────────
export const metaSchema = z.object({
  appName: z.string().describe("Human app name."),
  packageName: z.string().describe("Android applicationId, e.g. com.example.showcase."),
  stageStyle: z.enum(["1", "2", "3"]).default("3").describe("PICO stage style: 3=Full, 2=Mixed, 1=Window."),
  brief: z.string().describe("The original natural-language brief this spec realizes."),
  semanticScenePath: z.string().optional().describe("v17.0: path to a compose_semantic_scene JSON for the scanned world this app lives in — enables object anchorTo:{label} placement against REAL labeled surfaces."),
  occupancyPath: z.string().optional().describe("v26.1: path to a build_occupancy_grid JSON for the scanned world — anchorTo relation:'on' placements then also avoid UNLABELED scanned geometry (zod strips unknown keys, so this MUST be declared here to reach resolveAnchors)."),
  budget: z
    .object({
      iterations: z.number().int().optional().describe("Max replan/repair iterations."),
      timeMin: z.number().optional().describe("Soft wall-clock budget in minutes."),
      toolCalls: z.number().int().optional().describe("Soft cap on tool calls."),
    })
    .optional(),
});

// ── scenes ──────────────────────────────────────────────────────────────────────────────────────────────
export const sceneSchema = z.object({
  id: z.string(),
  environment: z.object({
    kind: z.enum(["texturedMesh", "splat", "pano", "procedural", "homeEnvProxy"]),
    asset: z.string().optional().describe("Model/splat/pano file name (baked bundle for texturedMesh)."),
    baseColorImage: z.string().optional(),
    params: z.record(z.any()).optional().describe("v19: passed through to generate_environment_kotlin — translate/rotationEuler/scale seat a scanned world around the fixed emulator eye (e.g. translate.y = -floorY so the world floor sits at app y=0; rotationEuler.y=180 to face the hero wall). Apply the SAME transform to the semantic scene JSON so anchorTo coordinates stay truthful."),
  }),
  lighting: z
    .object({
      rig: z.enum(["sun", "fullRig", "ibl", "none"]).default("sun"),
      params: z.record(z.any()).optional(),
    })
    .default({ rig: "sun" }),
  colliders: z
    .object({
      room: z
        .object({ halfW: z.number(), height: z.number(), halfD: z.number(), centerZ: z.number().default(0) })
        .optional(),
      props: z.array(z.record(z.any())).default([]),
    })
    .default({ props: [] }),
  transitions: z.array(z.object({ to: z.string(), trigger: z.string() })).default([]),
  physics: z
    .object({ gravity: vec3.optional().describe("m/s² (default [0,-9.81,0])") })
    .optional()
    .describe("Presence = a REAL physics world on the scene root (verified simulating on the emulator, v8.8). Objects with a `body` fall/roll/collide."),
});

// ── layouts ────────────────────────────────────────────────────────────────────────────────────────────
export const layoutSchema = z.object({
  id: z.string(),
  sceneId: z.string(),
  pattern: z.enum(["wall", "grid", "arc", "shelf"]),
  count: z.number().int(),
  surface: z.string().optional().describe("Optional proxy/surface ref the layout sits on (home-env proxy id)."),
  params: z.record(z.any()).optional().describe("radius/spacing/columns/shelves/centerY/centerZ/etc."),
});

// ── objects ────────────────────────────────────────────────────────────────────────────────────────────
export const objectSchema = z.object({
  id: z.string(),
  sceneId: z.string(),
  source: z.enum(["model", "quad", "primitive"]),
  material: z.record(z.any()).optional(),
  layoutRef: z.string().optional().describe("A layout id (positions this object)."),
  transform: z.object({ position: vec3.optional(), rotationDeg: vec3.optional(), scale: vec3.optional() }).optional(),
  anchorTo: z
    .object({
      label: z.string().describe("A labeled object in the scanned world's semantic scene, e.g. 'counter', 'neon menu wall' — or 'floor' with relation 'on'."),
      relation: z.enum(["on-top-of", "next-to", "in-front-of", "on"]).optional().describe("Spatial relation (default on-top-of). 'on' = v24 affordance route: a COLLISION-FREE spot on the labeled surface (or 'floor') via the free-space solver, honoring clearance/facing/avoiding."),
      offset: vec3.optional().describe("Extra world-axis offset in meters, applied after resolution."),
      gap: z.number().optional().describe("Clearance for next-to / in-front-of (default 0.15m)."),
      clearance: z.number().optional().describe("v24 ('on' only): min gap to obstacles + surface edges (default 0.05m)."),
      facing: z.string().optional().describe("v24 ('on' only): face this label or 'room-center' — bakes transform.rotationDeg.y."),
      avoiding: z.array(z.string()).optional().describe("v24 ('on' only): labels to keep distance from (soft)."),
      visibleFrom: vec3.optional().describe("v27.3 ('on' only): a viewpoint in the app frame (e.g. the spawn camera [0,1.2,0]) — requires meta.occupancyPath. Candidates whose line of sight to visibleFrom is occluded by scanned geometry are hard-rejected, not just non-intersecting ones."),
      captureFrustum: captureFrustumSchema.optional().describe("v27.7 ('on' only): calibrated deterministic-forward intrinsics. Requires visibleFrom; candidates whose projected child AABB is insufficiently inside the capture are hard-rejected."),
    })
    .strict()
    .superRefine((anchor, ctx) => {
      if (anchor.captureFrustum && !anchor.visibleFrom) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["captureFrustum"],
          message: "anchorTo.captureFrustum requires anchorTo.visibleFrom as the camera center",
        });
      }
      if (anchor.captureFrustum && anchor.relation !== "on") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["relation"],
          message: "anchorTo.captureFrustum requires explicit relation 'on' so the affordance solver enforces it",
        });
      }
    })
    .optional()
    .describe("v17.0 SEMANTIC PLACEMENT: anchor this object to a LABELED real-world surface from meta.semanticScenePath (semantic_splat_scan -> compose_semantic_scene output). The compiler resolves it to a concrete transform.position at ledger-build time; an explicit transform.position wins over anchorTo."),
  body: z
    .object({
      mode: z.enum(["static", "dynamic"]),
      shape: z.enum(["box", "sphere", "capsule"]),
      dims: z.array(z.number()).describe("box=[x,y,z] full extents; sphere=[radius]; capsule=[height,radius]"),
      mass: z.number().optional().describe("kg (dynamic only, default 1)"),
      color: vec3.optional().describe("[r,g,b] 0..1 tint (bodies render as PBR by default)"),
    })
    .optional()
    .describe("A rigid body in the scene's physics world (requires scene.physics). Placed at transform.position. Launch it with an interaction action 'launch:<objectId>'."),
  dataBindRef: z.string().optional().describe("A data node id whose items produce these objects."),
  anim: z.record(z.any()).optional(),
});

// ── data ───────────────────────────────────────────────────────────────────────────────────────────────
export const dataSchema = z.object({
  id: z.string(),
  source: z.enum(["json", "gated_api"]),
  asset: z.string().optional().describe("Bundled JSON asset path, e.g. data/items.json (for source=json)."),
  endpoint: z.string().optional().describe("API endpoint (for source=gated_api — network-gated, flagged)."),
  schema: z.record(z.any()).optional().describe("Expected item field shape."),
  bindsTo: z.array(z.string()).default([]).describe("Object ids this data drives."),
});

// ── interactions ──────────────────────────────────────────────────────────────────────────────────────
export const interactionSchema = z.object({
  id: z.string(),
  trigger: z.enum(["broadcast", "gaze_dwell", "controller_ray", "grab", "press"]),
  target: z.string().describe("Object/layout/menu id this interaction acts on."),
  action: z.string().describe("What happens, e.g. 'showDetail' / 'select' / 'navigate:sceneB'."),
  stateMachine: z.record(z.any()).optional(),
  driveChannel: z.enum(["broadcast", "controller"]).default("broadcast"),
  params: z.record(z.any()).optional().describe("Action params, e.g. { velocity: [0,0,-8], angular: [-8,0,0] } for 'launch:<id>'."),
});

// ── navigation ────────────────────────────────────────────────────────────────────────────────────────
export const navigationSchema = z.object({
  startScene: z.string(),
  portals: z.array(z.object({ from: z.string(), to: z.string(), trigger: z.string() })).default([]),
});

// ── verificationPlan (the contract) ─────────────────────────────────────────────────────────────────────
export const verificationNodeSchema = z.object({
  claim: z.string().describe("The checkable claim, e.g. '6 shelf cards render in an arc'."),
  method: z.enum(["capture", "assert_scene", "dump_scene", "baseline"]),
  forwardFOVpose: cameraPoseSchema.optional().describe("REQUIRED for method=capture (C2): where emulator_look must aim."),
  capabilityClass: capabilityClassSchema,
  targetRef: z.string().optional().describe("Which spec node this verifies (scene/layout/object/interaction id)."),
  reproHash: z.string().optional().describe("Canonical pose + seed hash for reproducibility (v5.5)."),
});

// ── headsetLayer (built-for-Swan codegen pieces) ───────────────────────────────────────────────────────
export const headsetPieceSchema = z.object({
  feature: z.string().describe("e.g. 'controller-ray select', 'sense/plane pins', 'in-front Compose panel'."),
  capabilityClass: capabilityClassSchema,
  tool: z.string().optional().describe("The generate_* tool that emits the Swan code."),
});

// ── the whole spec ───────────────────────────────────────────────────────────────────────────────────
export const panelSchema = z.object({
  id: z.string(),
  title: z.string().describe("Panel heading, e.g. 'KNOCKDOWN'."),
  kind: z.enum(["hud", "scoreboard", "info", "web"]).default("hud").describe("web = a WebView panel: full HTML/CSS/JS with a LIVE DOM in the spatial viewport (vision-verified)."),
  url: z.string().optional().describe("kind='web': URL to load (INTERNET permission required)."),
  html: z.string().optional().describe("kind='web': inline HTML (deterministic, no network)."),
  fields: z
    .array(z.object({ key: z.string(), label: z.string(), initial: z.string() }))
    .default([])
    .describe("Live label:value rows. Keys 'throws'/'status' get automatic game hooks (bump on launch / READY-ROLLING)."),
});

export const appSpecSchema = z.object({
  meta: metaSchema,
  scenes: z.array(sceneSchema).min(1),
  layouts: z.array(layoutSchema).default([]),
  objects: z.array(objectSchema).default([]),
  data: z.array(dataSchema).default([]),
  interactions: z.array(interactionSchema).default([]),
  panels: z.array(panelSchema).default([]).describe("v9.4 hybrid tier: Compose WindowContainer panels with LIVE runtime text (2D windows composite as floating spatial panels — vision-verified). Spawn at the dock position, off the forward view."),
  navigation: navigationSchema,
  verificationPlan: z.array(verificationNodeSchema).default([]),
  headsetLayer: z.array(headsetPieceSchema).default([]),
});
export type AppSpec = z.infer<typeof appSpecSchema>;

/** A tiny well-formed example spec (used by plan_app_spec as a scaffold when no draft is supplied). */
export function exampleSpec(brief: string, appName = "ShowcaseXR", packageName = "com.example.showcasexr"): AppSpec {
  return appSpecSchema.parse({
    meta: { appName, packageName, stageStyle: "3", brief },
    scenes: [
      {
        id: "main",
        environment: { kind: "homeEnvProxy" },
        lighting: { rig: "sun" },
        colliders: { room: { halfW: 2.5, height: 2.5, halfD: 2.5, centerZ: -2 }, props: [] },
      },
    ],
    layouts: [{ id: "shelf1", sceneId: "main", pattern: "shelf", count: 6, params: { shelves: 2, spacing: 0.6 } }],
    objects: [{ id: "cards", sceneId: "main", source: "quad", layoutRef: "shelf1", dataBindRef: "catalog" }],
    data: [{ id: "catalog", source: "json", asset: "data/items.json", bindsTo: ["cards"] }],
    interactions: [
      { id: "gaze", trigger: "gaze_dwell", target: "cards", action: "showDetail", driveChannel: "broadcast" },
      { id: "ray", trigger: "controller_ray", target: "cards", action: "select", driveChannel: "controller" },
    ],
    navigation: { startScene: "main", portals: [] },
    verificationPlan: [
      {
        claim: "6 cards render in a shelf layout",
        method: "capture",
        capabilityClass: "C0_emulator",
        targetRef: "shelf1",
        forwardFOVpose: { yawDeg: 0, pitchDeg: 0, targetZ: -2.5 },
      },
      {
        claim: "select(item3) shows the matching detail card from JSON",
        method: "capture",
        capabilityClass: "C0_emulator",
        targetRef: "gaze",
        forwardFOVpose: { yawDeg: 0, pitchDeg: 0, targetZ: -2.0 },
      },
    ],
    headsetLayer: [{ feature: "controller-ray select", capabilityClass: "C3", tool: "generate_headset_readiness_codegen" }],
  });
}
