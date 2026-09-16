// External-APK OBSERVATION, structurally hermetic.
//
// This repository reserves emulator-5554 for the user and a physical PICO device is attached to
// this host, so nothing here may reach a real adb. Hermeticity is STRUCTURAL, not incidental:
//   * every device interaction goes through an injected `runText`/`runBinary` seam;
//   * the seam is a MODEL of a device — an argv it does not recognise throws loudly and fails the
//     test, so a new production command can never slip through unobserved;
//   * serials are fixture strings only (`fixture-observe-*`), never emulator-5554 and never a real
//     serial, and the tool now REQUIRES an explicit serial so there is no default to leak into;
//   * the run directory is a per-test temp root, never ~/.pico-mcp and never /tmp/pico-render;
//   * "the seam was used" is asserted, not assumed — see the call-log assertions and the
//     `would actually catch a spawn` case at the bottom.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { registerVerifyApkTools } from "../dist/verifyapk.js";
import { retainPicoCliObservation } from "../dist/picocli.js";
import { clearAdbResolutionCache } from "../dist/adb.js";

// ── BARRIER 2, and the reason it exists ────────────────────────────────────────────────────────
// The injected seam is the primary barrier. This env pin is the SECOND, independent one, and it is
// here because the first RED run of this file — against the pre-C6 implementation, which took no
// dependencies and hardcoded `emulator-5554` — reached the user's live emulator and cleared its
// global logcat twenty times. An injected seam only protects you once the implementation HAS a
// seam. `PICO_ADB` naming a path that does not exist makes src/adb.ts refuse and refuse to fall
// back, so ANY implementation that bypasses the seam fails loudly instead of finding a real adb.
// Do not remove this, and do not run this file's RED phase without it.
const PINNED_FAKE_ADB = "/fixture/no/such/adb";
const priorPicoAdb = process.env.PICO_ADB;
process.env.PICO_ADB = PINNED_FAKE_ADB;
clearAdbResolutionCache();
test.after(() => {
  if (priorPicoAdb === undefined) delete process.env.PICO_ADB; else process.env.PICO_ADB = priorPicoAdb;
  clearAdbResolutionCache();
});

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "media");
const readFixture = (name) => fs.readFileSync(path.join(fixtures, name));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const SERIAL = "fixture-observe-0001";
const PACKAGE = "com.fixture.observed";
const COMPONENT = ".MainActivity";
const REMOTE_APK = "/data/app/~~fixture==/com.fixture.observed-1/base.apk";
const BOOT_ID = "11111111-2222-3333-4444-555555555555";
const PID = 4242;
const START_TICKS = "987654";
const procStat = (pid, ticks) =>
  `${pid} (com.fixture.observed) S 1 2 3 4 -1 4194304 100 0 0 0 10 20 0 0 20 0 15 0 ${ticks}\n`;
const foregroundDump = (pkg) =>
  `  Display #0 (activities from top to bottom):\n    topResumedActivity=ActivityRecord{1a2b3c u0 ${pkg}/.MainActivity t42}\n`;

