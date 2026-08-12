// occupancy.mjs — gate for the v27-line OCCUPANCY-FROM-GEOMETRY capability: voxelize raw splat
// points into an occupancy grid so solve_free_placement avoids UNLABELED obstacles (the ramen-
// counter finding, ledgered on com.example.affordance seq 1). Synthetic known-geometry checks
// first (hand-verifiable), then the real ramen scan when it exists on this machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildOccupancyGrid,
  boxOccupied,
  rayOccluded,
  saveOccupancyGrid,
  loadOccupancyGrid,
  loadSplatPositions,
} from "../dist/occupancy.js";
import { solveFreePlacement } from "../dist/affordance.js";
import { resolveAnchors } from "../dist/semanticplace.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

console.log("occupancy gate (occupancy-from-geometry: unlabeled obstacles block placement)");

/** dense lattice of points filling an AABB — every claim below is checkable by hand */
function lattice(min, max, spacing = 0.025) {
  const pts = [];
  for (let x = min[0]; x <= max[0] + 1e-9; x += spacing)
    for (let y = min[1]; y <= max[1] + 1e-9; y += spacing)
      for (let z = min[2]; z <= max[2] + 1e-9; z += spacing) pts.push(x, y, z);
  return new Float32Array(pts);
}
const concat = (...arrs) => {
  const out = new Float32Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// 1) grid basics: a 1m³ block is occupied, empty space is not
{
  const block = lattice([1, 0, 1], [2, 1, 2]);
  const grid = buildOccupancyGrid(block, { cell: 0.05 });
  const inside = boxOccupied(grid, [1.1, 0.1, 1.1], [1.9, 0.9, 1.9]);
  const outside = boxOccupied(grid, [3, 2, 3], [3.5, 2.5, 3.5]);
  if (grid.occupiedCells > 3000 && inside.occupied > 0 && outside.occupied === 0)
    ok(`1m³ block -> ${grid.occupiedCells} occupied cells; inside occupied=${inside.occupied}, empty region occupied=0`);
  else fail(`grid basics: occupiedCells=${grid.occupiedCells} inside=${inside.occupied} outside=${outside.occupied}`);
}

// 2) save/load roundtrip preserves the grid exactly
{
  const grid = buildOccupancyGrid(lattice([0, 0, 0], [0.5, 0.5, 0.5]), { cell: 0.05 });
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "occ-")), "grid.json");
  saveOccupancyGrid(grid, p);
  const back = loadOccupancyGrid(p);
  const same =
    back.cell === grid.cell &&
    back.occupiedCells === grid.occupiedCells &&
    JSON.stringify(back.dims) === JSON.stringify(grid.dims) &&
    Buffer.compare(Buffer.from(back.bits), Buffer.from(grid.bits)) === 0;
  if (same) ok(`roundtrip: ${grid.occupiedCells} cells, dims ${grid.dims.join("×")} identical after save/load`);
  else fail(`roundtrip mismatch: cell=${back.cell}/${grid.cell} occ=${back.occupiedCells}/${grid.occupiedCells}`);
}

// 3) THE capability: an UNLABELED block at room center redirects a floor placement
{
  const scene = { objects: [], floorY: 0, bounds: { min: [0, 0, 0], max: [4, 3, 4] } };
  const block = { min: [1.5, 0, 1.5], max: [2.5, 1, 2.5] }; // no label anywhere — invisible to v24
  const grid = buildOccupancyGrid(lattice(block.min, block.max), { cell: 0.05 });
  const q = { on: "floor", childSize: [0.4, 0.4, 0.4], clearance: 0.05 };
  const blind = solveFreePlacement(scene, q);
  const seeing = solveFreePlacement(scene, q, grid);
  const blindInside =
    blind.status === "ok" &&
    blind.position[0] > block.min[0] && blind.position[0] < block.max[0] &&
    blind.position[2] > block.min[2] && blind.position[2] < block.max[2];
  const clearOfBlock =
    seeing.status === "ok" &&
    boxOccupied(grid,
      [seeing.position[0] - 0.2, 0.1, seeing.position[2] - 0.2],
      [seeing.position[0] + 0.2, 0.4, seeing.position[2] + 0.2]).occupied === 0;
  if (blindInside && clearOfBlock)
    ok(`unlabeled 1m³ block: blind solver lands INSIDE it [${blind.position.join(", ")}], occupancy-aware solver clears it [${seeing.position.join(", ")}]`);
  else fail(`unlabeled obstacle: blind=${blind.status}@${blind.position} inside=${blindInside}; seeing=${seeing.status}@${seeing.position} clear=${clearOfBlock}`);
}

