import crypto from "node:crypto";

/**
 * clicapabilities.ts — per-operation availability of the resolved @picoxr/pico-cli, derived from
 * bounded `--help` observations and bound to the exact package identity that produced them.
 *
 * Package activation (picoclimanaged.ts) answers "which exact pico-cli bytes run". This module
 * answers "which MCP-wrapped operations that package can be asked to perform, according to the
 * linked help evidence". The two stay separate: a missing optional profiler payload makes its
 * operations `unavailable` without invalidating an otherwise usable package, and `supported` means
 * supported by the retained discovery evidence — never runtime or visual acceptance.
 *
 * A help hash alone never enables an operation. A stored record is honored only after its
 * evidence bytes are re-read, hash-verified and re-classified (resolveOperationCapability), and
 * only when the entire recorded identity matches the resolved execution target.
 */

export type CliOperation = "knowledge-server" | "watch-crash" | "capture-record" | "perf-live"
  | "trace-record" | "trace-decode" | "trace-load" | "trace-query";
export type HelpObservation = {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  stdoutPath: string;
  stderrPath: string;
  stdoutSha256: string;
  stderrSha256: string;
};
export type OperationCapability = {
  operation: CliOperation;
  state: "supported" | "unavailable" | "unknown";
  argvPrefix: string[] | null;
  reason: string;
  evidence: HelpObservation[];
};
export type CliCapabilityIdentity = {
  version: string;
  executablePath: string;
  packageJsonSha256: string;
  executionTreeSha256: string;
};
export type CliCapabilitySet = {
  schemaVersion: 1;
  identity: CliCapabilityIdentity;
  checkedAt: string;
  operations: OperationCapability[];
};

export const CLI_OPERATIONS: readonly CliOperation[] = [
  "knowledge-server",
  "watch-crash",
  "capture-record",
  "perf-live",
  "trace-record",
  "trace-decode",
  "trace-load",
  "trace-query",
] as const;

export type CliOperationRoute = {
  operation: CliOperation;
  /** Discovery argv prefix (`--help` is appended by discovery); null when the line has no route. */
  argvPrefix: string[] | null;
  /** Which retained evidence or byte-checked source excerpt establishes (or denies) the route. */
  provenance: string;
  /**
   * True only when the retained evidence (test/fixtures/picocli/help/index.json) contains an
   * exit-0 help for this route, i.e. the phrase rule has a positive example. Without one, an
   * exit-0 help that fails the phrase rule and is not a proven parent shape stays `unknown`
   * instead of asserting a terminal `unavailable` from an unvalidated branch.
   */
  exitZeroHelpObserved: boolean;
  /**
   * The flag this route's line advertises for bounding its OWN observation window, or null when
   * the line advertises none. Consumers pass the requested duration through this flag instead of
   * relying on an outer kill; see cliobservations.ts. Never derived from a version comparison —
   * every entry cites the retained help that advertises (or lacks) the flag.
   */
  nativeDurationFlag: CliRouteDurationFlag | null;
  /**
   * The exact option spellings this route's line declares for the roles a wrapper needs, or null
   * when the line has no route. Never derived from an option's name, from a sibling route, or from
   * a version comparison: every entry cites the vendored profiler declaration it was read from.
   */
  options: CliRouteOptions | null;
};

/** A duration flag advertised by a route's retained help, with the evidence that advertises it. */
export type CliRouteDurationFlag = { flag: string; provenance: string };

/**
 * Option spellings for one route, keyed by the role the wrapper needs (`package`, `duration`,
 * `device`, `output`, `save`, `format`, `session`, `sql`, `envelope`). A role is present only when
 * the line's own declaration advertises it, so a missing role means "this line does not offer it",
 * never "guess a spelling".
 */
export type CliRouteOptions = { names: Readonly<Record<string, string>>; provenance: string };

export type CliVersionLine = "0.4.x" | "0.5.x";

/** The 0.4.x utilities gate. Measured 2026-08-12 on 0.4.2, retained 2026-09-15 as invocation 012
 * (0.4.4, exit 1) and invocations 137-141 (0.5.0, exit 3). Source: PERF_ENV044 / PERF_ENV050. */
export const PICO_CLI_UTILITIES_GATE_PATTERN = /not installed[\s\S]{0,120}pico-cli setup/i;
/** 0.5.0 profiler resolution requires an absolute PICO_HOME before any perf delegation
 * (source-inspected PERF_ENV050; not help-observed on this host). */
export const PICO_CLI_ENVIRONMENT_PATTERN = /PICO_HOME is not set|PICO_HOME must be an absolute path/i;
/** Usage dumps and router rejections: the wrapped argv no longer matches the installed CLI.
 * `Unknown perf subcommand` / `Unknown perf <resource> action` are the 0.5.0 router texts
 * (source-inspected PERF_ENV050). */
export const PICO_CLI_USAGE_DRIFT_PATTERN = /unknown (?:perf )?(?:sub)?command|unknown perf \S+ action|unknown option|unknown argument|missing required|\busage:/i;

