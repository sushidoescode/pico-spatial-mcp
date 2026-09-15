/**
 * publish-tarball — the release step that may only ever ADD.
 *
 * The defect these tests pin: `verify-tarball --publish <dir>` used to `fs.rmSync` every `.tgz`
 * already in the directory before copying the new one in, so publishing 37.0.0 destroyed the
 * 36.9.x artifacts a tester was still installing from. Publication is now a non-replacing
 * primitive: verify the source digest, stage a task-owned temporary, re-read its bytes, and land
 * it with an exclusive hard link. Every test below therefore checks two things — that the new
 * artifact arrived, and that nothing else in the directory moved.
 *
 * Hermetic: real files, real hard links, real collisions, no npm, no network. The archive
 * directory deliberately carries a space and a non-ASCII character (same rationale as
 * verify-tarball [M6]) so a path-handling regression cannot hide behind a tidy temp name.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  publishVerifiedTarball,
  receiptPathFor,
  writePublicationReceipt,
} from "../scripts/publish-tarball.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** A throwaway directory whose name is hostile on purpose. */
function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pico publish é ${label} `));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Two earlier releases that must survive every path through the helper, byte for byte. */
function seedPriorArchives(dir) {
  const priors = ["36.9.0", "36.9.1"].map((version) => ({
    name: `pico-spatial-mcp-${version}.tgz`,
    // NUL and 0xFF are built as bytes rather than written as source escapes: they are what a
    // text-mode or re-encoding copy would mangle, and keeping them out of this file keeps it
    // a reviewable text diff.
    bytes: Buffer.concat([
      Buffer.from(`PRIOR RELEASE ${version} sentinel `, "latin1"),
      Buffer.from([0x00, 0xff]),
      Buffer.from(" bytes\n", "latin1"),
    ]),
  }));
  for (const prior of priors) fs.writeFileSync(path.join(dir, prior.name), prior.bytes);
  return priors;
}

/** A stand-in tarball: bytes that are not text, so a truncated or re-encoded copy is visible. */
function seedSource(t, { size = 4096 } = {}) {
  const dir = tempDir(t, "src");
  const bytes = crypto.createHash("sha512").update("pico-spatial-mcp source tarball").digest();
  const payload = Buffer.concat(Array.from({ length: Math.ceil(size / bytes.length) }, () => bytes)).subarray(0, size);
  const source = path.join(dir, "pico-spatial-mcp-37.0.0.tgz");
  fs.writeFileSync(source, payload);
  return { source, payload, expectedSha256: sha256(payload) };
}

const assertPriorsIntact = (dir, priors) => {
  for (const prior of priors) {
    assert.deepEqual(fs.readFileSync(path.join(dir, prior.name)), prior.bytes, `${prior.name} bytes moved`);
  }
};

// --------------------------------------------------------------------------------------------
// The publication itself
// --------------------------------------------------------------------------------------------

test("publishes a verified tarball alongside prior versions, leaving every one of them untouched", (t) => {
  const archiveDir = tempDir(t, "archive");
  const priors = seedPriorArchives(archiveDir);
  const { source, payload, expectedSha256 } = seedSource(t);
  const destination = path.join(archiveDir, "pico-spatial-mcp-37.0.0.tgz");

  const result = publishVerifiedTarball({ source, destination, expectedSha256 });

  assert.deepEqual(result, { path: destination, sha256: expectedSha256, bytes: payload.length });
  assert.deepEqual(fs.readFileSync(destination), payload, "the published bytes are the verified bytes");
  assertPriorsIntact(archiveDir, priors);
  assert.deepEqual(
    fs.readdirSync(archiveDir).sort(),
    [...priors.map((prior) => prior.name), "pico-spatial-mcp-37.0.0.tgz"].sort(),
    "publication adds exactly one entry and leaves no temporary behind",
  );
});

test("refuses to replace an existing artifact, and the prior bytes and directory listing do not move", (t) => {
  const archiveDir = tempDir(t, "archive");
  const priors = seedPriorArchives(archiveDir);
  const { source, expectedSha256 } = seedSource(t);
  const existing = path.join(archiveDir, priors[1].name);
  const priorBytes = fs.readFileSync(existing);
  const priorNames = fs.readdirSync(archiveDir).sort();

  assert.throws(() => publishVerifiedTarball({ source, destination: existing, expectedSha256 }), /exists/);
  assert.deepEqual(fs.readFileSync(existing), priorBytes);
  assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames);
});

test("refuses a source whose digest is not the digest that passed verification, and writes nothing", (t) => {
  const archiveDir = tempDir(t, "archive");
  const priors = seedPriorArchives(archiveDir);
  const priorNames = fs.readdirSync(archiveDir).sort();
  const { source, expectedSha256 } = seedSource(t);
  const destination = path.join(archiveDir, "pico-spatial-mcp-37.0.0.tgz");
  const wrong = "0".repeat(64);

  assert.throws(
    () => publishVerifiedTarball({ source, destination, expectedSha256: wrong }),
    (error) => {
      assert.match(error.message, /digest/i);
      assert.match(error.message, new RegExp(expectedSha256));
      return true;
    },
  );
  assert.equal(fs.existsSync(destination), false, "a digest mismatch must never reach the destination");
  assertPriorsIntact(archiveDir, priors);
  assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames);

  // A source that is not there at all is the same refusal, not a crash that leaves scratch behind.
  assert.throws(() => publishVerifiedTarball({
    source: path.join(path.dirname(source), "absent.tgz"),
    destination,
    expectedSha256,
  }));
  assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames);
});

test("an interrupted copy removes its own temporary and never creates the destination", (t) => {
  for (const step of ["write", "fsync"]) {
    const archiveDir = tempDir(t, `archive-${step}`);
    const priors = seedPriorArchives(archiveDir);
    const priorNames = fs.readdirSync(archiveDir).sort();
    const { source, expectedSha256 } = seedSource(t);
    const destination = path.join(archiveDir, "pico-spatial-mcp-37.0.0.tgz");

    assert.throws(
      () => publishVerifiedTarball({
        source,
        destination,
        expectedSha256,
        io: { [step]: () => { throw new Error(`simulated ${step} failure`); } },
      }),
      new RegExp(`simulated ${step} failure`),
      `${step}: the underlying failure must surface, not be swallowed`,
    );
    assert.equal(fs.existsSync(destination), false, `${step}: no partial destination`);
    assertPriorsIntact(archiveDir, priors);
    assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames, `${step}: no temporary left behind`);
  }
});

test("re-reads the staged bytes and refuses to publish a copy that does not hash to the verified digest", (t) => {
  const archiveDir = tempDir(t, "archive");
  const priors = seedPriorArchives(archiveDir);
  const priorNames = fs.readdirSync(archiveDir).sort();
  const { source, expectedSha256 } = seedSource(t);
  const destination = path.join(archiveDir, "pico-spatial-mcp-37.0.0.tgz");

  // A write that reports full success and stores one flipped byte: same length, wrong content.
  // Only a re-read of what actually landed on disk can see this.
  const corruptingWrite = (fd, buffer, length) => {
    const corrupted = Buffer.from(buffer.subarray(0, length));
    corrupted[0] ^= 0xff;
    return fs.writeSync(fd, corrupted, 0, length);
  };
  assert.throws(
    () => publishVerifiedTarball({ source, destination, expectedSha256, io: { write: corruptingWrite } }),
    /staged copy/i,
  );
  assert.equal(fs.existsSync(destination), false);
  assertPriorsIntact(archiveDir, priors);
  assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames);
});

test("falls back to an exclusive probe and a rename when the filesystem cannot hard-link", (t) => {
  const archiveDir = tempDir(t, "archive");
  const priors = seedPriorArchives(archiveDir);
  const { source, payload, expectedSha256 } = seedSource(t);
  const destination = path.join(archiveDir, "pico-spatial-mcp-37.0.0.tgz");
  const renames = [];
  const unsupported = () => { const error = new Error("cross-device link not permitted"); error.code = "EXDEV"; throw error; };

  const result = publishVerifiedTarball({
    source,
    destination,
    expectedSha256,
    io: { link: unsupported, rename: (from, to) => { renames.push([from, to]); fs.renameSync(from, to); } },
  });

  assert.equal(renames.length, 1, "the fallback runs exactly one rename");
  assert.equal(renames[0][1], destination);
  assert.deepEqual(result, { path: destination, sha256: expectedSha256, bytes: payload.length });
  assert.deepEqual(fs.readFileSync(destination), payload);
  assertPriorsIntact(archiveDir, priors);
  assert.deepEqual(
    fs.readdirSync(archiveDir).sort(),
    [...priors.map((prior) => prior.name), "pico-spatial-mcp-37.0.0.tgz"].sort(),
  );
});

test("the rename fallback still refuses an occupied destination instead of overwriting it", (t) => {
  const archiveDir = tempDir(t, "archive");
  const priors = seedPriorArchives(archiveDir);
  const priorNames = fs.readdirSync(archiveDir).sort();
  const { source, expectedSha256 } = seedSource(t);
  const existing = path.join(archiveDir, priors[0].name);
  const renames = [];
  const unsupported = () => { const error = new Error("operation not permitted"); error.code = "EPERM"; throw error; };

  assert.throws(
    () => publishVerifiedTarball({
      source,
      destination: existing,
      expectedSha256,
      io: { link: unsupported, rename: (from, to) => { renames.push([from, to]); fs.renameSync(from, to); } },
    }),
    /exists/,
  );
  assert.deepEqual(renames, [], "an occupied destination must be refused before any rename");
  assert.deepEqual(fs.readFileSync(existing), priors[0].bytes);
  assert.deepEqual(fs.readdirSync(archiveDir).sort(), priorNames);
});

test("creates a missing destination directory, and refuses malformed arguments before touching disk", (t) => {
  const archiveDir = tempDir(t, "archive");
  const { source, payload, expectedSha256 } = seedSource(t);
  const nested = path.join(archiveDir, "2026-09-15-release", "pico-spatial-mcp-37.0.0.tgz");

  const result = publishVerifiedTarball({ source, destination: nested, expectedSha256 });
  assert.equal(result.path, nested);
  assert.deepEqual(fs.readFileSync(nested), payload);
  assert.deepEqual(fs.readdirSync(path.dirname(nested)), ["pico-spatial-mcp-37.0.0.tgz"]);

  const bad = path.join(archiveDir, "never.tgz");
  for (const options of [
    { source: "", destination: bad, expectedSha256 },
    { source, destination: "", expectedSha256 },
    { source, destination: bad, expectedSha256: "not-a-digest" },
    { source, destination: bad, expectedSha256: expectedSha256.toUpperCase() },
    { source, destination: bad },
  ]) {
    assert.throws(() => publishVerifiedTarball(options), /source|destination|expectedSha256/i);
  }
  assert.equal(fs.existsSync(bad), false);
});

// --------------------------------------------------------------------------------------------
// The publication receipt
// --------------------------------------------------------------------------------------------

test("writes the receipt beside the artifact and never overwrites an existing one", (t) => {
  const archiveDir = tempDir(t, "archive");
  const priors = seedPriorArchives(archiveDir);
  const { source, expectedSha256 } = seedSource(t);
  const destination = path.join(archiveDir, "pico-spatial-mcp-37.0.0.tgz");
  publishVerifiedTarball({ source, destination, expectedSha256 });

  const receipt = { artifact: { path: destination, sha256: expectedSha256 }, limitations: ["fixture receipt"] };
  assert.equal(receiptPathFor(destination), `${destination}.receipt.json`);
  const written = writePublicationReceipt({ destination, receipt });
  assert.equal(written.path, `${destination}.receipt.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(written.path, "utf8")), receipt);

  const receiptBytes = fs.readFileSync(written.path);
  const names = fs.readdirSync(archiveDir).sort();
  assert.throws(() => writePublicationReceipt({ destination, receipt: { replaced: true } }), /exists/);
  assert.deepEqual(fs.readFileSync(written.path), receiptBytes, "a receipt collision must not rewrite the receipt");
  assert.deepEqual(fs.readdirSync(archiveDir).sort(), names);
  assertPriorsIntact(archiveDir, priors);
});

