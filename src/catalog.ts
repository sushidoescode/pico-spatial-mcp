import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, expandHome } from "./util.js";
import { bakeTexturedModel } from "./bundle.js";

/**
 * catalog.ts — v5.8 `import_model_catalog`: batch-bake N models into N DISTINCT textured bundles.
 *
 * So a data-at-scale scene shows real, distinct models (not just tinted quads): give it a directory of GLBs
 * (or an explicit list) and it bakes each via spatialbundle (bake_textured_model is the ONLY textured path —
 * never runtime-load a raw GLB), copies the bundles into the app's assets, and returns the per-model load
 * snippets + a data-node stub keyed to each bundle. Missing sources return a dry-run PLAN (honest — no fake
 * bakes). The astc `--compress-textures` flag stays last (the retained bake gotcha, handled by the helper).
 */
export function registerCatalogTools(server: McpServer) {
  server.registerTool(
    "import_model_catalog",
    {
      description:
        "Batch-bake a catalog of textured models into N distinct .bundles (via spatialbundle) and stage them in an app's assets — so a data-at-scale scene shows real distinct models, not just tinted quads. Give a modelsDir (all GLB/GLTF/USD*) or an explicit models list + the app's assetsDir; each is baked (never runtime-load a raw GLB) and verified (texture+material present). Missing sources return a dry-run PLAN (no fake bakes). Returns per-model {name, bundle, rendersTextured} + a JSON data-node stub keyed to each bundle for generate_data_binding_kotlin.",
      inputSchema: {
        models: z.array(z.string()).optional().describe("Explicit model paths. Omit to scan modelsDir."),
        modelsDir: z.string().optional().describe("Directory to scan for models (glb/gltf/usd/usda/usdc/usdz)."),
        assetsDir: z.string().describe("App assets dir to stage bundles into, e.g. <project>/app/src/main/assets."),
        compressTextures: z.enum(["astc4x4", "astc5x5", "astc6x6", "astc8x8", "none"]).optional().describe("Default astc6x6."),
        dryRun: z.boolean().optional().describe("Plan only — don't bake (default false; auto-true if sources missing)."),
      },
    },
    async ({ models, modelsDir, assetsDir, compressTextures, dryRun }) => {
      const exts = [".glb", ".gltf", ".usd", ".usda", ".usdc", ".usdz"];
      let list: string[] = (models ?? []).map(expandHome);
      if (!list.length && modelsDir) {
        const dir = expandHome(modelsDir);
        try {
          list = fs.readdirSync(dir).filter((f) => exts.includes(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
        } catch (e: any) {
          return okJson({ status: "error", error: `cannot read modelsDir ${dir}: ${e.message}` });
        }
      }
      if (!list.length) return okJson({ status: "error", error: "no models given (pass `models` or a `modelsDir`)." });

      const assets = expandHome(assetsDir);
      const missing = list.filter((m) => !fs.existsSync(m));
      const plan = list.map((m) => ({ model: m, name: path.basename(m, path.extname(m)), bundle: path.join(assets, `${path.basename(m, path.extname(m))}.bundle`) }));

      if (dryRun || missing.length) {
        return okJson({
          status: missing.length ? "dry_run_missing_sources" : "dry_run",
          count: list.length,
          missing,
          plan,
          note: missing.length ? `${missing.length} source(s) missing — returning the batch PLAN (no fake bakes). Provide the models to bake for real.` : "Dry run: the batch-bake plan.",
        });
      }

      fs.mkdirSync(assets, { recursive: true });
      const results: any[] = [];
      const dataItems: any[] = [];
      for (const m of list) {
        const name = path.basename(m, path.extname(m));
        const out = path.join(assets, `${name}.bundle`);
        const r = await bakeTexturedModel({ modelPath: m, outBundle: out, compressTextures });
        const okBake = !("error" in r);
        results.push({ model: m, name, bundle: okBake ? r.bundle : null, rendersTextured: okBake ? r.rendersTextured : false, error: okBake ? undefined : r.error, sizeMB: okBake ? r.sizeMB : undefined });
        if (okBake) dataItems.push({ id: name, label: name, model: `${name}.bundle`, modelName: r.modelName });
      }
      const baked = results.filter((r) => r.bundle).length;
      return okJson({
        status: "baked",
        total: list.length,
        baked,
        failed: list.length - baked,
        results,
        dataNodeStub: dataItems,
        note: `Baked ${baked}/${list.length} models into ${assets}. Feed dataNodeStub to generate_data_binding_kotlin (bind by 'model' -> Entity.loadSuspend the baked bundle per item).`,
      });
    },
  );
}
