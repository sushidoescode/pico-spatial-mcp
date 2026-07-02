import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, expandHome } from "./util.js";
import { appendLedgerEntry } from "./ledger.js";

/**
 * assetgate.ts — v7.0 STRUCTURAL ASSET GATE (honesty tier 1 of 3).
 *
 * Before a generated/imported asset is allowed into the pipeline it must pass an OBJECTIVE structural
 * check: real geometry (parses), a triangle budget (perf — an unmeasured 2M-tri mesh tanks frame rate), a
 * finite/sane bounding box (not degenerate, not kilometre-scale), UVs present if it should be textured, a
 * material present, and NOT Draco-compressed (the bundled Assimp importer can't load Draco → an empty
 * bundle). This is a STRUCTURAL verdict only — it proves the asset is well-formed and in-budget, NEVER
 * that it looks good. It records `structural` to the trust ledger; the calibrated eye (auto_judged) and a
 * human LOOK (vision_verified) are the later, higher tiers. A generated asset is capped at structural
 * until those pass — "an asset was generated" must never masquerade as "a good asset was seen".
 *
 * Supports .glb/.gltf (binary/text header parse) and .usda/.usd (text parse of the mesh + material).
 */

export type AssetMetrics = {
  format: "glb" | "gltf" | "usda" | "unknown";
  parsed: boolean;
  triangles: number | null;
  bbox: { min: [number, number, number]; max: [number, number, number]; sizeM: number } | null;
  hasUVs: boolean;
  hasMaterial: boolean;
  textures: number;
  draco: boolean;
  bytes: number;
  sha256: string | null;
  note: string;
};

function bboxSize(min: number[], max: number[]): number {
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

function inspectGlbGltf(file: string, buf: Buffer): AssetMetrics {
  const base: AssetMetrics = { format: path.extname(file).toLowerCase() === ".gltf" ? "gltf" : "glb", parsed: false, triangles: null, bbox: null, hasUVs: false, hasMaterial: false, textures: 0, draco: false, bytes: buf.length, sha256: null, note: "" };
  let json: any;
  try {
    if (base.format === "gltf") json = JSON.parse(buf.toString("utf8"));
    else {
      if (buf.length < 20 || buf.toString("ascii", 0, 4) !== "glTF") return { ...base, note: "bad GLB magic" };
      const chunkLength = buf.readUInt32LE(12);
      if (buf.readUInt32LE(16) !== 0x4e4f534a) return { ...base, note: "first GLB chunk not JSON" };
      json = JSON.parse(buf.toString("utf8", 20, Math.min(20 + chunkLength, buf.length)));
    }
  } catch (e: any) {
    return { ...base, note: `parse failed: ${e?.message ?? e}` };
  }
  const accessors: any[] = Array.isArray(json.accessors) ? json.accessors : [];
  const draco = (Array.isArray(json.extensionsUsed) && json.extensionsUsed.includes("KHR_draco_mesh_compression")) ||
    (Array.isArray(json.meshes) && json.meshes.some((m: any) => (m.primitives ?? []).some((p: any) => p?.extensions?.KHR_draco_mesh_compression)));
  let triangles = 0;
  let hasUVs = false;
  const bmin = [Infinity, Infinity, Infinity];
  const bmax = [-Infinity, -Infinity, -Infinity];
  let sawPos = false;
  for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
    for (const prim of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
      const mode = prim.mode ?? 4; // 4 = TRIANGLES
      if (prim?.attributes?.TEXCOORD_0 != null) hasUVs = true;
      const idx = prim.indices != null ? accessors[prim.indices] : null;
      const pos = prim?.attributes?.POSITION != null ? accessors[prim.attributes.POSITION] : null;
      const vertCount = idx?.count ?? pos?.count ?? 0;
      if (mode === 4) triangles += Math.floor(vertCount / 3);
      if (pos && Array.isArray(pos.min) && Array.isArray(pos.max)) {
        sawPos = true;
        for (let i = 0; i < 3; i++) { bmin[i] = Math.min(bmin[i], pos.min[i]); bmax[i] = Math.max(bmax[i], pos.max[i]); }
      }
    }
  }
  const bbox = sawPos ? { min: bmin as [number, number, number], max: bmax as [number, number, number], sizeM: bboxSize(bmin, bmax) } : null;
  return {
    ...base,
    parsed: true,
    triangles,
    bbox,
    hasUVs,
    hasMaterial: Array.isArray(json.materials) && json.materials.length > 0,
    textures: Array.isArray(json.textures) ? json.textures.length : 0,
    draco,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    note: "parsed glTF",
  };
}

