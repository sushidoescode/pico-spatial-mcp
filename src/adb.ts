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
 *      whole task exists to remove. `adbExecutable` turns that refusal into a throw.
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
      `$PICO_ADB=${rejection.path} ${rejection.reason}. An explicitly configured adb is never ` +
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
    const declared = (io.env.PICO_ADB ?? "").trim();
    if (declared) {
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
      description: "Dump recent logcat output, optionally filtered by tag and/or a regex over lines.",
      inputSchema: {
        serial: serialParam,
        tag: z.string().optional().describe("Only show this log tag (logcat <tag>:V *:S)"),
        grep: z.string().optional().describe("Case-insensitive regex applied to lines"),
        lines: z.number().int().min(1).max(2000).default(200).describe("Max lines returned (from the end)"),
        clear: z.boolean().default(false).describe("Clear the log buffer instead of dumping"),
      },
    },
    async ({ serial, tag, grep, lines, clear }) => {
      const s = await resolveSerial(serial);
      if (clear) {
        const r = await adb(["-s", s, "logcat", "-c"]);
        return r.code === 0 ? ok("logcat buffer cleared") : fail(r.stderr);
      }
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
        "VERIFICATION PRIMITIVE — wait up to timeoutSec for a logcat line matching `pattern` (optionally scoped to `tag`) to appear, polling the buffer. Turns an app's Log.* markers into a machine-checkable pass/fail signal so an agent can PROVE behavior instead of eyeballing it (e.g. assert 'rayCast HIT' after attaching a collider, or 'placed pin #' after a commit). Returns {matched, line, elapsedSec} — matched:false is a normal (non-error) result so callers can branch and escalate. Typical loop: clear → trigger the action (launch / drive input) → assert_logcat.",
      inputSchema: {
        serial: serialParam,
        pattern: z.string().describe("Case-insensitive regex matched against each logcat line, e.g. 'rayCast HIT' or 'placed pin #\\\\d+'"),
        tag: z.string().optional().describe("Restrict to this log tag (logcat <tag>:V *:S), e.g. ClaimSightPin"),
        timeoutSec: z.number().int().min(1).max(180).default(20),
        clearFirst: z.boolean().default(false).describe("adb logcat -c before polling (use when re-running the same assertion to avoid matching stale lines)"),
        pollMs: z.number().int().min(200).max(5000).default(700),
      },
    },
    async ({ serial, pattern, tag, timeoutSec, clearFirst, pollMs }) => {
      const s = await resolveSerial(serial);
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch (e) {
        return fail(`Invalid regex /${pattern}/: ${(e as Error).message}`);
      }
      if (clearFirst) await adb(["-s", s, "logcat", "-c"]);
      const start = Date.now();
      const deadline = start + timeoutSec * 1000;
      let lastTail = "";
      const dumpArgs = ["-s", s, "logcat", "-d", ...(tag ? [`${tag}:V`, "*:S"] : [])];
      while (Date.now() < deadline) {
        const r = await adb(dumpArgs, 30_000);
        if (r.code === 0) {
          const lines = r.stdout.split("\n");
          const hit = lines.find((l) => re.test(l));
          if (hit) {
            return okJson({ matched: true, line: hit.trim(), elapsedSec: +((Date.now() - start) / 1000).toFixed(1), tag: tag ?? null, pattern });
          }
          lastTail = lines.filter((l) => l.trim()).slice(-8).join("\n");
        }
        await sleep(pollMs);
      }
      return okJson({
        matched: false,
        timedOutAfterSec: timeoutSec,
        tag: tag ?? null,
        pattern,
        hint: "No matching line within the timeout. Confirm the app emitted the log (it may need an action to trigger it), the tag is right, and the serial is correct.",
        lastLines: lastTail || "(buffer empty for this tag)",
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
