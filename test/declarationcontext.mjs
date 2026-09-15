// Task S5 — declaration authority is explicit and versioned.
//
// What this suite exists to prevent: a locally materialized 0.13.3 agent-vault being handed out
// as the declarations of whatever SDK a project happens to build against. Three things are
// asserted here, each on bytes rather than labels:
//   1. a DeclarationIdentity is READ from package.xml + the api-reference files (canonically
//      sorted, hashed, bounded to the root) — never inferred from a directory name or a hint;
//   2. compatibility evidence is accepted only when a record listed in the package-owned reviewed
//      index verifies byte-for-byte against the local declarations, the exact resolved SDK
//      artifact set and the target BOM — and every bound file, mutated on its own, is rejected
//      with the code that names what changed;
//   3. context resolution trusts only loader-branded evidence, and a symbol outside the verified
//      scope stays unknown even when another symbol has a compatible mapping.
//
// Every vault, record, index and artifact here is an in-memory fixture (declarationIOFromTree)
// with SYNTHETIC bytes — no fixture is a real SDK measurement, which is why the fixture target
// BOM is 9.9.9 and the fixture artifacts sit in a `com.pico.spatial.fixture` group. The packaged
// historical basis is read from disk only to prove it is byte-identical to its sources. Projects
// are real temporary directories because readProjectSdkIdentity (Task S3) reads the host
// filesystem; nothing here runs Gradle, a CLI, Java or any service.
//
// Run: npm run build && node --test test/declarationcontext.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { declarationIOFromTree } from "./helpers/toolchain-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(repoRoot, "data", "sdk-compatibility");
const INDEX_PATH = path.join(DATA_DIR, "index.v1.json");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

const {
  readDeclarationIdentity,
  loadVerifiedCompatibilityEvidence,
  resolveDeclarationContext,
  readCompatibilityIndex,
  indexedRecordPaths,
  hostDeclarationIO,
  deriveSourceSignatureSha256,
  deriveTargetSignatureSha256,
  SDK_COMPATIBILITY_DATA_DIR,
  SDK_COMPATIBILITY_INDEX_PATH,
} = await import("../dist/declarationcontext.js");
const { readProjectSdkIdentity } = await import("../dist/projectidentity.js");

// ─── the fixture vault (synthetic declarations; package.xml mirrors the historical 0.13.3 shape) ──
const VAULT = "/vault";
const PACKAGE_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<package name="agent-vault"><revision><major>0</major><minor>13</minor><micro>3</micro></revision></package>\n';
const ECS_REL = "knowledge/api-reference/com.pico.spatial.core.ecs.md";
const MATH_REL = "knowledge/api-reference/com.pico.spatial.core.math.md";
const PROSE_REL = "knowledge/documentation/spatial-ui.md";
const ECS_MD = [
  "# com.pico.spatial.core.ecs",
  "# Entity",
  "package com.pico.spatial.core.ecs {",
  "    open class Entity {",
  "        constructor ();",
  "",
  "        fun setName(name: String);",
  "    }",
  "}",
  "",
].join("\n");
const MATH_MD = [
  "# com.pico.spatial.core.math",
  "# Vector3",
  "package com.pico.spatial.core.math {",
  "    class Vector3(val x: Float = 0f, val y: Float = 0f, val z: Float = 0f) {",
  "    }",
  "}",
  "",
].join("\n");
const PROSE_MD = "# SpatialUI\n\nSpatialModelView renders a model inside a panel.\n";

function vaultFiles(root = VAULT, { packageXml = PACKAGE_XML, ecs = ECS_MD, math = MATH_MD, prose = PROSE_MD } = {}) {
  const files = {};
  if (packageXml !== null) files[`${root}/package.xml`] = packageXml;
  if (ecs !== null) files[`${root}/${ECS_REL}`] = ecs;
  if (math !== null) files[`${root}/${MATH_REL}`] = math;
  if (prose !== null) files[`${root}/${PROSE_REL}`] = prose;
  return files;
}

// ─── synthetic artifacts — an EXPLICIT (coordinate, sha256) -> path table ───────────────────────
const SOURCE_COORD = "com.pico.spatial.fixture:core:0.13.3@aar";
const TARGET_COORD = "com.pico.spatial.fixture:core:9.9.9@aar";
const TARGET61_COORD = "com.pico.spatial.fixture:core:6.1.0@aar";
const EXTRA_SDK_COORD = "com.pico.spatial.fixture:extra:9.9.9@aar";
const APP_COORD = "androidx.core:core-ktx:1.13.0@aar";
const SOURCE_BYTES = "FIXTURE source artifact: synthetic bytes standing in for a 0.13.3 module; not a real SDK measurement\n";
const TARGET_BYTES = "FIXTURE target artifact: synthetic bytes standing in for a 9.9.9 module; not a real SDK measurement\n";
const TARGET_ALT_BYTES = "FIXTURE alternate target artifact: a different synthetic build of the same coordinate\n";
const TARGET61_BYTES = "FIXTURE 6.1.0-labelled artifact: synthetic bytes with no reviewed mapping\n";
const EXTRA_SDK_BYTES = "FIXTURE unexpected SDK module\n";
const APP_BYTES = "FIXTURE application dependency; not an SDK module\n";
const SOURCE_SHA = sha256(SOURCE_BYTES);
const TARGET_SHA = sha256(TARGET_BYTES);
const TARGET_ALT_SHA = sha256(TARGET_ALT_BYTES);
const TARGET61_SHA = sha256(TARGET61_BYTES);
const EXTRA_SDK_SHA = sha256(EXTRA_SDK_BYTES);
const APP_SHA = sha256(APP_BYTES);
const ARTIFACT_FILES = {
  "/artifacts/source-core.aar": SOURCE_BYTES,
  "/artifacts/target-core.aar": TARGET_BYTES,
  "/artifacts/target-core-alt.aar": TARGET_ALT_BYTES,
  "/artifacts/target61-core.aar": TARGET61_BYTES,
  "/artifacts/extra.aar": EXTRA_SDK_BYTES,
  "/artifacts/app.aar": APP_BYTES,
};
const ARTIFACT_TABLE = [
  { coordinate: SOURCE_COORD, sha256: SOURCE_SHA, path: "/artifacts/source-core.aar" },
  { coordinate: TARGET_COORD, sha256: TARGET_SHA, path: "/artifacts/target-core.aar" },
  { coordinate: TARGET_COORD, sha256: TARGET_ALT_SHA, path: "/artifacts/target-core-alt.aar" },
  { coordinate: TARGET61_COORD, sha256: TARGET61_SHA, path: "/artifacts/target61-core.aar" },
  { coordinate: EXTRA_SDK_COORD, sha256: EXTRA_SDK_SHA, path: "/artifacts/extra.aar" },
  { coordinate: APP_COORD, sha256: APP_SHA, path: "/artifacts/app.aar" },
];