function inspectUsda(file: string, buf: Buffer): AssetMetrics {
  const text = buf.toString("utf8");
  const base: AssetMetrics = { format: "usda", parsed: false, triangles: null, bbox: null, hasUVs: false, hasMaterial: false, textures: 0, draco: false, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex"), note: "" };
  // triangle count from faceVertexCounts (sum of (n-2) per face; all-3 lists → count)
  let triangles = 0;
  for (const m of text.matchAll(/faceVertexCounts\s*=\s*\[([^\]]*)\]/g)) {
    for (const n of m[1].split(",")) { const v = parseInt(n.trim(), 10); if (v >= 3) triangles += v - 2; }
  }
  // bbox from points
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  let sawPt = false;
  for (const m of text.matchAll(/points\s*=\s*\[([^\]]*)\]/g)) {
    for (const p of m[1].matchAll(/\(([^)]*)\)/g)) {
      const c = p[1].split(",").map((x) => parseFloat(x.trim()));
      if (c.length === 3 && c.every((x) => Number.isFinite(x))) { sawPt = true; for (let i = 0; i < 3; i++) { bmin[i] = Math.min(bmin[i], c[i]); bmax[i] = Math.max(bmax[i], c[i]); } }
    }
  }
  return {
    ...base,
    parsed: /def\s+Mesh\b/.test(text) || /def\s+(Sphere|Cube|Cylinder|Cone)\b/.test(text),
    triangles: triangles || null,
    bbox: sawPt ? { min: bmin as any, max: bmax as any, sizeM: bboxSize(bmin, bmax) } : null,
    hasUVs: /primvars:st\b/.test(text),
    hasMaterial: /def\s+Material\b/.test(text) || /material:binding\b/.test(text),
    textures: (text.match(/inputs:file\s*=/g) || []).length,
    draco: false,
    note: "parsed USDA",
  };
}