// 4) the support surface's OWN points must not block placement (floor shell band)
{
  const scene = { objects: [], floorY: 0, bounds: { min: [0, 0, 0], max: [4, 3, 4] } };
  const floorSheet = lattice([0, 0, 0], [4, 0.02, 4], 0.04);
  const grid = buildOccupancyGrid(floorSheet, { cell: 0.05 });
  const r = solveFreePlacement(scene, { on: "floor", childSize: [0.4, 0.4, 0.4], clearance: 0.05 }, grid);
  if (r.status === "ok") ok(`floor-shell points alone do not block: placed at [${r.position.join(", ")}]`);
  else fail(`floor shell blocked placement: ${r.status} ${r.note ?? ""}`);
}

// 5) honest no-fit when unlabeled geometry fills the room — and the note SAYS it was occupancy
{
  const scene = { objects: [], floorY: 0, bounds: { min: [0, 0, 0], max: [2, 3, 2] } };
  const grid = buildOccupancyGrid(lattice([0, 0, 0], [2, 1, 2], 0.04), { cell: 0.05 });
  const r = solveFreePlacement(scene, { on: "floor", childSize: [0.4, 0.4, 0.4], clearance: 0.05 }, grid);
  if (r.status === "no-fit" && /occupancy|unlabeled|scanned/i.test(r.note ?? ""))
    ok(`fully-occupied room -> honest no-fit naming occupancy: "${r.note}"`);
  else fail(`expected occupancy no-fit, got ${r.status}: ${r.note ?? ""}`);
}

// 6) liftFloorToZero: a grid built in a sunken frame reports the lift and lands in app frame
{
  // floor sheet at y=-0.7 plus a box on it — after lift, floor ≈ 0
  const pts = concat(lattice([0, -0.7, 0], [3, -0.68, 3], 0.04), lattice([1, -0.7, 1], [1.5, -0.2, 1.5]));
  const grid = buildOccupancyGrid(pts, { cell: 0.05, liftFloorToZero: true });
  const liftOk = Math.abs(grid.offsetApplied[1] - 0.7) < 0.06;
  const boxThere = boxOccupied(grid, [1.05, 0.15, 1.05], [1.45, 0.45, 1.45]).occupied > 0;
  if (liftOk && boxThere) ok(`liftFloorToZero: lift=${grid.offsetApplied[1].toFixed(3)}m (≈0.7), box found in app frame`);
  else fail(`lift: offsetApplied=${grid.offsetApplied?.join(",")} boxOccupied>0=${boxThere}`);
}

