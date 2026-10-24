import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import crypto from "node:crypto";
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
  type PicoCliCommandResult,
  type PicoCliFailureClass,
  type PicoCliProvenance,
  type PicoCliRetainedObservation,
  cliWrapperContractShape,
} from "./picocli.js";
import {
  capabilityFailureClass,
  capabilityNeedsFreshDiscovery,
  cliOperationOptions,
  type CliRouteOptions,
  type OperationCapability,
} from "./clicapabilities.js";

export { picoCliPath } from "./picocli.js";

/**
 * perfcli.ts — perf_diagnose: PICO's OFFICIAL perf profiler routed through our loop.
 * (v31: CLI probing moved to the shared picocli.ts module; the diagnose core is exported so
 * SpatialBench's perfSource:'pico-cli' axis reuses it directly instead of round-tripping a tool.)
 *
 * C4 (2026-09-15) replaced the retired `perf monitor run --app … -d … -o …` invocation. `monitor`
 * is not in the 0.5.0 router's allow-list (`daemon|session|doctor|live|trace`, excerpt
 * PERF_ROUTER050) and is rejected before any delegation, so the wrapper now dispatches
 * `perf live run --package … --duration … --device … --save --output …` — every flag read from the
 * vendored profiler's own declarations through clicapabilities' route-option facts, never guessed.
 * Dispatch happens ONLY against verified `perf live run` capability evidence bound to the resolved
 * package; an unprovisioned or environment-gated profiler is refused with the CLI's own reason and
 * the retained evidence paths, and nothing here ever sets PICO_HOME or runs setup.
 *
 * The report is no longer trusted because it parsed. adaptPerfReport checks the report's identity
 * (`metadata.package` on the 0.2.0 schema, `metadata.app` on 0.1.0 — there is no version field, so
 * that key IS the schema signal), refuses a file that predates the run, and grades the measurement
 * (`complete` / `partial` / `missing`) so an official SKIP / INSUFFICIENT_DATA diagnosis can never
 * be read as a passing budget.
 *
 * HONESTY (load-bearing): all numbers are real measurements from pico-cli; anything the device
 * does not report arrives as 0/absent — on the EMULATOR the GPU counters are typically
 * unparseable (verified 2026-07-12), so gpu* zeros mean "not measured", never "GPU idle". The
 * diagnosis is pico-cli's own rule engine, quoted verbatim with its rule + evidence. Evidence
 * class: structural — perf numbers are NOT a substitute for LOOKING at captured frames.
 */

const HONESTY =
  "All metrics are real pico-cli measurements; absent counters arrive as 0/absent — on the emulator " +
  "GPU counters are typically unparseable, so gpu* zeros mean 'not measured', never 'GPU idle'. The " +
  "diagnosis block is pico-cli's own rule engine quoted verbatim (rule + evidence included). " +
  "measurement says how much was actually measured: 'missing' (including the profiler's own " +
  "SKIP/INSUFFICIENT_DATA) is never a pass, and Spatial Runtime FPS never stands in for app FPS. " +
  "Evidence class: structural — not a substitute for LOOKING at a capture.";

/** Source/freshness-neutral guidance for an unprovisioned utility payload. Byte-pinned by
 * test/distribution-adoption.mjs across every CLI wrapper: do not reword per branch. */
const SETUP_REQUIRED_NOTE =
  "The resolved CLI package is runnable, but this utility payload is not provisioned. Run the returned command manually, then retry.";

const PERF_OPERATION = "perf-live" as const;
const DEFAULT_PERF_DEVICE = "emulator-5554";
/** File name of the whole raw report copied into the immutable observation run directory. */
const RETAINED_REPORT_FILE = "live-report.json";

/**
 * What a refusal on a line with NO live-collection route does not establish. Deliberately a
 * separate field: the setup sentence is byte-pinned and source/freshness-neutral, so the limit
 * cannot be folded into it, and a caller that reads only the failure class would otherwise be told
 * to provision a payload and retry an operation this line still could not dispatch afterwards.
 */
const NO_LIVE_ROUTE_LIMIT =
  "The resolved pico-cli line advertises no live-collection route at all (perf-live resolved as no-route), "
  + "so provisioning the missing utility payload would still leave this wrapper without a route to dispatch here; "
  + "the adopted failure class comes from a sibling perf route's own gate (familyGate) and is evidence about the "
  + "shared payload, not about the live route. Live collection is routed on the 0.5.x line.";

/** How much of the requested measurement the returned report actually contains. */
export type PerfMeasurement = "complete" | "partial" | "missing";

