import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fail, okJson, ok } from "./util.js";

const run = promisify(execFile);
const ADB = process.env.PICO_ADB ?? path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb");
const SERIAL = "emulator-5554";

const PANEL_DOES_NOT_PROVE = [
  "that the panel's pixels rendered correctly",
  "that text, values, colors, or layout are correct or legible",
  "that the panel is inside the current capture field of view",
  "that the panel is unoccluded, focused, or free of shell ghosting",
];

type ParsedSpatialWindow = {
  name: string;
  package: string;
  activity: string | null;
  displayId: string | null;
  taskId: string | null;
  containerId: string | null;
  captionBarContainerId: string | null;
  windowEntityId: string | null;
  size: [number, number] | null;
  hasSurface: boolean;
  readyForDisplay: boolean;
  surfaceShown: boolean;
  onScreen: boolean;
  wmVisible: boolean;
  isViewAttachment: boolean;
  isViewAttachmentDecoupled: boolean;
  isCaptionBarWindow: boolean;
};

export type SpatialPanel = {
  name: string;
  package: string;
  activity: string;
  displayId: string | null;
  taskId: string | null;
  containerId: string;
  captionBarContainerId: string;
  windowEntityId: string | null;
  captionWindowEntityId: string | null;
  size: [number, number] | null;
  hasSurface: boolean;
  readyForDisplay: boolean;
  surfaceShown: boolean;
  onScreen: boolean;
  /** Normalized alias consumed by structural scorers; equivalent to wmVisible. */
  visible: boolean;
  wmVisible: boolean;
  captionBacked: true;
  contentReady: boolean;
  captionReady: boolean;
  ready: boolean;
  captionWindow: {
    name: string;
    package: string;
    containerId: string | null;
    captionBarContainerId: string | null;
    windowEntityId: string | null;
    hasSurface: boolean;
    readyForDisplay: boolean;
    surfaceShown: boolean;
    onScreen: boolean;
    wmVisible: boolean;
  };
};

export type SpatialPanelInventory = {
  status: "ok" | "error";
  evidenceType: "structural";
  error?: string;
  windowsParsed: number;
  packageFilter: string | null;
  expectedActivities: string[];
  count: number;
  panels: SpatialPanel[];
  matchedActivities: string[];
  missingActivities: string[];
  expectationMet: boolean | null;
  proves: string;
  doesNotProve: string[];
};

function windowReady(w: ParsedSpatialWindow): boolean {
  return w.hasSurface && w.readyForDisplay && w.surfaceShown && w.onScreen && w.wmVisible;
}

function fullyQualifiedActivity(pkg: string, activity: string | null): string | null {
  if (!activity) return null;
  return activity.startsWith(".") ? `${pkg}${activity}` : activity;
}

function errorInventory(error: string, opts: { packageFilter?: string; expectedActivities?: string[] }): SpatialPanelInventory {
  const expected = opts.expectedActivities ?? [];
  return {
    status: "error",
    evidenceType: "structural",
    error,
    windowsParsed: 0,
    packageFilter: opts.packageFilter ?? null,
    expectedActivities: expected,
    count: 0,
    panels: [],
    matchedActivities: [],
    missingActivities: [...expected],
    expectationMet: expected.length ? false : null,
    proves: "nothing — the WindowManager dump could not be parsed",
    doesNotProve: [...PANEL_DOES_NOT_PROVE],
  };
}

/**
 * Parse `dumpsys window windows` into an honest spatial-panel inventory.
 *
 * A PICO panel is NOT identifiable from the app window alone: immersive LaunchActivity and a
 * floating HudPanelActivity both carry SpaceWindowAttributes and a non-zero containerId. The
 * discriminating signal is a SECOND, healthy SystemUI caption window whose
 * `isCaptionBarWindow=true` and `captionBarContainerId=N` reference the app window's
 * `containerId [N]`. Parse every window first, perform that join, and only then apply the exact
 * package filter. This deliberately fails closed rather than calling every spatial window a panel.
 */
