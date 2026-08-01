// v30.2 surface placement: the generator that seats a baked model on a DETECTED plane.
// Every assertion is a trap that was hit by hand on 2026-07-29 while building the MR data tabletop;
// each one is silent (the app builds, runs, and looks plausibly wrong), so it has to be a gate.
// Run: npm run test:surfaceplace
import { surfacePlacementKotlin } from "../dist/surfaceplace.js";
import { runLint } from "../dist/lint.js";
import { buildLedger } from "../dist/compiler.js";
import { appSpecSchema } from "../dist/appspec.js";

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
assert(/surface\.y \+ BASE_LIFT/.test(kt) && !/FLOOR_Y|floorHeight\s*=/.test(kt),
  "TRAP 2: height comes from the detected plane, never a hardcoded floor constant");
assert(/root\.convertPositionFrom\(anchor\.transform\.position, null\)/.test(kt),
  "TRAP 3: converts anchor space into the root's space");
assert(/BASE_LIFT = 0\.4187f/.test(kt),
  "TRAP 4: origin-CENTRE model lifted by half its height (0.8373/2 = 0.4187)");
assert(/ShapeResource\.createBox/.test(kt) && !/createConvexMesh|createStaticMesh/.test(kt),
  "TRAP 5: PRIMITIVE box collider only (mesh colliders never register on PICO)");
assert(/PhysicsWorldComponent\(\)/.test(kt),
  "collider carries the REQUIRED PhysicsWorldComponent");
// TRAP 6 is the one that cost a whole debugging round on 2026-07-29: the table WAS seated, on the
// right plane, at the right height — 1.82 m to the user's right, ~83 deg off the view axis, so it
// read as "the table never appeared". Height from the plane; X/Z from the USER; clamped to the rect.
assert(/FRONT_DIST = 1\.6f/.test(kt) && /\(-FRONT_DIST\)\.coerceIn/.test(kt) && /0f\.coerceIn/.test(kt),
  "TRAP 6: a FLOOR-seated model stands in FRONT of the user, clamped into the plane rectangle");
assert(/surface\.y \+ BASE_LIFT/.test(kt) && !/Vector3\(surface\.x, surface\.y \+ BASE_LIFT, surface\.z\)/.test(kt),
  "TRAP 6: FLOOR takes the plane's HEIGHT but never its X/Z centroid");

