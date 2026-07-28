import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { okJson } from "./util.js";
import { detectJavaHome } from "./toolchain.js";
import { SKELETON_CANARIES, SKELETON_ROOT } from "./projectgen.js";

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
};

export type PreflightIO = {
  nodeVersion: string;
  exec: (cmd: string, args: string[]) => { ok: boolean; stdout: string; stderr?: string };
  readFile: (p: string) => string | null;
  statMtimeMs: (p: string) => number | null;
  now: () => number;
  home: string;
  /** Injected so a fixture can describe a machine WITHOUT a JDK; the default is the real resolver
   *  the Gradle lane uses, so this check can never disagree with whether builds actually work. */
  detectJavaHome: () => string | null;
};

export function defaultIO(): PreflightIO {
  return {
    nodeVersion: process.version,
    exec: (cmd, args) => {
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

const SDK_ADB = (home: string) =>
  path.join(home, "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb");

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
  // PICO_MCP_OUTER_SURFACE so the ultimate consumer is still knowable here.
  const servingDoors =
    process.env.PICO_MCP_SURFACE === "doors" || process.env.PICO_MCP_OUTER_SURFACE === "doors";
  return servingDoors
    ? "fleet_build(['calib']) then calibrate_capture_camera — both live on the full surface, so unset PICO_MCP_SURFACE (or set it to `full`) in your MCP server env and restart the client first"
    : "fleet_build(['calib']) then calibrate_capture_camera";
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
    : { name: "pico-sdk", status: "fail", detail: `no PICO SDK payload at ${sdkRoot}`, fix: "Install the PICO Spatial Plugin in Android Studio and let it download the SDK + emulator payloads; they land under ~/Library/PICO/sdk/0.13/." });

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
      push({ name: "emulator", status: "fail", detail: `no running emulator in: ${dev.stdout.trim() || "(empty)"}`, fix: "Open the PICO Spatial Editor app — it boots the emulator — then re-run preflight_env. (From a source checkout you can instead run scripts/restart-emulator.sh.)" });
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
        "v27-pre READ-ONLY environment doctor: node, adb, emulator/AVD state, gRPC reachability, macOS Accessibility (the silent CGEvent-drop gotcha), camera-calibration freshness (dies on emulator cold restart), and disk headroom. Every non-pass check carries the EXACT fix. Run this FIRST on a new machine. Never mutates anything.",
      inputSchema: {},
    },
    async () => {
      const checks = runPreflightChecks(defaultIO());
      const failing = checks.filter((c) => c.status === "fail");
      return okJson({ status: failing.length ? "problems" : "ok", checks, summary: failing.length ? `${failing.length} failing check(s) — apply each 'fix' in order.` : "environment looks healthy" });
    },
  );
}
