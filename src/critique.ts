import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { run } from "./util.js";

/**
 * critique.ts — v5.2 `critique_capture`: turn a LOOKED-at frame into a structured DEFECT LIST that feeds
 * replan_spec, so the compiler can self-repair.
 *
 * The agent has the eyes (the ground-truth rule stands): critique_capture does NOT pretend to see. It (1)
 * runs cheap dependency-light pixel heuristics (mean brightness, non-black coverage, dominant colors via
 * ImageMagick) as ASSISTS, (2) hands back the DESIGN.md rubric to judge against, and (3) maps the agent's
 * visual observations to a defect taxonomy — each defect carrying the diagnose/replan SYMPTOM keyword, the
 * DESIGN.md rule, and a suggested fix — and emits `replanFailures` in the exact shape replan_spec consumes.
 * Capture → LOOK → critique_capture(observations) → replan_spec(spec, replanFailures) → recompile subtree.
 */

// visual-defect keyword → { symptom (for replan_spec/diagnose), designRule, fix }.
// ORDER = precedence: the FIRST match wins, so specific/actionable defects come before the generic
// "not_rendering" catch-all (an observation like "cards not visible, sunk to the floor" should map to the
// actionable slot_in_bed, not the vague not_rendering).
const TAXONOMY: { match: RegExp; symptom: string; designRule: string; fix: string }[] = [
  { match: /flat ?white|all white|washed/, symptom: "displayColor", designRule: "DESIGN.md §1", fix: "bind a Material (setBaseColor), never rely on displayColor" },
  { match: /black|untextured|no texture|missing texture/, symptom: "texture_black", designRule: "diagnose: texture_black", fix: "BAKE the model (bake_textured_model) and load the baked bundle, never a raw GLB" },
  { match: /bed|floor|sunk|clip|through the/, symptom: "slot_in_bed", designRule: "home-env proxy floor y=0", fix: "move the layout out of the bed (centerZ further, centerY up)" },
  { match: /occlud|behind|overlap|hidden|covering/, symptom: "placement", designRule: "layout spacing", fix: "widen spacing / move the detail card so it doesn't occlude the shelf" },
  { match: /off ?screen|edge|cut ?off|out of frame|looking away|wrong ?direction/, symptom: "camera", designRule: "C2 forward-FOV", fix: "aim emulator_look to the node's forwardFOVpose (content lives near -Z)" },
  { match: /wrong ?colou?r|colou?r ?mismatch|does ?n.t match|different colou?r/, symptom: "color", designRule: "databinding color mapping", fix: "check the JSON color→Color4 mapping (RGB 0..1 order) in generate_data_binding_kotlin" },
  { match: /dim|dark|too ?dark|unlit|shadow/, symptom: "dim", designRule: "DESIGN.md §1 + lighting", fix: "add/upgrade the scene lighting rig (sun→fullRig) or use UNLIT/emissive materials" },
  { match: /empty|blank|nothing|not ?visible|not ?render|missing object|no cards|no items/, symptom: "not_rendering", designRule: "DESIGN.md §12", fix: "confirm the entity was added on the MAIN thread + lit + in the forward FOV; check the scene-dump" },
];

