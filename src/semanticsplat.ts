import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/** execFile errors lead with the full command line (incl. the JSON argv) — the useful part is the
 *  stderr tail (the python traceback), so surface that first. */
function subprocessError(e: any): string {
  const stderr = String(e?.stderr ?? "").trim();
  if (stderr) return stderr.slice(-400);
  return String(e?.message ?? e).slice(0, 300);
}

/**
 * semanticsplat.ts — the SEMANTIC layer for Gaussian splats (learned from PICO's July-9 workshop +
 * nigelhartman/splat_analyzer). World models expose three levels of info: VISUAL (the splat) →
 * GEOMETRIC (collision boxes, our analyze_splat) → SEMANTIC (what/where each object is). analyze_splat
 * gives geometry; THIS adds labels so an agent can reference "the counter", "the neon menu", "the floor"
 * by name — which unlocks AUTO-FRAMING (aim the camera at the hero object) and AUTO-PLACEMENT (rest
 * physics props on the labeled floor/counter) instead of the manual pose-sweeping we did by hand.
 *
 *   semantic_splat_scan   — geometric clusters (via analyze_splat) + headless COLOR perspective views
 *                           covering the room, with each cluster's 3D box drawn + numbered. The agent
 *                           LOOKS at the views and labels each #id (our vision-verify ethos), OR pass
 *                           autoLabel=true for headless OWL-v2 zero-shot labels (scripts/py/owl_label.py,
 *                           auto_judged — spot-check the views). Renderer: scripts/py/splat_perspective.py.
 *   compose_semantic_scene — labels -> {semantic JSON, RELATIONSHIP graph (on-top-of / next-to / inside),
 *                           AUTO-FRAME camera pose facing a hero label, AUTO-PLACE physics on the floor}.
 */

type Vec3 = [number, number, number];
interface Cluster { id: number; kind: string; center: Vec3; size: Vec3; points: number; }

async function selfCall(name: string, args: any): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const transport = new StdioClientTransport({ command: "node", args: [path.join(here, "index.js")], cwd: path.dirname(here) });
  const client = new Client({ name: "semantic-splat", version: "1" });
  await client.connect(transport);
  try {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
    try { return JSON.parse(text); } catch { return text; }
  } finally { await client.close().catch(() => {}); }
}

// resolve a python that has numpy + PIL (the renderer's deps)
function resolvePython(): { py: string; ok: boolean; hint: string } {
  const candidates = [
    process.env.PICO_PY,
    path.join(os.homedir(), ".pico/venv/bin/python"),
    "/opt/homebrew/opt/python@3.12/bin/python3.12",
    "python3",
  ].filter(Boolean) as string[];
  for (const py of candidates) {
    try { execFileSync(py, ["-c", "import numpy, PIL"], { stdio: "ignore" }); return { py, ok: true, hint: "" }; } catch {}
  }
  return { py: "python3", ok: false, hint: "The splat renderer needs numpy + Pillow. Install: python3 -m pip install numpy pillow (or point PICO_PY at a venv that has them)." };
}

// the OWL-v2 labeler needs transformers>=4.46 (post_process_grounded_object_detection) + torch +
// scipy (Owlv2ImageProcessor); probe the actual method so old pins fail here, not mid-run
async function hasOwlDeps(py: string): Promise<boolean> {
  try {
    await execFileAsync(py, ["-c", "import scipy, torch; from transformers import Owlv2Processor; assert hasattr(Owlv2Processor, 'post_process_grounded_object_detection')"], { timeout: 120_000 });
    return true;
  } catch { return false; }
}

/** generic indoor vocabulary for zero-shot labeling when the caller doesn't pass one. */
const DEFAULT_LABEL_QUERIES = [
  "counter", "bar counter", "table", "chair", "stool", "shelf", "shelving unit",
  "menu board", "neon sign", "sign", "lamp", "light fixture", "plant", "sofa", "bed",
  "cabinet", "refrigerator", "machine", "screen", "window", "door", "curtain",
  "bottle", "box", "pot",
];

/** covering camera poses: 4 cardinals from the room centroid at eye level + 2 cross-room from the ends. */
function coveringViews(min: Vec3, max: Vec3, floorY: number, outDir: string): { name: string; C: Vec3; T: Vec3; out: string }[] {
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const eye = floorY + 1.2;
  const c: Vec3 = [cx, eye, cz];
  const v = (name: string, C: Vec3, T: Vec3) => ({ name, C, T, out: path.join(outDir, `view-${name}.png`) });
  return [
    v("negZ", c, [cx, eye, cz - 1]),
    v("posZ", c, [cx, eye, cz + 1]),
    v("posX", c, [cx + 1, eye, cz]),
    v("negX", c, [cx - 1, eye, cz]),
    v("fromNegZ", [cx, eye, min[2] + 0.4], [cx, eye - 0.15, cz]),
    v("fromPosZ", [cx, eye, max[2] - 0.4], [cx, eye - 0.15, cz]),
  ];
}