// 7) compile path: meta.occupancyPath threads through resolveAnchors -> anchorTo relation 'on'
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-anchor-"));
  const scenePath = path.join(dir, "scene.json");
  // one labeled object in a corner (loadSemanticScene requires a non-empty scene); the block stays UNLABELED
  fs.writeFileSync(scenePath, JSON.stringify({ objects: [{ id: 1, label: "plant", center: [0.3, 0.15, 3.7], size: [0.2, 0.3, 0.2] }], floorY: 0, bounds: { min: [0, 0, 0], max: [4, 3, 4] } }));
  const grid = buildOccupancyGrid(lattice([1.5, 0, 1.5], [2.5, 1, 2.5]), { cell: 0.05 });
  const gridPath = path.join(dir, "grid.json");
  saveOccupancyGrid(grid, gridPath);
  const spec = {
    meta: { semanticScenePath: scenePath, occupancyPath: gridPath },
    objects: [{ id: "crate", body: { shape: "box", dims: [0.4, 0.4, 0.4] }, anchorTo: { label: "floor", relation: "on", clearance: 0.05 } }],
  };
  const { spec: out, notes } = resolveAnchors(spec);
  const p = out.objects[0].transform?.position;
  const clear = p && boxOccupied(grid, [p[0] - 0.2, 0.1, p[2] - 0.2], [p[0] + 0.2, 0.4, p[2] + 0.2]).occupied === 0;
  if (clear) ok(`resolveAnchors honors meta.occupancyPath: crate baked at [${p.join(", ")}], clear of the unlabeled block`);
  else fail(`resolveAnchors occupancy wiring: position=${p ? `[${p.join(", ")}]` : "(none)"} notes=${notes.join(" | ")}`);
}

// 8) THE SCHEMA STRIP REGRESSION (found live in the ramenoccupancy fleet run): meta.occupancyPath
// must SURVIVE appspec zod validation — zod strips unknown keys, so a schema without the field
// silently reverts every 'on' anchor to the blind solve (both pillars baked at the blind pose).
{
  const { metaSchema } = await import("../dist/appspec.js");
  const parsed = metaSchema.safeParse({
    appName: "X", packageName: "com.x.y", stageStyle: "3", brief: "b",
    semanticScenePath: "/tmp/scene.json", occupancyPath: "/tmp/grid.json",
  });
  if (parsed.success && parsed.data.occupancyPath === "/tmp/grid.json")
    ok("meta.occupancyPath survives appspec schema validation");
  else fail(`metaSchema strips occupancyPath: ${parsed.success ? JSON.stringify(parsed.data) : parsed.error}`);
}

// 9) rayOccluded: a ray straight through a wall slab reports occluded with a sensible fraction
{
  const wall = lattice([1.9, 0, 0], [2.1, 2, 4], 0.05);
  const floor = lattice([0, 0, 0], [4, 0.02, 4], 0.04); // thin floor sheet, same room, keeps the grid's bbox room-sized
  // minPointsPerCell pinned: the wall/floor are thin so the mean-density auto-threshold (skewed by
  // edge-cell undercounts) would otherwise punch holes in an otherwise-solid slab.
  const grid = buildOccupancyGrid(concat(wall, floor), { cell: 0.05, minPointsPerCell: 2 });
  const from = [0, 1, 2];
  const to = [4, 1, 2];
  const hit = rayOccluded(grid, from, to);
  if (hit.occluded && hit.fraction !== null && hit.fraction > 0.4 && hit.fraction < 0.6)
    ok(`rayOccluded through the wall: occluded=true fraction=${hit.fraction} (wall sits at ~0.5 along the 4m segment)`);
  else fail(`rayOccluded through-wall: expected occluded~0.5, got ${JSON.stringify(hit)}`);

  // 10) a ray that stays clear of the wall (same grid bbox) reports not occluded
  const clear = rayOccluded(grid, [0, 1, 0.2], [1.5, 1, 0.2]);
  if (!clear.occluded && clear.fraction === null) ok(`rayOccluded clear path: not occluded (${JSON.stringify(clear)})`);
  else fail(`rayOccluded expected clear, got ${JSON.stringify(clear)}`);

  // 11) self-occlusion skip: the ONLY obstruction sits within skipNearM (default 0.25m) of the
  // target endpoint (the target's own volume) — must NOT report occluded
  const selfOccl = rayOccluded(grid, [0, 1, 2], [2.05, 1, 2]); // target sits just inside the wall band
  if (!selfOccl.occluded) ok(`rayOccluded self-occlusion skip: target inside its own near-band -> not occluded (${JSON.stringify(selfOccl)})`);
  else fail(`rayOccluded self-occlusion skip failed: ${JSON.stringify(selfOccl)}`);
}

