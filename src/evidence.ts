import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import jpegJs from "jpeg-js";

/**
 * evidence.ts — the honesty PRIMITIVE (v6.1). A `vision_verified` claim must link a capture that is
 * actually a RENDERED IMAGE, not merely a path that resolves. The prior gate only checked
 * fs.existsSync(artifactPath) — so a .txt file, /etc/hosts, a 0-byte file, or a directory all passed as
 * "the frame I LOOKED at" (proven live in ADVERSARIAL_FINDINGS.md C1). This module validates that the
 * artifact is a real PNG/JPEG with real dimensions, and returns a content sha256 for provenance + reuse
 * detection (the same frame linked to many claims is a red flag). It CANNOT prove the frame shows the
 * right thing — that is the calibrated visual judge's job — but it makes the trivial spoofs impossible.
 *
 * PNG chunks are CRC-checked and the complete bounded raster stream is inflated. JPEG marker/scan
 * structure is walked through EOI and then decoded under jpeg-js memory/resolution bounds. This is
 * still an evidence-container integrity gate, not a semantic judge of what the pixels depict.
 */

export type CaptureCheck = {
  ok: boolean;
  reason?: string;
  format?: "png" | "jpeg";
  width?: number;
  height?: number;
  bytes?: number;
  sha256?: string;
};

type CaptureRead = { ok: true; bytes: Buffer } | { ok: false; reason: string };

const MIN_BYTES = 67;
const MIN_DIM = 64; // a scene capture is not a 16×16 icon
const MAX_DIM = 16_384;
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type RasterInspection = { ok: true; width: number; height: number } | { ok: false; reason: string };

function pngExpectedBytes(width: number, height: number, bitsPerPixel: number, interlace: number): { bytes: number; rowStarts: number[] } | null {
  const passes = interlace === 0
    ? [[0, 0, 1, 1] as const]
    : [
        [0, 0, 8, 8] as const,
        [4, 0, 8, 8] as const,
        [0, 4, 4, 8] as const,
        [2, 0, 4, 4] as const,
        [0, 2, 2, 4] as const,
        [1, 0, 2, 2] as const,
        [0, 1, 1, 2] as const,
      ];
  let total = 0;
  const rowStarts: number[] = [];
  for (const [startX, startY, stepX, stepY] of passes) {
    if (width <= startX || height <= startY) continue;
    const passWidth = Math.ceil((width - startX) / stepX);
    const passHeight = Math.ceil((height - startY) / stepY);
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let row = 0; row < passHeight; row++) {
      rowStarts.push(total);
      total += 1 + rowBytes;
      if (!Number.isSafeInteger(total) || total > MAX_DECODED_BYTES) return null;
    }
  }
  return { bytes: total, rowStarts };
}

function inspectPngStructure(buf: Buffer): RasterInspection {
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, reason: "bad PNG signature" };
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let interlace = 0;
  let sawIhdr = false;
  let sawPlte = false;
  let sawIdat = false;
  let leftIdatRun = false;
  let sawIend = false;
  let colorType = -1;
  const idat: Buffer[] = [];

  while (offset < buf.length) {
    if (buf.length - offset < 12) return { ok: false, reason: "truncated PNG chunk header" };
    const length = buf.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > buf.length) return { ok: false, reason: "truncated PNG chunk data" };
    const typeBytes = buf.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) return { ok: false, reason: "invalid PNG chunk type" };
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) return { ok: false, reason: `${type} PNG chunk CRC mismatch` };
    const data = buf.subarray(dataStart, dataEnd);

    if (!sawIhdr && type !== "IHDR") return { ok: false, reason: "IHDR is not the first PNG chunk" };
    if (type === "IHDR") {
      if (sawIhdr || length !== 13) return { ok: false, reason: "invalid or duplicate PNG IHDR" };
      sawIhdr = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      const allowedDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > MAX_DIM || height > MAX_DIM) return { ok: false, reason: `invalid or excessive PNG dimensions ${width}x${height}` };
      if (!allowedDepths[colorType]?.includes(bitDepth)) return { ok: false, reason: `invalid PNG bit-depth ${bitDepth} for color type ${colorType}` };
      if (data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) return { ok: false, reason: "unsupported PNG compression, filter, or interlace method" };
      interlace = data[12];
      bitsPerPixel = channels[colorType] * bitDepth;
    } else if (type === "PLTE") {
      if (sawIdat || sawPlte || length === 0 || length % 3 !== 0 || length > 768) return { ok: false, reason: "invalid PNG PLTE chunk" };
      sawPlte = true;
    } else if (type === "IDAT") {
      if (leftIdatRun) return { ok: false, reason: "PNG IDAT chunks are not consecutive" };
      if (colorType === 3 && !sawPlte) return { ok: false, reason: "indexed PNG has no PLTE before IDAT" };
      sawIdat = true;
      idat.push(data);
    } else if (type === "IEND") {
      if (!sawIdat || sawIend || length !== 0) return { ok: false, reason: "invalid PNG IEND" };
      sawIend = true;
      offset = chunkEnd;
      if (offset !== buf.length) return { ok: false, reason: "bytes follow PNG IEND" };
      break;
    } else {
      if (sawIdat) leftIdatRun = true;
      // Unknown critical chunks (uppercase first byte) change decoding semantics; fail closed.
      if (typeBytes[0] >= 0x41 && typeBytes[0] <= 0x5a) return { ok: false, reason: `unknown critical PNG chunk ${type}` };
    }
    offset = chunkEnd;
  }
  if (!sawIhdr || !sawIdat || !sawIend) return { ok: false, reason: "PNG is missing IHDR, IDAT, or IEND" };
  const layout = pngExpectedBytes(width, height, bitsPerPixel, interlace);
  if (!layout) return { ok: false, reason: "PNG decoded raster would exceed the bounded evidence limit" };
  let decoded: Buffer;
  try {
    decoded = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: layout.bytes + 1 });
  } catch (error: any) {
    return { ok: false, reason: `PNG IDAT stream did not decode: ${error?.message ?? String(error)}` };
  }
  if (decoded.length !== layout.bytes) return { ok: false, reason: `PNG decoded raster length ${decoded.length} did not match expected ${layout.bytes}` };
  if (layout.rowStarts.some((rowStart) => decoded[rowStart] > 4)) return { ok: false, reason: "PNG raster contains an invalid filter byte" };
  return { ok: true, width, height };
}

