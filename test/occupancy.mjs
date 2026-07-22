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

// 13) the REAL ramen scan: the ledgered unlabeled-counter finding, closed
const PLY = "/Users/sushantsrikrish/Marble Worlds/Ramen World/Cozy Neon Cyberpunk Ramen Bar.ply";
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

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall occupancy asserts passed");
process.exit(failures ? 1 : 0);