// ─── the packaged historical basis (read from disk to prove byte identity) + a synthetic basis ──
const DRIFT_BYTES = fs.readFileSync(path.join(DATA_DIR, "basis", "sdk-6.0.0-drift.md"));
const PROVENANCE_BYTES = fs.readFileSync(path.join(DATA_DIR, "basis", "sdk-adoption-provenance.json"));
const FIXTURE_BASIS = "# FIXTURE basis\n\nSynthetic derivation notes for the declarationcontext test record. Not a real SDK measurement.\n";
const DRIFT_REF = { path: "basis/sdk-6.0.0-drift.md", sha256: sha256(DRIFT_BYTES) };
const PROVENANCE_REF = { path: "basis/sdk-adoption-provenance.json", sha256: sha256(PROVENANCE_BYTES) };
const FIXTURE_BASIS_REF = { path: "basis/fixture-basis.md", sha256: sha256(FIXTURE_BASIS) };
const HISTORICAL = [DRIFT_REF, PROVENANCE_REF, FIXTURE_BASIS_REF];

// ─── tree builders ─────────────────────────────────────────────────────────────────────────────
const RECORD_REL = "records/fixture-declarationcontext.json";
const RECORD_PATH = path.join(DATA_DIR, RECORD_REL);
const SYMBOL = "com.pico.spatial.core.ecs.Entity";
const VECTOR3 = "com.pico.spatial.core.math.Vector3";
const recordBytes = (record) => JSON.stringify(record, null, 2) + "\n";

/** A tree spec: vault + artifacts + packaged basis + index + records. `records` = [{rel, bytes}]. */
function specFor({ records = [], vault = vaultFiles(), extraFiles = {}, artifacts = ARTIFACT_TABLE, historical = HISTORICAL, index = undefined } = {}) {
  const files = {
    ...vault,
    ...ARTIFACT_FILES,
    [path.join(DATA_DIR, "basis", "sdk-6.0.0-drift.md")]: DRIFT_BYTES,
    [path.join(DATA_DIR, "basis", "sdk-adoption-provenance.json")]: PROVENANCE_BYTES,
    [path.join(DATA_DIR, "basis", "fixture-basis.md")]: FIXTURE_BASIS,
  };
  for (const r of records) files[path.join(DATA_DIR, r.rel)] = r.bytes;
  const indexObject = index === undefined
    ? { schemaVersion: 1, records: records.map((r) => ({ path: r.rel, sha256: sha256(r.bytes) })), historicalReferences: historical }
    : index;
  if (indexObject !== null) files[INDEX_PATH] = typeof indexObject === "string" ? indexObject : JSON.stringify(indexObject, null, 2) + "\n";
  Object.assign(files, extraFiles);
  return { files, artifacts };
}
const ioFor = (spec, extra = {}) => declarationIOFromTree({ ...spec, ...extra });
const withFile = (spec, file, bytes) => ({ ...spec, files: { ...spec.files, [file]: bytes } });
const withoutFile = (spec, file) => { const files = { ...spec.files }; delete files[file]; return { ...spec, files }; };
const withArtifacts = (spec, artifacts) => ({ ...spec, artifacts });
const readIndex = (spec) => JSON.parse(spec.files[INDEX_PATH]);
const withIndex = (spec, index) => withFile(spec, INDEX_PATH, JSON.stringify(index, null, 2) + "\n");

/** The reader-produced identity of the fixture vault (content-only, so any io with the same vault agrees). */
function sourceOf(vault = vaultFiles()) {
  const read = readDeclarationIdentity(VAULT, ioFor(specFor({ vault })));
  assert.equal(read.status, "ok", `fixture vault must read: ${JSON.stringify(read)}`);
  return read.identity;
}

function recordFor(source, overrides = {}) {
  const merged = {
    schemaVersion: 1,
    id: "fixture-declarationcontext-2026-09-15",
    declarationFingerprint: source.fingerprint,
    packageRevision: "0.13.3",
    targetBom: "9.9.9",
    sourceFiles: [{ path: ECS_REL, sha256: sha256(ECS_MD) }],
    artifacts: [
      { side: "source", coordinate: SOURCE_COORD, sha256: SOURCE_SHA },
      { side: "target", coordinate: TARGET_COORD, sha256: TARGET_SHA },
    ],
    symbols: [SYMBOL],
    verdict: "compatible",
    basis: [FIXTURE_BASIS_REF],
    ...overrides,
  };
  if (!overrides.signatures) {
    merged.signatures = merged.symbols.map((symbol) => ({
      symbol,
      sourceSha256: deriveSourceSignatureSha256(symbol, merged.declarationFingerprint, merged.artifacts.filter((a) => a.side === "source")),
      targetSha256: deriveTargetSignatureSha256(symbol, merged.targetBom, merged.artifacts.filter((a) => a.side === "target")),
    }));
  }
  return merged;
}

/** The standard accepted scenario: one indexed fixture record over the fixture vault + artifacts. */
function scenario(recordOverrides = {}, specOverrides = {}) {
  const source = sourceOf(specOverrides.vault);
  const record = recordFor(source, recordOverrides);
  const spec = specFor({ ...specOverrides, records: [{ rel: RECORD_REL, bytes: recordBytes(record) }, ...(specOverrides.records ?? [])] });
  return { source, record, spec, io: ioFor(spec) };
}

// ─── real temp projects (readProjectSdkIdentity reads the host filesystem) ─────────────────────
const catalog = (bom) => ["[versions]", `bom = "${bom}"`, "", "[libraries]", 'bom = { group = "com.pico.spatial", name = "bom", version.ref = "bom" }', ""].join("\n");
let sandboxes = [];
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "declarationcontext "));
  sandboxes.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}
test.after(() => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
  sandboxes = [];
});
const RESOLVED = [
  { coordinate: TARGET_COORD, sha256: TARGET_SHA },
  { coordinate: APP_COORD, sha256: APP_SHA },
];
const rootA = project({ "gradle/libs.versions.toml": catalog("9.9.9"), "gradle.properties": "org.gradle.jvmargs=-Xmx2g\n# fixture project A\n" });
const rootB = project({ "gradle/libs.versions.toml": catalog("9.9.9"), "gradle.properties": "org.gradle.jvmargs=-Xmx4g\n# fixture project B\n" });
const identityA = readProjectSdkIdentity(rootA, { resolvedArtifacts: RESOLVED });
const identityB = readProjectSdkIdentity(rootB, { resolvedArtifacts: RESOLVED });
assert.equal(identityA.status, "resolved");
assert.equal(identityB.status, "resolved");

