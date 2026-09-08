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
  meta?: RelativeRouteWaypointMeta;
}

export interface RelativeRouteWaypointMeta {
  lane: "active" | "recovery";
  pairId?: string;
  pairRole?: "outbound" | "restore";
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
  applyRelativeAction(action: RelativeCameraAction, context?: RelativeRouteActionContext): Promise<CameraActionReceipt>;
  sampleContinuity?: () => Promise<ApplicationContinuitySample>;
  captureSettled(path: string, context: {
    priorSha256: string;
    remainingMs(): number;
  }): Promise<CaptureSettledReceipt>;
  allocateWaypointPath(seq: number): string;
  sleep(ms: number): Promise<void>;
  monotonicNs(): bigint;
}

export interface RelativeRouteActionContext {
  /** Recheck after asynchronous observation: reserves this and later actions, settlement,
   * post-action continuity, finalization, and the current lane's recovery reserve. */
  canStart(): boolean;
}

export interface RelativeRouteDecisionContext {
  remainingMs(): number;
  signal: AbortSignal;
}

/**
 * Compatibility-loop decisions are synchronous and side-effect-free. Stateful or asynchronous
 * observation belongs between explicit `RelativeRouteExecution` steps, never in this callback.
 * The runtime still fails closed on a JavaScript caller that returns a thenable.
 */
export type RelativeRouteDecision = (
  trace: readonly RelativeRouteWaypoint[],
  context: RelativeRouteDecisionContext,
) => RelativeCameraAction[] | "stop";

export type RelativeRouteStop =
  | "controller_stop"
  | "terminal_signal_candidate"
  | "action_failed"
  | "input_release_uncertain"
  | "route_unsettled"
  | "binding_lost"
  | "budget_exhausted";

export interface RelativeRouteActionAttemptIdentity {
  executionId: string;
  stepSeq: number;
  actionIndex: number;
}

export interface RelativeRouteAttemptOutcome<T> {
  status: "succeeded" | "failed" | "not_reached";
  evidence: T | null;
  detail: string | null;
}

export interface RelativeRouteActionAttempt {
  identity: RelativeRouteActionAttemptIdentity;
  order: number;
  request: RelativeCameraAction;
  lane: RelativeRouteWaypointMeta["lane"];
  recoveryLane: boolean;
  pairId?: string;
  pairRole?: "outbound" | "restore";
  continuityBefore: RelativeRouteAttemptOutcome<RouteContinuityObservation>;
  action: RelativeRouteAttemptOutcome<CameraActionReceipt>;
  settle: RelativeRouteAttemptOutcome<CaptureSettledReceipt>;
  continuityAfter: RelativeRouteAttemptOutcome<RouteContinuityObservation>;
}

export interface OrderedTerminalCameraActionFailure extends TerminalCameraActionFailure {
  attemptIdentity: RelativeRouteActionAttemptIdentity;
}

export interface RelativeRouteTrace {
  status: RelativeRouteStop;
  waypoints: RelativeRouteWaypoint[];
  actionAttempts: RelativeRouteActionAttempt[];
  terminalActionFailures: OrderedTerminalCameraActionFailure[];
  usage: { actions: number; waypoints: number; holdMs: number; dragPx: number; durationMs: number };
  terminalActionFailure?: OrderedTerminalCameraActionFailure;
}

export interface RelativeRouteStepOutcome {
  status: "settled" | Exclude<RelativeRouteStop, "controller_stop" | "terminal_signal_candidate">;
  waypoint: RelativeRouteWaypoint | null;
  actionReceipts: CameraActionReceipt[];
  actionApplied: boolean;
  actionAttempts: RelativeRouteActionAttempt[];
  terminalActionFailure?: OrderedTerminalCameraActionFailure;
}

export interface RelativeRoutePairedStepOutcome {
  primaryStatus: RelativeRouteStepOutcome["status"];
  outbound: RelativeRouteStepOutcome;
  restore: RelativeRouteStepOutcome | null;
  recoveryUsed: boolean;
}

