import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema, type AppSpec } from "./appspec.js";
import { generateBoundaryLabFiles } from "./boundaryprobe.js";
import { generateMissionTableFiles } from "./missiontable.js";

/**
 * assemble.ts — v6.3 THE WIRING GENERATOR (closes the ledger→running-app gap).
 *
 * The adversarial audit found that the two files which actually DEFINE a running app — the per-brief
 * composition object (hand-authored as ProductShowcase/MultiSceneDemo) and the SpatialView.initial wiring
 * (hand-authored as HomeStage.kt) — had NO generator and were not even ledger steps. So "brief → running
 * app" always required hand-wiring. This module generates all three from the AppSpec, deterministically:
 *
 *   SceneComposition.kt — the build(root) body: load each data node, then either drive SceneRouter
 *                         (multi-scene) or place a layout of data-bound cards + register interactions
 *                         (single scene), plus showDetail for select. This is a pure function of the spec.
 *   HomeStage.kt        — the @Composable SpatialView(initial=...) that makes the scene root on the MAIN
 *                         thread, attaches the AgentBridge, calls SceneComposition.build, and routes
 *                         DEBUG_CMD (navigate:/select:/hover:) to the right primitive (branches emitted
 *                         only for the primitives the spec actually uses).
 *   Main.kt             — the mainApp(scope) entrypoint (DefaultStage { PicoTheme { HomeStage() } }).
 *
 * Generators stay analytical (no RNG): the same spec yields byte-identical wiring. compile_app_spec now
 * emits these as ledger steps, so the ledger covers the whole app, not just the primitives.
 */

const PAT: Record<string, string> = { wall: "WALL", grid: "GRID", arc: "ARC", shelf: "SHELF" };

