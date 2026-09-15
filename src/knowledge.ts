import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { okJson } from "./util.js";
import {
  ensurePicoCli,
  classifyPicoCliFailure,
  describePicoCliEnvironmentFailure,
  picoCliExecutionGuards,
  picoCliOperationCapability,
  picoCliProvenance,
  picoCliFromEnsure,
  runPicoCliCommand,
  type PicoCliExecutionGuards,
  type PicoCliExecutionTarget,
  type PicoCliFailureClass,
  type PicoCliProvenance,
} from "./picocli.js";
import {
  capabilityFailureClass,
  capabilityNeedsFreshDiscovery,
  cliOperationRoutes,
  unknownCapability,
  type CliOperation,
  type OperationCapability,
} from "./clicapabilities.js";

export const DEFAULT_KNOWLEDGE_COMMAND = "pico-cli";
const KNOWLEDGE_OPERATION: CliOperation = "knowledge-server";

function knowledgeRouteFor(version: string): readonly string[] {
  return cliOperationRoutes(version).find((route) => route.operation === KNOWLEDGE_OPERATION)?.argvPrefix ?? [];
}

/**
 * Legacy default for an explicitly configured command/args pair: the 0.4.x knowledge route, taken
 * from the capability route table so the argv lives in exactly one place. The managed transport
 * never uses it — it dispatches the route the resolved CLI's own help evidence proves, which on
 * the 0.5.x line is `knowledge server` (the spaced `mcp dev-knowledge` route was removed there).
 */
export const DEFAULT_KNOWLEDGE_ARGS: readonly string[] = knowledgeRouteFor("0.4.4");
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_RETIREMENT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_STARTUP_STDERR_BYTES = 16 * 1_024;
const FAILURE_CLASSIFICATION_OVERLAP_CHARS = 256;
const SETUP_REQUIRED_NOTE = "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry.";
/**
 * The published pico-cli knowledge server starts a degraded stdio MCP server when it resolves no
 * graph/workspace (0.4.4 `package/dist/index.js`, 0.5.0 `package/dist/chunk-BLCMTNZL.js`, both
 * reached from `serveGraphify`): `initialize` succeeds, `tools/list` declares only an
 * "[Unavailable]" `graph_stats`, and every `tools/call` answers `isError` with exactly this
 * sentence. The transport started, so this is a knowledge-DATA gap, not a transport failure — and
 * a started transport says nothing about the graph API the provisioned server would expose. The
 * reason text inside the parentheses is version-specific (0.4.4 reports a graph.json path or
 * "current directory is not a pico-cli setup project"; 0.5.0 reports its .pico-env.json
 * diagnosis), so it is carried through verbatim instead of being parsed. It can itself contain
 * parentheses, which is why the reason group is greedy.
 */