const tempRoots = [];
function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pico-observe-${label}-`));
  tempRoots.push(dir);
  return dir;
}
test.after(() => { for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * A MODEL of one device, reachable only through the injected seam. Anything the production code
 * asks for that is not modelled here throws — that is the tripwire, and it is what keeps a future
 * production command from quietly reaching a real adb.
 */
function fakeDevice(overrides = {}) {
  const o = {
    installOutput: "Success\n",
    installCode: 0,
    remoteApkPath: REMOTE_APK,
    remoteApkSha256: null,      // set by the caller; default = the local APK digest
    bootIds: [BOOT_ID, BOOT_ID, BOOT_ID, BOOT_ID],
    pids: [PID, PID, PID],
    startTicks: [START_TICKS, START_TICKS, START_TICKS],
    foregroundPackages: [PACKAGE, PACKAGE],
    launchOutput: "Starting: Intent { cmp=... }\n",
    launchCode: 0,
    logcat: "09-15 10:00:00.000  4242  4242 I Fixture: scene ready\n",
    logcatCode: 0,
    captureBytes: readFixture("valid-small.png"),
    captureCode: 0,
    captureStderr: "",
    ...overrides,
  };
  const calls = [];
  const takeNext = (list, label) => {
    if (!list.length) throw new Error(`fixture ran out of ${label} responses — production asked more times than the model expects`);
    return list.length === 1 ? list[0] : list.shift();
  };
  const bootIds = [...o.bootIds];
  const pids = [...o.pids];
  const startTicks = [...o.startTicks];
  const foregroundPackages = [...o.foregroundPackages];

  const text = (stdout, code = 0, stderr = "") => ({ code, stdout, stderr, timedOut: false });

  const runText = async (command, args) => {
    calls.push({ command, args: [...args] });
    const joined = args.join(" ");
    assert.equal(args[0], "-s", `every device command must name its target explicitly: ${joined}`);
    assert.equal(args[1], SERIAL, `a device command addressed ${args[1]} instead of the fixture serial`);
    if (args[2] === "install") return text(o.installOutput, o.installCode);
    if (joined.includes("shell am force-stop")) return text("");
    if (joined.includes("shell pm path")) return text(`package:${o.remoteApkPath}\n`);
    if (joined.includes("shell toybox sha256sum")) {
      const digest = o.remoteApkSha256 ?? o.localApkSha256;
      return text(`${digest}  ${o.remoteApkPath}\n`);
    }
    if (joined.includes("/proc/sys/kernel/random/boot_id")) {
      const bootId = takeNext(bootIds, "boot_id");
      // null models a read that FAILS on this call only — the before/after reads are separate facts.
      return bootId === null ? text("", 1, "cat: /proc/sys/kernel/random/boot_id: Permission denied") : text(`${bootId}\n`);
    }
    if (joined.includes("shell am start") || joined.includes("shell monkey")) return text(o.launchOutput, o.launchCode);
    if (joined.includes("shell pidof")) {
      const pid = takeNext(pids, "pidof");
      return pid === null ? text("", 1) : text(`${pid}\n`);
    }
    if (/\/proc\/\d+\/stat/.test(joined)) {
      const pid = /\/proc\/(\d+)\/stat/.exec(joined)[1];
      return text(procStat(pid, takeNext(startTicks, "proc-stat")));
    }
    if (joined.includes("dumpsys activity activities")) {
      const pkg = takeNext(foregroundPackages, "foreground");
      // null models a dump that names no resumed activity at all.
      return text(pkg === null ? "  Display #0 (activities from top to bottom):\n" : foregroundDump(pkg));
    }
    if (joined.includes("logcat")) return text(o.logcat, o.logcatCode);
    throw new Error(`fixture reached an UNMODELLED device command: ${command} ${joined}`);
  };
  const runBinary = async (command, args) => {
    calls.push({ command, args: [...args], binary: true });
    const joined = args.join(" ");
    assert.equal(args[1], SERIAL, `a binary device command addressed ${args[1]} instead of the fixture serial`);
    if (joined.includes("screencap")) {
      return { code: o.captureCode, stdout: Buffer.from(o.captureBytes), stderr: o.captureStderr, timedOut: false };
    }
    throw new Error(`fixture reached an UNMODELLED binary device command: ${command} ${joined}`);
  };
  return { runText, runBinary, calls, options: o };
}

function writeApk(dir, body = "fixture-apk-bytes") {
  const apkPath = path.join(dir, "fixture.apk");
  fs.writeFileSync(apkPath, body);
  return { apkPath, sha256: sha256(Buffer.from(body)) };
}

/** Register the real tool against a fake server and return its handler. */
function handlerFor(deps) {
  const handlers = {};
  registerVerifyApkTools({ registerTool: (name, _metadata, fn) => { handlers[name] = fn; } }, deps);
  assert.ok(handlers.verify_pico_apk, "verify_pico_apk must still be the registered tool name");
  return handlers.verify_pico_apk;
}

async function observe(scenario = {}, { label = "run", extraDeps = {}, args = {} } = {}) {
  const root = tempRoot(label);
  const { apkPath, sha256: localApkSha256 } = writeApk(root);
  const device = fakeDevice({ localApkSha256, ...scenario });
  const handler = handlerFor({
    runTextFn: device.runText,
    runBinaryFn: device.runBinary,
    resolveAdbFn: () => "/fixture/adb",
    sleepFn: async () => {},
    observationRoot: () => path.join(root, "observations"),
    ...extraDeps,
  });
  const result = await handler({
    apkPath,
    packageName: PACKAGE,
    serial: SERIAL,
    activity: COMPONENT,
    settleSec: 0,
    ...args,
  });
  const payload = JSON.parse(result.content[0].text);
  return { payload, device, root, localApkSha256, apkPath };
}

// ── the observation record itself ──────────────────────────────────────────────────────────────

test("a clean observation records every identity field as OBSERVED and is not a receipt", async () => {
  const { payload, device, localApkSha256 } = await observe({}, { label: "clean" });
  assert.equal(payload.status, "observed", JSON.stringify(payload).slice(0, 600));
  assert.equal(payload.scope, "external-apk-observation");
  assert.notEqual(payload.scope, "fleet-native-debug", "an external APK may never claim the fleet-native receipt scope");
  assert.ok(!("receipt" in payload) || payload.receipt === null, "this path publishes no run receipt");
  assert.match(payload.notAReceipt, /receipt|release|hardware/i);

  assert.equal(payload.identity.apk.status, "observed");
  assert.equal(payload.identity.apk.sha256, localApkSha256);
  assert.equal(payload.identity.serial.status, "observed");
  assert.equal(payload.identity.serial.value, SERIAL);
  assert.equal(payload.identity.installedPackage.value, PACKAGE);
  assert.equal(payload.identity.installedApk.status, "observed");
  assert.equal(payload.identity.installedApk.sha256, localApkSha256);
  assert.equal(payload.identity.installedApk.path, REMOTE_APK);
  assert.equal(payload.identity.bootId.value, BOOT_ID);
  assert.equal(payload.identity.process.pid, PID);
  assert.equal(payload.identity.process.startTicks, START_TICKS);
  assert.equal(payload.identity.foreground.packageName, PACKAGE);

  assert.equal(payload.capture.route, "adb-screencap");
  assert.equal(payload.capture.status, "captured");
  assert.equal(payload.capture.sha256, sha256(device.options.captureBytes));
  assert.equal(payload.capture.width, 64);
  assert.equal(payload.capture.height, 64);
  assert.ok(payload.capture.capturedAt, "capture time is a required identity field");
  assert.ok(payload.capture.artifactPath, "the immutable capture must be published somewhere");
  assert.ok(fs.existsSync(payload.capture.artifactPath));
  assert.equal(sha256(fs.readFileSync(payload.capture.artifactPath)), payload.capture.sha256);

  assert.ok(device.calls.length > 0, "the injected seam must be the thing that ran");
});

test("identity that could not be observed is explicitly MISSING with a reason, never synthesised", async () => {
  // The device answers pm path with nothing: the installed-APK identity is unobservable. It must
  // NOT fall back to the caller's own apkPath/sha, and the overall status must not be 'observed'.
  const { payload } = await observe({ remoteApkPath: "" }, { label: "missing" });
  assert.equal(payload.identity.installedApk.status, "missing");
  assert.ok(payload.identity.installedApk.reason);
  assert.ok(!("sha256" in payload.identity.installedApk), "a missing field must not carry a value");
  assert.notEqual(payload.status, "observed");
});

// ── fail-closed matrix ─────────────────────────────────────────────────────────────────────────

test("installed APK digest ≠ local APK digest → mismatch, and nothing is launched", async () => {
  const { payload, device } = await observe(
    { remoteApkSha256: "b".repeat(64) },
    { label: "mismatch" },
  );
  assert.equal(payload.status, "mismatch");
  assert.equal(payload.identity.installedApk.sha256, "b".repeat(64));
  assert.ok(payload.reason.includes("b".repeat(64)) || payload.reason.includes("digest"), payload.reason);
  const launched = device.calls.filter((c) => c.args.join(" ").includes("am start") || c.args.join(" ").includes("monkey"));
  assert.deepEqual(launched, [], "a mismatched install must not be launched");
  assert.equal(payload.capture.status, "unavailable");
});

test("a FOREIGN app in the foreground is a conflict with the observed package — and is never stopped", async () => {
  const { payload, device } = await observe(
    { foregroundPackages: ["com.other.incumbent", "com.other.incumbent"] },
    { label: "conflict" },
  );
  assert.equal(payload.status, "conflict");
  assert.equal(payload.conflict.foregroundPackage, "com.other.incumbent");
  assert.ok(payload.conflict.evidence, "the conflict must carry the evidence it was read from");
  assert.equal(payload.identity.foreground.packageName, "com.other.incumbent");

  const stops = device.calls.filter((c) => c.args.join(" ").includes("force-stop"));
  for (const stop of stops) {
    assert.ok(stop.args.join(" ").includes(PACKAGE), `ordinary verification stopped a foreign app: ${stop.args.join(" ")}`);
  }
  assert.deepEqual(
    device.calls.filter((c) => c.args.join(" ").includes("com.other.incumbent")),
    [],
    "the incumbent must never be addressed by any device command",
  );
});

test("a boot identity that changes across the observation is INCONCLUSIVE", async () => {
  // Two boot_id reads bracket the observation: one before install, one after the capture.
  const { payload } = await observe(
    { bootIds: [BOOT_ID, "99999999-0000-0000-0000-000000000000"] },
    { label: "reboot" },
  );
  assert.equal(payload.status, "inconclusive");
  assert.match(payload.reason, /boot/i);
  assert.notEqual(payload.capture.status, "captured", "a frame spanning a reboot is not this observation's frame");
});

test("a PID that changes across the observation is INCONCLUSIVE", async () => {
  const { payload } = await observe({ pids: [PID, 5151] }, { label: "restart-pid" });
  assert.equal(payload.status, "inconclusive");
  assert.match(payload.reason, /PID changed/i);
  assert.notEqual(payload.capture.status, "captured");
});

test("a process START that changes under the SAME PID is INCONCLUSIVE — PID reuse is not continuity", async () => {
  const { payload } = await observe(
    { pids: [PID, PID], startTicks: [START_TICKS, "1000000"] },
    { label: "restart-start" },
  );
  assert.equal(payload.status, "inconclusive");
  assert.match(payload.reason, /start identity changed/i);
  assert.notEqual(payload.capture.status, "captured");
});

test("capture bytes substituted after the observation → tampered, and the frame is not evidence", async () => {
  const root = tempRoot("tamper");
  const { apkPath, sha256: localApkSha256 } = writeApk(root);
  const device = fakeDevice({ localApkSha256 });
  const substituted = readFixture("valid-dark.png");
  let retainedPath = null;
  const handler = handlerFor({
    runTextFn: device.runText,
    runBinaryFn: device.runBinary,
    resolveAdbFn: () => "/fixture/adb",
    sleepFn: async () => {},
    observationRoot: () => path.join(root, "observations"),
    // A retainer that writes DIFFERENT bytes than it was handed. The production read-back must
    // notice, because "the file exists" is not "the file holds the frame I observed".
    retainFn: (input) => {
      const real = retainPicoCliObservation(
        { ...input, artifacts: (input.artifacts ?? []).map((a) => ({ ...a, bytes: substituted })) },
        path.join(root, "observations"),
      );
      retainedPath = real.retained ? real.artifacts[0]?.path : null;
      return real;
    },
  });
  const result = await handler({ apkPath, packageName: PACKAGE, serial: SERIAL, activity: COMPONENT, settleSec: 0 });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, "tampered");
  assert.equal(payload.capture.status, "tampered");
  assert.match(payload.capture.reason, /digest|sha256|differ/i);
  assert.ok(retainedPath, "the fixture retainer must actually have written the substituted bytes");
  assert.equal(sha256(fs.readFileSync(retainedPath)), sha256(substituted));
});

test("a malformed image larger than 1000 bytes is INVALID MEDIA, not a capture", async () => {
  const truncated = readFixture("truncated.png");
  assert.ok(truncated.length > 1000);
  const { payload } = await observe({ captureBytes: truncated }, { label: "malformed" });
  assert.equal(payload.status, "invalid-media");
  assert.equal(payload.capture.status, "invalid");
  assert.ok(payload.capture.reason);
  assert.equal(payload.capture.bytes, truncated.length, "the honest byte count survives the refusal");
});

test("arbitrary nonempty bytes above the size floor are also invalid media", async () => {
  const { payload } = await observe({ captureBytes: readFixture("arbitrary-nonempty.bin") }, { label: "arbitrary" });
  assert.equal(payload.status, "invalid-media");
  assert.equal(payload.capture.status, "invalid");
});

test("a capture that FAILED is capture:'unavailable' and never status ok/observed", async () => {
  const { payload } = await observe(
    { captureCode: 1, captureBytes: Buffer.alloc(0), captureStderr: "device offline" },
    { label: "nocapture" },
  );
  assert.equal(payload.capture.status, "unavailable");
  assert.notEqual(payload.status, "observed");
  assert.notEqual(payload.status, "ok");
  assert.match(payload.capture.reason, /device offline|exit 1|screencap/i);
});

test("a valid DARK frame is an inconclusive capture route, not a rendering failure", async () => {
  const { payload } = await observe({ captureBytes: readFixture("valid-dark.png") }, { label: "dark" });
  assert.equal(payload.capture.status, "captured");
  assert.equal(payload.capture.frame.status, "dark");
  assert.equal(payload.capture.frame.verdict, "inconclusive-capture-route");
  assert.doesNotMatch(JSON.stringify(payload.capture), /render(ing)? (failed|failure)/i);
  assert.equal(payload.status, "observed", "a dark but valid frame is still an observation — the LOOK decides");
});

// ── the ladder closes on identity it never observed (fix round 1) ──────────────────────────────

test("a boot identity that was never observed is INCONCLUSIVE, not a clean observation", async () => {
  // Only the FIRST read fails, so there is no continuity BREAK to report — the gap is that
  // continuity was never established. Before the fix this fell through to status 'observed'.
  const { payload } = await observe({ bootIds: [null, BOOT_ID] }, { label: "noboot" });
  assert.equal(payload.identity.bootId.status, "missing");
  assert.equal(payload.status, "inconclusive");
  assert.match(payload.reason, /boot identity could not be observed/i);
  assert.ok(payload.reason.includes(payload.identity.bootId.reason),
    "the ladder must carry the missing field's own reason, not a paraphrase");
});

test("a foreground that was never observed is INCONCLUSIVE — the frame is unattributable", async () => {
  const { payload } = await observe({ foregroundPackages: [null] }, { label: "nofg" });
  assert.equal(payload.identity.foreground.status, "missing");
  assert.equal(payload.status, "inconclusive");
  assert.match(payload.reason, /foreground could not be observed/i);
  assert.ok(payload.reason.includes(payload.identity.foreground.reason));
  assert.ok(!("conflict" in payload), "no resumed activity is not the same finding as a foreign one");
});

test("an UNKNOWN crash state is INCONCLUSIVE — unknown is not 'no crash'", async () => {
  const { payload } = await observe({ logcatCode: 1, logcat: "" }, { label: "unknowncrash" });
  assert.equal(payload.logs.crash.attributed, null);
  assert.equal(payload.status, "inconclusive");
  assert.match(payload.reason, /unknown is not 'no crash'/);
});

// ── logs ───────────────────────────────────────────────────────────────────────────────────────

test("logcat is never cleared, is bounded, and is scoped to the observed PID", async () => {
  const { payload, device } = await observe({}, { label: "logs" });
  const logcatCalls = device.calls.filter((c) => c.args.includes("logcat"));
  assert.equal(logcatCalls.length, 1, "exactly one bounded log read");
  const args = logcatCalls[0].args;
  assert.ok(!args.includes("-c"), `logcat -c would destroy the device's global log: ${args.join(" ")}`);
  assert.ok(args.includes("-d"), "the log read must not block");
  assert.ok(args.some((a) => a === `--pid=${PID}`), `the log must be scoped to the observed PID: ${args.join(" ")}`);
  const tIndex = args.indexOf("-t");
  assert.ok(tIndex > 0 && Number(args[tIndex + 1]) > 0, `the log must be line-bounded: ${args.join(" ")}`);
  assert.equal(payload.logs.status, "collected");
  assert.equal(payload.logs.scope, "pid");
  assert.ok(payload.logs.path, "the bounded log belongs in the run directory");
  assert.ok(fs.existsSync(payload.logs.path));
});

