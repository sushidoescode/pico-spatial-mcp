import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
 *     adb shell am broadcast -a <pkg>.DEBUG_CMD --es cmd <start|pause|resume|reset|custom action names declared in the spec>
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

const RUN_CFG = (name: string, script: string) =>
  `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="${name}" type="ShConfigurationType">
    <option name="INDEPENDENT_SCRIPT_PATH" value="true" />
    <option name="SCRIPT_PATH" value="$PROJECT_DIR$/${script}" />
    <option name="SCRIPT_OPTIONS" value="" />
    <option name="INDEPENDENT_SCRIPT_WORKING_DIRECTORY" value="true" />
    <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$" />
    <option name="INTERPRETER_PATH" value="/bin/zsh" />
    <option name="INTERPRETER_OPTIONS" value="" />
    <option name="EXECUTE_IN_TERMINAL" value="true" />
    <option name="EXECUTE_SCRIPT_FILE" value="true" />
    <envs />
    <method v="2" />
  </configuration>
</component>
`;

/**
 * Write the PICO dev-convenience scripts into a project so the mouse bridge (and a reliable redeploy)
 * are one click away in Android Studio — no more pasting the long python command. Idempotent.
 * Reused by scaffold_spatial_app so every new project is preloaded with them.
 *
 * Drops: pico-bridge.sh (launcher, hover on by default), redeploy.sh (assemble+forcestop+install+launch),
 *        .run/*.run.xml (AS run configs -> green ▶), pico.gradle.kts + `apply(from=...)` (Gradle tasks).
 */
export function installBridgeLauncher(projectDir: string): { written: string[]; note: string } {
  const venvPy = path.join(DEFAULT_VENV, "bin", "python");
  const written: string[] = [];
  const w = (rel: string, content: string, exec = false) => {
    const full = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (exec) fs.chmodSync(full, 0o755);
    written.push(rel);
  };

  w("pico-bridge.sh", launcherScript(venvPy, false), true);

  w(
    "redeploy.sh",
    `#!/usr/bin/env bash
# redeploy.sh — assemble + reliably (re)launch THIS app on the emulator. Force-stops other spatial apps
# first (a prior app owning the stage makes the launch exit immediately). Auto-installed by the PICO MCP.
set -euo pipefail
cd "$(dirname "$0")"
PKG="$(grep -m1 -E 'applicationId' app/build.gradle.kts | sed -E 's/.*"([^"]+)".*/\\1/')"
export JAVA_HOME="\${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
echo "Building $PKG…"; ./gradlew :app:assembleDebug
adb shell am force-stop "$PKG" 2>/dev/null || true
adb install -r app/build/outputs/apk/debug/app-debug.apk
for i in 1 2 3 4; do adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 0.6; [ -n "$(adb shell pidof "$PKG" 2>/dev/null | tr -d '\\r')" ] && break; done
echo "launched $PKG"
`,
    true,
  );

  w(".run/Mouse Bridge.run.xml", RUN_CFG("Mouse Bridge", "pico-bridge.sh"));
  w(".run/Redeploy (emulator).run.xml", RUN_CFG("Redeploy (emulator)", "redeploy.sh"));

  w(
    "pico.gradle.kts",
    `// pico.gradle.kts — convenience tasks (auto-installed by the PICO MCP). Applied from the root build.
tasks.register<Exec>("mouseBridge") {
    group = "pico"
    description = "Click/hover the in-world menu with your Mac mouse on the emulator. Stop with the red square."
    workingDir = rootDir
    commandLine("bash", "\${rootDir}/pico-bridge.sh")
    isIgnoreExitValue = true
}
tasks.register<Exec>("redeploy") {
    group = "pico"
    description = "Assemble + reliably relaunch this app on the emulator (force-stops other spatial apps)."
    workingDir = rootDir
    commandLine("bash", "\${rootDir}/redeploy.sh")
    isIgnoreExitValue = true
}
`,
  );

  // Wire the Gradle tasks in by applying pico.gradle.kts from the root build (idempotent).
  const rootGradle = path.join(projectDir, "build.gradle.kts");
  let gradleNote = "added Gradle tasks (pico > mouseBridge / redeploy)";
  if (fs.existsSync(rootGradle)) {
    const cur = fs.readFileSync(rootGradle, "utf8");
    if (!cur.includes("pico.gradle.kts")) {
      fs.writeFileSync(rootGradle, cur.replace(/\s*$/, "") + '\n\napply(from = "pico.gradle.kts")\n');
      written.push("build.gradle.kts (apply pico.gradle.kts)");
    }
  } else {
    gradleNote = "root build.gradle.kts not found — Gradle tasks not wired (scripts + run configs still work)";
  }

  return {
    written,
    note: `Installed the PICO dev scripts. In Android Studio: pick "Mouse Bridge" from the run-config dropdown and hit ▶ (or Gradle tool window > ${path.basename(projectDir)} > Tasks > pico > mouseBridge). ${gradleNote}. First run may ask you to grant Input Monitoring to Android Studio.`,
  };
}

