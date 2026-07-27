// v29.2 materializer. The ONLY module that writes transport frames to disk, so
// src/vcamtransport.ts can stay filesystem-free and keep its purity gate.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FRAME_BYTES = 1280 * 720 * 4;
const MAXIMUM_FRAMES = 16;

type MaterializableFrame = { counter: number; pixels: Buffer; sha256: string };
type MaterializableSequence = { frames: MaterializableFrame[]; manifestJson: string; manifestSha256: string };

const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export function materializeSequence(
  sequence: MaterializableSequence,
  targetDir: string,
): { manifestPath: string; manifestSha256: string; framePaths: string[] } {
  if (!path.isAbsolute(targetDir)) throw new Error("materialize target directory must be an absolute path");
  if (!Array.isArray(sequence?.frames) || sequence.frames.length < 1 || sequence.frames.length > MAXIMUM_FRAMES) {
    throw new Error(`sequence must contain 1-16 frames; the native writer caps at ${MAXIMUM_FRAMES}`);
  }
  if (typeof sequence.manifestJson !== "string" || !/^[0-9a-f]{64}$/.test(sequence.manifestSha256 ?? "")) {
    throw new Error("sequence must carry manifestJson and a 64 lowercase hex manifestSha256");
  }

  // Validate EVERYTHING before writing anything, so a rejection leaves no partial output.
  sequence.frames.forEach((frame, index) => {
    if (!Buffer.isBuffer(frame.pixels) || frame.pixels.length !== FRAME_BYTES) {
      throw new Error(`frame ${index} must be exactly ${FRAME_BYTES} bytes`);
    }
    if (hash(frame.pixels) !== frame.sha256) throw new Error(`frame ${index} sha256 does not match its pixels`);
  });
  if (hash(Buffer.from(sequence.manifestJson, "utf8")) !== sequence.manifestSha256) {
    throw new Error("manifestSha256 does not match manifestJson");
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const manifestPath = path.join(targetDir, "manifest.json");
  if (fs.existsSync(manifestPath)) throw new Error(`manifest already exists, refusing to overwrite: ${manifestPath}`);

  // Frames FIRST, manifest LAST. The native writer hashes the manifest and then trusts the sibling
  // names, so a crash between the two leaves a manifest-less frame set — safe. The reverse order
  // would be a live TOCTOU on those names. Index is ARRAY POSITION, never the counter value.
  const framePaths: string[] = [];
  sequence.frames.forEach((frame, index) => {
    const framePath = path.join(targetDir, `frame-${String(index).padStart(3, "0")}.bgra`);
    if (fs.existsSync(framePath)) throw new Error(`frame already exists, refusing to overwrite: ${framePath}`);
    fs.writeFileSync(framePath, frame.pixels, { flag: "wx" });
    framePaths.push(framePath);
  });
  fs.writeFileSync(manifestPath, sequence.manifestJson, { flag: "wx" });

  return { manifestPath, manifestSha256: sequence.manifestSha256, framePaths };
}
