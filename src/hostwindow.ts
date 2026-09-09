import type { BoundQemuWindow } from "./cameradrive.js";
import { run } from "./util.js";

type WindowBinding = Pick<BoundQemuWindow, "qemuWindowId" | "qemuWindowOwnerPid">;

export interface HostWindowProbe {
  status: "ok" | "no_window" | "unavailable" | "not_applicable";
  occluded: boolean | null;
  frontmost: boolean | null;
  overlappingOwners: string[];
  observedAt: string;
  durationMs: number;
  qemuWindowId: number | null;
  qemuWindowOwnerPid: number | null;
  detail: string | null;
}

interface HostWindow {
  windowId: number;
  ownerPid: number;
  ownerName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  alpha?: number;
  layer: number;
}

export function unavailableHostWindowProbe(detail: string, binding?: WindowBinding): HostWindowProbe {
  return {
    status: "unavailable", occluded: null, frontmost: null, overlappingOwners: [],
    observedAt: new Date().toISOString(), durationMs: 0, qemuWindowId: binding?.qemuWindowId ?? null,
    qemuWindowOwnerPid: binding?.qemuWindowOwnerPid ?? null, detail,
  };
}

/** CoreGraphics supplies the on-screen windows in front-to-back order, in points. */
export function evaluateHostWindowOcclusion(
  binding: WindowBinding,
  snapshot: { windows: HostWindow[]; frontmostOwnerPid: number },
): HostWindowProbe {
  const base = unavailableHostWindowProbe("bound qemu window is absent from the on-screen window list", binding);
  const index = snapshot.windows.findIndex((w) => w.windowId === binding.qemuWindowId && w.ownerPid === binding.qemuWindowOwnerPid);
  if (index < 0) return { ...base, status: "no_window", frontmost: false };
  const target = snapshot.windows[index];
  const validRect = (w: HostWindow) => [w.x, w.y, w.width, w.height].every(Number.isFinite) && w.width > 0 && w.height > 0;
  const alpha = (w: HostWindow) => typeof w.alpha === "number" && Number.isFinite(w.alpha) && w.alpha >= 0 ? w.alpha : 1;
  if (!validRect(target) || alpha(target) === 0) {
    return { ...base, detail: "bound qemu window has no visible valid rectangle" };
  }
  const owners = new Set<string>();
  for (const w of snapshot.windows.slice(0, index)) {
    if (w.layer !== 0 || w.ownerPid === binding.qemuWindowOwnerPid || !validRect(w) || alpha(w) === 0) continue;
    if (w.x < target.x + target.width && w.x + w.width > target.x
      && w.y < target.y + target.height && w.y + w.height > target.y) {
      owners.add(w.ownerName?.trim() || `PID ${w.ownerPid}`);
    }
  }
  return {
    ...base, status: "ok", occluded: owners.size > 0,
    frontmost: snapshot.frontmostOwnerPid === binding.qemuWindowOwnerPid,
    overlappingOwners: [...owners], detail: null,
  };
}

export function hostWindowPrecondition(probe: HostWindowProbe): {
  code: "host_window_occluded" | "host_window_unavailable"; detail: string;
} | null {
  if (probe.status === "ok" && probe.occluded === false || probe.status === "not_applicable") return null;
  return probe.occluded === true
    ? { code: "host_window_occluded", detail: `bound qemu window is occluded by: ${probe.overlappingOwners.join(", ") || "unknown owner"}` }
    : { code: "host_window_unavailable", detail: probe.detail ?? "bound qemu window visibility could not be established" };
}

const WINDOW_SNAPSHOT_SWIFT = `import AppKit
import CoreGraphics
guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
  fputs("CoreGraphics on-screen window enumeration failed", stderr)
  exit(1)
}
let windows = raw.map { w -> [String: Any] in
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  return ["windowId": w[kCGWindowNumber as String] ?? -1, "ownerPid": w[kCGWindowOwnerPID as String] ?? -1,
    "ownerName": w[kCGWindowOwnerName as String] ?? "", "alpha": w[kCGWindowAlpha as String] ?? 1,
    "layer": w[kCGWindowLayer as String] ?? -1,
    "x": b["X"] ?? NSNull(), "y": b["Y"] ?? NSNull(), "width": b["Width"] ?? NSNull(), "height": b["Height"] ?? NSNull()]
}
let result: [String: Any] = ["windows": windows, "frontmostOwnerPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0]
print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`;

/** Read-only: never activates, raises, resizes, or moves a host window. */
export async function probeHostWindow(serial: string, binding?: BoundQemuWindow): Promise<HostWindowProbe> {
  const started = process.hrtime.bigint();
  const timed = (probe: HostWindowProbe): HostWindowProbe => ({
    ...probe, durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
  });
  if (process.platform !== "darwin") {
    return timed({ ...unavailableHostWindowProbe("CoreGraphics host visibility is not applicable on this host", binding), status: "not_applicable" });
  }
  if (!serial.startsWith("emulator-")) {
    return timed({ ...unavailableHostWindowProbe("target has no emulator host window"), status: "not_applicable" });
  }
  if (!binding) return timed(unavailableHostWindowProbe("an already-bound qemu window is required for host observation"));
  try {
    if (binding.discoveredSerial !== serial) return timed(unavailableHostWindowProbe("qemu window binding belongs to another serial", binding));
    const result = await run("swift", ["-e", WINDOW_SNAPSHOT_SWIFT], { timeoutMs: 15_000 });
    if (result.code !== 0 || result.timedOut) return timed(unavailableHostWindowProbe(`CoreGraphics probe failed: ${result.stderr || result.stdout}`, binding));
    const snapshot = JSON.parse(result.stdout);
    if (!Array.isArray(snapshot.windows) || !Number.isSafeInteger(snapshot.frontmostOwnerPid)) {
      return timed(unavailableHostWindowProbe("CoreGraphics probe returned a malformed snapshot", binding));
    }
    return timed(evaluateHostWindowOcclusion(binding, snapshot));
  } catch (error: any) {
    return timed(unavailableHostWindowProbe(error?.message ?? String(error), binding));
  }
}
