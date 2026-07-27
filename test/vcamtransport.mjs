// v28.4 injected-pixel transport: pure source, fresh webcam identity, and producer lifecycle.
// Run: npm run test:vcamtransport
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sutUrl = new URL("../dist/vcamtransport.js", import.meta.url);
const loadSut = () => import(sutUrl.href);

const WIDTH = 1280;
const HEIGHT = 720;
const PIXEL_FORMAT = "BGRA";
const FRAME_BYTES = WIDTH * HEIGHT * 4;
const NONCE = "VCAM-20260722-7F3A";
const COUNTER_REGION = { x: 960, y: 480, width: 256, height: 160 };
const PHYSICAL_UUID = "6C707041-05AC-0011-0008-000000000001";
const IMMERSED_UUID = "A1EA3EF8-F9D5-4BA7-827E-A26C1B27BEA2";
const MANIFEST_SHA256 = "a7e9bf4f566f9c8bedc37a9a03b976e071b31402e27a99e8b7f48fafbeb91f8c";

const FRESH_WEBCAM_LIST = `List of web cameras connected to the computer:
 Camera 'webcam0' is connected to device '${PHYSICAL_UUID}' on channel 0 using pixel format 'YV12'
 Camera 'webcam1' is connected to device '${IMMERSED_UUID}' on channel 0 using pixel format 'BGR4'
`;

const HOST_DEVICES = [
  { name: "MacBook Pro Camera", uuid: PHYSICAL_UUID },
  { name: "Immersed Camera", uuid: IMMERSED_UUID },
];

const TARGET = { name: "Immersed Camera", uuid: IMMERSED_UUID };

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pixelKey(bytes, offset) {
  return `${bytes[offset]},${bytes[offset + 1]},${bytes[offset + 2]},${bytes[offset + 3]}`;
}

function countChangedPixels(a, b, region, inside) {
  let changed = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const inRegion =
        x >= region.x && x < region.x + region.width &&
        y >= region.y && y < region.y + region.height;
      if (inRegion !== inside) continue;
      const offset = (y * WIDTH + x) * 4;
      if (
        a[offset] !== b[offset] ||
        a[offset + 1] !== b[offset + 1] ||
        a[offset + 2] !== b[offset + 2] ||
        a[offset + 3] !== b[offset + 3]
      ) changed += 1;
    }
  }
  return changed;
}

function assertCardFrame(frame, counter) {
  assert.equal(frame.counter, counter);
  assert.equal(frame.width, WIDTH);
  assert.equal(frame.height, HEIGHT);
  assert.equal(frame.pixelFormat, PIXEL_FORMAT);
  assert.ok(Buffer.isBuffer(frame.pixels), "BGRA frame must be a Buffer");
  assert.equal(frame.pixels.length, FRAME_BYTES);
  assert.equal(frame.sha256, sha256(frame.pixels));
  for (let offset = 3; offset < frame.pixels.length; offset += 4) {
    assert.equal(frame.pixels[offset], 255, "every source pixel must be opaque");
  }
}

function makePlan(createProducerPlan) {
  return createProducerPlan({
    executable: "/tmp/Virtual Camera Producer/bin/vcam-producer",
    deviceName: TARGET.name,
    deviceUid: TARGET.uuid,
    manifestPath: "/tmp/cards; literal argv/manifest.json",
    expectedManifestSha256: MANIFEST_SHA256,
    width: WIDTH,
    height: HEIGHT,
    pixelFormat: PIXEL_FORMAT,
  });
}

class FakeProducer extends EventEmitter {
  constructor({ ignoreTerm = false, ignoreKill = false } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
    this.ignoreTerm = ignoreTerm;
    this.ignoreKill = ignoreKill;
  }

  sendReady(overrides = {}, splitAt = 0) {
    const line = `${JSON.stringify({
      event: "ready",
      deviceUid: IMMERSED_UUID,
      width: WIDTH,
      height: HEIGHT,
      pixelFormat: PIXEL_FORMAT,
      manifestSha256: MANIFEST_SHA256,
      ...overrides,
    })}\n`;
    if (splitAt > 0) {
      this.stdout.write(line.slice(0, splitAt));
      queueMicrotask(() => this.stdout.write(line.slice(splitAt)));
    } else {
      this.stdout.write(line);
    }
  }

