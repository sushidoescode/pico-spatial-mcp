import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const CARD_WIDTH = 1280;
const CARD_HEIGHT = 720;
const CARD_PIXEL_FORMAT = "BGRA";
const COUNTER_REGION = Object.freeze({ x: 960, y: 480, width: 256, height: 160 } as const);
const STDERR_LIMIT = 64 * 1024;
const WEBCAM_LIST_HEADER = "List of web cameras connected to the computer:";
const UUID_PATTERN = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
const REQUIRED_DEVICE_NAME = "Immersed Camera";

type Bgra = readonly [number, number, number, 255];

export type TestCardFrame = {
  counter: number;
  width: number;
  height: number;
  pixelFormat: "BGRA";
  pixels: Buffer;
  sha256: string;
};

export type TestCardManifest = {
  schemaVersion: 1;
  kind: "pico-vcam-test-card-sequence";
  nonce: string;
  width: number;
  height: number;
  pixelFormat: "BGRA";
  frameBytes: number;
  counterRegion: typeof COUNTER_REGION;
  frames: Array<{ counter: number; bytes: number; sha256: string }>;
};

const GLYPHS: Record<string, readonly string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fillRect(
  pixels: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: Bgra,
): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + rectWidth));
  const bottom = Math.min(height, Math.ceil(y + rectHeight));
  for (let py = top; py < bottom; py += 1) {
    let offset = (py * width + left) * 4;
    for (let px = left; px < right; px += 1) {
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
      offset += 4;
    }
  }
}

function drawText(
  pixels: Buffer,
  width: number,
  height: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Bgra,
): void {
  let cursor = x;
  for (const raw of text) {
    const glyph = GLYPHS[raw.toUpperCase()] ?? ["11111", "10001", "00110", "00100", "00110", "10001", "11111"];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === "1") {
          fillRect(pixels, width, height, cursor + column * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    if (raw >= "a" && raw <= "z") {
      fillRect(pixels, width, height, cursor + 5 * scale, y + 6 * scale, scale, scale, color);
    }
    cursor += 6 * scale;
  }
}

function drawNonceBytes(
  pixels: Buffer,
  nonce: string,
  x: number,
  y: number,
  zero: Bgra,
  one: Bgra,
): void {
  const cellSize = 4;
  for (let index = 0; index < nonce.length; index += 1) {
    const byte = nonce.charCodeAt(index);
    for (let bit = 0; bit < 8; bit += 1) {
      fillRect(
        pixels,
        CARD_WIDTH,
        CARD_HEIGHT,
        x + index * cellSize,
        y + bit * cellSize,
        cellSize,
        cellSize,
        (byte & (1 << (7 - bit))) === 0 ? zero : one,
      );
    }
  }
}

function makeCard(nonce: string, counter: number): Buffer {
  const pixels = Buffer.alloc(CARD_WIDTH * CARD_HEIGHT * 4);
  const bars: Bgra[] = [
    [255, 255, 255, 255],
    [0, 255, 255, 255],
    [255, 255, 0, 255],
    [0, 255, 0, 255],
    [255, 0, 255, 255],
    [0, 0, 255, 255],
    [255, 0, 0, 255],
    [0, 0, 0, 255],
  ];
  const barWidth = CARD_WIDTH / bars.length;
  bars.forEach((color, index) => fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, index * barWidth, 0, barWidth, CARD_HEIGHT, color));

  const black: Bgra = [0, 0, 0, 255];
  const white: Bgra = [255, 255, 255, 255];
  const yellow: Bgra = [0, 255, 255, 255];
  const blue: Bgra = [255, 0, 0, 255];
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, 48, 196, 1184, 240, black);
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, 64, 212, 1152, 208, white);
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, 76, 224, 1128, 184, black);
  drawText(pixels, CARD_WIDTH, CARD_HEIGHT, "PICO VCAM", 108, 246, 9, yellow);
  const needsByteColumns = /[a-z]/.test(nonce) || nonce.length > 35;
  const nonceScale = needsByteColumns
    ? Math.max(2, Math.min(5, Math.floor(1060 / (6 * nonce.length))))
    : 5;
  drawText(pixels, CARD_WIDTH, CARD_HEIGHT, nonce, 108, 338, nonceScale, white);
  // Fixed-width byte columns make every accepted ASCII byte visible, including case and the
  // final byte of a maximum-length nonce. Zero bits are colored so a suffix cannot disappear
  // into unused black space.
  if (needsByteColumns) drawNonceBytes(pixels, nonce, 108, 376, blue, yellow);

  // The only counter-dependent pixels live in this fixed region. That makes changing-frame
  // provenance mechanically distinguishable from animation, clock, or encoder drift elsewhere.
  fillRect(
    pixels,
    CARD_WIDTH,
    CARD_HEIGHT,
    COUNTER_REGION.x,
    COUNTER_REGION.y,
    COUNTER_REGION.width,
    COUNTER_REGION.height,
    black,
  );
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, COUNTER_REGION.x + 8, COUNTER_REGION.y + 8, 240, 144, white);
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, COUNTER_REGION.x + 16, COUNTER_REGION.y + 16, 224, 128, black);
  drawText(pixels, CARD_WIDTH, CARD_HEIGHT, "FRAME", COUNTER_REGION.x + 28, COUNTER_REGION.y + 25, 5, yellow);
  drawText(
    pixels,
    CARD_WIDTH,
    CARD_HEIGHT,
    String(counter).padStart(6, "0"),
    COUNTER_REGION.x + 38,
    COUNTER_REGION.y + 76,
    5,
    white,
  );
  return pixels;
}

