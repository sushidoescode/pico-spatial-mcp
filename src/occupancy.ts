import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { parsePlyPositions, parseSpzPositions, trim, floorY as estimateFloorY } from "./splatanalyze.js";

/**
 * occupancy.ts — OCCUPANCY FROM GEOMETRY: voxelize raw splat/mesh points into a persistent
 * occupancy grid so the affordance solver avoids UNLABELED obstacles, not just detector boxes.
 *
 * The v24 solver is blind to anything the detector didn't label — the ledgered ramen-counter
 * finding (com.example.affordance seq 1): an unlabeled counter occluded a "collision-free"
 * floor placement. This closes that gap at the geometry level: every scanned point votes for
 * its voxel, dense voxels are occupied, and a placement candidate whose swept volume touches
 * an occupied voxel is rejected — label or no label.
 *
 * Same honesty rule as v24: this is structural evidence. A pose is not "verified" until a
 * frame with the child IN the world has been looked at.
 */

type Vec3 = [number, number, number];

export interface OccupancyGrid {
  cell: number;         // meters per voxel (may be auto-raised to fit the grid budget)
  origin: Vec3;         // world-frame min corner (after any lift/offset)
  dims: Vec3;           // [dx, dy, dz] voxel counts
  bits: Uint8Array;     // 1 byte per voxel, 1 = occupied
  occupiedCells: number;
  offsetApplied: Vec3;  // the world-frame shift applied to the points (e.g. floor lift)
  source?: string;
}

export interface BuildOccupancyOpts {
  cell?: number;            // default 0.05
  minPointsPerCell?: number; // default: max(2, mean occupied density) — same rule as clusterBoxes
  offset?: Vec3;            // explicit world shift applied to every point
  liftFloorToZero?: boolean; // estimate the floor band and shift it to y=0 (the v19 app frame)
  trim?: boolean;           // percentile-trim floater outliers first (default true)
  source?: string;
}

/** Voxelize points into an occupancy grid. Pure geometry, no labels. */
export function buildOccupancyGrid(posIn: Float32Array, opts: BuildOccupancyOpts = {}): OccupancyGrid {
  if (posIn.length < 3) throw new Error("buildOccupancyGrid: no points");
  const t = opts.trim === false ? null : trim(posIn);
  const pos = t ? t.pos : posIn;
  const n = pos.length / 3;

  const offset: Vec3 = [...(opts.offset ?? [0, 0, 0])] as Vec3;
  if (opts.liftFloorToZero) {
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { const y = pos[i * 3 + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    offset[1] -= estimateFloorY(pos, minY, maxY);
  }

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      const v = pos[i * 3 + a] + offset[a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }

  let cell = opts.cell ?? 0.05;
  let dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / cell + 1e-9))) as Vec3;
  if (dims[0] * dims[1] * dims[2] > 8_000_000) {
    cell *= Math.cbrt((dims[0] * dims[1] * dims[2]) / 8_000_000) * 1.05;
    dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / cell + 1e-9))) as Vec3;
  }
  const [dx, dy, dz] = dims;
  const counts = new Uint16Array(dx * dy * dz);
  const idx = (x: number, y: number, z: number) => (z * dy + y) * dx + x;
  for (let i = 0; i < n; i++) {
    const x = Math.min(dx - 1, Math.floor((pos[i * 3] + offset[0] - min[0]) / cell));
    const y = Math.min(dy - 1, Math.floor((pos[i * 3 + 1] + offset[1] - min[1]) / cell));
    const z = Math.min(dz - 1, Math.floor((pos[i * 3 + 2] + offset[2] - min[2]) / cell));
    const k = idx(x, y, z);
    if (counts[k] < 65535) counts[k]++;
  }
  let occ = 0, sum = 0;
  for (let k = 0; k < counts.length; k++) if (counts[k] > 0) { occ++; sum += counts[k]; }
  const thresh = opts.minPointsPerCell ?? Math.max(2, Math.round(sum / Math.max(1, occ)));
  const bits = new Uint8Array(counts.length);
  let occupiedCells = 0;
  for (let k = 0; k < counts.length; k++) if (counts[k] >= thresh) { bits[k] = 1; occupiedCells++; }
  return { cell, origin: min, dims, bits, occupiedCells, offsetApplied: offset, source: opts.source };
}

/** Count occupied voxels overlapping a world-frame AABB. Space outside the grid counts as free. */
export function boxOccupied(grid: OccupancyGrid, min: Vec3, max: Vec3): { occupied: number; checked: number } {
  const [dx, dy, dz] = grid.dims;
  const lo = [0, 1, 2].map((a) => Math.max(0, Math.floor((min[a] - grid.origin[a]) / grid.cell)));
  const hi = [0, 1, 2].map((a) => Math.min(grid.dims[a] - 1, Math.ceil((max[a] - grid.origin[a]) / grid.cell) - 1));
  let occupied = 0, checked = 0;
  for (let z = lo[2]; z <= hi[2]; z++)
    for (let y = lo[1]; y <= hi[1]; y++)
      for (let x = lo[0]; x <= hi[0]; x++) {
        checked++;
        if (grid.bits[(z * dy + y) * dx + x]) occupied++;
      }
  return { occupied, checked };
}

/**
 * v27.3 LINE OF SIGHT: sample the segment from->to at grid.cell/2 steps and report the first
 * occupied voxel hit. Samples within skipNearM (default 0.25m) of EITHER endpoint are skipped —
 * the viewer's own position and the target's own volume must not self-occlude the check. Points
 * outside the grid's bbox are free (same rule as boxOccupied).
 */
