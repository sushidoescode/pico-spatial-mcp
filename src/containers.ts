import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, fail } from "./util.js";

/**
 * containers.ts — v35.3 MULTI-CONTAINER apps and the SpatialNavigator.
 *
 * THE GAP THIS CLOSES. genMain has always emitted exactly `DefaultStage { PicoTheme { HomeStage() } }`
 * for every app, regardless of spec. WelcomeSpace — the Week-1 curriculum anchor — declares THREE
 * containers in one mainApp (a Planar DefaultWindowContainer, a Volumetric WindowContainer, and a
 * Stage) and opens/closes them at runtime through LocalSpatialNavigator, passing a Bundle between
 * them. An agentic track that can only emit DefaultStage cannot reach that outcome by prompting.
 *
 * Every symbol below was read from the 0.13.3 sources jars and adversarially re-verified.
 *
 *   ui/foundation `dsl/Stage.kt:65`   DefaultStage(content: @Composable StageScope.() -> Unit)
 *   `dsl/Stage.kt:88`                 Stage(id, immersion, brightness, upperLimbRenderMode,
 *                                           targetActivity, content)  — NOTE: no `style` param.
 *                                     Stage style is chosen at OPEN time, by openStage.
 *   `dsl/Stage.kt:124`                Immersion(default, min = 0, max = 100)  — the FACTORY.
 *                                     The class ctor is internal (:140); never call it.
 *   `dsl/WindowContainer.kt:66`       DefaultWindowContainer(content)
 *   `dsl/WindowContainer.kt:99`       WindowContainer(id, form, defaultSize, resizeType,
 *                                       defaultResizeRestriction, enableMaterialBackground,
 *                                       volumeAlignment, defaultVolumeBasePanelType,
 *                                       defaultCaptionBarType, placement, targetActivity,
 *                                       worldScale, content)
 *   ui/platform `containers/SpatialNavigator.kt:30`  the interface. openWindowContainer(id, tag,
 *                                     bundle) :40, closeWindowContainer :49/:52, minimize :63/:70,
 *                                     restore :81/:88, and openStage :100 / closeStage :108 which
 *                                     are BOTH `suspend`.
 *   `SpatialNavigator.kt:157`         LocalSpatialNavigator — non-null inside any container content.
 *   `containers/StageParams.kt:19`    StageStyle { Automatic, Mixed, Progressive, Full }
 *   `containers/SpatialContainerScope.kt:23`  SpatialContainerScope.bundle: Bundle? — how a
 *                                     container reads what the opener passed it.
 *   `resize/WindowConstraintsModifier.kt:50,71`  Modifier.windowConstraints — a member of
 *                                     WindowContainerConstraintsScope, so it is available ONLY
 *                                     inside WindowContainer content, not inside a Stage.
 *
 * FOUR RULES THIS ENCODES, each of which we would otherwise have got wrong:
 *
 *  1. A DECLARED CONTAINER DOES NOT OPEN ITSELF. Declaring WindowContainer(id=...) in mainApp only
 *     registers it; something must call navigator.openWindowContainer(id). This is the single most
 *     likely explanation for our long-standing measured note that "an immersive app's own
 *     WindowContainer does NOT open a panel window on the emulator". RESOLVED 2026-08-06: that
 *     measurement was of a declared-but-never-opened container. With the open call, the container
 *     really does open — vision_verified, ledger com.picoagent.v35expb#0. The note is narrowed, not
 *     discarded: without the call, the old observation stands exactly as recorded.
 *
 *  2. THE OBVIOUS TEARDOWN IS BROKEN. It is natural to write:
 *         val scope = rememberCoroutineScope()
 *         DisposableEffect(Unit) { onDispose { scope.launch { navigator.closeStage() } } }
 *     closeStage is `suspend`, so it needs a scope — but a rememberCoroutineScope() scope is
 *     CANCELLED when it leaves composition, and onDispose runs after that. The launch is a no-op
 *     and the Stage is never closed. Both PICO samples avoid it by closing on a LifecycleEventObserver
 *     at ON_PAUSE/ON_DESTROY — i.e. BEFORE disposal — which is what we emit.
 *
 *  3. Stage has no `style` parameter. Immersion is declared on the Stage; the STYLE (Mixed /
 *     Progressive / Full) is chosen when you open it. Emitting `Stage(style = ...)` does not compile.
 *
 *  4. Modifier.windowConstraints belongs to WindowContainerConstraintsScope. It is meaningless — and
 *     unavailable — inside a Stage, and under ContainerResizeType.ContentSize it is what actually
 *     sizes the window (ContainerResizeType.kt KDoc: ContentSize/ContentMinSize read their bounds
 *     from the constraints on the root node).
 *
 * NOT emitted: the manifest meta-data keys for style/worldscaletype/resizerestriction/defaultsize
 * and friends. The re-verification pass found these resolve through framework stubs that are absent
 * from 0.13.3 (e.g. core `container/WindowContainer.kt:244` routes through a missing
 * com.spatial.app.SpatialContainerManager), and the numeric encodings are KDoc-only. The DSL
 * parameters are the verified path and beat the manifest on every field but the container name.
 */

