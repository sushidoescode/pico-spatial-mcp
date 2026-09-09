import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, fail, okJson, expandHome, sleep } from "./util.js";
import { completeDependencies } from "./dependencies.js";
import { probeHostWindow, unavailableHostWindowProbe, hostWindowPrecondition, type HostWindowProbe } from "./hostwindow.js";
import { resolveAdb } from "./emulatorlook.js";
import { readDiscovery, type EmulatorDiscoveryRecord } from "./emulator.js";
import { getClient, resolveGrpcEndpointBinding, unary, type GrpcEndpointBinding } from "./grpc.js";
import {
  captureAdbFrame,
  captureSettledFrames,
  parseOnlineAdbSerials,
  sha256Bytes,
  SETTLE_COMPARISON,
  type SettledFrameResult,
} from "./observation.js";
import {
  CameraActionExecutionError,
  executeBoundCameraActions,
  type CameraActionBindingReceipt,
  type RelativeCameraAction,
} from "./navigation.js";

/**
 * cameradrive.ts — capture_orbit / capture_multiview: DRIVE the emulator free camera and
 * capture from multiple viewpoints, so an agent can visually verify 3D placement on its own
 * instead of asking the user for walk-around screenshots.
 *
 * Mechanism (settled empirically 2026-08-08 after a two-session goose chase):
 *  - TRANSLATION: gRPC EmulatorController.sendKey keydown/keyup with 'w','a','s','d','q','e'
 *    drives the GUI free-cam walk (W fwd / S back / A left / D right / Q down / E up, relative
 *    to current facing). A 2026-08-31 locked-console probe measured an exact-bound W move and
 *    byte-exact S inverse without host focus; rendered effect still requires settled LOOK.
 *  - ROTATION: only a RIGHT-button mouse drag on the GL surface rotates (same lane as
 *    emulator_look). gRPC sendMouse does NOT rotate; xr_head_* InputEvents do NOT move the
 *    view. So rotation posts CGEvents (macOS + Accessibility); translation is plain gRPC.
 *  - SETTLE: every motion glides after input stops. Both prior sessions produced false
 *    "input doesn't work" verdicts by capturing once, too early, and reading byte-identical
 *    hashes. ALWAYS settle-wait (consecutive identical captures) before judging a capture.
 */

const KEYCODES: Record<string, true> = { w: true, a: true, s: true, d: true, q: true, e: true };

export interface QemuWindowIdentity {
  windowId: number;
  ownerPid: number;
  area: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scale?: number;
}

export interface BoundQemuWindow extends GrpcEndpointBinding {
  onlineEmulatorSerials: string[];
  qemuWindowOwnerPid: number;
  qemuWindowId: number;
  qemuWindowX?: number;
  qemuWindowY?: number;
  qemuWindowWidth?: number;
  qemuWindowHeight?: number;
  qemuWindowScale?: number;
  bindingMethod: "discovery-pid-window" | "single-online-serial-plus-matching-discovery-plus-single-window";
}

export type QemuWindowBindingResult =
  | { ok: true; binding: BoundQemuWindow }
  | { ok: false; code: "binding_failed" | "ambiguous_host_window"; detail: string };

function measuredWindowGeometry(window: QemuWindowIdentity): {
  qemuWindowX: number;
  qemuWindowY: number;
  qemuWindowWidth: number;
  qemuWindowHeight: number;
  qemuWindowScale: number;
} | null {
  const values = [window.x, window.y, window.width, window.height, window.scale];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const [x, y, width, height, scale] = values as number[];
  return width >= 100 && height >= 100 && scale > 0
    ? { qemuWindowX: x, qemuWindowY: y, qemuWindowWidth: width, qemuWindowHeight: height, qemuWindowScale: scale }
    : null;
}

function boundWindowFields(window: QemuWindowIdentity) {
  return {
    qemuWindowOwnerPid: window.ownerPid,
    qemuWindowId: window.windowId,
    ...(measuredWindowGeometry(window) ?? {}),
  };
}

/** Pure fail-closed serial -> discovery endpoint -> qemu window correlation. */
export function selectQemuWindowBinding(
  serial: string,
  onlineSerials: string[],
  discovery: EmulatorDiscoveryRecord[],
  windows: QemuWindowIdentity[],
): QemuWindowBindingResult {
  if (!onlineSerials.includes(serial)) {
    return { ok: false, code: "binding_failed", detail: `requested adb serial '${serial}' is not online` };
  }
  const endpoint = resolveGrpcEndpointBinding(discovery, serial);
  if ("error" in endpoint) return { ok: false, code: "binding_failed", detail: endpoint.error };
  const onlineEmulatorSerials = onlineSerials.filter((candidate) => candidate.startsWith("emulator-")).sort();
  const byPid = endpoint.qemuPid === null ? [] : windows.filter((window) => window.ownerPid === endpoint.qemuPid);
  if (byPid.length === 1) {
    return {
      ok: true,
      binding: {
        ...endpoint,
        onlineEmulatorSerials,
        ...boundWindowFields(byPid[0]),
        bindingMethod: "discovery-pid-window",
      },
    };
  }
  if (
    byPid.length === 0
    && onlineEmulatorSerials.length === 1
    && onlineEmulatorSerials[0] === serial
    && windows.length === 1
  ) {
    return {
      ok: true,
      binding: {
        ...endpoint,
        onlineEmulatorSerials,
        ...boundWindowFields(windows[0]),
        bindingMethod: "single-online-serial-plus-matching-discovery-plus-single-window",
      },
    };
  }
  return {
    ok: false,
    code: "ambiguous_host_window",
    detail:
      `cannot bind adb serial '${serial}' to exactly one qemu window: ` +
      `onlineEmulators=[${onlineEmulatorSerials.join(", ")}], matchingPidWindows=${byPid.length}, eligibleWindows=${windows.length}`,
  };
}

