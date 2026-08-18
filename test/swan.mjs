// v31 swan-readiness test: parity-ledger closure + the hardware-identity classifier, fully
// deterministic (no emulator, no adb). HOME is pointed at a scratch dir BEFORE importing dist —
// swanparity.js resolves ~/.pico-mcp at module load — then producer-path device_verified schema
// fixtures are recorded with injected identity/capture probes and matching/merge logic is asserted,
// including that a later read reopens a row if ledger proof vanishes. Identity fixtures include values
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
const { appendLedgerEntry, appendDeviceVerifiedEntry, appendLedgerRetraction } = await import("../dist/ledger.js");
const { classifyDeviceIdentity, deviceVerifiedMatches, buildParityRows, mergeParityFile, normalizeFeatureText, normalizeCClass, selectPicoDevice } = await import("../dist/swanparity.js");
const { registerDeployTools } = await import("../dist/deploy.js");
if (os.homedir() !== scratch) { fail(`HOME override did not take (${os.homedir()})`); process.exit(1); }

const app = "com.test.swanparity";
const ledgerDir = path.join(scratch, ".pico-mcp", "ledgers");
fs.mkdirSync(ledgerDir, { recursive: true });
const fixturePng = path.resolve("golden/showcase-6cards.golden.png");
appendLedgerEntry(app, { claim: "controller-ray select", evidenceType: "built_for_headset", cClass: "C3" });
// These are disposable schema fixtures, not hardware observations; the wording makes that boundary
// explicit even inside the scratch ledger.
const fixtureLineage = {
  deviceSerial: "PA9K1SCHEMAFIXTURE",
  deviceModel: "PICO Swan schema fixture",
  deviceFingerprint: "Pico/swan/swan:16/SCHEMA/1:user/release-keys",
  deviceBootQemu: "",
};
const fixtureProbe = async (serial) => ({ serial, model: fixtureLineage.deviceModel, fingerprint: fixtureLineage.deviceFingerprint, bootQemu: fixtureLineage.deviceBootQemu });
const fixtureCaptureProbe = async () => fs.readFileSync(fixturePng);
const rayProof = await appendDeviceVerifiedEntry(app, { claim: "controller-ray synthetic closure fixture (not a hardware observation)", artifactPath: fixturePng, attestation: "synthetic regression fixture only; no hardware result is claimed", cClass: "C3", deviceFeature: "controller_ray", deviceOutcome: "pass", ...fixtureLineage }, fixtureProbe, fixtureCaptureProbe);
const panelProof = await appendDeviceVerifiedEntry(app, { claim: "in-front panel synthetic closure fixture (not a hardware observation)", artifactPath: fixturePng, attestation: "synthetic regression fixture only; no hardware result is claimed", cClass: "C4_headset_only", deviceFeature: "in_front_panel", deviceOutcome: "pass", ...fixtureLineage }, fixtureProbe, fixtureCaptureProbe);
const pinchProof = await appendDeviceVerifiedEntry(app, { claim: "hand pinch synthetic closure fixture (not a hardware observation)", artifactPath: fixturePng, attestation: "synthetic regression fixture only; no hardware result is claimed", cClass: "C3", deviceFeature: "hand_pinch", deviceOutcome: "pass", ...fixtureLineage }, fixtureProbe, fixtureCaptureProbe);
appendLedgerRetraction(app, { targetSeq: pinchProof.entry.seq, reason: "capture was of the wrong app", recordedAt: "2026-08-01T00:00:00.000Z" });

// 1) normalization helpers
if (normalizeFeatureText("Controller-Ray  select") === "controller ray select") ok("normalizeFeatureText folds hyphens/case/runs");
else fail(`normalizeFeatureText wrong: '${normalizeFeatureText("Controller-Ray  select")}'`);
if (normalizeCClass("C4_headset_only") === "C4" && normalizeCClass("C0_emulator") === "C0" && normalizeCClass("C3") === "C3") ok("normalizeCClass maps the ledger enum to matrix classes");
else fail("normalizeCClass wrong");