const FORMS = ["Planar", "Volumetric"] as const;
const RESIZE_TYPES = ["Automatic", "ContentSize", "ContentMinSize"] as const;
const STAGE_STYLES = ["Automatic", "Mixed", "Progressive", "Full"] as const;

export interface SecondaryWindowContainer {
  kind: "window";
  id: string;
  form?: (typeof FORMS)[number];
  widthDp?: number;
  heightDp?: number;
  depthDp?: number;
  resizeType?: (typeof RESIZE_TYPES)[number];
  materialBackground?: boolean;
  content?: string;
  contentImport?: string;
}

export interface SecondaryStage {
  kind: "stage";
  id: string;
  style?: (typeof STAGE_STYLES)[number];
  immersion?: number;
  immersionMin?: number;
  immersionMax?: number;
  content?: string;
  contentImport?: string;
}

export type SecondaryContainer = SecondaryWindowContainer | SecondaryStage;

export interface ContainerAppArgs {
  packageName: string;
  root?: "windowContainer" | "stage";
  rootContent?: string;
  rootContentImport?: string;
  rootWidthDp?: number;
  rootHeightDp?: number;
  containers?: SecondaryContainer[];
}

const pascal = (id: string) => id.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join("") || "Container";
const idConst = (id: string) => `ID_${id.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "CONTAINER"}`;

