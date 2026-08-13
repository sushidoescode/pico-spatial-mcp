import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, okJsonStructured } from "./util.js";
import { validateCapture, extractImagePath } from "./evidence.js";

/**
 * capability_report — the v3.1 honesty primitive. Takes the features an agent built + HOW each was
 * verified, and emits the truthful "verified-on-emulator vs built-for-headset" matrix the user
 * enforces (no more code-level "verified" passed off as experience-level). Bakes in the 4 proven
 * emulator ceilings (C1-C4, 2026-06-14) so every headset-gated feature carries its reason.
 */

const CEILINGS: Record<string, string> = {
  C1: "Scene-understanding planes and meshes work on the emulator in Full Space. Tracked runtime probes observed 43 semantic planes and 42–44 mesh anchors with triangle data. The earlier 0-mesh result was superseded: tracking can report RUNNING before anchors are ready, so poll for non-empty results; one recorded implementation also required subscribing before start(). These are emulator-simulation measurements, not Swan real-room measurements.",
  C2: "The GUI free-cam orbit is decoupled and can drift across launches. adb screencap has produced byte-stable forward frames for native Spatial SDK and some immersive runs, but that behavior is not universal: a black adb frame is inconclusive and a later OpenXR run contradicted the old XR-always-black rule. LOOK at the returned pixels; when the intended app view is absent, use an alternate host-window capture and LOOK again. A linked looked-at capture is required for vision_verified.",
  C3: "No controller/gaze pointer on the emulator. Interactions are verifiable headlessly: broadcast (adb am broadcast) drives them, a `press` interaction compiles to the clickable GameMenu (mouse bridge = real clicks). Only controller_ray/grab motion remains genuinely Swan-only.",
  C4: "Stage-vs-window dichotomy: no native config gives room + spatial pins + in-front interactive panels together.",
};

// status -> bucket + label. THE GROUND-TRUTH RULE (the user enforces this): only a feature an agent
// has SEEN render correctly (a capture inspected with vision) counts as visually verified. Code
// compiling, logcat markers, and structural decodes prove a thing EXISTS, never that it LOOKS right.
// So logcat/structural/decoded land in "structuralOnly" — NOT a visual "verified".
const STATUS_META: Record<string, { bucket: "deviceVerified" | "visuallyVerified" | "autoJudged" | "usdHostRender" | "structuralOnly" | "builtForHeadset"; label: string }> = {
  device_verified: { bucket: "deviceVerified", label: "SEEN in a same-serial capture from a live PICO-shaped, non-emulator adb identity (not cryptographic device attestation)" },
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
  "provenance-broken": { bucket: "structuralOnly", label: "PROVENANCE BROKEN — recorded visual evidence is missing or no longer matches its recorded hash; no visual claim survives" },
  built_for_headset: { bucket: "builtForHeadset", label: "built; runtime verification needs a PICO Swan headset" },
};