// ── contract ────────────────────────────────────────────────────────────────────────────────────
assert(kt.startsWith("package com.demo.app.content"), "emits into the requested package");
assert(/object TablePlacement \{/.test(kt), "object named as requested");
assert(/suspend fun seat\(root: Entity, add: \(Entity\) -> Unit\): Entity\?/.test(kt), "seat() signature is stable");
assert(/BUNDLE = "asset:\/\/table\.bundle"/.test(kt) && /MODEL = "Meshy_table"/.test(kt), "bundle + model wired");
assert(/semantics\.name == "FLOOR"/.test(kt), "targets the requested semantic label");
assert(/maxByOrNull \{ it\.boundingBoxSize\.x \* it\.boundingBoxSize\.y \}/.test(kt),
  "largest matching plane wins (a 0.2m shelf is a poor floor)");
// Fallback must be by HEIGHT, not orientation: measured across two PICO home environments, the
// convention FLIPS (room A: FLOOR=UPWARD; room B: FLOOR=DOWNWARD with CEILING=UPWARD), so an
// orientation filter picks the CEILING in room B.
assert(/minByOrNull \{ it\.transform\.position\.y \}/.test(kt) && /startsWith\("HORIZONTAL"\)/.test(kt),
  "FLOOR fallback picks the LOWEST large horizontal plane (orientation flips between rooms)");

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

  // An object-sized plane is the opposite case: a TABLE's centroid IS where you want the model,
  // and re-aiming it at the user would slide it off the table.
  const table = surfacePlacementKotlin({ ...base, semantic: "TABLE" });
  assert(/Vector3\(surface\.x, surface\.y \+ BASE_LIFT, surface\.z\)/.test(table) && !/FRONT_DIST/.test(table),
    "object-sized surfaces (TABLE) still seat at the plane centroid, not in front of the user");

  const wall = surfacePlacementKotlin({ ...base, semantic: "WALL" });
  assert(/semantics\.name == "WALL"/.test(wall) && /VERTICAL/.test(wall),
    "WALL target falls back to VERTICAL planes, not horizontal");

  const ceil = surfacePlacementKotlin({ ...base, semantic: "CEILING" });
  assert(/maxByOrNull \{ it\.transform\.position\.y \}/.test(ceil), "CEILING fallback picks the HIGHEST horizontal plane");

  const none = surfacePlacementKotlin({ ...base, collider: "none" });
  assert(!/CollisionComponent\(/.test(none) && !/makeCollider/.test(none), "collider:none emits no collider");

  const full = surfacePlacementKotlin({ ...base, collider: "boxFull" });
  assert(/val slabH = SIZE_Y/.test(full), "collider:boxFull uses the whole model height");
}

// ── determinism (the repo's standing rule for generators) ────────────────────────────────────────
assert(surfacePlacementKotlin(base) === kt, "deterministic: same options -> byte-identical Kotlin");

// ── v31 seatOn: AppSpec validation + compiler lowering (pure zod + ledger — no emulator) ─────────
{
  const spec = {
    meta: { appName: "MrTable", packageName: "com.demo.mrtable", stageStyle: "1", brief: "seat a kraken on the floor" },
    scenes: [{ id: "main", environment: { kind: "procedural" } }],
    objects: [{ id: "kraken", sceneId: "main", source: "model", seatOn: { semantic: "FLOOR", asset: "/tmp/models/kraken.glb", offset: [0, 0, -0.2] } }],
    navigation: { startScene: "main", portals: [] },
  };
  const parsed = appSpecSchema.safeParse(spec);
  assert(parsed.success, "seatOn: a valid seatOn object parses");
  if (parsed.success) {
    const ledger = buildLedger(parsed.data, "/tmp/proj");
    const measure = ledger.find((s) => s.tool === "measure_model");
    const bake = ledger.find((s) => s.tool === "bake_textured_model");
    const place = ledger.find((s) => s.tool === "generate_surface_placement_kotlin");
    assert(measure && bake && place, "seatOn lowers to measure_model -> bake_textured_model -> generate_surface_placement_kotlin");
    assert(measure && bake && place && measure.order < bake.order && bake.order < place.order,
      "seatOn steps are ordered measure -> bake -> place");
    assert(place && place.args.semantic === "FLOOR" && place.args.packageName === "com.demo.mrtable.content",
      "placement args prefilled: semantic target + content package");
    assert(place && place.cClass === "C0_emulator",
      "seatOn placement is C0_emulator (planes ARE detected on the emulator — 2026-07-29 measured)");
    assert(place && place.args.bundleAsset === "asset://kraken.bundle" && bake.args.outBundle === "/tmp/proj/app/src/main/assets/kraken.bundle",
      "bundle ref derived from the seatOn asset stem");
    assert(place && String(place.args.modelSize).startsWith("<") && String(place.args.baseLift).startsWith("<"),
      "measured args are LOUD placeholders (tool rejects them unfilled), never guessed numbers");
    assert(place && place.targetPath.endsWith("/content/KrakenPlacement.kt"), "placement Kotlin lands in the content package");
    assert(place && place.note.includes("offset"), "seatOn.offset surfaces in the ledger note (the generator has no offset arg yet)");
  }

  // exclusivity: one placement authority per object; the pipeline needs a bakeable model
  const objBase = spec.objects[0];
  const withAnchor = { ...spec, objects: [{ ...objBase, anchorTo: { label: "floor", relation: "on" } }] };
  assert(!appSpecSchema.safeParse(withAnchor).success, "seatOn + anchorTo is rejected (two placement authorities)");
  const withBody = { ...spec, objects: [{ ...objBase, body: { mode: "dynamic", shape: "sphere", dims: [0.1] } }] };
  assert(!appSpecSchema.safeParse(withBody).success, "seatOn + body is rejected (bodies are placed at compile-time positions)");
  const asQuad = { ...spec, objects: [{ ...objBase, source: "quad" }] };
  assert(!appSpecSchema.safeParse(asQuad).success, "seatOn on a non-model source is rejected (nothing to measure/bake)");
}

// ── v31 panels[].placement: 'world' compiles to the dock path with the LOUD fallback note ────────
{
  const spec = {
    meta: { appName: "Hud", packageName: "com.demo.hud", stageStyle: "3", brief: "world hud" },
    scenes: [{ id: "main", environment: { kind: "procedural" } }],
    panels: [
      { id: "score", title: "SCORE", placement: { kind: "world", position: [0, 1.4, -2] } },
      { id: "info", title: "INFO" },
    ],
    navigation: { startScene: "main", portals: [] },
  };
  const parsed = appSpecSchema.safeParse(spec);
  assert(parsed.success, "panels[].placement parses (kind world + default dock)");
  if (parsed.success) {
    const ledger = buildLedger(parsed.data, "/tmp/proj");
    const steps = ledger.filter((s) => s.tool === "generate_panel_compose_kotlin");
    const world = steps.find((s) => s.node === "score");
    const dock = steps.find((s) => s.node === "info");
    assert(world && world.args.placement === "world" && world.note.includes("world placement pending SDK confirmation — head-docked fallback"),
      "world panel: dock path + the LOUD pending-SDK fallback note (never an invented world-position API)");
    assert(dock && dock.args.placement === undefined && !dock.note.includes("WORLD PLACEMENT"),
      "default panel: unchanged dock lowering");
  }
}

// ── v31 GameMenu custom labels: params.label/params.button thread through bake_menu_panel ────────
{
  const meta = { appName: "Knockdown", packageName: "com.demo.knock", stageStyle: "3", brief: "drop ball" };
  const scenes = [{ id: "main", environment: { kind: "procedural" } }];
  const navigation = { startScene: "main", portals: [] };
  const custom = appSpecSchema.safeParse({
    meta, scenes, navigation,
    interactions: [
      { id: "drop", trigger: "press", target: "menu", action: "launch:ball", params: { label: "DROP BALL" } },
      { id: "rerack", trigger: "press", target: "menu", action: "resetWorld", params: { label: "RERACK" } },
    ],
  });
  assert(custom.success, "press interactions with params.label parse");
  if (custom.success) {
    const ledger = buildLedger(custom.data, "/tmp/proj");
    const bakeMenu = ledger.find((s) => s.tool === "bake_menu_panel");
    const menu = ledger.find((s) => s.tool === "generate_game_menu_kotlin");
    assert(bakeMenu && menu && bakeMenu.order < menu.order, "custom labels lower a bake_menu_panel step BEFORE the menu codegen");
    assert(bakeMenu && bakeMenu.args.labels.length === 4 && bakeMenu.args.labels[0] === "DROP BALL" && bakeMenu.args.labels[1] === "RERACK",
      "brief labels render on the baked panel texture (padded to the 4-row layout)");
    assert(bakeMenu && bakeMenu.args.actions[0] === "start" && bakeMenu.args.actions[1] === "reset",
      "actions keep the wiring's inferred builtin names (launch:* -> start, resetWorld -> reset) so dispatch/bridge still route");
    assert(bakeMenu && bakeMenu.args.outBundle === "/tmp/proj/app/src/main/assets/menu.bundle", "custom panel bakes straight to assets/menu.bundle");
    assert(menu && Array.isArray(menu.args.buttons) && menu.args.buttons[0].action === "start" && menu.args.buttons[0].rowPx === 205,
      "menu codegen rows prefilled at the verified row centres (205/315/425/535)");
  }
  const plain = appSpecSchema.safeParse({
    meta, scenes, navigation,
    interactions: [{ id: "go", trigger: "press", target: "menu", action: "launch:ball" }],
  });
  assert(plain.success, "plain press interactions parse");
  if (plain.success) {
    const ledger = buildLedger(plain.data, "/tmp/proj");
    assert(!ledger.some((s) => s.tool === "bake_menu_panel"), "no custom labels -> no bake_menu_panel step (verified default panel)");
    const menu = ledger.find((s) => s.tool === "generate_game_menu_kotlin");
    assert(menu && menu.args.buttons === undefined, "no custom labels -> the generator keeps its verified default rows");
  }
  const tooMany = appSpecSchema.safeParse({
    meta, scenes, navigation,
    interactions: ["a", "b", "c", "d", "e"].map((b, i) => (
      { id: `p${i}`, trigger: "press", target: "menu", action: "go", params: { button: b } }
    )),
  });
  assert(!tooMany.success, "more than 4 distinct menu buttons is rejected (the panel is a 4-row texture)");
}

console.log(`\nSurface-placement test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
