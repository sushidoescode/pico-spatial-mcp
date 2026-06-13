import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, okJson, run } from "./util.js";

/**
 * The WORLD-MODEL / ASSET pipeline (v1.7). Auto-detects what an incoming asset
 * actually IS (360 image, textured mesh, untextured collider, or Gaussian splat)
 * and routes it onto the path that actually RENDERS in the PICO USD runtime:
 *
 *   - A 360 equirectangular image -> skybox (the BEST visual path: surrounds the
 *     user everywhere and fixes "falling out" of a finite room).
 *   - A textured GLB -> imported, but MESH textures render BLACK in this runtime,
 *     so we warn and recommend converting the texture to a 360 skybox instead.
 *   - An untextured collider GLB -> optionally pano-projected to a textured GLB
 *     via headless Blender (still subject to the GLB-renders-black caveat), else
 *     imported as a dark collider.
 *   - A Gaussian splat (.spz/.ply) -> NOT loadable (needs a splat renderer);
 *     guidance to export a 360 pano or textured mesh instead.
 *
 * All chosen assets are copied into <projectDir>/Sources/Assets and the exact
 * `environment` object to pass to compose_inspection_scene is returned.
 */

const BLENDER_BIN = "/Applications/Blender.app/Contents/MacOS/Blender";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".exr", ".hdr"]);
const IBL_EXTS = new Set([".exr", ".hdr"]);
const GLB_EXTS = new Set([".glb", ".gltf"]);
const SPLAT_EXTS = new Set([".spz", ".ply"]);

interface GltfInspection {
  materials: number;
  textures: number;
  images: number;
  hasTexcoord0: boolean;
  parsed: boolean;
  note: string;
}

/**
 * Inline glTF header parse. For a binary .glb: 12-byte header
 * (magic 'glTF', uint32 version, uint32 total length), then a chunk header
 * (uint32 chunkLength + uint32 chunkType) followed by the JSON chunk. For a
 * text .gltf the whole file is JSON. We count materials/textures/images and
 * check whether any mesh primitive declares a TEXCOORD_0 attribute (UVs) —
 * the signal that the mesh is genuinely textured vs. a bare collider.
 */
function inspectGltf(file: string): GltfInspection {
  const empty: GltfInspection = { materials: 0, textures: 0, images: 0, hasTexcoord0: false, parsed: false, note: "" };
  try {
    let json: any;
    if (path.extname(file).toLowerCase() === ".gltf") {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } else {
      const buf = fs.readFileSync(file);
      if (buf.length < 20) return { ...empty, note: "file too small to be a valid GLB" };
      const magic = buf.toString("ascii", 0, 4);
      if (magic !== "glTF") return { ...empty, note: `bad GLB magic '${magic}' (expected 'glTF')` };
      // 12-byte header: magic(4) version(4) length(4); first chunk header at offset 12.
      const chunkLength = buf.readUInt32LE(12);
      const chunkType = buf.readUInt32LE(16); // 0x4E4F534A = 'JSON'
      if (chunkType !== 0x4e4f534a) return { ...empty, note: "first GLB chunk is not JSON" };
      const jsonEnd = 20 + chunkLength;
      const jsonStr = buf.toString("utf8", 20, Math.min(jsonEnd, buf.length));
      json = JSON.parse(jsonStr);
    }
    const materials = Array.isArray(json.materials) ? json.materials.length : 0;
    const textures = Array.isArray(json.textures) ? json.textures.length : 0;
    const images = Array.isArray(json.images) ? json.images.length : 0;
    let hasTexcoord0 = false;
    if (Array.isArray(json.meshes)) {
      for (const mesh of json.meshes) {
        const prims = Array.isArray(mesh?.primitives) ? mesh.primitives : [];
        for (const prim of prims) {
          if (prim?.attributes && Object.prototype.hasOwnProperty.call(prim.attributes, "TEXCOORD_0")) {
            hasTexcoord0 = true;
          }
        }
      }
    }
    return { materials, textures, images, hasTexcoord0, parsed: true, note: "parsed glTF header" };
  } catch (e: any) {
    return { ...empty, note: `failed to parse glTF: ${e?.message ?? String(e)}` };
  }
}

function assetsDirOf(projectDir: string): string {
  return path.join(expandHome(projectDir), "Sources", "Assets");
}

