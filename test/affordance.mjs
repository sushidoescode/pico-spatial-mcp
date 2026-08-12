// v24 affordance test: support-surface extraction + the free-space solver on synthetic scenes
// with KNOWN geometry (so every assertion is checkable by hand), plus the real ramen scan
// (CI-skips when absent). Honest no-fit is asserted, not just the happy path.
// Run: npm run test:affordance
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extractSupportSurfaces, registerAffordanceTools, solveFreePlacement } from "../dist/affordance.js";
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

// v27.7 capture-frustum oracle: project all 8 CHILD-AABB corners through the fixed -Z camera,
// then measure how much of the projected bbox survives clipping to the capture frame.
function captureVisibility(center, size, camera, frustum) {
  const us = [];
  const vs = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = center[0] + sx * size[0] / 2;
        const y = center[1] + sy * size[1] / 2;
        const z = center[2] + sz * size[2] / 2;
        const d = camera[2] - z;
        if (!(d > 0)) return { allCornersInFront: false, visibleFraction: 0 };
        us.push(frustum.cx + frustum.f * (x - camera[0]) / d);
        vs.push(frustum.cy - frustum.f * (y - camera[1]) / d);
      }
    }
  }
  const minU = Math.min(...us), maxU = Math.max(...us);
  const minV = Math.min(...vs), maxV = Math.max(...vs);
  const fullArea = (maxU - minU) * (maxV - minV);
  const clippedW = Math.max(0, Math.min(frustum.width, maxU) - Math.max(0, minU));
  const clippedH = Math.max(0, Math.min(frustum.height, maxV) - Math.max(0, minV));
  return { allCornersInFront: true, visibleFraction: fullArea > 0 ? clippedW * clippedH / fullArea : 0 };
}

const captureScene = { objects: [], floorY: 0, bounds: { min: [-2, 0, -4], max: [2, 3, -2] } };
const captureChild = [0.2, 0.2, 0.2];
const captureCamera = [2, 1, 0];
const captureFrustum = { f: 100, cx: 50, cy: 50, width: 100, height: 100 }; // default minVisibleFraction = 0.5
const captureQuery = { on: "floor", childSize: captureChild, clearance: 0 };
const captureBlind = solveFreePlacement(captureScene, captureQuery);
const captureViewOnly = solveFreePlacement(captureScene, { ...captureQuery, visibleFrom: captureCamera });
const captureConstrained = solveFreePlacement(captureScene, {
  ...captureQuery,
  visibleFrom: captureCamera,
  captureFrustum,
});

// 11) Happy path + backward invariant: without captureFrustum the historical center pick stays
// [0,0.1,-3]; with it, that fully off-frame pick is rejected and an at-least-half-visible pose wins.
{
  const vis = captureConstrained.status === "ok"
    ? captureVisibility(captureConstrained.position, captureChild, captureCamera, captureFrustum)
    : { allCornersInFront: false, visibleFraction: 0 };
  const baselineUnchanged =
    captureBlind.status === "ok" &&
    captureBlind.position.join(",") === "0,0.1,-3" &&
    captureViewOnly.status === "ok" &&
    captureViewOnly.position.join(",") === captureBlind.position.join(",");
  const counterInNote =
    captureConstrained.status === "ok" &&
    Number.isInteger(captureConstrained.frustumBlocked) &&
    captureConstrained.frustumBlocked > 0 &&
    /frustum/i.test(captureConstrained.note ?? "") &&
    (captureConstrained.note ?? "").includes(String(captureConstrained.frustumBlocked));
  if (
    baselineUnchanged &&
    captureConstrained.status === "ok" &&
    captureConstrained.position.join(",") !== captureBlind.position.join(",") &&
    vis.allCornersInFront &&
    vis.visibleFraction >= 0.5 - 1e-9 &&
    counterInNote
  ) ok(`captureFrustum moves the blind pose into frame (${(100 * vis.visibleFraction).toFixed(1)}% bbox visible; ${captureConstrained.frustumBlocked} rejected), while both plain and visibleFrom-only solves preserve [${captureBlind.position.join(", ")}]`);
  else fail(`captureFrustum default-0.5 solve: blind=${JSON.stringify(captureBlind)} viewOnly=${JSON.stringify(captureViewOnly)} constrained=${JSON.stringify(captureConstrained)} visibleFraction=${vis.visibleFraction}`);
}

