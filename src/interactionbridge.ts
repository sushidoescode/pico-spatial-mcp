import path from "node:path";
import { z } from "zod";
import { runBinary } from "./util.js";

/** App-private AgentBridge extension. It deliberately does not install the legacy broadcast receiver. */
export const INTERACTION_BRIDGE_ROOT = "files/agentbridge/interaction-v1";
export const INTERACTION_BRIDGE_MAX_BYTES = 65_536;
const packageSchema = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/).max(180);
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const panelStateSchema = z.object({
  panel: z.object({ id: z.literal("fixture.panel"), visible: z.boolean() }).strict(),
  counter: integer,
}).strict();
const argsSchema = z.object({ panelId: z.literal("fixture.panel") }).strict();

export const bridgeSemanticStateSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("pico.agent-bridge.semantic-state"),
  packageName: packageSchema, generation: uuidSchema, revision: integer,
  observedAtEpochMs: integer, pid: integer.refine((value) => value > 0),
  pidStartTicks: z.string().regex(/^[0-9]{1,24}$/), state: panelStateSchema,
  actions: z.tuple([z.literal("panel.show")]),
}).strict();

export const interactionBridgeRequestSchema = z.object({
  schemaVersion: z.literal(1), packageName: packageSchema, requestId: uuidSchema,
  expectedGeneration: uuidSchema, expectedRevision: integer,
  actionId: z.literal("panel.show"), args: argsSchema, deadlineEpochMs: integer,
}).strict();

export const interactionBridgeAckSchema = z.object({
  schemaVersion: z.literal(1), packageName: packageSchema, requestId: uuidSchema,
  generation: uuidSchema, expectedRevision: integer, actionId: z.literal("panel.show"),
  args: argsSchema, status: z.enum(["accepted", "completed", "refused"]), revision: integer,
  acknowledgedAtEpochMs: integer, state: panelStateSchema,
  error: z.object({ code: z.string().min(1).max(80), detail: z.string().min(1).max(300) }).strict().optional(),
}).strict();

export type BridgeSemanticStateV1 = z.infer<typeof bridgeSemanticStateSchema>;
export type InteractionBridgeRequestV1 = z.infer<typeof interactionBridgeRequestSchema>;
export type InteractionBridgeAckV1 = z.infer<typeof interactionBridgeAckSchema>;

function checkState(revision: number, state: BridgeSemanticStateV1["state"]): void {
  if (revision !== state.counter || state.panel.visible !== (state.counter > 0)) {
    throw new Error("bridge state counter, revision and panel visibility contradict one another");
  }
}

export function parseBridgeSemanticState(value: unknown): BridgeSemanticStateV1 {
  const parsed = bridgeSemanticStateSchema.parse(value);
  checkState(parsed.revision, parsed.state);
  return parsed;
}

export function parseInteractionBridgeRequest(value: unknown): InteractionBridgeRequestV1 {
  return interactionBridgeRequestSchema.parse(value);
}

export function parseInteractionBridgeAck(value: unknown, expected: InteractionBridgeRequestV1): InteractionBridgeAckV1 {
  const request = parseInteractionBridgeRequest(expected);
  const ack = interactionBridgeAckSchema.parse(value);
  if (ack.packageName !== request.packageName || ack.requestId !== request.requestId
      || ack.generation !== request.expectedGeneration || ack.expectedRevision !== request.expectedRevision
      || ack.actionId !== request.actionId || ack.args.panelId !== request.args.panelId) {
    throw new Error("ACK does not match package, request, generation, revision or action");
  }
  checkState(ack.revision, ack.state);
  if (ack.status === "refused") {
    if (!ack.error) throw new Error("refused ACK requires a reason");
  } else {
    if (ack.error) throw new Error("accepted/completed ACK cannot contain an error");
    if (ack.status === "accepted" && ack.revision !== request.expectedRevision) {
      throw new Error("accepted ACK changed revision before completion");
    }
    if (ack.status === "completed" && (!ack.state.panel.visible
        || ack.revision < request.expectedRevision || ack.revision > request.expectedRevision + 1)) {
      throw new Error("completed ACK does not establish the requested state transition");
    }
    if (ack.acknowledgedAtEpochMs > request.deadlineEpochMs) throw new Error("ACK is after the action deadline");
  }
  return ack;
}

export interface InteractionBridgeBackend {
  observe(timeoutMs?: number): Promise<BridgeSemanticStateV1>;
  send(request: InteractionBridgeRequestV1, timeoutMs?: number): Promise<void>;
  readAck(request: InteractionBridgeRequestV1, timeoutMs?: number): Promise<InteractionBridgeAckV1 | null>;
}

export interface InteractionBridgeBackendOptions {
  adb: string;
  serial: string;
  packageName: string;
  signal?: AbortSignal;
  runBytes?: typeof runBinary;
}

function quoteRemote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function callTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? 2_000;
  if (!Number.isInteger(value) || value < 1 || value > 15_000) throw new Error("bridge timeout must be 1..15000 ms");
  return value;
}

