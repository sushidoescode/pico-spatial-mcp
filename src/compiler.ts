import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema, type AppSpec } from "./appspec.js";

/**
 * compiler.ts — v5.0 `compile_app_spec`.
 *
 * Walks a validated AppSpec topologically and emits a BUILD LEDGER: an ordered list mapping each spec node
 * → the EXACT existing tool call (tool + args, packageName pre-filled) → the target Kotlin file → the C-class.
 * It is a DRIVER + reconciler, NOT a second orchestrator and NOT a monolith that hides the build — the
 * `brief_to_app` prompt (the agent, inside the Workflow engine) executes the ledger step-by-step through the
 * REAL generate_* / scaffold / bake / build tools, applying file edits SERIALLY (the parallel-writer clobber
 * lesson). The ledger is idempotent + resumable: each step names its output path so a re-run can skip
 * completed steps. This keeps the plan human-readable and makes "did we build what the brief asked?" objective.
 */

type LedgerStep = {
  order: number;
  node: string; // spec node id (or "meta"/"build")
  tool: string;
  args: Record<string, any>;
  targetPath: string;
  cClass: string;
  status: "planned";
  note?: string;
};

function contentPkgPath(packageName: string): string {
  return `app/src/main/java/${packageName.replace(/\./g, "/")}/content`;
}

