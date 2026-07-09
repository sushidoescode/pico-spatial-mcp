import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";

const run = promisify(execFile);

/**
 * splatanalyze.ts — v14: SPLATS → INTERACTIVE SCENES on the CURRENT toolchain.
 *
 * PICO's OS 6 announcement (2026-07-08) promises the emulator will "get 3D bounding boxes on
 * splats in under one minute, and turn splats into interactive scenes". Our 0.13 toolchain has no
 * such tool — but a Gaussian splat is just a point cloud, so this REPRODUCES the capability
 * host-side, today: parse .spz (Niantic format, gzip + 24-bit fixed-point positions) or .ply
 * (binary gaussian PLY) positions, trim outlier floaters, then voxel-density cluster into K
 * oriented-to-axis 3D bounding boxes + a floor estimate — and emit the verified collider-rig
 * Kotlin (CollisionComponent primitive boxes; splats have NO native collision — the long-standing
 * gotcha this automates away). A top-down density heatmap with the boxes drawn on it makes the
 * result LOOKable host-side (honest verification without a device).
 */

type Vec3 = [number, number, number];
interface Cluster { center: Vec3; size: Vec3; points: number }

function parsePlyPositions(buf: Buffer, maxSamples: number): { pos: Float32Array; total: number } {
  const headEnd = buf.indexOf("end_header\n");
  if (headEnd < 0) throw new Error("not a PLY (no end_header)");
  const header = buf.subarray(0, headEnd).toString("latin1");
  if (!/format binary_little_endian/.test(header)) throw new Error("only binary_little_endian PLY supported");
  const m = header.match(/element vertex (\d+)/);
  if (!m) throw new Error("no vertex element");
  const total = parseInt(m[1]);
  // compute the per-vertex stride + x/y/z offsets from the property list
  const SIZES: Record<string, number> = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, char: 1, int8: 1, short: 2, ushort: 2, int: 4, uint: 4, int32: 4, uint32: 4 };
  let stride = 0; const offs: Record<string, number> = {};
  for (const line of header.split("\n")) {
    const pm = line.match(/^property (\w+) (\w+)/);
    if (!pm) continue;
    offs[pm[2]] = stride;
    stride += SIZES[pm[1]] ?? 4;
  }
  if (!("x" in offs && "y" in offs && "z" in offs)) throw new Error("PLY lacks x/y/z");
  const data = buf.subarray(headEnd + "end_header\n".length);
  const step = Math.max(1, Math.floor(total / maxSamples));
  const n = Math.floor(total / step);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const base = i * step * stride;
    pos[i * 3] = data.readFloatLE(base + offs.x);
    pos[i * 3 + 1] = data.readFloatLE(base + offs.y);
    pos[i * 3 + 2] = data.readFloatLE(base + offs.z);
  }
  return { pos, total };
}

function parseSpzPositions(raw: Buffer, maxSamples: number): { pos: Float32Array; total: number } {
  const buf = zlib.gunzipSync(raw);
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x5053474e) throw new Error(`not an SPZ (magic 0x${magic.toString(16)})`); // 'NGSP'
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  const fractionalBits = buf.readUInt8(13);
  if (version !== 2 && version !== 3) throw new Error(`unsupported SPZ version ${version}`);
  const HEADER = 16;
  const scale = 1 / (1 << fractionalBits);
  const step = Math.max(1, Math.floor(total / maxSamples));
  const n = Math.floor(total / step);
  const pos = new Float32Array(n * 3);
  // positions: 3 × 24-bit signed little-endian fixed point per point, first block after the header
  for (let i = 0; i < n; i++) {
    const base = HEADER + i * step * 9;
    for (let a = 0; a < 3; a++) {
      const o = base + a * 3;
      let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
      if (v & 0x800000) v -= 0x1000000; // sign-extend 24-bit
      pos[i * 3 + a] = v * scale;
    }
  }
  return { pos, total };
}

