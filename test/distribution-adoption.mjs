import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedRuntimeHarness, publishManagedFixtureVersion } from "./helpers/picocli-managed-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeNodeCommand(binDir, name, driverPath) {
  if (process.platform === "win32") {
    const command = path.join(binDir, `${name}.cmd`);
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${driverPath}" %*\r\n`);
    return command;
  }
  const command = path.join(binDir, name);
  writeExecutable(command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(driverPath)} "$@"\n`);
  return command;
}

function waitForFile(file, timeoutMs = 3_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function installPackedArtifactWithoutNetwork() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico packed adoption "));
  const packRoot = path.join(root, "packed");
  const installRoot = path.join(root, "installed");
  const modulesRoot = path.join(installRoot, "node_modules");
  const installed = path.join(modulesRoot, "pico-spatial-mcp");
  fs.mkdirSync(packRoot, { recursive: true });
  fs.mkdirSync(installed, { recursive: true });

  const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const tarballs = fs.readdirSync(packRoot).filter((file) => file.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, JSON.stringify(tarballs));
  const extract = spawnSync("tar", [
    "-xzf", path.join(packRoot, tarballs[0]), "--strip-components=1", "-C", installed,
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(extract.status, 0, extract.stderr || extract.stdout);

  // The artifact is installed without `npm install` or network access. Link only the already
  // installed runtime dependencies; the package bytes themselves all come from the tarball.
  for (const dependency of Object.keys(readJson("package.json").dependencies)) {
    const source = path.join(repoRoot, "node_modules", ...dependency.split("/"));
    const target = path.join(modulesRoot, ...dependency.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  }

  return { root, installRoot, installed, entry: path.join(installed, "dist", "index.js") };
}

const MANAGED_POLICY_START = "<!-- pico-mcp-managed-cli-policy:start -->";
const MANAGED_POLICY_END = "<!-- pico-mcp-managed-cli-policy:end -->";
const CANONICAL_MANAGED_POLICY_BLOCK = `
\`managed-latest\` is the default. Resolution is lazy on the first real CLI-backed operation.
Server startup, tool registration and \`tools/list\`, \`preflight_env\`, and the default
\`pico_doctor {}\` inspect only an existing cache: they make no npm request, provision nothing, and
write nothing to the managed store. The explicit \`pico_doctor {calibrate:true}\` exception is
mutating because it runs the separately documented calibration workflow.

Each exact version is published as an immutable MCP-owned cache entry. The ambient global CLI and
\`PATH\` remain untouched. A successful registry lookup reports registry-latest as of \`checkedAt\`.
If that lookup fails, a validated cached fallback is labeled \`unknown\`; if a known-newer install
fails, it is labeled \`outdated\`. Neither fallback is ever called latest.

Set \`PICO_MCP_CLI_POLICY\` only when the default is not appropriate:

- \`managed-latest\` — lazily resolve and, on first CLI use, provision the exact registry version.
- \`managed-cached\` — use only a validated cached version, without registry or install work.
- \`external\` — run only the absolute \`PICO_MCP_CLI_PATH\`; it is never updated by the MCP.
- \`disabled\` — turn off CLI-backed operations.

Through 37.x, the deprecated aliases \`PICO_MCP_AUTOINSTALL_CLI=1\` and
\`PICO_MCP_AUTOUPDATE_CLI=1\` map to \`managed-latest\`; they never install globally and conflict with
another explicit policy. \`ensure_pico_cli\` is the force-refresh health path. Its deprecated
\`update\` input is inert and accepted only for compatibility.

Package activation and utility setup are separate. Call \`ensure_pico_cli\`, then manually run its
returned absolute path with args \`["setup"]\` if the CLI reports an unprovisioned utility payload.
The MCP never runs setup. It also never runs \`update --check\`, because that command writes a local
update cache; freshness comes from the registry lookup instead.

\`0.4.2\` was registry latest on 2026-08-14, an observed value rather than a timeless pin. A v1.0
date supplied by the user/PICO team is planning input, not repository-verified release evidence.
The compatibility sweep is version-agnostic and covers the complete reachable advertised
help-only tree except the prohibited top-level setup subtree. It does not establish semantic
compatibility, hidden-alias longevity, perf provisioning, emulator/device/Windows behavior, or
visual evidence.
`.trim();

function extractManagedPolicyBlock(markdown, file) {
  const starts = markdown.split(MANAGED_POLICY_START).length - 1;
  const ends = markdown.split(MANAGED_POLICY_END).length - 1;
  assert.equal(starts, 1, `${file}: exactly one managed-policy start marker`);
  assert.equal(ends, 1, `${file}: exactly one managed-policy end marker`);
  const start = markdown.indexOf(MANAGED_POLICY_START) + MANAGED_POLICY_START.length;
  const end = markdown.indexOf(MANAGED_POLICY_END, start);
  assert.ok(end > start, `${file}: managed-policy markers are ordered`);
  return markdown.slice(start, end).trim();
}

const contradictoryManagedPolicyPatterns = [
  /\b(?:the\s+)?(?:mcp|server|plugin|runtime|service|tool)\b[^.\n]{0,100}\b(?:runs?|running|invokes?|invoking|executes?|executing|performs?|performing|launches?|launching|calls?|calling|starts?|starting|triggers?|triggering|handles?|handling)\b[^.\n]{0,60}\b(?:pico-cli\s+)?setup\b/i,
  /\b(?:the\s+)?(?:mcp|server|plugin|runtime|service|tool)\b[^.\n]{0,100}\b(?:runs?|running|invokes?|invoking|executes?|executing|performs?|performing|launches?|launching|calls?|calling|starts?|starting|triggers?|triggering|handles?|handling)\b[^.\n]{0,60}\b(?:pico-cli\s+)?update\s+--check\b/i,
  /\b(?:pico-cli\s+)?setup\b[^.\n]{0,80}\b(?:is|gets?|will\s+be|can\s+be)\s+(?:automatically\s+)?(?:run|invoked|executed|performed|launched|called|started|triggered|handled)\b/i,
  /\b(?:pico-cli\s+)?update\s+--check\b[^.\n]{0,80}\b(?:is|gets?|will\s+be|can\s+be)\s+(?:automatically\s+)?(?:run|invoked|executed|performed|launched|called|started|triggered|handled)\b/i,
  /\b(?:pico-cli\s+)?(?:setup|update\s+--check)\b[^.\n]{0,60}\b(?:is|becomes?|will\s+be)\s+automatic\b/i,
  /\bautomatically\b[^.\n]{0,80}\b(?:pico-cli\s+)?(?:setup|update\s+--check)\b/i,
  /\b(?:pico-cli\s+)?(?:setup|update\s+--check)\b[^.\n]{0,80}\bautomatically\b/i,
  // Policy-defining vocabulary belongs only to the exact canonical block. Keeping it out of the
  // surrounding prose makes appended alternate defaults/modes fail closed instead of requiring a
  // finite list of every possible negation.
  /\bmanaged-(?:latest|cached)\b/i,
  /\bPICO_MCP_CLI_(?:POLICY|PATH)\b/i,
  /\bPICO_MCP_AUTO(?:INSTALL|UPDATE)_CLI\b/i,
  /\bregistry-latest\b/i,
  /\b(?:fallback\b[^.\n]{0,100}\blatest|latest\b[^.\n]{0,100}\bfallback)\b/i,
  /\b(?:mcp|server|plugin|runtime|service|tool)\b[^.\n]{0,100}\b(?:modifies?|changes?|rewrites?|replaces?|exports?|prepends?|appends?|mutates?|updates?)\b[^.\n]{0,60}\bPATH\b/i,
  /\bPATH\b[^.\n]{0,100}\b(?:is|gets?|will\s+be|can\s+be)?\s*(?:modified|changed|rewritten|replaced|exported|prepended|appended|mutated|updated)\b/i,
];

const ALTERNATE_CLI_RESOLUTION_TOKENS = new Set(["external", "disabled", "ambient", "global"]);
const POLICY_CLAIM_CONTEXT_TOKENS = new Set([
  "default",
  "defaults",
  "mode",
  "modes",
  "policy",
  "policies",
  "resolution",
  "resolver",
]);

