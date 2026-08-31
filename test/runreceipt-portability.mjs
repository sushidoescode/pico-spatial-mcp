import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditIdOf,
  parsePortableRunReceipt,
  parsePromotionManifest,
  parseReceiptSelector,
  parseRunReceiptBinding,
  portableReceiptIdOf,
  promotionIdOf,
} from "../dist/runreceiptportable.js";
import * as portable from "../dist/runreceiptportable.js";
import { canonicalJson } from "../dist/runreceiptidentity.js";
import * as store from "../dist/runreceiptstore.js";
import { validateCaptureBuffer } from "../dist/evidence.js";
import { createRunReceiptFixture } from "./helpers/runreceipt-fixture.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function promotionRoots(fixture, suffix = "target") {
  const targetReceiptRoot = path.join(fixture.scratch, `${suffix}-receipt-store`);
  const targetLedgerRoot = path.join(fixture.scratch, `${suffix}-ledger-store`);
  fs.mkdirSync(targetReceiptRoot);
  fs.mkdirSync(targetLedgerRoot);
  return {
    targetReceiptRoot: fs.realpathSync(targetReceiptRoot),
    targetLedgerRoot: fs.realpathSync(targetLedgerRoot),
  };
}

async function createPortableFixture(t, options = {}) {
  const owned = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pico-portability-roots-"));
  t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
  return createRunReceiptFixture(t, store, {
    ...options,
    rootDir: path.join(owned, "receipt-store"),
    ledgerDir: path.join(owned, "ledger-store"),
  });
}

function promotionInput(fixture, published, target) {
  return {
    app: fixture.payload.app,
    sourceReceiptId: published.receiptId,
    sourceReceiptRoot: fs.realpathSync(fixture.rootDir),
    sourceLedgerRoot: fs.realpathSync(fixture.ledgerDir),
    ...target,
  };
}

function promotedPaths(fixture, published, promoted, target) {
  return {
    apk: path.join(target.targetReceiptRoot, "artifacts", "apk", `${fixture.payload.apk.sha256}.apk`),
    effectiveAppSpec: path.join(target.targetReceiptRoot, "artifacts", "spec", `${fixture.payload.source.effectiveAppSpec.sha256}.json`),
    capture: path.join(target.targetLedgerRoot, "artifacts", `${fixture.payload.capture.sha256}.png`),
    lineage: path.join(target.targetReceiptRoot, "portable-lineage-v1", fixture.payload.app, `${published.receiptId}.json`),
    portable: path.join(target.targetReceiptRoot, "portable-v1", fixture.payload.app, `${promoted.portableReceiptId}.json`),
    manifest: path.join(target.targetReceiptRoot, "promotions-v1", fixture.payload.app, `${promoted.promotionId}.json`),
  };
}

function hashFiles(paths) {
  return Object.fromEntries(Object.entries(paths).map(([name, file]) => [name, sha256Bytes(fs.readFileSync(file))]));
}

function temporaryNames(root) {
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.name.includes(".tmp-")) found.push(candidate);
      if (entry.isDirectory()) visit(candidate);
    }
  };
  visit(root);
  return found;
}

function directoryMetadata(directory) {
  const stats = fs.statSync(directory, { bigint: true });
  return {
    deviceId: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function directoryTreeMetadata(root) {
  const records = {};
  const visit = (directory, relative) => {
    records[relative || "."] = directoryMetadata(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name), path.join(relative, entry.name));
    }
  };
  visit(root, "");
  return records;
}

function resolvedPython3() {
  for (const component of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!component || !path.isAbsolute(component)) continue;
    const candidate = path.join(component, "python3");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error("test requires python3 on an absolute PATH component");
}

function runHelperProbe(source, args = []) {
  const helperPath = fs.realpathSync(path.join(process.cwd(), "scripts", "receipt-portability-helper.py"));
  return spawnSync(resolvedPython3(), ["-I", "-S", "-B", "-c", source, helperPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function publishPromotion(t, suffix = "target") {
  const fixture = await createPortableFixture(t);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const target = promotionRoots(fixture, suffix);
  const input = promotionInput(fixture, published, target);
  const promoted = await portable.promoteNativeRunReceipt(input);
  assert.equal(promoted.status, "promoted", promoted.reason);
  return { fixture, published, target, input, promoted, paths: promotedPaths(fixture, published, promoted, target) };
}

const artifacts = {
  apk: { store: "receipt", algorithm: "sha256", sha256: HASH_A, bytes: 4096 },
  effectiveAppSpec: { store: "receipt", algorithm: "sha256", sha256: HASH_B, bytes: 512 },
  capture: { store: "ledger", algorithm: "sha256", sha256: HASH_C, bytes: 2048, width: 640, height: 480, format: "png" },
};

const payload = {
  kind: "pico.portable-native-run-receipt",
  schemaVersion: 1,
  app: "com.example.portable",
  sourceReceipt: {
    kind: "pico.native-run-receipt",
    schemaVersion: 1,
    receiptId: HASH_D,
    fileSha256: HASH_A,
  },
  artifacts,
};

const roots = {
  receipt: { realPath: "/var/lib/pico/receipts", deviceId: "16777232", inode: "987654321" },
  ledger: { realPath: "/var/lib/pico/ledger", deviceId: "16777232", inode: "987654322" },
};

const core = {
  app: payload.app,
  portableReceiptId: "e".repeat(64),
  sourceReceiptId: payload.sourceReceipt.receiptId,
  sourceRoots: roots,
  targetRoots: {
    receipt: { realPath: "/srv/pico/receipts", deviceId: "16777233", inode: "987654323" },
    ledger: { realPath: "/srv/pico/ledger", deviceId: "16777233", inode: "987654324" },
  },
  artifacts,
};

const audit = {
  promotionId: "f".repeat(64),
  recordedAt: "2026-08-31T12:34:56.789Z",
  toolVersion: "37.0.0-rc.1",
};

function domainHash(domain, value) {
  return crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from(domain, "utf8"),
    Buffer.from([0]),
    Buffer.from(canonicalJson(value), "utf8"),
  ])).digest("hex");
}

