import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema } from "./appspec.js";

/**
 * templates.ts — v5.6 TEMPLATES: parameterized AppSpec skeletons for reuse.
 *
 * Each template is a pure function (params) -> a validated AppSpec draft — the common shapes the loop has
 * proven (gallery / inspection / dashboard / ambient / showcase). instantiate_template stamps a brief +
 * app/package + count/palette and returns an AppSpec ready for plan_app_spec -> compile_app_spec, plus a
 * sample data JSON for the data-bound ones. This is reuse over the v5.0 pipeline — not new rendering.
 */

type Params = { appName: string; packageName: string; brief: string; count?: number; palette?: number[][] };

const room = { halfW: 2.5, height: 2.5, halfD: 2.5, centerZ: -2 };
const fwd = (targetZ = -2.5) => ({ yawDeg: 0, pitchDeg: 0, targetZ });

const TEMPLATES: Record<string, { desc: string; build: (p: Params) => any; sampleData?: (p: Params) => any }> = {
  gallery: {
    desc: "A quiet gallery: N works floating in an arc in the user's room, softly lit. No data/interaction.",
    // v32 MR default: Mixed ("1") — the room IS the hall. The old texturedMesh env belonged to the
    // Full-Space presentation and would occlude passthrough, so the env is procedural now; opt back
    // into "3" + a texturedMesh env asset for a fully-virtual hall.
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "1", brief: p.brief },
      scenes: [{ id: "main", environment: { kind: "procedural" }, lighting: { rig: "sun" }, colliders: { props: [] } }],
      layouts: [{ id: "arc1", sceneId: "main", pattern: "arc", count: p.count ?? 3, params: { radius: 2.2 } }],
      objects: [{ id: "works", sceneId: "main", source: "quad", layoutRef: "arc1" }],
      navigation: { startScene: "main" },
      verificationPlan: [{ claim: `${p.count ?? 3} works in an arc`, method: "capture", capabilityClass: "C0_emulator", targetRef: "arc1", forwardFOVpose: fwd(-2.2) }],
    }),
  },
  inspection: {
    desc: "An inspection bay: N gaze-selectable hotspots on a grid over the home-env floor. Native anchoring = Swan.",
    // v32 MR default: Mixed ("1") — the template was already authored against the home environment
    // (homeEnvProxy colliders); in Mixed the hotspots sit over the REAL room instead of a void.
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "1", brief: p.brief },
      scenes: [{ id: "bay", environment: { kind: "homeEnvProxy" }, lighting: { rig: "fullRig" }, colliders: { room, props: [] } }],
      layouts: [{ id: "spots", sceneId: "bay", pattern: "grid", count: p.count ?? 4, params: { columns: 2 } }],
      objects: [{ id: "hotspots", sceneId: "bay", source: "primitive", layoutRef: "spots" }],
      interactions: [{ id: "gaze", trigger: "gaze_dwell", target: "hotspots", action: "showInfo", driveChannel: "broadcast" }],
      navigation: { startScene: "bay" },
      verificationPlan: [{ claim: `${p.count ?? 4} hotspots on a grid`, method: "capture", capabilityClass: "C0_emulator", targetRef: "spots", forwardFOVpose: fwd() }],
      headsetLayer: [{ feature: "native-surface anchoring", capabilityClass: "C1", tool: "generate_scene_understanding_kotlin" }],
    }),
  },
  dashboard: {
    desc: "A data dashboard: N metric tiles on a grid, each colored by a JSON status feed.",
    // v32 MR default: Mixed ("1") — metric tiles float at eye level with the real room behind them.
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "1", brief: p.brief },
      scenes: [{ id: "wall", environment: { kind: "procedural" }, lighting: { rig: "sun" }, colliders: { props: [] } }],
      layouts: [{ id: "tiles", sceneId: "wall", pattern: "grid", count: p.count ?? 6, params: { columns: 3 } }],
      objects: [{ id: "metrics", sceneId: "wall", source: "quad", layoutRef: "tiles", dataBindRef: "feed" }],
      data: [{ id: "feed", source: "json", asset: "data/items.json", bindsTo: ["metrics"] }],
      navigation: { startScene: "wall" },
      verificationPlan: [{ claim: `${p.count ?? 6} metric tiles colored by JSON`, method: "capture", capabilityClass: "C0_emulator", targetRef: "tiles", forwardFOVpose: fwd() }],
    }),
    sampleData: (p) => paletteItems(p.count ?? 6, p.palette),
  },
  ambient: {
    desc: "A calm ambient corner: a softly-lit procedural scene, nothing to click.",
    // Progressive ("2") intentionally kept — the adjustable virtual/real balance is this template's point.
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "2", brief: p.brief },
      scenes: [{ id: "corner", environment: { kind: "procedural" }, lighting: { rig: "ibl", params: { ktxAssetPath: "ibl/studio.ktx", mode: "local", intensityExponent: 6 } }, colliders: { props: [] } }],
      layouts: [{ id: "ambient-one", sceneId: "corner", pattern: "arc", count: 1, params: { radius: 2.5, centerY: 1.4, arcSpanDeg: 0 } }],
      objects: [{ id: "ambient", sceneId: "corner", source: "primitive", layoutRef: "ambient-one" }],
      navigation: { startScene: "corner" },
      verificationPlan: [{ claim: "ambient scene renders softly lit", method: "capture", capabilityClass: "C0_emulator", targetRef: "ambient-one", forwardFOVpose: fwd() }],
    }),
  },
  showcase: {
    desc: "An interactive product showcase: N items on shelves, gaze-select + detail card, from a JSON catalog. Controller-ray = Swan.",
    // v32 MR default: Mixed ("1") — the shelf stands in the user's room (homeEnvProxy colliders were
    // already the home bedroom's geometry).
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "1", brief: p.brief },
      scenes: [{ id: "main", environment: { kind: "homeEnvProxy" }, lighting: { rig: "sun" }, colliders: { room, props: [] } }],
      layouts: [{ id: "shelf1", sceneId: "main", pattern: "shelf", count: p.count ?? 6, params: { shelves: 2 } }],
      objects: [{ id: "cards", sceneId: "main", source: "quad", layoutRef: "shelf1", dataBindRef: "catalog" }],
      data: [{ id: "catalog", source: "json", asset: "data/items.json", bindsTo: ["cards"] }],
      interactions: [
        { id: "gaze", trigger: "gaze_dwell", target: "cards", action: "showDetail", driveChannel: "broadcast" },
        { id: "ray", trigger: "controller_ray", target: "cards", action: "select", driveChannel: "controller" },
      ],
      navigation: { startScene: "main" },
      verificationPlan: [
        { claim: `${p.count ?? 6} shelf cards render`, method: "capture", capabilityClass: "C0_emulator", targetRef: "shelf1", forwardFOVpose: fwd() },
        { claim: "select(itemN) shows the matching detail card", method: "capture", capabilityClass: "C0_emulator", targetRef: "gaze", forwardFOVpose: fwd(-2.0) },
      ],
      headsetLayer: [{ feature: "controller-ray select", capabilityClass: "C3", tool: "generate_headset_readiness_codegen" }],
    }),
    sampleData: (p) => paletteItems(p.count ?? 6, p.palette),
  },
  studio: {
    desc: "A premium product STUDIO: N procedural props in an arc, PBR-metallic + a sun rig with soft shadows, each slowly spinning. For real polished-metal reflections, add prepare_ibl_cubemap + generate_ibl_kotlin(mode='local', intensityExponent≈6) on the props. (Richer bespoke scenes — orrery/command-deck — are hand-crafted: see examples/HeroObservatory.kt + VIDEO_DEMO.md.)",
    // v32 MR default: Mixed ("1") — the product props spin in the user's room; the IBL upgrade the
    // desc suggests already names mode='local' (stage-mode IBL is inert in Mixed and fails closed).
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "1", brief: p.brief },
      scenes: [{ id: "studio", environment: { kind: "procedural" }, lighting: { rig: "sun" }, colliders: { props: [] } }],
      layouts: [{ id: "row", sceneId: "studio", pattern: "arc", count: p.count ?? 3, params: { radius: 1.8 } }],
      objects: [{ id: "hero", sceneId: "studio", source: "primitive", layoutRef: "row", material: { mode: "pbr", metallic: 1, roughness: 0.15 }, anim: { type: "tween", property: "rotation", from: [0, 0, 0], to: [0, 360, 0], duration: 8, repeat: "restart" } }],
      navigation: { startScene: "studio" },
      verificationPlan: [{ claim: `${p.count ?? 3} PBR-metal props spinning in a sun-lit studio with shadows`, method: "capture", capabilityClass: "C0_emulator", targetRef: "row", forwardFOVpose: fwd(-1.8) }],
    }),
  },
  knockdown: {
    desc: "A REAL-PHYSICS knockdown game (verified simulating on the emulator, v8.8): a lane, N capsule targets racked at the far end, and a heavy ball — broadcast 'launch:ball' throws it and the targets scatter under real rigid-body dynamics. Expect a ~2s beat between launch and motion (engine epoch). Click START (green) on the in-world GameMenu to throw, RESET (red) to re-rack (disable+rebuild — the only reliable physics reset). The mouse bridge clicks the menu; broadcast start/reset also drives it. Needs assets/menu.bundle.",
    // v32 DELIBERATELY still "3" (Full — explicit opt-in): this is the verified Full-Space physics
    // proof-path (v8.8) whose lane geometry (rack at z=-5 over a floating slab) was proven against
    // the void and reads as floating furniture over passthrough; it has NOT been re-captured in
    // Mixed. The MR-native equivalent is the tabletop game archetype (plan_app_spec game scaffold,
    // modeled on briefs/mrtable.json).
    build: (p) => {
      const n = Math.min(p.count ?? 3, 6);
      const targets = Array.from({ length: n }, (_, i) => ({
        id: `target${i}`,
        sceneId: "lane",
        source: "primitive",
        transform: { position: [(i - (n - 1) / 2) * 0.16, 1.21, -5.0] },
        body: { mode: "dynamic", shape: "capsule", dims: [0.3, 0.06], mass: 0.35, color: [0.95, 0.95, 0.92] },
      }));
      return {
        meta: { appName: p.appName, packageName: p.packageName, stageStyle: "3", brief: p.brief },
        scenes: [{ id: "lane", environment: { kind: "procedural" }, lighting: { rig: "sun" }, colliders: { props: [] }, physics: { gravity: [0, -9.81, 0] } }],
        objects: [
          { id: "floor", sceneId: "lane", source: "primitive", transform: { position: [0, 0.9, -4.2] }, body: { mode: "static", shape: "box", dims: [1.4, 0.2, 3.6], color: [0.55, 0.4, 0.22] } },
          { id: "ball", sceneId: "lane", source: "primitive", transform: { position: [0, 1.17, -2.9] }, body: { mode: "dynamic", shape: "sphere", dims: [0.15], mass: 5, color: [0.1, 0.08, 0.2] } },
          ...targets,
        ],
        interactions: [
          { id: "btnThrow", trigger: "press", target: "ball", action: "launch:ball", driveChannel: "broadcast", params: { velocity: [0, 0, -7], angular: [-8, 0, 0], button: "start" } },
          { id: "btnReset", trigger: "press", target: "ball", action: "resetWorld", driveChannel: "broadcast", params: { button: "reset" } },
        ],
        panels: [{ id: "hud", title: "KNOCKDOWN", kind: "hud", fields: [{ key: "throws", label: "THROWS", initial: "0" }, { key: "status", label: "STATUS", initial: "READY" }] }],
        navigation: { startScene: "lane" },
        verificationPlan: [
          { claim: `${n} capsule targets racked on the lane + the ball at rest`, method: "capture", capabilityClass: "C0_emulator", targetRef: "lane", forwardFOVpose: fwd(-4.2) },
          { claim: "the KNOCKDOWN live-text panel shows THROWS/STATUS and updates on START (turn the camera — panels spawn at the dock position)", method: "capture", capabilityClass: "C0_emulator", targetRef: "hud", forwardFOVpose: fwd(-4.2) },
          { claim: "after 'launch:ball' the ball rolls and the targets scatter (REAL physics)", method: "capture", capabilityClass: "C0_emulator", targetRef: "throw", forwardFOVpose: fwd(-4.2) },
        ],
      };
    },
  },
  constellation: {
    desc: "An ambient CONSTELLATION: N softly-lit nodes in an arc — a calm data/ambient piece (IBL rig). Combine with SceneAnimator (bob/pulseEmissive) for gentle life.",
    // Progressive ("2") intentionally kept — the adjustable virtual/real balance is this template's point.
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "2", brief: p.brief },
      scenes: [{ id: "space", environment: { kind: "procedural" }, lighting: { rig: "ibl", params: { ktxAssetPath: "ibl/studio.ktx", mode: "local", intensityExponent: 6 } }, colliders: { props: [] } }],
      layouts: [{ id: "nodes", sceneId: "space", pattern: "arc", count: p.count ?? 5, params: { radius: 2.0 } }],
      objects: [{ id: "stars", sceneId: "space", source: "primitive", layoutRef: "nodes", material: { mode: "pbr", metallic: 0, roughness: 0.3 } }],
      navigation: { startScene: "space" },
      verificationPlan: [{ claim: `${p.count ?? 5} glowing nodes in an arc`, method: "capture", capabilityClass: "C0_emulator", targetRef: "nodes", forwardFOVpose: fwd(-2.0) }],
    }),
  },
};

