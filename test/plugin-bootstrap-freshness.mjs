/**
 * plugin-bootstrap-freshness — a host plugin cache must rebuild when its source moved, and must
 * cost nothing at all when it did not.
 *
 * The bootstrap used to decide setup from two existence checks (`node_modules/`, `dist/index.js`),
 * so a cache whose source or lockfile changed under it served stale output forever across host
 * restarts. These tests drive the identity-based decision instead: read the dependency and build
 * receipts, and only when something is genuinely stale take the setup lease, re-read both under it,
 * and run exactly the actions still needed.
 *
 * Nothing here runs a real `npm`, a real registry request or the real TypeScript compiler. Fixtures
 * are real checkouts on disk with real lockfiles, receipts, locks and emitted files, under hostile
 * space/Unicode paths; npm, the compiler and the server are stand-ins the test drives with barriers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEPENDENCY_RECEIPT_NAME,
  dependencyIdentity,
  nodeMajor,
  verifyBuild,
  verifyDependencies,
  verifyEmittedOutput,
  writeDependencyReceipt,
  writeReceipt,
} from "../scripts/build-identity.mjs";
import { isSourceCheckout, runBootstrap, sourceSetupPlan } from "../scripts/plugin-bootstrap.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_NAME = ".pico-source-setup.lock";
const INSTALL_ARGS = ["ci", "--no-audit", "--no-fund"];
const fixtures = [];
const timings = [];

test.after(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (timings.length) process.stderr.write(`bootstrap timings: ${timings.join(", ")}\n`);
});

// ---------------------------------------------------------------- fixtures

/** A source checkout shaped like a host plugin cache, under a space/Unicode path on purpose. */
function createCheckout({
  source = "export const value = 1;\n",
  lock = { name: "fixture", lockfileVersion: 3 },
  dirName = "plugin cache ü 漢字",
} = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pico-bootfresh-")));
  fixtures.push(parent);
  const root = path.join(parent, dirName);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" })}\n`);
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);
  fs.writeFileSync(path.join(root, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "src" }, include: ["src/**/*.ts"] })}\n`);
  fs.writeFileSync(path.join(root, "src", "index.ts"), source);
  return root;
}

/** What a successful `npm ci` leaves behind: node_modules, with the compiler entry the build wants. */
function installDependenciesInto(root, { typescriptVersion = "5.6.2" } = {}) {
  const tsDir = path.join(root, "node_modules", "typescript");
  fs.mkdirSync(path.join(tsDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(tsDir, "package.json"), `${JSON.stringify({ name: "typescript", version: typescriptVersion })}\n`);
  fs.writeFileSync(path.join(tsDir, "bin", "tsc"), "// stand-in for the real compiler entry\n");
}

/** One emitted `.js` per top-level source: removals, orphans and tampering are then real files. */
function transpile(root, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(path.join(root, "src"))) {
    if (!name.endsWith(".ts")) continue;
    fs.writeFileSync(path.join(outDir, name.replace(/\.ts$/u, ".js")), fs.readFileSync(path.join(root, "src", name)));
  }
}

/** Bring a checkout to exactly the state a successful cold bootstrap leaves behind. */
function publishCurrentBuild(root) {
  const distDir = path.join(root, "dist");
  fs.rmSync(distDir, { recursive: true, force: true });
  transpile(root, distDir);
  writeReceipt(root, distDir);
}

function recordCurrentInstall(root) {
  writeDependencyReceipt(root, { npmArgv: INSTALL_ARGS });
}

/** A warm cache: dependencies installed and recorded, output published and current. */
function createWarmCheckout(options) {
  const root = createCheckout(options);
  installDependenciesInto(root);
  recordCurrentInstall(root);
  publishCurrentBuild(root);
  assert.equal(verifyDependencies(root).current, true, "fixture should start with current dependencies");
  assert.equal(verifyBuild(root).current, true, "fixture should start with a current build");
  return root;
}

/** An installed tarball: dist/ and scripts/, no src/, no tsconfig, no lockfile. */
function createInstalledPackage() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pico-bootfresh-pkg-")));
  fixtures.push(parent);
  const source = createCheckout({ dirName: "build here" });
  publishCurrentBuild(source);

  const root = path.join(parent, "node_modules", "pico spatial mcp ü");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.cpSync(path.join(source, "dist"), path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "pico-spatial-mcp", version: "0.0.0", type: "module" })}\n`);
  for (const script of ["plugin-bootstrap.mjs", "build-identity.mjs", "build-source.mjs"]) {
    fs.copyFileSync(path.join(repoRoot, "scripts", script), path.join(root, "scripts", script));
  }
  assert.equal(isSourceCheckout(root), false, "an installed package must never look like a source checkout");
  return root;
}