test("portable receipt identity catches a missing domain separator", () => {
  const expected = "686285ebed75d103fac0f8a7c0f12bec9b8e704122da606236542255be194bbf";
  assert.equal(portableReceiptIdOf(payload), expected);
  assert.equal(domainHash("pico.portable-native-run-receipt/v1", payload), expected);
});

test("promotion identity catches a core hash that omits pinned root identities", () => {
  const expected = "9a0a7781aeddacc19d637a8db637aa467b74a2edbfb115956a4d6e4f08cf1149";
  assert.equal(promotionIdOf(core), expected);
  assert.equal(domainHash("pico.run-receipt-promotion-core/v1", core), expected);
});

test("promotion audit identity catches a hash that omits recorded audit fields", () => {
  const expected = "851f825522778c89024f78f77268fd24d2cb7f6460b1d82422929665f105e354";
  assert.equal(auditIdOf(audit), expected);
  assert.equal(domainHash("pico.run-receipt-promotion-audit/v1", audit), expected);
});

test("portable schema catches untrusted receipt IDs, extra keys, and wrong artifact roles", () => {
  assert.throws(
    () => portableReceiptIdOf({ ...payload, receiptId: "0".repeat(64) }),
    /unrecognized|receiptId|invalid/i,
  );
  assert.throws(
    () => portableReceiptIdOf({ ...payload, unexpected: true }),
    /unrecognized|unexpected/i,
  );
  assert.throws(
    () => portableReceiptIdOf({ ...payload, artifacts: { ...artifacts, apk: { ...artifacts.apk, store: "ledger" } } }),
    /store|receipt|invalid/i,
  );
  assert.throws(
    () => portableReceiptIdOf({ ...payload, artifacts: { ...artifacts, extra: artifacts.apk } }),
    /unrecognized|extra/i,
  );
});

test("portable validators catch noncanonical hashes, root locators, timestamps, and tool versions", () => {
  assert.throws(
    () => promotionIdOf({ ...core, sourceRoots: { ...core.sourceRoots, receipt: { ...roots.receipt, deviceId: "01" } } }),
    /deviceId|decimal|invalid/i,
  );
  assert.throws(
    () => promotionIdOf({ ...core, sourceRoots: { ...core.sourceRoots, receipt: { ...roots.receipt, inode: "-1" } } }),
    /inode|decimal|invalid/i,
  );
  assert.throws(
    () => promotionIdOf({ ...core, sourceRoots: { ...core.sourceRoots, receipt: { ...roots.receipt, realPath: "/var/lib/pico/receipts/" } } }),
    /realPath|path|invalid/i,
  );
  for (const realPath of ["relative/store", "/", "/var/lib/pico/../pico/receipts", "/var/lib/pico\u0000/receipts"]) {
    assert.throws(
      () => promotionIdOf({ ...core, sourceRoots: { ...core.sourceRoots, receipt: { ...roots.receipt, realPath } } }),
      /realPath|path|invalid/i,
      `noncanonical root locator ${JSON.stringify(realPath)} must be rejected`,
    );
  }
  assert.throws(() => auditIdOf({ ...audit, recordedAt: "2026-08-31T12:34:56Z" }), /recordedAt|timestamp|invalid/i);
  assert.throws(() => auditIdOf({ ...audit, toolVersion: "v37.0.0" }), /toolVersion|version|invalid/i);
  assert.throws(() => portableReceiptIdOf({ ...payload, sourceReceipt: { ...payload.sourceReceipt, receiptId: "A".repeat(64) } }), /receiptId|invalid/i);
});

test("strict portable receipt, manifest, selector, and binding parsers catch extra persisted fields", () => {
  const receiptId = portableReceiptIdOf(payload);
  const promotionId = promotionIdOf({ ...core, portableReceiptId: receiptId });
  const auditId = auditIdOf({ ...audit, promotionId });
  assert.deepEqual(Object.keys(parsePortableRunReceipt({ ...payload, receiptId })).sort(), ["app", "artifacts", "kind", "receiptId", "schemaVersion", "sourceReceipt"]);
  assert.deepEqual(Object.keys(parsePromotionManifest({
    kind: "pico.run-receipt-promotion", schemaVersion: 1, promotionId, auditId,
    core: { ...core, portableReceiptId: receiptId }, recordedAt: audit.recordedAt, toolVersion: audit.toolVersion,
  })).sort(), ["auditId", "core", "kind", "promotionId", "recordedAt", "schemaVersion", "toolVersion"]);
  assert.throws(() => parsePortableRunReceipt({ ...payload, receiptId, extra: true }), /unrecognized|extra/i);
  assert.throws(() => parsePromotionManifest({
    kind: "pico.run-receipt-promotion", schemaVersion: 1, promotionId, auditId,
    core: { ...core, portableReceiptId: receiptId }, recordedAt: audit.recordedAt, toolVersion: audit.toolVersion, extra: true,
  }), /unrecognized|extra/i);
  assert.throws(() => parseReceiptSelector({ kind: "pico.native-run-receipt", schemaVersion: 1, receiptId: HASH_A, promotionId }), /unrecognized|promotion/i);
  assert.throws(() => parseRunReceiptBinding({ kind: "pico.native-run-receipt", schemaVersion: 1, receiptId: HASH_A, captureSha256: HASH_B, auditId }), /unrecognized|audit/i);
});

