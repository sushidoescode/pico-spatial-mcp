import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { auditProjectConfig } from "./projectconfig.js";
import { defaultVaultRoot, loadVaultIndex, runVaultCheck } from "./vault.js";
import type { VaultFinding, VaultIndex } from "./vault.js";
import { sharedKnowledgeBridge } from "./knowledge.js";
import type { KnowledgeCaller, KnowledgeResult } from "./knowledge.js";

/**
 * lint.ts — v5.1 the RETAINED-LESSONS LINT ENGINE.
 *
 * Every hard-won MEMORY.md / diagnose gotcha becomes an EXECUTABLE, fixture-backed lint rule the planner
 * (and the brief_to_app loop) runs BEFORE codegen — so the loop can never repeat a solved mistake. Two tools:
 *   - preflight_lint(content, kind?) — scan emitted Kotlin / a shell command / gradle config for the known
 *     anti-patterns and return violations (ruleId, severity, line, message, fix, designRule). It merges the
 *     built-in rules with any lessons learned via record_lesson.
 *   - record_lesson(...) — append a NEW rule (pattern + message + fix) to ~/.pico-mcp/lessons.json whenever a
 *     novel diagnose resolution surfaces a fresh gotcha, growing the KB over time.
 *
 * Each built-in rule ships its OWN positive + negative fixture, so `npm run test:lint` proves every rule
 * fires on the mistake and passes clean code — the genuinely test-verifiable heart of v5.1.
 */

export type RuleKind = "kotlin" | "command" | "gradle" | "usd" | "any";
export interface LintRule {
  id: string;
  severity: "error" | "warn";
  kinds: RuleKind[];
  /** "present": fires if `pattern` matches. "conditional": fires if `when` matches AND `unless` does NOT. */
  type: "present" | "conditional";
  pattern?: RegExp;
  when?: RegExp;
  unless?: RegExp;
  message: string;
  fix: string;
  designRule?: string;
  positiveFixture: string; // MUST trigger this rule
  negativeFixture: string; // MUST NOT trigger this rule
  learned?: boolean;
}

