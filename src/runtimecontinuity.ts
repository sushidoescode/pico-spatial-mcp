import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseForegroundActivities,
  parseInstalledApkPath,
  parsePid,
  parseProcStartTicks,
  parseRemoteSha256,
} from "./nativefleetreceipt.js";
import { assertExternalCapturePath } from "./observation.js";
import { run, type RunResult } from "./util.js";

export const BOUNDARY_PROBE_V1_PREFIX = "PICO_BOUNDARY_PROBE_V1 ";
export const SPATIAL_SHELL_RESUMED_COMPONENT =
  "com.pxr.scenarioprovider/com.unity3d.player.UnityPlayerActivity";
/** Shared with navigation's conservative preflight; real sampler work must finish below this. */
export const APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS = 10_000;
export const APPLICATION_CONTINUITY_ADB_PROBE_TIMEOUT_MS = 4_000;
export const APPLICATION_CONTINUITY_LOG_READ_TIMEOUT_MS = 8_000;
export const APPLICATION_CONTINUITY_WORK_BUDGET_MS = 9_000;
export const APPLICATION_CONTINUITY_LOG_MAX_LINES = 65_536;
export const APPLICATION_CONTINUITY_LOG_MAX_BYTES = 64 * 1024 * 1024;

const BOUNDARY_EVENT_KINDS = new Set([
  "command_received",
  "stage_open_requested",
  "stage_open_returned",
  "explicit_close_requested",
  "explicit_close_returned",
  "lifecycle",
  "focus",
] as const);
const LIFECYCLE_KINDS = new Set([
  "ON_CREATE",
  "ON_START",
  "ON_RESUME",
  "ON_PAUSE",
  "ON_STOP",
  "ON_DESTROY",
] as const);
const EVENT_KEYS = new Set([
  "schemaVersion",
  "sessionId",
  "generation",
  "seq",
  "monotonicNs",
  "kind",
  "lifecycle",
  "requestedDynamicStageStyle",
  "detail",
]);
const MAX_BOUNDARY_LINE_BYTES = 16 * 1024;
const MAX_BOUNDARY_DETAIL_BYTES = 512;
const MAX_LOG_BYTES = APPLICATION_CONTINUITY_LOG_MAX_BYTES;
const MAX_STDERR_BYTES = 64 * 1024;
const TEXT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const COMMAND_TAIL_BYTES = 64 * 1024;

export type BoundaryProbeEventKind =
  | "command_received"
  | "stage_open_requested"
  | "stage_open_returned"
  | "explicit_close_requested"
  | "explicit_close_returned"
  | "lifecycle"
  | "focus";

export type BoundaryProbeLifecycle =
  | "ON_CREATE"
  | "ON_START"
  | "ON_RESUME"
  | "ON_PAUSE"
  | "ON_STOP"
  | "ON_DESTROY";

export interface BoundaryProbeEventV1 {
  schemaVersion: 1;
  sessionId: string;
  generation: number;
  seq: number;
  monotonicNs: string;
  kind: BoundaryProbeEventKind;
  lifecycle?: BoundaryProbeLifecycle;
  requestedDynamicStageStyle?: "Full";
  detail?: string;
}

export type BoundaryProbeParseResult =
  | { status: "ok"; event: BoundaryProbeEventV1; rawLine: string }
  | { status: "absent" | "malformed" | "truncated"; event: null; rawLine: string };

export type ProbeSequenceIssue =
  | { kind: "gap" | "duplicate" | "out_of_order"; expectedSeq: number; observedSeq: number }
  | { kind: "wrong_session"; expectedSessionId: string; observedSessionId: string }
  | { kind: "wrong_generation"; expectedGeneration: number; observedGeneration: number }
  | { kind: "missing_prior"; observedSeq: number };

export interface BoundaryProbeSequenceResult {
  status: "complete" | "gap" | "wrong_session" | "wrong_generation" | "unknown";
  priorSeq: number | null;
  lastSeq: number | null;
  issues: ProbeSequenceIssue[];
}

export interface WatchdogObservation {
  status: "advancing" | "stalled" | "absent" | "unparsed";
  focus?: string;
  lastRenderTime?: string;
  rawLines: string[];
}

export interface WatchdogCursor {
  focus: string;
  lastRenderTime: string;
}

export interface ApplicationContinuitySample {
  observedAtMonotonicNs: string;
  serial: string;
  bootId: string;
  packageName: string;
  allowedResumedComponents: string[];
  apkSha256: string;
  pid: number | null;
  pidStartTicks: string | null;
  resumedComponents: string[];
  foreground: "exact_allowed" | "same_package_unlisted" | "different_package" | "absent" | "unknown";
  probeEventsSincePrior: BoundaryProbeEventV1[];
  probeParse: "ok" | "absent" | "malformed" | "truncated";
  probeSequence: "complete" | "gap" | "wrong_session" | "wrong_generation" | "unknown";
  watchdog: {
    status: "advancing" | "stalled" | "absent" | "unparsed";
    focus?: string;
    lastRenderTime?: string;
  };
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validBoundaryEvent(value: unknown): value is BoundaryProbeEventV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !EVENT_KEYS.has(key))) return false;
  if (candidate.schemaVersion !== 1
    || !validSessionId(candidate.sessionId)
    || !positiveInteger(candidate.generation)
    || !positiveInteger(candidate.seq)
    || typeof candidate.monotonicNs !== "string"
    || !/^\d{1,32}$/.test(candidate.monotonicNs)
    || typeof candidate.kind !== "string"
    || !BOUNDARY_EVENT_KINDS.has(candidate.kind as BoundaryProbeEventKind)) {
    return false;
  }
  if (candidate.lifecycle !== undefined
    && (typeof candidate.lifecycle !== "string"
      || !LIFECYCLE_KINDS.has(candidate.lifecycle as BoundaryProbeLifecycle))) {
    return false;
  }
  if (candidate.kind === "lifecycle" ? candidate.lifecycle === undefined : candidate.lifecycle !== undefined) {
    return false;
  }
  if (candidate.requestedDynamicStageStyle !== undefined && candidate.requestedDynamicStageStyle !== "Full") {
    return false;
  }
  if (candidate.detail !== undefined && (
    typeof candidate.detail !== "string"
    || candidate.detail.length === 0
    || Buffer.byteLength(candidate.detail, "utf8") > MAX_BOUNDARY_DETAIL_BYTES
    || /[\u0000-\u001f\u007f]/.test(candidate.detail)
  )) return false;
  return true;
}

