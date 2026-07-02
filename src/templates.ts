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
    desc: "A quiet gallery: N works floating in an arc, softly lit. No data/interaction.",
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "3", brief: p.brief },
      scenes: [{ id: "main", environment: { kind: "texturedMesh" }, lighting: { rig: "sun" }, colliders: { props: [] } }],
      layouts: [{ id: "arc1", sceneId: "main", pattern: "arc", count: p.count ?? 3, params: { radius: 2.2 } }],
      objects: [{ id: "works", sceneId: "main", source: "quad", layoutRef: "arc1" }],
      navigation: { startScene: "main" },
      verificationPlan: [{ claim: `${p.count ?? 3} works in an arc`, method: "capture", capabilityClass: "C0_emulator", targetRef: "arc1", forwardFOVpose: fwd(-2.2) }],
    }),
  },
  inspection: {
    desc: "An inspection bay: N gaze-selectable hotspots on a grid over the home-env floor. Native anchoring = Swan.",
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "3", brief: p.brief },
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
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "3", brief: p.brief },
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
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "2", brief: p.brief },
      scenes: [{ id: "corner", environment: { kind: "procedural" }, lighting: { rig: "ibl" }, colliders: { props: [] } }],
      objects: [{ id: "ambient", sceneId: "corner", source: "primitive", transform: { position: [0, 1.4, -2.5] } }],
      navigation: { startScene: "corner" },
      verificationPlan: [{ claim: "ambient scene renders softly lit", method: "capture", capabilityClass: "C0_emulator", targetRef: "corner", forwardFOVpose: fwd() }],
    }),
  },
  showcase: {
    desc: "An interactive product showcase: N items on shelves, gaze-select + detail card, from a JSON catalog. Controller-ray = Swan.",
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "3", brief: p.brief },
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
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "3", brief: p.brief },
      scenes: [{ id: "studio", environment: { kind: "procedural" }, lighting: { rig: "sun" }, colliders: { props: [] } }],
      layouts: [{ id: "row", sceneId: "studio", pattern: "arc", count: p.count ?? 3, params: { radius: 1.8 } }],
      objects: [{ id: "hero", sceneId: "studio", source: "primitive", layoutRef: "row", material: { mode: "pbr", metallic: 1, roughness: 0.15 }, anim: { type: "tween", property: "rotation", from: [0, 0, 0], to: [0, 360, 0], duration: 8, repeat: "restart" } }],
      navigation: { startScene: "studio" },
      verificationPlan: [{ claim: `${p.count ?? 3} PBR-metal props spinning in a sun-lit studio with shadows`, method: "capture", capabilityClass: "C0_emulator", targetRef: "row", forwardFOVpose: fwd(-1.8) }],
    }),
  },
  constellation: {
    desc: "An ambient CONSTELLATION: N softly-lit nodes in an arc — a calm data/ambient piece (IBL rig). Combine with SceneAnimator (bob/pulseEmissive) for gentle life.",
    build: (p) => ({
      meta: { appName: p.appName, packageName: p.packageName, stageStyle: "2", brief: p.brief },
      scenes: [{ id: "space", environment: { kind: "procedural" }, lighting: { rig: "ibl" }, colliders: { props: [] } }],
      layouts: [{ id: "nodes", sceneId: "space", pattern: "arc", count: p.count ?? 5, params: { radius: 2.0 } }],
      objects: [{ id: "stars", sceneId: "space", source: "primitive", layoutRef: "nodes", material: { mode: "pbr", metallic: 0, roughness: 0.3 } }],
      navigation: { startScene: "space" },
      verificationPlan: [{ claim: `${p.count ?? 5} glowing nodes in an arc`, method: "capture", capabilityClass: "C0_emulator", targetRef: "nodes", forwardFOVpose: fwd(-2.0) }],
    }),
  },
};

function paletteItems(n: number, palette?: number[][]) {
  const pal = palette && palette.length ? palette : [[0.85, 0.12, 0.2], [0.95, 0.6, 0.1], [0.95, 0.9, 0.2], [0.15, 0.75, 0.35], [0.2, 0.45, 0.9], [0.6, 0.25, 0.85]];
  return Array.from({ length: n }, (_, i) => ({ id: `item${i}`, label: `Item ${i}`, color: pal[i % pal.length] }));
}

export function registerTemplateTools(server: McpServer) {
  server.registerTool(
    "list_templates",
    {
      description: "List the parameterized AppSpec skeletons (gallery / inspection / dashboard / ambient / showcase) — the proven app shapes you can instantiate for a new brief instead of authoring a spec from scratch. Each names its params + which are data-bound/interactive + any Swan-only pieces.",
      inputSchema: {},
    },
    async () => okJson({ templates: Object.entries(TEMPLATES).map(([name, t]) => ({ name, description: t.desc, dataBound: !!t.sampleData })) }),
  );

  server.registerTool(
    "instantiate_template",
    {
      description: "Instantiate a template skeleton into a concrete, validated AppSpec for a new brief — ready for plan_app_spec -> compile_app_spec. Stamps the app/package + count + palette; for data-bound templates it also returns a sample data JSON (write it to app/src/main/assets/data/items.json). Reuse over the v5.0 pipeline; the output is regression-gated like any other app.",
      inputSchema: {
        name: z.enum(["gallery", "inspection", "dashboard", "ambient", "showcase", "studio", "constellation"]).describe("Which skeleton."),
        brief: z.string().describe("The new brief this instance realizes."),
        appName: z.string().describe("App name, e.g. SpiceShowcaseXR."),
        packageName: z.string().describe("applicationId, e.g. com.example.spicexr."),
        count: z.number().int().optional().describe("Object count (template default if omitted)."),
        palette: z.array(z.array(z.number()).length(3)).optional().describe("Optional [r,g,b] 0..1 colors for data-bound sample items."),
      },
    },
    async ({ name, brief, appName, packageName, count, palette }) => {
      const t = TEMPLATES[name];
      const draft = t.build({ appName, packageName, brief, count, palette });
      const parsed = appSpecSchema.safeParse(draft);
      if (!parsed.success) return okJson({ status: "error", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      return okJson({
        status: "ok",
        template: name,
        spec: parsed.data,
        sampleData: t.sampleData ? t.sampleData({ appName, packageName, brief, count, palette }) : null,
        next: "Review the spec, then compile_app_spec(spec, projectDir). For data-bound templates write sampleData to app/src/main/assets/data/items.json.",
      });
    },
  );
}