export function buildLedger(spec: AppSpec, projectDir: string): LedgerStep[] {
  const steps: LedgerStep[] = [];
  const pkg = spec.meta.packageName;
  const contentPkg = `${pkg}.content`;
  const cpath = contentPkgPath(pkg);
  let n = 0;
  const push = (s: Omit<LedgerStep, "order" | "status">) => steps.push({ order: n++, status: "planned", ...s });

  // 1. scaffold
  push({
    node: "meta",
    tool: "scaffold_spatial_app",
    args: { targetDir: projectDir, packageName: pkg, appName: spec.meta.appName, stageStyle: spec.meta.stageStyle },
    targetPath: projectDir,
    cClass: "C0_emulator",
    note: "Provide a known-good templateProject. Force-stop other com.example.* apps first (launch flakiness).",
  });
  // 2. agent bridge (headless assert channel) — always
  push({ node: "meta", tool: "generate_agent_bridge", args: { packageName: pkg }, targetPath: `${cpath}/AgentBridge.kt`, cClass: "C0_emulator", note: "SKIP this step if the scaffold template already ships agent/AgentBridge.kt (galleryxr-derived templates do); otherwise inject and call AgentBridge.attachScene(root). The bridge lives under <pkg>.agent." });

  // 3. per-scene: environment → colliders → lighting
  for (const s of spec.scenes) {
    const env = s.environment;
    if (env.kind === "texturedMesh") {
      push({ node: s.id, tool: "bake_textured_model", args: { modelPath: env.asset ?? "<model.glb>", outBundle: `${projectDir}/app/src/main/assets/${(env.asset ?? "model").replace(/\.glb$/, "")}.bundle` }, targetPath: "app/src/main/assets/", cClass: "C0_emulator", note: "The ONLY textured path — never runtime-load raw GLB." });
      push({ node: s.id, tool: "generate_environment_kotlin", args: { packageName: contentPkg, kind: "texturedMesh", assetFileName: env.asset, baseColorImage: env.baseColorImage }, targetPath: `${cpath}/MeshEnvironment.kt`, cClass: "C0_emulator" });
    } else if (env.kind === "splat") {
      push({ node: s.id, tool: "generate_environment_kotlin", args: { packageName: contentPkg, kind: "splat", assetFileName: env.asset, delivery: "storage" }, targetPath: `${cpath}/SplatEnvironment.kt`, cClass: "C0_emulator", note: "adb-push the .spz; spatialbundle can't pack splats. NOTE: a splat is a BOUNDED volume — for a full surround use kind=pano (skybox)." });
    } else if (env.kind === "pano") {
      push({ node: s.id, tool: "generate_environment_kotlin", args: { packageName: contentPkg, kind: "skybox", assetFileName: env.baseColorImage ?? env.asset }, targetPath: `${cpath}/SkyboxEnvironment.kt`, cClass: "C0_emulator", note: "FULL-surround equirect skybox (no bounded blob). Ship the pano PNG (≤4096px) in assets/." });
    } else if (env.kind === "homeEnvProxy") {
      push({ node: s.id, tool: "generate_home_env_proxy", args: { packageName: contentPkg }, targetPath: `${cpath}/HomeEnvProxy.kt`, cClass: "C1", note: "Faked hit-test of the known bedroom; floor y=0 is the only vision-verified anchor." });
    } else if (env.kind !== "procedural") {
      push({ node: s.id, tool: "generate_environment_kotlin", args: { packageName: contentPkg, kind: env.kind, assetFileName: env.asset }, targetPath: `${cpath}/Environment.kt`, cClass: "C0_emulator" });
    }
    // kind "procedural" = the scene content IS the environment — no env file to generate.
    if (s.colliders.room) {
      push({ node: s.id, tool: "generate_collider_kotlin", args: { packageName: contentPkg, room: s.colliders.room, shapes: s.colliders.props }, targetPath: `${cpath}/SpatialColliders.kt`, cClass: "C0_emulator", note: "attachPhysicsWorld(root) REQUIRED on-device before rayCast." });
    }
    // v9.1: REAL physics (verified simulating on the emulator, v8.8) — one ScenePhysics.kt per app.
    if ((s as any).physics || spec.objects.some((o: any) => o.body)) {
      const g = (s as any).physics?.gravity;
      push({ node: s.id, tool: "generate_rigidbody_kotlin", args: { packageName: contentPkg, ...(g ? { gravity: g } : {}) }, targetPath: `${cpath}/ScenePhysics.kt`, cClass: "C0_emulator", note: "REAL emulator physics (v8.8 rulebook baked in): wiring calls initWorld + per-body helpers; launch via 'launch:<id>' broadcast; reset = resetWorld (disable+rebuild), never destroy." });
    }
    const rig = s.lighting.rig;
    if (rig !== "none") {
      const tool = rig === "fullRig" ? "generate_full_lighting_rig_kotlin" : rig === "ibl" ? "generate_ibl_kotlin" : "generate_lighting_kotlin";
      // v14.9: every invoker (template HomeStage + generate_app_wiring) calls SceneLighting.apply —
      // the fullRig must be EMITTED under that object name (its default SceneLightingRig collides
      // with the template's bundled copy AND leaves the call site unresolved; found by the
      // spotcheck brief). ibl differs in API (SceneIBL.applyStage/applyLocal) and gets its own file.
      const lightArgs: Record<string, unknown> = { packageName: contentPkg, ...(s.lighting.params ?? {}) };
      if (rig === "fullRig") lightArgs.objectName = "SceneLighting";
      push({ node: s.id, tool, args: lightArgs, targetPath: `${cpath}/${rig === "ibl" ? "SceneIBL.kt" : "SceneLighting.kt"}`, cClass: "C0_emulator" });
    }
  }

  // 4. layouts
  for (const l of spec.layouts) {
    push({ node: l.id, tool: "generate_layout_kotlin", args: { packageName: contentPkg, pattern: l.pattern, count: l.count, ...(l.params ?? {}) }, targetPath: `${cpath}/SceneLayout.kt`, cClass: "C0_emulator" });
  }
  // 5. data binding
  for (const d of spec.data) {
    if (d.source === "json") push({ node: d.id, tool: "generate_data_binding_kotlin", args: { packageName: contentPkg }, targetPath: `${cpath}/SceneDataBinding.kt`, cClass: "C0_emulator", note: `Place ${d.asset ?? "data/items.json"} under app/src/main/assets/.` });
    else push({ node: d.id, tool: "generate_data_binding_kotlin", args: { packageName: contentPkg }, targetPath: `${cpath}/SceneDataBinding.kt`, cClass: "C3", note: "gated_api: network-gated; verify with one live call and flag it." });
  }
  // 5b. animation (v7.3) — an object's anim ({type:tween|orbit,...}) → SceneTween/SceneOrbit, played in the wiring
  for (const o of spec.objects) {
    const a: any = o.anim;
    if (!a || (a.type !== "tween" && a.type !== "orbit")) continue;
    if (a.type === "orbit") {
      push({ node: o.id, tool: "generate_orbit_animation_kotlin", args: { packageName: contentPkg, axis: a.axis, startPosition: a.startPosition, duration: a.duration, rotationCount: a.rotationCount, loop: a.loop ?? true }, targetPath: `${cpath}/SceneOrbit.kt`, cClass: "C0_emulator", note: "Revolves each placed entity; wiring calls SceneOrbit.play(it)." });
    } else {
      push({ node: o.id, tool: "generate_tween_animation_kotlin", args: { packageName: contentPkg, property: a.property ?? "rotation", from: a.from, to: a.to, duration: a.duration, repeat: a.repeat, loop: a.loop ?? true, ease: a.ease }, targetPath: `${cpath}/SceneTween.kt`, cClass: "C0_emulator", note: "Tweens each placed entity; wiring calls SceneTween.play(it)." });
    }
  }

  // v9.4: panels -> a Compose WindowContainer with LIVE runtime text (the hybrid-app tier).
  for (const pn of (spec as any).panels ?? []) {
    if (pn.kind === "web") {
      push({ node: pn.id, tool: "generate_panel_compose_kotlin", args: { packageName: contentPkg, kind: "web", ...(pn.url ? { url: pn.url } : {}), ...(pn.html ? { html: pn.html } : {}) }, targetPath: `${cpath}/WebPanel.kt`, cClass: "C0_emulator", note: "WEB panel: full HTML/CSS/JS with a LIVE DOM as a spatial panel (vision-verified). Merge the returned manifestEntry (+ INTERNET permission for URLs). Show: am start -n <pkg>/<contentPkg>.WebPanelActivity." });
    } else {
      push({ node: pn.id, tool: "generate_panel_compose_kotlin", args: { packageName: contentPkg, title: pn.title, ...(pn.fields?.length ? { fields: pn.fields } : {}) }, targetPath: `${cpath}/HudPanel.kt`, cClass: "C0_emulator", note: "LIVE TEXT panel (2D windows composite as spatial panels). Spawns at the dock position — verify by turning the camera. Headless drive: DEBUG_CMD 'hud:<key>=<value>'." });
    }
  }

  // v9.2: press interactions -> the in-world clickable GameMenu (mouse-bridge detectable).
  if (spec.interactions.some((i: any) => i.trigger === "press")) {
    push({ node: spec.interactions.filter((i: any) => i.trigger === "press").map((i: any) => i.id).join(","), tool: "generate_game_menu_kotlin", args: { packageName: `${pkg}.gen` }, targetPath: `${cpath.replace(/content$/, "gen")}/GameMenu.kt`, cClass: "C0_emulator", note: "Needs assets/menu.bundle (bake_textured_model of the 4-row panel, or copy a known-good one). The wiring attaches it on its own root + maps buttons via customActions; the mouse bridge clicks it. Broadcast start/pause/resume/reset also drives it." });
  }

  // 6. interactions (one engine file; per-interaction registration is authored in the wiring)
  if (spec.interactions.length) {
    push({ node: spec.interactions.map((i) => i.id).join(","), tool: "generate_interaction_kotlin", args: { packageName: contentPkg }, targetPath: `${cpath}/SceneInteraction.kt`, cClass: "C0_emulator", note: "Register each object; broadcast select = C0, controller/gaze ray = C3 (built-for-Swan)." });
  }
  // 6b. multi-scene routing — a scene-graph state machine when there is >1 scene or any portal
  if (spec.scenes.length > 1 || spec.navigation.portals.length) {
    push({ node: "navigation", tool: "generate_scene_router_kotlin", args: { packageName: contentPkg }, targetPath: `${cpath}/SceneRouter.kt`, cClass: "C0_emulator", note: `Register a builder per scene [${spec.scenes.map((s) => s.id).join(", ")}]; start '${spec.navigation.startScene}'; transition via 'navigate:<id>' broadcast (portal/gaze activation = Swan, C3).` });
  }

  // 7. headset layer
  if (spec.headsetLayer.length) push({ node: "headset", tool: "generate_headset_readiness_codegen", args: { packageName: contentPkg }, targetPath: `${cpath}/HeadsetReadiness.kt`, cClass: "C3", note: "Guarded registry that no-ops on the emulator; lights up on Swan." });

  // 7b. THE WIRING (v6.3) — the app-defining glue, generated from the spec (was hand-authored). This is
  // what closes the ledger→running-app gap: SceneComposition.build + HomeStage SpatialView.initial + Main.
  // v15.0: pass the FULL spec — the meta-only shorthand failed generate_app_wiring's zod validation,
  // so SceneComposition/HomeStage/Main were never written in automated runs (fleet apps silently ran
  // on the scaffold template's HomeStage and spec objects never spawned).
  push({ node: "wiring", tool: "generate_app_wiring", args: { spec }, targetPath: `${cpath}/SceneComposition.kt`, cClass: "C0_emulator", note: "Emits SceneComposition.kt + HomeStage.kt + Main.kt from the spec; write all three (serial). No more hand-wiring." });

  // 8. build & run
  push({ node: "build", tool: "build_and_run", args: { projectDir, packageName: pkg }, targetPath: projectDir, cClass: "C0_emulator", note: "Require BUILD SUCCESSFUL + PID up + ready-log before reading any capture (stale-APK gotcha)." });
  return steps;
}