/** The shared Kotlin/TypeScript wire contract: one prefix followed by one compact JSON object. */
export function formatBoundaryProbeEventV1(event: BoundaryProbeEventV1): string {
  if (!validBoundaryEvent(event)) throw new Error("invalid BoundaryProbe V1 event");
  return `${BOUNDARY_PROBE_V1_PREFIX}${JSON.stringify(event)}`;
}

export function parseBoundaryProbeEventV1(
  rawLine: string,
  options: { truncated?: boolean } = {},
): BoundaryProbeParseResult {
  if (typeof rawLine !== "string") {
    return { status: "malformed", event: null, rawLine: String(rawLine) };
  }
  const first = rawLine.indexOf(BOUNDARY_PROBE_V1_PREFIX);
  if (first < 0) return { status: "absent", event: null, rawLine };
  if (first !== rawLine.lastIndexOf(BOUNDARY_PROBE_V1_PREFIX)) {
    return { status: "malformed", event: null, rawLine };
  }
  const payload = rawLine.slice(first + BOUNDARY_PROBE_V1_PREFIX.length).trimEnd();
  if (options.truncated === true
    || Buffer.byteLength(rawLine, "utf8") > MAX_BOUNDARY_LINE_BYTES
    || payload.length === 0
    || (payload.startsWith("{") && !payload.endsWith("}"))) {
    return { status: "truncated", event: null, rawLine };
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!validBoundaryEvent(parsed)) return { status: "malformed", event: null, rawLine };
    return { status: "ok", event: parsed, rawLine };
  } catch {
    return { status: "malformed", event: null, rawLine };
  }
}

const LOGCAT_THREADTIME_RECORD =
  /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+([1-9]\d*)\s+\d+\s+[VDIWEF]\s+([^\s:]+)\s*:\s?(.*)$/;

/** Authenticate a raw threadtime record before its app-owned message enters sequence state. */
export function parseBoundaryProbeLogRecordV1(
  rawLine: string,
  expectedPid: number | null,
  options: { truncated?: boolean } = {},
): BoundaryProbeParseResult {
  if (typeof rawLine !== "string") {
    return { status: "malformed", event: null, rawLine: String(rawLine) };
  }
  if (!rawLine.includes(BOUNDARY_PROBE_V1_PREFIX)) {
    return { status: "absent", event: null, rawLine };
  }
  if (options.truncated === true) return { status: "truncated", event: null, rawLine };
  const record = LOGCAT_THREADTIME_RECORD.exec(rawLine);
  if (!record) return { status: "malformed", event: null, rawLine };
  const sourcePid = parsePid(record[1]);
  const tag = record[2];
  const message = record[3];
  if (!positiveInteger(expectedPid)
    || sourcePid !== expectedPid
    || tag !== "BoundaryProbe"
    || !message.startsWith(BOUNDARY_PROBE_V1_PREFIX)) {
    return { status: "malformed", event: null, rawLine };
  }
  const parsed = parseBoundaryProbeEventV1(message, options);
  return parsed.status === "ok"
    ? { status: "ok", event: parsed.event, rawLine }
    : { status: parsed.status, event: null, rawLine };
}

export function classifyBoundaryProbeSequenceV1(
  events: readonly BoundaryProbeEventV1[],
  expectation: { sessionId: string; generation: number; priorSeq: number | null },
): BoundaryProbeSequenceResult {
  if (!validSessionId(expectation?.sessionId)
    || !positiveInteger(expectation?.generation)
    || (expectation?.priorSeq !== null && !nonnegativeInteger(expectation?.priorSeq))) {
    throw new Error("invalid BoundaryProbe V1 sequence expectation");
  }
  const priorSeq = expectation.priorSeq;
  const lastSeq = events.length > 0 ? events[events.length - 1].seq : null;
  if (events.length === 0) return { status: "unknown", priorSeq, lastSeq, issues: [] };

  const wrongSession = events.find((event) => event.sessionId !== expectation.sessionId);
  if (wrongSession) {
    return {
      status: "wrong_session",
      priorSeq,
      lastSeq,
      issues: [{
        kind: "wrong_session",
        expectedSessionId: expectation.sessionId,
        observedSessionId: wrongSession.sessionId,
      }],
    };
  }
  const wrongGeneration = events.find((event) => event.generation !== expectation.generation);
  if (wrongGeneration) {
    return {
      status: "wrong_generation",
      priorSeq,
      lastSeq,
      issues: [{
        kind: "wrong_generation",
        expectedGeneration: expectation.generation,
        observedGeneration: wrongGeneration.generation,
      }],
    };
  }
  if (priorSeq === null && events[0].seq !== 1) {
    return {
      status: "unknown",
      priorSeq,
      lastSeq,
      issues: [{ kind: "missing_prior", observedSeq: events[0].seq }],
    };
  }
  const issues: ProbeSequenceIssue[] = [];
  let expectedSeq = priorSeq === null ? 1 : priorSeq + 1;
  let previousObserved = priorSeq;
  for (const event of events) {
    if (event.seq !== expectedSeq) {
      const kind = event.seq === previousObserved
        ? "duplicate"
        : event.seq < expectedSeq
          ? "out_of_order"
          : "gap";
      issues.push({ kind, expectedSeq, observedSeq: event.seq });
    }
    previousObserved = event.seq;
    expectedSeq = event.seq + 1;
  }
  return {
    status: issues.length === 0 ? "complete" : "gap",
    priorSeq,
    lastSeq,
    issues,
  };
}

