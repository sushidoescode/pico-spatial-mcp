import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, okJson, run, sleep } from "./util.js";
import { adb, resolveSerial } from "./adb.js";

/**
 * Snapshot-based VISUAL regression for the spatial app (macOS only).
 *
 * The immersive 3D headset view is host-composited in the emulator's QEMU GUI
 * window — adb/gRPC screenshots cannot see it (same constraint hostgui.ts /
 * diagnose.ts work around). So we capture the GUI window with the macOS
 * `screencapture -l<id>` path, run a scripted ClaimSight interaction sequence
 * between captures, and perceptually diff each frame against a stored baseline.
 *
 * Image diff is dependency-free by default: ImageMagick `compare` is used when
 * present (it is the most accurate), otherwise we fall back to a coarse
 * sips-based mean-pixel-difference (sips is always on macOS). The method used is
 * ALWAYS reported back so the result is interpretable. Node has no built-in PNG
 * decoder, so all pixel work is shelled out.
 *
 * Requires the macOS Screen Recording permission for the app running this
 * server (Terminal/iTerm/IDE). It must NOT crash when the emulator window is
 * absent or a permission is missing — those return a structured error instead.
 */

const EMU_OWNER = "qemu-system-aarch64";

const PERM_HINT =
  "Grant Screen Recording to the app running this server (Terminal/iTerm/your IDE) in System Settings > Privacy & Security > Screen Recording, then fully restart that app.";

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
  const tmp = path.join(os.tmpdir(), `pico-regwin-${process.pid}.swift`);
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

/** Capture an emulator window to a PNG file via the host screencapture path (same as gui_capture). */
async function captureWindow(target: Win, outPath: string): Promise<{ ok: boolean; err: string }> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch {}
  const cap = await run("screencapture", ["-o", "-x", `-l${target.id}`, outPath], { timeoutMs: 30_000 });
  if (cap.code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) return { ok: true, err: "" };
  const err = (cap.stderr || cap.stdout || "").trim();
  if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch {}
  return { ok: false, err };
}

/**
 * Read a PNG into a small NxN BGRA pixel buffer via sips (downscale -> 32bpp BMP).
 * Mirrors the proven decode in diagnose.ts: sips writes "BM", a pixel-data offset
 * at bytes 10-13, width/height at 18/22, bpp at 28; height may be negative
 * (top-down). Returns flat [r,g,b] triples or null if the pipeline is unreliable.
 */
