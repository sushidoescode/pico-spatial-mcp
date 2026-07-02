import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, fail } from "./util.js";

/**
 * composition.ts — v5.7 `generate_composition_scene`: the deferred v4.8 USD-composition tool.
 *
 * Composes multiple authored USDA/USDZ sub-scenes into one scene via USD `references` + `over` overrides
 * (non-destructive layering), extending compose_scene. Emits a well-formed #usda 1.0 text.
 *
 * LOAD-BEARING GOTCHA baked into the description: the Spatial Editor silently DROPS hand-authored `over`
 * blocks on re-save — so if a composed scene round-trips through the editor, DIFF the USDA (bundle_content_diff
 * / editor_project_diff), never trust a bundle md5, and re-apply overrides in Kotlin/at pack time if the
 * editor ate them. For runtime multi-scene, prefer generate_scene_router_kotlin (ECS/broadcast, C4-safe).
 */
const f = (n: number) => (Number.isInteger(n) ? `${n}` : `${n}`);

export function registerCompositionTools(server: McpServer) {
  server.registerTool(
    "generate_composition_scene",
    {
      description:
        "Emit a composed USDA scene that layers multiple authored sub-scenes via USD references + non-destructive `over` overrides (extends compose_scene). Each layer references a sub-scene asset with an optional translate/scale; each override targets a prim path with authored attributes. GOTCHA baked in: the Spatial Editor DROPS hand-authored `over` blocks on re-save — if this round-trips the editor, diff the USDA (never a bundle md5) and re-apply overrides. For RUNTIME scene switching prefer generate_scene_router_kotlin (broadcast-driven, C4-safe). Returns the USDA text; pack with pack_bundle and verify with inspect_bundle.",
      inputSchema: {
        layers: z
          .array(
            z.object({
              name: z.string().describe("Layer prim name."),
              reference: z.string().describe("Sub-scene asset path, e.g. scenes/lobby.usda or ../Assets/x.usdz."),
              translate: z.array(z.number()).length(3).optional().describe("[x,y,z] offset."),
              scale: z.array(z.number()).length(3).optional().describe("[x,y,z] scale."),
            }),
          )
          .min(1)
          .describe("The sub-scenes to compose (referenced, not copied)."),
        overrides: z
          .array(z.object({ primPath: z.string().describe("Prim to override, e.g. /Root/LayerA/Light."), attributes: z.array(z.string()).optional().describe("Raw USDA attribute lines, e.g. 'float inputs:intensity = 800'.") }))
          .optional()
          .describe("Non-destructive `over` blocks layered on top of the references."),
        up: z.enum(["Y", "Z"]).optional().describe("Up axis (default Y)."),
        defaultPrim: z.string().optional().describe("defaultPrim name (default Root)."),
      },
    },
    async ({ layers, overrides, up, defaultPrim }) => {
      if (!layers.length) return fail("at least one layer is required.");
      const root = defaultPrim ?? "Root";
      const L: string[] = [
        "#usda 1.0",
        "(",
        `    defaultPrim = "${root}"`,
        `    upAxis = "${up ?? "Y"}"`,
        ")",
        "",
        `def Xform "${root}"`,
        "{",
      ];
      for (const layer of layers) {
        L.push(`    def Xform "${layer.name}" (`);
        L.push(`        prepend references = @${layer.reference}@`);
        L.push("    )");
        L.push("    {");
        if (layer.translate) L.push(`        double3 xformOp:translate = (${layer.translate.map(f).join(", ")})`);
        if (layer.scale) L.push(`        float3 xformOp:scale = (${layer.scale.map(f).join(", ")})`);
        const ops: string[] = [];
        if (layer.translate) ops.push('"xformOp:translate"');
        if (layer.scale) ops.push('"xformOp:scale"');
        if (ops.length) L.push(`        uniform token[] xformOpOrder = [${ops.join(", ")}]`);
        L.push("    }");
      }
      for (const o of overrides ?? []) {
        // `over` = non-destructive override layered on top of the composed references.
        L.push(`    over "${o.primPath.replace(/^\/(Root\/)?/, "")}"`);
        L.push("    {");
        for (const attr of o.attributes ?? []) L.push(`        ${attr}`);
        L.push("    }");
      }
      L.push("}");
      L.push("");
      return ok(L.join("\n"));
    },
  );
}