function alternateManagedPolicyClaims(markdown) {
  return String(markdown)
    .replace(/\r\n/g, "\n")
    .split(/(?:\n[ \t]*){2,}|(?<=[.!?;])(?:[ \t]+|\n+)|\n(?=[ \t]*(?:#{1,6}[ \t]|[-*+][ \t]|\d+\.[ \t]|```|>))/)
    .map((clause) => ({
      clause: clause.replace(/\s+/g, " ").trim(),
      tokens: new Set(clause.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? []),
    }))
    .filter(({ clause, tokens }) => clause.length > 0
      && [...ALTERNATE_CLI_RESOLUTION_TOKENS].some((token) => tokens.has(token))
      && [...POLICY_CLAIM_CONTEXT_TOKENS].some((token) => tokens.has(token)))
    .map(({ clause }) => clause);
}

function assertNoAppendedManagedPolicyClaims(markdown, file) {
  const start = markdown.indexOf(MANAGED_POLICY_START);
  const end = markdown.indexOf(MANAGED_POLICY_END, start + MANAGED_POLICY_START.length);
  const outsideCanonical = start >= 0 && end >= 0
    ? `${markdown.slice(0, start)}\n${markdown.slice(end + MANAGED_POLICY_END.length)}`
    : markdown;
  for (const pattern of contradictoryManagedPolicyPatterns) {
    assert.doesNotMatch(outsideCanonical, pattern, `${file}: contradictory or duplicate managed policy claim outside canonical block`);
  }
  assert.deepEqual(
    alternateManagedPolicyClaims(outsideCanonical),
    [],
    `${file}: alternate external/disabled/ambient/global CLI policy claim outside canonical block`,
  );
}

function assertCanonicalManagedPolicyDocument(markdown, file) {
  assert.equal(extractManagedPolicyBlock(markdown, file), CANONICAL_MANAGED_POLICY_BLOCK, `${file}: canonical policy bytes`);
  assertNoAppendedManagedPolicyClaims(markdown, file);
}

function assertNoActionableBareSetup(text, label) {
  const offending = String(text)
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((clause) => /\bpico-cli\s+setup\b/i.test(clause))
    .filter((clause) => {
      const negatedActive = /\b(?:never|does\s+not|do\s+not|will\s+not|cannot|can\s+not)\b[^.!?;\n]{0,80}\b(?:runs?|invokes?|executes?|performs?|launches?|calls?|starts?|triggers?)\b[^.!?;\n]{0,20}\bpico-cli\s+setup\b/i.test(clause);
      const negatedPassive = /\bpico-cli\s+setup\b[^.!?;\n]{0,50}\b(?:is|will\s+be|can\s+be)\s+(?:never|not)\s+(?:run|invoked|executed|performed|launched|called|started|triggered)\b/i.test(clause);
      const actionableOverride = /\b(?:should|must|please|manually|then)\b[^.!?;\n]{0,40}\b(?:run|invoke|execute|perform|launch|call|start|trigger)\b[^.!?;\n]{0,20}\bpico-cli\s+setup\b/i.test(clause);
      return (!negatedActive && !negatedPassive) || actionableOverride;
    });
  assert.deepEqual(offending, [], `${label}: actionable bare pico-cli setup guidance: ${offending.join(" | ")}`);
}

function canonicalManagedCliPath(managedRoot, version) {
  return path.join(
    managedRoot,
    "versions",
    version,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "pico-cli.cmd" : "pico-cli",
  );
}

function assertCanonicalManagedCliPath(actual, managedRoot, version) {
  assert.equal(actual, canonicalManagedCliPath(managedRoot, version));
}

function validateTrackedMarkdownCitation({ link, sourceFile, root, tracked }) {
  const fragmentAt = link.indexOf("#");
  const target = fragmentAt === -1 ? link : link.slice(0, fragmentAt);
  const anchor = fragmentAt === -1 ? null : link.slice(fragmentAt + 1);
  assert.doesNotMatch(target, /^(?:[A-Za-z][A-Za-z0-9+.-]*:|~|\/|\\\\|[A-Za-z]:[\\/])/, `citation must be repo-relative: ${link}`);
  assert.doesNotMatch(target, /(?:^|\/)\.dev(?:\/|$)/, `citation must not use .dev: ${link}`);
  const decodedTarget = decodeURIComponent(target);
  assert.doesNotMatch(decodedTarget, /^(?:[A-Za-z][A-Za-z0-9+.-]*:|~|\/|\\\\|[A-Za-z]:[\\/])/, `decoded citation must be repo-relative: ${link}`);
  assert.equal(path.normalize(decodedTarget).split(/[\\/]+/).includes(".dev"), false, `decoded citation must not use .dev: ${link}`);
  const lexicalRoot = path.resolve(root);
  const resolved = path.resolve(path.dirname(sourceFile), decodedTarget);
  assert.ok(resolved.startsWith(`${lexicalRoot}${path.sep}`), `citation escapes the repository: ${link}`);
  assert.equal(fs.existsSync(resolved), true, `citation target does not exist: ${link}`);
  const realRoot = fs.realpathSync(lexicalRoot);
  const realTarget = fs.realpathSync(resolved);
  const realRelative = path.relative(realRoot, realTarget);
  assert.ok(
    realRelative !== ""
      && realRelative !== ".."
      && !realRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(realRelative),
    `citation resolves outside the repository: ${link}`,
  );
  assert.equal(path.normalize(realRelative).split(/[\\/]+/).includes(".dev"), false, `citation real target must not use .dev: ${link}`);
  const relative = path.normalize(path.relative(lexicalRoot, resolved));
  assert.equal(tracked.has(relative), true, `citation target is not tracked: ${link}`);
  assert.equal(tracked.has(path.normalize(realRelative)), true, `citation real target is not tracked: ${link}`);
  if (anchor !== null) {
    const range = /^L(\d+)(?:-L(\d+))?$/.exec(anchor);
    assert.ok(range, `malformed line anchor: ${link}`);
    const first = Number(range[1]);
    const last = Number(range[2] ?? range[1]);
    const lineCount = fs.readFileSync(resolved, "utf8").split(/\r?\n/).length;
    assert.ok(first >= 1 && first <= last && last <= lineCount, `line anchor outside ${relative} (${lineCount} lines): ${link}`);
  }
}

function decodePublicEvidenceText(value) {
  let decoded = value;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Decode only path-significant octets. Unlike decodeURIComponent(document), this keeps going
    // past an unrelated literal/malformed percent and also peels bounded double-encoding.
    const next = decoded.replace(/%(?:25|2e|2f|5c)/gi, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replaceAll("\\", "/");
}

function assertNoPrivateDevCitation(contents, file) {
  const decoded = decodePublicEvidenceText(contents);
  assert.doesNotMatch(
    decoded,
    /(?:^|[\/\s(`])\.dev(?:[\/\s`)#]|$)/im,
    `${file} cites ignored .dev evidence`,
  );
  // Decode each target independently. A literal/malformed percent elsewhere in the document must
  // not prevent a later encoded private citation from being recognized.
  for (const match of contents.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const decodedTarget = decodePublicEvidenceText(match[1]);
    const target = decodedTarget.split("#", 1)[0];
    const normalized = path.posix.normalize(target);
    assert.equal(
      normalized.split("/").some((segment) => segment.toLowerCase() === ".dev"),
      false,
      `${file} normalizes to ignored .dev evidence: ${match[1]}`,
    );
  }
}

function extractLedgerLabels(markdown) {
  return [...new Set([...markdown.matchAll(/\b([A-Za-z0-9._-]+)#(\d+)\b/g)]
    .map((match) => `${match[1]}#${match[2]}`))];
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

function waitForJsonLine(file, predicate, timeoutMs = 6_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const match = readJsonLines(file).find(predicate);
      if (match) return resolve(match);
      if (Date.now() - started >= timeoutMs) return reject(new Error(`timed out waiting for event in ${file}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function mcpText(result) {
  return (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

test("portable core and host overlays use only their documented MCP contracts", () => {
  const pkg = readJson("package.json");
  const portable = readJson("plugin.json");
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(portable.name, pkg.name);
  assert.equal(portable.version, pkg.version);
  assert.deepEqual(Object.keys(portable).sort(), [
    "$schema", "author", "description", "homepage", "keywords", "license", "name", "repository", "version",
  ]);

  const portableMcp = readJson("mcp.json");
  assert.deepEqual(portableMcp, {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      "pico-spatial-mcp": {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/scripts/plugin-bootstrap.mjs"],
      },
    },
  });

  const claude = readJson(".claude-plugin/plugin.json");
  assert.equal(claude.name, pkg.name);
  assert.equal(claude.version, pkg.version);
  assert.equal(claude.mcpServers, "./.mcp.claude.json");
  assert.equal(fs.existsSync(path.join(repoRoot, ".mcp.claude.json")), true);

  const codex = readJson(".codex-plugin/plugin.json");
  assert.deepEqual(Object.keys(codex).sort(), ["author", "description", "interface", "name", "version"]);
  assert.equal(codex.version, pkg.version);
  for (const key of ["displayName", "shortDescription", "longDescription", "developerName", "category", "capabilities", "websiteURL", "defaultPrompt"]) {
    assert.ok(codex.interface[key], `.codex-plugin/plugin.json interface.${key}`);
  }
  assert.ok(Array.isArray(codex.interface.capabilities));
  assert.ok(Array.isArray(codex.interface.defaultPrompt));

  const cursor = readJson(".cursor-plugin/plugin.json");
  assert.equal(cursor.name, pkg.name);
  assert.equal(cursor.version, pkg.version);
  assert.equal(Object.hasOwn(cursor, "$schema"), false, "Cursor payload must not publish the dead hosted schema URL");
  assert.equal(cursor.mcpServers, "mcp.cursor.json");
  assert.deepEqual(readJson("mcp.cursor.json"), {
    mcpServers: {
      "pico-spatial-mcp": {
        command: "node",
        args: ["${CURSOR_PLUGIN_ROOT}/scripts/plugin-bootstrap.mjs"],
      },
    },
  });
  assert.equal(fs.existsSync(path.join(repoRoot, ".mcp.json")), false, "legacy .mcp.json would duplicate canonical mcp.json discovery");
  assert.equal(fs.existsSync(path.join(repoRoot, ".github/plugin/plugin.json")), false, "shadowed Copilot payload must not drift from root plugin.json");

  const claudeMcp = readJson(".mcp.claude.json");
  assert.deepEqual(claudeMcp, {
    mcpServers: {
      "pico-spatial-mcp": {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/scripts/plugin-bootstrap.mjs"],
      },
    },
  });
  for (const [config, token] of [[portableMcp, "${PLUGIN_ROOT}"], [claudeMcp, "${CLAUDE_PLUGIN_ROOT}"]]) {
    const bootstrap = config.mcpServers["pico-spatial-mcp"].args[0].replace(token, repoRoot);
    assert.equal(fs.existsSync(bootstrap), true);
  }
});

test("all host marketplaces use their exact source descriptor and synchronized metadata", () => {
  const pkg = readJson("package.json");
  const marketplaces = [
    { file: ".claude-plugin/marketplace.json", source: "./" },
    { file: ".agents/plugins/marketplace.json", source: { source: "local", path: "." } },
    { file: ".cursor-plugin/marketplace.json", source: "." },
    { file: ".github/plugin/marketplace.json", source: "." },
  ];

  for (const expected of marketplaces) {
    const marketplace = readJson(expected.file);
    if (expected.file === ".cursor-plugin/marketplace.json") {
      assert.equal(Object.hasOwn(marketplace, "$schema"), false, "Cursor marketplace must not publish the dead hosted schema URL");
    }
    assert.equal(marketplace.plugins.length, 1, expected.file);
    const plugin = marketplace.plugins[0];
    assert.equal(plugin.name, pkg.name, expected.file);
    assert.equal(plugin.version, pkg.version, expected.file);
    assert.deepEqual(plugin.source, expected.source, expected.file);
  }
});

test("installed tarball keeps default startup, tools/list, and pico_doctor read-only", async () => {
  const artifact = installPackedArtifactWithoutNetwork();
  const harness = createManagedRuntimeHarness();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const env = { ...harness.env };
  delete env.PICO_MCP_SURFACE;
  delete env.PICO_MCP_OUTER_SURFACE;
  delete env.PICO_MCP_CLI_POLICY;
  assert.equal(Object.hasOwn(env, "PICO_MCP_CLI_POLICY"), false, "default-policy child must leave PICO_MCP_CLI_POLICY unset");
  const beforeHome = fs.readdirSync(harness.home);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [artifact.entry],
    cwd: artifact.installRoot,
    env,
  });
  const client = new Client({ name: "packed-managed-policy", version: "0.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 18);
    assert.equal(harness.calls().some((call) => call.role === "npm"), false, JSON.stringify(harness.calls()));
    assert.equal(fs.existsSync(harness.managedRoot), false, "tools/list must not create the managed store");

    const doctor = await client.callTool({ name: "pico_doctor", arguments: {} });
    const payload = JSON.parse(mcpText(doctor));
    assert.ok(Array.isArray(payload.preflight?.checks) && payload.preflight.checks.length > 0, JSON.stringify(payload));
    assert.equal(harness.calls().some((call) => call.role === "npm"), false, JSON.stringify(harness.calls()));
    assert.equal(harness.calls().some((call) => call.role === "managed-cli"), false, JSON.stringify(harness.calls()));
    assert.equal(fs.existsSync(harness.managedRoot), false, "default pico_doctor must not create the managed store");
    assert.deepEqual(fs.readdirSync(harness.home), beforeHome, "default pico_doctor must not write the isolated home");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(harness.root, { recursive: true, force: true });
    fs.rmSync(artifact.root, { recursive: true, force: true });
  }
});

test("installed tarball wrapper lazily uses exact managed latest without touching ambient CLI or PATH", () => {
  const artifact = installPackedArtifactWithoutNetwork();
  const harness = createManagedRuntimeHarness({ latestVersion: "0.4.2" });
  const pathKey = process.platform === "win32"
    ? (Object.keys(harness.env).find((key) => key.toUpperCase() === "PATH") ?? "Path")
    : "PATH";
  const ambientMarker = path.join(harness.root, "ambient-invoked");
  const ambientCli = path.join(harness.binDir, process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
  if (process.platform === "win32") {
    fs.writeFileSync(ambientCli, `@echo off\r\n>"${ambientMarker}" echo invoked\r\nexit /b 88\r\n`);
  } else {
    writeExecutable(ambientCli, `#!/bin/sh\nprintf invoked > ${shellQuote(ambientMarker)}\nexit 88\n`);
  }
  const ambientBefore = fs.readFileSync(ambientCli);
  const childEnv = { ...harness.env };
  delete childEnv.PICO_MCP_CLI_POLICY;
  const pathBefore = childEnv[pathKey];
  assert.equal(Object.hasOwn(childEnv, "PICO_MCP_CLI_POLICY"), false, "wrapper child must resolve the unset default policy");
  const knowledgeUrl = pathToFileURL(path.join(artifact.installed, "dist", "knowledge.js")).href;
  const script = `
const { KnowledgeBridge } = await import(${JSON.stringify(knowledgeUrl)});
const pathKey = ${JSON.stringify(pathKey)};
const pathBefore = process.env[pathKey];
const policyWasSet = Object.hasOwn(process.env, "PICO_MCP_CLI_POLICY");
const bridge = new KnowledgeBridge({ startupTimeoutMs: 3000, callTimeoutMs: 2000, retirementTimeoutMs: 2000 });
const result = await bridge.call("graph_stats", {});
const pathAfter = process.env[pathKey];
await bridge.close();
process.stdout.write(JSON.stringify({ result, pathBefore, pathAfter, policyWasSet }));
`;

  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: artifact.installRoot,
      env: childEnv,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const out = JSON.parse(child.stdout);
    assert.equal(out.result.status, "ok", JSON.stringify(out.result));
    assert.equal(out.result.picoCli.source, "managed");
    assert.equal(out.result.picoCli.policy, "managed-latest");
    assert.equal(out.result.picoCli.version, "0.4.2");
    assert.equal(out.result.picoCli.latestVersion, "0.4.2");
    assert.equal(out.result.picoCli.freshness, "latest");
    assert.match(out.result.picoCli.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(path.isAbsolute(out.result.picoCli.path), true);
    assert.equal(out.policyWasSet, false);
    assertCanonicalManagedCliPath(out.result.picoCli.path, harness.managedRoot, "0.4.2");
    assert.throws(
      () => assertCanonicalManagedCliPath(`${canonicalManagedCliPath(harness.managedRoot, "0.4.2")}-evil`, harness.managedRoot, "0.4.2"),
      /Expected values to be strictly equal/,
    );
    assert.equal(out.pathBefore, pathBefore);
    assert.equal(out.pathAfter, pathBefore);
    assert.deepEqual(fs.readFileSync(ambientCli), ambientBefore);
    assert.equal(fs.existsSync(ambientMarker), false, "ambient pico-cli on PATH must not run");

    const calls = harness.calls();
    const npmCalls = calls.filter((call) => call.role === "npm");
    assert.deepEqual(npmCalls[0].args, [
      "view", "@picoxr/pico-cli@latest", "version", "dist.integrity", "--json",
    ]);
    assert.equal(npmCalls.length, 2, JSON.stringify(npmCalls));
    assert.equal(npmCalls[1].args[0], "install");
    assert.ok(npmCalls[1].args.includes("--prefix"), JSON.stringify(npmCalls[1]));
    assert.equal(npmCalls[1].args.at(-1), "@picoxr/pico-cli@0.4.2");
    const argvLedger = calls.map((call) => call.args.join(" ")).join("\n");
    assert.doesNotMatch(argvLedger, /(?:^|\s)(?:-g|--global)(?:\s|$)/);
    assert.doesNotMatch(argvLedger, /(?:^|\s)setup(?:\s|$)/);
    assert.doesNotMatch(argvLedger, /update\s+--check/);
    assert.equal(calls.some((call) => call.role === "managed-cli" && call.args.slice(1).join(" ") === "mcp dev-knowledge"), true);
    assert.equal(fs.existsSync(path.join(harness.managedRoot, "versions", "0.4.2", "install.json")), true);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
    fs.rmSync(artifact.root, { recursive: true, force: true });
  }
});

test("setup-required wrapper results stay source/freshness-neutral and never execute setup", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const neutralNote = "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry.";
  const scenarios = [
    { name: "registry latest", freshness: "latest", configure() {} },
    {
      name: "registry unknown cached fallback", freshness: "unknown",
      configure(harness) {
        publishManagedFixtureVersion(harness, harness.managedRoot, "0.4.2");
        harness.env.FAKE_REGISTRY_MODE = "failure";
      },
    },
    {
      name: "known-newer install failure fallback", freshness: "outdated",
      configure(harness) {
        publishManagedFixtureVersion(harness, harness.managedRoot, "0.4.1");
        publishManagedFixtureVersion(harness, harness.managedRoot, "0.4.2", { packageVersion: "0.4.1" });
      },
    },
    {
      name: "managed cache-only", freshness: "cached",
      configure(harness) {
        publishManagedFixtureVersion(harness, harness.managedRoot, "0.4.2");
        harness.env.PICO_MCP_CLI_POLICY = "managed-cached";
      },
    },
    {
      name: "explicit external", freshness: "external",
      configure(harness) {
        const marker = path.join(harness.root, "external-setup-was-run");
        const external = path.join(harness.root, process.platform === "win32" ? "setup-refusing-external.cmd" : "setup-refusing-external");
        if (process.platform === "win32") {
          fs.writeFileSync(external, `@echo off\r\nif "%1"=="-v" (echo pico-cli/0.4.2& exit /b 0)\r\nif "%1"=="setup" (>"${marker}" echo ran)\r\n>&2 echo Error: Perf utilities are not installed. Run pico-cli setup.\r\nexit /b 1\r\n`);
        } else {
          writeExecutable(external, `#!/bin/sh\nif [ "$1" = "-v" ]; then printf 'pico-cli/0.4.2\\n'; exit 0; fi\nif [ "$1" = "setup" ]; then printf ran > ${shellQuote(marker)}; fi\nprintf 'Error: Perf utilities are not installed. Run pico-cli setup.\\n' >&2\nexit 1\n`);
        }
        harness.env.PICO_MCP_CLI_POLICY = "external";
        harness.env.PICO_MCP_CLI_PATH = external;
        harness.externalSetupMarker = marker;
      },
    },
  ];

  for (const scenario of scenarios) {
    const harness = createManagedRuntimeHarness({ operationMode: "setup-required" });
    scenario.configure(harness);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "dist", "index.js")],
      cwd: repoRoot,
      env: { ...harness.env, PICO_MCP_SURFACE: "full" },
      stderr: "pipe",
    });
    const client = new Client({ name: `neutral-setup-guidance-${scenario.freshness}`, version: "0.0.0" });
    try {
      await client.connect(transport);
      const invocations = [
        ["perf_diagnose", { packageName: "com.example.fixture", durationSec: 5 }],
        ["perf_trace", { action: "record", packageName: "com.example.fixture", durationSec: 5, outputPath: path.join(harness.root, "trace.perfetto-trace") }],
        ["watch_crash", { packageName: "com.example.fixture", durationSec: 5 }],
        ["capture_record", { durationSec: 1, outputPath: path.join(harness.root, "capture.mp4") }],
      ];
      for (const [name, args] of invocations) {
        const response = await client.callTool({ name, arguments: args });
        const result = JSON.parse(mcpText(response));
        assert.equal(result.status, "failed", `${scenario.name}/${name}: ${JSON.stringify(result)}`);
        assert.equal(result.failureClass, "setup-required", `${scenario.name}/${name}: ${JSON.stringify(result)}`);
        assert.equal(result.note, neutralNote, `${scenario.name}/${name}: setup note must not infer source or freshness`);
        assert.deepEqual(result.setupCommand, { path: result.picoCli.path, args: ["setup"] }, `${scenario.name}/${name}`);
        assert.equal(path.isAbsolute(result.setupCommand.path), true, `${scenario.name}/${name}`);
        assert.equal(result.picoCli.freshness, scenario.freshness, `${scenario.name}/${name}`);
        assert.doesNotMatch(result.note, /\b(?:managed|current|latest|cached|external|outdated|unknown)\b/i, `${scenario.name}/${name}`);
      }
      const setupCalls = harness.calls().filter((call) => call.role === "managed-cli" && call.args.slice(1).join(" ") === "setup");
      assert.deepEqual(setupCalls, [], scenario.name);
      if (harness.externalSetupMarker) assert.equal(fs.existsSync(harness.externalSetupMarker), false, scenario.name);
    } finally {
      await client.close().catch(() => {});
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test("public schemas and missing-vault results route setup through ensure_pico_cli", async () => {
  const harness = createManagedRuntimeHarness();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    cwd: repoRoot,
    env: {
      ...harness.env,
      PICO_MCP_SURFACE: "full",
      PICO_AGENT_VAULT: path.join(harness.root, "deliberately-missing-vault"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "public-setup-guidance", version: "0.0.0" });
  const assertManagedSetupGuidance = (text, label) => {
    assert.doesNotMatch(text, /\bpico-cli\s+setup\b/i, `${label}: no bare ambient setup command`);
    assert.match(text, /ensure_pico_cli/i, `${label}: resolve the managed CLI first`);
    assert.match(text, /returned absolute path/i, `${label}: require the resolved absolute path`);
    assert.match(text, /args \[\"setup\"\]/i, `${label}: preserve setup as argv data`);
  };
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      assertNoActionableBareSetup(JSON.stringify(tool), `${tool.name} public schema`);
    }
    const selectedSchemas = listed.tools.filter((tool) => ["preflight_lint", "vault_api", "run_spatialbench"].includes(tool.name));
    assert.equal(selectedSchemas.length, 3, JSON.stringify(selectedSchemas.map((tool) => tool.name)));
    assert.doesNotMatch(JSON.stringify(selectedSchemas), /\bpico-cli\s+setup\b/i);

    const lint = JSON.parse(mcpText(await client.callTool({
      name: "preflight_lint",
      arguments: { content: "val safe = 1", kind: "kotlin" },
    })));
    assert.equal(lint.vault.status, "unavailable", JSON.stringify(lint));
    assertManagedSetupGuidance(lint.vault.note, "preflight_lint result");

    const vault = JSON.parse(mcpText(await client.callTool({
      name: "vault_api",
      arguments: { symbol: "Entity", sdkVersion: `missing-${process.pid}` },
    })));
    assert.equal(vault.status, "unavailable", JSON.stringify(vault));
    assertManagedSetupGuidance(vault.note, "vault_api result");

    const { formatManualPicoCliSetupGuidance } = await import("../dist/doors.js");
    assertManagedSetupGuidance(formatManualPicoCliSetupGuidance("Perf utilities are unavailable."), "pico_loop fix");

    const missingRoot = path.join(harness.root, "missing-index-root");
    const script = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "build-vault-index.mjs"), missingRoot], {
      cwd: repoRoot,
      env: { ...harness.env },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(script.status, 1, script.stderr || script.stdout);
    assertManagedSetupGuidance(script.stderr, "build-vault-index stderr");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test("KnowledgeBridge classifies setup refusal anywhere in bounded startup stderr", () => {
  for (const scenario of [
    { name: "noise before refusal", before: "noise-before-refusal-".repeat(1_200), after: "", refusalRetained: true },
    { name: "noise after refusal", before: "", after: "noise-after-refusal-".repeat(1_200), refusalRetained: false },
  ]) {
    const harness = createManagedRuntimeHarness();
    const refusalMarker = "KNOWLEDGE_SETUP_REFUSAL_DO_NOT_INHERIT";
    const refusingServer = path.join(harness.root, "refusing-knowledge.mjs");
    fs.writeFileSync(refusingServer, [
      `process.stderr.write(${JSON.stringify(`${scenario.before}${refusalMarker}: Perf utilities are not installed. Run pico-cli setup.\n${scenario.after}`)});`,
      "setTimeout(() => process.exit(1), 10);",
    ].join("\n"));
    const childEnv = { ...harness.env, FAKE_KNOWLEDGE_SERVER: refusingServer };
    const knowledgeUrl = pathToFileURL(path.join(repoRoot, "dist", "knowledge.js")).href;
    const script = `
const { KnowledgeBridge } = await import(${JSON.stringify(knowledgeUrl)});
const bridge = new KnowledgeBridge({ startupTimeoutMs: 2000, callTimeoutMs: 1000, retirementTimeoutMs: 1000, maxOutputBytes: 8192 });
const result = await bridge.call("graph_stats", {});
await bridge.close();
process.stdout.write(JSON.stringify(result));
`;
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: repoRoot,
        env: childEnv,
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(child.status, 0, `${scenario.name}: ${child.stderr || child.stdout}`);
      assert.doesNotMatch(child.stderr, new RegExp(refusalMarker), `${scenario.name}: child stderr must be captured, not inherited`);
      const result = JSON.parse(child.stdout);
      assert.equal(result.status, "unavailable", `${scenario.name}: ${JSON.stringify(result)}`);
      assert.equal(result.failureClass, "setup-required", `${scenario.name}: ${JSON.stringify(result)}`);
      assert.equal(result.error, "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry.");
      if (scenario.refusalRetained) assert.match(result.outputTail, new RegExp(refusalMarker));
      else assert.doesNotMatch(result.outputTail, new RegExp(refusalMarker), "classification must survive eviction from the retained tail");
      assert.equal(Buffer.byteLength(result.outputTail, "utf8") <= 16 * 1024, true);
      assert.equal(result.outputTruncated, true);
      assert.deepEqual(result.setupCommand, { path: result.picoCli.path, args: ["setup"] });
      assert.equal(path.isAbsolute(result.setupCommand.path), true);
      assert.equal(harness.calls().some((call) => call.role === "managed-cli" && call.args.slice(1).join(" ") === "setup"), false);
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test("bootstrap root/platform/prerequisite decisions are independent of the caller cwd", async () => {
  const { resolvePluginRoot, npmExecutable, needsSourceBuild, sourceSetupPlan } =
    await import("../scripts/plugin-bootstrap.mjs");

  const pluginRoot = path.resolve("/tmp", "hostile cwd", "PICO plugin ü 漢字");
  const bootstrapUrl = pathToFileURL(path.join(pluginRoot, "scripts", "plugin-bootstrap.mjs"));
  assert.equal(resolvePluginRoot(bootstrapUrl.href), pluginRoot);
  assert.equal(npmExecutable("win32"), "npm.cmd");
  assert.equal(npmExecutable("darwin"), "npm");
  assert.equal(npmExecutable("linux"), "npm");

  assert.equal(needsSourceBuild({ nodeModulesPresent: true, distEntryPresent: true }), false);
  assert.equal(needsSourceBuild({ nodeModulesPresent: false, distEntryPresent: true }), true);
  assert.equal(needsSourceBuild({ nodeModulesPresent: true, distEntryPresent: false }), true);
  assert.equal(needsSourceBuild({ nodeModulesPresent: false, distEntryPresent: false }), true);

  const ci = ["ci", "--no-audit", "--no-fund"];
  const build = ["run", "build"];
  assert.deepEqual(sourceSetupPlan({ nodeModulesPresent: true, distEntryPresent: true }), []);
  assert.deepEqual(sourceSetupPlan({ nodeModulesPresent: false, distEntryPresent: true }), [ci]);
  assert.deepEqual(sourceSetupPlan({ nodeModulesPresent: true, distEntryPresent: false }), [build]);
  assert.deepEqual(sourceSetupPlan({ nodeModulesPresent: false, distEntryPresent: false }), [ci, build]);
});

test("Windows bootstrap runs fixed npm scripts through ComSpec without shell interpolation", async () => {
  const { runBootstrap } = await import("../scripts/plugin-bootstrap.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico windows bootstrap "));
  const comspec = "C:\\Windows\\System32\\cmd.exe";
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const env = { ComSpec: comspec, PICO_HOME: "C:\\PICO Home" };
  const launches = [];
  const spawnImpl = (command, args, options) => {
    launches.push({ command, args, options });
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("close", 0, null);
    });
    return child;
  };

  await runBootstrap({ root, platform: "win32", env, execPath, spawnImpl });

  assert.deepEqual(launches.map(({ command, args }) => ({ command, args })), [
    {
      command: comspec,
      args: ["/d", "/s", "/c", "npm.cmd ci --no-audit --no-fund"],
    },
    {
      command: comspec,
      args: ["/d", "/s", "/c", "npm.cmd run build"],
    },
    {
      command: execPath,
      args: [path.join(root, "dist", "index.js")],
    },
  ]);
  assert.deepEqual(launches.map(({ options }) => options.stdio), [["ignore", 2, 2], ["ignore", 2, 2], "inherit"]);
  assert.ok(launches.every(({ options }) => options.cwd === root));
  assert.ok(launches.every(({ options }) => options.env === env));
  assert.ok(launches.every(({ options }) => options.shell !== true));
});

test("a non-timeout npm failure is nonzero and never launches MCP", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico failed install "));
  const pluginRoot = path.join(tempRoot, "source plugin");
  const hostileCwd = path.join(tempRoot, "caller");
  const fakeBin = path.join(tempRoot, "bin");
  const npmLog = path.join(tempRoot, "npm.jsonl");
  const childMarker = path.join(tempRoot, "child-started");
  fs.mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true });
  fs.mkdirSync(hostileCwd, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "scripts", "plugin-bootstrap.mjs"), path.join(pluginRoot, "scripts", "plugin-bootstrap.mjs"));

  const fakeNpm = path.join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm");
  writeExecutable(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stderr.write("deliberate npm failure\\n");
process.exit(23);
`);

  const result = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "plugin-bootstrap.mjs")], {
    cwd: hostileCwd,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPM_LOG: npmLog,
      FAKE_CHILD_LOG: childMarker,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deliberate npm failure/);
  assert.match(result.stderr, /failed with exit code 23/);
  assert.deepEqual(fs.readFileSync(npmLog, "utf8").trim().split("\n").map(JSON.parse), [
    ["ci", "--no-audit", "--no-fund"],
  ]);
  assert.equal(fs.existsSync(childMarker), false);
});

test("cold bootstrap keeps npm on stderr, uses absolute child argv, and propagates child exit", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico distribution "));
  const pluginRoot = path.join(tempRoot, "source plugin ü 漢字");
  const hostileCwd = path.join(tempRoot, "unrelated caller cwd");
  const fakeBin = path.join(tempRoot, "fake bin");
  const npmLog = path.join(tempRoot, "npm.jsonl");
  const childLog = path.join(tempRoot, "child.json");
  fs.mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true });
  fs.mkdirSync(hostileCwd, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "scripts", "plugin-bootstrap.mjs"), path.join(pluginRoot, "scripts", "plugin-bootstrap.mjs"));

  const fakeNpm = path.join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm");
  writeExecutable(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("NPM_STDOUT\\n");
process.stderr.write("NPM_STDERR\\n");
if (process.argv[2] === "ci") fs.mkdirSync(path.join(process.cwd(), "node_modules"), { recursive: true });
if (process.argv[2] === "run" && process.argv[3] === "build") {
  fs.mkdirSync(path.join(process.cwd(), "dist"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "dist", "index.js"), ${JSON.stringify(`import fs from "node:fs";
fs.writeFileSync(process.env.FAKE_CHILD_LOG, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), execPath: process.execPath }));
process.stdout.write("MCP_STDOUT\\n");
process.stderr.write("MCP_STDERR\\n");
process.exit(Number(process.env.FAKE_CHILD_EXIT ?? 0));
`)});
}
`);

  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_NPM_LOG: npmLog,
    FAKE_CHILD_LOG: childLog,
    FAKE_CHILD_EXIT: "7",
  };
  const first = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "plugin-bootstrap.mjs")], {
    cwd: hostileCwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(first.status, 7, first.stderr);
  assert.equal(first.stdout, "MCP_STDOUT\n");
  assert.match(first.stderr, /NPM_STDOUT/);
  assert.match(first.stderr, /NPM_STDERR/);
  assert.match(first.stderr, /MCP_STDERR/);
  assert.deepEqual(fs.readFileSync(npmLog, "utf8").trim().split("\n").map(JSON.parse), [
    ["ci", "--no-audit", "--no-fund"],
    ["run", "build"],
  ]);
  const canonicalPluginRoot = fs.realpathSync(pluginRoot);
  assert.deepEqual(JSON.parse(fs.readFileSync(childLog, "utf8")), {
    argv: [path.join(canonicalPluginRoot, "dist", "index.js")],
    cwd: canonicalPluginRoot,
    execPath: process.execPath,
  });

  fs.writeFileSync(npmLog, "");
  const warm = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "plugin-bootstrap.mjs")], {
    cwd: hostileCwd,
    env: { ...env, FAKE_CHILD_EXIT: "0" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(fs.readFileSync(npmLog, "utf8"), "");
});

test("documented portable and Claude token contracts launch from a hostile cwd", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico manifest launcher "));
  const hostileCwd = path.join(tempRoot, "unrelated caller cwd ü 漢字");
  fs.mkdirSync(hostileCwd, { recursive: true });

  for (const [file, token, typed] of [["mcp.json", "${PLUGIN_ROOT}", true], [".mcp.claude.json", "${CLAUDE_PLUGIN_ROOT}", false]]) {
    const manifest = readJson(file);
    const launcher = manifest.mcpServers["pico-spatial-mcp"];
    assert.equal(launcher.command, "node");
    assert.deepEqual(launcher.args, [`${token}/scripts/plugin-bootstrap.mjs`]);
    assert.equal(Object.hasOwn(launcher, "type"), typed);

    const hostResolvedArgs = launcher.args.map((arg) => arg.replaceAll(token, repoRoot));
    assert.notDeepEqual(hostResolvedArgs, [path.resolve(hostileCwd, "scripts/plugin-bootstrap.mjs")]);
    const result = spawnSync(launcher.command, hostResolvedArgs, {
      cwd: hostileCwd,
      env: { ...process.env, [token.slice(2, -1)]: repoRoot },
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.equal(result.signal, null, `${file}: ${result.stderr}`);
    assert.equal(result.stdout, "", `${file}: MCP bootstrap must not contaminate stdout before EOF shutdown`);
  }

  const cursor = readJson("mcp.cursor.json").mcpServers["pico-spatial-mcp"];
  assert.deepEqual(cursor.args, ["${CURSOR_PLUGIN_ROOT}/scripts/plugin-bootstrap.mjs"]);
  const cursorResolvedArgs = cursor.args.map((arg) => arg.replaceAll("${CURSOR_PLUGIN_ROOT}", repoRoot));
  const cursorResult = spawnSync(cursor.command, cursorResolvedArgs, {
    cwd: hostileCwd,
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(cursorResult.status, 0, cursorResult.stderr);
  assert.equal(cursorResult.stdout, "", "Cursor candidate must keep MCP stdout clean after test-side root expansion");
});

test("bounded bootstrap children are killed after timeout", async () => {
  const { runBoundedChild } = await import("../scripts/plugin-bootstrap.mjs");
  await assert.rejects(
    runBoundedChild(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      { cwd: repoRoot, timeoutMs: 40, killGraceMs: 40, stdio: "ignore" },
    ),
    (error) => error?.code === "BOOTSTRAP_TIMEOUT" && /timed out/i.test(error.message),
  );
});

test("bootstrap forwards SIGTERM to the MCP child", { skip: process.platform === "win32" }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico signal "));
  const pluginRoot = path.join(tempRoot, "plugin ü");
  const hostileCwd = path.join(tempRoot, "hostile cwd");
  const readyFile = path.join(tempRoot, "ready");
  const signalFile = path.join(tempRoot, "signal");
  fs.mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
  fs.mkdirSync(hostileCwd, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "scripts", "plugin-bootstrap.mjs"), path.join(pluginRoot, "scripts", "plugin-bootstrap.mjs"));
  fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), `import fs from "node:fs";
fs.writeFileSync(process.env.FAKE_READY_FILE, "ready");
process.on("SIGTERM", () => { fs.writeFileSync(process.env.FAKE_SIGNAL_FILE, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`);

  const child = spawn(process.execPath, [path.join(pluginRoot, "scripts", "plugin-bootstrap.mjs")], {
    cwd: hostileCwd,
    env: { ...process.env, FAKE_READY_FILE: readyFile, FAKE_SIGNAL_FILE: signalFile },
    stdio: "ignore",
  });
  await waitForFile(readyFile);
  child.kill("SIGTERM");
  const close = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(fs.readFileSync(signalFile, "utf8"), "SIGTERM");
  assert.deepEqual(close, { code: 143, signal: null });
});

