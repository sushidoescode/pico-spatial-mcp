import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";

import { inputIdentity, verifyBuild } from "../scripts/build-identity.mjs";
import {
  assertOwnedScratch,
  buildSource,
  handleInterrupt,
  publishStaging,
  runCompiler,
  sweepStaleScratch,
  withSourceSetup,
} from "../scripts/build-source.mjs";

const LOCK_NAME = ".pico-source-setup.lock";
const fixtures = [];

test.after(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSource(root, relativePath, contents) {
  const target = path.join(root, "src", ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function writeInstalledTypeScript(root, version) {
  const dir = path.join(root, "node_modules", "typescript");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "typescript", version })}\n`);
}

/** A throwaway checkout with the same shape the real build reads: config, lockfile and sources. */
function createCheckout({ sources = { "index.ts": "export const value = 1;\n" } } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pico-buildfresh-")));
  fixtures.push(root);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" })}\n`);
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3 })}\n`);
  fs.writeFileSync(path.join(root, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "src" }, include: ["src/**/*.ts"] })}\n`);
  for (const [relativePath, contents] of Object.entries(sources)) writeSource(root, relativePath, contents);
  return root;
}

function listSources(dir, prefix = "") {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listSources(path.join(dir, entry.name), relativePath));
    else if (entry.name.endsWith(".ts")) found.push(relativePath);
  }
  return found;
}

/** Stand-in compiler that really emits one file per source, so removals and tampering are real. */
function transpiler({ onCompile } = {}) {
  return async ({ root, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    for (const relativePath of listSources(path.join(root, "src"))) {
      const target = path.join(outDir, ...relativePath.replace(/\.ts$/, ".js").split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fs.readFileSync(path.join(root, "src", ...relativePath.split("/"))));
    }
    if (onCompile) await onCompile();
  };
}

function fakeClock() {
  let elapsed = 0;
  return { now: () => elapsed, wait: async (ms) => { elapsed += ms; }, get elapsed() { return elapsed; } };
}

function fakeChild(code) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, null);
  });
  return child;
}

