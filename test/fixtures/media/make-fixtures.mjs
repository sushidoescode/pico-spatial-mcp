#!/usr/bin/env node
// Deterministic media fixtures for test/artifactinspection.mjs and test/verifyapk-observation.mjs.
//
// Every byte here is SYNTHESISED from the code below. None of these files is a device capture, a
// screen recording, or a copy of anyone's content — see README.md. Re-run with:
//   node test/fixtures/media/make-fixtures.mjs
// (zlib's exact compressed bytes depend on the local zlib build, so the committed files are the
// artifact of record and the tests assert their PROPERTIES, never byte-equality with a rerun.)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ── PNG ────────────────────────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf) => {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
};
/** 8-bit truecolour (color type 2), no interlace, one filter-0 scanline per row. */
function png(width, height, pixel) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // deflate / adaptive / non-interlaced
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A deterministic high-entropy pattern: bright enough to classify as LIT and incompressible enough
// that the truncation fixture below still exceeds the 1000-byte "too small to be a real capture"
// floor while being structurally broken.
const litPixel = (x, y) => [(x * 37 + y * 17) & 0xff, (x * 53 + y * 101) & 0xff, (x * 11 + y * 199) & 0xff];
const validSmall = png(64, 64, litPixel);
const validDark = png(64, 64, () => [0, 0, 0]);
// Cut inside the IDAT chunk: signature + IHDR survive, the raster and IEND do not.
const truncated = validSmall.subarray(0, 1400);

// Neither a PNG nor an MP4: a nonempty byte run larger than the 1000-byte capture floor, so a
// size-only check would call it a capture.
const arbitrary = Buffer.alloc(1536);
for (let i = 0; i < arbitrary.length; i++) arbitrary[i] = (i * 31 + 7) & 0xff;

// ── MP4 ────────────────────────────────────────────────────────────────────────────────────────
const box = (type, ...parts) => {
  const payload = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, payload]);
};
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; };
const zeros = (n) => Buffer.alloc(n);
const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

const ftyp = box("ftyp", Buffer.from("isom", "ascii"), u32(0x200), Buffer.from("isomiso2mp41", "ascii"));
/** mvhd v0: timescale + duration are the only fields inspectMp4 reads. */
const mvhd = (timescale, duration) => box("mvhd",
  u32(0), u32(0), u32(0), u32(timescale), u32(duration),
  u32(0x00010000), u16(0x0100), zeros(2), zeros(8), MATRIX, zeros(24), u32(2));
const tkhd = (trackId, duration) => box("tkhd",
  u32(0x00000007), u32(0), u32(0), u32(trackId), zeros(4), u32(duration), zeros(8),
  u16(0), u16(0), u16(0), zeros(2), MATRIX, u32(320 << 16), u32(240 << 16));
const mdhd = (timescale, duration) => box("mdhd", u32(0), u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
const hdlr = (handlerType, name) => box("hdlr", u32(0), zeros(4), Buffer.from(handlerType, "ascii"), zeros(12), Buffer.from(`${name}\0`, "ascii"));
const trak = (trackId, handlerType, name, timescale, duration) =>
  box("trak", tkhd(trackId, duration), box("mdia", mdhd(timescale, duration), hdlr(handlerType, name)));
const mdat = box("mdat", Buffer.from(Array.from({ length: 96 }, (_, i) => (i * 13 + 5) & 0xff)));

// 1.5 s at a 1000-tick timescale, one declared video track.
const validShort = Buffer.concat([ftyp, box("moov", mvhd(1000, 1500), trak(1, "vide", "VideoHandler", 30000, 45000)), mdat]);
// Structurally identical, but the only declared track is audio.
const noVideo = Buffer.concat([ftyp, box("moov", mvhd(1000, 1500), trak(1, "soun", "SoundHandler", 44100, 66150)), mdat]);

const files = {
  "valid-small.png": validSmall,
  "valid-dark.png": validDark,
  "truncated.png": truncated,
  "arbitrary-nonempty.bin": arbitrary,
  "valid-short.mp4": validShort,
  "no-video-track.mp4": noVideo,
};
for (const [name, bytes] of Object.entries(files)) {
  fs.writeFileSync(path.join(here, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
