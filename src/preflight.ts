import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, okJsonStructured } from "./util.js";
import { doorsSurfaceActive } from "./doors.js";
import { detectJavaHome } from "./toolchain.js";
import { SKELETON_CANARIES, SKELETON_ROOT } from "./projectgen.js";
import { UNITY_SKELETON_CANARIES, UNITY_SKELETON_ROOT } from "./unitygen.js";
import {
  extractPicoCliRemediations,
  inspectPicoCliCached,
  parsePicoCliEnvelope,
  picoCliFromEnsure,
  runPicoCli,
  runPicoCliSync,
  type PicoCliEnsureResult,
} from "./picocli.js";

/**
 * preflight.ts — v27-pre: the read-only environment doctor.
 *
 * One tool, `preflight_env`, that a stranger runs FIRST on a new machine. Every check returns
 * {name, status, detail, fix} — and the fix is the EXACT command or action, never "check your
 * setup". Strictly read-only: repair commands are only ever printed, never executed.
 */

export type CheckResult = {
  name: string;
  status: "pass" | "fail" | "warn" | "unknown";
  detail: string;
  fix: string | null;
  /** Exact read-only resolver evidence. Present on production pico-cli rows so policy/source/
   * freshness are not flattened into a guessed generic status. */
  inspection?: PicoCliEnsureResult;
};

/** One injected command result. `code`, `timedOut` and `spawnError` are optional so legacy
 * fixtures keep working; production supplies them from the bounded runner so the emulator-status
 * row can check execution/envelope consistency. */
export type PreflightExecResult = {
  ok: boolean;
  stdout: string;
  stderr?: string;
  code?: number | null;
  timedOut?: boolean;
  spawnError?: string;
};

export type PreflightIO = {
  nodeVersion: string;
  exec: (cmd: string, args: string[]) => PreflightExecResult;
  readFile: (p: string) => string | null;
  statMtimeMs: (p: string) => number | null;
  now: () => number;
  home: string;
  /** Injected so a fixture can describe a machine WITHOUT a JDK; the default is the real resolver
   *  the Gradle lane uses, so this check can never disagree with whether builds actually work. */
  detectJavaHome: () => string | null;
  /** Production's exact read-only managed inspection. Fixtures that exercise the legacy pure
   * command evaluator may omit it. */
  picoCliInspection?: PicoCliEnsureResult;
};

export function defaultIO(): PreflightIO {
  return {
    nodeVersion: process.version,
    exec: (cmd, args) => {
      if (cmd === "pico-cli") return runPicoCliSync(args);
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
      return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    readFile: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
    statMtimeMs: (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } },
    now: () => Date.now(),
    home: os.homedir(),
    detectJavaHome,
  };
}

/** Production preflight adapter: keep the fixture-friendly synchronous evaluator, but precompute
 * pico-cli's two read-only calls through the hard-bounded process-tree runner. */
async function defaultBoundedIO(): Promise<PreflightIO> {
  const base = defaultIO();
  const inspected = await inspectPicoCliCached();
  const probe = picoCliFromEnsure(inspected);
  const versionResult = inspected.status === "ok"
    ? { ok: true, stdout: inspected.raw, stderr: "" }
    : { ok: false, stdout: "", stderr: inspected.note };
  const emulatorResult = probe
    ? await runPicoCli(probe, ["emulator", "status", "--format", "json"], { timeoutMs: 15_000 })
    : null;
  return {
    ...base,
    picoCliInspection: inspected,
    exec: (cmd, args) => {
      if (cmd !== "pico-cli") return base.exec(cmd, args);
      if (args.length === 1 && args[0] === "-v") return versionResult;
      if (args.join(" ") === "emulator status --format json" && emulatorResult) {
        return {
          ok: !emulatorResult.timedOut && !emulatorResult.spawnError && emulatorResult.code === 0,
          stdout: emulatorResult.stdout,
          stderr: emulatorResult.stderr,
          code: emulatorResult.code,
          timedOut: emulatorResult.timedOut,
          ...(emulatorResult.spawnError ? { spawnError: emulatorResult.spawnError } : {}),
        };
      }
      return { ok: false, stdout: "", stderr: "unsupported pico-cli preflight command" };
    },
  };
}

