import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureFrustumSchema } from "./appspec.js";
import { okJson } from "./util.js";
import { loadSemanticScene, labelScore, type SemanticScene, type SemanticObject } from "./semanticplace.js";
import { boxOccupied, rayOccluded, loadOccupancyGrid, type OccupancyGrid } from "./occupancy.js";

/**
 * affordance.ts — v24 THE AFFORDANCE MODEL: from labeled boxes to VERIFIED FREE SPACE.
 *
 * v17 anchoring answers "where is the counter?"; this answers "where ON the counter does a
 * 30cm bowl actually FIT?" — support surfaces extracted from the semantic scene, an occupancy
 * check against every other labeled box, and a grid-search solver that returns a collision-free
 * pose (or an HONEST no-fit with the tightest gap it found, never a silent overlap).
 *
 * Everything here is pure geometry over detector-labeled boxes: structural evidence. The
 * placement is not "verified" until a frame with the child IN the world has been looked at.
 */

export interface SupportSurface {
  kind: "floor" | "object-top";
  label: string;
  objectId: number | null;
  y: number; // world Y of the support plane
  min: [number, number]; // XZ rect
  max: [number, number];
  areaM2: number;
}

export interface FreePlacementQuery {
  on: string; // label or "floor"
  childSize: [number, number, number];
  clearance?: number; // min gap to obstacles + surface edges (default 0.05)
  facing?: string; // label or "room-center" — yields rotationYDeg
  avoiding?: string[]; // labels to maximize distance from (soft)
  visibleFrom?: [number, number, number]; // v27.3: a viewpoint (app frame) — candidates occluded from it are hard-rejected (needs an occupancy grid)
  captureFrustum?: CaptureFrustum; // v27.7: calibrated deterministic-forward intrinsics — candidates outside the rendered frame are hard-rejected
}

export interface CaptureFrustum {
  f: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  minVisibleFraction?: number; // clipped projected-AABB area / full projected-AABB area (default 0.5)
}

type Point3 = [number, number, number];

function projectedCornersCaptureFraction(
  corners: Point3[],
  visibleFrom: Point3,
  frustum: CaptureFrustum,
): number | null {
  const us: number[] = [];
  const vs: number[] = [];
  for (const [x, y, z] of corners) {
    const d = visibleFrom[2] - z;
    if (!(d > 0)) return null;
    us.push(frustum.cx + (frustum.f * (x - visibleFrom[0])) / d);
    vs.push(frustum.cy - (frustum.f * (y - visibleFrom[1])) / d);
  }
  const minU = Math.min(...us);
  const maxU = Math.max(...us);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);
  const fullArea = (maxU - minU) * (maxV - minV);
  if (!(fullArea > 0) || !Number.isFinite(fullArea)) return 0;
  const clippedW = Math.max(0, Math.min(frustum.width, maxU) - Math.max(0, minU));
  const clippedH = Math.max(0, Math.min(frustum.height, maxV) - Math.max(0, minV));
  return (clippedW * clippedH) / fullArea;
}

/**
 * Project an AABB through the deterministic forward camera (+X right, +Y up, -Z forward), or
 * project already-camera-aligned real corners via the two-argument overload. The latter avoids
 * enclosing rotated geometry in a second AABB and thereby inventing phantom corner combinations.
 * Returns null when any supplied corner is behind the camera; otherwise returns the fraction of
 * the projected 2D bounding box that lies inside the capture frame.
 */
export function projectedCaptureFraction(
  center: Point3,
  size: Point3,
  visibleFrom: Point3,
  frustum: CaptureFrustum,
): number | null;
export function projectedCaptureFraction(
  cameraCorners: Point3[],
  frustum: CaptureFrustum,
): number | null;
export function projectedCaptureFraction(
  centerOrCorners: Point3 | Point3[],
  sizeOrFrustum: Point3 | CaptureFrustum,
  visibleFrom?: Point3,
  frustum?: CaptureFrustum,
): number | null {
  if (Array.isArray(centerOrCorners[0])) {
    return projectedCornersCaptureFraction(centerOrCorners as Point3[], [0, 0, 0], sizeOrFrustum as CaptureFrustum);
  }
  const center = centerOrCorners as Point3;
  const size = sizeOrFrustum as Point3;
  const corners: Point3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    corners.push([
      center[0] + (sx * size[0]) / 2,
      center[1] + (sy * size[1]) / 2,
      center[2] + (sz * size[2]) / 2,
    ]);
  }
  return projectedCornersCaptureFraction(corners, visibleFrom!, frustum!);
}

