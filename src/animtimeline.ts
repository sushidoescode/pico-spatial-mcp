import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, fail } from "./util.js";

/**
 * animtimeline.ts — MULTI-TRACK keyframe choreography.
 *
 * EXTENDS the vision-verified SceneAnimator runtime-motion path (generate_scene_animator_kotlin):
 * same per-frame `entity.components.set(TransformComponent(...))` on the main thread, same coroutine
 * frame-loop shape. Here N tracks each carry position/rotation/scale/emissive keyframes and are
 * LINEARLY interpolated over a shared timeline. This is transform + material choreography — NOT
 * skeletal/rigged animation (unsupported on this stack). Evidence class when used: vision_verified
 * via before/after motion captures (the SDK AnimationResource is the unreliable path this avoids).
 */
const kf = (n: number): string => (Number.isFinite(n) ? `${n}f` : "0f");
const v3 = (v: number[]): string => `Vector3(${kf(v[0])}, ${kf(v[1])}, ${kf(v[2])})`;
const sortByT = <T extends { t: number }>(a: T[]): T[] => a.slice().sort((x, y) => x.t - y.t);

export function registerAnimTimelineTools(server: McpServer) {
  server.registerTool(
    "generate_animation_timeline",
    {
      description:
        "Emit SceneTimeline.kt — a MULTI-TRACK keyframe choreography driver. EXTENDS the vision-verified SceneAnimator runtime-motion path (generate_scene_animator_kotlin): identical per-frame `entity.components.set(TransformComponent(pos, rot.toQuat(), scale))` on the main thread + the same coroutine frame-loop. Each track carries position/rotation(deg)/scale/emissive keyframes; the driver LINEARLY interpolates between them over a shared timeline (loop or hold). Bind runtime entities by name: SceneTimeline.bind(\"planet\", planetEntity, planetMat); then LaunchedEffect(Unit){ SceneTimeline.run() }. HONEST SCOPE: transform + emissive keyframe choreography only — NOT skeletal/rigged/morph animation (unsupported). Emissive is grayscale intensity (Color4(v,v,v,1f)); needs a PhysicallyBasedMaterial bound. Evidence class when driven: vision_verified via before/after motion captures. RETURNS JSON {kotlin, note} — write to content/SceneTimeline.kt.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content"),
        tracks: z
          .array(
            z.object({
              target: z.string().describe("Track name — you bind the runtime Entity to it via SceneTimeline.bind(name, entity)."),
              keyframes: z
                .array(
                  z.object({
                    t: z.number().describe("Keyframe time in seconds."),
                    pos: z.array(z.number()).length(3).optional().describe("Position [x,y,z] meters."),
                    rotDeg: z.array(z.number()).length(3).optional().describe("Euler rotation [x,y,z] DEGREES."),
                    scale: z.number().optional().describe("Uniform scale factor."),
                    emissive: z.number().optional().describe("Emissive intensity 0..1 (needs a PBR material bound)."),
                  }),
                )
                .min(1)
                .describe("Keyframes; any channel may be omitted per key (each channel interpolates over the keys that set it)."),
            }),
          )
          .min(1)
          .describe("The animation tracks (several objects moving in concert)."),
        loop: z.boolean().optional().describe("Loop the timeline forever (default true); false = play once and hold the last keyframe."),
        durationSec: z.number().optional().describe("Timeline length in seconds (default = the max keyframe time across all tracks)."),
      },
    },
    async ({ packageName, tracks, loop, durationSec }) => {
      for (const tr of tracks) {
        for (const k of tr.keyframes) {
          if (k.pos && k.pos.length !== 3) return fail(`track '${tr.target}': pos must be [x,y,z] (3 numbers).`);
          if (k.rotDeg && k.rotDeg.length !== 3) return fail(`track '${tr.target}': rotDeg must be [x,y,z] degrees (3 numbers).`);
        }
      }
      const allT = tracks.flatMap((t) => t.keyframes.map((k) => k.t));
      const dur = durationSec ?? (allT.length ? Math.max(...allT) : 0);
      const doLoop = loop !== false;

      const trackEntries = tracks
        .map((tr) => {
          const posK = sortByT(tr.keyframes.filter((k) => k.pos)).map((k) => `V3Key(${kf(k.t)}, ${v3(k.pos!)})`);
          const rotK = sortByT(tr.keyframes.filter((k) => k.rotDeg)).map((k) => `V3Key(${kf(k.t)}, ${v3(k.rotDeg!)})`);
          const sclK = sortByT(tr.keyframes.filter((k) => k.scale !== undefined)).map((k) => `NumKey(${kf(k.t)}, ${kf(k.scale!)})`);
          const emiK = sortByT(tr.keyframes.filter((k) => k.emissive !== undefined)).map((k) => `NumKey(${kf(k.t)}, ${kf(k.emissive!)})`);
          const restPos = sortByT(tr.keyframes.filter((k) => k.pos))[0]?.pos ?? [0, 0, 0];
          return [
            `        ${JSON.stringify(tr.target)} to Track(`,
            `            posKeys = listOf(${posK.join(", ")}),`,
            `            rotKeys = listOf(${rotK.join(", ")}),`,
            `            scaleKeys = listOf(${sclK.join(", ")}),`,
            `            emissiveKeys = listOf(${emiK.join(", ")}),`,
            `            restPos = ${v3(restPos)},`,
            `        )`,
          ].join("\n");
        })
        .join(",\n");

      const kt = [
        `package ${packageName}`,
        "",
        "import android.util.Log",
        "import com.pico.spatial.core.ecs.Entity",
        "import com.pico.spatial.core.ecs.TransformComponent",
        "import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial",
        "import com.pico.spatial.core.math.Color4",
        "import com.pico.spatial.core.math.EulerAngles",
        "import com.pico.spatial.core.math.Quat",
        "import com.pico.spatial.core.math.Vector3",
        "import kotlinx.coroutines.Dispatchers",
        "import kotlinx.coroutines.delay",
        "import kotlinx.coroutines.withContext",
        "",
        "/**",
        " * Generated by generate_animation_timeline — a MULTI-TRACK keyframe choreography driver that",
        " * EXTENDS the vision-verified SceneAnimator path: it drives runtime entities via the SAME",
        " * per-frame TransformComponent.set on the main thread (the SDK AnimationResource does NOT",
        " * reliably propagate through the SpatialView node hierarchy). Channels interpolate LINEARLY.",
        " * Transform + emissive choreography only — NOT skeletal/rigged animation.",
        " *",
        " * Usage (in a @Composable, AFTER the scene is built):",
        ' *   SceneTimeline.bind("planet", planetEntity, planetMat)   // mat optional; needed for emissive',
        ' *   SceneTimeline.bind("ring", ringEntity)',
        " *   LaunchedEffect(Unit) { SceneTimeline.run() }",
        " */",
        "object SceneTimeline {",
        '    private const val TAG = "SceneTimeline"',
        `    const val DURATION = ${kf(dur)}`,
        `    const val LOOP = ${doLoop}`,
        "",
        "    private data class V3Key(val t: Float, val v: Vector3)",
        "    private data class NumKey(val t: Float, val v: Float)",
        "    private class Track(",
        "        val posKeys: List<V3Key>,",
        "        val rotKeys: List<V3Key>,",
        "        val scaleKeys: List<NumKey>,",
        "        val emissiveKeys: List<NumKey>,",
        "        val restPos: Vector3,",
        "    )",
        "",
        "    private val tracks: Map<String, Track> = mapOf(",
        trackEntries,
        "    )",
        "",
        "    private class Bound(val entity: Entity, val mat: PhysicallyBasedMaterial?)",
        "    private val bound = mutableMapOf<String, Bound>()",
        "",
        "    /** Bind a track NAME to its runtime Entity (+ optional PBR material for the emissive channel). */",
        "    fun bind(name: String, entity: Entity, mat: PhysicallyBasedMaterial? = null) {",
        '        if (!tracks.containsKey(name)) { Log.w(TAG, "no track named " + name); return }',
        "        bound[name] = Bound(entity, mat)",
        "    }",
        "",
        "    fun clear() { bound.clear() }",
        "",
        "    private fun lerp(a: Float, b: Float, f: Float): Float = a + (b - a) * f",
        "",
        "    private fun sampleV3(keys: List<V3Key>, t: Float, default: Vector3): Vector3 {",
        "        if (keys.isEmpty()) return default",
        "        if (t <= keys.first().t) return keys.first().v",
        "        if (t >= keys.last().t) return keys.last().v",
        "        for (i in 0 until keys.size - 1) {",
        "            val a = keys[i]; val b = keys[i + 1]",
        "            if (t >= a.t && t <= b.t) {",
        "                val f = if (b.t > a.t) (t - a.t) / (b.t - a.t) else 0f",
        "                return Vector3(lerp(a.v.x, b.v.x, f), lerp(a.v.y, b.v.y, f), lerp(a.v.z, b.v.z, f))",
        "            }",
        "        }",
        "        return keys.last().v",
        "    }",
        "",
        "    private fun sampleNum(keys: List<NumKey>, t: Float, default: Float): Float {",
        "        if (keys.isEmpty()) return default",
        "        if (t <= keys.first().t) return keys.first().v",
        "        if (t >= keys.last().t) return keys.last().v",
        "        for (i in 0 until keys.size - 1) {",
        "            val a = keys[i]; val b = keys[i + 1]",
        "            if (t >= a.t && t <= b.t) {",
        "                val f = if (b.t > a.t) (t - a.t) / (b.t - a.t) else 0f",
        "                return lerp(a.v, b.v, f)",
        "            }",
        "        }",
        "        return keys.last().v",
        "    }",
        "",
        "    private fun apply(track: Track, b: Bound, tt: Float) {",
        "        val hasTransform = track.posKeys.isNotEmpty() || track.rotKeys.isNotEmpty() || track.scaleKeys.isNotEmpty()",
        "        if (hasTransform) {",
        "            val p = sampleV3(track.posKeys, tt, track.restPos)",
        "            val r = if (track.rotKeys.isEmpty()) Quat.identity()",
        "                    else sampleV3(track.rotKeys, tt, Vector3(0f, 0f, 0f)).let { EulerAngles(it.x, it.y, it.z).toQuat() }",
        "            val s = sampleNum(track.scaleKeys, tt, 1f)",
        "            b.entity.components.set(TransformComponent(p, r, Vector3(s, s, s)))",
        "        }",
        "        val mat = b.mat",
        "        if (track.emissiveKeys.isNotEmpty() && mat != null) {",
        "            val e = sampleNum(track.emissiveKeys, tt, 0f)",
        "            mat.setEmissiveColor(Color4(e, e, e, 1f))",
        "        }",
        "    }",
        "",
        "    /** Drive the timeline. Call from LaunchedEffect(Unit) { SceneTimeline.run() }. Safe to start",
        "     *  before bind() — the loop reads the shared bound map each frame and picks entities up. */",
        "    suspend fun run(fps: Int = 60) {",
        "        val t0 = System.nanoTime()",
        "        val frameMs = (1000L / fps).coerceAtLeast(8L)",
        "        var announced = false",
        "        while (true) {",
        "            val raw = (System.nanoTime() - t0) / 1_000_000_000f",
        "            val tt = when {",
        "                DURATION <= 0f -> raw",
        "                LOOP -> raw % DURATION",
        "                raw > DURATION -> DURATION",
        "                else -> raw",
        "            }",
        '            if (!announced && bound.isNotEmpty()) { announced = true; Log.i(TAG, "timeline driving " + bound.size + " tracks over " + DURATION + "s") }',
        "            withContext(Dispatchers.Main) {",
        "                for ((name, b) in bound) { tracks[name]?.let { runCatching { apply(it, b, tt) } } }",
        "            }",
        "            delay(frameMs)",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n");

      const note =
        `Write to content/SceneTimeline.kt. After building the scene, bind each track name to its runtime Entity ` +
        `(SceneTimeline.bind("<target>", entity, optionalPbrMat)) then LaunchedEffect(Unit){ SceneTimeline.run() }. ` +
        `Extends the vision-verified SceneAnimator per-frame TransformComponent path; linear-interp transform+emissive ` +
        `choreography, NOT skeletal/rigged. Emissive needs a PhysicallyBasedMaterial bound. Verify by before/after motion captures.`;
      return okJson({ kotlin: kt, note });
    },
  );
}
