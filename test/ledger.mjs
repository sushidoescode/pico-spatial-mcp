// v5.3 fixture test: the trust ledger must REJECT a vision_verified claim that lacks a linked,
// existing capture + attestation, and ACCEPT honest evidence. Run: npm run test:ledger
import { validateEntry } from "../dist/ledger.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok   ${name}`); else { console.log(`  FAIL ${name}`); failures++; } };

// a real file to link
const real = path.join(os.tmpdir(), "pico-ledger-fixture.png");
fs.writeFileSync(real, "x");

// 1) vision_verified with NO artifact -> rejected
check("vision_verified w/o artifact is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified" }).ok);
// 2) vision_verified with a NON-EXISTENT artifact -> rejected
check("vision_verified w/ missing artifact is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: "/no/such/file.png", attestation: "I saw six cards" }).ok);
// 3) vision_verified with a real artifact but NO attestation -> rejected
check("vision_verified w/o attestation is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: real }).ok);
// 4) vision_verified with real artifact + attestation -> accepted
check("vision_verified w/ artifact + attestation is accepted", validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: real, attestation: "I saw six cards at eye level" }).ok);
// 5) non-visual evidence types record without an artifact
check("logcat records without artifact", validateEntry({ claim: "c", evidenceType: "logcat" }).ok);
check("structural records without artifact", validateEntry({ claim: "c", evidenceType: "structural" }).ok);
check("built_for_headset records without artifact", validateEntry({ claim: "c", evidenceType: "built_for_headset", cClass: "C3" }).ok);

fs.rmSync(real, { force: true });
console.log(`\nLedger fixture test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
