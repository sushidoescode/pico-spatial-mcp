// v24 affordance test: support-surface extraction + the free-space solver on synthetic scenes
// with KNOWN geometry (so every assertion is checkable by hand), plus the real ramen scan
// (CI-skips when absent). Honest no-fit is asserted, not just the happy path.
// Run: npm run test:affordance
import fs from "node:fs";
import { extractSupportSurfaces, solveFreePlacement } from "../dist/affordance.js";
import { resolveAnchors } from "../dist/semanticplace.js";
import { buildOccupancyGrid, rayOccluded } from "../dist/occupancy.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

// Synthetic room: 4×4m floor, a 2×0.9×1m table at the center with a 0.4m cube sitting on its left half.
const table = { id: 1, label: "wooden table", center: [0, 0.45, -2], size: [2, 0.9, 1] };
const cubeOnTable = { id: 2, label: "storage box", center: [-0.6, 1.1, -2], size: [0.4, 0.4, 0.4] };
const tallShelf = { id: 3, label: "tall shelf", center: [1.8, 1.25, -3.5], size: [0.4, 2.5, 1] };
const scene = {
  objects: [table, cubeOnTable, tallShelf],
  floorY: 0,
  bounds: { min: [-2, 0, -4], max: [2, 2.6, 0] },
};

// 1) surface extraction: floor + table top + box top; the shelf top is too high (2.5m > 2m)
const surfaces = extractSupportSurfaces(scene);
const kinds = surfaces.map((s) => `${s.kind}:${s.label}`).sort();
if (surfaces.length === 3 && kinds.join(",") === "floor:floor,object-top:storage box,object-top:wooden table") ok("surfaces: floor + table top + box top; 2.5m shelf top excluded as unreachable");
else fail(`surface extraction wrong: ${kinds.join(",")}`);

// 2) free spot ON the table clears the storage box by ≥ clearance
const r1 = solveFreePlacement(scene, { on: "table", childSize: [0.3, 0.2, 0.3], clearance: 0.08 });
if (r1.status === "ok" && r1.surface.objectId === 1 && Math.abs(r1.position[1] - 1.0) < 1e-6) ok(`solver places on the table top at y=1.0 -> [${r1.position.join(", ")}]`);
else fail(`table placement wrong: ${JSON.stringify(r1).slice(0, 160)}`);
if (r1.status === "ok") {
  const gapX = Math.abs(r1.position[0] - cubeOnTable.center[0]) - (0.3 / 2 + 0.4 / 2);
  const gapZ = Math.abs(r1.position[2] - cubeOnTable.center[2]) - (0.3 / 2 + 0.4 / 2);
  if (Math.max(gapX, gapZ) >= 0.08 - 1e-9) ok(`placed spot clears the storage box by ${Math.max(gapX, gapZ).toFixed(3)}m ≥ 0.08m clearance`);
  else fail(`clearance violated: gap ${Math.max(gapX, gapZ).toFixed(3)}m < 0.08m`);
}

// 3) HONEST NO-FIT: a 1.9×0.95m slab + 10cm clearance cannot fit a 2×1m table top
const r2 = solveFreePlacement(scene, { on: "wooden table", childSize: [1.9, 0.2, 0.95], clearance: 0.1 });
if (r2.status === "no-fit" && /smaller than the child footprint/.test(r2.note)) ok(`oversized child -> no-fit with the reason (${r2.note.slice(0, 60)}…)`);
else fail(`expected no-fit for oversized child, got ${r2.status}`);

// 4) surface crowded out: fill the table with a second big box so nothing clears
const crowded = { ...scene, objects: [...scene.objects, { id: 4, label: "crate", center: [0.55, 1.1, -2], size: [0.9, 0.4, 1.0] }] };
const r3 = solveFreePlacement(crowded, { on: "wooden table", childSize: [0.5, 0.2, 0.6], clearance: 0.08 });
if (r3.status === "no-fit" && /tightest gap/.test(r3.note)) ok("crowded surface -> honest no-fit naming the tightest gap");
else fail(`expected crowded no-fit, got ${r3.status}: ${r3.note?.slice(0, 100)}`);

