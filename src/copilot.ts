import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { adb } from "./adb.js";
import { LogWindowOpenError, openLogWindow, readLogWindow, unseenMarkerCause, type AdbRunner, type LogWindow } from "./logwindow.js";

/**
 * copilot.ts — v25 THE LIVE AGENT COPILOT: talk to a RUNNING spatial app.
 *
 * The Agent Bridge (generate_agent_bridge, injected into every fleet app) exposes spawn/move/
 * remove/dump_scene over `am broadcast`; this module is the host half — each command carries a
 * unique tag, and the tool AWAITS the bridge's tagged ack in logcat before returning (a command
 * that never acks returns status:"no-ack", never a silent success). live_scene_snapshot parses
 * dump_scene into structured entities; live_scene_diff proves what a live edit ACTUALLY changed
 * (added/removed/moved), which is the copilot's verification story: command → ack → diff → (for
 * visual claims) capture + LOOK.
 *
 * Evidence class: bridge acks + scene diffs are STRUCTURAL (the app's own testimony). A visual
 * claim still requires a looked-at capture.
 */

let tagCounter = 0;
const nextTag = () => `t${Date.now().toString(36)}${(tagCounter++).toString(36)}`;

async function resolveSerial(serial?: string): Promise<string> {
  if (serial) return serial;
  const r = await adb(["devices"]);
  const line = r.stdout.split("\n").find((l) => l.trim().endsWith("device") && !l.startsWith("List"));
  if (!line) throw new Error("no adb device online");
  return line.split("\t")[0].trim();
}

