import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appSpecSchema } from "../dist/appspec.js";
import {
  canonicalJson,
  collectGradleInputIdentity,
} from "../dist/runreceiptidentity.js";
import {
  applicationResourceKey,
  createFleetInputIdentityObserversForTest,
  observeTargetGeneration,
  ProjectLocatorError,
  projectResourceKey,
  readCompatibilityBrief,
  resolveProjectLocator,
  revalidateProjectLocator,
} from "../dist/fleetinputidentity.js";

const COMPATIBILITY_BRIEF_MAX_BYTES = 3 * 1024 * 1024;
const LOCATOR_MAX_PATH_BYTES = 16 * 1024;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

function scratch(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function directoryIdentity(directory) {
  const stat = fs.statSync(directory, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function minimalSpec(brief = "locator fixture", packageName = "com.example.locator") {
  return appSpecSchema.parse({
    meta: { appName: "LocatorFixture", packageName, brief },
    scenes: [{ id: "main", environment: { kind: "procedural" } }],
    navigation: { startScene: "main" },
  });
}

function writeFixtureFile(root, relativePath, contents) {
  const destination = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
  return destination;
}

function createGradleProjectAt(project, source = "class Main") {
  fs.mkdirSync(project, { recursive: true });
  writeFixtureFile(project, "settings.gradle.kts", "rootProject.name = 'locator'\n");
  writeFixtureFile(project, "gradlew", "#!/bin/sh\n");
  writeFixtureFile(
    project,
    "app/src/main/AndroidManifest.xml",
    "<manifest package=\"com.example.locator\" />\n",
  );
  writeFixtureFile(
    project,
    "app/src/main/java/com/example/Main.kt",
    `package com.example\n${source}\n`,
  );
  return project;
}

function snapshotTree(root) {
  const entries = [];
  const visit = (candidate, relative) => {
    const stat = fs.lstatSync(candidate, { bigint: true });
    const entry = {
      path: relative,
      device: String(stat.dev),
      inode: String(stat.ino),
      mode: String(stat.mode),
      links: String(stat.nlink),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    };
    if (stat.isFile()) entry.bytes = fs.readFileSync(candidate).toString("base64");
    if (stat.isSymbolicLink()) entry.target = fs.readlinkSync(candidate);
    entries.push(entry);
    if (!stat.isDirectory()) return;
    for (const child of fs.readdirSync(candidate).sort()) {
      visit(path.join(candidate, child), relative === "." ? child : path.join(relative, child));
    }
  };
  visit(root, ".");
  return entries;
}

function protectTreeReadOnly(root) {
  const paths = [];
  const collect = (candidate) => {
    const stat = fs.lstatSync(candidate);
    paths.push({ path: candidate, mode: stat.mode & 0o7777, directory: stat.isDirectory() });
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(candidate)) collect(path.join(candidate, child));
    }
  };
  collect(root);
  for (const entry of [...paths].sort((left, right) => right.path.length - left.path.length)) {
    if (!fs.lstatSync(entry.path).isSymbolicLink()) fs.chmodSync(entry.path, entry.directory ? 0o555 : 0o444);
  }
  return () => {
    for (const entry of paths.sort((left, right) => left.path.length - right.path.length)) {
      if (!fs.lstatSync(entry.path).isSymbolicLink()) fs.chmodSync(entry.path, entry.mode);
    }
  };
}

function assertRejectedWithoutMutation(root, briefPath, bytes, operation, pattern) {
  fs.writeFileSync(briefPath, bytes);
  const restore = protectTreeReadOnly(root);
  const before = snapshotTree(root);
  try {
    assert.throws(operation, pattern);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    restore();
  }
}

function expectLocatorFailure(operation, status) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ProjectLocatorError);
    assert.equal(error?.name, "ProjectLocatorError");
    assert.equal(error?.status, status);
    return true;
  });
}

function targetFor(locator, options = {}) {
  const briefId = options.briefId ?? "door42";
  const briefInput = options.briefInput ?? "Exact locator fixture";
  const app = `com.fleet.${briefId}`;
  const briefPath = path.resolve(
    options.briefPath ?? path.join(path.dirname(locator.requestedProjectsRoot), `${briefId}.json`),
  );
  return {
    briefInput,
    briefId,
    app,
    executionSerial: "emulator-5554",
    inputBaseDir: locator.requestedProjectsRoot,
    briefPath,
    projectDir: locator.requestedProjectDir,
    projectLocator: locator,
    resourceKey: applicationResourceKey(app, "emulator-5554"),
    projectResourceKey: projectResourceKey(locator.physicalProjectDir),
    base: null,
  };
}

function canonicalBrief(target, spec = minimalSpec()) {
  return canonicalJson({ id: target.briefId, brief: target.briefInput, spec });
}

test("resource keys hash the exact canonical application and physical-project identities", () => {
  assert.equal(
    applicationResourceKey("com.fleet.door42", "emulator-5554"),
    sha('{"app":"com.fleet.door42","kind":"pico.application-resource","schemaVersion":1,"serial":"emulator-5554"}'),
  );
  assert.equal(
    projectResourceKey("/private/tmp/fleet-door42-native"),
    sha('{"kind":"pico.physical-project-resource","physicalProjectDir":"/private/tmp/fleet-door42-native","schemaVersion":1}'),
  );
});