// 12) Default discriminator: omitting minVisibleFraction must behave exactly like an explicit 0.5
// for single candidates immediately on either side of 50% projected-bbox visibility.
{
  const oneScene = { objects: [], floorY: 0, bounds: { min: [-1.1, 0, -2.1], max: [-0.9, 3, -1.9] } };
  const child = [0.2, 0.2, 0.2];
  const camera = [0, 0.1, 0];
  // cx is chosen so the one candidate at [-1,0.1,-2] is infinitesimally over 50%; shifting cx
  // left by 0.001px makes the otherwise-identical projection just under 50%.
  const halfFrustum = { f: 100, cx: 50.37593985062406, cy: 50, width: 100, height: 100 };
  const belowFrustum = { ...halfFrustum, cx: halfFrustum.cx - 0.001 };
  const center = [-1, 0.1, -2];
  const halfFraction = captureVisibility(center, child, camera, halfFrustum).visibleFraction;
  const belowFraction = captureVisibility(center, child, camera, belowFrustum).visibleFraction;
  const omittedHalf = solveFreePlacement(oneScene, { on: "floor", childSize: child, clearance: 0, visibleFrom: camera, captureFrustum: halfFrustum });
  const explicitHalf = solveFreePlacement(oneScene, { on: "floor", childSize: child, clearance: 0, visibleFrom: camera, captureFrustum: { ...halfFrustum, minVisibleFraction: 0.5 } });
  const omittedBelow = solveFreePlacement(oneScene, { on: "floor", childSize: child, clearance: 0, visibleFrom: camera, captureFrustum: belowFrustum });
  const explicitBelow = solveFreePlacement(oneScene, { on: "floor", childSize: child, clearance: 0, visibleFrom: camera, captureFrustum: { ...belowFrustum, minVisibleFraction: 0.5 } });
  const fixtureStraddlesHalf = halfFraction >= 0.5 && halfFraction < 0.50000001 && belowFraction < 0.5 && belowFraction > 0.499;
  if (
    fixtureStraddlesHalf &&
    omittedHalf.status === "ok" && explicitHalf.status === "ok" &&
    omittedHalf.frustumBlocked === 0 && explicitHalf.frustumBlocked === 0 &&
    omittedBelow.status === "no-fit" && explicitBelow.status === "no-fit" &&
    omittedBelow.frustumBlocked === 1 && explicitBelow.frustumBlocked === 1
  ) ok(`omitted minVisibleFraction matches explicit 0.5 (${halfFraction} accepted; ${belowFraction} rejected)`);
  else fail(`minVisibleFraction default is not 0.5: fractions=${halfFraction}/${belowFraction} omitted=${omittedHalf.status}/${omittedBelow.status} explicit=${explicitHalf.status}/${explicitBelow.status}`);
}

// 13) Property/invariant: every pose the solver offers (winner AND alternatives) satisfies the
// same 8-corner projected-bbox visibility threshold; an off-frame alternative is not a valid answer.
{
  const offered = captureConstrained.status === "ok"
    ? [captureConstrained.position, ...(captureConstrained.alternatives ?? [])]
    : [];
  const fractions = offered.map((p) => captureVisibility(p, captureChild, captureCamera, captureFrustum));
  if (offered.length > 1 && fractions.every((v) => v.allCornersInFront && v.visibleFraction >= 0.5 - 1e-9))
    ok(`captureFrustum invariant: all ${offered.length} offered poses are at least 50% visible`);
  else fail(`captureFrustum leaked an invalid offered pose: ${JSON.stringify(offered.map((p, i) => ({ p, ...fractions[i] })))}`);
}