function layoutForScene(spec: AppSpec, sceneId: string) {
  return spec.layouts.find((l) => l.sceneId === sceneId);
}
// The data node feeding a layout: an object with this layoutRef + a dataBindRef, resolved to the data node.
function dataForLayout(spec: AppSpec, layoutId: string | undefined) {
  if (!layoutId) return undefined;
  const obj = spec.objects.find((o) => o.layoutRef === layoutId && o.dataBindRef);
  if (obj?.dataBindRef) return spec.data.find((d) => d.id === obj.dataBindRef);
  // fallback: any json data node bound to an object in this layout
  const obj2 = spec.objects.find((o) => o.layoutRef === layoutId);
  if (obj2) return spec.data.find((d) => d.bindsTo.includes(obj2.id));
  return spec.data[0];
}
const dataVar = (id: string) => `data_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
const assetOf = (d: { asset?: string } | undefined) => d?.asset ?? "data/items.json";

// v6.5: if the object bound to a layout is a real model (source="model"), the wiring must place it with
// SceneDataBinding.makeModelCard (async baked-bundle load) instead of makeCard (tinted quad).
function objectForLayout(spec: AppSpec, layoutId: string | undefined) {
  if (!layoutId) return undefined;
  return spec.objects.find((o) => o.layoutRef === layoutId);
}
function factoryFor(spec: AppSpec, layoutId: string | undefined): "makeCard" | "makeModelCard" {
  return objectForLayout(spec, layoutId)?.source === "model" ? "makeModelCard" : "makeCard";
}
function modelScaleFor(spec: AppSpec, layoutId: string | undefined): number | null {
  const o = objectForLayout(spec, layoutId);
  if (o?.source !== "model") return null;
  const s = o.transform?.scale;
  return Array.isArray(s) && s.length ? Number(s[0]) : null;
}

// v6.6: material mode (unlit/pbr + roughness/metallic) from the layout's object.material, emitted onto
// SceneDataBinding before place() so the cards pick it up. object.material is a free record; we read
// {type:"pbr"|"unlit", roughness, metallic}.
function materialLines(spec: AppSpec, layoutId: string | undefined, indent: string): string[] {
  const m: any = objectForLayout(spec, layoutId)?.material;
  const out: string[] = [];
  if (m?.type === "pbr") out.push(`${indent}SceneDataBinding.materialMode = "pbr"`);
  if (typeof m?.roughness === "number") out.push(`${indent}SceneDataBinding.roughness = ${m.roughness}f`);
  if (typeof m?.metallic === "number") out.push(`${indent}SceneDataBinding.metallic = ${m.metallic}f`);
  return out;
}
function finiteLayoutNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
/** SceneLayout.kt is one app-level object, so every placement must restore the selected layout's
 * full parameter set before calling place(). This prevents another scene/layout generator step's
 * defaults from silently leaking into the current scene. */
function layoutConfigLines(layout: AppSpec["layouts"][number], indent: string): string[] {
  const params: any = layout.params ?? {};
  const intValue = (value: unknown, fallback: number) => Math.trunc(finiteLayoutNumber(value, fallback));
  return [
    `${indent}SceneLayout.radius = ${finiteLayoutNumber(params.radius, 2.5)}f`,
    `${indent}SceneLayout.spacing = ${finiteLayoutNumber(params.spacing, 0.6)}f`,
    `${indent}SceneLayout.columns = ${intValue(params.columns, 3)}`,
    `${indent}SceneLayout.shelves = ${intValue(params.shelves, 2)}`,
    `${indent}SceneLayout.centerY = ${finiteLayoutNumber(params.centerY, 1.4)}f`,
    `${indent}SceneLayout.centerZ = ${finiteLayoutNumber(params.centerZ, -2.5)}f`,
    `${indent}SceneLayout.arcSpanDeg = ${finiteLayoutNumber(params.arcSpanDeg, 90)}f`,
    `${indent}SceneLayout.faceUser = ${typeof params.faceUser === "boolean" ? params.faceUser : true}`,
    `${indent}SceneLayout.yawOffsetDeg = ${finiteLayoutNumber(params.yawOffsetDeg, 0)}f`,
    `${indent}SceneLayout.defaultCount = ${layout.count}`,
  ];
}
// v6.6: compose the orphaned lighting + environment tiers — the compiler generates SceneLighting.kt and
// MeshEnvironment.kt but nothing invoked them, so PBR content was unlit and backdrops never loaded.
function anyLighting(spec: AppSpec): boolean {
  return spec.scenes.some((s) => s.lighting?.rig && s.lighting.rig !== "none");
}
// v14.9: sun and fullRig are both emitted as `object SceneLighting` by the compiler ledger
// (fullRig via objectName — its default SceneLightingRig collided with the template's bundled
// copy and left call sites unresolved; found by the spotcheck brief). Only ibl differs in API.
function iblModeForScene(scene: AppSpec["scenes"][number]): "stage" | "local" | "both" | null {
  const lighting: any = scene.lighting?.rig === "ibl" ? scene.lighting : null;
  if (!lighting) return null;
  return lighting.params?.mode === "local" || lighting.params?.mode === "both" ? lighting.params.mode : "stage";
}
function sceneUsesLocalIbl(scene: AppSpec["scenes"][number]): boolean {
  const mode = iblModeForScene(scene);
  return mode === "local" || mode === "both";
}
function lightingApplyCalls(spec: AppSpec): string[] {
  const calls: string[] = [];
  if (spec.scenes.some((scene) => scene.lighting.rig === "sun" || scene.lighting.rig === "fullRig")) {
    calls.push("SceneLighting.apply(root)");
  }
  if (spec.scenes.some((scene) => {
    const mode = iblModeForScene(scene);
    return mode === "stage" || mode === "both";
  })) calls.push("SceneIBL.applyStage(root)");
  return calls;
}
/** groundShadow/shadowReceiver helpers exist only on the sun rig's SceneLighting object. */
function sunRig(scene: AppSpec["scenes"][number]): boolean {
  return scene.lighting.rig === "sun";
}
function anyTexturedEnv(spec: AppSpec): boolean {
  return spec.scenes.some((s) => s.environment?.kind === "texturedMesh" || s.environment?.kind === "splat" || s.environment?.kind === "pano");
}
// v15.1/v28.3: any layout with no data node feeding it uses procedural props. This predicate also
// controls the makeProp imports/helper, including multi-scene router builders.
function hasDataLessLayout(spec: AppSpec): boolean {
  return spec.scenes.some((scene) => {
    const layout = layoutForScene(spec, scene.id);
    return !!layout && !dataForLayout(spec, layout.id);
  });
}
// v7.3: animation — the object's anim ({type:"tween"|"orbit", ...}) plays on each placed entity.
function animFor(spec: AppSpec, layoutId: string | undefined): { type: string } | null {
  const a: any = objectForLayout(spec, layoutId)?.anim;
  // Engine-system motion is attached by its profile/runtime and must never also lower to the
  // legacy SceneOrbit coroutine merely because both routes use the word "orbit".
  return a && a.driver !== "system" && (a.type === "tween" || a.type === "orbit") ? a : null;
}
function animPlayCall(anim: { type: string } | null): string | null {
  if (!anim) return null;
  return anim.type === "orbit" ? "SceneOrbit.play" : "SceneTween.play";
}
function envLoadLine(scene: any, rootVar: string, indent: string): string | null {
  // texturedMesh = the verified baked-bundle backdrop; splat = a custom World Labs Gaussian splat world
  // (v7.1). Both load async so build() never blocks. Splat reads from the app's external files dir
  // (delivered via adb push — Android would compress a large splat in APK assets and break the loader).
  if (scene.environment?.kind === "texturedMesh") return `${indent}compScope.launch { MeshEnvironment.load { ${rootVar}.addChild(it) } }`;
  if (scene.environment?.kind === "splat") return `${indent}compScope.launch { SplatEnvironment.load(ctx?.getExternalFilesDir(null)?.absolutePath) { ${rootVar}.addChild(it) } }`;
  if (scene.environment?.kind === "pano") return `${indent}compScope.launch { SkyboxEnvironment.load { ${rootVar}.addChild(it) } }`; // FULL surround, no blob
  return null; // homeEnvProxy/procedural are no-op backdrops
}

// v9.1: REAL physics wiring — scene.physics + object.body -> ScenePhysics calls; 'launch:<id>'
// interactions -> a bodies registry + launchBody() driven from the DEBUG_CMD dispatch.
function specHasPhysics(spec: AppSpec): boolean {
  return spec.scenes.some((s: any) => s.physics) || spec.objects.some((o: any) => o.body);
}
function vec3Kt(v: number[] | undefined, dflt: [number, number, number]): string {
  const a = v && v.length === 3 ? v : dflt;
  return `Vector3(${a[0]}f, ${a[1]}f, ${a[2]}f)`;
}
function colorKt(c: number[] | undefined): string | null {
  return c && c.length === 3 ? `Color4(${c[0]}f, ${c[1]}f, ${c[2]}f, 1f)` : null;
}
function physicsBodyLines(spec: AppSpec, indent: string): string[] {
  const out: string[] = [`${indent}ScenePhysics.initWorld(root)`];
  for (const o of spec.objects as any[]) {
    if (!o.body) continue;
    const b = o.body;
    const pos = vec3Kt(o.transform?.position, [0, 1.2, -3]);
    const tint = colorKt(b.color);
    const tintArg = tint ? `, tint = ${tint}` : "";
    const mass = b.mass ?? 1;
    // v31.3: every {mode, shape} pair maps to its true helper — static capsule/sphere used to
    // silently coerce to the dynamic variant (a spec-declared static flag pole would FALL).
    // Static colliders are vault-grounded: CollisionComponent with no RigidBody accepts
    // box/sphere/capsule ShapeResources alike.
    if (b.shape === "box" && b.mode === "static") out.push(`${indent}bodies["${o.id}"] = ScenePhysics.staticBox(root, "${o.id}", ${pos}, ${vec3Kt(b.dims, [1, 0.2, 1])}${tintArg})`);
    else if (b.shape === "box") out.push(`${indent}bodies["${o.id}"] = ScenePhysics.dynamicBox(root, "${o.id}", ${pos}, ${vec3Kt(b.dims, [0.3, 0.3, 0.3])}, ${mass}f${tintArg})`);
    else if (b.shape === "sphere" && b.mode === "static") out.push(`${indent}bodies["${o.id}"] = ScenePhysics.staticSphere(root, "${o.id}", ${pos}, ${b.dims?.[0] ?? 0.15}f${tintArg})`);
    else if (b.shape === "sphere") out.push(`${indent}bodies["${o.id}"] = ScenePhysics.dynamicSphere(root, "${o.id}", ${pos}, ${b.dims?.[0] ?? 0.15}f, ${mass}f${tintArg})`);
    else if (b.mode === "static") out.push(`${indent}bodies["${o.id}"] = ScenePhysics.staticCapsule(root, "${o.id}", ${pos}, ${b.dims?.[0] ?? 0.3}f, ${b.dims?.[1] ?? 0.06}f${tintArg})`);
    else out.push(`${indent}bodies["${o.id}"] = ScenePhysics.dynamicCapsule(root, "${o.id}", ${pos}, ${b.dims?.[0] ?? 0.3}f, ${b.dims?.[1] ?? 0.06}f, ${mass}f${tintArg})`);
  }
  return out;
}
function launchVelocityMap(spec: AppSpec): Map<string, { linear: number[]; angular: number[] }> {
  const m = new Map<string, { linear: number[]; angular: number[] }>();
  for (const i of spec.interactions as any[]) {
    if (typeof i.action === "string" && i.action.startsWith("launch:")) {
      m.set(i.action.slice(7), { linear: i.params?.velocity ?? [0, 0, -8], angular: i.params?.angular ?? [-8, 0, 0] });
    }
  }
  return m;
}

function genComposition(spec: AppSpec, pkg: string): string {
  const contentPkg = `${pkg}.content`;
  const roomMission = spec.roomExperience?.kind === "swanMissionTable";
  const boundaryLab = spec.boundaryLab !== undefined;
  const multiScene = spec.scenes.length > 1 || spec.navigation.portals.length > 0;
  const hasInteractions = spec.interactions.length > 0;
  // v9.1: select/hover interactions are DATA-backed (showDetail reads SceneDataBinding.byId); a
  // launch-only physics spec has interactions but no data — emit no detail-card machinery for it.
  const hasSelect = hasInteractions && spec.data.length > 0;
  const readyMsg = multiScene
    ? `composition ready (${spec.scenes.length} scenes; start '${spec.navigation.startScene}'; navigate:<id>)`
    : `composition ready (single scene)`;

  const lighting = anyLighting(spec);
  const asyncEnv = anyTexturedEnv(spec);
  const physics = specHasPhysics(spec);
  const launches = launchVelocityMap(spec);
  const localIblBodyIds = (spec.objects as any[])
    .filter((object) => object.body && spec.scenes.some((scene) => scene.id === object.sceneId && sceneUsesLocalIbl(scene)))
    .map((object) => String(object.id));

  const lines: string[] = [];
  const needsCtx = spec.data.length > 0 || anyTexturedEnv(spec);
  lines.push(`package ${contentPkg}`, ``);
  // imports as a de-duplicated set — three feature axes (select, physics, procedural props) overlap
  const imports = new Set<string>([`import android.util.Log`, `import android.content.Context`, `import com.pico.spatial.core.ecs.Entity`]);
  if (hasSelect) {
    for (const i of [
      `import com.pico.spatial.core.ecs.ModelComponent`,
      `import com.pico.spatial.core.ecs.TransformComponent`,
      `import com.pico.spatial.core.ecs.resource.MeshResource`,
      `import com.pico.spatial.core.ecs.resource.UnlitMaterial`,
      `import com.pico.spatial.core.math.Color4`,
      `import com.pico.spatial.core.math.EulerAngles`,
      `import com.pico.spatial.core.math.Vector3`,
    ]) imports.add(i);
  }
  if (physics) {
    imports.add(`import com.pico.spatial.core.math.Color4`);
    imports.add(`import com.pico.spatial.core.math.Vector3`);
  }
  if (hasDataLessLayout(spec)) {
    for (const i of [
      `import com.pico.spatial.core.ecs.ModelComponent`,
      `import com.pico.spatial.core.ecs.resource.MeshResource`,
      `import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial`,
      `import com.pico.spatial.core.math.Color4`,
      `import com.pico.spatial.core.math.Vector3`,
    ]) imports.add(i);
  }
  if (asyncEnv) {
    for (const i of [
      `import kotlinx.coroutines.CoroutineScope`,
      `import kotlinx.coroutines.Dispatchers`,
      `import kotlinx.coroutines.SupervisorJob`,
      `import kotlinx.coroutines.launch`,
    ]) imports.add(i);
  }
  lines.push(...[...imports].sort());
  lines.push(``, `/** GENERATED by generate_app_wiring from the AppSpec — the build(root) composition. Do not hand-edit. */`);
  lines.push(`object SceneComposition {`, `    private const val TAG = "SpatialDemo"`);
  if (hasSelect) lines.push(`    private var detail: Entity? = null`);
  if (physics) lines.push(`    private val bodies = mutableMapOf<String, Entity>()`);
  if (asyncEnv) lines.push(`    private val compScope = CoroutineScope(Dispatchers.Main + SupervisorJob())`);
  // v15.1: ctx arrives as a parameter (HomeStage passes LocalContext.current.applicationContext) —
  // the previous SpatialApplication.appContext read assumed a template property that the scaffold
  // template never had; wiring must be self-contained on ANY template.
  lines.push(``, `    fun build(root: Entity, ctx: Context? = null) {`);

  // v6.6: light the scene (so PBR content renders lit, not dim) — the rig was generated but never applied.
  if (lighting) for (const lightingCall of lightingApplyCalls(spec)) lines.push(`        ${lightingCall}`);
  if (roomMission) lines.push(`        MissionTableExperience.build(root)`);
  if (boundaryLab) lines.push(`        BoundaryLabScene.build(root)`);

  // v9.1: REAL physics — world + bodies (created in ONE batch each at build, per the rulebook).
  if (physics) for (const bl of physicsBodyLines(spec, "        ")) lines.push(bl);
  if (localIblBodyIds.length) {
    const bodyRefs = localIblBodyIds.map((id) => `bodies["${id}"]`).join(", ");
    lines.push(`        SceneIBL.applyLocal(root, listOfNotNull(${bodyRefs}))`);
  }

  // load each data node
  for (const d of spec.data) {
    lines.push(`        val ${dataVar(d.id)} = ctx?.let { SceneDataBinding.loadItems(it, "${assetOf(d)}") } ?: emptyList()`);
  }

  if (multiScene) {
    lines.push(`        SceneRouter.attach(root)`);
    for (const s of spec.scenes) {
      const l = layoutForScene(spec, s.id);
      const d = dataForLayout(spec, l?.id);
      const pat = PAT[l?.pattern ?? "shelf"];
      const dv = d ? dataVar(d.id) : null;
      const factory = factoryFor(spec, l?.id);
      const scale = modelScaleFor(spec, l?.id);
      lines.push(`        SceneRouter.register("${s.id}") { c ->`);
      const env = envLoadLine(s, "c", "            ");
      if (env) lines.push(env);
      if (l) lines.push(...layoutConfigLines(l, "            "));
      const mplay = animPlayCall(animFor(spec, l?.id));
      if (dv && l) {
        for (const ml of materialLines(spec, l.id, "            ")) lines.push(ml);
        if (scale != null) lines.push(`            SceneDataBinding.modelScale = ${scale}f`);
        if (factory === "makeModelCard") {
          const loadedActions: string[] = [];
          if (mplay) loadedActions.push(`${mplay}(it)`);
          if (sceneUsesLocalIbl(s)) loadedActions.push(`SceneIBL.applyLocal(c, listOf(it))`);
          if (sunRig(s)) loadedActions.push(`SceneLighting.groundShadow(it)`);
          lines.push(loadedActions.length
            ? `            SceneDataBinding.onModelLoaded = { ${loadedActions.join("; ")} }`
            : `            SceneDataBinding.onModelLoaded = null`);
        }
        lines.push(`            val placed = SceneLayout.place(c, ${dv}.size, SceneLayout.Pattern.${pat}) { i -> SceneDataBinding.${factory}(${dv}[i]) }`);
        if (mplay && factory !== "makeModelCard") lines.push(`            placed.forEach { ${mplay}(it) }`);
        if (sceneUsesLocalIbl(s) && factory !== "makeModelCard") lines.push(`            SceneIBL.applyLocal(c, placed)`);
      } else if (l) {
        lines.push(`            val placed = SceneLayout.place(c, ${l.count ?? 3}, SceneLayout.Pattern.${pat}) { i -> makeProp(i) }`);
        if (sceneUsesLocalIbl(s)) lines.push(`            SceneIBL.applyLocal(c, placed)`);
        if (sunRig(s)) lines.push(`            placed.forEach { SceneLighting.groundShadow(it) }`);
        if (mplay) lines.push(`            placed.forEach { ${mplay}(it) }`);
      } else {
        lines.push(`            Log.w(TAG, "composition: scene '${s.id}' has no layout to place")`);
      }
      lines.push(`        }`);
    }
    lines.push(`        SceneRouter.start("${spec.navigation.startScene}")`);
  } else {
    const s = spec.scenes[0];
    const l = layoutForScene(spec, s.id);
    const d = dataForLayout(spec, l?.id);
    const pat = PAT[l?.pattern ?? "shelf"];
    const dv = d ? dataVar(d.id) : null;
    const factory = factoryFor(spec, l?.id);
    const scale = modelScaleFor(spec, l?.id);
    // v6.6: load a real backdrop (texturedMesh) if the scene has one.
    const env = envLoadLine(s, "root", "        ");
    if (env) lines.push(env);
    if (l) lines.push(...layoutConfigLines(l, "        "));
    if (dv) {
      lines.push(`        if (${dv}.isEmpty()) { Log.e(TAG, "composition: no items loaded"); return }`);
      for (const ml of materialLines(spec, l?.id, "        ")) lines.push(ml);
      if (scale != null) lines.push(`        SceneDataBinding.modelScale = ${scale}f`);
      const play = animPlayCall(animFor(spec, l?.id));
      // v7.3: for MODELS the animation must target the async-loaded child (via onModelLoaded), not the
      // container; for QUADS the placed entity IS the geometry, so play it directly after placement.
      // NOTE: quad/primitive animation is vision-verified. Loaded-MODEL rotation is BEST-EFFORT — the SDK's
      // animation does not propagate through a loaded model's node hierarchy, so nested geometry may not move.
      if (factory === "makeModelCard") {
        const loadedActions: string[] = [];
        if (play) loadedActions.push(`${play}(it)`);
        if (sceneUsesLocalIbl(s)) loadedActions.push(`SceneIBL.applyLocal(root, listOf(it))`);
        if (sunRig(s)) loadedActions.push(`SceneLighting.groundShadow(it)`);
        lines.push(loadedActions.length
          ? `        SceneDataBinding.onModelLoaded = { ${loadedActions.join("; ")} }   // target the loaded geometry, not its container`
          : `        SceneDataBinding.onModelLoaded = null`);
      }
      lines.push(`        val cards = SceneLayout.place(root, ${dv}.size, SceneLayout.Pattern.${pat}) { i -> SceneDataBinding.${factory}(${dv}[i]) }`);
      if (sceneUsesLocalIbl(s) && factory !== "makeModelCard") lines.push(`        SceneIBL.applyLocal(root, cards)`);
      // v8.5 AAA: real 3D-model props cast soft ground shadows (flat quads skip it — a flat shadow reads odd).
      if (hasSelect) {
        lines.push(`        cards.forEachIndexed { i, card ->`, `            SceneInteraction.register(${dv}[i].id, card) { id -> showDetail(root, id) }`, `        }`);
      }
      if (play && factory !== "makeModelCard") lines.push(`        cards.forEach { ${play}(it) }   // v7.3 animation`);
      lines.push(`        Log.i(TAG, "built " + cards.size + " cards")`);
    } else if (l) {
      // v15.1: a layout WITHOUT a data node places procedural PBR props (was: a warning log and a
      // black scene — briefs like studio asked for "3 hero props" with no data source and rendered
      // NOTHING; the studio black-frame defect).
      const play = animPlayCall(animFor(spec, l.id));
      lines.push(`        val props = SceneLayout.place(root, ${l.count ?? 3}, SceneLayout.Pattern.${pat}) { i -> makeProp(i) }`);
      if (sceneUsesLocalIbl(s)) lines.push(`        SceneIBL.applyLocal(root, props)`);
      if (lighting && sunRig(s)) lines.push(`        props.forEach { SceneLighting.groundShadow(it) }`);
      if (play) lines.push(`        props.forEach { ${play}(it) }`);
      lines.push(`        Log.i(TAG, "placed " + props.size + " procedural props (data-less layout)")`);
    } else if (!roomMission && !boundaryLab) {
      if (!physics) lines.push(`        Log.w(TAG, "composition: scene '${s.id}' has no layout to place")`);
      else lines.push(`        Log.i(TAG, "physics scene: " + bodies.size + " bodies")`);
    } else if (roomMission) {
      lines.push(`        Log.i(TAG, "room-aware mission installation built; TABLE/WALL_ART placement starts after attachment seating")`);
    } else {
      lines.push(`        Log.i(TAG, "Boundary Lab enclosure and four-axis gates scheduled")`);
    }
  }
  lines.push(`        Log.i(TAG, "${readyMsg}")`, `    }`);
  if (hasDataLessLayout(spec)) {
    lines.push(
      ``,
      `    /** Procedural PBR prop for data-less layouts: sphere/box/capsule cycled by index, metallic tints. */`,
      `    private fun makeProp(i: Int): Entity {`,
      `        val e = Entity()`,
      `        e.setName("prop_" + i)`,
      `        runCatching {`,
      `            val mesh = when (i % 3) {`,
      `                0 -> MeshResource.createSphere(0.22f)`,
      `                1 -> MeshResource.createBox(Vector3(0.3f, 0.3f, 0.3f))`,
      `                else -> MeshResource.createCapsule(0.44f, 0.15f) // (height, radius) — vault order`,
      `            }`,
      `            val tints = listOf(Color4(0.85f, 0.86f, 0.9f, 1f), Color4(0.93f, 0.78f, 0.45f, 1f), Color4(0.62f, 0.75f, 0.9f, 1f))`,
      `            val mat = PhysicallyBasedMaterial.create()`,
      `            mat.setBaseColor(tints[i % tints.size])`,
      `            mat.setRoughness(0.25f)`,
      `            mat.setMetallic(0.9f)`,
      `            e.components.set(ModelComponent(mesh, mat))`,
      `        }.onFailure { Log.e(TAG, "makeProp " + i + " failed: " + it.message) }`,
      `        return e`,
      `    }`,
    );
  }

  if (physics && launches.size) {
    lines.push(``, `    /** 'launch:<id>' broadcast -> the safe throw (cm nudge + velocity; motion starts on the next ~2s engine epoch). */`);
    lines.push(`    fun launchBody(id: String) {`);
    lines.push(`        val b = bodies[id] ?: run { Log.w(TAG, "launch: unknown body " + id); return }`);
    lines.push(`        when (id) {`);
    for (const [id, v] of launches) {
      lines.push(`            "${id}" -> ScenePhysics.launch(b, ${vec3Kt(v.linear, [0, 0, -8])}, ${vec3Kt(v.angular, [-8, 0, 0])})`);
    }
    lines.push(`            else -> ScenePhysics.launch(b, Vector3(0f, 0f, -8f))`);
    lines.push(`        }`, `    }`);
  }

  // showDetail (single- and multi-scene both support broadcast select of a detail card)
  if (hasSelect) {
    lines.push(
      ``,
      `    /** On select: a large detail card front-and-center, tinted to match the selected item (from JSON). */`,
      `    fun showDetail(root: Entity, id: String) {`,
      `        val item = SceneDataBinding.byId(id) ?: run { Log.w(TAG, "showDetail: unknown " + id); return }`,
      `        val e = detail ?: Entity().also { it.setName("detailCard"); root.addChild(it); detail = it }`,
      `        runCatching {`,
      `            val mesh = MeshResource.createPlane(0.72f, 0.92f, 0.02f)`,
      `            val mat = UnlitMaterial.create()`,
      `            mat.setBaseColor(item.color ?: Color4(0.9f, 0.9f, 0.9f, 1f))`,
      `            e.components.set(ModelComponent(mesh, mat))`,
      `            e.components.set(TransformComponent(Vector3(0f, 1.5f, -1.35f), EulerAngles(0f, 0f, 0f), Vector3(1f, 1f, 1f)))`,
      `            Log.i(TAG, "showDetail " + id + " shown")`,
      `        }.onFailure { Log.e(TAG, "showDetail failed: " + it.message) }`,
      `    }`,
    );
  }
  lines.push(`}`, ``);
  return lines.join("\n");
}