  finish(code, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  finishWithTrailingStderr(code, trailingStderr, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    queueMicrotask(() => {
      this.stderr.write(trailingStderr);
      this.stdout.end();
      this.stderr.end();
      this.emit("close", code, signal);
    });
  }

  kill(signal = "SIGTERM") {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    if (signal === "SIGKILL" && this.ignoreKill) return true;
    this.finish(null, signal);
    return true;
  }
}

test("fixed-nonce 1280x720 BGRA cards and their manifest are deterministic and hash-verifiable", async () => {
  const { createTestCardSequence } = await loadSut();
  const options = {
    nonce: NONCE,
    counters: [0, 1],
    width: WIDTH,
    height: HEIGHT,
    pixelFormat: PIXEL_FORMAT,
  };
  const first = createTestCardSequence(options);
  const repeated = createTestCardSequence(options);

  assert.equal(first.frames.length, 2);
  first.frames.forEach((frame, index) => assertCardFrame(frame, index));
  assert.deepEqual(
    first.frames.map((frame) => frame.sha256),
    repeated.frames.map((frame) => frame.sha256),
  );
  assert.deepEqual(first.frames.map((frame) => frame.pixels), repeated.frames.map((frame) => frame.pixels));

  const manifestFrames = first.frames.map((frame) => ({
    counter: frame.counter,
    bytes: FRAME_BYTES,
    sha256: frame.sha256,
  }));
  assert.deepEqual(first.manifest, {
    schemaVersion: 1,
    kind: "pico-vcam-test-card-sequence",
    nonce: NONCE,
    width: WIDTH,
    height: HEIGHT,
    pixelFormat: PIXEL_FORMAT,
    frameBytes: FRAME_BYTES,
    counterRegion: COUNTER_REGION,
    frames: manifestFrames,
  });
  assert.equal(first.manifestJson, `${JSON.stringify(first.manifest, null, 2)}\n`);
  assert.equal(first.manifestSha256, sha256(Buffer.from(first.manifestJson, "utf8")));
  assert.equal(first.manifestSha256, repeated.manifestSha256);
  const retainedLiveSequence = createTestCardSequence({ ...options, counters: [0, 1, 2, 3] });
  assert.equal(
    retainedLiveSequence.manifestSha256,
    "d3f6c4869a4804ef95cd80f8a12a5b4c0511b3dfc1c3c5bc2454da02a1751d4f",
    "the reviewed live-card artifact remains reproducible after transport hardening",
  );

  const requiredBgra = new Set([
    "0,0,0,255",
    "255,255,255,255",
    "0,0,255,255",
    "0,255,0,255",
    "255,0,0,255",
  ]);
  for (let offset = 0; offset < first.frames[0].pixels.length && requiredBgra.size > 0; offset += 4) {
    requiredBgra.delete(pixelKey(first.frames[0].pixels, offset));
  }
  assert.deepEqual([...requiredBgra], [], "card must contain opaque black, white, red, green, and blue blocks");

  assert.ok(
    countChangedPixels(first.frames[0].pixels, first.frames[1].pixels, COUNTER_REGION, true) >= 256,
    "adjacent counters must make a visibly substantial change inside the counter panel",
  );
  assert.equal(
    countChangedPixels(first.frames[0].pixels, first.frames[1].pixels, COUNTER_REGION, false),
    0,
    "counter progression must not introduce unrelated frame drift",
  );

  const otherNonce = createTestCardSequence({ ...options, nonce: "VCAM-20260722-DIFFERENT", counters: [0] });
  assert.notEqual(first.frames[0].sha256, otherNonce.frames[0].sha256, "the nonce must affect visible source pixels");
  const lowercaseNonce = createTestCardSequence({ ...options, nonce: "vcam-case", counters: [0] });
  const uppercaseNonce = createTestCardSequence({ ...options, nonce: "VCAM-CASE", counters: [0] });
  assert.notEqual(
    lowercaseNonce.frames[0].sha256,
    uppercaseNonce.frames[0].sha256,
    "every accepted nonce byte, including ASCII case, must affect visible source pixels",
  );
  const maxLengthPrefix = "A".repeat(63);
  const maxLengthX = createTestCardSequence({ ...options, nonce: `${maxLengthPrefix}X`, counters: [0] });
  const maxLengthY = createTestCardSequence({ ...options, nonce: `${maxLengthPrefix}Y`, counters: [0] });
  assert.notEqual(
    maxLengthX.frames[0].sha256,
    maxLengthY.frames[0].sha256,
    "the final byte of a maximum-length accepted nonce must be rendered rather than clipped",
  );
  const originalCounterX = first.manifest.counterRegion.x;
  let mutationSnapshot;
  try {
    try {
      first.manifest.counterRegion.x = 0;
    } catch {
      // An immutable returned region is the preferred contract.
    }
    const afterMutation = createTestCardSequence(options);
    mutationSnapshot = {
      returnedX: first.manifest.counterRegion.x,
      nextManifestSha256: afterMutation.manifestSha256,
      nextFrameSha256: afterMutation.frames[0].sha256,
    };
  } finally {
    // Keep this RED probe isolated if an older mutable implementation poisoned module state.
    try { first.manifest.counterRegion.x = originalCounterX; } catch {}
  }
  assert.equal(mutationSnapshot.returnedX, originalCounterX, "returned counter geometry is immutable");
  assert.equal(mutationSnapshot.nextManifestSha256, repeated.manifestSha256);
  assert.equal(mutationSnapshot.nextFrameSha256, repeated.frames[0].sha256);
  assert.throws(
    () => createTestCardSequence({ ...options, counters: Array.from({ length: 17 }, (_, index) => index) }),
    /1-16|16 values/i,
    "source generation and the native writer share the same bounded short-sequence cap",
  );
});

test("test-card generation needs no clock, PATH command, HOME state, or configured font/FFmpeg/camera path", async () => {
  const { createTestCardSequence } = await loadSut();
  const reference = createTestCardSequence({
    nonce: NONCE,
    counters: [7],
    width: WIDTH,
    height: HEIGHT,
    pixelFormat: PIXEL_FORMAT,
  });
  const childSource = `
    const RealDate = Date;
    globalThis.Date = class ForbiddenWallClock extends RealDate {
      constructor(...args) {
        if (args.length === 0) throw new Error("wall clock access forbidden");
        super(...args);
      }
      static now() { throw new Error("wall clock access forbidden"); }
    };
    const { createTestCardSequence } = await import(${JSON.stringify(sutUrl.href)});
    const result = createTestCardSequence(${JSON.stringify({
      nonce: NONCE,
      counters: [7],
      width: WIDTH,
      height: HEIGHT,
      pixelFormat: PIXEL_FORMAT,
    })});
    process.stdout.write(result.manifestSha256);
  `;
  const isolated = spawnSync(process.execPath, ["--input-type=module", "--eval", childSource], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: "",
      HOME: "/definitely-not-a-vcam-home",
      FONTCONFIG_FILE: "/definitely-not-a-font-config",
      FONTCONFIG_PATH: "/definitely-not-a-font-path",
      FFMPEG_PATH: "/definitely-not-ffmpeg",
      PICO_VCAM_PRODUCER: "/definitely-not-a-producer",
    },
  });
  assert.equal(isolated.signal, null, "pure generation must finish within the bound");
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(isolated.stdout, reference.manifestSha256);

  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../src/vcamtransport.ts", import.meta.url),
    "utf8",
  ));
  assert.doesNotMatch(source, /System\/Library\/Fonts|FONTCONFIG|avfoundation|ffmpeg/i);
});

