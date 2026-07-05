import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, ok, okJson } from "./util.js";

/**
 * ClaimSight-style spatial inspection scenes. A higher-level builder on top of
 * the USDA grammar that assembles a legit-looking insurance-inspection app:
 * a damaged-room environment, severity-colored damage markers pinned in 3D
 * (canonical ClaimSight 5-tier palette + real IICRC/Haag damage taxonomy), and
 * an info panel. The environment can be procedural (authored here, zero deps)
 * or a referenced GLB/splat room (e.g. a World Labs Marble export) for photoreal.
 */

// Canonical ClaimSight severity palette (src/utils/constants.js).
const SEVERITY_RGB: Record<number, [number, number, number]> = {
  1: hexToRgb("#22c55e"), // minor — green
  2: hexToRgb("#eab308"), // moderate — yellow
  3: hexToRgb("#f97316"), // significant — orange
  4: hexToRgb("#ef4444"), // severe — red
  5: hexToRgb("#a855f7"), // critical — purple
};
const ACCENT_RGB = hexToRgb("#3b82f6");
const SEVERITY_LABEL: Record<number, string> = { 1: "minor", 2: "moderate", 3: "significant", 4: "severe", 5: "critical" };

// Real damage taxonomy (INSURANCE_DOMAIN_CONTEXT.md / IICRC / Haag).
const DAMAGE_TYPES = ["water", "electrical", "structural", "wind", "hail", "mold", "smoke", "fire", "impact", "plumbing"] as const;

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const lin = (c: number) => +(c / 255).toFixed(4);
  return [lin(parseInt(m.slice(0, 2), 16)), lin(parseInt(m.slice(2, 4), 16)), lin(parseInt(m.slice(4, 6), 16))];
}
function rgbStr(c: [number, number, number]): string {
  return `(${c[0]}, ${c[1]}, ${c[2]})`;
}

const damageSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  type: z.enum(DAMAGE_TYPES),
  severity: z.number().int().min(1).max(5),
  location: z.tuple([z.number(), z.number(), z.number()]).describe("[x,y,z] world position of the damage (the surface contact point), meters"),
  surface: z
    .enum(["floor", "ceiling", "wall_north", "wall_south", "wall_east", "wall_west"])
    .default("floor")
    .describe("Which surface the marker sticks to — determines its orientation (marker +Y aligns to the surface normal). The ClaimSight 'stick to any surface' behavior."),
  normal: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Explicit surface normal [x,y,z] (overrides `surface`) for arbitrary/angled surfaces"),
  note: z.string().optional().describe("Adjuster note (stored as USD documentation)"),
});
type Damage = z.infer<typeof damageSchema>;

// Surface -> inward normal (points away from the surface into the room).
const SURFACE_NORMAL: Record<string, [number, number, number]> = {
  floor: [0, 1, 0],
  ceiling: [0, -1, 0],
  wall_north: [0, 0, 1], // back wall (-z), normal points +z
  wall_south: [0, 0, -1],
  wall_east: [-1, 0, 0], // +x wall, normal points -x
  wall_west: [1, 0, 0],
};

/** Quaternion (w,x,y,z) that rotates local +Y onto the surface normal — the marker's stick-to-surface orientation. */
function quatYToNormal(n: [number, number, number]): [number, number, number, number] {
  const len = Math.hypot(...n) || 1;
  const v: [number, number, number] = [n[0] / len, n[1] / len, n[2] / len];
  const dot = v[1]; // (0,1,0)·v
  const round = (x: number) => (Math.abs(x) < 1e-6 ? 0 : +x.toFixed(6));
  if (dot > 0.99999) return [1, 0, 0, 0]; // already +Y (floor)
  if (dot < -0.99999) return [0, 1, 0, 0]; // -Y (ceiling): 180° about X
  // axis = cross((0,1,0), v) = (v.z, 0, -v.x)
  const ax = [v[2], 0, -v[0]];
  const al = Math.hypot(...ax) || 1;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  const s = Math.sin(angle / 2);
  return [round(Math.cos(angle / 2)), round((ax[0] / al) * s), round((ax[1] / al) * s), round((ax[2] / al) * s)];
}

