import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  probePicoCli,
  PICO_CLI_AUTOINSTALL_ENV,
  PICO_CLI_AUTOUPDATE_ENV,
  runPicoCliCommand,
} from "../../dist/picocli.js";

const savedEnv = new Map();
export const tempRoots = [];
const trackedEnv = [
  "PATH",
  "Path",
  PICO_CLI_AUTOINSTALL_ENV,
  PICO_CLI_AUTOUPDATE_ENV,
  "PICO_TEST_FULL_ENV",
  "FAKE_PICO_STATE",
  "FAKE_PICO_LOG",
  "FAKE_PICO_BIN",
  "FAKE_PICO_CLI_TEMPLATE",
  "FAKE_PICO_CLI_TARGET",
  "FAKE_PICO_PREFIX",
  "FAKE_NPM_MODE",
  "FAKE_LATEST_VERSION",
  "FAKE_REGISTRY_INTEGRITY",
  "FAKE_REGISTRY_MODE",
  "FAKE_PICO_DRIVER",
  "FAKE_CANARY_FAILURE",
];

function runtimeDriverSource() {
  return `
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const [role, ...args] = process.argv.slice(2);
const logPath = process.env.FAKE_PICO_LOG;
const record = (extra = {}) => {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify({ role, args, pid: process.pid, ...extra }) + "\\n");
};
record();

if (role === "node-proxy") {
  const child = spawn(process.execPath, args, { env: process.env, stdio: "inherit", windowsHide: true });
  child.once("error", (error) => { process.stderr.write(error.message + "\\n"); process.exit(127); });
  child.once("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  await new Promise(() => {});
}

if (role === "managed-cli") {
  const [version, ...cliArgs] = args;
  if (cliArgs[0] === "-v") {
    process.stdout.write("pico-cli/" + version + " (managed runtime fixture)\\n");
    process.exit(0);
  }
  if (cliArgs.at(-1) === "--help") {
    process.stdout.write("fixture help: " + cliArgs.join(" ") + "\\n");
    process.exit(0);
  }
  if (cliArgs.join(" ") === "mcp dev-knowledge") {
    await import(pathToFileURL(process.env.FAKE_KNOWLEDGE_SERVER).href);
    await new Promise(() => {});
  }
  if (cliArgs.join(" ") === "emulator status --format json") {
    process.stdout.write(JSON.stringify({ tool_status: "SUCCESS", data: { fixture: true }, errors: [] }) + "\\n");
    process.exit(0);
  }
  if (process.env.FAKE_PICO_OPERATION_MODE === "setup-required") {
    process.stderr.write("Error: Perf utilities 0.4.2 are not installed. Run \`pico-cli setup\` to install.\\n");
    process.exit(1);
  }
  process.stdout.write("fake managed pico-cli operation complete\\n");
  process.exit(0);
}

if (role !== "npm") {
  process.stderr.write("unexpected fixture role: " + role + "\\n");
  process.exit(2);
}

if (args[0] === "prefix" && args[1] === "-g") {
  process.stdout.write(process.env.FAKE_PICO_GLOBAL_PREFIX + "\\n");
  process.exit(0);
}

if (args[0] === "view") {
  const delayMs = Number(process.env.FAKE_PICO_VIEW_DELAY_MS ?? 0);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (process.env.FAKE_REGISTRY_MODE === "failure") {
    process.stderr.write("npm ERR! fixture registry unavailable\\n");
    process.exit(1);
  }
  const version = fs.readFileSync(process.env.FAKE_LATEST_VERSION_FILE, "utf8").trim();
  process.stdout.write(JSON.stringify({ version, "dist.integrity": "sha512-runtime-fixture" }) + "\\n");
  process.exit(0);
}

if (args[0] === "install") {
  const prefixIndex = args.indexOf("--prefix");
  if (prefixIndex < 0) {
    const target = process.env.FAKE_PICO_GLOBAL_CLI;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const version = fs.readFileSync(process.env.FAKE_LATEST_VERSION_FILE, "utf8").trim();
    if (process.platform === "win32") {
      fs.writeFileSync(target, '@echo off\\r\\n"' + process.execPath + '" "' + process.env.FAKE_PICO_DRIVER + '" managed-cli "' + version + '" %*\\r\\n');
    } else {
      fs.writeFileSync(target, '#!/bin/sh\\nexec "' + process.execPath + '" "' + process.env.FAKE_PICO_DRIVER + '" managed-cli "' + version + '" "$@"\\n', { mode: 0o755 });
    }
    process.stdout.write("installed fake global pico-cli\\n");
    process.exit(0);
  }
  const prefix = args[prefixIndex + 1];
  const packageArg = args.at(-1);
  const version = packageArg.slice("@picoxr/pico-cli@".length);
  const packageRoot = path.join(prefix, "node_modules", "@picoxr", "pico-cli");
  const shimDir = path.join(prefix, "node_modules", ".bin");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@picoxr/pico-cli", version }));
  const shim = path.join(shimDir, process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
  if (process.platform === "win32") {
    fs.writeFileSync(shim, '@echo off\\r\\n"' + process.execPath + '" "' + process.env.FAKE_PICO_DRIVER + '" managed-cli "' + version + '" %*\\r\\n');
  } else {
    fs.writeFileSync(shim, '#!/bin/sh\\nexec "' + process.execPath + '" "' + process.env.FAKE_PICO_DRIVER + '" managed-cli "' + version + '" "$@"\\n', { mode: 0o755 });
  }
  process.stdout.write("installed exact fake managed pico-cli\\n");
  process.exit(0);
}

process.stderr.write("unexpected fake npm argv: " + JSON.stringify(args) + "\\n");
process.exit(2);
`;
}