// 14) Boundary: a single candidate whose projected bbox is clipped to EXACTLY T of its full area
// is accepted at minVisibleFraction=T, but rejected when the requested threshold is even 1e-6 higher.
{
  const oneScene = { objects: [], floorY: 0, bounds: { min: [-1.1, 0, -2.1], max: [-0.9, 3, -1.9] } };
  const child = [0.2, 0.2, 0.2];
  const camera = [0, 0.1, 0];
  const frustum = { f: 100, cx: 50, cy: 50, width: 100, height: 100 };
  const center = [-1, 0.1, -2];
  const threshold = captureVisibility(center, child, camera, frustum).visibleFraction;
  const atThreshold = solveFreePlacement(oneScene, { on: "floor", childSize: child, clearance: 0, visibleFrom: camera, captureFrustum: { ...frustum, minVisibleFraction: threshold } });
  const aboveThreshold = solveFreePlacement(oneScene, { on: "floor", childSize: child, clearance: 0, visibleFrom: camera, captureFrustum: { ...frustum, minVisibleFraction: threshold + 1e-6 } });
  const reportsBoundary =
    atThreshold.status === "ok" &&
    atThreshold.frustumBlocked === 0 &&
    /frustum/i.test(atThreshold.note ?? "") &&
    aboveThreshold.status === "no-fit" &&
    aboveThreshold.frustumBlocked === 1 &&
    /frustum/i.test(aboveThreshold.note ?? "");
  if (reportsBoundary) ok(`minVisibleFraction boundary is inclusive at ${(100 * threshold).toFixed(3)}%, exclusive 1e-6 above it`);
  else fail(`minVisibleFraction boundary wrong: T=${threshold} at=${JSON.stringify(atThreshold)} above=${JSON.stringify(aboveThreshold)}`);
}

// 15) ROUNDING REGRESSION: constraints apply to the 3-decimal poses callers actually receive, not
// hidden raw lattice coordinates. Exercise the exact reviewer repro as both winner and alternative.
{
  const child = [0.2, 0.2, 0.2];
  const camera = [0, 0.1, 0];
  const baseFrustum = { f: 100, cx: 50, cy: 50, width: 100, height: 100 };
  const rawBoundary = [1.0006, 0.1, -2];
  const roundedBoundary = [1.001, 0.1, -2];
  const threshold = captureVisibility(rawBoundary, child, camera, baseFrustum).visibleFraction;
  const roundedFraction = captureVisibility(roundedBoundary, child, camera, baseFrustum).visibleFraction;
  const query = {
    on: "floor", childSize: child, clearance: 0, visibleFrom: camera,
    captureFrustum: { ...baseFrustum, minVisibleFraction: threshold },
  };
  const asWinner = solveFreePlacement({ objects: [], floorY: 0, bounds: { min: [0.9006, 0, -2.1], max: [1.1006, 3, -1.9] } }, query);
  const asAlternative = solveFreePlacement({ objects: [], floorY: 0, bounds: { min: [0.8006, 0, -2.1], max: [1.1006, 3, -1.9] } }, query);
  const alternativeOffers = asAlternative.status === "ok" ? [asAlternative.position, ...(asAlternative.alternatives ?? [])] : [];
  const alternativeFractions = alternativeOffers.map((p) => captureVisibility(p, child, camera, baseFrustum).visibleFraction);
  const fixtureCrossesThreshold = threshold > roundedFraction && threshold - roundedFraction > 0.001;
  if (
    fixtureCrossesThreshold &&
    asWinner.status === "no-fit" && /frustum/i.test(asWinner.note ?? "") &&
    asAlternative.status === "ok" && alternativeOffers.length > 0 &&
    alternativeFractions.every((fraction) => fraction + 1e-12 >= threshold) &&
    /frustum/i.test(asAlternative.note ?? "")
  ) ok(`rounded-pose invariant: raw ${(100 * threshold).toFixed(4)}% candidate is never emitted at ${(100 * roundedFraction).toFixed(4)}%; all winner/alternative outputs meet threshold`);
  else fail(`rounded-pose leak: threshold=${threshold} rounded=${roundedFraction} winner=${JSON.stringify(asWinner)} alternatives=${JSON.stringify(alternativeOffers.map((p, i) => ({ p, fraction: alternativeFractions[i] })))}`);
}

