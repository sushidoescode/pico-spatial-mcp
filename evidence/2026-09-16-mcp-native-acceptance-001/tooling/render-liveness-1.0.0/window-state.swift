import AppKit
import CoreGraphics
import Foundation

func rect(_ window: [String: Any]) -> CGRect {
    let b = window[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
}
func isSystemCursor(_ window: [String: Any]) -> Bool {
    let bounds = rect(window)
    return (window[kCGWindowOwnerName as String] as? String) == "Window Server" &&
        (window[kCGWindowName as String] as? String) == "Cursor" &&
        (window[kCGWindowLayer as String] as? Int) == Int(CGWindowLevelForKey(.cursorWindow)) &&
        bounds.origin.x.isFinite && bounds.origin.y.isFinite && bounds.width.isFinite && bounds.height.isFinite &&
        bounds.width > 0 && bounds.height > 0 && bounds.width <= 64 && bounds.height <= 64
}
// Offline regression cases: no window enumeration or emulator input in this mode.
if CommandLine.arguments.contains("--self-test-cursor") {
    let cursor: [String: Any] = [kCGWindowOwnerName as String: "Window Server",
        kCGWindowName as String: "Cursor", kCGWindowLayer as String: Int(CGWindowLevelForKey(.cursorWindow)),
        kCGWindowBounds as String: ["X": CGFloat(706), "Y": CGFloat(982), "Width": CGFloat(28), "Height": CGFloat(40)]]
    var app = cursor; app[kCGWindowOwnerName as String] = "Code"
    var lock = cursor; lock[kCGWindowName as String] = "Lock Screen"
    var ordinary = cursor; ordinary[kCGWindowLayer as String] = 0
    var giant = cursor; giant[kCGWindowBounds as String] = ["Width": CGFloat(1728), "Height": CGFloat(1117)]
    var untitled = cursor; untitled.removeValue(forKey: kCGWindowName as String)
    let rows: [[String: Any]] = [("observed system pointer", cursor, true), ("foreign app named Cursor", app, false),
        ("lock screen", lock, false), ("ordinary window layer", ordinary, false), ("display-size surface", giant, false),
        ("untitled Window Server surface", untitled, false)].map { label, window, expected in
            ["case": label, "expectedCursor": expected, "actualCursor": isSystemCursor(window), "passed": isSystemCursor(window) == expected]
        }
    let passed = rows.allSatisfy { $0["passed"] as? Bool == true }
    let data = try JSONSerialization.data(withJSONObject: ["cursorWindowLevel": CGWindowLevelForKey(.cursorWindow), "cases": rows, "passed": passed], options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(passed ? 0 : 1)
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
func summary(_ window: [String: Any]) -> [String: Any] {
    return ["id": window[kCGWindowNumber as String] ?? 0, "pid": window[kCGWindowOwnerPID as String] ?? 0,
            "owner": window[kCGWindowOwnerName as String] ?? "", "title": window[kCGWindowName as String] ?? "",
            "bounds": window[kCGWindowBounds as String] ?? [:], "layer": window[kCGWindowLayer as String] ?? 0,
            "alpha": window[kCGWindowAlpha as String] ?? 0]
}
let front = NSWorkspace.shared.frontmostApplication
let candidates = windows.enumerated().filter { _, w in
    (w[kCGWindowOwnerName as String] as? String ?? "").contains("qemu-system-aarch64") &&
    (w[kCGWindowName as String] as? String ?? "") == "PICO Emulator - 6.1.0"
}
var result: [String: Any] = ["capturedAt": ISO8601DateFormatter().string(from: Date()),
    "frontmostPid": front?.processIdentifier ?? 0, "frontmostName": front?.localizedName ?? "",
    "targetFound": !candidates.isEmpty, "method": "Read-only CGWindowList front-to-back intersection and NSWorkspace frontmost PID. Does not move, resize or activate any window."]
if let (index, target) = candidates.first {
    let targetRect = rect(target)
    let overlaps = windows.prefix(index).filter { window in
        let area = rect(window).intersection(targetRect)
        return (window[kCGWindowAlpha as String] as? Double ?? 1) > 0 && !area.isNull && area.width > 0 && area.height > 0
    }
    let targetPid = target[kCGWindowOwnerPID as String] as? Int32
    // Dock owns a display-sized WindowServer surface whose rectangle includes transparent space.
    // Keep it visible in the evidence, but don't mistake its bounding box for an opaque app window.
    let dockSurfaces = overlaps.filter { window in
        (window[kCGWindowOwnerName as String] as? String) == "Dock" &&
        (window[kCGWindowName as String] as? String) == "Dock" &&
        (window[kCGWindowLayer as String] as? Int) == 20 && rect(window).contains(targetRect)
    }
    let dockIds = Set(dockSurfaces.compactMap { $0[kCGWindowNumber as String] as? Int })
    let cursorSurfaces = overlaps.filter(isSystemCursor)
    let blockers = overlaps.filter { ($0[kCGWindowOwnerPID as String] as? Int32) != targetPid && !dockIds.contains($0[kCGWindowNumber as String] as? Int ?? -1) && !isSystemCursor($0) }
    let frontmost = targetPid == front?.processIdentifier
    result["target"] = summary(target)
    result["targetZIndex"] = index
    result["frontmost"] = frontmost
    result["occludingWindows"] = blockers.map(summary)
    result["ownedOverlays"] = overlaps.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == targetPid }.map(summary)
    result["ownedOverlayPolicy"] = "The emulator's own child toolbar windows are retained separately; foreign overlapping windows fail this gate."
    result["dockSystemSurfaces"] = dockSurfaces.map(summary)
    result["dockPolicy"] = "Display-sized Dock surface bounds do not establish opaque coverage. This structural app-window check must be paired with the required compositor sample."
    result["systemCursorSurfaces"] = cursorSurfaces.map(summary)
    result["systemCursorPolicy"] = "Only a Window Server surface titled Cursor at the native cursor level with positive bounds no larger than 64x64 is classified as the pointer. It remains retained here. Other foreign windows and unknown system surfaces still fail."
    result["unoccluded"] = blockers.isEmpty
    result["pass"] = frontmost && blockers.isEmpty && targetRect.width > 0 && targetRect.height > 0
} else {
    result["pass"] = false
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8)!)