export interface RelativeRouteExecution {
  activeRemainingMs(observeClock?: boolean): number;
  executeStep(
    actions: readonly RelativeCameraAction[],
    meta?: Omit<RelativeRouteWaypointMeta, "lane">,
  ): Promise<RelativeRouteStepOutcome>;
  adoptSettledBaseline(receipt: CaptureSettledReceipt): boolean;
  executePairedStep(
    outbound: RelativeCameraAction,
    inverse: RelativeCameraAction,
    meta: { pairId: string },
  ): Promise<RelativeRoutePairedStepOutcome>;
  finish(status: RelativeRouteStop): RelativeRouteTrace;
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
    const provenBindingRevalidationFailure = action.kind === "key_hold"
      && receipt?.status === "failed"
      && typeof receipt.error === "string" && receipt.error.length > 0
      && ack?.connectionAttempts === 0
      && ack?.keydownAttempted === false
      && ack?.keydownAcknowledged === false
      && ack?.applicationUncertain === false
      && ack?.keyupAcknowledged === false
      && ack?.releaseCertain === true
      && (ack?.bindingRevalidation?.status === "mismatch" || ack?.bindingRevalidation?.status === "failed")
      && !Object.prototype.hasOwnProperty.call(ack, "grpc");
    if (receipt?.serial !== binding.serial
      || receipt?.action !== expectedKind
      || !hostWindowMatches
      || !actionEvidenceMatches
      || (!grpcMatches && !provenNoInputKeyFailure && !provenBindingRevalidationFailure)) {
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

function inverseActionsMatch(outbound: RelativeCameraAction, inverse: RelativeCameraAction): boolean {
  if (outbound.kind === "look_drag" && inverse.kind === "look_drag") {
    return inverse.dxPx === -outbound.dxPx && inverse.dyPx === -outbound.dyPx;
  }
  if (outbound.kind !== "key_hold" || inverse.kind !== "key_hold" || outbound.holdMs !== inverse.holdMs) return false;
  const inverseKey: Record<Extract<RelativeCameraAction, { kind: "key_hold" }>["key"], string> = {
    w: "s", s: "w", a: "d", d: "a", q: "e", e: "q",
  };
  return inverse.key === inverseKey[outbound.key];
}

export function createRelativeRouteExecution(
  input: BoundRelativeRouteInput,
  deps: RelativeRouteDependencies,
): RelativeRouteExecution {
  const waypoints: RelativeRouteWaypoint[] = [];
  const actionAttempts: RelativeRouteActionAttempt[] = [];
  const terminalActionFailures: OrderedTerminalCameraActionFailure[] = [];
  const allocatedPaths = new Set<string>();
  const usage = { actions: 0, waypoints: 0, holdMs: 0, dragPx: 0, durationMs: 0 };
  let nextStepSeq = 1;
  let nextAttemptOrder = 1;
  let priorCaptureSha256 = input?.priorCaptureSha256;
  let canonicalSessionRoot: string | null = null;
  let startedAt: bigint | null = null;
  let lastObservedAt: bigint | null = null;
  let clockFailed = false;
  let initializationStatus: RelativeRouteStop | null = null;

  if (!validInput(input)
    || !deps
    || typeof deps.applyRelativeAction !== "function"
    || typeof deps.captureSettled !== "function"
    || typeof deps.allocateWaypointPath !== "function"
    || typeof deps.sleep !== "function"
    || typeof deps.monotonicNs !== "function") {
    initializationStatus = "budget_exhausted";
  } else {
    canonicalSessionRoot = canonicalExternalSessionRoot(input.artifactSession);
    if (!canonicalSessionRoot) initializationStatus = "budget_exhausted";
    else if (input.continuity.kind === "required" && !deps.sampleContinuity) initializationStatus = "binding_lost";
    else {
      try {
        startedAt = deps.monotonicNs();
        if (typeof startedAt !== "bigint") throw new Error("monotonic clock did not return bigint");
        lastObservedAt = startedAt;
      } catch {
        initializationStatus = "budget_exhausted";
      }
    }
  }

  const elapsedMs = (): number | null => {
    if (clockFailed || initializationStatus || startedAt === null || lastObservedAt === null) return null;
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
  const copyOutcome = <T>(candidate: RelativeRouteAttemptOutcome<T>): RelativeRouteAttemptOutcome<T> => ({
    status: candidate.status,
    evidence: candidate.evidence,
    detail: candidate.detail,
  });
  const copyAttempt = (attempt: RelativeRouteActionAttempt): RelativeRouteActionAttempt => ({
    ...attempt,
    identity: { ...attempt.identity },
    request: { ...attempt.request } as RelativeCameraAction,
    continuityBefore: copyOutcome(attempt.continuityBefore),
    action: copyOutcome(attempt.action),
    settle: copyOutcome(attempt.settle),
    continuityAfter: copyOutcome(attempt.continuityAfter),
  });
  const copyFailure = (failure: OrderedTerminalCameraActionFailure): OrderedTerminalCameraActionFailure => ({
    ...failure,
    attemptIdentity: { ...failure.attemptIdentity },
    receiptsSoFar: [...failure.receiptsSoFar],
    attemptedAction: { ...failure.attemptedAction } as RelativeCameraAction,
  });
  const traceWithoutClock = (status: RelativeRouteStop): RelativeRouteTrace => {
    const orderedFailures = terminalActionFailures.map(copyFailure);
    const trace: RelativeRouteTrace = {
      status,
      waypoints: [...waypoints],
      actionAttempts: actionAttempts.map(copyAttempt),
      terminalActionFailures: orderedFailures,
      usage: { ...usage },
    };
    if (orderedFailures.length) trace.terminalActionFailure = orderedFailures.at(-1)!;
    return trace;
  };
  const finish = (status: RelativeRouteStop): RelativeRouteTrace => {
    if (initializationStatus) return traceWithoutClock(initializationStatus);
    const durationMs = elapsedMs();
    if (durationMs === null) return traceWithoutClock("budget_exhausted");
    usage.durationMs = durationMs;
    return traceWithoutClock(status);
  };
  const outcome = (
    status: RelativeRouteStepOutcome["status"],
    waypoint: RelativeRouteWaypoint | null = null,
    actionReceipts: CameraActionReceipt[] = [],
    actionApplied = false,
    stepAttempts: RelativeRouteActionAttempt[] = [],
    terminalActionFailure?: OrderedTerminalCameraActionFailure,
  ): RelativeRouteStepOutcome => {
    const result: RelativeRouteStepOutcome = {
      status,
      waypoint,
      actionReceipts,
      actionApplied,
      actionAttempts: stepAttempts.map(copyAttempt),
    };
    if (terminalActionFailure) result.terminalActionFailure = terminalActionFailure;
    return result;
  };
  const reserveForLane = (lane: RelativeRouteWaypointMeta["lane"]): number =>
    lane === "active" ? input.budgets.recoveryReserveMs : 0;
  const waypointDurationForLane = (
    actions: readonly RelativeCameraAction[],
    lane: RelativeRouteWaypointMeta["lane"],
  ): number => conservativeWaypointDurationMs(input, actions) - input.budgets.recoveryReserveMs + reserveForLane(lane);
  const postCaptureForLane = (lane: RelativeRouteWaypointMeta["lane"]): number =>
    postCaptureReserveMs(input) - input.budgets.recoveryReserveMs + reserveForLane(lane);
  const postRenderForLane = (lane: RelativeRouteWaypointMeta["lane"]): number =>
    postRenderDwellReserveMs(input) - input.budgets.recoveryReserveMs + reserveForLane(lane);
  const activeRemainingMs = (observeClock = true): number => {
    const elapsed = observeClock
      ? elapsedMs()
      : startedAt !== null && lastObservedAt !== null
        ? Number((lastObservedAt - startedAt) / 1_000_000n)
        : null;
    return elapsed === null
      ? 0
      : Math.max(0, input.budgets.maxDurationMs - elapsed
        - input.budgets.recoveryReserveMs - ROUTE_FINALIZATION_RESERVE_MS);
  };
  const reservePath = (seq: number): string | null => {
    if (!canonicalSessionRoot) return null;
    let capturePath: string;
    try {
      capturePath = deps.allocateWaypointPath(seq);
    } catch {
      return null;
    }
    if (allocatedPaths.has(capturePath)
      || !capturePathBelongsToSession(input.artifactSession, canonicalSessionRoot, capturePath)) return null;
    allocatedPaths.add(capturePath);
    return capturePath;
  };
  const notReached = <T>(detail: string): RelativeRouteAttemptOutcome<T> => ({
    status: "not_reached",
    evidence: null,
    detail,
  });
  const succeeded = <T>(evidence: T): RelativeRouteAttemptOutcome<T> => ({
    status: "succeeded",
    evidence,
    detail: null,
  });
  const failed = <T>(detail: string, evidence: T | null = null): RelativeRouteAttemptOutcome<T> => ({
    status: "failed",
    evidence,
    detail,
  });
  const createActionAttempts = (
    actions: readonly RelativeCameraAction[],
    attemptedCount: number,
    receipts: readonly CameraActionReceipt[],
    continuityBefore: RouteContinuityObservation,
    seq: number,
    lane: RelativeRouteWaypointMeta["lane"],
    meta: Omit<RelativeRouteWaypointMeta, "lane"> | undefined,
    terminalFailure?: TerminalCameraActionFailure,
  ): RelativeRouteActionAttempt[] => {
    const created: RelativeRouteActionAttempt[] = [];
    for (let actionIndex = 0; actionIndex < attemptedCount; actionIndex++) {
      const request = actions[actionIndex];
      if (!request) break;
      const receipt = receipts[actionIndex] ?? null;
      const terminalFailureAttempt = terminalFailure !== undefined && actionIndex === attemptedCount - 1;
      const actionSucceeded = !terminalFailureAttempt && receipt?.status === "applied"
        && (request.kind !== "key_hold" || receipt.ack.releaseCertain === true);
      const detail = actionSucceeded
        ? null
        : actionIndex === attemptedCount - 1 && terminalFailure
          ? terminalFailure.terminalError
          : receipt?.error ?? (receipt ? `camera action returned ${receipt.status}` : "camera action produced no receipt");
      const attempt: RelativeRouteActionAttempt = {
        identity: { executionId: input.artifactSession.runId, stepSeq: seq, actionIndex },
        order: nextAttemptOrder++,
        request,
        lane,
        recoveryLane: lane === "recovery",
        ...(meta?.pairId ? { pairId: meta.pairId } : {}),
        ...(meta?.pairRole ? { pairRole: meta.pairRole } : {}),
        continuityBefore: succeeded(continuityBefore),
        action: actionSucceeded ? succeeded(receipt!) : failed(detail ?? "camera action failed", receipt),
        settle: notReached("settlement was not reached"),
        continuityAfter: notReached("post-action continuity was not reached"),
      };
      actionAttempts.push(attempt);
      created.push(attempt);
    }
    return created;
  };
  const retainTerminalActionFailure = (
    failure: TerminalCameraActionFailure,
    stepAttempts: readonly RelativeRouteActionAttempt[],
  ): OrderedTerminalCameraActionFailure | undefined => {
    const terminalAttempt = stepAttempts.at(-1);
    if (!terminalAttempt) return undefined;
    const ordered: OrderedTerminalCameraActionFailure = {
      ...failure,
      attemptIdentity: { ...terminalAttempt.identity },
      receiptsSoFar: [...failure.receiptsSoFar],
      attemptedAction: { ...failure.attemptedAction } as RelativeCameraAction,
    };
    terminalActionFailures.push(ordered);
    return ordered;
  };
  const setSettleOutcome = (
    stepAttempts: readonly RelativeRouteActionAttempt[],
    settle: RelativeRouteAttemptOutcome<CaptureSettledReceipt>,
  ) => {
    for (const attempt of stepAttempts) attempt.settle = copyOutcome(settle);
  };
  const setContinuityAfter = (
    stepAttempts: readonly RelativeRouteActionAttempt[],
    continuityAfter: RelativeRouteAttemptOutcome<RouteContinuityObservation>,
  ) => {
    for (const attempt of stepAttempts) attempt.continuityAfter = copyOutcome(continuityAfter);
  };

  const executeStepInternal = async (
    requested: readonly RelativeCameraAction[],
    lane: RelativeRouteWaypointMeta["lane"],
    meta?: Omit<RelativeRouteWaypointMeta, "lane">,
    reservedStep?: { seq: number; capturePath: string },
  ): Promise<RelativeRouteStepOutcome> => {
    if (initializationStatus) return outcome(initializationStatus === "binding_lost" ? "binding_lost" : "budget_exhausted");
    if (!Array.isArray(requested) || requested.length === 0
      || (!reservedStep && nextStepSeq > input.budgets.maxWaypoints)) {
      return outcome("budget_exhausted");
    }
    const actions = [...requested];
    const groupUsage: ActionUsage[] = [];
    for (const action of actions) {
      const measured = actionUsage(action);
      if (!measured
        || measured.holdMs > input.budgets.maxHoldMsPerAction
        || measured.dragPx > input.budgets.maxDragPxPerAction) return outcome("budget_exhausted");
      groupUsage.push(measured);
    }
    const groupHoldMs = groupUsage.reduce((sum, measured) => sum + measured.holdMs, 0);
    const groupDragPx = groupUsage.reduce((sum, measured) => sum + measured.dragPx, 0);
    if (usage.actions + actions.length > input.budgets.maxActions
      || usage.holdMs + groupHoldMs > input.budgets.maxCumulativeHoldMs
      || usage.dragPx + groupDragPx > input.budgets.maxCumulativeDragPx) return outcome("budget_exhausted");

    const elapsedBeforeWaypointMs = elapsedMs();
    if (elapsedBeforeWaypointMs === null
      || elapsedBeforeWaypointMs + waypointDurationForLane(actions, lane) > input.budgets.maxDurationMs) {
      return outcome("budget_exhausted");
    }
    const seq = reservedStep?.seq ?? nextStepSeq++;
    const capturePath = reservedStep?.capturePath ?? reservePath(seq);
    if (!capturePath) return outcome("route_unsettled");

    const continuityBefore = await observeContinuity(input, deps);
    if (!continuityBefore || !continuityBefore.matches) return outcome("binding_lost");
    const elapsedAfterContinuityMs = elapsedMs();
    const remainingWaypointReserveMs = waypointDurationForLane(actions, lane)
      - (input.continuity.kind === "required" ? APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS : 0);
    if (elapsedAfterContinuityMs === null
      || elapsedAfterContinuityMs + remainingWaypointReserveMs > input.budgets.maxDurationMs) {
      return outcome("budget_exhausted");
    }

    let actionReceipts: CameraActionReceipt[];
    let stepAttempts: RelativeRouteActionAttempt[] = [];
    try {
      let actionIndex = 0;
      actionReceipts = await executeBoundCameraActions(input.runtimeBinding, actions, {
        applyRelativeAction: (action) => {
          const remainingOperationMs = waypointDurationForLane(actions.slice(actionIndex++), lane)
            - (input.continuity.kind === "required" ? APPLICATION_CONTINUITY_SAMPLE_RESERVE_MS : 0);
          return deps.applyRelativeAction(action, {
            canStart: () => {
              const elapsed = elapsedMs();
              return elapsed !== null && elapsed + remainingOperationMs <= input.budgets.maxDurationMs;
            },
          });
        },
      });
    } catch (error) {
      if (error instanceof CameraActionExecutionError) {
        for (let index = 0; index < error.attemptedCount; index++) {
          usage.actions++;
          usage.holdMs += groupUsage[index]?.holdMs ?? 0;
          usage.dragPx += groupUsage[index]?.dragPx ?? 0;
        }
        const failure = error.toTerminalFailure();
        stepAttempts = createActionAttempts(
          actions,
          error.attemptedCount,
          error.retainedReceipts,
          continuityBefore.observation,
          seq,
          lane,
          meta,
          failure,
        );
        const orderedFailure = retainTerminalActionFailure(failure, stepAttempts);
        return outcome("action_failed", null, error.retainedReceipts, false, stepAttempts, orderedFailure);
      }
      return outcome("action_failed");
    }
    for (let index = 0; index < actionReceipts.length; index++) {
      usage.actions++;
      usage.holdMs += groupUsage[index]?.holdMs ?? 0;
      usage.dragPx += groupUsage[index]?.dragPx ?? 0;
    }
    const uncertainIndex = actionReceipts.findIndex((receipt, index) =>
      receipt.status === "release_uncertain"
      || (actions[index]?.kind === "key_hold" && receipt.ack.releaseCertain !== true));
    if (uncertainIndex >= 0) {
      const failure = failureFromReturnedReceipt("release_uncertain", actions, actionReceipts, uncertainIndex);
      stepAttempts = createActionAttempts(
        actions,
        actionReceipts.length,
        actionReceipts,
        continuityBefore.observation,
        seq,
        lane,
        meta,
        failure,
      );
      const orderedFailure = retainTerminalActionFailure(failure, stepAttempts);
      return outcome("input_release_uncertain", null, actionReceipts, false, stepAttempts, orderedFailure);
    }
    const failedIndex = actionReceipts.findIndex((receipt) => receipt.status !== "applied");
    if (failedIndex >= 0) {
      const failure = failureFromReturnedReceipt("reported_action_failure", actions, actionReceipts, failedIndex);
      stepAttempts = createActionAttempts(
        actions,
        actionReceipts.length,
        actionReceipts,
        continuityBefore.observation,
        seq,
        lane,
        meta,
        failure,
      );
      const orderedFailure = retainTerminalActionFailure(failure, stepAttempts);
      return outcome("action_failed", null, actionReceipts, false, stepAttempts, orderedFailure);
    }
    stepAttempts = createActionAttempts(
      actions,
      actionReceipts.length,
      actionReceipts,
      continuityBefore.observation,
      seq,
      lane,
      meta,
    );
    if (actionReceipts.length !== actions.length) {
      return outcome("action_failed", null, actionReceipts, false, stepAttempts);
    }
    const actionApplied = true;

    try {
      await deps.sleep(POST_ACTION_RENDER_DWELL_MS);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSettleOutcome(stepAttempts, failed(`post-action render dwell failed: ${detail}`));
      return outcome("route_unsettled", null, actionReceipts, actionApplied, stepAttempts);
    }
    const elapsedAfterDwellMs = elapsedMs();
    if (elapsedAfterDwellMs === null
      || elapsedAfterDwellMs + postRenderForLane(lane) > input.budgets.maxDurationMs) {
      setSettleOutcome(stepAttempts, failed("deadline exhausted after post-action render dwell"));
      return outcome("budget_exhausted", null, actionReceipts, actionApplied, stepAttempts);
    }

    let settle: CaptureSettledReceipt;
    try {
      settle = await deps.captureSettled(capturePath, {
        priorSha256: priorCaptureSha256,
        remainingMs: () => {
          const elapsed = elapsedMs();
          return elapsed === null ? 0 : Math.max(0, input.budgets.maxDurationMs - elapsed - postCaptureForLane(lane));
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSettleOutcome(stepAttempts, failed(`settled capture failed: ${detail}`));
      return outcome("route_unsettled", null, actionReceipts, actionApplied, stepAttempts);
    }
    const elapsedAfterCaptureMs = elapsedMs();
    if (elapsedAfterCaptureMs === null
      || elapsedAfterCaptureMs + postCaptureForLane(lane) > input.budgets.maxDurationMs) {
      setSettleOutcome(stepAttempts, failed("deadline exhausted after settled capture", settle));
      return outcome("budget_exhausted", null, actionReceipts, actionApplied, stepAttempts);
    }
    try {
      if (!settledReceiptMatches(capturePath, input, settle)) {
        setSettleOutcome(stepAttempts, failed("settled capture receipt failed exact binding validation", settle));
        return outcome("route_unsettled", null, actionReceipts, actionApplied, stepAttempts);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSettleOutcome(stepAttempts, failed(`settled capture receipt validation failed: ${detail}`, settle));
      return outcome("route_unsettled", null, actionReceipts, actionApplied, stepAttempts);
    }
    const continuityAfter = await observeContinuity(input, deps);
    if (!continuityAfter) {
      setSettleOutcome(stepAttempts, settle.status === "settled" && settle.settlementSatisfied
        && settle.sha256 !== priorCaptureSha256
        ? succeeded(settle)
        : failed("settled capture did not establish a fresh baseline", settle));
      setContinuityAfter(stepAttempts, failed("post-action continuity could not be sampled"));
      return outcome("binding_lost", null, actionReceipts, actionApplied, stepAttempts);
    }
    const waypoint: RelativeRouteWaypoint = {
      seq,
      actions,
      actionReceipts,
      continuityBefore: continuityBefore.observation,
      settle,
      continuityAfter: continuityAfter.observation,
      ...(meta ? { meta: { lane, ...meta } } : {}),
    };
    waypoints.push(waypoint);
    usage.waypoints++;
    if (settle.status !== "settled" || !settle.settlementSatisfied || settle.sha256 === priorCaptureSha256) {
      setSettleOutcome(stepAttempts, failed("settled capture did not establish a fresh baseline", settle));
      setContinuityAfter(stepAttempts, continuityAfter.matches
        ? succeeded(continuityAfter.observation)
        : failed("post-action continuity no longer matches the bound runtime", continuityAfter.observation));
      return outcome("route_unsettled", waypoint, actionReceipts, actionApplied, stepAttempts);
    }
    setSettleOutcome(stepAttempts, succeeded(settle));
    if (!continuityAfter.matches) {
      setContinuityAfter(stepAttempts, failed("post-action continuity no longer matches the bound runtime", continuityAfter.observation));
      return outcome("binding_lost", waypoint, actionReceipts, actionApplied, stepAttempts);
    }
    setContinuityAfter(stepAttempts, succeeded(continuityAfter.observation));
    const elapsedAfterFinalContinuityMs = elapsedMs();
    if (elapsedAfterFinalContinuityMs === null
      || elapsedAfterFinalContinuityMs + reserveForLane(lane) + ROUTE_FINALIZATION_RESERVE_MS
        > input.budgets.maxDurationMs) {
      return outcome("budget_exhausted", waypoint, actionReceipts, actionApplied, stepAttempts);
    }
    priorCaptureSha256 = settle.sha256!;
    return outcome("settled", waypoint, actionReceipts, actionApplied, stepAttempts);
  };

  const executeStep: RelativeRouteExecution["executeStep"] = (actions, meta) =>
    executeStepInternal(actions, "active", meta);

  const adoptSettledBaseline = (receipt: CaptureSettledReceipt): boolean => {
    if (initializationStatus || !canonicalSessionRoot || !receipt?.path || allocatedPaths.has(receipt.path)) return false;
    try {
      if (!capturePathBelongsToSession(input.artifactSession, canonicalSessionRoot, receipt.path)
        || !settledReceiptMatches(receipt.path, input, receipt)
        || receipt.status !== "settled"
        || !receipt.settlementSatisfied
        || !receipt.sha256) return false;
    } catch {
      return false;
    }
    allocatedPaths.add(receipt.path);
    priorCaptureSha256 = receipt.sha256;
    return true;
  };

  const executePairedStep: RelativeRouteExecution["executePairedStep"] = async (outbound, inverse, meta) => {
    const refused = (status: RelativeRouteStepOutcome["status"]): RelativeRoutePairedStepOutcome => {
      const outboundResult = outcome(status);
      return { primaryStatus: status, outbound: outboundResult, restore: null, recoveryUsed: false };
    };
    if (initializationStatus || typeof meta?.pairId !== "string" || meta.pairId.length === 0
      || !inverseActionsMatch(outbound, inverse)) return refused("budget_exhausted");
    const measured = [actionUsage(outbound), actionUsage(inverse)];
    if (measured.some((candidate) => !candidate)
      || measured.some((candidate) => candidate!.holdMs > input.budgets.maxHoldMsPerAction
        || candidate!.dragPx > input.budgets.maxDragPxPerAction)) return refused("budget_exhausted");
    const combinedHold = measured.reduce((sum, candidate) => sum + candidate!.holdMs, 0);
    const combinedDrag = measured.reduce((sum, candidate) => sum + candidate!.dragPx, 0);
    const recoveryDuration = waypointDurationForLane([inverse], "recovery");
    const elapsed = elapsedMs();
    if (usage.actions + 2 > input.budgets.maxActions
      || nextStepSeq + 1 > input.budgets.maxWaypoints
      || usage.holdMs + combinedHold > input.budgets.maxCumulativeHoldMs
      || usage.dragPx + combinedDrag > input.budgets.maxCumulativeDragPx
      || recoveryDuration > input.budgets.recoveryReserveMs
      || elapsed === null
      || elapsed + waypointDurationForLane([outbound], "active") > input.budgets.maxDurationMs) {
      return refused("budget_exhausted");
    }
    const outboundSeq = nextStepSeq;
    const restoreSeq = nextStepSeq + 1;
    const outboundPath = reservePath(outboundSeq);
    const restorePath = outboundPath ? reservePath(restoreSeq) : null;
    if (!outboundPath || !restorePath) return refused("route_unsettled");
    nextStepSeq += 2;

    const outboundResult = await executeStepInternal(
      [outbound],
      "active",
      { pairId: meta.pairId, pairRole: "outbound" },
      { seq: outboundSeq, capturePath: outboundPath },
    );
    if (!outboundResult.actionApplied) {
      return {
        primaryStatus: outboundResult.status,
        outbound: outboundResult,
        restore: null,
        recoveryUsed: false,
      };
    }
    if (outboundResult.waypoint?.settle.status === "settled"
      && outboundResult.waypoint.settle.settlementSatisfied
      && outboundResult.waypoint.settle.sha256
      && outboundResult.waypoint.settle.sha256 !== priorCaptureSha256) {
      priorCaptureSha256 = outboundResult.waypoint.settle.sha256;
    }
    const beforeRestore = elapsedMs();
    const activeRestoreFits = beforeRestore !== null
      && beforeRestore + waypointDurationForLane([inverse], "active") <= input.budgets.maxDurationMs;
    const recoveryUsed = !activeRestoreFits;
    const restore = await executeStepInternal(
      [inverse],
      recoveryUsed ? "recovery" : "active",
      { pairId: meta.pairId, pairRole: "restore" },
      { seq: restoreSeq, capturePath: restorePath },
    );
    return {
      primaryStatus: outboundResult.status,
      outbound: outboundResult,
      restore,
      recoveryUsed,
    };
  };

  return { activeRemainingMs, executeStep, adoptSettledBaseline, executePairedStep, finish };
}

export async function executeRelativeCameraRoute(
  input: BoundRelativeRouteInput,
  decide: RelativeRouteDecision,
  deps: RelativeRouteDependencies,
): Promise<RelativeRouteTrace> {
  const execution = createRelativeRouteExecution(input, deps);
  const decisionWaypoints: RelativeRouteWaypoint[] = [];
  while (true) {
    const initialDecisionRemainingMs = execution.activeRemainingMs(false);
    if (initialDecisionRemainingMs <= 0) return execution.finish("budget_exhausted");
    let decision: RelativeCameraAction[] | "stop";
    let decisionTimedOut = false;
    const controller = new AbortController();
    let decisionTimer: NodeJS.Timeout | null = null;
    let decisionPromise: Promise<RelativeCameraAction[] | "stop"> | null = null;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        decisionTimer = setTimeout(() => {
          decisionTimedOut = true;
          controller.abort("relative route decision deadline exhausted");
          reject(new Error("relative route decision deadline exhausted"));
        }, Math.max(1, Math.min(initialDecisionRemainingMs, 2_147_483_647)));
      });
      decisionPromise = Promise.resolve().then(() => decide([...decisionWaypoints], {
        remainingMs: execution.activeRemainingMs,
        signal: controller.signal,
      }));
      decision = await Promise.race([decisionPromise, deadline]);
    } catch {
      controller.abort("relative route decision failed or exceeded its deadline");
      if (decisionPromise) {
        // JavaScript callers can still violate the synchronous/pure controller type. Observe a late
        // rejection without draining the loser; only explicit RelativeRouteExecution steps can mutate
        // route state, so a late decision can never allocate, apply input, or capture through this loop.
        void decisionPromise.catch(() => undefined);
      }
      return execution.finish(decisionTimedOut ? "budget_exhausted" : "action_failed");
    } finally {
      if (decisionTimer) clearTimeout(decisionTimer);
    }
    if (decision === "stop") return execution.finish("controller_stop");
    if (!Array.isArray(decision) || decision.length === 0) return execution.finish("budget_exhausted");
    const step = await execution.executeStep(decision);
    if (step.waypoint) decisionWaypoints.push(step.waypoint);
    if (step.status !== "settled") return execution.finish(step.status);
  }
}