async function readSmallRgb(pngPath: string, gridN: number): Promise<{ w: number; h: number; rgb: number[] } | null> {
  const base = path.join(os.tmpdir(), "pico-mcp");
  fs.mkdirSync(base, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const small = path.join(base, `reg-small-${stamp}.png`);
  const bmp = path.join(base, `reg-small-${stamp}.bmp`);
  try {
    const ds = await run("sips", ["-z", String(gridN), String(gridN), pngPath, "--out", small], { timeoutMs: 20_000 });
    if (ds.code !== 0 || !fs.existsSync(small)) return null;
    const conv = await run("sips", ["-s", "format", "bmp", small, "--out", bmp], { timeoutMs: 20_000 });
    if (conv.code !== 0 || !fs.existsSync(bmp)) return null;

    const d = fs.readFileSync(bmp);
    if (d.length < 54 || d[0] !== 0x42 || d[1] !== 0x4d) return null; // "BM"
    const pixOff = d.readUInt32LE(10);
    const w = d.readInt32LE(18);
    const h = d.readInt32LE(22);
    const bpp = d.readUInt16LE(28);
    if (bpp !== 32 || w <= 0 || h === 0) return null; // only handle the 32bpp form sips emits
    const absH = Math.abs(h);
    const rowBytes = (((bpp * w + 31) / 32) | 0) * 4; // 4-byte aligned stride

    const rgb: number[] = [];
    for (let ry = 0; ry < absH; ry++) {
      const rowStart = pixOff + ry * rowBytes;
      if (rowStart + w * 4 > d.length) return null;
      for (let cx = 0; cx < w; cx++) {
        const p = rowStart + cx * 4;
        rgb.push(d[p + 2], d[p + 1], d[p]); // BGRA -> R,G,B
      }
    }
    if (!rgb.length) return null;
    return { w, h: absH, rgb };
  } catch {
    return null;
  } finally {
    for (const f of [small, bmp]) try { fs.unlinkSync(f); } catch {}
  }
}

/** Detect an ImageMagick `compare` invocation, preferring `magick compare` then bare `compare`. */
async function detectMagickCompare(): Promise<string[] | null> {
  const magick = await run("which", ["magick"], { timeoutMs: 5_000 });
  if (magick.code === 0 && magick.stdout.trim()) return [magick.stdout.trim(), "compare"];
  const compare = await run("which", ["compare"], { timeoutMs: 5_000 });
  if (compare.code === 0 && compare.stdout.trim()) return [compare.stdout.trim()];
  return null;
}

/**
 * Perceptual diff of two PNGs -> normalized difference in [0,1] (0 = identical).
 * Prefers ImageMagick `compare -metric MAE` (returns a normalized mean abs error);
 * falls back to a coarse sips downscale + mean per-pixel RGB difference. The
 * concrete method used is always returned so the score is interpretable.
 */
async function diffImages(
  baselinePath: string,
  currentPath: string,
  magickCmd: string[] | null,
  gridN: number,
): Promise<{ score: number | null; method: string; note?: string }> {
  // --- Preferred: ImageMagick compare (most accurate). ---
  if (magickCmd) {
    // -metric MAE prints "<abs> (<normalized>)" to stderr and exits non-zero when images differ.
    const args = [...magickCmd.slice(1), "-metric", "MAE", baselinePath, currentPath, "null:"];
    const r = await run(magickCmd[0], args, { timeoutMs: 60_000 });
    const out = `${r.stderr} ${r.stdout}`.trim();
    // Normalized fraction is inside the parentheses; fall back to the raw number.
    const paren = out.match(/\(([-\d.eE]+)\)/);
    const bare = out.match(/^\s*([-\d.eE]+)/);
    const norm = paren ? Number(paren[1]) : bare ? Number(bare[1]) / 65535 : NaN;
    if (Number.isFinite(norm)) {
      return { score: Math.max(0, Math.min(1, norm)), method: "imagemagick-compare-mae" };
    }
    // compare failed to parse (e.g. dimension mismatch) — fall through to sips.
    return { score: null, method: "imagemagick-compare-mae", note: `compare unparseable: ${out.slice(0, 200)}` };
  }

  // --- Fallback: dependency-free sips mean per-pixel RGB difference. ---
  const a = await readSmallRgb(baselinePath, gridN);
  const b = await readSmallRgb(currentPath, gridN);
  if (!a || !b) return { score: null, method: "sips-mean-diff", note: "sips downscale/parse failed for one or both images" };
  const n = Math.min(a.rgb.length, b.rgb.length);
  if (n === 0) return { score: null, method: "sips-mean-diff", note: "empty pixel buffers" };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a.rgb[i] - b.rgb[i]);
  const score = sum / n / 255; // mean abs channel diff, normalized to [0,1]
  return { score: Math.round(score * 1e4) / 1e4, method: "sips-mean-diff" };
}

// ---------------------------------------------------------------------------
// Scripted steps
// ---------------------------------------------------------------------------

interface Step {
  name: string;
  /** Optional action run BEFORE the capture; resilient — return a note, never throw fatally. */
  action?: (serial: string | null) => Promise<string>;
  /** Settle delay after the action before capturing (ms). */
  settleMs?: number;
}

/**
 * Built-in ClaimSight sequence. Pragmatic and resilient: every action swallows
 * its own failure into a note so a missing app / unavailable input never aborts
 * the whole run — the capture+diff still happens for the frames that work.
 */
const CLAIMSIGHT_PACKAGE = "com.example.claimsight";

