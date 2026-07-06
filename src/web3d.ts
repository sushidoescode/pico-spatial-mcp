import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { okJson } from "./util.js";

/**
 * web3d.ts — v10.16 (P14): three.js 3D scenes in the WEB lane.
 *
 * The emulator's Chromium 138 has WebGL2 + WebGPU + WebXR (verified). This generates a self-
 * contained three.js 3D scene (no build) that renders as a floating spatial panel — an in-browser
 * 3D lane beside the native Filament one. Presets: 'orbit' (a glowing core + orbiting spheres, an
 * orrery/galaxy), 'grid' (a grid of spinning shapes), 'torusfield'. Serve it + drive_browser to
 * open; capture_frame to SEE the GPU render. On PICO OS 6 a WebXR button enters immersive (session
 * runs; visual compositing is Swan-hardware — inline/panel render is verifiable now).
 */
const esc = (s: string) => s.replace(/</g, "&lt;");

function sceneJs(preset: string, count: number, palette: string[]): string {
  const cols = JSON.stringify(palette.length ? palette : ["#7fd7ff", "#7dff9b", "#ff9bce", "#ffd24d", "#c07bff", "#ff8a5c"]);
  if (preset === "grid") {
    return `const N=${count}, COLS=${cols};
    const g=Math.ceil(Math.sqrt(N));
    for(let i=0;i<N;i++){const s=(i%3===0)?new THREE.TorusKnotGeometry(0.35,0.13,80,16):(i%3===1)?new THREE.IcosahedronGeometry(0.5,0):new THREE.BoxGeometry(0.7,0.7,0.7);
      const m=new THREE.MeshStandardMaterial({color:COLS[i%COLS.length],metalness:0.6,roughness:0.25});
      const o=new THREE.Mesh(s,m); o.position.set((i%g-g/2)*1.6,(Math.floor(i/g)-g/2)*1.6,0); o.userData.sp=0.4+Math.random(); scene.add(o); objs.push(o);}
    animate=(t)=>{objs.forEach(o=>{o.rotation.x=t*0.0006*o.userData.sp;o.rotation.y=t*0.0009*o.userData.sp;});};`;
  }
  if (preset === "torusfield") {
    return `const N=${count}, COLS=${cols};
    for(let i=0;i<N;i++){const o=new THREE.Mesh(new THREE.TorusGeometry(0.5+i*0.12,0.06,16,64),new THREE.MeshStandardMaterial({color:COLS[i%COLS.length],emissive:COLS[i%COLS.length],emissiveIntensity:0.4,metalness:0.7,roughness:0.2}));
      o.rotation.x=Math.random()*Math.PI; o.rotation.y=Math.random()*Math.PI; o.userData.a=Math.random()*6; scene.add(o); objs.push(o);}
    animate=(t)=>{objs.forEach((o,i)=>{o.rotation.z=t*0.0004*(i+1)+o.userData.a;});};`;
  }
  // orbit (default): glowing core + N orbiting spheres
  return `const N=${count}, COLS=${cols};
    const core=new THREE.Mesh(new THREE.SphereGeometry(0.7,48,48),new THREE.MeshStandardMaterial({color:0xfff2b0,emissive:0xffcc44,emissiveIntensity:1.4}));
    scene.add(core); const cl=new THREE.PointLight(0xffd488,2.2,50); scene.add(cl);
    for(let i=0;i<N;i++){const r=1.8+i*0.55, sz=0.16+Math.random()*0.18;
      const o=new THREE.Mesh(new THREE.SphereGeometry(sz,32,32),new THREE.MeshStandardMaterial({color:COLS[i%COLS.length],metalness:0.5,roughness:0.35}));
      o.userData={r, a:Math.random()*6.28, sp:0.3+Math.random()*0.5, tilt:(Math.random()-0.5)*0.5}; scene.add(o); objs.push(o);
      const ring=new THREE.Mesh(new THREE.RingGeometry(r-0.01,r+0.01,96),new THREE.MeshBasicMaterial({color:0x33406a,side:THREE.DoubleSide,transparent:true,opacity:0.4})); ring.rotation.x=Math.PI/2+o.userData.tilt; scene.add(ring);}
    animate=(t)=>{objs.forEach(o=>{const a=o.userData.a+t*0.0004*o.userData.sp; o.position.set(Math.cos(a)*o.userData.r,Math.sin(o.userData.tilt)*Math.sin(a)*o.userData.r,Math.sin(a)*o.userData.r);}); core.rotation.y=t*0.0002;};`;
}

