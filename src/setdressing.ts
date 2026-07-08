import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * setdressing.ts — v13 (Q1, edgeDetail push v6): PROCEDURAL themed SET DRESSING — the anti-void kit.
 *
 * The single biggest gap between "works" and "AAA": pipeline scenes render as props floating in a
 * black void. v6 adds the GEOMETRIC-DENSITY tier the fidelity rubric demanded (edgeDetail was ~1):
 * ceiling beams + hanging neon tube fixtures (fills the black top half of the frame), torus halo
 * rings, 45° corner braces, side rails with glowing end caps, a framed marquee, floor inlays, and
 * pillar orbs — on top of the v5 floor/trim/backdrop/dot-band/chevrons/light rig. All from SDK
 * primitives verified in working code: createBox/createSphere/createCapsule/createCylinder(h,r)/
 * createTorus(outerR,innerR)/createPlane + PhysicallyBasedMaterial + ModelComponent +
 * TransformComponent(...).setEulerAngles(EulerAngles) + Directional/Point lights + dim IBL.
 * Hero entities/materials exposed via SetDressing.entities/materials for SceneTimeline binds.
 */

type Rgb = [number, number, number];
const C4 = (c: Rgb, a = 1) => `Color4(${c[0]}f, ${c[1]}f, ${c[2]}f, ${a}f)`;
const hex2rgb = (h: string): Rgb => {
  const m = h.replace("#", "");
  return [parseInt(m.slice(0, 2), 16) / 255, parseInt(m.slice(2, 4), 16) / 255, parseInt(m.slice(4, 6), 16) / 255].map((v) => +v.toFixed(3)) as Rgb;
};