const codesOf = (result) => result.rejected.map((r) => r.code);
const hashTree = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(`${path.relative(root, abs)}\0${sha256(fs.readFileSync(abs))}`);
    }
  };
  walk(root);
  return sha256(out.join("\n"));
};

// ═══ 1. packaged reviewed data ═════════════════════════════════════════════════════════════════

test("the reviewed index is a fixed module-relative path and its packaged basis is byte-identical to the historical sources", () => {
  assert.equal(SDK_COMPATIBILITY_DATA_DIR, DATA_DIR);
  assert.equal(SDK_COMPATIBILITY_INDEX_PATH, INDEX_PATH);
  assert.ok(DRIFT_BYTES.equals(fs.readFileSync(path.join(repoRoot, "docs", "SDK_6_0_0_DRIFT.md"))), "basis/sdk-6.0.0-drift.md is a byte copy of docs/SDK_6_0_0_DRIFT.md");
  assert.ok(PROVENANCE_BYTES.equals(fs.readFileSync(path.join(repoRoot, "test", "fixtures", "sdk-adoption-provenance.json"))), "basis/sdk-adoption-provenance.json is a byte copy of the fixture");
  // the historical core hashes stay INPUTS: present in the basis text, absent from any record
  const drift = DRIFT_BYTES.toString("utf8");
  assert.ok(drift.includes("29b5ec6bdc85238d61914990fdafd2d00b535bf49bc2d018a08ff17f3071dcd0"), "0.13.3 core binary hash retained in the basis");
  assert.ok(drift.includes("92bc5d19b048d9c083681e550e86dc6aaafddf75731a4989f5a8e8165d3db5df"), "6.0.0 core binary hash retained in the basis");
  const provenance = JSON.parse(PROVENANCE_BYTES.toString("utf8"));
  assert.equal(provenance.sdkVersion, "0.13.3");
  assert.equal(Object.hasOwn(provenance, "records"), false, "the historical provenance fixture carries no mapping records");

  const packaged = readCompatibilityIndex();
  assert.equal(packaged.status, "ok", JSON.stringify(packaged));
  assert.deepEqual(packaged.index.records, [], "records start EMPTY — no reviewed mapping exists yet");
  assert.deepEqual(packaged.index.historicalReferences, [
    { path: "basis/sdk-6.0.0-drift.md", sha256: "e1671fbdaf1ee278298258f4aa3c5771861a677e37e22e8281d0ffc7eb7d6b5a" },
    { path: "basis/sdk-adoption-provenance.json", sha256: "058bbf48ae902a22dd77f23e6a4427fc2bb5349ee09cede268aefbf76fa3f20e" },
  ]);
  assert.deepEqual(packaged.index.historicalReferences, [DRIFT_REF, PROVENANCE_REF], "the index hashes are the hashes of the packaged bytes");
  assert.deepEqual(indexedRecordPaths(), []);
});

test("brief snippet: an unindexed caller record is never a candidate, the context stays unknown, and a missing vault is unavailable", () => {
  const source = sourceOf();
  const claims = recordBytes(recordFor(source));
  const io = ioFor(specFor({ extraFiles: { "/caller/claims-compatible.json": claims } }));
  const target = identityA;

  const read = readDeclarationIdentity("/vault", io); assert.equal(read.status,"ok");
  const rejected = loadVerifiedCompatibilityEvidence(["/caller/claims-compatible.json"], read.identity, target, io);
  assert.equal(rejected.accepted.length,0);
  assert.equal(rejected.rejected[0].code,"record-not-reviewed");
  assert.equal(resolveDeclarationContext(read.identity, target, rejected.accepted).status,"unknown");
  assert.equal(readDeclarationIdentity("/missing-vault", io).status,"unavailable");

  assert.equal(rejected.rejected[0].path, "/caller/claims-compatible.json");
  assert.match(rejected.rejected[0].detail, /reviewed index/);
});

// ═══ 2. reading a declaration identity ═════════════════════════════════════════════════════════

test("a declaration identity is read from package.xml and the api-reference bytes, canonically sorted and root-relative", () => {
  const io = ioFor(specFor());
  const read = readDeclarationIdentity(VAULT, io);
  assert.equal(read.status, "ok");
  const { identity } = read;
  assert.equal(identity.root, VAULT);
  assert.equal(identity.packageRevision, "0.13.3");
  assert.equal(identity.authority, "declarations");
  assert.deepEqual(identity.sources.map((s) => s.path), [ECS_REL, MATH_REL, "package.xml"], "sources are sorted root-relative posix paths; prose is not a declaration source");
  assert.deepEqual(identity.sources.map((s) => s.sha256), [sha256(ECS_MD), sha256(MATH_MD), sha256(PACKAGE_XML)]);
  assert.match(identity.fingerprint, /^[0-9a-f]{64}$/);
  const material = `pico-declaration-identity/1\ndeclarations\n${identity.sources.map((s) => `${s.path}\0${s.sha256}\n`).join("")}`;
  assert.equal(identity.fingerprint, sha256(material), "the fingerprint is sha256 over the versioned prefix, the authority and the sorted `path\\0sha256` lines");
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.sources), "identities are frozen");
  assert.equal(readDeclarationIdentity(VAULT, io).identity.fingerprint, identity.fingerprint, "reading twice is deterministic");
});

test("identical declaration installations at different roots share a fingerprint and differ only in root", () => {
  const elsewhere = "/opt/pico/6.1/agent-vault";
  const io = ioFor(specFor({ extraFiles: vaultFiles(elsewhere) }));
  const a = readDeclarationIdentity(VAULT, io).identity;
  const b = readDeclarationIdentity(elsewhere, io).identity;
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.root, b.root);
  assert.equal(b.root, elsewhere);
  // no revision is inferred from the directory label: `6.1` in the path, 0.13.3 in package.xml
  assert.equal(b.packageRevision, "0.13.3");
  // the same content, declared to the tree in a different order, hashes identically
  const reversed = Object.fromEntries(Object.entries(vaultFiles()).reverse());
  assert.equal(readDeclarationIdentity(VAULT, ioFor(specFor({ vault: reversed }))).identity.fingerprint, a.fingerprint);
  // a different declaration byte is a different identity, and a different package revision too
  assert.notEqual(readDeclarationIdentity(VAULT, ioFor(specFor({ vault: vaultFiles(VAULT, { ecs: ECS_MD + "// one more byte\n" }) }))).identity.fingerprint, a.fingerprint);
  assert.notEqual(readDeclarationIdentity(VAULT, ioFor(specFor({ vault: vaultFiles(VAULT, { packageXml: PACKAGE_XML.replace("<micro>3</micro>", "<micro>4</micro>") }) }))).identity.fingerprint, a.fingerprint);
});