// v9.2: press interactions -> GameMenu buttons. button = params.button, else inferred
// (launch:* -> start, resetWorld -> reset). Returns [button, kotlinBody] pairs.
function menuButtons(spec: AppSpec): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const panels = ((spec as any).panels ?? []).some((panel: any) => panel.placement?.kind !== "scene");
  for (const i of spec.interactions as any[]) {
    if (i.trigger !== "press") continue;
    const a = String(i.action);
    const btn = i.params?.button ?? (a.startsWith("launch:") ? "start" : a === "resetWorld" ? "reset" : "start");
    let body = a.startsWith("launch:") ? `SceneComposition.launchBody("${a.slice(7)}")`
      : a === "resetWorld" ? "resetScene()"
      : a.startsWith("navigate:") ? `SceneRouter.go("${a.slice(9)}")`
      : `Log.i(TAG, "menu action ${a}")`;
    // v9.4: live-text panels track the game (bump throws on launch, READY/ROLLING status).
    if (panels && a.startsWith("launch:")) body += `; HudState.onLaunch()`;
    if (panels && a === "resetWorld") body += `; HudState.onReset()`;
    out.push([btn, body]);
  }
  return out;
}

function fullStageLifecycleLines(options: { boundaryLab: boolean; roomMission: boolean }): string[] {
  return [
    `private class FullStageWorldLifecycle(`,
    `    private val hmdTrackingProvider: HMDTrackingProvider,`,
    `) {`,
    `    private data class Disposal(`,
    `        val registrationToken: Long?,`,
    `        val sceneProviderAttached: Boolean,`,
    `        val ownedHierarchy: Entity?,`,
    `    )`,
    ``,
    `    private val lifecycleLock = Any()`,
    `    private var lifecycleGeneration = 1L`,
    `    private var disposed = false`,
    `    private var hmdStartAttempted = false`,
    `    private var hmdStarted = false`,
    `    private var sceneProviderAttached = false`,
    `    private var locomotionRegistrationToken: Long? = null`,
    `    private var lifecycleScope: CoroutineScope? = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)`,
    `    private var directGlideJob: Job? = null`,
    `    @Volatile private var spatialViewHostRef: Entity? = null`,
    `    @Volatile private var worldRootRef: Entity? = null`,
    `    @Volatile private var worldRootGeneration = 0L`,
    ``,
    `    fun createSpatialViewHost(): Entity = Entity().also { host ->`,
    `        host.setName("AgentSpatialViewHost")`,
    `        host.components.set(TransformComponent(Vector3.ZERO, Quat.identity(), Vector3(1f, 1f, 1f)))`,
    `    }`,
    ``,
    `    fun createWorldRoot(position: Vector3): Entity = Entity().also { root ->`,
    `        root.setName("AgentWorldRoot")`,
    `        root.components.set(TransformComponent(position, Quat.identity(), Vector3(1f, 1f, 1f)))`,
    `    }`,
    ``,
    `    fun start() {`,
    `        val shouldStart = synchronized(lifecycleLock) {`,
    `            if (disposed || hmdStartAttempted) false else { hmdStartAttempted = true; true }`,
    `        }`,
    `        if (!shouldStart) return`,
    `        runCatching { hmdTrackingProvider.start() }`,
    `            .onSuccess { synchronized(lifecycleLock) { if (!disposed) hmdStarted = true } }`,
    `            .onFailure { Log.e(TAG, "HMD tracking start failed: " + (it.message ?: it.javaClass.simpleName)) }`,
    `    }`,
    ``,
    `    fun mount(spatialViewHost: Entity, worldRoot: Entity) {`,
    `        start()`,
    `        val generation = synchronized(lifecycleLock) {`,
    `            check(!disposed) { "Full Stage lifecycle is disposed" }`,
    `            check(spatialViewHostRef == null && worldRootRef == null) { "Full Stage hierarchy already mounted" }`,
    `            spatialViewHostRef = spatialViewHost`,
    `            worldRootRef = worldRoot`,
    `            lifecycleGeneration`,
    `        }`,
    `        AgentBridge.attachSceneProvider("stage") { currentWorldRoot(generation) }`,
    `        synchronized(lifecycleLock) { sceneProviderAttached = true }`,
    `        var registeredToken: Long? = null`,
    `        try {`,
    `            val registrationToken = AgentBridge.registerLocomotionProducer(`,
    `                rootProvider = { currentWorldRoot(generation) },`,
    `                hmdProducer = { readHmdPose(generation) },`,
    `                producer = { request -> produceLocomotion(generation, request) },`,
    `            )`,
    `            registeredToken = registrationToken`,
    `            synchronized(lifecycleLock) {`,
    `                check(!disposed && lifecycleGeneration == generation) { "Full Stage lifecycle changed during registration" }`,
    `                locomotionRegistrationToken = registrationToken`,
    `                worldRootGeneration = registrationToken`,
    `            }`,
    `        } catch (cause: Throwable) {`,
    `            val staleToken = registeredToken`,
    `            if (staleToken != null) {`,
    `                runCatching { AgentBridge.unregisterLocomotionProducer(staleToken) }`,
    `                    .onFailure { cleanup -> cause.addSuppressed(cleanup) }`,
    `            }`,
    `            throw cause`,
    `        }`,
    `    }`,
    ``,
    `    fun currentWorldRoot(generation: Long = lifecycleGeneration): Entity? = synchronized(lifecycleLock) {`,
    `        worldRootRef?.takeIf { !disposed && lifecycleGeneration == generation }`,
    `    }`,
    ``,
    `    private fun readHmdPose(generation: Long): AgentBridge.AgentHmdPose? {`,
    `        val available = synchronized(lifecycleLock) {`,
    `            !disposed && lifecycleGeneration == generation && hmdStarted`,
    `        }`,
    `        if (!available) return null`,
    `        val readAtMonotonicNs = SystemClock.elapsedRealtimeNanos()`,
    `        val pose = hmdTrackingProvider.latestData.hmdPose`,
    `        return AgentBridge.AgentHmdPose(readAtMonotonicNs, pose.position, pose.rotation)`,
    `    }`,
    ``,
    `    private fun requestIsCurrent(generation: Long, request: AgentBridge.LocomotionRequest, root: Entity? = null): Boolean {`,
    `        val locallyCurrent = synchronized(lifecycleLock) {`,
    `            !disposed && lifecycleGeneration == generation &&`,
    `                locomotionRegistrationToken == request.generation &&`,
    `                worldRootGeneration == request.rootGenerationBefore &&`,
    `                (root == null || worldRootRef === root)`,
    `        }`,
    `        return locallyCurrent && AgentBridge.locomotionRequestIsCurrent(request.generation)`,
    `    }`,
    ``,
    `    private fun staleRegistration(): AgentBridge.AgentLocomotionResult =`,
    `        AgentBridge.AgentLocomotionResult("rejected", null, "stale_registration")`,
    ``,
    `    private suspend fun produceLocomotion(`,
    `        generation: Long,`,
    `        request: AgentBridge.LocomotionRequest,`,
    `    ): AgentBridge.AgentLocomotionResult {`,
    `        if (!requestIsCurrent(generation, request)) return staleRegistration()`,
    `        return when (request.mode) {`,
    `            "direct" -> direct(generation, request)`,
    `            "replacement" -> replacement(generation, request)`,
    `            else -> AgentBridge.AgentLocomotionResult("rejected", null, "unsupported_mode")`,
    `        }`,
    `    }`,
    ``,
    `    private suspend fun direct(`,
    `        generation: Long,`,
    `        request: AgentBridge.LocomotionRequest,`,
    `    ): AgentBridge.AgentLocomotionResult {`,
    `        val scope = synchronized(lifecycleLock) { lifecycleScope } ?: return staleRegistration()`,
    `        val glide = scope.async(start = CoroutineStart.LAZY) {`,
    `            val root = currentWorldRoot(generation) ?: error("AgentWorldRoot is unavailable")`,
    `            check(requestIsCurrent(generation, request, root)) { "stale_registration" }`,
    `            val transform = root.components.get<TransformComponent>() ?: error("AgentWorldRoot transform is unavailable")`,
    `            val start = transform.position`,
    `            if (request.glideDurationMs == 0) {`,
    `                transform.setPosition(request.target)`,
    `            } else {`,
    `                val startedAtNs = SystemClock.elapsedRealtimeNanos()`,
    `                val durationNs = request.glideDurationMs.toLong() * 1_000_000L`,
    `                while (true) {`,
    `                    currentCoroutineContext().ensureActive()`,
    `                    check(requestIsCurrent(generation, request, root)) { "stale_registration" }`,
    `                    val elapsedNs = (SystemClock.elapsedRealtimeNanos() - startedAtNs).coerceAtLeast(0L)`,
    `                    val fraction = (elapsedNs.toDouble() / durationNs.toDouble()).coerceIn(0.0, 1.0).toFloat()`,
    `                    transform.setPosition(Vector3(`,
    `                        start.x + (request.target.x - start.x) * fraction,`,
    `                        start.y + (request.target.y - start.y) * fraction,`,
    `                        start.z + (request.target.z - start.z) * fraction,`,
    `                    ))`,
    `                    if (fraction >= 1f) break`,
    `                    delay(16L)`,
    `                }`,
    `                transform.setPosition(request.target)`,
    `            }`,
    `            check(requestIsCurrent(generation, request, root)) { "stale_registration" }`,
    `            AgentBridge.AgentLocomotionResult(`,
    `                "completed",`,
    `                AgentBridge.AgentWorldPose(request.rootGenerationBefore, transform.position),`,
    `            )`,
    `        }`,
    `        val accepted = synchronized(lifecycleLock) {`,
    `            if (disposed || lifecycleGeneration != generation || directGlideJob != null) false`,
    `            else { directGlideJob = glide; true }`,
    `        }`,
    `        if (!accepted) { glide.cancel(); return staleRegistration() }`,
    `        glide.start()`,
    `        return try {`,
    `            glide.await()`,
    `        } catch (cause: CancellationException) {`,
    `            throw cause`,
    `        } catch (cause: Throwable) {`,
    `            AgentBridge.AgentLocomotionResult("failed", null, failureText(cause))`,
    `        } finally {`,
    `            synchronized(lifecycleLock) { if (directGlideJob === glide) directGlideJob = null }`,
    `        }`,
    `    }`,
    ``,
    `    private suspend fun replacement(`,
    `        generation: Long,`,
    `        request: AgentBridge.LocomotionRequest,`,
    `    ): AgentBridge.AgentLocomotionResult = withContext(Dispatchers.Main.immediate) {`,
    `        val oldRoot = currentWorldRoot(generation) ?: return@withContext staleRegistration()`,
    `        val host = synchronized(lifecycleLock) { spatialViewHostRef } ?: return@withContext staleRegistration()`,
    `        var candidate: Entity? = null`,
    `        val movedChildren = mutableListOf<Entity>()`,
    `        var published = false`,
    `        try {`,
    `            check(requestIsCurrent(generation, request, oldRoot)) { "stale_registration" }`,
    `            val created = createWorldRoot(request.target)`,
    `            candidate = created`,
    `            check(host.addChild(created)) { "candidate_attach_failed" }`,
    `            oldRoot.getChildren().toList().forEach { child ->`,
    `                check(oldRoot.removeChild(child)) { "stable_child_detach_failed" }`,
    `                movedChildren += child`,
    `                check(created.addChild(child)) { "stable_child_attach_failed" }`,
    `            }`,
    `            check(requestIsCurrent(generation, request, oldRoot)) { "stale_registration" }`,
    `            check(request.rootGenerationBefore < Long.MAX_VALUE) { "root_generation_exhausted" }`,
    `            val nextGeneration = request.rootGenerationBefore + 1L`,
    `            synchronized(lifecycleLock) {`,
    `                check(!disposed && lifecycleGeneration == generation && worldRootRef === oldRoot) { "stale_registration" }`,
    `                worldRootRef = created`,
    `                worldRootGeneration = nextGeneration`,
    `            }`,
    `            published = true`,
    `            val applied = created.components.get<TransformComponent>()?.position`,
    `                ?: error("replacement AgentWorldRoot transform is unavailable")`,
    `            check(oldRoot.getChildrenCount() == 0) { "old_root_not_empty" }`,
    `            check(host.removeChild(oldRoot)) { "old_root_detach_failed" }`,
    `            check(oldRoot.destroy(false)) { "old_root_destroy_failed" }`,
    `            AgentBridge.AgentLocomotionResult(`,
    `                "completed",`,
    `                AgentBridge.AgentWorldPose(nextGeneration, applied),`,
    `            )`,
    `        } catch (cause: Throwable) {`,
    `            val cleanupError = candidate?.let { failedCandidate ->`,
    `                rollbackReplacement(`,
    `                    generation, host, oldRoot, failedCandidate, movedChildren,`,
    `                    request.rootGenerationBefore, published,`,
    `                )`,
    `            }`,
    `            if (cause is CancellationException) {`,
    `                if (cleanupError != null) cause.addSuppressed(IllegalStateException(cleanupError))`,
    `                throw cause`,
    `            }`,
    `            AgentBridge.AgentLocomotionResult("failed", null, failureText(cause), cleanupError)`,
    `        }`,
    `    }`,
    ``,
    `    private fun rollbackReplacement(`,
    `        generation: Long,`,
    `        host: Entity,`,
    `        oldRoot: Entity,`,
    `        candidate: Entity,`,
    `        movedChildren: List<Entity>,`,
    `        oldGeneration: Long,`,
    `        published: Boolean,`,
    `    ): String? {`,
    `        val failures = mutableListOf<String>()`,
    `        fun cleanup(label: String, action: () -> Unit) {`,
    `            runCatching(action).onFailure { failures += label + ": " + failureText(it) }`,
    `        }`,
    `        if (oldRoot.getParent() !== host) {`,
    `            cleanup("old_root_reattach") { check(host.addChild(oldRoot)) { "returned false" } }`,
    `        }`,
    `        movedChildren.asReversed().forEach { child ->`,
    `            cleanup("candidate_child_detach") {`,
    `                if (child.getParent() === candidate) check(candidate.removeChild(child)) { "returned false" }`,
    `            }`,
    `            cleanup("old_child_restore") {`,
    `                if (child.getParent() !== oldRoot) check(oldRoot.addChild(child)) { "returned false" }`,
    `            }`,
    `        }`,
    `        if (published) {`,
    `            cleanup("root_publication_restore") {`,
    `                synchronized(lifecycleLock) {`,
    `                    check(!disposed && lifecycleGeneration == generation && worldRootRef === candidate) { "lifecycle changed during rollback" }`,
    `                    worldRootRef = oldRoot`,
    `                    worldRootGeneration = oldGeneration`,
    `                }`,
    `            }`,
    `        }`,
    `        cleanup("candidate_detach") {`,
    `            if (candidate.getParent() != null) check(candidate.removeFromParent()) { "returned false" }`,
    `        }`,
    `        cleanup("candidate_destroy") {`,
    `            check(candidate.getChildrenCount() == 0) { "candidate still owns stable children" }`,
    `            check(candidate.destroy(false)) { "returned false" }`,
    `        }`,
    `        return failures.takeIf { it.isNotEmpty() }?.joinToString("; ")?.take(500)`,
    `    }`,
    ``,
    `    private fun failureText(cause: Throwable): String =`,
    `        (cause.message ?: cause.javaClass.simpleName).take(500)`,
    ``,
    `    fun dispose() {`,
    `        val disposal = synchronized(lifecycleLock) {`,
    `            if (disposed) return`,
    `            disposed = true`,
    `            lifecycleGeneration += 1L`,
    `            directGlideJob?.cancel(CancellationException("Full Stage disposed"))`,
    `            directGlideJob = null`,
    `            lifecycleScope?.cancel(CancellationException("Full Stage disposed"))`,
    `            lifecycleScope = null`,
    `            val state = Disposal(locomotionRegistrationToken, sceneProviderAttached, spatialViewHostRef ?: worldRootRef)`,
    `            locomotionRegistrationToken = null`,
    `            sceneProviderAttached = false`,
    `            spatialViewHostRef = null`,
    `            worldRootRef = null`,
    `            worldRootGeneration = 0L`,
    `            state`,
    `        }`,
    `        val registrationToken = disposal.registrationToken`,
    `        if (registrationToken != null) runCatching { AgentBridge.unregisterLocomotionProducer(registrationToken) }`,
    ...(options.roomMission
      ? [
          `        runCatching { MissionTableExperience.stop() }`,
          `        runCatching { AgentBridge.unregisterNavigationGuideProducer() }`,
        ]
      : []),
    ...(options.boundaryLab ? [`        rootRef?.let { root -> runCatching { BoundaryLabScene.release(root) } }`] : []),
    `        if (disposal.sceneProviderAttached) runCatching { AgentBridge.detachSceneProvider() }`,
    `        runCatching { hmdTrackingProvider.stop() }`,
    `        val ownedHierarchy = disposal.ownedHierarchy`,
    `        runCatching { ownedHierarchy?.destroy(true) }`,
    ...(options.roomMission ? [`        runCatching { MissionTableExperience.releaseResources() }`] : []),
    `        rootRef = null`,
    `    }`,
    `}`,
    ``,
  ];
}

