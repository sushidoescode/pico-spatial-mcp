import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson, sleep } from "./util.js";
import { DRAG_SWIFT, resolveAdb } from "./emulatorlook.js";

const exec = promisify(execFile);
const SERIAL = "emulator-5554";

/**
 * capturerig.ts — capture_rig: DETERMINISTIC multi-angle capture for the drifting free-cam (C2).
 *
 * The emulator's free camera drifts between runs, so ad-hoc sweeps waste captures. This rig:
 *  1. normalizes pitch (drag hard down, then recoverDy back),
 *  2. sweeps N fixed yaw increments, screencapping at each stop,
 *  3. scores every frame with cheap image heuristics (nonVoid/saturation/edges),
 *  4. returns all scored frames + the best K paths.
 * HONESTY: the scores are auto_judged-class heuristics AT BEST — they RANK frames, they do not
 * verify anything. The caller must still LOOK at the best frames before claiming a visual result.
 */

interface FrameScore {
  path: string;
  score: number;
  nonVoid: number | null;
  saturation: number | null;
  edges: number | null;
  error?: string;
}

/** Post one right-button drag on the qemu window (mirrors emulator_look's swift invocation). */
async function drag(swiftPath: string, dx: number, dy: number): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await exec("swift", [swiftPath, "right", String(dx), String(dy), "24", "14"], { timeout: 30_000 });
    if (/NO_QEMU_WINDOW/.test(stdout)) return { ok: false, detail: "NO_QEMU_WINDOW — is the emulator window open?" };
    return { ok: true, detail: stdout.trim() };
  } catch (e) {
    return { ok: false, detail: `swift drag failed: ${(e as Error).message}` };
  }
}

/** magick <img> <preOps> -format %[fx:mean] info: — throws only inside the caller's try/catch. */
async function fxMean(img: string, preOps: string[]): Promise<number> {
  const { stdout } = await exec("magick", [img, ...preOps, "-format", "%[fx:mean]", "info:"], { timeout: 20_000 });
  const v = parseFloat(stdout.trim());
  if (!Number.isFinite(v)) throw new Error(`magick returned non-numeric: ${stdout.trim()}`);
  return v;
}