// ── The built-in rules (one per retained gotcha) ────────────────────────────────────────────────────────
export const BUILTIN_RULES: LintRule[] = [
  {
    id: "compose-fork-direct-dependency",
    severity: "error",
    kinds: ["gradle"],
    type: "present",
    pattern: /(?:implementation|api)\s*\(\s*["']androidx\.compose\.(?:ui|foundation):/,
    message: "Direct androidx.compose dependency bypasses the PICO Spatial fork and BOM exclusions.",
    fix: "Use the PICO Spatial UI artifact and preserve the required configurations.all exclusions; audit a project directory with preflight_lint(projectDir) or verify_gradle_config.",
    positiveFixture: 'implementation("androidx.compose.ui:ui:1.7.0")',
    negativeFixture: 'implementation(libs.platform)',
  },
  {
    id: "displayColor-flat-white",
    severity: "error",
    kinds: ["kotlin", "usd"],
    type: "present",
    pattern: /\bdisplayColor\b/,
    message: "USD primvars:displayColor renders as a flat UNLIT white material — color does NOT come from displayColor.",
    fix: "Bind a real Material (author_materialx / UnlitMaterial.create().setBaseColor(Color4) / PhysicallyBasedMaterial).",
    designRule: "DESIGN.md §1 (color requires MATERIALS, never displayColor)",
    positiveFixture: 'primvars:displayColor = [(1, 0, 0)]',
    negativeFixture: "mat.setBaseColor(Color4(1f, 0f, 0f, 1f))",
  },
  {
    // v35.26 REFUTED BY MEASUREMENT (ledger com.picoagent.v35expc#4). Both earlier versions of this
    // rule are now dead. It began as an error — "mesh colliders cook nothing queryable, rayCast
    // returns 0 hits" — which v35.4 narrowed to the LOADED-asset case after a RUNTIME MeshResource
    // measured queryable. Experiment C-5 re-tested that surviving half on emulator-5554, and it does
    // not hold either. A mesh pulled off a LOADED model (ModelComponent.mesh on SM_PicoRobot_001 of
    // PICO's own pico_robot_animated.glb) cooks through BOTH createStaticMesh and createConvexMesh,
    // neither throws, the CollisionComponent reads back present, and rayCast HITS it: 548 self-hits
    // on the static shape at scale 1, 35 at scale 0.0045, 50 on the convex shape — against a
    // primitive control measuring 441 in the same cast.
    //
    // What actually bites — and what produced every "0 hits" reading, including the first cast of
    // this very experiment — is ALIGNMENT. The shape is cooked from the mesh's LOCAL vertex data and
    // placed by the COLLIDER ENTITY's transform; it does NOT inherit the source model's node
    // hierarchy. Measured, the cooked shape sat y +0.00..+0.60 ABOVE its entity origin and spanned
    // x -0.24..+0.26, so a ray aimed at the entity origin passes underneath a collider that is
    // registered and working perfectly. Scale compounds it: at the asset's own 0.0045 the entire
    // collider measured ~1.6 x 3.6 x 1.6 MILLIMETRES, which any metre-scale grid scan sweeps
    // straight past. A negative from a single ray, or from a coarse grid, is not evidence of absence.
    id: "mesh-collider-alignment",
    severity: "warn",
    kinds: ["kotlin"],
    type: "present",
    pattern: /createStaticMesh|createConvexMesh/,
    message: "Mesh collider: QUERYABLE from a RUNTIME MeshResource and from a LOADED asset alike (re-measured 2026-08-06 on emulator — createStaticMesh and createConvexMesh both answered rayCast). The real trap is ALIGNMENT: the shape is cooked from the mesh's LOCAL vertex data and positioned by the COLLIDER entity's transform, not by the source model's node hierarchy, so it commonly does not contain the entity origin and it scales with that entity — measured ~2mm across at the asset's own 0.0045 scale.",
    fix: "Do not verify with one ray aimed at the entity origin — that returns NONE against a working collider. Sweep a grid, or derive the ray from the shape's real extent. Match the collider entity's transform to the source model's, and offset it if the submesh is offset in its own space. A PRIMITIVE proxy (createBox(FULL extents) / createSphere(radius) / createCapsule(height, radius)) is still the cheapest correct answer when an approximate volume will do — triangle meshes cost far more per query. Either way a PhysicsWorldComponent on the scene root is required or nothing is queryable at all.",
    designRule: "DESIGN.md §9 (runtime physics) — refuted by ledger com.picoagent.v35expc#4",
    positiveFixture: "e.components.set(CollisionComponent(listOf(ShapeResource.createConvexMesh(mesh)), physMat()))",
    negativeFixture: "e.components.set(CollisionComponent(listOf(ShapeResource.createBox(Vector3(1f,1f,1f))), physMat()))",
  },
  {
    id: "collisioncomponent-no-arg",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /CollisionComponent\s*\(\s*\)/,
    message: "CollisionComponent has no no-arg constructor — the public ctors are 2-arg (shapes, material) and 5-arg.",
    fix: "CollisionComponent(listOf(shape), PhysicsMaterialResource(f,f,r)[, COLLIDER_FULL, COLLISION_FILTER_DEFAULT, BRIEF]).",
    designRule: "DESIGN.md §9",
    positiveFixture: "entity.components.set(CollisionComponent())",
    negativeFixture: "entity.components.set(CollisionComponent(listOf(shape), physMat()))",
  },
  {
    id: "raycast-without-physicsworld",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /\.rayCast\s*\(/,
    unless: /PhysicsWorldComponent/,
    message: "Scene.rayCast returns 0 hits unless a PhysicsWorldComponent is set on the scene root (USD colliders never become query actors).",
    fix: "Call attachPhysicsWorld(root) — root.components.set(PhysicsWorldComponent()) — on Dispatchers.Main AFTER the scene loads, before rayCast.",
    designRule: "DESIGN.md §9 (PhysicsWorldComponent REQUIRED on-device)",
    positiveFixture: "val hit = scene.rayCast(o, d, 10f, CollisionCastHitMode.NEAREST, group, null).results.firstOrNull()",
    negativeFixture: "root.components.set(PhysicsWorldComponent())\nval hit = scene.rayCast(o, d, 10f, CollisionCastHitMode.NEAREST, group, null).results.firstOrNull()",
  },
  {
    id: "menu-dispatch-missing-move-route",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /import\s+\S+\.gen\.GameMenu[\s\S]*fun dispatchDebugCommand/,
    unless: /cmd\.startsWith\("move:"\)\s*->\s*GameMenu\.nudgePanelCmd/,
    message: "This app attaches a GameMenu but dispatchDebugCommand has no move: route — the mouse bridge's panel title-drag broadcasts move:dx,dy,dz and the panel silently stays put (the com.fleet.knockdown 'menu not moveable' bug).",
    fix: 'Add `cmd.startsWith("move:") -> GameMenu.nudgePanelCmd(cmd.removePrefix("move:"))` to the dispatch when{} (generate_app_wiring emits it for menu specs since v29.4).',
    positiveFixture: 'import com.demo.app.gen.GameMenu\ninternal fun dispatchDebugCommand(cmd: String, arg: Int = 0) {\n    when {\n        cmd == "start" -> GameMenu.select(cmd)\n        else -> Log.w(TAG, cmd)\n    }\n}',
    negativeFixture: 'import com.demo.app.gen.GameMenu\ninternal fun dispatchDebugCommand(cmd: String, arg: Int = 0) {\n    when {\n        cmd == "start" -> GameMenu.select(cmd)\n        cmd.startsWith("move:") -> GameMenu.nudgePanelCmd(cmd.removePrefix("move:"))\n        else -> Log.w(TAG, cmd)\n    }\n}',
  },
  {
    id: "collisioncasthitmode-closest",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /CollisionCastHitMode\s*\.\s*CLOSEST/,
    message: "CollisionCastHitMode has no CLOSEST value — the enum is NEAREST / ALL.",
    fix: "Use CollisionCastHitMode.NEAREST (closest hit) or .ALL.",
    positiveFixture: "scene.rayCast(o, d, 10f, CollisionCastHitMode.CLOSEST, g, null)",
    negativeFixture: "scene.rayCast(o, d, 10f, CollisionCastHitMode.NEAREST, g, null)",
  },
  {
    id: "spotlight-cone-radians",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    // the balanced-paren group keeps the two sub-1.0 floats OUTSIDE nested calls like Color4(...),
    // so a tinted color ending in 0.x components can't false-fire; optional trailing bool = 6-arg ctor
    pattern: /SpotLightComponent\s*\((?:[^();\n]|\([^()]*\))*,\s*0\.\d+f\s*,\s*0\.\d+f\s*(?:,\s*(?:true|false)\s*)?\)/,
    message: "SpotLightComponent inner/outer cone angles are DEGREES (agent-vault: 'measured in degrees'; sample 15f/30f). Sub-1.0 values are a radians smell — a <1° cone lights nothing.",
    fix: "Pass degrees: e.g. SpotLightComponent(color, lumens, radius, 26f, 40f).",
    designRule: "agent-vault com.pico.spatial.core.ecs.md (SpotLightComponent innerAngle/outerAngle, 2026-07-12 vault audit)",
    positiveFixture: "spot.components.set(SpotLightComponent(Color4(0.9f, 0.95f, 1f, 1f), 1300f, 6f, 0.45f, 0.7f, true))",
    negativeFixture: "spot.components.set(SpotLightComponent(Color4(1f, 0.95f, 0.9f, 0.8f), 1300f, 6f, 26f, 40f))",
  },
  {
    id: "physics-ccd-continuous",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /CollisionDetectionMode\s*\.\s*CONTINUOUS/,
    message: "CollisionDetectionMode.CONTINUOUS silently KILLS dynamic-vs-dynamic contacts on the emulator adapter — a fast ball glides through pins undeflected (verified v8.8).",
    fix: "Stay on DISCRETE (the default) — at 8 m/s vs capsule pins it still strikes reliably.",
    designRule: "physics rulebook R4 (v8.8, examples/BowlingGame.kt)",
    positiveFixture: "RigidBodyComponent(MassProperties(5f), RigidBodyMode.DYNAMIC).apply { collisionDetectionMode = CollisionDetectionMode.CONTINUOUS }",
    negativeFixture: "RigidBodyComponent(MassProperties(5f), RigidBodyMode.DYNAMIC).apply { linearDamping = 0.1f }",
  },
  {
    id: "physics-destroy-respawn",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /RigidBodyComponent[\s\S]*\.destroy\s*\(|\.destroy\s*\([\s\S]*RigidBodyComponent/,
    unless: /enabled\s*=\s*false/,
    message: "destroy() in a file that builds RigidBody entities: destroying individual live bodies loses collision pairing (respawns roll through everything), and destroying a physics-world root POISONS every world built after it in-process (verified v8.8).",
    fix: "Reset by DISABLING the old game root (oldRoot.enabled = false) and rebuilding a fresh root ~3s later — ScenePhysics.resetWorld() does exactly this.",
    designRule: "physics rulebook R1+R3 (v8.8, examples/BowlingGame.kt)",
    positiveFixture: "ball.destroy(true)\nval e = Entity()\ne.components.set(RigidBodyComponent(MassProperties(1f), RigidBodyMode.DYNAMIC))",
    negativeFixture: "oldRoot.enabled = false\nval e = Entity()\ne.components.set(RigidBodyComponent(MassProperties(1f), RigidBodyMode.DYNAMIC))",
  },
  {
    id: "physics-kinematic-flip",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    // v35.17 NARROWED. The old pattern matched ANY `rigidBodyMode = RigidBodyMode.X`, which also
    // caught CONSTRUCTION-time initialisation inside `RigidBodyComponent().apply { ... }` — the very
    // thing this rule's own fix line recommends ("construct bodies in their final mode"), and the
    // form PICO document (PhysicsManager.kt:140-155). The defect is mutating an ALREADY-ATTACHED
    // component, so match that: an assignment reached through the entity's component set.
    pattern: /components\s*(?:\.\s*get\s*<\s*RigidBodyComponent\s*>\s*\(\)|\[\s*RigidBodyComponent::class\.java\s*\])[\s\S]{0,80}?rigidBodyMode\s*=\s*RigidBodyMode\s*\.\s*(?:KINEMATIC|DYNAMIC)/,
    message: "Flipping rigidBodyMode on a LIVE, already-attached body is a SILENT NO-OP on the emulator adapter — kinematic-teleport patterns do nothing, and the transform-set they wrap becomes (jump/timestep) velocity that launches the body through geometry (verified v8.8).",
    fix: "Construct bodies in their final mode — RigidBodyComponent().apply { rigidBodyMode = ... } on a FRESH instance is fine and is what PICO document. To move a body: cm-scale nudges + PhysicsVelocityComponent (ScenePhysics.launch). To start/stop simulation on a live body, ADD or REMOVE the whole RigidBodyComponent (ScenePhysics.setDynamic) — that is PICO's own play loop and is a strictly weaker operation than a mode flip.",
    designRule: "physics rulebook R2 (v8.8, examples/BowlingGame.kt)",
    positiveFixture: "body.components.get<RigidBodyComponent>()?.rigidBodyMode = RigidBodyMode.KINEMATIC",
    negativeFixture: "e.components.set(RigidBodyComponent(MassProperties(1f), RigidBodyMode.KINEMATIC))\ne.components.set(RigidBodyComponent().apply { rigidBodyMode = RigidBodyMode.DYNAMIC })",
  },
  {
    id: "rotation-rotateVector",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /\.rotation\s*\.\s*rotateVector/,
    message: "TransformComponent.rotation is EulerAngles (lazy-computed) — it has no rotateVector.",
    fix: "Rotate a vector with the quaternion: transform.quaternion.rotateVector(v).",
    designRule: "DESIGN.md §10 (PICO math API)",
    positiveFixture: "val f = tc.rotation.rotateVector(Vector3(0f,0f,-1f))",
    negativeFixture: "val f = tc.quaternion.rotateVector(Vector3(0f,0f,-1f))",
  },
  {
    id: "transform-scale-property",
    severity: "warn",
    kinds: ["kotlin"],
    type: "present",
    pattern: /\.scale\s*=\s*Vector3/,
    message: "TransformComponent's mutable scale property is `scaleVector`, not `.scale`.",
    fix: "Set tc.scaleVector = Vector3(...). (Vector3 for position/scaleVector, Quat for quaternion.)",
    designRule: "DESIGN.md §10",
    positiveFixture: "tc.scale = Vector3(1.1f, 1.1f, 1.1f)",
    negativeFixture: "tc.scaleVector = Vector3(1.1f, 1.1f, 1.1f)",
  },
  {
    id: "particlecomponent-ctor",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /ParticleComponent\s*\(/,
    message: "ParticleComponent has no public constructor — an editor-authored asset auto-attaches it.",
    fix: "Drive the existing one: entity.components.get<ParticleComponent>()?.let { ... } (see generate_particle_kotlin).",
    positiveFixture: "entity.components.set(ParticleComponent(rate = 100f))",
    negativeFixture: "entity.components.get<ParticleComponent>()?.play()",
  },
  {
    id: "text-component",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    // v35.5: match a USE (constructor call or import), not a mention. The bare-word pattern fired
    // on our own doc comments explaining that TextComponent does not exist — the same false
    // positive the Material rule had, found by scanning our generators against these rules.
    pattern: /(?:^|\n)\s*import\s+\S*TextComponent\b|\bTextComponent\s*\(/,
    message: "There is no public TextComponent in SDK 0.13.3 — IN-SCENE 3D text cannot be drawn. (LIVE runtime text DOES work via a 2D panel activity — this limit is in-scene-3D only, v9.4.)",
    fix: "For in-scene 3D labels, bake text into a texture (bake_textured_model) and select it per item. For LIVE/dynamic text (HUD, scoreboards, detail) use generate_panel_compose_kotlin (a 2D panel activity auto-hosted as a floating spatial panel; DEBUG_CMD hud:<key>=<value> updates it live).",
    designRule: "DESIGN.md §1/§12",
    positiveFixture: "entity.components.set(TextComponent(\"Nebula\"))",
    negativeFixture: "// NOTE: there is no TextComponent in 0.13.3, so this bakes a texture instead\nentity.components.set(ModelComponent(mesh, UnlitMaterial.create()))",
  },
  {
    id: "raw-glb-runtime-load",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /loadSuspend\s*\(/,
    unless: /\.bundle|AssetBundle/,
    message: "Runtime-loading a raw GLB (Entity.loadSuspend(File(x.glb))) renders BLACK — gltfio's async texture loader is never driven.",
    fix: "BAKE the GLB with bake_textured_model → load the baked model from its .bundle (AssetBundle.load).",
    designRule: "diagnose: texture_black",
    positiveFixture: "val e = Entity.loadSuspend(File(ctx.filesDir, \"marble.glb\").path)",
    negativeFixture: "val bundle = AssetBundle.load(\"asset://marble.bundle\"); val e = Entity.loadSuspend(\"marble\", bundle)",
  },
  {
    id: "usd-glb-reference",
    severity: "error",
    kinds: ["usd", "kotlin"],
    type: "present",
    pattern: /references\s*=\s*@[^@]*\.glb@/,
    message: "USD has no glTF plugin — `prepend references = @x.glb@` packs an EMPTY bundle (no mesh/texture).",
    fix: "Never reference a GLB in USDA; bake_textured_model then load the baked model in Kotlin.",
    designRule: "diagnose: texture_black",
    positiveFixture: 'def "Model" ( prepend references = @marble.glb@ ) {}',
    negativeFixture: 'def "Model" ( prepend references = @marble.usda@ ) {}',
  },
  {
    id: "stage-lighting-in-mixed",
    severity: "warn",
    kinds: ["kotlin", "gradle"],
    type: "conditional",
    when: /StageEnvironmentLightingComponent/,
    unless: /FULL|PROGRESSIVE/,
    message: "StageEnvironmentLightingComponent is INACTIVE in the MIXED stage (the system IBL wins).",
    fix: "Use it only in FULL/PROGRESSIVE stage, or drive a localized IBL (generate_ibl_kotlin) instead.",
    positiveFixture: "root.components.set(StageEnvironmentLightingComponent(ktx))",
    negativeFixture: "// FULL stage\nroot.components.set(StageEnvironmentLightingComponent(ktx))",
  },
  {
    id: "dynamic-full-stage-emulator-safety",
    severity: "warn",
    kinds: ["kotlin"],
    type: "present",
    pattern: /\bspatialNavigator\s*\.\s*openStage\s*\([\s\S]{0,400}?\bStageStyle\s*\.\s*Full\b/,
    message: "Fabian verified: the dynamic Full route uses runtime stage style 2 and triggers the safety transition on the emulator.",
    fix: "Use a manifest-declared style-1 DefaultStage, and validate the opaque Full route on hardware with Safeguard configured.",
    designRule: "Space Program emulator-stage safety finding (Fabian)",
    positiveFixture: "spatialNavigator.openStage(SpatialContainers.ID_FULL, StageStyle.Full)",
    negativeFixture: "spatialNavigator.openStage(SpatialContainers.ID_MAIN, StageStyle.Mixed)",
  },
  {
    id: "defaultstage-windowcontainer-metadata",
    severity: "warn",
    kinds: ["any"],
    type: "present",
    pattern: /^(?=[\s\S]*\bfun\s+mainApp\s*\([^)]*\)[\s\S]*?\bDefaultStage\s*\{)(?=[\s\S]*android:name\s*=\s*["']pico\.spatial\.windowcontainer\.)/,
    message: "A DefaultStage app still carries pico.spatial.windowcontainer.* manifest metadata; the launch container and manifest family disagree.",
    fix: "Remove every pico.spatial.windowcontainer.* entry and keep the manifest-declared pico.spatial.stage.id plus pico.spatial.stage.style for DefaultStage.",
    designRule: "Fabian's DefaultStage manifest checklist",
    positiveFixture: "fun mainApp(scope: SpatialAppScope) = with(scope) { DefaultStage { HomeStage() } }\n<meta-data android:name=\"pico.spatial.windowcontainer.id\" android:value=\"main\" />",
    negativeFixture: "fun mainApp(scope: SpatialAppScope) = with(scope) { DefaultStage { HomeStage() } }\n<meta-data android:name=\"pico.spatial.stage.id\" android:value=\"main\" />",
  },
  {
    id: "bundle-md5-diff",
    severity: "error",
    kinds: ["command", "kotlin"],
    type: "conditional",
    when: /md5|md5sum|shasum|sha256/,
    unless: /bundle_content_diff/,
    message: "The spatialbundle build is NON-deterministic — a raw md5/sha of a .bundle is meaningless for change detection.",
    fix: "Use bundle_content_diff (compares decoded content), never a byte-hash of the bundle.",
    positiveFixture: "md5 -q app/build/spatial/bundle/scene.bundle",
    negativeFixture: "bundle_content_diff before.bundle after.bundle",
  },
  {
    id: "am-start-without-forcestop",
    severity: "warn",
    kinds: ["command"],
    type: "conditional",
    when: /am\s+start/,
    unless: /force-stop/,
    message: "Launch is flaky: a prior com.example.* spatial app owning the full-space stage makes yours exit immediately.",
    fix: "force-stop the other spatial apps first: adb shell am force-stop <pkg>; sleep 1.5; then am start.",
    designRule: "diagnose: falling_out / launch flakiness",
    positiveFixture: "adb shell am start -n com.example.showcasexr/.platform.LaunchActivity",
    negativeFixture: "adb shell am force-stop com.example.other; sleep 1.5; adb shell am start -n com.example.showcasexr/.platform.LaunchActivity",
  },
  {
    // v35.1 — from the samples-conformance diff: PICO's eight official samples carry ZERO
    // androidx.compose.material* imports across 131 files. Our own AGENTS.md forbids them too.
    // Material is a different design system: it will not pick up PicoTheme roles, will not get
    // SpatialUI hover/haptics, and drags in a Compose fork we deliberately exclude in Gradle.
    id: "compose-material-in-spatial-ui",
    severity: "error",
    kinds: ["kotlin", "gradle"],
    type: "present",
    // Matches a real import statement or a real Gradle coordinate — NOT a prose mention. A doc
    // comment that says "no Material here" must not be an error; the first draft of this rule fired
    // on the very comment that documents the ban.
    pattern: /(?:^|\n)\s*import\s+androidx\.compose\.material|["']androidx\.compose\.material3?:/,
    message: "Material/Material3 is forbidden in PICO Spatial apps — PICO's 8 official samples contain zero material imports across 131 files.",
    fix: "Use com.pico.spatial.ui.design components (Text, Button, Icon, Slider, TitleBar, windows.*) inside PicoTheme, and take colours from PicoTheme.colorScheme roles.",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (SpatialUI is mandatory; Material is forbidden)",
    positiveFixture: "import androidx.compose.material3.Text",
    negativeFixture: "// SpatialUI only — no Material here\nimport com.pico.spatial.ui.design.Text",
  },
  {
    // v35.1 — the panel generator shipped a bare `setContent { HudPanel() }` for four versions.
    // Without the provider, LocalColorScheme/LocalTypography fall back to library defaults and the
    // SpatialUI indication + snackbar host are never installed (PicoTheme.kt:53-69).
    id: "compose-setcontent-without-picotheme",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /setContent\s*\{/,
    unless: /PicoTheme\s*(\{|\.)/,
    message: "Compose content is mounted without a PicoTheme wrap — colour/type roles fall back to library defaults and SpatialUI indication + snackbar host are never provided.",
    fix: "setContent { PicoTheme { YourPanel() } } — and read colours from PicoTheme.colorScheme, sizes from PicoTheme.typography.",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (all 2D UI wrapped in PicoTheme)",
    positiveFixture: "setContentView(ComposeView(this).apply { setContent { HudPanel() } })",
    negativeFixture: "setContentView(ComposeView(this).apply { setContent { PicoTheme { HudPanel() } } })",
  },
  {
    // v35.2 — the SDK's OWN KDoc is wrong here. Scene.kt:230-231 shows
    //   EntityQueryCondition.custom { entity -> entity.name == "Player" }
    // and BOTH halves fail to compile: the factory is `customCondition` (EntityQueryCondition.kt:128),
    // and Entity exposes getName()/setName() functions (Entity.kt:1695,1716), not a `name` property —
    // Kotlin does not synthesise property syntax for a getter declared on a Kotlin class.
    // Anyone who copies that KDoc — human or agent — gets two compile errors.
    id: "entityquerycondition-custom",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /EntityQueryCondition\s*\.\s*custom\s*[({]/,
    message: "EntityQueryCondition.custom does not exist — the factory is customCondition. (The SDK's own KDoc at Scene.kt:230 has this typo.)",
    fix: "EntityQueryCondition.customCondition { entity -> ... }. Inside the predicate use entity.getName(), not entity.name. Prefer hasComponent(...) where possible: customCondition forces a full linear scan of the scene (Scene.kt:270-282).",
    positiveFixture: 'val c = EntityQueryCondition.custom { e -> e.getName() == "Player" }',
    negativeFixture: 'val c = EntityQueryCondition.customCondition { e -> e.getName() == "Player" }',
  },
  {
    // v35.2 — System has exactly one overridable member: update (System.kt:47). A grep of System.kt
    // for onRegister/onUnregister/priority/enabled returns zero hits, so these compile-fail with
    // "overrides nothing". Easy to assume from other ECS frameworks.
    id: "ecs-system-nonexistent-override",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /:\s*System\s*\(\s*\)[\s\S]*override\s+fun\s+(?:onRegister|onUnregister)\s*\(/,
    message: "PICO's ECS System has no onRegister/onUnregister/priority/enabled to override — update(SceneUpdateContext) is its only open member (System.kt:47).",
    fix: "Put setup/teardown in the registerSystem<T>()/unregisterSystem<T>() DisposableEffect that owns the system's lifetime, not in a System override.",
    positiveFixture: "class SpinSystem : System() {\n    override fun onRegister() {}\n    override fun update(context: SceneUpdateContext) {}\n}",
    negativeFixture: "class SpinSystem : System() {\n    override fun update(context: SceneUpdateContext) {}\n}",
  },
  {
    // v35.2 — the acquisition/release rule applied to ECS registration. Systems live in a single
    // GLOBAL static set (System.kt:53); a system registered and never unregistered keeps ticking
    // once per container per frame for the rest of the process.
    id: "registersystem-without-unregister",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /\bregisterSystem\s*</,
    unless: /\bunregisterSystem\s*</,
    message: "registerSystem<T>() with no matching unregisterSystem<T>() — System instances live in one global static set (System.kt:53), so the system keeps ticking for the process lifetime.",
    fix: "DisposableEffect(Unit) { registerSystem<T>(); onDispose { unregisterSystem<T>() } }",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (lifecycle cleanup is mandatory)",
    positiveFixture: "LaunchedEffect(Unit) { registerSystem<SpinSystem>() }",
    negativeFixture: "DisposableEffect(Unit) {\n    registerSystem<SpinSystem>()\n    onDispose { unregisterSystem<SpinSystem>() }\n}",
  },
  // ── v35.5: acquisition without release ────────────────────────────────────────────────────────
  // The cross-cutting finding of the samples diff. Across all of src/ our codegen emitted .close()
  // exactly ONCE (on an Android AssetFileDescriptor, not an SDK resource) and .destroy() once, while
  // 8/8 PICO samples pair every acquisition with a release — eleven pairs tabulated in the report.
  // Our own house rules already said "lifecycle cleanup is mandatory"; the generators were on the
  // wrong side of it. These rules make the omission mechanically visible.
  //
  // Each is CONDITIONAL (acquire present, release absent) so a file that does clean up stays clean,
  // and each release symbol below was confirmed to exist in 0.13.3 before being recommended — an
  // unpaired-but-uncloseable resource would otherwise send an agent chasing a method that is not there.
  {
    id: "animationresource-never-closed",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /AnimationResource\s*\.\s*(?:generate|generateWithTweenAnimation)\s*\(/,
    unless: /\.close\s*\(\s*\)/,
    message: "An AnimationResource is baked and never closed — every play() leaks one. AnimationResource extends Resource, which is Closeable (Resource.kt:24; override at AnimationResource.kt:69).",
    fix: "Retain it (private var res: AnimationResource?) and add a stop(): entity.stopAllAnimations() FIRST, then res?.close(); res = null. Never close a resource that is still playing — PICO's own comments warn about exactly that.",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (lifecycle cleanup is mandatory)",
    positiveFixture: "val res = AnimationResource.generateWithTweenAnimation(anim)\nval c = entity.playAnimation(res)",
    negativeFixture: "val res = AnimationResource.generateWithTweenAnimation(anim)\nval c = entity.playAnimation(res)\nfun stop(e: Entity) { e.stopAllAnimations(); res.close() }",
  },
  {
    id: "assetbundle-never-closed",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /AssetBundle\s*\.\s*load\s*\(/,
    unless: /\.close\s*\(\s*\)|releaseModel\s*\(/,
    message: "An AssetBundle is loaded and never released — bundles are Closeable (AssetBundle.kt:76-77, close() at :235) and hold their models until they are.",
    fix: "Release per-model with bundle.releaseModel(name) (AssetBundle.kt:213) and close the bundle in teardown. For a bundle shared by several call sites, refcount it by owner — generate_bundle_lease_kotlin emits that. (An earlier version of this line pointed at WelcomeSpace's AssetBundleManager; that refcounted manager exists only in the 6.0.0 GitHub copy, not in PICO's 0.13.3 archive, whose AssetBundle.kt is a 29-line lazy singleton.)",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (lifecycle cleanup is mandatory)",
    positiveFixture: 'val bundle = AssetBundle.load("asset://menu.bundle")\nval panel = Entity.loadSuspend("menu", bundle)',
    negativeFixture: 'val bundle = AssetBundle.load("asset://menu.bundle")\nval panel = Entity.loadSuspend("menu", bundle)\nfun dispose() { bundle.close() }',
  },
  {
    // The ownership rule for SDK resources, which is NOT "always close" and NOT "never close".
    // Resource.kt:35-42, on toGlobal(): "After turning the Resource instance into a global instance,
    // it will no longer be tied to the lifecycle of any other instance. You need to actively call
    // the close method to release the resource." So a plain Resource handed to a component is owned
    // by that component, and toGlobal() is the act that transfers ownership to the app.
    // Corroborated both ways in PICO's own 0.13.3 samples: WelcomeSpace calls material.toGlobal()
    // (FullSpaceRoomViewModel.kt:126) and closes it (:168, guarded by material.valid), while the
    // Physics sample — which never calls toGlobal — closes nothing at all.
    id: "toglobal-without-close",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /\.\s*toGlobal\s*\(\s*\)/,
    unless: /\bclose\s*\(\s*\)/,   // receiver-less close() inside apply{}/let{} counts
    message: "A Resource is made global with toGlobal() and never closed. toGlobal() detaches it from its consumer's lifecycle and makes the APP responsible for it (Resource.kt:35-42) — after that call, nothing else will ever free it.",
    fix: "Close it in teardown, guarded by valid: `res.takeIf { it.valid }?.close()` — the pairing WelcomeSpace uses (toGlobal at FullSpaceRoomViewModel.kt:126, close at :168). If you did not mean to take ownership, drop the toGlobal() call instead and let the component keep it.",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (lifecycle cleanup is mandatory)",
    positiveFixture: "val mat = UnlitMaterial.create()\nmat.toGlobal()\ne.components.set(ModelComponent(mesh, mat))",
    negativeFixture: "val mat = UnlitMaterial.create()\nmat.toGlobal()\ne.components.set(ModelComponent(mesh, mat))\nfun dispose() { if (mat.valid) mat.close() }",
  },
  {
    // Vibrant encodes its level INTO THE COLOR BITS, which is why ordinary colour maths erases it.
    // ColorVibrant.kt:33-40, verbatim: "WARNING: The vibrant info is encoded directly into the color
    // bits. Operations such as: - Animation interpolation - Gradients - Shader manipulations -
    // Android blending will destroy the encoded vibrant info."
    // There is no error and no warning at runtime: the colour simply stops adapting to the glass.
    id: "vibrant-encoding-destroyed",
    severity: "warn",
    kinds: ["kotlin"],
    // An AND of two positives (uses Vibrant AND does something that erases it), which the
    // when/unless form cannot express — so it is a `present` rule with two lookaheads.
    type: "present",
    pattern: /^(?=[\s\S]*(?:\.\s*withVibrant\s*\(|\bColor\s*\.\s*Vibrant\b))(?=[\s\S]*(?:animateColorAsState|updateTransition|Brush\s*\.\s*(?:linear|radial|sweep|vertical|horizontal)Gradient|\blerp\s*\(|\.\s*copy\s*\(\s*alpha))/,
    message: "A Vibrant-encoded colour is fed through animation, a gradient, a shader or an alpha copy. Vibrant stores its level in the colour BITS (ColorVibrant.kt:33-40), so these operations silently strip it — the colour keeps rendering, it just stops adapting to the glass.",
    fix: "Animate something other than the colour (alpha on a wrapper, or crossfade two vibrant colours), or drop Vibrant for that element and use a literal Color(0xFF…).withVibrant(Vibrant.None) — the opt-out idiom PICO use at SearchPage.kt:140. For a static tint prefer the Modifier form: Modifier.vibrantEffect(Vibrant.Neutral).",
    designRule: "PICO SpatialUI design system (vibrant materials)",
    positiveFixture: "val c = Color.Vibrant.withVibrant(Vibrant.Dark)\nval a by animateColorAsState(c)",
    negativeFixture: "val c = Color.Vibrant.withVibrant(Vibrant.Dark)\nText(\"hi\", color = c)",
  },
  {
    // PicoTheme.colorTokens is @hide + @RestrictTo(LIBRARY) (PicoTheme.kt:38-43). PICO's own sample
    // reaches for it four times and every single one is wrapped in @SuppressLint("RestrictedApi")
    // (ContentDetailPage.kt:76, :96; FeedsPage.kt:125/144; RelationshipContent.kt:118/124) — which
    // is the tell that it is not app-side API, not that suppressing it is fine.
    id: "picotheme-colortokens-restricted",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /PicoTheme\s*\.\s*colorTokens\s*\./,
    unless: /@SuppressLint\s*\(\s*"RestrictedApi"\s*\)/,
    message: "PicoTheme.colorTokens is restricted design-system internals — @hide and @RestrictTo(LIBRARY) at PicoTheme.kt:38-43. It is not app-side API and can change without notice.",
    fix: "Use the public roles instead: PicoTheme.colorScheme for colour and PicoTheme.typography for type (PicoTheme.kt:30-36). If you genuinely need a token PICO have not exposed as a role, you must annotate the call site @SuppressLint(\"RestrictedApi\") and accept that it may break on an SDK bump.",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (SpatialUI should stay app-side and public)",
    positiveFixture: "Text(\"t\", color = PicoTheme.colorTokens.LabelPrimary)",
    negativeFixture: "Text(\"t\", color = PicoTheme.colorScheme.labelPrimary)",
  },
  {
    // The INVERSE error, and the more dangerous direction: closing a resource the app does not own.
    // A leak costs memory; this crashes, and only on teardown, where it is hardest to attribute.
    // Deliberately a WARNING and deliberately narrow (named mesh/material/shape/texture locals in a
    // file with no toGlobal anywhere) — a resource closed without toGlobal is at best redundant,
    // since Resource.kt:73-83 makes every later use throw "You can't ... on a closed X".
    id: "resource-closed-without-toglobal",
    severity: "warn",
    kinds: ["kotlin"],
    type: "conditional",
    when: /\b(mesh|shape|mat|material|texture|tex)[A-Za-z0-9_]*\s*(?:\?\s*)?\.\s*close\s*\(\s*\)/i,
    unless: /\.\s*toGlobal\s*\(\s*\)/,
    message: "A mesh/material/shape/texture resource is closed in a file that never calls toGlobal(). Until toGlobal(), a Resource is tied to the lifecycle of whatever consumed it (Resource.kt:35-42) — the component owns it, so closing it here is a use-after-free rather than a cleanup.",
    fix: "Delete the close(); the ModelComponent/CollisionComponent that received it will release it. Close it ONLY if you first call toGlobal() to take ownership. PICO's Physics sample hands shapes and physics materials to components and closes neither.",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (do not invent lifecycle contracts)",
    positiveFixture: "val mesh = MeshResource.createSphere(2f)\ne.components.set(ModelComponent(mesh, mat))\nfun dispose() { mesh.close() }",
    negativeFixture: "val mesh = MeshResource.createSphere(2f)\nmesh.toGlobal()\ne.components.set(ModelComponent(mesh, mat))\nfun dispose() { mesh.close() }",
  },
  {
    // CypressMediaPlayer implements Closeable DIRECTLY — it is not a Resource, so the
    // lifecycle-tied default above never applies to it. It holds a decoder and a Surface.
    id: "mediaplayer-never-closed",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /CypressMediaPlayer\s*\(\s*\)/,
    // \bclose(), not \.close(): the teardown idiom is `player.apply { ...; close() }` (PlaybackManager
    // .kt:147-150), where the call has no receiver. Requiring the dot would fire on PICO's own sample.
    unless: /\bclose\s*\(\s*\)/,
    message: "A CypressMediaPlayer is constructed and never closed. It is Closeable but NOT a Resource, so no component will ever adopt it — the decoder and Surface stay alive until close().",
    fix: "Tear it down with unregisterCypressMediaPlayerCallback() BEFORE close(), the order PICO's own PlaybackManager.reset() uses (SpatialVideo/data/PlaybackManager.kt:147-150, called from VideoViewModel.onCleared). A callback delivered against a closed player is a teardown-only crash.",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (lifecycle cleanup is mandatory)",
    positiveFixture: "val player = CypressMediaPlayer()\nplayer.setDataSource(src)\nplayer.prepareAsync()",
    negativeFixture: "val player = CypressMediaPlayer()\nplayer.prepareAsync()\nfun release() { player.unregisterCypressMediaPlayerCallback(); player.close() }",
  },
  {
    id: "trackingmanager-never-stopped",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /\b(?:Plane|Mesh|Image|Object)TrackingManager\s*\.\s*start\s*\(\s*\)/,
    unless: /TrackingManager\s*\.\s*stop\s*\(\s*\)/,
    message: "Tracking is started and never stopped — on hardware that keeps a sensor pipeline alive for the process lifetime (battery + thermal) after the app is done with it.",
    fix: "Pair it: PlaneTrackingManager.stop() (plane/PlaneTrackingManager.kt:210) from onDispose / ON_PAUSE / onCleared. PICO pair theirs the same way (MeshScanManager.kt:57,74).",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (lifecycle cleanup is mandatory)",
    positiveFixture: "fun start() { PlaneTrackingManager.start() }",
    negativeFixture: "fun start() { PlaneTrackingManager.start() }\nfun stop() { PlaneTrackingManager.stop() }",
  },
  {
    id: "subscription-never-cancelled",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /\b(?:content|scene)\s*\.\s*subscribe\s*\(|subscribeAnchorUpdate\s*\(/,
    unless: /\.cancel\s*\(\s*\)/,
    message: "An event subscription is created and never cancelled — subscribe returns a Cancellable precisely so you can release it, and an uncancelled subscriber keeps firing into a dead scope.",
    fix: "Hold the Cancellable and cancel it in teardown: DisposableEffect(Unit) { onDispose { subscription?.cancel() } }. PICO's EventManager.kt:31,40 is the reference pair.",
    designRule: "PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md (lifecycle cleanup is mandatory)",
    positiveFixture: "subscription = content.subscribe(eventType = event, subscriber = { c -> onCollision(c) })",
    negativeFixture: "subscription = content.subscribe(eventType = event, subscriber = { c -> onCollision(c) })\nfun dispose() { subscription?.cancel() }",
  },
  {
    // v35.13 — the invisible-wall defect. A tap target with COLLIDER_FULL is a PHYSICAL obstacle:
    // CollisionResponseMode.COLLIDER_FULL "applies physical collision effects" (kt:41-46), and both
    // the target and every physics body default to COLLISION_FILTER_DEFAULT (group 1u, mask ALL),
    // which always pairs (CollisionFilter.kt:26-28,93-97). We shipped this in three generators, so
    // every selectable card in an app that also had physics was an invisible wall.
    // PICO's own spatial-tap target is TRIGGER_LITE on a private group (InteractionReceiver.kt:49-55).
    id: "interactable-collider-full",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /InteractableComponent\s*\([\s\S]{0,400}?CollisionResponseMode\.COLLIDER_FULL/,
    message: "An InteractableComponent target with CollisionResponseMode.COLLIDER_FULL is a physical obstacle — dynamic bodies bounce off your UI. Tap targets must not exchange forces.",
    fix: "Use CollisionResponseMode.TRIGGER_LITE, and scope the pair with CollisionFilter(CollisionGroup(group), CollisionGroup(mask)) — keep group on bit 0 so Scene.rayCast(..., COLLISION_GROUP_ALL, ...) still picks it, and narrow the MASK to exclude physics bodies.",
    designRule: "DESIGN.md §9 — PICO's tap target is TRIGGER_LITE (InteractionReceiver.kt:49-55)",
    positiveFixture: "entity.components.set(InteractableComponent())\nentity.components.set(CollisionComponent(listOf(shape), physMat(), CollisionResponseMode.COLLIDER_FULL, CollisionFilter.COLLISION_FILTER_DEFAULT, CollisionInfoDetailLevel.BRIEF))",
    negativeFixture: "entity.components.set(InteractableComponent())\nentity.components.set(CollisionComponent(listOf(shape), physMat(), CollisionResponseMode.TRIGGER_LITE, CollisionFilter(CollisionGroup(1u), CollisionGroup(1u)), CollisionInfoDetailLevel.BRIEF))",
  },
  {
    id: "scaffold-log-tag-drift",
    severity: "warn",
    kinds: ["command", "kotlin"],
    type: "conditional",
    when: /logcat[^\n]*-s\s+[A-Za-z0-9_]+:/,
    unless: /SpatialDemo/,
    message: "A scaffolded app keeps the log tag 'SpatialDemo' after a package rename — grep that, not the new app name.",
    fix: "Use `logcat -s SpatialDemo:V` (or grep the HomeStage/seed tag), not the renamed applicationId, for the ready-log.",
    positiveFixture: "adb logcat -s ShowcaseXR:V",
    negativeFixture: "adb logcat -s SpatialDemo:V",
  },
];

// ── learned-lesson store (~/.pico-mcp/lessons.json) ─────────────────────────────────────────────────────
const LESSONS_PATH = path.join(os.homedir(), ".pico-mcp", "lessons.json");

/**
 * v35.5 — a malformed entry used to poison EVERY lint result.
 *
 * A record with no `pattern` compiled to `new RegExp(undefined)` = `/(?:)/`, which matches any
 * string, so a single bad row turned preflight_lint into "one error on every file, with no rule id
 * to explain it". Found the honest way: the v35 conformance gate started failing across eight
 * unrelated generators with an EMPTY rule id, and the cause was a partial row in this machine's
 * ~/.pico-mcp/lessons.json — repo code was fine.
 *
 * The store is user-writable and grows over time, so it has to be treated as untrusted input: a row
 * without a usable id, pattern and message is skipped rather than allowed to fire. Skipping is the
 * right failure mode — a lost lesson is recoverable, a lint that cries wolf on every file gets the
 * whole tool ignored.
 */
function isUsableLearnedRule(r: any): boolean {
  if (!r || typeof r !== "object") return false;
  if (typeof r.id !== "string" || !r.id.trim()) return false;
  if (typeof r.pattern !== "string" || !r.pattern.trim()) return false;
  if (typeof r.message !== "string" || !r.message.trim()) return false;
  // An empty-matching regex ("", "(?:)", "^", ".*") fires on everything — never useful as a rule.
  try {
    if (new RegExp(r.pattern).test("")) return false;
  } catch {
    return false; // an invalid regex would throw at every call site
  }
  return true;
}

function loadLearned(): LintRule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isUsableLearnedRule).map((r: any) => ({
      id: r.id,
      severity: r.severity === "warn" ? "warn" : "error",
      kinds: Array.isArray(r.kinds) && r.kinds.length ? r.kinds : ["any"],
      type: "present" as const,
      pattern: new RegExp(r.pattern),
      message: r.message,
      fix: r.fix,
      designRule: r.designRule,
      positiveFixture: r.positiveFixture ?? "",
      negativeFixture: r.negativeFixture ?? "",
      learned: true,
    }));
  } catch {
    return [];
  }
}

function saveLearned(rules: LintRule[]) {
  fs.mkdirSync(path.dirname(LESSONS_PATH), { recursive: true });
  const serializable = rules.map((r) => ({
    id: r.id,
    severity: r.severity,
    kinds: r.kinds,
    pattern: r.pattern?.source ?? "",
    message: r.message,
    fix: r.fix,
    designRule: r.designRule,
    positiveFixture: r.positiveFixture,
    negativeFixture: r.negativeFixture,
  }));
  fs.writeFileSync(LESSONS_PATH, JSON.stringify(serializable, null, 2));
}

const ruleApplies = (rule: LintRule, kind: RuleKind) => kind === "any" || rule.kinds.includes("any") || rule.kinds.includes(kind);

/**
 * v35.13 — strip comments before deciding whether a rule fires.
 *
 * THREE TIMES in one wave a rule matched its own documentation: the Material rule fired on the
 * comment banning Material, the TextComponent rule fired on the comment explaining TextComponent
 * does not exist, and the interactable rule fired on the comment explaining why COLLIDER_FULL is
 * wrong. Each time the fix was to hand-tighten one regex, and each time the next rule repeated it.
 *
 * The root cause is structural, not per-rule: a lint rule describes an anti-pattern, and good code
 * DOCUMENTS the anti-pattern it is avoiding — so the more carefully a generator explains itself, the
 * more likely it is to trip its own guard. Fixing it once here beats fixing it in every rule author's
 * head. Blanking comment BODIES (rather than deleting them) preserves every byte offset and line
 * number, so reported line numbers stay exact.
 *
 * Applies to kotlin/gradle only — `command` content is shell, where # is not reliably a comment, and
 * `usd` uses # for real directives.
 */
export function stripCommentsForLint(content: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "str" | "char" = "code";
  while (i < content.length) {
    const c = content[i];
    const n = content[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === '"') { mode = "str"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += c; i++; continue; }
      out += c === "\n" ? c : " "; i++; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? c : " "; i++; continue;
    }
    // inside a string literal: keep it (a rule may legitimately match string content)
    if (c === "\\") { out += content.slice(i, i + 2); i += 2; continue; }
    if (c === '"') { mode = "code"; }
    out += c; i++;
  }
  return out;
}

/** Run all applicable rules over content. Exported so the fixture test can call it directly. */
export function runLint(content: string, kind: RuleKind = "any", rules: LintRule[] = [...BUILTIN_RULES, ...loadLearned()]) {
  const lines = content.split("\n");
  // Decide on comment-free text; report against the original so line numbers stay exact.
  const probeText = kind === "kotlin" || kind === "gradle" ? stripCommentsForLint(content) : content;
  const violations: any[] = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, kind)) continue;
    let fired = false;
    if (rule.type === "present" && rule.pattern) {
      fired = rule.pattern.test(probeText);
    } else if (rule.type === "conditional" && rule.when) {
      // NOTE the asymmetry: `when` matches comment-free text (so prose cannot TRIGGER a rule), but
      // `unless` matches the ORIGINAL (so a documented, deliberate exemption can still suppress one).
      fired = rule.when.test(probeText) && !(rule.unless && rule.unless.test(content));
    }
    if (!fired) continue;
    const probe = rule.pattern ?? rule.when;
    const lineIdx = probe ? lines.findIndex((l) => probe.test(l)) : -1;
    violations.push({
      ruleId: rule.id,
      severity: rule.severity,
      line: lineIdx >= 0 ? lineIdx + 1 : null,
      match: lineIdx >= 0 ? lines[lineIdx].trim().slice(0, 160) : null,
      message: rule.message,
      fix: rule.fix,
      ...(rule.designRule ? { designRule: rule.designRule } : {}),
      ...(rule.learned ? { learned: true } : {}),
    });
  }
  return violations;
}

// ── the advisory agent-vault symbol stage (v31: nearest-match enrichment) ───────────────────────────────

/** Plain Levenshtein — vault simple names are short, so the O(n*m) rolling-row form is plenty. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Nearest vault type by case-insensitive simple-name edit distance — capped, so a completely
 *  unrelated name gets NO suggestion rather than a fake one. */
function nearestVaultType(index: VaultIndex, simpleName: string): string | null {
  const target = simpleName.toLowerCase();
  let best: { qualifiedName: string; d: number } | null = null;
  for (const types of index.packages.values()) {
    for (const ty of types.values()) {
      const d = editDistance(target, ty.name.split(".").pop()!.toLowerCase());
      if (!best || d < best.d) best = { qualifiedName: ty.qualifiedName, d };
    }
  }
  return best && best.d <= Math.max(2, Math.ceil(target.length / 3)) ? best.qualifiedName : null;
}

/**
 * The vault-symbol pass preflight_lint runs over Kotlin: runVaultCheck plus a machine-usable
 * `nearest` vault match on each unknown-type finding (an exact simple-name hit in another package
 * first, else the smallest edit distance under the cap). ADVISORY by contract — findings are
 * warnings/info and must never gate `clean`. Exported so a fixture test can drive it against
 * test/fixtures/agent-vault without spawning the server.
 */
export function runVaultSymbolStage(content: string, index: VaultIndex): (VaultFinding & { nearest?: string })[] {
  return runVaultCheck(content, index).map((f) => {
    if (f.check !== "unknown-type") return f;
    const simple = f.symbol.split(".").pop()!;
    const exact = [...index.packages.entries()].find(([, m]) => m.has(simple));
    const nearest = exact ? `${exact[0]}.${simple}` : nearestVaultType(index, simple);
    if (!nearest) return f;
    return {
      ...f,
      nearest,
      // "declared in: ..." messages already cite the match; only the declared-nowhere case needs it
      ...(f.message.includes("no vault package declares it") ? { message: `${f.message} Nearest vault match: ${nearest}.` } : {}),
    };
  });
}

export function registerLintTools(
  server: McpServer,
  knowledgeCaller: KnowledgeCaller = sharedKnowledgeBridge,
) {
  const managedSetupGuidance = "Call ensure_pico_cli, then manually run its returned absolute path with args [\"setup\"]; the MCP never runs setup.";
  server.registerTool(
    "preflight_lint",
    {
      description:
        "Scan emitted Kotlin / a shell command / gradle config against the retained-lessons rulebook BEFORE you write or run it — so the loop never repeats a solved mistake. Catches the hard-won gotchas (displayColor flat-white, mesh-collider ALIGNMENT, rayCast without PhysicsWorldComponent, CollisionCastHitMode.CLOSEST, .rotation.rotateVector, .scale vs scaleVector, ParticleComponent ctor, TextComponent, raw-GLB runtime load, USD glTF reference, StageEnvironmentLighting in MIXED, md5 bundle diff, am start without force-stop, scaffold log-tag drift, androidx.compose.material* in a Spatial app, Compose mounted without a PicoTheme wrap) plus any lessons recorded via record_lesson. Returns violations with severity/line/message/fix/designRule. Kotlin content ALSO gets an agent-vault symbol check (import/type existence vs PICO's authoritative SDK api-reference, materialized by the CLI's separately provisioned utility payload) reported in a separate advisory `vault` block — vault findings never affect `clean` (unknown symbols come back as warnings carrying the `nearest` vault match), an absent vault degrades to managed absolute-path setup guidance, and `vaultSymbols` overrides the default (false skips the pass, true forces it for any kind). Optional `knowledgeSecondOpinion` runs only a broader query_graph lookup in a separate explicitly advisory block; it never changes `clean` or overrides vault_api exact-symbol truth. Run this tool on every generate_* output before writing the file.",
      inputSchema: {
        content: z.string().describe("The Kotlin source, shell command, or config text to lint."),
        kind: z.enum(["kotlin", "command", "gradle", "usd", "any"]).optional().describe("Restrict to rules for this kind (default 'any' = all rules)."),
        vaultSymbols: z.boolean().optional().describe("Override the advisory agent-vault symbol pass: false skips it, true forces it regardless of kind. Default: it runs for kind 'kotlin'/'any'."),
        projectDir: z.string().optional().describe("Optional Android project root for a read-only static configuration audit (Compose exclusions and container family/root consistency). Never invokes Gradle."),
        knowledgeSecondOpinion: z.string().trim().min(1).optional().describe("Optional question for a broader knowledge-graph second opinion. Advisory only: it never changes clean and never overrides vault_api exact-symbol truth."),
      },
    },
    async ({ content, kind, vaultSymbols, projectDir, knowledgeSecondOpinion }) => {
      const violations = runLint(content, kind ?? "any");
      const errors = violations.filter((v) => v.severity === "error").length;
      const warnings = violations.filter((v) => v.severity === "warn").length;
      // agent-vault symbol stage — ADVISORY, in its own block: never touches `clean`/`violations`
      // (vault findings are index lookups, not verified past failures; a vault gap must not stall the loop)
      let vault: any = { status: "skipped" };
      const wantVault = vaultSymbols ?? ((kind ?? "any") === "kotlin" || (kind ?? "any") === "any");
      if (vaultSymbols === false) {
        vault = { status: "skipped", note: "agent-vault symbol pass disabled by vaultSymbols:false." };
      } else if (wantVault) {
        const index = loadVaultIndex();
        if (!index) {
          vault = { status: "unavailable", note: `agent-vault not found (default ${defaultVaultRoot()}, override with PICO_AGENT_VAULT) — SDK symbol validation skipped. ${managedSetupGuidance}` };
        } else {
          const findings = runVaultSymbolStage(content, index);
          vault = {
            status: "ok",
            sdkVersion: index.sdkVersion,
            typesIndexed: index.typeCount,
            findings,
            note: findings.length
              ? "ADVISORY agent-vault findings — each is an unresolved symbol (with the nearest vault match when one exists), unknown enum value/constant, or constructor-arity mismatch, with the authoritative vault declaration cited. Check the citation (vault_api gives the full signature) before writing; ui.* composables are not validated."
              : "Emitted SDK usage resolves against the agent-vault api-reference (types, enum values, ctor arity; ui.* composables not validated).",
          };
        }
      }
      const projectConfig = projectDir ? auditProjectConfig(projectDir) : null;
      const projectErrors = projectConfig?.static.errors.length ?? 0;
      const clean = violations.length === 0 && projectErrors === 0;
      let knowledge: {
        advisory: true;
        authority: "context-only";
        query: string;
        result: KnowledgeResult;
        note: string;
      } | undefined;
      if (knowledgeSecondOpinion !== undefined) {
        let result: KnowledgeResult;
        try {
          result = await knowledgeCaller.call("query_graph", { question: knowledgeSecondOpinion });
        } catch (error) {
          result = {
            status: "unavailable",
            action: "query_graph",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        knowledge = {
          advisory: true,
          authority: "context-only",
          query: knowledgeSecondOpinion,
          result,
          note: "ADVISORY broader graph context only — this block never changes clean. vault_api remains authoritative for exact SDK declarations and file/line citations.",
        };
      }
      return okJson({
        clean,
        counts: { errors, warnings, projectErrors },
        violations,
        vault,
        ...(projectConfig ? { projectConfig } : {}),
        ...(knowledge ? { knowledge } : {}),
        note: errors || projectErrors ? "FIX every error before writing/running this — each is a verified past failure or a source-grounded project configuration issue." : warnings ? "Warnings are strong reminders; confirm they don't apply." : "Clean against the retained-lessons rulebook.",
      });
    },
  );

  server.registerTool(
    "record_lesson",
    {
      description:
        "Append a NEW retained-lessons lint rule after diagnose resolves a novel failure — grow the rulebook so the mistake can never recur. Persists to ~/.pico-mcp/lessons.json; preflight_lint picks it up immediately. Provide a regex that detects the anti-pattern plus a positive fixture (must trigger) and a negative fixture (must not) so the rule stays test-backed.",
      inputSchema: {
        id: z.string().describe("Unique kebab-case rule id, e.g. 'my-new-gotcha'."),
        pattern: z.string().describe("A JS regex source string that detects the anti-pattern."),
        message: z.string().describe("What's wrong (the verified failure)."),
        fix: z.string().describe("The concrete fix."),
        severity: z.enum(["error", "warn"]).optional().describe("Default 'error'."),
        kinds: z.array(z.enum(["kotlin", "command", "gradle", "usd", "any"])).optional().describe("Which content kinds this applies to (default ['any'])."),
        designRule: z.string().optional().describe("The DESIGN.md rule / diagnose symptom it maps to."),
        positiveFixture: z.string().optional().describe("A sample that MUST trigger the rule."),
        negativeFixture: z.string().optional().describe("A sample that MUST NOT trigger the rule."),
      },
    },
    async ({ id, pattern, message, fix, severity, kinds, designRule, positiveFixture, negativeFixture }) => {
      // validate the regex + fixtures before persisting
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e: any) {
        return okJson({ status: "invalid", error: `bad regex: ${e.message}` });
      }
      if (positiveFixture && !re.test(positiveFixture)) return okJson({ status: "invalid", error: "positiveFixture does not match the pattern" });
      if (negativeFixture && re.test(negativeFixture)) return okJson({ status: "invalid", error: "negativeFixture matches the pattern (it should not)" });
      const learned = loadLearned().filter((r) => r.id !== id);
      const rule: LintRule = {
        id,
        severity: severity ?? "error",
        kinds: (kinds && kinds.length ? kinds : ["any"]) as RuleKind[],
        type: "present",
        pattern: re,
        message,
        fix,
        designRule,
        positiveFixture: positiveFixture ?? "",
        negativeFixture: negativeFixture ?? "",
        learned: true,
      };
      learned.push(rule);
      saveLearned(learned);
      return okJson({ status: "recorded", id, totalLearned: learned.length, path: LESSONS_PATH });
    },
  );
}