/** Pure template constructor used by the MCP wrapper and regression tests. Validation remains the
 * caller's next step so error reporting can retain appSpecSchema's full issue list. */
export function buildTemplateDraft(name: keyof typeof TEMPLATES, params: Params): any {
  const template = TEMPLATES[name];
  if (!template) throw new Error(`unknown template '${String(name)}'`);
  return template.build(params);
}

function paletteItems(n: number, palette?: number[][]) {
  const pal = palette && palette.length ? palette : [[0.85, 0.12, 0.2], [0.95, 0.6, 0.1], [0.95, 0.9, 0.2], [0.15, 0.75, 0.35], [0.2, 0.45, 0.9], [0.6, 0.25, 0.85]];
  return Array.from({ length: n }, (_, i) => ({ id: `item${i}`, label: `Item ${i}`, color: pal[i % pal.length] }));
}

export function registerTemplateTools(server: McpServer) {
  server.registerTool(
    "list_templates",
    {
      description: "List the 8 parameterized AppSpec skeletons (gallery / inspection / dashboard / ambient / showcase / studio / constellation / KNOCKDOWN) — the proven app shapes you can instantiate for a new brief instead of authoring from scratch. `knockdown` is the REAL-physics game (physics + clickable GameMenu + live-text scoreboard — the proof-path for physics/interactive/hybrid briefs); `studio` is AAA PBR-metal; `constellation` is ambient + SceneAnimator. Each names its params + which are data-bound/interactive + any Swan-only pieces. Instantiate with instantiate_template(name, brief, appName, packageName[, count, palette]).",
      inputSchema: {},
    },
    async () => okJson({ templates: Object.entries(TEMPLATES).map(([name, t]) => ({ name, description: t.desc, dataBound: !!t.sampleData })) }),
  );

  server.registerTool(
    "instantiate_template",
    {
      description: "Instantiate a template skeleton into a concrete, validated AppSpec for a new brief — ready for plan_app_spec -> compile_app_spec. Stamps the app/package + count + palette; for data-bound templates it also returns a sample data JSON (write it to app/src/main/assets/data/items.json). Reuse over the v5.0 pipeline; the output is regression-gated like any other app.",
      inputSchema: {
        name: z.enum(["gallery", "inspection", "dashboard", "ambient", "showcase", "studio", "constellation", "knockdown"]).describe("Which skeleton."),
        brief: z.string().describe("The new brief this instance realizes."),
        appName: z.string().describe("App name, e.g. SpiceShowcaseXR."),
        packageName: z.string().describe("applicationId, e.g. com.example.spicexr."),
        count: z.number().int().optional().describe("Object count (template default if omitted)."),
        palette: z.array(z.array(z.number()).length(3)).optional().describe("Optional [r,g,b] 0..1 colors for data-bound sample items."),
      },
    },
    async ({ name, brief, appName, packageName, count, palette }) => {
      const t = TEMPLATES[name];
      const draft = buildTemplateDraft(name, { appName, packageName, brief, count, palette });
      const parsed = appSpecSchema.safeParse(draft);
      if (!parsed.success) return okJson({ status: "error", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      const iblPath = parsed.data.scenes.find((scene) => scene.lighting.rig === "ibl")?.lighting.params?.ktxAssetPath;
      return okJson({
        status: "ok",
        template: name,
        spec: parsed.data,
        sampleData: t.sampleData ? t.sampleData({ appName, packageName, brief, count, palette }) : null,
        next: "Review the spec, then compile_app_spec(spec, projectDir). For data-bound templates write sampleData to app/src/main/assets/data/items.json." +
          (iblPath ? ` Before building, bake or copy a real prefiltered cubemap to app/src/main/assets/${iblPath}.` : ""),
      });
    },
  );
}
