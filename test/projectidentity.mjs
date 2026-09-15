// Task S3 — the static project SDK-identity reader.
//
// What this suite exists to prevent: generation, cloning or a toolchain change quietly
// rewriting (or mis-reading) the dependency identity a project declares. The reader is
// STATIC — it reads a bounded allowlist of project files and never invokes Gradle — so
// every fixture here is a real temporary project on disk, and the suite asserts bytes,
// not intentions.
//
// Run: node --test test/projectidentity.mjs   (npm run build first — this imports dist/)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { readProjectSdkIdentity, PROJECT_IDENTITY_FILES } = await import("../dist/projectidentity.js");
const { SKELETON_ROOT } = await import("../dist/projectgen.js");

const CATALOG = "gradle/libs.versions.toml";

/** The exact catalog shape appskeleton/gradle/libs.versions.toml:1-14 ships (BOM pinned at line 5). */
function skeletonCatalog(version = "6.0.0") {
  return [
    "[versions]",
    'agp = "8.13.2"',
    `bom = "${version}"`,
    "",
    "[libraries]",
    'bom = { group = "com.pico.spatial", name = "bom", version.ref = "bom" }',
    'core = { group = "com.pico.spatial.core", name = "core" }',
    "",
  ].join("\n");
}

/** The exact dependency shape appskeleton/app/build.gradle.kts:50 ships. */
function appGradleWithCatalogPlatform() {
  return ["dependencies {", "    implementation(platform(libs.bom))", "    implementation(libs.core)", "}", ""].join("\n");
}

let sandboxes = [];
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "projectidentity "));
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

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ------------------------------------------------------------------ declared forms

test("the version-catalog alias form the app skeleton ships is a declared BOM", () => {
  const root = project({
    [CATALOG]: skeletonCatalog(),
    "settings.gradle.kts": 'rootProject.name = "x"\ninclude(":app")\n',
    "app/build.gradle.kts": appGradleWithCatalogPlatform(),
  });
  const id = readProjectSdkIdentity(root);
  assert.equal(id.status, "declared");
  assert.equal(id.declaredBom, "6.0.0");
  assert.deepEqual(id.resolvedArtifacts, []);
  assert.ok(
    id.reasons.some((r) => r.includes(CATALOG)),
    `reasons must cite the catalog: ${JSON.stringify(id.reasons)}`,
  );
});

test("a version catalog alone yields declared — no build-file reference required", () => {
  const root = project({ [CATALOG]: skeletonCatalog("6.1.0") });
  const id = readProjectSdkIdentity(root);
  assert.equal(id.status, "declared");
  assert.equal(id.declaredBom, "6.1.0");
});

test("a literal platform() coordinate in a build file is a declared BOM with no catalog at all", () => {
  const root = project({
    "app/build.gradle.kts": 'dependencies {\n    implementation(platform("com.pico.spatial:bom:6.1.0"))\n}\n',
  });
  const id = readProjectSdkIdentity(root);
  assert.equal(id.status, "declared");
  assert.equal(id.declaredBom, "6.1.0");
  assert.ok(id.reasons.some((r) => r.includes("app/build.gradle.kts")));
});

test("a Groovy build.gradle literal and enforcedPlatform are read the same way", () => {
  const groovy = project({ "app/build.gradle": "dependencies {\n    implementation platform('com.pico.spatial:bom:6.0.1')\n}\n" });
  assert.equal(readProjectSdkIdentity(groovy).declaredBom, "6.0.1");
  const enforced = project({ "build.gradle.kts": 'dependencies {\n    api(enforcedPlatform("com.pico.spatial:bom:6.2.0"))\n}\n' });
  assert.equal(readProjectSdkIdentity(enforced).declaredBom, "6.2.0");
});

test("the packaged app skeleton itself declares BOM 6.0.0 (appskeleton/gradle/libs.versions.toml:5)", () => {
  const id = readProjectSdkIdentity(SKELETON_ROOT);
  assert.equal(id.status, "declared");
  assert.equal(id.declaredBom, "6.0.0");
  assert.equal(
    id.declaredBom,
    /^bom = "([^"]+)"$/m.exec(fs.readFileSync(path.join(SKELETON_ROOT, "gradle/libs.versions.toml"), "utf8"))[1],
    "the reader must agree with the catalog line it claims to read",
  );
});

test("a BOM library entry whose artifact is not literally named 'bom' is found through its platform(libs.alias) pair", () => {
  const root = project({
    [CATALOG]: ['[versions]', 'picoPlatform = "6.3.0"', "", "[libraries]", 'pico-platform = { group = "com.pico.spatial", name = "platform-bom", version.ref = "picoPlatform" }', ""].join("\n"),
    "app/build.gradle.kts": "dependencies {\n    implementation(platform(libs.pico.platform))\n}\n",
  });
  const id = readProjectSdkIdentity(root);
  assert.equal(id.status, "declared");
  assert.equal(id.declaredBom, "6.3.0");
});

