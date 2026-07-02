// v7.1 test for the custom-world inspector: detect splat vs mesh PLY and decode a bbox/centroid from a
// synthetic binary splat PLY. (The real .spz/.ply decode is verified live against Marble files.)
// Run: npm run test:worldenv
import { inspectWorld } from "../dist/worldenv.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok   ${name}`); else { console.log(`  FAIL ${name}`); failures++; } };

// ── synthesize a tiny binary_little_endian splat PLY: 3 points, 3DGS properties ──
const props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
const header =
  `ply\nformat binary_little_endian 1.0\nelement vertex 3\n` +
  props.map((p) => `property float ${p}`).join("\n") + `\nend_header\n`;
const pts = [[-1, 0, -2], [1, 2, 0], [0, 4, 2]]; // x,y,z per point
const stride = props.length * 4;
const body = Buffer.alloc(3 * stride);
pts.forEach((p, i) => { for (let c = 0; c < 3; c++) body.writeFloatLE(p[c], i * stride + c * 4); });
const splatPly = path.join(os.tmpdir(), "pico-test-splat.ply");
fs.writeFileSync(splatPly, Buffer.concat([Buffer.from(header, "ascii"), body]));

const s = inspectWorld(splatPly);
check(`detects splat PLY (kind=${s.kind})`, s.kind === "splat");
check(`counts points (${s.numPoints})`, s.numPoints === 3);
check(`decodes bbox min x (${s.bbox?.min?.[0]})`, s.bbox && Math.abs(s.bbox.min[0] - -1) < 1e-4);
check(`decodes bbox max y (${s.bbox?.max?.[1]})`, s.bbox && Math.abs(s.bbox.max[1] - 4) < 1e-4);
check(`computes density centroid y (${s.centroid?.[1]})`, s.centroid && Math.abs(s.centroid[1] - 2) < 1e-3);
check(`computes a floorY (${s.floorY})`, typeof s.floorY === "number");

// ── mesh PLY (has faces, no splat props) → kind mesh ──
const meshHeader = `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n`;
const meshPly = path.join(os.tmpdir(), "pico-test-mesh.ply");
fs.writeFileSync(meshPly, meshHeader);
check("detects mesh PLY (has faces)", inspectWorld(meshPly).kind === "mesh");

// ── .glb routes to mesh ──
check("glb → mesh route", inspectWorld("/x/world.glb").kind === "mesh");

fs.rmSync(splatPly, { force: true });
fs.rmSync(meshPly, { force: true });
console.log(`\nWorld-env test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