test("native lineage validator catches a source-root locator rewrite", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const receiptBytes = fs.readFileSync(published.receiptPath);
  const valid = store.validateNativeRunReceiptLineageSnapshot({
    app: fixture.payload.app,
    receiptId: published.receiptId,
    receiptBytes,
    sourceReceiptRoot: fixture.rootDir,
    sourceLedgerRoot: fixture.ledgerDir,
    apk: { sha256: fixture.payload.apk.sha256, bytes: fixture.payload.apk.bytes },
    effectiveAppSpecBytes: fs.readFileSync(fixture.publishedSpec.artifactPath),
    capture: validateCaptureBuffer(fs.readFileSync(fixture.captureArtifactPath), "fixture capture"),
  });
  assert.equal(valid.status, "valid");
  assert.equal(valid.receiptFileSha256, crypto.createHash("sha256").update(receiptBytes).digest("hex"));

  const rewritten = store.validateNativeRunReceiptLineageSnapshot({
    app: fixture.payload.app,
    receiptId: published.receiptId,
    receiptBytes,
    sourceReceiptRoot: `${fixture.rootDir}-other`,
    sourceLedgerRoot: fixture.ledgerDir,
    apk: { sha256: fixture.payload.apk.sha256, bytes: fixture.payload.apk.bytes },
    effectiveAppSpecBytes: fs.readFileSync(fixture.publishedSpec.artifactPath),
    capture: validateCaptureBuffer(fs.readFileSync(fixture.captureArtifactPath), "fixture capture"),
  });
  assert.equal(rewritten.status, "invalid");
  assert.match(rewritten.issues.join("\n"), /artifactPath|receipt-store|CAS/i);

  for (const sourceReceiptRoot of [
    path.relative(process.cwd(), fixture.rootDir),
    "/",
    `${path.dirname(fixture.rootDir)}/../${path.basename(path.dirname(fixture.rootDir))}/${path.basename(fixture.rootDir)}`,
    `${fixture.rootDir}\u0000`,
  ]) {
    const invalidRoot = store.validateNativeRunReceiptLineageSnapshot({
      app: fixture.payload.app,
      receiptId: published.receiptId,
      receiptBytes,
      sourceReceiptRoot,
      sourceLedgerRoot: fixture.ledgerDir,
      apk: { sha256: fixture.payload.apk.sha256, bytes: fixture.payload.apk.bytes },
      effectiveAppSpecBytes: fs.readFileSync(fixture.publishedSpec.artifactPath),
      capture: validateCaptureBuffer(fs.readFileSync(fixture.captureArtifactPath), "fixture capture"),
    });
    assert.equal(invalidRoot.status, "invalid", `invalid source root ${JSON.stringify(sourceReceiptRoot)} must fail`);
    assert.match(invalidRoot.issues.join("\n"), /sourceReceiptRoot.*canonical|source receipt root.*canonical/i);
  }
});