const WATCHDOG_THREADTIME =
  /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+[VDIWEF]\s+SpatialRuntimeService\s*:\s*Watchdog\b(.*)$/;
const WATCHDOG_FOCUS = /(?:^|\s)focus=(?:\d+\()?([A-Za-z][A-Za-z0-9_.]*)(?:\))?(?=\s|,|$)/;
const WATCHDOG_RENDER = /(?:^|\s)lastRenderTime=(\d+)(?=\s|,|$)/;

/** Candidate lines that do not match the measured raw grammar remain explicit `unparsed`. */
export function parseSpatialRuntimeWatchdog(
  lines: readonly string[],
  prior: WatchdogCursor | null = null,
): WatchdogObservation {
  const rawLines = lines.filter((line) => line.includes("SpatialRuntimeService") && line.includes("Watchdog"));
  if (rawLines.length === 0) return { status: "absent", rawLines: [] };
  const parsed: WatchdogCursor[] = [];
  for (const line of rawLines) {
    const message = WATCHDOG_THREADTIME.exec(line)?.[1];
    const focus = message ? WATCHDOG_FOCUS.exec(message)?.[1] : undefined;
    const lastRenderTime = message ? WATCHDOG_RENDER.exec(message)?.[1] : undefined;
    if (!focus || !lastRenderTime) return { status: "unparsed", rawLines };
    parsed.push({ focus, lastRenderTime });
  }
  const observations = prior ? [prior, ...parsed] : parsed;
  const latest = observations[observations.length - 1];
  if (observations.length < 2) {
    return { status: "unparsed", focus: latest.focus, lastRenderTime: latest.lastRenderTime, rawLines };
  }
  if (observations.some((entry) => entry.focus !== latest.focus)) {
    return { status: "unparsed", focus: latest.focus, lastRenderTime: latest.lastRenderTime, rawLines };
  }
  let relation: "advancing" | "stalled" | null = null;
  for (let index = 1; index < observations.length; index += 1) {
    const before = BigInt(observations[index - 1].lastRenderTime);
    const after = BigInt(observations[index].lastRenderTime);
    if (after < before) {
      return { status: "unparsed", focus: latest.focus, lastRenderTime: latest.lastRenderTime, rawLines };
    }
    const current = after > before ? "advancing" : "stalled";
    if (relation !== null && relation !== current) {
      return { status: "unparsed", focus: latest.focus, lastRenderTime: latest.lastRenderTime, rawLines };
    }
    relation = current;
  }
  return {
    status: relation ?? "unparsed",
    focus: latest.focus,
    lastRenderTime: latest.lastRenderTime,
    rawLines,
  };
}

export function classifyResumedApplication(
  dumpsysOutput: string,
  packageName: string,
  allowedResumedComponents: readonly string[],
  options: { commandSucceeded?: boolean } = {},
): Pick<ApplicationContinuitySample, "resumedComponents" | "foreground"> {
  const activities = parseForegroundActivities(dumpsysOutput);
  const resumedComponents = activities.map((activity) => activity.component);
  if (options.commandSucceeded === false) return { resumedComponents, foreground: "unknown" };
  if (activities.length === 0) {
    const recognizableAbsence = /\bACTIVITY MANAGER ACTIVITIES\b/.test(dumpsysOutput)
      || /\b(?:mCurrentFocus|topResumedActivity|mResumedActivity|ResumedActivity)\s*[:=]\s*(?:null|none)\b/i.test(dumpsysOutput);
    return { resumedComponents, foreground: recognizableAbsence ? "absent" : "unknown" };
  }

  const allowed = new Set(allowedResumedComponents);
  const samePackageUnlisted = activities.some((activity) =>
    activity.packageName === packageName && !allowed.has(activity.component));
  if (samePackageUnlisted) return { resumedComponents, foreground: "same_package_unlisted" };

  const hasAllowed = activities.some((activity) =>
    activity.packageName === packageName && allowed.has(activity.component));
  const differentPackage = activities.some((activity) =>
    activity.packageName !== packageName && activity.component !== SPATIAL_SHELL_RESUMED_COMPONENT);
  if (!hasAllowed || differentPackage) return { resumedComponents, foreground: "different_package" };
  return { resumedComponents, foreground: "exact_allowed" };
}

export interface ApplicationContinuityBinding {
  serial: string;
  bootId: string;
  packageName: string;
  apkSha256: string;
  pid: number;
  pidStartTicks: string;
  allowedResumedComponents: string[];
}

export interface SampleApplicationContinuityInput {
  adbPath: string;
  binding: ApplicationContinuityBinding;
  probe: { sessionId: string; generation: number; priorSeq: number | null };
  watchdogPrior: WatchdogCursor | null;
}

export interface ContinuityLogRead {
  lines: string[];
  truncated: boolean;
}

function normalizeContinuityLogRead(candidate: unknown): ContinuityLogRead {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { lines: [], truncated: true };
  }
  const read = candidate as { lines?: unknown; truncated?: unknown };
  if (!Array.isArray(read.lines) || typeof read.truncated !== "boolean") {
    return { lines: [], truncated: true };
  }
  const lines: string[] = [];
  let bytes = 0;
  let truncated = read.truncated || read.lines.length > APPLICATION_CONTINUITY_LOG_MAX_LINES;
  const candidateCount = Math.min(read.lines.length, APPLICATION_CONTINUITY_LOG_MAX_LINES);
  for (let index = 0; index < candidateCount; index += 1) {
    const line = read.lines[index];
    if (typeof line !== "string") {
      truncated = true;
      break;
    }
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > APPLICATION_CONTINUITY_LOG_MAX_BYTES - bytes) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += lineBytes;
  }
  return { lines, truncated };
}

