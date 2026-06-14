import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, okJson } from "./util.js";

/**
 * decode_editor_project — the agent's X-ray of a PICO Spatial Editor project (the whole
 * SpatialPackContent tree, NOT just the compiled bundle). Enumerates scenes (+ their prims,
 * materials, shaders, components, asset references), the Sources/Assets, and the editor's baked
 * hidden dirs (.Library / .Component / .CacheData: BundleCache manifest + MaterialCache).
 *
 * Verified against real projects 2026-06-14: claimsight-native + spatialdemo-native
 * editor-asset/src/main/res3d/SpatialPackContent. Editor format = Spatial Editor V0.13.4,
 * bundleTool 0.10.1, MaterialCache materials stored as {GUID}.{mtlx,material,mat,parameterinfo}.
 */

const NESTED = "editor-asset/src/main/res3d/SpatialPackContent";

const ASSET_TYPE: Record<string, string> = {
  ".usdz": "model", ".usdc": "model", ".usda": "model", ".usd": "model", ".glb": "model", ".gltf": "model",
  ".png": "texture", ".jpg": "texture", ".jpeg": "texture", ".exr": "texture", ".hdr": "texture",
  ".ktx": "texture", ".ktx2": "texture", ".astc": "texture",
  ".mtlx": "material", ".mat": "material", ".material": "material",
  ".spz": "splat", ".ply": "splat",
  ".wav": "audio", ".mp3": "audio", ".ogg": "audio",
  ".picometa": "metadata",
};

function exists(p: string): boolean { try { return fs.existsSync(p); } catch { return false; } }
function listDir(d: string): string[] { try { return fs.readdirSync(d); } catch { return []; } }
function statSize(f: string): number { try { return fs.statSync(f).size; } catch { return 0; } }
function statMtime(f: string): number { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }
function readText(f: string): string { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } }
function readJson(f: string): any { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** Recursively count files + return up to `cap` relative paths. */
function walk(dir: string, cap = 40): { count: number; files: string[]; bytes: number } {
  const files: string[] = [];
  let count = 0, bytes = 0;
  const rec = (d: string, rel: string) => {
    for (const name of listDir(d)) {
      const full = path.join(d, name);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) rec(full, r);
      else { count++; bytes += st.size; if (files.length < cap) files.push(r); }
    }
  };
  rec(dir, "");
  return { count, files, bytes };
}

/** Resolve the SpatialPackContent dir from either a direct path or an Android project root. */
function resolveProjectRoot(input: string): string | null {
  const p = expandHome(input);
  if (!exists(p)) return null;
  if (exists(path.join(p, "Sources")) || exists(path.join(p, "SpatialPackContent.spatialproject"))) return p;
  const nested = path.join(p, ...NESTED.split("/"));
  if (exists(nested)) return nested;
  const spc = path.join(p, "SpatialPackContent");
  if (exists(spc)) return spc;
  return p;
}

/** Light USDA parse: header + the prims/materials/shaders/components/references that matter. */
function parseScene(file: string) {
  const text = readText(file);
  const grab = (re: RegExp): string | undefined => text.match(re)?.[1];
  const all = (re: RegExp): string[] => {
    const out: string[] = []; let m;
    const g = new RegExp(re.source, "g");
    while ((m = g.exec(text)) !== null) out.push(m[1]);
    return out;
  };
  const uniq = (a: string[]) => Array.from(new Set(a));
  return {
    name: path.basename(file),
    path: `Sources/Scenes/${path.basename(file)}`,
    sizeBytes: statSize(file),
    editorVersion: grab(/string Version = "([^"]+)"/),
    runtimeVersion: grab(/string RuntimeVersion = "([^"]+)"/),
    defaultPrim: grab(/defaultPrim = "([^"]+)"/),
    upAxis: grab(/upAxis = "([^"]+)"/),
    metersPerUnit: grab(/metersPerUnit = (\S+)/),
    materials: uniq(all(/def Material "([^"]+)"/)),
    shaderNodes: uniq(all(/info:id = "(ND_[^"]+)"/)),
    components: uniq(all(/def SpatialComponent "([^"]+)"/)),
    componentIds: uniq(all(/uniform token info:id = "([A-Za-z]+Component)"/)),
    assetReferences: uniq(all(/references\s*=\s*@([^@]+)@/).concat(all(/inputs:file\s*=\s*@([^@]+)@/))),
    meshes: all(/def Mesh "([^"]+)"/).length,
    xforms: all(/def Xform "([^"]+)"/).length,
  };
}

