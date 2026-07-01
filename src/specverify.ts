import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema, type AppSpec } from "./appspec.js";
import { buildCapabilityMatrix } from "./capability.js";

/**
 * specverify.ts — v5.0 `verify_app_spec`: the plan-level GATE.
 *
 * Walks the AppSpec's verificationPlan and, per node: classifies by C-class, emits the exact emulator_look
 * pose + capture/assert directive the agent must run, and — critically — NEVER auto-passes a visual claim.
 * A C0/C2 capture claim can only reach verdict PASS if the agent submits a `result` whose verdict is PASS
 * AND that carries linked evidence (the capture path it actually LOOKED at); a PASS with no evidence is
 * REJECTED as an over-claim (the honesty rule the user has enforced, brought into the data model). C1/C3/C4
 * nodes are honestly DEFERRED_SWAN. Returns per-node verdicts, a spec-satisfaction score (fraction of
 * emulator-visual claims actually vision-verified), and an auto-derived capability_report.
 */

const CCLASS_TO_CEILING: Record<string, "C1" | "C2" | "C3" | "C4" | undefined> = {
  C0_emulator: undefined,
  C1: "C1",
  C2: "C2",
  C3: "C3",
  C4_headset_only: "C4",
};

function poseDirective(node: any): string {
  const p = node.forwardFOVpose;
  if (!p) return "no forwardFOVpose set";
  return `emulator_look(yaw=${p.yawDeg ?? 0}, pitch=${p.pitchDeg ?? 0}) then capture_frame; content ~z=${p.targetZ ?? -2.5}${p.note ? ` (${p.note})` : ""}`;
}

