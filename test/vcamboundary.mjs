// v29.1 host-camera source-readback boundary report: fail-closed state model + orchestration.
// Run: npm run test:vcamboundary
// Pure and platform-independent — no camera, Immersed, emulator, TCC, GUI, FFmpeg, or OBS.
import assert from "node:assert/strict";
import test from "node:test";

const sutUrl = new URL("../dist/vcamboundary.js", import.meta.url);
const loadSut = () => import(sutUrl.href);

const MANIFEST_SHA256 = "d3f6c4869a4804ef95cd80f8a12a5b4c0511b3dfc1c3c5bc2454da02a1751d4f";
const IMMERSED_UUID = "A1EA3EF8-F9D5-4BA7-827E-A26C1B27BEA2";
const READER_SHA256 = "1111111111111111111111111111111111111111111111111111111111111111";
const PRODUCER_SHA256 = "2222222222222222222222222222222222222222222222222222222222222222";
const CAP_SHA_A = "3333333333333333333333333333333333333333333333333333333333333333";
const CAP_SHA_B = "4444444444444444444444444444444444444444444444444444444444444444";

function artifact(overrides = {}) {
  return { path: "/run/vcam/avf-capture-00.png", bytes: 1024, sha256: CAP_SHA_A, ...overrides };
}

// A realistic, fully-valid v29.1 outcome: the host gate passed through AVFoundation with two
// distinct counters; the direct-CMIO branch is blocked on its ownership contract (a sibling, not a
// blocker); the qemu-adjacent route is not attempted this stage. Every rule below is exercised by
// mutating exactly one field of this baseline.
function baseReport() {
  let clock = 1_000;
  const span = () => ({ startedAtMs: (clock += 10), endedAtMs: (clock += 10) });
  return {
    runId: "vcam-v29.1-20260724-AB12",
    source: {
      manifestPath: "/run/vcam/manifest.json",
      manifestSha256: MANIFEST_SHA256,
      nonce: "VCAM-20260724-AB12",
      width: 1280,
      height: 720,
      pixelFormat: "BGRA",
    },
    device: { name: "Immersed Camera", uuid: IMMERSED_UUID },
    reader: { executable: "/run/vcam/bin/cmio-camera-reader", argv: ["--authorization-only"], sha256: READER_SHA256 },
    producer: { executable: "/run/vcam/bin/cmio-camera-writer", argv: ["--device-uid", IMMERSED_UUID], sha256: PRODUCER_SHA256 },
    stages: {
      source: { state: "passed", ...span() },
      cmioSink: { state: "passed", ...span() },
      cmioAuthorization: { state: "passed", authStatus: "authorized", ...span() },
      cmioSource: { state: "blocked", delivery: "none", error: "CMIO input-sample ownership contract unresolved", ...span() },
      avfAuthorization: { state: "passed", authStatus: "authorized", ...span() },
      avFoundation: {
        state: "passed",
        delivery: "changing",
        recognizedCounters: [0, 1],
        artifacts: [artifact({ path: "/run/vcam/avf-00.png", sha256: CAP_SHA_A }), artifact({ path: "/run/vcam/avf-01.png", sha256: CAP_SHA_B })],
        ...span(),
      },
      qemuAuthorization: { state: "skipped", ...span() },
      emulatorRoute: { state: "skipped", ...span() },
      cameraPeek: { state: "skipped", ...span() },
    },
  };
}

// Deep clone so a per-test mutation cannot leak into another test's baseline.
const clone = (value) => JSON.parse(JSON.stringify(value));

test("the canonical v29.1 host-gate report validates and is returned frozen", async () => {
  const { validateBoundaryReport } = await loadSut();
  const report = baseReport();
  const validated = validateBoundaryReport(report);
  assert.equal(validated.runId, report.runId);
  assert.equal(validated.stages.avFoundation.state, "passed");
  assert.ok(Object.isFrozen(validated), "a validated report is frozen against later mutation");
  assert.ok(Object.isFrozen(validated.stages), "stage map is frozen");
  assert.ok(Object.isFrozen(validated.stages.avFoundation), "each stage is frozen");
});

