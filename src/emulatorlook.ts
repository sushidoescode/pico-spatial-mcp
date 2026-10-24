import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, runBinary, image, fail, expandHome } from "./util.js";
import { adbExecutable } from "./adb.js";
import { observationCapturePath } from "./capturepaths.js";

/**
 * emulator_look — AIM the emulator's free camera, then capture, so an agent can VISUALLY verify a
 * WHOLE scene (not just the forward view). Cracked 2026-06-15: the emulator enters look/orbit mode
 * on a RIGHT-button mouse DRAG on the GL surface — keystrokes do nothing and a left-drag doesn't
 * rotate, but a CGEvent right-drag does (verified by vision: the room rotated to reveal new content).
 *
 * Posts a real CGEvent drag from the qemu window's center by (dx, dy), then `adb screencap` +
 * returns the image. Requires the controlling process to have macOS Accessibility (AXIsProcessTrusted).
 */

/** THE shared adb lookup (src/adb.ts): explicit $PICO_ADB -> PATH -> the SELECTED toolchain's
 *  bundled platform-tools, identity-keyed so a replaced adb is observed without a restart. */
export function resolveAdb(): string {
  return adbExecutable();
}

// Finds the largest qemu window and posts a button-drag from its center by (dx,dy).
export const DRAG_SWIFT = `import CoreGraphics
import Foundation
let a = CommandLine.arguments            // button dx dy steps delayMs
let button = a[1]
let dx = Double(a[2])!, dy = Double(a[3])!
let steps = Int(a[4]) ?? 24
let delayMs = Double(a[5]) ?? 14
var cx = 0.0, cy = 0.0, area = 0.0
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let wl = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
  for w in wl {
    if (w[kCGWindowOwnerName as String] as? String) == "qemu-system-aarch64" {
      let b = w[kCGWindowBounds as String] as? [String:Any] ?? [:]
      let x = (b["X"] as? Double) ?? 0, y = (b["Y"] as? Double) ?? 0
      let ww = (b["Width"] as? Double) ?? 0, hh = (b["Height"] as? Double) ?? 0
      if ww*hh > area { area = ww*hh; cx = x+ww/2; cy = y+hh/2 }
    }
  }
}
if area == 0 { print("NO_QEMU_WINDOW"); exit(1) }
let (downT,dragT,upT,mb): (CGEventType,CGEventType,CGEventType,CGMouseButton)
switch button {
case "right":  (downT,dragT,upT,mb) = (.rightMouseDown,.rightMouseDragged,.rightMouseUp,.right)
case "middle": (downT,dragT,upT,mb) = (.otherMouseDown,.otherMouseDragged,.otherMouseUp,.center)
default:       (downT,dragT,upT,mb) = (.leftMouseDown,.leftMouseDragged,.leftMouseUp,.left)
}
func post(_ t: CGEventType, _ x: Double, _ y: Double) {
  CGEvent(mouseEventSource:nil, mouseType:t, mouseCursorPosition:CGPoint(x:x,y:y), mouseButton:mb)?.post(tap:.cghidEventTap)
}
let x1=cx, y1=cy, x2=cx+dx, y2=cy+dy
CGWarpMouseCursorPosition(CGPoint(x:x1,y:y1)); usleep(60000)
post(downT,x1,y1); usleep(UInt32(delayMs*1000))
for i in 1...steps { let t=Double(i)/Double(steps); post(dragT, x1+(x2-x1)*t, y1+(y2-y1)*t); usleep(UInt32(delayMs*1000)) }
post(upT,x2,y2)
print("ok center=(\\(Int(cx)),\\(Int(cy))) drag->(\\(Int(x2)),\\(Int(y2)))")
`;

export function registerEmulatorLookTools(server: McpServer) {
  server.registerTool(
    "emulator_look",
    {
      description:
        "AIM the emulator's free camera by a mouse-drag, then capture the rendered frame and return the image — so you can VISUALLY verify a whole scene, not just the forward view. The emulator only enters look/orbit mode on a RIGHT-button drag (keystrokes/left-drag do nothing). dx<0 looks left, dx>0 looks right; dy pans vertically. A ~300px horizontal drag is a sizeable yaw; call repeatedly to sweep around. Requires macOS Accessibility for the controlling process. Pairs with capture_frame (which captures without moving). The frame is saved to a run-unique RETAINED file under the observation root, never a fixed shared path a later look can overwrite; the default TARGET is unchanged (emulator-5554).",
      inputSchema: {
        dx: z.number().describe("Horizontal drag pixels from window center (negative = look left, positive = look right). ~300 ≈ a big yaw."),
        dy: z.number().optional().describe("Vertical drag pixels (default 0). negative = up, positive = down."),
        button: z.enum(["right", "middle", "left"]).optional().describe("Mouse button for the drag (default 'right' — the one that orbits)."),
        steps: z.number().int().positive().optional().describe("Interpolation steps for the drag (default 24)."),
        serial: z.string().optional().describe("adb device serial (default emulator-5554)."),
        capture: z.boolean().optional().describe("Capture + return the frame after moving (default true)."),
      },
    },
    async ({ dx, dy, button, steps, serial, capture }) => {
      const dev = serial ?? "emulator-5554";
      // focus the emulator window
      await run("osascript", ["-e", 'tell application "System Events" to set frontmost of (first process whose name contains "qemu") to true'], { timeoutMs: 5000 });
      const swiftPath = path.join(os.tmpdir(), "pico-emulator-look.swift");
      fs.writeFileSync(swiftPath, DRAG_SWIFT);
      const drag = await run("swift", [swiftPath, button ?? "right", String(dx), String(dy ?? 0), String(steps ?? 24), "14"], { timeoutMs: 30_000 });
      if (drag.code !== 0 || /NO_QEMU_WINDOW/.test(drag.stdout)) {
        return fail(`drag failed: ${drag.stdout || drag.stderr}. Is the emulator window open + the process Accessibility-trusted?`);
      }
      if (capture === false) return { content: [{ type: "text", text: `Looked (${drag.stdout.trim()}). Call capture_frame to see.` }] };

      await new Promise((r) => setTimeout(r, 800)); // settle
      const adb = resolveAdb();
      const full = expandHome(observationCapturePath("emulator-look", "emulator_look.png"));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const res = await runBinary(adb, ["-s", dev, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      if (res.code !== 0 || res.stdout.length < 1000) return fail(`screencap failed after look (code ${res.code}).`);
      fs.writeFileSync(full, res.stdout);
      const small = full.replace(/\.png$/, ".small.png");
      const sip = await run("sips", ["-Z", "1100", full, "--out", small], { timeoutMs: 20_000 });
      const b64 = fs.readFileSync(sip.code === 0 && fs.existsSync(small) ? small : full).toString("base64");
      return image(b64, `Looked (${drag.stdout.trim()}) then captured -> ${full}. LOOK at this and judge what the rotated view reveals. Call again with a different dx to keep sweeping.`);
    },
  );
}
