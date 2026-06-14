import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, fail } from "./util.js";

/**
 * author_materialx — emit a PICO-editor MaterialX (.mtlx) material in the EXACT format the Spatial
 * Editor writes (MaterialX 1.38, colorspace="workingspace", the stdlib xi:include block,
 * combinematerial "USD_Default" -> shader "Shader").
 *
 * Format copied verbatim from real editor output: claimsight-native MaterialCache/*.mtlx (456 of
 * them, decoded 2026-06-14). Two findings drive the "bright" options:
 *   - The editor's OWN bright materials set emissiveColor == diffuseColor (self-lit, lighting-
 *     independent). A dim material has emissiveColor (0,0,0). So `bright:true` mirrors that.
 *   - An UNLIT path exists: node `_unlit_surfaceshader` / nodedef `ND__unlit_surfaceshader`
 *     (extend_defs.mtlx) — guaranteed-bright, no lighting influence.
 *
 * HONESTY (C2 + the textured-mesh wall): well-formedness + format-fidelity are verifiable headless;
 * visual brightness is NOT (no reliable emulator capture). The base-color TEXTURE path follows the
 * MaterialX <image> standard but is UNVERIFIED on this runtime — hand-authored image textures are
 * known to pack BLACK except via an editor-authored material or the bake path (bake_textured_model).
 * Treat textured .mtlx as "built for the editor/MaterialX pipeline; verify visually on headset."
 */

// The 24 stdlib includes the editor emits, verbatim (resolved against spatialbundle's resources dir).
const STDLIB_INCLUDES = [
  "bxdf/disney_brdf_2012.mtlx",
  "bxdf/disney_brdf_2015.mtlx",
  "bxdf/usd_preview_surface.mtlx",
  "bxdf/standard_surface.mtlx",
  "bxdf/gltf_pbr.mtlx",
  "targets/genosl.mtlx",
  "targets/genmsl.mtlx",
  "targets/genglsl.mtlx",
  "targets/essl.mtlx",
  "targets/genmdl.mtlx",
  "extend_lib/extend_defs.mtlx",
  "extend_lib/extend_stdlib_ng.mtlx",
  "extend_lib/extend_half_ng.mtlx",
  "extend_lib/extend_half_defs.mtlx",
  "extend_lib/extend_stdlib_defs.mtlx",
  "extend_lib/genglsl/extend_genglsl_impl.mtlx",
  "cmlib/cmlib_defs.mtlx",
  "cmlib/cmlib_ng.mtlx",
  "stdlib/stdlib_ng.mtlx",
  "stdlib/stdlib_defs.mtlx",
  "stdlib/genglsl/stdlib_genglsl_unit_impl.mtlx",
  "stdlib/genglsl/stdlib_genglsl_impl.mtlx",
  "stdlib/genglsl/stdlib_genglsl_cm_impl.mtlx",
  "spatial_lib/spatial_lib_defs.mtlx",
  "spatial_lib/genglsl/spatial_lib_genglsl_impl.mtlx",
];

const c3 = (rgb: [number, number, number]) => rgb.map((v) => v.toFixed(6)).join(", ");