function copyToAssets(src: string, projectDir: string): { dest: string; file: string; sizeMB: number } {
  const dir = assetsDirOf(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.basename(src);
  const dest = path.join(dir, file);
  fs.copyFileSync(src, dest);
  return { dest, file, sizeMB: Number((fs.statSync(dest).size / 1024 / 1024).toFixed(2)) };
}

/**
 * Generate a Blender python script that imports an untextured GLB, projects an
 * equirectangular panorama onto it (per-vertex direction from the mesh centroid:
 * u = 0.5 + atan2(d.x, -d.z)/2π, v = 0.5 + asin(clamp(d.y,-1,1))/π), wires the
 * pano in as both Base Color and Emission (strength ~0.85 so it reads bright
 * without scene lighting), and exports a textured GLB.
 */
function blenderProjectionScript(glbIn: string, pano: string, glbOut: string): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `import bpy, math
from mathutils import Vector

GLB_IN = "${esc(glbIn)}"
PANO = "${esc(pano)}"
GLB_OUT = "${esc(glbOut)}"

# Clean slate.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB_IN)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise SystemExit("no mesh in glb")

img = bpy.data.images.load(PANO)

for obj in meshes:
    me = obj.data
    # Mesh centroid in local space.
    if len(me.vertices) == 0:
        continue
    cx = sum(v.co.x for v in me.vertices) / len(me.vertices)
    cy = sum(v.co.y for v in me.vertices) / len(me.vertices)
    cz = sum(v.co.z for v in me.vertices) / len(me.vertices)
    centroid = Vector((cx, cy, cz))

    uv_layer = me.uv_layers.new(name="EquirectProj") if not me.uv_layers else me.uv_layers.active
    me.uv_layers.active = uv_layer

    for loop in me.loops:
        v = me.vertices[loop.vertex_index].co
        d = (v - centroid)
        n = d.length
        if n == 0.0:
            uv_layer.data[loop.index].uv = (0.5, 0.5)
            continue
        d = d / n
        u = 0.5 + math.atan2(d.x, -d.z) / (2.0 * math.pi)
        yy = max(-1.0, min(1.0, d.y))
        vv = 0.5 + math.asin(yy) / math.pi
        uv_layer.data[loop.index].uv = (u, vv)

    # Principled BSDF material with the pano as Base Color + Emission.
    mat = bpy.data.materials.new(name="EquirectProjected")
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    # Emission slots differ across Blender versions; set whichever exists.
    if "Emission Color" in bsdf.inputs:
        links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    elif "Emission" in bsdf.inputs:
        links.new(tex.outputs["Color"], bsdf.inputs["Emission"])
    if "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = 0.85
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)

bpy.ops.export_scene.gltf(filepath=GLB_OUT, export_format='GLB')
print("PROJECTION_DONE", GLB_OUT)
`;
}