export function registerCaptureRigTools(server: McpServer) {
  server.registerTool(
    "capture_rig",
    {
      description:
        "Deterministic multi-angle capture rig for the DRIFTING emulator free-cam (ceiling C2). Recovers pitch (drags hard down then recoverDy back), then sweeps sweepSteps fixed yaw increments of stepDx px, screencapping at each stop, and scores every frame (nonVoid 0.5 + saturation 0.3 + edges 0.2 via magick; falls back to file size if magick is missing). Returns ALL scored frames + the top-<keep> paths. HONESTY: scores are auto_judged-class heuristics AT BEST — this tool only RANKS; it is NOT a substitute for LOOKING. The CALLER must still LOOK at the best frames (e.g. Read them) before claiming anything vision_verified. macOS-only (drives the qemu GUI cam; needs Accessibility). Pairs with emulator_look (single aimed look) and capture_frame.",
      inputSchema: {
        outDir: z.string().optional().describe("Directory for rig<i>.png frames (default /tmp/pico-render/rig)."),
        recoverDy: z.number().optional().describe("Recovery pitch drag after the hard-down: default 400 (down) to counter upward drift; pass negative to pitch up."),
        sweepSteps: z.number().int().min(1).max(24).optional().describe("Yaw stops in the sweep (default 10, max 24)."),
        stepDx: z.number().optional().describe("Horizontal drag px per stop (default 180; negative sweeps left)."),
        keep: z.number().int().positive().optional().describe("How many best paths to return (default 3)."),
        settleMs: z.number().int().nonnegative().optional().describe("Wait after each drag before screencap (default 400)."),
        normalize: z.boolean().optional().describe("Run the hard pitch-recovery before sweeping (default true). Set FALSE to sweep gently around the CURRENT pose — e.g. right after an app launch, whose default forward pose often already frames the content (verified: the fresh-launch pose framed the neon alley; the hard recovery lost it)."),
      },
    },
    async ({ outDir, recoverDy, sweepSteps, stepDx, keep, settleMs, normalize }) => {
      if (process.platform !== "darwin") {
        return okJson({ status: "error", error: "capture_rig is macOS-only (drives the emulator GUI cam)" });
      }
      const dir = outDir ?? "/tmp/pico-render/rig";
      const dy = recoverDy ?? 400;
      const steps = Math.min(sweepSteps ?? 10, 24);
      const dx = stepDx ?? 180;
      const k = keep ?? 3;
      const settle = settleMs ?? 400;
      const errors: string[] = [];

      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        return okJson({ status: "error", error: `cannot create outDir ${dir}: ${(e as Error).message}` });
      }

      // 1. bring qemu frontmost (same osascript as emulator_look), then normalize pitch.
      try {
        await exec("osascript", ["-e", 'tell application "System Events" to set frontmost of (first process whose name contains "qemu") to true'], { timeout: 5000 });
      } catch (e) {
        errors.push(`osascript frontmost failed (continuing): ${(e as Error).message}`);
      }
      const swiftPath = path.join(os.tmpdir(), "pico-capture-rig.swift");
      try {
        fs.writeFileSync(swiftPath, DRAG_SWIFT);
      } catch (e) {
        return okJson({ status: "error", error: `cannot write swift helper: ${(e as Error).message}` });
      }
      if (normalize !== false) {
        const rec1 = await drag(swiftPath, 0, -1000);
        if (!rec1.ok) return okJson({ status: "error", error: `pitch recovery drag 1 failed: ${rec1.detail}`, errors });
        const rec2 = await drag(swiftPath, 0, dy);
        if (!rec2.ok) return okJson({ status: "error", error: `pitch recovery drag 2 failed: ${rec2.detail}`, errors });
      }

      // 2. sweep + capture.
      const adb = resolveAdb();
      const captured: string[] = [];
      // capture the STARTING pose too: with normalize=false the current pose is often the best frame.
      try {
        const p0 = path.join(dir, "rig_start.png");
        const s0 = await exec(adb, ["-s", SERIAL, "exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
        if (s0.stdout.length >= 1000) { fs.writeFileSync(p0, s0.stdout); captured.push(p0); }
      } catch (e) { errors.push(`start capture failed: ${(e as Error).message}`); }
      for (let i = 0; i < steps; i++) {
        const d = await drag(swiftPath, dx, 0);
        if (!d.ok) {
          errors.push(`sweep step ${i}: ${d.detail}`);
          continue;
        }
        await sleep(settle);
        const p = path.join(dir, `rig${i}.png`);
        try {
          const { stdout } = await exec(adb, ["-s", SERIAL, "exec-out", "screencap", "-p"], {
            encoding: "buffer",
            maxBuffer: 32 * 1024 * 1024,
            timeout: 30_000,
          });
          if (stdout.length < 1000) {
            errors.push(`sweep step ${i}: screencap too small (${stdout.length} bytes) — skipped`);
            continue;
          }
          fs.writeFileSync(p, stdout);
          captured.push(p);
        } catch (e) {
          errors.push(`sweep step ${i}: screencap failed: ${(e as Error).message}`);
        }
      }

      // 3. score. Probe magick once; fall back to file size if missing.
      let magickOk = true;
      try {
        await exec("magick", ["-version"], { timeout: 10_000 });
      } catch {
        magickOk = false;
      }
      const frames: FrameScore[] = [];
      for (const p of captured) {
        if (magickOk) {
          try {
            const nonVoid = await fxMean(p, ["-colorspace", "Gray", "-threshold", "8%"]);
            const saturation = await fxMean(p, ["-colorspace", "HSL", "-channel", "G", "-separate", "+channel"]);
            const edges = await fxMean(p, ["-colorspace", "Gray", "-edge", "1", "-clamp"]); // -clamp: HDRI edge convolution goes negative without it (same fix as fidelity.ts)
            frames.push({ path: p, score: nonVoid * 0.5 + saturation * 0.3 + Math.min(1, edges * 10) * 0.2, nonVoid, saturation, edges });
            continue;
          } catch (e) {
            errors.push(`scoring ${path.basename(p)} failed, using file size: ${(e as Error).message}`);
          }
        }
        let size = 0;
        try {
          size = fs.statSync(p).size;
        } catch (e) {
          errors.push(`stat ${path.basename(p)} failed: ${(e as Error).message}`);
        }
        frames.push({ path: p, score: size, nonVoid: null, saturation: null, edges: null, error: "scored by file size only" });
      }

      const sorted = [...frames].sort((a, b) => b.score - a.score);
      const best = sorted.slice(0, k).map((f) => f.path);
      const note =
        `Recovered pitch (down 1000, then ${dy}) and swept ${steps} x ${dx}px yaw stops; captured ${captured.length} frames -> ${dir}. ` +
        (magickOk ? "Scores = nonVoid*0.5 + saturation*0.3 + edges*0.2 (magick)." : "magick NOT found — scores are raw FILE SIZES, an even weaker proxy.") +
        " These are auto_judged-class heuristics that only RANK frames — NOT a substitute for LOOKING. LOOK at the best frames before claiming any visual result." +
        (errors.length ? ` ${errors.length} step error(s) recorded.` : "");
      return okJson({ status: captured.length > 0 ? "ok" : "error", frames, best, note, ...(errors.length ? { errors } : {}) });
    },
  );
}
