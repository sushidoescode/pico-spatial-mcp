import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * innerclient.ts — how the doors surface reaches its inner full-surface server (C5, 2026-09-15).
 *
 * Two defects lived in doors.ts's inner(): (1) it tested its cache, awaited connect, then stored
 * the cache, so N concurrent first callers each spawned their own inner dist/index.js; (2) its
 * call adapter kept only text blocks, so structuredContent, image/resource blocks and isError were
 * lost, and an inner tool's error came back as a success-shaped value.
 *
 * This module owns initialization (single-flight + generations) and the two result lanes;
 * doors.ts only wires them.
 *
 * Result lanes
 *   raw    — InnerClient.callRaw(): the inner CallToolResult verbatim (every content block,
 *            structuredContent, isError). Doors that forward artifacts return it as their own result.
 *   domain — decodeDomainValue(): the decoded value today's doors consume for SUCCESSFUL results
 *            (text blocks joined with "\n", JSON.parse when possible, else the text — structuredContent
 *            is not merged). An isError result is never a success object: it becomes the documented
 *            {status:"error", tool, error, structuredContent?, fix} payload, marked out-of-band
 *            (non-enumerable symbol, never serialized) so the door adapter can flag its envelope.
 */
export interface InnerClient {
  callRaw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Initialization ownership only: one pending connect is shared by every concurrent caller, and a
 * failed connect clears the slot so a later call reconnects. createInnerClientProvider adds the
 * generation bookkeeping (retirement on close / transport failure) the doors need. */
export function createSingleFlightClient(connect: () => Promise<InnerClient>): () => Promise<InnerClient> {
  let pending: Promise<InnerClient> | undefined;
  return () => pending ??= connect().catch(error => { pending = undefined; throw error; });
}

/** Handed to connect(): lets the transport retire its own generation when it closes underneath the
 * provider (child exit, broken pipe), so the next acquire reconnects instead of reusing a dead client. */
export interface InnerSession {
  readonly generation: number;
  /** Retire this generation: drop it from the provider synchronously (a later acquire reconnects)
   * and close its client. Idempotent; a stale generation cannot retire a newer one. */
  retire(reason?: unknown): Promise<void>;
}

export type InnerConnect = (session: InnerSession) => Promise<InnerClient>;

export interface InnerClientProvider {
  /** The live client. Concurrent first callers share ONE pending connect; a failed connect rejects
   * every waiter with the same error and clears the slot; a retired generation reconnects. */
  acquire(): Promise<InnerClient>;
  /** Retire the generation that produced `client` (no-op for a client this provider never handed out
   * or already retired). Never touches a newer generation. */
  retire(client: InnerClient, reason?: unknown): Promise<void>;
  /** Retire whatever is live or still connecting. */
  close(): Promise<void>;
  /** Id of the most recently started generation (0 before the first acquire). */
  generation(): number;
  /** The connected client of the live generation, or null while none is connected. */
  current(): InnerClient | null;
}

type Generation = {
  id: number;
  attempt: Promise<InnerClient>;
  client: InnerClient | null;
  retired: boolean;
  closing: Promise<void> | null;
};

export function createInnerClientProvider(connect: InnerConnect): InnerClientProvider {
  let active: Generation | null = null;
  let counter = 0;
  const generationOf = new WeakMap<InnerClient, Generation>();

  const retireGeneration = (generation: Generation): Promise<void> => {
    if (generation.retired) return generation.closing ?? Promise.resolve();
    generation.retired = true;
    // Synchronous: a close racing a new connect must never clear the NEW generation, so the identity
    // check happens before any await. The next acquire may start generation n+1 while this one is
    // still closing.
    if (active === generation) active = null;
    generation.closing = generation.client ? generation.client.close().catch(() => undefined) : Promise.resolve();
    return generation.closing;
  };

  return {
    acquire() {
      if (active) return active.attempt;
      const id = ++counter;
      const generation: Generation = { id, attempt: Promise.resolve(null as unknown as InnerClient), client: null, retired: false, closing: null };
      const session: InnerSession = { generation: id, retire: () => retireGeneration(generation) };
      generation.attempt = connect(session).then(
        (client) => {
          generationOf.set(client, generation);
          if (generation.retired) {
            // closed (or the transport failed) while connecting: never hand out a client the
            // provider already gave up on — close it and let the waiters see why.
            generation.closing = client.close().catch(() => undefined);
            throw new Error(`inner client generation ${id} was retired during initialization`);
          }
          generation.client = client;
          return client;
        },
        (error) => {
          // a failed first initialization rejects every concurrent waiter with this same error and
          // frees the slot, so a later call retries the connect
          if (active === generation) active = null;
          generation.retired = true;
          throw error;
        },
      );
      active = generation;
      return generation.attempt;
    },
    retire(client) {
      const generation = generationOf.get(client);
      return generation ? retireGeneration(generation) : Promise.resolve();
    },
    close() {
      return active ? retireGeneration(active) : Promise.resolve();
    },
    generation: () => counter,
    current: () => active?.client ?? null,
  };
}

// ── result lanes ──

/** Out-of-band marker on a domain-lane error payload: a non-enumerable symbol, so it never reaches
 * JSON and an object spread drops it (a door that reshapes the payload owns its own status). */
export const INNER_TOOL_ERROR: unique symbol = Symbol("pico.innerToolError");

/** The documented domain-lane shape of an inner tool's isError result. */
export interface InnerToolErrorPayload {
  status: "error";
  tool: string;
  error: string;
  structuredContent?: Record<string, unknown>;
  fix: string;
}

/** Text blocks joined with "\n"; image/audio/resource blocks contribute nothing (raw lane carries them). */
export function textOf(result: CallToolResult): string {
  return (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** Domain lane. Successful results keep the pre-C5 decoding exactly (JSON text → value, other text →
 * string, structuredContent ignored). An isError result becomes the marked error payload. */
export function decodeDomainValue(name: string, result: CallToolResult): unknown {
  const text = textOf(result);
  if (result.isError) {
    const structured = result.structuredContent;
    const payload: InnerToolErrorPayload = {
      status: "error",
      tool: name,
      error: text || (structured ? JSON.stringify(structured) : `${name} reported an error without text`),
      ...(structured ? { structuredContent: structured } : {}),
      fix: `The full-surface tool ${name} reported this error in its own words: read \`error\` (and structuredContent when present), feed it to pico_fix for a retained lesson or run pico_doctor if the environment is suspect, then retry.`,
    };
    Object.defineProperty(payload, INNER_TOOL_ERROR, { value: true, enumerable: false });
    return payload;
  }
  try { return JSON.parse(text); } catch { return text; }
}

export function isInnerToolError(value: unknown): value is InnerToolErrorPayload {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[INNER_TOOL_ERROR] === true;
}

/** The tool's own words for a domain-lane value: an error payload's text, a string itself, else JSON. */
export function domainValueText(value: unknown): string {
  if (isInnerToolError(value)) return value.error;
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null);
}