test("the four terminal states are the only accepted stage states", async () => {
  const { validateBoundaryReport, STAGE_IDS } = await loadSut();
  assert.deepEqual(
    [...STAGE_IDS],
    ["source", "cmioSink", "cmioAuthorization", "cmioSource", "avfAuthorization", "avFoundation", "qemuAuthorization", "emulatorRoute", "cameraPeek"],
    "the stage DAG is exactly the nine v29.1 boundaries in dependency order",
  );
  for (const bad of ["pass", "PASSED", "error", "ok", "pending", "", null, 1]) {
    const report = clone(baseReport());
    report.stages.source.state = bad;
    assert.throws(() => validateBoundaryReport(report), /state/i, `state ${JSON.stringify(bad)} must be rejected`);
  }
});

test("a report with an unknown or missing stage is rejected", async () => {
  const { validateBoundaryReport } = await loadSut();
  const extra = clone(baseReport());
  extra.stages.somethingElse = { state: "passed", startedAtMs: 1, endedAtMs: 2 };
  assert.throws(() => validateBoundaryReport(extra), /unknown stage|somethingElse/i);
  const missing = clone(baseReport());
  delete missing.stages.cameraPeek;
  assert.throws(() => validateBoundaryReport(missing), /missing stage|cameraPeek/i);
});

test("run id, source identity, and exact 1280x720 BGRA source format are required", async () => {
  const { validateBoundaryReport } = await loadSut();
  const mutate = (fn) => { const r = clone(baseReport()); fn(r); return r; };
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.runId = ""; })), /run.?id/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.source.manifestPath = "relative/manifest.json"; })), /absolute|manifest/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.source.manifestSha256 = "abc"; })), /sha-?256/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.source.nonce = ""; })), /nonce/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.source.width = 1920; })), /1280|720|BGRA|format/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.source.height = 1080; })), /1280|720|BGRA|format/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.source.pixelFormat = "BGR4"; })), /1280|720|BGRA|format/i);
});

test("exact device identity requires a name and a case-normalized UUID", async () => {
  const { validateBoundaryReport } = await loadSut();
  const mutate = (fn) => { const r = clone(baseReport()); fn(r); return r; };
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.device.name = ""; })), /device.*name/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.device.uuid = "not-a-uuid"; })), /uuid/i);
  assert.throws(
    () => validateBoundaryReport(mutate((r) => { r.device.uuid = IMMERSED_UUID.toLowerCase(); })),
    /uuid.*normal|normal.*uuid|uppercase/i,
    "identity must be stored case-normalized, not as a raw lowercase observation",
  );
});

test("reader and producer executable/argv/hash provenance is required", async () => {
  const { validateBoundaryReport } = await loadSut();
  const mutate = (fn) => { const r = clone(baseReport()); fn(r); return r; };
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.reader.executable = "cmio-camera-reader"; })), /absolute|executable/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.reader.sha256 = "xyz"; })), /sha-?256/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.reader.argv = "not-an-array"; })), /argv/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { delete r.producer; })), /producer/i);
});

test("stage timestamps must be finite and endedAtMs must not precede startedAtMs", async () => {
  const { validateBoundaryReport } = await loadSut();
  const mutate = (fn) => { const r = clone(baseReport()); fn(r); return r; };
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.source.startedAtMs = Number.NaN; })), /finite|timestamp/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.source.endedAtMs = Infinity; })), /finite|timestamp/i);
  assert.throws(
    () => validateBoundaryReport(mutate((r) => { r.stages.avFoundation.endedAtMs = r.stages.avFoundation.startedAtMs - 1; })),
    /monoton|ended|before|order/i,
  );
});

test("a reached stage cannot start before its prerequisite finished", async () => {
  const { validateBoundaryReport } = await loadSut();
  const report = clone(baseReport());
  // avFoundation is reached (passed); pull its start before avfAuthorization's end.
  report.stages.avFoundation.startedAtMs = report.stages.avfAuthorization.startedAtMs - 5;
  report.stages.avFoundation.endedAtMs = report.stages.avfAuthorization.startedAtMs - 1;
  assert.throws(() => validateBoundaryReport(report), /monoton|order|prerequisite|before/i);
});

test("a stage may only be passed when every prerequisite passed", async () => {
  const { validateBoundaryReport } = await loadSut();
  const report = clone(baseReport());
  // avfAuthorization is blocked (denied), but avFoundation still claims passed — a dependent pass
  // after a required prerequisite non-pass, which must be rejected.
  const span = { startedAtMs: report.stages.avfAuthorization.startedAtMs, endedAtMs: report.stages.avfAuthorization.endedAtMs };
  report.stages.avfAuthorization = { state: "blocked", authStatus: "denied", ...span };
  assert.throws(() => validateBoundaryReport(report), /prerequisite|depend|passed|skipped/i);
});

