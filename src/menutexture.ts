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

/**
 * menutexture.ts — v10.7 (P6a): CUSTOM-LABELED game menus.
 *
 * Kills the "only START/PAUSE/RESUME/RESET" limitation: renders a 900x680 panel texture with
 * DOMAIN button labels (ImageMagick), builds the vertical textured plane GLB (headless Blender),
 * and bakes it to menu.bundle (spatialbundle — the only textured path). The row LAYOUT and BAR
 * COLORS stay identical to the verified panel (rows centered at y=205/315/425/535; green/amber/
 * blue/red) so the mouse bridge's color-bar detection and GameMenu's analytical row-Y math keep
 * working unchanged — only the words change.
 */

const ROWS_Y = [205, 315, 425, 535];
const BAR_COLORS = ["#4dd96b", "#f7b82e", "#52a8f7", "#ed5757"]; // green/amber/blue/red (bridge-detectable)
const BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender";
const FONT = fs.existsSync("/System/Library/Fonts/Supplemental/Arial Bold.ttf")
  ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
  : "/System/Library/Fonts/Helvetica.ttc"; // font FILE paths — name lookups fail on some magick builds

export function registerMenuTextureTools(server: McpServer) {
  server.registerTool(
    "bake_menu_panel",
    {
      description:
        "Bake a CUSTOM-LABELED in-world game-menu panel (P6a): renders a 900x680 panel texture with YOUR four button labels (e.g. THROW/RERACK/PINS/INFO) + a title, builds the vertical textured plane GLB via headless Blender, and bakes it to a .bundle (bakeTexturedModel — the only textured path). Row layout + bar colors are IDENTICAL to the verified default panel, so the mouse bridge's color detection and generate_game_menu_kotlin's row math work unchanged — pass actions [{action:'<your1>',rowPx:205},{...,rowPx:315},{...,rowPx:425},{...,rowPx:535}] and map behavior via GameMenu.customActions. RETURNS: JSON {bundle, texture, glb, actions} — copy the bundle into app/src/main/assets/menu.bundle. Needs ImageMagick + Blender + the PICO spatialbundle toolchain.",
      inputSchema: {
        title: z.string().describe("Panel heading, e.g. 'KNOCKDOWN'."),
        labels: z.array(z.string()).length(4).describe("The four button labels top→bottom, e.g. ['THROW','RERACK','PINS','INFO']."),
        actions: z.array(z.string()).length(4).optional().describe("The four action ids for GameMenu (default: the labels lowercased)."),
        outBundle: z.string().describe("Output .bundle path (copy/point it at app/src/main/assets/menu.bundle)."),
      },
    },
    async ({ title, labels, actions, outBundle }) => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "menupanel-"));
      const png = path.join(work, "panel.png");
      const glb = path.join(work, "menu.glb");
      const acts = actions ?? labels.map((l) => l.toLowerCase().replace(/[^a-z0-9]+/g, "_"));

      // 1) the texture — same geometry as the verified panel, custom words
      const args = [
        "-size", "900x680", "canvas:#131b3a",
        // title
        "-fill", "#dfe7ff", "-font", FONT, "-pointsize", "54",
        "-gravity", "north", "-annotate", "+0+52", title.toUpperCase(),
        // footer hint
        "-fill", "#7c88ad", "-pointsize", "22", "-gravity", "south", "-annotate", "+0+26", "gaze / controller to select",
      ];
      labels.forEach((_label, i) => {
        const yc = ROWS_Y[i];
        args.push("-fill", BAR_COLORS[i], "-draw", `roundrectangle 90,${yc - 40} 810,${yc + 40} 18,18`);
      });
      await run("magick", [...args, png], { timeout: 60_000 });
      // label text pass (separate so gravity math stays simple: center each label on its bar)
      for (let i = 0; i < 4; i++) {
        await run("magick", [png, "-fill", "#10203a", "-font", FONT, "-pointsize", "40", "-gravity", "north", "-annotate", `+0+${ROWS_Y[i] - 22}`, labels[i].toUpperCase(), png], { timeout: 60_000 });
      }

      // 2) the vertical textured plane GLB (the verified menu recipe: a +90°X-rotated plane, 900:680 aspect)
      const py = path.join(work, "mk.py");
      fs.writeFileSync(py, `
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.name = "menu"
p.scale = (1.0, 680/900, 1.0)
p.rotation_euler = (1.5707963, 0, 0)
bpy.ops.object.transform_apply(scale=True, rotation=True)
mat = bpy.data.materials.new("panel"); mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load("${png}")
mat.node_tree.links.new(bsdf.inputs["Base Color"], tex.outputs["Color"])
mat.node_tree.links.new(bsdf.inputs["Emission Color"], tex.outputs["Color"]) if "Emission Color" in bsdf.inputs else None
p.data.materials.append(mat)
bpy.ops.export_scene.gltf(filepath="${glb}", export_format="GLB")
`);
      await run(BLENDER, ["-b", "-P", py], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      if (!fs.existsSync(glb)) return okJson({ status: "error", error: "Blender did not produce the GLB (check Blender install)" });

      // 3) bake (the only textured path)
      const baked = await bakeTexturedModel({ modelPath: glb, outBundle });
      return okJson({
        status: "ok",
        bundle: outBundle,
        texture: png,
        glb,
        actions: acts.map((a, i) => ({ action: a, rowPx: ROWS_Y[i], label: labels[i] })),
        wireUp: "Copy the bundle to app/src/main/assets/menu.bundle; generate_game_menu_kotlin with these actions; map each via GameMenu.customActions. The mouse bridge detects the same color bars.",
        bake: baked?.status ?? baked,
      });
    },
  );
}