test("missing or malformed package metadata makes declaration authority unavailable, naming package.xml", () => {
  const missing = readDeclarationIdentity(VAULT, ioFor(specFor({ vault: vaultFiles(VAULT, { packageXml: null }) })));
  assert.equal(missing.status, "unavailable");
  assert.match(missing.code, /package-xml/);
  assert.match(missing.detail, /package\.xml/);
  const malformed = readDeclarationIdentity(VAULT, ioFor(specFor({ vault: vaultFiles(VAULT, { packageXml: "<package><revision>6.1</revision></package>\n" }) })));
  assert.equal(malformed.status, "unavailable");
  assert.match(malformed.code, /package-xml/);
  assert.match(malformed.detail, /package\.xml/);
  // a version label in the directory name is NOT a substitute for the metadata
  const labelled = readDeclarationIdentity("/sdk/6.1/agent-vault", ioFor(specFor({ extraFiles: vaultFiles("/sdk/6.1/agent-vault", { packageXml: null }) })));
  assert.equal(labelled.status, "unavailable");
  assert.match(labelled.code, /package-xml/);
});

test("absent roots, directory-only hints and unreadable declarations are unavailable", () => {
  const io = ioFor(specFor({ extraFiles: { "/just-a-dir/README.txt": "not a vault" } }));
  const absent = readDeclarationIdentity("/missing-vault", io);
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.code, "root-unavailable");
  const dirOnly = readDeclarationIdentity("/just-a-dir", io);
  assert.equal(dirOnly.status, "unavailable");
  assert.equal(dirOnly.code, "declarations-missing");
  const emptyApi = readDeclarationIdentity(VAULT, ioFor(specFor({ vault: vaultFiles(VAULT, { ecs: null, math: null, prose: null }) }, { dirs: [`${VAULT}/knowledge/api-reference`] })));
  assert.equal(emptyApi.status, "unavailable");
  assert.equal(emptyApi.code, "declarations-missing");
  const unreadable = readDeclarationIdentity(VAULT, ioFor(specFor(), { unreadable: [`${VAULT}/${MATH_REL}`] }));
  assert.equal(unreadable.status, "unavailable");
  assert.equal(unreadable.code, "declaration-unreadable");
  assert.match(unreadable.detail, /com\.pico\.spatial\.core\.math\.md/);
});

test("a symlink escaping the root, duplicate canonical entries and bytes changing during the read are all unavailable", () => {
  const escapeFile = `${VAULT}/knowledge/api-reference/evil.md`;
  const escaped = readDeclarationIdentity(VAULT, ioFor(specFor({ extraFiles: { [escapeFile]: "alias", "/outside/secret.md": "# outside\n" } }), { symlinks: { [escapeFile]: "/outside/secret.md" } }));
  assert.equal(escaped.status, "unavailable");
  assert.equal(escaped.code, "declaration-escape");
  assert.match(escaped.detail, /evil\.md/);

  const aliasFile = `${VAULT}/knowledge/api-reference/zz-alias.md`;
  const duplicate = readDeclarationIdentity(VAULT, ioFor(specFor({ extraFiles: { [aliasFile]: "alias" } }), { symlinks: { [aliasFile]: `${VAULT}/${ECS_REL}` } }));
  assert.equal(duplicate.status, "unavailable");
  assert.equal(duplicate.code, "declaration-duplicate");

  const stable = ioFor(specFor());
  let ecsReads = 0;
  const flaky = {
    ...stable,
    read(target) {
      const bytes = stable.read(target);
      if (bytes && target.endsWith("com.pico.spatial.core.ecs.md")) {
        ecsReads += 1;
        if (ecsReads > 1) return Buffer.concat([bytes, Buffer.from("// rewritten mid-read\n")]);
      }
      return bytes;
    },
  };
  const changed = readDeclarationIdentity(VAULT, flaky);
  assert.equal(changed.status, "unavailable");
  assert.equal(changed.code, "declaration-changed");
  assert.ok(ecsReads >= 2, "the reader verifies the bytes it hashed by reading them again");
});

test("a prose-only root is identified as prose and cannot authorize target declarations", () => {
  const prose = readDeclarationIdentity(VAULT, ioFor(specFor({ vault: vaultFiles(VAULT, { ecs: null, math: null }) })));
  assert.equal(prose.status, "ok");
  assert.equal(prose.identity.authority, "prose");
  assert.equal(prose.identity.packageRevision, "0.13.3");
  assert.deepEqual(prose.identity.sources.map((s) => s.path), [PROSE_REL, "package.xml"]);
  const bare = readDeclarationIdentity(VAULT, ioFor(specFor({ vault: vaultFiles(VAULT, { ecs: null, math: null, packageXml: null }) })));
  assert.equal(bare.status, "ok");
  assert.equal(bare.identity.authority, "prose");
  assert.equal(bare.identity.packageRevision, null);

  // even a record crafted around the prose fingerprint is refused: prose never grants authority
  const crafted = recordFor(prose.identity, { sourceFiles: [{ path: PROSE_REL, sha256: sha256(PROSE_MD) }] });
  const io = ioFor(specFor({ vault: vaultFiles(VAULT, { ecs: null, math: null }), records: [{ rel: RECORD_REL, bytes: recordBytes(crafted) }] }));
  const loaded = loadVerifiedCompatibilityEvidence([RECORD_PATH], prose.identity, identityA, io);
  assert.equal(loaded.accepted.length, 0);
  assert.deepEqual(codesOf(loaded), ["context-mismatch"]);
  assert.match(loaded.rejected[0].detail, /prose/);
  assert.equal(resolveDeclarationContext(prose.identity, identityA, []).status, "unknown");
  assert.equal(resolveDeclarationContext(prose.identity, null, []).status, "historical");
});

// ═══ 3. verified compatibility evidence ════════════════════════════════════════════════════════

