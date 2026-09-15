import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { okJsonStructured } from "./util.js";
import {
  ensurePicoCli,
  picoCliProvenance,
  picoCliFromEnsure,
  picoCliOperationCapability,
  retainPicoCliObservation,
  runPicoCli,
  classifyPicoCliFailure,
  describePicoCliEnvironmentFailure,
  cliWrapperContractShape,
  inspectPicoCliArtifact,
  type PicoCliArtifactInspection,
  type PicoCliCommandResult,
  type PicoCliRetainedObservation,
} from "./picocli.js";
import {
  capabilityFailureClass,
  capabilityNeedsFreshDiscovery,
  cliOperationOptions,
  type CliOperation,
  type CliRouteOptions,
  type OperationCapability,
} from "./clicapabilities.js";

/**
 * perftrace.ts — perf_trace: PICO's Perfetto trace pipeline routed through our loop.
 *
 * Wraps `pico-cli perf trace` record / decode / load / query — the official path to the spatial
 * engine's REAL 3D frame pacing, the blind spot gfxinfo/measure_perf declares it cannot see.
 * `--live` (Ctrl+C-terminated streaming) is deliberately NOT wrapped — every action is bounded,
 * and no new trace-analysis execution is added just because the CLI advertises it.
 *
 * C4 (2026-09-15) re-derived every flag from the VENDORED profiler's own declarations
 * (clicapabilities' route-option facts; 0.4.4 bundles profiler 0.1.0, 0.5.0 bundles 0.2.0) and
 * fixed the two output contracts the consumer audit found broken:
 *   * `load` used to be parsed with a best-effort session scraper, but the default renderer prints
 *     the HUMAN label `[TraceLoad] Session: <id>` (excerpt TRACE_LOAD_HUMAN) which that scraper
 *     never matched. The wrapper now asks for the machine envelope with the global `--envelope`
 *     flag and validates success/resource/action before trusting `data.sessionId`; the label
 *     parser survives only as a separately identified legacy path.
 *   * `query` used to assign the WHOLE envelope to `rows`. `TraceQueryAction` declares
 *     `outputMode:"envelope"` and returns `{sessionId, rpcEndpoint, rows}` as the envelope's `data`
 *     (excerpts TRACE_QUERY_SCHEMA / TRACE_QUERY_ROWS / TRACE_JSON_ENVELOPE). The wrapper now
 *     validates the envelope and returns `data.rows`. Note this profiler envelope is NOT the
 *     top-level pico-cli `tool_status` envelope.
 *
 * Dispatch requires verified capability evidence for the exact trace route on the resolved
 * package; an unprovisioned or environment-gated profiler is refused without spawning, and nothing
 * here ever sets PICO_HOME or runs setup.
 *
 * HONESTY (load-bearing): outputs are pico-cli's own, quoted verbatim (outputTail) plus artifact
 * paths whose existence is stat-checked, never asserted. Absent CLI degrades to
 * status:'unavailable' — null/absent, never fabricated. Caveats: `decode` may auto-download
 * traceconv on first use (network); `load`/`query` need the CLI's own perf daemon +
 * trace_processor_shell. The flag surface is SOURCE-verified against the vendored profiler
 * packages; an end-to-end record on a device is not ledgered. Evidence class: structural —
 * traces are numbers, not looks.
 */

const HONESTY =
  "Everything returned is pico-cli's own output (verbatim tail) plus stat-checked artifact paths; " +
  "raw stdout/stderr are retained immutably. Session ids and query rows come from the profiler's " +
  "validated JSON envelope (success/resource/action/session checked before anything is unwrapped) " +
  "— never scraped from prose, and an empty rows array is a real answer, not a missing one. The " +
  "flag surface was read from the vendored profiler package's own declarations (0.1.0 on the 0.4.x " +
  "line, 0.2.0 on 0.5.x); an end-to-end record on a device is not ledgered. Evidence class: " +
  "structural — trace numbers are not a substitute for LOOKING at frames.";

