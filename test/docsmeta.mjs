// v31 docs/metadata gate: versions, tool-count claims, markdown links, and manifest identity stay
// in sync BY ASSERTION, not by discipline. Deterministic, no emulator, no network.
// Run: npm run test:docsmeta
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };
const warn = (m) => console.log(`  WARN ${m}`);
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

// ── (a) one version everywhere ──────────────────────────────────────────────────────────────────
const pkgVersion = JSON.parse(read("package.json")).version;
console.log(`package.json version: ${pkgVersion}\n`);
for (const [file, pick] of [
  ["plugin.json", (o) => o.version],
  [".claude-plugin/plugin.json", (o) => o.version],
  [".claude-plugin/marketplace.json", (o) => o.metadata?.version],
  [".claude-plugin/marketplace.json", (o) => o.plugins?.[0]?.version],
  [".codex-plugin/plugin.json", (o) => o.version],
  [".agents/plugins/marketplace.json", (o) => o.plugins?.[0]?.version],
  [".cursor-plugin/plugin.json", (o) => o.version],
  [".cursor-plugin/marketplace.json", (o) => o.plugins?.[0]?.version],
  [".github/plugin/plugin.json", (o) => o.version],
  [".github/plugin/marketplace.json", (o) => o.metadata?.version],
  [".github/plugin/marketplace.json", (o) => o.plugins?.[0]?.version],
]) {
  const v = pick(JSON.parse(read(file)));
  v === pkgVersion ? ok(`${file} carries version ${v}`) : fail(`${file} version ${v} != package.json ${pkgVersion}`);
}

// the root manifest must be an exact copy of the canonical one (sync-metadata rewrites it as such)
read("plugin.json") === read(".claude-plugin/plugin.json")
  ? ok("plugin.json is an exact copy of .claude-plugin/plugin.json")
  : fail("plugin.json differs from .claude-plugin/plugin.json — run `npm run sync:meta`");

// ── (b) no stale version/tool-count literals anywhere sync-metadata governs ─────────────────────
const check = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "sync-metadata.mjs"), "--check"], {
  encoding: "utf8",
  timeout: 60_000,
});
if (check.status === 0) ok("sync-metadata --check: no stale version/tool-count literals");
else {
  fail("sync-metadata --check found stale metadata — run `npm run sync:meta` (after EXPECTED_TOOLS is settled):");
  console.log(((check.stdout || "") + (check.stderr || "")).trim().split("\n").map((l) => `       ${l}`).join("\n"));
}

// ── (c) every relative markdown link in root *.md + docs/** resolves ────────────────────────────
const mdFiles = fs.readdirSync(repoRoot).filter((f) => f.endsWith(".md"));
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith(".md")) mdFiles.push(rel);
  }
})("docs");
let links = 0;
let broken = 0;
for (const file of mdFiles) {
  // fenced blocks and inline code carry example paths, not links — strip before scanning
  const src = read(file).replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of src.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = m[1].trim().split(/\s+/)[0]; // drop an optional "title" part
    if (/^(https?:|mailto:|#|<)/.test(target)) continue;
    target = target.replace(/#.*$/, "");
    if (!target) continue;
    links++;
    if (!fs.existsSync(path.resolve(repoRoot, path.dirname(file), target))) {
      broken++;
      fail(`${file}: broken relative link -> ${m[1]}`);
    }
  }
}
if (!broken) ok(`all ${links} relative markdown links resolve (${mdFiles.length} files: root *.md + docs/**)`);

// ── (d) homepage vs git origin — WARNING only: whether PICO-MCP -> pico-spatial-mcp was a repo
// rename is not decidable locally and this gate must not touch the network ──────────────────────
try {
  const homepage = JSON.parse(read("plugin.json")).homepage ?? "";
  const origin = /\[remote "origin"\][^[]*?url = (\S+)/.exec(read(".git/config"))?.[1] ?? "";
  const norm = (u) => u.replace(/^git@github\.com:/, "github.com/").replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  if (!origin) warn("no git origin remote found — homepage not cross-checked");
  else if (norm(homepage) === norm(origin)) ok(`plugin.json homepage matches the git origin (${origin})`);
  else warn(`plugin.json homepage (${homepage}) != git origin (${origin}) — warning only; a historical rename cannot be ruled out offline`);
} catch (e) {
  warn(`homepage/origin check skipped: ${e.message}`);
}

console.log(`\nDocs/metadata gate done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
