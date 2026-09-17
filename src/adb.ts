import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, image, ok, okJson, run, runBinary, sleep, tail } from "./util.js";
import { hostToolchainIO } from "./toolchain.js";
import { executableCandidates } from "./picocli.js";
import { executableNames, resolveRootCandidate, selectInstallation, type FileIdentity, type ToolchainIO } from "./toolchainselection.js";
import { IdentityCache } from "./identitycache.js";
import { LONG_POLL_LOG_WINDOW_MAX_LINES, LogWindowOpenError, logWindowFromMarker, openLogWindow, readLogWindow, unseenMarkerCause, type AdbRunner, type LogWindow } from "./logwindow.js";

/**
 * THE one adb lookup (Task S4).
 *
 * Before this, every consumer carried its own copy of `[$PICO_ADB, <literal 0.13 path>,
 * /opt/homebrew/bin/adb, "adb"]`, so on a host carrying both 0.13 and 6.1 every capture, deploy
 * and verification ran the 0.13 adb while the structural selection chose 6.1 — measured on this
 * repo's own machine. `src/adb.ts` additionally memoized its answer in a `cachedAdb` that no
 * toolchain change could ever dislodge.
 *
 * Precedence, one chain for every consumer:
 *   1. explicit `$PICO_ADB` — it must exist, be executable and be readable, and its BYTES are
 *      disclosed, so a pinned adb is identified rather than trusted by filename. It fails CLOSED:
 *      a set-but-unusable override is refused outright and NOTHING else is probed, because
 *      quietly running a different binary than the one an operator named is the failure this
 *      whole task exists to remove. A set-but-BLANK value (empty or whitespace) is an override
 *      too and takes the same path: reading it as "unset" walked PATH, which is exactly how a
 *      fixture gate that pinned it blank would have found a real adb. `adbExecutable` turns that
 *      refusal into a throw.
 *   2. PATH — searched in JS through the shared PATH/PATHEXT helper, never a POSIX `which`
 *      subprocess, so the lookup is identical on Windows and costs no process.
 *   3. the SELECTED toolchain's bundled `adb` component — the S1 selection, so it follows the
 *      installation this server is otherwise using instead of a hardcoded version directory.
 *      Scope of that selection: the bundled candidate resolves from the HOST tools root
 *      (`resolveRootCandidate({}, io)` — explicit toolsRoot, then $PICO_HOME, then the platform
 *      default) with NO `androidProjectRoot`. A project's `spatial.tools.dir` in local.properties
 *      therefore selects the packer for that project's pack operations but never this adb: adb is
 *      a host-level tool, one per process, not a per-project one. `src/preflight.ts` builds its
 *      `adbInspection` the same way (`resolveHostToolchain({ required: ["adb"] })`, no project
 *      root), so the doctor's adb row and every consumer name the same bundled candidate.
 *
 * Caching: keyed on the winning candidate's identity (source + path + size + mtime), so a
 * replaced or removed adb, a changed `$PICO_ADB`, a changed PATH or a toolchain switch is
 * observed inside one process. Absence is never cached. Only the sha256 is skipped on a hit —
 * the candidate chain is re-walked every call.
 */

export type AdbSource = "explicit" | "path" | "bundled";

/** A set-but-unusable `$PICO_ADB`, reported rather than hidden behind the candidate that won. */
export interface AdbOverrideRejection {
  path: string;
  reason: string;
}

/**
 * THE reading of `$PICO_ADB` every consumer shares — exported so the doctor's adb row
 * (src/preflight.ts) classifies the variable exactly as this adapter does instead of carrying a
 * second copy of the rule:
 *   unset    — walk PATH, then the SELECTED toolchain's bundled adb;
 *   blank    — set to an empty or whitespace value: an override that is REFUSED, never read as
 *              unset, because a fixture gate or a shell that pinned it blank must not find a real
 *              adb underneath;
 *   declared — the trimmed path, the ONLY candidate.
 */