function genHomeStage(spec: AppSpec, pkg: string): string {
  const contentPkg = `${pkg}.content`;
  const roomMission = spec.roomExperience?.kind === "swanMissionTable";
  const boundaryLab = spec.boundaryLab !== undefined;
  const multiScene = spec.scenes.length > 1 || spec.navigation.portals.length > 0;
  const hasSelect = spec.interactions.length > 0 && spec.data.length > 0;
  const menu = menuButtons(spec);
  const physics = specHasPhysics(spec);
  const fullStageLocomotion = spec.meta.stageStyle === "3" && spec.meta.rootContainer === "stage";
  // v27-pre first-light fix: a resetWorld menu on a NON-physics spec used to emit a call to
  // resetScene() without ever generating it (unresolved reference at gradle time). A reset menu
  // now always gets the rebuildable-scene closure + a resetScene matching the scene's nature.
  const hasResetMenu = (spec.interactions as any[]).some((i) => i.trigger === "press" && String(i.action) === "resetWorld");
  const rebuildable = menu.length > 0 && (physics || hasResetMenu);
  const panelDefs = ((spec as any).panels ?? []) as any[];
  const scenePanelDefs = panelDefs.filter((panel) => panel.placement?.kind === "scene");
  const dockPanelDefs = panelDefs.filter((panel) => panel.placement?.kind !== "scene");
  const scenePanels = scenePanelDefs.length > 0;
  const panels = dockPanelDefs.length > 0;
  // One activity per generated panel host: panelcompose emits HudPanelActivity for hud-style
  // panels and WebPanelActivity for web panels (same content package as this file).
  const panelActivities = [...new Set(dockPanelDefs.map((p) => (p.kind === "web" ? "WebPanelActivity" : "HudPanelActivity")))];
  // v31.3: the dispatcher's select/hover whitelist is DERIVED from the spec's actual buttons
  // (builtins always kept) — the hardcoded four made a custom action like 'putt' unreachable by
  // broadcast even though GameMenu carried its row + customActions closure (com.fleet.door671805).
  const menuActions = [...new Set(["start", "pause", "resume", "reset", ...menu.map(([b]) => b)])];
  const ktSet = (names: string[]) => names.map((a) => `"${a}"`).join(", ");
  const dispatch: string[] = [];
  // Panels: hud:<key>=<value> updates the live text; panel:show/panel:hide open/close the panel
  // activity for ANY generated app (rocketsim-proven: the head-docked panel occludes the scene
  // from the fixed emulator pose — hiding it is the only way to capture clean composition frames).
  if (panels) dispatch.push(`        cmd.startsWith("hud:") -> cmd.removePrefix("hud:").split("=", limit = 2).let { if (it.size == 2) HudState.set(it[0], it[1]) }`);
  if (panels) {
    // panel:show must start the activity from the APP'S OWN context — shell `am start` is refused
    // while the Stage holds Full Space (rocketsim/mrtable seq 15), hence appCtxRef.
    dispatch.push(`        cmd == "panel:show" -> appCtxRef?.let { c -> ${panelActivities.map((a) => `c.startActivity(android.content.Intent(c, ${a}::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))`).join("; ")} } ?: Log.w(TAG, "panel:show before HomeStage composed — no context")`);
    dispatch.push(`        cmd == "panel:hide" -> { ${panelActivities.map((a) => `${a}.instance?.finish()`).join("; ")} }`);
  }
  if (menu.length) dispatch.push(`        cmd in setOf(${ktSet(menuActions)}) -> runCatching { GameMenu.select(cmd) }.onFailure { Log.e(TAG, "select " + cmd + ": " + it.message) }.let { }`);
  if (menu.length) {
    // The mouse bridge streams move:dx,dy,dz on a panel title-drag and hover:<row> previews. The
    // generated GameMenu has carried nudgePanelCmd/hover since v4.9 — but only the hand-edited demo
    // apps ever ROUTED them, so every generated menu app shipped an undraggable panel (found on
    // com.fleet.knockdown 2026-07-28). Menu hover MUST precede the SceneInteraction hover branch.
    dispatch.push(`        cmd.startsWith("move:") -> GameMenu.nudgePanelCmd(cmd.removePrefix("move:"))`);
    dispatch.push(`        cmd.startsWith("hover:") && cmd.removePrefix("hover:") in setOf(${ktSet([...menuActions, "none"])}) -> GameMenu.hover(cmd.removePrefix("hover:"))`);
  }
  if (multiScene) dispatch.push(`        cmd.startsWith("navigate:") -> SceneRouter.go(cmd.removePrefix("navigate:"))`);
  if (specHasPhysics(spec) && launchVelocityMap(spec).size) dispatch.push(`        cmd.startsWith("launch:") -> SceneComposition.launchBody(cmd.removePrefix("launch:"))`);
  if (roomMission) {
    dispatch.push(`        cmd == "mission:launch" -> MissionTableExperience.launchMission()`);
    dispatch.push(`        cmd == "mission:pause" -> MissionTableExperience.togglePause()`);
    dispatch.push(`        cmd == "mission:reset" -> MissionTableExperience.resetMission()`);
  }
  if (hasSelect) {
    dispatch.push(`        cmd.startsWith("select:") -> SceneComposition.showDetail(rootRef ?: return, cmd.removePrefix("select:")).also { SceneInteraction.select(cmd.removePrefix("select:")) }`);
    dispatch.push(`        cmd.startsWith("hover:") -> SceneInteraction.hover(cmd.removePrefix("hover:"))`);
  }
  return [
    `package ${contentPkg}`,
    ``,
    ...(fullStageLocomotion ? [`import android.os.SystemClock`] : []),
    `import android.util.Log`,
    `import androidx.compose.foundation.layout.fillMaxSize`,
    `import androidx.compose.runtime.Composable`,
    ...(roomMission || boundaryLab || fullStageLocomotion ? [`import androidx.compose.runtime.DisposableEffect`] : []),
    ...(fullStageLocomotion ? [`import androidx.compose.runtime.remember`] : []),
    `import androidx.compose.ui.Modifier`,
    `import androidx.compose.ui.platform.LocalContext`,
    ...(roomMission
      ? [
          `import androidx.lifecycle.Lifecycle`,
          `import androidx.lifecycle.LifecycleEventObserver`,
          `import androidx.lifecycle.compose.LocalLifecycleOwner`,
        ]
      : []),
    `import ${pkg}.agent.AgentBridge`,
    ...(menu.length ? [`import ${pkg}.gen.GameMenu`, `import com.pico.spatial.core.ecs.resource.AssetBundle`] : []),
    `import com.pico.spatial.core.ecs.Entity`,
    `import com.pico.spatial.core.ecs.TransformComponent`,
    `import com.pico.spatial.core.math.Quat`,
    `import com.pico.spatial.core.math.Vector3`,
    ...(fullStageLocomotion ? [`import com.pico.spatial.tracking.hmd.HMDTrackingProvider`] : []),
    `import com.pico.spatial.ui.foundation.content.SpatialView`,
    ...(roomMission
      ? [
          `import ${contentPkg}.ecs.OrbitSystem`,
          `import ${contentPkg}.ecs.SpinSystem`,
          `import com.pico.spatial.ui.foundation.dsl.registerSystem`,
          `import com.pico.spatial.ui.foundation.dsl.unregisterSystem`,
        ]
      : []),
    ...(fullStageLocomotion
      ? [
          `import kotlinx.coroutines.CancellationException`,
          `import kotlinx.coroutines.CoroutineScope`,
          `import kotlinx.coroutines.CoroutineStart`,
          `import kotlinx.coroutines.Dispatchers`,
          `import kotlinx.coroutines.Job`,
          `import kotlinx.coroutines.SupervisorJob`,
          `import kotlinx.coroutines.async`,
          `import kotlinx.coroutines.cancel`,
          `import kotlinx.coroutines.currentCoroutineContext`,
          `import kotlinx.coroutines.delay`,
          `import kotlinx.coroutines.ensureActive`,
        ]
      : [`import kotlinx.coroutines.Dispatchers`]),
    `import kotlinx.coroutines.withContext`,
    ``,
    `/** GENERATED by generate_app_wiring — the SpatialView.initial wiring + DEBUG_CMD dispatch. Do not hand-edit. */`,
    `private const val TAG = "SpatialDemo"`,
    `private var rootRef: Entity? = null`,
    ...(rebuildable ? [`private var rebuildGame: (() -> Unit)? = null`] : []),
    ...(panels
      ? [
          `// panel:show needs the app's OWN context — shell am start is refused while the Stage holds Full Space.`,
          `private var appCtxRef: android.content.Context? = null`,
        ]
      : []),
    ``,
    ...(fullStageLocomotion ? fullStageLifecycleLines({ boundaryLab, roomMission }) : []),
    `@Composable`,
    `fun HomeStage() {`,
    `    // Captured in the composable (template-independent) and handed to SceneComposition.build —`,
    `    // data loading + splat/mesh environments need an app Context.`,
    `    val appCtx = LocalContext.current.applicationContext`,
    ...(panels ? [`    appCtxRef = appCtx   // panel:show starts the panel activity from this context`] : []),
    ...(scenePanels ? [`    val panelSizes = rememberAttachmentPanelSizes()`] : []),
    ...(boundaryLab ? [`    val boundaryPanelSizes = rememberBoundaryPanelSizes()`] : []),
    ...(fullStageLocomotion
      ? [
          `    val hmdTrackingProvider = remember { HMDTrackingProvider() }`,
          `    val fullStageLifecycle = remember(hmdTrackingProvider) { FullStageWorldLifecycle(hmdTrackingProvider) }`,
          `    DisposableEffect(fullStageLifecycle) {`,
          `        fullStageLifecycle.start()`,
          `        onDispose { fullStageLifecycle.dispose() }`,
          `    }`,
        ]
      : []),
    ...(roomMission && !fullStageLocomotion
      ? [
          `    val lifecycleOwner = LocalLifecycleOwner.current`,
          `    DisposableEffect(lifecycleOwner) {`,
          `        registerSystem<SpinSystem>()`,
          `        registerSystem<OrbitSystem>()`,
          `        val observer = LifecycleEventObserver { _, event ->`,
          `            when (event) {`,
          `                Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP -> MissionTableExperience.pauseTracking()`,
          `                Lifecycle.Event.ON_START, Lifecycle.Event.ON_RESUME -> rootRef?.let { MissionTableExperience.resumeTracking(it) }`,
          `                else -> Unit`,
          `            }`,
          `        }`,
          `        lifecycleOwner.lifecycle.addObserver(observer)`,
          `        onDispose {`,
          `            lifecycleOwner.lifecycle.removeObserver(observer)`,
          `            MissionTableExperience.stop()`,
          `            AgentBridge.unregisterNavigationGuideProducer()`,
          `            unregisterSystem<OrbitSystem>()`,
          `            unregisterSystem<SpinSystem>()`,
          `            rootRef?.let { root -> AgentBridge.detachScene(root); root.destroy(true) }`,
          `            MissionTableExperience.releaseResources()`,
          `            rootRef = null`,
          `        }`,
          `    }`,
        ]
      : []),
    ...(boundaryLab && !fullStageLocomotion
      ? [
          `    DisposableEffect(Unit) {`,
          `        onDispose {`,
          `            rootRef?.let { root -> BoundaryLabScene.release(root) }`,
          `            rootRef = null`,
          `        }`,
          `    }`,
        ]
      : []),
    `    SpatialView(`,
    `        // fillMaxSize: the 3D content is transform-mapped to the SpatialView's 2D node — a small/default`,
    `        // node compresses the scene into a small bounded region (the "blob" you portal in/out of), so fill`,
    `        // the stage to give the content a large, walkable volume.`,
    `        modifier = Modifier.fillMaxSize(),`,
    `        initial = { content, ${scenePanels || boundaryLab ? "attachments" : "_"} ->`,
    `            withContext(Dispatchers.Main) {`,
    ...(fullStageLocomotion
      ? [
          `                val spatialViewHost = fullStageLifecycle.createSpatialViewHost()`,
          `                content.addEntity(spatialViewHost)`,
          `                val worldRoot = fullStageLifecycle.createWorldRoot(Vector3.ZERO)`,
          `                check(spatialViewHost.addChild(worldRoot)) { "AgentWorldRoot attachment failed" }`,
          `                fullStageLifecycle.mount(spatialViewHost, worldRoot)`,
        ]
      : []),
    ...(rebuildable
      ? [
          `                // The game scene is REBUILDABLE (reset = disable old root + rebuild fresh).`,
          `                val buildGame: () -> Unit = {`,
          `                    val sceneRoot = Entity()`,
          `                    sceneRoot.setName("SceneRoot")`,
          `                    sceneRoot.components.set(TransformComponent(Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))`,
          ...(fullStageLocomotion
            ? [
                `                    val worldParent = fullStageLifecycle.currentWorldRoot() ?: error("AgentWorldRoot is unavailable")`,
                `                    check(worldParent.addChild(sceneRoot)) { "SceneRoot attachment failed" }`,
              ]
            : [`                    content.addEntity(sceneRoot)`]),
          `                    rootRef = sceneRoot`,
          ...(!fullStageLocomotion ? [`                    ${roomMission ? 'AgentBridge.attachScene(sceneRoot, "stage")' : "AgentBridge.attachScene(sceneRoot)"}`] : []),
          ...(roomMission ? [`                    SceneUnderstanding.registerAgentBridgeSceneSnapshot()`] : []),
          `                    SceneComposition.build(sceneRoot, appCtx)`,
          ...(roomMission
            ? [
                `                    if (AgentBridge.navigationGuideCommandsEnabled()) {`,
                `                        MissionTableExperience.registerNavigationGuideProducer()`,
                `                    }`,
              ]
            : []),
          `                }`,
          `                rebuildGame = buildGame`,
          `                buildGame()`,
        ]
      : [
          `                val sceneRoot = Entity()`,
          `                sceneRoot.setName("SceneRoot")`,
          `                sceneRoot.components.set(TransformComponent(Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))`,
          ...(fullStageLocomotion
            ? [`                check(worldRoot.addChild(sceneRoot)) { "SceneRoot attachment failed" }`]
            : [`                content.addEntity(sceneRoot)`]),
          `                rootRef = sceneRoot`,
          ...(!fullStageLocomotion ? [`                ${roomMission ? 'AgentBridge.attachScene(sceneRoot, "stage")' : "AgentBridge.attachScene(sceneRoot)"}`] : []),
          ...(roomMission ? [`                SceneUnderstanding.registerAgentBridgeSceneSnapshot()`] : []),
          `                SceneComposition.build(sceneRoot, appCtx)`,
          ...(roomMission
            ? [
                `                if (AgentBridge.navigationGuideCommandsEnabled()) {`,
                `                    MissionTableExperience.registerNavigationGuideProducer()`,
                `                }`,
              ]
            : []),
        ]),
    ...(scenePanels ? [`                attachments.seatSceneAttachmentPanels(${fullStageLocomotion ? "worldRoot" : "content"})`] : []),
    ...(boundaryLab ? [`                attachments.seatBoundaryLabPanels(${fullStageLocomotion ? "worldRoot" : "content"})`] : []),
    ...(roomMission ? [`                rootRef?.let { MissionTableExperience.start(it) }`] : []),
    `            }`,
    ...(menu.length
      ? [
          `            // The clickable in-world GameMenu (its own root — survives game resets). The mouse bridge detects it.`,
          `            runCatching {`,
          `                val bundle = withContext(Dispatchers.IO) { AssetBundle.load("asset://menu.bundle") }`,
          `                val panel = withContext(Dispatchers.IO) { Entity.loadSuspend("menu", bundle) }`,
          `                withContext(Dispatchers.Main) {`,
                    `                    val menuRoot = Entity()`,
                    `                    menuRoot.setName("MenuRoot")`,
                    `                    menuRoot.components.set(TransformComponent(Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))`,
                    ...(fullStageLocomotion
                      ? [
                          `                    val menuParent = fullStageLifecycle.currentWorldRoot() ?: error("AgentWorldRoot is unavailable")`,
                          `                    check(menuParent.addChild(menuRoot)) { "MenuRoot attachment failed" }`,
                        ]
                      : [`                    content.addEntity(menuRoot)`]),
          `                    GameMenu.customActions = mapOf(${menu.map(([b, body]) => `"${b}" to { ${body} }`).join(", ")})`,
          `                    GameMenu.attach(menuRoot, panel, emptyList())`,
          `                }`,
          `            }.onFailure { Log.e(TAG, "menu attach failed: " + it.message) }`,
        ]
      : []),
    `            Log.i(TAG, "HomeStage ready")`,
    `        },`,
    `        attachments = { ${[
      ...(scenePanels ? ["sceneAttachmentPanels(panelSizes)"] : []),
      ...(boundaryLab ? ["boundaryLabPanels(boundaryPanelSizes, BoundaryLabScene.ROOT_SENTINEL)"] : []),
    ].join("; ")} },`,
    `    )`,
    `}`,
    ``,
    ...(rebuildable
      ? physics
        ? [
            `/** RESET: disable the old physics root + rebuild fresh (the only reliable physics reset). */`,
            `internal fun resetScene() {`,
            `    val old = rootRef ?: return`,
            `    rootRef = null`,
            `    ScenePhysics.resetWorld(old) { rebuildGame?.invoke() }`,
            `    Log.i(TAG, "resetScene: rebuilding")`,
            `}`,
            ``,
          ]
        : [
            `/** RESET (static scene): disable the old root + rebuild immediately (no physics world to settle). */`,
            `internal fun resetScene() {`,
            `    val old = rootRef ?: return`,
            `    rootRef = null`,
            `    old.enabled = false`,
            `    rebuildGame?.invoke()`,
            `    Log.i(TAG, "resetScene: rebuilding (static)")`,
            `}`,
            ``,
          ]
      : []),
    `/** Headless command channel: adb shell am broadcast -a ${pkg}.DEBUG_CMD --es cmd <navigate:|select:|hover:|move:|${panels ? "panel:show|panel:hide|" : ""}${roomMission ? "mission:launch|mission:pause|mission:reset|" : ""}${menu.length ? menuActions.join("|") + "|" : "start|reset|"}launch:><id> */`,
    `internal fun dispatchDebugCommand(cmd: String, arg: Int = 0) {`,
    `    Log.i(TAG, "DEBUG_CMD cmd=" + cmd + " arg=" + arg)`,
    `    when {`,
    ...(dispatch.length ? dispatch : [`        else -> Log.w(TAG, "no debug commands wired")`]),
    ...(dispatch.length ? [`        else -> Log.w(TAG, "unknown DEBUG_CMD: " + cmd)`] : []),
    `    }`,
    `}`,
    ``,
  ].join("\n");
}