const half = (v: [number, number, number], i: number) => v[i] / 2;

/** Extract support surfaces: the floor plus every object top that is flat-usable (area + height sane). */
export function extractSupportSurfaces(scene: SemanticScene): SupportSurface[] {
  const out: SupportSurface[] = [];
  const floorY = scene.floorY;
  if (floorY !== undefined && scene.bounds) {
    out.push({
      kind: "floor",
      label: "floor",
      objectId: null,
      y: floorY,
      min: [scene.bounds.min[0], scene.bounds.min[2]],
      max: [scene.bounds.max[0], scene.bounds.max[2]],
      areaM2: (scene.bounds.max[0] - scene.bounds.min[0]) * (scene.bounds.max[2] - scene.bounds.min[2]),
    });
  }
  for (const o of scene.objects) {
    const topY = o.center[1] + o.size[1] / 2;
    const area = o.size[0] * o.size[2];
    const aboveFloor = floorY !== undefined ? topY - floorY : topY;
    // usable top: enough area for anything (≥0.04 m² ≈ a 20cm square) and reachable (≤2m up)
    if (area >= 0.04 && aboveFloor <= 2.0) {
      out.push({
        kind: "object-top",
        label: o.label,
        objectId: o.id,
        y: topY,
        min: [o.center[0] - o.size[0] / 2, o.center[2] - o.size[2] / 2],
        max: [o.center[0] + o.size[0] / 2, o.center[2] + o.size[2] / 2],
        areaM2: area,
      });
    }
  }
  return out;
}

/** Obstacles for a child of height h resting on plane y: every box whose vertical span crosses (y, y+h). */
function obstaclesFor(scene: SemanticScene, surface: SupportSurface, childH: number): SemanticObject[] {
  return scene.objects.filter((o) => {
    if (surface.objectId !== null && o.id === surface.objectId) return false; // the supporter itself
    const oMin = o.center[1] - o.size[1] / 2;
    const oMax = o.center[1] + o.size[1] / 2;
    return oMax > surface.y + 0.01 && oMin < surface.y + childH; // vertical overlap with the child's span
  });
}

