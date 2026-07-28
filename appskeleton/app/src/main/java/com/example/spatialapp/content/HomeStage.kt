package com.example.spatialapp.content

import android.util.Log
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.example.spatialapp.agent.AgentBridge
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.ModelComponent
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.ecs.resource.MeshResource
import com.pico.spatial.core.ecs.resource.UnlitMaterial
import com.pico.spatial.core.math.Color4
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.ui.foundation.content.SpatialView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Scaffold default stage — a self-contained hello-spatial scene built from procedural
 * primitives only (no asset bundles, no editor-asset module), so a freshly generated
 * project builds AND renders with zero external assets. generate_app_wiring replaces
 * this file when an AppSpec drives the build.
 */
private const val TAG = "SpatialDemo"

@Composable
fun HomeStage() {
    SpatialView(
        // fillMaxSize: the 3D content is transform-mapped to the SpatialView's 2D node — a small
        // node compresses the scene into a small bounded region, so fill the stage.
        modifier = Modifier.fillMaxSize(),
        initial = { content, _ ->
            withContext(Dispatchers.Main) {
                val sceneRoot = Entity()
                sceneRoot.setName("SceneRoot")
                sceneRoot.components.set(TransformComponent(Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))
                content.addEntity(sceneRoot)
                AgentBridge.attachScene(sceneRoot) // headless scene introspection via AGENT_CMD
                SceneLighting.apply(sceneRoot)
                buildHelloScene(sceneRoot)
                Log.i(TAG, "HomeStage ready (scaffold hello scene)")
            }
        },
        attachments = {},
    )
}

/** Backdrop plane + three primitive shapes in a row, unlit so they read in any capture. */
private fun buildHelloScene(root: Entity) {
    fun place(name: String, mesh: MeshResource, color: Color4, pos: Vector3) {
        val e = Entity()
        e.setName(name)
        val mat = UnlitMaterial.create()
        mat.setBaseColor(color)
        e.components.set(ModelComponent(mesh, mat))
        e.components.set(TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f)))
        root.addChild(e)
    }
    place("Backdrop", MeshResource.createPlane(2.4f, 1.5f, 0.02f), Color4(0.10f, 0.13f, 0.20f, 1f), Vector3(0f, 1.45f, -2.6f))
    place("HelloBox", MeshResource.createBox(Vector3(0.30f, 0.30f, 0.30f)), Color4(0.23f, 0.51f, 0.96f, 1f), Vector3(-0.6f, 1.45f, -2.0f))
    place("HelloSphere", MeshResource.createSphere(0.18f), Color4(0.96f, 0.62f, 0.04f, 1f), Vector3(0f, 1.45f, -2.0f))
    place("HelloCapsule", MeshResource.createCapsule(0.44f, 0.15f), Color4(0.13f, 0.77f, 0.37f, 1f), Vector3(0.6f, 1.45f, -2.0f))
}

/**
 * Headless command channel — driven via:
 *   adb shell am broadcast -a com.example.spatialapp.DEBUG_CMD --es cmd ping
 * generate_app_wiring replaces this with the spec's command dispatch.
 */
internal fun dispatchDebugCommand(cmd: String, arg: Int = 0) {
    Log.i(TAG, "DEBUG_CMD cmd=$cmd arg=$arg")
    when (cmd) {
        "ping" -> Log.i(TAG, "pong (scaffold default stage)")
        else -> Log.w(TAG, "unknown DEBUG_CMD: $cmd")
    }
}