// 2) ledger→matrix matching
const m = deviceVerifiedMatches(app);
if (m.controller_ray?.captureSha256 === rayProof.entry.capture.sha256 && m.controller_ray?.deviceSerial === fixtureLineage.deviceSerial) ok("controller_ray closes only from its exact structured feature + PASS, cClass C3, intact sha, and validated lineage");
else fail(`controller_ray match wrong: ${JSON.stringify(m.controller_ray)}`);
if (m.in_front_panel?.captureSha256 === panelProof.entry.capture.sha256) ok("in_front_panel closes across the C4_headset_only↔C4 spelling gap");
else fail(`in_front_panel match wrong: ${JSON.stringify(m.in_front_panel)}`);
if (!m.hand_pinch) ok("retracted device_verified entry does NOT close hand_pinch");
else fail(`hand_pinch falsely closed: ${JSON.stringify(m.hand_pinch)}`);
if (!m.scene_understanding) ok("unclaimed features stay open");
else fail("scene_understanding falsely closed");

const negativeApp = "com.test.swanparity.negative";
const negativeProof = await appendDeviceVerifiedEntry(negativeApp, { claim: "controller_ray does NOT select on PICO hardware", artifactPath: fixturePng, attestation: "synthetic negative-outcome fixture only; no hardware result is claimed", cClass: "C3", deviceFeature: "controller_ray", deviceOutcome: "fail", ...fixtureLineage }, fixtureProbe, fixtureCaptureProbe);
if (negativeProof.status === "recorded" && !deviceVerifiedMatches(negativeApp).controller_ray) ok("negative device outcome remains evidence but cannot close parity despite positive keywords");
else fail(`negative device outcome closed parity or failed to record: ${JSON.stringify({ negativeProof, matches: deviceVerifiedMatches(negativeApp) })}`);

const proseOnlyApp = "com.test.swanparity.proseonly";
const proseOnlyPath = path.join(ledgerDir, `${proseOnlyApp}.json`);
const proseOnlyRow = { ...rayProof.entry, seq: 0, claim: "controller_ray selects according to prose only" };
delete proseOnlyRow.deviceFeature;
delete proseOnlyRow.deviceOutcome;
fs.writeFileSync(proseOnlyPath, `${JSON.stringify([proseOnlyRow], null, 2)}\n`);
if (!deviceVerifiedMatches(proseOnlyApp).controller_ray) ok("legacy device prose without structured feature/outcome cannot close parity");
else fail("legacy free-text device claim falsely closed controller_ray");

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
const anchorBaseline = buildParityRows(app, ["world_anchor"], null)[0]?.emulator ?? "";
if (/unverified/i.test(anchorBaseline) && !/world tracking returns nothing|anchor no-ops?/i.test(anchorBaseline)) ok("world-anchor baseline defers unmeasured emulator persistence behavior without asserting a no-op");
else fail(`world-anchor baseline overclaims unmeasured behavior: ${anchorBaseline}`);

// 4) merge: first write closes; a second read with intact proof stays closed.
const first = mergeParityFile(app, rows, false);
let onDisk = JSON.parse(fs.readFileSync(first.path, "utf8"));
if (onDisk.rows.find((r) => r.feature === "controller_ray")?.verifiedBy === "device_verified") ok("parity file holds the closed row after the first merge");
else fail(`parity file wrong after first merge: ${JSON.stringify(onDisk.rows)}`);

const second = mergeParityFile(app, buildParityRows(app, keys, null), false);
if (second.rows.find((r) => r.feature === "controller_ray")?.verifiedBy === "device_verified") ok("second run keeps the row closed (idempotent)");
else fail("second run reopened the closed row");

// 5) cached parity state cannot outlive proof, even when an explicit subset omits the cached row.
appendLedgerRetraction(app, { targetSeq: rayProof.entry.seq, reason: "synthetic device proof withdrawn", recordedAt: "2026-08-01T00:01:00.000Z" });
const third = mergeParityFile(app, buildParityRows(app, ["scene_understanding"], null), false);
const kept = third.rows.find((r) => r.feature === "controller_ray");
if (kept?.verifiedBy === "built_for_headset" && kept?.device === "awaiting_device") ok("omitted cached row reopens when its ledger evidence disappears");
else fail(`closed row survived without ledger proof: ${JSON.stringify(kept)}`);
if (third.rows.find((r) => r.feature === "in_front_panel")?.verifiedBy === "device_verified") ok("omitted cached row with current validated proof stays closed");
else fail("current omitted device proof did not survive merge");
let parityCollisionRejected = false;
try { mergeParityFile("com.test/swanparity", [], false); } catch (error) { parityCollisionRejected = /invalid app ledger key/i.test(String(error?.message ?? error)); }
if (parityCollisionRejected && fs.existsSync(first.path)) ok("noncanonical parity key is rejected instead of aliasing another app file");
else fail("noncanonical parity key was not rejected");

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

