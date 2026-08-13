// Trust-ledger regression gate. Visual evidence must be a real image, copied into the ledger's
// content-addressed store, and revalidated every time it is read. Retractions are append-only.
// Run: npm run build && npm run test:ledger
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-ledger-test-"));
const ledgerDir = path.join(scratch, "ledgers");
process.env.PICO_MCP_LEDGER_DIR = ledgerDir;

const {
  appendLedgerEntry,
  appendLedgerRetraction,
  buildLedgerReport,
  readLedger,
  validateEntry,
} = await import("../dist/ledger.js");
const { validateCapture } = await import("../dist/evidence.js");

const realPng = path.join(scratch, "mutable-source.png");
const otherPng = path.join(scratch, "other.png");
fs.writeFileSync(realPng, makePng(128, 128, 24));
fs.writeFileSync(otherPng, makePng(128, 128, 192));
const textFile = path.join(scratch, "fake.txt");
fs.writeFileSync(textFile, "this is not a rendered frame");
const emptyPng = path.join(scratch, "empty.png");
fs.writeFileSync(emptyPng, "");
const dirPath = path.join(scratch, "directory");
fs.mkdirSync(dirPath);

// Image and entry gate.
check("validateCapture accepts a real PNG", validateCapture(realPng).ok);
check("validateCapture reports dimensions", validateCapture(realPng).width === 128);
check("validateCapture rejects a text file", !validateCapture(textFile).ok);
check("validateCapture rejects a 0-byte file", !validateCapture(emptyPng).ok);
check("validateCapture rejects a directory", !validateCapture(dirPath).ok);
check("validateCapture rejects a missing path", !validateCapture(path.join(scratch, "missing.png")).ok);
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
const firstReuse = appendLedgerEntry("fixture.reuse", { claim: "first", evidenceType: "auto_judged", artifactPath: misleading, attestation: "measured the first fixture" });
const secondReuse = appendLedgerEntry("fixture.reuse", { claim: "second", evidenceType: "auto_judged", artifactPath: misleading, attestation: "measured the second fixture" });
check("canonical extension comes from image bytes", firstReuse.entry.artifactPath.endsWith(".png"));
check("identical bytes reuse one CAS path", firstReuse.entry.artifactPath === secondReuse.entry.artifactPath && secondReuse.entry.reusedArtifact === true);
const protectedCore = appendLedgerEntry("fixture.extra", { claim: "protected", evidenceType: "structural", extra: { deviceSerial: "PA9TEST", seq: 99, evidenceType: "vision_verified", retracted: true } });
check("extra metadata cannot override core ledger fields", protectedCore.entry.seq === 0 && protectedCore.entry.evidenceType === "structural" && !protectedCore.entry.retracted && protectedCore.entry.deviceSerial === "PA9TEST");

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

// Full-surface downstream tools must consume the effective reader, not raw JSON. This closes the
// bypasses where ship/cross-ledger/public reports could previously resurrect broken visual proof.
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
const toolLedger = await callJson("ledger_report", { app: mismatchApp });
check("ledger_report emits provenance-broken for a hash mismatch", toolLedger.ledger[0]?.evidenceType === "provenance-broken" && toolLedger.capabilityReport.matrix.visuallyVerified.length === 0);
const cross = await callJson("capability_matrix", { appFilter: mismatchApp });
check("cross-ledger matrix excludes broken visual proof", cross.evidenceTotals?.["provenance-broken"] === 1 && cross.evidenceTotals?.vision_verified == null && cross.integrityIssues?.length === 1);
const ship = await callJson("ship_checklist", { app: mismatchApp, projectDir: scratch });
check("ship checklist blocks on broken provenance", !ship.ready.some((line) => /vision-verified/.test(line)) && ship.blockers.some((line) => /broken provenance/i.test(line)));
const claimsOut = path.join(scratch, "claims-output");
await callJson("generate_claims_page", { apps: [mismatchApp], outDir: claimsOut });
const publicClaims = JSON.parse(fs.readFileSync(path.join(claimsOut, "claims.json"), "utf8"));
check("public claims output cannot publish broken proof as vision_verified", publicClaims.totals?.["provenance-broken"] === 1 && publicClaims.totals?.vision_verified == null);
await client.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nLedger fixture test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