test("fresh webcam output resolves the exact host name+UUID even when webcam indices move", async () => {
  const { parseEmulatorWebcamList, resolvePostStartWebcam } = await loadSut();
  assert.deepEqual(parseEmulatorWebcamList(FRESH_WEBCAM_LIST), [
    { route: "webcam0", uuid: PHYSICAL_UUID, channel: 0, pixelFormat: "YV12" },
    { route: "webcam1", uuid: IMMERSED_UUID, channel: 0, pixelFormat: "BGR4" },
  ]);

  const movedOutput = `List of web cameras connected to the computer:
 Camera 'webcam0' is connected to device '${PHYSICAL_UUID}' on channel 0 using pixel format 'YV12'
 Camera 'webcam2' is connected to device '${IMMERSED_UUID}' on channel 0 using pixel format 'BGR4'
`;
  const resolved = resolvePostStartWebcam({
    webcams: parseEmulatorWebcamList(movedOutput),
    hostDevices: HOST_DEVICES,
    target: TARGET,
    producerStartedAtMs: 1_000,
    observedAtMs: 1_001,
  });
  assert.deepEqual(resolved, {
    route: "webcam2",
    name: TARGET.name,
    uuid: TARGET.uuid,
    channel: 0,
    pixelFormat: "BGR4",
    observedAtMs: 1_001,
  });
  assert.deepEqual(
    resolvePostStartWebcam({
      webcams: parseEmulatorWebcamList(movedOutput),
      hostDevices: HOST_DEVICES,
      target: { ...TARGET, uuid: TARGET.uuid.toLowerCase() },
      producerStartedAtMs: 1_000,
      observedAtMs: 1_001,
    }),
    resolved,
    "UUID identity is semantic rather than dependent on hex-letter case",
  );
});

test("webcam parsing and resolution fail closed for malformed, missing, ambiguous, swapped, or stale identity", async () => {
  const { parseEmulatorWebcamList, resolvePostStartWebcam } = await loadSut();
  const resolve = ({ output = FRESH_WEBCAM_LIST, hostDevices = HOST_DEVICES, observedAtMs = 2_000 } = {}) =>
    resolvePostStartWebcam({
      webcams: parseEmulatorWebcamList(output),
      hostDevices,
      target: TARGET,
      producerStartedAtMs: 1_000,
      observedAtMs,
    });

  assert.throws(
    () => parseEmulatorWebcamList("List of web cameras connected to the computer:\n Camera webcam0 ???\n"),
    /malformed|unrecognized.*camera/i,
  );
  assert.throws(
    () => resolve({ output: FRESH_WEBCAM_LIST.replace(/^ Camera 'webcam1'.*\n/m, "") }),
    /missing|not found/i,
  );
  assert.throws(
    () => resolve({
      output: `${FRESH_WEBCAM_LIST} Camera 'webcam2' is connected to device '${IMMERSED_UUID}' on channel 0 using pixel format 'BGR4'\n`,
    }),
    /ambiguous|duplicate/i,
  );
  assert.throws(
    () => resolve({
      hostDevices: [
        { name: "MacBook Pro Camera", uuid: IMMERSED_UUID },
        { name: "Immersed Camera", uuid: PHYSICAL_UUID },
      ],
    }),
    /identity|name.*uuid|uuid.*name|changed/i,
  );
  assert.throws(
    () => resolve({ hostDevices: [...HOST_DEVICES, { ...TARGET }] }),
    /ambiguous|duplicate/i,
  );
  assert.throws(
    () => resolve({
      output: FRESH_WEBCAM_LIST.replace("Camera 'webcam1'", "Camera 'webcam0'"),
    }),
    /ambiguous|duplicate|route/i,
  );
  assert.throws(
    () => resolvePostStartWebcam({
      webcams: [
        { route: "webcam1", uuid: IMMERSED_UUID, channel: 0, pixelFormat: "BGR4" },
        { route: "webcam1", uuid: PHYSICAL_UUID, channel: 0, pixelFormat: "YV12" },
      ],
      hostDevices: HOST_DEVICES,
      target: TARGET,
      producerStartedAtMs: 1_000,
      observedAtMs: 1_001,
    }),
    /ambiguous|duplicate|route/i,
    "resolution must fail closed even when a caller supplies pre-parsed duplicate routes",
  );
  assert.throws(
    () => parseEmulatorWebcamList(
      `${FRESH_WEBCAM_LIST.trimEnd()}\n ignored List of web cameras connected to the computer: suffix\n`,
    ),
    /malformed|unrecognized|header/i,
    "only the exact webcam-list header may be skipped",
  );
  assert.throws(
    () => parseEmulatorWebcamList(
      "List of web cameras connected to the computer:\n Camera 'webcam0' is connected to device 'not-a-uuid' on channel 0 using pixel format 'BGR4'\n",
    ),
    /malformed|uuid/i,
  );
  assert.throws(() => resolve({ observedAtMs: 1_000 }), /post-start|stale|fresh/i);
  assert.throws(() => resolve({ observedAtMs: 999 }), /post-start|stale|fresh/i);
});

test("producer plans preserve executable/argv separation and require the exact UID and 1280x720 BGRA format", async () => {
  const { createProducerPlan } = await loadSut();
  const plan = makePlan(createProducerPlan);
  assert.equal(plan.executable, "/tmp/Virtual Camera Producer/bin/vcam-producer");
  assert.deepEqual(plan.argv, [
    "--device-uid", IMMERSED_UUID,
    "--width", "1280",
    "--height", "720",
    "--pixel-format", "BGRA",
    "--manifest", "/tmp/cards; literal argv/manifest.json",
    "--expected-manifest-sha256", MANIFEST_SHA256,
  ]);
  assert.deepEqual(plan.expectedReady, {
    deviceUid: IMMERSED_UUID,
    width: WIDTH,
    height: HEIGHT,
    pixelFormat: PIXEL_FORMAT,
    manifestSha256: MANIFEST_SHA256,
  });
  assert.equal("command" in plan, false, "a shell command string is not part of the plan contract");
  assert.notEqual(plan.shell, true);

  const base = {
    executable: "/tmp/vcam-producer",
    deviceName: TARGET.name,
    deviceUid: TARGET.uuid,
    manifestPath: "/tmp/manifest.json",
    expectedManifestSha256: MANIFEST_SHA256,
    width: WIDTH,
    height: HEIGHT,
    pixelFormat: PIXEL_FORMAT,
  };
  assert.throws(() => createProducerPlan({ ...base, deviceUid: "" }), /device.*uid/i);
  assert.throws(() => createProducerPlan({ ...base, deviceUid: "not-a-uuid" }), /device.*uid|uuid/i);
  assert.throws(
    () => createProducerPlan({ ...base, deviceName: "MacBook Pro Camera" }),
    /device.*name|Immersed Camera/i,
    "the plan cannot claim a name different from the native writer's exact sink contract",
  );
  const lowercaseUidPlan = createProducerPlan({ ...base, deviceUid: IMMERSED_UUID.toLowerCase() });
  assert.equal(lowercaseUidPlan.argv[1], IMMERSED_UUID);
  assert.equal(lowercaseUidPlan.expectedReady.deviceUid, IMMERSED_UUID);
  assert.throws(() => createProducerPlan({ ...base, width: 1920 }), /1280.*720.*BGRA/i);
  assert.throws(() => createProducerPlan({ ...base, height: 1080 }), /1280.*720.*BGRA/i);
  assert.throws(() => createProducerPlan({ ...base, pixelFormat: "BGR4" }), /1280.*720.*BGRA/i);
  assert.throws(() => createProducerPlan({ ...base, expectedManifestSha256: "" }), /manifest.*sha-?256/i);
  assert.throws(() => createProducerPlan({ ...base, expectedManifestSha256: "A".repeat(64) }), /manifest.*sha-?256/i);
});

