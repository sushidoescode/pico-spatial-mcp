import crypto from "node:crypto";
import path from "node:path";
import { canonicalJson } from "./identity.mjs";
import {
  RULE_DEFINITIONS,
  RESULT_SCHEMA_VERSION,
  RUBRIC_VERSION,
  createDefaultRuntimeProtocolReceipts,
  createDefaultSubmissionTests,
  validateBuildQualification,
  validateScoreResultV2,
  validateSubmissionTests,
} from "./contract.mjs";
import { ANALYZER_CONSTANTS, analyzeKotlin } from "./kotlin-analysis.mjs";
import { loadSubmissionSources } from "./source.mjs";
import { evaluateSpatialRules } from "./rules-spatial.mjs";
import { evaluateStatePlaneRules } from "./rules-state-plane.mjs";

const HASH = /^[a-f0-9]{64}$/;
const RESPONSE_KEYS = Object.freeze(["protocolVersion", "subsetVersion", "command", "analysisStatus", "rejectionCode", "kotlinInputSetSha256", "files", "constants", "nodes", "claims"]);
const FILE_KEYS = Object.freeze(["bytes", "path", "sha256"]);
const NODE_KEYS = Object.freeze(["nodeId", "path", "fileSha256", "startUtf16", "endUtf16", "kind", "textSha256", "structuralToken"]);
const CLAIM_KEYS = Object.freeze(["ruleId", "proofForm", "witnessNodeIds", "witnessDigest"]);
const RULE_IDS = Object.freeze(RULE_DEFINITIONS.map(([id]) => id));
const WITNESS_KINDS = new Set([
  "declaration", "callable_reference", "call", "argument", "property_read", "assignment",
  "condition", "loop", "lambda", "return", "type_reference", "catch",
]);
const REJECTION_CODES = new Set(["parse", "unsupported_script", "ambiguous_index", "incomplete_imports", "limit", "internal_uncertainty"]);
const WITNESS_CAPS = Object.freeze([11, 16, 14, 12, 16, 11, 12, 11, 12, 24, 12, 24, 10, 25, 20, 22]);
const PROOF_FORMS_BY_RULE = Object.freeze({
  "spatial.project-entry": Object.freeze(["application-launch-root"]),
  "spatial.container-topology": Object.freeze(["direct-mixed-stage-open", "one-helper-mixed-stage-open", "two-helper-mixed-stage-open"]),
  "spatial.entity-content": Object.freeze(["spatial-view-entity-attachment"]),
  "spatial.ui-lifecycle": Object.freeze(["themed-window-and-disposable-stage"]),
  "ecs.component-clone": Object.freeze(["expression-component-clone", "single-return-block-component-clone"]),
  "ecs.system-query": Object.freeze(["hoisted-query-scene-update"]),
  "ecs.frame-update": Object.freeze(["assign-delta-update", "plus-assign-delta-update"]),
  "ecs.lifecycle": Object.freeze(["paired-system-lifecycle"]),
  "state.single-source": Object.freeze(["shared-strong-authority"]),
  "state.typed-handoff": Object.freeze(["typed-bundle-roundtrip"]),
  "state.shared-read-write": Object.freeze(["same-authority-read-write"]),
  "state.reopen-wiring": Object.freeze(["retained-state-close-reopen"]),
  "plane.retry-readiness": Object.freeze(["bounded-retained-load-retry"]),
  "plane.semantic-fallback": Object.freeze(["dominating-semantic-plane-fallback"]),
  "plane.anchor-pose": Object.freeze(["same-anchor-pose-conversion"]),
  "plane.cleanup-errors": Object.freeze(["paired-plane-cleanup-status"]),
});

function snapshotInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new Error("score input must be a canonical plain object");
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) throw new Error("score input must not contain symbol keys");
  const allowed = new Set(["projectDir", "build", "submissionTests"]);
  if (!keys.includes("projectDir") || !keys.includes("build") || keys.some((key) => !allowed.has(key))) throw new Error("score input contains unknown or missing keys");
  const values = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error(`score input ${key} must be an enumerable own data property`);
    values[key] = descriptor.value;
  }
  if (typeof values.projectDir !== "string" || !path.isAbsolute(values.projectDir)) throw new Error("score input projectDir must be an absolute path");
  const build = validateBuildQualification(values.build);
  const submissionTests = Object.hasOwn(values, "submissionTests")
    ? validateSubmissionTests(values.submissionTests, build.status)
    : createDefaultSubmissionTests(build.status);
  return Object.freeze({ projectDir: values.projectDir, build, submissionTests });
}

function provenanceFailure(message) {
  throw new Error(`public analyzer provenance rejected: ${message}`);
}

