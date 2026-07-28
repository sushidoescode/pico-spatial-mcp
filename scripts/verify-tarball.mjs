#!/usr/bin/env node
/**
 * verify-tarball — proves the published tarball actually works for someone who has ONLY the tarball.
 *
 * The failure this exists to catch: `files: ["dist"]` packs a server that starts fine and then throws
 * at runtime, because several tools resolve `briefs/`, `scripts/py/` and `tools/` as siblings of
 * `dist/`. A smoke test run inside the repo cannot see that bug — the repo has those directories.
 *
 * So this packs, installs into a throwaway directory OUTSIDE the repo, and drives the INSTALLED
 * copy over stdio with its cwd set to the sandbox. Nothing here reads the repo's dist or node_modules.
 *
 * Run: npm run verify:tarball
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

// Runtime payload that lives OUTSIDE dist/ and is resolved relative to it. Each entry is a real
// runtime dependency, not a nice-to-have — the comment says which module reaches for it.
const REQUIRED_PAYLOAD = [
  ["briefs", "eval.ts / factory.ts / virtualcamera.ts resolve ../briefs"],
  ["scripts/py/splat_perspective.py", "virtualcamera.ts renders through this"],
  ["scripts/py/detect_colorkey.py", "capture/colour-key analysis"],
  ["scripts/restart-emulator.sh", "emulator lifecycle"],
  ["scripts/macos/cmio-camera-writer.m", "virtual-camera producer source"],
  ["tools/mouse_menu_bridge.py", "mousebridge.ts resolves ../tools"],
];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pico-mcp-tester-"));
console.log(`sandbox: ${sandbox}\n`);

try {
  // 1. Pack. `prepack` rebuilds dist, so the tarball can never ship stale output.
  const pack = spawnSync("npm", ["pack", "--pack-destination", sandbox], {
    cwd: repoRoot, encoding: "utf8", timeout: 300_000,
  });
  if (pack.status !== 0) { fail(`npm pack failed: ${pack.stderr?.slice(-500)}`); process.exit(1); }
  const tarball = fs.readdirSync(sandbox).find((f) => f.endsWith(".tgz"));
  if (!tarball) { fail("npm pack produced no .tgz"); process.exit(1); }
  ok(`packed ${tarball} (${(fs.statSync(path.join(sandbox, tarball)).size / 1024).toFixed(0)} kB)`);

  // 2. Install into the sandbox as a consumer would. --omit=dev proves devDependencies
  //    (typescript, @types/node) are genuinely not needed at runtime.
  const install = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", path.join(sandbox, tarball)], {
    cwd: sandbox, encoding: "utf8", timeout: 600_000,
  });
  if (install.status !== 0) { fail(`npm install failed: ${install.stderr?.slice(-800)}`); process.exit(1); }
  ok("installed into a clean directory with --omit=dev");

  const installed = path.join(sandbox, "node_modules", "pico-spatial-mcp");
  if (!fs.existsSync(installed)) { fail(`package missing at ${installed}`); process.exit(1); }

  // 3. The payload check — the whole reason this script exists.
  for (const [rel, why] of REQUIRED_PAYLOAD) {
    fs.existsSync(path.join(installed, rel))
      ? ok(`payload present: ${rel}`)
      : fail(`payload MISSING: ${rel}  (${why})`);
  }

  // 4. Junk that must NOT ship — checked RECURSIVELY.
  //    An earlier version only looked at the package root and passed a tarball that shipped
  //    tools/__pycache__ and scripts/py/__pycache__. A top-level check is not a check.
  const offenders = [];
  const leaks = [];
  const HOME_RE = /\/Users\/[A-Za-z0-9._-]+\//g;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(installed, p);
      if (e.isDirectory()) {
        if (["__pycache__", ".dev", ".superpowers", ".pico-stacks"].includes(e.name)) offenders.push(rel);
        else walk(p);
      } else {
        if (e.name.endsWith(".pyc") || e.name === ".DS_Store") offenders.push(rel);
        // Absolute local paths leak the author's username into every install. .pyc files embed
        // them invisibly, which is exactly how this got missed the first time.
        if (/\.(mjs|js|ts|json|md|py|sh|m)$/.test(e.name)) {
          const hits = (fs.readFileSync(p, "utf8").match(HOME_RE) || []);
          if (hits.length) leaks.push(`${rel} (${[...new Set(hits)].slice(0, 2).join(", ")})`);
        }
      }
    }
  })(installed);
  offenders.length ? fail(`unwanted content shipped: ${offenders.join(", ")}`) : ok("no build droppings anywhere in the package");
  leaks.length ? fail(`absolute local paths leak in: ${leaks.slice(0, 5).join("; ")}`) : ok("no absolute local paths in shipped text files");

  // 4b. A tarball recipient has no repo, so the docs written for repo users must not be the only
  //     onboarding. Require a tarball-facing guide to be present.
  fs.existsSync(path.join(installed, "TESTERS.md"))
    ? ok("TESTERS.md ships (tarball recipients have install instructions)")
    : fail("TESTERS.md missing — a tarball recipient has no working install path in the docs");

  // 5. Boot the INSTALLED server over stdio, cwd = sandbox, and list its tools. This is the real
  //    consumer path: if a tool's module-load-time code reaches for a repo path, it dies here.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const entry = path.join(installed, "dist", "index.js");
  if (!fs.existsSync(entry)) { fail(`bin entry missing: ${entry}`); process.exit(1); }
  if (!fs.readFileSync(entry, "utf8").startsWith("#!")) fail("dist/index.js lost its shebang — npx would break");
  else ok("bin entry has a shebang");

  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry], cwd: sandbox,
    env: { ...process.env, PICO_MCP_SURFACE: "full" },
  });
  const client = new Client({ name: "tarball-verifier", version: "0.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  tools.length > 150
    ? ok(`installed server started from the sandbox and listed ${tools.length} tools`)
    : fail(`only ${tools.length} tools listed — expected the full surface`);

  // 6. Prove a tool that depends on out-of-dist payload is actually reachable, by calling a
  //    read-only one and checking it does not fail on a missing file.
  const doctor = await client.callTool({ name: "preflight_env", arguments: {} });
  const body = JSON.parse(doctor.content[0].text);
  Array.isArray(body.checks) && body.checks.length > 0
    ? ok(`preflight_env ran from the installed copy (${body.checks.length} checks, status: ${body.status})`)
    : fail("preflight_env returned an unexpected shape");

  await client.close();

  console.log("\n--- MCP config a tester would use ---");
  console.log(JSON.stringify({
    mcpServers: {
      "pico-spatial-mcp": { command: "node", args: [path.join("<install-dir>", "node_modules", "pico-spatial-mcp", "dist", "index.js")] },
    },
  }, null, 2));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\nTarball verification done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
