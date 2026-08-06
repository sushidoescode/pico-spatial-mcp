import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, fail } from "./util.js";

/**
 * ecssystem.ts — v35.2 ECS `System` codegen: PICO's OWN per-frame mechanism.
 *
 * Until now our only per-frame driver was `SceneAnimator` (anim.ts) — a hand-rolled
 * `while (true) { delay(16) }` coroutine. It is vision-verified (the orrery) and it stays, but
 * `System` + `SceneUpdateContext` + `EntityQueryCondition` + `registerSystem`/`unregisterSystem` is
 * what the engine itself drives, and it is what PICO's samples use. Prefer this for new work.
 *
 * EVERY symbol below was read out of the 0.13.3 sources jars. The samples all target BOM 6.0.0
 * (verified: `git -C WelcomeSpace show HEAD:gradle/libs.versions.toml` -> spatialBom = "6.0.0"),
 * so they are an idiom source only — never proof that a symbol exists for us.
 *
 *   core `ecs/System.kt:38`                 abstract class System, implicit no-arg ctor
 *   core `ecs/System.kt:47`                 open fun update(context: SceneUpdateContext): Unit
 *                                           — the ONLY overridable member. No onRegister, no
 *                                             onUnregister, no priority, no enabled.
 *   core `ecs/System.kt:34-35`              KDoc: subclasses MUST have a public no-arg ctor;
 *                                           enforced at :106 via getConstructor().newInstance().
 *   core `ecs/SceneUpdateContext.kt:24-26`  val scene: Scene, val deltaTime: Float — that is all.
 *                                           deltaTime is SECONDS. Internal ctor: never constructible.
 *   core `ecs/EntityQueryCondition.kt:113`  hasComponent(Class<T>); `:127` customCondition((Entity)->Boolean).
 *                                           and/or/not at :53/:78/:92. There is NO byName and NO
 *                                           reified hasComponent<T>().
 *   core `ecs/Scene.kt:241-242`             @MainThread queryEntity(vararg conditions): List<Entity>
 *                                           — single overload, ALWAYS allocates.
 *   core `ecs/Component.kt:41`              open class Component; `:205` open fun clone(): Component
 *                                           — OPEN, not abstract. The base impl returns a bare
 *                                             Component() and drops subclass state, so overriding is
 *                                             semantically required for any component with fields.
 *   core `ecs/Component.kt:37`              KDoc: a custom component must have a default constructor.
 *   core `ecs/TransformComponent.kt:74,159,203`  position / quaternion / scaleVector are public vars.
 *   ui/foundation `dsl/System.kt:18,25`     inline fun <reified T : System> registerSystem() /
 *                                           unregisterSystem() — TOP-LEVEL functions, no receiver,
 *                                           NOT @Composable, NOT members of SpatialViewContent.
 *
 * Three traps this generator exists to avoid, each grounded above:
 *  1. `System.systemObjects` (System.kt:53) is a single GLOBAL static set, and
 *     `dispatchContainerUpdate` (:111) ticks each registered System once PER CONTAINER per frame
 *     with a DIFFERENT `context.scene`. Generated systems must never cache `context.scene`.
 *  2. `registerSystem` is guarded by `SpatialBuild.isSpatialPlatform()` (SpatialBuild.kt:43), so it
 *     is a silent no-op off-device. A system will never tick under JVM/Robolectric.
 *  3. `registerSystem` lives in `ui.foundation`, so a module that registers a System needs the
 *     ui:foundation dependency even if it is otherwise pure-3D core.
 *
 * NOT adopted from the samples: SpatialMesh's AmmoSystem.kt:40-41 `clear()` + `addAll()` into a
 * pre-allocated member list, commented "avoids creating new List objects in the hot loop." Against
 * 0.13.3 that is false — `queryEntity` has already allocated a fresh List by then, so the copy is
 * strictly MORE allocation than iterating the returned list. The transferable half of the idiom is
 * hoisting the EntityQueryCondition to a field, which this generator does.
 */