const KNOWLEDGE_DATA_UNAVAILABLE_PATTERN = /^Knowledge graph not available \(([\s\S]*)\)\.\s+(Run `pico-cli setup(?: --project [^`]*)?` to initialize\.)$/;
const KNOWLEDGE_GENERATION_TOKEN_ENV = "PICO_MCP_KNOWLEDGE_GENERATION_TOKEN";
const KNOWLEDGE_GENERATION_TOKEN_PATTERN = /^[1-9]\d*-[a-f0-9]{48}$/;
const PROCESS_SCAN_TIMEOUT_MS = 250;
const PROCESS_SCAN_MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const PROCESS_SCAN_MAX_MATCHES = 256;
const NATURAL_RETIREMENT_GRACE_MS = 100;

/** MCP SDK 1.30 exposes the child PID but not its stdin. Ending the already-open stdin stream is
 * the only graceful close primitive that cannot target a PID-reuse victim: the pipe object stays
 * bound to the spawned child even after its numeric PID is gone. Signals remain outside this class
 * and require a fresh OS birth-identity check. */
class KnowledgeStdioClientTransport extends StdioClientTransport {
  /** SDK error paths call transport.close() themselves. Never delegate while a numeric child
   * handle remains: the base implementation escalates with unchecked delayed PID signals. */
  override async close(): Promise<void> {
    const child = Reflect.get(this, "_process") as object | undefined;
    if (child) {
      this.requestGracefulEof();
      return;
    }
    await super.close();
  }

  requestGracefulEof(): string | null {
    try {
      const child = Reflect.get(this, "_process") as { stdin?: { end: () => void } | null } | undefined;
      child?.stdin?.end();
      return null;
    } catch (error) {
      return `the exact child stdin could not be closed: ${errorMessage(error)}`;
    }
  }

  /** Remove the SDK's numeric child handle only after the birth-bound process set is proven empty.
   * Client.close() can then clear protocol state without its delayed unchecked TERM/KILL fallback. */
  releaseConfirmedExitedProcess(): string | null {
    try {
      if (!Reflect.set(this, "_process", undefined)) {
        return "the SDK transport retained its numeric child handle";
      }
      return null;
    } catch (error) {
      return `the SDK transport child handle could not be released: ${errorMessage(error)}`;
    }
  }

  exactChildState(expectedPid: number): "live" | "exited" | "unavailable" {
    try {
      const child = Reflect.get(this, "_process") as {
        pid?: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      } | undefined;
      // StdioClientTransport clears this field only from the exact ChildProcess close callback or
      // after this lifecycle layer has already proved the generation empty and released it.
      if (!child) return "exited";
      if (child.pid !== expectedPid) return "unavailable";
      return child.exitCode !== null || child.signalCode !== null ? "exited" : "live";
    } catch {
      return "unavailable";
    }
  }
}

export type KnowledgeAction =
  | "query_graph"
  | "get_node"
  | "get_neighbors"
  | "get_community"
  | "god_nodes"
  | "graph_stats"
  | "shortest_path"
  | "switch_workspace";

const nonBlank = z.string().trim().min(1);

const queryGraphInput = z.object({
  action: z.literal("query_graph"),
  question: nonBlank,
  mode: z.enum(["bfs", "dfs"]).default("bfs"),
  depth: z.number().int().min(1).max(6).default(3),
  token_budget: z.number().int().positive().default(2_000),
  max_degree: z.number().int().nonnegative().default(0),
  query_variants: z.array(nonBlank).optional(),
  sort_by: z.enum(["degree", "relevance"]).default("degree"),
}).strict();

const getNodeInput = z.object({
  action: z.literal("get_node"),
  label: nonBlank,
}).strict();

const getNeighborsInput = z.object({
  action: z.literal("get_neighbors"),
  label: nonBlank,
  relation_filter: nonBlank.optional(),
}).strict();

const getCommunityInput = z.object({
  action: z.literal("get_community"),
  community_id: z.number().int().nonnegative(),
}).strict();

const godNodesInput = z.object({
  action: z.literal("god_nodes"),
  top_n: z.number().int().positive().default(10),
}).strict();

const graphStatsInput = z.object({
  action: z.literal("graph_stats"),
}).strict();

const shortestPathInput = z.object({
  action: z.literal("shortest_path"),
  source: nonBlank,
  target: nonBlank,
  max_hops: z.number().int().positive().default(8),
}).strict();

const switchWorkspaceInput = z.object({
  action: z.literal("switch_workspace"),
  workspace: nonBlank,
}).strict();

export const knowledgeInputSchema = z.discriminatedUnion("action", [
  queryGraphInput,
  getNodeInput,
  getNeighborsInput,
  getCommunityInput,
  godNodesInput,
  graphStatsInput,
  shortestPathInput,
  switchWorkspaceInput,
]);

export type KnowledgeInput = z.infer<typeof knowledgeInputSchema>;

/** Why the managed transport refused to start a knowledge child, with the exact capability
 * evidence behind the decision. Present only when no child was started. */
export type KnowledgeTransportRefusal = {
  operation: CliOperation;
  state: OperationCapability["state"];
  reason: string;
  argvPrefix: string[] | null;
  /** Absolute paths of the retained bounded-help bytes that produced `reason`. */
  evidence: string[];
};

/** The CLI's own report that its knowledge server has no graph/workspace to serve. */
export type KnowledgeDataGap = {
  available: false;
  reason: string;
  remediation: string;
  source: "pico-cli knowledge server";
};

export type KnowledgeResult = (
  | {
      status: "ok";
      action: KnowledgeAction;
      text: string;
      truncated: boolean;
      remoteError: false;
    }
  | {
      status: "error";
      action: KnowledgeAction;
      error: string;
      truncated: boolean;
      remoteError: true;
    }
  | {
      status: "unavailable";
      action: KnowledgeAction;
      error: string;
      truncated?: boolean;
      remoteError?: true;
    }
) & {
  picoCli?: PicoCliProvenance;
  failureClass?: PicoCliFailureClass;
  setupCommand?: { path: string; args: string[] };
  outputTail?: string;
  outputTruncated?: boolean;
  lifecycleWarning?: string;
  transport?: KnowledgeTransportRefusal;
  knowledgeData?: KnowledgeDataGap;
};

export type KnowledgeBridgeOptions = {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
  retirementTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Hermetic process-table/signal seam. Production callers must leave this unset. */
  processControl?: KnowledgeProcessControl;
};

export type KnowledgeProcessIdentity = {
  pid: number;
  parentPid: number;
  /** Immutable process birth identity. Production uses the OS-reported process start time. */
  birthIdentity: string;
  /** Process command plus environment, retained only in-memory for exact generation-token matching. */
  command: string;
};

export type KnowledgeProcessScanPurpose =
  | "capture-root"
  | "discover-generation"
  | "validate-signal"
  | "observe-retirement";

export type KnowledgeProcessScanRequest = {
  rootPid: number | null;
  ownershipToken: string;
  deadlineMs: number;
  purpose: KnowledgeProcessScanPurpose;
  expectedIdentity?: Pick<KnowledgeProcessIdentity, "pid" | "birthIdentity">;
};

export type KnowledgeProcessTableScan = {
  available: boolean;
  records: KnowledgeProcessIdentity[];
  reason?: string;
};

export type KnowledgeProcessSignalResult = {
  delivered: boolean;
  missing?: boolean;
  reason?: string;
};

export type KnowledgeDirectChildState = "live" | "exited" | "unavailable";

export type KnowledgeProcessControl = {
  platform: NodeJS.Platform;
  scanPosix: (request: KnowledgeProcessScanRequest) => KnowledgeProcessTableScan | Promise<KnowledgeProcessTableScan>;
  /** Raw single-PID signal. Production calls this only after a fresh birth-identity match. */
  signalPosix: (pid: number, signal: NodeJS.Signals) => KnowledgeProcessSignalResult;
  /** Hermetic mutation seam; production ownership comes from the exact SDK ChildProcess handle. */
  inspectRootProcess?: (pid: number) => KnowledgeDirectChildState;
};

type OwnedProcessIdentity = Pick<KnowledgeProcessIdentity, "pid" | "birthIdentity">;

type KnowledgeSession = {
  generation: number;
  commandPath: string;
  /** The exact argv this generation was spawned with; a different argv is a different identity. */
  commandArgs: string[];
  cliVersion: string | null;
  client: Client;
  transport: KnowledgeStdioClientTransport;
  fatal?: Error;
  intentionalClose: boolean;
  closed: boolean;
  closeObserved: Promise<void>;
  resolveCloseObserved: () => void;
  closePromise?: Promise<void>;
  ownershipToken: string;
  rootPid: number | null;
  rootIdentity: OwnedProcessIdentity | null;
  rootIdentityFailure?: string;
  childEnv: Record<string, string>;
  observedOwnedProcesses: Map<number, string>;
  processControl: KnowledgeProcessControl;
  executionTarget?: PicoCliExecutionTarget;
  executionGuards: PicoCliExecutionGuards;
  spawnAcquired: boolean;
  completionGuardRan: boolean;
  stderrTail: string;
  stderrTruncated: boolean;
  stderrClassificationTail: string;
  setupRequiredObserved: boolean;
};

class KnowledgeStartupError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
    readonly stderrTruncated: boolean,
    readonly setupRequiredObserved: boolean,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = "KnowledgeStartupError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isKnowledgeTimeout(error: unknown): boolean {
  if (error instanceof KnowledgeStartupError) return error.timedOut;
  if (error instanceof McpError) return error.code === ErrorCode.RequestTimeout;
  if (error && typeof error === "object" && (error as { code?: unknown }).code === ErrorCode.RequestTimeout) return true;
  return /\bMCP error -32001:\s*(?:Request timed out|Maximum total timeout exceeded)\b/i.test(errorMessage(error));
}

function productionKnowledgeEnvironment(): Record<string, string> {
  // The SDK's default stdio environment is intentionally sanitized, but this server's child needs
  // the complete host configuration (PICO_HOME, API keys, npm/PATH settings, proxies, etc.). Node's
  // process.env cannot contain NUL values; only omit the type-level undefined case.
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function appendUtf8Tail(existing: string, chunk: unknown, maxBytes: number): { text: string; truncated: boolean } {
  const combined = Buffer.concat([Buffer.from(existing, "utf8"), Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8")]);
  if (combined.length <= maxBytes) return { text: combined.toString("utf8"), truncated: false };
  let start = combined.length - maxBytes;
  while (start < combined.length && (combined[start] & 0b1100_0000) === 0b1000_0000) start++;
  return { text: combined.subarray(start).toString("utf8"), truncated: true };
}

/** Scan every bounded window while retaining only enough overlap for the measured refusal phrase
 * to cross chunk boundaries. The diagnostic tail may later evict that phrase; classification must
 * not be downgraded merely because newer stderr arrived. */
function scanSetupRequired(previousTail: string, chunk: unknown): { tail: string; observed: boolean } {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  let tail = previousTail;
  for (let offset = 0; offset < text.length; offset += 4_096) {
    const window = `${tail}${text.slice(offset, offset + 4_096)}`;
    if (classifyPicoCliFailure(window, "") === "setup-required") {
      return { tail: window.slice(-FAILURE_CLASSIFICATION_OVERLAP_CHARS), observed: true };
    }
    tail = window.slice(-FAILURE_CLASSIFICATION_OVERLAP_CHARS);
  }
  return { tail, observed: false };
}

function waitBounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type ProcessScan = {
  available: boolean;
  processes: OwnedProcessIdentity[];
  reason?: string;
};

type RetirementOutcome = {
  confirmed: boolean;
  /** True means a prior process may still be alive, so a replacement generation is forbidden. */
  overlapPossible: boolean;
  reason?: string;
};

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function runExecutionGuard(
  guard: ((deadlineMs: number) => string | null) | undefined,
  deadlineMs: number,
  phase: "pre-spawn" | "post-spawn" | "post-completion",
): string | null {
  if (!guard) return null;
  try {
    const failure = guard(deadlineMs);
    if (failure) return `${phase} managed pico-cli validation failed: ${failure}`;
    return Date.now() >= deadlineMs
      ? `${phase} managed pico-cli validation exhausted its shared deadline`
      : null;
  } catch (error) {
    return `${phase} managed pico-cli validation failed: ${errorMessage(error)}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function posixPsPath(): string | null {
  if (process.platform === "win32") return null;
  return ["/bin/ps", "/usr/bin/ps"].find((candidate) => fs.existsSync(candidate)) ?? null;
}

