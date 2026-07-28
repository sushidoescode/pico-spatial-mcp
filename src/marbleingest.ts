import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { okJson } from "./util.js";
import { fileURLToPath } from "node:url";

/**
 * marbleingest.ts — v14: ingest_marble_world — a downloaded World-Labs/Marble world -> an
 * interactive emulator scene, in one call.
 *
 * The user's Marble Pro subscription exports .spz (Gaussian splat) or .glb (textured mesh). This
 * orchestrator turns either into a deployable, INTERACTIVE native scene:
 *   .spz  -> analyze_splat (bounds/floor/boxes) -> generate_splat_colliders (the collider rig so
 *            objects rest on / rayCast hits the world's furniture) -> generate_environment_kotlin
 *            kind='splat' (the SplatEnvironment loader) -> the HomeStage wiring + the adb-push.
 *   .glb  -> the bake path (bake_textured_model -> a spatialbundle -> the SplatEnvironment mesh
 *            loader) — a SOLID, view-INDEPENDENT render (splats are photoreal but view-dependent).
 * Emits everything needed + the honest render notes (SpatialView bounded-window C4 ceiling +
 * the fillMaxSize/world-scale fix so the world FILLS the view instead of a bounded blob).
 */
async function selfClient() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const transport = new StdioClientTransport({ command: "node", args: [path.join(here, "index.js")], cwd: path.dirname(here) });
  const client = new Client({ name: "marble-ingest", version: "1" });
  await client.connect(transport);
  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
    try { return JSON.parse(text); } catch { return text; }
  };
  return { client, call };
}