test("an indexed record is accepted only after every bound byte verifies, and its acceptance is bound to the current project", () => {
  const { io, record, source } = scenario();
  const loaded = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, identityA, io);
  assert.deepEqual(loaded.rejected, []);
  assert.equal(loaded.accepted.length, 1);
  const [evidence] = loaded.accepted;
  assert.equal(evidence.record.path, RECORD_PATH);
  assert.equal(evidence.record.sha256, sha256(recordBytes(record)));
  assert.equal(evidence.id, record.id);
  assert.equal(evidence.verdict, "compatible");
  assert.deepEqual(evidence.symbols, [SYMBOL]);
  assert.equal(evidence.binding.projectRoot, identityA.projectRoot);
  assert.equal(evidence.binding.projectFingerprint, identityA.fingerprint);
  assert.match(evidence.binding.artifactsFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(evidence) && Object.isFrozen(evidence.binding), "accepted evidence is frozen");
  // the artifact bytes were actually read, both sides
  assert.ok(io.tree.reads.includes("/artifacts/source-core.aar") && io.tree.reads.includes("/artifacts/target-core.aar"), "both artifact payloads were read");

  const context = resolveDeclarationContext(source, identityA, loaded.accepted);
  assert.equal(context.status, "target-compatible");
  assert.deepEqual(context.verifiedSymbols, [SYMBOL]);
  assert.deepEqual(context.evidencePaths, [RECORD_PATH]);
  assert.equal(context.source, source);
  assert.equal(context.target, identityA);
  assert.ok(!context.verifiedSymbols.includes(VECTOR3), "a symbol outside the reviewed scope is not verified even though another symbol is");
  // a data-dir-relative path selects the same reviewed record
  const relative = loadVerifiedCompatibilityEvidence([RECORD_REL], source, identityA, io);
  assert.equal(relative.accepted[0]?.record.path, RECORD_PATH);
});

test("the signature derivation is pinned: symbol + verified declaration/artifact identity on each side", () => {
  const source = sourceOf();
  const sourceArtifacts = [{ coordinate: SOURCE_COORD, sha256: SOURCE_SHA }];
  const targetArtifacts = [{ coordinate: TARGET_COORD, sha256: TARGET_SHA }];
  const expectedSource = sha256(`pico-signature-source/1\n${SYMBOL}\n${source.fingerprint}\n${SOURCE_COORD}\0${SOURCE_SHA}\n`);
  const expectedTarget = sha256(`pico-signature-target/1\n${SYMBOL}\n9.9.9\n${TARGET_COORD}\0${TARGET_SHA}\n`);
  assert.equal(deriveSourceSignatureSha256(SYMBOL, source.fingerprint, sourceArtifacts), expectedSource);
  assert.equal(deriveTargetSignatureSha256(SYMBOL, "9.9.9", targetArtifacts), expectedTarget);
  // a record whose signature hashes were NOT derived from the verified inputs is refused
  const { io } = scenario({ signatures: [{ symbol: SYMBOL, sourceSha256: "1".repeat(64), targetSha256: expectedTarget }] });
  const loaded = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, identityA, io);
  assert.equal(loaded.accepted.length, 0);
  assert.deepEqual(codesOf(loaded), ["evidence-hash"]);
  assert.match(loaded.rejected[0].detail, /signature/);
});

test("every bound file mutated on its own is rejected with the code that names what changed", () => {
  const base = scenario();
  const load = (spec, target = identityA) => loadVerifiedCompatibilityEvidence([RECORD_PATH], base.source, target, ioFor(spec));
  const expect = (label, spec, code, detail, target) => {
    const result = load(spec, target);
    assert.equal(result.accepted.length, 0, `${label}: nothing accepted`);
    assert.deepEqual(codesOf(result), [code], `${label}: got ${JSON.stringify(result.rejected)}`);
    if (detail) assert.match(result.rejected[0].detail, detail, `${label}: detail`);
  };
  assert.equal(load(base.spec).accepted.length, 1, "the unmodified scenario is accepted");

  // the reviewed index
  const tamperedIndex = readIndex(base.spec); tamperedIndex.records[0].sha256 = "0".repeat(64);
  expect("changed index entry", withIndex(base.spec, tamperedIndex), "evidence-hash", /index/);
  expect("record removed from the index", withIndex(base.spec, { ...readIndex(base.spec), records: [] }), "record-not-reviewed");
  expect("missing index", withoutFile(base.spec, INDEX_PATH), "record-not-reviewed", /index/);
  expect("malformed index", withFile(base.spec, INDEX_PATH, "{ not json"), "record-not-reviewed", /index/);
  expect("index of an unknown schema", withIndex(base.spec, { ...readIndex(base.spec), schemaVersion: 2 }), "record-not-reviewed", /index/);
  // the record bytes (same path, one byte of whitespace)
  expect("changed record bytes", withFile(base.spec, RECORD_PATH, recordBytes(base.record) + "\n"), "evidence-hash", /record/);
  // the basis the record cites, and an unrelated reviewed reference
  expect("changed basis bytes", withFile(base.spec, path.join(DATA_DIR, "basis", "fixture-basis.md"), FIXTURE_BASIS + "edited\n"), "evidence-hash", /basis/);
  expect("missing basis", withoutFile(base.spec, path.join(DATA_DIR, "basis", "fixture-basis.md")), "evidence-hash", /basis/);
  expect("altered packaged historical reference", withFile(base.spec, path.join(DATA_DIR, "basis", "sdk-6.0.0-drift.md"), Buffer.concat([DRIFT_BYTES, Buffer.from("\n")])), "evidence-hash", /sdk-6\.0\.0-drift/);
  // the source declarations
  expect("changed package revision", withFile(base.spec, `${VAULT}/package.xml`, PACKAGE_XML.replace("<micro>3</micro>", "<micro>4</micro>")), "context-mismatch");
  expect("changed declaration bytes", withFile(base.spec, `${VAULT}/${ECS_REL}`, ECS_MD + "// drift\n"), "context-mismatch");
  // the artifacts
  expect("missing target artifact", withArtifacts(base.spec, ARTIFACT_TABLE.filter((a) => a.sha256 !== TARGET_SHA)), "artifact-unavailable", new RegExp(TARGET_COORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect("missing source artifact", withArtifacts(base.spec, ARTIFACT_TABLE.filter((a) => a.sha256 !== SOURCE_SHA)), "artifact-unavailable", /0\.13\.3/);
  expect("target artifact bytes differ from the reviewed hash", withArtifacts(base.spec, ARTIFACT_TABLE.map((a) => (a.sha256 === TARGET_SHA ? { ...a, path: "/artifacts/target-core-alt.aar" } : a))), "evidence-hash", /artifact/);
  expect("target artifact path exists in the table but not on disk", withoutFile(base.spec, "/artifacts/target-core.aar"), "artifact-unavailable");
});

test("record schema: unknown versions, ranges, wildcards, project fields and compatibility booleans are refused", () => {
  const source = sourceOf();
  const expectSchema = (label, overrides, detail) => {
    const { io } = scenario(overrides);
    const result = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, identityA, io);
    assert.equal(result.accepted.length, 0, `${label}: nothing accepted`);
    assert.deepEqual(codesOf(result), ["record-schema"], `${label}: got ${JSON.stringify(result.rejected)}`);
    if (detail) assert.match(result.rejected[0].detail, detail, `${label}: detail`);
  };
  expectSchema("unknown schema version", { schemaVersion: 2 }, /schemaVersion/);
  expectSchema("version range as targetBom", { targetBom: "[6.0,7.0)" }, /targetBom/);
  expectSchema("dynamic targetBom", { targetBom: "6.1.+" }, /targetBom/);
  expectSchema("version range in packageRevision", { packageRevision: "0.13.+" }, /packageRevision/);
  expectSchema("wildcard symbol", { symbols: ["com.pico.spatial.core.ecs.*"] }, /symbol/);
  expectSchema("package wildcard symbol", { symbols: ["com.pico.spatial.**"] }, /symbol/);
  expectSchema("empty symbol scope", { symbols: [] }, /symbol/);
  expectSchema("signatures outside the symbol scope", { signatures: [{ symbol: VECTOR3, sourceSha256: "a".repeat(64), targetSha256: "b".repeat(64) }] }, /signature/);
  expectSchema("empty signatures", { signatures: [] }, /signature/);
  expectSchema("artifact version range", { artifacts: [{ side: "source", coordinate: "com.pico.spatial.fixture:core:[0.13,1.0)@aar", sha256: SOURCE_SHA }, { side: "target", coordinate: TARGET_COORD, sha256: TARGET_SHA }] }, /coordinate/);
  expectSchema("artifact without extension", { artifacts: [{ side: "source", coordinate: "com.pico.spatial.fixture:core:0.13.3", sha256: SOURCE_SHA }, { side: "target", coordinate: TARGET_COORD, sha256: TARGET_SHA }] }, /coordinate/);
  expectSchema("no target artifact", { artifacts: [{ side: "source", coordinate: SOURCE_COORD, sha256: SOURCE_SHA }] }, /target/);
  expectSchema("a project root inside the record", { projectRoot: rootA }, /projectRoot/);
  expectSchema("a project fingerprint inside the record", { projectFingerprint: identityA.fingerprint }, /projectFingerprint/);
  expectSchema("a compatibility boolean inside the record", { compatible: true }, /compatible/);
  expectSchema("a forged binding inside the record", { binding: { projectRoot: rootA } }, /binding/);
  expectSchema("unknown verdict", { verdict: "probably" }, /verdict/);
  expectSchema("empty basis", { basis: [] }, /basis/);
  expectSchema("absolute basis path", { basis: [{ path: path.join(DATA_DIR, "basis", "fixture-basis.md"), sha256: FIXTURE_BASIS_REF.sha256 }] }, /basis/);
  expectSchema("basis path escaping the data directory", { basis: [{ path: "../../docs/SDK_6_0_0_DRIFT.md", sha256: DRIFT_REF.sha256 }] }, /basis/);
  expectSchema("source file path outside the declaration set", { sourceFiles: [{ path: "../gradle/libs.versions.toml", sha256: "c".repeat(64) }] }, /sourceFiles/);
  const malformed = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, identityA, ioFor(specFor({ records: [{ rel: RECORD_REL, bytes: "{ not json" }] })));
  assert.deepEqual(codesOf(malformed), ["record-schema"], "malformed json");
  assert.match(malformed.rejected[0].detail, /JSON/);
});