test("a stage whose prerequisite did not pass must be skipped, not failed or blocked", async () => {
  const { validateBoundaryReport } = await loadSut();
  const base = clone(baseReport());
  // Make cmioSink fail; then its dependents must all be skipped.
  base.stages.cmioSink = { state: "failed", error: "sink enqueue faulted", startedAtMs: base.stages.cmioSink.startedAtMs, endedAtMs: base.stages.cmioSink.endedAtMs };
  const skipDependents = (r) => {
    for (const id of ["cmioAuthorization", "cmioSource", "avfAuthorization", "avFoundation", "qemuAuthorization", "emulatorRoute", "cameraPeek"]) {
      r.stages[id] = { state: "skipped", startedAtMs: r.stages[id].startedAtMs, endedAtMs: r.stages[id].endedAtMs };
    }
  };
  const skipped = clone(base);
  skipDependents(skipped);
  assert.doesNotThrow(() => validateBoundaryReport(skipped), "all dependents skipped after a sink failure is a valid report");

  const stillReached = clone(base);
  skipDependents(stillReached);
  // avFoundation depends on the failed sink; it may not be reached (failed/blocked), only skipped.
  stillReached.stages.avFoundation = { state: "failed", delivery: "none", recognizedCounters: [], error: "read attempted despite a failed sink", startedAtMs: stillReached.stages.avFoundation.startedAtMs, endedAtMs: stillReached.stages.avFoundation.endedAtMs };
  assert.throws(() => validateBoundaryReport(stillReached), /skipped|prerequisite|depend/i, "a readback cannot be reached when its sink prerequisite failed");
});

test("a CMIO-branch non-pass never suppresses or invalidates a safe AVFoundation branch", async () => {
  const { validateBoundaryReport } = await loadSut();
  for (const cmioSource of [
    { state: "blocked", delivery: "none", error: "ownership contract unresolved" },
    { state: "failed", delivery: "none", recognizedCounters: [], error: "no CMIO input stream" },
    { state: "skipped" },
    { state: "failed", delivery: "static", recognizedCounters: [7], error: "one static counter only" },
  ]) {
    const report = clone(baseReport());
    const span = { startedAtMs: report.stages.cmioSource.startedAtMs, endedAtMs: report.stages.cmioSource.endedAtMs };
    report.stages.cmioSource = { ...cmioSource, ...span };
    const validated = validateBoundaryReport(report);
    assert.equal(validated.stages.avFoundation.state, "passed", `AVFoundation stays passed while cmioSource is ${cmioSource.state}`);
    assert.equal(validated.stages.cmioSource.state, cmioSource.state);
  }
});

test("authorization states other than authorized produce blocked, never failed", async () => {
  const { validateBoundaryReport } = await loadSut();
  for (const status of ["notDetermined", "denied", "restricted"]) {
    const report = clone(baseReport());
    // If the shared executable is not authorized, both reader branches block and downstream skips.
    const skip = (id) => { report.stages[id] = { state: "skipped", startedAtMs: report.stages[id].startedAtMs, endedAtMs: report.stages[id].endedAtMs }; };
    report.stages.cmioAuthorization = { state: "blocked", authStatus: status, startedAtMs: report.stages.cmioAuthorization.startedAtMs, endedAtMs: report.stages.cmioAuthorization.endedAtMs };
    report.stages.avfAuthorization = { state: "blocked", authStatus: status, startedAtMs: report.stages.avfAuthorization.startedAtMs, endedAtMs: report.stages.avfAuthorization.endedAtMs };
    skip("cmioSource");
    skip("avFoundation");
    skip("qemuAuthorization");
    skip("emulatorRoute");
    skip("cameraPeek");
    assert.doesNotThrow(() => validateBoundaryReport(report), `${status} authorization blocks both branches cleanly`);

    const asFailed = clone(report);
    asFailed.stages.avfAuthorization = { state: "failed", authStatus: status, startedAtMs: report.stages.avfAuthorization.startedAtMs, endedAtMs: report.stages.avfAuthorization.endedAtMs };
    assert.throws(() => validateBoundaryReport(asFailed), /authoriz|blocked|failed/i, "an authorization stage may never be failed");
  }
});

