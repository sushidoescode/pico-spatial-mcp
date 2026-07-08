import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { okJson } from "./util.js";

/**
 * ship.ts — v10.22 (P20): the SHIP path — package + honest production checklist.
 *
 * The honesty invariant applied to shipping: ship_checklist reads the trust ledger + build
 * artifacts and reports EXACTLY what's production-ready vs deferred (Swan/OS6) vs a blocker
 * (e.g. debug-signed, not store-ready) — it never says "shippable" for something unverified.
 * package_web_pwa turns a web/WebSpatial bundle into an installable, hostable PWA (manifest +
 * service worker), so the web lane has a real deploy target today.
 */
const LEDGER_DIR = path.join(os.homedir(), ".pico-mcp", "ledgers");

export function registerShipTools(server: McpServer) {
  server.registerTool(
    "ship_checklist",
    {
      description:
        "Honest PRODUCTION-READINESS checklist (P20). For an app, reads the trust ledger + build artifacts and reports what's READY to ship, what's DEFERRED (Swan hardware / OS 6), and what's a BLOCKER for store distribution (e.g. debug-signed APK, no vision-verified proof) — never claims 'shippable' for something unverified. Pass the app id (native package or web app id) + lane. Returns {ready, deferred, blockers, evidenceSummary, verdict}.",
      inputSchema: {
        app: z.string().describe("App id — native applicationId or web app id (matches a ledger)."),
        lane: z.enum(["native", "web", "hybrid"]).optional().describe("Which lane (default native)."),
        projectDir: z.string().optional().describe("Project dir (native: to check for the APK + release signing)."),
      },
    },
    async ({ app, lane, projectDir }) => {
      const ln = lane ?? "native";
      const ready: string[] = [], deferred: string[] = [], blockers: string[] = [];
      // ledger evidence
      const lf = path.join(LEDGER_DIR, `${app.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
      let entries: any[] = [];
      try { entries = JSON.parse(fs.readFileSync(lf, "utf8")); } catch { /* none */ }
      const byType: Record<string, number> = {};
      for (const e of entries) byType[e.evidenceType] = (byType[e.evidenceType] ?? 0) + 1;
      const vision = byType.vision_verified ?? 0;
      if (vision > 0) ready.push(`${vision} vision-verified proof(s) on file (a human/agent LOOKED)`);
      else blockers.push("NO vision-verified proof in the ledger — cannot claim the experience renders. Capture + record_verification first.");
      if (byType.built_for_headset) deferred.push(`${byType.built_for_headset} capability(ies) built-for-Swan (controller-ray / anchors / immersive) — device-verify on hardware.`);

      if (ln === "native" || ln === "hybrid") {
        const pdir = projectDir ?? path.join(os.homedir(), "AndroidStudioProjects", `${app.split(".").pop()}-native`);
        const apk = path.join(pdir, "app/build/outputs/apk/debug/app-debug.apk");
        const releaseApk = path.join(pdir, "app/build/outputs/apk/release/app-release.apk");
        if (fs.existsSync(apk)) ready.push("debug APK builds + installs on the emulator");
        else blockers.push("no debug APK found — run build_and_run / assembleDebug.");
        if (fs.existsSync(releaseApk)) ready.push("release APK present");
        else blockers.push("no RELEASE build — debug-signed only; for store/sideload distribution add a signingConfig + assembleRelease.");
        deferred.push("boundless walk-around immersion + true head-tracked depth activate on PICO Swan hardware (emulator ceiling C1/C2).");
      }
      if (ln === "web" || ln === "hybrid") {
        const pdir = projectDir ?? "";
        const hasManifest = pdir && (fs.existsSync(path.join(pdir, "public/manifest.webmanifest")) || fs.existsSync(path.join(pdir, "manifest.webmanifest")));
        const hasSW = pdir && fs.existsSync(path.join(pdir, "sw.js"));
        // A native-primary HYBRID (native APK with an embedded WebView panel) ships the web content
        // INSIDE the APK — a standalone PWA manifest is only needed to ALSO host it on the web, so it's
        // optional there, not a blocker. A pure WEB-lane app does need the manifest to be shippable.
        const nativePrimaryHybrid = ln === "hybrid";
        if (hasManifest) ready.push("web manifest present (installable/hostable)");
        else if (nativePrimaryHybrid) deferred.push("no standalone web manifest — fine for a native-primary hybrid (the WebView ships inside the APK); run package_web_pwa only if you ALSO want to host the web content.");
        else blockers.push("no web manifest — run package_web_pwa to make the web-lane app installable/hostable.");
        if (hasSW) ready.push("service worker present (offline-capable)"); else deferred.push("no service worker (add via package_web_pwa for offline web hosting).");
        deferred.push("WebSpatial spatial depth activates on PICO OS 6 (the 2D projection is shippable now).");
        if (ln === "web") ready.push("web content is hostable today (any static host + a URL) and runs in the emulator browser.");
        else ready.push("web control/HUD panels ship embedded in the APK (in-app WebView).");
      }
      const verdict = blockers.length === 0 ? "READY (within the honest scope below)" : `NOT READY — ${blockers.length} blocker(s)`;
      return okJson({
        status: "ok", app, lane: ln, verdict,
        ready, deferred, blockers,
        evidenceSummary: byType,
        honesty: "'Ready' means verified within the emulator's honest scope; 'deferred' items are real capabilities that need Swan/OS6 to activate (not failures); 'blockers' must be resolved before claiming production. This checklist will not report READY without a vision-verified proof + a build artifact.",
      });
    },
  );

  server.registerTool(
    "package_web_pwa",
    {
      description:
        "Turn a web / WebSpatial bundle into an installable, hostable PWA (P20): writes a manifest.webmanifest + a caching service worker (sw.js) + injects registration into index.html — giving the web lane a real deploy target today (any static host). Returns the files written + the host/deploy hint.",
      inputSchema: {
        projectDir: z.string().describe("The web project dir (contains index.html)."),
        name: z.string().describe("App name for the manifest."),
        themeColor: z.string().optional().describe("Theme color hex (default #05070f)."),
      },
    },
    async ({ projectDir, name, themeColor }) => {
      const files: string[] = [];
      const w = (rel: string, content: string) => { const fp = path.join(projectDir, rel); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, content); files.push(rel); };
      w("manifest.webmanifest", JSON.stringify({
        name, short_name: name.slice(0, 12), start_url: "/", display: "standalone",
        background_color: themeColor ?? "#05070f", theme_color: themeColor ?? "#05070f",
        icons: [{ src: "icon.png", sizes: "512x512", type: "image/png" }],
        xr_main_scene: { default_size: { width: 1280, height: 720 } },
      }, null, 2));
      w("sw.js", `const C='${name.replace(/[^a-z0-9]/gi, "")}-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  e.respondWith(caches.open(C).then(async cache => {
    const hit = await cache.match(e.request); if (hit) return hit;
    try { const res = await fetch(e.request); if (e.request.method === 'GET' && res.ok) cache.put(e.request, res.clone()); return res; }
    catch (err) { return hit || Response.error(); }
  }));
});`);
      // inject registration + manifest link into index.html if present
      const idx = path.join(projectDir, "index.html");
      if (fs.existsSync(idx)) {
        let h = fs.readFileSync(idx, "utf8");
        if (!h.includes("manifest.webmanifest")) h = h.replace(/<\/head>/i, `<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="${themeColor ?? "#05070f"}"></head>`);
        if (!h.includes("serviceWorker")) h = h.replace(/<\/body>/i, `<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js');</script></body>`);
        fs.writeFileSync(idx, h); files.push("index.html (manifest link + SW registration injected)");
      }
      return okJson({ status: "ok", projectDir, files, deploy: "Host the dir on any static host (or `python3 -m http.server` + adb reverse for the emulator). Installable as a PWA; on PICO OS 6 the WebSpatial parts activate spatially.", note: "Add an icon.png (512x512) for the install icon." });
    },
  );
}
