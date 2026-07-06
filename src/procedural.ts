import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * procedural.ts — v7.0 PROCEDURAL ASSET GENERATOR (the deterministic, offline content source).
 *
 * Emits a parametric 3D prop as a UsdGeomMesh in a USDA (which spatialbundle bakes into a renderable
 * bundle with a UsdPreviewSurface PBR material — VERIFIED: a gem mesh bakes with hasMaterial=true). This
 * is the "procedural/library now" half of the hybrid generative strategy: fully ANALYTICAL (no RNG →
 * byte-reproducible for the same params, so the determinism/regression gates hold), no network, no GPU.
 * It gives clean, distinct per-item props (gem/cube/crystal/…), unlike a room-scale imported GLB.
 *
 * Flat-shaded facets (each triangle gets its own 3 vertices + face normal) so geometric props read crisp.
 * Every triangle carries a planar UV so the baked material could later take a texture. The emitted USDA is
 * fed to bake_textured_model → a per-item bundle → bound via object.source="model" (makeModelCard).
 */

type V3 = [number, number, number];

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: V3): V3 { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function faceNormal(p0: V3, p1: V3, p2: V3): V3 { return norm(cross(sub(p1, p0), sub(p2, p0))); }

/** A quad (4 CCW corners) → 2 triangles. */
function quad(a: V3, b: V3, c: V3, d: V3): [V3, V3, V3][] {
  return [[a, b, c], [a, c, d]];
}

// ── shape triangle-lists (unit-ish, centered at origin; `size` scales; y is up) ────────────────────────
function cube(s: number): [V3, V3, V3][] {
  const h = s / 2;
  const c: V3[] = [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h]];
  return [
    ...quad(c[3], c[2], c[1], c[0]), // bottom
    ...quad(c[4], c[5], c[6], c[7]), // top
    ...quad(c[0], c[1], c[5], c[4]), // -z
    ...quad(c[2], c[3], c[7], c[6]), // +z
    ...quad(c[3], c[0], c[4], c[7]), // -x
    ...quad(c[1], c[2], c[6], c[5]), // +x
  ];
}
function octahedron(s: number, elong = 1.4): [V3, V3, V3][] {
  const a = s / 2, y = (s / 2) * elong;
  const px: V3 = [a, 0, 0], nx: V3 = [-a, 0, 0], pz: V3 = [0, 0, a], nz: V3 = [0, 0, -a], top: V3 = [0, y, 0], bot: V3 = [0, -y, 0];
  return [[px, pz, top], [pz, nx, top], [nx, nz, top], [nz, px, top], [pz, px, bot], [nx, pz, bot], [nz, nx, bot], [px, nz, bot]];
}
function tetrahedron(s: number): [V3, V3, V3][] {
  const a = s / 2;
  const p: V3[] = [[a, a, a], [a, -a, -a], [-a, a, -a], [-a, -a, a]];
  return [[p[0], p[1], p[2]], [p[0], p[3], p[1]], [p[0], p[2], p[3]], [p[1], p[3], p[2]]];
}
function pyramid(s: number): [V3, V3, V3][] {
  const h = s / 2;
  const b: V3[] = [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]];
  const apex: V3 = [0, h, 0];
  return [[b[0], b[1], apex], [b[1], b[2], apex], [b[2], b[3], apex], [b[3], b[0], apex], ...quad(b[3], b[2], b[1], b[0])];
}
function prism(s: number, sides = 6, height = 1.4): [V3, V3, V3][] {
  const r = s / 2, hy = (s / 2) * height;
  const top: V3[] = [], bot: V3[] = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Math.PI * 2;
    top.push([r * Math.cos(t), hy, r * Math.sin(t)]);
    bot.push([r * Math.cos(t), -hy, r * Math.sin(t)]);
  }
  const tris: [V3, V3, V3][] = [];
  const cT: V3 = [0, hy, 0], cB: V3 = [0, -hy, 0];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tris.push([cT, top[i], top[j]]);          // top fan
    tris.push([cB, bot[j], bot[i]]);          // bottom fan
    tris.push(...quad(bot[i], bot[j], top[j], top[i])); // side
  }
  return tris;
}
function crystal(s: number, sides = 6): [V3, V3, V3][] {
  // a hex prism body with pyramidal points on both ends (a gemstone/crystal)
  const r = s / 2, body = s * 0.6, tip = s * 0.9;
  const ring: V3[] = [];
  for (let i = 0; i < sides; i++) { const t = (i / sides) * Math.PI * 2; ring.push([r * Math.cos(t), 0, r * Math.sin(t)]); }
  const topR = ring.map((p) => [p[0], body, p[2]] as V3);
  const botR = ring.map((p) => [p[0], -body, p[2]] as V3);
  const apexT: V3 = [0, body + tip, 0], apexB: V3 = [0, -body - tip, 0];
  const tris: [V3, V3, V3][] = [];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tris.push([topR[i], apexT, topR[j]]);
    tris.push([botR[j], apexB, botR[i]]);
    tris.push(...quad(botR[i], botR[j], topR[j], topR[i]));
  }
  return tris;
}

