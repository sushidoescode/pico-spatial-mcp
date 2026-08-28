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
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures += 1; };

const publishIdx = process.argv.indexOf("--publish");
const publishDir = publishIdx > -1 ? process.argv[publishIdx + 1] : null;

// [M3] Anchors: a count alone cannot see a rename, and a floor cannot see a whole lane vanishing.
const EXPECTED_TOOLS = 250; // capture_orbit/capture_multiview + surface-independent ensure_pico_cli + pico_loop (door 16, v36.4)
const EXPECTED_OTHER_HOST_TOOLS = 247;
// macOS exposes four host-GUI tools; other hosts intentionally expose one explanatory gui_capture
// stub. Assert the exact platform surface instead of hiding this documented delta in a tolerance.
const EXPECTED_PLATFORM_TOOLS = process.platform === "darwin" ? EXPECTED_TOOLS : EXPECTED_OTHER_HOST_TOOLS;
const REQUIRED_TOOLS = [
  // the 18 tools on the doors surface: 16 intent doors + two surface-independent utilities
  "validate_toolchain", "pico_build_app", "pico_scan_world", "pico_place", "pico_look",
  "pico_verify_app", "pico_measure", "pico_perf", "pico_sdk", "pico_doctor", "pico_ship",
  "pico_capabilities", "pico_fix", "pico_record", "pico_emulator", "pico_next", "pico_loop", "ensure_pico_cli",
  // core lanes whose loss a count check would tolerate
  "emulator_boot", "build_and_run", "capture_frame", "capture_settled", "record_verification", "scaffold_spatial_app",
  "adb_shell", "gradle_build", "preflight_env",
  "verify_gradle_config", "build_matrix_report",
  "generate_subwindow_kotlin", "generate_spatial_gestures_kotlin",
  "knowledge_api", "generate_ecs_system_kotlin", "generate_attachment_panel_kotlin", "generate_container_app_kotlin", "generate_skeletal_animation_kotlin", "generate_event_subscription_kotlin", "generate_bundle_lease_kotlin",
];
// [M2] Briefs the brief lane depends on; directory existence is not content.
const BRIEF_CANARIES = ["gallery.json", "knockdown.json"];
const MIN_BRIEFS = 10;