type MotionKind = "spin" | "orbit" | "bob" | "custom";

const FIELDS: Record<Exclude<MotionKind, "custom">, { name: string; type: string; def: string; doc: string }[]> = {
  spin: [
    { name: "enabled", type: "Boolean", def: "true", doc: "Set false to pause this entity without removing the component." },
    { name: "degreesPerSecond", type: "Float", def: "45f", doc: "Yaw rate. Multiplied by deltaTime, so it is framerate-independent." },
  ],
  orbit: [
    { name: "enabled", type: "Boolean", def: "true", doc: "Set false to pause this entity without removing the component." },
    { name: "center", type: "Vector3", def: "Vector3(0f, 1.2f, -3f)", doc: "Orbit centre, in metres, in the container's local space." },
    { name: "radius", type: "Float", def: "1.2f", doc: "Orbit radius in metres." },
    { name: "radiansPerSecond", type: "Float", def: "0.6f", doc: "Angular speed. Multiplied by deltaTime." },
    { name: "angle", type: "Float", def: "0f", doc: "MUTABLE phase accumulator — the system advances it every frame. Seed it per entity to spread a constellation out." },
  ],
  bob: [
    { name: "enabled", type: "Boolean", def: "true", doc: "Set false to pause this entity without removing the component." },
    { name: "base", type: "Vector3", def: "Vector3(0f, 1.4f, -2f)", doc: "Rest position in metres; the bob oscillates around it." },
    { name: "amplitude", type: "Float", def: "0.06f", doc: "Peak vertical displacement in metres." },
    { name: "period", type: "Float", def: "2.5f", doc: "Seconds per full up-down cycle." },
    { name: "elapsed", type: "Float", def: "0f", doc: "MUTABLE time accumulator — the system advances it every frame." },
  ],
};

/** The per-entity body of `update`, given the component val name `c` and transform val name `t`. */
function motionBody(kind: MotionKind, indent: string): string[] {
  const i = indent;
  switch (kind) {
    case "spin":
      return [
        `${i}// quaternion is a public var (TransformComponent.kt:159). Mutating it in place keeps the`,
        `${i}// write on the batched-JNI path; replacing the whole TransformComponent would not, and`,
        `${i}// would also silently reset position and scale.`,
        `${i}val deltaYaw = c.degreesPerSecond * context.deltaTime`,
        `${i}t.quaternion = t.quaternion * EulerAngles(0f, deltaYaw, 0f).toQuat()`,
      ];
    case "orbit":
      return [
        `${i}// Phase lives on the COMPONENT, not in a system field: one System instance is ticked`,
        `${i}// once per container per frame (System.kt:111), so per-entity state must be per-entity.`,
        `${i}c.angle += c.radiansPerSecond * context.deltaTime`,
        `${i}// Position only — rotation and scale are left alone, so orbit composes with a spin system.`,
        `${i}t.position = Vector3(`,
        `${i}    c.center.x + c.radius * cos(c.angle),`,
        `${i}    c.center.y,`,
        `${i}    c.center.z + c.radius * sin(c.angle),`,
        `${i})`,
      ];
    case "bob":
      return [
        `${i}c.elapsed += context.deltaTime`,
        `${i}val y = c.base.y + c.amplitude * sin((2f * PI.toFloat() * c.elapsed) / c.period)`,
        `${i}t.position = Vector3(c.base.x, y, c.base.z)`,
      ];
    case "custom":
      return [
        `${i}// TODO: your per-frame behaviour. Read/write the entity's components here.`,
        `${i}// context.deltaTime is SECONDS (SceneUpdateContext.kt:26) — multiply by it so the`,
        `${i}// behaviour is framerate-independent.`,
        `${i}// Mutate the existing TransformComponent (t.position / t.quaternion / t.scaleVector).`,
        `${i}// Never replace the whole component per frame: that leaves the batched-JNI path and`,
        `${i}// overwrites the axes this system does not own.`,
        `${i}t.position = t.position`,
      ];
  }
}