export function rayOccluded(
  grid: OccupancyGrid,
  from: Vec3,
  to: Vec3,
  opts: { skipNearM?: number } = {},
): { occluded: boolean; fraction: number | null } {
  const skipNear = opts.skipNearM ?? 0.25;
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-9) return { occluded: false, fraction: null };
  const step = grid.cell / 2;
  const steps = Math.max(1, Math.ceil(dist / step));
  const [gx, gy, gz] = grid.dims;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (t * dist < skipNear || (1 - t) * dist < skipNear) continue;
    const px = from[0] + dx * t, py = from[1] + dy * t, pz = from[2] + dz * t;
    const cx = Math.floor((px - grid.origin[0]) / grid.cell);
    const cy = Math.floor((py - grid.origin[1]) / grid.cell);
    const cz = Math.floor((pz - grid.origin[2]) / grid.cell);
    if (cx < 0 || cy < 0 || cz < 0 || cx >= gx || cy >= gy || cz >= gz) continue; // outside the grid = free
    if (grid.bits[(cz * gy + cy) * gx + cx]) return { occluded: true, fraction: Number(t.toFixed(4)) };
  }
  return { occluded: false, fraction: null };
}

export function saveOccupancyGrid(grid: OccupancyGrid, p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    version: 1,
    cell: grid.cell,
    origin: grid.origin,
    dims: grid.dims,
    occupiedCells: grid.occupiedCells,
    offsetApplied: grid.offsetApplied,
    source: grid.source,
    bits: Buffer.from(grid.bits).toString("base64"),
  }));
}

export function loadOccupancyGrid(p: string): OccupancyGrid {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return {
    cell: raw.cell,
    origin: raw.origin,
    dims: raw.dims,
    bits: new Uint8Array(Buffer.from(raw.bits, "base64")),
    occupiedCells: raw.occupiedCells,
    offsetApplied: raw.offsetApplied ?? [0, 0, 0],
    source: raw.source,
  };
}

/** Load splat point positions from a .ply or .spz file (same parsers as analyze_splat). */
export function loadSplatPositions(p: string, maxSamples = 400000): { pos: Float32Array; total: number } {
  const buf = fs.readFileSync(p);
  return p.toLowerCase().endsWith(".spz") ? parseSpzPositions(buf, maxSamples) : parsePlyPositions(buf, maxSamples);
}

export function registerOccupancyTools(server: McpServer) {
  server.tool(
    "build_occupancy_grid",
    "OCCUPANCY FROM GEOMETRY: voxelize a splat scan (.ply/.spz) into a persistent occupancy grid so solve_free_placement avoids UNLABELED obstacles, not just detector-labeled boxes (closes the ramen-counter finding: a scanned-but-unlabeled counter occluding a 'free' placement). liftFloorToZero shifts the estimated floor band to y=0 to match the app/semantic-scene frame (the v19 world-seating recipe). Saves the grid JSON and returns stats; pass its path as occupancyPath to solve_free_placement, or set meta.occupancyPath in an AppSpec so anchorTo relation:'on' routes through it at compile time. Structural evidence only — LOOK at a frame before claiming placement.",
    {
      splatPath: z.string().describe("Path to the .ply or .spz splat scan."),
      cell: z.number().min(0.01).max(0.5).optional().describe("Voxel size in meters (default 0.05; auto-raised if the grid exceeds 8M cells)."),
      maxSamples: z.number().int().min(10000).max(2000000).optional().describe("Point subsample cap (default 400000)."),
      liftFloorToZero: z.boolean().optional().describe("Shift the estimated floor band to y=0 — the app/semantic frame (default true)."),
      minPointsPerCell: z.number().int().min(1).optional().describe("Occupancy threshold (default: mean occupied density, min 2 — drops splat mist)."),
      out: z.string().optional().describe("Output grid JSON path (default ~/.pico-mcp/artifacts/<splat>.occupancy.json)."),
    },
    async ({ splatPath, cell, maxSamples, liftFloorToZero, minPointsPerCell, out }) => {
      const p = splatPath.replace(/^~\//, `${process.env.HOME}/`);
      if (!fs.existsSync(p)) return okJson({ status: "error", error: `splat not found: ${p}` });
      const { pos, total } = loadSplatPositions(p, maxSamples ?? 400000);
      const grid = buildOccupancyGrid(pos, { cell, minPointsPerCell, liftFloorToZero: liftFloorToZero ?? true, source: p });
      const outPath = (out ?? `${process.env.HOME}/.pico-mcp/artifacts/${path.basename(p).replace(/\.[^.]+$/, "")}.occupancy.json`).replace(/^~\//, `${process.env.HOME}/`);
      saveOccupancyGrid(grid, outPath);
      return okJson({
        status: "ok",
        gridPath: outPath,
        points: { total, sampled: pos.length / 3 },
        cell: grid.cell,
        dims: grid.dims,
        occupiedCells: grid.occupiedCells,
        occupiedFrac: Number((grid.occupiedCells / (grid.dims[0] * grid.dims[1] * grid.dims[2])).toFixed(4)),
        offsetApplied: grid.offsetApplied,
        note: "pass gridPath as occupancyPath to solve_free_placement (or meta.occupancyPath in an AppSpec) — unlabeled geometry now blocks placement candidates.",
      });
    },
  );
}