export function createTestCardSequence(options: {
  nonce: string;
  counters: number[];
  width: number;
  height: number;
  pixelFormat: string;
}): {
  frames: TestCardFrame[];
  manifest: TestCardManifest;
  manifestJson: string;
  manifestSha256: string;
} {
  if (options.width !== CARD_WIDTH || options.height !== CARD_HEIGHT || options.pixelFormat !== CARD_PIXEL_FORMAT) {
    throw new Error("test cards require exact 1280x720 BGRA output");
  }
  if (typeof options.nonce !== "string" || options.nonce.length < 1 || options.nonce.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(options.nonce)) {
    throw new Error("nonce must be 1-64 ASCII letters, digits, dot, underscore, colon, or hyphen");
  }
  if (!Array.isArray(options.counters) || options.counters.length < 1 || options.counters.length > 16) {
    throw new Error("counters must contain 1-16 values");
  }
  const seen = new Set<number>();
  for (const counter of options.counters) {
    if (!Number.isSafeInteger(counter) || counter < 0 || counter > 999_999 || seen.has(counter)) {
      throw new Error("counters must be unique safe nonnegative integers no greater than 999999");
    }
    seen.add(counter);
  }

  const frames = options.counters.map((counter): TestCardFrame => {
    const pixels = makeCard(options.nonce, counter);
    return {
      counter,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      pixelFormat: CARD_PIXEL_FORMAT,
      pixels,
      sha256: hash(pixels),
    };
  });
  const manifest: TestCardManifest = {
    schemaVersion: 1,
    kind: "pico-vcam-test-card-sequence",
    nonce: options.nonce,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    pixelFormat: CARD_PIXEL_FORMAT,
    frameBytes: CARD_WIDTH * CARD_HEIGHT * 4,
    counterRegion: COUNTER_REGION,
    frames: frames.map((frame) => ({ counter: frame.counter, bytes: frame.pixels.length, sha256: frame.sha256 })),
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  return { frames, manifest, manifestJson, manifestSha256: hash(manifestJson) };
}

export type FixedPoseProvenance = {
  worldModel: { splatPath: string; splatSha256: string; offsetApplied: [number, number, number] };
  pose: { position: [number, number, number]; target: [number, number, number]; frame: "app" };
  intrinsics: { f: number; cx: number; cy: number; fovDeg: number };
  renderer: { script: string; scriptSha256: string; pointsRendered: number };
  baseFrameSha256: string;
};

export type FixedPoseManifest = {
  schemaVersion: 1;
  kind: "pico-vcam-fixed-pose-sequence";
  nonce: string;
  width: number;
  height: number;
  pixelFormat: "BGRA";
  frameBytes: number;
  counterRegion: typeof COUNTER_REGION;
  provenance: FixedPoseProvenance;
  frames: Array<{ counter: number; bytes: number; sha256: string }>;
};

const SHA256_TEXT = /^[0-9a-f]{64}$/;

function assertVec3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(`provenance ${label} must be exactly three finite numbers`);
  }
  return [value[0], value[1], value[2]];
}

