package com.example.showroomxr.content
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.example.showroomxr.agent.AgentBridge
import com.example.showroomxr.gen.GameMenu
import com.pico.spatial.core.ecs.CollisionComponent
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.ModelComponent
import com.pico.spatial.core.ecs.PhysicsVelocityComponent
import com.pico.spatial.core.ecs.PhysicsWorldComponent
import com.pico.spatial.core.ecs.PointLightComponent
import com.pico.spatial.core.ecs.RigidBodyComponent
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.ecs.resource.AssetBundle
import com.pico.spatial.core.ecs.resource.MeshResource
import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial
import com.pico.spatial.core.ecs.resource.PhysicsMaterialResource
import com.pico.spatial.core.ecs.resource.ShapeResource
import com.pico.spatial.core.ecs.simulation.MassProperties
import com.pico.spatial.core.ecs.simulation.RigidBodyMode
import com.pico.spatial.core.math.Color4
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.ui.foundation.content.SpatialView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "SpatialDemo"
private var sceneRoot: Entity? = null
private var bowlBall: Entity? = null
private val pins = mutableListOf<Entity>()
private var rebuildScene: (() -> Unit)? = null
private var throwing = false
private val BALL_START = Vector3(0f, 1.17f, -2.95f)
private const val BALL_R = 0.15f
private const val PIN_H = 0.30f
private const val PIN_R = 0.06f
private val PIN_Y = 1.0f + (PIN_H + 2f * PIN_R) / 2f
private val ROWS = listOf(listOf(0f), listOf(-0.14f, 0.14f), listOf(-0.28f, 0f, 0.28f), listOf(-0.42f, -0.14f, 0.14f, 0.42f))
private val pinPM = PhysicsMaterialResource(0.3f, 0.3f, 0.25f)
private val lanePM = PhysicsMaterialResource(0.15f, 0.15f, 0.15f)
private fun pbr(c: Color4, m: Float, r: Float) = PhysicallyBasedMaterial.create().apply { setBaseColor(c); setMetallic(m); setRoughness(r) }
private fun rackPositions(): List<Vector3> = buildList {
    ROWS.forEachIndexed { ri, xs -> val z = -5.0f - ri * 0.26f; xs.forEach { x -> add(Vector3(x, PIN_Y, z)) } }
}

// GAME PHYSICS RULES (all learned the hard way on the emulator's adapter):
//  * Bodies must be created with ALL their components in one batch, at scene build — the proven path.
//  * destroy+respawn of INDIVIDUAL bodies in a live world loses collision pairing (balls roll
//    through pins; pins sink through the lane). NEVER do partial respawns.
//  * The kinematic mode flip is a silent no-op, and a transform-set on a dynamic body is
//    interpreted as motion: (jump / timestep) becomes velocity — a meters-long "teleport" launches
//    the body through the floor. NEVER teleport live bodies more than a few cm.
//  * So RESET = destroy the ENTIRE game root (physics world included) and rebuild it from scratch,
//    exactly like launch. The menu lives on its own root and survives.

private fun makeBall(root: Entity): Entity {
    val e = Entity(); e.setName("ball")
    e.components.set(TransformComponent(BALL_START, Quat.identity(), Vector3(1f, 1f, 1f)))
    e.components.set(CollisionComponent(listOf(ShapeResource.createSphere(BALL_R)), lanePM))
    e.components.set(RigidBodyComponent(MassProperties(5f), RigidBodyMode.DYNAMIC).apply { linearDamping = 0.1f })
    e.components.set(ModelComponent(MeshResource.createSphere(BALL_R), pbr(Color4(0.06f, 0.05f, 0.12f, 1f), 0.7f, 0.08f)))
    root.addChild(e)
    return e
}

private fun makePins(root: Entity) {
    rackPositions().forEachIndexed { i, pos ->
        val pin = Entity(); pin.setName("pin$i")
        pin.components.set(TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f)))
        pin.components.set(CollisionComponent(listOf(ShapeResource.createCapsule(PIN_H, PIN_R)), pinPM))
        pin.components.set(RigidBodyComponent(MassProperties(0.35f), RigidBodyMode.DYNAMIC).apply { linearDamping = 0.05f })
        pin.components.set(ModelComponent(MeshResource.createCapsule(PIN_H, PIN_R), pbr(Color4(0.95f, 0.95f, 0.92f, 1f), 0f, 0.25f)))
        SceneLighting.groundShadow(pin); root.addChild(pin); pins.add(pin)
    }
}

// START (green): throw the existing ball — a tiny upward nudge (cm-scale, harmless) to break the
// resting contact, then the velocity. Works on a freshly built rack; after a strike, RESET first.
private fun throwBall() {
    val ball = bowlBall ?: run { Log.i(TAG, "no ball — RESET first"); return }
    if (throwing) return
    throwing = true
    val h = Handler(Looper.getMainLooper())
    ball.components.set(TransformComponent(Vector3(0f, 1.25f, -2.95f), Quat.identity(), Vector3(1f, 1f, 1f)))
    h.postDelayed({
        ball.components.set(PhysicsVelocityComponent(Vector3(0f, 0f, -8f), Vector3(-8f, 0f, 0f)))
        Log.i(TAG, "BOWL! ball launched")
    }, 250L)
    for (t in listOf(1500L, 3000L)) h.postDelayed({
        val bp = ball.components.get<TransformComponent>()?.position
        Log.i(TAG, "throwcheck t=" + t + " z=" + bp?.z + " y=" + bp?.y)
        if (t == 3000L) throwing = false
    }, t)
}

