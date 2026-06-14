import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

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

// status -> how strong the evidence is, and whether it counts as emulator-verified.
const STATUS_META: Record<string, { bucket: "verifiedOnEmulator" | "builtForHeadset" | "compiledOnly"; label: string }> = {
  rendered_emulator: { bucket: "verifiedOnEmulator", label: "rendered/observed on emulator" },
  logcat_asserted: { bucket: "verifiedOnEmulator", label: "asserted in logcat on emulator" },
  decoded_real_data: { bucket: "verifiedOnEmulator", label: "verified against real project data" },
  compiles: { bucket: "compiledOnly", label: "compiles (no runtime behaviour verified)" },
  structural: { bucket: "compiledOnly", label: "structurally valid (parses/well-formed) only" },
  built_for_headset: { bucket: "builtForHeadset", label: "built; runtime verification needs a PICO Swan headset" },
};

export function registerCapabilityTools(server: McpServer) {
  server.registerTool(
    "capability_report",
    {
      description:
        "Emit an honest verified-on-emulator vs built-for-headset capability matrix for a build. Pass each feature with how it was verified (rendered_emulator | logcat_asserted | decoded_real_data | compiles | structural | built_for_headset) and, for headset/blocked items, the emulator ceiling that gates it (C1 no scene-understanding, C2 no headless capture, C3 no controller/trigger, C4 stage-vs-window). Returns a structured matrix + a markdown report + the ceiling glossary, so a build report never passes code-level 'done' off as experience-level 'verified'.",
      inputSchema: {
        appName: z.string().optional().describe("App or build name for the report header."),
        features: z
          .array(
            z.object({
              name: z.string().describe("Feature, e.g. 'baked textured environment' or 'sense/plane surface pins'."),
              status: z
                .enum(["rendered_emulator", "logcat_asserted", "decoded_real_data", "compiles", "structural", "built_for_headset"])
                .describe("How it was verified — be honest."),
              evidence: z.string().optional().describe("The proof, e.g. a logcat line, capture path, or 'xmllint well-formed'."),
              ceiling: z.enum(["C1", "C2", "C3", "C4"]).optional().describe("The emulator ceiling gating this feature (for headset/blocked items)."),
            }),
          )
          .describe("Every feature in the build and how it was verified."),
      },
    },
    async ({ appName, features }) => {
      const buckets = {
        verifiedOnEmulator: [] as any[],
        compiledOnly: [] as any[],
        builtForHeadset: [] as any[],
      };
      for (const f of features) {
        const meta = STATUS_META[f.status];
        const entry = {
          name: f.name,
          how: meta.label,
          evidence: f.evidence ?? null,
          ...(f.ceiling ? { ceiling: f.ceiling, ceilingReason: CEILINGS[f.ceiling] } : {}),
        };
        buckets[meta.bucket].push(entry);
      }

      const usedCeilings = Array.from(
        new Set(features.map((f) => f.ceiling).filter(Boolean) as string[]),
      ).sort();

      const line = (e: any) =>
        `- **${e.name}** — ${e.how}${e.evidence ? ` (${e.evidence})` : ""}${e.ceiling ? ` _[${e.ceiling}]_` : ""}`;
      const md = [
        `# Capability report${appName ? `: ${appName}` : ""}`,
        ``,
        `## ✅ Verified on emulator (${buckets.verifiedOnEmulator.length})`,
        ...(buckets.verifiedOnEmulator.length ? buckets.verifiedOnEmulator.map(line) : ["_(none)_"]),
        ``,
        `## ⚙️ Compiled / structural only (${buckets.compiledOnly.length})`,
        ...(buckets.compiledOnly.length ? buckets.compiledOnly.map(line) : ["_(none)_"]),
        ``,
        `## 🟡 Built for headset — verify on PICO Swan (${buckets.builtForHeadset.length})`,
        ...(buckets.builtForHeadset.length ? buckets.builtForHeadset.map(line) : ["_(none)_"]),
        ...(usedCeilings.length ? [``, `## Emulator ceilings referenced`, ...usedCeilings.map((c) => `- **${c}**: ${CEILINGS[c]}`)] : []),
      ].join("\n");

      const summary = `${buckets.verifiedOnEmulator.length} verified on emulator, ${buckets.compiledOnly.length} compiled/structural only, ${buckets.builtForHeadset.length} built for headset`;
      return okJson({ appName: appName ?? null, summary, matrix: buckets, markdown: md });
    },
  );
}