test("native writer binds the already-opened manifest bytes and bounds provider-controlled CMIO ID lists", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../scripts/macos/cmio-camera-writer.m", import.meta.url),
    "utf8",
  ));
  assert.match(source, /--expected-manifest-sha256/);
  assert.match(source, /expectedManifestSha256/);
  const loadStart = source.indexOf("static NSArray<NSData *> *LoadAndValidateFrames");
  const loadEnd = source.indexOf("static void CopyFormatAttachments", loadStart);
  const loadSource = source.slice(loadStart, loadEnd);
  assert.ok(loadStart >= 0 && loadEnd > loadStart, "manifest loader must remain inspectable");
  const safeReadIndex = loadSource.indexOf("ReadRegularFileNoFollow");
  const manifestHashIndex = loadSource.indexOf("SHA256Hex");
  const manifestParseIndex = loadSource.indexOf("NSJSONSerialization");
  assert.ok(safeReadIndex >= 0, "manifest loader must use the bounded no-follow reader");
  assert.ok(manifestHashIndex >= 0, "manifest loader must hash the opened bytes");
  assert.ok(manifestParseIndex >= 0, "manifest loader must parse authenticated JSON bytes");
  assert.ok(
    safeReadIndex < manifestHashIndex,
    "the writer hashes bytes obtained through the no-follow bounded read",
  );
  assert.ok(
    manifestHashIndex < manifestParseIndex,
    "the opened manifest bytes are authenticated before JSON parsing or frame lookup",
  );
  assert.match(loadSource, /manifest SHA-256 mismatch/i);
  assert.doesNotMatch(source, /pico-vcam-fixed-pose-sequence/);

  const idsStart = source.indexOf("static BOOL CopyObjectIDs");
  const idsEnd = source.indexOf("static NSString *FourCCString", idsStart);
  const idsSource = source.slice(idsStart, idsEnd);
  assert.match(source, /kMaximumObjectIDs\s*=\s*[0-9]+/);
  assert.match(source, /kMaximumFrames\s*=\s*16\s*;/);
  assert.match(source, /kMaximumCopiedQueueCapacity\s*=\s*[0-9]+\s*;/);
  assert.match(idsSource, /size\s*>\s*kMaximumObjectIDs\s*\*\s*sizeof\(CMIOObjectID\)/);
  assert.match(idsSource, /returnedSize\s*>\s*size/);
  assert.match(source, /CFGetTypeID\(formatDescription\)\s*!=\s*CMFormatDescriptionGetTypeID\(\)/);
  assert.match(source, /!isfinite\(frameRate\)/);
  assert.doesNotMatch(source, /CMSimpleQueueGetCapacity\(queue\)\s*!=\s*1/);
  assert.match(source, /queueCapacity\s*<=\s*0[\s\S]*queueCapacity\s*>\s*kMaximumCopiedQueueCapacity/);
  assert.match(source, /copiedQueueCapacity[^\n]*%d/);
  assert.match(source, /effectiveMaxInFlight[^\n]*1/);
  assert.match(source, /inFlightToken/);
  assert.doesNotMatch(source, /kReservedToken/);
  assert.match(source, /callbackViolation/);
  assert.match(source, /CMSimpleQueueGetCount\(queue\)[\s\S]*initially empty/);
  assert.match(source, /expectedToken\s*=\s*\(uintptr_t\)token/);
  assert.match(source, /atomic_compare_exchange[^;]*inFlightToken/);
  assert.match(source, /kCMSimpleQueueError_QueueIsFull[\s\S]*backpressured/);

  const runStart = source.indexOf("static int RunProducer");
  const runEnd = source.indexOf("int main(", runStart);
  const runSource = source.slice(runStart, runEnd);
  const cleanupStart = runSource.indexOf("cleanup:");
  const cleanupSource = runSource.slice(cleanupStart);
  assert.ok(cleanupStart >= 0, "producer cleanup must remain inspectable");
  assert.match(cleanupSource, /ReclaimStoppedQueue\(queue, state, NO\)/);
  assert.match(cleanupSource, /NormalizeExitCodeForStopRequest\(exitCode, gStopRequested\)/);
  assert.match(cleanupSource, /EmitStats\(@"shutdown-snapshot", state, NO\)/);
  assert.doesNotMatch(cleanupSource, /EmitStats\(@"final"/);
  assert.match(source, /consumerQuiescenceProven/);
  assert.doesNotMatch(
    cleanupSource,
    /CMSimpleQueueDequeue|CFRelease\((?:queue|\(CFTypeRef\)\s*token)\)|ReclaimStoppedQueue\(queue, state, YES\)/,
    "shutdown must not unconditionally drain or release provider-owned queue samples",
  );
  const sampleCreateStart = runSource.indexOf("CMSampleBufferRef sampleBuffer = CreateSampleBuffer");
  const sampleCreateEnd = runSource.indexOf(");", sampleCreateStart);
  const sampleCreateSource = runSource.slice(sampleCreateStart, sampleCreateEnd + 2);
  assert.ok(sampleCreateStart >= 0 && sampleCreateEnd > sampleCreateStart, "sample creation must remain inspectable");
  assert.match(
    runSource,
    /uint64_t sequenceNumber\s*=\s*atomic_load_explicit\(&state->enqueued,\s*memory_order_relaxed\)/,
    "CMIO sequence numbers must advance only for successfully enqueued samples",
  );
  assert.match(sampleCreateSource, /sequenceNumber/);
  assert.doesNotMatch(
    sampleCreateSource,
    /scheduled/,
    "backpressured scheduler ticks must not create gaps in the CMIO sample sequence",
  );
  const enqueueIndex = runSource.indexOf("CMSimpleQueueEnqueue");
  const stopAfterEnqueueIndex = runSource.indexOf("if (gStopRequested)", enqueueIndex);
  const readyIndex = runSource.indexOf("EmitReady", enqueueIndex);
  assert.ok(
    enqueueIndex >= 0 && stopAfterEnqueueIndex > enqueueIndex && readyIndex > stopAfterEnqueueIndex,
    "a stop racing the first enqueue must suppress readiness before downstream work can begin",
  );
  const mainStart = source.indexOf("int main(");
  const mainSource = source.slice(mainStart);
  assert.ok(mainStart >= 0, "native CLI main must remain inspectable");
  assert.doesNotMatch(mainSource, /gStopRequested\)\s*return\s+130/);
  assert.ok(
    (mainSource.match(/NormalizeExitCodeForStopRequest\([^)]*gStopRequested\)/g) ?? []).length >= 3,
    "pre-manifest, post-discovery, and probe-return paths must preserve the handled signal code",
  );
});