export type PerfDiagnoseResult = {
  status: "ok" | "unavailable" | "failed";
  /** complete = app FPS and every declared counter group measured; partial = app FPS measured but
   * some declared counters are absent/all-zero (the emulator's unparseable-GPU case); missing =
   * no app FPS at all, including the profiler's own SKIP/INSUFFICIENT_DATA diagnosis. */
  measurement?: PerfMeasurement;
  failureClass?: PicoCliFailureClass;
  note?: string;
  error?: string;
  outputTail?: string;
  source?: string;
  reportPath?: string;
  /** Which published report schema the file matched: "0.2.0" (metadata.package) or "0.1.0"
   * (metadata.app). Neither schema carries a version field, so this is derived from that key. */
  reportVersion?: string | null;
  /** The resolved pico-cli version that produced the report (its bundled profiler is what wrote it). */
  producerVersion?: string | null;
  rawReportPath?: string;
  rawReportSha256?: string;
  /** Bounded selection of the report: metadata, diagnosis, summary and the top jank windows.
   * rawData (the per-sample array) is deliberately excluded. */
  view?: PerfReportView | null;
  /** Declared summary groups that are absent or all-zero — "not measured", never "measured zero". */
  missingCounters?: string[];
  metadata?: any;
  diagnosis?: any;
  summary?: any;
  jankWindowCount?: number;
  jankWindows?: any[];
  /** The device this run was asked to profile — the caller's explicit serial, or the default this
   *  wrapper substituted when none was named. Explicit target identity: a report validated against
   *  one device must never be read as evidence about another. */
  requestedDevice?: string;
  honesty?: string;
  picoCli?: PicoCliProvenance;
  setupCommand?: { path: string; args: string[] };
  outputTruncated?: boolean;
  /** Why dispatch was refused, ALWAYS for the operation this wrapper probed (perf-live), with the
   * retained bounded-help evidence paths behind the decision. */
  capability?: PerfCapabilityDisclosure;
  /** The sibling perf route whose retained gate answer this refusal adopted, when one was adopted.
   * It is evidence about the shared utilities payload, never about the live route itself. */
  familyGate?: PerfCapabilityDisclosure;
  /** What the adopted failureClass does NOT establish. Present whenever the resolved line has no
   * live-collection route at all, because provisioning the payload would not create one. */
  remediationLimit?: string;
  retainedLog?: Record<string, unknown>;
  retainedLogError?: string;
};

export type PerfCapabilityDisclosure = {
  operation: string;
  state: OperationCapability["state"];
  reason: string;
  argvPrefix: string[] | null;
  evidence: string[];
};

export type PerfReportView = {
  package: string;
  reportId: unknown;
  durationSeconds: unknown;
  totalSamples: unknown;
  timestamp: unknown;
  timeAlignment?: unknown;
  diagnosis: unknown;
  summary: unknown;
  jankWindowCount: number;
  jankWindows: unknown[];
};

// --- argv -------------------------------------------------------------------------------------

/**
 * The dispatched live-collection argv. `--output` is emitted only together with `--save`, because
 * LiveRunAction refuses an unpaired explicit output ("`-o, --output <path>` requires `--save` (or
 * `--report-mode`, which implies save).", excerpt LIVE050); `--save` alone would write the
 * profiler's own `reports/live-report-<ISO>.json` instead of our immutable evidence path.
 */
export function perfLiveArgv(
  argvPrefix: readonly string[],
  options: CliRouteOptions | null,
  request: { packageName: string; durationSec: number; device: string; reportPath: string },
): string[] {
  const names = options?.names ?? {};
  const args = [...argvPrefix];
  if (names.package) args.push(names.package, request.packageName);
  if (names.duration) args.push(names.duration, String(request.durationSec));
  if (names.device) args.push(names.device, request.device);
  if (names.save && names.output) args.push(names.save, names.output, request.reportPath);
  return args;
}

// --- report adapter ---------------------------------------------------------------------------

export type PerfReportAdaptation = {
  status: "ok" | "unavailable" | "failed";
  measurement: PerfMeasurement;
  reportVersion: string | null;
  producerVersion: string | null;
  reason: string;
  view: PerfReportView | null;
  missingCounters: string[];
  /** Convenience mirrors of the view, kept so existing consumers (doors, SpatialBench) are unchanged. */
  metadata: unknown;
  diagnosis: unknown;
  summary: unknown;
  jankWindowCount: number;
  jankWindows: unknown[];
};

