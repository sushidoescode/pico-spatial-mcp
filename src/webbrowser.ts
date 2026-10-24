import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";
import { adbExecutable } from "./adb.js";

const run = promisify(execFile);
/** THE shared adb lookup (src/adb.ts): explicit $PICO_ADB -> PATH -> the SELECTED toolchain's
 *  bundled platform-tools. Resolved PER CALL (identity-keyed, so a hit costs a stat) rather
 *  than frozen into a module constant at import time. */
const ADB = () => adbExecutable();
const SERIAL = "emulator-5554";
const BROWSER = "com.picoxr.browser";

/**
 * webbrowser.ts — v10.10: the WEB / WebXR lane.
 *
 * The PICO emulator ships a full Chromium 138 (com.picoxr.browser "SpaceBrowser") with WebXR
 * (immersive-vr/ar/inline all report SUPPORTED), WebGL2 + WebGPU — and it is FULLY CDP-drivable
 * headlessly (adb forward -> @weblayer_devtools_remote_<pid> -> Runtime.evaluate). This is a whole
 * content path beside the Kotlin/Spatial-SDK path, with NO APK build cycle: load any URL/three.js/
 * WebXR page from the host (adb reverse + a local server), evaluate JS, read results.
 * HONESTY: navigator.xr session SUPPORT is real and reproduced; an IMMERSIVE session's frames do
 * not visually composite to the emulator viewport (Swan-hardware — the long-standing OpenXR-layer
 * finding, refined: session+pose layer works, visual compositing does not). Inline/2D web content
 * (canvas, DOM, WebGL) DOES render as a floating browser panel and is capture-verifiable now.
 */

async function browserPid(): Promise<string | null> {
  const r = await run(ADB(), ["-s", SERIAL, "shell", "pidof", BROWSER], { timeout: 10_000 }).catch(() => null);
  const pid = r?.stdout.trim();
  return pid || null;
}