// RESET (red): full game-root rebuild — the only reliably clean physics state.
private fun resetGame() {
    val old = sceneRoot ?: return
    sceneRoot = null; bowlBall = null; pins.clear(); throwing = false
    // DISABLE the old root instead of destroying it — destroying a physics world poisons every
    // world built after it in this process (their bodies sink through geometry, deterministically).
    runCatching { old.enabled = false }.onFailure { Log.e(TAG, "root disable: " + it.message) }
    val h = Handler(Looper.getMainLooper())
    // A full native batch epoch (~2s) must pass between the destroy and the rebuild — same-epoch
    // rebuild registers the new bodies against the dying world and they fall through the lane.
    h.postDelayed({ rebuildScene?.invoke(); Log.i(TAG, "RESET: game scene rebuilt") }, 2800L)
    for (t in listOf(6000L, 8000L)) h.postDelayed({
        val py = pins.firstOrNull()?.components?.get<TransformComponent>()?.position
        val by = bowlBall?.components?.get<TransformComponent>()?.position
        Log.i(TAG, "rerackcheck t=" + t + " pin0 y=" + py?.y + " z=" + py?.z + " ball z=" + by?.z)
    }, t)
}

@Composable
fun HomeStage() {
    SpatialView(modifier = Modifier.fillMaxSize(), initial = { content, _ ->
        withContext(Dispatchers.Main) {
            val buildGame: () -> Unit = {
                val root = Entity(); root.setName("GameRoot")
                root.components.set(TransformComponent(Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))
                root.components.set(PhysicsWorldComponent(Vector3(0f, -9.81f, 0f)))
                content.addEntity(root); AgentBridge.attachScene(root); sceneRoot = root

                val laneExt = Vector3(1.3f, 0.2f, 3.8f)
                val lane = Entity()
                lane.components.set(TransformComponent(Vector3(0f, 0.9f, -4.4f), Quat.identity(), Vector3(1f, 1f, 1f)))
                lane.components.set(CollisionComponent(listOf(ShapeResource.createBox(laneExt)), lanePM))
                lane.components.set(ModelComponent(MeshResource.createBox(laneExt), pbr(Color4(0.55f, 0.4f, 0.22f, 1f), 0.05f, 0.35f)))
                SceneLighting.shadowReceiver(lane); root.addChild(lane)
                for (sx in floatArrayOf(-0.72f, 0.72f)) {
                    val g = Entity()
                    g.components.set(TransformComponent(Vector3(sx, 0.92f, -4.4f), Quat.identity(), Vector3(1f, 1f, 1f)))
                    g.components.set(ModelComponent(MeshResource.createBox(Vector3(0.14f, 0.14f, 3.8f)), pbr(Color4(0.1f, 0.1f, 0.12f, 1f), 0.3f, 0.5f)))
                    root.addChild(g)
                }
                bowlBall = makeBall(root)
                makePins(root)
                SceneLighting.apply(root)
                runCatching { SceneIBL.applyLocal(root, listOf(bowlBall!!)) }
                val lamp = Entity()
                lamp.components.set(PointLightComponent(Color4(1f, 0.97f, 0.9f, 1f), 5500f, 6f))
                lamp.components.set(TransformComponent(Vector3(0f, 2.0f, -5.4f), Quat.identity(), Vector3(1f, 1f, 1f)))
                root.addChild(lamp)
            }
            rebuildScene = buildGame
            buildGame()
            Log.i(TAG, "BOWLING: real physics. Click START (green) to bowl, RESET (red) to re-rack.")
        }
        // The menu lives on its OWN root so it survives game-root rebuilds.
        runCatching {
            val bundle = withContext(Dispatchers.IO) { AssetBundle.load("asset://menu.bundle") }
            val panel = withContext(Dispatchers.IO) { Entity.loadSuspend("menu", bundle) }
            withContext(Dispatchers.Main) {
                val menuRoot = Entity(); menuRoot.setName("MenuRoot")
                menuRoot.components.set(TransformComponent(Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))
                content.addEntity(menuRoot)
                GameMenu.customActions = mapOf("start" to { throwBall() }, "reset" to { resetGame() })
                GameMenu.attach(menuRoot, panel, emptyList())
            }
        }.onFailure { Log.e(TAG, "menu attach failed: " + it.message) }
        Log.i(TAG, "HomeStage(bowling) ready")
    }, attachments = {})
}

internal fun dispatchDebugCommand(cmd: String, arg: Int = 0) {
    Handler(Looper.getMainLooper()).post {
        when {
            cmd == "bowl" -> throwBall()
            cmd == "start" || cmd == "pause" || cmd == "resume" || cmd == "reset" ->
                runCatching { GameMenu.select(cmd) }.onFailure { Log.e(TAG, "select $cmd: " + it.message) }
            cmd.startsWith("hover:") -> { /* mouse-over preview from the bridge — ignore */ }
            else -> Log.i(TAG, "DEBUG_CMD " + cmd)
        }
    }
}