// ------------------------------------------------------------------ unknown forms

test("dynamic version providers are unknown, never guessed, with a file-specific reason", () => {
  for (const dynamic of ["+", "6.0.+", "[6.0,7.0)", "latest.release", "6.0.0-SNAPSHOT"]) {
    const root = project({ [CATALOG]: skeletonCatalog(dynamic) });
    const id = readProjectSdkIdentity(root);
    assert.equal(id.status, "unknown", `"${dynamic}" must not be treated as a literal`);
    assert.equal(id.declaredBom, null);
    assert.ok(id.reasons.some((r) => r.includes(CATALOG) && r.includes(dynamic)), `reason must name the file and the value: ${JSON.stringify(id.reasons)}`);
  }
});

test("a version interpolated from a property or a Gradle provider is unknown", () => {
  const interpolated = project({ "app/build.gradle.kts": 'dependencies {\n    implementation(platform("com.pico.spatial:bom:$bomVersion"))\n}\n' });
  const a = readProjectSdkIdentity(interpolated);
  assert.equal(a.status, "unknown");
  assert.ok(a.reasons.some((r) => r.includes("app/build.gradle.kts")));

  const findProperty = project({
    "gradle.properties": "picoBom=6.0.0\n",
    "app/build.gradle.kts": 'dependencies {\n    implementation(platform("com.pico.spatial:bom:" + project.findProperty("picoBom")))\n}\n',
  });
  const b = readProjectSdkIdentity(findProperty);
  assert.equal(b.status, "unknown", "a property lookup is not a static declaration, even when the property is right there");
  assert.equal(b.declaredBom, null);
});

test("a catalog alias pointing at a missing or non-literal version is unknown", () => {
  const missingAlias = project({ [CATALOG]: ["[libraries]", 'bom = { group = "com.pico.spatial", name = "bom", version.ref = "bom" }', ""].join("\n") });
  const a = readProjectSdkIdentity(missingAlias);
  assert.equal(a.status, "unknown");
  assert.ok(a.reasons.some((r) => r.includes("version.ref") || r.includes("bom")));

  const richVersion = project({ [CATALOG]: ["[versions]", 'bom = { require = "6.0.0" }', "", "[libraries]", 'bom = { group = "com.pico.spatial", name = "bom", version.ref = "bom" }', ""].join("\n") });
  assert.equal(readProjectSdkIdentity(richVersion).status, "unknown", "a rich version constraint is not the supported literal form");
});

test("conflicting declarations across files are unknown and both files are named", () => {
  const root = project({
    [CATALOG]: skeletonCatalog("6.0.0"),
    "app/build.gradle.kts": 'dependencies {\n    implementation(platform("com.pico.spatial:bom:6.1.0"))\n}\n',
  });
  const id = readProjectSdkIdentity(root);
  assert.equal(id.status, "unknown");
  assert.equal(id.declaredBom, null);
  const joined = id.reasons.join(" | ");
  assert.ok(joined.includes(CATALOG) && joined.includes("app/build.gradle.kts"), `both files must be named: ${joined}`);
  assert.ok(joined.includes("6.0.0") && joined.includes("6.1.0"), `both versions must be named: ${joined}`);
});

test("a project with no catalog and no platform() declaration is unknown, not null-declared-as-fact", () => {
  const root = project({ "settings.gradle.kts": 'rootProject.name = "x"\n', "app/build.gradle.kts": "dependencies {\n    implementation(libs.androidx.core.ktx)\n}\n" });
  const id = readProjectSdkIdentity(root);
  assert.equal(id.status, "unknown");
  assert.equal(id.declaredBom, null);
  assert.ok(id.reasons.some((r) => r.includes(CATALOG) || r.includes("no com.pico.spatial")), JSON.stringify(id.reasons));
});

test("a missing or unreadable project root is unknown, never a throw", () => {
  const root = path.join(os.tmpdir(), "projectidentity-absent-" + crypto.randomBytes(6).toString("hex"));
  const id = readProjectSdkIdentity(root);
  assert.equal(id.status, "unknown");
  assert.equal(id.declaredBom, null);
  assert.ok(id.reasons.length > 0);
  assert.equal(typeof id.fingerprint, "string");
});

