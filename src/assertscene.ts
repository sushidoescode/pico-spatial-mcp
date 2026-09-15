import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, okJson, fail, sleep } from "./util.js";
import { adbExecutable } from "./adb.js";

/**
 * assert_scene — STRUCTURAL verification via the injected Agent Bridge. Broadcasts `dump_scene`,
 * reads the AGENTBRIDGE| markers from logcat, parses the live entity tree, and evaluates assertions
 * (entities present, min count, component types present, raw marker regex).
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
        markers: z.array(z.string()).optional().describe("Each substring must appear in the CURRENT dump's AGENTBRIDGE| stream (logcat is cleared first, so launch-time events like scene_attached won't be here — use dump_end / entity names / your own per-dump markers)."),
      },
    },
    async (args) => {
      const r = await runAssertScene(args);
      return "error" in r ? fail(r.error) : okJson(r);
    },
  );
}

/** Core of assert_scene — returns data ({pass,results,scene} or {error}). Shared with the verify orchestrator. */
export async function runAssertScene(args: any): Promise<any> {
      const adb = resolveAdb();
      const dev = args.serial ?? "emulator-5554";
      const tag = args.tag ?? "AgentBridge";
      const action = `${args.applicationId}.AGENT_CMD`;
      await run(adb, ["-s", dev, "logcat", "-c"], { timeoutMs: 10_000 });
      const bc = await run(adb, ["-s", dev, "shell", "am", "broadcast", "-a", action, "--es", "cmd", "dump_scene", "--ei", "depth", String(args.depth ?? 8)], { timeoutMs: 15_000 });
      if (/error|not found/i.test(bc.stderr)) return { error: `broadcast failed: ${bc.stderr.slice(0, 300)}` };
      await sleep(1500);
      const lc = await run(adb, ["-s", dev, "logcat", "-d", "-s", `${tag}:V`], { timeoutMs: 15_000 });
      const { entities, count, raw } = parseDump(lc.stdout);

      if (!raw.some((l) => l.includes("dump_") || l.includes("scene_attached"))) {
        return { error: `No Agent Bridge dump seen on ${dev}. Is generate_agent_bridge injected, AgentBridge.attachScene(root) called, and the app running? (action=${action}, tag=${tag})` };
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
        note: "STRUCTURAL truth (existence) only — confirm appearance with capture_frame / verify_visual.",
      };
}
