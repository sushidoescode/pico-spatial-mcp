package com.example.showroomxr.content
import android.util.Log
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import com.example.showroomxr.agent.AgentBridge
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.ModelComponent
import com.pico.spatial.core.ecs.PointLightComponent
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.ecs.resource.BlendingMode
import com.pico.spatial.core.ecs.resource.MeshResource
import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial
import com.pico.spatial.core.math.Color4
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.ui.foundation.content.SpatialView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "SpatialDemo"
private fun pbr(c: Color4, m: Float, r: Float) = PhysicallyBasedMaterial.create().apply { setBaseColor(c); setMetallic(m); setRoughness(r) }

@Composable
fun HomeStage() {
    val cx = 0f; val cy = 1.7f; val cz = -3.3f
    SpatialView(modifier = Modifier.fillMaxSize(), initial = { content, _ ->
        withContext(Dispatchers.Main) {
            val root = Entity(); root.setName("SceneRoot")
            root.components.set(TransformComponent(Vector3(0f,0f,0f), Quat.identity(), Vector3(1f,1f,1f)))
            content.addEntity(root); AgentBridge.attachScene(root); SceneAnimator.clear()

            // ── glowing SUN + point light ──
            val sun = Entity(); val smat = pbr(Color4(0.2f,0.08f,0f,1f), 0f, 0.5f)
            sun.components.set(ModelComponent(MeshResource.createSphere(0.34f), smat))
            sun.components.set(TransformComponent(Vector3(cx, cy, cz), Quat.identity(), Vector3(1f,1f,1f)))
            content.addEntity(sun)
            SceneAnimator.pulseEmissive(smat, Color4(1.4f,0.6f,0.1f,1f), Color4(3.2f,1.5f,0.3f,1f), 2.2f)
            val lamp = Entity(); lamp.components.set(PointLightComponent(Color4(1f,0.85f,0.6f,1f), 7000f, 14f))
            lamp.components.set(TransformComponent(Vector3(cx, cy, cz), Quat.identity(), Vector3(1f,1f,1f)))
            content.addEntity(lamp)

            // ── orbiting planets ──
            fun planet(rad: Float, ang: Float, sp: Float, size: Float, mat: PhysicallyBasedMaterial): Entity {
                val e = Entity(); e.components.set(ModelComponent(MeshResource.createSphere(size), mat))
                e.components.set(TransformComponent(Vector3(cx + rad, cy, cz), Quat.identity(), Vector3(1f,1f,1f)))
                content.addEntity(e); SceneAnimator.orbit(e, Vector3(cx, cy, cz), rad, ang, sp); return e
            }
            val gold = planet(0.72f, 0.4f, 0.52f, 0.15f, pbr(Color4(1f,0.78f,0.32f,1f), 1f, 0.12f)) // metal → IBL shine
            planet(1.02f, 2.2f, 0.36f, 0.20f, pbr(Color4(0.18f,0.42f,0.9f,1f), 0f, 0.35f))          // ocean
            planet(1.34f, 4.1f, 0.27f, 0.14f, pbr(Color4(0.8f,0.35f,0.2f,1f), 0f, 0.6f))            // rocky
            val tech = pbr(Color4(0.02f,0.15f,0.2f,1f), 0f, 0.4f)                                    // tech-world (emissive)
            planet(1.7f, 5.5f, 0.19f, 0.22f, tech)
            SceneAnimator.pulseEmissive(tech, Color4(0.05f,0.5f,0.7f,1f), Color4(0.2f,1.4f,1.9f,1f), 1.6f)

            // ── holographic telemetry panels (transparent, fading, spinning) ──
            for (i in 0..1) {
                val hE = Entity(); val hmat = pbr(Color4(0.2f,0.85f,1f,0.6f), 0f, 0.2f)
                hmat.setBlendingMode(BlendingMode.TRANSPARENT); hmat.setEmissiveColor(Color4(0.1f,0.55f,0.85f,1f))
                hE.components.set(ModelComponent(MeshResource.createBox(Vector3(0.5f,0.7f,0.02f)), hmat))
                val hx = if (i==0) -1.85f else -2.15f
                hE.components.set(TransformComponent(Vector3(hx, cy + (if(i==0) 0.1f else -0.4f), cz - 0.2f), Quat.identity(), Vector3(1f,1f,1f)))
                content.addEntity(hE)
                SceneAnimator.spin(hE, Vector3(hx, cy + (if(i==0) 0.1f else -0.4f), cz - 0.2f), if(i==0) 25f else -30f)
                SceneAnimator.fadeOpacity(hmat, 0.3f, 0.8f, 2f + i)
            }
            // ── pulsing status core ──
            val statusM = pbr(Color4(0.1f,0.05f,0.05f,1f), 0f, 0.4f)
            val status = Entity(); status.components.set(ModelComponent(MeshResource.createSphere(0.1f), statusM))
            val sPos = Vector3(1.9f, cy + 0.6f, cz)
            status.components.set(TransformComponent(sPos, Quat.identity(), Vector3(1f,1f,1f)))
            content.addEntity(status)
            SceneAnimator.pulseEmissive(statusM, Color4(0.1f,0.6f,0.2f,1f), Color4(0.3f,2.5f,0.9f,1f), 1f)
            SceneAnimator.bob(status, sPos, 0.04f, 2.5f)

            SceneLighting.apply(root)
            SceneIBL.applyLocal(root, listOf(gold))   // the gold planet reflects the studio → shines
            Log.i(TAG, "HERO: orrery observatory — sun + 4 planets + holo panels + status")
        }
        Log.i(TAG, "HomeStage(hero) ready")
    }, attachments = {})
    LaunchedEffect(Unit) { SceneAnimator.run() }
}
internal fun dispatchDebugCommand(cmd: String, arg: Int = 0) { Log.i(TAG, "DEBUG_CMD " + cmd) }
