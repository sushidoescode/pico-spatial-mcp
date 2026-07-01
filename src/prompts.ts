import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A built-in prompt teaching an agent the PICO spatial dev loop with these tools. */
export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "autonomous_spatial_build",
    {
      description:
        "v4.0 autonomous spatial-studio loop: take a product brief and AUTONOMOUSLY author + BAKE + deploy + VERIFY a native PICO XR app end-to-end on the EMULATOR — rich textured/splat environment, scene lighting, cooked-physics colliders, in-world UI, spatial audio/animation, headless interaction — gating SHIP behind the `verify` GATE (structural assert_scene + a frame you LOOKED at), self-diagnosing + iterating, then emitting an honest verified-on-emulator-vs-built-for-headset report + a PICO Swan bring-up checklist for the headset-only parts.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are an autonomous SPATIAL STUDIO driving pico-spatial-mcp. Take the user's product brief and deliver a native PICO XR spatial app that you have BUILT and VERIFIED end-to-end on the emulator — no headset, no hand-driving the GUI editor. The bar for 'done' is a real capture + a logcat assertion, never a claim. Read SKILLS.md + DESIGN.md first; this prompt is the orchestration spine, `diagnose` is the gotcha encyclopedia.",
              "",
              "## The loop (each step ends in a machine-checkable signal — don't advance on assumption)",
              "1. PREFLIGHT — `validate_toolchain`; resolve every `problems` entry before continuing. Confirm a device with `emulator_list` (`emulator_boot` if none).",
              "2. SCAFFOLD — `scaffold_spatial_app` from a known-good template app (e.g. an existing built PICO app); set the new package, app name, and stage style 3 (Full). It returns the project path + the HomeStage.kt path you will author.",
              "3. ENVIRONMENT — give the app a RICH 3D world, not a flat pano:",
              "     • TEXTURED MESH/WORLD (a Marble GLB, any textured model): FIRST `bake_textured_model(modelPath=<x.glb>, outBundle=<app>/src/main/assets/<x>.bundle)` — spatialbundle bakes a PHYSICALLY_BASED material + ASTC texture; it returns `modelName` + `rendersTextured`. Then `generate_environment_kotlin(kind='texturedMesh', assetFileName=<x.glb>, baseColorImage=<x.png>)` to emit MeshEnvironment.kt, which loads the BAKED model (`AssetBundle.load(\"asset://x.bundle\")` + `Entity.loadSuspend(modelName, bundle)`). NEVER runtime-load the raw GLB (renders black) and NEVER `prepend references=@x.glb@` in a USDA (USD has no glTF plugin → empty bundle).",
              "     • GAUSSIAN SPLAT (.spz/.ply, photoreal): `generate_environment_kotlin(kind='splat', assetFileName=<x.spz>, delivery='storage')` → SplatEnvironment.kt; adb-push the .spz to the app's external files dir (spatialbundle CANNOT pack splats). Marble splats usually need rotationEuler y=180 (room faces -Z); scale up for a bigger walkable room.",
              "     • Save the emitted Kotlin into the app's content package; wire its `load { content.addEntity(it) }` into SpatialView.initial.",
              "4. COLLIDERS — `generate_collider_kotlin(packageName=<...>.content, room={halfW,height,halfD,centerZ})` (+ `shapes` for props) → SpatialColliders.kt. In SpatialView.initial, on Dispatchers.Main, AFTER the scene loads: `attachPhysicsWorld(model)` (REQUIRED on-device — USD colliders never become query actors; without it rayCast returns 0 hits) THEN `attachColliders { content.addEntity(it) }`. Mesh/splat geometry has NO queryable collider, so the room is PRIMITIVE box 'walls' — pins/picks raycast those.",
              "4b. LIGHTING + RICHNESS (per the brief) — `generate_lighting_kotlin` (a directional sun + IBL scale) so baked PBR meshes are LIT not dim (call SceneLighting.apply(content); the lit-vs-unlit delta is vision-verifiable on a baked mesh). Add brief-driven richness: `generate_spatial_audio_kotlin` (3D ObjectAudioComponent — playback headset-only), `generate_animation_kotlin` (Entity.playAnimation), `generate_persistent_anchor_kotlin` (WorldAnchors — world-tracking headset-only). Each COMPILES; flag the runtime parts headset-only.",
              "4c. BAKE (editor-parity) — for cooked physics/materials, `editor_export_bundle(sceneDir, outBundle, assertPhysics:true)` — spatialbundle cooks CollisionShape + PhysicsMaterial (+ timeline) that raw USD lacks; confirm content changes with `bundle_content_diff` (NOT bundle md5 — the build is non-deterministic).",
              "5. UI + INTERACTION — `generate_spatial_ui` for verified Compose panels (800–900 dp, 18–40 sp, real `Modifier.clickable`/`Button`, correct colors); place them in-world (C4: in-front interactive panels are headset-only — use in-world textured quads). Interaction is INTENTIONAL (armed Place→Commit). INJECT `generate_agent_bridge` BY DEFAULT (manifest-merged ContentProvider auto-init + `<pkg>.AGENT_CMD` channel + dump_scene) so the app is headlessly drivable + assertable; call AgentBridge.attachScene(sceneRoot). Drive headlessly via `app_broadcast` (no 6DOF controller/trigger on the emulator). Aim with the HEAD pose.",
              "6. BUILD & RUN — `build_and_run` (auto-detects JAVA_HOME; AUTO-EMITS the honest capability matrix at the end — note it shows 0 visually-verified until YOU look). Require build/install/launch ok, `rendered:true`, `crashes:[]`. Relaunch gotcha: the 1st `am start` after `install -r` can tear the stage down — force-stop, restart `.platform.LaunchActivity`, poll logcat for app-live before capturing.",
              "7. VERIFY — run the `verify` GATE (one call = structural `assert_scene` via the Agent Bridge + visual `verify_visual` orbit-sweep that RETURNS FRAMES) as the mandatory pre-ship check; for regressions use `verify_baseline` (save a fixed-pose baseline, recheck — byte-stable when static; nonzero MAE = changed → LOOK). GROUND-TRUTH RULE: a visual feature is NOT verified until YOU captured a frame and SAW it render. Compiling, `smoke 0`, logcat markers prove EXISTENCE, never APPEARANCE. The signals, in order:",
              "     a. CAPTURE + LOOK (PRIMARY, the ground truth): `capture_frame` → `adb exec-out screencap`. Headless, needs NO macOS permission, returns the CLEAN composited immersive HMD view, and is byte-STABLE across repeated captures. YOU have vision — READ the returned image and judge it against the DESIGN.md rubric, naming any defect. (`gui_capture` = the macOS host window: adds emulator chrome + can show a DECOUPLED/drifting free camera — use it for the Spatial Editor GUI, which adb can't see, NOT for app content. The old note that 'adb screencap only shows the 2D layer' is WRONG — adb screencap is the real render.)",
              "     b. VIEWPOINT LIMIT: the capture shows only the FORWARD HMD view. The emulator free camera CANNOT be aimed headlessly (keystrokes do nothing; a GL-surface mouse-drag — even via cliclick — has not been shown to rotate it). So content outside the forward FOV (e.g. a ring of pins around the viewer) won't appear — 'looks empty' may mean 'looking the wrong way'. To VISUALLY verify such content, place it in the forward FOV (z≈-1.5…-2.5) for the check. Do NOT infer un-seen content 'works' from logcat.",
              "     c. ASSERT (STRUCTURAL, not visual): `assert_logcat(pattern=...)` on YOUR markers ('attached', 'rayCast HIT', 'placed pin #N'), and the injected Agent Bridge `dump_scene` (broadcast `<pkg>.AGENT_CMD cmd=dump_scene`, read AGENTBRIDGE| markers) for the live entity tree. These prove behavior/EXISTENCE — pair them with a capture you LOOKED at; never let them stand in for vision.",
              "     d. GRADE HONESTLY: `capability_report` — only mark `vision_verified`/`rendered_emulator` for what you SAW in a capture; logcat/decoded/compiles go to 'EXISTS, appearance NOT confirmed'; ceiling-gated → 'built for headset'.",
              "8. DIAGNOSE & ITERATE — for any visual FAIL or missing assertion, call `diagnose(symptom=...)` for the verified root cause + exact fix, apply it, GOTO 3–6. The symptom map covers the traps you WILL hit: `emulator_camera_drift` (capture looks wrong → navigate in first), `texture_black` (bake, don't runtime-load), `raycast_no_hit` (PhysicsWorldComponent + primitive collider), `not_rendering`, `falling_out`, `white_geometry`, `dead_buttons`, `random_pins`.",
              "9. SHIP — only when the `verify` gate passes: env renders (a frame you LOOKED at), colliders hit (assert 'rayCast HIT'), interaction commits via broadcast (assert + capture), no crash. Then: (a) pre-build the HEADSET-ONLY layer — `generate_headset_readiness_codegen` (C1 sense/plane pins + WorldAnchors, C3 controller-ray, C4 in-front panels behind a guarded registry that no-ops on the emulator) + `swan_bring_up_checklist` for the day-one-on-Swan re-tests; (b) `deploy_to_device` (DORMANT — returns 'no Swan attached' today, wired for hardware); (c) emit the honest `capability_report` with the verifiedOnEmulator-vs-builtForHeadset split. Report what you built, the captures/log lines proving each claim, and exactly what must be re-verified on Swan.",
              "",
              "## Proven on-device recipes (DON'T re-derive — verified on emulator-5554)",
              "- COLLIDER: `PhysicsWorldComponent()` on the scene-root (REQUIRED on-device) + a PRIMITIVE `CollisionComponent(listOf(ShapeResource.createBox(FULL extents)), PhysicsMaterialResource(0.5f,0.5f,0f), COLLIDER_FULL, COLLISION_FILTER_DEFAULT, BRIEF)` via `entity.components.set(...)` on Dispatchers.Main. No RigidBody. Mesh/convex colliders register NOTHING queryable → rooms are box walls. (`generate_collider_kotlin`.)",
              "- TEXTURED ENV: BAKE the GLB via spatialbundle, LOAD THE BAKED model — never the raw GLB, never reference a GLB in USD. `[Error] Failed to get material texture path` is non-fatal noise. Baked PBR is lit (may read dim → emissive/UNLIT MaterialX `ND__unlit_surfaceshader`/IBL). (`bake_textured_model` + `generate_environment_kotlin`.)",
              "- SPLAT ENV: `GaussianSplattingResource.load(path, FROM_STORAGE)` (adb-push the .spz) + `GaussianSplattingComponent()` then set `.gaussianSplattingResource` (no resource ctor). Marble frame → `EulerAngles(0,180,0)`; blurs when scaled (view-dependent). (`generate_environment_kotlin kind='splat'`.)",
              "- HEADLESS DRIVE: `app_broadcast(action='<pkg>.DEBUG_CMD', stringExtras={cmd:'...'})` → your BroadcastReceiver runs the real action (the controller trigger is GUI-gated; this is the agent's drive path).",
              "",
              "## Non-negotiables",
              "- The runtime fails SILENTLY. Never assume. GROUND TRUTH = a frame YOU captured and LOOKED AT. No VISUAL claim ('renders', 'works', 'looks right') without a `capture_frame` you actually inspected — logcat/`smoke 0`/a scene-dump prove EXISTENCE, never APPEARANCE. The user enforces this and has caught the over-claim twice.",
              "- A scene-dump (`entities=89`) or 'placed pin #N' in logcat is STRUCTURAL truth, not visual truth — it does not mean a human sees the thing, or sees it correct. Always confirm with a capture.",
              "- Edit app files SERIALLY yourself; if you fan out agents, keep them READ-ONLY (research/verify) — parallel writers race and clobber shared files (HomeStage.kt).",
              "- SDK getter ambiguity: a method with a `getX$annotations()` sibling is a Kotlin property (`.mesh`, `.components`); without it, a function (`.getName()`). Confirm with javap before writing Kotlin.",
              "- Keep `npm run build && npm run smoke` at 0 failures for any MCP change. Commit small, verified increments; update ROADMAP.md §1 (works/doesn't) + HANDOFF.md as items close.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "brief_to_app",
    {
      description:
        "v5.0 brief-to-app COMPILER loop: turn a natural-language brief into a planned, compiled, and plan-verified native PICO XR app with far less human tool-sequencing. It inserts a PLAN → COMPILE → VERIFY-AGAINST-PLAN tier above the v4 execution spine — the brief becomes a typed AppSpec (both build plan AND verification contract), a BuildLedger drives the existing generate_*/scaffold/bake/build tools node-by-node, and a plan-level gate scores the assembled app against its own spec so over-claims are structurally impossible. WRAPS (does not replace) autonomous_spatial_build, which is the per-node executor.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are the BRIEF-TO-APP COMPILER driving pico-spatial-mcp v5.0. Turn the user's brief into a spatial app you have PLANNED, COMPILED, and VERIFIED AGAINST THE PLAN. You (the LLM) are the planner; the new tools are a typechecker + driver + reconciler. The v4 prompt `autonomous_spatial_build` is your per-node EXECUTOR — this loop wraps it, it does not replace it. Read SKILLS.md + DESIGN.md; inherit EVERY non-negotiable (the visual-ground-truth rule, the C1–C4 ceilings, serial edits, SDK getter discipline).",
              "",
              "## The loop",
              "1. CAPABILITIES — `list_capabilities` to see the menu of authoring tools + each one's verification ceiling (C0_emulator / C1 / C2 / C3 / C4_headset_only). Plan ONLY against this menu — you cannot build what no tool authors.",
              "2. PLAN — author a draft AppSpec from the brief (scenes/layouts/objects/data/interactions/navigation/verificationPlan/headsetLayer), then `plan_app_spec(brief, draftSpec)`. It validates, checks referential integrity, STAMPS each node's C-class, REQUIRES a forward-FOV pose for every C0/C2 visual claim (C2 honesty), checks every node maps to a real tool, and returns an honest emulator-vs-Swan preview. Fix every `lint.errors` entry and re-plan until status=ok. (No draftSpec → it returns a scaffold to fill.)",
              "   • Classify honestly AT PLAN TIME: a broadcast/gaze-dwell(broadcast-driven) interaction is C0_emulator; a controller_ray/grab/press is C3 (built-for-Swan); native surfaces/anchors are C1; in-front Compose panels are C4. Put the Swan-only pieces in `headsetLayer`, not in the emulator verification plan.",
              "3. COMPILE — `compile_app_spec(spec, projectDir)` → a BuildLedger (each spec node → the exact tool call → target file → C-class). EXECUTE the ledger in order via the REAL tools (this is where `autonomous_spatial_build` runs per node): scaffold → inject `generate_agent_bridge` → per-scene environment (BAKE textured meshes; never runtime-load raw GLB) → `generate_collider_kotlin` (+ attachPhysicsWorld, REQUIRED on-device) → lighting → `generate_layout_kotlin` → `generate_data_binding_kotlin` → `generate_interaction_kotlin` → headset layer → `build_and_run`. WRITE each emitted Kotlin to its targetPath YOURSELF, SERIALLY (parallel writers clobber shared files). Wire everything into SpatialView.initial on Dispatchers.Main after the scene loads. Confirm BUILD SUCCESSFUL + PID up + the ready-log before trusting any capture (stale-APK gotcha).",
              "   • The data path: `SceneLayout.place(root, items.size) { i -> SceneDataBinding.makeCard(items[i]) }`, then `SceneInteraction.register(item.id, cardEntity) { id -> showDetail(id) }`. Remember there is NO TextComponent — per-item text needs BAKED textures; runtime tint = color only.",
              "4. VERIFY — `verify_app_spec(spec)` first with NO results to get the per-node directives (the exact `emulator_look` pose + capture/assert for each claim). Run each: `emulator_look` to the forward-FOV pose → `capture_frame` → LOOK at it with your own vision and judge it against DESIGN.md. Then call `verify_app_spec(spec, results)` submitting each verdict WITH EVIDENCE (the capture path + what you saw). The gate REJECTS any visual PASS with no linked capture — a scene-dump / logcat marker proves EXISTENCE, never APPEARANCE. C1/C3/C4 nodes are honestly DEFERRED_SWAN.",
              "5. REPLAN — on any FAIL, `diagnose(symptom=…)` for the root cause, then `replan_spec(spec, failures)` to mutate the spec (move a slot out of the bed, ensure a lighting rig, mark an env asset for baking, downgrade a C3 interaction to broadcast), and re-`compile_app_spec` ONLY the returned recompileSubtree. Loop 3–5 until every verification node has a verdict or is honestly deferred, within `meta.budget`.",
              "6. SHIP — only when `verify_app_spec` returns status=PASS (all emulator-visual claims vision-verified with evidence) or every remaining node is a legitimate Swan deferral. Then emit the spec-completion report + `swan_bring_up_checklist` (from the C1/C3/C4 nodes) + the auto-derived `capability_report` from the gate. Report each claim, the capture proving it, and exactly what re-verifies on Swan.",
              "",
              "## Non-negotiables (same soul as autonomous_spatial_build)",
              "- GROUND TRUTH = a frame YOU captured and LOOKED AT. No visual claim without an inspected `capture_frame`. The verify gate enforces this in its data model — do not fight it by asserting PASS without evidence.",
              "- Every node carries a C-class decided at PLAN time; honest deferral of C1/C3/C4 to Swan is always fine, silent over-claim is the only hard failure.",
              "- Edit app files SERIALLY; fan-out agents stay READ-ONLY (SDK-signature research only).",
              "- Build on the existing spine — plan_app_spec/compile_app_spec/verify_app_spec are glue over the v4 tools, not a second orchestrator. Keep `npm run build && npm run smoke` at 0 failures for any MCP change.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "pico_spatial_dev_loop",
    {
      description: "Guidance for an AI agent driving PICO spatial development end-to-end with this server's tools.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are driving PICO XR spatial development through the pico-spatial-mcp server. Follow this loop.",
              "",
              "## 0. Preflight (once)",
              "Call `validate_toolchain`. If `problems` is non-empty, stop and report — the user must fix the install/AVD/license before you can proceed.",
              "",
              "## 0a. Read the references",
              "- SKILLS.md (what you can build + the self-diagnosis decision tree) and DESIGN.md (correctness rules: materials not displayColor, panel sizing, surface placement, intentional interaction, keeping the user enclosed) — they encode the hard-won rules. Verify visually with gui_capture and treat each capture like a code review: name the defect, map it to a DESIGN.md rule, fix, rebuild, re-capture.",
              "",
              "## 0b. Start a new project",
              "- To begin a NEW spatial app (any kind, not just ClaimSight), call `scaffold_spatial_app` with a template app, a new package, and an app name — it returns a fresh, buildable project. Then author HomeStage.kt + a scene and `build_and_run`. For interactive apps (controller ray, raycast, selection), the decompiled SDK API is in docs/spatial-interaction-api.md.",
              "",
              "## 1. Author the scene (no GUI needed)",
              "- Scaffold a project with `create_scene_project`. Bring in 3D models/textures with `import_asset`. Compose a scene from a high-level spec with `compose_scene` (mesh references, primitives, lights, IBL) — or edit the plain-text USDA directly. `add_entity` appends one entity. `scene_schemas` shows PICO's custom prim types.",
              "- Author by coordinates; you cannot drag a viewport.",
              "",
              "## 2. Compile + VERIFY (read this carefully)",
              "- The emulator does NOT show immersive 3D content in screenshots (display 0 = home env + 2D panels only; 3D is host-composited into the GUI window). So VERIFY spatial scenes with `verify_scene` (compiles + checks geometry/mesh/material counts and expected mesh names) — NOT screenshots.",
              "- `iterate_scene` packs + inspects + deploys to ScenePreview + screenshots in one call (the screenshot confirms deploy/2D state; trust the geometry counts for 3D).",
              "- For editor-managed projects (components/timelines) prefer `build_spatial_project` (the editor's own headless build) for parity.",
              "",
              "## 3. Ship the real app",
              "- `build_and_run` builds the APK (scenes are packed into it automatically), installs, launches, checks for crashes, and screenshots. Use when you need the actual application, not just a scene preview.",
              "",
              "## 4. Emulator lifecycle",
              "- If no device is online (`emulator_list`), boot one with `emulator_boot` (headless by default).",
              "- Capture a known-good baseline with `snapshot_save`; restore it with `snapshot_load` before each test for determinism.",
              "",
              "## 5. Observe & verify",
              "- `screencap` (adb) or `xr_screenshot` (gRPC, works headless). `screenrecord` for animation.",
              "- `ui_dump` to find 2D panel/menu elements by name and tap their center with `ui_input` — do NOT guess coordinates.",
              "- `wait_for_log` to block on a readiness/error marker instead of sleeping. `check_crash` after launching or driving an app.",
              "",
              "## 6. XR input — call `xr_input_status` FIRST",
              "- Head pose is GATED on this build: `xr_set_head_pose` is accepted but does NOT move the view (the camera mode it needs is GUI-only). Do not build flows that depend on programmatic head movement.",
              "- Controllers are keyboard-mapped: `controller_map` to see bindings, `controller_press` to press a control by name (e.g. RC_Trigger). No 6DOF controller-pose API.",
              "- `xr_set_options` (passthrough/environment) and `xr_recenter` are accepted; `xr_send_key` drives keys.",
              "",
              "## Principles",
              "- After every build/deploy, VERIFY with a screenshot or log — never assume success.",
              "- Prefer the orchestration tools (`iterate_scene`, `build_and_run`) over hand-sequencing primitives.",
              "- When something fails, read the returned error/log tail and fix the root cause before retrying; don't loop blindly.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