// 12) anchorTo.visibleFrom SURVIVES appspec objectSchema validation (the v26.2 lesson: zod strips
// unknown keys — any new field needs the schema too)
{
  const { objectSchema } = await import("../dist/appspec.js");
  const parsed = objectSchema.safeParse({
    id: "pillar", sceneId: "bar", source: "primitive",
    anchorTo: { label: "floor", relation: "on", visibleFrom: [0, 1.2, 0] },
  });
  if (parsed.success && Array.isArray(parsed.data.anchorTo?.visibleFrom) && parsed.data.anchorTo.visibleFrom.join(",") === "0,1.2,0")
    ok("anchorTo.visibleFrom survives appspec objectSchema validation");
  else fail(`objectSchema strips anchorTo.visibleFrom: ${parsed.success ? JSON.stringify(parsed.data) : parsed.error}`);
}

// v27.7 regression: captureFrustum is AppSpec data, not an out-of-band solver knob. Zod strips
// unknown fields, so the complete calibration payload (including an explicit threshold) must survive.
{
  const { objectSchema } = await import("../dist/appspec.js");
  const captureFrustum = { f: 1535.4, cx: 1080, cy: 1036, width: 2160, height: 2160, minVisibleFraction: 0.75 };
  const candidate = {
    id: "pillar", sceneId: "bar", source: "primitive",
    anchorTo: { label: "floor", relation: "on", visibleFrom: [0, 1.815, 0], captureFrustum },
  };
  const parsed = objectSchema.safeParse(candidate);
  const got = parsed.success ? parsed.data.anchorTo?.captureFrustum : null;
  const intact = got && Object.entries(captureFrustum).every(([key, value]) => got[key] === value);
  const missingF = objectSchema.safeParse({ ...candidate, anchorTo: { ...candidate.anchorTo, captureFrustum: { cx: 1080, cy: 1036, width: 2160, height: 2160 } } });
  const stringWidth = objectSchema.safeParse({ ...candidate, anchorTo: { ...candidate.anchorTo, captureFrustum: { ...captureFrustum, width: "2160" } } });
  if (intact && !missingF.success && !stringWidth.success)
    ok("anchorTo.captureFrustum survives appspec objectSchema validation intact; malformed shapes are rejected");
  else fail(`objectSchema captureFrustum contract wrong: parsed=${parsed.success ? JSON.stringify(parsed.data) : parsed.error} missingF=${missingF.success} stringWidth=${stringWidth.success}`);
}

// Strictness regressions: these near-miss field names used to be silently stripped by Zod,
// disabling the visual constraint while leaving the AppSpec apparently valid.
{
  const { objectSchema } = await import("../dist/appspec.js");
  const frustum = { f: 100, cx: 50, cy: 50, width: 100, height: 100 };
  const typo = objectSchema.safeParse({
    id: "typo", sceneId: "main", source: "primitive",
    anchorTo: { label: "floor", relation: "on", visibleFrom: [0, 1, 0], captureFrustrum: frustum },
  });
  const namesTypo = !typo.success && typo.error.issues.some((issue) => JSON.stringify(issue).includes("captureFrustrum"));
  if (namesTypo) ok("anchorTo.captureFrustrum typo is rejected instead of silently stripped");
  else fail(`anchorTo.captureFrustrum was not rejected loudly: ${typo.success ? JSON.stringify(typo.data) : typo.error}`);
}

{
  const { objectSchema } = await import("../dist/appspec.js");
  const nestedTypo = objectSchema.safeParse({
    id: "nested-typo", sceneId: "main", source: "primitive",
    anchorTo: {
      label: "floor", relation: "on", visibleFrom: [0, 1, 0],
      captureFrustum: { f: 100, cx: 50, cy: 50, width: 100, height: 100, minVisiblePercent: 75 },
    },
  });
  const namesNestedTypo = !nestedTypo.success && nestedTypo.error.issues.some((issue) => JSON.stringify(issue).includes("minVisiblePercent"));
  if (namesNestedTypo) ok("unknown captureFrustum.minVisiblePercent is rejected instead of silently stripped");
  else fail(`captureFrustum.minVisiblePercent was not rejected loudly: ${nestedTypo.success ? JSON.stringify(nestedTypo.data) : nestedTypo.error}`);
}

