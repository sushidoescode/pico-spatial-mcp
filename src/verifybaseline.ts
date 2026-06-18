import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, okJson, fail, image, expandHome } from "./util.js";
import { resolveAdb } from "./emulatorlook.js";
import { screencap, magickCompare } from "./verifyvisual.js";

/**
 * verify_baseline — DETERMINISTIC single-frame visual regression. capture_frame (adb screencap) is
 * BYTE-STABLE when the camera doesn't move, so: mode=save stores a baseline frame at the current
 * pose; mode=check re-captures + perceptual-diffs (ImageMagick MAE) against it and flags a regression
 * if diff > threshold. Valid ONLY while the camera is unmoved between save and check (the C2 residual);
 * for whole-scene checks use verify_visual (orbit). Returns the current frame to LOOK at — pixels are
 * the coarse signal, the agent's eyes are the verdict.
 */
export function registerVerifyBaselineTools(server: McpServer) {
  server.registerTool(
    "verify_baseline",
    {
      description:
        "Deterministic single-frame visual regression check. mode=save captures a baseline frame at the current camera pose; mode=check re-captures + diffs (ImageMagick MAE) and flags a REGRESSION if diff>threshold. Deterministic ONLY if the camera is unmoved between save and check (capture_frame is byte-stable when static). Returns the current frame to LOOK at. For whole-scene use verify_visual.",
      inputSchema: {
        name: z.string().describe("Baseline key, e.g. 'spatialdemo-forward'."),
        mode: z.enum(["save", "check"]).describe("save = store baseline at current pose; check = compare current frame to it."),
        serial: z.string().optional().describe("adb serial (default emulator-5554)."),
        baselineDir: z.string().optional().describe("Baseline dir (default /tmp/pico-render/baselines)."),
        threshold: z.number().optional().describe("MAE regression threshold (default 0.06; lower = stricter)."),
      },
    },
    async ({ name, mode, serial, baselineDir, threshold }) => {
      const adb = resolveAdb();
      const dev = serial ?? "emulator-5554";
      const dir = expandHome(baselineDir ?? "/tmp/pico-render/baselines");
      fs.mkdirSync(dir, { recursive: true });
      const baseline = path.join(dir, `${name}.png`);

      if (mode === "save") {
        if (!(await screencap(adb, dev, baseline))) return fail(`screencap failed (is ${dev} running?)`);
        return okJson({ saved: baseline, note: "Baseline saved at the CURRENT camera pose. The check is deterministic ONLY if the camera is NOT moved before mode=check (capture_frame is byte-stable while static)." });
      }

      // check
      if (!fs.existsSync(baseline)) return fail(`No baseline '${name}' at ${baseline} — run mode=save first (at the pose you want to lock).`);
      const cur = path.join(dir, `${name}.current.png`);
      if (!(await screencap(adb, dev, cur))) return fail(`screencap failed (is ${dev} running?)`);
      const diff = await magickCompare(baseline, cur);
      const small = cur.replace(/\.png$/, ".small.png");
      const s = await run("sips", ["-Z", "1000", cur, "--out", small], { timeoutMs: 20_000 });
      const b64 = fs.readFileSync(s.code === 0 && fs.existsSync(small) ? small : cur).toString("base64");
      const thr = threshold ?? 0.06;
      if (diff === null) {
        return image(b64, `verify_baseline '${name}': ImageMagick not available — perceptual diff unavailable. LOOK at this frame vs the baseline (${baseline}) to judge. (brew install imagemagick for an automatic MAE.)`);
      }
      // 3-band verdict. capture_frame is byte-stable when static, so ANY nonzero MAE = content
      // changed. Whole-frame MAE under-weights small-area changes (e.g. a few small markers recolored
      // give a tiny MAE) — so "changed but below threshold" still demands a vision pass.
      let verdict: string;
      if (diff < 0.0005) verdict = "IDENTICAL to baseline (no change detected)";
      else if (diff < thr) verdict = `CHANGED — diff(MAE)=${diff.toFixed(4)} < threshold ${thr}, i.e. a SMALL-AREA change (whole-frame MAE under-weights small objects). LOOK to judge if it's a regression`;
      else verdict = `⚠️ REGRESSION — diff(MAE)=${diff.toFixed(4)} ≥ threshold ${thr}`;
      return image(b64, `verify_baseline '${name}': ${verdict}. (Valid only if the camera is unmoved since save; byte-stable when static so nonzero MAE = content changed.) LOOK at this frame — pixels are the coarse signal, your eyes are the verdict.`);
    },
  );
}
