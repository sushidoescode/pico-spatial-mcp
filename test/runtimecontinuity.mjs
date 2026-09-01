import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  APPLICATION_CONTINUITY_ADB_PROBE_TIMEOUT_MS,
  APPLICATION_CONTINUITY_HEALTH_MAX_CANDIDATES,
  APPLICATION_CONTINUITY_LOG_MAX_LINES,
  APPLICATION_CONTINUITY_LOG_READ_TIMEOUT_MS,
  APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS,
  APPLICATION_CONTINUITY_WORK_BUDGET_MS,
  BOUNDARY_PROBE_V1_PREFIX,
  SPATIAL_SHELL_RESUMED_COMPONENT,
  classifyBoundaryProbeSequenceV1,
  classifyResumedApplication,
  collectLogWindow,
  formatBoundaryProbeEventV1,
  parseBoundaryProbeEventV1,
  parseBoundaryProbeLogRecordV1,
  parseSpatialRuntimeWatchdog,
  scanPackageRuntimeHealth,
  sampleApplicationContinuity,
} from "../dist/runtimecontinuity.js";

const SERIAL = "emulator-5554";
const BOOT_ID = "12345678-1234-4234-8234-123456789abc";
const PACKAGE = "com.fleet.boundarylabdynamicfull";
const ALLOWED = [
  `${PACKAGE}/.platform.LaunchActivity`,
  `${PACKAGE}/.platform.RouteActivity`,
];
const APK_SHA256 = "a".repeat(64);
const PID = 4242;
const PID_START_TICKS = "987654";
const SESSION_ID = "boundary-session-2026-08-31";

function probeEvent(kind, overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    generation: 3,
    seq: 1,
    monotonicNs: "123456789",
    kind,
    ...overrides,
  };
}

function procStat(pid = PID, startTicks = PID_START_TICKS) {
  return `${pid} (Boundary worker (stage)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${startTicks} 20 21\n`;
}

function foregroundLines(components) {
  return `ACTIVITY MANAGER ACTIVITIES\n${components.map((component, index) =>
    `  topResumedActivity=ActivityRecord{${100 + index} u0 ${component} t${20 + index}}`).join("\n")}\n`;
}

function textResult(stdout = "", overrides = {}) {
  return { code: 0, stdout, stderr: "", timedOut: false, ...overrides };
}

function threadtime(tag, message, second = "01", pid = 1200) {
  return `08-31 12:34:${second}.123  ${pid}  1300 I ${tag}: ${message}`;
}

