import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { inspectPng as inspectPngStructure, validateCaptureBuffer } from "./evidence.js";

/**
 * artifactinspection.ts — PURE media inspection (Task C6).
 *
 * "The file exists and is bigger than 1000 bytes" was, until this module, the only thing standing
 * between a truncated download and a capture presented as evidence. Every function here takes
 * BYTES (or a path, for hashing) and returns a structured answer; nothing in this module can reach
 * a device, a process, or a decoder on PATH. That is asserted textually by
 * test/artifactinspection.mjs, so keep it true.
 *
 * Reuse, not duplication: PNG container validity (signature, chunk CRCs, IHDR sanity, IDAT
 * inflate, IEND, no trailing bytes) already lives in evidence.ts and is the repository's evidence
 * gate. This module calls it and adds what the observation lanes need on top — bit depth, the
 * separation of "valid PNG" from "meets the capture-evidence floor", MP4 container structure with
 * a MEASURED duration, and dark-frame classification behind an injectable decoder seam.
 *
 * What this module deliberately does NOT do: decide whether pixels show the right thing. A valid
 * frame is a container, not a verdict, and a DARK frame is a statement about the capture route,
 * never about whether the app rendered. Only a LOOK settles that.
 */

const MAX_DECODE_PIXELS = 32 * 1024 * 1024;
const DARK_MEAN_LUMA = 8; // out of 255

/**
 * A dark frame is evidence about the ROUTE, not about the app. Kept as one exported constant so
 * every caller says the same thing and no caller can quietly upgrade it into a verdict.
 */
export const DARK_FRAME_NOTE =
  "This frame is a structurally valid image whose pixels are (near-)black. That is INCONCLUSIVE "
  + "about the capture route: a shell/compositor capture can come back black for an immersive "
  + "layer that is drawing perfectly, and it can equally come back black when nothing is drawn. "
  + "It is not proof either way. LOOK at the frame, and capture through a second route before "
  + "assigning any cause.";

export function sha256Bytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export type FileDigest = { sha256: string; bytes: number } | { sha256: null; bytes: null; reason: string };

/** Stream a file through sha256 without holding it in memory. Reports its reason, never throws. */
export function sha256File(filePath: string): FileDigest {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return { sha256: null, bytes: null, reason: `'${filePath}' is not a regular file` };
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      total += read;
    }
    return { sha256: hash.digest("hex"), bytes: total };
  } catch (error: any) {
    return { sha256: null, bytes: null, reason: `'${filePath}' could not be hashed: ${error?.message ?? String(error)}` };
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
  }
}

// ── PNG ────────────────────────────────────────────────────────────────────────────────────────

export type PngInspection = {
  valid: boolean;
  width: number | null;
  height: number | null;
  bitDepth: number | null;
  colorType: number | null;
  bytes: number;
  sha256: string;
  /** Whether the image also clears the repository's capture-evidence floor (size and dimensions). */
  meetsCaptureFloor: boolean;
  captureFloorReason?: string;
  reason?: string;
};

/**
 * Validate a PNG container and report its header facts. Container validity and
 * evidence-worthiness are answered separately: an 8x8 PNG is a perfectly valid PNG and is not a
 * scene capture, and conflating the two is how an icon becomes "the frame I looked at".
 */
export function inspectPng(bytes: Buffer): PngInspection {
  const base = { bytes: bytes.length, sha256: sha256Bytes(bytes) };
  const structural = inspectPngStructure(bytes);
  const floor = validateCaptureBuffer(bytes, "image");
  if (!structural) {
    return {
      ...base,
      valid: false,
      width: null,
      height: null,
      bitDepth: null,
      colorType: null,
      meetsCaptureFloor: false,
      // The structure failed, so the evidence gate's reason IS the structural reason.
      reason: floor.ok ? "not a structurally complete PNG" : floor.reason!,
    };
  }
  // Safe: inspectPngStructure has already CRC-checked IHDR and proved it is the first chunk.
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  return {
    ...base,
    valid: true,
    width: structural.width,
    height: structural.height,
    bitDepth,
    colorType,
    meetsCaptureFloor: floor.ok,
    ...(floor.ok ? {} : { captureFloorReason: floor.reason }),
  };
}