test("an authorized authorization stage must be passed and a non-authorized one must be blocked", async () => {
  const { validateBoundaryReport } = await loadSut();
  const mutate = (fn) => { const r = clone(baseReport()); fn(r); return r; };
  assert.throws(
    () => validateBoundaryReport(mutate((r) => { r.stages.avfAuthorization.authStatus = "denied"; })),
    /authoriz|blocked|passed/i,
    "authorized-passed cannot carry a non-authorized status",
  );
  assert.throws(
    () => validateBoundaryReport(mutate((r) => {
      // Skip the dependent so the dependency loop passes and the auth-consistency rule actually
      // fires (regression: previously the dependency loop threw first, making this vacuous).
      r.stages.avfAuthorization = { state: "blocked", authStatus: "authorized", startedAtMs: r.stages.avfAuthorization.startedAtMs, endedAtMs: r.stages.avfAuthorization.endedAtMs };
      r.stages.avFoundation = { state: "skipped", startedAtMs: r.stages.avFoundation.startedAtMs, endedAtMs: r.stages.avFoundation.endedAtMs };
    })),
    /authorization stage avfAuthorization is authorized but not passed/i,
    "a blocked auth stage cannot claim authorized",
  );
});

test("a changing-card readback pass requires at least two recognized distinct counters", async () => {
  const { validateBoundaryReport } = await loadSut();
  const mutate = (fn) => { const r = clone(baseReport()); fn(r); return r; };
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.avFoundation.recognizedCounters = [3]; })), /two|distinct|counter/i);
  assert.throws(
    () => validateBoundaryReport(mutate((r) => { r.stages.avFoundation.recognizedCounters = [5, 5]; })),
    /two|distinct|counter|duplicate/i,
    "duplicate counters cannot satisfy the two-distinct-counter changing-card bar",
  );
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.avFoundation.recognizedCounters = []; })), /counter/i);
});

test("a passed readback must be a changing delivery and carry at least two captures", async () => {
  const { validateBoundaryReport } = await loadSut();
  const mutate = (fn) => { const r = clone(baseReport()); fn(r); return r; };
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.avFoundation.delivery = "static"; })), /changing|passed|delivery/i);
  assert.throws(
    () => validateBoundaryReport(mutate((r) => { r.stages.avFoundation.artifacts = [artifact()]; })),
    /two|captures?|artifacts?/i,
    "a changing-card pass needs two retained captures showing the two counters",
  );
});

test("a single recognizable counter earns only a static-delivery result and never a pass", async () => {
  const { validateBoundaryReport } = await loadSut();
  const staticResult = clone(baseReport());
  staticResult.stages.avFoundation = {
    state: "failed",
    delivery: "static",
    recognizedCounters: [4],
    artifacts: [artifact()],
    error: "static delivery only; liveness did not pass",
    startedAtMs: staticResult.stages.avFoundation.startedAtMs,
    endedAtMs: staticResult.stages.avFoundation.endedAtMs,
  };
  // downstream already skipped in the baseline
  assert.doesNotThrow(() => validateBoundaryReport(staticResult), "state=failed + delivery=static + one counter is the honest static-delivery record");

  const staticButPassed = clone(staticResult);
  staticButPassed.stages.avFoundation.state = "passed";
  assert.throws(() => validateBoundaryReport(staticButPassed), /static|changing|passed|counter/i, "a static card can never be a changing-delivery pass");
});

test("delivery=changing is reserved for a passed readback and cannot label a non-pass", async () => {
  const { validateBoundaryReport } = await loadSut();
  const report = clone(baseReport());
  report.stages.avFoundation = {
    state: "failed",
    delivery: "changing",
    recognizedCounters: [0, 1],
    artifacts: [artifact({ sha256: CAP_SHA_A }), artifact({ sha256: CAP_SHA_B })],
    startedAtMs: report.stages.avFoundation.startedAtMs,
    endedAtMs: report.stages.avFoundation.endedAtMs,
  };
  assert.throws(() => validateBoundaryReport(report), /changing|passed|delivery/i);
});

test("every artifact reference carries a nonempty path, byte length, and SHA-256", async () => {
  const { validateBoundaryReport } = await loadSut();
  const mutate = (fn) => { const r = clone(baseReport()); fn(r); return r; };
  assert.throws(() => validateBoundaryReport(mutate((r) => { delete r.stages.avFoundation.artifacts[0].sha256; })), /sha-?256|artifact/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.avFoundation.artifacts[0].bytes = -1; })), /bytes|artifact/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.avFoundation.artifacts[0].path = ""; })), /path|artifact/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.avFoundation.artifacts[0].sha256 = "nothex"; })), /sha-?256/i);
});

