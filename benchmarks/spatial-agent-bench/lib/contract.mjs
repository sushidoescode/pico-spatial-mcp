import crypto from "node:crypto";
import path from "node:path";
import { canonicalJson } from "./identity.mjs";

export const RESULT_SCHEMA_VERSION = 2;
export const RUBRIC_VERSION = 2;
export const RUNTIME_PROTOCOL_VERSION = 1;

export const RULE_DEFINITIONS = deepFreeze([
  ["spatial.project-entry", "spatialNative", "source_and_typed_fact"],
  ["spatial.container-topology", "spatialNative", "source_and_typed_fact"],
  ["spatial.entity-content", "spatialNative", "source"],
  ["spatial.ui-lifecycle", "spatialNative", "source"],
  ["ecs.component-clone", "ecs", "source"],
  ["ecs.system-query", "ecs", "source"],
  ["ecs.frame-update", "ecs", "source"],
  ["ecs.lifecycle", "ecs", "source"],
  ["state.single-source", "statePassing", "source"],
  ["state.typed-handoff", "statePassing", "source"],
  ["state.shared-read-write", "statePassing", "source"],
  ["state.reopen-wiring", "statePassing", "source"],
  ["plane.retry-readiness", "planarTracking", "source"],
  ["plane.semantic-fallback", "planarTracking", "source"],
  ["plane.anchor-pose", "planarTracking", "source"],
  ["plane.cleanup-errors", "planarTracking", "source"],
]);