test("PROMOTE publishes independently verifiable immutable objects without a ledger row", async (t) => {
  const fixture = await createPortableFixture(t);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const target = promotionRoots(fixture);
  const sourcePaths = {
    receipt: published.receiptPath,
    apk: fixture.payload.apk.artifactPath,
    effectiveAppSpec: fixture.publishedSpec.artifactPath,
    capture: fixture.captureArtifactPath,
  };
  const sourceBefore = hashFiles(sourcePaths);

  const promoted = await portable.promoteNativeRunReceipt(promotionInput(fixture, published, target));
  assert.equal(promoted.status, "promoted", promoted.reason);
  assert.notEqual(promoted.portableReceiptId, published.receiptId);
  const paths = promotedPaths(fixture, published, promoted, target);
  assert.deepEqual({
    apk: promoted.apkArtifactPath,
    effectiveAppSpec: promoted.effectiveAppSpecArtifactPath,
    capture: promoted.captureArtifactPath,
    lineage: promoted.lineageReceiptPath,
    portable: promoted.portableReceiptPath,
    manifest: promoted.promotionManifestPath,
  }, paths);

  assert.deepEqual(hashFiles(sourcePaths), sourceBefore, "promotion must not modify any source object bytes");
  assert.equal(sha256Bytes(fs.readFileSync(paths.apk)), fixture.payload.apk.sha256);
  assert.equal(fs.statSync(paths.apk).size, fixture.payload.apk.bytes);
  const storedSpecBytes = fs.readFileSync(paths.effectiveAppSpec);
  const storedSpec = JSON.parse(storedSpecBytes);
  const canonicalSpec = Buffer.from(canonicalJson(storedSpec));
  assert.equal(sha256Bytes(canonicalSpec), fixture.payload.source.effectiveAppSpec.sha256);
  assert.equal(canonicalSpec.length, fixture.payload.source.effectiveAppSpec.bytes);
  assert.equal(storedSpecBytes.equals(Buffer.from(`${canonicalJson(storedSpec)}\n`)), true);
  const targetCapture = validateCaptureBuffer(fs.readFileSync(paths.capture), "promoted capture");
  assert.equal(targetCapture.ok, true);
  assert.deepEqual({
    sha256: targetCapture.sha256,
    bytes: targetCapture.bytes,
    width: targetCapture.width,
    height: targetCapture.height,
    format: targetCapture.format,
  }, {
    sha256: fixture.payload.capture.sha256,
    bytes: fixture.payload.capture.bytes,
    width: fixture.payload.capture.width,
    height: fixture.payload.capture.height,
    format: fixture.payload.capture.format,
  });

  const lineageBytes = fs.readFileSync(paths.lineage);
  assert.equal(lineageBytes.equals(fs.readFileSync(published.receiptPath)), true);
  const portableReceipt = parsePortableRunReceipt(JSON.parse(fs.readFileSync(paths.portable, "utf8")));
  const manifest = parsePromotionManifest(JSON.parse(fs.readFileSync(paths.manifest, "utf8")));
  assert.equal(lineageBytes.equals(Buffer.from(`${canonicalJson(JSON.parse(lineageBytes))}\n`)), true);
  assert.equal(fs.readFileSync(paths.portable).equals(Buffer.from(`${canonicalJson(portableReceipt)}\n`)), true);
  assert.equal(fs.readFileSync(paths.manifest).equals(Buffer.from(`${canonicalJson(manifest)}\n`)), true);
  assert.deepEqual(Object.keys(manifest).sort(), ["auditId", "core", "kind", "promotionId", "recordedAt", "schemaVersion", "toolVersion"]);
  assert.equal(portableReceipt.sourceReceipt.fileSha256, sha256Bytes(lineageBytes));
  const { receiptId: ignoredReceiptId, ...portablePayload } = portableReceipt;
  assert.equal(portableReceiptIdOf(portablePayload), promoted.portableReceiptId);
  assert.equal(promotionIdOf(manifest.core), promoted.promotionId);
  assert.equal(auditIdOf({ promotionId: manifest.promotionId, recordedAt: manifest.recordedAt, toolVersion: manifest.toolVersion }), promoted.auditId);
  assert.equal(fs.existsSync(path.join(target.targetLedgerRoot, `${fixture.payload.app}.json`)), false, "promotion must never append a ledger row");

  const read = await portable.readPortableRunReceipt(
    fixture.payload.app,
    promoted.portableReceiptId,
    promoted.promotionId,
    { rootDir: target.targetReceiptRoot, ledgerDir: target.targetLedgerRoot },
  );
  assert.equal(read.status, "valid", read.issues?.join("\n"));
  assert.equal(read.receipt.receiptId, promoted.portableReceiptId);
  assert.equal(read.manifest.auditId, promoted.auditId);
});

test("PROMOTE exact reruns and concurrent publishers reuse the first audit record", async (t) => {
  const fixture = await createPortableFixture(t);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const target = promotionRoots(fixture);
  const input = promotionInput(fixture, published, target);
  const raced = await Promise.all(Array.from({ length: 4 }, () => portable.promoteNativeRunReceipt(input)));
  for (const result of raced) assert.equal(result.status, "promoted", result.reason);
  assert.equal(new Set(raced.map((result) => result.portableReceiptId)).size, 1);
  assert.equal(new Set(raced.map((result) => result.promotionId)).size, 1);
  assert.equal(new Set(raced.map((result) => result.auditId)).size, 1);
  assert.equal(new Set(raced.map((result) => result.recordedAt)).size, 1);

  const rerun = await portable.promoteNativeRunReceipt(input);
  assert.equal(rerun.status, "promoted", rerun.reason);
  assert.equal(rerun.recordedAt, raced[0].recordedAt);
  assert.equal(rerun.auditId, raced[0].auditId);
  assert.deepEqual(temporaryNames(target.targetReceiptRoot), []);
  assert.deepEqual(temporaryNames(target.targetLedgerRoot), []);
});

test("PROMOTE permits only the designed identical source/target receipt-root exception", async (t) => {
  const fixture = await createPortableFixture(t, { app: "com.example.shared_receipt_root" });
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const targetLedgerRoot = path.join(fixture.scratch, "shared-root-target-ledger");
  fs.mkdirSync(targetLedgerRoot);
  const promoted = await portable.promoteNativeRunReceipt({
    ...promotionInput(fixture, published, {
      targetReceiptRoot: fs.realpathSync(fixture.rootDir),
      targetLedgerRoot: fs.realpathSync(targetLedgerRoot),
    }),
  });
  assert.equal(promoted.status, "promoted", promoted.reason);
  assert.equal(fs.existsSync(fixture.payload.apk.artifactPath), true);
  assert.equal(fs.existsSync(fixture.publishedSpec.artifactPath), true);
});

