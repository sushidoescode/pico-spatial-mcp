import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { okJson } from "./util.js";
import {
  ensurePicoCli,
  classifyPicoCliFailure,
  picoCliExecutionGuards,
  picoCliProvenance,
  picoCliFromEnsure,
  type PicoCliExecutionGuards,
  type PicoCliExecutionTarget,
  type PicoCliFailureClass,
  type PicoCliProvenance,
} from "./picocli.js";

export const DEFAULT_KNOWLEDGE_COMMAND = "pico-cli";
// Managed pico-cli exposes the knowledge MCP server as `mcp dev-knowledge`.
export const DEFAULT_KNOWLEDGE_ARGS = ["mcp", "dev-knowledge"] as const;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_RETIREMENT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_STARTUP_STDERR_BYTES = 16 * 1_024;
const FAILURE_CLASSIFICATION_OVERLAP_CHARS = 256;
const SETUP_REQUIRED_NOTE = "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry.";
const KNOWLEDGE_GENERATION_TOKEN_ENV = "PICO_MCP_KNOWLEDGE_GENERATION_TOKEN";
const KNOWLEDGE_GENERATION_TOKEN_PATTERN = /^[1-9]\d*-[a-f0-9]{48}$/;
const PROCESS_SCAN_TIMEOUT_MS = 250;
const PROCESS_SCAN_MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const PROCESS_SCAN_MAX_MATCHES = 256;
const NATURAL_RETIREMENT_GRACE_MS = 100;

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
};

type KnowledgeSession = {
  generation: number;
  commandPath: string;
  cliVersion: string | null;
  client: Client;
  transport: StdioClientTransport;
  fatal?: Error;
  intentionalClose: boolean;
  closed: boolean;
  closeObserved: Promise<void>;
  resolveCloseObserved: () => void;
  closePromise?: Promise<void>;
  ownershipToken: string;
  rootPid: number | null;
  childEnv: Record<string, string>;
  observedOwnedPids: Set<number>;
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
  ) {
    super(message);
    this.name = "KnowledgeStartupError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
  pids: number[];
  reason?: string;
};

type RetirementOutcome = {
  confirmed: boolean;
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

/** Locate only this generation's process tree. The random child-only environment capability
 * remains attributable after a detached descendant is reparented away from the CLI process. The
 * bounded process listing is inspected in memory and is never copied into diagnostics. */
function scanPosixGeneration(rootPid: number | null, ownershipToken: string, deadlineMs: number): ProcessScan {
  if (process.platform === "win32") return { available: false, pids: [], reason: "POSIX process inspection is unavailable on Windows" };
  if (!KNOWLEDGE_GENERATION_TOKEN_PATTERN.test(ownershipToken)) {
    return { available: false, pids: [], reason: "generation ownership token was invalid" };
  }
  const psPath = posixPsPath();
  if (!psPath) return { available: false, pids: [], reason: "no bounded POSIX ps executable was available" };
  const budgetMs = Math.min(PROCESS_SCAN_TIMEOUT_MS, remainingMs(deadlineMs));
  if (budgetMs <= 0) return { available: false, pids: [], reason: "generation process scan deadline was exhausted" };
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(psPath, ["eww", "-A", "-o", "pid=", "-o", "ppid=", "-o", "command="], {
      encoding: "utf8",
      timeout: budgetMs,
      maxBuffer: PROCESS_SCAN_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    return { available: false, pids: [], reason: `bounded POSIX process scan failed: ${errorMessage(error)}` };
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return { available: false, pids: [], reason: "bounded POSIX process scan did not complete" };
  }

  const assignment = `${KNOWLEDGE_GENERATION_TOKEN_ENV}=${ownershipToken}`;
  const byParent = new Map<number, number[]>();
  const owned = new Set<number>();
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const children = byParent.get(parentPid) ?? [];
    children.push(pid);
    byParent.set(parentPid, children);
    if (pid !== process.pid && pid !== process.ppid && hasExactEnvironmentAssignment(match[3], assignment)) {
      owned.add(pid);
      if (owned.size > PROCESS_SCAN_MAX_MATCHES) {
        return { available: false, pids: [], reason: `generation process scan exceeded ${PROCESS_SCAN_MAX_MATCHES} exact owners` };
      }
    }
  }

  if (rootPid !== null && Number.isSafeInteger(rootPid) && rootPid > 1) {
    const queue = [rootPid];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const parentPid = queue.shift()!;
      for (const pid of byParent.get(parentPid) ?? []) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        owned.add(pid);
        queue.push(pid);
        if (owned.size > PROCESS_SCAN_MAX_MATCHES) {
          return { available: false, pids: [], reason: `generation process tree exceeded ${PROCESS_SCAN_MAX_MATCHES} descendants` };
        }
      }
    }
  }
  return { available: true, pids: [...owned] };
}

function signalPosixPidOrGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    try { process.kill(pid, signal); } catch { /* this exact process is already gone */ }
  }
}

function rememberOwnedPids(session: KnowledgeSession, scan: ProcessScan): void {
  if (!scan.available) return;
  for (const pid of scan.pids) session.observedOwnedPids.add(pid);
}

function signalRememberedPosixGeneration(session: KnowledgeSession, signal: NodeJS.Signals): void {
  const pids = new Set(session.observedOwnedPids);
  if (session.rootPid !== null) pids.add(session.rootPid);
  for (const pid of [...pids].reverse()) signalPosixPidOrGroup(pid, signal);
}

function signalScannedPosixGeneration(scan: ProcessScan, signal: NodeJS.Signals): void {
  for (const pid of [...scan.pids].reverse()) signalPosixPidOrGroup(pid, signal);
}

async function terminatePosixGeneration(session: KnowledgeSession, deadlineMs: number): Promise<RetirementOutcome> {
  let scan = scanPosixGeneration(session.rootPid, session.ownershipToken, deadlineMs);
  rememberOwnedPids(session, scan);
  if (!scan.available) {
    signalRememberedPosixGeneration(session, "SIGKILL");
    return { confirmed: false, reason: scan.reason };
  }
  if (scan.pids.length === 0) return { confirmed: true };

  signalScannedPosixGeneration(scan, "SIGTERM");
  const gracefulDeadline = Math.min(deadlineMs, Date.now() + Math.min(NATURAL_RETIREMENT_GRACE_MS, Math.ceil(remainingMs(deadlineMs) / 2)));
  while (remainingMs(gracefulDeadline) > 0) {
    await delay(Math.min(20, remainingMs(gracefulDeadline)));
    scan = scanPosixGeneration(session.rootPid, session.ownershipToken, deadlineMs);
    rememberOwnedPids(session, scan);
    if (!scan.available) {
      signalRememberedPosixGeneration(session, "SIGKILL");
      return { confirmed: false, reason: scan.reason };
    }
    if (scan.pids.length === 0) return { confirmed: true };
  }

  scan = scanPosixGeneration(session.rootPid, session.ownershipToken, deadlineMs);
  rememberOwnedPids(session, scan);
  if (!scan.available) {
    signalRememberedPosixGeneration(session, "SIGKILL");
    return { confirmed: false, reason: scan.reason };
  }
  signalScannedPosixGeneration(scan, "SIGKILL");
  while (remainingMs(deadlineMs) > 0) {
    await delay(Math.min(20, remainingMs(deadlineMs)));
    scan = scanPosixGeneration(session.rootPid, session.ownershipToken, deadlineMs);
    rememberOwnedPids(session, scan);
    if (!scan.available) return { confirmed: false, reason: scan.reason };
    if (scan.pids.length === 0) return { confirmed: true };
  }
  return {
    confirmed: false,
    reason: `generation ${session.generation} still had ${scan.pids.length} exact owned process(es) at the retirement deadline`,
  };
}

function envValueCaseInsensitive(env: Record<string, string>, name: string): string | undefined {
  const actual = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return actual ? env[actual] : undefined;
}