// ---- materials (UsdPreviewSurface via MaterialX, the editor's own pattern) ----
// displayColor renders as a white UNLIT material in the PICO runtime; real colors
// require a bound Material with a ND_UsdPreviewSurface_surfaceshader shader.
// Room materials carry a low emissive term so the room reads bright without depending
// on scene lighting (which the runtime may not apply to referenced/procedural geometry).
const ROOM_MATS: Record<string, [number, number, number]> = {
  Wall: [0.86, 0.84, 0.8],
  Floor: [0.4, 0.33, 0.27],
  Ceiling: [0.9, 0.9, 0.88],
  Slate: [0.62, 0.65, 0.7],
  PanelBg: [0.06, 0.09, 0.16],
  Accent: ACCENT_RGB,
};
const ROOM_AMBIENT: Record<string, number> = { Wall: 0.35, Floor: 0.28, Ceiling: 0.38 };

function matBlock(name: string, rgb: [number, number, number], emissive: [number, number, number] = [0, 0, 0]): string {
  return [
    `        def Material "${name}"`,
    "        {",
    `            token outputs:mtlx:surface.connect = </Root/Materials/${name}/Shader.outputs:out>`,
    `            def Shader "Shader"`,
    "            {",
    `                uniform token info:id = "ND_UsdPreviewSurface_surfaceshader"`,
    `                color3f inputs:diffuseColor = ${rgbStr(rgb)} (colorSpace = "lin_srgb")`,
    `                color3f inputs:emissiveColor = ${rgbStr(emissive)} (colorSpace = "lin_srgb")`,
    `                float inputs:roughness = 0.45`,
    `                float inputs:metallic = 0`,
    `                token outputs:out`,
    "            }",
    "        }",
  ].join("\n");
}

/** An unlit (emissive) image-textured material for a skybox — the 360 pano shows full-bright. */
function skyboxMat(asset: string): string {
  return [
    `        def Material "Skybox"`,
    "        {",
    `            token outputs:mtlx:surface.connect = </Root/Materials/Skybox/Surf.outputs:out>`,
    `            def Shader "Surf"`,
    "            {",
    `                uniform token info:id = "ND_UsdPreviewSurface_surfaceshader"`,
    `                color3f inputs:diffuseColor = (0, 0, 0)`,
    `                color3f inputs:emissiveColor.connect = </Root/Materials/Skybox/Tex.outputs:out>`,
    `                token outputs:out`,
    "            }",
    `            def Shader "Tex"`,
    "            {",
    `                uniform token info:id = "ND_image_color3"`,
    `                asset inputs:file = @../Assets/${asset}@`,
    `                token outputs:out`,
    "            }",
    "        }",
  ].join("\n");
}

/** The shared material library, referenced by absolute path </Root/Materials/Name>. */
function materialsScope(skyboxAsset?: string): string {
  const mats: string[] = [];
  for (let s = 1; s <= 5; s++) {
    const c = SEVERITY_RGB[s];
    mats.push(matBlock(`Sev${s}`, c, [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5]));
    const core: [number, number, number] = [Math.min(1, c[0] + 0.4), Math.min(1, c[1] + 0.4), Math.min(1, c[2] + 0.4)];
    mats.push(matBlock(`Core${s}`, core, core)); // glowing core (emissive)
  }
  for (const [n, c] of Object.entries(ROOM_MATS)) {
    const a = ROOM_AMBIENT[n] ?? 0;
    mats.push(matBlock(n, c, [c[0] * a, c[1] * a, c[2] * a]));
  }
  if (skyboxAsset) mats.push(skyboxMat(skyboxAsset));
  return [`    def Scope "Materials"`, "    {", mats.join("\n"), "    }"].join("\n");
}

/** Emit a primitive with a bound material. */
function boundPrim(kind: string, name: string, body: string[], mat: string, indent = "        "): string {
  const i2 = indent + "    ";
  return [
    `${indent}def ${kind} "${name}" (`,
    `${indent}    prepend apiSchemas = ["MaterialBindingAPI"]`,
    `${indent})`,
    `${indent}{`,
    ...body.map((b) => i2 + b),
    `${i2}rel material:binding = </Root/Materials/${mat}>`,
    `${indent}}`,
  ].join("\n");
}