test("knowledge_api exposes all eight strict grounded action schemas", async () => {
  const { knowledgeInputSchema } = await import("../dist/knowledge.js");
  const cases = [
    {
      input: { action: "query_graph", question: "How is Entity.loadSuspend grounded?", query_variants: ["Entity loading"] },
      defaults: { mode: "bfs", depth: 3, token_budget: 2000, max_degree: 0, sort_by: "degree" },
    },
    { input: { action: "get_node", label: "Entity" } },
    { input: { action: "get_neighbors", label: "Entity", relation_filter: "DECLARES" } },
    { input: { action: "get_community", community_id: 7 } },
    { input: { action: "god_nodes" }, defaults: { top_n: 10 } },
    { input: { action: "graph_stats" } },
    { input: { action: "shortest_path", source: "Entity", target: "AssetBundle" }, defaults: { max_hops: 8 } },
    { input: { action: "switch_workspace", workspace: "spatial-sdk-0.13.3" } },
  ];

  assert.deepEqual(cases.map(({ input }) => knowledgeInputSchema.parse(input).action), [
    "query_graph", "get_node", "get_neighbors", "get_community", "god_nodes", "graph_stats", "shortest_path", "switch_workspace",
  ]);
  for (const { input, defaults } of cases) {
    const parsed = knowledgeInputSchema.parse(input);
    for (const [key, value] of Object.entries(defaults ?? {})) assert.deepEqual(parsed[key], value, `${input.action}.${key}`);
  }

  for (const invalid of [
    { action: "graph_stats", typo: true },
    { action: "query_graph" },
    { action: "query_graph", question: "q", mode: "wide" },
    { action: "query_graph", question: "q", depth: 0 },
    { action: "query_graph", question: "q", depth: 7 },
    { action: "query_graph", question: " " },
    { action: "query_graph", question: "q", token_budget: 0 },
    { action: "query_graph", question: "q", token_budget: 1.5 },
    { action: "query_graph", question: "q", max_degree: -1 },
    { action: "query_graph", question: "q", query_variants: ["valid", 3] },
    { action: "query_graph", question: "q", query_variants: [" "] },
    { action: "get_node", label: "Entity", extra: "no" },
    { action: "get_node", label: "" },
    { action: "get_neighbors", label: " " },
    { action: "get_community", community_id: -1 },
    { action: "get_community", community_id: 2.5 },
    { action: "god_nodes", top_n: 0 },
    { action: "god_nodes", top_n: 1.5 },
    { action: "shortest_path", source: "Entity" },
    { action: "shortest_path", source: " ", target: "AssetBundle" },
    { action: "shortest_path", source: "Entity", target: "" },
    { action: "shortest_path", source: "Entity", target: "AssetBundle", max_hops: 0 },
    { action: "shortest_path", source: "Entity", target: "AssetBundle", max_hops: 2.5 },
    { action: "switch_workspace", workspace: " " },
  ]) {
    assert.equal(knowledgeInputSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  }
});

test("KnowledgeBridge calls every action through one persistent serialized stdio MCP client", async () => {
  const {
    KnowledgeBridge,
    DEFAULT_KNOWLEDGE_COMMAND,
    DEFAULT_KNOWLEDGE_ARGS,
  } = await import("../dist/knowledge.js");
  assert.equal(DEFAULT_KNOWLEDGE_COMMAND, "pico-cli");
  assert.deepEqual(DEFAULT_KNOWLEDGE_ARGS, ["mcp", "dev-knowledge"]);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico knowledge actions "));
  const logPath = path.join(tempRoot, "server.jsonl");
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [path.join(repoRoot, "test", "fixtures", "fake-knowledge-server.mjs")],
    cwd: repoRoot,
    env: { ...process.env, FAKE_KNOWLEDGE_LOG: logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 1_000,
    maxOutputBytes: 8_192,
  });

  const calls = [
    ["switch_workspace", { workspace: "spatial-sdk-0.13.3" }],
    ["query_graph", { question: "What declares Entity?", mode: "dfs", depth: 6, token_budget: 4_096, max_degree: 20, query_variants: ["Entity relations", "declarations"], sort_by: "relevance" }],
    ["get_node", { label: "Entity" }],
    ["get_neighbors", { label: "Entity", relation_filter: "DECLARES" }],
    ["get_community", { community_id: 7 }],
    ["god_nodes", { top_n: 4 }],
    ["graph_stats", {}],
    ["shortest_path", { source: "Entity", target: "AssetBundle", max_hops: 5 }],
  ];

  const switched = await bridge.call(...calls[0]);
  assert.equal(switched.status, "ok", JSON.stringify(switched));
  const results = await Promise.all(calls.slice(1).map((call) => bridge.call(...call)));
  assert.ok(results.every((result) => result.status === "ok"), JSON.stringify(results));
  assert.ok(results.every((result) => JSON.parse(result.text).workspace === "spatial-sdk-0.13.3"));
  await bridge.close();

  const events = readJsonLines(logPath);
  const starts = events.filter((event) => event.event === "start");
  const remoteCalls = events.filter((event) => event.event === "call");
  assert.equal(starts.length, 1, JSON.stringify(events));
  assert.deepEqual(remoteCalls.map((event) => event.action), calls.map(([action]) => action));
  assert.equal(new Set(remoteCalls.map((event) => event.pid)).size, 1);
  assert.deepEqual(remoteCalls[1].args, calls[1][1]);
  assert.equal(Object.hasOwn(remoteCalls[1].args, "action"), false);
});

