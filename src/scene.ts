import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, ok, okJson } from "./util.js";

/**
 * Programmatic authoring of renderable PICO USDA scenes. The grammar here is
 * taken from real editor output (verified to pack with spatialbundle): a Root
 * Xform containing entities that are either referenced mesh assets
 * (usdz/usd/gltf/glb) or USD primitives, each with a translate/orient/scale
 * transform, plus optional PICO light/IBL SpatialComponents. This lets an agent
 * compose multi-entity scenes as text and compile them — no GUI viewport needed.
 */

// ---- transform helpers ----

/** XYZ Euler degrees -> quaternion (w,x,y,z). Matches the editor's quatf xformOp:orient. */
function eulerToQuat(xDeg: number, yDeg: number, zDeg: number): [number, number, number, number] {
  const r = Math.PI / 180;
  const cx = Math.cos((xDeg * r) / 2), sx = Math.sin((xDeg * r) / 2);
  const cy = Math.cos((yDeg * r) / 2), sy = Math.sin((yDeg * r) / 2);
  const cz = Math.cos((zDeg * r) / 2), sz = Math.sin((zDeg * r) / 2);
  // XYZ intrinsic order
  const w = cx * cy * cz + sx * sy * sz;
  const x = sx * cy * cz - cx * sy * sz;
  const y = cx * sy * cz + sx * cy * sz;
  const z = cx * cy * sz - sx * sy * cz;
  const round = (n: number) => Math.abs(n) < 1e-7 ? 0 : +n.toFixed(7);
  return [round(w), round(x), round(y), round(z)];
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const transformSchema = {
  translate: vec3.optional().describe("[x,y,z] meters (default [0,0,0])"),
  rotationEuler: vec3.optional().describe("[x,y,z] degrees (default [0,0,0])"),
  scale: z.union([z.number(), vec3]).optional().describe("uniform number or [x,y,z] (default 1)"),
};

const entitySchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  asset: z.string().optional().describe("Filename of a mesh under Sources/Assets — usdz/usd ONLY (a USDA reference to .gltf/.glb yields an EMPTY bundle: USD has no glTF plugin — the repo's own usd-glb-reference ERROR lint rule. Bake GLB via bake_textured_model instead), e.g. 'box.usdz'"),
  primitive: z.enum(["Cube", "Sphere", "Cylinder", "Cone", "Capsule", "Plane"]).optional(),
  size: z.number().optional().describe("primitive Cube size / Plane size"),
  radius: z.number().optional().describe("primitive Sphere/Cylinder/Cone/Capsule radius"),
  height: z.number().optional().describe("primitive Cylinder/Cone/Capsule height"),
  color: vec3.optional().describe("[r,g,b] 0..1 displayColor for primitives"),
  light: z.enum(["spot", "point", "directional"]).optional().describe("Add a light SpatialComponent to this entity"),
  ...transformSchema,
});

type Entity = z.infer<typeof entitySchema>;

function xformBlock(e: { translate?: number[]; rotationEuler?: number[]; scale?: number | number[] }, indent: string): string {
  const t = e.translate ?? [0, 0, 0];
  const lines: string[] = [];
  const order: string[] = [];
  lines.push(`${indent}float3 xformOp:translate = (${t.join(", ")})`);
  order.push('"xformOp:translate"');
  if (e.rotationEuler && (e.rotationEuler[0] || e.rotationEuler[1] || e.rotationEuler[2])) {
    const [w, x, y, z] = eulerToQuat(e.rotationEuler[0], e.rotationEuler[1], e.rotationEuler[2]);
    lines.push(`${indent}quatf xformOp:orient = (${w}, ${x}, ${y}, ${z}) (`);
    lines.push(`${indent}    customData = { float3 euler = (${e.rotationEuler.join(", ")}) }`);
    lines.push(`${indent})`);
    order.push('"xformOp:orient"');
  }
  if (e.scale != null) {
    const s = typeof e.scale === "number" ? [e.scale, e.scale, e.scale] : e.scale;
    lines.push(`${indent}float3 xformOp:scale = (${s.join(", ")})`);
    order.push('"xformOp:scale"');
  }
  lines.push(`${indent}uniform token[] xformOpOrder = [${order.join(", ")}]`);
  return lines.join("\n");
}

