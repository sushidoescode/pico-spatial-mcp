#!/usr/bin/env node
/**
 * sync-metadata — the single-source metadata stamper (v31).
 *
 * Two truths, read from files that already gate reality, get stamped everywhere they are published:
 *   - `version`             from package.json
 *   - the macOS and other-host full-surface counts from scripts/verify-tarball.mjs (the exact
 *     numbers the tarball gate asserts against an installed copy), plus the doors-name list at the
 *     head of REQUIRED_TOOLS (used only for small-count honesty WARNINGS, never for replacements).
 *
 * Stamped targets:
 *   - .claude-plugin/plugin.json      version + "NNN tools" phrases in the description
 *   - plugin.json                     portable Agent Plugins core: version + tool-count phrases
 *   - .claude-plugin/plugin.json      Claude-specific overlay: version + tool-count phrases
 *   - version-bearing host payload/marketplace manifests: version + any published tool-count
 *     phrases (portable core and every overlay keep their host-specific shapes)
 *   - README.md GETTING_STARTED.md TESTERS.md QUICKSTART.md SKILLS.md AGENTS.md docs/HOSTS.md
 *     docs/COLLABORATORS.md llms.txt
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
const otherHostToolsMatch = /const EXPECTED_OTHER_HOST_TOOLS = (\d+)/.exec(vt);
const reqMatch = /const REQUIRED_TOOLS = \[([\s\S]*?)\];/.exec(vt);
if (!toolsMatch || !otherHostToolsMatch || !reqMatch) {
  console.error("FATAL: cannot parse platform tool counts / REQUIRED_TOOLS from scripts/verify-tarball.mjs — its shape changed");
  process.exit(2);
}
const TOOLS = Number(toolsMatch[1]);
const OTHER_HOST_TOOLS = Number(otherHostToolsMatch[1]);
// the doors names are the run of entries before the "core lanes" comment in REQUIRED_TOOLS
const DOORS = [...reqMatch[1].split(/\/\/ core lanes/)[0].matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
if (DOORS.length < 10) {
  console.error(`FATAL: parsed only ${DOORS.length} doors names from REQUIRED_TOOLS — the doors/core-lanes comment boundary moved`);
  process.exit(2);
}
console.log(`truth: version=${version}  macOS-tools=${TOOLS}  other-host-tools=${OTHER_HOST_TOOLS}  doors=${DOORS.length}\n`);

// Every full-surface count this project has ever published (55/190/214/220/224 have all appeared in
// docs). Bare "~NNN" and "instead of NNN" forms are only replaced for THESE counts — a generic
// bare-number rule would eat measurements like "~90 s".
const PUBLISHED_COUNTS = [55, 190, 214, 220, 224, 233, 234, 238]
  .filter((c) => c !== TOOLS && c !== OTHER_HOST_TOOLS);

// v35.2: the OTHER-HOST count is published alongside the macOS one ("240 tools on macOS / 236 on
// other hosts") in docs AND in every host manifest description. The "NNN tools" rule below could
// not see it, because the other-host figure is usually written bare — so it silently drifted off
// truth for as long as the macOS number kept being stamped correctly. Anchor on the trailing
// "on other hosts" instead of on a "tools" suffix, and run it FIRST so the macOS rule then sees an
// already-correct value and leaves it alone.
const otherHostPhrases = (text) =>
  text.replace(/\b(\d{2,3})(\+?[- ]tools?)?(\s+on other hosts)\b/g, (m, d, suffix, tail) => (
    Number(d) >= 50 ? `${OTHER_HOST_TOOLS}${suffix ?? ""}${tail}` : m
  ));

/** "NNN tools" / "NNN-tool" phrases: any 2-3 digit count >= 50 that isn't the truth. */
const countPhrases = (text) =>
  otherHostPhrases(text).replace(/\b(\d{2,3})(\+?[- ]tools?)\b/g, (m, d, suffix) => (
    Number(d) >= 50 && ![TOOLS, OTHER_HOST_TOOLS].includes(Number(d)) ? `${TOOLS}${suffix}` : m
  ));

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

  // Portable Agent Plugins core: synchronize shared truths without replacing its closed schema
  // with Claude-only manifest fields.
  const rootBefore = read("plugin.json");
  const rootManifest = JSON.parse(rootBefore);
  const rootEdits = [];
  if (rootManifest.version !== version) {
    rootEdits.push(`version ${rootManifest.version} -> ${version}`);
    rootManifest.version = version;
  }
  const rootDescription = countPhrases(rootManifest.description ?? "");
  if (rootDescription !== rootManifest.description) {
    rootEdits.push(`description tool count -> ${TOOLS}`);
    rootManifest.description = rootDescription;
  }
  emit("plugin.json", rootBefore, JSON.stringify(rootManifest, null, 2) + "\n", rootEdits);

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
    if (pl.version !== version) {
      mpEdits.push(`plugins[${pl.name}].version ${pl.version} -> ${version}`);
      pl.version = version;
    }
    const d = countPhrases(pl.description ?? "");
    if (d !== pl.description) {
      mpEdits.push(`plugins[${pl.name}].description tool count -> ${TOOLS}`);
      pl.description = d;
    }
  }
  emit(".claude-plugin/marketplace.json", mpBefore, JSON.stringify(mp, null, 2) + "\n", mpEdits);

  // Host payloads have deliberately different accepted schemas; synchronize shared truths only.
  for (const file of [
    ".codex-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
  ]) {
    const before = read(file);
    const manifest = JSON.parse(before);
    const hostEdits = [];
    if (manifest.version !== version) {
      hostEdits.push(`version ${manifest.version} -> ${version}`);
      manifest.version = version;
    }
    const hostDescription = countPhrases(manifest.description ?? "");
    if (hostDescription !== manifest.description) {
      hostEdits.push(`description tool count -> ${TOOLS}`);
      manifest.description = hostDescription;
    }
    emit(file, before, JSON.stringify(manifest, null, 2) + "\n", hostEdits);
  }

  for (const file of [
    ".agents/plugins/marketplace.json",
    ".cursor-plugin/marketplace.json",
    ".github/plugin/marketplace.json",
  ]) {
    const before = read(file);
    const marketplace = JSON.parse(before);
    const hostEdits = [];
    if (marketplace.metadata && Object.hasOwn(marketplace.metadata, "version") && marketplace.metadata.version !== version) {
      hostEdits.push(`metadata.version ${marketplace.metadata.version} -> ${version}`);
      marketplace.metadata.version = version;
    }
    if (marketplace.metadata?.description) {
      const description = countPhrases(marketplace.metadata.description);
      if (description !== marketplace.metadata.description) {
        hostEdits.push(`metadata.description tool count -> ${TOOLS}`);
        marketplace.metadata.description = description;
      }
    }
    for (const plugin of marketplace.plugins ?? []) {
      if (plugin.version !== version) {
        hostEdits.push(`plugins[${plugin.name}].version ${plugin.version} -> ${version}`);
        plugin.version = version;
      }
      if (typeof plugin.description === "string") {
        const description = countPhrases(plugin.description);
        if (description !== plugin.description) {
          hostEdits.push(`plugins[${plugin.name}].description tool count -> ${TOOLS}`);
          plugin.description = description;
        }
      }
    }
    emit(file, before, JSON.stringify(marketplace, null, 2) + "\n", hostEdits);
  }
}

console.log(CHECK ? "sync-metadata --check (dry run):" : "sync-metadata stamping:");
stampManifests();
for (const doc of ["README.md", "GETTING_STARTED.md", "TESTERS.md", "QUICKSTART.md", "SKILLS.md", "AGENTS.md", "docs/HOSTS.md", "docs/COLLABORATORS.md", "llms.txt"]) stampDoc(doc);
for (const w of [...new Set(warns)]) console.log(`  WARN ${w}`);

if (CHECK) {
  console.log(`\n--check: ${changes} stale site(s), ${warns.length} warning(s).${changes ? " Run `npm run sync:meta` to stamp." : ""}`);
  process.exit(changes ? 1 : 0);
}
console.log(`\nstamped ${changes} site(s); ${warns.length} warning(s).`);
