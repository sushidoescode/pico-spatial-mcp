// v35 SAMPLE-CONFORMANCE GATE — every divergence from PICO's eight official Spatial SDK samples
// that we have closed gets an assertion here, so it can never silently reopen.
//
// Evidence base: .dev/findings/SAMPLES_CONFORMANCE_2026-08-05.md (each § cited per block below).
// Fully deterministic: dist imports + fake-server tool shims. No emulator, no adb, no server spawn.
// Run: node test/conformance.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };
const assert = (c, m) => (c ? ok(m) : fail(m));

const repoRoot = new URL("../", import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, repoRoot), "utf8");

const { registerPanelComposeTools } = await import("../dist/panelcompose.js");
const { generateWiring } = await import("../dist/assemble.js");
const { appSpecSchema } = await import("../dist/appspec.js");
const { runLint: runLintRaw, BUILTIN_RULES } = await import("../dist/lint.js");

// HERMETIC: lint against the BUILT-IN rules only. runLint otherwise merges ~/.pico-mcp/lessons.json,
// a user-writable store — so a developer's local lesson could pass or fail this gate depending on
// their machine. That is not hypothetical: a malformed row in that file (no id, empty pattern) once
// made this gate fail across eight unrelated generators with a blank rule id.
const runLint = (content, kind) => runLintRaw(content, kind, BUILTIN_RULES);

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
  assert(/val e\w+ = entity\(SceneAttachments\.ID_\w+\)/.test(kt) && /e\w+\?\.let \{ panel ->/.test(kt),
    "entity(id) is null-guarded (it returns Entity?)");

  // Position is metres; and it must be set by mutation on the existing component.
  assert(/setPosition\(SceneAttachments\.POS_/.test(kt), "positions the attachment via TransformComponent");
  assert(!/components\.set\(TransformComponent\(/.test(kt), "does not replace the attachment's TransformComponent");

  // faceViewer: there is no BillboardComponent in 0.13.3; LookAtComponent is the equivalent.
  assert(kt.includes("LookAtComponent().apply { setViewerAsTarget() }"), "faceViewer uses LookAtComponent.setViewerAsTarget()");
  // The word appears in the comment explaining why we do not use it; what must never appear is a use.
  assert(!/BillboardComponent\s*\(|import .*Billboard/.test(kt), "never constructs or imports a BillboardComponent (no such type in 0.13.3)");

  // An attachment has NO container glass behind it (unlike a WindowContainer, which the shell
  // composites onto a material surface). PicoTheme's default labelPrimary is BLACK, so without its
  // own fill the panel renders invisible over dark scene content — measured 2026-08-06, where the
  // text was legible only where it crossed an orange sphere.
  assert(/\.background\(colors\.fillSecondary/.test(kt), "attachment content draws its own background (no container glass behind it)");
  // A silent null from entity(id) is the likeliest cause of an invisible panel; say which happened.
  assert(/entity=" \+ \(if \(e\w+ == null\)/.test(kt), "the entity lookup logs NULL vs ok rather than silently skipping");

  // SpatialUI, not Material — same house rule as every other panel.
  assert(/PicoTheme \{/.test(kt), "panel content is wrapped in PicoTheme");
  assert(!/androidx\.compose\.material/.test(kt), "no Material import");
  assert(!/Color\(0x/.test(kt), "no hardcoded colour literals");
  const errs = runLint(kt, "kotlin").filter((v) => v.severity === "error");
  assert(errs.length === 0, `emitted attachment file is lint-clean${errs.length ? `: ${errs.map((e) => e.ruleId).join(", ")}` : ""}`);

  // The note must state the scope limit rather than overclaiming a world anchor.
  assert(/not world-?LOCKING|NOT world-locking|not world-locking/i.test(out.note), "the note distinguishes scene placement from world-locking");
  assert(/AnchorComponent/.test(out.note), "the note names AnchorComponent as what world-locking would still need");
  assert(/VISION_VERIFIED/i.test(out.note) && /ledger com\.picoagent\.v35attach#0/.test(out.note),
    "the note reports the evidence class it actually earned, with its ledger entry");

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
  // v35.24: ONE secondary Stage on a Stage root is now ALLOWED — it was refused as ungrounded, and
  // then it got measured (ledger com.picoagent.v35expc#2): it opens, the Bundle crosses, and the
  // second Stage takes over from the first. Two or more remain refused.
  const stageOnStage = generateContainerAppFiles({ packageName: "com.x", root: "stage", rootContent: "HomeStage()", containers: [{ kind: "stage", id: "s", content: "S()" }] });
  assert(/TAKEOVER, not an addition/.test(stageOnStage.files["Main.kt"]),
    "a Stage-root app declaring one Stage is allowed AND warns that opening it stops the root rendering");
  try { generateContainerAppFiles({ packageName: "com.x", root: "stage", containers: [{ kind: "stage", id: "a" }, { kind: "stage", id: "b" }] }); } catch { threw = true; }
  assert(threw, "more than one secondary Stage is still refused (only one Stage is open at a time)");

  // The validation hole that let a refused configuration be generated: `root` was never checked, so
  // `root: "DefaultStage"` emitted a DefaultStage app AND slipped past the root === "stage" guard.
  threw = false;
  try { generateContainerAppFiles({ packageName: "com.x", root: "DefaultStage" }); } catch { threw = true; }
  assert(threw, "an unrecognised root value is rejected rather than silently reinterpreted");

  // Every container's content needs its own import, or the emitted Main.kt does not compile.
  const withImport = generateContainerAppFiles({
    packageName: "com.x", containers: [{ kind: "window", id: "w", content: "Detail()", contentImport: "com.x.content.Detail" }],
  });
  assert(/import com\.x\.content\.Detail/.test(withImport.files["Main.kt"]),
    "a secondary container's contentImport is emitted (without it the output does not compile)");
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
// §1.1 — mesh colliders. EXPERIMENT C-5, measured on emulator-5554 (ledger com.picoagent.v35expc#4).
//
// We shipped "mesh colliders cook nothing queryable — rayCast returns 0 hits". v35.4 refuted the
// RUNTIME half. C-5 refuted the LOADED half that v35.4 kept alive as untested: a mesh taken off a
// loaded model's ModelComponent answers rayCast through BOTH createStaticMesh and createConvexMesh
// (548 / 50 self-hits vs a 441-hit primitive control in the same cast).
//
// The rule survives because the TRAP MOVED, not because the doubt did. What actually produces a
// "0 hits" reading is ALIGNMENT: the cooked shape follows the mesh's LOCAL vertex data and the
// collider entity's own transform, so it need not contain the entity origin (measured: entirely
// above it) and shrinks with the entity's scale (measured: ~2mm at the asset's 0.0045). This gate
// exists to stop the OLD claim creeping back in as if it had never been tested.
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n§1.1 the mesh-collider rule states alignment, not un-queryability");
{
  const rule = (await import("../dist/lint.js")).BUILTIN_RULES.find((r) => r.id === "mesh-collider-alignment");
  assert(rule, "the mesh-collider rule still exists (retargeted, not deleted)");
  assert(rule.severity === "warn", `it is a warning, not an error (measured queryable in BOTH provenances) — got ${rule?.severity}`);
  assert(/QUERYABLE/.test(rule.message), "the message leads with the measured result: mesh colliders ARE queryable");
  assert(/LOADED/.test(rule.message), "the message still names the LOADED-asset case — now as measured, not suspect");
  assert(/ALIGNMENT/.test(rule.message), "the message names the trap that actually bites");
  assert(!/returns 0 hits against them/.test(rule.message), "the first refuted absolute is gone");
  assert(!/has not been re-tested|remain suspect|still suspect/i.test(rule.message),
    "the second refuted claim — loaded-asset meshes untested/suspect — is gone from the message");
  // The single-ray-at-the-origin check is what manufactured the false negative. The fix must say so.
  assert(/one ray|single ray/i.test(rule.fix) && /origin/i.test(rule.fix),
    "the fix warns that one ray at the entity origin returns NONE against a working collider");

  // Every place that published the superseded claim must cite the experiment that killed it.
  for (const file of ["src/collider.ts", "src/surfaceplace.ts"]) {
    const s = read(file);
    assert(s.includes("com.picoagent.v35expc#4"), `${file}: cites the ledger entry that refuted it`);
    assert(!/A MESH collider never registers/.test(s), `${file}: the first refuted absolute is gone`);
    assert(!/still suspect|untested-and-suspect|loaded-mesh finding STANDS/.test(s),
      `${file}: no longer calls loaded-asset mesh colliders suspect`);
  }

  // PhysicsWorldComponent stays an ERROR — without it nothing is queryable, and that is exactly
  // what would have made either experiment falsely confirm the old claim.
  const pw = (await import("../dist/lint.js")).BUILTIN_RULES.find((r) => r.id === "raycast-without-physicsworld");
  assert(pw?.severity === "error", "rayCast without PhysicsWorldComponent is still an error");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §7 — acquisition without release, the cross-cutting finding.
//
// Across all of src/ our codegen emitted .close() exactly ONCE (on an Android AssetFileDescriptor,
// not an SDK resource) and .destroy() once, while 8/8 samples pair every acquisition with a
// release. This block asserts BOTH halves: the rules exist and fire, AND our own generators pass
// them — which is how the databinding and menu leaks were found in the first place.
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n§7 every generator that acquires a resource also releases it");
{
  const { BUILTIN_RULES } = await import("../dist/lint.js");
  for (const id of ["animationresource-never-closed", "assetbundle-never-closed", "trackingmanager-never-stopped", "subscription-never-cancelled"]) {
    const r = BUILTIN_RULES.find((x) => x.id === id);
    assert(r && r.severity === "error", `${id} is an error-level rule`);
    assert(r.type === "conditional", `${id} is conditional — a file that DOES clean up stays clean`);
  }

  // EXHAUSTIVE sweep of every generate_*_kotlin tool.
  //
  // This replaced a hand-maintained 7-lane list, which is precisely why it was worth doing: the list
  // covered the lanes this wave happened to touch, so `environment`, `surfaceplace` and `media` were
  // never swept and were each leaking an app-owned handle in shipped output. A list you have to
  // remember to extend is a list that silently stops being true.
  //
  // Two implementation notes, both learned the hard way:
  //  - dist/index.js is EXCLUDED. Importing it constructs the server and connects the stdio
  //    transport, which never resolves — that is what hung the original unbounded sweep for 10
  //    minutes. It was never a slow tool.
  //  - Args are synthesized from each tool's zod schema. A few tools take REFINED strings
  //    (z.string().refine(...) shows up as ZodEffects, so type-based synthesis cannot satisfy them)
  //    and get an explicit override below.
  const ARG_OVERRIDES = {
    generate_collider_kotlin: {
      packageName: "com.test.conf.content",
      shapes: [{ name: "Col_Desk", kind: "box", pos: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    },
    generate_subwindow_kotlin: {
      packageName: "com.test.conf.content", primaryId: "primary", primaryContent: "PrimaryPanel()",
      secondaryId: "secondary", stableTag: "tag", payloadKey: "k", payloadValue: "v",
      widthMeters: 0.6, heightMeters: 0.4, depthMeters: 0.05, subwindowSide: "Right",
      componentContent: "DetailPanel()",
    },
  };
  const synth = (key, shape) => {
    const d = shape?._def ?? {};
    if (d.typeName === "ZodOptional" || d.typeName === "ZodDefault") return undefined; // let the tool default it
    if (d.typeName === "ZodEnum") return d.values?.[0];
    if (d.typeName === "ZodArray") return /size|scale|dimension|position|extent/i.test(key) ? [1, 1, 1] : [];
    if (d.typeName === "ZodNumber") return 1;
    if (d.typeName === "ZodBoolean") return false;
    if (/^packageName$/i.test(key)) return "com.test.conf.content";
    if (/bundle/i.test(key)) return "asset://x.bundle";
    if (/ktx/i.test(key)) return "env.ktx";
    if (/assetFileName|glb/i.test(key)) return "model.glb";
    if (/png|image/i.test(key)) return "tex.png";
    if (/id$|name$/i.test(key)) return "thing";
    return "x";
  };

  const CODEGEN_MODULES = [
    "anim", "attachmentpanel", "bundlelease", "collider", "containers", "databinding", "display",
    "ecssystem", "environment", "events", "interactables", "interaction", "layout", "lighting",
    "media", "menu", "panelcompose", "physics", "richness", "router", "sense", "skeletal",
    "spatialgestures", "subwindow", "surfaceplace", "swan", "tappable", "webbridge",
  ];
  let swept = 0;
  const uncovered = [];
  for (const mod of CODEGEN_MODULES) {
    const m = await import(`../dist/${mod}.js`);
    const h = {}, meta = {};
    for (const reg of Object.values(m).filter((x) => typeof x === "function" && /^register/.test(x.name))) {
      try { reg({ registerTool: (n, mt, fn) => { h[n] = fn; meta[n] = mt; } }); } catch { /* needs a live server */ }
    }
    for (const [tool, fn] of Object.entries(h)) {
      if (!/^generate_.*_kotlin$/.test(tool)) continue;
      let args = ARG_OVERRIDES[tool];
      if (!args) {
        args = {};
        for (const [k, v] of Object.entries(meta[tool]?.inputSchema ?? {})) {
          const s = synth(k, v);
          if (s !== undefined) args[k] = s;
        }
      }
      let raw;
      try {
        const res = await fn(args);
        raw = res?.content?.[0]?.text ?? "";
        if (res?.isError) { uncovered.push(`${tool} (isError)`); continue; }
      } catch (e) { uncovered.push(`${tool} (threw: ${String(e?.message).slice(0, 60)})`); continue; }
      const kt = raw.trimStart().startsWith("{")
        ? (() => { try { const j = JSON.parse(raw); return Object.values(j.files ?? {}).join("\n") || j.kotlin || raw; } catch { return raw; } })()
        : raw;
      if (!/\b(object|class|fun|import)\b/.test(kt)) { uncovered.push(`${tool} (no kotlin)`); continue; }
      swept++;
      const errs = [...new Set(runLint(kt, "kotlin").filter((v) => v.severity === "error").map((v) => v.ruleId).filter(Boolean))];
      assert(errs.length === 0, `${tool} emits no unpaired acquisition${errs.length ? `: ${errs.join(", ")}` : ""}`);
    }
  }
  // No silent caps: a tool that cannot be invoked is a COVERAGE HOLE, and a gate that quietly skips
  // it reads as "everything passed" when it did not.
  assert(uncovered.length === 0, `every generate_*_kotlin tool is reachable by the sweep${uncovered.length ? ` — uncovered: ${uncovered.join("; ")}` : ""}`);
  assert(swept >= 33, `the sweep covers the whole codegen surface (swept ${swept})`);

  // The specific releases this wave added, asserted by shape so a refactor cannot quietly drop them.
  const anim = await import("../dist/anim.js");
  const ah = {};
  anim.registerAnimTools({ registerTool: (n, _m, f) => { ah[n] = f; } });
  for (const tool of ["generate_tween_animation_kotlin", "generate_orbit_animation_kotlin"]) {
    const kt = (await ah[tool]({ packageName: "com.test.conf.content" })).content[0].text;
    assert(/private var res: AnimationResource\? = null/.test(kt), `${tool} retains the AnimationResource`);
    // Order matters: closing a resource that is still playing is what PICO's comments warn about.
    const stopBody = /fun stop\(entity: Entity\)[\s\S]*?\n    \}/.exec(kt)?.[0] ?? "";
    assert(stopBody.indexOf("stopAllAnimations") >= 0 && stopBody.indexOf("stopAllAnimations") < stopBody.indexOf("close()"),
      `${tool} stops playback BEFORE closing the resource`);
  }

  const sense = await import("../dist/sense.js");
  const sh = {};
  sense.registerSenseTools({ registerTool: (n, _m, f) => { sh[n] = f; } });
  const senseKt = (await sh["generate_scene_understanding_kotlin"]({ packageName: "com.test.conf.content" })).content[0].text;
  assert(/fun stop\(\)/.test(senseKt) && /PlaneTrackingManager\.stop\(\)/.test(senseKt),
    "scene understanding pairs start() with stop() (battery/thermal cost on hardware otherwise)");
  // §4.1: loadAllAnchors resumes EMPTY with no error while state != RUNNING, so a bare retry loop
  // is a blind spin on a condition the SDK exposes directly.
  assert(/PLANES\| retry=\$tries state=\$\{PlaneTrackingManager\.state\}/.test(senseKt),
    "the plane retry loop logs TrackingState each attempt (turns '0 planes' into a diagnosis)");

  const db = await import("../dist/databinding.js");
  const dh = {};
  db.registerDataBindingTools({ registerTool: (n, _m, f) => { dh[n] = f; } });
  const dbKt = (await dh["generate_data_binding_kotlin"]({ packageName: "com.test.conf.content" })).content[0].text;
  assert(/fun dispose\(\)/.test(dbKt), "data binding emits a dispose()");
  assert(/bundles\.values\.forEach \{ runCatching \{ it\.close\(\) \} \}/.test(dbKt), "dispose() closes every cached AssetBundle");
  assert(/private val bundles = mutableMapOf<String, AssetBundle>\(\)/.test(dbKt),
    "bundles are cached by path, not re-loaded per catalog item");
  assert(/cancelChildren\(\)/.test(dbKt), "dispose() cancels in-flight loads before closing what they use");
  assert(/placeholder\.destroy\(\)/.test(dbKt), "a replaced placeholder Entity is destroyed, not stranded");
}

// A malformed row in the user-writable lessons store must never be able to fire.
console.log("\n§7 the learned-lesson store is treated as untrusted input");
{
  const poison = [
    { severity: "error", kinds: ["any"], pattern: "(?:)", positiveFixture: "", negativeFixture: "" },
    { id: "no-pattern", severity: "error", kinds: ["any"], message: "x" },
    { id: "matches-everything", severity: "error", kinds: ["any"], pattern: ".*", message: "x" },
    { id: "bad-regex", severity: "error", kinds: ["any"], pattern: "([", message: "x" },
  ];
  const home = process.env.HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-lessons-"));
  fs.mkdirSync(path.join(dir, ".pico-mcp"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pico-mcp", "lessons.json"), JSON.stringify(poison));
  process.env.HOME = dir;
  try {
    // Fresh import so the module re-reads LESSONS_PATH under the patched HOME.
    const { runLint: rl } = await import(`../dist/lint.js?poison=${Date.now()}`);
    const hits = rl("package com.example.app\nfun main() {}", "kotlin");
    assert(hits.length === 0, `a malformed lessons store fires nothing (got ${hits.map((h) => h.ruleId ?? "<no id>").join(", ")})`);
  } finally {
    process.env.HOME = home;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v35.9 — A TOOL THAT NOTHING ROUTES TO IS NOT SHIPPED.
//
// All three tools this wave added were registered MCP tools, tested, and documented — and INVISIBLE
// to the planner, the capability manifest and the compile ledger. An agent driving brief_to_app
// could never arrive at any of them. For generate_container_app_kotlin that gutted the point: its
// whole justification was "the agentic track cannot reach a WelcomeSpace-class outcome by
// prompting", and it still could not. Registration is not adoption; this asserts the difference.
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\nv35.9 every generator this wave added is REACHABLE, not just registered");
{
  const { CAPABILITY_MANIFEST } = await import("../dist/capabilities.js");
  const { buildLedger } = await import("../dist/compiler.js");
  const NEW_TOOLS = ["generate_ecs_system_kotlin", "generate_attachment_panel_kotlin", "generate_container_app_kotlin"];

  for (const t of NEW_TOOLS) {
    assert(CAPABILITY_MANIFEST.some((c) => c.tool === t), `${t} is in CAPABILITY_MANIFEST (list_capabilities / the planner see it)`);
  }

  // A spec that asks for all three must produce a ledger step for each.
  const spec = appSpecSchema.parse({
    meta: {
      appName: "Parity", packageName: "com.test.parity", stageStyle: "1", brief: "welcomespace-class",
      rootContainer: "windowContainer",
      secondaryContainers: [{ kind: "window", id: "display_box", form: "Volumetric" }, { kind: "stage", id: "room", style: "Full" }],
    },
    navigation: { startScene: "main", portals: [] },
    scenes: [{ id: "main", environment: { kind: "procedural" }, lighting: { rig: "sun" } }],
    objects: [{ id: "gem", sceneId: "main", source: "primitive", transform: { position: [0, 1.2, -2] }, anim: { type: "spin", driver: "system" } }],
    panels: [{ id: "hud", title: "SCORE", placement: { kind: "scene", position: [0, 1.45, -1.9] } }],
  });
  const ledger = buildLedger(spec, "/tmp/parity");
  for (const t of NEW_TOOLS) {
    assert(ledger.some((st) => st.tool === t), `${t} is ROUTED by compile_app_spec (an agent can reach it by prompting)`);
  }

  // Ordering: the container step REPLACES the Main.kt that generate_app_wiring emits, so it has to
  // come after it. Reversed, the app would end up with a DefaultStage Main.kt and two mainApps.
  const wiringAt = ledger.findIndex((st) => st.tool === "generate_app_wiring");
  const containersAt = ledger.findIndex((st) => st.tool === "generate_container_app_kotlin");
  assert(wiringAt >= 0 && containersAt > wiringAt, `the container step follows generate_app_wiring (${wiringAt} -> ${containersAt})`);

  // placement 'scene' must lower to the attachment route INSTEAD of the dock panel, not alongside.
  assert(!ledger.some((st) => st.tool === "generate_panel_compose_kotlin"),
    "a 'scene' panel does not also emit a docked 2D Activity");

  // ...and 'world' must still lower to the dock path, because world-LOCKING remains deferred.
  const worldSpec = appSpecSchema.parse({
    meta: { appName: "W", packageName: "com.test.w", stageStyle: "1", brief: "b" },
    navigation: { startScene: "main", portals: [] },
    scenes: [{ id: "main", environment: { kind: "procedural" } }],
    objects: [{ id: "o", sceneId: "main", source: "primitive", transform: { position: [0, 1, -2] } }],
    panels: [{ id: "p", title: "T", placement: { kind: "world", position: [0, 1, -2] } }],
  });
  const worldLedger = buildLedger(worldSpec, "/tmp/w");
  assert(worldLedger.some((st) => st.tool === "generate_panel_compose_kotlin"),
    "a 'world' panel still lowers to the dock path (world-locking needs AnchorComponent, still deferred)");
  assert(worldLedger.some((st) => /generate_attachment_panel_kotlin/.test(st.note ?? "")),
    "the 'world' ledger note points at the route that does work");
}

// §4.1 — mesh tracking. Measured working 2026-08-06 (ledger com.picoagent.v35expa#1): 44 anchors.
// The trap worth pinning: TrackingState.RUNNING is NOT a readiness signal — both trackers report
// RUNNING while still returning 0 for 1-2s — so nothing may gate a retry loop on state.
console.log("\n§4.1 mesh tracking is emitted, and nothing gates readiness on TrackingState");
{
  const sense = await import("../dist/sense.js");
  const sh = {};
  sense.registerSenseTools({ registerTool: (n, _m, f) => { sh[n] = f; } });
  const kt = (await sh["generate_scene_understanding_kotlin"]({ packageName: "com.test.conf.content" })).content[0].text;

  assert(/fun startMesh\(/.test(kt) && /subscribeAnchorUpdate/.test(kt),
    "mesh tracking is emitted via subscribeAnchorUpdate (the path PICO's own sample uses)");
  assert(/fun stopMesh\(/.test(kt) && /meshSub\?\.cancel\(\)/.test(kt) && /MeshTrackingManager\.stop\(\)/.test(kt),
    "startMesh is paired with a stopMesh that cancels the subscription AND stops the tracker");
  // Subscribing after start() can miss the first ADDED burst.
  assert(kt.indexOf("subscribeAnchorUpdate") < kt.indexOf("MeshTrackingManager.start()"),
    "subscription is set up BEFORE start()");
  // The refuted recommendation must never come back: a loop must not exit because state == RUNNING.
  assert(!/while\s*\([^)]*state\s*[!=]=\s*TrackingState\.RUNNING/.test(kt),
    "no retry loop gates on TrackingState.RUNNING (both trackers report RUNNING while returning 0)");
  assert(/MESH\| retry=\$tries state=/.test(kt), "the mesh retry loop logs state, making a 0 diagnosable");
  const errs = runLint(kt, "kotlin").filter((v) => v.severity === "error").map((v) => v.ruleId).filter(Boolean);
  assert(errs.length === 0, `scene-understanding is lint-clean${errs.length ? `: ${errs.join(", ")}` : ""}`);

  // And the retracted claim must be gone from the shipped text.
  const src = read("src/sense.ts");
  assert(!/Do not claim mesh data works on the emulator\.(?!~)/.test(src.replace(/~~[\s\S]*?~~/g, "")),
    "the 'do not claim mesh data works' absolute is retracted, not still asserted");
  assert(/com\.picoagent\.v35expa#1/.test(src), "the retraction cites its ledger entry");
}

// CP1B — query_scene_anchors does not use the historic MESH| log lane. The generated app bridge
// publishes one nonce-addressed file atomically, and the host pulls its exact bytes with run-as on
// the explicitly named serial. These are source/transport contracts: no adb process is started.
console.log("\nCP1B Agent Bridge scene snapshots are versioned, lossless, and file-only");
{
  const bridge = await import("../dist/agentbridge.js");
  const bridgeHandlers = {};
  bridge.registerAgentBridgeTools({ registerTool: (n, _m, f) => { bridgeHandlers[n] = f; } });
  const generated = JSON.parse((await bridgeHandlers["generate_agent_bridge"]({
    packageName: "com.test.conf.agent",
  })).content[0].text);
  const agentKt = generated.files.find((f) => f.path.endsWith("/AgentBridge.kt"))?.content ?? "";
  const providerKt = generated.files.find((f) => f.path.endsWith("/AgentBridgeInitProvider.kt"))?.content ?? "";

  assert(bridge.AGENT_BRIDGE_SCENE_PAYLOAD_KIND === "pico.agent-bridge.scene-snapshot",
    "scene payload kind is a static exported protocol constant");
  assert(bridge.AGENT_BRIDGE_SCENE_SCHEMA_VERSION === 1,
    "scene payload schema version is 1");
  assert(bridge.AGENT_BRIDGE_SCENE_REVISION === 41,
    "Agent Bridge scene protocol revision is the static revision 41");
  assert(bridge.AGENT_BRIDGE_SCENE_COORDINATE_FRAME_ID === "bridge-world-41",
    "scene coordinate-frame ID is pinned to bridge revision 41");
  assert(generated.sceneSnapshotProtocol.kind === bridge.AGENT_BRIDGE_SCENE_PAYLOAD_KIND &&
    generated.sceneSnapshotProtocol.schemaVersion === bridge.AGENT_BRIDGE_SCENE_SCHEMA_VERSION &&
    generated.sceneSnapshotProtocol.bridgeRevision === bridge.AGENT_BRIDGE_SCENE_REVISION,
  "tool metadata and host exports share one scene protocol version");
  assert(/SCENE_PAYLOAD_KIND = "pico\.agent-bridge\.scene-snapshot"/.test(agentKt) &&
    /SCENE_SCHEMA_VERSION = 1/.test(agentKt) && /SCENE_BRIDGE_REVISION = 41/.test(agentKt),
  "generated AgentBridge embeds the same kind/schema/revision constants");
  assert(/register\(SCENE_SNAPSHOT_COMMAND\)/.test(agentKt) && /SCENE_SNAPSHOT_COMMAND = "query_scene_anchors"/.test(agentKt),
    "generated AgentBridge owns one query_scene_anchors command");
  assert(/SCENE_SNAPSHOT_CACHE_DIRECTORY = "agentbridge\/scene-snapshots"/.test(agentKt) &&
    /sceneSnapshotTarget\(context: Context, requestId: String\)/.test(agentKt),
  "scene payload is request-addressed beneath the app cache");
  assert(/\.tmp-\$\{SystemClock\.elapsedRealtimeNanos\(\)\}/.test(agentKt) &&
    /Os\.rename\(temp\.absolutePath, target\.absolutePath\)/.test(agentKt),
  "payload publication is atomic temp-plus-rename on one filesystem");
  assert(/writer\.flush\(\)[\s\S]*output\.fd\.sync\(\)/.test(agentKt),
    "payload bytes are flushed and fsynced before publication");
  assert(/"apk-sha256"/.test(agentKt) && /observedStageStyle/.test(agentKt) &&
    /rootContainer/.test(agentKt) && /stageOpen/.test(agentKt),
  "payload envelope carries build, observed stage, root, and stage-open identity");
  assert(agentKt.includes('writer.name("buildIdentity").nullValue()') &&
    agentKt.includes('writer.name("observedStageStyle").nullValue()') &&
    agentKt.includes('writer.name("rootContainer").nullValue()') && agentKt.includes('"binding_failed"'),
  "unavailable build/stage/root identity is null and fails binding closed");
  assert(/getLaunchIntentForPackage\(context\.packageName\)/.test(agentKt) &&
    /getActivityInfo\(component, PackageManager\.GET_META_DATA\)/.test(agentKt),
  "observed stage style reads the launcher-activity metadata shape emitted by the repo scaffold");
  assert(/fun detachScene\(root: Entity\? = null\)/.test(agentKt) &&
    /fun detachSceneProvider\(\)/.test(agentKt) && generated.integration.some((line) => line.includes("detachScene(stageRoot)")),
  "direct and provider Stage attachments have explicit lifecycle detach wiring");
  assert(providerKt.indexOf("AgentBridge.initialize(ctx)") >= 0 &&
    providerKt.indexOf("AgentBridge.initialize(ctx)") < providerKt.indexOf("ctx.registerReceiver"),
  "provider binds application Context before making the command receiver reachable");
  assert(/"stage_not_open"/.test(agentKt) && /"bridge_unavailable"/.test(agentKt) && /"invalid_payload"/.test(agentKt),
    "generated bridge writes typed terminal payloads for missing stage/producer/valid data");
  assert(!/Log\.[diwev]\([^\n]*(?:vertices|indices|semanticAssignments)/.test(agentKt),
    "AgentBridge never writes scene geometry to a log line");

  const sense = await import("../dist/sense.js");
  const senseHandlers = {};
  sense.registerSenseTools({ registerTool: (n, _m, f) => { senseHandlers[n] = f; } });
  const senseKt = (await senseHandlers["generate_scene_understanding_kotlin"]({
    packageName: "com.test.conf.content",
    agentBridgePackage: "com.test.conf.agent",
  })).content[0].text;
  assert(senseKt.includes("import com.test.conf.agent.AgentBridge"),
    "scene generator imports the explicitly selected Agent Bridge package");
  assert(/fun registerAgentBridgeSceneSnapshot\(\)/.test(senseKt) && /registerSceneSnapshotProducer/.test(senseKt),
    "scene generator exposes the one-line lossless producer registration");
  assert(senseKt.includes('AgentBridge.attachScene(stageRoot, "stage")'),
    "scene integration names the identity-bearing stage-root overload");
  const producer = /private suspend fun writeAgentBridgeSceneSnapshot[\s\S]*?private suspend fun captureBridgeRead/.exec(senseKt)?.[0] ?? "";
  assert(producer.includes("restartMeshForBridgeQuery()") && producer.includes("captureBridgeRead(reads.size,"),
    "one bridge producer starts a fresh tracking epoch and owns every readiness read");
  assert(/bridgeQueryMutex\.lock\(\)[\s\S]*writeAgentBridgeSceneSnapshot[\s\S]*finally \{ bridgeQueryMutex\.unlock\(\) \}/.test(senseKt),
    "concurrent bridge requests serialize their mesh-tracker epochs");
  assert(/MeshTrackingManager\.start\(\)[\s\S]*meshSub = subscription[\s\S]*catch \(cause: Throwable\)[\s\S]*subscription\.cancel\(\)[\s\S]*meshSub = null[\s\S]*throw cause/.test(senseKt),
    "a failed tracker start is cleaned up, never retained as a live subscription");
  const captureRead = /private suspend fun captureBridgeRead[\s\S]*?private fun captureBridgeAnchor/.exec(senseKt)?.[0] ?? "";
  assert(/withTimeout\(timeoutMs\) \{ MeshTrackingManager\.loadAllAnchors/.test(captureRead),
    "each callback-based SDK mesh read is bounded by a timeout");
  assert(/anchors = oneShot\.map/.test(captureRead) && !/subscribed|sourceAnchors|\"subscription\"/.test(captureRead),
    "retained subscription anchors cannot satisfy a fresh bridge readiness read");
  assert(/setupFailure[\s\S]*writer\.name\("code"\)\.value\("bridge_unavailable"\)/.test(producer),
    "tracker setup failure becomes a typed terminal payload");
  assert(/consecutiveNonEmpty = if \(read\.anchors\.isNotEmpty\(\)\)/.test(producer) &&
    /consecutiveNonEmpty >= request\.stabilityReads/.test(producer),
  "readiness requires consecutive unfiltered non-empty mesh reads");
  assert(!/labels?|semanticAssignments.*(?:filter|any)/.test(producer),
    "producer performs no label filtering before readiness");
  for (const field of [
    "runtimeUuid", "worldFromAnchor", "positionM", "rotationQuaternionXyzw", "boundsM",
    "vertices", "indices", "semanticAssignments",
  ]) {
    assert(senseKt.includes(`writer.name("${field}")`), `lossless producer writes ${field}`);
  }
  assert(/transform\.toMatrix4\(\)\.toFloatArray\(\)/.test(senseKt) &&
    /require\(matrix\.size == 16\)/.test(senseKt),
  "worldFromAnchor is the full SDK row-major 4x4 matrix");
  assert(/require\(indices\.size % 3 == 0\)/.test(senseKt) && /require\(vertices\.size % 3 == 0\)/.test(senseKt),
    "producer refuses malformed triangle/xyz arrays instead of guessing");
  const rawSemanticWriter = /writer\.name\("semanticAssignments"\)[\s\S]*?writer\.endArray\(\)/.exec(senseKt)?.[0] ?? "";
  assert(/semanticAssignments\.forEach \{ writer\.value\(it\) \}/.test(rawSemanticWriter) && !/distinct|sorted/.test(rawSemanticWriter),
    "raw semantic assignments preserve duplicates and SDK order");
  assert(/queriedAtMonotonicNs/.test(senseKt) && /trackingState/.test(senseKt) &&
    /anchorCount/.test(senseKt) && /loadError/.test(senseKt),
  "every producer read carries monotonic time, tracking state, count, and read diagnostics");
  assert(/MESH\| oneShot=/.test(senseKt), "the old MESH| diagnostic lane remains available for old tools");

  const exactBytes = Buffer.from(JSON.stringify({
    semanticAssignments: Array.from({ length: 1800 }, (_, i) => i % 2 ? "WALL_ART" : "TABLE"),
  }), "utf8");
  assert(exactBytes.length > 16 * 1024, "transport fixture is much larger than a truncation-prone log line");
  const calls = [];
  let payloadPulls = 0;
  let ticks = 100n;
  const fetched = await bridge.fetchAgentBridgeSceneSnapshot("/fixture/adb", {
    serial: "fixture-serial",
    packageName: "com.test.conf",
    requestId: "fixture_nonce_20260828",
    maxRetries: 2,
    pollMs: 100,
    stabilityReads: 2,
  }, {
    monotonicNs: () => ticks++,
    runText: async (cmd, args) => {
      calls.push({ kind: "text", cmd, args });
      return { code: 0, stdout: "ok", stderr: "", timedOut: false };
    },
    runBytes: async (cmd, args) => {
      calls.push({ kind: "bytes", cmd, args });
      payloadPulls += 1;
      if (payloadPulls === 1) {
        return {
          code: 0,
          stdout: Buffer.from([0x00]),
          stderr: "",
          timedOut: false,
        };
      }
      return { code: 0, stdout: Buffer.concat([Buffer.from([0x01]), exactBytes]), stderr: "", timedOut: false };
    },
    sleep: async () => {},
  });
  assert(fetched.ok, "file/pull helper accepts an exact app-cache payload");
  assert(fetched.ok && Buffer.compare(fetched.bytes, exactBytes) === 0,
    "file/pull helper returns every payload byte losslessly");
  assert(payloadPulls === 2 && fetched.ok && fetched.actionReceipts.find((r) => r.action === "bridge_payload_pull")?.ack?.attempts === 2,
    "the explicit absent-file marker is retried until the payload appears");
  assert(calls.every((c) => c.args[0] === "-s" && c.args[1] === "fixture-serial"),
    "every adb subprocess is pinned to the exact requested serial");
  assert(calls.some((c) => c.args.includes("query_scene_anchors") && c.args.includes("fixture_nonce_20260828")),
    "broadcast carries the static command and transaction requestId");
  assert(calls.some((c) => c.kind === "bytes" && c.args.join(" ").includes("exec-out run-as com.test.conf sh -c") &&
    c.args.at(-1) === "cache/agentbridge/scene-snapshots/fixture_nonce_20260828.json"),
    "payload is existence-guarded and read as exact bytes through the intended package's run-as path");
  assert(!calls.some((c) => c.args.includes("logcat")), "lossless transport never consults logcat");
  assert(fetched.actionReceipts.map((r) => r.action).join(",") ===
    "bridge_broadcast,bridge_payload_pull,bridge_payload_cleanup",
  "file/pull helper returns broadcast, pull, and cleanup action receipts");

  const malformedBytes = Buffer.from("present, but deliberately not JSON", "utf8");
  const malformed = await bridge.fetchAgentBridgeSceneSnapshot("/fixture/adb", {
    serial: "fixture-serial",
    packageName: "com.test.conf",
    requestId: "malformed_nonce_20260828",
    maxRetries: 0,
    pollMs: 10,
    stabilityReads: 2,
  }, {
    monotonicNs: () => ticks++,
    runText: async () => ({ code: 0, stdout: "ok", stderr: "", timedOut: false }),
    runBytes: async () => ({
      code: 0,
      stdout: Buffer.concat([Buffer.from([0x01]), malformedBytes]),
      stderr: "",
      timedOut: false,
    }),
  });
  const { parseSceneBridgePayload } = await import("../dist/sceneanchors.js");
  const malformedParsed = malformed.ok ? parseSceneBridgePayload(malformed.bytes) : null;
  assert(malformed.ok && Buffer.compare(malformed.bytes, malformedBytes) === 0,
    "transport returns every byte of a present malformed payload without shape-scraping it");
  assert(malformedParsed?.ok === false,
    "a present malformed bridge file reaches the versioned host parser and terminates invalid_payload");

  let wallMs = 0;
  const unavailable = await bridge.fetchAgentBridgeSceneSnapshot("/fixture/adb", {
    serial: "fixture-serial",
    packageName: "com.test.conf",
    requestId: "missing_nonce_20260828",
    maxRetries: 0,
    pollMs: 10,
    stabilityReads: 2,
  }, {
    monotonicNs: () => ticks++,
    wallClockMs: () => wallMs,
    runText: async () => ({ code: 0, stdout: "ok", stderr: "", timedOut: false }),
    runBytes: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "No such file", timedOut: false }),
    sleep: async () => { wallMs = 100_000; },
  });
  assert(!unavailable.ok && unavailable.code === "bridge_unavailable",
    "missing terminal file fails as bridge_unavailable");
  assert(unavailable.actionReceipts.at(-1)?.status === "failed" &&
    unavailable.actionReceipts.at(-1)?.ack?.outcome === "timeout",
  "unavailable payload records a failed pull with explicit timeout outcome");

  let invalidSerialCalls = 0;
  const refused = await bridge.fetchAgentBridgeSceneSnapshot("/fixture/adb", {
    serial: "two serials",
    packageName: "com.test.conf",
    requestId: "refused_nonce_20260828",
    maxRetries: 0,
    pollMs: 10,
    stabilityReads: 2,
  }, {
    runText: async () => { invalidSerialCalls++; return { code: 0, stdout: "", stderr: "", timedOut: false }; },
  });
  assert(!refused.ok && refused.code === "bridge_unavailable" && invalidSerialCalls === 0,
    "ambiguous/non-exact serial input is refused before any adb call");
}

// §2.6 — skeletal animation. The gap that made most downloaded character GLBs un-animatable.
// The load-bearing rule is PROVENANCE: model-obtained clips are model-lifetime; generated clips are
// per-use. Getting it backwards either leaks every clip or closes one mid-playback.
console.log("\n§2.6 skeletal animation, and the provenance rule that decides disposal");
{
  const { generateSkeletalKotlin } = await import("../dist/skeletal.js");
  const kt = generateSkeletalKotlin({ packageName: "com.test.conf.content", modelUri: "asset://robot.glb", clips: ["Idle", "Wave"] });

  assert(/Entity\.load\(MODEL_URI\)/.test(kt) && /withContext\(Dispatchers\.IO\)/.test(kt),
    "the model load is the one call pushed to IO");
  // Everything else is @MainThread with a runtime check — moving it off-main throws.
  const ioBlock = /withContext\(Dispatchers\.IO\) \{[^}]*\}/.exec(kt)?.[0] ?? "";
  for (const mainOnly of ["findSkinnedMeshEntity", "getAnimationResources", "playAnimation", "stopAllAnimations"]) {
    assert(!ioBlock.includes(mainOnly), `${mainOnly} is NOT inside the IO block (it is @MainThread and would throw)`);
  }
  assert(/root\.findSkinnedMeshEntity\(\)/.test(kt),
    "findSkinnedMeshEntity runs on the PARENT (it searches this entity AND its children)");
  assert(/No Skinned Mesh Found/.test(kt),
    "an empty skinned-mesh array is logged (a non-skinned GLB returns empty silently)");
  assert(/firstOrNull \{ it\.getName\(\) == clipName \}/.test(kt),
    "clips are looked up BY NAME, not by a positional index into the GLB's clip order");
  assert(/index !in c\.indices/.test(kt), "the positional form is bounds-checked");

  // PROVENANCE: close exactly once, in dispose() — never in stop(), never on clip switch.
  const stopBody = /fun stop\(\) \{[\s\S]*?\n    \}/.exec(kt)?.[0] ?? "";
  const playBody = /fun play\(clipName[\s\S]*?\n    \}/.exec(kt)?.[0] ?? "";
  const disposeBody = /fun dispose\(\) \{[\s\S]*?\n    \}/.exec(kt)?.[0] ?? "";
  assert(stopBody && !/\.close\(\)/.test(stopBody), "stop() does NOT close model-owned clips");
  assert(playBody && !/\.close\(\)/.test(playBody), "switching clips does NOT close the previous one");
  assert(/clips\?\.forEach \{ runCatching \{ it\.close\(\) \} \}/.test(disposeBody),
    "dispose() is the ONE place model-owned clips are closed");
  // v35.25: there are now TWO close sites, and that is the point — two ownership classes, not one.
  // The model's clips are model-owned; anything AnimationResource.repeat() returns is app-created
  // (AnimationResource.kt:55-68 "Creates a new animation resource") and therefore ours to close.
  // Same type, opposite policy. What must stay invariant is that EVERY close is inside dispose().
  assert(/derived\.forEach \{ runCatching \{ it\.close\(\) \} \}/.test(disposeBody),
    "dispose() also closes the repeat()-derived resources, which the app created");
  assert((kt.match(/\.close\(\)/g) || []).length === (disposeBody.match(/\.close\(\)/g) || []).length,
    "every close() in the file is inside dispose() — none in stop(), none on clip switch");
  assert((kt.match(/\.close\(\)/g) || []).length === 2, "exactly two close() calls: model-owned clips, and app-derived resources");

  // A failed playAnimation must be LOGGED. A bare runCatching here is what made the on-device
  // experiment inconclusive: "no motion because it threw" and "no motion because the clip finished"
  // are indistinguishable from a capture unless the failure says so.
  assert(/playAnimation\([\s\S]{0,80}?\)[\s\S]{0,80}?\.onFailure/.test(kt),
    "a failed playAnimation is logged, not swallowed");
  assert(/AnimationPlayConfig has NO loop field|repeat\(count\)/.test(kt),
    "the play-once/repeat() trap is stated in the emitted file");

  const errs = runLint(kt, "kotlin").filter((v) => v.severity === "error").map((v) => v.ruleId).filter(Boolean);
  assert(errs.length === 0, `skeletal output is lint-clean${errs.length ? `: ${errs.join(", ")}` : ""}`);

  // The acquisition/release rule must respect provenance too: it fires on GENERATED clips and must
  // NOT fire on model-obtained ones, which are correctly left open.
  const modelClips = "val clips = e.findSkinnedMeshEntity().firstOrNull()?.getAnimationResources()\nval c = m.playAnimation(clips[0])";
  assert(!runLint(modelClips, "kotlin").map((v) => v.ruleId).includes("animationresource-never-closed"),
    "the never-closed rule does NOT fire on model-obtained clips (they are model-lifetime)");
  const generated = "val res = AnimationResource.generateWithTweenAnimation(anim)\nval c = e.playAnimation(res)";
  assert(runLint(generated, "kotlin").map((v) => v.ruleId).includes("animationresource-never-closed"),
    "the never-closed rule DOES fire on generated clips (you own those)");

  let threw = false;
  try { generateSkeletalKotlin({ packageName: "com.x", modelUri: "robot.glb" }); } catch { threw = true; }
  assert(threw, "a modelUri without a scheme is rejected");
}

// §1.5 — the invisible-wall defect. Tap targets must not exchange forces.
console.log("\n§1.5 tap targets are TRIGGER_LITE, not physical obstacles");
{
  const LANES = [
    ["interaction", "generate_interaction_kotlin", { packageName: "com.test.conf.content" }],
    ["tappable", "generate_tappable_detail_kotlin", { packageName: "com.test.conf.content", items: [{ id: "a", colorHex: "#3B82F6" }] }],
    ["spatialgestures", "generate_spatial_gestures_kotlin", { packageName: "com.test.conf.content", targetId: "gem", commandDispatcher: "dispatchGestureCommand" }],
  ];
  for (const [mod, tool, args] of LANES) {
    const m = await import(`../dist/${mod}.js`);
    const reg = Object.values(m).find((x) => typeof x === "function" && /^register/.test(x.name));
    const h = {};
    reg({ registerTool: (n, _meta, fn) => { h[n] = fn; } });
    const raw = (await h[tool](args)).content[0].text;
    const kt = raw.trimStart().startsWith("{")
      ? (() => { const j = JSON.parse(raw); return Object.values(j.files ?? {}).join("\n") || j.kotlin || raw; })()
      : raw;
    assert(/CollisionResponseMode\.TRIGGER_LITE/.test(kt), `${tool}: tap target uses TRIGGER_LITE`);
    assert(!/CollisionResponseMode\.COLLIDER_FULL,/.test(kt),
      `${tool}: no COLLIDER_FULL on an interactable (that makes the card an invisible wall)`);
    assert(!/CollisionFilter\.COLLISION_FILTER_DEFAULT/.test(kt),
      `${tool}: the filter is scoped, not COLLISION_FILTER_DEFAULT (group 1u + mask ALL always pairs)`);
    assert(/CollisionFilter\(CollisionGroup\(/.test(kt), `${tool}: emits an explicit CollisionFilter(group, mask)`);
    const errs = runLint(kt, "kotlin").filter((v) => v.severity === "error").map((v) => v.ruleId).filter(Boolean);
    assert(errs.length === 0, `${tool} is lint-clean${errs.length ? `: ${errs.join(", ")}` : ""}`);
  }

  // Physics colliders are MEANT to be physical — the fix must not have leaked into them.
  const phys = await import("../dist/physics.js");
  const ph = {};
  phys.registerPhysicsTools({ registerTool: (n, _m, f) => { ph[n] = f; } });
  const physKt = (await ph["generate_rigidbody_kotlin"]({ packageName: "com.test.conf.content" })).content[0].text;
  assert(!/TRIGGER_LITE/.test(physKt), "physics bodies are NOT demoted to TRIGGER_LITE (they must collide)");

  // And the guard itself.
  const bad = "entity.components.set(InteractableComponent())\nentity.components.set(CollisionComponent(listOf(s), m(), CollisionResponseMode.COLLIDER_FULL, CollisionFilter.COLLISION_FILTER_DEFAULT, CollisionInfoDetailLevel.BRIEF))";
  assert(runLint(bad, "kotlin").map((v) => v.ruleId).includes("interactable-collider-full"),
    "an InteractableComponent with COLLIDER_FULL is an error");
}

// P1-7 — Augment-backed components are a SILENT NO-OP outside a WindowContainer. No exception, no
// compile error, no pixel: AugmentImpl gates on isWindowContainer (Augments.kt:182) and its else
// branch only logs (:222-226). TabBar, Toolbar and Subwindow all route through it.
console.log("\nP1-7 Augment-backed components are refused outside a WindowContainer");
{
  const { generateSpatialUIKotlin } = await import("../dist/components.js");
  const AUGMENT_BACKED = ["tabBar", "toolbar"];
  for (const kind of AUGMENT_BACKED) {
    let refused = false, msg = "";
    try {
      generateSpatialUIKotlin({ packageName: "com.test.conf", panels: [{ kind, id: "p", title: "T", items: ["a", "b"], container: "ordinary" }] });
    } catch (e) { refused = true; msg = String(e?.message ?? e); }
    assert(refused, `${kind} in an 'ordinary' container is REFUSED (it would render nothing and only log)`);
    assert(/WindowContainer/.test(msg), `${kind}'s refusal names WindowContainer as the fix`);
  }
  // The already-guarded kinds must stay guarded.
  for (const kind of ["sheet", "snackbarHost", "coachmark"]) {
    let refused = false;
    try { generateSpatialUIKotlin({ packageName: "com.test.conf", panels: [{ kind, id: "p", title: "T", container: "ordinary" }] }); } catch { refused = true; }
    assert(refused, `${kind} in an 'ordinary' container is still refused`);
  }
  // A non-Augment kind must NOT be over-constrained.
  let ok = true;
  try { generateSpatialUIKotlin({ packageName: "com.test.conf", panels: [{ kind: "card", id: "c", title: "T", container: "ordinary" }] }); } catch { ok = false; }
  assert(ok, "a plain card is still valid in an ordinary container (the gate is not over-broad)");

  // followViewpoints: omitting it silently defaults to all four sides.
  const r = generateSpatialUIKotlin({ packageName: "com.test.conf", panels: [{ kind: "tabBar", id: "t", title: "T", items: ["Feeds", "Search"], container: "window" }] });
  const kt = typeof r === "string" ? r : (r.kotlin ?? JSON.stringify(r));
  assert(/followViewpoints = setOf\(ViewPoint\./.test(kt), "TabBar passes an explicit followViewpoints set");
  // TabBar.kt:81 imports the PLATFORM ViewPoint; there is a second, different ViewPoint in
  // ui.foundation.content, and picking that one would not compile.
  assert(/import com\.pico\.spatial\.ui\.platform\.ViewPoint/.test(kt),
    "ViewPoint comes from ui.platform (the type TabBar actually takes), not ui.foundation.content");
}

// §1.5/§5.3 — the event bus. One generator for physics, audio and animation, because they share one.
console.log("\n§5.3 the SDK event bus, and the preconditions that make handlers silently never fire");
{
  const { generateEventSubscriptionKotlin } = await import("../dist/events.js");
  const kt = generateEventSubscriptionKotlin({
    packageName: "com.test.conf.content",
    collision: ["Enter", "Exit"], animation: ["Started"], audio: ["PlaybackCompleted"],
  });

  assert(/private val subscriptions = mutableListOf<Cancellable>\(\)/.test(kt),
    "subscriptions are held in a LIST (one Cancellable? silently leaks all but the last)");
  assert(/fun unsubscribeAll\(\)/.test(kt) && /subscriptions\.forEach \{ runCatching \{ it\.cancel\(\) \} \}/.test(kt),
    "unsubscribeAll cancels every subscription");
  // Count real CALL SITES, not the doc comment that also says "content.subscribe(...)" — the same
  // prose-vs-code confusion that bit three lint rules this wave, here in the assertion itself.
  assert((kt.match(/content\.subscribe\(\w+Events\.\w+::class\.java\)/g) || []).length === 4,
    "one subscribe call site per requested event");

  // CollisionEvents.Exit carries ONLY entityA/entityB — reading position there does not compile.
  const exitBlock = /CollisionEvents\.Exit::class\.java\) \{ event ->[\s\S]*?\n            \},/.exec(kt)?.[0] ?? "";
  assert(exitBlock.length > 0, "the Exit handler is emitted");
  assert(!/event\.position|event\.impulse|event\.contacts/.test(exitBlock),
    "the Exit handler reads no position/impulse/contacts (Exit carries entityA/entityB only)");
  const enterBlock = /CollisionEvents\.Enter::class\.java\) \{ event ->[\s\S]*?\n            \},/.exec(kt)?.[0] ?? "";
  assert(/event\.position/.test(enterBlock), "the Enter handler DOES read position");

  // The two silent-failure preconditions must be stated in the emitted file.
  assert(/at least one[\s\S]{0,40}dynamic/i.test(kt),
    "the emitted file states that events fire only when a body is DYNAMIC (two statics fire nothing)");
  assert(/kinematicCollisionReportMode/.test(kt), "it names the override for the static/kinematic case");
  assert(/BRIEF/.test(kt) && /contacts/i.test(kt),
    "it states that event.contacts is empty under the default BRIEF detail level");

  // It must not emit the samples' generic when(event) wrapper, which only compiles via smart cast.
  assert(!/when \(event\)/.test(kt), "emits the direct class-literal form, not the smart-cast-dependent generic wrapper");

  const errs = runLint(kt, "kotlin").filter((v) => v.severity === "error").map((v) => v.ruleId).filter(Boolean);
  assert(errs.length === 0, `event file is lint-clean${errs.length ? `: ${errs.join(", ")}` : ""}`);

  // And it must be REACHABLE — the v35.9 lesson.
  const { CAPABILITY_MANIFEST } = await import("../dist/capabilities.js");
  assert(CAPABILITY_MANIFEST.some((c) => c.tool === "generate_event_subscription_kotlin"), "the event tool is in the manifest");
  const { buildLedger } = await import("../dist/compiler.js");
  const spec = appSpecSchema.parse({
    meta: { appName: "B", packageName: "com.test.b", stageStyle: "1", brief: "b" },
    navigation: { startScene: "main", portals: [] },
    scenes: [{ id: "main", environment: { kind: "procedural" }, physics: { events: ["Enter"] } }],
    objects: [{ id: "o", sceneId: "main", source: "primitive", transform: { position: [0, 1, -2] } }],
  });
  assert(buildLedger(spec, "/tmp/b").some((st) => st.tool === "generate_event_subscription_kotlin"),
    "scenes[].physics.events routes to the event generator");
}

// P1-7 — SideNavigation. The trap: SideNavigationItem has NO onClick.
console.log("\nP1-7 SideNavigation encodes the missing-onClick trap");
{
  const { generateSpatialUIKotlin } = await import("../dist/components.js");
  const r = generateSpatialUIKotlin({ packageName: "com.test.conf", panels: [{ kind: "sideNavigation", id: "n", title: "N", items: ["Profile", "Settings"], container: "window" }] });
  const kt = typeof r === "string" ? r : (r.kotlin ?? "");
  // SideNavigation.kt:140-152 has nine params and none is onClick, despite `shape` being documented
  // as "Shape of the item's clickable surface". Emitting onClick does not compile; emitting no
  // modifier compiles into an item that can never be selected.
  assert(!/SideNavigationItem\([^)]*onClick/.test(kt), "no onClick on SideNavigationItem (it has no such parameter)");
  assert(/Modifier\.spatialHoverEffect\(\)\.clickable/.test(kt), "clickability comes from a Modifier, as in PICO's sample");
  assert(/import com\.pico\.spatial\.ui\.design\.SideNavigation\b/.test(kt), "imported from design, not design.windows");
  assert((kt.match(/import androidx\.compose\.ui\.Modifier/g) || []).length === 1,
    "Modifier is imported exactly once (a duplicate is a Kotlin 'ambiguous import' error)");
}

// §1.2/§1.3/§1.6 — physics resource sharing, the .apply{} form, and reset-by-toggling.
console.log("\n§1.2/1.3/1.6 physics: shared resources, expressive bodies, toggle-not-rebuild");
{
  const phys = await import("../dist/physics.js");
  const ph = {};
  phys.registerPhysicsTools({ registerTool: (n, _m, f) => { ph[n] = f; } });
  const kt = (await ph["generate_rigidbody_kotlin"]({ packageName: "com.test.conf.content" })).content[0].text;

  // §1.3 — one material and one shape per KIND, not per body. A 50-body scene used to allocate 50.
  assert(/private val physMat = PhysicsMaterialResource\(/.test(kt), "the physics material is hoisted to a single shared val");
  assert(!/private fun physMat\(\)/.test(kt), "physMat is no longer a per-call factory");
  assert(/private val shapeCache = mutableMapOf<String, ShapeResource>\(\)/.test(kt), "shapes are memoized");
  assert(/private val meshCache = mutableMapOf<String, MeshResource>\(\)/.test(kt), "meshes are memoized");
  assert(/shapeFor\(/.test(kt) && /meshFor\(/.test(kt), "the helpers actually route through the caches");

  // §1.2 — the 2-arg ctor cannot express inertia/centerOfMass/gravity; centerOfMass is what makes a
  // toppling chain work. A fresh instance per entity stays mandatory.
  assert(/RigidBodyComponent\(\)\.apply \{/.test(kt), "bodies use the no-arg + .apply{} form PICO document");
  assert(/centerOfMass/.test(kt) && /inertia/.test(kt), "inertia and centerOfMass are expressible");
  assert(/isAffectedByGravity/.test(kt), "isAffectedByGravity is expressible");

  // §1.6 — toggle the component on a LIVE entity rather than rebuilding the world.
  assert(/fun setDynamic\(body: Entity, enabled: Boolean/.test(kt), "setDynamic toggles simulation on a live body");
  assert(/components\.remove\(RigidBodyComponent::class\.java\)/.test(kt), "disabling REMOVES the component (PICO's play loop)");
  assert(/fun resetTo\(/.test(kt), "resetTo restores a pose");
  // ...and it must restore IN PLACE; replacing the component would stamp identity rotation + unit scale.
  const resetBody = /fun resetTo\([\s\S]*?\n    \}/.exec(kt)?.[0] ?? "";
  assert(resetBody && !/components\.set\(TransformComponent\(/.test(resetBody), "resetTo mutates the transform in place");

  // R3 is untouched: destroying a physics world still poisons later worlds, so resetWorld survives.
  assert(/fun resetWorld\(/.test(kt), "resetWorld remains for structural rebuilds");

  const errs = runLint(kt, "kotlin").filter((v) => v.severity === "error").map((v) => v.ruleId).filter(Boolean);
  assert(errs.length === 0, `physics output is lint-clean${errs.length ? `: ${errs.join(", ")}` : ""}`);

  // The narrowed rule must still catch a genuine LIVE flip while allowing construction-time init.
  const liveFlip = "body.components.get<RigidBodyComponent>()?.rigidBodyMode = RigidBodyMode.KINEMATIC";
  assert(runLint(liveFlip, "kotlin").map((v) => v.ruleId).includes("physics-kinematic-flip"),
    "flipping rigidBodyMode on an attached component is still an error");
  const ctorInit = "e.components.set(RigidBodyComponent().apply { rigidBodyMode = RigidBodyMode.DYNAMIC })";
  assert(!runLint(ctorInit, "kotlin").map((v) => v.ruleId).includes("physics-kinematic-flip"),
    "setting the mode on a FRESH component is allowed (it is what the rule's own fix recommends)");
}

// §6.6 — one bundle per path, refcounted by owner.
console.log("\n§6.6 bundle leases are owner-refcounted, and validity is re-checked");
{
  const { generateBundleLeaseKotlin } = await import("../dist/bundlelease.js");
  const kt = generateBundleLeaseKotlin({ packageName: "com.test.conf.content", bundles: ["asset://furniture.bundle"] });

  assert(/private val owners = mutableMapOf<String, MutableSet<String>>\(\)/.test(kt),
    "leases are keyed by OWNER, not a bare count");
  // The whole point: release must be a no-op while anyone else holds the lease.
  const rel = /suspend fun release\(path: String, owner: String\)[\s\S]*?\n    \}/.exec(kt)?.[0] ?? "";
  assert(rel.length > 0, "release is emitted");
  assert(/if \(set\.isNotEmpty\(\)\)[\s\S]*?return@withLock/.test(rel),
    "release returns early while other owners remain (it must not free what the room still holds)");
  assert(/bundles\.remove\(path\)\?\.let \{ runCatching \{ it\.close\(\) \} \}/.test(rel),
    "the bundle is closed only on the LAST release");
  // A cache handing back a closed bundle fails far from the cache.
  assert(/existing != null && existing\.valid/.test(kt), "AssetBundle.valid is re-checked before reuse");
  // acquire suspends on IO, so a synchronized block cannot span it.
  assert(/private val lock = Mutex\(\)/.test(kt) && /lock\.withLock/.test(kt), "concurrency uses a suspending Mutex");
  assert(!/\bsynchronized\s*\(/.test(kt), "not synchronized (it cannot span a suspension point)");
  assert(/suspend fun closeAll\(\)/.test(kt), "there is a teardown that closes everything");

  const errs = runLint(kt, "kotlin").filter((v) => v.severity === "error").map((v) => v.ruleId).filter(Boolean);
  assert(errs.length === 0, `bundle lease is lint-clean${errs.length ? `: ${errs.join(", ")}` : ""}`);

  let threw = false;
  try { generateBundleLeaseKotlin({ packageName: "com.x", bundles: ["furniture.bundle"] }); } catch { threw = true; }
  assert(threw, "a bundle path without a scheme is rejected");
}

// CP2 flagship — one typed Mixed-stage room experience must lower through existing generators.
console.log("\nCP2 Swan Mission Table profile is room-aware, lifecycle-paired, and fleet-writable");
{
  const entry = JSON.parse(read("briefs/swanmissiontable.json"));
  const parsed = appSpecSchema.safeParse(entry.spec);
  assert(parsed.success, `flagship brief validates${parsed.success ? "" : `: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`}`);
  if (parsed.success) {
    const spec = parsed.data;
    const { buildLedger } = await import("../dist/compiler.js");
    const ledger = buildLedger(spec, "/tmp/swanmissiontable-conformance");
    const toolNames = ledger.map((step) => step.tool);
    const systems = ledger.filter((step) => step.tool === "generate_ecs_system_kotlin");
    assert(toolNames.includes("generate_scene_understanding_kotlin"), "room profile emits the existing scene-understanding primitive");
    assert(toolNames.indexOf("generate_scene_understanding_kotlin") < toolNames.indexOf("generate_app_wiring"),
      "scene bridge/readiness code is generated before app wiring");
    assert(systems.length === 2 && new Set(systems.map((step) => step.args.kind)).size === 2 && systems.some((step) => step.args.kind === "spin") && systems.some((step) => step.args.kind === "orbit"),
      "one shared Spin pair and one shared Orbit pair serve all engine-ticked entities");
    assert(ledger.filter((step) => step.tool === "generate_attachment_panel_kotlin").length === 1,
      "the WALL_ART companion uses the existing in-scene AttachmentPanel surface");

    const files = generateWiring(spec);
    const home = files.find((file) => file.path.endsWith("/HomeStage.kt"))?.content ?? "";
    const mission = files.find((file) => file.path.endsWith("/MissionTableExperience.kt"))?.content ?? "";
    const panel = files.find((file) => file.path.endsWith("/SceneAttachments.kt"))?.content ?? "";
    assert(files.length === 5 && mission && panel, "typed wiring emits the core three files plus experience and attachment files");
    assert(home.includes('AgentBridge.attachScene(sceneRoot, "stage")') && home.includes("SceneUnderstanding.registerAgentBridgeSceneSnapshot()"),
      "Stage root is identity-bound and registers the revision-41 scene producer");
    assert(/DisposableEffect\(lifecycleOwner\)[\s\S]*registerSystem<SpinSystem>\(\)[\s\S]*registerSystem<OrbitSystem>\(\)[\s\S]*onDispose[\s\S]*MissionTableExperience\.stop\(\)[\s\S]*unregisterSystem<OrbitSystem>\(\)[\s\S]*unregisterSystem<SpinSystem>\(\)[\s\S]*AgentBridge\.detachScene\(root\)[\s\S]*root\.destroy\(true\)/.test(home),
      "composition pairs mesh/job cleanup, ECS unregister, exact bridge detach, and recursive scene teardown");
    assert(home.includes("attachments = { sceneAttachmentPanels(panelSizes) }") && home.includes("attachments.seatSceneAttachmentPanels(content)"),
      "scene attachment builder and entity seating are both wired");
    assert(home.includes('cmd == "mission:launch"') && home.includes('cmd == "mission:pause"') && home.includes('cmd == "mission:reset"'),
      "broadcast validation routes to the same launch/pause/reset state functions as the panel");

    const readinessAt = mission.indexOf("SceneUnderstanding.awaitUnfilteredMesh");
    const classifyMatch = /classify(?:Room)?Anchors\(anchors\)/.exec(mission);
    const classifyAt = classifyMatch?.index ?? -1;
    const classifier = /private fun classify(?:Room)?Anchors[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    assert(readinessAt >= 0 && readinessAt < classifyAt,
      "every placement pass establishes unfiltered readiness before classifying labels from that snapshot");
    assert(classifier.includes("SemanticLabelType.TABLE") && classifier.includes("SemanticLabelType.FLOOR") &&
      classifier.includes("SemanticLabelType.WALL_ART") && (classifier.match(/anchor\.semantics/g) ?? []).length === 1,
      "one off-main classifier reads per-face semantics once per anchor for TABLE/FLOOR/WALL_ART");
    assert(!mission.includes("SceneUnderstanding.anchorsLabeled(anchors,"),
      "the flagship does not rescan the full per-face semantic stream once per requested label");

    const startTracking = /fun (?:start|resumeTracking)\([^)]*\) \{[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    const requeryLoop = /requeryJob = scope\.launch[\s\S]*?while \(isActive\) \{[\s\S]*?\n            \}/.exec(startTracking)?.[0] ?? "";
    const awaitNextPass = /private suspend fun awaitNextPass[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    assert(/SupervisorJob\(\) \+ Dispatchers\.Default/.test(startTracking) || /scope\.launch\(Dispatchers\.Default\)/.test(startTracking),
      "room snapshot loading and semantic classification run off Android Main");
    const rematchRoom = /private suspend fun rematchRoom[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    const resolveRoomMatch = /private suspend fun resolveRoomMatch[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    const applyRoomMatch = /private fun applyRoomMatch[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    const rematchMainAt = rematchRoom.search(/withContext\(Dispatchers\.Main(?:\.immediate)?\)/);
    assert(rematchMainAt > rematchRoom.indexOf("resolveRoomMatch()") &&
      !/MissionTableUi\.|anchorRoot\?\.enabled|seatPanel\(|applyTable\(|applyFloorFallback\(/.test(rematchRoom.slice(0, rematchMainAt)) &&
      /applyRoomMatch\(match\)/.test(rematchRoom.slice(rematchMainAt)) &&
      /awaitUnfilteredMesh[\s\S]*classify(?:Room)?Anchors\(anchors\)[\s\S]*return RoomMatch/.test(resolveRoomMatch) &&
      !/Dispatchers\.Main|MissionTableUi\.|anchorRoot\?\.enabled|seatPanel\(|applyTable\(|applyFloorFallback\(/.test(resolveRoomMatch) &&
      /MissionTableUi\.|seatPanel\(|applyTable\(|applyFloorFallback\(/.test(applyRoomMatch),
      "only the compact RoomMatch and its placement/Compose-state decisions cross back to Android Main");
    assert(requeryLoop.includes("while (isActive)") && requeryLoop.includes("rematchRoom()") &&
      requeryLoop.includes("awaitNextPass(signals)") && !/\bcontinue\b/.test(requeryLoop),
      "every re-query iteration reaches one cancellable wait, including label-absent returns");
    assert(awaitNextPass.includes("withTimeoutOrNull(REQUERY_MS)") && awaitNextPass.includes("signals.receive()") &&
      awaitNextPass.includes("delay(MIN_REQUERY_GAP_MS)"),
      "periodic polling sleeps and event storms are debounce-bounded rather than busy-looping");
    assert(mission.includes("Channel<Unit>(Channel.CONFLATED)") && mission.includes("signals.trySend(Unit)"),
      "mesh event pressure is conflated before the bounded re-query scheduler");
    assert(!/\brunBlocking\b|Thread\.sleep|SystemClock\.sleep|while\s*\(\s*true\s*\)/.test(mission),
      "mission waiting has no blocking sleep, runBlocking, or unbounded bare loop");

    const build = /fun build\([^)]*\) \{[\s\S]*?(?=\n    private suspend fun populateInstallation)/.exec(mission)?.[0] ?? "";
    const populate = /private suspend fun populateInstallation[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    const primitive = /private fun primitive[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    const prepareResources = /private (?:suspend )?fun (?:prepare|create)Resources[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    const resourceFactory = prepareResources || populate;
    assert(/SupervisorJob\(\) \+ Dispatchers\.Default/.test(build) ||
      /withContext\(Dispatchers\.Default\)[\s\S]*(?:prepare|create)Resources\(/.test(populate),
      "native mesh/resource construction is dispatched away from Android Main");
    const mainAttachAt = populate.search(/withContext\(Dispatchers\.Main(?:\.immediate)?\)/);
    assert(mainAttachAt > 0 && /MeshResource\.create/.test(resourceFactory) &&
      /PhysicallyBasedMaterial\.create/.test(resourceFactory) &&
      !/MeshResource\.create|PhysicallyBasedMaterial\.create/.test(populate.slice(mainAttachAt)) &&
      /primitive\(installation/.test(populate.slice(mainAttachAt)),
      "meshes and materials are prepared off-main before bounded Main-thread entity attachment");
    assert(!/MeshResource\.create|PhysicallyBasedMaterial\.create/.test(primitive),
      "the Main-thread primitive helper only creates entities/components from prepared resources");
    assert(/(?:data )?class PreparedResources/.test(mission) && /private var preparedResources: PreparedResources\?/.test(mission),
      "all generated meshes/materials have one retained ownership record");
    const preparedResources = /(?:data )?class PreparedResources[\s\S]*?(?=\n    private (?:var|val|fun|suspend|data|class))/.exec(mission)?.[0] ?? "";
    assert((preparedResources.match(/MeshResource/g) ?? []).length >= 4 &&
      preparedResources.includes("PhysicallyBasedMaterial") && /\.close\(\)/.test(preparedResources),
      "PreparedResources owns the four native meshes plus materials and can close them");
    assert(/catch \((?:cause|failure): Throwable\)[\s\S]*\.close\(\)[\s\S]*throw (?:cause|failure)/.test(resourceFactory),
      "partial or cancelled resource preparation closes local ownership before rethrowing");

    for (const event of ["ON_PAUSE", "ON_STOP"]) {
      assert(new RegExp(`Lifecycle\\.Event\\.${event}[\\s\\S]{0,280}MissionTableExperience\\.pauseTracking\\(\\)`).test(home),
        `${event} cancels the label wait and stops mesh tracking`);
    }
    assert(/Lifecycle\.Event\.ON_(?:START|RESUME)[\s\S]{0,320}MissionTableExperience\.(?:resumeTracking|start)\(/.test(home),
      "foreground lifecycle resumes room matching against the current Stage root");
    assert(/lifecycle\.removeObserver\(observer\)[\s\S]*MissionTableExperience\.stop\(\)/.test(home),
      "composition disposal removes the lifecycle observer before full experience teardown");
    assert(/MissionTableExperience\.stop\(\)[\s\S]*AgentBridge\.detachScene\(root\)[\s\S]*root\.destroy\(true\)[\s\S]*MissionTableExperience\.releaseResources\(\)/.test(home),
      "full teardown destroys every referencing entity before closing prepared meshes/materials");
    const pauseTracking = /fun pauseTracking\(\) \{[\s\S]*?(?=\n    (?:private )?fun )/.exec(mission)?.[0] ?? "";
    assert(pauseTracking.indexOf("requeryJob?.cancel()") >= 0 &&
      pauseTracking.indexOf("requeryJob?.cancel()") < pauseTracking.indexOf("ownerScope?.cancel()") &&
      pauseTracking.indexOf("ownerScope?.cancel()") < pauseTracking.indexOf("meshSignals?.close()") &&
      pauseTracking.indexOf("meshSignals?.close()") < pauseTracking.indexOf("SceneUnderstanding.stopMesh()"),
      "pause cancels the job/scope/channel before releasing the mesh tracker");
    assert(mission.includes('MissionTableUi.panelAnchor = "MESH NOT READY — stage fallback"') &&
      mission.includes('MissionTableUi.surface = "MESH not ready"'),
      "lost unfiltered readiness clears stale placement claims and restores the explicit stage fallback");
    const supportAt = resolveRoomMatch.indexOf("val supportPosition = table?.transform?.position ?: floor?.transform?.position ?: Vector3(FLOOR_FALLBACK_X_M, 0f, FLOOR_FALLBACK_Z_M)");
    const artAt = resolveRoomMatch.indexOf("val art = selectWallArt(candidates.wallArts, supportPosition)");
    assert(supportAt > resolveRoomMatch.indexOf("val floor = selectFloor") && artAt > supportAt &&
      resolveRoomMatch.indexOf("return RoomMatch(meshReady = true, table = table, floor = floor, wallArt = art)") > artAt &&
      !/if \(table == null\)[\s\S]*return/.test(resolveRoomMatch.slice(supportAt, artAt)),
      "WALL_ART selection remains live when TABLE is absent instead of falling back early");
    const floorFallback = /private fun applyFloorFallback[\s\S]*?(?=\n    private (?:suspend )?fun )/.exec(mission)?.[0] ?? "";
    assert(/if \(table != null\) \{\s*applyTable\(table\)\s*\} else if \(floor != null\) \{\s*applyFloorFallback\(floor\)/.test(applyRoomMatch),
      "TABLE wins whenever present, while FLOOR is the explicit label-absent fallback on every re-query");
    assert(floorFallback.includes("anchorEntity.enabled = true") && floorFallback.includes("fallbackPlinth?.enabled = true") &&
      floorFallback.includes("FLOOR_FALLBACK_X_M") && floorFallback.includes("FLOOR_FALLBACK_Z_M") &&
      floorFallback.includes("val source = host.convertTransformFrom(pose, null)") &&
      floorFallback.includes("transform.position = source.position") &&
      floorFallback.includes("val topOffset = abs(bounds.y) * 0.5f + FLOOR_PLINTH_HEIGHT_M + 0.008f") &&
      floorFallback.includes("transform.position = Vector3(localX, topOffset, localZ)") &&
      (floorFallback.match(/\.coerceIn\(/g) ?? []).length >= 2 && floorFallback.includes("FLOOR fallback"),
      "FLOOR fallback remains visible at live floor height and clamps a deterministic forward X/Z pose");
    assert(!/Vector3\(\s*(?:source|floor|surface)[A-Za-z]*\.x[\s\S]{0,160}(?:source|floor|surface)[A-Za-z]*\.z/.test(floorFallback),
      "FLOOR fallback never inherits the room-sized floor anchor centroid for X/Z");
    assert(mission.includes("width in TABLE_MIN_WIDTH_M..TABLE_MAX_WIDTH_M") && mission.includes("depth in TABLE_MIN_DEPTH_M..TABLE_MAX_DEPTH_M") &&
      mission.includes("width in ART_MIN_WIDTH_M..ART_MAX_WIDTH_M") && mission.includes("height in ART_MIN_HEIGHT_M..ART_MAX_HEIGHT_M"),
      "TABLE and WALL_ART candidates tolerate declared geometry ranges instead of exact counts");
    assert(mission.includes("rotateVector(Vector3.UP)") && mission.includes("Vector3.dot(up, Vector3.UP) >= 0.85f") &&
      mission.includes("finite(bounds)") && mission.includes("finite(pose.quaternion)"),
      "TABLE selection rejects non-horizontal, down-facing, and non-finite anchors");
    assert(mission.includes("val height = abs(bounds.z)") && mission.includes("boundingBoxSize.x * it.boundingBoxSize.z"),
      "WALL_ART selection follows the measured thin-Y/tall-Z anchor convention");
    assert(mission.includes('entity.setName("ROOM_SUPPORT_label_anchor")') && mission.includes('entity.setName("metre_authored_installation")') &&
      mission.includes("host.convertTransformFrom(anchor.transform, null)") && mission.includes("transform.position = Vector3(0f, topOffset, 0f)"),
      "exact label pose and local surface-lift/scale live on separate owned roots");
    assert(mission.indexOf("offsetTowardStageOrigin(art.transform.position)") < mission.indexOf("hostRoot?.convertPositionFrom(stagePosition, null)"),
      "WALL_ART offset is computed toward Stage origin before conversion into the panel host frame");
    assert(mission.includes("lastPanelPosition") && mission.includes("sqrt(distanceSquared(position, previous)) <= POSITION_DEADBAND_M"),
      "WALL_ART panel re-seating applies the same positional deadband as TABLE placement");
    assert(mission.includes("host.addChild(panelEntity)") && mission.includes("panel?.removeFromParent()") &&
      !panel.includes("content.addEntity(panel)"),
      "the attachment has one scene-graph owner and is detached before recursive root teardown");
    assert(!/candidates\s*\[|anchorsLabeled\([^\n]+\)\s*\[/.test(mission) && !/anchorsLabeled[^\n]*(?:size\s*==|count\s*==)/.test(mission),
      "runtime selection never indexes an anchor list or asserts a label count");
    assert(/earth\?\.components.*TransformComponent.*Quat\.identity/.test(mission) &&
      /spacecraft\?\.components.*OrbitComponent.*SPACECRAFT_START_ANGLE/.test(mission) &&
      /spacecraft\?\.components.*TransformComponent.*SPACECRAFT_START_POSITION/.test(mission),
      "RESET restores transforms as well as ECS component phases");
    assert(mission.includes("angle = SPACECRAFT_START_ANGLE") && mission.includes("angle = 0f"),
      "Moon and spacecraft retain separate authored orbit phases");
    assert(mission.includes("accumulatedPauseMs += (now - pausedAtMs).coerceAtLeast(0L)") &&
      mission.includes("now - missionStartedAtMs - accumulatedPauseMs"),
      "elapsed mission time excludes paused wall-clock duration");
    const missionStop = /fun stop\(\) \{[\s\S]*?Log\.i\(TAG, "stopped/.exec(mission)?.[0] ?? "";
    assert(missionStop.includes("panel?.removeFromParent()") && missionStop.includes("resetSessionState()") &&
      /missionStarted = false[\s\S]*paused = false[\s\S]*missionStartedAtMs = 0L[\s\S]*MissionTableUi\.phase/.test(mission),
      "Stage disposal resets runtime clocks and UI before the owned root is destroyed");
    assert((mission.match(/MeshResource\.createSphere\(/g) ?? []).length === 1 &&
      /primitive\(installation, "orbit_dot_" \+ index, (?:resources\.)?unitSphere/.test(mission),
      "one shared unit-sphere mesh avoids repeated native construction on the background build lane");
    assert(mission.includes("setBlendingMode(BlendingMode.TRANSPARENT)") && mission.includes("setOpacity(opacity)") &&
      mission.includes("setDepthWrite(false)") && mission.includes("opacity = 0.38f"),
      "atmosphere explicitly uses transparent PBR blending, opacity, and disabled depth writes");
    assert(panel.includes("PicoTheme {") && panel.includes("com.pico.spatial.ui.design.Button") && !/androidx\.compose\.material/.test(panel),
      "mission controls use SpatialUI Button/Text inside PicoTheme with no Material import");
    const customized = structuredClone(spec);
    customized.panels[0].id = "mission_wall_panel";
    customized.panels[0].title = "ROOM-SCALE FLIGHT DIRECTOR";
    customized.panels[0].placement.position = [0.25, 1.5, -1.25];
    customized.panels[0].placement.widthDp = 612;
    customized.panels[0].placement.heightDp = 324;
    customized.panels[0].fields.find((field) => field.key === "phase").initial = "READY $5";
    customized.interactions.find((interaction) => interaction.action === "mission:launch").params = { label: "IGNITE" };
    const customizedPanel = generateWiring(customized).find((file) => file.path.endsWith("/SceneAttachments.kt"))?.content ?? "";
    const customizedMission = generateWiring(customized).find((file) => file.path.endsWith("/MissionTableExperience.kt"))?.content ?? "";
    assert(customizedPanel.includes('MISSION_PANEL_ID = "mission_wall_panel"') &&
      customizedPanel.includes("panelSize(612.dp, 324.dp)") &&
      customizedPanel.includes("MissionTableExperience.STAGE_FALLBACK_POSITION") &&
      customizedMission.includes("val STAGE_FALLBACK_POSITION = Vector3(0.25f, 1.5f, -1.25f)") &&
      (customizedMission.match(/seatPanel\(STAGE_FALLBACK_POSITION\)/g) ?? []).length >= 3 &&
      customizedPanel.includes('Text("ROOM-SCALE FLIGHT DIRECTOR"') && customizedPanel.includes('Text("IGNITE")') &&
      customizedPanel.includes('mutableStateOf("READY \\$5")'),
      "mission panel id, dimensions, pose, title, and control labels derive from AppSpec metadata");
    assert(mission.includes("Per-face semantic alignment is unverified") && !/semanticAssignments|vertices\[|indices\[/.test(mission),
      "placement remains label-level and does not consume unverified triangle semantics");

    const sense = await import("../dist/sense.js");
    const senseHandlers = {};
    sense.registerSenseTools({ registerTool: (name, _meta, handler) => { senseHandlers[name] = handler; } });
    const senseKt = (await senseHandlers.generate_scene_understanding_kotlin({
      packageName: "com.test.mission.content",
      agentBridgePackage: "com.test.mission.agent",
    })).content[0].text;
    assert(/private var meshUpdateListener/.test(senseKt) && /startMeshOrThrow\(meshUpdateListener\)/.test(senseKt),
      "bridge-owned tracker epochs preserve the app's mesh-update listener");
    assert(/suspend fun awaitUnfilteredMesh[^{]+List<MeshAnchor>\?/.test(senseKt) && /fresh\.isNotEmpty\(\)/.test(senseKt) && /return fresh/.test(senseKt) && !/TrackingState\.RUNNING/.test(/suspend fun awaitUnfilteredMesh[\s\S]*?\n    \}/.exec(senseKt)?.[0] ?? ""),
      "shared readiness returns the accepted unfiltered snapshot and never trusts RUNNING state");
    const awaitMesh = /suspend fun awaitUnfilteredMesh[\s\S]*?(?=\n    (?:private )?(?:suspend )?fun )/.exec(senseKt)?.[0] ?? "";
    assert(/CancellationException/.test(awaitMesh) && /throw (?:cause|it)/.test(awaitMesh),
      "mesh-read error handling rethrows coroutine cancellation instead of turning lifecycle stop into an empty read");
    assert(/withTimeoutOrNull\(15_000L\)/.test(awaitMesh) && /loaded \?: emptyList\(\)/.test(awaitMesh),
      "an individual mesh-read timeout remains a retryable empty observation instead of cancelling the lifecycle-owned re-query job");
    assert(/if \(requeryJob\?\.isActive == true && ownerScope\?\.isActive == true && hostRoot === sceneRoot\) return/.test(mission),
      "foreground resume restarts a failed or completed re-query job even when its Supervisor scope remains active");
    assert(/fun anchorsLabeled\(anchors: List<MeshAnchor>, label: SemanticLabelType\)/.test(senseKt),
      "shared scene code can label-filter one accepted runtime snapshot without additional geometry loads");

    const fleet = await import("../dist/fleetbuild.js");
    const normalized = fleet.generatedFileEntries({ files: {
      "SpinComponent.kt": "package com.test.mission.ecs\nclass SpinComponent",
      "SpinSystem.kt": "package com.test.mission.ecs\nclass SpinSystem",
    } }, "app/src/main/java/com/test/mission/ecs/SpinSystem.kt");
    assert(normalized.length === 2 && normalized.every((file) => file.targetPath.includes("/ecs/")),
      "fleet writes every record-shaped companion file beside the ledger target");
    let refusedMixedFiles = false;
    try {
      fleet.generatedFileEntries({ files: {
        "SpinComponent.kt": "package com.test.mission.ecs\nclass SpinComponent",
        "../SpinSystem.kt": "package com.test.mission.ecs\nclass SpinSystem",
      } }, "app/src/main/java/com/test/mission/ecs/SpinSystem.kt");
    } catch { refusedMixedFiles = true; }
    assert(refusedMixedFiles, "fleet refuses an entire companion-file record when any entry is malformed");
  }

  const wrongStage = structuredClone(entry.spec);
  wrongStage.meta.stageStyle = "3";
  assert(!appSpecSchema.safeParse(wrongStage).success, "room profile refuses a non-Mixed Stage");
  const noPanel = structuredClone(entry.spec);
  noPanel.panels = [];
  assert(!appSpecSchema.safeParse(noPanel).success, "room profile refuses a missing in-scene mission panel");
  const noSpin = structuredClone(entry.spec);
  noSpin.objects.forEach((object) => { if (object.anim?.type === "spin") delete object.anim; });
  assert(!appSpecSchema.safeParse(noSpin).success, "room profile refuses a missing engine-spin lane");
  const missingControl = structuredClone(entry.spec);
  missingControl.interactions = missingControl.interactions.filter((interaction) => interaction.action !== "mission:pause");
  assert(!appSpecSchema.safeParse(missingControl).success, "room profile refuses missing mission control metadata");
  const ignoredPanelField = structuredClone(entry.spec);
  ignoredPanelField.panels[0].fields.push({ key: "ignored", label: "IGNORED", initial: "?" });
  assert(!appSpecSchema.safeParse(ignoredPanelField).success, "room profile refuses panel fields the generator cannot represent");
}

console.log(`\nSample-conformance gate done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
