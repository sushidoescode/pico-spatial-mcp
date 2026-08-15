import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalJson,
  canonicalIdentity,
  readAuthoredAppSpecIdentity,
  effectiveAppSpecIdentity,
  collectGradleInputIdentity,
  collectGuardedGradleInputIdentity,
  guardGradleInputGeneration,
} from "../dist/runreceiptidentity.js";

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

const authoredSpec = (packageName = "com.example.identity") => ({
  meta: {
    appName: "IdentityFixture",
    packageName,
    brief: "identity fixture",
  },
  scenes: [{ id: "main", environment: { kind: "procedural" } }],
  navigation: { startScene: "main" },
});

const normalizedAuthoredCanonical =
  '{"data":[],"headsetLayer":[],"interactions":[],"layouts":[],"meta":{"appName":"IdentityFixture","brief":"identity fixture","packageName":"com.example.identity","rootContainer":"stage","secondaryContainers":[],"stageStyle":"1"},"navigation":{"portals":[],"startScene":"main"},"objects":[],"panels":[],"scenes":[{"colliders":{"props":[]},"environment":{"kind":"procedural"},"id":"main","lighting":{"rig":"sun"},"transitions":[]}],"verificationPlan":[]}';

const gradleFiles = {
  "settings.gradle.kts": "rootProject.name = 'receipt-fixture'\n",
  "build.gradle": "plugins {}\n",
  "gradlew": "#!/bin/sh\n",
  "app/build.gradle.kts": "plugins { id(\"com.android.application\") }\n",
  "app/proguard-rules.pro": "-keep class com.example.** { *; }\n",
  "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https://example.invalid/gradle.zip\n",
  "buildSrc/src/main/kotlin/Plugin.kt": "class Plugin\n",
  "app/src/main/AndroidManifest.xml": "<manifest package=\"com.example.identity\" />\n",
  "app/src/main/java/com/example/Main.kt": "package com.example\nfun main() = Unit\n",
  "app/src/main/assets/data.json": '{"answer":42}\n',
  "libs/runtime.jar": "fixture jar bytes\n",
};

function writeFixtureFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function createGradleProject(parent) {
  const project = path.join(parent, "project");
  fs.mkdirSync(project, { recursive: true });
  for (const [relativePath, contents] of Object.entries(gradleFiles)) {
    writeFixtureFile(project, relativePath, contents);
  }
  return project;
}

function createMinimalGradleProject(parent) {
  const project = path.join(parent, "project");
  fs.mkdirSync(project, { recursive: true });
  writeFixtureFile(project, "gradlew", "#!/bin/sh\n");
  writeFixtureFile(project, "app/src/AndroidManifest.xml", "<manifest package=\"com.example.identity\" />\n");
  writeFixtureFile(project, "app/src/Main.kt", "package com.example\nclass Main\n");
  return project;
}

function expectedGradleEntries() {
  return [
    "app/build.gradle.kts",
    "app/proguard-rules.pro",
    "app/src/main/AndroidManifest.xml",
    "app/src/main/assets/data.json",
    "app/src/main/java/com/example/Main.kt",
    "build.gradle",
    "buildSrc/src/main/kotlin/Plugin.kt",
    "gradle/wrapper/gradle-wrapper.properties",
    "gradlew",
    "libs/runtime.jar",
    "settings.gradle.kts",
  ].map((relativePath) => ({
    path: relativePath,
    bytes: Buffer.byteLength(gradleFiles[relativePath]),
    sha256: sha(gradleFiles[relativePath]),
  }));
}

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("canonical JSON sorts object keys but preserves array order", () => {
  const actual = canonicalJson({ z: [3, { b: 2, a: 1 }], a: true });
  const expected = '{"a":true,"z":[3,{"a":1,"b":2}]}';
  assert.equal(actual, expected);
  assert.deepEqual(canonicalIdentity({ z: [3, { b: 2, a: 1 }], a: true }), {
    algorithm: "sha256",
    sha256: sha(expected),
    bytes: Buffer.byteLength(expected),
  });
});

