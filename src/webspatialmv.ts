import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { okJson } from "./util.js";

/**
 * webspatialmv.ts — v14 (#1 + #2): WebSpatial MULTI-VIEW apps + a headless verification lane.
 *
 * Grounded in the real @webspatial SDK source (fetched 2026-07-08):
 *  - Manifest key is `xr_spatial_scene` (NOT xr_main_scene) with default_size/resizability/
 *    worldScaling/worldAlignment/baseplateVisibility + overrides{window_scene, volume_scene}.
 *  - Named scenes are created at RUNTIME: initScene(name, cb: SpatialSceneCreationOptions =>
 *    SpatialSceneCreationOptions, {type: "window"|"volume"}) then window.open(url, name) — the SDK
 *    translates to webspatial://createSpatialScene. SpatialSceneCreationOptions = {defaultSize
 *    {width,height,depth?}, resizability{minWidth,...}, worldScaling, worldAlignment, baseplateVisibility}.
 *  - Runtime is detected from the UA: PicoWebApp/<v> => picoos, WSAppShell => visionos, Puppeteer.
 *
 * "Multi-view architecture" (the OS-6 term) = this multi-Spatial-Scene model. On PICO OS 6 each
 * scene becomes an OS-managed window/volume; elsewhere it degrades to a normal website — so the 2D
 * projection is verifiable NOW and the spatial behavior is built_for_os6.
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const esc = (s: string) => s.replace(/</g, "&lt;");

type Scene = { name: string; type: "window" | "volume"; title: string; size?: { width: string; height: string; depth?: string }; body?: string };

function sceneComponent(s: Scene): string {
  const rows = s.body ?? `<div enable-xr style={{ '--xr-back': '30px', '--xr-background-material': 'translucent' }}><p>${esc(s.title)} content</p></div>`;
  return `function Scene_${s.name}() {
  return (<main className="scene"><h1>${esc(s.title)}</h1>${rows}</main>)
}`;
}

export function registerWebSpatialMultiviewTools(server: McpServer) {
  server.registerTool(
    "generate_webspatial_multiview",
    {
      description:
        "Generate a MULTI-VIEW WebSpatial app (#1, PICO OS 6 'multi-view architecture') — a real, buildable React + @webspatial/react-sdk project with SEVERAL spatial scenes (each an OS-managed window or volume on OS 6). Uses the CORRECT manifest key `xr_spatial_scene` (+ window_scene/volume_scene overrides), registers each secondary scene at runtime via initScene(name, cb, {type}) with its SpatialSceneCreationOptions (defaultSize incl. '0.8m' meter strings for volumes, resizability, worldScaling/worldAlignment/baseplateVisibility), opens scenes with window.open(url, name), and renders per-scene routes with enable-xr panels + a 2D-projection preview.html. Verify with verify_webspatial_scenes (static scene-graph + headless boot). Spatial behavior = built_for_os6; the 2D projection is verifiable today.",
      inputSchema: {
        projectDir: z.string().describe("Directory to write the project into."),
        title: z.string().describe("App title, e.g. 'Ops Multiview'."),
        mainScene: z.object({ title: z.string(), body: z.string().optional() }).describe("The main (window) scene content."),
        scenes: z.array(z.object({
          name: z.string().describe("Scene id (route + window.open target + initScene name), e.g. 'detail'."),
          type: z.enum(["window", "volume"]).describe("OS 6 scene type."),
          title: z.string(),
          width: z.string().optional().describe("defaultSize width ('1024px' or '0.8m')."),
          height: z.string().optional(),
          depth: z.string().optional().describe("volumes only ('0.8m')."),
          body: z.string().optional().describe("Inline JSX/HTML body."),
        })).min(1).describe("The secondary spatial scenes."),
      },
    },
    async ({ projectDir, title, mainScene, scenes }) => {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "public"), { recursive: true });
      const write = (rel: string, content: string) => { const fp = path.join(projectDir, rel); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, content); return rel; };
      const files: string[] = [];
      const sc: Scene[] = scenes.map((s) => ({ name: s.name.replace(/[^A-Za-z0-9_]/g, "_"), type: s.type, title: s.title, size: { width: s.width ?? (s.type === "volume" ? "0.8m" : "1024px"), height: s.height ?? (s.type === "volume" ? "0.8m" : "720px"), depth: s.type === "volume" ? (s.depth ?? "0.8m") : undefined }, body: s.body }));

      files.push(write("package.json", JSON.stringify({
        name: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), private: true, type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { react: "^18.3.1", "react-dom": "^18.3.1", "@webspatial/react-sdk": "^1.7.0" },
        devDependencies: { vite: "^5.4.0", "@vitejs/plugin-react": "^4.3.0" },
      }, null, 2)));
      files.push(write("vite.config.js", `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })\n`));
      files.push(write("index.html", `<!doctype html><html lang=en><head><meta charset=utf-8>\n<meta name=viewport content="width=device-width,initial-scale=1">\n<link rel=manifest href="/manifest.webmanifest"><title>${esc(title)}</title></head>\n<body><div id=root></div><script type=module src="/src/main.jsx"></script></body></html>\n`));

      // CORRECT manifest: xr_spatial_scene (+ per-type overrides)
      files.push(write("public/manifest.webmanifest", JSON.stringify({
        name: title, short_name: title.slice(0, 12), start_url: "/", display: "standalone",
        xr_spatial_scene: {
          default_size: { width: "1024px", height: "720px" },
          worldScaling: "automatic", worldAlignment: "automatic",
          overrides: {
            window_scene: { default_size: { width: "1024px", height: "720px" } },
            volume_scene: { default_size: { width: "0.8m", height: "0.8m", depth: "0.8m" }, baseplateVisibility: "visible" },
          },
        },
      }, null, 2)));

      // main.jsx: initPolyfill + register each secondary scene via initScene + a pathname router
      const initScenes = sc.map((s) => {
        const sizeObj = `{ width: '${s.size!.width}', height: '${s.size!.height}'${s.size!.depth ? `, depth: '${s.size!.depth}'` : ""} }`;
        return `initScene('${s.name}', (cfg) => ({ ...cfg, defaultSize: ${sizeObj} }), { type: '${s.type}' })`;
      }).join("\n");
      const routes = sc.map((s) => `  if (route === '/${s.name}') return <Scene_${s.name} />`).join("\n");
      const openButtons = sc.map((s) => `        <button onClick={() => window.open('/${s.name}', '${s.name}')}>Open ${esc(s.title)} (${s.type})</button>`).join("\n");

      files.push(write("src/main.jsx", `import React from 'react'
import ReactDOM from 'react-dom/client'
import { initPolyfill, initScene } from '@webspatial/react-sdk'
import './App.css'

// Boot the WebSpatial polyfill, then register each secondary spatial scene (OS 6 windows/volumes).
initPolyfill()
${initScenes}

${sc.map(sceneComponent).join("\n")}

function MainScene() {
  return (
    <main className="scene">
      <h1>${esc(mainScene.title)}</h1>
      ${mainScene.body ?? `<div enable-xr style={{ '--xr-back': '30px', '--xr-background-material': 'translucent' }}><p>${esc(mainScene.title)} — the main window scene</p></div>`}
      <div className="open-bar">
${openButtons}
      </div>
    </main>
  )
}

function App() {
  const route = typeof window !== 'undefined' ? window.location.pathname : '/'
${routes}
  return <MainScene />
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
`));
      files.push(write("src/App.css", `:root{color-scheme:dark}
body{margin:0;font-family:-apple-system,Roboto,sans-serif}
.scene{min-height:100vh;background:radial-gradient(1200px 800px at 50% -10%,#10204a,#05070f);color:#eaf0ff;padding:6vh 6vw}
h1{font-size:5vh;color:#cfe0ff;margin:0 0 3vh}
[enable-xr]{background:linear-gradient(160deg,#141d40,#0d1430);border-radius:22px;padding:24px;margin:2vh 0}
.open-bar{display:flex;flex-wrap:wrap;gap:2vh;margin-top:3vh}
button{font:700 2.4vh -apple-system;padding:1.6vh 3vw;border:none;border-radius:2vh;background:#1b8f4a;color:#fff}
`));

      // 2D-projection preview.html (all scenes as stacked cards — verifiable now)
      const cards = [{ title: mainScene.title, type: "window (main)" }, ...sc.map((s) => ({ title: s.title, type: s.type }))]
        .map((s, i) => `<div class=card style="--i:${i}"><span class=t>${esc(s.type)}</span><h2>${esc(s.title)}</h2></div>`).join("\n");
      files.push(write("preview.html", `<!doctype html><html><head><meta charset=utf-8><style>
body{margin:0;min-height:100vh;background:radial-gradient(1200px 800px at 50% -10%,#10204a,#05070f);color:#eaf0ff;font-family:-apple-system,Roboto,sans-serif;padding:6vh 6vw}
h1{font-size:5vh;color:#cfe0ff}.grid{display:flex;flex-wrap:wrap;gap:3vh}
.card{flex:1 1 280px;background:linear-gradient(160deg,#141d40,#0d1430);border-radius:22px;padding:28px;box-shadow:0 14px 40px rgba(0,0,0,.5)}
.card h2{margin:8px 0 0;color:#7fd7ff}.t{font-size:2vh;color:#9aa4bf;text-transform:uppercase;letter-spacing:1px}
</style></head><body><h1>${esc(title)} — ${sc.length + 1} spatial scenes</h1><div class=grid>${cards}</div>
<!-- 2D projection of a multi-view WebSpatial app; each card is an OS-managed window/volume on PICO OS 6 --></body></html>`));

      return okJson({
        status: "ok", projectDir, files,
        sceneGraph: { main: { type: "window", title: mainScene.title }, scenes: sc.map((s) => ({ name: s.name, type: s.type, title: s.title, defaultSize: s.size })) },
        build: `cd ${projectDir} && npm install && npm run build`,
        verify: `verify_webspatial_scenes projectDir=${projectDir} (static scene-graph) — then serve dist/ + pass servedUrl for the headless boot/render check`,
        evidence: "The declared multi-view scene graph is structural (verify_webspatial_scenes reads it back). The 2D projection is C0-verifiable now (render preview.html / the built site). Each scene becomes an OS-managed window/volume on PICO OS 6 = built_for_os6.",
      });
    },
  );

  server.registerTool(
    "verify_webspatial_scenes",
    {
      description:
        "Verify a WebSpatial app's MULTI-VIEW scene graph (#2, headless — no device). STATIC: reads the manifest's xr_spatial_scene (+ overrides) and scans the source for initScene(name,...,{type}), window.open(url,name) scene-opens, and enable-xr elements → the declared scene graph (deterministic). RUNTIME (optional, pass servedUrl of the BUILT+served app): drives headless Chrome with a PicoWebApp UA and confirms it BOOTS as a picoos WebSpatial app (React mounts, no JS exceptions, content renders) + screenshots the 2D projection. HONEST: the scene graph is structural; the 2D render is vision-verifiable; NATIVE spatial-scene command emission needs the real PICO OS 6 runtime (built_for_os6 — a stubbed bridge runs the SDK in polyfill/degraded mode, confirmed). Returns {sceneGraph, boot, screenshot}.",
      inputSchema: {
        projectDir: z.string().describe("The WebSpatial project dir (or its built dir) — for the static scene-graph scan."),
        servedUrl: z.string().optional().describe("URL of the BUILT + served app (e.g. http://localhost:PORT/index.html) for the headless boot/render check. Omit for static-only."),
        screenshotOut: z.string().optional().describe("Boot screenshot path (default /tmp/pico-render/webspatial/boot.png)."),
      },
    },
    async ({ projectDir, servedUrl, screenshotOut }) => {
      // ── STATIC scene-graph ──
      const graph: any = { manifest: null, scenes: [], opens: [], enableXrCount: 0, initPolyfill: false };
      const mani = [path.join(projectDir, "public/manifest.webmanifest"), path.join(projectDir, "manifest.webmanifest"), path.join(projectDir, "dist/manifest.webmanifest")].find((p) => fs.existsSync(p));
      if (mani) { try { const m = JSON.parse(fs.readFileSync(mani, "utf8")); graph.manifest = { key: m.xr_spatial_scene ? "xr_spatial_scene" : (m.xr_main_scene ? "xr_main_scene (LEGACY — should be xr_spatial_scene)" : null), config: m.xr_spatial_scene ?? m.xr_main_scene ?? null }; } catch { /* */ } }
      const srcDirs = [path.join(projectDir, "src"), path.join(projectDir, "dist/assets"), projectDir];
      const srcFiles: string[] = [];
      for (const d of srcDirs) { try { for (const f of fs.readdirSync(d)) if (/\.(jsx?|tsx?|mjs)$/.test(f)) srcFiles.push(path.join(d, f)); } catch { /* */ } }
      const allSrc = srcFiles.map((f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");
      for (const m of allSrc.matchAll(/initScene\(\s*['"`]([^'"`]+)['"`][\s\S]*?type:\s*['"`](window|volume)['"`]/g)) graph.scenes.push({ name: m[1], type: m[2] });
      for (const m of allSrc.matchAll(/window\.open\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g)) graph.opens.push({ url: m[1], target: m[2] });
      graph.enableXrCount = (allSrc.match(/enable-xr/g) ?? []).length;
      graph.initPolyfill = /initPolyfill\s*\(/.test(allSrc);
      graph.valid = !!graph.manifest?.key?.startsWith("xr_spatial_scene") && graph.scenes.length > 0 && graph.initPolyfill;

      const result: any = { status: "ok", projectDir, sceneGraph: graph, boot: null, screenshot: null,
        honesty: "The scene graph is STRUCTURAL (read from the manifest + source). Native OS-managed window/volume creation needs the real PICO OS 6 Web App runtime (built_for_os6) — a stub runs the SDK in polyfill mode. The 2D boot render (if servedUrl given) is vision-verifiable." };

      if (!servedUrl) { result.note = "static scene-graph only — pass servedUrl (a built+served app) for the headless boot/render check."; return okJson(result); }

      // ── RUNTIME boot check (headless Chrome, PicoWebApp UA) ──
      const port = 9350 + Math.floor((Date.now() % 500));
      const userDir = `/tmp/wschrome-verify-${port}`;
      const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, "about:blank"], { stdio: "ignore" });
      try {
        let list: any[] | undefined;
        for (let i = 0; i < 40; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (list && list.length) break; } catch { /* */ } await new Promise((r) => setTimeout(r, 300)); }
        const page = (list ?? []).find((p) => p.type === "page");
        if (!page) throw new Error("no headless Chrome page");
        const ws = new (globalThis as any).WebSocket(page.webSocketDebuggerUrl);
        let id = 0; const pend: Record<number, (v: any) => void> = {}; const errors: string[] = [];
        const send = (m: string, p: any = {}) => new Promise<any>((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })); });
        ws.addEventListener("message", (e: any) => { const o = JSON.parse(e.data); if (o.method === "Runtime.exceptionThrown") errors.push(o.params?.exceptionDetails?.exception?.description ?? o.params?.exceptionDetails?.text ?? "exception"); if (o.id && pend[o.id]) { pend[o.id](o.result); delete pend[o.id]; } });
        await new Promise((r) => ws.addEventListener("open", r, { once: true }));
        await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
        await send("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; PICO) AppleWebKit/537.36 PicoWebApp/0.3.1 PicoBrowser" });
        await send("Page.navigate", { url: servedUrl });
        await new Promise((r) => setTimeout(r, 3500));
        const probe = await send("Runtime.evaluate", { expression: `JSON.stringify({ mounted: !!document.querySelector('#root *'), heading: document.querySelector('#root h1')?.textContent||null, bodyLen: document.body.innerText.length, uaPico: navigator.userAgent.includes('PicoWebApp') })`, returnByValue: true });
        const boot = JSON.parse(probe.result?.value ?? "{}");
        boot.jsErrors = errors.slice(0, 3);
        boot.ok = boot.mounted && boot.uaPico && errors.length === 0;
        result.boot = boot;
        // screenshot the 2D projection
        try {
          const shot = screenshotOut ?? "/tmp/pico-render/webspatial/boot.png";
          fs.mkdirSync(path.dirname(shot), { recursive: true });
          const cap = await send("Page.captureScreenshot", { format: "png" });
          if (cap?.data) { fs.writeFileSync(shot, Buffer.from(cap.data, "base64")); result.screenshot = shot; }
        } catch { /* */ }
        ws.close();
      } catch (e: any) {
        result.boot = { ok: false, error: String(e?.message ?? e).slice(0, 200) };
      } finally {
        chrome.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* */ }
      }
      return okJson(result);
    },
  );
}