// 7) target selection probes every candidate; adb list order never chooses a Quest over a later
// PICO, and multiple plausible PICO identities require an explicit serial.
const identities = {
  quest: { serial: "quest", model: "Quest 3", fingerprint: "oculus/eureka/eureka:14/x:user/release-keys", bootQemu: "", looksLikePico: false, reason: "not PICO" },
  "pico-a": { serial: "pico-a", model: "PICO Swan fixture A", fingerprint: "Pico/swan/a:16/x:user/release-keys", bootQemu: "", looksLikePico: true, reason: "PICO-shaped fixture" },
  "pico-b": { serial: "pico-b", model: "PICO Swan fixture B", fingerprint: "Pico/swan/b:16/x:user/release-keys", bootQemu: "", looksLikePico: true, reason: "PICO-shaped fixture" },
};
const selectionProbe = async (serial) => {
  const identity = identities[serial];
  if (!identity) throw new Error(`no fixture identity for ${serial}`);
  return identity;
};
const laterPico = await selectPicoDevice(["quest", "pico-a"], undefined, selectionProbe);
if (laterPico.status === "selected" && laterPico.selected?.serial === "pico-a" && laterPico.identities.length === 2) ok("device selection probes all candidates and chooses the sole PICO even when listed after non-PICO hardware");
else fail(`probe-all selection wrong: ${JSON.stringify(laterPico)}`);
const ambiguous = await selectPicoDevice(["pico-a", "pico-b"], undefined, selectionProbe);
if (ambiguous.status === "ambiguous" && ambiguous.selected === null) ok("multiple PICO-shaped devices fail closed as ambiguous");
else fail(`ambiguous selection wrong: ${JSON.stringify(ambiguous)}`);
const explicit = await selectPicoDevice(["pico-a", "pico-b"], "pico-b", selectionProbe);
if (explicit.status === "selected" && explicit.selected?.serial === "pico-b" && explicit.identities.length === 1) ok("explicit deviceSerial resolves a multi-PICO selection without list-order inference");
else fail(`explicit selection wrong: ${JSON.stringify(explicit)}`);
const requestedMissing = await selectPicoDevice(["pico-a"], "pico-b", selectionProbe);
if (requestedMissing.status === "requested_unavailable" && requestedMissing.selected === null) ok("unavailable explicit deviceSerial fails closed");
else fail(`missing explicit selection wrong: ${JSON.stringify(requestedMissing)}`);

// 8) deploy_to_device must not present a home-shell screenshot as a deployed app. These are
// injected protocol fixtures only: no adb command or Swan hardware is exercised here.
const apkFixture = path.join(scratch, "fixture.apk");
fs.writeFileSync(apkFixture, "schema-only APK fixture");
const picoIdentityFixture = async (serial) => ({ ...identities["pico-a"], serial });
const registerDeployFixture = (runFn, runBinaryFn = async () => ({ code: 0, stdout: fs.readFileSync(fixturePng), stderr: "", timedOut: false })) => {
  let handler;
  registerDeployTools({ registerTool: (name, _metadata, fn) => { if (name === "deploy_to_device") handler = fn; } }, {
    resolveAdbFn: () => "fixture-adb",
    probeDeviceIdentityFn: picoIdentityFixture,
    runFn,
    runBinaryFn,
    sleepFn: async () => {},
  });
  return handler;
};
const runResult = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr, timedOut: false });
const acceptedPrelude = (args) => {
  if (args.join(" ") === "devices") return runResult("List of devices attached\npico-a\tdevice\n");
  if (args.includes("install")) return runResult("Success\n");
  if (args.includes("force-stop")) return runResult();
  return null;
};
let captureCalls = 0;
const rejectedLaunchHandler = registerDeployFixture(async (_cmd, args) => {
  const prelude = acceptedPrelude(args);
  if (prelude) return prelude;
  if (args.includes("start")) return runResult("Error type 3\n", 1, "Activity class does not exist");
  return runResult();
}, async () => { captureCalls++; return { code: 0, stdout: Buffer.alloc(1200), stderr: "", timedOut: false }; });
const rejectedLaunch = await rejectedLaunchHandler({ apkPath: apkFixture, packageName: "com.test.deploy" });
if (rejectedLaunch.isError === true && /not accepted/i.test(rejectedLaunch.content[0].text) && captureCalls === 0) ok("deploy refuses a rejected am start and never captures a shell frame");
else fail(`rejected launch was mislabeled or captured: ${JSON.stringify({ rejectedLaunch, captureCalls })}`);

