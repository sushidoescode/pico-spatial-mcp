import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./util.js";

/**
 * physics.ts — v4.9 rigid-body dynamics + anchors; v9.0 the emulator physics rulebook.
 *
 * REAL physics simulates on the emulator (v8.6-v8.8, vision-verified: a thrown ball STRIKES pins
 * that fly and scatter — examples/BowlingGame.kt). The adapter rules, each verified by read-back
 * + frame series:
 *  R1 Create bodies with ALL components (Transform+Collision+RigidBody+Model) in ONE batch at
 *     scene build. Staged sets and destroy+respawn of live bodies LOSE collision pairing.
 *  R2 The kinematic rigidBodyMode flip is a silent NO-OP; a transform-set on a dynamic body
 *     becomes (jump/timestep) velocity — meter teleports launch bodies through the floor.
 *     cm-scale nudges are harmless (and useful to break resting contact).
 *  R3 Destroying a tree containing a PhysicsWorldComponent POISONS later worlds in-process.
 *     Reset = oldRoot.enabled = false + rebuild a fresh root ~3s later (resetWorld()).
 *  R4 CollisionDetectionMode.CONTINUOUS kills dynamic-vs-dynamic contacts — stay DISCRETE.
 *  R5 ~2s native batch epochs: a set velocity fires the NEXT epoch (visible beat before motion);
 *     TransformComponent read-backs lag ~2s — trust frames, not read-back timing.
 *
 * Source-verified facts (SDK 0.13.3), building on the PROVEN collider recipe (collider.ts):
 *  - PhysicsWorldComponent() on a common parent (default gravity (0,-9.81,0)); only entities under
 *    the SAME world collide.
 *  - A STATIC floor = CollisionComponent (5-arg public ctor) with NO RigidBodyComponent.
 *  - A DYNAMIC body = CollisionComponent + RigidBodyComponent(MassProperties(mass), RigidBodyMode.DYNAMIC).
 *    (RigidBodyMode has only KINEMATIC/DYNAMIC — static = omit it.)
 *  - PhysicsMaterialResource(staticFriction, dynamicFriction, restitution). Primitive shapes only
 *    register on-device (createBox FULL extents / createSphere radius).
 *  - The falling/resting motion is VISION-verifiable ONLY if the body also has a ModelComponent and
 *    the decoupled free cam is aimed at it; otherwise it is STRUCTURAL (assert the Transform via the
 *    Agent Bridge scene-dump: y decreasing then resting).
 *  - AnchorComponent(AnchorTarget.createCameraTarget()/createWorldAnchorTarget(uuid), TrackingMode)
 *    is HEADSET-ONLY (C1): it no-ops on the emulator (world-tracking returns nothing).
 */