function validateFixedPoseProvenance(provenance: FixedPoseProvenance): void {
  if (!provenance || typeof provenance !== "object") throw new Error("provenance is required");
  const { worldModel, pose, intrinsics, renderer, baseFrameSha256 } = provenance;
  if (!worldModel?.splatPath?.startsWith("/")) throw new Error("provenance worldModel.splatPath must be absolute");
  if (!SHA256_TEXT.test(worldModel?.splatSha256 ?? "")) throw new Error("provenance worldModel.splatSha256 must be 64 lowercase hex");
  assertVec3(worldModel?.offsetApplied, "worldModel.offsetApplied");
  assertVec3(pose?.position, "pose.position");
  // target is the single canonical orientation encoding: it is what the renderer consumes and it
  // needs no trig to re-verify. yaw/pitch are rejected so the native validator stays a flat check.
  if ((pose as any)?.yawDeg !== undefined || (pose as any)?.pitchDeg !== undefined) {
    throw new Error("provenance pose must use target, not yawDeg/pitchDeg");
  }
  assertVec3(pose?.target, "pose.target");
  if (pose?.frame !== "app") throw new Error('provenance pose.frame must be exactly "app"');
  for (const key of ["f", "cx", "cy", "fovDeg"] as const) {
    const value = intrinsics?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`provenance intrinsics.${key} must be a positive finite number`);
    }
  }
  if (!renderer?.script?.startsWith("/")) throw new Error("provenance renderer.script must be absolute");
  if (!SHA256_TEXT.test(renderer?.scriptSha256 ?? "")) throw new Error("provenance renderer.scriptSha256 must be 64 lowercase hex");
  if (!Number.isSafeInteger(renderer?.pointsRendered) || renderer.pointsRendered < 0) {
    throw new Error("provenance renderer.pointsRendered must be a nonnegative integer");
  }
  if (!SHA256_TEXT.test(baseFrameSha256 ?? "")) throw new Error("provenance baseFrameSha256 must be 64 lowercase hex");
}

export function stampFrame(basePixels: Buffer, options: { nonce: string; counter: number }): Buffer {
  if (!Buffer.isBuffer(basePixels) || basePixels.length !== CARD_WIDTH * CARD_HEIGHT * 4) {
    throw new Error("stampFrame requires an exact 1280x720 BGRA buffer");
  }
  const pixels = Buffer.from(basePixels);
  const black: Bgra = [0, 0, 0, 255];
  const white: Bgra = [255, 255, 255, 255];
  const yellow: Bgra = [0, 255, 255, 255];

  // The nonce sits over photographic content, so it supplies its own opaque plaque. The card gets
  // contrast from its black background; a room does not.
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, 48, 40, 1184, 96, black);
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, 60, 52, 1160, 72, white);
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, 72, 64, 1136, 48, black);
  drawText(pixels, CARD_WIDTH, CARD_HEIGHT, options.nonce, 88, 72, 5, yellow);

  // Counter panel. Identical geometry to the card so the native counterRegion bounds check and the
  // boundary report's changing-frame rule apply unchanged.
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, COUNTER_REGION.x, COUNTER_REGION.y, COUNTER_REGION.width, COUNTER_REGION.height, black);
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, COUNTER_REGION.x + 8, COUNTER_REGION.y + 8, 240, 144, white);
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, COUNTER_REGION.x + 16, COUNTER_REGION.y + 16, 224, 128, black);
  drawText(pixels, CARD_WIDTH, CARD_HEIGHT, "FRAME", COUNTER_REGION.x + 28, COUNTER_REGION.y + 25, 5, yellow);
  drawText(pixels, CARD_WIDTH, CARD_HEIGHT, String(options.counter).padStart(6, "0"), COUNTER_REGION.x + 38, COUNTER_REGION.y + 76, 5, white);

  // Digits alone are too weak over a photograph: the card's worst adjacent pair changes only 75
  // pixels. A counter-proportional bar supplies the large, obvious-at-a-glance delta a photograph
  // needs — but the digit run just above (COUNTER_REGION.x+38..+218, COUNTER_REGION.y+76..+111) is
  // the only human-legible readout of which counter this frame is, and an operator comparing two
  // captures must be able to both read the counter AND see an obvious difference. A pixel-count
  // proxy for "obvious difference" must never be bought by destroying "readable" — an earlier
  // version of this bar (224x100 starting at y+60) did exactly that: it fully overdrew the digit
  // row, so the operator could tell two frames apart but not tell WHICH counters they were. The bar
  // now lives in the free strip below the digit row instead: a 5px gap under the digits' y+111
  // bottom, ending with a 4px margin above the region's own y+160 bottom, and it runs across nearly
  // the full region width (not just the inner plaque's 224px) to keep the delta as large as this
  // constrained geometry allows without touching "FRAME" (ends y+60) or the digits (y+76..+111).
  const barTrack = 240;
  const barHeight = 40;
  const barX = COUNTER_REGION.x + 8;
  const barY = COUNTER_REGION.y + 116;
  const barWidth = 8 + ((options.counter % 16) * (barTrack - 8)) / 15;
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, barX, barY, barTrack, barHeight, black);
  fillRect(pixels, CARD_WIDTH, CARD_HEIGHT, barX, barY, barWidth, barHeight, yellow);
  return pixels;
}