test("cameraPeek is the only stage a changing pass can mark end-to-end vision_verified", async () => {
  const { validateBoundaryReport, isEndToEndVisionVerified } = await loadSut();
  const hostOnly = validateBoundaryReport(baseReport());
  assert.equal(isEndToEndVisionVerified(hostOnly), false, "an AVFoundation-only pass is not end-to-end injected-pixel delivery");

  const full = clone(baseReport());
  const span = () => ({ startedAtMs: 9000, endedAtMs: 9010 });
  full.stages.qemuAuthorization = { state: "passed", authStatus: "authorized", startedAtMs: 8000, endedAtMs: 8010 };
  full.stages.emulatorRoute = { state: "passed", startedAtMs: 8100, endedAtMs: 8110 };
  full.stages.cameraPeek = {
    state: "passed",
    delivery: "changing",
    recognizedCounters: [0, 1],
    artifacts: [artifact({ path: "/run/vcam/peek-00.png", sha256: CAP_SHA_A }), artifact({ path: "/run/vcam/peek-01.png", sha256: CAP_SHA_B })],
    ...span(),
  };
  const validated = validateBoundaryReport(full);
  assert.equal(isEndToEndVisionVerified(validated), true, "a looked-at CameraPeek changing pass is the only end-to-end claim");
});

// ---------------------------------------------------------------------------------------------
// Orchestration — runHostBoundary drives injected fakes through the stage machine. Producer
// teardown/abort/rejection-observation is delegated to withProducer (proven in vcamtransport);
// these tests cover the stage decisions, sibling independence, and complete-report assembly.
// ---------------------------------------------------------------------------------------------

function fakeProducer() {
  const calls = { started: 0, torndown: 0 };
  const run = async (op) => {
    calls.started += 1;
    const controller = new AbortController();
    try {
      return await op(controller.signal);
    } finally {
      calls.torndown += 1;
    }
  };
  return { run, calls };
}

function makeCounter() {
  let t = 0;
  return () => (t += 1);
}

function baseDeps(overrides = {}) {
  const producer = fakeProducer();
  let seenSignal;
  const deps = {
    identity: {
      runId: "vcam-v29.1-20260724-AB12",
      source: { manifestPath: "/run/vcam/manifest.json", manifestSha256: MANIFEST_SHA256, nonce: "VCAM-20260724-AB12", width: 1280, height: 720, pixelFormat: "BGRA" },
      device: { name: "Immersed Camera", uuid: IMMERSED_UUID },
      reader: { executable: "/run/vcam/bin/cmio-camera-reader", argv: ["--authorization-only"], sha256: READER_SHA256 },
      producer: { executable: "/run/vcam/bin/cmio-camera-writer", argv: ["--device-uid", IMMERSED_UUID], sha256: PRODUCER_SHA256 },
    },
    clock: makeCounter(),
    checkAuthorization: async () => "authorized",
    cmioContractAdmitted: false,
    runProducer: producer.run,
    proveSink: async () => ({ artifacts: [artifact({ path: "/run/vcam/sink-stats.jsonl", sha256: CAP_SHA_A })] }),
    readCmioSource: async () => { throw new Error("readCmioSource must not run while the contract is not admitted"); },
    readAvFoundation: async (signal) => {
      seenSignal = signal;
      return { delivery: "changing", recognizedCounters: [0, 1], artifacts: [artifact({ path: "/run/vcam/avf-00.png", sha256: CAP_SHA_A }), artifact({ path: "/run/vcam/avf-01.png", sha256: CAP_SHA_B })] };
    },
    readerGraceMs: 50,
    ...overrides,
  };
  return { deps, producer, seenSignal: () => seenSignal };
}

test("an unauthorized status blocks both reader branches, skips the sink and readbacks, and never starts the producer", async () => {
  const { runHostBoundary, validateBoundaryReport } = await loadSut();
  for (const status of ["notDetermined", "denied", "restricted"]) {
    const { deps, producer } = baseDeps({ checkAuthorization: async () => status });
    const report = await runHostBoundary(deps);
    assert.doesNotThrow(() => validateBoundaryReport(report), `report for ${status} is a valid boundary report`);
    assert.equal(report.stages.cmioAuthorization.state, "blocked");
    assert.equal(report.stages.cmioAuthorization.authStatus, status);
    assert.equal(report.stages.avfAuthorization.state, "blocked");
    assert.equal(report.stages.cmioSink.state, "skipped");
    assert.equal(report.stages.cmioSource.state, "skipped");
    assert.equal(report.stages.avFoundation.state, "skipped");
    assert.equal(report.stages.cameraPeek.state, "skipped");
    assert.equal(producer.calls.started, 0, "an unauthorized reader never starts the sink producer");
  }
});

