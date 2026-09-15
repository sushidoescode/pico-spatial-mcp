// Media inspection is PURE and HERMETIC: every case below reads a committed fixture from
// test/fixtures/media/ (see that directory's README for provenance — none is a device capture) and
// calls src/artifactinspection.ts. No adb, no device, no host decoder, no child process. The only
// decoder that may run is the pure-JS PNG path inside the module, or a FAKE decoder injected here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  inspectPng,
  inspectMp4,
  classifyFrame,
  sha256Bytes,
  sha256File,
  DARK_FRAME_NOTE,
} from "../dist/artifactinspection.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "media");
const read = (name) => fs.readFileSync(path.join(fixtures, name));

// ── sha256 helpers ─────────────────────────────────────────────────────────────────────────────

test("sha256Bytes and sha256File agree with the reference digest of the same fixture", () => {
  const bytes = read("valid-small.png");
  const expected = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256Bytes(bytes), expected);
  const fromFile = sha256File(path.join(fixtures, "valid-small.png"));
  assert.equal(fromFile.sha256, expected);
  assert.equal(fromFile.bytes, bytes.length);
});

test("sha256File reports a missing file instead of throwing or inventing a digest", () => {
  const missing = sha256File(path.join(fixtures, "no-such-fixture.png"));
  assert.equal(missing.sha256, null);
  assert.match(missing.reason, /no-such-fixture\.png/);
});

// ── PNG ────────────────────────────────────────────────────────────────────────────────────────

test("a valid small PNG inspects as valid with its real dimensions and bit depth", () => {
  const bytes = read("valid-small.png");
  const result = inspectPng(bytes);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.width, 64);
  assert.equal(result.height, 64);
  assert.equal(result.bitDepth, 8);
  assert.equal(result.colorType, 2);
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.sha256, sha256Bytes(bytes));
  assert.equal(result.meetsCaptureFloor, true);
});

test("a truncated PNG larger than 1000 bytes is INVALID — the size floor alone must not accept it", () => {
  const bytes = read("truncated.png");
  assert.ok(bytes.length > 1000, "the fixture has to be above the 1000-byte floor to be the interesting case");
  const result = inspectPng(bytes);
  assert.equal(result.valid, false);
  assert.ok(result.reason && result.reason.length > 0, "an invalid image must say why");
  assert.equal(result.sha256, sha256Bytes(bytes), "an invalid artifact still gets an honest digest");
});

test("arbitrary nonempty bytes above the capture floor are not a PNG", () => {
  const bytes = read("arbitrary-nonempty.bin");
  assert.ok(bytes.length > 1000);
  const result = inspectPng(bytes);
  assert.equal(result.valid, false);
  assert.match(result.reason, /signature|PNG/i);
  assert.equal(result.width, null);
  assert.equal(result.height, null);
});

test("a valid PNG below the capture-evidence floor is still a valid PNG, and says it is below the floor", () => {
  // 8×8 is a structurally perfect PNG that is NOT a scene capture. Format validity and
  // evidence-worthiness are separate answers; collapsing them is how a 16×16 icon becomes "a frame".
  const tiny = buildTinyPng();
  const result = inspectPng(tiny);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.width, 8);
  assert.equal(result.meetsCaptureFloor, false);
  assert.ok(result.captureFloorReason, "the floor refusal must name its reason");
});

function buildTinyPng() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, body, crc]);
  };
  const raw = Buffer.alloc(8 * (1 + 8 * 3));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── MP4 ────────────────────────────────────────────────────────────────────────────────────────

test("a valid short MP4 reports its MEASURED duration and its declared video track", () => {
  const bytes = read("valid-short.mp4");
  const result = inspectMp4(bytes);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.durationSec, 1.5, "1500 ticks at a 1000-tick timescale is 1.5 s, measured from mvhd");
  assert.equal(result.hasVideoTrack, true);
  assert.equal(result.trackCount, 1);
  assert.deepEqual(result.handlerTypes, ["vide"]);
  assert.equal(result.sha256, sha256Bytes(bytes));
});

