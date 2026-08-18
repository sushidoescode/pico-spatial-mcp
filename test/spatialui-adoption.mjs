import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const { generateSubwindowFiles } = await import("../dist/subwindow.js");
const { generateSpatialGestureFiles } = await import("../dist/spatialgestures.js");
const { generateSpatialUIKotlin } = await import("../dist/components.js");
const { runLint } = await import("../dist/lint.js");
const { CAPABILITY_MANIFEST } = await import("../dist/capabilities.js");

const readRepo = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// These lanes are frozen inputs to the public benchmark/calibration contract. This adoption work
// is intentionally a repo-only recipe, never a way to inflate the benchmark corpus.
const protectedFiles = new Map([
  ["src/spatialbench.ts", "7744a47d3938058023851fe3c67658885be16a0c3acaca2f01fd2bcbbf92e5b9"],
  ["briefs/calib.json", "b9b76f5fe63afa0fb8f30721f0f548ae5082b77a611f4e1410b4466abcda9179"],
]);
const protectedBefore = new Map();
for (const [file, expectedHash] of protectedFiles) {
  const content = readRepo(file);
  assert.equal(sha256(content), expectedHash, `${file} changed outside this task`);
  protectedBefore.set(file, content);
}
assert(protectedBefore.get("src/spatialbench.ts").includes('BENCH_CORE: readonly string[] = ["crystals", "boutique", "knockdown", "gallery", "console", "dashboard", "ambient", "affordance"]'));
assert(protectedBefore.get("src/spatialbench.ts").includes('BENCH_MR: readonly string[] = ["mrtable", "mrpedestal", "mrknock"]'));

