import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { auditProjectConfig } from "./projectconfig.js";
import { defaultVaultRoot, loadVaultIndex, runVaultCheck } from "./vault.js";
import type { VaultFinding, VaultIndex } from "./vault.js";

/**
 * lint.ts — v5.1 the RETAINED-LESSONS LINT ENGINE.
 *
 * Every hard-won MEMORY.md / diagnose gotcha becomes an EXECUTABLE, fixture-backed lint rule the planner
 * (and the brief_to_app loop) runs BEFORE codegen — so the loop can never repeat a solved mistake. Two tools:
 *   - preflight_lint(content, kind?) — scan emitted Kotlin / a shell command / gradle config for the known
 *     anti-patterns and return violations (ruleId, severity, line, message, fix, designRule). It merges the
 *     built-in rules with any lessons learned via record_lesson.
 *   - record_lesson(...) — append a NEW rule (pattern + message + fix) to ~/.pico-mcp/lessons.json whenever a
 *     novel diagnose resolution surfaces a fresh gotcha, growing the KB over time.
 *
 * Each built-in rule ships its OWN positive + negative fixture, so `npm run test:lint` proves every rule
 * fires on the mistake and passes clean code — the genuinely test-verifiable heart of v5.1.
 */

export type RuleKind = "kotlin" | "command" | "gradle" | "usd" | "any";
export interface LintRule {
  id: string;
  severity: "error" | "warn";
  kinds: RuleKind[];
  /** "present": fires if `pattern` matches. "conditional": fires if `when` matches AND `unless` does NOT. */
  type: "present" | "conditional";
  pattern?: RegExp;
  when?: RegExp;
  unless?: RegExp;
  message: string;
  fix: string;
  designRule?: string;
  positiveFixture: string; // MUST trigger this rule
  negativeFixture: string; // MUST NOT trigger this rule
  learned?: boolean;
}

