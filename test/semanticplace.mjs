// v17.0 semantic-placement test: label-anchored resolution over labeled 3D boxes.
// Fixture mirrors the REAL ramen-world labels (semantic_splat_scan verified 2026-07-12):
// counter, neon sign, menu board, light fixtures, floor. Run: npm run test:semantic
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSemanticPlacement, resolveAnchors, labelScore, loadSemanticScene } from "../dist/semanticplace.js";
import { buildLedger } from "../dist/compiler.js";

let failures = 0;
const fail = (msg) => { console.log(`  FAIL ${msg}`); failures++; };
const ok = (msg) => console.log(`  ok   ${msg}`);
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg));
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const scene = {
  objects: [
    { id: 3, label: "ramen bar counter", center: [0.0, 0.9, -2.0], size: [2.4, 0.9, 0.8] },
    { id: 8, label: "neon sign", center: [1.8, 1.9, -3.0], size: [1.2, 0.8, 0.1] },
    { id: 4, label: "menu board", center: [-1.5, 1.8, -3.0], size: [0.9, 0.7, 0.1] },
    { id: 11, label: "light fixture", center: [0.5, 2.4, -1.5], size: [0.3, 0.4, 0.3] },
    { id: 12, label: "light fixture", center: [-0.5, 2.4, -1.5], size: [0.35, 0.45, 0.35] },
    { id: 1, label: "floor", center: [0, 0.02, -2], size: [5, 0.04, 5] },
  ],
  floorY: 0.0,
  bounds: { min: [-2.5, 0, -4.5], max: [2.5, 2.8, 0.5] },
};

console.log("Resolver...\n");
// on-top-of: counter top 0.9+0.45=1.35, child h 0.3 -> y 1.5
const top = resolveSemanticPlacement(scene, { label: "counter" }, [0.4, 0.3, 0.4]);
assert(top.status === "ok" && top.matched.id === 3, `fuzzy 'counter' -> #3 ramen bar counter (got ${JSON.stringify(top.matched)})`);
assert(close(top.position[0], 0) && close(top.position[1], 1.5) && close(top.position[2], -2), `on-top-of y = center.y + size/2 + child/2 (got ${JSON.stringify(top.position)})`);

// next-to: neon sign (sx 1.2 > sz 0.1 -> free side is Z? no: dir picks the SHORTER extent axis: sz 0.1 < sx 1.2 -> dir Z)
const beside = resolveSemanticPlacement(scene, { label: "neon sign", relation: "next-to", gap: 0.1 }, [0.2, 0.2, 0.2]);
assert(beside.status === "ok" && close(beside.position[2], -3.0 + (0.05 + 0.1) + 0.1) && close(beside.position[1], 0.1), `next-to steps out along the free axis and grounds on floorY (got ${JSON.stringify(beside.position)})`);

// in-front-of: menu board at (-1.5,-3), room center (0,-2) -> direction normalized (1.5,1)/1.803
const front = resolveSemanticPlacement(scene, { label: "menu board", relation: "in-front-of", gap: 0.2 }, [0.2, 1.6, 0.2]);
assert(front.status === "ok" && front.position[0] > -1.5 && front.position[2] > -3.0 && close(front.position[1], 0.8), `in-front-of walks toward the room center at floor height (got ${JSON.stringify(front.position)})`);

// ambiguity: two 'light fixture' objects tie -> resolves against the larger, reports AMBIGUOUS
const amb = resolveSemanticPlacement(scene, { label: "light fixture" }, [0.1, 0.1, 0.1]);
assert(amb.status === "ambiguous" && amb.matched.id === 12 && /matched 2 objects/.test(amb.note), `ambiguous tie resolves to the largest + reports (got ${amb.status}, #${amb.matched?.id})`);

// not-found lists the available labels
const nf = resolveSemanticPlacement(scene, { label: "jukebox" });
assert(nf.status === "not-found" && nf.note.includes("ramen bar counter"), "not-found lists available labels");

// offset applies after resolution
const off = resolveSemanticPlacement(scene, { label: "counter", offset: [0.5, 0.1, 0] }, [0.4, 0.3, 0.4]);
assert(close(off.position[0], 0.5) && close(off.position[1], 1.6), "offset applied after resolution");

// labelScore ordering: exact > substring > token overlap
assert(labelScore("neon sign", "neon sign") > labelScore("neon", "neon sign") && labelScore("neon", "neon sign") > labelScore("sign board", "menu board"), "labelScore orders exact > substring > overlap");

console.log("\nCompile-time hook (resolveAnchors + buildLedger)...\n");
const sceneFile = path.join(os.tmpdir(), "pico-mcp-semantic-fixture.json");
fs.writeFileSync(sceneFile, JSON.stringify(scene));
const spec = {
  meta: { appName: "AnchorXR", packageName: "com.example.anchor", stageStyle: "3", brief: "t", semanticScenePath: sceneFile },
  scenes: [{ id: "s", environment: { kind: "procedural" }, lighting: { rig: "sun" }, colliders: { props: [] }, transitions: [] }],
  layouts: [], panels: [], interactions: [], data: [], verificationPlan: [], headsetLayer: [],
  navigation: { startScene: "s", portals: [] },
  objects: [
    { id: "scoreboard", sceneId: "s", source: "primitive", anchorTo: { label: "counter" }, body: { mode: "static", shape: "box", dims: [0.4, 0.3, 0.4] } },
    { id: "pinned", sceneId: "s", source: "primitive", transform: { position: [9, 9, 9] }, anchorTo: { label: "counter" } },
  ],
};
const { spec: resolved, notes } = resolveAnchors(spec);
assert(close(resolved.objects[0].transform.position[1], 1.5), `anchorTo baked into transform.position (got ${JSON.stringify(resolved.objects[0].transform)})`);
assert(resolved.objects[1].transform.position[0] === 9 && notes.some((n) => n.includes("wins over anchorTo")), "explicit position wins over anchorTo");
assert(notes.some((n) => n.includes("scoreboard")), "resolution notes name the object");

// through buildLedger: the wiring step's spec carries the BAKED position
const ledger = buildLedger(spec, "/tmp/x");
const wiring = ledger.find((s) => s.tool === "generate_app_wiring");
assert(close(wiring.args.spec.objects[0].transform.position[1], 1.5), "buildLedger passes the resolved spec to the wiring step");

// missing scene file -> untouched + loud note
const specBad = JSON.parse(JSON.stringify(spec));
specBad.meta.semanticScenePath = "/nonexistent.json";
const bad = resolveAnchors(specBad);
assert(!bad.spec.objects[0].transform?.position && bad.notes.some((n) => n.includes("NOT resolved")), "missing semantic scene leaves objects untouched with a loud note");

// loadSemanticScene tolerates the compose_semantic_scene wrapper shape
fs.writeFileSync(sceneFile, JSON.stringify({ semantic: { objects: scene.objects }, placement: { floorY: 0 }, bounds: scene.bounds }));
const wrapped = loadSemanticScene(sceneFile);
assert(wrapped && wrapped.objects.length === 6 && wrapped.floorY === 0, "loadSemanticScene reads the wrapped compose output shape");

fs.unlinkSync(sceneFile);
console.log(`\nSemantic-placement test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
