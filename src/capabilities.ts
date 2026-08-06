import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * capabilities.ts — v5.0 `list_capabilities`: the machine-readable menu the planner plans AGAINST.
 *
 * A curated manifest of the authoring/spine tools that `compile_app_spec` can drive, each tagged with WHAT
 * it authors, its key params, and its verification ceiling (the emulator C-class). The planner cannot plan
 * a node that no tool can build, and it stamps each node's C-class from this menu — so the honest
 * emulator-vs-Swan split is decided at plan time. (This is a curated manifest, not live-registry
 * introspection: the registry has no central metadata store; keep this in sync as generators are added.)
 */

export type CapEntry = {
  tool: string;
  authors: string;
  keyParams: string;
  ceiling: "C0_emulator" | "C1" | "C2" | "C3" | "C4_headset_only";
  note?: string;
};

export const CAPABILITY_MANIFEST: CapEntry[] = [
  { tool: "verify_gradle_config", authors: "source-grounded project configuration audit", keyParams: "projectDir,resolveTransitives", ceiling: "C0_emulator", note: "static mode is read-only; resolveTransitives may populate caches and use configured network repositories" },
  { tool: "build_matrix_report", authors: "observed packaged scaffold build matrix", keyParams: "none", ceiling: "C0_emulator", note: "source-grounded configuration evidence only" },
  // spine
  { tool: "scaffold_spatial_app", authors: "a fresh buildable app (package/appName/stage/scene)", keyParams: "templateProject,targetDir,packageName,appName,stageStyle", ceiling: "C0_emulator" },
  { tool: "build_and_run", authors: "compile+install+launch+auto capability matrix", keyParams: "projectDir,packageName,task,settleSec", ceiling: "C0_emulator" },
  { tool: "generate_agent_bridge", authors: "headless command channel + dump_scene (structural assert)", keyParams: "packageName,tag", ceiling: "C0_emulator" },
  // environment / richness
  { tool: "measure_model", authors: "a model's REAL bounding box + baseLift, so placement never runs on hand-measured numbers", keyParams: "modelPath", ceiling: "C0_emulator", note: "step 1 of measure -> bake -> generate_surface_placement_kotlin; generated GLBs are origin-CENTRED" },
  { tool: "bake_textured_model", authors: "a baked PBR bundle from a GLB (the ONLY textured path)", keyParams: "modelPath,outBundle", ceiling: "C0_emulator", note: "never runtime-load raw GLB (renders black)" },
  { tool: "generate_surface_placement_kotlin", authors: "the 6-trap MR seating object: poll planes -> convert anchor space -> seat with measured lift + primitive collider", keyParams: "packageName,bundleAsset,modelName,semantic,modelSize,baseLift", ceiling: "C0_emulator", note: "emulator-proven against the SIMULATED room planes (mrtable seq 10-11); REAL-room surfaces are hardware" },
  { tool: "place_model_on_surface", authors: "ONE CALL: measure -> bake -> surface-placement Kotlin seating a GLB on a detected FLOOR/TABLE/WALL", keyParams: "modelPath,semantic,packageName,modelName,offset", ceiling: "C0_emulator", note: "chains the proven v30 steps; the bake step runs the real spatialbundle toolchain" },
  { tool: "generate_environment_kotlin", authors: "MeshEnvironment/SplatEnvironment loader", keyParams: "kind,assetFileName,baseColorImage", ceiling: "C0_emulator" },
  { tool: "generate_home_env_proxy", authors: "invisible collider proxy of the known home bedroom (floor y=0)", keyParams: "packageName", ceiling: "C1", note: "faked hit-test; real surfaces are Swan-only" },
  { tool: "generate_collider_kotlin", authors: "PhysicsWorld + primitive room/prop colliders + rayCast", keyParams: "packageName,room,shapes", ceiling: "C0_emulator", note: "PhysicsWorldComponent REQUIRED on-device; primitives only" },
  { tool: "generate_lighting_kotlin", authors: "directional sun + IBL scale", keyParams: "packageName", ceiling: "C0_emulator" },
  { tool: "generate_full_lighting_rig_kotlin", authors: "Directional+Point+Spot+GroundShadow+IBL", keyParams: "packageName", ceiling: "C0_emulator" },
  { tool: "generate_ibl_kotlin", authors: "image-based lighting from a .ktx", keyParams: "packageName,ktx", ceiling: "C0_emulator", note: "StageEnvironmentLighting inactive in MIXED stage" },
  // v5.0 primitives (this session)
  { tool: "generate_layout_kotlin", authors: "analytical wall/grid/arc/shelf placement of N entities", keyParams: "packageName,pattern,count,radius,spacing,columns,shelves,centerY,centerZ,faceUser", ceiling: "C0_emulator" },
  { tool: "generate_interaction_kotlin", authors: "raycast+broadcast select/hover + selection state + highlight", keyParams: "packageName,highlightScale,defaultBoxSize", ceiling: "C0_emulator", note: "broadcast select = C0; controller/gaze ray = C3 Swan" },
  { tool: "generate_data_binding_kotlin", authors: "bundled JSON -> N tinted-quad cards + lookups (NO TextComponent)", keyParams: "packageName,cardWidth,cardHeight,defaultColor", ceiling: "C0_emulator", note: "dynamic text labels need baked textures" },
  { tool: "generate_tappable_detail_kotlin", authors: "named entities -> tappable detail views: interactable + primitive collider + colour-keyed registry + HUD detail expand", keyParams: "packageName,items,hudKey", ceiling: "C0_emulator", note: "broadcast select:<id> = C0; real pointer tap = C3 Swan; composition compiles + broadcast-drivable, not yet vision-verified end-to-end" },
  // UI / menu
  { tool: "generate_game_menu_kotlin", authors: "in-world pressable 3D menu (broadcast/gaze/controller/pinch)", keyParams: "packageName,actions", ceiling: "C0_emulator", note: "controller/pinch drive = C3 Swan" },
  { tool: "generate_scene_animator_kotlin", authors: "RELIABLE runtime animation: orbit/spin/bob + growY + pulseEmissive/fadeOpacity/cycleHue (coroutine frame loop — SDK AnimationResource does NOT propagate to runtime entities)", keyParams: "packageName", ceiling: "C0_emulator" },
  { tool: "prepare_ibl_cubemap", authors: "a prefiltered HDR cubemap (Filament cmgen) so PBR METALS actually shine — pair with generate_ibl_kotlin(mode='local', intensityExponent~6)", keyParams: "preset|equirectPath,outKtx", ceiling: "C0_emulator" },
  { tool: "generate_panel_compose_kotlin", authors: "LIVE RUNTIME TEXT: a Compose panel ACTIVITY auto-hosted as a floating spatial panel (HUD/scoreboard; DEBUG_CMD hud:<key>=<value> updates live). The no-TextComponent limit is in-scene-3D only", keyParams: "packageName,title,fields", ceiling: "C0_emulator", note: "needs the manifestEntry merged. NARROWED 2026-08-06 (ledger com.picoagent.v35expb#0): an app's own WindowContainer DOES open when it calls spatialNavigator.openWindowContainer — see generate_container_app_kotlin. This Activity lane stays right when you want the shell to own the panel independently of any container" },
  { tool: "render_usd_offscreen", authors: "off-device USD render (usdrecord) — verify generated content in seconds without the emulator", keyParams: "usdPath,outPng", ceiling: "C0_emulator" },
  { tool: "import_world_environment", authors: "a CUSTOM World-Labs/Marble world (.spz/.ply splat or GLB) as the app environment", keyParams: "worldPath,projectDir", ceiling: "C0_emulator" },
  { tool: "install_gradle_hooks", authors: "the EXTERNAL gradle plugin com.pico.hooks: USD scene-lint riding EVERY build (AS/CLI/CI, no MCP in the loop)", keyParams: "projectDir", ceiling: "C0_emulator" },
  { tool: "emit_editor_components", authors: "per-project component SCHEMA files (.spatialEditorComponent) — interchange only; the editor's Add Component palette does NOT pick them up (verified negative)", keyParams: "projectRoot,components", ceiling: "C0_emulator", note: "structural only — never claim Inspector render" },
  { tool: "generate_spatial_ui", authors: "SDK 0.13.3 source-grounded Compose component functions", keyParams: "packageName,panels", ceiling: "C4_headset_only", note: "structural composables only; expanded callbacks are placeholders, this tool owns no container, and appearance remains unverified until a capture is LOOKED at" },
  { tool: "generate_ecs_system_kotlin", authors: "an ECS Component + System PAIR (spin/orbit/bob/custom) plus its registerSystem/unregisterSystem DisposableEffect — PICO's own per-frame mechanism, engine-driven", keyParams: "packageName,kind,name", ceiling: "C0_emulator", note: "prefer over generate_scene_animator_kotlin for NEW per-frame work; structural (compiles against cited 0.13.3 symbols) — registerSystem is a no-op unless SpatialBuild.isSpatialPlatform(), so systems never tick under JVM/Robolectric; the registering module needs ui:foundation, not just core; motion needs a looked-at capture" },
  { tool: "generate_attachment_panel_kotlin", authors: "Compose panels placed INSIDE the 3D scene at a chosen position in METRES (AttachmentPanel + TransformComponent) — the in-scene counterpart to generate_panel_compose_kotlin's docked 2D Activity", keyParams: "packageName,panels[{id,title,lines,position,widthDp,heightDp,alignment,faceViewer}]", ceiling: "C0_emulator", note: "VISION_VERIFIED on the emulator (ledger com.picoagent.v35attach#0): renders in-scene and correctly depth-sorts against scene geometry. SCENE placement, NOT world-locking — panels move with their container; a real-room anchor still needs AnchorComponent (deferred). Requires minSdk 35 (the world-matrix path is API-35-gated)" },
  { tool: "generate_container_app_kotlin", authors: "a Main.kt with MORE THAN ONE container — a DefaultWindowContainer or DefaultStage root plus secondary WindowContainers/Stages opened at runtime via LocalSpatialNavigator (the WelcomeSpace shape)", keyParams: "packageName,root,rootContent,rootContentImport,containers[{kind,id,form,size,style,immersion}]", ceiling: "C0_emulator", note: "REPLACES the app's Main.kt — never add beside another mainApp. A declared container does NOT open itself; the emitted Open*OnEnter helper calls the navigator. Secondary WindowContainer opening is vision_verified (ledger com.picoagent.v35expb#0); opening a secondary STAGE via openStage and cross-container Bundle delivery are still unmeasured" },
  { tool: "generate_skeletal_animation_kotlin", authors: "SceneSkeletal.kt — plays BAKED skeletal clips from a loaded model (Entity.load -> findSkinnedMeshEntity -> getAnimationResources -> playAnimation), by clip NAME", keyParams: "packageName,modelUri,clips", ceiling: "C0_emulator", note: "the lane that makes downloaded character GLBs animatable — our other animation tools are procedural only. Model-obtained clips are MODEL-LIFETIME: closed once in dispose(), never on stop() or clip switch (the inverse of generated clips). Only Entity.load may leave the main thread. A non-skinned GLB yields an empty array silently. Structural: jar-cited and sample-shaped, not yet looked at" },
  { tool: "generate_subwindow_kotlin", authors: "DefaultStage entrypoint with retained primary content, a named secondary WindowContainer, and Subwindow", keyParams: "packageName,primaryId,primaryContent,secondaryId,stableTag,payload,size,constraints,subwindowSide,componentContent", ceiling: "C4_headset_only", note: "structural SDK 0.13.3 codegen; Mixed requires the caller-applied launcher manifest style 1 contract; Subwindow is an attached augment, CONTAINER-RELATIVE by construction (0.13.3 KDoc Subwindow.kt:41-42 — shown at the left/right side of the window container, height always filling it), so it follows its container and can never be world-locked; structure does not prove pixel rendering" },
  { tool: "generate_spatial_gestures_kotlin", authors: "target-filtered tap, drag, and scale gesture lanes with primitive collision", keyParams: "packageName,targetId,commandDispatcher", ceiling: "C3", note: "tap has a structural select:<id> command route; drag/scale remain named callbacks and native pointer behavior requires headset driving and observation" },
  // animation / media / physics / display
  { tool: "generate_tween_animation_kotlin", authors: "position/scale tween on an entity", keyParams: "packageName", ceiling: "C0_emulator" },
  { tool: "generate_orbit_animation_kotlin", authors: "orbit animation", keyParams: "packageName", ceiling: "C0_emulator" },
  { tool: "generate_particle_kotlin", authors: "driver for an editor-authored ParticleComponent", keyParams: "packageName", ceiling: "C0_emulator", note: "ParticleComponent has no ctor" },
  { tool: "generate_video_player_kotlin", authors: "video-on-quad", keyParams: "packageName", ceiling: "C0_emulator", note: "decode often fails on emulator" },
  { tool: "generate_spatial_audio_kotlin", authors: "3D ObjectAudioComponent", keyParams: "packageName", ceiling: "C3", note: "playback headset-only" },
  { tool: "generate_rigidbody_kotlin", authors: "REAL dynamics: fall/roll/strike + safe launch/reset (vision-verified bowling strike)", keyParams: "packageName,gravity", ceiling: "C0_emulator" },
  { tool: "generate_portal_kotlin", authors: "portal window + nested world", keyParams: "packageName", ceiling: "C0_emulator", note: "entity-crossing/passthrough = Swan" },
  { tool: "generate_display_controllers_kotlin", authors: "display-group ordering controllers", keyParams: "packageName", ceiling: "C0_emulator" },
  // headset codegen
  { tool: "generate_scene_understanding_kotlin", authors: "sense/plane surface pins", keyParams: "packageName", ceiling: "C0_emulator", note: "the emulator DOES return SIMULATED planes with semantics (FLOOR/TABLE/CHAIR/DOOR/WINDOW…) on an OPEN Stage — any stage style, Mixed (1) included — after polling (cold boot ~7 retries; FLOOR at y=0.40, measured 2026-07-29) — REAL-room surfaces remain hardware" },
  { tool: "generate_persistent_anchor_kotlin", authors: "world anchors", keyParams: "packageName", ceiling: "C1", note: "world-tracking headset-only" },
  { tool: "generate_headset_readiness_codegen", authors: "guarded C1/C3/C4 registry for Swan", keyParams: "packageName", ceiling: "C3" },
  { tool: "generate_anchor_kotlin", authors: "camera/world anchor tether", keyParams: "packageName,trackingMode", ceiling: "C1" },
];