function assertClosedRecord(value, expectedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) provenanceFailure(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    provenanceFailure(`${label} has an unknown or missing key`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) provenanceFailure(`${label}.${key} must be an enumerable data property`);
  }
}

function assertDenseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) provenanceFailure(`${label} must be an array`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) provenanceFailure(`${label} must be dense`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) provenanceFailure(`${label}[${index}] must be an enumerable data property`);
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function splitSurrogateBoundary(source, offset) {
  if (offset <= 0 || offset >= source.length) return false;
  const left = source.charCodeAt(offset - 1);
  const right = source.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

function indexedKotlinFiles(index) {
  if (!index || !Array.isArray(index.files)) provenanceFailure("source index is invalid");
  return index.files.filter((file) => file?.kind === "kotlin").map((file, fileIndex) => {
    if (typeof file.path !== "string" || typeof file.original !== "string" || typeof file.structural !== "string") {
      provenanceFailure(`indexed Kotlin file ${fileIndex} is invalid`);
    }
    if (file.original.length !== file.structural.length) provenanceFailure(`indexed Kotlin file ${file.path} has a non-isomorphic structural mask`);
    const bytes = Buffer.from(file.original, "utf8");
    return { file, path: file.path, bytes: bytes.length, sha256: sha256(bytes) };
  }).sort((left, right) => compareUtf8(left.path, right.path));
}

function projectedSourceEvidence(witnesses) {
  const distinct = new Map();
  let representable = true;
  for (const node of witnesses) {
    const line = node.file.structural.slice(0, node.startUtf16).split(/\r?\n/).length;
    const excerpt = node.file.structural.split(/\r?\n/)[line - 1]?.trim() ?? "";
    if (excerpt.length === 0 || Buffer.byteLength(excerpt, "utf8") > 512) representable = false;
    const key = canonicalJson([node.path, line]);
    if (!distinct.has(key)) distinct.set(key, { evidenceClass: "source", path: node.path, line, excerpt });
  }
  return {
    representable,
    sourceEvidence: representable ? Object.freeze([...distinct.values()].map(Object.freeze)) : Object.freeze([]),
  };
}

function validateAnalyzerResponse(index, response) {
  assertClosedRecord(response, RESPONSE_KEYS, "response");
  assertDenseArray(response.files, "response.files");
  assertDenseArray(response.nodes, "response.nodes");
  assertDenseArray(response.claims, "response.claims");
  if (response.protocolVersion !== 1 || response.subsetVersion !== 1 || response.command !== "analyze" || response.constants !== null) {
    provenanceFailure("response protocol or command is invalid");
  }
  if (!new Set(["accepted", "rejected"]).has(response.analysisStatus)) provenanceFailure("response analysisStatus is invalid");

  const kotlin = indexedKotlinFiles(index);
  const receipts = kotlin.map(({ path: filePath, bytes, sha256: digest }) => ({ path: filePath, bytes, sha256: digest }));
  for (const [fileIndex, receipt] of response.files.entries()) assertClosedRecord(receipt, FILE_KEYS, `response.files[${fileIndex}]`);
  if (canonicalJson(response.files) !== canonicalJson(receipts)) provenanceFailure("response file receipts do not match the submitted Kotlin files");
  const inputDigest = sha256(Buffer.from(canonicalJson(receipts), "utf8"));
  if (response.kotlinInputSetSha256 !== inputDigest) provenanceFailure("Kotlin input digest does not match the submitted index");

  if (response.analysisStatus === "rejected") {
    if (!REJECTION_CODES.has(response.rejectionCode) || response.nodes.length !== 0 || response.claims.length !== 0) {
      provenanceFailure("rejected response status or empty semantics is invalid");
    }
    return Object.freeze({
      analysisStatus: "rejected",
      rejectionCode: response.rejectionCode,
      claimsById: new Map(),
    });
  }
  if (response.rejectionCode !== null) provenanceFailure("accepted response has a rejection code");
  if (response.nodes.length > ANALYZER_CONSTANTS.MAX_RESPONSE_NODES || response.claims.length > ANALYZER_CONSTANTS.MAX_CLAIMS) {
    provenanceFailure("accepted response exceeds public analyzer bounds");
  }

  const indexedByPath = new Map();
  for (const row of kotlin) {
    const matches = indexedByPath.get(row.path) ?? [];
    matches.push(row);
    indexedByPath.set(row.path, matches);
  }
  const nodesById = new Map();
  let previousNodeId = null;
  for (const [nodeIndex, node] of response.nodes.entries()) {
    assertClosedRecord(node, NODE_KEYS, `response.nodes[${nodeIndex}]`);
    if (!HASH.test(node.nodeId) || !HASH.test(node.fileSha256) || !HASH.test(node.textSha256)) provenanceFailure(`node ${nodeIndex} has an invalid digest`);
    if (!WITNESS_KINDS.has(node.kind) || typeof node.structuralToken !== "boolean") provenanceFailure(`node ${nodeIndex} has invalid witness vocabulary`);
    if (previousNodeId !== null && compareUtf8(previousNodeId, node.nodeId) >= 0) provenanceFailure("node catalog is not sorted and unique");
    previousNodeId = node.nodeId;
    const matches = indexedByPath.get(node.path) ?? [];
    if (matches.length !== 1) provenanceFailure("node path does not resolve to exactly one indexed Kotlin file");
    const source = matches[0];
    if (node.fileSha256 !== source.sha256) provenanceFailure("node file hash does not match the submitted Kotlin file");
    if (!Number.isSafeInteger(node.startUtf16) || !Number.isSafeInteger(node.endUtf16)
        || node.startUtf16 < 0 || node.endUtf16 <= node.startUtf16 || node.endUtf16 > source.file.original.length) {
      provenanceFailure("node UTF-16 span is out of bounds or reversed");
    }
    if (splitSurrogateBoundary(source.file.original, node.startUtf16) || splitSurrogateBoundary(source.file.original, node.endUtf16)) {
      provenanceFailure("node UTF-16 span splits a surrogate pair");
    }
    const originalSpan = source.file.original.slice(node.startUtf16, node.endUtf16);
    if (sha256(Buffer.from(originalSpan, "utf8")) !== node.textSha256) provenanceFailure("node substring hash does not match the exact source span");
    const identity = {
      path: node.path,
      fileSha256: node.fileSha256,
      startUtf16: node.startUtf16,
      endUtf16: node.endUtf16,
      kind: node.kind,
      textSha256: node.textSha256,
      structuralToken: node.structuralToken,
    };
    if (sha256(Buffer.from(canonicalJson(identity), "utf8")) !== node.nodeId) provenanceFailure("node ID does not match its canonical identity");
    const structuralSpan = source.file.structural.slice(node.startUtf16, node.endUtf16);
    if (node.structuralToken && structuralSpan.trim().length === 0) provenanceFailure("structural witness span is wholly masked");
    if (!node.structuralToken && node.kind !== "argument") provenanceFailure("nonstructural witness is not an argument");
    nodesById.set(node.nodeId, Object.freeze({ ...node, file: source.file }));
  }

  const union = new Set();
  const validatedClaims = [];
  let previousRuleIndex = -1;
  let totalWitnesses = 0;
  for (const [claimIndex, claim] of response.claims.entries()) {
    assertClosedRecord(claim, CLAIM_KEYS, `response.claims[${claimIndex}]`);
    const ruleIndex = RULE_IDS.indexOf(claim.ruleId);
    if (ruleIndex < 0 || ruleIndex <= previousRuleIndex) provenanceFailure("claims are not unique and ordered by the public rule domain");
    previousRuleIndex = ruleIndex;
    if (typeof claim.proofForm !== "string" || claim.proofForm.length === 0
        || Buffer.byteLength(claim.proofForm, "utf8") > 512 || claim.proofForm.includes("\n") || claim.proofForm.includes("\r")) {
      provenanceFailure(`claim ${claimIndex} has an invalid proof form`);
    }
    if (!PROOF_FORMS_BY_RULE[claim.ruleId].includes(claim.proofForm)) {
      provenanceFailure(`claim ${claimIndex} proof form is outside the public rule domain`);
    }
    assertDenseArray(claim.witnessNodeIds, `response.claims[${claimIndex}].witnessNodeIds`);
    if (claim.witnessNodeIds.length < 1 || claim.witnessNodeIds.length > WITNESS_CAPS[ruleIndex]
        || claim.witnessNodeIds.length > ANALYZER_CONSTANTS.MAX_WITNESSES_PER_CLAIM) {
      provenanceFailure(`claim ${claimIndex} has an invalid witness count`);
    }
    const witnesses = [];
    let previousWitnessId = null;
    let hasStructuralWitness = false;
    for (const witnessNodeId of claim.witnessNodeIds) {
      if (!HASH.test(witnessNodeId) || (previousWitnessId !== null && compareUtf8(previousWitnessId, witnessNodeId) >= 0)) {
        provenanceFailure(`claim ${claimIndex} witness IDs are invalid or unsorted`);
      }
      previousWitnessId = witnessNodeId;
      const node = nodesById.get(witnessNodeId);
      if (!node) provenanceFailure(`claim ${claimIndex} witness does not resolve into the node catalog`);
      if (node.structuralToken) hasStructuralWitness = true;
      else if (node.kind !== "argument") provenanceFailure(`claim ${claimIndex} has an invalid nonstructural witness`);
      witnesses.push(node);
      union.add(witnessNodeId);
    }
    if (!hasStructuralWitness) provenanceFailure(`claim ${claimIndex} has no authenticated structural witness`);
    totalWitnesses += witnesses.length;
    if (totalWitnesses > ANALYZER_CONSTANTS.MAX_TOTAL_WITNESSES) provenanceFailure("claim witness union exceeds the public bound");
    const digestMaterial = { ruleId: claim.ruleId, proofForm: claim.proofForm, witnessNodeIds: claim.witnessNodeIds };
    if (!HASH.test(claim.witnessDigest) || sha256(Buffer.from(canonicalJson(digestMaterial), "utf8")) !== claim.witnessDigest) {
      provenanceFailure(`claim ${claimIndex} witness digest is invalid`);
    }
    validatedClaims.push(Object.freeze({
      ruleId: claim.ruleId,
      proofForm: claim.proofForm,
      witnessDigest: claim.witnessDigest,
      witnesses: Object.freeze(witnesses),
    }));
  }
  const expectedCatalog = [...union].sort(compareUtf8);
  if (canonicalJson(response.nodes.map((node) => node.nodeId)) !== canonicalJson(expectedCatalog)) {
    provenanceFailure("node catalog is not the exact claim-witness union");
  }
  const claimsById = new Map();
  for (const claim of validatedClaims) {
    const projected = projectedSourceEvidence(claim.witnesses);
    claimsById.set(claim.ruleId, Object.freeze({
      ...claim,
      representable: projected.representable,
      sourceEvidence: projected.sourceEvidence,
    }));
  }
  return Object.freeze({ analysisStatus: "accepted", rejectionCode: null, claimsById });
}

function evidenceTuple(row) {
  return [row.evidenceClass, row.path, row.line, row.kind ?? "", row.scope ?? "", row.activityName ?? "", row.key ?? "", row.value ?? "", row.excerpt];
}

function compareTuples(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function normalizeEvidence(rows) {
  const unique = new Map();
  for (const row of rows) unique.set(canonicalJson(evidenceTuple(row)), row);
  return [...unique.values()].sort((left, right) => compareTuples(evidenceTuple(left), evidenceTuple(right)));
}

function assertEvidenceProvenance(index, rules) {
  const sourceLines = new Map(index.files.map((file) => [file.path, file.structural.split(/\r?\n/)]));
  const typedFacts = new Set(index.factEvidence.map((fact) => canonicalJson(fact)));
  for (const rule of rules) {
    for (const row of rule.evidence) {
      if (row.evidenceClass === "source") {
        const lines = sourceLines.get(row.path);
        if (!lines || lines[row.line - 1]?.trim() !== row.excerpt) throw new Error(`source evidence provenance mismatch for ${rule.id}`);
      } else {
        const fact = { ...row };
        delete fact.evidenceClass;
        if (!typedFacts.has(canonicalJson(fact))) throw new Error(`typed-fact evidence provenance mismatch for ${rule.id}`);
      }
    }
  }
}

export function scoreSubmission(input) {
  const { projectDir, build, submissionTests } = snapshotInput(input);
  const index = loadSubmissionSources(projectDir);
  const analysis = analyzeKotlin(index);
  const context = validateAnalyzerResponse(index, analysis);
  const evaluations = [...evaluateSpatialRules(index, context), ...evaluateStatePlaneRules(context)];
  const byId = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation]));
  if (evaluations.length !== RULE_DEFINITIONS.length || byId.size !== RULE_DEFINITIONS.length) throw new Error("public rule adapters must produce exactly sixteen unique evaluations");
  const rules = RULE_DEFINITIONS.map(([id, axis, evidenceClass]) => {
    const evaluated = byId.get(id);
    if (!evaluated) throw new Error(`missing rule evaluator for ${id}`);
    const evidence = evaluated.pass ? normalizeEvidence(evaluated.evidence) : [];
    return {
      id,
      rubricVersion: RUBRIC_VERSION,
      axis,
      evidenceClass,
      pass: evaluated.pass,
      evidence,
      reason: evaluated.reason,
    };
  });
  assertEvidenceProvenance(index, rules);
  const structuralAxes = Object.fromEntries(["spatialNative", "ecs", "statePassing", "planarTracking"].map((axis) => [axis, rules.filter((rule) => rule.axis === axis && rule.pass).length]));
  const structuralScore = Object.values(structuralAxes).reduce((sum, value) => sum + value, 0);
  return validateScoreResultV2({
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    rubricVersion: RUBRIC_VERSION,
    rules,
    structuralAxes,
    structuralScore,
    build,
    buildQualifiedStructuralScore: build.status === "pass" ? structuralScore : 0,
    submissionTests,
    runtimeProtocolReceipts: createDefaultRuntimeProtocolReceipts(build.status),
    visual: { status: "not_performed", captureSha256: null },
  });
}
