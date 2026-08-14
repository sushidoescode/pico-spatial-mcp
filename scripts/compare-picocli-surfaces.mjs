#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PACKAGE = "@picoxr/pico-cli";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_DEPTH = 8;
const MAX_HELP_INVOCATIONS = 256;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function positiveEnvInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(`${name} must be a positive integer`);
  return Number(raw);
}

const timeoutMs = positiveEnvInteger("PICO_CLI_SWEEP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
const maxOutputBytes = positiveEnvInteger("PICO_CLI_SWEEP_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES);

function parseArguments(argv) {
  const allowed = new Set(["--from", "--to", "--output"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) fail(`invalid argument near ${flag ?? "<end>"}`);
    if (values.has(flag)) fail(`duplicate argument ${flag}`);
    values.set(flag, value);
  }
  if (values.size !== 3) fail("usage: compare-picocli-surfaces.mjs --from <semver> --to <semver|latest> --output <absolute-json-path>");
  const from = values.get("--from");
  const to = values.get("--to");
  const output = values.get("--output");
  if (!STABLE_SEMVER.test(from)) fail("--from must be a stable semantic version");
  if (to !== "latest" && !STABLE_SEMVER.test(to)) fail("--to must be a stable semantic version or latest");
  if (!path.isAbsolute(output)) fail("--output must be an absolute path");
  if (fs.existsSync(output)) fail("--output already exists; refusing to replace it");
  const parent = path.dirname(output);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) fail("--output parent directory must exist");
  return { from, to, output };
}

function terminate(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* child already exited */ }
  }
}

function runBounded(session, command, args) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let spawnError;
    let settled = false;
    let timer;
    const child = spawn(command, args, {
      cwd: session.cwd,
      env: session.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunks, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      capturedBytes += chunk.length;
      if (capturedBytes > maxOutputBytes && !outputTruncated) {
        outputTruncated = true;
        terminate(child);
      }
    };
    child.stdout.on("data", (chunk) => append(stdout, Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => append(stderr, Buffer.from(chunk)));
    child.on("error", (error) => { spawnError = error.message; });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut, outputTruncated, spawnError });
    });
    timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    timer.unref?.();
  });
}

function requireComplete(result, label, allowNonzero = false) {
  if (result.spawnError) fail(`${label} could not start: ${result.spawnError}`);
  if (result.timedOut) fail(`${label} timed out`);
  if (result.outputTruncated) fail(`${label} exceeded the output capture limit`);
  if (result.code === null) fail(`${label} terminated without an exit code${result.signal ? ` (${result.signal})` : ""}`);
  if (!allowNonzero && result.code !== 0) {
    const tail = Buffer.concat([result.stdout, result.stderr]).toString("utf8").slice(-2_000);
    fail(`${label} exited ${result.code}: ${tail}`);
  }
  return result;
}

function assertSafeCliArgv(argv) {
  const isVersion = argv.length === 1 && argv[0] === "-v";
  const isHelp = argv.length >= 1 && argv.at(-1) === "--help";
  if (!isVersion && !isHelp) fail(`central CLI safety guard rejected ${JSON.stringify(argv)}`);
  if (argv[0] === "setup") fail("central CLI safety guard rejected the setup subtree");
  for (let index = 0; index + 1 < argv.length; index += 1) {
    if (argv[index] === "update" && argv[index + 1] === "--check") fail("central CLI safety guard rejected update --check");
  }
}

async function invokeCli(session, cliPath, argv, label, allowNonzero = false) {
  assertSafeCliArgv(argv);
  return requireComplete(await runBounded(session, cliPath, argv), label, allowNonzero);
}

function parseVersion(bytes) {
  const match = bytes.toString("utf8").trim().match(/^pico-cli\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\s.*)?$/);
  return match ? match[0].match(/\d+\.\d+\.\d+/)?.[0] ?? null : null;
}