const CEILINGS: Record<string, string> = {
  C0_emulator: "Fully verifiable on the emulator now (renders in a forward capture / broadcast-drivable).",
  C1: "REAL-world scene understanding / hand-tracking need hardware. RETRACTION (2026-07-29, measured): the emulator DOES supply SIMULATED planes with semantics (FLOOR/TABLE/CHAIR/DOOR/WINDOW…; FLOOR at y=0.40) on an OPEN Stage after polling (~7 retries on a cold boot) — 'Full Space' in older notes meant Stage-not-WindowContainer, which Mixed stageStyle 1 also satisfies (mrtable gets 40+ planes) — so plane-based placement verifies on the emulator; only real-room surfaces, mesh data, and hand-tracking remain Swan.",
  C2: "Camera decoupled — verifiable only with a forward-FOV pose; content outside it can't be captured.",
  C3: "No controller/gaze pointer on the emulator — broadcast-emulate now, real controller/pinch is Swan-only.",
  C4_headset_only: "Stage-vs-window dichotomy — in-front Compose panels etc. are Swan-only.",
  PARTNER_STATED_stageStyle3: "Full Space stageStyle-3 immersive apps hit a known Guardian-boundary issue on hardware — PARTNER-STATED (per Matt/PICO, fix in progress), NOT measured by us. Scoped strictly to stageStyle '3' immersion: it does NOT taint the open-Stage plane/seating lane, which Mixed (stageStyle 1, the MR default) satisfies. Style 3 stays a first-class explicit opt-in until re-verified on hardware.",
};

