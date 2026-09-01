import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appSpecSchema } from "../dist/appspec.js";
import {
  canonicalIdentity,
  canonicalJson,
  GRADLE_INPUT_MAX_ENTRIES,
  GRADLE_INPUT_MAX_FILE_BYTES,
  GRADLE_INPUT_MAX_TOTAL_BYTES,
} from "../dist/runreceiptidentity.js";
import * as store from "../dist/runreceiptstore.js";
import {
  FIXTURE_APP,
  authoredSpec,
  createRunReceiptFixture,
  effectiveSpec,
  effectiveSpecWithStoredBytes,
  makePng,
  sha256,
} from "./helpers/runreceipt-fixture.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ZERO_HASH = "0".repeat(64);
const EXPECTED_EFFECTIVE_SPEC_MAX_BYTES = 2 * 1024 * 1024;

function issueText(result) {
  return result.status === "invalid" ? result.issues.join("\n") : "";
}

async function withFixture(t, callback, options) {
  const fixture = await createRunReceiptFixture(t, store, options);
  return callback(fixture);
}

function publishFixtureReceipt(fixture, payload = fixture.payload) {
  return store.publishNativeRunReceipt(payload, fixture.storeOptions);
}

function setGradleEntries(payload, entries) {
  const identity = canonicalIdentity(entries);
  payload.source.gradleInputs = {
    ...payload.source.gradleInputs,
    sha256: identity.sha256,
    entryCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    entries,
  };
}

