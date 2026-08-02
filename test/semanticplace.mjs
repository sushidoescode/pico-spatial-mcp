// v17.0 semantic-placement test: label-anchored resolution over labeled 3D boxes.
// Fixture mirrors the REAL ramen-world labels (semantic_splat_scan verified 2026-07-12):
// counter, neon sign, menu board, light fixtures, floor. Run: npm run test:semantic
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSemanticPlacement, resolveAnchors, labelScore, loadSemanticScene } from "../dist/semanticplace.js";
import { buildLedger } from "../dist/compiler.js";
import { planSplatAssets, prepareFleetSemanticAnchors, pushSplatAssets } from "../dist/fleetbuild.js";
import { appSpecSchema } from "../dist/appspec.js";

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
const fleetBad = prepareFleetSemanticAnchors(specBad);
assert(
  fleetBad.ok === false && JSON.stringify(fleetBad.unresolvedObjectIds) === JSON.stringify(["scoreboard"]) && fleetBad.notes.some((n) => n.includes("NOT resolved")),
  `fleet fails closed instead of launching an unresolved semantic marker at a fallback pose (${JSON.stringify(fleetBad)})`,
);
const fleetResolved = prepareFleetSemanticAnchors(spec);
assert(
  fleetResolved.ok === true && fleetResolved.unresolvedObjectIds.length === 0 && fleetResolved.notes.some((n) => n.includes("anchored")),
  `fleet preserves successful semantic-placement notes (${JSON.stringify(fleetResolved.notes)})`,
);

// loadSemanticScene tolerates the compose_semantic_scene wrapper shape
fs.writeFileSync(sceneFile, JSON.stringify({ semantic: { objects: scene.objects }, placement: { floorY: 0 }, bounds: scene.bounds }));
const wrapped = loadSemanticScene(sceneFile);
assert(wrapped && wrapped.objects.length === 6 && wrapped.floorY === 0, "loadSemanticScene reads the wrapped compose output shape");

console.log("\nSplat compile + fleet delivery contract...\n");
const splatRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico-mcp-splat-delivery-"));
const splatSource = path.join(splatRoot, "Fantasy World #1.ply");
fs.writeFileSync(splatSource, "ply\nformat ascii 1.0\nend_header\n");
const splatSpec = appSpecSchema.parse({
  ...spec,
  scenes: [{
    id: "s",
    environment: {
      kind: "splat",
      asset: splatSource,
      params: {
        packageName: "com.bad.override",
        kind: "skybox",
        assetFileName: "/tmp/unsafe override.ply",
        delivery: "asset",
        translate: { x: 1, y: 2, z: 3 },
        rotationEuler: { x: 0, y: 180, z: 0 },
        scale: 1.25,
      },
    },
    lighting: { rig: "none" },
    colliders: { props: [] },
    transitions: [],
  }],
  objects: [],
});
const splatLedger = buildLedger(splatSpec, "/tmp/fleet-splat");
const splatGenerator = splatLedger.find((step) => step.tool === "generate_environment_kotlin");
assert(
  splatGenerator?.args?.assetFileName === "Fantasy_World_1.ply" && !splatGenerator.args.assetFileName.includes(splatRoot) &&
    splatGenerator?.args?.delivery === "storage" && splatGenerator?.args?.kind === "splat" &&
    splatGenerator?.args?.packageName === "com.example.anchor.content",
  `absolute splat path compiles to canonical runtime args that params cannot override (got ${JSON.stringify(splatGenerator?.args)})`,
);
assert(
  JSON.stringify(splatGenerator?.args?.translate) === JSON.stringify({ x: 1, y: 2, z: 3 }) &&
    splatGenerator?.args?.rotationEuler?.y === 180 && splatGenerator?.args?.scale === 1.25,
  `splat calibration params survive AppSpec -> compiler (${JSON.stringify(splatGenerator?.args)})`,
);

const packageName = "com.fleet.secondworld";
const deliveryPlan = planSplatAssets(splatSpec, packageName);
const planned = deliveryPlan.assets?.[0];
assert(
  deliveryPlan.ok === true && planned?.fileName === splatGenerator?.args?.assetFileName &&
    planned?.remotePath === `/sdcard/Android/data/${packageName}/files/Fantasy_World_1.ply` &&
    planned?.bytes === fs.statSync(splatSource).size && /^[a-f0-9]{64}$/.test(planned?.sha256 ?? ""),
  `fleet plans a hashed, size-bounded app-files delivery (${JSON.stringify(deliveryPlan)})`,
);

