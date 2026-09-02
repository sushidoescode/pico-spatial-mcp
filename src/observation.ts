import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { probeDeviceIdentity, type ProbedDeviceIdentity } from "./deviceidentity.js";
import { validateCaptureBuffer } from "./evidence.js";
import { resolveAdb } from "./emulatorlook.js";
import { expandHome, run, runBinary, sleep } from "./util.js";

export const SETTLE_COMPARISON = "byte_exact" as const;
export const CAPTURE_SOURCE = "adb-exec-out-screencap" as const;

export interface CapturedFrame {
  bytes: Buffer;
  capturedAt: string;
  width: number;
  height: number;
}

export interface SettlePolicy {
  maxTries: number;
  intervalMs: number;
  comparison: typeof SETTLE_COMPARISON;
  priorSha256?: string;
}

export interface SettleDependencies {
  capture: () => Promise<CapturedFrame>;
  sleep: (ms: number) => Promise<void>;
  hash: (bytes: Buffer) => string;
}

export type SettledFrameResult =
  | {
      status: "settled";
      attempts: number;
      settlementSatisfied: true;
      frame: CapturedFrame;
      sha256: string;
      stablePair: [string, string];
    }
  | {
      status: "timeout";
      attempts: number;
      settlementSatisfied: false;
      frame: CapturedFrame;
      sha256: string;
      stablePair: null;
    }
  | {
      status: "capture_failed";
      attempts: number;
      settlementSatisfied: false;
      frame: CapturedFrame | null;
      sha256: string | null;
      stablePair: null;
      detail: string;
    };

/**
 * Capture until two consecutive frame byte streams are identical. When priorSha256 is supplied,
 * the stable pair must also differ from that exact prior frame so a delayed transition cannot
 * settle on stale pixels. Capture, sleeping, and hashing are injected so the complete discipline
 * is deterministic under unit tests and shared by every caller. A failed later capture retains the
 * last valid frame; a timeout never claims that its final frame is a navigation waypoint.
 */
export async function captureSettledFrames(
  policy: SettlePolicy,
  deps: SettleDependencies,
): Promise<SettledFrameResult> {
  if (policy.priorSha256 !== undefined && !/^[0-9a-f]{64}$/.test(policy.priorSha256)) {
    return {
      status: "capture_failed",
      attempts: 0,
      settlementSatisfied: false,
      frame: null,
      sha256: null,
      stablePair: null,
      detail: "priorSha256 must be exactly 64 lowercase hexadecimal characters",
    };
  }
  let previous: { frame: CapturedFrame; sha256: string } | null = null;
  for (let attempt = 1; attempt <= policy.maxTries; attempt++) {
    let frame: CapturedFrame;
    try {
      frame = await deps.capture();
    } catch (error: any) {
      return {
        status: "capture_failed",
        attempts: attempt,
        settlementSatisfied: false,
        frame: previous?.frame ?? null,
        sha256: previous?.sha256 ?? null,
        stablePair: null,
        detail: error?.message ?? String(error),
      };
    }
    const sha256 = deps.hash(frame.bytes);
    if (
      previous
      && frame.bytes.equals(previous.frame.bytes)
      && sha256 !== policy.priorSha256
    ) {
      return {
        status: "settled",
        attempts: attempt,
        settlementSatisfied: true,
        frame,
        sha256,
        stablePair: [previous.sha256, sha256],
      };
    }
    previous = { frame, sha256 };
    if (attempt < policy.maxTries) await deps.sleep(policy.intervalMs);
  }
  if (!previous) {
    return {
      status: "capture_failed",
      attempts: 0,
      settlementSatisfied: false,
      frame: null,
      sha256: null,
      stablePair: null,
      detail: "capture budget contained no attempts",
    };
  }
  return {
    status: "timeout",
    attempts: policy.maxTries,
    settlementSatisfied: false,
    frame: previous.frame,
    sha256: previous.sha256,
    stablePair: null,
  };
}

export interface CaptureLiveIdentity extends ProbedDeviceIdentity {
  bootId: string;
  observedAt: string;
}

export interface CaptureRuntimeBinding {
  serial: string;
  liveIdentity: CaptureLiveIdentity;
  captureSource: typeof CAPTURE_SOURCE;
  startedAtMonotonicNs: string;
  endedAtMonotonicNs: string;
}

export interface CaptureRef {
  path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  dimensions: { width: number; height: number };
  sourceSerial: string;
  capturedAt: string;
}

