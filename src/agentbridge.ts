import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { okJson, run, runBinary, sleep } from "./util.js";

export const AGENT_BRIDGE_SCENE_PAYLOAD_KIND = "pico.agent-bridge.scene-snapshot" as const;
export const AGENT_BRIDGE_SCENE_SCHEMA_VERSION = 1 as const;
export const AGENT_BRIDGE_SCENE_REVISION = 41 as const;
export const AGENT_BRIDGE_SCENE_COORDINATE_FRAME_ID = `bridge-world-${AGENT_BRIDGE_SCENE_REVISION}` as const;
export const AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND = "query_scene_anchors" as const;
export const AGENT_BRIDGE_SCENE_SNAPSHOT_CACHE_DIRECTORY = "agentbridge/scene-snapshots" as const;

export const AGENT_BRIDGE_NAVIGATION_GUIDE_PAYLOAD_KIND = "pico.agent-bridge.navigation-guide" as const;
export const AGENT_BRIDGE_NAVIGATION_GUIDE_SCHEMA_VERSION = 1 as const;
export const AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION = 1 as const;
export const AGENT_BRIDGE_NAVIGATION_GUIDE_COMMAND = "navigation_guide" as const;
export const AGENT_BRIDGE_NAVIGATION_GUIDE_CACHE_DIRECTORY = "agentbridge/navigation-guides" as const;
export const AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN = "nested-corners-v1" as const;
export const AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL = "viewer-facing-planar-v1" as const;
export const AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS = [[255, 0, 255], [0, 255, 255]] as const;
// Producer-owned outer frame: the 0.68m x 0.42m mission footprint plus a small visible margin,
// while remaining inside the measured 0.782631m x 0.464378m Livingroom TABLE support.
export const AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M = 0.74 as const;
export const AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M = 0.44 as const;

export const AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND = "pico.agent-bridge.locomotion" as const;
export const AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION = 1 as const;
export const AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION = 1 as const;
export const AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY = "agentbridge/locomotion" as const;
export const AGENT_BRIDGE_LOCOMOTION_ROOT_ID = "AgentWorldRoot" as const;
export const AGENT_BRIDGE_COMMANDS_COMMAND = "commands" as const;
export const AGENT_BRIDGE_HMD_POSE_COMMAND = "hmd_pose" as const;
export const AGENT_BRIDGE_LOCOMOTE_COMMAND = "locomote" as const;
export const AGENT_BRIDGE_LOCOMOTION_COMMANDS = [
  AGENT_BRIDGE_COMMANDS_COMMAND,
  AGENT_BRIDGE_HMD_POSE_COMMAND,
  AGENT_BRIDGE_LOCOMOTE_COMMAND,
] as const;

const SCENE_SNAPSHOT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,96}$/;
const ANDROID_PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const NAVIGATION_GUIDE_SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;
const NAVIGATION_GUIDE_TRACE_ID_PATTERN = /^anchor-\d{4}$/;
const PRINTABLE_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;
const LOCOMOTION_TAG_PATTERN = /^[\x21-\x7e]{1,120}$/;
const LOCOMOTION_INCARNATION_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type AgentBridgeNavigationGuideMode = "show" | "hide";

export interface AgentBridgeNavigationGuideRequestInput {
  serial: string;
  packageName: string;
  requestId: string;
  mode: AgentBridgeNavigationGuideMode;
  sceneSnapshotId: string;
  targetTraceId: string;
  targetRuntimeUuid: string;
  pattern: typeof AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN;
  projectionModel: typeof AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL;
  colors: [number[], number[]] | readonly [readonly number[], readonly number[]];
  widthM: number;
  heightM: number;
  maxPolls?: number;
  pollMs?: number;
  stabilityReads?: number;
  ackReadTimeoutMs?: number;
  controlTimeoutMs?: number;
}

export interface AgentBridgeNavigationGuideAck {
  kind: typeof AGENT_BRIDGE_NAVIGATION_GUIDE_PAYLOAD_KIND;
  schemaVersion: typeof AGENT_BRIDGE_NAVIGATION_GUIDE_SCHEMA_VERSION;
  bridgeRevision: typeof AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION;
  requestId: string;
  application: { packageName: string };
  mode: AgentBridgeNavigationGuideMode;
  sceneSnapshotId: string;
  targetTraceId: string;
  targetRuntimeUuid: string;
  pattern: typeof AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN;
  projectionModel: typeof AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL;
  colors: [[255, 0, 255], [0, 255, 255]];
  widthM: number;
  heightM: number;
  outcome: "shown" | "hidden" | "rejected" | "failed";
  guideState: "visible" | "hidden" | "unknown";
  cleanupState: "not_required" | "completed" | "failed";
  error: { code: string; detail: string } | null;
}

export interface AgentBridgeNavigationGuideActionReceipt {
  action:
    | "navigation_guide_broadcast"
    | "navigation_guide_ack_pull"
    | "navigation_guide_ack_cleanup"
    | "navigation_guide_invalidation_broadcast"
    | "navigation_guide_invalidation_ack_pull"
    | "navigation_guide_invalidation_ack_cleanup"
    | "navigation_guide_late_ack_cleanup";
  status: "applied" | "failed";
  startedAtMonotonicNs: string;
  endedAtMonotonicNs: string;
  ack: Record<string, unknown>;
  error?: string;
}

export type AgentBridgeNavigationGuideRequestResult =
  | {
      ok: true;
      ack: AgentBridgeNavigationGuideAck;
      terminalGuideState: "visible" | "hidden";
      cleanupProven: boolean;
      actionReceipts: AgentBridgeNavigationGuideActionReceipt[];
      evidenceCeiling: "structural";
    }
  | {
      ok: false;
      code: "bridge_unavailable" | "invalid_ack" | "guest_rejected" | "cleanup_failed";
      detail: string;
      ack?: AgentBridgeNavigationGuideAck;
      terminalGuideState: "hidden" | "unknown";
      cleanupProven: boolean;
      actionReceipts: AgentBridgeNavigationGuideActionReceipt[];
      evidenceCeiling: "structural";
    };

interface NavigationGuideRequestDeps {
  runText?: typeof run;
  runBytes?: typeof runBinary;
  sleep?: typeof sleep;
  monotonicNs?: () => bigint;
}

const navigationGuideAckSchema = z.object({
  kind: z.literal(AGENT_BRIDGE_NAVIGATION_GUIDE_PAYLOAD_KIND),
  schemaVersion: z.literal(AGENT_BRIDGE_NAVIGATION_GUIDE_SCHEMA_VERSION),
  bridgeRevision: z.literal(AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION),
  requestId: z.string().regex(SCENE_SNAPSHOT_REQUEST_ID_PATTERN),
  application: z.object({ packageName: z.string().regex(ANDROID_PACKAGE_PATTERN) }).strict(),
  mode: z.enum(["show", "hide"]),
  sceneSnapshotId: z.string().regex(NAVIGATION_GUIDE_SNAPSHOT_ID_PATTERN),
  targetTraceId: z.string().regex(NAVIGATION_GUIDE_TRACE_ID_PATTERN),
  targetRuntimeUuid: z.string().regex(PRINTABLE_ID_PATTERN),
  pattern: z.literal(AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN),
  projectionModel: z.literal(AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL),
  colors: z.tuple([
    z.tuple([z.literal(255), z.literal(0), z.literal(255)]),
    z.tuple([z.literal(0), z.literal(255), z.literal(255)]),
  ]),
  widthM: z.number().finite(),
  heightM: z.number().finite(),
  outcome: z.enum(["shown", "hidden", "rejected", "failed"]),
  guideState: z.enum(["visible", "hidden", "unknown"]),
  cleanupState: z.enum(["not_required", "completed", "failed"]),
  error: z.object({ code: z.string().min(1).max(120), detail: z.string().min(1).max(500) }).strict().nullable(),
}).strict();

function sameGuideColors(colors: AgentBridgeNavigationGuideRequestInput["colors"]): boolean {
  return Array.isArray(colors) && colors.length === 2
    && colors.every((color) => Array.isArray(color) && color.length === 3 && color.every(Number.isInteger))
    && colors[0].every((channel, index) => channel === AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS[0][index])
    && colors[1].every((channel, index) => channel === AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS[1][index]);
}

function navigationGuideInputError(adb: string, input: AgentBridgeNavigationGuideRequestInput): string | null {
  if (!adb) return "adb executable path is empty";
  if (!/^[\x21-\x7e]+$/.test(input.serial)) return "an exact printable adb serial is required";
  if (!ANDROID_PACKAGE_PATTERN.test(input.packageName)) return "packageName is not a valid Android package name";
  if (!SCENE_SNAPSHOT_REQUEST_ID_PATTERN.test(input.requestId)) return "requestId is not safe for the bridge cache path";
  if (input.mode !== "show" && input.mode !== "hide") return "mode must be show or hide";
  if (!NAVIGATION_GUIDE_SNAPSHOT_ID_PATTERN.test(input.sceneSnapshotId)) return "sceneSnapshotId must be a lowercase SHA-256";
  if (!NAVIGATION_GUIDE_TRACE_ID_PATTERN.test(input.targetTraceId)) return "targetTraceId must be a trace-local anchor ID";
  if (!PRINTABLE_ID_PATTERN.test(input.targetRuntimeUuid)) return "targetRuntimeUuid must be a non-empty printable runtime identity";
  if (input.pattern !== AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN) return "unsupported navigation-guide pattern";
  if (input.projectionModel !== AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL) return "unsupported navigation-guide projection model";
  if (!sameGuideColors(input.colors)) return "unsupported navigation-guide palette";
  if (input.widthM !== AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M || input.heightM !== AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M) {
    return "unsupported navigation-guide dimensions";
  }
  const maxPolls = input.maxPolls ?? 30;
  const pollMs = input.pollMs ?? 100;
  const stabilityReads = input.stabilityReads ?? 2;
  const ackReadTimeoutMs = input.ackReadTimeoutMs ?? 15_000;
  const controlTimeoutMs = input.controlTimeoutMs ?? 15_000;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 120) return "maxPolls must be an integer from 1 through 120";
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000) return "pollMs must be an integer from 10 through 60000";
  if (!Number.isInteger(stabilityReads) || stabilityReads < 2 || stabilityReads > 8) return "stabilityReads must be an integer from 2 through 8";
  if (!Number.isInteger(ackReadTimeoutMs) || ackReadTimeoutMs < 250 || ackReadTimeoutMs > 15_000) {
    return "ackReadTimeoutMs must be an integer from 250 through 15000";
  }
  if (!Number.isInteger(controlTimeoutMs) || controlTimeoutMs < 1_000 || controlTimeoutMs > 15_000) {
    return "controlTimeoutMs must be an integer from 1000 through 15000";
  }
  return null;
}

function navigationGuideAckError(ack: AgentBridgeNavigationGuideAck, input: AgentBridgeNavigationGuideRequestInput): string | null {
  if (ack.requestId !== input.requestId) return "ack requestId does not match the request";
  if (ack.application.packageName !== input.packageName) return "ack packageName does not match the request";
  if (ack.mode !== input.mode) return "ack mode does not match the request";
  if (ack.sceneSnapshotId !== input.sceneSnapshotId) return "ack sceneSnapshotId does not match the request";
  if (ack.targetTraceId !== input.targetTraceId) return "ack targetTraceId does not match the request";
  if (ack.targetRuntimeUuid !== input.targetRuntimeUuid) return "ack targetRuntimeUuid does not match the request";
  if (ack.pattern !== input.pattern || ack.projectionModel !== input.projectionModel || !sameGuideColors(ack.colors)) {
    return "ack fiducial does not match the request";
  }
  if (ack.widthM !== input.widthM || ack.heightM !== input.heightM) return "ack guide dimensions do not match the request";
  if (ack.outcome === "shown") {
    if (input.mode !== "show" || ack.guideState !== "visible" || ack.cleanupState !== "not_required" || ack.error !== null) {
      return "shown ack has contradictory mode, guide, cleanup, or error state";
    }
  } else if (ack.outcome === "hidden") {
    if (input.mode !== "hide" || ack.guideState !== "hidden" || ack.cleanupState !== "completed" || ack.error !== null) {
      return "hidden ack has contradictory mode, guide, cleanup, or error state";
    }
  } else if (ack.error === null || ack.cleanupState === "not_required" || ack.guideState === "visible") {
    return "rejected/failed ack does not retain a cleanup/error terminal state";
  }
  return null;
}

type NavigationGuideFailureCode = "bridge_unavailable" | "invalid_ack" | "guest_rejected" | "cleanup_failed";

type NavigationGuideTransactionResult =
  | { ok: true; ack: AgentBridgeNavigationGuideAck; ackValidated: true }
  | { ok: false; code: NavigationGuideFailureCode; detail: string; ack?: AgentBridgeNavigationGuideAck; ackValidated: boolean };

interface NavigationGuideTransactionActions {
  broadcast: AgentBridgeNavigationGuideActionReceipt["action"];
  pull: AgentBridgeNavigationGuideActionReceipt["action"];
  cleanup: AgentBridgeNavigationGuideActionReceipt["action"];
}

const primaryNavigationGuideActions: NavigationGuideTransactionActions = {
  broadcast: "navigation_guide_broadcast",
  pull: "navigation_guide_ack_pull",
  cleanup: "navigation_guide_ack_cleanup",
};

const invalidationNavigationGuideActions: NavigationGuideTransactionActions = {
  broadcast: "navigation_guide_invalidation_broadcast",
  pull: "navigation_guide_invalidation_ack_pull",
  cleanup: "navigation_guide_invalidation_ack_cleanup",
};

function navigationGuideRelativePath(requestId: string): string {
  return `cache/${AGENT_BRIDGE_NAVIGATION_GUIDE_CACHE_DIRECTORY}/${requestId}.json`;
}

function navigationGuideInvalidationRequestId(input: AgentBridgeNavigationGuideRequestInput): string {
  const digest = createHash("sha256").update(`${input.packageName}\0${input.requestId}`, "utf8").digest("hex");
  return `navigation_guide_hide_${digest.slice(0, 32)}`;
}

function trustedNavigationGuideHidden(result: NavigationGuideTransactionResult): boolean {
  return !result.ok && result.code !== "cleanup_failed" && result.ackValidated === true && result.ack?.guideState === "hidden"
    && result.ack.cleanupState === "completed";
}

async function executeNavigationGuideTransaction(
  adb: string,
  input: AgentBridgeNavigationGuideRequestInput,
  actionReceipts: AgentBridgeNavigationGuideActionReceipt[],
  actions: NavigationGuideTransactionActions,
  deps: Required<NavigationGuideRequestDeps>,
): Promise<NavigationGuideTransactionResult> {
  const stamp = () => deps.monotonicNs().toString();
  const fail = (
    code: NavigationGuideFailureCode,
    detail: string,
    ack?: AgentBridgeNavigationGuideAck,
    ackValidated = false,
  ): NavigationGuideTransactionResult => ({ ok: false, code, detail, ...(ack ? { ack } : {}), ackValidated });
  const maxPolls = input.maxPolls ?? 30;
  const pollMs = input.pollMs ?? 100;
  const stabilityReads = input.stabilityReads ?? 2;
  const ackReadTimeoutMs = input.ackReadTimeoutMs ?? 15_000;
  const controlTimeoutMs = input.controlTimeoutMs ?? 15_000;
  const relativePath = navigationGuideRelativePath(input.requestId);

  const broadcastStartedAt = stamp();
  const broadcast = await deps.runText(adb, [
    "-s", input.serial, "shell", "am", "broadcast",
    "-a", `${input.packageName}.AGENT_CMD`, "-p", input.packageName,
    "--es", "cmd", AGENT_BRIDGE_NAVIGATION_GUIDE_COMMAND,
    "--es", "kind", AGENT_BRIDGE_NAVIGATION_GUIDE_PAYLOAD_KIND,
    "--ei", "schemaVersion", String(AGENT_BRIDGE_NAVIGATION_GUIDE_SCHEMA_VERSION),
    "--ei", "bridgeRevision", String(AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION),
    "--es", "requestId", input.requestId,
    "--es", "mode", input.mode,
    "--es", "sceneSnapshotId", input.sceneSnapshotId,
    "--es", "targetTraceId", input.targetTraceId,
    "--es", "targetRuntimeUuid", input.targetRuntimeUuid,
    "--es", "pattern", input.pattern,
    "--es", "projectionModel", input.projectionModel,
    "--es", "color0", input.colors[0].join(","),
    "--es", "color1", input.colors[1].join(","),
    "--ef", "widthM", String(input.widthM),
    "--ef", "heightM", String(input.heightM),
  ], { timeoutMs: controlTimeoutMs, maxOutputBytes: 64 * 1024 });
  const broadcastApplied = broadcast.code === 0 && !broadcast.timedOut;
  actionReceipts.push({
    action: actions.broadcast,
    status: broadcastApplied ? "applied" : "failed",
    startedAtMonotonicNs: broadcastStartedAt,
    endedAtMonotonicNs: stamp(),
    ack: {
      serial: input.serial,
      packageName: input.packageName,
      action: `${input.packageName}.AGENT_CMD`,
      command: AGENT_BRIDGE_NAVIGATION_GUIDE_COMMAND,
      requestId: input.requestId,
      mode: input.mode,
      outcome: broadcastApplied ? "completed" : broadcast.timedOut ? "timeout" : "failed",
    },
    error: broadcastApplied ? undefined
      : (broadcast.timedOut ? "broadcast timed out" : (broadcast.stderr || broadcast.stdout || "broadcast failed")).slice(-400),
  });

  let stablePayload: Buffer | null = null;
  let stableCount = 0;
  let attempts = 0;
  let pullDetail = broadcastApplied ? "ack file has not appeared" : "broadcast failed before ack polling";
  const pullStartedAt = stamp();
  if (broadcastApplied) {
    for (let poll = 0; poll < maxPolls; poll++) {
      attempts++;
      const pulled = await deps.runBytes(adb, [
        "-s", input.serial, "exec-out", "run-as", input.packageName,
        "sh", "-c", 'if test -f "$1"; then printf "\\001"; cat "$1"; else printf "\\000"; fi', "pico-mcp", relativePath,
      ], { timeoutMs: ackReadTimeoutMs, maxOutputBytes: 1024 * 1024 });
      const existenceByte = pulled.stdout[0];
      const filePresent = existenceByte === 0x01;
      const fileAbsent = existenceByte === 0x00 && pulled.stdout.length === 1;
      if (pulled.code === 0 && !pulled.timedOut && filePresent) {
        const bytes = pulled.stdout.subarray(1);
        if (stablePayload !== null && stablePayload.equals(bytes)) stableCount++;
        else {
          stablePayload = Buffer.from(bytes);
          stableCount = 1;
        }
        pullDetail = stableCount >= stabilityReads ? "ack bytes stabilized" : "awaiting a second byte-identical ack read";
        if (stableCount >= stabilityReads) break;
      } else {
        stablePayload = null;
        stableCount = 0;
        pullDetail = pulled.timedOut
          ? "run-as ack read timed out"
          : pulled.code === 0 && fileAbsent
            ? "ack file has not appeared"
            : pulled.stdout.length > 0
              ? `run-as ack existence protocol was invalid: ${pulled.stdout.toString("utf8").slice(-300)}`
              : (pulled.stderr || `run-as ack read exited ${pulled.code ?? "without a code"}`).slice(-400);
      }
      if (poll + 1 < maxPolls) await deps.sleep(pollMs);
    }
  }
  const pulledSuccessfully = stablePayload !== null && stableCount >= stabilityReads;
  actionReceipts.push({
    action: actions.pull,
    status: pulledSuccessfully ? "applied" : "failed",
    startedAtMonotonicNs: pullStartedAt,
    endedAtMonotonicNs: stamp(),
    ack: {
      serial: input.serial,
      packageName: input.packageName,
      requestId: input.requestId,
      mode: input.mode,
      relativePath,
      attempts,
      stabilityReads: stableCount,
      ...(pulledSuccessfully ? { bytes: stablePayload!.length, outcome: "completed" } : { outcome: "timeout" }),
    },
    error: pulledSuccessfully ? undefined : pullDetail,
  });

  let parsedAck: AgentBridgeNavigationGuideAck | undefined;
  let parsedAckError: string | null = null;
  if (pulledSuccessfully) {
    let raw: unknown;
    try {
      raw = JSON.parse(stablePayload!.toString("utf8"));
    } catch (error: any) {
      parsedAckError = `navigation-guide acknowledgement is not valid JSON: ${error?.message ?? String(error)}`;
    }
    if (parsedAckError === null) {
      const parsed = navigationGuideAckSchema.safeParse(raw);
      if (!parsed.success) {
        parsedAckError = `navigation-guide acknowledgement schema mismatch: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 700)}`;
      } else {
        parsedAck = parsed.data as AgentBridgeNavigationGuideAck;
        parsedAckError = navigationGuideAckError(parsedAck, input);
      }
    }
  }
  const ackValidated = parsedAck !== undefined && parsedAckError === null;

  const cleanupStartedAt = stamp();
  const cleanup = await deps.runText(
    adb,
    ["-s", input.serial, "shell", "run-as", input.packageName, "rm", "-f", relativePath],
    { timeoutMs: controlTimeoutMs, maxOutputBytes: 64 * 1024 },
  );
  const cleanupApplied = cleanup.code === 0 && !cleanup.timedOut;
  actionReceipts.push({
    action: actions.cleanup,
    status: cleanupApplied ? "applied" : "failed",
    startedAtMonotonicNs: cleanupStartedAt,
    endedAtMonotonicNs: stamp(),
    ack: {
      serial: input.serial,
      packageName: input.packageName,
      requestId: input.requestId,
      mode: input.mode,
      relativePath,
      outcome: cleanupApplied ? "completed" : cleanup.timedOut ? "timeout" : "failed",
    },
    error: cleanupApplied ? undefined
      : (cleanup.timedOut ? "ack cleanup timed out" : (cleanup.stderr || cleanup.stdout || "ack cleanup failed")).slice(-400),
  });

  if (!cleanupApplied) return fail("cleanup_failed", "navigation-guide acknowledgement cleanup failed", parsedAck, ackValidated);
  if (!broadcastApplied) return fail("bridge_unavailable", "Agent Bridge navigation-guide broadcast failed");
  if (!pulledSuccessfully) return fail("bridge_unavailable", `No stable terminal Agent Bridge guide acknowledgement appeared at ${relativePath}: ${pullDetail}`);
  if (parsedAckError !== null) return fail("invalid_ack", parsedAckError, parsedAck);
  const ack = parsedAck!;
  if (ack.outcome === "rejected" || ack.outcome === "failed") {
    return fail("guest_rejected", `${ack.error!.code}: ${ack.error!.detail}`, ack, true);
  }
  return { ok: true, ack, ackValidated: true };
}

/**
 * Requests one trace-local guide transition through an exact-serial, exact-package Agent Bridge.
 * The acknowledgement is accepted only from two consecutive byte-identical app-private file reads;
 * broadcast/logcat text is never parsed. A failed SHOW whose terminal hidden state is not trusted
 * sends exactly one bounded HIDE transaction, then sweeps the original nonce again for a late ack.
 */
