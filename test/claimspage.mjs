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
      deviceIdentity: null,
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
if (/dated snapshot/i.test(html) && /re-hash/i.test(html)) ok("public page states that generated proof is a dated, revalidated snapshot");
else fail("public page presents a static snapshot as permanently live proof");

const brokenManifest = {
  ...manifest,
  apps: [{
    app: "com.test.broken",
    claims: [{
      ...manifest.apps[0].claims[0],
      evidenceType: "provenance-broken",
      claimedEvidenceType: "vision_verified",
      provenance: { status: "mismatch", reason: "stored bytes changed", expectedSha256: SHA, actualSha256: "f".repeat(64) },
    }],
  }],
  totals: { "provenance-broken": 1 },
};
const brokenHtml = renderClaimsHtml(brokenManifest, "2026-08-12T00:00:00Z");
if (/provenance-broken/.test(brokenHtml) && /claimed vision_verified/.test(brokenHtml) && /stored bytes changed/.test(brokenHtml) && brokenHtml.includes("f".repeat(64)))
  ok("broken provenance publishes its claimed tier, reason, and actual hash");
else fail("public page hides the reason a former visual claim was downgraded");

const producerDowngradeManifest = {
  ...manifest,
  apps: [{
    app: "com.test.legacy-producer",
    claims: [{
      ...manifest.apps[0].claims[0],
      evidenceType: "structural",
      claimedEvidenceType: "auto_judged",
      producerProvenance: {
        status: "unverifiable",
        kind: "visual_judge",
        reason: "missing visual_judge producer provenance; historical caller-authored metadata cannot prove this evidence class",
      },
    }],
  }],
  totals: { structural: 1 },
};
const producerDowngradeHtml = renderClaimsHtml(producerDowngradeManifest, "2026-08-12T00:00:00Z");
if (/DOWNGRADED from auto_judged/.test(producerDowngradeHtml) && /missing visual_judge producer provenance/.test(producerDowngradeHtml))
  ok("public claims disclose a legacy producer-tier downgrade and its reason");
else fail("public claims hide why a legacy producer-specific tier became structural");

const deviceDowngradeManifest = {
  ...manifest,
  apps: [{
    app: "com.test.legacy-device",
    claims: [{
      ...manifest.apps[0].claims[0],
      evidenceType: "vision_verified",
      claimedEvidenceType: "device_verified",
      deviceSerial: "legacy-device",
      deviceLineage: { status: "unverifiable", reason: "missing live adb identity provenance" },
    }],
  }],
  totals: { vision_verified: 1 },
};
const deviceDowngradeHtml = renderClaimsHtml(deviceDowngradeManifest, "2026-08-12T00:00:00Z");
if (/DOWNGRADED from device_verified/.test(deviceDowngradeHtml) && /missing live adb identity provenance/.test(deviceDowngradeHtml))
  ok("public claims disclose why legacy hardware evidence counts only as vision_verified");
else fail("public claims hide a device-lineage downgrade reason");

const negativeDeviceManifest = {
  ...manifest,
  apps: [{
    app: "com.test.device-negative",
    claims: [{
      ...manifest.apps[0].claims[0],
      evidenceType: "device_verified",
      deviceFeature: "controller_ray",
      deviceOutcome: "fail",
      deviceIdentity: {
        serial: "fixture-serial", model: "PICO fixture", identitySource: "adb-live-probe", captureSource: "adb-exec-out-screencap",
      },
    }],
  }],
  totals: { device_verified: 1 },
  deviceOutcomes: { pass: 0, fail: 1, unspecified: 0 },
};
const negativeDeviceHtml = renderClaimsHtml(negativeDeviceManifest, "2026-08-12T00:00:00Z");
if (/device_verified × 1 \(0 pass \/ 1 fail\)/.test(negativeDeviceHtml)
    && /feature <code>controller_ray<\/code> · outcome <b>fail<\/b> \(negative finding; not positive capability proof\)/.test(negativeDeviceHtml))
  ok("public claims preserve a looked-at device FAIL without presenting it as positive proof");
else fail("public claims blur a negative device observation into positive capability proof");

const unreadableManifest = {
  ...manifest,
  unreadableLedgers: ["com.test.corrupt: invalid JSON"],
};
const unreadableHtml = renderClaimsHtml(unreadableManifest, "2026-08-12T00:00:00Z");
if (/INCOMPLETE/.test(unreadableHtml) && /com\.test\.corrupt/.test(unreadableHtml))
  ok("public claims visibly disclose unreadable ledgers instead of omitting them");
else fail("public claims hide an unreadable ledger from the published corpus");

const corruptLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "claims-corrupt-ledger-"));
fs.writeFileSync(path.join(corruptLedgerDir, "com.test.corrupt.json"), "{not json");
const priorLedgerDir = process.env.PICO_MCP_LEDGER_DIR;
process.env.PICO_MCP_LEDGER_DIR = corruptLedgerDir;
const corruptManifest = buildClaimsManifest({});
if (priorLedgerDir === undefined) delete process.env.PICO_MCP_LEDGER_DIR;
else process.env.PICO_MCP_LEDGER_DIR = priorLedgerDir;
fs.rmSync(corruptLedgerDir, { recursive: true, force: true });
if (corruptManifest.apps.length === 0 && corruptManifest.unreadableLedgers?.some((item) => /com\.test\.corrupt/.test(item)))
  ok("claims manifest reports a corrupt ledger rather than silently dropping it");
else fail(`claims manifest omitted corrupt-ledger integrity: ${JSON.stringify(corruptManifest)}`);

// The human-readable capability snapshot and machine-readable claims snapshot must not drift into
// two incompatible public truths. This assertion is CI-safe because both are tracked artifacts.
const trackedClaims = JSON.parse(fs.readFileSync(path.resolve("docs/claims/claims.json"), "utf8"));
const trackedClaimsText = JSON.stringify(trackedClaims);
const withdrawnClaimPatterns = [
  /DROPS THE SKIN BINDING/,
  /UNRESOLVED: MeshTrackingManager\.loadAllAnchors\(\) returned 0/,
  /Unity immersive projection does not composite/,
  /P15 capability_matrix: an honest cross-ledger capability report proves the whole stack \(14 categories, all vision_verified, 40 looked-at captures\)/,
  /All EIGHT of PICO official Spatial SDK samples[\s\S]*NO patching of any kind/,
  /F4 \/ FLAGSHIP: Neon Strike Alley taken CONCEPT -> SHIPPABLE end-to-end[\s\S]*ship_checklist READY/,
  /P20 ship path: an honest production checklist \+ web PWA packaging give both lanes a real deploy target/,
  /adb screencap captures the SHELL composite[\s\S]*returns BLACK for XR-runtime immersive apps \(Unity OpenXR and Unity Integration SDK alike\)/,
  /an immersive app's own WindowContainer does NOT open a panel window on the emulator/,
];
const stillPublishedWithdrawals = withdrawnClaimPatterns.filter((pattern) => pattern.test(trackedClaimsText));
if (stillPublishedWithdrawals.length === 0)
  ok("structured corrections keep known-false and stale-readiness rows out of public claims");
else fail(`public claims still publish ${stillPublishedWithdrawals.length} withdrawn row(s) beside their corrections`);
const capabilities = fs.readFileSync(path.resolve("CAPABILITIES.md"), "utf8");
const trackedTotal = Object.values(trackedClaims.totals).reduce((a, b) => a + b, 0);
const trackedBroken = trackedClaims.totals["provenance-broken"] ?? 0;
const trackedEffective = trackedTotal - trackedBroken;
const trackedActiveApps = trackedClaims.apps.filter((app) => app.claims.some((claim) => claim.evidenceType !== "provenance-broken")).length;
if (capabilities.includes(`${trackedEffective} effective proof entries`)
    && capabilities.includes(`across ${trackedActiveApps} apps`)
    && capabilities.includes(`\`vision_verified\` ${trackedClaims.totals.vision_verified ?? 0}`)
    && capabilities.includes(`\`provenance-broken\` ${trackedBroken}`))
  ok("CAPABILITIES.md headline/totals match the tracked effective claims snapshot");
else fail(`CAPABILITIES.md is stale against docs/claims (effective=${trackedEffective}, apps=${trackedActiveApps}, vision=${trackedClaims.totals.vision_verified ?? 0}, broken=${trackedBroken})`);

const { generatedAt: trackedGeneratedAt, ...trackedManifest } = trackedClaims;
const trackedHtml = fs.readFileSync(path.resolve("docs/claims/index.html"), "utf8");
if (trackedHtml === renderClaimsHtml(trackedManifest, trackedGeneratedAt))
  ok("tracked claims HTML is exactly generated from the tracked JSON snapshot");
else fail("tracked claims HTML has drifted from claims.json or retains withdrawn rows");

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

  // This repository's checked-in public snapshot is generated on the ledger-owning maintainer
  // machine. When that same ledger corpus is present, require exact content freshness apart from
  // generatedAt; CI clones without the private local corpus skip this machine-specific assertion.
  const trackedPath = path.resolve("docs/claims/claims.json");
  if (fs.existsSync(trackedPath)) {
    const { generatedAt: _generatedAt, ...tracked } = JSON.parse(fs.readFileSync(trackedPath, "utf8"));
    if (JSON.stringify(tracked) === JSON.stringify(all)) ok("tracked public claims snapshot matches the current effective ledger read");
    else fail("tracked public claims snapshot is stale against the current effective ledger read");
  }
} else {
  console.log("  skip real ledger dir not on this machine — real-data asserts skipped");
}

console.log(`\nClaims-page test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