/** Parse PNG width/height from the IHDR chunk (first chunk after the 8-byte signature). */
export function inspectPng(buf: Buffer): { width: number; height: number } | null {
  const inspected = inspectPngStructure(buf);
  return inspected.ok ? { width: inspected.width, height: inspected.height } : null;
}

/** Walk a complete JPEG marker/entropy stream through EOI and return its SOF dimensions. */
function inspectJpegStructure(buf: Buffer): RasterInspection {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { ok: false, reason: "bad JPEG SOI" };
  let off = 2;
  let width = 0;
  let height = 0;
  let sawSof = false;
  let sawSos = false;
  let entropy = false;
  while (off < buf.length) {
    if (entropy) {
      while (off < buf.length && buf[off] !== 0xff) off++;
      if (off >= buf.length) return { ok: false, reason: "JPEG entropy stream is truncated before EOI" };
      let markerOffset = off;
      while (off < buf.length && buf[off] === 0xff) off++;
      if (off >= buf.length) return { ok: false, reason: "JPEG ends in an incomplete marker" };
      const marker = buf[off++];
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9) {
        if (off !== buf.length) return { ok: false, reason: "bytes follow JPEG EOI" };
        return sawSof && sawSos ? { ok: true, width, height } : { ok: false, reason: "JPEG has no SOF/SOS image stream" };
      }
      off = markerOffset;
      entropy = false;
      continue;
    }
    if (buf[off] !== 0xff) return { ok: false, reason: "JPEG marker stream is malformed" };
    while (off < buf.length && buf[off] === 0xff) off++;
    if (off >= buf.length) return { ok: false, reason: "JPEG ends in an incomplete marker" };
    const marker = buf[off++];
    if (marker === 0xd9) return { ok: false, reason: "JPEG reached EOI before scan data" };
    if (marker === 0xd8 || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (marker === 0xd8 || marker === 0x00) return { ok: false, reason: "unexpected JPEG standalone marker" };
      continue;
    }
    if (off + 2 > buf.length) return { ok: false, reason: "truncated JPEG segment length" };
    const length = buf.readUInt16BE(off);
    if (length < 2 || off + length > buf.length) return { ok: false, reason: "invalid or truncated JPEG segment" };
    const dataStart = off + 2;
    const dataEnd = off + length;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 8 || sawSof) return { ok: false, reason: "invalid or duplicate JPEG SOF" };
      height = buf.readUInt16BE(dataStart + 1);
      width = buf.readUInt16BE(dataStart + 3);
      if (!width || !height || width > MAX_DIM || height > MAX_DIM) return { ok: false, reason: `invalid or excessive JPEG dimensions ${width}x${height}` };
      sawSof = true;
    }
    off = dataEnd;
    if (marker === 0xda) {
      if (!sawSof) return { ok: false, reason: "JPEG SOS precedes SOF" };
      sawSos = true;
      entropy = true;
    }
  }
  return { ok: false, reason: "JPEG is truncated before EOI" };
}

export function inspectJpeg(buf: Buffer): { width: number; height: number } | null {
  const inspected = inspectJpegStructure(buf);
  return inspected.ok ? { width: inspected.width, height: inspected.height } : null;
}