function assertNoAbsolutePaths(value, where) {
  if (typeof value === "string") {
    assert.equal(path.isAbsolute(value), false, `${where} leaks an absolute path: ${value}`);
    assert.equal(/^[A-Za-z]:[\\/]/.test(value), false, `${where} leaks a drive path: ${value}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoAbsolutePaths(item, `${where}[${index}]`)); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoAbsolutePaths(item, `${where}.${key}`);
  }
}

test("source edits change the input identity and invalidate the receipt", async () => {
  const root = createCheckout();
  await buildSource({ root, runCompiler: transpiler() });
  assert.equal(verifyBuild(root).current, true);

  const before = inputIdentity(root).sha256;
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const value = 2;\n");
  assert.notEqual(inputIdentity(root).sha256, before);
  assert.equal(verifyBuild(root).current, false);
});

test("the input identity is a sorted, deterministic digest over sources, config, lockfile and toolchain", () => {
  const root = createCheckout({
    sources: { "index.ts": "export const a = 1;\n", "b/two.ts": "export const b = 2;\n", "a/one.ts": "export const c = 3;\n" },
  });
  const identity = inputIdentity(root);
  assert.equal(identity.schemaVersion, 1);
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);

  const paths = identity.files.map((file) => file.path);
  assert.deepEqual(paths, [...paths].sort());
  for (const expected of ["package-lock.json", "package.json", "src/a/one.ts", "src/b/two.ts", "src/index.ts", "tsconfig.json", "toolchain:node-major", "toolchain:typescript"]) {
    assert.ok(paths.includes(expected), `input identity is missing ${expected}`);
  }
  for (const file of identity.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);

  assert.deepEqual(inputIdentity(root), identity);
  const material = identity.files.map(({ path: filePath, sha256 }) => `${filePath}\0${sha256}\n`).join("");
  assert.equal(crypto.createHash("sha256").update(material).digest("hex"), identity.sha256);
});

test("a successful build publishes dist with a portable receipt and no leftover scratch", async () => {
  const root = createCheckout({ sources: { "index.ts": "export const value = 1;\n", "lib/helper.ts": "export const helper = 2;\n" } });
  await buildSource({ root, runCompiler: transpiler() });

  const raw = fs.readFileSync(path.join(root, "dist", "build-receipt.json"), "utf8");
  const receipt = JSON.parse(raw);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.input.sha256, inputIdentity(root).sha256);
  assert.deepEqual(receipt.input.files, inputIdentity(root).files);
  assert.deepEqual(receipt.output.files.map((file) => file.path), ["index.js", "lib/helper.js"]);
  assert.match(receipt.output.sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.nodeMajor, Number(process.versions.node.split(".")[0]));

  assertNoAbsolutePaths(receipt, "receipt");
  assert.equal(raw.includes(os.homedir()), false, "receipt leaks the home directory");
  assert.equal(raw.includes(root), false, "receipt leaks the checkout path");
  assert.doesNotMatch(raw, /\d{4}-\d{2}-\d{2}T\d{2}:/, "receipt carries a timestamp");

  assert.equal(verifyBuild(root).current, true);
  assert.deepEqual(verifyBuild(root).reasons, []);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".dist-") || name === LOCK_NAME), []);
});

test("removing a source removes its emitted module on the next successful build", async () => {
  const root = createCheckout({ sources: { "index.ts": "export const value = 1;\n", "extra.ts": "export const extra = 1;\n" } });
  await buildSource({ root, runCompiler: transpiler() });
  assert.equal(fs.existsSync(path.join(root, "dist", "extra.js")), true);

  fs.rmSync(path.join(root, "src", "extra.ts"));
  await buildSource({ root, runCompiler: transpiler() });
  assert.equal(fs.existsSync(path.join(root, "dist", "extra.js")), false);
  assert.equal(verifyBuild(root).current, true);
});

test("lockfile and tsconfig edits invalidate the receipt", async () => {
  const lockEdited = createCheckout();
  await buildSource({ root: lockEdited, runCompiler: transpiler() });
  fs.writeFileSync(path.join(lockEdited, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} })}\n`);
  const afterLock = verifyBuild(lockEdited);
  assert.equal(afterLock.current, false);
  assert.ok(afterLock.reasons.some((reason) => /input/i.test(reason)), afterLock.reasons.join("; "));

  const configEdited = createCheckout();
  await buildSource({ root: configEdited, runCompiler: transpiler() });
  fs.writeFileSync(path.join(configEdited, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "src", strict: true }, include: ["src/**/*.ts"] })}\n`);
  assert.equal(verifyBuild(configEdited).current, false);
});

test("the installed TypeScript version participates in the identity", async () => {
  const root = createCheckout();
  await buildSource({ root, runCompiler: transpiler() });
  const readReceipt = () => JSON.parse(fs.readFileSync(path.join(root, "dist", "build-receipt.json"), "utf8"));
  assert.equal(readReceipt().typescript, null);

  const before = inputIdentity(root).sha256;
  writeInstalledTypeScript(root, "9.9.9");
  assert.notEqual(inputIdentity(root).sha256, before);
  assert.equal(verifyBuild(root).current, false);

  await buildSource({ root, runCompiler: transpiler() });
  assert.equal(readReceipt().typescript, "9.9.9");
  assert.equal(verifyBuild(root).current, true);
});

test("a failed compilation preserves the previously published output", async () => {
  const root = createCheckout();
  await buildSource({ root, runCompiler: transpiler() });
  const oldEntry = path.join(root, "dist", "index.js");
  const oldBytes = fs.readFileSync(oldEntry);

  writeSource(root, "index.ts", "export const value = 2;\n");
  await assert.rejects(buildSource({ root, runCompiler: async () => { throw Error("compile failed"); } }), /compile failed/);
  assert.deepEqual(fs.readFileSync(oldEntry), oldBytes);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".dist-") || name === LOCK_NAME), []);
  assert.equal(verifyBuild(root).current, false);
});

test("a source change during compilation is rejected and the old output survives", async () => {
  const root = createCheckout();
  await buildSource({ root, runCompiler: transpiler() });
  const oldBytes = fs.readFileSync(path.join(root, "dist", "index.js"));

  await assert.rejects(
    buildSource({ root, runCompiler: transpiler({ onCompile: () => writeSource(root, "index.ts", "export const value = 3;\n") }) }),
    /changed during/i,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, "dist", "index.js")), oldBytes);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".dist-") || name === LOCK_NAME), []);
});

test("tampered, missing and orphaned output invalidates the receipt", async () => {
  const tampered = createCheckout();
  await buildSource({ root: tampered, runCompiler: transpiler() });
  fs.appendFileSync(path.join(tampered, "dist", "index.js"), "// tampered\n");
  const tamperedResult = verifyBuild(tampered);
  assert.equal(tamperedResult.current, false);
  assert.ok(tamperedResult.reasons.some((reason) => reason.includes("index.js")), tamperedResult.reasons.join("; "));

  const removed = createCheckout();
  await buildSource({ root: removed, runCompiler: transpiler() });
  fs.rmSync(path.join(removed, "dist", "index.js"));
  const removedResult = verifyBuild(removed);
  assert.equal(removedResult.current, false);
  assert.ok(removedResult.reasons.some((reason) => reason.includes("index.js")), removedResult.reasons.join("; "));

  const orphaned = createCheckout();
  await buildSource({ root: orphaned, runCompiler: transpiler() });
  fs.writeFileSync(path.join(orphaned, "dist", "orphan.js"), "export const orphan = 1;\n");
  const orphanResult = verifyBuild(orphaned);
  assert.equal(orphanResult.current, false);
  assert.ok(orphanResult.reasons.some((reason) => reason.includes("orphan.js")), orphanResult.reasons.join("; "));
});

test("a missing, unparsable or half-published build is never current", async () => {
  const root = createCheckout();
  const neverBuilt = verifyBuild(root);
  assert.equal(neverBuilt.current, false);
  assert.ok(neverBuilt.reasons.length > 0);

  await buildSource({ root, runCompiler: transpiler() });
  const receiptPath = path.join(root, "dist", "build-receipt.json");
  fs.rmSync(receiptPath);
  assert.equal(verifyBuild(root).current, false);

  fs.writeFileSync(receiptPath, "{ not json");
  const unparsable = verifyBuild(root);
  assert.equal(unparsable.current, false);
  assert.ok(unparsable.reasons.length > 0);

  fs.writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 2, input: {}, output: {} })}\n`);
  assert.equal(verifyBuild(root).current, false);

  // A receipt may only name files inside the tree it describes.
  const escaping = { schemaVersion: 1, input: inputIdentity(root), output: { sha256: "0".repeat(64), files: [{ path: "../../etc/hosts", sha256: "0".repeat(64) }] } };
  fs.writeFileSync(receiptPath, `${JSON.stringify(escaping)}\n`);
  const traversal = verifyBuild(root);
  assert.equal(traversal.current, false);
  assert.ok(traversal.reasons.some((reason) => /malformed output entry/.test(reason)), traversal.reasons.join("; "));

  fs.rmSync(path.join(root, "dist"), { recursive: true });
  assert.equal(verifyBuild(root).current, false);
});