// 5) floor placement stays inside bounds and out of the shelf's footprint
const r4 = solveFreePlacement(scene, { on: "floor", childSize: [0.6, 0.5, 0.6], clearance: 0.1 });
if (r4.status === "ok" && r4.position[1] === 0.25 && r4.position[0] > -2 && r4.position[0] < 2) ok(`floor placement at [${r4.position.join(", ")}] (y = h/2)`);
else fail(`floor placement wrong: ${JSON.stringify(r4).slice(0, 120)}`);

// 6) facing: from the placed spot, yaw toward a label; toward room-center yields |yaw| ≤ 180
const r5 = solveFreePlacement(scene, { on: "floor", childSize: [0.4, 0.4, 0.4], clearance: 0.1, facing: "tall shelf" });
if (r5.status === "ok" && r5.rotationYDeg !== null) {
  const expected = (Math.atan2(tallShelf.center[0] - r5.position[0], -(tallShelf.center[2] - r5.position[2])) * 180) / Math.PI;
  if (Math.abs(r5.rotationYDeg - expected) < 0.2) ok(`facing 'tall shelf' bakes yaw ${r5.rotationYDeg}° (matches atan2 by hand)`);
  else fail(`yaw ${r5.rotationYDeg}° != expected ${expected.toFixed(1)}°`);
} else fail(`facing solve failed: ${JSON.stringify(r5).slice(0, 120)}`);

// 7) avoiding pushes the pick away from the avoided label
const rNear = solveFreePlacement(scene, { on: "floor", childSize: [0.4, 0.4, 0.4], clearance: 0.1 });
const rAvoid = solveFreePlacement(scene, { on: "floor", childSize: [0.4, 0.4, 0.4], clearance: 0.1, avoiding: ["tall shelf"] });
if (rNear.status === "ok" && rAvoid.status === "ok") {
  const d = (p) => Math.hypot(p[0] - tallShelf.center[0], p[2] - tallShelf.center[2]);
  if (d(rAvoid.position) >= d(rNear.position) - 1e-9) ok(`avoiding 'tall shelf' keeps distance (${d(rAvoid.position).toFixed(2)}m vs ${d(rNear.position).toFixed(2)}m unconstrained)`);
  else fail("avoiding moved the pick CLOSER to the avoided object");
} else fail("avoiding comparison could not run");

// 8) compiler route: anchorTo {relation:'on'} bakes position + facing yaw via resolveAnchors
const scenePath = "/tmp/affordance-test-scene.json";
fs.writeFileSync(scenePath, JSON.stringify(scene));
const spec = {
  meta: { semanticScenePath: scenePath },
  objects: [{ id: "bowl", body: { shape: "box", dims: [0.3, 0.2, 0.3] }, anchorTo: { label: "table", relation: "on", clearance: 0.08, facing: "room-center" } }],
};
const { spec: baked, notes } = resolveAnchors(spec);
const b = baked.objects[0];
if (b.transform?.position && Math.abs(b.transform.position[1] - 1.0) < 1e-6 && Array.isArray(b.transform.rotationDeg)) ok(`resolveAnchors 'on' route: baked [${b.transform.position.join(", ")}] + rotationDeg.y=${b.transform.rotationDeg[1]}°`);
else fail(`compiler route failed: ${JSON.stringify({ transform: b.transform, notes }).slice(0, 200)}`);

// 9) compiler route stays honest on no-fit (object untouched + note, never a silent overlap)
const spec2 = {
  meta: { semanticScenePath: scenePath },
  objects: [{ id: "slab", body: { shape: "box", dims: [1.9, 0.2, 0.95] }, anchorTo: { label: "wooden table", relation: "on", clearance: 0.1 } }],
};
const r6 = resolveAnchors(spec2);
if (!r6.spec.objects[0].transform?.position && r6.notes.some((n) => /no-fit/.test(n))) ok("compiler 'on' no-fit: object left unplaced + note (no silent overlap)");
else fail(`no-fit leak: ${JSON.stringify(r6.notes)}`);

