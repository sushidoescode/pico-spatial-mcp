import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, okJson, run, sleep } from "./util.js";

/**
 * generate_scene_understanding_kotlin — the CORRECT native surface-pin path (sense/plane).
 *
 * CORRECTED 2026-07-28 (ledger emulator-scene-understanding seq 0, evidence class logcat).
 * The earlier note here — "the emulator returns 0 planes (no sensors)" — was WRONG, and the whole
 * C1 ceiling and the generate_home_env_proxy workaround were built on it.
 *
 * The emulator DOES supply scene understanding. PICO's own emulator docs state the bedroom IS the
 * Video See-Through simulation and that "Spatial Mesh simulation provides spatial mesh data for the
 * virtual scene". A Spatial SDK app in FULL SPACE receives ~40 real planes with semantics
 * (FLOOR / TABLE / CHAIR / DOOR / WINDOW alongside BED / WALL / CEILING / CABINET), orientations
 * and metre bounding boxes.
 *
 * MEASURED 2026-07-29 (mrtable, seq 10-11): you MUST POLL. A one-shot query fired while Full Space
 * is still animating in returns 0 — warm boot took 4 one-second retries, COLD boot took 7. FLOOR is
 * at y=0.40, not 0. These readings are the likely cause of the historic 0-plane belief.
 *
 * THE PREREQUISITE IS FULL SPACE — the app must hold an OPEN Stage. Querying from a WindowContainer
 * or before the Stage opens returns 0 planes. REAL-room surfaces (vs the simulated bedroom) remain
 * hardware (Swan).
 *
 * STILL UNRESOLVED: MeshTrackingManager.loadAllAnchors() returned 0 in the same full-space probe
 * with no error, while planes returned 43. Do not claim mesh data works on the emulator.
 *
 * v31 adds `dumpPlanes` (polls + emits PLANES| markers) and the host-side `probe_planes` tool that
 * drives it through the Agent Bridge and parses the inventory back out of logcat.
 */

function resolveAdb(): string {
  const c = [
    process.env.PICO_ADB,
    path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb"),
    "/opt/homebrew/bin/adb",
    "adb",
  ].filter(Boolean) as string[];
  for (const x of c) if (x === "adb" || fs.existsSync(x)) return x;
  return "adb";
}

export interface ProbedPlane {
  idx: number;
  label: string;
  orientation: string;
  position: [number, number, number];
  extent: [number, number];
}

/** Parse the PLANES| markers from a logcat dump (exported for the deterministic test). */
export function parsePlaneMarkers(log: string): { count: number; retries: number; planes: ProbedPlane[] } | null {
  const lines = log.split("\n").filter((l) => l.includes("PLANES|")).map((l) => l.slice(l.indexOf("PLANES|")));
  // Only the most recent dump: start from the last count= header.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/PLANES\| count=/.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const head = lines[start].match(/count=(\d+) retries=(\d+)/);
  if (!head) return null;
  const planes: ProbedPlane[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/idx=(\d+) label=(\S+) orient=(\S+) pos=([-\d.]+),([-\d.]+),([-\d.]+) bbox=([-\d.]+),([-\d.]+)/);
    if (!m) continue;
    planes.push({
      idx: +m[1],
      label: m[2],
      orientation: m[3],
      position: [+m[4], +m[5], +m[6]],
      extent: [+m[7], +m[8]],
    });
  }
  return { count: +head[1], retries: +head[2], planes };
}

const DUMP_PLANES_WIRING =
  'AgentBridge.register("dump_planes") { _ -> CoroutineScope(Dispatchers.Main).launch { SceneUnderstanding.dumpPlanes() } }';

