// Task S6 — the reviewed compatibility payload must survive INSTALLATION, not just the checkout.
//
// The packaging risk this suite exists to catch: `data/sdk-compatibility/` is resolved from
// `dist/declarationcontext.js`'s own module URL, so a tarball that ships `dist/` without that data
// installs a server whose declaration authority silently degrades — `readCompatibilityIndex()`
// answers `index-missing`, every lookup stays historical, and nothing in the build says why.
//
// So everything here runs against a RELOCATED package fixture: a temp directory holding only
// `dist/`, `data/sdk-compatibility/` and `package.json` — no `docs/`, no `test/`, no fixtures, no
// `node_modules/`. The canary (`scripts/verify-sdk-compatibility-payload.mjs`) is run against it
// from an UNRELATED working directory, in-process and again in a child process, so a canary that
// quietly resolved its data from `process.cwd()` or from this source checkout would answer about
// the wrong tree.
//
// Hermetic and read-only outside its own temp directories. The only process started is `node`
// running the canary; no CLI, provider, Java, Gradle, emulator or native binary is launched, and
// the repository's own `data/` is only ever READ.
//
// Run: npm run build && node --test test/declarationcontext-installed.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANARY_PATH = path.join(repoRoot, "scripts", "verify-sdk-compatibility-payload.mjs");
const DATA_REL = path.join("data", "sdk-compatibility");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

const { verifySdkCompatibilityPayload } = await import(pathToFileURL(CANARY_PATH).href);

const temps = [];
const temp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

/**
 * A relocated installation: dist/, data/sdk-compatibility/ and package.json, and nothing else.
 * `dist/` is copied whole so the fixture is a real package layout rather than a hand-picked
 * subset; `declarationcontext.js` pulls in only `./projectidentity.js` and node builtins, which
 * is why no `node_modules/` is needed to import it.
 */
function relocate(prefix) {
  const root = temp(prefix);
  fs.cpSync(path.join(repoRoot, "dist"), path.join(root, "dist"), { recursive: true });
  fs.cpSync(path.join(repoRoot, DATA_REL), path.join(root, DATA_REL), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "pico-spatial-mcp", version: "0.0.0-relocated-fixture", type: "module", main: "dist/index.js" }, null, 2) + "\n",
  );
  return root;
}

/** The fixture's own copy of the SDK module, whose data dir is the fixture's, not this repo's. */
const moduleOf = (root) => import(pathToFileURL(path.join(root, "dist", "declarationcontext.js")).href);

const dataFile = (root, rel) => path.join(root, DATA_REL, ...rel.split("/"));
const readIndex = (root) => JSON.parse(fs.readFileSync(dataFile(root, "index.v1.json"), "utf8"));
const writeIndex = (root, index) => fs.writeFileSync(dataFile(root, "index.v1.json"), JSON.stringify(index, null, 2) + "\n");

// ═══ 1. the canary resolves from packageRoot only ══════════════════════════════════════════════

