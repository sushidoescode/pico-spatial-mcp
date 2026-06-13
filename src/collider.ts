import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, fail } from "./util.js";

/**
 * collider.ts — the RUNTIME COLLIDER generator (the keystone unblock, verified on the
 * PICO 0.13 device emulator 2026-06-13).
 *
 * Background (why this exists): Scene.rayCast in a native PICO spatial app returns NO HIT
 * for colliders authored in USD — the runtime never turns USD CollisionComponent prims into
 * live PhysX query actors. The ONLY thing that works is attaching a CollisionComponent to a
 * LIVE entity at runtime via entity.components.set(...). Three facts were established the hard
 * way (each cost a build+install+logcat cycle) and are encoded here so they are never re-derived:
 *
 *   1. A PhysicsWorldComponent MUST be set on the scene-root (or an ancestor of the colliders)
 *      on-device, or every collider registers in the SceneInspector yet rayCast returns 0 hits.
 *      (The decompiled macOS editor dylib auto-creates the PxScene with no guard; the DEVICE
 *      runtime 0.13.2 differs and requires the component.)
 *   2. Only PRIMITIVE shapes register as queryable actors. ShapeResource.createStaticMesh /
 *      createConvexMesh from a loaded render mesh cook NO queryable triangles on-device
 *      (grid-scanned 20x20m at all heights -> 0 hits). Use box / sphere / capsule.
 *   3. CollisionComponent's 5-arg ctor is PUBLIC (only the no-arg ctor is internal); no
 *      RigidBodyComponent is needed for a static collider; ShapeResource.createBox takes
 *      FULL extents (a Vector3(1,1,1) box has faces at +-0.5).
 *
 * This tool emits a ready-to-paste Kotlin file plus integration notes, so an agent can give any
 * native PICO app working surface raycasting (pin/marker placement, object picking) without
 * rediscovering the above.
 */

const vec3 = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

const shapeSpec = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Kotlin-safe entity name, e.g. Col_Desk"),
  kind: z.enum(["box", "sphere", "capsule"]).describe("Primitive only — mesh colliders do not register on-device"),
  pos: vec3.describe("World-frame center of the collider"),
  size: vec3.optional().describe("box: FULL extents (x,y,z). createBox takes full extents, faces at +-size/2"),
  radius: z.number().optional().describe("sphere/capsule radius"),
  height: z.number().optional().describe("capsule height"),
});

const roomSpec = z.object({
  halfW: z.number().default(2.6).describe("half-width on x"),
  height: z.number().default(2.7).describe("floor(y=0) to ceiling height"),
  halfD: z.number().default(2.8).describe("half-depth on z"),
  centerZ: z.number().default(-2.3).describe("room center z (the model/skybox center)"),
  thickness: z.number().default(0.12).describe("wall slab thickness"),
});

const matSpec = z.object({
  staticFriction: z.number().default(0.5),
  dynamicFriction: z.number().default(0.5),
  restitution: z.number().default(0.0),
});

function f(n: number): string {
  // Kotlin float literal
  return Number.isInteger(n) ? `${n}f` : `${n}f`;
}

function shapeExpr(s: z.infer<typeof shapeSpec>): string {
  switch (s.kind) {
    case "box": {
      const v = s.size ?? { x: 1, y: 1, z: 1 };
      return `ShapeResource.createBox(Vector3(${f(v.x)}, ${f(v.y)}, ${f(v.z)}))`;
    }
    case "sphere":
      return `ShapeResource.createSphere(${f(s.radius ?? 0.5)})`;
    case "capsule":
      return `ShapeResource.createCapsule(${f(s.radius ?? 0.3)}, ${f(s.height ?? 1.0)})`;
  }
}

