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
 *  - The button caps, underline, flash + cursor are CHILDREN of the panel, so they ride the panel
 *    face and stay on the right button even when the emulator free camera drifts (C2).
 *  - Each button's panel-local Y is computed ANALYTICALLY from the texture row centers (NOT eyeballed):
 *    y = ((1 - rowPx/textureHeight) - 0.5) * planeHeight. Verified observed==commanded on-emulator.
 *  - select(action) is the SINGLE entry point: a DEBUG_CMD broadcast drives it on the emulator (C3:
 *    no controller), and a gaze/controller hit drives the same method on a headset.
 *  - AAA 3D feel (default on): a LIT beveled backing slab (createBox + PhysicallyBasedMaterial) gives
 *    the panel real depth/frame, a point light makes it pop, a gentle idle-bob tween makes it float,
 *    and each button is a RAISED GLASSY 3D CAP. select() lifts the active cap + slides a glowing
 *    underline to it, then PLUNGES the cap and springs it back (position TweenAnimation, EASE_OUT,
 *    REVERSE×1) with a ripple flash — a real button-press, not a flat colour wash. The press is a
 *    panel-local/cap-local animation, so the idle bob (on the panel) never fights it.
 */
export function registerMenuTools(server: McpServer) {
  server.registerTool(
    "generate_game_menu_kotlin",
    {
      description:
        "Emit GameMenu.kt — a REAL in-world game menu (start/pause/resume/reset or custom buttons) with an AAA 3D feel, the way menuxr-native verified it. You provide a VERTICAL baked textured panel (bake_textured_model of a +90°X-rotated plane — see the usage note) and a list of AnimationPlaybackControllers; the menu adds a LIT 3D backing slab (depth/frame), a point light (pop), a gentle idle-bob float, and — per button — a RAISED GLASSY 3D CAP (rounded createBox) so the panel reads as real raised buttons. select(action) lifts the active cap, slides a glowing underline + cursor to the row, and PLAYS A REAL BUTTON-PRESS ANIMATION: the cap PLUNGES in and springs back (a position TweenAnimation, EASE_OUT, REVERSE×1) with a quick ripple flash (an opacity tween) — not a flat colour wash. select(action) is one entry point driven by a DEBUG_CMD broadcast on the emulator (no controller, C3) and by gaze/controller on a headset. Selection alignment + the raised cap are VISION-verifiable; pause/resume freezing is structurally verifiable via the Agent Bridge dump_scene.",
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
        highlightOpacity: z.number().optional().describe("Peak opacity of the ripple flash that pulses on press (default 0.6)."),
        cursorX: z.number().optional().describe("Panel-local X of the cursor marker (default -0.36 = left end of the button row)."),
        backingSlab: z.boolean().optional().describe("Add a LIT beveled 3D backing slab behind the face for depth/frame (default true = AAA)."),
        pointLight: z.boolean().optional().describe("Add a point light in front of the panel so the slab catches specular (default true)."),
        idleBob: z.boolean().optional().describe("Gently float the whole panel with a position tween (default FALSE — a still panel reads as firmly anchored in space, and the bob is auto-stopped the moment you move the panel anyway). Set true for the floating look."),
        handInput: z.boolean().optional().describe("Also emit GameMenuHandInput — a HEADSET-ONLY hand-tracking path: a PINCH (thumb-tip↔index-tip) near a button pokes GameMenu.select. Default false. Compiles against the tracking module but is UNVERIFIABLE on the emulator (HandTrackingProvider returns no hands — C1). Call GameMenuHandInput.start() after attach."),
        faceUser: z.boolean().optional().describe("Auto-orient the panel to FACE the user as it moves (billboard: yaw to turn toward you + pitch to tilt up/down) so it reads as a real 3D object, not a flat plane sliding on X/Y. Default true. The tilt is GENTLE + CLAMPED to ~12° (FACE_STRENGTH 0.5) so the emulator's vision-based click bridge still detects the buttons — a full face-the-user billboard slants them too far to click. On a headset (clicked by gaze/controller, not vision) you can raise FACE_STRENGTH/MAX_TILT. Recomputed on every nudgePanel + snap."),
        snapGrid: z.number().optional().describe("Grid size (metres) the panel snaps to when you drop it (bridge sends move:snap on release) for clean placement. Default 0.1. Set 0 to disable snapping."),
      },
    },
    async ({ packageName, panelModelName, panelPosition, panelScale, planeHeight, textureHeight, buttons, highlightOpacity, cursorX, backingSlab, pointLight, idleBob, handInput, faceUser, snapGrid }) => {
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
      const bobOn = idleBob === true;   // default OFF: a steady panel reads as anchored in space
      const faceUserOn = faceUser !== false;   // default ON: panel turns/tilts to face the user as it moves
      const snap = snapGrid ?? 0.1;            // grid size (m) for snap-on-drop; 0 disables
      const handOn = handInput === true;

      // Analytical panel-local Y per button: y = ((1 - rowPx/texH) - 0.5) * planeHeight.
      const btnY = btns.map((b) => {
        const V = 1 - b.rowPx / texH;
        const y = (V - 0.5) * ph;
        return { action: b.action, y: +y.toFixed(4) };
      });
      const spacing = btns.length > 1 ? Math.abs((btns[btns.length - 1].rowPx - btns[0].rowPx) / (btns.length - 1)) : 110;
      const hlHeight = +(((spacing * 0.92) / texH) * ph).toFixed(3); // a touch under one row
      const slabH = +(ph + 0.105).toFixed(3); // a touch taller than the panel face -> visible frame
      const rowHalf = +(((spacing / 2) / texH) * ph).toFixed(4); // panel-local half-row (poke tolerance)
      // 3D pressable button caps (panel mesh width is 1.0; one cap per button row).
      const capW = 0.84;
      const capH = +(hlHeight * 0.98).toFixed(3);
      const underW = +(capW * 0.86).toFixed(3);
      const underDy = +(-(capH * 0.46)).toFixed(4); // underline sits just below the button centre

      const btnYEntries = btnY.map((b) => `"${b.action}" to ${b.y}f`).join(", ");

      // Per-button accent colors so each glassy cap DEEPENS its own button (matching hue glosses,
      // it doesn't wash like a neutral white film). Known actions get the texture's button colors.
      const accent = (a: string): [number, number, number] =>
        ({ start: [0.30, 0.85, 0.42], pause: [0.97, 0.72, 0.18], resume: [0.32, 0.66, 0.97], reset: [0.93, 0.34, 0.34] } as Record<string, [number, number, number]>)[a] ?? [0.55, 0.9, 1.0];
      const capColorEntries = btns
        .map((b) => `"${b.action}" to Color4(${accent(b.action).map((c) => c + "f").join(", ")}, 1f)`)
        .join(", ");
      const capGlowEntries = btns
        .map((b) => { const [r, g, bl] = accent(b.action); return `"${b.action}" to Color4(${(r * 0.5).toFixed(3)}f, ${(g * 0.5).toFixed(3)}f, ${(bl * 0.5).toFixed(3)}f, 1f)`; })
        .join(", ");
      // Flash color = the accent pushed toward white, so a pulse reads as a BRIGHT tap of the
      // button's own hue (a same-colour flash over a same-colour button would be invisible).
      const bright = (c: number) => +(c + (1 - c) * 0.6).toFixed(3);
      const capFlashEntries = btns
        .map((b) => { const [r, g, bl] = accent(b.action); return `"${b.action}" to Color4(${bright(r)}f, ${bright(g)}f, ${bright(bl)}f, 1f)`; })
        .join(", ");

      const imports = [
        "import android.util.Log",
        "import com.pico.spatial.core.ecs.Entity",
        "import com.pico.spatial.core.ecs.ModelComponent",
        "import com.pico.spatial.core.ecs.TransformComponent",
        "import com.pico.spatial.core.ecs.animation.AnimationBindTarget",
        "import com.pico.spatial.core.ecs.animation.AnimationPlaybackController",
        "import com.pico.spatial.core.ecs.animation.EaseType",
        "import com.pico.spatial.core.ecs.animation.MaterialTarget",
        "import com.pico.spatial.core.ecs.animation.RepeatMode",
        "import com.pico.spatial.core.ecs.animation.SpatialAnimation",
        "import com.pico.spatial.core.ecs.animation.TweenAnimation",
        "import com.pico.spatial.core.ecs.resource.AnimationResource",
        "import com.pico.spatial.core.ecs.resource.BlendingMode",
        "import com.pico.spatial.core.ecs.resource.MeshResource",
        "import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial",
        "import com.pico.spatial.core.ecs.resource.UnlitMaterial",
        "import com.pico.spatial.core.math.Color4",
        "import com.pico.spatial.core.math.EulerAngles",
        "import com.pico.spatial.core.math.Quat",
        "import com.pico.spatial.core.math.Vector3",
        "import kotlin.math.atan2",
        "import kotlin.math.roundToInt",
        "import kotlin.math.sqrt",
      ];
      if (lightOn) imports.push("import com.pico.spatial.core.ecs.PointLightComponent");
      if (handOn) imports.push(
        "import android.os.Handler",
        "import android.os.Looper",
        "import com.pico.spatial.tracking.DataProvider",
        "import com.pico.spatial.tracking.hand.HandJoint",
        "import com.pico.spatial.tracking.hand.HandPose",
        "import com.pico.spatial.tracking.hand.HandTrackingData",
        "import com.pico.spatial.tracking.hand.HandTrackingProvider",
        "import kotlin.math.abs",
      );

      const attachBody: string[] = [
        "    fun attach(sceneRoot: Entity, panel: Entity?, ctrls: List<AnimationPlaybackController>) {",
        "        controllers = ctrls",
        "        panel ?: run { Log.e(TAG, \"panel is null (bundle load failed?) — menu inert\"); return }",
        "        panel.components.set(TransformComponent(PANEL_POS, Quat.identity(), Vector3(SCALE, SCALE, SCALE)))",
        "        sceneRoot.addChild(panel)",
        "        panelRef = panel; panelPos = PANEL_POS   // enable moving the panel around the room",
        "        applyPanel()                             // orient to face the user from the start (if FACE_USER)",
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
        "        // (AAA) a raised glassy 3D button CAP per row. They sit proud of the face so the panel",
        "        // reads as real raised buttons; the active one lifts and select() PLUNGES it like a press.",
        "        BTN_Y.forEach { (action, y) ->",
        "            val cap = Entity().also { it.setName(\"MenuCap_\" + action) }",
        "            val capMat = PhysicallyBasedMaterial.create()",
        "            val cColor = CAP_COLOR[action] ?: Color4(0.55f, 0.9f, 1f, 1f)",
        "            val cGlow = CAP_GLOW[action] ?: Color4(0.28f, 0.45f, 0.5f, 1f)",
        "            capMat.setBaseColor(cColor)",
        "            runCatching {",
        "                capMat.setBlendingMode(BlendingMode.TRANSPARENT); capMat.setOpacity(0.26f)",
        "                capMat.setMetallic(0.45f); capMat.setRoughness(0.2f)",
        "                capMat.setEmissiveColor(cGlow); capMat.setDepthWrite(false)",
        "            }",
        `            cap.components.set(ModelComponent(MeshResource.createBox(Vector3(${capW}f, ${capH}f, CAP_THICK), CAP_CORNER), capMat))`,
        "            cap.components.set(TransformComponent(Vector3(BTN_X, y, CAP_Z), Quat.identity(), Vector3(1f, 1f, 1f)))",
        "            panel.addChild(cap); caps[action] = cap",
        "            // a color-matched tap flash for THIS button (invisible at rest; pulses on press).",
        "            val fl = Entity().also { it.setName(\"MenuFlash_\" + action) }",
        "            val flMat = UnlitMaterial.create(BlendingMode.TRANSPARENT)",
        "            flMat.setBaseColor(CAP_FLASH[action] ?: Color4(0.85f, 0.97f, 1f, 1f)); flMat.setOpacity(0f); flMat.setDepthWrite(false)",
        `            fl.components.set(ModelComponent(MeshResource.createPlane(${capW}f, ${capH}f, 0.03f), flMat))`,
        "            fl.components.set(TransformComponent(Vector3(BTN_X, y, FLASH_Z), Quat.identity(), Vector3(1f, 1f, 1f)))",
        "            panel.addChild(fl); flashes[action] = fl",
        "        }",
        "",
        "        // a slim glowing UNDERLINE marks the active button (modern, not a flat colour wash).",
        "        val ul = Entity().also { it.setName(\"MenuUnderline\") }",
        "        val ulMat = UnlitMaterial.create(BlendingMode.TRANSPARENT)",
        "        ulMat.setBaseColor(Color4(0.30f, 0.95f, 1f, 1f)); ulMat.setOpacity(0.95f); ulMat.setDepthWrite(false)",
        `        ul.components.set(ModelComponent(MeshResource.createPlane(${underW}f, 0.014f, 0.007f), ulMat))`,
        "        ul.components.set(TransformComponent(Vector3(0f, 2f, MARK_Z), Quat.identity(), Vector3(1f, 1f, 1f)))",
        "        panel.addChild(ul); underline = ul",
        "",
        "        val cur = Entity().also { it.setName(\"MenuCursor\") }",
        "        val curMat = UnlitMaterial.create()",
        "        curMat.setBaseColor(Color4(0.2f, 1f, 1f, 1f)) // bright cyan, self-lit",
        "        cur.components.set(ModelComponent(MeshResource.createSphere(1f), curMat))",
        "        cur.components.set(TransformComponent(Vector3(0f, 2f, CUR_Z), Quat.identity(), Vector3(CUR_S, CUR_S, CUR_S)))",
        "        panel.addChild(cur); cursor = cur",
        "",
        "        // park the focus on the first button so nothing floats before the first interaction.",
        "        BTN_Y.keys.firstOrNull()?.let { selected = it; focus(it) }",
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
        "            bobCtrl = panel.playAnimation(AnimationResource.generateWithTweenAnimation(bob))",
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
        "    private val caps = mutableMapOf<String, Entity>()     // one raised 3D cap per button row",
        "    private val flashes = mutableMapOf<String, Entity>()  // a color-matched tap flash per row",
        "    private var underline: Entity? = null",
        "    private var cursor: Entity? = null",
        "    private var pressCtrl: AnimationPlaybackController? = null",
        "    private var flashCtrl: AnimationPlaybackController? = null",
        "    private var selected: String? = null   // the last COMMITTED button; hover previews others",
        "    private var panelRef: Entity? = null",
        "    private var bobCtrl: AnimationPlaybackController? = null  // idle bob; stopped when the panel is moved",
        "    private var panelPos = Vector3(0f, 0f, 0f)  // live panel position (updated by nudgePanel; set in attach)",
        "    /** Per-action lambdas. If an action has one it OVERRIDES the built-in controller behavior —",
        "     *  e.g. a physics demo maps \"pause\"->freeze sim, \"reset\"->rebuild. Set before/after attach. */",
        "    var customActions: Map<String, () -> Unit> = emptyMap()",
        "",
        `    private val PANEL_POS = Vector3(${pos[0]}f, ${pos[1]}f, ${pos[2]}f)`,
        `    private const val SCALE = ${scale}f`,
        "    // Panel-local Y of each button, computed analytically from the texture rows at gen time:",
        "    //   y = ((1 - rowPx/" + texH + ") - 0.5) * " + ph + "   (panel half-height = " + (ph / 2).toFixed(4) + ", +Y=up)",
        `    private val BTN_Y = mapOf(${btnYEntries})`,
        `    private val CAP_COLOR = mapOf<String, Color4>(${capColorEntries})`,
        `    private val CAP_GLOW = mapOf<String, Color4>(${capGlowEntries})`,
        `    private val CAP_FLASH = mapOf<String, Color4>(${capFlashEntries})`,
        "    private const val BTN_X = 0.0f      // buttons centered on the panel",
        `    private const val CURSOR_X = ${curX}f // left end of the active button`,
        "    private const val CAP_Z = 0.035f       // button cap rests proud of the panel face",
        "    private const val CAP_RAISE = 0.022f   // the active cap lifts further toward the viewer",
        "    private const val CAP_THICK = 0.05f",
        "    private const val CAP_CORNER = 0.02f  // <= CAP_THICK/2 so the rounded box stays valid",
        "    private const val PRESS_DEPTH = 0.05f  // how far the cap plunges on a press",
        "    private const val MARK_Z = 0.055f      // underline just in front of the caps",
        "    private const val FLASH_Z = 0.062f     // ripple flash in front of everything",
        `    private const val UNDER_DY = ${underDy}f // underline offset below the button centre`,
        "    private const val CUR_Z = 0.075f",
        "    private const val CUR_S = 0.03f",
        `    private const val FACE_USER = ${faceUserOn}   // auto-orient the panel to face the user as it moves`,
        `    private const val SNAP_GRID = ${snap}f       // grid (m) the panel snaps to on drop (0 = off)`,
        "    private val USER_POS = Vector3(0f, 1.5f, 0f)  // the viewer/HMD the panel turns to face (headset origin)",
        "    // A GENTLE, CLAMPED billboard: enough tilt to read as 3D, capped so the emulator's vision-based",
        "    // click bridge still sees the buttons (it tolerates up to ~15deg). On a headset raise these.",
        "    private const val FACE_STRENGTH = 0.5f",
        "    private const val MAX_TILT = 12f   // degrees",
        "",
        "    /** Place the panel, build the highlight + cursor as panel children, and bind the controllers. */",
        ...attachBody,
        "",
        "    /** Move the FOCUS indicator to a row — raise its cap, settle the rest, slide the underline +",
        "     *  cursor. No press, no action. Shared by hover (preview) and select (commit). @MainThread. */",
        "    private fun focus(action: String) {",
        "        val y = BTN_Y[action] ?: return",
        "        caps.forEach { (a, cap) ->",
        "            val z = if (a == action) CAP_Z + CAP_RAISE else CAP_Z",
        "            runCatching { cap.components.set(TransformComponent(Vector3(BTN_X, BTN_Y[a] ?: y, z), Quat.identity(), Vector3(1f, 1f, 1f))) }",
        "        }",
        "        runCatching { underline?.components?.set(TransformComponent(Vector3(BTN_X, y + UNDER_DY, MARK_Z), Quat.identity(), Vector3(1f, 1f, 1f))) }",
        "        runCatching { cursor?.components?.set(TransformComponent(Vector3(CURSOR_X, y, CUR_Z), Quat.identity(), Vector3(CUR_S, CUR_S, CUR_S))) }",
        "    }",
        "",
        "    /** PREVIEW a button under the pointer WITHOUT committing — the emulator mouse bridge sends this",
        "     *  on mouse-over (DEBUG_CMD cmd=hover:<action>); a headset sends it on gaze. An unknown/\"none\"",
        "     *  target restores focus to the last selected button. @MainThread. */",
        "    fun hover(action: String) {",
        "        (if (BTN_Y.containsKey(action)) action else selected)?.let { focus(it) }",
        "    }",
        "",
        "    /** The COMMIT entry point — focus the row, PLAY THE PRESS (plunge + color-matched flash), and",
        "     *  apply the action. Driven by a click (emulator bridge) or gaze/controller trigger. @MainThread. */",
        "    fun select(action: String) {",
        "        BTN_Y[action]?.let {",
        "            focus(action); selected = action",
        "            caps[action]?.let { cap ->",
        "                runCatching {",
        "                    pressCtrl?.let { c -> runCatching { c.stop() } }",
        "                    val press = TweenAnimation.createTweenAnimation(",
        "                        name = \"press\", bindTarget = AnimationBindTarget.bindPosition(),",
        "                        by = Vector3(0f, 0f, -PRESS_DEPTH), duration = 0.12f,",
        "                        repeatMode = RepeatMode.REVERSE, repeatCount = 1, easeType = EaseType.EASE_OUT,",
        "                    )",
        "                    pressCtrl = cap.playAnimation(AnimationResource.generateWithTweenAnimation(press))",
        "                }.onFailure { Log.e(TAG, \"press anim failed: $it\") }",
        "            }",
        "            // color-matched tap flash on the pressed button (a brief pulse, invisible at rest).",
        "            flashes[action]?.let { fl ->",
        "                runCatching {",
        "                    flashCtrl?.let { c -> runCatching { c.stop() } }",
        "                    val pulse = TweenAnimation.createTweenAnimation(",
        "                        name = \"flash\", bindTarget = AnimationBindTarget.bindMaterial(0, MaterialTarget.OPACITY),",
        `                        from = 0f, to = ${opacity}f, duration = 0.18f,`,
        "                        repeatMode = RepeatMode.REVERSE, repeatCount = 1, easeType = EaseType.EASE_OUT,",
        "                    )",
        "                    flashCtrl = fl.playAnimation(AnimationResource.generateWithTweenAnimation(pulse))",
        "                }.onFailure { Log.e(TAG, \"flash anim failed: $it\") }",
        "            }",
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
        "",
        "    /** MOVE the whole panel (+ its buttons/children) by a WORLD delta and log the new position, so you",
        "     *  can drag it anywhere in the room and then bake the spot in via panelPosition. Stops the idle bob",
        "     *  so it doesn't fight the move. Driven by the mouse-bridge drag (DEBUG_CMD move:dx,dy,dz) on the",
        "     *  emulator, or a controller/hand grab on a headset. @MainThread. */",
        "    /** Orientation that turns the panel to FACE the user (yaw toward you + pitch to tilt), so it",
        "     *  reads as a 3D object in the room instead of a flat plane. Identity if FACE_USER is off. */",
        "    private fun faceRot(): Quat {",
        "        if (!FACE_USER) return Quat.identity()",
        "        val fx = USER_POS.x - panelPos.x; val fy = USER_POS.y - panelPos.y; val fz = USER_POS.z - panelPos.z",
        "        val h = sqrt(fx * fx + fz * fz)",
        "        if (h < 1e-4f) return Quat.identity()",
        "        val yaw = (Math.toDegrees(atan2(fx.toDouble(), fz.toDouble())).toFloat() * FACE_STRENGTH)",
        "            .coerceIn(-MAX_TILT, MAX_TILT)     // turn to face you (clamped so clicks still detect)",
        "        val pitch = (-Math.toDegrees(atan2(fy.toDouble(), h.toDouble())).toFloat() * FACE_STRENGTH)",
        "            .coerceIn(-MAX_TILT, MAX_TILT)     // tilt up/down toward you",
        "        return EulerAngles(pitch, yaw, 0f).toQuat()",
        "    }",
        "",
        "    /** Place the panel at panelPos with the face-the-user rotation. @MainThread. */",
        "    private fun applyPanel() {",
        "        val p = panelRef ?: return",
        "        runCatching { p.components.set(TransformComponent(panelPos, faceRot(), Vector3(SCALE, SCALE, SCALE))) }",
        "            .onFailure { Log.e(TAG, \"panel place failed: $it\") }",
        "    }",
        "",
        "    fun nudgePanel(dx: Float, dy: Float, dz: Float) {",
        "        bobCtrl?.let { runCatching { it.stop() } }; bobCtrl = null",
        "        panelPos = Vector3(panelPos.x + dx, panelPos.y + dy, panelPos.z + dz)",
        "        applyPanel()",
        "        Log.i(TAG, \"panel at (${panelPos.x}, ${panelPos.y}, ${panelPos.z})  <- set panelPosition to this to bake it in\")",
        "    }",
        "",
        "    /** Snap the panel to the SNAP_GRID for a clean placement (bridge sends this on drop). @MainThread. */",
        "    fun snapPanel() {",
        "        bobCtrl?.let { runCatching { it.stop() } }; bobCtrl = null",
        "        if (SNAP_GRID > 0f) {",
        "            fun q(v: Float): Float = (v / SNAP_GRID).roundToInt() * SNAP_GRID",
        "            panelPos = Vector3(q(panelPos.x), q(panelPos.y), q(panelPos.z))",
        "            applyPanel()",
        "        }",
        "        Log.i(TAG, \"panel SNAPPED to (${panelPos.x}, ${panelPos.y}, ${panelPos.z})  <- set panelPosition to this\")",
        "    }",
        "",
        "    /** From the bridge: \"snap\" -> snapPanel(); else a \"dx,dy,dz\" world delta -> nudgePanel. @MainThread. */",
        "    fun nudgePanelCmd(s: String) {",
        "        if (s.trim() == \"snap\") { snapPanel(); return }",
        "        val v = s.split(\",\").mapNotNull { it.trim().toFloatOrNull() }",
        "        if (v.size == 3) nudgePanel(v[0], v[1], v[2]) else Log.w(TAG, \"bad move cmd: $s\")",
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
        "// 2) MANIFEST RECEIVER (emulator drive, C3 — no controller). In your Application, route cmd:",
        "//      val f = IntentFilter(\"$packageName.DEBUG_CMD\")",
        "//      registerReceiver(object: BroadcastReceiver(){ override fun onReceive(c:Context,i:Intent){",
        "//          val cmd = i.getStringExtra(\"cmd\") ?: return",
        "//          when { cmd.startsWith(\"hover:\") -> GameMenu.hover(cmd.removePrefix(\"hover:\"))",
        "//                 cmd.startsWith(\"move:\")  -> GameMenu.nudgePanelCmd(cmd.removePrefix(\"move:\"))",
        "//                 else -> GameMenu.select(cmd) }",
        "//      } }, f, RECEIVER_EXPORTED)",
        "//    Commit:  adb shell am broadcast -a <pkg>.DEBUG_CMD --es cmd pause    (start|pause|resume|reset)",
        "//    Preview: adb shell am broadcast -a <pkg>.DEBUG_CMD --es cmd hover:pause   (mouse-over, no commit;",
        "//             the mouse bridge sends this automatically with BRIDGE_HOVER=1; \"hover:none\" clears it)",
        "//",
        "// 3) HEADSET: hit-test the panel with gaze/controller -> GameMenu.hover(action) on gaze-over and",
        "//    GameMenu.select(action) on trigger (same entry points).",
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
