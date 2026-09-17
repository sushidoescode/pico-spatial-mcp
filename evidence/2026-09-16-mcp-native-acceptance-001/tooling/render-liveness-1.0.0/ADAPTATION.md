# Adaptation of the copied render-liveness/1.0.0 host helpers (2026-09-16)

One string changed, nothing else: the qemu window title the helpers key on, 'PICO Emulator - 6.0.0' -> 'PICO Emulator - 6.1.0' (the running 6.1 emulator's title, read-only CGWindowList evidence). Thresholds, checks, package targeting and refusal logic are byte-identical to the originals in PROVENANCE.sha256. runtime_gate.py's legacy 'gate' mode (hardcoded emulator-5554 + superseded SPR threshold) is NOT used; only its 'raise' mode is.

```diff
--- window-state.swift.orig	2026-09-09 22:12:35
+++ window-state.swift	2026-09-16 14:45:22
@@ -44,7 +44,7 @@
 let front = NSWorkspace.shared.frontmostApplication
 let candidates = windows.enumerated().filter { _, w in
     (w[kCGWindowOwnerName as String] as? String ?? "").contains("qemu-system-aarch64") &&
-    (w[kCGWindowName as String] as? String ?? "") == "PICO Emulator - 6.0.0"
+    (w[kCGWindowName as String] as? String ?? "") == "PICO Emulator - 6.1.0"
 }
 var result: [String: Any] = ["capturedAt": ISO8601DateFormatter().string(from: Date()),
     "frontmostPid": front?.processIdentifier ?? 0, "frontmostName": front?.localizedName ?? "",
--- host-move.swift.orig	2026-09-11 23:09:15
+++ host-move.swift	2026-09-16 14:45:22
@@ -11,7 +11,7 @@
 let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
 guard let target = windows.first(where: {
     ($0[kCGWindowOwnerName as String] as? String) == "qemu-system-aarch64" &&
-    ($0[kCGWindowName as String] as? String) == "PICO Emulator - 6.0.0"
+    ($0[kCGWindowName as String] as? String) == "PICO Emulator - 6.1.0"
 }), let pid = target[kCGWindowOwnerPID as String] as? Int,
       NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid),
       let bounds = target[kCGWindowBounds as String] as? [String: Double],
--- host-click.swift.orig	2026-09-09 22:12:35
+++ host-click.swift	2026-09-16 14:45:22
@@ -11,7 +11,7 @@
 let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
 guard let target = windows.first(where: {
     ($0[kCGWindowOwnerName as String] as? String) == "qemu-system-aarch64" &&
-    ($0[kCGWindowName as String] as? String) == "PICO Emulator - 6.0.0"
+    ($0[kCGWindowName as String] as? String) == "PICO Emulator - 6.1.0"
 }), let pid = target[kCGWindowOwnerPID as String] as? Int,
       NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid),
       let bounds = target[kCGWindowBounds as String] as? [String: Double],
--- runtime_gate.py.orig	2026-09-09 22:12:35
+++ runtime_gate.py	2026-09-16 14:45:22
@@ -71,7 +71,7 @@
     sys.exit(0 if value['pass'] else 1)
 elif mode == 'raise':
     # Both permitted operations are attempted; failure never bypasses the ten-second wait.
-    result = run(['osascript', '-e', 'tell application "System Events" to tell process "qemu-system-aarch64" to perform action "AXRaise" of window "PICO Emulator - 6.0.0"', '-e', 'tell application "System Events" to set frontmost of process "qemu-system-aarch64" to true'])
+    result = run(['osascript', '-e', 'tell application "System Events" to tell process "qemu-system-aarch64" to perform action "AXRaise" of window "PICO Emulator - 6.1.0"', '-e', 'tell application "System Events" to set frontmost of process "qemu-system-aarch64" to true'])
     save(name + '.json', result)
     if result['exit'] != 0:
         front = run(['osascript', '-e', 'tell application "System Events" to set frontmost of process "qemu-system-aarch64" to true'])
```

## Adapted-file sha256
96e8d462274e64d96d0e52d4ba232ed845ae1e2a2050428fcab4a497a16d2529  window-state.swift
54623180145c051c79d9d1fb13e7b0f84ba5691cbe1809a6dc59abf2ffbd0914  host-move.swift
af4eb3f03512c098dee08d0d3a7aa38f8c87c7543959dde82b3eadf2b9160aaf  host-click.swift
ddcbbcbb0bb6242654de4737169422379f6f20ebe9716cd13d76df682e4ba1e1  runtime_gate.py