test("PROMOTE reports an ambiguous interpreter override unavailable before target writes", async (t) => {
  const fixture = await createPortableFixture(t, { app: "com.example.unavailable_helper" });
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const target = promotionRoots(fixture);
  const previous = process.env.PICO_MCP_RECEIPT_PORTABILITY_PYTHON;
  process.env.PICO_MCP_RECEIPT_PORTABILITY_PYTHON = "relative/python3";
  t.after(() => {
    if (previous === undefined) delete process.env.PICO_MCP_RECEIPT_PORTABILITY_PYTHON;
    else process.env.PICO_MCP_RECEIPT_PORTABILITY_PYTHON = previous;
  });
  const result = await portable.promoteNativeRunReceipt(promotionInput(fixture, published, target));
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /absolute.*executable|override|python/i);
  assert.deepEqual(fs.readdirSync(target.targetReceiptRoot), []);
  assert.deepEqual(fs.readdirSync(target.targetLedgerRoot), []);
});

test("PROMOTE refuses a portable receipt as a recursive source", async (t) => {
  const first = await publishPromotion(t, "first-target");
  const next = promotionRoots(first.fixture, "second-target");
  const recursive = await portable.promoteNativeRunReceipt({
    app: first.fixture.payload.app,
    sourceReceiptId: first.promoted.portableReceiptId,
    sourceReceiptRoot: first.target.targetReceiptRoot,
    sourceLedgerRoot: first.target.targetLedgerRoot,
    ...next,
  });
  assert.equal(recursive.status, "refused");
  assert.match(recursive.reason, /portable|one-hop|recursive/i);
});

test("PROMOTE refuses every missing or mismatched source object", async (t) => {
  const cases = [
    ["receipt deleted", (fixture, published) => fs.unlinkSync(published.receiptPath)],
    ["receipt mismatched", (fixture, published) => fs.writeFileSync(published.receiptPath, "{}\n")],
    ["APK deleted", (fixture) => fs.unlinkSync(fixture.payload.apk.artifactPath)],
    ["APK mismatched", (fixture) => fs.writeFileSync(fixture.payload.apk.artifactPath, Buffer.from("PK\u0003\u0004wrong-apk"))],
    ["effective AppSpec deleted", (fixture) => fs.unlinkSync(fixture.publishedSpec.artifactPath)],
    ["effective AppSpec mismatched", (fixture) => fs.writeFileSync(fixture.publishedSpec.artifactPath, "{}\n")],
    ["capture deleted", (fixture) => fs.unlinkSync(fixture.captureArtifactPath)],
    ["capture mismatched", (fixture) => fs.writeFileSync(fixture.captureArtifactPath, Buffer.from("not a png"))],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (child) => {
      const fixture = await createPortableFixture(child, { app: `com.example.source_${name.replace(/[^a-z]+/gi, "_").toLowerCase()}` });
      const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
      const target = promotionRoots(fixture);
      mutate(fixture, published);
      const result = await portable.promoteNativeRunReceipt(promotionInput(fixture, published, target));
      assert.equal(result.status, "refused");
      assert.match(result.reason, /receipt|APK|spec|capture|source|valid|exist|hash|canonical/i);
      assert.equal(fs.existsSync(path.join(target.targetReceiptRoot, "promotions-v1")), false, "no manifest may commit for invalid source bytes");
    });
  }
});

test("PROMOTE refuses source symlinks, target child symlinks, and unsafe root overlap", async (t) => {
  await t.test("source final symlink", async (child) => {
    const fixture = await createPortableFixture(child, { app: "com.example.source_symlink" });
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const target = promotionRoots(fixture);
    const realApk = path.join(fixture.scratch, "same-apk-bytes.apk");
    fs.writeFileSync(realApk, fs.readFileSync(fixture.payload.apk.artifactPath));
    fs.unlinkSync(fixture.payload.apk.artifactPath);
    fs.symlinkSync(realApk, fixture.payload.apk.artifactPath);
    const result = await portable.promoteNativeRunReceipt(promotionInput(fixture, published, target));
    assert.equal(result.status, "refused");
    assert.match(result.reason, /symbolic|symlink|no-follow|source/i);
  });

  await t.test("target child symlink", async (child) => {
    const fixture = await createPortableFixture(child, { app: "com.example.target_symlink" });
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const target = promotionRoots(fixture);
    const outside = path.join(fixture.scratch, "outside-target");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target.targetReceiptRoot, "artifacts"));
    const result = await portable.promoteNativeRunReceipt(promotionInput(fixture, published, target));
    assert.equal(result.status, "refused");
    assert.match(result.reason, /symbolic|symlink|no-follow|directory/i);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  await t.test("root alias and overlap", async (child) => {
    const fixture = await createPortableFixture(child, { app: "com.example.root_overlap" });
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const target = promotionRoots(fixture);
    const alias = path.join(fixture.scratch, "receipt-alias");
    fs.symlinkSync(fixture.rootDir, alias);
    const aliased = await portable.promoteNativeRunReceipt({ ...promotionInput(fixture, published, target), sourceReceiptRoot: alias });
    assert.equal(aliased.status, "refused");
    assert.match(aliased.reason, /resolved|canonical|symlink|root/i);

    const equalLedger = await portable.promoteNativeRunReceipt({ ...promotionInput(fixture, published, target), targetLedgerRoot: fs.realpathSync(fixture.ledgerDir) });
    assert.equal(equalLedger.status, "refused");
    assert.match(equalLedger.reason, /overlap|distinct|root/i);

    const nestedLedger = path.join(target.targetLedgerRoot, "nested");
    fs.mkdirSync(nestedLedger);
    const nested = await portable.promoteNativeRunReceipt({ ...promotionInput(fixture, published, target), targetReceiptRoot: nestedLedger });
    assert.equal(nested.status, "refused");
    assert.match(nested.reason, /overlap|ancestor|descendant|root/i);
  });
});