// ---- procedural room shell ----
function roomShell(w: number, h: number, d: number): string {
  const hw = w / 2, hd = d / 2, t = 0.08;
  const slab = (name: string, sx: number, sy: number, sz: number, tx: number, ty: number, tz: number, mat: string) =>
    boundPrim("Cube", name, [
      "double size = 1",
      `float3 xformOp:scale = (${sx}, ${sy}, ${sz})`,
      `float3 xformOp:translate = (${tx}, ${ty}, ${tz})`,
      'uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]',
    ], mat, "        ");
  return [
    `    def Xform "Room"`,
    "    {",
    slab("Floor", w, t, d, 0, 0, 0, "Floor"),
    slab("Ceiling", w, t, d, 0, h, 0, "Ceiling"),
    slab("WallBack", w, h, t, 0, h / 2, -hd, "Wall"),
    slab("WallFront", w, h, t, 0, h / 2, hd, "Wall"),
    slab("WallLeft", t, h, d, -hw, h / 2, 0, "Wall"),
    slab("WallRight", t, h, d, hw, h / 2, 0, "Wall"),
    "    }",
  ].join("\n");
}

/**
 * A "saturn"-style ClaimSight damage marker that sticks to ANY surface, built along
 * its local +Y (= surface normal): halo disc -> stem -> dome -> glowing core -> ring.
 * Colors come from bound Materials (Sev<N>/Core<N>/Slate), not displayColor.
 */
function damageMarker(dmg: Damage): string {
  const [x, y, z] = dmg.location;
  const n = dmg.normal ?? SURFACE_NORMAL[dmg.surface] ?? [0, 1, 0];
  const [qw, qx, qy, qz] = quatYToNormal(n);
  const scale = 0.85 + dmg.severity * 0.06;
  const sev = `Sev${dmg.severity}`;
  const cyl = (name: string, radius: number, height: number, ly: number, mat: string) =>
    boundPrim("Cylinder", name, [
      'uniform token axis = "Y"',
      `double radius = ${radius}`,
      `double height = ${height}`,
      `float3 xformOp:translate = (0, ${ly}, 0)`,
      'uniform token[] xformOpOrder = ["xformOp:translate"]',
    ], mat);
  const sphere = (name: string, radius: number, ly: number, mat: string) =>
    boundPrim("Sphere", name, [
      `double radius = ${radius}`,
      `float3 xformOp:translate = (0, ${ly}, 0)`,
      'uniform token[] xformOpOrder = ["xformOp:translate"]',
    ], mat);

  return [
    `    def Xform "${dmg.name}" (`,
    `        customData = { string damageType = "${dmg.type}"; int severity = ${dmg.severity}; string severityLabel = "${SEVERITY_LABEL[dmg.severity]}"; string surface = "${dmg.surface}"; float3 surfaceNormal = (${n.join(", ")})${dmg.note ? `; string note = "${dmg.note.replace(/"/g, "'")}"` : ""} }`,
    "    )",
    "    {",
    `        float3 xformOp:translate = (${x}, ${y}, ${z})`,
    `        quatf xformOp:orient = (${qw}, ${qx}, ${qy}, ${qz})`,
    `        float3 xformOp:scale = (${scale}, ${scale}, ${scale})`,
    '        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]',
    cyl("Halo", 0.12, 0.01, 0.006, sev),
    cyl("Stem", 0.01, 0.16, 0.09, "Slate"),
    sphere("Dome", 0.062, 0.18, sev),
    sphere("Core", 0.04, 0.18, `Core${dmg.severity}`),
    cyl("Ring", 0.105, 0.014, 0.18, sev),
    "    }",
  ].join("\n");
}

function infoPanel(title: string, pos: [number, number, number]): string {
  return [
    `    def Xform "InfoPanel" (`,
    `        customData = { string title = "${title.replace(/"/g, "'")}" }`,
    "    )",
    "    {",
    boundPrim("Cube", "PanelBack", [
      "double size = 1",
      "float3 xformOp:scale = (0.9, 0.55, 0.02)",
      `float3 xformOp:translate = (${pos.join(", ")})`,
      'uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]',
    ], "PanelBg"),
    boundPrim("Cube", "PanelAccent", [
      "double size = 1",
      "float3 xformOp:scale = (0.9, 0.04, 0.025)",
      `float3 xformOp:translate = (${pos[0]}, ${(pos[1] + 0.27).toFixed(3)}, ${pos[2]})`,
      'uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]',
    ], "Accent"),
    "    }",
  ].join("\n");
}

