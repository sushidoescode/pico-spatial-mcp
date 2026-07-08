import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run, okJson, expandHome } from "./util.js";

/**
 * fidelity.ts — the AAA-quality RUBRIC over a capture PNG.
 *
 * Host-side ImageMagick heuristics only (no adb): five 0-100 subscores (nonVoid, contrast,
 * colorVariety, edgeDetail, brightBalance) → weighted total → grade → concrete tool-named fix
 * suggestions for every weak subscore. This is the quality bar that tells an agent WHAT to fix.
 *
 * HONESTY INVARIANT: every number here is an auto_judged-class heuristic AT BEST. A high score is
 * NOT a substitute for LOOKING at the frame, and record_verification still requires a looked-at
 * capture. Use this to ITERATE toward quality, then LOOK to verify.
 */

/** Run one `magick <img> ... -format "%[fx:...]" info:` query. Never throws. */
async function fx(imagePath: string, args: string[], fxFormat: string): Promise<{ value: number | null; error?: string }> {
  try {
    const res = await run("magick", [imagePath, ...args, "-format", fxFormat, "info:"], { timeoutMs: 30_000 });
    if (res.code !== 0) return { value: null, error: `magick exited ${res.code}: ${res.stderr.trim().slice(0, 300)}` };
    const v = Number(res.stdout.trim());
    if (!Number.isFinite(v)) return { value: null, error: `unparseable magick output: ${res.stdout.trim().slice(0, 120)}` };
    return { value: v };
  } catch (e: any) {
    return { value: null, error: String(e?.message ?? e) };
  }
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

export function registerFidelityTools(server: McpServer) {
  server.registerTool(
    "fidelity_score",
    {
      description:
        "AAA-quality RUBRIC over a capture PNG — host-side ImageMagick heuristics only (no adb). Returns five 0-100 subscores (nonVoid = lit fraction, contrast = luminance spread, colorVariety = mean saturation, edgeDetail = edge density, brightBalance = exposure vs the 0.18-0.55 mid band), a weighted total (30/20/20/20/10), a grade (>=80 AAA, >=60 solid, >=40 flat, else void), and a concrete tool-named fix suggestion for every subscore below 55 — the quality bar that tells an agent WHAT to fix next. HONESTY: this is a heuristic auto_judged-class signal for ITERATION — it is NOT a substitute for LOOKING at the frame; record_verification still requires a looked-at capture, and a high score must never be claimed as vision_verified.",
      inputSchema: {
        imagePath: z.string().describe("Path to the capture PNG (from capture_canonical / capture_frame)."),
        label: z.string().optional().describe("Optional label for this scoring run, e.g. 'knockdown forward view after lighting pass'."),
        profile: z.enum(["standard", "dark-theme"]).optional().describe("Weighting profile. 'dark-theme' (neon/noir/cosmic art direction) reweights to nonVoid 10 / contrast 25 / colorVariety 30 / edgeDetail 25 / brightBalance 10 and widens the exposure band down to 0.06 — an intentionally dark scene is NOT a void; judge it on color/contrast/detail instead."),
        region: z.enum(["full", "content"]).optional().describe("'full' (default) scores the whole frame. 'content' auto-trims near-black margins first (magick -fuzz -trim) and scores only the lit CONTENT bounding box — the honest measure for a dark scene where content sits in a band with black margins (the free-cam can't dolly closer, so the void around good content would otherwise cap the score). Reports the trimmed fraction."),
      },
    },
    async ({ imagePath, label, profile, region }) => {
      const img0 = expandHome(imagePath);
      const honesty =
        "heuristic auto_judged-class signal for iteration — NOT a substitute for LOOKING at the frame; record_verification still requires a looked-at capture.";
      if (!fs.existsSync(img0)) {
        return okJson({ status: "error", label, note: `image not found: ${img0}`, honesty });
      }
      // 'content' region: trim near-black borders to the lit content bounding box, then score that.
      let img = img0, trimNote: string | undefined;
      if (region === "content") {
        try {
          const tmp = img0.replace(/\.png$/i, "") + ".content.png";
          await run("magick", [img0, "-alpha", "off", "-fuzz", "14%", "-trim", "+repage", tmp], { timeoutMs: 30_000 });
          if (fs.existsSync(tmp) && fs.statSync(tmp).size > 500) {
            const dims = await run("magick", ["identify", "-format", "%w %h", tmp], { timeoutMs: 15_000 });
            img = tmp; trimNote = `content region ${dims.stdout.trim()} (trimmed from full frame)`;
          }
        } catch { /* fall back to full frame */ }
      }

      // Five independent magick measurements; each failure becomes a structured error, never a throw.
      // -alpha off everywhere: screencap PNGs are srgba, and the alpha channel corrupts fx:mean/sd
      // (measured: mean lum 0.528 with alpha vs true 0.056 without). -clamp after -edge: on HDRI
      // builds the edge convolution goes negative and cancels the mean to ~0 without it (measured).
      const [lit, sd, sat, edges, mean] = await Promise.all([
        fx(img, ["-alpha", "off", "-colorspace", "Gray", "-threshold", "8%"], "%[fx:mean*100]"), // lit (non-near-black) fraction, 0-100
        fx(img, ["-alpha", "off", "-colorspace", "Gray"], "%[fx:standard_deviation*100]"), // luminance sd, 0-100
        fx(img, ["-alpha", "off", "-colorspace", "HSL", "-channel", "G", "-separate"], "%[fx:mean*100]"), // mean saturation, 0-100
        fx(img, ["-alpha", "off", "-colorspace", "Gray", "-edge", "1", "-clamp"], "%[fx:mean*100]"), // edge density, 0-100
        fx(img, ["-alpha", "off", "-colorspace", "Gray"], "%[fx:mean]"), // mean luminance, 0-1
      ]);

      const errors: { metric: string; error: string }[] = [];
      for (const [metric, m] of [["nonVoid", lit], ["contrast", sd], ["colorVariety", sat], ["edgeDetail", edges], ["brightBalance", mean]] as const) {
        if (m.value == null) errors.push({ metric, error: m.error ?? "unknown" });
      }
      if (errors.length) {
        const missing = errors.some((e) => /ENOENT|spawn error/i.test(e.error));
        return okJson({
          status: "error",
          label,
          note: missing
            ? "ImageMagick (`magick`) is not available on this host — install it (brew install imagemagick) to score fidelity."
            : `magick measurement failed for: ${errors.map((e) => e.metric).join(", ")}`,
          errors,
          honesty,
        });
      }

      // Subscores (all 0-100).
      const nonVoid = clamp(lit.value!); // lit fraction directly: 100 - near-black percentage
      const contrast = clamp(sd.value! * 4); // sd*100 in 0-100; typical good frames sd ~0.15-0.25 → 60-100
      const colorVariety = clamp(sat.value! * 2.5); // mean saturation *100 → scaled sat*250
      const edgeDetail = clamp(edges.value! * 4); // edge density *100 → scaled edges*400
      const dark = profile === "dark-theme";
      const lum = mean.value!;
      const LO = dark ? 0.06 : 0.18, HI = 0.55;
      let brightBalance: number;
      if (lum >= LO && lum <= HI) brightBalance = 100; // inside the ideal mid band
      else if (lum < LO) brightBalance = clamp((lum / LO) * 100); // linear falloff to 0 at pure black
      else brightBalance = clamp(((1 - lum) / (1 - HI)) * 100); // linear falloff to 0 at pure white

      const subscores = {
        nonVoid: r1(nonVoid),
        contrast: r1(contrast),
        colorVariety: r1(colorVariety),
        edgeDetail: r1(edgeDetail),
        brightBalance: r1(brightBalance),
      };
      const total = dark
        ? r1(nonVoid * 0.1 + contrast * 0.25 + colorVariety * 0.3 + edgeDetail * 0.25 + brightBalance * 0.1)
        : r1(nonVoid * 0.3 + contrast * 0.2 + colorVariety * 0.2 + edgeDetail * 0.2 + brightBalance * 0.1);
      const grade = total >= 80 ? "AAA" : total >= 60 ? "solid" : total >= 40 ? "flat" : "void";

      // Concrete, tool-named fixes for every weak subscore.
      const suggestions: string[] = [];
      if (nonVoid < 55) suggestions.push("nonVoid low — scene is mostly void: add set dressing (generate_set_dressing) or a surround (generate_environment_kotlin kind=skybox), or reframe (capture_rig).");
      if (colorVariety < 55) suggestions.push("colorVariety low — monochrome: add emissive accents / themed materials (generate_set_dressing theme=neon).");
      if (contrast < 55) suggestions.push("contrast low — flat lighting: add a key light + dim ambient (SceneLightingRig).");
      if (edgeDetail < 55) suggestions.push("edgeDetail low — sparse geometry: add props/trim or move camera closer.");
      if (brightBalance < 55) suggestions.push(`brightBalance low — ${lum > HI ? "over" : "under"}-exposed (mean luminance ${lum.toFixed(3)}): adjust light intensity (dim-IBL rule).`);

      return okJson({ status: "scored", label, profile: profile ?? "standard", region: region ?? "full", trimNote, subscores, total, grade, suggestions, honesty });
    },
  );
}
