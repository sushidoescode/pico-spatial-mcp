import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { okJson } from "./util.js";
import { isPassingDeviceEvidence, readLedger } from "./ledger.js";
import { validateCapture } from "./evidence.js";

/**
 * ship.ts — v10.22 (P20): the SHIP path — package + honest production checklist.
 *
 * The honesty invariant applied to shipping: ship_checklist reads the trust ledger + build
 * artifacts and reports EXACTLY what's production-ready vs deferred (Swan/OS6) vs a blocker
 * (e.g. debug-signed, not store-ready) — it never says "shippable" for something unverified.
 * package_web_pwa validates an existing HTML entrypoint + icon before scaffolding manifest and
 * service-worker files. That structural packaging step is not browser/deploy/readiness evidence.
 */
export function registerShipTools(server: McpServer) {
  server.registerTool(
    "ship_checklist",
    {
      description:
        "Honest PRODUCTION-READINESS checklist (P20). Reads the effective ledger and reports build paths without treating their existence as build/install/signing proof. An intact device_verified PASS row whose looked-at bytes matched a same-serial live screencap satisfies the positive visual-proof gate just as vision_verified does; device FAIL rows remain explicit blockers, and legacy rows without live identity/capture lineage are downgraded on read. Native READY remains blocked until a future digest-bound receipt ties current APK bytes to install/session evidence and the looked-at frame.",
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
      let entries: any[] = [];
      let ledgerError: string | null = null;
      try { entries = readLedger(app).effectiveEntries; } catch (error: any) { ledgerError = error?.message ?? String(error); }
      const byType: Record<string, number> = {};
      for (const e of entries) byType[e.evidenceType] = (byType[e.evidenceType] ?? 0) + 1;
      const vision = byType.vision_verified ?? 0;
      const devicePass = entries.filter(isPassingDeviceEvidence).length;
      const deviceFail = entries.filter((entry) => entry.evidenceType === "device_verified" && entry.deviceOutcome === "fail").length;
      if (devicePass > 0) ready.push(`${devicePass} positive device-verified proof(s) on file (a human/agent LOOKED; hardware lineage validated; outcome=pass)`);
      if (deviceFail > 0) blockers.push(`${deviceFail} device-verified failed outcome(s) on file — these are looked-at negative findings, not positive readiness proof.`);
      if (vision > 0) ready.push(`${vision} vision-verified proof(s) on file (a human/agent LOOKED)`);
      if (vision + devicePass === 0) blockers.push("NO positive vision-verified or device-verified PASS proof in the ledger — cannot claim the experience renders. Capture + LOOK + record_verification first.");
      const lineageDowngrades = entries.filter((entry) => entry.claimedEvidenceType === "device_verified" && entry.deviceLineage?.status !== "validated").length;
      if (lineageDowngrades) deferred.push(`${lineageDowngrades} historical device_verified row(s) were downgraded because their hardware lineage is missing or invalid; their intact looked-at frame counts only as vision_verified.`);
      if (byType["provenance-broken"]) blockers.push(`${byType["provenance-broken"]} visual claim(s) have broken provenance — their linked bytes are missing or do not match the recorded hash.`);
      if (ledgerError) blockers.push(`trust ledger unreadable — no ledger evidence counted: ${ledgerError}`);
      if (byType.built_for_headset) deferred.push(`${byType.built_for_headset} capability(ies) built-for-Swan (controller-ray / anchors / immersive) — device-verify on hardware.`);

      if (ln === "native" || ln === "hybrid") {
        const pdir = projectDir ?? path.join(os.homedir(), "AndroidStudioProjects", `${app.split(".").pop()}-native`);
        const apk = path.join(pdir, "app/build/outputs/apk/debug/app-debug.apk");
        const releaseApk = path.join(pdir, "app/build/outputs/apk/release/app-release.apk");
        if (fs.existsSync(apk)) deferred.push(`debug APK path exists (${apk}); path existence does not prove valid APK bytes, build success, installation, or that this ledger's looked-at frame came from this build.`);
        else blockers.push("no debug APK path found — run build_and_run / assembleDebug.");
        if (fs.existsSync(releaseApk)) deferred.push(`release APK path exists (${releaseApk}); signing and installability are unverified.`);
        else blockers.push("no RELEASE APK path — for store/sideload distribution add a signingConfig + assembleRelease.");
        // No current receipt format binds an APK digest to both a verified install/session and the
        // looked-at capture. Failing closed here prevents an arbitrary or replaced file named .apk
        // from inheriting historical visual proof and producing READY.
        blockers.push("no verified build receipt binds the current APK bytes to install/session evidence and the looked-at frame; ship_checklist cannot establish native readiness from file existence.");
        deferred.push("boundless walk-around immersion + true head-tracked depth activate on PICO Swan hardware (emulator ceiling C1/C2).");
      }
      if (ln === "web" || ln === "hybrid") {
        const pdir = projectDir ?? "";
        const hasManifest = pdir && (fs.existsSync(path.join(pdir, "public/manifest.webmanifest")) || fs.existsSync(path.join(pdir, "manifest.webmanifest")));
        const hasSW = pdir && fs.existsSync(path.join(pdir, "sw.js"));
        const hasEntrypoint = pdir && (fs.existsSync(path.join(pdir, "public/index.html")) || fs.existsSync(path.join(pdir, "index.html")));
        // A native-primary HYBRID (native APK with an embedded WebView panel) ships the web content
        // INSIDE the APK — a standalone PWA manifest is only needed to ALSO host it on the web, so it's
        // optional there, not a blocker. A pure WEB-lane app does need the manifest to be shippable.
        const nativePrimaryHybrid = ln === "hybrid";
        if (hasManifest) deferred.push("web manifest path exists; path existence does not prove a valid deploy bundle or live hosting.");
        else if (nativePrimaryHybrid) deferred.push("no standalone web manifest — fine for a native-primary hybrid (the WebView ships inside the APK); run package_web_pwa only if you ALSO want to host the web content.");
        else blockers.push("no web manifest — run package_web_pwa to scaffold validated PWA metadata; a browser/deploy receipt is still required before any installable/hostable claim.");
        if (hasSW) deferred.push("service worker path exists; offline behavior has not been exercised."); else deferred.push("no service worker (add via package_web_pwa for offline web hosting).");
        if (hasEntrypoint) deferred.push("web entrypoint path exists; current assets have not been digest-bound to a build/deploy receipt.");
        else blockers.push("no web index.html entrypoint found.");
        blockers.push("no digest-bound web build/deploy receipt ties the current entrypoint and assets to a successful host/browser session and the looked-at frame.");
        deferred.push("WebSpatial spatial depth depends on PICO OS 6; this checklist does not establish that the current 2D projection is deployable or shippable.");
        if (ln === "web") deferred.push("static hosting is a deployment option after the web receipt gate is satisfied; it has not been established by this checklist.");
        else deferred.push("web control/HUD panels are intended to ship inside the APK, but inherit the native digest/install receipt blocker.");
      }
      const verdict = blockers.length === 0 ? "READY (within the honest scope below)" : `NOT READY — ${blockers.length} blocker(s)`;
      return okJson({
        status: "ok", app, lane: ln, verdict,
        ready, deferred, blockers,
        evidenceSummary: { ...byType, deviceVerifiedPass: devicePass, deviceVerifiedFail: deviceFail },
        honesty: "'Ready' means verified within the evidence's honest scope; 'deferred' items need Swan/OS6 or additional proof; 'blockers' must be resolved before claiming production. File existence is not build/install/deploy evidence and cannot bind historical visual proof to current native or web bytes; a future digest-bound verification receipt is required.",
      });
    },
  );

  server.registerTool(
    "package_web_pwa",
    {
      description:
        "Validate an existing web entrypoint plus 512×512 PNG icon, then scaffold PWA metadata: writes manifest.webmanifest + sw.js and injects their links into index.html. This is a structural packaging result, not evidence that a browser installed it, a host served it, offline caching worked, or the current bytes are production-ready.",
      inputSchema: {
        projectDir: z.string().describe("The web project dir (contains index.html)."),
        name: z.string().min(1).max(120).describe("App name for the manifest."),
        themeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Six-digit theme color hex (default #05070f)."),
      },
    },
    async ({ projectDir, name, themeColor }) => {
      let projectStat: fs.Stats;
      try { projectStat = fs.statSync(projectDir); }
      catch (error: any) { return okJson({ status: "rejected", projectDir, reason: `projectDir is not readable: ${error?.message ?? String(error)}` }); }
      if (!projectStat.isDirectory()) return okJson({ status: "rejected", projectDir, reason: "projectDir must be an existing directory" });

      // Validate every required input before the first write so a rejected call cannot leave a
      // manifest/service-worker half-package behind.
      const idx = path.join(projectDir, "index.html");
      let indexHtml: string;
      try {
        const indexStat = fs.statSync(idx);
        if (!indexStat.isFile() || indexStat.size === 0 || indexStat.size > 4 * 1024 * 1024) {
          return okJson({ status: "rejected", projectDir, reason: "index.html must be a non-empty regular file no larger than 4 MiB; nothing was written" });
        }
        indexHtml = fs.readFileSync(idx, "utf8");
      } catch {
        return okJson({ status: "rejected", projectDir, reason: "index.html is required before PWA metadata can be scaffolded; nothing was written" });
      }
      if (!/<html\b/i.test(indexHtml) || !/<\/head>/i.test(indexHtml) || !/<\/body>/i.test(indexHtml)) {
        return okJson({ status: "rejected", projectDir, reason: "index.html must contain html, closing head, and closing body elements so injection is explicit; nothing was written" });
      }
      const iconPath = path.join(projectDir, "icon.png");
      const icon = validateCapture(iconPath);
      if (!icon.ok || icon.format !== "png" || icon.width !== 512 || icon.height !== 512) {
        return okJson({ status: "rejected", projectDir, reason: `icon.png must be a decodable 512×512 PNG before it is declared in the manifest; nothing was written (${icon.reason ?? `${icon.width ?? "?"}×${icon.height ?? "?"} ${icon.format ?? "unknown format"}`})` });
      }

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
      let h = indexHtml;
      if (!h.includes("manifest.webmanifest")) h = h.replace(/<\/head>/i, `<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="${themeColor ?? "#05070f"}"></head>`);
      if (!h.includes("serviceWorker")) h = h.replace(/<\/body>/i, `<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js');</script></body>`);
      fs.writeFileSync(idx, h); files.push("index.html (manifest link + SW registration injected)");
      return okJson({
        status: "scaffolded",
        projectDir,
        files,
        validatedInputs: { indexHtml: "non-empty HTML injection points present", icon: { path: iconPath, sha256: icon.sha256, width: icon.width, height: icon.height, format: icon.format } },
        next: "Serve this exact directory, exercise install/offline behavior in a browser, and retain a digest-bound deploy/session receipt before claiming it installable, hostable, offline-capable, or production-ready.",
        honesty: "PWA files were scaffolded around validated local inputs. This call did not run a browser or host, does not prove deployment, and is not production-ready evidence.",
      });
    },
  );
}