test("a ready fake producer runs with shell disabled and is always terminated after successful use", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  let spawnCall;
  const spawn = (executable, argv, options) => {
    spawnCall = { executable, argv, options };
    queueMicrotask(() => child.sendReady({}, 17));
    return child;
  };
  const value = await withProducer(
    plan,
    { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 },
    async (ready) => {
      assert.deepEqual(ready, { event: "ready", ...plan.expectedReady });
      assert.ok(child.stdout.listenerCount("data") >= 1, "stdout stays drained after readiness");
      return "producer-used";
    },
  );
  assert.equal(value, "producer-used");
  assert.equal(spawnCall.executable, plan.executable);
  assert.deepEqual(spawnCall.argv, plan.argv);
  assert.equal(spawnCall.options.shell, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.stdout.listenerCount("data"), 0, "stdout drain is removed after teardown");
  assert.equal(child.stderr.listenerCount("data"), 0, "stderr tail capture is removed after teardown");
});

test("non-object readiness JSON fails closed instead of escaping as a host exception", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  const spawn = () => {
    queueMicrotask(() => child.stdout.write("null\n"));
    return child;
  };
  await assert.rejects(
    withProducer(plan, { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 }, async () => {}),
    /non-object|readiness.*JSON/i,
  );
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("a post-ready child error rejects the operation path without becoming an unhandled host error", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  const spawn = () => {
    queueMicrotask(() => child.sendReady());
    return child;
  };
  let operationSettled = false;
  let operationSignal;
  await assert.rejects(
    withProducer(plan, { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 }, async (_ready, signal) => {
      operationSignal = signal;
      queueMicrotask(() => child.emit("error", new Error("producer pipe failed")));
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      operationSettled = true;
    }),
    /producer process error.*producer pipe failed/i,
  );
  assert.equal(operationSignal?.aborted, true, "producer failure aborts the in-flight operation");
  assert.equal(operationSettled, true, "withProducer joins the aborted operation before rejecting");
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("a post-ready failure bounds teardown when the operation ignores abort and handles a late rejection", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  const spawn = () => {
    queueMicrotask(() => child.sendReady());
    return child;
  };
  let rejectOperation;
  let operationSignal;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const startedAt = Date.now();
  const task = withProducer(
    plan,
    { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 10 },
    (_ready, signal) => {
      operationSignal = signal;
      queueMicrotask(() => child.emit("error", new Error("producer failed while operation ignored abort")));
      return new Promise((_resolve, reject) => { rejectOperation = reject; });
    },
  );
  let guardTimer;
  try {
    const outcome = await Promise.race([
      task.then(
        () => ({ kind: "resolved" }),
        (error) => ({ kind: "rejected", error }),
      ),
      new Promise((resolve) => {
        guardTimer = setTimeout(() => resolve({ kind: "guard-timeout" }), 500);
      }),
    ]);
    clearTimeout(guardTimer);
    if (outcome.kind === "guard-timeout") {
      rejectOperation?.(new Error("release ignored operation after failed bound"));
      await task.catch(() => {});
    }
    assert.equal(outcome.kind, "rejected", "withProducer must reject within the cleanup bound");
    assert.match(String(outcome.error?.message ?? outcome.error), /producer process error.*ignored abort/i);
    assert.equal(operationSignal?.aborted, true);
    assert.ok(Date.now() - startedAt < 500, "abort join plus TERM/KILL cleanup remains bounded");
    assert.deepEqual(child.signals, ["SIGTERM"]);

    rejectOperation?.(new Error("late ignored-operation rejection"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "a late ignored-operation rejection remains observed");
  } finally {
    clearTimeout(guardTimer);
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("an operation promise settled before a concurrent producer error remains the exact primary failure", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  const spawn = () => {
    queueMicrotask(() => child.sendReady());
    return child;
  };
  const failure = new Error("operation won the failure race");
  let rejectOperation;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const operationPromise = new Promise((_resolve, reject) => { rejectOperation = reject; });
  const task = withProducer(
    plan,
    { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 },
    () => {
      markStarted();
      return operationPromise;
    },
  );
  await started;
  rejectOperation(failure);
  child.emit("error", new Error("producer failed after operation promise settled"));
  await assert.rejects(task, (error) => error === failure);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("a producer error observed before operation rejection remains primary and observes the rejection", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  const spawn = () => {
    queueMicrotask(() => child.sendReady());
    return child;
  };
  const operationFailure = new Error("operation rejected after producer failure");
  let rejectOperation;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const operationPromise = new Promise((_resolve, reject) => { rejectOperation = reject; });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const task = withProducer(
      plan,
      { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 },
      () => {
        markStarted();
        return operationPromise;
      },
    );
    await started;
    child.emit("error", new Error("producer won the failure race"));
    rejectOperation(operationFailure);
    const caught = await task.then(
      () => assert.fail("producer-first failure must reject"),
      (error) => error,
    );
    assert.notEqual(caught, operationFailure);
    assert.match(String(caught?.message ?? caught), /producer process error.*won the failure race/i);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "the losing operation rejection remains permanently observed");
    assert.deepEqual(child.signals, ["SIGTERM"]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("a producer error emitted synchronously inside operation reserves priority over a following throw", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  const spawn = () => {
    queueMicrotask(() => child.sendReady());
    return child;
  };
  const operationFailure = new Error("synchronous operation throw came second");
  const caught = await withProducer(
    plan,
    { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 },
    () => {
      child.emit("error", new Error("synchronous producer failure came first"));
      throw operationFailure;
    },
  ).then(
    () => assert.fail("producer-first synchronous failure must reject"),
    (error) => error,
  );
  assert.notEqual(caught, operationFailure);
  assert.match(String(caught?.message ?? caught), /producer process error.*came first/i);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("a producer error emitted synchronously inside operation reserves priority over a following return", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  const spawn = () => {
    queueMicrotask(() => child.sendReady());
    return child;
  };
  const caught = await withProducer(
    plan,
    { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 },
    () => {
      child.emit("error", new Error("synchronous producer failure preceded return"));
      return Promise.resolve("operation returned too late");
    },
  ).then(
    () => assert.fail("producer-first synchronous failure must reject"),
    (error) => error,
  );
  assert.match(String(caught?.message ?? caught), /producer process error.*preceded return/i);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("stdout and stderr stream errors reject safely before readiness and abort/join after readiness", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);

  for (const streamName of ["stdout", "stderr"]) {
    const earlyChild = new FakeProducer();
    let earlyOperationCalled = false;
    const earlySpawn = () => {
      queueMicrotask(() => earlyChild[streamName].emit("error", new Error(`${streamName} early pipe failure`)));
      return earlyChild;
    };
    await assert.rejects(
      withProducer(plan, { spawn: earlySpawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 }, async () => {
        earlyOperationCalled = true;
      }),
      new RegExp(`${streamName}.*stream.*error.*early pipe failure|early pipe failure`, "i"),
    );
    assert.equal(earlyOperationCalled, false);
    assert.deepEqual(earlyChild.signals, ["SIGTERM"]);

    const liveChild = new FakeProducer();
    let liveOperationSettled = false;
    let liveSignal;
    const liveSpawn = () => {
      queueMicrotask(() => liveChild.sendReady());
      return liveChild;
    };
    await assert.rejects(
      withProducer(plan, { spawn: liveSpawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 }, async (_ready, signal) => {
        liveSignal = signal;
        queueMicrotask(() => liveChild[streamName].emit("error", new Error(`${streamName} live pipe failure`)));
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        liveOperationSettled = true;
      }),
      new RegExp(`${streamName}.*stream.*error.*live pipe failure|live pipe failure`, "i"),
    );
    assert.equal(liveSignal?.aborted, true);
    assert.equal(liveOperationSettled, true, "stream failure joins the aborted operation");
    assert.deepEqual(liveChild.signals, ["SIGTERM"]);
  }
});

test("every unexpected post-ready exit aborts and joins the operation with code, signal, and stderr context", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);

  for (const code of [0, 17]) {
    const child = new FakeProducer();
    let operationSettled = false;
    let operationSignal;
    const spawn = () => {
      queueMicrotask(() => child.sendReady());
      return child;
    };
    const caught = await withProducer(
      plan,
      { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 },
      async (_ready, signal) => {
        operationSignal = signal;
        queueMicrotask(() => {
          child.finishWithTrailingStderr(code, `writer stopped after ready (${code})\n`);
        });
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        operationSettled = true;
      },
    ).then(
      () => assert.fail(`post-ready exit ${code} must reject`),
      (error) => error,
    );
    assert.match(String(caught?.message ?? caught), /exited.*during.*operation|during.*operation.*exit/is);
    assert.match(String(caught?.message ?? caught), new RegExp(`code ${code}`));
    assert.match(String(caught?.message ?? caught), /signal null/i);
    assert.match(String(caught?.message ?? caught), new RegExp(`writer stopped after ready \\(${code}\\)`, "i"));
    assert.equal(operationSignal?.aborted, true, "unexpected exit aborts the operation signal");
    assert.equal(operationSettled, true, "withProducer joins the aborted operation before rejecting");
    assert.deepEqual(child.signals, [], "an already-exited producer receives no teardown signal");
  }
});

test("producer readiness independently validates every acquired identity/format field and cleans up", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const mismatches = [
    { deviceUid: PHYSICAL_UUID },
    { width: 1920 },
    { height: 1080 },
    { pixelFormat: "BGR4" },
    { manifestSha256: "0".repeat(64) },
  ];
  for (const mismatch of mismatches) {
    const child = new FakeProducer();
    const spawn = () => {
      queueMicrotask(() => child.sendReady(mismatch));
      return child;
    };
    await assert.rejects(
      withProducer(plan, { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 }, async () => {}),
      /ready|readiness|device.*uid|width|height|pixel.*format|BGRA/i,
    );
    assert.deepEqual(child.signals, ["SIGTERM"]);
  }
});

test("readiness timeout performs bounded SIGTERM-to-SIGKILL teardown", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer({ ignoreTerm: true });
  const startedAt = Date.now();
  await assert.rejects(
    withProducer(
      plan,
      { spawn: () => child, startupTimeoutMs: 15, shutdownTimeoutMs: 15 },
      async () => assert.fail("operation must not run before readiness"),
    ),
    /ready|readiness.*timeout|timed out/i,
  );
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(Date.now() - startedAt < 2_000, "timeout plus teardown must remain bounded");
});

test("producer exit before readiness reports the exit and stderr without launching the operation", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  let operationCalled = false;
  const spawn = () => {
    queueMicrotask(() => {
      child.finishWithTrailingStderr(23, "CoreMediaIO sink unavailable\n");
    });
    return child;
  };
  const error = await withProducer(
    plan,
    { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 },
    async () => {
      operationCalled = true;
    },
  ).then(
    () => assert.fail("early producer exit must reject"),
    (caught) => caught,
  );
  assert.match(String(error?.message ?? error), /before.*ready|early.*exit/is);
  assert.match(String(error?.message ?? error), /23/);
  assert.match(String(error?.message ?? error), /CoreMediaIO sink unavailable/i);
  assert.equal(operationCalled, false);
  assert.deepEqual(child.signals, [], "an already-exited producer needs no extra signal");
  assert.equal(child.stderr.listenerCount("data"), 0, "early-exit stderr capture is removed");
});

test("producer stderr diagnostics retain only a bounded tail", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  const spawn = () => {
    queueMicrotask(() => {
      child.stderr.write(`discarded-prefix:${"x".repeat(70_000)}:retained-tail`);
      child.finish(31);
    });
    return child;
  };
  const caught = await withProducer(
    plan,
    { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 },
    async () => assert.fail("operation must not run before readiness"),
  ).then(
    () => assert.fail("producer exit must reject"),
    (error) => error,
  );
  const diagnostic = String(caught?.message ?? caught);
  assert.doesNotMatch(diagnostic, /discarded-prefix/);
  assert.match(diagnostic, /retained-tail/);
  assert.ok(Buffer.byteLength(diagnostic, "utf8") < 66_000, "retained diagnostic stays near the 64 KiB cap");
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("dry-run never spawns or invokes the producer operation", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  let spawnCalled = false;
  let operationCalled = false;
  const result = await withProducer(
    plan,
    {
      dryRun: true,
      spawn: () => {
        spawnCalled = true;
        throw new Error("dry-run spawned");
      },
    },
    async () => {
      operationCalled = true;
    },
  );
  assert.equal(spawnCalled, false);
  assert.equal(operationCalled, false);
  assert.deepEqual(result, { dryRun: true, executable: plan.executable, argv: plan.argv });
});

test("producer teardown runs in finally and preserves an operation failure", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  const failure = new Error("capture stage failed");
  const spawn = () => {
    queueMicrotask(() => child.sendReady());
    return child;
  };
  await assert.rejects(
    withProducer(plan, { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 100 }, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("a teardown failure is attached to the preserved operation error instead of being hidden", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer({ ignoreTerm: true, ignoreKill: true });
  const failure = new Error("capture stage failed");
  const spawn = () => {
    queueMicrotask(() => child.sendReady());
    return child;
  };
  const caught = await withProducer(
    plan,
    { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 10 },
    async () => { throw failure; },
  ).then(
    () => assert.fail("operation must reject"),
    (error) => error,
  );
  assert.equal(caught, failure, "the primary operation error identity remains intact");
  assert.match(String(caught.teardownError?.message ?? ""), /SIGKILL|did not exit/i);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("teardown still escalates to SIGKILL when sending SIGTERM throws", async () => {
  const { createProducerPlan, withProducer } = await loadSut();
  const plan = makePlan(createProducerPlan);
  const child = new FakeProducer();
  child.kill = (signal = "SIGTERM") => {
    child.signals.push(signal);
    if (signal === "SIGTERM") throw new Error("TERM delivery failed");
    child.finish(null, signal);
    return true;
  };
  const spawn = () => {
    queueMicrotask(() => child.sendReady());
    return child;
  };
  const value = await withProducer(
    plan,
    { spawn, startupTimeoutMs: 100, shutdownTimeoutMs: 10 },
    async () => "operation-complete",
  );
  assert.equal(value, "operation-complete");
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

const roomBase = () => {
  // A deterministic non-uniform "photographic" base: gradients in all three channels so a stamp
  // has to supply its own contrast rather than inheriting the card's black background.
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      pixels[offset] = (x * 7 + y * 3) % 256;
      pixels[offset + 1] = (x * 3 + y * 11) % 256;
      pixels[offset + 2] = (x * 13 + y * 5) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
};

const PROVENANCE = {
  worldModel: { splatPath: "/abs/world.ply", splatSha256: "1a".repeat(32), offsetApplied: [0, 0.775604248046875, 0] },
  pose: { position: [0.034, 1.896, 0.147], target: [0.034, 1.7224, -0.8378], frame: "app" },
  intrinsics: { f: 914.01, cx: 640, cy: 360, fovDeg: 70 },
  renderer: { script: "/abs/splat_perspective.py", scriptSha256: "2b".repeat(32), pointsRendered: 500000 },
  baseFrameSha256: "3c".repeat(32),
};

// The counter digit run: drawText(..., String(counter).padStart(6, "0"), COUNTER_REGION.x + 38,
// COUNTER_REGION.y + 76, 5, white) — 6 characters at a 6*scale=30px advance (width 180), 7 glyph
// rows at scale 5 (height 35). This is the operator's only human-legible readout of the counter
// value, and the liveness bar must never draw into it.
const DIGIT_BOX = { x: COUNTER_REGION.x + 38, y: COUNTER_REGION.y + 76, width: 180, height: 35 };

test("fixed-pose frames change ONLY inside the counter region, and change a lot", async () => {
  const { createFixedPoseSequence } = await loadSut();
  const base = roomBase();
  const counters = Array.from({ length: 16 }, (_, index) => index);
  const sequence = createFixedPoseSequence({
    basePixels: base, nonce: NONCE, counters,
    width: WIDTH, height: HEIGHT, pixelFormat: PIXEL_FORMAT, provenance: PROVENANCE,
  });
  assert.equal(sequence.frames.length, 16);
  sequence.frames.forEach((frame, index) => assertCardFrame(frame, index));

  // The bar must not overdraw the digit row (COUNTER_REGION.x+38..+218, .y+76..+111) — legibility
  // took priority over raw pixel count after an earlier version bought its delta by covering the
  // digits entirely (an operator could see two frames differed but not which counters they were).
  // With the bar confined below the digit row, measuring all 15 adjacent pairs over this exact
  // roomBase() gives a minimum of 715 changed pixels (pair 8->9) and a maximum of 1250 (pair 9->10).
  // 700 is used as the floor: comfortably below the measured 715 (small integer margin, not a
  // knife-edge), and ~9x the card's own worst case of 75.
  for (let index = 1; index < sequence.frames.length; index += 1) {
    const previous = sequence.frames[index - 1].pixels;
    const current = sequence.frames[index].pixels;
    assert.equal(
      countChangedPixels(previous, current, COUNTER_REGION, false), 0,
      `counters ${index - 1}->${index} must not change a pixel outside the counter panel`,
    );
    assert.ok(
      countChangedPixels(previous, current, COUNTER_REGION, true) >= 700,
      `counters ${index - 1}->${index} must change >=700 pixels (measured minimum is 715); the card's own worst pair is only 75`,
    );
  }
});

test("the digit readout inside COUNTER_REGION stays legible: the bar changes without overdrawing it", async () => {
  const { stampFrame } = await loadSut();
  const base = roomBase();
  const frameA = stampFrame(base, { nonce: NONCE, counter: 3 });
  const frameB = stampFrame(base, { nonce: NONCE, counter: 9 });

  for (const [label, frame] of [["counter 3", frameA], ["counter 9", frameB]]) {
    const colors = new Set();
    for (let y = DIGIT_BOX.y; y < DIGIT_BOX.y + DIGIT_BOX.height; y += 1) {
      for (let x = DIGIT_BOX.x; x < DIGIT_BOX.x + DIGIT_BOX.width; x += 1) {
        const offset = (y * WIDTH + x) * 4;
        colors.add(`${frame[offset]},${frame[offset + 1]},${frame[offset + 2]},${frame[offset + 3]}`);
      }
    }
    assert.ok(colors.has("0,0,0,255"), `${label}: digit box must retain its black background`);
    assert.ok(
      colors.has("255,255,255,255"),
      `${label}: digit box must retain white glyph pixels — the counter must stay human-readable`,
    );
    assert.ok(
      !colors.has("0,255,255,255"),
      `${label}: the liveness bar (yellow) must not intrude into the digit box`,
    );
  }

  let differing = 0;
  for (let y = DIGIT_BOX.y; y < DIGIT_BOX.y + DIGIT_BOX.height; y += 1) {
    for (let x = DIGIT_BOX.x; x < DIGIT_BOX.x + DIGIT_BOX.width; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      if (
        frameA[offset] !== frameB[offset] ||
        frameA[offset + 1] !== frameB[offset + 1] ||
        frameA[offset + 2] !== frameB[offset + 2]
      ) differing += 1;
    }
  }
  assert.ok(
    differing > 0,
    "the digit box itself must change between two different counters — it is legible content, not a frozen decoration",
  );
});

test("the stamp preserves room pixels outside the stamped regions", async () => {
  const { stampFrame } = await loadSut();
  const base = roomBase();
  const stamped = stampFrame(base, { nonce: NONCE, counter: 3 });
  assert.notEqual(stamped, base, "stampFrame must not mutate its input");
  assert.equal(base.equals(roomBase()), true, "the caller's buffer is untouched");
  let differing = 0;
  for (let offset = 0; offset < base.length; offset += 4) if (base[offset] !== stamped[offset]) differing += 1;
  assert.ok(differing > 0 && differing < WIDTH * HEIGHT * 0.25, "a stamp covers some of the frame, not most of it");
});

test("fixed-pose manifest carries validated provenance and the reserved kind", async () => {
  const { createFixedPoseSequence } = await loadSut();
  const sequence = createFixedPoseSequence({
    basePixels: roomBase(), nonce: NONCE, counters: [0, 1],
    width: WIDTH, height: HEIGHT, pixelFormat: PIXEL_FORMAT, provenance: PROVENANCE,
  });
  assert.equal(sequence.manifest.kind, "pico-vcam-fixed-pose-sequence");
  assert.equal(sequence.manifest.schemaVersion, 1);
  assert.deepEqual(sequence.manifest.counterRegion, COUNTER_REGION);
  assert.deepEqual(sequence.manifest.provenance, PROVENANCE);
  assert.equal(sequence.manifestJson, `${JSON.stringify(sequence.manifest, null, 2)}\n`);
  assert.equal(sequence.manifestSha256, sha256(Buffer.from(sequence.manifestJson, "utf8")));

  const repeated = createFixedPoseSequence({
    basePixels: roomBase(), nonce: NONCE, counters: [0, 1],
    width: WIDTH, height: HEIGHT, pixelFormat: PIXEL_FORMAT, provenance: PROVENANCE,
  });
  assert.equal(repeated.manifestSha256, sequence.manifestSha256, "generation is deterministic");

  for (const bad of [
    { ...PROVENANCE, baseFrameSha256: "NOTHEX" },
    { ...PROVENANCE, pose: { ...PROVENANCE.pose, frame: "splat" } },
    { ...PROVENANCE, pose: { ...PROVENANCE.pose, target: undefined, yawDeg: 0, pitchDeg: 20 } },
    { ...PROVENANCE, intrinsics: { ...PROVENANCE.intrinsics, fovDeg: 0 } },
    // assertVec3 failure modes on worldModel.offsetApplied and pose.position specifically, not just
    // the fields already covered above.
    { ...PROVENANCE, worldModel: { ...PROVENANCE.worldModel, offsetApplied: [0, 1] } },
    { ...PROVENANCE, pose: { ...PROVENANCE.pose, position: [0, Infinity, 0] } },
    { ...PROVENANCE, pose: { ...PROVENANCE.pose, position: "not-an-array" } },
  ]) {
    assert.throws(
      () => createFixedPoseSequence({
        basePixels: roomBase(), nonce: NONCE, counters: [0],
        width: WIDTH, height: HEIGHT, pixelFormat: PIXEL_FORMAT, provenance: bad,
      }),
      /provenance|frame|target|fovDeg|sha256/i,
      `provenance must be rejected: ${JSON.stringify(bad).slice(0, 80)}`,
    );
  }
});

test("the reviewed test-card golden is unaffected by the fixed-pose path", async () => {
  const { createTestCardSequence } = await loadSut();
  const retained = createTestCardSequence({
    nonce: NONCE, counters: [0, 1, 2, 3], width: WIDTH, height: HEIGHT, pixelFormat: PIXEL_FORMAT,
  });
  assert.equal(retained.manifestSha256, "d3f6c4869a4804ef95cd80f8a12a5b4c0511b3dfc1c3c5bc2454da02a1751d4f");
});