export function createFixedPoseSequence(options: {
  basePixels: Buffer;
  nonce: string;
  counters: number[];
  width: number;
  height: number;
  pixelFormat: string;
  provenance: FixedPoseProvenance;
}): { frames: TestCardFrame[]; manifest: FixedPoseManifest; manifestJson: string; manifestSha256: string } {
  if (options.width !== CARD_WIDTH || options.height !== CARD_HEIGHT || options.pixelFormat !== CARD_PIXEL_FORMAT) {
    throw new Error("fixed-pose frames require exact 1280x720 BGRA output");
  }
  if (typeof options.nonce !== "string" || options.nonce.length < 1 || options.nonce.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(options.nonce)) {
    throw new Error("nonce must be 1-64 ASCII letters, digits, dot, underscore, colon, or hyphen");
  }
  if (!Array.isArray(options.counters) || options.counters.length < 1 || options.counters.length > 16) {
    throw new Error("counters must contain 1-16 values");
  }
  const seen = new Set<number>();
  for (const counter of options.counters) {
    if (!Number.isSafeInteger(counter) || counter < 0 || counter > 999_999 || seen.has(counter)) {
      throw new Error("counters must be unique safe nonnegative integers no greater than 999999");
    }
    seen.add(counter);
  }
  validateFixedPoseProvenance(options.provenance);

  const frames = options.counters.map((counter): TestCardFrame => {
    const pixels = stampFrame(options.basePixels, { nonce: options.nonce, counter });
    return { counter, width: CARD_WIDTH, height: CARD_HEIGHT, pixelFormat: CARD_PIXEL_FORMAT, pixels, sha256: hash(pixels) };
  });
  const manifest: FixedPoseManifest = {
    schemaVersion: 1,
    kind: "pico-vcam-fixed-pose-sequence",
    nonce: options.nonce,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    pixelFormat: CARD_PIXEL_FORMAT,
    frameBytes: CARD_WIDTH * CARD_HEIGHT * 4,
    counterRegion: COUNTER_REGION,
    provenance: options.provenance,
    frames: frames.map((frame) => ({ counter: frame.counter, bytes: frame.pixels.length, sha256: frame.sha256 })),
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  return { frames, manifest, manifestJson, manifestSha256: hash(manifestJson) };
}

export type EmulatorWebcam = {
  route: string;
  uuid: string;
  channel: number;
  pixelFormat: string;
};

function normalizeUuid(uuid: string): string {
  return uuid.toUpperCase();
}

export function parseEmulatorWebcamList(stdout: string): EmulatorWebcam[] {
  if (typeof stdout !== "string") {
    throw new Error("malformed webcam list: missing header");
  }
  const webcams: EmulatorWebcam[] = [];
  let sawHeader = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === WEBCAM_LIST_HEADER) {
      if (sawHeader || webcams.length > 0) throw new Error("malformed webcam list: duplicate or misplaced header");
      sawHeader = true;
      continue;
    }
    if (!sawHeader) throw new Error("malformed webcam list: missing exact header before camera records");
    const match = line.match(/^\s*Camera '(webcam[0-9]+)' is connected to device '([^']+)' on channel ([0-9]+) using pixel format '([^']+)'\s*$/);
    if (!match) throw new Error(`malformed or unrecognized camera line: ${line.trim()}`);
    const parsed = { route: match[1], uuid: match[2], channel: Number(match[3]), pixelFormat: match[4] };
    if (!UUID_PATTERN.test(parsed.uuid)) throw new Error(`malformed camera UUID: ${parsed.uuid}`);
    if (!Number.isSafeInteger(parsed.channel) || parsed.channel < 0) {
      throw new Error(`malformed camera channel: ${match[3]}`);
    }
    if (!/^[A-Za-z0-9]{1,16}$/.test(parsed.pixelFormat)) {
      throw new Error(`malformed camera pixel format: ${parsed.pixelFormat}`);
    }
    if (webcams.some((camera) => camera.route === parsed.route)) {
      throw new Error(`duplicate or ambiguous webcam route: ${parsed.route}`);
    }
    webcams.push(parsed);
  }
  if (!sawHeader) throw new Error("malformed webcam list: missing header");
  return webcams;
}