test("canonical JSON rejects values that cannot have one portable identity", () => {
  for (const value of [undefined, NaN, Infinity, { a: undefined }, new Date(0)]) {
    assert.throws(() => canonicalJson(value), /canonical|JSON|unsupported|finite/i);
  }
  const sparse = [];
  sparse[1] = "x";
  assert.throws(() => canonicalJson(sparse), /sparse/i);

  let getterValue = 0;
  const accessorArray = [0];
  Object.defineProperty(accessorArray, 0, {
    enumerable: true,
    configurable: true,
    get: () => ++getterValue,
  });
  assert.throws(() => canonicalJson(accessorArray), /accessor|property|unsupported/i);
});

test("authored identity parses schema defaults, binds the real source path, and changes with authored intent", (t) => {
  const dir = scratch(t, "pico-authored-identity-");
  const briefPath = path.join(dir, "brief.json");
  const aliasPath = path.join(dir, "brief-alias.json");
  fs.writeFileSync(briefPath, JSON.stringify({ brief: "identity fixture", spec: authoredSpec() }));
  fs.symlinkSync(briefPath, aliasPath);

  const first = readAuthoredAppSpecIdentity(aliasPath);
  assert.deepEqual(first, {
    algorithm: "sha256",
    sha256: sha(normalizedAuthoredCanonical),
    bytes: Buffer.byteLength(normalizedAuthoredCanonical),
    sourcePath: fs.realpathSync(briefPath),
  });

  fs.writeFileSync(
    briefPath,
    JSON.stringify({ brief: "identity fixture", spec: authoredSpec("com.example.changed") }),
  );
  const changed = readAuthoredAppSpecIdentity(aliasPath);
  assert.notEqual(changed.sha256, first.sha256);
  assert.equal(changed.sourcePath, first.sourcePath);
});

test("effective identity changes when fleet rewrites the package", () => {
  const before = effectiveAppSpecIdentity(authoredSpec());
  const after = effectiveAppSpecIdentity(authoredSpec("com.picoagent.fleet_identity"));
  assert.notEqual(after.sha256, before.sha256);
});

test("Gradle identity contains only the exact sorted V1 allowlist with independently hashed files", (t) => {
  const dir = scratch(t, "pico-gradle-identity-");
  const project = createGradleProject(dir);
  const entries = expectedGradleEntries();
  const entriesCanonical = `[${entries.map((entry) =>
    `{"bytes":${entry.bytes},"path":${JSON.stringify(entry.path)},"sha256":${JSON.stringify(entry.sha256)}}`
  ).join(",")}]`;

  const actual = collectGradleInputIdentity(project);
  assert.deepEqual(actual, {
    schemaVersion: 1,
    projectDir: fs.realpathSync(project),
    algorithm: "sha256",
    sha256: sha(entriesCanonical),
    entryCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
  });

  writeFixtureFile(project, "README.md", "ignored documentation\n");
  writeFixtureFile(project, ".idea/x", "ignored IDE state\n");
  writeFixtureFile(project, "local.properties", "sdk.dir=/private/tmp/sdk\n");
  writeFixtureFile(project, "app/build/x", "ignored build output\n");
  writeFixtureFile(project, "buildSrc/build/classes/kotlin/main/Generated.class", "ignored buildSrc output\n");
  writeFixtureFile(project, "buildSrc/.gradle/cache.bin", "ignored nested Gradle cache\n");
  writeFixtureFile(project, "buildSrc/src/.git/index", "ignored nested Git metadata\n");
  writeFixtureFile(project, "gradle/.idea/workspace.xml", "ignored nested IDE metadata\n");
  writeFixtureFile(project, "buildSrc/local.properties", "ignored buildSrc local configuration\n");
  writeFixtureFile(project, "buildSrc/README.md", "ignored buildSrc documentation\n");
  assert.deepEqual(collectGradleInputIdentity(project), actual);
});

test("Gradle identity keeps packaged documentation and nested buildSrc resources", (t) => {
  const dir = scratch(t, "pico-gradle-packaged-documentation-");
  const project = createGradleProject(dir);
  writeFixtureFile(project, "app/src/main/assets/README.md", "packaged asset\n");
  writeFixtureFile(project, "buildSrc/src/main/resources/README.md", "build logic resource\n");
  writeFixtureFile(project, "buildSrc/src/main/resources/local.properties", "build logic local resource\n");
  writeFixtureFile(project, "buildSrc/README.md/Plugin.kt", "class DocumentationNamedDirectoryPlugin\n");
  writeFixtureFile(project, "buildSrc/local.properties/Config.kt", "class LocalPropertiesNamedDirectoryConfig\n");
  const identity = collectGradleInputIdentity(project);
  assert.ok(identity.entries.some((entry) => entry.path === "app/src/main/assets/README.md"));
  assert.ok(identity.entries.some((entry) => entry.path === "buildSrc/src/main/resources/README.md"));
  assert.ok(identity.entries.some((entry) => entry.path === "buildSrc/src/main/resources/local.properties"));
  assert.ok(identity.entries.some((entry) => entry.path === "buildSrc/README.md/Plugin.kt"));
  assert.ok(identity.entries.some((entry) => entry.path === "buildSrc/local.properties/Config.kt"));
});