export async function requestAgentBridgeNavigationGuide(
  adb: string,
  input: AgentBridgeNavigationGuideRequestInput,
  injected: NavigationGuideRequestDeps = {},
): Promise<AgentBridgeNavigationGuideRequestResult> {
  const actionReceipts: AgentBridgeNavigationGuideActionReceipt[] = [];
  const evidenceCeiling = "structural" as const;
  const deps: Required<NavigationGuideRequestDeps> = {
    runText: injected.runText ?? run,
    runBytes: injected.runBytes ?? runBinary,
    sleep: injected.sleep ?? sleep,
    monotonicNs: injected.monotonicNs ?? (() => process.hrtime.bigint()),
  };
  const finish = (
    result: NavigationGuideTransactionResult,
    provenHidden = trustedNavigationGuideHidden(result),
  ): AgentBridgeNavigationGuideRequestResult => result.ok
    ? {
        ok: true,
        ack: result.ack,
        terminalGuideState: result.ack.guideState === "hidden" ? "hidden" : "visible",
        cleanupProven: result.ack.guideState === "hidden" && result.ack.cleanupState === "completed",
        actionReceipts,
        evidenceCeiling,
      }
    : {
        ok: false,
        code: result.code,
        detail: result.detail,
        ...(result.ack ? { ack: result.ack } : {}),
        terminalGuideState: provenHidden ? "hidden" : "unknown",
        cleanupProven: provenHidden,
        actionReceipts,
        evidenceCeiling,
      };

  const inputError = navigationGuideInputError(adb, input);
  if (inputError) return {
    ok: false,
    code: "bridge_unavailable",
    detail: inputError,
    terminalGuideState: "unknown",
    cleanupProven: false,
    actionReceipts,
    evidenceCeiling,
  };

  const primary = await executeNavigationGuideTransaction(adb, input, actionReceipts, primaryNavigationGuideActions, deps);
  if (input.mode === "hide" || primary.ok || trustedNavigationGuideHidden(primary)) return finish(primary);

  // This helper executes the transaction primitive directly. A failed compensating HIDE therefore
  // returns evidence to this call and can never recursively schedule another invalidation.
  const invalidationInput: AgentBridgeNavigationGuideRequestInput = {
    ...input,
    requestId: navigationGuideInvalidationRequestId(input),
    mode: "hide",
  };
  const invalidation = await executeNavigationGuideTransaction(
    adb,
    invalidationInput,
    actionReceipts,
    invalidationNavigationGuideActions,
    deps,
  );

  const originalRelativePath = navigationGuideRelativePath(input.requestId);
  const lateCleanupStartedAt = deps.monotonicNs().toString();
  const lateCleanup = await deps.runText(
    adb,
    ["-s", input.serial, "shell", "run-as", input.packageName, "rm", "-f", originalRelativePath],
    { timeoutMs: input.controlTimeoutMs ?? 15_000, maxOutputBytes: 64 * 1024 },
  );
  const lateCleanupApplied = lateCleanup.code === 0 && !lateCleanup.timedOut;
  actionReceipts.push({
    action: "navigation_guide_late_ack_cleanup",
    status: lateCleanupApplied ? "applied" : "failed",
    startedAtMonotonicNs: lateCleanupStartedAt,
    endedAtMonotonicNs: deps.monotonicNs().toString(),
    ack: {
      serial: input.serial,
      packageName: input.packageName,
      requestId: input.requestId,
      relativePath: originalRelativePath,
      outcome: lateCleanupApplied ? "completed" : lateCleanup.timedOut ? "timeout" : "failed",
    },
    error: lateCleanupApplied ? undefined
      : (lateCleanup.timedOut ? "late acknowledgement cleanup timed out" : (lateCleanup.stderr || lateCleanup.stdout || "late acknowledgement cleanup failed")).slice(-400),
  });

  const invalidationClean = invalidation.ok || trustedNavigationGuideHidden(invalidation);
  if (!invalidationClean || !lateCleanupApplied) {
    return {
      ok: false,
      code: "cleanup_failed",
      detail: `${primary.code}: ${primary.detail}; navigation-guide invalidation did not prove bounded hidden cleanup`,
      ...(primary.ack ? { ack: primary.ack } : {}),
      terminalGuideState: "unknown",
      cleanupProven: false,
      actionReceipts,
      evidenceCeiling,
    };
  }
  return finish(primary, true);
}

export interface AgentBridgeLocomotionTransactionInput {
  serial: string;
  packageName: string;
  requestId: string;
  tag?: string;
  maxPolls?: number;
  pollMs?: number;
  stabilityReads?: number;
  ackReadTimeoutMs?: number;
  controlTimeoutMs?: number;
  /** Host-only absolute transaction deadline. It is never sent as guest wire payload. */
  deadlineMonotonicNs?: string;
}

export interface AgentBridgeLocomotionMinimumEnvelopeInput {
  maxPolls: number;
  pollMs: number;
  stabilityReads: number;
  executionDelayMs: number;
}

/**
 * Smallest host deadline envelope admitted for one rev-1 locomotion request.
 * Callers add any evidence/capture work that follows the transaction itself.
 */
export function agentBridgeLocomotionMinimumEnvelopeMs(
  input: AgentBridgeLocomotionMinimumEnvelopeInput,
): number {
  const cancellationPolls = Math.max(input.stabilityReads + 2, Math.min(input.maxPolls, 10));
  const finalizationCleanupReserveMs = 1_000 + input.stabilityReads * 250
    + Math.max(0, input.stabilityReads - 1) * input.pollMs + 1_000 + 250;
  const cancellationReserveMs = 1_000 + cancellationPolls * 250
    + Math.max(0, cancellationPolls - 1) * input.pollMs + finalizationCleanupReserveMs;
  return 1_000 + input.executionDelayMs + input.maxPolls * 250
    + Math.max(0, input.maxPolls - 1) * input.pollMs + cancellationReserveMs;
}

export interface AgentBridgeHmdPoseRequestInput extends AgentBridgeLocomotionTransactionInput {
  expectedRootGeneration?: number;
  expectedRootIncarnation: string;
}

export type AgentBridgeLocomotionMode = "direct" | "replacement";

export interface AgentBridgeLocomotionRequestInput extends AgentBridgeLocomotionTransactionInput {
  mode: AgentBridgeLocomotionMode;
  target: { x: number; y: number; z: number };
  rootGeneration: number;
  rootIncarnation: string;
  glideDurationMs: number;
  physicalWalk?: false;
  /** Host-only ownership transfer: the route removes the nonce after quiescence or owned stop. */
  deferNonceCleanup?: true;
}

export interface AgentBridgeLocomotionNonceCleanupReceipt {
  status: "route_owned" | "deferred_until_stop" | "removed_and_absent";
  requestId: string;
  relativePath: string;
  attempts: number;
  finalizationSha256?: string;
  removalError?: string;
}

export interface AgentBridgeLocomotionNonceCleanupInput {
  serial: string;
  packageName: string;
  requestId: string;
  tag: string;
  rootGeneration: number;
  rootIncarnation: string;
  controlTimeoutMs?: number;
  ackReadTimeoutMs?: number;
  pollMs?: number;
  stabilityReads?: number;
  deadlineMonotonicNs: string;
  /** Recovery after a proven process stop; no guest writer remains to finalize. */
  processStopped?: true;
  /** The sole removal already started; recovery may only re-probe pathname absence. */
  probeOnly?: true;
  /** Recovery-only bounded effects when the injected strict clock is unavailable. */
  cleanupOnly?: true;
}

export class AgentBridgeLocomotionNonceCleanupError extends Error {
  readonly finalizationProven: boolean;
  readonly removalStarted: boolean;
  readonly absenceProven = false;

  constructor(
    message: string,
    disposition: { finalizationProven: boolean; removalStarted: boolean },
  ) {
    super(message);
    this.name = "AgentBridgeLocomotionNonceCleanupError";
    this.finalizationProven = disposition.finalizationProven;
    this.removalStarted = disposition.removalStarted;
  }
}

export interface AgentBridgePosition {
  x: number;
  y: number;
  z: number;
}

export interface AgentBridgeWorldPose {
  rootGeneration: number;
  position: AgentBridgePosition;
}

export interface AgentBridgeHmdPose {
  readAtMonotonicNs: string;
  position: AgentBridgePosition;
  rotation: { x: number; y: number; z: number; w: number };
}

interface AgentBridgeLocomotionAckBase {
  kind: typeof AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND;
  schemaVersion: typeof AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION;
  capabilityRevision: typeof AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION;
  requestId: string;
  tag: string;
  application: { packageName: string };
  physicalWalk: false;
  primaryError: string | null;
  cleanupError: string | null;
}

export interface AgentBridgeLocomotionCapabilityAck extends AgentBridgeLocomotionAckBase {
  operation: typeof AGENT_BRIDGE_COMMANDS_COMMAND;
  outcome: "available" | "capability_unavailable" | "rejected" | "failed";
  commands: [typeof AGENT_BRIDGE_COMMANDS_COMMAND, typeof AGENT_BRIDGE_HMD_POSE_COMMAND, typeof AGENT_BRIDGE_LOCOMOTE_COMMAND];
  availability: {
    debuggable: boolean;
    observedStageStyle: "Full" | "Mixed" | null;
    rootContainer: "stage" | string | null;
    rootRegistered: boolean;
    hmdAvailable: boolean;
    locomotionAvailable: boolean;
  };
  root: { id: typeof AGENT_BRIDGE_LOCOMOTION_ROOT_ID; generation: number; incarnation: string } | null;
}

export interface AgentBridgeHmdPoseAck extends AgentBridgeLocomotionAckBase {
  operation: typeof AGENT_BRIDGE_HMD_POSE_COMMAND;
  outcome: "sampled" | "capability_unavailable" | "rejected" | "failed";
  root: { id: typeof AGENT_BRIDGE_LOCOMOTION_ROOT_ID; generation: number; incarnation: string } | null;
  hmdPose: AgentBridgeHmdPose | null;
}

export interface AgentBridgeLocomotionAck extends AgentBridgeLocomotionAckBase {
  operation: typeof AGENT_BRIDGE_LOCOMOTE_COMMAND;
  requestControl: "execute";
  executionLeaseMs: number;
  outcome: "completed" | "capability_unavailable" | "rejected" | "failed";
  mode: AgentBridgeLocomotionMode;
  target: AgentBridgePosition & { absolute: true };
  glideDurationMs: number;
  rootGenerationBefore: number;
  root: { id: typeof AGENT_BRIDGE_LOCOMOTION_ROOT_ID; generation: number; incarnation: string } | null;
  pose: AgentBridgeWorldPose | null;
  hmdPose: null;
}

export interface AgentBridgeLocomotionActionReceipt {
  action: "locomotion_broadcast" | "locomotion_ack_pull" | "locomotion_cancel" | "locomotion_ack_cleanup";
  status: "applied" | "failed";
  startedAtMonotonicNs: string;
  endedAtMonotonicNs: string;
  ack: Record<string, unknown>;
  error?: string;
}

export type AgentBridgeLocomotionRequestResult<Ack> =
  | {
      ok: true;
      ack: Ack;
      primaryError: null;
      cleanupError: null;
      motionQuiesced: true;
      nonceCleanup?: AgentBridgeLocomotionNonceCleanupReceipt;
      actionReceipts: AgentBridgeLocomotionActionReceipt[];
      evidenceCeiling: "structural";
    }
  | {
      ok: false;
      code: "invalid_request" | "bridge_unavailable" | "capability_unavailable" | "invalid_ack" | "guest_rejected" | "cleanup_failed";
      detail: string;
      primaryError: string | null;
      cleanupError: string | null;
      motionQuiesced: boolean;
      nonceCleanup?: AgentBridgeLocomotionNonceCleanupReceipt;
      ack?: Ack;
      actionReceipts: AgentBridgeLocomotionActionReceipt[];
      evidenceCeiling: "structural";
    };

interface AgentBridgeLocomotionDeps {
  runText?: typeof run;
  runBytes?: typeof runBinary;
  sleep?: typeof sleep;
  monotonicNs?: () => bigint;
}

const locomotionPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
}).strict();

const locomotionWorldPoseSchema = z.object({
  rootGeneration: z.number().int().safe().positive(),
  position: locomotionPositionSchema,
}).strict();

const locomotionHmdPoseSchema = z.object({
  readAtMonotonicNs: z.string().regex(/^(?:0|[1-9]\d*)$/),
  position: locomotionPositionSchema,
  rotation: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
    w: z.number().finite(),
  }).strict(),
}).strict();

const locomotionAckBaseSchema = z.object({
  kind: z.literal(AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND),
  schemaVersion: z.literal(AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION),
  capabilityRevision: z.literal(AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION),
  requestId: z.string().regex(SCENE_SNAPSHOT_REQUEST_ID_PATTERN),
  tag: z.string().regex(LOCOMOTION_TAG_PATTERN),
  application: z.object({ packageName: z.string().regex(ANDROID_PACKAGE_PATTERN) }).strict(),
  physicalWalk: z.literal(false),
  primaryError: z.string().min(1).max(500).nullable(),
  cleanupError: z.string().min(1).max(500).nullable(),
});

const locomotionCapabilityAckSchema = locomotionAckBaseSchema.extend({
  operation: z.literal(AGENT_BRIDGE_COMMANDS_COMMAND),
  outcome: z.enum(["available", "capability_unavailable", "rejected", "failed"]),
  commands: z.tuple([
    z.literal(AGENT_BRIDGE_COMMANDS_COMMAND),
    z.literal(AGENT_BRIDGE_HMD_POSE_COMMAND),
    z.literal(AGENT_BRIDGE_LOCOMOTE_COMMAND),
  ]),
  availability: z.object({
    debuggable: z.boolean(),
    observedStageStyle: z.enum(["Full", "Mixed"]).nullable(),
    rootContainer: z.string().min(1).max(120).nullable(),
    rootRegistered: z.boolean(),
    hmdAvailable: z.boolean(),
    locomotionAvailable: z.boolean(),
  }).strict(),
  root: z.object({
    id: z.literal(AGENT_BRIDGE_LOCOMOTION_ROOT_ID),
    generation: z.number().int().safe().positive(),
    incarnation: z.string().regex(LOCOMOTION_INCARNATION_PATTERN),
  }).strict().nullable(),
}).strict();

const locomotionHmdAckSchema = locomotionAckBaseSchema.extend({
  operation: z.literal(AGENT_BRIDGE_HMD_POSE_COMMAND),
  outcome: z.enum(["sampled", "capability_unavailable", "rejected", "failed"]),
  root: z.object({
    id: z.literal(AGENT_BRIDGE_LOCOMOTION_ROOT_ID),
    generation: z.number().int().safe().positive(),
    incarnation: z.string().regex(LOCOMOTION_INCARNATION_PATTERN),
  }).strict().nullable(),
  hmdPose: locomotionHmdPoseSchema.nullable(),
}).strict();

const locomotionActionAckSchema = locomotionAckBaseSchema.extend({
  operation: z.literal(AGENT_BRIDGE_LOCOMOTE_COMMAND),
  requestControl: z.literal("execute"),
  executionLeaseMs: z.number().int().min(1).max(30_000),
  outcome: z.enum(["completed", "capability_unavailable", "rejected", "failed"]),
  mode: z.enum(["direct", "replacement"]),
  target: locomotionPositionSchema.extend({ absolute: z.literal(true) }).strict(),
  glideDurationMs: z.number().int().min(0).max(10_000),
  rootGenerationBefore: z.number().int().safe().positive(),
  root: z.object({
    id: z.literal(AGENT_BRIDGE_LOCOMOTION_ROOT_ID),
    generation: z.number().int().safe().positive(),
    incarnation: z.string().regex(LOCOMOTION_INCARNATION_PATTERN),
  }).strict().nullable(),
  pose: locomotionWorldPoseSchema.nullable(),
  hmdPose: z.null(),
}).strict();

const locomotionCancelAckSchema = locomotionAckBaseSchema.extend({
  operation: z.literal(AGENT_BRIDGE_LOCOMOTE_COMMAND),
  requestControl: z.literal("cancel"),
  outcome: z.enum(["cancelled", "already_terminal", "cancel_failed"]),
  rootGenerationBefore: z.number().int().safe().positive(),
  root: z.object({
    id: z.literal(AGENT_BRIDGE_LOCOMOTION_ROOT_ID),
    generation: z.number().int().safe().positive(),
    incarnation: z.string().regex(LOCOMOTION_INCARNATION_PATTERN),
  }).strict(),
}).strict();

const locomotionFinalizeAckSchema = locomotionAckBaseSchema.extend({
  operation: z.literal(AGENT_BRIDGE_LOCOMOTE_COMMAND),
  requestControl: z.literal("finalize"),
  outcome: z.literal("finalized"),
  rootGenerationBefore: z.number().int().safe().positive(),
  root: z.object({
    id: z.literal(AGENT_BRIDGE_LOCOMOTION_ROOT_ID),
    generation: z.number().int().safe().positive(),
    incarnation: z.string().regex(LOCOMOTION_INCARNATION_PATTERN),
  }).strict(),
}).strict();

type LocomotionOperation = typeof AGENT_BRIDGE_LOCOMOTION_COMMANDS[number];
type AnyLocomotionAck = AgentBridgeLocomotionCapabilityAck | AgentBridgeHmdPoseAck | AgentBridgeLocomotionAck;

interface LocomotionTransactionSpec<Ack extends AnyLocomotionAck> {
  operation: LocomotionOperation;
  input: AgentBridgeLocomotionTransactionInput;
  extraBroadcastArgs: string[];
  schema: z.ZodType<Ack>;
  validateAck: (ack: Ack) => string | null;
  missingAckCode: "bridge_unavailable" | "capability_unavailable";
  preflightError?: string | null;
  executionDelayMs?: number;
  executionLeaseMs?: number;
  cancelIdentity?: { rootGeneration: number; rootIncarnation: string };
  deferNonceCleanup?: boolean;
}

function locomotionTag(input: AgentBridgeLocomotionTransactionInput): string {
  return input.tag ?? input.requestId;
}

function locomotionUnsafeIdentityError(adb: string, input: AgentBridgeLocomotionTransactionInput): string | null {
  if (!adb) return "adb executable path is empty";
  if (!/^[\x21-\x7e]+$/.test(input.serial)) return "an exact printable adb serial is required";
  if (!ANDROID_PACKAGE_PATTERN.test(input.packageName)) return "packageName is not a valid Android package name";
  if (!SCENE_SNAPSHOT_REQUEST_ID_PATTERN.test(input.requestId)) return "requestId is not safe for the bridge cache path";
  return null;
}

function locomotionPayloadInputError(input: AgentBridgeLocomotionTransactionInput): string | null {
  if (!LOCOMOTION_TAG_PATTERN.test(locomotionTag(input))) return "tag must be a non-empty printable identifier";
  const maxPolls = input.maxPolls ?? 30;
  const pollMs = input.pollMs ?? 100;
  const stabilityReads = input.stabilityReads ?? 2;
  const ackReadTimeoutMs = input.ackReadTimeoutMs ?? 15_000;
  const controlTimeoutMs = input.controlTimeoutMs ?? 15_000;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 120) return "maxPolls must be an integer from 1 through 120";
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000) return "pollMs must be an integer from 10 through 60000";
  if (!Number.isInteger(stabilityReads) || stabilityReads < 2 || stabilityReads > 8) return "stabilityReads must be an integer from 2 through 8";
  if (!Number.isInteger(ackReadTimeoutMs) || ackReadTimeoutMs < 250 || ackReadTimeoutMs > 15_000) {
    return "ackReadTimeoutMs must be an integer from 250 through 15000";
  }
  if (!Number.isInteger(controlTimeoutMs) || controlTimeoutMs < 1_000 || controlTimeoutMs > 15_000) {
    return "controlTimeoutMs must be an integer from 1000 through 15000";
  }
  if (input.deadlineMonotonicNs !== undefined && !/^[1-9][0-9]*$/.test(input.deadlineMonotonicNs)) {
    return "deadlineMonotonicNs must be one positive absolute monotonic nanosecond value";
  }
  return null;
}

function canonicalFloat32Number(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) return null;
  // Locomotion treats both IEEE-754 zero signs as the same world coordinate and emits +0.
  if (rounded === 0) return 0;
  for (let precision = 1; precision <= 9; precision++) {
    const candidate = Number(rounded.toPrecision(precision));
    if (Number.isFinite(candidate) && Math.fround(candidate) === rounded) return candidate;
  }
  return null;
}

function sameFloat32TransportValue(left: number, right: number): boolean {
  const leftFloat = Math.fround(left);
  const rightFloat = Math.fround(right);
  if (!Number.isFinite(leftFloat) || !Number.isFinite(rightFloat)) return false;
  // Match the canonicalization policy: +0 and -0 are one locomotion coordinate.
  if (leftFloat === 0 && rightFloat === 0) return true;
  return Object.is(leftFloat, rightFloat);
}

function sameFloat32TransportPosition(left: AgentBridgePosition, right: AgentBridgePosition): boolean {
  return sameFloat32TransportValue(left.x, right.x)
    && sameFloat32TransportValue(left.y, right.y)
    && sameFloat32TransportValue(left.z, right.z);
}