async function resolveLatest(session) {
  const result = requireComplete(await runBounded(session, "npm", [
    "view", `${PACKAGE}@latest`, "version", "dist.integrity", "--json",
  ]), "npm registry lookup");
  let parsed;
  try { parsed = JSON.parse(result.stdout.toString("utf8")); }
  catch { fail("npm registry lookup returned malformed JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).sort().join("\0") !== ["dist.integrity", "version"].join("\0")
    || !STABLE_SEMVER.test(parsed.version)
    || (parsed["dist.integrity"] !== null && typeof parsed["dist.integrity"] !== "string")) {
    fail("npm registry lookup returned invalid package metadata");
  }
  return parsed.version;
}

async function installExact(session, requested, exactVersion) {
  const root = fs.mkdtempSync(path.join(session.root, "version-"));
  requireComplete(await runBounded(session, "npm", [
    "install", "--prefix", root, "--no-save", "--package-lock=false", "--fund=false", "--audit=false",
    `${PACKAGE}@${exactVersion}`,
  ]), `${PACKAGE}@${exactVersion} install`);
  const packagePath = path.join(root, "node_modules", "@picoxr", "pico-cli", "package.json");
  let packageJson;
  try { packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")); }
  catch { fail(`${PACKAGE}@${exactVersion} did not install valid package metadata`); }
  if (packageJson?.name !== PACKAGE || packageJson?.version !== exactVersion) fail(`${PACKAGE}@${exactVersion} package version did not match`);
  const cliPath = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
  let stat;
  try { stat = fs.statSync(cliPath); } catch { fail(`${PACKAGE}@${exactVersion} did not install its CLI shim`); }
  if (!stat.isFile()) fail(`${PACKAGE}@${exactVersion} CLI shim is not a file`);
  const versionResult = await invokeCli(session, cliPath, ["-v"], `${PACKAGE}@${exactVersion} version`);
  const reportedVersion = parseVersion(Buffer.concat([versionResult.stdout, versionResult.stderr]));
  if (reportedVersion !== exactVersion) fail(`${PACKAGE}@${exactVersion} reported version ${reportedVersion ?? "unknown"}`);
  return { requested, version: exactVersion, cliPath };
}

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const COMMAND_SECTION_BOUNDARIES = new Set(["Options:", "Arguments:", "Positionals:", "Examples:", "Global Options:"]);
const SAFE_COMMAND_TOKEN_SOURCE = "[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*";
const SAFE_COMMAND_TOKEN = new RegExp(`^${SAFE_COMMAND_TOKEN_SOURCE}$`);
const SAFE_COMMAND_SEQUENCE_PREFIX = new RegExp(`^${SAFE_COMMAND_TOKEN_SOURCE}(?:[ \\t]+${SAFE_COMMAND_TOKEN_SOURCE})*`);
const COMMAND_ARGUMENT_NOTATION = /^(?:(?:\s+|=)?(?:<[^<>\r\n]+>|\[[^\[\]\r\n]+\]))+$/;

function advertisedCommands(helpBytes) {
  const lines = helpBytes.toString("utf8").replace(ANSI_CSI, "").replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex((line) => line === "Commands:");
  if (heading < 0) return [];
  const section = [];
  for (let index = heading + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent === 0) break;
    section.push({ line, indent });
  }
  if (section.length === 0) return [];
  const entryIndent = Math.min(...section.map((entry) => entry.indent));
  const commands = new Map();
  for (const entry of section) {
    if (entry.indent !== entryIndent) continue;
    const text = entry.line.trim();
    if (COMMAND_SECTION_BOUNDARIES.has(text)) break;
    const syntax = text.split(/\s{2,}/, 1)[0];
    const sequence = syntax.match(SAFE_COMMAND_SEQUENCE_PREFIX)?.[0] ?? "";
    const tokens = sequence.split(/[ \t]+/).filter(Boolean);
    const argumentNotation = syntax.slice(sequence.length);
    if (tokens.length === 0
      || tokens.length > MAX_DEPTH
      || tokens.some((token) => !SAFE_COMMAND_TOKEN.test(token))
      || (argumentNotation.length > 0 && !COMMAND_ARGUMENT_NOTATION.test(argumentNotation))) {
      fail(`unsupported advertised command grammar: ${JSON.stringify(text)}`);
    }
    commands.set(tokens.join("\0"), tokens);
  }
  return [...commands.values()].sort((left, right) => {
    const leftKey = left.join(" ");
    const rightKey = right.join(" ");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function commandKey(tokens) {
  return tokens.length === 0 ? "pico-cli" : tokens.join(" ");
}

async function enumerateSurface(session, installed) {
  const queue = [[]];
  const queued = new Set([JSON.stringify([])]);
  const visited = new Set();
  const hashes = new Map();
  while (queue.length > 0) {
    if (visited.size >= MAX_HELP_INVOCATIONS) fail(`${installed.version} exceeded ${MAX_HELP_INVOCATIONS} help invocations`);
    const tokens = queue.shift();
    const serialized = JSON.stringify(tokens);
    if (visited.has(serialized)) continue;
    visited.add(serialized);
    const result = await invokeCli(session, installed.cliPath, [...tokens, "--help"], `${installed.version} ${commandKey(tokens)} --help`, true);
    const exactHelp = Buffer.concat([result.stdout, result.stderr]);
    hashes.set(commandKey(tokens), crypto.createHash("sha256").update(exactHelp).digest("hex"));
    for (const advertisedTokens of advertisedCommands(exactHelp)) {
      const child = [...tokens, ...advertisedTokens];
      if (child[0] === "setup") continue;
      if (child.length > MAX_DEPTH) fail(`${installed.version} exceeded command depth ${MAX_DEPTH}`);
      const childSerialized = JSON.stringify(child);
      if (!visited.has(childSerialized) && !queued.has(childSerialized)) {
        queued.add(childSerialized);
        queue.push(child);
      }
    }
    if (visited.size + queue.length > MAX_HELP_INVOCATIONS) fail(`${installed.version} advertised more than ${MAX_HELP_INVOCATIONS} help paths`);
  }
  return hashes;
}

function reportFor(fromInstalled, toInstalled, fromHashes, toHashes) {
  const fromKeys = new Set(fromHashes.keys());
  const toKeys = new Set(toHashes.keys());
  const addedCommands = [...toKeys].filter((key) => !fromKeys.has(key)).sort();
  const removedCommands = [...fromKeys].filter((key) => !toKeys.has(key)).sort();
  const changedHelp = [...fromKeys].filter((key) => toKeys.has(key) && fromHashes.get(key) !== toHashes.get(key)).sort()
    .map((command) => ({ command, fromSha256: fromHashes.get(command), toSha256: toHashes.get(command) }));
  const unchangedCommands = [...fromKeys].filter((key) => toKeys.has(key) && fromHashes.get(key) === toHashes.get(key)).sort();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    from: { requested: fromInstalled.requested, version: fromInstalled.version, commandCount: fromHashes.size },
    to: { requested: toInstalled.requested, version: toInstalled.version, commandCount: toHashes.size },
    addedCommands,
    removedCommands,
    changedHelp,
    unchangedCommands,
    safety: { setupInvoked: false, nonHelpCommandsInvoked: false },
  };
}

function writeAtomicNew(output, report) {
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, output);
    try {
      const directory = fs.openSync(path.dirname(output), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { /* directory fsync is not supported on every platform */ }
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* preserve original failure */ }
    try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pico-cli-surface-session-")));
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  const npmCache = path.join(root, "npm-cache");
  const xdgConfig = path.join(root, "xdg-config");
  const xdgCache = path.join(root, "xdg-cache");
  const xdgData = path.join(root, "xdg-data");
  for (const directory of [home, cwd, npmCache, xdgConfig, xdgCache, xdgData]) fs.mkdirSync(directory);
  const npmUserConfig = path.join(home, ".npmrc");
  const session = {
    root,
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NPM_CONFIG_CACHE: npmCache,
      npm_config_cache: npmCache,
      NPM_CONFIG_USERCONFIG: npmUserConfig,
      npm_config_userconfig: npmUserConfig,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
    },
  };
  try {
    const toVersion = args.to === "latest" ? await resolveLatest(session) : args.to;
    const fromInstalled = await installExact(session, args.from, args.from);
    const fromHashes = await enumerateSurface(session, fromInstalled);
    const toInstalled = await installExact(session, args.to, toVersion);
    const toHashes = await enumerateSurface(session, toInstalled);
    writeAtomicNew(args.output, reportFor(fromInstalled, toInstalled, fromHashes, toHashes));
    process.stdout.write(`${args.output}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`pico-cli surface comparison failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