export function registerPhysicsTools(server: McpServer) {
  // ── generate_rigidbody_kotlin ──────────────────────────────────────────────
  server.registerTool(
    "generate_rigidbody_kotlin",
    {
      description:
        "Emit ScenePhysics.kt — REAL rigid-body dynamics, VERIFIED SIMULATING ON THE EMULATOR (a launched ball strikes pins that fly — vision-verified v8.8). PhysicsWorldComponent on the scene root; STATIC colliders (box/sphere/capsule — no RigidBody, they never move); DYNAMIC bodies (box/sphere/capsule) that fall, rest, roll and collide. launch() = the safe throw (cm nudge + velocity; fires on the NEXT ~2s engine epoch — expect a beat). resetWorld() = the ONLY reliable reset (disable the old root + rebuild fresh ~3s later; destroying a physics world poisons later worlds, and per-entity destroy+respawn loses collision pairing). Keep DISCRETE collision (CONTINUOUS kills dynamic-vs-dynamic contacts); never teleport live bodies beyond a few cm (jump/timestep becomes velocity). Create every body with ALL components in one batch — the emitted helpers do. Give bodies a ModelComponent to SEE the motion; verify via frames (read-backs lag ~2s). RETURNS: raw Kotlin text (write it to the targetPath yourself).",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content"),
        gravity: z.array(z.number()).optional().describe("World gravity [x,y,z] m/s² (default [0,-9.81,0]). Pass [0,0,0] for zero-g."),
        restitution: z.number().optional().describe("Default bounciness 0..1 for the physics material (default 0.2)."),
        friction: z.number().optional().describe("Default static/dynamic friction (default 0.6)."),
      },
    },
    async ({ packageName, gravity, restitution, friction }) => {
      const g = (gravity && gravity.length === 3 ? gravity : [0, -9.81, 0]) as number[];
      const rest = restitution ?? 0.2;
      const fric = friction ?? 0.6;
      const customG = !(g[0] === 0 && g[1] === -9.81 && g[2] === 0);
      const kt = [
        `package ${packageName}`,
        "",
        "import android.os.Handler",
        "import android.os.Looper",
        "import android.util.Log",
        "import com.pico.spatial.core.ecs.CollisionComponent",
        "import com.pico.spatial.core.ecs.Entity",
        "import com.pico.spatial.core.ecs.ModelComponent",
        "import com.pico.spatial.core.ecs.PhysicsForceComponent",
        "import com.pico.spatial.core.ecs.PhysicsVelocityComponent",
        "import com.pico.spatial.core.ecs.PhysicsWorldComponent",
        "import com.pico.spatial.core.ecs.RigidBodyComponent",
        "import com.pico.spatial.core.ecs.TransformComponent",
        "import com.pico.spatial.core.ecs.resource.MeshResource",
        "import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial",
        "import com.pico.spatial.core.ecs.resource.PhysicsMaterialResource",
        "import com.pico.spatial.core.ecs.resource.ShapeResource",
        "import com.pico.spatial.core.math.Color4",
        "import com.pico.spatial.core.ecs.simulation.MassProperties",
        "import com.pico.spatial.core.ecs.simulation.RigidBodyMode",
        "import com.pico.spatial.core.math.Quat",
        "import com.pico.spatial.core.math.Vector3",
        "",
        "/**",
        " * Generated by generate_rigidbody_kotlin. REAL emulator physics (vision-verified strike, v8.8).",
        " * 1) initWorld(root)  2) staticBox/Sphere/Capsule(root, ...) floor/props  3) dynamicBox/Sphere/Capsule(root, ...)",
        " * 4) launch(body, velocity) to throw  5) resetWorld(oldRoot) { rebuild() } to reset.",
        " * THE ADAPTER RULES: create bodies with ALL components in one batch (these helpers do);",
        " * NEVER destroy+respawn individual live bodies (collision pairing is lost) or destroy a",
        " * physics-world root (poisons later worlds — resetWorld disables instead); NEVER teleport a",
        " * live body beyond a few cm (jump/timestep becomes velocity); keep DISCRETE collision",
        " * (CONTINUOUS kills dynamic-vs-dynamic contacts); expect a ~2s epoch beat before a set",
        " * velocity takes effect. Attach a ModelComponent to a body to SEE it. All @MainThread.",
        " */",
        "object ScenePhysics {",
        '    private const val TAG = "ScenePhysics"',
        "",
        "    private fun physMat(): PhysicsMaterialResource =",
        `        PhysicsMaterialResource(${fric}f, ${fric}f, ${rest}f)`,
        "",
        "    /** Call ONCE on the scene root (or a common parent of every physics entity). */",
        "    fun initWorld(root: Entity) {",
        customG
          ? `        runCatching { root.components.set(PhysicsWorldComponent(Vector3(${g[0]}f, ${g[1]}f, ${g[2]}f))) }`
          : "        runCatching { root.components.set(PhysicsWorldComponent()) }",
        "            .onFailure { Log.e(TAG, \"PhysicsWorld failed: ${it.message}\") }",
        "    }",
        "",
        "    /** A STATIC floor/wall (collider, no RigidBody). fullExtents = full box size (a 1m box spans ±0.5). */",
        "    fun staticBox(root: Entity, name: String, pos: Vector3, fullExtents: Vector3, tint: Color4 = Color4(0.5f, 0.42f, 0.3f, 1f)): Entity =",
        "        body(root, name, pos, ShapeResource.createBox(fullExtents), MeshResource.createBox(fullExtents), dynamic = false, mass = 0f, tint = tint)",
        "",
        "    /** A STATIC sphere (boulder/dome — collider, no RigidBody; sphere shapes are valid static colliders). */",
        "    fun staticSphere(root: Entity, name: String, pos: Vector3, radius: Float, tint: Color4 = Color4(0.5f, 0.42f, 0.3f, 1f)): Entity =",
        "        body(root, name, pos, ShapeResource.createSphere(radius), MeshResource.createSphere(radius), dynamic = false, mass = 0f, tint = tint)",
        "",
        "    /** A STATIC capsule (pillar/post/flag pole — collider, no RigidBody; capsule shapes are valid static colliders). */",
        "    fun staticCapsule(root: Entity, name: String, pos: Vector3, height: Float, radius: Float, tint: Color4 = Color4(0.5f, 0.42f, 0.3f, 1f)): Entity =",
        "        body(root, name, pos, ShapeResource.createCapsule(height, radius), MeshResource.createCapsule(height, radius), dynamic = false, mass = 0f, tint = tint)",
        "",
        "    /** A DYNAMIC box that falls under gravity and rests on a static collider. */",
        "    fun dynamicBox(root: Entity, name: String, pos: Vector3, fullExtents: Vector3, mass: Float = 1f, tint: Color4 = Color4(0.7f, 0.7f, 0.72f, 1f)): Entity =",
        "        body(root, name, pos, ShapeResource.createBox(fullExtents), MeshResource.createBox(fullExtents), dynamic = true, mass = mass, tint = tint)",
        "",
        "    /** A DYNAMIC sphere that falls and rolls/rests. */",
        "    fun dynamicSphere(root: Entity, name: String, pos: Vector3, radius: Float, mass: Float = 1f, tint: Color4 = Color4(0.12f, 0.1f, 0.25f, 1f)): Entity =",
        "        body(root, name, pos, ShapeResource.createSphere(radius), MeshResource.createSphere(radius), dynamic = true, mass = mass, tint = tint)",
        "",
        "    /** Apply a CONSTANT local-space force/torque to a dynamic body (e.g. wind/thruster). */",
        "    fun applyForce(body: Entity, force: Vector3, torque: Vector3 = Vector3(0f, 0f, 0f)) {",
        "        runCatching { body.components.set(PhysicsForceComponent(force, torque)) }",
        "            .onFailure { Log.e(TAG, \"applyForce failed: ${it.message}\") }",
        "    }",
        "",
        "    /** Give a body a one-shot world-space velocity kick (linear m/s, angular rad/s). */",
        "    fun setVelocity(body: Entity, linear: Vector3, angular: Vector3 = Vector3(0f, 0f, 0f)) {",
        "        runCatching { body.components.set(PhysicsVelocityComponent(linear, angular)) }",
        "            .onFailure { Log.e(TAG, \"setVelocity failed: ${it.message}\") }",
        "    }",
        "",
        "    /** A DYNAMIC capsule (upright pin/bottle shape) that falls, topples and rests. */",
        "    fun dynamicCapsule(root: Entity, name: String, pos: Vector3, height: Float, radius: Float, mass: Float = 1f, tint: Color4 = Color4(0.95f, 0.95f, 0.92f, 1f)): Entity =",
        "        body(root, name, pos, ShapeResource.createCapsule(height, radius), MeshResource.createCapsule(height, radius), dynamic = true, mass = mass, tint = tint)",
        "",
        "    /** THE SAFE THROW: a cm-scale upward nudge (breaks resting contact — a settled body ignores",
        "     *  velocity), then the velocity a beat later. The engine batches physics ops on ~2s epochs,",
        "     *  so motion starts on the NEXT epoch — expect a visible pause before the body moves.",
        "     *  The nudge MUTATES position in place (transform.position = ...). It must never replace the",
        "     *  TransformComponent: a replacement writes identity rotation and unit scale too, so any body",
        "     *  that was rotated or scaled at build time would silently snap upright and to 1x the instant",
        "     *  it is launched. PICO mutate in place for exactly this reason (PhysicsManager.kt:172-175). */",
        "    fun launch(body: Entity, linear: Vector3, angular: Vector3 = Vector3(0f, 0f, 0f)) {",
        "        runCatching {",
        "            val t = body.components.get<TransformComponent>()",
        "            if (t == null) {",
        "                Log.w(TAG, \"launch: body has no TransformComponent — skipping the nudge\")",
        "            } else {",
        "                val p = t.position",
        "                t.position = Vector3(p.x, p.y + 0.05f, p.z)",
        "            }",
        "            Handler(Looper.getMainLooper()).postDelayed({",
        "                runCatching { body.components.set(PhysicsVelocityComponent(linear, angular)) }",
        "                    .onFailure { Log.e(TAG, \"launch velocity failed: ${it.message}\") }",
        "            }, 250L)",
        "        }.onFailure { Log.e(TAG, \"launch failed: ${it.message}\") }",
        "    }",
        "",
        "    /** THE ONLY RELIABLE RESET: disable the old physics root (cleanly deactivates its bodies)",
        "     *  and rebuild a fresh root after [rebuildDelayMs] (~3s = past the engine batch epoch).",
        "     *  Do NOT destroy a physics-world root (poisons every world built after it in-process)",
        "     *  and do NOT destroy+respawn individual bodies (collision pairing is lost). */",
        "    fun resetWorld(oldRoot: Entity, rebuildDelayMs: Long = 3000L, rebuild: () -> Unit) {",
        "        runCatching { oldRoot.enabled = false }",
        "            .onFailure { Log.e(TAG, \"resetWorld disable failed: ${it.message}\") }",
        "        Handler(Looper.getMainLooper()).postDelayed({",
        "            runCatching { rebuild() }.onFailure { Log.e(TAG, \"resetWorld rebuild failed: ${it.message}\") }",
        "        }, rebuildDelayMs)",
        "    }",
        "",
        "    private fun body(root: Entity, name: String, pos: Vector3, shape: ShapeResource, mesh: MeshResource, dynamic: Boolean, mass: Float, tint: Color4): Entity {",
        "        val e = Entity()",
        "        e.setName(name)",
        "        e.components.set(TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f)))",
        "        runCatching {",
        "            e.components.set(CollisionComponent(listOf(shape), physMat()))",
        "            if (dynamic) {",
        "                e.components.set(RigidBodyComponent(MassProperties(mass), RigidBodyMode.DYNAMIC))",
        "            }",
        "            val mat = PhysicallyBasedMaterial.create().apply { setBaseColor(tint); setMetallic(0.1f); setRoughness(0.4f) }",
        "            e.components.set(ModelComponent(mesh, mat))",
        "        }.onFailure { Log.e(TAG, \"body '$name' failed: ${it.message}\") }",
        "        root.addChild(e)",
        "        return e",
        "    }",
        "}",
        "",
      ].join("\n");
      return ok(kt);
    },
  );

  // ── generate_anchor_kotlin ─────────────────────────────────────────────────
  server.registerTool(
    "generate_anchor_kotlin",
    {
      description:
        "Emit SceneAnchor.kt — AnchorComponent helpers to tether an entity to the HMD camera (createCameraTarget) or a persisted world anchor (createWorldAnchorTarget(uuid)), with position/rotation offsets and a tracking mode. Compiles against the SDK. HEADSET-ONLY (C1): anchoring is effective only in full space — it NO-OPS on the emulator (world-tracking returns nothing). Use this for Swan; verify the chain compiles + the component attaches (structural) on the emulator.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content"),
        trackingMode: z.enum(["CONTINUOUS", "ONCE"]).optional().describe("CONTINUOUS = keep following the target; ONCE = snap once. Default CONTINUOUS."),
      },
    },
    async ({ packageName, trackingMode }) => {
      const tm = trackingMode ?? "CONTINUOUS";
      const kt = [
        `package ${packageName}`,
        "",
        "import android.util.Log",
        "import com.pico.spatial.core.ecs.AnchorComponent",
        "import com.pico.spatial.core.ecs.Entity",
        "import com.pico.spatial.core.ecs.anchor.AnchorTarget",
        "import com.pico.spatial.core.math.Quat",
        "import com.pico.spatial.core.math.Vector3",
        "import java.util.UUID",
        "",
        "/**",
        " * Generated by generate_anchor_kotlin. Tethers an entity to the HMD camera or a world anchor.",
        " * @MainThread. HEADSET-ONLY (C1): effective only in full space; NO-OP on the emulator (world",
        " * tracking returns nothing). VERIFY on the emulator: compiles + the component attaches (structural).",
        " */",
        "object SceneAnchor {",
        '    private const val TAG = "SceneAnchor"',
        "",
        "    /** Anchor [entity] to the HMD camera with a position offset (e.g. heads-up content). */",
        "    fun anchorToCamera(entity: Entity, positionOffset: Vector3 = Vector3(0f, 0f, -1f)) {",
        "        runCatching {",
        `            val anchor = AnchorComponent(AnchorTarget.createCameraTarget(), AnchorComponent.TrackingMode.${tm})`,
        "            anchor.positionOffset = positionOffset",
        "            anchor.rotationOffset = Quat.identity()",
        "            entity.components.set(anchor)",
        '            Log.i(TAG, "anchored to camera (headset-only)")',
        "        }.onFailure { Log.e(TAG, \"anchorToCamera failed: ${it.message}\") }",
        "    }",
        "",
        "    /** Anchor [entity] to a persisted world anchor by UUID (requires world tracking — headset). */",
        "    fun anchorToWorld(entity: Entity, uuid: UUID) {",
        "        runCatching {",
        `            val anchor = AnchorComponent(AnchorTarget.createWorldAnchorTarget(uuid), AnchorComponent.TrackingMode.${tm})`,
        "            entity.components.set(anchor)",
        '            Log.i(TAG, "anchored to world anchor $uuid (headset-only)")',
        "        }.onFailure { Log.e(TAG, \"anchorToWorld failed: ${it.message}\") }",
        "    }",
        "}",
        "",
      ].join("\n");
      return ok(kt);
    },
  );
}