function defaultSteps(packageName: string): Step[] {
  return [
    {
      // Ensure the app is foregrounded, then capture the resting "home" frame.
      name: "home",
      settleMs: 1500,
      action: async (serial) => {
        if (!serial) return "no adb serial — captured whatever the GUI currently shows";
        const r = await adb(["-s", serial, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"], 20_000).catch(
          (e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }),
        );
        return r.code === 0 && !/No activities found|Error/i.test(r.stdout + r.stderr)
          ? `launched ${packageName}`
          : `launch skipped (${(r.stdout + r.stderr).trim().slice(0, 120) || "no launcher"})`;
      },
    },
    {
      // Arm "Place Pin": find a clickable element by text and tap its center, else
      // press the controller trigger as a fallback. Either way capture "armed".
      name: "armed",
      settleMs: 1200,
      action: async (serial) => {
        if (!serial) return "no adb serial — skipped arm action";
        const tapped = await tapByText(serial, /place\s*pin|place|pin/i);
        if (tapped) return `tapped UI element: ${tapped}`;
        const press = await adb(["-s", serial, "shell", "input", "keyevent", "KEYCODE_ENTER"], 15_000).catch(() => null);
        return press?.code === 0 ? "no Place-Pin UI node; sent ENTER as arm fallback" : "no arm action available (skipped)";
      },
    },
    {
      // Confirm/commit the placement (tap a Commit/Confirm/Done node if present).
      name: "placed",
      settleMs: 1200,
      action: async (serial) => {
        if (!serial) return "no adb serial — skipped commit action";
        const tapped = await tapByText(serial, /commit|confirm|done|place/i);
        return tapped ? `tapped UI element: ${tapped}` : "no commit UI node found (captured current frame)";
      },
    },
  ];
}

