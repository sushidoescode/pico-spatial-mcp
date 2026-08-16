import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSubmissionSources, findEvidence, findFactEvidence } from "../benchmarks/spatial-agent-bench/lib/source.mjs";

function scratch(t, prefix = "agentbench-source-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

test("inventory is stable and masks untrusted Kotlin, TOML, and XML prose without moving lines", (t) => {
  const project = scratch(t);
  write(project, "README.md", "ignored\n");
  write(project, "build/generated/Stuff.kt", "class Ignored\n");
  write(project, ".gradle/cache.gradle.kts", "plugins {}\n");
  write(project, "app/build.gradle.kts", `plugins { alias(libs.plugins.android.application) }\ndependencies { implementation(platform(libs.spatial.bom)) }\n`);
  write(project, "app/src/main/java/com/agentbench/Foo.kt", String.raw`package com.agentbench

/* fake in comment
   /* nested fake PlaneTrackingManager.stop() */
*/
// fake in comment: com.pico.spatial 0.13.3
val slash: Char = '/'
val quote: Char = '\''
val escaped = "arbitrary com.pico.spatial \"0.13.3\""
val raw = """<activity android:name=".Forged" />
com.pico.spatial 0.13.3"""
fun startTracking() {
  PlaneTrackingManager.start()
}
`);
  write(project, "gradle/libs.versions.toml", `[versions]\nsdk = "0.13.3" # com.pico.spatial:forged and <activity android:name=".Forged" />\n\n[libraries]\nspatial-bom = { module = "com.pico.spatial:bom", version.ref = "sdk" }\n\n[plugins]\nandroid-application = { id = "com.android.application", version.ref = "sdk" }\n`);
  write(project, "app/src/main/AndroidManifest.xml", `<?xml version="1.0" encoding="utf-8"?>\n<!-- com.pico.spatial 0.13.3 <activity android:name=".Forged" /> -->\n<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.example.agentbench">\n  <application android:name=".BenchApplication">\n    untrusted com.pico.spatial 0.13.3 activity text\n    <activity android:name=".LaunchActivity" />\n    <meta-data android:name="org.example.mode" android:value="spatial" />\n  </application>\n</manifest>\n`);

  const index = loadSubmissionSources(project);

  assert.equal(index.projectDir, fs.realpathSync(project));
  assert.deepEqual(index.files.map((file) => file.path), [
    "app/build.gradle.kts",
    "app/src/main/AndroidManifest.xml",
    "app/src/main/java/com/agentbench/Foo.kt",
    "gradle/libs.versions.toml",
  ]);
  assert.deepEqual(index.files.map((file) => file.kind), ["gradle", "manifest", "kotlin", "gradle"]);
  const kotlin = index.files.find((file) => file.kind === "kotlin");
  assert.equal(kotlin.structural.includes("PlaneTrackingManager.start()"), true);
  assert.equal(kotlin.structural.includes("fake in comment"), false);
  assert.equal(kotlin.structural.includes("com.pico.spatial"), false);
  assert.equal(kotlin.structural.includes(".Forged"), false);
  assert.equal(kotlin.structural.split("\n").length, kotlin.original.split("\n").length);
  for (const file of index.files) {
    assert.equal(file.structural.split("\n").length, file.original.split("\n").length, file.path);
    assert.equal(path.isAbsolute(file.absolutePath), true);
  }
  const manifest = index.files.find((file) => file.kind === "manifest");
  const catalog = index.files.find((file) => file.path.endsWith(".toml"));
  assert.equal(manifest.structural.includes(".Forged"), false);
  assert.equal(manifest.structural.includes("untrusted com.pico.spatial"), false);
  assert.equal(catalog.structural.includes("forged"), false);
  assert.equal(catalog.structural.includes("com.pico.spatial"), false);
  assert.equal(catalog.structural.includes("0.13.3"), false);
  assert.deepEqual(index.facts.gradle.pluginIds, ["com.android.application"]);
  assert.deepEqual(index.facts.gradle.moduleCoordinates, ["com.pico.spatial:bom"]);
  assert.deepEqual(index.facts.gradle.versions, { sdk: "0.13.3" });
  assert.deepEqual(index.facts.gradle.applicationIds, ["org.example.agentbench"]);
  assert.deepEqual(index.facts.manifest, {
    applicationName: ".BenchApplication",
    activities: [".LaunchActivity"],
    metadata: [{ name: "org.example.mode", value: "spatial", resource: null }],
  });
  assert.equal(index.totalBytes, index.files.reduce((sum, file) => sum + Buffer.byteLength(file.original), 0));
});

test("Kotlin script masking stays aligned after non-BMP characters", (t) => {
  const project = scratch(t);
  write(project, "scripts/Setup.kts", `val bait = "😀 hidden payload"\nTrustedCall.after()\n`);

  const index = loadSubmissionSources(project);
  const script = index.files[0];

  assert.equal(script.path, "scripts/Setup.kts");
  assert.equal(script.kind, "kotlin");
  assert.equal(script.structural.length, script.original.length);
  assert.equal(script.structural.includes("hidden payload"), false);
  assert.equal(script.structural.includes("TrustedCall.after()"), true);
});

test("Groovy slashy, dollar-slashy, and triple-single strings are masked without moving lines", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle", `def slashy = /com.pico.spatial:forged:0.13.3\n<activity name='.Forged' \\/>/\ndef dollarSlashy = $/com.pico.spatial:forged:0.13.3\n<activity name='.Forged' />/$\ndef tripleSingle = '''com.pico.spatial:forged:0.13.3\n<activity name='.Forged' />'''\ndependencies { implementation('org.example:real:1.0') }\n`);

  const index = loadSubmissionSources(project);
  const gradle = index.files[0];

  assert.equal(gradle.structural.includes("com.pico.spatial"), false);
  assert.equal(gradle.structural.includes("0.13.3"), false);
  assert.equal(gradle.structural.includes(".Forged"), false);
  assert.equal(gradle.structural.split("\n").length, gradle.original.split("\n").length);
  assert.deepEqual(index.facts.gradle.moduleCoordinates, ["org.example:real"]);
});