test("a FATAL with no attribution to this package or PID is NOT this app's crash", async () => {
  const { payload } = await observe(
    {
      pids: [null, null, null],   // no PID: the log cannot be --pid scoped
      logcat: "09-15 10:00:00.000  9001  9001 E AndroidRuntime: FATAL EXCEPTION: main\n"
            + "09-15 10:00:00.001  9001  9001 E AndroidRuntime: Process: com.someone.else\n",
    },
    { label: "foreign-fatal" },
  );
  assert.equal(payload.logs.scope, "unscoped");
  assert.equal(payload.logs.crash.attributed, false,
    "an unattributed global FATAL must never be reported as this package's crash");
  assert.ok(payload.logs.crash.reason);
});

test("a FATAL naming this package IS attributed", async () => {
  const { payload } = await observe(
    {
      pids: [null, null, null],
      logcat: `09-15 10:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main\n`
            + `09-15 10:00:00.001  4242  4242 E AndroidRuntime: Process: ${PACKAGE}, PID: 4242\n`,
    },
    { label: "own-fatal" },
  );
  assert.equal(payload.logs.crash.attributed, true);
  assert.ok(payload.logs.crash.lines.length > 0, "the attributing lines must be returned as the evidence");
  assert.notEqual(payload.status, "observed");
});