test("an authorized changing AVFoundation readback passes while the direct-CMIO branch stays blocked on its contract", async () => {
  const { runHostBoundary, validateBoundaryReport, isEndToEndVisionVerified } = await loadSut();
  let cmioCalled = false;
  const { deps, producer } = baseDeps({ readCmioSource: async () => { cmioCalled = true; throw new Error("nope"); } });
  const report = await runHostBoundary(deps);
  assert.doesNotThrow(() => validateBoundaryReport(report));
  assert.equal(report.stages.cmioAuthorization.state, "passed");
  assert.equal(report.stages.avfAuthorization.state, "passed");
  assert.equal(report.stages.cmioSink.state, "passed");
  assert.equal(report.stages.avFoundation.state, "passed");
  assert.equal(report.stages.avFoundation.delivery, "changing");
  assert.deepEqual(report.stages.avFoundation.recognizedCounters, [0, 1]);
  assert.equal(report.stages.cmioSource.state, "blocked");
  assert.equal(cmioCalled, false, "an unadmitted CMIO contract means the direct reader is never invoked");
  assert.equal(producer.calls.started, 1);
  assert.equal(producer.calls.torndown, 1, "the producer is torn down after the readback");
  assert.equal(isEndToEndVisionVerified(report), false, "an AVFoundation-only pass is not end-to-end injected-pixel delivery");
});

test("a static AVFoundation readback is recorded as a failed static delivery, never a pass", async () => {
  const { runHostBoundary, validateBoundaryReport } = await loadSut();
  const { deps } = baseDeps({
    readAvFoundation: async () => ({ delivery: "static", recognizedCounters: [4, 4, 4], artifacts: [artifact()] }),
  });
  const report = await runHostBoundary(deps);
  assert.doesNotThrow(() => validateBoundaryReport(report));
  assert.equal(report.stages.avFoundation.state, "failed");
  assert.equal(report.stages.avFoundation.delivery, "static");
});

test("an AVFoundation reader that throws yields a failed readback with the producer torn down, leaving the CMIO branch independent", async () => {
  const { runHostBoundary, validateBoundaryReport } = await loadSut();
  const { deps, producer } = baseDeps({ readAvFoundation: async () => { throw new Error("capture session faulted"); } });
  const report = await runHostBoundary(deps);
  assert.doesNotThrow(() => validateBoundaryReport(report));
  assert.equal(report.stages.avFoundation.state, "failed");
  assert.match(String(report.stages.avFoundation.error), /capture session faulted/i);
  assert.equal(report.stages.cmioSink.state, "passed");
  assert.equal(report.stages.cmioSource.state, "blocked");
  assert.equal(producer.calls.torndown, 1, "a downstream reader failure still tears down the producer");
});

test("an admitted-but-failing CMIO branch never suppresses a passing AVFoundation branch", async () => {
  const { runHostBoundary, validateBoundaryReport } = await loadSut();
  const { deps } = baseDeps({
    cmioContractAdmitted: true,
    readCmioSource: async () => { throw new Error("cmio input stream absent"); },
  });
  const report = await runHostBoundary(deps);
  assert.doesNotThrow(() => validateBoundaryReport(report));
  assert.equal(report.stages.cmioSource.state, "failed", "the admitted CMIO reader ran and failed");
  assert.equal(report.stages.avFoundation.state, "passed", "the AVFoundation sibling still passed");
});

test("readers run under an abort signal and the returned report is frozen and validated", async () => {
  const { runHostBoundary } = await loadSut();
  const { deps, seenSignal } = baseDeps();
  const report = await runHostBoundary(deps);
  assert.ok(seenSignal() instanceof AbortSignal, "the AVFoundation reader receives the producer operation's abort signal");
  assert.ok(Object.isFrozen(report), "runHostBoundary returns a frozen, validated report");
});

test("a producer that cannot be started fails the sink and skips the readbacks with a complete report", async () => {
  const { runHostBoundary, validateBoundaryReport } = await loadSut();
  const { deps } = baseDeps({ runProducer: async () => { throw new Error("cmio sink unavailable"); } });
  const report = await runHostBoundary(deps);
  assert.doesNotThrow(() => validateBoundaryReport(report));
  assert.equal(report.stages.cmioAuthorization.state, "passed", "authorization was established before the producer failed");
  assert.equal(report.stages.cmioSink.state, "failed");
  assert.match(String(report.stages.cmioSink.error), /cmio sink unavailable/i);
  assert.equal(report.stages.cmioSource.state, "skipped");
  assert.equal(report.stages.avFoundation.state, "skipped");
});

