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
import { loadSubmissionSources } from "./source.mjs";
import { evaluateSpatialRules } from "./rules-spatial.mjs";
import { evaluateStatePlaneRules } from "./rules-state-plane.mjs";

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
  const evaluations = [...evaluateSpatialRules(index), ...evaluateStatePlaneRules(index)];
  const byId = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation]));
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
