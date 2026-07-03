import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema, type AppSpec } from "./appspec.js";

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
// v6.6: compose the orphaned lighting + environment tiers — the compiler generates SceneLighting.kt and
// MeshEnvironment.kt but nothing invoked them, so PBR content was unlit and backdrops never loaded.
function anyLighting(spec: AppSpec): boolean {
  return spec.scenes.some((s) => s.lighting?.rig && s.lighting.rig !== "none");
}
function anyTexturedEnv(spec: AppSpec): boolean {
  return spec.scenes.some((s) => s.environment?.kind === "texturedMesh" || s.environment?.kind === "splat" || s.environment?.kind === "pano");
}
// v7.3: animation — the object's anim ({type:"tween"|"orbit", ...}) plays on each placed entity.
function animFor(spec: AppSpec, layoutId: string | undefined): { type: string } | null {
  const a: any = objectForLayout(spec, layoutId)?.anim;
  return a && (a.type === "tween" || a.type === "orbit") ? a : null;
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
  if (scene.environment?.kind === "splat") return `${indent}compScope.launch { SplatEnvironment.load(SpatialApplication.appContext?.getExternalFilesDir(null)?.absolutePath) { ${rootVar}.addChild(it) } }`;
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
    if (b.shape === "box" && b.mode === "static") out.push(`${indent}bodies["${o.id}"] = ScenePhysics.staticBox(root, "${o.id}", ${pos}, ${vec3Kt(b.dims, [1, 0.2, 1])}${tintArg})`);
    else if (b.shape === "box") out.push(`${indent}bodies["${o.id}"] = ScenePhysics.dynamicBox(root, "${o.id}", ${pos}, ${vec3Kt(b.dims, [0.3, 0.3, 0.3])}, ${mass}f${tintArg})`);
    else if (b.shape === "sphere") out.push(`${indent}bodies["${o.id}"] = ScenePhysics.dynamicSphere(root, "${o.id}", ${pos}, ${b.dims?.[0] ?? 0.15}f, ${mass}f${tintArg})`);
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

  const lines: string[] = [];
  const needsCtx = spec.data.length > 0 || anyTexturedEnv(spec);
  lines.push(`package ${contentPkg}`, ``, `import android.util.Log`);
  if (needsCtx) lines.push(`import ${pkg}.platform.SpatialApplication`);
  lines.push(`import com.pico.spatial.core.ecs.Entity`);
  if (hasSelect) {
    lines.push(
      `import com.pico.spatial.core.ecs.ModelComponent`,
      `import com.pico.spatial.core.ecs.TransformComponent`,
      `import com.pico.spatial.core.ecs.resource.MeshResource`,
      `import com.pico.spatial.core.ecs.resource.UnlitMaterial`,
      `import com.pico.spatial.core.math.Color4`,
      `import com.pico.spatial.core.math.EulerAngles`,
      `import com.pico.spatial.core.math.Vector3`,
    );
  }
  if (!hasSelect && physics) {
    lines.push(`import com.pico.spatial.core.math.Color4`, `import com.pico.spatial.core.math.Vector3`);
  }
  if (asyncEnv) {
    lines.push(
      `import kotlinx.coroutines.CoroutineScope`,
      `import kotlinx.coroutines.Dispatchers`,
      `import kotlinx.coroutines.SupervisorJob`,
      `import kotlinx.coroutines.launch`,
    );
  }
  lines.push(``, `/** GENERATED by generate_app_wiring from the AppSpec — the build(root) composition. Do not hand-edit. */`);
  lines.push(`object SceneComposition {`, `    private const val TAG = "SpatialDemo"`);
  if (hasSelect) lines.push(`    private var detail: Entity? = null`);
  if (physics) lines.push(`    private val bodies = mutableMapOf<String, Entity>()`);
  if (asyncEnv) lines.push(`    private val compScope = CoroutineScope(Dispatchers.Main + SupervisorJob())`);
  lines.push(``, `    fun build(root: Entity) {`);
  if (needsCtx) lines.push(`        val ctx = SpatialApplication.appContext`);

  // v6.6: light the scene (so PBR content renders lit, not dim) — the rig was generated but never applied.
  if (lighting) lines.push(`        SceneLighting.apply(root)`);

  // v9.1: REAL physics — world + bodies (created in ONE batch each at build, per the rulebook).
  if (physics) for (const bl of physicsBodyLines(spec, "        ")) lines.push(bl);

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
      const dv = d ? dataVar(d.id) : "emptyList()";
      const factory = factoryFor(spec, l?.id);
      const scale = modelScaleFor(spec, l?.id);
      lines.push(`        SceneRouter.register("${s.id}") { c ->`);
      for (const ml of materialLines(spec, l?.id, "            ")) lines.push(ml);
      if (scale != null) lines.push(`            SceneDataBinding.modelScale = ${scale}f`);
      const env = envLoadLine(s, "c", "            ");
      if (env) lines.push(env);
      const mplay = animPlayCall(animFor(spec, l?.id));
      if (mplay) {
        lines.push(
          `            SceneLayout.place(c, ${dv}.size, SceneLayout.Pattern.${pat}) { i -> SceneDataBinding.${factory}(${dv}[i]) }.forEach { ${mplay}(it) }`,
          `        }`,
        );
      } else {
        lines.push(
          `            SceneLayout.place(c, ${dv}.size, SceneLayout.Pattern.${pat}) { i -> SceneDataBinding.${factory}(${dv}[i]) }`,
          `        }`,
        );
      }
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
    if (dv) {
      lines.push(`        if (${dv}.isEmpty()) { Log.e(TAG, "composition: no items loaded"); return }`);
      for (const ml of materialLines(spec, l?.id, "        ")) lines.push(ml);
      if (scale != null) lines.push(`        SceneDataBinding.modelScale = ${scale}f`);
      const play = animPlayCall(animFor(spec, l?.id));
      // v7.3: for MODELS the animation must target the async-loaded child (via onModelLoaded), not the
      // container; for QUADS the placed entity IS the geometry, so play it directly after placement.
      // NOTE: quad/primitive animation is vision-verified. Loaded-MODEL rotation is BEST-EFFORT — the SDK's
      // animation does not propagate through a loaded model's node hierarchy, so nested geometry may not move.
      if (play && factory === "makeModelCard") lines.push(`        SceneDataBinding.onModelLoaded = { ${play}(it) }   // v7.3 animation (best-effort on loaded models — nested geometry may not rotate)`);
      lines.push(`        val cards = SceneLayout.place(root, ${dv}.size, SceneLayout.Pattern.${pat}) { i -> SceneDataBinding.${factory}(${dv}[i]) }`);
      // v8.5 AAA: real 3D-model props cast soft ground shadows (flat quads skip it — a flat shadow reads odd).
      if (lighting && factory === "makeModelCard") lines.push(`        cards.forEach { SceneLighting.groundShadow(it) }`);
      if (hasSelect) {
        lines.push(`        cards.forEachIndexed { i, card ->`, `            SceneInteraction.register(${dv}[i].id, card) { id -> showDetail(root, id) }`, `        }`);
      }
      if (play && factory !== "makeModelCard") lines.push(`        cards.forEach { ${play}(it) }   // v7.3 animation`);
      lines.push(`        Log.i(TAG, "built " + cards.size + " cards")`);
    } else {
      if (!physics) lines.push(`        Log.w(TAG, "composition: scene '${s.id}' has no data-bound layout to place")`);
      else lines.push(`        Log.i(TAG, "physics scene: " + bodies.size + " bodies")`);
    }
  }
  lines.push(`        Log.i(TAG, "${readyMsg}")`, `    }`);

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