// ---------------------------------------------------------------- stand-ins

function classifyLaunch(command, args) {
  const first = args[0] ?? "";
  if (first.endsWith(`${path.sep}dist${path.sep}index.js`)) return "launch";
  if (path.basename(first) === "tsc") return "compile";
  return "install";
}

/**
 * A stand-in for `child_process.spawn` that records every launch and hands each one to a
 * test-owned handler, so the test decides when — and whether — a child closes.
 */
function recordingSpawn({ log = [], onInstall, onCompile, onLaunch } = {}) {
  const launches = [];
  let nextPid = 20_000;
  const spawnImpl = (command, args, options) => {
    const kind = classifyLaunch(command, args);
    const launch = { kind, command, args, options };
    launches.push(launch);

    const child = new EventEmitter();
    child.pid = ++nextPid;
    child.exitCode = null;
    child.signalCode = null;
    let closed = false;
    const close = (code = 0, signal = null) => {
      if (closed) return;
      closed = true;
      child.exitCode = code;
      child.signalCode = signal;
      log.push(`${kind}:end`);
      child.emit("close", code, signal);
    };
    child.kill = (signal) => { close(null, signal); return true; };

    log.push(`${kind}:start`);
    const handler = { install: onInstall, compile: onCompile, launch: onLaunch }[kind];
    Promise.resolve()
      .then(() => handler?.({ launch, command, args, options }))
      .then((code) => close(code ?? 0, null), (error) => { closed = true; child.emit("error", error); });
    return child;
  };
  return { spawnImpl, launches, log };
}

/** An injected compiler that really emits, logs its span, and can be parked or made to fail. */
function recordingCompiler({ log = [], before, fail } = {}) {
  const calls = [];
  const runCompilerImpl = async ({ root, outDir, signal }) => {
    calls.push({ root, outDir, signal });
    log.push("compile:start");
    try {
      if (before) await before({ root, outDir });
      if (fail) throw new Error(fail);
      transpile(root, outDir);
    } finally {
      log.push("compile:end");
    }
  };
  return { runCompilerImpl, calls, log };
}

/** A promise the test resolves by hand: no sleeps, no races against wall-clock time. */
function barrier() {
  let release;
  const reached = new Promise((resolve) => { release = resolve; });
  return { reached, release };
}

/**
 * Bound every wait on a barrier. If the behaviour under test regresses so that the barrier is never
 * reached — an install that stops running, a compiler that is never called — an unbounded await
 * hangs the whole runner until CI times out, which is a far worse failure report than an assertion.
 */
function reach(promise, what, timeoutMs = 10_000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`nothing ever reached ${what}`)), timeoutMs); }),
  ]);
}

function gate() {
  const arrived = barrier();
  const proceed = barrier();
  return {
    arrived: arrived.reached,
    proceed: proceed.release,
    async wait() { arrived.release(); await proceed.reached; },
  };
}

function fakeClock() {
  let elapsed = 0;
  return { now: () => elapsed, wait: async (ms) => { elapsed += ms; }, get elapsed() { return elapsed; } };
}

const kinds = (launches) => launches.map((launch) => launch.kind);

function scratchLeft(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith(".dist-") || name === LOCK_NAME);
}

// ---------------------------------------------------------------- the plan

test("the setup plan is decided by dependency and build freshness, not by directory existence", () => {
  assert.deepEqual(sourceSetupPlan({ dependenciesCurrent: true, buildCurrent: false }), [["run", "build"]]);
  assert.deepEqual(sourceSetupPlan({ dependenciesCurrent: false, buildCurrent: false }),
    [["ci", "--no-audit", "--no-fund"], ["run", "build"]]);

  assert.deepEqual(sourceSetupPlan({ dependenciesCurrent: true, buildCurrent: true }), []);
  assert.deepEqual(sourceSetupPlan({ dependenciesCurrent: false, buildCurrent: true }), [["ci", "--no-audit", "--no-fund"]]);

  // The plan is a fresh value every call: a caller mutating one must not rewrite the next.
  const first = sourceSetupPlan({ dependenciesCurrent: false, buildCurrent: false });
  first[0].push("--registry=http://evil.example");
  assert.deepEqual(sourceSetupPlan({ dependenciesCurrent: false, buildCurrent: false }),
    [["ci", "--no-audit", "--no-fund"], ["run", "build"]]);
});

