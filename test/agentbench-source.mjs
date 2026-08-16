import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSubmissionSources, findEvidence } from "../benchmarks/spatial-agent-bench/lib/source.mjs";

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
    "app/src/main/AndroidManifest.xml",
    "app/src/main/java/com/agentbench/Foo.kt",
    "gradle/libs.versions.toml",
  ]);
  assert.deepEqual(index.files.map((file) => file.kind), ["manifest", "kotlin", "gradle"]);
  const kotlin = index.files[1];
  assert.equal(kotlin.structural.includes("PlaneTrackingManager.start()"), true);
  assert.equal(kotlin.structural.includes("fake in comment"), false);
  assert.equal(kotlin.structural.includes("com.pico.spatial"), false);
  assert.equal(kotlin.structural.includes(".Forged"), false);
  assert.equal(kotlin.structural.split("\n").length, kotlin.original.split("\n").length);
  for (const file of index.files) {
    assert.equal(file.structural.split("\n").length, file.original.split("\n").length, file.path);
    assert.equal(path.isAbsolute(file.absolutePath), true);
  }
  assert.equal(index.files[0].structural.includes(".Forged"), false);
  assert.equal(index.files[0].structural.includes("untrusted com.pico.spatial"), false);
  assert.equal(index.files[2].structural.includes("forged"), false);
  assert.equal(index.files[2].structural.includes("com.pico.spatial"), false);
  assert.equal(index.files[2].structural.includes("0.13.3"), false);
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

test("typed Gradle facts come only from catalog declarations and relevant balanced blocks", (t) => {
  const project = scratch(t);
  write(project, "gradle/libs.versions.toml", `[versions]\nsdk = '2.4.6'\n\n[libraries]\nspatial-runtime = { group = "org.example.spatial", name = "runtime", version.ref = "sdk" }\n\n[plugins]\nandroid-application = { id = "com.android.application", version.ref = "sdk" }\n\n# com.pico.spatial:forged 0.13.3 <activity android:name=".Forged" />\n`);
  write(project, "app/build.gradle.kts", `// id("com.pico.spatial.forged") and implementation("com.pico.spatial:forged:0.13.3")\nplugins {\n  alias(libs.plugins.android.application)\n}\ndependencies {\n  implementation(platform(libs.spatial.runtime))\n  implementation("org.example:direct:7.1")\n  val decoy = "com.pico.spatial:forged:0.13.3"\n}\nandroid {\n  defaultConfig { applicationId = "org.example.generated" }\n}\ntasks.register("unrelated") {\n  description = "com.pico.spatial:forged:0.13.3 <activity android:name='.Forged' />"\n}\n`);
  write(project, "app/src/main/java/org/example/Canary.kt", `val bait = "com.pico.spatial:forged 0.13.3 <activity android:name='.Forged' />"\n`);
  write(project, "notes/decoy.toml", `[versions]\ndecoy = "0.13.3"\n[libraries]\nforged = { module = "com.pico.spatial:forged", version.ref = "decoy" }\n`);

  const index = loadSubmissionSources(project);

  assert.deepEqual(index.facts.gradle, {
    pluginIds: ["com.android.application"],
    moduleCoordinates: ["org.example:direct", "org.example.spatial:runtime"],
    versions: { sdk: "2.4.6" },
    applicationIds: ["org.example.generated"],
  });
  assert.deepEqual(index.facts.manifest, { applicationName: null, activities: [], metadata: [] });
  assert.equal(JSON.stringify(index.facts).includes("com.pico.spatial"), false);
  assert.equal(JSON.stringify(index.facts).includes("0.13.3"), false);
  assert.equal(JSON.stringify(index.facts).includes(".Forged"), false);
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
  ];

  for (const fixture of cases) {
    const project = path.join(scratch(t, "agentbench-source-malformed-"), fixture.name.replaceAll(" ", "-"));
    fs.mkdirSync(project);
    write(project, fixture.path, fixture.contents);
    assert.throws(() => loadSubmissionSources(project), fixture.error, fixture.name);
  }
});
