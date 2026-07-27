// v29.2 throughput analysis: correlate writer enqueues with reader captures, fail-closed on
// anything that would make a latency number dishonest. Run: npm run test:vcamthroughput
import assert from "node:assert/strict";
import test from "node:test";

const sutUrl = new URL("../dist/vcamthroughput.js", import.meta.url);
const loadSut = () => import(sutUrl.href);

const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);

const writerLines = (records, extra = {}, { omitStats = false } = {}) => {
  const enqueueLines = records.map((r) => JSON.stringify({ event: "enqueue", ...r })).join("\n");
  if (omitStats) return enqueueLines + "\n";
  return enqueueLines +
    "\n" + JSON.stringify({ event: "stats", phase: "shutdown-snapshot", scheduled: 4, enqueued: records.length,
      removed: records.length, dropInFlight: 1, dropQueueNonEmpty: 2, dropCasLost: 0, dropQueueFull: 0,
      recordsTruncated: false, ...extra }) + "\n";
};

const readerLines = (frames, summary = {}, { omitReadback = false } = {}) => {
  const frameLines = frames.map((f) => JSON.stringify({ event: "frame", width: 1280, height: 720, pixelFormat: "BGRA", ...f })).join("\n");
  if (omitReadback) return frameLines + "\n";
  return frameLines +
    // `previews` mirrors the real reader's summary record (cmio-camera-reader.m emits it for every
    // readback), so a fixture cannot accidentally describe a shape the reader never produces.
    "\n" + JSON.stringify({ event: "readback", framesCaptured: frames.length, dropped: 0,
      elapsedMs: 1000, timedOut: false, previews: true, ...summary }) + "\n";
};

test("observed source cadence comes from presentationTimeMs deltas, not wall clock", async () => {
  const { analyzeThroughput } = await loadSut();
  const report = analyzeThroughput({
    writerJsonl: writerLines([
      { sequence: 1, frameIndex: 0, sha256: HASH_A, hostTimeNs: 1_000_000_000, presentationTimeMs: 0 },
      { sequence: 2, frameIndex: 1, sha256: HASH_B, hostTimeNs: 2_000_000_000, presentationTimeMs: 33.3 },
    ]),
    readerJsonl: readerLines([
      { index: 0, presentationTimeMs: 100, rawSha256: HASH_A, hostTimeNs: 1_050_000_000 },
      { index: 1, presentationTimeMs: 133.3, rawSha256: HASH_B, hostTimeNs: 2_040_000_000 },
      { index: 2, presentationTimeMs: 166.6, rawSha256: HASH_B, hostTimeNs: 2_080_000_000 },
    ]),
  });
  assert.equal(Math.round(report.observedSourceHz), 30, "33.3ms deltas are a 30fps source");
  assert.equal(report.distinctFramesObserved, 2);
  assert.deepEqual(report.confounded, []);
  assert.equal(report.latencyMs.isLowerBound, true, "repeated hashes make latency a lower bound, always");
  assert.equal(report.latencyMs.p50, 50, "HASH_A: reader 1.05e9ns - writer 1.0e9ns = 50ms");
  assert.equal(report.drops.inFlight, 1);
  assert.equal(report.drops.queueNonEmpty, 2);
});

test("a non-BGRA reader record is a format mismatch, never silent zero-correlation", async () => {
  const { analyzeThroughput } = await loadSut();
  const report = analyzeThroughput({
    writerJsonl: writerLines([{ sequence: 1, frameIndex: 0, sha256: HASH_A, hostTimeNs: 1e9, presentationTimeMs: 0 }]),
    readerJsonl: readerLines([{ index: 0, presentationTimeMs: 0, rawSha256: HASH_A, hostTimeNs: 1.05e9, pixelFormat: "420v" }]),
  });
  assert.ok(report.confounded.includes("pixelFormat!=BGRA"), "the reader only guards bytesPerRow >= width*4");
  assert.equal(report.latencyMs, null, "a format mismatch must not yield a latency number");
});