test("a source checkout is recognised by its sources and tsconfig, and an installed payload is not", () => {
  const root = createCheckout();
  assert.equal(isSourceCheckout(root), true);
  assert.equal(isSourceCheckout(repoRoot), true);

  fs.rmSync(path.join(root, "tsconfig.json"));
  assert.equal(isSourceCheckout(root), false, "no tsconfig means nothing here can be compiled");

  const noSources = createCheckout();
  fs.rmSync(path.join(noSources, "src"), { recursive: true });
  assert.equal(isSourceCheckout(noSources), false);

  assert.equal(isSourceCheckout(createInstalledPackage()), false);
});

// ---------------------------------------------------------------- identities

test("the dependency identity is a digest over the lockfile bytes and this Node major", () => {
  const root = createCheckout();
  const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const expected = sha256([
    `package-lock.json\0${sha256(fs.readFileSync(path.join(root, "package-lock.json")))}\n`,
    `toolchain:node-major\0${sha256(String(nodeMajor()))}\n`,
  ].join(""));

  assert.equal(dependencyIdentity(root), expected, "the schema must stay the documented one");
  assert.equal(dependencyIdentity(root), dependencyIdentity(root), "the identity must be stable");

  const before = dependencyIdentity(root);
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3, extra: 1 })}\n`);
  assert.notEqual(dependencyIdentity(root), before, "a lockfile edit must move the identity");

  // Source and tsconfig belong to the build identity, never to the install identity.
  const afterLock = dependencyIdentity(root);
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const value = 2;\n");
  assert.equal(dependencyIdentity(root), afterLock, "a source edit must not look like a dependency change");

  const noLock = createCheckout();
  fs.rmSync(path.join(noLock, "package-lock.json"));
  assert.equal(dependencyIdentity(noLock), null, "with no lockfile there is nothing to be current against");
});

test("an install is only current when its receipt accounts for the lockfile on disk", () => {
  const root = createCheckout();
  const receiptPath = path.join(root, DEPENDENCY_RECEIPT_NAME);

  assert.equal(verifyDependencies(root).current, false, "no node_modules at all");
  assert.match(verifyDependencies(root).reasons.join(" "), /node_modules/);

  installDependenciesInto(root);
  assert.equal(verifyDependencies(root).current, false, "node_modules with no receipt is an unknown install");
  assert.match(verifyDependencies(root).reasons.join(" "), /unreadable|cannot be accounted/);

  const written = recordCurrentInstall(root) ?? JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(written.schemaVersion, 1);
  assert.equal(written.dependencyIdentity, dependencyIdentity(root));
  assert.deepEqual(written.npmArgv, INSTALL_ARGS);
  assert.equal(verifyDependencies(root).current, true);

  fs.writeFileSync(receiptPath, "{not json");
  assert.equal(verifyDependencies(root).current, false);
  assert.match(verifyDependencies(root).reasons.join(" "), /unparsable/);

  fs.writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 99, dependencyIdentity: dependencyIdentity(root), npmArgv: INSTALL_ARGS })}\n`);
  assert.equal(verifyDependencies(root).current, false);
  assert.match(verifyDependencies(root).reasons.join(" "), /schemaVersion/);

  fs.writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, dependencyIdentity: dependencyIdentity(root) })}\n`);
  assert.equal(verifyDependencies(root).current, false, "a receipt that does not say what produced it is not trustworthy");

  recordCurrentInstall(root);
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3, bumped: true })}\n`);
  assert.equal(verifyDependencies(root).current, false);
  assert.match(verifyDependencies(root).reasons.join(" "), /package-lock\.json changed/);

  // A receipt that survives the tree it describes is still unknown.
  recordCurrentInstall(root);
  fs.rmSync(path.join(root, "node_modules"), { recursive: true });
  assert.equal(verifyDependencies(root).current, false);
});