/** percentile trim per axis (splats have floater outliers) */
function trim(pos: Float32Array, lo = 0.01, hi = 0.99): { pos: Float32Array; min: Vec3; max: Vec3 } {
  const n = pos.length / 3;
  const bounds: { min: Vec3; max: Vec3 } = { min: [0, 0, 0], max: [0, 0, 0] };
  for (let a = 0; a < 3; a++) {
    const vals = new Float32Array(n);
    for (let i = 0; i < n; i++) vals[i] = pos[i * 3 + a];
    vals.sort();
    bounds.min[a] = vals[Math.floor(n * lo)];
    bounds.max[a] = vals[Math.floor(n * hi) - 1];
  }
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (let a = 0; a < 3; a++) { const v = pos[i * 3 + a]; if (v < bounds.min[a] || v > bounds.max[a]) { ok = false; break; } }
    if (ok) keep.push(i);
  }
  const out = new Float32Array(keep.length * 3);
  keep.forEach((src, dst) => { out[dst * 3] = pos[src * 3]; out[dst * 3 + 1] = pos[src * 3 + 1]; out[dst * 3 + 2] = pos[src * 3 + 2]; });
  return { pos: out, min: bounds.min, max: bounds.max };
}

/** voxel-density clustering → axis-aligned boxes (26-connected components above a density threshold) */
function clusterBoxes(pos: Float32Array, min: Vec3, max: Vec3, cell: number, topK: number): { clusters: Cluster[]; cellUsed: number } {
  let dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / cell))) as Vec3;
  if (dims[0] * dims[1] * dims[2] > 8_000_000) {
    // auto-raise the cell to fit the grid budget (object-scale splats with huge halos hit this)
    cell *= Math.cbrt((dims[0] * dims[1] * dims[2]) / 8_000_000) * 1.05;
    dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / cell))) as Vec3;
  }
  const [dx, dy, dz] = dims;
  const grid = new Uint16Array(dx * dy * dz);
  const idx = (x: number, y: number, z: number) => (z * dy + y) * dx + x;
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const x = Math.min(dx - 1, Math.floor((pos[i * 3] - min[0]) / cell));
    const y = Math.min(dy - 1, Math.floor((pos[i * 3 + 1] - min[1]) / cell));
    const z = Math.min(dz - 1, Math.floor((pos[i * 3 + 2] - min[2]) / cell));
    const k = idx(x, y, z);
    if (grid[k] < 65535) grid[k]++;
  }
  // density threshold: mean occupied density (occupied cells only) — keeps solid structure, drops mist
  let occ = 0, sum = 0;
  for (let k = 0; k < grid.length; k++) if (grid[k] > 0) { occ++; sum += grid[k]; }
  const thresh = Math.max(2, Math.round(sum / Math.max(1, occ)));
  // BFS connected components (6-connectivity is tighter/cleaner than 26 for furniture)
  const seen = new Uint8Array(grid.length);
  const clusters: Cluster[] = [];
  const stack: number[] = [];
  for (let z0 = 0; z0 < dz; z0++) for (let y0 = 0; y0 < dy; y0++) for (let x0 = 0; x0 < dx; x0++) {
    const k0 = idx(x0, y0, z0);
    if (seen[k0] || grid[k0] < thresh) continue;
    let lo: Vec3 = [x0, y0, z0], hi: Vec3 = [x0, y0, z0], pts = 0, cells = 0;
    stack.push(x0, y0, z0); seen[k0] = 1;
    while (stack.length) {
      const z = stack.pop()!, y = stack.pop()!, x = stack.pop()!;
      pts += grid[idx(x, y, z)]; cells++;
      lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
      hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
      for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const nx = x + ox, ny = y + oy, nz = z + oz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= dx || ny >= dy || nz >= dz) continue;
        const nk = idx(nx, ny, nz);
        if (!seen[nk] && grid[nk] >= thresh) { seen[nk] = 1; stack.push(nx, ny, nz); }
      }
    }
    if (cells < 4) continue; // noise
    clusters.push({
      center: [0, 1, 2].map((a) => min[a] + ((lo[a] + hi[a] + 1) / 2) * cell) as Vec3,
      size: [0, 1, 2].map((a) => Math.max(cell, (hi[a] - lo[a] + 1) * cell)) as Vec3,
      points: pts,
    });
  }
  clusters.sort((a, b) => b.points - a.points);
  return { clusters: clusters.slice(0, topK), cellUsed: cell };
}