test("portable historical reads never dereference recorded source roots", async (t) => {
  const promoted = await publishPromotion(t);
  fs.rmSync(promoted.fixture.rootDir, { recursive: true });
  fs.rmSync(promoted.fixture.ledgerDir, { recursive: true });
  const read = await portable.readPortableRunReceipt(
    promoted.fixture.payload.app,
    promoted.promoted.portableReceiptId,
    promoted.promoted.promotionId,
    { rootDir: promoted.target.targetReceiptRoot, ledgerDir: promoted.target.targetLedgerRoot },
  );
  assert.equal(read.status, "valid", read.issues?.join("\n"));
});

test("portable historical reader requires the manifest commit marker", async (t) => {
  const promoted = await publishPromotion(t);
  fs.unlinkSync(promoted.paths.manifest);
  assert.equal(fs.existsSync(promoted.paths.portable), true, "portable bytes alone are not a commit");
  const read = await portable.readPortableRunReceipt(
    promoted.fixture.payload.app,
    promoted.promoted.portableReceiptId,
    promoted.promoted.promotionId,
    { rootDir: promoted.target.targetReceiptRoot, ledgerDir: promoted.target.targetLedgerRoot },
  );
  assert.equal(read.status, "invalid");
  assert.match(read.issues.join("\n"), /manifest|exist|open/i);
});

test("portable historical reads and PROMOTE reruns fail closed on every corrupt final object", async (t) => {
  for (const role of ["apk", "effectiveAppSpec", "capture", "lineage", "portable", "manifest"]) {
    await t.test(role, async (child) => {
      const promoted = await publishPromotion(child, `target-${role.toLowerCase()}`);
      fs.writeFileSync(promoted.paths[role], Buffer.from(`corrupt-${role}`, "utf8"));
      const rerun = await portable.promoteNativeRunReceipt(promoted.input);
      assert.equal(rerun.status, "refused");
      assert.match(rerun.reason, /corrupt|canonical|hash|invalid|mismatch|PNG|manifest|receipt|trailing newline/i);
      const read = await portable.readPortableRunReceipt(
        promoted.fixture.payload.app,
        promoted.promoted.portableReceiptId,
        promoted.promoted.promotionId,
        { rootDir: promoted.target.targetReceiptRoot, ledgerDir: promoted.target.targetLedgerRoot },
      );
      assert.equal(read.status, "invalid");
      assert.match(read.issues.join("\n"), /corrupt|canonical|hash|invalid|valid JSON|mismatch|PNG|manifest|receipt|trailing newline/i);
      assert.deepEqual(temporaryNames(promoted.target.targetReceiptRoot), [], "ordinary refusal must clean receipt-store temporary names");
      assert.deepEqual(temporaryNames(promoted.target.targetLedgerRoot), [], "ordinary refusal must clean ledger-store temporary names");
    });
  }
});

