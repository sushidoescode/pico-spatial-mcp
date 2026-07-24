// v29.1 host-camera source-readback boundary report.
//
// A pure, platform-independent, fail-closed model of the boundary chain proven (or refuted) between
// a deterministic source card and a CameraPeek preview. It carries no camera, CoreMediaIO,
// AVFoundation, emulator, or wall-clock dependency — the orchestration in this module drives only
// injected operations, so it runs unchanged on Linux CI.
//
// The four terminal states are first-class and never collapsed: `passed` (did its job, and for a
// readback delivered two visibly different counters), `failed` (ran but did not), `blocked` (an
// authorization or contract gate stopped it — never a failure), and `skipped` (a prerequisite did
// not pass, so it was never attempted). CMIO and AVFoundation are sibling consumers of the source;
// a CMIO-branch non-pass can never suppress or invalidate a safe AVFoundation result.

export const STAGE_IDS = [
  "source",
  "cmioSink",
  "cmioAuthorization",
  "cmioSource",
  "avfAuthorization",
  "avFoundation",
  "qemuAuthorization",
  "emulatorRoute",
  "cameraPeek",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

// Operationally honest dependency edges. The read-only authorization query and the sink producer
// are independent children of the source card: writing frames into the Immersed *output* sink needs
// no camera-read permission, and querying `authorizationStatusForMediaType:` needs no sink. Each
// readback then requires BOTH its client authorization AND a publishing sink. This matches the live
// order — authorization-only check first, producer started only if authorized — so timestamps stay
// monotonic along every edge. `blocked` never appears where a prerequisite did not pass.
export const STAGE_DEPENDENCIES: Readonly<Record<StageId, readonly StageId[]>> = Object.freeze({
  source: [],
  cmioSink: ["source"],
  cmioAuthorization: ["source"],
  avfAuthorization: ["source"],
  cmioSource: ["cmioAuthorization", "cmioSink"],
  avFoundation: ["avfAuthorization", "cmioSink"],
  qemuAuthorization: ["avFoundation"],
  emulatorRoute: ["qemuAuthorization"],
  cameraPeek: ["emulatorRoute"],
});

const AUTH_STAGES: ReadonlySet<StageId> = new Set(["cmioAuthorization", "avfAuthorization", "qemuAuthorization"]);
const READBACK_STAGES: ReadonlySet<StageId> = new Set(["cmioSource", "avFoundation", "cameraPeek"]);

export type StageState = "passed" | "failed" | "blocked" | "skipped";
export type AuthStatus = "authorized" | "notDetermined" | "denied" | "restricted";
export type Delivery = "none" | "static" | "changing";

const STATES: ReadonlySet<string> = new Set(["passed", "failed", "blocked", "skipped"]);
const AUTH_STATUSES: ReadonlySet<string> = new Set(["authorized", "notDetermined", "denied", "restricted"]);
const DELIVERIES: ReadonlySet<string> = new Set(["none", "static", "changing"]);

export type ArtifactRef = { path: string; bytes: number; sha256: string };

export type StageResult = {
  state: StageState;
  startedAtMs: number;
  endedAtMs: number;
  authStatus?: AuthStatus;
  delivery?: Delivery;
  recognizedCounters?: number[];
  artifacts?: ArtifactRef[];
  error?: string;
  note?: string;
};

export type ExecutableProvenance = { executable: string; argv: string[]; sha256: string };

export type BoundaryReport = {
  runId: string;
  source: {
    manifestPath: string;
    manifestSha256: string;
    nonce: string;
    width: 1280;
    height: 720;
    pixelFormat: "BGRA";
  };
  device: { name: string; uuid: string };
  reader: ExecutableProvenance;
  producer: ExecutableProvenance;
  stages: Record<StageId, StageResult>;
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

function fail(message: string): never {
  throw new Error(`invalid vcam boundary report: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function distinctCount(counters: number[]): number {
  return new Set(counters).size;
}

function validateProvenance(label: string, value: unknown): void {
  if (!isObject(value)) fail(`${label} provenance is required`);
  if (typeof value.executable !== "string" || !value.executable.startsWith("/")) {
    fail(`${label}.executable must be an absolute path`);
  }
  if (!Array.isArray(value.argv) || value.argv.some((entry) => typeof entry !== "string")) {
    fail(`${label}.argv must be an array of strings`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_RE.test(value.sha256)) {
    fail(`${label}.sha256 must be 64 lowercase hex characters (SHA-256)`);
  }
}

function validateArtifacts(stageId: StageId, artifacts: unknown): void {
  if (artifacts === undefined) return;
  if (!Array.isArray(artifacts)) fail(`stage ${stageId} artifacts must be an array`);
  artifacts.forEach((artifact, index) => {
    const where = `stage ${stageId} artifact ${index}`;
    if (!isObject(artifact)) fail(`${where} must be an object`);
    if (!nonEmptyString(artifact.path)) fail(`${where} path must be a non-empty string`);
    if (typeof artifact.bytes !== "number" || !Number.isInteger(artifact.bytes) || artifact.bytes < 0) {
      fail(`${where} bytes must be a non-negative integer byte length`);
    }
    if (typeof artifact.sha256 !== "string" || !SHA256_RE.test(artifact.sha256)) {
      fail(`${where} sha256 must be 64 lowercase hex characters (SHA-256)`);
    }
  });
}

function validateRecognizedCounters(stageId: StageId, counters: unknown): number[] {
  if (counters === undefined) return [];
  if (!Array.isArray(counters) || counters.some((c) => typeof c !== "number" || !Number.isInteger(c) || c < 0)) {
    fail(`stage ${stageId} recognizedCounters must be an array of non-negative integers`);
  }
  return counters as number[];
}

function validateAuthStage(stageId: StageId, stage: StageResult): void {
  if (stage.state === "failed") {
    fail(`authorization stage ${stageId} may never be failed; a non-authorized status is blocked, not failed`);
  }
  if (!AUTH_STATUSES.has(stage.authStatus as string)) {
    fail(`authorization stage ${stageId} must carry a valid authStatus`);
  }
  if (stage.authStatus === "authorized" && stage.state !== "passed") {
    fail(`authorization stage ${stageId} is authorized but not passed`);
  }
  if (stage.authStatus !== "authorized" && stage.state !== "blocked") {
    fail(`authorization stage ${stageId} status ${stage.authStatus} must be blocked, not ${stage.state}`);
  }
}

function validateReadbackStage(stageId: StageId, stage: StageResult): void {
  const counters = validateRecognizedCounters(stageId, stage.recognizedCounters);
  const delivery = stage.delivery ?? "none";
  if (!DELIVERIES.has(delivery)) fail(`readback stage ${stageId} delivery must be none, static, or changing`);

  // A changing delivery is the liveness claim itself, so it is reserved for a pass, and a pass must
  // be a changing delivery — the two are equivalent and cannot drift apart.
  if (delivery === "changing" && stage.state !== "passed") {
    fail(`readback stage ${stageId} delivery is 'changing' but state is ${stage.state}, not passed`);
  }
  if (stage.state === "passed" && delivery !== "changing") {
    fail(`readback stage ${stageId} is passed but delivery is ${delivery}, not 'changing'`);
  }

  if (stage.state === "passed") {
    if (distinctCount(counters) < 2) {
      fail(`readback stage ${stageId} passed but has fewer than two distinct recognized counters`);
    }
    if (!Array.isArray(stage.artifacts) || stage.artifacts.length < 2) {
      fail(`readback stage ${stageId} passed but retained fewer than two captures showing the counters`);
    }
    // Two array entries are not enough: byte-identical captures cannot prove two visibly different
    // counters (this was v28.4's exact negative signature). Every distinct counter claimed must be
    // backed by a distinct retained frame.
    const distinctCaptures = new Set(stage.artifacts.map((artifact) => artifact.sha256)).size;
    if (distinctCaptures < distinctCount(counters)) {
      fail(`readback stage ${stageId} passed but its retained captures are not all distinct; byte-identical frames cannot prove ${distinctCount(counters)} visibly different counters`);
    }
  } else if (stage.state === "failed") {
    if (delivery === "static" && distinctCount(counters) !== 1) {
      fail(`readback stage ${stageId} static delivery must recognize exactly one counter`);
    }
    if (delivery === "none" && counters.length !== 0) {
      fail(`readback stage ${stageId} delivered no card yet recognized a counter`);
    }
  } else if (stage.state === "blocked") {
    if (delivery !== "none") fail(`readback stage ${stageId} is blocked and cannot claim a delivery`);
    if (counters.length !== 0) fail(`readback stage ${stageId} is blocked and cannot recognize counters`);
  }
}

function validateStageShape(stageId: StageId, stage: unknown): asserts stage is StageResult {
  if (!isObject(stage)) fail(`stage ${stageId} must be an object`);
  if (typeof stage.state !== "string" || !STATES.has(stage.state)) {
    fail(`stage ${stageId} has invalid state ${JSON.stringify(stage.state)}`);
  }
  if (!finiteNumber(stage.startedAtMs)) fail(`stage ${stageId} startedAtMs must be a finite number`);
  if (!finiteNumber(stage.endedAtMs)) fail(`stage ${stageId} endedAtMs must be a finite number`);
  if (stage.endedAtMs < stage.startedAtMs) fail(`stage ${stageId} endedAtMs must not precede startedAtMs`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export function validateBoundaryReport(report: unknown): BoundaryReport {
  if (!isObject(report)) fail("report must be an object");
  if (!nonEmptyString(report.runId)) fail("runId must be a non-empty string");

  const source = report.source;
  if (!isObject(source)) fail("source is required");
  if (typeof source.manifestPath !== "string" || !source.manifestPath.startsWith("/")) {
    fail("source.manifestPath must be an absolute path");
  }
  if (typeof source.manifestSha256 !== "string" || !SHA256_RE.test(source.manifestSha256)) {
    fail("source.manifestSha256 must be 64 lowercase hex characters (SHA-256)");
  }
  if (!nonEmptyString(source.nonce)) fail("source.nonce must be a non-empty string");
  if (source.width !== 1280 || source.height !== 720 || source.pixelFormat !== "BGRA") {
    fail("source must be exactly 1280x720 BGRA");
  }

  const device = report.device;
  if (!isObject(device)) fail("device is required");
  if (!nonEmptyString(device.name)) fail("device.name must be a non-empty string");
  if (typeof device.uuid !== "string" || !UUID_RE.test(device.uuid)) fail("device.uuid must be a valid UUID");
  if (device.uuid !== device.uuid.toUpperCase()) {
    fail("device.uuid must be stored case-normalized (uppercase), not as a raw observation");
  }

  validateProvenance("reader", report.reader);
  validateProvenance("producer", report.producer);

  const stages = report.stages;
  if (!isObject(stages)) fail("stages is required");
  for (const key of Object.keys(stages)) {
    if (!(STAGE_IDS as readonly string[]).includes(key)) fail(`unknown stage: ${key}`);
  }
  for (const stageId of STAGE_IDS) {
    if (!(stageId in stages)) fail(`missing stage: ${stageId}`);
    validateStageShape(stageId, stages[stageId]);
  }

  const typed = stages as Record<StageId, StageResult>;

  // Dependency and monotonicity: a reached stage (passed/failed/blocked) requires every
  // prerequisite to have passed and to have finished before it started. `skipped` is always
  // permissible — it means the stage was never attempted.
  for (const stageId of STAGE_IDS) {
    const stage = typed[stageId];
    if (stage.state === "skipped") continue;
    for (const prereq of STAGE_DEPENDENCIES[stageId]) {
      if (typed[prereq].state !== "passed") {
        fail(`stage ${stageId} is ${stage.state} but prerequisite ${prereq} did not pass; it must be skipped`);
      }
      if (stage.startedAtMs < typed[prereq].endedAtMs) {
        fail(`stage ${stageId} started before its prerequisite ${prereq} finished`);
      }
    }
  }

  // Per-stage semantic rules. Artifact shape and off-class over-claim are checked universally
  // (even for skipped stages); auth/readback semantics only for stages that were actually reached.
  for (const stageId of STAGE_IDS) {
    const stage = typed[stageId];
    validateArtifacts(stageId, stage.artifacts);
    if (!AUTH_STAGES.has(stageId) && stage.authStatus !== undefined) {
      fail(`stage ${stageId} is not an authorization stage and cannot carry authStatus (over-claim)`);
    }
    if (!READBACK_STAGES.has(stageId) && (stage.delivery !== undefined || stage.recognizedCounters !== undefined)) {
      fail(`stage ${stageId} is not a readback stage and cannot carry delivery or recognizedCounters (over-claim)`);
    }
    if (stage.state === "skipped") continue;
    if (AUTH_STAGES.has(stageId)) validateAuthStage(stageId, stage);
    if (READBACK_STAGES.has(stageId)) validateReadbackStage(stageId, stage);
  }

  return deepFreeze(report as BoundaryReport);
}

/**
 * The only end-to-end injected-pixel claim v29.1 admits: a looked-at CameraPeek preview that passed
 * a changing-card delivery. Any host-only pass (AVFoundation, CMIO) is narrower and never
 * end-to-end. Callers still owe a personal LOOK before recording anything as vision_verified.
 */
export function isEndToEndVisionVerified(report: BoundaryReport): boolean {
  const peek = report.stages.cameraPeek;
  return peek.state === "passed" && peek.delivery === "changing";
}

// --------------------------------------------------------------------------------------------
// Orchestration
//
// runHostBoundary drives the host-side boundary chain (source → sink → CMIO/AVFoundation readback)
// through injected operations, so it is fully CI-safe. It NEVER decides pixels itself: the caller
// hands it looked-at reader outcomes and it classifies them, always emitting a complete, validated
// report. Producer teardown, abort-on-failure, bounded grace, and rejection observation belong to
// `runProducer` (in production, `withProducer` from vcamtransport); each real reader is internally
// bounded (finite frame/time limits). The qemu-and-beyond stages are always `skipped` here — they
// belong to the separately gated emulator/CameraPeek phase.
// --------------------------------------------------------------------------------------------

export type ReadbackOutcome = {
  delivery: Delivery;
  recognizedCounters: number[];
  artifacts: ArtifactRef[];
};

export type HostBoundaryDeps = {
  identity: {
    runId: string;
    source: BoundaryReport["source"];
    device: { name: string; uuid: string };
    reader: ExecutableProvenance;
    producer: ExecutableProvenance;
  };
  /** Monotonic-ish millisecond clock. Injected so the orchestrator stays pure and deterministic. */
  clock: () => number;
  /** Read-only camera authorization status of the shared host-reader executable. Never prompts. */
  checkAuthorization: (signal: AbortSignal) => Promise<AuthStatus>;
  /** Whether direct CMIO client sample readback's ownership contract is established. v29.1: false. */
  cmioContractAdmitted: boolean;
  /** Runs `op` while the sink producer is healthy and tears the producer down afterward. */
  runProducer: <T>(op: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  /** Proves ongoing Immersed sink enqueue/removal; resolves with any retained structural artifacts. */
  proveSink: (signal: AbortSignal) => Promise<{ artifacts?: ArtifactRef[] }>;
  /** Optional bounded direct CMIO reader; only invoked when `cmioContractAdmitted` is true. */
  readCmioSource?: (signal: AbortSignal) => Promise<ReadbackOutcome>;
  /** The required host gate: a bounded AVFoundation readback. */
  readAvFoundation: (signal: AbortSignal) => Promise<ReadbackOutcome>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWellFormedArtifact(value: unknown): value is ArtifactRef {
  return isObject(value)
    && nonEmptyString(value.path)
    && typeof value.bytes === "number" && Number.isInteger(value.bytes) && value.bytes >= 0
    && typeof value.sha256 === "string" && SHA256_RE.test(value.sha256);
}

/**
 * Classifies a looked-at reader outcome into a readback stage, never over-claiming liveness. Reader
 * output is untrusted: malformed counters or captures are demoted to a failed stage rather than
 * propagated into the whole-report validator, so runHostBoundary always returns a complete report
 * (and never discards a valid sibling branch). The pass condition mirrors validateReadbackStage
 * exactly — two distinct counters, each backed by a distinct retained capture.
 */
function classifyReadback(started: number, ended: number, outcome: ReadbackOutcome): StageResult {
  const rawCounters = outcome.recognizedCounters;
  const rawArtifacts = outcome.artifacts;
  const countersWellFormed = Array.isArray(rawCounters)
    && rawCounters.every((counter) => typeof counter === "number" && Number.isInteger(counter) && counter >= 0);
  const artifactsWellFormed = Array.isArray(rawArtifacts) && rawArtifacts.every(isWellFormedArtifact);
  if (!countersWellFormed || !artifactsWellFormed) {
    return { state: "failed", delivery: "none", recognizedCounters: [], artifacts: [], error: "reader returned malformed output; no changing delivery substantiated", startedAtMs: started, endedAtMs: ended };
  }

  const counters = rawCounters;
  const artifacts = rawArtifacts;
  const distinct = new Set(counters).size;
  const distinctCaptures = new Set(artifacts.map((artifact) => artifact.sha256)).size;
  if (outcome.delivery === "changing" && distinct >= 2 && artifacts.length >= 2 && distinctCaptures >= distinct) {
    return { state: "passed", delivery: "changing", recognizedCounters: [...counters], artifacts, startedAtMs: started, endedAtMs: ended };
  }
  if (distinct === 1) {
    return {
      state: "failed",
      delivery: "static",
      recognizedCounters: [counters[0]],
      artifacts,
      error: "static delivery only; liveness did not pass (need two distinct counters with distinct captures)",
      startedAtMs: started,
      endedAtMs: ended,
    };
  }
  // No recognizable card, or counters without matching distinct retained captures — neither
  // substantiates a changing delivery. Record the honest "none" and keep the raw count in the note.
  return {
    state: "failed",
    delivery: "none",
    recognizedCounters: [],
    artifacts,
    error: "no changing card delivered",
    note: distinct >= 2 ? `observed ${distinct} counters but fewer than ${distinct} distinct retained captures` : undefined,
    startedAtMs: started,
    endedAtMs: ended,
  };
}

export async function runHostBoundary(deps: HostBoundaryDeps): Promise<BoundaryReport> {
  const now = deps.clock;
  const stages = {} as Record<StageId, StageResult>;
  const skipped = (): StageResult => { const t = now(); return { state: "skipped", startedAtMs: t, endedAtMs: now() }; };

  const sourceStart = now();
  stages.source = { state: "passed", startedAtMs: sourceStart, endedAtMs: now() };

  // Authorization is a read-only query of the shared executable. An error while querying is
  // fail-closed: unknown authorization is treated as not-authorized and blocks, never fails.
  const authStart = now();
  let status: AuthStatus;
  let authError: string | undefined;
  const controller = new AbortController();
  try {
    status = await deps.checkAuthorization(controller.signal);
  } catch (error) {
    status = "notDetermined";
    authError = `authorization query failed: ${errorMessage(error)}`;
  }
  // Fail closed: an unmapped status (a native TCC value the reader did not normalize) is treated as
  // not-authorized and blocks, exactly like a thrown query — it never slips through as authorized.
  if (!AUTH_STATUSES.has(status)) {
    authError = authError ?? `unmapped authorization status: ${String(status)}`;
    status = "notDetermined";
  }
  const authEnd = now();
  const authorized = status === "authorized";
  const authStage = (): StageResult => ({
    state: authorized ? "passed" : "blocked",
    authStatus: status,
    error: authError,
    startedAtMs: authStart,
    endedAtMs: authEnd,
  });
  stages.cmioAuthorization = authStage();
  stages.avfAuthorization = authStage();

  if (!authorized) {
    stages.cmioSink = skipped();
    stages.cmioSource = skipped();
    stages.avFoundation = skipped();
    stages.qemuAuthorization = skipped();
    stages.emulatorRoute = skipped();
    stages.cameraPeek = skipped();
    return validateBoundaryReport({ ...deps.identity, stages });
  }

  let cmioSink: StageResult | undefined;
  let cmioSource: StageResult | undefined;
  let avFoundation: StageResult | undefined;

  try {
    await deps.runProducer(async (signal) => {
      const sinkStart = now();
      let sinkArtifacts: ArtifactRef[] | undefined;
      try {
        const proof = await deps.proveSink(signal);
        sinkArtifacts = proof.artifacts;
      } catch (error) {
        cmioSink = { state: "failed", error: `sink not proven: ${errorMessage(error)}`, startedAtMs: sinkStart, endedAtMs: now() };
        return;
      }
      cmioSink = { state: "passed", artifacts: sinkArtifacts, startedAtMs: sinkStart, endedAtMs: now() };

      // CMIO and AVFoundation are independent sibling consumers. allSettled isolates them so a CMIO
      // failure can never reject the AVFoundation branch.
      const runCmio = async (): Promise<StageResult> => {
        const start = now();
        if (!deps.cmioContractAdmitted || !deps.readCmioSource) {
          return { state: "blocked", delivery: "none", error: "direct CMIO input-sample ownership contract is undocumented", startedAtMs: start, endedAtMs: now() };
        }
        try {
          const outcome = await deps.readCmioSource(signal);
          return classifyReadback(start, now(), outcome);
        } catch (error) {
          return { state: "failed", delivery: "none", recognizedCounters: [], error: `cmio readback failed: ${errorMessage(error)}`, startedAtMs: start, endedAtMs: now() };
        }
      };
      const runAvf = async (): Promise<StageResult> => {
        const start = now();
        try {
          const outcome = await deps.readAvFoundation(signal);
          return classifyReadback(start, now(), outcome);
        } catch (error) {
          return { state: "failed", delivery: "none", recognizedCounters: [], error: `avfoundation readback failed: ${errorMessage(error)}`, startedAtMs: start, endedAtMs: now() };
        }
      };

      const [cmioResult, avfResult] = await Promise.all([runCmio(), runAvf()]);
      cmioSource = cmioResult;
      avFoundation = avfResult;
    });
  } catch (error) {
    if (!cmioSink) {
      cmioSink = { state: "failed", error: `producer failed: ${errorMessage(error)}`, startedAtMs: now(), endedAtMs: now() };
    }
  }

  // Assemble any stages the operation could not reach (producer/sink failure, or an abort that
  // interrupted a readback before it recorded a result).
  const sinkPassed = cmioSink?.state === "passed";
  stages.cmioSink = cmioSink ?? { state: "failed", error: "producer did not prove the sink", startedAtMs: now(), endedAtMs: now() };
  stages.cmioSource = cmioSource ?? (sinkPassed
    ? { state: "failed", delivery: "none", recognizedCounters: [], error: "cmio readback interrupted before completion", startedAtMs: now(), endedAtMs: now() }
    : skipped());
  stages.avFoundation = avFoundation ?? (sinkPassed
    ? { state: "failed", delivery: "none", recognizedCounters: [], error: "avfoundation readback interrupted before completion", startedAtMs: now(), endedAtMs: now() }
    : skipped());
  stages.qemuAuthorization = skipped();
  stages.emulatorRoute = skipped();
  stages.cameraPeek = skipped();

  return validateBoundaryReport({ ...deps.identity, stages });
}