function genMain(spec: AppSpec, pkg: string): string {
  return [
    `package ${pkg}`,
    ``,
    `import ${pkg}.content.HomeStage`,
    `import com.pico.spatial.ui.design.PicoTheme`,
    `import com.pico.spatial.ui.foundation.dsl.DefaultStage`,
    `import com.pico.spatial.ui.foundation.dsl.SpatialAppScope`,
    ``,
    `/** GENERATED by generate_app_wiring — app entry. The immersive scene lives in DefaultStage. Dock`,
    ` *  panels are separate 2D activities; scene attachments remain inside the SpatialView —`,
    ` *  an app's own WindowContainer opens too, but ONLY if the app calls`,
    ` *  spatialNavigator.openWindowContainer (measured 2026-08-06) — see generate_container_app_kotlin. */`,
    `fun mainApp(scope: SpatialAppScope) = with(scope) {`,
    `    DefaultStage { PicoTheme { HomeStage() } }`,
    `}`,
    ``,
  ].join("\n");
}

/** Pure: returns the core wiring plus any typed internal-profile files. */
export function generateWiring(spec: AppSpec): { path: string; content: string }[] {
  const pkg = spec.meta.packageName;
  const cdir = `app/src/main/java/${pkg.replace(/\./g, "/")}`;
  return [
    { path: `${cdir}/content/SceneComposition.kt`, content: genComposition(spec, pkg) },
    { path: `${cdir}/content/HomeStage.kt`, content: genHomeStage(spec, pkg) },
    { path: `${cdir}/Main.kt`, content: genMain(spec, pkg) },
    ...generateMissionTableFiles(spec, pkg),
    ...generateBoundaryLabFiles(spec, pkg),
  ];
}

