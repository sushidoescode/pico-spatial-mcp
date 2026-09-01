import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CameraActionReceipt } from "./cameradrive.js";
import {
  resolveProspectivePath,
  type CaptureSettledReceipt,
} from "./observation.js";
import {
  APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS,
  type ApplicationContinuitySample,
} from "./runtimecontinuity.js";
export type { ApplicationContinuitySample, BoundaryProbeEventV1 } from "./runtimecontinuity.js";

export type RelativeCameraAction =
  | { kind: "key_hold"; key: "w" | "a" | "s" | "d" | "q" | "e"; holdMs: number }
  | { kind: "look_drag"; dxPx: number; dyPx: number };

export interface RouteBudgets {
  maxActions: number;
  maxWaypoints: number;
  maxHoldMsPerAction: number;
  maxDragPxPerAction: number;
  maxCumulativeHoldMs: number;
  maxCumulativeDragPx: number;
  maxDurationMs: number;
  recoveryReserveMs: number;
}

interface CameraRuntimeBindingBase {
  serial: string;
  grpc: {
    discoveryFile: string;
    qemuPid: number | null;
    address: string;
    tokenFingerprint?: string;
  };
  qemuWindow: {
    ownerPid: number;
    windowId: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    scale?: number;
  } | null;
}

/** Selector-qualified compatibility binding used by the lower camera-action core. */
export interface CameraActionBindingReceipt extends CameraRuntimeBindingBase {
  bindingMethod: "discovery-pid-window" | "single-online-serial-plus-matching-discovery-plus-single-window";
  onlineEmulatorSerials: string[];
}

/** Strong application-aware route binding. The plan requires a concrete discovery PID. */
export interface RuntimeBindingReceipt extends Omit<CameraRuntimeBindingBase, "grpc"> {
  bootId: string;
  grpc: {
    discoveryFile: string;
    qemuPid: number;
    address: string;
    tokenFingerprint?: string;
  };
}

export interface BoundApplicationIdentity {
  packageName: string;
  apkSha256: string;
  allowedResumedComponents: string[];
  pid: number;
  pidStartTicks: string;
}

export interface ReservedArtifactSession {
  runId: string;
  absoluteRoot: string;
  ownerNonceHash: string;
}

export type RouteContinuityCapability =
  | { kind: "required"; binding: BoundApplicationIdentity }
  | { kind: "not_requested" };

export type RouteContinuityObservation =
  | { kind: "sampled"; sample: ApplicationContinuitySample }
  | { kind: "not_requested" };

export interface RelativeRouteWaypoint {
  seq: number;
  actions: RelativeCameraAction[];
  actionReceipts: CameraActionReceipt[];
  continuityBefore: RouteContinuityObservation;
  settle: CaptureSettledReceipt;
  continuityAfter: RouteContinuityObservation;
}

export interface BoundRelativeRouteInput {
  runtimeBinding: RuntimeBindingReceipt;
  continuity: RouteContinuityCapability;
  artifactSession: ReservedArtifactSession;
  priorCaptureSha256: string;
  budgets: RouteBudgets;
  capture: { maxTries: number; intervalMs: number; attemptTimeoutMs: number };
}

export interface RelativeRouteDependencies {
  applyRelativeAction(action: RelativeCameraAction): Promise<CameraActionReceipt>;
  sampleContinuity?: () => Promise<ApplicationContinuitySample>;
  captureSettled(path: string, context: {
    priorSha256: string;
    remainingMs(): number;
  }): Promise<CaptureSettledReceipt>;
  allocateWaypointPath(seq: number): string;
  sleep(ms: number): Promise<void>;
  monotonicNs(): bigint;
}

export interface RelativeRouteDecisionContext {
  remainingMs(): number;
  signal: AbortSignal;
}

export type RelativeRouteDecision = (
  trace: readonly RelativeRouteWaypoint[],
  context: RelativeRouteDecisionContext,
) => RelativeCameraAction[] | "stop" | Promise<RelativeCameraAction[] | "stop">;

export type RelativeRouteStop =
  | "controller_stop"
  | "terminal_signal_candidate"
  | "action_failed"
  | "input_release_uncertain"
  | "route_unsettled"
  | "binding_lost"
  | "budget_exhausted";

export interface RelativeRouteTrace {
  status: RelativeRouteStop;
  waypoints: RelativeRouteWaypoint[];
  usage: { actions: number; waypoints: number; holdMs: number; dragPx: number; durationMs: number };
  terminalActionFailure?: TerminalCameraActionFailure;
}

export type CameraActionFailureKind =
  | "adapter_exception"
  | "receipt_binding_mismatch"
  | "reported_action_failure"
  | "release_uncertain";

export interface TerminalCameraActionFailure {
  kind: CameraActionFailureKind;
  receiptsSoFar: CameraActionReceipt[];
  terminalReceipt: CameraActionReceipt | null;
  terminalError: string;
  attemptedCount: number;
  attemptedAction: RelativeCameraAction;
}