function hasExactEnvironmentAssignment(details: string, assignment: string): boolean {
  let offset = details.indexOf(assignment);
  while (offset >= 0) {
    const before = offset === 0 || /\s/.test(details[offset - 1]);
    const end = offset + assignment.length;
    const after = end === details.length || /\s/.test(details[end]);
    if (before && after) return true;
    offset = details.indexOf(assignment, offset + 1);
  }
  return false;
}

async function productionPosixProcessTable(request: KnowledgeProcessScanRequest): Promise<KnowledgeProcessTableScan> {
  if (process.platform === "win32") {
    return { available: false, records: [], reason: "POSIX process birth identity is unavailable on Windows" };
  }
  const psPath = posixPsPath();
  if (!psPath) return { available: false, records: [], reason: "no bounded POSIX ps executable was available" };
  const budgetMs = Math.min(PROCESS_SCAN_TIMEOUT_MS, remainingMs(request.deadlineMs));
  if (budgetMs <= 0) return { available: false, records: [], reason: "generation process scan deadline was exhausted" };
  let result: Awaited<ReturnType<typeof runPicoCliCommand>>;
  try {
    result = await runPicoCliCommand(psPath, ["eww", "-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "command="], {
      timeoutMs: budgetMs,
      killGraceMs: Math.min(25, budgetMs),
      maxOutputBytes: PROCESS_SCAN_MAX_OUTPUT_BYTES,
      baseEnv: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
    });
  } catch (error) {
    return { available: false, records: [], reason: `bounded POSIX process scan failed: ${errorMessage(error)}` };
  }
  if (result.spawnError || result.timedOut || result.outputTruncated || result.code !== 0) {
    return { available: false, records: [], reason: "bounded POSIX process scan did not complete" };
  }

  const records: KnowledgeProcessIdentity[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
    if (!match) {
      return { available: false, records: [], reason: "bounded POSIX process scan returned an unparseable birth-identity row" };
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (!Number.isSafeInteger(parentPid) || parentPid < 0) {
      return { available: false, records: [], reason: "bounded POSIX process scan returned an invalid parent PID" };
    }
    records.push({
      pid,
      parentPid,
      birthIdentity: match[3].replace(/\s+/g, " ").trim(),
      command: match[4],
    });
  }
  return { available: true, records };
}

function productionPosixSignal(pid: number, signal: NodeJS.Signals): KnowledgeProcessSignalResult {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) {
    return { delivered: false, reason: "refused an invalid or host-owned PID" };
  }
  try {
    process.kill(pid, signal);
    return { delivered: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return { delivered: false, missing: true };
    return { delivered: false, reason: `single-PID ${signal} failed: ${errorMessage(error)}` };
  }
}

const productionProcessControl: KnowledgeProcessControl = {
  platform: process.platform,
  scanPosix: productionPosixProcessTable,
  signalPosix: productionPosixSignal,
};

function normalizedProcessTable(scan: KnowledgeProcessTableScan): KnowledgeProcessTableScan {
  if (!scan || scan.available !== true || !Array.isArray(scan.records)) {
    return {
      available: false,
      records: [],
      reason: scan?.reason ?? "process-table provider did not return an available record set",
    };
  }
  const byPid = new Map<number, KnowledgeProcessIdentity>();
  let retainedBytes = 0;
  for (const record of scan.records) {
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 1
      || !Number.isSafeInteger(record.parentPid) || record.parentPid < 0
      || typeof record.birthIdentity !== "string" || record.birthIdentity.length === 0 || record.birthIdentity.length > 512
      || typeof record.command !== "string") {
      return { available: false, records: [], reason: "process-table provider returned an invalid birth-identity record" };
    }
    retainedBytes += Buffer.byteLength(record.birthIdentity, "utf8") + Buffer.byteLength(record.command, "utf8");
    if (retainedBytes > PROCESS_SCAN_MAX_OUTPUT_BYTES) {
      return { available: false, records: [], reason: "process-table provider exceeded the bounded retained-byte limit" };
    }
    if (byPid.has(record.pid)) {
      return { available: false, records: [], reason: "process-table provider returned duplicate PIDs" };
    }
    byPid.set(record.pid, record);
  }
  return { available: true, records: [...byPid.values()] };
}

async function readProcessTable(
  session: KnowledgeSession,
  purpose: KnowledgeProcessScanPurpose,
  deadlineMs: number,
  expectedIdentity?: OwnedProcessIdentity,
): Promise<KnowledgeProcessTableScan> {
  if (session.processControl.platform === "win32") {
    return { available: false, records: [], reason: "process birth identity is not implemented on native Windows" };
  }
  const budgetMs = Math.min(PROCESS_SCAN_TIMEOUT_MS, remainingMs(deadlineMs));
  if (budgetMs <= 0) {
    return { available: false, records: [], reason: "process-table validation deadline was exhausted" };
  }
  try {
    const scan = Promise.resolve(session.processControl.scanPosix({
        rootPid: session.rootPid,
        ownershipToken: session.ownershipToken,
        deadlineMs,
        purpose,
        ...(expectedIdentity ? { expectedIdentity } : {}),
      }));
    return normalizedProcessTable(await waitBounded(
      scan,
      budgetMs,
      `bounded process-table provider did not settle within ${budgetMs}ms`,
    ));
  } catch (error) {
    return { available: false, records: [], reason: `process-table provider failed: ${errorMessage(error)}` };
  }
}

