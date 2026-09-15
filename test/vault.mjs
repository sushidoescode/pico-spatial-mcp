// v14.6 vault test: the agent-vault symbol index parser + the preflight vault check.
// Fixture-backed (test/fixtures/agent-vault, CI-green without pico-cli) plus assertions against
// the REAL vault when present (skip-if-absent). Run: npm run test:vault
import { loadVaultIndex, runVaultCheck, defaultVaultRoot, registerVaultTools } from "../dist/vault.js";
import { registerDoorTools } from "../dist/doors.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const fail = (msg) => { console.log(`  FAIL ${msg}`); failures++; };
const ok = (msg) => console.log(`  ok   ${msg}`);
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg));

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-vault");
const assertSdk6Provenance = (result, label) => {
  assert(result.vaultProvenance?.defaultSdkVersion === "0.13.3", `${label}: names the 0.13.3 default declaration vault`);
  assert(result.vaultProvenance?.declarationSource === "PICO agent-vault knowledge/api-reference", `${label}: names the declaration source`);
  assert(result.vaultProvenance?.sdk600DriftDoc === "docs/SDK_6_0_0_DRIFT.md", `${label}: points at the SDK 6.0.0 drift document`);
};

// Public missing-vault guidance must route through the managed resolver. A bare `pico-cli setup`
// command could execute an unrelated ambient/global shim and contradict the managed policy.
{
  const handlers = {};
  let metadata;
  registerVaultTools({ registerTool: (name, toolMetadata, fn) => {
    handlers[name] = fn;
    if (name === "vault_api") metadata = toolMetadata;
  } });
  const missingSdk = `missing-${process.pid}-${Date.now()}`;
  const missing = JSON.parse((await handlers.vault_api({ symbol: "Entity", sdkVersion: missingSdk })).content[0].text);
  const publicText = JSON.stringify({ metadata, missing });
  assert(!/pico-cli\s+setup/i.test(publicText), "vault_api public schema/result never recommends a bare pico-cli setup command");
  assert(/ensure_pico_cli/i.test(missing.note ?? ""), "vault_api missing-vault result starts with ensure_pico_cli");
  assert(/returned absolute path/i.test(missing.note ?? ""), "vault_api missing-vault result requires the returned absolute path");
  assert(/args \[\"setup\"\]/i.test(missing.note ?? ""), "vault_api missing-vault result supplies setup argv structurally");
  assertSdk6Provenance(missing, "vault_api unavailable result");
  assert(/0\.13\.3/.test(metadata.description) && /docs\/SDK_6_0_0_DRIFT\.md/.test(metadata.description), "vault_api description discloses the 0.13.3 declaration baseline and SDK 6.0.0 drift caveat");

  const priorVault = process.env.PICO_AGENT_VAULT;
  process.env.PICO_AGENT_VAULT = FIXTURE;
  try {
    const found = JSON.parse((await handlers.vault_api({ symbol: "Entity" })).content[0].text);
    const documented = JSON.parse((await handlers.vault_api({ symbol: "SpatialModelView" })).content[0].text);
    const notFound = JSON.parse((await handlers.vault_api({ symbol: "DefinitelyMissingSdkType" })).content[0].text);
    assert(found.status === "ok", `fixture vault_api success response available (got ${found.status})`);
    assert(documented.status === "documented-only", `fixture vault_api documented-only response available (got ${documented.status})`);
    assert(notFound.status === "not-found", `fixture vault_api not-found response available (got ${notFound.status})`);
    assertSdk6Provenance(found, "vault_api success result");
    assertSdk6Provenance(documented, "vault_api documented-only result");
    assertSdk6Provenance(notFound, "vault_api not-found result");
  } finally {
    if (priorVault === undefined) delete process.env.PICO_AGENT_VAULT;
    else process.env.PICO_AGENT_VAULT = priorVault;
  }

  const doorMetadata = {};
  registerDoorTools({ registerTool: (name, toolMetadata) => { doorMetadata[name] = toolMetadata; } });
  assert(/0\.13\.3/.test(doorMetadata.pico_sdk.description) && /docs\/SDK_6_0_0_DRIFT\.md/.test(doorMetadata.pico_sdk.description), "pico_sdk description discloses the forwarded vault provenance and drift caveat");
}

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

// ── 2b. Phase-2 checks: @param docs, enum values, ctor arity (import-driven, 2026-07-13) ────────────────
console.log("\nPhase-2 checks against the fixture index...\n");

// @param doc capture — the unit-semantics data that would have caught the spotlight bug mechanically
assert(createCapsule?.params[0]?.doc?.includes("total height"), `createCapsule height param carries its @param doc (got ${JSON.stringify(createCapsule?.params[0]?.doc)})`);

// enum-value check: fires on a bogus entry, silent on real entries — needs the explicit import
const enumBad = runVaultCheck("import com.pico.spatial.core.ecs.simulation.RigidBodyMode\nval m = RigidBodyMode.BOGUS", idx);
assert(enumBad.length === 1 && enumBad[0].check === "unknown-enum-value" && enumBad[0].message.includes("KINEMATIC"), `bogus enum entry flagged w/ valid values (got ${JSON.stringify(enumBad)})`);
assert(runVaultCheck("import com.pico.spatial.core.ecs.simulation.RigidBodyMode\nval m = RigidBodyMode.DYNAMIC", idx).length === 0, "real enum entry silent");
assert(runVaultCheck("val m = RigidBodyMode.BOGUS", idx).length === 0, "no import → enum check does not fire (androidx safety)");
// companion constants count as valid values
assert(runVaultCheck("import com.pico.spatial.core.math.Vector3\nval z = Vector3.ZERO", idx).length === 0, "companion constant Vector3.ZERO silent");
const constBad = runVaultCheck("import com.pico.spatial.core.math.Vector3\nval z = Vector3.NOPE", idx);
assert(constBad.length === 1 && constBad[0].check === "unknown-enum-value", "bogus companion constant flagged");
// nested-type access via the outer import is NOT a false positive
assert(runVaultCheck("import com.pico.spatial.core.ecs.AnchorComponent\nval t = AnchorComponent.TrackingMode", idx).length === 0, "nested type access via outer import silent");
// doc-prose sentence boundary ("Type. Capitalized...") is NOT a member access (live-sweep regression)
assert(runVaultCheck("import com.pico.spatial.core.ecs.RigidBodyComponent\n * RigidBodyComponent. Call attach(entity) first.", idx).length === 0, "prose 'Type. Word' not treated as member access");

// ── review-round-2 regressions (2026-07-13) ──
// a comment mentioning the bogus FQN must NOT suppress the code finding (shared-seen bug)
const suppress = runVaultCheck("import com.pico.spatial.core.ecs.simulation.RigidBodyMode\n// legacy: com.pico.spatial.core.ecs.simulation.RigidBodyMode.BOGUS\nval m = RigidBodyMode.BOGUS", idx);
assert(suppress.some((f) => f.check === "unknown-enum-value" && f.line === 3), "comment FQN mention does not suppress the code finding");
// SDK names inside strings / line comments are prose, not usage
assert(runVaultCheck('import com.pico.spatial.core.ecs.simulation.RigidBodyMode\nLog.d("physics", "mode must be RigidBodyMode.STATIC or DYNAMIC")', idx).length === 0, "Type.MEMBER inside a string literal is ignored");
assert(runVaultCheck("import com.pico.spatial.core.ecs.simulation.RigidBodyMode\nval m = mode // not RigidBodyMode.LEGACY", idx).length === 0, "Type.MEMBER inside a // comment is ignored");
// Type.Companion is always a known member
assert(runVaultCheck("import com.pico.spatial.core.math.Vector3\nfun Vector3.Companion.up() = Vector3(0f, 1f, 0f)", idx).length === 0, "Type.Companion is known");
// ctor-arity must not count commas inside string args or inline lambdas; trailing lambda counts as one arg
assert(runVaultCheck('import com.pico.spatial.core.math.Vector3\nval v = Vector3("a, b, c, d".length.toFloat(), 1f, 2f)', idx).length === 0, "commas inside string args not counted");
assert(runVaultCheck("import com.pico.spatial.core.math.Vector3\nval v = Vector3(listOf(1f).fold(0f) { acc, x -> acc + x }, 1f, 2f)", idx).length === 0, "commas inside inline lambda args not counted");
assert(runVaultCheck("import com.pico.spatial.core.math.Vector3\nval v = Vector3(1f, 2f, 3f) { it }", idx).length === 1, "trailing lambda counted as an argument (4 > max 3 flagged)");
// ui.* imports must not feed phase-2 checks (type-level-only vault docs)
assert(runVaultCheck("import com.pico.spatial.ui.design.ButtonSize\nval s = ButtonSize.Large", idx).length === 0, "ui.* types excluded from member/arity checks");
// the FQN and entry-import forms of a bogus enum entry are caught, not just the imported-simple-name form
const fqnBogus = runVaultCheck("val m = com.pico.spatial.core.ecs.simulation.RigidBodyMode.BOGUS", idx);
assert(fqnBogus.length === 1 && fqnBogus[0].check === "unknown-enum-value", "inline-FQN bogus enum entry caught");
const importBogus = runVaultCheck("import com.pico.spatial.core.ecs.simulation.RigidBodyMode.BOGUS", idx);
assert(importBogus.length === 1 && importBogus[0].check === "unknown-enum-value", "entry-import bogus enum entry caught");
assert(runVaultCheck("import com.pico.spatial.core.ecs.simulation.RigidBodyMode.DYNAMIC", idx).length === 0, "entry-import of a real entry silent");
// enum-entry doc must not leak onto the enum's following member (val value: Int)
const alignVal = ecs.get("AnchorComponent.Alignment")?.properties.find((p) => p.name === "value");
assert(alignVal && alignVal.doc === undefined, `enum-entry doc does not leak onto 'val value' (got ${JSON.stringify(alignVal?.doc)})`);

// ctor arity: fires outside every overload's [min,max], silent inside (defaults honored)
const arityBad = runVaultCheck("import com.pico.spatial.core.ecs.TransformComponent\nval t = TransformComponent(pos, rot)", idx);
assert(arityBad.length === 1 && arityBad[0].check === "ctor-arity" && arityBad[0].message.includes("3"), `TransformComponent(2 args) flagged, arities listed (got ${JSON.stringify(arityBad)})`);
assert(runVaultCheck("import com.pico.spatial.core.ecs.TransformComponent\nval t = TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f))", idx).length === 0, "TransformComponent(3 args) silent — nested call parens counted correctly");
assert(runVaultCheck("import com.pico.spatial.core.math.Vector3\nval v = Vector3()", idx).length === 0, "Vector3() silent (all-default ctor, minArity 0)");
assert(runVaultCheck("import com.pico.spatial.core.math.Vector3\nval v = Vector3(1f, 2f, 3f, 4f)", idx).length === 1, "Vector3(4 args) flagged (max 3)");
assert(runVaultCheck("import com.pico.spatial.core.ecs.RigidBodyComponent\nval r = RigidBodyComponent(MassProperties(5f), RigidBodyMode.DYNAMIC)", idx).length === 0, "RigidBodyComponent 2-arg ctor silent");

// ── 2c. v15.3: named-arg validation + unit advisories ───────────────────────────────────────────────────
console.log("\nv15.3 named-arg + unit-advisory checks...\n");
assert(
  runVaultCheck("import com.pico.spatial.core.ecs.RigidBodyComponent\nval r = RigidBodyComponent(massProperties = MassProperties(1f), rigidBodyMode = RigidBodyMode.DYNAMIC)", idx).filter((f) => f.check === "unknown-ctor-arg").length === 0,
  "valid named args silent",
);
const badArg = runVaultCheck("import com.pico.spatial.core.ecs.RigidBodyComponent\nval r = RigidBodyComponent(massProps = MassProperties(1f), rigidBodyMode = RigidBodyMode.DYNAMIC)", idx).filter((f) => f.check === "unknown-ctor-arg");
assert(badArg.length === 1 && badArg[0].message.includes("massProperties"), `misspelled named arg flagged with real names cited (got ${JSON.stringify(badArg)})`);
const unitAdv = runVaultCheck("import com.pico.spatial.core.ecs.SpotLightComponent\nspot.components.set(SpotLightComponent(Color4(1f, 1f, 1f, 1f), 1300f, 6f, 26f, 40f))", idx).filter((f) => f.check === "unit-advisory");
assert(unitAdv.length === 1 && unitAdv[0].severity === "info" && /innerAngle.*degrees/.test(unitAdv[0].message), `unit advisory fires on numeric literals into degree params (got ${JSON.stringify(unitAdv)})`);
assert(runVaultCheck("import com.pico.spatial.core.math.Vector3\nval v = Vector3(1f, 2f, 3f)", idx).filter((f) => f.check === "unit-advisory").length === 0, "no unit advisory when params carry no unit docs");

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
  // phase 2 generalizes two retained-lessons gotchas mechanically:
  const closest = runVaultCheck("import com.pico.spatial.core.ecs.simulation.CollisionCastHitMode\nscene.rayCast(o, d, 10f, CollisionCastHitMode.CLOSEST, g, null)", real);
  assert(closest.some((f) => f.check === "unknown-enum-value" && f.symbol.includes("CLOSEST")), "REAL vault: CollisionCastHitMode.CLOSEST caught by the generic enum check");
  assert(runVaultCheck("import com.pico.spatial.core.ecs.simulation.CollisionCastHitMode\nscene.rayCast(o, d, 10f, CollisionCastHitMode.NEAREST, g, null)", real).length === 0, "REAL vault: .NEAREST silent");
  const noArg = runVaultCheck("import com.pico.spatial.core.ecs.CollisionComponent\ne.components.set(CollisionComponent())", real);
  assert(noArg.some((f) => f.check === "ctor-arity"), "REAL vault: CollisionComponent() no-arg caught by the generic arity check");
  const rSpotInner = rSpot?.properties.find((p) => p.name === "innerAngle");
  assert(/degree/i.test(rSpotInner?.doc ?? ""), `REAL vault: SpotLightComponent innerAngle property doc mentions degrees (got ${JSON.stringify(rSpotInner?.doc)})`);
  const rUnit = runVaultCheck("import com.pico.spatial.core.ecs.SpotLightComponent\nspot.components.set(SpotLightComponent(Color4(1f, 1f, 1f, 1f), 1300f, 6f, 26f, 40f))", real).filter((f) => f.check === "unit-advisory");
  assert(rUnit.length === 1 && /degree/i.test(rUnit[0].message), "REAL vault: unit advisory fires for SpotLightComponent cone params");
  // review-round-2 live repro: PolygonFillMode.value must not carry the UNKNOWN entry's leaked doc
  const pfmVal = real.packages.get("com.pico.spatial.core.ecs.resource")?.get("PolygonFillMode")?.properties.find((p) => p.name === "value");
  assert(!/reserved value/i.test(pfmVal?.doc ?? ""), `REAL vault: PolygonFillMode.value doc not leaked from the UNKNOWN entry (got ${JSON.stringify(pfmVal?.doc)})`);
  // vault_api resolves Type.MEMBER queries to the owning type card (fake-server shim)
  const handlers = {};
  registerVaultTools({ registerTool: (name, _m, fn) => { handlers[name] = fn; } });
  const apiRes = JSON.parse((await handlers["vault_api"]({ symbol: "RigidBodyMode.DYNAMIC" })).content[0].text);
  assert(apiRes.status === "ok" && /enum entry/.test(apiRes.note ?? ""), `vault_api("RigidBodyMode.DYNAMIC") resolves to the owner type card (got status=${apiRes.status})`);
  const apiProp = JSON.parse((await handlers["vault_api"]({ symbol: "com.pico.spatial.core.ecs.SpotLightComponent.innerAngle" })).content[0].text);
  assert(apiProp.status === "ok" && /property/.test(apiProp.note ?? ""), "vault_api FQN Type.member query resolves");
  const splatImports = ["import com.pico.spatial.core.ecs.GaussianSplattingComponent", "import com.pico.spatial.core.ecs.resource.GaussianSplattingResource", "import com.pico.spatial.core.ecs.LoadType"].join("\n");
  assert(runVaultCheck(splatImports, real).length === 0, "REAL vault: splat-env imports clean (allowlist + LoadType)");
  console.log(`\n  info real vault: SDK ${real.sdkVersion}, ${real.typeCount} types across ${real.fileCount} package files`);
}

// ── Task S4: the index is keyed on the vault's CONTENT, not on its root string ────────────────
// A vault root is a directory the CLI's utility payload materializes and later replaces. The old
// memo keyed on the root string alone, so a vault swapped in place kept answering with the
// declarations of the vault that was there when the server started — an agent grounding SDK 6.1
// code against a 6.0 index it could not see.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s4-vault-"));
  const apiDir = path.join(sandbox, "knowledge", "api-reference");
  const declaration = (typeName, ctorArgs) =>
    `# com.pico.spatial.core.ecs\n# ${typeName}\npackage com.pico.spatial.core.ecs {\n    class ${typeName} {\n        constructor (${ctorArgs});\n    }\n}\n`;
  const declFile = path.join(apiDir, "com.pico.spatial.core.ecs.md");
  const typeNames = (index) => [...(index?.packages.get("com.pico.spatial.core.ecs")?.keys() ?? [])].sort();

  try {
    // never cache absence: a vault materialized AFTER the first miss must be picked up
    assert(loadVaultIndex(sandbox) === null, "S4: an absent vault is not an index");
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(declFile, declaration("AlphaComponent", "value: Float"));
    assert(
      typeNames(loadVaultIndex(sandbox)).includes("AlphaComponent"),
      "S4: a vault provisioned after an absent lookup is loaded without restarting",
    );

    // same-path replacement: new declarations at the same root are observed
    fs.writeFileSync(declFile, declaration("BetaComponent", "value: Float, unit: Int"));
    const replaced = typeNames(loadVaultIndex(sandbox));
    assert(
      replaced.includes("BetaComponent") && !replaced.includes("AlphaComponent"),
      `S4: a vault replaced at the same path is re-read (got ${JSON.stringify(replaced)})`,
    );

    // an ADDED declaration file changes the index too (sorted filenames + content hashes)
    fs.writeFileSync(path.join(apiDir, "com.pico.spatial.core.math.md"),
      "# com.pico.spatial.core.math\n# Vector3\npackage com.pico.spatial.core.math {\n    class Vector3 {\n        constructor (x: Float);\n    }\n}\n");
    assert(loadVaultIndex(sandbox)?.fileCount === 2, "S4: an added declaration file changes the index");

    // package metadata is part of the key: a re-materialized vault's revision is not stale
    fs.writeFileSync(path.join(sandbox, "package.xml"), "<x><revision><major>6</major><minor>0</minor><micro>0</micro></revision></x>");
    assert(loadVaultIndex(sandbox)?.sdkVersion === "6.0.0", "S4: package.xml revision is read");
    fs.writeFileSync(path.join(sandbox, "package.xml"), "<x><revision><major>6</major><minor>1</minor><micro>0</micro></revision></x>");
    assert(loadVaultIndex(sandbox)?.sdkVersion === "6.1.0", "S4: a changed package.xml revision invalidates the cached index");

    // removal: a successful entry must not survive its inputs
    fs.rmSync(declFile);
    fs.rmSync(path.join(apiDir, "com.pico.spatial.core.math.md"));
    assert(loadVaultIndex(sandbox) === null, "S4: removing every declaration file removes the cached index");

    // the fixture vault still loads beside the sandbox (per-root entries do not collide)
    assert((loadVaultIndex(FIXTURE)?.typeCount ?? 0) > 0, "S4: a second root is unaffected by the first root's cache");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(`\nVault test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