export type AdbOverrideDeclaration =
  | { kind: "unset" }
  | { kind: "blank"; rejection: AdbOverrideRejection }
  | { kind: "declared"; path: string };

export function classifyAdbOverride(raw: string | null | undefined): AdbOverrideDeclaration {
  if (raw === undefined || raw === null) return { kind: "unset" };
  const declared = raw.trim();
  if (declared === "") {
    return { kind: "blank", rejection: { path: "", reason: "is set but empty — unset PICO_ADB to use the PATH/bundled chain, or name an absolute executable" } };
  }
  return { kind: "declared", path: declared };
}

/** `$PICO_ADB=<path> <reason>` for messages; an empty path prints as `""` so it still reads as a SET variable. */
export function describeAdbOverrideRejection(rejection: AdbOverrideRejection): string {
  return `$PICO_ADB=${rejection.path === "" ? '""' : rejection.path} ${rejection.reason}`;
}

export type AdbResolution =
  | { status: "ok"; path: string; source: AdbSource; identity: FileIdentity; overrideRejected: AdbOverrideRejection | null; probed: readonly string[] }
  | { status: "unavailable"; code: string; detail: string; overrideRejected: AdbOverrideRejection | null; probed: readonly string[] };

/** The selection IO plus the cheap stat that decides whether a payload needs re-hashing. */
export interface AdbIO extends ToolchainIO {
  stat?(target: string): { size: number; mtimeMs: number } | null;
}

export function hostAdbIO(): AdbIO {
  return {
    ...hostToolchainIO(),
    stat(target: string) {
      try {
        const s = fs.statSync(target);
        return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
      } catch {
        return null;
      }
    },
  };
}

const adbCache = new IdentityCache<{ status: "ok"; path: string; source: AdbSource; identity: FileIdentity }>();

/** Tests only: prove a cache miss. Production never needs it — the key does the work. */
export function clearAdbResolutionCache(): void {
  adbCache.clear();
}

/** The bundled candidate, resolved through the S1 selection WITHOUT hashing a multi-MB payload. */
function bundledAdbCandidate(io: AdbIO): string | null {
  const root = resolveRootCandidate({}, io);
  if ("status" in root) return null;
  const chosen = selectInstallation({ toolsRoot: root.root, required: ["adb"] }, io);
  if ("status" in chosen) return null;
  return chosen.installation.components.adb ?? null;
}

function identityKey(source: AdbSource, target: string, io: AdbIO): string {
  const stat = io.stat?.(target);
  // Without a stat (fixtures, exotic IO) the key falls back to the content itself: correct, just
  // not cheap. It never falls back to the path alone — that is the staleness this task removes.
  if (!stat) {
    const bytes = io.read(target);
    return `${source}\0${target}\0sha:${bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : "unreadable"}`;
  }
  return `${source}\0${target}\0${stat.size}\0${stat.mtimeMs}`;
}

/**
 * Resolve the adb executable this process should run, with its provenance and byte identity.
 * Structural only: nothing is executed and no device connection is opened.
 */