test("escaped Groovy triple-quote delimiters cannot expose dependency-shaped text", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle", String.raw`dependencies {
  def single = '''hidden \'''
  implementation('org.example:forged-single:9.9')
  \''' still hidden'''
  def double = """hidden \"""
  implementation("org.example:forged-double:9.9")
  \""" still hidden"""
  implementation('org.example:real:1.0')
}
`);

  const index = loadSubmissionSources(project);
  const gradle = index.files[0];

  assert.equal(gradle.structural.includes("forged-single"), false);
  assert.equal(gradle.structural.includes("forged-double"), false);
  assert.equal(gradle.structural.split("\n").length, gradle.original.split("\n").length);
  assert.deepEqual(index.facts.gradle.moduleCoordinates, ["org.example:real"]);
});

test("overlapping escaped Groovy triple-quote delimiters retain the real closer", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle", String.raw`dependencies {
  def single = '''hidden \''''
  def double = """hidden \""""
  implementation('org.example:real:1.0')
}
`);

  const index = loadSubmissionSources(project);
  const gradle = index.files[0];

  assert.equal(gradle.structural.includes("hidden"), false);
  assert.deepEqual(index.facts.gradle.moduleCoordinates, ["org.example:real"]);
});

test("Groovy return slashy and escaped dollar-slashy delimiters cannot expose bait", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle", `def bait() { return /com.pico.spatial:forged:0.13.3/ }\ndef escapedDelimiter = $/com.pico.spatial:forged $/$ still-hidden 0.13.3 /$\ndependencies { implementation('org.example:real:1.0') }\n`);

  const index = loadSubmissionSources(project);
  const gradle = index.files[0];

  assert.equal(gradle.structural.includes("com.pico.spatial"), false);
  assert.equal(gradle.structural.includes("still-hidden"), false);
  assert.equal(gradle.structural.includes("0.13.3"), false);
  assert.equal(gradle.structural.split("\n").length, gradle.original.split("\n").length);
  assert.deepEqual(index.facts.gradle.moduleCoordinates, ["org.example:real"]);
});

test("Groovy command-expression and closure-arrow slashy strings cannot expose bait", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle", `println /com.pico.spatial:forged:0.13.3/\ndef bait = { -> /com.pico.spatial:forged:0.13.3/ }\ndependencies { implementation('org.example:real:1.0') }\n`);

  const index = loadSubmissionSources(project);
  const gradle = index.files[0];

  assert.equal(gradle.structural.includes("com.pico.spatial"), false);
  assert.equal(gradle.structural.includes("0.13.3"), false);
  assert.deepEqual(index.facts.gradle.moduleCoordinates, ["org.example:real"]);
});

test("ordinary Groovy division cannot hide block boundaries and promote nested facts", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle", `dependencies { def a = x / y }\ntasks.register('bait') { def b = z / q; implementation('com.pico.spatial:forged:0.13.3') }\n`);

  assert.throws(() => loadSubmissionSources(project), /ambiguous|slash|Gradle/i);
});

test("ordinary Kotlin Gradle arithmetic remains accepted without changing block scope", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle.kts", `dependencies { val ratio = 8 / 2 }\ntasks.register("bait") { val other = 9 / 3; implementation("com.pico.spatial:forged:0.13.3") }\n`);

  const index = loadSubmissionSources(project);

  assert.deepEqual(index.facts.gradle.moduleCoordinates, []);
});

test("ambiguous multiline Groovy command-expression slash syntax fails closed", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle", `def harmless = 1; sink /com.pico.spatial:forged\nstill-bait/\n`);
  const conditionalProject = scratch(t);
  write(conditionalProject, "app/build.gradle", `if ((harmless = 1)) logger.lifecycle /com.pico.spatial:forged\nstill-bait/\n`);

  assert.throws(() => loadSubmissionSources(project), /ambiguous|slash|Gradle/i);
  assert.throws(() => loadSubmissionSources(conditionalProject), /ambiguous|slash|Gradle/i);
});

test("typed Gradle facts come only from catalog declarations and relevant balanced blocks", (t) => {
  const project = scratch(t);
  write(project, "gradle/libs.versions.toml", `[versions]\nsdk = '2.4.6'\nunused = "0.13.3"\n\n[libraries]\nspatial-runtime = { group = "org.example.spatial", name = "runtime", version.ref = "sdk" }\nunused-bait = { module = "com.pico.spatial:forged", version.ref = "unused" }\n\n[plugins]\nandroid-application = { id = "com.android.application", version.ref = "sdk" }\nunused-plugin = { id = "com.pico.spatial.forged", version.ref = "unused" }\n\n# com.pico.spatial:forged 0.13.3 <activity android:name=".Forged" />\n`);
  write(project, "app/build.gradle.kts", `// id("com.pico.spatial.forged") and implementation("com.pico.spatial:forged:0.13.3")\nplugins {\n  alias(libs.plugins.android.application)\n}\ndependencies {\n  implementation(platform(libs.spatial.runtime))\n  implementation("org.example:direct:7.1")\n  val decoy = "com.pico.spatial:forged:0.13.3"\n}\nandroid {\n  defaultConfig { applicationId = "org.example.generated" }\n}\ntasks.register("unrelated") {\n  description = "com.pico.spatial:forged:0.13.3 <activity android:name='.Forged' />"\n}\n`);
  write(project, "app/src/main/java/org/example/Canary.kt", `val bait = "com.pico.spatial:forged 0.13.3 <activity android:name='.Forged' />"\n`);
  write(project, "notes/decoy.toml", `[versions]\ndecoy = "0.13.3"\n[libraries]\nforged = { module = "com.pico.spatial:forged", version.ref = "decoy" }\n`);

  const index = loadSubmissionSources(project);

  assert.deepEqual(index.facts.gradle, {
    pluginIds: ["com.android.application"],
    moduleCoordinates: ["org.example.spatial:runtime", "org.example:direct"],
    versions: { sdk: "2.4.6" },
    applicationIds: ["org.example.generated"],
  });
  assert.deepEqual(index.facts.manifest, { applicationName: null, activities: [], metadata: [] });
  assert.equal(JSON.stringify(index.facts).includes("com.pico.spatial"), false);
  assert.equal(JSON.stringify(index.facts).includes("0.13.3"), false);
  assert.equal(JSON.stringify(index.facts).includes(".Forged"), false);
});