async function captureRootIdentity(session: KnowledgeSession, deadlineMs: number): Promise<void> {
  if (session.rootPid === null || !Number.isSafeInteger(session.rootPid) || session.rootPid <= 1) {
    session.rootIdentityFailure = "the generation root PID was not acquired";
    return;
  }
  const table = await readProcessTable(session, "capture-root", deadlineMs);
  if (!table.available) {
    session.rootIdentityFailure = table.reason ?? "the generation root birth identity could not be read";
    return;
  }
  const root = table.records.find((record) => record.pid === session.rootPid);
  if (!root) {
    session.rootIdentityFailure = "the spawned generation root was absent from the birth-identity snapshot";
    return;
  }
  const directChildState = exactRootProcessState(session, session.rootPid);
  if (directChildState !== "live") {
    session.rootIdentityFailure = directChildState === "exited"
      ? "the exact spawned root exited before its OS birth identity could be bound"
      : "the exact spawned root handle could not be matched while binding its OS birth identity";
    return;
  }
  session.rootIdentity = { pid: root.pid, birthIdentity: root.birthIdentity };
}

function exactRootProcessState(session: KnowledgeSession, pid: number): KnowledgeDirectChildState {
  try {
    const state = session.processControl.inspectRootProcess?.(pid) ?? session.transport.exactChildState(pid);
    return state === "live" || state === "exited" ? state : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Locate only this generation's exact process identities. The captured transport root remains
 * attributable if a wrapper removes the random environment token; token matching retains detached
 * descendants after reparenting. Numeric PIDs are never treated as ownership on their own. */
async function scanPosixGeneration(
  session: KnowledgeSession,
  deadlineMs: number,
  purpose: "discover-generation" | "observe-retirement",
): Promise<ProcessScan> {
  if (!KNOWLEDGE_GENERATION_TOKEN_PATTERN.test(session.ownershipToken)) {
    return { available: false, processes: [], reason: "generation ownership token was invalid" };
  }
  if (!session.rootIdentity) {
    return {
      available: false,
      processes: [],
      reason: session.rootIdentityFailure ?? "generation root birth identity was not captured",
    };
  }
  const table = await readProcessTable(session, purpose, deadlineMs);
  if (!table.available) return { available: false, processes: [], reason: table.reason };

  const assignment = `${KNOWLEDGE_GENERATION_TOKEN_ENV}=${session.ownershipToken}`;
  const recordsByPid = new Map(table.records.map((record) => [record.pid, record]));
  const byParent = new Map<number, KnowledgeProcessIdentity[]>();
  for (const record of table.records) {
    const children = byParent.get(record.parentPid) ?? [];
    children.push(record);
    byParent.set(record.parentPid, children);
  }
  const owned = new Map<number, KnowledgeProcessIdentity>();
  const retain = (record: KnowledgeProcessIdentity) => {
    if (record.pid === process.pid || record.pid === process.ppid) return;
    owned.set(record.pid, record);
  };

  const currentRoot = recordsByPid.get(session.rootIdentity.pid);
  const directRootState = exactRootProcessState(session, session.rootIdentity.pid);
  if (directRootState === "unavailable") {
    return { available: false, processes: [], reason: "the exact generation root handle state could not be observed" };
  }
  if (directRootState === "live") {
    if (!currentRoot || currentRoot.birthIdentity !== session.rootIdentity.birthIdentity) {
      return {
        available: false,
        processes: [],
        reason: "the live exact generation root conflicted with its OS birth-identity row",
      };
    }
    retain(currentRoot);
  }
  for (const [pid, birthIdentity] of session.observedOwnedProcesses) {
    if (pid === session.rootIdentity.pid) continue;
    const current = recordsByPid.get(pid);
    if (current?.birthIdentity === birthIdentity) retain(current);
  }
  for (const record of table.records) {
    if (record.pid === session.rootIdentity.pid) continue;
    if (hasExactEnvironmentAssignment(record.command, assignment)) retain(record);
  }

  const queue = [...owned.values()];
  const walked = new Set(queue.map((record) => record.pid));
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent.pid) ?? []) {
      if (walked.has(child.pid)) continue;
      walked.add(child.pid);
      retain(child);
      queue.push(child);
      if (owned.size > PROCESS_SCAN_MAX_MATCHES) {
        return { available: false, processes: [], reason: `generation process tree exceeded ${PROCESS_SCAN_MAX_MATCHES} identities` };
      }
    }
  }
  if (owned.size > PROCESS_SCAN_MAX_MATCHES) {
    return { available: false, processes: [], reason: `generation process scan exceeded ${PROCESS_SCAN_MAX_MATCHES} exact owners` };
  }
  return {
    available: true,
    processes: [...owned.values()].map(({ pid, birthIdentity }) => ({ pid, birthIdentity })),
  };
}

function rememberOwnedProcesses(session: KnowledgeSession, scan: ProcessScan): void {
  if (!scan.available) return;
  for (const processIdentity of scan.processes) {
    session.observedOwnedProcesses.set(processIdentity.pid, processIdentity.birthIdentity);
  }
}

async function signalExactProcess(
  session: KnowledgeSession,
  expected: OwnedProcessIdentity,
  signal: NodeJS.Signals,
  deadlineMs: number,
): Promise<{ settled: boolean; reason?: string }> {
  const table = await readProcessTable(session, "validate-signal", deadlineMs, expected);
  if (!table.available) return { settled: false, reason: table.reason };
  const current = table.records.find((record) => record.pid === expected.pid);
  // Missing means the original exited. A mismatched birth identity is PID reuse: never signal it.
  if (!current || current.birthIdentity !== expected.birthIdentity) return { settled: true };
  const isRoot = session.rootIdentity?.pid === expected.pid
    && session.rootIdentity.birthIdentity === expected.birthIdentity;
  if (isRoot) {
    const directChildState = exactRootProcessState(session, expected.pid);
    if (directChildState === "exited") return { settled: true };
    if (directChildState !== "live") {
      return { settled: false, reason: "the exact generation root handle could not be revalidated before signalling" };
    }
  } else {
    const assignment = `${KNOWLEDGE_GENERATION_TOKEN_ENV}=${session.ownershipToken}`;
    if (!hasExactEnvironmentAssignment(current.command, assignment)) {
      return {
        settled: false,
        reason: `generation-token ownership could not be revalidated for descendant PID ${expected.pid}`,
      };
    }
  }
  let result: KnowledgeProcessSignalResult;
  try {
    result = session.processControl.signalPosix(expected.pid, signal);
  } catch (error) {
    return { settled: false, reason: `single-PID ${signal} provider failed: ${errorMessage(error)}` };
  }
  if (result.delivered || result.missing) return { settled: true };
  return { settled: false, reason: result.reason ?? `single-PID ${signal} was not delivered` };
}

async function signalGeneration(
  session: KnowledgeSession,
  scan: ProcessScan,
  signal: NodeJS.Signals,
  deadlineMs: number,
): Promise<{ settled: boolean; reason?: string }> {
  for (const processIdentity of [...scan.processes].sort((left, right) => right.pid - left.pid)) {
    const outcome = await signalExactProcess(session, processIdentity, signal, deadlineMs);
    if (!outcome.settled) return outcome;
  }
  return { settled: true };
}

