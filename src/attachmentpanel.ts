import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, fail } from "./util.js";

/**
 * attachmentpanel.ts — v35.2 IN-SCENE Compose panels, the capability we told ourselves was impossible.
 *
 * THE CORRECTION. Since v31 we have shipped, in three places, a variant of:
 *   "no public API positions an auto-hosted 2D panel in world space (vault-checked)"
 * and compiled AppSpec `panels[].placement: 'world'` to a head-docked fallback. The sentence is true
 * of the architecture it names — a separate 2D Activity that PICO OS composites as a floating
 * window; nothing in 0.13.3 sets the world pose of one of those. But we let that narrow fact stand
 * in for a broader one, and the broader claim was wrong. Inside a SpatialView, `AttachmentPanel`
 * gives you a Compose surface backed by a real ECS Entity whose TransformComponent you set, in
 * metres. It has been public the whole time; six of PICO's eight samples use it. The vault check was
 * scoped to the auto-hosted-Activity path and never re-run against ui.foundation.content.
 *
 * These remain two different architectures, which is why this is a separate tool from
 * generate_panel_compose_kotlin rather than a flag on it:
 *   - dock   (generate_panel_compose_kotlin): its own 2D Activity, OS-composited, spawns at the
 *            shell dock, survives independently of any SpatialView. Still the right answer for a
 *            HUD you want the shell to manage.
 *   - scene  (this tool): Compose hosted INSIDE the SpatialView's scene graph, positioned in metres
 *            in that view's local space. Moves with the container. NOT a persistent world anchor —
 *            world-LOCKING still needs AnchorComponent, which stays honestly deferred.
 *
 * Every symbol was read from the 0.13.3 sources jars and then adversarially re-verified. The
 * corrections that came out of that second pass are the interesting part:
 *
 *   ui/foundation `content/SpatialView.kt:77-83`
 *     SpatialView(modifier, update, attachments: (AttachmentPanelBuilder.() -> Unit)?, initial)
 *   `SpatialView.kt:172-192`  interface AttachmentPanelBuilder {
 *       fun AttachmentPanel(id: Any, size: IntSize? = null,
 *                           alignment: AttachmentPanelComponent.Alignment = UNSPECIFIED,
 *                           content: @Composable () -> Unit)
 *       fun clearAllAttachments() }
 *   `SpatialView.kt:222-229`  interface SpatialViewAttachments { fun entity(id: Any): Entity? }
 *                             — one member, nullable return.
 *
 *   TRAP 1 — the `attachments` lambda is NOT @Composable (SpatialView.kt:81; it is invoked from
 *   AndroidView's update block at :128). Calling panelSize(...) or LocalContext.current inside it
 *   does not compile. Sizes MUST be hoisted into the enclosing composable, which is why this tool
 *   emits rememberAttachmentPanelSizes() separately from the builder extension.
 *
 *   TRAP 2 — two unit systems in one call site. Position is METRES (TransformComponent.kt:71-72
 *   KDoc, verbatim: "measured in meters (m)"). Panel size is PIXELS (ui AttachmentPanelComponent.kt
 *   :88-92), produced by @Composable panelSize(). We emit the Dp overload (:121-125) deliberately:
 *   the metres overload (:146-147) resolves through LocalPhysicalLengthConverter, which is
 *   `compositionLocalOf { error(...) }` (PhysicalLengthConverter.kt:326-329) and THROWS unless a
 *   spatial container provided it.
 *
 *   TRAP 3 — panelSize is `remember`ed with NO KEYS (ui AttachmentPanelComponent.kt:127). The
 *   IntSize is frozen at first composition and will not recompute on a density or argument change.
 *   Do not drive a resizing panel through it.
 *
 *   TRAP 4 — the attachment entity is NOT added to the scene for you. Every sample explicitly calls
 *   content.addEntity(it) or parent.addChild(it). Omitting it yields a silently invisible panel.
 *
 *   TRAP 5 — alignment is the anchor point ON THE PANEL that is aligned TO the entity, in normalized
 *   [0,1] where (0,0) is top-left (core/ecs/AttachmentPanelComponent.kt:255-258). It is not a world
 *   placement, and reading it the other way round produces backwards offsets.
 *
 *   Ordering is safe: SpatialView.kt:127-135 invokes the attachments builder and binds the
 *   attachments BEFORE launching `initial`, so entity(id) is populated by the time we seat it. And
 *   `initial` runs on Main (SpatialView.kt:89,135), which matters because Entity(), ComponentSet.get,
 *   addChild and the TransformComponent setters are all @MainThread with a checkIsMainThread().
 *
 *   WHY THIS WORKS FOR US, and where its floor is. The v34 Rik research (.dev/drafts/
 *   2026-08-04-reply-to-rik.md:103-107) decompiled the AttachmentPanelComponent handler and found it
 *   branches on Build.VERSION.SDK_INT >= 35, with only that branch calling
 *   ViewLink.setViewLinkGlobalMatrix3D(Matrix44) — Matrix44 being an AOSP class added in API 35. Our
 *   appskeleton sets minSdk = 35 (app/build.gradle.kts:13), so the branch is always taken and the
 *   world-matrix path is live. An app built against a lower minSdk would take the other branch, and
 *   ViewLink/SpaceView are PICO platform classes absent from AOSP's android.jar, so on a non-PICO
 *   device that path throws rather than degrading. Do not lower minSdk below 35 and expect
 *   positioned attachments to keep working.
 *
 *   NOT emitted: the hand-built Entity + attachmentPanelComponent() route. Both symbols are real
 *   (ui AttachmentPanelComponent.kt:99-105, :50-53) but nothing in the jars or any sample shows a
 *   hand-built entity rendering outside the builder path, and content() hard-checks that its Context
 *   is a LifecycleOwner + SavedStateRegistryOwner (:55-64). Unconfirmed, so we do not ship it.
 */