async function analyzeImage(imagePath: string): Promise<any> {
  const meanC = await run("magick", [imagePath, "-resize", "1x1", "txt:-"]);
  const rgb = /\((\d+),(\d+),(\d+)/.exec(meanC.stdout.split("\n").find((l) => l.includes("(")) ?? "");
  const cover = await run("magick", [imagePath, "-colorspace", "Gray", "-threshold", "8%", "-format", "%[fx:mean]", "info:"]);
  const hist = await run("magick", [imagePath, "-colors", "6", "-depth", "8", "-format", "%c", "histogram:info:"]);
  const brightness = rgb ? (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / (3 * 255) : null;
  const nonBlackCoverage = cover.code === 0 ? Number(cover.stdout.trim()) : null;
  const topColors = hist.stdout
    .split("\n")
    .map((l) => l.match(/#([0-9A-Fa-f]{6})/)?.[1])
    .filter(Boolean)
    .slice(0, 6);
  return {
    available: meanC.code === 0,
    meanColorRGB: rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null,
    meanBrightness: brightness,
    nonBlackCoverage,
    mostlyBlack: nonBlackCoverage != null ? nonBlackCoverage < 0.02 : null,
    topColors,
  };
}

const RUBRIC = [
  "Does the frame show what `claim` describes, and ONLY that (no missing/extra objects)?",
  "Is it LIT (not dim/black)? Color from Materials, not flat-white displayColor (§1)?",
  "Are objects in the forward FOV, upright, correctly placed (not in the bed / occluding each other)?",
  "Do data-bound colors/textures match the source catalog entry?",
  "For a transient state (animation/highlight): was it HELD (slowed/paused) so the capture is unambiguous?",
];

export function registerCritiqueTools(server: McpServer) {
  server.registerTool(
    "critique_capture",
    {
      description:
        "Turn a LOOKED-at capture into a structured defect list that feeds replan_spec (the v5.2 self-repair loop). You still do the seeing (ground-truth rule): pass what you observed as `observations` and this maps each to a defect with a diagnose/replan SYMPTOM + DESIGN.md rule + suggested fix, and returns `replanFailures` ready for replan_spec. It also runs cheap pixel heuristics (mean brightness, non-black coverage, dominant colors) as ASSISTS and returns the DESIGN.md rubric to judge against. If you pass `expected` (minObjects/notMostlyBlack/colorsPresent) it adds heuristic defects (e.g. mostly-black → not_rendering). Capture → LOOK → critique_capture → replan_spec → recompile the failed subtree.",
      inputSchema: {
        claim: z.string().describe("What the frame should show, e.g. '6 shelf cards render lit in the forward FOV'."),
        imagePath: z.string().optional().describe("Path to the capture (adb screencap PNG) — enables the pixel heuristics."),
        observations: z
          .array(z.object({ defect: z.string().describe("What's wrong, in plain words (mapped to a symptom)."), targetRef: z.string().optional().describe("The spec node id the defect belongs to.") }))
          .optional()
          .describe("Your visual findings. Omit to just get the rubric + heuristics."),
        expected: z
          .object({ notMostlyBlack: z.boolean().optional(), minObjects: z.number().optional(), colorsPresent: z.array(z.string()).optional().describe("Hex colors you expect, e.g. ['#26BF59'].") })
          .optional(),
      },
    },
    async ({ claim, imagePath, observations, expected }) => {
      const heuristics = imagePath ? await analyzeImage(imagePath).catch((e) => ({ available: false, error: String(e) })) : null;
      const defects: any[] = [];

      for (const o of observations ?? []) {
        const t = o.defect.toLowerCase();
        const hit = TAXONOMY.find((r) => r.match.test(t));
        defects.push({
          observation: o.defect,
          targetRef: o.targetRef,
          symptom: hit?.symptom ?? "unknown",
          designRule: hit?.designRule,
          suggestedFix: hit?.fix ?? "no automatic mapping — triage with diagnose",
        });
      }

      // heuristic-derived defects (assists, not the verdict)
      if (expected?.notMostlyBlack && heuristics && (heuristics as any).mostlyBlack) {
        defects.push({ observation: "frame is almost entirely black (heuristic)", symptom: "not_rendering", designRule: "DESIGN.md §12", suggestedFix: "nothing rendered — check main-thread add + lighting + camera aim" });
      }
      if (expected?.colorsPresent && heuristics && (heuristics as any).topColors) {
        const top = ((heuristics as any).topColors as string[]).map((c) => c.toUpperCase());
        for (const want of expected.colorsPresent) {
          const w = want.replace("#", "").toUpperCase();
          const near = top.some((c) => colorClose(c, w));
          if (!near) defects.push({ observation: `expected color ${want} not among dominant colors (heuristic)`, symptom: "color", designRule: "databinding color mapping", suggestedFix: "verify the JSON color for this item and the RGB order" });
        }
      }

      const replanFailures = defects.filter((d) => d.symptom !== "unknown").map((d) => ({ targetRef: d.targetRef, claim, symptom: d.symptom }));
      return okJson({
        claim,
        heuristics,
        rubric: RUBRIC,
        defects,
        replanFailures,
        clean: defects.length === 0,
        note: defects.length
          ? "Defects found. Pass `replanFailures` to replan_spec, then recompile only the returned subtree, then re-capture + LOOK. Heuristics are ASSISTS — your vision is the verdict."
          : "No defects from your observations. Confirm against the rubric that the claim is truly satisfied before marking PASS.",
      });
    },
  );
}

// crude hex proximity (each channel within 48/255) so a rendered tint counts as "the expected color present"
function colorClose(a: string, b: string): boolean {
  if (a.length < 6 || b.length < 6) return false;
  for (let i = 0; i < 6; i += 2) {
    const da = parseInt(a.slice(i, i + 2), 16);
    const db = parseInt(b.slice(i, i + 2), 16);
    if (Math.abs(da - db) > 48) return false;
  }
  return true;
}