const sub = generateSubwindowFiles({
  packageName: "com.demo.workbench",
  primaryId: "home",
  primaryContent: "HomeStage()",
  primaryContentImport: "com.demo.workbench.content.HomeStage",
  secondaryId: "inspector",
  stableTag: "workbench",
  payloadKey: "mode",
  payloadValue: "inspect",
  widthMeters: 1.2,
  heightMeters: 0.6,
  depthMeters: 0.1,
  minWidthDp: 520,
  minHeightDp: 410,
  maxWidthDp: 1180,
  maxHeightDp: 880,
  subwindowSide: "Right",
  componentContent: "InspectorPanel()",
});
assert.deepEqual(Object.keys(sub.files), ["Main.kt"]);
assert.equal(sub.writeMode, "replace");
assert.equal(sub.ownership?.path, "Main.kt");
assert.match(sub.ownership?.instruction ?? "", /replace.*existing.*Main\.kt.*not.*alongside.*mainApp/i);
const sk = sub.files["Main.kt"];
assert.equal((sk.match(/fun mainApp\(/g) || []).length, 1);
assert.equal((sk.match(/DefaultStage\s*\{/g) || []).length, 1);
assert.equal((sk.match(/WindowContainer\(id = "inspector"/g) || []).length, 1);
assert(sk.includes("import com.pico.spatial.ui.foundation.dsl.SpatialAppScope"));
assert(sk.includes("fun mainApp(scope: SpatialAppScope) = with(scope) {"));
assert(sk.includes("@Composable\nprivate fun HomeWorkspace()"));
assert(sk.includes("DefaultStage { HomeWorkspace() }"));
assert(sk.includes("import com.demo.workbench.content.HomeStage"));
assert(/private fun HomeWorkspace\(\)[\s\S]*HomeStage\(\)[\s\S]*navigator\.openWindowContainer/.test(sk));
assert(!sk.includes("@Composable fun mainApp()"));
assert(!/@Composable fun \w+Window\(\)/.test(sk));
assert(!sk.includes("import com.pico.spatial.ui.foundation.dsl.bundle"));
assert(!/import .*windowConstraints/.test(sk));
assert(sk.includes('val initialArgs = bundleOf("mode" to "inspect")'));
assert(sk.includes('navigator.openWindowContainer("inspector", "workbench", initialArgs)'));
assert(sk.includes('navigator.closeWindowContainer("inspector", "workbench")'));
assert(sk.includes('defaultSize = WindowContainerSize(1.2f, 0.6f, 0.1f, LengthUnit.Meters)'));
assert(sk.includes("resizeType = ContainerResizeType.ContentSize"));
assert(sk.includes('val initialValue = bundle?.getString("mode")'));
assert(/WindowContainer\(id = "inspector",[\s\S]*?\) \{\s*\/\/ bundle[^\n]*\n\s*val initialValue[^\n]*\n\s*Box\(Modifier\.windowConstraints\(/.test(sk));
assert(sk.includes("minWidth = 520.dp") && sk.includes("minHeight = 410.dp"));
assert(sk.includes("maxWidth = 1180.dp") && sk.includes("maxHeight = 880.dp"));
assert(/Box\(Modifier\.windowConstraints\([\s\S]*?\)\) \{\s*PicoTheme \{\s*InspectorPanel\(\)/.test(sk));
assert(sk.includes("followViewpoints = ViewPoint.All"));
assert(sk.includes("placement = SubwindowPlacement.Right"));
assert(!sk.includes("offset = DpOffset3D"));
assert(sk.includes("fixed 360.dp x MatchContainerHeight attached augment"));
assert.equal((sk.match(/Subwindow\(/g) || []).length, 1);
// v35.5: the old assertion accepted the hedge "an attached augment; this does not prove arbitrary
// world lock" — true, but a negative that never said what a Subwindow IS. The 0.13.3 KDoc
// (Subwindow.kt:41-42) settles it: "shown at left or right side of the window container ... height
// always fill the height of the window container". It is CONTAINER-RELATIVE by construction, so it
// can never be world-locked — a property of the component, not a limit of our generator. Assert the
// precise statement, and that it still denies world lock.
assert(sub.doesNotProve.some((x) => /container-relative/i.test(x)), "Subwindow is described as container-relative");
assert(sub.doesNotProve.some((x) => /never be world-locked|world lock/i.test(x)), "Subwindow still denies world lock");
assert(sub.doesNotProve.some((x) => /Subwindow\.kt:41-42/.test(x)), "the container-relative claim cites the 0.13.3 KDoc");
assert(sub.doesNotProve.some((x) => /pixel rendering/i.test(x)));
assert(sub.doesNotProve.some((x) => /does not write or verify.*manifest.*Mixed.*manifestNotes/i.test(x)));
assert(sub.manifestNotes.some((x) => /launcher.*DefaultStage.*style 1.*Mixed/i.test(x)));
assert(sub.manifestNotes.some((x) => /DSL declaration is sufficient.*default stub/i.test(x)));
assert(sub.manifestNotes.some((x) => /optional custom.*same id.*separate.*launcher metadata/i.test(x)));
const scaffoldFiles = {
  "Main.kt": "fun mainApp(scope: SpatialAppScope) = with(scope) { DefaultStage { OldHome() } }",
  "HomeStage.kt": "@Composable fun OldHome() = Unit",
};
const appliedFiles = { ...scaffoldFiles, ...sub.files };
const appliedKotlin = Object.values(appliedFiles).join("\n");
assert.equal((appliedKotlin.match(/fun mainApp\(/g) || []).length, 1);
assert.equal((appliedKotlin.match(/DefaultStage\s*(?:\{|\{ HomeWorkspace\(\) \})/g) || []).length, 1);
assert.equal((appliedKotlin.match(/WindowContainer\(id = "inspector"/g) || []).length, 1);
assert.throws(() => generateSubwindowFiles({ packageName: "bad package", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 1, heightMeters: 1, depthMeters: 0, minWidthDp: 900, maxWidthDp: 800, subwindowSide: "Left", componentContent: "Panel()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.demo", primaryId: "../Main", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: Number.POSITIVE_INFINITY, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel(); injected()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage(); injected()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.demo", primaryId: "when", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.when", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "A..B()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 1e39, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" }));
assert.throws(() => generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "x", payloadKey: "x", payloadValue: "x", widthMeters: 5e-324, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" }));
const escapedSub = generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "tag\"\\$\nnext", payloadKey: "key\"\\$\nnext", payloadValue: "value\"\\$\nnext", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" });
const escapedKotlin = Object.values(escapedSub.files)[0];
assert(escapedKotlin.includes('"tag\\"\\\\\\$\\nnext"'));
assert(escapedKotlin.includes('"key\\"\\\\\\$\\nnext"'));
assert(escapedKotlin.includes('"value\\"\\\\\\$\\nnext"'));
const controlSub = generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "tag\rcontrol\u0001", payloadKey: "key", payloadValue: "value", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" });
assert(Object.values(controlSub.files)[0].includes('"tag\\rcontrol\\u0001"'));
const c1ControlSub = generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "tag\u0085next", payloadKey: "key", payloadValue: "value", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" });
assert(Object.values(c1ControlSub.files)[0].includes('"tag\\u0085next"'));
const formFeedSub = generateSubwindowFiles({ packageName: "com.demo", primaryId: "home", primaryContent: "HomeStage()", secondaryId: "inspector", stableTag: "tag", payloadKey: "key", payloadValue: "before\fafter", widthMeters: 1, heightMeters: 1, depthMeters: 0, subwindowSide: "Left", componentContent: "Panel()" });
assert(Object.values(formFeedSub.files)[0].includes('"before\\u000cafter"'));
assert(!Object.values(formFeedSub.files)[0].includes('"before\\fafter"'));

const gest = generateSpatialGestureFiles({ packageName: "com.demo.workbench", targetId: "blueCube", commandDispatcher: "dispatchDebugCommand" });
assert.deepEqual(Object.keys(gest.files), ["blueCubeSpatialGestures.kt"]);
const gk = gest.files["blueCubeSpatialGestures.kt"];
assert.equal((gk.match(/\.pointerInput\(/g) || []).length, 3);
assert(!gk.includes(".pointerInput(Unit)"));
assert(gk.includes(".pointerInput(entity, context)"));
assert(gk.includes(".pointerInput(entity, context, onDrag, density, converter)"));
assert(gk.includes(".pointerInput(entity, context, onScale)"));
assert.equal((gk.match(/TargetEntity\.hit\(entity\)/g) || []).length, 3);
for (const detector of ["detectSpatialTapGesture", "detectSpatialDragGesture", "detectSpatialScaleGesture"]) {
  assert(gk.includes(`import com.pico.spatial.ui.foundation.gesture.${detector}`));
}
assert(!gk.includes("gesture.*"));
assert(gk.includes("entity.components.set(InteractableComponent())"));
for (const token of [
  "CollisionComponent(",
  "listOf(ShapeResource.createBox(Vector3(0.2f, 0.2f, 0.2f)))",
  "PhysicsMaterialResource(0.4f, 0.4f, 0.1f)",
  // v35.13: was COLLIDER_FULL + COLLISION_FILTER_DEFAULT. A gesture target is a TAP TARGET, and
  // COLLIDER_FULL "applies physical collision effects" (CollisionResponseMode.kt:41-46) while
  // COLLISION_FILTER_DEFAULT (group 1u, mask ALL) pairs with every physics body — so the target was
  // an invisible wall that dynamic bodies bounced off. PICO's own tap target is TRIGGER_LITE on a
  // scoped filter (InteractionReceiver.kt:49-55).
  "CollisionResponseMode.TRIGGER_LITE",
  "CollisionFilter(CollisionGroup(1u), CollisionGroup(1u))",
  "CollisionInfoDetailLevel.BRIEF",
]) assert(gk.includes(token), token);
assert(!gk.includes("CollisionResponseMode.COLLIDER_FULL,"), "gesture target is not a physical obstacle");
assert(!gk.includes("CollisionFilter.COLLISION_FILTER_DEFAULT"), "gesture target does not pair with every physics body");
assert(!gk.includes("RigidBodyComponent"));
assert.equal((gk.match(/dispatchDebugCommand\("select:blueCube"\)/g) || []).length, 1);
assert(gk.includes("onDrag: (SpatialDragValue, Vector3)->Unit"));
assert(gk.includes("onScale: (SpatialScaleValue)->Unit"));
for (const axis of ["x", "y", "z"]) assert(gk.includes(`it.dragAmount.${axis}.toDp()`));
assert(!gk.includes("it.delta"));
for (const axis of ["X", "Y", "Z"]) assert(gk.includes(`converter.dpToLength(delta${axis}Dp, LengthUnit.Meters)`));
assert(gk.includes("val deltaMeters = Vector3("));
assert(gk.includes("converter.lengthToDp(20f, LengthUnit.Centimeters)"));
assert(gk.includes(".requiredSize(twentyCentimeters)"));
assert(gk.includes("onDrag(it, deltaMeters)"));
assert(gk.includes("onScale(it)"));
assert(!/LengthUnit\.(METER|CENTIMETER)\b/.test(gk));
assert(gest.doesNotProve.some((x) => /drag\/scale.*caller callbacks.*not claimed dispatcher routes/i.test(x)));
assert.throws(() => generateSpatialGestureFiles({ packageName: "bad package", targetId: "blueCube", commandDispatcher: "dispatchDebugCommand" }));
assert.throws(() => generateSpatialGestureFiles({ packageName: "com.demo", targetId: "bad-id", commandDispatcher: "dispatchDebugCommand" }));
assert.throws(() => generateSpatialGestureFiles({ packageName: "com.demo", targetId: "blueCube", commandDispatcher: "run(); hacked" }));
assert.throws(() => generateSpatialGestureFiles({ packageName: "com.demo", targetId: "blueCube", commandDispatcher: "when" }));
assert.throws(() => generateSpatialGestureFiles({ packageName: "com.demo", targetId: "class", commandDispatcher: "dispatchDebugCommand" }));
assert.throws(() => generateSpatialGestureFiles({ packageName: "com.when", targetId: "blueCube", commandDispatcher: "dispatchDebugCommand" }));

const componentInputs = {
  titleBar: { kind: "titleBar", id: "titleDemo", title: "Demo", items: [] },
  // v35.14: these two now REQUIRE container:"window". TabBar and Toolbar are AugmentImpl-backed
  // (Augments.kt:167-181); outside a WindowContainer AugmentImpl takes its else branch and only
  // logs "Augment-like components are not supported in <type>. Use WindowContainer instead."
  // (:222-226) — no exception, no compile error, no pixel. These fixtures previously omitted
  // container, defaulting to "ordinary", i.e. they described the silent-no-op case.
  toolbar: { kind: "toolbar", id: "toolbarDemo", title: "Demo", items: [], container: "window" },
  tabBar: { kind: "tabBar", id: "tabDemo", title: "Demo", items: ["One", "Two"], container: "window" },
  sheet: { kind: "sheet", id: "sheetDemo", title: "Demo", items: [], container: "window" },
  snackbarHost: { kind: "snackbarHost", id: "snackDemo", title: "Demo", items: [], container: "window" },
  coachmark: { kind: "coachmark", id: "coachDemo", title: "Demo", items: [], container: "window" },
  segmentControl: { kind: "segmentControl", id: "segmentDemo", title: "Demo", items: ["One", "Two"] },
};
const exactCalls = {
  titleBar: 'TitleBar(title = { Text(text = "Demo") })',
  toolbar: 'Toolbar(cornerSize = 32.dp, content = { Text(text = "Demo") })',
  // v35.14: followViewpoints is now explicit. Omitting it silently defaults to ViewPoint.All (all
  // four sides); PICO's own sample passes a set (HomePage.kt:68-98).
  tabBar: 'TabBar(followViewpoints = setOf(ViewPoint.Front, ViewPoint.Left), content = { item(selected = true, onClick = {}, mainContent = { Text(text = "One") }); item(selected = false, onClick = {}, mainContent = { Text(text = "Two") }) })',
  sheet: 'Sheet(onDismissRequest = {}) { Text(text = "Demo") }',
  snackbarHost: 'SnackbarHost { Text(text = "Demo") }',
  coachmark: 'CoachmarkBox(coachmark = { SimpleCoachmark(text = { Text(text = "Demo") }) }) { Text(text = "Demo") }',
  segmentControl: 'SegmentControl(content = { SegmentItem(selected = true, onClick = {}, title = { Text(text = "One") }); SegmentItem(selected = false, onClick = {}, title = { Text(text = "Two") }) })',
};
const expandedOutputs = {};
const componentImports = {
  titleBar: ["com.pico.spatial.ui.design.TitleBar"],
  toolbar: ["com.pico.spatial.ui.design.windows.Toolbar"],
  // TabBar.kt:81 imports the PLATFORM ViewPoint; a second, different ViewPoint exists in
  // ui.foundation.content and would not compile here.
  tabBar: ["com.pico.spatial.ui.design.windows.TabBar", "com.pico.spatial.ui.platform.ViewPoint"],
  sheet: ["com.pico.spatial.ui.design.windows.Sheet"],
  snackbarHost: ["com.pico.spatial.ui.design.windows.SnackbarHost"],
  coachmark: ["com.pico.spatial.ui.design.windows.CoachmarkBox", "com.pico.spatial.ui.design.windows.SimpleCoachmark"],
  segmentControl: ["com.pico.spatial.ui.design.SegmentControl", "com.pico.spatial.ui.design.SegmentItem"],
};
for (const [kind, panel] of Object.entries(componentInputs)) {
  const kotlin = generateSpatialUIKotlin({ packageName: "com.demo.workbench", panels: [panel] });
  expandedOutputs[kind] = kotlin;
  assert(kotlin.includes(exactCalls[kind]), `${kind} exact 0.13.3 call shape`);
  for (const expectedImport of componentImports[kind]) assert(kotlin.includes(`import ${expectedImport}`), `${kind} import`);
  for (const [otherKind, imports] of Object.entries(componentImports)) {
    if (otherKind === kind) continue;
    for (const otherImport of imports) {
      if (!componentImports[kind].includes(otherImport)) assert(!kotlin.includes(`import ${otherImport}`), `${kind} must not import ${otherImport}`);
    }
  }
  assert(kotlin.includes("Structural placeholder:"), `${kind} must state its evidence boundary`);
  assert(kotlin.includes("SDK 0.13.3 source-grounded call shapes"));
  assert(kotlin.includes("caller owns the spatial container, state, and actions"));
  assert(kotlin.includes("Compilation and a LOOK remain pending"));
  assert(!/rendered flat in 3D|panels >= 800|every button is a real/i.test(kotlin));
  assert(!kotlin.includes("WindowContainer("), `${kind} must not take container ownership`);
  assert(!kotlin.includes(".width(880.dp)"), `${kind} is a root/window augment, not a legacy shell child`);
}
assert(!/\bSnackbar\s*\(/.test(expandedOutputs.snackbarHost), "0.13.3 exposes SnackbarHost, not a public Snackbar composable");
assert(expandedOutputs.tabBar.includes("onClick callbacks are no-ops"));
assert(expandedOutputs.segmentControl.includes("onClick callbacks are no-ops"));
assert(expandedOutputs.sheet.includes("dismiss callback is a no-op"));
assert(expandedOutputs.snackbarHost.includes("does not call SnackbarHostState.show"));
for (const kind of ["sheet", "snackbarHost", "coachmark"]) {
  assert.throws(() => generateSpatialUIKotlin({ packageName: "com.demo", panels: [{ ...componentInputs[kind], container: "ordinary" }] }));
}
for (const kind of ["tabBar", "segmentControl"]) {
  assert.throws(() => generateSpatialUIKotlin({ packageName: "com.demo", panels: [{ ...componentInputs[kind], items: [] }] }));
}
assert.throws(() => generateSpatialUIKotlin({ packageName: "com.demo", panels: [{ kind: "madeUp", id: "x", title: "x" }] }));
assert.throws(() => generateSpatialUIKotlin({ packageName: "bad package", panels: [componentInputs.titleBar] }));
assert.throws(() => generateSpatialUIKotlin({ packageName: "com.when", panels: [componentInputs.titleBar] }));
const formFeedComponent = generateSpatialUIKotlin({ packageName: "com.demo", panels: [{ ...componentInputs.titleBar, title: "before\fafter" }] });
assert(formFeedComponent.includes('"before\\u000cafter"'));
assert(!formFeedComponent.includes('"before\\fafter"'));
const commentControlComponent = generateSpatialUIKotlin({ packageName: "com.demo", panels: [{ kind: "card", id: "safeComment", title: "Safe", bodyLines: [], buttons: [{ label: "Run", colorHex: "#00DD66", action: 'dispatch safe\rprintln("injected")\u0085next' }] }] });
assert(!/[\r\u0085]/.test(commentControlComponent));
assert(commentControlComponent.includes('// dispatch safe println("injected") next'));

// The pre-existing card/menu/list contract is a byte-level compatibility surface.
const legacyGoldens = [
  [{ packageName: "com.golden.legacy", panels: [{ kind: "card", id: "status", title: "Status", subtitle: "Ready", bodyLines: ["Line one"], accentHex: "#1122EE", buttons: [{ label: "Go", colorHex: "#FF0033", action: "dispatch go" }] }] }, "14a9fb6d76b2d330076a4d6f00121b1769a0381803d43c2ee893433128880938"],
  [{ packageName: "com.golden.legacy", panels: [{ kind: "menu", id: "actions", title: "Actions", buttons: [{ label: "Run", colorHex: "#00DD66", filled: true, action: "dispatch run" }] }] }, "eef1ba198c139e0b893ed7bd3c29e0bae044025e1cb347dc83a90ad9c3715ae1"],
  [{ packageName: "com.golden.legacy", panels: [{ kind: "list", id: "items", title: "Items", items: [{ label: "Alpha", sublabel: "First", dotHex: "#FFCC00" }] }] }, "8037d0d7d8146ff22e4f3466ed52721060019b0a5c335622d199cacf7de0c8c2"],
];
for (const [input, expectedHash] of legacyGoldens) assert.equal(sha256(generateSpatialUIKotlin(input)), expectedHash);
const worldPlacementInput = { packageName: "com.demo", panels: [{ kind: "card", id: "worldCard", title: "World", bodyLines: [], buttons: [], placement: "world" }] };
const worldPlacementBefore = JSON.stringify(worldPlacementInput);
generateSpatialUIKotlin(worldPlacementInput);
assert.equal(JSON.stringify(worldPlacementInput), worldPlacementBefore);
assert.equal(worldPlacementInput.panels[0].placement, "world");

for (const [name, kotlin] of [["subwindow", sk], ["gestures", gk], ...Object.entries(expandedOutputs)]) {
  const errors = runLint(kotlin, "kotlin").filter((finding) => finding.severity === "error");
  assert.deepEqual(errors, [], `${name} generated Kotlin must pass preflight_lint error rules`);
}

const provenance = JSON.parse(readRepo("test/fixtures/sdk-adoption-provenance.json"));
assert.equal(provenance.sdkVersion, "0.13.3");
assert.deepEqual(provenance.artifacts, {
  design: "com.pico.spatial.ui:design:0.13.3",
  foundation: "com.pico.spatial.ui:foundation:0.13.3",
  platform: "com.pico.spatial.ui:platform:0.13.3",
  core: "com.pico.spatial.core:core:0.13.3",
});
assert(provenance.entries.length >= 25);
for (const entry of provenance.entries) {
  for (const field of ["symbol", "import", "signature", "sdkVersion", "artifact", "source"]) assert.equal(typeof entry[field], "string", `${entry.symbol ?? "entry"}.${field}`);
  assert.equal(entry.sdkVersion, "0.13.3");
  assert(!entry.signature.includes("..."), `${entry.symbol} signature must not be abbreviated`);
  assert(!/\/Users\/|\/home\/|[a-f0-9]{40}\//i.test(entry.source), `${entry.symbol} source must be stable`);
  if (entry.artifact.startsWith("com.pico.")) assert(entry.source.includes("-0.13.3-sources.jar!/"), `${entry.symbol} must name a stable source-jar entry`);
}
const provenanceBySymbol = new Map(provenance.entries.map((entry) => [entry.symbol, entry]));
for (const symbol of ["detectSpatialTapGesture", "detectSpatialDragGesture", "detectSpatialScaleGesture"]) {
  assert.match(provenanceBySymbol.get(symbol).signature, /^suspend fun PointerInputScope\./);
}
assert.match(provenanceBySymbol.get("InteractableComponent").source, /core-0\.13\.3-sources\.jar!\/com\/pico\/spatial\/core\/ecs\/Entity\.kt/);
assert.match(provenanceBySymbol.get("Toolbar").signature, /segmented overload/);
assert.match(provenanceBySymbol.get("Toolbar").signature, /cornerSize = 32\.dp.*disambiguates/);
assert.equal(provenanceBySymbol.get("Bundle/bundleOf").artifact, "androidx.core:core-ktx:1.13.0; Android platform");
assert.match(provenanceBySymbol.get("Bundle/bundleOf").source, /core-ktx-1\.13\.0-sources\.jar!\/androidx\/core\/os\/Bundle\.kt/);
for (const [symbol, output, token] of [
  ["Subwindow", sk, "import com.pico.spatial.ui.design.windows.Subwindow"],
  ["SpatialAppScope", sk, "import com.pico.spatial.ui.foundation.dsl.SpatialAppScope"],
  ["DefaultStage", sk, "DefaultStage {"],
  ["WindowContainer", sk, 'WindowContainer(id = "inspector"'],
  ["LocalSpatialNavigator", sk, "LocalSpatialNavigator.current"],
  ["SpatialContainerScope.bundle", sk, 'bundle?.getString("mode")'],
  ["ContainerResizeType.ContentSize", sk, "ContainerResizeType.ContentSize"],
  ["windowConstraints", sk, "Modifier.windowConstraints("],
  ["detectSpatialTapGesture", gk, "detectSpatialTapGesture(context, TargetEntity.hit(entity))"],
  ["detectSpatialDragGesture", gk, "detectSpatialDragGesture(context, TargetEntity.hit(entity), onDrag ="],
  ["detectSpatialScaleGesture", gk, "detectSpatialScaleGesture(context, TargetEntity.hit(entity), onScale ="],
  ["LocalPhysicalLengthConverter/LengthUnit", gk, "LocalPhysicalLengthConverter.current"],
  ["TitleBar", expandedOutputs.titleBar, exactCalls.titleBar],
  ["Toolbar", expandedOutputs.toolbar, exactCalls.toolbar],
  ["TabBar", expandedOutputs.tabBar, exactCalls.tabBar],
  ["Sheet", expandedOutputs.sheet, exactCalls.sheet],
  ["SnackbarHost (no public Snackbar composable)", expandedOutputs.snackbarHost, exactCalls.snackbarHost],
  ["CoachmarkBox/SimpleCoachmark", expandedOutputs.coachmark, exactCalls.coachmark],
  ["SegmentControl/SegmentItem", expandedOutputs.segmentControl, exactCalls.segmentControl],
]) {
  assert(provenance.entries.some((entry) => entry.symbol === symbol), `missing provenance for ${symbol}`);
  assert(output.includes(token), `output does not exhibit ${symbol}`);
}

const demo = JSON.parse(readRepo("examples/docs-adoption-workbench.json"));
assert.equal(demo.kind, "structural-recipe");
assert.equal(demo.repositoryOnly, true);
assert.equal(demo.executable, false);
assert.match(demo.scope, /replayable generator calls.*not a complete app/i);
assert.doesNotMatch(demo.scope, /Task\s+\d+/i, "public recipe scope must not promise a later task's evidence");
assert.match(demo.manifestContract, /caller-owned.*style=1.*Mixed.*do not edit/i);
assert(demo.missingIntegration.some((item) => /HomeStage.*InspectorPanel/.test(item)));
assert(demo.missingIntegration.some((item) => /dispatchDebugCommand/.test(item)));
assert(demo.missingIntegration.some((item) => /Modifier/.test(item)));
assert.match(demo.outputDestinations.generate_subwindow_kotlin, /Replace .*Main\.kt/);
assert.equal(demo.stageStyle, "1");
assert.deepEqual(demo.tools, ["generate_subwindow_kotlin", "generate_spatial_gestures_kotlin"]);
const demoSubwindowCall = demo.calls.find((call) => call.tool === "generate_subwindow_kotlin");
const demoSubwindowOutput = generateSubwindowFiles(demoSubwindowCall.arguments);
assert(demoSubwindowOutput.files["Main.kt"].includes(`${demoSubwindowCall.arguments.primaryContent}`));
assert.equal(demoSubwindowOutput.writeMode, "replace");
assert.match(demoSubwindowCall.application, /replace.*Main\.kt/i);
const demoGestureCalls = demo.calls.filter((call) => call.tool === "generate_spatial_gestures_kotlin");
assert.deepEqual(demoGestureCalls.map((call) => call.arguments.targetId), demo.targets.map((target) => target.id));
for (const call of demoGestureCalls) generateSpatialGestureFiles(call.arguments);
for (const target of demo.targets) {
  assert(demo.integrationSteps.some((step) => step.includes(target.id) && step.includes(target.colorHex)));
}
assert.equal(demo.benchmarkMembership, "none");
assert.equal(new Set(demo.targets.map((target) => target.colorHex)).size, 2);
for (const target of demo.targets) {
  const channels = target.colorHex.slice(1).match(/../g).map((hex) => Number.parseInt(hex, 16));
  assert(Math.max(...channels) - Math.min(...channels) >= 200, `${target.id} must use a saturated color`);
}
assert(demo.visualClaims.every((claim) => claim.requiresLook === true));
assert(!protectedBefore.get("src/spatialbench.ts").includes("docs-adoption-workbench"));
const examplesReadme = readRepo("examples/README.md");
assert(examplesReadme.includes("docs-adoption-workbench.json"));
assert(/repo-only/i.test(examplesReadme));
assert.doesNotMatch(examplesReadme.split(/\r?\n/, 1)[0], /vision-verified/i, "page heading must not blanket-upgrade structural recipes");
assert(demo.integrationSteps.every((step) => !/Task\s+\d+/i.test(step)), "integration steps must stay replayable and task-neutral");
assert(!JSON.parse(readRepo("package.json")).files.includes("examples"), "repo-only recipe must stay out of the npm package");

const subwindowCapability = CAPABILITY_MANIFEST.find((entry) => entry.tool === "generate_subwindow_kotlin");
assert.equal(subwindowCapability?.ceiling, "C4_headset_only");
// v35.5: same strengthening as above — assert the precise container-relative statement and its
// citation, not just the old "does not prove world lock" hedge.
assert.match(subwindowCapability?.note ?? "", /structural.*attached augment.*container-relative/i);
assert.match(subwindowCapability?.note ?? "", /Subwindow\.kt:41-42/);
assert.match(subwindowCapability?.note ?? "", /never be world-locked/i);
assert.match(subwindowCapability?.note ?? "", /Mixed requires.*caller-applied.*manifest style 1/i);
const gestureCapability = CAPABILITY_MANIFEST.find((entry) => entry.tool === "generate_spatial_gestures_kotlin");
assert.equal(gestureCapability?.ceiling, "C3");
assert.match(gestureCapability?.note ?? "", /tap.*select.*drag\/scale.*callback/i);

for (const [file, before] of protectedBefore) assert.equal(readRepo(file), before, `${file} mutated during generation`);

console.log("SpatialUI adoption test done. Failures: 0");
