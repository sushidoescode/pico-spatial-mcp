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
private val BALL_START = Vector3(0f, 1.17f, -2.95f)
private const val BALL_R = 0.15f
private val pinPM = PhysicsMaterialResource(0.3f, 0.3f, 0.35f)
private val lanePM = PhysicsMaterialResource(0.15f, 0.15f, 0.15f)
private fun pbr(c: Color4, m: Float, r: Float) = PhysicallyBasedMaterial.create().apply { setBaseColor(c); setMetallic(m); setRoughness(r) }

private fun spawnBall(root: Entity, vel: Vector3?, start: Vector3 = BALL_START): Entity {
    val e = Entity(); e.setName("ball")
    e.components.set(TransformComponent(start, Quat.identity(), Vector3(1f,1f,1f)))
    e.components.set(CollisionComponent(listOf(ShapeResource.createSphere(BALL_R)), lanePM))
    e.components.set(RigidBodyComponent(MassProperties(5f), RigidBodyMode.DYNAMIC).apply { linearDamping = 0.1f })
    e.components.set(ModelComponent(MeshResource.createSphere(BALL_R), pbr(Color4(0.06f,0.05f,0.12f,1f), 0.7f, 0.08f)))
    vel?.let { e.components.set(PhysicsVelocityComponent(it, Vector3(-8f,0f,0f))) }
    root.addChild(e)
    runCatching { SceneIBL.applyLocal(root, listOf(e)) }
    return e
}

private fun setupPins(root: Entity) {
    val ph = 0.30f; val pr = 0.06f; val pinY = 1.0f + (ph + 2f*pr)/2f
    val rows = listOf(listOf(0f), listOf(-0.14f, 0.14f), listOf(-0.28f, 0f, 0.28f), listOf(-0.42f, -0.14f, 0.14f, 0.42f))
    rows.forEachIndexed { ri, xs ->
        val z = -5.0f - ri * 0.26f
        for (x in xs) {
            val pin = Entity(); pin.setName("pin")
            pin.components.set(TransformComponent(Vector3(x, pinY, z), Quat.identity(), Vector3(1f,1f,1f)))
            pin.components.set(CollisionComponent(listOf(ShapeResource.createCapsule(ph, pr)), pinPM))
            pin.components.set(RigidBodyComponent(MassProperties(0.35f), RigidBodyMode.DYNAMIC).apply { linearDamping = 0.05f })
            pin.components.set(ModelComponent(MeshResource.createCapsule(ph, pr), pbr(Color4(0.95f,0.95f,0.92f,1f), 0f, 0.25f)))
            SceneLighting.groundShadow(pin); root.addChild(pin); pins.add(pin)
        }
    }
}

// START (green) — throw a FRESH ball, spawned ELEVATED so it is awake and its velocity applies.
private fun throwBall() {
    val root = sceneRoot ?: return
    runCatching { bowlBall?.destroy(true) }
    bowlBall = spawnBall(root, Vector3(0f, 0f, -8f), Vector3(0f, 1.30f, -2.95f))
    Log.i(TAG, "BOWL! ball thrown")
}

// RESET (red) — clear the knocked-down pins + ball, rebuild the rack.
private fun resetGame() {
    val root = sceneRoot ?: return
    pins.forEach { runCatching { it.destroy(true) } }; pins.clear()
    runCatching { bowlBall?.destroy(true) }
    setupPins(root)
    bowlBall = spawnBall(root, null)
    Log.i(TAG, "RESET: pins + ball restored")
}

@Composable
fun HomeStage() {
    SpatialView(modifier = Modifier.fillMaxSize(), initial = { content, _ ->
        withContext(Dispatchers.Main) {
            val root = Entity(); root.setName("SceneRoot")
            root.components.set(TransformComponent(Vector3(0f,0f,0f), Quat.identity(), Vector3(1f,1f,1f)))
            root.components.set(PhysicsWorldComponent(Vector3(0f, -9.81f, 0f)))
            content.addEntity(root); AgentBridge.attachScene(root); sceneRoot = root

            val laneExt = Vector3(1.3f, 0.2f, 3.8f)
            val lane = Entity()
            lane.components.set(TransformComponent(Vector3(0f, 0.9f, -4.4f), Quat.identity(), Vector3(1f,1f,1f)))
            lane.components.set(CollisionComponent(listOf(ShapeResource.createBox(laneExt)), lanePM))
            lane.components.set(ModelComponent(MeshResource.createBox(laneExt), pbr(Color4(0.55f,0.4f,0.22f,1f), 0.05f, 0.35f)))
            SceneLighting.shadowReceiver(lane); root.addChild(lane)
            for (sx in floatArrayOf(-0.72f, 0.72f)) {
                val g = Entity()
                g.components.set(TransformComponent(Vector3(sx, 0.92f, -4.4f), Quat.identity(), Vector3(1f,1f,1f)))
                g.components.set(ModelComponent(MeshResource.createBox(Vector3(0.14f,0.14f,3.8f)), pbr(Color4(0.1f,0.1f,0.12f,1f), 0.3f, 0.5f)))
                root.addChild(g)
            }
            bowlBall = spawnBall(root, null)
            setupPins(root)
            SceneLighting.apply(root)
            val lamp = Entity()
            lamp.components.set(PointLightComponent(Color4(1f, 0.97f, 0.9f, 1f), 5500f, 6f))
            lamp.components.set(TransformComponent(Vector3(0f, 2.0f, -5.4f), Quat.identity(), Vector3(1f,1f,1f)))
            root.addChild(lamp)
            Log.i(TAG, "BOWLING: real physics. Click START (green) to bowl, RESET (red) to re-rack.")
        }
        // Load the clickable menu panel (the mouse bridge detects it): START -> bowl, RESET -> re-rack
        runCatching {
            val bundle = withContext(Dispatchers.IO) { AssetBundle.load("asset://menu.bundle") }
            val panel = withContext(Dispatchers.IO) { Entity.loadSuspend("menu", bundle) }
            withContext(Dispatchers.Main) {
                GameMenu.customActions = mapOf("start" to { throwBall() }, "reset" to { resetGame() })
                GameMenu.attach(sceneRoot!!, panel, emptyList())
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