const calls = [];
const pushed = await pushSplatAssets(deliveryPlan.assets, {
  adbPath: "/fake/adb",
  serial: "emulator-5554",
  runner: async (file, args) => {
    calls.push([file, args]);
    if (args.includes("stat")) return { stdout: `${planned.bytes}\n`, stderr: "" };
    if (args.includes("sha256sum")) return { stdout: `${planned.sha256}  ${planned.remotePath}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  },
});
assert(
  pushed.ok === true && pushed.assets?.[0]?.remoteBytes === planned.bytes && pushed.assets?.[0]?.remoteSha256 === planned.sha256,
  `fleet verifies remote splat size + sha256 after push (${JSON.stringify(pushed)})`,
);
assert(
  calls.length === 4 && calls[0][1].includes("mkdir") && calls[1][1].includes("push") && calls[2][1].includes("stat") && calls[3][1].includes("sha256sum") &&
    calls.every(([, args]) => args[0] === "-s" && args[1] === "emulator-5554"),
  `delivery is serial-scoped mkdir -> push -> stat -> sha256 (${JSON.stringify(calls)})`,
);

const badRemote = await pushSplatAssets(deliveryPlan.assets, {
  adbPath: "/fake/adb",
  runner: async (_file, args) => args.includes("stat")
    ? { stdout: `${planned.bytes + 1}\n`, stderr: "" }
    : args.includes("sha256sum")
      ? { stdout: `${planned.sha256}  ${planned.remotePath}\n`, stderr: "" }
      : { stdout: "", stderr: "" },
});
assert(badRemote.ok === false && badRemote.errors?.some((error) => /size mismatch/i.test(error)), "remote size mismatch fails closed before launch");

const badHash = await pushSplatAssets(deliveryPlan.assets, {
  adbPath: "/fake/adb",
  runner: async (_file, args) => args.includes("stat")
    ? { stdout: `${planned.bytes}\n`, stderr: "" }
    : args.includes("sha256sum")
      ? { stdout: `${"0".repeat(64)}  ${planned.remotePath}\n`, stderr: "" }
      : { stdout: "", stderr: "" },
});
assert(badHash.ok === false && badHash.errors?.some((error) => /sha256 mismatch/i.test(error)), "remote hash mismatch fails closed before launch");

const malformedRemote = await pushSplatAssets(deliveryPlan.assets, {
  adbPath: "/fake/adb",
  runner: async (_file, args) => args.includes("stat")
    ? { stdout: "not-a-size\n", stderr: "" }
    : { stdout: "", stderr: "" },
});
assert(malformedRemote.ok === false && malformedRemote.errors?.some((error) => /remote size/i.test(error)), "unparseable remote evidence fails closed");

const runnerFailure = await pushSplatAssets(deliveryPlan.assets, {
  adbPath: "/fake/adb",
  runner: async () => { throw new Error("adb transport lost"); },
});
assert(runnerFailure.ok === false && runnerFailure.errors?.some((error) => /adb transport lost/i.test(error)), "ADB delivery errors fail closed");

const physicalSerial = await pushSplatAssets(deliveryPlan.assets, {
  adbPath: "/fake/adb",
  serial: "Swan-physical-001",
  runner: async () => ({ stdout: "", stderr: "" }),
});
assert(physicalSerial.ok === false && physicalSerial.errors?.some((error) => /emulator/i.test(error)), "fleet splat delivery rejects physical-device serials");

const symlinkPath = path.join(splatRoot, "linked.ply");
fs.symlinkSync(splatSource, symlinkPath);
const symlinkPlan = planSplatAssets({ ...splatSpec, scenes: [{ ...splatSpec.scenes[0], environment: { kind: "splat", asset: symlinkPath } }] }, packageName);
assert(symlinkPlan.ok === false && symlinkPlan.errors?.some((error) => /symbolic link/i.test(error)), "splat delivery rejects a symlink source");

const wrongType = path.join(splatRoot, "world.glb");
fs.writeFileSync(wrongType, "glb");
const wrongTypePlan = planSplatAssets({ ...splatSpec, scenes: [{ ...splatSpec.scenes[0], environment: { kind: "splat", asset: wrongType } }] }, packageName);
assert(wrongTypePlan.ok === false && wrongTypePlan.errors?.some((error) => /\.ply or \.spz/i.test(error)), "a GLB cannot masquerade as a splat delivery");

const collisionA = path.join(splatRoot, "a", "world one.ply");
const collisionB = path.join(splatRoot, "b", "world#one.ply");
fs.mkdirSync(path.dirname(collisionA), { recursive: true });
fs.mkdirSync(path.dirname(collisionB), { recursive: true });
fs.writeFileSync(collisionA, "a");
fs.writeFileSync(collisionB, "b");
const collisionPlan = planSplatAssets({
  ...splatSpec,
  scenes: [
    { ...splatSpec.scenes[0], id: "a", environment: { kind: "splat", asset: collisionA } },
    { ...splatSpec.scenes[0], id: "b", environment: { kind: "splat", asset: collisionB } },
  ],
}, packageName);
assert(collisionPlan.ok === false && collisionPlan.errors?.some((error) => /collision/i.test(error)), "different splats cannot silently overwrite one remote basename");

const secondSplatSource = path.join(splatRoot, "second.spz");
fs.writeFileSync(secondSplatSource, "SPZ fixture");
const conflictingSplatSpec = {
  ...splatSpec,
  scenes: [
    splatSpec.scenes[0],
    {
      ...splatSpec.scenes[0],
      id: "second",
      environment: {
        kind: "splat",
        asset: secondSplatSource,
        params: { scale: 2 },
      },
    },
  ],
};
const conflictingSplats = appSpecSchema.safeParse(conflictingSplatSpec);
assert(
  conflictingSplats.success === false && conflictingSplats.error.issues.some((issue) => /splat|SplatEnvironment|configuration/i.test(issue.message)),
  "AppSpec rejects conflicting multi-scene splats that would overwrite one SplatEnvironment.kt",
);

const sharedSplatSpec = appSpecSchema.parse({
  ...splatSpec,
  scenes: [splatSpec.scenes[0], { ...splatSpec.scenes[0], id: "shared-second" }],
});
const sharedSplatSteps = buildLedger(sharedSplatSpec, "/tmp/fleet-shared-splat").filter(
  (step) => step.tool === "generate_environment_kotlin" && step.args?.kind === "splat",
);
assert(sharedSplatSteps.length === 1, `identical multi-scene splat config emits one shared generator (${sharedSplatSteps.length})`);
const sharedSplatPlan = planSplatAssets(sharedSplatSpec, packageName);
assert(
  sharedSplatPlan.ok === true && sharedSplatPlan.assets.length === 1 &&
    JSON.stringify(sharedSplatPlan.assets[0].sceneIds) === JSON.stringify(["s", "shared-second"]),
  `identical multi-scene splat delivery is deduplicated with both scene ids (${JSON.stringify(sharedSplatPlan)})`,
);

const fleetSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/fleetbuild.ts"), "utf8");
const semanticGateAt = fleetSource.indexOf("const semanticPlacement = prepareFleetSemanticAnchors(parsed.data)");
const semanticFailureAt = fleetSource.indexOf("semantic placement unresolved for object(s)", semanticGateAt);
const ledgerAt = fleetSource.indexOf("const steps = buildLedger(spec", semanticGateAt);
assert(
  semanticGateAt >= 0 && semanticFailureAt > semanticGateAt && ledgerAt > semanticFailureAt,
  "fleet rejects unresolved semantic anchors before code generation/build",
);
const installAt = fleetSource.indexOf('"install", "-r", apk');
const pushAt = fleetSource.indexOf("pushSplatAssets(", installAt);
const pushFailureAt = fleetSource.indexOf("splat delivery failed", pushAt);
const launchAt = fleetSource.indexOf("await launchApp()", installAt);
assert(installAt >= 0 && pushAt > installAt && pushFailureAt > pushAt && launchAt > pushFailureAt, "fleet invokes fail-closed splat delivery after install and before launch");

const secondWorldEntry = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../briefs/stationsemantic.json"), "utf8"));
const secondWorldParsed = appSpecSchema.safeParse(secondWorldEntry.spec);
assert(secondWorldParsed.success, `second-world brief parses through AppSpec (${secondWorldParsed.success ? "ok" : JSON.stringify(secondWorldParsed.error.issues)})`);
if (secondWorldParsed.success) {
  const marker = secondWorldParsed.data.objects.find((object) => object.id === "screenMarker");
  assert(
    secondWorldParsed.data.scenes[0]?.environment?.kind === "splat" && marker?.anchorTo?.label === "display screen bank" && !marker?.transform?.position,
    "second-world brief is genuinely splat + anchorTo authored (no hand-baked marker position)",
  );
  const secondLedger = buildLedger(secondWorldParsed.data, "/tmp/fleet-stationsemantic");
  const secondGenerator = secondLedger.find((step) => step.tool === "generate_environment_kotlin");
  assert(
    secondGenerator?.args?.assetFileName === "Futuristic_Space_Station_Interior.ply" && secondGenerator?.args?.rotationEuler?.y === 32.101,
    `second-world compiler preserves the safe asset name + calibrated world transform (${JSON.stringify(secondGenerator?.args)})`,
  );
  const portableSemanticPath = path.join(splatRoot, "station-semantic-fixture.json");
  fs.writeFileSync(portableSemanticPath, JSON.stringify({
    objects: [{
      id: 6,
      label: "display screen bank",
      center: [0.034, 1.896, -1.253],
      size: [0.249, 1.006, 0.214],
      confidence: 0.153,
      labelEvidence: "vision_confirmed",
    }],
    relationships: [],
    floorY: 0.072,
    bounds: { min: [-4.28, -0.395, -2.053], max: [4.347, 2.57, 6.804] },
  }));
  const portableSecondSpec = structuredClone(secondWorldParsed.data);
  portableSecondSpec.meta.semanticScenePath = portableSemanticPath;
  const portableSecondLedger = buildLedger(portableSecondSpec, "/tmp/fleet-stationsemantic-portable");
  const secondWiring = portableSecondLedger.find((step) => step.tool === "generate_app_wiring");
  const bakedMarker = secondWiring?.args?.spec?.objects?.find((object) => object.id === "screenMarker");
  assert(
    JSON.stringify(bakedMarker?.transform?.position) === JSON.stringify([0.214, 1.432, -0.966]),
    `portable second-world semantic fixture bakes the looked-at display bank pose (${JSON.stringify(bakedMarker?.transform?.position)})`,
  );

  const semanticOnHost = fs.existsSync(secondWorldParsed.data.meta.semanticScenePath ?? "");
  if (semanticOnHost) {
    const liveWiring = secondLedger.find((step) => step.tool === "generate_app_wiring");
    const liveMarker = liveWiring?.args?.spec?.objects?.find((object) => object.id === "screenMarker");
    assert(
      JSON.stringify(liveMarker?.transform?.position) === JSON.stringify(bakedMarker?.transform?.position),
      `persisted scan artifact matches the portable regression pose (${JSON.stringify(liveMarker?.transform?.position)})`,
    );
  } else {
    ok("skip host-artifact parity: persisted scan evidence is not installed on this machine");
  }
}

// ── v29.4: the wiring must route EVERY channel the mouse bridge sends to a menu app ──────────────
// Found on com.fleet.knockdown (2026-07-28): the generated GameMenu ships nudgePanelCmd + hover, and
// the bridge streams `move:dx,dy,dz` on a title-drag — but the generated dispatchDebugCommand never
// routed `move:` (or menu `hover:`), so the panel was undraggable in every generated app while the
// hand-edited demo apps worked. Guard the emission contract itself.
{
  const { generateWiring } = await import("../dist/assemble.js");
  const knockdown = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "briefs", "knockdown.json"), "utf8"));
  const menuSpec = appSpecSchema.parse(knockdown.spec);
  const files = generateWiring(menuSpec);
  const home = files.find((f) => f.path.endsWith("HomeStage.kt"))?.content ?? "";
  assert(home.includes('cmd.startsWith("move:") -> GameMenu.nudgePanelCmd(cmd.removePrefix("move:"))'),
    "menu app wiring routes move: to GameMenu.nudgePanelCmd (bridge panel-drag)");
  assert(/cmd\.startsWith\("hover:"\)[^\n]*GameMenu\.hover/.test(home),
    "menu app wiring routes menu hover: actions to GameMenu.hover");
  assert(home.includes('cmd in setOf("start", "pause", "resume", "reset")'),
    "menu app wiring still routes the four select actions");
  const noMenuSpec = appSpecSchema.parse({ ...knockdown.spec, interactions: [] });
  const noMenuHome = generateWiring(noMenuSpec).find((f) => f.path.endsWith("HomeStage.kt"))?.content ?? "";
  assert(!noMenuHome.includes("GameMenu"), "menu-free wiring emits no GameMenu references");
}

fs.unlinkSync(sceneFile);
fs.rmSync(splatRoot, { recursive: true, force: true });
console.log(`\nSemantic-placement test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