test("KnowledgeBridge returns remote tool errors without retiring switched workspace state", async () => {
  const { KnowledgeBridge } = await import("../dist/knowledge.js");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico knowledge remote error "));
  const logPath = path.join(tempRoot, "server.jsonl");
  const fakeServer = path.join(tempRoot, "remote-error-server.mjs");
  const sdkServerUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const sdkStdioUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const zodUrl = import.meta.resolve("zod");
  fs.writeFileSync(fakeServer, `#!/usr/bin/env node
import fs from "node:fs";
import { McpServer } from ${JSON.stringify(sdkServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const logPath = process.env.FAKE_KNOWLEDGE_LOG;
const append = (event) => fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
append({ event: "start" });
let workspace = "default";
const server = new McpServer({ name: "remote-error-knowledge", version: "0.0.0" });
for (const action of ["switch_workspace", "get_node", "god_nodes", "graph_stats"]) {
  server.registerTool(action, { inputSchema: z.object({}).passthrough() }, async (args) => {
    append({ event: "call", action, args, workspace });
    if (action === "switch_workspace") workspace = String(args.workspace);
    if (action === "get_node") {
      return {
        isError: true,
        content: [{ type: "text", text: "remote graph rejected this node" }],
      };
    }
    if (action === "god_nodes") {
      return {
        content: [{ type: "text", text: "Error executing god_nodes: Graph file not found: /missing/graph.json" }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ action, workspace, pid: process.pid }) }],
    };
  });
}
await server.connect(new StdioServerTransport());
`);

  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [fakeServer],
    cwd: repoRoot,
    env: { ...process.env, FAKE_KNOWLEDGE_LOG: logPath },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 1_000,
    maxOutputBytes: 8_192,
  });

  try {
    const switched = await bridge.call("switch_workspace", { workspace: "retained-after-remote-error" });
    assert.equal(switched.status, "ok", JSON.stringify(switched));
    const switchedPayload = JSON.parse(switched.text);

    const remoteError = await bridge.call("get_node", { label: "missing-node" });
    assert.deepEqual(remoteError, {
      status: "error",
      action: "get_node",
      error: "remote graph rejected this node",
      truncated: false,
      remoteError: true,
    });

    const followUp = await bridge.call("graph_stats", {});
    assert.equal(followUp.status, "ok", JSON.stringify(followUp));
    const followUpPayload = JSON.parse(followUp.text);
    assert.equal(followUpPayload.workspace, "retained-after-remote-error");
    assert.equal(followUpPayload.pid, switchedPayload.pid);

    const missingGraph = await bridge.call("god_nodes", { top_n: 5 });
    assert.deepEqual(missingGraph, {
      status: "unavailable",
      action: "god_nodes",
      error: "Error executing god_nodes: Graph file not found: /missing/graph.json",
      truncated: false,
      remoteError: true,
    });

    const afterMissingGraph = await bridge.call("graph_stats", {});
    assert.equal(afterMissingGraph.status, "ok", JSON.stringify(afterMissingGraph));
    const afterMissingPayload = JSON.parse(afterMissingGraph.text);
    assert.equal(afterMissingPayload.workspace, "retained-after-remote-error");
    assert.equal(afterMissingPayload.pid, switchedPayload.pid);
  } finally {
    await bridge.close();
  }

  const events = readJsonLines(logPath);
  assert.equal(events.filter((event) => event.event === "start").length, 1, JSON.stringify(events));
  assert.equal(new Set(events.filter((event) => event.event === "call").map((event) => event.pid)).size, 1);
  assert.deepEqual(events.filter((event) => event.event === "call").map((event) => event.action), [
    "switch_workspace",
    "get_node",
    "graph_stats",
    "god_nodes",
    "graph_stats",
  ]);
});