export interface CaptureSettledReceipt {
  status: "settled" | "timeout" | "capture_failed";
  serial: string;
  path: string | null;
  sha256: string | null;
  attempts: number;
  settlementSatisfied: boolean;
  comparison: typeof SETTLE_COMPARISON;
  stablePair: [string, string] | null;
  captureRuntimeBinding: CaptureRuntimeBinding | null;
  captureRef: CaptureRef | null;
  lastValidCaptureRef: CaptureRef | null;
  actionReceipts: [];
  error: { code: string; detail: string } | null;
  evidenceCeiling: "structural";
  lookRequired: true;
}

export interface CaptureSettledInput {
  serial: string;
  outPath: string;
  maxTries: number;
  intervalMs: number;
  comparison: typeof SETTLE_COMPARISON;
  priorSha256?: string;
}

export interface CaptureSettledDependencies {
  monotonicNs: () => bigint;
  listOnlineSerials: () => Promise<string[]>;
  probeIdentity: (serial: string) => Promise<CaptureLiveIdentity>;
  capture: (serial: string) => Promise<CapturedFrame>;
  sleep: (ms: number) => Promise<void>;
  hash: (bytes: Buffer) => string;
  writeFrame: (absolutePath: string, bytes: Buffer) => void;
}

function identityProblem(identity: CaptureLiveIdentity, serial: string): string | null {
  if (identity.serial !== serial) return `live identity returned serial '${identity.serial}' for requested serial '${serial}'`;
  if (!identity.model.trim()) return "live identity model is empty";
  if (!identity.fingerprint.trim()) return "live identity fingerprint is empty";
  if (typeof identity.bootQemu !== "string") return "live identity bootQemu is missing";
  if (!identity.bootId.trim()) return "live identity boot ID is empty";
  if (!Number.isFinite(Date.parse(identity.observedAt))) return "live identity observedAt is invalid";
  return null;
}

function sameRuntimeIdentity(before: CaptureLiveIdentity, after: CaptureLiveIdentity): boolean {
  return before.serial === after.serial
    && before.model === after.model
    && before.fingerprint === after.fingerprint
    && before.bootQemu === after.bootQemu
    && before.bootId === after.bootId;
}

export function sha256Bytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function parseOnlineAdbSerials(output: string): string[] {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2 && fields[1] === "device")
    .map((fields) => fields[0]);
}

export async function captureAdbFrame(adb: string, serial: string, timeoutMs = 30_000): Promise<CapturedFrame> {
  const result = await runBinary(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
    timeoutMs,
    maxOutputBytes: 64 * 1024 * 1024,
  });
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `adb screencap failed for '${serial}' (exit ${result.code}${result.timedOut ? ", timeout" : ""}): ${result.stderr.trim() || "no stderr"}`,
    );
  }
  const checked = validateCaptureBuffer(result.stdout, `${serial} screencap`);
  if (!checked.ok) throw new Error(checked.reason ?? `invalid screencap returned for '${serial}'`);
  if (checked.format !== "png") throw new Error(`adb screencap for '${serial}' returned ${checked.format ?? "unknown"}, expected PNG`);
  return {
    bytes: result.stdout,
    capturedAt: new Date().toISOString(),
    width: checked.width!,
    height: checked.height!,
  };
}

async function defaultOnlineSerials(adb: string): Promise<string[]> {
  const result = await run(adb, ["devices", "-l"], { timeoutMs: 10_000 });
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `adb devices failed (exit ${result.code}${result.timedOut ? ", timeout" : ""}): ${result.stderr.trim() || "no stderr"}`,
    );
  }
  return parseOnlineAdbSerials(result.stdout);
}

