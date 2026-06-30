import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, run } from "./util.js";

/**
 * mousebridge.ts — setup_mouse_bridge: let a Mac MOUSE select the in-world game menu on the EMULATOR.
 *
 * The PICO emulator has no controller/gaze pointer (C3) and a 2D click does NOT raycast into the
 * spatial runtime, so there is no native way to click an in-world menu. The host-side bridge
 * (tools/mouse_menu_bridge.py) closes that gap: a Quartz event tap watches the real mouse over the
 * emulator window, maps the cursor into the device framebuffer, detects which of the 4 menu rows it
 * is over (scene-color robust: it finds the menu's blue panel bbox first, then the button bars inside
 * it, and least-squares-fits the 4 equally-spaced rows wherever the free camera drifted the panel),
 * and fires the already-proven command channel:
 *     adb shell am broadcast -a <pkg>.DEBUG_CMD --es cmd <start|pause|resume|reset>
 * which the app routes to GameMenu.select(action).
 *
 * VERIFIED end-to-end (2026-06-30, orreryxr on emulator-5554): a REAL system mouse click (cliclick)
 * over PAUSE was caught by the tap -> classified pause -> broadcast -> "GameMenu: select(pause)" ->
 * the in-world highlight + cursor LANDED on PAUSE (vision-confirmed). The mapping was validated by
 * marking the computed button screen-points on a full-screen capture (circles on the right buttons).
 *
 * The bridge is a HOST-side, blocking process (it runs a CFRunLoop), so the MCP server can't host it.
 * This tool's job is one-shot SETUP + the exact run instructions; the user runs `live` in a terminal.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/mousebridge.js -> repo root is one up; tools/ lives at the repo root.
const TOOLS_DIR = path.resolve(here, "..", "tools");
const BRIDGE_PY = path.join(TOOLS_DIR, "mouse_menu_bridge.py");
const SETUP_SH = path.join(TOOLS_DIR, "setup_bridge_venv.sh");
const DEFAULT_VENV = path.join(os.homedir(), ".pico-bridge", "venv");

export function registerMouseBridgeTools(server: McpServer) {
  server.registerTool(
    "setup_mouse_bridge",
    {
      description:
        "Set up + explain the HOST MOUSE BRIDGE so the user can SELECT the in-world game menu with their Mac mouse on the emulator (there is no controller/gaze pointer on the emulator — C3). Creates the isolated venv the bridge needs (pyobjc Quartz + Pillow), best-effort checks that a menu is currently detectable on screen, and returns the exact `live` command to run plus the one-time Input Monitoring permission step. The bridge watches the real mouse over the emulator window, maps the cursor into the framebuffer, detects which menu row it is over (scene-color robust via the blue panel bbox), and on a LEFT-CLICK broadcasts <pkg>.DEBUG_CMD so GameMenu.select fires — VERIFIED end-to-end (a real click on PAUSE moved the in-world highlight to PAUSE). macOS only.",
      inputSchema: {
        packageName: z
          .string()
          .optional()
          .describe(
            "App package to drive, e.g. com.example.orreryxr. If omitted, the bridge auto-detects the foreground com.example.* app at click time.",
          ),
        enableHover: z
          .boolean()
          .optional()
          .describe(
            "Also move the highlight on mouse-over (not just click). Off by default — it broadcasts on every move and only does anything if the app routes a 'hover' DEBUG_CMD. Click-to-select needs NO app change.",
          ),
      },
    },
    async ({ packageName, enableHover }) => {
      if (os.platform() !== "darwin") {
        return fail("The mouse bridge is macOS-only (it uses Quartz CGEventTap + window enumeration).");
      }
      if (!fs.existsSync(BRIDGE_PY)) {
        return fail(`Bridge script not found at ${BRIDGE_PY}. Expected it in the repo tools/ directory.`);
      }

      // 1) Ensure the venv (idempotent). Prefer the setup script; fall back to the existing venv.
      let venvPython = path.join(DEFAULT_VENV, "bin", "python");
      const setup = await run("bash", [SETUP_SH], { timeoutMs: 240_000 });
      if (setup.code === 0) {
        venvPython = setup.stdout.trim() || venvPython;
      } else if (!fs.existsSync(venvPython)) {
        return fail(
          `Could not create the bridge venv.\n` +
            `Run it yourself:\n  bash ${SETUP_SH}\n\n` +
            `stderr:\n${setup.stderr.slice(-1500)}`,
        );
      }

      // 2) Best-effort readiness check: is a menu currently detectable on screen?
      let readiness = "skipped (run `detect` yourself once the emulator shows a menu)";
      const det = await run(venvPython, [BRIDGE_PY, "detect"], { timeoutMs: 30_000 });
      if (det.code === 0) {
        const line = det.stdout.split("\n").find((l) => l.startsWith("detect:")) ?? det.stdout.trim();
        readiness = line.includes("None")
          ? "no menu detected right now (bring the emulator forward with a GameMenu visible, then re-run detect)"
          : `menu DETECTED ✓  ${line.replace("detect:", "").trim()}`;
      }

      // 3) Compose the run command + instructions.
      const env: string[] = [];
      if (packageName) env.push(`BRIDGE_PKG=${packageName}`);
      if (enableHover) env.push("BRIDGE_HOVER=1");
      const envPrefix = env.length ? env.join(" ") + " " : "";
      const liveCmd = `${envPrefix}${venvPython} ${BRIDGE_PY} live`;

      const md = [
        "# Mouse bridge ready",
        "",
        `**venv python:** \`${venvPython}\``,
        `**bridge:** \`${BRIDGE_PY}\``,
        `**readiness:** ${readiness}`,
        "",
        "## Run it (in your terminal)",
        "```bash",
        liveCmd,
        "```",
        "Then **move your mouse over a menu button in the emulator window and LEFT-CLICK** to select it.",
        "Each click does a fresh screen capture, so it tracks the panel even as the free camera drifts. Ctrl-C to stop.",
        "",
        "## One-time macOS permission",
        "The bridge needs to observe the global mouse. If the first run prints",
        "`could not create event tap`, grant **Input Monitoring** to your terminal app:",
        "**System Settings → Privacy & Security → Input Monitoring**, enable your terminal, then **quit + relaunch** it.",
        "",
        "## Other subcommands",
        "```bash",
        `${venvPython} ${BRIDGE_PY} detect    # screencap + print detected rows + save a debug overlay`,
        `${venvPython} ${BRIDGE_PY} window    # print the emulator window bounds`,
        `${venvPython} ${BRIDGE_PY} point <sx> <sy>   # map one screen point -> select (testing)`,
        "```",
        "",
        "## How it works / limits",
        "- It finds the menu's **blue panel bbox** first, then the green/amber/blue/red button bars *inside* it, so",
        "  scene colors (red planets, a sun, plants) can't contaminate detection.",
        "- A click is mapped **screen → emulator window → device framebuffer → nearest button row**, then it",
        "  broadcasts `<pkg>.DEBUG_CMD` — the SAME channel a gaze/controller select uses on a real headset.",
        "- The click is **listen-only** (it still reaches the emulator), so you keep full camera control.",
        "- This is an **emulator** convenience for testing in-world UI without a controller. On a PICO headset the",
        "  same `GameMenu.select` is driven by real gaze/controller (and the optional hand-tracking pinch).",
      ].join("\n");

      return ok(md);
    },
  );
}
