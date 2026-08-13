// v6.3 calibration + audit of the AUTOMATED EYE. The eye must AGREE with the human on the human-verified
// golden (6 cards → measures 6 → PASS) and must CATCH the over-claim (a frame with fewer objects claimed
// as 6 → not a silent PASS). v6.3 adds the MR passthrough rule: on a home-env/passthrough frame
// (coverage > PASSTHROUGH_COVERAGE_THRESHOLD) the count/black checks are advisory and can NEVER
// auto-PASS — only color-keyed counting against the authored palette scores there. Fixtures are
// synthesized with ImageMagick (skip if absent); the color-key path needs the pico venv (skip if absent).
// The pure-logic checks always run. Run: npm run test:eye
import { analyzeFrame, analyzeColorKeys, judgeFrame, PASSTHROUGH_COVERAGE_THRESHOLD } from "../dist/eye.js";
import { sendXrRecenter } from "../dist/grpc.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const golden = path.join(ROOT, "golden", "showcase-6cards.golden.png");

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok   ${name}`); else { console.log(`  FAIL ${name}`); failures++; } };

// capture_canonical's recenter option must send the real gRPC XR command. The previous Android
// keyevent 0 implementation was a no-op while its schema claimed xr_recenter behavior.
let recenterEvent = null;
const recenter = await sendXrRecenter(undefined, {
  getClientFn: () => ({ client: {}, metadata: {} }),
  streamInputFn: async (_client, events) => { recenterEvent = events[0]; },
});
check("XR recenter helper sends xr_command RECENTER", recenter.ok && recenterEvent?.xr_command?.action === "RECENTER");

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
