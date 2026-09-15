// v31 docs/metadata gate: versions, tool-count claims, markdown links, and manifest identity stay
// in sync BY ASSERTION, not by discipline. Deterministic, no emulator, no network.
// Run: npm run test:docsmeta
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePackagedInventory,
  parseTrackedPaths,
  publicMarkdownFiles,
  relativeLinkReport,
} from "../scripts/public-docs.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };
const warn = (m) => console.log(`  WARN ${m}`);
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
/**
 * A link failure names the link. A document-level failure carries no target, because the document
 * itself is the problem — it resolves outside the checkout, or it could not be read at all.
 */
const describeDocFailure = (f) => {
  if (f.target) return `${f.file}: ${f.reason} relative link -> ${f.target}`;
  if (f.reason === "escapes-checkout") return `${f.file}: the document resolves outside the checkout and was not read`;
  return `${f.file}: the document could not be read (${f.reason})`;
};

// ── modes ───────────────────────────────────────────────────────────────────────────────────────
// Default: the public documentation set is whatever Git tracks, so this gate grades the same files
// in a developer checkout and in a clean CI checkout.
//   --packaged <inventory.json>  a source-less installed tarball has no Git metadata; the document
//                                list must then be stated explicitly, never guessed from a scan.
//   --local                      additionally audit the untracked notes a developer checkout
//                                carries. Warnings only — it never changes the public set or the
//                                result, which is the whole point of the split.
const USAGE = "usage: node test/docsmeta.mjs [--local] [--packaged <inventory.json>]";
let localMode = false;
let packagedInventoryPath = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--local") localMode = true;
  else if (arg === "--packaged") {
    packagedInventoryPath = argv[++i] ?? null;
    if (!packagedInventoryPath) { console.error(`docsmeta: --packaged needs a path\n${USAGE}`); process.exit(2); }
  } else if (arg.startsWith("--packaged=")) packagedInventoryPath = arg.slice("--packaged=".length);
  else { console.error(`docsmeta: unknown argument ${arg}\n${USAGE}`); process.exit(2); }
}

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
  [".github/plugin/marketplace.json", (o) => o.metadata?.version],
  [".github/plugin/marketplace.json", (o) => o.plugins?.[0]?.version],
]) {
  const v = pick(JSON.parse(read(file)));
  v === pkgVersion ? ok(`${file} carries version ${v}`) : fail(`${file} version ${v} != package.json ${pkgVersion}`);
}

// Portable core and Claude's host overlay deliberately have different schemas, but one identity.
const portableManifest = JSON.parse(read("plugin.json"));
const claudeManifest = JSON.parse(read(".claude-plugin/plugin.json"));
portableManifest.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
  ? ok("plugin.json targets Agent Plugins 1.0.0")
  : fail("plugin.json does not target the canonical Agent Plugins 1.0.0 schema");
portableManifest.name === claudeManifest.name && portableManifest.version === claudeManifest.version
  ? ok("portable and Claude manifests carry one plugin identity")
  : fail("portable and Claude manifests disagree on name/version");

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

// ── (c) every relative markdown link in the public documentation set resolves ───────────────────
// Public documentation is tracked root *.md plus tracked docs/**/*.md, decided by `git ls-files`
// and never by listing the working tree. A developer checkout carries gitignored root notes
// (CLAUDE.md, HANDOFF.md, NEXT-AGENT-PROMPT.md, the generated pico-cli plugin-context file) that a
// clean CI checkout does not, so a scan graded a different set of documents in the two places.
// `git ls-files` reads the index, so documents staged for this very commit are graded too.
let publicDocs = null;
if (packagedInventoryPath) {
  try {
    const inventory = parsePackagedInventory(fs.readFileSync(packagedInventoryPath, "utf8"));
    publicDocs = publicMarkdownFiles({ root: repoRoot, trackedPaths: inventory });
    ok(`public docs: ${publicDocs.length} file(s) named by the packaged inventory ${packagedInventoryPath}`);
  } catch (e) {
    fail(`public docs: packaged inventory ${packagedInventoryPath} is unusable — ${e.message}`);
  }
} else {
  const tracked = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", "*.md"], {
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tracked.error || tracked.status !== 0) {
    const detail = tracked.error?.message || (tracked.stderr || "").trim() || `git exited with ${tracked.status}`;
    fail(`public docs: not a git checkout — ${detail}. Run this gate from a git checkout, or pass `
      + `--packaged <inventory.json> for a source-less install. This gate never falls back to scanning the tree.`);
  } else {
    publicDocs = publicMarkdownFiles({ root: repoRoot, trackedPaths: parseTrackedPaths(tracked.stdout) });
  }
}

if (publicDocs) {
  const report = relativeLinkReport({ root: repoRoot, files: publicDocs });
  for (const f of report.failures) fail(describeDocFailure(f));
  if (report.failures.length === 0) {
    const source = packagedInventoryPath ? "files named by the packaged inventory" : "git-tracked files";
    ok(`all ${report.links} relative markdown links resolve (${publicDocs.length} ${source}: root *.md + docs/**)`);
  }
}

// ── (c2) --local: the notes only this working tree has, as warnings that change nothing ─────────
if (localMode) {
  console.log("\n  -- --local: untracked local markdown (warnings only; never part of the gate result) --");
  const publicSet = new Set(publicDocs ?? []);
  const local = fs.readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !publicSet.has(e.name))
    .map((e) => e.name);
  if (fs.existsSync(path.join(repoRoot, "docs"))) {
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.isFile() && e.name.endsWith(".md") && !publicSet.has(rel)) local.push(rel);
      }
    })("docs");
  }
  local.sort();
  if (local.length === 0) warn("no untracked local markdown in root *.md or docs/**");
  else {
    warn(`${local.length} local file(s) outside the public set: ${local.join(", ")}`);
    const localReport = relativeLinkReport({ root: repoRoot, files: local });
    for (const f of localReport.failures) warn(describeDocFailure(f));
    if (localReport.failures.length === 0) warn(`all ${localReport.links} local relative link(s) resolve`);
  }
}

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
