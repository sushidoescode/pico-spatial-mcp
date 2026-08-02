import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./util.js";

/**
 * panelcompose.ts — v9.4 the HYBRID-APP tier: Compose WindowContainer panels with LIVE RUNTIME TEXT.
 *
 * THE UNLOCK (v9.3, vision-verified): the emulator composites every 2D window as a floating spatial
 * panel (SpaceWindowAttributes -> spatial_container service -> a 3D quad with system chrome). A
 * WindowContainer panel is a normal Compose surface, so it renders REAL LIVE TEXT — the
 * no-TextComponent limitation applies only to in-scene 3D content. Hybrid app = Filament 3D scene
 * (DefaultStage) + Compose panels (WindowContainer) for HUD/scoreboard/detail.
 *
 * Panels spawn at the shell dock position, OFF the default forward view — verify by turning the
 * camera (the C2 sweep), not by a forward-only capture.
 */
export function registerPanelComposeTools(server: McpServer) {
  server.registerTool(
    "generate_panel_compose_kotlin",
    {
      description:
        "Emit HudPanel.kt — a LIVE-RUNTIME-TEXT spatial panel (the hybrid-app tier). ARCHITECTURE (the proven path): the panel is its OWN 2D ACTIVITY (HudPanelActivity, same APK + process) — the OS auto-hosts every 2D task as a floating spatial panel over the still-rendering immersive scene (vision-verified with Settings, v9.3). An immersive app's own WindowContainer does NOT open a panel window on the emulator — don't use it for this. Compose state is shared in-process, so DEBUG_CMD 'hud:<key>=<value>' -> HudState.set updates the text LIVE; HudState.onLaunch()/onReset() are game hooks the wiring calls from menu actions (bump 'throws', READY/ROLLING 'status'). Show/hide headlessly: DEBUG_CMD 'panel:show'/'panel:hide' (wired by generate_app_wiring for any spec with panels — show starts the activity from the APP'S OWN context because shell am start is refused while the Stage holds Full Space; hide finishes it via the activity's instance companion, the rocketsim-proven way to un-occlude scene captures). adb shell am start -n <pkg>/<contentPkg>.HudPanelActivity also works when the shell start is not refused. RETURNS: JSON {kotlin, manifestEntry, note} — write kotlin to the targetPath and merge manifestEntry into <application>: the activity with its own taskAffinity so it doesn't replace the immersive task. placement:'world' is accepted but NOT world-locked — no vault-confirmed API positions an auto-hosted 2D panel in world space; it emits the same dock path plus a loud head-docked-fallback marker in the code + note.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content"),
        kind: z.enum(["hud", "web"]).default("hud").describe("hud = the live label:value Compose scoreboard. web = a WebView panel (FULL HTML/CSS/JS with a LIVE DOM — vision-verified: a JS setInterval ticked live in-world). Web panels put charts/dashboards/docs in the spatial viewport."),
        url: z.string().optional().describe("kind='web': a URL to load (needs INTERNET permission), OR omit and pass html."),
        html: z.string().optional().describe("kind='web': inline HTML to render (deterministic, no network). Ignored for kind='hud'."),
        title: z.string().optional().describe("Panel heading text (default 'STATUS'). hud only."),
        fields: z
          .array(z.object({ key: z.string(), label: z.string(), initial: z.string() }))
          .optional()
          .describe("The label:value rows, e.g. [{key:'throws',label:'THROWS',initial:'0'},{key:'status',label:'STATUS',initial:'READY'}]. Default exactly that."),
        placement: z
          .enum(["dock", "world"])
          .optional()
          .describe("'world' = a world-anchored panel was REQUESTED. HONEST LIMIT: no public API positions an auto-hosted 2D panel in world space (vault-checked), so 'world' changes NOTHING behaviorally — it only stamps a loud 'world placement pending SDK confirmation — head-docked fallback' comment into the emitted code + note. Default 'dock' (the proven path)."),
      },
    },
    async ({ packageName, kind, url, html, title, fields, placement }) => {
      // v31: 'world' placement has no vault-confirmed API — emit the dock path with a LOUD marker
      // so the fallback is visible in the source and the tool result, never silently swallowed.
      const worldCommentLines = placement === "world"
        ? [
            ` * WORLD PLACEMENT REQUESTED — world placement pending SDK confirmation: no public API`,
            ` * positions an auto-hosted 2D panel in world space (vault-checked), so this panel uses`,
            ` * the HEAD-DOCKED fallback and spawns at the dock. Verify by turning the camera.`,
          ]
        : [];
      const worldNote = placement === "world" ? "; WORLD PLACEMENT REQUESTED: world placement pending SDK confirmation — head-docked fallback" : "";
      if (kind === "web") {
        const load = url
          ? `wv.loadUrl(${JSON.stringify(url)})`
          : `wv.loadDataWithBaseURL(null, HTML, "text/html", "utf-8", null)`;
        const htmlConst = url ? "" : `
    private val HTML = ${JSON.stringify(html ?? "<html><body style='background:#0b1020;color:#7fd7ff;font-size:48px;padding:40px'>WEB PANEL</body></html>")}
`;
        const kt = [
          `package ${packageName}`,
          ``,
          `import android.annotation.SuppressLint`,
          `import android.os.Bundle`,
          `import android.webkit.WebView`,
          `import androidx.activity.ComponentActivity`,
          ``,
          `/**`,
          ` * Generated by generate_panel_compose_kotlin (kind='web') — WEB CONTENT as a floating spatial`,
          ` * panel. Full HTML/CSS/JS with a LIVE DOM (vision-verified: JS timers tick in-world). The`,
          ` * activity is its own task; the OS auto-hosts it as a spatial panel (spawns at the dock).`,
          ` * Show/hide: DEBUG_CMD panel:show / panel:hide (in-app start — shell am start is refused`,
          ` * while the Stage holds Full Space); or adb shell am start -n <pkg>/${packageName}.WebPanelActivity`,
          ...worldCommentLines,
          ` */`,
          `class WebPanelActivity : ComponentActivity() {${htmlConst}`,
          `    @SuppressLint("SetJavaScriptEnabled")`,
          `    override fun onCreate(savedInstanceState: Bundle?) {`,
          `        super.onCreate(savedInstanceState)`,
          `        instance = this`,
          `        val wv = WebView(this)`,
          `        wv.settings.javaScriptEnabled = true`,
          `        ${load}`,
          `        setContentView(wv)`,
          `    }`,
          ``,
          `    override fun onDestroy() {`,
          `        if (instance === this) instance = null`,
          `        super.onDestroy()`,
          `    }`,
          ``,
          `    companion object {`,
          `        /** For DEBUG_CMD panel:hide — the head-docked panel occludes the scene from the fixed`,
          `         *  emulator pose; hiding it is the only way to capture clean composition frames. */`,
          `        @Volatile var instance: WebPanelActivity? = null`,
          `    }`,
          `}`,
          ``,
        ].join("\n");
        const manifestEntry = `<activity android:name="${packageName}.WebPanelActivity" android:exported="true" android:taskAffinity="${packageName}.webpanel" android:launchMode="singleTask" />`;
        return ok(JSON.stringify({ kotlin: kt, manifestEntry, note: `Write kotlin to WebPanel.kt; merge manifestEntry into <application>${url ? "; add <uses-permission android:name=\"android.permission.INTERNET\"/> for the URL" : ""}; show/hide via DEBUG_CMD panel:show / panel:hide (wired by generate_app_wiring; in-app start — shell am start is refused while the Stage holds Full Space), or adb shell am start -n <pkg>/${packageName}.WebPanelActivity${worldNote}` }, null, 2));
      }
      const t = title ?? "STATUS";
      const fl = fields && fields.length ? fields : [
        { key: "throws", label: "THROWS", initial: "0" },
        { key: "status", label: "STATUS", initial: "READY" },
      ];
      const hasThrows = fl.some((f) => f.key === "throws");
      const hasStatus = fl.some((f) => f.key === "status");
      const kt = [
        `package ${packageName}`,
        ``,
        `import androidx.compose.foundation.background`,
        `import androidx.compose.foundation.layout.Arrangement`,
        `import androidx.compose.foundation.layout.Column`,
        `import androidx.compose.foundation.layout.Row`,
        `import androidx.compose.foundation.layout.fillMaxWidth`,
        `import androidx.compose.foundation.layout.width`,
        `import androidx.compose.foundation.layout.padding`,
        `import androidx.compose.foundation.shape.RoundedCornerShape`,
        `import androidx.compose.runtime.Composable`,
        `import androidx.compose.runtime.mutableStateMapOf`,
        `import androidx.compose.ui.Modifier`,
        `import androidx.compose.ui.graphics.Color`,
        `import androidx.compose.ui.unit.dp`,
        `import androidx.compose.ui.unit.sp`,
        `import android.os.Bundle`,
        `import androidx.activity.ComponentActivity`,
        `import androidx.compose.ui.platform.ComposeView`,
        `import com.pico.spatial.ui.design.Text`,
        ``,
        `/**`,
        ` * Generated by generate_panel_compose_kotlin — a LIVE-TEXT spatial panel (hybrid-app tier).`,
        ` * The panel is its OWN 2D activity: the OS auto-hosts 2D tasks as floating spatial panels`,
        ` * over the immersive scene (an app's own WindowContainer does NOT open on the emulator).`,
        ` * Same process => shared Compose state: DEBUG_CMD 'hud:<key>=<value>' updates text LIVE;`,
        ` * 'panel:show' starts the activity (from the app's own context) and 'panel:hide' finishes`,
        ` * it — the panel occludes the fixed emulator pose, so hide it for clean scene captures.`,
        ` * Panels spawn near the dock — turn the camera to see.`,
        ...worldCommentLines,
        ` */`,
        `object HudState {`,
        `    val values = mutableStateMapOf(${fl.map((f) => `"${f.key}" to "${f.initial}"`).join(", ")})`,
        `    val labels = linkedMapOf(${fl.map((f) => `"${f.key}" to "${f.label}"`).join(", ")})`,
        ``,
        `    fun set(key: String, value: String) { values[key] = value }`,
        ``,
        `    fun bump(key: String) { values[key] = ((values[key]?.toIntOrNull() ?: 0) + 1).toString() }`,
        ``,
        `    /** Game hook: called by the wiring when a launch action fires. */`,
        `    fun onLaunch() {`,
        hasThrows ? `        bump("throws")` : `        // no 'throws' field`,
        hasStatus ? `        set("status", "ROLLING")` : `        // no 'status' field`,
        `    }`,
        ``,
        `    /** Game hook: called by the wiring when a reset action fires. */`,
        `    fun onReset() {`,
        hasStatus ? `        set("status", "READY")` : `        // no 'status' field`,
        `    }`,
        `}`,
        ``,
        `@Composable`,
        `fun HudPanel() {`,
        `    Column(`,
        `        modifier = Modifier`,
        `            .width(720.dp) // DESIGN.md §4: panels >= 700dp or they read tiny at distance (wrap-content can collapse the window)`,
        `            .background(Color(0xFF0B1020), RoundedCornerShape(18.dp))`,
        `            .padding(28.dp),`,
        `        verticalArrangement = Arrangement.spacedBy(14.dp),`,
        `    ) {`,
        `        Text("${t}", fontSize = 34.sp, color = Color(0xFF7FD7FF))`,
        `        HudState.labels.forEach { (key, label) ->`,
        `            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {`,
        `                Text(label, fontSize = 26.sp, color = Color(0xFF9AA4BF))`,
        `                Text(HudState.values[key] ?: "", fontSize = 26.sp, color = Color.White)`,
        `            }`,
        `        }`,
        `    }`,
        `}`,
        ``,
        `/** The 2D panel host — its own task, auto-hosted as a floating spatial panel by the OS. */`,
        `class HudPanelActivity : ComponentActivity() {`,
        `    override fun onCreate(savedInstanceState: Bundle?) {`,
        `        super.onCreate(savedInstanceState)`,
        `        instance = this`,
        `        setContentView(ComposeView(this).apply { setContent { HudPanel() } })`,
        `    }`,
        ``,
        `    override fun onDestroy() {`,
        `        if (instance === this) instance = null`,
        `        super.onDestroy()`,
        `    }`,
        ``,
        `    companion object {`,
        `        /** For DEBUG_CMD panel:hide — the head-docked panel occludes the scene from the fixed`,
        `         *  emulator pose; hiding it is the only way to capture clean composition frames. */`,
        `        @Volatile var instance: HudPanelActivity? = null`,
        `    }`,
        `}`,
        ``,
      ].join("\n");
      const manifestEntry = `<activity android:name="${packageName}.HudPanelActivity" android:exported="true" android:taskAffinity="${packageName}.panel" android:launchMode="singleTask" />`;
      return ok(JSON.stringify({ kotlin: kt, manifestEntry, note: `Write kotlin to HudPanel.kt; merge manifestEntry into <application>; show/hide via DEBUG_CMD panel:show / panel:hide (wired by generate_app_wiring; in-app start — shell am start is refused while the Stage holds Full Space), or adb shell am start -n <pkg>/<contentPkg>.HudPanelActivity${worldNote}` }, null, 2));
    },
  );
}