/** The launcher body (used for both the per-project pico-bridge.sh and the global `pico-bridge`). */
function launcherScript(venvPy: string, isGlobal: boolean): string {
  return `#!/usr/bin/env bash
# pico-bridge — ${isGlobal ? "GLOBAL launcher (run from ANY terminal/project)" : "project launcher"} for the
# PICO in-world-menu mouse bridge (installed by the PICO MCP). Move the mouse over a menu button in the
# emulator and left-click; it auto-targets whichever demo is in front. \`nohover\` disables the hover preview.
set -euo pipefail
PY="${venvPy}"
BRIDGE="${BRIDGE_PY}"
SETUP="${SETUP_SH}"
[ -x "$PY" ] || { echo "Setting up the bridge venv (one time)…"; bash "$SETUP"; }
export BRIDGE_HOVER="\${BRIDGE_HOVER:-1}"          # hover preview ON by default
[ "\${1:-}" = "nohover" ] && unset BRIDGE_HOVER
echo "Mouse bridge: move the mouse over a menu button in the emulator and click. Ctrl-C to stop."
exec "$PY" -u "$BRIDGE" live
`;
}

/**
 * Install a GLOBAL `pico-bridge` command on PATH so it runs from any terminal/project (no cwd worry).
 * Picks the first writable dir among the usual PATH bins. Returns the installed path, or null.
 */