/**
 * Validate that `p` is a real, non-trivial raster image. Returns { ok, reason } on failure; on success
 * also returns format/width/height/bytes/sha256 (the ledger records these for provenance + reuse checks).
 */
export function validateCaptureBuffer(buf: Buffer, label = "capture", opts: { minBytes?: number } = {}): CaptureCheck {
  const minBytes = opts.minBytes ?? MIN_BYTES;
  if (buf.length < minBytes) return { ok: false, reason: `artifact '${label}' is only ${buf.length} bytes — too small to be a real capture` };
  if (buf.length > MAX_CAPTURE_BYTES) return { ok: false, reason: `artifact '${label}' is ${buf.length} bytes — exceeds the ${MAX_CAPTURE_BYTES}-byte evidence limit` };
  const png = buf.subarray(0, 8).equals(PNG_SIGNATURE);
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!png && !isJpeg) return { ok: false, reason: `artifact '${label}' is not a PNG/JPEG image (bad magic bytes) — an image-grounded claim must link a real rendered frame` };
  const inspected = png ? inspectPngStructure(buf) : inspectJpegStructure(buf);
  if (!inspected.ok) return { ok: false, reason: `artifact '${label}' is not a structurally complete ${png ? "PNG" : "JPEG"}: ${inspected.reason}` };
  if (!png) {
    try {
      // A complete marker stream can still contain no valid Huffman tables or raster data. Decode
      // fail-closed with explicit memory/resolution bounds; marker-only JPEG-shaped bytes are not
      // evidence. PNG gets the equivalent full inflate/scanline validation above.
      const decoded = jpegJs.decode(buf, {
        useTArray: true,
        formatAsRGBA: false,
        tolerantDecoding: false,
        maxResolutionInMP: 64,
        maxMemoryUsageInMB: 256,
      });
      if (!decoded.data?.length || decoded.width !== inspected.width || decoded.height !== inspected.height) {
        return { ok: false, reason: `artifact '${label}' JPEG decoder did not produce the declared raster` };
      }
    } catch (error: any) {
      return { ok: false, reason: `artifact '${label}' JPEG raster did not decode: ${error?.message ?? String(error)}` };
    }
  }
  if (inspected.width < MIN_DIM || inspected.height < MIN_DIM) return { ok: false, reason: `artifact '${label}' is ${inspected.width}×${inspected.height} — too small to be a scene capture` };
  return { ok: true, format: png ? "png" : "jpeg", width: inspected.width, height: inspected.height, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}

export function validateCapture(p: string | undefined, opts: { minBytes?: number } = {}): CaptureCheck {
  if (!p || !p.trim()) return { ok: false, reason: "no artifactPath supplied" };
  const read = readCaptureBytes(p);
  if (!read.ok) return read;
  return validateCaptureBuffer(read.bytes, p, opts);
}

/** Open once, fstat that exact descriptor, and read exactly the bounded size plus a one-byte growth
 * probe. This avoids both allocating an oversized file and the stat(path)→read(path) replacement race. */
export function readCaptureBytes(p: string): CaptureRead {
  let fd: number | undefined;
  try {
    fd = fs.openSync(p, "r");
  } catch (error: any) {
    if (error?.code === "ENOENT") return { ok: false, reason: `artifact '${p}' does not exist` };
    return { ok: false, reason: `artifact '${p}' could not be read: ${error?.message ?? String(error)}` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) return { ok: false, reason: `artifact '${p}' is a directory, not an image` };
    if (!st.isFile()) return { ok: false, reason: `artifact '${p}' is not a regular file` };
    if (st.size > MAX_CAPTURE_BYTES) return { ok: false, reason: `artifact '${p}' is ${st.size} bytes — exceeds the ${MAX_CAPTURE_BYTES}-byte evidence limit` };
    const bytes = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) return { ok: false, reason: `artifact '${p}' changed or was truncated while being read` };
      offset += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, growthProbe, 0, 1, null) !== 0 || fs.fstatSync(fd).size !== st.size) {
      return { ok: false, reason: `artifact '${p}' changed or grew while being read; refusing an unstable evidence snapshot` };
    }
    return { ok: true, bytes };
  } catch (error: any) {
    return { ok: false, reason: `artifact '${p}' could not be read: ${error?.message ?? String(error)}` };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** Pull the first plausible image path out of a free-text evidence string (legacy capability_report). */
export function extractImagePath(evidence: string | undefined): string | undefined {
  if (!evidence) return undefined;
  const m = evidence.match(/(\/[^\s"']+\.(?:png|jpg|jpeg))/i) || evidence.match(/([~.][^\s"']*\.(?:png|jpg|jpeg))/i);
  return m ? m[1] : undefined;
}