const ALIGNMENTS = [
  "UNSPECIFIED", "TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "CENTER_LEFT",
  "CENTER", "CENTER_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER", "BOTTOM_RIGHT",
] as const;

export interface AttachmentPanelSpec {
  id: string;
  title?: string;
  lines?: string[];
  position?: number[];
  widthDp?: number;
  heightDp?: number;
  alignment?: (typeof ALIGNMENTS)[number];
  faceViewer?: boolean;
}

export interface AttachmentPanelArgs {
  packageName: string;
  panels?: AttachmentPanelSpec[];
}

const kstr = (s: string) => JSON.stringify(s);
const constName = (id: string) => id.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "PANEL";
const fnName = (id: string) => {
  const parts = id.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const camel = parts.map((p, i) => (i === 0 ? p[0].toUpperCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1))).join("");
  return `${camel || "Panel"}Content`;
};

/** Pure generator, exported so the conformance gate can drive it without spawning the server. */
export function generateAttachmentPanelFiles(args: AttachmentPanelArgs): { files: Record<string, string>; usage: string; note: string } {
  const { packageName } = args;
  const panels: AttachmentPanelSpec[] = args.panels?.length
    ? args.panels
    : [{ id: "hud", title: "STATUS", lines: ["READY"], position: [0, -0.3, 0.28], widthDp: 320, heightDp: 140, alignment: "CENTER" }];

  const seen = new Set<string>();
  for (const p of panels) {
    if (!p.id) throw new Error("every panel needs an id");
    if (seen.has(p.id)) throw new Error(`duplicate panel id '${p.id}' — ids are map keys (ViewAttachments.kt:27), they must be unique`);
    seen.add(p.id);
    if (p.position && p.position.length !== 3) throw new Error(`panel '${p.id}': position must be [x,y,z] in metres`);
    // MAX_PANEL_SIZE_DP = 2048 (core/ecs/AttachmentPanelComponent.kt:204); the SDK clamps silently
    // at :227-234, so catch it here where the author can see it instead of at render time.
    for (const [dim, v] of [["widthDp", p.widthDp], ["heightDp", p.heightDp]] as const) {
      if (v != null && (v <= 0 || v > 2048)) throw new Error(`panel '${p.id}': ${dim} must be in (0, 2048] — the SDK clamps at MAX_PANEL_SIZE_DP=2048`);
    }
    if (p.alignment && !ALIGNMENTS.includes(p.alignment)) throw new Error(`panel '${p.id}': unknown alignment '${p.alignment}'`);
  }

  const anyFaceViewer = panels.some((p) => p.faceViewer);

  const kt = [
    `package ${packageName}`,
    ``,
    `import androidx.compose.foundation.background`,
    `import androidx.compose.foundation.layout.Arrangement`,
    `import androidx.compose.foundation.layout.Column`,
    `import androidx.compose.foundation.layout.padding`,
    `import androidx.compose.foundation.shape.RoundedCornerShape`,
    `import androidx.compose.runtime.Composable`,
    `import androidx.compose.ui.Modifier`,
    `import androidx.compose.ui.unit.IntSize`,
    `import androidx.compose.ui.unit.dp`,
    `import com.pico.spatial.core.container.SpatialViewContent`,
    `import com.pico.spatial.core.ecs.AttachmentPanelComponent`,
    `import com.pico.spatial.core.ecs.Entity`,
    ...(anyFaceViewer ? [`import com.pico.spatial.core.ecs.LookAtComponent`] : []),
    `import com.pico.spatial.core.ecs.TransformComponent`,
    `import com.pico.spatial.core.math.Vector3`,
    `import com.pico.spatial.ui.design.PicoTheme`,
    `import com.pico.spatial.ui.design.Text`,
    `import com.pico.spatial.ui.foundation.content.AttachmentPanelBuilder`,
    `import com.pico.spatial.ui.foundation.content.SpatialViewAttachments`,
    `import com.pico.spatial.ui.foundation.content.panelSize`,
    ``,
    `/**`,
    ` * Generated by generate_attachment_panel_kotlin — Compose panels placed INSIDE the 3D scene.`,
    ` *`,
    ` * Position is in METRES, in the hosting SpatialView's local space. Panel size is in PIXELS,`,
    ` * produced by the @Composable panelSize(Dp, Dp). Do not cross the two.`,
    ` *`,
    ` * This is scene placement, NOT a world anchor: the panels move with their container. A pose that`,
    ` * survives app restarts or is fixed to the real room still needs AnchorComponent.`,
    ` */`,
    `object SceneAttachments {`,
    ...panels.flatMap((p) => [
      `    /** Attachment id for '${p.id}'. ids are map keys (ViewAttachments.kt:27) — keep them unique and stable. */`,
      `    const val ID_${constName(p.id)} = ${kstr(p.id)}`,
      `    /** METRES, in the SpatialView's local space (TransformComponent.kt:71-72). */`,
      `    val POS_${constName(p.id)} = Vector3(${(p.position ?? [0, -0.3, 0.28]).map((n) => `${n}f`).join(", ")})`,
    ]),
    `}`,
    ``,
    `/**`,
    ` * Panel sizes, hoisted OUT of the attachments lambda on purpose.`,
    ` *`,
    ` * The attachments lambda is NOT a composable scope (SpatialView.kt:81 — the lambda type carries`,
    ` * no @Composable, and it is invoked from AndroidView's update block at :128), so calling`,
    ` * panelSize() inside it does not compile. Call this from your composable and pass the result in.`,
    ` *`,
    ` * The Dp overload (ui AttachmentPanelComponent.kt:121-125) is used deliberately over the metres`,
    ` * overload (:146-147): the latter resolves through LocalPhysicalLengthConverter, which is`,
    ` * compositionLocalOf { error(...) } (PhysicalLengthConverter.kt:326-329) and throws outside a`,
    ` * spatial container. NOTE panelSize is remember-ed with NO keys (:127) — these sizes are frozen`,
    ` * at first composition and will not recompute.`,
    ` */`,
    `@Composable`,
    `fun rememberAttachmentPanelSizes(): Map<String, IntSize> = mapOf(`,
    ...panels.map((p) => `    SceneAttachments.ID_${constName(p.id)} to panelSize(${p.widthDp ?? 320}.dp, ${p.heightDp ?? 140}.dp),`),
    `)`,
    ``,
    `/**`,
    ` * The attachments block. Pass it the hoisted sizes:`,
    ` *   attachments = { sceneAttachmentPanels(sizes) }`,
    ` */`,
    `fun AttachmentPanelBuilder.sceneAttachmentPanels(sizes: Map<String, IntSize>) {`,
    ...panels.flatMap((p) => [
      `    AttachmentPanel(`,
      `        id = SceneAttachments.ID_${constName(p.id)},`,
      `        size = sizes[SceneAttachments.ID_${constName(p.id)}],`,
      `        // The anchor point ON THE PANEL that is aligned TO the entity, normalized [0,1] with`,
      `        // (0,0) = top-left (AttachmentPanelComponent.kt:255-258). Not a world offset.`,
      `        alignment = AttachmentPanelComponent.Alignment.${p.alignment ?? "CENTER"},`,
      `    ) {`,
      `        ${fnName(p.id)}()`,
      `    }`,
    ]),
    `}`,
    ``,
    `/**`,
    ` * Seat every panel and add it to the scene. Call from SpatialView's initial block:`,
    ` *   initial = { content, attachments -> attachments.seatSceneAttachmentPanels(content) }`,
    ` *`,
    ` * The attachment entity is NOT added for you — every sample calls addEntity/addChild explicitly,`,
    ` * and omitting it yields a panel that exists but never renders. entity(id) is nullable`,
    ` * (SpatialView.kt:228); it is populated by the time initial runs (:127-135 binds attachments`,
    ` * before launching initial), but guard anyway. initial runs on Main (:89,:135), which these`,
    ` * @MainThread calls require.`,
    ` */`,
    `fun SpatialViewAttachments.seatSceneAttachmentPanels(content: SpatialViewContent) {`,
    ...panels.flatMap((p) => [
      `    val e${constName(p.id)} = entity(SceneAttachments.ID_${constName(p.id)})`,
      `    // Log the lookup. entity(id) returning null is the single most likely reason a panel`,
      `    // never appears, and a bare ?.let swallows it silently — you get an invisible panel and`,
      `    // no clue why. Say which happened.`,
      `    android.util.Log.i("SceneAttachments", "attachment '${p.id}' entity=" + (if (e${constName(p.id)} == null) "NULL (never created — is the id identical in the builder and here?)" else "ok"))`,
      `    e${constName(p.id)}?.let { panel ->`,
      `        panel.components.get<TransformComponent>()?.setPosition(SceneAttachments.POS_${constName(p.id)})`,
      ...(p.faceViewer
        ? [
            `        // Face the viewer. There is no BillboardComponent in 0.13.3 (grep: zero hits);`,
            `        // LookAtComponent.setViewerAsTarget() is the equivalent (LookAtComponent.kt:148).`,
            `        panel.components.set(LookAtComponent().apply { setViewerAsTarget() })`,
          ]
        : []),
      `        content.addEntity(panel)`,
      `        android.util.Log.i("SceneAttachments", "attachment '${p.id}' seated at " + SceneAttachments.POS_${constName(p.id)}.x + "," + SceneAttachments.POS_${constName(p.id)}.y + "," + SceneAttachments.POS_${constName(p.id)}.z + " (metres, SpatialView-local)")`,
      `    }`,
    ]),
    `}`,
    ``,
    `/** Full-stage overload: parent panels beneath the replaceable AgentWorldRoot. */`,
    `fun SpatialViewAttachments.seatSceneAttachmentPanels(worldRoot: Entity) {`,
    ...panels.flatMap((p) => [
      `    val e${constName(p.id)} = entity(SceneAttachments.ID_${constName(p.id)})`,
      `    android.util.Log.i("SceneAttachments", "attachment '${p.id}' entity=" + (if (e${constName(p.id)} == null) "NULL (never created — is the id identical in the builder and here?)" else "ok"))`,
      `    e${constName(p.id)}?.let { panel ->`,
      `        panel.components.get<TransformComponent>()?.setPosition(SceneAttachments.POS_${constName(p.id)})`,
      ...(p.faceViewer
        ? [
            `        panel.components.set(LookAtComponent().apply { setViewerAsTarget() })`,
          ]
        : []),
      `        check(worldRoot.addChild(panel)) { "attachment '${p.id}' could not be parented beneath AgentWorldRoot" }`,
      `        android.util.Log.i("SceneAttachments", "attachment '${p.id}' seated under AgentWorldRoot")`,
      `    }`,
    ]),
    `}`,
    ``,
    ...panels.flatMap((p) => [
      `/** Content for the '${p.id}' panel. SpatialUI inside PicoTheme — never Material. */`,
      `@Composable`,
      `private fun ${fnName(p.id)}() {`,
      `    PicoTheme {`,
      `        val colors = PicoTheme.colorScheme`,
      `        val type = PicoTheme.typography`,
      `        Column(`,
      `            modifier = Modifier`,
      `                // An in-scene attachment gets NO container backing. A WindowContainer panel is`,
      `                // composited by the shell onto its own glass surface, so content can rely on it;`,
      `                // an attachment is drawn straight into the 3D scene against whatever happens to`,
      `                // be behind it. PicoTheme's default labelPrimary is BLACK, so without this fill`,
      `                // the panel renders invisible over any dark scene content — measured 2026-08-06,`,
      `                // where the text was only legible where it crossed an orange sphere.`,
      `                .background(colors.fillSecondary, RoundedCornerShape(12.dp))`,
      `                .padding(16.dp),`,
      `            verticalArrangement = Arrangement.spacedBy(8.dp),`,
      `        ) {`,
      ...(p.title ? [`            Text(${kstr(p.title)}, style = type.titleLarge, color = colors.fillPrimary)`] : []),
      ...(p.lines ?? []).map((l) => `            Text(${kstr(l)}, style = type.bodyLarge, color = colors.labelPrimary)`),
      `        }`,
      `    }`,
      `}`,
      ``,
    ]),
  ].join("\n");

  const usage = [
    `// In the composable that hosts the scene (e.g. HomeStage):`,
    `val panelSizes = rememberAttachmentPanelSizes()   // hoisted: panelSize is @Composable`,
    `SpatialView(`,
    `    modifier = Modifier.fillMaxSize(),`,
    `    attachments = { sceneAttachmentPanels(panelSizes) },`,
    `    initial = { content, attachments ->`,
    `        // ... build your scene ...`,
    `        attachments.seatSceneAttachmentPanels(content)`,
    `    },`,
    `)`,
  ].join("\n");

  return {
    files: { "SceneAttachments.kt": kt },
    usage,
    note:
      `Write SceneAttachments.kt into ${packageName} and wire it as shown in usage. ` +
      `Position is METRES in the SpatialView's LOCAL space; size is PIXELS via the @Composable panelSize(Dp, Dp). ` +
      `This is scene placement, NOT world-locking: the panels move with their container and do not survive as a real-world anchor — ` +
      `that still needs AnchorComponent and stays deferred. ` +
      `STATUS: VISION_VERIFIED on emulator-5554 (ledger com.picoagent.v35attach#0, 2026-08-06). A panel emitted by this tool renders ` +
      `inside the 3D scene and is correctly DEPTH-SORTED: seated at z=-1.85 it visibly occludes a scene sphere at z=-2.0, so this is real ` +
      `3D placement, not a 2D overlay. ` +
      `LOOK-DERIVED GOTCHA now handled for you: an attachment gets NO container backing. A WindowContainer panel is composited by the shell ` +
      `onto its own glass surface; an attachment is drawn straight into the scene against whatever is behind it. PicoTheme's default ` +
      `labelPrimary is BLACK, so the first build rendered an INVISIBLE panel over dark scene content — legible only where the text happened ` +
      `to cross an orange sphere. The emitted content now fills its own fillSecondary background. ` +
      `Sizing is still worth checking by eye: panelSize takes dp, and a panel sized for arm's length reads small at a few metres.`,
  };
}