// captureFrustum is meaningful ONLY for the affordance relation:'on'. Omitting relation defaults
// to on-top-of, and every other relation bypasses solveFreePlacement, so Zod must reject both loudly.
{
  const { objectSchema, appSpecSchema } = await import("../dist/appspec.js");
  const captureFrustum = { f: 100, cx: 50, cy: 50, width: 100, height: 100 };
  const visibleFrom = [0, 1, 0];
  const omittedRelation = objectSchema.safeParse({
    id: "omitted", sceneId: "main", source: "primitive",
    anchorTo: { label: "floor", visibleFrom, captureFrustum },
  });
  const wholeSpecFor = (relation) => appSpecSchema.safeParse({
    meta: { appName: "Bad Frustum Relation", packageName: "com.test.badfrustumrelation", stageStyle: "3", brief: "test" },
    scenes: [{ id: "main", environment: { kind: "homeEnvProxy" } }],
    objects: [{
      id: "next", sceneId: "main", source: "primitive",
      anchorTo: { label: "marker", relation, visibleFrom, captureFrustum },
    }],
    navigation: { startScene: "main" },
  });
  const nonOnRelations = ["on-top-of", "next-to", "in-front-of"];
  const nonOnResults = nonOnRelations.map((relation) => ({ relation, parsed: wholeSpecFor(relation) }));
  const namesRelationOn = (parsed) =>
    !parsed.success && parsed.error.issues.some((issue) => /\brelation\b/i.test(issue.message) && /\bon\b/i.test(issue.message));
  if (namesRelationOn(omittedRelation) && nonOnResults.every(({ parsed }) => namesRelationOn(parsed)))
    ok("objectSchema and whole AppSpec reject captureFrustum for omitted/on-top-of/next-to/in-front-of relations; only explicit 'on' is valid");
  else fail(`captureFrustum relation guard missing/not loud: omitted=${omittedRelation.success ? "accepted" : omittedRelation.error} nonOn=${nonOnResults.map(({ relation, parsed }) => `${relation}:${parsed.success ? "accepted" : parsed.error}`).join(" | ")}`);
}

function projectedCaptureFraction(center, size, camera, frustum) {
  const us = [];
  const vs = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const d = camera[2] - (center[2] + sz * size[2] / 2);
    if (!(d > 0)) return 0;
    us.push(frustum.cx + frustum.f * (center[0] + sx * size[0] / 2 - camera[0]) / d);
    vs.push(frustum.cy - frustum.f * (center[1] + sy * size[1] / 2 - camera[1]) / d);
  }
  const minU = Math.min(...us), maxU = Math.max(...us);
  const minV = Math.min(...vs), maxV = Math.max(...vs);
  const fullArea = (maxU - minU) * (maxV - minV);
  const clippedW = Math.max(0, Math.min(frustum.width, maxU) - Math.max(0, minU));
  const clippedH = Math.max(0, Math.min(frustum.height, maxV) - Math.max(0, minV));
  return fullArea > 0 ? clippedW * clippedH / fullArea : 0;
}

