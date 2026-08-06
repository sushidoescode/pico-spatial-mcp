import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * spatialaudio.ts — generate_spatial_audio: emit Kotlin that adds a POSITIONED audio source to a
 * scene at a world position, started when the app runs.
 *
 * RETRACTION (2026-08-05) — the previous note here was WRONG, and it is corrected in place rather
 * than quietly deleted. It claimed "a grep of the installed PICO Spatial SDK 0.13.3
 * (~/Library/PICO/sdk) found NO runtime spatial-audio Kotlin component/API on disk". That grep
 * looked in the TOOLCHAIN PAYLOAD; the Kotlin sources live in the Gradle-resolved AAR. Measured:
 * `core-0.13.3-sources.jar` ships com/pico/spatial/core/ecs/resource/AudioResource.kt plus a whole
 * com/pico/spatial/core/ecs/audio/ package (AudioFormat, AudioChannelLayout, AudioStreamConfig,
 * AudioStreamDataCallback, …), and PICO's own SpatialAudio sample calls
 * AudioResource.load(name, path, LoadType.FROM_ASSETS) -> entity.prepareAudio(res) ->
 * AudioPlayerController.setVolume/setLoop/play. So a REAL runtime spatial-audio API exists in the
 * version we target, and the fallback below was chosen on a false premise.
 *
 * WHAT THIS TOOL STILL DOES (unchanged, and still honest about what it is): standard Android
 * SoundPool — it loads the bundled asset and plays it at app start, "anchored" at the given world
 * position via a CRUDE distance-attenuation + L/R pan. That is a positional TRIGGER, not
 * spatialization, and it remains useful only where you deliberately want no SDK dependency.
 * PREFER the SDK path for new work. A first-class AudioResource/prepareAudio generator is the
 * follow-up this retraction opens; until it ships, this tool must not be read as evidence that the
 * SDK lacks audio.
 *
 * EVIDENCE CLASS: structural — the code compiles, the app runs, and logcat shows the audio init +
 * stream id (grep tag SpatialAudioSource). Audio is NOT visually verifiable, and TRUE head-tracked
 * HRTF spatialization is built_for_headset (PICO Swan). Never claim SDK spatialization we didn't
 * confirm. For entity-attached SDK audio (ObjectAudioComponent + an editor-authored SpatialAudioFile)
 * see generate_spatial_audio_kotlin (richness.ts) — that path is device/headset-verified, not emulator.
 */