export interface EcsSystemArgs {
  packageName: string;
  name?: string;
  kind?: MotionKind;
}

/** Pure generator, exported so the conformance gate can assert on it without spawning the server. */
export function generateEcsSystemFiles(args: EcsSystemArgs): {
  files: Record<string, string>;
  registration: string;
  note: string;
} {
  const { packageName } = args;
  const kind: MotionKind = args.kind ?? "spin";
  const base = (args.name ?? (kind === "custom" ? "Behaviour" : kind[0].toUpperCase() + kind.slice(1))).replace(/[^A-Za-z0-9]/g, "");
  if (!base) throw new Error("name must contain at least one alphanumeric character");
  const comp = `${base}Component`;
  const sys = `${base}System`;

  const fields = kind === "custom"
    ? [{ name: "enabled", type: "Boolean", def: "true", doc: "Set false to pause this entity without removing the component." }]
    : FIELDS[kind];
  const needsVector3 = fields.some((f) => f.type === "Vector3") || kind === "orbit" || kind === "bob" || kind === "custom";
  const needsEuler = kind === "spin";
  const mathImports = [
    ...(kind === "orbit" ? ["import kotlin.math.cos", "import kotlin.math.sin"] : []),
    ...(kind === "bob" ? ["import kotlin.math.PI", "import kotlin.math.sin"] : []),
  ];

  // A field the system MUTATES must be `var`; the rest stay `val`. clone() must copy every field or
  // a cloned entity silently loses its state (Component.kt:205 returns a bare Component()).
  const mutable = new Set(["enabled", "angle", "elapsed"]);
  const ctorLines = fields.map((f, idx) => {
    const kw = mutable.has(f.name) ? "var" : "val";
    return `    ${kw} ${f.name}: ${f.type} = ${f.def}${idx === fields.length - 1 ? "," : ","}`;
  });

  const componentKt = [
    `package ${packageName}`,
    ``,
    `import androidx.annotation.Keep`,
    `import com.pico.spatial.core.ecs.Component`,
    ...(needsVector3 ? [`import com.pico.spatial.core.math.Vector3`] : []),
    ``,
    `/**`,
    ` * Generated by generate_ecs_system_kotlin — the DATA half of an ECS pair. Attach it to any`,
    ` * entity that should take part in ${sys}:`,
    ` *`,
    ` *   entity.components.set(${comp}(${fields.filter((f) => !mutable.has(f.name)).map((f) => `${f.name} = ${f.def}`).join(", ")}))`,
    ` *`,
    ` * Every constructor parameter has a default, so the class has the public no-arg constructor the`,
    ` * SDK requires of a custom component (Component.kt:37).`,
    ...fields.map((f) => ` *   ${f.name}: ${f.doc}`),
    ` *`,
    ` * @Keep is DEFENSIVE. Component.register reflects on the class name and its no-arg ctor`,
    ` * (Component.kt:575-579), and the SDK's own @Keep has BINARY retention on SDK types only — it`,
    ` * does not propagate to your subclass. We could not determine from the sources jars whether the`,
    ` * AAR ships a consumer ProGuard rule covering subclasses, so we keep the class explicitly`,
    ` * rather than find out in a minified release build.`,
    ` */`,
    `@Keep`,
    `class ${comp}(`,
    ...ctorLines,
    `) : Component() {`,
    `    /**`,
    `     * clone() is OPEN, not abstract (Component.kt:205) — this compiles without the override. But`,
    `     * the base implementation returns a bare Component() and drops every field above, so a cloned`,
    `     * entity would silently lose its behaviour. Override it, and copy every field.`,
    `     */`,
    `    override fun clone(): ${comp} = ${comp}(${fields.map((f) => f.name).join(", ")})`,
    `}`,
    ``,
  ].join("\n");

  const systemKt = [
    `package ${packageName}`,
    ``,
    `import androidx.annotation.Keep`,
    `import com.pico.spatial.core.ecs.EntityQueryCondition`,
    `import com.pico.spatial.core.ecs.SceneUpdateContext`,
    `import com.pico.spatial.core.ecs.System`,
    `import com.pico.spatial.core.ecs.TransformComponent`,
    ...(needsEuler ? [`import com.pico.spatial.core.math.EulerAngles`] : []),
    ...(kind === "orbit" || kind === "bob" || kind === "custom" ? [`import com.pico.spatial.core.math.Vector3`] : []),
    ...mathImports,
    ``,
    `/**`,
    ` * Generated by generate_ecs_system_kotlin — the BEHAVIOUR half. The engine calls update() once`,
    ` * per frame; you never drive it yourself.`,
    ` *`,
    ` * Register it for the lifetime of the screen that needs it:`,
    ` *   DisposableEffect(Unit) {`,
    ` *       registerSystem<${sys}>()`,
    ` *       onDispose { unregisterSystem<${sys}>() }`,
    ` *   }`,
    ` *`,
    ` * MUST be a top-level class with a public no-arg constructor: registration reflects via`,
    ` * clazz.getConstructor().newInstance() (System.kt:106), so an inner/local/anonymous class throws.`,
    ` *`,
    ` * update() is the only overridable member of System (System.kt:47) — there is no onRegister,`,
    ` * onUnregister, priority or enabled to override.`,
    ` *`,
    ` * @Keep is DEFENSIVE: registration does clazz.getConstructor().newInstance() (System.kt:106), so`,
    ` * R8 stripping the no-arg constructor would fail at runtime, not at build time. The SDK's own`,
    ` * @Keep does not propagate to subclasses and we could not confirm a consumer rule from sources.`,
    ` */`,
    `@Keep`,
    `class ${sys} : System() {`,
    `    /**`,
    `     * Hoisted deliberately: built once, not once per frame. hasComponent keeps the fast`,
    `     * component-index path (EntityQueryCondition.kt:113) — customCondition and or() both force`,
    `     * a full linear scan of the scene instead (Scene.kt:270-282).`,
    `     */`,
    `    private val query = EntityQueryCondition.hasComponent(${comp}::class.java)`,
    ``,
    `    override fun update(context: SceneUpdateContext) {`,
    `        // NEVER cache context.scene. One System instance is registered globally`,
    `        // (System.kt:53) and ticked once per CONTAINER per frame (System.kt:111), each time`,
    `        // with a different scene. Read it fresh from the context every call, as here.`,
    `        context.scene.queryEntity(query).forEach { entity ->`,
    `            val c = entity.components[${comp}::class.java] ?: return@forEach`,
    `            if (!c.enabled) return@forEach`,
    `            val t = entity.components[TransformComponent::class.java] ?: return@forEach`,
    ...motionBody(kind, "            "),
    `        }`,
    `    }`,
    `}`,
    ``,
  ].join("\n");

  const registration = [
    `// Paste into the @Composable that owns the scene. registerSystem/unregisterSystem are`,
    `// TOP-LEVEL functions in com.pico.spatial.ui.foundation.dsl (dsl/System.kt:18,25) — not members`,
    `// of SpatialViewContent, not extensions, and not @Composable. Calling them from a`,
    `// DisposableEffect body is the paired-lifecycle shape.`,
    `import androidx.compose.runtime.DisposableEffect`,
    `import com.pico.spatial.ui.foundation.dsl.registerSystem`,
    `import com.pico.spatial.ui.foundation.dsl.unregisterSystem`,
    ``,
    `DisposableEffect(Unit) {`,
    `    registerSystem<${sys}>()`,
    `    onDispose { unregisterSystem<${sys}>() }`,
    `}`,
  ].join("\n");

  return {
    files: { [`${comp}.kt`]: componentKt, [`${sys}.kt`]: systemKt },
    registration,
    note:
      `Write ${comp}.kt and ${sys}.kt into ${packageName}, then paste the returned registration snippet into the composable that owns the scene ` +
      `and attach the component to entities with entity.components.set(${comp}(...)). ` +
      `DEPENDENCIES: registerSystem lives in ui:foundation (dsl/System.kt:18), so a module that registers a System needs that artifact ` +
      `even if it is otherwise pure core — System.register(Class) from core is the dependency-free alternative. Vector3/EulerAngles/Quat ` +
      `are in the com.pico.spatial.core.math PACKAGE but ship in the com.pico.spatial.foundation:foundation ARTIFACT, not core:core. ` +
      `HONEST STATUS: structural — this compiles against the 0.13.3 symbols cited in the emitted comments, and registerSystem is ` +
      `a no-op unless SpatialBuild.isSpatialPlatform() (SpatialBuild.kt:43), so it will not tick under JVM/Robolectric. ` +
      `Motion is vision-verifiable on device/emulator; verify with a capture before claiming it moves.`,
  };
}