/** Pure generator, exported so the conformance gate can drive it without spawning the server. */
export function generateContainerAppFiles(args: ContainerAppArgs): { files: Record<string, string>; note: string } {
  const { packageName } = args;
  const root = args.root ?? "windowContainer";
  // Validate explicitly. This is not defensive noise: `root: "DefaultStage"` (a plausible-looking
  // but invalid value) was accepted, emitted a DefaultStage app, and slipped past the root === "stage"
  // guard below — so a typo silently produced a configuration the generator means to refuse.
  if (root !== "windowContainer" && root !== "stage") {
    throw new Error(`root must be 'windowContainer' or 'stage' — got '${root}'`);
  }
  const rootContent = args.rootContent ?? "HomeStage()";
  const containers = args.containers ?? [];

  const seen = new Set<string>();
  for (const c of containers) {
    if (!c.id) throw new Error("every secondary container needs an id");
    if (seen.has(c.id)) throw new Error(`duplicate container id '${c.id}' — ids address open/close calls, they must be unique`);
    seen.add(c.id);
  }
  const stages = containers.filter((c): c is SecondaryStage => c.kind === "stage");
  const windows = containers.filter((c): c is SecondaryWindowContainer => c.kind === "window");
  if (root === "stage" && stages.length > 1) {
    // Still refused: several secondary Stages on a Stage root has no grounding at all, and only one
    // Stage is open at a time, so the second and third could only ever take over from each other.
    throw new Error("root 'stage' with MORE THAN ONE secondary stage is not a grounded configuration — only one Stage is open at a time; declare one and reuse it");
  }

  const needsNavigator = containers.length > 0;
  const hasStage = stages.length > 0;

  const kt = [
    `package ${packageName}`,
    ``,
    ...(needsNavigator ? [`import androidx.compose.runtime.Composable`, `import androidx.compose.runtime.DisposableEffect`] : []),
    ...(hasStage ? [`import androidx.compose.runtime.rememberCoroutineScope`] : []),
    ...(needsNavigator ? [`import androidx.lifecycle.compose.LocalLifecycleOwner`] : []),
    ...(windows.length ? [`import androidx.compose.ui.Modifier`] : []),
    `import androidx.compose.ui.unit.dp`,
    ...(needsNavigator ? [`import androidx.lifecycle.Lifecycle`, `import androidx.lifecycle.LifecycleEventObserver`] : []),
    ...(hasStage ? [`import kotlinx.coroutines.launch`] : []),
    ...(args.rootContentImport ? [`import ${args.rootContentImport}`] : []),
    // Per-container content imports. Without these a multi-container app whose secondary content
    // lives in a subpackage (which is what our own scaffold does) does not compile, and the tool
    // reports success — the failure only surfaces at build time. Deduped so two containers sharing
    // a composable do not emit it twice.
    ...[...new Set(containers.map((c) => c.contentImport).filter(Boolean))].map((i) => `import ${i}`),
    `import com.pico.spatial.ui.design.PicoTheme`,
    ...(root === "windowContainer"
      ? [`import com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer`]
      : [`import com.pico.spatial.ui.foundation.dsl.DefaultStage`]),
    ...(windows.length
      ? [
          `import com.pico.spatial.ui.foundation.dsl.Form`,
          `import com.pico.spatial.ui.foundation.dsl.WindowContainer`,
          `import com.pico.spatial.ui.foundation.dsl.WindowContainerSize`,
          `import com.pico.spatial.ui.platform.resize.ContainerResizeType`,
        ]
      : []),
    ...(hasStage
      ? [
          `import com.pico.spatial.ui.foundation.dsl.Immersion`,
          `import com.pico.spatial.ui.foundation.dsl.Stage`,
          `import com.pico.spatial.ui.platform.containers.StageStyle`,
        ]
      : []),
    `import com.pico.spatial.ui.foundation.dsl.SpatialAppScope`,
    ...(needsNavigator ? [`import com.pico.spatial.ui.platform.containers.LocalSpatialNavigator`] : []),
    ``,
    `/**`,
    ` * GENERATED by generate_container_app_kotlin — the app entry, with more than one container.`,
    ` *`,
    ` * Exactly one Default* container per app: it is what PICO OS launches. Every other container is`,
    ` * DECLARED here and OPENED at runtime through the navigator — declaring one does not open it.`,
    ` * Secondary containers need no manifest entry.`,
    ` */`,
    `fun mainApp(scope: SpatialAppScope) = with(scope) {`,
    ...(root === "windowContainer"
      ? [
          `    DefaultWindowContainer {`,
          `        PicoTheme {`,
          `            // windowConstraints comes from WindowContainerConstraintsScope, so it exists only`,
          `            // inside WindowContainer content. Under ContainerResizeType.ContentSize it is what`,
          `            // actually sizes the window — a ContentSize container with no constraints has no`,
          `            // source for its bounds.`,
          `            ${rootContent.replace(/\(\)$/, "")}(Modifier.windowConstraints(width = ${args.rootWidthDp ?? 1280}.dp, height = ${args.rootHeightDp ?? 720}.dp))`,
          `        }`,
          `    }`,
        ]
      : [`    DefaultStage { PicoTheme { ${rootContent} } }`]),
    ...windows.flatMap((w) => [
      ``,
      `    // Declared, not opened. Call Open${pascal(w.id)}OnEnter() from a composable inside a container.`,
      `    WindowContainer(`,
      `        id = SpatialContainers.${idConst(w.id)},`,
      `        form = Form.${w.form ?? "Planar"},`,
      `        defaultSize = WindowContainerSize(${w.widthDp ?? 1280}.dp, ${w.heightDp ?? 720}.dp${w.depthDp != null ? `, ${w.depthDp}.dp` : ""}),`,
      `        resizeType = ContainerResizeType.${w.resizeType ?? "ContentSize"},`,
      `        enableMaterialBackground = ${w.materialBackground ?? true},`,
      `    ) {`,
      `        PicoTheme {`,
      `            // 'bundle' is whatever the opener passed to openWindowContainer (SpatialContainerScope.kt:23).`,
      `            ${w.content ?? `${pascal(w.id)}Content(bundle)`}`,
      `        }`,
      `    }`,
    ]),
    ...stages.flatMap((s) => [
      ``,
      `    // A Stage has NO style parameter — style is chosen when you OPEN it (openStage(id, style)).`,
      `    // Immersion is declared here, via the Immersion(...) FACTORY; its class ctor is internal.`,
      ...(root === "stage"
        ? [
            `    // TAKEOVER, not an addition. MEASURED on emulator-5554 (ledger com.picoagent.v35expc#2):`,
            `    // opening this Stage STOPS the DefaultStage above from rendering — its entities are still`,
            `    // alive, but nothing of it is drawn until this one closes. Stage.kt:73 says as much`,
            `    // ("When Stage is opened, the system will hide windows from other apps"); the practical`,
            `    // consequence is that a second Stage is a MODE SWITCH, not a second view. If you wanted`,
            `    // both on screen at once, you wanted a WindowContainer.`,
          ]
        : []),
      `    Stage(`,
      `        id = SpatialContainers.${idConst(s.id)},`,
      `        immersion = Immersion(default = ${s.immersion ?? 100}, min = ${s.immersionMin ?? 0}, max = ${s.immersionMax ?? 100}),`,
      `    ) {`,
      `        PicoTheme { ${s.content ?? `${pascal(s.id)}Content()`} }`,
      `    }`,
    ]),
    `}`,
    ``,
    ...(needsNavigator
      ? [
          `/** Container ids and the navigator calls that open and close them. */`,
          `object SpatialContainers {`,
          ...containers.map((c) => `    const val ${idConst(c.id)} = ${JSON.stringify(c.id)}`),
          `}`,
          ``,
        ]
      : []),
    ...windows.flatMap((w) => {
      const fn = pascal(w.id);
      return [
        `/**`,
        ` * Open the '${w.id}' WindowContainer. Call from a @Composable inside a container:`,
        ` *   val navigator = LocalSpatialNavigator.current`,
        ` *   Button(onClick = { navigator.openWindowContainer(SpatialContainers.${idConst(w.id)}, tag, bundle) }) { ... }`,
        ` *`,
        ` * DECLARING the container in mainApp does NOT open it. openWindowContainer is not suspend.`,
        ` * The optional bundle arrives on the receiving side as WindowContainerScope.bundle.`,
        ` */`,
        `@Composable`,
        `fun Open${fn}OnEnter(tag: String? = null, bundle: android.os.Bundle? = null) {`,
        `    val navigator = LocalSpatialNavigator.current`,
        `    val lifecycleOwner = LocalLifecycleOwner.current`,
        `    DisposableEffect(lifecycleOwner) {`,
        `        navigator.openWindowContainer(SpatialContainers.${idConst(w.id)}, tag, bundle)`,
        `        // Close on ON_PAUSE as well as in onDispose. closeWindowContainer is NOT suspend, so`,
        `        // onDispose alone would work here — but a Stage's closeStage IS suspend and onDispose`,
        `        // cannot run it (the scope is already cancelled), so both cases use the lifecycle`,
        `        // observer and stay consistent.`,
        `        val observer = LifecycleEventObserver { _, event ->`,
        `            if (event == Lifecycle.Event.ON_PAUSE) {`,
        `                navigator.closeWindowContainer(SpatialContainers.${idConst(w.id)}, tag)`,
        `            }`,
        `        }`,
        `        lifecycleOwner.lifecycle.addObserver(observer)`,
        `        onDispose {`,
        `            lifecycleOwner.lifecycle.removeObserver(observer)`,
        `            navigator.closeWindowContainer(SpatialContainers.${idConst(w.id)}, tag)`,
        `        }`,
        `    }`,
        `}`,
        ``,
      ];
    }),
    ...stages.flatMap((s) => {
      const fn = pascal(s.id);
      return [
        `/**`,
        ` * Open the '${s.id}' Stage and close it again on the way out.`,
        ` *`,
        ` * openStage/closeStage are SUSPEND (SpatialNavigator.kt:100,108), so they need a scope — and`,
        ` * that is exactly where the obvious version goes wrong. This does NOT work:`,
        ` *`,
        ` *     DisposableEffect(Unit) { onDispose { scope.launch { navigator.closeStage() } } }`,
        ` *`,
        ` * A rememberCoroutineScope() scope is cancelled when it leaves composition, and onDispose runs`,
        ` * after that — the launch is a no-op and the Stage never closes. Close on ON_PAUSE/ON_DESTROY`,
        ` * instead, which runs BEFORE disposal. Both PICO samples do it this way.`,
        ` */`,
        `@Composable`,
        `fun Open${fn}OnEnter(style: StageStyle = StageStyle.${s.style ?? "Mixed"}, bundle: android.os.Bundle? = null) {`,
        `    val navigator = LocalSpatialNavigator.current`,
        `    val lifecycleOwner = LocalLifecycleOwner.current`,
        `    val scope = rememberCoroutineScope()`,
        `    DisposableEffect(lifecycleOwner) {`,
        `        scope.launch { navigator.openStage(SpatialContainers.${idConst(s.id)}, style, bundle) }`,
        `        val observer = LifecycleEventObserver { _, event ->`,
        `            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_DESTROY) {`,
        `                // Still on a live scope here: ON_PAUSE fires before the composition leaves.`,
        `                scope.launch { navigator.closeStage() }`,
        `            }`,
        `        }`,
        `        lifecycleOwner.lifecycle.addObserver(observer)`,
        `        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }`,
        `    }`,
        `}`,
        ``,
      ];
    }),
  ].join("\n");

  return {
    files: { "Main.kt": kt },
    note:
      `Write Main.kt to app/src/main/java/${packageName.replace(/\./g, "/")}/Main.kt — it REPLACES the existing Main.kt (an app has exactly one mainApp). ` +
      `The Default* container is what PICO OS launches and needs the matching manifest meta-data; secondary containers are declared here and need NO manifest entry. ` +
      `Declaring a container does not open it — call the emitted Open*OnEnter helper, or navigator.openWindowContainer/openStage directly. ` +
      `HONEST STATUS: vision_verified for both container kinds (see below). Every symbol is confirmed in the 0.13.3 sources jars and adversarially re-verified. ` +
      `MEASURED 2026-08-06 (vision_verified, ledger com.picoagent.v35expb#0): a DefaultStage app declaring a secondary WindowContainer and calling this generator's ` +
      `Open*OnEnter helper DOES get a real floating glass spatial panel on the emulator, rendering live SpatialUI text over the passthrough home environment; ` +
      `dumpsys shows a second visible SpatialStubActivity task the app launched itself. That NARROWS our v9.3 note ("an immersive app's own WindowContainer does ` +
      `NOT open a panel window on the emulator") — the v9.3 measurement was of a DECLARED-BUT-NEVER-OPENED container. Declaring registers; opening is a separate call. ` +
      `Still unmeasured: opening a secondary STAGE via openStage, and cross-container Bundle delivery. Look at a capture before claiming either.`,
  };
}