test("a packaged payload is verified from its receipt without any source", () => {
  const root = createInstalledPackage();
  assert.equal(fs.existsSync(path.join(root, "src")), false);
  assert.equal(fs.existsSync(path.join(root, "package-lock.json")), false);

  assert.deepEqual(verifyEmittedOutput(root), { current: true, reasons: [] });
  // The source-checkout predicate cannot prove this and must not be what gates a tarball consumer.
  assert.equal(verifyBuild(root).current, false);

  const entry = path.join(root, "dist", "index.js");
  const original = fs.readFileSync(entry);
  fs.writeFileSync(entry, "console.log('tampered')\n");
  assert.equal(verifyEmittedOutput(root).current, false);
  assert.match(verifyEmittedOutput(root).reasons.join(" "), /does not match the bytes/);
  fs.writeFileSync(entry, original);
  assert.equal(verifyEmittedOutput(root).current, true);

  fs.writeFileSync(path.join(root, "dist", "orphan.js"), "// nothing emitted this\n");
  assert.match(verifyEmittedOutput(root).reasons.join(" "), /orphan/);
  fs.rmSync(path.join(root, "dist", "orphan.js"));

  fs.rmSync(entry);
  assert.match(verifyEmittedOutput(root).reasons.join(" "), /is missing but the receipt lists it/);

  const noReceipt = createInstalledPackage();
  fs.rmSync(path.join(noReceipt, "dist", "build-receipt.json"));
  assert.equal(verifyEmittedOutput(noReceipt).current, false);
});

// ---------------------------------------------------------------- warm start

test("an unchanged cache starts the server with no npm, no compiler and no setup lock", async () => {
  const root = createWarmCheckout();
  const { spawnImpl, launches, log } = recordingSpawn();
  const compiler = recordingCompiler({ log });

  const started = process.hrtime.bigint();
  const result = await runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl });
  timings.push(`warm ${Number(process.hrtime.bigint() - started) / 1e6}ms`);

  assert.deepEqual(result, { code: 0, signal: null, forwardedSignal: undefined });
  assert.deepEqual(kinds(launches), ["launch"], "a warm start runs nothing but the server");
  assert.deepEqual(launches[0].args, [path.join(root, "dist", "index.js")]);
  assert.equal(compiler.calls.length, 0);
  assert.deepEqual(scratchLeft(root), [], "an unchanged start must not even take the setup lease");
});

// ---------------------------------------------------------------- stale caches

test("a deleted dist is rebuilt without reinstalling dependencies", async () => {
  const root = createWarmCheckout();
  fs.rmSync(path.join(root, "dist"), { recursive: true });

  const log = [];
  const { spawnImpl, launches } = recordingSpawn({ log });
  const compiler = recordingCompiler({ log });
  await runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl });

  assert.deepEqual(kinds(launches), ["launch"]);
  assert.equal(compiler.calls.length, 1);
  assert.equal(verifyBuild(root).current, true);
  assert.deepEqual(log, ["compile:start", "compile:end", "launch:start", "launch:end"]);
  assert.deepEqual(scratchLeft(root), []);
});

test("a source edit rebuilds before the server starts", async () => {
  const root = createWarmCheckout();
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const value = 2;\n");
  assert.equal(verifyBuild(root).current, false);

  const log = [];
  const { spawnImpl, launches } = recordingSpawn({ log });
  const compiler = recordingCompiler({ log });
  await runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl });

  assert.deepEqual(kinds(launches), ["launch"], "a source edit is not a dependency change");
  assert.equal(compiler.calls.length, 1);
  assert.equal(verifyBuild(root).current, true);
  assert.equal(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8"), "export const value = 2;\n");
  assert.deepEqual(log.slice(0, 2), ["compile:start", "compile:end"]);
  assert.equal(log.indexOf("launch:start") > log.indexOf("compile:end"), true, "the server must not start before the rebuild");
});

