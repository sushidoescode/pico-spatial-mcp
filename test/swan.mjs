// v31 swan-readiness test: parity-ledger closure + the hardware-identity classifier, fully
// deterministic (no emulator, no adb). HOME is pointed at a scratch dir BEFORE importing dist —
// swanparity.js resolves ~/.pico-mcp at module load — then a device_verified-shaped ledger entry
// is minted directly and the matching/merge logic is asserted, including that a second run (and a
// run after the ledger vanishes) never reopens a closed row. Identity fixtures are the values
// MEASURED live on 2026-08-01: the PICO emulator's own Pico/swan_oversea fingerprint (which must
// NOT pass — emulator veto) and a real Quest 3 over USB. Run: npm run test:swan
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

// Point HOME at scratch BEFORE the dist import (module-load-time os.homedir()).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "swan-test-"));
process.env.HOME = scratch;
const { classifyDeviceIdentity, deviceVerifiedMatches, buildParityRows, mergeParityFile, normalizeFeatureText, normalizeCClass } = await import("../dist/swanparity.js");
if (os.homedir() !== scratch) { fail(`HOME override did not take (${os.homedir()})`); process.exit(1); }

const app = "com.test.swanparity";
const ledgerDir = path.join(scratch, ".pico-mcp", "ledgers");
fs.mkdirSync(ledgerDir, { recursive: true });
fs.writeFileSync(
  path.join(ledgerDir, `${app}.json`),
  JSON.stringify([
    { seq: 0, claim: "controller-ray select", evidenceType: "built_for_headset", artifactPath: null, attestation: null, cClass: "C3", reproHash: null },
    // The device_verified shape record_verification writes (capture block + deviceSerial extra).
    { seq: 1, claim: "controller-ray select fires on hardware", evidenceType: "device_verified", artifactPath: "/tmp/swan/ray.png", attestation: "the ray highlight moved onto the target and select fired", cClass: "C3", reproHash: null, deviceSerial: "PA9K1TEST", capture: { sha256: "ab12cd34ef56", width: 1024, height: 1024, bytes: 4321, format: "png" } },
    // C4 spelled the ledger way — must still close the matrix's "C4" row.
    { seq: 2, claim: "in-front panel is clickable over the scene", evidenceType: "device_verified", artifactPath: "/tmp/swan/panel.png", attestation: "panel rendered in front and the button responded", cClass: "C4_headset_only", reproHash: null, deviceSerial: "PA9K1TEST", capture: { sha256: "77aa88bb99cc", width: 1024, height: 1024, bytes: 4321, format: "png" } },
    // Retracted device_verified — must NOT close its row (ledger.ts retraction shape).
    { seq: 3, claim: "hand pinch selects the menu button", evidenceType: "device_verified", artifactPath: "/tmp/swan/pinch.png", attestation: "pinch fired select", cClass: "C3", reproHash: null, deviceSerial: "PA9K1TEST", capture: { sha256: "deadbeef0000", width: 1024, height: 1024, bytes: 4321, format: "png" }, retracted: true, retractedOn: "2026-08-01", retractedReason: "capture was of the wrong app" },
  ], null, 2),
);

// 1) normalization helpers
if (normalizeFeatureText("Controller-Ray  select") === "controller ray select") ok("normalizeFeatureText folds hyphens/case/runs");
else fail(`normalizeFeatureText wrong: '${normalizeFeatureText("Controller-Ray  select")}'`);
if (normalizeCClass("C4_headset_only") === "C4" && normalizeCClass("C0_emulator") === "C0" && normalizeCClass("C3") === "C3") ok("normalizeCClass maps the ledger enum to matrix classes");
else fail("normalizeCClass wrong");

// 2) ledger→matrix matching
const m = deviceVerifiedMatches(app);
if (m.controller_ray?.captureSha256 === "ab12cd34ef56" && m.controller_ray?.deviceSerial === "PA9K1TEST") ok("controller_ray closes (cClass C3 + 'controller-ray' keyword) with sha + serial");
else fail(`controller_ray match wrong: ${JSON.stringify(m.controller_ray)}`);
if (m.in_front_panel?.captureSha256 === "77aa88bb99cc") ok("in_front_panel closes across the C4_headset_only↔C4 spelling gap");
else fail(`in_front_panel match wrong: ${JSON.stringify(m.in_front_panel)}`);
if (!m.hand_pinch) ok("retracted device_verified entry does NOT close hand_pinch");
else fail(`hand_pinch falsely closed: ${JSON.stringify(m.hand_pinch)}`);
if (!m.scene_understanding) ok("unclaimed features stay open");
else fail("scene_understanding falsely closed");

