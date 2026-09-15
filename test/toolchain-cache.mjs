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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { IdentityCache } from "../dist/identitycache.js";
import { adbExecutable, clearAdbResolutionCache, resolveAdbExecutable } from "../dist/adb.js";
import { clearProtoCache, loadProto } from "../dist/grpc.js";
import { detectJavaHome, gradleEnv } from "../dist/toolchain.js";
import { registerDeployTools } from "../dist/deploy.js";
import { toolchainIOFromTree } from "./helpers/toolchain-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("a set-but-unusable PICO_ADB FAILS CLOSED and probes nothing else", () => {
  // The track rule: an explicit root or pin never falls back. A perfectly good adb sits on PATH
  // here precisely so that "it resolved" cannot be mistaken for "it was correct".
  clearAdbResolutionCache();
  const io = adbIO({
    env: { PICO_ADB: "/opt/pinned/adb", PATH: "/usr/local/bin", PICO_HOME: "/fixture/Library/PICO/sdk" },
    files: {
      "/opt/pinned/adb": { bytes: "not-executable", executable: false },
      [PATH_ADB]: { bytes: "path-adb", executable: true },
      ...sdkTree("bundled-adb"),
    },
  });
  const r = resolveAdbExecutable(io);
  assert.equal(r.status, "unavailable");
  assert.equal(r.code, "unavailable/adb-override-unusable");
  assert.equal(r.overrideRejected?.path, "/opt/pinned/adb");
  assert.match(r.overrideRejected.reason, /executable/i);
  assert.deepEqual(r.probed, ["/opt/pinned/adb"], "no PATH or bundled candidate may be probed past a rejected override");
  assert.ok(!io.reads.some((p) => p === PATH_ADB || p === BUNDLED_ADB), "no fallback payload may be read");
});

test("adbExecutable THROWS on an unusable explicit override, naming the path and the reason", () => {
  const cases = [
    { label: "missing", files: {}, reason: /names no existing file/ },
    { label: "not executable", files: { "/opt/pinned/adb": { bytes: "x", executable: false } }, reason: /not an executable file/ },
  ];
  for (const { label, files, reason } of cases) {
    clearAdbResolutionCache();
    const io = adbIO({
      env: { PICO_ADB: "/opt/pinned/adb", PATH: "/usr/local/bin", PICO_HOME: "/fixture/Library/PICO/sdk" },
      files: { ...files, [PATH_ADB]: { bytes: "path-adb", executable: true }, ...sdkTree("bundled-adb") },
    });
    assert.throws(() => adbExecutable(io), (error) => {
      assert.match(error.message, /\/opt\/pinned\/adb/, `${label}: the configured path must be named`);
      assert.match(error.message, reason, `${label}: the reason must be named`);
      assert.match(error.message, /no fallback was attempted/i, `${label}: the refusal to fall back must be stated`);
      return true;
    }, `${label}: adbExecutable must refuse rather than substitute a different binary`);
    assert.ok(!io.reads.some((p) => p === PATH_ADB || p === BUNDLED_ADB), `${label}: no fallback payload may be read`);
  }
});

test("an explicit override whose bytes cannot be read is refused, not silently identity-less", () => {
  // $PICO_ADB pointing at a directory passes an X_OK check; an override that cannot be identified
  // by its bytes is not an override at all.
  clearAdbResolutionCache();
  const io = toolchainIOFromTree({
    platform: "darwin", home: "/fixture",
    env: { PICO_ADB: "/opt/pinned", PATH: "/usr/local/bin" },
    files: { "/opt/pinned/inner": { bytes: "x", executable: true }, [PATH_ADB]: { bytes: "path-adb", executable: true } },
  });
  io.executable = (target) => target === "/opt/pinned" || target === "/opt/pinned/inner" || target === PATH_ADB;
  const r = resolveAdbExecutable(io);
  assert.equal(r.status, "unavailable");
  assert.equal(r.code, "unavailable/adb-override-unusable");
  assert.match(r.overrideRejected.reason, /readable regular file/i);
});

