import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * setdressing.ts — v13 (Q1): PROCEDURAL themed SET DRESSING — the anti-void kit.
 *
 * The single biggest gap between "works" and "AAA": pipeline scenes render as props floating in a
 * black void. This emits SetDressing.kt — a floor, perimeter neon trim, corner pillars with emissive
 * caps, a marquee sign bar, and a themed light rig — built ENTIRELY from primitives + PBR (no assets
 * to bake/push). Distinct from generate_environment_kotlin (which imports skybox/splat/mesh WORLDS);
 * this one dresses the stage around the content. Every SDK call is verbatim from verified code:
 * MeshResource.createBox / PhysicallyBasedMaterial.create().apply{...} / ModelComponent(mesh, mat)
 * (knockdownxr ScenePhysics), DirectionalLightComponent + ShadowProjectionType.Auto +
 * EnvironmentLightingSettingsComponent (SceneLighting), PointLightComponent(Color4, lm, falloff)
 * (SceneLightingRig), setEmissiveColor(Color4) (SceneAnimator). Hero entities + materials are
 * exposed via SetDressing.entities/materials so SceneTimeline (generate_animation_timeline) can
 * bind and animate them (pulsing neon, bobbing marquee).
 */

type Rgb = [number, number, number];
const C4 = (c: Rgb, a = 1) => `Color4(${c[0]}f, ${c[1]}f, ${c[2]}f, ${a}f)`;
const hex2rgb = (h: string): Rgb => {
  const m = h.replace("#", "");
  return [parseInt(m.slice(0, 2), 16) / 255, parseInt(m.slice(2, 4), 16) / 255, parseInt(m.slice(4, 6), 16) / 255].map((v) => +v.toFixed(3)) as Rgb;
};

type Theme = {
  floor: { color: Rgb; metallic: number; roughness: number };
  trimA: Rgb; trimB: Rgb;               // alternating emissive trim colors
  pillar: Rgb;
  keyLux: number; keyColor: Rgb; ibl: number;
  points: { color: Rgb; lm: number; falloff: number; pos: [number, number, number] }[];
  marquee: Rgb;
};

const THEMES: Record<string, Theme> = {
  neon: {
    floor: { color: [0.05, 0.05, 0.07], metallic: 0.4, roughness: 0.12 },
    trimA: hex2rgb("#ff2d95"), trimB: hex2rgb("#22e0ff"), pillar: [0.07, 0.07, 0.09],
    keyLux: 900, keyColor: [1, 0.95, 0.98], ibl: 0.5,
    points: [
      { color: [1, 0.18, 0.58], lm: 2600, falloff: 9, pos: [-2.2, 2.0, -3.4] },   // wall-wash magenta (near the backdrop)
      { color: [0.13, 0.88, 1], lm: 2600, falloff: 9, pos: [2.2, 2.0, -3.4] },    // wall-wash cyan
      { color: [1, 0.9, 0.95], lm: 450, falloff: 6, pos: [0, 2.6, 0.6] },         // center fill over the play area
    ],
    marquee: hex2rgb("#ff2d95"),
  },
  showroom: {
    floor: { color: [0.82, 0.8, 0.78], metallic: 0.05, roughness: 0.5 },
    trimA: [0.95, 0.9, 0.8], trimB: [0.95, 0.9, 0.8], pillar: [0.75, 0.73, 0.7],
    keyLux: 2200, keyColor: [1, 0.97, 0.9], ibl: 1.6,
    points: [
      { color: [1, 0.95, 0.85], lm: 1100, falloff: 8, pos: [-2.4, 2.6, -2.4] },
      { color: [1, 0.95, 0.85], lm: 1100, falloff: 8, pos: [2.4, 2.6, 2.4] },
    ],
    marquee: [0.9, 0.85, 0.75],
  },
  cosmic: {
    floor: { color: [0.04, 0.05, 0.12], metallic: 0.3, roughness: 0.3 },
    trimA: hex2rgb("#4d6bff"), trimB: hex2rgb("#9b4dff"), pillar: [0.06, 0.07, 0.14],
    keyLux: 700, keyColor: [0.85, 0.9, 1], ibl: 0.4,
    points: [
      { color: [0.3, 0.42, 1], lm: 800, falloff: 7, pos: [-2.6, 2.4, -2.6] },
      { color: [0.61, 0.3, 1], lm: 800, falloff: 7, pos: [2.6, 2.4, 2.6] },
    ],
    marquee: hex2rgb("#4d6bff"),
  },
  noir: {
    floor: { color: [0.12, 0.12, 0.13], metallic: 0.1, roughness: 0.7 },
    trimA: [0.9, 0.7, 0.35], trimB: [0.9, 0.7, 0.35], pillar: [0.1, 0.1, 0.11],
    keyLux: 4000, keyColor: [1, 0.98, 0.92], ibl: 0.3,
    points: [{ color: [1, 0.78, 0.45], lm: 500, falloff: 6, pos: [-2.2, 2.5, -2.2] }],
    marquee: [0.9, 0.7, 0.35],
  },
};

