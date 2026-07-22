import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { projectedCaptureFraction, solveFreePlacement } from "./affordance.js";
import { loadOccupancyGrid, type OccupancyGrid } from "./occupancy.js";

/**
 * semanticplace.ts — v17.0 SEMANTIC PLACEMENT: anchor spec objects to LABELED real-world surfaces.
 *
 * The semantic splat layer (semantic_splat_scan → compose_semantic_scene) turns a scanned world
 * into labeled 3D boxes ("counter", "neon menu wall", "floor"). This module closes the loop for
 * CODEGEN: an AppSpec object can say `anchorTo: {label: "counter", relation: "on-top-of"}` and the
 * compiler resolves it to a concrete transform against the scanned scene — briefs place content on
 * REAL surfaces by NAME.
 *
 * v17.0 scope (foundation): deterministic axis-aligned resolution for on-top-of / next-to /
 * in-front-of, fuzzy label matching with ambiguity reporting, an agent-facing
 * `resolve_semantic_placement` tool, and the compile-time hook (anchorTo resolves to a baked
 * transform in the ledger — downstream codegen is unchanged).
 *
 * HONESTY: a resolution is GEOMETRY MATH over auto/hand-labeled boxes — evidence class structural.
 * Whether the placed content visually sits on the real counter still requires a looked-at capture
 * inside the splat world (the 17.0 verification milestone; pending until run).
 */

type Vec3 = [number, number, number];