function rawReceipt(fixture, payload) {
  const receiptId = sha256(canonicalJson(payload));
  const receiptPath = path.join(fixture.rootDir, "native-v1", FIXTURE_APP, `${receiptId}.json`);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${canonicalJson({ ...payload, receiptId })}\n`);
  return { receiptId, receiptPath };
}

function maxGradleEntries() {
  const entries = [
    { path: "app/src/main/AndroidManifest.xml", bytes: 0, sha256: ZERO_HASH },
    { path: "app/src/main/java/com/example/MainActivity.kt", bytes: 0, sha256: ZERO_HASH },
    ...Array.from({ length: GRADLE_INPUT_MAX_ENTRIES - 2 }, (_, index) => ({
      path: `libs/${index.toString(36)}`,
      bytes: 0,
      sha256: ZERO_HASH,
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 0; index < GRADLE_INPUT_MAX_TOTAL_BYTES / GRADLE_INPUT_MAX_FILE_BYTES; index += 1) {
    entries[index].bytes = GRADLE_INPUT_MAX_FILE_BYTES;
  }
  return entries;
}

test("native receipt FIFO leaves fail closed without blocking the first snapshot open", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-runreceipt-fifo-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const receiptPath = path.join(rootDir, "native-v1", FIXTURE_APP, `${ZERO_HASH}.json`);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const fifo = spawnSync("mkfifo", [receiptPath], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  const moduleUrl = new URL("../dist/runreceiptstore.js", import.meta.url).href;
  const script = `
    import { readNativeRunReceipt } from ${JSON.stringify(moduleUrl)};
    const result = readNativeRunReceipt(process.argv[1], process.argv[2], { rootDir: process.argv[3] });
    if (result.status === "invalid" && /regular|snapshot|read/i.test(result.issues.join(" "))) process.exitCode = 0;
    else { console.error(JSON.stringify(result)); process.exitCode = 2; }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, FIXTURE_APP, ZERO_HASH, rootDir], {
    encoding: "utf8",
    timeout: 1_200,
    killSignal: "SIGTERM",
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `child signal: ${child.signal}\n${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
});

function maxGradleByteEntries() {
  return [
    { path: "app/src/main/AndroidManifest.xml", bytes: GRADLE_INPUT_MAX_FILE_BYTES, sha256: ZERO_HASH },
    { path: "app/src/main/java/com/example/MainActivity.kt", bytes: GRADLE_INPUT_MAX_FILE_BYTES, sha256: ZERO_HASH },
    { path: "libs/a", bytes: GRADLE_INPUT_MAX_FILE_BYTES, sha256: ZERO_HASH },
    { path: "libs/b", bytes: GRADLE_INPUT_MAX_FILE_BYTES, sha256: ZERO_HASH },
  ];
}

function exactGradleAllowlistViolations(payload) {
  const validEntries = payload.source.gradleInputs.entries;
  return [
    ["zero entries", []],
    ["missing Android manifest", validEntries.filter((entry) => !entry.path.endsWith("/AndroidManifest.xml"))],
    ["missing Kotlin or Java source", validEntries.filter((entry) => !/\.(?:kt|java)$/.test(entry.path))],
    ["normalized path outside V1 allowlist", [
      ...validEntries,
      { path: "README.md", bytes: 0, sha256: ZERO_HASH },
    ].sort((left, right) => left.path.localeCompare(right.path))],
    ["buildSrc build output", [
      ...validEntries,
      { path: "buildSrc/build/classes/kotlin/main/Generated.class", bytes: 0, sha256: ZERO_HASH },
    ].sort((left, right) => left.path.localeCompare(right.path))],
    ["nested Gradle cache", [
      ...validEntries,
      { path: "buildSrc/.gradle/cache.bin", bytes: 0, sha256: ZERO_HASH },
    ].sort((left, right) => left.path.localeCompare(right.path))],
    ["nested Git metadata", [
      ...validEntries,
      { path: "app/src/main/.git/index", bytes: 0, sha256: ZERO_HASH },
    ].sort((left, right) => left.path.localeCompare(right.path))],
    ["nested IDE metadata", [
      ...validEntries,
      { path: "gradle/.idea/workspace.xml", bytes: 0, sha256: ZERO_HASH },
    ].sort((left, right) => left.path.localeCompare(right.path))],
    ["buildSrc local properties", [
      ...validEntries,
      { path: "buildSrc/local.properties", bytes: 0, sha256: ZERO_HASH },
    ].sort((left, right) => left.path.localeCompare(right.path))],
    ["buildSrc project documentation", [
      ...validEntries,
      { path: "buildSrc/README.md", bytes: 0, sha256: ZERO_HASH },
    ].sort((left, right) => left.path.localeCompare(right.path))],
  ];
}

function withGradleEntries(payload, entries) {
  const changed = structuredClone(payload);
  setGradleEntries(changed, entries);
  return changed;
}

function storedEffectiveSpec(bytes, packageName = FIXTURE_APP) {
  const spec = effectiveSpecWithStoredBytes(bytes, packageName);
  assert.equal(appSpecSchema.safeParse(spec).success, true, "effective AppSpec boundary fixture must remain schema-valid");
  return spec;
}

const receiptIdentityMutations = [
  ["reserved session ID", (value) => { value.runtime.sessionId = "unknown"; }],
  ["malformed session ID", (value) => { value.runtime.sessionId = "11111111-2222-3333-4444-555555555555"; }],
  ["reserved serial", (value) => { value.runtime.serial = "placeholder"; }],
  ["reserved optimistic observation", (value) => { value.runtime.serial = "optimistic"; }],
  ["malformed serial", (value) => { value.runtime.serial = "PICO serial with spaces"; }],
  ["reserved model", (value) => { value.runtime.model = "unavailable"; }],
  ["reserved inferred observation", (value) => { value.runtime.model = "inferred"; }],
  ["malformed model", (value) => { value.runtime.model = "PICO\u0000 4"; }],
  ["reserved fingerprint", (value) => { value.runtime.fingerprint = "unknown"; }],
  ["malformed fingerprint", (value) => { value.runtime.fingerprint = "PICO 4 user build"; }],
  ["reserved boot-qemu", (value) => { value.runtime.bootQemu = "unknown"; }],
  ["malformed boot-qemu", (value) => { value.runtime.bootQemu = "2"; }],
  ["reserved boot ID", (value) => { value.runtime.bootId = "not-available"; }],
  ["malformed boot ID", (value) => { value.runtime.bootId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; }],
  ["reserved component", (value) => { value.runtime.component = "placeholder"; }],
  ["malformed component", (value) => { value.runtime.component = `${FIXTURE_APP} MainActivity`; }],
  ["reserved runtime PID ticks", (value) => { value.runtime.pidStartTicks = "unknown"; }],
  ["malformed runtime PID ticks", (value) => { value.runtime.pidStartTicks = "-1"; }],
  ["reserved foreground package", (value) => { value.capture.before.foregroundPackage = "unknown"; }],
  ["malformed foreground package", (value) => { value.capture.before.foregroundPackage = "PICO Receipt"; }],
  ["reserved foreground component", (value) => { value.capture.after.foregroundComponent = "pending"; }],
  ["malformed foreground component", (value) => { value.capture.after.foregroundComponent = `${FIXTURE_APP} MainActivity`; }],
  ["reserved observation PID ticks", (value) => { value.capture.before.pidStartTicks = "unset"; }],
  ["malformed observation PID ticks", (value) => { value.capture.after.pidStartTicks = "987654 ticks"; }],
];

test("receipt ID binds every payload section and canonical file bytes", async (t) => {
  await withFixture(t, (fixture) => {
    const first = publishFixtureReceipt(fixture);
    const parsed = JSON.parse(fs.readFileSync(first.receiptPath, "utf8"));
    assert.equal(parsed.receiptId, first.receiptId);
    assert.match(first.receiptId, HASH_PATTERN);
    assert.equal(fs.readFileSync(first.receiptPath, "utf8"), `${canonicalJson(parsed)}\n`);

    const payloadMutations = [
      ["package", (value) => { value.apk.packageName = "com.example.changed"; }],
      ["install digest", (value) => { value.install.acknowledgementSha256 = sha256("different install acknowledgement"); }],
      ["serial", (value) => { value.runtime.serial = "emulator-5556"; }],
      ["fingerprint", (value) => { value.runtime.fingerprint = "PICO/changed/fingerprint:14/changed/test-keys"; }],
      ["boot ID", (value) => { value.runtime.bootId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"; }],
      ["session ID", (value) => { value.runtime.sessionId = "22222222-3333-4444-8555-666666666666"; }],
      ["PID", (value) => { value.runtime.pid = 4343; value.capture.before.pid = 4343; value.capture.after.pid = 4343; }],
      ["PID start ticks", (value) => { value.runtime.pidStartTicks = "123456789"; value.capture.before.pidStartTicks = "123456789"; value.capture.after.pidStartTicks = "123456789"; }],
      ["foreground before", (value) => { value.capture.before.foregroundComponent = `${FIXTURE_APP}/.OtherActivity`; }],
      ["foreground after", (value) => { value.capture.after.foregroundComponent = `${FIXTURE_APP}/.OtherActivity`; }],
      ["capture hash", (value) => { value.capture.sha256 = ZERO_HASH; }],
    ];
    for (const [name, mutate] of payloadMutations) {
      const changedPayload = structuredClone(fixture.payload);
      mutate(changedPayload);
      const changed = publishFixtureReceipt(fixture, changedPayload);
      assert.notEqual(changed.receiptId, first.receiptId, `${name} must affect receipt identity`);
    }
  });
});

test("APK, spec, and receipt publication is create-only and rejects corrupt hash targets", async (t) => {
  await withFixture(t, async (fixture) => {
    const firstReceipt = publishFixtureReceipt(fixture);
    assert.deepEqual(await store.publishApkArtifact(fixture.sourceApkPath, fixture.storeOptions), {
      sourcePath: fs.realpathSync(fixture.sourceApkPath),
      artifactPath: fixture.payload.apk.artifactPath,
      sha256: fixture.payload.apk.sha256,
      bytes: fixture.apkBytes.length,
    });
    assert.deepEqual(store.publishEffectiveSpecArtifact(fixture.effectiveSpec, fixture.storeOptions), fixture.publishedSpec);
    assert.equal(publishFixtureReceipt(fixture).receiptId, firstReceipt.receiptId);

    fs.writeFileSync(fixture.payload.apk.artifactPath, "corrupt APK target");
    await assert.rejects(
      store.publishApkArtifact(fixture.sourceApkPath, fixture.storeOptions),
      /already exists|corrupt|sha256|refus/i,
    );
    assert.equal(fs.readFileSync(fixture.payload.apk.artifactPath, "utf8"), "corrupt APK target");

    fs.writeFileSync(fixture.publishedSpec.artifactPath, "corrupt spec target");
    assert.throws(
      () => store.publishEffectiveSpecArtifact(fixture.effectiveSpec, fixture.storeOptions),
      /already exists|corrupt|sha256|refus/i,
    );
    assert.equal(fs.readFileSync(fixture.publishedSpec.artifactPath, "utf8"), "corrupt spec target");

    fs.writeFileSync(firstReceipt.receiptPath, "corrupt receipt target");
    assert.throws(
      () => publishFixtureReceipt(fixture),
      /already exists|corrupt|sha256|refus/i,
    );
    assert.equal(fs.readFileSync(firstReceipt.receiptPath, "utf8"), "corrupt receipt target");

    const stagingFiles = fs.readdirSync(path.dirname(fixture.payload.apk.artifactPath))
      .filter((name) => name.startsWith("."));
    assert.deepEqual(stagingFiles, []);
  });
});

test("APK publication rejects a same-size source mutation and removes staging bytes", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-run-receipt-apk-race-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const rootDir = path.join(scratch, "store");
  const sourcePath = path.join(scratch, "racing.apk");
  const sourceBytes = 1024 * 1024 + 64;
  fs.writeFileSync(sourcePath, Buffer.alloc(sourceBytes, 0x61));
  const originalReadSync = fs.readSync;
  let mutated = false;
  fs.readSync = function (...args) {
    const count = originalReadSync.apply(this, args);
    if (!mutated && args[3] === 1024 * 1024) {
      mutated = true;
      fs.writeFileSync(sourcePath, Buffer.alloc(sourceBytes, 0x62));
    }
    return count;
  };
  try {
    await assert.rejects(store.publishApkArtifact(sourcePath, { rootDir }), /changed while being copied/i);
    assert.equal(mutated, true);
  } finally {
    fs.readSync = originalReadSync;
  }
  const artifactDirectory = path.join(rootDir, "artifacts", "apk");
  assert.deepEqual(fs.readdirSync(artifactDirectory), []);
});

test("publication uses exact CAS paths and unsafe app keys cannot create directories", async (t) => {
  await withFixture(t, (fixture) => {
    const published = publishFixtureReceipt(fixture);
    assert.equal(
      published.receiptPath,
      path.join(fixture.rootDir, "native-v1", FIXTURE_APP, `${published.receiptId}.json`),
    );
    assert.equal(
      fixture.payload.apk.artifactPath,
      path.join(fixture.rootDir, "artifacts", "apk", `${fixture.payload.apk.sha256}.apk`),
    );
    assert.equal(
      fixture.publishedSpec.artifactPath,
      path.join(fixture.rootDir, "artifacts", "spec", `${fixture.publishedSpec.sha256}.json`),
    );
    const specCanonical = canonicalJson(fixture.effectiveSpec);
    assert.equal(fs.readFileSync(fixture.publishedSpec.artifactPath, "utf8"), `${specCanonical}\n`);
    assert.equal(fixture.publishedSpec.bytes, Buffer.byteLength(specCanonical));

    for (const unsafe of ["../escape", "Com.Example.Receipt", ".hidden", "a/b", ""] ) {
      const payload = structuredClone(fixture.payload);
      payload.app = unsafe;
      assert.throws(() => publishFixtureReceipt(fixture, payload), /invalid app|app.*key|lowercase/i);
    }
    assert.equal(fs.existsSync(path.join(fixture.rootDir, "escape")), false);
  });
});

test("effective AppSpec publication and historical reading share one exact stored-byte boundary", async (t) => {
  await withFixture(t, (fixture) => {
    assert.equal(store.EFFECTIVE_APP_SPEC_MAX_BYTES, EXPECTED_EFFECTIVE_SPEC_MAX_BYTES);
    const boundarySpec = storedEffectiveSpec(store.EFFECTIVE_APP_SPEC_MAX_BYTES);
    const publishedSpec = store.publishEffectiveSpecArtifact(boundarySpec, fixture.storeOptions);
    assert.equal(fs.statSync(publishedSpec.artifactPath).size, store.EFFECTIVE_APP_SPEC_MAX_BYTES);

    const boundaryPayload = structuredClone(fixture.payload);
    boundaryPayload.source.effectiveAppSpec = publishedSpec;
    const boundaryReceipt = publishFixtureReceipt(fixture, boundaryPayload);
    assert.equal(
      store.readNativeRunReceipt(FIXTURE_APP, boundaryReceipt.receiptId, fixture.storeOptions).status,
      "valid",
    );

    const oversized = storedEffectiveSpec(store.EFFECTIVE_APP_SPEC_MAX_BYTES + 1);
    assert.throws(
      () => store.publishEffectiveSpecArtifact(oversized, fixture.storeOptions),
      /effective AppSpec|stored|byte|limit|2097152/i,
    );
  });
});

test("publisher rejects Gradle manifests outside the exact V1 allowlist or mandatory presence", async (t) => {
  await withFixture(t, (fixture) => {
    for (const [name, entries] of exactGradleAllowlistViolations(fixture.payload)) {
      assert.throws(
        () => publishFixtureReceipt(fixture, withGradleEntries(fixture.payload, entries)),
        /Gradle|allowlist|AndroidManifest|Kotlin|Java|entry/i,
        name,
      );
    }
  });
});

test("raw historical reader rejects Gradle manifests outside the exact V1 allowlist or mandatory presence", async (t) => {
  await withFixture(t, (fixture) => {
    for (const [name, entries] of exactGradleAllowlistViolations(fixture.payload)) {
      const payload = withGradleEntries(fixture.payload, entries);
      const written = rawReceipt(fixture, payload);
      const result = store.readNativeRunReceipt(FIXTURE_APP, written.receiptId, fixture.storeOptions);
      assert.equal(result.status, "invalid", name);
      assert.match(issueText(result), /Gradle|allowlist|AndroidManifest|Kotlin|Java|entry/i, name);
    }
  });
});

test("publisher and raw reader accept selected files below documentation-named buildSrc directories", async (t) => {
  await withFixture(t, (fixture) => {
    const entries = [
      ...fixture.payload.source.gradleInputs.entries,
      { path: "buildSrc/README.md/Plugin.kt", bytes: 0, sha256: ZERO_HASH },
      { path: "buildSrc/local.properties/Config.kt", bytes: 0, sha256: ZERO_HASH },
    ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const payload = withGradleEntries(fixture.payload, entries);
    assert.doesNotThrow(() => publishFixtureReceipt(fixture, payload));
    const written = rawReceipt(fixture, payload);
    assert.equal(store.readNativeRunReceipt(FIXTURE_APP, written.receiptId, fixture.storeOptions).status, "valid");
  });
});

test("strict schemas reject unknown keys at every nested receipt object and union", async (t) => {
  await withFixture(t, (fixture) => {
    const mutations = [
      ["payload", (value) => { value.unknown = true; }],
      ["source", (value) => { value.source.unknown = true; }],
      ["authored identity", (value) => { value.source.authoredAppSpec.unknown = true; }],
      ["effective identity", (value) => { value.source.effectiveAppSpec.unknown = true; }],
      ["Gradle identity", (value) => { value.source.gradleInputs.unknown = true; }],
      ["Gradle entry", (value) => { value.source.gradleInputs.entries[0].unknown = true; }],
      ["build", (value) => { value.build.unknown = true; }],
      ["output metadata", (value) => { value.build.outputMetadata.unknown = true; }],
      ["APK", (value) => { value.apk.unknown = true; }],
      ["manifest union", (value) => { value.apk.manifestInspection.unknown = true; }],
      ["signing union", (value) => { value.apk.signingInspection.unknown = true; }],
      ["install", (value) => { value.install.unknown = true; }],
      ["runtime", (value) => { value.runtime.unknown = true; }],
      ["capture", (value) => { value.capture.unknown = true; }],
      ["before observation", (value) => { value.capture.before.unknown = true; }],
      ["after observation", (value) => { value.capture.after.unknown = true; }],
    ];
    for (const [name, mutate] of mutations) {
      const payload = structuredClone(fixture.payload);
      mutate(payload);
      assert.throws(() => publishFixtureReceipt(fixture, payload), /unrecognized|unknown|invalid/i, name);
    }
    const invalidUnion = structuredClone(fixture.payload);
    invalidUnion.apk.manifestInspection.status = "guessed";
    assert.throws(() => publishFixtureReceipt(fixture, invalidUnion), /invalid|status|union/i);
  });
});

test("publisher rejects reserved or malformed mandatory identities without excluding PICO-shaped observations", async (t) => {
  await withFixture(t, (fixture) => {
    for (const [name, mutate] of receiptIdentityMutations) {
      const payload = structuredClone(fixture.payload);
      mutate(payload);
      assert.throws(
        () => publishFixtureReceipt(fixture, payload),
        /session|serial|model|fingerprint|boot|component|foreground|package|pid|identity|invalid/i,
        name,
      );
    }

    const picoPayload = structuredClone(fixture.payload);
    picoPayload.runtime.sessionId = "7ad551b8-98fa-4db2-a8e7-d41f86097992";
    picoPayload.runtime.serial = "PICO4U-A7H1234567";
    picoPayload.runtime.model = "PICO 4 Ultra Enterprise";
    picoPayload.runtime.fingerprint = "PICO/A9210/PICOA9210:14/UP1A.231005.007/20260814:user/release-keys";
    picoPayload.runtime.bootQemu = ""; // Physical PICO getprop commonly reports the exact absent value.
    picoPayload.runtime.bootId = "f1927646-a41d-4d88-b50f-8aa6873351df";
    const published = publishFixtureReceipt(fixture, picoPayload);
    assert.equal(store.readNativeRunReceipt(FIXTURE_APP, published.receiptId, fixture.storeOptions).status, "valid");
  });
});

test("raw reader independently rejects reserved or malformed mandatory identities", async (t) => {
  await withFixture(t, (fixture) => {
    for (const [name, mutate] of receiptIdentityMutations) {
      const payload = structuredClone(fixture.payload);
      mutate(payload);
      const written = rawReceipt(fixture, payload);
      const result = store.readNativeRunReceipt(FIXTURE_APP, written.receiptId, fixture.storeOptions);
      assert.equal(result.status, "invalid", name);
      assert.match(
        issueText(result),
        /session|serial|model|fingerprint|boot|component|foreground|package|pid|identity|invalid/i,
        name,
      );
    }
  });
});

test("publisher enforces every Gradle manifest maximum within the independent receipt envelope bound", async (t) => {
  await withFixture(t, (fixture) => {
    const entryBoundary = structuredClone(fixture.payload);
    setGradleEntries(entryBoundary, maxGradleEntries());
    assert.equal(entryBoundary.source.gradleInputs.entryCount, GRADLE_INPUT_MAX_ENTRIES);
    assert.throws(
      () => publishFixtureReceipt(fixture, entryBoundary),
      /receipt.*2097152|receipt.*byte.*limit/i,
      "the exact allowlisted entry-count boundary is larger than the independent 2 MiB receipt envelope",
    );

    const byteBoundary = structuredClone(fixture.payload);
    setGradleEntries(byteBoundary, maxGradleByteEntries());
    assert.equal(byteBoundary.source.gradleInputs.totalBytes, GRADLE_INPUT_MAX_TOTAL_BYTES);
    assert.equal(byteBoundary.source.gradleInputs.entries[0].bytes, GRADLE_INPUT_MAX_FILE_BYTES);
    assert.doesNotThrow(() => publishFixtureReceipt(fixture, byteBoundary));

    const overEntries = structuredClone(fixture.payload);
    setGradleEntries(overEntries, [
      ...maxGradleEntries(),
      { path: "libs/overflow", bytes: 0, sha256: ZERO_HASH },
    ]);
    assert.throws(() => publishFixtureReceipt(fixture, overEntries), /entries|array|20000|too big|maximum/i);

    const overEntryCount = structuredClone(fixture.payload);
    overEntryCount.source.gradleInputs.entryCount = GRADLE_INPUT_MAX_ENTRIES + 1;
    assert.throws(() => publishFixtureReceipt(fixture, overEntryCount), /entryCount|20000|too big|maximum/i);

    const overTotal = structuredClone(fixture.payload);
    setGradleEntries(overTotal, [
      ...maxGradleByteEntries(),
      { path: "libs/c", bytes: GRADLE_INPUT_MAX_FILE_BYTES, sha256: ZERO_HASH },
    ]);
    assert.throws(() => publishFixtureReceipt(fixture, overTotal), /totalBytes|2147483648|too big|maximum/i);

    const overFile = structuredClone(fixture.payload);
    setGradleEntries(overFile, [
      { path: "app/src/main/AndroidManifest.xml", bytes: 0, sha256: ZERO_HASH },
      { path: "app/src/main/java/com/example/MainActivity.kt", bytes: GRADLE_INPUT_MAX_FILE_BYTES + 1, sha256: ZERO_HASH },
    ]);
    assert.throws(() => publishFixtureReceipt(fixture, overFile), /bytes|536870912|too big|maximum/i);

    const wrongEntryCount = structuredClone(fixture.payload);
    wrongEntryCount.source.gradleInputs.entryCount += 1;
    assert.throws(() => publishFixtureReceipt(fixture, wrongEntryCount), /entryCount|entries|match/i);

    const wrongTotalBytes = structuredClone(fixture.payload);
    wrongTotalBytes.source.gradleInputs.totalBytes += 1;
    assert.throws(() => publishFixtureReceipt(fixture, wrongTotalBytes), /totalBytes|byte total|match/i);

    const wrongManifestHash = structuredClone(fixture.payload);
    wrongManifestHash.source.gradleInputs.sha256 = ZERO_HASH;
    assert.throws(() => publishFixtureReceipt(fixture, wrongManifestHash), /manifest|sha256|canonical/i);

    const unsafePath = structuredClone(fixture.payload);
    const unsafeEntries = structuredClone(unsafePath.source.gradleInputs.entries);
    unsafeEntries[0].path = "../escape";
    setGradleEntries(unsafePath, unsafeEntries);
    assert.throws(() => publishFixtureReceipt(fixture, unsafePath), /path|POSIX|relative|normalized/i);
  });
});

test("raw reader independently enforces every Gradle manifest maximum and exact cross-field totals", async (t) => {
  await withFixture(t, (fixture) => {
    const entryBoundary = structuredClone(fixture.payload);
    setGradleEntries(entryBoundary, maxGradleEntries());
    const entryBoundaryReceipt = rawReceipt(fixture, entryBoundary);
    assert.equal(
      store.readNativeRunReceipt(FIXTURE_APP, entryBoundaryReceipt.receiptId, fixture.storeOptions).status,
      "invalid",
    );

    const byteBoundary = structuredClone(fixture.payload);
    setGradleEntries(byteBoundary, maxGradleByteEntries());
    const boundaryReceipt = rawReceipt(fixture, byteBoundary);
    assert.equal(
      store.readNativeRunReceipt(FIXTURE_APP, boundaryReceipt.receiptId, fixture.storeOptions).status,
      "valid",
    );

    const cases = [
      ["entries", (value) => setGradleEntries(value, [
        ...maxGradleEntries(),
        { path: "libs/overflow", bytes: 0, sha256: ZERO_HASH },
      ]), /entries|array|20000|too big|maximum|receipt.*(?:2097152|limit)/i],
      ["entryCount", (value) => { value.source.gradleInputs.entryCount = GRADLE_INPUT_MAX_ENTRIES + 1; }, /entryCount|20000|too big|maximum/i],
      ["totalBytes", (value) => setGradleEntries(value, [
        ...maxGradleByteEntries(),
        { path: "libs/c", bytes: GRADLE_INPUT_MAX_FILE_BYTES, sha256: ZERO_HASH },
      ]), /totalBytes|2147483648|too big|maximum/i],
      ["per-file bytes", (value) => setGradleEntries(value, [
        { path: "app/src/main/AndroidManifest.xml", bytes: 0, sha256: ZERO_HASH },
        { path: "app/src/main/java/com/example/MainActivity.kt", bytes: GRADLE_INPUT_MAX_FILE_BYTES + 1, sha256: ZERO_HASH },
      ]), /bytes|536870912|too big|maximum/i],
      ["entry count relationship", (value) => { value.source.gradleInputs.entryCount += 1; }, /entryCount|entries|match/i],
      ["total bytes relationship", (value) => { value.source.gradleInputs.totalBytes += 1; }, /totalBytes|byte total|match/i],
      ["manifest digest relationship", (value) => { value.source.gradleInputs.sha256 = ZERO_HASH; }, /manifest|sha256|canonical/i],
      ["normalized path relationship", (value) => {
        const entries = structuredClone(value.source.gradleInputs.entries);
        entries[0].path = "../escape";
        setGradleEntries(value, entries);
      }, /path|POSIX|relative|normalized|allowlist/i],
    ];
    for (const [name, mutate, expected] of cases) {
      const payload = structuredClone(fixture.payload);
      mutate(payload);
      const written = rawReceipt(fixture, payload);
      const result = store.readNativeRunReceipt(FIXTURE_APP, written.receiptId, fixture.storeOptions);
      assert.equal(result.status, "invalid", name);
      assert.match(issueText(result), expected, name);
    }
  });
});

test("historical validation independently detects receipt and CAS tampering", async (t) => {
  const cases = [
    ["noncanonical receipt bytes", (fixture, published) => {
      const parsed = JSON.parse(fs.readFileSync(published.receiptPath, "utf8"));
      fs.writeFileSync(published.receiptPath, `${JSON.stringify(parsed, null, 2)}\n`);
    }, /canonical/i],
    ["recomputed receipt ID mismatch", (fixture, published) => {
      const parsed = JSON.parse(fs.readFileSync(published.receiptPath, "utf8"));
      parsed.runtime.serial = "emulator-5560";
      fs.writeFileSync(published.receiptPath, `${canonicalJson(parsed)}\n`);
    }, /receipt.*ID|digest|hash/i],
    ["APK CAS mutation", (fixture) => {
      fs.writeFileSync(fixture.payload.apk.artifactPath, "changed APK CAS");
    }, /APK|sha256|bytes/i],
    ["effective spec mutation", (fixture) => {
      fs.writeFileSync(fixture.publishedSpec.artifactPath, `${canonicalJson(effectiveSpec("com.example.changed"))}\n`);
    }, /effective|spec|sha256/i],
    ["capture CAS mutation", (fixture) => {
      fs.writeFileSync(fixture.captureArtifactPath, makePng(99));
    }, /capture|sha256/i],
    ["unknown nested key", (fixture, published) => {
      const parsed = JSON.parse(fs.readFileSync(published.receiptPath, "utf8"));
      parsed.capture.before.unknown = true;
      fs.writeFileSync(published.receiptPath, `${canonicalJson(parsed)}\n`);
    }, /unrecognized|unknown|capture.*before/i],
    ["unknown schema", (fixture, published) => {
      const parsed = JSON.parse(fs.readFileSync(published.receiptPath, "utf8"));
      parsed.schemaVersion = 2;
      fs.writeFileSync(published.receiptPath, `${canonicalJson(parsed)}\n`);
    }, /schemaVersion|literal|invalid/i],
    ["unknown kind", (fixture, published) => {
      const parsed = JSON.parse(fs.readFileSync(published.receiptPath, "utf8"));
      parsed.kind = "pico.unknown-receipt";
      fs.writeFileSync(published.receiptPath, `${canonicalJson(parsed)}\n`);
    }, /kind|literal|invalid/i],
    ["oversized receipt", (fixture, published) => {
      fs.truncateSync(published.receiptPath, store.RUN_RECEIPT_MAX_BYTES + 1);
    }, /limit|exceed|2097152/i],
  ];

  for (const [name, mutate, expected] of cases) {
    await t.test(name, async (child) => {
      const fixture = await createRunReceiptFixture(child, store);
      const published = publishFixtureReceipt(fixture);
      mutate(fixture, published);
      const result = store.readNativeRunReceipt(FIXTURE_APP, published.receiptId, fixture.storeOptions);
      assert.equal(result.status, "invalid");
      assert.match(issueText(result), expected);
    });
  }

  await t.test("filename mismatch", async (child) => {
    const fixture = await createRunReceiptFixture(child, store);
    const published = publishFixtureReceipt(fixture);
    const mismatchedPath = path.join(path.dirname(published.receiptPath), `${ZERO_HASH}.json`);
    fs.copyFileSync(published.receiptPath, mismatchedPath);
    const result = store.readNativeRunReceipt(FIXTURE_APP, ZERO_HASH, fixture.storeOptions);
    assert.equal(result.status, "invalid");
    assert.match(issueText(result), /filename|receipt.*ID|requested/i);
  });
});

test("historical validation rejects package, install, runtime, and capture cross-field disagreement", async (t) => {
  const mutations = [
    ["APK package", (value) => { value.apk.packageName = "com.example.changed"; }],
    ["manifest package", (value) => { value.apk.manifestInspection.packageName = "com.example.changed"; }],
    ["install package", (value) => { value.install.packageName = "com.example.changed"; }],
    ["remote APK digest", (value) => { value.install.remoteApkSha256 = ZERO_HASH; }],
    ["runtime component", (value) => { value.runtime.component = "com.example.changed/.Main"; }],
    ["before package", (value) => { value.capture.before.foregroundPackage = "com.example.changed"; }],
    ["before component", (value) => { value.capture.before.foregroundComponent = "com.example.changed/.Main"; }],
    ["after PID", (value) => { value.capture.after.pid = 9999; }],
    ["after PID start", (value) => { value.capture.after.pidStartTicks = "1"; }],
    ["Gradle entry count", (value) => { value.source.gradleInputs.entryCount += 1; }],
    ["Gradle total bytes", (value) => { value.source.gradleInputs.totalBytes += 1; }],
    ["Gradle manifest digest", (value) => { value.source.gradleInputs.sha256 = ZERO_HASH; }],
    ["build time order", (value) => { value.build.startedAt = "2026-08-14T12:01:00.000Z"; }],
    ["capture time bracket", (value) => { value.capture.before.observedAt = "2026-08-14T11:59:52.000Z"; }],
  ];
  await withFixture(t, (fixture) => {
    for (const [name, mutate] of mutations) {
      const payload = structuredClone(fixture.payload);
      mutate(payload);
      const written = rawReceipt(fixture, payload);
      const result = store.readNativeRunReceipt(FIXTURE_APP, written.receiptId, fixture.storeOptions);
      assert.equal(result.status, "invalid", name);
      assert.match(issueText(result), /package|component|PID|digest|sha256|entries|bytes|time|before|later|agree|match/i, name);
    }
  });
});

test("current validation detects mutable authored, Gradle, APK, project, and AGP changes", async (t) => {
  const cases = [
    ["authored spec", (fixture) => {
      fs.writeFileSync(fixture.briefPath, JSON.stringify({ brief: "changed", spec: authoredSpec("com.example.authoredchanged") }));
    }, /authored|AppSpec/i],
    ["Gradle input", (fixture) => {
      fs.appendFileSync(path.join(fixture.projectDir, "app/src/main/assets/scene.json"), "changed\n");
    }, /Gradle|input/i],
    ["source APK", (fixture) => {
      fs.writeFileSync(fixture.sourceApkPath, "changed source APK");
    }, /source APK|APK source/i],
    ["AGP output metadata", (fixture) => {
      fs.writeFileSync(fixture.outputMetadataPath, `${JSON.stringify({ ...fixture.outputMetadata, applicationId: "com.example.changed" })}\n`);
    }, /output metadata|AGP|applicationId/i],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async (child) => {
      const fixture = await createRunReceiptFixture(child, store);
      const published = publishFixtureReceipt(fixture);
      mutate(fixture);
      const historical = store.readNativeRunReceipt(FIXTURE_APP, published.receiptId, fixture.storeOptions);
      assert.equal(historical.status, "valid");
      assert.equal(historical.mode, "historical");
      const current = store.readNativeRunReceipt(FIXTURE_APP, published.receiptId, {
        ...fixture.storeOptions,
        mode: "current",
        projectDir: fixture.projectDir,
      });
      assert.equal(current.status, "invalid");
      assert.match(issueText(current), expected);
    });
  }

  await t.test("project real path", async (child) => {
    const fixture = await createRunReceiptFixture(child, store);
    const other = await createRunReceiptFixture(child, store, { app: "com.example.other" });
    const published = publishFixtureReceipt(fixture);
    const current = store.readNativeRunReceipt(FIXTURE_APP, published.receiptId, {
      ...fixture.storeOptions,
      mode: "current",
      projectDir: other.projectDir,
    });
    assert.equal(current.status, "invalid");
    assert.match(issueText(current), /project.*path|projectDir|real path/i);
  });
});

test("historical validation survives moved source paths while current validation fails closed", async (t) => {
  await withFixture(t, (fixture) => {
    const published = publishFixtureReceipt(fixture);
    const movedProject = path.join(fixture.scratch, "moved-project");
    const movedBrief = path.join(fixture.scratch, "moved-brief.json");
    fs.renameSync(fixture.projectDir, movedProject);
    fs.renameSync(fixture.briefPath, movedBrief);

    const historical = store.readNativeRunReceipt(FIXTURE_APP, published.receiptId, fixture.storeOptions);
    assert.equal(historical.status, "valid");
    assert.equal(historical.mode, "historical");
    const current = store.readNativeRunReceipt(FIXTURE_APP, published.receiptId, {
      ...fixture.storeOptions,
      mode: "current",
      projectDir: movedProject,
    });
    assert.equal(current.status, "invalid");
    assert.match(issueText(current), /project|authored|Gradle|source APK|metadata/i);
  });
});

test("scanning reports overflow and malformed candidates and selects newest valid deterministically", async (t) => {
  await withFixture(t, (fixture) => {
    const first = publishFixtureReceipt(fixture);
    const laterPayload = structuredClone(fixture.payload);
    laterPayload.createdAt = "2026-08-14T13:00:00.000Z";
    laterPayload.runtime.sessionId = "33333333-4444-4555-8666-777777777777";
    const later = publishFixtureReceipt(fixture, laterPayload);
    const tiedPayload = structuredClone(laterPayload);
    tiedPayload.runtime.sessionId = "44444444-5555-4666-8777-888888888888";
    const tied = publishFixtureReceipt(fixture, tiedPayload);
    const malformedId = "f".repeat(64);
    fs.writeFileSync(path.join(path.dirname(first.receiptPath), `${malformedId}.json`), "not JSON\n");

    const selection = store.findHistoricalNativeRunReceipt(FIXTURE_APP, fixture.storeOptions);
    assert.equal(selection.status, "valid");
    const expectedId = [later.receiptId, tied.receiptId].sort()[0];
    assert.equal(selection.receipt.receiptId, expectedId);
    assert.deepEqual(selection.rejectedCandidates.map((candidate) => candidate.receiptId), [malformedId]);
    assert.match(selection.rejectedCandidates[0].issues.join("\n"), /JSON|parse|canonical/i);

    const offsetPayload = structuredClone(fixture.payload);
    offsetPayload.createdAt = "2026-08-14T07:00:00.000-07:00";
    offsetPayload.runtime.sessionId = "55555555-6666-4777-8888-999999999999";
    const chronologicallyNewest = publishFixtureReceipt(fixture, offsetPayload);
    const timeSelection = store.findHistoricalNativeRunReceipt(FIXTURE_APP, fixture.storeOptions);
    assert.equal(timeSelection.status, "valid");
    assert.equal(timeSelection.receipt.receiptId, chronologicallyNewest.receiptId);

    const currentSelection = store.findCurrentNativeRunReceipt(FIXTURE_APP, fixture.projectDir, fixture.storeOptions);
    assert.equal(currentSelection.status, "valid");
    assert.equal(currentSelection.receipt.receiptId, chronologicallyNewest.receiptId);
  });

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pico-run-receipt-empty-"));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
  assert.deepEqual(store.findHistoricalNativeRunReceipt(FIXTURE_APP, { rootDir: emptyRoot }), {
    status: "none",
    rejectedCandidates: [],
  });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-run-receipt-overflow-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const appDir = path.join(scratch, "native-v1", FIXTURE_APP);
  fs.mkdirSync(appDir, { recursive: true });
  for (let index = 0; index < store.RUN_RECEIPT_MAX_PER_APP + 1; index += 1) {
    fs.writeFileSync(path.join(appDir, `${index.toString(16).padStart(64, "0")}.json`), "{}\n");
  }
  const overflow = store.findHistoricalNativeRunReceipt(FIXTURE_APP, { rootDir: scratch });
  assert.equal(overflow.status, "invalid-store");
  assert.match(overflow.issues.join("\n"), /4096|overflow|too many|limit/i);
});

test("capture binding rejects wrong app, receipt, and frame and returns only structural binding fields", async (t) => {
  await withFixture(t, (fixture) => {
    const published = publishFixtureReceipt(fixture);
    const wrongCapture = path.join(fixture.scratch, "wrong-capture.png");
    fs.writeFileSync(wrongCapture, makePng(177));

    for (const result of [
      store.validateNativeRunReceiptCaptureBinding("com.example.other", published.receiptId, fixture.captureSourcePath, fixture.storeOptions),
      store.validateNativeRunReceiptCaptureBinding(FIXTURE_APP, ZERO_HASH, fixture.captureSourcePath, fixture.storeOptions),
      store.validateNativeRunReceiptCaptureBinding(FIXTURE_APP, published.receiptId, wrongCapture, fixture.storeOptions),
    ]) {
      assert.equal(result.status, "invalid");
      assert.match(result.reason, /app|receipt|capture|sha256|exist|match/i);
    }

    const valid = store.validateNativeRunReceiptCaptureBinding(
      FIXTURE_APP,
      published.receiptId,
      fixture.captureSourcePath,
      fixture.storeOptions,
    );
    assert.deepEqual(valid, {
      status: "valid",
      binding: {
        kind: "pico.native-run-receipt",
        schemaVersion: 1,
        receiptId: published.receiptId,
        captureSha256: fixture.payload.capture.sha256,
      },
    });
    assert.deepEqual(Object.keys(valid.binding).sort(), ["captureSha256", "kind", "receiptId", "schemaVersion"]);
  });
});

test("runReceiptDirectory honors the hermetic environment override", () => {
  const previous = process.env.PICO_MCP_RUN_RECEIPT_DIR;
  const override = path.join(os.tmpdir(), `pico-receipt-root-${crypto.randomUUID()}`);
  process.env.PICO_MCP_RUN_RECEIPT_DIR = override;
  try {
    assert.equal(store.runReceiptDirectory(), path.resolve(override));
  } finally {
    if (previous === undefined) delete process.env.PICO_MCP_RUN_RECEIPT_DIR;
    else process.env.PICO_MCP_RUN_RECEIPT_DIR = previous;
  }
});