test("Gradle identity changes for each selected manifest, source, wrapper, and asset input", (t) => {
  const dir = scratch(t, "pico-gradle-mutations-");
  const project = createGradleProject(dir);
  const baseline = collectGradleInputIdentity(project);
  const selectedMutations = [
    "app/src/main/AndroidManifest.xml",
    "app/src/main/java/com/example/Main.kt",
    "gradle/wrapper/gradle-wrapper.properties",
    "app/src/main/assets/data.json",
  ];

  for (const relativePath of selectedMutations) {
    writeFixtureFile(project, relativePath, `${gradleFiles[relativePath]}changed\n`);
    assert.notEqual(
      collectGradleInputIdentity(project).sha256,
      baseline.sha256,
      `${relativePath} must affect the Gradle input identity`,
    );
    writeFixtureFile(project, relativePath, gradleFiles[relativePath]);
  }
});

test("Gradle identity rejects a same-size selected file mutation during chunked hashing", (t) => {
  const dir = scratch(t, "pico-gradle-race-");
  const project = createGradleProject(dir);
  const assetPath = path.join(project, "app/src/main/assets/large.bin");
  const assetBytes = 1024 * 1024 + 64;
  fs.writeFileSync(assetPath, Buffer.alloc(assetBytes, 0x61));

  const originalReadSync = fs.readSync;
  let mutated = false;
  fs.readSync = function (...args) {
    const count = originalReadSync.apply(this, args);
    if (!mutated && args[3] === 1024 * 1024) {
      mutated = true;
      fs.writeFileSync(assetPath, Buffer.alloc(assetBytes, 0x62));
    }
    return count;
  };
  try {
    assert.throws(() => collectGradleInputIdentity(project), /changed while hashing/i);
    assert.equal(mutated, true);
  } finally {
    fs.readSync = originalReadSync;
  }
});

test("Gradle identity fails closed on selected symlinks and project-root escapes", (t) => {
  const dir = scratch(t, "pico-gradle-links-");
  const linkedProject = createGradleProject(path.join(dir, "linked"));
  fs.symlinkSync(
    path.join(linkedProject, "local.properties"),
    path.join(linkedProject, "app/src/main/assets/selected-link"),
  );
  assert.throws(() => collectGradleInputIdentity(linkedProject), /symlink|symbolic/i);

  const escapingProject = createGradleProject(path.join(dir, "escaping"));
  const outside = path.join(dir, "outside.txt");
  fs.writeFileSync(outside, "outside\n");
  fs.symlinkSync(outside, path.join(escapingProject, "app/src/main/assets/escape"));
  assert.throws(
    () => collectGradleInputIdentity(escapingProject),
    /escape|outside|project root/i,
  );
});

test("Gradle identity fails closed on selected special entries", (t) => {
  const dir = scratch(t, "pico-gradle-special-");
  const project = createGradleProject(dir);
  const fifo = path.join(project, "app/src/main/assets/fifo");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  assert.throws(() => collectGradleInputIdentity(project), /regular|special|unsupported/i);
});

test("Gradle identity requires an Android manifest and app Kotlin or Java source", (t) => {
  const dir = scratch(t, "pico-gradle-required-");
  const noManifest = createGradleProject(path.join(dir, "no-manifest"));
  fs.rmSync(path.join(noManifest, "app/src/main/AndroidManifest.xml"));
  assert.throws(() => collectGradleInputIdentity(noManifest), /Android manifest/i);

  const noAppSource = createGradleProject(path.join(dir, "no-app-source"));
  fs.rmSync(path.join(noAppSource, "app/src/main/java/com/example/Main.kt"));
  assert.throws(() => collectGradleInputIdentity(noAppSource), /Kotlin|Java|source/i);
});

