// Task S4 — selected-SDK resource caches must be keyed on WHAT WAS SELECTED, not on "have I run
// before". Every cache in this suite is expected to notice a root/version switch, a replaced
// payload and a removed payload within one process, and to publish nothing for a failed load.
//
// Hermetic: the ADB and JDK blocks run entirely against the in-memory ToolchainIO fixture (an
// "executable" is a boolean flag, never a real binary). The proto block writes a throwaway tools
// tree under os.tmpdir() because @grpc/proto-loader reads real files — the fixture `emulator`
// payloads there are created mode 0755 and are never executed, and no device connection is
// opened anywhere in this file.
//
// Run: npm run build && node --test test/toolchain-cache.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IdentityCache } from "../dist/identitycache.js";
import { adbExecutable, clearAdbResolutionCache, resolveAdbExecutable } from "../dist/adb.js";
import { clearProtoCache, loadProto } from "../dist/grpc.js";
import { detectJavaHome, gradleEnv } from "../dist/toolchain.js";
import { toolchainIOFromTree } from "./helpers/toolchain-fixture.mjs";

// ─────────────────────────────────────────────────────────── the cache primitive

test("IdentityCache reloads when the identity changes", () => {
  const cache = new IdentityCache(); let loads = 0;
  assert.equal(cache.get("old-bytes", () => ++loads), 1);
  assert.equal(cache.get("old-bytes", () => ++loads), 1);
  assert.equal(cache.get("new-bytes", () => ++loads), 2);
});

test("IdentityCache publishes nothing when the loader throws, and never returns a stale value", () => {
  const cache = new IdentityCache();
  assert.equal(cache.get("a", () => "A"), "A");
  assert.throws(() => cache.get("b", () => { throw new Error("load failed"); }), /load failed/);
  // The failed key must not be remembered AND the previous key's value must not resurface.
  let reloads = 0;
  assert.equal(cache.get("a", () => { reloads += 1; return "A2"; }), "A2");
  assert.equal(reloads, 1, "the entry for 'a' was evicted before 'b' was attempted");
});

test("IdentityCache.getOr lets a caller refuse to cache an unavailable result", () => {
  const cache = new IdentityCache();
  let loads = 0;
  const load = () => { loads += 1; return loads === 1 ? { error: "absent" } : { value: "present" }; };
  const cacheable = (result) => !("error" in result);
  assert.deepEqual(cache.getOr("k", load, cacheable), { error: "absent" });
  assert.deepEqual(cache.getOr("k", load, cacheable), { value: "present" });
  assert.equal(loads, 2, "an unavailable result is never published");
  assert.deepEqual(cache.getOr("k", load, cacheable), { value: "present" });
  assert.equal(loads, 2, "the successful result IS published");
});

test("IdentityCache.clear empties the entry", () => {
  const cache = new IdentityCache(); let loads = 0;
  cache.get("k", () => ++loads);
  cache.clear();
  assert.equal(cache.get("k", () => ++loads), 2);
});

// ─────────────────────────────────────────────────────────────────── adb adapter

const sha256 = (value) => crypto.createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");

/**
 * The fixture ToolchainIO plus the cheap `stat` the host adapter uses to decide whether a payload
 * needs re-hashing. `mtimes` is declared per path so a test can model a replacement.
 */
function adbIO({ platform = "darwin", home = "/fixture", env = {}, files = {}, mtimes = {} } = {}) {
  const io = toolchainIOFromTree({ platform, home, env, files });
  const P = platform === "win32" ? path.win32 : path.posix;
  const table = new Map();
  for (const [raw, spec] of Object.entries(files)) {
    const bytes = typeof spec === "string" ? spec : String(spec?.bytes ?? "");
    table.set(P.normalize(raw), { size: Buffer.byteLength(bytes, "utf8"), mtimeMs: mtimes[raw] ?? 1_000 });
  }
  io.stat = (target) => table.get(P.normalize(target)) ?? null;
  return io;
}

const PATH_ADB = "/usr/local/bin/adb";
const BUNDLED_ADB = "/fixture/Library/PICO/sdk/6.1/emulator/system-images/platform-tools/adb";

function sdkTree(adbBytes) {
  return {
    [BUNDLED_ADB]: { bytes: adbBytes, executable: true },
    "/fixture/Library/PICO/sdk/6.1/emulator/emulator": { bytes: "emulator-6.1", executable: true },
  };
}