export function registerEditorProjectTools(server: McpServer) {
  server.registerTool(
    "decode_editor_project",
    {
      description:
        "X-ray a whole PICO Spatial Editor project (a SpatialPackContent tree OR an Android project root that contains one). Reports: project name/version, every scene (.usda) with its prims/materials/shaders/components/asset-references, the Sources/Assets inventory categorized by type, and the editor's baked hidden dirs — .Library (processed assets), .Component (custom components), and .CacheData (BundleCache manifest: bundleTool version + bundled scene list + md5; MaterialCache material count). This is the agent's view of the editor's GUI state without opening the editor.",
      inputSchema: {
        projectDir: z
          .string()
          .describe(
            "Path to a SpatialPackContent dir, or an Android project root (it will descend into editor-asset/src/main/res3d/SpatialPackContent). ~ is expanded.",
          ),
        maxScenes: z.number().int().positive().optional().describe("Cap scenes parsed in detail (default 20)."),
      },
    },
    async ({ projectDir, maxScenes }) => {
      const root = resolveProjectRoot(projectDir);
      if (!root || !exists(root)) return fail(`Project path not found: ${expandHome(projectDir)}`);
      const capScenes = maxScenes ?? 20;

      // ---- project metadata ----
      const proj = readJson(path.join(root, "SpatialPackContent.spatialproject"));
      const modelView = readJson(path.join(root, "ModelView"));
      const project = {
        name: proj?.projectName ?? path.basename(root),
        version: proj?.version ?? null,
        defaultScene: modelView?.sceneFile ?? null,
        path: root,
      };

      // ---- scenes ----
      const scenesDir = path.join(root, "Sources", "Scenes");
      const sceneFiles = listDir(scenesDir).filter((f) => f.endsWith(".usda")).sort();
      const scenes = {
        count: sceneFiles.length,
        files: sceneFiles.slice(0, capScenes).map((f) => parseScene(path.join(scenesDir, f))),
        ...(sceneFiles.length > capScenes ? { omitted: sceneFiles.length - capScenes } : {}),
      };

      // ---- assets ----
      const assetsDir = path.join(root, "Sources", "Assets");
      const byType: Record<string, { count: number; bytes: number; files: string[] }> = {};
      let assetCount = 0, assetBytes = 0;
      for (const name of listDir(assetsDir)) {
        const full = path.join(assetsDir, name);
        if (isDir(full)) continue;
        const ext = path.extname(name).toLowerCase();
        const type = ASSET_TYPE[ext] ?? "other";
        const sz = statSize(full);
        assetCount++; assetBytes += sz;
        (byType[type] ??= { count: 0, bytes: 0, files: [] });
        byType[type].count++; byType[type].bytes += sz;
        if (byType[type].files.length < 25) byType[type].files.push(`${name} (${(sz / 1024).toFixed(0)} KB)`);
      }
      const assets = { count: assetCount, totalBytes: assetBytes, byType };

      // ---- .Component ----
      const compJson = readJson(path.join(root, ".Component", "component.json"));
      const components = {
        present: exists(path.join(root, ".Component", "component.json")),
        count: Array.isArray(compJson?.components) ? compJson.components.length : 0,
        entries: Array.isArray(compJson?.components) ? compJson.components.slice(0, 20) : [],
      };

      // ---- .Library ----
      const libDir = path.join(root, ".Library");
      const libEntries = listDir(libDir).filter((n) => isDir(path.join(libDir, n)));
      const library = {
        present: exists(libDir),
        count: libEntries.length,
        entries: libEntries.map((n) => {
          const ts = n.match(/_(\d{10,})$/)?.[1];
          const w = walk(path.join(libDir, n), 12);
          return { name: n, asset: ts ? n.slice(0, n.length - ts.length - 1) : n, fileCount: w.count, files: w.files };
        }),
      };

      // ---- .CacheData ----
      const cacheDir = path.join(root, ".CacheData");
      const bundleCacheJson = readJson(path.join(cacheDir, "BundleCache", "cache.json"));
      const matCacheDir = path.join(cacheDir, "MaterialCache");
      const matFiles = listDir(matCacheDir);
      const distinctMaterials = new Set(
        matFiles.filter((f) => f.endsWith(".mtlx")).map((f) => f.slice(0, -5)),
      ).size;
      const cacheData = {
        present: exists(cacheDir),
        bundleCache: {
          present: exists(path.join(cacheDir, "BundleCache")),
          bundleBytes: statSize(path.join(cacheDir, "BundleCache", "cache.bundle")),
          bundleToolVersion: bundleCacheJson?.bundleToolVersion ?? null,
          targetMd5: bundleCacheJson?.targetBundleMd5String ?? null,
          bundledScenes: Array.isArray(bundleCacheJson?.sceneFiles)
            ? bundleCacheJson.sceneFiles.map((s: string) => path.basename(s))
            : [],
        },
        materialCache: {
          present: exists(matCacheDir),
          fileCount: matFiles.length,
          distinctMaterials,
        },
        assetCache: { present: exists(path.join(cacheDir, "AssetCache")) },
        editorAssetDb: {
          present: exists(path.join(cacheDir, "EditorAsset.db")),
          sizeBytes: statSize(path.join(cacheDir, "EditorAsset.db")),
        },
      };

      return okJson({ project, scenes, assets, components, library, cacheData });
    },
  );
}
