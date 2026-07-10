import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { okJson } from "./util.js";

/**
 * commandcenter.ts — the AGENTIC COMMAND CENTER (ranked task #4; the PICO hackathon's category (b)).
 * Learned from the Jul-9 workshop's OpenClaw kit: a chat scene where an agent replies with typed
 * resources, and a DISPATCHER opens the right OS-6 window/volume per file type — GLB → a 3D volume,
 * video → a window, image → a window, url → a web panel. Human-in-the-loop: you talk, the agent hands
 * back a resource, it opens as its own spatial window. Built on our WebSpatial multi-scene lane
 * (initScene + window.open, correct xr_spatial_scene manifest). Ships with a MOCK agent so it demos
 * with zero backend; point `agentEndpoint` at a real agent (OpenClaw/your MCP) to go live.
 */

const esc = (s: string) => s.replace(/</g, "&lt;").replace(/`/g, "\\`").replace(/\$/g, "\\$");

export function registerCommandCenterTools(server: McpServer) {
  server.registerTool(
    "generate_command_center",
    {
      description:
        "Scaffold an AGENTIC COMMAND CENTER — a real WebSpatial (React + @webspatial/react-sdk) app where a chat panel talks to an agent and a DISPATCHER opens the right OS-6 window/volume per returned resource type: .glb/.gltf → a 3D VOLUME (model-viewer), video → a window, image → a window, any url → a web panel. This is the PICO 'agentic command center' pattern (workshop OpenClaw kit) on our WebSpatial multi-scene lane (initScene + window.open, correct xr_spatial_scene manifest). Ships a MOCK agent (keyword→resource, so it demos with no backend); set agentEndpoint to a real agent (returns {reply, resources:[{type,url,title}]}) to go live. Build + serve, then `adb reverse tcp:5173`, open in the emulator browser, 'open as app'. Returns {projectDir, files, run}.",
      inputSchema: {
        projectDir: z.string().describe("Absolute path to scaffold the app into."),
        title: z.string().optional().describe("App title (default 'Command Center')."),
        agentEndpoint: z.string().optional().describe("POST endpoint that takes {message} and returns {reply, resources:[{type:'model'|'video'|'image'|'web', url, title}]}. Omit to use the built-in MOCK agent (keyword→resource)."),
      },
    },
    async ({ projectDir, title, agentEndpoint }) => {
      const appTitle = title ?? "Command Center";
      const files: string[] = [];
      const write = (rel: string, content: string) => { const fp = path.join(projectDir, rel); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, content); files.push(rel); };

      write("package.json", JSON.stringify({
        name: appTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-"), private: true, type: "module",
        scripts: { dev: "vite --host --port 5173", build: "vite build", preview: "vite preview --host --port 5173" },
        dependencies: { react: "^18.3.1", "react-dom": "^18.3.1", "@webspatial/react-sdk": "^0.1.6", "@google/model-viewer": "^3.5.0" },
        devDependencies: { "@vitejs/plugin-react": "^4.3.1", vite: "^5.4.0", "@webspatial/vite-plugin": "^0.1.6" },
      }, null, 2) + "\n");

      write("vite.config.js", `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()], server: { host: true, port: 5173 } })\n`);

      write("index.html", `<!doctype html><html lang=en><head><meta charset=utf-8>\n<meta name=viewport content="width=device-width,initial-scale=1">\n<link rel=manifest href="/manifest.webmanifest"><title>${esc(appTitle)}</title></head>\n<body><div id=root></div><script type=module src="/src/main.jsx"></script></body></html>\n`);

      // Correct OS-6 manifest: the spatial-scene descriptor with window + volume overrides.
      write("public/manifest.webmanifest", JSON.stringify({
        name: appTitle, short_name: appTitle, display: "standalone", start_url: "/",
        xr_spatial_scene: {
          default_size: { width: "1024px", height: "720px" },
          resizability: "resizable",
          worldScaling: "dynamic", worldAlignment: "gravityAligned", baseplateVisibility: "hidden",
          overrides: {
            window_scene: { default_size: { width: "1024px", height: "720px" } },
            volume_scene: { default_size: { width: "0.9m", height: "0.9m", depth: "0.9m" }, baseplateVisibility: "visible" },
          },
        },
      }, null, 2) + "\n");

      // The MOCK agent — keyword → typed resource (the OpenClaw demo shape). Real agent: swap for a fetch.
      write("src/agent.js", `// Mock agent: maps a message to typed resources. Replace with a POST to your agent
// (OpenClaw / your MCP) that returns { reply, resources: [{type,url,title}] }.
const RULES = [
  { re: /hungry|food|eat|avocado/i, reply: "Here's something to eat.", resources: [{ type: 'model', url: 'https://modelviewer.dev/shared-assets/models/Avocado.glb', title: 'Avocado' }] },
  { re: /movie|watch|video|film/i, reply: 'Opening a movie for you.', resources: [{ type: 'video', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', title: 'Feature' }] },
  { re: /music|song|listen/i, reply: 'Here is a track.', resources: [{ type: 'web', url: 'https://example.com', title: 'Now Playing' }] },
  { re: /learn|xr|docs|develop/i, reply: 'Learning resources:', resources: [{ type: 'web', url: 'https://docs.worldlabs.ai', title: 'XR Docs' }] },
  { re: /helmet|model|3d|object/i, reply: 'A 3D model:', resources: [{ type: 'model', url: 'https://modelviewer.dev/shared-assets/models/Astronaut.glb', title: 'Astronaut' }] },
];
export async function ask(message, endpoint) {
  if (endpoint) {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
    return await r.json();
  }
  const hit = RULES.find(r => r.re.test(message));
  return hit ? { reply: hit.reply, resources: hit.resources } : { reply: "Try: 'I'm hungry', 'play a movie', 'show me a 3D model', 'where can I learn XR'.", resources: [] };
}
`);

      // The typed scenes: a 3D VOLUME for models, WINDOWs for video/image, a PANEL for web.
      write("src/scenes.jsx", `import '@google/model-viewer'
function useParam(k){ return new URLSearchParams(location.search).get(k) || '' }
export function ModelVolume(){ const url=useParam('url'), title=useParam('title')
  return <div enable-xr style={{'--xr-background-material':'translucent', width:'100%', height:'100%'}}>
    <model-viewer src={url} camera-controls auto-rotate style={{width:'100%',height:'100%'}} />
    <div style={{position:'absolute',bottom:8,left:8,color:'#fff',font:'13px system-ui'}}>{title}</div>
  </div> }
export function VideoWindow(){ const url=useParam('url'), title=useParam('title')
  return <div enable-xr style={{background:'#000',width:'100%',height:'100%'}}>
    <video src={url} controls autoPlay style={{width:'100%',height:'100%'}} />
    <div style={{position:'absolute',top:8,left:8,color:'#fff',font:'13px system-ui'}}>{title}</div>
  </div> }
export function ImageWindow(){ const url=useParam('url')
  return <div enable-xr style={{background:'#111',width:'100%',height:'100%',display:'grid',placeItems:'center'}}>
    <img src={url} alt="" style={{maxWidth:'100%',maxHeight:'100%'}} />
  </div> }
export function WebPanel(){ const url=useParam('url')
  return <div enable-xr style={{width:'100%',height:'100%'}}><iframe src={url} title="web" style={{width:'100%',height:'100%',border:0}} /></div> }
`);

      // main.jsx: register the four typed spatial scenes, route by pathname, mount the chat command center.
      write("src/main.jsx", `import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initPolyfill, initScene } from '@webspatial/react-sdk'
import { ask } from './agent.js'
import { ModelVolume, VideoWindow, ImageWindow, WebPanel } from './scenes.jsx'

initPolyfill()
// OS-6 scene registry: models open as a VOLUME, everything else as a WINDOW.
initScene('model', (cfg) => ({ ...cfg, defaultSize: { width: '0.9m', height: '0.9m', depth: '0.9m' } }), { type: 'volume' })
initScene('video', (cfg) => ({ ...cfg, defaultSize: { width: '1280px', height: '720px' } }), { type: 'window' })
initScene('image', (cfg) => ({ ...cfg, defaultSize: { width: '900px', height: '900px' } }), { type: 'window' })
initScene('web',   (cfg) => ({ ...cfg, defaultSize: { width: '1024px', height: '720px' } }), { type: 'window' })

const ENDPOINT = ${agentEndpoint ? `'${agentEndpoint}'` : "null"}
// The DISPATCHER: open a resource as its typed spatial scene.
function dispatch(res){
  const q = '?url=' + encodeURIComponent(res.url) + '&title=' + encodeURIComponent(res.title || '')
  window.open('/' + res.type + q, res.type)  // scene name === type; window.open triggers the OS-6 window/volume
}

function CommandCenter(){
  const [log, setLog] = useState([{ who:'agent', text:"I'm your command center. Ask for food, a movie, a 3D model, or XR docs." }])
  const [input, setInput] = useState('')
  const send = async () => {
    const msg = input.trim(); if(!msg) return
    setLog(l => [...l, { who:'you', text: msg }]); setInput('')
    const { reply, resources } = await ask(msg, ENDPOINT)
    setLog(l => [...l, { who:'agent', text: reply, resources }])
  }
  return <div enable-xr style={{ '--xr-back':'40px', '--xr-background-material':'thick', display:'flex', flexDirection:'column', height:'100%', font:'15px system-ui', color:'#eef' }}>
    <div style={{ padding:'14px 18px', borderBottom:'1px solid #2b3350', fontWeight:700, letterSpacing:'.02em' }}>${esc(appTitle)}</div>
    <div style={{ flex:1, overflowY:'auto', padding:'14px 18px', display:'flex', flexDirection:'column', gap:10 }}>
      {log.map((m,i) => <div key={i} style={{ alignSelf: m.who==='you'?'flex-end':'flex-start', maxWidth:'80%' }}>
        <div style={{ background: m.who==='you'?'#3a4a7a':'#1b2338', padding:'8px 12px', borderRadius:12 }}>{m.text}</div>
        {(m.resources||[]).map((r,j) => <button key={j} onClick={()=>dispatch(r)} style={{ marginTop:6, display:'block', background:'#12304a', color:'#8fe3ff', border:'1px solid #1e4a63', borderRadius:8, padding:'8px 12px', cursor:'pointer' }}>Open {r.title} ({r.type}) →</button>)}
      </div>)}
    </div>
    <div style={{ display:'flex', gap:8, padding:14, borderTop:'1px solid #2b3350' }}>
      <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()} placeholder="Ask the command center…" style={{ flex:1, padding:'10px 12px', borderRadius:8, border:'1px solid #2b3350', background:'#0d1220', color:'#eef' }} />
      <button onClick={send} style={{ padding:'10px 18px', borderRadius:8, border:0, background:'#3a4a7a', color:'#fff', cursor:'pointer' }}>Send</button>
    </div>
  </div>
}

function Router(){
  const p = location.pathname
  if (p === '/model') return <ModelVolume />
  if (p === '/video') return <VideoWindow />
  if (p === '/image') return <ImageWindow />
  if (p === '/web')   return <WebPanel />
  return <CommandCenter />
}
createRoot(document.getElementById('root')).render(<Router />)
`);

      write("README.md", `# ${appTitle} — agentic command center (WebSpatial / OS 6)

A chat panel + a dispatcher that opens each agent resource as its own OS-6 window/volume:
**.glb → 3D volume · video → window · image → window · url → web panel.**

## Run
    npm install
    npm run dev            # serves on :5173

## In the PICO emulator
    adb reverse tcp:5173 tcp:5173
    # emulator browser → http://localhost:5173 → "Open as app"
Ask: *"I'm hungry"* → an avocado opens in a 3D volume. *"play a movie"* → a video window. *"where can I learn XR"* → a web panel.

## Go live
${agentEndpoint ? `Wired to your agent at \`${agentEndpoint}\`.` : "Replace the mock in `src/agent.js` with a POST to your agent (OpenClaw / your MCP) returning `{ reply, resources:[{type,url,title}] }`. Pass \`agentEndpoint\` to the generator to bake the URL in."}
`);

      return okJson({
        status: "ok",
        projectDir,
        files,
        agent: agentEndpoint ? `live: ${agentEndpoint}` : "mock (keyword→resource; edit src/agent.js or pass agentEndpoint)",
        run: ["cd " + projectDir, "npm install", "npm run dev", "adb reverse tcp:5173 tcp:5173", "emulator browser → http://localhost:5173 → 'Open as app'"],
        verify: "verify_webspatial_scenes(projectDir) for the static scene-graph + headless boot; then LOOK at the 2D projection. Spatial windows/volumes = built_for_os6.",
        note: "Agentic command center (task #4): chat → the agent hands back typed resources → the dispatcher opens each as its OS-6 window/volume. This is hackathon category (b).",
      });
    },
  );
}
