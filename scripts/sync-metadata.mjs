#!/usr/bin/env node
/**
 * sync-metadata — the single-source metadata stamper (v31).
 *
 * Two truths, read from files that already gate reality, get stamped everywhere they are published:
 *   - `version`             from package.json
 *   - the full-surface tool count from scripts/verify-tarball.mjs EXPECTED_TOOLS (the number the
 *     tarball gate asserts against an installed copy), plus the doors-name list at the head of
 *     REQUIRED_TOOLS (used only for small-count honesty WARNINGS, never for replacements).
 *
 * Stamped targets:
 *   - .claude-plugin/plugin.json      version + "NNN tools" phrases in the description
 *   - plugin.json                     rewritten as an EXACT copy of .claude-plugin/plugin.json —
 *                                     which loader reads which file is unverified, so both ship,
 *                                     but only the .claude-plugin one is authored
 *   - .claude-plugin/marketplace.json metadata.version + description tool counts
 *   - README.md GETTING_STARTED.md TESTERS.md QUICKSTART.md AGENTS.md docs/HOSTS.md
 *     full-surface tool-count claims + versioned tarball filenames. Deliberately CONSERVATIVE:
 *     only the known stale-literal shapes below are touched, and every replacement is printed.
 *
 * Modes:
 *   node scripts/sync-metadata.mjs           stamp, printing every replacement
 *   node scripts/sync-metadata.mjs --check   dry-run; exit 1 if anything would change
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
let changes = 0;
const warns = [];
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

// ── sources of truth ────────────────────────────────────────────────────────────────────────────
const version = JSON.parse(read("package.json")).version;
const vt = read("scripts/verify-tarball.mjs");
const toolsMatch = /const EXPECTED_TOOLS = (\d+)/.exec(vt);
const reqMatch = /const REQUIRED_TOOLS = \[([\s\S]*?)\];/.exec(vt);
if (!toolsMatch || !reqMatch) {
  console.error("FATAL: cannot parse EXPECTED_TOOLS / REQUIRED_TOOLS from scripts/verify-tarball.mjs — its shape changed");
  process.exit(2);
}
const TOOLS = Number(toolsMatch[1]);
// the doors names are the run of entries before the "core lanes" comment in REQUIRED_TOOLS
const DOORS = [...reqMatch[1].split(/\/\/ core lanes/)[0].matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
if (DOORS.length < 10) {
  console.error(`FATAL: parsed only ${DOORS.length} doors names from REQUIRED_TOOLS — the doors/core-lanes comment boundary moved`);
  process.exit(2);
}
console.log(`truth: version=${version}  tools=${TOOLS}  doors=${DOORS.length}\n`);

// Every full-surface count this project has ever published (55/190/214/220/224 have all appeared in
// docs). Bare "~NNN" and "instead of NNN" forms are only replaced for THESE counts — a generic
// bare-number rule would eat measurements like "~90 s".
const PUBLISHED_COUNTS = [55, 190, 214, 220, 224].filter((c) => c !== TOOLS);

/** "NNN tools" / "NNN-tool" phrases: any 2-3 digit count >= 50 that isn't the truth. */
const countPhrases = (text) =>
  text.replace(/\b(\d{2,3})(\+?[- ]tools?)\b/g, (m, d, suffix) => (Number(d) >= 50 && Number(d) !== TOOLS ? `${TOOLS}${suffix}` : m));

function stampDocLine(line) {
  let out = countPhrases(line);
  for (const c of PUBLISHED_COUNTS) {
    out = out.replace(new RegExp(`~${c}(?!\\d)`, "g"), `~${TOOLS}`);
    out = out.replace(new RegExp(`instead of ${c}(?!\\d)`, "g"), `instead of ${TOOLS}`);
  }
  return out.replace(/pico-spatial-mcp-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\.tgz/g, `pico-spatial-mcp-${version}.tgz`);
}

