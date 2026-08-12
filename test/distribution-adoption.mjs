import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  assert.deepEqual(DEFAULT_KNOWLEDGE_ARGS, ["mcp", "spatial-knowledge"]);

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

test("KnowledgeBridge provisions only its production default pico-cli command", { concurrency: false }, async () => {
  const [{ KnowledgeBridge }, picocli] = await Promise.all([
    import("../dist/knowledge.js"),
    import("../dist/picocli.js"),
  ]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico knowledge provision "));
  const fakeBin = path.join(tempRoot, "bin");
  const npmLog = path.join(tempRoot, "npm.jsonl");
  const npmDriver = path.join(tempRoot, "fake-npm.mjs");
  const knowledgeLog = path.join(tempRoot, "knowledge.jsonl");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(npmDriver, `
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stderr.write("npm ERR! code ENETUNREACH network request failed\\n");
process.exit(1);
`);
  writeNodeCommand(fakeBin, "npm", npmDriver);

  const pathKey = process.platform === "win32"
    ? Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path"
    : "PATH";
  const priorPath = process.env[pathKey];
  const priorAutoInstall = process.env[picocli.PICO_CLI_AUTOINSTALL_ENV];
  const priorAutoUpdate = process.env[picocli.PICO_CLI_AUTOUPDATE_ENV];
  process.env[pathKey] = fakeBin;
  process.env[picocli.PICO_CLI_AUTOINSTALL_ENV] = "1";
  delete process.env[picocli.PICO_CLI_AUTOUPDATE_ENV];
  picocli.probePicoCli(true);

  const production = new KnowledgeBridge({ startupTimeoutMs: 500, callTimeoutMs: 500 });
  let custom;
  try {
    const unavailable = await production.call("graph_stats", {});
    assert.equal(unavailable.status, "unavailable", JSON.stringify(unavailable));
    assert.equal(unavailable.failureClass, "network", JSON.stringify(unavailable));
    assert.equal(unavailable.cliProvisioning?.status, "failed");
    assert.equal(unavailable.cliProvisioning?.phase, "install");
    assert.deepEqual(readJsonLines(npmLog).map((entry) => entry), [
      ["install", "-g", "@picoxr/pico-cli"],
    ]);

    custom = new KnowledgeBridge({
      command: process.execPath,
      args: [path.join(repoRoot, "test", "fixtures", "fake-knowledge-server.mjs")],
      cwd: repoRoot,
      env: { FAKE_KNOWLEDGE_LOG: knowledgeLog },
      startupTimeoutMs: 2_000,
      callTimeoutMs: 1_000,
    });
    const customResult = await custom.call("graph_stats", {});
    assert.equal(customResult.status, "ok", JSON.stringify(customResult));
    assert.equal(Object.hasOwn(customResult, "cliProvisioning"), false);
    assert.equal(readJsonLines(npmLog).length, 1, "an injected custom command must not provision pico-cli");
  } finally {
    await custom?.close();
    await production.close();
    if (priorPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = priorPath;
    if (priorAutoInstall === undefined) delete process.env[picocli.PICO_CLI_AUTOINSTALL_ENV];
    else process.env[picocli.PICO_CLI_AUTOINSTALL_ENV] = priorAutoInstall;
    if (priorAutoUpdate === undefined) delete process.env[picocli.PICO_CLI_AUTOUPDATE_ENV];
    else process.env[picocli.PICO_CLI_AUTOUPDATE_ENV] = priorAutoUpdate;
    picocli.probePicoCli(true);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

test("answers-by-measurement publishes exactly six narrow answers backed by tracked citations", () => {
  const answerFile = path.join(repoRoot, "docs", "ANSWERED_BY_MEASUREMENT.md");
  assert.equal(fs.existsSync(answerFile), true, "docs/ANSWERED_BY_MEASUREMENT.md must exist");
  const page = fs.readFileSync(answerFile, "utf8");
  const expectedQuestions = ["5", "23", "24", "25", "33", "36"];
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

test("distribution metadata records platform-exact full surfaces, 17 doors, and 44 test suites plus smoke", () => {
  const pkg = readJson("package.json");
  const testScripts = Object.keys(pkg.scripts).filter((name) => name.startsWith("test:"));
  assert.equal(testScripts.length, 44, testScripts.join("\n"));
  assert.equal(pkg.scripts["test:distribution-adoption"], "node --test test/distribution-adoption.mjs");

  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "gates.yml"), "utf8");
  for (const script of testScripts) {
    assert.match(workflow, new RegExp(`run: npm run ${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`), script);
  }
  assert.equal((workflow.match(/run: npm run smoke\s/g) ?? []).length, 1);

  const tarball = fs.readFileSync(path.join(repoRoot, "scripts", "verify-tarball.mjs"), "utf8");
  assert.match(tarball, /const EXPECTED_TOOLS = 248;/);
  assert.match(tarball, /const EXPECTED_OTHER_HOST_TOOLS = 245;/);
  assert.match(tarball, /"ensure_pico_cli"/);
  assert.doesNotMatch(tarball, /TOOL_TOLERANCE/);
  assert.match(tarball, /tools\.length === EXPECTED_PLATFORM_TOOLS/);

  const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /doors surface[\s\S]{0,120}: 17/);
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
    assert.match(prose, /248(?: tools?)? on macOS[\s\S]{0,160}245(?: tools?)? on other hosts/i, file);
    assert.doesNotMatch(prose, /\b248\+(?:[- ]tools?)?/i, file);
  }

  for (const description of [
    readJson(".claude-plugin/plugin.json").description,
    readJson(".claude-plugin/marketplace.json").plugins[0].description,
  ]) {
    assert.match(description, /248 tools on macOS \/ 245 on other hosts/i);
  }
});