test("a corrected PICO_ADB is honoured immediately: a refusal is never cached", () => {
  clearAdbResolutionCache();
  const broken = adbIO({ env: { PICO_ADB: "/opt/pinned/adb" }, files: { "/opt/pinned/adb": { bytes: "x", executable: false } } });
  assert.equal(resolveAdbExecutable(broken).status, "unavailable");
  const fixed = adbIO({ env: { PICO_ADB: "/opt/pinned/adb" }, files: { "/opt/pinned/adb": { bytes: "pinned-adb", executable: true } } });
  const r = resolveAdbExecutable(fixed);
  assert.equal(r.status, "ok");
  assert.equal(r.source, "explicit");
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

// ──────────────────────────────────────────── the refusal reaches a real consumer, and stays lazy

test("a real consumer surfaces the refusal through its own error path, spawning no adb", async () => {
  // STRUCTURALLY hermetic, not incidentally so. `deploy_to_device` reads
  // `(deps.resolveAdbFn ?? resolveAdb)()` and then runs adb through `deps.runFn` — so leaving
  // resolveAdbFn UNSET exercises the real adapter (that is the point of a consumer-level case)
  // while every function that could reach a process is a tripwire that fails this test loudly.
  //
  // The previous version of this case passed `{}` for the dependencies and was hermetic only
  // because production happens to evaluate resolveAdb() before building its runners. That is an
  // emergent property of adb.ts, not a guarantee of the test: run against pre-fix code it fell
  // through and executed a real `adb devices -l` on this host (see the report's fix round 2).
  const reached = [];
  const tripwire = (name) => (...args) => {
    reached.push(`${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
    throw new Error(`fixture reached a real spawn: ${name}`);
  };
  const handlers = {};
  registerDeployTools(
    { registerTool: (name, _metadata, fn) => { handlers[name] = fn; } },
    {
      runFn: tripwire("run"),
      runBinaryFn: tripwire("runBinary"),
      probeDeviceIdentityFn: tripwire("probeDeviceIdentity"),
      sleepFn: tripwire("sleep"),
      // resolveAdbFn deliberately NOT injected: the real adapter must be the thing under test.
    },
  );

  const configured = "/fixture/no/such/adb";
  const prior = process.env.PICO_ADB;
  process.env.PICO_ADB = configured;
  clearAdbResolutionCache();
  try {
    await assert.rejects(
      () => handlers.deploy_to_device({
        apkPath: "/fixture/app.apk",
        packageName: "com.fixture.app",
        // A fixture serial, never emulator-5554 and never a real device: this repository reserves
        // emulator-5554 for the user, so no test of mine may name it as a target.
        deviceSerial: "fixture-swan-0000",
      }),
      (error) => {
        assert.match(error.message, /\/fixture\/no\/such\/adb/, "the configured path must be named");
        assert.match(error.message, /names no existing file/, "the reason must be named");
        assert.match(error.message, /no fallback was attempted/i, "the refusal to fall back must be stated");
        return true;
      },
      "deploy_to_device must surface the refusal instead of running some other adb",
    );
  } finally {
    if (prior === undefined) delete process.env.PICO_ADB; else process.env.PICO_ADB = prior;
    clearAdbResolutionCache();
  }
  assert.deepEqual(reached, [], "no injected runner may be invoked: the refusal must precede every spawn");
});

test("the loud-runner fixture would actually catch a spawn", async () => {
  // A tripwire nobody proves can fire is decoration. Same consumer, same stubs, a WORKING
  // $PICO_ADB — so resolution succeeds and the very next thing the handler does is call runFn.
  const reached = [];
  const handlers = {};
  registerDeployTools(
    { registerTool: (name, _metadata, fn) => { handlers[name] = fn; } },
    {
      runFn: (...args) => { reached.push(args[0]); throw new Error("fixture reached a real spawn: run"); },
      runBinaryFn: () => { throw new Error("fixture reached a real spawn: runBinary"); },
      probeDeviceIdentityFn: () => { throw new Error("fixture reached a real spawn: probeDeviceIdentity"); },
      sleepFn: async () => {},
      resolveAdbFn: () => "/fixture/usable/adb",
    },
  );
  await assert.rejects(
    () => handlers.deploy_to_device({ apkPath: "/fixture/app.apk", packageName: "com.fixture.app", deviceSerial: "fixture-swan-0000" }),
    /fixture reached a real spawn: run/,
  );
  assert.deepEqual(reached, ["/fixture/usable/adb"], "the tripwire fires on the first adb invocation");
});

test("no consumer resolves adb at module load", () => {
  // The textual half. src/verifyapk.ts froze its adb into a module constant, and src/index.ts
  // imports it at server start.
  const offenders = [];
  for (const name of fs.readdirSync(path.join(repoRoot, "src")).filter((f) => f.endsWith(".ts"))) {
    if (name === "adb.ts") continue; // where adbExecutable is defined
    for (const line of fs.readFileSync(path.join(repoRoot, "src", name), "utf8").split("\n")) {
      if (!/adbExecutable\s*\(/.test(line)) continue;
      const topLevel = !/^[ \t]/.test(line);
      const lazy = /=>\s*adbExecutable\s*\(/.test(line);
      if (topLevel && !lazy) offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "adb must be resolved per call, never frozen at import time");
});

test("a broken $PICO_ADB cannot break server startup or tool registration", () => {
  // The BEHAVIOURAL half, and the one that matters: the textual gate above only sees a literal
  // `adbExecutable(` and missed two real offenders that reached it one hop away —
  // boundaryexperiment.ts built its live orchestrator at module scope, and worldlocomotion.ts
  // built its dependencies during registerInAppLocomotionTools(). With a stale PICO_ADB export,
  // fail-closed resolution turned both into a server that died before registering anything:
  // tools/list gone, preflight_env gone, and the doctor row that explains the problem
  // unreachable. Every device-free lane must survive a bad override.
  //
  // Runs in a CHILD process so the module registry is clean (this suite has already imported
  // several dist modules under a good environment) and so the hostile env cannot leak into the
  // rest of the run. The child imports every dist module except index.js — which would start a
  // server — and calls every exported register*Tools with a stub. No adb, no device, no emulator.
  const probe = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const dist = process.argv[1];",
    "const stub = { registerTool: () => {}, tool: () => {}, registerResource: () => {}, registerPrompt: () => {} };",
    "const failures = [];",
    'for (const file of fs.readdirSync(dist).filter((f) => f.endsWith(".js") && f !== "index.js").sort()) {',
    "  let mod;",
    "  try { mod = await import(path.join(dist, file)); }",
    "  catch (e) { failures.push(`import ${file}: ${e?.message ?? e}`); continue; }",
    "  for (const [name, value] of Object.entries(mod)) {",
    '    if (typeof value !== "function" || !/^register\\w*Tools$/.test(name)) continue;',
    "    try { value(stub); } catch (e) { failures.push(`${file} ${name}(): ${e?.message ?? e}`); }",
    "  }",
    "}",
    "console.log(JSON.stringify(failures));",
  ].join("\n");

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", probe, path.join(repoRoot, "dist")],
    { encoding: "utf8", timeout: 120_000, env: { ...process.env, PICO_ADB: "/fixture/no/such/adb" } },
  );
  assert.equal(result.status, 0, `startup probe did not complete: ${result.stderr}`);
  const failures = JSON.parse(result.stdout.trim().split("\n").pop());
  const adbFailures = failures.filter((f) => /PICO_ADB|adbExecutable|adb not found/i.test(f));
  assert.deepEqual(adbFailures, [], "a bad $PICO_ADB must reach the handler that needs a device, never server startup");
});
