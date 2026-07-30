// v30.5 model measurement: the last hand-step in the Meshy-GLB -> MR-object path.
// Fixtures are synthesised here rather than checked in, so the gate has NO machine-local dependency
// (the sin that v29.3 spent an arc removing from the build lane).
// Run: npm run test:modelmeasure
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureModel } from "../dist/modelmeasure.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures += 1; };
const assert = (c, m) => (c ? ok(m) : fail(m));
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelmeasure-"));

/** Minimal glTF whose POSITION accessor carries the min/max the spec requires. */
function gltf({ min, max, node = {}, extraNode = null }) {
  const nodes = [{ mesh: 0, ...node }];
  if (extraNode) nodes.push({ mesh: 0, ...extraNode });
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: [{ name: "box", primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: "VEC3", componentType: 5126, count: 8, min, max }],
  };
}

function writeGltf(name, json) {
  const f = path.join(dir, `${name}.gltf`);
  fs.writeFileSync(f, JSON.stringify(json));
  return f;
}

/** Pack JSON into a real .glb container so the binary path is exercised too. */
function writeGlb(name, json) {
  const j = Buffer.from(JSON.stringify(json), "utf8");
  const padded = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + padded.length, 8);
  const chunk = Buffer.alloc(8);
  chunk.writeUInt32LE(padded.length, 0);
  chunk.writeUInt32LE(0x4e4f534a, 4);
  const f = path.join(dir, `${name}.glb`);
  fs.writeFileSync(f, Buffer.concat([header, chunk, padded]));
  return f;
}

// ── the measurement itself ───────────────────────────────────────────────────────────────────────
{
  // Origin-CENTRED, the Meshy/Marble convention and the one that buries a model to the waist when
  // it is assumed to be bottom-origin.
  const m = measureModel(writeGltf("centred", gltf({ min: [-1, -0.5, -0.25], max: [1, 0.5, 0.25] })));
  assert(!m.error && near(m.size[0], 2) && near(m.size[1], 1) && near(m.size[2], 0.5), "measures a centred box exactly");
  assert(m.originAt === "center", "infers origin-CENTRED");
  assert(near(m.baseLift, 0.5), "baseLift is the distance from origin DOWN to the lowest point");
  assert(m.meshNodes === 1, "counts mesh-bearing nodes");
  assert(m.warnings.length === 0, "a sane model warns about nothing");
}
{
  const m = measureModel(writeGltf("bottom", gltf({ min: [-1, 0, -1], max: [1, 2, 1] })));
  assert(m.originAt === "bottom" && near(m.baseLift, 0), "bottom-origin model needs NO lift");
}
{
  // The case neither convention label covers — and the reason baseLift is authoritative. Measured on
  // the real Meshy table: its origin sat 0.5 mm below true centre, so height/2 was 0.4 mm wrong.
  const m = measureModel(writeGltf("offset", gltf({ min: [-1, -0.9, -1], max: [1, 0.1, 1] })));
  assert(m.originAt === "offset" && near(m.baseLift, 0.9), "off-centre origin reports an exact baseLift");
  assert(m.warnings.some((w) => /pass baseLift explicitly/.test(w)), "and warns that a label cannot express it");
}

// ── the scene graph must actually be walked ──────────────────────────────────────────────────────
{
  const m = measureModel(writeGltf("scaled", gltf({ min: [-1, -1, -1], max: [1, 1, 1], node: { scale: [3, 0.5, 1] } })));
  assert(near(m.size[0], 6) && near(m.size[1], 1) && near(m.size[2], 2), "applies a node's SCALE");
}
{
  // 90 deg about Z swaps the x and y extents. An AABB that ignored rotation would report 2 x 1.
  const q = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const m = measureModel(writeGltf("rotated", gltf({ min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5], node: { rotation: q } })));
  assert(near(m.size[0], 1) && near(m.size[1], 2), "applies a node's ROTATION (corners, not the raw AABB)");
}
{
  const m = measureModel(writeGltf("two", gltf({ min: [-1, -1, -1], max: [1, 1, 1], extraNode: { translation: [10, 0, 0] } })));
  assert(near(m.size[0], 12), "unions every mesh node in the scene");
}
{
  const child = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ translation: [5, 0, 0], children: [1] }, { mesh: 0, translation: [0, 3, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: "VEC3", componentType: 5126, count: 8, min: [-1, -1, -1], max: [1, 1, 1] }],
  };
  const m = measureModel(writeGltf("nested", child));
  assert(near(m.centre[0], 5) && near(m.centre[1], 3), "composes PARENT transforms down the tree");
}

// ── containers and failure modes ─────────────────────────────────────────────────────────────────
{
  const m = measureModel(writeGlb("binary", gltf({ min: [-1, -1, -1], max: [1, 1, 1] })));
  assert(!m.error && near(m.size[0], 2), "parses a real .glb container, not just .gltf JSON");
}
{
  const bad = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ name: "nomin", primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: "VEC3", componentType: 5126, count: 8 }] };
  const m = measureModel(writeGltf("nomin", bad));
  assert(!!m.error && /min\/max/.test(m.error), "refuses to guess when POSITION min/max is absent");
}
assert(!!measureModel(path.join(dir, "nope.glb")).error, "missing file is an error, not a crash");
{
  // The file must EXIST, or the missing-file check fires first and we learn nothing about formats.
  const usdz = path.join(dir, "table.usdz");
  fs.writeFileSync(usdz, "not really usdz");
  const m = measureModel(usdz);
  assert(!!m.error && /\.glb\/\.gltf/.test(m.error), "unsupported extension says which formats it reads");
}
{
  const m = measureModel(writeGltf("cm", gltf({ min: [0, 0, 0], max: [200, 84, 135] })));
  assert(m.warnings.some((w) => /centimetres/.test(w)), "flags a model that looks like centimetres");
}

// ── determinism (the repo's standing rule for anything feeding a generator) ───────────────────────
{
  const f = writeGltf("det", gltf({ min: [-1, -0.5, -0.25], max: [1, 0.5, 0.25] }));
  assert(JSON.stringify(measureModel(f)) === JSON.stringify(measureModel(f)), "deterministic: same file -> identical measurement");
}

// ── opportunistic: the REAL model the vision-verified MR table was built on ───────────────────────
// Skipped when absent so the gate stays machine-independent, but when it is there it proves the tool
// reproduces numbers a looked-at app actually ran on.
{
  const real = path.join(os.homedir(), "Downloads", "Meshy_AI_a_table_0729105533_texture.glb");
  if (fs.existsSync(real)) {
    const m = measureModel(real);
    assert(near(m.size[0], 2.0035) && near(m.size[1], 0.8373) && near(m.size[2], 1.3509),
      "reproduces the hand-measured Meshy table (2.0035 x 0.8373 x 1.3509) that ledger seq 0-12 ran on");
    assert(m.originAt === "center", "and independently infers the origin-CENTRED convention");
  } else {
    console.log("  skip the real Meshy table (not on this machine) — synthetic fixtures still gate the logic");
  }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nModel-measure test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