function resolveSurface(scene: SemanticScene, on: string): { surface?: SupportSurface; note: string; ambiguous?: string[] } {
  const surfaces = extractSupportSurfaces(scene);
  if (on === "floor") {
    const f = surfaces.find((s) => s.kind === "floor");
    return f ? { surface: f, note: "floor" } : { note: "scene has no floorY/bounds — cannot use the floor as a support surface" };
  }
  const scored = surfaces
    .filter((s) => s.kind === "object-top")
    .map((s) => ({ s, score: labelScore(on, s.label) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { note: `no support surface matches '${on}' — labeled tops: ${surfaces.filter((s) => s.kind === "object-top").map((s) => `'${s.label}'`).join(", ") || "(none usable)"}` };
  const ties = scored.filter((x) => x.score === scored[0].score);
  const pick = ties.length > 1 ? ties.sort((a, b) => b.s.areaM2 - a.s.areaM2)[0] : scored[0];
  return {
    surface: pick.s,
    note: ties.length > 1 ? `'${on}' is ambiguous (${ties.map((t) => `#${t.s.objectId} '${t.s.label}'`).join(" vs ")}) — resolved to the largest top` : `matched #${pick.s.objectId} '${pick.s.label}'`,
    ambiguous: ties.length > 1 ? ties.map((t) => t.s.label) : undefined,
  };
}

/** Grid-search a collision-free spot on the resolved surface. Honest no-fit when nothing clears. */
export function solveFreePlacement(scene: SemanticScene, q: FreePlacementQuery, occupancy?: OccupancyGrid | null) {
  if (q.captureFrustum && !q.visibleFrom) {
    return {
      status: "no-fit" as const,
      note: "captureFrustum requires visibleFrom as the deterministic forward camera center — refusing an unconstrained placement",
      frustumBlocked: 0,
    };
  }
  const clearance = q.clearance ?? 0.05;
  const [cw, ch, cd] = q.childSize;
  const res = resolveSurface(scene, q.on);
  if (!res.surface) return {
    status: "no-surface" as const,
    note: res.note,
    ...(q.captureFrustum ? { frustumBlocked: 0 } : {}),
  };
  const s = res.surface;
  const obstacles = obstaclesFor(scene, s, ch);
  const avoid = (q.avoiding ?? [])
    .map((lbl) => scene.objects.filter((o) => labelScore(lbl, o.label) > 0))
    .flat();

  // usable rect once the child's half-extents + edge clearance are inset
  const minX = s.min[0] + cw / 2 + clearance;
  const maxX = s.max[0] - cw / 2 - clearance;
  const minZ = s.min[1] + cd / 2 + clearance;
  const maxZ = s.max[1] - cd / 2 - clearance;
  if (minX > maxX || minZ > maxZ) {
    return {
      status: "no-fit" as const,
      note: `the ${s.label} top (${(s.max[0] - s.min[0]).toFixed(2)}×${(s.max[1] - s.min[1]).toFixed(2)}m) is smaller than the child footprint ${cw.toFixed(2)}×${cd.toFixed(2)}m + ${clearance}m clearance`,
      surface: s,
      ...(q.captureFrustum ? { frustumBlocked: 0 } : {}),
    };
  }

  const step = Math.max(0.04, Math.min(cw, cd) / 2);
  const candidates: { x: number; z: number; minGap: number; score: number }[] = [];
  let tightest = -Infinity;
  // occupancy: skip a shell band above the support plane so the surface's OWN scanned points
  // (floor sheet, table top) don't block everything, then require the child's swept volume clear
  const occBand = occupancy ? Math.max(1.5 * occupancy.cell, 0.08) : 0;
  let occBlocked = 0;
  let losBlocked = 0;
  let frustumBlocked = 0;
  const checkLos = !!(occupancy && q.visibleFrom);
  const checkFrustum = !!(q.visibleFrom && q.captureFrustum);
  const minVisibleFraction = q.captureFrustum?.minVisibleFraction ?? 0.5;
  // honesty: visibleFrom is a HARD constraint only when an occupancy grid exists — say so
  // loudly instead of silently skipping (reviewer finding, v27.3).
  const losSkippedNote = q.visibleFrom && !occupancy
    ? "; WARNING: visibleFrom was set but NO occupancy grid was provided — line-of-sight was NOT checked (pass occupancyPath / meta.occupancyPath)"
    : "";
  for (let x = minX; x <= maxX + 1e-9; x += step) {
    for (let z = minZ; z <= maxZ + 1e-9; z += step) {
      // The public contract emits 3-decimal poses. Evaluate EVERY constraint against that exact
      // pose so a raw floating lattice coordinate cannot pass and then round outside the gate.
      const px = Number(x.toFixed(3));
      const pz = Number(z.toFixed(3));
      // hard constraint: no XZ overlap (inflated by clearance) with any vertically-overlapping box
      let minGap = Infinity;
      for (const o of obstacles) {
        const gx = Math.abs(px - o.center[0]) - (cw / 2 + o.size[0] / 2);
        const gz = Math.abs(pz - o.center[2]) - (cd / 2 + o.size[2] / 2);
        const gap = Math.max(gx, gz); // separation along the least-separated axis pair
        minGap = Math.min(minGap, gap);
      }
      if (minGap < clearance) {
        tightest = Math.max(tightest, minGap);
        continue;
      }
      // hard constraint: no UNLABELED scanned geometry inside the child's volume (occupancy grid)
      if (occupancy) {
        const yLo = s.y + Math.min(occBand, ch / 2);
        const r = boxOccupied(occupancy, [px - cw / 2 - clearance, yLo, pz - cd / 2 - clearance], [px + cw / 2 + clearance, s.y + ch, pz + cd / 2 + clearance]);
        if (r.occupied > 0) { occBlocked++; continue; }
      }
      const target: [number, number, number] = [px, Number((s.y + ch / 2).toFixed(3)), pz];
      // hard constraint: the child's PROJECTED BOX must be substantially inside the calibrated
      // deterministic-forward capture. LOS alone only proves an unoccluded ray; it says nothing
      // about whether the rendered object is above/below/outside the image.
      if (checkFrustum) {
        const fraction = projectedCaptureFraction(target, q.childSize, q.visibleFrom!, q.captureFrustum!);
        if (fraction === null || fraction + 1e-12 < minVisibleFraction) { frustumBlocked++; continue; }
      }
      // hard constraint: the candidate must be VISIBLE from visibleFrom (occupancy required — this
      // is a line-of-sight check against scanned geometry, not just non-intersection)
      if (checkLos) {
        const los = rayOccluded(occupancy!, q.visibleFrom!, target);
        if (los.occluded) { losBlocked++; continue; }
      }
      // soft scores: stay clear of obstacles, drift from 'avoiding' labels, mild centrality
      const cx = (s.min[0] + s.max[0]) / 2;
      const cz = (s.min[1] + s.max[1]) / 2;
      const centrality = -0.3 * Math.hypot(px - cx, pz - cz);
      const avoidPenalty = avoid.reduce((a, o) => a - 1.5 / Math.max(0.2, Math.hypot(px - o.center[0], pz - o.center[2])), 0);
      const gapBonus = Math.min(minGap, 1.0);
      candidates.push({ x: px, z: pz, minGap: minGap === Infinity ? 99 : minGap, score: gapBonus + centrality + avoidPenalty });
    }
  }
  if (!candidates.length) {
    return {
      status: "no-fit" as const,
      note: `no collision-free spot on '${s.label}' for ${cw.toFixed(2)}×${cd.toFixed(2)}m with ${clearance}m clearance — tightest gap found was ${tightest === -Infinity ? "n/a" : tightest.toFixed(3) + "m"} (${obstacles.length} obstacles share the surface${occBlocked ? `; ${occBlocked} candidate cells blocked by UNLABELED scanned geometry in the occupancy grid` : ""}${checkFrustum ? `; capture frustum required ≥${(minVisibleFraction * 100).toFixed(1)}% projected-box visibility (${frustumBlocked} candidate cells blocked)` : ""}${checkLos ? `; line-of-sight checked from visibleFrom (${losBlocked} candidate cells blocked)` : ""}${losSkippedNote})`,
      surface: s,
      obstacles: obstacles.map((o) => `#${o.id} '${o.label}'`),
      losBlocked,
      ...(checkFrustum ? { frustumBlocked } : {}),
    };
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const position: [number, number, number] = [Number(best.x.toFixed(3)), Number((s.y + ch / 2).toFixed(3)), Number(best.z.toFixed(3))];

  let rotationYDeg: number | null = null;
  if (q.facing) {
    let target: [number, number] | null = null;
    if (q.facing === "room-center") {
      const b = scene.bounds;
      target = b ? [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2] : [0, 0];
    } else {
      const scored = scene.objects.map((o) => ({ o, sc: labelScore(q.facing!, o.label) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc);
      if (scored.length) target = [scored[0].o.center[0], scored[0].o.center[2]];
    }
    if (target) rotationYDeg = Number(((Math.atan2(target[0] - position[0], -(target[1] - position[2])) * 180) / Math.PI).toFixed(1));
  }

  return {
    status: "ok" as const,
    position,
    rotationYDeg,
    surface: { kind: s.kind, label: s.label, objectId: s.objectId, y: s.y },
    minGapM: Number(best.minGap.toFixed(3)),
    losBlocked,
    note: `${res.note}; ${candidates.length}/${Math.round(((maxX - minX) / step + 1) * ((maxZ - minZ) / step + 1))} grid cells clear; best min-gap ${best.minGap === 99 ? "unobstructed" : best.minGap.toFixed(2) + "m"}${occupancy ? `; occupancy grid consulted (${occBlocked} cells blocked by unlabeled geometry)` : ""}${checkFrustum ? `; capture frustum required ≥${(minVisibleFraction * 100).toFixed(1)}% projected-box visibility (${frustumBlocked} cells blocked)` : ""}${checkLos ? `; line-of-sight checked from visibleFrom (${losBlocked} candidate cells blocked)` : ""}${losSkippedNote}`,
    ...(checkFrustum ? { frustumBlocked } : {}),
    alternatives: candidates.slice(1, 4).map((c) => [Number(c.x.toFixed(3)), Number((s.y + ch / 2).toFixed(3)), Number(c.z.toFixed(3))]),
    honesty: "pure geometry over detector-labeled boxes (structural) — LOOK at a frame with the child in the world before claiming placement.",
  };
}

export function registerAffordanceTools(server: McpServer) {
  server.registerTool(
    "solve_free_placement",
    {
      description: "v24 AFFORDANCE SOLVER: find a COLLISION-FREE pose for a child object in a scanned world — 'put a 30cm bowl ON the counter, 10cm clear of everything, facing the neon sign'. Extracts support surfaces (floor + usable object tops) from the semantic scene, grid-searches free space against every other labeled box, and returns the best pose + rotationYDeg (when facing is set) + up to 3 alternatives — or an HONEST no-fit naming the tightest gap it found (never a silent overlap). visibleFrom + occupancyPath reject occluded candidates; captureFrustum additionally rejects child boxes outside the calibrated deterministic forward frame. Feed the pose into an AppSpec transform, or use anchorTo:{label, relation:'on', clearance} and the compiler routes through this solver. Structural evidence only until a frame is LOOKED at.",
      inputSchema: z.object({
        semanticScenePath: z.string().optional().describe("Path to a compose_semantic_scene JSON (or pass objects inline)."),
        objects: z.array(z.object({ id: z.number(), label: z.string(), center: z.tuple([z.number(), z.number(), z.number()]), size: z.tuple([z.number(), z.number(), z.number()]) })).optional(),
        floorY: z.number().optional(),
        bounds: z.object({ min: z.tuple([z.number(), z.number(), z.number()]), max: z.tuple([z.number(), z.number(), z.number()]) }).optional(),
        on: z.string().describe("Support surface: a label ('counter', 'table') or 'floor'."),
        childSize: z.tuple([z.number(), z.number(), z.number()]).describe("[w,h,d] meters of the thing being placed."),
        clearance: z.number().min(0).max(2).optional().describe("Min gap to obstacles and surface edges (default 0.05m)."),
        facing: z.string().optional().describe("Face this label (or 'room-center') — returns rotationYDeg."),
        avoiding: z.array(z.string()).optional().describe("Labels to keep distance from (soft constraint)."),
        occupancyPath: z.string().optional().describe("build_occupancy_grid output JSON — UNLABELED scanned geometry then also blocks candidates (closes the ramen-counter class of miss)."),
        visibleFrom: z.tuple([z.number(), z.number(), z.number()]).optional().describe("v27.3 LINE OF SIGHT: a viewpoint in the app frame (e.g. the spawn camera [0,1.2,0]). Requires occupancyPath — candidates whose ray to visibleFrom is occluded by scanned geometry are hard-rejected, not just non-intersecting ones."),
        captureFrustum: captureFrustumSchema.optional().describe("v27.7 CAPTURE FOV: calibrated deterministic-forward intrinsics. Requires visibleFrom; candidates whose projected child AABB is less than minVisibleFraction (default 0.5) inside the frame are hard-rejected."),
      }).strict(),
    },
    async ({ semanticScenePath, objects, floorY, bounds, on, childSize, clearance, facing, avoiding, occupancyPath, visibleFrom, captureFrustum }) => {
      let scene: SemanticScene | null = null;
      if (semanticScenePath) scene = loadSemanticScene(semanticScenePath.replace(/^~\//, `${process.env.HOME}/`));
      else if (objects?.length) scene = { objects: objects as SemanticObject[], floorY, bounds: bounds as SemanticScene["bounds"] };
      if (!scene) return okJson({ status: "error", error: semanticScenePath ? `cannot load semantic scene ${semanticScenePath}` : "provide semanticScenePath or inline objects" });
      let occupancy: OccupancyGrid | null = null;
      if (occupancyPath) {
        try { occupancy = loadOccupancyGrid(occupancyPath.replace(/^~\//, `${process.env.HOME}/`)); }
        catch { return okJson({ status: "error", error: `cannot load occupancy grid ${occupancyPath}` }); }
      }
      return okJson(solveFreePlacement(scene, {
        on,
        childSize: childSize as [number, number, number],
        clearance,
        facing,
        avoiding,
        visibleFrom: visibleFrom as [number, number, number] | undefined,
        captureFrustum: captureFrustum as CaptureFrustum | undefined,
      }, occupancy));
    },
  );
}
