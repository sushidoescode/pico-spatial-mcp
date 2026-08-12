import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import {
  ensurePicoCli,
  picoCliFromEnsure,
  PICO_CLI_AUTOINSTALL_ENV,
  PICO_CLI_AUTOUPDATE_ENV,
  type PicoCliEnsureResult,
  type PicoCliFailureClass,
} from "./picocli.js";

export const DEFAULT_KNOWLEDGE_COMMAND = "pico-cli";
export const DEFAULT_KNOWLEDGE_ARGS = ["mcp", "spatial-knowledge"] as const;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_RETIREMENT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;

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
  cliProvisioning?: PicoCliEnsureResult;
  failureClass?: PicoCliFailureClass;
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
  client: Client;
  transport: StdioClientTransport;
  fatal?: Error;
  intentionalClose: boolean;
  closed: boolean;
  closeObserved: Promise<void>;
  resolveCloseObserved: () => void;
  closePromise?: Promise<void>;
};

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

  constructor(options: KnowledgeBridgeOptions = {}) {
    this.command = options.command ?? DEFAULT_KNOWLEDGE_COMMAND;
    this.args = [...(options.args ?? DEFAULT_KNOWLEDGE_ARGS)];
    this.cwd = options.cwd;
    // Supplying a command is the injection/custom-command seam used by tests and alternate
    // providers. Only the production default pico-cli command participates in MCP provisioning.
    this.provisionDefaultPicoCli = options.command === undefined;
    // Leave production env unresolved until spawn time: a successful lazy global install may add
    // npm's bin directory to process.env.PATH before the first knowledge_api call starts this child.
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
    this.resetBarrier = priorReset.then(
      () => session.closeObserved,
      () => session.closeObserved,
    );
    session.closePromise = (async () => {
      const clientClose = session.client.close().catch(() => undefined);
      try {
        await waitBounded(
          Promise.all([clientClose, session.closeObserved]),
          this.retirementTimeoutMs,
          `spatial-knowledge generation ${session.generation} close was not observed within ${this.retirementTimeoutMs}ms`,
        );
      } catch {
        // Keep resetBarrier quarantined on closeObserved. The caller returns after this bounded
        // cleanup attempt, but no replacement generation may start until the old transport's
        // close event is actually observed.
      }
    })();
    return session.closePromise;
  }

  private async ensureStarted(): Promise<KnowledgeSession> {
    if (this.current && !this.current.fatal && !this.current.closed) return this.current;
    if (this.current) await this.retire(this.current);
    if (this.startupPromise) return this.startupPromise;
    await waitBounded(
      this.resetBarrier,
      this.retirementTimeoutMs,
      `previous spatial-knowledge process close was not observed within ${this.retirementTimeoutMs}ms`,
    );

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      env: this.env ?? productionKnowledgeEnvironment(),
      stderr: "inherit",
    });
    const client = new Client({ name: "pico-spatial-mcp-knowledge", version: "1.0.0" });
    let resolveCloseObserved!: () => void;
    const closeObserved = new Promise<void>((resolve) => {
      resolveCloseObserved = resolve;
    });
    const session: KnowledgeSession = {
      generation: ++this.generation,
      client,
      transport,
      intentionalClose: false,
      closed: false,
      closeObserved,
      resolveCloseObserved,
    };
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
        await client.connect(transport, {
          timeout: this.startupTimeoutMs,
          maxTotalTimeout: this.startupTimeoutMs,
        });
        if (session.fatal) throw session.fatal;
        if (session.closed || this.starting !== session) {
          throw new Error(`spatial-knowledge generation ${session.generation} closed during startup`);
        }
        this.starting = undefined;
        this.current = session;
        return session;
      } catch (error) {
        session.fatal ??= error instanceof Error ? error : new Error(String(error));
        await this.retire(session);
        throw session.fatal;
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
      let cliProvisioning: PicoCliEnsureResult | null = null;
      const withProvisioning = (result: KnowledgeResult): KnowledgeResult =>
        cliProvisioning && cliProvisioning.action !== "present"
          ? { ...result, cliProvisioning }
          : result;
      try {
        if (
          this.provisionDefaultPicoCli &&
          (process.env[PICO_CLI_AUTOINSTALL_ENV] === "1" || process.env[PICO_CLI_AUTOUPDATE_ENV] === "1")
        ) {
          cliProvisioning = await ensurePicoCli();
          if (!picoCliFromEnsure(cliProvisioning)) {
            return {
              status: "unavailable",
              action: parsedAction,
              error: cliProvisioning.note ?? "pico-cli is unavailable after provisioning.",
              failureClass: "failureClass" in cliProvisioning ? cliProvisioning.failureClass : "cli-missing",
              cliProvisioning,
            };
          }
        }
        session = await this.ensureStarted();
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
          return withProvisioning({
            status: "unavailable",
            action: parsedAction,
            error: capped.text,
            truncated: capped.truncated,
            remoteError: true,
          });
        }
        if (response.isError === true || providerTextError) {
          return withProvisioning({
            status: "error",
            action: parsedAction,
            error: capped.text,
            truncated: capped.truncated,
            remoteError: true,
          });
        }
        return withProvisioning({
          status: "ok",
          action: parsedAction,
          text: capped.text,
          truncated: capped.truncated,
          remoteError: false,
        });
      } catch (error) {
        if (session) await this.retire(session);
        return withProvisioning({ status: "unavailable", action: parsedAction, error: errorMessage(error) });
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
        "Query PICO's persistent spatial-knowledge graph through pico-cli. Exposes query_graph, get_node, get_neighbors, get_community, god_nodes, graph_stats, shortest_path, and switch_workspace. When the shared CLI is missing, PICO_MCP_AUTOINSTALL_CLI=1 enables the same lazy bounded provisioning used by the perf/trace tools; default remains unavailable with no install. Graph answers are broad contextual evidence; use vault_api for authoritative exact SDK declarations and citations.",
      inputSchema: knowledgeInputSchema,
    },
    async (input) => {
      const parsed = knowledgeInputSchema.parse(input);
      const { action, ...fields } = parsed;
      return okJson(await bridge.call(action, fields));
    },
  );
}
