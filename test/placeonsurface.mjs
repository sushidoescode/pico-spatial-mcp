// v31 place_model_on_surface: the one-call orchestrator (measure -> bake -> surface placement).
// The composition is what this gates: the measured numbers must FLOW into the emitted Kotlin —
// hand-retyping them between the three steps is exactly the silent error the orchestrator removes.
// The bake step needs the spatialbundle toolchain, so composeSurfacePlacement (pure) is tested
// against a synthesized GLB fixture + a stubbed bake result — deterministic, machine-independent
// (the modelmeasure.mjs fixture pattern).
// Run: npm run test:placeonsurface
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureModel } from "../dist/modelmeasure.js";
import { composeSurfacePlacement } from "../dist/placeonsurface.js";
import { parsePlaneMarkers } from "../dist/sense.js";
import { runLint } from "../dist/lint.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures += 1; };
const assert = (c, m) => (c ? ok(m) : fail(m));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "placeonsurface-"));

/** Minimal glTF JSON packed into a real .glb container (the modelmeasure.mjs pattern). */
function writeGlb(name, { min, max }) {
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ name: "box", primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: "VEC3", componentType: 5126, count: 8, min, max }],
  };
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

// An origin-CENTRED 2 x 1 x 0.5 box — the Meshy convention, the one that buries a model to the
// waist when its baseLift is guessed instead of measured.
const measured = measureModel(writeGlb("table", { min: [-1, -0.5, -0.25], max: [1, 0.5, 0.25] }));
assert(!measured.error, "fixture GLB measures cleanly");
const bake = { bundle: "/tmp/assets/market_table.bundle", modelName: "Meshy_table" };
const base = { packageName: "com.demo.app.content", semantic: "TABLE" };

const composed = composeSurfacePlacement(measured, bake, base);
const kt = composed.kotlin;

// ── the measured numbers flow into the Kotlin (never retyped) ────────────────────────────────────
assert(/SIZE_X = 2f/.test(kt) && /SIZE_Y = 1f/.test(kt) && /SIZE_Z = 0\.5f/.test(kt),
  "measured dims flow into the emitted Kotlin (SIZE_X/Y/Z from the file's accessors)");
assert(/BASE_LIFT = 0\.5000f/.test(kt) && composed.baseLift === 0.5,
  "measured baseLift applied (origin-CENTRED box lifts by half its height)");
assert(/MEASURED by measure_model/.test(kt),
  "the Kotlin says the lift is MEASURED, not a convention label");

// ── bake output wires the bundle + model name ────────────────────────────────────────────────────
assert(/BUNDLE = "asset:\/\/market_table\.bundle"/.test(kt), "bundleAsset derived from the baked bundle path");
assert(/MODEL = "Meshy_table"/.test(kt), "model name comes from the bake info, not a guess");

// ── the seating recipe survives composition ──────────────────────────────────────────────────────
assert(/semantics\.name == "TABLE"/.test(kt), "semantic target honored (TABLE)");
assert(/ShapeResource\.createBox/.test(kt) && !/createConvexMesh|createStaticMesh/.test(kt),
  "PRIMITIVE box collider present (mesh colliders never register on PICO)");
assert(/PhysicsWorldComponent\(\)/.test(kt), "collider carries the REQUIRED PhysicsWorldComponent");
assert(/while \(planes\.isEmpty\(\) && tries < 20\)/.test(kt), "the poll-for-planes trap stays closed");
assert(/Vector3\(surface\.x, surface\.y \+ BASE_LIFT, surface\.z\)/.test(kt) && !/FRONT_DIST/.test(kt),
  "an object-sized TABLE seats at the plane centroid");

// ── contract ─────────────────────────────────────────────────────────────────────────────────────
assert(composed.objectName === "TablePlacement", "default object name derives from the semantic");
assert(composed.targetPath === "app/src/main/java/com/demo/app/content/TablePlacement.kt",
  "targetPath points into the requested package");
assert(/TablePlacement\.seat\(sceneRoot\)/.test(composed.usage), "usage line shows the seat() insertion");

// ── variants ─────────────────────────────────────────────────────────────────────────────────────
{
  const floor = composeSurfacePlacement(measured, bake, { ...base, semantic: "FLOOR" });
  assert(/FRONT_DIST = 1\.6f/.test(floor.kotlin) && /semantics\.name == "FLOOR"/.test(floor.kotlin),
    "FLOOR variant seats in FRONT of the user (trap 6)");
  assert(floor.objectName === "FloorPlacement", "FLOOR variant names FloorPlacement");

  const lifted = composeSurfacePlacement(measured, bake, { ...base, offset: 0.02 });
  assert(/BASE_LIFT = 0\.5200f/.test(lifted.kotlin) && lifted.baseLift === 0.52,
    "offset adds extra metres above the surface on top of the measured lift");

  const none = composeSurfacePlacement(measured, bake, { ...base, collider: "none" });
  assert(!/CollisionComponent\(/.test(none.kotlin), "collider:none emits no collider");

  const named = composeSurfacePlacement(measured, bake, { ...base, objectName: "MarketTable" });
  assert(/object MarketTable \{/.test(named.kotlin) && /MarketTable\.kt$/.test(named.targetPath),
    "explicit objectName wins");
}

// ── the composed Kotlin passes this repo's OWN retained-lessons lint ─────────────────────────────
{
  const res = runLint(kt, "kotlin");
  const errors = (res.violations ?? []).filter((v) => v.severity === "error");
  errors.length === 0
    ? ok(`composed Kotlin passes preflight_lint (${(res.violations ?? []).length} non-error notes)`)
    : fail(`composed Kotlin trips lint: ${errors.map((e) => e.ruleId).join(", ")}`);
}

// ── determinism (the repo's standing rule for generators) ────────────────────────────────────────
assert(JSON.stringify(composeSurfacePlacement(measured, bake, base)) === JSON.stringify(composed),
  "deterministic: same measurement + bake + options -> byte-identical output");

// ── probe_planes marker parser (the host half of the poll-for-planes lesson) ─────────────────────
{
  const log = [
    "08-01 10:00:00.000  1234  1234 I SceneUnderstanding: PLANES| count=0 retries=0",
    "08-01 10:00:09.000  1234  1234 I SceneUnderstanding: PLANES| count=2 retries=7",
    "08-01 10:00:09.001  1234  1234 I SceneUnderstanding: PLANES| idx=0 label=FLOOR orient=HORIZONTAL_UPWARD pos=1.82,0.40,-0.35 bbox=4.92,2.90",
    "08-01 10:00:09.002  1234  1234 I SceneUnderstanding: PLANES| idx=1 label=TABLE orient=HORIZONTAL_UPWARD pos=0.1,1.2,-1.6 bbox=1.2,0.7",
  ].join("\n");
  const p = parsePlaneMarkers(log);
  assert(p && p.count === 2 && p.retries === 7, "parses the LATEST dump's count + retry count (cold boot ~7)");
  assert(p.planes.length === 2 && p.planes[0].label === "FLOOR" && p.planes[0].position[1] === 0.4,
    "parses label + pose (FLOOR at y=0.40, the measured emulator height)");
  assert(p.planes[1].extent[0] === 1.2 && p.planes[1].extent[1] === 0.7, "parses plane extents");
  assert(parsePlaneMarkers("no markers here") === null, "no markers -> null (probe reports the honest error)");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nplace-on-surface test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