async function terminateWindowsGeneration(
  session: KnowledgeSession,
  childEnv: Record<string, string>,
  deadlineMs: number,
): Promise<RetirementOutcome> {
  if (session.rootPid === null || !Number.isSafeInteger(session.rootPid) || session.rootPid <= 1) {
    return { confirmed: false, reason: "the Windows generation root PID was not observed before retirement" };
  }
  const systemRoot = envValueCaseInsensitive(childEnv, "SystemRoot") ?? "C:\\Windows";
  const taskkillPath = path.win32.join(systemRoot, "System32", "taskkill.exe");
  return new Promise((resolve) => {
    let settled = false;
    let killer: ReturnType<typeof spawn> | undefined;
    const finish = (outcome: RetirementOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer?.unref();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { killer?.kill("SIGKILL"); } catch { /* taskkill already exited */ }
      finish({ confirmed: false, reason: "Windows taskkill did not settle within the generation retirement deadline" });
    }, Math.max(1, remainingMs(deadlineMs)));
    try {
      killer = spawn(taskkillPath, ["/pid", String(session.rootPid), "/t", "/f"], {
        env: childEnv,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", (error) => finish({ confirmed: false, reason: `Windows taskkill failed: ${errorMessage(error)}` }));
      killer.once("close", (code) => finish(code === 0
        ? { confirmed: true }
        : { confirmed: false, reason: `Windows taskkill exited ${String(code)}; the generation is quarantined rather than claimed retired` }));
    } catch (error) {
      finish({ confirmed: false, reason: `Windows taskkill could not start: ${errorMessage(error)}` });
    }
  });
}

function finishRetirementValidation(
  session: KnowledgeSession,
  deadlineMs: number,
  outcome: RetirementOutcome,
): RetirementOutcome {
  if (!session.spawnAcquired || session.completionGuardRan) return outcome;
  session.completionGuardRan = true;
  const failure = runExecutionGuard(session.executionGuards.afterCompletion, deadlineMs, "post-completion");
  return failure ? { confirmed: false, reason: failure } : outcome;
}

async function retireKnowledgeGeneration(
  session: KnowledgeSession,
  timeoutMs: number,
): Promise<RetirementOutcome> {
  const deadlineMs = Date.now() + Math.max(1, timeoutMs);
  // Capture ownership before asking the SDK to close: its transport deliberately drops its public
  // pid as soon as close begins, even when descendant-held stdio delays the close event.
  session.rootPid ??= session.transport.pid;
  if (process.platform === "win32") {
    // taskkill must see the live root before the SDK can close a .cmd parent and orphan its Node
    // descendant. It owns the exact `/t` tree first; protocol closure follows either outcome.
    const outcome = await terminateWindowsGeneration(session, session.childEnv, deadlineMs);
    const clientClose = session.client.close().catch(() => undefined);
    void clientClose;
    return finishRetirementValidation(session, deadlineMs, outcome);
  }
  const initialPosixScan = scanPosixGeneration(session.rootPid, session.ownershipToken, deadlineMs);
  rememberOwnedPids(session, initialPosixScan);
  const clientClose = session.client.close().catch(() => undefined);
  if (!initialPosixScan.available) {
    signalRememberedPosixGeneration(session, "SIGKILL");
    void clientClose;
    return finishRetirementValidation(session, deadlineMs, { confirmed: false, reason: initialPosixScan.reason });
  }
  await Promise.race([
    session.closeObserved,
    delay(Math.min(NATURAL_RETIREMENT_GRACE_MS, Math.max(1, Math.floor(remainingMs(deadlineMs) / 3)))),
  ]);
  const outcome = await terminatePosixGeneration(session, deadlineMs);
  void clientClose;
  return finishRetirementValidation(session, deadlineMs, outcome);
}

export class KnowledgeBridge {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly provisionDefaultPicoCli: boolean;
  private readonly startupTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly retirementTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private generation = 0;
  private current?: KnowledgeSession;
  private starting?: KnowledgeSession;
  private startupPromise?: Promise<KnowledgeSession>;
  private resetBarrier: Promise<void> = Promise.resolve();
  private queue: Promise<void> = Promise.resolve();
  private lifecycleWarning?: string;

  constructor(options: KnowledgeBridgeOptions = {}) {
    this.command = options.command ?? DEFAULT_KNOWLEDGE_COMMAND;
    this.args = [...(options.args ?? DEFAULT_KNOWLEDGE_ARGS)];
    this.cwd = options.cwd;
    // Supplying a command is the injection/custom-command seam used by tests and alternate
    // providers. Only the production default pico-cli command participates in MCP provisioning.
    this.provisionDefaultPicoCli = options.command === undefined;
    // Leave production env unresolved until spawn time so current host configuration reaches the
    // managed child. The command itself is always the resolved absolute managed path.
    this.env = options.env ? { ...productionKnowledgeEnvironment(), ...options.env } : undefined;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.retirementTimeoutMs = options.retirementTimeoutMs ?? DEFAULT_RETIREMENT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
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
        this.lifecycleWarning = `${errorMessage(error)}; later generations use isolated ownership and the prior generation remains quarantined`;
      }
      try {
        const outcome = await retireKnowledgeGeneration(session, Math.max(1, remainingMs(retirementDeadlineMs)));
        if (!outcome.confirmed) {
          this.lifecycleWarning = `spatial-knowledge generation ${session.generation} retirement was not fully observed: ${outcome.reason ?? "unknown cleanup state"}; the generation is quarantined and later generations use an isolated ownership token`;
        }
      } catch (error) {
        this.lifecycleWarning = `spatial-knowledge generation ${session.generation} retirement failed boundedly: ${errorMessage(error)}; the generation is quarantined and later generations use an isolated ownership token`;
      }
    })();
    // A close event held open by descendant-owned stdio must never become the restart barrier.
    // The bounded retirement attempt above owns this generation and always settles; an unproved
    // cleanup is carried forward as an explicit lifecycle warning instead of poisoning all future
    // starts.
    this.resetBarrier = session.closePromise.then(() => undefined, () => undefined);
    return session.closePromise;
  }

  private async ensureStarted(
    commandPath: string,
    cliVersion: string | null,
    executionTarget?: PicoCliExecutionTarget,
  ): Promise<KnowledgeSession> {
    const sameIdentity = (session: KnowledgeSession) =>
      session.commandPath === commandPath
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

    const ownershipToken = `${process.pid}-${randomBytes(24).toString("hex")}`;
    const executionGuards = executionTarget ? picoCliExecutionGuards(executionTarget) : {};
    const childEnv = {
      ...(this.env ?? productionKnowledgeEnvironment()),
      [KNOWLEDGE_GENERATION_TOKEN_ENV]: ownershipToken,
    };
    const transport = new StdioClientTransport({
      command: commandPath,
      args: this.args,
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
      cliVersion,
      client,
      transport,
      intentionalClose: false,
      closed: false,
      closeObserved,
      resolveCloseObserved,
      ownershipToken,
      rootPid: null,
      childEnv,
      observedOwnedPids: new Set(),
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
        // StdioClientTransport assigns its ChildProcess synchronously before connect first yields.
        // Preserve the PID because transport.close() intentionally clears the public value before
        // descendant-held pipes have necessarily closed.
        session.rootPid = transport.pid;
        session.spawnAcquired = session.rootPid !== null;
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
        );
      } finally {
        if (this.startupPromise === startup) this.startupPromise = undefined;
      }
    })();
    this.startupPromise = startup;
    return startup;
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
        let cliVersion: string | null = null;
        let executionTarget: PicoCliExecutionTarget | undefined;
        if (this.provisionDefaultPicoCli) {
          const ensured = await ensurePicoCli();
          if (ensured.status !== "ok") {
            if (this.current) await this.retire(this.current);
            if (this.starting) await this.retire(this.starting);
            return withProvenance({
              status: "unavailable",
              action: parsedAction,
              error: ensured.note,
              failureClass: ensured.failureClass,
            });
          }
          const ready = picoCliFromEnsure(ensured)!;
          executionTarget = ready;
          commandPath = ready.path;
          cliVersion = ready.version;
          provenance = picoCliProvenance(ensured);
        }
        session = await this.ensureStarted(commandPath, cliVersion, executionTarget);
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
        const startupFailure = provenance && (
          error instanceof KnowledgeStartupError && error.setupRequiredObserved
            ? "setup-required"
            : classifyPicoCliFailure(startupStderr, errorMessage(error))
        );
        if (provenance && startupFailure === "setup-required") {
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
        return withProvenance({
          status: "unavailable",
          action: parsedAction,
          error: errorMessage(error),
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
