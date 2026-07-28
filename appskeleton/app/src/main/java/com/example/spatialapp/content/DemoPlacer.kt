package com.example.spatialapp.content

import android.util.Log
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.ecs.resource.AssetBundle
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import com.pico.spatial.tracking.hmd.HMDTrackingProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.acos

/**
 * Minimal, headless-drivable marker placer for the v3.0 demo. Casts the HMD (head) forward ray
 * against the box-room colliders (SpatialColliders.rayCast) and instantiates a "Pin" marker at the
 * hit surface, oriented to the surface normal. The emulator gives no 6DOF controller pose and gates
 * the trigger, so placement is driven via the DEBUG_CMD broadcast channel. All SDK calls here are
 * the same ones proven on-device for surface pin placement.
 */
class DemoPlacer(
    /** Identity/origin parent that carries the PhysicsWorldComponent — its `scene` is the rayCast world,
     *  and markers added as its children render at world coordinates (no frame offset). */
    private val sceneRoot: Entity,
    /** Asset bundle holding the marker model (e.g. a baked "Pin"). */
    private val bundle: AssetBundle,
) {
    private val tag = "SpatialDemo"
    private val hmd = HMDTrackingProvider()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val placed = mutableListOf<Entity>()
    private var busy = false

    fun start() {
        runCatching { hmd.start() }.onFailure { Log.e(tag, "hmd start failed: ${it.message}") }
    }

    /** Place a marker ~1.5 m in front of the gaze — the broadcast 'place' command. The emulator has no
     *  scene-understanding, so this is a FIXED-DISTANCE placement (honest), not a surface snap. */
    fun placeAtGaze() {
        if (busy) return
        val pose = hmd.latestData.hmdPose
        val origin = pose.position
        val forward = pose.rotation.rotateVector(Vector3.FORWARD).normalize()
        val point = origin.plus(forward.times(1.5f))
        Log.i(tag, "place at gaze distance: $point (origin=$origin fwd=$forward)")
        placeAt(point, forward.unaryMinus())
    }

    /** Seed a RING of markers around the user at eye level so that — whichever way the (uncontrollable,
     *  decoupled) emulator camera faces — some damage pins are in view when you look around the home
     *  environment. Fixed world positions so they're easy to find by navigating the emulator. */
    fun seedDemoPins() {
        // THREE markers in a forward arc (all in the HMD FOV for a single-capture
        // visual check), spread left/center/right at a comfortable gallery height.
        val radius = 2.2f
        val angles = doubleArrayOf(158.0, 180.0, 202.0) // around -Z (dead ahead)
        for (a0 in angles) {
            val a = Math.toRadians(a0)
            val p = Vector3((radius * kotlin.math.sin(a)).toFloat(), 1.45f, (radius * kotlin.math.cos(a)).toFloat())
            placeAt(p, p.times(-1f).normalize()) // face the user
        }
        Log.i(tag, "seeded 3-orb gallery arc (radius $radius) in the forward FOV")
    }

    private fun placeAt(point: Vector3, normal: Vector3) {
        busy = true
        scope.launch {
            runCatching {
                val pin = Entity.loadSuspend("Pin", bundle)
                pin.components.get(TransformComponent::class.java)?.apply {
                    position = point
                    setQuaternion(quatYToNormal(normal))
                }
                sceneRoot.addChild(pin)
                placed.add(pin)
                Log.i(tag, "placed pin #${placed.size} at $point")
            }.onFailure { Log.e(tag, "pin placement failed: ${it.message}") }
            busy = false
        }
    }

    /** Remove every placed marker. */
    fun clearAll() {
        scope.launch {
            val snapshot = placed.toList()
            placed.clear()
            var removed = 0
            snapshot.forEach { pin ->
                runCatching { sceneRoot.removeChild(pin); pin.destroy(true); removed++ }
                    .onFailure { Log.w(tag, "clear: ${it.message}") }
            }
            Log.i(tag, "cleared $removed/${snapshot.size} pins")
        }
    }

    /** Rotate local +Y onto the surface normal (snap to world up/down near vertical) — same as the
     *  proven pin orientation logic. */
    private fun quatYToNormal(nRaw: Vector3): Quat {
        var n = nRaw.normalize()
        if (abs(n.y) > 0.85f) n = if (n.y > 0f) Vector3.UP else Vector3.DOWN
        val dot = Vector3.dot(Vector3.UP, n)
        if (dot > 0.9999f) return Quat.identity()
        if (dot < -0.9999f) return Quat(Vector3(1f, 0f, 0f), Math.PI.toFloat())
        val axis = Vector3.cross(Vector3.UP, n).normalize()
        return Quat(axis, acos(dot.coerceIn(-1f, 1f)))
    }
}
