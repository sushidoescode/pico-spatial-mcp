// v14.6 vault test: the agent-vault symbol index parser + the preflight vault check.
// Fixture-backed (test/fixtures/agent-vault, CI-green without pico-cli) plus assertions against
// the REAL vault when present (skip-if-absent). Run: npm run test:vault
import { loadVaultIndex, runVaultCheck, defaultVaultRoot } from "../dist/vault.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const fail = (msg) => { console.log(`  FAIL ${msg}`); failures++; };
const ok = (msg) => console.log(`  ok   ${msg}`);
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg));

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-vault");

// ── 1. Parser over the fixture vault ────────────────────────────────────────────────────────────────────
console.log("Parsing the fixture vault...\n");
const idx = loadVaultIndex(FIXTURE);
if (!idx) { fail("fixture vault did not load"); process.exit(1); }
assert(idx.fileCount === 4, `fileCount 4 (got ${idx.fileCount})`);

const ecs = idx.packages.get("com.pico.spatial.core.ecs");
const resource = idx.packages.get("com.pico.spatial.core.ecs.resource");
const math = idx.packages.get("com.pico.spatial.core.math");
const sim = idx.packages.get("com.pico.spatial.core.ecs.simulation");
assert(ecs && resource && math && sim, "all 4 fixture packages indexed");

// top-level types
for (const name of ["Entity", "RigidBodyComponent", "AnchorComponent", "CollisionComponent", "TransformComponent"])
  assert(ecs.has(name), `core.ecs declares ${name}`);
assert(!ecs.has("Sneaky"), "code sample inside a doc comment is NOT indexed (Sneaky)");

// nested types discovered by brace tracking (same indentation as members — the corpus quirk)
assert(ecs.has("AnchorComponent.Alignment"), "nested enum AnchorComponent.Alignment indexed");
assert(ecs.has("AnchorComponent.TrackingMode"), "nested class AnchorComponent.TrackingMode indexed");
assert(ecs.has("Entity.CloneOptions"), "nested class Entity.CloneOptions indexed");
assert(ecs.get("ExtraComponentDataSyncer")?.kind === "typealias", "typealias with vestigial brace pair indexed");

// enum entries + phantom-doc immunity
const alignment = ecs.get("AnchorComponent.Alignment");
assert(JSON.stringify(alignment?.enumEntries) === JSON.stringify(["CENTER", "EDGE"]), `enum entries [CENTER, EDGE] (got ${JSON.stringify(alignment?.enumEntries)})`);
const rbm = sim.get("RigidBodyMode");
assert(JSON.stringify(rbm?.enumEntries) === JSON.stringify(["KINEMATIC", "DYNAMIC", "UNKNOWN"]), "RigidBodyMode entries KINEMATIC/DYNAMIC/UNKNOWN");

// constructors: arity + param names
const rbc = ecs.get("RigidBodyComponent");
assert(rbc?.constructors.length === 2, `RigidBodyComponent has 2 ctors (got ${rbc?.constructors.length})`);
assert(JSON.stringify(rbc?.constructors[1]?.params.map((p) => p.name)) === JSON.stringify(["massProperties", "rigidBodyMode"]), "2-arg ctor param names");
const v3 = math.get("Vector3");
const v3ctor = v3?.constructors.find((c) => c.maxArity === 3);
assert(v3ctor?.minArity === 0, "Vector3(x,y,z) defaults → minArity 0 / maxArity 3");

// companion members are static members of the owning type
const shape = resource.get("ShapeResource");
const createCapsule = shape?.functions.find((f) => f.name === "createCapsule");
assert(createCapsule?.static === true, "ShapeResource.createCapsule is static (Companion)");
assert(
  JSON.stringify(createCapsule?.params.map((p) => p.name)) === JSON.stringify(["height", "radius"]),
  `createCapsule params are (height, radius) — the 2026-07-12 audit bug, locked (got ${JSON.stringify(createCapsule?.params.map((p) => p.name))})`,
);
const tm = ecs.get("AnchorComponent.TrackingMode");
assert(tm?.properties.some((p) => p.name === "CONTINUOUS" && p.static), "pseudo-enum companion constant TrackingMode.CONTINUOUS indexed as static");