export function registerInspectionTools(server: McpServer) {
  server.registerTool(
    "compose_inspection_scene",
    {
      description:
        "Build a complete ClaimSight-style spatial inspection scene: an environment (procedural damaged room, or a referenced GLB/splat room from e.g. World Labs Marble), severity-colored damage markers pinned in 3D using the canonical ClaimSight 5-tier palette (1 green→5 purple) and real damage taxonomy. All geometry uses real bound MATERIALS (ND_UsdPreviewSurface, emissive cores) — NOT primvars:displayColor, which renders white in the PICO runtime. Writes renderable USDA; pack with verify_scene/iterate_scene. Markers carry damageType/severity as USD customData. NOTE: referenced GLBs must be TEXTURED meshes to look right — an untextured collider mesh renders dark.",
      inputSchema: {
        outPath: z.string().describe("Output .usda (e.g. <project>/Sources/Scenes/Inspection.usda)"),
        environment: z
          .object({
            type: z.enum(["procedural_room", "glb", "skybox"]).default("procedural_room"),
            asset: z.string().optional().describe("For glb: a TEXTURED mesh filename. For skybox: a 360 equirectangular IMAGE filename (under Sources/Assets; import_environment first)."),
            skySphere: z.string().optional().describe("skybox only: the sky-sphere mesh whose texture is overridden (default 'Sky Sphere.usdz' — needs a sphere usdz with an editor-authored image material in Assets)"),
            skyTextureNode: z.string().optional().describe("skybox only: prim path of the texture node inside the sky-sphere to override (default '_materials/Sky_Sphere_m/____________')"),
            width: z.number().default(6),
            height: z.number().default(3),
            depth: z.number().default(6),
          })
          .default({ type: "procedural_room", width: 6, height: 3, depth: 6 }),
        damages: z.array(damageSchema).min(1),
        panel: z
          .object({ title: z.string().default("ClaimSight — Inspection Log"), position: z.tuple([z.number(), z.number(), z.number()]).default([1.6, 1.4, -1.5]) })
          .optional(),
        ibl: z.string().optional().describe("Optional .exr/.hdr IBL filename under Sources/Assets"),
      },
    },
    async ({ outPath, environment, damages, panel, ibl }) => {
      const out = expandHome(outPath);
      const blocks: string[] = [];
      blocks.push(materialsScope()); // shared material library (real colors, not displayColor)

      if (environment.type === "procedural_room") {
        blocks.push(roomShell(environment.width, environment.height, environment.depth));
      } else if (environment.type === "skybox" && environment.asset) {
        // 360 equirectangular image as a skybox. Hand-authored texture materials don't
        // pack in this runtime, so we reference a working sky-sphere mesh (with an
        // editor-authored Principled_BSDF image material) and OVERRIDE its texture node
        // to the provided panorama — the proven pattern. The sky sphere surrounds the
        // user everywhere (also fixes "falling out" of a finite room).
        const skySphere = environment.skySphere ?? "Sky Sphere.usdz";
        const matPath = environment.skyTextureNode ?? "_materials/Sky_Sphere_m/____________";
        const segs = matPath.split("/");
        let block = `    def "Sky_Sphere" (\n        prepend references = @../Assets/${skySphere}@\n    )\n    {\n`;
        block += `        quatf xformOp:orient = (0.7071069, -0.70710665, 0, 0)\n`;
        block += `        float3 xformOp:translate = (0, 0, 0)\n`;
        block += `        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient"]\n`;
        // nest `over` blocks down to the texture node and override its file
        let indent = "        ";
        segs.forEach((s, i) => { block += `${indent}over "${s}"\n${indent}{\n`; indent += "    "; if (i === segs.length - 1) block += `${indent}asset inputs:file = @../Assets/${environment.asset}@\n`; });
        for (let i = 0; i < segs.length; i++) { indent = indent.slice(4); block += `${indent}}\n`; }
        block += "    }";
        blocks.push(block);
      } else if (environment.asset) {
        // referenced environment mesh (Marble textured GLB export, Scaniverse mesh, usdz)
        blocks.push(
          [
            `    def "Environment" (`,
            `        prepend references = @../Assets/${environment.asset}@`,
            "    )",
            "    {",
            "        float3 xformOp:translate = (0, 0, 0)",
            '        uniform token[] xformOpOrder = ["xformOp:translate"]',
            "    }",
          ].join("\n"),
        );
      } else {
        return fail(`environment.type=${environment.type} requires environment.asset (import_environment first)`);
      }

      blocks.push(`    def Xform "DamageMarkers"\n    {\n${damages.map(damageMarker).map((b) => b.replace(/^    /gm, "        ")).join("\n")}\n    }`);
      if (panel !== undefined) blocks.push(infoPanel(panel.title ?? "ClaimSight — Inspection Log", panel.position ?? [1.6, 1.4, -1.5]));

      const iblBlock = ibl
        ? [
            "",
            '    def Xform "EnvironmentLighting"',
            "    {",
            '        def SpatialComponent "StageEnvironmentLightingComponent"',
            "        {",
            '            uniform token info:id = "StageEnvironmentLightingComponent"',
            '            token mMode = "SINGLE"',
            '            def SpatialStruct "mIblTextureOne"',
            "            {",
            "                bool generateMipmap = 1",
            '                token maxSize = "MAXSIZE_256"',
            '                token mipmapMode = "ENV_LIGHTING"',
            '                token textureFormat = "R11F_G11F_B10F"',
            `                asset texturePath = @../Assets/${ibl}@`,
            '                token textureShape = "TEXTURE_CUBEMAP"',
            "            }",
            "        }",
            "    }",
          ].join("\n")
        : "";

      const usda =
        [
          "#usda 1.0",
          "(",
          '    defaultPrim = "Root"',
          '    customLayerData = { string generator = "pico-spatial-mcp / ClaimSight" }',
          "    metersPerUnit = 1",
          '    upAxis = "Y"',
          ")",
          "",
          'def Xform "Root"',
          "{",
          "    float3 xformOp:translate = (0, 0, 0)",
          '    uniform token[] xformOpOrder = ["xformOp:translate"]',
          "",
        ].join("\n") +
        blocks.join("\n\n") +
        iblBlock +
        "\n}\n";

      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, usda);
      const sevCounts = damages.reduce((a, d) => ((a[d.severity] = (a[d.severity] || 0) + 1), a), {} as Record<number, number>);
      return ok(
        `Wrote ClaimSight inspection scene: ${out}\n` +
          `Environment: ${environment.type}${environment.asset ? ` (${environment.asset})` : ""}; damages: ${damages.length} (by severity ${JSON.stringify(sevCounts)}); panel: ${panel ? "yes" : "no"}; ${usda.split("\n").length} lines.\n` +
          `Next: verify_scene (geometry check) then iterate_scene / build APK, then gui_capture to view the 3D result.`,
      );
    },
  );

  server.registerTool(
    "import_environment",
    {
      description:
        "Import a room ENVIRONMENT into a project for use as an inspection backdrop: a GLB/USDZ mesh (e.g. a World Labs Marble mesh export, or a Scaniverse/Polycam scan), or a 360 skybox image. Copies it into Sources/Assets and returns the filename to pass as compose_inspection_scene environment.asset. NOTE: world-model GENERATION (Marble) is external — see worldmodel_guide; this automates the IMPORT + composition side.",
      inputSchema: {
        sourcePath: z.string().describe("Absolute path to the .glb/.usdz/.usd/.png/.jpg/.exr environment file"),
        projectDir: z.string(),
        rename: z.string().optional(),
      },
    },
    async ({ sourcePath, projectDir, rename }) => {
      const src = expandHome(sourcePath);
      if (!fs.existsSync(src)) return fail(`No such file: ${src}`);
      const ext = path.extname(src).toLowerCase();
      const allowed = [".glb", ".gltf", ".usdz", ".usd", ".usda", ".usdc", ".ply", ".png", ".jpg", ".jpeg", ".exr", ".hdr"];
      if (!allowed.includes(ext)) return fail(`Unsupported environment type '${ext}'. Allowed: ${allowed.join(", ")}`);
      const assetsDir = path.join(expandHome(projectDir), "Sources", "Assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      const fname = rename ?? path.basename(src);
      fs.copyFileSync(src, path.join(assetsDir, fname));
      const kind = [".png", ".jpg", ".jpeg", ".exr", ".hdr"].includes(ext) ? "skybox" : ext === ".ply" ? "splat (loads natively via import_world_environment)" : "glb";
      return okJson({
        imported: fname,
        sizeMB: Number((fs.statSync(path.join(assetsDir, fname)).size / 1024 / 1024).toFixed(2)),
        environmentType: kind,
        useAs: `compose_inspection_scene environment={ "type": "${kind === "skybox" ? "skybox" : "glb"}", "asset": "${fname}" }`,
      });
    },
  );

  server.registerTool(
    "worldmodel_guide",
    {
      description:
        "Explain how to generate a damaged-room environment with a world model (World Labs Marble or alternatives) and bring it into a ClaimSight spatial scene. Returns the concrete workflow, free-vs-paid constraints, and the recommended format for the PICO emulator.",
      inputSchema: {},
    },
    async () =>
      okJson({
        why: "The PICO OS6 emulator has no passthrough cameras, so a native spatial app shows an empty (white) Full stage unless you load an environment. A virtual damaged-room backdrop makes a ClaimSight inspection legible (matches ClaimSight's own PLAN_PICO_EMULATOR/PLAN_VR_DEMO GLB-virtual-room approach).",
        howToLoad: "import_environment <file> into the project, then compose_inspection_scene environment={type:'glb'|'skybox', asset:'<file>'}. A GLB mesh becomes a referenced room; an equirectangular image becomes a skybox sphere. Rebuild with build_and_run. (Verified: loading Sky Sphere.usdz replaced the white background.)",
        worldModels: {
          worldLabsMarble: {
            best: "Highest fidelity damaged-room worlds. Generate at marble.worldlabs.ai (text or a photo of a damaged room), export GLB mesh (~600k tris + PBR textures) for the emulator. PLY/SPZ splats are higher fidelity AND load natively on PICO 0.13 (import_world_environment — vision-verified with a 1.92M-pt SPZ; no external renderer needed).",
            cost: "Free tier = 4 gens/month VIEW-ONLY; GLB/PLY export needs a paid plan. (User has credits.)",
            promptForDamagedRoom:
              "Interior of a residential living room with significant water and storm damage for an insurance inspection: large brown water stain spreading across a sagging drywall ceiling with bubbling paint, a dark mold bloom in the corner where wall meets ceiling, buckled and water-stained hardwood floor, a cracked plaster wall near an old electrical panel, peeling baseboards, dim overcast daylight through a partly boarded window, realistic, photogrammetry-style, empty of people, neutral furniture pushed aside.",
          },
          hunyuan3D: "OPEN SOURCE (Apache-2.0), runs LOCALLY on ~6GB VRAM — text/image-to-3D with PBR textures in seconds (hy-3d.net / Tencent Hunyuan3D). Best free+local option for individual props or a room shell; generate → export GLB → import_environment.",
          text2Room_ctrlRoom: "Open-source research (Text2Room, Ctrl-Room) that extract a full textured 3D ROOM mesh from a text prompt — closest free analog to Marble for room-scale; heavier to run locally.",
          blockadeSkyboxAI: "Blockade Labs Skybox AI — text→360° equirectangular panorama with a free tier; cheapest path to a damaged-room SKYBOX (no geometry). Export the PNG → import_environment (type:'skybox').",
          meshyTripo: "Meshy / Tripo — text/image-to-3D with free-tier APIs; good for individual damaged-asset props (broken furniture, debris) to scatter in the scene.",
        },
        scaniverse_polycam: "Free phone scan of a real damaged room → GLB/USDZ export → import_environment. ClaimSight already uses Scaniverse (SPZ/GLB) in PLAN_3DGS.",
        recommendedForEmulator: "Marble GLB (highest fidelity, user has credits) or Hunyuan3D locally (free). Import with import_environment, then compose_inspection_scene environment={type:'glb', asset:'<file>.glb'}.",
        automationBoundary: "This MCP automates IMPORT + scene composition + build + verify + run. World-model GENERATION is an external step (web for Marble/Skybox AI; local for Hunyuan3D). Once you have a GLB/PNG, the MCP does the rest.",
      }),
  );
}
