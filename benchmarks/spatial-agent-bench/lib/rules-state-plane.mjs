const RULE_IDS = Object.freeze([
  "state.single-source",
  "state.typed-handoff",
  "state.shared-read-write",
  "state.reopen-wiring",
  "plane.retry-readiness",
  "plane.semantic-fallback",
  "plane.anchor-pose",
  "plane.cleanup-errors",
]);

function rejectedReason(context) {
  return `supported-subset-v1 rejected: ${context.rejectionCode}`;
}

function evaluateClaim(context, id) {
  if (context.analysisStatus === "rejected") {
    return { id, pass: false, evidence: [], reason: rejectedReason(context) };
  }
  const claim = context.claimsById.get(id);
  if (!claim) return { id, pass: false, evidence: [], reason: "supported-subset-v1 claim absent" };
  if (!claim.representable) {
    return { id, pass: false, evidence: [], reason: "supported-subset-v1 witness unrepresentable" };
  }
  return {
    id,
    pass: true,
    evidence: claim.sourceEvidence,
    reason: `supported-subset-v1 witness: ${claim.proofForm}`,
  };
}

export function evaluateStatePlaneRules(context) {
  return RULE_IDS.map((id) => evaluateClaim(context, id));
}