// properties + suspend companion fn
assert(rbc?.properties.some((p) => p.name === "angularDamping" && p.type === "Float" && p.mutable), "angularDamping: Float var indexed");
const entity = ecs.get("Entity");
assert(entity?.properties.some((p) => p.name === "scene" && p.type === "Scene?"), "nullable `Scene ?` normalized to Scene?");
assert(entity?.functions.some((f) => f.name === "loadSuspend" && f.static && f.suspend), "Companion @JvmStatic suspend loadSuspend indexed");

// ── 2. runVaultCheck against the fixture index ──────────────────────────────────────────────────────────
console.log("\nVault check against the fixture index...\n");

// positive: fabricated types in a documented package MUST each yield one warn finding with the right line
const pos = runVaultCheck(
  ["import com.pico.spatial.core.ecs.TextComponent", "import com.pico.spatial.core.ecs.FrobnicatorComponent"].join("\n"),
  idx,
);
assert(pos.length === 2 && pos.every((f) => f.check === "unknown-type" && f.severity === "warn"), `2 unknown-type warns (got ${JSON.stringify(pos.map((f) => f.check))})`);
assert(pos[0]?.line === 1 && pos[1]?.line === 2, "finding lines attribute to the import lines");

// negative: the real generate_rigidbody_kotlin import block MUST stay silent
const physicsImports = [
  "import android.os.Handler",
  "import android.os.Looper",
  "import android.util.Log",
  "import com.pico.spatial.core.ecs.CollisionComponent",
  "import com.pico.spatial.core.ecs.Entity",
  "import com.pico.spatial.core.ecs.ModelComponent",
  "import com.pico.spatial.core.ecs.PhysicsForceComponent",
  "import com.pico.spatial.core.ecs.PhysicsVelocityComponent",
  "import com.pico.spatial.core.ecs.PhysicsWorldComponent",
  "import com.pico.spatial.core.ecs.RigidBodyComponent",
  "import com.pico.spatial.core.ecs.TransformComponent",
  "import com.pico.spatial.core.ecs.resource.MeshResource",
  "import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial",
  "import com.pico.spatial.core.ecs.resource.PhysicsMaterialResource",
  "import com.pico.spatial.core.ecs.resource.ShapeResource",
  "import com.pico.spatial.core.math.Color4",
  "import com.pico.spatial.core.ecs.simulation.MassProperties",
  "import com.pico.spatial.core.ecs.simulation.RigidBodyMode",
  "import com.pico.spatial.core.math.Quat",
  "import com.pico.spatial.core.math.Vector3",
].join("\n");
const neg = runVaultCheck(physicsImports, idx);
assert(neg.length === 0, `generate_rigidbody_kotlin import block is vault-clean (got ${JSON.stringify(neg.map((f) => f.symbol))})`);