/** The declared summary groups (reporter.d.ts, both schema lines). appFps is graded separately. */
const COUNTER_GROUPS: readonly string[] = ["sysFps", "gpuUsage", "gpuFreq", "systemCpu", "appCpu", "gpuTemp"];
/** Official diagnosis vocabularies. 0.2.0 adds SKIP / INSUFFICIENT_DATA (REPORT050). */
const DIAGNOSIS_RESULTS = new Set(["PASS", "FAIL", "SKIP"]);
const DIAGNOSIS_CATEGORIES = new Set(["APP", "SPR", "APP&SPR", "NO_ISSUE", "INSUFFICIENT_DATA"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A counter group counts as measured only when it exists and reports at least one non-zero
 * number. An all-zero GPU block on the emulator is "not parsed", not "the GPU was idle". */
function groupMeasured(group: unknown): boolean {
  if (!isRecord(group)) return false;
  const numbers = Object.values(group).map(finiteNumber).filter((value): value is number => value !== null);
  return numbers.length > 0 && numbers.some((value) => value !== 0);
}

function failedAdaptation(reason: string, reportVersion: string | null, producerVersion: string | null): PerfReportAdaptation {
  return {
    status: "failed", measurement: "missing", reportVersion, producerVersion, reason,
    view: null, missingCounters: [], metadata: null, diagnosis: null, summary: null,
    jankWindowCount: 0, jankWindows: [],
  };
}

/**
 * Validate one profiler report against the run that was supposed to produce it, and grade how much
 * it actually measured. Pure: the caller reads the bytes and reports whether the path predated the
 * run. Anything that cannot be tied to THIS run (missing, empty, malformed, truncated, an unknown
 * schema, a different package or device, a file that already existed) is `failed`, never `ok`.
 */
export function adaptPerfReport(args: {
  /** The file's text, or null when it could not be read. */
  raw: string | null;
  readError?: string;
  requestedPackage: string;
  requestedDevice: string;
  producerVersion: string | null;
  /** True when the output path already existed before the run started. */
  preexisting: boolean;
}): PerfReportAdaptation {
  const producerVersion = args.producerVersion ?? null;
  if (args.preexisting) {
    return failedAdaptation(
      "the report path already existed before this run started, so its contents cannot be attributed to this measurement",
      null, producerVersion,
    );
  }
  if (args.raw === null) {
    return failedAdaptation(`the profiler report could not be read${args.readError ? `: ${args.readError}` : ""}`, null, producerVersion);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.raw);
  } catch (e) {
    return failedAdaptation(`the profiler report is not parseable JSON (truncated or malformed): ${e instanceof Error ? e.message : String(e)}`, null, producerVersion);
  }
  if (!isRecord(parsed)) return failedAdaptation("the profiler report is not a JSON object", null, producerVersion);
  const metadata = parsed.metadata;
  if (!isRecord(metadata)) return failedAdaptation("the profiler report has no metadata block", null, producerVersion);

  // Neither published schema carries a version field (reporter.d.ts, REPORT044/REPORT050), so the
  // package/app key IS the schema signal: 0.2.0 renamed metadata.app to metadata.package.
  const reportVersion = typeof metadata.package === "string" ? "0.2.0"
    : typeof metadata.app === "string" ? "0.1.0"
      : null;
  if (reportVersion === null) {
    return failedAdaptation(
      "the profiler report matches no known schema: neither metadata.package (0.2.0) nor metadata.app (0.1.0) is present",
      null, producerVersion,
    );
  }
  const reportedPackage = String(reportVersion === "0.2.0" ? metadata.package : metadata.app);
  if (reportedPackage !== args.requestedPackage) {
    return failedAdaptation(
      `the profiler report identifies ${JSON.stringify(reportedPackage)}, not the requested ${JSON.stringify(args.requestedPackage)}`
        + (reportedPackage === "" ? ' (an empty package is the profiler\'s "--package none" no-app-metrics mode)' : ""),
      reportVersion, producerVersion,
    );
  }
  // Neither schema declares a device field. Validate one only if a future line adds it.
  for (const key of ["device", "deviceId", "serial"]) {
    const reported = metadata[key];
    if (typeof reported === "string" && reported.length > 0 && reported !== args.requestedDevice) {
      return failedAdaptation(
        `the profiler report's metadata.${key} is ${JSON.stringify(reported)}, not the requested device ${JSON.stringify(args.requestedDevice)}`,
        reportVersion, producerVersion,
      );
    }
  }

  const diagnosis = isRecord(parsed.diagnosis) ? parsed.diagnosis : null;
  const summary = isRecord(parsed.summary) ? parsed.summary : null;
  const jankWindows = Array.isArray(parsed.jankWindows) ? parsed.jankWindows : [];
  const diagnosisResult = typeof diagnosis?.result === "string" ? diagnosis.result : null;
  const diagnosisCategory = typeof diagnosis?.category === "string" ? diagnosis.category : null;
  const unknownDiagnosis = (diagnosisResult !== null && !DIAGNOSIS_RESULTS.has(diagnosisResult))
    || (diagnosisCategory !== null && !DIAGNOSIS_CATEGORIES.has(diagnosisCategory));

  const appFps = isRecord(summary?.appFps) ? summary.appFps : null;
  const appAvg = finiteNumber(appFps?.avg);
  const appP5 = finiteNumber(appFps?.p5);
  const appMeasured = appAvg !== null && appAvg !== 0 && appP5 !== null;
  const missingCounters = COUNTER_GROUPS.filter((group) => !groupMeasured(summary?.[group]));
  if (!appMeasured) missingCounters.unshift("appFps");

  // PERF_SKIP050: SKIP / INSUFFICIENT_DATA is the profiler's own "nothing was collected" verdict.
  const skipped = diagnosisResult === "SKIP" || diagnosisCategory === "INSUFFICIENT_DATA";
  const measurement: PerfMeasurement = (!appMeasured || skipped)
    ? "missing"
    : missingCounters.length > 0 ? "partial" : "complete";

  const view: PerfReportView = {
    package: reportedPackage,
    reportId: metadata.report_id ?? null,
    durationSeconds: metadata.durationSeconds ?? null,
    totalSamples: metadata.totalSamples ?? null,
    timestamp: metadata.timestamp ?? null,
    ...(metadata.timeAlignment !== undefined ? { timeAlignment: metadata.timeAlignment } : {}),
    diagnosis,
    summary,
    jankWindowCount: jankWindows.length,
    jankWindows: jankWindows.slice(0, 5),
  };
  const reason = skipped
    ? `the profiler's own diagnosis is ${diagnosisResult ?? "SKIP"}/${diagnosisCategory ?? "INSUFFICIENT_DATA"} — nothing was measured`
    : !appMeasured
      ? "the profiler collected no app 3D frames (appFps absent or zero) — not measured, not a failure of the app"
      : measurement === "partial"
        ? `app FPS was measured; these declared counters were not: ${missingCounters.join(", ")}`
        : "every declared counter group was measured";
  return {
    status: "ok",
    measurement,
    reportVersion,
    producerVersion,
    reason: unknownDiagnosis ? `${reason}; the report's diagnosis vocabulary is outside the published enums and is quoted verbatim` : reason,
    view,
    missingCounters,
    metadata,
    diagnosis,
    summary,
    jankWindowCount: jankWindows.length,
    jankWindows: view.jankWindows,
  };
}

// --- the bounded live-collection core ----------------------------------------------------------

export type PerfDiagnoseRequest = {
  packageName: string;
  durationSec: number;
  device: string;
  /** Absolute path this run's report must be written to. It must not already exist. */
  reportPath: string;
};

export type PerfDiagnoseRuntime = {
  capability: () => OperationCapability;
  /** One bounded fresh discovery for an `unknown` capability with no usable evidence; optional. */
  rediscover?: () => Promise<OperationCapability | null>;
  /** Route-option facts for the resolved line, or null when the line has no live route. */
  options: () => CliRouteOptions | null;
  /** The other perf-family capabilities bound to the same target; see the no-route branch. */
  familyEvidence?: () => OperationCapability[];
  run: (args: string[], opts: { timeoutMs: number }) => Promise<PicoCliCommandResult>;
  retain: (input: {
    argv: string[];
    result: PicoCliCommandResult;
    artifacts?: Array<{ name: string; bytes: Buffer; sourcePath?: string }>;
    metadata: Record<string, unknown>;
  }) => PicoCliRetainedObservation;
  cliPath: string;
  cliRaw: string | null;
  cliVersion: string | null;
};

function capabilityDisclosure(capability: OperationCapability): PerfCapabilityDisclosure {
  return {
    operation: capability.operation,
    state: capability.state,
    reason: capability.reason,
    argvPrefix: capability.argvPrefix ? [...capability.argvPrefix] : null,
    evidence: capability.evidence.flatMap((observation) => [observation.stdoutPath, observation.stderrPath]),
  };
}

/**
 * The perf family resolves its utilities gate ONCE, before delegating any perf argv (PERF_ENV044's
 * `ms()` / PERF_ENV050's `Tm()` run ahead of the profiler spawn), so a gate answer retained for a
 * sibling `perf …` route is direct evidence about `perf live run` on the same package. That is the
 * only way a line with no live route can report the CLI's own reason instead of only ours.
 */
function perfFamilyGate(family: readonly OperationCapability[]): OperationCapability | null {
  return family.find((candidate) => /^(?:utilities-not-installed|environment):/.test(candidate.reason)) ?? null;
}

/**
 * Every outcome — a capability refusal, a failed or timed-out run, an unusable report, or a graded
 * one — names the device this wrapper was asked to profile. The request is the authority on that,
 * so it is written over whatever the inner result carried.
 */
export async function collectPerfLive(
  request: PerfDiagnoseRequest,
  runtime: PerfDiagnoseRuntime,
): Promise<PerfDiagnoseResult> {
  return { ...(await collectPerfLiveResult(request, runtime)), requestedDevice: request.device };
}

async function collectPerfLiveResult(
  request: PerfDiagnoseRequest,
  runtime: PerfDiagnoseRuntime,
): Promise<PerfDiagnoseResult> {
  // 1. Capability gate. Dispatch requires `supported` evidence bound to THIS execution target.
  let capability = runtime.capability();
  if (capability.state === "unknown" && capabilityNeedsFreshDiscovery(capability.reason) && runtime.rediscover) {
    capability = (await runtime.rediscover()) ?? capability;
  }
  if (capability.state !== "supported" || !capability.argvPrefix || capability.argvPrefix.length === 0) {
    // A line with no route at all gets the perf family's own gate answer when one was retained.
    const family = capability.argvPrefix === null && /^no-route:/.test(capability.reason)
      ? perfFamilyGate(runtime.familyEvidence?.() ?? [])
      : null;
    const noRoute = capability.argvPrefix === null && /^no-route:/.test(capability.reason);
    // The gate that OBSERVED the condition supplies the class and the environment remedy; the
    // operation this wrapper actually probed supplies the disclosed capability. Collapsing the two
    // (as the first C4 cut did) made the result name a sibling route as its own evidence and
    // promised that setup + retry would fix an operation this line cannot run even after setup.
    const gateSource = family ?? capability;
    const failureClass = family
      ? capabilityFailureClass(family)
      : noRoute
        ? "flag-or-version-drift"
        : capabilityFailureClass(capability);
    const environmentGuidance = failureClass === "environment"
      ? describePicoCliEnvironmentFailure(gateSource.reason, "", PERF_OPERATION)
      : null;
    const note = failureClass === "setup-required"
      ? SETUP_REQUIRED_NOTE
      : failureClass === "environment"
        ? environmentGuidance
          ?? "pico-cli reported an incomplete environment while this wrapper probed its live-collection route; read the capability reason before assuming a cause."
        : failureClass === "flag-or-version-drift"
          ? `pico-cli offers no verified live-collection route (installed: ${runtime.cliRaw || "unknown"}) — the retired \`perf monitor run\` is rejected by the CLI's own router, so no profiler run was started.`
          : "The resolved pico-cli has no verified `perf live run` capability, so this wrapper started no profiler run. Run ensure_pico_cli to re-run bounded capability discovery, then read the capability reason below.";
    return {
      status: "failed",
      measurement: "missing",
      failureClass,
      note,
      ...(failureClass === "setup-required" ? { setupCommand: { path: runtime.cliPath, args: ["setup"] } } : {}),
      reportPath: request.reportPath,
      producerVersion: runtime.cliVersion,
      capability: capabilityDisclosure(capability),
      ...(family ? { familyGate: capabilityDisclosure(family) } : {}),
      ...(noRoute ? { remediationLimit: NO_LIVE_ROUTE_LIMIT } : {}),
      honesty: HONESTY,
    };
  }

  // 2. Argv completeness. The option spellings are route FACTS; if the resolved line does not
  //    supply every role this invocation needs, dispatching a half-built argv would either measure
  //    the wrong thing or write the report somewhere we never read. Refuse instead.
  const options = runtime.options();
  const missingRoles = (["package", "duration", "device", "save", "output"] as const)
    .filter((role) => !options?.names[role]);
  if (missingRoles.length > 0) {
    return {
      status: "failed",
      measurement: "missing",
      failureClass: "flag-or-version-drift",
      note: `the resolved pico-cli line declares no ${missingRoles.join("/")} option for its live-collection route (installed: ${runtime.cliRaw || "unknown"}), so this wrapper built no invocation. Report this upstream instead of retrying.`,
      reportPath: request.reportPath,
      producerVersion: runtime.cliVersion,
      capability: capabilityDisclosure(capability),
      honesty: HONESTY,
    };
  }

  // 3. Immutable output. A file that already exists cannot be attributed to this run, and the
  //    profiler would overwrite it, destroying prior evidence — refuse before spawning anything.
  let preexisting: fs.Stats | null = null;
  try {
    preexisting = fs.statSync(request.reportPath);
  } catch {
    preexisting = null;
  }
  if (preexisting) {
    return {
      status: "failed",
      measurement: "missing",
      failureClass: "runtime",
      note: `a file already existed at ${request.reportPath} (${preexisting.size} bytes, mtime ${new Date(preexisting.mtimeMs).toISOString()}) before this run started; refusing to overwrite it or to read it as this run's measurement.`,
      reportPath: request.reportPath,
      producerVersion: runtime.cliVersion,
      honesty: HONESTY,
    };
  }
  fs.mkdirSync(path.dirname(request.reportPath), { recursive: true });

  // 4. Bounded run through the shared spawn boundary.
  const args = perfLiveArgv(capability.argvPrefix, options, request);
  const timeoutMs = (request.durationSec + 90) * 1000;
  const runResult = await runtime.run(args, { timeoutMs });

  // 5. Read whatever the run produced, then retain the raw streams AND the WHOLE raw report,
  //    before interpreting either. The retained copy is the immutable evidence; the CLI's own
  //    output path can be overwritten by a later run, ours cannot.
  let raw: string | null = null;
  let readError: string | undefined;
  try {
    raw = fs.readFileSync(request.reportPath, "utf8");
  } catch (e) {
    readError = e instanceof Error ? e.message : String(e);
  }
  const retained = runtime.retain({
    argv: args,
    result: runResult,
    ...(raw !== null
      ? { artifacts: [{ name: RETAINED_REPORT_FILE, bytes: Buffer.from(raw, "utf8"), sourcePath: request.reportPath }] }
      : {}),
    metadata: {
      packageName: request.packageName,
      device: request.device,
      requestedDurationSec: request.durationSec,
      reportPath: request.reportPath,
      ...(readError ? { reportReadError: readError } : {}),
      capabilityReason: capability.reason,
      cliVersion: runtime.cliVersion,
    },
  });
  const retainedReport = retained.retained
    ? retained.artifacts.find((artifact) => artifact.name === RETAINED_REPORT_FILE) ?? null
    : null;
  const retainedFields: Partial<PerfDiagnoseResult> = retained.retained
    ? {
        retainedLog: {
          directory: retained.directory,
          stdoutPath: retained.stdoutPath,
          stderrPath: retained.stderrPath,
          recordPath: retained.recordPath,
          stdoutSha256: retained.stdoutSha256,
          stderrSha256: retained.stderrSha256,
          outputTruncated: retained.outputTruncated,
          ...(retainedReport ? { reportPath: retainedReport.path, reportSha256: retainedReport.sha256, reportBytes: retainedReport.bytes } : {}),
        },
      }
    : { retainedLogError: retained.error };

  if (runResult.spawnError || runResult.timedOut || runResult.code !== 0) {
    const failureClass = runResult.spawnError ? "runtime" : classifyPicoCliFailure(runResult.stderr, runResult.stdout);
    const environmentGuidance = failureClass === "environment"
      ? describePicoCliEnvironmentFailure(runResult.stderr, runResult.stdout, PERF_OPERATION)
      : null;
    const tail = `${runResult.stderr}\n${runResult.stdout}`.trim().split("\n").slice(-6).join("\n");
    return {
      status: "failed",
      measurement: "missing",
      failureClass,
      note: failureClass === "flag-or-version-drift"
        ? `pico-cli rejected \`${args.join(" ")}\` (installed: ${runtime.cliRaw || "unknown"}) — its perf surface drifted from the route its own capability evidence advertised; report outputTail upstream instead of retrying.`
        : failureClass === "setup-required"
          ? SETUP_REQUIRED_NOTE
          : failureClass === "environment"
            ? environmentGuidance ?? "pico-cli reported an incomplete environment; read outputTail before assuming a cause."
            : "pico-cli perf live run failed at runtime — read outputTail (the CLI's own words) before assuming a cause; a stopped app or wrong device serial are common but NOT proven by this wrapper.",
      ...(failureClass === "setup-required" ? { setupCommand: { path: runtime.cliPath, args: ["setup"] } } : {}),
      error: runResult.spawnError ?? (runResult.timedOut
        ? `pico-cli perf live run timed out after ${request.durationSec + 90}s and was killed.`
        : `pico-cli perf live run exited with code ${runResult.code}.`),
      ...(tail ? { outputTail: tail } : {}),
      ...(runResult.outputTruncated ? { outputTruncated: true } : {}),
      reportPath: request.reportPath,
      producerVersion: runtime.cliVersion,
      ...retainedFields,
      honesty: HONESTY,
    };
  }

  // 6. Exit 0 is not evidence that a usable report exists. Validate the bytes we already read.
  const adaptation = adaptPerfReport({
    raw,
    ...(readError ? { readError } : {}),
    requestedPackage: request.packageName,
    requestedDevice: request.device,
    producerVersion: runtime.cliVersion,
    preexisting: false,
  });
  const rawReportSha256 = raw !== null ? crypto.createHash("sha256").update(raw, "utf8").digest("hex") : undefined;
  const tail = `${runResult.stdout}\n${runResult.stderr}`.trim().split("\n").slice(-6).join("\n");
  const base: PerfDiagnoseResult = {
    status: adaptation.status,
    measurement: adaptation.measurement,
    source: "pico-cli perf live run (official PICO profiler + diagnosis engine)",
    reportPath: request.reportPath,
    // The immutable retained copy when retention succeeded, otherwise the CLI's own path.
    rawReportPath: retainedReport?.path ?? request.reportPath,
    ...(rawReportSha256 ? { rawReportSha256 } : {}),
    reportVersion: adaptation.reportVersion,
    producerVersion: adaptation.producerVersion,
    note: adaptation.reason,
    view: adaptation.view,
    missingCounters: adaptation.missingCounters,
    metadata: adaptation.metadata,
    diagnosis: adaptation.diagnosis,
    summary: adaptation.summary,
    jankWindowCount: adaptation.jankWindowCount,
    jankWindows: adaptation.jankWindows,
    ...(tail ? { outputTail: tail } : {}),
    ...(runResult.outputTruncated ? { outputTruncated: true } : {}),
    ...retainedFields,
    honesty: HONESTY,
  };
  if (adaptation.status !== "ok") {
    return { ...base, failureClass: "runtime", error: `pico-cli exited 0 but its report is unusable: ${adaptation.reason}` };
  }
  return base;
}

/** Core diagnose, shared by the `perf_diagnose` tool and SpatialBench's perfSource:'pico-cli'
 * axis. Callers that need the numbers call this directly — never innerCall the tool. */
export async function runPerfDiagnose(
  packageName: string,
  opts: { durationSec?: number; device?: string } = {},
): Promise<PerfDiagnoseResult> {
  // The target is decided before anything can fail, so even a refusal names the device it is about.
  const device = opts.device ?? DEFAULT_PERF_DEVICE;
  const ensured = await ensurePicoCli();
  if (ensured.status !== "ok") {
    return {
      status: "unavailable",
      measurement: "missing",
      failureClass: ensured.failureClass,
      note: ensured.note,
      ...(ensured.outputTail ? { outputTail: ensured.outputTail } : {}),
      requestedDevice: device,
    };
  }
  let cli = picoCliFromEnsure(ensured)!;
  let provenance = { picoCli: picoCliProvenance(ensured) };
  const sec = Math.min(120, Math.max(5, Math.round(opts.durationSec ?? 15)));
  const outDir = path.join(os.homedir(), ".pico-mcp", "perf");
  const reportPath = path.join(outDir, `${packageName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  const runtime: PerfDiagnoseRuntime = {
    capability: () => picoCliOperationCapability(cli, PERF_OPERATION),
    rediscover: async () => {
      // The same bounded path C2 uses: starting a real CLI-backed operation is the lazy first use.
      const refreshed = await ensurePicoCli({ forceRefresh: true });
      if (refreshed.status !== "ok") return null;
      const target = picoCliFromEnsure(refreshed);
      if (!target) return null;
      cli = target;
      provenance = { picoCli: picoCliProvenance(refreshed) };
      return picoCliOperationCapability(cli, PERF_OPERATION);
    },
    options: () => cliOperationOptions(cli.version ?? "", PERF_OPERATION),
    familyEvidence: () => (["trace-record", "trace-decode", "trace-load", "trace-query"] as const)
      .map((operation) => picoCliOperationCapability(cli, operation)),
    run: (args, runOpts) => runPicoCli(cli, args, runOpts),
    retain: (input) => retainPicoCliObservation({ operation: PERF_OPERATION, argv: input.argv, result: input.result, ...(input.artifacts ? { artifacts: input.artifacts } : {}), metadata: input.metadata }),
    // Accessors, not captured values: `rediscover` may re-resolve the CLI mid-call, and a refusal
    // that quoted the pre-refresh path or version would name a package we did not run.
    get cliPath() { return cli.path; },
    get cliRaw() { return cli.raw ?? null; },
    get cliVersion() { return cli.version ?? null; },
  };
  const result = await collectPerfLive({ packageName, durationSec: sec, device, reportPath }, runtime);
  return { ...result, ...provenance };
}

/**
 * Score SpatialBench's perf axis from a diagnose result. HONESTY: the pico-cli report exposes
 * appFps percentiles p5/p10/p50 — FPS LOWS, where p5 is the frame-time-p95 analog ("95% of
 * sampled seconds ran at least this fast"). There is NO appFps p95 field in either published
 * report schema (reporter.d.ts on both profiler lines); do not invent one. appFps avg 0/absent
 * means the profiler saw no app 3D frames -> null, a SKIP that must never be counted against the
 * axis max, never a 0. An explicit measurement:'missing' (which includes the profiler's own
 * SKIP/INSUFFICIENT_DATA diagnosis) is likewise not measured — Spatial Runtime/compositor FPS is
 * never substituted for app FPS.
 */
export function scorePicoCliPerfAxis(
  result: Pick<PerfDiagnoseResult, "status" | "summary" | "measurement" | "reportVersion"> | null | undefined,
  budgetMs: number,
): { perf: 0 | 1 | null; note: string } {
  if (!result || result.status !== "ok") {
    return { perf: null, note: `perf(pico-cli): source ${result?.status ?? "absent"} — not measured` };
  }
  if (result.measurement === "missing") {
    return { perf: null, note: "perf(pico-cli): the profiler reported no app 3D frames for this window (measurement 'missing' — includes its own SKIP/INSUFFICIENT_DATA verdict) — not measured, not a fail" };
  }
  const app = result.summary?.appFps;
  const p5 = typeof app?.p5 === "number" ? app.p5 : null;
  const avg = typeof app?.avg === "number" ? app.avg : null;
  if (p5 === null || avg === null || avg === 0) {
    return { perf: null, note: "perf(pico-cli): profiler reports no app 3D frames (appFps 0/absent — the emulator's no_3d_frame case) — not measured, not a fail" };
  }
  const floorFps = 1000 / budgetMs;
  const perf: 0 | 1 = p5 >= floorFps ? 1 : 0;
  return { perf, note: `perf(pico-cli): appFps p5=${p5} vs floor ${floorFps.toFixed(1)}fps (${budgetMs}ms budget) -> ${perf ? "meets" : "misses"} budget` };
}

export function registerPerfCliTools(server: McpServer) {
  server.registerTool(
    "perf_diagnose",
    {
      description:
        "Run PICO's OFFICIAL performance profiler (`pico-cli perf live run`) against a running app for a fixed window " +
        "and return its validated JSON report: app/system FPS percentiles, CPU/GPU usage, jank windows, and pico-cli's " +
        "DIAGNOSIS (bottleneck category + rule + evidence — e.g. INSUFFICIENT_DATA, APP, SPR). Prefer this over " +
        "measure_perf for engine/3D-pipeline analysis; keep measure_perf for the 2D UI-frame (gfxinfo) view. " +
        "Dispatch requires verified `perf live run` capability evidence for the resolved package: an unprovisioned or " +
        "environment-gated profiler is refused with the CLI's own reason and the retained evidence paths, and this " +
        "server never sets PICO_HOME and never runs setup. The report is validated before it is reported — its package " +
        "identity must match the request, its schema must be a published one (reportVersion 0.2.0/0.1.0), and a report " +
        "file that predates the run is refused. The result reports `requestedDevice` — the explicit `device` you named or " +
        "the default this wrapper substituted — so a report is never read against the wrong target. " +
        "Read `measurement` before reading any number: 'missing' (including the " +
        "profiler's own SKIP/INSUFFICIENT_DATA) is NOT a pass, and Spatial Runtime FPS never stands in for app FPS. " +
        "Resolves the latest managed @picoxr/pico-cli lazily on first use and runs its absolute path; successful resolution " +
        "is reported in picoCli provenance. Failures carry an honest failureClass for managed policy/freshness, " +
        "setup-required, environment, flag-or-version-drift (the CLI rejected our flags), or runtime (read the CLI's " +
        "outputTail — the cause is not guessed for you). The full raw report is saved to reportPath for deep dives. " +
        "HONESTY: " + HONESTY,
      // Typed contract (2026-07-28 revision lane): the shared CLI-wrapper core + the report fields.
      outputSchema: z.object({
        status: z.enum(["ok", "failed", "unavailable"]).describe("ok = a report was produced, its identity validated and its measurement graded; failed = the run, the capability evidence or the report failed (see failureClass/capability/outputTail); unavailable = pico-cli absent/unusable."),
        ...cliWrapperContractShape,
        measurement: z.enum(["complete", "partial", "missing"]).optional().describe("complete = app FPS and every declared counter group measured; partial = app FPS measured, some declared counters absent/all-zero; missing = no app 3D frames at all, including the profiler's own SKIP/INSUFFICIENT_DATA. 'missing' is never a passing budget."),
        source: z.string().optional(),
        reportPath: z.string().optional().describe("The full pico-cli report JSON, persisted for deep dives."),
        rawReportPath: z.string().optional().describe("The retained raw report (same path); rawReportSha256 pins its bytes."),
        rawReportSha256: z.string().optional(),
        reportVersion: z.string().nullable().optional().describe("Which published report schema the file matched: '0.2.0' (metadata.package) or '0.1.0' (metadata.app). Neither schema carries a version field."),
        producerVersion: z.string().nullable().optional().describe("The resolved pico-cli version whose bundled profiler wrote the report."),
        view: z.unknown().optional().describe("Bounded selection of the report: metadata, diagnosis, summary and the top jank windows. The unbounded per-sample rawData array is excluded."),
        missingCounters: z.array(z.string()).optional().describe("Declared summary groups that are absent or all-zero — 'not measured', never 'measured zero' and never 'GPU idle'."),
        capability: z.record(z.unknown()).optional().describe("Why dispatch was refused — ALWAYS for the operation this wrapper probed (perf-live), with the retained bounded-help evidence paths behind the decision."),
        familyGate: z.record(z.unknown()).optional().describe("The sibling perf route whose retained gate answer this refusal adopted. Evidence about the shared utilities payload, never about the live route itself."),
        remediationLimit: z.string().optional().describe("What the adopted failure class does NOT establish. Present when the resolved line has no live-collection route at all, because provisioning the payload would not create one."),
        retainedLog: z.record(z.unknown()).optional().describe("Immutable raw stdout/stderr of the bounded run, with hashes."),
        retainedLogError: z.string().optional(),
        metadata: z.unknown().optional(),
        diagnosis: z.unknown().optional().describe("pico-cli's OWN rule-engine verdict, verbatim (result + category + suggestion)."),
        summary: z.unknown().optional().describe("pico-cli's summary: appFps percentiles p5/p10/p50 (FPS LOWS — there is no p95), sysFps, CPU/GPU counters. appFps 0/absent = no app 3D frames: not measured, never 'GPU idle'."),
        jankWindowCount: z.number().optional(),
        jankWindows: z.array(z.unknown()).optional().describe("Top jank windows (at most 5)."),
        requestedDevice: z.string().optional().describe("The device this run was asked to profile: your explicit `device`, or the default this wrapper substituted when you named none. Read it before reading any number — a report validated against one device is not evidence about another."),
      }).passthrough(),
      inputSchema: {
        packageName: z.string().describe("Target app package (must be running), e.g. com.example.knockdownxr"),
        durationSec: z.number().min(5).max(120).optional().describe("Sampling window in seconds (default 15)."),
        device: z.string().optional().describe(`Device serial to profile. Omitted: this wrapper's documented default target, ${DEFAULT_PERF_DEVICE}. Whichever decided, the result reports it as requestedDevice.`),
      },
    },
    async ({ packageName, durationSec, device }) => okJsonStructured(await runPerfDiagnose(packageName, { durationSec, device }) as unknown as Record<string, unknown>),
  );
}
