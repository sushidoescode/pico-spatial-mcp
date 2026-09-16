import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, ok, okJson, sleep, tail } from "./util.js";
import { AVD_HOME } from "./toolchain.js";
import { adb, resolveSerial } from "./adb.js";
import { LONG_POLL_LOG_WINDOW_MAX_LINES, openLogWindow, readLogWindow, unseenMarkerCause, type AdbRunner, type LogWindow } from "./logwindow.js";

/**
 * v0.3 — capabilities a self-running agent loop needs beyond raw observe/control:
 * deterministic state (snapshots), structured UI observation (no coordinate
 * guessing), event-driven waiting (logcat patterns / boot), crash detection,
 * semantic XR controller input parsed from the AVD's real key mapping, and
 * screen recording for multi-frame verification.
 */

// ---- Controller key mapping (parsed from the AVD's controller_settings.ini) ----

/**
 * controller_settings.ini stores ASCII codes for letters (e.g. Q=81, W=87) and
 * 32 for space. Android `input keyevent` wants KEYCODE_* names. Map ASCII->keycode.
 */
function asciiToKeyevent(code: number): string {
  if (code === 32) return "KEYCODE_SPACE";
  if (code >= 65 && code <= 90) return `KEYCODE_${String.fromCharCode(code)}`; // A-Z
  if (code >= 97 && code <= 122) return `KEYCODE_${String.fromCharCode(code - 32)}`;
  if (code >= 48 && code <= 57) return `KEYCODE_${String.fromCharCode(code)}`; // 0-9
  return `${code}`;
}

interface ControllerMap {
  path: string;
  buttons: Record<string, { code: number; keyevent: string }>;
}

function readControllerMap(avd?: string): ControllerMap | null {
  const avdName = avd ?? (fs.existsSync(AVD_HOME) ? fs.readdirSync(AVD_HOME).find((d) => d.endsWith(".avd"))?.replace(/\.avd$/, "") : undefined);
  if (!avdName) return null;
  const ini = path.join(AVD_HOME, `${avdName}.avd`, "controller_settings.ini");
  if (!fs.existsSync(ini)) return null;
  const buttons: ControllerMap["buttons"] = {};
  for (const line of fs.readFileSync(ini, "utf8").split("\n")) {
    const m = line.match(/^\s*([LR]C_[A-Za-z]+)\s*=\s*(\d+)\s*$/);
    if (m) {
      const code = parseInt(m[2], 10);
      if (code > 0) buttons[m[1]] = { code, keyevent: asciiToKeyevent(code) };
    }
  }
  return { path: ini, buttons };
}