const LIGHT_COMPONENT: Record<string, string> = {
  spot: "SpotLightComponent",
  point: "PointLightComponent",
  directional: "DirectionalLightComponent",
};

function entityBlock(e: Entity, indent = "    "): string {
  const inner = "    ";
  const i2 = indent + inner;
  const parts: string[] = [];
  if (e.asset) {
    parts.push(`${indent}def "${e.name}" (`);
    parts.push(`${indent}    prepend references = @../Assets/${e.asset}@`);
    parts.push(`${indent})`);
    parts.push(`${indent}{`);
    parts.push(xformBlock(e, i2));
    parts.push(`${indent}}`);
  } else if (e.primitive) {
    parts.push(`${indent}def ${e.primitive} "${e.name}"`);
    parts.push(`${indent}{`);
    if (e.primitive === "Sphere" || e.primitive === "Capsule") parts.push(`${i2}double radius = ${e.radius ?? 0.5}`);
    if (e.primitive === "Cube" || e.primitive === "Plane") parts.push(`${i2}double size = ${e.size ?? 1}`);
    if (e.primitive === "Cylinder" || e.primitive === "Cone") {
      parts.push(`${i2}double radius = ${e.radius ?? 0.5}`);
      parts.push(`${i2}double height = ${e.height ?? 1}`);
    }
    if (e.color) parts.push(`${i2}color3f[] primvars:displayColor = [(${e.color.join(", ")})]`);
    parts.push(xformBlock(e, i2));
    parts.push(`${indent}}`);
  } else if (e.light) {
    // light-only entity: an Xform carrying the light component
    const comp = LIGHT_COMPONENT[e.light];
    parts.push(`${indent}def Xform "${e.name}"`);
    parts.push(`${indent}{`);
    parts.push(xformBlock(e, i2));
    parts.push("");
    parts.push(`${i2}def SpatialComponent "${comp}"`);
    parts.push(`${i2}{`);
    parts.push(`${i2}    uniform token info:id = "${comp}"`);
    parts.push(`${i2}}`);
    parts.push(`${indent}}`);
  } else {
    // plain Xform group
    parts.push(`${indent}def Xform "${e.name}"`);
    parts.push(`${indent}{`);
    parts.push(xformBlock(e, i2));
    parts.push(`${indent}}`);
  }
  return parts.join("\n");
}

function buildSceneUsda(entities: Entity[], opts: { up?: string; ibl?: string }): string {
  const header = [
    "#usda 1.0",
    "(",
    '    defaultPrim = "Root"',
    "    metersPerUnit = 1",
    `    upAxis = "${opts.up ?? "Y"}"`,
    ")",
    "",
    'def Xform "Root"',
    "{",
    "    float3 xformOp:translate = (0, 0, 0)",
    '    uniform token[] xformOpOrder = ["xformOp:translate"]',
    "",
  ];
  const body = entities.map((e) => entityBlock(e)).join("\n\n");
  const iblBlock = opts.ibl
    ? [
        "",
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
        '                token sourceColorSpace = "SRGB_REC709"',
        '                token targetColorSpace = "SRGB_DISPLAY_P3"',
        '                token textureFormat = "R11F_G11F_B10F"',
        `                asset texturePath = @../Assets/${opts.ibl}@`,
        '                token textureShape = "TEXTURE_CUBEMAP"',
        '                token textureType = "DEFAULT"',
        "            }",
        "        }",
        "    }",
      ].join("\n")
    : "";
  return header.join("\n") + body + iblBlock + "\n}\n";
}

const ASSET_EXTS = [".usdz", ".usd", ".usda", ".usdc", ".gltf", ".glb", ".png", ".jpg", ".jpeg", ".webp", ".exr", ".hdr", ".ktx"];

