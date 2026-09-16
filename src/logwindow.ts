import { randomUUID } from "node:crypto";

/**
 * logwindow.ts — marker-correlated, bounded log observation (host completion T4, 2026-09-16).
 *
 * WHY THIS MODULE EXISTS. Several observation paths used to CLEAR the device's global log buffer
 * before reading it, just to scope their own scan to "lines produced from now on". That clear is
 * irreversible and it is not this server's log to erase: docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md
 * (Negative evidence, Incident 3) records ~20 such clears of the user's emulator from one RED run.
 * The user ruled every one of them a constraint violation.
 *
 * THE REPLACEMENT. A window is opened by writing ONE marker line into the device's main buffer
 * (`adb -s <serial> shell log -t pico-mcp <marker>`; the `log` command appends a line at priority I)
 * and read back with a BOUNDED dump (`logcat -d -v threadtime -t <maxLines>` plus tag filters that
 * always admit the marker tag) sliced to the lines AFTER the marker. Nothing is ever removed from
 * the device. Flags per the AOSP logcat help text: `-d` dump and exit, `-t <count>` most recent
 * <count> lines, `-v threadtime` the timestamped format, `-b <buffer>` (repeatable; `all`), and the
 * filterspec `TAG:V ... *:S` which admits the named tags and silences the rest.
 *
 * THE SEMANTICS EVERY CALLER FOLLOWS. `markerSeen: false` means the marker was evicted from the
 * bounded tail (or never written) — the read is INCONCLUSIVE. A caller reports
 * `{ serial, logWindow: { marker, markerSeen: false } }` with an inconclusive status and never
 * matches its pattern against the unscoped buffer instead. Every result also names the explicit
 * target (`serial`) the window was opened on.
 *
 * `-t <count>` is applied by logd to the selected buffers BEFORE the client-side tag filter, so a
 * busy device can push the marker out of the tail even when the filtered output is short; that is
 * exactly the case `markerSeen: false` reports, and callers that poll for long pass a larger
 * `maxLines` rather than trusting a partial tail.
 */

export const LOG_WINDOW_TAG = "pico-mcp";

/** The default bound on one dump. Callers polling for tens of seconds may raise it. */
export const DEFAULT_LOG_WINDOW_MAX_LINES = 4000;

export interface LogWindow {
  /** The explicit device the marker was written to. */
  serial: string;
  /** `pico-mcp-window-<uuid>` — the line every read slices after. */
  marker: string;
  /** ISO time the host wrote (or, for a caller-supplied marker, adopted) the window. */
  openedAt: string;
}

/** What every call site adapts its own adb shape to: `(args, timeoutMs?) => {code, stdout, stderr}`. */
export type AdbRunner = (args: string[], timeoutMs?: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface ReadLogWindowOptions {
  /** Tags to admit (`TAG:V`); the marker tag is always added and everything else is silenced (`*:S`). No tags = every tag. */
  tags?: string[];
  /** logcat buffers, each as `-b <name>` (`all` is accepted). Default: logcat's own default set. */
  buffers?: string[];
  /** `-t <count>` bound on the dump. Default DEFAULT_LOG_WINDOW_MAX_LINES. */
  maxLines?: number;
  timeoutMs?: number;
}

export interface LogWindowRead {
  markerSeen: boolean;
  /** The lines AFTER the marker line; empty when the marker was not seen. */
  lines: string[];
  /** The dump text exactly as returned. */
  raw: string;
}

/** The marker write failed: no window exists. `marker` is what was attempted, for the caller's report. */
export class LogWindowOpenError extends Error {
  constructor(readonly serial: string, readonly marker: string, detail: string) {
    super(`could not open a log window on ${serial} (marker ${marker}): ${detail}`);
    this.name = "LogWindowOpenError";
  }
}

export function newLogMarker(): string {
  return `pico-mcp-window-${randomUUID()}`;
}

/** Adopt a marker a caller already wrote (e.g. pico_loop's `log -t pico-mcp <marker>` through adb_shell). */
export function logWindowFromMarker(serial: string, marker: string): LogWindow {
  return { serial, marker, openedAt: new Date().toISOString() };
}

/**
 * Writes one marker line into the device's main log buffer (`adb -s S shell log -t pico-mcp <marker>`).
 * Never clears anything. Throws LogWindowOpenError when the write did not succeed.
 */
export async function openLogWindow(run: AdbRunner, serial: string): Promise<LogWindow> {
  const marker = newLogMarker();
  const result = await run(["-s", serial, "shell", "log", "-t", LOG_WINDOW_TAG, marker], 10_000);
  if (result.code !== 0) {
    throw new LogWindowOpenError(serial, marker, result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
  }
  return { serial, marker, openedAt: new Date().toISOString() };
}

/**
 * Bounded dump (`logcat -d -v threadtime -t <maxLines>`, plus `-b` per buffer and the tag filters,
 * which always include `pico-mcp:V`), sliced to the lines AFTER the marker. Throws when the dump
 * command itself failed, so a failed read is never mistaken for an evicted marker.
 */
export async function readLogWindow(run: AdbRunner, window: LogWindow, opts: ReadLogWindowOptions = {}): Promise<LogWindowRead> {
  const maxLines = opts.maxLines ?? DEFAULT_LOG_WINDOW_MAX_LINES;
  const args = ["-s", window.serial, "logcat"];
  for (const buffer of opts.buffers ?? []) args.push("-b", buffer);
  args.push("-d", "-v", "threadtime", "-t", String(maxLines));
  if (opts.tags && opts.tags.length) {
    for (const tag of opts.tags) args.push(`${tag}:V`);
    args.push(`${LOG_WINDOW_TAG}:V`, "*:S");
  }
  const result = await run(args, opts.timeoutMs ?? 15_000);
  if (result.code !== 0) {
    throw new Error(`bounded log dump failed on ${window.serial} (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { ...sliceAfterMarker(result.stdout, window.marker), raw: result.stdout };
}

/** The lines after the LAST line containing the marker; `markerSeen: false` (and no lines) when it is absent. */
export function sliceAfterMarker(stdout: string, marker: string): { markerSeen: boolean; lines: string[] } {
  const lines = stdout.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(marker)) { at = i; break; }
  }
  if (at < 0) return { markerSeen: false, lines: [] };
  return { markerSeen: true, lines: lines.slice(at + 1) };
}