/** Source/freshness-neutral guidance for an unprovisioned utility payload. Byte-pinned by
 * test/distribution-adoption.mjs across every CLI wrapper: do not reword per branch. */
const SETUP_REQUIRED_NOTE =
  "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry.";

export type PerfTraceAction = "record" | "decode" | "load" | "query";

const TRACE_OPERATIONS: Record<PerfTraceAction, CliOperation> = {
  record: "trace-record",
  decode: "trace-decode",
  load: "trace-load",
  query: "trace-query",
};

// --- the profiler's machine envelope -----------------------------------------------------------

/** `buildJsonEnvelope` (excerpt TRACE_JSON_ENVELOPE). `data`, `error` and `formattedOutput` are
 * always emitted by the profiler but are optional here so a fixture need not restate them. */
export type ProfilerEnvelope = {
  success: boolean;
  exitCode: number;
  resource: string;
  action: string;
  data?: unknown;
  error?: string | null;
  formattedOutput?: string | null;
};

export type ProfilerEnvelopeParse =
  | { status: "ok"; envelope: ProfilerEnvelope }
  | { status: "failed"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asEnvelope(value: unknown): ProfilerEnvelope | null {
  if (!isRecord(value)) return null;
  if (typeof value.success !== "boolean") return null;
  if (typeof value.exitCode !== "number") return null;
  if (typeof value.resource !== "string" || typeof value.action !== "string") return null;
  return value as unknown as ProfilerEnvelope;
}

/**
 * Locate the profiler's envelope in a stdout stream. `writeOutput` emits it as one JSON document
 * (compact when stdout is not a TTY, which it never is under our pipe), but the CLI's own progress
 * prose can share the stream, so the whole document is tried first and then each line.
 */
export function parseProfilerEnvelope(stdout: string): ProfilerEnvelopeParse {
  const text = stdout.trim();
  if (text.length === 0) return { status: "failed", reason: "the profiler produced no output, so there is no JSON envelope to read" };
  const attempt = (candidate: string): ProfilerEnvelope | null => {
    try {
      return asEnvelope(JSON.parse(candidate));
    } catch {
      return null;
    }
  };
  const whole = attempt(text);
  if (whole) return { status: "ok", envelope: whole };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const perLine = attempt(trimmed);
    if (perLine) return { status: "ok", envelope: perLine };
  }
  return { status: "failed", reason: "no parseable profiler JSON envelope (success/exitCode/resource/action) was found in the output — it may be truncated, malformed, or the human renderer's text" };
}

export type TraceLoadValidation =
  | { status: "ok"; sessionId: string; rpcEndpoint?: string; envelope: ProfilerEnvelope }
  | { status: "failed"; reason: string; envelope?: ProfilerEnvelope };

/** Validate a `perf --envelope trace load` result before trusting its session id. */
export function validateTraceLoadEnvelope(stdout: string): TraceLoadValidation {
  const parsed = parseProfilerEnvelope(stdout);
  if (parsed.status !== "ok") return { status: "failed", reason: parsed.reason };
  const envelope = parsed.envelope;
  if (envelope.success !== true) {
    return { status: "failed", reason: `the profiler reported failure (exitCode ${envelope.exitCode}): ${envelope.error ?? "no error text"}`, envelope };
  }
  if (envelope.resource !== "trace" || envelope.action !== "load") {
    return { status: "failed", reason: `the envelope describes ${envelope.resource}.${envelope.action}, not trace.load`, envelope };
  }
  const data = isRecord(envelope.data) ? envelope.data : null;
  const sessionId = typeof data?.sessionId === "string" && data.sessionId.length > 0 ? data.sessionId : null;
  if (!sessionId) return { status: "failed", reason: "the successful trace.load envelope carries no data.sessionId", envelope };
  return {
    status: "ok",
    sessionId,
    ...(typeof data?.rpcEndpoint === "string" ? { rpcEndpoint: data.rpcEndpoint } : {}),
    envelope,
  };
}

