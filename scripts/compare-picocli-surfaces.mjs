#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PACKAGE = "@picoxr/pico-cli";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_DEPTH = 8;
const MAX_HELP_INVOCATIONS = 256;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 250;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const INVOCATION_TOKEN_ENV = "PICO_CLI_SWEEP_INVOCATION_TOKEN";
const INVOCATION_TOKEN_PATTERN = /^[1-9]\d*-[a-f0-9]{48}$/;
const PROCESS_SCAN_TIMEOUT_MS = 250;
const PROCESS_SCAN_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROCESS_SCAN_MAX_MATCHES = 256;

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
const killGraceMs = positiveEnvInteger("PICO_CLI_SWEEP_KILL_GRACE_MS", DEFAULT_KILL_GRACE_MS);
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

function terminateDirectOrGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
    return;
  } catch {
    try { child.kill(signal); } catch { /* child already exited */ }
  }
}

function posixPsPath() {
  if (process.platform === "win32") return null;
  return ["/bin/ps", "/usr/bin/ps"].find((candidate) => fs.existsSync(candidate)) ?? null;
}

function posixDescendants(rootPid) {
  if (process.platform === "win32" || !Number.isSafeInteger(rootPid) || rootPid <= 1) return [];
  const psPath = posixPsPath();
  if (!psPath) return [];
  let result;
  try {
    result = spawnSync(psPath, ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: PROCESS_SCAN_TIMEOUT_MS,
      maxBuffer: PROCESS_SCAN_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch {
    return [];
  }
  if (result.error || result.status !== 0) return [];
  const byParent = new Map();
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!byParent.has(parentPid)) byParent.set(parentPid, []);
    byParent.get(parentPid).push(pid);
  }
  const descendants = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parentPid = queue.shift();
    for (const pid of byParent.get(parentPid) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      descendants.push(pid);
      queue.push(pid);
    }
  }
  return descendants;
}

function posixInvocationOwners(invocationToken) {
  if (!INVOCATION_TOKEN_PATTERN.test(invocationToken)) return [];
  const psPath = posixPsPath();
  if (!psPath) return [];
  let result;
  try {
    result = spawnSync(psPath, ["eww", "-A", "-o", "pid=", "-o", "command="], {
      encoding: "utf8",
      timeout: PROCESS_SCAN_TIMEOUT_MS,
      maxBuffer: PROCESS_SCAN_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch {
    return [];
  }
  if (result.error || result.status !== 0) return [];
  // The scan output contains other processes' environments. It is bounded, matched in memory,
  // and deliberately never included in an error or log.
  const assignment = `${INVOCATION_TOKEN_ENV}=${invocationToken}`;
  const owners = new Set();
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) continue;
    const details = match[2];
    let offset = details.indexOf(assignment);
    let exactMatch = false;
    while (offset >= 0) {
      const before = offset === 0 || /\s/.test(details[offset - 1]);
      const end = offset + assignment.length;
      const after = end === details.length || /\s/.test(details[end]);
      if (before && after) {
        exactMatch = true;
        break;
      }
      offset = details.indexOf(assignment, offset + 1);
    }
    if (!exactMatch) continue;
    owners.add(pid);
    if (owners.size > PROCESS_SCAN_MAX_MATCHES) return [];
  }
  return [...owners];
}

function signalPosixPidOrGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    try { process.kill(pid, signal); } catch { /* process already exited */ }
  }
}