export function resolveAdbExecutable(io: AdbIO = hostAdbIO()): AdbResolution {
  const P = io.platform === "win32" ? path.win32 : path.posix;
  const probed: string[] = [];

  const refuseOverride = (rejection: AdbOverrideRejection): AdbResolution => ({
    status: "unavailable",
    code: "unavailable/adb-override-unusable",
    detail:
      `${describeAdbOverrideRejection(rejection)}. An explicitly configured adb is never ` +
      "replaced by a PATH or bundled candidate, so no fallback was attempted — correct $PICO_ADB, " +
      "or unset it to use PATH and the selected toolchain's bundled platform-tools.",
    overrideRejected: rejection,
    probed,
  });

  // Candidates are probed in precedence order and the walk STOPS at the first usable one, so a
  // host whose adb is on PATH never scans the tools root.
  const pick = ():
    | { kind: "winner"; source: AdbSource; path: string }
    | { kind: "override-rejected"; rejection: AdbOverrideRejection }
    | { kind: "none" } => {
    const declaration = classifyAdbOverride(io.env.PICO_ADB);
    // Set-but-blank is still SET. An operator who exported an empty PICO_ADB did not ask for the
    // PATH/bundled chain, and a harness that pinned it blank must not find a real adb underneath;
    // it is refused like a nonexistent file, and nothing is probed.
    if (declaration.kind === "blank") return { kind: "override-rejected", rejection: declaration.rejection };
    if (declaration.kind === "declared") {
      const declared = declaration.path;
      probed.push(declared);
      // An explicit configuration fails CLOSED, like every other explicit root and pin on this
      // track. Falling through to PATH would run a different binary than the operator named, and
      // the caller — which only ever sees the resolved string — would have no way to notice.
      if (io.realpath(declared) === null) {
        return { kind: "override-rejected", rejection: { path: declared, reason: "names no existing file" } };
      }
      if (!io.executable(declared)) {
        return { kind: "override-rejected", rejection: { path: declared, reason: "is not an executable file" } };
      }
      return { kind: "winner", source: "explicit", path: declared };
    }
    for (const name of executableNames("adb", io.platform)) {
      for (const candidate of executableCandidates(name, io.env, io.platform)) {
        probed.push(candidate);
        if (io.executable(candidate)) return { kind: "winner", source: "path", path: candidate };
      }
    }
    const bundled = bundledAdbCandidate(io);
    if (bundled) {
      probed.push(bundled);
      if (io.executable(bundled)) return { kind: "winner", source: "bundled", path: bundled };
    }
    return { kind: "none" };
  };

  const picked = pick();
  if (picked.kind === "override-rejected") return refuseOverride(picked.rejection);
  if (picked.kind === "none") {
    return {
      status: "unavailable",
      code: "unavailable/adb-missing",
      detail: `adb not found on PATH or in the PICO emulator's bundled platform-tools (probed: ${probed.join(", ") || "nothing"})`,
      overrideRejected: null,
      probed,
    };
  }

  const winner = picked;
  const resolved = adbCache.getOr(
    identityKey(winner.source, P.normalize(winner.path), io),
    () => {
      const bytes = io.read(winner.path);
      return {
        status: "ok" as const,
        path: winner.path,
        source: winner.source,
        identity: {
          path: winner.path,
          // Empty means the payload could not be read (a directory, or X_OK without R_OK). It is an
          // absence of evidence, never a hash — and it is not published, so a file that becomes
          // readable is picked up on the next call.
          sha256: bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : "",
        },
      };
    },
    (value) => value.identity.sha256 !== "",
  );
  if (winner.source === "explicit" && !resolved.identity.sha256) {
    // An override whose bytes cannot be read cannot be identified, and identifying it is the whole
    // point of naming one explicitly. This also catches $PICO_ADB pointing at a directory, which
    // passes an X_OK check.
    return refuseOverride({ path: winner.path, reason: "is not a readable regular file, so the bytes it would be identified by cannot be disclosed" });
  }
  return { ...resolved, overrideRejected: null, probed };
}

/**
 * The executable a consumer runs.
 *
 * An unusable EXPLICIT `$PICO_ADB` throws: it is an operator error, not a degraded host, and every
 * consumer reaches this through a string, so a fall-through would substitute a different binary
 * for an install or a capture with nothing in that operation's own result to say so. Throwing puts
 * it on each caller's existing handler error path instead.
 *
 * No adb anywhere is NOT a throw — the bare name is returned exactly as before, so that failure
 * still lands at the spawn where it always did rather than at a new throw inside a handler that
 * used to degrade.
 */
export function adbExecutable(io: AdbIO = hostAdbIO()): string {
  const resolved = resolveAdbExecutable(io);
  if (resolved.status === "ok") return resolved.path;
  if (resolved.overrideRejected) throw new Error(resolved.detail);
  return "adb";
}

export async function adbPath(): Promise<string> {
  const resolved = resolveAdbExecutable();
  if (resolved.status !== "ok") throw new Error(resolved.detail);
  return resolved.path;
}