function picoCliInspectionFix(inspected: Extract<PicoCliEnsureResult, { status: "unavailable" }>): string {
  if (inspected.failureClass === "configuration") {
    return "Correct the CLI policy configuration named in the note, then restart the MCP server and re-run this read-only check.";
  }
  if (inspected.policy === "disabled") {
    return "Change PICO_MCP_CLI_POLICY from disabled and restart the MCP server only if CLI-backed tools are needed; non-CLI lanes remain available.";
  }
  if (inspected.policy === "external") {
    return "Set PICO_MCP_CLI_PATH to a runnable absolute pico-cli path, restart the MCP server, then re-run this read-only check.";
  }
  if (inspected.source === "managed" && /content-bound immutable-store validation/i.test(inspected.note)) {
    return "Follow the exact manual recovery action in the inspection note, then call ensure_pico_cli; this read-only check does not alter the rejected cache entry.";
  }
  if (inspected.policy === "managed-cached") {
    return "To provision instead of remaining cache-only, set PICO_MCP_CLI_POLICY=managed-latest, restart the MCP server, then call ensure_pico_cli; otherwise publish a validated managed cache entry outside this read-only check.";
  }
  return "Under managed-latest, first CLI use provisions lazily. Call ensure_pico_cli to refresh/provision now, or invoke the needed CLI-backed tool; neither path changes the global CLI or PATH.";
}

function picoCliInspectionDetail(inspected: PicoCliEnsureResult): string {
  if (inspected.status === "ok") {
    return [
      "inspection status=ok",
      `policy=${inspected.policy}`,
      `source=${inspected.source}`,
      `freshness=${inspected.freshness}`,
      `version=${inspected.version}`,
      `action=${inspected.action}`,
      `latestVersion=${inspected.latestVersion ?? "not checked"}`,
      `checkedAt=${inspected.checkedAt ?? "not checked"}`,
      ...(inspected.warning ? [`warning=${inspected.warning.failureClass}: ${inspected.warning.note}`] : []),
    ].join("; ");
  }
  return [
    "inspection status=unavailable",
    `policy=${inspected.policy ?? "invalid"}`,
    `source=${inspected.source ?? "none"}`,
    `freshness=${inspected.freshness ?? "unavailable"}`,
    `failureClass=${inspected.failureClass}`,
    inspected.note,
  ].join("; ");
}

const SDK_ADB = (home: string) =>
  path.join(home, "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb");

export const PICO_EMULATOR_INSTALL_COMMAND = "pico-cli emulator install --source auto --yes";

function emulatorAcquisitionFix(): string {
  return `To download/update only the PICO emulator bundle, run \`${PICO_EMULATOR_INSTALL_COMMAND}\`. ` +
    "This does not create an AVD and does not install the JDK, Android SDK, Gradle, or PICO build SDK. " +
    "After the bundle is present, open the PICO Spatial Editor app to boot the emulator (or, from a source checkout, run scripts/restart-emulator.sh), then re-run preflight_env.";
}

function findAdb(io: PreflightIO): string | null {
  if (io.exec("adb", ["version"]).ok) return "adb";
  const bundled = SDK_ADB(io.home);
  if (io.exec(bundled, ["version"]).ok) return bundled;
  return null;
}

/**
 * The calibration remedy names fleet_build + calibrate_capture_camera, neither of which is
 * registered on the `doors` surface. Telling a doors-only user to run them is telling them to do
 * something they cannot do, so name the way out of the surface as part of the fix.
 */
function calibrationRoute(): string {
  // The doors surface does not register preflight_env; pico_doctor reaches these strings by spawning
  // an INNER server with PICO_MCP_SURFACE=full, so keying off PICO_MCP_SURFACE alone made this branch
  // unreachable and shipped the dead-end remedy anyway. doors.ts marks the inner server with
  // PICO_MCP_OUTER_SURFACE so the ultimate consumer is still knowable here. doorsSurfaceActive()
  // (not a raw env read) keeps this correct now that UNSET also means doors (v36.3).
  const servingDoors =
    doorsSurfaceActive() || process.env.PICO_MCP_OUTER_SURFACE === "doors";
  return servingDoors
    ? "run pico_doctor {calibrate:true} — it runs fleet_build(['calib']) then calibrate_capture_camera through the full-surface inner server, no client restart needed"
    : "fleet_build(['calib']) then calibrate_capture_camera";
}

