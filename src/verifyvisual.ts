import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, runBinary, image, fail, expandHome } from "./util.js";
import { DRAG_SWIFT, resolveAdb } from "./emulatorlook.js";

/**
 * verify_visual — the WHOLE-SCENE visual ground-truth sweep. Captures the forward frame, then orbits
 * the free camera (emulator_look's right-drag) by a fixed yaw and captures again, N times — so the
 * agent can LOOK at the entire scene, not just the forward view. Returns the frames as images.
 * Optionally perceptual-diffs each frame vs a baseline dir (ImageMagick `compare` if available) to
 * catch regressions.
 *
 * HONESTY: this drives the decoupled FREE camera, and the orbit isn't pixel-repeatable across runs,
 * so the diff is a coarse regression signal — the real verdict is the agent looking at the frames.
 */

export async function screencap(adb: string, dev: string, outFull: string): Promise<boolean> {
  const res = await runBinary(adb, ["-s", dev, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
  if (res.code !== 0 || res.stdout.length < 1000) return false;
  fs.writeFileSync(outFull, res.stdout);
  return true;
}

export async function magickCompare(a: string, b: string): Promise<number | null> {
  let bin: string[] | null = null;
  const magick = await run("which", ["magick"], { timeoutMs: 5000 });
  if (magick.code === 0 && magick.stdout.trim()) bin = [magick.stdout.trim(), "compare"];
  else {
    const compare = await run("which", ["compare"], { timeoutMs: 5000 });
    if (compare.code === 0 && compare.stdout.trim()) bin = [compare.stdout.trim()];
  }
  if (!bin) return null;
  // compare prints the MAE metric to stderr like "1234.5 (0.0188)"
  const r = await run(bin[0], [...bin.slice(1), "-metric", "MAE", a, b, "/dev/null"], { timeoutMs: 30_000 });
  const m = (r.stderr + r.stdout).match(/\(([\d.]+)\)/);
  return m ? parseFloat(m[1]) : null;
}

/** Orbit-sweep capture (no image encoding) — shared by verify_visual + the verify orchestrator. */
export async function sweepFrames(opts: { serial?: string; steps?: number; stepDx?: number; outDir?: string; baselineDir?: string }): Promise<{ frames: { i: number; path: string; diff?: number | null }[]; dir: string; n: number; dx: number; error?: string }> {
  const adb = resolveAdb();
  const dev = opts.serial ?? "emulator-5554";
  const n = opts.steps ?? 3;
  const dx = opts.stepDx ?? 340;
  const dir = expandHome(opts.outDir ?? "/tmp/pico-render/verify_visual");
  fs.mkdirSync(dir, { recursive: true });
  const swiftPath = path.join(os.tmpdir(), "pico-verify-look.swift");
  fs.writeFileSync(swiftPath, DRAG_SWIFT);
  await run("osascript", ["-e", 'tell application "System Events" to set frontmost of (first process whose name contains "qemu") to true'], { timeoutMs: 5000 });
  const frames: { i: number; path: string; diff?: number | null }[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const d = await run("swift", [swiftPath, "right", String(dx), "0", "24", "14"], { timeoutMs: 30_000 });
      if (/NO_QEMU_WINDOW/.test(d.stdout)) return { frames, dir, n, dx, error: "emulator window not found — is it open + Accessibility granted?" };
      await new Promise((r) => setTimeout(r, 800));
    }
    const full = path.join(dir, `frame_${i}.png`);
    if (!(await screencap(adb, dev, full))) return { frames, dir, n, dx, error: `screencap failed at frame ${i} (is ${dev} running?)` };
    let diff: number | null | undefined;
    if (opts.baselineDir) {
      const base = path.join(expandHome(opts.baselineDir), `frame_${i}.png`);
      diff = fs.existsSync(base) ? await magickCompare(base, full) : null;
    }
    frames.push({ i, path: full, diff });
  }
  return { frames, dir, n, dx };
}

/** Downscale + base64-encode up to `cap` frames into MCP image content blocks. */
export async function framesToImageContent(frames: { i: number; path: string }[], cap: number): Promise<any[]> {
  const content: any[] = [];
  for (const f of frames.slice(0, cap)) {
    const small = f.path.replace(/\.png$/, ".small.png");
    const s = await run("sips", ["-Z", "900", f.path, "--out", small], { timeoutMs: 20_000 });
    const use = s.code === 0 && fs.existsSync(small) ? small : f.path;
    content.push({ type: "image", data: fs.readFileSync(use).toString("base64"), mimeType: "image/png" });
  }
  return content;
}

export function registerVerifyVisualTools(server: McpServer) {
  server.registerTool(
    "verify_visual",
    {
      description:
        "WHOLE-SCENE visual verification: capture the forward frame, then orbit the emulator camera by a fixed yaw and capture again, N times — returns the frames as images so the agent can LOOK at the entire scene (not just forward). Optional baselineDir does a coarse perceptual diff (ImageMagick) to flag regressions. The agent's eyes are the verdict; the diff is a coarse signal (free camera, not pixel-repeatable).",
      inputSchema: {
        serial: z.string().optional().describe("adb device serial (default emulator-5554)."),
        steps: z.number().int().min(1).max(6).optional().describe("Number of frames in the sweep (default 3)."),
        stepDx: z.number().optional().describe("Per-step yaw drag in px (default 340; sign sets direction, + = look right)."),
        outDir: z.string().optional().describe("Where to save the frames (default /tmp/pico-render/verify_visual)."),
        baselineDir: z.string().optional().describe("Optional dir of baseline frames (frame_0.png ...) to perceptual-diff against."),
        maxReturned: z.number().int().min(1).max(6).optional().describe("Max frames returned as images (default 4)."),
      },
    },
    async ({ serial, steps, stepDx, outDir, baselineDir, maxReturned }) => {
      const sw = await sweepFrames({ serial, steps, stepDx, outDir, baselineDir });
      if (sw.error) return fail(sw.error);
      const { frames, dir, n, dx } = sw;
      const content: any[] = await framesToImageContent(frames, maxReturned ?? 4);
      const diffNote = baselineDir
        ? " Diffs vs baseline (0=identical, higher=more changed; coarse): " + frames.map((f) => `f${f.i}=${f.diff ?? "n/a"}`).join(" ")
        : "";
      content.push({
        type: "text",
        text:
          `Swept ${n} frames (yaw step ${dx}px) -> ${dir}/frame_*.png. LOOK at each returned frame and judge the WHOLE scene (geometry, materials, placement, defects) — this is the visual ground truth.` +
          diffNote,
      });
      return { content };
    },
  );
}