// ── MP4 ────────────────────────────────────────────────────────────────────────────────────────

export type Mp4Inspection = {
  valid: boolean;
  /** Measured from the mvhd timescale/duration in the file — never a requested or advertised value. */
  durationSec: number | null;
  hasVideoTrack: boolean;
  trackCount: number | null;
  handlerTypes: string[];
  bytes: number;
  sha256: string;
  reason?: string;
};

type Box = { type: string; start: number; payloadStart: number; end: number };

/** Walk one level of ISO-BMFF boxes. Returns null (with a reason) on any inconsistency. */
function walkBoxes(bytes: Buffer, from: number, to: number): { boxes: Box[] } | { reason: string } {
  const boxes: Box[] = [];
  let offset = from;
  while (offset < to) {
    if (to - offset < 8) return { reason: `truncated box header at byte ${offset}` };
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return { reason: `invalid box type at byte ${offset}` };
    let payloadStart = offset + 8;
    if (size === 1) {
      if (to - offset < 16) return { reason: `truncated 64-bit box header at byte ${offset}` };
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return { reason: `box '${type}' declares an unrepresentable size` };
      size = Number(large);
      payloadStart = offset + 16;
    } else if (size === 0) {
      size = to - offset; // "to end of file"
    }
    if (size < payloadStart - offset) return { reason: `box '${type}' declares a size smaller than its own header` };
    const end = offset + size;
    if (end > to) return { reason: `box '${type}' is truncated: it declares ${size} bytes but only ${to - offset} remain` };
    boxes.push({ type, start: offset, payloadStart, end });
    offset = end;
  }
  if (offset !== to) return { reason: `box structure does not exactly cover bytes ${from}..${to}` };
  return { boxes };
}

function findBoxes(bytes: Buffer, parent: Box, type: string): Box[] | null {
  const walked = walkBoxes(bytes, parent.payloadStart, parent.end);
  if ("reason" in walked) return null;
  return walked.boxes.filter((b) => b.type === type);
}

/**
 * Inspect an MP4/ISO-BMFF CONTAINER. This is a structure check — box nesting that exactly covers
 * the file, `ftyp` first, `moov` and `mdat` present, the `mvhd` timescale/duration, and each
 * track's `hdlr` handler type. It decodes no video: `hasVideoTrack` means a video handler is
 * DECLARED, and `durationSec` is what the container states about itself, which is still an
 * observation of the file rather than a repetition of what was requested.
 */
export function inspectMp4(bytes: Buffer): Mp4Inspection {
  const base = { bytes: bytes.length, sha256: sha256Bytes(bytes), durationSec: null, hasVideoTrack: false, trackCount: null, handlerTypes: [] as string[] };
  const top = walkBoxes(bytes, 0, bytes.length);
  if ("reason" in top) return { ...base, valid: false, reason: top.reason };
  if (!top.boxes.length) return { ...base, valid: false, reason: "no ISO-BMFF boxes found" };
  if (top.boxes[0].type !== "ftyp") return { ...base, valid: false, reason: `first box is '${top.boxes[0].type}', not 'ftyp'` };
  const moov = top.boxes.find((b) => b.type === "moov");
  if (!moov) return { ...base, valid: false, reason: "no 'moov' box: the file declares no movie header" };
  if (!top.boxes.some((b) => b.type === "mdat")) {
    return { ...base, valid: false, reason: "no 'mdat' box: the file carries no media payload" };
  }

  const moovChildren = walkBoxes(bytes, moov.payloadStart, moov.end);
  if ("reason" in moovChildren) return { ...base, valid: false, reason: `inside 'moov': ${moovChildren.reason}` };

  let durationSec: number | null = null;
  const mvhd = moovChildren.boxes.find((b) => b.type === "mvhd");
  if (mvhd) {
    const version = bytes[mvhd.payloadStart];
    const at = mvhd.payloadStart + 4;
    if (version === 0 && mvhd.end - at >= 16) {
      const timescale = bytes.readUInt32BE(at + 8);
      const duration = bytes.readUInt32BE(at + 12);
      if (timescale > 0 && duration !== 0xffffffff) durationSec = duration / timescale;
    } else if (version === 1 && mvhd.end - at >= 28) {
      const timescale = bytes.readUInt32BE(at + 16);
      const duration = bytes.readBigUInt64BE(at + 20);
      if (timescale > 0 && duration !== 0xffffffffffffffffn) durationSec = Number(duration) / timescale;
    }
  }

  const handlerTypes: string[] = [];
  const traks = moovChildren.boxes.filter((b) => b.type === "trak");
  for (const trak of traks) {
    const mdias = findBoxes(bytes, trak, "mdia");
    if (!mdias) return { ...base, valid: false, reason: "a 'trak' box has an unreadable child structure" };
    for (const mdia of mdias) {
      const hdlrs = findBoxes(bytes, mdia, "hdlr");
      if (!hdlrs) return { ...base, valid: false, reason: "an 'mdia' box has an unreadable child structure" };
      for (const hdlr of hdlrs) {
        const at = hdlr.payloadStart + 8;
        if (hdlr.end - at >= 4) handlerTypes.push(bytes.toString("latin1", at, at + 4));
      }
    }
  }

  return {
    bytes: bytes.length,
    sha256: base.sha256,
    valid: true,
    durationSec,
    hasVideoTrack: handlerTypes.includes("vide"),
    trackCount: traks.length,
    handlerTypes,
  };
}

