package com.example.picofixture.iteration

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import android.os.Process
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Debug-only AgentBridge file transport. Android run-as supplies the app UID; no receiver or listener exists.
 * This proves semantic application state, never a hand/controller route or rendered appearance.
 */
class AgentInteractionBridge(private val context: Context, private val showPanel: () -> Unit) {
    companion object { private const val MAX_REQUESTS = 128; private const val MAX_BYTES = 16384 }
    private val generation = UUID.randomUUID().toString()
    private val root = File(context.filesDir, "agentbridge/interaction-v1")
    private val generationRoot = File(root, generation)
    private val inbox = File(generationRoot, "inbox")
    private val acks = File(generationRoot, "acks")
    private val handler = Handler(Looper.getMainLooper())
    private val seen = mutableSetOf<String>()
    private var running = false
    private var revision = 0L
    private var visible = false
    private val pid = Process.myPid()
    private val pidStartTicks: String = File("/proc/self/stat").readText().substringAfterLast(") ").split(" ")[19]
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            try {
                // All state transitions and Compose state writes are on the main looper.
                inbox.listFiles()?.filter { it.name.endsWith(".json") }?.sortedBy { it.name }?.take(MAX_REQUESTS)?.forEach(::receive)
                publishState()
            } catch (_: Exception) {
                // Fail closed: a damaged private directory cannot trigger arbitrary fallback IPC.
                running = false
            }
            if (running) handler.postDelayed(this, 100L)
        }
    }

    fun start() {
        check(Looper.myLooper() == Looper.getMainLooper())
        check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) { "Debug bridge requires a debuggable APK" }
        check(!running)
        val appFiles = context.filesDir.canonicalFile
        check(root.canonicalFile == File(appFiles, "agentbridge/interaction-v1")) { "Bridge root escaped private files" }
        check(inbox.mkdirs() && acks.mkdirs()) { "Generation directory already exists or is unavailable" }
        running = true
        publishState()
        handler.post(tick)
    }

    fun stop() {
        running = false
        handler.removeCallbacks(tick)
        // Retain state/ACK evidence. Host validates PID/start ticks and generation before attribution.
    }

    private fun state(): JSONObject = JSONObject().put("panel", JSONObject().put("id", "fixture.panel").put("visible", visible)).put("counter", revision)
    private fun publishState() {
        atomicWrite(File(root, "state.json"), JSONObject()
            .put("schemaVersion", 1).put("kind", "pico.agent-bridge.semantic-state")
            .put("packageName", context.packageName).put("generation", generation).put("revision", revision)
            .put("observedAtEpochMs", System.currentTimeMillis()).put("pid", pid).put("pidStartTicks", pidStartTicks)
            .put("state", state()).put("actions", JSONArray().put("panel.show")))
    }

    private fun exactKeys(value: JSONObject, expected: Set<String>): Boolean = value.keys().asSequence().toSet() == expected
    private fun number(value: JSONObject, key: String): Long {
        val raw = value.get(key)
        require(raw is Int || raw is Long)
        val parsed = (raw as Number).toLong()
        require(parsed in 0L..9007199254740991L)
        return parsed
    }

    private fun receive(file: File) {
        val requestId = file.name.removeSuffix(".json")
        if (!uuid.matches(requestId) || requestId in seen || seen.size >= MAX_REQUESTS) return
        require(file.canonicalFile == File(inbox.canonicalFile, file.name)) { "Inbox symlink refused" }
        require(file.length() in 1L..MAX_BYTES.toLong()) { "Oversized request refused" }
        seen.add(requestId) // Tombstone before parsing or action. Never evict/retry within a generation.
        val request = try { JSONObject(file.readText(Charsets.UTF_8)) } catch (_: Exception) { return }
        val fields = setOf("schemaVersion", "packageName", "requestId", "expectedGeneration", "expectedRevision", "actionId", "args", "deadlineEpochMs")
        if (!exactKeys(request, fields)) return
        val valid = runCatching {
            number(request, "schemaVersion") == 1L && request.get("requestId") == requestId &&
                request.get("packageName") == context.packageName && request.get("actionId") == "panel.show" &&
                request.get("expectedGeneration") is String && uuid.matches(request.getString("expectedGeneration")) &&
                exactKeys(request.getJSONObject("args"), setOf("panelId")) && request.getJSONObject("args").get("panelId") == "fixture.panel"
        }.getOrDefault(false)
        if (!valid) return
        val expectedRevision = runCatching { number(request, "expectedRevision") }.getOrNull() ?: return
        val deadline = runCatching { number(request, "deadlineEpochMs") }.getOrNull() ?: return
        val now = System.currentTimeMillis()
        val reason = when {
            request.getString("expectedGeneration") != generation -> "generation_mismatch"
            expectedRevision != revision -> "revision_mismatch"
            deadline < now -> "deadline_expired"
            deadline - now > 60000L -> "deadline_too_long"
            else -> null
        }
        if (reason != null) { acknowledge(request, "refused", reason); return }
        acknowledge(request, "accepted")
        // Deadline is checked once more after publishing accepted and before any state change.
        if (System.currentTimeMillis() > deadline) { acknowledge(request, "refused", "deadline_expired"); return }
        if (!visible) {
            showPanel()
            visible = true
            revision += 1L
        }
        publishState()
        acknowledge(request, "completed")
    }

    private fun acknowledge(request: JSONObject, status: String, reason: String? = null) {
        val ack = JSONObject().put("schemaVersion", 1).put("packageName", context.packageName)
            .put("requestId", request.getString("requestId")).put("generation", generation)
            .put("expectedRevision", request.getLong("expectedRevision")).put("actionId", "panel.show")
            .put("args", JSONObject().put("panelId", "fixture.panel")).put("status", status)
            .put("revision", revision).put("acknowledgedAtEpochMs", System.currentTimeMillis()).put("state", state())
        if (reason != null) ack.put("error", JSONObject().put("code", reason).put("detail", "Request refused before mutation"))
        atomicWrite(File(acks, request.getString("requestId") + ".json"), ack)
    }

    private fun atomicWrite(target: File, value: JSONObject) {
        val canonicalRoot = root.canonicalFile
        require(canonicalRoot == File(context.filesDir.canonicalFile, "agentbridge/interaction-v1"))
        require(target.canonicalFile == File(target.parentFile!!.canonicalFile, target.name))
        require(target.canonicalFile.toPath().startsWith(canonicalRoot.toPath()))
        val temporary = File(target.parentFile, target.name + ".tmp")
        require(temporary.canonicalFile == File(target.parentFile!!.canonicalFile, temporary.name))
        val bytes = value.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_BYTES)
        temporary.outputStream().use { it.write(bytes); it.fd.sync() }
        check(temporary.renameTo(target)) { "Atomic bridge publication failed" }
    }
}