const USAGE_SECTION_PATTERN = /\busage\b/i;

// Route tables. Every argv below is traceable to retained help bytes copied into
// test/fixtures/picocli/help/<version>/NNN.* (index.json maps NNN to
// evidence/2026-09-15-cli050-sdk61-evolution-audit-001/RAW_HELP_INDEX_002.json) or to the
// byte-checked source excerpts in CLI050_STATIC_EXCERPTS_001.json (K044, K050, WATCH_ARGS050,
// CAPTURE_ARGS050, PERF_ROUTER050, PERF_ENV050, PERF_ENV044). Colon aliases retained by 0.5.0
// (`mcp:dev-knowledge`, `knowledge:server`) are single argv tokens and are deliberately not used;
// the removed spaced `mcp dev-knowledge` route is never resurrected on 0.5.x, and the former
// `perf monitor run` route is rejected by the 0.5.0 router and appears in no table.
type RouteTable = Record<CliOperation, { argv: readonly string[] | null; provenance: string; exitZeroHelpObserved: boolean; nativeDurationFlag?: CliRouteDurationFlag; options?: CliRouteOptions }>;

// Profiler option facts. The perf family is delegated to a VENDORED profiler package, so the
// option spellings belong to that package's version, not to the pico-cli version: 0.4.4 bundles
// `package/vendor/profiler-cli/pspp-profiler-cli-0.1.0.tgz` (sha256 13d029ef…4a0cfe2) and 0.5.0
// bundles `pspp-profiler-cli-0.2.0.tgz` (sha256 9e78d481…0eac85d). Both nested archives were read
// in memory from the official tarballs in
// evidence/2026-09-15-cli050-sdk61-evolution-audit-001/ (Python tarfile; nothing extracted, nothing
// executed), at `package/dist/index.js:2` unless another member is named. `--envelope` is a GLOBAL
// program option on both lines (`createProgram()`: .option("--envelope","Output a machine-readable
// JSON envelope")), and commander is configured with neither allowUnknownOption nor
// passThroughOptions, so it must precede the resource token.
const PROFILER_0_1_PROVENANCE = "profiler 0.1.0 (bundled with pico-cli 0.4.4), package/dist/index.js:2";
const PROFILER_0_2_PROVENANCE = "profiler 0.2.0 (bundled with pico-cli 0.5.0), package/dist/index.js:2";

const LIVE_OPTIONS_0_2: CliRouteOptions = {
  // LiveRunAction.registerOptions: --package (canonical) / --app (deprecated alias, warns),
  // --device <device_id>, "-t, --duration <seconds>", "-o, --output <path> (requires --save or
  // --report-mode)", --save. Excerpt LIVE050. LiveRunAction.execute refuses an --output that is not
  // paired with --save/--report-mode, so the two are emitted together or not at all.
  names: { package: "--package", duration: "--duration", device: "--device", output: "--output", save: "--save" },
  provenance: `${PROFILER_0_2_PROVENANCE} LiveRunAction.registerOptions/execute (excerpt LIVE050)`,
};
const TRACE_RECORD_OPTIONS_0_1: CliRouteOptions = {
  // TraceRecordAction.registerOptions on 0.1.0 declares "-a, --app <package>"; it has no --package.
  names: { package: "--app", duration: "--duration", device: "--device", output: "--output" },
  provenance: `${PROFILER_0_1_PROVENANCE} TraceRecordAction.registerOptions ("-a, --app <package>", "-t, --duration", "-d, --device", "-o, --output")`,
};
const TRACE_RECORD_OPTIONS_0_2: CliRouteOptions = {
  // 0.2.0 renames the short alias's long form: "-a, --package <package>" plus "--app <package>
  // Deprecated alias for --package".
  names: { package: "--package", duration: "--duration", device: "--device", output: "--output" },
  provenance: `${PROFILER_0_2_PROVENANCE} TraceRecordAction.registerOptions ("-a, --package <package>", "-t, --duration", "-d, --device", "-o, --output")`,
};
const TRACE_DECODE_OPTIONS: CliRouteOptions = {
  // TraceDecodeAction.registerOptions is unchanged across both lines: "-f, --format <type>" and
  // "-o, --output <path>", with the trace file as the (optional) positional argument.
  names: { format: "--format", output: "--output" },
  provenance: `${PROFILER_0_1_PROVENANCE} / ${PROFILER_0_2_PROVENANCE} TraceDecodeAction.registerOptions ("-f, --format", "-o, --output")`,
};
const TRACE_LOAD_OPTIONS: CliRouteOptions = {
  // TraceLoadAction takes the trace file positionally; the session result is machine-readable only
  // through the global --envelope flag. Its default rendering is renderTraceLoad's human
  // "[TraceLoad] Session: <id>" label (excerpt TRACE_LOAD_HUMAN), which is not a JSON result.
  names: { envelope: "--envelope" },
  provenance: `${PROFILER_0_1_PROVENANCE} / ${PROFILER_0_2_PROVENANCE} createProgram global --envelope + TraceLoadAction (excerpts TRACE_LOAD_HUMAN, TRACE_JSON_ENVELOPE)`,
};
const TRACE_QUERY_OPTIONS: CliRouteOptions = {
  // TraceQueryAction declares --session and --sql on both lines. 0.2.0 additionally declares
  // outputMode:"envelope" (excerpt TRACE_QUERY_SCHEMA) so it always emits the envelope; 0.1.0 does
  // not, so the global flag is passed on both lines rather than inferred from the version.
  names: { session: "--session", sql: "--sql", envelope: "--envelope" },
  provenance: `${PROFILER_0_1_PROVENANCE} / ${PROFILER_0_2_PROVENANCE} TraceQueryAction.registerOptions ("--session", "--sql") + createProgram global --envelope (excerpts TRACE_QUERY_SCHEMA, TRACE_QUERY_ROWS)`,
};