export function registerEcsSystemTools(server: McpServer) {
  server.registerTool(
    "generate_ecs_system_kotlin",
    {
      description:
        "Emit an ECS Component + System PAIR plus its registration snippet — PICO's own per-frame mechanism, the one the engine drives. Returns JSON {files:{'<Name>Component.kt','<Name>System.kt'}, registration, note}. Prefer this over generate_scene_animator_kotlin for NEW per-frame behaviour: System/SceneUpdateContext/EntityQueryCondition is what PICO's samples use, the engine ticks it (no hand-rolled coroutine loop to leak), and per-entity state lives on the component. SceneAnimator remains valid and vision-verified for runtime-built entities. WHAT IT GETS RIGHT, each grounded in the 0.13.3 sources jars and cited inline in the emitted Kotlin: a top-level class with a public no-arg ctor (registration reflects via getConstructor().newInstance(), System.kt:106); a clone() override that copies every field (clone() is OPEN not abstract at Component.kt:205, and the base impl silently drops subclass state); a HOISTED EntityQueryCondition.hasComponent (customCondition/or force a full scene scan, Scene.kt:270-282); deltaTime-scaled motion (SceneUpdateContext.deltaTime is seconds); in-place TransformComponent mutation on the batched-JNI path rather than a per-frame component replacement; and a paired registerSystem/unregisterSystem DisposableEffect. TRAPS IT ENCODES: never cache context.scene (one global System instance is ticked once per CONTAINER per frame with a different scene, System.kt:53,111); registerSystem is a silent no-op unless SpatialBuild.isSpatialPlatform(), so systems never tick under JVM/Robolectric; and the registering module needs ui:foundation, not just core. Kinds: spin (yaw), orbit (phase on the component so a constellation can be spread), bob (vertical oscillation), custom (correct scaffolding with a TODO body). HONEST STATUS: structural — compiles against the cited symbols; motion needs a looked-at capture before any 'it moves' claim.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package for both emitted files, e.g. com.example.app.ecs"),
        kind: z
          .enum(["spin", "orbit", "bob", "custom"])
          .optional()
          .describe("The per-frame behaviour. spin = yaw at N deg/s. orbit = circle the XZ plane around a centre (phase is stored per entity). bob = vertical sine around a rest position. custom = the full correct scaffolding with a TODO update body. Default spin."),
        name: z
          .string()
          .optional()
          .describe("Base name for the pair, e.g. 'Spin' -> SpinComponent + SpinSystem. Defaults to the kind ('Behaviour' for custom)."),
      },
    },
    async ({ packageName, kind, name }) => {
      try {
        return ok(JSON.stringify(generateEcsSystemFiles({ packageName, kind, name }), null, 2));
      } catch (e: any) {
        return fail(String(e?.message ?? e));
      }
    },
  );
}