async function defaultIdentity(adb: string, serial: string): Promise<CaptureLiveIdentity> {
  const identity = await probeDeviceIdentity(adb, serial);
  const boot = await run(adb, ["-s", serial, "shell", "cat", "/proc/sys/kernel/random/boot_id"], { timeoutMs: 10_000 });
  if (boot.code !== 0 || boot.timedOut || !boot.stdout.trim()) {
    throw new Error(
      `adb boot identity probe failed for '${serial}' (exit ${boot.code}${boot.timedOut ? ", timeout" : ""}): ${boot.stderr.trim() || "empty boot id"}`,
    );
  }
  return { ...identity, bootId: boot.stdout.trim(), observedAt: new Date().toISOString() };
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function resolveProspectivePath(candidate: string): string {
  const absolute = path.resolve(expandHome(candidate));
  let ancestor = path.dirname(absolute);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = fs.existsSync(ancestor) ? fs.realpathSync(ancestor) : ancestor;
  return path.resolve(realAncestor, path.relative(ancestor, absolute));
}

export function assertExternalCapturePath(candidate: string): string {
  const absolute = resolveProspectivePath(candidate);
  const repo = fs.existsSync(repositoryRoot()) ? fs.realpathSync(repositoryRoot()) : repositoryRoot();
  if (isWithin(repo, absolute)) {
    throw new Error(`capture path '${absolute}' is inside the repository; room captures must use an external session path`);
  }
  return absolute;
}

function publishExternalFrame(
  target: string,
  bytes: Buffer,
  expectedSha256: string,
  deps: Pick<CaptureSettledDependencies, "writeFrame" | "hash">,
): { path: string; bytes: Buffer; sha256: string } {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const checkedTarget = assertExternalCapturePath(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    deps.writeFrame(temporary, bytes);
    const stagedStat = fs.lstatSync(temporary);
    if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
      throw new Error("capture writer did not produce a regular temporary file");
    }
    const staged = fs.readFileSync(temporary);
    if (deps.hash(staged) !== expectedSha256 || !staged.equals(bytes)) {
      throw new Error("temporary capture bytes do not match the captured frame");
    }
    // Same-directory rename replaces an existing symlink/hard-link directory entry instead of
    // following it and truncating its target inode.
    fs.renameSync(temporary, checkedTarget);
    const publishedPath = fs.realpathSync(checkedTarget);
    assertExternalCapturePath(publishedPath);
    const published = fs.readFileSync(publishedPath);
    const publishedSha256 = deps.hash(published);
    if (publishedSha256 !== expectedSha256 || !published.equals(bytes)) {
      throw new Error("published capture bytes do not match the captured frame");
    }
    return { path: publishedPath, bytes: published, sha256: publishedSha256 };
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Publication already failed; preserve the primary error.
    }
  }
}

function emptyReceipt(
  serial: string,
  error: { code: string; detail: string },
  attempts = 0,
  binding: CaptureRuntimeBinding | null = null,
): CaptureSettledReceipt {
  return {
    status: "capture_failed",
    serial,
    path: null,
    sha256: null,
    attempts,
    settlementSatisfied: false,
    comparison: SETTLE_COMPARISON,
    stablePair: null,
    captureRuntimeBinding: binding,
    captureRef: null,
    lastValidCaptureRef: null,
    actionReceipts: [],
    error,
    evidenceCeiling: "structural",
    lookRequired: true,
  };
}