test("PROMOTE validates the exact reread lineage before helper publication", async (t) => {
  const fixture = await createPortableFixture(t, { app: "com.example.swap_a" });
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const target = promotionRoots(fixture);
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = function (filename, ...args) {
    if (!swapped && path.resolve(String(filename)) === path.resolve(published.receiptPath)) {
      swapped = true;
      const changed = JSON.parse(originalReadFileSync.call(fs, published.receiptPath, "utf8"));
      changed.app = "com.example.swap_b";
      const replacement = Buffer.from(`${canonicalJson(changed)}\n`, "utf8");
      assert.equal(replacement.length, fs.statSync(published.receiptPath).size, "deterministic swap must preserve the stat-before-read size");
      fs.writeFileSync(published.receiptPath, replacement);
    }
    return originalReadFileSync.call(fs, filename, ...args);
  };
  let result;
  try {
    result = await portable.promoteNativeRunReceipt(promotionInput(fixture, published, target));
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(swapped, true, "test must swap the lineage during the post-validator bounded read");
  assert.equal(result.status, "refused");
  assert.match(result.reason, /lineage|receipt|app|recomputed|invalid/i);
  assert.equal(fs.existsSync(path.join(target.targetReceiptRoot, "promotions-v1")), false, "invalid reread lineage must be refused before a manifest can commit");
});

test("PROMOTE never repairs a dependency beneath an existing committed manifest", async (t) => {
  const cases = [
    ["apk", (promoted) => fs.unlinkSync(promoted.paths.apk)],
    ["effectiveAppSpec", (promoted) => fs.unlinkSync(promoted.paths.effectiveAppSpec)],
    ["capture", (promoted) => fs.unlinkSync(promoted.paths.capture)],
    ["lineage", (promoted) => fs.unlinkSync(promoted.paths.lineage)],
    ["portable final-name drift", (promoted) => {
      const drifted = path.join(path.dirname(promoted.paths.portable), `${HASH_A}.json`);
      fs.renameSync(promoted.paths.portable, drifted);
    }],
  ];
  for (const [name, removeDependency] of cases) {
    await t.test(name, async (child) => {
      const promoted = await publishPromotion(child, `committed-${String(name).toLowerCase().replace(/[^a-z]+/g, "-")}`);
      removeDependency(promoted);
      const missingPath = name === "portable final-name drift" ? promoted.paths.portable : promoted.paths[name];
      const targetMetadata = {
        receipt: directoryTreeMetadata(promoted.target.targetReceiptRoot),
        ledger: directoryTreeMetadata(promoted.target.targetLedgerRoot),
      };
      const before = await portable.readPortableRunReceipt(
        promoted.fixture.payload.app,
        promoted.promoted.portableReceiptId,
        promoted.promoted.promotionId,
        { rootDir: promoted.target.targetReceiptRoot, ledgerDir: promoted.target.targetLedgerRoot },
      );
      assert.equal(before.status, "invalid");
      const rerun = await portable.promoteNativeRunReceipt(promoted.input);
      assert.equal(rerun.status, "refused");
      assert.match(rerun.reason, /manifest|committed|target|exist|open|missing|receipt|APK|capture|AppSpec/i);
      assert.equal(fs.existsSync(missingPath), false, "rerun must not recreate a missing committed dependency");
      assert.deepEqual({
        receipt: directoryTreeMetadata(promoted.target.targetReceiptRoot),
        ledger: directoryTreeMetadata(promoted.target.targetLedgerRoot),
      }, targetMetadata, "committed-state refusal must perform no target directory writes");
      const after = await portable.readPortableRunReceipt(
        promoted.fixture.payload.app,
        promoted.promoted.portableReceiptId,
        promoted.promoted.promotionId,
        { rootDir: promoted.target.targetReceiptRoot, ledgerDir: promoted.target.targetLedgerRoot },
      );
      assert.equal(after.status, "invalid");
    });
  }
});

test("PROMOTE shared receipt roots leave native APK and spec directories byte-for-byte metadata stable", async (t) => {
  const fixture = await createPortableFixture(t, { app: "com.example.shared_metadata" });
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const apkDirectory = path.dirname(fixture.payload.apk.artifactPath);
  const specDirectory = path.dirname(fixture.publishedSpec.artifactPath);
  const oldTime = new Date("2001-01-01T00:00:00.000Z");
  fs.utimesSync(apkDirectory, oldTime, oldTime);
  fs.utimesSync(specDirectory, oldTime, oldTime);
  const before = { apk: directoryMetadata(apkDirectory), spec: directoryMetadata(specDirectory) };
  const targetLedgerRoot = path.join(fixture.scratch, "shared-metadata-ledger");
  fs.mkdirSync(targetLedgerRoot);
  const result = await portable.promoteNativeRunReceipt(promotionInput(fixture, published, {
    targetReceiptRoot: fs.realpathSync(fixture.rootDir),
    targetLedgerRoot: fs.realpathSync(targetLedgerRoot),
  }));
  assert.equal(result.status, "promoted", result.reason);
  assert.deepEqual({ apk: directoryMetadata(apkDirectory), spec: directoryMetadata(specDirectory) }, before,
    "shared-root promotion must not stage, link, or unlink inside native CAS directories");
  assert.deepEqual(temporaryNames(apkDirectory), []);
  assert.deepEqual(temporaryNames(specDirectory), []);
});

test("PROMOTE helper rejects same-path different-inode roots and retained child substitution", (t) => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pico-portability-helper-probe-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const left = path.join(scratch, "left");
  const right = path.join(scratch, "right");
  const root = path.join(scratch, "root");
  fs.mkdirSync(left);
  fs.mkdirSync(right);
  fs.mkdirSync(path.join(root, "child"), { recursive: true });
  const probe = runHelperProbe(String.raw`
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("receipt_helper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeRoot:
    def __init__(self, fd):
        self.path = "/same/canonical/path"
        self.fd = fd
        self.chain_ids = []

left_fd = os.open(sys.argv[2], os.O_RDONLY | os.O_DIRECTORY)
right_fd = os.open(sys.argv[3], os.O_RDONLY | os.O_DIRECTORY)
try:
    try:
        module.reject_root_overlap({"sourceReceipt": FakeRoot(left_fd), "targetReceipt": FakeRoot(right_fd)})
    except module.PortabilityError:
        pass
    else:
        raise AssertionError("same locator with different descriptor identities was accepted")
finally:
    os.close(left_fd)
    os.close(right_fd)

root_path = os.path.realpath(sys.argv[4])
root_stat = os.stat(root_path)
opened = module.StoreRoot("probeRoot", {
    "realPath": root_path,
    "deviceId": str(root_stat.st_dev),
    "inode": str(root_stat.st_ino),
})
try:
    opened.open_dir(["child"])
    os.rename(os.path.join(root_path, "child"), os.path.join(root_path, "moved"))
    os.mkdir(os.path.join(root_path, "child"))
    try:
        opened.verify()
    except module.PortabilityError:
        pass
    else:
        raise AssertionError("retained child substitution was accepted")
finally:
    opened.close()

saved_dir_fd = module.os.supports_dir_fd
try:
    module.os.supports_dir_fd = set()
    try:
        module.check_platform_apis()
    except module.UnsupportedPortabilityError:
        pass
    else:
        raise AssertionError("missing descriptor APIs were accepted")
finally:
    module.os.supports_dir_fd = saved_dir_fd
`, [left, right, root]);
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
});