test("adb resolution prefers an explicit PICO_ADB and discloses its identity", () => {
  clearAdbResolutionCache();
  const io = adbIO({
    env: { PICO_ADB: "/opt/pinned/adb", PATH: "/usr/local/bin", PICO_HOME: "/fixture/Library/PICO/sdk" },
    files: { "/opt/pinned/adb": { bytes: "pinned-adb", executable: true }, [PATH_ADB]: { bytes: "path-adb", executable: true }, ...sdkTree("bundled-adb") },
  });
  const r = resolveAdbExecutable(io);
  assert.equal(r.status, "ok");
  assert.equal(r.path, "/opt/pinned/adb");
  assert.equal(r.source, "explicit");
  assert.deepEqual(r.identity, { path: "/opt/pinned/adb", sha256: sha256("pinned-adb") });
});

test("adb resolution searches PATH before the bundled platform-tools payload", () => {
  clearAdbResolutionCache();
  const io = adbIO({
    env: { PATH: "/empty:/usr/local/bin", PICO_HOME: "/fixture/Library/PICO/sdk" },
    files: { [PATH_ADB]: { bytes: "path-adb", executable: true }, ...sdkTree("bundled-adb") },
  });
  const r = resolveAdbExecutable(io);
  assert.equal(r.source, "path");
  assert.equal(r.path, PATH_ADB);
});

test("adb resolution falls back to the SELECTED toolchain's bundled adb, not a hardcoded 0.13 path", () => {
  clearAdbResolutionCache();
  const io = adbIO({
    env: { PATH: "/empty", PICO_HOME: "/fixture/Library/PICO/sdk" },
    files: sdkTree("bundled-adb"),
  });
  const r = resolveAdbExecutable(io);
  assert.equal(r.status, "ok");
  assert.equal(r.source, "bundled");
  assert.equal(r.path, BUNDLED_ADB);
  assert.equal(r.identity.sha256, sha256("bundled-adb"));
  assert.ok(!/0\.13/.test(r.path), "the bundled candidate must come from the selection, never a literal 0.13 path");
});

test("a set-but-unusable PICO_ADB is disclosed, never silently substituted without a record", () => {
  clearAdbResolutionCache();
  const io = adbIO({
    env: { PICO_ADB: "/opt/pinned/adb", PATH: "/usr/local/bin" },
    files: { "/opt/pinned/adb": { bytes: "not-executable", executable: false }, [PATH_ADB]: { bytes: "path-adb", executable: true } },
  });
  const r = resolveAdbExecutable(io);
  assert.equal(r.status, "ok");
  assert.equal(r.source, "path");
  assert.equal(r.overrideRejected?.path, "/opt/pinned/adb");
  assert.match(r.overrideRejected.reason, /executable/i);
});

test("a replaced adb at the same path is observed inside one process", () => {
  clearAdbResolutionCache();
  const before = adbIO({ env: { PATH: "/usr/local/bin" }, files: { [PATH_ADB]: { bytes: "adb-v1", executable: true } }, mtimes: { [PATH_ADB]: 1_000 } });
  assert.equal(resolveAdbExecutable(before).identity.sha256, sha256("adb-v1"));
  const after = adbIO({ env: { PATH: "/usr/local/bin" }, files: { [PATH_ADB]: { bytes: "adb-v2-longer", executable: true } }, mtimes: { [PATH_ADB]: 2_000 } });
  assert.equal(resolveAdbExecutable(after).identity.sha256, sha256("adb-v2-longer"), "the replacement must not return the cached v1 identity");
});

test("an unchanged adb is not re-hashed on every call", () => {
  clearAdbResolutionCache();
  const io = adbIO({ env: { PATH: "/usr/local/bin" }, files: { [PATH_ADB]: { bytes: "adb-v1", executable: true } } });
  resolveAdbExecutable(io);
  const readsAfterFirst = io.reads.length;
  resolveAdbExecutable(io);
  resolveAdbExecutable(io);
  assert.equal(io.reads.length, readsAfterFirst, "a cache hit must not read the payload again");
});

test("adb absence is never cached: a later-provisioned adb is found without a restart", () => {
  clearAdbResolutionCache();
  const empty = adbIO({ env: { PATH: "/empty" }, files: {} });
  const missing = resolveAdbExecutable(empty);
  assert.equal(missing.status, "unavailable");
  assert.match(missing.detail, /adb/i);
  const provisioned = adbIO({ env: { PATH: "/empty" }, files: sdkTree("bundled-adb"), });
  provisioned.env.PICO_HOME = "/fixture/Library/PICO/sdk";
  assert.equal(resolveAdbExecutable(provisioned).status, "ok");
});

test("adbExecutable keeps the historical bare-name last resort so no consumer control flow changes", () => {
  clearAdbResolutionCache();
  const empty = adbIO({ env: { PATH: "/empty" }, files: {} });
  assert.equal(adbExecutable(empty), "adb");
});