/** Every operation names its package and serial; target/fence validation belongs to the session caller. */
export function createInteractionBridgeBackend(options: InteractionBridgeBackendOptions): InteractionBridgeBackend {
  if (!path.isAbsolute(options.adb)) throw new Error("bridge requires an absolute adb executable path");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.serial)) throw new Error("bridge requires one explicit safe serial");
  packageSchema.parse(options.packageName);
  const execute = options.runBytes ?? runBinary;
  // Never discard IDs: a lost transport result is not authorization to re-send a possibly applied command.
  const attempted = new Set<string>();
  const validateRequest = (raw: InteractionBridgeRequestV1) => {
    const request = parseInteractionBridgeRequest(raw);
    if (request.packageName !== options.packageName) throw new Error("request package differs from backend package");
    return request;
  };
  const invoke = async (script: string, args: string[], timeoutMs?: number) => {
    if (options.signal?.aborted) throw new Error("cancelled before bridge dispatch");
    const command = ["run-as", options.packageName, "sh", "-c", script, "pico-mcp", ...args].map(quoteRemote).join(" ");
    return execute(options.adb, ["-s", options.serial, "exec-out", command], {
      timeoutMs: callTimeout(timeoutMs), maxOutputBytes: INTERACTION_BRIDGE_MAX_BYTES + 1, signal: options.signal,
    });
  };
  const parentsGuard = (relativePath: string) => {
    const parts = relativePath.split("/");
    return parts.map((_, i) => `test ! -L ${quoteRemote(parts.slice(0, i + 1).join("/"))}`).join(" && ");
  };
  const read = async (relativePath: string, timeoutMs?: number): Promise<unknown | null> => {
    const script = `${parentsGuard(relativePath)} || exit 73; if test -f "$1"; then printf '\\001'; head -c 65537 "$1"; else printf '\\000'; fi`;
    const result = await invoke(script, [relativePath], timeoutMs);
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`bridge read failed: ${result.timedOut ? "timed out" : result.stderr.slice(0, 500) || `exit ${result.code}`}`);
    }
    if (result.stdout.length === 1 && result.stdout[0] === 0) return null;
    if (result.stdout[0] !== 1 || result.stdout.length < 3 || result.stdout.length > INTERACTION_BRIDGE_MAX_BYTES + 1) {
      throw new Error("invalid or oversized bridge file framing");
    }
    return JSON.parse(result.stdout.subarray(1).toString("utf8"));
  };
  return {
    async observe(timeoutMs) {
      const raw = await read(`${INTERACTION_BRIDGE_ROOT}/state.json`, timeoutMs);
      if (raw === null) throw new Error("debug bridge state is unavailable");
      const state = parseBridgeSemanticState(raw);
      if (state.packageName !== options.packageName) throw new Error("observed package differs from backend package");
      return state;
    },
    async send(raw, timeoutMs) {
      const request = validateRequest(raw);
      callTimeout(timeoutMs);
      if (options.signal?.aborted) throw new Error("cancelled before bridge dispatch");
      if (attempted.has(request.requestId)) throw new Error("duplicate request: uncertain dispatch is never retried");
      if (attempted.size >= 128) throw new Error("bridge session request limit reached");
      const relativePath = `${INTERACTION_BRIDGE_ROOT}/${request.expectedGeneration}/inbox/${request.requestId}.json`;
      const payload = Buffer.from(JSON.stringify(request)).toString("base64");
      if (payload.length > 16_384) throw new Error("request exceeds bounded bridge payload");
      attempted.add(request.requestId);
      // Android run-as may refuse hard links. mkdir is the exclusive, persistent request claim;
      // its staging file is never visible to the app's *.json inbox scan until atomic rename.
      // Never remove the claim, including after errors or interruption: reconstruction cannot retry.
      const stagedPath = `${relativePath}.claim/request.tmp`;
      const script = [
        `${parentsGuard(stagedPath)} && test ! -L "$1" && test ! -L "$1.tmp" || exit 73`,
        'test -d "$(dirname "$1")" || exit 74',
        'test ! -e "$1" && test ! -e "$1.tmp" || exit 76',
        'umask 077',
        'mkdir "$1.claim" || exit 76',
        'test ! -L "$1.claim" || exit 73',
        'set -C',
        `printf '%s' "$2" | base64 -d > "$1.claim/request.tmp" || exit 75`,
        `${parentsGuard(stagedPath)} && test ! -L "$1" || exit 73`,
        'test ! -e "$1" || exit 76',
        'mv -n -T "$1.claim/request.tmp" "$1" || exit 77',
        'test ! -e "$1.claim/request.tmp" && test -f "$1" && test ! -L "$1" || exit 78',
        'printf published',
      ].join('; ');
      const result = await invoke(script, [relativePath, payload], timeoutMs);
      if (result.code !== 0 || result.timedOut || result.stdout.toString("utf8") !== "published") {
        // exec-out can return adb exit zero while remote stderr is merged into stdout. Preserve
        // bounded raw diagnostics without treating process exit zero as publication evidence.
        const transport = { code: result.code, timedOut: result.timedOut,
          stdoutBytes: result.stdout.length, stdoutBase64: result.stdout.subarray(0, 1024).toString("base64"),
          stderr: result.stderr.slice(0, 256), truncated: result.stdout.length > 1024 || result.stderr.length > 256 };
        throw new Error(`in_doubt: bridge publication ${result.timedOut ? "timed out" : `failed (${result.code})`}; do not resend request ${request.requestId}; transport=${JSON.stringify(transport)}`);
      }
    },
    async readAck(raw, timeoutMs) {
      const request = validateRequest(raw);
      const value = await read(`${INTERACTION_BRIDGE_ROOT}/${request.expectedGeneration}/acks/${request.requestId}.json`, timeoutMs);
      return value === null ? null : parseInteractionBridgeAck(value, request);
    },
  };
}

/** Emit only into src/debug. The matching release adapter must be inert and contain no IPC code. */
export function emitAgentInteractionBridgeKt(packageName: string): string {
  packageSchema.parse(packageName);
  return KOTLIN_BRIDGE.replace("__PACKAGE__", packageName);
}

const KOTLIN_BRIDGE = String.raw`package __PACKAGE__

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
`;
