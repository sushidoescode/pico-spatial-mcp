import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, fail } from "./util.js";

/**
 * menu.ts — generate_game_menu_kotlin: the VERIFIED in-world game menu pattern, with an AAA 3D feel.
 *
 * Built + tested + VISION-confirmed in menuxr-native (2026-06-30): a floating menu panel
 * (START/PAUSE/RESUME/RESET) whose selection highlight + cursor land EXACTLY on each button,
 * driving a set of AnimationPlaybackControllers (pause/resume/reset a live "game").
 *
 * The non-obvious facts this tool bakes in so they don't have to be rediscovered:
 *  - The panel MUST be a VERTICAL baked textured quad. A Blender `primitive_plane_add` is
 *    HORIZONTAL; after the glTF Y-up conversion it lies flat (table-top) in app X-Z and the
 *    createPlane highlight ends up PERPENDICULAR to it. Rebake with rotation_euler=(radians(90),0,0)
 *    so the quad stands vertical in app X-Y (normal +Z toward viewer, texture-V -> panel-local +Y),
 *    matching the createPlane convention. See the make_panel.py snippet in the usage note.
 *  - The highlight + cursor are CHILDREN of the panel, so they ride the panel face and stay on the
 *    right button even when the emulator free camera drifts (C2).
 *  - Each button's panel-local Y is computed ANALYTICALLY from the texture row centers (NOT eyeballed):
 *    y = ((1 - rowPx/textureHeight) - 0.5) * planeHeight. Verified observed==commanded on-emulator.
 *  - select(action) is the SINGLE entry point: a DEBUG_CMD broadcast drives it on the emulator (C3:
 *    no controller), and a gaze/controller hit drives the same method on a headset.
 *  - AAA 3D feel (default on): a LIT beveled backing slab (createBox + PhysicallyBasedMaterial) gives
 *    the panel real depth/frame, a point light makes it pop, and a gentle idle-bob tween makes it
 *    float. select() never touches the panel transform, so the bob never fights the selection.
 */
