import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { validateCapture, extractImagePath } from "./evidence.js";

/**
 * capability_report — the v3.1 honesty primitive. Takes the features an agent built + HOW each was
 * verified, and emits the truthful "verified-on-emulator vs built-for-headset" matrix the user
 * enforces (no more code-level "verified" passed off as experience-level). Bakes in the 4 proven
 * emulator ceilings (C1-C4, 2026-06-14) so every headset-gated feature carries its reason.
 */

const CEILINGS: Record<string, string> = {
  C1: "No scene-understanding on the emulator: PlaneTrackingManager/MeshTrackingManager start (RUNNING) but return 0 planes/0 mesh. Real-surface pins are headset-only.",
  C2: "Capture camera is decoupled + uncontrollable headlessly. No reliable headless 3D screenshot — verify via logcat, never claim 'renders' from a capture.",
  C3: "No controller pointer + the trigger is GUI-gated. Panel clicks/trigger interactions can't be verified headlessly — drive via adb am broadcast.",
  C4: "Stage-vs-window dichotomy: no native config gives room + spatial pins + in-front interactive panels together.",
};

// status -> bucket + label. THE GROUND-TRUTH RULE (the user enforces this): only a feature an agent
// has SEEN render correctly (a capture inspected with vision) counts as visually verified. Code
// compiling, logcat markers, and structural decodes prove a thing EXISTS, never that it LOOKS right.
// So logcat/structural/decoded land in "structuralOnly" — NOT a visual "verified".
const STATUS_META: Record<string, { bucket: "visuallyVerified" | "autoJudged" | "usdHostRender" | "structuralOnly" | "builtForHeadset"; label: string }> = {
  vision_verified: { bucket: "visuallyVerified", label: "SEEN rendering correctly in a capture (agent/human vision)" },
  rendered_emulator: { bucket: "visuallyVerified", label: "observed rendering on emulator (vision-confirmed)" },
  // v6.2: the calibrated automated eye MEASURED objective properties (object count / colors / coverage)
  // of a real frame against the acceptance predicate. This is a distinct, weaker class than human vision —
  // it never becomes vision_verified. A human audit samples it to keep it calibrated.
  auto_judged: { bucket: "autoJudged", label: "MEASURED by the calibrated automated eye (objective CV vs the predicate on a real frame) — not human-seen" },
  // v7.4: the off-device USD (Hydra Storm) render — verifies scene COMPOSITION/geometry deterministically,
  // NOT the on-device Filament appearance. A distinct, honest class: never conflated with device vision.
  usd_host_render: { bucket: "usdHostRender", label: "rendered OFF-DEVICE (Hydra Storm USD) — composition/geometry verified, NOT device appearance" },
  logcat_asserted: { bucket: "structuralOnly", label: "asserted in logcat — EXISTS, not visually confirmed" },
  decoded_real_data: { bucket: "structuralOnly", label: "verified against real data — structural, not visual" },
  compiles: { bucket: "structuralOnly", label: "compiles — no runtime behaviour or appearance verified" },
  structural: { bucket: "structuralOnly", label: "structurally valid (parses/well-formed) only" },
  built_for_headset: { bucket: "builtForHeadset", label: "built; runtime verification needs a PICO Swan headset" },
};