const WINDOW_LIST_SWIFT = `import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
var rows: [[String: Any]] = []
if let windows = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
  for window in windows {
    guard (window[kCGWindowOwnerName as String] as? String) == "qemu-system-aarch64" else { continue }
    guard let id = window[kCGWindowNumber as String] as? Int,
          let pid = window[kCGWindowOwnerPID as String] as? Int else { continue }
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let x = (bounds["X"] as? Double) ?? 0
    let y = (bounds["Y"] as? Double) ?? 0
    let width = (bounds["Width"] as? Double) ?? 0
    let height = (bounds["Height"] as? Double) ?? 0
    let center = CGPoint(x: x + width / 2, y: y + height / 2)
    var displayCount: UInt32 = 0
    CGGetDisplaysWithPoint(center, 0, nil, &displayCount)
    var scale = 0.0
    if displayCount > 0 {
      var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
      CGGetDisplaysWithPoint(center, displayCount, &displays, &displayCount)
      if let display = displays.first, let mode = CGDisplayCopyDisplayMode(display) {
        let displayWidth = CGDisplayBounds(display).width
        if displayWidth > 0 { scale = Double(mode.pixelWidth) / Double(displayWidth) }
      }
    }
    if width >= 100 && height >= 100 && scale > 0 {
      rows.append(["windowId": id, "ownerPid": pid, "x": x, "y": y, "width": width, "height": height, "scale": scale, "area": width * height])
    }
  }
}
let data = try! JSONSerialization.data(withJSONObject: rows, options: [])
print(String(data: data, encoding: .utf8)!)
`;