export function registerAssembleTools(server: McpServer) {
  server.registerTool(
    "generate_app_wiring",
    {
      description:
        "Generate the app-DEFINING wiring from an AppSpec — the files that turn the primitives into a running app, which previously had NO generator and were hand-authored (the ledger→running-app gap). Emits three deterministic Kotlin files: SceneComposition.kt (the build(root) body: load data → SceneRouter for multi-scene or SceneLayout.place + SceneInteraction.register + showDetail for single scene), HomeStage.kt (the SpatialView.initial wiring on the main thread + AgentBridge + DEBUG_CMD dispatch, with branches only for the primitives the spec uses; the menu select/hover whitelist is derived from the spec's actual buttons — custom actions like 'putt' are broadcast-drivable; specs with panels get 'panel:show'/'panel:hide' routing that starts/finishes the panel activity from the app's own context), and Main.kt (the mainApp entrypoint). Analytical/deterministic (same spec → byte-identical wiring). Write each to its path, then build_and_run. Pairs with compile_app_spec (which now lists these as steps). RETURNS: JSON {files: [{path, content}]} — write ALL of them (path is project-relative).",
      inputSchema: {
        spec: z.any().describe("A validated AppSpec (from plan_app_spec)."),
      },
    },
    async ({ spec: raw }) => {
      const parsed = appSpecSchema.safeParse(raw);
      if (!parsed.success) return okJson({ status: "invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      const files = generateWiring(parsed.data);
      return okJson({
        status: "ok",
        appName: parsed.data.meta.appName,
        packageName: parsed.data.meta.packageName,
        files,
        note: "Write each file to its `path`, then run the `build` step. These files were previously hand-authored (ProductShowcase/MultiSceneDemo/HomeStage) — they are now generated from the spec, closing the ledger→running-app gap.",
      });
    },
  );
}