test("an independent writer waits for the lock, then fails without stealing it", async () => {
  const root = createCheckout();
  const lockPath = path.join(root, LOCK_NAME);

  await withSourceSetup({ root }, async () => {
    const held = fs.readFileSync(lockPath, "utf8");
    const record = JSON.parse(held);
    assert.equal(record.pid, process.pid);
    assert.match(record.token, /^[a-f0-9]{32}$/);

    const clock = fakeClock();
    await assert.rejects(
      withSourceSetup({ root, waitMs: 30_000, clock }, async () => { throw new Error("the second writer must not run"); }),
      /\.pico-source-setup\.lock/,
    );
    assert.ok(clock.elapsed >= 30_000, `waited only ${clock.elapsed}ms`);
    assert.equal(fs.readFileSync(lockPath, "utf8"), held, "the waiting writer stole the lock");
  });

  assert.equal(fs.existsSync(lockPath), false);
});

test("a waiting writer proceeds once the holder releases the lock", async () => {
  const root = createCheckout();
  const lockPath = path.join(root, LOCK_NAME);
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid + 1, token: "f".repeat(32) })}\n`, { flag: "wx" });

  let ticks = 0;
  const clock = {
    now: () => ticks * 100,
    wait: async () => { ticks += 1; if (ticks === 3) fs.rmSync(lockPath); },
  };

  let ran = false;
  await withSourceSetup({ root, waitMs: 30_000, clock }, async () => { ran = true; });
  assert.equal(ran, true);
  assert.ok(ticks >= 3, `the writer did not wait: ${ticks} poll(s)`);
  assert.equal(fs.existsSync(lockPath), false);
});

test("only the exact active lease for the same root is reused", async () => {
  const rootA = createCheckout();
  const rootB = createCheckout();
  const lockA = path.join(rootA, LOCK_NAME);

  let retired;
  await withSourceSetup({ root: rootB }, async (lease) => { retired = lease; });

  let captured;
  await withSourceSetup({ root: rootA }, async (lease) => {
    captured = lease;
    let nested = false;
    await withSourceSetup({ root: rootA, owner: lease }, async (inner) => {
      nested = true;
      assert.equal(inner, lease);
    });
    assert.equal(nested, true);
    assert.equal(fs.existsSync(lockA), true, "a nested call released the outer lock");

    await assert.rejects(withSourceSetup({ root: rootA, owner: "a-token" }, async () => {}), /owner/i);
    await assert.rejects(withSourceSetup({ root: rootA, owner: {} }, async () => {}), /owner/i);
    await assert.rejects(withSourceSetup({ root: rootA, owner: retired }, async () => {}), /owner/i);
    await withSourceSetup({ root: rootB }, async (activeElsewhere) => {
      await assert.rejects(withSourceSetup({ root: rootA, owner: activeElsewhere }, async () => {}), /owner/i);
    });
  });

  await assert.rejects(withSourceSetup({ root: rootA, owner: captured }, async () => {}), /owner/i);
  assert.equal(fs.existsSync(lockA), false);
});

test("buildSource reuses a caller-held lease instead of deadlocking on itself", async () => {
  const root = createCheckout();
  const lockPath = path.join(root, LOCK_NAME);
  await withSourceSetup({ root }, async (lease) => {
    await buildSource({ root, owner: lease, runCompiler: transpiler() });
    assert.equal(fs.existsSync(lockPath), true);
  });
  assert.equal(verifyBuild(root).current, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("the production compiler runs the checkout's TypeScript through this node binary", async () => {
  const root = createCheckout();
  const tscEntry = path.join(root, "node_modules", "typescript", "bin", "tsc");
  fs.mkdirSync(path.dirname(tscEntry), { recursive: true });
  fs.writeFileSync(tscEntry, "// fixture tsc\n");
  const outDir = path.join(root, ".dist-staging-fixture");

  const calls = [];
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return fakeChild(0); };
  await runCompiler({ root, outDir, spawn });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [tscEntry, "-p", path.join(root, "tsconfig.json"), "--outDir", outDir]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, root);

  await assert.rejects(runCompiler({ root, outDir, spawn: () => fakeChild(2) }), /2/);

  const bare = createCheckout();
  await assert.rejects(runCompiler({ root: bare, outDir: path.join(bare, ".dist-staging-fixture"), spawn }), /typescript/i);
});

test("a failed publication restores the previous dist and keeps no backup behind", async () => {
  const root = createCheckout();
  await buildSource({ root, runCompiler: transpiler() });
  const published = fs.readdirSync(path.join(root, "dist")).sort();
  const oldBytes = fs.readFileSync(path.join(root, "dist", "index.js"));

  // A staging tree that vanished between compilation and publication: dist must come back intact.
  assert.throws(() => publishStaging(root, path.join(root, ".dist-staging-gone")), /ENOENT/);
  assert.deepEqual(fs.readdirSync(path.join(root, "dist")).sort(), published);
  assert.deepEqual(fs.readFileSync(path.join(root, "dist", "index.js")), oldBytes);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".dist-backup-")), []);
  assert.equal(verifyBuild(root).current, true);
});

test("every destructive step refuses paths the build does not own", async () => {
  const root = createCheckout();
  const outside = createCheckout();

  assertOwnedScratch(root, path.join(root, ".dist-staging-abc123"), ".dist-staging-");
  for (const [target, prefix] of [
    [path.join(outside, ".dist-staging-abc123"), ".dist-staging-"],
    [path.join(root, "src"), ".dist-staging-"],
    [path.join(root, "dist"), ".dist-backup-"],
    [path.join(root, ".dist-staging-"), ".dist-staging-"],
    [path.join(root, "nested", ".dist-staging-abc123"), ".dist-staging-"],
    [root, ".dist-staging-"],
  ]) {
    assert.throws(() => assertOwnedScratch(root, target, prefix), /is not a .* path owned by/, target);
  }

  // A staging tree belonging to another checkout must not be publishable into this one.
  const foreign = path.join(outside, ".dist-staging-foreign");
  fs.mkdirSync(foreign, { recursive: true });
  assert.throws(() => publishStaging(root, foreign), /is not a .* path owned by/);
  assert.equal(fs.existsSync(foreign), true, "a foreign staging tree was consumed");
  assert.equal(fs.existsSync(path.join(root, "dist")), false);
});

test("holding the lock sweeps scratch an interrupted build left, and nothing else", async () => {
  const root = createCheckout();
  const outside = createCheckout();

  const stale = path.join(root, ".dist-staging-interrupted");
  const staleBackup = path.join(root, ".dist-backup-interrupted");
  for (const dir of [stale, staleBackup]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), "half-written output\n");
  }
  // Look-alikes that are not scratch: a bare prefix, a file, and a real source directory.
  const barePrefix = path.join(root, ".dist-staging-");
  fs.mkdirSync(barePrefix, { recursive: true });
  fs.writeFileSync(path.join(root, ".dist-staging-notadir"), "a file, not a staging tree\n");
  // A staging tree belonging to a different checkout must not be a candidate at all.
  const foreign = path.join(outside, ".dist-staging-foreign");
  fs.mkdirSync(foreign, { recursive: true });

  const swept = sweepStaleScratch(root).sort();
  assert.deepEqual(swept, [".dist-backup-interrupted", ".dist-staging-interrupted"]);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(staleBackup), false);
  assert.equal(fs.existsSync(barePrefix), true, "a bare prefix is not a scratch name");
  assert.equal(fs.existsSync(path.join(root, ".dist-staging-notadir")), true, "a file is not a staging tree");
  assert.equal(fs.existsSync(foreign), true, "the sweep escaped the root it was given");
  assert.equal(fs.existsSync(path.join(root, "src", "index.ts")), true);

  fs.rmSync(barePrefix, { recursive: true });
  fs.rmSync(path.join(root, ".dist-staging-notadir"));
});

test("the next build recovers scratch an interrupted build left behind", async () => {
  const root = createCheckout();
  const abandoned = path.join(root, ".dist-staging-abandoned");
  fs.mkdirSync(abandoned, { recursive: true });
  fs.writeFileSync(path.join(abandoned, "index.js"), "half-written output\n");

  await buildSource({ root, runCompiler: transpiler() });
  assert.equal(fs.existsSync(abandoned), false, "the interrupted build's staging tree survived");
  assert.equal(verifyBuild(root).current, true);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".dist-")), []);
});

test("an interrupt releases this build's lock and staging, then re-raises the signal", async () => {
  const root = createCheckout();
  await buildSource({ root, runCompiler: transpiler() });
  const publishedBytes = fs.readFileSync(path.join(root, "dist", "index.js"));

  const raised = [];
  let staging;
  let afterHandler;
  await assert.rejects(
    buildSource({
      root,
      runCompiler: async ({ outDir }) => {
        staging = outDir;
        fs.writeFileSync(path.join(outDir, "index.js"), "half-written output\n");
        assert.equal(fs.existsSync(path.join(root, LOCK_NAME)), true);
        // Stand in for Ctrl-C: the handler is the only cleanup a killed build ever gets.
        handleInterrupt("SIGINT", { raise: (signal) => raised.push(signal) });
        // Read the disk HERE. A real signal never reaches the `finally` below, so anything the
        // handler did not clean up is what would actually be left in the checkout.
        afterHandler = {
          staging: fs.existsSync(outDir),
          lock: fs.existsSync(path.join(root, LOCK_NAME)),
        };
        throw new Error("interrupted");
      },
    }),
    /interrupted/,
  );

  assert.deepEqual(raised, ["SIGINT"], "the signal was swallowed instead of re-raised");
  assert.equal(afterHandler.staging, false, "a Ctrl-C would leave the staging tree behind");
  assert.equal(afterHandler.lock, false, "a Ctrl-C would leave the lock behind");
  assert.deepEqual(fs.readFileSync(path.join(root, "dist", "index.js")), publishedBytes);
  assert.equal(verifyBuild(root).current, true);
  assert.equal(fs.existsSync(staging), false);
});

test("an interrupt never releases a lock that is no longer this build's", async () => {
  const root = createCheckout();
  const lockPath = path.join(root, LOCK_NAME);
  const foreign = `${JSON.stringify({ pid: process.pid + 1, token: "f".repeat(32) })}\n`;

  let afterHandler;
  await assert.rejects(
    buildSource({
      root,
      runCompiler: async ({ outDir }) => {
        // Our lock has been taken over: the handler may clean our staging, never this record.
        fs.writeFileSync(lockPath, foreign);
        handleInterrupt("SIGTERM", { raise: () => {} });
        afterHandler = { lock: fs.readFileSync(lockPath, "utf8"), staging: fs.existsSync(outDir) };
        throw new Error("interrupted");
      },
    }),
    /interrupted/,
  );

  assert.equal(afterHandler.lock, foreign, "the handler released a lock it does not own");
  assert.equal(afterHandler.staging, false, "a Ctrl-C would leave the staging tree behind");
  assert.equal(fs.readFileSync(lockPath, "utf8"), foreign, "the exit path released a lock it does not own");
  fs.rmSync(lockPath);
});

test("a lock whose holder has exited is reported as dead, with a recovery command, not stolen", async () => {
  const root = createCheckout();
  const lockPath = path.join(root, LOCK_NAME);
  const exited = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(exited.status, 0);
  const deadPid = exited.pid;
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: deadPid, token: "d".repeat(32) })}\n`, { flag: "wx" });

  const clock = fakeClock();
  await assert.rejects(
    withSourceSetup({ root, waitMs: 30_000, clock }, async () => { throw new Error("must not run"); }),
    (error) => {
      assert.match(error.message, new RegExp(`pid ${deadPid}, which is no longer running`));
      assert.match(error.message, new RegExp(`Remove the stale lock: (rm|del) `));
      assert.ok(error.message.includes(lockPath));
      return true;
    },
  );
  assert.equal(fs.existsSync(lockPath), true, "a dead pid is not a licence to steal the lock");

  // The live-holder wording stays distinct, and still never steals.
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "l".repeat(32) })}\n`);
  await assert.rejects(
    withSourceSetup({ root, waitMs: 30_000, clock: fakeClock() }, async () => {}),
    (error) => {
      assert.doesNotMatch(error.message, /no longer running/);
      assert.match(error.message, /remove the lock only if that process is gone/);
      return true;
    },
  );
  assert.equal(fs.existsSync(lockPath), true);
  fs.rmSync(lockPath);
});

test("two concurrent builds under one lease are serialized, and neither sweeps the other", async () => {
  const root = createCheckout();
  const events = [];
  let releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  let aStaging;
  let bStaging;
  let aStagingAfterYield;
  let bSawAStaging;

  await withSourceSetup({ root }, async (lease) => {
    const a = buildSource({
      root,
      owner: lease,
      runCompiler: async ({ outDir }) => {
        aStaging = outDir;
        events.push("A:start");
        // Yield while still owning outDir. An unserialized sibling would run its sweep right here.
        await barrier;
        aStagingAfterYield = fs.existsSync(outDir);
        fs.writeFileSync(path.join(outDir, "index.js"), "export const built = \"A\";\n");
        events.push("A:end");
      },
    });
    const b = buildSource({
      root,
      owner: lease,
      runCompiler: async ({ outDir }) => {
        bStaging = outDir;
        bSawAStaging = fs.existsSync(aStaging);
        events.push("B:start");
        fs.writeFileSync(path.join(outDir, "index.js"), "export const built = \"B\";\n");
        events.push("B:end");
      },
    });
    releaseBarrier();
    await Promise.all([a, b]);
  });

  assert.equal(aStagingAfterYield, true, "a sibling build's sweep deleted this build's staging");
  assert.deepEqual(events, ["A:start", "A:end", "B:start", "B:end"], "the two builds interleaved");
  assert.notEqual(aStaging, bStaging);
  assert.equal(bSawAStaging, false, "A's staging outlived A's own publication");

  assert.equal(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8"), "export const built = \"B\";\n");
  assert.equal(verifyBuild(root).current, true);
  assert.deepEqual(verifyBuild(root).reasons, []);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".dist-") || name === LOCK_NAME), []);
});

test("the sweep spares staging an active build is using", async () => {
  const root = createCheckout();
  const stale = path.join(root, ".dist-staging-stale");
  let liveStaging;
  let swept;
  let liveSurvived;

  await buildSource({
    root,
    runCompiler: async ({ outDir }) => {
      liveStaging = outDir;
      fs.writeFileSync(path.join(outDir, "index.js"), "export const value = 1;\n");
      // A genuinely stale sibling appears next to a staging tree that is in use right now.
      fs.mkdirSync(stale, { recursive: true });
      fs.writeFileSync(path.join(stale, "index.js"), "half-written output\n");
      swept = sweepStaleScratch(root);
      liveSurvived = fs.existsSync(outDir);
    },
  });

  assert.equal(liveSurvived, true, "the sweep deleted staging an active build was using");
  assert.deepEqual(swept, [".dist-staging-stale"]);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(verifyBuild(root).current, true);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".dist-")), []);
});

test("an interrupt aborts the compiler before it removes the staging tree", async () => {
  const root = createCheckout();
  let observed;

  await assert.rejects(
    buildSource({
      root,
      runCompiler: async ({ outDir, signal }) => {
        assert.equal(signal.aborted, false, "the compiler was handed an already-aborted signal");
        fs.writeFileSync(path.join(outDir, "index.js"), "half-written output\n");
        // Deleting the tree before the compiler is told to stop is the bug this guards: record
        // what the disk looked like at the moment the abort landed.
        let stagingAtAbort = null;
        signal.addEventListener("abort", () => { stagingAtAbort = fs.existsSync(outDir); });

        handleInterrupt("SIGINT", { raise: () => {} });

        observed = { stagingAtAbort, aborted: signal.aborted, stagingAfter: fs.existsSync(outDir) };
        throw new Error("interrupted");
      },
    }),
    /interrupted/,
  );

  assert.equal(observed.aborted, true, "the compiler was never told to stop");
  assert.equal(observed.stagingAtAbort, true, "the staging tree was removed before the compiler was aborted");
  assert.equal(observed.stagingAfter, false, "the staging tree was left behind");
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".dist-") || name === LOCK_NAME), []);
});

test("an interrupt stops the production compiler's child process", async (t) => {
  const root = createCheckout();
  const pidPath = path.join(root, "compiler.pid");
  // Stands in for tsc: announces its pid, then keeps writing into outDir for far longer than the
  // test lives. If the handler does not stop it, it re-creates the staging tree it was deleted.
  const sleeper = path.join(root, "sleeper.mjs");
  fs.writeFileSync(sleeper, [
    'import fs from "node:fs";',
    'const outDir = process.argv[process.argv.indexOf("--outDir") + 1];',
    'fs.mkdirSync(outDir, { recursive: true });',
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    'setInterval(() => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(`${outDir}/index.js`, "late\\n"); }, 20);',
  ].join("\n"));

  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === "EPERM"; }
  };

  const build = buildSource({ root, runCompiler: (options) => runCompiler({ ...options, tscEntry: sleeper }) });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(pidPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(pidPath), true, "the stand-in compiler never started");
  const compilerPid = Number(fs.readFileSync(pidPath, "utf8"));
  assert.ok(compilerPid > 0);
  // If the behaviour under test regresses, this child outlives the run and keeps the test runner
  // alive forever. A hang is a far worse failure report than an assertion, so reap it regardless —
  // but only while it is still ours to reap. Once the poll below has watched this pid die, the
  // number is free for the OS to hand to someone else, and signalling it would hit a stranger.
  let compilerReaped = false;
  t.after(() => { if (!compilerReaped) { try { process.kill(compilerPid, "SIGKILL"); } catch {} } });

  handleInterrupt("SIGTERM", { raise: () => {} });
  // Bounded on purpose. If the compiler is never stopped it never exits, so this promise never
  // settles — and an un-awaitable build must be reported as a failed assertion, not as a runner
  // that hangs until CI times out.
  let bound;
  const outcome = await Promise.race([
    build.then(() => "the build resolved despite being interrupted", (error) => `rejected: ${error.message}`),
    new Promise((resolve) => { bound = setTimeout(() => resolve("the build never settled after the interrupt"), 10_000); }),
  ]);
  // The losing arm keeps the runner alive for its full 10s otherwise: a suite that passes must exit.
  clearTimeout(bound);
  assert.match(outcome, /^rejected: .*interrupted/, outcome);

  // SIGKILL stops it from executing instantly, but the pid lingers as a zombie until libuv reaps
  // it, so poll for the entry to disappear rather than assuming the reap has already happened.
  const reaped = Date.now() + 3_000;
  while (alive(compilerPid) && Date.now() < reaped) await new Promise((resolve) => setTimeout(resolve, 10));
  const stillAlive = alive(compilerPid);
  compilerReaped = !stillAlive;
  assert.equal(stillAlive, false, `compiler pid ${compilerPid} outlived the interrupt`);

  // The stand-in rewrites its outDir every 20ms, so a quarter second of silence means it is gone.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".dist-")), []);
  assert.equal(fs.existsSync(path.join(root, LOCK_NAME)), false);
});