export function registerSpecVerifyTools(server: McpServer) {
  server.registerTool(
    "verify_app_spec",
    {
      description:
        "The plan-level verification gate for a built AppSpec. For each verificationPlan node it classifies by C-class, emits the exact emulator_look pose + capture/assert directive to run, and returns a per-node verdict. It NEVER auto-passes a visual claim: a C0/C2 capture claim reaches PASS only if you submit a `results` entry with verdict=PASS AND evidence (the capture path you actually LOOKED at) — a PASS with no evidence is REJECTED as an over-claim. C1/C3/C4 nodes are honestly DEFERRED_SWAN. Returns per-node verdicts, a spec-satisfaction score (fraction of emulator-visual claims vision-verified), the list of still-unverified visual claims, and an auto-derived capability_report. Call once to get the directives (no results), then again submitting what you LOOKED at.",
      inputSchema: {
        spec: z.any().describe("The built app's AppSpec."),
        applicationId: z.string().optional().describe("The running app's package (for assert_scene/dump_scene directives)."),
        results: z
          .array(
            z.object({
              claim: z.string().describe("Must match a verificationPlan node's claim."),
              verdict: z.enum(["PASS", "FAIL", "LOOK"]).describe("What you concluded after LOOKING/asserting."),
              evidence: z.string().optional().describe("REQUIRED for a visual PASS: the capture path + what you saw. Or the logcat/dump line for a structural PASS."),
            }),
          )
          .optional()
          .describe("What you LOOKED at / asserted. Omit on the first call to just get the directives."),
      },
    },
    async ({ spec: raw, applicationId, results }) => {
      const parsed = appSpecSchema.safeParse(raw);
      if (!parsed.success) return okJson({ status: "invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      const spec: AppSpec = parsed.data;
      const submitted = new Map((results ?? []).map((r) => [r.claim, r]));

      const perNode: any[] = [];
      const features: any[] = [];
      let visualTotal = 0;
      let visualPass = 0;
      const unverifiedVisual: string[] = [];

      for (const v of spec.verificationPlan) {
        const cls = v.capabilityClass;
        const ceiling = CCLASS_TO_CEILING[cls];
        const isVisualNow = cls === "C0_emulator" || cls === "C2";
        const r = submitted.get(v.claim);

        if (!isVisualNow) {
          perNode.push({ claim: v.claim, cClass: cls, verdict: "DEFERRED_SWAN", directive: `built-for-Swan (${cls}); re-verify on device (v5.9)` });
          features.push({ name: v.claim, status: "built_for_headset", evidence: `plan class ${cls}`, ceiling });
          continue;
        }

        // emulator-visual claim
        visualTotal++;
        const directive = v.method === "capture" ? poseDirective(v) : `${v.method} on ${applicationId ?? "<applicationId>"} — assert markers / dump_scene`;

        if (!r) {
          perNode.push({ claim: v.claim, cClass: cls, verdict: "PENDING_LOOK", directive });
          unverifiedVisual.push(v.claim);
          features.push({ name: v.claim, status: "structural", evidence: "not yet captured/looked" });
          continue;
        }
        if (r.verdict === "PASS") {
          const visualMethod = v.method === "capture" || v.method === "baseline";
          if (visualMethod && !r.evidence) {
            // OVER-CLAIM GUARD: a visual PASS with no linked capture is rejected.
            perNode.push({ claim: v.claim, cClass: cls, verdict: "REJECTED_NO_EVIDENCE", directive, message: "visual PASS needs a linked capture path you LOOKED at — rejected as an over-claim" });
            unverifiedVisual.push(v.claim);
            features.push({ name: v.claim, status: "structural", evidence: "PASS claimed without a capture — rejected" });
          } else {
            visualPass++;
            perNode.push({ claim: v.claim, cClass: cls, verdict: "PASS", evidence: r.evidence });
            features.push({ name: v.claim, status: visualMethod ? "vision_verified" : "logcat_asserted", evidence: r.evidence });
          }
        } else if (r.verdict === "FAIL") {
          perNode.push({ claim: v.claim, cClass: cls, verdict: "FAIL", evidence: r.evidence, directive: "→ diagnose(symptom) then replan_spec" });
          unverifiedVisual.push(v.claim);
          features.push({ name: v.claim, status: "structural", evidence: r.evidence ?? "failed" });
        } else {
          perNode.push({ claim: v.claim, cClass: cls, verdict: "LOOK", directive, evidence: r.evidence });
          unverifiedVisual.push(v.claim);
          features.push({ name: v.claim, status: "structural", evidence: "inconclusive — LOOK again" });
        }
      }

      // Fold in the built-for-Swan pieces so the report is honest even if the agent didn't add a
      // verification node for each (a controller-ray path / headset layer is BUILT, not verified-now).
      const coveredClaims = new Set(spec.verificationPlan.map((v) => v.claim));
      for (const h of spec.headsetLayer) {
        const name = `headset: ${h.feature}`;
        if (!coveredClaims.has(name)) features.push({ name, status: "built_for_headset", evidence: `plan class ${h.capabilityClass}`, ceiling: CCLASS_TO_CEILING[h.capabilityClass] });
      }

      const specSatisfaction = visualTotal ? visualPass / visualTotal : 1;
      const report = buildCapabilityMatrix(spec.meta.appName, features);
      const gate = unverifiedVisual.length === 0 && visualTotal > 0 ? "PASS" : visualTotal === 0 ? "NO_VISUAL_CLAIMS" : "INCOMPLETE";
      return okJson({
        status: gate,
        specSatisfaction: Number(specSatisfaction.toFixed(3)),
        visualClaims: { total: visualTotal, passed: visualPass },
        unverifiedVisualClaims: unverifiedVisual,
        perNode,
        capabilityReport: report,
        note: gate === "PASS"
          ? "All emulator-visual claims vision-verified with linked evidence; headset claims deferred to Swan (honest)."
          : "NOT shippable yet — run the directives, LOOK at each capture, and resubmit results with evidence. Honest deferral of C1/C3/C4 is fine; silent over-claim is the only hard failure.",
      });
    },
  );
}