export function saveEnvironment() {
  for (const key of trackedEnv) savedEnv.set(key, process.env[key]);
}

export function restoreEnvironment() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeCommand(binDir, name, driverPath, role, fixedArgs = []) {
  if (process.platform === "win32") {
    const command = path.join(binDir, `${name}.cmd`);
    const fixed = fixedArgs.map((arg) => ` "${String(arg).replaceAll('"', '""')}"`).join("");
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${driverPath}" ${role}${fixed} %*\r\n`);
    return command;
  }
  const command = path.join(binDir, name);
  const fixed = fixedArgs.map((arg) => ` ${shQuote(arg)}`).join("");
  fs.writeFileSync(command, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(driverPath)} ${shQuote(role)}${fixed} "$@"\n`, { mode: 0o755 });
  return command;
}

export function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Fresh-process Task 4 fixture. It never mutates this test process's HOME/PATH and every npm/CLI
 * byte lives below one temporary root. Callers pass `env` to a newly spawned Node/MCP child.
 */
export function createManagedRuntimeHarness({ latestVersion = "0.4.2", operationMode = "success" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico managed runtime "));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const globalPrefix = path.join(root, "fake-global");
  const globalBin = process.platform === "win32" ? globalPrefix : path.join(globalPrefix, "bin");
  const globalCli = path.join(globalBin, process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
  const logPath = path.join(root, "calls.jsonl");
  const knowledgeLogPath = path.join(root, "knowledge.jsonl");
  const latestVersionFile = path.join(root, "latest.version");
  const driverPath = path.join(root, "runtime-driver.mjs");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(globalBin, { recursive: true });
  fs.writeFileSync(logPath, "");
  fs.writeFileSync(knowledgeLogPath, "");
  fs.writeFileSync(latestVersionFile, latestVersion);
  fs.writeFileSync(driverPath, runtimeDriverSource());
  writeCommand(binDir, "npm", driverPath, "npm");
  writeCommand(binDir, "node", driverPath, "node-proxy");
  const pathKey = process.platform === "win32"
    ? (Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path")
    : "PATH";
  const supportPath = process.platform === "win32"
    ? [path.win32.dirname(process.env.ComSpec ?? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`)]
    : [path.dirname(process.execPath)];
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    [pathKey]: [binDir, ...supportPath].join(path.delimiter),
    PICO_MCP_CLI_POLICY: "managed-latest",
    PICO_HOME: path.join(root, "missing-pico-home"),
    FAKE_PICO_LOG: logPath,
    FAKE_PICO_DRIVER: driverPath,
    FAKE_PICO_GLOBAL_PREFIX: globalPrefix,
    FAKE_PICO_GLOBAL_CLI: globalCli,
    FAKE_LATEST_VERSION_FILE: latestVersionFile,
    FAKE_PICO_OPERATION_MODE: operationMode,
    FAKE_KNOWLEDGE_LOG: knowledgeLogPath,
    FAKE_KNOWLEDGE_SERVER: path.resolve("test", "fixtures", "fake-knowledge-server.mjs"),
  };
  delete env.PICO_MCP_AUTOINSTALL_CLI;
  delete env.PICO_MCP_AUTOUPDATE_CLI;
  return {
    root,
    home,
    binDir,
    driverPath,
    env,
    logPath,
    knowledgeLogPath,
    latestVersionFile,
    globalCli,
    managedRoot: path.join(home, ".pico-mcp", "cli"),
    calls: () => readLog(logPath),
    knowledgeCalls: () => readLog(knowledgeLogPath),
    setLatest(version) { fs.writeFileSync(latestVersionFile, version); },
  };
}

