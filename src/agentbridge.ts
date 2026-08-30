import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, run, runBinary, sleep } from "./util.js";

export const AGENT_BRIDGE_SCENE_PAYLOAD_KIND = "pico.agent-bridge.scene-snapshot" as const;
export const AGENT_BRIDGE_SCENE_SCHEMA_VERSION = 1 as const;
export const AGENT_BRIDGE_SCENE_REVISION = 41 as const;
export const AGENT_BRIDGE_SCENE_COORDINATE_FRAME_ID = `bridge-world-${AGENT_BRIDGE_SCENE_REVISION}` as const;
export const AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND = "query_scene_anchors" as const;
export const AGENT_BRIDGE_SCENE_SNAPSHOT_CACHE_DIRECTORY = "agentbridge/scene-snapshots" as const;

const SCENE_SNAPSHOT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,96}$/;
const ANDROID_PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export interface AgentBridgeSceneSnapshotFetchInput {
  serial: string;
  packageName: string;
  requestId: string;
  maxRetries: number;
  pollMs: number;
  stabilityReads: number;
}

export interface AgentBridgeSceneSnapshotActionReceipt {
  action: "bridge_broadcast" | "bridge_payload_pull" | "bridge_payload_cleanup";
  status: "applied" | "failed";
  startedAtMonotonicNs: string;
  endedAtMonotonicNs: string;
  ack: Record<string, unknown>;
  error?: string;
}

export type AgentBridgeSceneSnapshotFetchResult =
  | { ok: true; bytes: Buffer; actionReceipts: AgentBridgeSceneSnapshotActionReceipt[] }
  | { ok: false; code: "bridge_unavailable"; detail: string; actionReceipts: AgentBridgeSceneSnapshotActionReceipt[] };

interface SceneSnapshotFetchDeps {
  runText?: typeof run;
  runBytes?: typeof runBinary;
  sleep?: typeof sleep;
  monotonicNs?: () => bigint;
  wallClockMs?: () => number;
}

/**
 * Fetch one nonce-addressed Agent Bridge scene payload without ever routing geometry through
 * logcat. `adb` is an already-resolved executable path. Every subprocess is pinned to the exact
 * caller-supplied serial, and the app-private cache path is read through `run-as` so a different
 * package or device cannot satisfy the request accidentally.
 */