test("Gradle generation guard fails closed at an explicit directory-count ceiling", (t) => {
  const countRoot = scratch(t, "pico-gradle-directory-count-");
  const countProject = createMinimalGradleProject(countRoot);
  for (const name of ["empty-a", "empty-b", "empty-c"]) {
    fs.mkdirSync(path.join(countProject, "app/src", name));
  }
  const countIdentity = collectGradleInputIdentity(countProject);
  let countGuard;
  try {
    assert.throws(
      () => { countGuard = guardGradleInputGeneration(countIdentity, { maxDirectories: 3 }); },
      /Gradle input director(?:y|ies).*3|directory count.*3/i,
    );
  } finally {
    countGuard?.close();
  }
});

test("Gradle generation guard fails closed at an explicit directory-depth ceiling", (t) => {
  const depthRoot = scratch(t, "pico-gradle-directory-depth-");
  const depthProject = createMinimalGradleProject(depthRoot);
  fs.mkdirSync(path.join(depthProject, "app/src/a/b/c"), { recursive: true });
  const depthIdentity = collectGradleInputIdentity(depthProject);
  let depthGuard;
  try {
    assert.throws(
      () => { depthGuard = guardGradleInputGeneration(depthIdentity, { maxDepth: 2 }); },
      /Gradle input directory depth.*2|depth ceiling.*2/i,
    );
  } finally {
    depthGuard?.close();
  }
});

test("Gradle generation guard caps selected watcher diagnostics during an event storm", async (t) => {
  const dir = scratch(t, "pico-gradle-event-cap-");
  const project = createMinimalGradleProject(dir);
  const identity = collectGradleInputIdentity(project);
  const originalWatch = fs.watch;
  const listeners = [];
  fs.watch = function (_directory, options, listener) {
    const callback = typeof options === "function" ? options : listener;
    listeners.push(callback);
    const watcher = {
      close() {},
      on() { return watcher; },
    };
    return watcher;
  };
  let guard;
  try {
    guard = guardGradleInputGeneration(identity, { maxEventSamples: 2 });
    assert.ok(listeners.length >= 1);
    for (let index = 0; index < 64; index += 1) listeners[0]("change", "gradlew");
    await assert.rejects(
      guard.assertUnchanged(),
      (error) => {
        assert.match(error.message, /additional selected path mutations omitted/i);
        assert.ok((error.message.match(/selected path mutation observed/g) ?? []).length <= 2);
        return true;
      },
    );
  } finally {
    guard?.close();
    fs.watch = originalWatch;
  }
});

test("guarded collection catches a transient change in an existing selected directory before collection returns", async (t) => {
  const dir = scratch(t, "pico-gradle-collection-directory-race-");
  const project = createGradleProject(dir);
  const largeWrapper = path.join(project, "gradlew.bat");
  fs.writeFileSync(largeWrapper, Buffer.alloc(1024 * 1024 + 32, 0x61));
  const selectedDirectory = path.join(project, "app/src/main/java/com/example");
  const transient = path.join(selectedDirectory, "Transient.kt");
  const originalReadSync = fs.readSync;
  let mutated = false;
  fs.readSync = function (...args) {
    const count = originalReadSync.apply(this, args);
    if (!mutated && args[3] === 1024 * 1024) {
      mutated = true;
      fs.writeFileSync(transient, "package com.example\nclass Transient\n");
      fs.unlinkSync(transient);
    }
    return count;
  };
  let guarded;
  try {
    guarded = collectGuardedGradleInputIdentity(project);
    assert.equal(mutated, true);
    await assert.rejects(guarded.guard.assertUnchanged(), /directory|generation|continuity|mutation/i);
  } finally {
    guarded?.guard.close();
    fs.readSync = originalReadSync;
  }
});