test("a lockfile edit reinstalls, rebuilds and records the new dependency identity", async () => {
  const root = createWarmCheckout();
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3, bumped: true })}\n`);
  const expected = dependencyIdentity(root);

  const log = [];
  const { spawnImpl, launches } = recordingSpawn({
    log,
    onInstall: ({ options }) => { installDependenciesInto(options.cwd, { typescriptVersion: "5.7.0" }); },
  });
  const compiler = recordingCompiler({ log });
  await runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl });

  assert.deepEqual(kinds(launches), ["install", "launch"]);
  assert.deepEqual(launches[0].args, INSTALL_ARGS);
  assert.deepEqual(launches[0].options.stdio, ["ignore", 2, 2], "npm chatter belongs on stderr; stdout carries protocol frames");
  assert.equal(launches[0].options.cwd, root);
  assert.equal(compiler.calls.length, 1);
  assert.deepEqual(log, ["install:start", "install:end", "compile:start", "compile:end", "launch:start", "launch:end"]);

  const receipt = JSON.parse(fs.readFileSync(path.join(root, DEPENDENCY_RECEIPT_NAME), "utf8"));
  assert.equal(receipt.dependencyIdentity, expected);
  assert.deepEqual(receipt.npmArgv, INSTALL_ARGS);
  assert.equal(verifyDependencies(root).current, true);
  assert.equal(verifyBuild(root).current, true);
  assert.deepEqual(scratchLeft(root), []);
});

test("a cache with no trustworthy dependency receipt installs once", async () => {
  const root = createWarmCheckout();
  fs.rmSync(path.join(root, DEPENDENCY_RECEIPT_NAME));

  const log = [];
  const { spawnImpl, launches } = recordingSpawn({ log, onInstall: ({ options }) => installDependenciesInto(options.cwd) });
  const compiler = recordingCompiler({ log });
  await runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl });

  assert.deepEqual(kinds(launches), ["install", "launch"], "unknown dependencies are never declared current");
  assert.equal(compiler.calls.length, 0, "an install that leaves the build identity untouched must not force a rebuild");
  assert.equal(verifyDependencies(root).current, true);
});

test("restoring a deleted node_modules does not recompile output the install makes current again", async () => {
  const root = createWarmCheckout();
  // The installed TypeScript version is part of the build identity, so losing node_modules makes a
  // perfectly good dist/ read as stale. Reinstalling is what it was actually waiting for.
  fs.rmSync(path.join(root, "node_modules"), { recursive: true });
  assert.equal(verifyDependencies(root).current, false);
  assert.equal(verifyBuild(root).current, false, "the missing compiler should invalidate the build identity");

  const log = [];
  const { spawnImpl, launches } = recordingSpawn({ log, onInstall: ({ options }) => installDependenciesInto(options.cwd) });
  const compiler = recordingCompiler({ log });
  await runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl });

  assert.deepEqual(kinds(launches), ["install", "launch"]);
  assert.equal(compiler.calls.length, 0, "the install restored the build identity; recompiling would be busywork");
  assert.equal(verifyBuild(root).current, true);
  assert.equal(verifyDependencies(root).current, true);
  assert.deepEqual(scratchLeft(root), []);
});

test("the install and the build it feeds share one setup lease", async () => {
  const root = createCheckout();
  const tokens = [];
  const readLock = () => JSON.parse(fs.readFileSync(path.join(root, LOCK_NAME), "utf8"));

  const { spawnImpl } = recordingSpawn({
    onInstall: ({ options }) => { tokens.push(readLock().token); installDependenciesInto(options.cwd); },
  });
  const compiler = recordingCompiler({ before: () => { tokens.push(readLock().token); } });
  await runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl });

  assert.equal(tokens.length, 2, "both the install and the build should have run under a lease");
  assert.equal(tokens[0], tokens[1], "the build must reuse the installation's lease, never take a second one");
  assert.equal(fs.existsSync(path.join(root, LOCK_NAME)), false, "the lease must be released");
});

test("the planned build runs the checkout's own TypeScript through this node binary with an explicit outDir", async () => {
  const root = createWarmCheckout();
  fs.rmSync(path.join(root, "dist"), { recursive: true });

  // No injected compiler: this exercises the default wiring all the way to the spawn.
  const { spawnImpl, launches } = recordingSpawn({
    onCompile: ({ args, options }) => {
      transpile(options.cwd, args[args.indexOf("--outDir") + 1]);
    },
  });
  await runBootstrap({ root, spawnImpl });

  const compile = launches.find((launch) => launch.kind === "compile");
  assert.ok(compile, "the build should have spawned a compiler");
  assert.equal(compile.command, process.execPath);
  assert.equal(compile.args[0], path.join(root, "node_modules", "typescript", "bin", "tsc"));
  assert.deepEqual(compile.args.slice(1, 4), ["-p", path.join(root, "tsconfig.json"), "--outDir"]);
  assert.equal(path.dirname(compile.args[4]), root);
  assert.match(path.basename(compile.args[4]), /^\.dist-staging-[0-9a-f]+$/u);
  assert.equal(compile.options.cwd, root);
  assert.equal(compile.options.shell, false);
  assert.equal(verifyBuild(root).current, true);
  assert.deepEqual(scratchLeft(root), []);
});

// ---------------------------------------------------------------- failures

test("a failed install ends bootstrap and never compiles or launches", async () => {
  const root = createCheckout();
  const log = [];
  const { spawnImpl, launches } = recordingSpawn({ log, onInstall: () => 23 });
  const compiler = recordingCompiler({ log });

  await assert.rejects(
    runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl }),
    /failed with exit code 23/,
  );

  assert.deepEqual(kinds(launches), ["install"], "no server may start behind a failed prerequisite");
  assert.equal(compiler.calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, DEPENDENCY_RECEIPT_NAME)), false, "a failed install must record nothing");
  assert.deepEqual(scratchLeft(root), []);
});

test("a failed compilation ends bootstrap, keeps the previous output and never launches", async () => {
  const root = createWarmCheckout();
  const published = fs.readFileSync(path.join(root, "dist", "index.js"), "utf8");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const value = 3;\n");

  const { spawnImpl, launches } = recordingSpawn();
  const compiler = recordingCompiler({ fail: "TS1005: ';' expected" });

  await assert.rejects(
    runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl }),
    /TS1005/,
  );

  assert.deepEqual(kinds(launches), [], "stale output must never be served");
  assert.equal(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8"), published);
  assert.deepEqual(scratchLeft(root), []);
});

test("a lockfile that changes during installation is rejected instead of recorded", async () => {
  const root = createCheckout();
  const { spawnImpl, launches } = recordingSpawn({
    onInstall: ({ options }) => {
      installDependenciesInto(options.cwd);
      fs.writeFileSync(path.join(options.cwd, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3, raced: true })}\n`);
    },
  });
  const compiler = recordingCompiler();

  await assert.rejects(
    runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl }),
    /package-lock\.json changed while/,
  );

  assert.deepEqual(kinds(launches), ["install"]);
  assert.equal(compiler.calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, DEPENDENCY_RECEIPT_NAME)), false,
    "recording success against a lockfile nobody installed would be worse than reinstalling");
  assert.deepEqual(scratchLeft(root), []);
});