test("a basis outside the reviewed index and a caller path with reviewed bytes are both not-reviewed", () => {
  const source = sourceOf();
  const unlisted = scenario({ basis: [{ path: "basis/unlisted.md", sha256: sha256("# unlisted\n") }] }, { extraFiles: { [path.join(DATA_DIR, "basis", "unlisted.md")]: "# unlisted\n" } });
  const result = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, identityA, unlisted.io);
  assert.deepEqual(codesOf(result), ["record-not-reviewed"]);
  assert.match(result.rejected[0].detail, /basis/);

  const copied = scenario();
  const copy = ioFor(withFile(copied.spec, "/caller/copy-of-reviewed.json", copied.spec.files[RECORD_PATH]));
  const viaCopy = loadVerifiedCompatibilityEvidence(["/caller/copy-of-reviewed.json"], source, identityA, copy);
  assert.deepEqual(codesOf(viaCopy), ["record-not-reviewed"], "identical bytes at an unindexed path are not a trust anchor");
  assert.equal(loadVerifiedCompatibilityEvidence([RECORD_PATH], source, identityA, copy).accepted.length, 1, "the indexed path still is");
});

test("context mismatch: wrong target BOM, an unexpected SDK module, a different source set — while unrelated app dependencies are ignored", () => {
  const { io, source } = scenario();
  const wrongBom = readProjectSdkIdentity(project({ "gradle/libs.versions.toml": catalog("6.0.0") }), { resolvedArtifacts: RESOLVED });
  assert.equal(wrongBom.status, "resolved");
  const bom = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, wrongBom, io);
  assert.deepEqual(codesOf(bom), ["context-mismatch"]);
  assert.match(bom.rejected[0].detail, /6\.0\.0/);

  const extraModule = readProjectSdkIdentity(rootA, { resolvedArtifacts: [...RESOLVED, { coordinate: EXTRA_SDK_COORD, sha256: EXTRA_SDK_SHA }] });
  const extra = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, extraModule, io);
  assert.deepEqual(codesOf(extra), ["context-mismatch"]);
  assert.match(extra.rejected[0].detail, /extra/);

  const moreAppDeps = readProjectSdkIdentity(rootA, { resolvedArtifacts: [...RESOLVED, { coordinate: "org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0@jar", sha256: "d".repeat(64) }] });
  assert.equal(loadVerifiedCompatibilityEvidence([RECORD_PATH], source, moreAppDeps, io).accepted.length, 1, "application dependencies do not enter the SDK set");

  const otherSource = sourceOf(vaultFiles(VAULT, { math: MATH_MD + "// v2\n" }));
  const drifted = loadVerifiedCompatibilityEvidence([RECORD_PATH], otherSource, identityA, ioFor(specFor({ vault: vaultFiles(VAULT, { math: MATH_MD + "// v2\n" }), records: [{ rel: RECORD_REL, bytes: io.read(RECORD_PATH) }] })));
  assert.deepEqual(codesOf(drifted), ["context-mismatch"]);
  assert.match(drifted.rejected[0].detail, /fingerprint|declaration/);
});