test("an MP4 whose only track is audio is a valid container with NO video stream", () => {
  const result = inspectMp4(read("no-video-track.mp4"));
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.hasVideoTrack, false);
  assert.equal(result.trackCount, 1);
  assert.deepEqual(result.handlerTypes, ["soun"]);
  assert.equal(result.durationSec, 1.5);
});

test("arbitrary nonempty bytes are not an MP4", () => {
  const result = inspectMp4(read("arbitrary-nonempty.bin"));
  assert.equal(result.valid, false);
  assert.ok(result.reason);
  assert.equal(result.durationSec, null);
  assert.equal(result.hasVideoTrack, false);
});

test("a truncated MP4 box header fails closed instead of reporting a partial duration", () => {
  const truncated = read("valid-short.mp4").subarray(0, 60);
  const result = inspectMp4(truncated);
  assert.equal(result.valid, false);
  assert.equal(result.durationSec, null);
  assert.match(result.reason, /truncat|incomplete|box/i);
});

test("an MP4 missing mdat is refused — a header with no media payload is not a recording", () => {
  const full = read("valid-short.mp4");
  const mdatStart = full.indexOf(Buffer.from("mdat", "ascii")) - 4;
  const result = inspectMp4(full.subarray(0, mdatStart));
  assert.equal(result.valid, false);
  assert.match(result.reason, /mdat/i);
});

// ── frame classification ───────────────────────────────────────────────────────────────────────

test("a valid dark frame is INCONCLUSIVE about the capture route, never proof of failed rendering", () => {
  const result = classifyFrame(read("valid-dark.png"));
  assert.equal(result.status, "dark");
  assert.equal(result.valid, true, "the frame itself is a structurally valid PNG");
  assert.equal(result.verdict, "inconclusive-capture-route");
  assert.equal(result.meanLuma, 0);
  assert.equal(result.note, DARK_FRAME_NOTE);
  assert.match(DARK_FRAME_NOTE, /inconclusive/i);
  assert.doesNotMatch(JSON.stringify(result), /render(ing)? (failed|failure)/i,
    "a dark frame must never be reported as a rendering failure");
});

test("a valid lit frame classifies as lit with a real mean luma", () => {
  const result = classifyFrame(read("valid-small.png"));
  assert.equal(result.status, "lit");
  assert.equal(result.verdict, "frame-has-content");
  assert.ok(result.meanLuma > 8, `expected a lit mean luma, got ${result.meanLuma}`);
});

test("a malformed image is undecodable, not dark", () => {
  const result = classifyFrame(read("truncated.png"));
  assert.equal(result.status, "undecodable");
  assert.equal(result.valid, false);
  assert.equal(result.meanLuma, null);
});

test("with no decoder available the answer is UNVALIDATED, never a successful decode", () => {
  // A JPEG-shaped artifact: the pure-JS path in this module decodes PNG only, and no decoder is
  // injected, so the honest answer is that nothing decoded it — not "dark", not "lit".
  const jpegish = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
  const result = classifyFrame(jpegish);
  assert.equal(result.status, "unvalidated");
  assert.equal(result.meanLuma, null);
  assert.match(result.reason, /decoder/i);
});

test("an injected decoder is used when present, and its failure stays unvalidated", () => {
  const calls = [];
  const decoder = (bytes) => {
    calls.push(bytes.length);
    return { ok: true, width: 2, height: 1, pixels: Buffer.from([255, 255, 255, 255, 255, 255]) };
  };
  const jpegish = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
  const lit = classifyFrame(jpegish, decoder);
  assert.equal(calls.length, 1, "the injected decoder must actually be the seam that ran");
  assert.equal(lit.status, "lit");
  // Rec.709 coefficients do not sum to exactly 1 in binary floating point, so white lands a few
  // ULPs below 255. Asserting an exact 255 would be asserting the rounding, not the brightness.
  assert.ok(Math.abs(lit.meanLuma - 255) < 1e-6, `expected ~255, got ${lit.meanLuma}`);

  const failing = classifyFrame(jpegish, () => ({ ok: false, reason: "fixture decoder declined" }));
  assert.equal(failing.status, "unvalidated");
  assert.match(failing.reason, /fixture decoder declined/);
});