export function installGlobalCommand(): string | null {
  const venvPy = path.join(DEFAULT_VENV, "bin", "python");
  const prefer = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
  const onPath = new Set((process.env.PATH ?? "").split(":"));
  for (const dir of prefer) {
    try {
      if (!onPath.has(dir)) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      const dest = path.join(dir, "pico-bridge");
      fs.writeFileSync(dest, launcherScript(venvPy, true));
      fs.chmodSync(dest, 0o755);
      return dest;
    } catch {
      /* try the next dir */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// v27.2 BAKED-IN BRIDGE: the bridge is a blocking host process (CFRunLoop), so it
// can't run inside the MCP loop — but it CAN run as a DETACHED child with a pidfile.
// startBridgeDetached() is idempotent (alive pid = no-op) and is auto-invoked by
// fleet_build after launching a menu app, so nobody has to paste a command again.
// Opt out with PICO_MCP_NO_AUTOBRIDGE=1. Logs: ~/.pico-mcp/bridge.log.
// ---------------------------------------------------------------------------

const BRIDGE_DIR = path.join(os.homedir(), ".pico-mcp");
const BRIDGE_PIDFILE = path.join(BRIDGE_DIR, "bridge.pid");
const BRIDGE_LOG = path.join(BRIDGE_DIR, "bridge.log");

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Read the pidfile; clean it up if the process is gone. Exported for tests + status. */
export function bridgeStatus(): { running: boolean; pid: number | null; logTail: string } {
  let pid: number | null = null;
  try { pid = parseInt(fs.readFileSync(BRIDGE_PIDFILE, "utf8").trim(), 10) || null; } catch { /* no pidfile */ }
  const running = pid != null && pidAlive(pid);
  if (pid != null && !running) { try { fs.unlinkSync(BRIDGE_PIDFILE); } catch { /* ok */ } pid = null; }
  let logTail = "";
  try { logTail = fs.readFileSync(BRIDGE_LOG, "utf8").split("\n").slice(-6).join("\n"); } catch { /* no log */ }
  return { running, pid: running ? pid : null, logTail };
}

/**
 * Start the mouse bridge as a detached background process (idempotent). Ensures the venv first.
 * Returns an honest status: "already-running" | "started" | "permission-needed" | "failed" |
 * "unsupported". Never throws — callers use it best-effort from launch paths.
 */
export async function startBridgeDetached(opts?: { hover?: boolean; packageName?: string }): Promise<{ status: string; pid: number | null; note: string }> {
  if (os.platform() !== "darwin") return { status: "unsupported", pid: null, note: "mouse bridge is macOS-only" };
  if (!fs.existsSync(BRIDGE_PY)) return { status: "failed", pid: null, note: `bridge script missing: ${BRIDGE_PY}` };
  const existing = bridgeStatus();
  if (existing.running) return { status: "already-running", pid: existing.pid, note: `bridge already live (pid ${existing.pid})` };

  const venvPy = path.join(DEFAULT_VENV, "bin", "python");
  if (!fs.existsSync(venvPy)) {
    const setup = await run("bash", [SETUP_SH], { timeoutMs: 240_000 });
    if (setup.code !== 0 && !fs.existsSync(venvPy)) {
      return { status: "failed", pid: null, note: `venv setup failed — run: bash ${SETUP_SH}` };
    }
  }

  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  const logFd = fs.openSync(BRIDGE_LOG, "a");
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts?.hover === false) delete env.BRIDGE_HOVER; else env.BRIDGE_HOVER = "1";
  if (opts?.packageName) env.BRIDGE_PKG = opts.packageName;
  const child = spawn(venvPy, ["-u", BRIDGE_PY, "live"], { detached: true, stdio: ["ignore", logFd, logFd], env });
  child.unref();
  fs.closeSync(logFd);
  if (child.pid == null) return { status: "failed", pid: null, note: "spawn returned no pid" };
  fs.writeFileSync(BRIDGE_PIDFILE, String(child.pid));

  // settle, then read the log for the known permission failure signature
  await new Promise((r) => setTimeout(r, 1200));
  const after = bridgeStatus();
  if (!after.running) {
    const permHit = /could not create event tap/i.test(after.logTail);
    return {
      status: permHit ? "permission-needed" : "failed",
      pid: null,
      note: permHit
        ? "bridge exited: macOS Input Monitoring not granted. System Settings → Privacy & Security → Input Monitoring → enable the app hosting this MCP (your terminal/IDE), quit + relaunch it, then re-run mouse_bridge_start."
        : `bridge exited early — log tail:\n${after.logTail}`,
    };
  }
  return { status: "started", pid: after.pid, note: `mouse bridge live (pid ${after.pid}) — move the mouse over a menu button in the emulator and click. Stop: mouse_bridge_stop.` };
}

export function stopBridge(): { stopped: boolean; note: string } {
  const s = bridgeStatus();
  if (!s.running || s.pid == null) return { stopped: false, note: "bridge not running" };
  try { process.kill(s.pid, "SIGTERM"); } catch { /* already gone */ }
  try { fs.unlinkSync(BRIDGE_PIDFILE); } catch { /* ok */ }
  return { stopped: true, note: `stopped bridge (pid ${s.pid})` };
}

export function registerMouseBridgeTools(server: McpServer) {
  server.registerTool(
    "mouse_bridge_start",
    {
      description:
        "Start the in-world-menu MOUSE BRIDGE as a DETACHED background process (idempotent — a live bridge is reused). No terminal needed: this is the baked-in replacement for manually running `pico-bridge`. The bridge lets a Mac mouse click/hover the in-world GameMenu on the emulator, auto-targeting the foreground app. fleet_build auto-calls this after launching a menu app (opt out: PICO_MCP_NO_AUTOBRIDGE=1). One-time macOS grant: Input Monitoring for the app hosting this MCP. Logs: ~/.pico-mcp/bridge.log.",
      inputSchema: {
        hover: z.boolean().optional().describe("Hover preview (default ON): mousing over a button broadcasts hover:<action>. false = click-only."),
        packageName: z.string().optional().describe("Pin the target package. Default: auto-target the foreground spatial app (recommended)."),
      },
    },
    async ({ hover, packageName }) => ok(JSON.stringify(await startBridgeDetached({ hover, packageName }), null, 2)),
  );

  server.registerTool(
    "mouse_bridge_stop",
    { description: "Stop the detached mouse bridge (SIGTERM the pidfile process; cleans up ~/.pico-mcp/bridge.pid).", inputSchema: {} },
    async () => ok(JSON.stringify(stopBridge(), null, 2)),
  );

  server.registerTool(
    "mouse_bridge_status",
    { description: "Is the detached mouse bridge running? Returns pid + the last log lines (the place to see permission errors).", inputSchema: {} },
    async () => ok(JSON.stringify(bridgeStatus(), null, 2)),
  );

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
            "App package to drive, e.g. com.fleet.knockdown. If omitted, the bridge auto-detects the foreground spatial app at click time (system packages are excluded).",
          ),
        enableHover: z
          .boolean()
          .optional()
          .describe(
            "Also PREVIEW the button under the pointer (mouse-over highlight), not just click-to-select. Apps built by generate_game_menu_kotlin route it to GameMenu.hover(); the bridge broadcasts hover:<action> only when the hovered row CHANGES (efficient). Hover never commits — a click does. Off by default.",
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

      // 3) Install a GLOBAL `pico-bridge` command so it runs from any terminal/project (no cwd worry).
      const globalCmd = installGlobalCommand();

      // 4) Compose the run command + instructions.
      const env: string[] = [];
      // BRIDGE_PKG is an OPTIONAL hard pin. By default the bridge auto-targets the FOREGROUND demo
      // (re-checked each click) so clicks always hit the app you're looking at — do NOT pin unless asked.
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
        "## Run it — the easy way (from ANY terminal, any project)",
        globalCmd
          ? "```bash\npico-bridge\n```\n(installed at `" + globalCmd + "` — hover preview on; add `nohover` to disable)"
          : "_(couldn't install a global `pico-bridge` command — use the full command below)_",
        "",
        "## Or the full command",
        "```bash",
        liveCmd,
        "```",
        "Then **move your mouse over a menu button in the emulator window and LEFT-CLICK** to select it.",
        "**Drag the panel's title/frame to MOVE it anywhere in the room** (scroll over it to change depth); on",
        "release it logs the new position so you can bake it into `panelPosition`.",
        "It **auto-targets whichever demo is in the foreground** (re-checked each click) and prints the target,",
        "e.g. `click -> reset  [gravityxr]`. Each click does a fresh capture, so it tracks the panel even as the",
        "free camera drifts. Ctrl-C to stop." + (packageName ? `  (Pinned to \`${packageName}\` — omit BRIDGE_PKG to auto-target instead.)` : ""),
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
        "- It targets the **foreground** spatial app each click (a pinned BRIDGE_PKG overrides), then broadcasts",
        "  `<pkg>.DEBUG_CMD` — the SAME channel a gaze/controller select uses on a real headset.",
        "- Detection uses the menu's **unique signature** — four wide colour bars stacked vertically (green→amber→",
        "  blue→red) at one column — so side-by-side scene objects (floor cubes) and round planets can't hijack it.",
        "- A click is mapped **screen → emulator window → device framebuffer → nearest button row**.",
        "- With **BRIDGE_HOVER=1**, moving the mouse over a button PREVIEWS it (broadcasts `hover:<action>`",
        "  only on a row change → `GameMenu.hover()`); hover never commits, a click does. A background",
        "  thread keeps detection fresh so hover + clicks never block on a screencap.",
        "- The click is **listen-only** (it still reaches the emulator), so you keep full camera control.",
        "- This is an **emulator** convenience for testing in-world UI without a controller. On a PICO headset the",
        "  same `GameMenu.select` is driven by real gaze/controller (and the optional hand-tracking pinch).",
      ].join("\n");

      return ok(md);
    },
  );

  server.registerTool(
    "install_bridge_launcher",
    {
      description:
        "Preload a project with PICO dev-convenience scripts so the mouse bridge (and a reliable emulator redeploy) are ONE CLICK in Android Studio — no more pasting the long python command. Writes pico-bridge.sh (launcher, hover-preview on by default), redeploy.sh (assemble + force-stop other spatial apps + install + launch), Android Studio run configs (.run/*.run.xml → green ▶ 'Mouse Bridge' / 'Redeploy (emulator)'), and a pico.gradle.kts wired into the root build (Gradle tool window > pico > mouseBridge / redeploy). Idempotent. scaffold_spatial_app runs this automatically for new projects; use this tool to add it to existing ones. macOS.",
      inputSchema: {
        projectDir: z.string().describe("The Android project root (e.g. ~/AndroidStudioProjects/menuxr-native)."),
      },
    },
    async ({ projectDir }) => {
      const dir = projectDir.replace(/^~(?=$|\/)/, os.homedir());
      if (!fs.existsSync(dir)) return fail(`Project dir not found: ${dir}`);
      if (!fs.existsSync(path.join(dir, "app"))) return fail(`${dir} doesn't look like an Android project (no app/ module).`);
      try {
        const { written, note } = installBridgeLauncher(dir);
        return ok(`${note}\n\nWrote:\n${written.map((w) => "  " + w).join("\n")}`);
      } catch (e) {
        return fail(`install_bridge_launcher failed: ${(e as Error).message}`);
      }
    },
  );
}