// --------------------------------------------------------------------------------------------
// The structural half of "never deletes anything"
// --------------------------------------------------------------------------------------------

test("the publication module contains no directory enumeration and no recursive removal", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "publish-tarball.mjs"), "utf8");
  // Comments are stripped first: the module header names the `rmSync` sweep it exists to remove,
  // and that sentence should stay readable. The assertion is about executable code.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const forbidden of [/readdir/i, /\brmSync\b/, /\brm\b\s*\(/, /rimraf/i, /\bglob\b/i]) {
    assert.doesNotMatch(code, forbidden, `publication must never enumerate or bulk-remove: ${forbidden}`);
  }
  // The only removal the module may perform is of the temporary it created itself.
  const unlinks = [...code.matchAll(/unlink\s*\(([^)]*)\)/g)].map((match) => match[1].trim());
  assert.ok(unlinks.length > 0, "the temporary must be removed on every path");
  for (const argument of unlinks) {
    assert.match(argument, /temporary|probe|filePath/, `unlink target is not a task-owned path: ${argument}`);
  }
});

test("verify-tarball publishes through the helper and removes nothing but its own sandbox", () => {
  const verify = fs.readFileSync(path.join(repoRoot, "scripts", "verify-tarball.mjs"), "utf8");
  const code = verify.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  assert.match(code, /publishVerifiedTarball\(\{/, "publication must go through the non-replacing helper");
  assert.match(code, /writePublicationReceipt\(\{/, "a publication must be receipted");
  // The defect, pinned: the old branch ran fs.rmSync over every .tgz already in the destination and
  // then fs.copyFileSync'd the new one on top.
  assert.deepEqual(
    [...code.matchAll(/rmSync\(([^),]*)/g)].map((match) => match[1].trim()),
    ["sandbox"],
    "verify-tarball may remove nothing but the throwaway sandbox it created",
  );
  assert.doesNotMatch(code, /copyFileSync/, "a published artifact is never written with a replacing copy");
});
