import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, runBinary, image, fail, expandHome } from "./util.js";
import { adbExecutable } from "./adb.js";
import { randomUUID } from "node:crypto";
import { inspectPng, classifyFrame } from "./artifactinspection.js";
import { picoCliObservationRoot } from "./picocli.js";

/**
 * A run-unique capture path under the observation root. The old default was one fixed file, so the
 * second capture silently overwrote the frame the first one was still being cited for — and two
 * agents capturing at once produced one file and two claims about it.
 */
function defaultCapturePath(): string {
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}`;
  return path.join(picoCliObservationRoot(), "capture-frame", runId, "capture_frame.png");
}

/**
 * capture_frame — the VISUAL GROUND-TRUTH primitive. Grabs a frame via `adb exec-out screencap`
 * (headless, no macOS permissions) and RETURNS THE IMAGE so the agent must LOOK at it.
 *
 * WHAT THIS ROUTE ACTUALLY OBSERVES (corrected 2026-09-15, Task C6): `screencap` composites the
 * CURRENT DISPLAY through the device shell. On 2026-06-14 that display carried the composited
 * HMD/immersive view for the run being checked, and the capture was byte-stable across repeats —
 * but that was an observation of one app on one display, not a property of the route. For an
 * XR-runtime immersive layer the same command can return black while the app draws perfectly, and
 * it can equally return black when nothing is drawn. A black frame here is INCONCLUSIVE ABOUT THE
 * ROUTE and is never, on its own, a rendering verdict. The macOS qemu-window capture observes
 * something different again: the emulator WINDOW, with its free camera and chrome.
 *
 * The bytes are structurally inspected before they are returned or written. "Bigger than 1000
 * bytes" is not an image, and a truncated capture is not evidence of anything.
 *
 * THE RULE this enforces: a feature is not "verified" until an agent has SEEN it render correctly.
 * Code compiling and logcat markers prove existence, not appearance. Always read the returned image.
 */

function resolveAdb(): string {
  return adbExecutable();
}

export function registerCaptureTools(server: McpServer) {
  server.registerTool(
    "capture_frame",
    {
      description:
        "Capture a frame with `adb exec-out screencap` (headless, no macOS perms) and return it as an image the agent MUST visually inspect. ROUTE: this composites the CURRENT DISPLAY through the device shell — for the checked runs that display carried the forward immersive view, but for an XR-runtime immersive layer the same command can return black while the app renders correctly, so a black frame is inconclusive about the route rather than a rendering verdict. The bytes are structurally inspected (signature, chunk CRCs, raster) before being returned; a truncated or non-image capture is refused instead of saved. This is the ground-truth check: code/logcat prove a thing EXISTS, only looking proves it RENDERS correctly. Downscales for the response and also saves full-res to disk. Content outside the captured field of view (e.g. pins in a ring behind the viewer) won't appear; reposition/navigate to inspect the rest.",
      inputSchema: {
        serial: z.string().optional().describe("REQUIRED adb device serial. There is no default: a frame names the device it came from."),
        outPath: z.string().optional().describe("Full-res PNG output path. Default: a run-unique file under the observation root, never a fixed shared path a later capture can overwrite."),
        maxDim: z.number().int().positive().optional().describe("Max dimension of the returned (downscaled) image (default 1200)."),
      },
    },
    async ({ serial, outPath, maxDim }) => {
      // Explicit target identity: a capture that cannot name its device is not evidence about any
      // device, and a default serial acts on whatever happens to be attached.
      if (!serial || !serial.trim()) {
        return fail("serial is required: capture_frame names the device the frame came from, and there is no default target. Pass the adb serial of the device to capture.");
      }
      const adb = resolveAdb();
      const dev = serial;
      const full = expandHome(outPath ?? defaultCapturePath());
      fs.mkdirSync(path.dirname(full), { recursive: true });

      const res = await runBinary(adb, ["-s", dev, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      if (res.code !== 0 || res.stdout.length < 1000) {
        return fail(`screencap failed (code ${res.code}, ${res.stdout.length} bytes). Is ${dev} running? stderr: ${res.stderr.slice(0, 400)}`);
      }
      // A byte count is not an image. Inspect the container before anything is written or returned.
      const inspected = inspectPng(res.stdout);
      if (!inspected.valid) {
        return fail(`screencap returned ${res.stdout.length} bytes from ${dev} that are not a valid image: ${inspected.reason}. Nothing was written; re-capture rather than treating these bytes as a frame.`);
      }
      if (!inspected.meetsCaptureFloor) {
        return fail(`screencap returned a valid but unusable frame from ${dev} (${inspected.width}x${inspected.height}): ${inspected.captureFloorReason}. Nothing was written.`);
      }
      const frame = classifyFrame(res.stdout);
      fs.writeFileSync(full, res.stdout);

      // Downscale for the response (sips is built into macOS).
      const small = full.replace(/\.png$/, "") + ".small.png";
      const dim = maxDim ?? 1200;
      const sip = await run("sips", ["-Z", String(dim), full, "--out", small], { timeoutMs: 20_000 });
      const toReturn = sip.code === 0 && fs.existsSync(small) ? small : full;
      const b64 = fs.readFileSync(toReturn).toString("base64");

      const note =
        `Captured the current display of ${dev} through the device shell -> ${full} ` +
        `(${(res.stdout.length / 1024).toFixed(0)} KB, ${inspected.width}x${inspected.height}, sha256 ${inspected.sha256}). ` +
        `Returned image is downscaled to ${dim}px. ` +
        `GROUND-TRUTH RULE: do not report a visual feature as "verified" unless you have looked at this frame and confirmed it renders correctly. ` +
        `Content outside the captured field of view is not in this frame.` +
        (frame.status === "dark" ? ` ${frame.note}` : "");
      return image(b64, note);
    },
  );
}
