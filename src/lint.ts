import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

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
    fix: "Use PRIMITIVE shapes only: ShapeResource.createBox(FULL extents) / createSphere(r) / createCapsule(r,h).",
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
    message: "There is no public TextComponent in SDK 0.13.3 — runtime text cannot be drawn.",
    fix: "Bake text into a texture (bake_textured_model) and select it per item; runtime binding = color/material only.",
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

export function registerLintTools(server: McpServer) {
  server.registerTool(
    "preflight_lint",
    {
      description:
        "Scan emitted Kotlin / a shell command / gradle config against the retained-lessons rulebook BEFORE you write or run it — so the loop never repeats a solved mistake. Catches the hard-won gotchas (displayColor flat-white, mesh colliders not queryable, rayCast without PhysicsWorldComponent, CollisionCastHitMode.CLOSEST, .rotation.rotateVector, .scale vs scaleVector, ParticleComponent ctor, TextComponent, raw-GLB runtime load, USD glTF reference, StageEnvironmentLighting in MIXED, md5 bundle diff, am start without force-stop, scaffold log-tag drift) plus any lessons recorded via record_lesson. Returns violations with severity/line/message/fix/designRule. Run it on every generate_* output before writing the file.",
      inputSchema: {
        content: z.string().describe("The Kotlin source, shell command, or config text to lint."),
        kind: z.enum(["kotlin", "command", "gradle", "usd", "any"]).optional().describe("Restrict to rules for this kind (default 'any' = all rules)."),
      },
    },
    async ({ content, kind }) => {
      const violations = runLint(content, kind ?? "any");
      const errors = violations.filter((v) => v.severity === "error").length;
      const warnings = violations.filter((v) => v.severity === "warn").length;
      return okJson({
        clean: violations.length === 0,
        counts: { errors, warnings },
        violations,
        note: errors ? "FIX every error before writing/running this — each is a verified past failure." : warnings ? "Warnings are strong reminders; confirm they don't apply." : "Clean against the retained-lessons rulebook.",
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