// ── frame classification ───────────────────────────────────────────────────────────────────────

export type DecodedFrame =
  | { ok: true; width: number; height: number; pixels: Buffer }
  | { ok: false; reason: string };
/** The decoder SEAM. Production may pass a host decoder when one exists; tests inject a fake. */
export type FrameDecoder = (bytes: Buffer) => DecodedFrame;

export type FrameClassification = {
  status: "dark" | "lit" | "undecodable" | "unvalidated";
  /** Container validity, when it was checked. null when no inspection applied to this format. */
  valid: boolean | null;
  verdict: "inconclusive-capture-route" | "frame-has-content" | "no-frame" | "unknown";
  meanLuma: number | null;
  width: number | null;
  height: number | null;
  reason: string;
  note?: string;
};

/**
 * Classify a captured frame as dark or lit, using an injected decoder when one is supplied and the
 * built-in pure-JS PNG path otherwise. When neither can read the bytes the answer is
 * `unvalidated` — explicitly "nothing decoded this", never a successful decode by default.
 */
export function classifyFrame(bytes: Buffer, decoder?: FrameDecoder): FrameClassification {
  if (decoder) {
    const decoded = decoder(bytes);
    if (!decoded.ok) {
      return { status: "unvalidated", valid: null, verdict: "unknown", meanLuma: null, width: null, height: null, reason: `the supplied decoder did not decode these bytes: ${decoded.reason}` };
    }
    const luma = meanLumaOf(decoded);
    if (luma === null) {
      return { status: "unvalidated", valid: null, verdict: "unknown", meanLuma: null, width: decoded.width, height: decoded.height, reason: "the supplied decoder returned a raster that does not match its own declared dimensions" };
    }
    return finish(true, luma, decoded.width, decoded.height, "decoded by the supplied decoder");
  }

  const png = inspectPng(bytes);
  if (!png.valid) {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { status: "undecodable", valid: false, verdict: "no-frame", meanLuma: null, width: null, height: null, reason: `not a decodable image: ${png.reason}` };
    }
    return { status: "unvalidated", valid: false, verdict: "unknown", meanLuma: null, width: null, height: null, reason: "no decoder was supplied and these bytes are not a PNG, the only format this module decodes on its own" };
  }
  const decoded = decodePngRaster(bytes, png);
  if (!decoded.ok) {
    return { status: "unvalidated", valid: true, verdict: "unknown", meanLuma: null, width: png.width, height: png.height, reason: `no decoder was supplied and the built-in decoder does not cover this PNG variant: ${decoded.reason}` };
  }
  const luma = meanLumaOf(decoded);
  if (luma === null) {
    return { status: "unvalidated", valid: true, verdict: "unknown", meanLuma: null, width: png.width, height: png.height, reason: "the built-in decoder produced a raster inconsistent with the header" };
  }
  return finish(true, luma, decoded.width, decoded.height, "decoded by the built-in PNG path");
}