test("the canary verifies the packaged index and every referenced byte, resolving from packageRoot and never from the working directory", () => {
  const installed = relocate("pico-s6-installed-");
  const unrelated = temp("pico-s6-unrelated-cwd-");

  const source = verifySdkCompatibilityPayload(repoRoot);
  assert.equal(source.ok, true, JSON.stringify(source.errors));
  assert.deepEqual(source.errors, []);
  // The index itself plus every file it references, each as a package-relative posix path.
  assert.ok(source.checked.some((f) => f.path === "data/sdk-compatibility/index.v1.json"), JSON.stringify(source.checked));
  assert.ok(source.checked.every((f) => f.path.startsWith("data/sdk-compatibility/") && !f.path.includes("\\")), JSON.stringify(source.checked));
  assert.ok(source.checked.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), JSON.stringify(source.checked));
  assert.equal(source.checked.length, 3, "index + the two packaged historical references");

  // The SAME bytes at a different location produce the SAME identities.
  const relocated = verifySdkCompatibilityPayload(installed);
  assert.equal(relocated.ok, true, JSON.stringify(relocated.errors));
  assert.deepEqual(relocated.checked, source.checked, "a relocated package must hash identically");

  // …and it answers about the root it was HANDED, from a working directory that has no data at all.
  const child = spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(pathToFileURL(CANARY_PATH).href)}).then((m) => process.stdout.write(JSON.stringify(m.verifySdkCompatibilityPayload(${JSON.stringify(installed)})))).catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(3); });`],
    { cwd: unrelated, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), relocated, "the canary answered differently when run from another cwd");

  // A root with no packaged data is a failure that NAMES the root — never a silent pass.
  const empty = verifySdkCompatibilityPayload(unrelated);
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.checked, []);
  assert.ok(empty.errors.some((e) => e.includes(unrelated)), JSON.stringify(empty.errors));
  assert.ok(empty.errors.some((e) => /index/.test(e)), JSON.stringify(empty.errors));
});

test("an empty reviewed mapping list is valid; a missing index is not", () => {
  const installed = relocate("pico-s6-installed-empty-");
  assert.deepEqual(readIndex(installed).records, [], "the packaged index ships no reviewed records yet");
  assert.equal(verifySdkCompatibilityPayload(installed).ok, true);

  fs.rmSync(dataFile(installed, "index.v1.json"));
  const missing = verifySdkCompatibilityPayload(installed);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes("index.v1.json")), JSON.stringify(missing.errors));
});

// ═══ 2. the relocated module loads its own historical references ═══════════════════════════════

test("the relocated package loads its historical references through its own module URL, with no docs/ or test/ present", async () => {
  const installed = relocate("pico-s6-installed-load-");
  assert.deepEqual(fs.readdirSync(installed).sort(), ["data", "dist", "package.json"]);
  for (const absent of ["docs", "test", "node_modules", "appskeleton"]) {
    assert.equal(fs.existsSync(path.join(installed, absent)), false, `the relocated fixture must not carry ${absent}/`);
  }

  const sdk = await moduleOf(installed);
  // Node's ESM loader canonicalizes the module URL, so the data dir the module derives from it is
  // the CANONICAL fixture path (/private/var/… on macOS). What matters is that it is inside THIS
  // package and not the repository's own data directory.
  const canonical = fs.realpathSync(installed);
  assert.equal(sdk.SDK_COMPATIBILITY_DATA_DIR, path.join(canonical, DATA_REL), "the module resolved data outside its own package");
  assert.equal(sdk.SDK_COMPATIBILITY_INDEX_PATH, path.join(canonical, DATA_REL, "index.v1.json"));
  assert.ok(!sdk.SDK_COMPATIBILITY_DATA_DIR.startsWith(repoRoot + path.sep), "an installed module must not read the source checkout's data");

  const index = sdk.readCompatibilityIndex();
  assert.equal(index.status, "ok", JSON.stringify(index));
  assert.deepEqual(index.index.records, []);
  assert.ok(index.index.historicalReferences.length >= 2, JSON.stringify(index.index.historicalReferences));
  // The historical basis really loaded: every reference re-hashed to its indexed value.
  assert.deepEqual(
    index.verified.map((f) => f.path).sort(),
    index.index.historicalReferences.map((f) => f.path).sort(),
  );
  for (const ref of index.index.historicalReferences) {
    assert.equal(sha256(fs.readFileSync(dataFile(installed, ref.path))), ref.sha256, ref.path);
  }
  assert.deepEqual(sdk.indexedRecordPaths(), []);
});

// ═══ 3. basis lifecycle inside one process ════════════════════════════════════════════════════

test("removing a required basis file makes the payload unavailable, and restoring its exact bytes recovers fresh loading in the same process", async () => {
  const installed = relocate("pico-s6-installed-lifecycle-");
  const sdk = await moduleOf(installed);
  const victim = readIndex(installed).historicalReferences[0];
  const victimPath = dataFile(installed, victim.path);
  const original = fs.readFileSync(victimPath);
  assert.equal(sha256(original), victim.sha256);

  assert.equal(verifySdkCompatibilityPayload(installed).ok, true);
  assert.equal(sdk.readCompatibilityIndex().status, "ok");

  // (a) removed.
  fs.rmSync(victimPath);
  const removed = verifySdkCompatibilityPayload(installed);
  assert.equal(removed.ok, false);
  assert.ok(removed.errors.some((e) => e.includes(victim.path)), JSON.stringify(removed.errors));
  const removedIndex = sdk.readCompatibilityIndex();
  assert.equal(removedIndex.status, "unavailable");
  assert.equal(removedIndex.code, "evidence-hash");

  // (b) restored, but ALTERED: still refused, and the refusal names the hash mismatch.
  fs.writeFileSync(victimPath, Buffer.concat([original, Buffer.from("\n<!-- tampered -->\n")]));
  const altered = verifySdkCompatibilityPayload(installed);
  assert.equal(altered.ok, false);
  assert.ok(altered.errors.some((e) => e.includes(victim.path) && e.includes(victim.sha256)), JSON.stringify(altered.errors));
  assert.equal(sdk.readCompatibilityIndex().code, "evidence-hash");

  // (c) restored to its EXACT bytes: fresh loading recovers without a restart.
  fs.writeFileSync(victimPath, original);
  const recovered = verifySdkCompatibilityPayload(installed);
  assert.equal(recovered.ok, true, JSON.stringify(recovered.errors));
  assert.equal(sdk.readCompatibilityIndex().status, "ok", "the same module instance must pick the restored bytes up");
});

// ═══ 4. an accepted mapping does not outlive its packaged basis ════════════════════════════════

const VAULT_PACKAGE_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<package name="agent-vault"><revision><major>0</major><minor>13</minor><micro>3</micro></revision></package>\n';
const ECS_REL = "knowledge/api-reference/com.pico.spatial.core.ecs.md";
const ECS_MD = [
  "# com.pico.spatial.core.ecs",
  "# Entity",
  "package com.pico.spatial.core.ecs {",
  "    open class Entity {",
  "        constructor ();",
  "    }",
  "}",
  "",
].join("\n");
const SYMBOL = "com.pico.spatial.core.ecs.Entity";
const SOURCE_COORD = "com.pico.spatial.fixture:core:0.13.3@aar";
const TARGET_COORD = "com.pico.spatial.fixture:core:9.9.9@aar";
const SOURCE_BYTES = "FIXTURE source artifact: synthetic bytes for the S6 installed-payload suite; not a real SDK measurement\n";
const TARGET_BYTES = "FIXTURE target artifact: synthetic bytes for the S6 installed-payload suite; not a real SDK measurement\n";
const FIXTURE_BASIS = "# FIXTURE basis\n\nSynthetic derivation notes for the S6 installed-payload record. Not a real SDK measurement.\n";
const RECORD_REL = "records/s6-installed-fixture.json";
const BASIS_REL = "basis/s6-installed-fixture.md";

/** A DeclarationIO over the real filesystem plus an EXPLICIT (coordinate, sha256) -> path table. */
function fsDeclarationIO(artifacts) {
  const table = new Map(artifacts.map((a) => [`${a.coordinate}\0${a.sha256}`, a.path]));
  return {
    read: (target) => { try { return fs.statSync(target).isFile() ? fs.readFileSync(target) : null; } catch { return null; } },
    entries: (target) => { try { return fs.readdirSync(target); } catch { return null; } },
    realpath: (target) => { try { return fs.realpathSync(target); } catch { return null; } },
    artifactPath: (coordinate, digest) => table.get(`${coordinate}\0${digest}`) ?? null,
  };
}

test("a previously accepted mapping does not survive a changed or missing packaged basis, and comes back only when the exact bytes do", async () => {
  const installed = relocate("pico-s6-installed-record-");
  const sdk = await moduleOf(installed);

  // A vault, a project and two artifacts, all on disk.
  const vaultRoot = temp("pico-s6-vault-");
  fs.mkdirSync(path.join(vaultRoot, "knowledge", "api-reference"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "package.xml"), VAULT_PACKAGE_XML);
  fs.writeFileSync(path.join(vaultRoot, ...ECS_REL.split("/")), ECS_MD);

  const projectRoot = temp("pico-s6-record-project-");
  fs.mkdirSync(path.join(projectRoot, "gradle"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "gradle", "libs.versions.toml"),
    '[versions]\nbom = "9.9.9"\n\n[libraries]\nbom = { group = "com.pico.spatial", name = "bom", version.ref = "bom" }\n',
  );

  const artifactDir = temp("pico-s6-artifacts-");
  const sourceArtifact = path.join(artifactDir, "source-core.aar");
  const targetArtifact = path.join(artifactDir, "target-core.aar");
  fs.writeFileSync(sourceArtifact, SOURCE_BYTES);
  fs.writeFileSync(targetArtifact, TARGET_BYTES);
  const io = fsDeclarationIO([
    { coordinate: SOURCE_COORD, sha256: sha256(SOURCE_BYTES), path: sourceArtifact },
    { coordinate: TARGET_COORD, sha256: sha256(TARGET_BYTES), path: targetArtifact },
  ]);

  const read = sdk.readDeclarationIdentity(vaultRoot, io);
  assert.equal(read.status, "ok", JSON.stringify(read));
  const source = read.identity;
  const target = (await import(pathToFileURL(path.join(installed, "dist", "projectidentity.js")).href)).readProjectSdkIdentity(projectRoot, {
    resolvedArtifacts: [{ coordinate: TARGET_COORD, sha256: sha256(TARGET_BYTES) }],
  });
  assert.equal(target.status, "resolved");

  // The reviewed record, its basis, and an index that lists both alongside the packaged ones.
  const artifacts = [
    { side: "source", coordinate: SOURCE_COORD, sha256: sha256(SOURCE_BYTES) },
    { side: "target", coordinate: TARGET_COORD, sha256: sha256(TARGET_BYTES) },
  ];
  const record = {
    schemaVersion: 1,
    id: "s6-installed-fixture-2026-09-15",
    declarationFingerprint: source.fingerprint,
    packageRevision: "0.13.3",
    targetBom: "9.9.9",
    sourceFiles: [{ path: ECS_REL, sha256: sha256(ECS_MD) }],
    artifacts,
    signatures: [{
      symbol: SYMBOL,
      sourceSha256: sdk.deriveSourceSignatureSha256(SYMBOL, source.fingerprint, artifacts.filter((a) => a.side === "source")),
      targetSha256: sdk.deriveTargetSignatureSha256(SYMBOL, "9.9.9", artifacts.filter((a) => a.side === "target")),
    }],
    symbols: [SYMBOL],
    verdict: "compatible",
    basis: [{ path: BASIS_REL, sha256: sha256(FIXTURE_BASIS) }],
  };
  const recordBytes = JSON.stringify(record, null, 2) + "\n";
  fs.mkdirSync(path.dirname(dataFile(installed, RECORD_REL)), { recursive: true });
  fs.writeFileSync(dataFile(installed, RECORD_REL), recordBytes);
  fs.writeFileSync(dataFile(installed, BASIS_REL), FIXTURE_BASIS);
  const pristineIndex = readIndex(installed);
  writeIndex(installed, {
    schemaVersion: 1,
    records: [{ path: RECORD_REL, sha256: sha256(recordBytes) }],
    historicalReferences: [...pristineIndex.historicalReferences, { path: BASIS_REL, sha256: sha256(FIXTURE_BASIS) }],
  });

  const recordPath = dataFile(installed, RECORD_REL);
  const load = () => sdk.loadVerifiedCompatibilityEvidence([recordPath], source, target, io);

  // (a) accepted, and the canary now checks the record and the extra basis too.
  const accepted = load();
  assert.equal(accepted.accepted.length, 1, JSON.stringify(accepted.rejected));
  assert.equal(accepted.accepted[0].record.sha256, sha256(recordBytes));
  assert.equal(sdk.resolveDeclarationContext(source, target, accepted.accepted).status, "target-compatible");
  const withRecord = verifySdkCompatibilityPayload(installed);
  assert.equal(withRecord.ok, true, JSON.stringify(withRecord.errors));
  assert.equal(withRecord.checked.length, 5, JSON.stringify(withRecord.checked.map((f) => f.path)));
  assert.ok(withRecord.checked.some((f) => f.path.endsWith(RECORD_REL)), JSON.stringify(withRecord.checked));

  // (b) the packaged basis the record cites is CHANGED: the acceptance does not carry over.
  fs.writeFileSync(dataFile(installed, BASIS_REL), FIXTURE_BASIS + "edited after review\n");
  const afterChange = load();
  assert.deepEqual(afterChange.accepted, [], "a mapping survived a changed packaged basis");
  assert.deepEqual(afterChange.rejected.map((r) => r.code), ["evidence-hash"]);
  assert.equal(sdk.resolveDeclarationContext(source, target, afterChange.accepted).status, "unknown");
  const changedCanary = verifySdkCompatibilityPayload(installed);
  assert.equal(changedCanary.ok, false);
  assert.ok(changedCanary.errors.some((e) => e.includes(BASIS_REL)), JSON.stringify(changedCanary.errors));

  // (c) the basis is REMOVED: same refusal, named as an absence.
  fs.rmSync(dataFile(installed, BASIS_REL));
  const afterRemoval = load();
  assert.deepEqual(afterRemoval.accepted, []);
  assert.deepEqual(afterRemoval.rejected.map((r) => r.code), ["evidence-hash"]);
  const removedCanary = verifySdkCompatibilityPayload(installed);
  assert.equal(removedCanary.ok, false);
  assert.ok(removedCanary.errors.some((e) => e.includes(BASIS_REL)), JSON.stringify(removedCanary.errors));

  // (d) the EXACT reviewed bytes come back: a fresh load verifies again in the same process.
  fs.writeFileSync(dataFile(installed, BASIS_REL), FIXTURE_BASIS);
  const recovered = load();
  assert.equal(recovered.accepted.length, 1, JSON.stringify(recovered.rejected));
  assert.equal(recovered.accepted[0].record.sha256, sha256(recordBytes));
  assert.equal(verifySdkCompatibilityPayload(installed).ok, true);
});

test("a record whose basis the installed index does not declare at the same hash is refused, even when every indexed byte matches", () => {
  const installed = relocate("pico-s6-installed-basis-");
  const pristine = readIndex(installed);
  const write = (basis) => {
    const bytes = JSON.stringify({ schemaVersion: 1, id: "s6-basis-probe", basis }, null, 2) + "\n";
    fs.mkdirSync(path.dirname(dataFile(installed, RECORD_REL)), { recursive: true });
    fs.writeFileSync(dataFile(installed, RECORD_REL), bytes);
    writeIndex(installed, { ...pristine, records: [{ path: RECORD_REL, sha256: sha256(bytes) }] });
  };

  // (a) a basis the index never declares — the bytes of everything indexed still match.
  write([{ path: "basis/never-reviewed.md", sha256: "a".repeat(64) }]);
  const undeclared = verifySdkCompatibilityPayload(installed);
  assert.equal(undeclared.ok, false);
  assert.ok(undeclared.errors.some((e) => e.includes("never-reviewed.md") && /does not declare/.test(e)), JSON.stringify(undeclared.errors));

  // (b) a declared basis cited at the WRONG hash.
  write([{ path: pristine.historicalReferences[0].path, sha256: "b".repeat(64) }]);
  const wrongHash = verifySdkCompatibilityPayload(installed);
  assert.equal(wrongHash.ok, false);
  assert.ok(wrongHash.errors.some((e) => e.includes(pristine.historicalReferences[0].path) && e.includes("b".repeat(64))), JSON.stringify(wrongHash.errors));

  // (c) no basis at all: a reviewed mapping must name what it rests on.
  write([]);
  const noBasis = verifySdkCompatibilityPayload(installed);
  assert.equal(noBasis.ok, false);
  assert.ok(noBasis.errors.some((e) => /cites no basis/.test(e)), JSON.stringify(noBasis.errors));

  // (d) the same record citing the packaged basis at its real hash verifies.
  write([pristine.historicalReferences[0]]);
  const good = verifySdkCompatibilityPayload(installed);
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.equal(good.checked.length, 4, JSON.stringify(good.checked.map((f) => f.path)));
});

test("a malformed or wrong-version installed index is refused rather than partially trusted", () => {
  const installed = relocate("pico-s6-installed-schema-");
  const indexPath = dataFile(installed, "index.v1.json");
  const cases = [
    ["not JSON at all", "{ this is not json\n", /not valid JSON/],
    ["a future schema", JSON.stringify({ schemaVersion: 2, records: [], historicalReferences: [] }), /schemaVersion 2/],
    ["an unexpected field", JSON.stringify({ schemaVersion: 1, records: [], historicalReferences: [], trustMe: true }), /unexpected field "trustMe"/],
    ["an escaping reference", JSON.stringify({ schemaVersion: 1, records: [], historicalReferences: [{ path: "../../etc/passwd", sha256: "c".repeat(64) }] }), /relative path inside/],
    ["a short hash", JSON.stringify({ schemaVersion: 1, records: [], historicalReferences: [{ path: "basis/x.md", sha256: "abc" }] }), /64 lowercase hex/],
  ];
  for (const [name, body, pattern] of cases) {
    fs.writeFileSync(indexPath, body);
    const result = verifySdkCompatibilityPayload(installed);
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.checked, [], `${name}: nothing may be reported as checked under a refused index`);
    assert.ok(result.errors.some((e) => pattern.test(e)), `${name}: ${JSON.stringify(result.errors)}`);
  }
});

// ═══ 5. the canary's own discipline ════════════════════════════════════════════════════════════

test("the canary reads only: it starts no process, opens no network, and never consults the working directory", () => {
  const text = fs.readFileSync(CANARY_PATH, "utf8");
  for (const banned of ["child_process", "spawnSync", "execSync", "node:http", "node:net", "fetch(", "process.cwd", "writeFileSync", "mkdirSync", "rmSync"]) {
    assert.ok(!text.includes(banned), `scripts/verify-sdk-compatibility-payload.mjs must not contain ${banned}`);
  }
  // A relative root is a caller bug, not an invitation to resolve against the working directory.
  const relative = verifySdkCompatibilityPayload("data");
  assert.equal(relative.ok, false);
  assert.ok(relative.errors.some((e) => /absolute/i.test(e)), JSON.stringify(relative.errors));
  for (const bad of [undefined, null, "", 42]) {
    const refused = verifySdkCompatibilityPayload(bad);
    assert.equal(refused.ok, false, JSON.stringify(bad));
    assert.deepEqual(refused.checked, []);
    assert.ok(refused.errors.length > 0);
  }
});