export interface SemanticObject {
  id: number;
  label: string;
  center: Vec3;
  size: Vec3;
  /** v20: detector confidence (0-1) and how the label was established. */
  confidence?: number;
  labelEvidence?: "vision_confirmed" | "auto_judged";
}
export interface SemanticScene {
  objects: SemanticObject[];
  floorY?: number;
  bounds?: { min: Vec3; max: Vec3 };
}
export interface AnchorSpec {
  label: string;
  relation?: "on-top-of" | "next-to" | "in-front-of";
  /** Extra offset applied after resolution (meters, world axes). */
  offset?: Vec3;
  /** Clearance gap for next-to / in-front-of (meters, default 0.15). */
  gap?: number;
}
export interface Resolution {
  status: "ok" | "not-found" | "ambiguous";
  position?: Vec3;
  matched?: { id: number; label: string; score: number };
  alternatives?: { id: number; label: string; score: number }[];
  relation?: string;
  note: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Label match score: 3 exact, 2 substring, token-overlap fraction otherwise. */
export function labelScore(query: string, label: string): number {
  const q = norm(query);
  const l = norm(label);
  if (!q || !l) return 0;
  if (q === l) return 3;
  if (l.includes(q) || q.includes(l)) return 2;
  const qt = new Set(q.split(" "));
  const lt = new Set(l.split(" "));
  let hit = 0;
  for (const t of qt) if (lt.has(t)) hit++;
  return hit / Math.max(qt.size, 1);
}

export function resolveSemanticPlacement(scene: SemanticScene, anchor: AnchorSpec, childSize: Vec3 = [0.3, 0.3, 0.3]): Resolution {
  const scored = scene.objects
    .map((o) => ({ id: o.id, label: o.label, score: labelScore(anchor.label, o.label), obj: o }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) {
    return {
      status: "not-found",
      note: `no labeled object matches '${anchor.label}' — labels present: ${scene.objects.map((o) => o.label).join(", ") || "(none)"}.`,
    };
  }
  const best = scored[0];
  const ties = scored.filter((s) => s.score === best.score);
  // ambiguity: multiple equal-score matches of a fuzzy (non-exact) query → report, still resolve
  // against the LARGEST tied object so callers can proceed deliberately.
  const pick = ties.length > 1 ? ties.map((t) => ({ t, vol: t.obj.size[0] * t.obj.size[1] * t.obj.size[2] })).sort((a, b) => b.vol - a.vol)[0].t : best;

  const o = pick.obj;
  const rel = anchor.relation ?? "on-top-of";
  const gap = anchor.gap ?? 0.15;
  const half = (v: Vec3, i: number) => v[i] / 2;
  let pos: Vec3;
  if (rel === "on-top-of") {
    pos = [o.center[0], o.center[1] + half(o.size, 1) + half(childSize, 1), o.center[2]];
  } else {
    // horizontal direction: in-front-of walks toward the room center (bounds center, else origin);
    // next-to steps out along the SHORTER horizontal extent (the free side of an elongated object).
    let dir: Vec3;
    if (rel === "in-front-of") {
      const rc: Vec3 = scene.bounds
        ? [(scene.bounds.min[0] + scene.bounds.max[0]) / 2, 0, (scene.bounds.min[2] + scene.bounds.max[2]) / 2]
        : [0, 0, 0];
      const dx = rc[0] - o.center[0];
      const dz = rc[2] - o.center[2];
      const len = Math.hypot(dx, dz) || 1;
      dir = [dx / len, 0, dz / len];
    } else {
      dir = o.size[0] <= o.size[2] ? [1, 0, 0] : [0, 0, 1];
    }
    const extent = Math.abs(dir[0]) * (half(o.size, 0) + half(childSize, 0)) + Math.abs(dir[2]) * (half(o.size, 2) + half(childSize, 2));
    const baseY = scene.floorY !== undefined ? scene.floorY + half(childSize, 1) : o.center[1];
    pos = [o.center[0] + dir[0] * (extent + gap), baseY, o.center[2] + dir[2] * (extent + gap)];
  }
  if (anchor.offset) pos = [pos[0] + anchor.offset[0], pos[1] + anchor.offset[1], pos[2] + anchor.offset[2]];
  const r2 = (n: number) => Math.round(n * 1000) / 1000;
  pos = [r2(pos[0]), r2(pos[1]), r2(pos[2])];

  const conf = (pick.obj as SemanticObject).confidence;
  const lowConf = conf !== undefined && conf < 0.3 && (pick.obj as SemanticObject).labelEvidence !== "vision_confirmed";
  return {
    status: ties.length > 1 ? "ambiguous" : "ok",
    position: pos,
    matched: { id: pick.id, label: pick.label, score: pick.score },
    ...(scored.length > 1 ? { alternatives: scored.slice(0, 5).filter((s) => s.id !== pick.id).map(({ id, label, score }) => ({ id, label, score })) } : {}),
    relation: rel,
    note:
      (ties.length > 1
        ? `'${anchor.label}' matched ${ties.length} objects equally — resolved against the largest (#${pick.id} '${pick.label}'); pass a more specific label to disambiguate. `
        : `resolved '${anchor.label}' -> #${pick.id} '${pick.label}'. `) +
      (lowConf ? `LOW-CONFIDENCE label (${conf}) never eye-confirmed — spot-check the annotated scan view before trusting this anchor. ` : "") +
      `Placement is GEOMETRY over labeled boxes (structural evidence) — visually verify inside the world before claiming it sits right.`,
  };
}

/** Load a semantic scene JSON (compose_semantic_scene output or the {objects,floorY,bounds} subset). */
export function loadSemanticScene(p: string): SemanticScene | null {
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const objects = raw.objects ?? raw.semantic?.objects;
    if (!Array.isArray(objects) || !objects.length) return null;
    return { objects, floorY: raw.floorY ?? raw.placement?.floorY, bounds: raw.bounds };
  } catch {
    return null;
  }
}

const vec3Schema = z.array(z.number()).length(3);

export function registerSemanticPlaceTools(server: McpServer) {
  server.registerTool(
    "resolve_semantic_placement",
    {
      description:
        "Resolve a LABEL-ANCHORED placement against a scanned world's semantic scene (semantic_splat_scan -> compose_semantic_scene): given labeled 3D boxes and an anchor like {label:'counter', relation:'on-top-of'}, returns the concrete world position for the child content, with fuzzy label matching + ambiguity reporting. Relations: on-top-of (stack on the box top), next-to (step out along the object's free side), in-front-of (toward the room center), plus offset/gap tuning. This is what lets an AppSpec object say anchorTo:{label} and land on a REAL surface by name (the compiler calls the same resolver). HONESTY: pure geometry over labeled boxes — structural evidence; visually verify the placement inside the world before claiming it.",
      inputSchema: {
        objects: z.array(z.object({ id: z.number(), label: z.string(), center: vec3Schema, size: vec3Schema })).min(1).describe("Labeled objects from compose_semantic_scene."),
        anchorTo: z.object({
          label: z.string().describe("Target object by name, e.g. 'counter', 'neon menu'."),
          relation: z.enum(["on-top-of", "next-to", "in-front-of"]).optional().describe("Spatial relation (default on-top-of)."),
          offset: vec3Schema.optional().describe("Extra world-axis offset in meters."),
          gap: z.number().optional().describe("Clearance for next-to / in-front-of (default 0.15m)."),
        }),
        childSize: vec3Schema.optional().describe("Full extents of the content being placed (default 0.3m cube)."),
        floorY: z.number().optional().describe("Floor Y from the scan (grounds next-to / in-front-of)."),
        bounds: z.object({ min: vec3Schema, max: vec3Schema }).optional().describe("Room bounds (gives in-front-of its 'toward the room' direction)."),
      },
    },
    async ({ objects, anchorTo, childSize, floorY, bounds }) => {
      const res = resolveSemanticPlacement(
        { objects: objects as SemanticObject[], floorY, bounds: bounds as SemanticScene["bounds"] },
        anchorTo as AnchorSpec,
        (childSize as Vec3) ?? [0.3, 0.3, 0.3],
      );
      return okJson(res);
    },
  );
}

/**
 * Compile-time hook: bake every object's anchorTo into a concrete transform.position against
 * meta.semanticScenePath. An explicit transform.position wins; missing scene file or unmatched
 * label leaves the object untouched and reports it (never a silent drop). Returns the notes so
 * compile_app_spec can surface each resolution in its response.
 */
export function resolveAnchors(spec: any): { spec: any; notes: string[] } {
  const anchored = (spec.objects ?? []).filter((o: any) => o.anchorTo);
  if (!anchored.length) return { spec, notes: [] };
  const notes: string[] = [];
  const scenePath = spec.meta?.semanticScenePath;
  const scene = scenePath ? loadSemanticScene(scenePath) : null;
  if (!scene) {
    notes.push(`anchorTo present on ${anchored.length} object(s) but meta.semanticScenePath ${scenePath ? `could not be loaded (${scenePath})` : "is not set"} — anchors NOT resolved; set explicit transform.position or fix the path.`);
    return { spec, notes };
  }
  // meta.occupancyPath (build_occupancy_grid output): unlabeled scanned geometry also blocks 'on' placements
  const occPath = spec.meta?.occupancyPath;
  let occupancy: OccupancyGrid | null = null;
  if (occPath) {
    try {
      occupancy = loadOccupancyGrid(occPath.replace(/^~\//, `${process.env.HOME}/`));
      notes.push(`occupancy grid loaded (${occupancy.occupiedCells} occupied cells @ ${occupancy.cell}m) — unlabeled geometry constrains 'on' anchors.`);
    } catch {
      notes.push(`meta.occupancyPath set but could not be loaded (${occPath}) — 'on' anchors resolved WITHOUT unlabeled-geometry occupancy.`);
    }
  }
  const out = JSON.parse(JSON.stringify(spec));
  for (const o of out.objects) {
    if (!o.anchorTo) continue;
    if (o.transform?.position) {
      notes.push(`object '${o.id}': explicit transform.position wins over anchorTo('${o.anchorTo.label}') — anchor ignored.`);
      continue;
    }
    const dims = o.body?.dims;
    const childSize: Vec3 =
      o.body?.shape === "sphere" && dims?.length ? [dims[0] * 2, dims[0] * 2, dims[0] * 2]
      : o.body?.shape === "capsule" && dims?.length >= 2 ? [dims[1] * 2, dims[0], dims[1] * 2]
      : dims?.length === 3 ? [dims[0], dims[1], dims[2]]
      : [0.3, 0.3, 0.3];
    if (o.anchorTo.relation === "on") {
      // v24 affordance route: a COLLISION-FREE spot on the surface, not blind center-stacking
      const sol = solveFreePlacement(scene, {
        on: o.anchorTo.label,
        childSize,
        clearance: o.anchorTo.clearance,
        facing: o.anchorTo.facing,
        avoiding: o.anchorTo.avoiding,
        visibleFrom: o.anchorTo.visibleFrom,
        captureFrustum: o.anchorTo.captureFrustum,
      }, occupancy);
      if (sol.status !== "ok") {
        notes.push(`object '${o.id}': affordance solver ${sol.status} — ${sol.note}`);
        continue;
      }
      const off = o.anchorTo.offset ?? [0, 0, 0];
      const finalPosition = sol.position.map((v: number, i: number) => Number((v + off[i]).toFixed(3))) as Vec3;
      // The solver validates its own returned pose. anchorTo.offset is applied afterward, so the
      // final BAKED pose needs the same frustum gate or an offset can silently invalidate the claim.
      if (o.anchorTo.captureFrustum) {
        const threshold = o.anchorTo.captureFrustum.minVisibleFraction ?? 0.5;
        const fraction = projectedCaptureFraction(finalPosition, childSize, o.anchorTo.visibleFrom, o.anchorTo.captureFrustum);
        if (fraction === null || fraction + 1e-12 < threshold) {
          notes.push(
            `object '${o.id}': anchorTo.offset [${off.join(", ")}] moves the solver pose to [${finalPosition.join(", ")}], outside the capture frustum ` +
            `(${fraction === null ? "a box corner is behind the camera" : `${(fraction * 100).toFixed(1)}% < ${(threshold * 100).toFixed(1)}% visible`}) — object left unplaced.`,
          );
          continue;
        }
      }
      o.transform = { ...(o.transform ?? {}), position: finalPosition };
      if (sol.rotationYDeg !== null && !o.transform.rotationDeg) o.transform.rotationDeg = [0, sol.rotationYDeg, 0];
      notes.push(`object '${o.id}': free-placed ON '${sol.surface.label}' -> [${o.transform.position.join(", ")}] (min gap ${sol.minGapM}m${sol.rotationYDeg !== null ? `, facing yaw ${sol.rotationYDeg}°` : ""}); ${sol.note}`);
      continue;
    }
    const res = resolveSemanticPlacement(scene, o.anchorTo, childSize);
    if (!res.position) {
      notes.push(`object '${o.id}': ${res.note}`);
      continue;
    }
    o.transform = { ...(o.transform ?? {}), position: res.position };
    notes.push(`object '${o.id}': anchored ${res.relation} #${res.matched!.id} '${res.matched!.label}' -> position [${res.position.join(", ")}]${res.status === "ambiguous" ? " (AMBIGUOUS match — see resolver note)" : ""}.`);
  }
  return { spec: out, notes };
}
