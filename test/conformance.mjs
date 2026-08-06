// v35 SAMPLE-CONFORMANCE GATE — every divergence from PICO's eight official Spatial SDK samples
// that we have closed gets an assertion here, so it can never silently reopen.
//
// Evidence base: .dev/findings/SAMPLES_CONFORMANCE_2026-08-05.md (each § cited per block below).
// Fully deterministic: dist imports + fake-server tool shims. No emulator, no adb, no server spawn.
// Run: node test/conformance.mjs
import fs from "node:fs";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };
const assert = (c, m) => (c ? ok(m) : fail(m));

const repoRoot = new URL("../", import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, repoRoot), "utf8");

const { registerPanelComposeTools } = await import("../dist/panelcompose.js");
const { generateWiring } = await import("../dist/assemble.js");
const { appSpecSchema } = await import("../dist/appspec.js");
const { runLint } = await import("../dist/lint.js");

const handlers = {};
const shim = { registerTool: (name, _meta, fn) => { handlers[name] = fn; } };
registerPanelComposeTools(shim);

const callJson = async (tool, args) => JSON.parse((await handlers[tool](args)).content[0].text);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §3.1 — SpatialUI conformance in generated panels.
//
// PICO's 8 samples: 0 androidx.compose.material* imports across 131 files, 17 `PicoTheme {` wraps.
// Ours shipped raw Compose with hardcoded hex and no PicoTheme for four versions, in direct
// violation of PICO-SPATIAL-AGENTIC-TOOLS.AGENTS.md ("all 2D UI with SpatialUI wrapped in PicoTheme").
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n§3.1 generated panels are SpatialUI-conformant");
{
  const hud = await callJson("generate_panel_compose_kotlin", {
    packageName: "com.test.conf.content",
    kind: "hud",
    title: "STATUS",
    fields: [{ key: "throws", label: "THROWS", initial: "0" }],
  });
  const kt = hud.kotlin;

  assert(kt.includes("import com.pico.spatial.ui.design.PicoTheme"), "hud panel imports PicoTheme");
  assert(/setContent\s*\{\s*PicoTheme\s*\{/.test(kt), "hud panel is mounted inside PicoTheme { }");
  assert(!/androidx\.compose\.material/.test(kt), "hud panel has no androidx.compose.material* import");
  assert(!/Color\(0x/.test(kt), "hud panel emits no hardcoded Color(0x...) literal");
  assert(!/androidx\.compose\.ui\.graphics\.Color/.test(kt), "hud panel no longer imports raw Compose Color");
  assert(!/\bColor\.White\b/.test(kt), "hud panel no longer uses Color.White");

  // Every colour is a role that actually exists in ColorScheme.kt:49-66, every size a Typography
  // role from Typography.kt:44-62. A role name we invented would compile-fail on a real build, so
  // the set is pinned here against the 0.13.3 declaration.
  const COLOR_ROLES = new Set([
    "fillPrimary", "fillSecondary", "fillTertiary", "fillLight", "labelPrimaryLight", "labelPrimary",
    "labelSecondary", "labelTertiary", "labelQuaternary", "lightenHover", "lightenPressed", "error",
    "alert", "passable", "interaction", "dividerLine",
  ]);
  const TYPE_ROLES = new Set([
    "bodyLarge", "bodyLargeMultiline", "bodyMedium", "bodyMediumMultiline", "bodySmall", "bodyTiny",
    "displayLarge", "displayMedium", "displaySmall", "headlineLarge", "headlineMedium", "headlineSmall",
    "labelLarge", "labelMedium", "labelSmall", "titleLarge", "titleMedium", "titleSmall",
  ]);
  assert(kt.includes("PicoTheme.colorScheme"), "hud panel reads PicoTheme.colorScheme");
  assert(kt.includes("PicoTheme.typography"), "hud panel reads PicoTheme.typography");

  const usedColors = [...kt.matchAll(/\bcolors\.([A-Za-z]+)/g)].map((m) => m[1]);
  const usedTypes = [...kt.matchAll(/\btype\.([A-Za-z]+)/g)].map((m) => m[1]);
  assert(usedColors.length >= 3, `hud panel takes >=3 colours from roles (got ${usedColors.length})`);
  assert(usedTypes.length >= 2, `hud panel takes >=2 text sizes from roles (got ${usedTypes.length})`);
  const badColor = usedColors.filter((r) => !COLOR_ROLES.has(r));
  const badType = usedTypes.filter((r) => !TYPE_ROLES.has(r));
  assert(badColor.length === 0, `every colour role exists in 0.13.3 ColorScheme${badColor.length ? `: invented ${badColor.join(", ")}` : ""}`);
  assert(badType.length === 0, `every typography role exists in 0.13.3 Typography${badType.length ? `: invented ${badType.join(", ")}` : ""}`);

  const errors = runLint(kt, "kotlin").filter((v) => v.severity === "error");
  assert(errors.length === 0, `hud panel is lint-clean${errors.length ? `: ${errors.map((e) => e.ruleId).join(", ")}` : ""}`);

  // The web panel is a WebView, not Compose — it must still never pull in Material.
  const web = await callJson("generate_panel_compose_kotlin", {
    packageName: "com.test.conf.content", kind: "web", html: "<b>x</b>",
  });
  assert(!/androidx\.compose\.material/.test(web.kotlin), "web panel has no androidx.compose.material* import");
  const webErrors = runLint(web.kotlin, "kotlin").filter((v) => v.severity === "error");
  assert(webErrors.length === 0, `web panel is lint-clean${webErrors.length ? `: ${webErrors.map((e) => e.ruleId).join(", ")}` : ""}`);
}

// The lint rules that keep §3.1 from regressing must themselves exist and fire.
console.log("\n§3.1 the regression guards are wired into preflight_lint");
{
  const material = runLint("import androidx.compose.material3.Button", "kotlin").map((v) => v.ruleId);
  assert(material.includes("compose-material-in-spatial-ui"), "a Material import is an error");
  const gradleCoord = runLint('implementation("androidx.compose.material3:material3:1.3.0")', "gradle").map((v) => v.ruleId);
  assert(gradleCoord.includes("compose-material-in-spatial-ui"), "a Material Gradle coordinate is an error");
  // ...but a doc comment that merely NAMES the ban must stay clean. The first draft of this rule
  // fired on the very comment documenting it, which is how the false positive was caught.
  const prose = runLint("// SpatialUI only: never androidx.compose.material here\nimport com.pico.spatial.ui.design.Text", "kotlin").map((v) => v.ruleId);
  assert(!prose.includes("compose-material-in-spatial-ui"), "a prose mention of the ban is not an error");
  const bare = runLint("setContentView(ComposeView(this).apply { setContent { HudPanel() } })", "kotlin").map((v) => v.ruleId);
  assert(bare.includes("compose-setcontent-without-picotheme"), "a bare setContent is an error");
  const wrapped = runLint("setContentView(ComposeView(this).apply { setContent { PicoTheme { HudPanel() } } })", "kotlin").map((v) => v.ruleId);
  assert(!wrapped.includes("compose-setcontent-without-picotheme"), "a PicoTheme-wrapped setContent is clean");
}

// §6.1 — the container root keeps its PicoTheme wrap (we already conformed here; pin it).
console.log("\n§6.1 the generated app entry keeps its PicoTheme wrap");
{
  const spec = appSpecSchema.parse({
    meta: { appName: "ConfTest", packageName: "com.test.conf", stageStyle: "1", brief: "conformance fixture" },
    navigation: { startScene: "main", portals: [] },
    scenes: [{ id: "main", environment: { kind: "procedural" }, lighting: { rig: "sun" } }],
    objects: [{ id: "cube", sceneId: "main", source: "primitive", transform: { position: [0, 1, -2] } }],
  });
  const main = generateWiring(spec).find((f) => f.path.endsWith("Main.kt"))?.content ?? "";
  assert(main.includes("import com.pico.spatial.ui.design.PicoTheme"), "Main.kt imports PicoTheme");
  assert(/PicoTheme\s*\{/.test(main), "Main.kt wraps the container content in PicoTheme");
  assert(!/androidx\.compose\.material/.test(main), "Main.kt has no Material import");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §6.2 — android:configChanges on the launch activity.
//
// 7/7 sample manifests that declare it use the same nine flags. Without them Android destroys and
// recreates LaunchActivity on any size/density/uiMode change — in a spatial shell that means a
// container resize rebuilds the entire scene.
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n§6.2 the skeleton manifest survives a container resize");
{
  const manifest = read("appskeleton/app/src/main/AndroidManifest.xml");
  const launchActivity = manifest.slice(manifest.indexOf("<activity"), manifest.indexOf("</activity>"));
  const configChanges = /android:configChanges="([^"]+)"/.exec(launchActivity);
  assert(configChanges !== null, "LaunchActivity declares android:configChanges");
  if (configChanges) {
    // The exact set PICO ships in Physics/WelcomeSpace/Animation/SpatialMesh/SpatialAudio manifests.
    const REQUIRED = [
      "screenSize", "smallestScreenSize", "screenLayout", "orientation", "density",
      "uiMode", "keyboardHidden", "navigation", "keyboard",
    ];
    const declared = configChanges[1].split("|").map((s) => s.trim());
    const missing = REQUIRED.filter((flag) => !declared.includes(flag));
    assert(missing.length === 0, `configChanges carries PICO's nine flags${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  }

  // §6.4 — the conformance diff recommended DELETING the three pico.spatial.stage.immersion* keys
  // because no sample declares them. REFUTED against the 0.13.3 source: both Stage samples ship
  // style="1" (Mixed), where immersion is inapplicable, and ui/foundation dsl/Stage.kt:29-56
  // documents this meta-data block as the DefaultStage configuration mechanism while
  // DefaultStage(content) at :64 takes no immersion parameter. The keys stay; the broken part was
  // the range (min was 100, pinning a Progressive stage at full immersion with no adjustment).
  assert(manifest.includes("pico.spatial.stage.immersion"),
    "the stage.immersion* keys are kept — they are DefaultStage's only immersion control (Stage.kt:29-56)");
  const immersionValue = (name) => {
    const m = new RegExp(`android:name="pico\\.spatial\\.stage\\.${name}"\\s*\\n?\\s*android:value="(\\d+)"`).exec(manifest);
    return m ? Number(m[1]) : null;
  };
  const def = immersionValue("immersion");
  const min = immersionValue("immersion_min");
  const max = immersionValue("immersion_max");
  assert(min === 0, `immersion_min is 0 so a Progressive stage is actually adjustable (got ${min})`);
  assert(min !== null && max !== null && def !== null && min <= def && def <= max && min < max,
    `immersion range is a usable [min <= default <= max] with min < max (got [${min}, ${def}, ${max}])`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §2.3 — the ECS System pair, and the SceneAnimator fixes it forced.
//
// Every symbol asserted here was read from the 0.13.3 sources jars and then adversarially
// re-verified against them. Symbols in the DO-NOT-EMIT list must never appear in our output.
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n§2.3 generate_ecs_system_kotlin emits a valid Component + System pair");
{
  const { generateEcsSystemFiles } = await import("../dist/ecssystem.js");

  // Symbols confirmed absent from 0.13.3 — emitting any of these ships code that cannot compile.
  const FORBIDDEN = [
    [/EntityQueryCondition\s*\.\s*custom\s*[({]/, "EntityQueryCondition.custom (SDK KDoc typo; real name customCondition)"],
    [/EntityQueryCondition\s*\.\s*byName/, "EntityQueryCondition.byName (does not exist)"],
    [/EntityQueryCondition\s*\.\s*hasComponent\s*</, "reified hasComponent<T>() (only the Class<T> form exists)"],
    [/\.setScale\s*\(/, "setScale (the setter is setScaleVector)"],
    [/\.setRotation\s*\(/, "setRotation (use setQuaternion/setEulerAngles)"],
    [/transform\.scale\b(?!Vector)/, "TransformComponent.scale (the property is scaleVector)"],
    [/\bentity\.name\b/, "Entity.name (getName() is a function, not a property)"],
    [/override\s+fun\s+onRegister/, "System.onRegister (System has no such member)"],
    [/queryEntityInto/, "queryEntityInto (no buffer-reuse overload exists)"],
    [/\.clear\(\)\s*[\s\S]{0,40}addAll\(\s*context\.scene\.queryEntity/, "clear()+addAll() (net-negative on 0.13.3 — queryEntity already allocated)"],
  ];

  for (const kind of ["spin", "orbit", "bob", "custom"]) {
    const out = generateEcsSystemFiles({ packageName: "com.test.conf.ecs", kind });
    const all = Object.values(out.files).join("\n") + "\n" + out.registration;
    const names = Object.keys(out.files);
    assert(names.length === 2, `${kind}: emits a Component + System pair (${names.join(", ")})`);

    const sysFile = out.files[names.find((n) => n.endsWith("System.kt"))];
    const compFile = out.files[names.find((n) => n.endsWith("Component.kt"))];

    // Registration reflects via getConstructor().newInstance() (System.kt:106): a top-level class
    // with a public no-arg ctor, or it throws at runtime rather than at build time.
    assert(/^@Keep\nclass \w+System : System\(\) \{/m.test(sysFile), `${kind}: System is a top-level @Keep class`);
    assert(/^@Keep\nclass \w+Component\(/m.test(compFile), `${kind}: Component is a top-level @Keep class`);
    const ctorParams = /class \w+Component\(([\s\S]*?)\) : Component\(\)/.exec(compFile)?.[1] ?? "";
    const params = ctorParams.split("\n").filter((l) => l.trim());
    assert(params.length > 0 && params.every((p) => p.includes(" = ")), `${kind}: every ctor param has a default (public no-arg ctor exists)`);

    // clone() is OPEN not abstract, and the base impl drops subclass state — so the override must
    // copy every field or a cloned entity silently loses its behaviour.
    const cloneArgs = /override fun clone\(\): \w+Component = \w+Component\(([^)]*)\)/.exec(compFile)?.[1] ?? "";
    const copied = cloneArgs.split(",").map((s) => s.trim()).filter(Boolean);
    const declared = params.map((p) => /\b(?:val|var)\s+(\w+)\s*:/.exec(p)?.[1]).filter(Boolean);
    assert(declared.length > 0 && declared.every((f) => copied.includes(f)),
      `${kind}: clone() copies every field (declared ${declared.join("/")}, copied ${copied.join("/")})`);

    assert(sysFile.includes("private val query = EntityQueryCondition.hasComponent("),
      `${kind}: the EntityQueryCondition is hoisted to a field, not rebuilt per frame`);
    assert(/override fun update\(context: SceneUpdateContext\)/.test(sysFile),
      `${kind}: overrides update(SceneUpdateContext) — System's only open member`);
    assert(sysFile.includes("context.scene.queryEntity(query)"),
      `${kind}: reads scene fresh from the context (one System is ticked once per container)`);
    assert(!/\bval\s+\w*[Ss]cene\s*=\s*context\.scene/.test(sysFile),
      `${kind}: never caches context.scene`);
    if (kind !== "custom") {
      assert(sysFile.includes("context.deltaTime"), `${kind}: scales motion by deltaTime (framerate-independent)`);
    }
    assert(!/components\.set\(TransformComponent\(/.test(sysFile),
      `${kind}: mutates the existing TransformComponent instead of replacing it per frame`);

    for (const [re, why] of FORBIDDEN) {
      assert(!re.test(all), `${kind}: does not emit ${why}`);
    }

    // Paired lifecycle, and the registration must not trip our own lint.
    assert(all.includes("registerSystem<") && all.includes("unregisterSystem<"),
      `${kind}: registration snippet pairs registerSystem with unregisterSystem`);
    assert(/DisposableEffect\(Unit\)\s*\{[\s\S]*onDispose\s*\{[\s\S]*unregisterSystem/.test(out.registration),
      `${kind}: unregister happens in onDispose`);
    const errs = runLint(all, "kotlin").filter((v) => v.severity === "error");
    assert(errs.length === 0, `${kind}: emitted pair is lint-clean${errs.length ? `: ${errs.map((e) => e.ruleId).join(", ")}` : ""}`);
  }

  // The guards themselves.
  const custom = runLint('EntityQueryCondition.custom { e -> e.getName() == "x" }', "kotlin").map((v) => v.ruleId);
  assert(custom.includes("entityquerycondition-custom"), "EntityQueryCondition.custom is an error");
  const unpaired = runLint("LaunchedEffect(Unit) { registerSystem<SpinSystem>() }", "kotlin").map((v) => v.ruleId);
  assert(unpaired.includes("registersystem-without-unregister"), "registerSystem with no unregisterSystem is an error");
}

console.log("\n§1.4/§2.3 per-frame and per-event transform writes mutate, never replace");
{
  const { registerAnimTools } = await import("../dist/anim.js");
  const { registerPhysicsTools } = await import("../dist/physics.js");
  const h = {};
  const s = { registerTool: (n, _m, f) => { h[n] = f; } };
  registerAnimTools(s);
  registerPhysicsTools(s);

  const animator = (await h["generate_scene_animator_kotlin"]({ packageName: "com.test.conf.content" })).content[0].text;
  // The old shape wrote a whole new TransformComponent (identity rotation + unit scale) every frame,
  // which made orbit and spin mutually exclusive by construction and allocated per entity per frame.
  assert(!/components\.set\(TransformComponent\(/.test(animator),
    "SceneAnimator never constructs a TransformComponent per frame");
  assert(/it\.position\s*=/.test(animator), "SceneAnimator writes position by mutation");
  assert(/it\.quaternion\s*=/.test(animator), "SceneAnimator writes rotation by mutation");
  assert(/it\.scaleVector\s*=/.test(animator), "SceneAnimator uses scaleVector, not the nonexistent scale");
  assert(!/\bQuat\.identity\(\)/.test(animator), "SceneAnimator no longer stamps identity rotation over other animations");
  // orbit must not touch rotation, spin must not touch position — otherwise they cannot compose.
  const orbitBody = /fun orbit\([\s\S]*?\n    \}/.exec(animator)?.[0] ?? "";
  const spinBody = /fun spin\([\s\S]*?\n    \}/.exec(animator)?.[0] ?? "";
  assert(orbitBody && !/quaternion|scaleVector/.test(orbitBody), "orbit writes position only, so it composes with spin");
  assert(spinBody && !/\.position\s*=|scaleVector/.test(spinBody), "spin writes rotation only, so it composes with orbit");
  assert(/fun stop\(\)/.test(animator) && /while \(running\)/.test(animator),
    "SceneAnimator's frame loop is cancellable (stop() + a loop condition, not while(true))");
  // fadeOpacity was a silent no-op: a PBR material is OPAQUE by default, so setOpacity did nothing.
  assert(/setBlendingMode\(BlendingMode\.TRANSPARENT\)/.test(animator),
    "fadeOpacity sets BlendingMode.TRANSPARENT (setOpacity on an opaque material is a no-op)");
  assert(/setBlendingMode\(BlendingMode\.OPAQUE\)/.test(animator), "there is a path back to OPAQUE");

  const phys = (await h["generate_rigidbody_kotlin"]({ packageName: "com.test.conf.content" })).content[0].text;
  const launchBody = /fun launch\([\s\S]*?\n    \}/.exec(phys)?.[0] ?? "";
  assert(launchBody.length > 0, "ScenePhysics.launch is emitted");
  assert(!/components\.set\(TransformComponent\(/.test(launchBody),
    "launch() nudges by mutation — replacing the component would clobber rotation and scale");
  assert(/\.position = Vector3\(/.test(launchBody), "launch() writes position in place");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §3.2 — AttachmentPanel: Compose placed INSIDE the 3D scene.
//
// We shipped "no public API positions an auto-hosted 2D panel in world space" and compiled
// placement:'world' to a head-docked fallback. True of an OS-composited 2D Activity window; false
// as the general claim it was read as. These assertions pin both the route and the retraction.
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n§3.2 in-scene Compose panels, and the correction that unlocked them");
{
  const { generateAttachmentPanelFiles } = await import("../dist/attachmentpanel.js");
  const out = generateAttachmentPanelFiles({
    packageName: "com.test.conf.content",
    panels: [
      { id: "score", title: "SCORE", lines: ["0"], position: [0, -0.3, 0.28], widthDp: 320, heightDp: 140, alignment: "CENTER" },
      { id: "label", title: "LABEL", position: [0.4, 1.2, -2], faceViewer: true },
    ],
  });
  const kt = out.files["SceneAttachments.kt"];

  assert(kt.includes("import com.pico.spatial.ui.foundation.content.AttachmentPanelBuilder"), "imports AttachmentPanelBuilder");
  assert(kt.includes("fun AttachmentPanelBuilder.sceneAttachmentPanels("), "emits the attachments builder extension");
  assert(kt.includes("fun SpatialViewAttachments.seatSceneAttachmentPanels("), "emits the seating helper");
  assert((kt.match(/AttachmentPanel\(\n/g) || []).length === 2, "one AttachmentPanel per requested panel");

  // TRAP 1: the attachments lambda is NOT a composable scope, so panelSize must be hoisted.
  const builderBlock = /fun AttachmentPanelBuilder\.sceneAttachmentPanels[\s\S]*?\n\}/.exec(kt)?.[0] ?? "";
  assert(builderBlock.length > 0, "the builder extension is well-formed");
  assert(!/panelSize\(/.test(builderBlock), "panelSize is NOT called inside the attachments lambda (it is not a composable scope)");
  assert(/@Composable\nfun rememberAttachmentPanelSizes\(\)/.test(kt), "panel sizes are hoisted into a @Composable");

  // TRAP 2/3: the Dp overload only — the metres overload throws outside a spatial container, and
  // panelSize is remembered with no keys.
  assert(/panelSize\(\d+\.dp, \d+\.dp\)/.test(kt), "uses the Dp overload of panelSize");
  assert(!/panelSize\([\d.]+f\s*,/.test(kt), "does not use the metres overload (it throws without LocalPhysicalLengthConverter)");

  // TRAP 4: the attachment entity must be explicitly added or it silently never renders.
  assert((kt.match(/content\.addEntity\(panel\)/g) || []).length === 2, "every attachment entity is explicitly added to the scene");
  assert(/entity\(SceneAttachments\.ID_\w+\)\?\.let/.test(kt), "entity(id) is null-guarded (it returns Entity?)");

  // Position is metres; and it must be set by mutation on the existing component.
  assert(/setPosition\(SceneAttachments\.POS_/.test(kt), "positions the attachment via TransformComponent");
  assert(!/components\.set\(TransformComponent\(/.test(kt), "does not replace the attachment's TransformComponent");

  // faceViewer: there is no BillboardComponent in 0.13.3; LookAtComponent is the equivalent.
  assert(kt.includes("LookAtComponent().apply { setViewerAsTarget() }"), "faceViewer uses LookAtComponent.setViewerAsTarget()");
  // The word appears in the comment explaining why we do not use it; what must never appear is a use.
  assert(!/BillboardComponent\s*\(|import .*Billboard/.test(kt), "never constructs or imports a BillboardComponent (no such type in 0.13.3)");

  // SpatialUI, not Material — same house rule as every other panel.
  assert(/PicoTheme \{/.test(kt), "panel content is wrapped in PicoTheme");
  assert(!/androidx\.compose\.material/.test(kt), "no Material import");
  assert(!/Color\(0x/.test(kt), "no hardcoded colour literals");
  const errs = runLint(kt, "kotlin").filter((v) => v.severity === "error");
  assert(errs.length === 0, `emitted attachment file is lint-clean${errs.length ? `: ${errs.map((e) => e.ruleId).join(", ")}` : ""}`);

  // The note must state the scope limit rather than overclaiming a world anchor.
  assert(/not world-?LOCKING|NOT world-locking|not world-locking/i.test(out.note), "the note distinguishes scene placement from world-locking");
  assert(/AnchorComponent/.test(out.note), "the note names AnchorComponent as what world-locking would still need");
  assert(/structural/i.test(out.note), "the note reports honest evidence status");

  // Input validation: ids are map keys, and the SDK silently clamps oversize panels.
  let threw = false;
  try { generateAttachmentPanelFiles({ packageName: "com.x", panels: [{ id: "a" }, { id: "a" }] }); } catch { threw = true; }
  assert(threw, "duplicate attachment ids are rejected (ids are map keys)");
  threw = false;
  try { generateAttachmentPanelFiles({ packageName: "com.x", panels: [{ id: "a", widthDp: 4096 }] }); } catch { threw = true; }
  assert(threw, "a panel wider than MAX_PANEL_SIZE_DP=2048 is rejected rather than silently clamped");
}

console.log("\n§3.2 the shipped 'no world placement' claim is corrected everywhere it was published");
{
  // The claim lived in three places. Each must now name the real route AND keep the half that is
  // genuinely true (no public API world-poses an OS-composited 2D Activity window).
  for (const file of ["src/panelcompose.ts", "src/appspec.ts", "src/compiler.ts"]) {
    const s = read(file);
    assert(!/world placement pending SDK confirmation/.test(s), `${file}: the dead-end wording is gone`);
    assert(/generate_attachment_panel_kotlin/.test(s), `${file}: points at the route that actually works`);
    assert(/AnchorComponent/.test(s), `${file}: still distinguishes scene placement from world-locking`);
  }
  const hud = await callJson("generate_panel_compose_kotlin", {
    packageName: "com.test.conf.content", kind: "hud", placement: "world",
  });
  assert(/generate_attachment_panel_kotlin/.test(hud.kotlin), "a 'world' request emits the real route in the generated source");
  assert(/generate_attachment_panel_kotlin/.test(hud.note), "a 'world' request names the real route in the tool note");
  assert(!/head-docked fallback/.test(hud.note), "the 'head-docked fallback' framing is gone from the note");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §3.3/§3.4/§6.3 — multi-container apps and the SpatialNavigator.
//
// Our genMain has always emitted DefaultStage for every app. WelcomeSpace declares three containers
// and navigates between them. MEASURED 2026-08-06 on emulator-5554 (ledger com.picoagent.v35expb#0,
// vision_verified): with the explicit open call, an immersive app's own secondary WindowContainer
// really does open — which narrows, not discards, our v9.3 note.
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n§3.3 multi-container apps open through the navigator");
{
  const { generateContainerAppFiles } = await import("../dist/containers.js");
  const out = generateContainerAppFiles({
    packageName: "com.test.conf",
    root: "windowContainer",
    rootContent: "MainNavHost()",
    rootContentImport: "com.test.conf.ui.MainNavHost",
    containers: [
      { kind: "window", id: "display_box", form: "Volumetric", widthDp: 1520, heightDp: 700, depthDp: 600 },
      { kind: "stage", id: "room", style: "Full", immersion: 100 },
    ],
  });
  const kt = out.files["Main.kt"];

  assert((kt.match(/fun mainApp\(/g) || []).length === 1, "exactly one mainApp");
  assert((kt.match(/DefaultWindowContainer \{|DefaultStage \{/g) || []).length === 1, "exactly one Default* container — it is what the OS launches");
  assert(/WindowContainer\(\n\s+id = SpatialContainers\.ID_DISPLAY_BOX/.test(kt), "the secondary WindowContainer is declared with its id");
  assert(/Stage\(\n\s+id = SpatialContainers\.ID_ROOM/.test(kt), "the secondary Stage is declared with its id");

  // Stage has NO style param — style is chosen at openStage time. Emitting it would not compile.
  const stageDecl = /    Stage\([\s\S]*?\n    \) \{/.exec(kt)?.[0] ?? "";
  assert(stageDecl.length > 0 && !/style\s*=/.test(stageDecl), "Stage() is declared without a style parameter (it has none)");
  assert(/Immersion\(default = \d+, min = \d+, max = \d+\)/.test(kt), "immersion uses the Immersion(...) factory, not the internal class ctor");

  // windowConstraints is a WindowContainerConstraintsScope member — only valid inside a WindowContainer.
  assert(/Modifier\.windowConstraints\(width = \d+\.dp, height = \d+\.dp\)/.test(kt), "the WindowContainer root carries windowConstraints");
  const stageRoot = generateContainerAppFiles({ packageName: "com.test.conf", root: "stage" }).files["Main.kt"];
  assert(!/windowConstraints/.test(stageRoot), "a Stage-rooted app emits no windowConstraints (the scope does not provide it)");

  // A declared container does not open itself.
  assert(/navigator\.openWindowContainer\(SpatialContainers\.ID_DISPLAY_BOX/.test(kt), "an explicit openWindowContainer call is emitted");
  assert(/navigator\.openStage\(SpatialContainers\.ID_ROOM/.test(kt), "an explicit openStage call is emitted");
  assert(/LocalSpatialNavigator\.current/.test(kt), "the navigator comes from LocalSpatialNavigator");

  // THE BROKEN TEARDOWN. closeStage is suspend; a rememberCoroutineScope is cancelled before
  // onDispose runs, so `onDispose { scope.launch { closeStage() } }` silently never executes.
  // Both PICO samples close on the lifecycle instead.
  const stageHelper = /fun OpenRoomOnEnter\([\s\S]*?\n\}/.exec(kt)?.[0] ?? "";
  assert(stageHelper.length > 0, "the Stage open/close helper is emitted");
  assert(!/onDispose \{[^}]*scope\.launch/.test(stageHelper),
    "closeStage is NOT called from onDispose (the scope is already cancelled there — it would silently no-op)");
  assert(/LifecycleEventObserver/.test(stageHelper) && /ON_PAUSE/.test(stageHelper),
    "the Stage is closed on ON_PAUSE/ON_DESTROY, before disposal");

  // The manifest keys whose 0.13.3 backing is a framework stub must not be emitted.
  for (const key of ["pico.spatial.windowcontainer.style", "pico.spatial.windowcontainer.worldscaletype", "pico.spatial.windowcontainer.defaultsize"]) {
    assert(!kt.includes(key), `does not emit the unbacked manifest key ${key}`);
  }

  const errs = runLint(kt, "kotlin").filter((v) => v.severity === "error");
  assert(errs.length === 0, `container Main.kt is lint-clean${errs.length ? `: ${errs.map((e) => e.ruleId).join(", ")}` : ""}`);

  // Refuse ungrounded configurations rather than guessing.
  let threw = false;
  try { generateContainerAppFiles({ packageName: "com.x", root: "stage", containers: [{ kind: "stage", id: "s" }] }); } catch { threw = true; }
  assert(threw, "a DefaultStage app declaring another Stage is refused (not a grounded configuration)");
  threw = false;
  try { generateContainerAppFiles({ packageName: "com.x", containers: [{ kind: "window", id: "a" }, { kind: "window", id: "a" }] }); } catch { threw = true; }
  assert(threw, "duplicate container ids are rejected (ids address the open/close calls)");

  // The note must carry the measurement, not the retracted absolute.
  assert(/MEASURED 2026-08-06/.test(out.note), "the note carries the emulator measurement");
  assert(/com\.picoagent\.v35expb#0/.test(out.note), "the note cites the ledger entry");
}

console.log("\n§3.3 the v9.3 'own WindowContainer never opens' note is narrowed, not deleted");
{
  for (const file of ["src/panelcompose.ts", "src/assemble.ts"]) {
    const s = read(file);
    assert(!/own WindowContainer does NOT open/.test(s), `${file}: the unqualified absolute is gone`);
    assert(/spatialNavigator\.openWindowContainer|openWindowContainer/.test(s), `${file}: names the call that makes it open`);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §1.1 — mesh colliders. EXPERIMENT A, measured on emulator-5554 (ledger com.picoagent.v35expa#0).
//
// We shipped "mesh colliders cook nothing queryable — rayCast returns 0 hits". A createStaticMesh
// collider built from a RUNTIME MeshResource both held a dropped body (restY=1.14, exactly the
// predicted rest height) and answered a rayCast (hits=2), matching a createBox control exactly.
// What is NOT refuted: the original finding was about a mesh LOADED from a bundle/GLB, which was
// never re-tested. The rule is narrowed to that scope, not deleted.
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n§1.1 the mesh-collider rule is narrowed to the case that still holds");
{
  const rule = (await import("../dist/lint.js")).BUILTIN_RULES.find((r) => r.id === "mesh-collider-not-queryable");
  assert(rule, "the mesh-collider rule still exists (narrowed, not deleted)");
  assert(rule.severity === "warn", `it is a warning, not an error (measured queryable in the runtime-mesh case) — got ${rule?.severity}`);
  assert(/LOADED/.test(rule.message), "the message names the LOADED-asset case as the one still suspect");
  assert(/RUNTIME MeshResource/.test(rule.message), "the message states what was actually measured");
  assert(!/returns 0 hits against them/.test(rule.message), "the refuted absolute is gone");

  // The three places that published the over-general claim.
  for (const [file, needle] of [["src/collider.ts", "com.picoagent.v35expa#0"], ["src/surfaceplace.ts", "com.picoagent.v35expa#0"]]) {
    const s = read(file);
    assert(s.includes(needle), `${file}: cites the ledger entry that narrowed it`);
    assert(!/A MESH collider never registers/.test(s), `${file}: the refuted absolute is gone`);
  }

  // PhysicsWorldComponent stays an ERROR — without it nothing is queryable, and that is exactly
  // what would have made Experiment A falsely confirm the old claim.
  const pw = (await import("../dist/lint.js")).BUILTIN_RULES.find((r) => r.id === "raycast-without-physicsworld");
  assert(pw?.severity === "error", "rayCast without PhysicsWorldComponent is still an error");
}

console.log(`\nSample-conformance gate done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