test("truncated enqueue records forbid a latency distribution", async () => {
  const { analyzeThroughput } = await loadSut();
  const report = analyzeThroughput({
    writerJsonl: writerLines([{ sequence: 1, frameIndex: 0, sha256: HASH_A, hostTimeNs: 1e9, presentationTimeMs: 0 }],
      { recordsTruncated: true }),
    readerJsonl: readerLines([{ index: 0, presentationTimeMs: 0, rawSha256: HASH_A, hostTimeNs: 1.05e9 }]),
  });
  assert.ok(report.confounded.includes("recordsTruncated"));
  assert.equal(report.latencyMs, null, "dropped early records break the latest-enqueue-at-or-before rule");
});

test("missing hostTimeNs yields cadence but no latency, and never throws", async () => {
  const { analyzeThroughput } = await loadSut();
  const report = analyzeThroughput({
    writerJsonl: writerLines([{ sequence: 1, frameIndex: 0, sha256: HASH_A, presentationTimeMs: 0 }]),
    readerJsonl: readerLines([
      { index: 0, presentationTimeMs: 0, rawSha256: HASH_A },
      { index: 1, presentationTimeMs: 33.3, rawSha256: HASH_B },
    ]),
  });
  assert.equal(report.latencyMs, null);
  assert.ok(report.confounded.includes("no hostTimeNs"));
  assert.equal(Math.round(report.observedSourceHz), 30, "cadence survives without host stamps");
});

test("garbage and empty input are confounded, not exceptions", async () => {
  const { analyzeThroughput } = await loadSut();
  for (const bad of ["", "not json at all\n{{{\n", "\n\n"]) {
    const report = analyzeThroughput({ writerJsonl: bad, readerJsonl: bad });
    assert.ok(Array.isArray(report.confounded) && report.confounded.length > 0, `must flag: ${JSON.stringify(bad)}`);
    assert.equal(report.latencyMs, null);
    assert.equal(report.observedSourceHz, null);
  }
});

test("a wall span that dwarfs the source span is reported as a measurement, not as a reader diagnosis", async () => {
  const { analyzeThroughput } = await loadSut();
  const report = analyzeThroughput({
    writerJsonl: writerLines([{ sequence: 1, frameIndex: 0, sha256: HASH_A, hostTimeNs: 1e9, presentationTimeMs: 0 }]),
    readerJsonl: readerLines(
      [{ index: 0, presentationTimeMs: 0, rawSha256: HASH_A, hostTimeNs: 1.05e9 },
       { index: 1, presentationTimeMs: 33.3, rawSha256: HASH_B, hostTimeNs: 1.06e9 }],
      { elapsedMs: 15_000, previews: true },
    ),
  });
  assert.equal(report.wallSpanExceedsSourceSpan, true, "33ms of source time across 15s of wall clock is a real divergence");
  assert.equal(report.readerWritesPreviews, true, "only the reader's own previews flag can point the finger at the reader");
});

test("the same divergence under --no-preview carries no reader attribution", async () => {
  const { analyzeThroughput } = await loadSut();
  // A genuinely STALLED SOURCE: two frames 33ms apart inside a 15s run, with a reader doing almost
  // no work. The old name (`selfPerturbed`) asserted a cause this input flatly contradicts — the
  // reader wrote no PNGs, so nothing it did can explain the wall span. The measurement must still
  // be reported, and `readerWritesPreviews:false` is what stops an operator chasing the reader.
  const report = analyzeThroughput({
    writerJsonl: writerLines([{ sequence: 1, frameIndex: 0, sha256: HASH_A, hostTimeNs: 1e9, presentationTimeMs: 0 }]),
    readerJsonl: readerLines(
      [{ index: 0, presentationTimeMs: 0, rawSha256: HASH_A, hostTimeNs: 1.05e9 },
       { index: 1, presentationTimeMs: 33.3, rawSha256: HASH_B, hostTimeNs: 1.06e9 }],
      { elapsedMs: 15_000, previews: false },
    ),
  });
  assert.equal(report.wallSpanExceedsSourceSpan, true, "the divergence is real regardless of who caused it");
  assert.equal(report.readerWritesPreviews, false, "a --no-preview reader cannot be blamed for its own wall span");
});