test("PROMOTE helper JSON parser rejects non-finite numbers and lone surrogates recursively", () => {
  const probe = runHelperProbe(String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("receipt_helper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = [
    b'{"value":NaN}',
    b'{"value":Infinity}',
    b'{"value":-Infinity}',
    b'{"value":1e9999}',
    b'{"nested":[{"value":"\\ud800"}]}',
    b'{"\\udfff":"value"}',
]
for raw in cases:
    try:
        module.parse_json_bytes(raw, 1024, "probe")
    except module.PortabilityError:
        continue
    raise AssertionError("strict parser accepted %r" % raw)
`);
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
});

test("portable historical helper responses require exact canonical stdout bytes", async (t) => {
  const fixture = await createPortableFixture(t, { app: "com.example.stdout_framing" });
  const target = promotionRoots(fixture);
  const responses = [
    '{ "protocol": "pico.receipt-portability-helper", "version": 1, "status": "error", "operation": "inspect", "reason": "fake helper failure" }\n',
    '{"operation":"inspect","protocol":"pico.receipt-portability-helper","reason":"first","reason":"duplicate helper failure","status":"error","version":1}\n',
  ];
  const previous = process.env.PICO_MCP_RECEIPT_PORTABILITY_PYTHON;
  try {
    for (const [index, response] of responses.entries()) {
      await t.test(`noncanonical response ${index + 1}`, async () => {
        const fake = path.join(fixture.scratch, `fake-python-${index}.py`);
        const encoded = Buffer.from(response, "utf8").toString("base64");
        fs.writeFileSync(fake, `#!${resolvedPython3()}\nimport base64, sys\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(base64.b64decode("${encoded}"))\n`, { mode: 0o700 });
        process.env.PICO_MCP_RECEIPT_PORTABILITY_PYTHON = fake;
        const result = await portable.readPortableRunReceipt(
          fixture.payload.app,
          HASH_A,
          HASH_B,
          { rootDir: target.targetReceiptRoot, ledgerDir: target.targetLedgerRoot },
        );
        assert.equal(result.status, "invalid");
        assert.match(result.issues.join("\n"), /invalid response|canonical stdout/i);
      });
    }
  } finally {
    if (previous === undefined) delete process.env.PICO_MCP_RECEIPT_PORTABILITY_PYTHON;
    else process.env.PICO_MCP_RECEIPT_PORTABILITY_PYTHON = previous;
  }
});

test("PROMOTE accepts a valid committed winner from a different tool version", async (t) => {
  const promoted = await publishPromotion(t, "different-tool-winner");
  const manifest = JSON.parse(fs.readFileSync(promoted.paths.manifest, "utf8"));
  manifest.recordedAt = "2026-08-31T23:59:59.999Z";
  manifest.toolVersion = "99.1.0";
  manifest.auditId = auditIdOf({ promotionId: manifest.promotionId, recordedAt: manifest.recordedAt, toolVersion: manifest.toolVersion });
  fs.writeFileSync(promoted.paths.manifest, `${canonicalJson(manifest)}\n`);
  const rerun = await portable.promoteNativeRunReceipt(promoted.input);
  assert.equal(rerun.status, "promoted", rerun.reason);
  assert.equal(rerun.recordedAt, manifest.recordedAt);
  assert.equal(rerun.auditId, manifest.auditId);
});

test("PROMOTE resumes uncommitted dependency publication only while the manifest is absent", async (t) => {
  const promoted = await publishPromotion(t, "resume-without-manifest");
  fs.unlinkSync(promoted.paths.manifest);
  const before = await portable.readPortableRunReceipt(
    promoted.fixture.payload.app,
    promoted.promoted.portableReceiptId,
    promoted.promoted.promotionId,
    { rootDir: promoted.target.targetReceiptRoot, ledgerDir: promoted.target.targetLedgerRoot },
  );
  assert.equal(before.status, "invalid");
  const resumed = await portable.promoteNativeRunReceipt(promoted.input);
  assert.equal(resumed.status, "promoted", resumed.reason);
  assert.equal(fs.existsSync(promoted.paths.manifest), true);
});

test("portable historical reads reject manifest target-root field drift", async (t) => {
  const promoted = await publishPromotion(t, "manifest-root-drift");
  const manifest = JSON.parse(fs.readFileSync(promoted.paths.manifest, "utf8"));
  manifest.core.targetRoots.receipt.inode = manifest.core.targetRoots.receipt.inode === "0" ? "1" : "0";
  fs.writeFileSync(promoted.paths.manifest, `${canonicalJson(manifest)}\n`);
  const read = await portable.readPortableRunReceipt(
    promoted.fixture.payload.app,
    promoted.promoted.portableReceiptId,
    promoted.promoted.promotionId,
    { rootDir: promoted.target.targetReceiptRoot, ledgerDir: promoted.target.targetLedgerRoot },
  );
  assert.equal(read.status, "invalid");
  assert.match(read.issues.join("\n"), /root|identity|promotion|manifest/i);
});
