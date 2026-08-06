import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./util.js";

/**
 * tappable.ts — v31 `generate_tappable_detail_kotlin`: turn inert NAMED entities into tappable
 * detail views (the mrtable next-move: "the columns are inert").
 *
 * Composes three individually proven recipes rather than inventing a new one:
 *  - InteractableComponent + PRIMITIVE box CollisionComponent (the 5-arg ctor) — the vault-confirmed
 *    interactable recipe from generate_interaction_kotlin (mesh colliders never register).
 *  - The colour-keyed InteractableRegistry (generate_interactable_registry_kotlin): each item is
 *    add()ed and publish()ed so the INTERACTABLES| marker names every tappable for bridge consumers.
 *  - The HUD live-update channel: the generated wiring routes DEBUG_CMD 'hud:<key>=<value>' to
 *    HudState.set (assemble.ts, vision-verified live text v9.4), so select(id) pushes the item's
 *    detail text onto the panel. The panel activity is started FROM THE APP because `adb shell
 *    am start` cannot launch a 2D task while the Stage holds Full Space (mrtable seq 15).
 *
 * The COMPOSITION is new codegen: it compiles against SDK 0.13.3 idioms and is broadcast-drivable
 * on the emulator (select:<id>); it has not itself been vision-verified end-to-end. A real tap
 * needs a registry-driven bridge consumer (not yet shipped) or Swan controller/gaze (C3).
 */

/** Kotlin string literal: JSON escaping matches Kotlin's, but `$` must not interpolate. */
function kstr(s: string): string {
  return JSON.stringify(s).replace(/\$/g, "\\$");
}

