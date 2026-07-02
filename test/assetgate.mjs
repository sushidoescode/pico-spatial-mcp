// v7.0 fixture test for the STRUCTURAL ASSET GATE. It must accept a well-formed in-budget asset and
// reject the concrete failure modes (Draco, over-budget, degenerate, oversized, no-material). Also checks
// inspectAsset on a real procedural USDA. Run: npm run test:assetgate
import { gateAsset, inspectAsset } from "../dist/assetgate.js";
import { proceduralUsda } from "../dist/procedural.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok   ${name}`); else { console.log(`  FAIL ${name}`); failures++; } };

const good = { format: "glb", parsed: true, triangles: 5000, bbox: { min: [-0.2, -0.2, -0.2], max: [0.2, 0.2, 0.2], sizeM: 0.69 }, hasUVs: true, hasMaterial: true, textures: 1, draco: false, bytes: 1000, sha256: "x", note: "" };

check("accepts a well-formed in-budget asset", gateAsset(good).pass);
check("rejects Draco-compressed", !gateAsset({ ...good, draco: true }).pass);
check("rejects over triangle budget", !gateAsset({ ...good, triangles: 5_000_000 }).pass);
check("rejects zero-triangle/degenerate", !gateAsset({ ...good, triangles: 0 }).pass);
check("rejects oversized bbox (unit-scale error)", !gateAsset({ ...good, bbox: { min: [0, 0, 0], max: [500, 500, 500], sizeM: 866 } }).pass);
check("rejects unparsed asset", !gateAsset({ ...good, parsed: false }).pass);
check("rejects no-material by default", !gateAsset({ ...good, hasMaterial: false }).pass);
check("requireUVs fails when no UVs", !gateAsset({ ...good, hasUVs: false }, { requireUVs: true }).pass);
check("requireUVs not required by default", gateAsset({ ...good, hasUVs: false }).pass);
check("custom triangle budget is honored", !gateAsset({ ...good, triangles: 6000 }, { maxTriangles: 5000 }).pass);

// inspectAsset on a real procedural USDA (a gem) — must parse mesh + material + UVs + a sane bbox.
const usda = proceduralUsda({ shape: "gem", name: "testgem", color: [0.2, 0.7, 0.9], size: 0.3, metallic: 0.1, roughness: 0.3 });
const f = path.join(os.tmpdir(), "pico-gate-testgem.usda");
fs.writeFileSync(f, usda);
const m = inspectAsset(f);
check(`inspectAsset parses the procedural USDA (parsed=${m.parsed})`, m.parsed);
check(`inspectAsset counts triangles (${m.triangles})`, m.triangles > 0);
check("inspectAsset sees the material", m.hasMaterial);
check("inspectAsset sees UVs (primvars:st)", m.hasUVs);
check(`inspectAsset computes a sane bbox (${m.bbox?.sizeM?.toFixed(3)}m)`, m.bbox != null && m.bbox.sizeM > 0 && m.bbox.sizeM < 5);
check("the procedural gem PASSES the gate", gateAsset(m).pass);

// determinism: same params → identical USDA
const usda2 = proceduralUsda({ shape: "gem", name: "testgem", color: [0.2, 0.7, 0.9], size: 0.3, metallic: 0.1, roughness: 0.3 });
check("procedural generation is deterministic (byte-identical)", usda === usda2);

fs.rmSync(f, { force: true });
console.log(`\nAsset gate test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