export function registerSenseTools(server: McpServer) {
  server.registerTool(
    "generate_scene_understanding_kotlin",
    {
      description:
        "Emit drop-in Kotlin (SceneUnderstanding.kt) that uses PICO native scene-understanding (sense/plane) to land markers on detected surfaces (floor/wall/ceiling) — the native equivalent of WebXR hit-test. RETRACTION (2026-07-28/29, measured): the emulator DOES supply scene understanding — a FULL SPACE app receives ~40 SIMULATED planes with semantics (FLOOR/TABLE/CHAIR/DOOR/WINDOW + BED/WALL/CEILING/CABINET), orientations and metre bounding boxes; you MUST POLL, because a one-shot query during Full Space entry returns 0 (warm boot ~4 one-second retries, COLD boot ~7; FLOOR is at y=0.40, not 0 — the historic '0 planes' belief came from one-shot queries). REAL-room surfaces remain hardware (Swan), and MeshTrackingManager still returned 0 anchors in the same probe — do not claim mesh data works. Includes dumpPlanes(maxRetries) which polls and emits PLANES| logcat markers; register it as an AgentBridge command and drive it with probe_planes. REQUIRES Full Space (an open Stage); a WindowContainer returns 0 planes.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package, e.g. com.example.app.content"),
      },
    },
    async ({ packageName }) => {
      const kotlin = [
        `package ${packageName}`,
        "",
        "import android.util.Log",
        "import com.pico.spatial.core.math.Vector3",
        "import com.pico.spatial.sense.plane.PlaneAnchor",
        "import com.pico.spatial.sense.plane.PlaneTrackingManager",
        "import kotlinx.coroutines.Dispatchers",
        "import kotlinx.coroutines.delay",
        "import kotlinx.coroutines.withContext",
        "",
        "/**",
        " * Generated by pico-spatial-mcp generate_scene_understanding_kotlin.",
        " * EMULATOR: SIMULATED planes DO appear in FULL SPACE, but you must POLL — a one-shot query",
        " * during Full Space entry returns 0 (measured 2026-07-29: warm ~4 retries, cold ~7; ~40 planes",
        " * with FLOOR/TABLE/CHAIR/DOOR/WINDOW semantics; FLOOR at y=0.40, not 0). REAL-room surfaces",
        " * need hardware (Swan). A WindowContainer returns 0 planes regardless.",
        " */",
        "object SceneUnderstanding {",
        '    private const val TAG = "SceneUnderstanding"',
        "",
        "    /** Start plane tracking. Call once after the scene loads (Full Space must be open). */",
        "    fun start() {",
        "        runCatching { PlaneTrackingManager.start(); Log.i(TAG, \"plane tracking ${PlaneTrackingManager.state}\") }",
        '            .onFailure { Log.e(TAG, "plane start failed: ${it.message}") }',
        "    }",
        "",
        "    /** All currently detected planes. One-shot — 0 during Full Space entry; poll (see dumpPlanes). */",
        "    suspend fun planes(): List<PlaneAnchor> =",
        "        runCatching { withContext(Dispatchers.IO) { PlaneTrackingManager.loadAllAnchors().toList() } }",
        '            .getOrElse { Log.e(TAG, "loadAllAnchors failed: ${it.message}"); emptyList() }',
        "",
        "    /** Log every detected plane (human-readable; dumpPlanes emits the machine-parsed markers). */",
        "    suspend fun logPlanes() {",
        "        val ps = planes()",
        '        Log.i(TAG, "planes detected: ${ps.size}")',
        "        ps.forEachIndexed { i, p ->",
        '            Log.i(TAG, "  plane[$i] semantics=${p.semantics} orient=${p.planeOrientation} bbox=${p.boundingBoxSize} verts=${p.vertices.size}")',
        "        }",
        "    }",
        "",
        "    /**",
        "     * POLL + dump the live plane inventory as PLANES| logcat markers (driven by probe_planes).",
        "     * Polls because a one-shot query during Full Space entry returns 0 — the retained lesson.",
        "     */",
        "    suspend fun dumpPlanes(maxRetries: Int = 15) {",
        "        start()",
        "        var ps = planes()",
        "        var tries = 0",
        "        while (ps.isEmpty() && tries < maxRetries) {",
        "            delay(1000)",
        "            tries++",
        "            ps = planes()",
        "        }",
        '        Log.i(TAG, "PLANES| count=${ps.size} retries=$tries")',
        "        ps.forEachIndexed { i, p ->",
        "            val c = p.transform.position",
        '            Log.i(TAG, "PLANES| idx=$i label=${p.semantics.name} orient=${p.planeOrientation.name} pos=${c.x},${c.y},${c.z} bbox=${p.boundingBoxSize.x},${p.boundingBoxSize.y}")',
        "        }",
        "    }",
        "",
        "    /** Raycast the gaze ray vs the detected planes; nearest hit point + plane normal, or null.",
        "     *  NOTE: javap-confirm PlaneAnchor.transform accessors before trusting on hardware. */",
        "    suspend fun nearestPlaneHit(origin: Vector3, dir: Vector3, maxDist: Float = 8f): Pair<Vector3, Vector3>? {",
        "        val ps = planes()",
        '        if (ps.isEmpty()) { Log.w(TAG, "nearestPlaneHit: 0 planes (still in Full Space entry? POLL first — see dumpPlanes)"); return null }',
        "        var best = maxDist; var pt: Vector3? = null; var nrm = Vector3.UP",
        "        for (p in ps) {",
        "            val c = p.transform.position",
        "            // NOTE: Transform.rotation is EulerAngles; the quaternion is Transform.quaternion (javap/sources-confirmed 0.13.3).",
        "            val n = p.transform.quaternion.rotateVector(Vector3.FORWARD).normalize()",
        "            val denom = Vector3.dot(dir, n)",
        "            if (kotlin.math.abs(denom) < 1e-5f) continue",
        "            val t = Vector3.dot(c.minus(origin), n) / denom",
        "            if (t in 0.01f..best) { best = t; pt = origin.plus(dir.times(t)); nrm = n }",
        "        }",
        "        return pt?.let { it to nrm }",
        "    }",
        "}",
        "",
      ].join("\n");
      return ok(kotlin);
    },
  );

  server.registerTool(
    "probe_planes",
    {
      description:
        "Dump the LIVE plane inventory (label / orientation / pose / extent / retry count) from a RUNNING app — institutionalizes the poll-for-planes lesson (2026-07-29: a one-shot query returns 0 during Full Space entry; a cold boot needed ~7 one-second retries; FLOOR at y=0.40). Drives the injected Agent Bridge: broadcasts AGENT_CMD cmd=dump_planes, then parses the PLANES| logcat markers that SceneUnderstanding.dumpPlanes() emits. REQUIRES the app to (1) hold an OPEN Stage (Full Space — a WindowContainer returns 0 planes), (2) have generate_agent_bridge injected, and (3) register the command: " + DUMP_PLANES_WIRING + " (SceneUnderstanding.kt from generate_scene_understanding_kotlin). Returns an honest error naming the missing prerequisite when no markers appear. STRUCTURAL evidence (logcat markers) — it proves what the runtime reports, not what a human sees.",
      inputSchema: {
        applicationId: z.string().describe("App id whose Agent Bridge to drive, e.g. com.example.spatialdemo (action = <id>.AGENT_CMD)."),
        serial: z.string().optional().describe("adb device serial (default emulator-5554)."),
        tag: z.string().optional().describe("Logcat tag SceneUnderstanding logs under (default SceneUnderstanding)."),
        waitSec: z.number().int().min(3).max(60).default(25).describe("How long to wait for the PLANES| dump (dumpPlanes itself polls up to 15s on an empty room)."),
      },
    },
    async ({ applicationId, serial, tag, waitSec }) => {
      const adb = resolveAdb();
      const dev = serial ?? "emulator-5554";
      const t = tag ?? "SceneUnderstanding";
      const action = `${applicationId}.AGENT_CMD`;
      await run(adb, ["-s", dev, "logcat", "-c"], { timeoutMs: 10_000 });
      const bc = await run(adb, ["-s", dev, "shell", "am", "broadcast", "-a", action, "--es", "cmd", "dump_planes"], { timeoutMs: 15_000 });
      if (/error|not found/i.test(bc.stderr)) return fail(`broadcast failed: ${bc.stderr.slice(0, 300)}`);
      const deadline = Date.now() + (waitSec ?? 25) * 1000;
      let parsed: ReturnType<typeof parsePlaneMarkers> = null;
      let sawBridge = false;
      while (Date.now() < deadline) {
        await sleep(1500);
        const lc = await run(adb, ["-s", dev, "logcat", "-d", "-s", `${t}:V`, "AgentBridge:V"], { timeoutMs: 15_000 });
        if (lc.stdout.includes("AGENTBRIDGE|")) sawBridge = true;
        parsed = parsePlaneMarkers(lc.stdout);
        // A dump can be caught mid-flush (count line in, per-plane lines still coming) — poll on.
        if (parsed && parsed.planes.length >= parsed.count) break;
      }
      if (!parsed) {
        return fail(
          `No PLANES| dump seen on ${dev} within ${waitSec ?? 25}s. Prerequisites, in the order they usually fail:\n` +
            `1. The app must hold an OPEN Stage (Full Space) — a WindowContainer returns 0 planes.\n` +
            `2. generate_agent_bridge must be injected (${sawBridge ? "bridge markers WERE seen — the bridge is alive" : "no AGENTBRIDGE| markers seen — is the app running with the bridge?"}).\n` +
            `3. The command must be registered: ${DUMP_PLANES_WIRING}\n` +
            `   (SceneUnderstanding.kt comes from generate_scene_understanding_kotlin; tag=${t}, action=${action}.)`,
        );
      }
      return okJson({
        device: dev,
        count: parsed.count,
        retries: parsed.retries,
        planes: parsed.planes,
        note:
          parsed.count === 0
            ? "0 planes AFTER polling — is the Stage open (Full Space)? On the emulator the simulated room reports ~40 planes once entry finishes."
            : `Live inventory (STRUCTURAL truth). retries=${parsed.retries} is the poll count the runtime needed — cold boots have measured ~7. FLOOR height here is the number to trust, never a constant.`,
      });
    },
  );
}