export const EVIDENCE_CLASSES = deepFreeze([
  "source",
  "typed_fact",
  "source_and_typed_fact",
  "submission_test",
  "app_self_reported_protocol",
  "external_observation",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_STATUSES = new Set(["pass", "fail", "not_run"]);
const SUBMISSION_STATUSES = new Set(["pass", "fail", "execution_failed", "no_source", "not_run", "not_run_build_failed"]);
const RUNTIME_CHECK_STATUSES = new Set(["pass", "fail", "blocked_environment", "not_run", "not_run_build_failed"]);
const RUNTIME_RUN_STATUSES = new Set(["complete", "blocked_environment", "not_run", "not_run_build_failed"]);
const AXES = ["spatialNative", "ecs", "statePassing", "planarTracking"];
const TEST_COMMAND = [
  "$PINNED_GRADLE/bin/gradle",
  "--offline",
  "--no-daemon",
  "--no-configuration-cache",
  "--console=plain",
  ":app:testDebugUnitTest",
];
const NULL_RUNTIME_FIELDS = [
  "environmentReceiptSha256", "driverSha256", "validatorSha256", "transcriptSha256",
  "corpusIdentitySha256", "attemptInputIdentitySha256", "buildReceiptSha256", "apkSha256",
  "packageName", "protocolVectorsSha256", "resetInstallReceipts", "receiptSha256",
];
const RUNTIME_KEYS = new Set([
  "protocolVersion", "evidenceClass", "runStatus", "checks", ...NULL_RUNTIME_FIELDS,
]);
const HASH_RUNTIME_FIELDS = [
  "environmentReceiptSha256", "driverSha256", "validatorSha256", "transcriptSha256",
  "corpusIdentitySha256", "attemptInputIdentitySha256", "buildReceiptSha256", "apkSha256",
  "protocolVectorsSha256", "receiptSha256",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function snapshotPlainData(value, label, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${label} must contain canonical finite plain data`);
    return value;
  }
  if (typeof value !== "object") throw new Error(`${label} must contain only canonical plain data`);

  const array = Array.isArray(value);
  const expectedPrototype = array ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(value) !== expectedPrototype) throw new Error(`${label} has a non-canonical plain-data prototype`);
  if (ancestors.has(value)) throw new Error(`${label} must not contain a cycle`);
  ancestors.add(value);
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) throw new Error(`${label} must not contain symbol own keys`);
    if (array) {
      const length = value.length;
      if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) throw new Error(`${label} must be a dense array with only own indexed data`);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || lengthDescriptor.value !== length) throw new Error(`${label}.length must be an own data property`);
      const copy = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error(`${label}[${index}] must be an enumerable own data property`);
        copy[index] = snapshotPlainData(descriptor.value, `${label}[${index}]`, ancestors);
      }
      return deepFreeze(copy);
    }

    const copy = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error(`${label}.${key} must be an enumerable own data property`);
      Object.defineProperty(copy, key, {
        value: snapshotPlainData(descriptor.value, `${label}.${key}`, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return deepFreeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotAttachmentInput(value) {
  const label = "runtime attachment input";
  if (!isRecord(value)) throw new Error(`${label} must have the canonical plain-data object prototype`);
  const expected = new Set(["score", "receipt", "loadedCorpusIdentitySha256", "loadedProtocolVectorsSha256", "attemptInputIdentitySha256", "receiptStore"]);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) throw new Error(`${label} must not contain symbol own keys`);
  if (ownKeys.length !== expected.size || ownKeys.some((key) => !expected.has(key))) throw new Error(`${label} contains unknown or missing own keys`);
  const descriptors = Object.fromEntries(ownKeys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]));
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error(`${label}.${key} must be an enumerable own data property`);
  }
  const store = descriptors.receiptStore.value;
  if (!isRecord(store)) throw new Error("receiptStore must have the canonical plain-data object prototype");
  const storeKeys = Reflect.ownKeys(store);
  if (storeKeys.length !== 1 || storeKeys[0] !== "resolve") throw new Error("receiptStore must contain only an enumerable own resolve data property");
  const resolveDescriptor = Object.getOwnPropertyDescriptor(store, "resolve");
  if (!resolveDescriptor?.enumerable || !Object.hasOwn(resolveDescriptor, "value") || typeof resolveDescriptor.value !== "function") throw new Error("receiptStore.resolve must be an enumerable own function data property");
  return Object.freeze({
    score: snapshotPlainData(descriptors.score.value, `${label}.score`),
    receipt: snapshotPlainData(descriptors.receipt.value, `${label}.receipt`),
    loadedCorpusIdentitySha256: snapshotPlainData(descriptors.loadedCorpusIdentitySha256.value, `${label}.loadedCorpusIdentitySha256`),
    loadedProtocolVectorsSha256: snapshotPlainData(descriptors.loadedProtocolVectorsSha256.value, `${label}.loadedProtocolVectorsSha256`),
    attemptInputIdentitySha256: snapshotPlainData(descriptors.attemptInputIdentitySha256.value, `${label}.attemptInputIdentitySha256`),
    receiptStore: Object.freeze({ resolve: resolveDescriptor.value }),
  });
}

function exactKeys(value, label, keys) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label} contains unknown key: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required key: ${key}`);
}

function assertHash(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function assertSafeInteger(value, label, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be a safe integer at least ${minimum}`);
}

function assertBoundedString(value, label, maximumBytes, { nullable = false, singleLine = false, trimmed = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (trimmed && value !== value.trim()) throw new Error(`${label} must be trimmed`);
  if (singleLine && /[\r\n]/.test(value)) throw new Error(`${label} must be single-line`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function withoutReceiptSha256(value) {
  const copy = { ...value };
  delete copy.receiptSha256;
  return copy;
}

function verifySelfHash(value, label) {
  assertHash(value.receiptSha256, `${label}.receiptSha256`);
  const expected = sha256Canonical(withoutReceiptSha256(value));
  if (value.receiptSha256 !== expected) throw new Error(`${label} receipt digest mismatch`);
}

function validateRelativePath(value, label, maximumBytes = 1_024) {
  assertBoundedString(value, label, maximumBytes, { trimmed: true, singleLine: true });
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be a normalized relative POSIX path`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || path.posix.normalize(value) !== value) throw new Error(`${label} must not contain empty, dot, or traversal segments`);
  return value;
}

function cloneAndFreeze(value) {
  return deepFreeze(structuredClone(value));
}

export function validateBuildQualification(value) {
  value = snapshotPlainData(value, "build qualification");
  exactKeys(value, "build qualification", new Set(["status", "receiptSha256"]));
  if (!BUILD_STATUSES.has(value.status)) throw new Error("build qualification has an invalid status");
  assertHash(value.receiptSha256, "build qualification receipt", true);
  if (value.status === "not_run" && value.receiptSha256 !== null) throw new Error("not-run build must have a null receipt");
  if (value.status !== "not_run" && value.receiptSha256 === null) throw new Error("pass/fail build requires a receipt");
  return deepFreeze({ status: value.status, receiptSha256: value.receiptSha256 });
}

function defaultSubmissionStatus(buildStatus) {
  if (!BUILD_STATUSES.has(buildStatus)) throw new Error("invalid build status for submission tests");
  return buildStatus === "fail" ? "not_run_build_failed" : "not_run";
}

export function createDefaultSubmissionTests(buildStatus) {
  const status = defaultSubmissionStatus(buildStatus);
  return deepFreeze({
    evidenceClass: "submission_test",
    status,
    testCount: 0,
    passedCount: 0,
    failureCount: 0,
    errorCount: 0,
    skippedCount: 0,
    preBuildResultsSha256: null,
    resultFiles: [],
    testExecutionReceiptSha256: null,
    receiptSha256: null,
  });
}

function validateResultFiles(files) {
  if (!Array.isArray(files)) throw new Error("submissionTests.resultFiles must be an array");
  const normalized = [];
  let previous = null;
  for (const [index, file] of files.entries()) {
    exactKeys(file, `submissionTests.resultFiles[${index}]`, new Set(["path", "bytes", "sha256"]));
    validateRelativePath(file.path, `submissionTests.resultFiles[${index}].path`);
    assertSafeInteger(file.bytes, `submissionTests.resultFiles[${index}].bytes`, 0);
    assertHash(file.sha256, `submissionTests.resultFiles[${index}].sha256`);
    if (previous !== null && file.path <= previous) throw new Error("submissionTests.resultFiles must be sorted by unique path");
    previous = file.path;
    normalized.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
  }
  return normalized;
}

export function validateSubmissionTests(value, buildStatus) {
  if (!BUILD_STATUSES.has(buildStatus)) throw new Error("invalid build status for submission tests");
  value = snapshotPlainData(value, "submissionTests");
  exactKeys(value, "submissionTests", new Set([
    "evidenceClass", "status", "testCount", "passedCount", "failureCount", "errorCount",
    "skippedCount", "preBuildResultsSha256", "resultFiles", "testExecutionReceiptSha256",
    "receiptSha256",
  ]));
  if (value.evidenceClass !== "submission_test" || !SUBMISSION_STATUSES.has(value.status)) throw new Error("submissionTests vocabulary drift");
  for (const key of ["testCount", "passedCount", "failureCount", "errorCount", "skippedCount"]) assertSafeInteger(value[key], `submissionTests.${key}`, 0);
  for (const key of ["preBuildResultsSha256", "testExecutionReceiptSha256", "receiptSha256"]) assertHash(value[key], `submissionTests.${key}`, true);
  const resultFiles = validateResultFiles(value.resultFiles);
  const observed = new Set(["pass", "fail", "execution_failed", "no_source"]);
  if (buildStatus === "fail" && value.status !== "not_run_build_failed") throw new Error("failed build permits only not_run_build_failed submission tests");
  if (buildStatus === "not_run" && value.status !== "not_run") throw new Error("not-run build permits only not_run submission tests");
  if (buildStatus === "pass" && value.status === "not_run_build_failed") throw new Error("passing build cannot use not_run_build_failed submission tests");
  if (["pass", "fail"].includes(value.status)) {
    if (value.testCount <= 0 || value.testCount !== value.passedCount + value.failureCount + value.errorCount + value.skippedCount) throw new Error("submission test count equation failed");
    if (resultFiles.length === 0) throw new Error("observed submission tests require fresh result files");
  }
  if (value.status === "pass" && (value.passedCount !== value.testCount || value.failureCount !== 0 || value.errorCount !== 0 || value.skippedCount !== 0)) throw new Error("passing submission tests require every test to pass without skips");
  if (value.status === "fail" && value.failureCount + value.errorCount + value.skippedCount === 0) throw new Error("failed submission tests require a failure, error, or skip");
  if (["execution_failed", "no_source", "not_run", "not_run_build_failed"].includes(value.status) && [value.testCount, value.passedCount, value.failureCount, value.errorCount, value.skippedCount].some((count) => count !== 0)) throw new Error(`${value.status} submission tests require zero counts`);
  if (["execution_failed", "no_source", "not_run", "not_run_build_failed"].includes(value.status) && resultFiles.length !== 0) throw new Error(`${value.status} submission tests require no result files`);
  if (observed.has(value.status)) {
    if (value.preBuildResultsSha256 === null || value.testExecutionReceiptSha256 === null || value.receiptSha256 === null) throw new Error(`${value.status} submission tests require provenance hashes`);
    verifySelfHash(value, "submissionTests");
  } else if (value.preBuildResultsSha256 !== null || value.testExecutionReceiptSha256 !== null || value.receiptSha256 !== null) {
    throw new Error("not-run submission tests require null provenance hashes");
  }
  return deepFreeze({
    evidenceClass: value.evidenceClass,
    status: value.status,
    testCount: value.testCount,
    passedCount: value.passedCount,
    failureCount: value.failureCount,
    errorCount: value.errorCount,
    skippedCount: value.skippedCount,
    preBuildResultsSha256: value.preBuildResultsSha256,
    resultFiles,
    testExecutionReceiptSha256: value.testExecutionReceiptSha256,
    receiptSha256: value.receiptSha256,
  });
}

export function validateTestExecutionReceipt(value) {
  value = snapshotPlainData(value, "test execution receipt");
  exactKeys(value, "test execution receipt", new Set([
    "version", "launcherSha256", "gradleExecutableSha256", "command", "workingDirectory",
    "exitCode", "stdoutBytes", "stdoutSha256", "stderrBytes", "stderrSha256", "receiptSha256",
  ]));
  if (value.version !== 1 || canonicalJson(value.command) !== canonicalJson(TEST_COMMAND) || value.workingDirectory !== "submission") throw new Error("test execution receipt command drift");
  assertHash(value.launcherSha256, "test execution launcher hash");
  assertHash(value.gradleExecutableSha256, "test execution Gradle hash");
  assertSafeInteger(value.exitCode, "test execution exitCode");
  assertSafeInteger(value.stdoutBytes, "test execution stdoutBytes", 0);
  assertSafeInteger(value.stderrBytes, "test execution stderrBytes", 0);
  assertHash(value.stdoutSha256, "test execution stdout hash");
  assertHash(value.stderrSha256, "test execution stderr hash");
  verifySelfHash(value, "test execution receipt");
  return cloneAndFreeze(value);
}

function defaultRuntimeStatus(buildStatus) {
  if (!BUILD_STATUSES.has(buildStatus)) throw new Error("invalid build status for runtime protocol");
  return buildStatus === "fail" ? "not_run_build_failed" : "not_run";
}

export function createDefaultRuntimeProtocolReceipts(buildStatus) {
  const runStatus = defaultRuntimeStatus(buildStatus);
  return deepFreeze({
    protocolVersion: 1,
    evidenceClass: "app_self_reported_protocol",
    runStatus,
    checks: { stateTranscript: runStatus, surfaceTranscript: runStatus, tickTranscript: runStatus },
    environmentReceiptSha256: null,
    driverSha256: null,
    validatorSha256: null,
    transcriptSha256: null,
    corpusIdentitySha256: null,
    attemptInputIdentitySha256: null,
    buildReceiptSha256: null,
    apkSha256: null,
    packageName: null,
    protocolVectorsSha256: null,
    resetInstallReceipts: null,
    receiptSha256: null,
  });
}

function validateChecks(checks, runStatus) {
  exactKeys(checks, "runtime protocol checks", new Set(["stateTranscript", "surfaceTranscript", "tickTranscript"]));
  for (const [name, status] of Object.entries(checks)) {
    if (!RUNTIME_CHECK_STATUSES.has(status)) throw new Error(`runtime protocol check ${name} has invalid status`);
    if (runStatus === "complete" && !["pass", "fail"].includes(status)) throw new Error("complete runtime protocol checks must pass or fail");
    if (runStatus !== "complete" && status !== runStatus) throw new Error(`runtime protocol checks must equal ${runStatus}`);
  }
  return { stateTranscript: checks.stateTranscript, surfaceTranscript: checks.surfaceTranscript, tickTranscript: checks.tickTranscript };
}

export function validateRuntimeProtocolReceipts(value, buildStatus) {
  if (!BUILD_STATUSES.has(buildStatus)) throw new Error("invalid build status for runtime protocol");
  value = snapshotPlainData(value, "runtimeProtocolReceipts");
  exactKeys(value, "runtimeProtocolReceipts", RUNTIME_KEYS);
  if (value.protocolVersion !== 1 || value.evidenceClass !== "app_self_reported_protocol" || !RUNTIME_RUN_STATUSES.has(value.runStatus)) throw new Error("runtime protocol vocabulary drift");
  const checks = validateChecks(value.checks, value.runStatus);
  for (const key of HASH_RUNTIME_FIELDS) assertHash(value[key], `runtimeProtocolReceipts.${key}`, true);
  if (value.packageName !== null) assertBoundedString(value.packageName, "runtimeProtocolReceipts.packageName", 255, { trimmed: true, singleLine: true });
  if (value.resetInstallReceipts !== null) {
    exactKeys(value.resetInstallReceipts, "runtime reset/install receipts", new Set(["stateSha256", "tickSha256", "tableSurfaceSha256", "floorSurfaceSha256"]));
    for (const [key, hash] of Object.entries(value.resetInstallReceipts)) assertHash(hash, `runtime reset/install ${key}`);
    if (new Set(Object.values(value.resetInstallReceipts)).size !== 4) throw new Error("runtime reset/install receipt hashes must be distinct");
  }
  if (buildStatus === "fail" && value.runStatus !== "not_run_build_failed") throw new Error("failed build permits only not_run_build_failed runtime protocol");
  if (buildStatus === "not_run" && value.runStatus !== "not_run") throw new Error("not-run build permits only not_run runtime protocol");
  if (buildStatus === "pass" && value.runStatus === "not_run_build_failed") throw new Error("passing build cannot use not_run_build_failed runtime protocol");
  if (["complete", "blocked_environment"].includes(value.runStatus) && buildStatus !== "pass") throw new Error(`${value.runStatus} runtime protocol requires a passing build`);
  if (value.runStatus === "complete") {
    for (const key of HASH_RUNTIME_FIELDS) if (value[key] === null) throw new Error(`complete runtime protocol requires ${key}`);
    if (value.packageName === null || value.resetInstallReceipts === null) throw new Error("complete runtime protocol requires package and reset/install receipts");
  } else if (value.runStatus === "blocked_environment") {
    if (value.environmentReceiptSha256 === null) throw new Error("blocked runtime protocol requires an environment receipt");
    for (const key of NULL_RUNTIME_FIELDS.filter((key) => key !== "environmentReceiptSha256")) if (value[key] !== null) throw new Error(`blocked runtime protocol requires null ${key}`);
  } else {
    for (const key of NULL_RUNTIME_FIELDS) if (value[key] !== null) throw new Error(`${value.runStatus} runtime protocol requires null ${key}`);
  }
  return deepFreeze({
    protocolVersion: value.protocolVersion,
    evidenceClass: value.evidenceClass,
    runStatus: value.runStatus,
    checks,
    environmentReceiptSha256: value.environmentReceiptSha256,
    driverSha256: value.driverSha256,
    validatorSha256: value.validatorSha256,
    transcriptSha256: value.transcriptSha256,
    corpusIdentitySha256: value.corpusIdentitySha256,
    attemptInputIdentitySha256: value.attemptInputIdentitySha256,
    buildReceiptSha256: value.buildReceiptSha256,
    apkSha256: value.apkSha256,
    packageName: value.packageName,
    protocolVectorsSha256: value.protocolVectorsSha256,
    resetInstallReceipts: value.resetInstallReceipts === null ? null : { ...value.resetInstallReceipts },
    receiptSha256: value.receiptSha256,
  });
}

export function validateRuntimeEnvironmentReceipt(value) {
  value = snapshotPlainData(value, "runtime environment receipt");
  exactKeys(value, "runtime environment receipt", new Set([
    "version", "status", "hostPlatform", "corpusIdentitySha256", "attemptInputIdentitySha256",
    "reasonCode", "emulatorIdentitySha256", "resetDriverSha256", "tableFixtureSha256",
    "floorFixtureSha256", "probeTranscriptSha256", "receiptSha256",
  ]));
  if (value.version !== 1 || !["ready", "blocked"].includes(value.status) || value.hostPlatform !== "macos") throw new Error("runtime environment receipt vocabulary drift");
  for (const key of ["corpusIdentitySha256", "attemptInputIdentitySha256", "probeTranscriptSha256"]) assertHash(value[key], `runtime environment ${key}`);
  for (const key of ["emulatorIdentitySha256", "resetDriverSha256", "tableFixtureSha256", "floorFixtureSha256"]) assertHash(value[key], `runtime environment ${key}`, true);
  const reasons = new Set(["emulator_unreachable", "sdk_emulator_compatibility_unverified", "reset_unavailable", "table_fixture_unavailable", "floor_fixture_unavailable", "fixture_load_unverified"]);
  if (value.status === "ready") {
    if (value.reasonCode !== null || [value.emulatorIdentitySha256, value.resetDriverSha256, value.tableFixtureSha256, value.floorFixtureSha256].some((entry) => entry === null)) throw new Error("ready runtime environment requires every environment identity and no reason code");
  } else if (!reasons.has(value.reasonCode)) {
    throw new Error("blocked runtime environment requires a typed reason code");
  }
  verifySelfHash(value, "runtime environment receipt");
  return cloneAndFreeze(value);
}

export function validateRuntimeProtocolEvidenceReceipt(value) {
  value = snapshotPlainData(value, "runtime protocol evidence receipt");
  exactKeys(value, "runtime protocol evidence receipt", new Set([
    "version", "protocolVersion", "corpusIdentitySha256", "attemptInputIdentitySha256",
    "buildReceiptSha256", "apkSha256", "packageName", "protocolVectorsSha256",
    "environmentReceiptSha256", "driverSha256", "validatorSha256", "transcriptSha256",
    "resetInstallReceipts", "checks", "receiptSha256",
  ]));
  if (value.version !== 1 || value.protocolVersion !== 1) throw new Error("runtime protocol evidence version drift");
  for (const key of ["corpusIdentitySha256", "attemptInputIdentitySha256", "buildReceiptSha256", "apkSha256", "protocolVectorsSha256", "environmentReceiptSha256", "driverSha256", "validatorSha256", "transcriptSha256"]) assertHash(value[key], `runtime protocol evidence ${key}`);
  assertBoundedString(value.packageName, "runtime protocol evidence packageName", 255, { trimmed: true, singleLine: true });
  exactKeys(value.resetInstallReceipts, "runtime protocol evidence reset/install receipts", new Set(["stateSha256", "tickSha256", "tableSurfaceSha256", "floorSurfaceSha256"]));
  for (const [key, hash] of Object.entries(value.resetInstallReceipts)) assertHash(hash, `runtime protocol evidence reset ${key}`);
  if (new Set(Object.values(value.resetInstallReceipts)).size !== 4) throw new Error("runtime protocol evidence reset/install receipt hashes must be distinct");
  exactKeys(value.checks, "runtime protocol evidence checks", new Set(["stateTranscript", "surfaceTranscript", "tickTranscript"]));
  for (const status of Object.values(value.checks)) if (!["pass", "fail"].includes(status)) throw new Error("runtime protocol evidence checks must pass or fail");
  verifySelfHash(value, "runtime protocol evidence receipt");
  return cloneAndFreeze(value);
}

function validateBuildArtifactReceipt(value, expectedHash) {
  value = snapshotPlainData(value, "build artifact receipt");
  exactKeys(value, "build artifact receipt", new Set(["version", "status", "corpusIdentitySha256", "attemptInputIdentitySha256", "apkSha256", "packageName", "receiptSha256"]));
  if (value.version !== 1 || value.status !== "pass") throw new Error("build artifact receipt must be version 1 pass");
  for (const key of ["corpusIdentitySha256", "attemptInputIdentitySha256", "apkSha256"]) assertHash(value[key], `build artifact ${key}`);
  assertBoundedString(value.packageName, "build artifact packageName", 255, { trimmed: true, singleLine: true });
  verifySelfHash(value, "build artifact receipt");
  if (value.receiptSha256 !== expectedHash) throw new Error("build artifact resolver returned the wrong receipt hash");
  return value;
}

function validateResetInstallReceipt(value, expectedHash) {
  value = snapshotPlainData(value, "reset/install receipt");
  exactKeys(value, "reset/install receipt", new Set([
    "version", "runName", "corpusIdentitySha256", "attemptInputIdentitySha256",
    "buildReceiptSha256", "apkSha256", "packageName", "resetDriverSha256", "fixtureKind",
    "fixtureSha256", "orderedLifecycleTranscriptSha256", "receiptSha256",
  ]));
  if (value.version !== 1 || !["state", "tick", "table_surface", "floor_surface"].includes(value.runName) || !["table-present", "floor-only"].includes(value.fixtureKind)) throw new Error("reset/install receipt vocabulary drift");
  for (const key of ["corpusIdentitySha256", "attemptInputIdentitySha256", "buildReceiptSha256", "apkSha256", "resetDriverSha256", "fixtureSha256", "orderedLifecycleTranscriptSha256"]) assertHash(value[key], `reset/install ${key}`);
  assertBoundedString(value.packageName, "reset/install packageName", 255, { trimmed: true, singleLine: true });
  verifySelfHash(value, "reset/install receipt");
  if (value.receiptSha256 !== expectedHash) throw new Error("reset/install resolver returned the wrong receipt hash");
  return value;
}

function resolveReceipt(store, kind, sha256, label) {
  if (!store || typeof store.resolve !== "function") throw new Error("receiptStore.resolve is required");
  const value = store.resolve(kind, sha256);
  if (!isRecord(value)) throw new Error(`${label} is missing from the private receipt store`);
  return value;
}

export function attachRuntimeProtocolEvidence(input) {
  input = snapshotAttachmentInput(input);
  assertHash(input.loadedCorpusIdentitySha256, "loaded corpus identity");
  assertHash(input.loadedProtocolVectorsSha256, "loaded protocol vector identity");
  assertHash(input.attemptInputIdentitySha256, "attempt input identity");
  const score = validateScoreResultV2(input.score);
  if (score.build.status !== "pass" || score.runtimeProtocolReceipts.runStatus !== "not_run") throw new Error("runtime evidence can attach only to an unobserved passing-build score");
  const detailed = validateRuntimeProtocolEvidenceReceipt(input.receipt);
  if (detailed.corpusIdentitySha256 !== input.loadedCorpusIdentitySha256 || detailed.attemptInputIdentitySha256 !== input.attemptInputIdentitySha256 || detailed.protocolVectorsSha256 !== input.loadedProtocolVectorsSha256) throw new Error("runtime detailed receipt input identity mismatch");
  if (detailed.buildReceiptSha256 !== score.build.receiptSha256) throw new Error("runtime detailed build receipt does not match score build receipt");
  const build = validateBuildArtifactReceipt(resolveReceipt(input.receiptStore, "build", score.build.receiptSha256, "build artifact receipt"), score.build.receiptSha256);
  if (build.corpusIdentitySha256 !== input.loadedCorpusIdentitySha256 || build.attemptInputIdentitySha256 !== input.attemptInputIdentitySha256) throw new Error("build artifact input identity mismatch");
  if (detailed.apkSha256 !== build.apkSha256 || detailed.packageName !== build.packageName) throw new Error("runtime detailed APK/package does not match build artifact");
  const environment = validateRuntimeEnvironmentReceipt(resolveReceipt(input.receiptStore, "environment", detailed.environmentReceiptSha256, "runtime environment receipt"));
  if (environment.receiptSha256 !== detailed.environmentReceiptSha256 || environment.status !== "ready") throw new Error("runtime environment receipt is not the referenced ready receipt");
  if (environment.corpusIdentitySha256 !== input.loadedCorpusIdentitySha256 || environment.attemptInputIdentitySha256 !== input.attemptInputIdentitySha256) throw new Error("runtime environment input identity mismatch");
  const resetFields = [
    ["stateSha256", "state", "table-present", environment.tableFixtureSha256],
    ["tickSha256", "tick", "table-present", environment.tableFixtureSha256],
    ["tableSurfaceSha256", "table_surface", "table-present", environment.tableFixtureSha256],
    ["floorSurfaceSha256", "floor_surface", "floor-only", environment.floorFixtureSha256],
  ];
  if (new Set(Object.values(detailed.resetInstallReceipts)).size !== 4) throw new Error("runtime reset/install receipt hashes must be distinct");
  for (const [field, runName, fixtureKind, fixtureSha256] of resetFields) {
    const expectedHash = detailed.resetInstallReceipts[field];
    const reset = validateResetInstallReceipt(resolveReceipt(input.receiptStore, "reset_install", expectedHash, `${runName} reset/install receipt`), expectedHash);
    if (reset.runName !== runName) throw new Error(`reset/install runName mismatch for ${runName}`);
    if (reset.corpusIdentitySha256 !== input.loadedCorpusIdentitySha256 || reset.attemptInputIdentitySha256 !== input.attemptInputIdentitySha256 || reset.buildReceiptSha256 !== build.receiptSha256) throw new Error(`reset/install identity mismatch for ${runName}`);
    if (reset.apkSha256 !== build.apkSha256 || reset.packageName !== build.packageName) throw new Error(`reset/install APK/package artifact mismatch for ${runName}`);
    if (reset.resetDriverSha256 !== environment.resetDriverSha256 || reset.fixtureKind !== fixtureKind || reset.fixtureSha256 !== fixtureSha256) throw new Error(`reset/install fixture or driver mismatch for ${runName}`);
  }
  const runtimeProtocolReceipts = validateRuntimeProtocolReceipts({
    protocolVersion: detailed.protocolVersion,
    evidenceClass: "app_self_reported_protocol",
    runStatus: "complete",
    checks: detailed.checks,
    environmentReceiptSha256: detailed.environmentReceiptSha256,
    driverSha256: detailed.driverSha256,
    validatorSha256: detailed.validatorSha256,
    transcriptSha256: detailed.transcriptSha256,
    corpusIdentitySha256: detailed.corpusIdentitySha256,
    attemptInputIdentitySha256: detailed.attemptInputIdentitySha256,
    buildReceiptSha256: build.receiptSha256,
    apkSha256: build.apkSha256,
    packageName: build.packageName,
    protocolVectorsSha256: detailed.protocolVectorsSha256,
    resetInstallReceipts: detailed.resetInstallReceipts,
    receiptSha256: detailed.receiptSha256,
  }, "pass");
  return validateScoreResultV2({ ...score, runtimeProtocolReceipts });
}

function validateMetadata(value, label) {
  exactKeys(value, label, new Set(["name", "value", "resource"]));
  assertBoundedString(value.name, `${label}.name`, 512, { trimmed: true, singleLine: true });
  for (const key of ["value", "resource"]) {
    if (value[key] !== null) assertBoundedString(value[key], `${label}.${key}`, 1_024, { trimmed: true, singleLine: true });
  }
  return { name: value.name, value: value.value, resource: value.resource };
}

function evidenceTuple(row) {
  return [row.evidenceClass, row.path, row.line, row.kind ?? "", row.key ?? "", row.value ?? "", row.excerpt];
}

function compareTuples(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function validateEvidenceRow(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.evidenceClass === "source") {
    exactKeys(value, label, new Set(["evidenceClass", "path", "line", "excerpt"]));
  } else if (value.evidenceClass === "typed_fact") {
    const allowed = new Set(["evidenceClass", "kind", "value", "path", "line", "excerpt", "key", "alias", "version", "versionRef", "metadata"]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown typed-fact key: ${key}`);
    for (const key of ["evidenceClass", "kind", "value", "path", "line", "excerpt"]) if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required key: ${key}`);
  } else {
    throw new Error(`${label} has forbidden evidence class`);
  }
  validateRelativePath(value.path, `${label}.path`);
  assertSafeInteger(value.line, `${label}.line`, 1);
  assertBoundedString(value.excerpt, `${label}.excerpt`, 512, { trimmed: true, singleLine: true });
  const normalized = { evidenceClass: value.evidenceClass };
  if (value.evidenceClass === "typed_fact") {
    assertBoundedString(value.kind, `${label}.kind`, 256, { trimmed: true, singleLine: true });
    assertBoundedString(value.value, `${label}.value`, 1_024, { trimmed: true, singleLine: true });
    normalized.kind = value.kind;
    normalized.value = value.value;
  }
  normalized.path = value.path;
  normalized.line = value.line;
  normalized.excerpt = value.excerpt;
  if (value.evidenceClass === "typed_fact") {
    for (const key of ["key", "alias", "version", "versionRef"]) {
      if (!Object.hasOwn(value, key)) continue;
      if (key === "key" && value[key] === null) throw new Error(`${label}.key must be a string when present`);
      if (value[key] !== null) assertBoundedString(value[key], `${label}.${key}`, 1_024, { trimmed: true, singleLine: true });
      normalized[key] = value[key];
    }
    if (Object.hasOwn(value, "metadata")) normalized.metadata = validateMetadata(value.metadata, `${label}.metadata`);
  }
  return normalized;
}

function validateRule(value, definition, index) {
  exactKeys(value, `rules[${index}]`, new Set(["id", "rubricVersion", "axis", "evidenceClass", "pass", "evidence", "reason"]));
  const [id, axis, evidenceClass] = definition;
  if (value.id !== id || value.rubricVersion !== 2 || value.axis !== axis || value.evidenceClass !== evidenceClass || typeof value.pass !== "boolean") throw new Error(`rules[${index}] definition drift`);
  assertBoundedString(value.reason, `rules[${index}].reason`, 512, { trimmed: true, singleLine: true });
  if (!Array.isArray(value.evidence)) throw new Error(`rules[${index}].evidence must be an array`);
  const evidence = value.evidence.map((row, rowIndex) => validateEvidenceRow(row, `rules[${index}].evidence[${rowIndex}]`));
  for (let rowIndex = 1; rowIndex < evidence.length; rowIndex += 1) {
    if (compareTuples(evidenceTuple(evidence[rowIndex - 1]), evidenceTuple(evidence[rowIndex])) >= 0) throw new Error(`rules[${index}].evidence must be sorted and unique`);
  }
  if (!value.pass && evidence.length !== 0) throw new Error(`failed rule ${id} must have no evidence`);
  if (value.pass && evidenceClass === "source" && (evidence.length === 0 || evidence.some((row) => row.evidenceClass !== "source"))) throw new Error(`passing source rule ${id} requires source-only evidence`);
  if (value.pass && evidenceClass === "source_and_typed_fact") {
    if (!evidence.some((row) => row.evidenceClass === "source") || !evidence.some((row) => row.evidenceClass === "typed_fact")) throw new Error(`passing mixed rule ${id} requires source and typed-fact evidence`);
  }
  return { id, rubricVersion: 2, axis, evidenceClass, pass: value.pass, evidence, reason: value.reason };
}

export function validateScoreResultV2(value) {
  value = snapshotPlainData(value, "score result");
  exactKeys(value, "score result", new Set([
    "resultSchemaVersion", "rubricVersion", "rules", "structuralAxes", "structuralScore",
    "build", "buildQualifiedStructuralScore", "submissionTests", "runtimeProtocolReceipts",
    "visual",
  ]));
  if (value.resultSchemaVersion !== 2 || value.rubricVersion !== 2) throw new Error("score result version drift");
  if (!Array.isArray(value.rules) || value.rules.length !== RULE_DEFINITIONS.length) throw new Error("score result must contain exactly sixteen ordered rules");
  const rules = value.rules.map((rule, index) => validateRule(rule, RULE_DEFINITIONS[index], index));
  exactKeys(value.structuralAxes, "structuralAxes", new Set(AXES));
  const computedAxes = Object.fromEntries(AXES.map((axis) => [axis, rules.filter((rule) => rule.axis === axis && rule.pass).length]));
  for (const axis of AXES) {
    assertSafeInteger(value.structuralAxes[axis], `structuralAxes.${axis}`, 0);
    if (value.structuralAxes[axis] > 4 || value.structuralAxes[axis] !== computedAxes[axis]) throw new Error(`structural axis ${axis} is inconsistent with rules`);
  }
  assertSafeInteger(value.structuralScore, "structuralScore", 0);
  const computedScore = Object.values(computedAxes).reduce((total, score) => total + score, 0);
  if (value.structuralScore !== computedScore) throw new Error("structuralScore is inconsistent with axes");
  const build = validateBuildQualification(value.build);
  assertSafeInteger(value.buildQualifiedStructuralScore, "buildQualifiedStructuralScore", 0);
  const qualified = build.status === "pass" ? value.structuralScore : 0;
  if (value.buildQualifiedStructuralScore !== qualified) throw new Error("buildQualifiedStructuralScore is inconsistent with build status");
  const submissionTests = validateSubmissionTests(value.submissionTests, build.status);
  const runtimeProtocolReceipts = validateRuntimeProtocolReceipts(value.runtimeProtocolReceipts, build.status);
  if (runtimeProtocolReceipts.runStatus === "complete" && runtimeProtocolReceipts.buildReceiptSha256 !== build.receiptSha256) throw new Error("complete runtime protocol build receipt does not match score build");
  exactKeys(value.visual, "visual", new Set(["status", "captureSha256"]));
  if (value.visual.status !== "not_performed" || value.visual.captureSha256 !== null) throw new Error("Task 2.5 score visual status must be not_performed");
  return deepFreeze({
    resultSchemaVersion: 2,
    rubricVersion: 2,
    rules,
    structuralAxes: computedAxes,
    structuralScore: computedScore,
    build,
    buildQualifiedStructuralScore: qualified,
    submissionTests,
    runtimeProtocolReceipts,
    visual: { status: "not_performed", captureSha256: null },
  });
}