export function createHarness({
  installedVersion = null,
  cliPresent = installedVersion !== null,
  npmMode = "success",
  latestVersion = "0.3.0",
  registryIntegrity = "sha512-fixture",
  registryMode = "success",
  canaryFailure = "",
  separateGlobalBin = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico cli auto "));
  tempRoots.push(root);
  const binDir = path.join(root, "bin");
  const templateDir = path.join(root, "template");
  const globalPrefix = path.join(root, "global-prefix");
  const cliBinDir = separateGlobalBin
    ? (process.platform === "win32" ? globalPrefix : path.join(globalPrefix, "bin"))
    : binDir;
  const statePath = path.join(root, "installed.version");
  const logPath = path.join(root, "calls.jsonl");
  const driverPath = path.join(root, "fake-command.mjs");
  fs.mkdirSync(binDir);
  fs.mkdirSync(templateDir);
  if (separateGlobalBin) fs.mkdirSync(cliBinDir, { recursive: true });
  if (installedVersion) fs.writeFileSync(statePath, installedVersion);
  fs.writeFileSync(driverPath, `
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const [role, ...args] = process.argv.slice(2);
const state = process.env.FAKE_PICO_STATE;
const log = process.env.FAKE_PICO_LOG;
const record = (extra = {}) => fs.appendFileSync(log, JSON.stringify({ role, args, sentinel: process.env.PICO_TEST_FULL_ENV ?? null, ...extra }) + "\\n");
record();
if (role === "managed-cli") {
  const [version, ...cliArgs] = args;
  if (cliArgs[0] === "-v") process.stdout.write("pico-cli/" + version + " (managed fixture)\\n");
  else if (cliArgs.at(-1) === "--help" && cliArgs.slice(0, -1).join(" ") === process.env.FAKE_CANARY_FAILURE) {
    process.stderr.write("fixture incompatible: " + cliArgs.join(" ") + "\\n");
    process.exit(7);
  }
  else if (cliArgs.at(-1) === "--help") process.stdout.write("fixture help: " + cliArgs.join(" ") + "\\n");
  else process.stdout.write("fake managed pico-cli operation complete\\n");
  process.exit(0);
}
if (role === "cli") {
  if (!fs.existsSync(state)) { process.stderr.write("pico-cli absent\\n"); process.exit(127); }
  const version = fs.readFileSync(state, "utf8").trim();
  if (args[0] === "-v") process.stdout.write("pico-cli/" + version + " (fake)\\n");
  else process.stdout.write("fake pico-cli operation complete\\n");
  process.exit(0);
}
if (args[0] === "prefix" && args[1] === "-g") {
  process.stdout.write(process.env.FAKE_PICO_PREFIX + "\\n");
  process.exit(0);
}
if (args[0] === "view") {
  const managedView = args.length === 5
    && args[1] === "@picoxr/pico-cli@latest"
    && args[2] === "version"
    && args[3] === "dist.integrity"
    && args[4] === "--json";
  if (managedView && process.env.FAKE_REGISTRY_MODE === "failure") {
    process.stderr.write("npm ERR! fixture registry unavailable\\n");
    process.exit(1);
  }
  if (managedView && process.env.FAKE_REGISTRY_MODE === "malformed") {
    process.stdout.write('{"version":');
    process.exit(0);
  }
  const response = managedView
    ? { version: process.env.FAKE_LATEST_VERSION, "dist.integrity": process.env.FAKE_REGISTRY_INTEGRITY || null }
    : process.env.FAKE_LATEST_VERSION;
  process.stdout.write(JSON.stringify(response) + "\\n");
  process.exit(0);
}
if (args[0] === "install") {
  const mode = process.env.FAKE_NPM_MODE;
  if (mode === "hang") {
    process.on("SIGTERM", () => {});
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),2500); setInterval(()=>{},1000)"], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    record({ event: "descendant", descendantPid: descendant.pid });
    descendant.unref();
    await new Promise(() => { setInterval(() => {}, 1_000); });
  }
  else if (mode === "network") { process.stderr.write("npm ERR! code ENETUNREACH network request failed\\n"); process.exit(1); }
  else if (mode === "permissions") { process.stderr.write("npm ERR! code EACCES permission denied\\n"); process.exit(1); }
  else if (mode === "registry-404") { process.stderr.write("npm ERR! code E404 404 Not Found - not in this registry\\n"); process.exit(1); }
  else if (mode === "no-cli") { process.stdout.write("npm claimed success without a CLI\\n"); process.exit(0); }
  else if (mode === "update-noop") { process.stdout.write("npm claimed update success without changing pico-cli\\n"); process.exit(0); }
  else {
    const prefixIndex = args.indexOf("--prefix");
    if (prefixIndex >= 0) {
      const prefix = args[prefixIndex + 1];
      const packageArg = args.at(-1);
      const version = packageArg.slice("@picoxr/pico-cli@".length);
      const packageVersion = mode === "mismatched-package" ? "0.4.1" : version;
      const cliVersion = mode === "mismatched-cli" ? "0.4.1" : version;
      const packageRoot = path.join(prefix, "node_modules", "@picoxr", "pico-cli");
      const shimDir = path.join(prefix, "node_modules", ".bin");
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.mkdirSync(shimDir, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@picoxr/pico-cli", version: packageVersion }));
      const shim = path.join(shimDir, process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
      if (process.platform === "win32") {
        fs.writeFileSync(shim, '@echo off\\r\\n"' + process.execPath + '" "' + process.env.FAKE_PICO_DRIVER + '" managed-cli "' + cliVersion + '" %*\\r\\n');
      } else {
        fs.writeFileSync(shim, '#!/bin/sh\\nexec "' + process.execPath + '" "' + process.env.FAKE_PICO_DRIVER + '" managed-cli "' + cliVersion + '" "$@"\\n', { mode: 0o755 });
      }
      process.stdout.write("installed exact fake managed pico-cli\\n");
      process.exit(0);
    }
    fs.copyFileSync(process.env.FAKE_PICO_CLI_TEMPLATE, process.env.FAKE_PICO_CLI_TARGET);
    if (process.platform !== "win32") fs.chmodSync(process.env.FAKE_PICO_CLI_TARGET, 0o755);
    fs.writeFileSync(state, process.env.FAKE_LATEST_VERSION);
    process.stdout.write("installed fake pico-cli\\n");
    process.exit(0);
  }
}
process.stderr.write("unexpected fake npm argv: " + JSON.stringify(args) + "\\n");
process.exit(2);
`);
  const cliTemplate = writeCommand(templateDir, "pico-cli", driverPath, "cli");
  const cliTarget = path.join(cliBinDir, process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
  if (cliPresent) {
    fs.copyFileSync(cliTemplate, cliTarget);
    if (process.platform !== "win32") fs.chmodSync(cliTarget, 0o755);
  }
  writeCommand(binDir, "npm", driverPath, "npm");
  const pathKey = process.platform === "win32" ? (Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path") : "PATH";
  const supportPath = process.platform === "win32"
    ? [path.win32.dirname(process.env.ComSpec ?? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`)]
    : [];
  process.env[pathKey] = [binDir, ...supportPath].join(path.delimiter);
  process.env.FAKE_PICO_STATE = statePath;
  process.env.FAKE_PICO_LOG = logPath;
  process.env.FAKE_PICO_BIN = binDir;
  process.env.FAKE_PICO_CLI_TEMPLATE = cliTemplate;
  process.env.FAKE_PICO_CLI_TARGET = cliTarget;
  process.env.FAKE_PICO_PREFIX = separateGlobalBin
    ? globalPrefix
    : (process.platform === "win32" ? binDir : root);
  process.env.FAKE_NPM_MODE = npmMode;
  process.env.FAKE_LATEST_VERSION = latestVersion;
  process.env.FAKE_REGISTRY_INTEGRITY = registryIntegrity;
  process.env.FAKE_REGISTRY_MODE = registryMode;
  process.env.FAKE_PICO_DRIVER = driverPath;
  process.env.FAKE_CANARY_FAILURE = canaryFailure;
  process.env.PICO_TEST_FULL_ENV = "full-env-reached-child";
  delete process.env[PICO_CLI_AUTOINSTALL_ENV];
  delete process.env[PICO_CLI_AUTOUPDATE_ENV];
  probePicoCli(true);
  fs.writeFileSync(logPath, "");
  return { root, binDir, cliBinDir, statePath, logPath, driverPath, cliTarget, calls: () => readLog(logPath) };
}

export function createManagedIO(harness, {
  env = {},
  now = Date.parse("2026-08-14T12:00:00.000Z"),
  uuidPrefix = "fixture-staging",
} = {}) {
  let uuid = 0;
  const commands = [];
  return {
    env,
    platform: process.platform,
    homeDir: path.join(harness.root, "unused-home"),
    now: () => typeof now === "function" ? now() : now,
    randomUUID: () => `${uuidPrefix}-${++uuid}`,
    commands,
    run: (command, args, options = {}) => {
      commands.push({ command, args, options });
      return runPicoCliCommand(command, args, options);
    },
  };
}

export function publishManagedFixtureVersion(harness, managedRoot, version, {
  recordVersion = version,
  packageVersion = version,
  cliVersion = version,
  recordText,
  registryIntegrity = null,
} = {}) {
  const versionRoot = path.join(managedRoot, "versions", version);
  const relativeCliPath = path.join("node_modules", ".bin", process.platform === "win32" ? "pico-cli.cmd" : "pico-cli");
  const shimPath = path.join(versionRoot, relativeCliPath);
  const packageRoot = path.join(versionRoot, "node_modules", "@picoxr", "pico-cli");
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  writeCommand(path.dirname(shimPath), "pico-cli", harness.driverPath, "managed-cli", [cliVersion]);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@picoxr/pico-cli", version: packageVersion }));
  fs.writeFileSync(path.join(versionRoot, "install.json"), recordText ?? JSON.stringify({
    schemaVersion: 1,
    version: recordVersion,
    relativeCliPath,
    registryIntegrity,
    installedAt: "2026-08-14T12:00:00.000Z",
  }));
  return { versionRoot, shimPath };
}

export function createManagedConvergenceWorker(harness, repoRoot, participants) {
  const workerPath = path.join(harness.root, "managed-worker.mjs");
  const barrierRoot = path.join(harness.root, "managed-worker-barrier");
  fs.mkdirSync(barrierRoot);
  const managedModule = pathToFileURL(path.join(repoRoot, "dist", "picoclimanaged.js")).href;
  const cliModule = pathToFileURL(path.join(repoRoot, "dist", "picocli.js")).href;
  fs.writeFileSync(workerPath, `
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveManagedPicoCli } from ${JSON.stringify(managedModule)};
import { runPicoCliCommand } from ${JSON.stringify(cliModule)};

const [managedRoot, barrierRoot, participantsText] = process.argv.slice(2);
const participants = Number(participantsText);
const claimPath = path.join(managedRoot, "versions", ".0.4.2.publish");
const contentionPath = path.join(barrierRoot, "claim-contention.jsonl");
const originalOpenSync = fs.openSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
fs.openSync = function instrumentedOpenSync(file, flags, ...rest) {
  if (String(file) !== claimPath || flags !== "wx") return originalOpenSync.call(this, file, flags, ...rest);
  let descriptor;
  try {
    descriptor = originalOpenSync.call(this, file, flags, ...rest);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fs.appendFileSync(contentionPath, JSON.stringify({ event: "claim-eexist", pid: process.pid }) + "\\n");
    }
    throw error;
  }
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(contentionPath)) {
    if (Date.now() >= deadline) {
      fs.closeSync(descriptor);
      throw new Error("winning managed claim was not observed by a loser");
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
  return descriptor;
};
let canaries = 0;
const io = {
  env: {},
  platform: process.platform,
  homeDir: path.join(managedRoot, "unused-home"),
  now: () => Date.parse("2026-08-14T12:00:00.000Z"),
  randomUUID: () => process.pid + "-" + crypto.randomUUID(),
  run: async (command, args, options = {}) => {
    const result = await runPicoCliCommand(command, args, options);
    if (args.at(-1) === "--help" && ++canaries === 9) {
      fs.writeFileSync(path.join(barrierRoot, String(process.pid)), "ready");
      const deadline = Date.now() + 15_000;
      while (fs.readdirSync(barrierRoot).length < participants) {
        if (Date.now() >= deadline) throw new Error("managed worker barrier timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return result;
  },
};

const result = await resolveManagedPicoCli({
  managedRoot,
  forceRefresh: true,
  installTimeoutMs: 5_000,
  updateCheckTimeoutMs: 5_000,
  killGraceMs: 25,
}, io);
process.stdout.write(JSON.stringify(result));
`);
  return { workerPath, barrierRoot };
}

export function launchManagedConvergenceWorker(workerPath, managedRoot, barrierRoot, participants) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, managedRoot, barrierRoot, String(participants)], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`managed worker failed code=${code} signal=${signal}: ${stderr || stdout}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`managed worker emitted invalid JSON: ${stdout}\n${stderr}`, { cause: error })); }
    });
  });
}
