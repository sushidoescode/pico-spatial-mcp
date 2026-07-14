// v22 claims-page test: the public page is GENERATED from ledger data and cannot say more than
// the ledger proved — hashes surface verbatim, attestations are HTML-escaped (no injection), and
// the minEvidence filter actually drops weaker classes. Run: npm run test:claims
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClaimsManifest, renderClaimsHtml } from "../dist/claimspage.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

// 1) synthetic manifest → html carries the verifiable parts and escapes hostile text
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const manifest = {
  apps: [{
    app: "com.test.subject",
    claims: [{
      seq: 0,
      claim: "the marker renders <b>in-world</b>",
      evidenceType: "vision_verified",
      attestation: 'I LOOKED at it. <script>alert("xss")</script>',
      artifact: "frame.png",
      capture: { sha256: SHA, width: 2160, height: 2158, bytes: 12345, format: "png" },
      cClass: "C0_emulator",
      deviceSerial: null,
      reproHash: null,
    }],
  }],
  totals: { vision_verified: 1 },
  evidenceMeaning: { vision_verified: "looked at" },
  evidenceRank: ["device_verified", "vision_verified", "auto_judged", "usd_host_render", "logcat", "structural", "compiles", "built_for_headset"],
};
const html = renderClaimsHtml(manifest, "2026-07-13T00:00:00Z");
if (html.includes(SHA)) ok("capture sha256 surfaces verbatim (the verifiable part)");
else fail("sha256 missing from the page");
if (!html.includes("<script>") && html.includes("&lt;script&gt;")) ok("attestation text is HTML-escaped (no injection)");
else fail("hostile attestation not escaped");
if (html.includes("2160×2158") && html.includes("frame.png")) ok("dimensions + artifact name rendered");
else fail("capture dimensions/artifact missing");

// 2) against the REAL ledgers (skips cleanly on CI where ~/.pico-mcp/ledgers is absent)
const LEDGER_DIR = path.join(os.homedir(), ".pico-mcp", "ledgers");
if (fs.existsSync(LEDGER_DIR) && fs.readdirSync(LEDGER_DIR).some((f) => f.endsWith(".json"))) {
  const all = buildClaimsManifest({});
  const strong = buildClaimsManifest({ minEvidence: "auto_judged" });
  const totalAll = Object.values(all.totals).reduce((a, b) => a + b, 0);
  const totalStrong = Object.values(strong.totals).reduce((a, b) => a + b, 0);
  if (totalAll > 0 && all.apps.length > 0) ok(`real ledgers load (${all.apps.length} apps, ${totalAll} claims)`);
  else fail("real ledgers produced an empty manifest");
  const weakLeaked = Object.keys(strong.totals).some((t) => ["usd_host_render", "logcat", "structural", "compiles", "built_for_headset"].includes(t));
  if (!weakLeaked && totalStrong <= totalAll) ok(`minEvidence=auto_judged drops weaker classes (${totalStrong}/${totalAll} kept)`);
  else fail("minEvidence filter leaked weaker evidence classes");
} else {
  console.log("  skip real ledger dir not on this machine — real-data asserts skipped");
}

console.log(`\nClaims-page test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