const EMULATOR_STATUS_TOOL = "emulator.status";
/** pico-cli's shared result serializer maps tool_status to the process exit code
 * (source-inspected CLI_RESULT_SCHEMA, 0.5.0 chunk-IRAF5R7A.js:12; 2026-09-15 audit). */
const EMULATOR_STATUS_EXIT: Record<"SUCCESS" | "PARTIAL" | "FAILED", number> = { SUCCESS: 0, FAILED: 3, PARTIAL: 4 };
const EMULATOR_STATUS_DIRECT_FIX = "Run `pico-cli emulator status --format json` directly and inspect its diagnostics; this read-only check does not run pico-cli doctor.";

/**
 * The emulator-status row. A healthy row requires all of: the process completed (no timeout,
 * spawn error or managed-integrity rejection), a well-formed envelope whose tool_name is
 * emulator.status, tool_status SUCCESS, and an exit code consistent with that status. PARTIAL and
 * FAILED stay warnings that surface the envelope's own remediation; every other defect is a
 * warning that names what was inconsistent instead of a pass.
 */
function emulatorStatusCheck(status: PreflightExecResult): CheckResult {
  const name = "pico-cli-emulator-status";
  const stderr = status.stderr?.trim() ?? "";
  if (status.spawnError) {
    const integrity = /validation failed|identity|publication/i.test(status.spawnError);
    return integrity
      ? { name, status: "warn", detail: `managed pico-cli integrity check rejected the emulator status invocation before it could be trusted: ${status.spawnError}`, fix: "Call ensure_pico_cli to re-resolve and revalidate the managed CLI, then re-run preflight_env; if the rejection persists, follow the manual recovery action in its note." }
      : { name, status: "warn", detail: `structured emulator status unavailable: pico-cli could not start (${status.spawnError})`, fix: EMULATOR_STATUS_DIRECT_FIX };
  }
  if (status.timedOut) {
    return { name, status: "warn", detail: `structured emulator status unavailable: pico-cli emulator status timed out and was killed${stderr ? `; stderr=${stderr}` : ""}`, fix: EMULATOR_STATUS_DIRECT_FIX };
  }
  const exitObserved = status.code !== undefined;
  const processContext = status.ok
    ? (exitObserved ? `; process exit: ${status.code}` : "")
    : `; process exit: ${exitObserved ? String(status.code) : "non-zero"}${stderr ? `; stderr=${stderr}` : ""}`;
  const envelope = parsePicoCliEnvelope(status.stdout);
  if (envelope.status === "invalid") {
    return { name, status: "warn", detail: `structured emulator status unavailable: ${envelope.detail}${processContext}`, fix: EMULATOR_STATUS_DIRECT_FIX };
  }
  const toolName = envelope.envelope.tool_name;
  if (toolName !== EMULATOR_STATUS_TOOL) {
    return { name, status: "warn", detail: `structured emulator status envelope carries tool_name=${typeof toolName === "string" ? toolName : "(missing)"}, expected ${EMULATOR_STATUS_TOOL}; not treating another tool's JSON as emulator status${processContext}`, fix: EMULATOR_STATUS_DIRECT_FIX };
  }
  const expectedExit = EMULATOR_STATUS_EXIT[envelope.toolStatus];
  const exitConsistent = exitObserved ? status.code === expectedExit : (status.ok ? expectedExit === 0 : expectedExit !== 0);
  const consistency = exitConsistent ? "" : `; exit/status mismatch: envelope ${envelope.toolStatus} expects exit ${expectedExit}`;
  if (envelope.outcome === "operational") {
    return exitConsistent
      ? { name, status: "pass", detail: `pico-cli structured emulator status: operational${processContext}`, fix: null }
      : { name, status: "warn", detail: `pico-cli structured emulator status: envelope SUCCESS but the process did not exit ${expectedExit}${processContext}${consistency}; not treating an inconsistent execution as healthy`, fix: EMULATOR_STATUS_DIRECT_FIX };
  }
  const payload = JSON.stringify(envelope.envelope).slice(0, 1_000);
  const action = extractPicoCliRemediations(envelope.envelope)[0];
  const diagnostic = envelope.summary ?? payload;
  return { name, status: "warn", detail: `pico-cli structured emulator status: ${envelope.outcome}; ${diagnostic}; payload=${payload}${processContext}${consistency}`, fix: action ?? "Run `pico-cli emulator status --format json` directly and address its returned diagnostics; this read-only check does not run pico-cli doctor." };
}