test("a sink that cannot be proven fails the sink and skips the readbacks", async () => {
  const { runHostBoundary, validateBoundaryReport } = await loadSut();
  const { deps, producer } = baseDeps({ proveSink: async () => { throw new Error("sink enqueue never removed"); } });
  const report = await runHostBoundary(deps);
  assert.doesNotThrow(() => validateBoundaryReport(report));
  assert.equal(report.stages.cmioSink.state, "failed");
  assert.match(String(report.stages.cmioSink.error), /sink enqueue never removed/i);
  assert.equal(report.stages.avFoundation.state, "skipped");
  assert.equal(producer.calls.torndown, 1, "the producer is torn down even when the sink cannot be proven");
});

// ---------------------------------------------------------------------------------------------
// Review hardening (adversarial pass). The honesty invariant is "two visibly DIFFERENT frames",
// not merely two array entries; the orchestrator must never reject on untrusted reader output;
// authorization fail-closes on any unmapped status; and over-claim fields are rejected off-class.
// ---------------------------------------------------------------------------------------------

test("a changing pass whose two captures are byte-identical is rejected", async () => {
  const { validateBoundaryReport } = await loadSut();
  const report = clone(baseReport());
  report.stages.avFoundation.artifacts = [artifact({ path: "/run/vcam/avf-00.png", sha256: CAP_SHA_A }), artifact({ path: "/run/vcam/avf-01.png", sha256: CAP_SHA_A })];
  assert.throws(() => validateBoundaryReport(report), /identical|distinct|captures?|different/i, "byte-identical frames cannot prove two different counters");
});

test("a changing pass claiming more distinct counters than it retained distinct captures is rejected", async () => {
  const { validateBoundaryReport } = await loadSut();
  const report = clone(baseReport());
  report.stages.avFoundation.recognizedCounters = [0, 1, 2, 3, 4];
  report.stages.avFoundation.artifacts = [artifact({ path: "/run/vcam/avf-00.png", sha256: CAP_SHA_A }), artifact({ path: "/run/vcam/avf-01.png", sha256: CAP_SHA_B })];
  assert.throws(() => validateBoundaryReport(report), /identical|distinct|captures?|counter/i, "five claimed counters need five distinct retained captures");
});

test("delivery, recognizedCounters, and authStatus are rejected on stages outside their class", async () => {
  const { validateBoundaryReport } = await loadSut();
  const mutate = (fn) => { const r = clone(baseReport()); fn(r); return r; };
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.cmioSink.delivery = "changing"; })), /delivery|cmioSink|over-?claim/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.cmioSink.recognizedCounters = [0, 1, 2]; })), /counter|cmioSink|over-?claim/i);
  assert.throws(() => validateBoundaryReport(mutate((r) => { r.stages.emulatorRoute.authStatus = "authorized"; })), /auth|emulatorRoute|over-?claim/i);
});

test("a blocked readback cannot carry a delivery or recognized counters", async () => {
  const { validateBoundaryReport } = await loadSut();
  const span = () => ({ startedAtMs: baseReport().stages.cmioSource.startedAtMs, endedAtMs: baseReport().stages.cmioSource.endedAtMs });
  const withCmio = (cmio) => { const r = clone(baseReport()); r.stages.cmioSource = { ...cmio, ...span() }; return r; };
  assert.throws(() => validateBoundaryReport(withCmio({ state: "blocked", delivery: "static" })), /blocked|delivery/i);
  assert.throws(() => validateBoundaryReport(withCmio({ state: "blocked", delivery: "none", recognizedCounters: [7] })), /blocked|counter/i);
});

test("a failed static readback must recognize exactly one counter and a failed none readback zero", async () => {
  const { validateBoundaryReport } = await loadSut();
  const span = () => ({ startedAtMs: baseReport().stages.cmioSource.startedAtMs, endedAtMs: baseReport().stages.cmioSource.endedAtMs });
  const withCmio = (cmio) => { const r = clone(baseReport()); r.stages.cmioSource = { ...cmio, ...span() }; return r; };
  assert.throws(() => validateBoundaryReport(withCmio({ state: "failed", delivery: "static", recognizedCounters: [1, 2] })), /static|one counter/i);
  assert.throws(() => validateBoundaryReport(withCmio({ state: "failed", delivery: "none", recognizedCounters: [3] })), /none|counter|no card/i);
});