export interface SampleApplicationContinuityDependencies {
  runText: typeof run;
  readLogLines: () => Promise<ContinuityLogRead>;
  monotonicNs: () => bigint;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function validContinuityInput(input: SampleApplicationContinuityInput): boolean {
  const binding = input?.binding;
  return typeof input?.adbPath === "string" && path.isAbsolute(input.adbPath)
    && !!binding
    && typeof binding.serial === "string" && /^[A-Za-z0-9._:-]+$/.test(binding.serial)
    && typeof binding.bootId === "string" && binding.bootId.length > 0
    && typeof binding.packageName === "string"
    && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(binding.packageName)
    && /^[a-f0-9]{64}$/.test(binding.apkSha256)
    && positiveInteger(binding.pid)
    && /^\d+$/.test(binding.pidStartTicks)
    && Array.isArray(binding.allowedResumedComponents)
    && binding.allowedResumedComponents.length > 0
    && new Set(binding.allowedResumedComponents).size === binding.allowedResumedComponents.length
    && binding.allowedResumedComponents.every((component) =>
      typeof component === "string" && component.startsWith(`${binding.packageName}/`))
    && validSessionId(input.probe?.sessionId)
    && positiveInteger(input.probe?.generation)
    && (input.probe?.priorSeq === null || nonnegativeInteger(input.probe?.priorSeq))
    && (input.watchdogPrior === null || (
      typeof input.watchdogPrior?.focus === "string" && input.watchdogPrior.focus.length > 0
      && typeof input.watchdogPrior?.lastRenderTime === "string"
      && /^\d+$/.test(input.watchdogPrior.lastRenderTime)
    ));
}

function commandSucceeded(result: RunResult): boolean {
  return result.code === 0 && result.timedOut === false;
}

function exactRemoteDigest(output: string, expectedPath: string): string {
  const parsed = parseRemoteSha256(output);
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!parsed || lines.length !== 1 || !lines[0].endsWith(` ${expectedPath}`)) return "";
  return parsed;
}

function failedContinuityCommand(detail: string): RunResult {
  return { code: null, stdout: "", stderr: detail, timedOut: true };
}

function boundedDependency<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  setTimer: (callback: () => void, milliseconds: number) => unknown,
  clearTimer: (handle: unknown) => void,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: unknown;
    let timerAssigned = false;
    let clearAfterTimerAssignment = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      if (timerAssigned) clearTimer(timer);
      else clearAfterTimerAssignment = true;
      resolve(value);
    };
    timer = setTimer(() => {
      if (settled) return;
      onTimeout?.();
      finish(fallback);
    }, timeoutMs);
    timerAssigned = true;
    if (clearAfterTimerAssignment) clearTimer(timer);
    promise.then(
      (value) => finish(value),
      () => finish(fallback),
    );
  });
}

