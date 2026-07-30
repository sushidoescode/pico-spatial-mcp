/**
 * measure_model — read a model's REAL world-space bounding box out of the file.
 *
 * Why this exists. `bake_textured_model` already hands back the model name and a load snippet, and
 * `generate_surface_placement_kotlin` already bakes in the six placement traps — but its `modelSize`
 * and `originAt` were caller-supplied, i.e. hand-measured. On 2026-07-29 those numbers were measured
 * by hand for a Meshy table (2.0035 x 0.8373 x 1.3509, origin centred) and everything downstream
 * depended on them being right: get the height wrong and the model sinks through the floor or hovers;
 * get the origin convention wrong and it is buried to the waist. That was the last hand-step in the
 * Meshy-GLB -> MR-object path, and hand-measurement is exactly the kind of silent error this repo
 * turns into a gate rather than re-derives.
 *
 * How it measures. glTF REQUIRES `min`/`max` on the POSITION accessor of every mesh primitive, so the
 * exact local AABB is already in the JSON — no buffer decoding, no dependencies. We walk the scene
 * graph, compose each node's TRS (or explicit matrix) down the tree, transform the 8 corners of each
 * primitive's local AABB into world space, and union. Bind pose is the right measure: skinning and
 * animation are deliberately ignored, because a model is placed at rest.
 *
 * BASE_LIFT is reported as `-min.y`, not as a convention label. "Centre-origin" and "bottom-origin"
 * are just two points on a continuum, and plenty of downloaded models are neither; the distance from
 * the origin to the model's lowest point is exact for all of them.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Vec3 = [number, number, number];
type Mat4 = number[]; // column-major, glTF's own layout

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + i] * b[j * 4 + k];
      out[j * 4 + i] = s;
    }
  }
  return out;
}

/** M = T * R * S, built straight into column-major layout. */
function composeTRS(t: Vec3, q: [number, number, number, number], s: Vec3): Mat4 {
  const [x, y, z, w] = q;
  const [sx, sy, sz] = s;
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Pull the glTF JSON out of a .glb container, or read a .gltf directly. */
export function readGltfJson(file: string): { json: any } | { error: string } {
  if (!fs.existsSync(file)) return { error: `No such model: ${file}` };
  const ext = path.extname(file).toLowerCase();
  if (ext === ".gltf") {
    try {
      return { json: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (e) {
      return { error: `Not valid glTF JSON: ${(e as Error).message}` };
    }
  }
  if (ext !== ".glb") {
    return {
      error:
        `measure_model reads .glb/.gltf (that is the format Meshy, Marble and most generators emit). ` +
        `Got '${ext}'. USD/USDZ carry extents differently and are not parsed here.`,
    };
  }
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.toString("utf8", 0, 4) !== "glTF") return { error: `Not a GLB (bad magic): ${file}` };
  // GLB: 12-byte header, then [u32 length][u32 type][data] chunks. JSON is 0x4E4F534A.
  let off = 12;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (type === 0x4e4f534a) {
      try {
        return { json: JSON.parse(buf.toString("utf8", start, start + len)) };
      } catch (e) {
        return { error: `GLB JSON chunk did not parse: ${(e as Error).message}` };
      }
    }
    off = start + len;
  }
  return { error: `GLB has no JSON chunk: ${file}` };
}

export interface ModelMeasurement {
  file: string;
  format: "glb" | "gltf";
  size: Vec3;
  min: Vec3;
  max: Vec3;
  centre: Vec3;
  /** Distance from the model's origin DOWN to its lowest point — feed straight to BASE_LIFT. */
  baseLift: number;
  /** Convenience label for generate_surface_placement_kotlin's originAt; baseLift is authoritative. */
  originAt: "center" | "bottom" | "offset";
  meshNodes: number;
  warnings: string[];
}

export function measureModel(file: string): ModelMeasurement | { error: string } {
  const parsed = readGltfJson(file);
  if ("error" in parsed) return parsed;
  const g = parsed.json;
  const nodes: any[] = g.nodes ?? [];
  const meshes: any[] = g.meshes ?? [];
  const accessors: any[] = g.accessors ?? [];

  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  let meshNodes = 0;
  const missing: string[] = [];

  const visit = (idx: number, parent: Mat4, seen: Set<number>) => {
    if (seen.has(idx)) return; // a malformed file can cycle; don't hang on it
    seen.add(idx);
    const n = nodes[idx];
    if (!n) return;
    const local: Mat4 = Array.isArray(n.matrix)
      ? (n.matrix as Mat4)
      : composeTRS(
          (n.translation as Vec3) ?? [0, 0, 0],
          (n.rotation as [number, number, number, number]) ?? [0, 0, 0, 1],
          (n.scale as Vec3) ?? [1, 1, 1],
        );
    const world = multiply(parent, local);
    if (typeof n.mesh === "number" && meshes[n.mesh]) {
      meshNodes += 1;
      for (const prim of meshes[n.mesh].primitives ?? []) {
        const acc = accessors[prim.attributes?.POSITION];
        if (!acc?.min || !acc?.max) {
          missing.push(meshes[n.mesh].name ?? `mesh[${n.mesh}]`);
          continue;
        }
        const [ax, ay, az] = acc.min as Vec3;
        const [bx, by, bz] = acc.max as Vec3;
        // Every corner, because a rotated node's AABB is not its transformed AABB.
        for (const c of [
          [ax, ay, az], [bx, ay, az], [ax, by, az], [ax, ay, bz],
          [bx, by, az], [bx, ay, bz], [ax, by, bz], [bx, by, bz],
        ] as Vec3[]) {
          const p = transformPoint(world, c);
          for (let i = 0; i < 3; i++) {
            if (p[i] < lo[i]) lo[i] = p[i];
            if (p[i] > hi[i]) hi[i] = p[i];
          }
        }
      }
    }
    for (const child of n.children ?? []) visit(child, world, seen);
  };

  const sceneIdx = typeof g.scene === "number" ? g.scene : 0;
  const roots: number[] = g.scenes?.[sceneIdx]?.nodes ?? nodes.map((_, i) => i);
  for (const r of roots) visit(r, IDENTITY, new Set());

  if (!Number.isFinite(lo[0])) {
    return {
      error:
        `No measurable geometry in ${path.basename(file)}` +
        (missing.length ? ` — ${missing.length} primitive(s) lack POSITION accessor min/max, which glTF requires.` : "."),
    };
  }

  const r4 = (v: number) => +v.toFixed(4);
  const size: Vec3 = [r4(hi[0] - lo[0]), r4(hi[1] - lo[1]), r4(hi[2] - lo[2])];
  const centre: Vec3 = [r4((hi[0] + lo[0]) / 2), r4((hi[1] + lo[1]) / 2), r4((hi[2] + lo[2]) / 2)];
  const baseLift = r4(-lo[1]);

  // Label the convention, but only as a convenience — baseLift is what placement should use.
  const h = size[1] || 1;
  const originAt: ModelMeasurement["originAt"] =
    Math.abs(lo[1]) <= 0.02 * h ? "bottom" : Math.abs(centre[1]) <= 0.02 * h ? "center" : "offset";

  const warnings: string[] = [];
  const longest = Math.max(...size);
  if (longest > 20) warnings.push(`longest axis is ${longest} m — generators often emit centimetres; check the scale before placing.`);
  if (longest < 0.02) warnings.push(`longest axis is ${longest} m — suspiciously small; check the scale before placing.`);
  if (originAt === "offset")
    warnings.push(`origin is neither centred nor at the base (min.y=${r4(lo[1])}, centre.y=${centre[1]}) — pass baseLift explicitly rather than an originAt label.`);
  if (missing.length) warnings.push(`${missing.length} primitive(s) had no POSITION min/max and were skipped: ${[...new Set(missing)].slice(0, 4).join(", ")}`);

  return {
    file,
    format: path.extname(file).toLowerCase() === ".gltf" ? "gltf" : "glb",
    size,
    min: [r4(lo[0]), r4(lo[1]), r4(lo[2])],
    max: [r4(hi[0]), r4(hi[1]), r4(hi[2])],
    centre,
    baseLift,
    originAt,
    meshNodes,
    warnings,
  };
}

export function registerModelMeasureTools(server: McpServer) {
  server.registerTool(
    "measure_model",
    {
      description:
        "Measure a .glb/.gltf model's REAL world-space bounding box, so surface placement never runs on hand-measured numbers. Walks the scene graph, composes each node's transform, and unions the POSITION accessor min/max that glTF requires — exact, no buffer decoding. Returns size, min/max, centre, meshNodes, and baseLift (the distance from the model's origin down to its lowest point). Feed size straight into generate_surface_placement_kotlin's modelSize and baseLift into its baseLift: get the height wrong and the model sinks through the floor or hovers above it; get the origin convention wrong and it is buried to the waist. Downloaded and generated models (Meshy, Marble) are usually origin-CENTRED rather than sitting on their base, which is exactly the case that looks fine in code and wrong in the headset. Warns when the scale looks like centimetres. This is the measuring step of the model->MR pipeline: measure_model -> bake_textured_model -> generate_surface_placement_kotlin.",
      inputSchema: {
        modelPath: z.string().describe("Absolute path to the .glb or .gltf to measure"),
      },
    },
    async ({ modelPath }) => {
      const r = measureModel(modelPath);
      if ("error" in r) return { isError: true, content: [{ type: "text" as const, text: r.error }] };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...r,
                nextStep:
                  `generate_surface_placement_kotlin with modelSize: [${r.size.join(", ")}], baseLift: ${r.baseLift}` +
                  ` — then bake_textured_model to get the bundle + model name.`,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