export function registerTappableDetailTools(server: McpServer) {
  server.registerTool(
    "generate_tappable_detail_kotlin",
    {
      description:
        "Emit TappableDetail.kt — make NAMED child entities tappable detail views: each listed entity gets InteractableComponent + a PRIMITIVE box collider (the verified 5-arg CollisionComponent ctor; mesh colliders never register on PICO), is registered in the colour-keyed InteractableRegistry (published as the INTERACTABLES|<json> logcat marker), and select(id) applies a scale-bump highlight (scaleVector — a same-scale highlight is invisible) then fires the proven HUD live-update channel (an in-app DEBUG_CMD broadcast 'hud:<key>=<value>' that the generated wiring routes to HudState.set) so the detail panel expands with the item's text; the panel activity is started FROM the app (adb am start cannot open a 2D task while the Stage holds Full Space — measured, mrtable seq 15). HONEST EVIDENCE: every ingredient is individually emulator-proven (interactable recipe, scaleVector highlight, hud: live text, app-started panel), but THIS composition is new codegen — compiles-against-SDK + broadcast-drivable (adb shell am broadcast -a <pkg>.DEBUG_CMD --es cmd select:<id>), not yet vision-verified end-to-end; a real pointer tap is Swan (C3). REQUIRES in the same package: InteractableRegistry.kt (generate_interactable_registry_kotlin) and HudPanel.kt + the hud: route (generate_panel_compose_kotlin + wiring). RETURNS raw Kotlin; route DEBUG_CMD 'select:<id>' to TappableDetail.select.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content (must also hold InteractableRegistry + HudPanel)."),
        items: z
          .array(
            z.object({
              id: z.string().describe("The entity NAME to make tappable (matched by walking the scene root's children)."),
              colorHex: z.string().describe("The item's registry colour, '#RRGGBB' — how a colour-keyed bridge locates it in the framebuffer."),
              detail: z.string().optional().describe("Detail text pushed to the HUD on select (default: the id)."),
            }),
          )
          .min(1)
          .describe("The named entities to wire, in registry slot order."),
        hudKey: z.string().default("detail").describe("HudPanel field key the detail text is written to (add this key to the panel's fields)."),
        highlightScale: z.number().optional().describe("Scale multiplier on the selected entity (default 1.15)."),
        boxSize: z.array(z.number()).length(3).optional().describe("Collider FULL box extents [x,y,z] metres (default [0.4,0.4,0.4])."),
        showPanelOnSelect: z.boolean().default(true).describe("Start HudPanelActivity from the app on select (the only launch path in Full Space)."),
      },
    },
    async ({ packageName, items, hudKey, highlightScale, boxSize, showPanelOnSelect }) => {
      const hs = highlightScale ?? 1.15;
      const box = (boxSize && boxSize.length === 3 ? boxSize : [0.4, 0.4, 0.4]) as number[];
      const key = hudKey ?? "detail";
      const kt = [
        `package ${packageName}`,
        "",
        "import android.content.Context",
        "import android.content.Intent",
        "import android.os.Handler",
        "import android.os.Looper",
        "import android.util.Log",
        "import com.pico.spatial.core.ecs.CollisionComponent",
        "import com.pico.spatial.core.ecs.Entity",
        "import com.pico.spatial.core.ecs.InteractableComponent",
        "import com.pico.spatial.core.ecs.TransformComponent",
        "import com.pico.spatial.core.ecs.resource.PhysicsMaterialResource",
        "import com.pico.spatial.core.ecs.resource.ShapeResource",
        "import com.pico.spatial.core.ecs.simulation.CollisionFilter",
        "import com.pico.spatial.core.ecs.simulation.CollisionGroup",
        "import com.pico.spatial.core.ecs.simulation.CollisionInfoDetailLevel",
        "import com.pico.spatial.core.ecs.simulation.CollisionResponseMode",
        "import com.pico.spatial.core.math.Vector3",
        "",
        "/**",
        " * Generated by generate_tappable_detail_kotlin. NAMED child entities become tappable detail",
        " * views: InteractableComponent + a PRIMITIVE box collider, registered in the colour-keyed",
        " * InteractableRegistry (INTERACTABLES| marker), and select(id) scale-bumps the entity and",
        " * fires DEBUG_CMD 'hud:<key>=<value>' so the HUD panel expands with the item's detail text.",
        " * Wire once after the scene loads:  TappableDetail.wire(sceneRoot, context)",
        " * Route in dispatchDebugCommand:    cmd.startsWith(\"select:\") -> TappableDetail.select(cmd.removePrefix(\"select:\"))",
        " * Drive on the emulator:            adb shell am broadcast -a <pkg>.DEBUG_CMD --es cmd select:<id>",
        " */",
        "object TappableDetail {",
        '    private const val TAG = "TappableDetail"',
        `    private const val HUD_KEY = ${kstr(key)}`,
        `    private const val SHOW_PANEL = ${showPanelOnSelect !== false}`,
        `    var highlightScale = ${hs}f`,
        "",
        "    data class Item(val id: String, val colorHex: String, val detail: String)",
        "    val ITEMS = listOf(",
        ...items.map((it) => `        Item(${kstr(it.id)}, ${kstr(it.colorHex)}, ${kstr(it.detail ?? it.id)}),`),
        "    )",
        "",
        "    private val wired = LinkedHashMap<String, Entity>()",
        "    private val baseScale = HashMap<String, Vector3>()",
        "    private var appContext: Context? = null",
        "    var selected: String? = null",
        "        private set",
        "",
        "    private val mainHandler = Handler(Looper.getMainLooper())",
        "",
        "    // Scene mutation must run on the main thread; broadcast-driven select arrives on a binder thread.",
        "    private fun onMain(block: () -> Unit) {",
        "        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)",
        "    }",
        "",
        "    /** Find each named child of [root], attach interactable + collider, publish the registry. */",
        "    fun wire(root: Entity, context: Context) {",
        "        appContext = context.applicationContext",
        "        InteractableRegistry.clear()",
        "        ITEMS.forEachIndexed { slot, item ->",
        "            val e = find(root, item.id)",
        "            if (e == null) { Log.w(TAG, \"TAPPABLE| missing entity '\" + item.id + \"'\"); return@forEachIndexed }",
        "            runCatching {",
        "                e.components.set(InteractableComponent())",
        "                e.components.set(",
        "                    CollisionComponent(",
        `                        listOf(ShapeResource.createBox(Vector3(${box[0]}f, ${box[1]}f, ${box[2]}f))),`,
        "                        PhysicsMaterialResource(0.5f, 0.5f, 0f),",
        "                        // v35.13: TRIGGER_LITE, not COLLIDER_FULL — a tap target with COLLIDER_FULL is a physical",
        "                        // obstacle. Both this and every ScenePhysics body default to COLLISION_FILTER_DEFAULT",
        "                        // (group 1u, mask ALL) which always pairs, so a selectable card used to be an invisible",
        "                        // wall that dynamic bodies bounced off. PICO's tap target is TRIGGER_LITE on a private",
        "                        // group: InteractionReceiver.kt:49-55. Group stays bit 0 so rayCast still picks it; the",
        "                        // MASK is what excludes physics.",
        "                        CollisionResponseMode.TRIGGER_LITE,",
        "                        CollisionFilter(CollisionGroup(1u), CollisionGroup(1u)),",
        "                        CollisionInfoDetailLevel.BRIEF,",
        "                    ),",
        "                )",
        "                baseScale[item.id] = e.components.get<TransformComponent>()?.scaleVector ?: Vector3(1f, 1f, 1f)",
        "                wired[item.id] = e",
        "                InteractableRegistry.add(item.id, item.colorHex, slot)",
        "            }.onFailure { Log.e(TAG, \"TAPPABLE| wire '\" + item.id + \"' failed: \" + it.message) }",
        "        }",
        "        InteractableRegistry.publish()",
        "        Log.i(TAG, \"TAPPABLE| wired=\" + wired.size + \"/\" + ITEMS.size)",
        "    }",
        "",
        "    /** Select [id]: scale-bump highlight + expand the HUD detail panel with its text. */",
        "    fun select(id: String) = onMain {",
        "        val item = ITEMS.firstOrNull { it.id == id }",
        "        if (item == null) { Log.w(TAG, \"TAPPABLE| unknown id '\" + id + \"'\"); return@onMain }",
        "        setHighlight(selected, false)",
        "        selected = id",
        "        setHighlight(id, true)",
        "        val ctx = appContext",
        "        if (ctx == null) { Log.w(TAG, \"TAPPABLE| no context — call wire() first\"); return@onMain }",
        "        if (SHOW_PANEL) {",
        "            // `adb shell am start` cannot open a 2D task while the Stage holds Full Space —",
        "            // the panel must be started FROM the app (measured 2026-07-30, mrtable seq 15).",
        "            runCatching {",
        "                ctx.startActivity(",
        `                    Intent().setClassName(ctx.packageName, "${packageName}.HudPanelActivity")`,
        "                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),",
        "                )",
        "            }.onFailure { Log.w(TAG, \"TAPPABLE| panel activity not shown: \" + it.message) }",
        "        }",
        "        // The proven live-update channel: the wiring receiver routes 'hud:<key>=<value>' to HudState.set.",
        "        ctx.sendBroadcast(",
        "            Intent(ctx.packageName + \".DEBUG_CMD\").setPackage(ctx.packageName)",
        "                .putExtra(\"cmd\", \"hud:\" + HUD_KEY + \"=\" + item.detail),",
        "        )",
        "        Log.i(TAG, \"TAPPABLE| selected=\" + id)",
        "    }",
        "",
        "    private fun setHighlight(id: String?, on: Boolean) {",
        "        val e = id?.let { wired[it] } ?: return",
        "        val tc = e.components.get<TransformComponent>() ?: return",
        "        val base = baseScale[id] ?: Vector3(1f, 1f, 1f)",
        "        val f = if (on) highlightScale else 1f",
        "        runCatching { tc.scaleVector = Vector3(base.x * f, base.y * f, base.z * f) }",
        "            .onFailure { Log.e(TAG, \"TAPPABLE| highlight '\" + id + \"' failed: \" + it.message) }",
        "    }",
        "",
        "    private fun find(root: Entity, name: String): Entity? {",
        "        if (root.getName() == name) return root",
        "        for (c in runCatching { root.getChildren() }.getOrDefault(emptyArray())) {",
        "            val hit = find(c, name)",
        "            if (hit != null) return hit",
        "        }",
        "        return null",
        "    }",
        "}",
        "",
      ].join("\n");
      return ok(kt);
    },
  );
}