const ROUTES_0_4: RouteTable = {
  // exitZeroHelpObserved cites the fixture index entry that holds the exit-0 help for the route.
  "knowledge-server": {
    argv: ["mcp", "dev-knowledge"],
    provenance: "0.4.4 invocation 062 (`mcp dev-knowledge --help`, exit 0) and registration excerpt K044",
    exitZeroHelpObserved: true, // index.json 0.4.4/062
  },
  // No nativeDurationFlag on this line: retained help 0.4.4/025 advertises --launch-timeout only,
  // and WATCH044 shows the monitoring loop bounded by an internal 30 s constant with no flag.
  "watch-crash": { argv: ["app", "watch-crash"], provenance: "0.4.4 invocation 025 (`app watch-crash --help`, exit 0)", exitZeroHelpObserved: true /* index.json 0.4.4/025 */ },
  "capture-record": { argv: ["capture", "record"], provenance: "0.4.4 invocation 026 (`capture record --help`, exit 0)", exitZeroHelpObserved: true /* index.json 0.4.4/026 */ },
  "perf-live": {
    argv: null,
    provenance: "no 0.4.x live-collection route is dispatched: 0.4.4 invocation 012 (`perf --help`) exited 1 at the "
      + "utilities gate (PERF_ENV044 fails before delegating any perf argv) and the former `perf monitor run` route is "
      + "rejected by the 0.5.0 router (PERF_ROUTER050); live collection is routed on 0.5.x only",
    exitZeroHelpObserved: false, // no route, no help
  },
  // The four trace routes have no retained exit-0 help: the only 0.4.4 perf observation (index.json
  // 0.4.4/012) exited 1 at the utilities gate, so the provisioned 0.1.0 profiler help was never seen.
  "trace-record": { argv: ["perf", "trace", "record"], provenance: "PERF_ENV044 forwards argv to the vendored 0.1.0 profiler; reachability is decided by the utilities gate observed in 0.4.4 invocation 012", exitZeroHelpObserved: false, options: TRACE_RECORD_OPTIONS_0_1 },
  "trace-decode": { argv: ["perf", "trace", "decode"], provenance: "PERF_ENV044 forwards argv to the vendored 0.1.0 profiler; reachability is decided by the utilities gate observed in 0.4.4 invocation 012", exitZeroHelpObserved: false, options: TRACE_DECODE_OPTIONS },
  "trace-load": { argv: ["perf", "trace", "load"], provenance: "PERF_ENV044 forwards argv to the vendored 0.1.0 profiler; reachability is decided by the utilities gate observed in 0.4.4 invocation 012", exitZeroHelpObserved: false, options: TRACE_LOAD_OPTIONS },
  "trace-query": { argv: ["perf", "trace", "query"], provenance: "PERF_ENV044 forwards argv to the vendored 0.1.0 profiler; reachability is decided by the utilities gate observed in 0.4.4 invocation 012", exitZeroHelpObserved: false, options: TRACE_QUERY_OPTIONS },
};