function stampDoc(file) {
  const p = path.join(repoRoot, file);
  if (!fs.existsSync(p)) {
    warns.push(`${file}: not found — skipped`);
    return;
  }
  const lines = fs.readFileSync(p, "utf8").split("\n");
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    const out = stampDocLine(lines[i]);
    if (out !== lines[i]) {
      changes++;
      touched = true;
      console.log(`  ${CHECK ? "STALE" : "stamp"} ${file}:${i + 1}`);
      console.log(`    - ${lines[i].trim().slice(0, 140)}`);
      console.log(`    + ${out.trim().slice(0, 140)}`);
      lines[i] = out;
    }
    // small-count honesty warnings (never replaced, never exit-affecting): doors-surface claims
    for (const m of lines[i].matchAll(/\b(\d{1,2})[- ]tools?\b/g)) {
      if (Number(m[1]) < 50 && Number(m[1]) !== DOORS.length) {
        warns.push(`${file}:${i + 1}: says "${m[0]}" but REQUIRED_TOOLS names ${DOORS.length} doors-surface tools`);
      }
    }
    const dm = /\b(\d{1,2}) doors\b/.exec(lines[i]);
    if (dm && Number(dm[1]) !== DOORS.length && Number(dm[1]) !== DOORS.length - 1) {
      warns.push(`${file}:${i + 1}: says "${dm[0]}" but REQUIRED_TOOLS names ${DOORS.length} (incl. validate_toolchain)`);
    }
  }
  if (touched && !CHECK) fs.writeFileSync(p, lines.join("\n"));
}

function emit(file, before, after, edits) {
  if (after === before) return;
  changes++;
  console.log(`  ${CHECK ? "STALE" : "stamp"} ${file}: ${edits.join("; ") || "content drift vs the canonical manifest"}`);
  if (!CHECK) fs.writeFileSync(path.join(repoRoot, file), after);
}

function stampManifests() {
  // canonical manifest: .claude-plugin/plugin.json
  const canonBefore = read(".claude-plugin/plugin.json");
  const canon = JSON.parse(canonBefore);
  const edits = [];
  if (canon.version !== version) {
    edits.push(`version ${canon.version} -> ${version}`);
    canon.version = version;
  }
  const desc = countPhrases(canon.description ?? "");
  if (desc !== canon.description) {
    edits.push(`description tool count -> ${TOOLS}`);
    canon.description = desc;
  }
  const canonAfter = JSON.stringify(canon, null, 2) + "\n";
  emit(".claude-plugin/plugin.json", canonBefore, canonAfter, edits);

  // root plugin.json: an exact copy, so the two manifests structurally cannot drift
  const rootBefore = fs.existsSync(path.join(repoRoot, "plugin.json")) ? read("plugin.json") : "";
  emit("plugin.json", rootBefore, canonAfter, ["exact copy of .claude-plugin/plugin.json"]);

  // marketplace manifest
  const mpBefore = read(".claude-plugin/marketplace.json");
  const mp = JSON.parse(mpBefore);
  const mpEdits = [];
  if (mp.metadata?.version !== version) {
    mpEdits.push(`metadata.version ${mp.metadata?.version} -> ${version}`);
    mp.metadata = { ...(mp.metadata ?? {}), version };
  }
  if (mp.metadata?.description) {
    const d = countPhrases(mp.metadata.description);
    if (d !== mp.metadata.description) {
      mpEdits.push(`metadata.description tool count -> ${TOOLS}`);
      mp.metadata.description = d;
    }
  }
  for (const pl of mp.plugins ?? []) {
    const d = countPhrases(pl.description ?? "");
    if (d !== pl.description) {
      mpEdits.push(`plugins[${pl.name}].description tool count -> ${TOOLS}`);
      pl.description = d;
    }
  }
  emit(".claude-plugin/marketplace.json", mpBefore, JSON.stringify(mp, null, 2) + "\n", mpEdits);
}

console.log(CHECK ? "sync-metadata --check (dry run):" : "sync-metadata stamping:");
stampManifests();
for (const doc of ["README.md", "GETTING_STARTED.md", "TESTERS.md", "QUICKSTART.md", "AGENTS.md", "docs/HOSTS.md"]) stampDoc(doc);
for (const w of [...new Set(warns)]) console.log(`  WARN ${w}`);

if (CHECK) {
  console.log(`\n--check: ${changes} stale site(s), ${warns.length} warning(s).${changes ? " Run `npm run sync:meta` to stamp." : ""}`);
  process.exit(changes ? 1 : 0);
}
console.log(`\nstamped ${changes} site(s); ${warns.length} warning(s).`);