/** derive a relationship graph from labeled boxes: on-top-of, next-to, inside. */
function relationships(objs: { id: number; label: string; center: Vec3; size: Vec3 }[]): { a: number; b: number; rel: string }[] {
  const rels: { a: number; b: number; rel: string }[] = [];
  const bb = (o: any) => ({
    x0: o.center[0] - o.size[0] / 2, x1: o.center[0] + o.size[0] / 2,
    y0: o.center[1] - o.size[1] / 2, y1: o.center[1] + o.size[1] / 2,
    z0: o.center[2] - o.size[2] / 2, z1: o.center[2] + o.size[2] / 2,
  });
  const xzOverlap = (A: any, B: any) => Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0)) * Math.max(0, Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0));
  for (let i = 0; i < objs.length; i++) for (let j = 0; j < objs.length; j++) {
    if (i === j) continue;
    const A = bb(objs[i]), B = bb(objs[j]);
    const ov = xzOverlap(A, B);
    const footprint = Math.min((A.x1 - A.x0) * (A.z1 - A.z0), (B.x1 - B.x0) * (B.z1 - B.z0)) || 1;
    // A on top of B: A's base ~ B's top, meaningful XZ overlap
    if (ov / footprint > 0.25 && Math.abs(A.y0 - B.y1) < 0.25 && objs[i].center[1] > objs[j].center[1]) rels.push({ a: objs[i].id, b: objs[j].id, rel: "on-top-of" });
    // A inside B
    else if (A.x0 >= B.x0 && A.x1 <= B.x1 && A.y0 >= B.y0 && A.y1 <= B.y1 && A.z0 >= B.z0 && A.z1 <= B.z1) rels.push({ a: objs[i].id, b: objs[j].id, rel: "inside" });
  }
  // next-to: adjacent in XZ at similar height (undirected, dedup i<j)
  for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) {
    const A = bb(objs[i]), B = bb(objs[j]);
    const gap = Math.hypot(objs[i].center[0] - objs[j].center[0], objs[i].center[2] - objs[j].center[2]);
    const yClose = Math.abs(objs[i].center[1] - objs[j].center[1]) < 0.6;
    const near = gap < (Math.max(A.x1 - A.x0, A.z1 - A.z0) + Math.max(B.x1 - B.x0, B.z1 - B.z0)) / 2 + 0.4;
    if (yClose && near && !rels.some(r => (r.a === objs[i].id && r.b === objs[j].id) || (r.a === objs[j].id && r.b === objs[i].id))) rels.push({ a: objs[i].id, b: objs[j].id, rel: "next-to" });
  }
  return rels;
}