// v10.3 (P4): LATHE — revolve a 2D (y, radius) profile around Y into a smooth-silhouette solid.
// Profiles are normalized to height 1 and scaled by size; radii are fractions of size.
// 24 segments reads round at pin scale; triangles keep the flat-shaded pipeline unchanged.
function lathe(s: number, profile: [number, number][], segments = 24): [V3, V3, V3][] {
  const tris: [V3, V3, V3][] = [];
  const ring = (y: number, r: number): V3[] => {
    const pts: V3[] = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      pts.push([r * s * Math.cos(t), y * s, r * s * Math.sin(t)]);
    }
    return pts;
  };
  const rings = profile.map(([y, r]) => ring(y, r));
  for (let k = 0; k < profile.length - 1; k++) {
    const [ , rA] = profile[k];
    const [ , rB] = profile[k + 1];
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      if (rA > 0 && rB > 0) {
        tris.push([A[i], B[i], B[j]], [A[i], B[j], A[j]]);
      } else if (rA > 0 && rB === 0) {
        const apex: V3 = [0, profile[k + 1][0] * s, 0];
        tris.push([A[i], apex, A[j]]);
      } else if (rA === 0 && rB > 0) {
        const apex: V3 = [0, profile[k][0] * s, 0];
        tris.push([apex, B[i], B[j]]);
      }
    }
  }
  // bottom cap (if the first ring is open)
  if (profile[0][1] > 0) {
    const A = rings[0];
    const c: V3 = [0, profile[0][0] * s, 0];
    for (let i = 0; i < segments; i++) tris.push([c, A[(i + 1) % segments], A[i]]);
  }
  // top cap (if the last ring is open)
  const last = profile.length - 1;
  if (profile[last][1] > 0) {
    const B = rings[last];
    const c: V3 = [0, profile[last][0] * s, 0];
    for (let i = 0; i < segments; i++) tris.push([c, B[i], B[(i + 1) % segments]]);
  }
  return tris;
}

// The classic bowling-pin silhouette: wide belly, narrow neck, small head. (y, radius) 0..1.
const PIN_PROFILE: [number, number][] = [
  [0.0, 0.14], [0.04, 0.19], [0.14, 0.225], [0.26, 0.235], [0.38, 0.21],
  [0.48, 0.155], [0.58, 0.11], [0.66, 0.095], [0.74, 0.105], [0.82, 0.125],
  [0.9, 0.11], [0.96, 0.065], [1.0, 0.0],
];
// A slim bottle: cylindrical body, shoulder, thin neck, small lip.
const BOTTLE_PROFILE: [number, number][] = [
  [0.0, 0.16], [0.02, 0.18], [0.5, 0.18], [0.62, 0.14], [0.72, 0.07],
  [0.94, 0.065], [0.96, 0.075], [1.0, 0.07],
];

const SHAPES: Record<string, (s: number) => [V3, V3, V3][]> = {
  cube,
  gem: (s) => octahedron(s, 1.4),
  octahedron: (s) => octahedron(s, 1.0),
  tetrahedron,
  pyramid,
  prism: (s) => prism(s, 6, 1.4),
  crystal: (s) => crystal(s, 6),
  pin: (s) => lathe(s, PIN_PROFILE),
  bottle: (s) => lathe(s, BOTTLE_PROFILE),
};

function fmt(n: number): string {
  // deterministic, compact fixed precision (no locale, no RNG)
  return (Math.round(n * 1e5) / 1e5).toString();
}

