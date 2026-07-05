import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, image, ok, okJson, run, runBinary } from "./util.js";

/**
 * Host-GUI frontier (macOS only). The PICO emulator composites the immersive 3D
 * headset view in its GUI window via the host GPU — that view is NOT in the
 * guest framebuffer (adb/gRPC screenshots miss it). This module enumerates and
 * captures the emulator's actual window, and can drive its WASD camera mode
 * (the only path to move the head, which has no gRPC/console entry point).
 *
 * Requires one-time macOS permissions for the process running this server:
 *   - Screen Recording  -> for window capture (System Settings > Privacy & Security)
 *   - Accessibility     -> for sending keystrokes
 * The tools detect when a permission is missing and return setup instructions.
 */

const EMU_OWNER = "qemu-system-aarch64";

interface Win {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Enumerate the emulator's on-screen windows via CoreGraphics (Swift one-liner). */
function listEmulatorWindows(): Win[] {
  const swift = `
import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let wl = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
  for w in wl {
    let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
    if owner == "${EMU_OWNER}" {
      let wid = (w[kCGWindowNumber as String] as? Int) ?? 0
      let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
      print("\\(wid) \\(Int((b["X"] as? Double) ?? 0)) \\(Int((b["Y"] as? Double) ?? 0)) \\(Int((b["Width"] as? Double) ?? 0)) \\(Int((b["Height"] as? Double) ?? 0))")
    }
  }
}`;
  const tmp = path.join(os.tmpdir(), `pico-winlist-${process.pid}.swift`);
  fs.writeFileSync(tmp, swift);
  try {
    const out = execFileSync("swift", [tmp], { timeout: 60_000, encoding: "utf8" });
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.trim().split(/\s+/).map(Number))
      .map(([id, x, y, w, h]) => ({ id, x, y, w, h }))
      .filter((win) => win.w > 0 && win.h > 0);
  } catch (e: any) {
    throw new Error(`window enumeration failed (is Xcode CLT installed? 'swift' on PATH?): ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** The main display window is the largest by area. */
function mainWindow(wins: Win[]): Win | null {
  if (!wins.length) return null;
  return [...wins].sort((a, b) => b.w * b.h - a.w * a.h)[0];
}

const PERM_HINT =
  "Grant Screen Recording to the app running this server (Terminal/iTerm/your IDE) in System Settings > Privacy & Security > Screen Recording, then fully restart that app.";

export function registerHostGuiTools(server: McpServer) {
  if (process.platform !== "darwin") {
    // Register a single stub so the tool name exists but explains the platform limit.
    server.registerTool(
      "gui_capture",
      { description: "Host-GUI capture is macOS-only; this server is running on a non-macOS host.", inputSchema: {} },
      async () => fail(`gui_capture requires macOS (host is ${process.platform}).`),
    );
    return;
  }

  server.registerTool(
    "gui_find_window",
    {
      description:
        "Enumerate the PICO emulator's on-screen GUI windows (CoreGraphics). Returns window ids + bounds; the largest is the main 3D display. Use this to confirm the emulator GUI is visible before gui_capture / gui_camera.",
      inputSchema: {},
    },
    async () => {
      try {
        const wins = listEmulatorWindows();
        if (!wins.length) return fail("No emulator GUI window found. Is the emulator running WITHOUT -no-window, and not minimized?");
        return okJson({ windows: wins, main: mainWindow(wins) });
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );

  server.registerTool(
    "gui_capture",
    {
      description:
        "Capture the PICO emulator's GUI free-cam window. NOTE: this is the FREE-CAMERA view, which DRIFTS across launches (C2 orbit drift). For deterministic visual verification use capture_frame / capture_canonical (adb screencap = the composited immersive forward view, byte-deterministic, ledger-bindable — the ground-truth path). Use gui_capture only when you need the free-cam angle (e.g. to sweep for a dock panel). Tries window-id capture, falls back to screen-region capture. Requires macOS Screen Recording permission; returns setup instructions if denied.",
      inputSchema: {
        windowId: z.number().int().optional().describe("Specific window id (default: the main/largest emulator window)"),
        mode: z.enum(["window", "region", "auto"]).default("auto").describe("window=by id, region=by screen bounds, auto=window then region"),
      },
    },
    async ({ windowId, mode }) => {
      let wins: Win[];
      try {
        wins = listEmulatorWindows();
      } catch (e: any) {
        return fail(e.message);
      }
      const target = windowId ? wins.find((w) => w.id === windowId) : mainWindow(wins);
      if (!target) return fail(`No emulator window${windowId ? ` with id ${windowId}` : ""} found.`);

      const out = path.join(os.tmpdir(), "pico-mcp", `gui-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });

      const attempts: Array<{ how: string; args: string[] }> = [];
      if (mode === "window" || mode === "auto") attempts.push({ how: "window-id", args: ["-o", "-x", `-l${target.id}`, out] });
      if (mode === "region" || mode === "auto")
        attempts.push({ how: "region", args: ["-o", "-x", `-R${target.x},${target.y},${target.w},${target.h}`, out] });

      let lastErr = "";
      for (const a of attempts) {
        const r = await run("screencapture", a.args, { timeoutMs: 30_000 });
        if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000) {
          const bytes = fs.readFileSync(out);
          return image(bytes.toString("base64"), `Emulator GUI capture (${a.how}, window ${target.id}, ${target.w}x${target.h}, ${bytes.length} bytes). This is the host-composited 3D view.`);
        }
        lastErr = (r.stderr || r.stdout || "").trim();
        if (fs.existsSync(out)) try { fs.unlinkSync(out); } catch {}
      }
      if (/could not create image|not authorized|permission/i.test(lastErr) || !lastErr) {
        return fail(`Screen capture failed — likely missing Screen Recording permission.\n${PERM_HINT}\nRaw: ${lastErr || "(no output)"}`);
      }
      return fail(`screencapture failed: ${lastErr}`);
    },
  );

  server.registerTool(
    "gui_camera",
    {
      description:
        "Drive the emulator's WASD camera mode by sending keystrokes to its GUI window (the ONLY way to move the head/camera — gRPC head-pose is gated). Sends a sequence of keys (W/A/S/D move, Q/E up/down, arrows look). Requires macOS Accessibility permission AND that you have FIRST clicked into the emulator window to enter camera mode (mouse-drag enters it; keystrokes alone may not). Verify the result with gui_capture.",
      inputSchema: {
        keys: z.array(z.string()).describe("Keys to press in order, e.g. ['w','w','a','d']. Single chars; 'left'/'right'/'up'/'down' for arrows."),
        holdMs: z.number().int().default(120).describe("Approx press duration per key (via repeated keystrokes)"),
      },
    },
    async ({ keys, holdMs }) => {
      const arrowCode: Record<string, number> = { left: 123, right: 124, down: 125, up: 126 };
      const lines = ['tell application "System Events"', `  set frontmost of (first process whose name is "${EMU_OWNER}") to true`, "  delay 0.3"];
      const reps = Math.max(1, Math.round(holdMs / 60));
      for (const k of keys) {
        const lk = k.toLowerCase();
        for (let i = 0; i < reps; i++) {
          if (arrowCode[lk] != null) lines.push(`  key code ${arrowCode[lk]}`);
          else lines.push(`  keystroke "${lk.replace(/"/g, '\\"')}"`);
        }
      }
      lines.push("end tell");
      const r = await run("osascript", ["-e", lines.join("\n")], { timeoutMs: 30_000 });
      if (r.code !== 0) {
        const denied = /not allowed|assistive|accessibility|-1719|osascript is not allowed/i.test(r.stderr);
        return fail(
          denied
            ? `Keystroke injection denied — grant Accessibility permission to the app running this server in System Settings > Privacy & Security > Accessibility, then restart it.\nRaw: ${r.stderr.trim()}`
            : `osascript failed: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
      return ok(`Sent ${keys.length} key(s) to the emulator window: ${keys.join(" ")}. Verify with gui_capture. (If nothing moved, click+drag inside the window first to enter camera mode.)`);
    },
  );

  server.registerTool(
    "gui_permissions",
    {
      description: "Check whether this process has the macOS permissions needed for host-GUI capture (Screen Recording) and input (Accessibility), and how to grant them.",
      inputSchema: {},
    },
    async () => {
      const probe = path.join(os.tmpdir(), `pico-perm-${Date.now()}.png`);
      const cap = await runBinary("screencapture", ["-o", "-x", "-t", "png", "-R0,0,8,8", probe], { timeoutMs: 15_000 });
      const screenOk = cap.code === 0 && fs.existsSync(probe) && fs.statSync(probe).size > 100;
      if (fs.existsSync(probe)) try { fs.unlinkSync(probe); } catch {}
      const ax = await run("osascript", ["-e", 'tell application "System Events" to return name of first process'], { timeoutMs: 10_000 });
      const axOk = ax.code === 0;
      return okJson({
        screenRecording: screenOk ? "granted" : "MISSING — needed for gui_capture",
        accessibility: axOk ? "granted" : "MISSING — needed for gui_camera",
        howToGrant: "System Settings > Privacy & Security > {Screen Recording, Accessibility}; add the app running this MCP server (Terminal/iTerm/IDE), then fully quit & reopen it.",
        note: "Window enumeration (gui_find_window) needs no permission. Capture/keystrokes do.",
      });
    },
  );
}