// minimal CDP: forward the devtools socket, find the target page, eval an expression, return the value.
async function cdpEval(expr: string, opts: { urlIncludes?: string; port?: number } = {}): Promise<any> {
  const pid = await browserPid();
  if (!pid) throw new Error("SpaceBrowser is not running — open a page first (drive_browser url=...).");
  const port = opts.port ?? 9222;
  await run(ADB(), ["-s", SERIAL, "forward", `tcp:${port}`, `localabstract:weblayer_devtools_remote_${pid}`], { timeout: 10_000 });
  const pages = await (await fetch(`http://localhost:${port}/json`)).json();
  const page = (pages as any[]).find((p) => p.type === "page" && (!opts.urlIncludes || (p.url ?? "").includes(opts.urlIncludes)))
    ?? (pages as any[]).find((p) => p.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("no debuggable page open in SpaceBrowser");
  const ws = new (globalThis as any).WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending: Record<number, (v: any) => void> = {};
  const sendCdp = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
  ws.addEventListener("message", (e: any) => { const o = JSON.parse(e.data); if (o.id && pending[o.id]) { pending[o.id](o.result); delete pending[o.id]; } });
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  try {
    await sendCdp("Runtime.enable");
    const r = await sendCdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r?.exceptionDetails) throw new Error("JS error: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r?.result?.value;
  } finally {
    ws.close();
  }
}

export function registerWebBrowserTools(server: McpServer) {
  server.registerTool(
    "drive_browser",
    {
      description:
        "Drive the PICO emulator's on-image Chromium 138 (SpaceBrowser) HEADLESSLY — a whole web content lane with NO APK build. Opens a URL as a floating browser panel and/or evaluates JavaScript in the live page via CDP (adb forward -> devtools socket -> Runtime.evaluate, userGesture so WebXR user-activation is satisfied). Use `url` to load a page (serve local files with a host http.server + adb reverse, then http://localhost:<port>/...), and `evalJs` to read/drive it (returns the value). The panel spawns at the dock — capture_frame + a camera sweep to SEE it; but evalJs reads state deterministically. WebGL2 + WebGPU + WebXR are available (see webxr_probe).",
      inputSchema: {
        url: z.string().optional().describe("URL to open in SpaceBrowser (e.g. http://localhost:8899/app.html after `adb reverse tcp:8899 tcp:8899` + a host server)."),
        evalJs: z.string().optional().describe("A JS expression to evaluate in the live page (async allowed; returns by value). E.g. 'document.title' or '(async()=>navigator.xr?await navigator.xr.isSessionSupported(\"immersive-vr\"):false)()'."),
        urlIncludes: z.string().optional().describe("When multiple tabs are open, target the page whose URL contains this substring."),
        settleSec: z.number().optional().describe("Seconds to wait after opening the URL before evaluating (default 6)."),
      },
    },
    async ({ url, evalJs, urlIncludes, settleSec }) => {
      const steps: string[] = [];
      if (url) {
        await run(ADB(), ["-s", SERIAL, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, BROWSER], { timeout: 30_000 });
        steps.push(`opened ${url}`);
        await new Promise((r) => setTimeout(r, (settleSec ?? 6) * 1000));
      }
      let value: any;
      if (evalJs) {
        value = await cdpEval(evalJs, { urlIncludes: urlIncludes ?? (url ? url.split("/").pop() : undefined) });
        steps.push("evaluated JS");
      }
      return okJson({ status: "ok", steps, value, note: "The browser panel docks off the forward view — capture_frame + emulator_look to see it; evalJs is the deterministic readout." });
    },
  );

  server.registerTool(
    "webxr_probe",
    {
      description:
        "Probe the emulator browser's WebXR + web-graphics capabilities (reproduced fact, v10.10): drives the live SpaceBrowser page via CDP and reports navigator.xr session support (immersive-vr/ar/inline), WebGL2, WebGPU, and the UA. A page must be open (pass url to open one). HONESTY: session SUPPORT is real (isSessionSupported returns true) and an immersive session RUNS headlessly delivering stereo poses — BUT its frames do NOT visually composite to the emulator viewport (Swan-hardware; refined OpenXR-layer finding). Inline/2D web content DOES render as a panel and is capture-verifiable now. Returns the capability matrix; records nothing (call record_verification if you also LOOK).",
      inputSchema: {
        url: z.string().optional().describe("Optional URL to open first (default: probe whatever page is open; if none, open about:blank won't have navigator.xr context — open a real http(s) page)."),
      },
    },
    async ({ url }) => {
      if (url) {
        await run(ADB(), ["-s", SERIAL, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, BROWSER], { timeout: 30_000 });
        await new Promise((r) => setTimeout(r, 6000));
      }
      const probe = `(async () => {
        const r = { ua: navigator.userAgent, hasXR: !!navigator.xr };
        if (navigator.xr) {
          r.immersiveVR = await navigator.xr.isSessionSupported('immersive-vr').catch(()=>false);
          r.immersiveAR = await navigator.xr.isSessionSupported('immersive-ar').catch(()=>false);
          r.inline = await navigator.xr.isSessionSupported('inline').catch(()=>false);
        }
        r.webgl2 = !!document.createElement('canvas').getContext('webgl2');
        r.webgpu = 'gpu' in navigator;
        return JSON.stringify(r);
      })()`;
      let caps: any;
      try { caps = JSON.parse(await cdpEval(probe, { urlIncludes: url ? url.split("/").pop() : undefined })); }
      catch (e: any) { return okJson({ status: "error", error: String(e?.message ?? e) }); }
      return okJson({
        status: "ok",
        capabilities: caps,
        honesty: {
          sessionLayer: "navigator.xr session support is REAL (immersive-vr/ar report supported); an immersive session runs headlessly + delivers stereo poses.",
          visualLayer: "an immersive session's FRAMES do NOT composite to the emulator viewport (Swan-hardware). Inline/2D web content (DOM/canvas/WebGL) DOES render as a floating browser panel — capture-verifiable now.",
          evidence: "isSessionSupported values are DATA (structural). To claim a page RENDERS, capture_frame the browser panel and LOOK, then record_verification.",
        },
      });
    },
  );
}