test("typed facts retain immutable parser-span provenance and applied alias relationships", (t) => {
  const project = scratch(t);
  write(project, "gradle/libs.versions.toml", `[versions]\nsdk = "2.4.6"\nagp = "8.6.1"\nunused = "0.13.3"\n\n[libraries]\nspatial-runtime = { module = "org.example.spatial:runtime", version.ref = "sdk" }\nunused-bait = { module = "com.pico.spatial:forged", version.ref = "unused" }\n\n[plugins]\nandroid-application = { id = "com.android.application", version.ref = "agp" }\n`);
  write(project, "app/build.gradle.kts", `plugins {\n  alias(libs.plugins.android.application)\n}\ndependencies {\n  implementation(libs.spatial.runtime)\n  implementation("org.example:direct:7.1")\n}\nandroid { defaultConfig { applicationId = "org.example.generated" } }\n`);
  write(project, "app/src/main/AndroidManifest.xml", `<manifest package="org.example.manifest">\n  <application android:name=".BenchApplication">\n    <activity android:name=".LaunchActivity" />\n    <meta-data android:name="org.example.mode" android:resource="@xml/mode" />\n  </application>\n</manifest>\n`);

  const index = loadSubmissionSources(project);

  assert.deepEqual(findFactEvidence(index, { kind: "gradle.dependency" }), [
    {
      kind: "gradle.dependency",
      value: "org.example.spatial:runtime",
      alias: "spatial.runtime",
      version: "2.4.6",
      versionRef: "sdk",
      path: "app/build.gradle.kts",
      line: 5,
      excerpt: "implementation(libs.spatial.runtime)",
    },
    {
      kind: "gradle.dependency",
      value: "org.example:direct",
      alias: null,
      version: "7.1",
      versionRef: null,
      path: "app/build.gradle.kts",
      line: 6,
      excerpt: 'implementation("org.example:direct:7.1")',
    },
  ]);
  assert.deepEqual(findFactEvidence(index, { kind: "gradle.plugin" }), [{
    kind: "gradle.plugin",
    value: "com.android.application",
    alias: "android.application",
    version: "8.6.1",
    versionRef: "agp",
    path: "app/build.gradle.kts",
    line: 2,
    excerpt: "alias(libs.plugins.android.application)",
  }]);
  assert.deepEqual(findFactEvidence(index, { kind: "gradle.version", key: "sdk" }), [{
    kind: "gradle.version",
    key: "sdk",
    value: "2.4.6",
    path: "gradle/libs.versions.toml",
    line: 2,
    excerpt: 'sdk = "2.4.6"',
  }]);
  assert.deepEqual(findFactEvidence(index, { kind: "manifest.activity", value: ".LaunchActivity" }), [{
    kind: "manifest.activity",
    value: ".LaunchActivity",
    path: "app/src/main/AndroidManifest.xml",
    line: 3,
    excerpt: '<activity android:name=".LaunchActivity" />',
  }]);
  assert.deepEqual(findFactEvidence(index, { kind: "manifest.metadata", value: "org.example.mode" }), [{
    kind: "manifest.metadata",
    value: "org.example.mode",
    metadata: { name: "org.example.mode", value: null, resource: "@xml/mode" },
    path: "app/src/main/AndroidManifest.xml",
    line: 4,
    excerpt: '<meta-data android:name="org.example.mode" android:resource="@xml/mode" />',
  }]);
  assert.equal(findFactEvidence(index).some((fact) => fact.value === "0.13.3" || fact.value === "com.pico.spatial:forged"), false);
  assert.equal(Object.isFrozen(index.factEvidence), true);
  assert.equal(index.factEvidence.every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(findFactEvidence(index, { kind: "manifest.metadata" })[0].metadata), true);
  assert.throws(() => findFactEvidence(index, { excerpt: "0.13.3" }), /query|field|excerpt/i);
});