test("KnowledgeBridge deduplicates concurrent startup and caps returned text", async () => {
  const { KnowledgeBridge } = await import("../dist/knowledge.js");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico knowledge concurrent "));
  const logPath = path.join(tempRoot, "server.jsonl");
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [path.join(repoRoot, "test", "fixtures", "fake-knowledge-server.mjs")],
    cwd: repoRoot,
    env: {
      ...process.env,
      FAKE_KNOWLEDGE_LOG: logPath,
      FAKE_KNOWLEDGE_LARGE_CHARS: "10000",
    },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 1_000,
    maxOutputBytes: 128,
  });

  const [large, node] = await Promise.all([
    bridge.call("query_graph", { question: "large output" }),
    bridge.call("get_node", { label: "Entity" }),
  ]);
  assert.equal(large.status, "ok", JSON.stringify(large));
  assert.equal(large.text.length, 128);
  assert.equal(large.truncated, true);
  assert.equal(node.status, "ok", JSON.stringify(node));
  await bridge.close();
  assert.equal(readJsonLines(logPath).filter((event) => event.event === "start").length, 1);
});

test("KnowledgeBridge production environment forwards the full host environment", async () => {
  const { KnowledgeBridge } = await import("../dist/knowledge.js");
  const priorPicoHome = process.env.PICO_HOME;
  const priorSecret = process.env.PICO_KNOWLEDGE_TEST_SECRET;
  const expectedPicoHome = path.join(os.tmpdir(), "pico home ü 漢字");
  process.env.PICO_HOME = expectedPicoHome;
  process.env.PICO_KNOWLEDGE_TEST_SECRET = "must-reach-child";

  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [path.join(repoRoot, "test", "fixtures", "fake-knowledge-server.mjs")],
    cwd: repoRoot,
    startupTimeoutMs: 2_000,
    callTimeoutMs: 1_000,
  });

  try {
    const result = await bridge.call("graph_stats", {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    const payload = JSON.parse(result.text);
    assert.equal(payload.picoHome, expectedPicoHome);
    assert.equal(payload.testSecret, "must-reach-child");
  } finally {
    await bridge.close();
    if (priorPicoHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = priorPicoHome;
    if (priorSecret === undefined) delete process.env.PICO_KNOWLEDGE_TEST_SECRET;
    else process.env.PICO_KNOWLEDGE_TEST_SECRET = priorSecret;
  }
});

test("KnowledgeBridge observes a timed-out generation exit before starting its replacement", async () => {
  const { KnowledgeBridge } = await import("../dist/knowledge.js");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico knowledge ordered reset "));
  const logPath = path.join(tempRoot, "server.jsonl");
  const bridge = new KnowledgeBridge({
    command: process.execPath,
    args: [path.join(repoRoot, "test", "fixtures", "fake-knowledge-server.mjs")],
    cwd: repoRoot,
    env: {
      FAKE_KNOWLEDGE_LOG: logPath,
      FAKE_KNOWLEDGE_STARTUP_HANG_ONCE_FILE: path.join(tempRoot, "once.state"),
      FAKE_KNOWLEDGE_DELAYED_CLOSE_MS: "80",
    },
    // v35.2 — was startupTimeoutMs: 100 / callTimeoutMs: 1_000, which made this test flaky under
    // machine load (reproduced at 0db8e29, before this wave: it fails on a loaded box and passes on
    // an idle one). The first generation hangs UNCONDITIONALLY — fake-knowledge-server.mjs:20-29
    // takes the setInterval branch and never connects a transport — so the first call's
    // "unavailable" comes from the hang, not from the budget being tight. The budget was only ever
    // racing the SECOND, genuine node spawn, which is not what this test is about. Widening it
    // changes nothing that is asserted below and makes the ordering check deterministic.
    startupTimeoutMs: 3_000,
    callTimeoutMs: 5_000,
  });

  const unavailable = await bridge.call("graph_stats", {});
  assert.equal(unavailable.status, "unavailable", JSON.stringify(unavailable));
  const recovered = await bridge.call("graph_stats", {});
  assert.equal(recovered.status, "ok", JSON.stringify(recovered));
  await bridge.close();

  const firstStart = readJsonLines(logPath).find((event) => event.event === "start");
  assert.ok(firstStart, "first generation did not start");
  await waitForJsonLine(logPath, (event) => event.event === "exit" && event.pid === firstStart.pid);
  const events = readJsonLines(logPath);
  const firstExitIndex = events.findIndex((event) => event.event === "exit" && event.pid === firstStart.pid);
  const secondStartIndex = events.findIndex((event) => event.event === "start" && event.pid !== firstStart.pid);
  assert.ok(firstExitIndex >= 0, JSON.stringify(events));
  assert.ok(secondStartIndex >= 0, JSON.stringify(events));
  assert.ok(firstExitIndex < secondStartIndex, JSON.stringify(events));
});

test("KnowledgeBridge resets after startup timeout, call timeout, and protocol failure, then recovers", async () => {
  const { KnowledgeBridge } = await import("../dist/knowledge.js");
  const fakeServer = path.join(repoRoot, "test", "fixtures", "fake-knowledge-server.mjs");

  const scenarios = [
    {
      name: "startup timeout",
      envKey: "FAKE_KNOWLEDGE_STARTUP_HANG_ONCE_FILE",
      firstAction: "graph_stats",
      firstInput: {},
      startupTimeoutMs: 700,
      callTimeoutMs: 1_000,
    },
    {
      name: "call timeout",
      envKey: "FAKE_KNOWLEDGE_HANG_ONCE_FILE",
      actionEnv: { FAKE_KNOWLEDGE_HANG_ACTION: "query_graph" },
      firstAction: "query_graph",
      firstInput: { question: "hang once" },
      startupTimeoutMs: 2_000,
      callTimeoutMs: 150,
    },
    {
      name: "protocol failure",
      envKey: "FAKE_KNOWLEDGE_PROTOCOL_ONCE_FILE",
      actionEnv: { FAKE_KNOWLEDGE_PROTOCOL_ACTION: "get_node" },
      firstAction: "get_node",
      firstInput: { label: "break protocol" },
      startupTimeoutMs: 2_000,
      callTimeoutMs: 1_000,
    },
  ];

  for (const scenario of scenarios) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico knowledge reset "));
    const logPath = path.join(tempRoot, "server.jsonl");
    const bridge = new KnowledgeBridge({
      command: process.execPath,
      args: [fakeServer],
      cwd: repoRoot,
      env: {
        ...process.env,
        FAKE_KNOWLEDGE_LOG: logPath,
        [scenario.envKey]: path.join(tempRoot, "once.state"),
        ...(scenario.actionEnv ?? {}),
      },
      startupTimeoutMs: scenario.startupTimeoutMs,
      callTimeoutMs: scenario.callTimeoutMs,
      maxOutputBytes: 1_024,
    });
    const unavailable = await bridge.call(scenario.firstAction, scenario.firstInput);
    assert.equal(unavailable.status, "unavailable", `${scenario.name}: ${JSON.stringify(unavailable)}`);
    const recovered = await bridge.call("graph_stats", {});
    assert.equal(recovered.status, "ok", `${scenario.name}: ${JSON.stringify(recovered)}`);
    await bridge.close();
    assert.equal(readJsonLines(logPath).filter((event) => event.event === "start").length, 2, scenario.name);
  }
});