/** A failed action attempt that preserves every receipt emitted before execution stopped. */
export class CameraActionExecutionError extends Error implements TerminalCameraActionFailure {
  readonly kind: CameraActionFailureKind;
  readonly receiptsSoFar: CameraActionReceipt[];
  readonly terminalReceipt: CameraActionReceipt | null;
  readonly terminalError: string;
  readonly attemptedCount: number;
  readonly attemptedAction: RelativeCameraAction;

  constructor(failure: TerminalCameraActionFailure) {
    super(failure.terminalError);
    this.name = "CameraActionExecutionError";
    this.kind = failure.kind;
    this.receiptsSoFar = [...failure.receiptsSoFar];
    this.terminalReceipt = failure.terminalReceipt;
    this.terminalError = failure.terminalError;
    this.attemptedCount = failure.attemptedCount;
    this.attemptedAction = failure.attemptedAction;
  }

  get retainedReceipts(): CameraActionReceipt[] {
    return this.terminalReceipt
      ? [...this.receiptsSoFar, this.terminalReceipt]
      : [...this.receiptsSoFar];
  }

  toTerminalFailure(): TerminalCameraActionFailure {
    return {
      kind: this.kind,
      receiptsSoFar: [...this.receiptsSoFar],
      terminalReceipt: this.terminalReceipt,
      terminalError: this.terminalError,
      attemptedCount: this.attemptedCount,
      attemptedAction: this.attemptedAction,
    };
  }
}

function failureFromReturnedReceipt(
  kind: Extract<CameraActionFailureKind, "reported_action_failure" | "release_uncertain">,
  actions: readonly RelativeCameraAction[],
  receipts: readonly CameraActionReceipt[],
  terminalIndex: number,
): TerminalCameraActionFailure {
  const terminalReceipt = receipts[terminalIndex];
  const detail = typeof terminalReceipt.error === "string" && terminalReceipt.error.length > 0
    ? terminalReceipt.error
    : kind === "release_uncertain"
      ? `camera action key release was not proven certain at index ${terminalIndex}`
      : `camera action receipt reported status ${terminalReceipt.status} at index ${terminalIndex}`;
  return {
    kind,
    receiptsSoFar: receipts.slice(0, terminalIndex),
    terminalReceipt,
    terminalError: detail,
    attemptedCount: terminalIndex + 1,
    attemptedAction: actions[terminalIndex],
  };
}

interface ActionUsage {
  holdMs: number;
  dragPx: number;
}