// ---------------------------------------------------------------- packaged

test("an installed package with an intact payload launches without npm or a compiler", async () => {
  const root = createInstalledPackage();
  const { spawnImpl, launches } = recordingSpawn();
  const compiler = recordingCompiler();

  const result = await runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl });

  assert.equal(result.code, 0);
  assert.deepEqual(kinds(launches), ["launch"], "a tarball consumer has no source to rebuild and no lockfile to install");
  assert.equal(compiler.calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, LOCK_NAME)), false, "an installed package must not be written into");
  assert.equal(fs.existsSync(path.join(root, DEPENDENCY_RECEIPT_NAME)), false);
});

test("an installed package whose payload was tampered with refuses to launch and asks for a reinstall", async () => {
  const root = createInstalledPackage();
  fs.writeFileSync(path.join(root, "dist", "index.js"), "console.log('not what shipped')\n");

  const { spawnImpl, launches } = recordingSpawn();
  const compiler = recordingCompiler();

  await assert.rejects(
    runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl }),
    (error) => {
      assert.match(error.message, /does not match the build receipt/);
      assert.match(error.message, /[Rr]einstall/);
      assert.doesNotMatch(error.message, /npm ci|tsc|TypeScript/, "a tarball consumer must never be told to compile");
      return true;
    },
  );

  assert.deepEqual(kinds(launches), []);
  assert.equal(compiler.calls.length, 0);
});

// ---------------------------------------------------------------- concurrency

async function concurrentBootstraps(root, { onInstall } = {}) {
  const log = [];
  const installGate = gate();
  const compileGate = gate();
  const receipts = [];

  const make = () => {
    const { spawnImpl, launches } = recordingSpawn({
      log,
      onInstall: async ({ options }) => {
        await installGate.wait();
        installDependenciesInto(options.cwd);
        onInstall?.(options.cwd);
      },
      onLaunch: () => { receipts.push(fs.readFileSync(path.join(root, "dist", "build-receipt.json"), "utf8")); },
    });
    const compiler = recordingCompiler({ log, before: () => compileGate.wait() });
    return { launches, compiler, run: runBootstrap({ root, spawnImpl, runCompilerImpl: compiler.runCompilerImpl }) };
  };

  const first = make();
  const second = make();

  await reach(installGate.arrived, "the install");
  installGate.proceed();
  await reach(compileGate.arrived, "the compiler");
  compileGate.proceed();

  await reach(Promise.all([first.run, second.run]), "both bootstraps finishing");
  return { log, receipts, first, second };
}