export async function executeCaptureSettled(
  input: CaptureSettledInput,
  deps: CaptureSettledDependencies,
): Promise<{ receipt: CaptureSettledReceipt; frame: Buffer | null }> {
  const startedAtMonotonicNs = deps.monotonicNs().toString();
  let absolutePath: string;
  try {
    absolutePath = assertExternalCapturePath(input.outPath);
  } catch (error: any) {
    return {
      receipt: emptyReceipt(input.serial, {
        code: "artifact_path_inside_repository",
        detail: error?.message ?? String(error),
      }),
      frame: null,
    };
  }

  let online: string[];
  try {
    online = await deps.listOnlineSerials();
  } catch (error: any) {
    return {
      receipt: emptyReceipt(input.serial, { code: "binding_failed", detail: error?.message ?? String(error) }),
      frame: null,
    };
  }
  if (!online.includes(input.serial)) {
    return {
      receipt: emptyReceipt(input.serial, {
        code: "binding_failed",
        detail: `requested adb serial '${input.serial}' is not online; refusing to guess from [${online.join(", ") || "none"}]`,
      }),
      frame: null,
    };
  }

  let liveIdentity: CaptureLiveIdentity;
  try {
    liveIdentity = await deps.probeIdentity(input.serial);
  } catch (error: any) {
    return {
      receipt: emptyReceipt(input.serial, {
        code: "binding_failed",
        detail: `live identity probe failed for '${input.serial}': ${error?.message ?? String(error)}`,
      }),
      frame: null,
    };
  }
  const initialIdentityProblem = identityProblem(liveIdentity, input.serial);
  if (initialIdentityProblem) {
    return {
      receipt: emptyReceipt(input.serial, {
        code: "binding_failed",
        detail: initialIdentityProblem,
      }),
      frame: null,
    };
  }

  const bindingBase = {
    serial: input.serial,
    liveIdentity,
    captureSource: CAPTURE_SOURCE,
    startedAtMonotonicNs,
  } as const;
  const closeBinding = (): CaptureRuntimeBinding => ({
    ...bindingBase,
    endedAtMonotonicNs: deps.monotonicNs().toString(),
  });

  // The design register explicitly leaves exact-equality policy for dynamic hardware/MR frames
  // unverified. Static emulator frames are the sole measured byte-exact lane in Phase 1A.
  if (!input.serial.startsWith("emulator-") || liveIdentity.bootQemu !== "1") {
    const binding = closeBinding();
    return {
      receipt: emptyReceipt(
        input.serial,
        {
          code: "comparison_policy_unverified",
          detail: "byte_exact settlement on hardware or another non-emulator runtime is UNVERIFIED; refusing to claim a settled waypoint",
        },
        0,
        binding,
      ),
      frame: null,
    };
  }

  const settled = await captureSettledFrames(
    {
      maxTries: input.maxTries,
      intervalMs: input.intervalMs,
      comparison: input.comparison,
      priorSha256: input.priorSha256,
    },
    { capture: () => deps.capture(input.serial), sleep: deps.sleep, hash: deps.hash },
  );
  let endingIdentity: CaptureLiveIdentity | null = null;
  let runtimeChanged: string | null = null;
  try {
    endingIdentity = await deps.probeIdentity(input.serial);
  } catch (error: any) {
    runtimeChanged = `post-capture live identity probe failed for '${input.serial}': ${error?.message ?? String(error)}`;
  }
  if (endingIdentity) {
    runtimeChanged = identityProblem(endingIdentity, input.serial) ?? (
      sameRuntimeIdentity(liveIdentity, endingIdentity)
        ? null
        : "live identity changed during capture; refusing to bind the frames to one runtime"
    );
  }
  const binding = closeBinding();
  if (!settled.frame || !settled.sha256) {
    return {
      receipt: emptyReceipt(
        input.serial,
        { code: "capture_failed", detail: settled.status === "capture_failed" ? settled.detail : "capture produced no valid frame" },
        settled.attempts,
        binding,
      ),
      frame: null,
    };
  }

  let published: { path: string; bytes: Buffer; sha256: string };
  try {
    published = publishExternalFrame(absolutePath, settled.frame.bytes, settled.sha256, deps);
  } catch (error: any) {
    return {
      receipt: emptyReceipt(
        input.serial,
        { code: "artifact_write_failed", detail: error?.message ?? String(error) },
        settled.attempts,
        binding,
      ),
      frame: settled.frame.bytes,
    };
  }

  const captureRef: CaptureRef = {
    path: published.path,
    sha256: published.sha256,
    bytes: published.bytes.length,
    width: settled.frame.width,
    height: settled.frame.height,
    dimensions: { width: settled.frame.width, height: settled.frame.height },
    sourceSerial: input.serial,
    capturedAt: settled.frame.capturedAt,
  };
  if (runtimeChanged) {
    return {
      receipt: {
        ...emptyReceipt(input.serial, { code: "binding_failed", detail: runtimeChanged }, settled.attempts, binding),
        path: published.path,
        sha256: published.sha256,
        captureRef,
        lastValidCaptureRef: captureRef,
      },
      frame: published.bytes,
    };
  }
  const failedDetail = settled.status === "capture_failed" ? settled.detail : null;
  const receipt: CaptureSettledReceipt = {
    status: settled.status,
    serial: input.serial,
    path: published.path,
    sha256: published.sha256,
    attempts: settled.attempts,
    settlementSatisfied: settled.settlementSatisfied,
    comparison: SETTLE_COMPARISON,
    stablePair: settled.stablePair,
    captureRuntimeBinding: binding,
    captureRef,
    lastValidCaptureRef: settled.status === "settled" ? null : captureRef,
    actionReceipts: [],
    error: settled.status === "settled"
      ? null
      : settled.status === "timeout"
        ? {
            code: "settle_timeout",
            detail: input.priorSha256
              ? `no byte-identical consecutive pair different from the required prior frame within ${settled.attempts} capture attempts`
              : `no byte-identical consecutive pair within ${settled.attempts} capture attempts`,
          }
        : { code: "capture_failed", detail: failedDetail! },
    evidenceCeiling: "structural",
    lookRequired: true,
  };
  return { receipt, frame: published.bytes };
}

function defaultDependencies(adb: string, attemptTimeoutMs = 30_000): CaptureSettledDependencies {
  return {
    monotonicNs: () => process.hrtime.bigint(),
    listOnlineSerials: () => defaultOnlineSerials(adb),
    probeIdentity: (serial) => defaultIdentity(adb, serial),
    capture: (serial) => captureAdbFrame(adb, serial, attemptTimeoutMs),
    sleep,
    hash: sha256Bytes,
    writeFrame: (absolutePath, bytes) => fs.writeFileSync(absolutePath, bytes),
  };
}

export interface ExecuteLiveCaptureSettledOptions {
  adbPath?: string;
  attemptTimeoutMs?: number;
  dependencies?: CaptureSettledDependencies;
}