export async function fetchAgentBridgeSceneSnapshot(
  adb: string,
  input: AgentBridgeSceneSnapshotFetchInput,
  deps: SceneSnapshotFetchDeps = {},
): Promise<AgentBridgeSceneSnapshotFetchResult> {
  const actionReceipts: AgentBridgeSceneSnapshotActionReceipt[] = [];
  const now = deps.monotonicNs ?? (() => process.hrtime.bigint());
  const execText = deps.runText ?? run;
  const execBytes = deps.runBytes ?? runBinary;
  const wait = deps.sleep ?? sleep;
  const wallClockMs = deps.wallClockMs ?? Date.now;
  const stamp = () => now().toString();
  const invalid = (detail: string): AgentBridgeSceneSnapshotFetchResult => ({
    ok: false,
    code: "bridge_unavailable",
    detail,
    actionReceipts,
  });

  if (!adb) return invalid("adb executable path is empty");
  if (!/^[\x21-\x7e]+$/.test(input.serial)) return invalid("an exact printable adb serial is required");
  if (!ANDROID_PACKAGE_PATTERN.test(input.packageName)) return invalid("packageName is not a valid Android package name");
  if (!SCENE_SNAPSHOT_REQUEST_ID_PATTERN.test(input.requestId)) return invalid("requestId is not safe for the bridge cache path");
  if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 120) return invalid("maxRetries must be an integer from 0 through 120");
  if (!Number.isInteger(input.pollMs) || input.pollMs < 10 || input.pollMs > 60_000) return invalid("pollMs must be an integer from 10 through 60000");
  if (!Number.isInteger(input.stabilityReads) || input.stabilityReads < 2 || input.stabilityReads > 8) return invalid("stabilityReads must be an integer from 2 through 8");

  const broadcastStart = stamp();
  const broadcast = await execText(
    adb,
    [
      "-s", input.serial,
      "shell", "am", "broadcast",
      "-a", `${input.packageName}.AGENT_CMD`,
      "--es", "cmd", AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND,
      "--es", "requestId", input.requestId,
      "--ei", "maxRetries", String(input.maxRetries),
      "--ei", "pollMs", String(input.pollMs),
      "--ei", "stabilityReads", String(input.stabilityReads),
    ],
    { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
  );
  actionReceipts.push({
    action: "bridge_broadcast",
    status: broadcast.code === 0 && !broadcast.timedOut ? "applied" : "failed",
    startedAtMonotonicNs: broadcastStart,
    endedAtMonotonicNs: stamp(),
    ack: {
      serial: input.serial,
      action: `${input.packageName}.AGENT_CMD`,
      command: AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND,
      requestId: input.requestId,
      outcome: broadcast.code === 0 && !broadcast.timedOut ? "completed" : broadcast.timedOut ? "timeout" : "failed",
    },
    error: broadcast.code === 0 && !broadcast.timedOut
      ? undefined
      : (broadcast.timedOut ? "broadcast timed out" : (broadcast.stderr || broadcast.stdout || "broadcast failed")).slice(-400),
  });
  if (broadcast.code !== 0 || broadcast.timedOut) {
    return invalid(`Agent Bridge broadcast failed on ${input.serial}: ${(broadcast.stderr || broadcast.stdout || "no diagnostic output").slice(-400)}`);
  }

  const relativePath = `cache/${AGENT_BRIDGE_SCENE_SNAPSHOT_CACHE_DIRECTORY}/${input.requestId}.json`;
  const readStart = stamp();
  const deadline = wallClockMs() + 30_000 + (input.maxRetries + 1) * input.pollMs;
  const readPollMs = Math.min(500, Math.max(50, Math.floor(input.pollMs / 4)));
  let attempts = 0;
  let lastDetail = "payload file has not appeared";
  while (wallClockMs() <= deadline) {
    attempts += 1;
    const pulled = await execBytes(
      adb,
      [
        "-s", input.serial, "exec-out", "run-as", input.packageName,
        "sh", "-c", 'if test -f "$1"; then printf "\\001"; cat "$1"; else printf "\\000"; fi', "pico-mcp", relativePath,
      ],
      { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 * 1024 },
    );
    // Android's adb exec-out can report exit 0 while forwarding a remote `cat: ... No such file`
    // diagnostic on stdout. The remote shell prefixes its result with an out-of-band existence
    // byte: 0 means absent, 1 means present. Strip that byte and hand EVERY present file byte to
    // the versioned host parser. Transport must not decide whether the payload is valid JSON.
    const existenceByte = pulled.stdout[0];
    const filePresent = existenceByte === 0x01;
    const fileAbsent = existenceByte === 0x00 && pulled.stdout.length === 1;
    if (pulled.code === 0 && !pulled.timedOut && filePresent) {
      const payload = pulled.stdout.subarray(1);
      actionReceipts.push({
        action: "bridge_payload_pull",
        status: "applied",
        startedAtMonotonicNs: readStart,
        endedAtMonotonicNs: stamp(),
        ack: { serial: input.serial, packageName: input.packageName, requestId: input.requestId, relativePath, attempts, bytes: payload.length, outcome: "completed" },
      });
      const cleanupStart = stamp();
      const cleanup = await execText(
        adb,
        ["-s", input.serial, "shell", "run-as", input.packageName, "rm", "-f", relativePath],
        { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
      );
      actionReceipts.push({
        action: "bridge_payload_cleanup",
        status: cleanup.code === 0 && !cleanup.timedOut ? "applied" : "failed",
        startedAtMonotonicNs: cleanupStart,
        endedAtMonotonicNs: stamp(),
        ack: {
          serial: input.serial,
          packageName: input.packageName,
          requestId: input.requestId,
          relativePath,
          outcome: cleanup.code === 0 && !cleanup.timedOut ? "completed" : cleanup.timedOut ? "timeout" : "failed",
        },
        error: cleanup.code === 0 && !cleanup.timedOut
          ? undefined
          : (cleanup.timedOut ? "payload cleanup timed out" : (cleanup.stderr || cleanup.stdout || "payload cleanup failed")).slice(-400),
      });
      return { ok: true, bytes: payload, actionReceipts };
    }
    lastDetail = pulled.timedOut
      ? "run-as payload read timed out"
      : pulled.code === 0 && fileAbsent
        ? "payload file has not appeared"
        : pulled.stdout.length > 0
          ? `run-as payload existence protocol was invalid: ${pulled.stdout.toString("utf8").slice(-300)}`
        : (pulled.stderr || `run-as payload read exited ${pulled.code ?? "without a code"}`).slice(-400);
    if (wallClockMs() + readPollMs > deadline) break;
    await wait(readPollMs);
  }
  actionReceipts.push({
    action: "bridge_payload_pull",
    status: "failed",
    startedAtMonotonicNs: readStart,
    endedAtMonotonicNs: stamp(),
    ack: { serial: input.serial, packageName: input.packageName, requestId: input.requestId, relativePath, attempts, outcome: "timeout" },
    error: lastDetail,
  });
  return invalid(`No terminal Agent Bridge payload appeared at ${relativePath} on ${input.serial}: ${lastDetail}`);
}

/**
 * generate_agent_bridge — emit an INJECTABLE Kotlin library ("Agent Bridge") that turns any native
 * PICO spatial app into a cooperative headless control + verification surface for an AI agent.
 *
 * The thesis: `adb am broadcast` (drive) + `adb logcat` (read) give deterministic STRUCTURAL
 * verification — the app TELLS the agent its exact scene state on command (assert_scene / dump_scene).
 * This COMPLEMENTS visual verification. capture_frame is a measured headless path, but its returned
 * pixels must be LOOKed at and a black/absent immersive view can require an alternate host-window
 * capture. The mouse bridge delivers input, not proof of a visual response. Use the bridge for
 * structural state and a looked-at frame for appearance.
 *
 * Boots with ZERO app code via a manifest-merged ContentProvider (the LeakCanary/Firebase trick):
 * the provider's onCreate runs at process start and registers the AGENT_CMD BroadcastReceiver.
 * The only optional one-line glue is AgentBridge.attachScene(sceneRoot) so dump_scene can introspect.
 *
 * APIs used are sources-confirmed (foundation/core 0.13.3): Entity.getChildren()/getChildrenCount()/
 * getName(), Entity.components (a Collection<Component> with operator get(Class)), TransformComponent
 * .position/.quaternion/.scaleVector. The broadcast+logcat pattern is emulator-proven (ClaimSight).
 */

function agentBridgeKt(pkg: string, tag: string): string {
  return `package ${pkg}

import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import android.system.Os
import android.util.JsonWriter
import android.util.Log
import com.pico.spatial.core.ecs.Entity
import com.pico.spatial.core.ecs.ModelComponent
import com.pico.spatial.core.ecs.TransformComponent
import com.pico.spatial.core.ecs.resource.MeshResource
import com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial
import com.pico.spatial.core.math.Color4
import com.pico.spatial.core.math.Quat
import com.pico.spatial.core.math.Vector3
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * AgentBridge — an injectable headless control + verification surface for an AI agent.
 * Generated by pico-spatial-mcp generate_agent_bridge.
 *
 * Drive it headlessly:   adb shell am broadcast -a <applicationId>.AGENT_CMD --es cmd dump_scene
 * Read it headlessly:    adb logcat -s ${tag}:V
 *
 * Built-in commands: ping | commands | scene_stats | dump_scene (extra --ei depth N)
 *   + query_scene_anchors (versioned, lossless, nonce-addressed app-cache JSON; never logcat)
 *   + LIVE EDITS (v25): spawn | move | remove — each echoes your --es tag in its ack event.
 * Extend with your own: AgentBridge.register("arm") { _ -> placer.toggleArmed() }.
 * ONE-LINE GLUE (optional, for scene introspection): AgentBridge.attachScene(sceneRoot).
 * query_scene_anchors requires explicit identity: AgentBridge.attachScene(stageRoot, "stage").
 */
object AgentBridge {
    const val TAG = "${tag}"
    const val ACTION_SUFFIX = ".AGENT_CMD"
    const val SCENE_PAYLOAD_KIND = "${AGENT_BRIDGE_SCENE_PAYLOAD_KIND}"
    const val SCENE_SCHEMA_VERSION = ${AGENT_BRIDGE_SCENE_SCHEMA_VERSION}
    const val SCENE_BRIDGE_REVISION = ${AGENT_BRIDGE_SCENE_REVISION}
    const val SCENE_SNAPSHOT_COMMAND = "${AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND}"
    const val SCENE_SNAPSHOT_CACHE_DIRECTORY = "${AGENT_BRIDGE_SCENE_SNAPSHOT_CACHE_DIRECTORY}"

    data class SceneSnapshotRequest(
        val requestId: String,
        val maxRetries: Int,
        val pollMs: Long,
        val stabilityReads: Int,
    )

    private val bridgeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val requestIdPattern = Regex("^[A-Za-z0-9_-]{8,96}$")

    @Volatile private var applicationContext: Context? = null
    @Volatile private var sceneRoot: Entity? = null
    @Volatile private var sceneProvider: (() -> Entity?)? = null
    @Volatile private var rootContainer: String? = null
    @Volatile private var sceneSnapshotProducer: (suspend (SceneSnapshotRequest, JsonWriter) -> Unit)? = null
    @Volatile private var cachedApkSha256: String? = null
    private val handlers = LinkedHashMap<String, (Bundle) -> Unit>()

    init { registerBuiltins() }

    /** Called by AgentBridgeInitProvider before the receiver becomes reachable. */
    fun initialize(context: Context) { applicationContext = context.applicationContext }

    /** Attach the live scene root so dump_scene/scene_stats can introspect it. */
    fun attachScene(root: Entity) { attachSceneInternal(root, null) }

    /** Explicit container identity is required by query_scene_anchors runtime binding. */
    fun attachScene(root: Entity, container: String) { attachSceneInternal(root, container) }

    private fun attachSceneInternal(root: Entity, container: String?) {
        sceneRoot = root
        sceneProvider = null
        rootContainer = container
        event("scene_attached", "name" to root.getName(), "container" to (container ?: "unreported"))
    }

    /** Pair direct attachScene(...) with this from Stage disposal/closure. */
    fun detachScene(root: Entity? = null) {
        if (root != null && sceneRoot !== root) {
            event("scene_detach_ignored", "msg" to "root_mismatch")
            return
        }
        sceneRoot = null
        // Retain the reported container identity: a closed known Stage is stage_not_open, while a
        // never-identified root remains binding_failed.
        event("scene_detached", "container" to (rootContainer ?: "unreported"))
    }

    /** Attach a provider instead, if the root is rebuilt over time. */
    fun attachSceneProvider(provider: () -> Entity?) { attachSceneProviderInternal(null, provider) }

    /** Explicit container identity is required by query_scene_anchors runtime binding. */
    fun attachSceneProvider(container: String, provider: () -> Entity?) { attachSceneProviderInternal(container, provider) }

    private fun attachSceneProviderInternal(container: String?, provider: () -> Entity?) {
        sceneRoot = null
        sceneProvider = provider
        rootContainer = container
        event("scene_provider_attached", "container" to (container ?: "unreported"))
    }

    /** Pair attachSceneProvider(...) with this when the provider lifecycle ends. */
    fun detachSceneProvider() {
        sceneProvider = null
        event("scene_provider_detached", "container" to (rootContainer ?: "unreported"))
    }

    /**
     * Register the sole producer for query_scene_anchors. The producer writes only the readiness,
     * reads, and optional error members into an already-open versioned envelope. Geometry remains
     * in the app-private file and is never emitted through event()/logcat.
     */
    fun registerSceneSnapshotProducer(producer: suspend (SceneSnapshotRequest, JsonWriter) -> Unit) {
        sceneSnapshotProducer = producer
        event("scene_snapshot_producer_registered", "revision" to SCENE_BRIDGE_REVISION)
    }

    private fun root(): Entity? = sceneRoot ?: sceneProvider?.invoke()

    /** Register or override a command. The handler receives the broadcast extras. */
    fun register(cmd: String, handler: (Bundle) -> Unit) { handlers[cmd] = handler }

    /** Route a command (called by AgentBridgeInitProvider's receiver). */
    fun dispatch(cmd: String?, extras: Bundle) {
        if (cmd == null) { event("error", "msg" to "null cmd"); return }
        val h = handlers[cmd]
        if (h == null) { event("unknown_cmd", "cmd" to cmd, "known" to handlers.keys.joinToString(",")); return }
        runCatching { h(extras) }.onFailure { event("cmd_failed", "cmd" to cmd, "msg" to (it.message ?: it.toString())) }
    }

    /** Emit a structured, greppable telemetry marker: AGENTBRIDGE| event=<name> k=v ... */
    fun event(name: String, vararg pairs: Pair<String, Any?>) {
        val sb = StringBuilder("AGENTBRIDGE| event=").append(name)
        for ((k, v) in pairs) sb.append(' ').append(k).append('=').append(fmt(v))
        Log.i(TAG, sb.toString())
    }

    private fun fmt(v: Any?): String = if (v == null) "null" else v.toString().replace('\\n', ' ').replace(' ', '_')

    private fun registerBuiltins() {
        register("ping") { event("pong") }
        register("commands") { event("commands", "list" to handlers.keys.joinToString(",")) }
        register("scene_stats") {
            val r = root()
            if (r == null) { event("scene_stats", "attached" to false); return@register }
            var n = 0
            walk(r, 0, Int.MAX_VALUE) { _, _ -> n++ }
            event("scene_stats", "attached" to true, "rootName" to r.getName(), "entities" to n)
        }
        register("dump_scene") { extras ->
            val r = root()
            if (r == null) { event("dump_scene", "attached" to false); return@register }
            val maxDepth = extras.getInt("depth", 6)
            event("dump_begin", "root" to r.getName(), "maxDepth" to maxDepth)
            var n = 0
            walk(r, 0, maxDepth) { e, depth ->
                n++
                val comps = runCatching { e.components.joinToString(",") { it.javaClass.simpleName } }.getOrDefault("?")
                val t = runCatching { e.components[TransformComponent::class.java] }.getOrNull()
                if (t != null) {
                    val p = t.position; val s = t.scaleVector
                    event("entity", "d" to depth, "name" to e.getName(), "children" to e.getChildrenCount(),
                        "pos" to "\${p.x},\${p.y},\${p.z}", "scale" to "\${s.x},\${s.y},\${s.z}", "comps" to comps)
                } else {
                    event("entity", "d" to depth, "name" to e.getName(), "children" to e.getChildrenCount(), "comps" to comps)
                }
            }
            event("dump_end", "entities" to n)
        }
        register(SCENE_SNAPSHOT_COMMAND) { extras ->
            val requestId = extras.getString("requestId")
            if (requestId == null || !requestIdPattern.matches(requestId)) {
                event("scene_snapshot_rejected", "msg" to "invalid_request_id")
                return@register
            }
            val request = SceneSnapshotRequest(
                requestId = requestId,
                maxRetries = extras.getInt("maxRetries", 15),
                pollMs = extras.getInt("pollMs", 1000).toLong(),
                stabilityReads = extras.getInt("stabilityReads", 2),
            )
            val validationError = when {
                request.maxRetries !in 0..120 -> "maxRetries must be in 0..120"
                request.pollMs !in 10L..60_000L -> "pollMs must be in 10..60000"
                request.stabilityReads !in 2..8 -> "stabilityReads must be in 2..8"
                else -> null
            }
            val ctx = applicationContext
            if (ctx == null) {
                event("scene_snapshot_failed", "requestId" to requestId, "msg" to "bridge_not_initialized")
                return@register
            }
            val target = sceneSnapshotTarget(ctx, requestId)
            if (target.exists() && !target.delete()) {
                event("scene_snapshot_failed", "requestId" to requestId, "msg" to "stale_payload_not_removed")
                return@register
            }
            bridgeScope.launch {
                if (validationError == null) writeSceneSnapshot(request)
                else writeTerminalSnapshot(request, "invalid_payload", validationError)
            }
            event(
                "scene_snapshot_requested",
                "requestId" to requestId,
                "revision" to SCENE_BRIDGE_REVISION,
                "maxRetries" to request.maxRetries,
                "stabilityReads" to request.stabilityReads,
            )
        }
        // v25 LIVE EDITS: an agent talks to the RUNNING scene. Each ack echoes the caller's tag so
        // the host can await its own command. Spawned entities are visual-only (no RigidBody) —
        // live physics mutation stays out per the physics adapter rules.
        register("spawn") { ex ->
            val tg = ex.getString("tag") ?: ""
            val r = root()
            if (r == null) { event("spawn_failed", "tag" to tg, "msg" to "no_scene_root"); return@register }
            val id = ex.getString("id")
            if (id == null) { event("spawn_failed", "tag" to tg, "msg" to "missing_id"); return@register }
            if (find(r, id) != null) { event("spawn_failed", "tag" to tg, "id" to id, "msg" to "name_exists"); return@register }
            val pos = vec3(ex.getString("pos"), Vector3(0f, 1f, -2f))
            val dims = vec3(ex.getString("dims"), Vector3(0.3f, 0.3f, 0.3f))
            val c = vec3(ex.getString("color"), Vector3(0.2f, 0.9f, 0.9f))
            val mesh = if (ex.getString("shape") == "sphere") MeshResource.createSphere(dims.x) else MeshResource.createBox(dims)
            val e = Entity()
            e.setName(id)
            e.components.set(TransformComponent(pos, Quat.identity(), Vector3(1f, 1f, 1f)))
            val mat = PhysicallyBasedMaterial.create().apply { setBaseColor(Color4(c.x, c.y, c.z, 1f)); setMetallic(0.1f); setRoughness(0.4f) }
            e.components.set(ModelComponent(mesh, mat))
            r.addChild(e)
            event("spawned", "tag" to tg, "id" to id, "pos" to "\${pos.x},\${pos.y},\${pos.z}")
        }
        register("move") { ex ->
            val tg = ex.getString("tag") ?: ""
            val r = root(); val id = ex.getString("id")
            val e = if (r != null && id != null) find(r, id) else null
            if (e == null) { event("move_failed", "tag" to tg, "id" to (id ?: "null"), "msg" to "not_found"); return@register }
            val t = e.components[TransformComponent::class.java]
            if (t == null) { event("move_failed", "tag" to tg, "id" to id, "msg" to "no_transform"); return@register }
            val pos = vec3(ex.getString("pos"), t.position)
            e.components.set(TransformComponent(pos, t.quaternion, t.scaleVector))
            event("moved", "tag" to tg, "id" to id, "pos" to "\${pos.x},\${pos.y},\${pos.z}")
        }
        register("remove") { ex ->
            val tg = ex.getString("tag") ?: ""
            val r = root(); val id = ex.getString("id")
            val e = if (r != null && id != null) find(r, id) else null
            if (e == null) { event("remove_failed", "tag" to tg, "id" to (id ?: "null"), "msg" to "not_found"); return@register }
            runCatching { e.destroy() }
                .onSuccess { event("removed", "tag" to tg, "id" to id) }
                .onFailure { event("remove_failed", "tag" to tg, "id" to id, "msg" to (it.message ?: "destroy_failed")) }
        }
    }

    private suspend fun writeSceneSnapshot(request: SceneSnapshotRequest) {
        val producer = sceneSnapshotProducer
        val stageOpen = rootContainer == "stage" && runCatching { root() != null }.getOrDefault(false)
        when {
            rootContainer == null -> writeTerminalSnapshot(request, "binding_failed", "root container identity was not reported")
            !stageOpen -> writeTerminalSnapshot(request, "stage_not_open", "an attached stage root is required")
            producer == null -> writeTerminalSnapshot(request, "bridge_unavailable", "no scene snapshot producer is registered")
            else -> {
                val ctx = applicationContext ?: return
                val target = sceneSnapshotTarget(ctx, request.requestId)
                try {
                    writeSnapshotAtomically(ctx, request, target) { writer -> producer(request, writer) }
                    event(
                        "scene_snapshot_written",
                        "requestId" to request.requestId,
                        "revision" to SCENE_BRIDGE_REVISION,
                        "bytes" to target.length(),
                    )
                } catch (cause: Throwable) {
                    val detail = (cause.message ?: cause.javaClass.simpleName).take(500)
                    runCatching { writeTerminalSnapshot(request, "invalid_payload", detail) }
                    event("scene_snapshot_failed", "requestId" to request.requestId, "msg" to detail)
                }
            }
        }
    }

    private suspend fun writeTerminalSnapshot(request: SceneSnapshotRequest, code: String, detail: String) {
        val ctx = applicationContext ?: return
        val target = sceneSnapshotTarget(ctx, request.requestId)
        writeSnapshotAtomically(ctx, request, target) { writer ->
            writer.name("readiness").beginObject()
            writer.name("maxRetries").value(request.maxRetries.toLong())
            writer.name("pollMs").value(request.pollMs)
            writer.name("stabilityReads").value(request.stabilityReads.toLong())
            writer.name("retries").value(0L)
            writer.name("satisfied").value(false)
            writer.endObject()
            writer.name("reads").beginArray().endArray()
            writer.name("error").beginObject()
            writer.name("code").value(code)
            writer.name("detail").value(detail.take(500))
            writer.endObject()
        }
        event("scene_snapshot_written", "requestId" to request.requestId, "terminal" to code, "bytes" to target.length())
    }

    private suspend fun writeSnapshotAtomically(
        context: Context,
        request: SceneSnapshotRequest,
        target: File,
        writeBody: suspend (JsonWriter) -> Unit,
    ) {
        val directory = target.parentFile ?: throw IllegalStateException("scene snapshot cache has no parent")
        if (!directory.exists() && !directory.mkdirs()) throw IllegalStateException("could not create scene snapshot cache")
        val temp = File(directory, ".\${request.requestId}.tmp-\${SystemClock.elapsedRealtimeNanos()}")
        val output = FileOutputStream(temp)
        try {
            val writer = JsonWriter(OutputStreamWriter(output, Charsets.UTF_8))
            writer.beginObject()
            writeEnvelopeHeader(writer, context, request)
            writeBody(writer)
            writer.endObject()
            writer.flush()
            output.fd.sync()
        } catch (cause: Throwable) {
            temp.delete()
            throw cause
        } finally {
            runCatching { output.close() }
        }
        try {
            // POSIX rename on the same app-cache filesystem publishes either all exact bytes or none.
            Os.rename(temp.absolutePath, target.absolutePath)
        } catch (cause: Throwable) {
            temp.delete()
            throw cause
        }
    }

    private fun writeEnvelopeHeader(writer: JsonWriter, context: Context, request: SceneSnapshotRequest) {
        writer.name("kind").value(SCENE_PAYLOAD_KIND)
        writer.name("schemaVersion").value(SCENE_SCHEMA_VERSION.toLong())
        writer.name("bridgeRevision").value(SCENE_BRIDGE_REVISION.toLong())
        writer.name("requestId").value(request.requestId)
        writer.name("application").beginObject()
        writer.name("packageName").value(context.packageName)
        val buildSha256 = runCatching { apkSha256(context) }.getOrNull()
        if (buildSha256 == null) {
            writer.name("buildIdentity").nullValue()
        } else {
            writer.name("buildIdentity").beginObject()
            writer.name("kind").value("apk-sha256")
            writer.name("sha256").value(buildSha256)
            writer.endObject()
        }
        val stageStyle = observedStageStyle(context)
        if (stageStyle == null) writer.name("observedStageStyle").nullValue()
        else writer.name("observedStageStyle").value(stageStyle)
        if (rootContainer == null) writer.name("rootContainer").nullValue()
        else writer.name("rootContainer").value(rootContainer)
        writer.name("stageOpen").value(rootContainer == "stage" && runCatching { root() != null }.getOrDefault(false))
        writer.endObject()
        writer.name("coordinateFrame").beginObject()
        writer.name("id").value("${AGENT_BRIDGE_SCENE_COORDINATE_FRAME_ID}")
        writer.name("units").value("metres")
        writer.name("handedness").value("sdk-reported")
        writer.endObject()
    }

    @Suppress("DEPRECATION")
    private fun observedStageStyle(context: Context): String? {
        val packageManager = context.packageManager
        val launcher = runCatching { packageManager.getLaunchIntentForPackage(context.packageName)?.component }.getOrNull()
        val activityRaw = launcher?.let { component ->
            runCatching { packageManager.getActivityInfo(component, PackageManager.GET_META_DATA).metaData?.get("pico.spatial.stage.style") }.getOrNull()
        }
        val applicationRaw = runCatching {
            packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
                .metaData?.get("pico.spatial.stage.style")
        }.getOrNull()
        // The repo scaffold follows PICO's manifest shape and declares this on the launcher
        // activity. Application metadata is accepted only as a compatibility fallback.
        val raw = activityRaw ?: applicationRaw
        return when (raw?.toString()?.trim()) {
            "1", "Mixed", "mixed" -> "Mixed"
            "3", "Full", "full" -> "Full"
            else -> null
        }
    }

    private fun apkSha256(context: Context): String {
        cachedApkSha256?.let { return it }
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(context.applicationInfo.sourceDir).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) digest.update(buffer, 0, count)
            }
        }
        val value = digest.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
        cachedApkSha256 = value
        return value
    }

    private fun sceneSnapshotTarget(context: Context, requestId: String): File =
        File(File(context.cacheDir, SCENE_SNAPSHOT_CACHE_DIRECTORY), "$requestId.json")

    private fun find(root: Entity, name: String): Entity? {
        var found: Entity? = null
        walk(root, 0, Int.MAX_VALUE) { e, _ -> if (found == null && e.getName() == name) found = e }
        return found
    }

    private fun vec3(s: String?, def: Vector3): Vector3 {
        if (s == null) return def
        val p = s.split(",")
        if (p.size != 3) return def
        return runCatching { Vector3(p[0].trim().toFloat(), p[1].trim().toFloat(), p[2].trim().toFloat()) }.getOrDefault(def)
    }

    private fun walk(e: Entity, depth: Int, maxDepth: Int, visit: (Entity, Int) -> Unit) {
        visit(e, depth)
        if (depth >= maxDepth) return
        runCatching { e.getChildren() }.getOrDefault(emptyArray()).forEach { walk(it, depth + 1, maxDepth, visit) }
    }
}
`;
}

function initProviderKt(pkg: string): string {
  return `package ${pkg}

import android.content.BroadcastReceiver
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle

/**
 * AgentBridgeInitProvider — zero-app-code auto-init for AgentBridge (the LeakCanary/Firebase trick).
 * Generated by pico-spatial-mcp generate_agent_bridge.
 *
 * Manifest-merged ContentProvider: its onCreate runs at process start (before Application.onCreate),
 * registering the <applicationId>.AGENT_CMD BroadcastReceiver. No ContentProvider data methods used.
 */
class AgentBridgeInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val ctx = context?.applicationContext ?: return false
        AgentBridge.initialize(ctx)
        val action = ctx.packageName + AgentBridge.ACTION_SUFFIX
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                if (intent == null) return
                AgentBridge.dispatch(intent.getStringExtra("cmd"), intent.extras ?: Bundle())
            }
        }
        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= 33) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, filter)
        }
        AgentBridge.event("bridge_ready", "action" to action)
        return true
    }

    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?): Int = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?): Int = 0
}
`;
}

export function registerAgentBridgeTools(server: McpServer) {
  server.registerTool(
    "generate_agent_bridge",
    {
      description:
        "Emit an INJECTABLE Kotlin 'Agent Bridge' library that makes a native PICO app headlessly agent-drivable and structurally inspectable. It self-initializes via a manifest-merged ContentProvider and exposes AGENT_CMD broadcasts, structured logcat telemetry, a live scene-graph dump, and the revision-41 query_scene_anchors transport. Scene geometry uses a versioned, lossless, nonce-addressed app-cache JSON file read with explicit-serial run-as; it is never sent through logcat. Those signals prove state, not appearance. Pair them with a capture whose returned app pixels you actually LOOK at; adb capture_frame is often stable for native content, while an alternate host-window capture may be needed when it is black/inconclusive. Returns Kotlin, manifest wiring, and drive examples. APIs are source-confirmed; broadcast/logcat behavior is emulator-measured; revision 41 was live-validated on emulator-5554 with the generated com.fleet.swanmissiontable app. Geometry and labels retain a structural evidence ceiling; rendered pixels require separate visual evidence.",
      inputSchema: {
        packageName: z
          .string()
          .describe("Package for the bridge files, e.g. com.example.spatialdemo.agent"),
        tag: z.string().optional().describe("Logcat tag for telemetry (default 'AgentBridge')."),
      },
    },
    async ({ packageName, tag }) => {
      const t = tag ?? "AgentBridge";
      const pkgPath = packageName.replace(/\./g, "/");
      const files = [
        { path: `app/src/main/java/${pkgPath}/AgentBridge.kt`, content: agentBridgeKt(packageName, t) },
        { path: `app/src/main/java/${pkgPath}/AgentBridgeInitProvider.kt`, content: initProviderKt(packageName) },
      ];
      const manifestProvider =
        `<!-- Agent Bridge auto-init (manifest-merged; boots with no app code). Place inside <application>. -->\n` +
        `<provider\n` +
        `    android:name="${packageName}.AgentBridgeInitProvider"\n` +
        `    android:authorities="\${applicationId}.agentbridge"\n` +
        `    android:exported="false"\n` +
        `    android:enabled="true" />`;
      const integration = [
        "1. Write both .kt files to the paths above.",
        "2. Merge the <provider> snippet into the app's AndroidManifest.xml inside <application>. (Auto-inits the AGENT_CMD receiver at process start — no app code needed.)",
        "3. (Optional, for old scene introspection) after building your scene root, add one line: AgentBridge.attachScene(sceneRoot) — e.g. in HomeStage right after the SpatialView content is built.",
        "4. For query_scene_anchors, report the root explicitly with AgentBridge.attachScene(stageRoot, \"stage\"), pair it with AgentBridge.detachScene(stageRoot) from Stage disposal/closure (or use the identity-bearing attachSceneProvider/detachSceneProvider pair), generate SceneUnderstanding.kt, and call SceneUnderstanding.registerAgentBridgeSceneSnapshot(). Omitting container identity fails binding closed. The one bridge command then performs all unfiltered readiness reads and writes one lossless payload.",
        "5. (Optional) register app-specific commands: AgentBridge.register(\"arm\") { _ -> placer.toggleArmed() }.",
      ];
      const driveExamples = [
        "adb -s emulator-5554 shell am broadcast -a <applicationId>.AGENT_CMD --es cmd ping",
        "adb -s emulator-5554 shell am broadcast -a <applicationId>.AGENT_CMD --es cmd scene_stats",
        "adb -s emulator-5554 shell am broadcast -a <applicationId>.AGENT_CMD --es cmd dump_scene --ei depth 8",
        "adb -s emulator-5554 shell am broadcast -a <applicationId>.AGENT_CMD --es cmd query_scene_anchors --es requestId <nonce> --ei maxRetries 15 --ei pollMs 1000 --ei stabilityReads 2",
        "adb -s emulator-5554 exec-out run-as <applicationId> cat cache/agentbridge/scene-snapshots/<nonce>.json  # exact payload bytes; use a unique nonce",
        `adb -s emulator-5554 logcat -d -s ${t}:V   # read the AGENTBRIDGE| markers`,
      ];
      return okJson({
        files,
        manifestProvider,
        integration,
        driveExamples,
        sceneSnapshotProtocol: {
          kind: AGENT_BRIDGE_SCENE_PAYLOAD_KIND,
          schemaVersion: AGENT_BRIDGE_SCENE_SCHEMA_VERSION,
          bridgeRevision: AGENT_BRIDGE_SCENE_REVISION,
          command: AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND,
          cacheDirectory: AGENT_BRIDGE_SCENE_SNAPSHOT_CACHE_DIRECTORY,
        },
        builtinCommands: ["ping", "commands", "scene_stats", "dump_scene", AGENT_BRIDGE_SCENE_SNAPSHOT_COMMAND, "spawn", "move", "remove"],
        verification:
          "The revision-41 source and exact-file transport contract is structurally tested and was exercised live on emulator-5554 by com.fleet.swanmissiontable. The pulled geometry and labels remain structural evidence; verify rendered pixels separately from hidden scene data.",
      });
    },
  );
}