export function registerAttachmentPanelTools(server: McpServer) {
  server.registerTool(
    "generate_attachment_panel_kotlin",
    {
      description:
        "Emit Compose panels placed INSIDE the 3D scene at a chosen position in metres — the in-scene counterpart to generate_panel_compose_kotlin's docked 2D Activity. Returns JSON {files:{'SceneAttachments.kt'}, usage, note}. RETRACTION THIS SUPERSEDES: we shipped 'no public API positions an auto-hosted 2D panel in world space' and compiled placement:'world' to a head-docked fallback. That is true only of an OS-composited 2D Activity window, and it stays true for that case — but inside a SpatialView, AttachmentPanel(id, size, alignment, content) yields a Compose surface backed by a real ECS Entity whose TransformComponent you set, in metres. It has been public in 0.13.3 the whole time (ui/foundation content/SpatialView.kt:182); six of PICO's eight samples use it. SCOPE, STATED PRECISELY: this is scene placement, not world-LOCKING — panels live in the hosting SpatialView's local space and move with their container; a pose fixed to the real room still needs AnchorComponent and remains deferred. TRAPS IT ENCODES, each grounded and adversarially re-verified: the attachments lambda is NOT a composable scope (SpatialView.kt:81), so panelSize() is hoisted into a separate rememberAttachmentPanelSizes(); position is METRES but size is PIXELS; the Dp overload of panelSize is emitted because the metres overload throws outside a spatial container (LocalPhysicalLengthConverter is compositionLocalOf{error}); panelSize is remember-ed with no keys, so sizes are frozen at first composition; the attachment entity must be explicitly added via content.addEntity or it silently never renders; and alignment is the anchor point ON THE PANEL aligned TO the entity in normalized [0,1], not a world offset. Panels are SpatialUI inside PicoTheme, never Material. faceViewer uses LookAtComponent.setViewerAsTarget() — there is no BillboardComponent in 0.13.3. STATUS: VISION_VERIFIED on the emulator (ledger com.picoagent.v35attach#0) — a panel from this tool renders in-scene and correctly occludes geometry behind it. It also draws its own background: an attachment has no container glass behind it, and PicoTheme's default text colour is black, so without a fill the panel is invisible over dark scene content (found by looking).",
      inputSchema: {
        packageName: z.string().describe("Kotlin package for the emitted file, e.g. com.example.app.content"),
        panels: z
          .array(
            z.object({
              id: z.string().describe("Stable unique attachment id — it is a map key (ViewAttachments.kt:27)."),
              title: z.string().optional().describe("Heading line, rendered with PicoTheme.typography.titleLarge."),
              lines: z.array(z.string()).optional().describe("Body lines, rendered with PicoTheme.typography.bodyLarge."),
              position: z.array(z.number()).optional().describe("[x,y,z] in METRES, in the hosting SpatialView's local space. Default [0,-0.3,0.28] (PICO's own Physics sample offset)."),
              widthDp: z.number().optional().describe("Panel width in dp, (0,2048]. Default 320. The SDK clamps at MAX_PANEL_SIZE_DP=2048."),
              heightDp: z.number().optional().describe("Panel height in dp, (0,2048]. Default 140."),
              alignment: z.enum(ALIGNMENTS).optional().describe("Anchor point ON THE PANEL aligned TO the entity, normalized [0,1] with (0,0)=top-left. Default CENTER."),
              faceViewer: z.boolean().optional().describe("Attach LookAtComponent().setViewerAsTarget() so the panel turns to face the headset. There is no BillboardComponent in 0.13.3."),
            }),
          )
          .optional()
          .describe("The panels to place. Defaults to one 'hud' panel at [0,-0.3,0.28]."),
      },
    },
    async ({ packageName, panels }) => {
      try {
        return ok(JSON.stringify(generateAttachmentPanelFiles({ packageName, panels }), null, 2));
      } catch (e: any) {
        return fail(String(e?.message ?? e));
      }
    },
  );
}