test("a declared-only or unknown project identity is target-unresolved; a stale identity is refused until re-read", () => {
  const { io, source } = scenario();
  const declaredOnly = readProjectSdkIdentity(rootA);
  assert.equal(declaredOnly.status, "declared");
  const declared = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, declaredOnly, io);
  assert.deepEqual(codesOf(declared), ["target-unresolved"]);
  const unknownRoot = readProjectSdkIdentity(project({ "gradle.properties": "x=y\n" }));
  assert.equal(unknownRoot.status, "unknown");
  assert.deepEqual(codesOf(loadVerifiedCompatibilityEvidence([RECORD_PATH], source, unknownRoot, io)), ["target-unresolved"]);
  // resolved artifacts supplied but declaring nothing: the BOM cannot be confirmed
  const resolvedNoBom = readProjectSdkIdentity(project({ "gradle.properties": "x=y\n" }), { resolvedArtifacts: RESOLVED });
  assert.equal(resolvedNoBom.status, "resolved");
  assert.deepEqual(codesOf(loadVerifiedCompatibilityEvidence([RECORD_PATH], source, resolvedNoBom, io)), ["context-mismatch"]);

  const staleRoot = project({ "gradle/libs.versions.toml": catalog("9.9.9"), "gradle.properties": "a=1\n" });
  const stale = readProjectSdkIdentity(staleRoot, { resolvedArtifacts: RESOLVED });
  fs.appendFileSync(path.join(staleRoot, "gradle.properties"), "b=2\n");
  const refused = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, stale, io);
  assert.deepEqual(codesOf(refused), ["target-unresolved"]);
  assert.match(refused.rejected[0].detail, /changed/);
  const fresh = readProjectSdkIdentity(staleRoot, { resolvedArtifacts: RESOLVED });
  assert.equal(loadVerifiedCompatibilityEvidence([RECORD_PATH], source, fresh, io).accepted.length, 1);
});

test("source 0.13.3 -> target 6.1.0 with no reviewed mapping stays unknown even though every version string is valid", () => {
  const source = sourceOf();
  assert.equal(source.packageRevision, "0.13.3");
  const target61 = readProjectSdkIdentity(project({ "gradle/libs.versions.toml": catalog("6.1.0") }), { resolvedArtifacts: [{ coordinate: TARGET61_COORD, sha256: TARGET61_SHA }] });
  assert.equal(target61.status, "resolved");
  assert.equal(target61.declaredBom, "6.1.0");
  // the fixture index with no records
  const empty = ioFor(specFor());
  const none = loadVerifiedCompatibilityEvidence(indexedRecordPaths(empty), source, target61, empty);
  assert.deepEqual(none, { accepted: [], rejected: [] });
  assert.equal(resolveDeclarationContext(source, target61, none.accepted).status, "unknown");
  // the fixture 9.9.9 record does not apply to a 6.1.0 target either
  const { io } = scenario();
  const mismatch = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, target61, io);
  assert.deepEqual(codesOf(mismatch), ["context-mismatch"]);
  // and the PACKAGED index (host io) has no records at all
  const packaged = loadVerifiedCompatibilityEvidence(indexedRecordPaths(), source, target61);
  assert.deepEqual(packaged, { accepted: [], rejected: [] });
  const context = resolveDeclarationContext(source, target61, packaged.accepted);
  assert.equal(context.status, "unknown");
  assert.deepEqual(context.verifiedSymbols, []);
  assert.deepEqual(context.evidencePaths, []);
});

test("brief snippet: two projects with identical resolved SDK artifacts reuse one record; a changed artifact or configuration is not carried over", () => {
  const { io, source } = scenario();
  const recordPath = RECORD_PATH;
  const projectA = identityA;
  const projectB = identityB;
  const changedArtifactProject = readProjectSdkIdentity(rootA, { resolvedArtifacts: [{ coordinate: TARGET_COORD, sha256: TARGET_ALT_SHA }, { coordinate: APP_COORD, sha256: APP_SHA }] });
  assert.equal(changedArtifactProject.status, "resolved");
  assert.notEqual(projectA.fingerprint, projectB.fingerprint, "different configuration bytes: different fingerprints");
  assert.notEqual(projectA.projectRoot, projectB.projectRoot);

  const a = loadVerifiedCompatibilityEvidence([recordPath], source, projectA, io).accepted[0];
  const b = loadVerifiedCompatibilityEvidence([recordPath], source, projectB, io).accepted[0];
  assert.equal(a.record.sha256,b.record.sha256);
  assert.notEqual(a.binding.projectFingerprint,b.binding.projectFingerprint);
  assert.equal(loadVerifiedCompatibilityEvidence([recordPath], source, changedArtifactProject, io).accepted.length,0);
  assert.equal(resolveDeclarationContext(source, projectB, [a]).status,"unknown");

  assert.equal(a.binding.artifactsFingerprint, b.binding.artifactsFingerprint, "the normalized SDK artifact set is the same for both");
  assert.deepEqual(codesOf(loadVerifiedCompatibilityEvidence([recordPath], source, changedArtifactProject, io)), ["context-mismatch"], "a changed target artifact rejects mapping applicability");
  assert.equal(resolveDeclarationContext(source, projectA, [a]).status, "target-compatible");
  assert.equal(resolveDeclarationContext(source, projectB, [b]).status, "target-compatible");
  assert.equal(resolveDeclarationContext(source, projectA, [b]).status, "unknown", "evidence bound to B does not speak for A");

  // change B's configuration without changing artifacts: the old binding is refused, fresh verification succeeds with the same record
  fs.appendFileSync(path.join(rootB, "gradle.properties"), "android.useAndroidX=true\n");
  const projectB2 = readProjectSdkIdentity(rootB, { resolvedArtifacts: RESOLVED });
  assert.notEqual(projectB2.fingerprint, projectB.fingerprint);
  assert.equal(resolveDeclarationContext(source, projectB2, [b]).status, "unknown", "a changed project configuration invalidates the old binding");
  const b2 = loadVerifiedCompatibilityEvidence([recordPath], source, projectB2, io).accepted[0];
  assert.ok(b2, "fresh verification against the changed project succeeds");
  assert.equal(b2.record.sha256, a.record.sha256, "…with the same reusable reviewed mapping");
  assert.equal(b2.binding.projectFingerprint, projectB2.fingerprint);
  assert.equal(resolveDeclarationContext(source, projectB2, [b2]).status, "target-compatible");
  // a declared-only view of the same project never matches a binding made from resolved evidence
  assert.equal(resolveDeclarationContext(source, readProjectSdkIdentity(rootA), [a]).status, "unknown");
});

// ═══ 4. context resolution ═════════════════════════════════════════════════════════════════════

test("only loader-branded evidence counts; a structurally identical plain object and a caller-built source are refused", () => {
  const { io, source } = scenario();
  const [a] = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, identityA, io).accepted;
  const forged = JSON.parse(JSON.stringify(a));
  assert.deepEqual(Object.keys(forged).sort(), Object.keys(a).sort(), "the forgery is structurally identical");
  assert.equal(resolveDeclarationContext(source, identityA, [forged]).status, "unknown");
  assert.deepEqual(resolveDeclarationContext(source, identityA, [forged]).verifiedSymbols, []);
  assert.equal(resolveDeclarationContext(source, identityA, [a, forged]).status, "target-compatible", "genuine evidence beside a forgery still counts on its own");
  const spread = { ...a };
  assert.equal(resolveDeclarationContext(source, identityA, [spread]).status, "unknown");

  const fakeSource = JSON.parse(JSON.stringify(source));
  assert.throws(() => resolveDeclarationContext(fakeSource, identityA, [a]), /readDeclarationIdentity/);
  const viaFake = loadVerifiedCompatibilityEvidence([RECORD_PATH], fakeSource, identityA, io);
  assert.deepEqual(codesOf(viaFake), ["context-mismatch"]);
  assert.match(viaFake.rejected[0].detail, /readDeclarationIdentity/);
});