function finish(valid: boolean, meanLuma: number, width: number, height: number, how: string): FrameClassification {
  const dark = meanLuma < DARK_MEAN_LUMA;
  return {
    status: dark ? "dark" : "lit",
    valid,
    verdict: dark ? "inconclusive-capture-route" : "frame-has-content",
    meanLuma,
    width,
    height,
    reason: `${how}; mean luma ${meanLuma.toFixed(2)} of 255 (dark below ${DARK_MEAN_LUMA})`,
    ...(dark ? { note: DARK_FRAME_NOTE } : {}),
  };
}

function meanLumaOf(decoded: { width: number; height: number; pixels: Buffer }): number | null {
  const pixelCount = decoded.width * decoded.height;
  if (pixelCount <= 0) return null;
  const channels = decoded.pixels.length / pixelCount;
  if (!Number.isInteger(channels) || ![1, 3, 4].includes(channels)) return null;
  let total = 0;
  for (let i = 0; i < decoded.pixels.length; i += channels) {
    total += channels === 1
      ? decoded.pixels[i]
      : 0.2126 * decoded.pixels[i] + 0.7152 * decoded.pixels[i + 1] + 0.0722 * decoded.pixels[i + 2];
  }
  return total / pixelCount;
}

/**
 * The built-in PNG raster decode: non-interlaced, bit depth 8 or 16, colour types 0/2/4/6. Every
 * variant outside that (palette, interlace, oversized) is reported as "not covered", which becomes
 * `unvalidated` — the honest answer, never a guess.
 */
function decodePngRaster(
  bytes: Buffer,
  header: PngInspection,
): { ok: true; width: number; height: number; pixels: Buffer } | { ok: false; reason: string } {
  const width = header.width!;
  const height = header.height!;
  const bitDepth = header.bitDepth!;
  const colorType = header.colorType!;
  if (bytes[28] !== 0) return { ok: false, reason: "interlaced PNG" };
  if (bitDepth !== 8 && bitDepth !== 16) return { ok: false, reason: `bit depth ${bitDepth}` };
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) return { ok: false, reason: `colour type ${colorType}` };
  if (width * height > MAX_DECODE_PIXELS) return { ok: false, reason: `${width}x${height} exceeds the bounded decode limit` };

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset = offset + 12 + length;
  }
  const bytesPerPixel = (channels * bitDepth) / 8;
  const rowBytes = width * bytesPerPixel;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: height * (1 + rowBytes) + 1 });
  } catch (error: any) {
    return { ok: false, reason: `IDAT did not inflate: ${error?.message ?? String(error)}` };
  }
  if (raw.length !== height * (1 + rowBytes)) return { ok: false, reason: "raster length does not match the header" };

  const out = Buffer.allocUnsafe(height * rowBytes);
  let previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + rowBytes)];
    const row = Buffer.from(raw.subarray(y * (1 + rowBytes) + 1, (y + 1) * (1 + rowBytes)));
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const b = previous[x];
      const c = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      switch (filter) {
        case 0: break;
        case 1: row[x] = (row[x] + a) & 0xff; break;
        case 2: row[x] = (row[x] + b) & 0xff; break;
        case 3: row[x] = (row[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: return { ok: false, reason: `unknown filter byte ${filter}` };
      }
    }
    row.copy(out, y * rowBytes);
    previous = row;
  }

  // Collapse to 8-bit samples and drop alpha, so meanLumaOf sees 1 or 3 channels.
  const sampleStride = bitDepth === 16 ? 2 : 1;
  const colorChannels = colorType === 0 || colorType === 4 ? 1 : 3;
  const pixels = Buffer.allocUnsafe(width * height * colorChannels);
  let write = 0;
  for (let i = 0; i < width * height; i++) {
    const pixelStart = i * bytesPerPixel;
    for (let c = 0; c < colorChannels; c++) pixels[write++] = out[pixelStart + c * sampleStride];
  }
  return { ok: true, width, height, pixels };
}