export function registerContainerTools(server: McpServer) {
  server.registerTool(
    "generate_container_app_kotlin",
    {
      description:
        "Emit a Main.kt with MORE THAN ONE container — a DefaultWindowContainer or DefaultStage root plus secondary WindowContainers and Stages, opened and closed at runtime through LocalSpatialNavigator. Returns JSON {files:{'Main.kt'}, note}. WHY: generate_app_wiring has always emitted DefaultStage for every app, but PICO's WelcomeSpace (the Week-1 curriculum anchor) declares three containers in one mainApp and navigates between them, so an agentic track limited to DefaultStage cannot reach a comparable outcome by prompting. FOUR RULES IT ENCODES, each read from the 0.13.3 sources jars and adversarially re-verified: (1) a DECLARED container does not open itself — WindowContainer(id=...) only registers it, something must call navigator.openWindowContainer(id), which is very likely why our own measurement said an app's own WindowContainer never appears; (2) the obvious Stage teardown is BROKEN — closeStage is suspend, and DisposableEffect{onDispose{scope.launch{closeStage()}}} silently never runs because a rememberCoroutineScope is cancelled before onDispose, so we close on a LifecycleEventObserver at ON_PAUSE/ON_DESTROY like PICO's own samples; (3) Stage has NO style parameter — immersion is declared via the Immersion(...) factory (its class ctor is internal) and the style is chosen at openStage time; (4) Modifier.windowConstraints belongs to WindowContainerConstraintsScope, so it exists only inside WindowContainer content, and under ContainerResizeType.ContentSize it is what actually sizes the window. It deliberately does NOT emit the manifest meta-data keys for style/worldscaletype/defaultsize — those resolve through framework stubs absent from 0.13.3 and their encodings are KDoc-only; the DSL parameters are the verified path. (5) every container's content needs its OWN import — `contentImport` per container, not just rootContentImport. Without it a multi-container app whose secondary content lives in a subpackage (which is what our own scaffold does) failed to compile while this tool reported success; that gap was found by building the output rather than reading it. HONEST STATUS: vision_verified on emulator-5554 for BOTH container kinds. WindowContainer: ledger com.picoagent.v35expb#0. Stage: ledger com.picoagent.v35expc#2 (2026-08-06) — a declared secondary Stage DOES open on navigator.openStage(id, style, bundle), and the Bundle CROSSES the boundary intact (receiver read StageScope.bundle and got back exactly what was sent). Also measured: opening the second Stage REPLACES the first — the DefaultStage content stops rendering, matching Stage.kt:73 'When Stage is opened, the system will hide windows from other apps'. So a Stage is not a second window you add; it is a takeover.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package of the app entry, e.g. com.example.app"),
        root: z
          .enum(["windowContainer", "stage"])
          .optional()
          .describe("The app's launch container — exactly one Default* per app. 'windowContainer' (default) is the WelcomeSpace shape: a panel-led app that opens a Stage on demand. 'stage' is the immersive-first shape our generator has always emitted."),
        rootContent: z.string().optional().describe("Composable call for the root's content, e.g. 'HomeStage()'. For a windowContainer root, the Modifier.windowConstraints is passed to it."),
        rootContentImport: z.string().optional().describe("Fully-qualified import for rootContent, e.g. com.example.app.content.HomeStage"),
        rootWidthDp: z.number().optional().describe("Root windowConstraints width in dp (default 1280). Ignored for a stage root."),
        rootHeightDp: z.number().optional().describe("Root windowConstraints height in dp (default 720). Ignored for a stage root."),
        containers: z
          .array(
            z.union([
              z.object({
                kind: z.literal("window"),
                id: z.string().describe("Unique id — it addresses the open/close calls."),
                form: z.enum(FORMS).optional().describe("Planar (a flat window) or Volumetric (a 3D box). Default Planar."),
                widthDp: z.number().optional(),
                heightDp: z.number().optional(),
                depthDp: z.number().optional().describe("Volumetric only — the third axis of the default size."),
                resizeType: z.enum(RESIZE_TYPES).optional().describe("Default ContentSize, which reads its bounds from Modifier.windowConstraints on the content."),
                materialBackground: z.boolean().optional().describe("Glass/material backing. Default true."),
                content: z.string().optional().describe("Composable call for this container's content. It can read `bundle` (whatever the opener passed)."),
                contentImport: z.string().optional().describe("Fully-qualified import for `content`, e.g. com.example.app.content.DetailPanel. REQUIRED when the composable is not in the same package as Main.kt, or the emitted file will not compile."),
              }),
              z.object({
                kind: z.literal("stage"),
                id: z.string(),
                style: z.enum(STAGE_STYLES).optional().describe("Style used when OPENING (Stage itself has no style param). Default Mixed — the MR lane."),
                immersion: z.number().optional().describe("Default immersion 0-100 (Progressive only). Default 100."),
                immersionMin: z.number().optional().describe("Default 0 — keep below immersionMax or Progressive cannot be adjusted."),
                immersionMax: z.number().optional().describe("Default 100."),
                content: z.string().optional(),
                contentImport: z.string().optional().describe("Fully-qualified import for `content`. REQUIRED when the composable is not in Main.kt's package."),
              }),
            ]),
          )
          .optional()
          .describe("Secondary containers, declared in mainApp and opened at runtime. They need no manifest entry."),
      },
    },
    async (a) => {
      try {
        return ok(JSON.stringify(generateContainerAppFiles(a as ContainerAppArgs), null, 2));
      } catch (e: any) {
        return fail(String(e?.message ?? e));
      }
    },
  );
}
