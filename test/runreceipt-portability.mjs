import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  auditIdOf,
  parsePortableRunReceipt,
  parsePromotionManifest,
  parseReceiptSelector,
  parseRunReceiptBinding,
  portableReceiptIdOf,
  promotionIdOf,
} from "../dist/runreceiptportable.js";
import { canonicalJson } from "../dist/runreceiptidentity.js";
import * as store from "../dist/runreceiptstore.js";
import { validateCaptureBuffer } from "../dist/evidence.js";
import { createRunReceiptFixture } from "./helpers/runreceipt-fixture.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

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
});
