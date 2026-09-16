// v22 claims-page test: the public page is GENERATED from ledger data and cannot say more than
// the ledger proved — hashes surface verbatim, attestations are HTML-escaped (no injection), and
// the minEvidence filter actually drops weaker classes. Section 2 rebuilds a whole ledger from
// tracked bytes through the real writer API, so the generation path is exercised identically on
// every host; the maintainer's own ledgers are host state and are only read under
// PICO_CLAIMS_LIVE_LEDGER=1. Run: npm run test:claims
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClaimsManifest, renderClaimsHtml } from "../dist/claimspage.js";
import { appendAutoJudgedEntry, appendDeviceVerifiedEntry, appendLedgerEntry, appendLedgerRetraction, appendUsdHostRenderEntry } from "../dist/ledger.js";

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

// 2) a FIXTURE ledger, built with the real writer API from deterministic inputs, so this gate has
//    the same answer on every host. Every input is a tracked byte-identical file, the manifest
//    carries no timestamps of its own (only seq/claim/evidence/capture identities), and the ledger
//    lives in a temp dir that is removed below — the maintainer's real ledgers are never read here.
const fixtureLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "claims-fixture-ledger-"));
const priorDir = process.env.PICO_MCP_LEDGER_DIR;
process.env.PICO_MCP_LEDGER_DIR = fixtureLedgerDir;
try {
  const recorded = (label, result) => {
    if (result?.status !== "recorded") fail(`fixture writer '${label}' was rejected: ${result?.reason ?? "unknown reason"}`);
    return result;
  };
  // Three tracked images, so their bytes (and therefore every hash below) are identical on every
  // host. `brokenSource` is materialized into the fixture CAS and then overwritten with
  // `replacementSource` — a different but still structurally valid image — which is how a
  // provenance-broken row is produced with a reason that names two hashes and no filesystem path.
  const golden = path.resolve("golden/showcase-6cards.golden.png");
  const brokenSource = path.resolve("test/fixtures/media/valid-small.png");
  const replacementSource = path.resolve("test/fixtures/media/valid-dark.png");
  const goldenBytes = fs.readFileSync(golden);
  const goldenSha = crypto.createHash("sha256").update(goldenBytes).digest("hex");

  // com.fixture.alpha — the non-image classes, plus the row that is retracted.
  recorded("alpha/compiles", appendLedgerEntry("com.fixture.alpha", { claim: "fixture: alpha compiles", evidenceType: "compiles" }));
  recorded("alpha/logcat", appendLedgerEntry("com.fixture.alpha", { claim: "fixture: alpha prints its startup line", evidenceType: "logcat", cClass: "C0_emulator" }));
  recorded("alpha/structural", appendLedgerEntry("com.fixture.alpha", { claim: "fixture: alpha declares the spatial activity", evidenceType: "structural", cClass: "C1" }));
  recorded("alpha/built_for_headset", appendLedgerEntry("com.fixture.alpha", { claim: "fixture: alpha is built for a headset-only capability", evidenceType: "built_for_headset", cClass: "C3" }));
  const withdrawn = recorded("alpha/withdrawn", appendLedgerEntry("com.fixture.alpha", { claim: "fixture: alpha claim that was withdrawn", evidenceType: "structural" }));
  recorded("alpha/retraction", appendLedgerRetraction("com.fixture.alpha", {
    targetSeq: withdrawn.entry.seq,
    reason: "fixture retraction: a withdrawn row must not reach the generated manifest",
    recordedAt: "2026-09-16T00:00:00.000Z",
  }));

  // com.fixture.beta — the three image classes each producer path owns.
  recorded("beta/vision_verified", appendLedgerEntry("com.fixture.beta", {
    claim: "fixture: beta shows six cards",
    evidenceType: "vision_verified",
    artifactPath: golden,
    attestation: "fixture attestation: the tracked golden frame stands in for a frame that was LOOKED at",
    cClass: "C0_emulator",
    reproHash: "fixture-repro-0001",
  }));
  recorded("beta/auto_judged", appendAutoJudgedEntry("com.fixture.beta", {
    claim: "fixture: beta panel is centered",
    artifactPath: golden,
    artifactBytes: goldenBytes,
    attestation: "fixture measurement summary: synthetic visual_judge receipt, no judge was run",
    cClass: "C0_emulator",
    autoJudge: { verdict: "pass", score: 0.91 },
  }));
  recorded("beta/usd_host_render", appendUsdHostRenderEntry("com.fixture.beta", {
    claim: "fixture: beta asset renders off-device",
    artifactPath: golden,
    artifactBytes: goldenBytes,
    attestation: "fixture measurement summary: synthetic renderer receipt, no Hydra render was run",
    cClass: "C1",
    // A synthetic measurement. Only outputSha256 is load-bearing (it must bind the stored bytes);
    // none of these fields is surfaced by the manifest, and no renderer produced them.
    usdRender: {
      schemaVersion: 1,
      assetSha256: goldenSha,
      outputSha256: goldenSha,
      objectCount: 6,
      nonBlackCoverage: 0.62,
      dominantColors: ["#1b2430", "#58d6ff"],
      callerContext: { text: "fixture usd render measurement; no renderer ran", verified: false },
    },
  }));

  // com.fixture.gamma — the strongest class (through injected probes, so no adb runs and nothing
  // here is a hardware observation) and the row whose stored bytes are replaced afterwards.
  const fixtureLineage = {
    deviceSerial: "PA0000FIXTURE0001",
    deviceModel: "PICO schema fixture",
    deviceFingerprint: "Pico/fixture/fixture:16/FIXTURE/1:user/release-keys",
    deviceBootQemu: "",
  };
  recorded("gamma/device_verified", await appendDeviceVerifiedEntry("com.fixture.gamma", {
    claim: "fixture: gamma device row (synthetic schema fixture; no hardware was observed)",
    artifactPath: golden,
    attestation: "fixture attestation: identity and screencap probes are injected; no device or adb was touched",
    cClass: "C3",
    deviceFeature: "controller_ray",
    deviceOutcome: "pass",
    ...fixtureLineage,
  }, async (serial) => ({ serial, model: fixtureLineage.deviceModel, fingerprint: fixtureLineage.deviceFingerprint, bootQemu: fixtureLineage.deviceBootQemu }), async () => goldenBytes));
  const brokenRow = recorded("gamma/to-be-broken", appendLedgerEntry("com.fixture.gamma", {
    claim: "fixture: gamma row whose stored evidence was replaced",
    evidenceType: "vision_verified",
    artifactPath: brokenSource,
    attestation: "fixture attestation: this row's content-addressed bytes are replaced on purpose so the read downgrades it",
    cClass: "C0_emulator",
  }));
  fs.writeFileSync(brokenRow.entry.artifactPath, fs.readFileSync(replacementSource));

  const manifest = buildClaimsManifest({});
  // The only manifest values a fixture cannot pin are the two ISO instants verifyLiveDeviceLineage()
  // mints from the wall clock when a device_verified row is written. They are replaced by a fixed
  // token for the comparison — and separately asserted to be real instants — so every other field,
  // hashes and provenance objects included, is still compared exactly.
  const OBSERVED_AT = "<fixture-observed-at>";
  const normalize = (value) => JSON.parse(JSON.stringify(value, (key, v) => (key === "identityObservedAt" || key === "observedAt" ? OBSERVED_AT : v)));
  const observedInstants = manifest.apps
    .flatMap((app) => app.claims)
    .flatMap((claim) => [claim.deviceIdentity?.identityObservedAt, claim.deviceLineage?.observedAt])
    .filter((value) => value !== undefined);
  if (observedInstants.length === 2 && observedInstants.every((value) => typeof value === "string" && Number.isFinite(Date.parse(value))))
    ok("the device row's two live-probe instants are real ISO timestamps (the only normalized fields)");
  else fail(`fixture device row did not carry exactly two parseable live-probe instants: ${JSON.stringify(observedInstants)}`);

  const expectedPath = path.resolve("test/fixtures/claims/expected-manifest.json");
  const actual = normalize(manifest);
  if (process.argv.includes("--update-fixture")) {
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const expected = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, "utf8")) : null;
  if (expected && JSON.stringify(actual) === JSON.stringify(expected)) ok("fixture ledger generates the committed expected manifest byte-for-byte");
  else fail("fixture manifest drifted from test/fixtures/claims/expected-manifest.json (re-run with --update-fixture ONLY after reviewing the diff)");

  if (!JSON.stringify(manifest).includes("alpha claim that was withdrawn")) ok("the retracted fixture row never reaches the generated manifest");
  else fail("a retracted fixture row is still published in the generated manifest");

  const strong = buildClaimsManifest({ minEvidence: "auto_judged" });
  const weakLeaked = Object.keys(strong.totals).some((t) => ["usd_host_render", "logcat", "structural", "compiles", "built_for_headset", "provenance-broken"].includes(t));
  if (!weakLeaked) ok("minEvidence=auto_judged drops weaker classes on the fixture ledger");
  else fail(`minEvidence filter leaked weaker evidence classes: ${JSON.stringify(strong.totals)}`);

  const fixtureHtml = renderClaimsHtml(manifest, "2026-09-16T00:00:00.000Z");
  const fixtureCaptures = manifest.apps.flatMap((app) => app.claims).filter((claim) => claim.capture?.sha256);
  if (fixtureCaptures.length > 0 && fixtureCaptures.every((claim) => fixtureHtml.includes(claim.capture.sha256)))
    ok(`fixture HTML surfaces every capture hash verbatim (${fixtureCaptures.length} rows)`);
  else fail("fixture HTML lost a capture hash");
} finally {
  if (priorDir === undefined) delete process.env.PICO_MCP_LEDGER_DIR; else process.env.PICO_MCP_LEDGER_DIR = priorDir;
  fs.rmSync(fixtureLedgerDir, { recursive: true, force: true });
}

// 3) the machine-specific comparison against the maintainer's REAL ledgers is opt-in: it is host
//    state, not a property of the source, and regenerating the tracked snapshot is a publication
//    decision rather than something this gate may demand on an arbitrary machine.
if (process.env.PICO_CLAIMS_LIVE_LEDGER === "1") {
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
} else {
  console.log("  skip live-ledger comparison (set PICO_CLAIMS_LIVE_LEDGER=1 on the ledger-owning machine to run it)");
}

console.log(`\nClaims-page test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