export function runPreflightChecks(io: PreflightIO): CheckResult[] {
  const out: CheckResult[] = [];
  const push = (c: CheckResult) => out.push(c);

  // 1. node
  const major = Number((io.nodeVersion.match(/^v(\d+)/) ?? [])[1] ?? 0);
  push(major >= 20
    ? { name: "node", status: "pass", detail: io.nodeVersion, fix: null }
    : { name: "node", status: "fail", detail: `found ${io.nodeVersion}, need >=20`, fix: "Install Node 20 or newer (e.g. `brew install node@20`), then restart your MCP client so the server runs on it." });

  // 2. adb
  const adb = findAdb(io);
  push(adb
    ? { name: "adb", status: "pass", detail: adb, fix: null }
    : { name: "adb", status: "fail", detail: "no adb on PATH and no bundled platform-tools", fix: `Install the PICO Spatial Plugin in Android Studio (payloads land under ~/Library/PICO/sdk/0.13/) or add adb to PATH; expected bundled path: ${SDK_ADB(io.home)}` });

  // 2b. PICO SDK payload. adb can be on PATH from an unrelated Android install, so a passing adb
  //     check is not evidence the PICO SDK is present. Without it there is nothing to build against.
  // PICO_HOME overrides the default location for the rest of the toolchain, so this check has to
  // honour it too — otherwise preflight reports "no SDK" while validate_toolchain reports one.
  const sdkRoot = process.env.PICO_HOME
    ? path.join(process.env.PICO_HOME, "0.13")
    : path.join(io.home, "Library/PICO/sdk/0.13");
  push(io.statMtimeMs(sdkRoot) != null
    ? { name: "pico-sdk", status: "pass", detail: sdkRoot, fix: null }
    : { name: "pico-sdk", status: "fail", detail: `no PICO SDK payload at ${sdkRoot}`, fix: "Install the PICO Spatial Plugin in Android Studio and let it download the PICO build SDK under ~/Library/PICO/sdk/0.13/. This is separate from `pico-cli emulator install --source auto --yes`, which downloads/updates only the emulator bundle and does not install the build SDK." });

  // 2c. JDK. Gradle needs it, and its absence surfaces as an opaque build failure much later.
  //     This MUST use detectJavaHome() — the same resolver gradleEnv() injects into every Gradle
  //     invocation. An earlier version checked only $JAVA_HOME and `java` on PATH, which meant the
  //     standard setup (Android Studio installed, JAVA_HOME unset, macOS's /usr/bin/java stub
  //     exiting non-zero) reported "no JDK found — Gradle APK builds fail without it" while builds
  //     in fact succeeded against Android Studio's bundled JBR. That is the same false claim this
  //     check was added to prevent, only inverted: a false "broken" instead of a false "healthy".
  //     If the build lane can find a JDK, this check must agree with it.
  const javaHome = io.detectJavaHome();
  push(javaHome
    ? { name: "jdk", status: "pass", detail: process.env.JAVA_HOME === javaHome ? `JAVA_HOME=${javaHome}` : `${javaHome} (auto-detected; Gradle gets it injected)`, fix: null }
    : { name: "jdk", status: "fail", detail: "no JDK found (JAVA_HOME unset, none on PATH, no Android Studio JBR)", fix: "Install a JDK 17+ (Android Studio bundles one, or `brew install openjdk@17`) and set JAVA_HOME — Gradle APK builds fail without it." });

  // 2d. ImageMagick. Only the capture-analysis lane needs it, so this is a warn, not a fail.
  push(io.exec("magick", ["-version"]).ok
    ? { name: "imagemagick", status: "pass", detail: "magick on PATH", fix: null }
    : { name: "imagemagick", status: "warn", detail: "no `magick` on PATH — golden-frame MAE compare and some capture analysis are unavailable", fix: "brew install imagemagick (only needed for the capture-analysis lane; building and running apps works without it)." });

  // 2e. App skeleton. Every build path (pico_build_app -> fleet_build -> scaffold_spatial_app)
  //     GENERATES a fresh project from the skeleton packaged at appskeleton/ (v29.3 — no more
  //     machine-local template). The payload rides in the npm tarball, so this can only fail on a
  //     truncated/blocked install; checking it here still beats a multi-minute build dying at
  //     scaffold. Goes through io.statMtimeMs so fixtures can describe other machines.
  const missingSkel = SKELETON_CANARIES.filter((rel) => io.statMtimeMs(path.join(SKELETON_ROOT, ...rel.split("/"))) == null);
  push(missingSkel.length === 0
    ? { name: "app-skeleton", status: "pass", detail: `generator payload at ${SKELETON_ROOT} (${SKELETON_CANARIES.length} canaries present)`, fix: null }
    : { name: "app-skeleton", status: "fail", detail: `packaged app skeleton incomplete at ${SKELETON_ROOT} — missing: ${missingSkel.slice(0, 4).join(", ")}${missingSkel.length > 4 ? ` (+${missingSkel.length - 4} more)` : ""}`, fix: "Reinstall the pico-spatial-mcp package (the tarball ships appskeleton/ — a partial or filtered install cannot scaffold projects). Everything that does not build an APK — scanning, capture, SDK lookup, diagnosis, perf — works without it." });

  // 2f. Unity lane (OPTIONAL — warn-tier so it never blocks non-Unity testers). Payload canaries
  //     fail only on a broken install; a missing editor is a warn with the install path named.
  const missingUnitySkel = UNITY_SKELETON_CANARIES.filter((rel) => io.statMtimeMs(path.join(UNITY_SKELETON_ROOT, ...rel.split("/"))) == null);
  if (missingUnitySkel.length > 0) {
    push({ name: "unity-lane", status: "fail", detail: `packaged unity skeleton incomplete — missing: ${missingUnitySkel.slice(0, 3).join(", ")}${missingUnitySkel.length > 3 ? ` (+${missingUnitySkel.length - 3} more)` : ""}`, fix: "Reinstall the pico-spatial-mcp package (the tarball ships unityskeleton/). The Unity lane is optional; everything else works without it." });
  } else {
    const hub = io.statMtimeMs("/Applications/Unity/Hub/Editor") != null;
    const envEditor = !!process.env.UNITY_EDITOR_PATH;
    push(hub || envEditor
      ? { name: "unity-lane", status: "pass", detail: envEditor ? `UNITY_EDITOR_PATH=${process.env.UNITY_EDITOR_PATH}` : "Unity Hub editors present; unity skeleton payload complete", fix: null }
      : { name: "unity-lane", status: "warn", detail: "no Unity editor found (optional lane) — unity_build_apk needs one", fix: "Install Unity 6000.4.9f1 + Android Build Support via Unity Hub, or set UNITY_EDITOR_PATH. Skip this if you are not building Unity apps." });
  }

  // 2g. pico-cli (OPTIONAL — warn-tier, never a failure). perf_diagnose/perf_trace/watch_crash/
  //     capture_record and agent-vault provisioning ride on it; building, capture, and verification
  //     all work without it. Probe with `-v` ONLY: `pico-cli doctor` and `pico-cli plugin doctor`
  //     hang (measured >=90s / 45s on 0.3.0, 2026-08-01) and must never be inlined here.
  //     (0.4.2 re-measured 2026-08-12 on one macOS arm64 machine: doctor returned JSON in ~10s.
  //     That is not a cross-machine/release claim; the bounded sub-second `-v` probe remains.)
  const inspectedCli = io.picoCliInspection;
  const picoCli = inspectedCli
    ? (inspectedCli.status === "ok"
        ? { ok: true, stdout: inspectedCli.raw, stderr: "" }
        : { ok: false, stdout: inspectedCli.raw, stderr: inspectedCli.note })
    : io.exec("pico-cli", ["-v"]);
  if (inspectedCli?.status === "ok" || (!inspectedCli && picoCli.ok)) {
    const raw = picoCli.stdout.trim();
    const cliVersion = raw.match(/pico-cli\/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
    push(inspectedCli
      ? { name: "pico-cli", status: "pass", detail: picoCliInspectionDetail(inspectedCli), fix: null, inspection: inspectedCli }
      : { name: "pico-cli", status: "pass", detail: cliVersion ? `managed cached version ${cliVersion} (${raw})` : `managed cached CLI (version string unparsed: ${raw || "(empty)"})`, fix: null });
    push(emulatorStatusCheck(io.exec("pico-cli", ["emulator", "status", "--format", "json"])));
  } else if (inspectedCli?.status === "unavailable") {
    push({
      name: "pico-cli",
      status: "warn",
      detail: picoCliInspectionDetail(inspectedCli),
      fix: picoCliInspectionFix(inspectedCli),
      inspection: inspectedCli,
    });
  } else {
    push({ name: "pico-cli", status: "warn", detail: "no validated managed pico-cli is cached; first CLI use will provision the MCP-owned registry-latest version lazily", fix: "Call ensure_pico_cli to provision now, or invoke the needed CLI-backed tool; neither path changes the global CLI or PATH." });
  }

  // 3. emulator (a PICO device attached and in 'device' state)
  let bootAtMs: number | null = null;
  if (!adb) {
    push({ name: "emulator", status: "unknown", detail: "cannot check without adb", fix: "Fix the adb check first, then re-run preflight_env." });
  } else {
    const dev = io.exec(adb, ["devices"]);
    const line = dev.stdout.split("\n").find((l) => /emulator-\d+\tdevice/.test(l));
    if (line) {
      const serial = line.split("\t")[0];
      const up = io.exec(adb, ["-s", serial, "shell", "cat", "/proc/uptime"]);
      const uptimeSec = parseFloat(up.stdout.trim().split(/\s+/)[0] ?? "");
      if (up.ok && Number.isFinite(uptimeSec)) bootAtMs = io.now() - uptimeSec * 1000;
      push({ name: "emulator", status: "pass", detail: `${serial} (device)`, fix: null });
    } else {
      push({ name: "emulator", status: "fail", detail: `no running emulator in: ${dev.stdout.trim() || "(empty)"}`, fix: emulatorAcquisitionFix() });
    }
  }

  // 4. grpc (capture-rig endpoint) — only meaningful when the emulator is up
  const emuUp = out.find((c) => c.name === "emulator")?.status === "pass";
  push(emuUp
    ? (io.exec("nc", ["-z", "127.0.0.1", "8554"]).ok
        ? { name: "grpc", status: "pass", detail: "emulator gRPC port 8554 reachable", fix: null }
        : { name: "grpc", status: "warn", detail: "port 8554 not reachable — XR input injection and some capture paths degrade", fix: "Cold-restart the emulator; the gRPC endpoint comes up with a clean boot. (From a source checkout: scripts/restart-emulator.sh.)" })
    : { name: "grpc", status: "unknown", detail: "emulator not running", fix: "Boot the emulator first (see the emulator check), then re-run preflight_env." });

  // 5. accessibility — macOS gives no reliable read-only query for another process's AX grant.
  push({ name: "accessibility", status: "unknown",
    detail: "macOS Accessibility for the controlling process cannot be verified read-only; without it, emulator_look free-cam drags are SILENTLY dropped.",
    fix: "System Settings → Privacy & Security → Accessibility → enable your terminal/IDE. To confirm it works: take two captures around an emulator_look sweep and md5-compare them — identical files mean the drag was dropped." });

  // 6. calibration freshness (the dies-on-cold-restart gotcha)
  const calPath = path.join(io.home, ".pico-mcp", "camera-calibration.json");
  const calRaw = io.readFile(calPath);
  if (!calRaw) {
    push({ name: "calibration", status: "warn", detail: "no camera calibration on file — pico_measure/measure_placement unavailable", fix: `Run ${calibrationRoute()} (one-time per emulator boot).` });
  } else {
    // calibrate_capture_camera persists `at` as an ISO string (metricverify.ts). Comparing a string
    // to a number coerces to NaN, which silently reported every stale calibration as fresh.
    let calAt: number | null = null;
    try {
      const rawAt = JSON.parse(calRaw).at;
      if (typeof rawAt === "number" && Number.isFinite(rawAt)) calAt = rawAt;
      else if (typeof rawAt === "string" && Number.isFinite(Date.parse(rawAt))) calAt = Date.parse(rawAt);
    } catch { /* unparseable */ }
    if (calAt == null) calAt = io.statMtimeMs(calPath);
    if (bootAtMs == null) {
      push({ name: "calibration", status: "unknown", detail: "calibration on file but the emulator is not running — freshness cannot be assessed (calibration dies on emulator cold restart)", fix: `Boot the emulator, re-run preflight_env, and recalibrate if it reports stale: ${calibrationRoute()}.` });
    } else if (calAt != null && calAt < bootAtMs) {
      push({ name: "calibration", status: "fail", detail: `calibration predates the current emulator boot (calibrated ${new Date(calAt).toISOString()}, booted ${new Date(bootAtMs).toISOString()}) — cy can shift ~300px across a cold restart`, fix: `Recalibrate BEFORE any measure_placement session: ${calibrationRoute()}.` });
    } else {
      push({ name: "calibration", status: "pass", detail: `calibration on file${calAt ? ` (at ${new Date(calAt).toISOString()})` : ""}`, fix: null });
    }
  }

  // 7. disk (the toolchain + AVDs + artifacts want headroom)
  const df = io.exec("df", ["-k", io.home]);
  const availKb = Number((df.stdout.split("\n")[1] ?? "").trim().split(/\s+/)[3] ?? NaN);
  if (!df.ok || !Number.isFinite(availKb)) {
    push({ name: "disk", status: "unknown", detail: "could not read free space", fix: "Check free disk space manually (`df -h ~`); keep >=10 GB free for AVDs, builds, and capture artifacts." });
  } else {
    const gb = availKb / (1024 * 1024);
    push(gb >= 10
      ? { name: "disk", status: "pass", detail: `${gb.toFixed(1)} GB free`, fix: null }
      : { name: "disk", status: "fail", detail: `${gb.toFixed(1)} GB free (<10 GB)`, fix: "Free at least 10 GB (old AVD snapshots and ~/.pico-mcp/artifacts are the usual culprits)." });
  }

  return out;
}

export function registerPreflightTools(server: McpServer) {
  server.registerTool(
    "preflight_env",
    {
      description:
        "v27-pre READ-ONLY environment doctor: node, adb, emulator/AVD state, gRPC reachability, pico-cli presence (warn-tier — the perf/trace/recording lane is optional), macOS Accessibility (the silent CGEvent-drop gotcha), camera-calibration freshness (dies on emulator cold restart), and disk headroom. Every non-pass check carries the EXACT fix. Run this FIRST on a new machine. Never mutates anything.",
      inputSchema: {},
      // Typed contract (2026-07-28 revision lane): the doctor's check list, fix-pointed.
      outputSchema: z.object({
        status: z.enum(["ok", "problems"]).describe("problems = at least one check FAILING (warn/unknown do not fail the doctor)."),
        checks: z.array(z.object({
          name: z.string(),
          status: z.enum(["pass", "fail", "warn", "unknown"]),
          detail: z.string(),
          fix: z.string().nullable().describe("The EXACT next command/action for a non-pass check; null when passing."),
        }).passthrough()),
        summary: z.string(),
      }).passthrough(),
    },
    async () => {
      const checks = runPreflightChecks(await defaultBoundedIO());
      const failing = checks.filter((c) => c.status === "fail");
      return okJsonStructured({ status: failing.length ? "problems" : "ok", checks, summary: failing.length ? `${failing.length} failing check(s) — apply each 'fix' in order.` : "environment looks healthy" });
    },
  );
}