test("a log read that fails leaves logs unavailable and never implies 'no crash'", async () => {
  const { payload } = await observe({ logcatCode: 1, logcat: "" }, { label: "nologs" });
  assert.equal(payload.logs.status, "unavailable");
  assert.equal(payload.logs.crash.attributed, null, "unknown is not false");
  assert.notEqual(payload.status, "observed", "an observation that could not read the log is not clean");
});

// ── run directories and paths ──────────────────────────────────────────────────────────────────

test("each observation gets a unique run directory under the observation root, and refuses replacement", async () => {
  const root = tempRoot("rundir");
  const { apkPath, sha256: localApkSha256 } = writeApk(root);
  const observationRoot = path.join(root, "observations");
  const runOnce = async (runId) => {
    const device = fakeDevice({ localApkSha256 });
    const handler = handlerFor({
      runTextFn: device.runText,
      runBinaryFn: device.runBinary,
      resolveAdbFn: () => "/fixture/adb",
      sleepFn: async () => {},
      observationRoot: () => observationRoot,
      ...(runId ? { runIdFn: () => runId } : {}),
    });
    const r = await handler({ apkPath, packageName: PACKAGE, serial: SERIAL, activity: COMPONENT, settleSec: 0 });
    return JSON.parse(r.content[0].text);
  };
  const first = await runOnce();
  const second = await runOnce();
  assert.ok(first.runDirectory && second.runDirectory);
  assert.notEqual(first.runDirectory, second.runDirectory, "two observations must never share a run directory");
  assert.ok(first.runDirectory.startsWith(observationRoot), first.runDirectory);
  assert.match(first.runDirectory, /external-apk-observation/);

  const pinned = await runOnce("pinned-run-id");
  assert.ok(pinned.runDirectory);
  const replayed = await runOnce("pinned-run-id");
  assert.match(JSON.stringify(replayed), /EEXIST|already exists|retention/i,
    "a second observation with the same run id must be refused, not overwrite the first");
});