test("locator records literal existing-root, absent-root, and existing-project coordinates", (t) => {
  const root = scratch(t, "pico-locator-shapes-");
  const id = "door42";
  const leaf = `fleet-${id}-native`;
  const rootPhysical = fs.realpathSync(root);
  const rootGeneration = directoryIdentity(rootPhysical);

  const absentProject = resolveProjectLocator(root, id);
  assert.deepEqual(absentProject, {
    kind: "pico.project-locator",
    schemaVersion: 1,
    requestedProjectsRoot: path.resolve(root),
    physicalProjectsRoot: rootPhysical,
    requestedProjectDir: path.join(path.resolve(root), leaf),
    physicalProjectDir: path.join(rootPhysical, leaf),
    anchor: {
      requestedPath: path.resolve(root),
      physicalPath: rootPhysical,
      ...rootGeneration,
    },
    missingSuffix: [leaf],
  });
  assert.deepEqual(revalidateProjectLocator(absentProject), absentProject);

  const existingIntermediate = path.join(root, "missing");
  fs.mkdirSync(existingIntermediate);
  const intermediatePhysical = fs.realpathSync(existingIntermediate);
  const nestedRequestedRoot = path.join(existingIntermediate, "nested");
  const absentRoot = resolveProjectLocator(nestedRequestedRoot, id);
  assert.deepEqual(absentRoot, {
    kind: "pico.project-locator",
    schemaVersion: 1,
    requestedProjectsRoot: path.resolve(nestedRequestedRoot),
    physicalProjectsRoot: path.join(intermediatePhysical, "nested"),
    requestedProjectDir: path.join(path.resolve(nestedRequestedRoot), leaf),
    physicalProjectDir: path.join(intermediatePhysical, "nested", leaf),
    anchor: {
      requestedPath: path.resolve(existingIntermediate),
      physicalPath: intermediatePhysical,
      ...directoryIdentity(intermediatePhysical),
    },
    missingSuffix: ["nested", leaf],
  });
  assert.deepEqual(revalidateProjectLocator(absentRoot), absentRoot);

  const existingProjectPath = createGradleProjectAt(path.join(root, leaf));
  const existingPhysical = fs.realpathSync(existingProjectPath);
  const existingProject = resolveProjectLocator(root, id);
  assert.deepEqual(existingProject, {
    kind: "pico.project-locator",
    schemaVersion: 1,
    requestedProjectsRoot: path.resolve(root),
    physicalProjectsRoot: rootPhysical,
    requestedProjectDir: path.resolve(existingProjectPath),
    physicalProjectDir: existingPhysical,
    anchor: {
      requestedPath: path.resolve(existingProjectPath),
      physicalPath: existingPhysical,
      ...directoryIdentity(existingPhysical),
    },
    missingSuffix: [],
  });
  assert.deepEqual(revalidateProjectLocator(existingProject), existingProject);
});

test("lexical root spellings and two stable symlink aliases retain requested spelling but share physical identity", (t) => {
  const directory = scratch(t, "pico-locator-aliases-");
  const physicalRoot = path.join(directory, "physical-projects");
  const id = "door42";
  const project = createGradleProjectAt(path.join(physicalRoot, `fleet-${id}-native`));
  const aliasA = path.join(directory, "projects-a");
  const aliasB = path.join(directory, "projects-b");
  fs.symlinkSync(physicalRoot, aliasA);
  fs.symlinkSync(physicalRoot, aliasB);

  const lexical = resolveProjectLocator(path.join(directory, "unused", "..", "projects-a", "."), id);
  const second = resolveProjectLocator(aliasB, id);
  assert.equal(lexical.requestedProjectsRoot, path.resolve(aliasA));
  assert.equal(second.requestedProjectsRoot, path.resolve(aliasB));
  assert.notEqual(lexical.requestedProjectDir, second.requestedProjectDir);
  assert.equal(lexical.physicalProjectsRoot, fs.realpathSync(physicalRoot));
  assert.equal(second.physicalProjectsRoot, fs.realpathSync(physicalRoot));
  assert.equal(lexical.physicalProjectDir, fs.realpathSync(project));
  assert.equal(second.physicalProjectDir, fs.realpathSync(project));
  assert.equal(projectResourceKey(lexical.physicalProjectDir), projectResourceKey(second.physicalProjectDir));
  assert.deepEqual(revalidateProjectLocator(lexical), lexical);
  assert.deepEqual(revalidateProjectLocator(second), second);
});