export function registerAssetTools(server: McpServer) {
  server.registerTool(
    "prepare_environment",
    {
      description:
        "Auto-detect an incoming environment asset (360 image / textured GLB / untextured collider GLB / Gaussian splat) and route it onto the path that actually RENDERS in the PICO USD runtime. Parses GLB glTF headers inline (counts materials/textures/images + checks for TEXCOORD_0 UVs) to tell a textured mesh from a bare collider. A 360 equirectangular image becomes a SKYBOX (the best visual path — surrounds the user, fixes falling out). A textured GLB is imported with a warning that MESH textures render BLACK in this runtime (prefer a 360 skybox). An untextured collider can be pano-PROJECTED to a textured GLB via headless Blender (still GLB-black-caveated) when Blender + a panorama are available, else imported as a dark collider. Gaussian splats (.spz/.ply) are NOT loadable (need a splat renderer). Copies the chosen asset(s) into Sources/Assets and returns the exact `environment` object to pass to compose_inspection_scene.",
      inputSchema: {
        sourcePath: z.string().describe("Absolute path to the asset (.png/.jpg/.jpeg/.exr/.hdr 360 image, .glb/.gltf mesh, or .spz/.ply splat)"),
        projectDir: z.string().describe("The spatial app project dir (asset is copied into <projectDir>/Sources/Assets)"),
        skySphere: z
          .string()
          .optional()
          .describe("Optional: a panorama image (abs path or a filename already in Sources/Assets) to project onto an untextured collider GLB via Blender"),
      },
    },
    async ({ sourcePath, projectDir, skySphere }) => {
      const src = expandHome(sourcePath);
      if (!fs.existsSync(src)) return fail(`No such file: ${src}`);
      const ext = path.extname(src).toLowerCase();
      const caveats: string[] = [];

      // ---- 360 image -> skybox (the best path) ----
      if (IMAGE_EXTS.has(ext)) {
        const { file, sizeMB } = copyToAssets(src, projectDir);
        const isIbl = IBL_EXTS.has(ext);
        if (isIbl) {
          caveats.push(
            `.${ext.slice(1)} is also usable as IBL (compose_inspection_scene ibl='${file}') for environment lighting; as a skybox it provides the full surround.`,
          );
        }
        const recommendedCompose = { type: "skybox" as const, asset: file };
        return okJson({
          detectedType: isIbl ? "equirectangular image (skybox + IBL-capable)" : "equirectangular 360 image (skybox)",
          action: `Copied '${file}' (${sizeMB} MB) into Sources/Assets as a 360 skybox.`,
          recommendedCompose,
          rationale:
            "A 360 skybox is the BEST visual path: it surrounds the user everywhere and fixes 'falling out' of a finite room. Authored image materials don't pack here, so compose_inspection_scene overrides a working sky-sphere mesh's texture node with this image.",
          caveats,
        });
      }

      // ---- Gaussian splat -> not loadable ----
      if (SPLAT_EXTS.has(ext)) {
        return okJson({
          detectedType: "Gaussian splat",
          action: "NOT imported.",
          recommendedCompose: null,
          rationale:
            "Gaussian splats (.spz/.ply) are NOT natively loadable by the PICO USD runtime — they need a dedicated splat renderer (e.g. Spark.js), which the emulator/runtime does not provide.",
          caveats: [
            "Export a 360 equirectangular panorama from the splat capture and run prepare_environment on that (type:'skybox') — the working visual path.",
            "Or export a TEXTURED mesh; note GLB MESH textures still render BLACK in this runtime, so a skybox is preferred.",
          ],
        });
      }

      // ---- GLB / glTF ----
      if (GLB_EXTS.has(ext)) {
        const insp = inspectGltf(src);
        const textured = insp.parsed && insp.images > 0 && insp.hasTexcoord0;

        if (!insp.parsed) {
          caveats.push(`Could not parse the glTF header (${insp.note}); treating as a mesh.`);
        }

        // Textured GLB -> import + warn it renders black.
        if (textured) {
          const { file, sizeMB } = copyToAssets(src, projectDir);
          caveats.push("GLB/USDZ MESH textures render BLACK in this runtime — the textured surface will NOT show.");
          caveats.push("Recommended instead: convert this mesh's texture to a 360 equirectangular skybox, or run on a real headset where mesh textures render.");
          return okJson({
            detectedType: "textured GLB mesh",
            gltf: insp,
            action: `Copied '${file}' (${sizeMB} MB) into Sources/Assets.`,
            recommendedCompose: { type: "glb" as const, asset: file },
            rationale:
              "Imported as a referenced environment mesh. It has bound image textures (images>0 and TEXCOORD_0 UVs present) but those render BLACK in the PICO runtime.",
            caveats,
          });
        }

        // Untextured collider GLB.
        const blenderAvailable = fs.existsSync(BLENDER_BIN);
        let pano: string | null = null;
        if (skySphere) {
          const cand = expandHome(skySphere);
          if (fs.existsSync(cand)) pano = cand;
          else {
            const inAssets = path.join(assetsDirOf(projectDir), skySphere);
            if (fs.existsSync(inAssets)) pano = inAssets;
          }
        }

        // Offer projection when Blender + a panorama are both available.
        if (blenderAvailable && pano) {
          const stem = path.basename(src, path.extname(src));
          const outName = `${stem}.projected.glb`;
          const assetsDir = assetsDirOf(projectDir);
          fs.mkdirSync(assetsDir, { recursive: true });
          const outGlb = path.join(assetsDir, outName);
          const scriptPath = path.join(os.tmpdir(), `pico_project_${Date.now()}.py`);
          fs.writeFileSync(scriptPath, blenderProjectionScript(src, pano, outGlb));

          const r = await run(BLENDER_BIN, ["--background", "--python", scriptPath], { timeoutMs: 300_000 });
          try {
            fs.unlinkSync(scriptPath);
          } catch {
            /* best-effort cleanup */
          }

          if ((r.code !== 0 && !r.stdout.includes("PROJECTION_DONE")) || !fs.existsSync(outGlb)) {
            // Projection failed — fall back to importing the untextured collider.
            const { file, sizeMB } = copyToAssets(src, projectDir);
            caveats.push(`Blender projection failed (exit ${r.code}); imported the untextured collider instead.`);
            caveats.push("It will render DARK (no texture). Provide/convert a 360 panorama (type:'skybox') for the best visual.");
            return okJson({
              detectedType: "untextured collider GLB (projection failed)",
              gltf: insp,
              action: `Copied '${file}' (${sizeMB} MB) into Sources/Assets (projection attempt failed).`,
              recommendedCompose: { type: "glb" as const, asset: file },
              rationale: "Projection via headless Blender did not produce a textured GLB; using the untextured collider as a fallback.",
              blenderStderrTail: r.stderr.trim().slice(-600) || undefined,
              caveats,
            });
          }

          const sizeMB = Number((fs.statSync(outGlb).size / 1024 / 1024).toFixed(2));
          caveats.push("GLB/USDZ MESH textures render BLACK in this runtime — even the projected texture will NOT show in the emulator (use a 360 skybox, or a real headset).");
          return okJson({
            detectedType: "untextured collider GLB (pano-projected)",
            gltf: insp,
            action: `Projected the panorama '${path.basename(pano)}' onto the collider via headless Blender and exported '${outName}' (${sizeMB} MB) into Sources/Assets.`,
            recommendedCompose: { type: "glb" as const, asset: outName },
            rationale:
              "Built equirectangular UVs by projecting each vertex direction from the mesh centroid (u=0.5+atan2(d.x,-d.z)/2π, v=0.5+asin(clamp(d.y,-1,1))/π) and wired the panorama as Principled Base Color + Emission (~0.85).",
            caveats,
          });
        }

        // No projection possible — import the bare collider.
        const { file, sizeMB } = copyToAssets(src, projectDir);
        if (!blenderAvailable && skySphere) caveats.push(`Blender not found at ${BLENDER_BIN}; cannot pano-project — imported the untextured collider.`);
        if (!skySphere) caveats.push("No panorama provided (skySphere) — imported the untextured collider; pass a 360 image as skySphere to project a texture, or use type:'skybox' for the best visual.");
        caveats.push("It will render DARK (an untextured collider mesh has no surface color).");
        return okJson({
          detectedType: "untextured collider GLB",
          gltf: insp,
          action: `Copied '${file}' (${sizeMB} MB) into Sources/Assets.`,
          recommendedCompose: { type: "glb" as const, asset: file },
          rationale: "Imported as a referenced collider mesh; it has no textures (images==0 / no TEXCOORD_0), so it renders dark.",
          caveats,
        });
      }

      return fail(
        `Unsupported asset type '${ext}'. Supported: ${[...IMAGE_EXTS, ...GLB_EXTS, ...SPLAT_EXTS].join(", ")} (360 image / GLB mesh / Gaussian splat).`,
      );
    },
  );

  server.registerTool(
    "list_environment_assets",
    {
      description:
        "List the entries in <projectDir>/Sources/Assets with a detected type + a one-line note (skybox-ready image / textured mesh / collider / splat / ibl) to help an agent pick the right environment.asset for compose_inspection_scene. GLBs are header-parsed (textures + TEXCOORD_0) to distinguish textured meshes from bare colliders.",
      inputSchema: {
        projectDir: z.string().describe("The spatial app project dir whose Sources/Assets is listed"),
      },
    },
    async ({ projectDir }) => {
      const dir = assetsDirOf(projectDir);
      if (!fs.existsSync(dir)) return okJson({ assetsDir: dir, exists: false, assets: [] });

      const entries: Array<{ file: string; type: string; note: string; sizeMB: number }> = [];
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        const ext = path.extname(name).toLowerCase();
        const sizeMB = Number((stat.size / 1024 / 1024).toFixed(2));

        let type = "other";
        let note = "unrecognized asset";
        if (IBL_EXTS.has(ext)) {
          type = "ibl";
          note = "equirectangular HDR — skybox-ready and usable as IBL (environment lighting)";
        } else if (IMAGE_EXTS.has(ext)) {
          type = "skybox";
          note = "skybox-ready 360 image (the best visual path — surrounds the user)";
        } else if (SPLAT_EXTS.has(ext)) {
          type = "splat";
          note = "Gaussian splat — NOT loadable by the runtime (export a 360 pano or textured mesh)";
        } else if (GLB_EXTS.has(ext)) {
          const insp = inspectGltf(full);
          if (insp.parsed && insp.images > 0 && insp.hasTexcoord0) {
            type = "textured mesh";
            note = `textured GLB (images=${insp.images}, has UVs) — NOTE: mesh textures render BLACK in this runtime`;
          } else {
            type = "collider";
            note = insp.parsed
              ? `untextured collider GLB (images=${insp.images}, texcoord0=${insp.hasTexcoord0}) — renders dark`
              : `GLB (unparsed: ${insp.note})`;
          }
        } else if ([".usdz", ".usd", ".usda", ".usdc"].includes(ext)) {
          type = "usd";
          note = name.toLowerCase().includes("sky") ? "USD sky-sphere candidate (skybox texture-override target)" : "referenced USD mesh";
        }

        entries.push({ file: name, type, note, sizeMB });
      }

      return okJson({ assetsDir: dir, exists: true, count: entries.length, assets: entries });
    },
  );
}