/** Parse AGENTBRIDGE| lines: `AGENTBRIDGE| event=<name> k=v k=v ...` (values have spaces→_ folded). */
export function parseBridgeLine(line: string): { event: string; fields: Record<string, string> } | null {
  const m = line.match(/AGENTBRIDGE\|\s+event=(\S+)((?:\s+\S+=\S+)*)/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const kv of (m[2] ?? "").trim().split(/\s+/).filter(Boolean)) {
    const i = kv.indexOf("=");
    if (i > 0) fields[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { event: m[1], fields };
}

async function sendAndAwait(serial: string, packageName: string, extras: Record<string, string>, ackEvents: string[], timeoutMs = 8000) {
  const tag = nextTag();
  const args = ["-s", serial, "shell", "am", "broadcast", "-a", `${packageName}.AGENT_CMD`];
  for (const [k, v] of Object.entries({ ...extras, tag })) args.push("--es", k, v);
  await adb(args);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = await adb(["-s", serial, "logcat", "-d", "-s", "AgentBridge:V"], 15_000);
    for (const line of log.stdout.split("\n").reverse()) {
      const p = parseBridgeLine(line);
      if (p && p.fields.tag === tag && ackEvents.includes(p.event)) return { ack: p.event, fields: p.fields, tag };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ack: null, tag };
}

export interface SceneEntity { name: string; depth: number; pos: [number, number, number] | null; comps: string }

type SnapshotLogWindow = { marker: string; markerSeen: boolean };
type SnapshotResult =
  | { status: "ok"; entities: SceneEntity[]; rootName: string; serial: string; logWindow: SnapshotLogWindow }
  | { status: "no-dump" | "inconclusive"; error: string; serial: string; logWindow: SnapshotLogWindow | null };

/**
 * Dump + parse the LAST dump_begin..dump_end block the bridge emitted INSIDE a marker window opened
 * before the dump_scene broadcast. The device log is never cleared (src/logwindow.ts): only lines
 * after the marker are parsed, so a stale dump from an earlier snapshot cannot be returned as this
 * one; a marker that never shows up in the bounded dump makes the snapshot inconclusive.
 */
async function snapshot(serial: string, packageName: string, depth = 8): Promise<SnapshotResult> {
  const runner: AdbRunner = (args, timeoutMs) => adb(args, timeoutMs ?? 60_000);
  let window: LogWindow;
  try {
    window = await openLogWindow(runner, serial);
  } catch (e) {
    return {
      status: "inconclusive",
      error: `could not open a log window on ${serial}; nothing was driven or read: ${(e as Error).message}`,
      serial,
      logWindow: e instanceof LogWindowOpenError ? { marker: e.marker, markerSeen: false } : null,
    };
  }
  await adb(["-s", serial, "shell", "am", "broadcast", "-a", `${packageName}.AGENT_CMD`, "--es", "cmd", "dump_scene", "--ei", "depth", String(depth)]);
  const deadline = Date.now() + 8000;
  let markerSeen = false;
  let successfulDumps = 0;
  let lastReadError: string | null = null;
  while (Date.now() < deadline) {
    let read: Awaited<ReturnType<typeof readLogWindow>> | null = null;
    try {
      read = await readLogWindow(runner, window, { tags: ["AgentBridge"], timeoutMs: 15_000 });
      successfulDumps += 1;
    } catch (e) {
      // a failed dump is retried until the deadline — and remembered, so a dead adb is reported
      // below as the dump failure it is, never as log eviction (unseenMarkerCause)
      lastReadError = e instanceof Error ? e.message : String(e);
      read = null;
    }
    if (read) {
      markerSeen = read.markerSeen;
      if (read.markerSeen) {
        const lines = read.lines;
        const lastIndexWhere = (arr: string[], pred: (l: string) => boolean) => {
          for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
          return -1;
        };
        const endIdx = lastIndexWhere(lines, (l) => l.includes("event=dump_end"));
        if (endIdx >= 0) {
          const beginIdx = lastIndexWhere(lines.slice(0, endIdx), (l) => l.includes("event=dump_begin"));
          const rootName = parseBridgeLine(lines[beginIdx])?.fields.root ?? "?";
          const entities: SceneEntity[] = [];
          for (const l of lines.slice(beginIdx + 1, endIdx)) {
            const p = parseBridgeLine(l);
            if (!p || p.event !== "entity") continue;
            const pos = p.fields.pos ? (p.fields.pos.split(",").map(Number) as [number, number, number]) : null;
            entities.push({ name: p.fields.name ?? "?", depth: Number(p.fields.d ?? 0), pos: pos && pos.every((v) => Number.isFinite(v)) ? pos : null, comps: p.fields.comps ?? "" });
          }
          return { status: "ok", entities, rootName, serial, logWindow: { marker: window.marker, markerSeen: true } };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const logWindow = { marker: window.marker, markerSeen };
  if (!markerSeen) {
    return {
      status: "inconclusive",
      error: `the log window marker ${window.marker} was not seen within 8s on ${serial} (${unseenMarkerCause({ successfulDumps, lastReadError })}); the buffer was not cleared — re-run`,
      serial,
      logWindow,
    };
  }
  return {
    status: "no-dump",
    error: "no dump_begin..dump_end block appeared inside the log window — is the app running with the bridge attached (AgentBridge.attachScene)?",
    serial,
    logWindow,
  };
}

export function diffSnapshots(before: SceneEntity[], after: SceneEntity[], moveEpsilon = 0.005) {
  const byName = (es: SceneEntity[]) => new Map(es.map((e) => [e.name, e]));
  const b = byName(before);
  const a = byName(after);
  const added = [...a.values()].filter((e) => !b.has(e.name)).map((e) => ({ name: e.name, pos: e.pos }));
  const removed = [...b.values()].filter((e) => !a.has(e.name)).map((e) => ({ name: e.name, pos: e.pos }));
  const moved = [...a.values()]
    .filter((e) => {
      const prev = b.get(e.name);
      return prev?.pos && e.pos && Math.hypot(e.pos[0] - prev.pos[0], e.pos[1] - prev.pos[1], e.pos[2] - prev.pos[2]) > moveEpsilon;
    })
    .map((e) => ({ name: e.name, from: b.get(e.name)!.pos, to: e.pos, deltaM: Number(Math.hypot(e.pos![0] - b.get(e.name)!.pos![0], e.pos![1] - b.get(e.name)!.pos![1], e.pos![2] - b.get(e.name)!.pos![2]).toFixed(4)) }));
  return { added, removed, moved, beforeCount: before.length, afterCount: after.length };
}

const HONESTY = "bridge acks + scene diffs are the app's own structural testimony — a VISUAL claim still needs capture_canonical + a LOOK.";

export function registerCopilotTools(server: McpServer) {
  server.tool(
    "live_spawn",
    "v25 LIVE COPILOT: spawn a primitive INTO a RUNNING fleet app (Agent Bridge `spawn` over am broadcast) — no rebuild, no relaunch. Awaits the bridge's tagged ack (spawned / spawn_failed); a missing ack returns no-ack, never a silent success. Spawned entities are visual-only (no physics body). Verify with live_scene_diff and, for visual claims, capture + LOOK.",
    {
      serial: z.string().optional(),
      packageName: z.string().describe("The running app, e.g. com.fleet.affordance"),
      id: z.string().describe("Entity name (must be unique in the scene)"),
      shape: z.enum(["box", "sphere"]).default("box"),
      position: z.tuple([z.number(), z.number(), z.number()]),
      dims: z.tuple([z.number(), z.number(), z.number()]).optional().describe("box full extents; sphere uses dims[0] as radius (default 0.3s)"),
      color: z.tuple([z.number(), z.number(), z.number()]).optional().describe("[r,g,b] 0..1 (default cyan)"),
    },
    async ({ serial, packageName, id, shape, position, dims, color }) => {
      const s = await resolveSerial(serial);
      const extras: Record<string, string> = { cmd: "spawn", id, shape, pos: position.join(",") };
      if (dims) extras.dims = dims.join(",");
      if (color) extras.color = color.join(",");
      const r = await sendAndAwait(s, packageName, extras, ["spawned", "spawn_failed"]);
      return okJson({ status: r.ack === "spawned" ? "ok" : r.ack === null ? "no-ack" : "failed", ack: r.ack, detail: r.fields ?? null, honesty: HONESTY });
    },
  );

  server.tool(
    "live_move",
    "v25 LIVE COPILOT: move a named entity in a RUNNING fleet app (Agent Bridge `move`). Awaits the tagged ack (moved / move_failed / no-ack). Works on any entity with a TransformComponent — including compile-time content. Do NOT live-move physics bodies (adapter rule: no runtime teleports); verify with live_scene_diff.",
    {
      serial: z.string().optional(),
      packageName: z.string(),
      id: z.string().describe("Entity name as shown by dump_scene"),
      position: z.tuple([z.number(), z.number(), z.number()]),
    },
    async ({ serial, packageName, id, position }) => {
      const s = await resolveSerial(serial);
      const r = await sendAndAwait(s, packageName, { cmd: "move", id, pos: position.join(",") }, ["moved", "move_failed"]);
      return okJson({ status: r.ack === "moved" ? "ok" : r.ack === null ? "no-ack" : "failed", ack: r.ack, detail: r.fields ?? null, honesty: HONESTY });
    },
  );

  server.tool(
    "live_remove",
    "v25 LIVE COPILOT: destroy a named entity in a RUNNING fleet app (Agent Bridge `remove`). Awaits the tagged ack (removed / remove_failed / no-ack). Do NOT remove physics bodies at runtime (adapter rule: no destroy+respawn); verify with live_scene_diff.",
    { serial: z.string().optional(), packageName: z.string(), id: z.string() },
    async ({ serial, packageName, id }) => {
      const s = await resolveSerial(serial);
      const r = await sendAndAwait(s, packageName, { cmd: "remove", id }, ["removed", "remove_failed"]);
      return okJson({ status: r.ack === "removed" ? "ok" : r.ack === null ? "no-ack" : "failed", ack: r.ack, detail: r.fields ?? null, honesty: HONESTY });
    },
  );

  server.tool(
    "live_scene_snapshot",
    "v25 LIVE COPILOT: dump the RUNNING app's scene graph (Agent Bridge dump_scene) into structured entities [{name, depth, pos, comps}]. Take one before and one after a live edit and feed both to live_scene_diff — that diff is the structural proof of what actually changed.",
    { serial: z.string().optional(), packageName: z.string(), depth: z.number().int().min(1).max(12).default(8) },
    async ({ serial, packageName, depth }) => {
      const s = await resolveSerial(serial);
      const snap = await snapshot(s, packageName, depth);
      if (snap.status !== "ok") return okJson({ status: snap.status, error: snap.error, serial: snap.serial, logWindow: snap.logWindow });
      return okJson({ status: "ok", rootName: snap.rootName, entityCount: snap.entities.length, entities: snap.entities, serial: snap.serial, logWindow: snap.logWindow });
    },
  );

  server.tool(
    "live_scene_diff",
    "v25 LIVE COPILOT: diff two live_scene_snapshot entity lists (before vs after a live edit) — added / removed / moved (with per-entity delta meters). This is the copilot's verification: the RUNNING app's own testimony of what changed. Structural evidence; pair with capture + LOOK for visual claims.",
    {
      before: z.array(z.object({ name: z.string(), depth: z.number(), pos: z.tuple([z.number(), z.number(), z.number()]).nullable(), comps: z.string() })),
      after: z.array(z.object({ name: z.string(), depth: z.number(), pos: z.tuple([z.number(), z.number(), z.number()]).nullable(), comps: z.string() })),
      moveEpsilonM: z.number().default(0.005),
    },
    async ({ before, after, moveEpsilonM }) => okJson({ status: "ok", ...diffSnapshots(before as SceneEntity[], after as SceneEntity[], moveEpsilonM), honesty: HONESTY }),
  );
}