const KEY_ACTION_TIMEOUT_RESERVE_MS = 18_800;
// One look action performs two serial focus probes (5 s each) immediately before
// the bounded 30 s CoreGraphics drag. Keep admission at the full live ceiling.
const LOOK_ACTION_TIMEOUT_RESERVE_MS = 40_000;
export const POST_ACTION_RENDER_DWELL_MS = 10_000;
// executeCaptureSettled performs adb serial discovery plus pre/post runtime-identity probes around
// the bounded screencap loop. The deadline-aware live adapter runs each identity group in parallel,
// leaving three sequential 10 s envelopes in addition to capture attempts and intervals.
const CAPTURE_BINDING_TIMEOUT_RESERVE_MS = 30_000;
export const ROUTE_FINALIZATION_RESERVE_MS = 12_000;
const WALK_KEYS = new Set(["w", "a", "s", "d", "q", "e"]);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function actionUsage(action: RelativeCameraAction): ActionUsage | null {
  if (action?.kind === "key_hold") {
    if (!WALK_KEYS.has(action.key) || !Number.isSafeInteger(action.holdMs) || action.holdMs <= 0) return null;
    return { holdMs: action.holdMs, dragPx: 0 };
  }
  if (action?.kind === "look_drag") {
    if (!Number.isSafeInteger(action.dxPx) || !Number.isSafeInteger(action.dyPx)) return null;
    return { holdMs: 0, dragPx: Math.hypot(action.dxPx, action.dyPx) };
  }
  return null;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function completeWindowGeometry(window: {
  x?: unknown; y?: unknown; width?: unknown; height?: unknown; scale?: unknown;
}): { x: number; y: number; width: number; height: number; scale: number } | null {
  const values = [window.x, window.y, window.width, window.height, window.scale];
  if (values.every((value) => value === undefined)) return null;
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const [x, y, width, height, scale] = values as number[];
  return width >= 100 && height >= 100 && scale > 0 ? { x, y, width, height, scale } : null;
}

function windowGeometryIsAbsentOrComplete(window: {
  x?: unknown; y?: unknown; width?: unknown; height?: unknown; scale?: unknown;
}): boolean {
  const values = [window.x, window.y, window.width, window.height, window.scale];
  return values.every((value) => value === undefined) || completeWindowGeometry(window) !== null;
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isWithin(parent: string, candidate: string): boolean {
  return path.resolve(parent) === path.resolve(candidate) || isStrictDescendant(parent, candidate);
}

function resolveNavigationPath(candidate: string): string {
  const absolute = path.resolve(candidate);
  try {
    fs.lstatSync(absolute);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return resolveProspectivePath(absolute);
  }
  // Navigation never publishes over a pre-existing symlink: resolve the final entry too.
  return fs.realpathSync(absolute);
}

function validCameraActionBinding(
  binding: unknown,
): binding is CameraActionBindingReceipt | RuntimeBindingReceipt {
  if (!binding || typeof binding !== "object") return false;
  const candidate = binding as Partial<CameraActionBindingReceipt & RuntimeBindingReceipt>;
  const grpc = candidate.grpc;
  const window = candidate.qemuWindow;
  if (typeof candidate.serial !== "string" || candidate.serial.trim().length === 0
    || !grpc || typeof grpc !== "object"
    || typeof grpc.discoveryFile !== "string" || !path.isAbsolute(grpc.discoveryFile)
    || (grpc.qemuPid !== null && !positiveInteger(grpc.qemuPid))
    || typeof grpc.address !== "string" || grpc.address.trim().length === 0
    || (grpc.tokenFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(grpc.tokenFingerprint))) {
    return false;
  }
  if (window !== null && (
    !window || typeof window !== "object"
    || !positiveInteger(window.ownerPid)
    || !positiveInteger(window.windowId)
    || !windowGeometryIsAbsentOrComplete(window)
  )) return false;
  const method = candidate.bindingMethod;
  const online = candidate.onlineEmulatorSerials;
  if (method === undefined && online === undefined) {
    return typeof candidate.bootId === "string" && candidate.bootId.length > 0
      && grpc.qemuPid !== null
      && (window === null || window.ownerPid === grpc.qemuPid);
  }
  if ((method !== "discovery-pid-window"
      && method !== "single-online-serial-plus-matching-discovery-plus-single-window")
    || !Array.isArray(online)
    || online.length === 0
    || online.some((serial) => typeof serial !== "string" || !/^emulator-[1-9]\d*$/.test(serial))
    || JSON.stringify(online) !== JSON.stringify([...new Set(online)].sort())
    || !online.includes(candidate.serial as string)
    || window === null) {
    return false;
  }
  if (method === "discovery-pid-window") {
    return grpc.qemuPid !== null && window.ownerPid === grpc.qemuPid;
  }
  return online.length === 1
    && online[0] === candidate.serial
    && (grpc.qemuPid === null || window.ownerPid !== grpc.qemuPid);
}

function validStrictRuntimeBinding(binding: unknown): binding is RuntimeBindingReceipt {
  if (!binding || typeof binding !== "object") return false;
  const candidate = binding as Partial<RuntimeBindingReceipt> & Record<string, unknown>;
  const grpc = candidate.grpc;
  const window = candidate.qemuWindow;
  return typeof candidate.serial === "string" && candidate.serial.trim().length > 0
    && typeof candidate.bootId === "string" && candidate.bootId.length > 0
    && !Object.prototype.hasOwnProperty.call(candidate, "bindingMethod")
    && !Object.prototype.hasOwnProperty.call(candidate, "onlineEmulatorSerials")
    && !!grpc && typeof grpc === "object"
    && typeof grpc.discoveryFile === "string" && path.isAbsolute(grpc.discoveryFile)
    && positiveInteger(grpc.qemuPid)
    && typeof grpc.address === "string" && grpc.address.trim().length > 0
    && (grpc.tokenFingerprint === undefined || /^[a-f0-9]{64}$/.test(grpc.tokenFingerprint))
    && !!window && typeof window === "object"
    && positiveInteger(window.ownerPid)
    && positiveInteger(window.windowId)
    && windowGeometryIsAbsentOrComplete(window)
    && window.ownerPid === grpc.qemuPid;
}

function canonicalExternalSessionRoot(session: ReservedArtifactSession): string | null {
  if (typeof session?.absoluteRoot !== "string" || !path.isAbsolute(session.absoluteRoot)) return null;
  try {
    const root = resolveNavigationPath(session.absoluteRoot);
    const repository = resolveNavigationPath(REPOSITORY_ROOT);
    return isWithin(repository, root) || isWithin(root, repository) ? null : root;
  } catch {
    return null;
  }
}

function exactStringSet(observed: string[], expected: string[]): boolean {
  if (!Array.isArray(observed) || observed.length !== expected.length) return false;
  return JSON.stringify([...observed].sort()) === JSON.stringify([...expected].sort());
}

function validInput(input: BoundRelativeRouteInput): boolean {
  const { budgets, capture } = input;
  const artifactRoot = input.artifactSession?.absoluteRoot ?? "";
  const application = input.continuity?.kind === "required" ? input.continuity.binding : null;
  return validStrictRuntimeBinding(input.runtimeBinding)
    && typeof input.artifactSession?.runId === "string" && input.artifactSession.runId.length > 0
    && /^[a-f0-9]{64}$/.test(input.artifactSession?.ownerNonceHash ?? "")
    && /^[a-f0-9]{64}$/.test(input.priorCaptureSha256 ?? "")
    && path.isAbsolute(artifactRoot)
    && positiveInteger(budgets?.maxActions)
    && positiveInteger(budgets?.maxWaypoints)
    && positiveInteger(budgets?.maxHoldMsPerAction)
    && positiveInteger(budgets?.maxDragPxPerAction)
    && positiveInteger(budgets?.maxCumulativeHoldMs)
    && positiveInteger(budgets?.maxCumulativeDragPx)
    && positiveInteger(budgets?.maxDurationMs)
    && Number.isSafeInteger(budgets?.recoveryReserveMs) && budgets.recoveryReserveMs >= 0
    && budgets.recoveryReserveMs <= budgets.maxDurationMs
    && positiveInteger(capture?.maxTries)
    && Number.isSafeInteger(capture?.intervalMs) && capture.intervalMs >= 0
    && positiveInteger(capture?.attemptTimeoutMs)
    && (application === null || (
      typeof application.packageName === "string" && application.packageName.length > 0
      && /^[a-f0-9]{64}$/.test(application.apkSha256)
      && Array.isArray(application.allowedResumedComponents) && application.allowedResumedComponents.length > 0
      && application.allowedResumedComponents.every((component) => typeof component === "string" && component.length > 0)
      && positiveInteger(application.pid)
      && typeof application.pidStartTicks === "string" && /^[0-9]+$/.test(application.pidStartTicks)
    ));
}

function conservativeWaypointDurationMs(
  input: BoundRelativeRouteInput,
  actions: readonly RelativeCameraAction[],
): number {
  const actionMs = actions.reduce((sum, action) => sum + (
    action.kind === "key_hold"
      ? KEY_ACTION_TIMEOUT_RESERVE_MS + action.holdMs
      : LOOK_ACTION_TIMEOUT_RESERVE_MS
  ), 0);
  const captureMs = captureWorkReserveMs(input);
  const continuityMs = input.continuity.kind === "required" ? 2 * APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS : 0;
  return actionMs + POST_ACTION_RENDER_DWELL_MS + captureMs + continuityMs
    + input.budgets.recoveryReserveMs + ROUTE_FINALIZATION_RESERVE_MS;
}

function captureWorkReserveMs(input: BoundRelativeRouteInput): number {
  return CAPTURE_BINDING_TIMEOUT_RESERVE_MS
    + input.capture.maxTries * input.capture.attemptTimeoutMs
    + Math.max(0, input.capture.maxTries - 1) * input.capture.intervalMs;
}

function postCaptureReserveMs(input: BoundRelativeRouteInput): number {
  const continuityMs = input.continuity.kind === "required" ? APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS : 0;
  return continuityMs + input.budgets.recoveryReserveMs + ROUTE_FINALIZATION_RESERVE_MS;
}

function postRenderDwellReserveMs(input: BoundRelativeRouteInput): number {
  return captureWorkReserveMs(input) + postCaptureReserveMs(input);
}

/** Conservative whole-route admission estimate for callers with a fixed action schedule. */
export function estimateRelativeRouteDurationMs(
  input: BoundRelativeRouteInput,
  actionGroups: readonly (readonly RelativeCameraAction[])[],
): number {
  if (!validInput(input) || !Array.isArray(actionGroups) || actionGroups.length === 0) return Number.POSITIVE_INFINITY;
  const continuityMs = input.continuity.kind === "required" ? 2 * APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS : 0;
  let total = input.budgets.recoveryReserveMs + ROUTE_FINALIZATION_RESERVE_MS;
  for (const group of actionGroups) {
    if (!Array.isArray(group) || group.length === 0) return Number.POSITIVE_INFINITY;
    let actionMs = 0;
    for (const action of group) {
      const measured = actionUsage(action);
      if (!measured
        || measured.holdMs > input.budgets.maxHoldMsPerAction
        || measured.dragPx > input.budgets.maxDragPxPerAction) return Number.POSITIVE_INFINITY;
      actionMs += action.kind === "key_hold"
        ? KEY_ACTION_TIMEOUT_RESERVE_MS + action.holdMs
        : LOOK_ACTION_TIMEOUT_RESERVE_MS;
    }
    total += actionMs + POST_ACTION_RENDER_DWELL_MS + captureWorkReserveMs(input) + continuityMs;
    if (!Number.isSafeInteger(total)) return Number.POSITIVE_INFINITY;
  }
  return total;
}

function capturePathBelongsToSession(
  session: ReservedArtifactSession,
  canonicalSessionRoot: string,
  candidate: string,
): boolean {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return false;
  const lexicalRoot = path.resolve(session.absoluteRoot);
  const lexicalCandidate = path.resolve(candidate);
  if (candidate !== lexicalCandidate || !isStrictDescendant(lexicalRoot, lexicalCandidate)) return false;
  try {
    const physicalCandidate = resolveNavigationPath(candidate);
    const physicalExpected = path.resolve(canonicalSessionRoot, path.relative(lexicalRoot, lexicalCandidate));
    const repository = resolveNavigationPath(REPOSITORY_ROOT);
    return !isWithin(repository, physicalCandidate)
      && physicalCandidate === physicalExpected
      && isStrictDescendant(canonicalSessionRoot, physicalCandidate);
  } catch {
    return false;
  }
}

function continuityMatches(
  input: BoundRelativeRouteInput,
  sample: ApplicationContinuitySample,
): boolean {
  if (input.continuity.kind !== "required") return true;
  const expected = input.continuity.binding;
  return sample.serial === input.runtimeBinding.serial
    && sample.bootId === input.runtimeBinding.bootId
    && sample.packageName === expected.packageName
    && sample.apkSha256 === expected.apkSha256
    && sample.pid === expected.pid
    && sample.pidStartTicks === expected.pidStartTicks
    && exactStringSet(sample.allowedResumedComponents, expected.allowedResumedComponents)
    && sample.foreground === "exact_allowed"
    && Array.isArray(sample.resumedComponents)
    && sample.resumedComponents.some((component) => expected.allowedResumedComponents.includes(component));
}

function validCaptureRef(
  capturePath: string,
  input: BoundRelativeRouteInput,
  receipt: CaptureSettledReceipt,
): boolean {
  const binding = receipt.captureRuntimeBinding;
  const captureRef = receipt.captureRef;
  if (!binding || !captureRef
    || typeof receipt.path !== "string"
    || typeof receipt.sha256 !== "string"
    || typeof captureRef.path !== "string") return false;
  return path.resolve(receipt.path) === path.resolve(capturePath)
    && receipt.serial === input.runtimeBinding.serial
    && /^[a-f0-9]{64}$/.test(receipt.sha256)
    && binding.serial === input.runtimeBinding.serial
    && binding.liveIdentity?.serial === input.runtimeBinding.serial
    && binding.liveIdentity?.bootId === input.runtimeBinding.bootId
    && captureRef.sourceSerial === input.runtimeBinding.serial
    && path.resolve(captureRef.path) === path.resolve(capturePath)
    && captureRef.sha256 === receipt.sha256
    && receipt.evidenceCeiling === "structural"
    && receipt.lookRequired === true;
}

function settledReceiptMatches(
  capturePath: string,
  input: BoundRelativeRouteInput,
  receipt: CaptureSettledReceipt,
): boolean {
  if (!validCaptureRef(capturePath, input, receipt)) return false;
  if (receipt.status === "settled") {
    return receipt.settlementSatisfied === true
      && receipt.error === null
      && receipt.lastValidCaptureRef === null
      && Array.isArray(receipt.stablePair)
      && receipt.stablePair.length === 2
      && receipt.stablePair[0] === receipt.sha256
      && receipt.stablePair[1] === receipt.sha256;
  }
  return (receipt.status === "timeout" || receipt.status === "capture_failed")
    && receipt.settlementSatisfied === false
    && receipt.stablePair === null;
}

async function observeContinuity(
  input: BoundRelativeRouteInput,
  deps: RelativeRouteDependencies,
): Promise<{ observation: RouteContinuityObservation; matches: boolean } | null> {
  if (input.continuity.kind === "not_requested") {
    return { observation: { kind: "not_requested" }, matches: true };
  }
  if (!deps.sampleContinuity) return null;
  try {
    const sample = await deps.sampleContinuity();
    return {
      observation: { kind: "sampled", sample },
      matches: continuityMatches(input, sample),
    };
  } catch {
    return null;
  }
}

export async function executeBoundCameraActions(
  binding: CameraActionBindingReceipt | RuntimeBindingReceipt,
  actions: readonly RelativeCameraAction[],
  deps: Pick<RelativeRouteDependencies, "applyRelativeAction">,
): Promise<CameraActionReceipt[]> {
  if (!validCameraActionBinding(binding)) throw new Error("invalid camera action binding");
  if (!deps || typeof deps.applyRelativeAction !== "function") {
    throw new Error("invalid camera action dependencies");
  }
  if (!Array.isArray(actions)) throw new Error("invalid relative camera action group");
  for (let index = 0; index < actions.length; index++) {
    if (!actionUsage(actions[index])) throw new Error(`invalid relative camera action at index ${index}`);
  }
  const receipts: CameraActionReceipt[] = [];
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    let receipt: CameraActionReceipt;
    try {
      receipt = await deps.applyRelativeAction(action);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CameraActionExecutionError({
        kind: "adapter_exception",
        receiptsSoFar: receipts,
        terminalReceipt: null,
        terminalError: `camera action adapter failed at index ${index}: ${detail}`,
        attemptedCount: index + 1,
        attemptedAction: action,
      });
    }
    const expectedKind = action.kind;
    const ack = receipt?.ack as Record<string, any> | undefined;
    const hostWindow = ack?.hostWindow;
    const expectedWindow = binding.qemuWindow;
    const observedWindow = hostWindow && typeof hostWindow === "object"
      ? {
          ownerPid: hostWindow.qemuWindowOwnerPid ?? hostWindow.ownerPid,
          windowId: hostWindow.qemuWindowId ?? hostWindow.windowId,
          x: hostWindow.qemuWindowX ?? hostWindow.x,
          y: hostWindow.qemuWindowY ?? hostWindow.y,
          width: hostWindow.qemuWindowWidth ?? hostWindow.width,
          height: hostWindow.qemuWindowHeight ?? hostWindow.height,
          scale: hostWindow.qemuWindowScale ?? hostWindow.scale,
        }
      : null;
    const expectedGeometry = expectedWindow ? completeWindowGeometry(expectedWindow) : null;
    const observedGeometry = observedWindow ? completeWindowGeometry(observedWindow) : null;
    const hostWindowMatches = expectedWindow === null
      ? hostWindow === null
      : observedWindow?.ownerPid === expectedWindow.ownerPid
        && observedWindow?.windowId === expectedWindow.windowId
        && (expectedGeometry === null || (
          observedGeometry !== null
          && observedGeometry.x === expectedGeometry.x
          && observedGeometry.y === expectedGeometry.y
          && observedGeometry.width === expectedGeometry.width
          && observedGeometry.height === expectedGeometry.height
          && observedGeometry.scale === expectedGeometry.scale
        ));
    const actionEvidenceMatches = action.kind === "key_hold"
      ? ack?.key === action.key && ack?.holdMs === action.holdMs
      : ack?.requested?.dragDx === action.dxPx && ack?.requested?.dragDy === action.dyPx;
    const grpc = ack?.grpc;
    const grpcMatches = action.kind === "look_drag" || (
      grpc && typeof grpc === "object"
      && grpc.discoveryFile === binding.grpc.discoveryFile
      && grpc.discoveredSerial === binding.serial
      && grpc.qemuPid === binding.grpc.qemuPid
      && grpc.address === binding.grpc.address
      && (grpc.tokenFingerprint ?? null) === (binding.grpc.tokenFingerprint ?? null)
    );
    const provenNoInputKeyFailure = action.kind === "key_hold"
      && receipt?.status === "failed"
      && typeof receipt.error === "string" && receipt.error.length > 0
      && ack?.connectionAttempts === 2
      && ack?.keydownAttempted === false
      && ack?.keydownAcknowledged === false
      && ack?.applicationUncertain === false
      && ack?.keyupAcknowledged === false
      && ack?.releaseCertain === true
      && !Object.prototype.hasOwnProperty.call(ack, "grpc");
    if (receipt?.serial !== binding.serial
      || receipt?.action !== expectedKind
      || !hostWindowMatches
      || !actionEvidenceMatches
      || (!grpcMatches && !provenNoInputKeyFailure)) {
      throw new CameraActionExecutionError({
        kind: "receipt_binding_mismatch",
        receiptsSoFar: receipts,
        terminalReceipt: receipt ?? null,
        terminalError: `action receipt binding mismatch: expected ${binding.serial}/${expectedKind} with exact runtime evidence`,
        attemptedCount: index + 1,
        attemptedAction: action,
      });
    }
    receipts.push(receipt);
    if (receipt.status !== "applied" || (action.kind === "key_hold" && receipt.ack.releaseCertain !== true)) break;
  }
  return receipts;
}

export async function executeRelativeCameraRoute(
  input: BoundRelativeRouteInput,
  decide: RelativeRouteDecision,
  deps: RelativeRouteDependencies,
): Promise<RelativeRouteTrace> {
  const waypoints: RelativeRouteWaypoint[] = [];
  const allocatedPaths = new Set<string>();
  const usage = { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 0 };
  let terminalActionFailure: TerminalCameraActionFailure | undefined;
  if (!validInput(input)) return { status: "budget_exhausted", waypoints, usage };
  if (!deps
    || typeof deps.applyRelativeAction !== "function"
    || typeof deps.captureSettled !== "function"
    || typeof deps.allocateWaypointPath !== "function"
    || typeof deps.sleep !== "function"
    || typeof deps.monotonicNs !== "function") {
    return { status: "budget_exhausted", waypoints, usage };
  }
  const canonicalSessionRoot = canonicalExternalSessionRoot(input.artifactSession);
  if (!canonicalSessionRoot) return { status: "budget_exhausted", waypoints, usage };
  let startedAt: bigint;
  try {
    startedAt = deps.monotonicNs();
    if (typeof startedAt !== "bigint") throw new Error("monotonic clock did not return bigint");
  } catch {
    return { status: "budget_exhausted", waypoints, usage };
  }
  let lastObservedAt = startedAt;
  let clockFailed = false;
  const elapsedMs = (): number | null => {
    if (clockFailed) return null;
    try {
      const observed = deps.monotonicNs();
      if (typeof observed !== "bigint" || observed < lastObservedAt) {
        clockFailed = true;
        return null;
      }
      lastObservedAt = observed;
      const elapsed = (observed - startedAt) / 1_000_000n;
      if (elapsed > BigInt(Number.MAX_SAFE_INTEGER)) {
        clockFailed = true;
        return null;
      }
      return Number(elapsed);
    } catch {
      clockFailed = true;
      return null;
    }
  };
  const finishWithoutClock = (status: RelativeRouteStop): RelativeRouteTrace => {
    const trace: RelativeRouteTrace = {
      status,
      waypoints: [...waypoints],
      usage: { ...usage },
    };
    if (terminalActionFailure) trace.terminalActionFailure = terminalActionFailure;
    return trace;
  };
  const finish = (status: RelativeRouteStop): RelativeRouteTrace => {
    const durationMs = elapsedMs();
    if (durationMs === null) return finishWithoutClock("budget_exhausted");
    usage.durationMs = durationMs;
    return finishWithoutClock(status);
  };

  if (input.continuity.kind === "required" && !deps.sampleContinuity) return finish("binding_lost");
  let priorCaptureSha256 = input.priorCaptureSha256;

  while (true) {
    let decision: RelativeCameraAction[] | "stop";
    let decisionTimedOut = false;
    const controller = new AbortController();
    const decisionRemainingMs = (): number => {
      const elapsed = elapsedMs();
      return elapsed === null ? 0 : Math.max(0, input.budgets.maxDurationMs - elapsed);
    };
    const lastObservedElapsed = (lastObservedAt - startedAt) / 1_000_000n;
    const initialDecisionRemainingMs = lastObservedElapsed > BigInt(Number.MAX_SAFE_INTEGER)
      ? 0
      : Math.max(0, input.budgets.maxDurationMs - Number(lastObservedElapsed));
    if (initialDecisionRemainingMs <= 0) return finish("budget_exhausted");
    let decisionTimer: NodeJS.Timeout | null = null;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        decisionTimer = setTimeout(() => {
          decisionTimedOut = true;
          controller.abort("relative route decision deadline exhausted");
          reject(new Error("relative route decision deadline exhausted"));
        }, Math.max(1, Math.min(initialDecisionRemainingMs, 2_147_483_647)));
      });
      decision = await Promise.race([
        Promise.resolve().then(() => decide([...waypoints], {
          remainingMs: decisionRemainingMs,
          signal: controller.signal,
        })),
        deadline,
      ]);
    } catch {
      return finish(decisionTimedOut ? "budget_exhausted" : "action_failed");
    } finally {
      if (decisionTimer) clearTimeout(decisionTimer);
    }
    if (decision === "stop") return finish("controller_stop");
    if (!Array.isArray(decision) || decision.length === 0) return finish("budget_exhausted");
    if (usage.waypoints >= input.budgets.maxWaypoints) return finish("budget_exhausted");

    const groupUsage: ActionUsage[] = [];
    for (const action of decision) {
      const measured = actionUsage(action);
      if (!measured
        || measured.holdMs > input.budgets.maxHoldMsPerAction
        || measured.dragPx > input.budgets.maxDragPxPerAction) {
        return finish("budget_exhausted");
      }
      groupUsage.push(measured);
    }
    const groupActions = groupUsage.length;
    const groupHoldMs = groupUsage.reduce((sum, measured) => sum + measured.holdMs, 0);
    const groupDragPx = groupUsage.reduce((sum, measured) => sum + measured.dragPx, 0);
    if (usage.actions + groupActions > input.budgets.maxActions
      || usage.holdMs + groupHoldMs > input.budgets.maxCumulativeHoldMs
      || usage.dragPx + groupDragPx > input.budgets.maxCumulativeDragPx) {
      return finish("budget_exhausted");
    }
    const elapsedBeforeWaypointMs = elapsedMs();
    if (elapsedBeforeWaypointMs === null) return finishWithoutClock("budget_exhausted");
    if (elapsedBeforeWaypointMs + conservativeWaypointDurationMs(input, decision) > input.budgets.maxDurationMs) {
      return finish("budget_exhausted");
    }

    const seq = usage.waypoints + 1;
    let capturePath: string;
    try {
      capturePath = deps.allocateWaypointPath(seq);
    } catch {
      return finish("route_unsettled");
    }
    if (allocatedPaths.has(capturePath)
      || !capturePathBelongsToSession(input.artifactSession, canonicalSessionRoot, capturePath)) {
      return finish("route_unsettled");
    }
    allocatedPaths.add(capturePath);

    const continuityBefore = await observeContinuity(input, deps);
    if (!continuityBefore || !continuityBefore.matches) return finish("binding_lost");
    const elapsedAfterContinuityMs = elapsedMs();
    if (elapsedAfterContinuityMs === null) return finishWithoutClock("budget_exhausted");
    const remainingWaypointReserveMs = conservativeWaypointDurationMs(input, decision)
      - (input.continuity.kind === "required" ? APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS : 0);
    if (elapsedAfterContinuityMs + remainingWaypointReserveMs > input.budgets.maxDurationMs) {
      return finish("budget_exhausted");
    }

    let actionReceipts: CameraActionReceipt[];
    try {
      actionReceipts = await executeBoundCameraActions(input.runtimeBinding, decision, deps);
    } catch (error) {
      if (error instanceof CameraActionExecutionError) {
        for (let index = 0; index < error.attemptedCount; index++) {
          usage.actions++;
          usage.holdMs += groupUsage[index].holdMs;
          usage.dragPx += groupUsage[index].dragPx;
        }
        terminalActionFailure = error.toTerminalFailure();
      }
      return finish("action_failed");
    }
    for (let index = 0; index < actionReceipts.length; index++) {
      usage.actions++;
      usage.holdMs += groupUsage[index].holdMs;
      usage.dragPx += groupUsage[index].dragPx;
    }
    const uncertainIndex = actionReceipts.findIndex((receipt, index) =>
      receipt.status === "release_uncertain"
      || (decision[index]?.kind === "key_hold" && receipt.ack.releaseCertain !== true));
    if (uncertainIndex >= 0) {
      terminalActionFailure = failureFromReturnedReceipt("release_uncertain", decision, actionReceipts, uncertainIndex);
      return finish("input_release_uncertain");
    }
    const failedIndex = actionReceipts.findIndex((receipt) => receipt.status !== "applied");
    if (failedIndex >= 0) {
      terminalActionFailure = failureFromReturnedReceipt("reported_action_failure", decision, actionReceipts, failedIndex);
      return finish("action_failed");
    }
    if (actionReceipts.length !== decision.length) {
      return finish("action_failed");
    }

    try {
      await deps.sleep(POST_ACTION_RENDER_DWELL_MS);
    } catch {
      return finish("route_unsettled");
    }
    const elapsedAfterDwellMs = elapsedMs();
    if (elapsedAfterDwellMs === null) return finishWithoutClock("budget_exhausted");
    if (elapsedAfterDwellMs + postRenderDwellReserveMs(input) > input.budgets.maxDurationMs) {
      return finish("budget_exhausted");
    }

    let settle: CaptureSettledReceipt;
    try {
      settle = await deps.captureSettled(capturePath, {
        priorSha256: priorCaptureSha256,
        remainingMs: () => {
          const elapsed = elapsedMs();
          if (elapsed === null) return 0;
          return Math.max(0, input.budgets.maxDurationMs - elapsed - postCaptureReserveMs(input));
        },
      });
    } catch {
      return finish("route_unsettled");
    }
    const elapsedAfterCaptureMs = elapsedMs();
    if (elapsedAfterCaptureMs === null) return finishWithoutClock("budget_exhausted");
    if (elapsedAfterCaptureMs + postCaptureReserveMs(input) > input.budgets.maxDurationMs) {
      return finish("budget_exhausted");
    }
    try {
      if (!settledReceiptMatches(capturePath, input, settle)) return finish("route_unsettled");
    } catch {
      return finish("route_unsettled");
    }
    const continuityAfter = await observeContinuity(input, deps);
    if (!continuityAfter) return finish("binding_lost");
    waypoints.push({
      seq,
      actions: [...decision],
      actionReceipts,
      continuityBefore: continuityBefore.observation,
      settle,
      continuityAfter: continuityAfter.observation,
    });
    usage.waypoints++;

    if (settle.status !== "settled"
      || !settle.settlementSatisfied
      || settle.sha256 === priorCaptureSha256) return finish("route_unsettled");
    if (!continuityAfter.matches) return finish("binding_lost");
    const elapsedAfterFinalContinuityMs = elapsedMs();
    if (elapsedAfterFinalContinuityMs === null) return finishWithoutClock("budget_exhausted");
    if (elapsedAfterFinalContinuityMs + input.budgets.recoveryReserveMs + ROUTE_FINALIZATION_RESERVE_MS
      > input.budgets.maxDurationMs) {
      return finish("budget_exhausted");
    }
    priorCaptureSha256 = settle.sha256!;
  }
}
