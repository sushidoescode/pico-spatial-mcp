// Trust-ledger regression gate. Visual evidence must be a real image, copied into the ledger's
// content-addressed store, and revalidated every time it is read. Retractions are append-only.
// Run: npm run build && npm run test:ledger
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import zlib from "node:zlib";

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok   ${name}`); else { console.log(`  FAIL ${name}`); failures++; } };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};
function makePng(w, h, shade = 0) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) raw.fill(shade, y * (w + 1) + 1, (y + 1) * (w + 1));
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function makeMarkerOnlyJpeg(w, h) {
  const segment = (marker, data) => {
    const length = Buffer.alloc(2); length.writeUInt16BE(data.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
  };
  const sof = Buffer.from([8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
  const sos = Buffer.from([1, 1, 0, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.alloc(40)),
    segment(0xc0, sof),
    segment(0xda, sos),
    Buffer.from([0x01, 0xff, 0xd9]),
  ]);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-ledger-test-"));
const ledgerDir = path.join(scratch, "ledgers");
process.env.PICO_MCP_LEDGER_DIR = ledgerDir;

const {
  appendLedgerEntry,
  appendAutoJudgedEntry,
  appendUsdHostRenderEntry,
  appendDeviceVerifiedEntry,
  appendLedgerRetraction,
  buildLedgerReport,
  readLedger,
  validateEntry,
} = await import("../dist/ledger.js");
const { validateCapture } = await import("../dist/evidence.js");
const { runBinary } = await import("../dist/util.js");

const realPng = path.join(scratch, "mutable-source.png");
const otherPng = path.join(scratch, "other.png");
const devicePng = path.join(scratch, "device-fixture.png");
fs.writeFileSync(realPng, makePng(128, 128, 24));
fs.writeFileSync(otherPng, makePng(128, 128, 192));
fs.writeFileSync(devicePng, makePng(128, 128, 111));
const headerOnlyPng = path.join(scratch, "header-only.png");
const headerOnlyBytes = Buffer.alloc(67);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(headerOnlyBytes);
headerOnlyBytes.writeUInt32BE(13, 8);
headerOnlyBytes.write("IHDR", 12, "ascii");
headerOnlyBytes.writeUInt32BE(2160, 16);
headerOnlyBytes.writeUInt32BE(2158, 20);
fs.writeFileSync(headerOnlyPng, headerOnlyBytes);
const truncatedPng = path.join(scratch, "truncated.png");
fs.writeFileSync(truncatedPng, makePng(128, 128, 33).subarray(0, -12));
const corruptCrcPng = path.join(scratch, "corrupt-crc.png");
const corruptCrcBytes = Buffer.from(makePng(128, 128, 44));
const idatTypeOffset = corruptCrcBytes.indexOf(Buffer.from("IDAT", "ascii"));
corruptCrcBytes[idatTypeOffset + 4] ^= 0xff;
fs.writeFileSync(corruptCrcPng, corruptCrcBytes);
const markerOnlyJpeg = path.join(scratch, "marker-only.jpg");
fs.writeFileSync(markerOnlyJpeg, makeMarkerOnlyJpeg(128, 128));
const oversizedCapture = path.join(scratch, "oversized-sparse.png");
fs.closeSync(fs.openSync(oversizedCapture, "w"));
fs.truncateSync(oversizedCapture, 64 * 1024 * 1024 + 1);
const textFile = path.join(scratch, "fake.txt");
fs.writeFileSync(textFile, "this is not a rendered frame");
const emptyPng = path.join(scratch, "empty.png");
fs.writeFileSync(emptyPng, "");
const dirPath = path.join(scratch, "directory");
fs.mkdirSync(dirPath);

const boundedBinary = await runBinary(process.execPath, ["--eval", "process.stdout.write(Buffer.alloc(4096, 1))"], { maxOutputBytes: 1024 });
check("binary command output is capped before it can exhaust the server", boundedBinary.stdout.length <= 1024 && /maxOutputBytes|output limit/i.test(boundedBinary.stderr));

// Image and entry gate.
check("validateCapture accepts a real PNG", validateCapture(realPng).ok);
check("validateCapture reports dimensions", validateCapture(realPng).width === 128);
check("validateCapture rejects a text file", !validateCapture(textFile).ok);
check("validateCapture rejects a 0-byte file", !validateCapture(emptyPng).ok);
check("validateCapture rejects a directory", !validateCapture(dirPath).ok);
check("validateCapture rejects a missing path", !validateCapture(path.join(scratch, "missing.png")).ok);
check("validateCapture rejects PNG-shaped header junk without a valid chunk stream", !validateCapture(headerOnlyPng).ok);
check("validateCapture rejects a PNG truncated before IEND", !validateCapture(truncatedPng).ok);
check("validateCapture rejects a PNG whose IDAT CRC is corrupt", !validateCapture(corruptCrcPng).ok);
check("validateCapture rejects a marker-only JPEG with no decodable raster", !validateCapture(markerOnlyJpeg).ok);
check("validateCapture rejects an oversized sparse capture before buffering it", !validateCapture(oversizedCapture).ok && /exceeds|limit|large/i.test(validateCapture(oversizedCapture).reason ?? ""));
check("vision_verified without artifact is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified" }).ok);
check("vision_verified without attestation is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: realPng }).ok);
check("device_verified uses the same image gate", !validateEntry({ claim: "c", evidenceType: "device_verified" }).ok);
const good = validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: realPng, attestation: "I saw the rendered subject" });
check("vision_verified with image and attestation is accepted", good.ok);
check("accepted entry records capture provenance", /^[a-f0-9]{64}$/.test(good.entry?.capture?.sha256 ?? ""));
check("text spoof is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: textFile, attestation: "I claim this is a frame" }).ok);
check("empty spoof is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: emptyPng, attestation: "I claim this is a frame" }).ok);
check("directory spoof is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: dirPath, attestation: "I claim this is a frame" }).ok);
check("usd_host_render uses the image gate", validateEntry({ claim: "c", evidenceType: "usd_host_render", artifactPath: realPng, attestation: "Storm rendered the composition" }).ok);
check("non-visual evidence needs no artifact", validateEntry({ claim: "c", evidenceType: "structural" }).ok);
check("PNG-shaped header junk cannot mint vision_verified", appendLedgerEntry("fixture.header-junk", { claim: "junk pixels", evidenceType: "vision_verified", artifactPath: headerOnlyPng, attestation: "this prose cannot make corrupt bytes visual proof" }).status === "rejected");
check("marker-only JPEG cannot mint vision_verified", appendLedgerEntry("fixture.jpeg-junk", { claim: "junk jpeg pixels", evidenceType: "vision_verified", artifactPath: markerOnlyJpeg, attestation: "this prose cannot make marker bytes visual proof" }).status === "rejected");
check("generic append cannot mint auto_judged without a calibrated-producer receipt", appendLedgerEntry("fixture.forged-auto", { claim: "forged measurement", evidenceType: "auto_judged", artifactPath: realPng, attestation: "caller prose pretending to be a calibrated result" }).status === "rejected");
check("generic append cannot mint usd_host_render without a renderer receipt", appendLedgerEntry("fixture.forged-usd", { claim: "forged host render", evidenceType: "usd_host_render", artifactPath: realPng, attestation: "caller prose pretending to be a Storm render" }).status === "rejected");
const producerAutoApp = "fixture.producer-auto";
const producedAuto = appendAutoJudgedEntry(producerAutoApp, {
  claim: "calibrated fixture count passes",
  artifactPath: realPng,
  artifactBytes: fs.readFileSync(realPng),
  attestation: "visual_judge fixture measured objectCount=1 at confidence 1",
  autoJudge: { confidence: 1, measurements: { objectCount: 1 } },
});
const producedAutoRead = readLedger(producerAutoApp);
check("visual_judge producer path persists hash-bound provenance", producedAuto.status === "recorded"
  && producedAuto.entry?.evidenceProducer?.kind === "visual_judge"
  && producedAuto.entry?.evidenceProducer?.artifactSha256 === producedAuto.entry?.capture?.sha256
  && producedAutoRead.effectiveEntries[0]?.evidenceType === "auto_judged"
  && producedAutoRead.effectiveEntries[0]?.producerProvenance?.status === "validated");
const producerUsdApp = "fixture.producer-usd";
const usdOutputSha256 = crypto.createHash("sha256").update(fs.readFileSync(otherPng)).digest("hex");
const usdMeasurement = {
  schemaVersion: 1,
  assetSha256: "a".repeat(64),
  outputSha256: usdOutputSha256,
  objectCount: 4,
  nonBlackCoverage: 0.42,
  dominantColors: ["#112233", "#445566"],
  callerContext: { text: "caller requested four dragons; this text was not visually verified", verified: false },
};
const producedUsd = appendUsdHostRenderEntry(producerUsdApp, {
  claim: "Storm fixture renders",
  artifactPath: otherPng,
  artifactBytes: fs.readFileSync(otherPng),
  attestation: "render_usd_offscreen fixture produced this host frame",
  usdRender: usdMeasurement,
});
check("USD renderer producer path persists hash-bound provenance and structured measurements", producedUsd.status === "recorded"
  && producedUsd.entry?.evidenceProducer?.kind === "render_usd_offscreen"
  && producedUsd.entry?.usdRender?.outputSha256 === producedUsd.entry?.capture?.sha256
  && producedUsd.entry?.usdRender?.callerContext?.verified === false
  && readLedger(producerUsdApp).effectiveEntries[0]?.evidenceType === "usd_host_render");
check("USD renderer receipt rejects an output hash that is not bound to the rendered artifact", appendUsdHostRenderEntry("fixture.producer-usd-mismatch", {
  claim: "mismatched fixture",
  artifactPath: otherPng,
  artifactBytes: fs.readFileSync(otherPng),
  attestation: "renderer fixture with deliberately wrong output hash",
  usdRender: { ...usdMeasurement, outputSha256: "b".repeat(64) },
}).status === "rejected");

const usdMutablePath = path.join(scratch, "usd-mutable-output.png");
const usdMeasuredBytes = makePng(128, 128, 77);
const usdReplacementBytes = makePng(128, 128, 222);
const usdMeasuredSha = crypto.createHash("sha256").update(usdMeasuredBytes).digest("hex");
fs.writeFileSync(usdMutablePath, usdReplacementBytes);
const usdSnapshotBound = appendUsdHostRenderEntry("fixture.producer-usd-byte-binding", {
  claim: "Storm snapshot-bound fixture",
  artifactPath: usdMutablePath,
  artifactBytes: usdMeasuredBytes,
  attestation: "renderer measured the immutable pre-replacement output bytes",
  usdRender: { ...usdMeasurement, outputSha256: usdMeasuredSha },
});
check("USD producer persists measured bytes rather than re-reading a replaced output path",
  usdSnapshotBound.status === "recorded"
  && usdSnapshotBound.entry?.capture?.sha256 === usdMeasuredSha
  && validateCapture(usdMutablePath).sha256 !== usdMeasuredSha);

const producerUsdPath = path.join(ledgerDir, `${producerUsdApp}.json`);
const producerUsdEvents = JSON.parse(fs.readFileSync(producerUsdPath, "utf8"));
producerUsdEvents[0].usdRender.outputSha256 = "c".repeat(64);
fs.writeFileSync(producerUsdPath, `${JSON.stringify(producerUsdEvents, null, 2)}\n`);
const unboundUsdRead = readLedger(producerUsdApp);
check("read-time producer validation downgrades a USD measurement hash unbound from its CAS artifact",
  unboundUsdRead.effectiveEntries[0]?.evidenceType === "structural"
  && /measured output hash/i.test(unboundUsdRead.producerProvenanceIssues?.[0]?.reason ?? ""));
producerUsdEvents[0].usdRender.outputSha256 = usdOutputSha256;
fs.writeFileSync(producerUsdPath, `${JSON.stringify(producerUsdEvents, null, 2)}\n`);

const legacyAutoPath = path.join(ledgerDir, `${producerAutoApp}.json`);
const legacyAutoEvents = JSON.parse(fs.readFileSync(legacyAutoPath, "utf8"));
legacyAutoEvents[0].runReceipt = {
  kind: "pico.native-run-receipt",
  schemaVersion: 1,
  receiptId: "d".repeat(64),
  captureSha256: legacyAutoEvents[0].capture.sha256,
};
delete legacyAutoEvents[0].evidenceProducer;
fs.writeFileSync(legacyAutoPath, `${JSON.stringify(legacyAutoEvents, null, 2)}\n`);
const legacyAutoRead = readLedger(producerAutoApp);
check("legacy auto_judged without producer provenance downgrades to structural", legacyAutoRead.effectiveEntries[0]?.evidenceType === "structural"
  && legacyAutoRead.effectiveEntries[0]?.claimedEvidenceType === "auto_judged"
  && legacyAutoRead.producerProvenanceIssues?.length === 1
  && legacyAutoRead.effectiveEntries[0]?.runReceipt == null
  && legacyAutoRead.runReceiptIssues?.length === 1);
const legacyUsdPath = producerUsdPath;
const legacyUsdEvents = JSON.parse(fs.readFileSync(legacyUsdPath, "utf8"));
legacyUsdEvents[0].runReceipt = {
  kind: "pico.native-run-receipt",
  schemaVersion: 1,
  receiptId: "e".repeat(64),
  captureSha256: legacyUsdEvents[0].capture.sha256,
};
delete legacyUsdEvents[0].evidenceProducer;
fs.writeFileSync(legacyUsdPath, `${JSON.stringify(legacyUsdEvents, null, 2)}\n`);
const legacyUsdRead = readLedger(producerUsdApp);
check("legacy usd_host_render without producer provenance downgrades to structural", legacyUsdRead.effectiveEntries[0]?.evidenceType === "structural"
  && legacyUsdRead.effectiveEntries[0]?.claimedEvidenceType === "usd_host_render"
  && legacyUsdRead.producerProvenanceIssues?.length === 1
  && legacyUsdRead.effectiveEntries[0]?.runReceipt == null
  && legacyUsdRead.runReceiptIssues?.length === 1);

// Device evidence has a stronger provenance contract than an emulator look. These identity values
// are schema fixtures only; no Swan hardware was available or observed in this test.
const deviceFixture = {
  deviceSerial: "PA9K1SCHEMAFIXTURE",
  deviceModel: "PICO Swan schema fixture",
  deviceFingerprint: "Pico/swan/swan:16/SCHEMA/1:user/release-keys",
  deviceBootQemu: "",
};
const fixtureProbe = async (serial) => ({
  serial,
  model: deviceFixture.deviceModel,
  fingerprint: deviceFixture.deviceFingerprint,
  bootQemu: deviceFixture.deviceBootQemu,
});
const fixtureCaptureProbe = async () => fs.readFileSync(devicePng);
const directReceiptBinding = (receiptId, artifactPath) => ({
  kind: "pico.native-run-receipt",
  schemaVersion: 1,
  receiptId,
  captureSha256: crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex"),
});
const directLedgerBindingApp = "fixture.direct-runreceipt-binding";
const directLedgerBinding = appendLedgerEntry(directLedgerBindingApp, {
  claim: "plain shaped binding has no receipt resolver lineage",
  evidenceType: "vision_verified",
  artifactPath: realPng,
  attestation: "synthetic capability fixture only; no rendered LOOK is claimed",
  runReceiptBinding: directReceiptBinding("f".repeat(64), realPng),
});
check("direct appendLedgerEntry rejects a plain shaped binding without resolver-origin capability",
  directLedgerBinding.status === "rejected"
  && /resolver|trusted|capability|lineage/i.test(directLedgerBinding.reason ?? "")
  && readLedger(directLedgerBindingApp).events.length === 0);
const directDeviceBindingApp = "fixture.device-direct-runreceipt-binding";
const directDeviceBinding = await appendDeviceVerifiedEntry(directDeviceBindingApp, {
  claim: "plain shaped binding cannot borrow synthetic device lineage",
  artifactPath: devicePng,
  attestation: "synthetic capability fixture only; no Swan or hardware result is claimed",
  deviceFeature: "controller_ray",
  deviceOutcome: "pass",
  ...deviceFixture,
  runReceiptBinding: directReceiptBinding("f".repeat(64), devicePng),
}, fixtureProbe, fixtureCaptureProbe);
check("direct appendDeviceVerifiedEntry rejects a plain shaped binding without resolver-origin capability",
  directDeviceBinding.status === "rejected"
  && /resolver|trusted|capability|lineage/i.test(directDeviceBinding.reason ?? "")
  && readLedger(directDeviceBindingApp).events.length === 0);
const missingDeviceOutcome = await appendDeviceVerifiedEntry("fixture.device-missing-outcome", {
  claim: "free-text polarity must not be inferred",
  artifactPath: devicePng,
  attestation: "synthetic schema fixture; no hardware observation",
  deviceFeature: "controller_ray",
  ...deviceFixture,
}, fixtureProbe, fixtureCaptureProbe);
check("device_verified requires explicit structured outcome", missingDeviceOutcome.status === "rejected" && /deviceOutcome/i.test(missingDeviceOutcome.reason ?? ""));
const missingDeviceLineage = appendLedgerEntry("fixture.device-missing-lineage", {
  claim: "device lineage is required",
  evidenceType: "device_verified",
  artifactPath: realPng,
  attestation: "synthetic schema fixture; no hardware observation",
  extra: { deviceSerial: deviceFixture.deviceSerial },
});
check("new device_verified entry rejects serial-only caller metadata", missingDeviceLineage.status === "rejected" && /live adb|model|fingerprint|lineage/i.test(missingDeviceLineage.reason ?? ""));
const forgedDeviceMetadata = appendLedgerEntry("fixture.device-forged-metadata", {
  claim: "caller strings are not a device receipt",
  evidenceType: "device_verified",
  artifactPath: devicePng,
  attestation: "synthetic schema fixture; no hardware observation",
  extra: {
    ...deviceFixture,
    deviceIdentitySource: "adb-live-probe",
    deviceIdentityObservedAt: new Date().toISOString(),
    deviceCaptureSource: "adb-exec-out-screencap",
    deviceCaptureSha256: validateCapture(devicePng).sha256,
  },
});
check("caller-forged probe markers cannot mint device_verified", forgedDeviceMetadata.status === "rejected" && /live adb|caller-supplied/i.test(forgedDeviceMetadata.reason ?? ""));
const emulatorShapedDevice = await appendDeviceVerifiedEntry("fixture.device-emulator-shaped", {
  claim: "emulator identity must not become device proof",
  artifactPath: devicePng,
  attestation: "synthetic schema fixture; no hardware observation",
  deviceSerial: "localhost:5555",
  deviceFeature: "controller_ray",
  deviceOutcome: "pass",
}, async (serial) => ({
  serial,
  model: "SDK Spaceos Oversea built for arm64",
  fingerprint: "Pico/swan_oversea/pico_spaceos_oversea_emulator_arm64:16/x:user/test-keys",
  bootQemu: "1",
}), fixtureCaptureProbe);
check("new device_verified entry rejects emulator-shaped identity", emulatorShapedDevice.status === "rejected" && /emulator|qemu/i.test(emulatorShapedDevice.reason ?? ""));
const deviceApp = "fixture.device-valid-lineage";
const validDevice = await appendDeviceVerifiedEntry(deviceApp, {
  claim: "controller ray schema fixture",
  artifactPath: devicePng,
  attestation: "synthetic schema fixture only; no Swan result is claimed",
  cClass: "C3",
  deviceFeature: "controller_ray",
  deviceOutcome: "pass",
  ...deviceFixture,
}, fixtureProbe, fixtureCaptureProbe);
check("device_verified schema fixture records complete non-emulator lineage", validDevice.status === "recorded" && validDevice.entry?.deviceSerial === deviceFixture.deviceSerial && validDevice.entry?.deviceFingerprint === deviceFixture.deviceFingerprint);
const mismatchedLiveIdentity = await appendDeviceVerifiedEntry("fixture.device-probe-mismatch", {
  claim: "caller identity must match probe",
  artifactPath: devicePng,
  attestation: "synthetic schema fixture only; no Swan result is claimed",
  ...deviceFixture,
  deviceModel: "different claimed model",
  deviceFeature: "controller_ray",
  deviceOutcome: "pass",
}, fixtureProbe, fixtureCaptureProbe);
check("device_verified rejects caller identity that differs from the live probe", mismatchedLiveIdentity.status === "rejected" && /did not match.*probe/i.test(mismatchedLiveIdentity.reason ?? ""));
const mismatchedLiveCapture = await appendDeviceVerifiedEntry("fixture.device-capture-mismatch", {
  claim: "caller artifact must match the same device live capture",
  artifactPath: devicePng,
  attestation: "synthetic schema fixture only; no Swan result is claimed",
  ...deviceFixture,
  deviceFeature: "controller_ray",
  deviceOutcome: "pass",
}, fixtureProbe, async () => fs.readFileSync(otherPng));
check("device_verified rejects artifact bytes not captured live from the probed serial", mismatchedLiveCapture.status === "rejected" && /capture.*match|match.*capture/i.test(mismatchedLiveCapture.reason ?? ""));
const deviceRead = readLedger(deviceApp);
check("complete device lineage remains device_verified on read", deviceRead.effectiveEntries[0]?.evidenceType === "device_verified" && deviceRead.effectiveEntries[0]?.deviceLineage?.status === "validated");
const deviceReport = buildLedgerReport(deviceApp);
check("per-app capability matrix counts device proof in its strongest bucket", deviceReport.capabilityReport.matrix.deviceVerified?.length === 1 && deviceReport.capabilityReport.matrix.visuallyVerified.length === 0);
const failedDeviceApp = "fixture.device-failed-outcome";
const failedDevice = await appendDeviceVerifiedEntry(failedDeviceApp, {
  claim: "controller_ray does NOT select on the fixture device",
  artifactPath: devicePng,
  attestation: "synthetic negative-outcome fixture only; no Swan result is claimed",
  cClass: "C3",
  deviceFeature: "controller_ray",
  deviceOutcome: "fail",
  ...deviceFixture,
}, fixtureProbe, fixtureCaptureProbe);
const failedDeviceReport = buildLedgerReport(failedDeviceApp);
check("failed device outcome stays recorded but never enters the positive device capability bucket", failedDevice.status === "recorded"
  && failedDeviceReport.capabilityReport.matrix.deviceVerified.length === 0
  && failedDeviceReport.capabilityReport.matrix.structuralOnly.some((entry) => /DEVICE-OBSERVED fail/.test(entry.evidence ?? "")));

// Legacy rows cannot be retroactively trusted as hardware proof. Their intact looked-at frame can
// remain vision_verified, but the missing device lineage must be disclosed and cannot close Swan.
const legacyDeviceApp = "fixture.device-legacy-lineage";
const legacyDevice = await appendDeviceVerifiedEntry(legacyDeviceApp, {
  claim: "legacy controller ray fixture",
  artifactPath: devicePng,
  attestation: "synthetic schema fixture only; no Swan result is claimed",
  cClass: "C3",
  deviceFeature: "controller_ray",
  deviceOutcome: "pass",
  ...deviceFixture,
}, fixtureProbe, fixtureCaptureProbe);
const legacyDevicePath = path.join(ledgerDir, `${legacyDeviceApp}.json`);
const legacyDeviceEvents = JSON.parse(fs.readFileSync(legacyDevicePath, "utf8"));
for (const field of ["deviceModel", "deviceFingerprint", "deviceBootQemu", "deviceIdentitySource", "deviceIdentityObservedAt"]) delete legacyDeviceEvents[0][field];
fs.writeFileSync(legacyDevicePath, `${JSON.stringify(legacyDeviceEvents, null, 2)}\n`);
const legacyDeviceRead = readLedger(legacyDeviceApp);
check("legacy device row without complete lineage downgrades to vision_verified", legacyDevice.status === "recorded" && legacyDeviceRead.effectiveEntries[0]?.evidenceType === "vision_verified" && legacyDeviceRead.effectiveEntries[0]?.claimedEvidenceType === "device_verified");
check("legacy device lineage downgrade is disclosed", legacyDeviceRead.deviceLineageIssues?.length === 1 && /missing/i.test(legacyDeviceRead.deviceLineageIssues[0]?.reason ?? ""));

// Immutable content-addressed write: the mutable source path is never the recorded evidence path.
const immutableApp = "fixture.immutable";
const immutable = appendLedgerEntry(immutableApp, {
  claim: "the subject renders",
  evidenceType: "vision_verified",
  artifactPath: realPng,
  attestation: "I looked at the rendered subject",
});
const storedPath = immutable.entry?.artifactPath;
const expectedSha = immutable.entry?.capture?.sha256;
check("visual append succeeds", immutable.status === "recorded");
check("visual append records the source path separately", immutable.entry?.sourceArtifactPath === realPng);
check("visual append records a ledger-owned path", typeof storedPath === "string" && storedPath !== realPng && path.dirname(storedPath) === path.join(ledgerDir, "artifacts"));
check("CAS filename is hash-addressed with canonical extension", path.basename(storedPath ?? "") === `${expectedSha}.png`);
check("CAS bytes match the bytes that were hashed", fs.readFileSync(storedPath).equals(fs.readFileSync(realPng)));

// Replacing/deleting the caller-owned source cannot invalidate the stored proof.
fs.copyFileSync(otherPng, realPng);
let effective = readLedger(immutableApp);
check("overwriting the source leaves immutable evidence intact", effective.effectiveEntries[0]?.provenance?.status === "intact");
check("effective evidence remains vision_verified after source overwrite", effective.effectiveEntries[0]?.evidenceType === "vision_verified");
let report = buildLedgerReport(immutableApp);
check("intact immutable evidence reaches the visual bucket", report.capabilityReport.matrix.visuallyVerified.length === 1);

// Missing stored evidence is explicit broken provenance and cannot print as visual proof.
fs.rmSync(storedPath);
effective = readLedger(immutableApp);
check("missing stored artifact downgrades to provenance-broken", effective.effectiveEntries[0]?.evidenceType === "provenance-broken" && effective.effectiveEntries[0]?.provenance?.status === "missing");
report = buildLedgerReport(immutableApp);
check("missing stored artifact never reaches the visual bucket", report.capabilityReport.matrix.visuallyVerified.length === 0);
check("broken provenance remains conspicuous in generated output", report.capabilityReport.matrix.structuralOnly.some((e) => /provenance/i.test(e.how)));

// A different valid image at the immutable path is also rejected by expected-vs-actual hash.
const mismatchApp = "fixture.mismatch";
const mismatchSource = path.join(scratch, "mismatch-source.png");
fs.writeFileSync(mismatchSource, makePng(128, 128, 48));
const mismatch = appendLedgerEntry(mismatchApp, { claim: "mismatch subject", evidenceType: "vision_verified", artifactPath: mismatchSource, attestation: "I looked at the mismatch fixture" });
fs.copyFileSync(otherPng, mismatch.entry.artifactPath);
const mismatchRead = readLedger(mismatchApp);
check("valid replacement image is a hash mismatch", mismatchRead.effectiveEntries[0]?.evidenceType === "provenance-broken" && mismatchRead.effectiveEntries[0]?.provenance?.status === "mismatch");
check("mismatch reports expected and actual hashes", mismatchRead.effectiveEntries[0]?.provenance?.expectedSha256 === mismatch.entry.capture.sha256 && mismatchRead.effectiveEntries[0]?.provenance?.actualSha256 === validateCapture(otherPng).sha256);
check("mismatched image never reaches the visual bucket", buildLedgerReport(mismatchApp).capabilityReport.matrix.visuallyVerified.length === 0);

// Even when a hash collision is not in play, a stored file that is no longer a decodable image
// is broken provenance. Header-shaped junk must never survive the read-side evidence gate.
const malformedStoredApp = "fixture.malformed-stored";
const malformedStoredSource = path.join(scratch, "malformed-stored-source.png");
fs.writeFileSync(malformedStoredSource, makePng(128, 128, 52));
const malformedStored = appendLedgerEntry(malformedStoredApp, { claim: "stored frame must remain decodable", evidenceType: "vision_verified", artifactPath: malformedStoredSource, attestation: "looked at the valid fixture before corruption" });
fs.writeFileSync(malformedStored.entry.artifactPath, headerOnlyBytes);
const malformedStoredRead = readLedger(malformedStoredApp);
check("malformed stored capture downgrades to provenance-broken on read", malformedStoredRead.effectiveEntries[0]?.evidenceType === "provenance-broken" && malformedStoredRead.effectiveEntries[0]?.provenance?.status === "mismatch");

// Legacy visual rows without a recorded hash are unverifiable, even if a valid current file exists.
const legacyNoHashApp = "fixture.legacy-no-hash";
fs.mkdirSync(ledgerDir, { recursive: true });
fs.writeFileSync(path.join(ledgerDir, `${legacyNoHashApp}.json`), JSON.stringify([{ seq: 0, claim: "legacy look", evidenceType: "vision_verified", artifactPath: otherPng, attestation: "a historical look without a hash" }]));
const noHash = readLedger(legacyNoHashApp).effectiveEntries[0];
check("legacy visual row without recorded hash is provenance-broken", noHash.evidenceType === "provenance-broken" && noHash.provenance.status === "unverifiable");

// Append-only retraction: target bytes/fields stay untouched; the new event removes it from proof.
const retractApp = "fixture.retraction";
const retractSource = path.join(scratch, "retract-source.png");
fs.writeFileSync(retractSource, makePng(128, 128, 73));
appendLedgerEntry(retractApp, { claim: "claim to retract", evidenceType: "vision_verified", artifactPath: retractSource, attestation: "I looked before provenance was questioned" });
const ledgerFile = path.join(ledgerDir, `${retractApp}.json`);
const beforeRetraction = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
const retraction = appendLedgerRetraction(retractApp, { targetSeq: 0, reason: "the cryptographic binding cannot be recovered", note: "the prose was accurate; the binding failed" });
const afterRetraction = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
check("retraction appends an event", retraction.status === "recorded" && afterRetraction.length === beforeRetraction.length + 1 && afterRetraction[1].eventType === "retraction");
check("retraction leaves the target entry unchanged", JSON.stringify(afterRetraction[0]) === JSON.stringify(beforeRetraction[0]));
check("retracted claim is excluded from effective evidence", readLedger(retractApp).effectiveEntries.length === 0);
check("retraction history and reason remain readable", readLedger(retractApp).retractions[0]?.reason === "the cryptographic binding cannot be recovered");
check("duplicate retraction is rejected", appendLedgerRetraction(retractApp, { targetSeq: 0, reason: "again" }).status === "rejected");

// Legacy inline retractions remain honored for compatibility.
const legacyRetractApp = "fixture.legacy-retracted";
fs.writeFileSync(path.join(ledgerDir, `${legacyRetractApp}.json`), JSON.stringify([{ seq: 0, claim: "old claim", evidenceType: "structural", retracted: true, retractedReason: "legacy correction" }]));
check("legacy inline retraction remains excluded", readLedger(legacyRetractApp).effectiveEntries.length === 0);

// CAS reuse, content-derived extension, corrupt-destination fail-closed, and metadata integrity.
const misleading = path.join(scratch, "actually-png.jpg");
fs.writeFileSync(misleading, makePng(128, 128, 81));
const firstReuse = appendLedgerEntry("fixture.reuse", { claim: "first", evidenceType: "vision_verified", artifactPath: misleading, attestation: "looked at the first fixture" });
const secondReuse = appendLedgerEntry("fixture.reuse", { claim: "second", evidenceType: "vision_verified", artifactPath: misleading, attestation: "looked at the second fixture" });
check("canonical extension comes from image bytes", firstReuse.entry.artifactPath.endsWith(".png"));
check("identical bytes reuse one CAS path", firstReuse.entry.artifactPath === secondReuse.entry.artifactPath && secondReuse.entry.reusedArtifact === true);
const protectedCore = appendLedgerEntry("fixture.extra", { claim: "protected", evidenceType: "structural", extra: { deviceSerial: "PA9TEST", seq: 99, evidenceType: "vision_verified", retracted: true, runReceipt: { kind: "pico.native-run-receipt", schemaVersion: 1, receiptId: "a".repeat(64), captureSha256: "b".repeat(64) } } });
check("extra metadata cannot override core fields or attach unprobed hardware or run-receipt lineage", protectedCore.entry.seq === 0 && protectedCore.entry.evidenceType === "structural" && !protectedCore.entry.retracted && protectedCore.entry.deviceSerial == null && protectedCore.entry.runReceipt == null);

// Historical ledger files are user-visible JSON. A malformed or mismatched caller-authored
// runReceipt object must not become a Task 6 input, while the independently intact LOOK remains.
for (const [suffix, runReceipt] of [
  ["malformed", { kind: "pico.native-run-receipt", schemaVersion: 1, receiptId: "not-a-hash", captureSha256: "b".repeat(64) }],
  ["capture-mismatch", { kind: "pico.native-run-receipt", schemaVersion: 1, receiptId: "a".repeat(64), captureSha256: "b".repeat(64) }],
  ["caller-extra", { kind: "pico.native-run-receipt", schemaVersion: 1, receiptId: "a".repeat(64), captureSha256: "c".repeat(64), callerAuthored: true }],
]) {
  const app = `fixture.legacy-runreceipt-${suffix}`;
  const recorded = appendLedgerEntry(app, { claim: `legacy ${suffix} binding fixture`, evidenceType: "vision_verified", artifactPath: realPng, attestation: "synthetic fixture attestation only; no rendered LOOK is claimed" });
  const file = path.join(ledgerDir, `${app}.json`);
  const events = JSON.parse(fs.readFileSync(file, "utf8"));
  events[0].runReceipt = runReceipt;
  fs.writeFileSync(file, `${JSON.stringify(events, null, 2)}\n`);
  const read = readLedger(app);
  check(`legacy ${suffix} runReceipt cannot be consumed while intact image evidence is preserved`, recorded.status === "recorded"
    && read.effectiveEntries[0]?.evidenceType === "vision_verified"
    && read.effectiveEntries[0]?.runReceipt == null
    && read.runReceiptIssues?.length === 1);
}

const corruptSource = path.join(scratch, "corrupt-cas-source.png");
fs.writeFileSync(corruptSource, makePng(128, 128, 99));
const corruptSha = validateCapture(corruptSource).sha256;
const corruptDest = path.join(ledgerDir, "artifacts", `${corruptSha}.png`);
fs.mkdirSync(path.dirname(corruptDest), { recursive: true });
fs.writeFileSync(corruptDest, "corrupt pre-existing artifact");
const corruptAppend = appendLedgerEntry("fixture.corrupt-cas", { claim: "must fail closed", evidenceType: "vision_verified", artifactPath: corruptSource, attestation: "I looked at the source fixture" });
check("corrupt pre-existing CAS target rejects append", corruptAppend.status === "rejected" && /content-addressed|artifact/i.test(corruptAppend.reason ?? ""));
check("corrupt CAS target is not overwritten", fs.readFileSync(corruptDest, "utf8") === "corrupt pre-existing artifact");

const corruptLedgerApp = "fixture.corrupt-ledger";
const corruptLedgerPath = path.join(ledgerDir, `${corruptLedgerApp}.json`);
fs.writeFileSync(corruptLedgerPath, "{not json");
const corruptLedgerAppend = appendLedgerEntry(corruptLedgerApp, { claim: "must not erase history", evidenceType: "structural" });
check("unreadable ledger rejects append", corruptLedgerAppend.status === "rejected");
check("unreadable ledger bytes are preserved", fs.readFileSync(corruptLedgerPath, "utf8") === "{not json");

// Ledger keys are canonical identities, not lossy filenames. A path-shaped key may never alias a
// legitimate underscore key and read/write/retract its history.
const collisionVictim = "fixture_collision_victim";
const collisionOriginal = appendLedgerEntry(collisionVictim, { claim: "victim history", evidenceType: "structural" });
const collisionAttack = appendLedgerEntry("fixture/collision/victim", { claim: "attacker history", evidenceType: "structural" });
check("noncanonical app key is rejected instead of colliding with a canonical ledger", collisionOriginal.status === "recorded" && collisionAttack.status === "rejected" && readLedger(collisionVictim).events.length === 1 && readLedger(collisionVictim).events[0]?.claim === "victim history");
const caseCollision = appendLedgerEntry("Fixture_Collision_Victim", { claim: "case alias attacker", evidenceType: "structural" });
check("uppercase app key is rejected instead of aliasing lowercase on case-insensitive filesystems", caseCollision.status === "rejected" && readLedger(collisionVictim).events.length === 1);

// Appending is a cross-process transaction. Every worker must reload after it owns the lock,
// allocate a unique sequence, and persist before the next writer begins. A successful return may
// never hide a lost claim or a vanished retraction.
const ledgerModule = new URL("../dist/ledger.js", import.meta.url).href;
const workerSource = `
  const ledger = await import(process.env.PICO_LEDGER_MODULE);
  const result = process.env.PICO_LEDGER_ACTION === "retract"
    ? ledger.appendLedgerRetraction(process.env.PICO_LEDGER_APP, {
        targetSeq: Number(process.env.PICO_LEDGER_TARGET),
        reason: "concurrent correction",
      })
    : ledger.appendLedgerEntry(process.env.PICO_LEDGER_APP, {
        claim: process.env.PICO_LEDGER_CLAIM,
        evidenceType: "structural",
      });
  if (result.status !== "recorded") {
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
`;
function ledgerWorker(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
      env: {
        ...process.env,
        PICO_LEDGER_MODULE: ledgerModule,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const concurrentApp = "fixture.concurrent-appends";
const concurrentCount = 40;
const appendWorkers = await Promise.all(Array.from({ length: concurrentCount }, (_, i) => ledgerWorker({
  PICO_LEDGER_ACTION: "append",
  PICO_LEDGER_APP: concurrentApp,
  PICO_LEDGER_CLAIM: `concurrent claim ${i}`,
})));
const concurrentRead = readLedger(concurrentApp);
const concurrentSeqs = concurrentRead.events.map((event) => event.seq);
check("all concurrent append workers report success", appendWorkers.every((worker) => worker.code === 0));
if (appendWorkers.some((worker) => worker.code !== 0)) console.log(`       worker errors: ${JSON.stringify(appendWorkers.filter((worker) => worker.code !== 0).map((worker) => worker.stderr))}`);
check("concurrent appends retain every unique claim", concurrentRead.events.length === concurrentCount && new Set(concurrentRead.events.map((event) => event.claim)).size === concurrentCount);
check("concurrent appends allocate unique contiguous sequences", new Set(concurrentSeqs).size === concurrentCount && Math.min(...concurrentSeqs) === 0 && Math.max(...concurrentSeqs) === concurrentCount - 1);

const mixedApp = "fixture.concurrent-retraction";
appendLedgerEntry(mixedApp, { claim: "target corrected during concurrent writes", evidenceType: "structural" });
const mixedAppendCount = 24;
const mixedWorkers = await Promise.all([
  ...Array.from({ length: mixedAppendCount }, (_, i) => ledgerWorker({
    PICO_LEDGER_ACTION: "append",
    PICO_LEDGER_APP: mixedApp,
    PICO_LEDGER_CLAIM: `mixed claim ${i}`,
  })),
  ledgerWorker({
    PICO_LEDGER_ACTION: "retract",
    PICO_LEDGER_APP: mixedApp,
    PICO_LEDGER_TARGET: "0",
  }),
]);
const mixedRead = readLedger(mixedApp);
check("concurrent append/retraction workers report success", mixedWorkers.every((worker) => worker.code === 0));
if (mixedWorkers.some((worker) => worker.code !== 0)) console.log(`       mixed worker errors: ${JSON.stringify(mixedWorkers.filter((worker) => worker.code !== 0).map((worker) => worker.stderr))}`);
check("concurrent append/retraction retains every event", mixedRead.events.length === mixedAppendCount + 2 && new Set(mixedRead.events.map((event) => event.seq)).size === mixedAppendCount + 2);
check("concurrent retraction remains effective", mixedRead.retractions.length === 1 && mixedRead.retractions[0]?.retracts === 0 && !mixedRead.effectiveEntries.some((event) => event.seq === 0));

// A complete published lock whose PID is provably dead is recoverable. Malformed ownership is
// deliberately fail-closed: the atomic directory acquisition path never publishes partial metadata.
function writeLockDirectory(lockPath, record) {
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, `${record.token}.owner.json`), `${JSON.stringify(record)}\n`);
}
const staleLockApp = "fixture.stale-lock";
const staleLockPath = path.join(ledgerDir, `${staleLockApp}.json.lock`);
writeLockDirectory(staleLockPath, { pid: 2147483647, token: "dead-owner-fixture", createdAt: "2026-08-12T00:00:00.000Z" });
const afterStaleLock = appendLedgerEntry(staleLockApp, { claim: "write after owner died during lock creation", evidenceType: "structural" });
check("complete lock with a provably dead PID is recovered", afterStaleLock.status === "recorded" && readLedger(staleLockApp).effectiveEntries.length === 1 && !fs.existsSync(staleLockPath));

// PID reuse must not wedge a dead lock forever: a current PID with a different OS process-start
// identity is not the process that published the lock.
const reusedPidApp = "fixture.reused-pid-lock";
const reusedPidLockPath = path.join(ledgerDir, `${reusedPidApp}.json.lock`);
writeLockDirectory(reusedPidLockPath, { pid: process.pid, token: "reused-pid-fixture", createdAt: "2026-08-12T00:00:00.000Z", processIdentity: "definitely-not-this-process" });
const afterReusedPid = appendLedgerEntry(reusedPidApp, { claim: "write after PID reuse", evidenceType: "structural" });
check("lock ownership includes process-start identity so PID reuse is recoverable", afterReusedPid.status === "recorded" && readLedger(reusedPidApp).events.length === 1);

// A reaper crash after atomically moving the whole dead generation leaves only a uniquely named
// quarantine; the fixed name is free, so a claimant can proceed without touching the orphan.
const crashedReaperApp = "fixture.crashed-reaper";
const crashedReaperLockPath = path.join(ledgerDir, `${crashedReaperApp}.json.lock`);
writeLockDirectory(`${crashedReaperLockPath}.reaped.2147483647.orphan`, { pid: 2147483647, token: "orphaned-dead-generation", createdAt: "2026-08-12T00:00:00.000Z" });
const afterCrashedReaper = appendLedgerEntry(crashedReaperApp, { claim: "write after reaper crash", evidenceType: "structural" });
check("whole-directory quarantine left by a crashed reaper cannot wedge or overwrite a claimant", afterCrashedReaper.status === "recorded" && readLedger(crashedReaperApp).events.length === 1);
const crashedElectionApp = "fixture.crashed-reaper-election";
const crashedElectionLockPath = path.join(ledgerDir, `${crashedElectionApp}.json.lock`);
const crashedElectionOwner = { pid: 2147483647, token: "dead-owner-with-crashed-reaper", createdAt: "2026-08-12T00:00:00.000Z" };
writeLockDirectory(crashedElectionLockPath, crashedElectionOwner);
const crashedElectionMarker = `${crashedElectionLockPath}.reap.${crypto.createHash("sha256").update(crashedElectionOwner.token).digest("hex")}`;
writeLockDirectory(crashedElectionMarker, { pid: 2147483647, token: "dead-reaper-election", createdAt: "2026-08-12T00:00:00.000Z" });
const afterCrashedElection = appendLedgerEntry(crashedElectionApp, { claim: "write after election owner died", evidenceType: "structural" });
check("dead reaper election is recoverable without weakening mutual exclusion", afterCrashedElection.status === "recorded" && readLedger(crashedElectionApp).events.length === 1);

// Force two processes to read the same dead owner before either begins recovery. The reaper must
// elect one remover atomically; neither process may unlink the other's replacement lock.
const twoReaperApp = "fixture.two-dead-lock-reapers";
const twoReaperLockPath = path.join(ledgerDir, `${twoReaperApp}.json.lock`);
writeLockDirectory(twoReaperLockPath, { pid: 2147483647, token: "two-reaper-dead-owner", createdAt: "2026-08-12T00:00:00.000Z" });
const reaperRelease = path.join(scratch, "two-reaper.release");
const reaperWorkerSource = `
  import fs from "node:fs";
  const realRead = fs.readFileSync;
  let paused = false;
  fs.readFileSync = function(target, ...args) {
    if (!paused && String(target).startsWith(process.env.PICO_DEAD_LOCK_PATH + "/") && String(target).endsWith(".owner.json")) {
      paused = true;
      const snapshot = realRead.call(this, target, ...args);
      fs.writeFileSync(process.env.PICO_REAPER_READY, "ready");
      while (!fs.existsSync(process.env.PICO_REAPER_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      return snapshot;
    }
    return realRead.call(this, target, ...args);
  };
  const ledger = await import(process.env.PICO_LEDGER_MODULE);
  const result = ledger.appendLedgerEntry(process.env.PICO_LEDGER_APP, { claim: process.env.PICO_LEDGER_CLAIM, evidenceType: "structural" });
  if (result.status !== "recorded") { console.error(JSON.stringify(result)); process.exitCode = 1; }
`;
const reaperChildren = [0, 1].map((i) => {
  const ready = path.join(scratch, `two-reaper-${i}.ready`);
  const child = spawn(process.execPath, ["--input-type=module", "--eval", reaperWorkerSource], {
    env: { ...process.env, PICO_LEDGER_MODULE: ledgerModule, PICO_LEDGER_APP: twoReaperApp, PICO_LEDGER_CLAIM: `reaper claim ${i}`, PICO_DEAD_LOCK_PATH: twoReaperLockPath, PICO_REAPER_READY: ready, PICO_REAPER_RELEASE: reaperRelease },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, ready, done: new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr }))) };
});
const reaperReadyDeadline = Date.now() + 5_000;
while (!reaperChildren.every(({ ready }) => fs.existsSync(ready)) && Date.now() < reaperReadyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
fs.writeFileSync(reaperRelease, "go");
const reaperResults = await Promise.all(reaperChildren.map(({ done }) => done));
const twoReaperRead = readLedger(twoReaperApp);
check("two synchronized dead-lock reapers preserve both successful appends", reaperChildren.every(({ ready }) => fs.existsSync(ready)) && reaperResults.every(({ code }) => code === 0) && twoReaperRead.events.length === 2 && new Set(twoReaperRead.events.map((event) => event.seq)).size === 2);

// Hold a reaper immediately after it atomically moves the whole dead generation out. A claimant
// must be able to fill the fixed path, and the old reaper must clean only its quarantine—not touch,
// restore over, or spuriously reject the live replacement.
const replacementApp = "fixture.reaper-replacement-window";
const replacementLockPath = path.join(ledgerDir, `${replacementApp}.json.lock`);
writeLockDirectory(replacementLockPath, { pid: 2147483647, token: "replacement-window-dead", createdAt: "2026-08-12T00:00:00.000Z" });
const reaperMoved = path.join(scratch, "replacement-reaper-moved.ready");
const reaperContinue = path.join(scratch, "replacement-reaper.continue");
const claimantLocked = path.join(scratch, "replacement-claimant-locked.ready");
const claimantContinue = path.join(scratch, "replacement-claimant.continue");
const replacementReaperSource = `
  import fs from "node:fs";
  const realRename = fs.renameSync;
  let paused = false;
  fs.renameSync = function(source, destination) {
    const result = realRename.call(this, source, destination);
    if (!paused && String(source) === process.env.PICO_DEAD_LOCK_PATH && String(destination).includes(".reaped.")) {
      paused = true;
      fs.writeFileSync(process.env.PICO_REAPER_MOVED, "moved");
      while (!fs.existsSync(process.env.PICO_REAPER_CONTINUE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return result;
  };
  const ledger = await import(process.env.PICO_LEDGER_MODULE);
  const result = ledger.appendLedgerEntry(process.env.PICO_LEDGER_APP, { claim: "reaper append", evidenceType: "structural" });
  if (result.status !== "recorded") { console.error(JSON.stringify(result)); process.exitCode = 1; }
`;
const replacementClaimantSource = `
  import fs from "node:fs";
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function(target, data, ...args) {
    if (typeof target === "number" && String(data).includes("replacement claimant")) {
      realWrite.call(this, process.env.PICO_CLAIMANT_LOCKED, "locked");
      while (!fs.existsSync(process.env.PICO_CLAIMANT_CONTINUE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return realWrite.call(this, target, data, ...args);
  };
  const ledger = await import(process.env.PICO_LEDGER_MODULE);
  const result = ledger.appendLedgerEntry(process.env.PICO_LEDGER_APP, { claim: "replacement claimant", evidenceType: "structural" });
  if (result.status !== "recorded") { console.error(JSON.stringify(result)); process.exitCode = 1; }
`;
function barrierWorker(source, env) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { env: { ...process.env, PICO_LEDGER_MODULE: ledgerModule, PICO_LEDGER_APP: replacementApp, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, done: new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr }))) };
}
const replacementReaper = barrierWorker(replacementReaperSource, { PICO_DEAD_LOCK_PATH: replacementLockPath, PICO_REAPER_MOVED: reaperMoved, PICO_REAPER_CONTINUE: reaperContinue });
const reaperMoveDeadline = Date.now() + 5_000;
while (!fs.existsSync(reaperMoved) && Date.now() < reaperMoveDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
const replacementClaimant = barrierWorker(replacementClaimantSource, { PICO_CLAIMANT_LOCKED: claimantLocked, PICO_CLAIMANT_CONTINUE: claimantContinue });
const claimantLockDeadline = Date.now() + 5_000;
while (!fs.existsSync(claimantLocked) && Date.now() < claimantLockDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
fs.writeFileSync(reaperContinue, "continue");
await new Promise((resolve) => setTimeout(resolve, 100));
fs.writeFileSync(claimantContinue, "continue");
const replacementResults = await Promise.all([replacementReaper.done, replacementClaimant.done]);
const replacementRead = readLedger(replacementApp);
check("dead-owner reaper never restores over or removes a live replacement generation", fs.existsSync(reaperMoved)
  && fs.existsSync(claimantLocked)
  && replacementResults.every(({ code }) => code === 0)
  && replacementRead.events.length === 2
  && replacementRead.events.filter((event) => event.claim === "replacement claimant").length === 1);

// A successful ledger rename and first CAS publication are durable directory-entry operations on
// POSIX, not merely fsynced file contents. Instrument a child before importing the built module.
if (process.platform !== "win32") {
  const durabilityApp = "fixture.directory-fsync";
  const durabilitySource = path.join(scratch, "directory-fsync-source.png");
  fs.writeFileSync(durabilitySource, makePng(128, 128, 62));
  const durabilityWorkerSource = `
    import fs from "node:fs";
    const realFsync = fs.fsyncSync;
    let directoryFsyncs = 0;
    fs.fsyncSync = function(fd) {
      if (fs.fstatSync(fd).isDirectory()) directoryFsyncs++;
      return realFsync.call(this, fd);
    };
    const ledger = await import(process.env.PICO_LEDGER_MODULE);
    const result = ledger.appendLedgerEntry(process.env.PICO_LEDGER_APP, { claim: "durable visual append", evidenceType: "vision_verified", artifactPath: process.env.PICO_DURABILITY_SOURCE, attestation: "looked at the durability fixture" });
    if (result.status !== "recorded" || directoryFsyncs < 2) { console.error(JSON.stringify({ result, directoryFsyncs })); process.exitCode = 1; }
  `;
  const durabilityResult = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", durabilityWorkerSource], {
      env: { ...process.env, PICO_LEDGER_MODULE: ledgerModule, PICO_LEDGER_APP: durabilityApp, PICO_DURABILITY_SOURCE: durabilitySource },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  check("ledger rename and first CAS publication fsync their parent directories", durabilityResult.code === 0);
}

// Image materialization may be slow, but it runs before the ledger lock. Simulate a process that
// spends longer than the lock's stale threshold reading a capture, while a structural writer lands
// meanwhile; both claims must survive with unique sequences.
const slowApp = "fixture.slow-image-materialization";
const slowSource = path.join(scratch, "slow-materialization.png");
fs.writeFileSync(slowSource, makePng(128, 128, 111));
const slowWorkerSource = `
  import fs from "node:fs";
  const real = fs.openSync;
  fs.openSync = function(file, ...args) {
    if (String(file) === process.env.PICO_SLOW_SOURCE) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 11_000);
    return real.call(this, file, ...args);
  };
  const ledger = await import(process.env.PICO_LEDGER_MODULE);
  const result = ledger.appendLedgerEntry(process.env.PICO_LEDGER_APP, {
    claim: "slow image claim",
    evidenceType: "vision_verified",
    artifactPath: process.env.PICO_SLOW_SOURCE,
    attestation: "looked at synthetic slow fixture",
  });
  if (result.status !== "recorded") { console.error(JSON.stringify(result)); process.exitCode = 1; }
`;
const slowChild = spawn(process.execPath, ["--input-type=module", "--eval", slowWorkerSource], {
  env: { ...process.env, PICO_LEDGER_MODULE: ledgerModule, PICO_LEDGER_APP: slowApp, PICO_SLOW_SOURCE: slowSource },
  stdio: ["ignore", "pipe", "pipe"],
});
const slowDone = new Promise((resolve) => slowChild.on("close", resolve));
await new Promise((resolve) => setTimeout(resolve, 750));
const concurrentFast = appendLedgerEntry(slowApp, { claim: "fast structural claim", evidenceType: "structural" });
const slowExit = await slowDone;
const slowRead = readLedger(slowApp);
check("slow pre-transaction capture work does not expose a live lock to stale reaping", slowExit === 0 && concurrentFast.status === "recorded" && slowRead.events.length === 2 && new Set(slowRead.events.map((event) => event.seq)).size === 2);

// A live owner may block inside synchronous ledger write/fsync longer than the former 10s stale
// threshold. Never steal it by elapsed time: wait for its token-checked release, then append.
const slowWriteApp = "fixture.slow-locked-write";
const slowWriteReady = path.join(scratch, "slow-locked-write.ready");
const slowWriteWorkerSource = `
  import fs from "node:fs";
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function(target, data, ...args) {
    if (typeof target === "number" && String(data).includes("slow locked claim")) {
      realWrite.call(this, process.env.PICO_SLOW_WRITE_READY, "locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 11_000);
    }
    return realWrite.call(this, target, data, ...args);
  };
  const ledger = await import(process.env.PICO_LEDGER_MODULE);
  const result = ledger.appendLedgerEntry(process.env.PICO_LEDGER_APP, {
    claim: "slow locked claim",
    evidenceType: "structural",
  });
  if (result.status !== "recorded") { console.error(JSON.stringify(result)); process.exitCode = 1; }
`;
const slowWriteChild = spawn(process.execPath, ["--input-type=module", "--eval", slowWriteWorkerSource], {
  env: { ...process.env, PICO_LEDGER_MODULE: ledgerModule, PICO_LEDGER_APP: slowWriteApp, PICO_SLOW_WRITE_READY: slowWriteReady },
  stdio: ["ignore", "pipe", "pipe"],
});
const readyDeadline = Date.now() + 5_000;
while (!fs.existsSync(slowWriteReady) && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
const concurrentAfterSlowWrite = appendLedgerEntry(slowWriteApp, { claim: "writer waiting for live owner", evidenceType: "structural" });
const slowWriteExit = await new Promise((resolve) => slowWriteChild.on("close", resolve));
const slowWriteRead = readLedger(slowWriteApp);
check("elapsed time never reaps a live writer during a >10s ledger write", fs.existsSync(slowWriteReady) && slowWriteExit === 0 && concurrentAfterSlowWrite.status === "recorded" && slowWriteRead.events.length === 2 && new Set(slowWriteRead.events.map((event) => event.seq)).size === 2);

// Full-surface downstream tools must consume the effective reader, not raw JSON. This closes the
// bypasses where ship/cross-ledger/public reports could previously resurrect broken visual proof.
const fakeAdb = path.join(scratch, "fake-device-adb.mjs");
fs.writeFileSync(fakeAdb, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const serial = args[1] ?? "";
if (args.includes("getprop")) {
  const prop = args.at(-1);
  const values = {
    "ro.product.model": "PICO Swan schema fixture",
    "ro.build.fingerprint": "Pico/swan/swan:16/SCHEMA/1:user/release-keys",
    "ro.boot.qemu": "",
  };
  process.stdout.write((values[prop] ?? "") + "\\n");
} else if (args.includes("screencap") && serial === "PA9K1PUBLICFIXTURE") {
  process.stdout.write(fs.readFileSync(process.env.PICO_DEVICE_FIXTURE_PATH));
} else {
  process.stderr.write("unsupported fake adb invocation: " + args.join(" "));
  process.exitCode = 2;
}
`);
fs.chmodSync(fakeAdb, 0o755);
process.env.PICO_ADB = fakeAdb;
process.env.PICO_DEVICE_FIXTURE_PATH = devicePng;
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, PICO_MCP_SURFACE: "full", PICO_MCP_LEDGER_DIR: ledgerDir, HOME: scratch },
});
const client = new Client({ name: "ledger-provenance-gate", version: "0.0.0" });
await client.connect(transport);
const callJson = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const publicDeviceApp = "fixture.device-public-live-path";
const publicDevice = await callJson("record_verification", {
  app: publicDeviceApp,
  claim: "public live-probe schema fixture",
  evidenceType: "device_verified",
  artifactPath: devicePng,
  attestation: "synthetic schema-flow fixture only; no Swan hardware observation is claimed",
  cClass: "C3",
  deviceSerial: "PA9K1PUBLICFIXTURE",
  deviceFeature: "controller_ray",
  deviceOutcome: "pass",
});
check("public record_verification mints device_verified only through live identity + same-serial capture probes", publicDevice.status === "recorded" && publicDevice.entry?.deviceCaptureSource === "adb-exec-out-screencap");
const publicForgedAuto = await callJson("record_verification", {
  app: "fixture.public-forged-auto",
  action: "record",
  claim: "caller-authored auto result",
  evidenceType: "auto_judged",
  artifactPath: devicePng,
  attestation: "plain prose is not a calibrated visual_judge receipt",
});
check("public record_verification rejects caller-minted auto_judged", publicForgedAuto.status === "rejected" && /visual_judge|producer|receipt/i.test(publicForgedAuto.reason ?? ""));
const publicForgedUsd = await callJson("record_verification", {
  app: "fixture.public-forged-usd",
  action: "record",
  claim: "caller-authored host render result",
  evidenceType: "usd_host_render",
  artifactPath: devicePng,
  attestation: "plain prose is not a render_usd_offscreen receipt",
});
check("public record_verification rejects caller-minted usd_host_render", publicForgedUsd.status === "rejected" && /render_usd_offscreen|producer|receipt/i.test(publicForgedUsd.reason ?? ""));

const publicRetractionApp = "fixture.public-retraction";
const publicOriginal = await callJson("record_verification", {
  app: publicRetractionApp,
  action: "record",
  claim: "public structural claim",
  evidenceType: "structural",
});
const mixedRetract = await callJson("record_verification", {
  app: publicRetractionApp,
  action: "retract",
  targetSeq: publicOriginal.entry?.seq,
  retractionReason: "should reject mixed action fields",
  claim: "silently ignored claim",
});
check("retract action rejects record-only fields", mixedRetract.status === "rejected" && /mutually exclusive|record-only/i.test(mixedRetract.reason ?? ""));
const mixedRecord = await callJson("record_verification", {
  app: publicRetractionApp,
  action: "record",
  claim: "must not be interpreted as a retraction",
  evidenceType: "structural",
  targetSeq: publicOriginal.entry?.seq,
  retractionReason: "silently inferred retraction",
});
check("record action rejects retraction-only fields", mixedRecord.status === "rejected" && /mutually exclusive|retraction-only/i.test(mixedRecord.reason ?? ""));
const publicRetraction = await callJson("record_verification", {
  app: publicRetractionApp,
  action: "retract",
  targetSeq: publicOriginal.entry?.seq,
  retractionReason: "public correction fixture",
  retractionNote: "original history must remain immutable",
});
const publicRetractedReport = await callJson("ledger_report", { app: publicRetractionApp });
check("public retract appends immutable history and excludes the target from effective proof", publicOriginal.status === "recorded"
  && publicRetraction.status === "recorded"
  && publicRetractedReport.history?.length === 2
  && publicRetractedReport.history[0]?.claim === "public structural claim"
  && publicRetractedReport.history[1]?.eventType === "retraction"
  && publicRetractedReport.ledger?.length === 0);
const toolLedger = await callJson("ledger_report", { app: mismatchApp });
check("ledger_report emits provenance-broken for a hash mismatch", toolLedger.ledger[0]?.evidenceType === "provenance-broken" && toolLedger.capabilityReport.matrix.visuallyVerified.length === 0);
const cross = await callJson("capability_matrix", { appFilter: mismatchApp });
check("cross-ledger matrix excludes broken visual proof", cross.evidenceTotals?.["provenance-broken"] === 1 && cross.evidenceTotals?.vision_verified == null && cross.integrityIssues?.length === 1);
const corruptMatrixApp = "fixture.corrupt-matrix";
const corruptMatrixPath = path.join(ledgerDir, `${corruptMatrixApp}.json`);
fs.writeFileSync(corruptMatrixPath, "{not valid ledger JSON");
const incompleteCross = await callJson("capability_matrix", { appFilter: corruptMatrixApp });
fs.rmSync(corruptMatrixPath, { force: true });
check("cross-ledger matrix fails closed when any selected ledger is unreadable",
  incompleteCross.status === "incomplete"
  && incompleteCross.unreadableLedgers?.length === 1
  && /1 unreadable ledger/i.test(incompleteCross.headline ?? "")
  && /partial|incomplete|excluded/i.test(incompleteCross.honesty ?? ""));
const failedDeviceCross = await callJson("capability_matrix", { appFilter: failedDeviceApp });
check("cross-ledger matrix discloses device FAIL separately and excludes it from positive proof", failedDeviceCross.evidenceTotals?.device_verified_failed === 1
  && failedDeviceCross.failedDeviceObservations?.length === 1
  && /1 device FAIL/i.test(failedDeviceCross.headline ?? "")
  && !failedDeviceCross.categories?.some((category) => category.bestEvidence === "device_verified"));
const ship = await callJson("ship_checklist", { app: mismatchApp, projectDir: scratch });
check("ship checklist blocks on broken provenance", !ship.ready.some((line) => /vision-verified/.test(line)) && ship.blockers.some((line) => /broken provenance/i.test(line)));
const deviceShip = await callJson("ship_checklist", { app: deviceApp, projectDir: scratch });
const deviceShipAccepted = deviceShip.ready.some((line) => /device-verified/i.test(line)) && !deviceShip.blockers.some((line) => /NO .*verified proof/i.test(line));
check("ship checklist accepts intact validated device proof as visual proof", deviceShipAccepted);
if (!deviceShipAccepted) console.log(`       ship output: ${JSON.stringify(deviceShip)}`);
const failedDeviceShip = await callJson("ship_checklist", { app: failedDeviceApp, projectDir: scratch });
check("ship checklist preserves device FAIL as a blocker rather than positive proof",
  failedDeviceShip.evidenceSummary?.deviceVerifiedPass === 0
  && failedDeviceShip.evidenceSummary?.deviceVerifiedFail === 1
  && !failedDeviceShip.ready.some((line) => /positive device-verified proof/i.test(line))
  && failedDeviceShip.blockers.some((line) => /device-verified failed outcome/i.test(line)));
const fakeShipProject = path.join(scratch, "fake-ship-project");
for (const variant of ["debug", "release"]) {
  const fakeApk = path.join(fakeShipProject, `app/build/outputs/apk/${variant}/app-${variant}.apk`);
  fs.mkdirSync(path.dirname(fakeApk), { recursive: true });
  fs.writeFileSync(fakeApk, `plain text pretending to be ${variant} APK`);
}
const fakeShip = await callJson("ship_checklist", { app: deviceApp, projectDir: fakeShipProject });
check("ship checklist never infers build/install/signing from .apk path existence", /^NOT READY/.test(fakeShip.verdict)
  && fakeShip.blockers.some((line) => /not bound|receipt|verified build/i.test(line))
  && fakeShip.receipt?.status === "no-current-receipt"
  && Array.isArray(fakeShip.receipt?.rejectedCandidates)
  && !fakeShip.ready.some((line) => /builds|installs|release APK/i.test(line)));
const fakeWebProject = path.join(scratch, "fake-web-project");
fs.mkdirSync(fakeWebProject, { recursive: true });
fs.writeFileSync(path.join(fakeWebProject, "manifest.webmanifest"), "{}");
const fakeWebShip = await callJson("ship_checklist", { app: deviceApp, lane: "web", projectDir: fakeWebProject });
check("ship checklist never infers deployed/hostable web readiness from manifest path existence", /^NOT READY/.test(fakeWebShip.verdict)
  && fakeWebShip.blockers.some((line) => /receipt|digest|entrypoint|deploy/i.test(line))
  && !fakeWebShip.ready.some((line) => /hostable today|runs in the emulator browser/i.test(line)));
const emptyPwaProject = path.join(scratch, "empty-pwa-project");
fs.mkdirSync(emptyPwaProject, { recursive: true });
const emptyPwa = await callJson("package_web_pwa", { projectDir: emptyPwaProject, name: "Empty Fixture" });
check("package_web_pwa rejects a missing entrypoint before writing partial metadata", emptyPwa.status === "rejected"
  && /index\.html/i.test(emptyPwa.reason ?? "")
  && !fs.existsSync(path.join(emptyPwaProject, "manifest.webmanifest"))
  && !fs.existsSync(path.join(emptyPwaProject, "sw.js")));
const noIconPwaProject = path.join(scratch, "no-icon-pwa-project");
fs.mkdirSync(noIconPwaProject, { recursive: true });
fs.writeFileSync(path.join(noIconPwaProject, "index.html"), "<!doctype html><html><head><title>fixture</title></head><body>fixture</body></html>");
const noIconPwa = await callJson("package_web_pwa", { projectDir: noIconPwaProject, name: "No Icon Fixture" });
check("package_web_pwa rejects a missing declared icon before mutation", noIconPwa.status === "rejected"
  && /icon\.png/i.test(noIconPwa.reason ?? "")
  && !fs.existsSync(path.join(noIconPwaProject, "manifest.webmanifest"))
  && !fs.existsSync(path.join(noIconPwaProject, "sw.js")));
const validPwaProject = path.join(scratch, "valid-pwa-project");
fs.mkdirSync(validPwaProject, { recursive: true });
fs.writeFileSync(path.join(validPwaProject, "index.html"), "<!doctype html><html><head><title>fixture</title></head><body>fixture</body></html>");
fs.writeFileSync(path.join(validPwaProject, "icon.png"), makePng(512, 512, 91));
const validPwa = await callJson("package_web_pwa", { projectDir: validPwaProject, name: "Valid Fixture" });
check("package_web_pwa returns a scaffolded, not deployment-ready, result for validated inputs", validPwa.status === "scaffolded"
  && /not (?:prove|establish).*deploy|deploy.*unverified|not production-ready/i.test(`${validPwa.honesty ?? ""} ${validPwa.next ?? ""}`)
  && fs.existsSync(path.join(validPwaProject, "manifest.webmanifest"))
  && fs.existsSync(path.join(validPwaProject, "sw.js"))
  && /manifest\.webmanifest/.test(fs.readFileSync(path.join(validPwaProject, "index.html"), "utf8")));
const claimsOut = path.join(scratch, "claims-output");
await callJson("generate_claims_page", { apps: [mismatchApp], outDir: claimsOut });
const publicClaims = JSON.parse(fs.readFileSync(path.join(claimsOut, "claims.json"), "utf8"));
check("public claims output cannot publish broken proof as vision_verified", publicClaims.totals?.["provenance-broken"] === 1 && publicClaims.totals?.vision_verified == null);
await client.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nLedger fixture test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