async function requestExactChildEof(
  session: KnowledgeSession,
  deadlineMs: number,
): Promise<string | null> {
  const requestFailure = session.transport.requestGracefulEof();
  if (requestFailure) return requestFailure;
  if (session.rootPid === null) return "the exact generation root PID was unavailable after requesting EOF";

  const eofDeadline = Math.min(deadlineMs, Date.now() + NATURAL_RETIREMENT_GRACE_MS);
  let state = exactRootProcessState(session, session.rootPid);
  while (state === "live" && remainingMs(eofDeadline) > 0) {
    await delay(Math.min(20, remainingMs(eofDeadline)));
    state = exactRootProcessState(session, session.rootPid);
  }
  if (state === "exited") return null;
  return state === "unavailable"
    ? "the exact generation root handle could not be observed after requesting EOF"
    : "the exact generation root did not exit during the bounded EOF grace period";
}

async function terminatePosixGeneration(
  session: KnowledgeSession,
  deadlineMs: number,
  initialScan: ProcessScan,
): Promise<RetirementOutcome> {
  let scan = initialScan;
  if (!scan.available) {
    return { confirmed: false, overlapPossible: true, reason: scan.reason };
  }
  if (scan.processes.length === 0) return { confirmed: true, overlapPossible: false };

  scan = await scanPosixGeneration(session, deadlineMs, "observe-retirement");
  rememberOwnedProcesses(session, scan);
  if (!scan.available) return { confirmed: false, overlapPossible: true, reason: scan.reason };
  const term = await signalGeneration(session, scan, "SIGTERM", deadlineMs);
  if (!term.settled) return { confirmed: false, overlapPossible: true, reason: term.reason };
  const gracefulDeadline = Math.min(deadlineMs, Date.now() + Math.min(NATURAL_RETIREMENT_GRACE_MS, Math.ceil(remainingMs(deadlineMs) / 2)));
  while (remainingMs(gracefulDeadline) > 0) {
    await delay(Math.min(20, remainingMs(gracefulDeadline)));
    scan = await scanPosixGeneration(session, deadlineMs, "observe-retirement");
    rememberOwnedProcesses(session, scan);
    if (!scan.available) {
      return { confirmed: false, overlapPossible: true, reason: scan.reason };
    }
    if (scan.processes.length === 0) return { confirmed: true, overlapPossible: false };
  }

  scan = await scanPosixGeneration(session, deadlineMs, "observe-retirement");
  rememberOwnedProcesses(session, scan);
  if (!scan.available) {
    return { confirmed: false, overlapPossible: true, reason: scan.reason };
  }
  const kill = await signalGeneration(session, scan, "SIGKILL", deadlineMs);
  if (!kill.settled) return { confirmed: false, overlapPossible: true, reason: kill.reason };
  while (remainingMs(deadlineMs) > 0) {
    await delay(Math.min(20, remainingMs(deadlineMs)));
    scan = await scanPosixGeneration(session, deadlineMs, "observe-retirement");
    rememberOwnedProcesses(session, scan);
    if (!scan.available) return { confirmed: false, overlapPossible: true, reason: scan.reason };
    if (scan.processes.length === 0) return { confirmed: true, overlapPossible: false };
  }
  return {
    confirmed: false,
    overlapPossible: true,
    reason: `generation ${session.generation} still had ${scan.processes.length} birth-bound process(es) at the retirement deadline`,
  };
}

function finishRetirementValidation(
  session: KnowledgeSession,
  deadlineMs: number,
  outcome: RetirementOutcome,
): RetirementOutcome {
  if (!session.spawnAcquired || session.completionGuardRan) return outcome;
  session.completionGuardRan = true;
  const failure = runExecutionGuard(session.executionGuards.afterCompletion, deadlineMs, "post-completion");
  return failure
    ? {
        confirmed: false,
        overlapPossible: outcome.overlapPossible,
        reason: outcome.reason ? `${outcome.reason}; ${failure}` : failure,
      }
    : outcome;
}

async function retireKnowledgeGeneration(
  session: KnowledgeSession,
  timeoutMs: number,
): Promise<RetirementOutcome> {
  const deadlineMs = Date.now() + Math.max(1, timeoutMs);
  // Capture ownership before asking the SDK to close: its transport deliberately drops its public
  // pid as soon as close begins, even when descendant-held stdio delays the close event.
  session.rootPid ??= session.transport.pid;
  let initialPosixScan: ProcessScan | null = null;
  if (session.processControl.platform !== "win32") {
    // Capture root ancestry before EOF can exit and reparent the root's children. This best-effort
    // snapshot lets later scans retain token-stripped descendants by birth identity. An unavailable
    // snapshot still proceeds to the exact-pipe EOF request, but can never authorize replacement.
    initialPosixScan = await scanPosixGeneration(session, deadlineMs, "discover-generation");
    rememberOwnedProcesses(session, initialPosixScan);
  }
  // EOF targets the already-open exact child pipe, so it is safe even when OS process identity is
  // unavailable. Give an EOF-responsive root a bounded chance to exit before any platform or
  // process-table early return; uncertainty still blocks replacement because descendants remain
  // unproved.
  const eofFailure = await requestExactChildEof(session, deadlineMs);
  if (session.processControl.platform === "win32") {
    return finishRetirementValidation(session, deadlineMs, {
      confirmed: false,
      overlapPossible: true,
      reason: [
        "native Windows process birth identity is not implemented; no numeric-PID signal was sent and replacement is blocked",
        eofFailure,
      ].filter(Boolean).join("; "),
    });
  }
  let outcome = await terminatePosixGeneration(session, deadlineMs, initialPosixScan!);
  if (!outcome.confirmed && eofFailure) {
    outcome = {
      ...outcome,
      reason: outcome.reason ? `${outcome.reason}; ${eofFailure}` : eofFailure,
    };
  }
  if (outcome.confirmed) {
    // Only after the birth-bound process set is proven empty may the SDK clear protocol state.
    // First remove its stale numeric child handle so a delayed SDK fallback cannot race PID reuse.
    const releaseFailure = session.transport.releaseConfirmedExitedProcess();
    if (releaseFailure) {
      return finishRetirementValidation(session, deadlineMs, {
        confirmed: false,
        overlapPossible: false,
        reason: releaseFailure,
      });
    }
    const clientClose = session.client.close().catch(() => undefined);
    await Promise.race([
      clientClose,
      delay(Math.min(100, Math.max(1, remainingMs(deadlineMs)))),
    ]);
  }
  return finishRetirementValidation(session, deadlineMs, outcome);
}

function knowledgeTransportRefusal(capability: OperationCapability): KnowledgeTransportRefusal {
  return {
    operation: capability.operation,
    state: capability.state,
    reason: capability.reason,
    argvPrefix: capability.argvPrefix ? [...capability.argvPrefix] : null,
    evidence: capability.evidence.flatMap((observation) => [observation.stdoutPath, observation.stderrPath]),
  };
}

/** The CLI's own "this server has no graph to serve" answer, or null for any other tool error. */
function knowledgeDataGap(text: string): KnowledgeDataGap | null {
  const match = KNOWLEDGE_DATA_UNAVAILABLE_PATTERN.exec(text.trim());
  if (!match) return null;
  return { available: false, reason: match[1], remediation: match[2], source: "pico-cli knowledge server" };
}