test("applicationId facts require direct top-level android/defaultConfig scope and retain provenance", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle.kts", `android {
  defaultConfig {
    applicationId = "org.example.real"
  }
}
`);

  const index = loadSubmissionSources(project);

  assert.deepEqual(index.facts.gradle.applicationIds, ["org.example.real"]);
  assert.deepEqual(findFactEvidence(index, { kind: "gradle.applicationId" }), [{
    kind: "gradle.applicationId",
    value: "org.example.real",
    path: "app/build.gradle.kts",
    line: 3,
    excerpt: 'applicationId = "org.example.real"',
  }]);
});

test("plugin facts honor literal version and apply-false suffixes", (t) => {
  const project = scratch(t);
  write(project, "gradle/libs.versions.toml", `[versions]\nagp = "8.6.1"\n[plugins]\nskipped-alias = { id = "com.pico.spatial.forged", version.ref = "agp" }\n`);
  write(project, "app/build.gradle.kts", `plugins {\n  alias(libs.plugins.skipped.alias) apply false\n  id("com.android.application") version "8.6.1"\n  id("com.example.skipped") apply false\n  id("com.example.also-skipped") apply(false)\n}\n`);

  const index = loadSubmissionSources(project);

  assert.deepEqual(index.facts.gradle.pluginIds, ["com.android.application"]);
  assert.deepEqual(index.facts.gradle.versions, {});
  assert.deepEqual(findFactEvidence(index, { kind: "gradle.plugin" }), [{
    kind: "gradle.plugin",
    value: "com.android.application",
    alias: null,
    version: "8.6.1",
    versionRef: null,
    path: "app/build.gradle.kts",
    line: 3,
    excerpt: 'id("com.android.application") version "8.6.1"',
  }]);
});

test("non-Maven project dependencies do not become module facts", (t) => {
  const project = scratch(t);
  write(project, "app/build.gradle.kts", `dependencies {\n  implementation(project(":shared"))\n  val decoy = "com.pico.spatial:forged:0.13.3"\n}\n`);

  const index = loadSubmissionSources(project);

  assert.deepEqual(index.facts.gradle.moduleCoordinates, []);
});

test("findEvidence always predicates on structural text and may reveal original only after selection", (t) => {
  const project = scratch(t);
  write(project, "src/Foo.kt", `fun selected() { TrustedCall.run("hidden needle") }\nval decoy = "TrustedCall.run hidden needle"\n`);
  const index = loadSubmissionSources(project);

  assert.deepEqual(findEvidence(index, /hidden needle/, { original: true }), []);
  assert.deepEqual(findEvidence(index, /TrustedCall\.run/, { original: true }), [{
    path: "src/Foo.kt",
    line: 1,
    excerpt: 'fun selected() { TrustedCall.run("hidden needle") }',
  }]);
  assert.deepEqual(findEvidence(index, "TrustedCall.run", { paths: ["missing.kt"] }), []);
  assert.throws(() => findEvidence(index, () => true), /matcher|regular expression|string/i);
});

test("source inventory rejects symlinks and paths that are not absolute directories", (t) => {
  const parent = scratch(t);
  const project = path.join(parent, "project");
  const outside = write(parent, "outside.kt", "class Outside\n");
  fs.mkdirSync(project);
  fs.symlinkSync(outside, path.join(project, "Escape.kt"));

  assert.throws(() => loadSubmissionSources(project), /symlink|escape/i);
  assert.throws(() => loadSubmissionSources("relative/project"), /absolute/i);
  assert.throws(() => loadSubmissionSources(outside), /directory/i);
});

test("source inventory rejects a root symlink with a trailing separator", (t) => {
  const parent = scratch(t, "agentbench-source-root-link-");
  const project = path.join(parent, "project");
  const linkedProject = path.join(parent, "linked-project");
  fs.mkdirSync(project);
  write(project, "src/Subject.kt", "class Subject\n");
  fs.symlinkSync(project, linkedProject, "dir");

  assert.throws(() => loadSubmissionSources(`${linkedProject}${path.sep}`), /symlink|root/i);
});

test("source inventory rejects a root swapped between lstat and realpath", (t) => {
  const parent = scratch(t, "agentbench-source-root-race-");
  const project = path.join(parent, "project");
  fs.mkdirSync(project);
  write(project, "src/Original.kt", "class Original\n");
  const displaced = path.join(parent, "displaced-project");
  const originalRealpathSync = fs.realpathSync;
  let swapped = false;
  fs.realpathSync = function (target, ...args) {
    if (!swapped && path.resolve(String(target)) === path.resolve(project)) {
      swapped = true;
      fs.renameSync(project, displaced);
      fs.mkdirSync(project);
      write(project, "src/Replacement.kt", "class Replaced\n");
    }
    return originalRealpathSync.call(this, target, ...args);
  };

  try {
    assert.throws(() => loadSubmissionSources(project), /root|identity|changed|race/i);
  } finally {
    fs.realpathSync = originalRealpathSync;
  }
});

test("source inventory rejects a same-size path replacement after descriptor read", (t) => {
  const project = scratch(t, "agentbench-source-file-race-");
  const selected = write(project, "src/Subject.kt", "class Alpha\n");
  const replacement = write(project, "replacement.tmp", "class Bravo\n");
  assert.equal(fs.statSync(selected).size, fs.statSync(replacement).size);
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = function (target, ...args) {
    const result = originalReadFileSync.call(this, target, ...args);
    if (!swapped && typeof target === "number") {
      swapped = true;
      fs.renameSync(replacement, selected);
    }
    return result;
  };

  try {
    assert.throws(() => loadSubmissionSources(project), /identity|changed|replacement|race/i);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("source inventory revalidates root identity after all selected file reads", (t) => {
  const parent = scratch(t, "agentbench-source-post-read-root-race-");
  const project = path.join(parent, "project");
  const displaced = path.join(parent, "displaced-project");
  fs.mkdirSync(project);
  write(project, "src/Subject.kt", "class Subject\n");
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = function (target, ...args) {
    const result = originalReadFileSync.call(this, target, ...args);
    if (!swapped && typeof target === "number") {
      swapped = true;
      fs.renameSync(project, displaced);
      fs.symlinkSync(displaced, project, "dir");
    }
    return result;
  };

  try {
    assert.throws(() => loadSubmissionSources(project), /root|identity|changed|symlink|race/i);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("source inventory revalidates root identity after each selected file read", (t) => {
  const parent = scratch(t, "agentbench-source-each-read-root-race-");
  const project = path.join(parent, "project");
  const displaced = path.join(parent, "displaced-project");
  fs.mkdirSync(project);
  write(project, "src/First.kt", "class First\n");
  write(project, "src/Second.kt", "class Second\n");
  const originalReadFileSync = fs.readFileSync;
  let completedReads = 0;
  fs.readFileSync = function (target, ...args) {
    const result = originalReadFileSync.call(this, target, ...args);
    if (typeof target === "number") {
      completedReads += 1;
      if (completedReads === 1) {
        fs.renameSync(project, displaced);
        fs.symlinkSync(displaced, project, "dir");
      }
    }
    return result;
  };

  try {
    assert.throws(() => loadSubmissionSources(project), /root|identity|changed|symlink|race/i);
    assert.equal(completedReads, 1);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("source inventory rejects more than 2,000 selected files", (t) => {
  const project = scratch(t);
  for (let index = 0; index <= 2_000; index += 1) write(project, `src/File${String(index).padStart(4, "0")}.kt`, "class X\n");
  assert.throws(() => loadSubmissionSources(project), /2.?000|file count|too many/i);
});

test("source inventory rejects one selected file above 2 MiB", (t) => {
  const project = scratch(t);
  write(project, "src/Oversized.kt", Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  assert.throws(() => loadSubmissionSources(project), /2 MiB|file.*large|size limit/i);
});

test("source inventory rejects more than 32 MiB selected in total", (t) => {
  const project = scratch(t);
  for (let index = 0; index < 17; index += 1) write(project, `src/Chunk${index}.kt`, Buffer.alloc(2 * 1024 * 1024, 0x20));
  assert.throws(() => loadSubmissionSources(project), /32 MiB|total.*large|size limit/i);
});

test("inventory and facts use locale-independent deterministic ordering", (t) => {
  const project = scratch(t, "agentbench-source-order-");
  write(project, "src/lower.kt", "class Lower\n");
  write(project, "src/Upper.kt", "class Upper\n");
  write(project, "app/build.gradle.kts", `dependencies {\n  implementation("z.example:zeta:1")\n  implementation("A.example:alpha:1")\n}\n`);
  const originalLocaleCompare = String.prototype.localeCompare;
  let index;
  String.prototype.localeCompare = function () {
    throw new Error("localeCompare must not determine source order");
  };

  try {
    index = loadSubmissionSources(project);
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }

  assert.deepEqual(index.files.map((file) => file.path), ["app/build.gradle.kts", "src/Upper.kt", "src/lower.kt"]);
  assert.deepEqual(index.facts.gradle.moduleCoordinates, ["A.example:alpha", "z.example:zeta"]);
});

test("strict typed parsers fail closed for malformed or ambiguous inputs", (t) => {
  const cases = [
    {
      name: "malformed TOML",
      path: "gradle/libs.versions.toml",
      contents: "[versions]\nsdk = \"unterminated\n",
      error: /TOML|quote|malformed/i,
    },
    {
      name: "unresolved catalog version",
      path: "gradle/libs.versions.toml",
      contents: "[libraries]\nruntime = { module = \"org.example:runtime\", version.ref = \"missing\" }\n",
      error: /unresolved|missing|version/i,
    },
    {
      name: "normalized duplicate alias",
      path: "gradle/libs.versions.toml",
      contents: "[versions]\nsdk = \"1.0\"\n[libraries]\nspatial-runtime = { module = \"org.example:one\", version.ref = \"sdk\" }\nspatial.runtime = { module = \"org.example:two\", version.ref = \"sdk\" }\n",
      error: /duplicate|alias/i,
    },
    {
      name: "DOCTYPE",
      path: "app/src/main/AndroidManifest.xml",
      contents: '<!DOCTYPE manifest [<!ENTITY forged "payload">]><manifest />\n',
      error: /DOCTYPE|entity|XML/i,
    },
    {
      name: "entity",
      path: "app/src/main/AndroidManifest.xml",
      contents: '<manifest><application android:name="&forged;" /></manifest>\n',
      error: /entity|XML/i,
    },
    {
      name: "unterminated entity",
      path: "app/src/main/AndroidManifest.xml",
      contents: '<manifest><application android:name="&forged" /></manifest>\n',
      error: /entity|XML/i,
    },
    {
      name: "multiple XML roots",
      path: "app/src/main/AndroidManifest.xml",
      contents: '<manifest></manifest><manifest />\n',
      error: /root|XML|malformed/i,
    },
    {
      name: "nested activity",
      path: "app/src/main/AndroidManifest.xml",
      contents: '<manifest><application><intent-filter><activity android:name=".Forged" /></intent-filter></application></manifest>\n',
      error: /activity|parent|manifest|XML/i,
    },
    {
      name: "multiple applications",
      path: "app/src/main/AndroidManifest.xml",
      contents: '<manifest><application /><application /></manifest>\n',
      error: /application|multiple|manifest|XML/i,
    },
    {
      name: "unresolved dependency alias",
      path: "app/build.gradle.kts",
      contents: "dependencies { implementation(libs.missing.runtime) }\n",
      error: /unresolved|alias/i,
    },
    {
      name: "unbalanced Gradle",
      path: "app/build.gradle.kts",
      contents: "plugins { id(\"com.android.application\")\n",
      error: /Gradle|balanced|nesting|closing/i,
    },
    {
      name: "dynamic Gradle value",
      path: "app/build.gradle.kts",
      contents: 'dependencies { implementation("org.example:runtime:$version") }\n',
      error: /dynamic|interpolated|Gradle/i,
    },
    {
      name: "dynamic dependency expression",
      path: "app/build.gradle.kts",
      contents: "dependencies { implementation(runtimeCoordinate) }\n",
      error: /dynamic|unsupported|Gradle/i,
    },
    {
      name: "dynamic plugin expression",
      path: "app/build.gradle.kts",
      contents: "plugins { id(pluginIdentifier) }\n",
      error: /dynamic|unsupported|Gradle/i,
    },
    {
      name: "dynamic application id expression",
      path: "app/build.gradle.kts",
      contents: "android { defaultConfig { applicationId = computedId } }\n",
      error: /dynamic|unsupported|Gradle/i,
    },
    {
      name: "qualified application id assignment",
      path: "app/build.gradle.kts",
      contents: 'android { defaultConfig { fake.applicationId = "org.example.qualified" } }\n',
      error: /qualified|direct|application|Gradle/i,
    },
    {
      name: "task-local android scope",
      path: "app/build.gradle.kts",
      contents: 'tasks.register("bait") { android { defaultConfig { applicationId = "org.example.task" } } }\n',
      error: /android|top-level|scope|Gradle/i,
    },
    {
      name: "conditional android scope",
      path: "app/build.gradle.kts",
      contents: 'if (false)\nandroid { defaultConfig { applicationId = "org.example.dead" } }\n',
      error: /android|conditional|direct|scope|Gradle/i,
    },
    {
      name: "conditional application id assignment",
      path: "app/build.gradle.kts",
      contents: 'android { defaultConfig {\nif (false)\napplicationId = "org.example.dead"\n} }\n',
      error: /application|conditional|direct|scope|Gradle/i,
    },
    {
      name: "top-level application id assignment",
      path: "app/build.gradle.kts",
      contents: 'applicationId = "org.example.top"\n',
      error: /application|scope|Gradle/i,
    },
    {
      name: "wrong-parent default config",
      path: "app/build.gradle.kts",
      contents: 'other { defaultConfig { applicationId = "org.example.parent" } }\n',
      error: /defaultConfig|android|scope|Gradle/i,
    },
    {
      name: "qualified android scope",
      path: "app/build.gradle.kts",
      contents: 'fake.android { defaultConfig { applicationId = "org.example.android" } }\n',
      error: /qualified|android|top-level|scope|Gradle/i,
    },
    {
      name: "qualified default config scope",
      path: "app/build.gradle.kts",
      contents: 'android { fake.defaultConfig { applicationId = "org.example.config" } }\n',
      error: /qualified|defaultConfig|scope|Gradle/i,
    },
    {
      name: "non-assignment application id",
      path: "app/build.gradle.kts",
      contents: 'android { defaultConfig { applicationId("org.example.call") } }\n',
      error: /assignment|application|Gradle/i,
    },
    {
      name: "multiline application id expression suffix",
      path: "app/build.gradle.kts",
      contents: 'android {\n  defaultConfig {\n    applicationId = "org.example.safe"\n      .replace("safe", "forged")\n  }\n}\n',
      error: /application|suffix|literal|Gradle/i,
    },
    {
      name: "qualified fake dependency call",
      path: "app/build.gradle.kts",
      contents: 'dependencies { fake.implementation("com.pico.spatial:forged:0.13.3") }\n',
      error: /qualified|dependency|Gradle/i,
    },
    {
      name: "nested dependency handler",
      path: "app/build.gradle.kts",
      contents: 'tasks.register("bait") { dependencies { implementation("com.pico.spatial:forged:0.13.3") } }\n',
      error: /dependency|top-level|scope|Gradle/i,
    },
    {
      name: "qualified dependency handler",
      path: "app/build.gradle.kts",
      contents: 'fake.dependencies { implementation("com.pico.spatial:forged:0.13.3") }\n',
      error: /qualified|dependency|top-level|scope|Gradle/i,
    },
    {
      name: "method-pointer dependency handler",
      path: "app/build.gradle",
      contents: 'fake.&dependencies { implementation("com.pico.spatial:forged:0.13.3") }\n',
      error: /qualified|dependency|top-level|scope|Gradle/i,
    },
    {
      name: "method-pointer plugin handler",
      path: "app/build.gradle",
      contents: 'fake.&plugins { id("com.pico.spatial.forged") }\n',
      error: /qualified|plugin|top-level|scope|Gradle/i,
    },
    {
      name: "newline-qualified dependency call",
      path: "app/build.gradle",
      contents: 'dependencies { fake.\n implementation("com.pico.spatial:forged:0.13.3") }\n',
      error: /qualified|direct|dependency|Gradle/i,
    },
    {
      name: "qualified fake plugin alias",
      path: "app/build.gradle.kts",
      contents: 'plugins { fake.alias(libs.plugins.missing) }\n',
      error: /qualified|plugin|Gradle/i,
    },
    {
      name: "qualified fake plugin id",
      path: "app/build.gradle.kts",
      contents: 'plugins { fake.id("com.pico.spatial.forged") }\n',
      error: /qualified|plugin|Gradle/i,
    },
    {
      name: "method-pointer fake dependency call",
      path: "app/build.gradle",
      contents: 'dependencies { fake.&implementation("com.pico.spatial:forged:0.13.3") }\n',
      error: /qualified|direct|dependency/i,
    },
    {
      name: "method-pointer fake plugin id",
      path: "app/build.gradle",
      contents: 'plugins { fake.&id("com.pico.spatial.forged") }\n',
      error: /qualified|direct|plugin/i,
    },
    {
      name: "method-pointer fake plugin alias",
      path: "app/build.gradle",
      contents: 'plugins { fake.&alias(libs.plugins.missing) }\n',
      error: /qualified|direct|plugin/i,
    },
    {
      name: "dynamic plugin version suffix",
      path: "app/build.gradle.kts",
      contents: 'plugins { id("com.android.application") version computedVersion }\n',
      error: /dynamic|version|plugin/i,
    },
    {
      name: "dynamic plugin apply suffix",
      path: "app/build.gradle.kts",
      contents: 'plugins { id("com.android.application") apply shouldApply }\n',
      error: /dynamic|apply|plugin/i,
    },
  ];

  for (const fixture of cases) {
    const project = path.join(scratch(t, "agentbench-source-malformed-"), fixture.name.replaceAll(" ", "-"));
    fs.mkdirSync(project);
    write(project, fixture.path, fixture.contents);
    assert.throws(() => loadSubmissionSources(project), fixture.error, fixture.name);
  }
});