export function registerSemanticSplatTools(server: McpServer) {
  server.registerTool(
    "semantic_splat_scan",
    {
      description:
        "The SEMANTIC layer for a Gaussian splat (visual→geometric→SEMANTIC). Runs analyze_splat for the GEOMETRIC 3D boxes, then renders headless COLOR perspective views covering the room (numpy point projection, no GL — clean + recognizable, unlike the emulator's garbled splat) with each cluster's box drawn + numbered. LOOK at every returned view and label each #id ('counter','neon menu','bottle shelf','floor','stool'…), then call compose_semantic_scene with those labels. This is what lets an agent reference objects by NAME -> auto-framing + auto-placement. HEADLESS MODE: autoLabel=true runs OWL-v2 zero-shot detection over clean renders and returns autoLabels per cluster id — these are auto_judged detector opinions, NOT vision-verified; spot-check the annotated views before trusting a hero label. Returns {clusters, views:[{out,name,visibleIds}], bounds, floorY, autoLabels?}.",
      inputSchema: {
        splatPath: z.string().describe("Absolute path to the .ply (or .spz) Gaussian splat."),
        topK: z.number().optional().describe("Max object clusters to label (default 12)."),
        maxSamples: z.number().optional().describe("Points to render per view (default 500000)."),
        outDir: z.string().optional().describe("Where to write the view PNGs (default /tmp/pico-render/semantic/<stem>)."),
        autoLabel: z.boolean().optional().describe("Run OWL-v2 zero-shot labeling headlessly over the views (needs transformers+torch in the resolved python; ~1GB model download on first use)."),
        labelQueries: z.array(z.string()).optional().describe("Candidate labels for the zero-shot detector (default: a generic indoor vocabulary). Pass scene-specific terms ('ramen bar counter', 'neon menu') for better matches."),
      },
    },
    async ({ splatPath, topK, maxSamples, outDir, autoLabel, labelQueries }) => {
      if (!fs.existsSync(splatPath)) return okJson({ status: "error", error: `not found: ${splatPath}` });
      const { py, ok, hint } = resolvePython();
      if (!ok) return okJson({ status: "error", error: hint });
      const stem = path.basename(splatPath).replace(/\.(spz|ply)$/i, "");
      const dir = outDir ?? path.join("/tmp/pico-render/semantic", stem);
      fs.mkdirSync(dir, { recursive: true });
      // 1. geometric clusters
      const a = await selfCall("analyze_splat", { splatPath, topK: topK ?? 12 });
      if (a.status !== "ok") return okJson({ status: "error", error: `analyze_splat: ${a.error}` });
      const clusters: Cluster[] = (a.clusters ?? []).map((c: any, i: number) => ({ id: i, kind: c.kind, center: c.center, size: c.size, points: c.points }));
      const min = a.global.min as Vec3, max = a.global.max as Vec3, floorY = a.floorY as number;
      // 2. covering color views with the boxes projected in (clean copies + 2D boxes when auto-labeling).
      // Check the OWL deps BEFORE rendering so an unavailable labeler doesn't waste the 960px render.
      let autoLabels: any;
      const owlReady = autoLabel ? await hasOwlDeps(py) : false;
      if (autoLabel && !owlReady) {
        autoLabels = { status: "unavailable", hint: `${py} lacks transformers>=4.46 + torch + scipy. Install: ${py} -m pip install transformers torch scipy` };
      }
      const views = coveringViews(min, max, floorY, dir);
      const scriptsDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url))), "..", "scripts", "py");
      const size = owlReady ? 960 : 640; // OWL-v2 ingests 960px — render at native detector resolution
      // scale the default point budget with render area so the 960px views keep the 640px density
      const cfg = { splat: splatPath, maxPts: maxSamples ?? (size === 960 ? 1_125_000 : 500_000), W: size, H: size, fov: 80, clusters, views, saveClean: owlReady };
      let rendered: any;
      try {
        const { stdout } = await execFileAsync(py, [path.join(scriptsDir, "splat_perspective.py"), JSON.stringify(cfg)], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 10 * 60 * 1000 });
        rendered = JSON.parse(stdout.trim().split("\n").pop() as string);
      } catch (e: any) {
        return okJson({ status: "error", error: `render failed: ${subprocessError(e)}`, hint });
      }
      // 3. optional headless OWL-v2 labeling over the clean views (generous timeout: first use
      // downloads the ~1GB model, then CPU-inferences six 960px views)
      if (owlReady) {
        try {
          const owlCfg = { views: rendered.views, queries: labelQueries?.length ? labelQueries : DEFAULT_LABEL_QUERIES };
          const { stdout } = await execFileAsync(py, [path.join(scriptsDir, "owl_label.py"), JSON.stringify(owlCfg)], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 30 * 60 * 1000 });
          const owl = JSON.parse(stdout.trim().split("\n").pop() as string);
          autoLabels = {
            status: "ok", ...owl,
            evidence: "auto_judged — OWL-v2 zero-shot opinions matched to cluster boxes by IoU. Spot-check the annotated views (LOOK) before trusting a hero label; record_verification stays vision_verified-only for looked-at claims.",
          };
        } catch (e: any) {
          autoLabels = { status: "error", error: `owl_label failed: ${subprocessError(e)}` };
        }
      }
      return okJson({
        status: "ok",
        splat: splatPath,
        points: rendered.points,
        bounds: { min, max },
        floorY,
        clusters,
        views: rendered.views,
        heatmap: a.heatmap,
        ...(autoLabels ? { autoLabels } : {}),
        next: autoLabels?.status === "ok"
          ? "autoLabels holds OWL-v2 opinions per cluster id. Spot-check the annotated views, then compose_semantic_scene(objects=[{id,label,center,size}…], heroLabel=…) using the labels you accept."
          : "LOOK at each view PNG (the numbered cyan/magenta boxes are the clusters). Label each #id, then compose_semantic_scene(splatPath, objects=[{id,label},…], heroLabel=…). Unlabeled ids are dropped.",
      });
    },
  );

  server.registerTool(
    "compose_semantic_scene",
    {
      description:
        "Turn semantic_splat_scan labels into a STRUCTURED scene: a labeled-object JSON, a RELATIONSHIP graph (on-top-of / next-to / inside, derived from the 3D boxes — so an agent resolves 'the table on the carpet' to the right object), an AUTO-FRAME camera pose that faces a chosen hero label (the fix for the manual pose-sweeping), and AUTO-PLACEMENT of physics on the labeled floor. Pass the clusters back with a label per id. Returns {objects, relationships, autoFrame, placement}. Feed autoFrame into the environment transform and placement into generate_splat_colliders / your physics props.",
      inputSchema: {
        objects: z.array(z.object({
          id: z.number().describe("Cluster id from semantic_splat_scan."),
          label: z.string().describe("What it is, e.g. 'neon menu wall', 'counter', 'bottle shelf', 'stool', 'floor'."),
          center: z.array(z.number()).length(3),
          size: z.array(z.number()).length(3),
        })).min(1).describe("The labeled clusters (drop the ones you couldn't identify)."),
        bounds: z.object({ min: z.array(z.number()).length(3), max: z.array(z.number()).length(3) }).describe("Room bounds from semantic_splat_scan."),
        floorY: z.number().describe("Floor Y from semantic_splat_scan."),
        heroLabel: z.string().optional().describe("Which labeled object to auto-frame the camera on (e.g. 'neon menu wall'). Default: the object with the largest wall-like face."),
        eyeHeight: z.number().optional().describe("Standing eye height above the floor for the auto-frame (default 1.3)."),
      },
    },
    async ({ objects, bounds, floorY, heroLabel, eyeHeight }) => {
      const objs = objects.map((o) => ({ id: o.id, label: o.label, center: o.center as Vec3, size: o.size as Vec3 }));
      const min = bounds.min as Vec3, max = bounds.max as Vec3;
      const rels = relationships(objs);
      // hero: named, else the widest wall-like object (large in one horizontal axis + tall, thin in the other)
      const wallScore = (o: any) => Math.max(o.size[0], o.size[2]) * o.size[1] / (Math.min(o.size[0], o.size[2]) + 0.1);
      const hero = (heroLabel ? objs.find((o) => o.label.toLowerCase().includes(heroLabel.toLowerCase())) : undefined)
        ?? [...objs].sort((a, b) => wallScore(b) - wallScore(a))[0];
      // auto-frame: stand back from the hero along the axis of the room's open space, at eye level, look at it.
      const eh = eyeHeight ?? 1.3;
      const eyeY = floorY + eh;
      const roomCx = (min[0] + max[0]) / 2, roomCz = (min[2] + max[2]) / 2;
      // face the hero from the room interior: camera on the line from hero-center toward room-center, backed off.
      const toCenter: Vec3 = [roomCx - hero.center[0], 0, roomCz - hero.center[2]];
      const len = Math.hypot(toCenter[0], toCenter[2]) || 1;
      const back = Math.max(1.4, Math.max(hero.size[0], hero.size[2]) * 0.9); // stand-off distance
      const camPos: Vec3 = [hero.center[0] + (toCenter[0] / len) * back, eyeY, hero.center[2] + (toCenter[2] / len) * back];
      const lookAt: Vec3 = [hero.center[0], floorY + eh * 0.75, hero.center[2]];
      // placement: the floor collider + any 'floor'/'counter'-labeled resting surfaces
      const floorObj = objs.find((o) => /floor/i.test(o.label));
      const surfaces = objs.filter((o) => /floor|counter|table|shelf|deck/i.test(o.label))
        .map((o) => ({ id: o.id, label: o.label, topY: +(o.center[1] + o.size[1] / 2).toFixed(3), center: o.center, size: o.size }));
      return okJson({
        status: "ok",
        objects: objs.map((o) => ({ ...o, center: o.center.map((v) => +v.toFixed(3)), size: o.size.map((v) => +v.toFixed(3)) })),
        relationships: rels.map((r) => ({ ...r, aLabel: objs.find((o) => o.id === r.a)?.label, bLabel: objs.find((o) => o.id === r.b)?.label })),
        autoFrame: {
          hero: hero.label,
          note: "Seat the world so this cameraPos maps to the emulator's fixed eye (world origin, looking -Z). For a mesh/splat env with the fixed forward camera: envTransform.position = (0, eyeY, 0) - cameraPos, then aim via a yaw so lookAt is forward. Use this instead of hand-sweeping the pose.",
          cameraPos: camPos.map((v) => +v.toFixed(3)),
          lookAt: lookAt.map((v) => +v.toFixed(3)),
          eyeY: +eyeY.toFixed(3),
        },
        placement: {
          floorY: +floorY.toFixed(3),
          floorLabelId: floorObj?.id ?? null,
          restingSurfaces: surfaces,
          note: "Emit the physics floor at floorY (generate_splat_colliders passes roomBounds); drop props onto a restingSurface's topY (they land on the labeled counter/shelf instead of clipping).",
        },
        note: "Labeled scene + relationship graph + a computed hero camera pose + resting surfaces — the semantic upgrade so placement/framing is automatic, not hand-tuned.",
      });
    },
  );
}