export async function sampleApplicationContinuity(
  input: SampleApplicationContinuityInput,
  deps: SampleApplicationContinuityDependencies,
): Promise<ApplicationContinuitySample> {
  if (!validContinuityInput(input)
    || !deps || typeof deps.runText !== "function"
    || typeof deps.readLogLines !== "function"
    || typeof deps.monotonicNs !== "function") {
    throw new Error("invalid application continuity input or dependencies");
  }
  const { binding } = input;
  const setTimer = deps.setTimer ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  if ((deps.setTimer === undefined) !== (deps.clearTimer === undefined)) {
    throw new Error("application continuity timer dependencies must be provided together");
  }

  const observedAtMonotonicNs = deps.monotonicNs();
  if (typeof observedAtMonotonicNs !== "bigint" || observedAtMonotonicNs < 0n) {
    throw new Error("application continuity monotonic clock returned an invalid value");
  }
  const fallbackSample: ApplicationContinuitySample = {
    observedAtMonotonicNs: observedAtMonotonicNs.toString(),
    serial: binding.serial,
    bootId: "",
    packageName: binding.packageName,
    allowedResumedComponents: [...binding.allowedResumedComponents],
    apkSha256: "",
    pid: null,
    pidStartTicks: null,
    resumedComponents: [],
    foreground: "unknown",
    probeEventsSincePrior: [],
    probeParse: "truncated",
    probeSequence: "unknown",
    watchdog: { status: "unparsed" },
  };
  let collectionCancelled = false;

  const collect = async (): Promise<ApplicationContinuitySample> => {
    const adb = (
      args: string[],
      maxOutputBytes = COMMAND_TAIL_BYTES,
    ): Promise<RunResult> => boundedDependency(
      Promise.resolve().then(() => collectionCancelled
        ? failedContinuityCommand("application continuity collection already timed out")
        : deps.runText(input.adbPath, ["-s", binding.serial, ...args], {
          timeoutMs: APPLICATION_CONTINUITY_ADB_PROBE_TIMEOUT_MS,
          maxOutputBytes,
        })),
      APPLICATION_CONTINUITY_ADB_PROBE_TIMEOUT_MS,
      failedContinuityCommand("application continuity adb probe timed out or failed"),
      setTimer,
      clearTimer,
    );
    const logPromise = boundedDependency(
      Promise.resolve().then(() => collectionCancelled
        ? { lines: [], truncated: true }
        : deps.readLogLines()),
      APPLICATION_CONTINUITY_LOG_READ_TIMEOUT_MS,
      { lines: [], truncated: true },
      setTimer,
      clearTimer,
    );

    const [boot, packagePathResult, pidResult, foregroundResult] = await Promise.all([
      adb(["shell", "cat", "/proc/sys/kernel/random/boot_id"]),
      adb(["shell", "pm", "path", binding.packageName]),
      adb(["shell", "pidof", binding.packageName]),
      adb(["shell", "dumpsys", "activity", "activities"], TEXT_OUTPUT_LIMIT),
    ]);
    if (collectionCancelled) return fallbackSample;
    const bootId = commandSucceeded(boot) ? boot.stdout.trim() : "";
    const installedPath = commandSucceeded(packagePathResult)
      ? parseInstalledApkPath(packagePathResult.stdout)
      : null;
    const pid = commandSucceeded(pidResult) ? parsePid(pidResult.stdout) : null;
    const [digest, stat] = await Promise.all([
      installedPath
        ? adb(["shell", "toybox", "sha256sum", installedPath])
        : Promise.resolve(failedContinuityCommand("installed APK path unavailable")),
      pid !== null
        ? adb(["shell", "cat", `/proc/${pid}/stat`])
        : Promise.resolve(failedContinuityCommand("application PID unavailable")),
    ]);
    if (collectionCancelled) return fallbackSample;
    const apkSha256 = installedPath && commandSucceeded(digest)
      ? exactRemoteDigest(digest.stdout, installedPath)
      : "";
    const pidStartTicks = pid !== null && commandSucceeded(stat)
      ? parseProcStartTicks(stat.stdout)
      : null;
    const foreground = classifyResumedApplication(
      foregroundResult.stdout,
      binding.packageName,
      binding.allowedResumedComponents,
      { commandSucceeded: commandSucceeded(foregroundResult) },
    );

    const candidateLogRead = await logPromise;
    if (collectionCancelled) return fallbackSample;
    const logRead = normalizeContinuityLogRead(candidateLogRead);
    const probeResults = logRead.lines.map((line, index) => parseBoundaryProbeLogRecordV1(line, pid, {
      truncated: logRead.truncated && index === logRead.lines.length - 1
        && line.includes(BOUNDARY_PROBE_V1_PREFIX),
    }));
    const markerResults = probeResults.filter((result) => result.status !== "absent");
    const probeEventsSincePrior = markerResults
      .filter((result): result is Extract<BoundaryProbeParseResult, { status: "ok" }> => result.status === "ok")
      .map((result) => result.event);
    const probeParse: ApplicationContinuitySample["probeParse"] = logRead.truncated
      ? "truncated"
      : markerResults.some((result) => result.status === "truncated")
        ? "truncated"
        : markerResults.some((result) => result.status === "malformed")
          ? "malformed"
          : markerResults.length === 0
            ? "absent"
            : "ok";
    const probeSequence = probeParse === "ok"
      ? classifyBoundaryProbeSequenceV1(probeEventsSincePrior, input.probe).status
      : "unknown";

    const watchdogParsed = parseSpatialRuntimeWatchdog(logRead.lines, input.watchdogPrior);
    const watchdogStatus = logRead.truncated && watchdogParsed.status === "absent"
      ? "unparsed"
      : watchdogParsed.status;
    const watchdog: ApplicationContinuitySample["watchdog"] = {
      status: watchdogStatus,
      ...(watchdogParsed.focus ? { focus: watchdogParsed.focus } : {}),
      ...(watchdogParsed.lastRenderTime ? { lastRenderTime: watchdogParsed.lastRenderTime } : {}),
    };
    return {
      observedAtMonotonicNs: observedAtMonotonicNs.toString(),
      serial: binding.serial,
      bootId,
      packageName: binding.packageName,
      allowedResumedComponents: [...binding.allowedResumedComponents],
      apkSha256,
      pid,
      pidStartTicks,
      resumedComponents: foreground.resumedComponents,
      foreground: foreground.foreground,
      probeEventsSincePrior,
      probeParse,
      probeSequence,
      watchdog,
    };
  };

  return boundedDependency(
    collect(),
    APPLICATION_CONTINUITY_WORK_BUDGET_MS,
    fallbackSample,
    setTimer,
    clearTimer,
    () => { collectionCancelled = true; },
  );
}

export interface CollectLogWindowInput {
  adbPath: string;
  serial: string;
  artifactPath: string;
  appStartMarker: string;
  maxDurationMs: number;
  maxBytes?: number;
  gracefulTerminationMs?: number;
  forcedTerminationMs?: number;
}

type LogcatSpawn = (
  command: string,
  args: string[],
  options: { shell: false; stdio: ["ignore", "pipe", "pipe"]; windowsHide: true },
) => ChildProcess;

export interface CollectLogWindowDependencies {
  spawn: LogcatSpawn;
  monotonicNs: () => bigint;
  publicationFs?: ArtifactPublicationFileSystem;
}

export interface ArtifactPublicationFileSystem {
  fsyncSync: (descriptor: number) => void;
  fstatSync: (descriptor: number, options: { bigint: true }) => fs.BigIntStats;
  linkSync: (existingPath: fs.PathLike, newPath: fs.PathLike) => void;
  openSync: (filePath: fs.PathLike, flags: number) => number;
  readSync: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  closeSync: (descriptor: number) => void;
  lstatSync: (filePath: fs.PathLike, options: { bigint: true }) => fs.BigIntStats;
  unlinkSync: (filePath: fs.PathLike) => void;
}

const DEFAULT_ARTIFACT_PUBLICATION_FS: ArtifactPublicationFileSystem = {
  fsyncSync: (descriptor) => fs.fsyncSync(descriptor),
  fstatSync: (descriptor, options) => fs.fstatSync(descriptor, options),
  linkSync: (existingPath, newPath) => fs.linkSync(existingPath, newPath),
  openSync: (filePath, flags) => fs.openSync(filePath, flags),
  readSync: (descriptor, buffer, offset, length, position) =>
    fs.readSync(descriptor, buffer, offset, length, position),
  closeSync: (descriptor) => fs.closeSync(descriptor),
  lstatSync: (filePath, options) => fs.lstatSync(filePath, options),
  unlinkSync: (filePath) => fs.unlinkSync(filePath),
};