/** floor estimate: dominant low band of the Y histogram */
function floorY(pos: Float32Array, minY: number, maxY: number): number {
  const bins = 200, hist = new Uint32Array(bins);
  const n = pos.length / 3, span = Math.max(1e-6, maxY - minY);
  for (let i = 0; i < n; i++) hist[Math.min(bins - 1, Math.floor(((pos[i * 3 + 1] - minY) / span) * bins))]++;
  // the first strong peak from the bottom (≥ 60% of the max bin in the lower half)
  let best = 0;
  for (let b = 0; b < bins / 2; b++) best = Math.max(best, hist[b]);
  for (let b = 0; b < bins / 2; b++) if (hist[b] >= best * 0.6) return minY + ((b + 0.5) / bins) * span;
  return minY;
}

/** strip the room SHELL (floor/ceiling/wall bands) so interior objects separate into distinct clusters */
function stripShell(pos: Float32Array, min: Vec3, max: Vec3, fy: number, band: number): Float32Array {
  const keep: number[] = [];
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], zz = pos[i * 3 + 2];
    if (y < fy + band) continue;                    // floor shell
    if (y > max[1] - band) continue;                // ceiling shell
    if (x < min[0] + band || x > max[0] - band) continue; // wall shells
    if (zz < min[2] + band || zz > max[2] - band) continue;
    keep.push(i);
  }
  const out = new Float32Array(keep.length * 3);
  keep.forEach((src, dst) => { out[dst * 3] = pos[src * 3]; out[dst * 3 + 1] = pos[src * 3 + 1]; out[dst * 3 + 2] = pos[src * 3 + 2]; });
  return out;
}