type Theme = {
  floor: { color: Rgb; metallic: number; roughness: number };
  trimA: Rgb; trimB: Rgb;
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
      { color: [1, 0.18, 0.58], lm: 2600, falloff: 9, pos: [-2.2, 2.0, -3.4] },
      { color: [0.13, 0.88, 1], lm: 2600, falloff: 9, pos: [2.2, 2.0, -3.4] },
      { color: [1, 0.9, 0.95], lm: 450, falloff: 6, pos: [0, 2.6, 0.6] },
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
      { color: [0.3, 0.42, 1], lm: 2000, falloff: 8, pos: [-2.2, 2.0, -3.4] },
      { color: [0.61, 0.3, 1], lm: 2000, falloff: 8, pos: [2.2, 2.0, -3.4] },
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
        "Emit SetDressing.kt — PROCEDURAL themed SET DRESSING that kills the black void (the #1 AAA gap), v6 = the GEOMETRIC-DENSITY tier: glossy PBR floor, perimeter neon trim, backdrop wall + pinstripes + arcade dot band, lane chevrons + side dashes, corner pillars with glowing caps + torus halo rings + orbs, CEILING BEAMS with hanging neon tube fixtures (fills the top of frame), 45° corner braces, side rails with glowing end caps + posts, a framed marquee with studs, diagonal floor inlays, and a themed light rig (dim IBL + shadowed key + colored points) — ~55 props, all from verified SDK primitives (box/sphere/cylinder/torus), no assets to bake. Themes: neon/showroom/cosmic/noir. Call SetDressing.install(sceneRoot) INSTEAD of a bright SceneLighting.apply. Animate: entities/materials expose 'marquee', 'capNE..SW', 'ringNE..SW' for SceneTimeline.bind. Visual quality still requires a looked-at capture (iterate with fidelity_score; profile dark-theme for neon/noir/cosmic). RETURNS JSON {kotlin, callSnippet, animatables, note}.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.demo.bowldeck.content"),
        theme: z.enum(["neon", "showroom", "cosmic", "noir"]).describe("Visual theme."),
        size: z.number().min(6).max(16).optional().describe("Stage footprint in meters (default 9)."),
        withMarquee: z.boolean().optional().describe("Include the framed marquee sign bar (default true)."),
        withCeiling: z.boolean().optional().describe("Include ceiling beams + hanging fixtures (default true — fills the top of frame)."),
        density: z.enum(["lite", "standard", "rich"]).optional().describe("Visual-richness vs draw-call budget. 'rich' (~90 props: + side dashes, inlays, orbs, braces, rails, 4th ceiling beam, 9-dot band) is the full AAA dressing for on-device/hardware; 'standard' (~52, DEFAULT) trims to the highest-impact set; 'lite' (~30) for perf-constrained targets. NOTE: a startup FocusEvent ANR observed on the emulator was proven ENVIRONMENTAL (bisect: the bare app with NO dressing ANRs identically) — a degraded emulator focus subsystem after a long session, NOT caused by density; remedy is a cold emulator restart (see diagnose emu_focus_wedge). install() is SUSPEND (yields the main thread during the build) regardless, which is correct for large builds on real hardware."),
      },
    },
    async ({ packageName, theme, size, withMarquee, withCeiling, density }) => {
      const T = THEMES[theme];
      const S = size ?? 9;
      const half = +(S / 2).toFixed(2);
      const pil = +(half - 0.3).toFixed(2);
      const marquee = withMarquee !== false;
      const dens = density ?? "standard";
      const rich = dens === "rich";
      const std = dens === "standard" || rich;      // standard-and-up
      const ceiling = withCeiling !== false && std;  // ceiling only on standard+
      const nDots = rich ? 9 : 5;
      const nBeams = rich ? 4 : 3;
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Generated by generate_set_dressing (theme=${theme}, size=${S}m, v6 geometric-density tier).
 * Call SetDressing.install(sceneRoot) from SpatialView.initial (Dispatchers.Main), INSTEAD of a
 * bright SceneLighting.apply. Animatables: ${marquee ? '"marquee", ' : ""}"capNE..SW", "ringNE..SW".
 */
object SetDressing {
    private const val TAG = "SetDressing"
    private const val YIELD_EVERY = 12
    val entities = mutableMapOf<String, Entity>()
    val materials = mutableMapOf<String, PhysicallyBasedMaterial>()
    private var props = 0

    private var sinceYield = 0
    private suspend fun prop(
        parent: Entity, name: String, mesh: com.pico.spatial.core.ecs.resource.MeshResource,
        pos: Vector3, mat: PhysicallyBasedMaterial, rot: EulerAngles? = null, track: Boolean = false,
    ) {
        if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; delay(1) }  // yield: 100+ builds don't ANR
        val e = Entity()
        e.setName(name)
        val tc = TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f))
        if (rot != null) tc.setEulerAngles(rot)
        e.components.set(tc)
        e.components.set(ModelComponent(mesh, mat))
        parent.addChild(e)
        props++
        if (track) { entities[name] = e; materials[name] = mat }
    }

    private fun pbr(color: Color4, metallic: Float, roughness: Float, emissive: Color4? = null) =
        PhysicallyBasedMaterial.create().apply {
            setBaseColor(color); setMetallic(metallic); setRoughness(roughness)
            if (emissive != null) setEmissiveColor(emissive)
        }

    /** Install the ${theme} stage. SUSPEND — yields the main thread periodically so the 100+
     *  entity build never ANRs. Call from a coroutine on Dispatchers.Main (SpatialView.initial). */
    suspend fun install(content: Entity) {
        runCatching {
            content.components.set(EnvironmentLightingSettingsComponent(${T.ibl}f))
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
            val trimA = pbr(${C4(T.trimA)}, 0.1f, 0.4f, ${C4(T.trimA)})
            val trimB = pbr(${C4(T.trimB)}, 0.1f, 0.4f, ${C4(T.trimB)})
            val metal = pbr(Color4(0.16f, 0.16f, 0.2f, 1f), 0.7f, 0.3f)
            val pillarMat = pbr(${C4(T.pillar)}, 0.25f, 0.35f)

            // ── floor + perimeter trim ──
            prop(content, "DressFloor", MeshResource.createBox(Vector3(${S}f, 0.06f, ${S}f)),
                Vector3(0f, -0.03f, 0f), pbr(${C4(T.floor.color)}, ${T.floor.metallic}f, ${T.floor.roughness}f))
            prop(content, "TrimN", MeshResource.createBox(Vector3(${(S - 0.5).toFixed(1)}f, 0.07f, 0.12f)), Vector3(0f, 0.05f, -${half}f), trimA)
            prop(content, "TrimS", MeshResource.createBox(Vector3(${(S - 0.5).toFixed(1)}f, 0.07f, 0.12f)), Vector3(0f, 0.05f, ${half}f), trimB)
            prop(content, "TrimE", MeshResource.createBox(Vector3(0.12f, 0.07f, ${(S - 0.5).toFixed(1)}f)), Vector3(${half}f, 0.05f, 0f), trimA)
            prop(content, "TrimW", MeshResource.createBox(Vector3(0.12f, 0.07f, ${(S - 0.5).toFixed(1)}f)), Vector3(-${half}f, 0.05f, 0f), trimB)

            // ── backdrop + pinstripes + arcade dot band ──
            prop(content, "Backdrop", MeshResource.createBox(Vector3(${S}f, 3.4f, 0.12f)),
                Vector3(0f, 1.7f, -${half}f), pbr(Color4(0.14f, 0.14f, 0.18f, 1f), 0.15f, 0.55f))
            prop(content, "Stripe1", MeshResource.createBox(Vector3(${(S - 0.8).toFixed(1)}f, 0.06f, 0.14f)), Vector3(0f, 1.15f, -${(half - 0.08).toFixed(2)}f), trimA)
            prop(content, "Stripe2", MeshResource.createBox(Vector3(${(S - 0.8).toFixed(1)}f, 0.06f, 0.14f)), Vector3(0f, 1.85f, -${(half - 0.08).toFixed(2)}f), trimB)
            for (i in 0 until ${nDots}) {
                val xPos = -3.2f + i * ${(6.4 / (nDots - 1)).toFixed(2)}f
                prop(content, "Dot$i", MeshResource.createBox(Vector3(0.16f, 0.16f, 0.1f)),
                    Vector3(xPos, 2.45f, -${(half - 0.1).toFixed(2)}f), if (i % 2 == 0) trimB else trimA)
            }

            // ── lane chevrons${rich ? " + side dash rows" : ""} (leads the eye to the pins) ──
            for (i in 0 until 5) {
                val zPos = 0.6f - i * 0.7f
                prop(content, "Chev$i", MeshResource.createBox(Vector3(0.5f - i * 0.05f, 0.05f, 0.16f)),
                    Vector3(0f, 0.05f, zPos), if (i % 2 == 0) trimA else trimB)
${rich ? `                prop(content, "DashL$i", MeshResource.createBox(Vector3(0.16f, 0.04f, 0.05f)), Vector3(-1.3f, 0.04f, zPos), trimB)
                prop(content, "DashR$i", MeshResource.createBox(Vector3(0.16f, 0.04f, 0.05f)), Vector3(1.3f, 0.04f, zPos), trimA)
` : ""}            }
${rich ? `            // diagonal floor inlays at the corners (45-degree accents)
            for ((tag, ix, iz) in listOf(Triple("A", -1f, -1f), Triple("B", 1f, -1f), Triple("C", -1f, 1f), Triple("D", 1f, 1f))) {
                prop(content, "Inlay$tag", MeshResource.createBox(Vector3(1.1f, 0.045f, 0.09f)),
                    Vector3(ix * ${(half - 1.1).toFixed(1)}f, 0.04f, iz * ${(half - 1.1).toFixed(1)}f),
                    if (ix * iz > 0f) trimA else trimB, rot = EulerAngles(0f, 45f * ix * iz, 0f))
            }
` : ""}
            // ── corner pillars: caps${std ? " + halo rings" : ""}${rich ? " + orbs + angled braces" : ""} ──
            val corners = listOf(
                Triple("NE", ${pil}f, -${pil}f), Triple("NW", -${pil}f, -${pil}f),
                Triple("SE", ${pil}f, ${pil}f), Triple("SW", -${pil}f, ${pil}f),
            )
            for ((tag, px, pz) in corners) {
                val a = if (tag == "NE" || tag == "SW") trimA else trimB
                prop(content, "Pillar$tag", MeshResource.createBox(Vector3(0.16f, 2.3f, 0.16f)), Vector3(px, 1.15f, pz), pillarMat)
                prop(content, "cap$tag", MeshResource.createBox(Vector3(0.26f, 0.10f, 0.26f)), Vector3(px, 2.36f, pz),
                    pbr(${C4(T.trimA)}, 0.1f, 0.3f, if (tag == "NE" || tag == "SW") ${C4(T.trimA)} else ${C4(T.trimB)}), track = true)
${std ? `                prop(content, "ring$tag", MeshResource.createTorus(0.3f, 0.26f), Vector3(px, 2.62f, pz), a, rot = EulerAngles(90f, 0f, 0f), track = true)
` : ""}${rich ? `                prop(content, "orb$tag", MeshResource.createSphere(0.07f), Vector3(px, 1.5f, pz), a)
                prop(content, "Brace$tag", MeshResource.createBox(Vector3(0.9f, 0.07f, 0.07f)),
                    Vector3(px - 0.35f * (if (px > 0f) 1f else -1f), 2.62f, pz), metal,
                    rot = EulerAngles(0f, 0f, 35f * (if (px > 0f) 1f else -1f)))
` : ""}            }
${ceiling ? `
            // ── ceiling: beams + hanging neon tube fixtures (fills the top of frame) ──
            for (b in 0 until ${nBeams}) {
                val bz = 0.4f - b * 1.4f
                prop(content, "Beam$b", MeshResource.createBox(Vector3(${S}f, 0.12f, 0.22f)), Vector3(0f, 3.3f, bz), metal)
                prop(content, "TubeL$b", MeshResource.createCylinder(1.1f, 0.035f), Vector3(-1.6f, 3.05f, bz), if (b % 2 == 0) trimA else trimB, rot = EulerAngles(0f, 0f, 90f))
                prop(content, "TubeR$b", MeshResource.createCylinder(1.1f, 0.035f), Vector3(1.6f, 3.05f, bz), if (b % 2 == 0) trimB else trimA, rot = EulerAngles(0f, 0f, 90f))
            }
` : ""}${rich ? `
            // ── side rails with glowing end caps (cylinder rotated X 90 lies along Z) ──
            for ((tag, rx) in listOf("L" to -${(half - 0.45).toFixed(2)}f, "R" to ${(half - 0.45).toFixed(2)}f)) {
                for ((idx, ry) in listOf(0.5f, 0.9f).withIndex()) {
                    prop(content, "Rail$tag$idx", MeshResource.createCylinder(${(S - 1.6).toFixed(1)}f, 0.035f), Vector3(rx, ry, 0f), metal, rot = EulerAngles(90f, 0f, 0f))
                    prop(content, "RailCapN$tag$idx", MeshResource.createSphere(0.06f), Vector3(rx, ry, -${((S - 1.6) / 2).toFixed(2)}f), if (tag == "L") trimB else trimA)
                    prop(content, "RailCapS$tag$idx", MeshResource.createSphere(0.06f), Vector3(rx, ry, ${((S - 1.6) / 2).toFixed(2)}f), if (tag == "L") trimA else trimB)
                }
            }
` : ""}${marquee ? `
            // ── framed marquee sign bar (tracked — bob/pulse with SceneTimeline) ──
            prop(content, "marquee", MeshResource.createBox(Vector3(2.6f, 0.35f, 0.08f)),
                Vector3(0f, 2.7f, -${(half - 0.2).toFixed(1)}f), pbr(${C4(T.marquee)}, 0.15f, 0.3f, ${C4(T.marquee)}), track = true)
${std ? `            prop(content, "MarqTop", MeshResource.createBox(Vector3(2.8f, 0.06f, 0.1f)), Vector3(0f, 2.92f, -${(half - 0.2).toFixed(1)}f), metal)
            prop(content, "MarqBot", MeshResource.createBox(Vector3(2.8f, 0.06f, 0.1f)), Vector3(0f, 2.48f, -${(half - 0.2).toFixed(1)}f), metal)
            prop(content, "MarqL", MeshResource.createBox(Vector3(0.06f, 0.5f, 0.1f)), Vector3(-1.4f, 2.7f, -${(half - 0.2).toFixed(1)}f), metal)
            prop(content, "MarqR", MeshResource.createBox(Vector3(0.06f, 0.5f, 0.1f)), Vector3(1.4f, 2.7f, -${(half - 0.2).toFixed(1)}f), metal)
            prop(content, "StudL", MeshResource.createSphere(0.05f), Vector3(-1.45f, 2.7f, -${(half - 0.22).toFixed(2)}f), trimB)
            prop(content, "StudR", MeshResource.createSphere(0.05f), Vector3(1.45f, 2.7f, -${(half - 0.22).toFixed(2)}f), trimB)
` : ""}` : ""}
            Log.i(TAG, "installed theme=${theme} size=${S} density=${dens} props=" + props)
        }.onFailure { Log.e(TAG, "install failed: " + it.message, it) }
    }
}
`;
      return okJson({
        kotlin: kt,
        callSnippet: "SetDressing.install(sceneRoot)   // in SpatialView.initial, Dispatchers.Main — replaces a bright SceneLighting.apply",
        animatables: [...(marquee ? ["marquee"] : []), "capNE", "capNW", "capSE", "capSW", "ringNE", "ringNW", "ringSE", "ringSW"],
        note: `Write to content/SetDressing.kt. Theme=${theme}, density=${dens} (standard ~52 props = EMULATOR-STABLE; rich ~90 = hardware). Sections: floor/trim/backdrop/pinstripes/dots/chevrons/pillars+caps${std ? "/halo-rings/ceiling-beams+tubes/framed-marquee" : ""}${rich ? "/side-dashes/inlays/orbs/braces/rails" : ""}. IMPORTANT: install() is SUSPEND (yields the main thread so the build does not ANR) — call it from a coroutine on Dispatchers.Main. Pair with generate_animation_timeline (bind the animatables). Capture + fidelity_score (profile dark-theme) + LOOK.`,
      });
    },
  );
}