type ManagedTransportResolution =
  | {
      status: "ok";
      commandPath: string;
      commandArgs: string[];
      cliVersion: string | null;
      executionTarget: PicoCliExecutionTarget;
      provenance: PicoCliProvenance;
    }
  | { status: "unresolved"; note: string; failureClass?: PicoCliFailureClass }
  | {
      status: "refused";
      note: string;
      failureClass: PicoCliFailureClass;
      provenance: PicoCliProvenance;
      refusal: KnowledgeTransportRefusal;
      setupCommand?: { path: string; args: string[] };
    };

export class KnowledgeBridge {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly provisionDefaultPicoCli: boolean;
  private readonly configuredArgs: boolean;
  private readonly startupTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly retirementTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly processControl: KnowledgeProcessControl;
  private generation = 0;
  private current?: KnowledgeSession;
  private starting?: KnowledgeSession;
  private startupPromise?: Promise<KnowledgeSession>;
  private resetBarrier: Promise<void> = Promise.resolve();
  private queue: Promise<void> = Promise.resolve();
  private lifecycleWarning?: string;
  private lifecycleBlock?: string;

  constructor(options: KnowledgeBridgeOptions = {}) {
    this.command = options.command ?? DEFAULT_KNOWLEDGE_COMMAND;
    this.args = [...(options.args ?? DEFAULT_KNOWLEDGE_ARGS)];
    this.cwd = options.cwd;
    // Supplying a command is the injection/custom-command seam used by tests and alternate
    // providers. Only the production default pico-cli command participates in MCP provisioning.
    this.provisionDefaultPicoCli = options.command === undefined;
    // Explicitly configured argv keeps its exact existing behavior: it is spawned as given and
    // never replaced by, or checked against, the resolved CLI's capability evidence.
    this.configuredArgs = options.args !== undefined;
    // Leave production env unresolved until spawn time so current host configuration reaches the
    // managed child. The command itself is always the resolved absolute managed path.
    this.env = options.env ? { ...productionKnowledgeEnvironment(), ...options.env } : undefined;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.retirementTimeoutMs = options.retirementTimeoutMs ?? DEFAULT_RETIREMENT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.processControl = options.processControl ?? productionProcessControl;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job, job);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private markFatal(session: KnowledgeSession, error: Error): void {
    if (session.intentionalClose || session.closed) return;
    session.fatal ??= error;
    void this.retire(session).catch(() => undefined);
  }

  private retire(session: KnowledgeSession): Promise<void> {
    if (session.closePromise) return session.closePromise;
    if (this.current === session) this.current = undefined;
    if (this.starting === session) this.starting = undefined;
    session.intentionalClose = true;
    const priorReset = this.resetBarrier;
    const retirementDeadlineMs = Date.now() + Math.max(1, this.retirementTimeoutMs);
    session.closePromise = (async () => {
      try {
        await waitBounded(
          priorReset,
          Math.max(1, remainingMs(retirementDeadlineMs)),
          `the prior spatial-knowledge retirement did not settle within ${this.retirementTimeoutMs}ms`,
        );
      } catch (error) {
        this.lifecycleWarning = `${errorMessage(error)}; the prior generation remains quarantined and replacement is blocked`;
        this.lifecycleBlock = this.lifecycleWarning;
      }
      try {
        const outcome = await retireKnowledgeGeneration(session, Math.max(1, remainingMs(retirementDeadlineMs)));
        if (!outcome.confirmed) {
          this.lifecycleWarning = `spatial-knowledge generation ${session.generation} retirement was not fully observed: ${outcome.reason ?? "unknown cleanup state"}; the generation is quarantined${outcome.overlapPossible ? " and replacement is blocked" : ""}`;
          if (outcome.overlapPossible) this.lifecycleBlock = this.lifecycleWarning;
        }
      } catch (error) {
        this.lifecycleWarning = `spatial-knowledge generation ${session.generation} retirement failed boundedly: ${errorMessage(error)}; the generation is quarantined and replacement is blocked`;
        this.lifecycleBlock = this.lifecycleWarning;
      }
    })();
    // A close event held open by descendant-owned stdio must never make close() itself unbounded.
    // The attempt settles, but an unproved process retirement poisons replacement explicitly so
    // two knowledge generations can never overlap behind a reassuring warning.
    this.resetBarrier = session.closePromise.then(() => undefined, () => undefined);
    return session.closePromise;
  }

