#!/usr/bin/env node
/**
 * verify-tarball — proves the published tarball works for someone who has ONLY the tarball.
 *
 * The failure this exists to catch: several modules resolve `briefs/`, `scripts/py/` and `tools/`
 * as siblings of `dist/`. A smoke test run inside the repo cannot see them missing from the package,
 * because the repo always has them. So this packs, installs into a throwaway directory OUTSIDE the
 * repo, and drives the INSTALLED copy over stdio.
 *
 * A mutation audit of an earlier version found five ways to ship a broken tarball green. Each fix is
 * marked [Mn] below so nobody weakens one without knowing what it was for:
 *   [M1] payload was a hand-maintained allowlist -> now DERIVED from the built dist.
 *   [M2] `briefs` passed on directory existence alone -> now asserts content + named canaries.
 *   [M3] tools.length > 150 tolerated losing 69 tools -> now exact count + named anchors.
 *   [M4] leak scan required a trailing slash and only read 8 extensions -> now byte-scans everything.
 *   [M5] the gate verified a tarball it packed, never the one that ships -> --publish makes the
 *        shipped artifact BE the verified artifact, by construction.
 *
 * Run:  npm run test:tarball
 *       npm run test:tarball -- --publish ~/.pico-mcp/dist
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures += 1; };

const publishIdx = process.argv.indexOf("--publish");
const publishDir = publishIdx > -1 ? process.argv[publishIdx + 1] : null;

// [M3] Anchors: a count alone cannot see a rename, and a floor cannot see a whole lane vanishing.
const EXPECTED_TOOLS = 220;
const TOOL_TOLERANCE = 3;
const REQUIRED_TOOLS = [
  // the 13 doors TESTERS.md promises
  "validate_toolchain", "pico_build_app", "pico_scan_world", "pico_place", "pico_look",
  "pico_verify_app", "pico_measure", "pico_perf", "pico_sdk", "pico_doctor", "pico_ship",
  "pico_capabilities", "pico_fix",
  // core lanes whose loss a count check would tolerate
  "emulator_boot", "build_and_run", "capture_frame", "record_verification", "scaffold_spatial_app",
  "adb_shell", "gradle_build", "preflight_env",
];
// [M2] Briefs the brief lane depends on; directory existence is not content.
const BRIEF_CANARIES = ["gallery.json", "knockdown.json"];
const MIN_BRIEFS = 10;

/** [M1] Derive the out-of-dist payload from the BUILT output, so a new dependency cannot slip past. */
function derivedSiblingDirs() {
  const dirs = new Set();
  for (const f of fs.readdirSync(path.join(repoRoot, "dist")).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(repoRoot, "dist", f), "utf8");
    for (const m of src.matchAll(/["'`]\.\.["'`]\s*,\s*["'`]([A-Za-z0-9._-]+)["'`]/g)) dirs.add(m[1]);
  }
  // Created at runtime, never packaged — resolved as siblings of the INSTALL, not of dist.
  for (const runtime of [".pico-stacks", "golden"]) dirs.delete(runtime);
  return [...dirs].sort();
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pico-mcp-tester-"));
console.log(`sandbox: ${sandbox}\n`);
let verifiedTarball = null;