test("runHostBoundary demotes a reader that over-claims 'changing' without matching evidence", async () => {
  const { runHostBoundary, validateBoundaryReport } = await loadSut();
  // Byte-identical captures.
  {
    const { deps } = baseDeps({ readAvFoundation: async () => ({ delivery: "changing", recognizedCounters: [0, 1], artifacts: [artifact({ sha256: CAP_SHA_A }), artifact({ sha256: CAP_SHA_A })] }) });
    const report = await runHostBoundary(deps);
    assert.doesNotThrow(() => validateBoundaryReport(report));
    assert.equal(report.stages.avFoundation.state, "failed", "byte-identical captures are not a changing pass");
  }
  // Two distinct counters but only one retained capture.
  {
    const { deps } = baseDeps({ readAvFoundation: async () => ({ delivery: "changing", recognizedCounters: [0, 1], artifacts: [artifact({ sha256: CAP_SHA_A })] }) });
    const report = await runHostBoundary(deps);
    assert.doesNotThrow(() => validateBoundaryReport(report));
    assert.equal(report.stages.avFoundation.state, "failed");
    assert.equal(report.stages.avFoundation.delivery, "none");
  }
  // delivery 'changing' but a single counter.
  {
    const { deps } = baseDeps({ readAvFoundation: async () => ({ delivery: "changing", recognizedCounters: [5, 5], artifacts: [artifact({ sha256: CAP_SHA_A }), artifact({ sha256: CAP_SHA_B })] }) });
    const report = await runHostBoundary(deps);
    assert.doesNotThrow(() => validateBoundaryReport(report));
    assert.equal(report.stages.avFoundation.state, "failed");
    assert.equal(report.stages.avFoundation.delivery, "static");
  }
});

test("runHostBoundary returns a complete report instead of rejecting when a reader emits malformed output", async () => {
  const { runHostBoundary, validateBoundaryReport } = await loadSut();
  // Malformed counters on the required AVFoundation gate.
  {
    const { deps } = baseDeps({ readAvFoundation: async () => ({ delivery: "changing", recognizedCounters: [-1], artifacts: [artifact()] }) });
    const report = await runHostBoundary(deps);
    assert.doesNotThrow(() => validateBoundaryReport(report), "malformed reader output must not make the orchestrator reject");
    assert.equal(report.stages.avFoundation.state, "failed");
  }
  // Malformed artifact bytes while claiming a changing pass.
  {
    const { deps } = baseDeps({ readAvFoundation: async () => ({ delivery: "changing", recognizedCounters: [0, 1], artifacts: [{ path: "/x", bytes: -1, sha256: CAP_SHA_A }, artifact({ sha256: CAP_SHA_B })] }) });
    const report = await runHostBoundary(deps);
    assert.doesNotThrow(() => validateBoundaryReport(report));
    assert.equal(report.stages.avFoundation.state, "failed");
  }
  // A malformed CMIO reader must not discard a legitimately-passing AVFoundation sibling.
  {
    const { deps } = baseDeps({
      cmioContractAdmitted: true,
      readCmioSource: async () => ({ delivery: "static", recognizedCounters: [-1], artifacts: [artifact()] }),
    });
    const report = await runHostBoundary(deps);
    assert.doesNotThrow(() => validateBoundaryReport(report));
    assert.equal(report.stages.cmioSource.state, "failed");
    assert.equal(report.stages.avFoundation.state, "passed", "a malformed CMIO sibling does not lose the AVFoundation pass");
  }
});

test("an unmapped authorization status fail-closes to a blocked report rather than rejecting", async () => {
  const { runHostBoundary, validateBoundaryReport } = await loadSut();
  const { deps, producer } = baseDeps({ checkAuthorization: async () => "granted" });
  const report = await runHostBoundary(deps);
  assert.doesNotThrow(() => validateBoundaryReport(report), "an out-of-domain status must not make the orchestrator reject");
  assert.equal(report.stages.avfAuthorization.state, "blocked");
  assert.ok(["notDetermined", "denied", "restricted"].includes(report.stages.avfAuthorization.authStatus), "an unmapped status fails closed to a non-authorized status");
  assert.equal(report.stages.avFoundation.state, "skipped");
  assert.equal(producer.calls.started, 0);
});