export function registerSceneTools(server: McpServer) {
  server.registerTool(
    "compose_scene",
    {
      description:
        "Generate a complete, renderable PICO USDA scene from a high-level spec — no GUI. Entities are referenced mesh assets (usdz/usd/gltf/glb under Sources/Assets) or USD primitives, each with a translate/rotation(euler°)/scale transform, plus optional lights and an IBL environment. Writes the .usda; pack it with pack_bundle/iterate_scene and verify with inspect_bundle. Use import_asset first to bring meshes/textures into the project.",
      inputSchema: {
        outPath: z.string().describe("Output .usda path (typically <project>/Sources/Scenes/<Name>.usda)"),
        entities: z.array(entitySchema).min(1),
        up: z.enum(["Y", "Z"]).default("Y"),
        ibl: z.string().optional().describe("Filename of an .exr/.hdr IBL under Sources/Assets for image-based lighting"),
        overwrite: z.boolean().default(true),
      },
    },
    async ({ outPath, entities, up, ibl, overwrite }) => {
      const out = expandHome(outPath);
      if (fs.existsSync(out) && !overwrite) return fail(`Exists (overwrite=false): ${out}`);
      const bad = entities.find((e) => !e.asset && !e.primitive && !e.light);
      if (bad) return fail(`Entity '${bad.name}' must have one of: asset, primitive, or light`);
      const usda = buildSceneUsda(entities, { up, ibl });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, usda);
      return ok(
        `Wrote ${out} (${entities.length} entities${ibl ? " + IBL" : ""}, ${usda.split("\n").length} lines).\nNext: pack_bundle/iterate_scene then inspect_bundle to verify geometry.\n\n${usda.length > 1600 ? usda.slice(0, 1600) + "\n... (truncated)" : usda}`,
      );
    },
  );

  server.registerTool(
    "add_entity",
    {
      description:
        "Append one entity (mesh reference, primitive, or light) to an existing scene .usda, inserting it inside the Root Xform. For quick incremental edits without regenerating the whole scene.",
      inputSchema: {
        scenePath: z.string(),
        entity: entitySchema,
      },
    },
    async ({ scenePath, entity }) => {
      const p = expandHome(scenePath);
      if (!fs.existsSync(p)) return fail(`No such scene: ${p}`);
      if (!entity.asset && !entity.primitive && !entity.light) return fail("entity needs asset, primitive, or light");
      const src = fs.readFileSync(p, "utf8");
      const lastBrace = src.lastIndexOf("}");
      if (lastBrace < 0) return fail("Scene has no closing brace; not a valid USDA Root block");
      const block = "\n" + entityBlock(entity) + "\n";
      const updated = src.slice(0, lastBrace) + block + src.slice(lastBrace);
      fs.writeFileSync(p, updated);
      return ok(`Added entity '${entity.name}' to ${p}.`);
    },
  );

  server.registerTool(
    "import_asset",
    {
      description:
        "Copy a 3D model (usdz/usd/gltf/glb) or texture (png/jpg/webp/exr/hdr/ktx) into a project's Sources/Assets so scenes can reference it. Returns the filename to use as an entity's `asset` (or IBL).",
      inputSchema: {
        sourcePath: z.string().describe("Absolute path to the source asset file"),
        projectDir: z.string().describe("The .spatialproject directory (assets go to <projectDir>/Sources/Assets)"),
        rename: z.string().optional().describe("Optional new filename (keep the extension)"),
      },
    },
    async ({ sourcePath, projectDir, rename }) => {
      const src = expandHome(sourcePath);
      if (!fs.existsSync(src)) return fail(`No such file: ${src}`);
      const ext = path.extname(src).toLowerCase();
      if (!ASSET_EXTS.includes(ext)) return fail(`Unsupported asset type '${ext}'. Allowed: ${ASSET_EXTS.join(", ")}`);
      const assetsDir = path.join(expandHome(projectDir), "Sources", "Assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      const fname = rename ?? path.basename(src);
      const dest = path.join(assetsDir, fname);
      fs.copyFileSync(src, dest);
      return okJson({
        imported: fname,
        dest,
        sizeMB: Number((fs.statSync(dest).size / 1024 / 1024).toFixed(2)),
        useAs: ASSET_EXTS.slice(0, 6).includes(ext) ? `entity { "asset": "${fname}" }` : `compose_scene ibl="${fname}" or a texture reference`,
      });
    },
  );
}
