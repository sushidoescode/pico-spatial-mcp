import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";
import { bakeTexturedModel } from "./bundle.js";

const run = promisify(execFile);
const BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender";

/**
 * signageboard.ts — the COMBINED lever: a signage PNG -> an in-world BAKED, EMISSIVE textured plane.
 *
 * Geometry (set dressing) gives the space; TEXTURE gives edgeDetail + real text. This fuses them:
 * takes a generate_signage_texture PNG, builds an emissive plane GLB at the PNG's aspect (headless
 * Blender), bakes it to a spatialbundle (bakeTexturedModel — the only textured path; raw GLB renders
 * black), and emits a SignageBoard loader that places it at a world position/size on the backdrop.
 * The baked plane carries real crisp TEXT (STRIKE!, LANE 1 scoreboard) + fine detail the native SDK
 * can't draw at runtime — the move that breaks the alley into the AAA fidelity band.
 */
export function registerSignageBoardTools(server: McpServer) {
  server.registerTool(
    "bake_signage_board",
    {
      description:
        "Bake a signage PNG into an in-world EMISSIVE textured plane (the combined geometry+texture lever). Takes a generate_signage_texture PNG, builds an emissive plane GLB at the image aspect (headless Blender), bakes it to a spatialbundle (the only textured path — raw GLB renders black), and emits SignageBoard<id>.kt that loads + places it at a world position/width on the backdrop. Real crisp TEXT + fine detail in-world (edgeDetail the native SDK can't draw at runtime). RETURNS JSON {bundle, modelName, kotlin, callSnippet, assetName}. Needs ImageMagick output + Blender + the spatialbundle toolchain. Copy the bundle into app/src/main/assets/ and call SignageBoard<id>.load(sceneRoot) in SpatialView.initial.",
      inputSchema: {
        pngPath: z.string().describe("The signage PNG (from generate_signage_texture)."),
        outBundle: z.string().describe("Output .bundle path (copy into app/src/main/assets/)."),
        id: z.string().describe("Unique id for the emitted loader class + entity name, e.g. 'Marquee' or 'Scoreboard'."),
        packageName: z.string().describe("Kotlin package for the loader, e.g. com.demo.bowldeck.content"),
        worldWidth: z.number().optional().describe("Board width in meters (default 2.6; height derived from PNG aspect)."),
        position: z.tuple([z.number(), z.number(), z.number()]).optional().describe("World position [x,y,z] (default [0,2.4,-4.3] — on the backdrop)."),
        rotationYDeg: z.number().optional().describe("Yaw degrees (default 0 = facing +z/the viewer)."),
        emissiveStrength: z.number().optional().describe("Emission multiplier for the neon glow (default 1.4)."),
      },
    },
    async ({ pngPath, outBundle, id, packageName, worldWidth, position, rotationYDeg, emissiveStrength }) => {
      if (!fs.existsSync(pngPath)) return okJson({ status: "error", error: `png not found: ${pngPath}` });
      if (!fs.existsSync(BLENDER)) return okJson({ status: "error", error: "Blender not found at " + BLENDER });
      // aspect from the PNG (via ImageMagick identify through Blender's loaded image, but simplest: read w/h with magick)
      let aspectHW = 0.5; // height/width fallback (2:1)
      try {
        const r = await run("magick", ["identify", "-format", "%w %h", pngPath], { timeout: 20_000 });
        const [w, h] = r.stdout.trim().split(/\s+/).map(Number);
        if (w > 0 && h > 0) aspectHW = h / w;
      } catch { /* fallback */ }
      const W = worldWidth ?? 2.6;
      const H = +(W * aspectHW).toFixed(3);
      const pos = position ?? [0, 2.4, -4.3];
      const yaw = rotationYDeg ?? 0;
      const emis = emissiveStrength ?? 1.4;

      const work = fs.mkdtempSync(path.join(os.tmpdir(), "signboard-"));
      const glb = path.join(work, `${id}.glb`);
      // vertical emissive plane at the PNG aspect (same +90°X recipe as the verified menu plane)
      const py = path.join(work, "mk.py");
      fs.writeFileSync(py, `
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.name = "${id}"
p.scale = (1.0, ${aspectHW}, 1.0)
p.rotation_euler = (1.5707963, 0, 0)
bpy.ops.object.transform_apply(scale=True, rotation=True)
mat = bpy.data.materials.new("sign"); mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load("${pngPath}")
links = mat.node_tree.links
links.new(bsdf.inputs["Base Color"], tex.outputs["Color"])
if "Emission Color" in bsdf.inputs:
    links.new(bsdf.inputs["Emission Color"], tex.outputs["Color"])
    try: bsdf.inputs["Emission Strength"].default_value = ${emis}
    except Exception: pass
elif "Emission" in bsdf.inputs:
    links.new(bsdf.inputs["Emission"], tex.outputs["Color"])
p.data.materials.append(mat)
bpy.ops.export_scene.gltf(filepath="${glb}", export_format="GLB")
`);
      try {
        await run(BLENDER, ["-b", "-P", py], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      } catch (e: any) {
        return okJson({ status: "error", error: "Blender failed: " + String(e?.stderr ?? e?.message ?? e).slice(0, 300) });
      }
      if (!fs.existsSync(glb)) return okJson({ status: "error", error: "Blender did not produce the GLB" });

      const baked = await bakeTexturedModel({ modelPath: glb, outBundle });
      const modelName = baked?.modelName ?? id;
      const assetName = path.basename(outBundle);
      const kotlin = `package ${packageName}

import android.util.Log
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.ecs.resource.AssetBundle
import com.pico.spatial.core.math.EulerAngles
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Generated by bake_signage_board — an in-world BAKED emissive signage plane (real text + detail).
 * Ship ${assetName} in app/src/main/assets/. Call SignageBoard${id}.load(sceneRoot) from
 * SpatialView.initial (a coroutine). Baked (spatialbundle) so the texture RENDERS (raw GLB is black).
 */
object SignageBoard${id} {
    private const val TAG = "SignageBoard${id}"
    private const val BUNDLE = "asset://${assetName}"
    private const val MODEL = ${JSON.stringify(modelName)}

    suspend fun load(parent: Entity) {
        runCatching {
            val bundle = withContext(Dispatchers.IO) { AssetBundle.load(BUNDLE) }
            val e = Entity.loadSuspend(MODEL, bundle)
            withContext(Dispatchers.Main) {
                e.setName("Sign${id}")
                val tc = TransformComponent(
                    Vector3(${pos[0]}f, ${pos[1]}f, ${pos[2]}f), Quat.identity(),
                    Vector3(${W}f, ${W}f, ${W}f)   // plane is unit-width; scale to worldWidth (aspect baked into mesh)
                )
                ${yaw ? `tc.setEulerAngles(EulerAngles(0f, ${yaw}f, 0f))` : `// no yaw`}
                e.components.set(tc)
                parent.addChild(e)
                Log.i(TAG, "signage board ${id} attached (w=${W} h=${H})")
            }
        }.onFailure { Log.e(TAG, "load failed: " + it.message, it) }
    }
}
`;
      return okJson({
        status: baked?.status === "error" ? "error" : "ok",
        bundle: outBundle, modelName, assetName, glb,
        worldSize: [W, H],
        kotlin,
        callSnippet: `SignageBoard${id}.load(sceneRoot)   // in SpatialView.initial (suspend)`,
        bake: baked,
        note: `Copy ${assetName} into app/src/main/assets/. Write kotlin to content/SignageBoard${id}.kt. Baked emissive plane: real text + fine detail in-world (the edgeDetail lever, in-world). Capture + fidelity_score to confirm the jump.`,
      });
    },
  );
}