test("locator admits exactly 64 components and 16 KiB paths, then rejects each +1 before filesystem traversal", (t) => {
  const unique = `pico-locator-${process.pid}-${Date.now()}`;
  const exactComponents = [unique, ...Array.from({ length: 62 }, (_, index) => `c${index}`)];
  const exactComponentRoot = path.join(path.parse(process.cwd()).root, ...exactComponents);
  const exactComponentLocator = resolveProjectLocator(exactComponentRoot, "x");
  assert.equal(exactComponentLocator.requestedProjectDir.split(path.sep).filter(Boolean).length, 64);
  assert.equal(exactComponentLocator.missingSuffix.length, 64);

  const overComponentRoot = path.join(exactComponentRoot, "overflow");
  assert.throws(
    () => resolveProjectLocator(overComponentRoot, "x"),
    /component|64|limit/i,
  );

  const byteAnchor = scratch(t, "pico-locator-byte-bound-");
  const missingPrefix = path.join(fs.realpathSync(byteAnchor), `${unique}-missing`);
  const leaf = "fleet-x-native";
  const fixedBytes = Buffer.byteLength(`${missingPrefix}//${leaf}`);
  const remainingBytes = LOCATOR_MAX_PATH_BYTES - fixedBytes;
  const filler = `${"\u00e9".repeat(Math.floor(remainingBytes / 2))}${remainingBytes % 2 === 0 ? "" : "a"}`;
  assert.equal(Buffer.byteLength(filler), remainingBytes);
  const exactByteRoot = `${missingPrefix}/${filler}`;
  const exactByteProject = path.join(exactByteRoot, leaf);
  assert.equal(Buffer.byteLength(exactByteProject), LOCATOR_MAX_PATH_BYTES);
  const exactByteLocator = resolveProjectLocator(exactByteRoot, "x");
  assert.equal(exactByteLocator.requestedProjectDir, exactByteProject);
  assert.equal(Buffer.byteLength(exactByteLocator.physicalProjectDir), LOCATOR_MAX_PATH_BYTES);

  const overByteRoot = `${missingPrefix}/${filler}a`;
  assert.equal(Buffer.byteLength(path.join(overByteRoot, leaf)), LOCATOR_MAX_PATH_BYTES + 1);
  assert.throws(
    () => resolveProjectLocator(overByteRoot, "x"),
    /path|16\s*KiB|16384|limit/i,
  );
});

test("locator detects alias retarget, in-call symlink races, and persisted ancestor replacement", (t) => {
  const directory = scratch(t, "pico-locator-retarget-");
  const rootA = path.join(directory, "a");
  const rootB = path.join(directory, "b");
  const id = "door42";
  createGradleProjectAt(path.join(rootA, `fleet-${id}-native`), "class A");
  createGradleProjectAt(path.join(rootB, `fleet-${id}-native`), "class B");
  const alias = path.join(directory, "projects");
  fs.symlinkSync(rootA, alias);
  const locator = resolveProjectLocator(alias, id);
  fs.unlinkSync(alias);
  fs.symlinkSync(rootB, alias);
  assert.throws(() => revalidateProjectLocator(locator), /anchor|physical|changed|conflict|stable/i);

  fs.unlinkSync(alias);
  fs.symlinkSync(rootA, alias);
  let retargeted = false;
  const racingObservers = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (!retargeted && event.kind === "directory-descriptor-opened"
        && event.requestedPath === path.join(alias, `fleet-${id}-native`)) {
        retargeted = true;
        fs.unlinkSync(alias);
        fs.symlinkSync(rootB, alias);
      }
    },
  });
  assert.throws(() => racingObservers.resolveProjectLocator(alias, id), /race|changed|stable|physical/i);
  assert.equal(retargeted, true);

  const absentRoot = path.join(directory, "replace-me");
  fs.mkdirSync(absentRoot);
  const absentLocator = resolveProjectLocator(absentRoot, "door99");
  const held = path.join(directory, "held-root");
  fs.renameSync(absentRoot, held);
  fs.mkdirSync(absentRoot);
  assert.throws(() => revalidateProjectLocator(absentLocator), /anchor|device|inode|changed|conflict/i);
});

test("locator rejects unsafe IDs, non-directories, FIFOs, and project resolution outside the physical root", (t) => {
  const directory = scratch(t, "pico-locator-unsafe-");
  assert.throws(() => resolveProjectLocator(directory, "../escape"), /brief|component|unsafe|separator|root/i);
  assert.throws(() => resolveProjectLocator(directory, "nested/id"), /brief|component|unsafe|separator/i);

  const fileRoot = path.join(directory, "file-root");
  fs.writeFileSync(fileRoot, "not a directory");
  assert.throws(() => resolveProjectLocator(fileRoot, "door42"), /directory|component/i);

  const fifoRoot = path.join(directory, "fifo-root");
  const fifo = spawnSync("mkfifo", [fifoRoot], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  assert.throws(() => resolveProjectLocator(fifoRoot, "door42"), /directory|component|FIFO|special/i);

  const leafRoot = path.join(directory, "leaf-root");
  fs.mkdirSync(leafRoot);
  fs.writeFileSync(path.join(leafRoot, "fleet-door42-native"), "project leaf is a file");
  assert.throws(() => resolveProjectLocator(leafRoot, "door42"), /directory|component|ENOTDIR/i);

  const intermediateRoot = path.join(directory, "intermediate-root");
  fs.mkdirSync(intermediateRoot);
  const fifoIntermediate = path.join(intermediateRoot, "fifo-component");
  const intermediateFifo = spawnSync("mkfifo", [fifoIntermediate], { encoding: "utf8" });
  assert.equal(intermediateFifo.status, 0, intermediateFifo.stderr);
  assert.throws(
    () => resolveProjectLocator(path.join(fifoIntermediate, "nested"), "door42"),
    /directory|component|FIFO|special|ENOTDIR/i,
  );

  const projects = path.join(directory, "projects");
  const outside = path.join(directory, "outside-project");
  fs.mkdirSync(projects);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(projects, "fleet-door42-native"));
  assert.throws(() => resolveProjectLocator(projects, "door42"), /outside|escape|physical root/i);
});