// v27.7 end-to-end: parse a WHOLE AppSpec, then resolve its anchor. The blind central pose is
// completely outside this synthetic camera; captureFrustum must survive parsing, flow through
// resolveAnchors, and bake a different pose whose projected child bbox is at least 50% in-frame.
{
  const { appSpecSchema } = await import("../dist/appspec.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-capture-frustum-"));
  const scenePath = path.join(dir, "scene.json");
  fs.writeFileSync(scenePath, JSON.stringify({
    objects: [{ id: 1, label: "high marker", center: [-1.8, 2.6, -3.8], size: [0.1, 0.1, 0.1] }],
    floorY: 0,
    bounds: { min: [-2, 0, -4], max: [2, 3, -2] },
  }));
  const camera = [2, 1, 0];
  const frustum = { f: 100, cx: 50, cy: 50, width: 100, height: 100 };
  const makeSpec = (anchorTo) => appSpecSchema.parse({
    meta: { appName: "Capture Frustum", packageName: "com.test.capturefrustum", stageStyle: "3", brief: "test", semanticScenePath: scenePath },
    scenes: [{ id: "main", environment: { kind: "homeEnvProxy" } }],
    objects: [{
      id: "crate", sceneId: "main", source: "primitive",
      body: { mode: "static", shape: "box", dims: [0.2, 0.2, 0.2] },
      anchorTo,
    }],
    navigation: { startScene: "main" },
  });
  const blind = resolveAnchors(makeSpec({ label: "floor", relation: "on", clearance: 0 }));
  const throughSchema = makeSpec({ label: "floor", relation: "on", clearance: 0, visibleFrom: camera, captureFrustum: frustum });
  const framed = resolveAnchors(throughSchema);
  let missingCameraClosed = false;
  let missingCameraDetail = "";
  try {
    const missingCamera = resolveAnchors(makeSpec({ label: "floor", relation: "on", clearance: 0, captureFrustum: frustum }));
    const missingP = missingCamera.spec.objects[0].transform?.position;
    missingCameraDetail = `position=${missingP} notes=${missingCamera.notes.join(" | ")}`;
    missingCameraClosed = !missingP && missingCamera.notes.some((n) => /capture.?frustum/i.test(n) && /visibleFrom/i.test(n));
  } catch (error) {
    // A cross-field Zod rejection is also a valid fail-closed AppSpec contract, provided it names
    // the conflicting fields rather than surfacing an unrelated parse error.
    missingCameraDetail = String(error);
    missingCameraClosed = /capture.?frustum/i.test(missingCameraDetail) && /visibleFrom/i.test(missingCameraDetail);
  }
  const blindP = blind.spec.objects[0].transform?.position;
  const framedP = framed.spec.objects[0].transform?.position;
  const visibleFraction = framedP ? projectedCaptureFraction(framedP, [0.2, 0.2, 0.2], camera, frustum) : 0;
  const parsedFrustum = throughSchema.objects[0].anchorTo?.captureFrustum;
  const survived = parsedFrustum && Object.entries(frustum).every(([key, value]) => parsedFrustum[key] === value);
  const changed = blindP && framedP && blindP.join(",") !== framedP.join(",");
  if (survived && blindP?.join(",") === "0,0.1,-3" && changed && visibleFraction >= 0.5 - 1e-9 && framed.notes.some((n) => /frustum/i.test(n)) && missingCameraClosed)
    ok(`AppSpec -> zod -> resolveAnchors bakes an in-frame pose [${framedP.join(", ")}] (${(100 * visibleFraction).toFixed(1)}% visible) instead of blind [${blindP.join(", ")}]`);
  else fail(`captureFrustum AppSpec flow failed: survived=${survived} blind=${blindP} framed=${framedP} visibleFraction=${visibleFraction} notes=${framed.notes.join(" | ")} missingCamera={${missingCameraDetail}}`);
}