function runtimeHealthFixture(t, body, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-runtime-health-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactPath = path.join(root, "window.txt");
  fs.writeFileSync(artifactPath, body, { mode: 0o600 });
  const bytes = fs.readFileSync(artifactPath);
  const marker = overrides.marker ?? "boundary_health_marker";
  return {
    status: "collected",
    stopReason: "caller_stop",
    termination: "sigterm",
    truncated: false,
    observedBytes: bytes.length,
    appStartMarker: marker,
    appStartMarkerObserved: body.includes(marker),
    child: {
      pid: 9191,
      startedAtMonotonicNs: "1",
      endedAtMonotonicNs: "2",
      command: "/absolute/adb",
      args: [],
      exitCode: 0,
      signal: null,
    },
    rawArtifact: {
      path: artifactPath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    stderrTail: "",
    ...overrides,
  };
}

test("BoundaryProbe V1 formats and parses every event kind through one exact compact wire prefix", () => {
  const events = [
    probeEvent("command_received"),
    probeEvent("stage_open_requested", { seq: 2, requestedDynamicStageStyle: "Full" }),
    probeEvent("stage_open_returned", { seq: 3, requestedDynamicStageStyle: "Full" }),
    probeEvent("explicit_close_requested", { seq: 4 }),
    probeEvent("explicit_close_returned", { seq: 5 }),
    probeEvent("lifecycle", { seq: 6, lifecycle: "ON_CREATE" }),
    probeEvent("lifecycle", { seq: 7, lifecycle: "ON_START" }),
    probeEvent("lifecycle", { seq: 8, lifecycle: "ON_RESUME" }),
    probeEvent("lifecycle", { seq: 9, lifecycle: "ON_PAUSE" }),
    probeEvent("lifecycle", { seq: 10, lifecycle: "ON_STOP" }),
    probeEvent("lifecycle", { seq: 11, lifecycle: "ON_DESTROY" }),
    probeEvent("focus", { seq: 12, detail: "root=true" }),
  ];

  for (const event of events) {
    const encoded = formatBoundaryProbeEventV1(event);
    assert.ok(encoded.startsWith(BOUNDARY_PROBE_V1_PREFIX));
    assert.equal(encoded.includes("\n"), false);
    assert.equal(encoded, `${BOUNDARY_PROBE_V1_PREFIX}${JSON.stringify(event)}`);
    const rawLine = threadtime("BoundaryProbe", encoded);
    assert.deepEqual(parseBoundaryProbeEventV1(rawLine), {
      status: "ok",
      event,
      rawLine,
    });
  }
});

test("BoundaryProbe parser preserves absent, malformed, truncated, unknown-field, and overlong raw markers", () => {
  const absent = threadtime("OtherTag", "PICO boundary prose only");
  assert.deepEqual(parseBoundaryProbeEventV1(absent), {
    status: "absent",
    event: null,
    rawLine: absent,
  });

  const malformed = `${BOUNDARY_PROBE_V1_PREFIX}${JSON.stringify({
    ...probeEvent("focus"),
    schemaVersion: 2,
  })}`;
  assert.deepEqual(parseBoundaryProbeEventV1(malformed), {
    status: "malformed",
    event: null,
    rawLine: malformed,
  });

  const unknownField = `${BOUNDARY_PROBE_V1_PREFIX}${JSON.stringify({
    ...probeEvent("focus"),
    surprise: true,
  })}`;
  assert.equal(parseBoundaryProbeEventV1(unknownField).status, "malformed");

  const incomplete = `${BOUNDARY_PROBE_V1_PREFIX}{"schemaVersion":1,"sessionId":"${SESSION_ID}"`;
  assert.deepEqual(parseBoundaryProbeEventV1(incomplete), {
    status: "truncated",
    event: null,
    rawLine: incomplete,
  });

  const externallyTruncated = `${BOUNDARY_PROBE_V1_PREFIX}${JSON.stringify(probeEvent("command_received"))}`;
  assert.deepEqual(parseBoundaryProbeEventV1(externallyTruncated, { truncated: true }), {
    status: "truncated",
    event: null,
    rawLine: externallyTruncated,
  });

  const overlong = `${BOUNDARY_PROBE_V1_PREFIX}${JSON.stringify(probeEvent("focus", { detail: "x".repeat(513) }))}`;
  assert.equal(parseBoundaryProbeEventV1(overlong).status, "malformed");
  assert.throws(() => formatBoundaryProbeEventV1(probeEvent("focus", { detail: "x".repeat(513) })), /invalid BoundaryProbe V1 event/i);
});

test("BoundaryProbe raw-record authentication requires the exact tag and currently observed app PID", () => {
  const event = probeEvent("command_received");
  const encoded = formatBoundaryProbeEventV1(event);
  const exact = threadtime("BoundaryProbe", encoded, "01", PID);
  assert.deepEqual(parseBoundaryProbeLogRecordV1(exact, PID), {
    status: "ok",
    event,
    rawLine: exact,
  });

  const wrongTag = threadtime("BoundaryProbeSpoof", encoded, "02", PID);
  assert.deepEqual(parseBoundaryProbeLogRecordV1(wrongTag, PID), {
    status: "malformed",
    event: null,
    rawLine: wrongTag,
  });
  const wrongPid = threadtime("BoundaryProbe", encoded, "03", PID + 1);
  assert.deepEqual(parseBoundaryProbeLogRecordV1(wrongPid, PID), {
    status: "malformed",
    event: null,
    rawLine: wrongPid,
  });
});

test("BoundaryProbe sequence classification exposes complete, gaps, duplicates, expectation drift, and prior-seq state", () => {
  const events = [1, 2, 3].map((seq) => probeEvent(seq === 1 ? "command_received" : "focus", { seq }));
  assert.deepEqual(classifyBoundaryProbeSequenceV1(events, {
    sessionId: SESSION_ID,
    generation: 3,
    priorSeq: 0,
  }), {
    status: "complete",
    priorSeq: 0,
    lastSeq: 3,
    issues: [],
  });

  assert.deepEqual(classifyBoundaryProbeSequenceV1([events[0], events[2]], {
    sessionId: SESSION_ID,
    generation: 3,
    priorSeq: 0,
  }), {
    status: "gap",
    priorSeq: 0,
    lastSeq: 3,
    issues: [{ kind: "gap", expectedSeq: 2, observedSeq: 3 }],
  });

  assert.deepEqual(classifyBoundaryProbeSequenceV1([events[0], events[0]], {
    sessionId: SESSION_ID,
    generation: 3,
    priorSeq: 0,
  }), {
    status: "gap",
    priorSeq: 0,
    lastSeq: 1,
    issues: [{ kind: "duplicate", expectedSeq: 2, observedSeq: 1 }],
  });

  assert.deepEqual(classifyBoundaryProbeSequenceV1([probeEvent("focus", { sessionId: "other-session" })], {
    sessionId: SESSION_ID,
    generation: 3,
    priorSeq: 0,
  }).status, "wrong_session");
  assert.deepEqual(classifyBoundaryProbeSequenceV1([probeEvent("focus", { generation: 4 })], {
    sessionId: SESSION_ID,
    generation: 3,
    priorSeq: 0,
  }).status, "wrong_generation");
  assert.deepEqual(classifyBoundaryProbeSequenceV1([probeEvent("focus", { seq: 8 })], {
    sessionId: SESSION_ID,
    generation: 3,
    priorSeq: null,
  }), {
    status: "unknown",
    priorSeq: null,
    lastSeq: 8,
    issues: [{ kind: "missing_prior", observedSeq: 8 }],
  });
});

test("SpatialRuntimeService watchdog parser classifies only exact raw candidates", () => {
  const advancing = [
    threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) lastRenderTime=165936554`, "01"),
    threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) lastRenderTime=165937555`, "02"),
  ];
  assert.deepEqual(parseSpatialRuntimeWatchdog(advancing), {
    status: "advancing",
    focus: PACKAGE,
    lastRenderTime: "165937555",
    rawLines: advancing,
  });

  const stalled = [
    threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) lastRenderTime=165937555`, "03"),
  ];
  assert.deepEqual(parseSpatialRuntimeWatchdog(stalled, {
    focus: PACKAGE,
    lastRenderTime: "165937555",
  }), {
    status: "stalled",
    focus: PACKAGE,
    lastRenderTime: "165937555",
    rawLines: stalled,
  });
  assert.deepEqual(parseSpatialRuntimeWatchdog([]), { status: "absent", rawLines: [] });

  const prose = `operator note: SpatialRuntimeService Watchdog proves focus=${PACKAGE} lastRenderTime=99`;
  assert.deepEqual(parseSpatialRuntimeWatchdog([prose]), {
    status: "unparsed",
    rawLines: [prose],
  });
  const incomplete = threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) rendering=true`);
  assert.deepEqual(parseSpatialRuntimeWatchdog([incomplete]), {
    status: "unparsed",
    rawLines: [incomplete],
  });
  const mixed = [
    threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) lastRenderTime=10`, "06"),
    threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) lastRenderTime=10`, "07"),
    threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) lastRenderTime=11`, "08"),
  ];
  assert.deepEqual(parseSpatialRuntimeWatchdog(mixed), {
    status: "unparsed",
    focus: PACKAGE,
    lastRenderTime: "11",
    rawLines: mixed,
  });
});

test("foreground classification honors pre-bound components and only the OS 6 co-resumed shell exception", () => {
  assert.deepEqual(classifyResumedApplication(foregroundLines([ALLOWED[0]]), PACKAGE, ALLOWED), {
    resumedComponents: [ALLOWED[0]],
    foreground: "exact_allowed",
  });
  assert.deepEqual(classifyResumedApplication(foregroundLines([ALLOWED[1], SPATIAL_SHELL_RESUMED_COMPONENT]), PACKAGE, ALLOWED), {
    resumedComponents: [ALLOWED[1], SPATIAL_SHELL_RESUMED_COMPONENT],
    foreground: "exact_allowed",
  });

  const unlisted = `${PACKAGE}/.platform.UnboundActivity`;
  assert.deepEqual(classifyResumedApplication(foregroundLines([ALLOWED[0], unlisted]), PACKAGE, ALLOWED), {
    resumedComponents: [ALLOWED[0], unlisted],
    foreground: "same_package_unlisted",
  });
  assert.deepEqual(classifyResumedApplication(foregroundLines([ALLOWED[0], "com.pico.launcher/.Launcher"]), PACKAGE, ALLOWED), {
    resumedComponents: [ALLOWED[0], "com.pico.launcher/.Launcher"],
    foreground: "different_package",
  });
  assert.deepEqual(classifyResumedApplication("mCurrentFocus=null\n", PACKAGE, ALLOWED), {
    resumedComponents: [],
    foreground: "absent",
  });
  assert.deepEqual(classifyResumedApplication("", PACKAGE, ALLOWED, { commandSucceeded: false }), {
    resumedComponents: [],
    foreground: "unknown",
  });
  assert.deepEqual(classifyResumedApplication("arbitrary successful command prose\n", PACKAGE, ALLOWED), {
    resumedComponents: [],
    foreground: "unknown",
  });
});

function continuityFixture(mutation = {}) {
  const apkPath = `/data/app/~~boundary/${PACKAGE}/base.apk`;
  const observedPid = mutation.pid ?? PID;
  const eventLine = threadtime(
    "BoundaryProbe",
    formatBoundaryProbeEventV1(probeEvent("command_received")),
    "01",
    observedPid,
  );
  const watchdogLines = [
    threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) lastRenderTime=101`, "04"),
    threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) lastRenderTime=102`, "05"),
  ];
  const calls = [];
  const runText = async (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    const joined = args.join(" ");
    if (joined.endsWith("cat /proc/sys/kernel/random/boot_id")) return textResult(`${mutation.bootId ?? BOOT_ID}\n`);
    if (joined.includes("shell pm path")) return textResult(`package:${apkPath}\n`);
    if (joined.includes("shell toybox sha256sum")) return textResult(`${mutation.apkSha256 ?? APK_SHA256}  ${apkPath}\n`);
    if (joined.includes("shell pidof")) {
      if (mutation.missingPid) return textResult("", { code: 1 });
      return textResult(`${mutation.pid ?? PID}\n`);
    }
    if (joined.includes("shell cat /proc/")) return textResult(procStat(mutation.pid ?? PID, mutation.pidStartTicks ?? PID_START_TICKS));
    if (joined.endsWith("shell dumpsys activity activities")) {
      return textResult(foregroundLines(mutation.components ?? [ALLOWED[0], SPATIAL_SHELL_RESUMED_COMPONENT]));
    }
    throw new Error(`unexpected adb call: ${command} ${joined}`);
  };
  return {
    input: {
      adbPath: "/opt/android/platform-tools/adb",
      binding: {
        serial: SERIAL,
        bootId: BOOT_ID,
        packageName: PACKAGE,
        apkSha256: APK_SHA256,
        pid: PID,
        pidStartTicks: PID_START_TICKS,
        allowedResumedComponents: ALLOWED,
      },
      probe: { sessionId: SESSION_ID, generation: 3, priorSeq: 0 },
      watchdogPrior: null,
    },
    deps: {
      runText,
      readLogLines: async () => ({
        lines: mutation.logLines ?? [eventLine, ...watchdogLines],
        truncated: mutation.logTruncated ?? false,
      }),
      monotonicNs: () => 222222222n,
    },
    calls,
  };
}

test("application continuity sample binds exact serial, boot, APK, PID/start, pre-bound foreground, probe, and watchdog", async () => {
  const fixture = continuityFixture();
  const sample = await sampleApplicationContinuity(fixture.input, fixture.deps);
  assert.deepEqual(sample, {
    observedAtMonotonicNs: "222222222",
    serial: SERIAL,
    bootId: BOOT_ID,
    packageName: PACKAGE,
    allowedResumedComponents: ALLOWED,
    apkSha256: APK_SHA256,
    pid: PID,
    pidStartTicks: PID_START_TICKS,
    resumedComponents: [ALLOWED[0], SPATIAL_SHELL_RESUMED_COMPONENT],
    foreground: "exact_allowed",
    probeEventsSincePrior: [probeEvent("command_received")],
    probeParse: "ok",
    probeSequence: "complete",
    watchdog: { status: "advancing", focus: PACKAGE, lastRenderTime: "102" },
  });
  assert.ok(fixture.calls.length >= 6);
  for (const call of fixture.calls) assert.deepEqual(call.args.slice(0, 2), ["-s", SERIAL]);
});

test("application continuity reports PID restart, missing process, boot drift, and same-package foreground drift without rebinding", async () => {
  const restarted = continuityFixture({ pid: 5252, pidStartTicks: "999999" });
  const restartedSample = await sampleApplicationContinuity(restarted.input, restarted.deps);
  assert.equal(restartedSample.pid, 5252);
  assert.equal(restartedSample.pidStartTicks, "999999");

  const reusedPid = continuityFixture({ pidStartTicks: "999999" });
  const reusedPidSample = await sampleApplicationContinuity(reusedPid.input, reusedPid.deps);
  assert.equal(reusedPidSample.pid, PID);
  assert.equal(reusedPidSample.pidStartTicks, "999999");

  const missing = continuityFixture({ missingPid: true });
  const missingSample = await sampleApplicationContinuity(missing.input, missing.deps);
  assert.equal(missingSample.pid, null);
  assert.equal(missingSample.pidStartTicks, null);

  const rebooted = continuityFixture({ bootId: "87654321-4321-4321-8321-cba987654321" });
  const rebootedSample = await sampleApplicationContinuity(rebooted.input, rebooted.deps);
  assert.equal(rebootedSample.bootId, "87654321-4321-4321-8321-cba987654321");

  const replaced = continuityFixture({ apkSha256: "b".repeat(64) });
  const replacedSample = await sampleApplicationContinuity(replaced.input, replaced.deps);
  assert.equal(replacedSample.apkSha256, "b".repeat(64));

  const unlisted = `${PACKAGE}/.platform.SurpriseActivity`;
  const drifted = continuityFixture({ components: [unlisted] });
  const driftedSample = await sampleApplicationContinuity(drifted.input, drifted.deps);
  assert.equal(driftedSample.foreground, "same_package_unlisted");
  assert.deepEqual(driftedSample.allowedResumedComponents, ALLOWED);
});

test("application continuity keeps every probe/watchdog no-signal class explicit and source-authenticated", async (t) => {
  const encoded = (event) => formatBoundaryProbeEventV1(event);
  const cases = [
    {
      name: "absent probe and watchdog",
      logLines: [threadtime("OtherTag", "ordinary line", "01", PID)],
      probeParse: "absent",
      probeSequence: "unknown",
      watchdog: "absent",
    },
    {
      name: "malformed probe and unparsed watchdog",
      logLines: [
        threadtime("BoundaryProbe", `${BOUNDARY_PROBE_V1_PREFIX}${JSON.stringify({ ...probeEvent("focus"), schemaVersion: 2 })}`, "01", PID),
        threadtime("SpatialRuntimeService", `Watchdog focus=27(${PACKAGE}) rendering=true`, "02"),
      ],
      probeParse: "malformed",
      probeSequence: "unknown",
      watchdog: "unparsed",
    },
    {
      name: "truncated probe",
      logLines: [threadtime("BoundaryProbe", `${BOUNDARY_PROBE_V1_PREFIX}{"schemaVersion":1`, "01", PID)],
      logTruncated: true,
      probeParse: "truncated",
      probeSequence: "unknown",
      watchdog: "unparsed",
    },
    {
      name: "sequence gap",
      logLines: [threadtime("BoundaryProbe", encoded(probeEvent("focus", { seq: 2 })), "01", PID)],
      probeParse: "ok",
      probeSequence: "gap",
      watchdog: "absent",
    },
    {
      name: "wrong session",
      logLines: [threadtime("BoundaryProbe", encoded(probeEvent("focus", { sessionId: "other-session" })), "01", PID)],
      probeParse: "ok",
      probeSequence: "wrong_session",
      watchdog: "absent",
    },
    {
      name: "wrong generation",
      logLines: [threadtime("BoundaryProbe", encoded(probeEvent("focus", { generation: 4 })), "01", PID)],
      probeParse: "ok",
      probeSequence: "wrong_generation",
      watchdog: "absent",
    },
    {
      name: "wrong tag is not trusted",
      logLines: [threadtime("BoundaryProbeSpoof", encoded(probeEvent("focus")), "01", PID)],
      probeParse: "malformed",
      probeSequence: "unknown",
      watchdog: "absent",
    },
    {
      name: "wrong source PID is not trusted",
      logLines: [threadtime("BoundaryProbe", encoded(probeEvent("focus")), "01", PID + 1)],
      probeParse: "malformed",
      probeSequence: "unknown",
      watchdog: "absent",
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = continuityFixture(fixtureCase);
      const sample = await sampleApplicationContinuity(fixture.input, fixture.deps);
      assert.equal(sample.probeParse, fixtureCase.probeParse);
      assert.equal(sample.probeSequence, fixtureCase.probeSequence);
      assert.equal(sample.watchdog.status, fixtureCase.watchdog);
    });
  }
});

test("application continuity bounds log normalization to a 65,536-line safe prefix", async () => {
  const beyondLimit = threadtime(
    "BoundaryProbe",
    formatBoundaryProbeEventV1(probeEvent("command_received")),
    "09",
    PID,
  );
  const fixture = continuityFixture({
    logLines: [...new Array(65_536).fill("ordinary raw line"), beyondLimit],
  });
  const sample = await sampleApplicationContinuity(fixture.input, fixture.deps);
  assert.equal(sample.probeParse, "truncated");
  assert.deepEqual(sample.probeEventsSincePrior, []);
  assert.equal(sample.probeSequence, "unknown");
  assert.equal(sample.watchdog.status, "unparsed");
});

test("application continuity applies the 64-MiB limit in UTF-8 bytes before parsing logs", async () => {
  const eightMiBUtf8Line = "😀".repeat(2 * 1024 * 1024);
  const beyondLimit = threadtime(
    "BoundaryProbe",
    formatBoundaryProbeEventV1(probeEvent("command_received")),
    "09",
    PID,
  );
  const fixture = continuityFixture({
    logLines: [...new Array(9).fill(eightMiBUtf8Line), beyondLimit],
  });
  const sample = await sampleApplicationContinuity(fixture.input, fixture.deps);
  assert.equal(sample.probeParse, "truncated");
  assert.deepEqual(sample.probeEventsSincePrior, []);
  assert.equal(sample.probeSequence, "unknown");
  assert.equal(sample.watchdog.status, "unparsed");
});

test("application continuity shares the 10-second route reserve and starts independent probes concurrently in two bounded waves", async () => {
  assert.equal(APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS, 10_000);
  assert.ok(APPLICATION_CONTINUITY_ADB_PROBE_TIMEOUT_MS * 2 < APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS);
  const fixture = continuityFixture();
  const calls = [];
  let phase = 1;
  let pending = [];
  const responseFor = (args) => {
    const joined = args.join(" ");
    if (joined.endsWith("cat /proc/sys/kernel/random/boot_id")) return textResult(`${BOOT_ID}\n`);
    if (joined.includes("shell pm path")) return textResult(`package:/data/app/~~boundary/${PACKAGE}/base.apk\n`);
    if (joined.includes("shell pidof")) return textResult(`${PID}\n`);
    if (joined.includes("shell dumpsys activity activities")) return textResult(foregroundLines([ALLOWED[0]]));
    if (joined.includes("shell toybox sha256sum")) return textResult(`${APK_SHA256}  /data/app/~~boundary/${PACKAGE}/base.apk\n`);
    if (joined.includes("shell cat /proc/")) return textResult(procStat());
    throw new Error(`unexpected call ${joined}`);
  };
  fixture.deps.runText = async (command, args, options) => new Promise((resolve) => {
    calls.push({ command, args: [...args], options: { ...options }, phase });
    pending.push({ resolve, args });
    const expected = phase === 1 ? 4 : 2;
    if (pending.length === expected) {
      const wave = pending;
      pending = [];
      phase += 1;
      queueMicrotask(() => wave.forEach((entry) => entry.resolve(responseFor(entry.args))));
    }
  });

  let timeout;
  try {
    await Promise.race([
      sampleApplicationContinuity(fixture.input, fixture.deps),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("probes were serialized")), 250); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(calls.filter((call) => call.phase === 1).length, 4);
  assert.equal(calls.filter((call) => call.phase === 2).length, 2);
  assert.ok(calls.every((call) => call.options.timeoutMs === APPLICATION_CONTINUITY_ADB_PROBE_TIMEOUT_MS));
});

test("application continuity caps a hung log reader and the whole sampler below the shared route reserve", async () => {
  assert.ok(APPLICATION_CONTINUITY_LOG_READ_TIMEOUT_MS < APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS);
  assert.ok(APPLICATION_CONTINUITY_WORK_BUDGET_MS < APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS);

  const hungLog = continuityFixture();
  const logTimers = [];
  hungLog.deps.readLogLines = async () => new Promise(() => {});
  hungLog.deps.setTimer = (callback, ms) => {
    logTimers.push(ms);
    if (ms === APPLICATION_CONTINUITY_LOG_READ_TIMEOUT_MS) queueMicrotask(callback);
    return { ms };
  };
  hungLog.deps.clearTimer = () => {};
  const logBounded = await sampleApplicationContinuity(hungLog.input, hungLog.deps);
  assert.equal(logBounded.bootId, BOOT_ID);
  assert.equal(logBounded.apkSha256, APK_SHA256);
  assert.equal(logBounded.pid, PID);
  assert.equal(logBounded.probeParse, "truncated");
  assert.equal(logBounded.watchdog.status, "unparsed");
  assert.ok(logTimers.includes(APPLICATION_CONTINUITY_LOG_READ_TIMEOUT_MS));

  const hungOverall = continuityFixture();
  const overallTimers = [];
  hungOverall.deps.runText = async () => new Promise(() => {});
  hungOverall.deps.readLogLines = async () => new Promise(() => {});
  hungOverall.deps.setTimer = (callback, ms) => {
    overallTimers.push(ms);
    if (ms === APPLICATION_CONTINUITY_WORK_BUDGET_MS) queueMicrotask(callback);
    return { ms };
  };
  hungOverall.deps.clearTimer = () => {};
  let outside;
  try {
    const sample = await Promise.race([
      sampleApplicationContinuity(hungOverall.input, hungOverall.deps),
      new Promise((_, reject) => { outside = setTimeout(() => reject(new Error("overall sampler deadline missing")), 250); }),
    ]);
    assert.equal(sample.bootId, "");
    assert.equal(sample.pid, null);
    assert.equal(sample.foreground, "unknown");
  } finally {
    clearTimeout(outside);
  }
  assert.ok(overallTimers.includes(APPLICATION_CONTINUITY_WORK_BUDGET_MS));
});

test("application continuity overall timeout prevents late wave one from scheduling digest or stat probes", async () => {
  const fixture = continuityFixture();
  const calls = [];
  const waveOne = [];
  let lateOutputReads = 0;
  fixture.deps.runText = async (_command, args) => new Promise((resolve) => {
    calls.push([...args]);
    waveOne.push({ args: [...args], resolve });
  });
  fixture.deps.readLogLines = async () => ({ lines: [], truncated: false });
  fixture.deps.setTimer = (callback, ms) => {
    if (ms === APPLICATION_CONTINUITY_WORK_BUDGET_MS) queueMicrotask(callback);
    return { ms };
  };
  fixture.deps.clearTimer = () => {};

  const fallback = await sampleApplicationContinuity(fixture.input, fixture.deps);
  assert.equal(fallback.pid, null);
  assert.equal(waveOne.length, 4);
  for (const pending of waveOne) {
    const joined = pending.args.join(" ");
    let stdout;
    if (joined.endsWith("cat /proc/sys/kernel/random/boot_id")) stdout = `${BOOT_ID}\n`;
    else if (joined.includes("shell pm path")) stdout = `package:/data/app/~~boundary/${PACKAGE}/base.apk\n`;
    else if (joined.includes("shell pidof")) stdout = `${PID}\n`;
    else if (joined.includes("shell dumpsys activity activities")) stdout = foregroundLines([ALLOWED[0]]);
    else throw new Error(`unexpected wave-one call: ${joined}`);
    pending.resolve({
      code: 0,
      get stdout() {
        lateOutputReads += 1;
        return stdout;
      },
      stderr: "",
      timedOut: false,
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateOutputReads, 0);
  assert.equal(calls.length, 4);
  assert.equal(calls.some((args) => args.includes("sha256sum") || args.includes(`/proc/${PID}/stat`)), false);
});

test("application continuity clears a timer handle returned after a synchronous timeout callback", async () => {
  const fixture = continuityFixture();
  const cleared = [];
  let nextHandle = 0;
  let workHandle;
  let logDependencyCalls = 0;
  fixture.deps.readLogLines = async () => {
    logDependencyCalls += 1;
    return { lines: [], truncated: false };
  };
  fixture.deps.setTimer = (callback, ms) => {
    const handle = { id: nextHandle += 1, ms };
    if (ms === APPLICATION_CONTINUITY_WORK_BUDGET_MS) {
      workHandle = handle;
      callback();
    }
    return handle;
  };
  fixture.deps.clearTimer = (handle) => { cleared.push(handle); };

  const sample = await sampleApplicationContinuity(fixture.input, fixture.deps);
  assert.equal(sample.pid, null);
  assert.ok(workHandle);
  assert.equal(cleared.includes(workHandle), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.length, 0);
  assert.equal(logDependencyCalls, 0);
});

test("application continuity does not inspect late logs after timing out during wave two", async () => {
  const fixture = continuityFixture();
  const waveTwo = [];
  let logReads = 0;
  let overallTimeout;
  fixture.deps.runText = async (_command, args) => {
    const joined = args.join(" ");
    if (joined.endsWith("cat /proc/sys/kernel/random/boot_id")) return textResult(`${BOOT_ID}\n`);
    if (joined.includes("shell pm path")) return textResult(`package:/data/app/~~boundary/${PACKAGE}/base.apk\n`);
    if (joined.includes("shell pidof")) return textResult(`${PID}\n`);
    if (joined.includes("shell dumpsys activity activities")) return textResult(foregroundLines([ALLOWED[0]]));
    return new Promise((resolve) => { waveTwo.push({ joined, resolve }); });
  };
  fixture.deps.readLogLines = async () => ({
    get lines() {
      logReads += 1;
      return ["late oversized log must remain untouched"];
    },
    truncated: false,
  });
  fixture.deps.setTimer = (callback, ms) => {
    if (ms === APPLICATION_CONTINUITY_WORK_BUDGET_MS) overallTimeout = callback;
    return { ms };
  };
  fixture.deps.clearTimer = () => {};

  const samplePromise = sampleApplicationContinuity(fixture.input, fixture.deps);
  while (waveTwo.length < 2) await new Promise((resolve) => setImmediate(resolve));
  overallTimeout();
  const sample = await samplePromise;
  assert.equal(sample.pid, null);
  for (const pending of waveTwo) {
    pending.resolve(pending.joined.includes("sha256sum")
      ? textResult(`${APK_SHA256}  /data/app/~~boundary/${PACKAGE}/base.apk\n`)
      : textResult(procStat()));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logReads, 0);
});

test("runtime-health scan is marker-bound, exact-package attributed, and fail-closed on ambiguous evidence", (t) => {
  const marker = "boundary_health_marker";
  const markerLine = threadtime("BoundaryExperiment", marker, "01", PID);
  const quiet = runtimeHealthFixture(t, `${threadtime("AndroidRuntime", "FATAL EXCEPTION: pre-marker", "00", PID)}\nProcess: ${PACKAGE}, PID: ${PID}\n${markerLine}\n${threadtime("BoundaryProbe", "healthy", "02", PID)}\n`);
  const quietResult = scanPackageRuntimeHealth(quiet, PACKAGE, [PID]);
  assert.equal(quietResult.status, "no_attributed_failure");
  assert.equal(quietResult.incidents.length, 0);
  assert.ok(quietResult.tagInventory.some((entry) => entry.tag === "BoundaryProbe"));
  const snapshotResult = scanPackageRuntimeHealth({ ...quiet, status: "snapshot_collected" }, PACKAGE, [PID]);
  assert.equal(snapshotResult.status, "no_attributed_failure");
  assert.equal(snapshotResult.sourceSha256, quietResult.sourceSha256);

  for (const [label, body, kind] of [
    ["java", `${markerLine}\n${threadtime("AndroidRuntime", "FATAL EXCEPTION: main", "02", PID)}\nProcess: ${PACKAGE}, PID: ${PID}\n`, "java_crash"],
    ["anr", `${markerLine}\n${threadtime("ActivityManager", `ANR in ${PACKAGE} (pid ${PID})`, "02", 1000)}\n`, "anr"],
    ["native", `${markerLine}\n${threadtime("DEBUG", `Fatal signal 11 (SIGSEGV), PID: ${PID} >>> ${PACKAGE} <<<`, "02", PID)}\n`, "native_crash"],
  ]) {
    const result = scanPackageRuntimeHealth(runtimeHealthFixture(t, body), PACKAGE, [PID]);
    assert.equal(result.status, "attributed_failure", label);
    assert.equal(result.incidents[0].kind, kind);
  }

  const other = scanPackageRuntimeHealth(runtimeHealthFixture(
    t,
    `${markerLine}\n${threadtime("ActivityManager", "ANR in com.fleet.boundarylabdynamicfull2", "02", 1000)}\n`,
  ), PACKAGE, [PID]);
  assert.equal(other.status, "no_attributed_failure");
  assert.equal(other.incidents.length, 0);
  assert.equal(other.ignoredOtherPackageCount, 1);

  const ambiguous = scanPackageRuntimeHealth(runtimeHealthFixture(
    t,
    `${markerLine}\n${threadtime("AndroidRuntime", "FATAL EXCEPTION: unknown owner", "02", 7777)}\n`,
  ), PACKAGE, [PID]);
  assert.equal(ambiguous.status, "inconclusive");
  assert.equal(ambiguous.ambiguousCandidateCount, 1);

  const duplicateMarker = runtimeHealthFixture(t, `${markerLine}\n${markerLine}\n`);
  assert.equal(scanPackageRuntimeHealth(duplicateMarker, PACKAGE, [PID]).status, "inconclusive");
  const truncated = runtimeHealthFixture(t, `${markerLine}\n`, { truncated: true });
  assert.equal(scanPackageRuntimeHealth(truncated, PACKAGE, [PID]).status, "inconclusive");
});

test("runtime-health scans every line in a complete 64-MiB-bounded artifact", (t) => {
  const marker = "boundary_health_marker";
  const markerLine = threadtime("BoundaryExperiment", marker, "01", PID);
  const filler = new Array(APPLICATION_CONTINUITY_LOG_MAX_LINES).fill(
    threadtime("SpatialRuntimeService", "Watchdog: healthy", "02", 1200),
  );
  const quiet = runtimeHealthFixture(t, `${markerLine}\n${filler.join("\n")}\n`);
  assert.equal(scanPackageRuntimeHealth(quiet, PACKAGE, [PID]).status, "no_attributed_failure");

  const crash = runtimeHealthFixture(
    t,
    `${markerLine}\n${filler.join("\n")}\n${threadtime("AndroidRuntime", "FATAL EXCEPTION: main", "03", PID)}\nProcess: ${PACKAGE}, PID: ${PID}\n`,
  );
  const result = scanPackageRuntimeHealth(crash, PACKAGE, [PID]);
  assert.equal(result.status, "attributed_failure");
  assert.equal(result.incidents[0]?.kind, "java_crash");
});

test("runtime-health bounds retained candidates and fails closed when the full scan overflows", (t) => {
  const marker = "boundary_health_marker";
  const otherPackageCandidates = new Array(APPLICATION_CONTINUITY_HEALTH_MAX_CANDIDATES).fill(
    threadtime("ActivityManager", "ANR in com.other.application", "04", 2200),
  );
  const targetBeyondRetention = [
    ...new Array(10).fill(threadtime("SpatialRuntimeService", "Watchdog: healthy", "05", 1200)),
    threadtime("AndroidRuntime", "FATAL EXCEPTION: main", "06", PID),
    `Process: ${PACKAGE}, PID: ${PID}`,
  ];
  const result = scanPackageRuntimeHealth(runtimeHealthFixture(
    t,
    `${threadtime("BoundaryExperiment", marker, "01", PID)}\n${[...otherPackageCandidates, ...targetBeyondRetention].join("\n")}\n`,
  ), PACKAGE, [PID]);
  assert.equal(result.status, "inconclusive");
  assert.equal(result.incidents.length, 0);
  assert.equal(result.ignoredOtherPackageCount, APPLICATION_CONTINUITY_HEALTH_MAX_CANDIDATES);
  assert.equal(result.ambiguousCandidateCount, 1);
});

class FakeLogcatChild extends EventEmitter {
  constructor({ pid = 777, onSignal = () => {} } = {}) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.onSignal = onSignal;
    this.unrefCalls = 0;
  }

  kill(signal) {
    this.signals.push(signal);
    this.onSignal(signal, this);
    return true;
  }

  unref() {
    this.unrefCalls += 1;
  }

  close(code = 0, signal = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function logCollectorFixture(t, child, outputChunks) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-runtime-log-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const artifactPath = path.join(scratch, "step-logcat-all.txt");
  const spawnCalls = [];
  let monotonic = 10n;
  return {
    artifactPath,
    input: {
      adbPath: "/opt/android/platform-tools/adb",
      serial: SERIAL,
      artifactPath,
      appStartMarker: "boundary-start-11111111-2222-4333-8444-555555555555",
      maxDurationMs: 15,
      maxBytes: 1024,
      gracefulTerminationMs: 5,
      forcedTerminationMs: 25,
    },
    deps: {
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args: [...args], options: { ...options } });
        queueMicrotask(() => {
          for (const chunk of outputChunks) child.stdout.write(chunk);
        });
        return child;
      },
      monotonicNs: () => {
        monotonic += 10n;
        return monotonic;
      },
    },
    spawnCalls,
  };
}

function realPublicationFs(overrides = {}) {
  return {
    fsyncSync: (...args) => fs.fsyncSync(...args),
    fstatSync: (...args) => fs.fstatSync(...args),
    linkSync: (...args) => fs.linkSync(...args),
    openSync: (...args) => fs.openSync(...args),
    readSync: (...args) => fs.readSync(...args),
    closeSync: (...args) => fs.closeSync(...args),
    lstatSync: (...args) => fs.lstatSync(...args),
    unlinkSync: (...args) => fs.unlinkSync(...args),
    ...overrides,
  };
}

function assertConfirmedChildDetached(child) {
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdout.listenerCount("error"), 0);
  assert.equal(child.stderr.listenerCount("error"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefCalls, 0);
}

test("log collector owns one exact adb child, ends it gracefully at the time cap, and atomically publishes mode-0600 bytes", async (t) => {
  const child = new FakeLogcatChild({
    onSignal: (signal, instance) => {
      if (signal === "SIGTERM") queueMicrotask(() => instance.close(0, null));
    },
  });
  const fixture = logCollectorFixture(t, child, [Buffer.from("first raw line\nsecond raw line\n")]);
  const receipt = await collectLogWindow(fixture.input, fixture.deps);

  assert.equal(fixture.spawnCalls.length, 1);
  assert.deepEqual(fixture.spawnCalls[0], {
    command: fixture.input.adbPath,
    args: ["-s", SERIAL, "logcat", "-b", "all", "-v", "threadtime"],
    options: { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  });
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(receipt.status, "collected");
  assert.equal(receipt.stopReason, "duration_cap");
  assert.equal(receipt.termination, "sigterm");
  assert.equal(receipt.truncated, false);
  assert.equal(receipt.child.pid, 777);
  assert.equal(receipt.appStartMarker, fixture.input.appStartMarker);
  assert.equal(receipt.appStartMarkerObserved, false);
  assert.equal(receipt.rawArtifact.path, fs.realpathSync(fixture.artifactPath));
  assert.equal(receipt.rawArtifact.bytes, Buffer.byteLength("first raw line\nsecond raw line\n"));
  assert.equal(receipt.rawArtifact.sha256, crypto.createHash("sha256").update(fs.readFileSync(fixture.artifactPath)).digest("hex"));
  assert.equal(fs.statSync(fixture.artifactPath).mode & 0o777, 0o600);
  assertConfirmedChildDetached(child);
});

test("log collector exposes a synchronous owned-child start barrier and caller-controlled stop receipt", async (t) => {
  const child = new FakeLogcatChild({
    onSignal: (signal, instance) => {
      if (signal === "SIGTERM") queueMicrotask(() => instance.close(0, null));
    },
  });
  const fixture = logCollectorFixture(t, child, [Buffer.from("boundary-start-11111111-2222-4333-8444-555555555555\n")]);
  fixture.input.maxDurationMs = 500;
  const controller = new AbortController();
  let started = false;
  fixture.input.stopSignal = controller.signal;
  fixture.input.onStarted = () => {
    started = true;
    queueMicrotask(() => controller.abort());
  };
  const promise = collectLogWindow(fixture.input, fixture.deps);
  assert.equal(started, true);
  const receipt = await promise;
  assert.equal(receipt.status, "collected");
  assert.equal(receipt.stopReason, "caller_stop");
  assert.equal(receipt.appStartMarkerObserved, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assertConfirmedChildDetached(child);
});

test("log publisher neither reads nor unlinks a target replacement swapped in after hard-link publication", async (t) => {
  const child = new FakeLogcatChild();
  const fixture = logCollectorFixture(t, child, [Buffer.from("owned evidence\n")]);
  fixture.input.maxDurationMs = 500;
  const displacedOwnedLink = path.join(path.dirname(fixture.artifactPath), "displaced-owned-link.txt");
  const checkedTarget = path.join(
    fs.realpathSync(path.dirname(fixture.artifactPath)),
    path.basename(fixture.artifactPath),
  );
  const replacement = Buffer.from("attacker replacement must remain untouched\n");
  const readCalls = [];
  const unlinkCalls = [];
  let targetDescriptor = null;
  fixture.deps.publicationFs = realPublicationFs({
    linkSync: (source, target) => {
      fs.linkSync(source, target);
      fs.renameSync(target, displacedOwnedLink);
      fs.writeFileSync(target, replacement, { mode: 0o600 });
    },
    openSync: (...args) => {
      targetDescriptor = fs.openSync(...args);
      return targetDescriptor;
    },
    readSync: (...args) => {
      readCalls.push(args[0]);
      return fs.readSync(...args);
    },
    unlinkSync: (target) => {
      unlinkCalls.push(target);
      fs.unlinkSync(target);
    },
  });
  queueMicrotask(() => queueMicrotask(() => child.close(0, null)));

  await assert.rejects(
    collectLogWindow(fixture.input, fixture.deps),
    /changed|identity|owned artifact/i,
  );
  assert.ok(Number.isInteger(targetDescriptor));
  assert.equal(readCalls.includes(targetDescriptor), false);
  assert.equal(unlinkCalls.includes(checkedTarget), false);
  assert.deepEqual(fs.readFileSync(fixture.artifactPath), replacement);
});

test("log publisher rejects a receipt when its temporary hard link cannot be removed", async (t) => {
  const child = new FakeLogcatChild();
  const fixture = logCollectorFixture(t, child, [Buffer.from("cleanup must be confirmed\n")]);
  fixture.input.maxDurationMs = 500;
  const unlinkAttempts = [];
  fixture.deps.publicationFs = realPublicationFs({
    unlinkSync: (filePath) => {
      unlinkAttempts.push(filePath);
      throw new Error("simulated temporary unlink failure");
    },
  });
  queueMicrotask(() => queueMicrotask(() => child.close(0, null)));

  await assert.rejects(
    collectLogWindow(fixture.input, fixture.deps),
    /raw staging artifact absence could not be proven.*temporary unlink failure/i,
  );
  assert.ok(unlinkAttempts.some((filePath) => path.basename(filePath).endsWith(".tmp")));
  assert.equal(fs.readFileSync(fixture.artifactPath, "utf8"), "cleanup must be confirmed\n");
});

test("log publisher rejects same-inode special mode bits instead of masking them to 0600", async (t) => {
  const child = new FakeLogcatChild();
  const fixture = logCollectorFixture(t, child, [Buffer.from("private mode evidence\n")]);
  fixture.input.maxDurationMs = 500;
  fixture.deps.publicationFs = realPublicationFs({
    linkSync: (source, target) => {
      fs.linkSync(source, target);
      fs.chmodSync(target, 0o4600);
    },
  });
  queueMicrotask(() => queueMicrotask(() => child.close(0, null)));

  await assert.rejects(
    collectLogWindow(fixture.input, fixture.deps),
    /mode|private regular file|changed/i,
  );
  assert.equal((fs.lstatSync(fixture.artifactPath).mode & 0o7000) !== 0, true);
});

test("log collector retains the exact byte-cap prefix and escalates only its own TERM-ignoring child to KILL", async (t) => {
  const child = new FakeLogcatChild({
    onSignal: (signal, instance) => {
      if (signal === "SIGKILL") queueMicrotask(() => instance.close(null, "SIGKILL"));
    },
  });
  const fixture = logCollectorFixture(t, child, [Buffer.from("1234"), Buffer.from("567890")]);
  fixture.input.maxBytes = 7;
  fixture.input.maxDurationMs = 500;
  const receipt = await collectLogWindow(fixture.input, fixture.deps);

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(receipt.status, "collected");
  assert.equal(receipt.stopReason, "byte_cap");
  assert.equal(receipt.termination, "sigkill");
  assert.equal(receipt.truncated, true);
  assert.equal(receipt.observedBytes, 10);
  assert.equal(receipt.rawArtifact.bytes, 7);
  assert.equal(fs.readFileSync(fixture.artifactPath, "utf8"), "1234567");
});

test("log collector rejects repository paths before spawning and preserves natural early child exit", async (t) => {
  let spawnCalls = 0;
  await assert.rejects(
    collectLogWindow({
      adbPath: "/opt/android/platform-tools/adb",
      serial: SERIAL,
      artifactPath: path.join(process.cwd(), "forbidden-log.txt"),
      appStartMarker: "boundary-start-safe",
      maxDurationMs: 10,
      maxBytes: 1024,
      gracefulTerminationMs: 5,
      forcedTerminationMs: 5,
    }, {
      spawn: () => { spawnCalls += 1; throw new Error("must not spawn"); },
      monotonicNs: () => 1n,
    }),
    /inside the repository/i,
  );
  assert.equal(spawnCalls, 0);

  const child = new FakeLogcatChild();
  const fixture = logCollectorFixture(t, child, [
    Buffer.from("prefix boundary-start-11111111-2222-"),
    Buffer.from("4333-8444-555555555555 suffix\n"),
  ]);
  fixture.input.maxDurationMs = 500;
  queueMicrotask(() => queueMicrotask(() => child.close(0, null)));
  const receipt = await collectLogWindow(fixture.input, fixture.deps);
  assert.equal(receipt.stopReason, "child_exit");
  assert.equal(receipt.termination, "not_needed");
  assert.equal(receipt.appStartMarkerObserved, true);
  assert.deepEqual(child.signals, []);
  assertConfirmedChildDetached(child);
});

test("log collector publishes partial evidence when its exact owned child remains unconfirmed after KILL", async (t) => {
  const child = new FakeLogcatChild();
  const fixture = logCollectorFixture(t, child, [Buffer.from("partial-before-stall\n")]);
  fixture.input.maxDurationMs = 5;
  fixture.input.gracefulTerminationMs = 5;
  fixture.input.forcedTerminationMs = 5;
  const receipt = await collectLogWindow(fixture.input, fixture.deps);
  assert.equal(receipt.status, "teardown_unconfirmed");
  assert.equal(receipt.termination, "unconfirmed");
  assert.equal(receipt.truncated, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(fs.readFileSync(fixture.artifactPath, "utf8"), "partial-before-stall\n");
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.unrefCalls, 1);
  assert.doesNotThrow(() => child.stdout.emit("error", new Error("late stdout error")));
  assert.doesNotThrow(() => child.stderr.emit("error", new Error("late stderr error")));
  assert.doesNotThrow(() => child.emit("error", new Error("late unkillable child error")));
});

test("log collector fails closed on an invalid child PID and retains asynchronous spawn-error bytes", async (t) => {
  const invalid = new FakeLogcatChild({
    pid: null,
    onSignal: (signal, instance) => {
      if (signal === "SIGTERM") queueMicrotask(() => instance.close(null, "SIGTERM"));
    },
  });
  const invalidFixture = logCollectorFixture(t, invalid, [Buffer.from("invalid-pid-child\n")]);
  invalidFixture.input.maxDurationMs = 500;
  const invalidReceipt = await collectLogWindow(invalidFixture.input, invalidFixture.deps);
  assert.equal(invalidReceipt.status, "spawn_failed");
  assert.equal(invalidReceipt.child.pid, null);
  assert.notEqual(invalidReceipt.status, "collected");
  assert.deepEqual(invalid.signals, ["SIGTERM"]);

  const errored = new FakeLogcatChild();
  const errorFixture = logCollectorFixture(t, errored, [Buffer.from("before-error\n")]);
  errorFixture.input.maxDurationMs = 500;
  queueMicrotask(() => {
    errored.emit("error", new Error("spawn stream failed"));
    queueMicrotask(() => errored.close(1, null));
  });
  const errorReceipt = await collectLogWindow(errorFixture.input, errorFixture.deps);
  assert.equal(errorReceipt.status, "spawn_failed");
  assert.equal(fs.readFileSync(errorFixture.artifactPath, "utf8"), "before-error\n");
});

test("missing-PID ownership dominates unconfirmed teardown while retaining the partial artifact", async (t) => {
  const child = new FakeLogcatChild({ pid: null });
  const fixture = logCollectorFixture(t, child, [Buffer.from("pidless-partial\n")]);
  fixture.input.maxDurationMs = 500;
  fixture.input.gracefulTerminationMs = 5;
  fixture.input.forcedTerminationMs = 5;
  const receipt = await collectLogWindow(fixture.input, fixture.deps);
  assert.equal(receipt.status, "spawn_failed");
  assert.equal(receipt.termination, "unconfirmed");
  assert.equal(receipt.child.pid, null);
  assert.equal(receipt.truncated, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(fs.readFileSync(fixture.artifactPath, "utf8"), "pidless-partial\n");
  child.close(null, "SIGKILL");
});

test("log collector removes private staging if its initial monotonic sample is invalid", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-runtime-log-clock-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  let spawns = 0;
  await assert.rejects(collectLogWindow({
    adbPath: "/opt/android/platform-tools/adb",
    serial: SERIAL,
    artifactPath: path.join(scratch, "clock.txt"),
    appStartMarker: "clock-invalid",
    maxDurationMs: 10,
  }, {
    spawn: () => { spawns += 1; throw new Error("must not spawn"); },
    monotonicNs: () => -1n,
  }), /monotonic clock/i);
  assert.equal(spawns, 0);
  assert.deepEqual(fs.readdirSync(scratch), []);
});