test("KnowledgeBridge reports a missing pico-cli command as unavailable", async () => {
  const { KnowledgeBridge } = await import("../dist/knowledge.js");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico missing cli "));
  const bridge = new KnowledgeBridge({
    command: path.join(tempRoot, "definitely-missing-pico-cli"),
    args: ["mcp", "spatial-knowledge"],
    startupTimeoutMs: 500,
    callTimeoutMs: 500,
  });
  const result = await bridge.call("graph_stats", {});
  assert.equal(result.status, "unavailable", JSON.stringify(result));
  assert.match(result.error, /ENOENT|not found|spawn/i);
  await bridge.close();
});

test("KnowledgeBridge custom injected command bypasses managed resolution", async () => {
  const { KnowledgeBridge } = await import("../dist/knowledge.js");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico knowledge custom bypass "));
  const knowledgeLog = path.join(tempRoot, "knowledge.jsonl");
  const custom = new KnowledgeBridge({
    command: process.execPath,
    args: [path.join(repoRoot, "test", "fixtures", "fake-knowledge-server.mjs")],
    cwd: repoRoot,
    env: { FAKE_KNOWLEDGE_LOG: knowledgeLog, PICO_MCP_CLI_POLICY: "disabled" },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 1_000,
  });
  try {
    const customResult = await custom.call("graph_stats", {});
    assert.equal(customResult.status, "ok", JSON.stringify(customResult));
    assert.equal(Object.hasOwn(customResult, "picoCli"), false);
    assert.equal(readJsonLines(knowledgeLog).filter((event) => event.event === "start").length, 1);
  } finally {
    await custom.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("KnowledgeBridge production child follows managed path/version changes and retires on disabled", { concurrency: false }, () => {
  const harness = createManagedRuntimeHarness({ latestVersion: "0.4.1" });
  const knowledgeUrl = pathToFileURL(path.join(repoRoot, "dist", "knowledge.js")).href;
  const picoCliUrl = pathToFileURL(path.join(repoRoot, "dist", "picocli.js")).href;
  const script = `
import fs from "node:fs";
const { KnowledgeBridge } = await import(${JSON.stringify(knowledgeUrl)});
const { ensurePicoCli } = await import(${JSON.stringify(picoCliUrl)});
const bridge = new KnowledgeBridge({ startupTimeoutMs: 3000, callTimeoutMs: 2000, retirementTimeoutMs: 2000 });
const first = await bridge.call("graph_stats", {});
fs.writeFileSync(process.env.FAKE_LATEST_VERSION_FILE, "0.4.2");
const activated = await ensurePicoCli({ forceRefresh: true, updateCheckTimeoutMs: 2000, installTimeoutMs: 2000 });
const second = await bridge.call("graph_stats", {});
process.env.PICO_MCP_CLI_POLICY = "disabled";
const disabled = await bridge.call("graph_stats", {});
const eventsBeforeClose = fs.readFileSync(process.env.FAKE_KNOWLEDGE_LOG, "utf8").split("\\n").filter(Boolean).map(JSON.parse);
await bridge.close();
process.stdout.write(JSON.stringify({ first, activated, second, disabled, eventsBeforeClose }));
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    env: harness.env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const out = JSON.parse(child.stdout);
  assert.equal(out.first.status, "ok", JSON.stringify(out.first));
  assert.equal(out.first.picoCli.version, "0.4.1");
  assert.equal(out.activated.version, "0.4.2", JSON.stringify(out.activated));
  assert.equal(out.second.status, "ok", JSON.stringify(out.second));
  assert.equal(out.second.picoCli.version, "0.4.2");
  assert.notEqual(JSON.parse(out.first.text).pid, JSON.parse(out.second.text).pid, "new managed path/version must start a new child");
  assert.equal(out.disabled.status, "unavailable", JSON.stringify(out.disabled));
  assert.equal(out.disabled.failureClass, "cli-disabled");
  const starts = out.eventsBeforeClose.filter((event) => event.event === "start");
  const exits = out.eventsBeforeClose.filter((event) => event.event === "exit");
  assert.equal(starts.length, 2, JSON.stringify(out.eventsBeforeClose));
  assert.equal(exits.length, 2, "disabled resolution must retire the active managed child before returning");
  const managedStarts = harness.calls().filter((call) => call.role === "managed-cli" && call.args.slice(1).join(" ") === "mcp dev-knowledge");
  assert.deepEqual(managedStarts.map((call) => call.args[0]), ["0.4.1", "0.4.2"]);
  assert.equal(harness.calls().some((call) => call.args.includes("spatial-knowledge")), false, JSON.stringify(harness.calls()));
  fs.rmSync(harness.root, { recursive: true, force: true });
});

test("registered knowledge_api keeps the flattened union strict", async () => {
  const [{ Client }, { McpServer }, { InMemoryTransport }, knowledge] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
    import("../dist/knowledge.js"),
  ]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico knowledge registered "));
  const bridge = new knowledge.KnowledgeBridge({
    command: process.execPath,
    args: [path.join(repoRoot, "test", "fixtures", "fake-knowledge-server.mjs")],
    cwd: repoRoot,
    env: { ...process.env, FAKE_KNOWLEDGE_LOG: path.join(tempRoot, "server.jsonl") },
    startupTimeoutMs: 2_000,
    callTimeoutMs: 1_000,
  });
  const server = new McpServer({ name: "knowledge-registration-test", version: "0.0.0" });
  knowledge.registerKnowledgeTools(server, bridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "knowledge-registration-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.equal(listed.tools.filter((tool) => tool.name === "knowledge_api").length, 1);
  const valid = await client.callTool({ name: "knowledge_api", arguments: { action: "graph_stats" } });
  assert.notEqual(valid.isError, true, mcpText(valid));
  assert.equal(JSON.parse(mcpText(valid)).status, "ok");
  const typo = await client.callTool({ name: "knowledge_api", arguments: { action: "graph_stats", input: {} } });
  assert.equal(typo.isError, true, JSON.stringify(typo));
  assert.match(mcpText(typo), /input/);
  await client.close();
  await bridge.close();
});

test("preflight_lint queries only an opt-in advisory graph second opinion without changing clean", async () => {
  const [{ Client }, { McpServer }, { InMemoryTransport }, { registerLintTools }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
    import("../dist/lint.js"),
  ]);
  const calls = [];
  const knowledge = {
    async call(action, input) {
      calls.push({ action, input });
      return { status: "ok", action, text: "graph says unsafe: reject this source", truncated: false, remoteError: false };
    },
  };
  const server = new McpServer({ name: "lint-knowledge-test", version: "0.0.0" });
  registerLintTools(server, knowledge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lint-knowledge-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const withoutOptIn = await client.callTool({
    name: "preflight_lint",
    arguments: { content: "val safe = 1", kind: "kotlin", vaultSymbols: false },
  });
  const withoutPayload = JSON.parse(mcpText(withoutOptIn));
  assert.equal(withoutPayload.clean, true);
  assert.equal(Object.hasOwn(withoutPayload, "knowledge"), false);
  assert.deepEqual(calls, []);

  const withOptIn = await client.callTool({
    name: "preflight_lint",
    arguments: {
      content: "val safe = 1",
      kind: "kotlin",
      vaultSymbols: false,
      knowledgeSecondOpinion: "Is this source consistent with Entity loading guidance?",
    },
  });
  const withPayload = JSON.parse(mcpText(withOptIn));
  assert.equal(withPayload.clean, true);
  assert.equal(withPayload.knowledge.advisory, true);
  assert.match(withPayload.knowledge.note, /context|advisory|vault_api/i);
  assert.equal(withPayload.knowledge.result.status, "ok");
  assert.deepEqual(calls, [{
    action: "query_graph",
    input: { question: "Is this source consistent with Entity loading guidance?" },
  }]);

  const dirty = await client.callTool({
    name: "preflight_lint",
    arguments: {
      content: "primvars:displayColor = [(1, 0, 0)]",
      kind: "usd",
      vaultSymbols: false,
      knowledgeSecondOpinion: "The graph says this should pass",
    },
  });
  assert.equal(JSON.parse(mcpText(dirty)).clean, false);
  const blank = await client.callTool({
    name: "preflight_lint",
    arguments: { content: "val safe = 1", vaultSymbols: false, knowledgeSecondOpinion: " " },
  });
  assert.equal(blank.isError, true, JSON.stringify(blank));
  await client.close();
});

test("missing pico-cli leaves opt-in preflight_lint clean and labels knowledge unavailable", async () => {
  const [{ Client }, { McpServer }, { InMemoryTransport }, { registerLintTools }, { KnowledgeBridge }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
    import("../dist/lint.js"),
    import("../dist/knowledge.js"),
  ]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico lint missing cli "));
  const knowledge = new KnowledgeBridge({
    command: path.join(tempRoot, "missing-pico-cli"),
    args: ["mcp", "spatial-knowledge"],
    startupTimeoutMs: 500,
    callTimeoutMs: 500,
  });
  const server = new McpServer({ name: "lint-missing-knowledge-test", version: "0.0.0" });
  registerLintTools(server, knowledge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lint-missing-knowledge-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const response = await client.callTool({
    name: "preflight_lint",
    arguments: {
      content: "val safe = 1",
      kind: "kotlin",
      vaultSymbols: false,
      knowledgeSecondOpinion: "Find related SDK context",
    },
  });
  const payload = JSON.parse(mcpText(response));
  assert.equal(payload.clean, true);
  assert.equal(payload.knowledge.advisory, true);
  assert.equal(payload.knowledge.result.status, "unavailable");
  await client.close();
  await knowledge.close();
});

test("preflight prints the verified emulator-bundle install route but never runs it", async () => {
  const { runPreflightChecks } = await import("../dist/preflight.js");
  const calls = [];
  const io = {
    nodeVersion: "v22.0.0",
    exec(command, args) {
      calls.push([command, args]);
      const line = [command, ...args].join(" ");
      if (line === "adb version") return { ok: true, stdout: "Android Debug Bridge" };
      if (line === "adb devices") return { ok: true, stdout: "List of devices attached\n" };
      if (line === "pico-cli -v") return { ok: true, stdout: "pico-cli/0.3.0\n" };
      if (line === "pico-cli emulator status --format json") return { ok: true, stdout: '{"tool_status":"SUCCESS","data":{},"errors":[]}' };
      if (command === "df") return { ok: true, stdout: "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/disk 100000000 1 90000000 1% /\n" };
      return { ok: false, stdout: "", stderr: "not available" };
    },
    readFile: () => null,
    statMtimeMs: () => Date.now(),
    now: () => Date.now(),
    home: "/fake-home",
    detectJavaHome: () => "/fake-jdk",
  };
  const emulator = runPreflightChecks(io).find((check) => check.name === "emulator");
  assert.equal(emulator.status, "fail", JSON.stringify(emulator));
  assert.match(emulator.fix, /`pico-cli emulator install --source auto --yes`/);
  assert.match(emulator.fix, /downloads?\/updates?.*emulator bundle/i);
  assert.match(emulator.fix, /does not create an AVD/i);
  assert.match(emulator.fix, /does not install.*JDK.*Android SDK.*Gradle.*PICO build SDK/i);
  assert.equal(calls.some(([command, args]) => command === "pico-cli" && args[0] === "emulator" && args[1] === "install"), false, JSON.stringify(calls));
});

test("public adoption docs keep bundle installation, AVD creation, and build tooling distinct", () => {
  for (const file of ["README.md", "QUICKSTART.md", "GETTING_STARTED.md"]) {
    const contents = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const normalized = contents.replaceAll("**", "");
    assert.match(normalized, /pico-cli emulator install --source auto --yes/, file);
    assert.match(normalized, /does not\s+create (?:an|the) AVD/i, file);
    assert.match(normalized, /does not\s+install[\s\S]{0,120}JDK[\s\S]{0,120}Android SDK[\s\S]{0,120}Gradle[\s\S]{0,120}PICO build SDK/i, file);
  }
});

test("operational docs publish one exact canonical managed CLI policy block", () => {
  const policyDocs = [
    "README.md",
    "GETTING_STARTED.md",
    "SKILLS.md",
    "AGENTS.md",
    "TESTERS.md",
    "docs/HOSTS.md",
  ];

  for (const file of policyDocs) {
    const markdown = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assertCanonicalManagedPolicyDocument(markdown, file);
  }
});

test("managed CLI policy gate rejects alternate modes and automatic mutation claims", () => {
  const valid = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const alternateClaims = [
    "The MCP invokes pico-cli setup.",
    "The server executes setup.",
    "The MCP invokes update --check.",
    "The MCP runs setup.",
    "The server runs update --check.",
    "The MCP is running pico-cli setup.",
    "The server is executing update --check.",
    "The MCP performs pico-cli setup.",
    "The plugin performs pico-cli setup.",
    "The server launches update --check.",
    "The MCP calls setup for you.",
    "The runtime calls update --check.",
    "Pico-cli setup is automatically performed by the server.",
    "Setup is automatic.",
    "Setup will be launched automatically.",
    "Update --check gets invoked by the MCP.",
    "The server handles setup automatically.",
    "Managed-latest is not the default.",
    "External mode is the default.",
    "External\nis the default mode.",
    "Disabled policy governs CLI operations.",
    "Ambient CLI resolution is preferred.",
    "Global installation is the default.",
    "The MCP modifies PATH for managed commands.",
    "A cached fallback is reported as latest.",
  ];
  const acceptedClaims = alternateClaims.filter((claim) => {
    try {
      assertNoAppendedManagedPolicyClaims(`${valid}\n${claim}`, `alternate claim fixture: ${claim}`);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(acceptedClaims, [], `alternate modes and automatic setup/update claims must be rejected: ${acceptedClaims.join(" | ")}`);

  const mutatedInsideMarker = valid.replace("The MCP never runs setup.", "Setup is performed automatically by the MCP.");
  assert.throws(() => assertCanonicalManagedPolicyDocument(mutatedInsideMarker, "inside-marker mutation"), /canonical policy bytes/);

  // Dated findings/plans/specs, the measurement answer page, and CHANGELOG entries are evidence or
  // implementation history, not operational policy. They remain explicitly outside this
  // exact-block/append scanner so truthful measured/vendor-output quotations are not rewritten as
  // current ambient-command instructions.
  for (const historical of [
    "CHANGELOG.md",
    "docs/ANSWERED_BY_MEASUREMENT.md",
    "docs/findings/PICOCLI_042_SWEEP_2026-08-12.md",
    "docs/findings/PICOCLI_MANAGED_LATEST_2026-08-14.md",
    "docs/superpowers/plans/2026-08-14-managed-pico-cli.md",
    "docs/superpowers/specs/2026-08-14-managed-pico-cli-design.md",
    "docs/superpowers/specs/2026-08-14-pico-evolution-programme-design.md",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, historical)), true, historical);
  }
});

test("managed CLI policy gate accepts external and global prose that does not define resolution policy", () => {
  const valid = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  for (const benign of [
    "External contributors can run these commands locally.",
    "The external documentation lists CLI commands for troubleshooting.",
    "Global search indexes installation examples.",
  ]) {
    assert.doesNotThrow(
      () => assertNoAppendedManagedPolicyClaims(`${valid}\n${benign}`, `benign policy fixture: ${benign}`),
      benign,
    );
  }
});

test("managed-latest finding distinguishes live ledger proof from isolated synthetic battery calls", () => {
  const finding = fs.readFileSync(path.join(repoRoot, "docs/findings/PICOCLI_MANAGED_LATEST_2026-08-14.md"), "utf8");
  assert.doesNotMatch(finding, /^No `record_verification` call[^\n]*occurred\./m);
  assert.match(finding, /no (?:real|live)[^\n]*`record_verification`[^\n]*(?:call|ledger)/i);
  assert.match(finding, /isolated\s+synthetic fixture[^.]{0,160}`record_verification`/i);
});

test("managed CLI implementation plan no longer teaches a freshness-overclaiming setup note", () => {
  const implementationPlan = fs.readFileSync(path.join(repoRoot, "docs/superpowers/plans/2026-08-14-managed-pico-cli.md"), "utf8");
  assert.doesNotMatch(implementationPlan, /managed CLI is current[^\n]{0,160}utility payload/i);
  assert.match(implementationPlan, /resolved CLI package is runnable[^\n]{0,160}utility payload/i);
});

test("answers-by-measurement publishes exactly seven narrow answers backed by tracked citations", () => {
  const answerFile = path.join(repoRoot, "docs", "ANSWERED_BY_MEASUREMENT.md");
  assert.equal(fs.existsSync(answerFile), true, "docs/ANSWERED_BY_MEASUREMENT.md must exist");
  const page = fs.readFileSync(answerFile, "utf8");
  const expectedQuestions = ["5", "23", "24", "25", "33", "36", "37"];
  const questionMatches = [...page.matchAll(/^## Q(\d+)\b[^\n]*$/gm)];
  assert.deepEqual(questionMatches.map((match) => match[1]), expectedQuestions);

  for (let index = 0; index < questionMatches.length; index++) {
    const start = questionMatches[index].index;
    const end = questionMatches[index + 1]?.index ?? page.length;
    const section = page.slice(start, end);
    const question = `Q${expectedQuestions[index]}`;
    assert.equal((section.match(/^### Answer\s*$/gm) ?? []).length, 1, `${question} Answer`);
    assert.equal((section.match(/^### Evidence\s*$/gm) ?? []).length, 1, `${question} Evidence`);
    assert.equal((section.match(/^### Does not prove\s*$/gm) ?? []).length, 1, `${question} Does not prove`);
    const evidence = section.match(/^### Evidence\s*$([\s\S]*?)^### Does not prove\s*$/m)?.[1] ?? "";
    assert.match(evidence, /Evidence type\/class:\s*`(?:configuration|source-derived|structural|logcat|auto_judged|vision_verified|device_verified|partner-stated)(?:`\s*\+\s*`(?:configuration|source-derived|structural|logcat|auto_judged|vision_verified|device_verified|partner-stated))*`?\./, `${question} evidence classification`);
    assert.match(evidence, /\[[^\]]+\]\([^)]+\)/, `${question} tracked citation`);
    const boundary = section.match(/^### Does not prove\s*$([\s\S]*)$/m)?.[1].trim() ?? "";
    assert.ok(boundary.length >= 20, `${question} must state a substantive boundary`);
  }

  assert.doesNotMatch(page, /(?:^|[\s(/])\.dev(?:[\s/)#]|$)/m, "public evidence must not cite .dev");

  const tracked = new Set(spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout.split("\0").filter(Boolean).map((file) => path.normalize(file)));
  const links = [...page.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)].map((match) => match[1]);
  assert.ok(links.length >= expectedQuestions.length, "each answer must carry tracked evidence citations");
  for (const link of links) {
    validateTrackedMarkdownCitation({ link, sourceFile: answerFile, root: repoRoot, tracked });
  }

  const mutationSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pico evidence citation "));
  const mutationRoot = path.join(mutationSandbox, "repo");
  const mutationDocs = path.join(mutationRoot, "docs");
  fs.mkdirSync(mutationDocs, { recursive: true });
  const outside = path.join(mutationSandbox, "outside.md");
  fs.writeFileSync(outside, "outside\n");
  fs.symlinkSync(outside, path.join(mutationDocs, "escape.md"));
  const mutationDev = path.join(mutationRoot, ".dev");
  fs.mkdirSync(mutationDev);
  const devEvidence = path.join(mutationDev, "private.md");
  fs.writeFileSync(devEvidence, "private\n");
  fs.symlinkSync(devEvidence, path.join(mutationDocs, "dev-link.md"));
  const acceptedMutations = [];
  for (const [label, validate] of [
    ["non-line fragment", () => validateTrackedMarkdownCitation({
      link: "BUILD_MATRIX.md#bogus",
      sourceFile: answerFile,
      root: repoRoot,
      tracked,
    })],
    ["second fragment", () => validateTrackedMarkdownCitation({
      link: "BUILD_MATRIX.md#L1#bogus",
      sourceFile: answerFile,
      root: repoRoot,
      tracked,
    })],
    ["tracked symlink escape", () => validateTrackedMarkdownCitation({
      link: "escape.md#L1",
      sourceFile: path.join(mutationDocs, "answer.md"),
      root: mutationRoot,
      tracked: new Set([path.join("docs", "escape.md")]),
    })],
    ["tracked symlink to untracked .dev", () => validateTrackedMarkdownCitation({
      link: "dev-link.md#L1",
      sourceFile: path.join(mutationDocs, "answer.md"),
      root: mutationRoot,
      tracked: new Set([path.join("docs", "dev-link.md")]),
    })],
    ["encoded .dev segment", () => validateTrackedMarkdownCitation({
      link: "../%2Edev/private.md#L1",
      sourceFile: path.join(mutationDocs, "answer.md"),
      root: mutationRoot,
      tracked: new Set([path.join(".dev", "private.md")]),
    })],
  ]) {
    try {
      validate();
      acceptedMutations.push(label);
    } catch {
      // Expected: hostile citation mutations must fail closed.
    }
  }
  assert.deepEqual(acceptedMutations, [], `citation guard accepted mutations: ${acceptedMutations.join(", ")}`);

  const claims = readJson("docs/claims/claims.json");
  assert.deepEqual(
    extractLedgerLabels("plain com.example.unformatted#7 and other-app#2"),
    ["com.example.unformatted#7", "other-app#2"],
    "ledger extraction must not depend on Markdown backticks",
  );
  const ledgerLabels = extractLedgerLabels(page);
  assert.ok(ledgerLabels.length >= 1, "the page must cite measured ledger evidence");
  for (const label of ledgerLabels) {
    const split = label.lastIndexOf("#");
    const app = label.slice(0, split);
    const seq = Number(label.slice(split + 1));
    const ledger = claims.apps.find((entry) => entry.app === app);
    assert.ok(ledger, `cited ledger app is absent from tracked claims: ${label}`);
    assert.ok(ledger.claims.some((claim) => claim.seq === seq), `cited ledger sequence is absent from tracked claims: ${label}`);
  }
});

test("public docs do not use ignored .dev files as evidence", () => {
  const trackedMarkdown = spawnSync("git", ["ls-files", "*.md", "llms.txt"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout.trim().split("\n").filter(Boolean);
  const publicMarkdown = trackedMarkdown.filter((file) => !file.startsWith("docs/superpowers/"));
  assert.ok(publicMarkdown.includes("llms.txt"), "llms.txt must stay inside the public evidence guard");
  for (const file of publicMarkdown) {
    let contents = fs.readFileSync(path.join(repoRoot, file), "utf8");
    if (file === "docs/COLLABORATORS.md") {
      // This one section explains that .dev is ignored and unavailable to consumers; it is not an
      // evidence citation. The rest of the public page remains under the same rejection gate.
      contents = contents.replace(/^## What `\.dev\/` is[\s\S]*?(?=^## )/m, "");
    }
    assertNoPrivateDevCitation(contents, file);
  }

  const acceptedMutations = [];
  for (const mutation of [
    "[proof](../.dev/private.md)",
    "[proof](../../.dev/private.md)",
    "[proof](../%2Edev/private.md)",
    "[proof](..%2F%2Edev%2Fprivate.md)",
    "[proof](../%252Edev/private.md)",
    "[proof](..\\.DEV\\private.md)",
    "progress 100%\n[proof](../%2Edev/private.md)",
    "progress 100%\nevidence: ../%2Edev/private.md",
  ]) {
    try {
      assertNoPrivateDevCitation(mutation, "mutation");
      acceptedMutations.push(mutation);
    } catch {
      // Expected: every spelling of a private citation must fail closed.
    }
  }
  assert.deepEqual(acceptedMutations, [], `public evidence guard accepted: ${acceptedMutations.join(", ")}`);
});

test("the 46 named gate invocations are assigned to 43 Linux, one native-Windows, and two native-macOS lanes", () => {
  const pkg = readJson("package.json");
  const all = ["smoke", ...Object.keys(pkg.scripts).filter((name) => name.startsWith("test:"))];
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "gates.yml"), "utf8");
  const job = (name) => {
    const start = new RegExp(`^  ${name}:\\n`, "m").exec(workflow);
    assert.ok(start, `workflow job ${name} must exist`);
    const bodyStart = start.index + start[0].length;
    const remainder = workflow.slice(bodyStart);
    const next = /^  [A-Za-z0-9_-]+:\n/m.exec(remainder);
    return next ? remainder.slice(0, next.index) : remainder;
  };
  const namedCommands = (body) => [...body.matchAll(/^\s+run:\s+npm run (\S+)\s*$/gm)]
    .map((match) => match[1]).filter((name) => all.includes(name));
  const assigned = {
    linux: namedCommands(job("gates")),
    windows: namedCommands(job("picocli-windows")),
    macos: namedCommands(job("vcam-native")),
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(assigned).map(([host, names]) => [host, names.length])),
    { linux: 43, windows: 1, macos: 2 },
  );
  assert.deepEqual([...new Set(Object.values(assigned).flat())].sort(), [...all].sort(), "each named invocation must be assigned to a host lane");
  assert.equal(Object.values(assigned).flat().length, all.length, "named invocations must not be duplicated across host lanes");

  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8").replaceAll("\n", " ");
  assert.match(readme, /46 gate invocations[\s\S]{0,220}43[\s\S]{0,80}Linux[\s\S]{0,120}(?:one|1)[\s\S]{0,80}(?:native )?Windows[\s\S]{0,120}(?:two|2)[\s\S]{0,80}(?:native )?macOS/i);
});

test("pico-cli 0.4.2 docs state the measured scope and corrected deltas", () => {
  const answers = fs.readFileSync(path.join(repoRoot, "docs", "ANSWERED_BY_MEASUREMENT.md"), "utf8");
  const sweep = fs.readFileSync(path.join(repoRoot, "docs", "findings", "PICOCLI_042_SWEEP_2026-08-12.md"), "utf8");
  const combined = `${answers}\n${sweep}`;
  for (const page of [answers, sweep]) {
    assert.match(page, /fifteen (?:named )?`--help` surfaces[\s\S]{0,180}(?:not a complete|does not constitute a complete)/i);
    assert.match(page, /app launch[\s\S]{0,180}(?:not byte-identical|differed|adds an examples block)/i);
    assert.doesNotMatch(page, /app launch(?:\/|\|)stop(?:\/|\|)list[^\n]{0,120}byte-identical/i);
    assert.match(page, /update --check[\s\S]{0,180}(?:writes|write)[\s\S]{0,100}update-check\.json/i);
  }
  for (const delta of ["device shell", "beta_cn", "plugin doctor", "project create"]) {
    assert.match(combined, new RegExp(delta.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), `missing CLI delta: ${delta}`);
  }
});

test("the scene-understanding ceiling does not resurrect the superseded zero-mesh claim", () => {
  const capabilitySource = fs.readFileSync(path.join(repoRoot, "src", "capability.ts"), "utf8");
  assert.doesNotMatch(capabilitySource, /MESHES remain unresolved|MeshTrackingManager returned 0 in the same probe/i);
  assert.match(capabilitySource, /42.?44 mesh anchors/i);
  assert.match(capabilitySource, /poll for non-empty results/i);
});

test("public guidance does not resurrect refuted capture, scene-understanding, or mesh-collider absolutes", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .trim().split("\n").filter(Boolean)
    .filter((file) => !file.startsWith("docs/claims/") && file !== "CHANGELOG.md");
  const liveGuidanceFiles = tracked.filter((file) => /^(?:src\/|appskeleton\/|README\.md$|ROADMAP\.md$|docs\/DEVICE_VERIFICATION\.md$)/.test(file));
  const liveGuidance = liveGuidanceFiles.map((file) => `${file}\n${fs.readFileSync(path.join(repoRoot, file), "utf8")}`).join("\n");
  assert.doesNotMatch(liveGuidance, /mesh colliders? (?:never|do not|don't|does not)[^\n]{0,80}register/i);
  assert.doesNotMatch(liveGuidance, /(?:emulator:\s*)?0 planes\s*[—-]\s*no-op/i);
  assert.doesNotMatch(liveGuidance, /home bedroom is a Unity black box[^\n]{0,120}(?:unmeasurable|impossible|only)/i);
  assert.doesNotMatch(liveGuidance, /(?:structurally blind to XR-runtime|black (?:adb )?screencap[^\n]{0,100}(?:is|=) (?:a )?capture(?:-path)? artifact[^\n]{0,40}not a failure)/i);
  assert.doesNotMatch(liveGuidance, /adb[^\n]{0,80}(?:does|is)[^\n]{0,80}composited immersive[^\n]{0,100}(?:byte-deterministic|visual ground truth)/i);
  assert.doesNotMatch(liveGuidance, /immersive Unity[^\n]{0,100}returns? (?:a )?BLACK screencap/i);
  assert.doesNotMatch(liveGuidance, /gui_capture[^\n]{0,120}(?:ONLY|REQUIRED)[^\n]{0,80}(?:path|XR-runtime)/i);

  const collider = fs.readFileSync(path.join(repoRoot, "src", "collider.ts"), "utf8");
  assert.match(collider, /mesh colliders are queryable from a RUNTIME MeshResource AND from a LOADED asset/i);
  assert.match(collider, /real trap is ALIGNMENT/i);
  const sense = fs.readFileSync(path.join(repoRoot, "src", "sense.ts"), "utf8");
  assert.match(sense, /~40 SIMULATED planes/i);
  assert.match(sense, /44 distinct anchors/i);
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /(?:black[^\n]{0,120}(?:adb|screencap)[^\n]{0,160}inconclusive|black (?:adb )?frame[^\n]{0,80}inconclusive)/i);
  assert.match(readme, /alternate capture path[^\n]{0,100}LOOK/i);
});

test("published schema-token measurements name the tokenizer and context boundary", () => {
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  for (const measurement of ["5,029", "28,208", "86,927", "32.45%"])
    assert.match(changelog, new RegExp(measurement.replace(/[.%]/g, "\\$&")), measurement);
  assert.match(changelog, /tiktoken[\s\S]{0,80}o200k_base/i);
  assert.match(changelog, /`JSON\.stringify\(result\.tools\)`[\s\S]{0,100}`tools\/list`/i);
  assert.match(changelog, /not (?:the )?total host context/i);
  assert.match(changelog, /characters?\s*[÷/]\s*4/i);
});

test("official-samples guidance retracts the untracked 8\/8 runtime claim", () => {
  for (const file of ["docs/PICO_OFFICIAL_SAMPLES.md", "docs/COLLABORATORS.md", "SKILLS.md"]) {
    const contents = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.match(contents, /(?:does not retain|retains no) (?:a )?tracked[\s\S]{0,180}(?:8\/8|per-sample)/i, file);
    assert.doesNotMatch(contents, /All eight[^\n]{0,120}(?:build and run|verified running)/i, file);
  }
  const samples = fs.readFileSync(path.join(repoRoot, "docs", "PICO_OFFICIAL_SAMPLES.md"), "utf8");
  assert.match(samples, /SpatialML does not build as shipped/i);
  assert.match(samples, /local workaround/i);
});

test("distribution metadata records platform-exact full surfaces, 18 doors-surface tools, and 45 test suites plus smoke", () => {
  const pkg = readJson("package.json");
  const testScripts = Object.keys(pkg.scripts).filter((name) => name.startsWith("test:"));
  assert.equal(testScripts.length, 45, testScripts.join("\n"));
  assert.equal(pkg.scripts["test:distribution-adoption"], "node --test test/distribution-adoption.mjs");

  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "gates.yml"), "utf8");
  for (const script of testScripts) {
    assert.match(workflow, new RegExp(`run: npm run ${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`), script);
  }
  assert.equal((workflow.match(/run: npm run smoke\s/g) ?? []).length, 1);

  const tarball = fs.readFileSync(path.join(repoRoot, "scripts", "verify-tarball.mjs"), "utf8");
  assert.match(tarball, /const EXPECTED_TOOLS = 249;/);
  assert.match(tarball, /const EXPECTED_OTHER_HOST_TOOLS = 246;/);
  assert.match(tarball, /"ensure_pico_cli"/);
  assert.doesNotMatch(tarball, /TOOL_TOLERANCE/);
  assert.match(tarball, /tools\.length === EXPECTED_PLATFORM_TOOLS/);

  const metadataSync = fs.readFileSync(path.join(repoRoot, "scripts", "sync-metadata.mjs"), "utf8");
  assert.match(metadataSync, /other hosts\|Linux/, "metadata sync must keep the measured Linux count aligned");
  assert.match(metadataSync, /Windows\\s\+[\s\S]{0,180}source-derived/, "metadata sync must keep the source-derived Windows count aligned");

  const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /doors surface[\s\S]{0,120}: 18/);
  for (const file of [
    "README.md",
    "QUICKSTART.md",
    "GETTING_STARTED.md",
    "TESTERS.md",
    "AGENTS.md",
    "SKILLS.md",
    "docs/HOSTS.md",
    "docs/COLLABORATORS.md",
  ]) {
    const prose = fs.readFileSync(path.join(repoRoot, file), "utf8").replaceAll("\n", " ");
    assert.match(prose, /249(?: tools?)? on macOS[\s\S]{0,220}246(?: tools?)? on Linux[\s\S]{0,260}Windows[\s\S]{0,100}source-derived/i, file);
    assert.doesNotMatch(prose, /\b249\+(?:[- ]tools?)?/i, file);
  }

  for (const description of [
    readJson(".claude-plugin/plugin.json").description,
    readJson(".claude-plugin/marketplace.json").plugins[0].description,
  ]) {
    assert.match(description, /249 tools on macOS \/ 246 on Linux[\s\S]{0,100}Windows[\s\S]{0,80}source-derived/i);
  }
});
