// v6.2 calibration + audit of the AUTOMATED EYE. The eye must AGREE with the human on the human-verified
// golden (6 cards → measures 6 → PASS) and must CATCH the over-claim (a frame with fewer objects claimed
// as 6 → not a silent PASS). If ImageMagick is absent the measurement checks skip (the pure-logic checks
// still run). Run: npm run test:eye
import { analyzeFrame, judgeFrame } from "../dist/eye.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const golden = path.join(ROOT, "golden", "showcase-6cards.golden.png");

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok   ${name}`); else { console.log(`  FAIL ${name}`); failures++; } };

// ── pure judge logic (no I/O, always runs) ──
const six = { objectCount: 6, mostlyBlack: false, nonBlackCoverage: 0.06, dominantColors: ["#48A552", "#4B40B6"] };
check("judge PASSes when count matches (6==6)", judgeFrame(six, { minObjects: 6, notMostlyBlack: true }).verdict === "PASS");
check("judge does NOT silently PASS an over-claim (3 objects claimed as 6)", judgeFrame({ ...six, objectCount: 3 }, { minObjects: 6, notMostlyBlack: true }).verdict !== "PASS");
check("judge FAILs a mostly-black frame that should have content", judgeFrame({ objectCount: 0, mostlyBlack: true, nonBlackCoverage: 0.001, dominantColors: [] }, { minObjects: 6, notMostlyBlack: true }).verdict === "FAIL");
check("judge ESCALATEs on a near-miss (5 vs 6)", judgeFrame({ ...six, objectCount: 5 }, { minObjects: 6, maxObjects: 6, notMostlyBlack: true }).verdict === "ESCALATE");
check("judge never returns vision_verified (only PASS/FAIL/ESCALATE)", ["PASS", "FAIL", "ESCALATE"].includes(judgeFrame(six, { minObjects: 6 }).verdict));

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