export function registerCompilerTools(server: McpServer) {
  server.registerTool(
    "compile_app_spec",
    {
      description:
        "Compile a validated AppSpec into an executable BUILD LEDGER: an ordered, dependency-sorted list mapping each spec node to the EXACT existing tool call (scaffold → agent bridge → per-scene environment/colliders → generate_rigidbody_kotlin [scene.physics/object.body] → lighting → layouts → SceneAnimator/Tween/Orbit [object.anim] → data binding → generate_panel_compose_kotlin [panels/live-text] → generate_game_menu_kotlin [press interactions] → interactions → scene router [multi-scene] → generate_app_wiring [emits SceneComposition/HomeStage/Main] → headset layer → build_and_run), with args pre-filled (packageName wired to <pkg>.content), the target Kotlin file, and the C-class. This is the DRIVER, not a second orchestrator: the brief_to_app prompt executes the ledger step-by-step through the real generate_*/scaffold/bake/build tools, editing files SERIALLY. Idempotent + resumable (each step names its output path). Returns the ledger + build order + integration notes.",
      inputSchema: {
        spec: z.any().describe("A validated AppSpec (from plan_app_spec)."),
        projectDir: z.string().describe("Target Android project dir to scaffold/build into, e.g. ~/AndroidStudioProjects/showcasexr-native."),
      },
    },
    async ({ spec: raw, projectDir }) => {
      const parsed = appSpecSchema.safeParse(raw);
      if (!parsed.success) return okJson({ status: "invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      const spec = parsed.data;
      const ledger = buildLedger(spec, projectDir);
      const byClass: Record<string, number> = {};
      for (const s of ledger) byClass[s.cClass] = (byClass[s.cClass] ?? 0) + 1;
      return okJson({
        status: "ok",
        appName: spec.meta.appName,
        packageName: spec.meta.packageName,
        projectDir,
        stepCount: ledger.length,
        classSummary: byClass,
        ledger,
        howToExecute: [
          "Execute steps in `order`. After each generate_* returns Kotlin, WRITE it to `targetPath` yourself (serial edits — never fan out writers).",
          "generate_app_wiring emits SceneComposition.kt + HomeStage.kt + Main.kt (the SpatialView.initial wiring, DEBUG_CMD dispatch, panel/menu attach) — write those three yourself; no hand-wiring of individual objects.",
          "For data: SceneLayout.place(root, items.size) { i -> SceneDataBinding.makeCard(items[i]) }; then SceneInteraction.register(item.id, cardEntity) { id -> showDetail(id) }.",
          "Then run the `build` step and confirm BUILD SUCCESSFUL + PID + ready-log before verify_app_spec.",
        ],
      });
    },
  );
}