  private async ensureStarted(
    commandPath: string,
    commandArgs: string[],
    cliVersion: string | null,
    executionTarget?: PicoCliExecutionTarget,
  ): Promise<KnowledgeSession> {
    if (this.lifecycleBlock) {
      throw new Error(`spatial-knowledge replacement is blocked: ${this.lifecycleBlock}`);
    }
    const sameIdentity = (session: KnowledgeSession) =>
      session.commandPath === commandPath
      && session.commandArgs.length === commandArgs.length
      && session.commandArgs.every((argument, index) => argument === commandArgs[index])
      && session.cliVersion === cliVersion
      && session.executionTarget?.source === executionTarget?.source;
    if (this.current && !this.current.fatal && !this.current.closed && sameIdentity(this.current)) return this.current;
    if (this.current) await this.retire(this.current);
    if (this.starting && !sameIdentity(this.starting)) await this.retire(this.starting);
    if (this.startupPromise) return this.startupPromise;
    await waitBounded(
      this.resetBarrier,
      this.retirementTimeoutMs,
      `previous spatial-knowledge process close was not observed within ${this.retirementTimeoutMs}ms`,
    );
    if (this.lifecycleBlock) {
      throw new Error(`spatial-knowledge replacement is blocked: ${this.lifecycleBlock}`);
    }

    const ownershipToken = `${process.pid}-${randomBytes(24).toString("hex")}`;
    const executionGuards = executionTarget ? picoCliExecutionGuards(executionTarget) : {};
    const childEnv = {
      ...(this.env ?? productionKnowledgeEnvironment()),
      [KNOWLEDGE_GENERATION_TOKEN_ENV]: ownershipToken,
    };
    const transport = new KnowledgeStdioClientTransport({
      command: commandPath,
      args: commandArgs,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      env: childEnv,
      stderr: "pipe",
    });
    const client = new Client({ name: "pico-spatial-mcp-knowledge", version: "1.0.0" });
    let resolveCloseObserved!: () => void;
    const closeObserved = new Promise<void>((resolve) => {
      resolveCloseObserved = resolve;
    });
    const session: KnowledgeSession = {
      generation: ++this.generation,
      commandPath,
      commandArgs: [...commandArgs],
      cliVersion,
      client,
      transport,
      intentionalClose: false,
      closed: false,
      closeObserved,
      resolveCloseObserved,
      ownershipToken,
      rootPid: null,
      rootIdentity: null,
      childEnv,
      observedOwnedProcesses: new Map(),
      processControl: this.processControl,
      ...(executionTarget ? { executionTarget } : {}),
      executionGuards,
      spawnAcquired: false,
      completionGuardRan: false,
      stderrTail: "",
      stderrTruncated: false,
      stderrClassificationTail: "",
      setupRequiredObserved: false,
    };
    transport.stderr?.on("data", (chunk) => {
      if (!session.setupRequiredObserved) {
        const classified = scanSetupRequired(session.stderrClassificationTail, chunk);
        session.stderrClassificationTail = classified.tail;
        session.setupRequiredObserved = classified.observed;
      }
      const capped = appendUtf8Tail(session.stderrTail, chunk, MAX_STARTUP_STDERR_BYTES);
      session.stderrTail = capped.text;
      session.stderrTruncated ||= capped.truncated;
    });
    this.starting = session;
    client.onerror = (error) => this.markFatal(session, error);
    client.onclose = () => {
      if (!session.intentionalClose) this.markFatal(session, new Error("spatial-knowledge connection closed"));
      session.closed = true;
      session.resolveCloseObserved();
    };

    let startup!: Promise<KnowledgeSession>;
    startup = (async () => {
      try {
        const startupDeadlineMs = Date.now() + Math.max(1, this.startupTimeoutMs);
        const beforeSpawnFailure = runExecutionGuard(executionGuards.beforeSpawn, startupDeadlineMs, "pre-spawn");
        if (beforeSpawnFailure) throw new Error(beforeSpawnFailure);
        const connection = client.connect(transport, {
          timeout: this.startupTimeoutMs,
          maxTotalTimeout: this.startupTimeoutMs,
        });
        // Root birth-identity capture is asynchronous. Mark an early connection rejection handled
        // immediately, then still await the original promise below so the startup result is not
        // swallowed while the process-table request is in flight.
        void connection.catch(() => undefined);
        // StdioClientTransport assigns its ChildProcess synchronously before connect first yields.
        // Preserve the PID because transport.close() intentionally clears the public value before
        // descendant-held pipes have necessarily closed.
        session.rootPid = transport.pid;
        session.spawnAcquired = session.rootPid !== null;
        await captureRootIdentity(session, startupDeadlineMs);
        if (executionGuards.afterSpawn && !session.spawnAcquired) {
          void connection.catch(() => undefined);
          throw new Error("post-spawn managed pico-cli validation could not run because no child PID was acquired");
        }
        const afterSpawnFailure = runExecutionGuard(executionGuards.afterSpawn, startupDeadlineMs, "post-spawn");
        if (afterSpawnFailure) {
          void connection.catch(() => undefined);
          throw new Error(afterSpawnFailure);
        }
        await connection;
        if (session.fatal) throw session.fatal;
        if (session.closed || this.starting !== session) {
          throw new Error(`spatial-knowledge generation ${session.generation} closed during startup`);
        }
        this.starting = undefined;
        this.current = session;
        return session;
      } catch (error) {
        const cause = session.fatal ?? (error instanceof Error ? error : new Error(String(error)));
        session.fatal ??= cause;
        await this.retire(session);
        throw new KnowledgeStartupError(
          errorMessage(cause),
          session.stderrTail,
          session.stderrTruncated,
          session.setupRequiredObserved,
          isKnowledgeTimeout(cause),
        );
      } finally {
        if (this.startupPromise === startup) this.startupPromise = undefined;
      }
    })();
    this.startupPromise = startup;
    return startup;
  }

  /**
   * Resolve the managed CLI and the exact argv its own bounded help evidence proves for the
   * knowledge MCP server. A child is started only for a `supported` capability whose whole
   * recorded identity still matches the resolved execution target — `picoCliOperationCapability`
   * re-derives that identity and re-verifies the retained help bytes on every call, so a replaced
   * or updated package can never dispatch the previous line's route. Anything else is a structured
   * refusal: no spawn, and no other command alias is attempted.
   *
   * `configuredArgv` is the explicit-configuration escape hatch: it is spawned exactly as given,
   * without capability selection, which is the behavior such callers already had.
   */
  private async resolveManagedTransport(configuredArgv: string[] | null): Promise<ManagedTransportResolution> {
    let ensured = await ensurePicoCli();
    if (ensured.status !== "ok") {
      return { status: "unresolved", note: ensured.note, ...(ensured.failureClass ? { failureClass: ensured.failureClass } : {}) };
    }
    let target = picoCliFromEnsure(ensured);
    let capability = target && !configuredArgv ? picoCliOperationCapability(target, KNOWLEDGE_OPERATION) : null;
    if (!target || (capability !== null && capability.state === "unknown" && capabilityNeedsFreshDiscovery(capability.reason))) {
      // Starting the knowledge child is itself a real CLI-backed operation, so one bounded
      // discovery is allowed here. It runs at most once per call, and only when no usable evidence
      // is bound to this target; a classified `unknown` is evidence and is never re-probed.
      const rediscovered = await ensurePicoCli({ forceRefresh: true });
      if (rediscovered.status === "ok") {
        const rediscoveredTarget = picoCliFromEnsure(rediscovered);
        if (rediscoveredTarget) {
          ensured = rediscovered;
          target = rediscoveredTarget;
          capability = configuredArgv ? null : picoCliOperationCapability(rediscoveredTarget, KNOWLEDGE_OPERATION);
        }
      } else if (!target) {
        return {
          status: "unresolved",
          note: rediscovered.note,
          ...(rediscovered.failureClass ? { failureClass: rediscovered.failureClass } : {}),
        };
      }
    }
    if (!target) {
      return {
        status: "unresolved",
        note: `The resolved managed pico-cli at ${ensured.path} could not be bound to a validated execution target, so no knowledge server was started.`,
        failureClass: "cli-unusable",
      };
    }
    const provenance = picoCliProvenance(ensured);
    if (configuredArgv) {
      return { status: "ok", commandPath: ensured.path, commandArgs: [...configuredArgv], cliVersion: ensured.version, executionTarget: target, provenance };
    }
    if (!capability || capability.state !== "supported" || !capability.argvPrefix || capability.argvPrefix.length === 0) {
      const refused = capability
        ?? unknownCapability(KNOWLEDGE_OPERATION, "no-discovery: no knowledge-server capability was resolved for this execution target");
      const failureClass = capabilityFailureClass(refused);
      // Named operation: without it the remedy is worded as a PROFILER-payload problem, which a
      // knowledge-server refusal is not.
      const environmentGuidance = failureClass === "environment" ? describePicoCliEnvironmentFailure(refused.reason, "", KNOWLEDGE_OPERATION) : null;
      return {
        status: "refused",
        provenance,
        failureClass,
        refusal: knowledgeTransportRefusal(refused),
        note: `knowledge transport unavailable: the resolved pico-cli ${ensured.version ?? "of unknown version"} at ${ensured.path} `
          + `is not proven to expose the knowledge MCP server (${refused.state}: ${refused.reason}). `
          + "No knowledge server was started and no command alias was retried."
          + (environmentGuidance ? ` ${environmentGuidance}` : ""),
        ...(failureClass === "setup-required" ? { setupCommand: { path: ensured.path, args: ["setup"] } } : {}),
      };
    }
    return {
      status: "ok",
      commandPath: ensured.path,
      commandArgs: [...capability.argvPrefix],
      cliVersion: ensured.version,
      executionTarget: target,
      provenance,
    };
  }