export function registerAgentLoopTools(server: McpServer) {
  // ---- Snapshots: deterministic test fixtures ----
  server.registerTool(
    "snapshot_save",
    {
      description:
        "Save a named emulator snapshot (full VM state) via the console. Use to capture a known-good state (app installed, scene loaded) you can restore before each test for determinism.",
      inputSchema: { name: z.string().regex(/^[A-Za-z0-9_.-]+$/), serial: z.string().optional() },
    },
    async ({ name, serial }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "emu", "avd", "snapshot", "save", name], 120_000);
      const out = (r.stdout + r.stderr).trim();
      return /OK|^$/.test(out) || r.code === 0 ? ok(`Snapshot '${name}' saved.`) : fail(out);
    },
  );

  server.registerTool(
    "snapshot_load",
    {
      description: "Restore a named emulator snapshot — resets the VM to that exact state (the core of deterministic, repeatable XR tests).",
      inputSchema: { name: z.string(), serial: z.string().optional() },
    },
    async ({ name, serial }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "emu", "avd", "snapshot", "load", name], 120_000);
      const out = (r.stdout + r.stderr).trim();
      return r.code === 0 && !/KO|fail|Unknown/i.test(out) ? ok(`Snapshot '${name}' restored.`) : fail(out || "load failed");
    },
  );

  server.registerTool(
    "snapshot_list",
    {
      description: "List saved snapshots for the running emulator.",
      inputSchema: { serial: z.string().optional() },
    },
    async ({ serial }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "emu", "avd", "snapshot", "list"], 30_000);
      return ok((r.stdout + r.stderr).trim() || "(none)");
    },
  );

  // ---- Structured UI observation ----
  server.registerTool(
    "ui_dump",
    {
      description:
        "Dump the current UI hierarchy via uiautomator as structured elements (text, resource-id, class, clickable, bounds + center). Lets an agent find and tap elements by name instead of guessing pixel coordinates. Note: captures the 2D Android view layer (panels/menus), not 3D spatial content.",
      inputSchema: {
        serial: z.string().optional(),
        filterText: z.string().optional().describe("Only return nodes whose text/resource-id/content-desc matches this (case-insensitive)"),
      },
    },
    async ({ serial, filterText }) => {
      const s = await resolveSerial(serial);
      await adb(["-s", s, "shell", "uiautomator", "dump", "/sdcard/ui.xml"], 30_000);
      const r = await adb(["-s", s, "shell", "cat", "/sdcard/ui.xml"], 15_000);
      const xml = r.stdout;
      if (!xml.includes("<node")) return fail(`uiautomator dump produced no nodes: ${tail(xml, 10)}`);
      const re = filterText ? new RegExp(filterText, "i") : null;
      const nodes: any[] = [];
      for (const m of xml.matchAll(/<node\b[^>]*?(?:\/>|>)/g)) {
        const tagText = m[0];
        const attr = (k: string) => tagText.match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? "";
        const text = attr("text");
        const rid = attr("resource-id");
        const desc = attr("content-desc");
        const cls = attr("class");
        const clickable = attr("clickable") === "true";
        if (!text && !rid && !desc && !clickable) continue;
        if (re && !re.test(`${text} ${rid} ${desc}`)) continue;
        const b = attr("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
        const center = b ? { x: Math.round((+b[1] + +b[3]) / 2), y: Math.round((+b[2] + +b[4]) / 2) } : null;
        nodes.push({ text, resourceId: rid, contentDesc: desc, class: cls, clickable, center });
      }
      return okJson({ count: nodes.length, nodes: nodes.slice(0, 200) });
    },
  );

  // ---- Event-driven waiting ----
  server.registerTool(
    "wait_for_log",
    {
      description:
        "Block until a regex appears in logcat (or timeout). Essential for an agent loop: wait for 'scene loaded', an app-ready marker, or an error, instead of sleeping a fixed time. By default it opens a marker window first, so only lines logged after the call can match; the device log is never cleared. Returns {matched, elapsedSec, serial, logWindow, lines}; a window whose marker is never seen is an inconclusive error, never a match against the unscoped buffer.",
      inputSchema: {
        pattern: z.string().describe("Regex to match against new logcat lines"),
        serial: z.string().optional(),
        tag: z.string().optional(),
        timeoutSec: z.number().int().default(30),
        clearFirst: z.boolean().default(true).describe("Open a marker window before waiting (recommended): only lines logged after the window opens can match. Nothing is cleared; false polls the whole buffer."),
        maxLines: z.number().int().min(100).max(200000).optional().describe("Bound on each raw dump (`logcat -t <n>`). logd applies it to the selected buffers BEFORE the tag filter, so on a chatty device a small tail can drop the window marker while the filtered output stays short — the wait is then inconclusive, never a false match. Default 20000 (the module default of 4000 suits short reads; this tool polls for tens of seconds). Raise it for a long wait on a busy device: `-t <n>` never returns more than the buffer holds."),
      },
    },
    async ({ pattern, serial, tag, timeoutSec, clearFirst, maxLines }) => {
      const s = await resolveSerial(serial);
      const runner: AdbRunner = (args, timeoutMs) => adb(args, timeoutMs ?? 60_000);
      // A long poller's bound (src/logwindow.ts): the raw tail logd keeps BEFORE the tag filter.
      const bound = maxLines ?? LONG_POLL_LOG_WINDOW_MAX_LINES;
      let window: LogWindow | null = null;
      if (clearFirst) {
        try {
          window = await openLogWindow(runner, s);
        } catch (e) {
          return fail(`Inconclusive: could not open a log window on ${s}, so nothing was polled (${(e as Error).message}). status=inconclusive`);
        }
      }
      const re = new RegExp(pattern, "i");
      const started = Date.now();
      const deadline = started + timeoutSec * 1000;
      const filter = tag ? [`${tag}:V`, "*:S"] : [];
      let markerSeen = false;
      let successfulDumps = 0;
      let lastReadError: string | null = null;
      while (Date.now() < deadline) {
        let lines: string[] | null = null;
        if (window) {
          try {
            const read = await readLogWindow(runner, window, { tags: tag ? [tag] : undefined, maxLines: bound, timeoutMs: 20_000 });
            successfulDumps += 1;
            markerSeen = read.markerSeen;
            lines = read.markerSeen ? read.lines : null; // no marker: nothing here is provably post-window
          } catch (e) {
            // a failed dump is retried until the deadline — and remembered, so a dead adb is reported
            // below as the dump failure it is, never as log eviction (unseenMarkerCause)
            lastReadError = e instanceof Error ? e.message : String(e);
            lines = null;
          }
        } else {
          const r = await adb(["-s", s, "logcat", "-d", ...filter], 20_000);
          lines = r.stdout.split("\n");
        }
        const hit = lines ? lines.filter((l) => re.test(l)) : [];
        if (hit.length) {
          return okJson({
            matched: true,
            elapsedSec: Math.round((Date.now() - started) / 1000),
            serial: s,
            logWindow: window ? { marker: window.marker, markerSeen: true } : null,
            lines: hit.slice(-10),
          });
        }
        await sleep(1000);
      }
      if (window && !markerSeen) {
        const deadAdb = successfulDumps === 0 && lastReadError !== null;
        return fail(`Inconclusive: the log window marker ${window.marker} was never seen on ${s} within ${timeoutSec}s (${unseenMarkerCause({ successfulDumps, lastReadError })}; bound -t ${bound}); the device log was NOT cleared and nothing was matched against the unscoped buffer — ${deadAdb ? "check the adb connection" : "raise maxLines if the device is chatty"} and re-run. status=inconclusive`);
      }
      return fail(`Timeout: /${pattern}/ not seen in ${timeoutSec}s on ${s}${window ? ` (log window ${window.marker}, markerSeen=true)` : ""}`);
    },
  );

  // ---- Crash / health detection ----
  server.registerTool(
    "check_crash",
    {
      description:
        "Scan recent logcat for crashes/ANRs/fatal exceptions (optionally for one package) and report whether a process is alive. Use after launching or driving an app to detect failures an agent must react to.",
      inputSchema: {
        serial: z.string().optional(),
        packageName: z.string().optional().describe("Also check this process is running and filter crashes to it"),
        lines: z.number().int().default(500),
      },
    },
    async ({ serial, packageName, lines }) => {
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "logcat", "-d", "-t", String(lines)], 30_000);
      const crashRe = /FATAL EXCEPTION|ANR in|signal \d+ \(SIG|beginning of crash|E AndroidRuntime|tombstoned/i;
      const crashes = r.stdout.split("\n").filter((l) => crashRe.test(l) && (!packageName || l.includes(packageName)));
      let alive: boolean | null = null;
      if (packageName) {
        const pid = await adb(["-s", s, "shell", "pidof", packageName], 10_000);
        alive = pid.stdout.trim().length > 0;
      }
      const healthy = crashes.length === 0 && alive !== false;
      return okJson({
        healthy,
        processAlive: alive,
        crashCount: crashes.length,
        crashes: crashes.slice(-8),
      });
    },
  );

  // ---- Semantic XR controller input (keyboard-mapped) ----
  server.registerTool(
    "controller_map",
    {
      description:
        "Return the PICO emulator's controller→keyboard mapping (parsed from the AVD's controller_settings.ini), with the adb keyevent for each control. This is how controller buttons are driven on the emulator (there is no 6DOF controller-pose API).",
      inputSchema: { avd: z.string().optional() },
    },
    async ({ avd }) => {
      const m = readControllerMap(avd);
      if (!m) return fail("No controller_settings.ini found for the AVD");
      return okJson(m);
    },
  );

  server.registerTool(
    "controller_press",
    {
      description:
        "Press a PICO controller control by semantic name (e.g. 'RC_Trigger', 'LC_Grip', 'RC_A') — resolves it through the AVD's key mapping and injects the corresponding keyevent via adb. Buttons only; joystick directions are LC_Up/Down/Left/Right and RC_Up/Down/Left/Right.",
      inputSchema: {
        control: z.string().describe("Control name from controller_map, e.g. RC_Trigger, LC_X, RC_A, LC_Up"),
        serial: z.string().optional(),
        avd: z.string().optional(),
      },
    },
    async ({ control, serial, avd }) => {
      const m = readControllerMap(avd);
      if (!m) return fail("No controller_settings.ini found");
      const btn = m.buttons[control];
      if (!btn) return fail(`Unknown control '${control}'. Available: ${Object.keys(m.buttons).join(", ")}`);
      const s = await resolveSerial(serial);
      const r = await adb(["-s", s, "shell", "input", "keyevent", btn.keyevent]);
      return r.code === 0 ? ok(`Pressed ${control} (${btn.keyevent})`) : fail(r.stderr || r.stdout);
    },
  );

  // ---- Screen recording ----
  server.registerTool(
    "screenrecord",
    {
      description:
        "Record the emulator screen for N seconds (adb screenrecord) and pull the mp4 locally — for verifying animation/interaction over time, which a single screenshot can't capture.",
      inputSchema: {
        durationSec: z.number().int().min(1).max(180).default(8),
        localPath: z.string().optional().describe("Where to save the mp4 (default: temp dir)"),
        serial: z.string().optional(),
      },
    },
    async ({ durationSec, localPath, serial }) => {
      const s = await resolveSerial(serial);
      const remote = `/sdcard/pico-mcp-rec-${Date.now()}.mp4`;
      const out = expandHome(localPath ?? path.join(os.tmpdir(), "pico-mcp", `rec-${Date.now()}.mp4`));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const rec = await adb(["-s", s, "shell", "screenrecord", "--time-limit", String(durationSec), remote], (durationSec + 15) * 1000);
      if (rec.code !== 0 && rec.stderr) return fail(`screenrecord failed: ${rec.stderr}`);
      await sleep(1000);
      const pull = await adb(["-s", s, "pull", remote, out], 120_000);
      await adb(["-s", s, "shell", "rm", remote]);
      if (pull.code !== 0) return fail(`pull failed: ${pull.stderr || pull.stdout}`);
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      return ok(`Recorded ${durationSec}s -> ${out} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    },
  );
}