export interface LogArtifactRef {
  path: string;
  sha256: string;
  bytes: number;
}

export interface CollectLogWindowReceipt {
  status: "collected" | "spawn_failed" | "teardown_unconfirmed";
  stopReason: "duration_cap" | "byte_cap" | "child_exit" | "spawn_error";
  termination: "not_needed" | "sigterm" | "sigkill" | "unconfirmed";
  truncated: boolean;
  observedBytes: number;
  appStartMarker: string;
  appStartMarkerObserved: boolean;
  child: {
    pid: number | null;
    startedAtMonotonicNs: string;
    endedAtMonotonicNs: string;
    command: string;
    args: string[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  };
  rawArtifact: LogArtifactRef;
  stderrTail: string;
}

function defaultSpawn(command: string, args: string[]): ChildProcess {
  return spawnProcess(command, args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function validLogInput(input: CollectLogWindowInput): boolean {
  const maxBytes = input?.maxBytes ?? MAX_LOG_BYTES;
  const graceful = input?.gracefulTerminationMs ?? 1_000;
  const forced = input?.forcedTerminationMs ?? 5_000;
  return typeof input?.adbPath === "string" && path.isAbsolute(input.adbPath)
    && typeof input.serial === "string" && /^[A-Za-z0-9._:-]+$/.test(input.serial)
    && typeof input.artifactPath === "string" && path.isAbsolute(input.artifactPath)
    && typeof input.appStartMarker === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.appStartMarker)
    && positiveInteger(input.maxDurationMs) && input.maxDurationMs <= 10 * 60_000
    && positiveInteger(maxBytes) && maxBytes <= MAX_LOG_BYTES
    && nonnegativeInteger(graceful) && graceful <= 30_000
    && positiveInteger(forced) && forced <= 30_000;
}

interface PrivateArtifactStage {
  target: string;
  temporary: string;
  descriptor: number | null;
}

function preparePrivateArtifact(target: string): PrivateArtifactStage {
  const checkedBeforeCreate = assertExternalCapturePath(target);
  if (fs.existsSync(checkedBeforeCreate)) throw new Error(`log artifact already exists: ${checkedBeforeCreate}`);
  const parent = path.dirname(checkedBeforeCreate);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const checkedTarget = assertExternalCapturePath(checkedBeforeCreate);
  if (fs.existsSync(checkedTarget)) throw new Error(`log artifact already exists: ${checkedTarget}`);
  const temporary = path.join(parent, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  return {
    target: checkedTarget,
    temporary,
    descriptor: fs.openSync(temporary, "wx", 0o600),
  };
}

function abortPrivateArtifact(stage: PrivateArtifactStage): void {
  if (stage.descriptor !== null) {
    try { fs.closeSync(stage.descriptor); } catch { /* preserve the primary collector error */ }
    stage.descriptor = null;
  }
  try { if (fs.existsSync(stage.temporary)) fs.unlinkSync(stage.temporary); } catch { /* preserve primary error */ }
}

function abortPrivateArtifactWithPublicationFs(
  stage: PrivateArtifactStage,
  publicationFs: ArtifactPublicationFileSystem,
): void {
  if (stage.descriptor !== null) {
    try { publicationFs.closeSync(stage.descriptor); } catch { /* preserve the primary publication result */ }
    stage.descriptor = null;
  }
  try { publicationFs.unlinkSync(stage.temporary); } catch { /* random staging path may already be absent */ }
}

function writePrivateArtifactChunk(stage: PrivateArtifactStage, bytes: Buffer): void {
  if (stage.descriptor === null) throw new Error("log artifact staging descriptor is closed");
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(stage.descriptor, bytes, offset, bytes.length - offset, null);
  }
}

function publishPrivateArtifact(
  stage: PrivateArtifactStage,
  expectedBytes: number,
  expectedSha256: string,
  publicationFs: ArtifactPublicationFileSystem,
): LogArtifactRef {
  let publishedDescriptor: number | null = null;
  let publicationComplete = false;
  try {
    if (stage.descriptor === null) throw new Error("log artifact staging descriptor is closed");
    publicationFs.fsyncSync(stage.descriptor);
    const staged = publicationFs.fstatSync(stage.descriptor, { bigint: true });
    if (!staged.isFile() || staged.isSymbolicLink()
      || staged.nlink !== 1n
      || staged.size !== BigInt(expectedBytes)
      || (staged.mode & 0o7777n) !== 0o600n) {
      throw new Error("staged log artifact is not the exact private regular file");
    }
    publicationFs.linkSync(stage.temporary, stage.target);
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number" || noFollow === 0) {
      throw new Error("no-follow artifact publication is unavailable on this host");
    }
    publishedDescriptor = publicationFs.openSync(stage.target, fs.constants.O_RDONLY | noFollow);
    const before = publicationFs.fstatSync(publishedDescriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
      || before.dev !== staged.dev || before.ino !== staged.ino
      || before.nlink !== 2n
      || before.size !== BigInt(expectedBytes)
      || before.mode !== staged.mode) {
      throw new Error("linked log artifact target changed before descriptor read");
    }
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, expectedBytes)));
    let bytes = 0;
    while (bytes < expectedBytes) {
      const count = publicationFs.readSync(
        publishedDescriptor,
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - bytes),
        null,
      );
      if (count === 0) throw new Error("linked log artifact ended during descriptor read");
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }
    if (publicationFs.readSync(publishedDescriptor, buffer, 0, 1, null) !== 0) {
      throw new Error("linked log artifact grew during descriptor read");
    }
    const after = publicationFs.fstatSync(publishedDescriptor, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mode !== before.mode
      || after.nlink !== before.nlink || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) {
      throw new Error("linked log artifact changed during descriptor read");
    }
    const publishedSha256 = digest.digest("hex");
    if (bytes !== expectedBytes || publishedSha256 !== expectedSha256) {
      throw new Error("linked log artifact descriptor bytes changed");
    }
    const current = publicationFs.lstatSync(stage.target, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== after.dev || current.ino !== after.ino
      || current.nlink !== after.nlink || current.size !== after.size
      || current.mode !== after.mode) {
      throw new Error("linked log artifact pathname no longer names the owned artifact");
    }
    publicationFs.closeSync(publishedDescriptor);
    publishedDescriptor = null;
    publicationFs.closeSync(stage.descriptor);
    stage.descriptor = null;
    publicationFs.unlinkSync(stage.temporary);
    const finalTarget = publicationFs.lstatSync(stage.target, { bigint: true });
    if (!finalTarget.isFile() || finalTarget.isSymbolicLink()
      || finalTarget.dev !== after.dev || finalTarget.ino !== after.ino
      || finalTarget.nlink !== 1n || finalTarget.size !== after.size
      || finalTarget.mode !== after.mode) {
      throw new Error("final log artifact pathname is not the sole owned private link");
    }
    publicationComplete = true;
    return {
      path: stage.target,
      sha256: publishedSha256,
      bytes,
    };
  } finally {
    if (!publicationComplete) {
      if (publishedDescriptor !== null) {
        try { publicationFs.closeSync(publishedDescriptor); } catch { /* preserve the primary publication failure */ }
      }
      // Never unlink stage.target here: after link publication, its pathname may name replacement
      // evidence. Keep any target entry for explicit failed-run forensics and remove only our temp.
      abortPrivateArtifactWithPublicationFs(stage, publicationFs);
    }
  }
}