export function registerWeb3DTools(server: McpServer) {
  server.registerTool(
    "generate_web3d_scene",
    {
      description:
        "Generate a three.js 3D SCENE that renders in the emulator's Chromium (P14) — the in-browser 3D lane (WebGL2/WebGPU verified). Self-contained HTML (three.js via CDN, no build). Presets: 'orbit' (glowing core + orbiting spheres — orrery/galaxy), 'grid' (spinning metal shapes), 'torusfield'. Includes lighting, PBR materials, animation, orbit-drag controls, INTERACTIVE raycast selection (click objects -> highlight + label; a window.Scene3D select/data JS API), and a WebXR 'Enter VR' button (session runs on OS 6; inline/panel render verifiable now). Writes an .html; serve it (host server + adb reverse) then drive_browser url=... + capture_frame to SEE the GPU render. Returns the file path + serve/open commands.",
      inputSchema: {
        outPath: z.string().describe("Output .html path, e.g. /tmp/web3d/galaxy.html"),
        title: z.string().optional().describe("On-screen title (default 'WEB 3D')."),
        preset: z.enum(["orbit", "grid", "torusfield"]).optional().describe("Scene preset (default orbit)."),
        count: z.number().optional().describe("Object count (default 6)."),
        palette: z.array(z.string()).optional().describe("Hex colors."),
        interactive: z.boolean().optional().describe("P16: raycast-select objects (click/tap -> pulse + highlight + a title readout), a select(i)/data(values) JS API (window.Scene3D), and window.__selected. Verifiable via CDP (Scene3D.select(i) -> window.__selected). Default true for interactive scenes."),
        labels: z.array(z.string()).optional().describe("Per-object labels shown on selection (interactive)."),
      },
    },
    async ({ outPath, title, preset, count, palette, interactive, labels }) => {
      const t = title ?? "WEB 3D";
      const inter = interactive !== false;
      const body = sceneJs(preset ?? "orbit", count ?? 6, palette ?? []);
      const labelsJs = JSON.stringify(labels ?? []);
      const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#05060d}h1{position:fixed;top:3vh;left:4vw;color:#7fd7ff;font:800 5vh -apple-system;margin:0;z-index:2;pointer-events:none}
#vr{position:fixed;bottom:3vh;right:4vw;z-index:2;font:700 3vh -apple-system;padding:1.5vh 3vw;border:none;border-radius:2vh;background:#1b8f4a;color:#fff}</style>
<script type="importmap">{"imports":{"three":"./three.module.js","three/addons/controls/OrbitControls.js":"./OrbitControls.js"}}</script></head>
<body><h1>${esc(t)}</h1><button id=vr>Enter VR</button>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x05060d);
const camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,0.1,100); camera.position.set(0,3,8);
const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setSize(innerWidth,innerHeight); renderer.setPixelRatio(devicePixelRatio); document.body.appendChild(renderer.domElement);
renderer.xr.enabled=true;
scene.add(new THREE.AmbientLight(0x556699,0.6)); const key=new THREE.DirectionalLight(0xffffff,1.1); key.position.set(4,6,3); scene.add(key);
const controls=new OrbitControls(camera,renderer.domElement); controls.enableDamping=true;
const objs=[]; let animate=()=>{};
${body}
${inter ? `
// P16 INTERACTIVITY: raycast selection + a data/select JS API (window.Scene3D) + a readout.
const LABELS=${labelsJs};
const readout=document.createElement('div'); readout.id='sel';
readout.style.cssText='position:fixed;top:12vh;left:4vw;z-index:2;color:#7dff9b;font:800 4vh -apple-system;pointer-events:none;text-shadow:0 0 12px #000';
document.body.appendChild(readout);
window.__selected=-1;
function highlight(i){
  objs.forEach((o,j)=>{ if(o.material&&o.material.emissive){ o.material.emissiveIntensity = (j===i?0.9:(o.userData.__baseEmis||0)); } o.scale.setScalar(j===i?1.4:1); });
  window.__selected=i;
  readout.textContent = i>=0 ? (LABELS[i] || ('OBJECT '+i)) : '';
}
objs.forEach(o=>{ o.userData.__baseEmis = (o.material&&o.material.emissiveIntensity)||0; });
const ray=new THREE.Raycaster(), ptr=new THREE.Vector2();
function pick(cx,cy){ ptr.x=(cx/innerWidth)*2-1; ptr.y=-(cy/innerHeight)*2+1; ray.setFromCamera(ptr,camera); const hit=ray.intersectObjects(objs,false)[0]; highlight(hit?objs.indexOf(hit.object):-1); }
renderer.domElement.addEventListener('pointerdown',e=>pick(e.clientX,e.clientY));
// programmatic API (CDP/bridge verifiable)
window.Scene3D = {
  select:(i)=>{ highlight(i); return window.__selected; },
  count:()=>objs.length,
  data:(values)=>{ objs.forEach((o,j)=>{ const v=values[j]; if(v!=null){ o.scale.setScalar(0.5+v); } }); return objs.length; },
  selected:()=>window.__selected,
};
// deep-link a selection (#select=N) or data (#data=v0,v1,..) — for deterministic capture/verification
if(location.hash.includes('select=')){ const n=parseInt(location.hash.split('select=')[1]); if(!isNaN(n)) highlight(n); }
if(location.hash.includes('data=')){ const vs=location.hash.split('data=')[1].split(',').map(Number); window.Scene3D.data(vs); readout.textContent='DATA-DRIVEN'; }
` : ''}
renderer.setAnimationLoop((t)=>{ animate(t||performance.now()); controls.update(); renderer.render(scene,camera); });
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
document.getElementById('vr').onclick=async()=>{ if(navigator.xr){ try{ const s=await navigator.xr.requestSession('immersive-vr'); renderer.xr.setSession(s); document.getElementById('vr').textContent='VR session'; }catch(e){ document.getElementById('vr').textContent='VR: '+e.name; } } };
window.__ready=true;
</script></body></html>`;
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html);
      const dir = path.dirname(outPath), file = path.basename(outPath);
      return okJson({
        status: "ok",
        file: outPath,
        serve: `cd ${dir} && python3 -m http.server 8792 &  ;  adb reverse tcp:8792 tcp:8792`,
        open: `drive_browser url=http://localhost:8792/${file}  (then capture_frame + a sweep to SEE the render; drive_browser evalJs='window.__ready' to confirm it loaded)`,
        note: "three.js is co-served locally (place three.module.js + OrbitControls.js beside the .html — jsdelivr build/three.module.js is a single self-contained bundle; the emulator can be flaky reaching a CDN at runtime, so bundle it). WebGL2/WebGPU verified on the emulator; a WebXR 'Enter VR' button starts an immersive session (visual compositing = Swan-hardware; the inline 3D panel render is verifiable now).",
      });
    },
  );
}