test("the inspection module cannot reach a process, a device, or a decoder on PATH", () => {
  // Structural, not incidental. A monkey-patch assertion would not hold (named imports from a
  // builtin are bound before a test can swap them), so this is the textual half used elsewhere in
  // this repo: the compiled module must contain no process-spawning or device-facing surface at
  // all. `fs` is permitted for sha256File and nothing else.
  const source = fs.readFileSync(new URL("../dist/artifactinspection.js", import.meta.url), "utf8");
  for (const forbidden of ["child_process", "spawn", "execFile", "adb", "ffprobe", "magick", "emulator-"]) {
    assert.ok(!source.includes(forbidden), `artifactinspection must not reference ${forbidden}`);
  }
});

// ── the recording-artifact contract (capture_record's media check) ──────────────────────────────
// inspectRecordingArtifact is the pure half of capture_record: it is what turns "exit 0 and a
// nonempty file" into a statement about the container. Hermetic — it reads a committed fixture and
// a temp file, and never runs the CLI or a device.
const { inspectRecordingArtifact } = await import("../dist/picoclitools.js");

test("a valid short recording is validated, with a MEASURED duration that is not the request", () => {
  const result = inspectRecordingArtifact(path.join(fixtures, "valid-short.mp4"));
  assert.equal(result.media, "validated");
  assert.equal(result.measuredDurationSec, 1.5);
  assert.equal(result.hasVideoTrack, true);
  assert.equal(result.sha256, sha256Bytes(read("valid-short.mp4")));
  assert.equal(result.bytes, read("valid-short.mp4").length);
  // The point of the field: a 15-second REQUEST and a 1.5-second FILE must not be the same number.
  assert.notEqual(result.measuredDurationSec, 15);
});

test("a recording with no video stream is a validated container that declares no video", () => {
  const result = inspectRecordingArtifact(path.join(fixtures, "no-video-track.mp4"));
  assert.equal(result.media, "validated");
  assert.equal(result.hasVideoTrack, false);
  assert.match(result.reason, /video track absent/i);
});

test("a nonempty file that is not a container is INVALID media, not a recording", () => {
  const result = inspectRecordingArtifact(path.join(fixtures, "arbitrary-nonempty.bin"));
  assert.equal(result.media, "invalid");
  assert.equal(result.measuredDurationSec, null);
  assert.ok(result.sha256, "an invalid artifact still gets an honest digest");
  assert.match(result.reason, /not a parseable MP4/i);
});

test("a recording that cannot be read at all is UNVALIDATED, never a successful decode", () => {
  const result = inspectRecordingArtifact(path.join(fixtures, "no-such-recording.mp4"));
  assert.equal(result.media, "unvalidated");
  assert.equal(result.sha256, null);
  assert.equal(result.measuredDurationSec, null);
  assert.match(result.reason, /no-such-recording\.mp4/);
});

test("capture_record still caps the request at 180 s and defaults short", () => {
  // The CLI 0.5 line advertises 1800 s. Nothing in this repository has measured a recording that
  // long, so the wrapper's documented 180 s cap stands and no test asks for a 30-minute recording.
  const source = fs.readFileSync(new URL("../src/picoclitools.ts", import.meta.url), "utf8");
  const schema = /durationSec: z\.number\(\)\.min\(1\)\.max\((\d+)\)[\s\S]{0,200}?default (\d+)\)/.exec(source);
  assert.ok(schema, "capture_record's duration schema must remain declared in one readable place");
  assert.equal(schema[1], "180", "the 180-second MCP cap must not be widened without route evidence");
  assert.equal(Number(schema[2]) <= 30, true, `the default recording length must stay short, got ${schema[2]}s`);
  assert.ok(source.includes("Math.min(180,"), "the clamp must also be enforced in code, not only in the schema");
  assert.ok(!/1800/.test(source), "no 1800-second recording path may be built into this wrapper");
});