export function registerMenuTools(server: McpServer) {
  server.registerTool(
    "generate_game_menu_kotlin",
    {
      description:
        "Emit GameMenu.kt — a REAL in-world game menu (start/pause/resume/reset or custom buttons) with an AAA 3D feel, the way menuxr-native verified it. You provide a VERTICAL baked textured panel (bake_textured_model of a +90°X-rotated plane — see the usage note) and a list of AnimationPlaybackControllers; the menu adds a LIT 3D backing slab (depth/frame), a point light (pop) and a gentle idle-bob float, places a translucent highlight + bright cursor (both panel children, so camera drift never moves them off-button), and snaps them to each button via per-button panel-local Y computed ANALYTICALLY from the texture rows. select(action) is one entry point driven by a DEBUG_CMD broadcast on the emulator (no controller, C3) and by gaze/controller on a headset. Selection alignment is VISION-verifiable; pause/resume freezing is structurally verifiable via the Agent Bridge dump_scene.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content"),
        panelModelName: z.string().optional().describe('Baked panel model name loaded via Entity.loadSuspend (default "menu" — i.e. menu.bundle from bake_textured_model).'),
        panelPosition: z.array(z.number()).optional().describe("Panel world position [x,y,z] (default [0.85,1.45,-2.0] = to the right at eye level)."),
        panelScale: z.number().optional().describe("Uniform panel scale (default 0.85). Children inherit it, so highlight/cursor/slab sizes are in the same panel-local units as the panel mesh."),
        planeHeight: z.number().optional().describe("The panel quad's full height in mesh units before scale (default 0.755 = a 900x680 texture's 680/900 aspect). Half of this is the panel half-height used for the Y formula."),
        textureHeight: z.number().optional().describe("Panel texture height in px (default 680). Used with rowPx to compute each button's panel-local Y."),
        buttons: z
          .array(z.object({ action: z.string(), rowPx: z.number() }))
          .optional()
          .describe('Buttons as {action, rowPx} where rowPx is the button row CENTER in the texture (top=0). Default the verified 4: start@205, pause@315, resume@425, reset@535. Action names start/pause/resume/reset get built-in controller behavior; any other name calls a customActions[name] lambda.'),
        highlightOpacity: z.number().optional().describe("Translucent highlight fill opacity over the active button (default 0.6)."),
        cursorX: z.number().optional().describe("Panel-local X of the cursor marker (default -0.36 = left end of the button row)."),
        backingSlab: z.boolean().optional().describe("Add a LIT beveled 3D backing slab behind the face for depth/frame (default true = AAA)."),
        pointLight: z.boolean().optional().describe("Add a point light in front of the panel so the slab catches specular (default true)."),
        idleBob: z.boolean().optional().describe("Gently float the whole panel with a position tween (default true). Never conflicts with selection (select doesn't touch the panel transform)."),
        handInput: z.boolean().optional().describe("Also emit GameMenuHandInput — a HEADSET-ONLY hand-tracking path: a PINCH (thumb-tip↔index-tip) near a button pokes GameMenu.select. Default false. Compiles against the tracking module but is UNVERIFIABLE on the emulator (HandTrackingProvider returns no hands — C1). Call GameMenuHandInput.start() after attach."),
      },
    },
    async ({ packageName, panelModelName, panelPosition, panelScale, planeHeight, textureHeight, buttons, highlightOpacity, cursorX, backingSlab, pointLight, idleBob, handInput }) => {
      const model = panelModelName ?? "menu";
      const pos = (panelPosition ?? [0.85, 1.45, -2.0]) as number[];
      if (pos.length !== 3) return fail("panelPosition must be [x,y,z] (3 numbers).");
      const scale = panelScale ?? 0.85;
      const ph = planeHeight ?? 0.755;
      const texH = textureHeight ?? 680;
      const btns = buttons ?? [
        { action: "start", rowPx: 205 },
        { action: "pause", rowPx: 315 },
        { action: "resume", rowPx: 425 },
        { action: "reset", rowPx: 535 },
      ];
      if (!btns.length) return fail("buttons must be a non-empty list.");
      const opacity = highlightOpacity ?? 0.6;
      const curX = cursorX ?? -0.36;
      const slabOn = backingSlab !== false;
      const lightOn = pointLight !== false;
      const bobOn = idleBob !== false;
      const handOn = handInput === true;

      // Analytical panel-local Y per button: y = ((1 - rowPx/texH) - 0.5) * planeHeight.
      const btnY = btns.map((b) => {
        const V = 1 - b.rowPx / texH;
        const y = (V - 0.5) * ph;
        return { action: b.action, y: +y.toFixed(4) };
      });
      const spacing = btns.length > 1 ? Math.abs((btns[btns.length - 1].rowPx - btns[0].rowPx) / (btns.length - 1)) : 110;
      const hlHeight = +(((spacing * 0.92) / texH) * ph).toFixed(3); // a touch under one row
      const hlWidth = 0.82; // ~ button width in panel-local units (panel mesh width is 1.0)
      const slabH = +(ph + 0.105).toFixed(3); // a touch taller than the panel face -> visible frame
      const rowHalf = +(((spacing / 2) / texH) * ph).toFixed(4); // panel-local half-row (poke tolerance)

      const btnYEntries = btnY.map((b) => `"${b.action}" to ${b.y}f`).join(", ");

      const imports = [
        "import android.util.Log",
        "import com.pico.spatial.core.ecs.Entity",
        "import com.pico.spatial.core.ecs.ModelComponent",
        "import com.pico.spatial.core.ecs.TransformComponent",
        "import com.pico.spatial.core.ecs.animation.AnimationPlaybackController",
        "import com.pico.spatial.core.ecs.resource.BlendingMode",
        "import com.pico.spatial.core.ecs.resource.MeshResource",
        "import com.pico.spatial.core.ecs.resource.UnlitMaterial",
        "import com.pico.spatial.core.math.Color4",
        "import com.pico.spatial.core.math.Quat",
        "import com.pico.spatial.core.math.Vector3",
      ];
      if (slabOn) imports.push("import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial");
      if (lightOn) imports.push("import com.pico.spatial.core.ecs.PointLightComponent");
      if (bobOn) imports.push(
        "import com.pico.spatial.core.ecs.animation.AnimationBindTarget",
        "import com.pico.spatial.core.ecs.animation.EaseType",
        "import com.pico.spatial.core.ecs.animation.RepeatMode",
        "import com.pico.spatial.core.ecs.animation.SpatialAnimation",
        "import com.pico.spatial.core.ecs.animation.TweenAnimation",
        "import com.pico.spatial.core.ecs.resource.AnimationResource",
      );
      if (handOn) imports.push(
        "import android.os.Handler",
        "import android.os.Looper",
        "import com.pico.spatial.tracking.DataProvider",
        "import com.pico.spatial.tracking.hand.HandJoint",
        "import com.pico.spatial.tracking.hand.HandPose",
        "import com.pico.spatial.tracking.hand.HandTrackingData",
        "import com.pico.spatial.tracking.hand.HandTrackingProvider",
        "import kotlin.math.abs",
        "import kotlin.math.sqrt",
      );

      const attachBody: string[] = [
        "    fun attach(sceneRoot: Entity, panel: Entity?, ctrls: List<AnimationPlaybackController>) {",
        "        controllers = ctrls",
        "        panel ?: run { Log.e(TAG, \"panel is null (bundle load failed?) — menu inert\"); return }",
        "        panel.components.set(TransformComponent(PANEL_POS, Quat.identity(), Vector3(SCALE, SCALE, SCALE)))",
        "        sceneRoot.addChild(panel)",
        ...(handOn ? ["        panelRef = panel"] : []),
        "",
      ];
      if (slabOn) attachBody.push(
        "        // (AAA) lit beveled 3D backing slab behind the face -> real depth + frame.",
        "        val slab = Entity().also { it.setName(\"MenuSlab\") }",
        "        val slabMat = PhysicallyBasedMaterial.create()",
        "        slabMat.setBaseColor(Color4(0.05f, 0.07f, 0.14f, 1f))",
        "        runCatching { slabMat.setMetallic(0.55f); slabMat.setRoughness(0.35f); slabMat.setEmissiveColor(Color4(0.05f, 0.08f, 0.18f, 1f)) }",
        `        slab.components.set(ModelComponent(MeshResource.createBox(Vector3(1.1f, ${slabH}f, 0.06f), 0.05f), slabMat))`,
        "        slab.components.set(TransformComponent(Vector3(0f, 0f, -0.04f), Quat.identity(), Vector3(1f, 1f, 1f)))",
        "        panel.addChild(slab)",
        "",
      );
      if (lightOn) attachBody.push(
        "        // (AAA) a point light in front so the metallic slab pops.",
        "        val light = Entity().also { it.setName(\"MenuLight\") }",
        "        light.components.set(TransformComponent(Vector3(0f, 0.05f, 0.5f), Quat.identity(), Vector3(1f, 1f, 1f)))",
        "        light.components.set(PointLightComponent(Color4(0.7f, 0.82f, 1f, 1f), 220f, 1.6f))",
        "        panel.addChild(light)",
        "",
      );
      attachBody.push(
        "        // translucent highlight fill over the active button (panel child -> rides the face).",
        "        val hl = Entity().also { it.setName(\"MenuHighlight\") }",
        "        val hlMat = UnlitMaterial.create(BlendingMode.TRANSPARENT)",
        `        hlMat.setBaseColor(Color4(1f, 1f, 1f, 1f)); hlMat.setOpacity(${opacity}f); hlMat.setDepthWrite(false)`,
        `        hl.components.set(ModelComponent(MeshResource.createPlane(${hlWidth}f, ${hlHeight}f, 0.02f), hlMat))`,
        "        hl.components.set(TransformComponent(Vector3(0f, 2f, HL_Z), Quat.identity(), Vector3(1f, 1f, 1f)))",
        "        panel.addChild(hl); highlight = hl",
        "",
        "        val cur = Entity().also { it.setName(\"MenuCursor\") }",
        "        val curMat = UnlitMaterial.create()",
        "        curMat.setBaseColor(Color4(0.2f, 1f, 1f, 1f)) // bright cyan, self-lit",
        "        cur.components.set(ModelComponent(MeshResource.createSphere(1f), curMat))",
        "        cur.components.set(TransformComponent(Vector3(0f, 2f, CUR_Z), Quat.identity(), Vector3(CUR_S, CUR_S, CUR_S)))",
        "        panel.addChild(cur); cursor = cur",
        "",
        "        // park the indicator on the first button so nothing floats before the first selection.",
        "        BTN_Y.values.firstOrNull()?.let { y ->",
        "            hl.components.set(TransformComponent(Vector3(BTN_X, y, HL_Z), Quat.identity(), Vector3(1f, 1f, 1f)))",
        "            cur.components.set(TransformComponent(Vector3(CURSOR_X, y, CUR_Z), Quat.identity(), Vector3(CUR_S, CUR_S, CUR_S)))",
        "        }",
      );
      if (bobOn) attachBody.push(
        "",
        "        // (AAA) gentle idle bob — never fights selection (select doesn't touch the panel).",
        "        runCatching {",
        "            val bob = TweenAnimation.createTweenAnimation(",
        "                name = \"menu_bob\", bindTarget = AnimationBindTarget.bindPosition(),",
        "                from = PANEL_POS, to = Vector3(PANEL_POS.x, PANEL_POS.y + 0.015f, PANEL_POS.z),",
        "                duration = 3.5f, repeatMode = RepeatMode.REVERSE,",
        "                repeatCount = SpatialAnimation.INFINITE, easeType = EaseType.EASE_INOUT,",
        "            )",
        "            panel.playAnimation(AnimationResource.generateWithTweenAnimation(bob))",
        "        }.onFailure { Log.e(TAG, \"idle bob failed: $it\") }",
      );
      attachBody.push(
        "        Log.i(TAG, \"GameMenu attached: ${BTN_Y.size} buttons, ${controllers.size} controllers\")",
        "    }",
      );

      const kt = [
        `package ${packageName}`,
        "",
        ...imports,
        "",
        "/**",
        " * Generated by generate_game_menu_kotlin — the verified in-world game menu (AAA 3D feel).",
        " *",
        " * Wire-up (see the tool's usage note for the panel bake + manifest receiver):",
        " *   1) Bake a VERTICAL textured panel quad -> assets/" + model + ".bundle (bake_textured_model).",
        " *   2) val bundle = AssetBundle.load(\"asset://" + model + ".bundle\")",
        " *      val panel  = Entity.loadSuspend(\"" + model + "\", bundle)   // on Dispatchers.IO",
        " *   3) GameMenu.attach(sceneRoot, panel, controllers)              // on Dispatchers.Main",
        " *   4) Drive it: a DEBUG_CMD broadcast (emulator) or a gaze/controller hit (headset) ->",
        " *      GameMenu.select(\"start\"|\"pause\"|\"resume\"|\"reset\").",
        " *",
        " * VERIFY: selection alignment is vision-verifiable (highlight+cursor land on the button);",
        " * pause/resume freezing is structurally verifiable via the Agent Bridge dump_scene.",
        " */",
        "object GameMenu {",
        '    private const val TAG = "GameMenu"',
        "",
        "    private var controllers: List<AnimationPlaybackController> = emptyList()",
        "    private var highlight: Entity? = null",
        "    private var cursor: Entity? = null",
        ...(handOn ? ["    private var panelRef: Entity? = null"] : []),
        "    /** Per-action lambdas. If an action has one it OVERRIDES the built-in controller behavior —",
        "     *  e.g. a physics demo maps \"pause\"->freeze sim, \"reset\"->rebuild. Set before/after attach. */",
        "    var customActions: Map<String, () -> Unit> = emptyMap()",
        "",
        `    private val PANEL_POS = Vector3(${pos[0]}f, ${pos[1]}f, ${pos[2]}f)`,
        `    private const val SCALE = ${scale}f`,
        "    // Panel-local Y of each button, computed analytically from the texture rows at gen time:",
        "    //   y = ((1 - rowPx/" + texH + ") - 0.5) * " + ph + "   (panel half-height = " + (ph / 2).toFixed(4) + ", +Y=up)",
        `    private val BTN_Y = mapOf(${btnYEntries})`,
        "    private const val BTN_X = 0.0f      // buttons centered on the panel",
        `    private const val CURSOR_X = ${curX}f // left end of the active button`,
        "    private const val HL_Z = 0.012f     // highlight sits just in front of the panel face",
        "    private const val CUR_Z = 0.04f",
        "    private const val CUR_S = 0.03f",
        "",
        "    /** Place the panel, build the highlight + cursor as panel children, and bind the controllers. */",
        ...attachBody,
        "",
        "    /** The single entry point — snap the indicator to the row and apply the action. @MainThread. */",
        "    fun select(action: String) {",
        "        BTN_Y[action]?.let { y ->",
        "            runCatching { highlight?.components?.set(TransformComponent(Vector3(BTN_X, y, HL_Z), Quat.identity(), Vector3(1f, 1f, 1f))) }",
        "                .onFailure { Log.e(TAG, \"highlight move failed: $it\") }",
        "            runCatching { cursor?.components?.set(TransformComponent(Vector3(CURSOR_X, y, CUR_Z), Quat.identity(), Vector3(CUR_S, CUR_S, CUR_S))) }",
        "                .onFailure { Log.e(TAG, \"cursor move failed: $it\") }",
        "        }",
        "        val custom = customActions[action]",
        "        when {",
        "            custom != null -> runCatching { custom.invoke() }.onFailure { Log.e(TAG, \"custom $action failed: $it\") }",
        "            action == \"pause\" -> controllers.forEach { runCatching { it.setSpeed(0f); it.pause() } }",
        "            action == \"start\" || action == \"resume\" -> controllers.forEach { runCatching { it.setSpeed(1f); it.resume() } }",
        "            action == \"reset\" -> controllers.forEach { runCatching { it.setTime(0f); it.setSpeed(1f); it.resume() } }",
        "            else -> Log.w(TAG, \"no behavior for action '$action'\")",
        "        }",
        "        Log.i(TAG, \"select($action): ${controllers.size} controllers updated\")",
        "    }",
        ...(handOn ? [
          "",
          "    /** (handInput) Poke the nearest button to a WORLD point (e.g. a fingertip). @MainThread. */",
          "    internal fun pokeNearestRow(world: Vector3) {",
          "        val t = panelRef?.components?.get(TransformComponent::class.java) ?: return",
          "        val p = t.position",
          "        val lx = (world.x - p.x) / SCALE; val ly = (world.y - p.y) / SCALE; val lz = (world.z - p.z) / SCALE",
          `        if (abs(lz) > 0.12f || abs(lx - BTN_X) > 0.55f) return // not on the panel face / off to the side`,
          "        val hit = BTN_Y.minByOrNull { abs(it.value - ly) } ?: return",
          `        if (abs(hit.value - ly) <= ${rowHalf}f) select(hit.key)`,
          "    }",
        ] : []),
        "}",
        ...(handOn ? [
          "",
          "/**",
          " * GameMenuHandInput — HEADSET-ONLY hand-tracking for the menu (generate_game_menu_kotlin handInput).",
          " * A PINCH (thumb-tip↔index-tip) pokes the nearest button under the index fingertip. The emulator",
          " * has no hands (HandTrackingProvider returns null poses — C1), so this is unverifiable there but",
          " * compiles against the tracking module and lights up on a headset. Call start() after attach().",
          " */",
          "object GameMenuHandInput {",
          '    private const val TAG = "GameMenuHand"',
          "    private const val PINCH_DIST = 0.035f // metres: thumb-tip to index-tip = a pinch",
          "    private val provider = HandTrackingProvider()",
          "    private val main = Handler(Looper.getMainLooper())",
          "    private var leftWas = false",
          "    private var rightWas = false",
          "    // NOTE: onProvideData is NOT on the main thread -> post the entity touch to main.",
          "    private val listener = DataProvider.DataListener<HandTrackingData> { d ->",
          "        leftWas = pinch(d.left, leftWas); rightWas = pinch(d.right, rightWas)",
          "    }",
          "",
          "    fun start() = runCatching { provider.start(); provider.addListener(listener); Log.i(TAG, \"hand input started (headset-only)\") }",
          "        .onFailure { Log.e(TAG, \"start failed: $it\") }.let { }",
          "    fun stop() = runCatching { provider.removeListener(listener); provider.stop() }.let { }",
          "",
          "    private fun pinch(pose: HandPose?, was: Boolean): Boolean {",
          "        pose ?: return false",
          "        val thumb = runCatching { pose[HandJoint.Index.THUMB_TIP].position }.getOrNull() ?: return was",
          "        val index = runCatching { pose[HandJoint.Index.INDEX_TIP].position }.getOrNull() ?: return was",
          "        val now = dist(thumb, index) < PINCH_DIST",
          "        if (now && !was) main.post { GameMenu.pokeNearestRow(index) } // rising edge = a fresh pinch",
          "        return now",
          "    }",
          "",
          "    private fun dist(a: Vector3, b: Vector3): Float {",
          "        val dx = a.x - b.x; val dy = a.y - b.y; val dz = a.z - b.z",
          "        return sqrt(dx * dx + dy * dy + dz * dz)",
          "    }",
          "}",
        ] : []),
        "",
      ].join("\n");

      const py = [
        "# make_panel.py — bake a VERTICAL textured menu panel (run with Blender -b -P).",
        "#   blender -b -P make_panel.py -- <menu.png> <out.glb>",
        "import bpy, sys",
        "from math import radians",
        "tex, out = sys.argv[sys.argv.index('--')+1:][:2]",
        "bpy.ops.wm.read_factory_settings(use_empty=True)",
        "bpy.ops.mesh.primitive_plane_add(size=1.0)",
        "obj = bpy.context.active_object",
        `obj.scale = (1.0, ${(ph).toFixed(3)}, 1.0)            # texture aspect (height/width)`,
        "obj.rotation_euler = (radians(90), 0, 0)   # STAND IT VERTICAL (key step)",
        "bpy.ops.object.transform_apply(rotation=True, scale=True)",
        "mat = bpy.data.materials.new('panel'); mat.use_nodes = True; obj.data.materials.append(mat)",
        "nt = mat.node_tree; bsdf = nt.nodes.get('Principled BSDF')",
        "img = nt.nodes.new('ShaderNodeTexImage'); img.image = bpy.data.images.load(tex)",
        "nt.links.new(img.outputs['Color'], bsdf.inputs['Base Color'])",
        "emis = bsdf.inputs.get('Emission Color') or bsdf.inputs.get('Emission')",
        "if emis: nt.links.new(img.outputs['Color'], emis)",
        "if 'Emission Strength' in bsdf.inputs: bsdf.inputs['Emission Strength'].default_value = 1.35",
        "bpy.ops.export_scene.gltf(filepath=out, export_format='GLB')",
      ].join("\n");

      const note = [
        "// ── USAGE ──────────────────────────────────────────────────────────────────",
        "// 1) BAKE THE PANEL (vertical!). Author a menu.png (e.g. 900x680, one colored bar per",
        "//    button), then run the make_panel.py below, then bake_textured_model the GLB:",
        "//      bake_textured_model { modelPath: menu.glb, outBundle: menu.bundle, compressTextures: astc6x6 }",
        "//    Copy menu.bundle into app/src/main/assets. If you change the texture's row layout,",
        "//    pass the new {action,rowPx}+textureHeight to this tool so BTN_Y stays correct.",
        "//",
        "// 2) MANIFEST RECEIVER (emulator drive, C3 — no controller). In your Application:",
        "//      val f = IntentFilter(\"$packageName.DEBUG_CMD\")",
        "//      registerReceiver(object: BroadcastReceiver(){ override fun onReceive(c:Context,i:Intent){",
        "//          i.getStringExtra(\"cmd\")?.let { GameMenu.select(it) } } }, f, RECEIVER_EXPORTED)",
        "//    Drive it:  adb shell am broadcast -a <pkg>.DEBUG_CMD --es cmd pause   (start|pause|resume|reset)",
        "//",
        "// 3) HEADSET: hit-test the panel with gaze/controller and call the SAME GameMenu.select(action).",
        "//",
        "// VERIFY: aim the free cam with emulator_look, capture_frame each state, LOOK (highlight+cursor",
        "//    on the right button); prove pause-freeze with the Agent Bridge dump_scene (frozen transforms).",
        "//",
        "// ── make_panel.py ──",
        py.split("\n").map((l) => "// " + l).join("\n"),
      ].join("\n");

      return ok(kt + "\n\n" + note + "\n");
    },
  );
}