/**
 * LEGACY contract only. The default (non-envelope) `trace load` rendering is `renderTraceLoad`,
 * whose first line is exactly `[TraceLoad] Session: <id>` (excerpt TRACE_LOAD_HUMAN). This reads
 * that exact label and nothing else — it never guesses an id out of diagnostic prose.
 */
export function parseTraceLoadHumanSession(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\[TraceLoad\] Session:\s+(\S+)$/.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

export type TraceQueryValidation =
  | { status: "ok"; rows: unknown[]; sessionId: string; rpcEndpoint?: string; envelope: ProfilerEnvelope }
  | { status: "failed"; reason: string; envelope?: ProfilerEnvelope };

/**
 * Validate a `perf trace query` envelope and unwrap `data.rows`. `TraceQueryAction` declares
 * `outputMode:"envelope"` and returns `{sessionId, rpcEndpoint, rows}` as `data`, so the envelope
 * itself must never be handed back as the rows. An empty successful array IS a measurement.
 */
export function validateTraceQueryEnvelope(stdout: string, expected: { sessionId: string }): TraceQueryValidation {
  const parsed = parseProfilerEnvelope(stdout);
  if (parsed.status !== "ok") return { status: "failed", reason: parsed.reason };
  const envelope = parsed.envelope;
  if (envelope.success !== true) {
    return { status: "failed", reason: `the profiler reported failure (exitCode ${envelope.exitCode}): ${envelope.error ?? "no error text"}`, envelope };
  }
  if (envelope.resource !== "trace") return { status: "failed", reason: `the envelope's resource is ${JSON.stringify(envelope.resource)}, not "trace"`, envelope };
  if (envelope.action !== "query") return { status: "failed", reason: `the envelope's action is ${JSON.stringify(envelope.action)}, not "query"`, envelope };
  const data = isRecord(envelope.data) ? envelope.data : null;
  if (data === null) return { status: "failed", reason: "the successful trace.query envelope carries no data object", envelope };
  if (data.sessionId !== expected.sessionId) {
    return { status: "failed", reason: `the envelope answers for session ${JSON.stringify(data.sessionId)}, not the requested ${JSON.stringify(expected.sessionId)}`, envelope };
  }
  if (!Array.isArray(data.rows)) {
    return { status: "failed", reason: "the successful trace.query envelope carries no data.rows array (an --execute result reports `executed:true` instead)", envelope };
  }
  return {
    status: "ok",
    rows: data.rows,
    sessionId: expected.sessionId,
    ...(typeof data.rpcEndpoint === "string" ? { rpcEndpoint: data.rpcEndpoint } : {}),
    envelope,
  };
}

/**
 * Best-effort sessionId extraction. DEPRECATED by validateTraceLoadEnvelope — kept as a
 * compatibility export for callers holding older output. It never sees production dispatch.
 */
export function parseTraceSessionId(stdout: string): string | null {
  const fromJson = (text: string): string | null => {
    try {
      const parsed = JSON.parse(text);
      const id = parsed?.sessionId ?? parsed?.session_id ?? parsed?.data?.sessionId;
      return typeof id === "string" || typeof id === "number" ? String(id) : null;
    } catch {
      return null;
    }
  };
  const whole = fromJson(stdout.trim());
  if (whole) return whole;
  for (const line of stdout.trim().split("\n")) {
    const perLine = fromJson(line.trim());
    if (perLine) return perLine;
  }
  const m = stdout.match(/session[_ ]?id["'\s:=]+([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// --- argv ---------------------------------------------------------------------------------------

export type PerfTraceRequest = {
  action: PerfTraceAction;
  packageName?: string;
  durationSec?: number;
  tracePath?: string;
  sessionId?: string;
  sql?: string;
  format?: "json" | "systrace" | "ctrace";
  device?: string;
  outputPath?: string;
};

/**
 * Build one trace invocation from the route's own option facts. The global `--envelope` flag is
 * inserted directly after the `perf` token because commander registers it on the program and the
 * profiler enables neither allowUnknownOption nor passThroughOptions, so a subcommand would reject
 * it. Long options are preferred throughout even where a short alias still exists.
 */
export function traceArgv(
  action: PerfTraceAction,
  argvPrefix: readonly string[],
  options: CliRouteOptions | null,
  request: Pick<PerfTraceRequest, "packageName" | "durationSec" | "tracePath" | "sessionId" | "sql" | "format" | "device" | "outputPath">,
): string[] {
  const names = options?.names ?? {};
  const prefix = [...argvPrefix];
  const wantsEnvelope = (action === "load" || action === "query") && Boolean(names.envelope);
  const args = wantsEnvelope && prefix.length > 0
    ? [prefix[0], names.envelope, ...prefix.slice(1)]
    : prefix;
  if (action === "record") {
    if (names.duration && request.durationSec !== undefined) args.push(names.duration, String(request.durationSec));
    if (names.output && request.outputPath) args.push(names.output, request.outputPath);
    if (names.device && request.device) args.push(names.device, request.device);
    if (names.package && request.packageName) args.push(names.package, request.packageName);
    return args;
  }
  if (action === "decode") {
    if (request.tracePath) args.push(request.tracePath);
    if (names.format && request.format) args.push(names.format, request.format);
    if (names.output && request.outputPath) args.push(names.output, request.outputPath);
    return args;
  }
  if (action === "load") {
    if (request.tracePath) args.push(request.tracePath);
    return args;
  }
  if (names.session && request.sessionId) args.push(names.session, request.sessionId);
  if (names.sql && request.sql !== undefined) args.push(names.sql, request.sql);
  return args;
}

// --- the bounded trace core ----------------------------------------------------------------------

export type PerfTraceRuntime = {
  capability: (operation: CliOperation) => OperationCapability;
  rediscover?: (operation: CliOperation) => Promise<OperationCapability | null>;
  options: (operation: CliOperation) => CliRouteOptions | null;
  run: (args: string[], opts: { timeoutMs: number; maxOutputBytes?: number }) => Promise<PicoCliCommandResult>;
  retain: (input: { operation: CliOperation; argv: string[]; result: PicoCliCommandResult; metadata: Record<string, unknown> }) => PicoCliRetainedObservation;
  inspectArtifact: (artifactPath: string) => PicoCliArtifactInspection;
  cliPath: string;
  cliRaw: string | null;
  cliVersion: string | null;
};

function capabilityDisclosure(capability: OperationCapability): Record<string, unknown> {
  return {
    capability: {
      operation: capability.operation,
      state: capability.state,
      reason: capability.reason,
      argvPrefix: capability.argvPrefix ? [...capability.argvPrefix] : null,
      evidence: capability.evidence.flatMap((observation) => [observation.stdoutPath, observation.stderrPath]),
    },
  };
}

function retainedFields(retained: PicoCliRetainedObservation): Record<string, unknown> {
  return retained.retained
    ? {
        retainedLog: {
          directory: retained.directory,
          stdoutPath: retained.stdoutPath,
          stderrPath: retained.stderrPath,
          recordPath: retained.recordPath,
          stdoutSha256: retained.stdoutSha256,
          stderrSha256: retained.stderrSha256,
          outputTruncated: retained.outputTruncated,
        },
      }
    : { retainedLogError: retained.error };
}

export async function runPerfTrace(
  request: PerfTraceRequest,
  runtime: PerfTraceRuntime,
): Promise<Record<string, unknown>> {
  const operation = TRACE_OPERATIONS[request.action];

  // 1. Capability gate — no spawn without verified evidence bound to THIS execution target.
  let capability = runtime.capability(operation);
  if (capability.state === "unknown" && capabilityNeedsFreshDiscovery(capability.reason) && runtime.rediscover) {
    capability = (await runtime.rediscover(operation)) ?? capability;
  }
  if (capability.state !== "supported" || !capability.argvPrefix || capability.argvPrefix.length === 0) {
    const failureClass = capabilityFailureClass(capability);
    const environmentGuidance = failureClass === "environment"
      ? describePicoCliEnvironmentFailure(capability.reason, "", operation)
      : null;
    const note = failureClass === "setup-required"
      ? SETUP_REQUIRED_NOTE
      : failureClass === "environment"
        ? environmentGuidance ?? "pico-cli reported an incomplete environment while this wrapper probed its trace route; read the capability reason before assuming a cause."
        : failureClass === "flag-or-version-drift"
          ? `pico-cli rejected \`${capability.argvPrefix?.join(" ") ?? `perf trace ${request.action}`} --help\` (installed: ${runtime.cliRaw || "unknown"}) — its trace surface drifted from the routes this wrapper was verified against, so nothing was run.`
          : `The resolved pico-cli has no verified \`perf trace ${request.action}\` capability, so this wrapper ran nothing. Run ensure_pico_cli to re-run bounded capability discovery, then read the capability reason below.`;
    return {
      status: "failed",
      failureClass,
      note,
      ...(failureClass === "setup-required" ? { setupCommand: { path: runtime.cliPath, args: ["setup"] } } : {}),
      action: request.action,
      ...capabilityDisclosure(capability),
      honesty: HONESTY,
    };
  }

  // Argv completeness: the option spellings are route FACTS, so a line that declares none of the
  // roles this action needs gets a refusal, not a half-built invocation.
  const options = runtime.options(operation);
  const requiredRoles: Record<PerfTraceAction, readonly string[]> = {
    record: ["duration", "output", "device"],
    decode: ["format", "output"],
    load: ["envelope"],
    query: ["session", "sql", "envelope"],
  };
  const missingRoles = requiredRoles[request.action].filter((role) => !options?.names[role]);
  if (missingRoles.length > 0) {
    return {
      status: "failed",
      failureClass: "flag-or-version-drift",
      note: `the resolved pico-cli line declares no ${missingRoles.join("/")} option for \`perf trace ${request.action}\` (installed: ${runtime.cliRaw || "unknown"}), so this wrapper built no invocation. Report this upstream instead of retrying.`,
      action: request.action,
      ...capabilityDisclosure(capability),
      honesty: HONESTY,
    };
  }
  const args = traceArgv(request.action, capability.argvPrefix, options, request);
  const artifact = request.action === "record" || request.action === "decode" ? request.outputPath ?? null : null;
  const timeoutMs = request.action === "record"
    ? ((request.durationSec ?? 15) + 90) * 1000
    : request.action === "decode"
      ? 300_000 // traceconv may auto-download on first use
      : request.action === "load"
        ? 180_000 // starts trace_processor_shell via the CLI's daemon
        : 120_000;

  const runResult = await runtime.run(args, { timeoutMs, maxOutputBytes: 32 * 1024 * 1024 });
  const retained = runtime.retain({
    operation,
    argv: args,
    result: runResult,
    metadata: {
      action: request.action,
      ...(request.packageName ? { packageName: request.packageName } : {}),
      ...(request.device ? { device: request.device } : {}),
      ...(request.tracePath ? { tracePath: request.tracePath } : {}),
      ...(request.sessionId ? { requestedSessionId: request.sessionId } : {}),
      ...(artifact ? { artifact } : {}),
      capabilityReason: capability.reason,
      cliVersion: runtime.cliVersion,
    },
  });

  if (runResult.spawnError || runResult.timedOut || runResult.code !== 0) {
    const failureClass = runResult.spawnError ? "runtime" : classifyPicoCliFailure(runResult.stderr, runResult.stdout);
    const environmentGuidance = failureClass === "environment"
      ? describePicoCliEnvironmentFailure(runResult.stderr, runResult.stdout, operation)
      : null;
    const failTail = `${runResult.stderr}\n${runResult.stdout}`.trim().split("\n").slice(-8).join("\n");
    return {
      status: "failed",
      failureClass,
      note: failureClass === "flag-or-version-drift"
        ? `pico-cli rejected \`${args.join(" ")}\` (installed: ${runtime.cliRaw || "unknown"}) — its trace surface drifted from the vendored profiler declarations this argv was built from; report outputTail upstream instead of retrying.`
        : failureClass === "setup-required"
          ? SETUP_REQUIRED_NOTE
          : failureClass === "environment"
            ? environmentGuidance ?? "pico-cli reported an incomplete environment; read outputTail before assuming a cause."
            : "pico-cli perf trace failed at runtime — read outputTail (the CLI's own words) before assuming a cause.",
      ...(failureClass === "setup-required" ? { setupCommand: { path: runtime.cliPath, args: ["setup"] } } : {}),
      action: request.action,
      command: ["pico-cli", ...args].join(" "),
      error: runResult.spawnError ?? (runResult.timedOut
        ? `pico-cli perf trace exceeded ${timeoutMs}ms and was killed.`
        : `pico-cli perf trace exited with code ${runResult.code}.`),
      ...(failTail ? { outputTail: failTail } : {}),
      ...(runResult.outputTruncated ? { outputTruncated: true } : {}),
      ...retainedFields(retained),
      honesty: HONESTY,
    };
  }

  const tail = `${runResult.stdout}\n${runResult.stderr}`.trim().split("\n").slice(-12).join("\n");
  const out: Record<string, unknown> = {
    status: "ok",
    action: request.action,
    command: ["pico-cli", ...args].join(" "),
    ...(tail ? { outputTail: tail } : {}),
    ...(runResult.outputTruncated ? { outputTruncated: true } : {}),
    ...retainedFields(retained),
    honesty: HONESTY,
  };
  if (artifact) {
    // Exit 0 is not evidence the artifact is a non-empty regular file — stat once and fail closed.
    const inspection = runtime.inspectArtifact(artifact);
    const artifactOk = inspection.exists === true && inspection.regularFile && (inspection.bytes ?? 0) > 0;
    const artifactFailure = inspection.statError
      ? `could not be stat-checked: ${inspection.statError}`
      : inspection.exists === false
        ? "missing"
        : !inspection.regularFile
          ? "not a regular file"
          : "empty";
    out.artifact = artifact;
    if (inspection.exists !== null) out.artifactExists = inspection.exists;
    out.artifactBytes = inspection.bytes;
    if (!artifactOk) {
      out.status = "failed";
      out.failureClass = "runtime";
      out.note = `pico-cli exited 0 but the expected output file is ${artifactFailure} at ${artifact} — treat as failed.`;
      if (inspection.statError) out.error = inspection.statError;
    }
  }
  if (request.action === "load") {
    const validated = validateTraceLoadEnvelope(runResult.stdout);
    if (validated.status === "ok") {
      out.sessionId = validated.sessionId;
      out.sessionSource = "envelope";
      if (validated.rpcEndpoint) out.rpcEndpoint = validated.rpcEndpoint;
    } else {
      // LEGACY: only the exact human label, and only when the envelope was not usable. A parsed
      // label is reported as such so no caller mistakes it for a validated machine result.
      const legacy = parseTraceLoadHumanSession(runResult.stdout);
      if (legacy !== null) {
        out.sessionId = legacy;
        out.sessionSource = "legacy-human-label";
        out.note = `the profiler did not return a usable JSON envelope (${validated.reason}); the session id was read from the legacy \`[TraceLoad] Session:\` label instead.`;
      } else {
        out.status = "failed";
        out.failureClass = "runtime";
        out.sessionSource = "none";
        out.note = `pico-cli exited 0 but no usable trace.load session result was returned: ${validated.reason}. The raw output is in outputTail and the retained log.`;
      }
    }
  }
  if (request.action === "query") {
    const validated = validateTraceQueryEnvelope(runResult.stdout, { sessionId: request.sessionId ?? "" });
    if (validated.status === "ok") {
      out.rows = validated.rows;
      out.rowCount = validated.rows.length;
      out.sessionId = validated.sessionId;
      if (validated.rpcEndpoint) out.rpcEndpoint = validated.rpcEndpoint;
    } else {
      out.status = "failed";
      out.failureClass = "runtime";
      out.note = `pico-cli exited 0 but its trace.query answer could not be validated: ${validated.reason}. No rows are reported; the raw output is in outputTail and the retained log.`;
      if (validated.envelope?.error) out.error = validated.envelope.error;
      if (validated.envelope) out.envelopeExitCode = validated.envelope.exitCode;
    }
  }
  return out;
}

export function registerPerfTraceTools(server: McpServer) {
  server.registerTool(
    "perf_trace",
    {
      description:
        "Drive PICO's OFFICIAL Perfetto trace pipeline (`pico-cli perf trace`) — the real 3D frame-pacing evidence that " +
        "gfxinfo/measure_perf cannot see. action='record' traces the device for durationSec (bounded — the CLI's " +
        "Ctrl+C live mode is not wrapped) and returns the .perfetto-trace path; 'decode' converts a trace to " +
        "json/systrace/ctrace (may auto-download traceconv on first use); 'load' starts a trace_processor session and " +
        "returns its sessionId from the profiler's VALIDATED JSON envelope (sessionSource says whether it came from the " +
        "envelope or the legacy `[TraceLoad] Session:` label); 'query' runs SQL against a loaded session and returns the " +
        "envelope's data.rows — never the envelope itself, and an empty rows array is a real answer. Dispatch requires " +
        "verified capability evidence for the exact trace route on the resolved package; an unprovisioned or " +
        "environment-gated profiler is refused without running anything, and this server never sets PICO_HOME and never " +
        "runs setup. Bounded raw stdout/stderr are retained immutably (retainedLog). Resolves the latest managed " +
        "@picoxr/pico-cli lazily and runs its absolute path. Failures carry an honest managed policy/freshness, " +
        "flag-or-version-drift, setup-required (returning an absolute manual setupCommand), environment, " +
        "or runtime failureClass with the CLI's own outputTail. " +
        "HONESTY: " + HONESTY,
      // Typed contract (2026-07-28 revision lane): the shared CLI-wrapper core + trace fields.
      outputSchema: z.object({
        status: z.enum(["ok", "failed", "unavailable"]).describe("ok = the action completed, any expected artifact stat-checked non-missing AND any session/rows answer validated; failed = run/artifact/envelope failure, or the route's capability evidence refuses it (exit 0 with a missing file or an unvalidatable envelope is failed, not ok); unavailable = pico-cli absent/unusable."),
        ...cliWrapperContractShape,
        action: z.enum(["record", "decode", "load", "query"]).optional(),
        command: z.string().optional().describe("The exact pico-cli invocation."),
        artifact: z.string().optional().describe("record/decode: the expected output file."),
        artifactExists: z.boolean().optional().describe("Stat-checked — exit 0 is not evidence the artifact exists."),
        artifactBytes: z.number().nullable().optional(),
        sessionId: z.string().nullable().optional().describe("load: from the validated envelope (or the legacy label — see sessionSource). query: the session the rows answer for."),
        sessionSource: z.enum(["envelope", "legacy-human-label", "none"]).optional().describe("Which contract produced sessionId. 'envelope' is the validated machine result; 'legacy-human-label' is the default human renderer's `[TraceLoad] Session:` line."),
        rpcEndpoint: z.string().optional(),
        rows: z.array(z.unknown()).optional().describe("query: the envelope's data.rows, unwrapped and validated. Absent (never null-filled) when validation failed."),
        rowCount: z.number().optional(),
        envelopeExitCode: z.number().optional(),
        capability: z.record(z.unknown()).optional().describe("Why dispatch was refused, with the retained bounded-help evidence paths behind the decision."),
        retainedLog: z.record(z.unknown()).optional().describe("Immutable raw stdout/stderr of the bounded run, with hashes."),
        retainedLogError: z.string().optional(),
      }).passthrough(),
      inputSchema: {
        action: z.enum(["record", "decode", "load", "query"]).describe("record = capture a .perfetto-trace from the device; decode = convert it; load = open a SQL session on it; query = run SQL in that session."),
        packageName: z.string().optional().describe("record: target app package. Optional — omitting it records a whole-device trace."),
        durationSec: z.number().min(5).max(300).optional().describe("record: seconds to trace (default 15; the CLI's own default is 60 — shorter suits the loop)."),
        tracePath: z.string().optional().describe("decode/load: path to a .perfetto-trace file (required for those actions — pass the record result's artifact)."),
        sessionId: z.string().optional().describe("query: session id returned by a prior load."),
        sql: z.string().optional().describe("query: SQL for trace_processor, e.g. \"select name, dur from slice order by dur desc limit 20\"."),
        format: z.enum(["json", "systrace", "ctrace"]).optional().describe("decode: output format (default json)."),
        device: z.string().optional().describe("record: device serial (default emulator-5554)."),
        outputPath: z.string().optional().describe("record/decode: output file path (default under ~/.pico-mcp/perf/)."),
      },
    },
    async ({ action, packageName, durationSec, tracePath, sessionId, sql, format, device, outputPath }) => {
      const outDir = path.join(os.homedir(), ".pico-mcp", "perf");
      if ((action === "decode" || action === "load") && !tracePath) {
        return okJsonStructured({ status: "failed", action, note: `${action} needs tracePath (a .perfetto-trace file from record).` });
      }
      if (action === "query" && (!sessionId || !sql)) {
        return okJsonStructured({ status: "failed", action, note: "query needs sessionId (from load) and sql." });
      }

      const request: PerfTraceRequest = {
        action,
        ...(packageName ? { packageName } : {}),
        ...(tracePath ? { tracePath } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(sql !== undefined ? { sql } : {}),
        ...(format ? { format } : {}),
      };
      if (action === "record") {
        request.durationSec = Math.min(300, Math.max(5, Math.round(durationSec ?? 15)));
        request.device = device ?? "emulator-5554";
        request.outputPath = outputPath ?? path.join(outDir, `trace-${new Date().toISOString().replace(/[:.]/g, "-")}.perfetto-trace`);
      } else if (action === "decode") {
        request.format = format ?? "json";
        request.outputPath = outputPath ?? `${tracePath}.${format ?? "json"}`;
      }

      const ensured = await ensurePicoCli();
      if (ensured.status !== "ok") {
        return okJsonStructured({
          status: "unavailable",
          failureClass: ensured.failureClass,
          note: ensured.note,
          ...(ensured.outputTail ? { outputTail: ensured.outputTail } : {}),
        });
      }
      let cli = picoCliFromEnsure(ensured)!;
      let provenance = { picoCli: picoCliProvenance(ensured) };
      fs.mkdirSync(outDir, { recursive: true });

      const runtime: PerfTraceRuntime = {
        capability: (operation) => picoCliOperationCapability(cli, operation),
        rediscover: async (operation) => {
          const refreshed = await ensurePicoCli({ forceRefresh: true });
          if (refreshed.status !== "ok") return null;
          const target = picoCliFromEnsure(refreshed);
          if (!target) return null;
          cli = target;
          provenance = { picoCli: picoCliProvenance(refreshed) };
          return picoCliOperationCapability(cli, operation);
        },
        options: (operation) => cliOperationOptions(cli.version ?? "", operation),
        run: (args, opts) => runPicoCli(cli, args, opts),
        retain: (input) => retainPicoCliObservation({ operation: input.operation, argv: input.argv, result: input.result, metadata: input.metadata }),
        inspectArtifact: (artifactPath) => inspectPicoCliArtifact(artifactPath),
        // Accessors, not captured values: `rediscover` may re-resolve the CLI mid-call.
        get cliPath() { return cli.path; },
        get cliRaw() { return cli.raw ?? null; },
        get cliVersion() { return cli.version ?? null; },
      };
      const result = await runPerfTrace(request, runtime);
      return okJsonStructured({ ...result, ...provenance });
    },
  );
}