try {
  const pack = spawnSync("npm", ["pack", "--pack-destination", sandbox], { cwd: repoRoot, encoding: "utf8", timeout: 600_000 });
  if (pack.status !== 0) { fail(`npm pack failed: ${(pack.stderr || pack.stdout || "").slice(-800)}`); process.exit(1); }
  const tarball = fs.readdirSync(sandbox).find((f) => f.endsWith(".tgz"));
  if (!tarball) { fail("npm pack produced no .tgz"); process.exit(1); }
  verifiedTarball = path.join(sandbox, tarball);
  ok(`packed ${tarball} (${(fs.statSync(verifiedTarball).size / 1024).toFixed(0)} kB)`);

  const install = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", verifiedTarball], {
    cwd: sandbox, encoding: "utf8", timeout: 900_000,
  });
  if (install.status !== 0) { fail(`npm install failed: ${install.stderr?.slice(-800)}`); process.exit(1); }
  ok("installed into a clean directory with --omit=dev");

  const installed = path.join(sandbox, "node_modules", "pico-spatial-mcp");
  if (!fs.existsSync(installed)) { fail(`package missing at ${installed}`); process.exit(1); }

  // [M1] Every sibling directory the built code reaches for must actually ship.
  const needed = derivedSiblingDirs();
  ok(`derived out-of-dist dependencies from the build: ${needed.join(", ")}`);
  for (const d of needed) {
    fs.existsSync(path.join(installed, d)) ? ok(`payload present: ${d}/`) : fail(`payload MISSING: ${d}/ — the built code resolves it`);
  }

  // [M2] Content, not just a directory.
  const briefDir = path.join(installed, "briefs");
  if (fs.existsSync(briefDir)) {
    const briefs = fs.readdirSync(briefDir).filter((f) => f.endsWith(".json"));
    briefs.length >= MIN_BRIEFS ? ok(`briefs/ carries ${briefs.length} briefs`) : fail(`briefs/ has only ${briefs.length} briefs (expected >= ${MIN_BRIEFS})`);
    for (const c of BRIEF_CANARIES) {
      const p = path.join(briefDir, c);
      if (!fs.existsSync(p)) { fail(`brief canary missing: ${c}`); continue; }
      try { JSON.parse(fs.readFileSync(p, "utf8")); ok(`brief canary parses: ${c}`); }
      catch (e) { fail(`brief canary is not valid JSON: ${c} (${e.message})`); }
    }
  }

  // [M4] Byte-scan EVERY shipped file. The old version required a trailing slash after the
  //      username and only opened eight extensions, so .cfg/.txt/extensionless leaks sailed through.
  const offenders = [];
  const leaks = [];
  const LEAK_RE = /(\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Z]:\\Users\\[A-Za-z0-9._-]+)/g;
  const SKIP_LEAK_SCAN = new Set([".ktx", ".png", ".jpg", ".glb", ".ply", ".bundle", ".zip", ".tgz"]);
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(installed, p);
      if (e.isDirectory()) {
        if (["__pycache__", ".dev", ".superpowers", ".pico-stacks", ".venv", ".pytest_cache"].includes(e.name)) offenders.push(rel);
        else walk(p);
      } else {
        if (e.name.endsWith(".pyc") || e.name === ".DS_Store") offenders.push(rel);
        const st = fs.statSync(p);
        if (st.size > 8 * 1024 * 1024 || SKIP_LEAK_SCAN.has(path.extname(e.name))) continue;
        const hits = fs.readFileSync(p).toString("latin1").match(LEAK_RE);
        if (hits) leaks.push(`${rel} (${[...new Set(hits)].slice(0, 2).join(", ")})`);
      }
    }
  })(installed);
  offenders.length ? fail(`build droppings shipped: ${offenders.join(", ")}`) : ok("no build droppings anywhere in the package");
  leaks.length ? fail(`absolute home paths leak in: ${leaks.slice(0, 6).join("; ")}`) : ok("no absolute home paths in any shipped file");

  fs.existsSync(path.join(installed, "TESTERS.md"))
    ? ok("TESTERS.md ships")
    : fail("TESTERS.md missing — a tarball recipient has no working install path");

  const entry = path.join(installed, "dist", "index.js");
  if (!fs.existsSync(entry)) { fail(`bin entry missing: ${entry}`); process.exit(1); }
  fs.readFileSync(entry, "utf8").startsWith("#!") ? ok("bin entry has a shebang") : fail("dist/index.js lost its shebang — npx would break");

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry], cwd: sandbox,
    env: { ...process.env, PICO_MCP_SURFACE: "full" },
  });
  const client = new Client({ name: "tarball-verifier", version: "0.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));

  // [M3] Exact-with-tolerance, plus names. A floor tolerated an entire lane disappearing.
  Math.abs(tools.length - EXPECTED_TOOLS) <= TOOL_TOLERANCE
    ? ok(`installed server listed ${tools.length} tools (expected ~${EXPECTED_TOOLS})`)
    : fail(`tool count ${tools.length} is outside ${EXPECTED_TOOLS}+/-${TOOL_TOLERANCE} — update EXPECTED_TOOLS deliberately if this is intended`);
  const missing = REQUIRED_TOOLS.filter((t) => !names.has(t));
  missing.length ? fail(`required tools absent: ${missing.join(", ")}`) : ok(`all ${REQUIRED_TOOLS.length} anchor tools present`);

  const doctor = await client.callTool({ name: "preflight_env", arguments: {} });
  const body = JSON.parse(doctor.content[0].text);
  Array.isArray(body.checks) && body.checks.length > 0
    ? ok(`preflight_env ran from the installed copy (${body.checks.length} checks, status: ${body.status})`)
    : fail("preflight_env returned an unexpected shape");
  const badFix = (body.checks || []).filter((c) => c.status !== "pass" && /npm ci|npm run build/.test(c.fix || ""));
  badFix.length
    ? fail(`preflight advises repo-only commands a tarball user cannot run: ${badFix.map((c) => c.name).join(", ")}`)
    : ok("preflight fixes contain no repo-only commands");

  await client.close();

  // [M5] Publish only what passed, so the shipped artifact IS the verified artifact.
  if (publishDir && failures === 0) {
    const dest = path.resolve(publishDir.replace(/^~/, os.homedir()));
    fs.mkdirSync(dest, { recursive: true });
    for (const old of fs.readdirSync(dest).filter((f) => f.endsWith(".tgz"))) fs.rmSync(path.join(dest, old));
    const out = path.join(dest, path.basename(verifiedTarball));
    fs.copyFileSync(verifiedTarball, out);
    ok(`published the VERIFIED tarball to ${out}`);
  } else if (publishDir) {
    fail("not publishing: verification failed");
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\nTarball verification done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
