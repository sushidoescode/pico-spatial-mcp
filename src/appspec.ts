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
// C1               — REAL-world scene-understanding/hand-tracking → hardware; the emulator DOES return simulated planes with FLOOR/TABLE/etc. semantics after polling (2026-07-29).
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
  stageStyle: z.enum(["1", "2", "3"]).default("1").describe("PICO stage style: 1=Mixed (DEFAULT — the MR product: virtual content renders over the user's real room), 2=Progressive, 3=Full (fully-virtual, first-class explicit opt-in; note a partner-stated Guardian-boundary issue on hardware for Full-Space immersion — per PICO, known, fix in progress — not measured by us)."),
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
  seatOn: z
    .object({
      semantic: z.enum(["FLOOR", "TABLE", "WALL", "CEILING"]).describe("Target plane label, matched against the LIVE detected planes at runtime (the generated seat() polls, then falls back to the largest same-orientation plane)."),
      asset: z.string().optional().describe("Source GLB/GLTF path on the host — the compiler lowers it through measure_model -> bake_textured_model. Omitted = a loud '<model.glb>' placeholder in the ledger."),
      offset: vec3.optional().describe("Extra world-axis offset in metres. NOT yet consumed by generate_surface_placement_kotlin — the compiler records it in the ledger-step note for the executing agent to apply after seating."),
    })
    .strict()
    .optional()
    .describe("v31 RUNTIME surface seating — the v30.2 recipe: lowers to measure_model -> bake_textured_model -> generate_surface_placement_kotlin, whose seat() polls LIVE DETECTED planes at runtime (planes ARE detected on the emulator — 43 measured 2026-07-29) and seats the baked model on the matching surface. Distinct from anchorTo, which resolves against a SCANNED world (meta.semanticScenePath) at compile time. Mutually exclusive with anchorTo and with body (the physics wiring places bodies at a compile-time transform.position, but a seatOn position exists only at runtime — the placement generator emits its own primitive collider). Requires source 'model' and an open Stage (any stage style — NOT a WindowContainer); Mixed ('1'), the default, shows the real room behind the seated model."),
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
  params: z.record(z.any()).optional().describe("Action params, e.g. { velocity: [0,0,-8], angular: [-8,0,0] } for 'launch:<id>'. For trigger 'press': { button: 'start'|'pause'|'resume'|'reset'|<custom>, label: 'DROP BALL' } names + labels the GameMenu row — a custom label lowers a bake_menu_panel step so the panel texture actually renders it (max 4 distinct buttons: the panel is a 4-row texture)."),
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
  placement: z
    .object({
      kind: z.enum(["dock", "world"]).default("dock").describe("dock = the OS dock spawn (the proven path). 'world' = a REQUEST for a world-anchored panel — no public world-position API for auto-hosted 2D panels is vault-confirmed, so it currently compiles to the dock path with a loud fallback note."),
      position: vec3.optional().describe("Desired world position [x,y,z] for kind='world'. Recorded in the ledger note only — not consumable until a world-position API is confirmed."),
    })
    .strict()
    .optional()
    .describe("Where the panel should live (default dock). CORRECTED v35.2: 'world' still compiles to the dock path, because this AppSpec node lowers to an auto-hosted 2D Activity and no public API world-poses one of those — that limit is real. What was WRONG was the implication that in-scene 2D is impossible. It is not: generate_attachment_panel_kotlin places Compose INSIDE the 3D scene (AttachmentPanel + TransformComponent, metres — public in 0.13.3, used by six of eight PICO samples). The ledger note for 'world' now names that route. Even so, scene placement is not world-LOCKING: an anchor fixed to the real room still needs AnchorComponent, which stays honestly deferred."),
});

/** Asset paths are embedded in generated Kotlin and also used as APK-relative filesystem paths.
 * Keep the accepted alphabet deliberately boring: no interpolation/quote escapes, traversal, empty
 * segments, platform separators, or spelling that provisioning would normalize differently. */