function validArtifactPublicationFileSystem(candidate: unknown): candidate is ArtifactPublicationFileSystem {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const value = candidate as Record<string, unknown>;
  return ["fsyncSync", "fstatSync", "linkSync", "openSync", "readSync", "closeSync", "lstatSync", "unlinkSync"]
    .every((name) => typeof value[name] === "function");
}

export async function collectLogWindow(
  input: CollectLogWindowInput,
  deps: CollectLogWindowDependencies = { spawn: defaultSpawn, monotonicNs: () => process.hrtime.bigint() },
): Promise<CollectLogWindowReceipt> {
  if (!validLogInput(input)
    || !deps || typeof deps.spawn !== "function" || typeof deps.monotonicNs !== "function"
    || (deps.publicationFs !== undefined && !validArtifactPublicationFileSystem(deps.publicationFs))) {
    throw new Error("invalid bounded log-window input or dependencies");
  }
  const checkedTarget = assertExternalCapturePath(input.artifactPath);
  if (fs.existsSync(checkedTarget)) throw new Error(`log artifact already exists: ${checkedTarget}`);
  const maxBytes = input.maxBytes ?? MAX_LOG_BYTES;
  const gracefulTerminationMs = input.gracefulTerminationMs ?? 1_000;
  const forcedTerminationMs = input.forcedTerminationMs ?? 5_000;
  const command = input.adbPath;
  const args = ["-s", input.serial, "logcat", "-b", "all", "-v", "threadtime"];
  const options = {
    shell: false as const,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    windowsHide: true as const,
  };
  const startedAt = deps.monotonicNs();
  if (typeof startedAt !== "bigint" || startedAt < 0n) throw new Error("log-window monotonic clock returned an invalid value");
  const artifactStage = preparePrivateArtifact(checkedTarget);

  let child: ChildProcess;
  try {
    child = deps.spawn(command, args, options);
  } catch (error) {
    abortPrivateArtifact(artifactStage);
    throw new Error(`could not spawn owned logcat child: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!child || typeof child.once !== "function" || typeof child.kill !== "function"
    || !child.stdout || !child.stderr) {
    try { child?.kill?.("SIGKILL"); } catch { /* exact invalid child only */ }
    abortPrivateArtifact(artifactStage);
    throw new Error("spawn did not return one owned piped logcat child");
  }
  const ownedChildPid = positiveInteger(child.pid) ? child.pid : null;
  const invalidChildPid = ownedChildPid === null;

  const contentHash = crypto.createHash("sha256");
  const markerBytes = Buffer.from(input.appStartMarker, "utf8");
  let markerTail = Buffer.alloc(0);
  let appStartMarkerObserved = false;
  let retainedBytes = 0;
  let observedBytes = 0;
  let stderr = "";
  let stopReason: CollectLogWindowReceipt["stopReason"] | null = null;
  let termination: CollectLogWindowReceipt["termination"] = "not_needed";
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: Error | null = null;
  let streamError: Error | null = null;
  let acceptingOutput = true;
  let closed = false;
  let completionResolved = false;
  let graceTimer: NodeJS.Timeout | null = null;
  let forcedTimer: NodeJS.Timeout | null = null;
  let durationTimer: NodeJS.Timeout | null = null;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  const complete = () => {
    if (completionResolved) return;
    completionResolved = true;
    resolveCompletion();
  };

  const absorbLateError = () => {};
  const onStdoutData = (data: Buffer | string) => {
    if (!acceptingOutput) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    observedBytes += bytes.length;
    const remaining = Math.max(0, maxBytes - retainedBytes);
    if (remaining > 0) {
      const retained = bytes.subarray(0, remaining);
      try {
        writePrivateArtifactChunk(artifactStage, retained);
        contentHash.update(retained);
        retainedBytes += retained.length;
        if (!appStartMarkerObserved) {
          const searchable = markerTail.length > 0
            ? Buffer.concat([markerTail, retained])
            : retained;
          appStartMarkerObserved = searchable.indexOf(markerBytes) >= 0;
          const tailBytes = Math.max(0, markerBytes.length - 1);
          markerTail = tailBytes > 0
            ? Buffer.from(searchable.subarray(Math.max(0, searchable.length - tailBytes)))
            : Buffer.alloc(0);
        }
      } catch (error) {
        streamError = error instanceof Error ? error : new Error(String(error));
        beginTermination("spawn_error");
      }
    }
    if (observedBytes >= maxBytes) beginTermination("byte_cap");
  };
  const onStderrData = (data: Buffer | string) => {
    const next = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    stderr = `${stderr}${next}`;
    if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
      const bytes = Buffer.from(stderr, "utf8");
      stderr = bytes.subarray(bytes.length - MAX_STDERR_BYTES).toString("utf8");
    }
  };
  const onOutputStreamError = (error: Error) => {
    spawnError = error;
    beginTermination("spawn_error");
  };
  const onChildError = (error: Error) => {
    spawnError = error;
    beginTermination("spawn_error");
  };
  const onChildClose = (code: number | null, signal: NodeJS.Signals | null) => {
    closed = true;
    exitCode = code;
    exitSignal = signal;
    if (stopReason === null) stopReason = spawnError ? "spawn_error" : "child_exit";
    complete();
  };
  const detachUnconfirmedChild = () => {
    child.stdout!.removeListener("data", onStdoutData);
    child.stderr!.removeListener("data", onStderrData);
    child.stdout!.removeListener("error", onOutputStreamError);
    child.stderr!.removeListener("error", onOutputStreamError);
    child.stdout!.on("error", absorbLateError);
    child.stderr!.on("error", absorbLateError);
    try { child.stdout!.destroy(); } catch { /* evidence is already bounded and accepted */ }
    try { child.stderr!.destroy(); } catch { /* evidence is already bounded and accepted */ }
    child.removeListener("close", onChildClose);
    child.removeListener("error", onChildError);
    child.on("error", absorbLateError);
    try { child.unref?.(); } catch { /* receipt still records unconfirmed teardown */ }
  };
  const detachConfirmedChild = () => {
    acceptingOutput = false;
    child.stdout!.removeListener("data", onStdoutData);
    child.stderr!.removeListener("data", onStderrData);
    try { child.stdout!.destroy(); } catch { /* child exit is already confirmed */ }
    try { child.stderr!.destroy(); } catch { /* child exit is already confirmed */ }
    child.stdout!.removeListener("error", onOutputStreamError);
    child.stderr!.removeListener("error", onOutputStreamError);
    child.removeListener("close", onChildClose);
    child.removeListener("error", onChildError);
  };
  function beginTermination(reason: CollectLogWindowReceipt["stopReason"]): void {
    if (stopReason === null) stopReason = reason;
    if (termination !== "not_needed" || closed) return;
    try { child.kill("SIGTERM"); } catch { /* bounded SIGKILL escalation still runs */ }
    termination = "sigterm";
    graceTimer = setTimeout(() => {
      if (closed) return;
      try { child.kill("SIGKILL"); } catch { /* forced deadline reports unconfirmed */ }
      termination = "sigkill";
      forcedTimer = setTimeout(() => {
        if (closed) return;
        acceptingOutput = false;
        termination = "unconfirmed";
        detachUnconfirmedChild();
        complete();
      }, forcedTerminationMs);
    }, gracefulTerminationMs);
  }

  child.stdout.on("data", onStdoutData);
  child.stderr.on("data", onStderrData);
  child.stdout.on("error", onOutputStreamError);
  child.stderr.on("error", onOutputStreamError);
  child.once("error", onChildError);
  child.once("close", onChildClose);
  durationTimer = setTimeout(() => beginTermination("duration_cap"), input.maxDurationMs);
  if (invalidChildPid) beginTermination("spawn_error");

  await completion;
  const postCompletionTermination = termination as CollectLogWindowReceipt["termination"];
  if (postCompletionTermination !== "unconfirmed") detachConfirmedChild();
  if (durationTimer) clearTimeout(durationTimer);
  if (graceTimer) clearTimeout(graceTimer);
  if (forcedTimer) clearTimeout(forcedTimer);
  const endedAt = deps.monotonicNs();
  if (typeof endedAt !== "bigint" || endedAt < startedAt) {
    abortPrivateArtifact(artifactStage);
    throw new Error("log-window monotonic clock regressed");
  }
  const effectiveTermination = termination as CollectLogWindowReceipt["termination"];
  const effectiveStreamError = streamError as Error | null;
  if (effectiveStreamError) {
    abortPrivateArtifact(artifactStage);
    throw new Error(`log artifact streaming failed: ${effectiveStreamError.message}`);
  }
  const rawArtifact = publishPrivateArtifact(
    artifactStage,
    retainedBytes,
    contentHash.digest("hex"),
    deps.publicationFs ?? DEFAULT_ARTIFACT_PUBLICATION_FS,
  );
  // These values are mutated by ChildProcess/timer callbacks; take explicit post-await snapshots
  // because TypeScript control-flow analysis does not model those callback writes.
  const effectiveStopReason = (stopReason ?? "child_exit") as CollectLogWindowReceipt["stopReason"];
  return {
    status: invalidChildPid
      ? "spawn_failed"
      : effectiveTermination === "unconfirmed"
        ? "teardown_unconfirmed"
        : spawnError ? "spawn_failed" : "collected",
    stopReason: effectiveStopReason,
    termination: effectiveTermination,
    truncated: effectiveTermination === "unconfirmed"
      || effectiveStopReason === "byte_cap"
      || observedBytes > retainedBytes,
    observedBytes,
    appStartMarker: input.appStartMarker,
    appStartMarkerObserved,
    child: {
      pid: ownedChildPid,
      startedAtMonotonicNs: startedAt.toString(),
      endedAtMonotonicNs: endedAt.toString(),
      command,
      args,
      exitCode,
      signal: exitSignal,
    },
    rawArtifact,
    stderrTail: stderr,
  };
}
