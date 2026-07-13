#!/usr/bin/env node
// Debug dumper for the agent-vault symbol index (src/vault.ts does the parsing; this just prints).
// Usage: node scripts/build-vault-index.mjs [vaultRoot] [--json [outFile]]
import fs from "node:fs";
import { loadVaultIndex, defaultVaultRoot } from "../dist/vault.js";

const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf("--json");
const outFile = jsonIdx >= 0 && argv[jsonIdx + 1] && !argv[jsonIdx + 1].startsWith("--") ? argv[jsonIdx + 1] : undefined;
const root = argv.find((a) => !a.startsWith("--") && a !== outFile);
const idx = loadVaultIndex(root);
if (!idx) {
  console.error(`agent-vault not found at ${root ?? defaultVaultRoot()} (override with PICO_AGENT_VAULT or 'pico-cli setup')`);
  process.exit(1);
}
if (argv.includes("--json")) {
  const obj = {
    vaultRoot: idx.vaultRoot,
    sdkVersion: idx.sdkVersion,
    fileCount: idx.fileCount,
    typeCount: idx.typeCount,
    packages: Object.fromEntries([...idx.packages].map(([p, m]) => [p, Object.fromEntries(m)])),
  };
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(obj, null, 1));
    console.log(`wrote ${outFile}`);
  } else {
    console.log(JSON.stringify(obj, null, 1));
  }
} else {
  console.log(`agent-vault @ ${idx.vaultRoot} (SDK ${idx.sdkVersion ?? "?"}) — ${idx.typeCount} types / ${idx.fileCount} package files`);
  for (const [p, m] of [...idx.packages].sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${p}: ${m.size}`);
}
