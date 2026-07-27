// v29.2 throughput analysis. Pure: takes two JSONL strings, returns a validated report.
// Never throws on untrusted input — an unusable input is `confounded`, not an exception.

export type ThroughputInput = { writerJsonl: string; readerJsonl: string };

export type ThroughputReport = {
  observedSourceHz: number | null;
  injectedImageHz: number | null;
  latencyMs: { p50: number; p90: number; max: number; isLowerBound: true } | null;
  drops: { inFlight: number; queueNonEmpty: number; casLost: number; queueFull: number; readerDropped: number };
  distinctFramesObserved: number;
  selfPerturbed: boolean;
  confounded: string[];
};

const SHA256_RE = /^[0-9a-f]{64}$/;

type EnqueueRecord = { sequence: number; frameIndex: number; sha256: string; hostTimeNs: number | null };
type FrameRecord = { index: number; presentationTimeMs: number; rawSha256: string; hostTimeNs: number | null; pixelFormat: string };

function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
    } catch { /* a malformed line is counted by the caller, never fatal */ }
  }
  return out;
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank];
}

export function analyzeThroughput(input: ThroughputInput): ThroughputReport {
  const confounded: string[] = [];
  const add = (reason: string) => { if (!confounded.includes(reason)) confounded.push(reason); };

  const writerRows = parseLines(input?.writerJsonl ?? "");
  const readerRows = parseLines(input?.readerJsonl ?? "");
  if (writerRows.length === 0) add("empty or unparseable writer JSONL");
  if (readerRows.length === 0) add("empty or unparseable reader JSONL");

  const stats = writerRows.filter((r) => r.event === "stats").pop() ?? {};
  if (stats.recordsTruncated === true) add("recordsTruncated");

  const drops = {
    inFlight: finite(stats.dropInFlight) ?? 0,
    queueNonEmpty: finite(stats.dropQueueNonEmpty) ?? 0,
    casLost: finite(stats.dropCasLost) ?? 0,
    queueFull: finite(stats.dropQueueFull) ?? 0,
    readerDropped: finite((readerRows.filter((r) => r.event === "readback").pop() ?? {}).dropped) ?? 0,
  };

  const enqueues: EnqueueRecord[] = [];
  for (const row of writerRows) {
    if (row.event !== "enqueue") continue;
    const sha = typeof row.sha256 === "string" && SHA256_RE.test(row.sha256) ? row.sha256 : null;
    const sequence = finite(row.sequence);
    const frameIndex = finite(row.frameIndex);
    if (sha === null || sequence === null || frameIndex === null) { add("malformed enqueue record"); continue; }
    enqueues.push({ sequence, frameIndex, sha256: sha, hostTimeNs: finite(row.hostTimeNs) });
  }

  const frames: FrameRecord[] = [];
  for (const row of readerRows) {
    if (row.event !== "frame") continue;
    const sha = typeof row.rawSha256 === "string" && SHA256_RE.test(row.rawSha256) ? row.rawSha256 : null;
    const pts = finite(row.presentationTimeMs);
    const index = finite(row.index);
    if (sha === null || pts === null || index === null) { add("malformed frame record"); continue; }
    const pixelFormat = typeof row.pixelFormat === "string" ? row.pixelFormat : "unknown";
    // The reader only guards bytesPerRow >= width*4, so a 4-byte non-BGRA format still hashes
    // cleanly and can never correlate. Report that, rather than an honest-looking zero.
    if (pixelFormat !== "BGRA") add("pixelFormat!=BGRA");
    frames.push({ index, presentationTimeMs: pts, rawSha256: sha, hostTimeNs: finite(row.hostTimeNs), pixelFormat });
  }

  frames.sort((a, b) => a.presentationTimeMs - b.presentationTimeMs);

  let observedSourceHz: number | null = null;
  let injectedImageHz: number | null = null;
  if (frames.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < frames.length; i += 1) {
      const delta = frames[i].presentationTimeMs - frames[i - 1].presentationTimeMs;
      if (delta > 0) deltas.push(delta);
    }
    if (deltas.length > 0) {
      const mean = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
      observedSourceHz = 1000 / mean;
    }
    const spanMs = frames[frames.length - 1].presentationTimeMs - frames[0].presentationTimeMs;
    let flips = 0;
    for (let i = 1; i < frames.length; i += 1) if (frames[i].rawSha256 !== frames[i - 1].rawSha256) flips += 1;
    if (spanMs > 0) injectedImageHz = (flips * 1000) / spanMs;
  } else {
    add("fewer than two captured frames");
  }

  const distinctFramesObserved = new Set(frames.map((f) => f.rawSha256)).size;

  // A slow delegate stretches wall time but not the source's presentation cadence. When the two
  // diverge sharply the reader perturbed its own run (v29.1: in-callback PNG encode + disk read-back).
  const readback = readerRows.filter((r) => r.event === "readback").pop() ?? {};
  const elapsedMs = finite(readback.elapsedMs);
  const sourceSpanMs = frames.length >= 2
    ? frames[frames.length - 1].presentationTimeMs - frames[0].presentationTimeMs
    : null;
  const selfPerturbed = elapsedMs !== null && sourceSpanMs !== null && sourceSpanMs > 0
    ? elapsedMs > 3 * sourceSpanMs
    : false;

  let latencyMs: ThroughputReport["latencyMs"] = null;
  const writerHasHostTime = enqueues.some((e) => e.hostTimeNs !== null);
  const readerHasHostTime = frames.some((f) => f.hostTimeNs !== null);
  if (!writerHasHostTime || !readerHasHostTime) {
    add("no hostTimeNs");
  } else if (!confounded.includes("recordsTruncated") && !confounded.includes("pixelFormat!=BGRA")) {
    const byHash = new Map<string, number[]>();
    for (const e of enqueues) {
      if (e.hostTimeNs === null) continue;
      const list = byHash.get(e.sha256) ?? [];
      list.push(e.hostTimeNs);
      byHash.set(e.sha256, list);
    }
    for (const list of byHash.values()) list.sort((a, b) => a - b);
    const samples: number[] = [];
    for (const frame of frames) {
      if (frame.hostTimeNs === null) continue;
      const candidates = byHash.get(frame.rawSha256);
      if (!candidates || candidates.length === 0) continue;
      // Identical pixels repeat, so the honest anchor is the LATEST enqueue at or before the
      // observation. That makes every sample a lower bound, which the report states explicitly.
      let anchor: number | null = null;
      for (const stamp of candidates) {
        if (stamp <= frame.hostTimeNs) anchor = stamp; else break;
      }
      if (anchor !== null) samples.push((frame.hostTimeNs - anchor) / 1e6);
    }
    if (samples.length === 0) add("no correlated frames");
    else {
      samples.sort((a, b) => a - b);
      latencyMs = {
        p50: percentile(samples, 0.5),
        p90: percentile(samples, 0.9),
        max: samples[samples.length - 1],
        isLowerBound: true,
      };
    }
  }

  return { observedSourceHz, injectedImageHz, latencyMs, drops, distinctFramesObserved, selfPerturbed, confounded };
}