test("locator failures distinguish invalid stored coordinates, exhausted bounds, and observed drift", (t) => {
  const root = scratch(t, "pico-locator-error-codes-");
  const absent = resolveProjectLocator(root, "door42");
  expectLocatorFailure(
    () => revalidateProjectLocator({ ...absent, missingSuffix: [] }),
    "invalid-store",
  );

  const overBoundRoot = path.join(
    path.parse(process.cwd()).root,
    ...Array.from({ length: 64 }, (_, index) => `bounded-${index}`),
  );
  expectLocatorFailure(
    () => resolveProjectLocator(overBoundRoot, "x"),
    "limit-exceeded",
  );

  const project = createGradleProjectAt(absent.requestedProjectDir);
  const existing = resolveProjectLocator(root, "door42");
  fs.renameSync(project, path.join(root, "held-project"));
  createGradleProjectAt(project);
  expectLocatorFailure(
    () => revalidateProjectLocator(existing),
    "external-state-conflict",
  );
});

test("post-scaffold revalidation requires the predicted real path and preserves the original anchor", (t) => {
  const root = scratch(t, "pico-locator-post-scaffold-");
  const id = "door42";
  const locator = resolveProjectLocator(root, id);
  const other = path.join(root, "other-project");
  fs.mkdirSync(other);
  fs.symlinkSync(other, locator.requestedProjectDir);
  assert.throws(() => revalidateProjectLocator(locator), /physical|prediction|changed|conflict/i);

  fs.unlinkSync(locator.requestedProjectDir);
  fs.mkdirSync(locator.requestedProjectDir);
  const revalidated = revalidateProjectLocator(locator);
  assert.deepEqual(revalidated, locator);
  assert.equal(revalidated.anchor.requestedPath, path.resolve(root));
  assert.deepEqual(revalidated.missingSuffix, [`fleet-${id}-native`]);
});

test("delete/recreate changes the observed directory generation while same-inode ctime changes remain the documented boundary", (t) => {
  const root = scratch(t, "pico-locator-recreate-");
  const id = "door42";
  const project = createGradleProjectAt(path.join(root, `fleet-${id}-native`));
  const briefPath = path.join(root, `${id}.json`);
  const firstLocator = resolveProjectLocator(root, id);
  const target = targetFor(firstLocator, { briefId: id, briefPath });
  const first = observeTargetGeneration(target);
  assert.equal(first.project.status, "observed");

  fs.writeFileSync(path.join(project, "README.md"), "excluded sibling changes project ctime\n");
  assert.deepEqual(revalidateProjectLocator(firstLocator), firstLocator);
  assert.deepEqual(observeTargetGeneration(target), first);

  const heldDescriptor = fs.openSync(project, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.rmSync(project, { recursive: true });
    createGradleProjectAt(project);
    assert.throws(() => revalidateProjectLocator(firstLocator), /anchor|device|inode|changed|conflict/i);
    const secondLocator = resolveProjectLocator(root, id);
    const second = observeTargetGeneration(targetFor(secondLocator, { briefId: id, briefPath }));
    assert.equal(second.project.status, "observed");
    assert.equal(second.project.directory.physicalPath, first.project.directory.physicalPath);
    assert.notEqual(
      `${second.project.directory.device}:${second.project.directory.inode}`,
      `${first.project.directory.device}:${first.project.directory.inode}`,
    );
  } finally {
    fs.closeSync(heldDescriptor);
  }
});

test("compatibility brief reports absent or exact raw canonical bytes without returning adopted intent", (t) => {
  const root = scratch(t, "pico-brief-generation-");
  const locator = resolveProjectLocator(root, "door42");
  const briefPath = path.join(root, "door42.json");
  const target = targetFor(locator, {
    briefId: "door42",
    briefInput: "Caf\u00e9\r\nexact",
    briefPath,
  });
  assert.deepEqual(readCompatibilityBrief(target), { status: "absent" });
  assert.equal(fs.existsSync(briefPath), false);

  const raw = canonicalBrief(target, minimalSpec("raw compatibility"));
  fs.writeFileSync(briefPath, raw);
  const generation = readCompatibilityBrief(target);
  assert.deepEqual(generation, {
    status: "observed",
    bytes: Buffer.byteLength(raw),
    sha256: sha(Buffer.from(raw)),
  });
  assert.deepEqual(Object.keys(generation).sort(), ["bytes", "sha256", "status"]);
  assert.equal(fs.readFileSync(briefPath, "utf8"), raw);
});

test("compatibility brief rejects an absent-to-present race instead of returning a torn absent generation", (t) => {
  const root = scratch(t, "pico-brief-absence-race-");
  const locator = resolveProjectLocator(root, "door42");
  const briefPath = path.join(root, "door42.json");
  const target = targetFor(locator, { briefId: "door42", briefPath });
  const raw = canonicalBrief(target);
  let appeared = false;
  const racingObservers = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (!appeared && event.kind === "brief-absence-first-observed" && event.filePath === briefPath) {
        appeared = true;
        fs.writeFileSync(briefPath, raw);
      }
    },
  });
  assert.throws(() => racingObservers.readCompatibilityBrief(target), /appear|changed|race|stable|absen/i);
  assert.equal(appeared, true);
});

