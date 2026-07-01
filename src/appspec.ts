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

// ── meta ──────────────────────────────────────────────────────────────────────────────────────────────
export const metaSchema = z.object({
  appName: z.string().describe("Human app name."),
  packageName: z.string().describe("Android applicationId, e.g. com.example.showcase."),
  stageStyle: z.enum(["1", "2", "3"]).default("3").describe("PICO stage style: 3=Full, 2=Mixed, 1=Window."),
  brief: z.string().describe("The original natural-language brief this spec realizes."),
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
export const appSpecSchema = z.object({
  meta: metaSchema,
  scenes: z.array(sceneSchema).min(1),
  layouts: z.array(layoutSchema).default([]),
  objects: z.array(objectSchema).default([]),
  data: z.array(dataSchema).default([]),
  interactions: z.array(interactionSchema).default([]),
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