// OFFSET REGRESSION: resolveAnchors used to validate the solver pose, then add anchorTo.offset
// afterward without re-checking. A large offset must not bake a final transform outside the frame.
{
  const { appSpecSchema } = await import("../dist/appspec.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-capture-offset-"));
  const scenePath = path.join(dir, "scene.json");
  fs.writeFileSync(scenePath, JSON.stringify({
    objects: [{ id: 1, label: "marker", center: [-1.8, 2.6, -3.8], size: [0.1, 0.1, 0.1] }],
    floorY: 0,
    bounds: { min: [-2, 0, -4], max: [2, 3, -2] },
  }));
  const camera = [2, 1, 0];
  const frustum = { f: 100, cx: 50, cy: 50, width: 100, height: 100 };
  const makeSpec = (offset) => appSpecSchema.parse({
    meta: { appName: "Capture Offset", packageName: "com.test.captureoffset", stageStyle: "3", brief: "test", semanticScenePath: scenePath },
    scenes: [{ id: "main", environment: { kind: "homeEnvProxy" } }],
    objects: [{
      id: "crate", sceneId: "main", source: "primitive",
      body: { mode: "static", shape: "box", dims: [0.2, 0.2, 0.2] },
      anchorTo: { label: "floor", relation: "on", clearance: 0, visibleFrom: camera, captureFrustum: frustum, ...(offset ? { offset } : {}) },
    }],
    navigation: { startScene: "main" },
  });
  const baseline = resolveAnchors(makeSpec(null));
  const inFrameOffset = resolveAnchors(makeSpec([0.1, 0, 0]));
  const shifted = resolveAnchors(makeSpec([10, 0, 0]));
  const baselineP = baseline.spec.objects[0].transform?.position;
  const inFrameP = inFrameOffset.spec.objects[0].transform?.position;
  const shiftedP = shifted.spec.objects[0].transform?.position;
  const baselineFraction = baselineP ? projectedCaptureFraction(baselineP, [0.2, 0.2, 0.2], camera, frustum) : 0;
  const inFrameFraction = inFrameP ? projectedCaptureFraction(inFrameP, [0.2, 0.2, 0.2], camera, frustum) : 0;
  const shiftedFraction = shiftedP ? projectedCaptureFraction(shiftedP, [0.2, 0.2, 0.2], camera, frustum) : 0;
  const loudClosedNote = shifted.notes.some((note) => /frustum/i.test(note) && /offset/i.test(note));
  const smallOffset = [0.1, 0, 0];
  const validOffsetApplied =
    baselineP && inFrameP &&
    inFrameP.every((value, i) => Math.abs(value - (baselineP[i] + smallOffset[i])) < 1e-9) &&
    inFrameFraction >= 0.5 - 1e-12;
  const invalidHasNoTransform = !shifted.spec.objects[0].transform;
  if (baselineP && baselineFraction >= 0.5 - 1e-12 && validOffsetApplied && invalidHasNoTransform && loudClosedNote)
    ok(`resolveAnchors validates the FINAL offset pose: +0.1m bakes at ${(100 * inFrameFraction).toFixed(1)}% visible; +10m fails closed with no transform`);
  else fail(`offset final-pose validation wrong: baseline=${baselineP}@${baselineFraction} inFrame=${inFrameP}@${inFrameFraction} shifted=${shiftedP}@${shiftedFraction} shiftedTransform=${JSON.stringify(shifted.spec.objects[0].transform)} notes=${shifted.notes.join(" | ")}`);
}

// 13) the REAL ramen scan: the ledgered unlabeled-counter finding, closed
const PLY = `${process.env.HOME}/Marble Worlds/Ramen World/Cozy Neon Cyberpunk Ramen Bar.ply`;
const SCENE = `${process.env.HOME}/.pico-mcp/artifacts/ramen-v19-semantic-app.json`;
if (fs.existsSync(PLY) && fs.existsSync(SCENE)) {
  const { pos, total } = loadSplatPositions(PLY, 400000);
  const grid = buildOccupancyGrid(pos, { cell: 0.06, liftFloorToZero: true });
  const scene = JSON.parse(fs.readFileSync(SCENE, "utf8"));
  const q = { on: "floor", childSize: [0.4, 0.5, 0.4], clearance: 0.15 };
  const blind = solveFreePlacement(scene, q);
  const seeing = solveFreePlacement(scene, q, grid);
  const liftOk = Math.abs(grid.offsetApplied[1] - 0.776) < 0.08; // scan.floorY = -0.776
  const spotClear =
    seeing.status === "ok" &&
    boxOccupied(grid,
      [seeing.position[0] - 0.2, 0.12, seeing.position[2] - 0.2],
      [seeing.position[0] + 0.2, 0.5, seeing.position[2] + 0.2]).occupied === 0;
  const blindSpot = blind.status === "ok"
    ? boxOccupied(grid, [blind.position[0] - 0.2, 0.12, blind.position[2] - 0.2], [blind.position[0] + 0.2, 0.5, blind.position[2] + 0.2])
    : null;
  if (grid.occupiedCells > 500 && liftOk && spotClear)
    ok(`REAL ramen (${total} pts): lift ${grid.offsetApplied[1].toFixed(3)}m, ${grid.occupiedCells} occupied cells; occupancy-aware floor spot [${seeing.position.join(", ")}] verified clear${blindSpot && blindSpot.occupied > 0 ? `; blind spot [${blind.position.join(", ")}] WAS occluded (${blindSpot.occupied} cells) — counter finding reproduced` : ""}`);
  else fail(`real ramen: occ=${grid.occupiedCells} lift=${grid.offsetApplied?.[1]} seeing=${seeing.status}@${seeing.position} clear=${spotClear} ${seeing.note ?? ""}`);
} else {
  console.log("  skip real ramen splat not on this machine — real-world asserts skipped");
}


