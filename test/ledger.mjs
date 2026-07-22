// v5.3 + v6.1 fixture test: the trust ledger must REJECT a vision_verified claim that lacks a linked,
// REAL rendered image + attestation, and ACCEPT honest evidence. The v6.1 hardening additionally rejects
// non-image artifacts that merely exist (a text file, /etc/hosts, a 0-byte file, a directory), which the
// prior existsSync-only gate accepted (ADVERSARIAL_FINDINGS C1). Run: npm run test:ledger
import { validateEntry, appendLedgerEntry } from "../dist/ledger.js";
import { validateCapture } from "../dist/evidence.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok   ${name}`); else { console.log(`  FAIL ${name}`); failures++; } };

// ── a genuinely valid PNG (real signature + IHDR + zlib IDAT + IEND with correct CRCs) ──
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
function makePng(w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale
  const raw = Buffer.alloc(h * (w + 1)); // filter byte 0 per row + black pixels
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const tmp = os.tmpdir();
const realPng = path.join(tmp, "pico-ledger-fixture.png");
fs.writeFileSync(realPng, makePng(128, 128));
const textFile = path.join(tmp, "pico-ledger-fake.txt");
fs.writeFileSync(textFile, "this is not a rendered frame");
const emptyPng = path.join(tmp, "pico-ledger-empty.png");
fs.writeFileSync(emptyPng, "");
const dirPath = path.join(tmp, "pico-ledger-dir");
fs.mkdirSync(dirPath, { recursive: true });

// ── validateCapture unit checks (the v6.1 evidence primitive) ──
check("validateCapture accepts a real PNG", validateCapture(realPng).ok);
check("validateCapture reports dimensions", validateCapture(realPng).width === 128);
check("validateCapture rejects a text file", !validateCapture(textFile).ok);
check("validateCapture rejects a 0-byte file", !validateCapture(emptyPng).ok);
check("validateCapture rejects a directory", !validateCapture(dirPath).ok);
check("validateCapture rejects a missing path", !validateCapture("/no/such/file.png").ok);
if (fs.existsSync("/etc/hosts")) check("validateCapture rejects /etc/hosts", !validateCapture("/etc/hosts").ok);

// ── validateEntry (the ledger gate) ──
// 1) vision_verified with NO artifact -> rejected
check("vision_verified w/o artifact is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified" }).ok);
// 2) vision_verified with a NON-EXISTENT artifact -> rejected
check("vision_verified w/ missing artifact is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: "/no/such/file.png", attestation: "I saw six cards" }).ok);
// 3) vision_verified with a real IMAGE but NO attestation -> rejected
check("vision_verified w/o attestation is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: realPng }).ok);
// 3b) v18: device_verified (real-hardware vision) is held to the SAME image+attestation bar
check("device_verified w/o artifact is rejected", !validateEntry({ claim: "c", evidenceType: "device_verified" }).ok);
// 4) vision_verified with real IMAGE + attestation -> accepted, and records provenance
const good = validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: realPng, attestation: "I saw six cards at eye level" });
check("vision_verified w/ real image + attestation is accepted", good.ok);
check("accepted entry records capture provenance (sha256)", !!good.entry?.capture?.sha256);
// 5) v6.1: the four proven spoofs are now rejected
check("ATTACK: text file as vision_verified is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: textFile, attestation: "I saw six cards (lie)" }).ok);
check("ATTACK: /etc/hosts as vision_verified is rejected", !fs.existsSync("/etc/hosts") || !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: "/etc/hosts", attestation: "I saw cards (lie)" }).ok);
check("ATTACK: 0-byte png as vision_verified is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: emptyPng, attestation: "I saw cards (lie)" }).ok);
check("ATTACK: directory as vision_verified is rejected", !validateEntry({ claim: "c", evidenceType: "vision_verified", artifactPath: dirPath, attestation: "I saw cards (lie)" }).ok);
// 5b) v7.4: usd_host_render is grounded in a real image (same gate as vision_verified/auto_judged)
check("usd_host_render w/ real image + attestation is accepted", validateEntry({ claim: "c", evidenceType: "usd_host_render", artifactPath: realPng, attestation: "off-device Storm render of the composition" }).ok);
check("usd_host_render w/ a text file is rejected", !validateEntry({ claim: "c", evidenceType: "usd_host_render", artifactPath: textFile, attestation: "fake render" }).ok);
// 6) non-visual evidence types record without an artifact
check("logcat records without artifact", validateEntry({ claim: "c", evidenceType: "logcat" }).ok);
check("structural records without artifact", validateEntry({ claim: "c", evidenceType: "structural" }).ok);
check("built_for_headset records without artifact", validateEntry({ claim: "c", evidenceType: "built_for_headset", cClass: "C3" }).ok);

// 7) v27: deviceSerial passthrough — record_verification's extra path lands deviceSerial on the entry.
const deviceTestApp = "pico-ledger-devicetest-fixture";
const deviceTestPng = path.join(tmp, "pico-ledger-device-fixture.png");
fs.writeFileSync(deviceTestPng, makePng(64, 64));
const deviceRes = appendLedgerEntry(deviceTestApp, {
  claim: "hardware capture",
  evidenceType: "device_verified",
  artifactPath: deviceTestPng,
  attestation: "I saw it running on real Swan hardware",
  extra: { deviceSerial: "PA9K1ABCDEF" },
});
check("deviceSerial passthrough lands on the entry", deviceRes.entry?.deviceSerial === "PA9K1ABCDEF");
fs.rmSync(deviceTestPng, { force: true });
try { fs.rmSync(path.join(os.homedir(), ".pico-mcp", "ledgers", `${deviceTestApp}.json`), { force: true }); } catch { /* ignore */ }

fs.rmSync(realPng, { force: true });
fs.rmSync(textFile, { force: true });
fs.rmSync(emptyPng, { force: true });
fs.rmSync(dirPath, { recursive: true, force: true });
console.log(`\nLedger fixture test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