test("adb resolution honours win32 executable naming", () => {
  clearAdbResolutionCache();
  const io = adbIO({
    platform: "win32",
    home: "C:\\Users\\dev",
    env: { PATH: "C:\\tools", PATHEXT: ".COM;.EXE" },
    files: { "C:\\tools\\adb.exe": { bytes: "win-adb", executable: true } },
  });
  const r = resolveAdbExecutable(io);
  assert.equal(r.status, "ok");
  assert.equal(r.source, "path");
  assert.equal(r.path, "C:\\tools\\adb.exe");
});

// ───────────────────────────────────────────────────────────────── proto loading

function writeProtoTree(root, version, { extraRpc = "", extraType = "" } = {}) {
  const libDir = path.join(root, version, "emulator", "lib");
  fs.mkdirSync(libDir, { recursive: true });
  const emulatorBin = path.join(root, version, "emulator", "emulator");
  if (!fs.existsSync(emulatorBin)) fs.writeFileSync(emulatorBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(libDir, "emulator_types.proto"),
    `syntax = "proto3";\npackage android.emulation.control;\nmessage Empty {}\nmessage EmulatorStatus { string version = 1; }\n${extraType}`,
  );
  fs.writeFileSync(
    path.join(libDir, "emulator_controller.proto"),
    `syntax = "proto3";\npackage android.emulation.control;\nimport "emulator_types.proto";\nservice EmulatorController {\n  rpc getStatus (Empty) returns (EmulatorStatus) {}\n${extraRpc}}\n`,
  );
  return libDir;
}

function withPicoHome(root, body) {
  const prior = process.env.PICO_HOME;
  process.env.PICO_HOME = root;
  try { return body(); } finally {
    if (prior === undefined) delete process.env.PICO_HOME; else process.env.PICO_HOME = prior;
  }
}

const methodNames = (p) => Object.values(p.controllerCtor.service).map((m) => m.originalName ?? m.path.split("/").pop()).sort();

test("loadProto for 6.1 does not return the 6.0 schema it already loaded", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s4-proto-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeProtoTree(root, "6.0");
  writeProtoTree(root, "6.1", { extraRpc: "  rpc sendXrHeadPose (Empty) returns (Empty) {}\n" });

  withPicoHome(root, () => {
    clearProtoCache();
    const v60 = loadProto("6.0");
    assert.ok(!("error" in v60), `6.0 failed to load: ${v60.error}`);
    assert.ok(v60.protoPath.includes(`${path.sep}6.0${path.sep}`));
    assert.ok(!methodNames(v60).includes("sendXrHeadPose"));

    const v61 = loadProto("6.1");
    assert.ok(!("error" in v61), `6.1 failed to load: ${v61.error}`);
    assert.ok(v61.protoPath.includes(`${path.sep}6.1${path.sep}`), `6.1 request returned ${v61.protoPath}`);
    assert.ok(methodNames(v61).includes("sendXrHeadPose"), "the 6.1 request returned the cached 6.0 schema");

    // and back again, so the cache is keyed rather than merely last-write-wins-forever
    assert.ok(loadProto("6.0").protoPath.includes(`${path.sep}6.0${path.sep}`));
  });
});

test("loadProto reloads when a TRANSITIVE .proto import changes bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s4-proto-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libDir = writeProtoTree(root, "6.1");

  withPicoHome(root, () => {
    clearProtoCache();
    const first = loadProto("6.1");
    assert.ok(!("error" in first), `first load failed: ${first.error}`);
    assert.ok(!("android.emulation.control.XrPose" in first.pkgDef));

    writeProtoTree(root, "6.1", { extraType: "message XrPose { float x = 1; }\n" });
    assert.ok(fs.readFileSync(path.join(libDir, "emulator_types.proto"), "utf8").includes("XrPose"));

    const second = loadProto("6.1");
    assert.ok(!("error" in second), `second load failed: ${second.error}`);
    assert.ok(
      "android.emulation.control.XrPose" in second.pkgDef,
      "the imported schema changed but the cached package definition was returned",
    );
  });
});

test("loadProto returns the identical object while nothing changed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s4-proto-stable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeProtoTree(root, "6.1");
  withPicoHome(root, () => {
    clearProtoCache();
    const a = loadProto("6.1");
    const b = loadProto("6.1");
    assert.equal(a, b, "an unchanged selection must be served from the cache");
  });
});

test("a failed proto load is not cached", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-s4-proto-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libDir = writeProtoTree(root, "6.1");
  fs.writeFileSync(path.join(libDir, "emulator_controller.proto"), "this is not a proto file {{{\n");

  withPicoHome(root, () => {
    clearProtoCache();
    const broken = loadProto("6.1");
    assert.ok("error" in broken, "a malformed proto must not load");
    writeProtoTree(root, "6.1");
    const repaired = loadProto("6.1");
    assert.ok(!("error" in repaired), `a repaired proto must load without a restart: ${repaired.error}`);
  });
});