/** Build the honest verified-vs-built matrix from features. Shared by capability_report + the loop (build_and_run/iterate_scene auto-emit). */
export function buildCapabilityMatrix(appName: string | undefined, features: any[]): { appName: string | null; summary: string; matrix: any; markdown: string } {
  const buckets = {
    deviceVerified: [] as any[],
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
      ...(f.status === "device_verified" ? {
        deviceIdentity: {
          serial: f.deviceSerial,
          model: f.deviceModel,
          fingerprint: f.deviceFingerprint,
          bootQemu: f.deviceBootQemu,
        },
      } : {}),
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
    `## 🥽 Device verified — seen on validated PICO hardware lineage (${buckets.deviceVerified.length})`,
    ...(buckets.deviceVerified.length ? buckets.deviceVerified.map(line) : ["_(none)_"]),
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
  const summary = `${buckets.deviceVerified.length} device verified (looked capture + validated hardware lineage), ${buckets.visuallyVerified.length} visually verified, ${buckets.autoJudged.length} auto-judged (measured, not human-seen), ${buckets.usdHostRender.length} usd-host-render (composition off-device), ${buckets.structuralOnly.length} structural/logcat only (appearance unconfirmed), ${buckets.builtForHeadset.length} built for headset`;
  return { appName: appName ?? null, summary, matrix: buckets, markdown: md };
}

/** One matrix row (buildCapabilityMatrix's `entry` shape): ceiling fields appear only on gated items. */
const capabilityFeatureShape = z.object({
  name: z.string(),
  how: z.string(),
  evidence: z.string().nullable(),
  ceiling: z.string().optional(),
  ceilingReason: z.string().optional(),
  deviceIdentity: z.object({
    serial: z.string(),
    model: z.string(),
    fingerprint: z.string(),
    bootQemu: z.string(),
  }).optional(),
}).passthrough();

export function registerCapabilityTools(server: McpServer) {
  server.registerTool(
    "capability_report",
    {
      description:
        "Emit a caller-supplied capability matrix gated by VISUAL GROUND TRUTH. This legacy report can accept a linked human-looked vision_verified row, but cannot authenticate producer-specific device_verified, auto_judged, or usd_host_render provenance; those requests are downgraded to structural with the correct producer route. Ledger-generated reports preserve those tiers after their producer gates.",
      inputSchema: {
        appName: z.string().optional().describe("App or build name for the report header."),
        features: z
          .array(
            z.object({
              name: z.string().describe("Feature, e.g. 'baked textured environment' or 'sense/plane surface pins'."),
              status: z
                .enum(["device_verified", "vision_verified", "rendered_emulator", "auto_judged", "usd_host_render", "logcat_asserted", "decoded_real_data", "compiles", "structural", "built_for_headset"])
                .describe("How it was verified. Producer-specific device_verified/auto_judged/usd_host_render values are accepted only to return an explicit structural downgrade; use their named producer tools."),
              evidence: z.string().optional().describe("The proof: for vision_verified, the capture path + what was seen; else a logcat line / 'xmllint well-formed' / etc."),
              ceiling: z.enum(["C1", "C2", "C3", "C4"]).optional().describe("The emulator ceiling gating this feature (for headset/blocked items)."),
            }),
          )
          .describe("Every feature in the build and how it was verified."),
      },
      // Typed contract (2026-07-28 revision lane, works on SDK v1). One bucket per evidence tier;
      // the tiers stay structurally separate so "seen rendering" can never absorb "code exists".
      outputSchema: {
        appName: z.string().nullable(),
        summary: z.string().describe("One-line bucket counts, strongest evidence first."),
        matrix: z.object({
          deviceVerified: z.array(capabilityFeatureShape).describe("An agent LOOKED at a same-serial device capture and its live raw adb identity passed the PICO-shaped/non-emulator lineage gate; this is not cryptographic device attestation."),
          visuallyVerified: z.array(capabilityFeatureShape).describe("An agent LOOKED at a linked capture."),
          autoJudged: z.array(capabilityFeatureShape).describe("Calibrated eye scored it — measured, not human-seen."),
          usdHostRender: z.array(capabilityFeatureShape).describe("Off-device USD composition render."),
          structuralOnly: z.array(capabilityFeatureShape).describe("Exists per code/logs; appearance unconfirmed."),
          builtForHeadset: z.array(capabilityFeatureShape).describe("Compiles for Swan-only capability; deferred honestly."),
        }),
        markdown: z.string().describe("The same matrix rendered for humans."),
      },
    },
    async ({ appName, features }) => {
      // Gate every image-grounded bucket — including the two buckets now accepted by the input
      // contract — so this legacy caller-supplied path cannot publish an unlinked image claim.
      const gated = features.map((f) => {
        if (["device_verified", "vision_verified", "rendered_emulator", "auto_judged", "usd_host_render"].includes(f.status)) {
          const cap = validateCapture(extractImagePath(f.evidence));
          if (!cap.ok) return { ...f, status: "structural", evidence: `${f.evidence ?? "no evidence"} — DOWNGRADED (not a linked real capture: ${cap.reason})` };
        }
        if (f.status === "device_verified") return { ...f, status: "structural", evidence: `${f.evidence ?? "no evidence"} — DOWNGRADED (caller-supplied capability_report has no producer provenance; use record_verification so the server probes adb identity live)` };
        if (f.status === "auto_judged") return { ...f, status: "structural", evidence: `${f.evidence ?? "no evidence"} — DOWNGRADED (caller-supplied capability_report has no producer provenance; use visual_judge to measure and record a PASS)` };
        if (f.status === "usd_host_render") return { ...f, status: "structural", evidence: `${f.evidence ?? "no evidence"} — DOWNGRADED (caller-supplied capability_report has no producer provenance; use render_usd_offscreen to render and record)` };
        return f;
      });
      return okJsonStructured(buildCapabilityMatrix(appName, gated));
    },
  );
}