// 3) row building: closed rows are device_verified even with no Swan attached
const keys = ["scene_understanding", "controller_ray", "hand_pinch", "in_front_panel"];
const rows = buildParityRows(app, keys, null);
const byF = Object.fromEntries(rows.map((r) => [r.feature, r]));
if (byF.controller_ray.verifiedBy === "device_verified" && byF.controller_ray.device === "device_verified") ok("closed row is device_verified in the built rows");
else fail(`controller_ray row wrong: ${JSON.stringify(byF.controller_ray)}`);
if (byF.scene_understanding.verifiedBy === "built_for_headset" && byF.scene_understanding.device === "awaiting_device") ok("open row stays built_for_headset/awaiting_device without a Swan");
else fail(`scene_understanding row wrong: ${JSON.stringify(byF.scene_understanding)}`);
const pending = buildParityRows(app, ["scene_understanding"], "localhost:5555")[0];
if (pending.verifiedBy === "swan_pending" && pending.device === "pending_capture") ok("open row flips to swan_pending when a Swan serial is passed");
else fail(`pending row wrong: ${JSON.stringify(pending)}`);

// 4) merge: first write closes, a second run does not reopen
const first = mergeParityFile(app, rows, false);
let onDisk = JSON.parse(fs.readFileSync(first.path, "utf8"));
if (onDisk.rows.find((r) => r.feature === "controller_ray")?.verifiedBy === "device_verified") ok("parity file holds the closed row after the first merge");
else fail(`parity file wrong after first merge: ${JSON.stringify(onDisk.rows)}`);

const second = mergeParityFile(app, buildParityRows(app, keys, null), false);
if (second.rows.find((r) => r.feature === "controller_ray")?.verifiedBy === "device_verified") ok("second run keeps the row closed (idempotent)");
else fail("second run reopened the closed row");

// 5) merge keeps closed rows even if the ledger evidence file disappears (never reopen with weaker rows)
fs.rmSync(path.join(ledgerDir, `${app}.json`));
const third = mergeParityFile(app, buildParityRows(app, keys, null), false);
const kept = third.rows.find((r) => r.feature === "controller_ray");
if (kept?.verifiedBy === "device_verified" && kept?.captureSha256 === "ab12cd34ef56") ok("closed row survives a run with no ledger evidence (merge, not overwrite)");
else fail(`closed row lost after ledger removal: ${JSON.stringify(kept)}`);
if (third.rows.find((r) => r.feature === "hand_pinch")?.verifiedBy === "built_for_headset") ok("open rows still update normally through the merge");
else fail("open row shape wrong after merge");

// 6) identity classifier — fixtures are live-measured getprop values (2026-08-01)
const quest = classifyDeviceIdentity("Quest 3", "oculus/eureka/eureka:14/UP1A.231005.007.A1/52345320035400520:user/release-keys", "");
if (!quest.looksLikePico) ok("Quest 3 (measured) is NOT PICO hardware");
else fail(`Quest 3 misclassified: ${quest.reason}`);
const emuTcp = classifyDeviceIdentity("SDK Spaceos Oversea built for arm64", "Pico/swan_oversea/pico_spaceos_oversea_emulator_arm64:16/BQ2A.260122.002-BP2A.250705.008/3803:user/test-keys", "1");
if (!emuTcp.looksLikePico) ok("the PICO emulator over adb-over-TCP (measured; Pico strings + qemu marker) is vetoed");
else fail(`emulator-over-TCP misclassified: ${emuTcp.reason}`);
const emuNoQemuProp = classifyDeviceIdentity("SDK Spaceos Oversea built for arm64", "Pico/swan_oversea/pico_spaceos_oversea_emulator_arm64:16/x:user/test-keys", "");
if (!emuNoQemuProp.looksLikePico) ok("'emulator' in the fingerprint alone still vetoes (belt and braces)");
else fail("emulator fingerprint without qemu prop misclassified");
// Hypothetical Swan values — UNVERIFIED against real hardware; asserts only that PICO markers
// without emulator markers pass, which is the classifier's documented contract.
const swan = classifyDeviceIdentity("PICO Swan", "Pico/swan/swan:16/x/1:user/release-keys", "");
if (swan.looksLikePico) ok("PICO markers without emulator markers pass (contract; real Swan values unverified)");
else fail(`Swan-shaped identity rejected: ${swan.reason}`);
const empty = classifyDeviceIdentity("", "", "");
if (!empty.looksLikePico) ok("empty identity (offline/unauthorized probe) does not pass");
else fail("empty identity passed");

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nSwan test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
