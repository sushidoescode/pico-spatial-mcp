import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, runBinary, image, fail, expandHome } from "./util.js";

/**
 * capture_frame — the VISUAL GROUND-TRUTH primitive. Grabs the emulator's rendered immersive frame
 * via `adb exec-out screencap` (headless, no macOS permissions) and RETURNS THE IMAGE so the agent
 * must LOOK at it. Verified 2026-06-14: this path returns the composited HMD/immersive view (our
 * pin rendered over the home env) and is byte-stable across repeated captures (deterministic),
 * unlike the macOS qemu-window capture (free camera + emulator chrome).
 *
 * THE RULE this enforces: a feature is not "verified" until an agent has SEEN it render correctly.
 * Code compiling and logcat markers prove existence, not appearance. Always read the returned image.
 */

function resolveAdb(): string {
  const candidates = [
    process.env.PICO_ADB,
    path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb"),
    "/opt/homebrew/bin/adb",
    "adb",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === "adb" || fs.existsSync(c)) return c;
  }
  return "adb";
}

export function registerCaptureTools(server: McpServer) {
  server.registerTool(
    "capture_frame",
    {
      description:
        "Capture the emulator's RENDERED immersive frame (adb exec-out screencap — headless, no perms, byte-stable) and return it as an image the agent MUST visually inspect. This is the ground-truth check: code/logcat prove a thing EXISTS, only looking proves it RENDERS correctly. Downscales for the response and also saves full-res to disk. Note: shows the forward HMD view — content outside the field of view (e.g. pins in a ring behind the viewer) won't appear; reposition/navigate to inspect the rest.",
      inputSchema: {
        serial: z.string().optional().describe("adb device serial (default emulator-5554)."),
        outPath: z.string().optional().describe("Full-res PNG output path (default /tmp/pico-render/capture_frame.png)."),
        maxDim: z.number().int().positive().optional().describe("Max dimension of the returned (downscaled) image (default 1200)."),
      },
    },
    async ({ serial, outPath, maxDim }) => {
      const adb = resolveAdb();
      const dev = serial ?? "emulator-5554";
      const full = expandHome(outPath ?? "/tmp/pico-render/capture_frame.png");
      fs.mkdirSync(path.dirname(full), { recursive: true });

      const res = await runBinary(adb, ["-s", dev, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      if (res.code !== 0 || res.stdout.length < 1000) {
        return fail(`screencap failed (code ${res.code}, ${res.stdout.length} bytes). Is ${dev} running? stderr: ${res.stderr.slice(0, 400)}`);
      }
      fs.writeFileSync(full, res.stdout);

      // Downscale for the response (sips is built into macOS).
      const small = full.replace(/\.png$/, "") + ".small.png";
      const dim = maxDim ?? 1200;
      const sip = await run("sips", ["-Z", String(dim), full, "--out", small], { timeoutMs: 20_000 });
      const toReturn = sip.code === 0 && fs.existsSync(small) ? small : full;
      const b64 = fs.readFileSync(toReturn).toString("base64");

      const note =
        `Captured ${dev} immersive frame -> ${full} (${(res.stdout.length / 1024).toFixed(0)} KB, full-res). ` +
        `Returned image is downscaled to ${dim}px. ` +
        `GROUND-TRUTH RULE: do not report a visual feature as "verified" unless you have looked at this frame and confirmed it renders correctly. ` +
        `This is the forward HMD view — content behind/beside the viewer is out of frame.`;
      return image(b64, note);
    },
  );
}