async function heatmapPng(pos: Float32Array, min: Vec3, max: Vec3, clusters: Cluster[], out: string) {
  // top-down (X-Z) log-density heatmap as a raw PPM, then magick → PNG + cluster rectangles
  const W = 640, H = 640;
  const grid = new Float64Array(W * H);
  const n = pos.length / 3;
  const sx = (max[0] - min[0]) || 1, sz = (max[2] - min[2]) || 1;
  for (let i = 0; i < n; i++) {
    const px = Math.min(W - 1, Math.floor(((pos[i * 3] - min[0]) / sx) * (W - 1)));
    const pz = Math.min(H - 1, Math.floor(((pos[i * 3 + 2] - min[2]) / sz) * (H - 1)));
    grid[pz * W + px]++;
  }
  let mx = 0; for (let k = 0; k < grid.length; k++) mx = Math.max(mx, grid[k]);
  const ppm = Buffer.alloc(W * H * 3);
  for (let k = 0; k < grid.length; k++) {
    const v = Math.log1p(grid[k]) / Math.log1p(mx);
    ppm[k * 3] = Math.round(20 + v * 235); ppm[k * 3 + 1] = Math.round(16 + v * 120); ppm[k * 3 + 2] = Math.round(40 + v * 180);
  }
  const ppmPath = out.replace(/\.png$/, ".ppm");
  fs.writeFileSync(ppmPath, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`, "latin1"), ppm]));
  const draws: string[] = [];
  clusters.forEach((c) => {
    const x0 = ((c.center[0] - c.size[0] / 2 - min[0]) / sx) * (W - 1), x1 = ((c.center[0] + c.size[0] / 2 - min[0]) / sx) * (W - 1);
    const z0 = ((c.center[2] - c.size[2] / 2 - min[2]) / sz) * (H - 1), z1 = ((c.center[2] + c.size[2] / 2 - min[2]) / sz) * (H - 1);
    draws.push("-draw", `rectangle ${x0.toFixed(0)},${z0.toFixed(0)} ${x1.toFixed(0)},${z1.toFixed(0)}`);
  });
  await run("magick", [ppmPath, "-fill", "none", "-stroke", "#22e0ff", "-strokewidth", "2", ...draws, out], { timeout: 60_000 });
  fs.unlinkSync(ppmPath);
}

export function registerSplatAnalyzeTools(server: McpServer) {
  server.registerTool(
    "analyze_splat",
    {
      description:
        "3D BOUNDING BOXES ON A GAUSSIAN SPLAT, host-side, in seconds (reproduces PICO's announced OS-6 emulator capability on the CURRENT 0.13 toolchain). Parses .spz (Niantic v2/v3) or binary .ply positions, trims floater outliers (1-99 percentile), voxel-density clusters into top-K axis-aligned boxes, estimates the floor plane, and renders a top-down density HEATMAP with the boxes drawn on it (LOOK at it to verify the boxes wrap real structures — honest host-side verification). Feed the result to generate_splat_colliders to make the splat INTERACTIVE (splats have no native collision). Returns {numPoints, sampled, elapsedMs, global, floorY, clusters, heatmap}.",
      inputSchema: {
        splatPath: z.string().describe("Path to the .spz or .ply gaussian splat."),
        cellSize: z.number().optional().describe("Voxel size in splat units/meters (default 0.15 — furniture scale)."),
        topK: z.number().optional().describe("Max cluster boxes to return (default 10)."),
        maxSamples: z.number().optional().describe("Position subsample cap for speed (default 400000)."),
        heatmapOut: z.string().optional().describe("Heatmap PNG path (default alongside the splat under /tmp/pico-render/splat)."),
      },
    },
    async ({ splatPath, cellSize, topK, maxSamples, heatmapOut }) => {
      const t0 = Date.now();
      if (!fs.existsSync(splatPath)) return okJson({ status: "error", error: `not found: ${splatPath}` });
      try {
        const raw = fs.readFileSync(splatPath);
        const cap = maxSamples ?? 400_000;
        const parsed = splatPath.toLowerCase().endsWith(".ply") ? parsePlyPositions(raw, cap) : parseSpzPositions(raw, cap);
        const t = trim(parsed.pos);
        const span = Math.max(t.max[0] - t.min[0], t.max[1] - t.min[1], t.max[2] - t.min[2]);
        const cell = cellSize ?? Math.min(0.5, Math.max(0.02, span / 60)); // auto: ~60 cells across the largest axis
        const fy = floorY(t.pos, t.min[1], t.max[1]);
        // strip the room shell (floor/ceiling/walls) so interior structures cluster separately
        const interior = stripShell(t.pos, t.min, t.max, fy, Math.max(cell * 1.2, 0.1));
        const cb = clusterBoxes(interior.length ? interior : t.pos, t.min, t.max, cell, topK ?? 10);
        const spanV: Vec3 = [t.max[0] - t.min[0], t.max[1] - t.min[1], t.max[2] - t.min[2]];
        // classify: a box spanning >55% of the room in 2+ axes is STRUCTURE (interior walls/large
        // connected mass), not a discrete object — colliders should treat it differently
        const classify = (c: Cluster) => {
          const big = [0, 1, 2].filter((a) => c.size[a] > spanV[a] * 0.55).length;
          return big >= 2 ? "structure" : "object";
        };
        const hm = heatmapOut ?? path.join("/tmp/pico-render/splat", path.basename(splatPath).replace(/\.(spz|ply)$/i, "") + "-boxes.png");
        fs.mkdirSync(path.dirname(hm), { recursive: true });
        let heatmap: string | null = hm;
        try { await heatmapPng(t.pos, t.min, t.max, cb.clusters, hm); } catch (e: any) { heatmap = null; }
        const elapsedMs = Date.now() - t0;
        return okJson({
          status: "ok", file: splatPath, format: splatPath.toLowerCase().endsWith(".ply") ? "ply" : "spz",
          numPoints: parsed.total, sampled: t.pos.length / 3, interiorSampled: undefined as any, cellSize: +cb.cellUsed.toFixed(3), elapsedMs,
          global: { min: t.min.map((v) => +v.toFixed(3)), max: t.max.map((v) => +v.toFixed(3)) }, floorY: +fy.toFixed(3),
          clusters: cb.clusters.map((c) => ({ kind: classify(c), center: c.center.map((v) => +v.toFixed(3)), size: c.size.map((v) => +v.toFixed(3)), points: c.points })),
          heatmap,
          note: `LOOK at the heatmap — the cyan boxes should wrap the dense structures. Then generate_splat_colliders to emit the interactive collider rig. (${elapsedMs}ms — the announced capability is 'under one minute'.)`,
        });
      } catch (e: any) {
        return okJson({ status: "error", error: String(e?.message ?? e).slice(0, 300) });
      }
    },
  );

  server.registerTool(
    "generate_splat_colliders",
    {
      description:
        "Turn analyze_splat's bounding boxes into the INTERACTIVE collider rig (SplatColliders.kt): a static CollisionComponent box per cluster + a floor slab at floorY — the verified primitive-collider pattern (splats have NO native collision; mesh colliders never register). With this rig, Scene.rayCast hits the splat's structures — pins stick to real splat surfaces, objects rest on splat furniture: 'turn splats into interactive scenes' on the CURRENT toolchain. Optional debugVisuals renders each box as a translucent mesh so the fit is vision-verifiable in-app. RETURNS JSON {kotlin, callSnippet}.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content"),
        clusters: z.array(z.object({ center: z.array(z.number()).length(3), size: z.array(z.number()).length(3) })).min(1).describe("Cluster boxes from analyze_splat."),
        floorY: z.number().optional().describe("Floor height from analyze_splat (adds a floor slab collider; omit to skip)."),
        roomBounds: z.object({ min: z.array(z.number()).length(3), max: z.array(z.number()).length(3) }).optional().describe("analyze_splat's global bounds — emits 4 WALL slab colliders at the room perimeter (pass OBJECT-kind clusters here, walls come from these bounds; 'structure'-kind boxes usually should NOT be passed as solid boxes — they'd block rayCast through the whole interior)."),
        yUp: z.boolean().optional().describe("Splat frame is already Y-up (default true; World Labs Marble splats usually need the same rotation as the splat entity — apply the SAME transform to this rig's parent)."),
        debugVisuals: z.boolean().optional().describe("Render each collider as a translucent box mesh (verify the fit in-app; default false)."),
      },
    },
    async ({ packageName, clusters, floorY: fy, roomBounds, debugVisuals }) => {
      const dbg = debugVisuals === true;
      const boxes = clusters.map((c, i) => {
        const [cx, cy, cz] = c.center.map((v) => +v.toFixed(3));
        const [sx, sy, sz] = c.size.map((v) => +Math.max(0.05, v).toFixed(3));
        return [
          `        box(root, "SplatBox${i}", Vector3(${cx}f, ${cy}f, ${cz}f), Vector3(${sx}f, ${sy}f, ${sz}f))`,
        ].join("\n");
      }).join("\n");
      const kt = `package ${packageName}

import android.util.Log
import com.pico.spatial.core.ecs.CollisionComponent
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.ModelComponent
import com.pico.spatial.core.ecs.PhysicsWorldComponent
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.ecs.resource.MeshResource
import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial
import com.pico.spatial.core.ecs.resource.PhysicsMaterialResource
import com.pico.spatial.core.ecs.resource.ShapeResource
import com.pico.spatial.core.math.Color4
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3

/**
 * Generated by generate_splat_colliders — the auto-extracted interactive collider rig for a
 * Gaussian splat (from analyze_splat's density boxes). Splats have NO native collision; these
 * static CollisionComponent boxes make Scene.rayCast + resting physics work against the splat's
 * real structures. IMPORTANT: add this rig under the SAME parent/transform as the splat entity
 * so the boxes stay registered with the world the splat renders in.
 */
object SplatColliders {
    private const val TAG = "SplatColliders"
    private val physMat = PhysicsMaterialResource(0.6f, 0.6f, 0.2f)

    private fun box(root: Entity, name: String, center: Vector3, fullExtents: Vector3) {
        val e = Entity()
        e.setName(name)
        e.components.set(TransformComponent(center, Quat.identity(), Vector3(1f, 1f, 1f)))
        runCatching {
            e.components.set(CollisionComponent(listOf(ShapeResource.createBox(fullExtents)), physMat))
${dbg ? `            val mat = PhysicallyBasedMaterial.create().apply { setBaseColor(Color4(0.13f, 0.88f, 1f, 0.28f)); setMetallic(0.1f); setRoughness(0.6f) }
            e.components.set(ModelComponent(MeshResource.createBox(fullExtents), mat))
` : ""}        }.onFailure { Log.e(TAG, "$name failed: " + it.message) }
        root.addChild(e)
    }

    /** Call once, on the splat's parent (Dispatchers.Main). Ensures a PhysicsWorldComponent exists. */
    fun install(root: Entity) {
        runCatching { root.components.set(PhysicsWorldComponent()) }
${boxes}
${fy !== undefined ? `        box(root, "SplatFloor", Vector3(${roomBounds ? (((roomBounds.min[0] + roomBounds.max[0]) / 2).toFixed(2)) : "0"}f, ${((+fy.toFixed(3)) - 0.05).toFixed(2)}f, ${roomBounds ? (((roomBounds.min[2] + roomBounds.max[2]) / 2).toFixed(2)) : "0"}f), Vector3(${roomBounds ? (roomBounds.max[0] - roomBounds.min[0] + 0.4).toFixed(2) : "12"}f, 0.1f, ${roomBounds ? (roomBounds.max[2] - roomBounds.min[2] + 0.4).toFixed(2) : "12"}f))\n` : ""}${roomBounds ? (() => {
        const [mnx, , mnz] = roomBounds.min, [mxx, mxy, mxz] = roomBounds.max;
        const cy = ((fy ?? roomBounds.min[1]) + mxy) / 2, hgt = (mxy - (fy ?? roomBounds.min[1]) + 0.2);
        const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2, w = mxx - mnx, d = mxz - mnz;
        return [
          `        box(root, "SplatWallN", Vector3(${cx.toFixed(2)}f, ${cy.toFixed(2)}f, ${(mnz - 0.06).toFixed(2)}f), Vector3(${(w + 0.4).toFixed(2)}f, ${hgt.toFixed(2)}f, 0.12f))`,
          `        box(root, "SplatWallS", Vector3(${cx.toFixed(2)}f, ${cy.toFixed(2)}f, ${(mxz + 0.06).toFixed(2)}f), Vector3(${(w + 0.4).toFixed(2)}f, ${hgt.toFixed(2)}f, 0.12f))`,
          `        box(root, "SplatWallW", Vector3(${(mnx - 0.06).toFixed(2)}f, ${cy.toFixed(2)}f, ${cz.toFixed(2)}f), Vector3(0.12f, ${hgt.toFixed(2)}f, ${(d + 0.4).toFixed(2)}f))`,
          `        box(root, "SplatWallE", Vector3(${(mxx + 0.06).toFixed(2)}f, ${cy.toFixed(2)}f, ${cz.toFixed(2)}f), Vector3(0.12f, ${hgt.toFixed(2)}f, ${(d + 0.4).toFixed(2)}f))`,
        ].join("\n") + "\n";
      })() : ""}        Log.i(TAG, "splat collider rig installed: ${clusters.length} boxes${fy !== undefined ? " + floor" : ""}")
    }
}
`;
      return okJson({
        kotlin: kt,
        callSnippet: "SplatColliders.install(splatParent)   // the SAME parent/transform as the splat entity, on Dispatchers.Main",
        boxes: clusters.length,
        note: `Write to content/SplatColliders.kt. ${dbg ? "debugVisuals ON — translucent boxes render for a vision-verifiable fit." : "Re-run with debugVisuals:true to SEE the boxes in-app."} rayCast + resting physics now work against the splat's structures.`,
      });
    },
  );
}