test("compatibility brief rejects normalized-only equality, noncanonical bytes, unknown keys, malformed JSON, and invalid UTF-8", (t) => {
  const root = scratch(t, "pico-brief-strict-");
  const locator = resolveProjectLocator(root, "door42");
  const briefPath = path.join(root, "door42.json");
  const target = targetFor(locator, { briefId: "door42", briefInput: "Caf\u00e9", briefPath });
  const spec = minimalSpec();

  const rejected = [
    [canonicalJson({ id: "door42", brief: "Cafe\u0301", spec }), /brief|exact|byte/i],
    [JSON.stringify({ id: "door42", brief: target.briefInput, spec }, null, 2), /canonical/i],
    [canonicalJson({ id: "door42", brief: target.briefInput, spec, extra: true }), /unknown|keys|canonical|payload/i],
    [canonicalJson({
      id: "door42",
      brief: target.briefInput,
      spec: { ...spec, unexpectedAppSpecField: true },
    }), /canonical|schema|unknown/i],
    [canonicalJson({ id: "door99", brief: target.briefInput, spec }), /id|target|match/i],
    ["{", /JSON|malformed|parse|payload/i],
  ];
  for (const [bytes, pattern] of rejected) {
    assertRejectedWithoutMutation(
      root,
      briefPath,
      bytes,
      () => readCompatibilityBrief(target),
      pattern,
    );
  }

  const prefix = Buffer.from('{"brief":"');
  const suffix = Buffer.from(`","id":"door42","spec":${canonicalJson(spec)}}`);
  assertRejectedWithoutMutation(
    root,
    briefPath,
    Buffer.concat([prefix, Buffer.from([0xff]), suffix]),
    () => readCompatibilityBrief(target),
    /UTF-8|encoding|canonical|brief/i,
  );
});

test("compatibility brief admits exactly 3 MiB and rejects the +1 byte case before parsing", (t) => {
  const root = scratch(t, "pico-brief-size-");
  const locator = resolveProjectLocator(root, "door42");
  const briefPath = path.join(root, "door42.json");
  const target = targetFor(locator, { briefId: "door42", briefInput: "size boundary", briefPath });
  const baseSpec = minimalSpec("");
  const empty = canonicalJson({ id: target.briefId, brief: target.briefInput, spec: baseSpec });
  const fillerBytes = COMPATIBILITY_BRIEF_MAX_BYTES - Buffer.byteLength(empty);
  assert.ok(fillerBytes > 0);
  const exact = canonicalJson({
    id: target.briefId,
    brief: target.briefInput,
    spec: { ...baseSpec, meta: { ...baseSpec.meta, brief: "x".repeat(fillerBytes) } },
  });
  assert.equal(Buffer.byteLength(exact), COMPATIBILITY_BRIEF_MAX_BYTES);
  fs.writeFileSync(briefPath, exact);
  assert.deepEqual(readCompatibilityBrief(target), {
    status: "observed",
    bytes: COMPATIBILITY_BRIEF_MAX_BYTES,
    sha256: sha(Buffer.from(exact)),
  });

  fs.appendFileSync(briefPath, " ");
  assert.equal(fs.statSync(briefPath).size, COMPATIBILITY_BRIEF_MAX_BYTES + 1);
  const forbiddenOperations = [];
  const prechargeObservers = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (["brief-large-allocation", "brief-read", "brief-parse", "brief-hash"].includes(event.kind)) {
        forbiddenOperations.push(event.kind);
        throw new Error(`oversize brief reached forbidden ${event.kind}`);
      }
    },
  });
  const restore = protectTreeReadOnly(root);
  const before = snapshotTree(root);
  try {
    assert.throws(
      () => prechargeObservers.readCompatibilityBrief(target),
      /3\s*MiB|3145728|size|limit|oversize/i,
    );
    assert.deepEqual(forbiddenOperations, []);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    restore();
  }
});

test("compatibility brief rejects symlink, hard-link, and atomic replacement leaves", (t) => {
  const root = scratch(t, "pico-brief-links-");
  const locator = resolveProjectLocator(root, "door42");
  const briefPath = path.join(root, "door42.json");
  const target = targetFor(locator, { briefId: "door42", briefPath });
  const source = path.join(root, "source.json");
  const raw = canonicalBrief(target);
  fs.writeFileSync(source, raw);

  fs.symlinkSync(source, briefPath);
  assert.throws(() => readCompatibilityBrief(target), /symlink|symbolic|no-follow|ELOOP/i);
  fs.unlinkSync(briefPath);

  fs.linkSync(source, briefPath);
  assert.throws(() => readCompatibilityBrief(target), /hard.?link|one link|link count/i);
  fs.unlinkSync(briefPath);

  fs.writeFileSync(briefPath, raw);
  const replacement = path.join(root, "replacement.json");
  fs.writeFileSync(replacement, canonicalBrief(target, minimalSpec("replacement")));
  let replaced = false;
  const racingObservers = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (!replaced && event.kind === "brief-descriptor-opened" && event.filePath === briefPath) {
        replaced = true;
        fs.renameSync(replacement, briefPath);
      }
    },
  });
  assert.throws(
    () => racingObservers.readCompatibilityBrief(target),
    /replace|changed|race|stable|identity|link/i,
  );
  assert.equal(replaced, true);
});