export async function adb(args: string[], timeoutMs = 60_000) {
  return run(await adbPath(), args, { timeoutMs });
}

/** Resolve a target device serial: explicit > sole device > sole emulator. */
export async function resolveSerial(serial?: string): Promise<string> {
  if (serial) return serial;
  const r = await adb(["devices"]);
  const devices = r.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === "device")
    .map((p) => p[0]);
  if (devices.length === 1) return devices[0];
  const emulators = devices.filter((d) => d.startsWith("emulator-"));
  if (emulators.length === 1) return emulators[0];
  if (devices.length === 0) throw new Error("No adb devices online. Boot the PICO emulator first (emulator_boot).");
  throw new Error(`Multiple adb devices online (${devices.join(", ")}). Pass 'serial' explicitly.`);
}

const serialParam = z.string().optional().describe("adb device serial (default: the sole connected device / emulator)");

export function registerAdbTools(server: McpServer) {
  server.registerTool(
    "adb_devices",
    {
      description: "List adb devices currently online (the PICO emulator appears as emulator-<port>).",
      inputSchema: {},
    },
    async () => {
      const r = await adb(["devices", "-l"]);
      return r.code === 0 ? ok(r.stdout.trim()) : fail(r.stderr || r.stdout);
    },
  );

  server.registerTool(
    "app_install",
    {
      description: "Install an APK on the PICO emulator/device via adb install -r.",
      inputSchema: {
        apkPath: z.string().describe("Absolute path to the APK"),
        serial: serialParam,
      },
    },
    async ({ apkPath, serial }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "install", "-r", apkPath], 300_000);
      const out = (r.stdout + r.stderr).trim();
      return r.code === 0 && /Success/i.test(out) ? ok(`Installed on ${s}:\n${out}`) : fail(out);
    },
  );

  server.registerTool(
    "app_launch",
    {
      description:
        "Launch an app by package name (and optional activity) on the PICO emulator/device. Without an activity, launches the package's LAUNCHER intent.",
      inputSchema: {
        packageName: z.string(),
        activity: z.string().optional().describe("Fully qualified activity; omit to use the launcher intent"),
        serial: serialParam,
      },
    },
    async ({ packageName, activity, serial }) => {
      const s = await resolveSerial(serial);
      const r = activity
        ? await adb(["-s", s, "shell", "am", "start", "-n", `${packageName}/${activity}`])
        : await adb(["-s", s, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"]);
      const out = (r.stdout + r.stderr).trim();
      return r.code === 0 && !/Error|No activities found/i.test(out) ? ok(out || `Launched ${packageName}`) : fail(out);
    },
  );

  server.registerTool(
    "app_stop",
    {
      description: "Force-stop an app by package name.",
      inputSchema: { packageName: z.string(), serial: serialParam },
    },
    async ({ packageName, serial }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "shell", "am", "force-stop", packageName]);
      return r.code === 0 ? ok(`Stopped ${packageName}`) : fail(r.stderr || r.stdout);
    },
  );

  server.registerTool(
    "screencap",
    {
      description: "Capture a PNG screenshot of the PICO emulator/device display via adb (returns the image).",
      inputSchema: { serial: serialParam },
    },
    async ({ serial }) => {
      const s = await resolveSerial(serial);
      const r = await runBinary(await adbPath(), ["-s", s, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      if (r.code !== 0 || r.stdout.length < 8) return fail(`screencap failed: ${r.stderr}`);
      return image(r.stdout.toString("base64"), `Screenshot of ${s} (${r.stdout.length} bytes)`);
    },
  );

  server.registerTool(
    "logcat",
    {
      description: "Dump recent logcat output, optionally filtered by tag and/or a regex over lines. `clear:true` is the ONE destructive log operation on this server: it erases the device's global log buffer and requires an explicit serial. Scoped observation never needs it — assert_logcat / wait_for_log open a marker window instead.",
      inputSchema: {
        serial: serialParam,
        tag: z.string().optional().describe("Only show this log tag (logcat <tag>:V *:S)"),
        grep: z.string().optional().describe("Case-insensitive regex applied to lines"),
        lines: z.number().int().min(1).max(2000).default(200).describe("Max lines returned (from the end)"),
        clear: z.boolean().default(false).describe("DESTRUCTIVE: erases the device's global log buffer instead of dumping; explicit serial required (no sole-device resolution). This is an operator request, never part of ordinary verification — assert_logcat / wait_for_log scope their reads with a marker window and clear nothing."),
      },
    },
    async ({ serial, tag, grep, lines, clear }) => {
      if (clear) {
        // The explicit, operator-requested clear: the target must be NAMED. No sole-device resolution
        // can stand in for it, because the operation is irreversible and this host may carry devices
        // reserved for someone else (docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md, Incident 3).
        const target = serial?.trim() ?? "";
        if (!target) {
          return fail("logcat clear:true is destructive (it erases the device's global log buffer) and requires an explicit serial; no sole-device resolution is performed for a clear. Pass serial, or use assert_logcat / wait_for_log, which open a marker window instead of clearing.");
        }
        const r = await adb(["-s", target, "logcat", "-c"]);
        return r.code === 0 ? ok(`logcat buffer cleared on ${target} (destructive; explicit serial ${target})`) : fail(r.stderr || r.stdout || `exit ${r.code}`);
      }
      const s = await resolveSerial(serial);
      const args = ["-s", s, "logcat", "-d"];
      if (tag) args.push(`${tag}:V`, "*:S");
      const r = await adb(args, 60_000);
      if (r.code !== 0) return fail(r.stderr || r.stdout);
      let out = r.stdout.split("\n");
      if (grep) {
        const re = new RegExp(grep, "i");
        out = out.filter((l) => re.test(l));
      }
      return ok(out.slice(-lines).join("\n") || "(no matching lines)");
    },
  );

  server.registerTool(
    "ui_input",
    {
      description:
        "Inject 2D input via adb: tap, swipe, text, or keyevent. On the PICO emulator, key events also drive the keyboard-mapped XR controllers (see controller_settings.ini mapping).",
      inputSchema: {
        serial: serialParam,
        action: z.enum(["tap", "swipe", "text", "keyevent"]),
        x: z.number().optional(),
        y: z.number().optional(),
        x2: z.number().optional().describe("swipe end x"),
        y2: z.number().optional().describe("swipe end y"),
        durationMs: z.number().optional().describe("swipe duration"),
        text: z.string().optional().describe("for action=text"),
        keycode: z.string().optional().describe("for action=keyevent, e.g. KEYCODE_Q or 66"),
      },
    },
    async ({ serial, action, x, y, x2, y2, durationMs, text, keycode }) => {
      const s = await resolveSerial(serial);
      let args: string[];
      switch (action) {
        case "tap":
          if (x == null || y == null) return fail("tap requires x and y");
          args = ["input", "tap", String(x), String(y)];
          break;
        case "swipe":
          if (x == null || y == null || x2 == null || y2 == null) return fail("swipe requires x, y, x2, y2");
          args = ["input", "swipe", String(x), String(y), String(x2), String(y2), ...(durationMs ? [String(durationMs)] : [])];
          break;
        case "text":
          if (!text) return fail("text action requires text");
          args = ["input", "text", text.replace(/ /g, "%s")];
          break;
        case "keyevent":
          if (!keycode) return fail("keyevent requires keycode");
          args = ["input", "keyevent", keycode];
          break;
      }
      const r = await adb(["-s", s, "shell", ...args]);
      return r.code === 0 ? ok(`${action} ok`) : fail(r.stderr || r.stdout);
    },
  );

  server.registerTool(
    "assert_logcat",
    {
      description:
        "VERIFICATION PRIMITIVE — wait up to timeoutSec for a logcat line matching `pattern` (optionally scoped to `tag`) to appear, polling a bounded dump. Turns an app's Log.* markers into a machine-checkable pass/fail signal so an agent can PROVE behavior instead of eyeballing it (e.g. assert 'rayCast HIT' after attaching a collider, or 'placed pin #' after a commit). Returns {matched, line, elapsedSec, serial, logWindow} — matched:false is a normal (non-error) result so callers can branch and escalate; status:'inconclusive' means either the window's marker was never seen in the bounded dump, or the observation was LOST because the final dump before the deadline failed (dumps.succeeded/failed/lastError say which) — in both cases nothing was measured, re-run. Nothing here clears the device log. Typical loop: open a window (clearFirst:true, or write your own marker with adb_shell `log -t pico-mcp <marker>` and pass sinceMarker) → trigger the action (launch / drive input) → assert_logcat.",
      inputSchema: {
        serial: serialParam,
        pattern: z.string().describe("Case-insensitive regex matched against each logcat line, e.g. 'rayCast HIT' or 'placed pin #\\\\d+'"),
        tag: z.string().optional().describe("Restrict to this log tag (logcat <tag>:V *:S), e.g. ClaimSightPin"),
        timeoutSec: z.number().int().min(1).max(180).default(20),
        clearFirst: z.boolean().default(false).describe("Opens a marker window instead of clearing the device log; equivalent to sinceMarker with a fresh marker (kept for compatibility — use when re-running the same assertion so stale lines cannot match). Nothing is erased."),
        sinceMarker: z.string().optional().describe("Match only lines logged AFTER this marker line (e.g. one you wrote with adb_shell `log -t pico-mcp <marker>` before the action). Takes precedence over clearFirst. A marker absent from the bounded dump makes the result inconclusive — never a match against the unscoped buffer."),
        maxLines: z.number().int().min(100).max(200000).optional().describe("Bound on each raw dump (`logcat -t <n>`) of a WINDOWED read — one opened by clearFirst:true or named by sinceMarker. Without a window there is nothing to slice after, so the poll dumps the whole buffer and this input is inert. logd applies the bound to the selected buffers BEFORE the tag filter, so on a chatty device a small tail can drop the window marker while the filtered output stays short — the result is then inconclusive, never a false pass. Default 20000 (the module default of 4000 suits short reads; this tool polls for up to 180 s). Raise it for a long poll on a busy device: `-t <n>` never returns more than the buffer holds."),
        pollMs: z.number().int().min(200).max(5000).default(700),
      },
    },
    async ({ serial, pattern, tag, timeoutSec, clearFirst, sinceMarker, maxLines, pollMs }) => {
      const s = await resolveSerial(serial);
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch (e) {
        return fail(`Invalid regex /${pattern}/: ${(e as Error).message}`);
      }
      // A window scopes the poll to lines after its marker (src/logwindow.ts). Without one the whole
      // buffer is still the (compatible) scope — and either way nothing is cleared.
      const runner: AdbRunner = (args, timeoutMs) => adb(args, timeoutMs ?? 60_000);
      // A long poller's bound (src/logwindow.ts): the raw tail logd keeps BEFORE the tag filter.
      // It applies to the windowed read only; the unwindowed branch below dumps the whole buffer.
      const bound = maxLines ?? LONG_POLL_LOG_WINDOW_MAX_LINES;
      let window: LogWindow | null = null;
      if (sinceMarker) {
        window = logWindowFromMarker(s, sinceMarker);
      } else if (clearFirst) {
        try {
          window = await openLogWindow(runner, s);
        } catch (e) {
          return okJson({
            matched: false,
            status: "inconclusive",
            tag: tag ?? null,
            pattern,
            serial: s,
            logWindow: e instanceof LogWindowOpenError ? { marker: e.marker, markerSeen: false } : null,
            hint: `could not open a log window on ${s}; nothing was polled: ${(e as Error).message}`,
          });
        }
      }
      const start = Date.now();
      const deadline = start + timeoutSec * 1000;
      let lastTail = "";
      let markerSeen = false;
      let successfulDumps = 0;
      let failedDumps = 0;
      // Whether the MOST RECENT dump succeeded. A miss is conclusive only when the final dump before
      // the deadline succeeded: an earlier good dump cannot vouch for lines logged after it, so a
      // poll whose last dumps failed has LOST its observation (2026-09-16 native-acceptance fixture).
      let lastDumpSucceeded: boolean | null = null;
      let lastReadError: string | null = null;
      const dumpArgs = ["-s", s, "logcat", "-d", ...(tag ? [`${tag}:V`, "*:S"] : [])];
      while (Date.now() < deadline) {
        let lines: string[] | null = null;
        if (window) {
          try {
            const read = await readLogWindow(runner, window, { tags: tag ? [tag] : undefined, maxLines: bound, timeoutMs: 30_000 });
            successfulDumps += 1;
            lastDumpSucceeded = true;
            markerSeen = read.markerSeen;
            lines = read.markerSeen ? read.lines : null; // no marker: nothing here is provably post-window
          } catch (e) {
            // a failed dump is retried until the deadline — and remembered, so a dead adb is reported
            // below as the dump failure it is, never as log eviction (unseenMarkerCause)
            failedDumps += 1;
            lastDumpSucceeded = false;
            lastReadError = e instanceof Error ? e.message : String(e);
            lines = null;
          }
        } else {
          const r = await adb(dumpArgs, 30_000);
          if (r.code === 0) {
            successfulDumps += 1;
            lastDumpSucceeded = true;
            lines = r.stdout.split("\n");
          } else {
            failedDumps += 1;
            lastDumpSucceeded = false;
            lastReadError = (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 300);
          }
        }
        if (lines) {
          const hit = lines.find((l) => re.test(l));
          if (hit) {
            return okJson({
              matched: true,
              line: hit.trim(),
              elapsedSec: +((Date.now() - start) / 1000).toFixed(1),
              tag: tag ?? null,
              pattern,
              serial: s,
              logWindow: window ? { marker: window.marker, markerSeen: true } : null,
            });
          }
          lastTail = lines.filter((l) => l.trim()).slice(-8).join("\n");
        }
        await sleep(pollMs);
      }
      const dumps = { succeeded: successfulDumps, failed: failedDumps, lastError: lastReadError };
      if (window && !markerSeen) {
        return okJson({
          matched: false,
          status: "inconclusive",
          timedOutAfterSec: timeoutSec,
          tag: tag ?? null,
          pattern,
          serial: s,
          logWindow: { marker: window.marker, markerSeen: false },
          maxLines: bound,
          dumps,
          hint: `The log window marker was never seen (${unseenMarkerCause({ successfulDumps, lastReadError })}; bound -t ${bound}). The device log was NOT cleared and nothing was matched against the unscoped buffer. ${successfulDumps === 0 && lastReadError !== null ? `Check the adb connection to ${s}` : "Re-open the window (clearFirst:true or a fresh sinceMarker), raise maxLines if the device is chatty"}, and re-run.`,
        });
      }
      if (lastDumpSucceeded !== true) {
        // The observation was LOST: the last dump before the deadline failed (or no dump ever ran),
        // so "no match" is not something this poll observed for the tail of the window. Report it as
        // inconclusive — a replan or retry that chased it would chase a miss nothing measured.
        return okJson({
          matched: false,
          status: "inconclusive",
          timedOutAfterSec: timeoutSec,
          tag: tag ?? null,
          pattern,
          serial: s,
          logWindow: window ? { marker: window.marker, markerSeen: true } : null,
          dumps,
          hint: `The observation was lost: the last logcat dump before the deadline failed (${dumps.succeeded} succeeded, ${dumps.failed} failed; last error: ${lastReadError ?? "none recorded"}). ${window ? "The window's marker WAS seen, so the window is not the problem; " : ""}nothing was matched for the tail of the poll, so this is NOT a measured miss. Check the adb connection to ${s} and re-run.`,
          lastLines: lastTail || (window ? "(no lines after the window marker for this tag)" : "(buffer empty for this tag)"),
        });
      }
      return okJson({
        matched: false,
        timedOutAfterSec: timeoutSec,
        tag: tag ?? null,
        pattern,
        serial: s,
        logWindow: window ? { marker: window.marker, markerSeen: true } : null,
        dumps,
        hint: "No matching line within the timeout. Confirm the app emitted the log (it may need an action to trigger it), the tag is right, and the serial is correct.",
        lastLines: lastTail || (window ? "(no lines after the window marker for this tag)" : "(buffer empty for this tag)"),
      });
    },
  );

  server.registerTool(
    "app_broadcast",
    {
      description:
        "Send an Android broadcast Intent via `am broadcast` — a HEADLESS command channel into an app's BroadcastReceiver. This is how an agent drives in-app actions the PICO emulator can't otherwise trigger (the controller trigger is GUI-gated). E.g. ClaimSight registers `com.example.claimsight.DEBUG_CMD` with a `cmd` string extra: arm | commit | select | report | clear | mute | demo — so the full menu→pin→panel UX is drivable without a trigger. Pair with assert_logcat (verify the action fired) + gui_capture (see the result).",
      inputSchema: {
        serial: serialParam,
        action: z.string().describe("Intent action, e.g. com.example.claimsight.DEBUG_CMD"),
        stringExtras: z.record(z.string(), z.string()).optional().describe("--es key value extras, e.g. { cmd: 'commit' }"),
        intExtras: z.record(z.string(), z.number().int()).optional().describe("--ei key value extras, e.g. { arg: 0 }"),
        component: z.string().optional().describe("Optional explicit receiver component pkg/cls to target a manifest receiver"),
      },
    },
    async ({ serial, action, stringExtras, intExtras, component }) => {
      const s = await resolveSerial(serial);
      const args = ["-s", s, "shell", "am", "broadcast", "-a", action];
      if (component) args.push("-n", component);
      for (const [k, v] of Object.entries(stringExtras ?? {})) args.push("--es", k, v);
      for (const [k, v] of Object.entries(intExtras ?? {})) args.push("--ei", k, String(v));
      const r = await adb(args);
      const out = (r.stdout + r.stderr).trim();
      // `am broadcast` prints "Broadcast completed: result=0" on success (result=0 is normal).
      return r.code === 0 && /Broadcast completed/i.test(out)
        ? ok(`Sent ${action}${stringExtras ? " " + JSON.stringify(stringExtras) : ""}${intExtras ? " " + JSON.stringify(intExtras) : ""}\n${out}`)
        : fail(out || "am broadcast produced no output");
    },
  );

  server.registerTool(
    "adb_shell",
    {
      description: "Run an arbitrary adb shell command on the PICO emulator/device and return its output.",
      inputSchema: {
        command: z.string().describe("Shell command, e.g. 'getprop ro.build.fingerprint'"),
        serial: serialParam,
        timeoutMs: z.number().int().default(60000),
      },
    },
    async ({ command, serial, timeoutMs }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "shell", command], timeoutMs);
      const out = (r.stdout + (r.stderr ? `\n[stderr] ${r.stderr}` : "")).trim();
      return r.code === 0 ? ok(tail(out, 200) || "(no output)") : fail(out);
    },
  );

  server.registerTool(
    "file_push",
    {
      description: "Push a local file to the device (e.g. a .bundle for app-side hot reload).",
      inputSchema: { localPath: z.string(), remotePath: z.string(), serial: serialParam },
    },
    async ({ localPath, remotePath, serial }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "push", localPath, remotePath], 300_000);
      return r.code === 0 ? ok(r.stdout.trim()) : fail(r.stderr || r.stdout);
    },
  );

  server.registerTool(
    "file_pull",
    {
      description: "Pull a file from the device to a local path.",
      inputSchema: { remotePath: z.string(), localPath: z.string(), serial: serialParam },
    },
    async ({ remotePath, localPath, serial }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "pull", remotePath, localPath], 300_000);
      return r.code === 0 ? ok(r.stdout.trim()) : fail(r.stderr || r.stdout);
    },
  );
}
