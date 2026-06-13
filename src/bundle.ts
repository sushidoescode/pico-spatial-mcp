import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, ok, okJson, run, tail } from "./util.js";
import { pickVersion, resolveToolsRoot } from "./toolchain.js";

function getSpatialbundle(toolsVersion?: string): { bin: string; version: string } | { error: string } {
  const { root } = resolveToolsRoot();
  const sel = pickVersion(root, toolsVersion, "editor");
  if (!sel?.spatialbundle) return { error: `No spatialbundle binary found under ${root} (version ${toolsVersion ?? "any"})` };
  return { bin: sel.spatialbundle, version: sel.version };
}

export function registerBundleTools(server: McpServer) {
  server.registerTool(
    "pack_bundle",
    {
      description:
        "Compile a USDA/USD/GLTF scene directory into a PICO spatial .bundle using the headless spatialbundle CLI (no GUI, no Gradle). This is the same binary the com.pico.spatial.tools Gradle plugin shells out to.",
      inputSchema: {
        sceneDir: z.string().describe("Directory containing the scene files (for .spatialproject layouts: <proj>/Sources/Scenes)"),
        output: z.string().describe("Output .bundle path"),
        projectDir: z.string().optional().describe("The .spatialproject directory, if packing an editor project"),
        formats: z.array(z.enum(["usda", "usdc", "usdz", "usd", "gltf", "glb"])).default(["usda"]),
        compressTextures: z
          .enum(["astc4x4", "astc5x5", "astc6x6", "astc8x8", "astc10x10", "astc12x12", "none"])
          .default("none")
          .describe("ASTC texture compression ('none' omits the flag, matching the Gradle plugin's invocation)"),
        forceBuild: z.boolean().default(false),
        incremental: z.boolean().default(false),
        extraArgs: z.array(z.string()).default([]).describe("Additional raw spatialbundle pack flags"),
        toolsVersion: z.string().optional(),
      },
    },
    async ({ sceneDir, output, projectDir, formats, compressTextures, forceBuild, incremental, extraArgs, toolsVersion }) => {
      const sb = getSpatialbundle(toolsVersion);
      if ("error" in sb) return fail(sb.error);
      const out = expandHome(output);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const args = ["pack", "-s", expandHome(sceneDir), "-o", out, "--formats", ...formats, "--override-output"];
      if (projectDir) args.push("-p", expandHome(projectDir));
      if (compressTextures !== "none") args.push("--compress-textures", compressTextures);
      if (forceBuild) args.push("--force-build");
      if (incremental) args.push("--incremental-build");
      args.push(...extraArgs);

      const r = await run(sb.bin, args, { timeoutMs: 600_000 });
      const combined = (r.stdout + "\n" + r.stderr).trim();
      const exists = fs.existsSync(out);
      if (r.code !== 0 || !exists) {
        return fail(
          `spatialbundle pack failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}, bundle ${exists ? "written" : "missing"}).\nCommand: ${sb.bin} ${args.join(" ")}\n${tail(combined, 80)}`,
        );
      }
      const size = fs.statSync(out).size;
      return ok(`Bundle written: ${out} (${(size / 1024 / 1024).toFixed(2)} MB, spatialbundle ${sb.version})\n${tail(combined, 30)}`);
    },
  );

  server.registerTool(
    "inspect_bundle",
    {
      description:
        "Inspect a compiled .bundle: spatialbundle info stats (entities/meshes/triangles/textures) plus the embedded BundleInfo.json manifest (bundles are zip64 archives).",
      inputSchema: {
        bundlePath: z.string(),
        details: z.boolean().default(false).describe("Pass --details for per-entity breakdown"),
        toolsVersion: z.string().optional(),
      },
    },
    async ({ bundlePath, details, toolsVersion }) => {
      const sb = getSpatialbundle(toolsVersion);
      if ("error" in sb) return fail(sb.error);
      const p = expandHome(bundlePath);
      if (!fs.existsSync(p)) return fail(`No such file: ${p}`);
      const args = ["info", "--input", p];
      if (details) args.push("--details");
      const r = await run(sb.bin, args, { timeoutMs: 120_000 });
      let manifest: string | null = null;
      const unzip = await run("unzip", ["-p", p, "BundleInfo.json"], { timeoutMs: 30_000 });
      if (unzip.code === 0 && unzip.stdout.trim()) manifest = unzip.stdout.trim();
      const info = (r.stdout + r.stderr).trim();
      if (r.code !== 0 && !manifest) return fail(`spatialbundle info failed (exit ${r.code}):\n${info}`);
      return ok(
        `# spatialbundle info\n${info}\n\n# BundleInfo.json\n${manifest ? tail(manifest, 120) : "(not extractable — older bundle format or no unzip)"}`,
      );
    },
  );

  server.registerTool(
    "decode_spatial_bundle",
    {
      description:
        "Decode what the PICO Spatial Editor BAKED into a compiled .bundle — the agent's window into the editor's output without opening the GUI. Parses the embedded AssetInfo.json (spatial::asset::AssetInfoMap) and returns a histogram of asset TYPES (mesh / texture / shader / materialinstance / collisionshape / physicsmaterial / scene / …) plus the per-asset guid→name→path→type list, with collision/physics/scene assets called out. Note: a `collisionshape`/`physicsmaterial` asset being present means the editor cooked the USD CollisionComponent into the bundle — but that does NOT make Scene.rayCast hit at runtime (the runtime needs a CollisionComponent attached to a live entity + a PhysicsWorldComponent; see diagnose symptom=raycast_no_hit / generate_collider_kotlin).",
      inputSchema: {
        bundlePath: z.string(),
        full: z.boolean().default(false).describe("Include the full per-asset list (guid/name/path/type); default returns the histogram + collision/physics/scene assets only"),
      },
    },
    async ({ bundlePath, full }) => {
      const p = expandHome(bundlePath);
      if (!fs.existsSync(p)) return fail(`No such file: ${p}`);
      const r = await run("unzip", ["-p", p, "AssetInfo.json"], { timeoutMs: 60_000 });
      if (r.code !== 0 || !r.stdout.trim()) return fail(`Could not extract AssetInfo.json from ${p} (not a spatial bundle, or older format).`);
      let parsed: any;
      try {
        parsed = JSON.parse(r.stdout);
      } catch (e) {
        return fail(`AssetInfo.json is not valid JSON: ${(e as Error).message}`);
      }
      const elements: any[] = parsed?.assetInfo?.__elements ?? [];
      if (!Array.isArray(elements) || elements.length === 0) return fail("AssetInfo.json had no assetInfo.__elements array.");
      const histogram: Record<string, number> = {};
      const assets = elements.map((e) => {
        const type = String(e.type ?? "unknown");
        histogram[type] = (histogram[type] ?? 0) + 1;
        return { guid: e.guid, type, path: e.path, name: typeof e.name === "string" ? e.name.split("/").pop() : e.name, deps: (e.dependencies ?? []).length };
      });
      const sortedHist = Object.fromEntries(Object.entries(histogram).sort((a, b) => b[1] - a[1]));
      const physicsTypes = new Set(["collisionshape", "physicsmaterial"]);
      const colliders = assets.filter((a) => physicsTypes.has(a.type));
      const scenes = assets.filter((a) => a.type === "scene" || /scene/i.test(a.type));
      const out: any = {
        bundle: p,
        totalAssets: assets.length,
        typeHistogram: sortedHist,
        collisionAndPhysics: colliders,
        scenes,
        physicsNote:
          colliders.length > 0
            ? `${colliders.filter((c) => c.type === "collisionshape").length} collisionshape + ${colliders.filter((c) => c.type === "physicsmaterial").length} physicsmaterial baked by the editor. This is the editor's cooked collision — it does NOT make Scene.rayCast hit at runtime; attach a CollisionComponent at runtime (generate_collider_kotlin).`
            : "No baked collision assets — colliders (if any) must be attached at runtime.",
      };
      if (full) out.allAssets = assets;
      return okJson(out);
    },
  );

  server.registerTool(
    "scene_schemas",
    {
      description:
        "Return PICO's custom USD schema definitions (SpatialComponent / SpatialAudio / SpatialTimeline) from the installed toolchain — the authoritative grammar for authoring PICO USDA scenes as plain text.",
      inputSchema: { toolsVersion: z.string().optional() },
    },
    async ({ toolsVersion }) => {
      const sb = getSpatialbundle(toolsVersion);
      if ("error" in sb) return fail(sb.error);
      const usdDir = path.join(path.dirname(sb.bin), "usd");
      const out: string[] = [];
      for (const lib of ["spatialComponent", "spatialAudio", "spatialTimeline"]) {
        const schema = path.join(usdDir, lib, "resources", "schema.usda");
        if (fs.existsSync(schema)) out.push(`# ${lib} (${schema})\n${fs.readFileSync(schema, "utf8")}`);
      }
      if (!out.length) return fail(`No PICO schema.usda files found under ${usdDir}`);
      return ok(out.join("\n\n"));
    },
  );
}