export const CAPABILITY_EVIDENCE_NOTES = {
  knowledgeGraph:
    "knowledge_api is broad contextual graph evidence over a persistent pico-cli session; it does not prove exact SDK declarations",
  exactSdkSymbols:
    "vault_api is authoritative for exact installed-SDK signatures and file/line citations",
  lintSecondOpinion:
    "knowledgeSecondOpinion is opt-in query_graph context and never changes preflight_lint clean",
};

export function registerCapabilityManifestTools(server: McpServer) {
  server.registerTool(
    "list_capabilities",
    {
      description:
        "Return the machine-readable capability manifest the brief-to-app planner plans AGAINST: every authoring/spine tool compile_app_spec can drive, what it authors, its key params, and its emulator verification ceiling (C0_emulator / C1 / C2 / C3 / C4_headset_only). Use this before plan_app_spec so the plan cannot request a node no tool can build, and so each node's honest emulator-vs-Swan class is known at plan time. Filter by ceiling to see exactly what is emulator-verifiable now vs. built-for-Swan.",
      inputSchema: {
        ceiling: z
          .enum(["C0_emulator", "C1", "C2", "C3", "C4_headset_only"])
          .optional()
          .describe("Optional: only return tools with this verification ceiling."),
        contains: z.string().optional().describe("Optional case-insensitive substring filter on tool name / what it authors."),
      },
    },
    async ({ ceiling, contains }) => {
      let tools = CAPABILITY_MANIFEST;
      if (ceiling) tools = tools.filter((t) => t.ceiling === ceiling);
      if (contains) {
        const q = contains.toLowerCase();
        tools = tools.filter((t) => t.tool.toLowerCase().includes(q) || t.authors.toLowerCase().includes(q));
      }
      return okJson({
        count: tools.length,
        totalRegistered: CAPABILITY_MANIFEST.length,
        ceilings: CEILINGS,
        evidenceNotes: CAPABILITY_EVIDENCE_NOTES,
        tools,
      });
    },
  );
}