// ── The built-in rules (one per retained gotcha) ────────────────────────────────────────────────────────
export const BUILTIN_RULES: LintRule[] = [
  {
    id: "compose-fork-direct-dependency",
    severity: "error",
    kinds: ["gradle"],
    type: "present",
    pattern: /(?:implementation|api)\s*\(\s*["']androidx\.compose\.(?:ui|foundation):/,
    message: "Direct androidx.compose dependency bypasses the PICO Spatial fork and BOM exclusions.",
    fix: "Use the PICO Spatial UI artifact and preserve the required configurations.all exclusions; audit a project directory with preflight_lint(projectDir) or verify_gradle_config.",
    positiveFixture: 'implementation("androidx.compose.ui:ui:1.7.0")',
    negativeFixture: 'implementation(libs.platform)',
  },
  {
    id: "displayColor-flat-white",
    severity: "error",
    kinds: ["kotlin", "usd"],
    type: "present",
    pattern: /\bdisplayColor\b/,
    message: "USD primvars:displayColor renders as a flat UNLIT white material — color does NOT come from displayColor.",
    fix: "Bind a real Material (author_materialx / UnlitMaterial.create().setBaseColor(Color4) / PhysicallyBasedMaterial).",
    designRule: "DESIGN.md §1 (color requires MATERIALS, never displayColor)",
    positiveFixture: 'primvars:displayColor = [(1, 0, 0)]',
    negativeFixture: "mat.setBaseColor(Color4(1f, 0f, 0f, 1f))",
  },
  {
    id: "mesh-collider-not-queryable",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /createStaticMesh|createConvexMesh/,
    message: "Static/convex MESH colliders cook nothing queryable on-device — rayCast returns 0 hits against them.",
    fix: "Use PRIMITIVE shapes only: ShapeResource.createBox(FULL extents) / createSphere(radius) / createCapsule(height, radius).",
    designRule: "DESIGN.md §9 (runtime physics: primitives only)",
    positiveFixture: "e.components.set(CollisionComponent(listOf(ShapeResource.createConvexMesh(mesh)), physMat()))",
    negativeFixture: "e.components.set(CollisionComponent(listOf(ShapeResource.createBox(Vector3(1f,1f,1f))), physMat()))",
  },
  {
    id: "collisioncomponent-no-arg",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /CollisionComponent\s*\(\s*\)/,
    message: "CollisionComponent has no no-arg constructor — the public ctors are 2-arg (shapes, material) and 5-arg.",
    fix: "CollisionComponent(listOf(shape), PhysicsMaterialResource(f,f,r)[, COLLIDER_FULL, COLLISION_FILTER_DEFAULT, BRIEF]).",
    designRule: "DESIGN.md §9",
    positiveFixture: "entity.components.set(CollisionComponent())",
    negativeFixture: "entity.components.set(CollisionComponent(listOf(shape), physMat()))",
  },
  {
    id: "raycast-without-physicsworld",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /\.rayCast\s*\(/,
    unless: /PhysicsWorldComponent/,
    message: "Scene.rayCast returns 0 hits unless a PhysicsWorldComponent is set on the scene root (USD colliders never become query actors).",
    fix: "Call attachPhysicsWorld(root) — root.components.set(PhysicsWorldComponent()) — on Dispatchers.Main AFTER the scene loads, before rayCast.",
    designRule: "DESIGN.md §9 (PhysicsWorldComponent REQUIRED on-device)",
    positiveFixture: "val hit = scene.rayCast(o, d, 10f, CollisionCastHitMode.NEAREST, group, null).results.firstOrNull()",
    negativeFixture: "root.components.set(PhysicsWorldComponent())\nval hit = scene.rayCast(o, d, 10f, CollisionCastHitMode.NEAREST, group, null).results.firstOrNull()",
  },
  {
    id: "menu-dispatch-missing-move-route",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /import\s+\S+\.gen\.GameMenu[\s\S]*fun dispatchDebugCommand/,
    unless: /cmd\.startsWith\("move:"\)\s*->\s*GameMenu\.nudgePanelCmd/,
    message: "This app attaches a GameMenu but dispatchDebugCommand has no move: route — the mouse bridge's panel title-drag broadcasts move:dx,dy,dz and the panel silently stays put (the com.fleet.knockdown 'menu not moveable' bug).",
    fix: 'Add `cmd.startsWith("move:") -> GameMenu.nudgePanelCmd(cmd.removePrefix("move:"))` to the dispatch when{} (generate_app_wiring emits it for menu specs since v29.4).',
    positiveFixture: 'import com.demo.app.gen.GameMenu\ninternal fun dispatchDebugCommand(cmd: String, arg: Int = 0) {\n    when {\n        cmd == "start" -> GameMenu.select(cmd)\n        else -> Log.w(TAG, cmd)\n    }\n}',
    negativeFixture: 'import com.demo.app.gen.GameMenu\ninternal fun dispatchDebugCommand(cmd: String, arg: Int = 0) {\n    when {\n        cmd == "start" -> GameMenu.select(cmd)\n        cmd.startsWith("move:") -> GameMenu.nudgePanelCmd(cmd.removePrefix("move:"))\n        else -> Log.w(TAG, cmd)\n    }\n}',
  },
  {
    id: "collisioncasthitmode-closest",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /CollisionCastHitMode\s*\.\s*CLOSEST/,
    message: "CollisionCastHitMode has no CLOSEST value — the enum is NEAREST / ALL.",
    fix: "Use CollisionCastHitMode.NEAREST (closest hit) or .ALL.",
    positiveFixture: "scene.rayCast(o, d, 10f, CollisionCastHitMode.CLOSEST, g, null)",
    negativeFixture: "scene.rayCast(o, d, 10f, CollisionCastHitMode.NEAREST, g, null)",
  },
  {
    id: "spotlight-cone-radians",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    // the balanced-paren group keeps the two sub-1.0 floats OUTSIDE nested calls like Color4(...),
    // so a tinted color ending in 0.x components can't false-fire; optional trailing bool = 6-arg ctor
    pattern: /SpotLightComponent\s*\((?:[^();\n]|\([^()]*\))*,\s*0\.\d+f\s*,\s*0\.\d+f\s*(?:,\s*(?:true|false)\s*)?\)/,
    message: "SpotLightComponent inner/outer cone angles are DEGREES (agent-vault: 'measured in degrees'; sample 15f/30f). Sub-1.0 values are a radians smell — a <1° cone lights nothing.",
    fix: "Pass degrees: e.g. SpotLightComponent(color, lumens, radius, 26f, 40f).",
    designRule: "agent-vault com.pico.spatial.core.ecs.md (SpotLightComponent innerAngle/outerAngle, 2026-07-12 vault audit)",
    positiveFixture: "spot.components.set(SpotLightComponent(Color4(0.9f, 0.95f, 1f, 1f), 1300f, 6f, 0.45f, 0.7f, true))",
    negativeFixture: "spot.components.set(SpotLightComponent(Color4(1f, 0.95f, 0.9f, 0.8f), 1300f, 6f, 26f, 40f))",
  },
  {
    id: "physics-ccd-continuous",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /CollisionDetectionMode\s*\.\s*CONTINUOUS/,
    message: "CollisionDetectionMode.CONTINUOUS silently KILLS dynamic-vs-dynamic contacts on the emulator adapter — a fast ball glides through pins undeflected (verified v8.8).",
    fix: "Stay on DISCRETE (the default) — at 8 m/s vs capsule pins it still strikes reliably.",
    designRule: "physics rulebook R4 (v8.8, examples/BowlingGame.kt)",
    positiveFixture: "RigidBodyComponent(MassProperties(5f), RigidBodyMode.DYNAMIC).apply { collisionDetectionMode = CollisionDetectionMode.CONTINUOUS }",
    negativeFixture: "RigidBodyComponent(MassProperties(5f), RigidBodyMode.DYNAMIC).apply { linearDamping = 0.1f }",
  },
  {
    id: "physics-destroy-respawn",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /RigidBodyComponent[\s\S]*\.destroy\s*\(|\.destroy\s*\([\s\S]*RigidBodyComponent/,
    unless: /enabled\s*=\s*false/,
    message: "destroy() in a file that builds RigidBody entities: destroying individual live bodies loses collision pairing (respawns roll through everything), and destroying a physics-world root POISONS every world built after it in-process (verified v8.8).",
    fix: "Reset by DISABLING the old game root (oldRoot.enabled = false) and rebuilding a fresh root ~3s later — ScenePhysics.resetWorld() does exactly this.",
    designRule: "physics rulebook R1+R3 (v8.8, examples/BowlingGame.kt)",
    positiveFixture: "ball.destroy(true)\nval e = Entity()\ne.components.set(RigidBodyComponent(MassProperties(1f), RigidBodyMode.DYNAMIC))",
    negativeFixture: "oldRoot.enabled = false\nval e = Entity()\ne.components.set(RigidBodyComponent(MassProperties(1f), RigidBodyMode.DYNAMIC))",
  },
  {
    id: "physics-kinematic-flip",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /rigidBodyMode\s*=\s*RigidBodyMode\s*\.\s*(KINEMATIC|DYNAMIC)/,
    message: "Flipping rigidBodyMode on a live body is a SILENT NO-OP on the emulator adapter — kinematic-teleport patterns do nothing, and the transform-set they wrap becomes (jump/timestep) velocity that launches the body through geometry (verified v8.8).",
    fix: "Construct bodies in their final mode. To move a body: cm-scale nudges + PhysicsVelocityComponent (ScenePhysics.launch). To reset a scene: ScenePhysics.resetWorld (disable + rebuild).",
    designRule: "physics rulebook R2 (v8.8, examples/BowlingGame.kt)",
    positiveFixture: "body.components.get<RigidBodyComponent>()?.rigidBodyMode = RigidBodyMode.KINEMATIC",
    negativeFixture: "e.components.set(RigidBodyComponent(MassProperties(1f), RigidBodyMode.KINEMATIC))",
  },
  {
    id: "rotation-rotateVector",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /\.rotation\s*\.\s*rotateVector/,
    message: "TransformComponent.rotation is EulerAngles (lazy-computed) — it has no rotateVector.",
    fix: "Rotate a vector with the quaternion: transform.quaternion.rotateVector(v).",
    designRule: "DESIGN.md §10 (PICO math API)",
    positiveFixture: "val f = tc.rotation.rotateVector(Vector3(0f,0f,-1f))",
    negativeFixture: "val f = tc.quaternion.rotateVector(Vector3(0f,0f,-1f))",
  },
  {
    id: "transform-scale-property",
    severity: "warn",
    kinds: ["kotlin"],
    type: "present",
    pattern: /\.scale\s*=\s*Vector3/,
    message: "TransformComponent's mutable scale property is `scaleVector`, not `.scale`.",
    fix: "Set tc.scaleVector = Vector3(...). (Vector3 for position/scaleVector, Quat for quaternion.)",
    designRule: "DESIGN.md §10",
    positiveFixture: "tc.scale = Vector3(1.1f, 1.1f, 1.1f)",
    negativeFixture: "tc.scaleVector = Vector3(1.1f, 1.1f, 1.1f)",
  },
  {
    id: "particlecomponent-ctor",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /ParticleComponent\s*\(/,
    message: "ParticleComponent has no public constructor — an editor-authored asset auto-attaches it.",
    fix: "Drive the existing one: entity.components.get<ParticleComponent>()?.let { ... } (see generate_particle_kotlin).",
    positiveFixture: "entity.components.set(ParticleComponent(rate = 100f))",
    negativeFixture: "entity.components.get<ParticleComponent>()?.play()",
  },
  {
    id: "text-component",
    severity: "error",
    kinds: ["kotlin"],
    type: "present",
    pattern: /\bTextComponent\b/,
    message: "There is no public TextComponent in SDK 0.13.3 — IN-SCENE 3D text cannot be drawn. (LIVE runtime text DOES work via a 2D panel activity — this limit is in-scene-3D only, v9.4.)",
    fix: "For in-scene 3D labels, bake text into a texture (bake_textured_model) and select it per item. For LIVE/dynamic text (HUD, scoreboards, detail) use generate_panel_compose_kotlin (a 2D panel activity auto-hosted as a floating spatial panel; DEBUG_CMD hud:<key>=<value> updates it live).",
    designRule: "DESIGN.md §1/§12",
    positiveFixture: "entity.components.set(TextComponent(\"Nebula\"))",
    negativeFixture: "entity.components.set(ModelComponent(mesh, UnlitMaterial.create()))",
  },
  {
    id: "raw-glb-runtime-load",
    severity: "error",
    kinds: ["kotlin"],
    type: "conditional",
    when: /loadSuspend\s*\(/,
    unless: /\.bundle|AssetBundle/,
    message: "Runtime-loading a raw GLB (Entity.loadSuspend(File(x.glb))) renders BLACK — gltfio's async texture loader is never driven.",
    fix: "BAKE the GLB with bake_textured_model → load the baked model from its .bundle (AssetBundle.load).",
    designRule: "diagnose: texture_black",
    positiveFixture: "val e = Entity.loadSuspend(File(ctx.filesDir, \"marble.glb\").path)",
    negativeFixture: "val bundle = AssetBundle.load(\"asset://marble.bundle\"); val e = Entity.loadSuspend(\"marble\", bundle)",
  },
  {
    id: "usd-glb-reference",
    severity: "error",
    kinds: ["usd", "kotlin"],
    type: "present",
    pattern: /references\s*=\s*@[^@]*\.glb@/,
    message: "USD has no glTF plugin — `prepend references = @x.glb@` packs an EMPTY bundle (no mesh/texture).",
    fix: "Never reference a GLB in USDA; bake_textured_model then load the baked model in Kotlin.",
    designRule: "diagnose: texture_black",
    positiveFixture: 'def "Model" ( prepend references = @marble.glb@ ) {}',
    negativeFixture: 'def "Model" ( prepend references = @marble.usda@ ) {}',
  },
  {
    id: "stage-lighting-in-mixed",
    severity: "warn",
    kinds: ["kotlin", "gradle"],
    type: "conditional",
    when: /StageEnvironmentLightingComponent/,
    unless: /FULL|PROGRESSIVE/,
    message: "StageEnvironmentLightingComponent is INACTIVE in the MIXED stage (the system IBL wins).",
    fix: "Use it only in FULL/PROGRESSIVE stage, or drive a localized IBL (generate_ibl_kotlin) instead.",
    positiveFixture: "root.components.set(StageEnvironmentLightingComponent(ktx))",
    negativeFixture: "// FULL stage\nroot.components.set(StageEnvironmentLightingComponent(ktx))",
  },
  {
    id: "bundle-md5-diff",
    severity: "error",
    kinds: ["command", "kotlin"],
    type: "conditional",
    when: /md5|md5sum|shasum|sha256/,
    unless: /bundle_content_diff/,
    message: "The spatialbundle build is NON-deterministic — a raw md5/sha of a .bundle is meaningless for change detection.",
    fix: "Use bundle_content_diff (compares decoded content), never a byte-hash of the bundle.",
    positiveFixture: "md5 -q app/build/spatial/bundle/scene.bundle",
    negativeFixture: "bundle_content_diff before.bundle after.bundle",
  },
  {
    id: "am-start-without-forcestop",
    severity: "warn",
    kinds: ["command"],
    type: "conditional",
    when: /am\s+start/,
    unless: /force-stop/,
    message: "Launch is flaky: a prior com.example.* spatial app owning the full-space stage makes yours exit immediately.",
    fix: "force-stop the other spatial apps first: adb shell am force-stop <pkg>; sleep 1.5; then am start.",
    designRule: "diagnose: falling_out / launch flakiness",
    positiveFixture: "adb shell am start -n com.example.showcasexr/.platform.LaunchActivity",
    negativeFixture: "adb shell am force-stop com.example.other; sleep 1.5; adb shell am start -n com.example.showcasexr/.platform.LaunchActivity",
  },
  {
    id: "scaffold-log-tag-drift",
    severity: "warn",
    kinds: ["command", "kotlin"],
    type: "conditional",
    when: /logcat[^\n]*-s\s+[A-Za-z0-9_]+:/,
    unless: /SpatialDemo/,
    message: "A scaffolded app keeps the log tag 'SpatialDemo' after a package rename — grep that, not the new app name.",
    fix: "Use `logcat -s SpatialDemo:V` (or grep the HomeStage/seed tag), not the renamed applicationId, for the ready-log.",
    positiveFixture: "adb logcat -s ShowcaseXR:V",
    negativeFixture: "adb logcat -s SpatialDemo:V",
  },
];

// ── learned-lesson store (~/.pico-mcp/lessons.json) ─────────────────────────────────────────────────────
const LESSONS_PATH = path.join(os.homedir(), ".pico-mcp", "lessons.json");

function loadLearned(): LintRule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.map((r: any) => ({
      id: r.id,
      severity: r.severity === "warn" ? "warn" : "error",
      kinds: Array.isArray(r.kinds) && r.kinds.length ? r.kinds : ["any"],
      type: "present" as const,
      pattern: new RegExp(r.pattern),
      message: r.message,
      fix: r.fix,
      designRule: r.designRule,
      positiveFixture: r.positiveFixture ?? "",
      negativeFixture: r.negativeFixture ?? "",
      learned: true,
    }));
  } catch {
    return [];
  }
}

function saveLearned(rules: LintRule[]) {
  fs.mkdirSync(path.dirname(LESSONS_PATH), { recursive: true });
  const serializable = rules.map((r) => ({
    id: r.id,
    severity: r.severity,
    kinds: r.kinds,
    pattern: r.pattern?.source ?? "",
    message: r.message,
    fix: r.fix,
    designRule: r.designRule,
    positiveFixture: r.positiveFixture,
    negativeFixture: r.negativeFixture,
  }));
  fs.writeFileSync(LESSONS_PATH, JSON.stringify(serializable, null, 2));
}

const ruleApplies = (rule: LintRule, kind: RuleKind) => kind === "any" || rule.kinds.includes("any") || rule.kinds.includes(kind);

/** Run all applicable rules over content. Exported so the fixture test can call it directly. */
export function runLint(content: string, kind: RuleKind = "any", rules: LintRule[] = [...BUILTIN_RULES, ...loadLearned()]) {
  const lines = content.split("\n");
  const violations: any[] = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, kind)) continue;
    let fired = false;
    if (rule.type === "present" && rule.pattern) {
      fired = rule.pattern.test(content);
    } else if (rule.type === "conditional" && rule.when) {
      fired = rule.when.test(content) && !(rule.unless && rule.unless.test(content));
    }
    if (!fired) continue;
    const probe = rule.pattern ?? rule.when;
    const lineIdx = probe ? lines.findIndex((l) => probe.test(l)) : -1;
    violations.push({
      ruleId: rule.id,
      severity: rule.severity,
      line: lineIdx >= 0 ? lineIdx + 1 : null,
      match: lineIdx >= 0 ? lines[lineIdx].trim().slice(0, 160) : null,
      message: rule.message,
      fix: rule.fix,
      ...(rule.designRule ? { designRule: rule.designRule } : {}),
      ...(rule.learned ? { learned: true } : {}),
    });
  }
  return violations;
}

// ── the advisory agent-vault symbol stage (v31: nearest-match enrichment) ───────────────────────────────

/** Plain Levenshtein — vault simple names are short, so the O(n*m) rolling-row form is plenty. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Nearest vault type by case-insensitive simple-name edit distance — capped, so a completely
 *  unrelated name gets NO suggestion rather than a fake one. */
function nearestVaultType(index: VaultIndex, simpleName: string): string | null {
  const target = simpleName.toLowerCase();
  let best: { qualifiedName: string; d: number } | null = null;
  for (const types of index.packages.values()) {
    for (const ty of types.values()) {
      const d = editDistance(target, ty.name.split(".").pop()!.toLowerCase());
      if (!best || d < best.d) best = { qualifiedName: ty.qualifiedName, d };
    }
  }
  return best && best.d <= Math.max(2, Math.ceil(target.length / 3)) ? best.qualifiedName : null;
}

/**
 * The vault-symbol pass preflight_lint runs over Kotlin: runVaultCheck plus a machine-usable
 * `nearest` vault match on each unknown-type finding (an exact simple-name hit in another package
 * first, else the smallest edit distance under the cap). ADVISORY by contract — findings are
 * warnings/info and must never gate `clean`. Exported so a fixture test can drive it against
 * test/fixtures/agent-vault without spawning the server.
 */
export function runVaultSymbolStage(content: string, index: VaultIndex): (VaultFinding & { nearest?: string })[] {
  return runVaultCheck(content, index).map((f) => {
    if (f.check !== "unknown-type") return f;
    const simple = f.symbol.split(".").pop()!;
    const exact = [...index.packages.entries()].find(([, m]) => m.has(simple));
    const nearest = exact ? `${exact[0]}.${simple}` : nearestVaultType(index, simple);
    if (!nearest) return f;
    return {
      ...f,
      nearest,
      // "declared in: ..." messages already cite the match; only the declared-nowhere case needs it
      ...(f.message.includes("no vault package declares it") ? { message: `${f.message} Nearest vault match: ${nearest}.` } : {}),
    };
  });
}

export function registerLintTools(server: McpServer) {
  server.registerTool(
    "preflight_lint",
    {
      description:
        "Scan emitted Kotlin / a shell command / gradle config against the retained-lessons rulebook BEFORE you write or run it — so the loop never repeats a solved mistake. Catches the hard-won gotchas (displayColor flat-white, mesh colliders not queryable, rayCast without PhysicsWorldComponent, CollisionCastHitMode.CLOSEST, .rotation.rotateVector, .scale vs scaleVector, ParticleComponent ctor, TextComponent, raw-GLB runtime load, USD glTF reference, StageEnvironmentLighting in MIXED, md5 bundle diff, am start without force-stop, scaffold log-tag drift) plus any lessons recorded via record_lesson. Returns violations with severity/line/message/fix/designRule. Kotlin content ALSO gets an agent-vault symbol check (import/type existence vs PICO's authoritative SDK api-reference, materialized by pico-cli setup) reported in a separate advisory `vault` block — vault findings never affect `clean` (unknown symbols come back as warnings carrying the `nearest` vault match), an absent vault degrades to a note naming pico-cli setup, and `vaultSymbols` overrides the default (false skips the pass, true forces it for any kind). Run it on every generate_* output before writing the file.",
      inputSchema: {
        content: z.string().describe("The Kotlin source, shell command, or config text to lint."),
        kind: z.enum(["kotlin", "command", "gradle", "usd", "any"]).optional().describe("Restrict to rules for this kind (default 'any' = all rules)."),
        vaultSymbols: z.boolean().optional().describe("Override the advisory agent-vault symbol pass: false skips it, true forces it regardless of kind. Default: it runs for kind 'kotlin'/'any'."),
        projectDir: z.string().optional().describe("Optional Android project root for a read-only static configuration audit (Compose exclusions and container family/root consistency). Never invokes Gradle."),
      },
    },
    async ({ content, kind, vaultSymbols, projectDir }) => {
      const violations = runLint(content, kind ?? "any");
      const errors = violations.filter((v) => v.severity === "error").length;
      const warnings = violations.filter((v) => v.severity === "warn").length;
      // agent-vault symbol stage — ADVISORY, in its own block: never touches `clean`/`violations`
      // (vault findings are index lookups, not verified past failures; a vault gap must not stall the loop)
      let vault: any = { status: "skipped" };
      const wantVault = vaultSymbols ?? ((kind ?? "any") === "kotlin" || (kind ?? "any") === "any");
      if (vaultSymbols === false) {
        vault = { status: "skipped", note: "agent-vault symbol pass disabled by vaultSymbols:false." };
      } else if (wantVault) {
        const index = loadVaultIndex();
        if (!index) {
          vault = { status: "unavailable", note: `agent-vault not found (default ${defaultVaultRoot()}, override with PICO_AGENT_VAULT; provision via 'pico-cli setup') — SDK symbol validation skipped.` };
        } else {
          const findings = runVaultSymbolStage(content, index);
          vault = {
            status: "ok",
            sdkVersion: index.sdkVersion,
            typesIndexed: index.typeCount,
            findings,
            note: findings.length
              ? "ADVISORY agent-vault findings — each is an unresolved symbol (with the nearest vault match when one exists), unknown enum value/constant, or constructor-arity mismatch, with the authoritative vault declaration cited. Check the citation (vault_api gives the full signature) before writing; ui.* composables are not validated."
              : "Emitted SDK usage resolves against the agent-vault api-reference (types, enum values, ctor arity; ui.* composables not validated).",
          };
        }
      }
      const projectConfig = projectDir ? auditProjectConfig(projectDir) : null;
      const projectErrors = projectConfig?.static.errors.length ?? 0;
      return okJson({
        clean: violations.length === 0 && projectErrors === 0,
        counts: { errors, warnings, projectErrors },
        violations,
        vault,
        ...(projectConfig ? { projectConfig } : {}),
        note: errors || projectErrors ? "FIX every error before writing/running this — each is a verified past failure or a source-grounded project configuration issue." : warnings ? "Warnings are strong reminders; confirm they don't apply." : "Clean against the retained-lessons rulebook.",
      });
    },
  );

  server.registerTool(
    "record_lesson",
    {
      description:
        "Append a NEW retained-lessons lint rule after diagnose resolves a novel failure — grow the rulebook so the mistake can never recur. Persists to ~/.pico-mcp/lessons.json; preflight_lint picks it up immediately. Provide a regex that detects the anti-pattern plus a positive fixture (must trigger) and a negative fixture (must not) so the rule stays test-backed.",
      inputSchema: {
        id: z.string().describe("Unique kebab-case rule id, e.g. 'my-new-gotcha'."),
        pattern: z.string().describe("A JS regex source string that detects the anti-pattern."),
        message: z.string().describe("What's wrong (the verified failure)."),
        fix: z.string().describe("The concrete fix."),
        severity: z.enum(["error", "warn"]).optional().describe("Default 'error'."),
        kinds: z.array(z.enum(["kotlin", "command", "gradle", "usd", "any"])).optional().describe("Which content kinds this applies to (default ['any'])."),
        designRule: z.string().optional().describe("The DESIGN.md rule / diagnose symptom it maps to."),
        positiveFixture: z.string().optional().describe("A sample that MUST trigger the rule."),
        negativeFixture: z.string().optional().describe("A sample that MUST NOT trigger the rule."),
      },
    },
    async ({ id, pattern, message, fix, severity, kinds, designRule, positiveFixture, negativeFixture }) => {
      // validate the regex + fixtures before persisting
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e: any) {
        return okJson({ status: "invalid", error: `bad regex: ${e.message}` });
      }
      if (positiveFixture && !re.test(positiveFixture)) return okJson({ status: "invalid", error: "positiveFixture does not match the pattern" });
      if (negativeFixture && re.test(negativeFixture)) return okJson({ status: "invalid", error: "negativeFixture matches the pattern (it should not)" });
      const learned = loadLearned().filter((r) => r.id !== id);
      const rule: LintRule = {
        id,
        severity: severity ?? "error",
        kinds: (kinds && kinds.length ? kinds : ["any"]) as RuleKind[],
        type: "present",
        pattern: re,
        message,
        fix,
        designRule,
        positiveFixture: positiveFixture ?? "",
        negativeFixture: negativeFixture ?? "",
        learned: true,
      };
      learned.push(rule);
      saveLearned(learned);
      return okJson({ status: "recorded", id, totalLearned: learned.length, path: LESSONS_PATH });
    },
  );
}