  call(action: KnowledgeAction, input: unknown): Promise<KnowledgeResult> {
    let parsed: KnowledgeInput;
    try {
      const fields = input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      parsed = knowledgeInputSchema.parse({ ...fields, action });
    } catch (error) {
      return Promise.resolve({
        status: "unavailable",
        action,
        error: `invalid knowledge input: ${errorMessage(error)}`,
      });
    }

    const { action: parsedAction, ...argumentsForRemote } = parsed;
    return this.enqueue(async () => {
      let session: KnowledgeSession | undefined;
      let provenance: PicoCliProvenance | null = null;
      const withProvenance = (result: KnowledgeResult): KnowledgeResult =>
        ({
          ...result,
          ...(provenance ? { picoCli: provenance } : {}),
          ...(this.lifecycleWarning ? { lifecycleWarning: this.lifecycleWarning } : {}),
        });
      try {
        let commandPath = this.command;
        let commandArgs = [...this.args];
        let cliVersion: string | null = null;
        let executionTarget: PicoCliExecutionTarget | undefined;
        if (this.provisionDefaultPicoCli) {
          const resolution = await this.resolveManagedTransport(this.configuredArgs ? [...this.args] : null);
          if (resolution.status !== "ok") {
            if (resolution.status === "refused") provenance = resolution.provenance;
            if (this.current) await this.retire(this.current);
            if (this.starting) await this.retire(this.starting);
            return withProvenance({
              status: "unavailable",
              action: parsedAction,
              error: resolution.note,
              ...(resolution.failureClass ? { failureClass: resolution.failureClass } : {}),
              ...(resolution.status === "refused" ? { transport: resolution.refusal } : {}),
              ...(resolution.status === "refused" && resolution.setupCommand ? { setupCommand: resolution.setupCommand } : {}),
            });
          }
          executionTarget = resolution.executionTarget;
          commandPath = resolution.commandPath;
          commandArgs = resolution.commandArgs;
          cliVersion = resolution.cliVersion;
          provenance = resolution.provenance;
        }
        session = await this.ensureStarted(commandPath, commandArgs, cliVersion, executionTarget);
        const response = await session.client.callTool(
          { name: parsedAction, arguments: argumentsForRemote },
          undefined,
          { timeout: this.callTimeoutMs, maxTotalTimeout: this.callTimeoutMs },
        );
        if (session.fatal) throw session.fatal;
        const content = Array.isArray(response.content)
          ? response.content as Array<{ type: string; text?: string }>
          : [];
        const joined = content
          .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n") || (response.isError === true ? `${parsedAction} returned an MCP tool error` : "");
        const capped = capUtf8(joined, this.maxOutputBytes);
        const providerTextError = joined.startsWith(`Error executing ${parsedAction}:`);
        const dataGap = response.isError === true ? knowledgeDataGap(joined) : null;
        if (dataGap) {
          // The CLI's own degraded knowledge server: it started and answered, but has no graph or
          // workspace to serve. Its reason and remediation are reported verbatim; this is not a
          // transport failure, and it establishes nothing about the graph API or SDK declarations.
          return withProvenance({
            status: "unavailable",
            action: parsedAction,
            error: capped.text,
            truncated: capped.truncated,
            remoteError: true,
            knowledgeData: dataGap,
          });
        }
        if ((response.isError === true || providerTextError) && /\bGraph file not found:/i.test(joined)) {
          return withProvenance({
            status: "unavailable",
            action: parsedAction,
            error: capped.text,
            truncated: capped.truncated,
            remoteError: true,
          });
        }
        if (response.isError === true || providerTextError) {
          return withProvenance({
            status: "error",
            action: parsedAction,
            error: capped.text,
            truncated: capped.truncated,
            remoteError: true,
          });
        }
        return withProvenance({
          status: "ok",
          action: parsedAction,
          text: capped.text,
          truncated: capped.truncated,
          remoteError: false,
        });
      } catch (error) {
        if (session) await this.retire(session);
        const startupStderr = error instanceof KnowledgeStartupError ? error.stderrTail.trim() : "";
        const startupTruncated = error instanceof KnowledgeStartupError && error.stderrTruncated;
        const managedFailure = provenance && (
          error instanceof KnowledgeStartupError && error.setupRequiredObserved
            ? "setup-required"
            : isKnowledgeTimeout(error)
              ? "timeout"
              : classifyPicoCliFailure(startupStderr, errorMessage(error))
        );
        if (provenance && managedFailure === "setup-required") {
          return withProvenance({
            status: "unavailable",
            action: parsedAction,
            error: SETUP_REQUIRED_NOTE,
            failureClass: "setup-required",
            setupCommand: { path: provenance.path, args: ["setup"] },
            ...(startupStderr ? { outputTail: startupStderr } : {}),
            ...(startupTruncated ? { outputTruncated: true } : {}),
          });
        }
        const environmentGuidance = provenance && managedFailure === "environment"
          ? describePicoCliEnvironmentFailure(startupStderr, errorMessage(error), KNOWLEDGE_OPERATION)
          : null;
        if (environmentGuidance) {
          // The CLI read its environment before it could serve anything. The remedy names the
          // variable it read; provisioning is a separate question this never prescribes.
          return withProvenance({
            status: "unavailable",
            action: parsedAction,
            error: environmentGuidance,
            failureClass: "environment",
            ...(startupStderr ? { outputTail: startupStderr } : {}),
            ...(startupTruncated ? { outputTruncated: true } : {}),
          });
        }
        return withProvenance({
          status: "unavailable",
          action: parsedAction,
          error: errorMessage(error),
          ...(managedFailure ? { failureClass: managedFailure } : {}),
          ...(startupStderr ? { outputTail: startupStderr } : {}),
          ...(startupTruncated ? { outputTruncated: true } : {}),
        });
      }
    });
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      if (this.current) await this.retire(this.current);
      if (this.starting) await this.retire(this.starting);
    });
  }
}

export type KnowledgeCaller = Pick<KnowledgeBridge, "call">;
export const sharedKnowledgeBridge = new KnowledgeBridge();

export function registerKnowledgeTools(
  server: McpServer,
  bridge: KnowledgeBridge = sharedKnowledgeBridge,
): void {
  server.registerTool(
    "knowledge_api",
    {
      description:
        "Query PICO's persistent spatial-knowledge graph through the lazily resolved managed pico-cli absolute path. Exposes query_graph, get_node, get_neighbors, get_community, god_nodes, graph_stats, shortest_path, and switch_workspace. A changed managed path/version retires the old child before starting the new one. Graph answers are broad contextual evidence; use vault_api for authoritative exact SDK declarations and citations.",
      inputSchema: knowledgeInputSchema,
    },
    async (input) => {
      const parsed = knowledgeInputSchema.parse(input);
      const { action, ...fields } = parsed;
      return okJson(await bridge.call(action, fields));
    },
  );
}