async function listQemuWindows(): Promise<QemuWindowIdentity[]> {
  const swiftPath = path.join(os.tmpdir(), "pico-camera-window-list.swift");
  fs.writeFileSync(swiftPath, WINDOW_LIST_SWIFT);
  const result = await run("swift", [swiftPath], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`qemu window enumeration failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(parsed)) throw new Error("qemu window enumeration returned a non-array payload");
  return parsed.filter((entry): entry is QemuWindowIdentity =>
    Number.isInteger(entry?.windowId) && Number.isInteger(entry?.ownerPid) && Number.isFinite(entry?.area)
    && Number.isFinite(entry?.x) && Number.isFinite(entry?.y)
    && Number.isFinite(entry?.width) && entry.width >= 100
    && Number.isFinite(entry?.height) && entry.height >= 100
    && Number.isFinite(entry?.scale) && entry.scale > 0);
}

export async function bindMacQemuWindow(adb: string, serial: string): Promise<QemuWindowBindingResult> {
  const listed = await run(adb, ["devices", "-l"], { timeoutMs: 10_000 });
  if (listed.code !== 0 || listed.timedOut) {
    return { ok: false, code: "binding_failed", detail: `adb devices failed: ${listed.stderr || listed.stdout}` };
  }
  let windows: QemuWindowIdentity[];
  try {
    windows = await listQemuWindows();
  } catch (error: any) {
    return { ok: false, code: "ambiguous_host_window", detail: error?.message ?? String(error) };
  }
  return selectQemuWindowBinding(serial, parseOnlineAdbSerials(listed.stdout), readDiscovery(), windows);
}

const FRONTMOST_PID_SWIFT = `import AppKit
print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
`;

export async function frontmostQemu(binding: BoundQemuWindow | null): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  if (!binding) return "ambiguous_host_window: no serial-bound qemu process is available";
  const requested = await run("osascript", ["-e",
    `tell application "System Events" to set frontmost of (first process whose unix id is ${binding.qemuWindowOwnerPid}) to true`,
  ], { timeoutMs: 5000 });
  if (requested.code !== 0 || requested.timedOut) return `osascript frontmost failed: ${requested.stderr || requested.stdout || "request timed out"}`;
  const readback = await run("swift", ["-e", FRONTMOST_PID_SWIFT], { timeoutMs: 5000 });
  if (readback.timedOut) return "frontmost PID readback failed: command timed out";
  if (readback.code !== 0) return `frontmost PID readback failed: command exited ${readback.code ?? "without an exit code"}`;
  const value = readback.stdout.trim();
  if (!/^[1-9]\d*$/.test(value)) return "frontmost PID readback malformed: expected one positive integer";
  const observedPid = Number(value);
  if (!Number.isSafeInteger(observedPid)) return "frontmost PID readback malformed: expected one positive integer";
  return observedPid === binding.qemuWindowOwnerPid
    ? null
    : `frontmost PID readback mismatch: expected ${binding.qemuWindowOwnerPid}, observed ${observedPid}`;
}

/**
 * Exact-bound gRPC key injection targets the selected emulator endpoint directly. Only the
 * CoreGraphics drag lane depends on the qemu window being the active host application.
 */
export async function focusQemuForActions(
  actions: readonly RelativeCameraAction[],
  binding: BoundQemuWindow | null,
  focus: (candidate: BoundQemuWindow | null) => Promise<string | null> = frontmostQemu,
): Promise<string | null> {
  return actions.some((action) => action.kind === "look_drag") ? focus(binding) : null;
}

async function settleCapture(adb: string, serial: string, maxTries = 12, intervalMs = 700): Promise<SettledFrameResult> {
  return captureSettledFrames(
    { maxTries, intervalMs, comparison: SETTLE_COMPARISON },
    {
      capture: (timeoutMs) => captureAdbFrame(adb, serial, timeoutMs),
      sleep,
      hash: sha256Bytes,
      monotonicNs: () => process.hrtime.bigint(),
    },
  );
}

export interface CameraActionReceipt {
  action: "key_hold" | "look_drag";
  serial: string;
  status: "applied" | "failed" | "release_uncertain";
  startedAtMonotonicNs: string;
  endedAtMonotonicNs: string;
  ack: Record<string, unknown>;
  error?: string;
}

interface KeyHoldDependencies {
  getClient: typeof getClient;
  unary: typeof unary;
  sleep: (ms: number) => Promise<void>;
  monotonicNs: () => bigint;
}

/** gRPC key hold with exact-serial discovery on initial/reconnect paths and a paired keyup. */
export function keyHold(
  serial: string,
  key: string,
  holdMs: number,
  injected: Partial<KeyHoldDependencies> = {},
): Promise<CameraActionReceipt> {
  const deps = completeDependencies<KeyHoldDependencies>(
    "keyHold", injected,
    { getClient: true, unary: true, sleep: true, monotonicNs: true },
    () => ({ getClient, unary, sleep, monotonicNs: () => process.hrtime.bigint() }),
  );
  return executeKeyHold(serial, key, holdMs, deps);
}

async function executeKeyHold(
  serial: string,
  key: string,
  holdMs: number,
  deps: KeyHoldDependencies,
): Promise<CameraActionReceipt> {
  const startedAtMonotonicNs = deps.monotonicNs().toString();
  let connection = deps.getClient(undefined, serial);
  const finish = (
    status: CameraActionReceipt["status"],
    ack: Record<string, unknown>,
    error?: string,
  ): CameraActionReceipt => ({
    action: "key_hold",
    serial,
    status,
    startedAtMonotonicNs,
    endedAtMonotonicNs: deps.monotonicNs().toString(),
    ack: { key, holdMs, ...ack },
    ...(error ? { error } : {}),
  });
  let connectionAttempts = 1;
  if ("error" in connection) {
    const firstError = connection.error;
    await deps.sleep(800);
    connection = deps.getClient(undefined, serial);
    connectionAttempts++;
    if ("error" in connection) {
      return finish("failed", {
        connectionAttempts,
        keydownAttempted: false,
        keydownAcknowledged: false,
        applicationUncertain: false,
        keyupAcknowledged: false,
        releaseCertain: true,
      }, `${firstError}; reconnect failed: ${connection.error}`);
    }
  }

  const original = connection;
  let keydownAcknowledged = false;
  let keyupAcknowledged = false;
  let actionError: unknown = null;
  let releaseError: unknown = null;
  try {
    await deps.unary(original.client, "sendKey", { eventType: "keydown", key }, original.metadata, 6000);
    keydownAcknowledged = true;
    await deps.sleep(holdMs);
  } catch (error) {
    // A transport error can arrive after the guest applied keydown. Never replay the keydown.
    actionError = error;
  } finally {
    // Release is attempted after every keydown RPC invocation, including an unacknowledged one.
    try {
      await deps.unary(original.client, "sendKey", { eventType: "keyup", key }, original.metadata, 6000);
      keyupAcknowledged = true;
    } catch (error) {
      releaseError = error;
    }
  }

  let releaseRecoveredAfterReconnect = false;
  let reboundGrpc: GrpcEndpointBinding | null = null;
  let releaseReconnectBindingMatched: boolean | null = null;
  if (!keyupAcknowledged) {
    const rebound = deps.getClient(undefined, serial);
    connectionAttempts++;
    if (!("error" in rebound)) reboundGrpc = rebound.binding;
    const sameBinding = !("error" in rebound)
      && rebound.binding.discoveryFile === original.binding.discoveryFile
      && rebound.binding.discoveredSerial === original.binding.discoveredSerial
      && rebound.binding.qemuPid === original.binding.qemuPid
      && rebound.binding.address === original.binding.address
      && rebound.binding.tokenPresent === original.binding.tokenPresent
      && rebound.binding.tokenFingerprint === original.binding.tokenFingerprint;
    releaseReconnectBindingMatched = sameBinding;
    if (sameBinding) {
      try {
        await deps.unary(rebound.client, "sendKey", { eventType: "keyup", key }, rebound.metadata, 6000);
        keyupAcknowledged = true;
        releaseRecoveredAfterReconnect = true;
      } catch (error) {
        releaseError = error;
      }
    } else if (!("error" in rebound)) {
      releaseError = new Error("release reconnect changed discovery endpoint identity; refusing to send keyup to a different runtime");
    }
  }

  const applicationUncertain = !keydownAcknowledged;
  const ack = {
    connectionAttempts,
    keydownAttempted: true,
    keydownAcknowledged,
    applicationUncertain,
    keyupAcknowledged,
    releaseCertain: keyupAcknowledged,
    releaseRecoveredAfterReconnect,
    grpc: original.binding,
    reboundGrpc,
    releaseReconnectBindingMatched,
  };
  if (!keyupAcknowledged) {
    const detail = (releaseError as any)?.message ?? String(releaseError ?? actionError ?? "keyup was not acknowledged");
    return finish("release_uncertain", ack, detail);
  }
  if (actionError !== null || applicationUncertain) {
    const detail = (actionError as any)?.message ?? String(actionError ?? "keydown application was not acknowledged");
    return finish("failed", ack, detail);
  }
  return finish("applied", ack);
}

/** Right-button drag via CGEvents (rotation lane). macOS only. */
async function rightDrag(binding: BoundQemuWindow | null, dx: number, dy: number): Promise<string | null> {
  if (process.platform !== "darwin") return "rotation (dragDx/dragDy) requires macOS CGEvents; on this platform use key moves only";
  if (!binding) return "ambiguous_host_window: no serial-bound qemu window is available";
  const swiftPath = path.join(os.tmpdir(), "pico-camera-drive.swift");
  const boundDragSwift = `import CoreGraphics
import Foundation
let a = CommandLine.arguments
let targetWindow = Int(a[1])!, targetPid = Int(a[2])!
let dx = Double(a[3])!, dy = Double(a[4])!
let steps = Int(a[5]) ?? 24, delayMs = Double(a[6]) ?? 14
var cx = 0.0, cy = 0.0, found = false
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let windows = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
  for window in windows {
    let id = window[kCGWindowNumber as String] as? Int
    let pid = window[kCGWindowOwnerPID as String] as? Int
    if id == targetWindow && pid == targetPid {
      let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
      let x = (bounds["X"] as? Double) ?? 0, y = (bounds["Y"] as? Double) ?? 0
      let width = (bounds["Width"] as? Double) ?? 0, height = (bounds["Height"] as? Double) ?? 0
      cx = x + width / 2; cy = y + height / 2; found = width >= 100 && height >= 100
    }
  }
}
if !found { print("BOUND_QEMU_WINDOW_MISSING"); exit(1) }
func post(_ type: CGEventType, _ x: Double, _ y: Double) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .right)?.post(tap: .cghidEventTap)
}
let x2 = cx + dx, y2 = cy + dy
CGWarpMouseCursorPosition(CGPoint(x: cx, y: cy)); usleep(60000)
post(.rightMouseDown, cx, cy); usleep(UInt32(delayMs * 1000))
for i in 1...steps { let t = Double(i) / Double(steps); post(.rightMouseDragged, cx + (x2-cx)*t, cy + (y2-cy)*t); usleep(UInt32(delayMs * 1000)) }
post(.rightMouseUp, x2, y2)
print("ok window=\\(targetWindow) pid=\\(targetPid)")
`;
  fs.writeFileSync(swiftPath, boundDragSwift);
  const r = await run("swift", [swiftPath, String(binding.qemuWindowId), String(binding.qemuWindowOwnerPid), String(dx), String(dy), "24", "14"], { timeoutMs: 30_000 });
  if (r.code !== 0 || /BOUND_QEMU_WINDOW_MISSING/.test(r.stdout)) {
    return `right-drag failed: ${r.stdout || r.stderr}. Emulator window open + Accessibility granted?`;
  }
  return null;
}

const moveSchema = z.object({
  key: z.enum(["w", "a", "s", "d", "q", "e"]).optional()
    .describe("Walk key: w=forward s=back a=left d=right q=down e=up, relative to current facing"),
  holdMs: z.number().int().min(50).max(5000).optional().describe("How long to hold the key (default 600 ms ≈ a large step)"),
  repeat: z.number().int().min(1).max(20).optional().describe("Repeat the hold N times (default 1)"),
  dragDx: z.number().optional().describe("Right-drag pixels: rotation. dx>0 looks right, dx<0 looks left (macOS only)"),
  dragDy: z.number().optional().describe("Right-drag pixels: dy>0 looks down, dy<0 looks up (macOS only)"),
});

export function createCameraActionBindingReceipt(
  serial: string,
  windowBinding: BoundQemuWindow,
): CameraActionBindingReceipt {
  const geometry = [
    windowBinding.qemuWindowX,
    windowBinding.qemuWindowY,
    windowBinding.qemuWindowWidth,
    windowBinding.qemuWindowHeight,
    windowBinding.qemuWindowScale,
  ].every((value) => typeof value === "number" && Number.isFinite(value))
    ? {
        x: windowBinding.qemuWindowX!,
        y: windowBinding.qemuWindowY!,
        width: windowBinding.qemuWindowWidth!,
        height: windowBinding.qemuWindowHeight!,
        scale: windowBinding.qemuWindowScale!,
      }
    : {};
  return {
    serial,
    grpc: {
      discoveryFile: windowBinding.discoveryFile,
      qemuPid: windowBinding.qemuPid,
      address: windowBinding.address,
      ...(windowBinding.tokenFingerprint ? { tokenFingerprint: windowBinding.tokenFingerprint } : {}),
    },
    qemuWindow: {
      ownerPid: windowBinding.qemuWindowOwnerPid,
      windowId: windowBinding.qemuWindowId,
      ...geometry,
    },
    bindingMethod: windowBinding.bindingMethod,
    onlineEmulatorSerials: [...windowBinding.onlineEmulatorSerials],
  };
}

interface BoundCameraActionDependencies {
  focusQemu: typeof frontmostQemu;
  keyHold: typeof keyHold;
  rightDrag: typeof rightDrag;
}

export function createBoundCameraActionAdapter(
  serial: string,
  windowBinding: BoundQemuWindow | null,
  options: Partial<BoundCameraActionDependencies> & {
    revalidateWindow?: () => Promise<QemuWindowBindingResult>;
  } = {},
): { applyRelativeAction(action: RelativeCameraAction): Promise<CameraActionReceipt> } {
  // Revalidation is an optional guard on the chosen action lanes, not a replacement
  // for one of them. Injecting any action lane requires all three action dependencies.
  const { revalidateWindow, ...actionOverrides } = options;
  if ("focusQemu" in options || "keyHold" in options || "rightDrag" in options) {
    Object.assign(actionOverrides, {
      focusQemu: options.focusQemu, keyHold: options.keyHold, rightDrag: options.rightDrag,
    });
  }
  const deps = completeDependencies<BoundCameraActionDependencies>(
    "createBoundCameraActionAdapter", actionOverrides,
    { focusQemu: true, keyHold: true, rightDrag: true },
    () => ({ focusQemu: frontmostQemu, keyHold, rightDrag }),
  );
  const exactBindingMatch = (observed: BoundQemuWindow): boolean => !!windowBinding
    && observed.discoveryFile === windowBinding.discoveryFile
    && observed.discoveredSerial === windowBinding.discoveredSerial
    && observed.qemuPid === windowBinding.qemuPid
    && observed.address === windowBinding.address
    && observed.tokenPresent === windowBinding.tokenPresent
    && (observed.tokenFingerprint ?? null) === (windowBinding.tokenFingerprint ?? null)
    && JSON.stringify(observed.onlineEmulatorSerials) === JSON.stringify(windowBinding.onlineEmulatorSerials)
    && observed.bindingMethod === windowBinding.bindingMethod
    && observed.qemuWindowOwnerPid === windowBinding.qemuWindowOwnerPid
    && observed.qemuWindowId === windowBinding.qemuWindowId
    && observed.qemuWindowX === windowBinding.qemuWindowX
    && observed.qemuWindowY === windowBinding.qemuWindowY
    && observed.qemuWindowWidth === windowBinding.qemuWindowWidth
    && observed.qemuWindowHeight === windowBinding.qemuWindowHeight
    && observed.qemuWindowScale === windowBinding.qemuWindowScale;
  const revalidationFailure = (
    action: RelativeCameraAction,
    observed: QemuWindowBindingResult,
    startedAtMonotonicNs: string,
  ): CameraActionReceipt => {
    const bindingRevalidation = observed.ok
      ? { status: "mismatch" as const, expected: windowBinding, observed: observed.binding }
      : { status: "failed" as const, expected: windowBinding, observed: null, failure: observed };
    const base = {
      action: action.kind,
      serial,
      status: "failed" as const,
      startedAtMonotonicNs,
      endedAtMonotonicNs: process.hrtime.bigint().toString(),
      error: observed.ok
        ? "camera action refused because the freshly observed qemu endpoint/window changed"
        : `camera action refused because qemu endpoint/window revalidation failed: ${observed.detail}`,
    };
    if (action.kind === "key_hold") {
      return {
        ...base,
        ack: {
          key: action.key,
          holdMs: action.holdMs,
          hostWindow: windowBinding,
          connectionAttempts: 0,
          keydownAttempted: false,
          keydownAcknowledged: false,
          applicationUncertain: false,
          keyupAcknowledged: false,
          releaseCertain: true,
          bindingRevalidation,
        },
      };
    }
    return {
      ...base,
      ack: {
        requested: { dragDx: action.dxPx, dragDy: action.dyPx },
        hostWindow: windowBinding,
        cgEventAcknowledged: false,
        hostFocusRequired: true,
        hostFocusAttempted: false,
        focusAcknowledged: false,
        bindingRevalidation,
      },
    };
  };
  return {
    applyRelativeAction: async (action) => {
      const startedAtMonotonicNs = process.hrtime.bigint().toString();
      let revalidatedBinding: BoundQemuWindow | null = null;
      if (revalidateWindow) {
        let observed: QemuWindowBindingResult;
        try {
          observed = await revalidateWindow();
        } catch (error: any) {
          observed = { ok: false, code: "binding_failed", detail: error?.message ?? String(error) };
        }
        if (!observed.ok || !exactBindingMatch(observed.binding)) {
          return revalidationFailure(action, observed, startedAtMonotonicNs);
        }
        revalidatedBinding = observed.binding;
      }
      if (action.kind === "key_hold") {
        const receipt = await deps.keyHold(serial, action.key, action.holdMs);
        receipt.ack.hostWindow = windowBinding;
        if (revalidatedBinding) receipt.ack.bindingRevalidation = { status: "matched", expected: windowBinding, observed: revalidatedBinding };
        receipt.ack.hostFocusRequired = false;
        receipt.ack.hostFocusAttempted = false;
        receipt.ack.focusAcknowledged = false;
        if (receipt.status === "applied") await sleep(150);
        return receipt;
      }
      let focusError: string | null;
      try {
        focusError = await deps.focusQemu(windowBinding);
      } catch (error: any) {
        focusError = `focus verification failed: ${error?.message ?? String(error)}`;
      }
      const err = focusError
        ? `look-drag requires acknowledged bound qemu host focus: ${focusError}`
        : await deps.rightDrag(windowBinding, action.dxPx, action.dyPx);
      const focusAcknowledged = focusError === null;
      return {
        action: "look_drag",
        serial,
        status: err ? "failed" : "applied",
        startedAtMonotonicNs,
        endedAtMonotonicNs: process.hrtime.bigint().toString(),
        ack: {
          requested: { dragDx: action.dxPx, dragDy: action.dyPx },
          cgEventAcknowledged: !err,
          hostFocusRequired: true,
          hostFocusAttempted: true,
          focusAcknowledged,
          hostWindow: windowBinding,
          ...(revalidatedBinding
            ? { bindingRevalidation: { status: "matched", expected: windowBinding, observed: revalidatedBinding } }
            : {}),
        },
        ...(err ? { error: err } : {}),
      };
    },
  };
}

function expandMoves(moves: Array<z.infer<typeof moveSchema>>): RelativeCameraAction[] {
  const actions: RelativeCameraAction[] = [];
  for (const move of moves) {
    if (move.key) {
      if (!KEYCODES[move.key]) continue;
      for (let index = 0; index < (move.repeat ?? 1); index++) {
        actions.push({ kind: "key_hold", key: move.key, holdMs: move.holdMs ?? 600 });
      }
    }
    if (move.dragDx != null || move.dragDy != null) {
      actions.push({ kind: "look_drag", dxPx: move.dragDx ?? 0, dyPx: move.dragDy ?? 0 });
    }
  }
  return actions;
}

async function applyMoves(
  serial: string,
  moves: Array<z.infer<typeof moveSchema>>,
  windowBinding: BoundQemuWindow | null,
): Promise<{ error: string | null; actionReceipts: CameraActionReceipt[] }> {
  if (!windowBinding) return { error: "ambiguous_host_window: no serial-bound qemu window is available", actionReceipts: [] };
  const actions = expandMoves(moves);
  try {
    const actionReceipts = await executeBoundCameraActions(
      createCameraActionBindingReceipt(serial, windowBinding),
      actions,
      createBoundCameraActionAdapter(serial, windowBinding),
    );
    const refused = actionReceipts.find((receipt) =>
      receipt.status !== "applied"
      || (receipt.action === "key_hold" && receipt.ack.releaseCertain !== true));
    return {
      error: refused
        ? refused.error ?? (refused.action === "key_hold" ? `sendKey ${refused.status}` : `${refused.action} ${refused.status}`)
        : null,
      actionReceipts,
    };
  } catch (error: any) {
    return {
      error: error?.message ?? String(error),
      actionReceipts: error instanceof CameraActionExecutionError ? error.retainedReceipts : [],
    };
  }
}

function writeShrunk(buf: Buffer, outPath: string, maxDim: number): Promise<string> {
  const full = expandHome(outPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  const small = full.replace(/\.png$/, ".small.png");
  return run("sips", ["-Z", String(maxDim), full, "--out", small], { timeoutMs: 20_000 }).then((r) =>
    r.code === 0 && fs.existsSync(small) ? small : full,
  );
}

interface CameraDriveDependencies {
  platform: NodeJS.Platform;
  bindWindow: typeof bindMacQemuWindow;
  probeHostWindow: typeof probeHostWindow;
  focus: typeof frontmostQemu;
  applyMoves: typeof applyMoves;
  settleCapture: typeof settleCapture;
  writeShrunk: typeof writeShrunk;
}

export function registerCameraDriveTools(server: McpServer, overrides: Partial<CameraDriveDependencies> = {}) {
  const deps = completeDependencies<CameraDriveDependencies>(
    "registerCameraDriveTools", overrides,
    { platform: true, bindWindow: true, probeHostWindow: true, focus: true, applyMoves: true, settleCapture: true, writeShrunk: true },
    () => ({ platform: process.platform, bindWindow: bindMacQemuWindow, probeHostWindow, focus: frontmostQemu,
      applyMoves, settleCapture, writeShrunk }),
  );
  // Each capture samples its already-bound window once. Early refusals retain honest unknown evidence.
  const observed = (handler: (
    args: any,
    sample: (binding: BoundQemuWindow) => Promise<HostWindowProbe>,
    focus: (binding: BoundQemuWindow) => Promise<string | null>,
  ) => Promise<any>) => async (args: any) => {
    const probes: HostWindowProbe[] = [];
    let focusRequest: Record<string, unknown> | null = null;
    const sample = async (binding: BoundQemuWindow) => {
      let probe: HostWindowProbe;
      try { probe = await deps.probeHostWindow(args.serial ?? "emulator-5554", binding); }
      catch (error: any) { probe = unavailableHostWindowProbe(error?.message ?? String(error), binding); }
      probes.push(probe);
      return probe;
    };
    const focus = async (binding: BoundQemuWindow): Promise<string | null> => {
      const started = process.hrtime.bigint();
      let error: string | null;
      try { error = await deps.focus(binding); }
      catch (cause: any) { error = cause?.message ?? String(cause); }
      focusRequest = {
        status: error ? "failed" : "requested", error,
        qemuWindowId: binding.qemuWindowId, qemuWindowOwnerPid: binding.qemuWindowOwnerPid,
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      };
      return error;
    };
    let result;
    try { result = await handler(args, sample, focus); }
    catch (error: any) { result = fail(error?.message ?? String(error)); }
    const last = probes.at(-1) ?? unavailableHostWindowProbe("camera request ended before a bound-window observation");
    const warnings = probes.map(hostWindowPrecondition).filter((warning) => warning !== null);
    const evidence = {
      hostWindowProbe: last, hostWindowProbes: probes, hostWindowFocusRequest: focusRequest,
      warnings: warnings.filter((warning, i) => warnings.findIndex((w) => w.code === warning.code && w.detail === warning.detail) === i),
    };
    return {
      ...result, structuredContent: { ...result.structuredContent, ...evidence },
      content: [...result.content, { type: "text", text: JSON.stringify(evidence) }],
    };
  };
  server.registerTool(
    "capture_orbit",
    {
      description:
        "DRIVE the emulator free camera (walk keys + look drags), settle, then capture the HMD frame — the primitive that lets an agent verify 3D placement from angles OTHER than the launch-forward view. Moves run in order: {key:'w'|'a'|'s'|'d'|'q'|'e', holdMs?, repeat?} walks (gRPC sendKey; W fwd/S back/A left/D right/Q down/E up relative to facing), {dragDx, dragDy} rotates the view (right-button CGEvent drag). The camera has INERTIA: this tool settle-waits until two consecutive captures are byte-identical before returning. Phase 1 requires the serial-bound macOS qemu-window lane; non-macOS rendered motion remains UNVERIFIED and is refused. LOOK at the returned frame before claiming anything about the scene.",
      inputSchema: {
        moves: z.array(moveSchema).min(1).describe("Sequence of walk/look moves, applied in order"),
        serial: z.string().optional().describe("adb serial (default emulator-5554)"),
        outPath: z.string().optional().describe("Where to write the full-res capture (default /tmp/pico-render/capture_orbit.png)"),
        maxDim: z.number().int().positive().optional().describe("Max dimension of the returned image (default 1200)"),
        capture: z.boolean().optional().describe("Capture + return the frame after moving (default true)"),
      },
    },
    observed(async ({ moves, serial, outPath, maxDim, capture }, sample, focus) => {
      if (deps.platform !== "darwin") {
        return fail(
          "unsupported_backend: non-macOS gRPC key delivery has no measured focus/rendered-camera binding; " +
          "the design register marks that effect UNVERIFIED, so capture_orbit refuses motion on this host",
        );
      }
      const dev = serial ?? "emulator-5554";
      const adb = resolveAdb();
      const selected = await deps.bindWindow(adb, dev);
      if (!selected.ok) return fail(`${selected.code}: ${selected.detail}`);
      const windowBinding = selected.binding;
      const focusErr = await focus(windowBinding);
      if (focusErr && expandMoves(moves).some((action) => action.kind === "look_drag")) {
        await sample(windowBinding);
        return fail(focusErr);
      }
      const moved = await deps.applyMoves(dev, moves, windowBinding);
      if (moved.error) { await sample(windowBinding); return fail(`${moved.error}\nactionReceipts=${JSON.stringify(moved.actionReceipts)}`); }
      if (capture === false) {
        await sample(windowBinding);
        return okJson({ status: "ok", note: "moves applied (no capture requested)", actionReceipts: moved.actionReceipts });
      }
      const settled = await deps.settleCapture(adb, dev);
      const hostWindowAfter = await sample(windowBinding);
      const settleReceipt = {
        status: settled.status,
        attempts: settled.attempts,
        settlementSatisfied: settled.settlementSatisfied,
        sha256: settled.sha256,
        stablePair: settled.stablePair,
        hostWindowProbe: hostWindowAfter,
        hostWindowProbes: [hostWindowAfter],
        warnings: [hostWindowAfter].map(hostWindowPrecondition).filter(Boolean),
      };
      if (!settled.frame) return fail(
        `screencap failed after moves: ${settled.status === "capture_failed" ? settled.detail : "no valid frame"}` +
        `\nsettleReceipt=${JSON.stringify(settleReceipt)}\nactionReceipts=${JSON.stringify(moved.actionReceipts)}`,
      );
      const full = expandHome(outPath ?? "/tmp/pico-render/capture_orbit.png");
      const smallPath = await deps.writeShrunk(settled.frame.bytes, full, maxDim ?? 1200);
      const b64 = fs.readFileSync(smallPath).toString("base64");
      return {
        content: [
          { type: "image" as const, data: b64, mimeType: "image/png" as const },
          {
            type: "text" as const,
            text:
              `Applied ${moves.length} move(s), ${settled.status === "settled" ? "pose settled" : "POSE IS NOT A NAVIGATION WAYPOINT"} -> ${full}. ` +
              `settleReceipt=${JSON.stringify(settleReceipt)} actionReceipts=${JSON.stringify(moved.actionReceipts)}. ` +
              "LOOK at this frame and judge only its visible pixels; call again with more moves only after settlement succeeds.",
          },
        ],
        ...(settled.status === "settled" ? {} : { isError: true }),
      };
    }),
  );

  server.registerTool(
    "capture_multiview",
    {
      description:
        "Capture one scene from FOUR viewpoints in a single call — front (current pose), high-angle (fly up + look down), and two side obliques (strafe + re-aim) — then walk the camera back and report whether the round trip closed. This is the multi-angle visual check that placement work MUST pass: a single forward view cannot verify a 3D layout (two sessions were lost to that). Each leg settle-waits out the free-cam inertia and aborts before further motion if settlement or an action is uncertain. Phase 1 uses the serial-bound macOS qemu-window lane. LOOK at every returned frame: check nothing intersects furniture/walls/rug from ANY of the angles.",
      inputSchema: {
        serial: z.string().optional().describe("adb serial (default emulator-5554)"),
        outDir: z.string().optional().describe("Directory for the four frames (default /tmp/pico-render/multiview)"),
        sideHolds: z.number().int().min(1).max(10).optional().describe("How many 600ms strafe holds per side leg (default 3)"),
        aimSideDrag: z.number().optional().describe("Re-aim drag px toward subject after strafing (default 200)"),
        upHolds: z.number().int().min(1).max(10).optional().describe("How many 600ms up-holds for the high angle (default 2)"),
        aimDownDrag: z.number().optional().describe("Look-down drag px for the high angle (default 260)"),
        maxDim: z.number().int().positive().optional().describe("Max dimension of returned images (default 900)"),
      },
    },
    observed(async ({ serial, outDir, sideHolds, aimSideDrag, upHolds, aimDownDrag, maxDim }, sample, focus) => {
      if (deps.platform !== "darwin") {
        return fail("capture_multiview needs the macOS look-drag lane for its high/oblique aims; use capture_orbit with key moves only on this platform");
      }
      const dev = serial ?? "emulator-5554";
      const dir = expandHome(outDir ?? "/tmp/pico-render/multiview");
      fs.mkdirSync(dir, { recursive: true });
      const side = sideHolds ?? 3;
      const aim = aimSideDrag ?? 200;
      const up = upHolds ?? 2;
      const down = aimDownDrag ?? 260;
      const dim = maxDim ?? 900;
      const adb = resolveAdb();

      const selected = await deps.bindWindow(adb, dev);
      if (!selected.ok) return fail(`${selected.code}: ${selected.detail}`);
      const windowBinding = selected.binding;
      const focusErr = await focus(windowBinding);
      if (focusErr) { await sample(windowBinding); return fail(focusErr); }

      const legs: Array<{ name: string; go: Array<z.infer<typeof moveSchema>>; back: Array<z.infer<typeof moveSchema>> }> = [
        { name: "front", go: [], back: [] },
        {
          name: "high",
          go: [{ key: "e", repeat: up }, { dragDy: down }],
          back: [{ dragDy: -down }, { key: "q", repeat: up }],
        },
        {
          name: "oblique_left",
          go: [{ key: "a", repeat: side }, { dragDx: aim }],
          back: [{ dragDx: -aim }, { key: "d", repeat: side }],
        },
        {
          name: "oblique_right",
          go: [{ key: "d", repeat: side }, { dragDx: -aim }],
          back: [{ dragDx: aim }, { key: "a", repeat: side }],
        },
      ];

      const content: any[] = [];
      const paths: string[] = [];
      const problems: string[] = [];
      const actionReceipts: CameraActionReceipt[] = [];
      const settleReceipts: Array<Record<string, unknown>> = [];
      let frontHash: Buffer | null = null;

      const finishFailure = (detail: string) => {
        problems.push(detail);
        content.push({
          type: "text" as const,
          text:
            `Frames completed before refusal -> ${paths.join(", ") || "none"}. roundTripClosed=false. ` +
            `Problems: ${problems.join("; ")}. settleReceipts=${JSON.stringify(settleReceipts)} ` +
            `actionReceipts=${JSON.stringify(actionReceipts)}. ` +
            "The last unsettled frame, if returned, is not a navigation waypoint. LOOK only at returned pixels.",
        });
        return { content, isError: true };
      };

      for (const leg of legs) {
        if (leg.go.length) {
          const moved = await deps.applyMoves(dev, leg.go, windowBinding);
          actionReceipts.push(...moved.actionReceipts);
          if (moved.error) return finishFailure(`${leg.name}: ${moved.error}`);
        }
        const settled = await deps.settleCapture(adb, dev);
        const hostWindowAfter = await sample(windowBinding);
        const settleReceipt = {
          leg: leg.name,
          status: settled.status,
          attempts: settled.attempts,
          settlementSatisfied: settled.settlementSatisfied,
          sha256: settled.sha256,
          stablePair: settled.stablePair,
          hostWindowProbe: hostWindowAfter,
          hostWindowProbes: [hostWindowAfter],
          warnings: [hostWindowAfter].map(hostWindowPrecondition).filter(Boolean),
        };
        settleReceipts.push(settleReceipt);
        if (!settled.frame) return finishFailure(
          `${leg.name}: ${settled.status === "capture_failed" ? settled.detail : "screencap produced no valid frame"}`,
        );
        const full = path.join(dir, `${leg.name}.png`);
        const smallPath = await deps.writeShrunk(settled.frame.bytes, full, dim);
        paths.push(full);
        content.push({ type: "image" as const, data: fs.readFileSync(smallPath).toString("base64"), mimeType: "image/png" as const });
        if (settled.status !== "settled") {
          return finishFailure(`${leg.name}: ${settled.status}; refusing to use its last frame as a navigation waypoint`);
        }
        if (leg.name === "front") frontHash = settled.frame.bytes;
        if (leg.back.length) {
          const moved = await deps.applyMoves(dev, leg.back, windowBinding);
          actionReceipts.push(...moved.actionReceipts);
          if (moved.error) return finishFailure(`${leg.name} return: ${moved.error}`);
        }
      }

      const final = await deps.settleCapture(adb, dev);
      const hostWindowAfterRestore = await sample(windowBinding);
      settleReceipts.push({
        leg: "restored",
        status: final.status,
        attempts: final.attempts,
        settlementSatisfied: final.settlementSatisfied,
        sha256: final.sha256,
        stablePair: final.stablePair,
        hostWindowProbe: hostWindowAfterRestore,
        hostWindowProbes: [hostWindowAfterRestore],
        warnings: [hostWindowAfterRestore].map(hostWindowPrecondition).filter(Boolean),
      });
      const roundTripClosed = final.status === "settled" && !!(final.frame && frontHash && final.frame.bytes.equals(frontHash));
      if (final.frame) fs.writeFileSync(path.join(dir, "restored.png"), final.frame.bytes);

      content.push({
        type: "text" as const,
        text:
          `Frames (front, high, oblique_left, oblique_right) -> ${paths.join(", ")}. ` +
          `roundTripClosed=${roundTripClosed}${roundTripClosed ? "" : " (free-cam inertia drifts; the camera is NEAR but not exactly at the start pose)"}. ` +
          (problems.length ? `Problems: ${problems.join("; ")}. ` : "") +
          `settleReceipts=${JSON.stringify(settleReceipts)} actionReceipts=${JSON.stringify(actionReceipts)}. ` +
          "LOOK at every frame: verify from EACH angle that content sits where it should and intersects nothing.",
      });
      return { content, ...(roundTripClosed ? {} : { isError: true }) };
    }),
  );
}