test("a settings file that relocates the version catalog suppresses catalog evidence instead of trusting the wrong file", () => {
  const root = project({
    [CATALOG]: skeletonCatalog("6.0.0"),
    "settings.gradle.kts": 'dependencyResolutionManagement {\n  versionCatalogs { create("libs") { from(files("../shared/libs.versions.toml")) } }\n}\n',
  });
  const id = readProjectSdkIdentity(root);
  assert.equal(id.status, "unknown");
  assert.ok(id.reasons.some((r) => r.includes("settings.gradle.kts")), JSON.stringify(id.reasons));
});

test("commented-out declarations are not declarations", () => {
  const root = project({
    [CATALOG]: skeletonCatalog("6.0.0") + '\n# bom = "9.9.9"\n',
    "app/build.gradle.kts": [
      "dependencies {",
      '    // implementation(platform("com.pico.spatial:bom:9.9.9"))',
      '    /* implementation(platform("com.pico.spatial:bom:8.8.8")) */',
      "    implementation(platform(libs.bom))",
      "}",
      "",
    ].join("\n"),
  });
  const id = readProjectSdkIdentity(root);
  assert.equal(id.status, "declared", JSON.stringify(id.reasons));
  assert.equal(id.declaredBom, "6.0.0");
});

test("a repository URL is not mistaken for a comment", () => {
  const root = project({
    [CATALOG]: skeletonCatalog("6.0.0"),
    "settings.gradle.kts": 'dependencyResolutionManagement {\n  repositories {\n    maven { url = uri("https://artifact.bytedance.com/repository/Volcengine/") }\n  }\n}\n',
    "app/build.gradle.kts": appGradleWithCatalogPlatform(),
  });
  assert.equal(readProjectSdkIdentity(root).declaredBom, "6.0.0");
});

// ------------------------------------------------------------------ fingerprint

test("the fingerprint covers the allowlist, is stable, and ignores everything outside it", () => {
  const files = {
    [CATALOG]: skeletonCatalog(),
    "settings.gradle.kts": 'rootProject.name = "x"\n',
    "build.gradle.kts": "plugins { }\n",
    "gradle.properties": "org.gradle.jvmargs=-Xmx4g\n",
    "app/build.gradle.kts": appGradleWithCatalogPlatform(),
  };
  const root = project(files);
  const first = readProjectSdkIdentity(root).fingerprint;
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(readProjectSdkIdentity(root).fingerprint, first, "repeated reads of an unchanged tree must agree");

  // Something outside the allowlist changes nothing.
  fs.mkdirSync(path.join(root, "app/src/main"), { recursive: true });
  fs.writeFileSync(path.join(root, "app/src/main/AndroidManifest.xml"), "<manifest/>\n");
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.writeFileSync(path.join(root, "build/libs.versions.toml"), skeletonCatalog("9.9.9"));
  assert.equal(readProjectSdkIdentity(root).fingerprint, first, "only the bounded allowlist may feed the fingerprint");
  assert.equal(readProjectSdkIdentity(root).declaredBom, "6.0.0", "a stray catalog under build/ must not be read");

  // Any allowlisted byte changes it.
  for (const rel of Object.keys(files)) {
    const abs = path.join(root, ...rel.split("/"));
    const before = fs.readFileSync(abs);
    fs.writeFileSync(abs, Buffer.concat([before, Buffer.from("\n")]));
    assert.notEqual(readProjectSdkIdentity(root).fingerprint, first, `${rel} must feed the fingerprint`);
    fs.writeFileSync(abs, before);
  }
  assert.equal(readProjectSdkIdentity(root).fingerprint, first, "restoring the bytes restores the fingerprint");

  // Deleting an allowlisted file changes it too.
  fs.rmSync(path.join(root, "gradle.properties"));
  assert.notEqual(readProjectSdkIdentity(root).fingerprint, first);
});