function buildKotlin(opts: {
  packageName: string;
  room?: z.infer<typeof roomSpec>;
  shapes: z.infer<typeof shapeSpec>[];
  mat: z.infer<typeof matSpec>;
  rayCastHelper: boolean;
}): string {
  const { packageName, room, shapes, mat, rayCastHelper } = opts;
  const L: string[] = [];
  L.push(`package ${packageName}`);
  L.push("");
  L.push("import android.util.Log");
  L.push("import com.pico.spatial.core.ecs.CollisionComponent");
  L.push("import com.pico.spatial.core.ecs.Entity");
  L.push("import com.pico.spatial.core.ecs.PhysicsWorldComponent");
  L.push("import com.pico.spatial.core.ecs.TransformComponent");
  L.push("import com.pico.spatial.core.ecs.resource.PhysicsMaterialResource");
  L.push("import com.pico.spatial.core.ecs.resource.ShapeResource");
  L.push("import com.pico.spatial.core.ecs.simulation.CollisionCastHitMode");
  L.push("import com.pico.spatial.core.ecs.simulation.CollisionCastResult");
  L.push("import com.pico.spatial.core.ecs.simulation.CollisionFilter");
  L.push("import com.pico.spatial.core.ecs.simulation.CollisionGroup");
  L.push("import com.pico.spatial.core.ecs.simulation.CollisionInfoDetailLevel");
  L.push("import com.pico.spatial.core.ecs.simulation.CollisionResponseMode");
  L.push("import com.pico.spatial.core.ecs.Scene");
  L.push("import com.pico.spatial.core.math.Quat");
  L.push("import com.pico.spatial.core.math.Vector3");
  L.push("");
  L.push("/**");
  L.push(" * Generated by pico-spatial-mcp generate_collider_kotlin — VERIFIED runtime collider recipe.");
  L.push(" *");
  L.push(" * USAGE (in your SpatialView.initial, after the scene model is loaded + added):");
  L.push(" *   withContext(Dispatchers.Main) {");
  L.push(" *     SpatialColliders.attachPhysicsWorld(model)        // REQUIRED on-device for rayCast");
  L.push(" *     SpatialColliders.attachColliders { content.addEntity(it) }");
  L.push(" *   }");
  L.push(" *   // then: val hit = SpatialColliders.rayCast(model.scene, origin, dir)");
  L.push(" *");
  L.push(" * Facts baked in: PhysicsWorldComponent is REQUIRED on-device; only PRIMITIVE shapes");
  L.push(" * register (no static/convex mesh); createBox takes FULL extents; the 5-arg");
  L.push(" * CollisionComponent ctor is the public one; no RigidBody needed for static colliders.");
  L.push(" */");
  L.push("object SpatialColliders {");
  L.push('    private const val TAG = "SpatialColliders"');
  L.push("");
  L.push("    private fun physMat() = PhysicsMaterialResource(" + `${f(mat.staticFriction)}, ${f(mat.dynamicFriction)}, ${f(mat.restitution)})`);
  L.push("");
  L.push("    /** REQUIRED: enrolls the scene's colliders into the queryable PhysX world. Call once,");
  L.push("     *  on Dispatchers.Main, on the scene-root entity (or a common ancestor of the colliders). */");
  L.push("    fun attachPhysicsWorld(root: Entity) {");
  L.push("        runCatching { root.components.set(PhysicsWorldComponent()) }");
  L.push('            .onFailure { Log.e(TAG, "PhysicsWorldComponent failed: ${it.message}") }');
  L.push("    }");
  L.push("");
  L.push("    /** Attach one primitive collider entity at a world position. Returns it (already given");
  L.push("     *  a TransformComponent + CollisionComponent); pass it to content.addEntity / addChild. */");
  L.push("    fun box(name: String, pos: Vector3, fullExtents: Vector3): Entity = collider(name, pos, ShapeResource.createBox(fullExtents))");
  L.push("    fun sphere(name: String, pos: Vector3, radius: Float): Entity = collider(name, pos, ShapeResource.createSphere(radius))");
  L.push("    fun capsule(name: String, pos: Vector3, radius: Float, height: Float): Entity = collider(name, pos, ShapeResource.createCapsule(radius, height))");
  L.push("");
  L.push("    private fun collider(name: String, pos: Vector3, shape: ShapeResource): Entity {");
  L.push("        val e = Entity()");
  L.push("        e.setName(name)");
  L.push("        e.components.set(TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f)))");
  L.push("        runCatching {");
  L.push("            e.components.set(");
  L.push("                CollisionComponent(");
  L.push("                    listOf(shape), physMat(),");
  L.push("                    CollisionResponseMode.COLLIDER_FULL,");
  L.push("                    CollisionFilter.COLLISION_FILTER_DEFAULT,");
  L.push("                    CollisionInfoDetailLevel.BRIEF,");
  L.push("                ),");
  L.push("            )");
  L.push('        }.onFailure { Log.e(TAG, "collider \'$name\' failed: ${it.message}") }');
  L.push("        return e");
  L.push("    }");
  L.push("");
  L.push("    /** Attach all configured colliders. `add` is content.addEntity (world frame) or an");
  L.push("     *  ancestor's addChild (local frame). */");
  L.push("    fun attachColliders(add: (Entity) -> Unit) {");
  if (room) {
    const r = room;
    const cy = r.height / 2;
    L.push(`        // Room as 6 thin box "walls" (real rayCast, correct inward normals).`);
    const walls: [string, [number, number, number], [number, number, number]][] = [
      ["Col_Floor", [0, 0, r.centerZ], [r.halfW * 2, r.thickness, r.halfD * 2]],
      ["Col_Ceil", [0, r.height, r.centerZ], [r.halfW * 2, r.thickness, r.halfD * 2]],
      ["Col_WallL", [-r.halfW, cy, r.centerZ], [r.thickness, r.height, r.halfD * 2]],
      ["Col_WallR", [r.halfW, cy, r.centerZ], [r.thickness, r.height, r.halfD * 2]],
      ["Col_WallBack", [0, cy, r.centerZ - r.halfD], [r.halfW * 2, r.height, r.thickness]],
      ["Col_WallFront", [0, cy, r.centerZ + r.halfD], [r.halfW * 2, r.height, r.thickness]],
    ];
    for (const [name, p, s] of walls) {
      L.push(`        add(box(${JSON.stringify(name)}, Vector3(${f(p[0])}, ${f(p[1])}, ${f(p[2])}), Vector3(${f(s[0])}, ${f(s[1])}, ${f(s[2])})))`);
    }
  }
  for (const s of shapes) {
    L.push(`        add(${s.kind === "box" ? "box" : s.kind}(${JSON.stringify(s.name)}, Vector3(${f(s.pos.x)}, ${f(s.pos.y)}, ${f(s.pos.z)}), ${colliderArgs(s)}))`);
  }
  L.push("    }");
  if (rayCastHelper) {
    L.push("");
    L.push("    /** Cast a ray against the registered colliders; returns the nearest hit (position +");
    L.push("     *  surface normal + distance) or null. @MainThread. */");
    L.push("    fun rayCast(scene: Scene?, origin: Vector3, direction: Vector3, maxDistance: Float = 60f): CollisionCastResult? =");
    L.push("        scene?.rayCast(origin, direction, maxDistance, CollisionCastHitMode.NEAREST,");
    L.push("            CollisionGroup(CollisionGroup.COLLISION_GROUP_ALL), null)?.results?.firstOrNull()");
  }
  L.push("}");
  L.push("");
  return L.join("\n");
}