export function resolvePostStartWebcam(options: {
  webcams: EmulatorWebcam[];
  hostDevices: Array<{ name: string; uuid: string }>;
  target: { name: string; uuid: string };
  producerStartedAtMs: number;
  observedAtMs: number;
}): EmulatorWebcam & { name: string; observedAtMs: number } {
  if (!Number.isFinite(options.producerStartedAtMs) || !Number.isFinite(options.observedAtMs) || options.observedAtMs <= options.producerStartedAtMs) {
    throw new Error("webcam mapping is stale: observation must be strictly post-start");
  }
  if (!options.target?.name || !UUID_PATTERN.test(options.target?.uuid ?? "")) {
    throw new Error("target camera name and valid UUID are required");
  }
  const targetUuid = normalizeUuid(options.target.uuid);
  if (!Array.isArray(options.webcams) || !Array.isArray(options.hostDevices)) {
    throw new Error("webcam and host-device records are required");
  }
  const routes = new Set<string>();
  for (const camera of options.webcams) {
    if (!/^webcam[0-9]+$/.test(camera?.route ?? "") || !UUID_PATTERN.test(camera?.uuid ?? "") ||
        !Number.isSafeInteger(camera?.channel) || camera.channel < 0 ||
        !/^[A-Za-z0-9]{1,16}$/.test(camera?.pixelFormat ?? "")) {
      throw new Error("malformed pre-parsed webcam record");
    }
    if (routes.has(camera.route)) throw new Error(`duplicate or ambiguous webcam route: ${camera.route}`);
    routes.add(camera.route);
  }
  for (const device of options.hostDevices) {
    if (!device?.name || !UUID_PATTERN.test(device?.uuid ?? "")) {
      throw new Error("malformed host camera identity record");
    }
  }

  const relatedHostRecords = options.hostDevices.filter(
    (device) => device.name === options.target.name || normalizeUuid(device.uuid) === targetUuid,
  );
  const exactHostRecords = relatedHostRecords.filter(
    (device) => device.name === options.target.name && normalizeUuid(device.uuid) === targetUuid,
  );
  if (relatedHostRecords.length !== 1 || exactHostRecords.length !== 1) {
    throw new Error("ambiguous or changed host camera identity: exact name+UUID pair required once");
  }

  const matches = options.webcams.filter((camera) => normalizeUuid(camera.uuid) === targetUuid);
  if (matches.length === 0) throw new Error(`target webcam UUID not found: ${options.target.uuid}`);
  if (matches.length !== 1) throw new Error(`ambiguous duplicate webcam UUID: ${options.target.uuid}`);
  return { ...matches[0], name: options.target.name, observedAtMs: options.observedAtMs };
}

export type ProducerPlan = {
  executable: string;
  argv: string[];
  deviceName: string;
  expectedReady: {
    deviceUid: string;
    width: 1280;
    height: 720;
    pixelFormat: "BGRA";
    manifestSha256: string;
  };
  shell: false;
};