/** [M1] Derive the out-of-dist payload from the BUILT output, so a new dependency cannot slip past. */
function derivedSiblingDirs() {
  const dirs = new Set();
  for (const f of fs.readdirSync(path.join(repoRoot, "dist")).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(repoRoot, "dist", f), "utf8");
    // Two shapes appear in the built output: ("..", "briefs") and ("../briefs"). Matching only the
    // first missed the single-string form four shipped modules use.
    //
    // Scope matters in both directions. Matching ".." anywhere over-fires — editorcomponent emits
    // "../Assets/audio.wav" as a default value INTO a generated USD file, which resolves nothing and
    // names no directory we could ship. Restricting to lines that cite import.meta.url under-fires —
    // mousebridge computes its base once (`const here = ...`) and joins "tools" several lines later,
    // so `tools/` silently dropped out of the payload.
    //
    // A FILE-level gate is the honest granularity: only a module that resolves against itself can
    // have a sibling-of-dist dependency, and the false-positive file contains no import.meta.url at
    // all. Do not narrow this to per-line.
    if (!src.includes("import.meta.url")) continue;
    for (const m of src.matchAll(/["'`]\.\.["'`]\s*,\s*["'`]([A-Za-z0-9._-]+)["'`]/g)) dirs.add(m[1]);
    for (const m of src.matchAll(/["'`]\.\.\/([A-Za-z0-9._-]+)[^"'`]*["'`]/g)) dirs.add(m[1]);
  }
  // Created at runtime, never packaged — resolved as siblings of the INSTALL, not of dist.
  for (const runtime of [".pico-stacks", "golden"]) dirs.delete(runtime);
  return [...dirs].sort();
}

// [M6] The sandbox name deliberately contains a SPACE and a non-ASCII character. A review found nine
//      sites using `new URL(import.meta.url).pathname`, which keeps URL percent-encoding: a space
//      becomes %20 and an accented character becomes %C3%A9, so the resolved path does not exist.
//      That killed the whole `doors` surface and fleet_build for anyone whose install path had a
//      space in it — "~/My Projects", an accented username — and the old sandbox could never catch
//      it, because mkdtemp under /var/folders is always space-free. Every check below now runs in a
//      hostile path by default. Do not "clean up" this name.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pico mcp tester é "));
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

  // [M7] Docs the shipped PROMPTS instruct the agent to read. These are cited by name in prompt text
  //      rather than resolved as paths, so the [M1] derivation structurally cannot see them: a review
  //      found all five prompts opening with "Read SKILLS.md + DESIGN.md first" while neither was in
  //      the package. An unfollowable first instruction makes an agent stall or invent the rubric.
  for (const doc of ["SKILLS.md", "DESIGN.md", "GETTING_STARTED.md"]) {
    fs.existsSync(path.join(installed, doc))
      ? ok(`reader-facing doc ships: ${doc}`)
      : fail(`${doc} missing — the shipped prompts or TESTERS.md send the reader to it`);
  }

  // [M8] The app-skeleton generator payload (v29.3). The build lane used to clone a template that
  //      existed only on the author's machine, so every tarball install died at `scaffold failed` —
  //      the exact class of repo-green/tarball-broken failure this script exists for. Import the
  //      INSTALLED generator (pathToFileURL: the sandbox path contains a space — [M6]) and let its
  //      own canary list judge the payload, so a new canary is enforced here automatically.
  try {
    const pg = await import(pathToFileURL(path.join(installed, "dist", "projectgen.js")).href);
    const skel = pg.verifySkeleton();
    if (skel.ok) ok(`app skeleton ships complete and non-empty (${pg.SKELETON_CANARIES.length} canaries)`);
    else {
      if (skel.missing?.length) fail(`app skeleton incomplete in the tarball: ${skel.missing.join(", ")}`);
      // A 0-byte canary is the failure presence checks cannot see; it survives to break the build.
      if (skel.empty?.length) fail(`app skeleton ships EMPTY file(s): ${skel.empty.join(", ")}`);
    }
    (fs.statSync(path.join(installed, "appskeleton", "gradlew")).mode & 0o111)
      ? ok("appskeleton/gradlew kept its exec bit through pack+install")
      : fail("appskeleton/gradlew lost its exec bit — generated projects cannot build");
    fs.statSync(path.join(installed, "appskeleton", "gradle", "wrapper", "gradle-wrapper.jar")).size >= 40_000
      ? ok("gradle wrapper jar ships intact") : fail("gradle wrapper jar missing/truncated");
    fs.existsSync(path.join(installed, "appskeleton", "_gitignore"))
      ? ok("dot-less _gitignore survived packing (npm drops files named .gitignore)")
      : fail("appskeleton/_gitignore missing — generated projects would ship without a .gitignore");
    fs.statSync(pg.MENU_BUNDLE_ASSET).size >= 45_000
      ? ok("menu.bundle ships for GameMenu briefs") : fail("assets/menu.bundle missing/truncated — GameMenu briefs lose their panel");
  } catch (e) {
    fail(`app-skeleton payload check failed outright: ${e.message}`);
  }

  // [M8b] The Unity-lane payload (v30) — same class of risk as [M8]: repo-green, tarball-broken.
  try {
    const ug = await import(pathToFileURL(path.join(installed, "dist", "unitygen.js")).href);
    const uskel = ug.verifyUnitySkeleton();
    uskel.ok
      ? ok(`unity skeleton ships complete (${ug.UNITY_SKELETON_CANARIES.length} canaries)`)
      : fail(`unity skeleton incomplete in the tarball: ${[...uskel.missing, ...uskel.empty].join(", ")}`);
    fs.existsSync(path.join(installed, "unityskeleton", "_gitignore"))
      ? ok("unityskeleton _gitignore survived packing") : fail("unityskeleton/_gitignore missing");
  } catch (e) {
    fail(`unity-skeleton payload check failed outright: ${e.message}`);
  }

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

  // [M3] Exact count, plus named anchors. A floor or tolerance can hide a whole lane disappearing.
  tools.length === EXPECTED_PLATFORM_TOOLS
    ? ok(`installed server listed exactly ${EXPECTED_PLATFORM_TOOLS} tools for ${process.platform} (${EXPECTED_TOOLS} on the full macOS surface)`)
    : fail(`tool count ${tools.length} != exact ${process.platform} expectation ${EXPECTED_PLATFORM_TOOLS} (${EXPECTED_TOOLS} full macOS) — update EXPECTED_TOOLS deliberately if this is intended`);
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

  // [M6] Exercise the `doors` surface TESTERS.md tells people to start with. This is the check that
  //      would have caught the percent-encoding bug: door tools spawn an INNER full-surface server
  //      via StdioClientTransport using a module-relative script path and cwd, so a bad resolution
  //      surfaces as `spawn node ENOENT` — which reads like a missing Node, not a path bug.
  const doorsTransport = new StdioClientTransport({
    command: process.execPath, args: [entry], cwd: sandbox,
    env: { ...process.env, PICO_MCP_SURFACE: "doors" },
  });
  const doorsClient = new Client({ name: "tarball-verifier-doors", version: "0.0.0" });
  await doorsClient.connect(doorsTransport);
  const doorTools = await doorsClient.listTools();
  doorTools.tools.length === 18
    ? ok(`doors surface registered all 18 door tools`)
    : fail(`doors surface listed ${doorTools.tools.length} tools, expected 18`);
  const sdk = await doorsClient.callTool({ name: "pico_sdk", arguments: { symbol: "Entity" } });
  const sdkBody = JSON.parse(sdk.content[0].text);
  if (sdkBody.status === "ok") ok("a door tool completed its inner self-client spawn from a path containing a space");
  else if (sdkBody.status === "unavailable") ok("spaced-path inner spawn proven (vault absent on this machine; the unavailable answer still round-tripped through the spawned server)");
  else fail(`door tool failed in a spaced path: ${JSON.stringify(sdkBody).slice(0, 200)} — module-relative resolution is broken`);
  await doorsClient.close();

  // [M7] The CODED default (v36.3): env unset must serve the doors surface from the installed
  //      artifact. Docs always said doors; until v36.3 the code said full, so one missed env var
  //      exposed the full schema payload (86,927 o200k_base tokens over JSON.stringify(result.tools)
  //      returned by tools/list,
  //      measured 2026-08-12). Delete both vars so an inherited value cannot mask it.
  const defaultEnv = { ...process.env };
  delete defaultEnv.PICO_MCP_SURFACE;
  delete defaultEnv.PICO_MCP_OUTER_SURFACE;
  const defaultTransport = new StdioClientTransport({
    command: process.execPath, args: [entry], cwd: sandbox, env: defaultEnv,
  });
  const defaultClient = new Client({ name: "tarball-verifier-default", version: "0.0.0" });
  await defaultClient.connect(defaultTransport);
  const defaultTools = await defaultClient.listTools();
  defaultTools.tools.length === 18
    ? ok("PICO_MCP_SURFACE unset serves the 18-tool doors surface (full stays explicit opt-in)")
    : fail(`env-unset default listed ${defaultTools.tools.length} tools, expected the 18-tool doors surface`);
  await defaultClient.close();

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