function genHomeStage(spec: AppSpec, pkg: string): string {
  const contentPkg = `${pkg}.content`;
  const multiScene = spec.scenes.length > 1 || spec.navigation.portals.length > 0;
  const hasSelect = spec.interactions.length > 0 && spec.data.length > 0;
  const dispatch: string[] = [];
  if (multiScene) dispatch.push(`        cmd.startsWith("navigate:") -> SceneRouter.go(cmd.removePrefix("navigate:"))`);
  if (specHasPhysics(spec) && launchVelocityMap(spec).size) dispatch.push(`        cmd.startsWith("launch:") -> SceneComposition.launchBody(cmd.removePrefix("launch:"))`);
  if (hasSelect) {
    dispatch.push(`        cmd.startsWith("select:") -> SceneComposition.showDetail(rootRef ?: return, cmd.removePrefix("select:")).also { SceneInteraction.select(cmd.removePrefix("select:")) }`);
    dispatch.push(`        cmd.startsWith("hover:") -> SceneInteraction.hover(cmd.removePrefix("hover:"))`);
  }
  return [
    `package ${contentPkg}`,
    ``,
    `import android.util.Log`,
    `import androidx.compose.foundation.layout.fillMaxSize`,
    `import androidx.compose.runtime.Composable`,
    `import androidx.compose.ui.Modifier`,
    `import ${pkg}.agent.AgentBridge`,
    `import com.pico.spatial.core.ecs.Entity`,
    `import com.pico.spatial.core.ecs.TransformComponent`,
    `import com.pico.spatial.core.math.Quat`,
    `import com.pico.spatial.core.math.Vector3`,
    `import com.pico.spatial.ui.foundation.content.SpatialView`,
    `import kotlinx.coroutines.Dispatchers`,
    `import kotlinx.coroutines.withContext`,
    ``,
    `/** GENERATED by generate_app_wiring — the SpatialView.initial wiring + DEBUG_CMD dispatch. Do not hand-edit. */`,
    `private const val TAG = "SpatialDemo"`,
    `private var rootRef: Entity? = null`,
    ``,
    `@Composable`,
    `fun HomeStage() {`,
    `    SpatialView(`,
    `        // fillMaxSize: the 3D content is transform-mapped to the SpatialView's 2D node — a small/default`,
    `        // node compresses the scene into a small bounded region (the "blob" you portal in/out of), so fill`,
    `        // the stage to give the content a large, walkable volume.`,
    `        modifier = Modifier.fillMaxSize(),`,
    `        initial = { content, _ ->`,
    `            withContext(Dispatchers.Main) {`,
    `                val sceneRoot = Entity()`,
    `                sceneRoot.setName("SceneRoot")`,
    `                sceneRoot.components.set(TransformComponent(Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))`,
    `                content.addEntity(sceneRoot)`,
    `                rootRef = sceneRoot`,
    `                AgentBridge.attachScene(sceneRoot)`,
    `                SceneComposition.build(sceneRoot)`,
    `            }`,
    `            Log.i(TAG, "HomeStage ready")`,
    `        },`,
    `        attachments = {},`,
    `    )`,
    `}`,
    ``,
    `/** Headless command channel: adb shell am broadcast -a ${pkg}.DEBUG_CMD --es cmd <navigate:|select:|hover:><id> */`,
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
    `/** GENERATED by generate_app_wiring — app entry. The immersive scene lives in DefaultStage. */`,
    `fun mainApp(scope: SpatialAppScope) = with(scope) {`,
    `    DefaultStage { PicoTheme { HomeStage() } }`,
    `}`,
    ``,
  ].join("\n");
}

