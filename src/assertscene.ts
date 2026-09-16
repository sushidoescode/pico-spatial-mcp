import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, okJson, fail, sleep } from "./util.js";
import { adbExecutable } from "./adb.js";
import { LogWindowOpenError, openLogWindow, readLogWindow, type AdbRunner, type LogWindow } from "./logwindow.js";

/**
 * assert_scene — STRUCTURAL verification via the injected Agent Bridge. Broadcasts `dump_scene`,
 * reads the AGENTBRIDGE| markers from logcat, parses the live entity tree, and evaluates assertions
 * (entities present, min count, component types present, raw marker regex).
 *
 * Scoping (host completion T4, 2026-09-16): a MARKER WINDOW is opened before the broadcast and the
 * dump is read back bounded and sliced to the lines after the marker (src/logwindow.ts). The device's
 * global log is never cleared — the old clear here was one of the ~20 irreversible clears recorded as
 * Incident 3 in docs/findings/CLI050_IMPLEMENTATION_CHECKPOINT.md. A marker that is not in the dump
 * makes the call inconclusive (an error naming the marker), never a match against the unscoped buffer.
 *
 * Requires the app to have `generate_agent_bridge` injected + AgentBridge.attachScene(root) called.
 * HONESTY: this proves a thing EXISTS in the scene graph — NOT that it renders or looks right. Pair
 * with capture_frame / verify_visual for the visual ground truth.
 */

/** THE shared adb lookup (src/adb.ts): explicit $PICO_ADB -> PATH -> the SELECTED toolchain's
 *  bundled platform-tools, identity-keyed so a replaced adb is observed without a restart. */
function resolveAdb(): string {
  return adbExecutable();
}

interface Entity { name: string; children: number; comps: string[]; }

function parseDump(log: string): { entities: Entity[]; count: number | null; raw: string[] } {
  const raw = log.split("\n").filter((l) => l.includes("AGENTBRIDGE|")).map((l) => l.slice(l.indexOf("AGENTBRIDGE|")));
  // take only the most recent dump (from the last dump_begin)
  let start = 0;
  for (let i = raw.length - 1; i >= 0; i--) if (raw[i].includes("event=dump_begin")) { start = i; break; }
  const slice = raw.slice(start);
  const entities: Entity[] = [];
  let count: number | null = null;
  for (const line of slice) {
    const ent = line.match(/event=entity\b/);
    if (ent) {
      const name = line.match(/\bname=(\S+)/)?.[1] ?? "?";
      const children = parseInt(line.match(/\bchildren=(\d+)/)?.[1] ?? "0", 10);
      const comps = (line.match(/\bcomps=(\S+)/)?.[1] ?? "").split(",").filter(Boolean);
      entities.push({ name, children, comps });
    }
    const de = line.match(/event=dump_end entities=(\d+)/);
    if (de) count = parseInt(de[1], 10);
  }
  return { entities, count, raw };
}

export function registerAssertSceneTools(server: McpServer) {
  server.registerTool(
    "assert_scene",
    {
      description:
        "STRUCTURAL scene verification via the injected Agent Bridge: broadcasts dump_scene, parses the live entity tree from logcat, and checks assertions (entitiesPresent / minEntities / componentsPresent / markers). Requires generate_agent_bridge injected + attachScene called. PROVES existence, NOT appearance — pair with capture_frame / verify_visual for the visual ground truth.",
      inputSchema: {
        applicationId: z.string().describe("App id whose Agent Bridge to drive, e.g. com.example.spatialdemo (action = <id>.AGENT_CMD)."),
        serial: z.string().optional().describe("adb device serial (default emulator-5554)."),
        tag: z.string().optional().describe("Agent Bridge logcat tag (default AgentBridge)."),
        depth: z.number().int().positive().optional().describe("dump_scene depth (default 8)."),
        entitiesPresent: z.array(z.string()).optional().describe("Each name (substring match) must appear in the dump."),
        minEntities: z.number().int().optional().describe("Total entity count must be >= this."),
        componentsPresent: z.array(z.string()).optional().describe("Each component class name must appear on some entity."),
        markers: z.array(z.string()).optional().describe("Each substring must appear in the CURRENT dump's AGENTBRIDGE| stream (a marker window is opened before the dump and only lines after it count, so launch-time events like scene_attached won't be here — use dump_end / entity names / your own per-dump markers). The device log is never cleared."),
      },
    },
    async (args) => {
      const r = await runAssertScene(args);
      return "error" in r ? fail(r.error) : okJson(r);
    },
  );
}

