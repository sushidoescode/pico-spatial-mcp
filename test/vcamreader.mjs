// v29.1 host camera reader — device-free source audit of the macOS-native diagnostic executable.
// Run: npm run test:vcamreader
// This reads the .m source text only; it compiles nothing and touches no camera, so it runs on
// Linux CI. The strict compile + runtime seam live in the macOS-only test:vcamreader-native gate.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const readerUrl = new URL("../scripts/macos/cmio-camera-reader.m", import.meta.url);
const loadSource = () => readFile(readerUrl, "utf8");

// The direct-CMIO client-readback contract is UNDOCUMENTED (CMSimpleQueue delegates element
// lifetime externally; no retain annotation; Apple's documented source-consumer path is
// AVFoundation). So the reader must NEVER copy a stream queue, start a stream, or dequeue/enqueue a
// sample. Its presence would be a blocked-contract violation compiled into the binary.
const FORBIDDEN_DIRECT_CMIO = [
  "CMIOStreamCopyBufferQueue",
  "CMIODeviceStartStream",
  "CMIODeviceStopStream",
  "CMSimpleQueueDequeue",
  "CMSimpleQueueEnqueue",
  "CMSimpleQueueCreate",
  "CMIOSampleBufferCreate",
];

test("the reader never links the blocked direct-CMIO stream-consumption symbols", async () => {
  const source = await loadSource();
  for (const symbol of FORBIDDEN_DIRECT_CMIO) {
    assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`), `${symbol} would make the reader a direct CMIO stream client (blocked contract)`);
  }
});

test("the reader is its own tool identity and reuses the proven read-only helpers", async () => {
  const source = await loadSource();
  assert.match(source, /cmio-camera-reader:/, "diagnostics use the reader's own tool prefix, not the writer's");
  assert.doesNotMatch(source, /cmio-camera-writer/, "no writer prefix leaks into the reader");
  // Read-only property access + the exact signal/stop-normalization seam carried over verbatim.
  for (const helper of ["CMIOObjectGetPropertyData", "CMIOObjectGetPropertyDataSize", "CMIOObjectHasProperty", "NormalizeExitCodeForStopRequest", "InstallSignalHandlers"]) {
    assert.match(source, new RegExp(`\\b${helper}\\b`), `reader must use ${helper}`);
  }
});

test("the --cmio-probe-only mode performs read-only topology reporting and mutates nothing", async () => {
  const source = await loadSource();
  assert.match(source, /--cmio-probe-only/, "the read-only topology probe mode exists");
  // It enumerates the exact device by UID and reports each stream's direction/format.
  assert.match(source, /kCMIOHardwarePropertyDevices/);
  assert.match(source, /kCMIODevicePropertyDeviceUID/);
  assert.match(source, /kCMIODevicePropertyStreams/);
  assert.match(source, /kCMIOStreamPropertyDirection/);
  assert.match(source, /kCMIOStreamPropertyFormatDescription/);
  // It emits per-stream and summary JSONL topology events, read-only. The keys appear
  // backslash-escaped inside the C string literals (\"event\":\"stream\").
  assert.match(source, /\\"event\\":\\"stream\\"/);
  assert.match(source, /\\"event\\":\\"probe\\"/);
  assert.match(source, /\\"readOnly\\":true/);
});

test("argument parsing runs before any CoreMediaIO call and fails closed on unknown/duplicate/missing", async () => {
  const source = await loadSource();
  const parseIndex = source.indexOf("static BOOL ParseOptions");
  const mainIndex = source.indexOf("int main(");
  assert.ok(parseIndex >= 0 && mainIndex > parseIndex, "ParseOptions is defined and main follows it");
  const mainSource = source.slice(mainIndex);
  const parseCall = mainSource.indexOf("ParseOptions(");
  const firstCmioCall = Math.min(
    ...["CopyObjectIDs(", "ProbeDeviceTopology(", "CMIOObjectGetPropertyData("]
      .map((needle) => mainSource.indexOf(needle))
      .filter((position) => position >= 0),
  );
  assert.ok(Number.isFinite(firstCmioCall), "main must contain a CoreMediaIO call for the ordering check to be meaningful");
  assert.ok(parseCall >= 0 && firstCmioCall > parseCall, "the option parser runs before the first CoreMediaIO access");
  assert.match(source, /unknown argument/i);
  assert.match(source, /duplicate argument/i);
  assert.match(source, /missing value/i);
  // Exactly one mode must be selected — mutual exclusivity is enforced so Task 4's modes cannot mix.
  assert.match(source, /exactly one mode|mutually exclusive|choose one mode|one mode is required/i);
});

test("the reader never contains the only explicit camera-permission-prompt API", async () => {
  const source = await loadSource();
  assert.doesNotMatch(source, /\brequestAccessForMediaType\b/, "requestAccessForMediaType is the sole explicit prompt and must never appear");
});

test("authorization-only and avfoundation-readback are mutually-exclusive modes counted with the probe", async () => {
  const source = await loadSource();
  assert.match(source, /--authorization-only/);
  assert.match(source, /--avfoundation-readback/);
  // All three modes participate in the exactly-one-mode count so they cannot be combined.
  const modeCountLine = source.match(/int modeCount =[^;]*;/);
  assert.ok(modeCountLine, "a modeCount is computed");
  assert.match(modeCountLine[0], /cmioProbeOnly/);
  assert.match(modeCountLine[0], /authorizationOnly/);
  assert.match(modeCountLine[0], /avfoundationReadback/);
});

test("authorization-only reports executable identity, code signing, and AV status without capturing", async () => {
  const source = await loadSource();
  // Read-only authorization status query (never the prompting request API) + binary identity.
  assert.match(source, /authorizationStatusForMediaType/);
  assert.match(source, /SecStaticCodeCreateWithPath/);
  assert.match(source, /SecCodeCopySigningInformation/);
  assert.match(source, /_NSGetExecutablePath/);
  assert.match(source, /CC_SHA256/);
  assert.match(source, /\\"event\\":\\"authorization\\"/);
  // The authorization-only path must not build or start a capture session.
  const emitStart = source.indexOf("static int EmitAuthorization");
  assert.ok(emitStart >= 0, "EmitAuthorization is inspectable");
  const emitEnd = source.indexOf("\nstatic ", emitStart + 1);
  const emitSource = source.slice(emitStart, emitEnd > emitStart ? emitEnd : source.length);
  for (const forbidden of ["AVCaptureSession", "AVCaptureDeviceInput", "AVCaptureVideoDataOutput", "startRunning"]) {
    assert.ok(!emitSource.includes(forbidden), `authorization-only must not reference ${forbidden}`);
  }
});

test("an AVCaptureDeviceInput is only constructed after the client is already Authorized", async () => {
  const source = await loadSource();
  // A pure guard maps status to a construct/no-construct decision, unit-tested in the native gate.
  assert.match(source, /static BOOL CanConstructInput\(AVAuthorizationStatus status\)/);
  assert.match(source, /AVAuthorizationStatusAuthorized/);
  // Device selection uses the exact unique ID, never a list index.
  assert.match(source, /deviceWithUniqueID/);
  // Readback checks authorization and blocks before any device/input/session construction.
  const readbackStart = source.indexOf("static int RunAvfReadback");
  assert.ok(readbackStart >= 0, "RunAvfReadback is inspectable");
  const readbackSource = source.slice(readbackStart);
  const authCheck = readbackSource.search(/CanConstructInput|authorizationStatusForMediaType/);
  const firstInput = readbackSource.indexOf("AVCaptureDeviceInput");
  assert.ok(authCheck >= 0, "readback checks authorization");
  assert.ok(firstInput >= 0, "readback does construct an AVCaptureDeviceInput on the authorized path");
  assert.ok(authCheck < firstInput, "authorization is checked before any AVCaptureDeviceInput construction");
});

test("avfoundation readback is bounded by finite frame and time limits and records full frame provenance", async () => {
  const source = await loadSource();
  assert.match(source, /kMaximumReadbackFrames/);
  assert.match(source, /--frames/);
  assert.match(source, /--timeout-ms/);
  assert.match(source, /--output-dir/);
  // Per-frame provenance: dimensions, pixel format, timestamps, raw + preview hashes.
  assert.match(source, /presentationTimeMs|presentationTime/);
  assert.match(source, /rawSha256/);
  assert.match(source, /previewSha256/);
  // It must not silently succeed with zero frames or a single static frame; the decision is a pure
  // seam unit-tested in the native lifetime gate.
  assert.match(source, /distinctRawHashes/);
  assert.match(source, /static int AvfExitCode\(NSUInteger captured, NSUInteger distinct, NSUInteger requested\)/);
});

test("the reader retains host arrival time, drop accounting, and a preview-free fast path", async () => {
  const source = await loadSource();
  assert.match(source, /mach_absolute_time/, "a monotonic host stamp is required for latency correlation");
  assert.match(source, /hostTimeNs/, "the per-frame record must carry hostTimeNs");
  assert.match(source, /didDropSampleBuffer/, "dropped frames must be counted, not invisible");
  assert.match(source, /--no-preview/, "a rate run must be able to skip the in-callback PNG encode");
  assert.match(source, /elapsedMs/, "the readback summary must report its own wall-clock span");
});

test("the host stamp is scaled to nanoseconds and the frame cap follows the mode, not the flag order", async () => {
  const source = await loadSource();
  // Raw mach ticks would parse, validate, and yield a plausible-looking latency that nothing
  // downstream could flag. The stamp must be scaled by the host timebase, exactly as the sibling
  // producer scales its enqueue stamps, so both binaries share one clock AND one scale.
  assert.match(source, /mach_timebase_info/, "raw mach ticks are not nanoseconds; scale by the host timebase");
  assert.match(source, /NanosecondsForMachTicks/, "the reader reuses the producer's tick-to-nanosecond conversion");
  // The preview-free mode may run long precisely because it dropped the in-callback PNG encode.
  assert.match(source, /kMaximumReadbackFrames\s*=\s*240\b/, "the preview cap stays 240");
  assert.match(source, /kMaximumReadbackFramesNoPreview\s*=\s*3600\b/, "the preview-free cap is 3600");
  // The bound is resolved from the MODE by a pure helper and applied after the argument loop, so
  // `--frames 3600 --no-preview` and `--no-preview --frames 3600` must behave identically.
  assert.match(source, /static NSUInteger MaximumReadbackFramesForMode\(BOOL noPreview\)/);
  const parseStart = source.indexOf("static BOOL ParseOptions");
  assert.ok(parseStart >= 0, "ParseOptions is inspectable");
  const loopEnd = source.indexOf("if (options->help)", parseStart);
  const boundCheck = source.indexOf("MaximumReadbackFramesForMode(options->noPreview)", parseStart);
  assert.ok(loopEnd > parseStart, "the argument loop ends before the post-parse validation block");
  assert.ok(boundCheck > loopEnd, "the frame bound is applied after the argument loop, once --no-preview is known");
  // Record shape stays stable across modes: the preview fields become JSON null, never disappear.
  assert.match(source, /\\"previewSha256\\":%@,\\"previewPath\\":%@/, "preview fields are emitted in both modes");
});

test("a long readback wait is sliced so a pending stop can interrupt it", async () => {
  // Structural only, and deliberately so: this loop is inside RunAvfReadback, which needs an
  // authorized live camera, and the gates must stay device-free. What it pins is that the bounded
  // wait is taken in short slices under the stop flag rather than as one span of the full timeout,
  // which is the difference between a SIGTERM landing in 100 ms and being ignored for 60 s.
  const source = await loadSource();
  const readbackStart = source.indexOf("static int RunAvfReadback");
  assert.ok(readbackStart >= 0, "RunAvfReadback is inspectable");
  const readbackSource = source.slice(readbackStart);
  assert.match(
    readbackSource,
    /while \(!gStopRequested\) \{[\s\S]{0,400}?dispatch_semaphore_wait\([\s\S]{0,200}?kStopPollIntervalNs/,
    "the semaphore wait sits inside a loop guarded by the stop flag, with a short poll interval",
  );
  assert.doesNotMatch(
    readbackSource,
    /dispatch_semaphore_wait\([\s\S]{0,200}?timeoutMs \* NSEC_PER_MSEC/,
    "the wait must not be taken as one uninterruptible span of the whole timeout",
  );
  // The overall bound still exists; slicing must not turn the timeout into an unbounded wait.
  assert.match(readbackSource, /deadlineNs/, "the sliced wait still honors an overall deadline");
  assert.match(source, /kStopPollIntervalNs\s*=\s*100 \* NSEC_PER_MSEC/);
});

test("the source declares signal normalization and stop handling (ordering is proven by the native lifetime gate)", async () => {
  // Presence check only. The runtime proof that a pending stop short-circuits BEFORE any CMIO
  // access lives in test/macos/cmio-camera-reader-lifetime.m (the test:vcamreader-native gate).
  const source = await loadSource();
  assert.match(source, /NormalizeExitCodeForStopRequest\(0, gStopRequested\)/);
  assert.match(source, /SIGINT/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /SIGHUP/);
});