captureCalls = 0;
const missingPidHandler = registerDeployFixture(async (_cmd, args) => {
  const prelude = acceptedPrelude(args);
  if (prelude) return prelude;
  if (args.includes("start")) return runResult("Starting: Intent { cmp=com.test.deploy/.platform.LaunchActivity }\n");
  if (args.includes("pidof")) return runResult("", 1);
  return runResult();
}, async () => { captureCalls++; return { code: 0, stdout: Buffer.alloc(1200), stderr: "", timedOut: false }; });
const missingPid = await missingPidHandler({ apkPath: apkFixture, packageName: "com.test.deploy" });
if (missingPid.isError === true && /never exposed a live PID/i.test(missingPid.content[0].text) && captureCalls === 0) ok("deploy refuses an accepted launch with no live package PID and never captures a shell frame");
else fail(`PID-less launch was mislabeled or captured: ${JSON.stringify({ missingPid, captureCalls })}`);

captureCalls = 0;
let unstablePidCall = 0;
const unstablePidHandler = registerDeployFixture(async (_cmd, args) => {
  const prelude = acceptedPrelude(args);
  if (prelude) return prelude;
  if (args.includes("start")) return runResult("Starting: Intent { cmp=com.test.deploy/.platform.LaunchActivity }\n");
  if (args.includes("pidof")) return runResult(`${++unstablePidCall === 1 ? 4312 : 9876}\n`);
  return runResult();
}, async () => { captureCalls++; return { code: 0, stdout: fs.readFileSync(fixturePng), stderr: "", timedOut: false }; });
const unstablePid = await unstablePidHandler({ apkPath: apkFixture, packageName: "com.test.deploy" });
if (unstablePid.isError === true && /changed|restarted|unstable/i.test(unstablePid.content[0].text) && captureCalls === 0) ok("deploy refuses a PID replacement before capture instead of masking an early crash/restart");
else fail(`unstable PID was mislabeled or captured: ${JSON.stringify({ unstablePid, captureCalls })}`);

let pidCalls = 0;
const healthyHandler = registerDeployFixture(async (_cmd, args) => {
  const prelude = acceptedPrelude(args);
  if (prelude) return prelude;
  if (args.includes("start")) return runResult("Starting: Intent { cmp=com.test.deploy/.platform.LaunchActivity }\n");
  if (args.includes("pidof")) { pidCalls++; return runResult("4312\n"); }
  return runResult();
});
const healthy = await healthyHandler({ apkPath: apkFixture, packageName: "com.test.deploy" });
if (!healthy.isError && healthy.content[0]?.type === "image" && pidCalls === 3 && /proves only install \+ launch process health/i.test(healthy.content[1]?.text ?? "")) ok("deploy captures only after PID is observed before and after capture, with bounded process-health wording");
else fail(`healthy protocol fixture wrong: ${JSON.stringify({ healthy, pidCalls })}`);

pidCalls = 0;
const invalidCaptureHandler = registerDeployFixture(async (_cmd, args) => {
  const prelude = acceptedPrelude(args);
  if (prelude) return prelude;
  if (args.includes("start")) return runResult("Starting: Intent { cmp=com.test.deploy/.platform.LaunchActivity }\n");
  if (args.includes("pidof")) { pidCalls++; return runResult("4312\n"); }
  return runResult();
}, async () => ({ code: 0, stdout: Buffer.alloc(1200, 7), stderr: "", timedOut: false }));
const invalidCapture = await invalidCaptureHandler({ apkPath: apkFixture, packageName: "com.test.deploy" });
const invalidCaptureJson = invalidCapture.content[0]?.type === "text" ? JSON.parse(invalidCapture.content[0].text) : null;
if (!invalidCapture.isError && invalidCaptureJson?.status === "launched_capture_unavailable" && !invalidCapture.content.some((item) => item.type === "image")) ok("deploy never emits non-image screencap bytes as a PICO frame");
else fail(`invalid screencap bytes escaped as an image: ${JSON.stringify(invalidCapture)}`);

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nSwan test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
