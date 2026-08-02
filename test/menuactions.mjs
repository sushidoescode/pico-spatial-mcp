// v31.3 menu-action reachability + physics truth + panel hide/show — the three codegen gaps the
// claude-sonnet-5 putting-green experiment exposed (ledger com.fleet.door671805, 2026-08-01):
//  1. A CUSTOM menu button ('putt') had its GameMenu row + customActions closure but the generated
//     dispatchDebugCommand/hover whitelist hardcoded start|pause|resume|reset — the closure was
//     UNREACHABLE by broadcast. The whitelist must be derived from the spec's actual buttons.
//  2. body {mode:'static', shape:'capsule'} silently coerced to dynamicCapsule (a static flag pole
//     FELL). Vault-grounded fix: CollisionComponent with no RigidBody accepts capsule/sphere shapes,
//     so ScenePhysics gains staticCapsule/staticSphere and the wiring routes static shapes to them.
//  3. panel:show/panel:hide (rocketsim-proven: the head-docked panel occludes the fixed emulator
//     pose) must be standard wiring for ANY spec with panels — show from the APP'S OWN context
//     (shell am start is refused while the Stage holds Full Space), hide via the instance companion.
// Fully deterministic: dist imports + fake-server tool shims. No emulator, no adb, no server spawn.
// Run: node test/menuactions.mjs
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };
const assert = (c, m) => (c ? ok(m) : fail(m));

const { appSpecSchema } = await import("../dist/appspec.js");
const { generateWiring } = await import("../dist/assemble.js");
const { buildLedger } = await import("../dist/compiler.js");
const { registerPhysicsTools } = await import("../dist/physics.js");
const { registerPanelComposeTools } = await import("../dist/panelcompose.js");

// Fake-server shim (the test/vault.mjs pattern): capture handlers, call them directly.
const handlers = {};
const shim = { registerTool: (name, _meta, fn) => { handlers[name] = fn; } };
registerPhysicsTools(shim);
registerPanelComposeTools(shim);

// ── the putting-green-shaped spec: custom 'putt' button, static capsule flag, hud panel ──────────
const meta = { appName: "PuttXR", packageName: "com.test.putt", stageStyle: "3", brief: "mini putting green" };
const navigation = { startScene: "main", portals: [] };
const puttSpec = appSpecSchema.parse({
  meta, navigation,
  scenes: [{ id: "main", environment: { kind: "procedural" }, lighting: { rig: "sun" }, physics: {} }],
  objects: [
    { id: "green", sceneId: "main", source: "primitive", transform: { position: [0, 0.05, -2.5] }, body: { mode: "static", shape: "box", dims: [3, 0.1, 3] } },
    { id: "ball", sceneId: "main", source: "primitive", transform: { position: [0, 0.2, -1.5] }, body: { mode: "dynamic", shape: "sphere", dims: [0.021], mass: 0.046 } },
    { id: "flag", sceneId: "main", source: "primitive", transform: { position: [0.4, 0.6, -3.2] }, body: { mode: "static", shape: "capsule", dims: [1.0, 0.02] } },
    { id: "dome", sceneId: "main", source: "primitive", transform: { position: [-0.8, 0.25, -3] }, body: { mode: "static", shape: "sphere", dims: [0.3] } },
  ],
  interactions: [
    { id: "putt", trigger: "press", target: "ball", action: "launch:ball", params: { button: "putt", label: "PUTT", velocity: [0, 0, -2] } },
    { id: "rerack", trigger: "press", target: "ball", action: "resetWorld", params: { button: "reset" } },
  ],
  panels: [{ id: "hud", title: "PUTT", fields: [
    { key: "throws", label: "PUTTS", initial: "0" },
    { key: "status", label: "STATUS", initial: "READY" },
  ] }],
});
const files = generateWiring(puttSpec);
const home = files.find((f) => f.path.endsWith("HomeStage.kt"))?.content ?? "";
const comp = files.find((f) => f.path.endsWith("SceneComposition.kt"))?.content ?? "";

// 1) the custom action is in the DISPATCHER's routing, not just the customActions map
const selectLine = home.split("\n").find((l) => l.includes("GameMenu.select(cmd)")) ?? "";
assert(/cmd in setOf\([^)]*"putt"[^)]*\)/.test(selectLine), "dispatcher select whitelist contains the custom 'putt' button");
for (const b of ["start", "pause", "resume", "reset"]) {
  assert(selectLine.includes(`"${b}"`), `dispatcher select whitelist keeps builtin '${b}'`);
}
const hoverLine = home.split("\n").find((l) => l.includes("GameMenu.hover(")) ?? "";
assert(/setOf\([^)]*"putt"[^)]*"none"\)|setOf\([^)]*"none"[^)]*"putt"[^)]*\)/.test(hoverLine), "hover whitelist contains 'putt' (and 'none')");
assert(home.includes('"putt" to {'), "customActions still carries the 'putt' closure");
assert(home.includes("HudState.onLaunch()"), "the 'putt' closure fires the HUD onLaunch hook");

// 2) static capsule/sphere generate the STATIC helpers — the silent dynamic coercion is gone
assert(comp.includes('ScenePhysics.staticCapsule(root, "flag"'), "static+capsule body emits ScenePhysics.staticCapsule");
assert(!comp.includes('ScenePhysics.dynamicCapsule(root, "flag"'), "static+capsule no longer coerces to dynamicCapsule");
assert(comp.includes('ScenePhysics.staticSphere(root, "dome"'), "static+sphere body emits ScenePhysics.staticSphere");
assert(comp.includes('ScenePhysics.dynamicSphere(root, "ball"'), "dynamic sphere still emits dynamicSphere");
assert(comp.includes('ScenePhysics.staticBox(root, "green"'), "static box unchanged");