const ROUTES_0_5: RouteTable = {
  // exitZeroHelpObserved cites the fixture index entry that holds the exit-0 help for the route.
  "knowledge-server": {
    argv: ["knowledge", "server"],
    provenance: "0.5.0 invocation 136 (`knowledge server --help`, exit 0) and registration excerpt K050 (spaced `mcp dev-knowledge` removed)",
    exitZeroHelpObserved: true, // index.json 0.5.0/136
  },
  "watch-crash": {
    argv: ["app", "watch-crash"],
    provenance: "0.5.0 invocation 096 (`app watch-crash --help`, exit 0) and WATCH_ARGS050",
    exitZeroHelpObserved: true, // index.json 0.5.0/096
    nativeDurationFlag: {
      flag: "--monitor-timeout",
      provenance: "index.json 0.5.0/096 (`app watch-crash --help`, exit 0) advertises "
        + "`--monitor-timeout <seconds>  Total wall-clock seconds to wait for the process and crash signals (default: 30)`; "
        + "WATCH_ARGS050 declares the same option and WATCH050 shows one shared deadline covering launch, PID wait, polling and final log collection",
    },
  },
  "capture-record": { argv: ["capture", "record"], provenance: "0.5.0 invocation 097 (`capture record --help`, exit 0) and CAPTURE_ARGS050", exitZeroHelpObserved: true /* index.json 0.5.0/097 */ },
  // The five perf routes have no retained exit-0 help: every 0.5.0 perf child observation
  // (index.json 0.5.0/137-141) exited 3 at the utilities gate, so the help a provisioned 0.2.0
  // profiler renders (re-rendered by the CLI under `pico-cli perf`, PERF_ROUTER050) was never seen.
  "perf-live": {
    argv: ["perf", "live", "run"],
    provenance: "PERF_ROUTER050 permits live: run/start/stop; 0.5.0 invocation 139 (`perf live --help`) exited 3 at the utilities gate, so evidence decides reachability",
    exitZeroHelpObserved: false,
    options: LIVE_OPTIONS_0_2,
  },
  "trace-record": { argv: ["perf", "trace", "record"], provenance: "PERF_ROUTER050 permits trace: record/stop/decode/load/query/analysis; 0.5.0 invocation 141 (`perf trace --help`) exited 3 at the utilities gate", exitZeroHelpObserved: false, options: TRACE_RECORD_OPTIONS_0_2 },
  "trace-decode": { argv: ["perf", "trace", "decode"], provenance: "PERF_ROUTER050 permits trace: record/stop/decode/load/query/analysis; 0.5.0 invocation 141 (`perf trace --help`) exited 3 at the utilities gate", exitZeroHelpObserved: false, options: TRACE_DECODE_OPTIONS },
  "trace-load": { argv: ["perf", "trace", "load"], provenance: "PERF_ROUTER050 permits trace: record/stop/decode/load/query/analysis; 0.5.0 invocation 141 (`perf trace --help`) exited 3 at the utilities gate", exitZeroHelpObserved: false, options: TRACE_LOAD_OPTIONS },
  "trace-query": { argv: ["perf", "trace", "query"], provenance: "PERF_ROUTER050 permits trace: record/stop/decode/load/query/analysis; 0.5.0 invocation 141 (`perf trace --help`) exited 3 at the utilities gate", exitZeroHelpObserved: false, options: TRACE_QUERY_OPTIONS },
};

/** 0.4.x and older lines use the 0.4.4 table; 0.5.x and every newer line is probed with the newest
 * retained table. The table only supplies candidate argv: the help evidence decides the state. */
export function cliVersionLine(version: string): CliVersionLine {
  const match = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(version.trim());
  if (match && Number(match[1]) === 0 && Number(match[2]) <= 4) return "0.4.x";
  return "0.5.x";
}

export function cliOperationRoutes(version: string): CliOperationRoute[] {
  const line = cliVersionLine(version);
  const table = line === "0.4.x" ? ROUTES_0_4 : ROUTES_0_5;
  return CLI_OPERATIONS.map((operation) => ({
    operation,
    argvPrefix: table[operation].argv ? [...table[operation].argv] : null,
    provenance: `${line}: ${table[operation].provenance}`,
    exitZeroHelpObserved: table[operation].exitZeroHelpObserved,
    nativeDurationFlag: table[operation].nativeDurationFlag
      ? { ...table[operation].nativeDurationFlag as CliRouteDurationFlag }
      : null,
    options: cloneRouteOptions(table[operation].options ?? null),
  }));
}

function cloneRouteOptions(options: CliRouteOptions | null): CliRouteOptions | null {
  return options ? { names: { ...options.names }, provenance: options.provenance } : null;
}

/**
 * The option spellings the resolved line declares for an operation, or null when the line has no
 * route for it. Like cliOperationNativeDurationFlag this is a POSITIVE claim about the installed
 * package, so an unparseable version answers null rather than inheriting the newest table. A caller
 * must still hold a `supported` capability for the same target before dispatching.
 */
export function cliOperationOptions(version: string, operation: CliOperation): CliRouteOptions | null {
  if (!/^v?\d+\.\d+(?:\.|$)/.test(version.trim())) return null;
  return cliOperationRoutes(version).find((route) => route.operation === operation)?.options ?? null;
}

/**
 * The duration flag this operation's line advertises, or null when it advertises none. A caller
 * must still hold a `supported` capability for the same target before dispatching: this answers
 * "does the resolved line document the flag", never "can this package run the operation".
 */
export function cliOperationNativeDurationFlag(version: string, operation: CliOperation): CliRouteDurationFlag | null {
  // A duration flag is a POSITIVE claim about the installed CLI. cliOperationRoutes deliberately
  // probes an unrecognizable line with the newest table (candidate argv the evidence then judges),
  // but an unparseable version must never inherit that table's flag: nothing would judge it.
  if (!/^v?\d+\.\d+(?:\.|$)/.test(version.trim())) return null;
  return cliOperationRoutes(version).find((route) => route.operation === operation)?.nativeDurationFlag ?? null;
}

export type HelpFailureKind = "utilities-not-installed" | "environment" | "unknown-command" | "nonzero-exit";