export function isSafeIblAssetPath(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || !/^[A-Za-z0-9._/-]+\.ktx$/i.test(value)) return false;
  if (value.startsWith("/") || value.includes("//")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
export const iblKtxAssetPathSchema = z.string().refine(isSafeIblAssetPath, {
  message: "must be a safe APK-relative .ktx path using only letters, digits, '.', '_', '-', and '/'",
});

const appSpecObjectSchema = z.object({
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

/** SceneIBL.kt and SplatEnvironment.kt are app-level generated singletons. Multiple scenes may
 * share an identical configuration, but contradictory values would make the compiler overwrite
 * the same file and silently render earlier scenes with the later scene's settings. Reject those
 * shapes at the IR boundary instead of emitting a plausible but wrong app. */
export const appSpecSchema = appSpecObjectSchema.superRefine((spec, ctx) => {
  const iblScenes = spec.scenes.filter((scene) => scene.lighting.rig === "ibl");
  for (const scene of iblScenes) {
    const params = scene.lighting.params ?? {};
    if (!isSafeIblAssetPath(params.ktxAssetPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenes"],
        message: `IBL scene '${scene.id}' needs a safe APK-relative .ktx ktxAssetPath using only letters, digits, '.', '_', '-', and '/'`,
      });
    }
    if (params.mode !== undefined && !["stage", "local", "both"].includes(params.mode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenes"],
        message: `IBL scene '${scene.id}' mode must be 'stage', 'local', or 'both' when provided`,
      });
    }
    // v32 MR default: StageEnvironmentLighting is inactive in a MIXED stage (capabilities), so a
    // stage-mode IBL rig under stageStyle "1" would silently light nothing — fail closed instead.
    if (spec.meta.stageStyle === "1" && (params.mode ?? "stage") === "stage") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenes"],
        message: `IBL scene '${scene.id}' uses mode 'stage'${params.mode === undefined ? " (the implicit default)" : ""} under stageStyle '1' (Mixed) — StageEnvironmentLighting is inactive in a Mixed stage, so this rig would silently do nothing; set lighting.params.mode to 'local' ('stage' remains valid for stageStyle '3')`,
      });
    }
    if (
      params.intensityExponent !== undefined &&
      (typeof params.intensityExponent !== "number" || !Number.isFinite(params.intensityExponent) || params.intensityExponent < -24 || params.intensityExponent > 24)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenes"],
        message: `IBL scene '${scene.id}' intensityExponent must be a finite number in [-24, 24] when provided`,
      });
    }
  }
  const layoutSceneIds = new Set<string>();
  for (const layout of spec.layouts) {
    if (layoutSceneIds.has(layout.sceneId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layouts"],
        message: `the current wiring compiler supports one layout per scene; scene '${layout.sceneId}' declares multiple layouts`,
      });
    }
    layoutSceneIds.add(layout.sceneId);
  }

  // v31 seatOn exclusivity: one placement authority per object, and the pipeline needs a bakeable model.
  for (const o of spec.objects) {
    if (!o.seatOn) continue;
    if (o.anchorTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objects"],
        message: `object '${o.id}': seatOn (LIVE detected planes at runtime) and anchorTo (scanned-world resolution at compile time) are mutually exclusive — pick one placement authority`,
      });
    }
    if (o.body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objects"],
        message: `object '${o.id}': seatOn and body are mutually exclusive — the physics wiring places bodies at a compile-time transform.position, but a seatOn position exists only at runtime (the placement generator emits its own primitive collider)`,
      });
    }
    if (o.source !== "model") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objects"],
        message: `object '${o.id}': seatOn seats a BAKED model (measure_model -> bake_textured_model) — source must be 'model'`,
      });
    }
  }

  // v31: the verified in-world menu panel is a 4-row texture (bake_menu_panel keeps the same rows),
  // so more than 4 distinct press-interaction buttons can never render.
  const menuButtons = new Set<string>();
  for (const i of spec.interactions) {
    if (i.trigger !== "press") continue;
    const a = String(i.action);
    const p: any = i.params ?? {};
    menuButtons.add(String(p.button ?? (a.startsWith("launch:") ? "start" : a === "resetWorld" ? "reset" : "start")));
  }
  if (menuButtons.size > 4) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["interactions"],
      message: `press interactions declare ${menuButtons.size} distinct menu buttons; the in-world menu panel is a 4-row texture — 4 max`,
    });
  }

  const splatScenes = spec.scenes.filter((scene) => scene.environment.kind === "splat");
  if (splatScenes.length >= 2) {
    const canonicalize = (value: any): any => Array.isArray(value)
      ? value.map(canonicalize)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
        : value;
    const signature = (scene: (typeof splatScenes)[number]) => {
      const params = Object.fromEntries(
        Object.entries(scene.environment.params ?? {}).filter(
          ([key]) => !["packageName", "kind", "assetFileName", "delivery"].includes(key),
        ),
      );
      return JSON.stringify(canonicalize({ asset: scene.environment.asset ?? null, params }));
    };
    const expected = signature(splatScenes[0]);
    for (const scene of splatScenes.slice(1)) {
      if (signature(scene) === expected) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenes"],
        message: `all splat scenes must share one asset/params configuration because the current compiler emits one SplatEnvironment.kt; scene '${scene.id}' conflicts with '${splatScenes[0].id}'`,
      });
    }
  }

  if (iblScenes.length < 2) return;
  const signature = (scene: (typeof iblScenes)[number]) => {
    const params = scene.lighting.params ?? {};
    return JSON.stringify({
      ktxAssetPath: params.ktxAssetPath ?? null,
      mode: params.mode ?? "stage",
      intensityExponent: params.intensityExponent ?? 0,
    });
  };
  const expected = signature(iblScenes[0]);
  for (const scene of iblScenes.slice(1)) {
    if (signature(scene) === expected) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scenes"],
      message: `all IBL scenes must share one ktxAssetPath/mode/intensityExponent configuration; scene '${scene.id}' conflicts with '${iblScenes[0].id}'`,
    });
  }
});
export type AppSpec = z.infer<typeof appSpecSchema>;

/** A tiny well-formed example spec (used by plan_app_spec as a scaffold when no draft is supplied). */
export function exampleSpec(brief: string, appName = "ShowcaseXR", packageName = "com.example.showcasexr"): AppSpec {
  return appSpecSchema.parse({
    meta: { appName, packageName, stageStyle: "1", brief },
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