// ui composables are skipped (no declarations exist for them in the vault)
assert(runVaultCheck("import com.pico.spatial.ui.design.Text", idx).length === 0, "ui.* import skipped (Text)");
// allowlist: runtime-verified symbols absent from api-reference
assert(runVaultCheck("import com.pico.spatial.core.ecs.GaussianSplattingComponent", idx).length === 0, "allowlisted GaussianSplattingComponent skipped");
// undocumented package → info, not warn
const undoc = runVaultCheck("import com.pico.spatial.sense.plane.PlaneInfo", idx);
assert(undoc.length === 1 && undoc[0].check === "undocumented-package" && undoc[0].severity === "info", "unknown package → info finding");
// inline FQN usage checked too
const inline = runVaultCheck("val x = com.pico.spatial.core.ecs.BogusThing()", idx);
assert(inline.length === 1 && inline[0].check === "unknown-type", "inline FQN usage validated");
// nested inline FQN resolves through the outer type
assert(runVaultCheck("val m = com.pico.spatial.core.ecs.AnchorComponent.TrackingMode", idx).length === 0, "nested inline FQN (Outer.Nested) resolves");
// FQ enum-entry and companion-constant references resolve through the TYPE prefix (2026-07-13 review fix)
assert(runVaultCheck("val m = com.pico.spatial.core.ecs.simulation.RigidBodyMode.DYNAMIC", idx).length === 0, "FQ enum-entry (Enum.ENTRY) resolves via type prefix");
assert(runVaultCheck("val t = com.pico.spatial.core.ecs.AnchorComponent.TrackingMode.CONTINUOUS", idx).length === 0, "FQ companion constant (Outer.Nested.CONSTANT) resolves");
// member import (lowercase last segment) skipped
assert(runVaultCheck("import com.pico.spatial.core.ecs.someMember", idx).length === 0, "lowercase member import skipped");

// ── 3. Absent vault degrades to null ────────────────────────────────────────────────────────────────────
assert(loadVaultIndex("/nonexistent-vault-root") === null, "absent vault → loadVaultIndex null");

// ── 4. The REAL vault (skip-if-absent) ──────────────────────────────────────────────────────────────────
console.log("\nReal agent-vault checks (skipped when not provisioned)...\n");
const real = loadVaultIndex();
if (!real) {
  console.log(`  skip real vault not found at ${defaultVaultRoot()}`);
} else {
  assert(real.typeCount >= 419, `real vault indexes >= 419 top-level+nested types (got ${real.typeCount})`);
  const rShape = real.packages.get("com.pico.spatial.core.ecs.resource")?.get("ShapeResource");
  const rCapsule = rShape?.functions.find((f) => f.name === "createCapsule");
  assert(
    JSON.stringify(rCapsule?.params.map((p) => p.name)) === JSON.stringify(["height", "radius"]),
    "REAL vault: createCapsule(height, radius) — permanent regression lock for the collider.ts bug",
  );
  const rSpot = real.packages.get("com.pico.spatial.core.ecs")?.get("SpotLightComponent");
  assert(
    rSpot?.constructors.some((c) => c.maxArity === 5 && c.params[3]?.name === "innerAngle" && c.params[4]?.name === "outerAngle"),
    "REAL vault: SpotLightComponent 5-arg ctor with innerAngle/outerAngle — regression lock for the lighting.ts bug",
  );
  assert(runVaultCheck(physicsImports, real).length === 0, "REAL vault: generate_rigidbody_kotlin import block is vault-clean");
  const deepNested = [...(real.packages.get("com.pico.spatial.ml.securemr")?.keys() ?? [])].find((k) => k.split(".").length >= 3);
  if (deepNested) {
    assert(
      runVaultCheck(`import com.pico.spatial.ml.securemr.${deepNested}`, real).length === 0,
      `REAL vault: depth-3 nested type import resolves (${deepNested})`,
    );
  }
  assert(
    runVaultCheck("val m = com.pico.spatial.core.ecs.simulation.RigidBodyMode.DYNAMIC", real).length === 0,
    "REAL vault: FQ enum-entry reference resolves",
  );
  const splatImports = ["import com.pico.spatial.core.ecs.GaussianSplattingComponent", "import com.pico.spatial.core.ecs.resource.GaussianSplattingResource", "import com.pico.spatial.core.ecs.LoadType"].join("\n");
  assert(runVaultCheck(splatImports, real).length === 0, "REAL vault: splat-env imports clean (allowlist + LoadType)");
  console.log(`\n  info real vault: SDK ${real.sdkVersion}, ${real.typeCount} types across ${real.fileCount} package files`);
}

console.log(`\nVault test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
