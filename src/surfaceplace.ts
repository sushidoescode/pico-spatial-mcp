import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * surfaceplace.ts — v30.2: SEAT A BAKED MODEL ON A DETECTED REAL-WORLD SURFACE.
 *
 * This generator exists because the same five mistakes were made by hand while building the MR
 * data tabletop on 2026-07-29, and every one of them is silent — the app builds, runs, and looks
 * plausibly wrong:
 *
 *  1. A ONE-SHOT plane query returns 0. `PlaneTrackingManager.start()` then an immediate
 *     `loadAllAnchors()` gave 0 planes, because Full Space was still running its entry animation
 *     (logcat: "enter fullSpace animation start" ~2.5s AFTER the container reports full space).
 *     Emitted code POLLS. This is very likely part of what produced this project's historic
 *     "the emulator has no scene understanding" belief.
 *  2. The floor is NOT at y=0. The emulator's bedroom reports FLOOR at y=0.40. Anything seated
 *     with a hardcoded 0 floats or sinks.
 *  3. Anchor space needs an explicit conversion — `root.convertPositionFrom(pos, null)`, the
 *     examples/Plane.kt flow. It is identity while the root sits at the origin, so skipping it
 *     appears to work until the root moves.
 *  4. Generated/downloaded models (Meshy et al.) are usually origin-CENTRED, so seating them at
 *     the surface height buries half the model. Emitted code lifts by half the height unless the
 *     asset is declared bottom-origin.
 *  5. REFUTED 2026-08-06 by measurement (ledger com.picoagent.v35expc#4). This used to read "a
 *     MESH collider never registers in PICO's queryable physics world. Only primitives do."
 *     v35.4 refuted the runtime half; Experiment C-5 has now refuted the loaded half too. A mesh
 *     taken off a LOADED model's ModelComponent answers rayCast through both createStaticMesh and
 *     createConvexMesh, measured against a primitive control in the same cast.
 *     The emitted collider still stays a BOX here — but for a reason that survives the refutation
 *     rather than the one that did not. A mesh shape cooked from a loaded submesh is positioned by
 *     the COLLIDER ENTITY's transform and inherits none of the source model's node hierarchy, so
 *     seating it correctly requires knowing that submesh's own offset and scale; measured, one sat
 *     entirely above its entity origin and shrank to ~2mm at the asset's display scale. A box
 *     derived from the declared footprint needs none of that, and costs less per query. It also
 *     carries the required PhysicsWorldComponent, without which nothing is queryable at all.
 *
 * The emitted object is self-contained: call `seat(root, add)` from inside SpatialView.initial.
 */

const SEMANTICS = [
  "FLOOR",
  "CEILING",
  "WALL",
  "DOOR",
  "WINDOW",
  "OPENING",
  "TABLE",
  "SOFA",
  "CHAIR",
  "BED",
  "CABINET",
  "UNKNOWN",
] as const;

export interface SurfacePlacementOptions {
  packageName: string;
  objectName: string;
  bundleAsset: string;
  modelName: string;
  semantic: string;
  modelSize: [number, number, number];
  originAt: "center" | "bottom";
  /** Measured lift from measure_model — overrides originAt when present. */
  baseLift?: number;
  collider: "boxTop" | "boxFull" | "none";
  pollSeconds: number;
}

/** Deterministic: same options -> byte-identical Kotlin. */
export function surfacePlacementKotlin(o: SurfacePlacementOptions): string {
  const [w, h, d] = o.modelSize;
  // A measured baseLift (from measure_model) wins over the originAt label: "centred" and
  // "bottom-origin" are only two points on a continuum and plenty of downloaded models are neither,
  // whereas the distance from the origin to the model's lowest point is exact for all of them.
  const halfH =
    o.baseLift !== undefined ? o.baseLift.toFixed(4) : o.originAt === "center" ? (h / 2).toFixed(4) : "0.0000";
  const wantsUp = o.semantic !== "WALL" && o.semantic !== "DOOR" && o.semantic !== "WINDOW";
  const lines: string[] = [];

  lines.push(`package ${o.packageName}`);
  lines.push("");
  lines.push("import android.util.Log");
  lines.push("import com.pico.spatial.core.ecs.CollisionComponent");
  lines.push("import com.pico.spatial.core.ecs.Entity");
  lines.push("import com.pico.spatial.core.ecs.PhysicsWorldComponent");
  lines.push("import com.pico.spatial.core.ecs.TransformComponent");
  lines.push("import com.pico.spatial.core.ecs.resource.AssetBundle");
  lines.push("import com.pico.spatial.core.ecs.resource.PhysicsMaterialResource");
  lines.push("import com.pico.spatial.core.ecs.resource.ShapeResource");
  lines.push("import com.pico.spatial.core.ecs.simulation.CollisionFilter");
  lines.push("import com.pico.spatial.core.ecs.simulation.CollisionInfoDetailLevel");
  lines.push("import com.pico.spatial.core.ecs.simulation.CollisionResponseMode");
  lines.push("import com.pico.spatial.core.math.Quat");
  lines.push("import com.pico.spatial.core.math.Vector3");
  lines.push("import com.pico.spatial.sense.plane.PlaneAnchor");
  lines.push("import com.pico.spatial.sense.plane.PlaneTrackingManager");
  lines.push("import kotlinx.coroutines.Dispatchers");
  lines.push("import kotlinx.coroutines.delay");
  lines.push("import kotlinx.coroutines.withContext");
  lines.push("");
  lines.push("/**");
  lines.push(` * GENERATED by generate_surface_placement_kotlin — seats "${o.modelName}" on a detected`);
  lines.push(` * ${o.semantic} plane. Call from SpatialView.initial:`);
  lines.push(" *");
  lines.push(`ering *   ${o.objectName}.seat(sceneRoot) { sceneRoot.addChild(it) }`.replace("ering *", " *"));
  lines.push(" *");
  lines.push(" * REQUIRES an OPEN Stage — any stage style, Mixed (1) included. A WindowContainer returns 0 planes.");
  lines.push(" */");
  lines.push(`object ${o.objectName} {`);
  lines.push(`    private const val TAG = "SpatialDemo"`);
  lines.push(`    private const val BUNDLE = "${o.bundleAsset}"`);
  lines.push(`    private const val MODEL = "${o.modelName}"`);
  lines.push(`    private const val SIZE_X = ${w}f`);
  lines.push(`    private const val SIZE_Y = ${h}f`);
  lines.push(`    private const val SIZE_Z = ${d}f`);
  lines.push(
    `    /** ${o.baseLift !== undefined ? "MEASURED by measure_model" : `Origin is ${o.originAt}`}: lift by this to put the model's base on the surface. */`,
  );
  lines.push(`    private const val BASE_LIFT = ${halfH}f`);
  if (o.semantic === "FLOOR") {
    lines.push("    /** How far in front of the user a floor-seated model stands, in metres. */");
    lines.push("    private const val FRONT_DIST = 1.6f");
  }
  lines.push("");
  lines.push("    var placedAt: Vector3? = null");
  lines.push("        private set");
  lines.push("");
  lines.push("    // Retained for dispose(). AssetBundle is Closeable but NOT a Resource, so it is not");
  lines.push("    // lifecycle-tied to anything (Resource.kt:35-42) — if this object does not close it,");
  lines.push("    // nothing ever will.");
  lines.push("    private var bundle: AssetBundle? = null");
  lines.push("");
  lines.push("    /**");
  lines.push("     * Detect -> convert -> seat. `add` attaches the loaded root (content.addEntity or");
  lines.push("     * an ancestor's addChild). Returns the model entity, or null if no surface was found.");
  lines.push("     */");
  lines.push("    suspend fun seat(root: Entity, add: (Entity) -> Unit): Entity? {");
  lines.push("        val anchor = findSurface() ?: run {");
  lines.push(`            Log.w(TAG, "SURFACE| no ${o.semantic} plane found — nothing seated")`);
  lines.push("            return null");
  lines.push("        }");
  lines.push("        val b = bundle?.takeIf { it.valid } ?: withContext(Dispatchers.IO) { AssetBundle.load(BUNDLE) }");
  lines.push("        bundle = b");
  lines.push("        val model = Entity.loadSuspend(MODEL, b)");
  lines.push("        return withContext(Dispatchers.Main) {");
  lines.push("            // Anchor space -> root space. Identity while root sits at the origin, which is");
  lines.push("            // exactly why skipping it hides the bug until the root moves.");
  lines.push("            val surface = root.convertPositionFrom(anchor.transform.position, null)");
  if (o.semantic === "FLOOR") {
    lines.push("            // TRAP 6 — the height comes from the detected plane, but the X/Z must NOT.");
    lines.push("            // A FLOOR plane is room-sized and its centroid is wherever the room's middle");
    lines.push("            // happens to fall: measured 2026-07-29 at x=1.82, i.e. 1.8 m to the user's");
    lines.push("            // RIGHT and ~83 deg off the view axis. The model was seated correctly and");
    lines.push("            // still read as MISSING, because it was never in front of anyone. So seat it");
    lines.push("            // FRONT_DIST straight ahead (forward is -Z, origin at the user's feet), then");
    lines.push("            // clamp into the plane's own rectangle so it cannot stand off the surface.");
    lines.push("            val halfX = kotlin.math.max(0.25f, anchor.boundingBoxSize.x / 2f - SIZE_X / 2f)");
    lines.push("            val halfZ = kotlin.math.max(0.25f, anchor.boundingBoxSize.y / 2f - SIZE_Z / 2f)");
    lines.push("            val pos = Vector3(");
    lines.push("                0f.coerceIn(surface.x - halfX, surface.x + halfX),");
    lines.push("                surface.y + BASE_LIFT,");
    lines.push("                (-FRONT_DIST).coerceIn(surface.z - halfZ, surface.z + halfZ),");
    lines.push("            )");
  } else {
    lines.push("            // A TABLE/CABINET/BED/WALL plane is object-sized, so its centroid IS the");
    lines.push("            // place you want. (Only a room-sized FLOOR needs seating relative to the user.)");
    lines.push("            val pos = Vector3(surface.x, surface.y + BASE_LIFT, surface.z)");
  }
  lines.push(`            model.setName("${o.modelName}")`);
  lines.push("            model.components.set(TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f)))");
  lines.push("            add(model)");
  lines.push("            placedAt = pos");
  if (o.collider !== "none") {
    lines.push("            // PhysicsWorldComponent is REQUIRED before any rayCast against this collider.");
    lines.push("            runCatching { root.components.set(PhysicsWorldComponent()) }");
    lines.push("            add(makeCollider(pos))");
  }
  lines.push(
    '            Log.i(TAG, "SURFACE| seated " + MODEL + " on ' +
      o.semantic +
      ' at (" + fmt(pos.x) + "," + fmt(pos.y) + "," + fmt(pos.z) + ") surfaceY=" + fmt(surface.y))',
  );
  lines.push("            model");
  lines.push("        }");
  lines.push("    }");
  lines.push("");
  lines.push("    /**");
  lines.push("     * POLLS. A query fired immediately after start() returns 0 planes because the Stage");
  lines.push("     * is still animating in — measured 2026-07-29, and the most likely cause of historic");
  lines.push('     * "the emulator has no sense data" readings.');
  lines.push("     */");
  lines.push("    private suspend fun findSurface(): PlaneAnchor? {");
  lines.push("        runCatching { PlaneTrackingManager.start() }");
  lines.push(`            .onFailure { Log.e(TAG, "SURFACE| plane start failed: " + it.message) }`);
  lines.push("        var planes: List<PlaneAnchor> = emptyList()");
  lines.push("        var tries = 0");
  lines.push(`        while (planes.isEmpty() && tries < ${o.pollSeconds}) {`);
  lines.push("            planes = runCatching {");
  lines.push("                withContext(Dispatchers.IO) { PlaneTrackingManager.loadAllAnchors().toList() }");
  lines.push("            }.getOrDefault(emptyList())");
  lines.push("            if (planes.isNotEmpty()) break");
  lines.push("            delay(1000)");
  lines.push("            tries++");
  lines.push("        }");
  lines.push(`        Log.i(TAG, "SURFACE| planes=" + planes.size + " after " + tries + " retries")`);
  lines.push("        if (planes.isEmpty()) return null");
  lines.push(`        val labelled = planes.filter { it.semantics.name == "${o.semantic}" }`);
  if (wantsUp) {
    lines.push("        // Biggest matching plane wins; a 0.2m shelf is a poor floor.");
    lines.push("        val best = labelled.maxByOrNull { it.boundingBoxSize.x * it.boundingBoxSize.y }");
    lines.push("        if (best != null) return best");
    lines.push("        // Fallback by HEIGHT, not orientation. Measured 2026-07-29 across two PICO home");
    lines.push("        // environments: the orientation convention FLIPS between them — one reports");
    lines.push("        // FLOOR as HORIZONTAL_UPWARD, the other reports FLOOR as HORIZONTAL_DOWNWARD");
    lines.push("        // with CEILING as UPWARD. Filtering on orientation picks the CEILING in the");
    lines.push("        // second room. Lowest (or highest) large horizontal plane is stable.");
    lines.push("        val horizontal = planes.filter { it.planeOrientation.name.startsWith(\"HORIZONTAL\") }");
    lines.push("            .filter { it.boundingBoxSize.x * it.boundingBoxSize.y >= 1.0f }");
    if (o.semantic === "CEILING") {
      lines.push("        return horizontal.maxByOrNull { it.transform.position.y }");
    } else {
      lines.push("        return horizontal.minByOrNull { it.transform.position.y }");
    }
  } else {
    lines.push("        val best = labelled.maxByOrNull { it.boundingBoxSize.x * it.boundingBoxSize.y }");
    lines.push("        if (best != null) return best");
    lines.push("        return planes.filter { it.planeOrientation.name.contains(\"VERTICAL\") }");
    lines.push("            .maxByOrNull { it.boundingBoxSize.x * it.boundingBoxSize.y }");
  }
  lines.push("    }");
  if (o.collider !== "none") {
    lines.push("");
    lines.push("    /**");
    lines.push("     * A PRIMITIVE box. Mesh/convex colliders do NOT register in PICO's queryable world,");
    lines.push("     * so a mesh collider here would silently never raycast.");
    lines.push("     */");
    lines.push("    private fun makeCollider(pos: Vector3): Entity {");
    const slab = o.collider === "boxTop";
    lines.push(`        val slabH = ${slab ? "0.10f" : "SIZE_Y"}`);
    lines.push(
      `        val centre = Vector3(pos.x, pos.y + ${slab ? "(SIZE_Y / 2f - slabH / 2f)" : "0f"}, pos.z)`,
    );
    lines.push("        val e = Entity()");
    lines.push(`        e.setName("Col_${o.modelName}")`);
    lines.push("        e.components.set(TransformComponent(centre, Quat.identity(), Vector3(1f, 1f, 1f)))");
    lines.push("        runCatching {");
    lines.push("            e.components.set(");
    lines.push("                CollisionComponent(");
    lines.push("                    listOf(ShapeResource.createBox(Vector3(SIZE_X, slabH, SIZE_Z))),");
    lines.push("                    PhysicsMaterialResource(0.5f, 0.5f, 0f),");
    lines.push("                    CollisionResponseMode.COLLIDER_FULL,");
    lines.push("                    CollisionFilter.COLLISION_FILTER_DEFAULT,");
    lines.push("                    CollisionInfoDetailLevel.BRIEF,");
    lines.push("                ),");
    lines.push("            )");
    lines.push(`        }.onFailure { Log.e(TAG, "SURFACE| collider failed: " + it.message) }`);
    lines.push("        return e");
    lines.push("    }");
  }
  lines.push("");
  lines.push("    /**");
  lines.push("     * MANDATORY teardown — DisposableEffect { onDispose { " + o.objectName + ".dispose() } }.");
  lines.push("     * Two things are released here and NOTHING else releases them:");
  lines.push("     *  1. the AssetBundle (Closeable, not lifecycle-tied to any component);");
  lines.push("     *  2. plane tracking, which this object START()ed and which keeps running app-wide.");
  lines.push("     * The seated model's own mesh/material are owned by its ModelComponent and are NOT");
  lines.push("     * closed here (Resource.kt:35-42) — closing those would be a use-after-free.");
  lines.push("     */");
  lines.push("    fun dispose() {");
  lines.push("        runCatching { PlaneTrackingManager.stop() }");
  lines.push(`            .onFailure { Log.e(TAG, "SURFACE| plane stop failed: " + it.message) }`);
  lines.push("        bundle?.takeIf { it.valid }?.let { runCatching { it.close() } }");
  lines.push("        bundle = null");
  lines.push("        placedAt = null");
  lines.push(`        Log.i(TAG, "SURFACE| disposed (tracking stopped, bundle closed)")`);
  lines.push("    }");
  lines.push("");
  lines.push("    private fun fmt(v: Float): String = ((v * 100f).toInt() / 100f).toString()");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

export function registerSurfacePlacementTools(server: McpServer) {
  server.registerTool(
    "generate_surface_placement_kotlin",
    {
      description:
        "Seat a BAKED model on a DETECTED real-world surface (FLOOR/TABLE/WALL/BED/CABINET…) — the MR placement recipe, generated instead of hand-written. Emits a self-contained Kotlin object whose seat(root, add) detects the plane, converts anchor space into the scene root's space, seats the model with the right base lift, and attaches a PRIMITIVE box collider plus the required PhysicsWorldComponent. It bakes in five silent traps measured on 2026-07-29: a one-shot plane query returns 0 (the Stage entry animation is still running — so it POLLS), the emulator's floor is at y=0.40 not 0 (so height comes from the plane, never a constant), anchor space needs root.convertPositionFrom, downloaded/generated models are origin-CENTRED (so half-height lift), and MESH colliders never register in PICO's queryable physics world (so the collider is a box). Pair with bake_textured_model — a raw runtime-loaded GLB renders black. REQUIRES an open Stage — any stage style, Mixed (1) included; a WindowContainer returns 0 planes ('Full Space' in older notes meant open-Stage, not stageStyle 3).",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content"),
        objectName: z.string().default("SurfacePlacement").describe("Generated object name (e.g. TablePlacement)."),
        bundleAsset: z.string().describe("Baked bundle URI from bake_textured_model, e.g. asset://table.bundle"),
        modelName: z.string().describe("Model name inside the bundle (bake_textured_model returns it)."),
        semantic: z.enum(SEMANTICS).default("FLOOR").describe("Target plane label. Falls back to the largest same-orientation plane when the label is absent."),
        modelSize: z.array(z.number()).length(3).describe("Measured [x,y,z] metres of the model — read them from the source GLB accessors, do not guess."),
        originAt: z.enum(["center", "bottom"]).default("center").describe("Where the model's origin sits. Meshy/most generated GLBs are 'center' (Meshy can emit bottom via origin_at). Prefer passing a measured baseLift instead."),
        baseLift: z.number().optional().describe("MEASURED distance from the model's origin down to its lowest point, straight from measure_model. Overrides originAt, and is exact for models that are neither centred nor bottom-origin."),
        collider: z.enum(["boxTop", "boxFull", "none"]).default("boxTop").describe("boxTop = a slab across the model's top (things can rest on it); boxFull = the whole bbox; none."),
        pollSeconds: z.number().int().min(1).max(60).default(20).describe("How many 1-second retries to wait for planes (Stage entry can take seconds)."),
      },
    },
    async ({ packageName, objectName, bundleAsset, modelName, semantic, modelSize, originAt, baseLift, collider, pollSeconds }) => {
      const kotlin = surfacePlacementKotlin({
        packageName,
        objectName: objectName ?? "SurfacePlacement",
        bundleAsset,
        modelName,
        semantic: semantic ?? "FLOOR",
        modelSize: modelSize as [number, number, number],
        originAt: originAt ?? "center",
        baseLift,
        collider: collider ?? "boxTop",
        pollSeconds: pollSeconds ?? 20,
      });
      return okJson({
        kotlin,
        targetPath: `app/src/main/java/${packageName.replace(/\./g, "/")}/${objectName ?? "SurfacePlacement"}.kt`,
        usage: `${objectName ?? "SurfacePlacement"}.seat(sceneRoot) { sceneRoot.addChild(it) }  // inside SpatialView.initial`,
        requires: [
          "An OPEN Stage — any stage style, Mixed (1) included; the requirement is Stage-not-WindowContainer, NOT stageStyle 3. A WindowContainer or a query before the Stage opens returns 0 planes.",
          `The baked bundle at ${bundleAsset} must ship in app/src/main/assets/ (bake_textured_model writes it).`,
          "Stage style 1 (Mixed — the default presentation) or 2 (Progressive) shows the real room behind the model; 3 (Full) seats it against the app's own environment.",
        ],
        verify: [
          "logcat 'SURFACE| planes=N after R retries' then 'SURFACE| seated <model> on <SEMANTIC> at (x,y,z)'.",
          "LOOK at a capture — a model resting on a real surface is the only proof that the height was right.",
          "Raycast down onto it to prove the collider is queryable, not merely attached.",
        ],
      });
    },
  );
}
