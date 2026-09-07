// v27.1 name-aware procedural provisioning test. Two parts:
//   1) matchShapeArchetype — pure keyword table, always runs (no toolchain needed).
//   2) a bake smoke — builds one gem USDA via the shared proceduralUsda emitter and bakes it with
//      the REAL spatialbundle if the local toolchain is present; SELF-SKIPS (not FAIL) when it
//      isn't, exactly like smoke.mjs's SDK-optional pattern (CI has no PICO SDK payload).
// Run: npm run test:provision
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };
const skip = (m) => console.log(`  SKIP ${m}`);

const { matchShapeArchetype } = await import("../dist/fleetbuild.js");
const { proceduralUsda } = await import("../dist/procedural.js");
const bundleModule = await import("../dist/bundle.js");
const { BUNDLE_CACHE_NOTE, registerBundleTools } = bundleModule;
const { registerCatalogTools } = await import("../dist/catalog.js");

const toolMetadata = {};
const toolHandlers = {};
const registrationShim = { registerTool: (name, metadata, handler) => {
  toolMetadata[name] = metadata;
  toolHandlers[name] = handler;
} };
registerBundleTools(registrationShim);
registerCatalogTools(registrationShim);
const bundleCacheTerms = ["assets/BundleCache/", "ignoreAssetsPattern", ".gitignore"];
for (const tool of ["bake_textured_model", "import_model_catalog"]) {
  const description = toolMetadata[tool]?.description ?? "";
  for (const term of bundleCacheTerms) {
    if (!description.includes(term)) fail(`${tool} description is missing ${term}`);
  }
}
for (const term of bundleCacheTerms) {
  if (!(BUNDLE_CACHE_NOTE ?? "").includes(term)) fail(`shared bake note is missing ${term}`);
}
const missingCatalog = JSON.parse((await toolHandlers.import_model_catalog({
  models: [path.join(os.tmpdir(), `missing-model-${process.pid}.glb`)],
  assetsDir: path.join(os.tmpdir(), `missing-assets-${process.pid}`),
})).content[0].text);
for (const term of bundleCacheTerms) {
  if (!(missingCatalog.note ?? "").includes(term)) fail(`import_model_catalog result note is missing ${term}`);
}

// ── 1. matcher unit tests (always run) ──────────────────────────────────────────────────────────
const cases = [
  { args: ["gems"], want: "gem", label: "data node id 'gems' -> gem" },
  { args: ["gem"], want: "gem", label: "data node id 'gem' -> gem" },
  { args: ["crystals"], want: "crystal", label: "data node id 'crystals' -> crystal" },
  { args: ["crystal"], want: "crystal", label: "data node id 'crystal' -> crystal" },
  { args: ["cards"], want: null, label: "data node id 'cards' -> null (honest fallback)" },
  { args: ["items"], want: null, label: "data node id 'items' -> null" },
  { args: ["data"], want: null, label: "data node id 'data' -> null" },
  { args: [undefined, undefined, "gems"], want: "gem", label: "bound-object-id 'gems' (3rd arg) -> gem" },
  { args: [undefined, "gems.json"], want: "gem", label: "asset basename 'gems.json' (2nd arg) -> gem" },
  { args: ["catalog", "data/crystals.json"], want: "crystal", label: "asset basename 'data/crystals.json' -> crystal (id itself doesn't match)" },
  { args: ["prism-shelf"], want: "prism", label: "'prism-shelf' -> prism" },
  { args: ["crate-stack"], want: "cube", label: "'crate-stack' -> cube" },
  { args: ["bottles"], want: "bottle", label: "'bottles' -> bottle" },
  { args: ["bowlingPins"], want: "pin", label: "'bowlingPins' -> pin" },
  { args: ["octahedra"], want: "octahedron", label: "'octahedra' -> octahedron" },
  { args: [undefined, undefined, undefined], want: null, label: "all-undefined -> null" },
];
for (const c of cases) {
  const got = matchShapeArchetype(...c.args);
  if (got === c.want) ok(`${c.label} (got ${JSON.stringify(got)})`);
  else fail(`${c.label}: expected ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`);
}

// ── 2. bake smoke (SDK-gated) ────────────────────────────────────────────────────────────────────
let toolsAvailable = false;
try {
  const { resolveToolsRoot, pickVersion } = await import("../dist/toolchain.js");
  const { root } = resolveToolsRoot();
  const sel = pickVersion(root, undefined, "editor");
  toolsAvailable = !!sel?.spatialbundle;
} catch {
  toolsAvailable = false;
}

if (!toolsAvailable) {
  skip("bake smoke: no local PICO SDK/spatialbundle toolchain found — provisioning's bake path is exercised live by fleet_build");
} else {
  const { bakeTexturedModel } = await import("../dist/bundle.js");
  const usda = proceduralUsda({ shape: "gem", size: 0.34, color: [0.85, 0.12, 0.2], metallic: 0.15, roughness: 0.35, name: "gem0" });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-provision-test-"));
  const usdaPath = path.join(tmpDir, "gem0.usda");
  const outBundle = path.join(tmpDir, "gem0.bundle");
  fs.writeFileSync(usdaPath, usda);
  const bake = await bakeTexturedModel({ modelPath: usdaPath, outBundle });
  if (bake?.error) {
    fail(`bake smoke: bakeTexturedModel errored: ${bake.error}`);
  } else if (!fs.existsSync(outBundle)) {
    fail(`bake smoke: bake reported success but ${outBundle} does not exist`);
  } else {
    const size = fs.statSync(outBundle).size;
    if (size > 1024) ok(`bake smoke: gem0.bundle baked for real (${(size / 1024).toFixed(1)} KB, modelName=${bake.modelName})`);
    else fail(`bake smoke: gem0.bundle is only ${size} bytes (< 1KB) — suspiciously small`);
    for (const term of bundleCacheTerms) {
      if (!(bake.note ?? "").includes(term)) fail(`bakeTexturedModel success note is missing ${term}`);
    }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log(`\nProvision test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