// 13) v27.3 e2e: anchorTo.visibleFrom flows THROUGH resolveAnchors and changes the baked pose
// (a wall of geometry between the viewer and half the floor: without visibleFrom the solver may
// pick either side; with it, the baked position's ray from the viewer must be CLEAR).
{
  const { rayOccluded } = await import("../dist/occupancy.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-los-"));
  const scenePath = path.join(dir, "scene.json");
  fs.writeFileSync(scenePath, JSON.stringify({ objects: [{ id: 1, label: "plant", center: [0.3, 0.15, 3.7], size: [0.2, 0.3, 0.2] }], floorY: 0, bounds: { min: [0, 0, 0], max: [4, 3, 4] } }));
  // a dense wall slab across the middle: x 0..4, y 0..1.2, z 1.9..2.1 — the far half is hidden from the near viewer
  const grid = buildOccupancyGrid(lattice([0, 0, 1.9], [4, 1.2, 2.1], 0.02), { cell: 0.05, minPointsPerCell: 2 });
  const gridPath = path.join(dir, "grid.json");
  saveOccupancyGrid(grid, gridPath);
  const viewer = [2, 1.1, 0.2];
  const spec = {
    meta: { semanticScenePath: scenePath, occupancyPath: gridPath },
    objects: [{ id: "crate", body: { shape: "box", dims: [0.4, 0.4, 0.4] }, anchorTo: { label: "floor", relation: "on", clearance: 0.05, visibleFrom: viewer } }],
  };
  const { spec: out, notes } = resolveAnchors(spec);
  const p = out.objects[0].transform?.position;
  const clear = p && !rayOccluded(grid, viewer, [p[0], 0.2, p[2]]).occluded;
  if (p && clear) ok(`resolveAnchors honors anchorTo.visibleFrom: crate baked at [${p.join(", ")}], ray from viewer CLEAR`);
  else fail(`resolveAnchors LOS wiring: position=${p ? `[${p.join(", ")}]` : "(none)"} clear=${clear} notes=${notes.join(" | ")}`);
}

// 14) v27.3 honesty: visibleFrom WITHOUT an occupancy grid must WARN loudly, not silently skip
{
  const { solveFreePlacement } = await import("../dist/affordance.js");
  const scene = { objects: [{ id: 1, label: "plant", center: [0.3, 0.15, 3.7], size: [0.2, 0.3, 0.2] }], floorY: 0, bounds: { min: [0, 0, 0], max: [4, 3, 4] } };
  const r = solveFreePlacement(scene, { on: "floor", childSize: [0.4, 0.4, 0.4], visibleFrom: [2, 1.1, 0.2] }, null);
  if (/WARNING: visibleFrom was set but NO occupancy grid/.test(r.note ?? "")) ok("visibleFrom without a grid warns loudly in the note");
  else fail(`missing loud warning — note: ${(r.note ?? "").slice(0, 200)}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall occupancy asserts passed");
process.exit(failures ? 1 : 0);