test("Gradle collection streams bounded directory entries and closes every opened directory on failure", (t) => {
  const streamDir = scratch(t, "pico-gradle-streaming-directory-");
  const streamProject = createGradleProject(streamDir);
  const streamProjectReal = fs.realpathSync(streamProject);
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = function (directory, ...args) {
    const relative = path.relative(streamProjectReal, path.resolve(directory));
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
      throw new Error("selected Gradle traversal used unbounded readdirSync");
    }
    return originalReaddirSync.call(this, directory, ...args);
  };
  try {
    assert.doesNotThrow(() => collectGradleInputIdentity(streamProject));
  } finally {
    fs.readdirSync = originalReaddirSync;
  }

  const closeDir = scratch(t, "pico-gradle-directory-close-");
  const closeProject = createMinimalGradleProject(closeDir);
  for (const name of ["a", "b", "c", "d"]) fs.mkdirSync(path.join(closeProject, "app/src", name));
  const originalOpendirSync = fs.opendirSync;
  const opened = [];
  fs.opendirSync = function (...args) {
    const directory = originalOpendirSync.apply(this, args);
    const originalCloseSync = directory.closeSync.bind(directory);
    const record = { closeCalls: 0 };
    directory.closeSync = () => {
      record.closeCalls += 1;
      return originalCloseSync();
    };
    opened.push(record);
    return directory;
  };
  try {
    assert.throws(
      () => collectGuardedGradleInputIdentity(closeProject, { maxDirectories: 3 }),
      /directory count.*3|director(?:y|ies).*3/i,
    );
    assert.ok(opened.length > 0, "selected traversal must use bounded directory handles");
    assert.deepEqual(opened.map((record) => record.closeCalls), opened.map(() => 1));
  } finally {
    fs.opendirSync = originalOpendirSync;
  }
});

test("guarded collection catches atomic replace and restoration of a root-selected file without watcher delivery", async (t) => {
  const dir = scratch(t, "pico-gradle-root-restore-");
  const project = createGradleProject(dir);
  const selected = path.join(project, "settings.gradle.kts");
  const held = path.join(project, "settings.gradle.kts.held");
  const replacement = path.join(project, "settings.gradle.kts.replacement");
  const originalWatch = fs.watch;
  fs.watch = function () {
    const watcher = new EventEmitter();
    watcher.close = () => {};
    return watcher;
  };
  let guarded;
  try {
    guarded = collectGuardedGradleInputIdentity(project);
    fs.writeFileSync(replacement, "rootProject.name = 'replacement'\n");
    fs.renameSync(selected, held);
    fs.renameSync(replacement, selected);
    fs.unlinkSync(selected);
    fs.renameSync(held, selected);
    await assert.rejects(guarded.guard.assertUnchanged(), /file|generation|continuity|mutation/i);
  } finally {
    guarded?.guard.close();
    fs.watch = originalWatch;
  }
});

test("guard fails closed when an initially absent selected root changes with watcher delivery dropped", async (t) => {
  const dir = scratch(t, "pico-gradle-absent-root-");
  const project = createGradleProject(dir);
  const originalWatch = fs.watch;
  fs.watch = function () {
    const watcher = new EventEmitter();
    watcher.close = () => {};
    return watcher;
  };
  let guarded;
  try {
    guarded = collectGuardedGradleInputIdentity(project);
    const transientRoot = path.join(project, "app/libs");
    fs.mkdirSync(transientRoot, { recursive: true });
    fs.writeFileSync(path.join(transientRoot, "transient.jar"), "transient");
    fs.rmSync(transientRoot, { recursive: true });
    await assert.rejects(guarded.guard.assertUnchanged(), /parent|directory|generation|continuity|mutation|ambiguous/i);
  } finally {
    guarded?.guard.close();
    fs.watch = originalWatch;
  }
});

test("guard waits for a late coalesced watcher callback and closes every watcher exactly once", async (t) => {
  const dir = scratch(t, "pico-gradle-late-watch-");
  const project = createGradleProject(dir);
  const originalWatch = fs.watch;
  const watchers = [];
  fs.watch = function (_directory, options, listener) {
    const callback = typeof options === "function" ? options : listener;
    const watcher = new EventEmitter();
    watcher.callback = callback;
    watcher.closeCalls = 0;
    watcher.close = () => { watcher.closeCalls += 1; };
    watchers.push(watcher);
    return watcher;
  };
  let guarded;
  try {
    guarded = collectGuardedGradleInputIdentity(project);
    setImmediate(() => setImmediate(() => watchers[0].callback("rename", null)));
    await assert.rejects(guarded.guard.assertUnchanged(), /unknown|mutation|continuity/i);
  } finally {
    guarded?.guard.close();
    guarded?.guard.close();
    fs.watch = originalWatch;
  }
  assert.ok(watchers.length >= 2);
  assert.deepEqual(watchers.map((watcher) => watcher.closeCalls), watchers.map(() => 1));
});