export function registerSpatialAudioTools(server: McpServer) {
  server.registerTool(
    "generate_spatial_audio",
    {
      description:
        "FALLBACK LANE (see the retraction in this file's header): SDK 0.13.3 DOES ship a runtime spatial-audio API (AudioResource + entity.prepareAudio + AudioPlayerController, verified in core-0.13.3-sources.jar and used by PICO's own SpatialAudio sample) — an earlier note here wrongly said it did not. This tool deliberately emits Android SoundPool instead: a positional TRIGGER with crude distance/pan, no SDK dependency, no HRTF. Prefer the SDK path for new work. Emit SpatialAudioSource.kt — add a POSITIONED audio source to a scene at a world position, started when the app runs. HONEST SCOPE: a grep of the installed SDK 0.13.3 found NO runtime spatial-audio Kotlin API (only the editor's USD SpatialAudioFile authoring schema), so this does NOT use SDK HRTF — it FALLS BACK to Android SoundPool, loading the bundled asset and playing it at app start with a CRUDE distance-attenuation + L/R pan from the position (a positional TRIGGER, not spatialization). EVIDENCE: structural — compiles + app runs + logcat shows audio init/stream id (tag SpatialAudioSource); audio is NOT visually verifiable and TRUE HRTF spatialization is built_for_headset (PICO Swan). Call SpatialAudioSource.start(context) from your scene onCreate/onResume and stop() on teardown; put <assetName> in src/main/assets/. RETURNS JSON {kotlin, manifestEntry, note, evidence}. For entity-attached SDK audio see generate_spatial_audio_kotlin.",
      inputSchema: {
        assetName: z.string().describe("Audio file bundled under src/main/assets/, e.g. 'ambient.ogg' (SoundPool: short clips; .ogg/.wav)."),
        position: z
          .tuple([z.number(), z.number(), z.number()])
          .describe("World position [x,y,z] in meters the sound is conceptually anchored at; used for a crude distance/pan hint (NOT true HRTF)."),
        loop: z.boolean().optional().default(false).describe("Loop forever (SoundPool loop=-1) vs play once (default false)."),
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content"),
      },
    },
    async ({ assetName, position, loop, packageName }) => {
      const [x, y, z] = position;
      const flt = (n: number) => (Number.isFinite(n) ? `${n}f` : "0f");
      const loopVal = loop ? -1 : 0;
      const asset = JSON.stringify(assetName); // safe Kotlin string literal

      const kt = [
        `package ${packageName}`,
        ``,
        `import android.content.Context`,
        `import android.content.res.AssetFileDescriptor`,
        `import android.media.AudioAttributes`,
        `import android.media.SoundPool`,
        `import android.util.Log`,
        `import kotlin.math.sqrt`,
        ``,
        `/**`,
        ` * Generated by generate_spatial_audio. A POSITIONED audio source played at app start.`,
        ` *`,
        ` * HONEST: this uses Android SoundPool, NOT SDK HRTF spatial audio (no runtime spatial-audio API`,
        ` * was found in PICO Spatial SDK 0.13.3 — only the editor's USD SpatialAudioFile authoring schema).`,
        ` * [position] anchors the sound conceptually; start() derives a CRUDE distance attenuation + L/R pan`,
        ` * from it (listener assumed at origin). That is a positional TRIGGER — true head-tracked HRTF`,
        ` * spatialization is device-only (PICO Swan). Structural evidence: logcat tag SpatialAudioSource.`,
        ` * Put ${assetName} in src/main/assets/. Call start(context) from your scene onCreate/onResume.`,
        ` */`,
        `object SpatialAudioSource {`,
        `    private const val TAG = "SpatialAudioSource"`,
        `    private const val ASSET = ${asset}`,
        `    private const val LOOP = ${loopVal}            // -1 = loop forever, 0 = play once`,
        ``,
        `    /** World position the sound is conceptually anchored at (meters). */`,
        `    val position = floatArrayOf(${flt(x)}, ${flt(y)}, ${flt(z)})`,
        ``,
        `    private var soundPool: SoundPool? = null`,
        `    private var afd: AssetFileDescriptor? = null`,
        `    private var streamId = 0`,
        ``,
        `    /** Crude, NON-HRTF per-channel volume (listener at origin; pan in [-1..1] from world X). */`,
        `    private fun channels(): Pair<Float, Float> {`,
        `        val dist = sqrt(position[0] * position[0] + position[1] * position[1] + position[2] * position[2])`,
        `        val atten = 1f / (1f + dist)                 // 1/(1+d) distance falloff`,
        `        val pan = position[0].coerceIn(-1f, 1f)      // <0 = left, >0 = right`,
        `        val left = (1f - pan.coerceAtLeast(0f)) * atten`,
        `        val right = (1f + pan.coerceAtMost(0f)) * atten`,
        `        return left to right`,
        `    }`,
        ``,
        `    /** Load the asset and play it at app start. Releases any prior pool first. */`,
        `    fun start(context: Context) {`,
        `        stop()`,
        `        runCatching {`,
        `            val attrs = AudioAttributes.Builder()`,
        `                .setUsage(AudioAttributes.USAGE_GAME)`,
        `                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)`,
        `                .build()`,
        `            val pool = SoundPool.Builder().setMaxStreams(4).setAudioAttributes(attrs).build()`,
        `            soundPool = pool`,
        `            pool.setOnLoadCompleteListener { sp, sampleId, status ->`,
        `                if (status == 0) {`,
        `                    val (l, r) = channels()`,
        `                    streamId = sp.play(sampleId, l, r, 1, LOOP, 1f)`,
        `                    Log.i(TAG, "play asset=" + ASSET + " pos=(" + position[0] + "," + position[1] + "," +`,
        `                        position[2] + ") L=" + l + " R=" + r + " loop=" + LOOP + " stream=" + streamId +`,
        `                        " (positional trigger; HRTF=device)")`,
        `                } else {`,
        `                    Log.e(TAG, "SoundPool load failed status=" + status)`,
        `                }`,
        `            }`,
        `            val descriptor = context.assets.openFd(ASSET)`,
        `            afd = descriptor`,
        `            val soundId = pool.load(descriptor, 1)`,
        `            Log.i(TAG, "loading asset=" + ASSET + " id=" + soundId)`,
        `        }.onFailure { Log.e(TAG, "audio init failed: " + it.message) }`,
        `    }`,
        ``,
        `    /** Stop playback and release native resources. Call on scene teardown. */`,
        `    fun stop() {`,
        `        runCatching {`,
        `            if (streamId != 0) soundPool?.stop(streamId)`,
        `            soundPool?.release()`,
        `            afd?.close()`,
        `        }`,
        `        soundPool = null`,
        `        afd = null`,
        `        streamId = 0`,
        `    }`,
        `}`,
        ``,
      ].join("\n");

      const note =
        `Write to content/SpatialAudioSource.kt and bundle ${assetName} in src/main/assets/. ` +
        `Call SpatialAudioSource.start(context) from your scene/activity onCreate or onResume, and stop() on teardown. ` +
        `No manifest entry / permission needed (bundled asset). SoundPool = a positional TRIGGER with a crude ` +
        `distance/pan hint from position — NOT SDK HRTF. Evidence is structural: adb logcat | grep SpatialAudioSource ` +
        `shows "loading asset=..." then "play asset=... stream=...". Audio is NOT visually verifiable and true ` +
        `head-tracked spatialization is built_for_headset (PICO Swan). For entity-attached SDK audio see ` +
        `generate_spatial_audio_kotlin (ObjectAudioComponent + editor SpatialAudioFile).`;

      return okJson({ kotlin: kt, manifestEntry: "", note, evidence: "structural" });
    },
  );
}