export function inspectAsset(file: string): AssetMetrics {
  const ext = path.extname(file).toLowerCase();
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch (e: any) { return { format: "unknown", parsed: false, triangles: null, bbox: null, hasUVs: false, hasMaterial: false, textures: 0, draco: false, bytes: 0, sha256: null, note: `cannot read: ${e?.message ?? e}` }; }
  if (ext === ".glb" || ext === ".gltf") return inspectGlbGltf(file, buf);
  if (ext === ".usda" || ext === ".usd") return inspectUsda(file, buf);
  return { format: "unknown", parsed: false, triangles: null, bbox: null, hasUVs: false, hasMaterial: false, textures: 0, draco: false, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex"), note: `unsupported extension ${ext}` };
}

export type GatePolicy = { maxTriangles: number; maxSizeM: number; minSizeM: number; requireUVs: boolean; requireMaterial: boolean };
const DEFAULT_POLICY: GatePolicy = { maxTriangles: 200_000, maxSizeM: 50, minSizeM: 0.001, requireUVs: false, requireMaterial: true };

/** Pure gate: metrics + policy → {pass, failures[]}. Exported for the fixture test. */
export function gateAsset(m: AssetMetrics, policy: Partial<GatePolicy> = {}): { pass: boolean; failures: string[]; policy: GatePolicy } {
  const p = { ...DEFAULT_POLICY, ...policy };
  const failures: string[] = [];
  if (!m.parsed) failures.push(`asset did not parse as a valid mesh (${m.note})`);
  if (m.draco) failures.push("Draco-compressed glTF — the bundled Assimp importer cannot load it (would bake an empty bundle)");
  if (m.triangles != null && m.triangles > p.maxTriangles) failures.push(`triangle count ${m.triangles} exceeds budget ${p.maxTriangles} (perf)`);
  if (m.triangles === 0) failures.push("zero triangles — degenerate/empty geometry");
  if (m.bbox) {
    if (!Number.isFinite(m.bbox.sizeM) || m.bbox.sizeM <= 0) failures.push("degenerate bounding box (zero/non-finite extent)");
    else if (m.bbox.sizeM > p.maxSizeM) failures.push(`bounding box ${m.bbox.sizeM.toFixed(1)}m exceeds max ${p.maxSizeM}m (likely wrong unit scale)`);
    else if (m.bbox.sizeM < p.minSizeM) failures.push(`bounding box ${m.bbox.sizeM}m below min ${p.minSizeM}m (invisibly small)`);
  }
  if (p.requireMaterial && !m.hasMaterial) failures.push("no material — will render untextured/black");
  if (p.requireUVs && !m.hasUVs) failures.push("no UVs (TEXCOORD_0 / primvars:st) — cannot apply a texture");
  return { pass: failures.length === 0, failures, policy: p };
}

export function registerAssetGateTools(server: McpServer) {
  server.registerTool(
    "structural_asset_gate",
    {
      description:
        "HONESTY TIER 1 of 3 for generative depth: validate a 3D asset (.glb/.gltf/.usda/.usd) STRUCTURALLY before it enters the pipeline — real geometry, a triangle budget (perf), a finite/sane bounding box, UVs (if it should be textured), a material present, and NOT Draco-compressed (Assimp can't load Draco → empty bundle). Returns metrics (triangles, bbox size, hasUVs/Material/textures, sha256) + a pass/fail with concrete failures. Optionally records `structural` to the app's trust ledger (never vision_verified — a structural pass proves WELL-FORMED + IN-BUDGET, never that it looks good). This is the gate a generated/imported asset must clear before bake → bind → render → auto_judged → human vision_verified.",
      inputSchema: {
        assetPath: z.string().describe("Path to the .glb/.gltf/.usda/.usd asset."),
        maxTriangles: z.number().optional().describe("Triangle budget (default 200000)."),
        maxSizeM: z.number().optional().describe("Max bbox diagonal in meters (default 50)."),
        requireUVs: z.boolean().optional().describe("Fail if no UVs (default false — set true for textured assets)."),
        requireMaterial: z.boolean().optional().describe("Fail if no material (default true)."),
        app: z.string().optional().describe("If set, records a `structural` ledger entry for this app on pass."),
        claim: z.string().optional().describe("The claim to record (defaults to a generic asset-validated claim)."),
      },
    },
    async ({ assetPath, maxTriangles, maxSizeM, requireUVs, requireMaterial, app, claim }) => {
      const file = expandHome(assetPath);
      const metrics = inspectAsset(file);
      const result = gateAsset(metrics, { maxTriangles, maxSizeM, requireUVs, requireMaterial });
      let ledger: any;
      if (app && result.pass) {
        ledger = appendLedgerEntry(app, {
          claim: claim ?? `asset ${path.basename(file)} is structurally valid (${metrics.triangles} tris, ${metrics.bbox ? metrics.bbox.sizeM.toFixed(2) + "m" : "no-bbox"})`,
          evidenceType: "structural",
          attestation: `structural gate PASS: ${metrics.triangles} tris, bbox ${metrics.bbox?.sizeM?.toFixed(2)}m, hasUVs=${metrics.hasUVs}, hasMaterial=${metrics.hasMaterial}, sha ${metrics.sha256?.slice(0, 12)}`,
        });
      }
      return okJson({
        status: result.pass ? "pass" : "fail",
        assetPath: file,
        metrics,
        failures: result.failures,
        policy: result.policy,
        ...(ledger ? { ledger } : {}),
        note: result.pass
          ? "STRUCTURAL pass only — well-formed + in-budget. NOT verified to look good: bake → bind → render → capture+visual_judge (auto_judged) → human LOOK (vision_verified). Cap at structural until then."
          : `Rejected: ${result.failures.join("; ")}. Fix or regenerate before baking.`,
      });
    },
  );
}