test("no capture is written to the old mutable package-keyed /tmp path", async () => {
  const { payload } = await observe({}, { label: "notmp" });
  assert.ok(!JSON.stringify(payload).includes("/tmp/pico-render"),
    "the package-keyed mutable /tmp capture path is gone");
  assert.ok(!fs.existsSync(path.join("/tmp/pico-render/verifyapk", `${PACKAGE}.png`)));
});

// ── explicit target identity ───────────────────────────────────────────────────────────────────

test("the serial is REQUIRED — there is no emulator-5554 default to leak into", async () => {
  const root = tempRoot("noserial");
  const { apkPath } = writeApk(root);
  const device = fakeDevice({ localApkSha256: "unused" });
  const handler = handlerFor({
    runTextFn: device.runText,
    runBinaryFn: device.runBinary,
    resolveAdbFn: () => "/fixture/adb",
    sleepFn: async () => {},
    observationRoot: () => path.join(root, "observations"),
  });
  const result = await handler({ apkPath, packageName: PACKAGE, activity: COMPONENT, settleSec: 0 });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, "failed");
  assert.match(payload.reason, /serial/i);
  assert.deepEqual(device.calls, [], "no device command may run without an explicit target");

  // A whitespace-only serial is the case a schema cannot reject, so the handler must.
  const blank = JSON.parse((await handler({ apkPath, packageName: PACKAGE, serial: "   ", settleSec: 0 })).content[0].text);
  assert.equal(blank.status, "failed");
  assert.match(blank.reason, /serial is required/i);
  assert.deepEqual(device.calls, [], "a blank serial must not reach the device either");

  // The schema is the first line of defence (38.0.0): a client omitting `serial` is refused by
  // the protocol, not merely by the handler — the same shape watch_crash and capture_record carry.
  const metadata = {};
  registerVerifyApkTools({ registerTool: (name, meta) => { metadata[name] = meta; } }, {
    runTextFn: device.runText,
    runBinaryFn: device.runBinary,
    resolveAdbFn: () => "/fixture/adb",
    sleepFn: async () => {},
    observationRoot: () => path.join(root, "observations"),
  });
  assert.equal(metadata.verify_pico_apk.inputSchema.serial.isOptional(), false, "serial must be required in the registered schema");
  assert.match(metadata.verify_pico_apk.inputSchema.serial.description, /REQUIRED/);
  assert.match(metadata.verify_pico_apk.inputSchema.serial.description, /no default/i);

  // Both the SOURCE and the shipped build, because tsc erases a doc comment attached to an erased
  // type declaration — so a dist-only check can pass for a reason that has nothing to do with the
  // code. The reserved serial, the old mutable capture path and the log-clear must be absent from
  // what is written as well as from what ships.
  for (const file of ["../src/verifyapk.ts", "../dist/verifyapk.js"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(!source.includes("emulator-5554"), `${file} must not name the reserved serial at all`);
    assert.ok(!source.includes("/tmp/pico-render"), `${file} must not name the old mutable capture path`);
    assert.ok(!source.includes('"logcat", "-c"') && !source.includes("logcat -c"), `${file} must never clear the global log`);
    // EVERY force-stop argv, not just one of them: the old module's second force-stop targeted a
    // foreign incumbent read out of dumpsys, and a "one line matches" check would have allowed it.
    const stopTargets = [...source.matchAll(/"force-stop",\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    assert.ok(stopTargets.length > 0, `${file} should still stop the target package before launch`);
    for (const target of stopTargets) {
      assert.equal(target, "packageName", `${file} force-stops '${target}', which is not the package it was given`);
    }
  }
});

// The same fixed-path defect in its other shape. `capture_canonical` and `emulator_look` are the
// two LOOK captures the agent reads and then cites, and both wrote to one fixed /tmp/pico-render
// file that the next capture overwrote — so record_verification's byte-equality re-capture could be
// comparing against bytes that had already been replaced. Their DEFAULT TARGET is deliberately
// unchanged (emulator-5554 is what these two document and what pico_look drives with no inputs), so
// only the path literal is scanned; src AND dist, for the same reason the loop above reads both.
test("the canonical and emulator LOOK captures name no fixed shared output path", () => {
  for (const file of ["../src/eye.ts", "../dist/eye.js", "../src/emulatorlook.ts", "../dist/emulatorlook.js"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(!source.includes("/tmp/pico-render"), `${file} must not name a fixed shared capture path`);
    assert.ok(source.includes("observationCapturePath"), `${file} must take its default from the shared observation-root helper`);
    assert.ok(source.includes("emulator-5554"), `${file} must keep its documented default target`);
  }
});

// The helper those two and capture_frame now share. One responsibility: a run-unique RETAINED file
// under the observation store, so no capture can overwrite a frame another claim is anchored to.
test("observationCapturePath roots every kind under the observation store and never repeats a run", async () => {
  const { observationCapturePath } = await import("../dist/capturepaths.js");
  const { picoCliObservationRoot } = await import("../dist/picocli.js");
  const home = tempRoot("capture-paths");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const root = picoCliObservationRoot();
    for (const [kind, fileName] of [
      ["capture-frame", "capture_frame.png"],
      ["canonical", "canonical.png"],
      ["emulator-look", "emulator_look.png"],
    ]) {
      const first = observationCapturePath(kind, fileName);
      const second = observationCapturePath(kind, fileName);
      assert.equal(path.basename(first), fileName, `${kind}: the file keeps its name`);
      assert.equal(path.dirname(path.dirname(first)), path.join(root, kind), `${kind}: <root>/<kind>/<runId>/<file>`);
      assert.notEqual(first, second, `${kind}: two captures must not share a path`);
      // The run directory is the same shape retainPicoCliObservation uses: an ISO instant with the
      // punctuation stripped, then a uuid — sortable by time, unique without a lock.
      assert.match(path.basename(path.dirname(first)), /^\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      // Nothing is created by asking for a path: the caller owns the write.
      assert.equal(fs.existsSync(path.dirname(first)), false, `${kind}: naming a path must not create it`);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

// ── the seam is real ───────────────────────────────────────────────────────────────────────────

test("an unresolvable adb is refused before any device command runs", async () => {
  // The real adapter is under test here (resolveAdbFn deliberately NOT injected) while every
  // runner is a loud tripwire. Fixture serial only.
  const reached = [];
  const tripwire = (name) => async (...args) => {
    reached.push(`${name}(${JSON.stringify(args[0])})`);
    throw new Error(`fixture reached a real spawn: ${name}`);
  };
  const root = tempRoot("noadb");
  const { apkPath } = writeApk(root);
  const handler = handlerFor({
    runTextFn: tripwire("runText"),
    runBinaryFn: tripwire("runBinary"),
    sleepFn: async () => {},
    observationRoot: () => path.join(root, "observations"),
  });
  // PICO_ADB is already pinned to a path that does not exist by the module-level barrier above.
  assert.equal(process.env.PICO_ADB, PINNED_FAKE_ADB, "barrier 2 must still be in force");
  const result = await handler({ apkPath, packageName: PACKAGE, serial: "fixture-observe-0002", settleSec: 0 });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, "failed");
  assert.match(payload.reason, new RegExp(PINNED_FAKE_ADB.replace(/\//g, "\\/")));
  assert.deepEqual(reached, [], "the refusal must precede every spawn");
});

test("the loud-runner fixture would actually catch a spawn", async () => {
  // A tripwire nobody proves can fire is decoration. Same consumer, a WORKING resolver, so the
  // very next thing the handler does is reach the injected runner.
  const reached = [];
  const root = tempRoot("tripwire");
  const { apkPath } = writeApk(root);
  const handler = handlerFor({
    runTextFn: async (command, args) => { reached.push([command, ...args].join(" ")); throw new Error("fixture reached a real spawn: runText"); },
    runBinaryFn: async () => { throw new Error("fixture reached a real spawn: runBinary"); },
    resolveAdbFn: () => "/fixture/usable/adb",
    sleepFn: async () => {},
    observationRoot: () => path.join(root, "observations"),
  });
  const result = await handler({ apkPath, packageName: PACKAGE, serial: "fixture-observe-0003", settleSec: 0 });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(reached.length > 0, true, "the tripwire must fire on the first device invocation");
  assert.match(reached[0], /^\/fixture\/usable\/adb /);
  assert.notEqual(payload.status, "observed", "a spawn failure can never read as a clean observation");
});

// ── explicit capture targets (fix round 1) ─────────────────────────────────────────────────────
// capture_frame and capture_record are the other two tools that used to act on whatever device
// happened to be attached. Only their REFUSAL paths are exercised here, and deliberately so: both
// return before they resolve adb or the CLI, so these cases cannot reach a device even by accident.
// Neither tool takes an injectable runner, so calling them WITH a target would reach the real one.

test("capture_frame refuses to capture without an explicit serial, before resolving adb", async () => {
  const { registerCaptureTools } = await import("../dist/capture.js");
  const handlers = {};
  registerCaptureTools({ registerTool: (name, _metadata, fn) => { handlers[name] = fn; } });
  const result = await handlers.capture_frame({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /serial is required/i);
  assert.match(result.content[0].text, /no default target/i);

  const source = fs.readFileSync(new URL("../dist/capture.js", import.meta.url), "utf8");
  assert.ok(!source.includes("emulator-5554"), "capture_frame must not carry a default serial");
  assert.ok(!source.includes("/tmp/pico-render"), "capture_frame must not write to a fixed shared path");
  assert.ok(source.includes("capture-frame"), "the default path must live under the observation root");
});

test("capture_record refuses to record without an explicit device, before any CLI work", async () => {
  const { registerPicoCliTools } = await import("../dist/picoclitools.js");
  const handlers = {};
  const metadata = {};
  registerPicoCliTools({ registerTool: (name, meta, fn) => { metadata[name] = meta; handlers[name] = fn; } });
  const payload = JSON.parse((await handlers.capture_record({ durationSec: 1 })).content[0].text);
  assert.equal(payload.status, "failed");
  assert.match(payload.note, /device is required/i);
  assert.match(payload.note, /no default target/i);
  // `picoCli` provenance only ever appears after a successful ensure, so its absence is evidence
  // the refusal came first: no registry lookup, no provisioning, no managed-store write.
  assert.ok(!("picoCli" in payload), "the refusal must precede CLI resolution entirely");
  // A whitespace-only serial is the case the schema cannot reject, so the handler must.
  const blank = JSON.parse((await handlers.capture_record({ durationSec: 1, device: "   " })).content[0].text);
  assert.equal(blank.status, "failed");
  assert.match(blank.note, /device is required/i);
  assert.ok(!("picoCli" in blank));

  // The schema is the first line of defence (38.0.0): a client omitting `device` is refused by
  // the protocol, not merely by the handler — the same shape watch_crash carries.
  assert.equal(metadata.capture_record.inputSchema.device.isOptional(), false, "device must be required in the registered schema");
  assert.match(metadata.capture_record.inputSchema.device.description, /REQUIRED/);

  const source = fs.readFileSync(new URL("../dist/picoclitools.js", import.meta.url), "utf8");
  assert.ok(!/"-d", device \?\?/.test(source), "capture_record must not fall back to a default device");
  assert.ok(source.includes("capture-record"), "the default recording path must live under the observation root");
});
