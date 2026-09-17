// Bring the running emulator process to the front (activation only: no move, resize or input).
import AppKit
import Foundation
let pid = pid_t(CommandLine.arguments.count > 1 ? Int32(CommandLine.arguments[1]) ?? 0 : 0)
guard pid > 0, let app = NSRunningApplication(processIdentifier: pid) else { print("{\"ok\":false,\"reason\":\"no such pid\"}"); exit(2) }
let before = NSWorkspace.shared.frontmostApplication?.localizedName ?? "none"
let ok = app.activate(options: [.activateIgnoringOtherApps])
Thread.sleep(forTimeInterval: 1.0)
let after = NSWorkspace.shared.frontmostApplication?.localizedName ?? "none"
print("{\"ok\":\(ok),\"pid\":\(pid),\"frontmostBefore\":\"\(before)\",\"frontmostAfter1s\":\"\(after)\",\"isActive\":\(app.isActive)}")