/** Core of assert_scene — returns data ({pass,results,scene,serial,logWindow} or {error,serial,logWindow}). Shared with the verify orchestrator. */
export async function runAssertScene(args: any): Promise<any> {
      const adb = resolveAdb();
      const dev = args.serial ?? "emulator-5554";
      const tag = args.tag ?? "AgentBridge";
      const action = `${args.applicationId}.AGENT_CMD`;
      const runner: AdbRunner = (a, timeoutMs) => run(adb, a, { timeoutMs });
      // The window opens BEFORE the broadcast that produces the dump, so a previous run's stream
      // (still in the buffer — nothing is cleared) can never satisfy this call's assertions.
      let window: LogWindow;
      try {
        window = await openLogWindow(runner, dev);
      } catch (e) {
        const marker = e instanceof LogWindowOpenError ? e.marker : null;
        return {
          error: `could not open a log window on ${dev}; nothing was driven or read: ${(e as Error).message}`,
          serial: dev,
          logWindow: marker ? { marker, markerSeen: false } : null,
        };
      }
      const bc = await run(adb, ["-s", dev, "shell", "am", "broadcast", "-a", action, "--es", "cmd", "dump_scene", "--ei", "depth", String(args.depth ?? 8)], { timeoutMs: 15_000 });
      if (/error|not found/i.test(bc.stderr)) return { error: `broadcast failed on ${dev}: ${bc.stderr.slice(0, 300)}`, serial: dev, logWindow: { marker: window.marker, markerSeen: false } };
      await sleep(1500);
      let read: Awaited<ReturnType<typeof readLogWindow>>;
      try {
        read = await readLogWindow(runner, window, { tags: [tag], timeoutMs: 15_000 });
      } catch (e) {
        return { error: `bounded log read failed on ${dev}: ${(e as Error).message}`, serial: dev, logWindow: { marker: window.marker, markerSeen: false } };
      }
      const logWindow = { marker: window.marker, markerSeen: read.markerSeen };
      if (!read.markerSeen) {
        return { error: `log window marker ${window.marker} was evicted before the dump was read on ${dev}; the buffer was not cleared, re-run`, serial: dev, logWindow };
      }
      const { entities, count, raw } = parseDump(read.lines.join("\n"));

      if (!raw.some((l) => l.includes("dump_") || l.includes("scene_attached"))) {
        return { error: `No Agent Bridge dump seen on ${dev} inside the log window. Is generate_agent_bridge injected, AgentBridge.attachScene(root) called, and the app running? (action=${action}, tag=${tag})`, serial: dev, logWindow };
      }

      const results: { check: string; pass: boolean; detail?: string }[] = [];
      const allNames = entities.map((e) => e.name);
      const allComps = new Set(entities.flatMap((e) => e.comps));
      for (const n of args.entitiesPresent ?? []) {
        const hit = allNames.some((x) => x.includes(n));
        results.push({ check: `entity present: ${n}`, pass: hit, detail: hit ? undefined : `not found among ${allNames.length} entities` });
      }
      if (args.minEntities !== undefined) {
        const total = count ?? entities.length;
        results.push({ check: `>= ${args.minEntities} entities`, pass: total >= args.minEntities, detail: `dumped ${total}` });
      }
      for (const c of args.componentsPresent ?? []) {
        results.push({ check: `component present: ${c}`, pass: allComps.has(c), detail: allComps.has(c) ? undefined : `present: ${[...allComps].join(",") || "(none)"}` });
      }
      for (const m of args.markers ?? []) {
        const hit = raw.some((l) => l.includes(m));
        results.push({ check: `marker: ${m}`, pass: hit });
      }
      if (results.length === 0) results.push({ check: "dump received", pass: true });

      const pass = results.every((r) => r.pass);
      return {
        pass,
        results,
        scene: { entityCount: count ?? entities.length, entities: entities.slice(0, 40), componentsSeen: [...allComps] },
        serial: dev,
        logWindow,
        note: "STRUCTURAL truth (existence) only — confirm appearance with capture_frame / verify_visual.",
      };
}
