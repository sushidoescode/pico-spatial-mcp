import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema, type AppSpec } from "./appspec.js";
import { resolveAnchors } from "./semanticplace.js";

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

/** One host-neutral spelling for a splat's generated Kotlin filename and its adb-delivered
 * app-files filename. Absolute host paths must never leak into either runtime surface. */
export function splatAssetFileName(asset: string | undefined): string {
  const raw = (asset ?? "world.spz").split(/[\\/]/).pop() || "world.spz";
  const match = raw.match(/^(.*?)(\.(?:ply|spz))$/i);
  const sourceStem = match?.[1] ?? raw.replace(/\.[^.]*$/, "");
  const extension = (match?.[2] ?? ".spz").toLowerCase();
  const safeStem = sourceStem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+|\.+$/g, "") || "world";
  return `${safeStem}${extension}`;
}

export function buildLedger(spec: AppSpec, projectDir: string): LedgerStep[] {
  // v17.0: bake anchorTo:{label} placements into concrete transforms BEFORE any step consumes the
  // spec (the wiring step receives the resolved spec verbatim). Resolution notes surface via the
  // compile_app_spec response; unresolvable anchors leave objects untouched, never silently drop.
  spec = resolveAnchors(spec).spec;
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
    note: "Generates from the packaged skeleton by default (templateProject optional). Force-stop other com.example.* apps first (launch flakiness).",
  });
  // 2. agent bridge (headless assert channel) — always
  push({ node: "meta", tool: "generate_agent_bridge", args: { packageName: pkg }, targetPath: `${cpath}/AgentBridge.kt`, cClass: "C0_emulator", note: "SKIP this step if the scaffold template already ships agent/AgentBridge.kt (galleryxr-derived templates do); otherwise inject and call AgentBridge.attachScene(root). The bridge lives under <pkg>.agent." });

  // 2b. The flagship room profile consumes the shipped mesh primitive directly and exposes the
  // revision-41, lossless scene-snapshot producer through the same generated file. Keep this as an
  // ordinary existing-tool ledger step: the profile does not register a bespoke MCP surface.
  if (spec.roomExperience) {
    push({
      node: "room-mesh",
      tool: "generate_scene_understanding_kotlin",
      args: { packageName: contentPkg, agentBridgePackage: `${pkg}.agent` },
      targetPath: `${cpath}/SceneUnderstanding.kt`,
      cClass: "C0_emulator",
      note: "Room placement waits for consecutive UNFILTERED non-empty mesh reads, then classifies TABLE/FLOOR/WALL_ART by label from one snapshot. TABLE remains preferred; FLOOR is the explicit visible fallback. The same file registers the pico.agent-bridge.scene-snapshot schemaVersion 1 / bridgeRevision 41 producer for query_scene_anchors.",
    });
  }

  // 3. per-scene: environment → colliders → lighting
  // SceneIBL and SplatEnvironment are app-level objects. appSpecSchema guarantees scenes sharing
  // either singleton have the same effective config, so emit each shared file only once.
  let emittedIbl = false;
  let emittedSplat = false;
  for (const s of spec.scenes) {
    const env = s.environment;
    if (env.kind === "texturedMesh") {
      // v19: env.asset may be an ABSOLUTE path (a downloaded World Labs GLB) — the bundle name and
      // the runtime asset reference must use the BASENAME (an absolute path concatenated into
      // assets/ produced a mangled bake target).
      const stem = (env.asset ?? "model").split("/").pop()!.replace(/\.(glb|gltf|usdz?|usdc)$/i, "").replace(/[^A-Za-z0-9._-]/g, "_");
      push({ node: s.id, tool: "bake_textured_model", args: { modelPath: env.asset ?? "<model.glb>", outBundle: `${projectDir}/app/src/main/assets/${stem}.bundle` }, targetPath: "app/src/main/assets/", cClass: "C0_emulator", note: "The ONLY textured path — never runtime-load raw GLB." });
      push({ node: s.id, tool: "generate_environment_kotlin", args: { packageName: contentPkg, kind: "texturedMesh", assetFileName: `${stem}.glb`, baseColorImage: env.baseColorImage, ...(env.params ?? {}) }, targetPath: `${cpath}/MeshEnvironment.kt`, cClass: "C0_emulator" });
    } else if (env.kind === "splat") {
      if (!emittedSplat) {
        push({ node: s.id, tool: "generate_environment_kotlin", args: { ...(env.params ?? {}), packageName: contentPkg, kind: "splat", assetFileName: splatAssetFileName(env.asset), delivery: "storage" }, targetPath: `${cpath}/SplatEnvironment.kt`, cClass: "C0_emulator", note: "fleet delivers the .ply/.spz to the app's external files dir after install and verifies its size/hash before launch. NOTE: a splat is a BOUNDED volume — for a full surround use kind=pano (skybox)." });
        emittedSplat = true;
      }
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
    if (rig !== "none" && !(rig === "ibl" && emittedIbl)) {
      const tool = rig === "fullRig" ? "generate_full_lighting_rig_kotlin" : rig === "ibl" ? "generate_ibl_kotlin" : "generate_lighting_kotlin";
      // v14.9: every invoker (template HomeStage + generate_app_wiring) calls SceneLighting.apply —
      // the fullRig must be EMITTED under that object name (its default SceneLightingRig collides
      // with the template's bundled copy AND leaves the call site unresolved; found by the
      // spotcheck brief). ibl differs in API (SceneIBL.applyStage/applyLocal) and gets its own file.
      const lightArgs: Record<string, unknown> = { packageName: contentPkg, ...(s.lighting.params ?? {}) };
      if (rig === "fullRig") lightArgs.objectName = "SceneLighting";
      push({ node: s.id, tool, args: lightArgs, targetPath: `${cpath}/${rig === "ibl" ? "SceneIBL.kt" : "SceneLighting.kt"}`, cClass: "C0_emulator" });
      if (rig === "ibl") emittedIbl = true;
    }
  }

  // 4. layouts — SceneLayout is one app-level engine. Generate it once; generated wiring restores
  // every selected layout's full parameter set immediately before placement, so later scenes cannot
  // overwrite radius/span/center defaults in this shared file.
  const firstLayout = spec.layouts[0];
  if (firstLayout) {
    push({ node: firstLayout.id, tool: "generate_layout_kotlin", args: { packageName: contentPkg, pattern: firstLayout.pattern, count: firstLayout.count, ...(firstLayout.params ?? {}) }, targetPath: `${cpath}/SceneLayout.kt`, cClass: "C0_emulator" });
  }
  // 5. data binding
  for (const d of spec.data) {
    if (d.source === "json") push({ node: d.id, tool: "generate_data_binding_kotlin", args: { packageName: contentPkg }, targetPath: `${cpath}/SceneDataBinding.kt`, cClass: "C0_emulator", note: `Place ${d.asset ?? "data/items.json"} under app/src/main/assets/.` });
    else push({ node: d.id, tool: "generate_data_binding_kotlin", args: { packageName: contentPkg }, targetPath: `${cpath}/SceneDataBinding.kt`, cClass: "C3", note: "gated_api: network-gated; verify with one live call and flag it." });
  }
  // 5b. animation (v7.3) — an object's anim ({type:tween|orbit,...}) → SceneTween/SceneOrbit, played in the wiring
  const emittedSystemKinds = new Set<string>();
  for (const o of spec.objects) {
    const a: any = o.anim;
    // v35.9: anim.driver 'system' lowers to PICO's OWN per-frame mechanism (Component + System +
    // registerSystem) instead of our hand-rolled coroutine loop. Opt-in, because SceneAnimator is
    // the vision-verified path for runtime-built entities and we do not silently switch a proven
    // lane. Prefer 'system' for NEW work: the engine drives it, per-entity state lives on the
    // component, and there is no loop of ours to leak.
    if (a?.driver === "system") {
      const kind = a.type === "orbit" ? "orbit" : a.type === "bob" ? "bob" : a.type === "spin" ? "spin" : "custom";
      // One generated class pair is shared by every entity using that behaviour. Emitting the same
      // target twice made fleet overwrite identical files and overstated the compile-step total.
      if (emittedSystemKinds.has(kind)) continue;
      emittedSystemKinds.add(kind);
      const base = kind === "custom" ? "Behaviour" : kind[0].toUpperCase() + kind.slice(1);
      push({
        node: o.id,
        tool: "generate_ecs_system_kotlin",
        args: { packageName: `${contentPkg}.ecs`, kind, name: base },
        targetPath: `${cpath}/ecs/${base}System.kt`,
        cClass: "C0_emulator",
        note: `ECS ${kind} system (PICO's own per-frame mechanism). Also writes ${base}Component.kt. WIRING REQUIRED: attach the component per entity — entity.components.set(${base}Component(...)) — and paste the returned registration snippet (a DisposableEffect pairing registerSystem<${base}System>() with unregisterSystem) into the composable that owns the scene. The module needs the ui:foundation dependency. VERIFIED on device (ledger com.picoagent.v35expc#0): registration and per-frame ticking measured on emulator-5554. registerSystem is still a no-op unless SpatialBuild.isSpatialPlatform(), so nothing ticks under JVM/Robolectric — a green unit test is not evidence of motion. The pairing is scoped to COMPOSITION, not lifecycle: backgrounding does not unregister.`,
      });
      continue;
    }
    if (!a || (a.type !== "tween" && a.type !== "orbit")) continue;
    if (a.type === "orbit") {
      push({ node: o.id, tool: "generate_orbit_animation_kotlin", args: { packageName: contentPkg, axis: a.axis, startPosition: a.startPosition, duration: a.duration, rotationCount: a.rotationCount, loop: a.loop ?? true }, targetPath: `${cpath}/SceneOrbit.kt`, cClass: "C0_emulator", note: "Revolves each placed entity; wiring calls SceneOrbit.play(it)." });
    } else {
      push({ node: o.id, tool: "generate_tween_animation_kotlin", args: { packageName: contentPkg, property: a.property ?? "rotation", from: a.from, to: a.to, duration: a.duration, repeat: a.repeat, loop: a.loop ?? true, ease: a.ease }, targetPath: `${cpath}/SceneTween.kt`, cClass: "C0_emulator", note: "Tweens each placed entity; wiring calls SceneTween.play(it)." });
    }
  }

  // 5c. seatOn (v31) — RUNTIME surface seating: the proven v30 chain (measure_model ->
  // bake_textured_model -> generate_surface_placement_kotlin), lowered per object. Planes ARE
  // detected on the emulator (43 measured 2026-07-29), so every step is C0_emulator.
  for (const o of spec.objects) {
    const seat = o.seatOn;
    if (!seat) continue;
    const asset = seat.asset ?? "<model.glb>";
    const stem = asset.split("/").pop()!.replace(/\.(glb|gltf|usdz?|usdc)$/i, "").replace(/[^A-Za-z0-9._-]/g, "_");
    const objName = `${o.id.replace(/[^A-Za-z0-9]/g, "").replace(/^./, (c) => c.toUpperCase())}Placement`;
    push({ node: o.id, tool: "measure_model", args: { modelPath: asset }, targetPath: asset, cClass: "C0_emulator", note: "Feed the returned size into the placement step's modelSize and baseLift into its baseLift — never hand-measure." });
    push({ node: o.id, tool: "bake_textured_model", args: { modelPath: asset, outBundle: `${projectDir}/app/src/main/assets/${stem}.bundle` }, targetPath: "app/src/main/assets/", cClass: "C0_emulator", note: "The ONLY textured path — never runtime-load raw GLB. Its result names the model inside the bundle for the placement step." });
    push({
      node: o.id,
      tool: "generate_surface_placement_kotlin",
      args: {
        packageName: contentPkg,
        objectName: objName,
        bundleAsset: `asset://${stem}.bundle`,
        modelName: "<modelName from bake_textured_model result>",
        semantic: seat.semantic,
        modelSize: "<size from measure_model result>",
        baseLift: "<baseLift from measure_model result>",
      },
      targetPath: `${cpath}/${objName}.kt`,
      cClass: "C0_emulator",
      note: `Replace the <...> args from the measure/bake results before calling (loud placeholders — the tool rejects them unfilled). ${seat.offset ? `Then apply seatOn.offset [${seat.offset.join(", ")}] to the seated position by hand — the generator has no offset arg yet. ` : ""}The wiring does not auto-call seat() yet: call ${objName}.seat(sceneRoot) { sceneRoot.addChild(it) } inside SpatialView.initial after SceneComposition.build. REQUIRES Full Space (an open Stage); a WindowContainer returns 0 planes.`,
    });
  }

  // v35.16: collision events -> the SDK event bus. This is what turns a simulating scene into a
  // REACTING one; without it "ball hits pin -> score" has to be polled from the agent bridge.
  const eventScenes = spec.scenes.filter((sc: any) => (sc.physics?.events ?? []).length);
  if (eventScenes.length) {
    const events = [...new Set(eventScenes.flatMap((sc: any) => sc.physics.events as string[]))];
    push({
      node: "events",
      tool: "generate_event_subscription_kotlin",
      args: { packageName: contentPkg, collision: events },
      targetPath: `${cpath}/SceneEvents.kt`,
      cClass: "C0_emulator",
      note: `Collision events [${events.join(", ")}] on the SDK event bus. WIRING: set the SceneEvents.onCollision* callbacks and call SceneEvents.subscribe(content) inside SpatialView's initial block, then SceneEvents.unsubscribeAll() from a DisposableEffect onDispose. PRECONDITION: events fire only when at least one body in the pair is DYNAMIC — two static colliders touching report NOTHING, silently (CollisionEvents.kt:35-40); the override is PhysicsWorldComponent.kinematicCollisionReportMode, default NONE.`,
    });
  }

  // v9.4: panels -> a Compose WindowContainer with LIVE runtime text (the hybrid-app tier).
  for (const pn of (spec as any).panels ?? []) {
    // v31: placement 'world' has NO vault-confirmed world-position API for auto-hosted 2D panels —
    // compile to the dock path with the loud fallback note, never emit unverified SDK calls.
    // v35.9: 'scene' is now a REAL route, not a note. It lowers to generate_attachment_panel_kotlin
    // — Compose placed inside the SpatialView's scene graph, positioned in metres. Vision-verified
    // (ledger com.picoagent.v35attach#0). 'world' still lowers to the dock path, because
    // world-LOCKING needs AnchorComponent and remains deferred; its note points here.
    if (pn.placement?.kind === "scene") {
      const pos = pn.placement?.position ?? [0, 1.45, -1.9];
      push({
        node: pn.id,
        tool: "generate_attachment_panel_kotlin",
        args: {
          packageName: contentPkg,
          panels: [{
            id: pn.id,
            ...(pn.title ? { title: pn.title } : {}),
            ...(pn.fields?.length ? { lines: pn.fields.map((f: any) => `${f.label}: ${f.initial}`) } : {}),
            position: pos,
            ...(pn.placement?.widthDp ? { widthDp: pn.placement.widthDp } : {}),
            ...(pn.placement?.heightDp ? { heightDp: pn.placement.heightDp } : {}),
            ...(pn.placement?.faceViewer ? { faceViewer: true } : {}),
          }],
        },
        targetPath: `${cpath}/SceneAttachments.kt`,
        cClass: "C0_emulator",
        note: `IN-SCENE panel at [${pos.join(", ")}] METRES in the SpatialView's local space (vision-verified, ledger com.picoagent.v35attach#0). WIRING REQUIRED — this is not automatic: in the composable hosting SpatialView call rememberAttachmentPanelSizes(), pass it to attachments = { sceneAttachmentPanels(sizes) }, and call attachments.seatSceneAttachmentPanels(content) inside initial. The attachment entity is NOT added to the scene for you. NOT world-locking: it moves with its container; a real-room anchor still needs AnchorComponent.`,
      });
      continue;
    }
    const world = pn.placement?.kind === "world";
    const worldNote = world
      ? `IN-SCENE PLACEMENT REQUESTED${pn.placement?.position ? ` at [${pn.placement.position.join(", ")}]` : ""}: this node lowers to a docked 2D Activity, and no public API world-poses an OS-composited window — that limit is real. CORRECTED v35.2: for Compose INSIDE the 3D scene use generate_attachment_panel_kotlin (AttachmentPanel + TransformComponent, metres; public in 0.13.3). That is scene placement, not world-locking — a real-room anchor still needs AnchorComponent. `
      : "";
    const worldArg = world ? { placement: "world" } : {};
    if (pn.kind === "web") {
      push({ node: pn.id, tool: "generate_panel_compose_kotlin", args: { packageName: contentPkg, kind: "web", ...(pn.url ? { url: pn.url } : {}), ...(pn.html ? { html: pn.html } : {}), ...worldArg }, targetPath: `${cpath}/WebPanel.kt`, cClass: "C0_emulator", note: `${worldNote}WEB panel: full HTML/CSS/JS with a LIVE DOM as a spatial panel (vision-verified). Merge the returned manifestEntry (+ INTERNET permission for URLs). Show/hide: DEBUG_CMD 'panel:show'/'panel:hide' (wired by generate_app_wiring; in-app start — shell am start is refused while the Stage holds Full Space).` });
    } else {
      push({ node: pn.id, tool: "generate_panel_compose_kotlin", args: { packageName: contentPkg, title: pn.title, ...(pn.fields?.length ? { fields: pn.fields } : {}), ...worldArg }, targetPath: `${cpath}/HudPanel.kt`, cClass: "C0_emulator", note: `${worldNote}LIVE TEXT panel (2D windows composite as spatial panels). Spawns at the dock position — verify by turning the camera. Headless drive: DEBUG_CMD 'hud:<key>=<value>'; show/hide: DEBUG_CMD 'panel:show'/'panel:hide' (wired by generate_app_wiring — hide un-occludes scene captures).` });
    }
  }

  // v9.2: press interactions -> the in-world clickable GameMenu (mouse-bridge detectable).
  // v31: custom labels (interactions[].params.label / a non-builtin params.button) lower a
  // bake_menu_panel step so the panel TEXTURE renders the brief's words (labels are baked into
  // menu.bundle — they cannot change at runtime), then prefill the generator's row map.
  const press = spec.interactions.filter((i: any) => i.trigger === "press");
  if (press.length) {
    const BUILTIN = ["start", "pause", "resume", "reset"];
    // Row centres of the verified 900x680 panel — mirror menutexture.ts ROWS_Y (the bridge's
    // color-bar detection and the generator's row math both assume this layout).
    const ROWS_PX = [205, 315, 425, 535];
    const rows: Array<{ action: string; label?: string }> = [];
    for (const i of press as any[]) {
      const a = String(i.action);
      // Same inference as generate_app_wiring's menuButtons, so customActions keys line up.
      const btn = String(i.params?.button ?? (a.startsWith("launch:") ? "start" : a === "resetWorld" ? "reset" : "start"));
      if (!rows.some((r) => r.action === btn)) rows.push({ action: btn, label: i.params?.label });
    }
    const node = press.map((i: any) => i.id).join(",");
    const menuTarget = `${cpath.replace(/content$/, "gen")}/GameMenu.kt`;
    const custom = rows.some((r) => r.label || !BUILTIN.includes(r.action));
    if (custom) {
      // Pad to the 4 rows the panel texture has (appSpecSchema caps distinct buttons at 4).
      for (const b of BUILTIN) {
        if (rows.length >= 4) break;
        if (!rows.some((r) => r.action === b)) rows.push({ action: b });
      }
      const labels = rows.map((r) => r.label ?? r.action.toUpperCase().replace(/_/g, " "));
      push({ node, tool: "bake_menu_panel", args: { title: spec.meta.appName.toUpperCase(), labels, actions: rows.map((r) => r.action), outBundle: `${projectDir}/app/src/main/assets/menu.bundle` }, targetPath: "app/src/main/assets/menu.bundle", cClass: "C0_emulator", note: "CUSTOM menu labels: renders the brief's words onto the verified 4-row panel (same row layout + bar colors, so the mouse bridge still detects the bars). Needs ImageMagick + Blender + spatialbundle on the host." });
      const nonBuiltin = rows.filter((r) => !BUILTIN.includes(r.action)).map((r) => r.action);
      // v31.3: the wiring derives the DEBUG_CMD select/hover whitelist from the spec's buttons,
      // so custom actions are broadcast-drivable — the old HONEST LIMIT note is retired.
      push({ node, tool: "generate_game_menu_kotlin", args: { packageName: `${pkg}.gen`, buttons: rows.map((r, idx) => ({ action: r.action, rowPx: ROWS_PX[idx] })) }, targetPath: menuTarget, cClass: "C0_emulator", note: `Uses the bake_menu_panel bundle from the previous step. The wiring maps buttons via customActions and derives the DEBUG_CMD select/hover whitelist from these buttons, so ${nonBuiltin.length ? `non-builtin button(s) [${nonBuiltin.join(", ")}] are` : "every row is"} broadcast-drivable (--es cmd <action> / hover:<action>).` });
    } else {
      push({ node, tool: "generate_game_menu_kotlin", args: { packageName: `${pkg}.gen` }, targetPath: menuTarget, cClass: "C0_emulator", note: "Needs assets/menu.bundle (bake_textured_model of the 4-row panel, or copy a known-good one). The wiring attaches it on its own root + maps buttons via customActions; the mouse bridge clicks it. Broadcast start/pause/resume/reset also drives it." });
    }
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

  // v35.9: a multi-container app. MUST come after generate_app_wiring — that step emits a
  // DefaultStage Main.kt, and this one REPLACES it. An app has exactly one mainApp.
  const rootContainer = (spec as any).meta?.rootContainer ?? "stage";
  const secondaries = (spec as any).meta?.secondaryContainers ?? [];
  if (rootContainer !== "stage" || secondaries.length) {
    const dynamicBoundary = spec.boundaryLab?.variant === "dynamic_full";
    const loweredSecondaries = dynamicBoundary
      ? secondaries.map((container: any) => container.kind === "stage" && container.id === "dynamic-full"
        ? {
            ...container,
            content: "BoundaryFullStage()",
            contentImport: `${contentPkg}.BoundaryFullStage`,
          }
        : container)
      : secondaries;
    push({
      node: "containers",
      tool: "generate_container_app_kotlin",
      args: {
        packageName: pkg,
        root: rootContainer,
        rootContent: dynamicBoundary ? "BoundaryProbeRoot()" : "HomeStage()",
        rootContentImport: dynamicBoundary ? `${contentPkg}.BoundaryProbeRoot` : `${contentPkg}.HomeStage`,
        ...(loweredSecondaries.length ? { containers: loweredSecondaries } : {}),
      },
      targetPath: `${cpath.replace(/\/content$/, "")}/Main.kt`,
      cClass: "C0_emulator",
      note: `MULTI-CONTAINER app (${rootContainer} root${secondaries.length ? ` + ${secondaries.length} secondary` : ""}). REPLACE the Main.kt generate_app_wiring just wrote — never add it alongside, an app has exactly one mainApp. A declared container does NOT open itself: call the emitted Open*OnEnter helper from a composable inside a container. Secondary WindowContainer opening is vision-verified (ledger com.picoagent.v35expb#0); opening a secondary STAGE and cross-container Bundle delivery are unmeasured.`,
    });
  }

  // 8. build & run
  push({ node: "build", tool: "build_and_run", args: { projectDir, packageName: pkg }, targetPath: projectDir, cClass: "C0_emulator", note: "Require BUILD SUCCESSFUL + PID up + ready-log before reading any capture (stale-APK gotcha)." });
  return steps;
}

export function registerCompilerTools(server: McpServer) {
  server.registerTool(
    "compile_app_spec",
    {
      description:
        "Compile a validated AppSpec into an executable BUILD LEDGER: an ordered, dependency-sorted list mapping each spec node to the EXACT existing tool call (scaffold → agent bridge → per-scene environment/colliders → generate_rigidbody_kotlin [scene.physics/object.body] → lighting → layouts → SceneAnimator/Tween/Orbit [object.anim] / generate_ecs_system_kotlin [object.anim.driver 'system' — PICO's engine-driven Component+System] → measure_model/bake_textured_model/generate_surface_placement_kotlin [objects.seatOn — RUNTIME seating on live DETECTED planes] → data binding → generate_panel_compose_kotlin [panels/live-text, placement 'dock'] / generate_attachment_panel_kotlin [placement 'scene' — Compose INSIDE the 3D scene, positioned in metres, vision-verified; 'world' still lowers to dock because world-LOCKING needs AnchorComponent] → bake_menu_panel [custom press-button labels] + generate_game_menu_kotlin [press interactions] → interactions → scene router [multi-scene] → generate_app_wiring [emits SceneComposition/HomeStage/Main] → generate_container_app_kotlin [meta.rootContainer 'windowContainer' or meta.secondaryContainers — the WelcomeSpace multi-container shape; REPLACES the Main.kt wiring just wrote] → headset layer → build_and_run), with args pre-filled (packageName wired to <pkg>.content), the target Kotlin file, and the C-class. This is the DRIVER, not a second orchestrator: the brief_to_app prompt executes the ledger step-by-step through the real generate_*/scaffold/bake/build tools, editing files SERIALLY. Idempotent + resumable (each step names its output path). Returns the ledger + build order + integration notes.",
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
      const anchorNotes = resolveAnchors(spec).notes;
      // v31: world panel placement is a REQUEST we cannot honor yet (no vault-confirmed API) —
      // say so in the compile result, not just deep in a ledger note.
      const placementFallbacks = (spec.panels ?? [])
        .filter((p) => p.placement?.kind === "world")
        .map((p) => `panel '${p.id}': lowers to the docked 2D Activity (spawns at the dock; verify by turning the camera). No public API world-poses an OS-composited window. CORRECTED v35.2 — for Compose placed INSIDE the 3D scene, run generate_attachment_panel_kotlin alongside this; scene placement is still not world-locking (anchors remain deferred)`);
      return okJson({
        status: "ok",
        appName: spec.meta.appName,
        packageName: spec.meta.packageName,
        projectDir,
        stepCount: ledger.length,
        classSummary: byClass,
        ...(placementFallbacks.length ? { placementFallbacks } : {}),
        ...(anchorNotes.length ? { semanticPlacements: anchorNotes } : {}),
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