/** Find a clickable uiautomator node whose text/desc matches and tap its center. Returns the matched label or null. */
async function tapByText(serial: string, re: RegExp): Promise<string | null> {
  try {
    await adb(["-s", serial, "shell", "uiautomator", "dump", "/sdcard/reg-ui.xml"], 30_000);
    const r = await adb(["-s", serial, "shell", "cat", "/sdcard/reg-ui.xml"], 15_000);
    const xml = r.stdout;
    if (!xml.includes("<node")) return null;
    for (const m of xml.matchAll(/<node\b[^>]*?(?:\/>|>)/g)) {
      const tag = m[0];
      const attr = (k: string) => tag.match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? "";
      const label = `${attr("text")} ${attr("content-desc")}`.trim();
      const clickable = attr("clickable") === "true";
      if (!clickable || !re.test(label)) continue;
      const b = attr("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!b) continue;
      const cx = Math.round((+b[1] + +b[3]) / 2);
      const cy = Math.round((+b[2] + +b[4]) / 2);
      const tap = await adb(["-s", serial, "shell", "input", "tap", String(cx), String(cy)], 15_000);
      if (tap.code === 0) return label || `(${cx},${cy})`;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const stepSchema = z.object({
  name: z.string().describe("Step/frame name; the baseline is baselineDir/<name>.png"),
  tapText: z.string().optional().describe("Regex (case-insensitive) of a clickable UI node's text/desc to tap before capturing"),
  keyevent: z.string().optional().describe("adb keyevent to send before capturing, e.g. KEYCODE_ENTER"),
  launch: z.string().optional().describe("Package name to (re)launch via the LAUNCHER intent before capturing"),
  settleMs: z.number().int().min(0).max(15000).optional().describe("Delay after the action before capturing (default 1200ms)"),
});

export function registerRegressionTools(server: McpServer) {
  if (process.platform !== "darwin") {
    // Capture is macOS-only (host screencapture of the qemu window). Register a
    // stub so the tool name exists but explains the platform limit.
    server.registerTool(
      "run_visual_regression",
      {
        description:
          "Snapshot-based visual regression for the spatial app — macOS-only (host window capture); this server is on a non-macOS host.",
        inputSchema: {},
      },
      async () => fail(`run_visual_regression requires macOS (host is ${process.platform}).`),
    );
    return;
  }

  server.registerTool(
    "run_visual_regression",
    {
      description:
        "Run a SNAPSHOT-BASED visual regression over the live emulator's host-composited 3D view. For each scripted step it drives the app (launch / tap a UI node / keyevent — all via existing adb+ui helpers, resilient: inapplicable steps are skipped, never fatal), captures the emulator GUI window with the same macOS screencapture -l<id> path as gui_capture, and perceptually diffs the frame against baselineDir/<name>.png. Diff prefers ImageMagick `compare -metric MAE` when installed, else a dependency-free sips mean-pixel-difference (the chosen method is always reported). Defaults to a built-in ClaimSight sequence (home -> arm Place Pin -> placed). With updateBaseline=true it writes the current captures into baselineDir instead of diffing (record/refresh a baseline). Returns { steps, regressions, baselineUpdated, method }. Does NOT crash if the emulator window is missing or Screen Recording is denied — it returns a structured error.",
      inputSchema: {
        projectDir: z.string().optional().describe("Spatial app project dir (informational; reserved for project-scoped defaults)"),
        baselineDir: z.string().describe("Directory holding baseline PNGs named <step>.png (also where updateBaseline writes)"),
        outDir: z.string().optional().describe("Where to write current captures + diffs (default: a temp dir under pico-mcp/regression)"),
        steps: z.array(stepSchema).optional().describe("Scripted sequence; omit to use the built-in ClaimSight sequence (home/armed/placed)"),
        threshold: z.number().min(0).max(1).default(0.06).describe("Max normalized diff [0..1] a step may have before it counts as a regression"),
        updateBaseline: z.boolean().default(false).describe("Write current captures into baselineDir as the new baseline instead of diffing"),
        packageName: z.string().optional().describe("Package to launch for the built-in sequence (default com.pico.claimsight)"),
        gridN: z.number().int().min(8).max(128).default(32).describe("sips fallback downscale grid (NxN); ignored when ImageMagick is used"),
        serial: z.string().optional().describe("adb device serial for the scripted actions (default: sole connected device)"),
      },
    },
    async ({ projectDir, baselineDir, outDir, steps, threshold, updateBaseline, packageName, gridN, serial }) => {
      // 1) Locate the emulator GUI window — structured error, never a crash.
      let wins: Win[];
      try {
        wins = listEmulatorWindows();
      } catch (e: any) {
        return okJson({ error: e.message, hint: "Is Xcode CLT installed and 'swift' on PATH? gui_find_window can confirm windows.", steps: [], regressions: [], baselineUpdated: false, method: null });
      }
      const target = mainWindow(wins);
      if (!target) {
        return okJson({
          error: "No emulator GUI window found. Boot the emulator WITHOUT -no-window (emulator_boot headless=false) and don't minimize it.",
          windows: wins,
          steps: [],
          regressions: [],
          baselineUpdated: false,
          method: null,
        });
      }

      // 2) Resolve a serial for the scripted actions (optional — captures still work without one).
      let resolvedSerial: string | null = null;
      try {
        resolvedSerial = await resolveSerial(serial);
      } catch {
        resolvedSerial = null; // no device: actions self-skip, we still capture the GUI window
      }

      // 3) Output dir + diff method (detect ImageMagick once; report which path is used).
      const baseDir = expandHome(baselineDir);
      const captureDir = expandHome(outDir ?? path.join(os.tmpdir(), "pico-mcp", "regression", `run-${Date.now()}`));
      fs.mkdirSync(captureDir, { recursive: true });
      if (updateBaseline) fs.mkdirSync(baseDir, { recursive: true });
      const magickCmd = await detectMagickCompare();
      const method = updateBaseline ? "none (baseline update)" : magickCmd ? "imagemagick-compare-mae" : "sips-mean-diff";

      // 4) Resolve the step plan: explicit input or the built-in ClaimSight sequence.
      const pkg = packageName ?? CLAIMSIGHT_PACKAGE;
      const plan: Step[] = steps && steps.length
        ? steps.map((s) => ({
            name: s.name,
            settleMs: s.settleMs ?? 1200,
            action: async (sl) => {
              const notes: string[] = [];
              if (!sl && (s.launch || s.tapText || s.keyevent)) return "no adb serial — actions skipped";
              if (s.launch && sl) {
                const r = await adb(["-s", sl, "shell", "monkey", "-p", s.launch, "-c", "android.intent.category.LAUNCHER", "1"], 20_000).catch(() => null);
                notes.push(r?.code === 0 ? `launched ${s.launch}` : `launch ${s.launch} skipped`);
              }
              if (s.tapText && sl) {
                const t = await tapByText(sl, new RegExp(s.tapText, "i"));
                notes.push(t ? `tapped '${t}'` : `no node matching /${s.tapText}/i (skipped)`);
              }
              if (s.keyevent && sl) {
                const r = await adb(["-s", sl, "shell", "input", "keyevent", s.keyevent], 15_000).catch(() => null);
                notes.push(r?.code === 0 ? `sent ${s.keyevent}` : `keyevent ${s.keyevent} skipped`);
              }
              return notes.join("; ") || "capture only (no action)";
            },
          }))
        : defaultSteps(pkg);

      // 5) Walk the plan: act -> settle -> capture -> diff (or write baseline).
      const results: Array<Record<string, unknown>> = [];
      const regressions: string[] = [];
      for (const step of plan) {
        let actionNote = "capture only";
        try {
          if (step.action) actionNote = await step.action(resolvedSerial);
        } catch (e: any) {
          actionNote = `action error (continued): ${e?.message ?? e}`;
        }
        await sleep(step.settleMs ?? 1200);

        const curPath = path.join(captureDir, `${step.name}.png`);
        const cap = await captureWindow(target, curPath);
        if (!cap.ok) {
          const permLikely = /could not create image|not authorized|permission/i.test(cap.err) || !cap.err;
          results.push({
            name: step.name,
            action: actionNote,
            captured: false,
            error: permLikely ? `capture failed — likely missing Screen Recording permission. ${PERM_HINT}` : `screencapture failed: ${cap.err}`,
          });
          continue;
        }

        if (updateBaseline) {
          const dest = path.join(baseDir, `${step.name}.png`);
          fs.copyFileSync(curPath, dest);
          results.push({ name: step.name, action: actionNote, captured: true, baseline: dest, updated: true });
          continue;
        }

        const baselinePath = path.join(baseDir, `${step.name}.png`);
        if (!fs.existsSync(baselinePath)) {
          results.push({
            name: step.name,
            action: actionNote,
            captured: true,
            current: curPath,
            pass: null,
            note: `no baseline at ${baselinePath} — run with updateBaseline=true to record it`,
          });
          continue;
        }

        const { score, method: usedMethod, note } = await diffImages(baselinePath, curPath, magickCmd, gridN);
        if (score == null) {
          results.push({ name: step.name, action: actionNote, captured: true, current: curPath, baseline: baselinePath, diffScore: null, pass: null, method: usedMethod, note });
          continue;
        }
        const pass = score <= threshold;
        if (!pass) regressions.push(step.name);
        results.push({
          name: step.name,
          action: actionNote,
          captured: true,
          current: curPath,
          baseline: baselinePath,
          diffScore: score,
          threshold,
          pass,
          method: usedMethod,
        });
      }

      return okJson({
        steps: results,
        regressions,
        baselineUpdated: updateBaseline,
        method,
        window: { id: target.id, w: target.w, h: target.h },
        baselineDir: baseDir,
        outDir: captureDir,
        serial: resolvedSerial,
        projectDir: projectDir ? expandHome(projectDir) : undefined,
        note: updateBaseline
          ? "Baseline updated from current captures (no diffing performed)."
          : magickCmd
            ? "Diffed with ImageMagick compare (MAE, normalized)."
            : "Diffed with the dependency-free sips mean-pixel-difference fallback (ImageMagick not installed).",
      });
    },
  );
}