test("a writer killed before its shutdown stats record is confounded, not a silent zero-drop reading", async () => {
  const { analyzeThroughput } = await loadSut();
  const report = analyzeThroughput({
    writerJsonl: writerLines(
      [{ sequence: 1, frameIndex: 0, sha256: HASH_A, hostTimeNs: 1e9, presentationTimeMs: 0 }],
      {},
      { omitStats: true },
    ),
    readerJsonl: readerLines([{ index: 0, presentationTimeMs: 0, rawSha256: HASH_A, hostTimeNs: 1.05e9 }]),
  });
  assert.ok(report.confounded.includes("no writer stats record"), "a missing summary must not read as a confirmed zero");
  assert.equal(report.drops.inFlight, 0, "the counter still reports a value, just alongside the caveat");
});

test("a reader killed before its readback record is confounded, not a silent zero-drop or false divergence", async () => {
  const { analyzeThroughput } = await loadSut();
  const report = analyzeThroughput({
    writerJsonl: writerLines([{ sequence: 1, frameIndex: 0, sha256: HASH_A, hostTimeNs: 1e9, presentationTimeMs: 0 }]),
    readerJsonl: readerLines(
      [{ index: 0, presentationTimeMs: 0, rawSha256: HASH_A, hostTimeNs: 1.05e9 },
       { index: 1, presentationTimeMs: 33.3, rawSha256: HASH_B, hostTimeNs: 1.06e9 }],
      {},
      { omitReadback: true },
    ),
  });
  assert.ok(report.confounded.includes("no reader readback record"), "a missing summary must not read as a confirmed zero");
  assert.equal(report.drops.readerDropped, 0, "the counter still reports a value, just alongside the caveat");
  assert.equal(report.wallSpanExceedsSourceSpan, false, "no elapsedMs means the comparison cannot be made; it must default false, not throw");
  assert.equal(report.readerWritesPreviews, null, "an absent readback record means the preview mode is UNKNOWN, never a confident false");
});

test("duplicate or decreasing presentationTimeMs deltas leave cadence unknown, with a reason recorded", async () => {
  const { analyzeThroughput } = await loadSut();
  const report = analyzeThroughput({
    writerJsonl: writerLines([{ sequence: 1, frameIndex: 0, sha256: HASH_A, hostTimeNs: 1e9, presentationTimeMs: 0 }]),
    readerJsonl: readerLines([
      { index: 0, presentationTimeMs: 100, rawSha256: HASH_A, hostTimeNs: 1.05e9 },
      { index: 1, presentationTimeMs: 100, rawSha256: HASH_B, hostTimeNs: 1.06e9 },
    ]),
  });
  assert.equal(report.observedSourceHz, null, "a zero delta between two identically-stamped frames cannot yield a cadence");
  assert.ok(report.confounded.includes("no positive presentationTimeMs deltas"), "silence here would read as a real 0Hz measurement");
});

test("a SUBSET of dropped deltas is recorded, not silently averaged away into a lower cadence", async () => {
  const { analyzeThroughput } = await loadSut();
  // Exactly what a source republishing each rendered image twice looks like: each image is
  // delivered as a pair sharing one presentationTimeMs. Two of the three deltas are zero, so the
  // mean is taken over one surviving 33.3ms gap and observedSourceHz reports 30Hz for a stream
  // that actually delivered four frames. The number is not wrong to compute — it is wrong to
  // publish WITHOUT saying that most of the evidence was discarded to get it.
  const report = analyzeThroughput({
    writerJsonl: writerLines([{ sequence: 1, frameIndex: 0, sha256: HASH_A, hostTimeNs: 1e9, presentationTimeMs: 0 }]),
    readerJsonl: readerLines([
      { index: 0, presentationTimeMs: 0, rawSha256: HASH_A, hostTimeNs: 1.00e9 },
      { index: 1, presentationTimeMs: 0, rawSha256: HASH_A, hostTimeNs: 1.01e9 },
      { index: 2, presentationTimeMs: 33.3, rawSha256: HASH_B, hostTimeNs: 1.02e9 },
      { index: 3, presentationTimeMs: 33.3, rawSha256: HASH_B, hostTimeNs: 1.03e9 },
    ]),
  });
  assert.equal(Math.round(report.observedSourceHz), 30, "the survivors still average to 30Hz — that is precisely the trap");
  assert.ok(
    report.confounded.includes("non-positive presentationTimeMs deltas dropped from the cadence average"),
    `an under-reported headline number must never ship with confounded: [] — got ${JSON.stringify(report.confounded)}`,
  );
});