// 16) Exercise the OTHER two frame edges with a non-canonical calibration and a camera translated
// on every axis. Each axis alone is >50% visible; their clipped AREA product decides.
{
  const shiftedScene = { objects: [], floorY: 0, bounds: { min: [-0.11, 0, 2.89], max: [0.11, 3, 3.11] } };
  const child = [0.2, 0.2, 0.2];
  const center = [-0.01, 0.1, 2.99]; // the single grid candidate in shiftedScene
  const frustum = { f: 137, cx: 31, cy: 25, width: 137, height: 83 };
  const acceptedCamera = [-1.5, 0.85, 5];
  const rejectedCamera = [-1.5, 0.9, 5];
  const aboveFrameCamera = [0, -0.5, 5];
  const acceptedFraction = captureVisibility(center, child, acceptedCamera, frustum).visibleFraction;
  const rejectedFraction = captureVisibility(center, child, rejectedCamera, frustum).visibleFraction;
  const aboveFrameFraction = captureVisibility(center, child, aboveFrameCamera, frustum).visibleFraction;
  const accepted = solveFreePlacement(shiftedScene, { on: "floor", childSize: child, clearance: 0, visibleFrom: acceptedCamera, captureFrustum: frustum });
  const rejected = solveFreePlacement(shiftedScene, { on: "floor", childSize: child, clearance: 0, visibleFrom: rejectedCamera, captureFrustum: frustum });
  const aboveFrame = solveFreePlacement(shiftedScene, { on: "floor", childSize: child, clearance: 0, visibleFrom: aboveFrameCamera, captureFrustum: frustum });
  const fixturesStraddleHalf = acceptedFraction > 0.5 && acceptedFraction < 0.6 && rejectedFraction > 0.4 && rejectedFraction < 0.5 && aboveFrameFraction === 0;
  if (
    fixturesStraddleHalf &&
    accepted.status === "ok" && accepted.frustumBlocked === 0 &&
    rejected.status === "no-fit" && rejected.frustumBlocked === 1 &&
    aboveFrame.status === "no-fit" && aboveFrame.frustumBlocked === 1 &&
    /frustum/i.test(accepted.note ?? "") && /frustum/i.test(rejected.note ?? "") && /frustum/i.test(aboveFrame.note ?? "")
  ) ok(`shifted capture uses f/cx/cy/${frustum.width}×${frustum.height} and camera xyz: right+bottom area accepts ${(100 * acceptedFraction).toFixed(1)}%, rejects ${(100 * rejectedFraction).toFixed(1)}%; v<0 rejects 0%`);
  else fail(`shifted 2-D capture projection wrong: fractions=${acceptedFraction}/${rejectedFraction}/${aboveFrameFraction} accepted=${JSON.stringify(accepted)} rejected=${JSON.stringify(rejected)} above=${JSON.stringify(aboveFrame)}`);
}

// 17) Composition: capture-frustum filtering must not disable the pre-existing occupancy LOS hard
// constraint. The central in-frame floor is behind a full wall; the returned in-frame pose stays clear.
{
  const scene = { objects: [], floorY: 0, bounds: { min: [-2, 0, -6], max: [2, 3, -0.5] } };
  const wall = buildOccupancyGrid(lattice([-2, 0, -2.2], [2, 1.5, -1.8]), { cell: 0.05, minPointsPerCell: 2 });
  const camera = [0, 1, 0];
  const frustum = { f: 50, cx: 100, cy: 80, width: 200, height: 200 };
  const r = solveFreePlacement(scene, {
    on: "floor", childSize: [0.4, 0.4, 0.4], clearance: 0.05,
    visibleFrom: camera, captureFrustum: frustum,
  }, wall);
  const rayClear = r.status === "ok" && !rayOccluded(wall, camera, r.position).occluded;
  if (
    r.status === "ok" && rayClear && r.losBlocked > 0 && Number.isInteger(r.frustumBlocked) &&
    /line-of-sight/i.test(r.note ?? "") && /frustum/i.test(r.note ?? "")
  ) ok(`captureFrustum composes with occupancy LOS: ${r.losBlocked} occluded candidates rejected; returned [${r.position.join(", ")}] is ray-clear`);
  else fail(`captureFrustum disabled or obscured LOS: ${JSON.stringify(r)} rayClear=${rayClear}`);
}

// 18) Error path: the CHILD CENTER is in front of the camera, but its nearest depth face crosses
// behind z=0. Any one behind-camera corner must hard-reject the whole candidate.
{
  const straddlingScene = { objects: [], floorY: 0, bounds: { min: [-0.1, 0, -0.15], max: [0.1, 3, 0.05] } };
  const r = solveFreePlacement(straddlingScene, {
    on: "floor",
    childSize: [0.18, 0.18, 0.18],
    clearance: 0,
    visibleFrom: [0, 0.09, 0],
    captureFrustum: { f: 10, cx: 500, cy: 500, width: 1000, height: 1000 },
  });
  if (r.status === "no-fit" && r.frustumBlocked === 1 && /frustum/i.test(r.note ?? ""))
    ok("captureFrustum rejects an AABB when even one of its 8 corners is behind the -Z camera");
  else fail(`behind-camera AABB was not rejected: ${JSON.stringify(r)}`);
}

