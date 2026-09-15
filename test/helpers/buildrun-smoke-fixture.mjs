/**
 * The hermetic stand-ins the default smoke runs against: a fake Gradle, a fake adb, a fake npm, an
 * empty PICO tools root and an empty host home.
 *
 * Every program records what it was asked to do, because "the gate is hermetic" is a claim about
 * what was *not* reached and can only be settled by a log:
 *
 *   fixture-gradle        the fake Gradle wrapper inside the fixture project
 *   fixture-adb           a device operation, and it named `fixture-serial`
 *   fixture-adb-probe     an untargeted, device-blind probe (`adb version`) — contacts nothing
 *   fixture-adb-refused   anything else untargeted, or any other serial: refused, exit nonzero
 *   fixture-npm           an npm invocation, always refused — the server must never reach a registry
 *
 * The log paths are baked into each program at materialization time rather than read from the
 * environment, so a child that loses or rewrites its env still cannot invoke one of these silently.
 */
import fs from "node:fs";
import path from "node:path";

/** The only device identity the fixture adb will serve. Any other serial is refused. */
export const FIXTURE_SERIAL = "fixture-serial";

export function buildRunSmokeFixturePlan({ root, platform }) {
  const windows = platform === "win32";
  return {
    platform,
    executesMcpSuccessPath: !windows,
    scope: windows
      ? "wrapper-selection-only contract; no native build_and_run execution"
      : "hermetic MCP build_and_run success-path execution",
    binDir: path.join(root, "bin"),
    projectDir: path.join(root, "project"),
    adbPath: path.join(root, "bin", windows ? "adb.cmd" : "adb"),
    gradlePath: path.join(root, "project", windows ? "gradlew.bat" : "gradlew"),
    npmPath: path.join(root, "bin", windows ? "npm.cmd" : "npm"),
    // An existing-but-empty tools root: `listVersions` finds no version directory, so nothing in
    // the server can select a spatialbundle or emulator payload, whatever the host has installed.
    picoHome: path.join(root, "pico-home"),
    // A home the fixture owns, so `os.homedir()` inside the server cannot reach the developer's.
    homeDir: path.join(root, "home"),
    invocationLog: path.join(root, "fixture-invocations.jsonl"),
    npmLog: path.join(root, "fixture-npm.jsonl"),
    serial: FIXTURE_SERIAL,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function adbDriverSource({ invocationLog, scenario, pngBase64 }) {
  return `const fs = require("node:fs");
const LOG = ${JSON.stringify(invocationLog)};
const SERIAL = ${JSON.stringify(FIXTURE_SERIAL)};
const SCENARIO = ${JSON.stringify(scenario)};
const argv = process.argv.slice(2);
const targeted = argv[0] === "-s";
const serial = targeted ? argv[1] ?? null : null;
const op = targeted ? argv.slice(2) : argv;
const record = (kind) => fs.appendFileSync(LOG, JSON.stringify({ kind, serial, argv }) + "\\n");

if (!targeted) {
  // \`adb version\` prints the client's own version and contacts no device or adb server, so the
  // fixture answers it: that is what lets toolchain discovery resolve to this program instead of
  // a real adb further down PATH. Everything else untargeted (\`devices\`, \`start-server\`, ...)
  // could enumerate or touch real hardware, so it is refused rather than simulated.
  if (argv[0] === "version") {
    record("fixture-adb-probe");
    process.stdout.write("Android Debug Bridge version 0.0.0-fixture\\n");
  } else {
    record("fixture-adb-refused");
    process.stderr.write("fixture adb refuses untargeted command: " + argv.join(" ") + "\\n");
    process.exitCode = 1;
  }
} else if (serial !== SERIAL) {
  record("fixture-adb-refused");
  process.stderr.write("fixture adb serves only " + SERIAL + ", not " + String(serial) + "\\n");
  process.exitCode = 1;
} else {
  record("fixture-adb");
  if (op.includes("install")) process.stdout.write("Success\\n");
  else if (op.includes("monkey")) {
    if (SCENARIO === "launch-failure") { process.stderr.write("device offline\\n"); process.exitCode = 1; }
    else process.stdout.write("Events injected: 1\\n");
  } else if (op.includes("pidof")) {
    if (SCENARIO !== "dead-process") process.stdout.write("4242\\n");
    else process.exitCode = 1;
  } else if (op.includes("--pid") && op.includes("logcat")) {
    process.stdout.write("I SpatialView: RenderEntity create texture success\\n");
  } else if (op.includes("exec-out") && op.includes("screencap")) {
    process.stdout.write(Buffer.from(${JSON.stringify(pngBase64)}, "base64"));
  }
}
`;
}

function gradleDriverSource({ invocationLog }) {
  return `const fs = require("node:fs"), p = require("node:path");
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ kind: "fixture-gradle", serial: null, argv: process.argv.slice(2) }) + "\\n");
const dir = p.join(process.cwd(), "app", "build", "outputs", "apk", "debug"), out = p.join(dir, "app-debug.apk");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(out, "fixture apk");
fs.writeFileSync(p.join(dir, "output-metadata.json"), JSON.stringify({ variantName: "debug", applicationId: "com.example.contractfixture", elements: [{ outputFile: "app-debug.apk" }] }));
process.stdout.write("BUILD SUCCESSFUL\\n");
`;
}

function npmDriverSource({ npmLog }) {
  return `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify({ kind: "fixture-npm", serial: null, argv: process.argv.slice(2) }) + "\\n");
process.stderr.write("fixture npm refuses every invocation: this lane makes no registry request\\n");
process.exit(66);
`;
}

export function materializeBuildRunSmokeFixture({
  root,
  pngBase64,
  platform = process.platform,
  execPath = process.execPath,
  scenario = "success",
}) {
  const plan = buildRunSmokeFixturePlan({ root, platform });
  for (const dir of [plan.binDir, plan.projectDir, plan.picoHome, plan.homeDir]) fs.mkdirSync(dir, { recursive: true });

  const adbDriver = path.join(plan.binDir, "fake-adb.cjs");
  const gradleDriver = path.join(plan.projectDir, "fake-gradle.cjs");
  const npmDriver = path.join(plan.binDir, "fake-npm.cjs");
  fs.writeFileSync(adbDriver, adbDriverSource({ invocationLog: plan.invocationLog, scenario, pngBase64 }));
  fs.writeFileSync(gradleDriver, gradleDriverSource({ invocationLog: plan.invocationLog }));
  fs.writeFileSync(npmDriver, npmDriverSource({ npmLog: plan.npmLog }));

  const launchers = [[plan.adbPath, adbDriver], [plan.gradlePath, gradleDriver], [plan.npmPath, npmDriver]];
  for (const [launcher, driver] of launchers) {
    if (platform === "win32") {
      fs.writeFileSync(launcher, `@echo off\r\n"${execPath}" "${driver}" %*\r\n`);
    } else {
      fs.writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(execPath)} ${shellQuote(driver)} "$@"\n`, { mode: 0o755 });
      fs.chmodSync(launcher, 0o755);
    }
  }
  return { ...plan, adbDriver, gradleDriver, npmDriver };
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * What the fixture programs were actually asked to do.
 *
 * `calls` is the set of operations that acted on something — a device or a build — so asserting
 * every one of them named `fixture-serial` or was the fixture Gradle is the isolation claim.
 * `probes` and `refused` are kept apart because neither reaches a device: a probe answers a
 * version query, a refusal exits nonzero having done nothing.
 */
export function readBuildRunSmokeFixtureLog(plan) {
  const entries = readLog(plan.invocationLog);
  return {
    entries,
    calls: entries.filter((entry) => entry.kind === "fixture-adb" || entry.kind === "fixture-gradle"),
    probes: entries.filter((entry) => entry.kind === "fixture-adb-probe"),
    refused: entries.filter((entry) => entry.kind === "fixture-adb-refused"),
    npmCalls: readLog(plan.npmLog),
  };
}

/**
 * The environment a server spawned against this fixture gets. Built explicitly rather than spread
 * from `process.env`, so a developer's `PICO_HOME`, CLI policy, `JAVA_HOME` or SDK on PATH cannot
 * change what the gate measures. (`StdioClientTransport` still merges its own small allowlist —
 * HOME, LOGNAME, PATH, SHELL, TERM, USER on POSIX — underneath these, which is why HOME and PATH
 * are set here rather than left out.)
 *
 * PATH keeps only the fixture bin and the stable system directories the server's own child
 * processes need (`which`, `df`); the fixture bin comes first, so every lookup of adb or npm
 * resolves to a stand-in. It deliberately does not contain Node's own directory: nothing the smoke
 * exercises spawns a bare `node`, and a future change that does should fail loudly here rather than
 * pick up whatever else lives beside the host's Node.
 */
export function buildRunSmokeFixtureEnv(plan, extra = {}) {
  const systemPath = plan.platform === "win32"
    ? (process.env.PATH ?? process.env.Path ?? "")
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
  return {
    PATH: [plan.binDir, systemPath].filter(Boolean).join(path.delimiter),
    HOME: plan.homeDir,
    USERPROFILE: plan.homeDir,
    PICO_HOME: plan.picoHome,
    PICO_MCP_SURFACE: "full",
    // The least capable policy there is: CLI-backed operations are off, so no registry lookup, no
    // provisioning and no managed-cache write can happen behind a pure tool call. Nothing the
    // default smoke checks needs a CLI, so nothing weaker is warranted.
    PICO_MCP_CLI_POLICY: "disabled",
    ...(plan.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
    ...extra,
  };
}
