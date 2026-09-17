import Foundation
import AppKit
import CoreGraphics
import ApplicationServices

// Owned diagnostic pointer move only (no button event). Never activates, drags, moves or resizes a host window.
guard CommandLine.arguments.count == 3,
      let x = Double(CommandLine.arguments[1]), let y = Double(CommandLine.arguments[2]),
      x.isFinite, y.isFinite else { fatalError("Expected finite host x y") }
guard AXIsProcessTrusted() else { fatalError("Accessibility is not granted; no input sent") }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
guard let target = windows.first(where: {
    ($0[kCGWindowOwnerName as String] as? String) == "qemu-system-aarch64" &&
    ($0[kCGWindowName as String] as? String) == "PICO Emulator - 6.1.0"
}), let pid = target[kCGWindowOwnerPID as String] as? Int,
      NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid),
      let bounds = target[kCGWindowBounds as String] as? [String: Double],
      let bx = bounds["X"], let by = bounds["Y"],
      let width = bounds["Width"], let height = bounds["Height"],
      x > bx + 44, x < bx + width - 44, y > by + 44, y < by + height - 44
else { fatalError("Target must be frontmost and click inside emulator content") }
let point = CGPoint(x: x, y: y)
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: 0.15)

print("{\"x\":\(x),\"y\":\(y),\"targetPid\":\(pid),\"input\":\"move only\",\"effectVerified\":false}")