/** Build a flat-shaded USDA (each triangle its own 3 verts + face normal + planar UV) with a PBR material. */
export function proceduralUsda(opts: { shape: string; size: number; color: [number, number, number]; metallic: number; roughness: number; name: string }): string {
  const gen = SHAPES[opts.shape] ?? SHAPES.gem;
  const tris = gen(opts.size);
  const points: string[] = [];
  const normals: string[] = [];
  const uvs: string[] = [];
  const counts: number[] = [];
  const indices: number[] = [];
  let vi = 0;
  const uvTri: [number, number][] = [[0, 0], [1, 0], [0.5, 1]];
  for (const [p0, p1, p2] of tris) {
    const nrm = faceNormal(p0, p1, p2);
    for (const p of [p0, p1, p2]) points.push(`(${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])})`);
    for (let k = 0; k < 3; k++) { normals.push(`(${fmt(nrm[0])}, ${fmt(nrm[1])}, ${fmt(nrm[2])})`); uvs.push(`(${uvTri[k][0]}, ${uvTri[k][1]})`); }
    counts.push(3);
    indices.push(vi, vi + 1, vi + 2);
    vi += 3;
  }
  const [r, g, b] = opts.color;
  return [
    `#usda 1.0`,
    `(`,
    `    defaultPrim = "${opts.name}"`,
    `    upAxis = "Y"`,
    `    metersPerUnit = 1`,
    `)`,
    `def Xform "${opts.name}"`,
    `{`,
    `    def Mesh "geo"`,
    `    {`,
    `        int[] faceVertexCounts = [${counts.join(", ")}]`,
    `        int[] faceVertexIndices = [${indices.join(", ")}]`,
    `        point3f[] points = [${points.join(", ")}]`,
    `        normal3f[] normals = [${normals.join(", ")}] (interpolation = "faceVarying")`,
    `        texCoord2f[] primvars:st = [${uvs.join(", ")}] (interpolation = "faceVarying")`,
    `        rel material:binding = </${opts.name}/mat>`,
    `        uniform token subdivisionScheme = "none"`,
    `        uniform bool doubleSided = 1`,
    `    }`,
    `    def Material "mat"`,
    `    {`,
    `        token outputs:surface.connect = </${opts.name}/mat/pbr.outputs:surface>`,
    `        def Shader "pbr"`,
    `        {`,
    `            uniform token info:id = "UsdPreviewSurface"`,
    `            color3f inputs:diffuseColor = (${fmt(r)}, ${fmt(g)}, ${fmt(b)})`,
    `            float inputs:metallic = ${fmt(opts.metallic)}`,
    `            float inputs:roughness = ${fmt(opts.roughness)}`,
    `            token outputs:surface`,
    `        }`,
    `    }`,
    `}`,
    ``,
  ].join("\n");
}

export function registerProceduralTools(server: McpServer) {
  server.registerTool(
    "generate_procedural_asset",
    {
      description:
        "Generate a DETERMINISTIC parametric 3D prop as a USDA mesh (shape + PBR color) — the offline, no-network, byte-reproducible content source for generative depth. spatialbundle bakes the USDA into a renderable bundle with a UsdPreviewSurface material (VERIFIED). Shapes: cube/gem/octahedron/tetrahedron/pyramid/prism/crystal + LATHE solids pin/bottle (revolved real silhouettes — for knockdown/bowling props keep the capsule COLLIDER and use the lathe mesh as the MODEL). Flat-shaded crisp facets, planar UVs. Analytical (same params → identical USDA, so the determinism/regression gates hold). Returns the USDA text + a suggested outBundle name; WRITE it to a .usda, then bake_textured_model it, then bind via object.source=\"model\" (import_model_catalog does a batch). Use this instead of a hosted API when you want deterministic, free, distinct per-item props.",
      inputSchema: {
        shape: z.enum(["cube", "gem", "octahedron", "tetrahedron", "pyramid", "prism", "crystal", "pin", "bottle"]).describe("The parametric prop shape. pin/bottle are LATHE solids (a revolved silhouette — a real bowling-pin/bottle shape, not a capsule); size = their full HEIGHT."),
        name: z.string().describe("Asset name (the model name inside the bundle + the .usda/.bundle stem), e.g. 'ruby'."),
        color: z.array(z.number()).length(3).describe("Diffuse color [r,g,b] 0..1."),
        size: z.number().optional().describe("Overall size in meters (default 0.3)."),
        metallic: z.number().optional().describe("PBR metallic 0..1 (default 0.1)."),
        roughness: z.number().optional().describe("PBR roughness 0..1 (default 0.35)."),
      },
    },
    async ({ shape, name, color, size, metallic, roughness }) => {
      const usda = proceduralUsda({
        shape,
        name: name.replace(/[^A-Za-z0-9_]/g, "_"),
        color: [color[0], color[1], color[2]],
        size: size ?? 0.3,
        metallic: metallic ?? 0.1,
        roughness: roughness ?? 0.35,
      });
      const triCount = (usda.match(/faceVertexCounts = \[([^\]]*)\]/)?.[1].split(",").length) ?? 0;
      return okJson({
        status: "ok",
        shape,
        name,
        usda,
        triangles: triCount,
        suggestedUsdaPath: `<tmp>/${name}.usda`,
        suggestedBundle: `app/src/main/assets/${name}.bundle`,
        note: "Write `usda` to a .usda file, bake_textured_model it → a bundle, then bind with object.source=\"model\" (catalog item carries model + modelName). Deterministic: identical params → identical USDA.",
      });
    },
  );
}