export function createProducerPlan(options: {
  executable: string;
  deviceName: string;
  deviceUid: string;
  manifestPath: string;
  expectedManifestSha256: string;
  width: number;
  height: number;
  pixelFormat: string;
}): ProducerPlan {
  if (typeof options.executable !== "string" || !path.isAbsolute(options.executable)) {
    throw new Error("producer executable must be an absolute path");
  }
  if (typeof options.manifestPath !== "string" || !path.isAbsolute(options.manifestPath)) {
    throw new Error("producer manifest must be an absolute path");
  }
  if (!/^[0-9a-f]{64}$/.test(options.expectedManifestSha256 ?? "")) {
    throw new Error("producer expected manifest SHA-256 must be exactly 64 lowercase hex characters");
  }
  if (options.deviceName !== REQUIRED_DEVICE_NAME) {
    throw new Error(`producer device name must be exactly ${REQUIRED_DEVICE_NAME}`);
  }
  if (!UUID_PATTERN.test(options.deviceUid ?? "")) {
    throw new Error("producer device UID must be a UUID");
  }
  if (options.width !== CARD_WIDTH || options.height !== CARD_HEIGHT || options.pixelFormat !== CARD_PIXEL_FORMAT) {
    throw new Error("producer requires exact 1280x720 BGRA format");
  }
  const deviceUid = normalizeUuid(options.deviceUid);
  return {
    executable: options.executable,
    argv: [
      "--device-uid", deviceUid,
      "--width", String(options.width),
      "--height", String(options.height),
      "--pixel-format", options.pixelFormat,
      "--manifest", options.manifestPath,
      "--expected-manifest-sha256", options.expectedManifestSha256,
    ],
    deviceName: REQUIRED_DEVICE_NAME,
    expectedReady: {
      deviceUid,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      pixelFormat: CARD_PIXEL_FORMAT,
      manifestSha256: options.expectedManifestSha256,
    },
    shell: false,
  };
}

type ProducerChild = {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | string | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: string, listener: (...args: any[]) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
};