/** Build the honest verified-vs-built matrix from features. Shared by capability_report + the loop (build_and_run/iterate_scene auto-emit). */
export function buildCapabilityMatrix(appName: string | undefined, features: any[]): { appName: string | null; summary: string; matrix: any; markdown: string } {
  const buckets = {
    visuallyVerified: [] as any[],
    autoJudged: [] as any[],
    usdHostRender: [] as any[],
    structuralOnly: [] as any[],
    builtForHeadset: [] as any[],
  };
  for (const f of features) {
    const meta = STATUS_META[f.status] ?? STATUS_META.structural;
    const entry = {
      name: f.name,
      how: meta.label,
      evidence: f.evidence ?? null,
      ...(f.ceiling ? { ceiling: f.ceiling, ceilingReason: CEILINGS[f.ceiling] } : {}),
    };
    buckets[meta.bucket].push(entry);
  }
  const usedCeilings = Array.from(new Set(features.map((f) => f.ceiling).filter(Boolean) as string[])).sort();
  const line = (e: any) =>
    `- **${e.name}** — ${e.how}${e.evidence ? ` (${e.evidence})` : ""}${e.ceiling ? ` _[${e.ceiling}]_` : ""}`;
  const md = [
    `# Capability report${appName ? `: ${appName}` : ""}`,
    ``,
    `> GROUND-TRUTH RULE: only features an agent has SEEN render (a capture inspected with vision) are "verified". Everything else EXISTS but is not visually confirmed.`,
    ``,
    `## 👁️ Visually verified — seen rendering (${buckets.visuallyVerified.length})`,
    ...(buckets.visuallyVerified.length ? buckets.visuallyVerified.map(line) : ["_(none)_"]),
    ``,
    `## 🤖 Auto-judged — MEASURED by the calibrated eye, not human-seen (${buckets.autoJudged.length})`,
    ...(buckets.autoJudged.length ? buckets.autoJudged.map(line) : ["_(none)_"]),
    ``,
    `## 🖥️ USD host-render — composition verified OFF-DEVICE (Storm), NOT device appearance (${buckets.usdHostRender.length})`,
    ...(buckets.usdHostRender.length ? buckets.usdHostRender.map(line) : ["_(none)_"]),
    ``,
    `## ⚙️ Structural / logcat only — EXISTS, appearance NOT confirmed (${buckets.structuralOnly.length})`,
    ...(buckets.structuralOnly.length ? buckets.structuralOnly.map(line) : ["_(none)_"]),
    ``,
    `## 🟡 Built for headset — verify on PICO Swan (${buckets.builtForHeadset.length})`,
    ...(buckets.builtForHeadset.length ? buckets.builtForHeadset.map(line) : ["_(none)_"]),
    ...(usedCeilings.length ? [``, `## Emulator ceilings referenced`, ...usedCeilings.map((c) => `- **${c}**: ${CEILINGS[c]}`)] : []),
  ].join("\n");
  const summary = `${buckets.visuallyVerified.length} visually verified, ${buckets.autoJudged.length} auto-judged (measured, not human-seen), ${buckets.usdHostRender.length} usd-host-render (composition off-device), ${buckets.structuralOnly.length} structural/logcat only (appearance unconfirmed), ${buckets.builtForHeadset.length} built for headset`;
  return { appName: appName ?? null, summary, matrix: buckets, markdown: md };
}

export function registerCapabilityTools(server: McpServer) {
  server.registerTool(
    "capability_report",
    {
      description:
        "Emit an honest capability matrix gated by VISUAL GROUND TRUTH. Pass each feature with how it was verified: vision_verified/rendered_emulator (an agent CAPTURED a frame and SAW it render correctly — the only thing that counts as visually verified), logcat_asserted/decoded_real_data/compiles/structural (the thing EXISTS but its appearance is NOT confirmed), or built_for_headset (gated by an emulator ceiling C1-C4). Returns a structured matrix + markdown that keeps 'I saw it render' strictly separate from 'the code/logs say it exists', so a build report can never pass structural 'done' off as visual 'verified'.",
      inputSchema: {
        appName: z.string().optional().describe("App or build name for the report header."),
        features: z
          .array(
            z.object({
              name: z.string().describe("Feature, e.g. 'baked textured environment' or 'sense/plane surface pins'."),
              status: z
                .enum(["vision_verified", "rendered_emulator", "logcat_asserted", "decoded_real_data", "compiles", "structural", "built_for_headset"])
                .describe("How it was verified — be honest. Use vision_verified/rendered_emulator ONLY if an agent looked at a capture (capture_frame) and confirmed it renders."),
              evidence: z.string().optional().describe("The proof: for vision_verified, the capture path + what was seen; else a logcat line / 'xmllint well-formed' / etc."),
              ceiling: z.enum(["C1", "C2", "C3", "C4"]).optional().describe("The emulator ceiling gating this feature (for headset/blocked items)."),
            }),
          )
          .describe("Every feature in the build and how it was verified."),
      },
    },
    async ({ appName, features }) => {
      // v6.1: gate the legacy visual bucket the same way the ledger does — a vision_verified/
      // rendered_emulator status whose evidence isn't a real captured image is DOWNGRADED to structural,
      // so this older path can no longer print "seen rendering" for an unlinked/fake claim.
      const gated = features.map((f) => {
        if (f.status === "vision_verified" || f.status === "rendered_emulator") {
          const cap = validateCapture(extractImagePath(f.evidence));
          if (!cap.ok) return { ...f, status: "structural", evidence: `${f.evidence ?? "no evidence"} — DOWNGRADED (not a linked real capture: ${cap.reason})` };
        }
        return f;
      });
      return okJson(buildCapabilityMatrix(appName, gated));
    },
  );
}