test("compatibility brief regular-to-FIFO replacement cannot block before authoritative fstat", (t) => {
  const root = scratch(t, "pico-brief-fifo-race-");
  const moduleUrl = new URL("../dist/fleetinputidentity.js", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { spawnSync } from "node:child_process";
    import { appSpecSchema } from ${JSON.stringify(new URL("../dist/appspec.js", import.meta.url).href)};
    import { canonicalJson } from ${JSON.stringify(new URL("../dist/runreceiptidentity.js", import.meta.url).href)};
    import {
      applicationResourceKey,
      createFleetInputIdentityObserversForTest,
      projectResourceKey,
      resolveProjectLocator,
    } from ${JSON.stringify(moduleUrl)};
    const root = process.argv[1];
    const briefId = "door42";
    const locator = resolveProjectLocator(root, briefId);
    const briefPath = path.join(root, briefId + ".json");
    const app = "com.fleet." + briefId;
    const target = {
      briefInput: "FIFO race",
      briefId,
      app,
      executionSerial: "emulator-5554",
      inputBaseDir: locator.requestedProjectsRoot,
      briefPath,
      projectDir: locator.requestedProjectDir,
      projectLocator: locator,
      resourceKey: applicationResourceKey(app, "emulator-5554"),
      projectResourceKey: projectResourceKey(locator.physicalProjectDir),
      base: null,
    };
    const spec = appSpecSchema.parse({
      meta: { appName: "FifoFixture", packageName: "com.example.fifo", brief: "fifo" },
      scenes: [{ id: "main", environment: { kind: "procedural" } }],
      navigation: { startScene: "main" },
    });
    fs.writeFileSync(briefPath, canonicalJson({ id: briefId, brief: target.briefInput, spec }));
    let swapped = false;
    const observers = createFleetInputIdentityObserversForTest({
      onBoundary(event) {
        if (!swapped && event.kind === "brief-before-descriptor-open") {
          swapped = true;
          fs.unlinkSync(briefPath);
          const fifo = spawnSync("mkfifo", [briefPath], { encoding: "utf8" });
          if (fifo.status !== 0) throw new Error(fifo.stderr || "mkfifo failed");
        }
      },
    });
    try {
      observers.readCompatibilityBrief(target);
      process.exitCode = 2;
    } catch (error) {
      if (swapped && /regular|changed|FIFO|special/i.test(String(error))) process.exitCode = 0;
      else { console.error(error); process.exitCode = 3; }
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, root], {
    encoding: "utf8",
    timeout: 1_200,
    killSignal: "SIGTERM",
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `child signal: ${child.signal}\n${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
});

test("target identity rejects a project mapping that does not belong to the target brief ID", (t) => {
  const root = scratch(t, "pico-target-mapping-");
  const wrongLocator = resolveProjectLocator(root, "door99");
  const target = targetFor(wrongLocator, {
    briefId: "door42",
    briefPath: path.join(root, "door42.json"),
  });
  assert.throws(() => readCompatibilityBrief(target), /project|briefId|mapping|target/i);
});

test("target generation reuses the exact receipt Gradle policy and changes only for selected inputs", (t) => {
  const root = scratch(t, "pico-target-generation-");
  const id = "door42";
  const project = createGradleProjectAt(path.join(root, `fleet-${id}-native`));
  const locator = resolveProjectLocator(root, id);
  const briefPath = path.join(root, `${id}.json`);
  const target = targetFor(locator, { briefId: id, briefPath });
  const briefRaw = canonicalBrief(target);
  fs.writeFileSync(briefPath, briefRaw);

  const receiptIdentity = collectGradleInputIdentity(project);
  const baseline = observeTargetGeneration(target);
  assert.deepEqual(baseline.brief, {
    status: "observed",
    bytes: Buffer.byteLength(briefRaw),
    sha256: sha(Buffer.from(briefRaw)),
  });
  assert.deepEqual(baseline.project, {
    status: "observed",
    directory: {
      physicalPath: fs.realpathSync(project),
      ...directoryIdentity(project),
    },
    identity: {
      kind: "pico.gradle-input-generation",
      schemaVersion: 1,
      policy: "pico-native-receipt-gradle-input-v1",
      projectDir: receiptIdentity.projectDir,
      algorithm: "sha256",
      sha256: receiptIdentity.sha256,
      entryCount: receiptIdentity.entryCount,
      totalBytes: receiptIdentity.totalBytes,
    },
  });

  const sourcePath = path.join(project, "app/src/main/java/com/example/Main.kt");
  fs.writeFileSync(sourcePath, "package com.example\nclass Changed\n");
  const selectedChange = observeTargetGeneration(target);
  assert.notEqual(selectedChange.project.identity.sha256, baseline.project.identity.sha256);

  fs.writeFileSync(sourcePath, "package com.example\nclass Main\n");
  fs.writeFileSync(path.join(project, "README.md"), "ignored documentation\n");
  writeFixtureFile(project, "app/build/cache.bin", "ignored build cache\n");
  assert.deepEqual(observeTargetGeneration(target), baseline);
});

test("target generation represents an absent project and a bounded unmeasurable project without inventing authority", (t) => {
  const root = scratch(t, "pico-target-unobservable-");
  const id = "door42";
  const absentLocator = resolveProjectLocator(root, id);
  const briefPath = path.join(root, `${id}.json`);
  const absent = observeTargetGeneration(targetFor(absentLocator, { briefId: id, briefPath }));
  assert.deepEqual(absent, {
    brief: { status: "absent" },
    project: { status: "absent" },
  });

  fs.mkdirSync(absentLocator.requestedProjectDir);
  fs.writeFileSync(path.join(absentLocator.requestedProjectDir, "README.md"), "not a Gradle project\n");
  const unobservable = observeTargetGeneration(targetFor(absentLocator, { briefId: id, briefPath }));
  assert.equal(unobservable.brief.status, "absent");
  assert.equal(unobservable.project.status, "unobservable");
  assert.match(unobservable.project.reason, /Android manifest|Kotlin|Java|Gradle input|project/i);
  assert.ok(Buffer.byteLength(unobservable.project.reason) <= 64 * 1024);
  assert.equal(unobservable.project.reasonSha256, sha(unobservable.project.reason));
  assert.deepEqual(Object.keys(unobservable.project).sort(), ["reason", "reasonSha256", "status"]);
});

test("target generation rejects a brief change across project collection instead of returning a torn pair", (t) => {
  const root = scratch(t, "pico-target-brief-race-");
  const id = "door42";
  createGradleProjectAt(path.join(root, `fleet-${id}-native`));
  const locator = resolveProjectLocator(root, id);
  const briefPath = path.join(root, `${id}.json`);
  const target = targetFor(locator, { briefId: id, briefPath });
  fs.writeFileSync(briefPath, canonicalBrief(target, minimalSpec("before project collection")));
  let replaced = false;
  const racingObservers = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (!replaced && event.kind === "project-identity-collected") {
        replaced = true;
        fs.writeFileSync(briefPath, canonicalBrief(target, minimalSpec("after project collection")));
      }
    },
  });
  assert.throws(
    () => racingObservers.observeTargetGeneration(target),
    /brief|generation|changed|coherent|race|stable/i,
  );
  assert.equal(replaced, true);
});

test("target generation rejects brief and selected-input ABA instead of returning a pair that never coexisted", (t) => {
  const root = scratch(t, "pico-target-generation-aba-");
  const id = "door42";
  const project = createGradleProjectAt(path.join(root, `fleet-${id}-native`));
  const sourcePath = path.join(project, "app/src/main/java/com/example/Main.kt");
  const source0 = fs.readFileSync(sourcePath);
  const project0 = collectGradleInputIdentity(project);
  fs.writeFileSync(sourcePath, "package com.example\nclass GenerationOne\n");
  const project1 = collectGradleInputIdentity(project);
  assert.notEqual(project1.sha256, project0.sha256);
  fs.writeFileSync(sourcePath, source0);
  assert.equal(collectGradleInputIdentity(project).sha256, project0.sha256);

  const locator = resolveProjectLocator(root, id);
  const briefPath = path.join(root, `${id}.json`);
  const target = targetFor(locator, { briefId: id, briefPath });
  const brief0 = canonicalBrief(target, minimalSpec("generation zero"));
  const brief1 = canonicalBrief(target, minimalSpec("generation one"));
  fs.writeFileSync(briefPath, brief0);
  let briefAdvanced = false;
  let bothRestored = false;
  const racingObservers = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (!briefAdvanced && event.kind === "brief-hash") {
        briefAdvanced = true;
        fs.writeFileSync(briefPath, brief1);
        fs.writeFileSync(sourcePath, "package com.example\nclass GenerationOne\n");
      } else if (briefAdvanced && !bothRestored && event.kind === "project-identity-collected") {
        bothRestored = true;
        fs.writeFileSync(sourcePath, source0);
        fs.writeFileSync(briefPath, brief0);
      }
    },
  });
  assert.throws(
    () => racingObservers.observeTargetGeneration(target),
    /brief|project|generation|changed|coherent|race|stable/i,
  );
  assert.equal(briefAdvanced, true);
  assert.equal(bothRestored, true);
  assert.equal(fs.readFileSync(briefPath, "utf8"), brief0);
  assert.equal(collectGradleInputIdentity(project).sha256, project0.sha256);
});

test("target generation rejects a project absent-to-present race instead of returning a torn absence", (t) => {
  const root = scratch(t, "pico-target-project-absence-race-");
  const id = "door42";
  const locator = resolveProjectLocator(root, id);
  const target = targetFor(locator, { briefId: id, briefPath: path.join(root, `${id}.json`) });
  let appeared = false;
  const racingObservers = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (!appeared && event.kind === "project-absence-first-observed") {
        appeared = true;
        createGradleProjectAt(event.physicalProjectDir);
      }
    },
  });
  assert.throws(
    () => racingObservers.observeTargetGeneration(target),
    /project|appear|generation|changed|race|stable|absen/i,
  );
  assert.equal(appeared, true);
});

test("target generation revalidates alias and anchored-project identity at the return boundary", (t) => {
  const directory = scratch(t, "pico-target-final-locator-");
  const id = "door42";
  const rootA = path.join(directory, "a");
  const rootB = path.join(directory, "b");
  createGradleProjectAt(path.join(rootA, `fleet-${id}-native`), "class A");
  createGradleProjectAt(path.join(rootB, `fleet-${id}-native`), "class B");
  const alias = path.join(directory, "projects");
  fs.symlinkSync(rootA, alias);
  const aliasLocator = resolveProjectLocator(alias, id);
  const aliasBriefPath = path.join(directory, "alias-brief", `${id}.json`);
  fs.mkdirSync(path.dirname(aliasBriefPath));
  const aliasTarget = targetFor(aliasLocator, { briefId: id, briefPath: aliasBriefPath });
  fs.writeFileSync(aliasBriefPath, canonicalBrief(aliasTarget));
  let retargeted = false;
  const aliasRace = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (!retargeted && event.kind === "brief-hash") {
        retargeted = true;
        fs.unlinkSync(alias);
        fs.symlinkSync(rootB, alias);
      }
    },
  });
  assert.throws(
    () => aliasRace.observeTargetGeneration(aliasTarget),
    /locator|anchor|physical|external|conflict|changed|stable/i,
  );
  assert.equal(retargeted, true);

  const anchoredRoot = path.join(directory, "anchored");
  const anchoredProject = createGradleProjectAt(path.join(anchoredRoot, `fleet-${id}-native`));
  const anchoredLocator = resolveProjectLocator(anchoredRoot, id);
  const anchoredBriefPath = path.join(directory, "anchored-brief", `${id}.json`);
  fs.mkdirSync(path.dirname(anchoredBriefPath));
  const anchoredTarget = targetFor(anchoredLocator, { briefId: id, briefPath: anchoredBriefPath });
  fs.writeFileSync(anchoredBriefPath, canonicalBrief(anchoredTarget));
  const held = path.join(anchoredRoot, "held-project");
  let replaced = false;
  const anchoredRace = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (!replaced && event.kind === "brief-hash") {
        replaced = true;
        fs.renameSync(anchoredProject, held);
        createGradleProjectAt(anchoredProject, "class Replacement");
      }
    },
  });
  assert.throws(
    () => anchoredRace.observeTargetGeneration(anchoredTarget),
    /locator|anchor|device|inode|external|conflict|changed|stable/i,
  );
  assert.equal(replaced, true);
});

test("project generation rejects a root replacement during selected-input collection instead of pairing torn identities", (t) => {
  const root = scratch(t, "pico-project-generation-race-");
  const id = "door42";
  const project = createGradleProjectAt(path.join(root, `fleet-${id}-native`));
  const locator = resolveProjectLocator(root, id);
  const target = targetFor(locator, { briefId: id, briefPath: path.join(root, `${id}.json`) });
  const physicalProject = fs.realpathSync(project);
  const heldProject = path.join(root, "held-project-generation");
  let replaced = false;
  const racingObservers = createFleetInputIdentityObserversForTest({
    onBoundary(event) {
      if (!replaced && event.kind === "project-identity-collected"
        && event.physicalProjectDir === physicalProject) {
        replaced = true;
        fs.renameSync(project, heldProject);
        createGradleProjectAt(project, "class Replacement");
      }
    },
  });
  assert.throws(
    () => racingObservers.observeTargetGeneration(target),
    /brief|project|generation|changed|continuity|conflict|stable/i,
  );
  assert.equal(replaced, true);
});

test("locator and generation V1 stay read-only and never create, truncate, rename, repair, or adopt compatibility state", (t) => {
  const root = scratch(t, "pico-locator-read-only-");
  const id = "door42";
  const project = createGradleProjectAt(path.join(root, `fleet-${id}-native`));
  const locator = resolveProjectLocator(root, id);
  const briefPath = path.join(root, `${id}.json`);
  const target = targetFor(locator, { briefId: id, briefPath });
  const raw = canonicalBrief(target);
  fs.writeFileSync(briefPath, raw);
  const beforeProjectEntries = fs.readdirSync(project).sort();
  const beforeRootEntries = fs.readdirSync(root).sort();
  const beforeBrief = fs.readFileSync(briefPath);
  const beforeBriefStat = fs.statSync(briefPath, { bigint: true });
  const restore = protectTreeReadOnly(root);
  const beforeTree = snapshotTree(root);
  try {
    assert.deepEqual(revalidateProjectLocator(locator), locator);
    assert.deepEqual(readCompatibilityBrief(target), {
      status: "observed",
      bytes: beforeBrief.length,
      sha256: sha(beforeBrief),
    });
    assert.equal(observeTargetGeneration(target).project.status, "observed");
    assert.deepEqual(snapshotTree(root), beforeTree);
  } finally {
    restore();
  }

  assert.deepEqual(fs.readdirSync(project).sort(), beforeProjectEntries);
  assert.deepEqual(fs.readdirSync(root).sort(), beforeRootEntries);
  assert.deepEqual(fs.readFileSync(briefPath), beforeBrief);
  const afterBriefStat = fs.statSync(briefPath, { bigint: true });
  assert.equal(afterBriefStat.dev, beforeBriefStat.dev);
  assert.equal(afterBriefStat.ino, beforeBriefStat.ino);
  assert.equal(afterBriefStat.size, beforeBriefStat.size);
});
