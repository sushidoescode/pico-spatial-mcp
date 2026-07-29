// v30.2 surface placement: the generator that seats a baked model on a DETECTED plane.
// Every assertion is a trap that was hit by hand on 2026-07-29 while building the MR data tabletop;
// each one is silent (the app builds, runs, and looks plausibly wrong), so it has to be a gate.
// Run: npm run test:surfaceplace
import { surfacePlacementKotlin } from "../dist/surfaceplace.js";
import { runLint } from "../dist/lint.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures += 1; };
const assert = (c, m) => (c ? ok(m) : fail(m));

const base = {
  packageName: "com.demo.app.content",
  objectName: "TablePlacement",
  bundleAsset: "asset://table.bundle",
  modelName: "Meshy_table",
  semantic: "FLOOR",
  modelSize: [2.0035, 0.8373, 1.3509],
  originAt: "center",
  collider: "boxTop",
  pollSeconds: 20,
};

const kt = surfacePlacementKotlin(base);

// ── the five silent traps ────────────────────────────────────────────────────────────────────────
assert(/while \(planes\.isEmpty\(\) && tries < 20\)/.test(kt) && /delay\(1000\)/.test(kt),
  "TRAP 1: polls for planes (a one-shot query returns 0 during Full Space entry)");
// The y must be READ from the converted anchor, never a constant. (Careful: BASE_LIFT is legitimately
// 0.4187f for this model, so a naive "no 0.4 anywhere" check false-positives — it did, first run.)
assert(/Vector3\(surface\.x, surface\.y \+ BASE_LIFT, surface\.z\)/.test(kt) && !/FLOOR_Y|floorHeight\s*=/.test(kt),
  "TRAP 2: height comes from the detected plane, never a hardcoded floor constant");
assert(/root\.convertPositionFrom\(anchor\.transform\.position, null\)/.test(kt),
  "TRAP 3: converts anchor space into the root's space");
assert(/BASE_LIFT = 0\.4187f/.test(kt),
  "TRAP 4: origin-CENTRE model lifted by half its height (0.8373/2 = 0.4187)");
assert(/ShapeResource\.createBox/.test(kt) && !/createConvexMesh|createStaticMesh/.test(kt),
  "TRAP 5: PRIMITIVE box collider only (mesh colliders never register on PICO)");
assert(/PhysicsWorldComponent\(\)/.test(kt),
  "collider carries the REQUIRED PhysicsWorldComponent");

// ── contract ────────────────────────────────────────────────────────────────────────────────────
assert(kt.startsWith("package com.demo.app.content"), "emits into the requested package");
assert(/object TablePlacement \{/.test(kt), "object named as requested");
assert(/suspend fun seat\(root: Entity, add: \(Entity\) -> Unit\): Entity\?/.test(kt), "seat() signature is stable");
assert(/BUNDLE = "asset:\/\/table\.bundle"/.test(kt) && /MODEL = "Meshy_table"/.test(kt), "bundle + model wired");
assert(/semantics\.name == "FLOOR"/.test(kt), "targets the requested semantic label");
assert(/maxByOrNull \{ it\.boundingBoxSize\.x \* it\.boundingBoxSize\.y \}/.test(kt),
  "largest matching plane wins (a 0.2m shelf is a poor floor)");
assert(/HORIZONTAL_UPWARD|UPWARD/.test(kt), "falls back to orientation when the label is absent");

// ── the generated Kotlin must pass this repo's OWN retained-lessons lint ─────────────────────────
{
  const res = runLint(kt, "kotlin");
  const errors = (res.violations ?? []).filter((v) => v.severity === "error");
  errors.length === 0
    ? ok(`generated Kotlin passes preflight_lint (${(res.violations ?? []).length} non-error notes)`)
    : fail(`generated Kotlin trips lint: ${errors.map((e) => e.ruleId).join(", ")}`);
}

// ── variants ────────────────────────────────────────────────────────────────────────────────────
{
  const bottom = surfacePlacementKotlin({ ...base, originAt: "bottom" });
  assert(/BASE_LIFT = 0\.0000f/.test(bottom), "bottom-origin model gets NO lift");

  const wall = surfacePlacementKotlin({ ...base, semantic: "WALL" });
  assert(/semantics\.name == "WALL"/.test(wall) && /VERTICAL/.test(wall),
    "WALL target falls back to VERTICAL planes, not horizontal");

  const ceil = surfacePlacementKotlin({ ...base, semantic: "CEILING" });
  assert(/DOWNWARD/.test(ceil), "CEILING target falls back to DOWNWARD-facing planes");

  const none = surfacePlacementKotlin({ ...base, collider: "none" });
  assert(!/CollisionComponent\(/.test(none) && !/makeCollider/.test(none), "collider:none emits no collider");

  const full = surfacePlacementKotlin({ ...base, collider: "boxFull" });
  assert(/val slabH = SIZE_Y/.test(full), "collider:boxFull uses the whole model height");
}

// ── determinism (the repo's standing rule for generators) ────────────────────────────────────────
assert(surfacePlacementKotlin(base) === kt, "deterministic: same options -> byte-identical Kotlin");

console.log(`\nSurface-placement test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