function colliderArgs(s: z.infer<typeof shapeSpec>): string {
  switch (s.kind) {
    case "box": {
      const v = s.size ?? { x: 1, y: 1, z: 1 };
      return `Vector3(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;
    }
    case "sphere":
      return `${f(s.radius ?? 0.5)}`;
    case "capsule":
      return `${f(s.radius ?? 0.3)}, ${f(s.height ?? 1.0)}`;
  }
}

export function registerColliderTools(server: McpServer) {
  server.registerTool(
    "generate_collider_kotlin",
    {
      description:
        "Emit a verified, drop-in Kotlin file (SpatialColliders.kt) that gives a native PICO spatial app WORKING Scene.rayCast surface collision — the keystone for landing pins/markers on walls/floor/ceiling and for object picking. Encodes the hard-won on-device recipe: a PhysicsWorldComponent on the scene root is REQUIRED (USD-authored collision never becomes a query actor); only PRIMITIVE shapes (box/sphere/capsule) register (static/convex mesh colliders cook nothing queryable on-device); createBox uses FULL extents; the public 5-arg CollisionComponent ctor; no RigidBody needed. Provide a `room` AABB to get a 6-wall box room, and/or `shapes` for arbitrary primitive colliders (furniture, props). Returns the Kotlin + integration notes.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package for the generated file, e.g. com.example.claimsight.content"),
        room: roomSpec.optional().describe("Emit a 6-wall box room collider at this AABB (you stand inside; rays hit walls from inside with inward normals)"),
        shapes: z.array(shapeSpec).default([]).describe("Arbitrary primitive colliders (box/sphere/capsule) at world positions"),
        physicsMaterial: matSpec.optional(),
        rayCastHelper: z.boolean().default(true).describe("Include a rayCast(scene, origin, dir) helper"),
      },
    },
    async ({ packageName, room, shapes, physicsMaterial, rayCastHelper }) => {
      if (!room && (!shapes || shapes.length === 0)) {
        return fail("Provide a `room` AABB and/or at least one entry in `shapes` — nothing to generate.");
      }
      const mat = physicsMaterial ?? { staticFriction: 0.5, dynamicFriction: 0.5, restitution: 0.0 };
      const kotlin = buildKotlin({ packageName, room, shapes: shapes ?? [], mat, rayCastHelper });
      const notes = [
        "// ---- INTEGRATION ----",
        "// 1. Save as SpatialColliders.kt in the package above.",
        "// 2. In SpatialView.initial, after the scene model loads and content.addEntity(model):",
        "//      withContext(Dispatchers.Main) {",
        "//        SpatialColliders.attachPhysicsWorld(model)         // REQUIRED first",
        "//        SpatialColliders.attachColliders { content.addEntity(it) }",
        "//      }",
        "// 3. Raycast where the user aims:",
        "//      val hit = SpatialColliders.rayCast(model.scene, eyePos, eyeForward)",
        "//      if (hit != null) placeMarker(hit.position, hit.normal)",
        "// VERIFY: assert_logcat for your own 'rayCast HIT' log; primitives only (no mesh colliders).",
      ].join("\n");
      return ok(`${kotlin}\n${notes}`);
    },
  );
}