export function parseSpatialPanels(
  dump: string,
  opts: { packageFilter?: string; expectedActivities?: string[] } = {},
): SpatialPanelInventory {
  if (!dump || !dump.trim()) return errorInventory("empty dumpsys window output", opts);

  const blocks = dump
    .split(/(?=^\s*Window #\d+\s+Window\{)/m)
    .filter((b) => /^\s*Window #\d+\s+Window\{/.test(b));
  if (!blocks.length) return errorInventory("unparseable dumpsys window output (no Window blocks)", opts);

  const windows: ParsedSpatialWindow[] = [];
  for (const block of blocks) {
    const name = block.match(/Window\{[0-9a-fA-F]+\s+u\d+\s+([^}]+)\}/)?.[1]?.trim();
    const attr = block.match(/SpaceWindowAttributes\{[^}]*\}/)?.[0];
    if (!name || !attr) continue;
    const slash = name.indexOf("/");
    const pkg = slash >= 0 ? name.slice(0, slash) : name.split(/\s+/)[0];
    const activity = fullyQualifiedActivity(pkg, slash >= 0 ? name.slice(slash + 1) : null);
    const size = attr.match(/size=\[(\d+),\s*(\d+)\]/);
    windows.push({
      name,
      package: pkg,
      activity,
      displayId: block.match(/mDisplayId=(\d+)/)?.[1] ?? null,
      taskId: block.match(/\btaskId\s+\[(\d+)\]/)?.[1] ?? block.match(/\btaskId=(\d+)/)?.[1] ?? null,
      // The real spatial container id is on the line AFTER SpaceWindowAttributes. Do not confuse
      // it with captionBarContainerId inside the attributes (the old implementation did).
      containerId: block.match(/\bcontainerId\s+\[(\d+)\]/)?.[1] ?? null,
      captionBarContainerId: attr.match(/captionBarContainerId=(\d+)/)?.[1] ?? null,
      windowEntityId: attr.match(/windowEntityId=(\d+)/)?.[1] ?? null,
      size: size ? [Number(size[1]), Number(size[2])] : null,
      hasSurface: /mHasSurface=true/.test(block),
      readyForDisplay: /isReadyForDisplay\(\)=true/.test(block),
      surfaceShown: /Surface:\s+shown=true/.test(block),
      onScreen: /isOnScreen=true/.test(block),
      wmVisible: /isVisible=true/.test(block),
      isViewAttachment: /isViewAttachment=true/.test(attr),
      isViewAttachmentDecoupled: /isViewAttachmentDecoupled=true/.test(attr),
      isCaptionBarWindow: /isCaptionBarWindow=true/.test(attr),
    });
  }
  if (!windows.length) return errorInventory("unparseable dumpsys window output (no spatial windows)", opts);

  // Caption windows belong to SystemUI, have no app container of their own, and point back to the
  // content window's container. Only a fully ready/visible caption is strong enough structural
  // evidence; an allocated-but-not-drawn caption fails closed.
  const captionsByContainer = new Map<string, ParsedSpatialWindow[]>();
  for (const w of windows) {
    const target = w.captionBarContainerId;
    if (
      w.package !== "com.picoxr.systemui" ||
      !w.isCaptionBarWindow ||
      !w.isViewAttachment ||
      !target ||
      target === "0" ||
      !windowReady(w)
    ) continue;
    const arr = captionsByContainer.get(target) ?? [];
    arr.push(w);
    captionsByContainer.set(target, arr);
  }

  const allPanels: SpatialPanel[] = [];
  const seenContainers = new Set<string>();
  for (const w of windows) {
    const containerId = w.containerId;
    if (
      !w.activity ||
      w.package === "com.picoxr.systemui" ||
      w.isCaptionBarWindow ||
      w.isViewAttachment ||
      !containerId ||
      containerId === "0" ||
      !windowReady(w) ||
      seenContainers.has(containerId)
    ) continue;
    const caption = captionsByContainer.get(containerId)?.[0];
    if (!caption) continue; // immersive stage windows have no caption join and are excluded here.
    seenContainers.add(containerId);
    const contentReady = windowReady(w);
    const captionReady = windowReady(caption);
    allPanels.push({
      name: w.name,
      package: w.package,
      activity: w.activity,
      displayId: w.displayId,
      taskId: w.taskId,
      containerId,
      captionBarContainerId: caption.captionBarContainerId ?? containerId,
      windowEntityId: w.windowEntityId,
      captionWindowEntityId: caption.windowEntityId,
      size: w.size,
      hasSurface: w.hasSurface,
      readyForDisplay: w.readyForDisplay,
      surfaceShown: w.surfaceShown,
      onScreen: w.onScreen,
      visible: w.wmVisible,
      wmVisible: w.wmVisible,
      captionBacked: true,
      contentReady,
      captionReady,
      ready: contentReady && captionReady,
      captionWindow: {
        name: caption.name,
        package: caption.package,
        containerId: caption.containerId,
        captionBarContainerId: caption.captionBarContainerId,
        windowEntityId: caption.windowEntityId,
        hasSurface: caption.hasSurface,
        readyForDisplay: caption.readyForDisplay,
        surfaceShown: caption.surfaceShown,
        onScreen: caption.onScreen,
        wmVisible: caption.wmVisible,
      },
    });
  }

  // Exact package equality is intentional. Substring filtering can mix com.foo with com.foobar
  // and silently satisfy an expected panel count with the wrong app.
  const panels = opts.packageFilter !== undefined
    ? allPanels.filter((p) => p.package === opts.packageFilter)
    : allPanels;
  const expected = opts.expectedActivities ?? [];
  // Match both the normalized fully-qualified activity and the raw full component name. Android
  // may print a shorthand component such as `com.foo/.HudActivity`; callers should still be able
  // to expect the stable `com.foo.HudActivity` identity.
  const actualNames = new Set(panels.flatMap((p) => [p.activity, p.name]));
  const matchedActivities = expected.filter((a) => actualNames.has(a));
  const missingActivities = expected.filter((a) => !actualNames.has(a));

  return {
    status: "ok",
    evidenceType: "structural",
    windowsParsed: windows.length,
    packageFilter: opts.packageFilter ?? null,
    expectedActivities: expected,
    count: panels.length,
    panels,
    matchedActivities,
    missingActivities,
    expectationMet: expected.length ? missingActivities.length === 0 : null,
    proves:
      "WindowManager reports each listed app window in a distinct spatial container with a drawn, on-screen, WM-visible SystemUI caption bound to that container",
    doesNotProve: [...PANEL_DOES_NOT_PROVE],
  };
}

/**
 * webworkspace.ts — v10.11 (P9): the multi-panel WEB WORKSPACE.
 *
 * Extends the single web panel (panelcompose kind='web') to N NAMED panels: each is its own 2D
 * WebView activity with its own taskAffinity + launchMode=singleTask, so the OS auto-hosts each as
 * an INDEPENDENT floating spatial panel (verified mechanism). A shared WebPanelRegistry + a
 * <pkg>.PANEL_CMD manifest receiver drive each panel by name at runtime:
 *   adb shell am broadcast -a <pkg>.PANEL_CMD --es cmd 'panel:url:<name>=<url>'   (loadUrl)
 *   adb shell am broadcast -a <pkg>.PANEL_CMD --es cmd 'panel:js:<name>=<expr>'   (evaluateJavascript)
 *   adb shell am broadcast -a <pkg>.PANEL_CMD --es cmd 'panel:close:<name>'
 * Open a panel: adb shell am start -n <pkg>/<pkg>.content.WebPanel_<name> (or WebWorkspace.openAll).
 * list_spatial_panels reads dumpsys window windows -> the on-stage {package, container} map.
 */

const kid = (name: string) => name.replace(/[^A-Za-z0-9]/g, "_");

export function registerWebWorkspaceTools(server: McpServer) {
  server.registerTool(
    "generate_web_workspace",
    {
      description:
        "Emit WebWorkspace.kt — a multi-panel WEB WORKSPACE (P9): N NAMED WebView panels, each its own 2D task so the OS floats each as an INDEPENDENT spatial panel (full HTML/CSS/JS live DOM). Drive each by name at runtime via <pkg>.PANEL_CMD broadcasts: 'panel:url:<name>=<url>' (navigate), 'panel:js:<name>=<expr>' (run JS), 'panel:close:<name>'. Open panels with `am start -n <pkg>/<contentPkg>.WebPanel_<name>` or WebWorkspace.openAll(context). RETURNS: JSON {kotlin, manifestEntries:[...], openCommands:[...], driveExamples:[...]} — write kotlin to content/WebWorkspace.kt, merge ALL manifestEntries into <application> (+ INTERNET permission if any panel uses a URL). Panels spawn at the dock; capture_frame + a sweep to see them. Verifies today (2D web renders as panels); pair with drive_browser/webxr_probe for the browser lane.",
      inputSchema: {
        packageName: z.string().describe("Content package, e.g. com.example.app.content"),
        panels: z
          .array(z.object({
            name: z.string().describe("Panel id (used in class name + PANEL_CMD addressing), e.g. 'dash'."),
            url: z.string().optional().describe("Initial URL (needs INTERNET permission)."),
            html: z.string().optional().describe("Initial inline HTML (deterministic, no network)."),
          }))
          .min(1)
          .describe("The named panels."),
      },
    },
    async ({ packageName, panels }) => {
      const appPkg = packageName.replace(/\.content$/, "");
      const cfgLines = panels.map((p) => {
        const url = p.url ? JSON.stringify(p.url) : "null";
        const html = p.html ? JSON.stringify(p.html) : "null";
        return `        "${p.name}" to Cfg(${url}, ${html})`;
      }).join(",\n");
      const order = panels.map((p) => `"${p.name}"`).join(", ");
      const subclasses = panels.map((p) => `class WebPanel_${kid(p.name)} : WebWorkspacePanel() { override val panelName = "${p.name}" }`).join("\n");

      const kt = [
        `package ${packageName}`,
        ``,
        `import android.annotation.SuppressLint`,
        `import android.app.Activity`,
        `import android.content.BroadcastReceiver`,
        `import android.content.Context`,
        `import android.content.Intent`,
        `import android.os.Bundle`,
        `import android.util.Log`,
        `import android.webkit.WebView`,
        `import androidx.activity.ComponentActivity`,
        ``,
        `/**`,
        ` * Generated by generate_web_workspace — N floating web panels, each its own task/spatial`,
        ` * container. Open: am start -n ${appPkg}/${packageName}.WebPanel_<name>. Drive:`,
        ` * am broadcast -a ${appPkg}.PANEL_CMD -p ${appPkg} --es cmd 'panel:url:<name>=<url>' | 'panel:js:<name>=<expr>' | 'panel:close:<name>'.`,
        ` */`,
        `object WebPanelRegistry {`,
        `    val panels = mutableMapOf<String, WebView>()`,
        `    fun register(name: String, wv: WebView) { panels[name] = wv }`,
        `    fun unregister(name: String) { panels.remove(name) }`,
        `}`,
        ``,
        `object WebWorkspace {`,
        `    private const val TAG = "WebWorkspace"`,
        `    data class Cfg(val url: String?, val html: String?)`,
        `    val configs: Map<String, Cfg> = mapOf(`,
        cfgLines,
        `    )`,
        `    val order: List<String> = listOf(${order})`,
        ``,
        `    fun open(ctx: Context, name: String) {`,
        `        runCatching {`,
        `            val cls = Class.forName("${packageName}.WebPanel_" + name.replace(Regex("[^A-Za-z0-9]"), "_"))`,
        `            ctx.startActivity(Intent(ctx, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))`,
        `        }.onFailure { Log.e(TAG, "open " + name + ": " + it.message) }`,
        `    }`,
        `    fun openAll(ctx: Context) { order.forEach { open(ctx, it) } }`,
        ``,
        `    /** cmd is the FULL command incl. the 'panel:' prefix. Runs on the main thread (manifest receiver). */`,
        `    fun handle(cmd: String) {`,
        `        val body = cmd.removePrefix("panel:")`,
        `        when {`,
        `            body.startsWith("url:") -> body.removePrefix("url:").split("=", limit = 2).let { p ->`,
        `                if (p.size == 2) WebPanelRegistry.panels[p[0]]?.let { wv -> wv.post { wv.loadUrl(p[1]) } }`,
        `            }`,
        `            body.startsWith("js:") -> body.removePrefix("js:").split("=", limit = 2).let { p ->`,
        `                if (p.size == 2) WebPanelRegistry.panels[p[0]]?.let { wv -> wv.post { wv.evaluateJavascript(p[1], null) } }`,
        `            }`,
        `            body.startsWith("close:") -> body.removePrefix("close:").let { n ->`,
        `                WebPanelRegistry.panels[n]?.let { wv -> (wv.context as? Activity)?.finish() }`,
        `            }`,
        `            else -> Log.w(TAG, "unknown panel cmd: " + body)`,
        `        }`,
        `    }`,
        `}`,
        ``,
        `abstract class WebWorkspacePanel : ComponentActivity() {`,
        `    abstract val panelName: String`,
        `    @SuppressLint("SetJavaScriptEnabled")`,
        `    override fun onCreate(savedInstanceState: Bundle?) {`,
        `        super.onCreate(savedInstanceState)`,
        `        val wv = WebView(this)`,
        `        wv.settings.javaScriptEnabled = true`,
        `        WebPanelRegistry.register(panelName, wv)`,
        `        val cfg = WebWorkspace.configs[panelName]`,
        `        when {`,
        `            cfg?.url != null -> wv.loadUrl(cfg.url)`,
        `            cfg?.html != null -> wv.loadDataWithBaseURL(null, cfg.html, "text/html", "utf-8", null)`,
        `        }`,
        `        setContentView(wv)`,
        `    }`,
        `    override fun onDestroy() { WebPanelRegistry.unregister(panelName); super.onDestroy() }`,
        `}`,
        ``,
        subclasses,
        ``,
        `class WebWorkspaceReceiver : BroadcastReceiver() {`,
        `    override fun onReceive(context: Context?, intent: Intent?) {`,
        `        val cmd = intent?.getStringExtra("cmd") ?: return`,
        `        if (cmd.startsWith("panel:open:")) context?.let { WebWorkspace.open(it, cmd.removePrefix("panel:open:")) }`,
        `        else if (cmd.startsWith("panel:")) WebWorkspace.handle(cmd)`,
        `    }`,
        `}`,
        ``,
      ].join("\n");

      const manifestEntries = [
        ...panels.map((p) => `<activity android:name="${packageName}.WebPanel_${kid(p.name)}" android:exported="true" android:taskAffinity="${appPkg}.panel.${kid(p.name)}" android:launchMode="singleTask" />`),
        `<receiver android:name="${packageName}.WebWorkspaceReceiver" android:exported="true"><intent-filter><action android:name="${appPkg}.PANEL_CMD" /></intent-filter></receiver>`,
      ];
      const openCommands = panels.map((p) => `adb shell am start -n ${appPkg}/${packageName}.WebPanel_${kid(p.name)}`);
      const driveExamples = [
        `adb shell am broadcast -a ${appPkg}.PANEL_CMD -p ${appPkg} --es cmd 'panel:js:${panels[0].name}=document.body.style.background="#122"'`,
        `adb shell am broadcast -a ${appPkg}.PANEL_CMD -p ${appPkg} --es cmd 'panel:url:${panels[0].name}=https://example.com'`,
        `adb shell am broadcast -a ${appPkg}.PANEL_CMD -p ${appPkg} --es cmd 'panel:close:${panels[0].name}'`,
      ];
      return ok(JSON.stringify({ kotlin: kt, manifestEntries, openCommands, driveExamples, note: `Write kotlin to content/WebWorkspace.kt; merge all manifestEntries into <application>${panels.some((p) => p.url) ? " (+ INTERNET permission)" : ""}. Open panels with the openCommands; drive them with the PANEL_CMD broadcasts.` }, null, 2));
    },
  );

  server.registerTool(
    "list_spatial_panels",
    {
      description:
        "Return a fail-closed STRUCTURAL inventory of healthy PICO spatial panels. A panel is listed only when a ready/on-screen/WM-visible app container is joined to a ready SystemUI caption window whose captionBarContainerId references that exact container. This proves OS allocation/readiness, NOT rendered pixels, layout, legibility, current capture FOV, focus, or occlusion; visual claims still require LOOKING at a capture.",
      inputSchema: {
        packageFilter: z.string().min(1).optional().describe("Exact application package to include (e.g. 'com.example.app'); never a substring match."),
        expectedActivities: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional fully-qualified activity names to match; returns matchedActivities, missingActivities, and expectationMet."),
        serial: z.string().min(1).optional().describe(`ADB serial (default ${SERIAL}).`),
      },
    },
    async ({ packageFilter, expectedActivities, serial }) => {
      const device = serial ?? SERIAL;
      let stdout: string;
      try {
        const result = await run(ADB, ["-s", device, "shell", "dumpsys", "window", "windows"], {
          timeout: 20_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        stdout = result.stdout;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return fail(`list_spatial_panels failed closed: adb could not read WindowManager on ${device}: ${detail}`);
      }
      const inventory = parseSpatialPanels(stdout, { packageFilter, expectedActivities });
      if (inventory.status === "error") {
        return fail(`list_spatial_panels failed closed on ${device}: ${inventory.error ?? "unparseable WindowManager output"}`);
      }
      return okJson({ ...inventory, serial: device, observedAt: new Date().toISOString() });
    },
  );
}