export function registerMaterialXTools(server: McpServer) {
  server.registerTool(
    "author_materialx",
    {
      description:
        "Emit a PICO Spatial Editor MaterialX (.mtlx) material in the editor's exact format (MaterialX 1.38). mode=pbr -> UsdPreviewSurface (the editor default); mode=unlit -> ND__unlit_surfaceshader (guaranteed-bright, lighting-independent). bright:true mirrors the editor's own self-lit trick (emissiveColor=diffuseColor) so a PBR material renders bright instead of dim. Optional baseColorTexture wires an <image> node (MaterialX standard) — NOTE: hand-authored image textures are known to pack BLACK on this runtime except via an editor material or the bake path, so the textured .mtlx is built-for-editor/headset, not emulator-verified. Format copied verbatim from real editor MaterialCache output.",
      inputSchema: {
        name: z.string().optional().describe("Material display name (header comment only; node names stay editor-canonical). Default 'Material'."),
        mode: z.enum(["pbr", "unlit"]).optional().describe("pbr = UsdPreviewSurface (default); unlit = ND__unlit_surfaceshader (bright, lighting-independent)."),
        baseColor: z.array(z.number()).optional().describe("Linear RGB triple, e.g. [0.8,0.8,0.8] (default). For unlit this is 'color'; for pbr it's diffuseColor."),
        bright: z.boolean().optional().describe("PBR only: set emissiveColor = baseColor so the surface self-lights (the editor's own bright trick). Ignored for unlit (already bright)."),
        metallic: z.number().optional().describe("PBR metallic (default 0)."),
        roughness: z.number().optional().describe("PBR roughness (default 0.45, the editor default)."),
        baseColorTexture: z.string().optional().describe("Optional base-color texture path/filename to wire via an <image> node. UNVERIFIED on this runtime (see note) — prefer bake_textured_model for textured meshes."),
        includeStdlib: z.boolean().optional().describe("Emit the editor's stdlib xi:include block (default true; matches real editor .mtlx). Set false for a minimal material."),
      },
    },
    async ({ name, mode, baseColor, bright, metallic, roughness, baseColorTexture, includeStdlib }) => {
      const displayName = name ?? "Material";
      const m = mode ?? "pbr";
      if (baseColor && baseColor.length !== 3) return fail("baseColor must be exactly 3 numbers [r,g,b].");
      const rgb = (baseColor ?? [0.8, 0.8, 0.8]) as [number, number, number];
      const includes = includeStdlib === false ? "" :
        STDLIB_INCLUDES.map((h) => `  <xi:include href="resources/materialx/libraries/${h}" />`).join("\n") + "\n";

      // Optional texture nodes (MaterialX standard <texcoord> -> <image>); flagged unverified.
      const tex = baseColorTexture
        ? `  <texcoord name="uv0" type="vector2">\n` +
          `    <input name="index" type="integer" value="0" />\n` +
          `  </texcoord>\n` +
          `  <image name="baseColorTex" type="color3">\n` +
          `    <input name="file" type="filename" value="${baseColorTexture}" />\n` +
          `    <input name="texcoord" type="vector2" nodename="uv0" />\n` +
          `  </image>\n`
        : "";
      const colorInput = (inputName: string) =>
        baseColorTexture
          ? `    <input name="${inputName}" type="color3" nodename="baseColorTex" />`
          : `    <input name="${inputName}" type="color3" value="${c3(rgb)}" />`;

      let shader: string;
      if (m === "unlit") {
        shader =
          `  <_unlit_surfaceshader name="Shader" type="surfaceshader" nodedef="ND__unlit_surfaceshader">\n` +
          `${colorInput("color")}\n` +
          `    <input name="opacity" type="float" value="1.000000" />\n` +
          `    <input name="opacityThreshold" type="float" value="0.000000" />\n` +
          `    <input name="applyPostProcessToneMap" type="boolean" value="true" />\n` +
          `    <input name="hasPremultipliedAlpha" type="boolean" value="false" />\n` +
          `    <output name="out" type="surfaceshader" />\n` +
          `  </_unlit_surfaceshader>`;
      } else {
        const emissive = baseColorTexture
          ? (bright ? `    <input name="emissiveColor" type="color3" nodename="baseColorTex" />` : `    <input name="emissiveColor" type="color3" value="0.000000, 0.000000, 0.000000" />`)
          : `    <input name="emissiveColor" type="color3" value="${bright ? c3(rgb) : "0.000000, 0.000000, 0.000000"}" />`;
        shader =
          `  <UsdPreviewSurface name="Shader" type="surfaceshader" nodedef="ND_UsdPreviewSurface_surfaceshader">\n` +
          `${colorInput("diffuseColor")}\n` +
          `${emissive}\n` +
          `    <input name="useSpecularWorkflow" type="integer" value="0" />\n` +
          `    <input name="specularColor" type="color3" value="0.000000, 0.000000, 0.000000" />\n` +
          `    <input name="metallic" type="float" value="${(metallic ?? 0).toFixed(6)}" />\n` +
          `    <input name="roughness" type="float" value="${(roughness ?? 0.45).toFixed(6)}" />\n` +
          `    <input name="clearcoat" type="float" value="0.000000" />\n` +
          `    <input name="clearcoatRoughness" type="float" value="0.010000" />\n` +
          `    <input name="opacity" type="float" value="1.000000" />\n` +
          `    <input name="opacityThreshold" type="float" value="0.000000" />\n` +
          `    <input name="ior" type="float" value="1.500000" />\n` +
          `    <input name="normal" type="vector3" value="0.000000, 0.000000, 1.000000" />\n` +
          `    <input name="displacement" type="float" value="0" />\n` +
          `    <input name="occlusion" type="float" value="1.000000" />\n` +
          `    <output name="out" type="surfaceshader" />\n` +
          `  </UsdPreviewSurface>`;
      }

      const banner = baseColorTexture
        ? `  <!-- ${displayName}: ${m} + baseColorTexture. NOTE: hand-authored image textures may pack BLACK on this runtime;\n       prefer bake_textured_model for meshes, or bind to an editor-authored material. Verify visually on headset. -->\n`
        : `  <!-- ${displayName}: ${m}${m === "pbr" && bright ? " (bright: emissiveColor=diffuseColor, self-lit)" : ""} -->\n`;

      const doc =
        `<?xml version="1.0"?>\n` +
        `<materialx version="1.38" colorspace="workingspace" xmlns:xi="http://www.w3.org/2001/XInclude">\n` +
        includes +
        banner +
        `  <combinematerial name="USD_Default" type="material" nodedef="ND_combinematerial">\n` +
        `    <input name="surfaceshader" type="surfaceshader" nodename="Shader" />\n` +
        `    <input name="vertexshader" type="vertexshader" />\n` +
        `    <output name="out" type="material" />\n` +
        `  </combinematerial>\n` +
        tex +
        shader +
        `\n</materialx>\n`;

      return ok(doc);
    },
  );
}