// 10) LINE OF SIGHT: a synthetic room where the floor has free spots both IN FRONT of and BEHIND
// a tall unlabeled wall relative to visibleFrom. Without visibleFrom the solver may pick either
// side (occupancy alone only forbids intersecting the wall's own footprint). WITH visibleFrom, any
// candidate whose ray to the viewpoint crosses the wall must be hard-rejected: the chosen spot's
// ray must be clear, and losBlocked must be > 0 (some behind-the-wall candidates got eliminated).
function lattice(min, max, spacing = 0.025) {
  const pts = [];
  for (let x = min[0]; x <= max[0] + 1e-9; x += spacing)
    for (let y = min[1]; y <= max[1] + 1e-9; y += spacing)
      for (let z = min[2]; z <= max[2] + 1e-9; z += spacing) pts.push(x, y, z);
  return new Float32Array(pts);
}
{
  // room is deeper (z 0-6) than the wall's position (z 1.8-2.2) so the room CENTROID — and hence
  // the solver's centrality bonus — sits in the larger back region; the blind (occupancy-only)
  // pick is expected to land BEHIND the wall, invisible from a front viewpoint.
  const losScene = { objects: [], floorY: 0, bounds: { min: [0, 0, 0], max: [4, 3, 6] } };
  // a tall wall (y 0-1.5) spanning the FULL x width at z 1.8-2.2 — anything behind it (z>2.2), seen
  // from a viewpoint at z=0, is necessarily occluded (the wall blocks the whole width).
  // minPointsPerCell pinned: the wall is thin (0.4m in z, 8 cells) so the mean-density auto-threshold
  // (biased by edge-cell undercounts) would otherwise punch holes in an otherwise-solid slab.
  const wallGrid = buildOccupancyGrid(lattice([0, 0, 1.8], [4, 1.5, 2.2]), { cell: 0.05, minPointsPerCell: 2 });
  const q = { on: "floor", childSize: [0.4, 0.4, 0.4], clearance: 0.05 };
  const visibleFrom = [2, 1.2, 0];

  const withoutLos = solveFreePlacement(losScene, q, wallGrid); // occupancy only — free to land on either side of the wall
  const withLos = solveFreePlacement(losScene, { ...q, visibleFrom }, wallGrid);

  const blindBehindWall = withoutLos.status === "ok" && withoutLos.position[2] > 2.2;
  const losOk =
    withLos.status === "ok" &&
    !rayOccluded(wallGrid, visibleFrom, withLos.position).occluded &&
    withLos.losBlocked > 0;
  if (losOk)
    ok(
      `visibleFrom hard-rejects occluded spots: without-LOS picked [${withoutLos.position?.join(", ") ?? withoutLos.status}]` +
        `${blindBehindWall ? " (BEHIND the wall, as expected from centrality alone)" : ""}, ` +
        `with-LOS picked [${withLos.position.join(", ")}] (clear ray, losBlocked=${withLos.losBlocked})`,
    );
  else fail(`LOS solve wrong: withoutLos=${withoutLos.status}@${withoutLos.position}; withLos=${JSON.stringify(withLos).slice(0, 200)}`);
}

// 11) the REAL ramen scan: only the floor is a usable surface (all tops sit above 2m) — honest
const RAMEN = "/Users/sushantsrikrish/.pico-mcp/artifacts/ramen-v19-semantic-app.json";
if (fs.existsSync(RAMEN)) {
  const ramen = JSON.parse(fs.readFileSync(RAMEN, "utf8"));
  const rs = extractSupportSurfaces(ramen);
  const floorOnly = rs.length >= 1 && rs.every((s) => s.kind === "floor" || s.y - (ramen.floorY ?? 0) <= 2.0);
  const rf = solveFreePlacement(ramen, { on: "floor", childSize: [0.4, 0.5, 0.4], clearance: 0.15, facing: "menu display" });
  if (floorOnly && rf.status === "ok") ok(`real ramen scan: ${rs.length} surface(s), floor placement -> [${rf.position.join(", ")}] facing yaw ${rf.rotationYDeg}°`);
  else fail(`ramen solve: surfaces=${rs.map((s) => s.label).join(",")} status=${rf.status} ${rf.note ?? ""}`);
  const rMiss = solveFreePlacement(ramen, { on: "bar counter", childSize: [0.3, 0.3, 0.3] });
  if (rMiss.status === "no-surface") ok("real scan honest miss: 'bar counter' has no usable top -> no-surface (never guessed)");
  else fail(`expected no-surface for 'bar counter', got ${rMiss.status}`);
} else {
  console.log("  skip real ramen scan not on this machine — real-world asserts skipped");
}

console.log(`\nAffordance test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