function canonicalLocomotionTarget(target: unknown): AgentBridgePosition | null {
  if (target === null || typeof target !== "object") return null;
  const value = target as Record<string, unknown>;
  if (typeof value.x !== "number" || typeof value.y !== "number" || typeof value.z !== "number") return null;
  const x = canonicalFloat32Number(value.x);
  const y = canonicalFloat32Number(value.y);
  const z = canonicalFloat32Number(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function locomotionEnvelopeAckError(
  ack: AnyLocomotionAck,
  operation: LocomotionOperation,
  input: AgentBridgeLocomotionTransactionInput,
): string | null {
  if (ack.requestId !== input.requestId) return "acknowledgement requestId does not match the request";
  if (ack.tag !== locomotionTag(input)) return "acknowledgement tag does not match the request";
  if (ack.application.packageName !== input.packageName) return "acknowledgement packageName does not match the request";
  if (ack.operation !== operation) return "acknowledgement operation does not match the request";
  return null;
}

function terminalLocomotionAckError(ack: AnyLocomotionAck): string | null {
  const success = ack.outcome === "available" || ack.outcome === "sampled" || ack.outcome === "completed";
  if (success && (ack.primaryError !== null || ack.cleanupError !== null)) {
    return "successful acknowledgement contains a primary or cleanup error";
  }
  if (!success && ack.primaryError === null) return "failed acknowledgement omitted its primary error";
  return null;
}

function locomotionRelativePath(requestId: string): string {
  return `cache/${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}/${requestId}.json`;
}

async function executeLocomotionTransaction<Ack extends AnyLocomotionAck>(
  adb: string,
  spec: LocomotionTransactionSpec<Ack>,
  injected: AgentBridgeLocomotionDeps,
): Promise<AgentBridgeLocomotionRequestResult<Ack>> {
  const actionReceipts: AgentBridgeLocomotionActionReceipt[] = [];
  const evidenceCeiling = "structural" as const;
  const deps: Required<AgentBridgeLocomotionDeps> = {
    runText: injected.runText ?? run,
    runBytes: injected.runBytes ?? runBinary,
    sleep: injected.sleep ?? sleep,
    monotonicNs: injected.monotonicNs ?? (() => process.hrtime.bigint()),
  };
  let lastClockNs = 0n;
  let clockError: string | null = null;
  let nonceCleanup: AgentBridgeLocomotionNonceCleanupReceipt | undefined;
  const clockNs = (): bigint => {
    try {
      const value = deps.monotonicNs();
      if (typeof value !== "bigint" || value < 0n) throw new Error("locomotion transaction monotonic clock is invalid");
      lastClockNs = value;
    } catch (error) {
      clockError ??= `locomotion transaction clock: ${error instanceof Error ? error.message : String(error)}`;
    }
    return lastClockNs;
  };
  const stamp = () => clockNs().toString();
  const fail = (
    code: Exclude<AgentBridgeLocomotionRequestResult<Ack>, { ok: true }>["code"],
    primaryError: string | null,
    cleanupError: string | null,
    ack?: Ack,
    motionQuiesced = spec.operation !== AGENT_BRIDGE_LOCOMOTE_COMMAND,
  ): AgentBridgeLocomotionRequestResult<Ack> => ({
    ok: false,
    code,
    detail: primaryError === null ? cleanupError! : cleanupError === null
      ? primaryError
      : `${primaryError}; acknowledgement cleanup also failed: ${cleanupError}`,
    primaryError,
    cleanupError,
    ...(ack === undefined ? {} : { ack }),
    motionQuiesced,
    ...(nonceCleanup === undefined ? {} : { nonceCleanup }),
    actionReceipts,
    evidenceCeiling,
  });

  const unsafeIdentity = locomotionUnsafeIdentityError(adb, spec.input);
  if (unsafeIdentity !== null) return fail("invalid_request", unsafeIdentity, null);
  const relativePath = locomotionRelativePath(spec.input.requestId);
  const routeOwnsCleanup = spec.operation === AGENT_BRIDGE_LOCOMOTE_COMMAND && spec.deferNonceCleanup === true;
  const maxPolls = spec.input.maxPolls ?? 30;
  const pollMs = spec.input.pollMs ?? 100;
  const stabilityReads = spec.input.stabilityReads ?? 2;
  const ackReadTimeoutMs = spec.input.ackReadTimeoutMs ?? 15_000;
  const controlTimeoutMs = spec.input.controlTimeoutMs ?? 15_000;
  const deadlineNs = spec.input.deadlineMonotonicNs === undefined
    || !/^[1-9][0-9]*$/.test(spec.input.deadlineMonotonicNs)
    ? null
    : BigInt(spec.input.deadlineMonotonicNs);
  const remainingMs = (): number => {
    if (deadlineNs === null) return Number.MAX_SAFE_INTEGER;
    const current = clockNs();
    if (clockError !== null) return Number.MIN_SAFE_INTEGER;
    const remaining = (deadlineNs - current) / 1_000_000n;
    if (remaining > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    if (remaining < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
    return Number(remaining);
  };
  const boundedTimeout = (desiredMs: number, minimumMs: number, reserveAfterMs: number): number | null => {
    if (clockError !== null) return null;
    if (deadlineNs === null) return desiredMs;
    const available = remainingMs() - reserveAfterMs;
    if (clockError !== null) return null;
    if (available < minimumMs) return null;
    return Math.min(desiredMs, available);
  };
  const executionDelayMs = spec.executionDelayMs ?? 0;
  const cancellationPolls = Math.max(stabilityReads + 2, Math.min(maxPolls, 10));
  const finalizationCleanupReserveMs = 1_000 + stabilityReads * 250
    + Math.max(0, stabilityReads - 1) * pollMs + 1_000 + 250;
  const cancellationReserveMs = spec.operation === AGENT_BRIDGE_LOCOMOTE_COMMAND
    ? 1_000 + cancellationPolls * 250 + Math.max(0, cancellationPolls - 1) * pollMs
      + finalizationCleanupReserveMs
    : 1_000;
  const minimumEnvelopeMs = spec.operation === AGENT_BRIDGE_LOCOMOTE_COMMAND
    ? agentBridgeLocomotionMinimumEnvelopeMs({ maxPolls, pollMs, stabilityReads, executionDelayMs })
    : 1_000 + executionDelayMs + maxPolls * 250
      + Math.max(0, maxPolls - 1) * pollMs + cancellationReserveMs;
  const payloadProblem = locomotionPayloadInputError(spec.input) ?? spec.preflightError ?? null;
  const deadlineProblem = payloadProblem === null && deadlineNs !== null && remainingMs() < minimumEnvelopeMs
    ? `transaction deadline cannot fit the ${minimumEnvelopeMs}ms minimum broadcast/glide/poll/cleanup envelope`
    : null;
  const payloadInvalid = payloadProblem ?? deadlineProblem;
  if (payloadInvalid !== null) {
    if (routeOwnsCleanup) {
      nonceCleanup = {
        status: "route_owned",
        requestId: spec.input.requestId,
        relativePath,
        attempts: 0,
      };
      return fail("invalid_request", payloadInvalid, clockError, undefined, true);
    }
    const cleanupStartedAt = stamp();
    const requestedCleanupTimeoutMs = Number.isInteger(spec.input.controlTimeoutMs)
      && spec.input.controlTimeoutMs! >= 1_000 && spec.input.controlTimeoutMs! <= 15_000
      ? spec.input.controlTimeoutMs!
      : 1_000;
    const cleanupTimeoutMs = boundedTimeout(requestedCleanupTimeoutMs, 1_000, 0);
    let cleanupThrown: string | null = null;
    const cleanup = cleanupTimeoutMs === null ? null : await deps.runText(
      adb,
      ["-s", spec.input.serial, "shell", "run-as", spec.input.packageName, "rm", "-f", relativePath],
      { timeoutMs: cleanupTimeoutMs, maxOutputBytes: 64 * 1024 },
    ).catch((error) => {
      cleanupThrown = error instanceof Error ? error.message : String(error);
      return null;
    });
    const cleanupApplied = cleanup !== null && cleanup.code === 0 && !cleanup.timedOut;
    const cleanupError = cleanupApplied ? null : cleanup === null
      ? cleanupThrown ?? "transaction deadline left less than the valid 1000ms acknowledgement cleanup minimum"
      : (cleanup.timedOut ? "acknowledgement cleanup timed out" : (cleanup.stderr || cleanup.stdout || "acknowledgement cleanup failed")).slice(-400);
    actionReceipts.push({
      action: "locomotion_ack_cleanup",
      status: cleanupApplied ? "applied" : "failed",
      startedAtMonotonicNs: cleanupStartedAt,
      endedAtMonotonicNs: stamp(),
      ack: {
        serial: spec.input.serial,
        packageName: spec.input.packageName,
        operation: spec.operation,
        requestId: spec.input.requestId,
        relativePath,
        outcome: cleanupApplied ? "completed" : cleanup?.timedOut ? "timeout" : "failed",
      },
      error: cleanupError ?? undefined,
    });
    const retainedCleanup = clockError === null ? cleanupError
      : cleanupError === null ? clockError : `${clockError}; ${cleanupError}`;
    return fail("invalid_request", payloadInvalid, retainedCleanup);
  }

  let executeMayHaveApplied = false;
  const broadcastStartedAt = stamp();
  const afterBroadcastReserveMs = executionDelayMs + maxPolls * 250
    + Math.max(0, maxPolls - 1) * pollMs + cancellationReserveMs;
  const broadcastTimeoutMs = boundedTimeout(controlTimeoutMs, 1_000, afterBroadcastReserveMs);
  let broadcastThrown: string | null = null;
  if (broadcastTimeoutMs !== null && spec.operation === AGENT_BRIDGE_LOCOMOTE_COMMAND) executeMayHaveApplied = true;
  const broadcast = broadcastTimeoutMs === null ? null : await deps.runText(adb, [
      "-s", spec.input.serial, "shell", "am", "broadcast",
      "-a", `${spec.input.packageName}.AGENT_CMD`, "-p", spec.input.packageName,
      "--es", "cmd", spec.operation,
      "--es", "kind", AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
      "--ei", "schemaVersion", String(AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION),
      "--ei", "capabilityRevision", String(AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION),
      "--es", "requestId", spec.input.requestId,
      "--es", "tag", locomotionTag(spec.input),
      ...spec.extraBroadcastArgs,
    ], { timeoutMs: broadcastTimeoutMs, maxOutputBytes: 64 * 1024 }).catch((error) => {
      broadcastThrown = error instanceof Error ? error.message : String(error);
      return null;
    });
  const broadcastApplied = broadcast !== null && broadcast.code === 0 && !broadcast.timedOut;
  const broadcastFailure = broadcast === null
    ? broadcastThrown ?? (clockError ?? "transaction deadline exhausted before a valid broadcast timeout")
    : broadcast.timedOut ? "broadcast timed out" : (broadcast.stderr || broadcast.stdout || "broadcast failed").slice(-400);
  actionReceipts.push({
    action: "locomotion_broadcast",
    status: broadcastApplied ? "applied" : "failed",
    startedAtMonotonicNs: broadcastStartedAt,
    endedAtMonotonicNs: stamp(),
    ack: {
      serial: spec.input.serial,
      packageName: spec.input.packageName,
      operation: spec.operation,
      requestId: spec.input.requestId,
      tag: locomotionTag(spec.input),
      outcome: broadcastApplied ? "completed" : broadcast?.timedOut ? "timeout" : "failed",
    },
    error: broadcastApplied ? undefined : broadcastFailure,
  });

  let readyToPoll = broadcastApplied;
  let executionWaitError: string | null = null;
  if (readyToPoll && executionDelayMs > 0) {
    const afterDelayReserveMs = maxPolls * 250 + Math.max(0, maxPolls - 1) * pollMs + cancellationReserveMs;
    if (clockError !== null || (deadlineNs !== null && remainingMs() < executionDelayMs + afterDelayReserveMs)) {
      executionWaitError = clockError ?? "transaction deadline exhausted before the admitted glide wait while preserving acknowledgement cleanup";
      readyToPoll = false;
    } else {
      try {
        await deps.sleep(executionDelayMs);
      } catch (error) {
        executionWaitError = error instanceof Error ? error.message : String(error);
        readyToPoll = false;
      }
      if (clockError !== null) {
        executionWaitError ??= clockError;
        readyToPoll = false;
      }
    }
  }

  let stablePayload: Buffer | null = null;
  let stableCount = 0;
  let attempts = 0;
  let pullDetail = readyToPoll ? "acknowledgement file has not appeared"
    : executionWaitError ?? (broadcastApplied ? "acknowledgement polling did not start" : "broadcast failed before acknowledgement polling");
  const pullStartedAt = stamp();
  if (readyToPoll) {
    for (let poll = 0; poll < maxPolls; poll++) {
      const remainingPolls = maxPolls - poll - 1;
      const reserveAfterPullMs = remainingPolls * 250 + remainingPolls * pollMs + cancellationReserveMs;
      const pullTimeoutMs = boundedTimeout(ackReadTimeoutMs, 250, reserveAfterPullMs);
      if (pullTimeoutMs === null) {
        pullDetail = "transaction deadline exhausted before another valid acknowledgement read while preserving cleanup";
        break;
      }
      attempts++;
      let pullThrown: string | null = null;
      const pulled = await deps.runBytes(adb, [
        "-s", spec.input.serial, "exec-out", "run-as", spec.input.packageName,
        "sh", "-c", 'if test -f "$1"; then printf "\\001"; cat "$1"; else printf "\\000"; fi', "pico-mcp", relativePath,
      ], { timeoutMs: pullTimeoutMs, maxOutputBytes: 1024 * 1024 }).catch((error) => {
        pullThrown = error instanceof Error ? error.message : String(error);
        return { code: null, stdout: Buffer.alloc(0), stderr: pullThrown!, timedOut: false };
      });
      const filePresent = pulled.stdout[0] === 0x01;
      const fileAbsent = pulled.stdout[0] === 0x00 && pulled.stdout.length === 1;
      if (pulled.code === 0 && !pulled.timedOut && filePresent) {
        const bytes = pulled.stdout.subarray(1);
        if (stablePayload !== null && stablePayload.equals(bytes)) stableCount++;
        else {
          stablePayload = Buffer.from(bytes);
          stableCount = 1;
        }
        pullDetail = stableCount >= stabilityReads
          ? "acknowledgement bytes stabilized"
          : "awaiting another byte-identical acknowledgement read";
        if (stableCount >= stabilityReads) break;
      } else {
        stablePayload = null;
        stableCount = 0;
        pullDetail = pulled.timedOut
          ? "run-as acknowledgement read timed out"
          : pulled.code === 0 && fileAbsent
            ? "acknowledgement file has not appeared"
            : pulled.stdout.length > 0
              ? `run-as acknowledgement existence protocol was invalid: ${pulled.stdout.toString("utf8").slice(-300)}`
              : (pullThrown ?? (pulled.stderr || `run-as acknowledgement read exited ${pulled.code ?? "without a code"}`)).slice(-400);
      }
      if (poll + 1 < maxPolls) {
        const pollsAfterSleep = maxPolls - poll - 1;
        const reserveAfterSleepMs = pollsAfterSleep * 250
          + Math.max(0, pollsAfterSleep - 1) * pollMs + cancellationReserveMs;
        if (deadlineNs !== null && remainingMs() < pollMs + reserveAfterSleepMs) {
          pullDetail = "transaction deadline exhausted before polling sleep while preserving cleanup";
          break;
        }
        try {
          await deps.sleep(pollMs);
        } catch (error) {
          pullDetail = `acknowledgement polling sleep failed: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
    }
  }
  const pulledSuccessfully = stablePayload !== null && stableCount >= stabilityReads;
  actionReceipts.push({
    action: "locomotion_ack_pull",
    status: pulledSuccessfully ? "applied" : "failed",
    startedAtMonotonicNs: pullStartedAt,
    endedAtMonotonicNs: stamp(),
    ack: {
      serial: spec.input.serial,
      packageName: spec.input.packageName,
      operation: spec.operation,
      requestId: spec.input.requestId,
      relativePath,
      attempts,
      stabilityReads: stableCount,
      outcome: pulledSuccessfully ? "completed" : "timeout",
    },
    error: pulledSuccessfully ? undefined : pullDetail,
  });

  let ack: Ack | undefined;
  let terminalAckValidated = false;
  let primaryCode: Exclude<AgentBridgeLocomotionRequestResult<Ack>, { ok: true }>["code"] | null = null;
  let primaryError: string | null = null;
  if (!broadcastApplied) {
    primaryCode = "bridge_unavailable";
    primaryError = broadcast === null
      ? "Agent Bridge transaction deadline exhausted before broadcast"
      : broadcast.timedOut ? "Agent Bridge broadcast timed out" : "Agent Bridge broadcast failed";
  } else if (!pulledSuccessfully) {
    primaryCode = spec.missingAckCode;
    primaryError = `No stable terminal Agent Bridge ${spec.operation} acknowledgement appeared at ${relativePath}: ${pullDetail}`;
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(stablePayload!.toString("utf8"));
    } catch (error: any) {
      primaryCode = "invalid_ack";
      primaryError = `Agent Bridge ${spec.operation} acknowledgement is not valid JSON: ${error?.message ?? String(error)}`;
    }
    if (primaryError === null) {
      const rawRecord = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : null;
      const rawApplication = rawRecord?.application !== null && typeof rawRecord?.application === "object"
        ? rawRecord.application as Record<string, unknown>
        : null;
      const legacyCommands = spec.operation === AGENT_BRIDGE_COMMANDS_COMMAND && rawRecord !== null
        && !("capabilityRevision" in rawRecord)
        && rawRecord.kind === AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND
        && rawRecord.schemaVersion === AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION
        && rawRecord.requestId === spec.input.requestId
        && rawRecord.tag === locomotionTag(spec.input)
        && rawApplication?.packageName === spec.input.packageName
        && rawRecord.operation === AGENT_BRIDGE_COMMANDS_COMMAND
        && rawRecord.physicalWalk === false;
      if (legacyCommands) {
        primaryCode = "capability_unavailable";
        primaryError = "Agent Bridge commands acknowledgement has no locomotion capability revision";
      } else {
        const parsed = spec.schema.safeParse(raw);
        if (!parsed.success) {
          primaryCode = "invalid_ack";
          primaryError = `Agent Bridge ${spec.operation} acknowledgement schema mismatch: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 700)}`;
        } else {
          ack = parsed.data;
          primaryError = locomotionEnvelopeAckError(ack, spec.operation, spec.input)
            ?? terminalLocomotionAckError(ack)
            ?? spec.validateAck(ack);
          if (primaryError !== null) primaryCode = "invalid_ack";
          else {
            terminalAckValidated = true;
          }
          if (primaryError === null && ack.outcome === "capability_unavailable") {
            primaryCode = "capability_unavailable";
            primaryError = ack.primaryError!;
          } else if (primaryError === null && (ack.outcome === "rejected" || ack.outcome === "failed")) {
            primaryCode = "guest_rejected";
            primaryError = ack.primaryError!;
          }
        }
      }
    }
  }

  let cancelError: string | null = null;
  let motionQuiesced = spec.operation !== AGENT_BRIDGE_LOCOMOTE_COMMAND || terminalAckValidated;
  if (spec.operation === AGENT_BRIDGE_LOCOMOTE_COMMAND && executeMayHaveApplied && !terminalAckValidated) {
    const cancelStartedAt = stamp();
    const identity = spec.cancelIdentity;
    let cancelBroadcastThrown: string | null = null;
    const cancelStableFloorMs = cancellationPolls * 250
      + Math.max(0, cancellationPolls - 1) * pollMs + finalizationCleanupReserveMs;
    const cancelBroadcastTimeoutMs = identity === undefined
      ? null
      : boundedTimeout(controlTimeoutMs, 1_000, cancelStableFloorMs);
    const cancelBroadcast = cancelBroadcastTimeoutMs === null ? null : await deps.runText(adb, [
      "-s", spec.input.serial, "shell", "am", "broadcast",
      "-a", `${spec.input.packageName}.AGENT_CMD`, "-p", spec.input.packageName,
      "--es", "cmd", AGENT_BRIDGE_LOCOMOTE_COMMAND,
      "--es", "kind", AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
      "--ei", "schemaVersion", String(AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION),
      "--ei", "capabilityRevision", String(AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION),
      "--es", "requestId", spec.input.requestId,
      "--es", "tag", locomotionTag(spec.input),
      "--es", "requestControl", "cancel",
      "--el", "rootGeneration", String(identity!.rootGeneration),
      "--es", "rootIncarnation", identity!.rootIncarnation,
    ], { timeoutMs: cancelBroadcastTimeoutMs, maxOutputBytes: 64 * 1024 }).catch((error) => {
      cancelBroadcastThrown = error instanceof Error ? error.message : String(error);
      return null;
    });
    const cancelBroadcastApplied = cancelBroadcast !== null && cancelBroadcast.code === 0 && !cancelBroadcast.timedOut;
    let stableCancel: Buffer | null = null;
    let stableCancelCount = 0;
    let lastCancelProblem: string | null = null;
    if (cancelBroadcastApplied) {
      for (let poll = 0; poll < cancellationPolls; poll++) {
        const remainingCancellationPolls = cancellationPolls - poll - 1;
        const reserveAfterCancelReadMs = remainingCancellationPolls * 250
          + remainingCancellationPolls * pollMs + finalizationCleanupReserveMs;
        const cancelReadTimeoutMs = boundedTimeout(ackReadTimeoutMs, 250, reserveAfterCancelReadMs);
        if (cancelReadTimeoutMs === null) {
          lastCancelProblem = clockError ?? "absolute transaction deadline exhausted before cancellation acknowledgement read";
          break;
        }
        const pulled = await deps.runBytes(adb, [
          "-s", spec.input.serial, "exec-out", "run-as", spec.input.packageName,
          "sh", "-c", 'if test -f "$1"; then printf "\\001"; cat "$1"; else printf "\\000"; fi', "pico-mcp", relativePath,
        ], { timeoutMs: cancelReadTimeoutMs, maxOutputBytes: 1024 * 1024 }).catch(() => ({
          code: null, stdout: Buffer.alloc(0), stderr: "cancel acknowledgement read failed", timedOut: false,
        }));
        if (pulled.code === 0 && !pulled.timedOut && pulled.stdout[0] === 0x01 && identity !== undefined) {
          const bytes = pulled.stdout.subarray(1);
          try {
            const parsed = locomotionCancelAckSchema.parse(JSON.parse(bytes.toString("utf8")));
            const valid = (parsed.outcome === "cancelled" || parsed.outcome === "already_terminal")
              && parsed.requestId === spec.input.requestId && parsed.tag === locomotionTag(spec.input)
              && parsed.application.packageName === spec.input.packageName
              && parsed.rootGenerationBefore === identity.rootGeneration
              && parsed.root.generation === identity.rootGeneration
              && parsed.root.incarnation === identity.rootIncarnation
              && parsed.primaryError === null && parsed.cleanupError === null;
            if (!valid) throw new Error(parsed.primaryError ?? "cancel acknowledgement lost exact request/root identity");
            lastCancelProblem = null;
            if (stableCancel !== null && stableCancel.equals(bytes)) stableCancelCount++;
            else { stableCancel = Buffer.from(bytes); stableCancelCount = 1; }
            if (stableCancelCount >= stabilityReads) break;
          } catch (error) {
            lastCancelProblem = error instanceof Error ? error.message : String(error);
            stableCancel = null;
            stableCancelCount = 0;
          }
        } else {
          stableCancel = null;
          stableCancelCount = 0;
        }
        if (poll + 1 < cancellationPolls) {
          const pollsAfterSleep = cancellationPolls - poll - 1;
          const reserveAfterCancelSleepMs = pollsAfterSleep * 250
            + Math.max(0, pollsAfterSleep - 1) * pollMs + finalizationCleanupReserveMs;
          const cancelSleepMs = boundedTimeout(pollMs, 1, reserveAfterCancelSleepMs);
          if (cancelSleepMs === null) {
            lastCancelProblem = clockError ?? "absolute transaction deadline exhausted before cancellation polling sleep";
            break;
          }
          try { await deps.sleep(cancelSleepMs); } catch { break; }
        }
      }
    }
    if (stableCancel !== null && stableCancelCount >= stabilityReads && identity !== undefined) {
      motionQuiesced = true;
    } else {
      cancelError = identity === undefined
        ? "locomotion cancellation omitted its exact root identity"
        : cancelBroadcastTimeoutMs === null
          ? clockError ?? "absolute transaction deadline could not fit the cancellation barrier"
        : cancelBroadcastThrown ?? (cancelBroadcast?.timedOut
          ? "locomotion cancellation broadcast timed out"
          : cancelBroadcastApplied ? `locomotion cancellation acknowledgement did not stabilize${lastCancelProblem ? `: ${lastCancelProblem}` : ""}`
            : (cancelBroadcast?.stderr || cancelBroadcast?.stdout || "locomotion cancellation broadcast failed").slice(-400));
    }
    actionReceipts.push({
      action: "locomotion_cancel",
      status: motionQuiesced ? "applied" : "failed",
      startedAtMonotonicNs: cancelStartedAt,
      endedAtMonotonicNs: stamp(),
      ack: {
        serial: spec.input.serial,
        packageName: spec.input.packageName,
        operation: spec.operation,
        requestId: spec.input.requestId,
        outcome: motionQuiesced ? "cancelled" : "failed",
      },
      error: cancelError ?? undefined,
    });
  }

  nonceCleanup = routeOwnsCleanup ? {
    status: motionQuiesced ? "route_owned" : "deferred_until_stop",
    requestId: spec.input.requestId,
    relativePath,
    attempts: 0,
  } : undefined;
  const cleanupStartedAt = stamp();
  const cleanupTimeoutMs = routeOwnsCleanup ? null
    : boundedTimeout(controlTimeoutMs, 1_000, 0);
  let cleanupThrown: string | null = null;
  const cleanup = routeOwnsCleanup ? null : cleanupTimeoutMs === null ? null : await deps.runText(
    adb,
    ["-s", spec.input.serial, "shell", "run-as", spec.input.packageName, "rm", "-f", relativePath],
    { timeoutMs: cleanupTimeoutMs, maxOutputBytes: 64 * 1024 },
  ).catch((error) => {
    cleanupThrown = error instanceof Error ? error.message : String(error);
    return null;
  });
  const cleanupApplied = routeOwnsCleanup || (cleanup !== null && cleanup.code === 0 && !cleanup.timedOut);
  const cleanupError = cleanupApplied ? null : cleanup === null
    ? cleanupThrown ?? "transaction deadline left less than the valid 1000ms acknowledgement cleanup minimum"
    : (cleanup.timedOut ? "acknowledgement cleanup timed out" : (cleanup.stderr || cleanup.stdout || "acknowledgement cleanup failed")).slice(-400);
  if (!routeOwnsCleanup) actionReceipts.push({
    action: "locomotion_ack_cleanup",
    status: cleanupApplied ? "applied" : "failed",
    startedAtMonotonicNs: cleanupStartedAt,
    endedAtMonotonicNs: stamp(),
    ack: {
      serial: spec.input.serial,
      packageName: spec.input.packageName,
      operation: spec.operation,
      requestId: spec.input.requestId,
      relativePath,
      outcome: cleanupApplied ? "completed" : cleanup?.timedOut ? "timeout" : "failed",
    },
    error: cleanupError ?? undefined,
  });

  const cleanupProblems = [ack?.cleanupError ?? null, cancelError, cleanupError].filter((value): value is string => value !== null);
  if (clockError !== null) {
    if (primaryCode === null) {
      primaryCode = "bridge_unavailable";
      primaryError = clockError;
    } else cleanupProblems.push(clockError);
  }
  const combinedCleanupError = cleanupProblems.length > 0 ? cleanupProblems.join("; ") : null;
  if (primaryCode !== null) return fail(primaryCode, primaryError!, combinedCleanupError, ack, motionQuiesced);
  if (combinedCleanupError !== null) return fail("cleanup_failed", null, combinedCleanupError, ack, motionQuiesced);
  return {
    ok: true,
    ack: ack!,
    primaryError: null,
    cleanupError: null,
    motionQuiesced: true,
    ...(nonceCleanup === undefined ? {} : { nonceCleanup }),
    actionReceipts,
    evidenceCeiling,
  };
}

export async function probeAgentBridgeLocomotionCapability(
  adb: string,
  input: AgentBridgeLocomotionTransactionInput,
  deps: AgentBridgeLocomotionDeps = {},
): Promise<AgentBridgeLocomotionRequestResult<AgentBridgeLocomotionCapabilityAck>> {
  return executeLocomotionTransaction(adb, {
    operation: AGENT_BRIDGE_COMMANDS_COMMAND,
    input,
    extraBroadcastArgs: [],
    schema: locomotionCapabilityAckSchema,
    missingAckCode: "capability_unavailable",
    validateAck: (ack) => {
      if (ack.outcome !== "available") return null;
      if (!ack.availability.debuggable || ack.availability.observedStageStyle !== "Full"
        || ack.availability.rootContainer !== "stage" || !ack.availability.rootRegistered
        || !ack.availability.hmdAvailable || !ack.availability.locomotionAvailable || ack.root === null) {
        return "available acknowledgement contains an unavailable locomotion dependency";
      }
      return null;
    },
  }, deps);
}

export async function requestAgentBridgeHmdPose(
  adb: string,
  input: AgentBridgeHmdPoseRequestInput,
  deps: AgentBridgeLocomotionDeps = {},
): Promise<AgentBridgeLocomotionRequestResult<AgentBridgeHmdPoseAck>> {
  const invalidGeneration = input.expectedRootGeneration !== undefined
    && (!Number.isSafeInteger(input.expectedRootGeneration) || input.expectedRootGeneration < 1);
  const invalidIncarnation = !LOCOMOTION_INCARNATION_PATTERN.test(input.expectedRootIncarnation);
  return executeLocomotionTransaction(adb, {
    operation: AGENT_BRIDGE_HMD_POSE_COMMAND,
    input,
    extraBroadcastArgs: [
      ...(input.expectedRootGeneration === undefined
        ? []
        : ["--el", "rootGeneration", String(input.expectedRootGeneration)]),
      "--es", "rootIncarnation", input.expectedRootIncarnation,
    ],
    schema: locomotionHmdAckSchema,
    missingAckCode: "bridge_unavailable",
    preflightError: invalidGeneration
      ? "expectedRootGeneration must be a positive safe integer"
      : invalidIncarnation
        ? "expectedRootIncarnation must be one exact UUID producer identity"
        : null,
    validateAck: (ack) => {
      if (ack.outcome !== "sampled") return ack.hmdPose === null
        ? null
        : "failed acknowledgement contains an HMD pose";
      if (ack.root === null || ack.hmdPose === null) return "sampled acknowledgement omitted root or HMD pose";
      if (input.expectedRootGeneration !== undefined && ack.root.generation !== input.expectedRootGeneration) {
        return "acknowledgement root generation does not match the request";
      }
      if (ack.root.incarnation !== input.expectedRootIncarnation) {
        return "acknowledgement root incarnation does not match the request";
      }
      return null;
    },
  }, deps);
}

export async function requestAgentBridgeLocomotion(
  adb: string,
  input: AgentBridgeLocomotionRequestInput,
  deps: AgentBridgeLocomotionDeps = {},
): Promise<AgentBridgeLocomotionRequestResult<AgentBridgeLocomotionAck>> {
  const canonicalTarget = canonicalLocomotionTarget(input.target);
  const executionLeaseMs = Number.isInteger(input.glideDurationMs)
    ? Math.min(30_000, input.glideDurationMs + 2_000)
    : 2_000;
  const invalid = (input.mode !== "direct" && input.mode !== "replacement" ? "mode must be direct or replacement" : null)
    ?? (canonicalTarget === null ? "target must contain finite values in the Android Float32 transport domain" : null)
    ?? (!Number.isSafeInteger(input.rootGeneration) || input.rootGeneration < 1
      ? "rootGeneration must be a positive safe integer" : null)
    ?? (!LOCOMOTION_INCARNATION_PATTERN.test(input.rootIncarnation)
      ? "rootIncarnation must be one exact UUID producer identity" : null)
    ?? (!Number.isInteger(input.glideDurationMs) || input.glideDurationMs < 0 || input.glideDurationMs > 10_000
      ? "glideDurationMs must be an integer from 0 through 10000" : null)
    ?? (input.mode === "replacement" && input.glideDurationMs !== 0
      ? "replacement mode requires glideDurationMs 0" : null)
    ?? ((input as { physicalWalk?: unknown }).physicalWalk !== undefined
      && (input as { physicalWalk?: unknown }).physicalWalk !== false ? "physicalWalk must be false" : null);
  const transactionInput: AgentBridgeLocomotionRequestInput = canonicalTarget === null
    ? input
    : { ...input, target: canonicalTarget };
  const result = await executeLocomotionTransaction(adb, {
    operation: AGENT_BRIDGE_LOCOMOTE_COMMAND,
    input: transactionInput,
    preflightError: invalid,
    executionDelayMs: invalid === null ? input.glideDurationMs : 0,
    executionLeaseMs,
    cancelIdentity: {
      rootGeneration: input.rootGeneration,
      rootIncarnation: input.rootIncarnation,
    },
    // A locomote nonce may only be removed after a serialized guest finalization
    // fence (or an owned process stop).  The public wrapper either transfers that
    // ownership to the route or completes the same fence below.
    deferNonceCleanup: invalid === null || input.deferNonceCleanup === true,
    extraBroadcastArgs: canonicalTarget === null ? [] : [
      "--es", "requestControl", "execute",
      "--ei", "executionLeaseMs", String(executionLeaseMs),
      "--es", "mode", input.mode,
      "--ef", "x", String(canonicalTarget.x),
      "--ef", "y", String(canonicalTarget.y),
      "--ef", "z", String(canonicalTarget.z),
      "--ez", "absolute", "true",
      "--ei", "glideDurationMs", String(input.glideDurationMs),
      "--el", "rootGeneration", String(input.rootGeneration),
      "--es", "rootIncarnation", input.rootIncarnation,
      "--ez", "physicalWalk", "false",
    ],
    schema: locomotionActionAckSchema,
    missingAckCode: "bridge_unavailable",
    validateAck: (ack) => {
      if (canonicalTarget === null) return "request target was unavailable after preflight";
      if (ack.requestControl !== "execute" || ack.executionLeaseMs !== executionLeaseMs) {
        return "acknowledgement execution control/lease does not match the request";
      }
      if (ack.mode !== input.mode) return "acknowledgement mode does not match the request";
      if (!sameFloat32TransportPosition(ack.target, canonicalTarget)) {
        return "acknowledgement absolute target does not match the request";
      }
      if (ack.glideDurationMs !== input.glideDurationMs) return "acknowledgement glide duration does not match the request";
      if (ack.rootGenerationBefore !== input.rootGeneration) return "acknowledgement prior root generation does not match the request";
      if (ack.outcome !== "completed") return ack.pose === null
        ? null
        : "failed acknowledgement contains a world-root pose";
      if (ack.pose === null) return "completed acknowledgement omitted its world-root pose";
      if (ack.root === null || ack.root.id !== AGENT_BRIDGE_LOCOMOTION_ROOT_ID
        || ack.root.generation !== input.rootGeneration
        || ack.root.incarnation !== input.rootIncarnation) {
        return "acknowledgement root incarnation/readback does not match the request";
      }
      if (!sameFloat32TransportPosition(ack.pose.position, canonicalTarget)) {
        return "acknowledgement readback position does not match the absolute target";
      }
      const expectedGeneration = input.mode === "direct" ? input.rootGeneration : input.rootGeneration + 1;
      if (ack.pose.rootGeneration !== expectedGeneration) return "acknowledgement result root generation does not match the mechanism";
      return null;
    },
  }, deps);
  if (input.deferNonceCleanup === true || invalid !== null
    || result.nonceCleanup?.status !== "route_owned" || !result.motionQuiesced
    || !result.actionReceipts.some((receipt) => receipt.action === "locomotion_broadcast")) {
    return result;
  }

  const failCleanup = (problem: string): AgentBridgeLocomotionRequestResult<AgentBridgeLocomotionAck> => {
    const cleanupError = result.cleanupError === null ? problem : `${result.cleanupError}; ${problem}`;
    if (result.ok) {
      return {
        ok: false,
        code: "cleanup_failed",
        detail: cleanupError,
        primaryError: null,
        cleanupError,
        ack: result.ack,
        motionQuiesced: true,
        nonceCleanup: result.nonceCleanup,
        actionReceipts: result.actionReceipts,
        evidenceCeiling: result.evidenceCeiling,
      };
    }
    return {
      ...result,
      detail: result.primaryError === null
        ? cleanupError
        : `${result.primaryError}; acknowledgement cleanup also failed: ${cleanupError}`,
      cleanupError,
    };
  };

  let cleanupDeadlineMonotonicNs = input.deadlineMonotonicNs;
  if (cleanupDeadlineMonotonicNs === undefined) {
    try {
      const now = (deps.monotonicNs ?? (() => process.hrtime.bigint()))();
      if (typeof now !== "bigint" || now < 0n) throw new Error("locomotion cleanup monotonic clock is invalid");
      const stabilityReads = input.stabilityReads ?? 2;
      const pollMs = input.pollMs ?? 100;
      const cleanupEnvelopeMs = 1_000 + stabilityReads * 250
        + Math.max(0, stabilityReads - 1) * pollMs + 1_000 + 250 + 2;
      cleanupDeadlineMonotonicNs = (now + BigInt(cleanupEnvelopeMs) * 1_000_000n).toString();
    } catch (error) {
      return failCleanup(`locomotion acknowledgement cleanup clock: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const nonceCleanup = await cleanupAgentBridgeLocomotionNonce(adb, {
      serial: input.serial,
      packageName: input.packageName,
      requestId: input.requestId,
      tag: locomotionTag(input),
      rootGeneration: input.rootGeneration,
      rootIncarnation: input.rootIncarnation,
      controlTimeoutMs: input.controlTimeoutMs,
      ackReadTimeoutMs: input.ackReadTimeoutMs,
      pollMs: input.pollMs,
      stabilityReads: input.stabilityReads,
      deadlineMonotonicNs: cleanupDeadlineMonotonicNs,
    }, deps);
    if (nonceCleanup.removalError !== undefined) {
      return {
        ...failCleanup(`locomotion acknowledgement cleanup: ${nonceCleanup.removalError}`),
        nonceCleanup,
      };
    }
    return { ...result, nonceCleanup };
  } catch (error) {
    return failCleanup(`locomotion acknowledgement cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function cleanupAgentBridgeLocomotionNonce(
  adb: string,
  input: AgentBridgeLocomotionNonceCleanupInput,
  injected: AgentBridgeLocomotionDeps = {},
): Promise<AgentBridgeLocomotionNonceCleanupReceipt> {
  const unsafe = locomotionUnsafeIdentityError(adb, input);
  if (unsafe !== null) throw new Error(`locomotion nonce cleanup rejected: ${unsafe}`);
  if (!LOCOMOTION_TAG_PATTERN.test(input.tag) || !Number.isSafeInteger(input.rootGeneration) || input.rootGeneration < 1
    || !LOCOMOTION_INCARNATION_PATTERN.test(input.rootIncarnation)) {
    throw new Error("locomotion nonce cleanup rejected: finalization identity is invalid");
  }
  const controlTimeoutMs = input.controlTimeoutMs ?? 5_000;
  const ackReadTimeoutMs = input.ackReadTimeoutMs ?? Math.min(controlTimeoutMs, 5_000);
  const pollMs = input.pollMs ?? 100;
  const stabilityReads = input.stabilityReads ?? 2;
  if (!Number.isInteger(controlTimeoutMs) || controlTimeoutMs < 1_000 || controlTimeoutMs > 15_000) {
    throw new Error("locomotion nonce cleanup controlTimeoutMs must be an integer from 1000 through 15000");
  }
  if (!Number.isInteger(ackReadTimeoutMs) || ackReadTimeoutMs < 250 || ackReadTimeoutMs > 15_000
    || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 2_000
    || !Number.isInteger(stabilityReads) || stabilityReads < 2 || stabilityReads > 5
    || !/^[1-9][0-9]*$/.test(input.deadlineMonotonicNs)
    || (input.probeOnly === true && input.processStopped !== true)) {
    throw new Error("locomotion nonce cleanup polling/deadline inputs are invalid");
  }
  const runText = injected.runText ?? run;
  const runBytes = injected.runBytes ?? runBinary;
  const wait = injected.sleep ?? sleep;
  const monotonicNs = injected.monotonicNs ?? (() => process.hrtime.bigint());
  const deadline = BigInt(input.deadlineMonotonicNs);
  const now = (): bigint => {
    try {
      const value = monotonicNs();
      if (typeof value !== "bigint" || value < 0n) throw new Error("invalid monotonic value");
      return value;
    } catch (error) {
      if (input.cleanupOnly === true) return 0n;
      throw new Error(`locomotion nonce cleanup monotonic clock failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const fit = (desiredMs: number, minimumMs: number, reserveAfterMs: number, label: string): number => {
    if (input.cleanupOnly === true) return desiredMs;
    const current = now();
    if (current >= deadline) throw new Error(`${label} cannot start at or after the absolute locomotion deadline`);
    const remaining = Number((deadline - current) / 1_000_000n);
    const available = remaining - reserveAfterMs;
    if (available < minimumMs) throw new Error(`${label} cannot fit its minimum while preserving later nonce cleanup proof`);
    return Math.min(desiredMs, available);
  };
  const relativePath = locomotionRelativePath(input.requestId);
  let finalizationProven = input.processStopped === true;
  let removalStarted = input.probeOnly === true;
  try {
    let finalizationSha256: string | undefined;
    if (input.processStopped !== true) {
    const cleanupFloorMs = 1_000 + 250;
    const stableFloorMs = stabilityReads * 250 + Math.max(0, stabilityReads - 1) * pollMs;
    const finalizeTimeoutMs = fit(controlTimeoutMs, 1_000, stableFloorMs + cleanupFloorMs, "locomotion finalization broadcast");
    const finalized = await runText(adb, [
      "-s", input.serial, "shell", "am", "broadcast",
      "-a", `${input.packageName}.AGENT_CMD`, "-p", input.packageName,
      "--es", "cmd", AGENT_BRIDGE_LOCOMOTE_COMMAND,
      "--es", "kind", AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
      "--ei", "schemaVersion", String(AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION),
      "--ei", "capabilityRevision", String(AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION),
      "--es", "requestId", input.requestId,
      "--es", "tag", input.tag,
      "--es", "requestControl", "finalize",
      "--el", "rootGeneration", String(input.rootGeneration),
      "--es", "rootIncarnation", input.rootIncarnation,
    ], { timeoutMs: finalizeTimeoutMs, maxOutputBytes: 64 * 1024 });
    if (finalized.code !== 0 || finalized.timedOut) {
      throw new Error(finalized.timedOut ? "locomotion finalization broadcast timed out" : "locomotion finalization broadcast failed");
    }
    let stable: Buffer | null = null;
    let stableCount = 0;
    const maxPolls = stabilityReads + 3;
    for (let attempt = 0; attempt < maxPolls && stableCount < stabilityReads; attempt++) {
      const neededReads = stabilityReads - stableCount;
      const reserveAfterRead = Math.max(0, neededReads - 1) * 250
        + Math.max(0, neededReads - 1) * pollMs + cleanupFloorMs;
      let readTimeoutMs: number;
      try {
        readTimeoutMs = fit(ackReadTimeoutMs, 250, reserveAfterRead, "locomotion finalization acknowledgement read");
      } catch {
        break;
      }
      const pulled = await runBytes(adb, [
        "-s", input.serial, "exec-out", "run-as", input.packageName,
        "sh", "-c", 'if test -f "$1"; then printf "\\001"; cat "$1"; else printf "\\000"; fi', "pico-mcp", relativePath,
      ], { timeoutMs: readTimeoutMs, maxOutputBytes: 1024 * 1024 }).catch(() => null);
      let validBytes: Buffer | null = null;
      if (pulled !== null && pulled.code === 0 && !pulled.timedOut && pulled.stdout[0] === 0x01) {
        const bytes = pulled.stdout.subarray(1);
        try {
          const parsed = locomotionFinalizeAckSchema.parse(JSON.parse(bytes.toString("utf8")));
          if (parsed.requestId === input.requestId && parsed.tag === input.tag
            && parsed.application.packageName === input.packageName
            && parsed.rootGenerationBefore === input.rootGeneration
            && parsed.root.generation === input.rootGeneration
            && parsed.root.incarnation === input.rootIncarnation
            && parsed.primaryError === null && parsed.cleanupError === null) validBytes = bytes;
        } catch { /* stale or malformed bytes never contribute to stability */ }
      }
      if (validBytes !== null) {
        if (stable !== null && stable.equals(validBytes)) stableCount++;
        else { stable = Buffer.from(validBytes); stableCount = 1; }
      } else {
        stable = null;
        stableCount = 0;
      }
      if (stableCount >= stabilityReads) break;
      if (attempt + 1 < maxPolls) {
        const neededAfterSleep = stabilityReads - stableCount;
        const reserveAfterSleep = neededAfterSleep * 250
          + Math.max(0, neededAfterSleep - 1) * pollMs + cleanupFloorMs;
        let sleepDuration: number;
        try { sleepDuration = fit(pollMs, 1, reserveAfterSleep, "locomotion finalization polling sleep"); }
        catch { break; }
        await wait(sleepDuration);
      }
    }
    if (stable === null || stableCount < stabilityReads) {
      throw new Error("locomotion finalization acknowledgement did not stabilize before nonce cleanup");
    }
      finalizationSha256 = createHash("sha256").update(stable).digest("hex");
      finalizationProven = true;
    }
    let removalError: string | null = null;
    if (input.probeOnly !== true) {
      const removeTimeoutMs = fit(controlTimeoutMs, 1_000, 250, "locomotion nonce removal");
      let removalThrown: string | null = null;
      removalStarted = true;
      const removed = await runText(adb, [
        "-s", input.serial, "shell", "run-as", input.packageName, "rm", "-f", relativePath,
      ], { timeoutMs: removeTimeoutMs, maxOutputBytes: 64 * 1024 }).catch((error) => {
        removalThrown = error instanceof Error ? error.message : String(error);
        return null;
      });
      removalError = removed !== null && removed.code === 0 && !removed.timedOut ? null
        : removalThrown ?? (removed?.timedOut
          ? "locomotion nonce cleanup timed out"
          : `locomotion nonce cleanup failed: ${(removed?.stderr || removed?.stdout || `exit ${removed?.code ?? "unknown"}`).slice(-400)}`);
    }
    const absenceTimeoutMs = fit(ackReadTimeoutMs, 250, 0, "locomotion nonce absence proof");
    const absent = await runBytes(adb, [
      "-s", input.serial, "exec-out", "run-as", input.packageName,
      "sh", "-c", 'if test -e "$1"; then printf "\\001"; else printf "\\000"; fi', "pico-mcp", relativePath,
    ], { timeoutMs: absenceTimeoutMs, maxOutputBytes: 64 * 1024 });
    if (absent.code !== 0 || absent.timedOut || absent.stdout.length !== 1 || absent.stdout[0] !== 0x00) {
      throw new Error(`${removalError ? `${removalError}; ` : ""}locomotion nonce pathname absence was not proven after the sole exact cleanup attempt`);
    }
    return {
      status: "removed_and_absent",
      requestId: input.requestId,
      relativePath,
      attempts: 1,
      ...(finalizationSha256 === undefined ? {} : { finalizationSha256 }),
      ...(removalError === null ? {} : { removalError }),
    };
  } catch (error) {
    if (error instanceof AgentBridgeLocomotionNonceCleanupError) throw error;
    throw new AgentBridgeLocomotionNonceCleanupError(
      error instanceof Error ? error.message : String(error),
      { finalizationProven, removalStarted },
    );
  }
}

export interface AgentBridgeSceneSnapshotFetchInput {
  serial: string;
  packageName: string;
  requestId: string;
  maxRetries: number;
  pollMs: number;
  stabilityReads: number;
}

export interface AgentBridgeSceneSnapshotActionReceipt {
  action: "bridge_broadcast" | "bridge_payload_pull" | "bridge_payload_cleanup";
  status: "applied" | "failed";
  startedAtMonotonicNs: string;
  endedAtMonotonicNs: string;
  ack: Record<string, unknown>;
  error?: string;
}

export type AgentBridgeSceneSnapshotFetchResult =
  | { ok: true; bytes: Buffer; actionReceipts: AgentBridgeSceneSnapshotActionReceipt[] }
  | { ok: false; code: "bridge_unavailable"; detail: string; actionReceipts: AgentBridgeSceneSnapshotActionReceipt[] };

interface SceneSnapshotFetchDeps {
  runText?: typeof run;
  runBytes?: typeof runBinary;
  sleep?: typeof sleep;
  monotonicNs?: () => bigint;
  wallClockMs?: () => number;
}

/**
 * Fetch one nonce-addressed Agent Bridge scene payload without ever routing geometry through
 * logcat. `adb` is an already-resolved executable path. Every subprocess is pinned to the exact
 * caller-supplied serial, and the app-private cache path is read through `run-as` so a different
 * package or device cannot satisfy the request accidentally.
 */
export async function fetchAgentBridgeSceneSnapshot(
  adb: string,
  input: AgentBridgeSceneSnapshotFetchInput,
  deps: SceneSnapshotFetchDeps = {},
): Promise<AgentBridgeSceneSnapshotFetchResult> {
  const actionReceipts: AgentBridgeSceneSnapshotActionReceipt[] = [];
  const now = deps.monotonicNs ?? (() => process.hrtime.bigint());
  const execText = deps.runText ?? run;
  const execBytes = deps.runBytes ?? runBinary;
  const wait = deps.sleep ?? sleep;
  const wallClockMs = deps.wallClockMs ?? Date.now;
  const stamp = () => now().toString();
  const invalid = (detail: string): AgentBridgeSceneSnapshotFetchResult => ({
    ok: false,
    code: "bridge_unavailable",
    detail,
    actionReceipts,
  });

  if (!adb) return invalid("adb executable path is empty");
  if (!/^[\x21-\x7e]+$/.test(input.serial)) return invalid("an exact printable adb serial is required");
  if (!ANDROID_PACKAGE_PATTERN.test(input.packageName)) return invalid("packageName is not a valid Android package name");
  if (!SCENE_SNAPSHOT_REQUEST_ID_PATTERN.test(input.requestId)) return invalid("requestId is not safe for the bridge cache path");
  if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 120) return invalid("maxRetries must be an integer from 0 through 120");
  if (!Number.isInteger(input.pollMs) || input.pollMs < 10 || input.pollMs > 60_000) return invalid("pollMs must be an integer from 10 through 60000");
  if (!Number.isInteger(input.stabilityReads) || input.stabilityReads < 2 || input.stabilityReads > 8) return invalid("stabilityReads must be an integer from 2 through 8");

  const broadcastStart = stamp();
  const broadcast = await execText(
    adb,
    [
      "-s", input.serial,
      "shell", "am", "broadcast",
      "-a", `${input.packageName}.AGENT_CMD`,
      "--es", "cmd", AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND,
      "--es", "requestId", input.requestId,
      "--ei", "maxRetries", String(input.maxRetries),
      "--ei", "pollMs", String(input.pollMs),
      "--ei", "stabilityReads", String(input.stabilityReads),
    ],
    { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
  );
  actionReceipts.push({
    action: "bridge_broadcast",
    status: broadcast.code === 0 && !broadcast.timedOut ? "applied" : "failed",
    startedAtMonotonicNs: broadcastStart,
    endedAtMonotonicNs: stamp(),
    ack: {
      serial: input.serial,
      action: `${input.packageName}.AGENT_CMD`,
      command: AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND,
      requestId: input.requestId,
      outcome: broadcast.code === 0 && !broadcast.timedOut ? "completed" : broadcast.timedOut ? "timeout" : "failed",
    },
    error: broadcast.code === 0 && !broadcast.timedOut
      ? undefined
      : (broadcast.timedOut ? "broadcast timed out" : (broadcast.stderr || broadcast.stdout || "broadcast failed")).slice(-400),
  });
  if (broadcast.code !== 0 || broadcast.timedOut) {
    return invalid(`Agent Bridge broadcast failed on ${input.serial}: ${(broadcast.stderr || broadcast.stdout || "no diagnostic output").slice(-400)}`);
  }

  const relativePath = `cache/${AGENT_BRIDGE_SCENE_SNAPSHOT_CACHE_DIRECTORY}/${input.requestId}.json`;
  const readStart = stamp();
  const deadline = wallClockMs() + 30_000 + (input.maxRetries + 1) * input.pollMs;
  const readPollMs = Math.min(500, Math.max(50, Math.floor(input.pollMs / 4)));
  let attempts = 0;
  let lastDetail = "payload file has not appeared";
  while (wallClockMs() <= deadline) {
    attempts += 1;
    const pulled = await execBytes(
      adb,
      [
        "-s", input.serial, "exec-out", "run-as", input.packageName,
        "sh", "-c", 'if test -f "$1"; then printf "\\001"; cat "$1"; else printf "\\000"; fi', "pico-mcp", relativePath,
      ],
      { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 * 1024 },
    );
    // Android's adb exec-out can report exit 0 while forwarding a remote `cat: ... No such file`
    // diagnostic on stdout. The remote shell prefixes its result with an out-of-band existence
    // byte: 0 means absent, 1 means present. Strip that byte and hand EVERY present file byte to
    // the versioned host parser. Transport must not decide whether the payload is valid JSON.
    const existenceByte = pulled.stdout[0];
    const filePresent = existenceByte === 0x01;
    const fileAbsent = existenceByte === 0x00 && pulled.stdout.length === 1;
    if (pulled.code === 0 && !pulled.timedOut && filePresent) {
      const payload = pulled.stdout.subarray(1);
      actionReceipts.push({
        action: "bridge_payload_pull",
        status: "applied",
        startedAtMonotonicNs: readStart,
        endedAtMonotonicNs: stamp(),
        ack: { serial: input.serial, packageName: input.packageName, requestId: input.requestId, relativePath, attempts, bytes: payload.length, outcome: "completed" },
      });
      const cleanupStart = stamp();
      const cleanup = await execText(
        adb,
        ["-s", input.serial, "shell", "run-as", input.packageName, "rm", "-f", relativePath],
        { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
      );
      actionReceipts.push({
        action: "bridge_payload_cleanup",
        status: cleanup.code === 0 && !cleanup.timedOut ? "applied" : "failed",
        startedAtMonotonicNs: cleanupStart,
        endedAtMonotonicNs: stamp(),
        ack: {
          serial: input.serial,
          packageName: input.packageName,
          requestId: input.requestId,
          relativePath,
          outcome: cleanup.code === 0 && !cleanup.timedOut ? "completed" : cleanup.timedOut ? "timeout" : "failed",
        },
        error: cleanup.code === 0 && !cleanup.timedOut
          ? undefined
          : (cleanup.timedOut ? "payload cleanup timed out" : (cleanup.stderr || cleanup.stdout || "payload cleanup failed")).slice(-400),
      });
      return { ok: true, bytes: payload, actionReceipts };
    }
    lastDetail = pulled.timedOut
      ? "run-as payload read timed out"
      : pulled.code === 0 && fileAbsent
        ? "payload file has not appeared"
        : pulled.stdout.length > 0
          ? `run-as payload existence protocol was invalid: ${pulled.stdout.toString("utf8").slice(-300)}`
        : (pulled.stderr || `run-as payload read exited ${pulled.code ?? "without a code"}`).slice(-400);
    if (wallClockMs() + readPollMs > deadline) break;
    await wait(readPollMs);
  }
  actionReceipts.push({
    action: "bridge_payload_pull",
    status: "failed",
    startedAtMonotonicNs: readStart,
    endedAtMonotonicNs: stamp(),
    ack: { serial: input.serial, packageName: input.packageName, requestId: input.requestId, relativePath, attempts, outcome: "timeout" },
    error: lastDetail,
  });
  return invalid(`No terminal Agent Bridge payload appeared at ${relativePath} on ${input.serial}: ${lastDetail}`);
}

/**
 * generate_agent_bridge — emit an INJECTABLE Kotlin library ("Agent Bridge") that turns any native
 * PICO spatial app into a cooperative headless control + verification surface for an AI agent.
 *
 * The thesis: `adb am broadcast` (drive) + `adb logcat` (read) give deterministic STRUCTURAL
 * verification — the app TELLS the agent its exact scene state on command (assert_scene / dump_scene).
 * This COMPLEMENTS visual verification. capture_frame is a measured headless path, but its returned
 * pixels must be LOOKed at and a black/absent immersive view can require an alternate host-window
 * capture. The mouse bridge delivers input, not proof of a visual response. Use the bridge for
 * structural state and a looked-at frame for appearance.
 *
 * Boots with ZERO app code via a manifest-merged ContentProvider (the LeakCanary/Firebase trick):
 * the provider's onCreate runs at process start and registers the AGENT_CMD BroadcastReceiver.
 * The only optional one-line glue is AgentBridge.attachScene(sceneRoot) so dump_scene can introspect.
 *
 * APIs used are sources-confirmed (foundation/core 0.13.3): Entity.getChildren()/getChildrenCount()/
 * getName(), Entity.components (a Collection<Component> with operator get(Class)), TransformComponent
 * .position/.quaternion/.scaleVector. The broadcast+logcat pattern is emulator-proven (ClaimSight).
 */

function agentBridgeKt(pkg: string, tag: string): string {
  return `package ${pkg}

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import android.system.Os
import android.util.JsonWriter
import android.util.Log
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.ModelComponent
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.ecs.resource.MeshResource
import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial
import com.pico.spatial.core.math.Color4
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.math.BigDecimal
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout

/**
 * AgentBridge — an injectable headless control + verification surface for an AI agent.
 * Generated by pico-spatial-mcp generate_agent_bridge.
 *
 * Drive it headlessly:   adb shell am broadcast -a <applicationId>.AGENT_CMD --es cmd dump_scene
 * Read it headlessly:    adb logcat -s ${tag}:V
 *
 * Built-in commands: ping | commands | scene_stats | dump_scene (extra --ei depth N)
 *   + query_scene_anchors (versioned, lossless, nonce-addressed app-cache JSON; never logcat)
 *   + LIVE EDITS (v25): spawn | move | remove — each echoes your --es tag in its ack event.
 * Extend with your own: AgentBridge.register("arm") { _ -> placer.toggleArmed() }.
 * ONE-LINE GLUE (optional, for scene introspection): AgentBridge.attachScene(sceneRoot).
 * query_scene_anchors requires explicit identity: AgentBridge.attachScene(stageRoot, "stage").
 */
object AgentBridge {
    const val TAG = "${tag}"
    const val ACTION_SUFFIX = ".AGENT_CMD"
    const val SCENE_PAYLOAD_KIND = "${AGENT_BRIDGE_SCENE_PAYLOAD_KIND}"
    const val SCENE_SCHEMA_VERSION = ${AGENT_BRIDGE_SCENE_SCHEMA_VERSION}
    const val SCENE_BRIDGE_REVISION = ${AGENT_BRIDGE_SCENE_REVISION}
    const val SCENE_SNAPSHOT_COMMAND = "${AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND}"
    const val SCENE_SNAPSHOT_CACHE_DIRECTORY = "${AGENT_BRIDGE_SCENE_SNAPSHOT_CACHE_DIRECTORY}"
    const val NAVIGATION_GUIDE_PAYLOAD_KIND = "${AGENT_BRIDGE_NAVIGATION_GUIDE_PAYLOAD_KIND}"
    const val NAVIGATION_GUIDE_SCHEMA_VERSION = ${AGENT_BRIDGE_NAVIGATION_GUIDE_SCHEMA_VERSION}
    const val NAVIGATION_GUIDE_BRIDGE_REVISION = ${AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION}
    const val NAVIGATION_GUIDE_COMMAND = "${AGENT_BRIDGE_NAVIGATION_GUIDE_COMMAND}"
    const val NAVIGATION_GUIDE_CACHE_DIRECTORY = "${AGENT_BRIDGE_NAVIGATION_GUIDE_CACHE_DIRECTORY}"
    const val NAVIGATION_GUIDE_PATTERN = "${AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN}"
    const val NAVIGATION_GUIDE_PROJECTION_MODEL = "${AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL}"
    val NAVIGATION_GUIDE_COLOR_0 = intArrayOf(255, 0, 255)
    val NAVIGATION_GUIDE_COLOR_1 = intArrayOf(0, 255, 255)
    const val NAVIGATION_GUIDE_WIDTH_M = ${AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M}f
    const val NAVIGATION_GUIDE_HEIGHT_M = ${AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M}f
    const val LOCOMOTION_PAYLOAD_KIND = "${AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND}"
    const val LOCOMOTION_SCHEMA_VERSION = ${AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION}
    const val LOCOMOTION_CAPABILITY_REVISION = ${AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION}
    const val LOCOMOTION_CACHE_DIRECTORY = "${AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY}"
    const val AGENT_WORLD_ROOT_ID = "${AGENT_BRIDGE_LOCOMOTION_ROOT_ID}"
    const val COMMANDS_COMMAND = "${AGENT_BRIDGE_COMMANDS_COMMAND}"
    const val HMD_POSE_COMMAND = "${AGENT_BRIDGE_HMD_POSE_COMMAND}"
    const val LOCOMOTE_COMMAND = "${AGENT_BRIDGE_LOCOMOTE_COMMAND}"

    data class SceneSnapshotRequest(
        val requestId: String,
        val maxRetries: Int,
        val pollMs: Long,
        val stabilityReads: Int,
    )

    data class NavigationGuideRequest(
        val generation: Long,
        val kind: String,
        val schemaVersion: Int,
        val bridgeRevision: Int,
        val requestId: String,
        val mode: String,
        val sceneSnapshotId: String,
        val targetTraceId: String,
        val targetRuntimeUuid: String,
        val pattern: String,
        val projectionModel: String,
        val color0: IntArray,
        val color1: IntArray,
        val widthM: Float,
        val heightM: Float,
    )

    data class NavigationGuideResult(
        val outcome: String,
        val guideState: String,
        val cleanupState: String,
        val errorCode: String? = null,
        val errorDetail: String? = null,
    )

    data class AgentWorldPose(val rootGeneration: Long, val position: Vector3)
    data class AgentHmdPose(val readAtMonotonicNs: Long, val position: Vector3, val rotation: Quat)
    data class AgentLocomotionResult(
        val outcome: String,
        val pose: AgentWorldPose?,
        val primaryError: String? = null,
        val cleanupError: String? = null,
    )

    data class LocomotionRequest(
        val generation: Long,
        val kind: String,
        val schemaVersion: Int,
        val capabilityRevision: Int,
        val requestId: String,
        val tag: String,
        val mode: String,
        val target: Vector3,
        val absolute: Boolean,
        val glideDurationMs: Int,
        val executionLeaseMs: Int,
        val physicalWalk: Boolean,
        val rootGenerationBefore: Long,
        val rootIncarnation: String,
    )

    private data class LocomotionFileRequest(
        val generation: Long,
        val kind: String,
        val schemaVersion: Int,
        val capabilityRevision: Int,
        val requestId: String,
        val tag: String,
        val requestControl: String,
        val mode: String,
        val target: Vector3?,
        val absolute: Boolean,
        val glideDurationMs: Int,
        val executionLeaseMs: Int,
        val physicalWalk: Boolean,
        val rootGenerationBefore: Long,
        val rootIncarnation: String,
    )

    private data class LocomotionProducerBinding(
        val generation: Long,
        val rootGeneration: Long,
        val rootIncarnation: String,
        val rootProvider: () -> Entity?,
        val hmdProducer: () -> AgentHmdPose?,
        val producer: suspend (LocomotionRequest) -> AgentLocomotionResult,
    )

    private enum class LocomotionLeaseState {
        ACTIVE, CANCELLING, CANCEL_TERMINAL, EXECUTE_TERMINAL, EXPIRED, FINALIZING, FINALIZED
    }

    private data class LocomotionExecutionLease(
        val generation: Long,
        val rootGeneration: Long,
        val rootIncarnation: String,
        val tag: String,
        val expiresAtMonotonicNs: Long,
        var state: LocomotionLeaseState,
        var job: Job?,
        var cachedCancelOutcome: String?,
        var cancelWriter: Job?,
        var finalizeWriter: Job?,
    )

    private data class LocomotionCancellationPlan(
        val request: LocomotionFileRequest,
        val lease: LocomotionExecutionLease,
        val outcome: String,
        val barrierJob: Job?,
        val cancelProducer: Boolean,
    )

    private data class LocomotionFinalizationPlan(
        val request: LocomotionFileRequest,
        val lease: LocomotionExecutionLease,
        val producerJob: Job?,
        val cancelWriter: Job?,
    )

    private data class NavigationGuideProducerBinding(
        val generationIsCurrent: Boolean,
        val producer: (suspend (NavigationGuideRequest) -> NavigationGuideResult)?,
        val cleanup: (suspend () -> Boolean)?,
    )

    private val bridgeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val requestIdPattern = Regex("^[A-Za-z0-9_-]{8,96}$")
    private val locomotionIncarnationPattern = Regex("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
    private val sceneSnapshotIdPattern = Regex("^[a-f0-9]{64}$")
    private val targetTraceIdPattern = Regex("^anchor-[0-9]{4}$")
    private val navigationGuideMutex = Mutex()
    private val navigationGuideGenerationLock = Any()
    private var navigationGuideGeneration = 0L
    private val locomotionMutex = Mutex()
    private val locomotionGenerationLock = Any()
    private val locomotionLeaseLock = Any()
    private val locomotionLeases = LinkedHashMap<String, LocomotionExecutionLease>()
    private const val MAX_RETAINED_LOCOMOTION_LEASES = 256
    private const val LOCOMOTION_CANCEL_BARRIER_TIMEOUT_MS = 8_000L
    private var locomotionGeneration = 0L
    private var locomotionBinding: LocomotionProducerBinding? = null

    @Volatile private var applicationContext: Context? = null
    @Volatile private var sceneRoot: Entity? = null
    @Volatile private var sceneProvider: (() -> Entity?)? = null
    @Volatile private var rootContainer: String? = null
    @Volatile private var sceneSnapshotProducer: (suspend (SceneSnapshotRequest, JsonWriter) -> Unit)? = null
    @Volatile private var navigationGuideProducer: (suspend (NavigationGuideRequest) -> NavigationGuideResult)? = null
    @Volatile private var navigationGuideCleanup: (suspend () -> Boolean)? = null
    @Volatile private var navigationGuideBuiltinRegistered = false
    @Volatile private var cachedApkSha256: String? = null
    private val handlers = LinkedHashMap<String, (Bundle) -> Unit>()

    init { registerBuiltins() }

    /** Called by AgentBridgeInitProvider before the receiver becomes reachable. */
    fun initialize(context: Context) {
        applicationContext = context.applicationContext
        if (navigationGuideCommandsEnabled()) registerNavigationGuideBuiltin()
        registerLocomotionBuiltins()
    }

    /** The navigation guide is an authenticated debug feature and is unreachable in release APKs. */
    fun navigationGuideCommandsEnabled(): Boolean {
        val context = applicationContext ?: return false
        return context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
    }

    /** Attach the live scene root so dump_scene/scene_stats can introspect it. */
    fun attachScene(root: Entity) { attachSceneInternal(root, null) }

    /** Explicit container identity is required by query_scene_anchors runtime binding. */
    fun attachScene(root: Entity, container: String) { attachSceneInternal(root, container) }

    private fun attachSceneInternal(root: Entity, container: String?) {
        sceneRoot = root
        sceneProvider = null
        rootContainer = container
        event("scene_attached", "name" to root.getName(), "container" to (container ?: "unreported"))
    }

    /** Pair direct attachScene(...) with this from Stage disposal/closure. */
    fun detachScene(root: Entity? = null) {
        if (root != null && sceneRoot !== root) {
            event("scene_detach_ignored", "msg" to "root_mismatch")
            return
        }
        sceneRoot = null
        // Retain the reported container identity: a closed known Stage is stage_not_open, while a
        // never-identified root remains binding_failed.
        event("scene_detached", "container" to (rootContainer ?: "unreported"))
    }

    /** Attach a provider instead, if the root is rebuilt over time. */
    fun attachSceneProvider(provider: () -> Entity?) { attachSceneProviderInternal(null, provider) }

    /** Explicit container identity is required by query_scene_anchors runtime binding. */
    fun attachSceneProvider(container: String, provider: () -> Entity?) { attachSceneProviderInternal(container, provider) }

    private fun attachSceneProviderInternal(container: String?, provider: () -> Entity?) {
        sceneRoot = null
        sceneProvider = provider
        rootContainer = container
        event("scene_provider_attached", "container" to (container ?: "unreported"))
    }

    /** Pair attachSceneProvider(...) with this when the provider lifecycle ends. */
    fun detachSceneProvider() {
        sceneProvider = null
        event("scene_provider_detached", "container" to (rootContainer ?: "unreported"))
    }

    /**
     * Register the sole producer for query_scene_anchors. The producer writes only the readiness,
     * reads, and optional error members into an already-open versioned envelope. Geometry remains
     * in the app-private file and is never emitted through event()/logcat.
     */
    fun registerSceneSnapshotProducer(producer: suspend (SceneSnapshotRequest, JsonWriter) -> Unit) {
        sceneSnapshotProducer = producer
        event("scene_snapshot_producer_registered", "revision" to SCENE_BRIDGE_REVISION)
    }

    /** Register the guide producer separately from the revision-41 scene-snapshot producer. */
    fun registerNavigationGuideProducer(
        producer: suspend (NavigationGuideRequest) -> NavigationGuideResult,
        cleanup: suspend () -> Boolean,
    ) {
        val enabled = navigationGuideCommandsEnabled()
        synchronized(navigationGuideGenerationLock) {
            nextNavigationGuideGeneration()
            if (enabled) {
                navigationGuideProducer = producer
                navigationGuideCleanup = cleanup
            } else {
                navigationGuideProducer = null
                navigationGuideCleanup = null
            }
        }
        if (!enabled) return
        event("navigation_guide_producer_registered", "revision" to NAVIGATION_GUIDE_BRIDGE_REVISION)
    }

    fun unregisterNavigationGuideProducer() {
        synchronized(navigationGuideGenerationLock) {
            nextNavigationGuideGeneration()
            navigationGuideProducer = null
            navigationGuideCleanup = null
        }
        event("navigation_guide_producer_unregistered", "revision" to NAVIGATION_GUIDE_BRIDGE_REVISION)
    }

    fun registerLocomotionProducer(
        rootProvider: () -> Entity?,
        hmdProducer: () -> AgentHmdPose?,
        producer: suspend (LocomotionRequest) -> AgentLocomotionResult,
    ): Long {
        cancelAllLocomotionLeases("locomotion producer replaced")
        return synchronized(locomotionGenerationLock) {
            val generation = nextLocomotionGeneration()
            locomotionBinding = LocomotionProducerBinding(generation, generation, UUID.randomUUID().toString(), rootProvider, hmdProducer, producer)
            event("locomotion_producer_registered", "revision" to LOCOMOTION_CAPABILITY_REVISION, "generation" to generation)
            generation
        }
    }

    fun unregisterLocomotionProducer(generation: Long) {
        val removed = synchronized(locomotionGenerationLock) {
            if (locomotionBinding?.generation != generation) return
            nextLocomotionGeneration()
            locomotionBinding = null
            true
        }
        if (removed) cancelAllLocomotionLeases("locomotion producer unregistered")
        event("locomotion_producer_unregistered", "revision" to LOCOMOTION_CAPABILITY_REVISION, "generation" to generation)
    }

    private fun cancelAllLocomotionLeases(reason: String) {
        val jobs = synchronized(locomotionLeaseLock) {
            val active = locomotionLeases.values.mapNotNull { lease ->
                if (lease.state == LocomotionLeaseState.ACTIVE || lease.state == LocomotionLeaseState.EXPIRED) {
                    lease.state = LocomotionLeaseState.CANCELLING
                    lease.job
                } else null
            }
            active
        }
        jobs.forEach { job -> job.cancel(CancellationException(reason)) }
    }

    private fun nextLocomotionGeneration(): Long {
        check(locomotionGeneration < Long.MAX_VALUE) { "locomotion generation exhausted" }
        locomotionGeneration += 1L
        return locomotionGeneration
    }

    fun locomotionRequestIsCurrent(generation: Long): Boolean = synchronized(locomotionGenerationLock) {
        locomotionBinding?.generation == generation
    }

    fun locomotionRequestIsActive(request: LocomotionRequest): Boolean = synchronized(locomotionLeaseLock) {
        val lease = locomotionLeases[request.requestId] ?: return@synchronized false
        if (lease.generation != request.generation || lease.rootGeneration != request.rootGenerationBefore ||
            lease.rootIncarnation != request.rootIncarnation || lease.tag != request.tag ||
            lease.state != LocomotionLeaseState.ACTIVE
        ) return@synchronized false
        if (SystemClock.elapsedRealtimeNanos() >= lease.expiresAtMonotonicNs) {
            lease.state = LocomotionLeaseState.EXPIRED
            return@synchronized false
        }
        true
    }

    private fun pruneTerminalLocomotionLeasesLocked(): Boolean {
        while (locomotionLeases.size >= MAX_RETAINED_LOCOMOTION_LEASES) {
            val oldestTerminal = locomotionLeases.entries.firstOrNull { (_, lease) ->
                lease.state == LocomotionLeaseState.CANCEL_TERMINAL ||
                    lease.state == LocomotionLeaseState.EXECUTE_TERMINAL
            } ?: return false
            locomotionLeases.remove(oldestTerminal.key)
        }
        return true
    }

    private fun registerLocomotionLease(request: LocomotionFileRequest, job: Job, target: File): String? {
        if (request.requestControl != "execute" || request.executionLeaseMs !in 2_000..12_000 ||
            request.executionLeaseMs != request.glideDurationMs + 2_000
        ) return "invalid_or_replayed_execution_lease"
        val now = SystemClock.elapsedRealtimeNanos()
        val expiresAt = now + request.executionLeaseMs.toLong() * 1_000_000L
        return synchronized(locomotionLeaseLock) {
            if (locomotionLeases.containsKey(request.requestId) || !pruneTerminalLocomotionLeasesLocked()) {
                return@synchronized "invalid_or_replayed_execution_lease"
            }
            if (target.exists() && !target.delete()) return@synchronized "stale_ack_not_removed"
            locomotionLeases[request.requestId] = LocomotionExecutionLease(
                request.generation, request.rootGenerationBefore, request.rootIncarnation, request.tag,
                expiresAt, LocomotionLeaseState.ACTIVE, job, null, null, null,
            )
            null
        }
    }

    private fun remainingLocomotionLeaseMs(request: LocomotionFileRequest): Long? = synchronized(locomotionLeaseLock) {
        val lease = locomotionLeases[request.requestId] ?: return@synchronized null
        if (lease.generation != request.generation || lease.rootGeneration != request.rootGenerationBefore ||
            lease.rootIncarnation != request.rootIncarnation || lease.tag != request.tag ||
            lease.state != LocomotionLeaseState.ACTIVE
        ) return@synchronized null
        val remainingNs = lease.expiresAtMonotonicNs - SystemClock.elapsedRealtimeNanos()
        if (remainingNs <= 0L) {
            lease.state = LocomotionLeaseState.EXPIRED
            return@synchronized null
        }
        (remainingNs + 999_999L) / 1_000_000L
    }

    private fun completeLocomotionLease(request: LocomotionFileRequest): Boolean = synchronized(locomotionLeaseLock) {
        val lease = locomotionLeases[request.requestId] ?: return@synchronized false
        if (lease.generation != request.generation || lease.rootGeneration != request.rootGenerationBefore ||
            lease.rootIncarnation != request.rootIncarnation || lease.tag != request.tag ||
            lease.state != LocomotionLeaseState.ACTIVE
        ) return@synchronized false
        if (SystemClock.elapsedRealtimeNanos() >= lease.expiresAtMonotonicNs) {
            lease.state = LocomotionLeaseState.EXPIRED
            return@synchronized false
        }
        lease.state = LocomotionLeaseState.EXECUTE_TERMINAL
        true
    }

    private fun expireLocomotionLease(request: LocomotionFileRequest) = synchronized(locomotionLeaseLock) {
        val lease = locomotionLeases[request.requestId] ?: return@synchronized
        if (lease.generation == request.generation && lease.rootGeneration == request.rootGenerationBefore &&
            lease.rootIncarnation == request.rootIncarnation && lease.tag == request.tag &&
            lease.state == LocomotionLeaseState.ACTIVE
        ) lease.state = LocomotionLeaseState.EXPIRED
    }

    private fun currentLocomotionGeneration(): Long = synchronized(locomotionGenerationLock) { locomotionGeneration }

    private fun currentLocomotionBinding(): LocomotionProducerBinding? = synchronized(locomotionGenerationLock) {
        locomotionBinding
    }

    private fun registeredLocomotionRoot(): Entity? {
        val provider = synchronized(locomotionGenerationLock) { locomotionBinding?.rootProvider } ?: return null
        return runCatching { provider() }.getOrNull()
    }

    private fun publishLocomotionRootGeneration(generation: Long, rootGeneration: Long): Boolean =
        synchronized(locomotionGenerationLock) {
            val binding = locomotionBinding
            if (binding?.generation != generation) return@synchronized false
            locomotionBinding = binding.copy(rootGeneration = rootGeneration)
            true
        }

    private fun nextNavigationGuideGeneration(): Long = synchronized(navigationGuideGenerationLock) {
        check(navigationGuideGeneration < Long.MAX_VALUE) { "navigation-guide generation exhausted" }
        navigationGuideGeneration += 1L
        navigationGuideGeneration
    }

    fun navigationGuideRequestIsCurrent(generation: Long): Boolean = synchronized(navigationGuideGenerationLock) {
        generation == navigationGuideGeneration
    }

    private fun navigationGuideProducerBinding(generation: Long): NavigationGuideProducerBinding =
        synchronized(navigationGuideGenerationLock) {
            NavigationGuideProducerBinding(
                generationIsCurrent = generation == navigationGuideGeneration,
                producer = navigationGuideProducer,
                cleanup = navigationGuideCleanup,
            )
        }

    private fun root(): Entity? = sceneRoot ?: sceneProvider?.invoke()

    /** Register or override a command. The handler receives the broadcast extras. */
    fun register(cmd: String, handler: (Bundle) -> Unit) { handlers[cmd] = handler }

    /** Route a command (called by AgentBridgeInitProvider's receiver). */
    fun dispatch(cmd: String?, extras: Bundle) {
        if (cmd == null) { event("error", "msg" to "null cmd"); return }
        val h = handlers[cmd]
        if (h == null) { event("unknown_cmd", "cmd" to cmd, "known" to handlers.keys.joinToString(",")); return }
        runCatching { h(extras) }.onFailure { event("cmd_failed", "cmd" to cmd, "msg" to (it.message ?: it.toString())) }
    }

    /** Emit a structured, greppable telemetry marker: AGENTBRIDGE| event=<name> k=v ... */
    fun event(name: String, vararg pairs: Pair<String, Any?>) {
        val sb = StringBuilder("AGENTBRIDGE| event=").append(name)
        for ((k, v) in pairs) sb.append(' ').append(k).append('=').append(fmt(v))
        Log.i(TAG, sb.toString())
    }

    private fun fmt(v: Any?): String = if (v == null) "null" else v.toString().replace('\\n', ' ').replace(' ', '_')

    @Synchronized
    private fun registerNavigationGuideBuiltin() {
        if (navigationGuideBuiltinRegistered || !navigationGuideCommandsEnabled()) return
        navigationGuideBuiltinRegistered = true
        register(NAVIGATION_GUIDE_COMMAND) { extras ->
            val requestId = extras.getString("requestId")
            if (requestId == null || !requestIdPattern.matches(requestId)) {
                event("navigation_guide_rejected", "msg" to "invalid_request_id")
                return@register
            }
            val context = applicationContext
            if (context == null) {
                event("navigation_guide_failed", "requestId" to requestId, "msg" to "bridge_not_initialized")
                return@register
            }
            val generation = nextNavigationGuideGeneration()
            val target = navigationGuideTarget(context, requestId)
            if (target.exists() && !target.delete()) {
                event("navigation_guide_failed", "requestId" to requestId, "msg" to "stale_ack_not_removed")
                return@register
            }
            val request = NavigationGuideRequest(
                generation = generation,
                kind = extras.getString("kind") ?: "",
                schemaVersion = extras.getInt("schemaVersion", -1),
                bridgeRevision = extras.getInt("bridgeRevision", -1),
                requestId = requestId,
                mode = extras.getString("mode") ?: "",
                sceneSnapshotId = extras.getString("sceneSnapshotId") ?: "",
                targetTraceId = extras.getString("targetTraceId") ?: "",
                targetRuntimeUuid = extras.getString("targetRuntimeUuid") ?: "",
                pattern = extras.getString("pattern") ?: "",
                projectionModel = extras.getString("projectionModel") ?: "",
                color0 = parseNavigationGuideRgb(extras.getString("color0")),
                color1 = parseNavigationGuideRgb(extras.getString("color1")),
                widthM = extras.getFloat("widthM", -1f),
                heightM = extras.getFloat("heightM", -1f),
            )
            bridgeScope.launch { writeNavigationGuideAck(request) }
            event(
                "navigation_guide_requested",
                "requestId" to requestId,
                "revision" to NAVIGATION_GUIDE_BRIDGE_REVISION,
                "mode" to request.mode,
            )
        }
    }

    @Synchronized
    private fun registerLocomotionBuiltins() {
        register(COMMANDS_COMMAND) { extras -> dispatchLocomotionFileRequest(COMMANDS_COMMAND, extras) }
        register(HMD_POSE_COMMAND) { extras -> dispatchLocomotionFileRequest(HMD_POSE_COMMAND, extras) }
        register(LOCOMOTE_COMMAND) { extras -> dispatchLocomotionFileRequest(LOCOMOTE_COMMAND, extras) }
    }

    private fun parseLocomotionFileRequest(operation: String, extras: Bundle): LocomotionFileRequest? {
        val requestId = extras.getString("requestId")
        val tag = extras.getString("tag")
        if (requestId == null || !requestIdPattern.matches(requestId) ||
            tag == null || tag.length !in 1..120 || tag.any { it.code !in 0x21..0x7e }
        ) return null
        return LocomotionFileRequest(
            generation = currentLocomotionGeneration(),
            kind = extras.getString("kind") ?: "",
            schemaVersion = extras.getInt("schemaVersion", -1),
            capabilityRevision = extras.getInt("capabilityRevision", -1),
            requestId = requestId,
            tag = tag,
            requestControl = if (operation == LOCOMOTE_COMMAND) extras.getString("requestControl") ?: "" else "",
            mode = extras.getString("mode") ?: "",
            target = parseRequiredFiniteVector3(extras),
            absolute = extras.getBoolean("absolute", false),
            glideDurationMs = extras.getInt("glideDurationMs", -1),
            executionLeaseMs = extras.getInt("executionLeaseMs", -1),
            physicalWalk = extras.getBoolean("physicalWalk", true),
            rootGenerationBefore = extras.getLong("rootGeneration", -1L),
            rootIncarnation = extras.getString("rootIncarnation") ?: "",
        )
    }

    private fun admitLocomotionObservationRequest(request: LocomotionFileRequest, target: File): String? =
        synchronized(locomotionLeaseLock) {
            val leaseState = locomotionLeases[request.requestId]?.state
            if (leaseState == LocomotionLeaseState.FINALIZING ||
                leaseState == LocomotionLeaseState.FINALIZED
            ) return@synchronized "locomotion_nonce_finalization_started"
            if (target.exists() && !target.delete()) return@synchronized "stale_ack_not_removed"
            null
        }

    private fun dispatchLocomotionFileRequest(operation: String, extras: Bundle) {
        val request = parseLocomotionFileRequest(operation, extras)
        if (request == null) {
            event("locomotion_rejected", "operation" to operation, "msg" to "invalid_request_identity")
            return
        }
        val context = applicationContext
        if (context == null) {
            event("locomotion_failed", "operation" to operation, "requestId" to request.requestId, "msg" to "bridge_not_initialized")
            return
        }
        if (operation == LOCOMOTE_COMMAND &&
            (request.requestControl == "cancel" || request.requestControl == "finalize")
        ) {
            event("locomotion_rejected", "operation" to operation, "requestId" to request.requestId, "msg" to "control_requires_async_receiver")
            return
        }
        val targetFile = locomotionTarget(context, request.requestId)
        if (operation == LOCOMOTE_COMMAND) {
            val job = bridgeScope.launch(start = CoroutineStart.LAZY) { writeLocomotionAck(context, request, targetFile) }
            val admissionError = registerLocomotionLease(request, job, targetFile)
            if (admissionError != null) {
                job.cancel(CancellationException(admissionError))
                event("locomotion_rejected", "operation" to operation, "requestId" to request.requestId, "msg" to admissionError)
                return
            }
            job.start()
        } else {
            val admissionError = admitLocomotionObservationRequest(request, targetFile)
            if (admissionError != null) {
                event("locomotion_failed", "operation" to operation, "requestId" to request.requestId, "msg" to admissionError)
                return
            }
            bridgeScope.launch {
                when (operation) {
                    COMMANDS_COMMAND -> writeCommandsAck(context, request, targetFile)
                    HMD_POSE_COMMAND -> writeHmdPoseAck(context, request, targetFile)
                }
            }
        }
        event("locomotion_requested", "operation" to operation, "requestId" to request.requestId, "tag" to request.tag)
    }

    private fun cancelLocomotionRequest(request: LocomotionFileRequest): LocomotionCancellationPlan? =
        synchronized(locomotionLeaseLock) {
            if (validateLocomotionEnvelope(request) != null || request.requestControl != "cancel" ||
                !locomotionIncarnationPattern.matches(request.rootIncarnation)
            ) return@synchronized null
            val existing = locomotionLeases[request.requestId]
            if (existing != null) {
                if (existing.generation <= 0L || existing.rootGeneration != request.rootGenerationBefore ||
                    existing.rootIncarnation != request.rootIncarnation || existing.tag != request.tag
                ) return@synchronized null
                val exactRequest = request.copy(generation = existing.generation)
                return@synchronized when (existing.state) {
                    LocomotionLeaseState.EXECUTE_TERMINAL -> {
                        existing.state = LocomotionLeaseState.CANCELLING
                        existing.cachedCancelOutcome = "already_terminal"
                        LocomotionCancellationPlan(exactRequest, existing, "already_terminal", existing.job, false)
                    }
                    LocomotionLeaseState.CANCEL_TERMINAL -> LocomotionCancellationPlan(
                        exactRequest, existing, existing.cachedCancelOutcome ?: "cancelled", existing.job, false,
                    )
                    LocomotionLeaseState.ACTIVE -> {
                        existing.state = LocomotionLeaseState.CANCELLING
                        LocomotionCancellationPlan(exactRequest, existing, "cancelled", existing.job, true)
                    }
                    LocomotionLeaseState.CANCELLING, LocomotionLeaseState.EXPIRED -> {
                        existing.state = LocomotionLeaseState.CANCELLING
                        LocomotionCancellationPlan(
                            exactRequest, existing, existing.cachedCancelOutcome ?: "cancelled", existing.job, true,
                        )
                    }
                    LocomotionLeaseState.FINALIZING, LocomotionLeaseState.FINALIZED -> null
                }
            }
            val binding = currentLocomotionBinding()
            if (binding == null || request.generation != binding.generation ||
                request.rootGenerationBefore != binding.rootGeneration || request.rootIncarnation != binding.rootIncarnation ||
                !pruneTerminalLocomotionLeasesLocked()
            ) return@synchronized null
            val tombstone = LocomotionExecutionLease(
                request.generation, request.rootGenerationBefore, request.rootIncarnation, request.tag,
                Long.MAX_VALUE, LocomotionLeaseState.CANCELLING, null, "cancelled", null, null,
            )
            locomotionLeases[request.requestId] = tombstone
            LocomotionCancellationPlan(request, tombstone, "cancelled", null, false)
        }

    private fun terminalCancelOutcome(plan: LocomotionCancellationPlan): String? = synchronized(locomotionLeaseLock) {
        val existing = locomotionLeases[plan.request.requestId]
        if (existing !== plan.lease || existing.generation != plan.request.generation ||
            existing.rootGeneration != plan.request.rootGenerationBefore ||
            existing.rootIncarnation != plan.request.rootIncarnation || existing.tag != plan.request.tag
        ) return@synchronized null
        when (existing.state) {
            LocomotionLeaseState.EXECUTE_TERMINAL -> "already_terminal"
            LocomotionLeaseState.CANCEL_TERMINAL -> existing.cachedCancelOutcome ?: plan.outcome
            LocomotionLeaseState.CANCELLING, LocomotionLeaseState.EXPIRED -> {
                existing.state = LocomotionLeaseState.CANCEL_TERMINAL
                existing.cachedCancelOutcome = plan.outcome
                plan.outcome
            }
            LocomotionLeaseState.ACTIVE -> null
            LocomotionLeaseState.FINALIZING, LocomotionLeaseState.FINALIZED -> null
        }
    }

    fun dispatchLocomotionCancellation(extras: Bundle, finished: () -> Unit): Boolean {
        val context = applicationContext ?: return false
        val request = parseLocomotionFileRequest(LOCOMOTE_COMMAND, extras) ?: return false
        val plan = cancelLocomotionRequest(request) ?: return false
        if (plan.cancelProducer) {
            plan.barrierJob?.cancel(CancellationException("host cancelled locomotion request"))
        }
        val candidate = bridgeScope.launch(start = CoroutineStart.LAZY) {
            try {
                withTimeout(LOCOMOTION_CANCEL_BARRIER_TIMEOUT_MS) {
                    val job = plan.barrierJob
                    if (job != null) job.join()
                    val outcome = terminalCancelOutcome(plan) ?: return@withTimeout
                    writeLocomotionCancelAck(context, plan.request, locomotionTarget(context, plan.request.requestId), outcome)
                }
            } catch (_: TimeoutCancellationException) {
                event("locomotion_cancel_timeout", "requestId" to plan.request.requestId)
            } catch (cause: Throwable) {
                event("locomotion_cancel_failed", "requestId" to plan.request.requestId, "msg" to (cause.message ?: cause.javaClass.simpleName))
            } finally { /* completed writer remains the immutable repeat-cancel barrier */ }
        }
        val writer = synchronized(locomotionLeaseLock) {
            plan.lease.cancelWriter ?: candidate.also { plan.lease.cancelWriter = it }
        }
        if (writer !== candidate) candidate.cancel(CancellationException("shared cancel writer already owns this nonce"))
        writer.invokeOnCompletion { runCatching { finished() } }
        writer.start()
        runCatching { event("locomotion_cancel_requested", "requestId" to request.requestId, "tag" to request.tag) }
        return true
    }

    private suspend fun writeLocomotionCancelAck(
        context: Context,
        request: LocomotionFileRequest,
        target: File,
        outcome: String,
    ) {
        writeLocomotionAckAtomically(context, request, target, LOCOMOTE_COMMAND) { writer ->
            writer.name("requestControl").value("cancel")
            writer.name("outcome").value(outcome)
            writer.name("rootGenerationBefore").value(request.rootGenerationBefore)
            writer.name("root"); writeLocomotionRoot(writer, request.rootGenerationBefore, request.rootIncarnation)
            writeLocomotionErrors(writer, null, null)
        }
    }

    private fun finalizeLocomotionRequest(request: LocomotionFileRequest): LocomotionFinalizationPlan? =
        synchronized(locomotionLeaseLock) {
            if (validateLocomotionEnvelope(request) != null || request.requestControl != "finalize" ||
                !locomotionIncarnationPattern.matches(request.rootIncarnation)
            ) return@synchronized null
            val existing = locomotionLeases[request.requestId] ?: return@synchronized null
            if (existing.generation <= 0L || existing.rootGeneration != request.rootGenerationBefore ||
                existing.rootIncarnation != request.rootIncarnation || existing.tag != request.tag
            ) return@synchronized null
            val exactRequest = request.copy(generation = existing.generation)
            when (existing.state) {
                LocomotionLeaseState.EXECUTE_TERMINAL, LocomotionLeaseState.CANCEL_TERMINAL -> {
                    existing.state = LocomotionLeaseState.FINALIZING
                    LocomotionFinalizationPlan(exactRequest, existing, existing.job, existing.cancelWriter)
                }
                LocomotionLeaseState.FINALIZING -> LocomotionFinalizationPlan(
                    exactRequest, existing, existing.job, existing.cancelWriter,
                )
                LocomotionLeaseState.FINALIZED -> null
                else -> null
            }
        }

    fun dispatchLocomotionFinalization(extras: Bundle, finished: () -> Unit): Boolean {
        val context = applicationContext ?: return false
        val request = parseLocomotionFileRequest(LOCOMOTE_COMMAND, extras) ?: return false
        val plan = finalizeLocomotionRequest(request) ?: return false
        val candidate = bridgeScope.launch(start = CoroutineStart.LAZY) {
            try {
                withTimeout(LOCOMOTION_CANCEL_BARRIER_TIMEOUT_MS) {
                    plan.producerJob?.join()
                    plan.cancelWriter?.join()
                    writeLocomotionFinalizeAck(
                        context, plan.request, locomotionTarget(context, plan.request.requestId),
                    )
                }
            } catch (_: TimeoutCancellationException) {
                event("locomotion_finalize_timeout", "requestId" to plan.request.requestId)
            } catch (cause: Throwable) {
                event("locomotion_finalize_failed", "requestId" to plan.request.requestId, "msg" to (cause.message ?: cause.javaClass.simpleName))
            }
        }
        val writer = synchronized(locomotionLeaseLock) {
            plan.lease.finalizeWriter ?: candidate.also { plan.lease.finalizeWriter = it }
        }
        if (writer !== candidate) candidate.cancel(CancellationException("shared finalization writer already owns this nonce"))
        writer.invokeOnCompletion { runCatching { finished() } }
        writer.start()
        runCatching { event("locomotion_finalize_requested", "requestId" to request.requestId, "tag" to request.tag) }
        return true
    }

    private suspend fun writeLocomotionFinalizeAck(
        context: Context,
        request: LocomotionFileRequest,
        target: File,
    ) {
        writeLocomotionAckAtomically(context, request, target, LOCOMOTE_COMMAND) { writer ->
            writer.name("requestControl").value("finalize")
            writer.name("outcome").value("finalized")
            writer.name("rootGenerationBefore").value(request.rootGenerationBefore)
            writer.name("root"); writeLocomotionRoot(writer, request.rootGenerationBefore, request.rootIncarnation)
            writeLocomotionErrors(writer, null, null)
        }
    }

    private fun registerBuiltins() {
        register("ping") { event("pong") }
        register("scene_stats") {
            val r = root()
            if (r == null) { event("scene_stats", "attached" to false); return@register }
            var n = 0
            walk(r, 0, Int.MAX_VALUE) { _, _ -> n++ }
            event("scene_stats", "attached" to true, "rootName" to r.getName(), "entities" to n)
        }
        register("dump_scene") { extras ->
            val r = root()
            if (r == null) { event("dump_scene", "attached" to false); return@register }
            val maxDepth = extras.getInt("depth", 6)
            event("dump_begin", "root" to r.getName(), "maxDepth" to maxDepth)
            var n = 0
            walk(r, 0, maxDepth) { e, depth ->
                n++
                val comps = runCatching { e.components.joinToString(",") { it.javaClass.simpleName } }.getOrDefault("?")
                val t = runCatching { e.components[TransformComponent::class.java] }.getOrNull()
                if (t != null) {
                    val p = t.position; val s = t.scaleVector
                    event("entity", "d" to depth, "name" to e.getName(), "children" to e.getChildrenCount(),
                        "pos" to "\${p.x},\${p.y},\${p.z}", "scale" to "\${s.x},\${s.y},\${s.z}", "comps" to comps)
                } else {
                    event("entity", "d" to depth, "name" to e.getName(), "children" to e.getChildrenCount(), "comps" to comps)
                }
            }
            event("dump_end", "entities" to n)
        }
        register(SCENE_SNAPSHOT_COMMAND) { extras ->
            val requestId = extras.getString("requestId")
            if (requestId == null || !requestIdPattern.matches(requestId)) {
                event("scene_snapshot_rejected", "msg" to "invalid_request_id")
                return@register
            }
            val request = SceneSnapshotRequest(
                requestId = requestId,
                maxRetries = extras.getInt("maxRetries", 15),
                pollMs = extras.getInt("pollMs", 1000).toLong(),
                stabilityReads = extras.getInt("stabilityReads", 2),
            )
            val validationError = when {
                request.maxRetries !in 0..120 -> "maxRetries must be in 0..120"
                request.pollMs !in 10L..60_000L -> "pollMs must be in 10..60000"
                request.stabilityReads !in 2..8 -> "stabilityReads must be in 2..8"
                else -> null
            }
            val ctx = applicationContext
            if (ctx == null) {
                event("scene_snapshot_failed", "requestId" to requestId, "msg" to "bridge_not_initialized")
                return@register
            }
            val target = sceneSnapshotTarget(ctx, requestId)
            if (target.exists() && !target.delete()) {
                event("scene_snapshot_failed", "requestId" to requestId, "msg" to "stale_payload_not_removed")
                return@register
            }
            bridgeScope.launch {
                if (validationError == null) writeSceneSnapshot(request)
                else writeTerminalSnapshot(request, "invalid_payload", validationError)
            }
            event(
                "scene_snapshot_requested",
                "requestId" to requestId,
                "revision" to SCENE_BRIDGE_REVISION,
                "maxRetries" to request.maxRetries,
                "stabilityReads" to request.stabilityReads,
            )
        }
        // v25 LIVE EDITS: an agent talks to the RUNNING scene. Each ack echoes the caller's tag so
        // the host can await its own command. Spawned entities are visual-only (no RigidBody) —
        // live physics mutation stays out per the physics adapter rules.
        register("spawn") { ex ->
            val tg = ex.getString("tag") ?: ""
            val r = root()
            if (r == null) { event("spawn_failed", "tag" to tg, "msg" to "no_scene_root"); return@register }
            val id = ex.getString("id")
            if (id == null) { event("spawn_failed", "tag" to tg, "msg" to "missing_id"); return@register }
            if (find(r, id) != null) { event("spawn_failed", "tag" to tg, "id" to id, "msg" to "name_exists"); return@register }
            val pos = vec3(ex.getString("pos"), Vector3(0f, 1f, -2f))
            val dims = vec3(ex.getString("dims"), Vector3(0.3f, 0.3f, 0.3f))
            val c = vec3(ex.getString("color"), Vector3(0.2f, 0.9f, 0.9f))
            val mesh = if (ex.getString("shape") == "sphere") MeshResource.createSphere(dims.x) else MeshResource.createBox(dims)
            val e = Entity()
            e.setName(id)
            e.components.set(TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f)))
            val mat = PhysicallyBasedMaterial.create().apply { setBaseColor(Color4(c.x, c.y, c.z, 1f)); setMetallic(0.1f); setRoughness(0.4f) }
            e.components.set(ModelComponent(mesh, mat))
            r.addChild(e)
            event("spawned", "tag" to tg, "id" to id, "pos" to "\${pos.x},\${pos.y},\${pos.z}")
        }
        register("move") { ex ->
            val tg = ex.getString("tag") ?: ""
            val r = root(); val id = ex.getString("id")
            val e = if (r != null && id != null) find(r, id) else null
            if (e == null) { event("move_failed", "tag" to tg, "id" to (id ?: "null"), "msg" to "not_found"); return@register }
            if (e === registeredLocomotionRoot()) { event("move_failed", "tag" to tg, "id" to id, "msg" to "reserved_root"); return@register }
            val t = e.components[TransformComponent::class.java]
            if (t == null) { event("move_failed", "tag" to tg, "id" to id, "msg" to "no_transform"); return@register }
            val pos = vec3(ex.getString("pos"), t.position)
            e.components.set(TransformComponent(pos, t.quaternion, t.scaleVector))
            event("moved", "tag" to tg, "id" to id, "pos" to "\${pos.x},\${pos.y},\${pos.z}")
        }
        register("remove") { ex ->
            val tg = ex.getString("tag") ?: ""
            val r = root(); val id = ex.getString("id")
            val e = if (r != null && id != null) find(r, id) else null
            if (e == null) { event("remove_failed", "tag" to tg, "id" to (id ?: "null"), "msg" to "not_found"); return@register }
            if (e === registeredLocomotionRoot()) { event("remove_failed", "tag" to tg, "id" to id, "msg" to "reserved_root"); return@register }
            runCatching { e.destroy() }
                .onSuccess { event("removed", "tag" to tg, "id" to id) }
                .onFailure { event("remove_failed", "tag" to tg, "id" to id, "msg" to (it.message ?: "destroy_failed")) }
        }
    }

    private fun parseRequiredFiniteVector3(extras: Bundle): Vector3? {
        if (!extras.containsKey("x") || !extras.containsKey("y") || !extras.containsKey("z")) return null
        val x = extras.getFloat("x", Float.NaN)
        val y = extras.getFloat("y", Float.NaN)
        val z = extras.getFloat("z", Float.NaN)
        if (!x.isFinite() || !y.isFinite() || !z.isFinite()) return null
        return Vector3(x, y, z)
    }

    private fun validateLocomotionEnvelope(request: LocomotionFileRequest): String? = when {
        request.kind != LOCOMOTION_PAYLOAD_KIND -> "kind does not match the locomotion protocol"
        request.schemaVersion != LOCOMOTION_SCHEMA_VERSION -> "schemaVersion does not match the locomotion protocol"
        request.capabilityRevision != LOCOMOTION_CAPABILITY_REVISION -> "capabilityRevision does not match the locomotion protocol"
        else -> null
    }

    private fun locomotionUnavailableReason(context: Context, binding: LocomotionProducerBinding?): String? = when {
        context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0 -> "application_not_debuggable"
        observedStageStyle(context) != "Full" -> "full_stage_required"
        rootContainer != "stage" -> "stage_container_required"
        binding == null -> "locomotion_producer_unregistered"
        runCatching { binding.rootProvider() }.getOrNull() == null -> "agent_world_root_unavailable"
        else -> null
    }

    private suspend fun writeCommandsAck(context: Context, request: LocomotionFileRequest, target: File) {
        locomotionMutex.lock()
        try {
            val binding = currentLocomotionBinding()
            val envelopeError = validateLocomotionEnvelope(request)
            val unavailable = locomotionUnavailableReason(context, binding)
            val primaryError = envelopeError ?: unavailable
            val outcome = when {
                envelopeError != null -> "rejected"
                unavailable != null -> "capability_unavailable"
                else -> "available"
            }
            writeLocomotionAckAtomically(context, request, target, COMMANDS_COMMAND) { writer ->
                writer.name("outcome").value(outcome)
                writer.name("commands").beginArray()
                writer.value(COMMANDS_COMMAND); writer.value(HMD_POSE_COMMAND); writer.value(LOCOMOTE_COMMAND)
                writer.endArray()
                writer.name("availability").beginObject()
                writer.name("debuggable").value(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
                val stageStyle = observedStageStyle(context)
                writer.name("observedStageStyle"); if (stageStyle == null) writer.nullValue() else writer.value(stageStyle)
                writer.name("rootContainer"); if (rootContainer == null) writer.nullValue() else writer.value(rootContainer)
                writer.name("rootRegistered").value(binding != null && runCatching { binding.rootProvider() }.getOrNull() != null)
                writer.name("hmdAvailable").value(binding != null)
                writer.name("locomotionAvailable").value(binding != null)
                writer.endObject()
                writer.name("root")
                if (binding == null || runCatching { binding.rootProvider() }.getOrNull() == null) writer.nullValue()
                else writeLocomotionRoot(writer, binding.rootGeneration, binding.rootIncarnation)
                writeLocomotionErrors(writer, primaryError, null)
            }
        } finally {
            locomotionMutex.unlock()
        }
    }

    private suspend fun writeHmdPoseAck(context: Context, request: LocomotionFileRequest, target: File) {
        locomotionMutex.lock()
        try {
            val binding = currentLocomotionBinding()
            var primaryError = validateLocomotionEnvelope(request)
            if (primaryError == null && !locomotionIncarnationPattern.matches(request.rootIncarnation)) {
                primaryError = "root_incarnation_required"
            }
            if (primaryError == null && binding != null && binding.rootIncarnation != request.rootIncarnation) {
                primaryError = "stale_root_incarnation"
            }
            primaryError = primaryError ?: locomotionUnavailableReason(context, binding)
            if (primaryError == null && request.rootGenerationBefore > 0L && binding!!.rootGeneration != request.rootGenerationBefore) {
                primaryError = "stale_root_generation"
            }
            if (primaryError == null && !locomotionRequestIsCurrent(request.generation)) primaryError = "stale_generation"
            val pose = if (primaryError == null) runCatching { binding!!.hmdProducer() }.getOrNull() else null
            if (primaryError == null && (pose == null || !validHmdPose(pose))) primaryError = "hmd_pose_unavailable"
            if (primaryError == null && !locomotionRequestIsCurrent(request.generation)) {
                return
            }
            writeLocomotionAckAtomically(context, request, target, HMD_POSE_COMMAND) { writer ->
                writer.name("outcome").value(if (primaryError == null) "sampled" else
                    if (primaryError == "application_not_debuggable" || primaryError == "full_stage_required" ||
                        primaryError == "stage_container_required" || primaryError == "locomotion_producer_unregistered" ||
                        primaryError == "agent_world_root_unavailable") "capability_unavailable" else "rejected")
                writer.name("root")
                if (binding == null) writer.nullValue() else writeLocomotionRoot(writer, binding.rootGeneration, binding.rootIncarnation)
                writer.name("hmdPose")
                if (pose == null || primaryError != null) writer.nullValue() else writeHmdPose(writer, pose)
                writeLocomotionErrors(writer, primaryError, null)
            }
        } finally {
            locomotionMutex.unlock()
        }
    }

    private suspend fun writeLocomotionAck(context: Context, request: LocomotionFileRequest, target: File) {
        locomotionMutex.lock()
        try {
            val binding = currentLocomotionBinding()
            var primaryError = validateLocomotionEnvelope(request)
            primaryError = primaryError ?: when {
                request.requestControl != "execute" -> "request_control_must_be_execute"
                request.mode != "direct" && request.mode != "replacement" -> "mode_must_be_direct_or_replacement"
                request.target == null || !request.target.x.isFinite() || !request.target.y.isFinite() || !request.target.z.isFinite() ->
                    "finite_absolute_target_required"
                !request.absolute -> "absolute_target_required"
                request.glideDurationMs !in 0..10_000 -> "glide_duration_out_of_range"
                request.executionLeaseMs !in 2_000..12_000 || request.executionLeaseMs != request.glideDurationMs + 2_000 ->
                    "execution_lease_mismatch"
                request.mode == "replacement" && request.glideDurationMs != 0 -> "replacement_glide_must_be_zero"
                request.physicalWalk -> "physical_walk_refused"
                !locomotionIncarnationPattern.matches(request.rootIncarnation) -> "root_incarnation_required"
                binding != null && request.rootGenerationBefore != binding.rootGeneration -> "stale_root_generation"
                binding != null && request.rootIncarnation != binding.rootIncarnation -> "stale_root_incarnation"
                !locomotionRequestIsCurrent(request.generation) -> "stale_generation"
                else -> null
            }
            primaryError = primaryError ?: locomotionUnavailableReason(context, binding)
            val producerRequest = if (primaryError == null) LocomotionRequest(
                generation = request.generation,
                kind = request.kind,
                schemaVersion = request.schemaVersion,
                capabilityRevision = request.capabilityRevision,
                requestId = request.requestId,
                tag = request.tag,
                mode = request.mode,
                target = request.target!!,
                absolute = request.absolute,
                glideDurationMs = request.glideDurationMs,
                executionLeaseMs = request.executionLeaseMs,
                physicalWalk = request.physicalWalk,
                rootGenerationBefore = request.rootGenerationBefore,
                rootIncarnation = request.rootIncarnation,
            ) else null
            var result = if (producerRequest != null) {
                val leaseRemainingMs = remainingLocomotionLeaseMs(request) ?: return
                try {
                    withTimeout(leaseRemainingMs) { binding!!.producer(producerRequest) }
                } catch (_: TimeoutCancellationException) {
                    expireLocomotionLease(request)
                    return
                } catch (_: CancellationException) {
                    return
                } catch (cause: Throwable) {
                    AgentLocomotionResult("failed", null, cause.message ?: cause.javaClass.simpleName)
                }
            } else {
                AgentLocomotionResult(
                    if (primaryError == "application_not_debuggable" || primaryError == "full_stage_required" ||
                        primaryError == "stage_container_required" || primaryError == "locomotion_producer_unregistered" ||
                        primaryError == "agent_world_root_unavailable") "capability_unavailable" else "rejected",
                    null,
                    primaryError,
                )
            }
            if (primaryError == null && !locomotionRequestIsActive(producerRequest!!)) return
            if (primaryError == null) {
                val resultError = validateLocomotionResult(producerRequest!!, result)
                if (resultError != null) result = AgentLocomotionResult("failed", null, resultError, result.cleanupError)
            }
            if (result.outcome == "completed") {
                val pose = result.pose!!
                if (!completeLocomotionLease(request)) return
                if (!publishLocomotionRootGeneration(request.generation, pose.rootGeneration)) return
                if (!locomotionRequestIsCurrent(request.generation)) return
            } else if (!completeLocomotionLease(request)) {
                return
            }
            writeLocomotionAckAtomically(context, request, target, LOCOMOTE_COMMAND) { writer ->
                writer.name("requestControl").value("execute")
                writer.name("executionLeaseMs").value(request.executionLeaseMs.toLong())
                writer.name("outcome").value(result.outcome)
                writer.name("mode").value(request.mode)
                writer.name("target")
                if (request.target == null) writer.nullValue() else {
                    writer.beginObject()
                    writer.name("absolute").value(true)
                    writePositionMembers(writer, request.target)
                    writer.endObject()
                }
                writer.name("glideDurationMs").value(request.glideDurationMs.toLong())
                writer.name("rootGenerationBefore").value(request.rootGenerationBefore)
                writer.name("root")
                if (binding == null) writer.nullValue() else writeLocomotionRoot(writer, request.rootGenerationBefore, binding.rootIncarnation)
                writer.name("pose")
                if (result.pose == null) writer.nullValue() else writeWorldPose(writer, result.pose)
                writer.name("hmdPose").nullValue()
                writeLocomotionErrors(writer, result.primaryError, result.cleanupError)
            }
        } finally {
            locomotionMutex.unlock()
        }
    }

    private fun validateLocomotionResult(request: LocomotionRequest, result: AgentLocomotionResult): String? {
        if (result.outcome == "completed") {
            val pose = result.pose ?: return "completed_result_missing_pose"
            if (result.primaryError != null || result.cleanupError != null) return "completed_result_contains_error"
            if (!validWorldPose(pose)) return "completed_result_pose_not_finite"
            if (pose.position.x != request.target.x || pose.position.y != request.target.y || pose.position.z != request.target.z) {
                return "completed_result_target_mismatch"
            }
            val expectedGeneration = if (request.mode == "direct") request.rootGenerationBefore else request.rootGenerationBefore + 1L
            if (pose.rootGeneration != expectedGeneration) return "completed_result_generation_mismatch"
            return null
        }
        if (result.outcome != "rejected" && result.outcome != "failed" && result.outcome != "capability_unavailable") {
            return "unknown_locomotion_outcome"
        }
        if (result.pose != null || result.primaryError.isNullOrBlank()) return "failed_result_is_contradictory"
        return null
    }

    private fun validWorldPose(pose: AgentWorldPose): Boolean =
        pose.rootGeneration > 0L && pose.position.x.isFinite() && pose.position.y.isFinite() && pose.position.z.isFinite()

    private fun validHmdPose(pose: AgentHmdPose): Boolean = pose.readAtMonotonicNs >= 0L &&
        pose.position.x.isFinite() && pose.position.y.isFinite() && pose.position.z.isFinite() &&
        pose.rotation.x.isFinite() && pose.rotation.y.isFinite() && pose.rotation.z.isFinite() && pose.rotation.w.isFinite()

    private fun writeLocomotionRoot(writer: JsonWriter, generation: Long, incarnation: String) {
        writer.beginObject()
        writer.name("id").value(AGENT_WORLD_ROOT_ID)
        writer.name("generation").value(generation)
        writer.name("incarnation").value(incarnation)
        writer.endObject()
    }

    private fun writePositionMembers(writer: JsonWriter, position: Vector3) {
        writer.name("x").value(BigDecimal(position.x.toString()))
        writer.name("y").value(BigDecimal(position.y.toString()))
        writer.name("z").value(BigDecimal(position.z.toString()))
    }

    private fun writeWorldPose(writer: JsonWriter, pose: AgentWorldPose) {
        writer.beginObject()
        writer.name("rootGeneration").value(pose.rootGeneration)
        writer.name("position").beginObject(); writePositionMembers(writer, pose.position); writer.endObject()
        writer.endObject()
    }

    private fun writeHmdPose(writer: JsonWriter, pose: AgentHmdPose) {
        writer.beginObject()
        writer.name("readAtMonotonicNs").value(pose.readAtMonotonicNs.toString())
        writer.name("position").beginObject(); writePositionMembers(writer, pose.position); writer.endObject()
        writer.name("rotation").beginObject()
        writer.name("x").value(BigDecimal(pose.rotation.x.toString()))
        writer.name("y").value(BigDecimal(pose.rotation.y.toString()))
        writer.name("z").value(BigDecimal(pose.rotation.z.toString()))
        writer.name("w").value(BigDecimal(pose.rotation.w.toString()))
        writer.endObject()
        writer.endObject()
    }

    private fun writeLocomotionErrors(writer: JsonWriter, primaryError: String?, cleanupError: String?) {
        writer.name("primaryError"); if (primaryError == null) writer.nullValue() else writer.value(primaryError.take(500))
        writer.name("cleanupError"); if (cleanupError == null) writer.nullValue() else writer.value(cleanupError.take(500))
    }

    private fun publishLocomotionAckIfCurrent(
        request: LocomotionFileRequest,
        temp: File,
        target: File,
    ): Boolean {
        if (request.requestControl != "execute" && request.requestControl != "cancel" &&
            request.requestControl != "finalize"
        ) {
            return synchronized(locomotionLeaseLock) {
                val leaseState = locomotionLeases[request.requestId]?.state
                if (leaseState == LocomotionLeaseState.FINALIZING ||
                    leaseState == LocomotionLeaseState.FINALIZED
                ) return@synchronized false
                synchronized(locomotionGenerationLock) {
                    if (locomotionGeneration != request.generation) return@synchronized false
                    Os.rename(temp.absolutePath, target.absolutePath)
                    true
                }
            }
        }
        return synchronized(locomotionLeaseLock) {
            val lease = locomotionLeases[request.requestId] ?: return@synchronized false
            if (lease.generation != request.generation || lease.rootGeneration != request.rootGenerationBefore ||
                lease.rootIncarnation != request.rootIncarnation || lease.tag != request.tag
            ) return@synchronized false
            if (request.requestControl == "execute") {
                if (lease.state != LocomotionLeaseState.EXECUTE_TERMINAL) return@synchronized false
                return@synchronized synchronized(locomotionGenerationLock) {
                    if (locomotionGeneration != request.generation) return@synchronized false
                    Os.rename(temp.absolutePath, target.absolutePath)
                    true
                }
            }
            if (request.requestControl == "finalize") {
                if (lease.state != LocomotionLeaseState.FINALIZING) {
                    return@synchronized false
                }
                // The process-lifetime fence is visible before the rename.  A
                // readable finalize ack therefore implies that every prior
                // writer was joined and no later writer can publish this ID.
                lease.state = LocomotionLeaseState.FINALIZED
                Os.rename(temp.absolutePath, target.absolutePath)
                return@synchronized true
            }
            if (lease.state != LocomotionLeaseState.CANCEL_TERMINAL &&
                lease.state != LocomotionLeaseState.EXECUTE_TERMINAL
            ) return@synchronized false
            Os.rename(temp.absolutePath, target.absolutePath)
            true
        }
    }

    private suspend fun writeLocomotionAckAtomically(
        context: Context,
        request: LocomotionFileRequest,
        target: File,
        operation: String,
        writeBody: suspend (JsonWriter) -> Unit,
    ) {
        val directory = target.parentFile ?: throw IllegalStateException("locomotion cache has no parent")
        if (!directory.exists() && !directory.mkdirs()) throw IllegalStateException("could not create locomotion cache")
        val temp = File(directory, ".\${request.requestId}.tmp-\${SystemClock.elapsedRealtimeNanos()}")
        val output = FileOutputStream(temp)
        try {
            val writer = JsonWriter(OutputStreamWriter(output, Charsets.UTF_8))
            writer.beginObject()
            writer.name("kind").value(LOCOMOTION_PAYLOAD_KIND)
            writer.name("schemaVersion").value(LOCOMOTION_SCHEMA_VERSION.toLong())
            writer.name("capabilityRevision").value(LOCOMOTION_CAPABILITY_REVISION.toLong())
            writer.name("requestId").value(request.requestId)
            writer.name("tag").value(request.tag)
            writer.name("application").beginObject(); writer.name("packageName").value(context.packageName); writer.endObject()
            writer.name("operation").value(operation)
            writer.name("physicalWalk").value(false)
            writeBody(writer)
            writer.endObject()
            writer.flush()
            output.fd.sync()
        } catch (cause: Throwable) {
            temp.delete()
            throw cause
        } finally {
            runCatching { output.close() }
        }
        try {
            currentCoroutineContext().ensureActive()
            if (!publishLocomotionAckIfCurrent(request, temp, target)) temp.delete()
        } catch (cause: Throwable) {
            temp.delete()
            throw cause
        }
    }

    private fun parseNavigationGuideRgb(value: String?): IntArray {
        val invalid = intArrayOf(-1, -1, -1)
        val tokens = value?.split(",") ?: return invalid
        if (tokens.size != 3) return invalid
        val channels = IntArray(3)
        tokens.forEachIndexed { index, token ->
            val channel = token.trim().toIntOrNull() ?: return invalid
            if (channel !in 0..255) return invalid
            channels[index] = channel
        }
        return channels
    }

    private fun validateNavigationGuideRequest(request: NavigationGuideRequest): String? = when {
        request.kind != NAVIGATION_GUIDE_PAYLOAD_KIND -> "kind does not match the navigation-guide protocol"
        request.schemaVersion != NAVIGATION_GUIDE_SCHEMA_VERSION -> "schemaVersion does not match the navigation-guide protocol"
        request.bridgeRevision != NAVIGATION_GUIDE_BRIDGE_REVISION -> "bridgeRevision does not match the navigation-guide protocol"
        request.mode != "show" && request.mode != "hide" -> "mode must be show or hide"
        !sceneSnapshotIdPattern.matches(request.sceneSnapshotId) -> "sceneSnapshotId must be a lowercase SHA-256"
        !targetTraceIdPattern.matches(request.targetTraceId) -> "targetTraceId must be a trace-local anchor ID"
        request.targetRuntimeUuid.length !in 1..256 || request.targetRuntimeUuid.any { it.code !in 0x21..0x7e } ->
            "targetRuntimeUuid must be a non-empty printable runtime identity"
        request.pattern != NAVIGATION_GUIDE_PATTERN -> "unsupported navigation-guide pattern"
        request.projectionModel != NAVIGATION_GUIDE_PROJECTION_MODEL -> "unsupported navigation-guide projection model"
        !request.color0.contentEquals(NAVIGATION_GUIDE_COLOR_0) || !request.color1.contentEquals(NAVIGATION_GUIDE_COLOR_1) ->
            "unsupported navigation-guide palette"
        request.widthM != NAVIGATION_GUIDE_WIDTH_M || request.heightM != NAVIGATION_GUIDE_HEIGHT_M ->
            "unsupported navigation-guide dimensions"
        else -> null
    }

    private suspend fun cleanupNavigationGuideAfterRejection(
        cleanup: (suspend () -> Boolean)? = navigationGuideCleanup,
    ): Boolean {
        val callback = cleanup ?: return true
        return runCatching { callback() }.getOrDefault(false)
    }

    private fun validateNavigationGuideResult(
        request: NavigationGuideRequest,
        result: NavigationGuideResult,
    ): String? = when (result.outcome) {
        "shown" -> if (
            request.mode == "show" && result.guideState == "visible" &&
            result.cleanupState == "not_required" && result.errorCode == null && result.errorDetail == null
        ) null else "shown producer result is contradictory"
        "hidden" -> if (
            request.mode == "hide" && result.guideState == "hidden" &&
            result.cleanupState == "completed" && result.errorCode == null && result.errorDetail == null
        ) null else "hidden producer result is contradictory"
        "rejected", "failed" -> if (
            result.guideState != "visible" && result.cleanupState != "not_required" &&
            !result.errorCode.isNullOrBlank() && !result.errorDetail.isNullOrBlank()
        ) null else "rejected/failed producer result is contradictory"
        else -> "producer returned an unknown outcome"
    }

    private fun publishNavigationGuideAckIfCurrent(
        context: Context,
        request: NavigationGuideRequest,
        target: File,
        result: NavigationGuideResult,
    ): Boolean = synchronized(navigationGuideGenerationLock) {
        if (request.generation != navigationGuideGeneration) return@synchronized false
        writeNavigationGuideAckAtomically(context, request, target, result)
        true
    }

    private suspend fun writeNavigationGuideAck(request: NavigationGuideRequest) {
        val context = applicationContext ?: return
        val target = navigationGuideTarget(context, request.requestId)
        navigationGuideMutex.lock()
        try {
            val binding = navigationGuideProducerBinding(request.generation)
            if (!binding.generationIsCurrent) {
                return
            }
            val validationError = validateNavigationGuideRequest(request)
            var result = when {
                validationError != null -> {
                    val cleaned = cleanupNavigationGuideAfterRejection(binding.cleanup)
                    NavigationGuideResult(
                        outcome = "rejected",
                        guideState = if (cleaned) "hidden" else "unknown",
                        cleanupState = if (cleaned) "completed" else "failed",
                        errorCode = "invalid_request",
                        errorDetail = validationError,
                    )
                }
                binding.producer == null -> {
                    val cleaned = cleanupNavigationGuideAfterRejection(binding.cleanup)
                    NavigationGuideResult(
                        outcome = "failed",
                        guideState = if (cleaned) "hidden" else "unknown",
                        cleanupState = if (cleaned) "completed" else "failed",
                        errorCode = "bridge_unavailable",
                        errorDetail = "no navigation-guide producer is registered",
                    )
                }
                else -> try {
                    binding.producer.invoke(request)
                } catch (cause: Throwable) {
                    val cleaned = cleanupNavigationGuideAfterRejection(binding.cleanup)
                    NavigationGuideResult(
                        outcome = "failed",
                        guideState = if (cleaned) "hidden" else "unknown",
                        cleanupState = if (cleaned) "completed" else "failed",
                        errorCode = "producer_failed",
                        errorDetail = (cause.message ?: cause.javaClass.simpleName).take(500),
                    )
                }
            }
            if (!navigationGuideRequestIsCurrent(request.generation)) {
                cleanupNavigationGuideAfterRejection(binding.cleanup)
                return
            }
            val resultError = validateNavigationGuideResult(request, result)
            if (resultError != null) {
                val cleaned = cleanupNavigationGuideAfterRejection(binding.cleanup)
                result = NavigationGuideResult(
                    outcome = "failed",
                    guideState = if (cleaned) "hidden" else "unknown",
                    cleanupState = if (cleaned) "completed" else "failed",
                    errorCode = "invalid_producer_result",
                    errorDetail = resultError,
                )
            }
            if (!navigationGuideRequestIsCurrent(request.generation)) {
                cleanupNavigationGuideAfterRejection(binding.cleanup)
                return
            }
            try {
                if (!publishNavigationGuideAckIfCurrent(context, request, target, result)) {
                    cleanupNavigationGuideAfterRejection(binding.cleanup)
                    return
                }
                event(
                    "navigation_guide_ack_written",
                    "requestId" to request.requestId,
                    "revision" to NAVIGATION_GUIDE_BRIDGE_REVISION,
                    "outcome" to result.outcome,
                )
            } catch (cause: Throwable) {
                cleanupNavigationGuideAfterRejection(binding.cleanup)
                event(
                    "navigation_guide_ack_failed",
                    "requestId" to request.requestId,
                    "revision" to NAVIGATION_GUIDE_BRIDGE_REVISION,
                    "msg" to (cause.message ?: cause.javaClass.simpleName).take(300),
                )
            }
        } finally {
            navigationGuideMutex.unlock()
        }
    }

    private fun writeNavigationGuideAckAtomically(
        context: Context,
        request: NavigationGuideRequest,
        target: File,
        result: NavigationGuideResult,
    ) {
        val directory = target.parentFile ?: throw IllegalStateException("navigation-guide cache has no parent")
        if (!directory.exists() && !directory.mkdirs()) throw IllegalStateException("could not create navigation-guide cache")
        val temp = File(directory, ".\${request.requestId}.tmp-\${SystemClock.elapsedRealtimeNanos()}")
        val output = FileOutputStream(temp)
        try {
            val writer = JsonWriter(OutputStreamWriter(output, Charsets.UTF_8))
            writer.beginObject()
            writer.name("kind").value(NAVIGATION_GUIDE_PAYLOAD_KIND)
            writer.name("schemaVersion").value(NAVIGATION_GUIDE_SCHEMA_VERSION.toLong())
            writer.name("bridgeRevision").value(NAVIGATION_GUIDE_BRIDGE_REVISION.toLong())
            writer.name("requestId").value(request.requestId)
            writer.name("application").beginObject()
            writer.name("packageName").value(context.packageName)
            writer.endObject()
            writer.name("mode").value(request.mode)
            writer.name("sceneSnapshotId").value(request.sceneSnapshotId)
            writer.name("targetTraceId").value(request.targetTraceId)
            writer.name("targetRuntimeUuid").value(request.targetRuntimeUuid)
            writer.name("pattern").value(request.pattern)
            writer.name("projectionModel").value(request.projectionModel)
            writer.name("colors").beginArray()
            writer.beginArray(); request.color0.forEach { writer.value(it.toLong()) }; writer.endArray()
            writer.beginArray(); request.color1.forEach { writer.value(it.toLong()) }; writer.endArray()
            writer.endArray()
            // Float.toString() returns the shortest exact source decimal ("0.74"/"0.44");
            // BigDecimal preserves it in JSON instead of widening to 0.7400000095367432.
            writer.name("widthM").value(BigDecimal(request.widthM.toString()))
            writer.name("heightM").value(BigDecimal(request.heightM.toString()))
            writer.name("outcome").value(result.outcome)
            writer.name("guideState").value(result.guideState)
            writer.name("cleanupState").value(result.cleanupState)
            writer.name("error")
            if (result.errorCode == null || result.errorDetail == null) {
                writer.nullValue()
            } else {
                writer.beginObject()
                writer.name("code").value(result.errorCode.take(120))
                writer.name("detail").value(result.errorDetail.take(500))
                writer.endObject()
            }
            writer.endObject()
            writer.flush()
            output.fd.sync()
        } catch (cause: Throwable) {
            temp.delete()
            throw cause
        } finally {
            runCatching { output.close() }
        }
        try {
            Os.rename(temp.absolutePath, target.absolutePath)
        } catch (cause: Throwable) {
            temp.delete()
            throw cause
        }
    }

    private suspend fun writeSceneSnapshot(request: SceneSnapshotRequest) {
        val producer = sceneSnapshotProducer
        val stageOpen = rootContainer == "stage" && runCatching { root() != null }.getOrDefault(false)
        when {
            rootContainer == null -> writeTerminalSnapshot(request, "binding_failed", "root container identity was not reported")
            !stageOpen -> writeTerminalSnapshot(request, "stage_not_open", "an attached stage root is required")
            producer == null -> writeTerminalSnapshot(request, "bridge_unavailable", "no scene snapshot producer is registered")
            else -> {
                val ctx = applicationContext ?: return
                val target = sceneSnapshotTarget(ctx, request.requestId)
                try {
                    writeSnapshotAtomically(ctx, request, target) { writer -> producer(request, writer) }
                    event(
                        "scene_snapshot_written",
                        "requestId" to request.requestId,
                        "revision" to SCENE_BRIDGE_REVISION,
                        "bytes" to target.length(),
                    )
                } catch (cause: Throwable) {
                    val detail = (cause.message ?: cause.javaClass.simpleName).take(500)
                    runCatching { writeTerminalSnapshot(request, "invalid_payload", detail) }
                    event("scene_snapshot_failed", "requestId" to request.requestId, "msg" to detail)
                }
            }
        }
    }

    private suspend fun writeTerminalSnapshot(request: SceneSnapshotRequest, code: String, detail: String) {
        val ctx = applicationContext ?: return
        val target = sceneSnapshotTarget(ctx, request.requestId)
        writeSnapshotAtomically(ctx, request, target) { writer ->
            writer.name("readiness").beginObject()
            writer.name("maxRetries").value(request.maxRetries.toLong())
            writer.name("pollMs").value(request.pollMs)
            writer.name("stabilityReads").value(request.stabilityReads.toLong())
            writer.name("retries").value(0L)
            writer.name("satisfied").value(false)
            writer.endObject()
            writer.name("reads").beginArray().endArray()
            writer.name("error").beginObject()
            writer.name("code").value(code)
            writer.name("detail").value(detail.take(500))
            writer.endObject()
        }
        event("scene_snapshot_written", "requestId" to request.requestId, "terminal" to code, "bytes" to target.length())
    }

    private suspend fun writeSnapshotAtomically(
        context: Context,
        request: SceneSnapshotRequest,
        target: File,
        writeBody: suspend (JsonWriter) -> Unit,
    ) {
        val directory = target.parentFile ?: throw IllegalStateException("scene snapshot cache has no parent")
        if (!directory.exists() && !directory.mkdirs()) throw IllegalStateException("could not create scene snapshot cache")
        val temp = File(directory, ".\${request.requestId}.tmp-\${SystemClock.elapsedRealtimeNanos()}")
        val output = FileOutputStream(temp)
        try {
            val writer = JsonWriter(OutputStreamWriter(output, Charsets.UTF_8))
            writer.beginObject()
            writeEnvelopeHeader(writer, context, request)
            writeBody(writer)
            writer.endObject()
            writer.flush()
            output.fd.sync()
        } catch (cause: Throwable) {
            temp.delete()
            throw cause
        } finally {
            runCatching { output.close() }
        }
        try {
            // POSIX rename on the same app-cache filesystem publishes either all exact bytes or none.
            Os.rename(temp.absolutePath, target.absolutePath)
        } catch (cause: Throwable) {
            temp.delete()
            throw cause
        }
    }

    private fun writeEnvelopeHeader(writer: JsonWriter, context: Context, request: SceneSnapshotRequest) {
        writer.name("kind").value(SCENE_PAYLOAD_KIND)
        writer.name("schemaVersion").value(SCENE_SCHEMA_VERSION.toLong())
        writer.name("bridgeRevision").value(SCENE_BRIDGE_REVISION.toLong())
        writer.name("requestId").value(request.requestId)
        writer.name("application").beginObject()
        writer.name("packageName").value(context.packageName)
        val buildSha256 = runCatching { apkSha256(context) }.getOrNull()
        if (buildSha256 == null) {
            writer.name("buildIdentity").nullValue()
        } else {
            writer.name("buildIdentity").beginObject()
            writer.name("kind").value("apk-sha256")
            writer.name("sha256").value(buildSha256)
            writer.endObject()
        }
        val stageStyle = observedStageStyle(context)
        if (stageStyle == null) writer.name("observedStageStyle").nullValue()
        else writer.name("observedStageStyle").value(stageStyle)
        if (rootContainer == null) writer.name("rootContainer").nullValue()
        else writer.name("rootContainer").value(rootContainer)
        writer.name("stageOpen").value(rootContainer == "stage" && runCatching { root() != null }.getOrDefault(false))
        writer.endObject()
        writer.name("coordinateFrame").beginObject()
        writer.name("id").value("${AGENT_BRIDGE_SCENE_COORDINATE_FRAME_ID}")
        writer.name("units").value("metres")
        writer.name("handedness").value("sdk-reported")
        writer.endObject()
    }

    @Suppress("DEPRECATION")
    private fun observedStageStyle(context: Context): String? {
        val packageManager = context.packageManager
        val launcher = runCatching { packageManager.getLaunchIntentForPackage(context.packageName)?.component }.getOrNull()
        val activityRaw = launcher?.let { component ->
            runCatching { packageManager.getActivityInfo(component, PackageManager.GET_META_DATA).metaData?.get("pico.spatial.stage.style") }.getOrNull()
        }
        val applicationRaw = runCatching {
            packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
                .metaData?.get("pico.spatial.stage.style")
        }.getOrNull()
        // The repo scaffold follows PICO's manifest shape and declares this on the launcher
        // activity. Application metadata is accepted only as a compatibility fallback.
        val raw = activityRaw ?: applicationRaw
        return when (raw?.toString()?.trim()) {
            "1", "Mixed", "mixed" -> "Mixed"
            "3", "Full", "full" -> "Full"
            else -> null
        }
    }

    private fun apkSha256(context: Context): String {
        cachedApkSha256?.let { return it }
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(context.applicationInfo.sourceDir).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) digest.update(buffer, 0, count)
            }
        }
        val value = digest.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
        cachedApkSha256 = value
        return value
    }

    private fun sceneSnapshotTarget(context: Context, requestId: String): File =
        File(File(context.cacheDir, SCENE_SNAPSHOT_CACHE_DIRECTORY), "$requestId.json")

    private fun navigationGuideTarget(context: Context, requestId: String): File =
        File(File(context.cacheDir, NAVIGATION_GUIDE_CACHE_DIRECTORY), "$requestId.json")

    private fun locomotionTarget(context: Context, requestId: String): File =
        File(File(context.cacheDir, LOCOMOTION_CACHE_DIRECTORY), "$requestId.json")

    private fun find(root: Entity, name: String): Entity? {
        var found: Entity? = null
        walk(root, 0, Int.MAX_VALUE) { e, _ -> if (found == null && e.getName() == name) found = e }
        return found
    }

    private fun vec3(s: String?, def: Vector3): Vector3 {
        if (s == null) return def
        val p = s.split(",")
        if (p.size != 3) return def
        return runCatching { Vector3(p[0].trim().toFloat(), p[1].trim().toFloat(), p[2].trim().toFloat()) }.getOrDefault(def)
    }

    private fun walk(e: Entity, depth: Int, maxDepth: Int, visit: (Entity, Int) -> Unit) {
        visit(e, depth)
        if (depth >= maxDepth) return
        runCatching { e.getChildren() }.getOrDefault(emptyArray()).forEach { walk(it, depth + 1, maxDepth, visit) }
    }
}
`;
}

function initProviderKt(pkg: string): string {
  return `package ${pkg}

import android.content.BroadcastReceiver
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle

/**
 * AgentBridgeInitProvider — zero-app-code auto-init for AgentBridge (the LeakCanary/Firebase trick).
 * Generated by pico-spatial-mcp generate_agent_bridge.
 *
 * Manifest-merged ContentProvider: its onCreate runs at process start (before Application.onCreate),
 * registering the <applicationId>.AGENT_CMD BroadcastReceiver. No ContentProvider data methods used.
 */
class AgentBridgeInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val ctx = context?.applicationContext ?: return false
        AgentBridge.initialize(ctx)
        val action = ctx.packageName + AgentBridge.ACTION_SUFFIX
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                if (intent == null) return
                val cmd = intent.getStringExtra("cmd")
                val extras = intent.extras ?: Bundle()
                val requestControl = extras.getString("requestControl")
                if (cmd == AgentBridge.LOCOMOTE_COMMAND &&
                    (requestControl == "cancel" || requestControl == "finalize")
                ) {
                    val pending = goAsync()
                    val callbackOwned = runCatching {
                        if (requestControl == "cancel") {
                            AgentBridge.dispatchLocomotionCancellation(extras) { pending.finish() }
                        } else {
                            AgentBridge.dispatchLocomotionFinalization(extras) { pending.finish() }
                        }
                    }.getOrDefault(false)
                    if (!callbackOwned) pending.finish()
                    return
                }
                AgentBridge.dispatch(cmd, extras)
            }
        }
        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= 33) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, filter)
        }
        AgentBridge.event("bridge_ready", "action" to action)
        return true
    }

    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?): Int = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?): Int = 0
}
`;
}

export function registerAgentBridgeTools(server: McpServer) {
  server.registerTool(
    "generate_agent_bridge",
    {
      description:
        "Emit an INJECTABLE Kotlin 'Agent Bridge' library that makes a native PICO app headlessly agent-drivable and structurally inspectable. It self-initializes via a manifest-merged ContentProvider and exposes AGENT_CMD broadcasts, structured logcat telemetry, a live scene-graph dump, and the revision-41 query_scene_anchors transport. Scene geometry uses a versioned, lossless, nonce-addressed app-cache JSON file read with explicit-serial run-as; it is never sent through logcat. Those signals prove state, not appearance. Pair them with a capture whose returned app pixels you actually LOOK at; adb capture_frame is often stable for native content, while an alternate host-window capture may be needed when it is black/inconclusive. Returns Kotlin, manifest wiring, and drive examples. APIs are source-confirmed; broadcast/logcat behavior is emulator-measured; revision 41 was live-validated on emulator-5554 with the generated com.fleet.swanmissiontable app. Geometry and labels retain a structural evidence ceiling; rendered pixels require separate visual evidence.",
      inputSchema: {
        packageName: z
          .string()
          .describe("Package for the bridge files, e.g. com.example.spatialdemo.agent"),
        tag: z.string().optional().describe("Logcat tag for telemetry (default 'AgentBridge')."),
      },
    },
    async ({ packageName, tag }) => {
      const t = tag ?? "AgentBridge";
      const pkgPath = packageName.replace(/\./g, "/");
      const files = [
        { path: `app/src/main/java/${pkgPath}/AgentBridge.kt`, content: agentBridgeKt(packageName, t) },
        { path: `app/src/main/java/${pkgPath}/AgentBridgeInitProvider.kt`, content: initProviderKt(packageName) },
      ];
      const manifestProvider =
        `<!-- Agent Bridge auto-init (manifest-merged; boots with no app code). Place inside <application>. -->\n` +
        `<provider\n` +
        `    android:name="${packageName}.AgentBridgeInitProvider"\n` +
        `    android:authorities="\${applicationId}.agentbridge"\n` +
        `    android:exported="false"\n` +
        `    android:enabled="true" />`;
      const integration = [
        "1. Write both .kt files to the paths above.",
        "2. Merge the <provider> snippet into the app's AndroidManifest.xml inside <application>. (Auto-inits the AGENT_CMD receiver at process start — no app code needed.)",
        "3. (Optional, for old scene introspection) after building your scene root, add one line: AgentBridge.attachScene(sceneRoot) — e.g. in HomeStage right after the SpatialView content is built.",
        "4. For query_scene_anchors, report the root explicitly with AgentBridge.attachScene(stageRoot, \"stage\"), pair it with AgentBridge.detachScene(stageRoot) from Stage disposal/closure (or use the identity-bearing attachSceneProvider/detachSceneProvider pair), generate SceneUnderstanding.kt, and call SceneUnderstanding.registerAgentBridgeSceneSnapshot(). Omitting container identity fails binding closed. The one bridge command then performs all unfiltered readiness reads and writes one lossless payload.",
        "5. (Optional) register app-specific commands: AgentBridge.register(\"arm\") { _ -> placer.toggleArmed() }.",
      ];
      const driveExamples = [
        "adb -s emulator-5554 shell am broadcast -a <applicationId>.AGENT_CMD --es cmd ping",
        "adb -s emulator-5554 shell am broadcast -a <applicationId>.AGENT_CMD --es cmd scene_stats",
        "adb -s emulator-5554 shell am broadcast -a <applicationId>.AGENT_CMD --es cmd dump_scene --ei depth 8",
        "adb -s emulator-5554 shell am broadcast -a <applicationId>.AGENT_CMD --es cmd query_scene_anchors --es requestId <nonce> --ei maxRetries 15 --ei pollMs 1000 --ei stabilityReads 2",
        "adb -s emulator-5554 exec-out run-as <applicationId> cat cache/agentbridge/scene-snapshots/<nonce>.json  # exact payload bytes; use a unique nonce",
        `adb -s emulator-5554 logcat -d -s ${t}:V   # read the AGENTBRIDGE| markers`,
      ];
      return okJson({
        files,
        manifestProvider,
        integration,
        driveExamples,
        sceneSnapshotProtocol: {
          kind: AGENT_BRIDGE_SCENE_PAYLOAD_KIND,
          schemaVersion: AGENT_BRIDGE_SCENE_SCHEMA_VERSION,
          bridgeRevision: AGENT_BRIDGE_SCENE_REVISION,
          command: AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND,
          cacheDirectory: AGENT_BRIDGE_SCENE_SNAPSHOT_CACHE_DIRECTORY,
        },
        navigationGuideProtocol: {
          kind: AGENT_BRIDGE_NAVIGATION_GUIDE_PAYLOAD_KIND,
          schemaVersion: AGENT_BRIDGE_NAVIGATION_GUIDE_SCHEMA_VERSION,
          bridgeRevision: AGENT_BRIDGE_NAVIGATION_GUIDE_REVISION,
          command: AGENT_BRIDGE_NAVIGATION_GUIDE_COMMAND,
          cacheDirectory: AGENT_BRIDGE_NAVIGATION_GUIDE_CACHE_DIRECTORY,
          pattern: AGENT_BRIDGE_NAVIGATION_GUIDE_PATTERN,
          projectionModel: AGENT_BRIDGE_NAVIGATION_GUIDE_PROJECTION_MODEL,
          colors: AGENT_BRIDGE_NAVIGATION_GUIDE_COLORS,
          widthM: AGENT_BRIDGE_NAVIGATION_GUIDE_WIDTH_M,
          heightM: AGENT_BRIDGE_NAVIGATION_GUIDE_HEIGHT_M,
          evidenceCeiling: "structural",
        },
        locomotionProtocol: {
          kind: AGENT_BRIDGE_LOCOMOTION_PAYLOAD_KIND,
          schemaVersion: AGENT_BRIDGE_LOCOMOTION_SCHEMA_VERSION,
          capabilityRevision: AGENT_BRIDGE_LOCOMOTION_CAPABILITY_REVISION,
          cacheDirectory: AGENT_BRIDGE_LOCOMOTION_CACHE_DIRECTORY,
          rootId: AGENT_BRIDGE_LOCOMOTION_ROOT_ID,
          commands: AGENT_BRIDGE_LOCOMOTION_COMMANDS,
          modes: ["direct", "replacement"],
          physicalWalk: false,
          evidenceCeiling: "structural",
        },
        builtinCommands: ["ping", "commands", "scene_stats", "dump_scene", AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND, "spawn", "move", "remove"],
        debugCommands: [AGENT_BRIDGE_NAVIGATION_GUIDE_COMMAND, AGENT_BRIDGE_HMD_POSE_COMMAND, AGENT_BRIDGE_LOCOMOTE_COMMAND],
        verification:
          "The revision-41 source and exact-file transport contract is structurally tested and was exercised live on emulator-5554 by com.fleet.swanmissiontable. The pulled geometry and labels remain structural evidence; verify rendered pixels separately from hidden scene data.",
      });
    },
  );
}
