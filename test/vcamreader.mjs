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

test("the source declares signal normalization and stop handling (ordering is proven by the native lifetime gate)", async () => {
  // Presence check only. The runtime proof that a pending stop short-circuits BEFORE any CMIO
  // access lives in test/macos/cmio-camera-reader-lifetime.m (the test:vcamreader-native gate).
  const source = await loadSource();
  assert.match(source, /NormalizeExitCodeForStopRequest\(0, gStopRequested\)/);
  assert.match(source, /SIGINT/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /SIGHUP/);
});