function assertSerialSetup(log) {
  const setup = log.filter((entry) => entry.startsWith("install") || entry.startsWith("compile"));
  assert.equal(setup.filter((entry) => entry === "install:start").length, 1, `exactly one install: ${setup.join(" ")}`);
  assert.equal(setup.filter((entry) => entry === "compile:start").length, 1, `exactly one build: ${setup.join(" ")}`);
  for (let index = 0; index < setup.length; index += 2) {
    assert.equal(setup[index + 1], `${setup[index].split(":")[0]}:end`,
      `an install and a compile overlapped: ${setup.join(" ")}`);
  }
}

test("two cold bootstraps against one cache install once, build once, and never overlap", async () => {
  const root = createCheckout();
  const { log, receipts, first, second } = await concurrentBootstraps(root);

  assertSerialSetup(log);
  assert.equal(first.compiler.calls.length + second.compiler.calls.length, 1);
  assert.deepEqual(kinds(first.launches).filter((kind) => kind === "launch"), ["launch"]);
  assert.deepEqual(kinds(second.launches).filter((kind) => kind === "launch"), ["launch"]);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0], receipts[1], "both callers must observe the same published output");
  assert.equal(verifyBuild(root).current, true);
  assert.equal(verifyDependencies(root).current, true);
  assert.deepEqual(scratchLeft(root), []);
});

