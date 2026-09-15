import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, okJson, fail, expandHome, tail } from "./util.js";
import {
  isToolchainFailure,
  resolveOperationToolchain,
  toolchainProvenance,
  toolchainProvenanceLine,
  verifyOperationOverride,
  type OperationToolchain,
} from "./toolchain.js";

/**
 * editor_export_bundle — editor-parity bake: pack a scene dir to a .bundle via `spatialbundle` (the
 * editor's own packer) with the verified flags, then inspect the COOKED assets and confirm cooked
 * physics (collisionshape + physicsmaterial) — the thing hand-authored USD lacks at runtime.
 *
 * Verified path: a scene with a `def SpatialComponent "CollisionComponent"` (author_editor_component)
 * packs to cooked collisionshape + auto PhysicsMaterial (proven v3.2). HONEST: cooked-physics presence
 * is decode-verified here; whether rayCast HITs the cooked shape at runtime is logcat-asserted
 * (assert_scene), and appearance is a capture_frame/verify check — not proven by the bake alone.
 */

/**
 * One selection for the whole bake. This used to try $PICO_SPATIALBUNDLE and then a hardcoded
 * 0.13 path — a version nothing else in the server selects, so a host running 6.x would either
 * report "not found" or silently bake with a stale packer. The override still wins when it is
 * set, but it is now identified by its bytes rather than trusted by filename.
 */
async function packerToolchain(): Promise<OperationToolchain | { error: string }> {
  const prepared = resolveOperationToolchain({ required: ["packer"], primary: "packer", allowBinaryOverride: true });
  if (isToolchainFailure(prepared)) return { error: `${prepared.code}: ${prepared.detail}` };
  const verified = await verifyOperationOverride(prepared);
  if (isToolchainFailure(verified)) return { error: `${verified.code}: ${verified.detail}` };
  return verified;
}

export function registerEditorExportTools(server: McpServer) {
  server.registerTool(
    "editor_export_bundle",
    {
      description:
        "Editor-parity bake: pack a scene dir to a .bundle via spatialbundle (the editor's packer) and report the COOKED assets, confirming cooked physics (collisionshape + PhysicsMaterial) that raw USD lacks at runtime. Use after author_editor_component (Collision) / author_materialx to produce a deploy-ready bundle. Returns cooked-asset counts + physicsCooked flag. Cooked physics is decode-verified here; rayCast HIT is a runtime/logcat check (assert_scene), appearance a capture check.",
      inputSchema: {
        sceneDir: z.string().describe("Directory containing the scene file(s) (~ expanded)."),
        outBundle: z.string().describe("Output .bundle path."),
        projectDir: z.string().optional().describe("The .spatialproject dir, if applicable (-p)."),
        formats: z.array(z.enum(["usda", "usdc", "usdz", "usd", "gltf", "glb"])).optional().describe("Scene formats to scan (default [usda])."),
        compressTextures: z.enum(["astc4x4", "astc5x5", "astc6x6", "astc8x8", "astc10x10", "astc12x12"]).optional().describe("ASTC texture compression (default astc6x6)."),
        assertPhysics: z.boolean().optional().describe("If true, fail when no cooked collisionshape is produced."),
      },
    },
    async ({ sceneDir, outBundle, projectDir, formats, compressTextures, assertPhysics }) => {
      const ctx = await packerToolchain();
      if ("error" in ctx) return fail(`editor_export_bundle: ${ctx.error}`);
      const sb = ctx.bin;
      const src = expandHome(sceneDir);
      const out = expandHome(outBundle);
      if (!fs.existsSync(src)) return fail(`sceneDir not found: ${src}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });

      const packArgs = ["pack", "-s", src, "-o", out, "--formats", ...(formats ?? ["usda"]), "--override-output", "--force-build", "--compress-textures", compressTextures ?? "astc6x6"];
      if (projectDir) packArgs.push("-p", expandHome(projectDir));
      const pack = await run(sb, packArgs, { timeoutMs: 600_000 });
      if (pack.code !== 0 || !fs.existsSync(out)) return fail(`editor_export_bundle: pack failed.\n${tail(pack.stdout + pack.stderr, 40)}`);

      const info = await run(sb, ["info", "-i", out], { timeoutMs: 60_000 });
      const byType: Record<string, number> = {};
      for (const m of info.stdout.matchAll(/Asset Type:\s*(\S+)/g)) byType[m[1]] = (byType[m[1]] ?? 0) + 1;
      const modelCount = parseInt(info.stdout.match(/Model Count:\s*(\d+)/)?.[1] ?? "0", 10);
      const assetCount = parseInt(info.stdout.match(/Asset Count:\s*(\d+)/)?.[1] ?? "0", 10);
      const physicsCooked = (byType["collisionshape"] ?? 0) > 0;

      if (assertPhysics && !physicsCooked) {
        return fail(`editor_export_bundle: assertPhysics=true but NO cooked collisionshape in ${out}. Does the scene have a 'def SpatialComponent \"CollisionComponent\"' (author_editor_component collision_box)? cooked types: ${JSON.stringify(byType)}`);
      }
      const sizeMB = Number((fs.statSync(out).size / 1024 / 1024).toFixed(2));
      return okJson({
        ok: true,
        bundle: out,
        sizeMB,
        modelCount,
        assetCount,
        cookedByType: byType,
        physicsCooked,
        physicsMaterialCooked: (byType["physicsmaterial"] ?? 0) > 0,
        timelineCooked: (byType["timeline"] ?? 0) > 0,
        ...toolchainProvenance(ctx),
        packedWith: toolchainProvenanceLine(ctx),
        note: "Editor-parity bake via spatialbundle. Cooked physics (collisionshape+physicsmaterial) is decode-verified — it's what raw USD lacks at runtime. Confirm rayCast HIT via assert_scene/logcat, and appearance via capture_frame/verify. Bundle md5 is non-deterministic; use bundle_content_diff for content changes.",
      });
    },
  );
}