type SpawnProducer = (
  executable: string,
  argv: string[],
  options: { shell: false; stdio: ["ignore", "pipe", "pipe"] },
) => ProducerChild;

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${name} must be a positive finite number`);
  return resolved;
}

function exited(child: ProducerChild): boolean {
  return child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined;
}

function waitForExit(child: ProducerChild, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (didExit: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("exit", onExit);
      child.removeListener?.("close", onExit);
      resolve(didExit);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    child.once("close", onExit);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function stopProducer(child: ProducerChild, timeoutMs: number): Promise<void> {
  if (exited(child)) return;
  const termWait = waitForExit(child, timeoutMs);
  let termError: unknown;
  try {
    child.kill("SIGTERM");
  } catch (error) {
    termError = error;
  }
  if (await termWait) return;
  const killWait = waitForExit(child, timeoutMs);
  let killError: unknown;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    killError = error;
  }
  if (await killWait || exited(child)) return;
  throw new Error("producer did not exit after bounded SIGKILL teardown", {
    cause: killError ?? termError,
  });
}

function appendTail(current: Buffer, chunk: unknown): Buffer {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (incoming.length >= STDERR_LIMIT) {
    return Buffer.from(incoming.subarray(incoming.length - STDERR_LIMIT));
  }
  const retainedCurrent = current.length + incoming.length <= STDERR_LIMIT
    ? current
    : current.subarray(current.length - (STDERR_LIMIT - incoming.length));
  return Buffer.concat([retainedCurrent, incoming]);
}

function observeSettlementWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(() => finish(true), () => finish(true));
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function awaitReady(
  child: ProducerChild,
  expected: ProducerPlan["expectedReady"],
  timeoutMs: number,
  stderr: () => string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!child.stdout || !child.stderr) {
      reject(new Error("producer must expose piped stdout and stderr"));
      return;
    }
    let settled = false;
    let stdout = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.removeListener?.("data", onData);
      child.stdout?.removeListener?.("error", onStdoutError);
      child.stderr?.removeListener?.("error", onStderrError);
      child.removeListener?.("error", onError);
      child.removeListener?.("close", onExit);
    };
    const finish = (error?: Error, ready?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(ready!);
    };
    const validateReady = (ready: Record<string, unknown>): Error | null => {
      for (const [key, value] of Object.entries(expected)) {
        if (ready[key] !== value) return new Error(`producer readiness ${key} mismatch: expected ${value}, got ${String(ready[key])}`);
      }
      return null;
    };
    const onData = (chunk: unknown) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (stdout.length > 1024 * 1024) return finish(new Error("producer readiness output exceeded 1 MiB"));
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let event: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return finish(new Error(`producer emitted non-object readiness JSON: ${line.slice(0, 200)}`));
          }
          event = parsed as Record<string, unknown>;
        } catch {
          return finish(new Error(`producer emitted malformed readiness JSON: ${line.slice(0, 200)}`));
        }
        if (event.event !== "ready") continue;
        const mismatch = validateReady(event);
        return finish(mismatch ?? undefined, mismatch ? undefined : event);
      }
    };
    const onError = (error: Error) => finish(new Error(`producer spawn failed before ready: ${error.message}`));
    const onStdoutError = (error: Error) => finish(new Error(`producer stdout stream error before ready: ${error.message}`));
    const onStderrError = (error: Error) => finish(new Error(`producer stderr stream error before ready: ${error.message}`));
    const onExit = (code: number | null, signal: string | null) => {
      const detail = stderr().trim();
      finish(new Error(`producer exited before ready (code ${String(code)}, signal ${String(signal)}); stderr: ${detail || "<empty>"}`));
    };
    child.stdout.on("data", onData);
    child.stdout.on("error", onStdoutError);
    child.stderr.on("error", onStderrError);
    child.on("error", onError);
    // ChildProcess `close` follows process exit and stdio closure, so retained diagnostics include
    // trailing native stderr that is not guaranteed to have arrived at the earlier `exit` event.
    child.once("close", onExit);
    const timer = setTimeout(() => finish(new Error(`producer readiness timed out after ${timeoutMs}ms`)), timeoutMs);
  });
}

export async function withProducer<T>(
  plan: ProducerPlan,
  options: {
    dryRun?: boolean;
    spawn?: SpawnProducer;
    startupTimeoutMs?: number;
    shutdownTimeoutMs?: number;
  },
  operation: (ready: Record<string, unknown>, signal: AbortSignal) => Promise<T>,
): Promise<T | { dryRun: true; executable: string; argv: string[] }> {
  if (options?.dryRun) return { dryRun: true, executable: plan.executable, argv: [...plan.argv] };
  const startupTimeoutMs = positiveTimeout(options?.startupTimeoutMs, 10_000, "startupTimeoutMs");
  const shutdownTimeoutMs = positiveTimeout(options?.shutdownTimeoutMs, 2_000, "shutdownTimeoutMs");
  const spawn = options?.spawn ?? (spawnProcess as unknown as SpawnProducer);
  const child = spawn(plan.executable, [...plan.argv], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const captureStderr = (chunk: unknown) => { stderrTail = appendTail(stderrTail, chunk); };
  child.stderr?.on("data", captureStderr);
  const drainStdout = () => {};
  let observedChildError: Error | undefined;
  let observedChildClose: { code: number | null; signal: string | null } | undefined;
  let notifyPostReadyFailure: ((error: Error) => void) | undefined;
  const retainChildError = (error: Error) => {
    const wrapped = new Error(`producer process error: ${error.message}`, { cause: error });
    observedChildError = wrapped;
    notifyPostReadyFailure?.(wrapped);
  };
  const retainStdoutError = (error: Error) => {
    const wrapped = new Error(`producer stdout stream error: ${error.message}`, { cause: error });
    observedChildError = wrapped;
    notifyPostReadyFailure?.(wrapped);
  };
  const retainStderrError = (error: Error) => {
    const wrapped = new Error(`producer stderr stream error: ${error.message}`, { cause: error });
    observedChildError = wrapped;
    notifyPostReadyFailure?.(wrapped);
  };
  const retainChildClose = (code: number | null, signal: string | null) => {
    observedChildClose = { code, signal };
  };
  // EventEmitter treats an unhandled `error` event as a host-process exception. Retain one
  // listener across the entire child lifetime; awaitReady adds/removes only its local listener.
  child.on("error", retainChildError);
  child.stdout?.on("error", retainStdoutError);
  child.stderr?.on("error", retainStderrError);
  child.on("close", retainChildClose);

  let operationError: unknown;
  try {
    const ready = await awaitReady(child, plan.expectedReady, startupTimeoutMs, () => stderrTail.toString("utf8"));
    if (observedChildError) throw observedChildError;
    // The native producer emits bounded JSONL stats for the rest of its lifetime. Keep draining
    // stdout after readiness so a full pipe cannot stall frame delivery during a long operation.
    child.stdout?.on("data", drainStdout);
    const operationAbort = new AbortController();
    let processFailure: Error | undefined;
    let pendingExit: { code: number | null; signal: string | null } | undefined;
    let closeDiagnosticTimer: NodeJS.Timeout | undefined;
    let processFailureSignaled = false;
    let resolveProcessFailureSignal!: () => void;
    const processFailureSignal = new Promise<void>((resolve) => {
      resolveProcessFailureSignal = resolve;
    });
    const processFailureTerminal = processFailureSignal.then(() => ({ kind: "producer-failure" as const }));
    let resolveProcessFailureDetail!: (error: Error) => void;
    const processFailureDetail = new Promise<Error>((resolve) => {
      resolveProcessFailureDetail = resolve;
    });
    const signalProcessFailure = () => {
      if (processFailureSignaled) return;
      processFailureSignaled = true;
      resolveProcessFailureSignal();
    };
    const finishProcessFailure = (error: Error) => {
      signalProcessFailure();
      if (processFailure) return;
      processFailure = error;
      resolveProcessFailureDetail(error);
      if (!operationAbort.signal.aborted) operationAbort.abort(error);
    };
    const finishExitFailure = (code: number | null, signal: string | null, closeTimedOut = false) => {
      if (closeDiagnosticTimer) clearTimeout(closeDiagnosticTimer);
      closeDiagnosticTimer = undefined;
      const detail = stderrTail.toString("utf8").trim();
      finishProcessFailure(new Error(
        `producer exited during operation (code ${String(code)}, signal ${String(signal)}); stderr: ${detail || "<empty>"}` +
        (closeTimedOut ? "; stdio close timed out, so trailing stderr may be incomplete" : ""),
      ));
    };
    const postReadyExit = (code: number | null, signal: string | null) => {
      if (pendingExit || processFailureSignaled) return;
      pendingExit = { code, signal };
      signalProcessFailure();
      operationAbort.abort(new Error(
        `producer exited during operation (code ${String(code)}, signal ${String(signal)}); awaiting stdio close`,
      ));
      closeDiagnosticTimer = setTimeout(
        () => finishExitFailure(code, signal, true),
        shutdownTimeoutMs,
      );
    };
    const postReadyClose = (code: number | null, signal: string | null) => {
      const exit = pendingExit ?? { code, signal };
      finishExitFailure(exit.code, exit.signal);
    };
    notifyPostReadyFailure = finishProcessFailure;
    child.on("exit", postReadyExit);
    child.on("close", postReadyClose);
    if (observedChildError) finishProcessFailure(observedChildError);
    else if (observedChildClose) finishExitFailure(observedChildClose.code, observedChildClose.signal);
    else if (exited(child)) postReadyExit(child.exitCode ?? null, child.signalCode ?? null);

    let operationPromise: Promise<T> | undefined;
    try {
      if (!processFailureSignaled && !pendingExit) {
        try {
          operationPromise = Promise.resolve(operation(ready, operationAbort.signal));
        } catch (error) {
          operationPromise = Promise.reject(error);
        }
      }
      const operationTerminal = operationPromise?.then(
        (value) => ({ kind: "operation-value" as const, value }),
        (error: unknown) => ({ kind: "operation-error" as const, error }),
      );
      const neverCompletes = new Promise<never>(() => {});
      const terminal = await Promise.race([operationTerminal ?? neverCompletes, processFailureTerminal]);
      if (terminal.kind === "operation-value") return terminal.value;
      if (terminal.kind === "operation-error") throw terminal.error;
      if (terminal.kind === "producer-failure") {
        const failure = await processFailureDetail;
        if (operationTerminal) {
          // A cooperative operation is joined; an operation that ignores abort cannot prevent
          // the producer's bounded TERM/KILL cleanup. Its promise stays observed for any late
          // rejection after this bounded join window.
          await observeSettlementWithin(operationTerminal, shutdownTimeoutMs);
        }
        throw failure;
      }
      throw new Error("unreachable producer terminal state");
    } finally {
      notifyPostReadyFailure = undefined;
      if (closeDiagnosticTimer) clearTimeout(closeDiagnosticTimer);
      child.removeListener?.("exit", postReadyExit);
      child.removeListener?.("close", postReadyClose);
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await stopProducer(child, shutdownTimeoutMs);
    } catch (teardownError) {
      if (operationError === undefined) throw teardownError;
      if (operationError instanceof Error && Object.isExtensible(operationError)) {
        Object.defineProperty(operationError, "teardownError", {
          configurable: true,
          enumerable: true,
          value: teardownError,
        });
      } else {
        throw new AggregateError([operationError, teardownError], "producer operation and teardown both failed");
      }
    } finally {
      child.removeListener?.("error", retainChildError);
      child.stdout?.removeListener?.("error", retainStdoutError);
      child.stderr?.removeListener?.("error", retainStderrError);
      child.removeListener?.("close", retainChildClose);
      child.stdout?.removeListener?.("data", drainStdout);
      child.stderr?.removeListener?.("data", captureStderr);
    }
  }
}