test("the fingerprint is content identity: two roots with identical files agree, and the canonical root is reported separately", () => {
  const files = { [CATALOG]: skeletonCatalog(), "app/build.gradle.kts": appGradleWithCatalogPlatform() };
  const a = readProjectSdkIdentity(project(files));
  const b = readProjectSdkIdentity(project(files));
  assert.equal(a.fingerprint, b.fingerprint, "the root must not be hashed into the fingerprint");
  assert.notEqual(a.projectRoot, b.projectRoot, "the canonical root is carried separately, and distinguishes the two projects");
  assert.equal(a.projectRoot, fs.realpathSync(a.projectRoot), "projectRoot is canonical");

  const c = readProjectSdkIdentity(project({ ...files, [CATALOG]: skeletonCatalog("6.1.0") }));
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test("two projects with no allowlisted files share a fingerprint and are told apart by projectRoot alone", () => {
  const a = readProjectSdkIdentity(project({ "README.md": "x\n" }));
  const b = readProjectSdkIdentity(project({ "README.md": "y\n" }));
  assert.equal(a.fingerprint, b.fingerprint, "content identity of two empty declarations is genuinely the same");
  assert.notEqual(a.projectRoot, b.projectRoot);
  assert.equal(a.status, "unknown");
  assert.equal(b.status, "unknown");
});

test("the allowlist is exactly the bounded set, sorted, with no path escaping it", () => {
  assert.deepEqual(
    [...PROJECT_IDENTITY_FILES],
    ["app/build.gradle", "app/build.gradle.kts", "build.gradle", "build.gradle.kts", "gradle.properties", "gradle/libs.versions.toml", "settings.gradle", "settings.gradle.kts"],
  );
  for (const rel of PROJECT_IDENTITY_FILES) {
    assert.ok(!rel.includes(".."), `${rel} must not escape the project root`);
    assert.ok(!path.isAbsolute(rel), `${rel} must be project-relative`);
  }
});

test("a hostile project path (space + non-ASCII) is read and canonicalised without escaping", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "projectidentity é "));
  sandboxes.push(parent);
  const root = path.join(parent, "a project (é)");
  fs.mkdirSync(path.join(root, "gradle"), { recursive: true });
  fs.writeFileSync(path.join(root, CATALOG.split("/").join(path.sep)), skeletonCatalog("6.4.0"));
  const id = readProjectSdkIdentity(root);
  assert.equal(id.declaredBom, "6.4.0");
  assert.equal(id.projectRoot, fs.realpathSync(root));
});

// ------------------------------------------------------------------ resolvedArtifacts

test("resolvedArtifacts stays empty unless verified evidence is supplied by a separate boundary", () => {
  const root = project({ [CATALOG]: skeletonCatalog(), "app/build.gradle.kts": appGradleWithCatalogPlatform() });
  assert.deepEqual(readProjectSdkIdentity(root).resolvedArtifacts, []);
  assert.equal(readProjectSdkIdentity(root).status, "declared", "a catalog alone is declared, never resolved");

  const evidence = [{ coordinate: "com.pico.spatial:bom:6.0.0", sha256: "a".repeat(64) }];
  const withEvidence = readProjectSdkIdentity(root, { resolvedArtifacts: evidence });
  assert.equal(withEvidence.status, "resolved");
  assert.deepEqual([...withEvidence.resolvedArtifacts], evidence);
  assert.equal(withEvidence.declaredBom, "6.0.0", "supplying resolved evidence must not erase the declaration");

  // The result must not alias the caller's array.
  evidence.push({ coordinate: "junk", sha256: "b".repeat(64) });
  assert.equal(withEvidence.resolvedArtifacts.length, 1, "the result must hold its own copy of the evidence");
});

test("malformed resolved evidence is refused rather than upgraded to 'resolved'", () => {
  const root = project({ [CATALOG]: skeletonCatalog() });
  for (const bad of [[{ coordinate: "", sha256: "a".repeat(64) }], [{ coordinate: "g:a:1", sha256: "nothex" }], [{ coordinate: "g:a:1" }], ["g:a:1"]]) {
    const id = readProjectSdkIdentity(root, { resolvedArtifacts: bad });
    assert.notEqual(id.status, "resolved", `${JSON.stringify(bad)} is not verified evidence`);
    assert.deepEqual(id.resolvedArtifacts, []);
    assert.ok(id.reasons.some((r) => r.toLowerCase().includes("resolved")), JSON.stringify(id.reasons));
  }
  assert.equal(readProjectSdkIdentity(root, { resolvedArtifacts: [] }).status, "declared", "an empty evidence list is simply no evidence");
});

// ------------------------------------------------------------------ purity

test("the reader never runs Gradle or any other process", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/projectidentity.ts"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("/*"))
    .join("\n");
  for (const banned of ["child_process", "execFile", "execSync", "spawnSync", "spawn(", "sdk-facts", "gradlew", "./toolchain.js", "node:http"]) {
    assert.ok(!code.includes(banned), `src/projectidentity.ts must not reference ${banned}`);
  }
});

test("reading an identity leaves the project untouched", () => {
  const files = { [CATALOG]: skeletonCatalog(), "app/build.gradle.kts": appGradleWithCatalogPlatform(), "gradle.properties": "a=b\n" };
  const root = project(files);
  const listing = (dir) => {
    const out = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(`${path.relative(dir, p)}:${sha256(fs.readFileSync(p))}`);
      }
    })(dir);
    return out;
  };
  const before = listing(root);
  readProjectSdkIdentity(root, { resolvedArtifacts: [{ coordinate: "com.pico.spatial:bom:6.0.0", sha256: "c".repeat(64) }] });
  assert.deepEqual(listing(root), before, "the reader is read-only");
});
