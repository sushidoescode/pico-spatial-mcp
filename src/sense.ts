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
 * ~~STILL UNRESOLVED: MeshTrackingManager.loadAllAnchors() returned 0 ... Do not claim mesh data
 * works on the emulator.~~ **RESOLVED AND REFUTED 2026-08-06** (ledger com.picoagent.v35expa#1).
 * A probe running subscription and one-shot side by side against BOTH trackers, logging state every
 * second, measured: **44 distinct mesh anchors** via MeshTrackingManager.subscribeAnchorUpdate, and
 * loadAllAnchors() returning 44 as well. Mesh data works on the emulator.
 *
 * The old 0-mesh/43-plane result was a READINESS RACE, not a mesh-specific failure:
 *   TICK=0  meshState=RUNNING planeState=RUNNING  meshLoadAllAnchors=0   planeLoadAllAnchors=0
 *   TICK=1  meshState=RUNNING planeState=RUNNING  meshLoadAllAnchors=44  planeLoadAllAnchors=0
 *   TICK=2  meshState=RUNNING planeState=RUNNING  meshLoadAllAnchors=44  planeLoadAllAnchors=37
 * Mesh was actually READY BEFORE planes here. A one-shot at the wrong instant returns 0 for either.
 *
 * LOAD-BEARING CONSEQUENCE: `state == TrackingState.RUNNING` is **not** a readiness signal — both
 * trackers report RUNNING while still returning 0. So the conformance report's action §4.1-2 ("gate
 * the retry on state != RUNNING rather than on isEmpty; an empty room in RUNNING should exit
 * immediately") is **REFUTED — do not implement it.** It would exit at TICK=0 with 0 results. The
 * poll-until-non-empty gate below stays; the per-retry state log is what makes a 0 diagnosable.
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
        "Emit drop-in Kotlin (SceneUnderstanding.kt) that uses PICO native scene-understanding (sense/plane) to land markers on detected surfaces (floor/wall/ceiling) — the native equivalent of WebXR hit-test. RETRACTION (2026-07-28/29, measured): the emulator DOES supply scene understanding — a FULL SPACE app receives ~40 SIMULATED planes with semantics (FLOOR/TABLE/CHAIR/DOOR/WINDOW + BED/WALL/CEILING/CABINET), orientations and metre bounding boxes; you MUST POLL, because a one-shot query during Full Space entry returns 0 (warm boot ~4 one-second retries, COLD boot ~7; FLOOR is at y=0.40, not 0 — the historic '0 planes' belief came from one-shot queries). REAL-room surfaces remain hardware (Swan). MESH: RETRACTED 2026-08-06 (ledger com.picoagent.v35expa#1) — mesh data DOES work on the emulator: 44 distinct anchors, via both subscribeAnchorUpdate and loadAllAnchors. The old 0 was a readiness race, and note that state==RUNNING is NOT a readiness signal (both trackers report RUNNING while still returning 0 for ~1-2s), so POLL until non-empty rather than gating on state. Includes dumpPlanes(maxRetries) which polls and emits PLANES| logcat markers; register it as an AgentBridge command and drive it with probe_planes. REQUIRES Full Space (an open Stage); a WindowContainer returns 0 planes.",
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
        "import com.pico.spatial.core.lifecycle.Cancellable",
        "import com.pico.spatial.sense.base.AnchorUpdate",
        "import com.pico.spatial.sense.base.SemanticLabelType",
        "import com.pico.spatial.sense.mesh.MeshAnchor",
        "import com.pico.spatial.sense.mesh.MeshTrackingManager",
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
        "    /** Start plane tracking. Call once after the scene loads (Full Space must be open).",
        "     *  PAIR IT WITH stop() — see below. */",
        "    fun start() {",
        "        runCatching { PlaneTrackingManager.start(); Log.i(TAG, \"plane tracking ${PlaneTrackingManager.state}\") }",
        '            .onFailure { Log.e(TAG, "plane start failed: ${it.message}") }',
        "    }",
        "",
        "    /**",
        "     * v35.5 — the release half of start(). We emitted start() and never this, so every",
        "     * generated app that looked at planes left tracking running for the process lifetime;",
        "     * on hardware that is a battery and thermal cost for a capability the app is done with.",
        "     * PICO pair theirs the same way (MeshScanManager.kt:57,74). PlaneTrackingManager.stop()",
        "     * is confirmed at plane/PlaneTrackingManager.kt:210.",
        "     * Call from onDispose / ON_PAUSE / onCleared.",
        "     */",
        "    fun stop() {",
        "        runCatching { PlaneTrackingManager.stop(); Log.i(TAG, \"plane tracking stopped\") }",
        '            .onFailure { Log.e(TAG, "plane stop failed: ${it.message}") }',
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
        "            // v35.5: log the STATE each retry. loadAllAnchors() resumes immediately with an",
        "            // EMPTY array — silently, with no error — whenever state != RUNNING",
        "            // (PlaneTrackingManager.kt:125-131). Without this line \"0 planes\" is a mystery;",
        "            // with it, \"0 planes, state=INITIALIZED\" is a diagnosis. Our measured retry",
        "            // counts (warm ~4, cold ~7) are the observable shadow of this state walk.",
        "            Log.i(TAG, \"PLANES| retry=$tries state=${PlaneTrackingManager.state}\")",
        "            ps = planes()",
        "        }",
        '        Log.i(TAG, "PLANES| count=${ps.size} retries=$tries")',
        "        ps.forEachIndexed { i, p ->",
        "            val c = p.transform.position",
        '            Log.i(TAG, "PLANES| idx=$i label=${p.semantics.name} orient=${p.planeOrientation.name} pos=${c.x},${c.y},${c.z} bbox=${p.boundingBoxSize.x},${p.boundingBoxSize.y}")',
        "        }",
        "    }",
        "",
        "    // ── MESH (v35.10) ────────────────────────────────────────────────────────────────────",
        "    // Measured working on the emulator 2026-08-06: 44 distinct anchors (ledger",
        "    // com.picoagent.v35expa#1). SUBSCRIPTION is the primary path — it is what PICO's own",
        "    // SpatialMesh sample uses, and it is the only one that reports UPDATED/REMOVED, which",
        "    // matters on hardware where mesh refines over seconds. loadAllAnchors also works once",
        "    // ready, but it is a one-shot snapshot.",
        "    private var meshSub: Cancellable? = null",
        "    private val meshAnchors = mutableMapOf<String, MeshAnchor>()",
        "",
        "    /** Start mesh tracking and stream anchor updates. PAIR WITH stopMesh(). */",
        "    fun startMesh(onUpdate: ((AnchorUpdate.Event, MeshAnchor) -> Unit)? = null) {",
        "        runCatching {",
        "            // Subscribe BEFORE start(), the order the sample uses — otherwise the first",
        "            // ADDED burst can be missed.",
        "            meshSub = MeshTrackingManager.subscribeAnchorUpdate { update ->",
        "                val key = update.anchor.anchorUUID.toString()",
        "                when (update.event) {",
        "                    AnchorUpdate.Event.REMOVED -> meshAnchors.remove(key)",
        "                    else -> meshAnchors[key] = update.anchor",
        "                }",
        "                onUpdate?.invoke(update.event, update.anchor)",
        "            }",
        "            MeshTrackingManager.start()",
        "            Log.i(TAG, \"mesh tracking ${MeshTrackingManager.state}\")",
        "        }.onFailure { Log.e(TAG, \"mesh start failed: ${it.message}\") }",
        "    }",
        "",
        "    /** Release the subscription and the tracker. Call from onDispose / ON_PAUSE / onCleared. */",
        "    fun stopMesh() {",
        "        runCatching { meshSub?.cancel() }; meshSub = null",
        "        runCatching { MeshTrackingManager.stop() }",
        "        meshAnchors.clear()",
        "        Log.i(TAG, \"mesh tracking stopped\")",
        "    }",
        "",
        "    /**",
        "     * POLL + dump the mesh inventory as MESH| markers. Polls for the same reason planes do:",
        "     * TrackingState.RUNNING is NOT a readiness signal — both trackers report RUNNING while",
        "     * still returning 0 for the first 1-2s (measured). Never gate on state; poll until",
        "     * non-empty, and log state so a 0 is diagnosable.",
        "     */",
        "    suspend fun dumpMesh(maxRetries: Int = 15) {",
        "        startMesh()",
        "        var tries = 0",
        "        var n = runCatching { MeshTrackingManager.loadAllAnchors().size }.getOrDefault(0)",
        "        while (n == 0 && meshAnchors.isEmpty() && tries < maxRetries) {",
        "            delay(1000)",
        "            tries++",
        "            Log.i(TAG, \"MESH| retry=$tries state=${MeshTrackingManager.state}\")",
        "            n = runCatching { MeshTrackingManager.loadAllAnchors().size }.getOrDefault(0)",
        "        }",
        "        Log.i(TAG, \"MESH| oneShot=$n subscribed=${meshAnchors.size} retries=$tries state=${MeshTrackingManager.state}\")",
        "        val all = runCatching { MeshTrackingManager.loadAllAnchors().toList() }.getOrDefault(emptyList())",
        "        val histogram = LinkedHashMap<String, Int>()",
        "        all.forEachIndexed { i, a ->",
        "            // MeshAnchor.semantics is per-FACE, NOT per-anchor: a 500-triangle sofa returns",
        "            // SOFA 500 times. MEASURED 2026-08-07 (ledger com.picoagent.meshprobe#0) — joining",
        "            // the raw list overruns logcat's ~4KB line limit, the record TRUNCATES, and any",
        "            // downstream parse then silently drops that anchor. A 49-anchor room parsed as 23.",
        "            // Always distinct() before logging or matching.",
        "            val sem = runCatching { a.semantics }.getOrDefault(emptyList())",
        "            val label = sem.map { it.name }.distinct().sorted().joinToString(\"+\").ifBlank { \"<none>\" }",
        "            histogram[label] = (histogram[label] ?: 0) + 1",
        "            val bb = runCatching { a.boundingBoxSize }.getOrNull()",
        "            val p = runCatching { a.transform.position }.getOrNull()",
        "            Log.i(TAG, \"MESH| [$i] label=$label faces=${sem.size} verts=${runCatching { a.vertices.size }.getOrDefault(-1)}\" +",
        "                \" bbox=${bb?.x},${bb?.y},${bb?.z} pos=${p?.x},${p?.y},${p?.z}\")",
        "        }",
        "        Log.i(TAG, \"MESH| HISTOGRAM \" + histogram.entries.joinToString(\" | \") { \"${it.key}=${it.value}\" })",
        "    }",
        "",
        "    /** Anchors whose semantic set contains [label] — the way to find 'every wall-art surface'.",
        "     *  MATCH ON LABEL, NEVER ON INDEX OR COUNT: the inventory is per-SCENARIO and changes",
        "     *  between home environments (Museum Day 49 anchors / 4 WALL_ART vs Museum Night 38 / 2,",
        "     *  measured 2026-08-07), and the emulator's home environment also resets on cold boot. */",
        "    suspend fun anchorsLabeled(label: SemanticLabelType): List<MeshAnchor> =",
        "        runCatching { MeshTrackingManager.loadAllAnchors().filter { a -> a.semantics.any { it == label } } }",
        "            .getOrDefault(emptyList())",
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