/** Pure: returns the three wiring files (path relative to the content pkg + content string). */
export function generateWiring(spec: AppSpec): { path: string; content: string }[] {
  const pkg = spec.meta.packageName;
  const cdir = `app/src/main/java/${pkg.replace(/\./g, "/")}`;
  return [
    { path: `${cdir}/content/SceneComposition.kt`, content: genComposition(spec, pkg) },
    { path: `${cdir}/content/HomeStage.kt`, content: genHomeStage(spec, pkg) },
    { path: `${cdir}/Main.kt`, content: genMain(spec, pkg) },
  ];
}

export function registerAssembleTools(server: McpServer) {
  server.registerTool(
    "generate_app_wiring",
    {
      description:
        "Generate the app-DEFINING wiring from an AppSpec — the files that turn the primitives into a running app, which previously had NO generator and were hand-authored (the ledger→running-app gap). Emits three deterministic Kotlin files: SceneComposition.kt (the build(root) body: load data → SceneRouter for multi-scene or SceneLayout.place + SceneInteraction.register + showDetail for single scene), HomeStage.kt (the SpatialView.initial wiring on the main thread + AgentBridge + DEBUG_CMD dispatch, with branches only for the primitives the spec uses), and Main.kt (the mainApp entrypoint). Analytical/deterministic (same spec → byte-identical wiring). Write each to its path, then build_and_run. Pairs with compile_app_spec (which now lists these as steps).",
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
