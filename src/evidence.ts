import fs from "node:fs";
import crypto from "node:crypto";

/**
 * evidence.ts — the honesty PRIMITIVE (v6.1). A `vision_verified` claim must link a capture that is
 * actually a RENDERED IMAGE, not merely a path that resolves. The prior gate only checked
 * fs.existsSync(artifactPath) — so a .txt file, /etc/hosts, a 0-byte file, or a directory all passed as
 * "the frame I LOOKED at" (proven live in ADVERSARIAL_FINDINGS.md C1). This module validates that the
 * artifact is a real PNG/JPEG with real dimensions, and returns a content sha256 for provenance + reuse
 * detection (the same frame linked to many claims is a red flag). It CANNOT prove the frame shows the
 * right thing — that is the calibrated visual judge's job — but it makes the trivial spoofs impossible.
 *
 * Pure Node (fs + crypto), no image library: PNG dims come from the IHDR chunk, JPEG dims from the SOF
 * marker. This keeps the validator dependency-free and deterministic.
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

// The PNG/JPEG header + dimension checks are the PRIMARY gate (a valid header guarantees a real raster
// image). MIN_BYTES only guards against 0-byte / truncated files, so it is the true smallest-valid-PNG
// floor — a higher, capture-sized floor would false-reject legitimately small images, and the proven
// spoofs (text/hosts/empty/dir) already fail on magic-bytes/not-a-file, not on size.
const MIN_BYTES = 67;
const MIN_DIM = 64; // a scene capture is not a 16×16 icon

/** Parse PNG width/height from the IHDR chunk (first chunk after the 8-byte signature). */
export function inspectPng(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Parse JPEG width/height from the first Start-Of-Frame marker. */
export function inspectJpeg(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    // SOF0..SOF15, excluding DHT(0xc4), JPG(0xc8), DAC(0xcc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    if (off + 3 >= buf.length) break;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) break;
    off += 2 + len;
  }
  return null;
}

/**
 * Validate that `p` is a real, non-trivial raster image. Returns { ok, reason } on failure; on success
 * also returns format/width/height/bytes/sha256 (the ledger records these for provenance + reuse checks).
 */
export function validateCaptureBuffer(buf: Buffer, label = "capture", opts: { minBytes?: number } = {}): CaptureCheck {
  const minBytes = opts.minBytes ?? MIN_BYTES;
  if (buf.length < minBytes) return { ok: false, reason: `artifact '${label}' is only ${buf.length} bytes — too small to be a real capture` };
  let dim = inspectPng(buf);
  let format: "png" | "jpeg" = "png";
  if (!dim) { dim = inspectJpeg(buf); format = "jpeg"; }
  if (!dim) return { ok: false, reason: `artifact '${label}' is not a valid PNG/JPEG image (bad header/magic bytes) — a vision_verified claim must link a real rendered frame` };
  if (dim.width < MIN_DIM || dim.height < MIN_DIM) return { ok: false, reason: `artifact '${label}' is ${dim.width}×${dim.height} — too small to be a scene capture` };
  return { ok: true, format, width: dim.width, height: dim.height, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}

export function validateCapture(p: string | undefined, opts: { minBytes?: number } = {}): CaptureCheck {
  if (!p || !p.trim()) return { ok: false, reason: "no artifactPath supplied" };
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return { ok: false, reason: `artifact '${p}' does not exist` };
  }
  if (st.isDirectory()) return { ok: false, reason: `artifact '${p}' is a directory, not an image` };
  if (!st.isFile()) return { ok: false, reason: `artifact '${p}' is not a regular file` };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch (error: any) {
    return { ok: false, reason: `artifact '${p}' could not be read: ${error?.message ?? String(error)}` };
  }
  return validateCaptureBuffer(buf, p, opts);
}

/** Pull the first plausible image path out of a free-text evidence string (legacy capability_report). */
export function extractImagePath(evidence: string | undefined): string | undefined {
  if (!evidence) return undefined;
  const m = evidence.match(/(\/[^\s"']+\.(?:png|jpg|jpeg))/i) || evidence.match(/([~.][^\s"']*\.(?:png|jpg|jpeg))/i);
  return m ? m[1] : undefined;
}