/** Classify the text of a nonzero help invocation. Shared with the scheduled surface comparator. */
export function classifyHelpFailureText(text: string): HelpFailureKind {
  if (PICO_CLI_UTILITIES_GATE_PATTERN.test(text)) return "utilities-not-installed";
  if (PICO_CLI_ENVIRONMENT_PATTERN.test(text)) return "environment";
  if (/unknown (?:perf )?(?:sub)?command|unknown perf \S+ action|unknown option|unknown argument|missing required/i.test(text)) return "unknown-command";
  return "nonzero-exit";
}

export type HelpClassification = { state: OperationCapability["state"]; reason: string };

export type HelpClassificationOptions = {
  spawnError?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** See CliOperationRoute.exitZeroHelpObserved; defaults to false (the conservative branch). */
  exitZeroHelpObserved?: boolean;
};

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * pico-cli 0.5.0 renders help with ANSI SGR styling whenever FORCE_COLOR is set — and Claude Code
 * sets FORCE_COLOR=1 for every child it spawns, the MCP server included. `\u001b[1mUsage\u001b[22m:`
 * hides the usage section from a word-boundary match ("mUsage") and the styled `$ pico-cli …` line
 * from the route match, so the 2026-09-16 managed 0.5.0 discovery classified knowledge-server,
 * watch-crash and capture-record as malformed-help. Classification reads through the styling; the
 * retained bytes stay exactly as the CLI wrote them.
 */
const ANSI_SGR = /\u001b\[[0-9;]*m/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}

/**
 * What the help's `pico-cli …` usage/invocation lines say about the route. Every retained child
 * help (0.4.4 062/025/026, 0.5.0 136/096/097) carries a usage line that starts with the route's
 * full argv (`$ pico-cli knowledge server`), and every retained parent help (0.4.4 002/011,
 * 0.5.0 072/080/082) carries `pico-cli <proper prefix of the route> <placeholder>` with the
 * placeholder starting `[` or `<` (or the line ending). Descriptions are ignored on purpose:
 * the 0.5.0 `knowledge --help` parent (080) mentions "knowledge server" in prose.
 */
function usageRouteMatch(argvPrefix: string[], text: string): "route" | "parent" | null {
  let parent = false;
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\$?\s*pico-cli(?:\s+(.*))?$/.exec(raw.trim());
    if (!match) continue;
    const tokens = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
    let matched = 0;
    while (matched < argvPrefix.length && tokens[matched] === argvPrefix[matched]) matched += 1;
    if (matched === argvPrefix.length) return "route";
    const next = tokens[matched];
    if (next === undefined || next.startsWith("[") || next.startsWith("<")) parent = true;
  }
  return parent ? "parent" : null;
}

/**
 * Pure classification of one bounded `<argvPrefix> --help` observation. Nonzero exits are read
 * through their text (utilities gate, environment, router rejection, other). Exit-zero output must
 * contain a usage section whose `pico-cli …` line names the route's full argv to be `supported`;
 * a proven parent usage shape is `unavailable` (generic parent help); any other exit-0 shape is
 * `unavailable` only for routes with a retained exit-0 example and `unknown` otherwise; output
 * without a usage section is malformed (`unknown`).
 */
export function classifyHelpOutput(
  operation: CliOperation,
  argvPrefix: string[],
  observation: Pick<HelpObservation, "exitCode" | "timedOut" | "outputTruncated">,
  stdout: string,
  stderr: string,
  options: HelpClassificationOptions = {},
): HelpClassification {
  const phrase = argvPrefix.join(" ");
  const probe = `\`${phrase} --help\``;
  if (options.spawnError) {
    return { state: "unknown", reason: `incomplete: the bounded ${probe} probe for ${operation} did not complete: ${options.spawnError}` };
  }
  if (observation.timedOut) {
    const bound = options.timeoutMs !== undefined ? `${options.timeoutMs} ms` : "its time bound";
    return { state: "unknown", reason: `timed-out: ${probe} exceeded ${bound}; ${operation} is not classified from a killed probe` };
  }
  if (observation.outputTruncated) {
    const cap = options.maxOutputBytes !== undefined ? `${options.maxOutputBytes}-byte` : "its byte";
    return { state: "unknown", reason: `output-truncated: ${probe} exceeded the ${cap} capture cap; ${operation} is not classified from partial output` };
  }
  if (observation.exitCode === null) {
    return { state: "unknown", reason: `incomplete: ${probe} ended without an exit code; ${operation} is not classified` };
  }
  const text = `${stripAnsi(stdout)}\n${stripAnsi(stderr)}`;
  if (observation.exitCode !== 0) {
    const kind = classifyHelpFailureText(text);
    const detail = firstLine(stripAnsi(stderr)) || firstLine(stripAnsi(stdout));
    const suffix = detail ? `: ${detail}` : "";
    switch (kind) {
      case "utilities-not-installed":
        return { state: "unavailable", reason: `utilities-not-installed: ${probe} exited ${observation.exitCode} at the CLI's utilities gate${suffix}` };
      case "environment":
        return { state: "unavailable", reason: `environment: ${probe} exited ${observation.exitCode} because the CLI's environment is incomplete${suffix}` };
      case "unknown-command":
        return { state: "unavailable", reason: `unknown-command: the installed CLI rejected ${probe} (exit ${observation.exitCode})${suffix}` };
      default:
        return { state: "unavailable", reason: `nonzero-exit: ${probe} exited ${observation.exitCode} without help${suffix}` };
    }
  }
  if (text.trim().length === 0) {
    return { state: "unknown", reason: `malformed-help: ${probe} exited 0 with no output` };
  }
  if (!USAGE_SECTION_PATTERN.test(text)) {
    return { state: "unknown", reason: `malformed-help: ${probe} exited 0 but printed no usage section (${firstLine(text).slice(0, 80)})` };
  }
  const routeMatch = usageRouteMatch(argvPrefix, text);
  if (routeMatch !== "route") {
    const usage = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /pico-cli|usage/i.test(line) && !/^usage:?$/i.test(line)) ?? firstLine(text);
    const detail = `no pico-cli usage line in the help rendered for ${probe} names \`${phrase}\` (${usage.slice(0, 120)})`;
    if (routeMatch === "parent") {
      return { state: "unavailable", reason: `generic-parent-help: ${detail}; a parent command's usage was rendered instead of the operation's` };
    }
    if (options.exitZeroHelpObserved === true) {
      return { state: "unavailable", reason: `generic-parent-help: ${detail}; the usage rule is validated by retained exit-0 help for this route` };
    }
    return { state: "unknown", reason: `generic-parent-help: ${detail}; no retained exit-0 help validates this route's usage shape, so it stays unknown` };
  }
  return { state: "supported", reason: `help-names-operation: ${probe} exited 0 and a pico-cli usage line names \`${phrase}\`` };
}