export function registerMarbleIngestTools(server: McpServer) {
  server.registerTool(
    "ingest_marble_world",
    {
      description:
        "Ingest a downloaded World-Labs / Marble world (.spz splat or .glb mesh) into an INTERACTIVE native emulator scene — one call. For .spz: analyze_splat (3D bounding boxes + floor) -> generate_splat_colliders (the collider rig so objects rest on / rayCast hits the world's furniture — splats have NO native collision) -> generate_environment_kotlin kind='splat' (the SplatEnvironment loader) -> the exact HomeStage wiring + the adb-push. For .glb: the bake_textured_model path (a SOLID, view-INDEPENDENT render). Writes the Kotlin into projectDir/content if given, and returns {files, adbPush, homeStageSnippet, analysis, notes}. Then build_and_run + capture. HONEST: a splat renders as a photoreal but VIEW-DEPENDENT bounded volumetric window (the C4 SpatialView ceiling) — apply the fillMaxSize + world-scale fix (in the notes) so it FILLS the view; a .glb mesh is the reliable-render alternative (Blender can texture it).",
      inputSchema: {
        worldPath: z.string().describe("Absolute path to the downloaded .spz or .glb."),
        packageName: z.string().describe("Content package, e.g. com.example.app.content."),
        projectDir: z.string().optional().describe("If given, writes the generated Kotlin into <projectDir>/app/src/main/java/<pkg>/content/ and (.spz) prints the adb-push into the app's external files dir."),
        withColliders: z.boolean().optional().describe(".spz only: auto-extract + emit the interactive collider rig (default true)."),
        cellSize: z.number().optional().describe("analyze_splat voxel size (default auto)."),
        scale: z.number().optional().describe("World scale (splats/meshes often want ~1.0-2.2 to fill a walkable space; default 1)."),
      },
    },
    async ({ worldPath, packageName, projectDir, withColliders, cellSize, scale }) => {
      if (!fs.existsSync(worldPath)) return okJson({ status: "error", error: `not found: ${worldPath}` });
      const ext = path.extname(worldPath).toLowerCase();
      const isSplat = ext === ".spz" || ext === ".ply";
      const appPkg = packageName.replace(/\.content$/, "");
      const contentDir = projectDir ? path.join(projectDir, `app/src/main/java/${packageName.replace(/\./g, "/")}`) : null;
      const written: string[] = [];
      const { client, call } = await selfClient();
      try {
        const out: any = { status: "ok", world: worldPath, kind: isSplat ? "splat" : "mesh", files: [], analysis: null, notes: [] };

        if (isSplat) {
          // 1. analyze the splat -> bounds/floor/boxes + a LOOKable heatmap
          const a = await call("analyze_splat", { splatPath: worldPath, cellSize });
          if (a.status !== "ok") { out.status = "error"; out.error = `analyze_splat: ${a.error}`; return okJson(out); }
          out.analysis = { numPoints: a.numPoints, elapsedMs: a.elapsedMs, floorY: a.floorY, boxes: a.clusters.length, heatmap: a.heatmap, global: a.global };

          // 2. the SplatEnvironment loader (delivery=storage: adb-push the .spz to external files)
          const fileName = path.basename(worldPath);
          const env = await call("generate_environment_kotlin", { packageName, kind: "splat", assetFileName: fileName, delivery: "storage", scale: scale ?? 1 });
          const envKt = typeof env === "string" ? env : (env.kotlin ?? env);
          if (contentDir) { fs.mkdirSync(contentDir, { recursive: true }); fs.writeFileSync(path.join(contentDir, "SplatEnvironment.kt"), envKt); written.push("content/SplatEnvironment.kt"); }
          out.files.push({ file: "content/SplatEnvironment.kt", content: contentDir ? undefined : envKt });

          // 3. the interactive collider rig (objects rest on / rayCast hits the world)
          if (withColliders !== false) {
            const objs = (a.clusters ?? []).filter((c: any) => c.kind === "object");
            const rig = await call("generate_splat_colliders", { packageName, clusters: objs.length ? objs : a.clusters, floorY: a.floorY, roomBounds: a.global, debugVisuals: false });
            if (rig.kotlin) { if (contentDir) { fs.writeFileSync(path.join(contentDir, "SplatColliders.kt"), rig.kotlin); written.push("content/SplatColliders.kt"); } out.files.push({ file: "content/SplatColliders.kt", content: contentDir ? undefined : rig.kotlin }); out.colliderBoxes = rig.boxes; }
          }

          out.adbPush = `adb -s emulator-5554 push ${JSON.stringify(worldPath)} /sdcard/Android/data/${appPkg}/files/${fileName}`;
          out.homeStageSnippet = [
            "// In SpatialView.initial (a coroutine), after sceneRoot exists:",
            "SplatEnvironment.load(SpatialApplication.externalFilesPath) { content.addEntity(it) }",
            withColliders !== false ? "withContext(Dispatchers.Main) { SplatColliders.install(sceneRoot) }  // objects now rest on / rayCast the world" : "",
            "// place your objects UNDER sceneRoot (physics bodies, props, dressing) — they interact with the splat via the colliders",
          ].filter(Boolean).join("\n");
          out.notes = [
            "SPLAT = photoreal but VIEW-DEPENDENT; it renders as a bounded volumetric window in the stage (the C4 SpatialView ceiling). To make it FILL the view instead of a bounded 'portal', use SpatialView(Modifier.fillMaxSize()) and tune the world scale (~1.0-2.2) + the eye-level pose (a fixed forward capture frames it; the free-cam drifts).",
            "The .spz ships via adb-push (spatialbundle CANNOT pack splats). Run the adbPush above once; SplatEnvironment reads it FROM_STORAGE.",
            "For a SOLID, view-independent render, export the SAME world as .glb from Marble and re-run ingest_marble_world on the .glb (the bake path) — Blender can add/adjust textures first.",
          ];
        } else {
          // .glb mesh -> the baked textured-mesh path (reliable render)
          const stem = path.basename(worldPath).replace(/\.(glb|gltf)$/i, "");
          const bundleAsset = projectDir ? path.join(projectDir, `app/src/main/assets/${stem}.bundle`) : `${stem}.bundle`;
          if (projectDir) fs.mkdirSync(path.dirname(bundleAsset), { recursive: true });
          const bake = await call("bake_textured_model", { modelPath: worldPath, outBundle: bundleAsset });
          out.bake = bake?.status ?? bake;
          const env = await call("generate_environment_kotlin", { packageName, kind: "texturedMesh", assetFileName: path.basename(worldPath), baseColorImage: `${stem}.png`, delivery: "assets", scale: scale ?? 2.2 });
          const envKt = typeof env === "string" ? env : (env.kotlin ?? env);
          if (contentDir) { fs.mkdirSync(contentDir, { recursive: true }); fs.writeFileSync(path.join(contentDir, "MeshEnvironment.kt"), envKt); written.push("content/MeshEnvironment.kt"); }
          out.files.push({ file: "content/MeshEnvironment.kt", content: contentDir ? undefined : envKt });
          out.homeStageSnippet = [
            "// In SpatialView.initial (a coroutine):",
            "MeshEnvironment.load { content.addEntity(it) }  // the BAKED textured world (solid, view-independent)",
            "// add objects under sceneRoot; add a box-collider rig (generate_collider_kotlin) for rayCast (mesh colliders don't register)",
          ].join("\n");
          out.notes = [
            "MESH world renders SOLID + view-INDEPENDENT (the reliable path). Must be BAKED first (done above) — a raw GLB renders black at runtime.",
            "Mesh colliders don't register on-device: pair with a box-collider rig for Scene.rayCast (generate_collider_kotlin), or analyze the matching .spz with analyze_splat for auto-boxes.",
            "Blender can retexture the .glb before ingest (bake_signage_board / your own UVs).",
          ];
        }

        out.written = written;
        out.next = `Write the returned files into ${packageName} content/, ${isSplat ? "run adbPush, " : ""}add the homeStageSnippet to HomeStage, build_and_run, then capture_rig + LOOK (fixed forward pose frames the world).`;
        return okJson(out);
      } catch (e: any) {
        return okJson({ status: "error", error: String(e?.message ?? e).slice(0, 300), written });
      } finally {
        await client.close().catch(() => {});
      }
    },
  );
}
