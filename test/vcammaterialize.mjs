// v29.2 materializer: frames before manifest, indexed by array position, fail-closed.
// Run: npm run test:vcammaterialize
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sutUrl = new URL("../dist/vcammaterialize.js", import.meta.url);
const loadSut = () => import(sutUrl.href);

const FRAME_BYTES = 1280 * 720 * 4;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function fakeSequence(counters) {
  const frames = counters.map((counter) => {
    const pixels = Buffer.alloc(FRAME_BYTES, counter & 0xff);
    return { counter, width: 1280, height: 720, pixelFormat: "BGRA", pixels, sha256: sha256(pixels) };
  });
  const manifest = { schemaVersion: 1, kind: "pico-vcam-fixed-pose-sequence", frames: frames.map((f) => ({ counter: f.counter, bytes: f.pixels.length, sha256: f.sha256 })) };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  return { frames, manifest, manifestJson, manifestSha256: sha256(Buffer.from(manifestJson, "utf8")) };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vcam-materialize-"));

test("frames are written by array index and the manifest lands last", async () => {
  const { materializeSequence } = await loadSut();
  const dir = tempDir();
  // Counters deliberately NOT 0..N: the writer resolves frame-%03d.bgra by ARRAY POSITION.
  const sequence = fakeSequence([7, 3, 11]);
  const result = materializeSequence(sequence, dir);

  assert.deepEqual(result.framePaths.map((p) => path.basename(p)),
    ["frame-000.bgra", "frame-001.bgra", "frame-002.bgra"]);
  assert.equal(path.basename(result.manifestPath), "manifest.json");
  assert.equal(result.manifestSha256, sequence.manifestSha256);

  result.framePaths.forEach((framePath, index) => {
    const bytes = fs.readFileSync(framePath);
    assert.equal(bytes.length, FRAME_BYTES);
    assert.equal(sha256(bytes), sequence.frames[index].sha256, `frame-${String(index).padStart(3, "0")} must match array position ${index}`);
  });
  assert.equal(fs.readFileSync(result.manifestPath, "utf8"), sequence.manifestJson);
  assert.equal(sha256(fs.readFileSync(result.manifestPath)), sequence.manifestSha256,
    "the on-disk manifest hash is what the native writer will verify");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a mismatched frame hash is refused before anything is written", async () => {
  const { materializeSequence } = await loadSut();
  const dir = tempDir();
  const sequence = fakeSequence([0, 1]);
  sequence.frames[1].sha256 = "00".repeat(32);
  assert.throws(() => materializeSequence(sequence, dir), /sha256|hash/i);
  assert.deepEqual(fs.readdirSync(dir), [], "a rejected sequence must leave no partial output");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a wrong-size frame is refused", async () => {
  const { materializeSequence } = await loadSut();
  const dir = tempDir();
  const sequence = fakeSequence([0]);
  sequence.frames[0].pixels = Buffer.alloc(FRAME_BYTES - 1);
  assert.throws(() => materializeSequence(sequence, dir), /3686400|bytes/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses to overwrite an existing manifest", async () => {
  const { materializeSequence } = await loadSut();
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
  assert.throws(() => materializeSequence(fakeSequence([0]), dir), /exists/i,
    "a run must never silently clobber a retained evidence directory");
  // The throw alone doesn't prove nothing was written: Node's own "wx"-flag EEXIST error also
  // matches /exists/i, so a refactor that dropped the early existsSync guard and relied solely on
  // that flag at the final manifest write would still pass the line above while frame-000.bgra had
  // already landed in the directory. Check the directory holds only the pre-existing manifest.
  assert.deepEqual(fs.readdirSync(dir), ["manifest.json"],
    "a refused overwrite must not leave a partial frame behind");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("more than 16 frames is refused, matching the native cap", async () => {
  const { materializeSequence } = await loadSut();
  const dir = tempDir();
  assert.throws(() => materializeSequence(fakeSequence(Array.from({ length: 17 }, (_, i) => i)), dir), /1-16|16/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// None of the tests above actually pin the "frames before manifest" ordering contract: they only
// check the final directory state after a full success, which passes identically whether the
// writer emits frames-then-manifest or manifest-then-frames. This test forces a failure IN THE
// MIDDLE of frame writing (by pre-seeding a collision on the second frame's path, after validation
// has already passed) and asserts manifest.json is absent afterward. That only holds if the
// manifest write happens strictly after every frame write — the actual safety property the brief
// describes: "a crash between the two leaves a frame set with no manifest, which is inert and safe."
test("a failure partway through frame writing leaves no manifest on disk", async () => {
  const { materializeSequence } = await loadSut();
  const dir = tempDir();
  const sequence = fakeSequence([7, 3, 11]);
  // Collides with the SECOND frame by array position (frame-001.bgra), not by counter value.
  fs.writeFileSync(path.join(dir, "frame-001.bgra"), "pre-existing, not written by the materializer");
  assert.throws(() => materializeSequence(sequence, dir), /exists/i);
  assert.equal(fs.existsSync(path.join(dir, "manifest.json")), false,
    "manifest must not appear on disk when a mid-sequence frame write fails: writing it first would " +
    "advertise sibling frames that never got created, a live TOCTOU on those names");
  fs.rmSync(dir, { recursive: true, force: true });
});
