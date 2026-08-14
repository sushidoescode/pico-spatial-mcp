import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  "FAKE_PICO_DRIVER",
  "FAKE_CANARY_FAILURE",
];

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

export function createHarness({
  installedVersion = null,
  cliPresent = installedVersion !== null,
  npmMode = "success",
  latestVersion = "0.3.0",
  registryIntegrity = "sha512-fixture",
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
  process.env.FAKE_PICO_DRIVER = driverPath;
  process.env.FAKE_CANARY_FAILURE = canaryFailure;
  process.env.PICO_TEST_FULL_ENV = "full-env-reached-child";
  delete process.env[PICO_CLI_AUTOINSTALL_ENV];
  delete process.env[PICO_CLI_AUTOUPDATE_ENV];
  probePicoCli(true);
  fs.writeFileSync(logPath, "");
  return { root, binDir, cliBinDir, statePath, logPath, cliTarget, calls: () => readLog(logPath) };
}

export function createManagedIO(harness, {
  env = {},
  now = Date.parse("2026-08-14T12:00:00.000Z"),
} = {}) {
  let uuid = 0;
  const commands = [];
  return {
    env,
    platform: process.platform,
    homeDir: path.join(harness.root, "unused-home"),
    now: () => now,
    randomUUID: () => `fixture-staging-${++uuid}`,
    commands,
    run: (command, args, options = {}) => {
      commands.push({ command, args, options });
      return runPicoCliCommand(command, args, options);
    },
  };
}