test("two changed-lock bootstraps against one cache reinstall once and rebuild once", async () => {
  const root = createWarmCheckout();
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3, bumped: true })}\n`);
  const expected = dependencyIdentity(root);

  const { log, receipts } = await concurrentBootstraps(root, {
    onInstall: (cwd) => installDependenciesInto(cwd, { typescriptVersion: "5.7.0" }),
  });

  assertSerialSetup(log);
  assert.equal(receipts[0], receipts[1]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, DEPENDENCY_RECEIPT_NAME), "utf8")).dependencyIdentity, expected);
  assert.equal(verifyBuild(root).current, true);
  assert.deepEqual(scratchLeft(root), []);
});

test("a waiter that times out on the setup lease launches nothing", async () => {
  const root = createCheckout();
  const installGate = gate();
  const holder = recordingSpawn({
    onInstall: async ({ options }) => { await installGate.wait(); installDependenciesInto(options.cwd); },
  });
  const holderCompiler = recordingCompiler();
  const held = runBootstrap({ root, spawnImpl: holder.spawnImpl, runCompilerImpl: holderCompiler.runCompilerImpl });
  await reach(installGate.arrived, "the holder's install");

  const waiter = recordingSpawn();
  const waiterCompiler = recordingCompiler();
  const clock = fakeClock();
  await assert.rejects(
    runBootstrap({ root, spawnImpl: waiter.spawnImpl, runCompilerImpl: waiterCompiler.runCompilerImpl, setupWaitMs: 30_000, clock }),
    /another build is holding .*waited 30000ms/s,
  );

  assert.deepEqual(kinds(waiter.launches), [], "a waiter that gave up must not start a server on someone else's half-built cache");
  assert.equal(waiterCompiler.calls.length, 0);
  assert.equal(clock.elapsed >= 30_000, true, "the full deadline must be honoured — against the injected clock, not the wall");
  assert.equal(fs.existsSync(path.join(root, LOCK_NAME)), true, "a waiter must never steal the lock it timed out on");

  installGate.proceed();
  await reach(held, "the holder finishing");
  assert.equal(verifyBuild(root).current, true);
  assert.deepEqual(scratchLeft(root), []);
});

// ---------------------------------------------------------------- end to end

test("a real cold bootstrap compiles, keeps npm and compiler chatter off stdout, then starts warm", () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pico-bootfresh-e2e-")));
  fixtures.push(tempRoot);
  const pluginRoot = path.join(tempRoot, "source plugin ü 漢字");
  const hostileCwd = path.join(tempRoot, "unrelated caller cwd");
  const fakeBin = path.join(tempRoot, "fake bin");
  const npmLog = path.join(tempRoot, "npm.jsonl");
  const tscLog = path.join(tempRoot, "tsc.jsonl");
  const childLog = path.join(tempRoot, "child.json");

  fs.mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "src"), { recursive: true });
  fs.mkdirSync(hostileCwd, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const script of ["plugin-bootstrap.mjs", "build-identity.mjs", "build-source.mjs"]) {
    fs.copyFileSync(path.join(repoRoot, "scripts", script), path.join(pluginRoot, "scripts", script));
  }
  fs.writeFileSync(path.join(pluginRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" })}\n`);
  fs.writeFileSync(path.join(pluginRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3 })}\n`);
  fs.writeFileSync(path.join(pluginRoot, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "src" }, include: ["src/**/*.ts"] })}\n`);
  fs.writeFileSync(path.join(pluginRoot, "src", "index.ts"), `import fs from "node:fs";
fs.writeFileSync(process.env.FAKE_CHILD_LOG, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), execPath: process.execPath }));
process.stdout.write("MCP_STDOUT\\n");
process.stderr.write("MCP_STDERR\\n");
process.exit(Number(process.env.FAKE_CHILD_EXIT ?? 0));
`);

  // A fake npm that really provisions a stand-in compiler, so the in-process build is real work.
  const standInCompiler = `const fs = require("node:fs");
const path = require("node:path");
const outDir = process.argv[process.argv.indexOf("--outDir") + 1];
fs.mkdirSync(outDir, { recursive: true });
for (const name of fs.readdirSync(path.join(process.cwd(), "src"))) {
  if (!name.endsWith(".ts")) continue;
  fs.writeFileSync(path.join(outDir, name.replace(/\\.ts$/, ".js")), fs.readFileSync(path.join(process.cwd(), "src", name)));
}
fs.appendFileSync(process.env.FAKE_TSC_LOG, JSON.stringify(outDir) + "\\n");
process.stdout.write("TSC_STDOUT\\n");
`;
  const fakeNpm = path.join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm");
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("NPM_STDOUT\\n");
process.stderr.write("NPM_STDERR\\n");
if (process.argv[2] === "ci") {
  const bin = path.join(process.cwd(), "node_modules", "typescript", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "..", "package.json"), JSON.stringify({ name: "typescript", version: "5.6.2" }));
  fs.writeFileSync(path.join(bin, "tsc"), ${JSON.stringify(standInCompiler)});
}
`, { mode: 0o755 });
  fs.chmodSync(fakeNpm, 0o755);

  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_NPM_LOG: npmLog,
    FAKE_TSC_LOG: tscLog,
    FAKE_CHILD_LOG: childLog,
    FAKE_CHILD_EXIT: "7",
  };
  const bootstrap = path.join(pluginRoot, "scripts", "plugin-bootstrap.mjs");
  const run = (overrides = {}) => {
    const started = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [bootstrap], { cwd: hostileCwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 60_000 });
    return { ...result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  };
  const logLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);

  const cold = run();
  timings.push(`e2e cold ${cold.ms.toFixed(0)}ms`);
  assert.equal(cold.status, 7, cold.stderr);
  assert.equal(cold.stdout, "MCP_STDOUT\n", "only the server may write to stdout");
  for (const marker of ["NPM_STDOUT", "NPM_STDERR", "TSC_STDOUT", "MCP_STDERR"]) {
    assert.match(cold.stderr, new RegExp(marker), `${marker} belongs on stderr`);
  }
  assert.deepEqual(logLines(npmLog).map(JSON.parse), [INSTALL_ARGS]);
  assert.equal(logLines(tscLog).length, 1, "the cold build should compile exactly once");
  assert.equal(verifyBuild(pluginRoot).current, true);
  assert.equal(verifyDependencies(pluginRoot).current, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(childLog, "utf8")), {
    argv: [path.join(pluginRoot, "dist", "index.js")],
    cwd: pluginRoot,
    execPath: process.execPath,
  });
  assert.deepEqual(scratchLeft(pluginRoot), []);

  fs.writeFileSync(npmLog, "");
  const warm = run({ FAKE_CHILD_EXIT: "0" });
  timings.push(`e2e warm ${warm.ms.toFixed(0)}ms`);
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(fs.readFileSync(npmLog, "utf8"), "", "an unchanged cache must not run npm");
  assert.equal(logLines(tscLog).length, 1, "an unchanged cache must not run the compiler");
  assert.doesNotMatch(warm.stderr, /NPM_|TSC_/);

  fs.writeFileSync(path.join(pluginRoot, "src", "index.ts"), `${fs.readFileSync(path.join(pluginRoot, "src", "index.ts"), "utf8")}// edited\n`);
  const edited = run({ FAKE_CHILD_EXIT: "0" });
  timings.push(`e2e source-edit ${edited.ms.toFixed(0)}ms`);
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(fs.readFileSync(npmLog, "utf8"), "", "a source edit is not a dependency change");
  assert.equal(logLines(tscLog).length, 2, "a source edit must rebuild");
  assert.match(fs.readFileSync(path.join(pluginRoot, "dist", "index.js"), "utf8"), /\/\/ edited/);
  assert.equal(verifyBuild(pluginRoot).current, true);
  assert.deepEqual(scratchLeft(pluginRoot), []);
});