// ...and the generated ScenePhysics.kt actually defines them (vault-grounded static colliders)
const physRes = await handlers["generate_rigidbody_kotlin"]({ packageName: "com.test.putt.content" });
const physKt = physRes.content[0].text;
assert(physKt.includes("fun staticCapsule(") && physKt.includes("ShapeResource.createCapsule(height, radius)"),
  "ScenePhysics.kt defines staticCapsule on ShapeResource.createCapsule");
assert(/fun staticCapsule[^\n]*\n[^\n]*createCapsule\(height, radius\)[^\n]*dynamic = false, mass = 0f/.test(physKt),
  "staticCapsule is a TRUE static body (no RigidBody path: dynamic=false)");
assert(physKt.includes("fun staticSphere(") && /fun staticSphere[^\n]*\n[^\n]*createSphere\(radius\)[^\n]*dynamic = false/.test(physKt),
  "ScenePhysics.kt defines staticSphere as a true static body");

// 3) panel:show / panel:hide are standard wiring for any spec with panels
assert(home.includes('cmd == "panel:show"') && home.includes("FLAG_ACTIVITY_NEW_TASK") && home.includes("HudPanelActivity::class.java"),
  "panel:show starts HudPanelActivity with NEW_TASK");
assert(home.includes("appCtxRef") && /appCtxRef = appCtx/.test(home),
  "panel:show uses the app's own context captured in the composable (shell am start is refused in Full Space)");
assert(home.includes('cmd == "panel:hide"') && home.includes("HudPanelActivity.instance?.finish()"),
  "panel:hide finishes the panel via the instance companion");

// ...and the generated panel activity actually tracks its instance (hud + web kinds)
const hudRes = JSON.parse((await handlers["generate_panel_compose_kotlin"]({ packageName: "com.test.putt.content", kind: "hud" })).content[0].text);
assert(hudRes.kotlin.includes("@Volatile var instance: HudPanelActivity?") && hudRes.kotlin.includes("instance = this"),
  "HudPanelActivity tracks instance for panel:hide");
assert(hudRes.kotlin.includes("if (instance === this) instance = null"), "HudPanelActivity clears instance on destroy");
const webRes = JSON.parse((await handlers["generate_panel_compose_kotlin"]({ packageName: "com.test.putt.content", kind: "web", html: "<b>x</b>" })).content[0].text);
assert(webRes.kotlin.includes("@Volatile var instance: WebPanelActivity?") && webRes.kotlin.includes("instance = this"),
  "WebPanelActivity tracks instance for panel:hide");

// a WEB panel spec routes panel:show/hide to WebPanelActivity
const webSpec = appSpecSchema.parse({
  meta, navigation,
  scenes: [{ id: "main", environment: { kind: "procedural" } }],
  panels: [{ id: "console", title: "CONSOLE", kind: "web", html: "<b>hi</b>" }],
});
const webHome = generateWiring(webSpec).find((f) => f.path.endsWith("HomeStage.kt"))?.content ?? "";
assert(webHome.includes("WebPanelActivity::class.java") && webHome.includes("WebPanelActivity.instance?.finish()"),
  "web panel spec routes panel:show/hide to WebPanelActivity");

// ── guards: nothing leaks into specs that don't ask for it ───────────────────────────────────────
const bareSpec = appSpecSchema.parse({
  meta, navigation,
  scenes: [{ id: "main", environment: { kind: "procedural" } }],
});
const bareHome = generateWiring(bareSpec).find((f) => f.path.endsWith("HomeStage.kt"))?.content ?? "";
assert(!bareHome.includes("panel:show") && !bareHome.includes("appCtxRef"), "panel-free spec emits no panel:show/appCtxRef");
assert(!bareHome.includes("GameMenu"), "menu-free spec emits no GameMenu routing");

// builtin-only menu specs keep exactly the four builtins in the whitelist
const builtinSpec = appSpecSchema.parse({
  meta, navigation,
  scenes: [{ id: "main", environment: { kind: "procedural" }, physics: {} }],
  objects: [{ id: "ball", sceneId: "main", source: "primitive", body: { mode: "dynamic", shape: "sphere", dims: [0.1] } }],
  interactions: [{ id: "go", trigger: "press", target: "ball", action: "launch:ball", params: { button: "start" } }],
});
const builtinHome = generateWiring(builtinSpec).find((f) => f.path.endsWith("HomeStage.kt"))?.content ?? "";
assert(builtinHome.includes('cmd in setOf("start", "pause", "resume", "reset")'),
  "builtin-only menu keeps exactly the four builtins in the select whitelist");

// ── ledger regression: the custom-menu step no longer claims the builtin-only HONEST LIMIT ───────
const ledger = buildLedger(puttSpec, "/tmp/proj");
const menuStep = ledger.find((s) => s.tool === "generate_game_menu_kotlin");
assert(menuStep && !/HONEST LIMIT/.test(menuStep.note ?? ""), "custom-menu ledger note retires the builtin-only HONEST LIMIT");
assert(menuStep && /broadcast-drivable/.test(menuStep.note ?? ""), "custom-menu ledger note states custom buttons are broadcast-drivable");
const panelStep = ledger.find((s) => s.tool === "generate_panel_compose_kotlin");
assert(panelStep && /panel:show/.test(panelStep.note ?? ""), "panel ledger note points at DEBUG_CMD panel:show/panel:hide");

console.log(`\nMenu-actions test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