test("no target is historical; conflicting applicable records are incompatible; disjoint scopes keep their own verdicts", () => {
  const source = sourceOf();
  const compatible = recordFor(source);
  const conflict = recordFor(source, { id: "fixture-conflict", verdict: "incompatible" });
  const disjoint = recordFor(source, { id: "fixture-vector3", verdict: "incompatible", symbols: [VECTOR3], sourceFiles: [{ path: MATH_REL, sha256: sha256(MATH_MD) }] });
  const spec = specFor({ records: [
    { rel: RECORD_REL, bytes: recordBytes(compatible) },
    { rel: "records/fixture-conflict.json", bytes: recordBytes(conflict) },
    { rel: "records/fixture-vector3.json", bytes: recordBytes(disjoint) },
  ] });
  const io = ioFor(spec);
  const conflictPath = path.join(DATA_DIR, "records/fixture-conflict.json");
  const disjointPath = path.join(DATA_DIR, "records/fixture-vector3.json");

  const [a] = loadVerifiedCompatibilityEvidence([RECORD_PATH], source, identityA, io).accepted;
  assert.equal(resolveDeclarationContext(source, null, [a]).status, "historical");
  assert.deepEqual(resolveDeclarationContext(source, null, [a]).verifiedSymbols, []);
  assert.deepEqual(resolveDeclarationContext(source, null, [a]).evidencePaths, []);

  const both = loadVerifiedCompatibilityEvidence([RECORD_PATH, conflictPath], source, identityA, io);
  assert.equal(both.accepted.length, 2);
  const conflicting = resolveDeclarationContext(source, identityA, both.accepted);
  assert.equal(conflicting.status, "incompatible");
  assert.deepEqual(conflicting.verifiedSymbols, [], "a conflicted symbol is not verified compatible");
  assert.deepEqual([...conflicting.evidencePaths].sort(), [RECORD_PATH, conflictPath].sort());

  const single = loadVerifiedCompatibilityEvidence([conflictPath], source, identityA, io);
  assert.equal(resolveDeclarationContext(source, identityA, single.accepted).status, "incompatible");

  const split = loadVerifiedCompatibilityEvidence([RECORD_PATH, disjointPath], source, identityA, io);
  assert.equal(split.accepted.length, 2);
  const mixed = resolveDeclarationContext(source, identityA, split.accepted);
  assert.equal(mixed.status, "incompatible", "one verified-incompatible scope makes the target context incompatible");
  assert.deepEqual(mixed.verifiedSymbols, [SYMBOL], "the compatible scope stays verified; Vector3 is the incompatible one");
});

// ═══ 5. host adapter, purity, read-only ═════════════════════════════════════════════════════════

test("the host artifact lookup answers only exact hashes inside the Gradle module cache and never runs anything", () => {
  const gradleHome = project({});
  const moduleDir = path.join(gradleHome, "caches", "modules-2", "files-2.1", "com.pico.spatial.fixture", "core", "9.9.9", "0123abcd");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, "core-9.9.9.aar"), TARGET_BYTES);
  const host = hostDeclarationIO({ GRADLE_USER_HOME: gradleHome }, "/nonexistent-home");
  assert.equal(host.artifactPath(TARGET_COORD, TARGET_SHA), path.join(moduleDir, "core-9.9.9.aar"));
  assert.equal(host.artifactPath(TARGET_COORD, TARGET_ALT_SHA), null, "same coordinate, different bytes: not found");
  assert.equal(host.artifactPath("com.pico.spatial.fixture:core:9.9.9:sources@jar", TARGET_SHA), null, "a classifier names a different file");
  assert.equal(host.artifactPath("../../../etc:passwd:1.0@txt", TARGET_SHA), null, "a malformed coordinate never leaves the cache");
  assert.equal(host.artifactPath("com.pico.spatial.fixture:core:9.9.9", TARGET_SHA), null, "no extension: not an artifact identifier");
  const defaultHome = hostDeclarationIO({}, gradleHome.replace(/\/$/, ""));
  assert.equal(defaultHome.artifactPath(TARGET_COORD, TARGET_SHA), null, "without GRADLE_USER_HOME the lookup is under <home>/.gradle, which is empty here");
  fs.mkdirSync(path.join(gradleHome, ".gradle"), { recursive: true });
  fs.cpSync(path.join(gradleHome, "caches"), path.join(gradleHome, ".gradle", "caches"), { recursive: true });
  assert.equal(hostDeclarationIO({}, gradleHome).artifactPath(TARGET_COORD, TARGET_SHA), path.join(gradleHome, ".gradle", "caches", "modules-2", "files-2.1", "com.pico.spatial.fixture", "core", "9.9.9", "0123abcd", "core-9.9.9.aar"));
  assert.equal(host.read(path.join(moduleDir, "core-9.9.9.aar")).toString(), TARGET_BYTES);
  assert.equal(host.read(moduleDir), null, "a directory is not a readable file");
  assert.deepEqual(host.entries(moduleDir), ["core-9.9.9.aar"]);
  assert.equal(host.entries(path.join(moduleDir, "nope")), null);
  assert.equal(host.realpath(path.join(moduleDir, "nope")), null);
});

test("the module reads only; it never spawns a process, runs Gradle or the CLI, or writes to a project", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src", "declarationcontext.ts"), "utf8");
  for (const banned of ["child_process", "execFile", "execSync", "spawnSync", "spawn(", "gradlew", "node:http", "fetch(", "writeFileSync", "mkdirSync", "picocli", "knowledge.js"]) {
    assert.ok(!source.includes(banned), `src/declarationcontext.ts must not contain ${banned}`);
  }
  const { io, source: identity } = scenario();
  const before = hashTree(rootA);
  loadVerifiedCompatibilityEvidence([RECORD_PATH], identity, identityA, io);
  readDeclarationIdentity(VAULT, io);
  assert.equal(hashTree(rootA), before, "the project tree is untouched");
  assert.equal(typeof io.tree.reads.find((p) => p === RECORD_PATH), "string", "the record was read through the injected io");
  assert.ok(!Object.keys(io).some((k) => /write|remove|unlink/i.test(k)), "the DeclarationIO surface has no write channel");
});