export type ObservedHelp = {
  observation: HelpObservation;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export function unknownCapability(operation: CliOperation, reason: string, argvPrefix: string[] | null = null): OperationCapability {
  return { operation, state: "unknown", argvPrefix: argvPrefix ? [...argvPrefix] : null, reason, evidence: [] };
}

/** Classify one operation from its route and the observations recorded for that route. */
export function classifyOperation(route: CliOperationRoute, observations: ObservedHelp[]): OperationCapability {
  if (route.argvPrefix === null) {
    return { operation: route.operation, state: "unavailable", argvPrefix: null, reason: `no-route: ${route.provenance}`, evidence: [] };
  }
  const argvPrefix = [...route.argvPrefix];
  if (observations.length === 0) {
    return unknownCapability(route.operation, `no-discovery: no bounded help observation was recorded for \`${argvPrefix.join(" ")}\``, argvPrefix);
  }
  const latest = observations[observations.length - 1];
  const outcome = classifyHelpOutput(route.operation, argvPrefix, latest.observation, latest.stdout, latest.stderr, {
    exitZeroHelpObserved: route.exitZeroHelpObserved,
    ...(latest.spawnError !== undefined ? { spawnError: latest.spawnError } : {}),
    ...(latest.timeoutMs !== undefined ? { timeoutMs: latest.timeoutMs } : {}),
    ...(latest.maxOutputBytes !== undefined ? { maxOutputBytes: latest.maxOutputBytes } : {}),
  });
  return {
    operation: route.operation,
    state: outcome.state,
    argvPrefix,
    reason: outcome.reason,
    evidence: observations.map((item) => cloneObservation(item.observation)),
  };
}

function cloneObservation(observation: HelpObservation): HelpObservation {
  return { ...observation, argv: [...observation.argv] };
}

function cloneCapability(capability: OperationCapability): OperationCapability {
  return {
    ...capability,
    argvPrefix: capability.argvPrefix ? [...capability.argvPrefix] : null,
    evidence: capability.evidence.map(cloneObservation),
  };
}

/** `complete` only when every operation reached a terminal classification. */
export function capabilityCoverage(set: Pick<CliCapabilitySet, "operations">): "complete" | "partial" {
  return set.operations.every((operation) => operation.state !== "unknown") ? "complete" : "partial";
}

const IDENTITY_FIELDS: readonly (keyof CliCapabilityIdentity)[] = ["version", "executablePath", "packageJsonSha256", "executionTreeSha256"];

export function sameCliCapabilityIdentity(left: CliCapabilityIdentity, right: CliCapabilityIdentity): boolean {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

/** Null when identical; otherwise the fields that differ, so a stale record explains itself. */
export function describeIdentityDrift(recorded: CliCapabilityIdentity, current: CliCapabilityIdentity): string | null {
  const drifted = IDENTITY_FIELDS.filter((field) => recorded[field] !== current[field]);
  if (drifted.length === 0) return null;
  return drifted.map((field) => `${field} changed (recorded ${abbreviate(recorded[field])}, current ${abbreviate(current[field])})`).join("; ");
}

function abbreviate(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

/** Content-addressed key for the whole identity (used for the immutable report directory). */
export function cliCapabilityIdentityKey(identity: CliCapabilityIdentity): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify(IDENTITY_FIELDS.map((field) => identity[field])), "utf8")
    .digest("hex")
    .slice(0, 24);
}

export type EvidenceReader = (file: string) => Buffer | null;

export type CapabilityVerification = { status: "ok" } | { status: "rejected"; reason: string };

/**
 * Re-read, hash-verify and re-classify one record's evidence. The stored state is a cache: it is
 * honored only when the retained bytes reproduce it under the route table for `version`.
 */
export function verifyOperationCapability(
  capability: OperationCapability,
  readEvidence: EvidenceReader,
  version: string,
): CapabilityVerification {
  const { operation } = capability;
  if (capability.argvPrefix === null) {
    return capability.state === "unavailable" && capability.evidence.length === 0
      ? { status: "ok" }
      : { status: "rejected", reason: `report-inconsistent: ${operation} has no route but is stored as ${capability.state} with ${capability.evidence.length} observation(s)` };
  }
  if (capability.evidence.length === 0) {
    return capability.state === "unknown"
      ? { status: "ok" }
      : { status: "rejected", reason: `report-inconsistent: ${operation} is stored as ${capability.state} without any help observation` };
  }
  const observed: ObservedHelp[] = [];
  for (const observation of capability.evidence) {
    const stdout = readEvidence(observation.stdoutPath);
    if (!stdout) return { status: "rejected", reason: `evidence-missing: ${operation} evidence bytes at ${observation.stdoutPath} could not be read; request fresh bounded discovery (ensure_pico_cli)` };
    const stderr = readEvidence(observation.stderrPath);
    if (!stderr) return { status: "rejected", reason: `evidence-missing: ${operation} evidence bytes at ${observation.stderrPath} could not be read; request fresh bounded discovery (ensure_pico_cli)` };
    if (sha256Hex(stdout) !== observation.stdoutSha256) {
      return { status: "rejected", reason: `evidence-mismatch: ${operation} stdout bytes at ${observation.stdoutPath} no longer hash to the recorded value` };
    }
    if (sha256Hex(stderr) !== observation.stderrSha256) {
      return { status: "rejected", reason: `evidence-mismatch: ${operation} stderr bytes at ${observation.stderrPath} no longer hash to the recorded value` };
    }
    observed.push({ observation, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
  }
  const tableRoute = cliOperationRoutes(version).find((route) => route.operation === operation);
  const recomputed = classifyOperation({
    operation,
    argvPrefix: capability.argvPrefix,
    provenance: "stored record",
    exitZeroHelpObserved: tableRoute?.exitZeroHelpObserved ?? false,
    // Re-verification only re-classifies the retained bytes; the dispatch-time duration flag and
    // option spellings are read from the live route table, never from a stored record.
    nativeDurationFlag: null,
    options: null,
  }, observed);
  if (recomputed.state !== capability.state) {
    return {
      status: "rejected",
      reason: `report-inconsistent: ${operation} is stored as ${capability.state} but its retained bytes classify as ${recomputed.state} (${recomputed.reason})`,
    };
  }
  return { status: "ok" };
}

export function verifyCapabilitySet(set: CliCapabilitySet, readEvidence: EvidenceReader): CapabilityVerification {
  for (const capability of set.operations) {
    const verification = verifyOperationCapability(capability, readEvidence, set.identity.version);
    if (verification.status !== "ok") return verification;
  }
  return { status: "ok" };
}

/**
 * The only path from a stored set to a dispatch decision. Missing discovery, a stale identity,
 * missing or mismatched evidence bytes, and a stored state its bytes cannot reproduce all yield
 * `unknown`; old capabilities are never applied to a newly resolved target.
 */
export function resolveOperationCapability(args: {
  set: CliCapabilitySet | null;
  target: CliCapabilityIdentity;
  operation: CliOperation;
  readEvidence: EvidenceReader;
}): OperationCapability {
  const { set, target, operation, readEvidence } = args;
  if (!set) {
    return unknownCapability(operation, "no-discovery: no bounded discovery evidence is bound to this execution target; call ensure_pico_cli for fresh bounded discovery");
  }
  const drift = describeIdentityDrift(set.identity, target);
  if (drift) {
    return unknownCapability(operation, `stale-identity: the recorded capability identity does not match the resolved execution target (${drift}); request fresh bounded discovery (ensure_pico_cli)`);
  }
  const record = set.operations.find((candidate) => candidate.operation === operation);
  if (!record) {
    return unknownCapability(operation, `no-discovery: the bound capability report has no record for ${operation}; call ensure_pico_cli for fresh bounded discovery`);
  }
  const verification = verifyOperationCapability(record, readEvidence, set.identity.version);
  if (verification.status !== "ok") return unknownCapability(operation, verification.reason, record.argvPrefix);
  return cloneCapability(record);
}

/** The `unknown` reasons that mean "no usable evidence is bound to this target" rather than "the
 * evidence was read and could not be classified". Only these justify one fresh bounded discovery
 * from a consumer that is already performing a real CLI-backed operation; a classified `unknown`
 * (a timed-out probe, malformed help, an exhausted probe budget) *is* the evidence, and re-probing
 * it on every call would turn one bounded discovery into an unbounded retry loop. */
const FRESH_DISCOVERY_REASON_PATTERN = /^(?:no-discovery|stale-identity|evidence-missing|evidence-mismatch|report-inconsistent):/;

export function capabilityNeedsFreshDiscovery(reason: string): boolean {
  return FRESH_DISCOVERY_REASON_PATTERN.test(reason);
}

/** The failure classes a capability refusal can carry — a subset of picocli.ts's PicoCliFailureClass. */
export type CapabilityFailureClass = "setup-required" | "environment" | "flag-or-version-drift" | "cli-unusable";

/**
 * Honest failure class for a capability that cannot serve its route. The reason prefixes are the
 * stable contract of `classifyHelpOutput`, so this map lives beside them (and beside
 * capabilityNeedsFreshDiscovery) rather than being re-derived by each consumer.
 */
export function capabilityFailureClass(capability: Pick<OperationCapability, "reason">): CapabilityFailureClass {
  if (/^utilities-not-installed:/.test(capability.reason)) return "setup-required";
  if (/^environment:/.test(capability.reason)) return "environment";
  if (/^unknown-command:/.test(capability.reason)) return "flag-or-version-drift";
  return "cli-unusable";
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CAPABILITY_STATES = new Set<OperationCapability["state"]>(["supported", "unavailable", "unknown"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseObservation(value: unknown): HelpObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isStringArray(record.argv) || record.argv.length === 0) return null;
  if (record.exitCode !== null && (typeof record.exitCode !== "number" || !Number.isSafeInteger(record.exitCode))) return null;
  if (typeof record.timedOut !== "boolean" || typeof record.outputTruncated !== "boolean") return null;
  if (typeof record.stdoutPath !== "string" || typeof record.stderrPath !== "string") return null;
  if (typeof record.stdoutSha256 !== "string" || !SHA256_HEX.test(record.stdoutSha256)) return null;
  if (typeof record.stderrSha256 !== "string" || !SHA256_HEX.test(record.stderrSha256)) return null;
  return {
    argv: [...record.argv],
    exitCode: record.exitCode as number | null,
    timedOut: record.timedOut,
    outputTruncated: record.outputTruncated,
    stdoutPath: record.stdoutPath,
    stderrPath: record.stderrPath,
    stdoutSha256: record.stdoutSha256,
    stderrSha256: record.stderrSha256,
  };
}

function parseCapability(value: unknown): OperationCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.operation !== "string" || !CLI_OPERATIONS.includes(record.operation as CliOperation)) return null;
  if (typeof record.state !== "string" || !CAPABILITY_STATES.has(record.state as OperationCapability["state"])) return null;
  if (record.argvPrefix !== null && !isStringArray(record.argvPrefix)) return null;
  if (typeof record.reason !== "string") return null;
  if (!Array.isArray(record.evidence)) return null;
  const evidence: HelpObservation[] = [];
  for (const item of record.evidence) {
    const observation = parseObservation(item);
    if (!observation) return null;
    evidence.push(observation);
  }
  return {
    operation: record.operation as CliOperation,
    state: record.state as OperationCapability["state"],
    argvPrefix: record.argvPrefix === null ? null : [...(record.argvPrefix as string[])],
    reason: record.reason,
    evidence,
  };
}

export function parseCliCapabilityIdentity(value: unknown): CliCapabilityIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || record.version.length === 0 || record.version.length > 64) return null;
  if (typeof record.executablePath !== "string" || record.executablePath.length === 0) return null;
  if (typeof record.packageJsonSha256 !== "string" || !SHA256_HEX.test(record.packageJsonSha256)) return null;
  if (typeof record.executionTreeSha256 !== "string" || !SHA256_HEX.test(record.executionTreeSha256)) return null;
  return {
    version: record.version,
    executablePath: record.executablePath,
    packageJsonSha256: record.packageJsonSha256,
    executionTreeSha256: record.executionTreeSha256,
  };
}

/** Versioned reader for schema 1. Returns a fresh, structurally validated copy or null. */
export function parseCliCapabilitySet(value: unknown): CliCapabilitySet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  const identity = parseCliCapabilityIdentity(record.identity);
  if (!identity) return null;
  const checkedAtMs = typeof record.checkedAt === "string" ? Date.parse(record.checkedAt) : Number.NaN;
  if (!Number.isFinite(checkedAtMs) || new Date(checkedAtMs).toISOString() !== record.checkedAt) return null;
  if (!Array.isArray(record.operations)) return null;
  const operations: OperationCapability[] = [];
  const seen = new Set<CliOperation>();
  for (const item of record.operations) {
    const capability = parseCapability(item);
    if (!capability || seen.has(capability.operation)) return null;
    seen.add(capability.operation);
    operations.push(capability);
  }
  return { schemaVersion: 1, identity, checkedAt: record.checkedAt as string, operations };
}

export function sha256Hex(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