/** Shared live entrypoint used by both the MCP handler and internal bounded route orchestrators. */
export async function executeLiveCaptureSettled(
  input: CaptureSettledInput,
  options: ExecuteLiveCaptureSettledOptions = {},
): Promise<{ receipt: CaptureSettledReceipt; frame: Buffer | null }> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
    throw new Error("attemptTimeoutMs must be a positive safe integer");
  }
  return executeCaptureSettled(
    input,
    options.dependencies ?? defaultDependencies(options.adbPath ?? resolveAdb(), attemptTimeoutMs),
  );
}

async function responsePreview(fullPath: string, maxDim: number): Promise<string> {
  const small = fullPath.replace(/\.png$/i, "") + ".small.png";
  const resized = await run("sips", ["-Z", String(maxDim), fullPath, "--out", small], { timeoutMs: 20_000 });
  return resized.code === 0 && fs.existsSync(small) ? small : fullPath;
}

const captureRefSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  sourceSerial: z.string(),
  capturedAt: z.string(),
});

const runtimeBindingSchema = z.object({
  serial: z.string(),
  liveIdentity: z.object({
    serial: z.string(),
    model: z.string(),
    fingerprint: z.string(),
    bootQemu: z.string(),
    bootId: z.string(),
    observedAt: z.string(),
  }),
  captureSource: z.literal(CAPTURE_SOURCE),
  startedAtMonotonicNs: z.string(),
  endedAtMonotonicNs: z.string(),
});

export function registerObservationTools(server: McpServer) {
  server.registerTool(
    "capture_settled",
    {
      description:
        "Capture one exact adb serial until two consecutive rendered PNG byte streams are identical. Returns settled, timeout, or capture_failed with exact runtime binding, hashes, attempts, and the last valid external frame. A timeout is NOT a navigation waypoint even if its pixels are later LOOKed at. Evidence ceiling is structural; LOOK is still required for any pixel claim. Byte-exact hardware/MR settlement remains UNVERIFIED and is refused.",
      inputSchema: {
        serial: z.string().min(1).describe("Exact online adb serial; required so the tool never guesses among emulator/device targets."),
        outPath: z.string().optional().describe("Absolute external full-resolution PNG path (default: a unique /tmp/pico-render path); repository paths are refused."),
        maxDim: z.number().int().positive().optional().describe("Maximum response-image dimension (default 1200; full artifact is unchanged)."),
        maxTries: z.number().int().min(2).max(100).optional().describe("Maximum capture attempts (default 12)."),
        intervalMs: z.number().int().min(0).max(60_000).optional().describe("Delay between captures in milliseconds (default 700)."),
        comparison: z.literal(SETTLE_COMPARISON).optional().describe("Phase-1 comparison policy; only byte_exact is supported."),
      },
      outputSchema: {
        status: z.enum(["settled", "timeout", "capture_failed"]),
        serial: z.string(),
        path: z.string().nullable(),
        sha256: z.string().nullable(),
        attempts: z.number().int().nonnegative(),
        settlementSatisfied: z.boolean(),
        comparison: z.literal(SETTLE_COMPARISON),
        stablePair: z.tuple([z.string(), z.string()]).nullable(),
        captureRuntimeBinding: runtimeBindingSchema.nullable(),
        captureRef: captureRefSchema.nullable(),
        lastValidCaptureRef: captureRefSchema.nullable(),
        actionReceipts: z.array(z.never()),
        error: z.object({ code: z.string(), detail: z.string() }).nullable(),
        evidenceCeiling: z.literal("structural"),
        lookRequired: z.literal(true),
      },
    },
    async ({ serial, outPath, maxDim, maxTries, intervalMs, comparison }) => {
      const result = await executeLiveCaptureSettled(
        {
          serial,
          outPath: outPath ?? path.join(os.tmpdir(), "pico-render", `capture_settled-${crypto.randomUUID()}.png`),
          maxTries: maxTries ?? 12,
          intervalMs: intervalMs ?? 700,
          comparison: comparison ?? SETTLE_COMPARISON,
        },
      );
      const content: Array<{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }> = [];
      if (result.frame && result.receipt.path) {
        const preview = await responsePreview(result.receipt.path, maxDim ?? 1200);
        content.push({ type: "image", data: fs.readFileSync(preview).toString("base64"), mimeType: "image/png" });
      }
      content.push({ type: "text", text: JSON.stringify(result.receipt, null, 2) });
      return { content, structuredContent: result.receipt as unknown as Record<string, unknown> };
    },
  );
}