function runBounded(session, command, args) {
  return new Promise((resolve) => {
    // A detached descendant can outlive and be reparented away from a fast-exiting group leader.
    // This unguessable child-only capability keeps ownership exact after that PPID link disappears.
    const invocationToken = `${process.pid}-${crypto.randomBytes(24).toString("hex")}`;
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let spawnError;
    let settled = false;
    let aborting = false;
    let observedCode = null;
    let observedSignal = null;
    let timer;
    let abortTimer;
    let child;
    let treeKiller;
    const observedDescendants = new Set();

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(abortTimer);
      resolve({
        code: observedCode ?? child?.exitCode ?? null,
        signal: observedSignal ?? child?.signalCode ?? null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        outputTruncated,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    const settleAborted = () => {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      treeKiller?.unref();
      finish();
    };

    const rememberPosixDescendants = () => {
      for (const pid of posixDescendants(child?.pid)) observedDescendants.add(pid);
      for (const pid of posixInvocationOwners(invocationToken)) {
        if (pid !== child?.pid) observedDescendants.add(pid);
      }
    };

    const signalPosixTree = (signal) => {
      for (const pid of [...observedDescendants].reverse()) signalPosixPidOrGroup(pid, signal);
      terminateDirectOrGroup(child, signal);
    };

    const beginAbort = () => {
      if (settled || aborting) return;
      aborting = true;

      if (process.platform === "win32") {
        const systemRoot = session.env.SystemRoot ?? session.env.SYSTEMROOT ?? "C:\\Windows";
        const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
        if (child?.pid) {
          try {
            treeKiller = spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
              env: session.env,
              stdio: "ignore",
              windowsHide: true,
            });
            treeKiller.once("error", () => terminateDirectOrGroup(child, "SIGKILL"));
            treeKiller.once("close", (code) => {
              if (code !== 0) terminateDirectOrGroup(child, "SIGKILL");
              settleAborted();
            });
          } catch {
            terminateDirectOrGroup(child, "SIGKILL");
          }
        } else {
          terminateDirectOrGroup(child, "SIGKILL");
        }
        abortTimer = setTimeout(() => {
          try { treeKiller?.kill("SIGKILL"); } catch { /* tree killer already exited */ }
          terminateDirectOrGroup(child, "SIGKILL");
          settleAborted();
        }, killGraceMs);
        return;
      }

      rememberPosixDescendants();
      signalPosixTree("SIGTERM");
      abortTimer = setTimeout(() => {
        rememberPosixDescendants();
        signalPosixTree("SIGKILL");
        settleAborted();
      }, killGraceMs);
    };

    try {
      child = spawn(command, args, {
        cwd: session.cwd,
        env: { ...session.env, [INVOCATION_TOKEN_ENV]: invocationToken },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      finish();
      return;
    }

    const append = (chunks, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      capturedBytes += chunk.length;
      if (capturedBytes > maxOutputBytes && !outputTruncated) {
        outputTruncated = true;
        beginAbort();
      }
    };
    child.stdout.on("data", (chunk) => append(stdout, Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => append(stderr, Buffer.from(chunk)));
    child.on("error", (error) => {
      spawnError = error.message;
      if (!aborting) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }
    });
    child.on("exit", (code, signal) => {
      observedCode = code;
      observedSignal = signal;
    });
    child.on("close", (code, signal) => {
      observedCode = code;
      observedSignal = signal;
      if (!aborting) finish();
    });
    timer = setTimeout(() => {
      timedOut = true;
      beginAbort();
    }, timeoutMs);
  });
}

function requireComplete(result, label, allowNonzero = false) {
  const retainedOutput = Buffer.concat([result.stdout, result.stderr]).toString("utf8").slice(-2_000);
  const outputSuffix = retainedOutput ? `: ${retainedOutput}` : "";
  if (result.spawnError) fail(`${label} could not start: ${result.spawnError}${outputSuffix}`);
  if (result.timedOut) fail(`${label} timed out${outputSuffix}`);
  if (result.outputTruncated) fail(`${label} exceeded the output capture limit${outputSuffix}`);
  if (result.code === null) fail(`${label} terminated without an exit code${result.signal ? ` (${result.signal})` : ""}${outputSuffix}`);
  if (!allowNonzero && result.code !== 0) {
    fail(`${label} exited ${result.code}${outputSuffix}`);
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
    "install", "--prefix", root, "--ignore-scripts", "--no-save", "--package-lock=false", "--fund=false", "--audit=false",
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
const COMMAND_SECTION_HEADINGS = new Set(["Commands:", "Available Commands:"]);
const COMMAND_SECTION_LIKE_HEADING = /^(?:(?:available|additional|other)\s+)?(?:sub[- ]?)?commands?(?:\s+(?:groups?|list))?:$/i;
const COMMAND_SECTION_BOUNDARIES = new Set(["Options:", "Arguments:", "Positionals:", "Examples:", "Global Options:"]);
const SAFE_COMMAND_TOKEN_SOURCE = "[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*";
const SAFE_COMMAND_TOKEN = new RegExp(`^${SAFE_COMMAND_TOKEN_SOURCE}$`);
const SAFE_COMMAND_SEQUENCE_PREFIX = new RegExp(`^${SAFE_COMMAND_TOKEN_SOURCE}(?:[ \\t]+${SAFE_COMMAND_TOKEN_SOURCE})*`);
const COMMAND_ARGUMENT_NOTATION = /^(?:(?:\s+|=)?(?:<[^<>\r\n]+>|\[[^\[\]\r\n]+\]))+$/;

function advertisedCommands(helpBytes) {
  const lines = helpBytes.toString("utf8").replace(ANSI_CSI, "").replace(/\r\n/g, "\n").split("\n");
  const normalizedLines = lines.map((line) => ({
    line,
    text: line.trim(),
    indent: line.match(/^[ \t]*/)[0].length,
  }));
  const unsupportedHeading = normalizedLines.find(({ text }) => COMMAND_SECTION_LIKE_HEADING.test(text)
    && !COMMAND_SECTION_HEADINGS.has(text));
  if (unsupportedHeading !== undefined) {
    fail(`unrecognized command-section-like heading: ${JSON.stringify(unsupportedHeading.text)}`);
  }
  const heading = normalizedLines.findIndex(({ text }) => COMMAND_SECTION_HEADINGS.has(text));
  if (heading < 0) return { recognizedHeading: false, commands: [] };
  const headingIndent = normalizedLines[heading].indent;
  const section = [];
  for (let index = heading + 1; index < normalizedLines.length; index += 1) {
    const { line, text, indent } = normalizedLines[index];
    if (line.trim() === "") continue;
    if (indent < headingIndent) break;
    if (indent === headingIndent) {
      if (COMMAND_SECTION_BOUNDARIES.has(text)) break;
      fail(`unsupported command-section indentation or boundary: ${JSON.stringify(text)}`);
    }
    section.push({ line, indent });
  }
  if (section.length === 0) return { recognizedHeading: true, commands: [] };
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
  const sortedCommands = [...commands.values()].sort((left, right) => {
    const leftKey = left.join(" ");
    const rightKey = right.join(" ");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return { recognizedHeading: true, commands: sortedCommands };
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
    const advertised = advertisedCommands(exactHelp);
    if (tokens.length === 0 && !advertised.recognizedHeading) {
      fail(`${installed.version} root help did not expose a recognized root command heading`);
    }
    for (const advertisedTokens of advertised.commands) {
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