// ────────────────────────────────────────────────────────────────── JDK discovery

const jdkIO = (home, executable) => toolchainIOFromTree({
  platform: "darwin", home: "/fixture",
  env: { JAVA_HOME: home }, files: { [`${home}/bin/java`]: { bytes: "fixture-java", executable } },
});

test("JDK discovery revalidates its candidates on every call", () => {
  assert.equal(detectJavaHome(jdkIO("/jdk-a", true)), "/jdk-a");
  assert.equal(detectJavaHome(jdkIO("/jdk-b", true)), "/jdk-b");
  assert.equal(detectJavaHome(jdkIO("/jdk-b", false)), null);
  assert.equal(detectJavaHome(jdkIO("/jdk-b", true)), "/jdk-b");
  assert.deepEqual(gradleEnv(jdkIO("/jdk-a", true)), { JAVA_HOME: "/jdk-a" });
});

test("a removed bin/java is observed without restarting", () => {
  assert.equal(detectJavaHome(jdkIO("/jdk-a", true)), "/jdk-a");
  const removed = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: { JAVA_HOME: "/jdk-a" }, files: {} });
  assert.equal(detectJavaHome(removed), null);
  assert.deepEqual(gradleEnv(removed), {});
});

test("an absent JDK that later appears is found without restarting", () => {
  const absent = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files: {} });
  assert.equal(detectJavaHome(absent), null, "null must never be cached");
  assert.equal(detectJavaHome(jdkIO("/jdk-a", true)), "/jdk-a");
});

const STUDIO_JBR = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
const USER_STUDIO_JBR = "/fixture/Applications/Android Studio.app/Contents/jbr/Contents/Home";

const studioIO = (env, files) => toolchainIOFromTree({ platform: "darwin", home: "/fixture", env, files });

test("the bundled JBR candidates are preserved, user-home candidate included", () => {
  assert.equal(
    detectJavaHome(studioIO({}, { [`${STUDIO_JBR}/bin/java`]: { bytes: "jbr", executable: true } })),
    STUDIO_JBR,
  );
  assert.equal(
    detectJavaHome(studioIO({}, { [`/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home/bin/java`]: { bytes: "jbr", executable: true } })),
    "/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home",
  );
  assert.equal(
    detectJavaHome(studioIO({}, { [`${USER_STUDIO_JBR}/bin/java`]: { bytes: "jbr", executable: true } })),
    USER_STUDIO_JBR,
  );
});

test("replacing Android Studio's bundled JBR is observed with an unchanged environment", () => {
  const present = studioIO({}, { [`${STUDIO_JBR}/bin/java`]: { bytes: "jbr", executable: true } });
  assert.equal(detectJavaHome(present), STUDIO_JBR);
  // same env, the JBR payload loses its executable bit (a partial reinstall)
  const broken = studioIO({}, { [`${STUDIO_JBR}/bin/java`]: { bytes: "jbr", executable: false } });
  assert.equal(detectJavaHome(broken), null);
  const restored = studioIO({}, { [`${STUDIO_JBR}/bin/java`]: { bytes: "jbr-2", executable: true } });
  assert.equal(detectJavaHome(restored), STUDIO_JBR);
});

test("a higher-priority JAVA_HOME appearing after a fallback was selected wins immediately", () => {
  const fallbackFiles = { [`${STUDIO_JBR}/bin/java`]: { bytes: "jbr", executable: true } };
  assert.equal(detectJavaHome(studioIO({}, fallbackFiles)), STUDIO_JBR);
  const withJavaHome = studioIO({ JAVA_HOME: "/jdk-a" }, { ...fallbackFiles, "/jdk-a/bin/java": { bytes: "jdk-a", executable: true } });
  assert.equal(detectJavaHome(withJavaHome), "/jdk-a");
  assert.deepEqual(gradleEnv(withJavaHome), { JAVA_HOME: "/jdk-a" });
});

test("an unusable JAVA_HOME falls through to the bundled JBR, exactly as before", () => {
  const io = studioIO(
    { JAVA_HOME: "/jdk-broken" },
    { "/jdk-broken/bin/java": { bytes: "jdk", executable: false }, [`${STUDIO_JBR}/bin/java`]: { bytes: "jbr", executable: true } },
  );
  assert.equal(detectJavaHome(io), STUDIO_JBR);
});

test("gradleEnv and detectJavaHome answer from the same injected context", () => {
  for (const io of [jdkIO("/jdk-a", true), jdkIO("/jdk-b", false), studioIO({}, {})]) {
    const home = detectJavaHome(io);
    assert.deepEqual(gradleEnv(io), home ? { JAVA_HOME: home } : {});
  }
});
