// v6.3 calibration + audit of the AUTOMATED EYE. The eye must AGREE with the human on the human-verified
// golden (6 cards → measures 6 → PASS) and must CATCH the over-claim (a frame with fewer objects claimed
// as 6 → not a silent PASS). v6.3 adds the MR passthrough rule: on a home-env/passthrough frame
// (coverage > PASSTHROUGH_COVERAGE_THRESHOLD) the count/black checks are advisory and can NEVER
// auto-PASS — only color-keyed counting against the authored palette scores there. Fixtures are
// synthesized with ImageMagick (skip if absent); the color-key path needs the pico venv (skip if absent).
// The pure-logic checks always run. Run: npm run test:eye
import { analyzeFrame, analyzeColorKeys, judgeFrame, PASSTHROUGH_COVERAGE_THRESHOLD, registerEyeTools } from "../dist/eye.js";
import * as eyeModule from "../dist/eye.js";
import { sendXrRecenter } from "../dist/grpc.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const golden = path.join(ROOT, "golden", "showcase-6cards.golden.png");

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
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
};
const makePng = (shade) => {
  const width = 64, height = 64;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const rows = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) rows.fill(shade, y * (width + 1) + 1, (y + 1) * (width + 1));
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
};

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok   ${name}`); else { console.log(`  FAIL ${name}`); failures++; } };

// A measured PASS and a durable ledger write are separate outcomes. The public note must never
// say "recorded" when appendLedgerEntry rejected (for example because the ledger is corrupt).
const passNote = eyeModule.visualJudgePassNote;
check(
  "visual judge discloses a rejected evidence write instead of saying recorded",
  typeof passNote === "function"
    && /NOT recorded/.test(passNote(0.93, true, "fixture.app", { status: "rejected", reason: "corrupt ledger" }))
    && !/recorded to the ledger as auto_judged/.test(passNote(0.93, true, "fixture.app", { status: "rejected", reason: "corrupt ledger" })),
);

// capture_canonical's recenter option must send the real gRPC XR command. The previous Android
// keyevent 0 implementation was a no-op while its schema claimed xr_recenter behavior.
let recenterEvent = null;
const recenter = await sendXrRecenter(undefined, {
  getClientFn: () => ({ client: {}, metadata: {} }),
  streamInputFn: async (_client, events) => { recenterEvent = events[0]; },
});
check("XR recenter helper sends xr_command RECENTER", recenter.ok && recenterEvent?.xr_command?.action === "RECENTER");

// Registered-tool integration: recenter and screencap must be bound to the same requested emulator.
// A helper-only test would stay green if capture_canonical stopped calling it or targeted a different
// discovery endpoint.
let captureHandler = null;
let recenteredSerial = null;
let screencapSerial = null;
const fakeServer = {
  registerTool(name, _definition, handler) {
    if (name === "capture_canonical") captureHandler = handler;
  },
};
registerEyeTools(fakeServer, {
  sendXrRecenterFn: async (_toolsVersion, options) => {
    recenteredSerial = options?.serial;
    return { ok: true, accepted: true, effect: "unverified" };
  },
  runBinaryFn: async (_command, args) => {
    screencapSerial = args[1];
    return { code: 0, stdout: Buffer.alloc(1200, 7), stderr: "" };
  },
  analyzeFrameFn: async () => ({ available: true }),
  resolveAdbFn: () => "fake-adb",
});
const captureScratch = fs.mkdtempSync(path.join(os.tmpdir(), "eye-recenter-target-"));
const captureResult = JSON.parse((await captureHandler({
  serial: "emulator-5580",
  outPath: path.join(captureScratch, "frame.png"),
  recenter: true,
  settleMs: 0,
})).content[0].text);
check("capture_canonical binds RECENTER and screencap to one requested serial", captureResult.status === "captured" && recenteredSerial === "emulator-5580" && screencapSerial === "emulator-5580" && captureResult.recenter?.targetSerial === "emulator-5580");
fs.rmSync(captureScratch, { recursive: true, force: true });

// Public visual_judge regression: the caller's prose names semantic content that the calibrated
// checks do not measure. A PASS may persist only a canonical claim derived from the exact predicate
// and check results; the prose remains explicitly unverified context metadata.
let visualJudgeHandler = null;
const judgeServer = {
  registerTool(name, _definition, handler) {
    if (name === "visual_judge") visualJudgeHandler = handler;
  },
};
registerEyeTools(judgeServer, {
  analyzeFrameFn: async () => ({
    available: true,
    objectCount: 6,
    mostlyBlack: false,
    nonBlackCoverage: 0.06,
    dominantColors: ["48A552", "4B40B6"],
  }),
});
const judgeScratch = fs.mkdtempSync(path.join(os.tmpdir(), "eye-canonical-claim-"));
const previousLedgerDir = process.env.PICO_MCP_LEDGER_DIR;
process.env.PICO_MCP_LEDGER_DIR = path.join(judgeScratch, "ledgers");
const callerClaim = "Six dragons breathe fire above the canyon";
const exactExpectation = { minObjects: 6, maxObjects: 6, notMostlyBlack: true };
const judgedResult = JSON.parse((await visualJudgeHandler({
  imagePath: golden,
  claim: callerClaim,
  expect: exactExpectation,
  app: "fixture.eye-canonical",
  cClass: "C0_emulator",
  record: true,
})).content[0].text);
const persistedJudge = judgedResult.ledger?.entry;
check(
  "visual_judge persists a canonical measured claim, never the caller's dragons prose",
  judgedResult.verdict === "PASS"
    && judgedResult.ledger?.status === "recorded"
    && persistedJudge?.claim === judgedResult.claim
    && !/dragons|canyon|fire/i.test(persistedJudge?.claim ?? "")
    && /visual_judge measured PASS/.test(persistedJudge?.claim ?? "")
    && /\"minObjects\":6/.test(persistedJudge?.claim ?? "")
    && /\"objectCount\"/.test(persistedJudge?.claim ?? ""),
);
check(
  "visual_judge stores the exact predicate/checks and labels caller prose unverified context",
  JSON.stringify(persistedJudge?.autoJudge?.expect) === JSON.stringify(exactExpectation)
    && JSON.stringify(persistedJudge?.autoJudge?.checks) === JSON.stringify(judgedResult.checks)
    && persistedJudge?.autoJudge?.callerContext?.text === callerClaim
    && persistedJudge?.autoJudge?.callerContext?.verified === false
    && judgedResult.callerContext?.text === callerClaim
    && judgedResult.callerContext?.verified === false,
);
if (previousLedgerDir === undefined) delete process.env.PICO_MCP_LEDGER_DIR;
else process.env.PICO_MCP_LEDGER_DIR = previousLedgerDir;
fs.rmSync(judgeScratch, { recursive: true, force: true });

// The fleet source path is deterministic and can be overwritten while the producer is running.
// Measurements and CAS persistence must bind one read of one byte sequence, not two reads of a
// mutable path. This injected analyzer changes the caller's source after measuring it.
let swapJudgeHandler = null;
const swapScratch = fs.mkdtempSync(path.join(os.tmpdir(), "eye-byte-binding-"));
const swapSource = path.join(swapScratch, "forward.png");
const measuredBytes = makePng(40);
const replacementBytes = makePng(210);
const measuredSha = crypto.createHash("sha256").update(measuredBytes).digest("hex");
const replacementSha = crypto.createHash("sha256").update(replacementBytes).digest("hex");
fs.writeFileSync(swapSource, measuredBytes);
registerEyeTools({
  registerTool(name, _definition, handler) {
    if (name === "visual_judge") swapJudgeHandler = handler;
  },
}, {
  analyzeFrameFn: async (measuredPath) => {
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(measuredPath)).digest("hex");
    fs.writeFileSync(swapSource, replacementBytes);
    return { available: true, sha256, objectCount: 1, mostlyBlack: false, nonBlackCoverage: 0.06, dominantColors: ["282828"] };
  },
});
const priorSwapLedgerDir = process.env.PICO_MCP_LEDGER_DIR;
process.env.PICO_MCP_LEDGER_DIR = path.join(swapScratch, "ledgers");
const swappedResult = JSON.parse((await swapJudgeHandler({
  imagePath: swapSource,
  claim: "one measured foreground component",
  expect: { minObjects: 1, maxObjects: 1, notMostlyBlack: true },
  app: "fixture.eye-byte-binding",
  record: true,
})).content[0].text);
check(
  "visual_judge measures and persists one immutable byte snapshot when the source path is overwritten",
  swappedResult.verdict === "PASS"
    && swappedResult.ledger?.status === "recorded"
    && swappedResult.measurements?.sha256 === measuredSha
    && swappedResult.ledger?.entry?.capture?.sha256 === measuredSha
    && swappedResult.ledger?.entry?.evidenceProducer?.artifactSha256 === measuredSha
    && crypto.createHash("sha256").update(fs.readFileSync(swapSource)).digest("hex") === replacementSha
    && replacementSha !== measuredSha,
);
if (priorSwapLedgerDir === undefined) delete process.env.PICO_MCP_LEDGER_DIR;
else process.env.PICO_MCP_LEDGER_DIR = priorSwapLedgerDir;
fs.rmSync(swapScratch, { recursive: true, force: true });

// ── pure judge logic (no I/O, always runs) ──
const six = { objectCount: 6, mostlyBlack: false, nonBlackCoverage: 0.06, dominantColors: ["#48A552", "#4B40B6"] };
check("judge PASSes when count matches (6==6)", judgeFrame(six, { minObjects: 6, notMostlyBlack: true }).verdict === "PASS");
check("judge does NOT silently PASS an over-claim (3 objects claimed as 6)", judgeFrame({ ...six, objectCount: 3 }, { minObjects: 6, notMostlyBlack: true }).verdict !== "PASS");
check("judge FAILs a mostly-black frame that should have content", judgeFrame({ objectCount: 0, mostlyBlack: true, nonBlackCoverage: 0.001, dominantColors: [] }, { minObjects: 6, notMostlyBlack: true }).verdict === "FAIL");
check("judge ESCALATEs on a near-miss (5 vs 6)", judgeFrame({ ...six, objectCount: 5 }, { minObjects: 6, maxObjects: 6, notMostlyBlack: true }).verdict === "ESCALATE");
check("judge never returns vision_verified (only PASS/FAIL/ESCALATE)", ["PASS", "FAIL", "ESCALATE"].includes(judgeFrame(six, { minObjects: 6 }).verdict));

// ── v6.3 MR passthrough rule (pure logic, always runs) ──
// The mrtable proof frame: coverage 0.9801, dark islands counted instead of authored primitives.
const passthru = { objectCount: 2, mostlyBlack: false, nonBlackCoverage: 0.9801, dominantColors: ["#BBA175", "#CFB997"] };
check("THE HAZARD IS CLOSED: an in-band dark-island count on a passthrough frame must NOT auto-PASS", judgeFrame(passthru, { minObjects: 2, notMostlyBlack: true }).verdict === "ESCALATE");
const jTauto = judgeFrame(passthru, { notMostlyBlack: true });
check("passthrough: notMostlyBlack contributes ZERO confidence (no padding) and escalates", jTauto.verdict === "ESCALATE" && jTauto.confidence === 0);
check("passthrough: a zero dark-island count does not hardFail (count is meaningless, not absent content)", judgeFrame({ ...passthru, objectCount: 0 }, { minObjects: 2, notMostlyBlack: true }).verdict === "ESCALATE");
const ckOf = (found) => ({ available: true, expected: ["a", "b", "c", "d"], found, missing: ["a", "b", "c", "d"].filter((x) => !found.includes(x)), neutralSkipped: [] });
const palette4 = [{ name: "a", color: [0.9, 0.5, 0.1] }, { name: "b", color: [0.2, 0.5, 0.9] }, { name: "c", color: [0.2, 0.7, 0.4] }, { name: "d", color: [0.8, 0.6, 0.4] }];
const jCk4 = judgeFrame({ ...passthru, colorKey: ckOf(["a", "b", "c", "d"]) }, { minObjects: 2, notMostlyBlack: true, authoredColors: palette4 });
check("passthrough + color-key 4/4 → PASS on the authored palette alone (the MR auto_judged lane)", jCk4.verdict === "PASS" && jCk4.confidence === 1);
check("passthrough + color-key 0/4 → FAIL (authored content measurably absent)", judgeFrame({ ...passthru, colorKey: ckOf([]) }, { minObjects: 2, notMostlyBlack: true, authoredColors: palette4 }).verdict === "FAIL");
check("passthrough + color-key 3/4 (0.75 < 0.8) → ESCALATE", judgeFrame({ ...passthru, colorKey: ckOf(["a", "b", "c"]) }, { authoredColors: palette4 }).verdict === "ESCALATE");
check("passthrough + unavailable color-key (all-neutral palette) → ESCALATE, never PASS", judgeFrame({ ...passthru, colorKey: { available: false, expected: [], found: [], missing: [], neutralSkipped: ["x", "y"], error: "no distinct authored colors (all neutral)" } }, { minObjects: 2, notMostlyBlack: true, authoredColors: [{ name: "x", color: [0.5, 0.5, 0.5] }] }).verdict === "ESCALATE");
check("a single distinct authored color is too weak to auto-judge → ESCALATE", judgeFrame({ ...passthru, colorKey: { available: true, expected: ["a"], found: ["a"], missing: [], neutralSkipped: [] } }, { authoredColors: [palette4[0]] }).verdict === "ESCALATE");
check("non-passthrough frames keep the legacy lane untouched (6==6 still PASSes at coverage 0.06)", judgeFrame(six, { minObjects: 6, notMostlyBlack: true }).confidence === 1);

// ── v6.3 MR fixtures: synthesized frames (needs ImageMagick; the color-key path needs the pico venv) ──
// (a) black-void frame with 4 bright authored-color primitives — the legacy count path must still work.
// (b) busy photo-like "passthrough" frame (desaturated plasma noise) with the same primitives — the
//     count path must escalate; the color-key path must find the authored palette.
// (c) the auto-PASS hazard: a high-coverage frame whose DARK islands land in the expected band.
const AUTHORED = [
  { name: "sphereOrange", color: [0.902, 0.494, 0.133] }, // #E67E22
  { name: "sphereBlue", color: [0.18, 0.525, 0.871] },    // #2E86DE
  { name: "cubeGreen", color: [0.153, 0.682, 0.376] },    // #27AE60
  { name: "tableTan", color: [0.784, 0.631, 0.396] },     // #C8A165
];
const PRIMITIVE_DRAWS = [
  "-fill", "#E67E22", "-draw", "circle 100,250 100,220",
  "-fill", "#2E86DE", "-draw", "circle 250,250 250,220",
  "-fill", "#27AE60", "-draw", "rectangle 350,220 410,280",
  "-fill", "#C8A165", "-draw", "rectangle 120,350 380,400",
];
let fixtures = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eye-mr-"));
  const voidFrame = path.join(dir, "void-4primitives.png");
  const passthroughFrame = path.join(dir, "passthrough-4primitives.png");
  const hazardFrame = path.join(dir, "passthrough-2darkislands.png");
  await exec("magick", ["-size", "500x500", "xc:black", ...PRIMITIVE_DRAWS, voidFrame]);
  // Deterministic seed; desaturated (-modulate saturation 12%) so the noise mimics a muted home env —
  // below detect_colorkey's spread>50 saturation gate, like the mrtable bedroom's neutrals.
  await exec("magick", ["-seed", "11", "-size", "500x500", "plasma:fractal", "-blur", "0x1", "-modulate", "100,12,100", ...PRIMITIVE_DRAWS, passthroughFrame]);
  await exec("magick", ["-size", "500x500", "xc:#9c9c9c", "-fill", "black", "-draw", "rectangle 120,200 180,280", "-draw", "rectangle 320,200 380,280", hazardFrame]);
  fixtures = { voidFrame, passthroughFrame, hazardFrame };
} catch (e) {
  console.log(`  skip MR fixtures — ImageMagick unavailable (${String(e?.message ?? e).slice(0, 80)})`);
}
if (fixtures) {
  const mv = await analyzeFrame(fixtures.voidFrame);
  if (mv.available && mv.objectCount != null) {
    check(`(a) void frame: count path still counts the 4 bright primitives (measured ${mv.objectCount})`, mv.objectCount === 4);
    check(`(a) void frame is NOT passthrough (coverage ${mv.nonBlackCoverage?.toFixed(3)})`, mv.nonBlackCoverage != null && mv.nonBlackCoverage <= PASSTHROUGH_COVERAGE_THRESHOLD);
    check("(a) judge PASSes 4/4 on the void frame (legacy VR lane intact)", judgeFrame(mv, { minObjects: 4, maxObjects: 4, notMostlyBlack: true }).verdict === "PASS");
  } else {
    console.log(`  skip (a) measurements — ImageMagick measurement null (${mv.error ?? "connected-components unsupported"})`);
  }

  const mp = await analyzeFrame(fixtures.passthroughFrame);
  if (mp.available && mp.nonBlackCoverage != null) {
    check(`(b) busy frame measures as passthrough (coverage ${mp.nonBlackCoverage.toFixed(3)})`, mp.nonBlackCoverage > PASSTHROUGH_COVERAGE_THRESHOLD);
    const jCount = judgeFrame(mp, { minObjects: 4, maxObjects: 4, notMostlyBlack: true });
    check("(b) count path ESCALATES on the passthrough frame — never PASS, never FAIL", jCount.verdict === "ESCALATE");
    check("(b) passthrough confidence is 0 without a color-key path (advisory checks pad nothing)", jCount.confidence === 0);
    const ck = await analyzeColorKeys(fixtures.passthroughFrame, AUTHORED);
    if (ck.available) {
      check(`(b) color-key path finds all 4 authored colors on the passthrough frame (found ${ck.found.length}: ${ck.found.join(",")})`, ck.found.length === 4);
      const j = judgeFrame({ ...mp, colorKey: ck }, { minObjects: 4, maxObjects: 4, notMostlyBlack: true, authoredColors: AUTHORED });
      check(`(b) judge PASSes via the color-keyed MR lane (conf ${j.confidence})`, j.verdict === "PASS" && j.confidence >= 0.8);
      const neutralCk = await analyzeColorKeys(fixtures.passthroughFrame, [{ name: "targets", color: [0.95, 0.95, 0.92] }, { name: "ball", color: [0.1, 0.08, 0.2] }]);
      check("(b) an all-neutral authored palette degrades honestly (unavailable, names the neutrals)", neutralCk.available === false && /neutral/.test(neutralCk.error ?? "") && neutralCk.neutralSkipped.length === 2);
      check("(b) all-neutral palette + passthrough → ESCALATE", judgeFrame({ ...mp, colorKey: neutralCk }, { minObjects: 4, notMostlyBlack: true, authoredColors: [{ name: "targets", color: [0.95, 0.95, 0.92] }] }).verdict === "ESCALATE");
    } else {
      console.log(`  skip color-key — ${ck.error}`);
    }
  } else {
    console.log(`  skip (b) measurements — ImageMagick measurement null (${mp.error ?? "unavailable"})`);
  }

  const mh = await analyzeFrame(fixtures.hazardFrame);
  if (mh.available && mh.objectCount != null && mh.nonBlackCoverage != null) {
    check(`(c) hazard frame: high coverage (${mh.nonBlackCoverage.toFixed(3)}) with dark islands IN the expected band (measured ${mh.objectCount})`, mh.nonBlackCoverage > PASSTHROUGH_COVERAGE_THRESHOLD && mh.objectCount === 2);
    check("(c) THE AUTO-PASS HAZARD: in-band dark islands on a high-coverage frame must NOT pass", judgeFrame(mh, { minObjects: 2, notMostlyBlack: true }).verdict !== "PASS");
  } else {
    console.log(`  skip (c) measurements — ImageMagick measurement null (${mh.error ?? "connected-components unsupported"})`);
  }
}

// ── calibration against the human-verified golden (needs ImageMagick) ──
if (fs.existsSync(golden)) {
  const m = await analyzeFrame(golden);
  // Some ImageMagick builds (ubuntu CI) report available but can't run connected-components —
  // a null measurement is an ENVIRONMENTAL gap, not an eye defect: skip, don't fail.
  if (m.available && m.objectCount !== null && m.objectCount !== undefined) {
    check(`CALIBRATION: eye measures 6 objects on the human-verified 6-card golden (measured ${m.objectCount})`, m.objectCount === 6);
    check("CALIBRATION: golden is not mostly black", m.mostlyBlack === false);
    const j = judgeFrame(m, { minObjects: 6, notMostlyBlack: true, colorsPresent: ["#48A552"] });
    check(`CALIBRATION: eye PASSes the golden at high confidence (conf ${j.confidence})`, j.verdict === "PASS" && j.confidence >= 0.8);
  } else {
    console.log(`  skip calibration — ImageMagick unavailable or measurement null (${m.error ?? "connected-components unsupported"})`);
  }
} else {
  console.log("  skip calibration — golden frame not found");
}

console.log(`\nEye calibration test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