// 19) Invalid contract use fails closed: captureFrustum cannot silently behave like an unconstrained
// solve when visibleFrom (the camera center) is missing.
{
  const r = solveFreePlacement(captureScene, { ...captureQuery, captureFrustum });
  const loud = /capture.?frustum/i.test(r.note ?? "") && /visibleFrom/i.test(r.note ?? "");
  if (r.status !== "ok" && !r.position && Number.isInteger(r.frustumBlocked) && loud)
    ok("captureFrustum without visibleFrom fails closed and names the missing camera center");
  else fail(`captureFrustum without visibleFrom did not fail closed loudly: ${JSON.stringify(r)}`);
}

// 20) Result-shape invariant: even early exits expose frustumBlocked=0 when captureFrustum was
// enabled, so callers never have to infer whether the visual constraint existed from a missing key.
{
  const camera = [0, 0.1, 0];
  const frustum = { f: 100, cx: 50, cy: 50, width: 100, height: 100 };
  const noSurface = solveFreePlacement(
    { objects: [] },
    { on: "floor", childSize: [0.2, 0.2, 0.2], visibleFrom: camera, captureFrustum: frustum },
  );
  const tooLarge = solveFreePlacement(
    { objects: [], floorY: 0, bounds: { min: [-0.5, 0, -2], max: [0.5, 3, -1] } },
    { on: "floor", childSize: [2, 0.2, 2], clearance: 0, visibleFrom: camera, captureFrustum: frustum },
  );
  if (noSurface.status === "no-surface" && noSurface.frustumBlocked === 0 && tooLarge.status === "no-fit" && tooLarge.frustumBlocked === 0)
    ok("frustum-enabled no-surface and footprint-too-large results both expose frustumBlocked=0");
  else fail(`early frustum result shape inconsistent: noSurface=${JSON.stringify(noSurface)} tooLarge=${JSON.stringify(tooLarge)}`);
}

// 21) DIRECT MCP REGRESSION: AppSpec strictness is not enough — the registered
// solve_free_placement input schema must reject the same outer and nested typos before its handler.
{
  const mcpServer = new McpServer({ name: "affordance-input-test", version: "0.0.0" });
  registerAffordanceTools(mcpServer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "affordance-input-test", version: "0.0.0" });
  await mcpServer.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const frustum = { f: 100, cx: 50, cy: 50, width: 100, height: 100 };
  const baseArgs = {
    objects: [{ id: 1, label: "high marker", center: [0, 2.5, -3], size: [0.1, 0.1, 0.1] }],
    floorY: 0,
    bounds: { min: [-2, 0, -4], max: [2, 3, -2] },
    on: "floor",
    childSize: [0.2, 0.2, 0.2],
    visibleFrom: [0, 1, 0],
  };
  const outerTypo = await mcpClient.callTool({
    name: "solve_free_placement",
    arguments: { ...baseArgs, captureFrustrum: frustum },
  });
  const nestedTypo = await mcpClient.callTool({
    name: "solve_free_placement",
    arguments: { ...baseArgs, captureFrustum: { ...frustum, minVisiblePercent: 75 } },
  });
  await mcpClient.close();
  const textOf = (result) => (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  const outerRejected = outerTypo.isError === true && textOf(outerTypo).includes("captureFrustrum");
  const nestedRejected = nestedTypo.isError === true && textOf(nestedTypo).includes("minVisiblePercent");
  if (outerRejected && nestedRejected)
    ok("registered solve_free_placement rejects outer captureFrustrum and nested minVisiblePercent through MCP validation");
  else fail(`solve_free_placement MCP schema stripped typo(s): outer=${JSON.stringify(outerTypo)} nested=${JSON.stringify(nestedTypo)}`);
}

// 22) the REAL ramen scan: only the floor is a usable surface (all tops sit above 2m) — honest
const RAMEN = `${process.env.HOME}/.pico-mcp/artifacts/ramen-v19-semantic-app.json`;
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
