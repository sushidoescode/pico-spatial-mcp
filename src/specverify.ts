import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema, type AppSpec } from "./appspec.js";
import { buildCapabilityMatrix } from "./capability.js";
import { effectiveNodeClass } from "./planner.js";
import { validateCapture, extractImagePath } from "./evidence.js";

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
        "The plan-level verification gate for a built AppSpec. For each verificationPlan node it classifies by C-class (RECONCILED from the target — a mislabeled Swan-only node can't pose as emulator-verifiable, v6.1), emits the exact emulator_look pose + capture/assert directive, and returns a per-node verdict. It NEVER auto-passes a visual claim: a C0/C2 capture claim reaches PASS only if you submit a `results` entry with verdict=PASS AND evidence containing a path to a REAL PNG/JPEG frame that exists (a bare string like 'looks good' is REJECTED as an over-claim, v6.1). C1/C3/C4 nodes are honestly DEFERRED_SWAN. Returns per-node verdicts, a capture-scoped spec-satisfaction score (vision claims only — logcat/dump assertions are reported separately, never as vision), the still-unverified claims, and an auto-derived capability_report. Call once to get the directives (no results), then again submitting what you LOOKED at.",
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
      // v6.1: track truly-visual (capture/baseline) claims separately from logcat/dump assertions, so
      // specSatisfaction and the PASS note don't count evidence-less assertions as "vision-verified".
      let captureTotal = 0;
      let capturePass = 0;
      const unverifiedVisual: string[] = [];

      for (const v of spec.verificationPlan) {
        // v6.1: use the RECONCILED class (stricter of declared vs computed) so a mislabeled C3→C0
        // node is treated as Swan-only here too, even if plan_app_spec was bypassed.
        const cls = effectiveNodeClass(spec, v);
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
        const isCaptureMethod = v.method === "capture" || v.method === "baseline";
        if (isCaptureMethod) captureTotal++;
        const directive = v.method === "capture" ? poseDirective(v) : `${v.method} on ${applicationId ?? "<applicationId>"} — assert markers / dump_scene`;

        if (!r) {
          perNode.push({ claim: v.claim, cClass: cls, verdict: "PENDING_LOOK", directive });
          unverifiedVisual.push(v.claim);
          features.push({ name: v.claim, status: "structural", evidence: "not yet captured/looked" });
          continue;
        }
        if (r.verdict === "PASS") {
          const visualMethod = v.method === "capture" || v.method === "baseline";
          // v6.1 OVER-CLAIM GUARD: a visual PASS must link a real CAPTURED IMAGE, not just any string.
          // Previously any truthy `evidence` string passed (ADVERSARIAL_FINDINGS C2). Now the evidence must
          // contain a path to a valid PNG/JPEG frame that exists.
          const imgPath = visualMethod ? extractImagePath(r.evidence) : undefined;
          const cap = visualMethod ? validateCapture(imgPath) : { ok: true };
          if (visualMethod && !cap.ok) {
            perNode.push({ claim: v.claim, cClass: cls, verdict: "REJECTED_NO_EVIDENCE", directive, message: `visual PASS needs a linked capture path you LOOKED at (a real PNG/JPEG frame) — rejected as an over-claim. ${(cap as any).reason ?? (r.evidence ? "evidence has no image path" : "no evidence")}` });
            unverifiedVisual.push(v.claim);
            features.push({ name: v.claim, status: "structural", evidence: "PASS claimed without a real capture — rejected" });
          } else {
            visualPass++;
            if (visualMethod) capturePass++;
            perNode.push({ claim: v.claim, cClass: cls, verdict: "PASS", evidence: r.evidence, ...(visualMethod ? { captureSha: (cap as any).sha256 } : {}) });
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

      // specSatisfaction is scoped to truly-visual (capture/baseline) claims — the ones that carry the
      // "vision-verified" meaning. Assertion (logcat/dump) claims are reported separately, never as vision.
      const specSatisfaction = captureTotal ? capturePass / captureTotal : 1;
      const assertionClaims = { total: visualTotal - captureTotal, passed: visualPass - capturePass };
      const report = buildCapabilityMatrix(spec.meta.appName, features);
      const gate = unverifiedVisual.length === 0 && visualTotal > 0 ? "PASS" : visualTotal === 0 ? "NO_VISUAL_CLAIMS" : "INCOMPLETE";
      return okJson({
        status: gate,
        specSatisfaction: Number(specSatisfaction.toFixed(3)),
        captureClaims: { total: captureTotal, passed: capturePass },
        assertionClaims,
        unverifiedVisualClaims: unverifiedVisual,
        perNode,
        capabilityReport: report,
        note: gate === "PASS"
          ? `${capturePass}/${captureTotal} capture claim(s) vision-verified with a linked real frame; ${assertionClaims.passed}/${assertionClaims.total} assertion (logcat/dump) claim(s) asserted (EXISTS, not vision); headset claims deferred to Swan (honest).`
          : "NOT shippable yet — run the directives, LOOK at each capture, and resubmit results with a linked PNG/JPEG frame path. Honest deferral of C1/C3/C4 is fine; silent over-claim is the only hard failure.",
      });
    },
  );
}