export function registerSetDressingTools(server: McpServer) {
  server.registerTool(
    "generate_set_dressing",
    {
      description:
        "Emit SetDressing.kt — PROCEDURAL themed SET DRESSING that kills the black void (the #1 AAA gap): a glossy PBR floor, perimeter emissive neon trim, corner pillars with glowing caps, a marquee sign bar, and a themed light rig (dim IBL + shadowed key + colored point lights) — all from SDK primitives, no assets to bake. Themes: neon (magenta/cyan arcade), showroom (bright warm), cosmic (blue/violet), noir (single hard key). Call SetDressing.install(sceneRoot) beside/instead of SceneLighting.apply (it sets its OWN dim IBL + key — don't stack a 3500-lux sun on the neon look). Animate it: SetDressing.entities['marquee'|'capNE'|...] + .materials[...] are exposed for SceneTimeline.bind (generate_animation_timeline). All SDK calls verbatim from verified generators. Visual quality still requires a looked-at capture (expected vision_verified once captured; score iterations with fidelity_score). RETURNS JSON {kotlin, callSnippet, animatables, note}.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.demo.bowldeck.content"),
        theme: z.enum(["neon", "showroom", "cosmic", "noir"]).describe("Visual theme."),
        size: z.number().min(6).max(16).optional().describe("Stage footprint in meters (default 9)."),
        withMarquee: z.boolean().optional().describe("Include the floating marquee sign bar (default true)."),
      },
    },
    async ({ packageName, theme, size, withMarquee }) => {
      const T = THEMES[theme];
      const S = size ?? 9;
      const half = +(S / 2).toFixed(2);
      const pil = +(half - 0.3).toFixed(2);
      const marquee = withMarquee !== false;
      const pointsKt = T.points.map((p, i) => [
        `            val pt${i} = Entity()`,
        `            pt${i}.setName("DressPoint${i}")`,
        `            pt${i}.components.set(TransformComponent(Vector3(${p.pos[0]}f, ${p.pos[1]}f, ${p.pos[2]}f), Quat.identity(), Vector3(1f, 1f, 1f)))`,
        `            pt${i}.components.set(PointLightComponent(${C4(p.color)}, ${p.lm}f, ${p.falloff}f))`,
        `            content.addChild(pt${i})`,
      ].join("\n")).join("\n");

      const kt = `package ${packageName}

import android.util.Log
import com.pico.spatial.core.ecs.DirectionalLightComponent
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.EnvironmentLightingSettingsComponent
import com.pico.spatial.core.ecs.ModelComponent
import com.pico.spatial.core.ecs.PointLightComponent
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.ecs.light.ShadowProjectionType
import com.pico.spatial.core.ecs.resource.MeshResource
import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial
import com.pico.spatial.core.math.Color4
import com.pico.spatial.core.math.EulerAngles
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3

/**
 * Generated by generate_set_dressing (theme=${theme}, size=${S}m) — the anti-void kit.
 * Call SetDressing.install(sceneRoot) from SpatialView.initial (Dispatchers.Main), INSTEAD of a
 * bright SceneLighting.apply (this sets its own dim IBL + shadowed key so the ${theme} mood reads).
 * Animatable heroes (SceneTimeline.bind): entities/materials maps — ${marquee ? '"marquee", ' : ""}"capNE","capNW","capSE","capSW".
 */
object SetDressing {
    private const val TAG = "SetDressing"
    val entities = mutableMapOf<String, Entity>()
    val materials = mutableMapOf<String, PhysicallyBasedMaterial>()

    private fun prop(
        parent: Entity, name: String, mesh: com.pico.spatial.core.ecs.resource.MeshResource,
        pos: Vector3, mat: PhysicallyBasedMaterial, track: Boolean = false,
    ) {
        val e = Entity()
        e.setName(name)
        e.components.set(TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f)))
        e.components.set(ModelComponent(mesh, mat))
        parent.addChild(e)
        if (track) { entities[name] = e; materials[name] = mat }
    }

    private fun pbr(color: Color4, metallic: Float, roughness: Float, emissive: Color4? = null) =
        PhysicallyBasedMaterial.create().apply {
            setBaseColor(color); setMetallic(metallic); setRoughness(roughness)
            if (emissive != null) setEmissiveColor(emissive)
        }

    /** Install the ${theme} stage around the content root. Main-thread (SpatialView.initial). */
    fun install(content: Entity) {
        runCatching {
            // dim IBL so emissives + colored lights read (the dim-IBL rule)
            content.components.set(EnvironmentLightingSettingsComponent(${T.ibl}f))
            // key light (shadowed) — grounds the props
            val key = Entity()
            key.setName("DressKey")
            key.components.set(
                TransformComponent(Vector3(0f, 4f, 0f), Quat.identity(), Vector3(1f, 1f, 1f))
                    .setEulerAngles(EulerAngles(52f, -30f, 0f))
            )
            val keyLight = DirectionalLightComponent(${C4(T.keyColor)}, ${T.keyLux}f)
            keyLight.castsShadowEnabled = true
            keyLight.shadowProjectionType = ShadowProjectionType.Auto(8f)
            key.components.set(keyLight)
            content.addChild(key)
${pointsKt}
            // floor — glossy PBR slab
            prop(content, "DressFloor", MeshResource.createBox(Vector3(${S}f, 0.06f, ${S}f)),
                Vector3(0f, -0.03f, 0f), pbr(${C4(T.floor.color)}, ${T.floor.metallic}f, ${T.floor.roughness}f))
            // perimeter emissive trim (alternating ${theme} colors)
            val trimA = pbr(${C4(T.trimA)}, 0.1f, 0.4f, ${C4(T.trimA)})
            val trimB = pbr(${C4(T.trimB)}, 0.1f, 0.4f, ${C4(T.trimB)})
            prop(content, "TrimN", MeshResource.createBox(Vector3(${(S - 0.5).toFixed(1)}f, 0.07f, 0.12f)), Vector3(0f, 0.05f, -${half}f), trimA)
            prop(content, "TrimS", MeshResource.createBox(Vector3(${(S - 0.5).toFixed(1)}f, 0.07f, 0.12f)), Vector3(0f, 0.05f, ${half}f), trimB)
            prop(content, "TrimE", MeshResource.createBox(Vector3(0.12f, 0.07f, ${(S - 0.5).toFixed(1)}f)), Vector3(${half}f, 0.05f, 0f), trimA)
            prop(content, "TrimW", MeshResource.createBox(Vector3(0.12f, 0.07f, ${(S - 0.5).toFixed(1)}f)), Vector3(-${half}f, 0.05f, 0f), trimB)
            // lane chevrons — emissive floor accents leading to the pins (alternating colors)
            for (i in 0 until 5) {
                val zPos = 0.6f - i * 0.7f
                prop(content, "Chev$i", MeshResource.createBox(Vector3(0.5f - i * 0.05f, 0.05f, 0.16f)),
                    Vector3(0f, 0.05f, zPos), if (i % 2 == 0) trimA else trimB)
            }
            // backdrop dot band — small emissive squares across the wall (arcade marquee dots)
            for (i in 0 until 9) {
                val xPos = -3.2f + i * 0.8f
                prop(content, "Dot$i", MeshResource.createBox(Vector3(0.16f, 0.16f, 0.1f)),
                    Vector3(xPos, 2.45f, -${(half - 0.1).toFixed(2)}f), if (i % 2 == 0) trimB else trimA)
            }
            // corner pillars + glowing caps (caps tracked for SceneTimeline pulses)
            val pillarMat = pbr(${C4(T.pillar)}, 0.25f, 0.35f)
            val corners = listOf(
                Triple("NE", ${pil}f, -${pil}f), Triple("NW", -${pil}f, -${pil}f),
                Triple("SE", ${pil}f, ${pil}f), Triple("SW", -${pil}f, ${pil}f),
            )
            for ((tag, px, pz) in corners) {
                prop(content, "Pillar$tag", MeshResource.createBox(Vector3(0.16f, 2.3f, 0.16f)), Vector3(px, 1.15f, pz), pillarMat)
                val capMat = pbr(${C4(T.trimA)}, 0.1f, 0.3f, if (tag == "NE" || tag == "SW") ${C4(T.trimA)} else ${C4(T.trimB)})
                prop(content, "cap$tag", MeshResource.createBox(Vector3(0.26f, 0.10f, 0.26f)), Vector3(px, 2.36f, pz), capMat, track = true)
            }
            // backdrop wall (-z side, behind the content): closes the frame so the surround isn't void
            prop(content, "Backdrop", MeshResource.createBox(Vector3(${S}f, 3.4f, 0.12f)),
                Vector3(0f, 1.7f, -${half}f), pbr(Color4(0.14f, 0.14f, 0.18f, 1f), 0.15f, 0.55f))
            // horizontal neon pinstripes across the backdrop (the classic alley glow lines)
            prop(content, "Stripe1", MeshResource.createBox(Vector3(${(S - 0.8).toFixed(1)}f, 0.06f, 0.14f)), Vector3(0f, 1.15f, -${(half - 0.08).toFixed(2)}f), trimA)
            prop(content, "Stripe2", MeshResource.createBox(Vector3(${(S - 0.8).toFixed(1)}f, 0.06f, 0.14f)), Vector3(0f, 1.85f, -${(half - 0.08).toFixed(2)}f), trimB)
${marquee ? `            // marquee sign bar (tracked — bob/pulse it with SceneTimeline)
            prop(content, "marquee", MeshResource.createBox(Vector3(2.6f, 0.35f, 0.08f)),
                Vector3(0f, 2.7f, -${(half - 0.2).toFixed(1)}f), pbr(${C4(T.marquee)}, 0.15f, 0.3f, ${C4(T.marquee)}), track = true)
` : ""}            Log.i(TAG, "installed theme=${theme} size=${S} props=" + entities.size)
        }.onFailure { Log.e(TAG, "install failed: " + it.message, it) }
    }
}
`;
      return okJson({
        kotlin: kt,
        callSnippet: "SetDressing.install(sceneRoot)   // in SpatialView.initial, Dispatchers.Main — replaces a bright SceneLighting.apply",
        animatables: [...(marquee ? ["marquee"] : []), "capNE", "capNW", "capSE", "capSW"],
        note: `Write to content/SetDressing.kt. Theme=${theme}: dim IBL ${T.ibl} + ${T.keyLux}-lux shadowed key + ${T.points.length} colored point light(s) + emissive trim/caps${marquee ? " + marquee" : ""}. Pair with generate_animation_timeline (bind the animatables) for living neon. Capture + fidelity_score + LOOK to verify.`,
      });
    },
  );
}
