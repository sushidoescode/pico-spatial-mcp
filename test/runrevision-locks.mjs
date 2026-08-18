import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import test from "node:test";

import { canonicalJson } from "../dist/runreceiptidentity.js";
import {
  applicationResourceKey,
  projectResourceKey,
  resolveProjectLocator,
} from "../dist/fleetinputidentity.js";
import {
  acquirePublicFleetOwners,
  acquireRunOwners,
  authorizePublicFleetOwnerRelease,
  authorizeRunOwnerRelease,
  createLockBackedRunRevisionStore,
  recoverDeadPrefix,
  releaseDefiniteOwners,
  retainInDoubtOwners,
} from "../dist/runlocks.js";
import { createRunRevisionStore } from "../dist/runrevisionstore.js";
import {
  ATTEMPT_ID as FIXTURE_ATTEMPT_ID,
  authoredSpec,
  baseRevision,
  buildWork,
  createTestRunStoreAuthority,
  diagnostic,
  goalEnvelope,
  refreshRevisionId,
  transitionRevision,
} from "./helpers/runrevision-fixture.mjs";
import {
  parseRunHead,
  parseRunRevision,
  parseSnapshotEnvelope,
} from "../dist/runrevisiontypes.js";

const RUN_ID = "41000000-0000-4000-8000-000000000001";
const RUN_ID_2 = "41000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = FIXTURE_ATTEMPT_ID;
const ATTEMPT_ID_2 = "41000000-0000-4000-8000-000000000004";
const BRIEF_ID = "door238151";
const NOW = "2026-08-16T12:34:56.000Z";
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIVE_CHILDREN = new Set();
test.after(() => assert.equal(LIVE_CHILDREN.size, 0, "runlock child fixture leaked a live process"));

function uuidAt(index) {
  return `41000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pico-runlocks-"));
  fs.mkdirSync(projectsRoot(root));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(projectsRoot(root), { recursive: true, force: true });
  });
  return root;
}

function projectsRoot(root) {
  return `${root}-projects`;
}

function fixtureContext(root, overrides = {}) {
  const locator = resolveProjectLocator(projectsRoot(root), BRIEF_ID);
  const resourceKey = applicationResourceKey(`com.fleet.${BRIEF_ID}`, "emulator-5554");
  const projectKey = projectResourceKey(locator.physicalProjectDir);
  return {
    locator,
    input: {
      runId: RUN_ID,
      mode: "coordination",
      attemptId: null,
      resourceKey,
      projectResourceKey: projectKey,
      projectLocator: locator,
      deadlineMonotonicMs: Number.POSITIVE_INFINITY,
      ...overrides,
    },
  };
}

function dependencies(root, options = {}) {
  const pid = options.pid ?? process.pid;
  const identity = options.identity ?? `runlock-test:${pid}`;
  let uuidIndex = options.uuidStart ?? 1;
  let monotonic = options.monotonicStart ?? 0;
  const monotonicCalls = [];
  return {
    monotonicCalls,
    value: {
      rootDir: root,
      pid,
      processIdentity: options.processIdentity ?? (() => identity),
      isProcessIdentityLive: options.isProcessIdentityLive ?? ((candidatePid, candidateIdentity) => (
        candidatePid === pid && candidateIdentity === identity
      )),
      monotonicMs: options.monotonicMs ?? (() => {
        monotonicCalls.push(monotonic);
        const value = monotonic;
        monotonic += options.monotonicStep ?? 1;
        return value;
      }),
      nowUtc: options.nowUtc ?? (() => NOW),
      uuid: options.uuid ?? (() => {
        uuidIndex += 1;
        return uuidAt(uuidIndex);
      }),
    },
  };
}

function lockPath(root, scope, key) {
  return path.join(root, "locks", scope, `${key}.lock`);
}

function recordLockPathForTest(root, record) {
  const key = record.scope === "run"
    ? record.runId
    : record.scope === "application" ? record.resourceKey : record.projectResourceKey;
  return lockPath(root, record.scope, key);
}

function pathsFor(root, input) {
  return {
    run: lockPath(root, "run", input.runId),
    application: lockPath(root, "application", input.resourceKey),
    project: lockPath(root, "project", input.projectResourceKey),
  };
}

function ownerBytes(ownerPath, record) {
  const ownerFile = path.join(ownerPath, `${record.token}.owner.json`);
  return fs.readFileSync(ownerFile, "utf8");
}

function targetForOwners(owners, locator) {
  const original = baseRevision().target;
  return {
    ...original,
    inputBaseDir: locator.requestedProjectsRoot,
    briefPath: path.join(locator.requestedProjectsRoot, `${original.briefId}.json`),
    projectDir: locator.requestedProjectDir,
    projectLocator: locator,
    resourceKey: owners.application.record.resourceKey,
    projectResourceKey: owners.project.record.projectResourceKey,
  };
}

function storeRootForLocator(locator) {
  assert.ok(locator.requestedProjectsRoot.endsWith("-projects"));
  return locator.requestedProjectsRoot.slice(0, -"-projects".length);
}

function createdChain(owners, locator) {
  const root = storeRootForLocator(locator);
  const authority = createTestRunStoreAuthority();
  const store = createRunRevisionStore(authority.deps, { rootDir: root });
  const request = authority.mint(owners.run.record.runId, null, owners.run.record.mode);
  const initial = baseRevision();
  const goalRef = store.publishSnapshot("goal", goalEnvelope());
  const revision = refreshRevisionId({
    ...initial,
    runId: owners.run.record.runId,
    intent: { ...initial.intent, goal: goalRef },
    target: targetForOwners(owners, locator),
  });
  const head = {
    kind: "pico.workflow-run-head",
    schemaVersion: 1,
    runId: revision.runId,
    revision: revision.revision,
    revisionId: revision.revisionId,
    updatedAt: NOW,
  };
  store.publishRevision(revision, request);
  store.publishHead(null, head, request);
  return store.readCommittedRun(revision.runId, { parseRevision: parseRunRevision, parseHead: parseRunHead, parseSnapshot: parseSnapshotEnvelope });
}

function definitePublication(owners, locator, options = {}) {
  const root = storeRootForLocator(locator);
  const authority = createTestRunStoreAuthority();
  const store = createRunRevisionStore(authority.deps, { rootDir: root });
  const attemptId = options.attemptId ?? ATTEMPT_ID;
  const target = options.target ?? targetForOwners(owners, locator);
  const baseTarget = options.baseTarget ?? targetForOwners(owners, locator);
  const request = authority.mint(owners.run.record.runId, null, owners.run.record.mode);
  const initial = baseRevision();
  const goalRef = store.publishSnapshot("goal", goalEnvelope());
  const baseRevisionValue = refreshRevisionId({
    ...initial,
    runId: owners.run.record.runId,
    intent: { ...initial.intent, goal: goalRef },
    target: baseTarget,
  });
  store.publishRevision(baseRevisionValue, request);
  const baseHead = {
    kind: "pico.workflow-run-head", schemaVersion: 1, runId: baseRevisionValue.runId,
    revision: 0, revisionId: baseRevisionValue.revisionId, updatedAt: NOW,
  };
  store.publishHead(null, baseHead, request);
  const baseChain = store.readCommittedRun(baseRevisionValue.runId, {
    parseRevision: parseRunRevision, parseHead: parseRunHead, parseSnapshot: parseSnapshotEnvelope,
  });
  const transition = {
    type: "attempt-paused",
    attemptId,
    phase: "fleet-build",
    publicStatus: "failed",
    failure: diagnostic(),
    externalMutationDisposition: "possible",
  };
  let outcome = transitionRevision(transition, { status: "paused", publicStatus: "failed" });
  const appSpec = store.publishSnapshot("app-spec", {
    kind: "pico.workflow-app-spec", schemaVersion: 1, spec: authoredSpec,
  });
  const brief = store.publishSnapshot("brief-payload", {
    kind: "pico.workflow-brief-payload", schemaVersion: 1,
    id: target.briefId, brief: target.briefInput, spec: authoredSpec,
  });
  const external = store.publishSnapshot("external-input", {
    kind: "pico.workflow-external-input", schemaVersion: 1, policy: "pico-fleet-external-input-v1",
    appSpecSha256: appSpec.sha256, briefPayloadSha256: brief.sha256,
    resourceKey: target.resourceKey,
    projectResourceKey: target.projectResourceKey,
    physicalProjectDir: target.projectLocator.physicalProjectDir,
    inputBaseDir: target.projectLocator.requestedProjectsRoot,
    iblSelector: null, uses: [], files: [], iblChoices: [], uniqueFileCount: 0, totalBytes: 0,
  });
  const ledger = store.publishSnapshot("compiler-ledger", {
    kind: "pico.workflow-compiler-ledger", schemaVersion: 1,
    steps: [{
      order: 0, node: "fixture", tool: "fixture", args: {}, targetPath: "fixture",
      cClass: "fixture", status: "planned", note: null,
      execution: { disposition: "executed-failed", outputConfirmation: "unconfirmed", detailDigest: diagnostic().detailSha256 },
    }],
    projectWrites: [],
  });
  const publicResult = store.publishSnapshot("public-result", {
    kind: "pico.workflow-public-result", schemaVersion: 1, workflow: "pico-build-app",
    status: "failed", publicResult: buildWork("failed"),
  });
  outcome = refreshRevisionId({
    ...outcome,
    runId: baseRevisionValue.runId,
    revision: 1,
    parent: { revision: 0, revisionId: baseRevisionValue.revisionId },
    target,
    intent: {
      ...outcome.intent,
      goal: baseRevisionValue.intent.goal,
      currentSpec: { snapshot: appSpec, origin: "caller-authored", amendsRevision: null },
      briefPayload: brief,
    },
    attemptInputs: external,
    compiler: { ...outcome.compiler, ledger },
    projectGeneration: {
      ...outcome.projectGeneration,
      lastAttempt: {
        ...outcome.projectGeneration.lastAttempt,
        attemptId,
        attribution: {
          ...outcome.projectGeneration.lastAttempt.attribution,
          compilerLedger: ledger.sha256,
        },
      },
    },
    publicResult,
  });
  store.publishRevision(outcome, authority.mint(owners.run.record.runId, 0, owners.run.record.mode));
  const head = {
    kind: "pico.workflow-run-head",
    schemaVersion: 1,
    runId: outcome.runId,
    revision: 1,
    revisionId: outcome.revisionId,
    updatedAt: NOW,
  };
  if (options.publishHead !== false) {
    store.publishHead(baseHead, head, authority.mint(owners.run.record.runId, 0, owners.run.record.mode));
    return {
      chain: store.readCommittedRun(outcome.runId, {
        parseRevision: parseRunRevision, parseHead: parseRunHead, parseSnapshot: parseSnapshotEnvelope,
      }),
      tail: outcome,
      store,
    };
  }
  return { chain: baseChain, tail: outcome, store };
}

function definiteChain(owners, locator) {
  return definitePublication(owners, locator).chain;
}

function runningChain(owners, locator, type = "attempt-started", publishHead = true) {
  const root = storeRootForLocator(locator);
  const authority = createTestRunStoreAuthority();
  const store = createRunRevisionStore(authority.deps, { rootDir: root });
  const initialRequest = authority.mint(owners.run.record.runId, null, "execution");
  const initial = baseRevision();
  const goal = store.publishSnapshot("goal", goalEnvelope());
  const base = refreshRevisionId({
    ...initial,
    runId: owners.run.record.runId,
    intent: { ...initial.intent, goal },
    target: targetForOwners(owners, locator),
  });
  store.publishRevision(base, initialRequest);
  const baseHead = {
    kind: "pico.workflow-run-head", schemaVersion: 1, runId: base.runId,
    revision: 0, revisionId: base.revisionId, updatedAt: NOW,
  };
  store.publishHead(null, baseHead, initialRequest);
  const baseChain = store.readCommittedRun(base.runId, { parseRevision: parseRunRevision, parseHead: parseRunHead, parseSnapshot: parseSnapshotEnvelope });
  const appSpec = store.publishSnapshot("app-spec", {
    kind: "pico.workflow-app-spec", schemaVersion: 1, spec: authoredSpec,
  });
  const brief = store.publishSnapshot("brief-payload", {
    kind: "pico.workflow-brief-payload", schemaVersion: 1,
    id: base.target.briefId, brief: base.target.briefInput, spec: authoredSpec,
  });
  const external = store.publishSnapshot("external-input", {
    kind: "pico.workflow-external-input", schemaVersion: 1, policy: "pico-fleet-external-input-v1",
    appSpecSha256: appSpec.sha256, briefPayloadSha256: brief.sha256,
    resourceKey: owners.application.record.resourceKey,
    projectResourceKey: owners.project.record.projectResourceKey,
    physicalProjectDir: owners.project.record.physicalProjectDir,
    inputBaseDir: locator.requestedProjectsRoot,
    iblSelector: null, uses: [], files: [], iblChoices: [], uniqueFileCount: 0, totalBytes: 0,
  });
  const transition = type === "attempt-started"
    ? { type, attemptId: ATTEMPT_ID, phase: "build", iteration: null, generation: base.projectGeneration.expected, inputs: external.sha256 }
    : { type, attemptId: ATTEMPT_ID, phase: "fleet-build", reason: diagnostic(), externalMutationDisposition: "possible" };
  let tail = transitionRevision(transition, { status: "running", phase: type, attemptId: ATTEMPT_ID });
  tail = refreshRevisionId({
    ...tail,
    runId: base.runId,
    revision: 1,
    parent: { revision: 0, revisionId: base.revisionId },
    target: targetForOwners(owners, locator),
    intent: {
      ...tail.intent,
      goal: base.intent.goal,
      currentSpec: { snapshot: appSpec, origin: "caller-authored", amendsRevision: null },
      briefPayload: brief,
    },
    attemptInputs: external,
  });
  const tailRequest = authority.mint(owners.run.record.runId, 0, "execution");
  store.publishRevision(tail, tailRequest);
  const tailHead = {
    kind: "pico.workflow-run-head", schemaVersion: 1, runId: tail.runId,
    revision: 1, revisionId: tail.revisionId, updatedAt: NOW,
  };
  if (publishHead) {
    store.publishHead(baseHead, tailHead, tailRequest);
    return { chain: store.readCommittedRun(tail.runId, { parseRevision: parseRunRevision, parseHead: parseRunHead, parseSnapshot: parseSnapshotEnvelope }), tail, store, request: tailRequest };
  }
  return {
    chain: baseChain,
    tail,
    store,
    request: tailRequest,
  };
}

function publicCompletionMarker(owners, overrides = {}) {
  return {
    kind: "pico.public-fleet-execution-completed",
    schemaVersion: 1,
    completedAt: NOW,
    applicationOwnerToken: owners.application.token,
    projectOwnerToken: owners.project.token,
    attemptId: owners.application.record.attemptId,
    resourceKey: owners.application.record.resourceKey,
    projectResourceKey: owners.project.record.projectResourceKey,
    physicalProjectDir: owners.project.record.physicalProjectDir,
    briefPayloadSha256: "a".repeat(64),
    inputMode: "legacy-mutable",
    externalInputSha256: null,
    executionDisposition: "definitely-completed",
    phase: "complete",
    externalMutationDisposition: "none",
    resultSha256: "b".repeat(64),
    ...overrides,
  };
}

function publicStartedMarker(owners, overrides = {}) {
  return {
    kind: "pico.public-fleet-execution-started",
    schemaVersion: 1,
    createdAt: NOW,
    applicationOwnerToken: owners.application.token,
    projectOwnerToken: owners.project.token,
    attemptId: owners.application.record.attemptId,
    resourceKey: owners.application.record.resourceKey,
    projectResourceKey: owners.project.record.projectResourceKey,
    physicalProjectDir: owners.project.record.physicalProjectDir,
    briefPayloadSha256: "a".repeat(64),
    inputMode: "legacy-mutable",
    externalInputSha256: null,
    ...overrides,
  };
}

function writePublicStarted(root, owners, marker = publicStartedMarker(owners)) {
  const applicationPath = lockPath(root, "application", owners.application.record.resourceKey);
  fs.writeFileSync(path.join(applicationPath, "EXECUTION_STARTED.json"), `${canonicalJson(marker)}\n`);
  return marker;
}

function writePublicCompleted(root, owners, marker = publicCompletionMarker(owners)) {
  const applicationPath = lockPath(root, "application", owners.application.record.resourceKey);
  fs.writeFileSync(path.join(applicationPath, "EXECUTION_COMPLETED.json"), `${canonicalJson(marker)}\n`);
  return marker;
}

async function expectLockStatus(action, status, pattern = null) {
  let captured;
  await assert.rejects(action, (error) => {
    captured = error;
    return error?.status === status && (pattern === null || pattern.test(error.message));
  });
  return captured;
}

async function spawnAtBarrier(root, command, cut) {
  const child = fork(new URL("./fixtures/runlock-child.mjs", import.meta.url), [command, root, cut], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  LIVE_CHILDREN.add(child);
  child.once("exit", () => LIVE_CHILDREN.delete(child));
  let stderr = "";
  let records = null;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const expected = command === "cut-acquire"
    ? `after-${cut}-owner`
    : command === "cut-release"
      ? `after-${cut}-release`
      : command === "capacity-cut" ? "capacity-enrollment-held" : "holding";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`runlock child timed out at ${expected}: ${stderr}`)), 10_000);
      child.once("error", reject);
      child.on("message", (message) => {
        if (message?.kind === "owners") records = message.owners;
        if (message?.kind === "barrier" && message.name === expected) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          clearTimeout(timer);
          reject(new Error(`runlock child exited ${code}/${signal}: ${stderr}`));
        }
      });
    });
  } catch (error) {
    await killChild(child);
    throw error;
  }
  return { child, records, stderr };
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

function spawnCapacityChild(root, index) {
  const child = fork(new URL("./fixtures/runlock-child.mjs", import.meta.url), ["capacity-acquire", root, String(index)], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  LIVE_CHILDREN.add(child);
  child.once("exit", () => LIVE_CHILDREN.delete(child));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let sawBarrier = false;
  let sawResult = false;
  let resolveBarrier;
  let rejectBarrier;
  let resolveResult;
  let rejectResult;
  const barrier = new Promise((resolve, reject) => { resolveBarrier = resolve; rejectBarrier = reject; });
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  child.on("message", (message) => {
    if (message?.kind === "barrier" && message.name === `capacity-preclaim-${index}`) {
      sawBarrier = true;
      resolveBarrier();
    }
    if (message?.kind === "capacity-result") {
      sawResult = true;
      resolveResult(message);
    }
  });
  child.once("error", (error) => {
    if (!sawBarrier) rejectBarrier(error);
    if (!sawResult) rejectResult(error);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      const error = new Error(`capacity child ${index} exited ${code}/${signal} before its protocol completed: ${stderr}`);
      if (!sawBarrier) rejectBarrier(error);
      if (!sawResult) rejectResult(error);
      if (code === 0) resolve();
      else reject(error);
    });
  });
  return { child, barrier, result, exited };
}

function spawnCapacityAbaChild(root, command, index = 0) {
  const child = fork(new URL("./fixtures/runlock-child.mjs", import.meta.url), [command, root, String(index)], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  LIVE_CHILDREN.add(child);
  child.once("exit", () => LIVE_CHILDREN.delete(child));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const seen = new Set();
  const waiters = new Map();
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  child.on("message", (message) => {
    if (message?.kind === "barrier") {
      seen.add(message.name);
      waiters.get(message.name)?.resolve();
    }
    if (message?.kind === "capacity-result") resolveResult(message);
  });
  child.once("error", (error) => {
    rejectResult(error);
    for (const waiter of waiters.values()) waiter.reject(error);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      const error = new Error(`capacity ABA child ${command}/${index} exited ${code}/${signal}: ${stderr}`);
      if (code === 0) resolve();
      else reject(error);
      rejectResult(error);
      for (const waiter of waiters.values()) waiter.reject(error);
    });
  });
  const waitBarrier = (name, timeoutMs = 10_000) => {
    if (seen.has(name)) return Promise.resolve();
    if (waiters.has(name)) return waiters.get(name).promise;
    let resolve;
    let reject;
    const promise = new Promise((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${command}/${index} barrier '${name}': ${stderr}`)), timeoutMs);
    const wrapped = promise.finally(() => clearTimeout(timer));
    waiters.set(name, { promise: wrapped, resolve, reject });
    return wrapped;
  };
  const releaseBarrier = (name) => {
    const directory = path.join(root, "capacity-aba-gates");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${name}.release`), "release\n");
  };
  return { child, result, exited, waitBarrier, releaseBarrier };
}

function readOnlyOwner(lockDirectory) {
  const files = fs.readdirSync(lockDirectory).filter((name) => name.endsWith(".owner.json"));
  assert.equal(files.length, 1);
  return JSON.parse(fs.readFileSync(path.join(lockDirectory, files[0]), "utf8"));
}

function readOnlyElection(directory) {
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".election.json"));
  assert.equal(files.length, 1);
  return JSON.parse(fs.readFileSync(path.join(directory, files[0]), "utf8"));
}

function activeReservation(root, operation) {
  const directory = path.join(root, "reservations");
  if (!fs.existsSync(directory)) return false;
  return fs.readdirSync(directory).some((name) => {
    if (!/^reservation-[0-9]{2}\.json$/.test(name)) return false;
    const record = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    return record.operation === operation;
  });
}

function initialRevisionAndHead(store, context, owners) {
  const goal = store.publishSnapshot("goal", goalEnvelope());
  const original = baseRevision();
  const revision = refreshRevisionId({
    ...original,
    runId: owners.run.record.runId,
    intent: { ...original.intent, goal },
    target: targetForOwners(owners, context.locator),
  });
  const head = {
    kind: "pico.workflow-run-head",
    schemaVersion: 1,
    runId: revision.runId,
    revision: 0,
    revisionId: revision.revisionId,
    updatedAt: NOW,
  };
  return { revision, head };
}

function ownerRace(root, context, owners, kind, state) {
  const target = lockPath(root, "run", context.input.runId);
  const ownerFile = path.join(target, `${owners.run.token}.owner.json`);
  if (kind === "identity-drift") {
    state.identity = `${state.identity}:drifted`;
    return;
  }
  if (kind === "removal") {
    fs.rmSync(target, { recursive: true });
    return;
  }
  if (kind === "replacement") {
    fs.rmSync(target, { recursive: true });
    const replacement = {
      ...owners.run.record,
      pid: owners.run.record.pid + 10_000,
      processIdentity: `replacement:${owners.run.record.pid + 10_000}`,
      token: uuidAt(3901),
    };
    writeManualOwner(root, "run", context.input.runId, replacement);
    return;
  }
  if (kind === "malformed") {
    fs.writeFileSync(ownerFile, "{}\n");
    return;
  }
  if (kind === "symlink") {
    const outside = path.join(root, `outside-${owners.run.token}.json`);
    fs.writeFileSync(outside, `${canonicalJson(owners.run.record)}\n`);
    fs.unlinkSync(ownerFile);
    fs.symlinkSync(outside, ownerFile);
    return;
  }
  throw new Error(`unknown owner race '${kind}'`);
}

function armedRaceDependencies(root, context, owners, operation, kind, options = {}) {
  const state = { identity: options.identity ?? `race-owner:${options.pid ?? 8101}`, armed: false, fired: false };
  const base = dependencies(root, {
    pid: options.pid ?? 8101,
    identity: state.identity,
    isProcessIdentityLive: options.isProcessIdentityLive,
    uuidStart: options.uuidStart,
    processIdentity: () => {
      if (state.armed && !state.fired && activeReservation(root, operation)) {
        state.fired = true;
        ownerRace(root, context, owners, kind, state);
      }
      return state.identity;
    },
  }).value;
  return { deps: base, state };
}

function residueOwner(root, scope, index) {
  const token = uuidAt(10_000 + index);
  const runId = uuidAt(20_000 + index);
  const resourceKey = applicationResourceKey(`com.fleet.bound${index}`, "emulator-5554");
  const physicalProjectDir = path.join(root, "bounded", String(index));
  const projectKey = projectResourceKey(physicalProjectDir);
  return {
    key: scope === "run" ? runId : scope === "application" ? resourceKey : projectKey,
    record: {
      pid: 99_001,
      processIdentity: "bounded-residue:99001",
      token,
      createdAt: NOW,
      mode: "coordination",
      scope,
      runId,
      attemptId: null,
      resourceKey: scope === "run" ? null : resourceKey,
      projectResourceKey: scope === "run" ? null : projectKey,
      physicalProjectDir: scope === "run" ? null : physicalProjectDir,
    },
  };
}

function writeRecognizedOwnerResidue(root, scope, index) {
  const { key, record } = residueOwner(root, scope, index);
  const cleanup = uuidAt(30_000 + index);
  const target = `${lockPath(root, scope, key)}.released.${sha256(record.token)}.${cleanup}`;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${record.token}.owner.json`), `${canonicalJson(record)}\n`);
  return target;
}

function writeRecognizedElection(root, scope, index) {
  const { key, record: owner } = residueOwner(root, scope, index);
  const record = {
    kind: "pico.run-owner-recovery-election",
    schemaVersion: 1,
    pid: 99_002,
    processIdentity: "bounded-election:99002",
    token: uuidAt(40_000 + index),
    createdAt: NOW,
    scope,
    ownerToken: owner.token,
    lockPath: lockPath(root, scope, key),
  };
  const target = `${record.lockPath}.recover.${sha256(record.ownerToken)}`;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${record.token}.election.json`), `${canonicalJson(record)}\n`);
  return target;
}

function writeElectionForOwner(root, owner, overrides = {}) {
  const record = {
    kind: "pico.run-owner-recovery-election",
    schemaVersion: 1,
    pid: 99_003,
    processIdentity: "dead:owner-election:99003",
    token: uuidAt(49_000),
    createdAt: NOW,
    scope: owner.scope,
    ownerToken: owner.token,
    lockPath: recordLockPathForTest(root, owner),
    ...overrides,
  };
  const target = `${record.lockPath}.recover.${sha256(record.ownerToken)}`;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${record.token}.election.json`), `${canonicalJson(record)}\n`);
  return { target, record };
}

function capacityEnrollmentRecord(index) {
  return {
    kind: "pico.run-lock-capacity-enrollment",
    schemaVersion: 1,
    pid: 99_100 + index,
    processIdentity: `dead:capacity-residue:${index}`,
    token: uuidAt(120_000 + index),
    createdAt: NOW,
  };
}

function writeCapacityEnrollmentResidue(root, index) {
  const directory = path.join(root, "locks", "capacity-enrollment");
  fs.mkdirSync(directory, { recursive: true });
  const record = capacityEnrollmentRecord(index);
  const target = path.join(
    directory,
    `ACTIVE.released.${sha256(record.token)}.${uuidAt(130_000 + index)}.json`,
  );
  fs.writeFileSync(target, `${canonicalJson(record)}\n`);
  return target;
}

async function observeRenames(action, afterRename = () => undefined) {
  const original = fs.renameSync;
  const events = [];
  fs.renameSync = (source, target) => {
    const result = original(source, target);
    events.push({ source: String(source), target: String(target) });
    afterRename(String(source), String(target));
    return result;
  };
  try {
    await action(events);
  } finally {
    fs.renameSync = original;
  }
  return events;
}

function manualOwner(input, scope, overrides = {}) {
  return {
    pid: 9001,
    processIdentity: "manual-owner:9001",
    token: uuidAt(3301),
    createdAt: NOW,
    mode: input.mode,
    scope,
    runId: input.runId,
    attemptId: input.attemptId,
    resourceKey: scope === "run" ? null : input.resourceKey,
    projectResourceKey: scope === "run" ? null : input.projectResourceKey,
    physicalProjectDir: scope === "run" ? null : input.projectLocator.physicalProjectDir,
    ...overrides,
  };
}

function writeManualOwner(root, scope, key, record, text = `${canonicalJson(record)}\n`) {
  const target = lockPath(root, scope, key);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${record.token}.owner.json`), text);
  return target;
}

function moveOwnerToResidue(root, record, cleanupToken) {
  const source = recordLockPathForTest(root, record);
  const target = `${source}.released.${sha256(record.token)}.${cleanupToken}`;
  fs.renameSync(source, target);
  assert.equal(ownerBytes(target, record), `${canonicalJson(record)}\n`);
  return target;
}

function writeOwnerResidueForRecord(root, record, cleanupToken) {
  const target = `${recordLockPathForTest(root, record)}.released.${sha256(record.token)}.${cleanupToken}`;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${record.token}.owner.json`), `${canonicalJson(record)}\n`);
  return target;
}

test("acquireRunOwners publishes canonical run then application then project owner generations", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root);
  const deps = dependencies(root).value;
  const owners = await acquireRunOwners(input, deps);
  const paths = pathsFor(root, input);

  assert.deepEqual([owners.run.scope, owners.application.scope, owners.project.scope], ["run", "application", "project"]);
  const ownerKeys = [
    "pid", "processIdentity", "token", "createdAt", "mode", "scope", "runId", "attemptId",
    "resourceKey", "projectResourceKey", "physicalProjectDir",
  ].sort();
  for (const owner of [owners.run, owners.application, owners.project]) {
    assert.deepEqual(Object.keys(owner.record).sort(), ownerKeys);
  }
  assert.equal(ownerBytes(paths.run, owners.run.record), `${canonicalJson(owners.run.record)}\n`);
  assert.equal(ownerBytes(paths.application, owners.application.record), `${canonicalJson(owners.application.record)}\n`);
  assert.equal(ownerBytes(paths.project, owners.project.record), `${canonicalJson(owners.project.record)}\n`);
  assert.deepEqual(
    [owners.run.record.resourceKey, owners.run.record.projectResourceKey, owners.run.record.physicalProjectDir],
    [null, null, null],
  );
  assert.equal(owners.application.record.physicalProjectDir, input.projectLocator.physicalProjectDir);
});

test("acquirePublicFleetOwners publishes only application then project execution owners", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquirePublicFleetOwners(input, dependencies(root).value);
  const paths = pathsFor(root, { ...input, runId: RUN_ID });
  assert.equal(owners.run, null);
  assert.equal(fs.existsSync(paths.run), false);
  assert.equal(readOnlyOwner(paths.application).runId, null);
  assert.equal(readOnlyOwner(paths.project).attemptId, ATTEMPT_ID);
  assert.deepEqual(Object.keys(readOnlyOwner(paths.application)).sort(), [
    "pid", "processIdentity", "token", "createdAt", "mode", "scope", "runId", "attemptId",
    "resourceKey", "projectResourceKey", "physicalProjectDir",
  ].sort());
});

test("fresh owner tokens cannot reuse a recognized residue generation", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root);
  const reusedToken = uuidAt(2_901);
  const residueRecord = manualOwner(context.input, "project", {
    pid: 6_901,
    processIdentity: "dead:project-token-residue",
    token: reusedToken,
  });
  const residue = writeOwnerResidueForRecord(root, residueRecord, uuidAt(2_902));
  const deps = dependencies(root, { uuid: () => reusedToken }).value;
  await expectLockStatus(
    () => acquireRunOwners(context.input, deps),
    "invalid-store",
    /token|residue|generation|collision|quarantine/i,
  );
  assert.equal(fs.existsSync(residue), true);
  assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [false, false, false]);
});

test("coordination release requires a local durable authority and quarantines project application run", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root);
  const { input } = context;
  const deps = dependencies(root).value;
  const owners = await acquireRunOwners(input, deps);
  const paths = pathsFor(root, input);
  await assert.rejects(() => releaseDefiniteOwners(owners, {
    kind: "run-head", runId: RUN_ID, attemptId: null,
    applicationOwnerToken: owners.application.token,
    projectOwnerToken: owners.project.token,
    runOwnerToken: owners.run.token,
    authorityDigest: "a".repeat(64),
  }, deps), /authority|brand|origin/i);
  assert.ok(fs.existsSync(paths.project));

  const authority = authorizeRunOwnerRelease(owners, createdChain(owners, context.locator));
  await releaseDefiniteOwners(owners, authority, deps);
  assert.deepEqual(Object.values(paths).map((target) => fs.existsSync(target)), [false, false, false]);
});

test("release quarantines exact owner bytes in causal project application run order", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root);
  const acquireDeps = dependencies(root).value;
  const owners = await acquireRunOwners(context.input, acquireDeps);
  const authority = authorizeRunOwnerRelease(owners, createdChain(owners, context.locator));
  const releaseDeps = dependencies(root, { uuidStart: 3_100 }).value;
  const events = await observeRenames(async () => releaseDefiniteOwners(owners, authority, releaseDeps));
  const releases = events.filter(({ source, target }) => source.endsWith(".lock") && target.includes(".lock.released."));
  assert.deepEqual(releases.map(({ source }) => path.basename(path.dirname(source))), ["project", "application", "run"]);
  for (const [index, capability] of [owners.project, owners.application, owners.run].entries()) {
    const { target } = releases[index];
    const prefix = `${recordLockPathForTest(root, capability.record)}.released.${sha256(capability.token)}.`;
    assert.ok(target.startsWith(prefix));
    assert.match(target.slice(prefix.length), UUID_V4);
    assert.equal(ownerBytes(target, capability.record), `${canonicalJson(capability.record)}\n`);
  }
});

test("release refuses to create a second residue for one owner generation", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root);
  const deps = dependencies(root).value;
  const owners = await acquireRunOwners(context.input, deps);
  const authority = authorizeRunOwnerRelease(owners, createdChain(owners, context.locator));
  const firstResidue = writeOwnerResidueForRecord(root, owners.project.record, uuidAt(3_151));
  await expectLockStatus(
    () => releaseDefiniteOwners(owners, authority, deps),
    "invalid-store",
    /residue|generation|quarantine|duplicate|active/i,
  );
  assert.equal(fs.existsSync(firstResidue), true);
  assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [true, true, true]);
});

test("definite execution outcome authorizes reverse release but attempt-started does not", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const { input } = context;
  const deps = dependencies(root).value;
  const owners = await acquireRunOwners(input, deps);
  const started = runningChain(owners, context.locator, "attempt-started").chain;
  assert.throws(() => authorizeRunOwnerRelease(owners, started), /in.doubt|started|definite|release/i);
  const outcomeRoot = tempRoot(t);
  const outcomeContext = fixtureContext(outcomeRoot, { mode: "execution", attemptId: ATTEMPT_ID });
  const outcomeDeps = dependencies(outcomeRoot).value;
  const outcomeOwners = await acquireRunOwners(outcomeContext.input, outcomeDeps);
  const authority = authorizeRunOwnerRelease(outcomeOwners, definiteChain(outcomeOwners, outcomeContext.locator));
  await releaseDefiniteOwners(outcomeOwners, authority, outcomeDeps);
});

test("run release authority rejects cloned capabilities and every mismatched durable coordinate", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const deps = dependencies(root).value;
  const owners = await acquireRunOwners(context.input, deps);
  const chain = definiteChain(owners, context.locator);
  assert.throws(() => authorizeRunOwnerRelease(structuredClone(owners), chain), /brand|origin|capability/i);

  const last = chain.revisions.at(-1);
  const variants = [
    ["HEAD/tail", { ...chain, head: { ...chain.head, revisionId: "f".repeat(64) } }],
    ["attempt", { ...chain, revisions: [...chain.revisions.slice(0, -1), { ...last, transition: { ...last.transition, attemptId: ATTEMPT_ID_2 } }] }],
    ["target resource", { ...chain, revisions: [...chain.revisions.slice(0, -1), { ...last, target: { ...last.target, resourceKey: "e".repeat(64) } }] }],
    ["target project", { ...chain, revisions: [...chain.revisions.slice(0, -1), { ...last, target: { ...last.target, projectResourceKey: "d".repeat(64) } }] }],
    ["target path", { ...chain, revisions: [...chain.revisions.slice(0, -1), { ...last, target: { ...last.target, projectLocator: { ...last.target.projectLocator, physicalProjectDir: path.join(root, "replacement") } } }] }],
  ];
  for (const [label, variant] of variants) {
    assert.throws(() => authorizeRunOwnerRelease(owners, variant), /head|attempt|target|owner|release|match|chain|durable/i, label);
  }

  const startedRoot = tempRoot(t);
  const startedContext = fixtureContext(startedRoot, { mode: "execution", attemptId: ATTEMPT_ID });
  const startedOwners = await acquireRunOwners(startedContext.input, dependencies(startedRoot).value);
  const startedChain = runningChain(startedOwners, startedContext.locator, "attempt-started").chain;
  const startedLast = startedChain.revisions.at(-1);
  const forgedDefinite = {
    ...startedChain,
    revisions: [...startedChain.revisions.slice(0, -1), {
      ...startedLast,
      transition: {
        type: "attempt-paused",
        attemptId: ATTEMPT_ID,
        phase: "fleet-build",
        publicStatus: "failed",
        failure: diagnostic(),
        externalMutationDisposition: "possible",
      },
    }],
  };
  assert.throws(
    () => authorizeRunOwnerRelease(startedOwners, forgedDefinite),
    /canonical|durable|revision|chain|digest|release/i,
    "a caller-shaped definite transition cannot reuse the durable attempt-started revision identity",
  );
  assert.deepEqual(
    Object.values(pathsFor(startedRoot, startedContext.input)).map((target) => fs.existsSync(target)),
    [true, true, true],
  );

  const authority = authorizeRunOwnerRelease(owners, chain);
  await expectLockStatus(() => releaseDefiniteOwners(structuredClone(owners), authority, deps), "state-write-failed", /authority|origin|owner/i);
  assert.ok(fs.existsSync(recordLockPathForTest(root, owners.project.record)));
});

test("durable run and public completion authority is rebound immediately before release", async (t) => {
  await t.test("run HEAD changed after authorization", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root);
    const deps = dependencies(root).value;
    const owners = await acquireRunOwners(context.input, deps);
    const chain = createdChain(owners, context.locator);
    const authority = authorizeRunOwnerRelease(owners, chain);
    fs.writeFileSync(path.join(root, RUN_ID, "HEAD.json"), `${canonicalJson({
      ...chain.head,
      revisionId: "f".repeat(64),
    })}\n`);
    await expectLockStatus(
      () => releaseDefiniteOwners(owners, authority, deps),
      "invalid-store",
      /head|chain|durable|authority|revision/i,
    );
    assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [true, true, true]);
  });

  for (const kind of ["removed", "altered"]) {
    await t.test(`public completion ${kind} after authorization`, async (t) => {
      const root = tempRoot(t);
      const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
      const deps = dependencies(root).value;
      const owners = await acquirePublicFleetOwners(context.input, deps);
      writePublicStarted(root, owners);
      const marker = writePublicCompleted(root, owners);
      const authority = authorizePublicFleetOwnerRelease(owners, marker);
      const completedPath = path.join(
        lockPath(root, "application", context.input.resourceKey),
        "EXECUTION_COMPLETED.json",
      );
      if (kind === "removed") fs.unlinkSync(completedPath);
      else fs.writeFileSync(completedPath, `${canonicalJson({ ...marker, resultSha256: "c".repeat(64) })}\n`);
      await expectLockStatus(
        () => releaseDefiniteOwners(owners, authority, deps),
        "invalid-store",
        /completion|marker|durable|authority|current/i,
      );
      assert.deepEqual(
        [owners.application, owners.project].map((owner) => fs.existsSync(recordLockPathForTest(root, owner.record))),
        [true, true],
      );
    });
  }
});

test("public completion marker is consumed as persisted release authority without Task 4 publishing it", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
  const deps = dependencies(root).value;
  const owners = await acquirePublicFleetOwners(input, deps);
  writePublicStarted(root, owners);
  const marker = writePublicCompleted(root, owners);
  assert.throws(
    () => authorizePublicFleetOwnerRelease(owners, { ...marker, unexpected: true }),
    /marker|unknown|shape|canonical/i,
  );
  assert.throws(
    () => authorizePublicFleetOwnerRelease(owners, { ...marker, projectOwnerToken: uuidAt(900) }),
    /token|marker|owner/i,
  );
  const authority = authorizePublicFleetOwnerRelease(owners, marker);
  assert.throws(() => authorizePublicFleetOwnerRelease(structuredClone(owners), marker), /brand|origin|capability/i);
  await releaseDefiniteOwners(owners, authority, deps);
});

test("public completion authority rejects every identity input and disposition mismatch", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquirePublicFleetOwners(context.input, dependencies(root).value);
  writePublicStarted(root, owners);
  const marker = writePublicCompleted(root, owners);
  const mismatches = [
    ["application owner", { applicationOwnerToken: uuidAt(3201) }],
    ["project owner", { projectOwnerToken: uuidAt(3202) }],
    ["attempt", { attemptId: uuidAt(3203) }],
    ["application resource", { resourceKey: "c".repeat(64) }],
    ["project resource", { projectResourceKey: "d".repeat(64) }],
    ["physical project", { physicalProjectDir: path.join(root, "other-project") }],
    ["brief payload", { briefPayloadSha256: "e".repeat(64) }],
    ["sealed input null", { inputMode: "sealed" }],
    ["legacy external input", { externalInputSha256: "f".repeat(64) }],
    ["execution disposition", { executionDisposition: "in-doubt" }],
    ["phase", { phase: "unknown-phase" }],
    ["external mutation disposition", { externalMutationDisposition: "unknown" }],
    ["result digest", { resultSha256: "not-a-digest" }],
  ];
  for (const [label, mismatch] of mismatches) {
    assert.throws(
      () => authorizePublicFleetOwnerRelease(owners, { ...marker, ...mismatch }),
      /marker|owner|token|attempt|resource|project|input|disposition|phase|digest|sha/i,
      label,
    );
  }
});

test("retaining an in-doubt execution preserves all owners and rejects cloned capabilities", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquireRunOwners(input, dependencies(root).value);
  const retained = retainInDoubtOwners(owners);
  assert.equal(retained.status, "retained-in-doubt");
  assert.equal(retained.attemptId, ATTEMPT_ID);
  assert.deepEqual(Object.values(pathsFor(root, input)).map((target) => fs.existsSync(target)), [true, true, true]);
  assert.throws(() => retainInDoubtOwners(structuredClone(owners)), /brand|origin|capability/i);
});

test("one shared monotonic budget is not renewed after the run owner is acquired", async (t) => {
  const root = tempRoot(t);
  const base = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
  const blockerDeps = dependencies(root, { pid: 7001, identity: "live:blocker" }).value;
  const blocker = await acquirePublicFleetOwners(base.input, blockerDeps);
  const contender = fixtureContext(root, {
    runId: RUN_ID_2,
    mode: "execution",
    attemptId: ATTEMPT_ID_2,
    deadlineMonotonicMs: 100_000,
  });
  let clock = 0;
  let priorScopePublished = false;
  const calls = [];
  const contenderDeps = dependencies(root, {
    pid: 7002,
    identity: "live:contender",
    monotonicMs: () => {
      calls.push(clock);
      const value = clock;
      if (clock === 14_999) clock = 15_000;
      else if (clock === 15_000) clock = 30_000;
      return value;
    },
    isProcessIdentityLive: (pid, identity) => pid === 7001 && identity === "live:blocker",
  }).value;
  await expectLockStatus(() => observeRenames(
    () => acquireRunOwners(contender.input, contenderDeps),
    (_source, target) => {
      if (target === lockPath(root, "run", RUN_ID_2)) {
        priorScopePublished = true;
        clock = 14_999;
      }
    },
  ), "run-busy", /15|budget|live|busy/i);
  assert.equal(priorScopePublished, true);
  assert.ok(Math.max(...calls) <= 15_000, `shared acquisition clock renewed past 15 seconds: ${calls}`);
  assert.equal(fs.existsSync(lockPath(root, "run", RUN_ID_2)), false, "failed acquisition cleaned its own run prefix");
  assert.equal(blocker.application.record.token, readOnlyOwner(lockPath(root, "application", base.input.resourceKey)).token);
});

test("shared 15-second budget spans project staging and public application-project order despite wall-clock jumps", async (t) => {
  for (const publicFleet of [false, true]) {
    await t.test(publicFleet ? "public application-project" : "run-application-project", async (t) => {
      const root = tempRoot(t);
      const blockerContext = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
      await acquireRunOwners(blockerContext.input, dependencies(root, { pid: 7051, identity: "live:project-blocker" }).value);
      const contenderBase = fixtureContext(root, {
        runId: publicFleet ? null : RUN_ID_2,
        mode: "execution",
        attemptId: ATTEMPT_ID_2,
        resourceKey: "f".repeat(64),
        deadlineMonotonicMs: 100_000,
      }).input;
      let monotonic = 0;
      let priorScopePublished = false;
      let wall = false;
      const calls = [];
      const deps = dependencies(root, {
        pid: 7052,
        identity: "live:project-contender",
        monotonicMs: () => {
          calls.push(monotonic);
          const value = monotonic;
          if (monotonic === 14_999) monotonic = 15_000;
          else if (monotonic === 15_000) monotonic = 30_000;
          return value;
        },
        nowUtc: () => {
          wall = !wall;
          return wall ? "2099-12-31T23:59:59.000Z" : "1970-01-01T00:00:00.000Z";
        },
        isProcessIdentityLive: (pid, identity) => pid === 7051 && identity === "live:project-blocker",
      }).value;
      await expectLockStatus(
        () => observeRenames(
          () => publicFleet ? acquirePublicFleetOwners(contenderBase, deps) : acquireRunOwners(contenderBase, deps),
          (_source, target) => {
            if (target === lockPath(root, "application", contenderBase.resourceKey)) {
              priorScopePublished = true;
              monotonic = 14_999;
            }
          },
        ),
        "run-busy",
      );
      assert.equal(priorScopePublished, true);
      assert.ok(Math.max(...calls) <= 15_000, `shared project budget renewed: ${calls}`);
      if (!publicFleet) assert.equal(fs.existsSync(lockPath(root, "run", RUN_ID_2)), false);
      assert.equal(fs.existsSync(lockPath(root, "application", contenderBase.resourceKey)), false);
      assert.ok(fs.existsSync(lockPath(root, "project", blockerContext.input.projectResourceKey)));
    });
  }
});

test("a committed owner publication is cleaned when confirmation or enrollment release fails", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root);
  const deps = dependencies(root).value;
  const applicationPath = lockPath(root, "application", context.input.resourceKey);
  const activeEnrollment = path.join(root, "locks", "capacity-enrollment", "ACTIVE.json");
  const originalRename = fs.renameSync;
  let applicationCommitted = false;
  let releaseFailed = false;
  fs.renameSync = (source, target) => {
    const sourcePath = String(source);
    const targetPath = String(target);
    if (applicationCommitted && !releaseFailed && sourcePath === activeEnrollment
        && targetPath.includes("ACTIVE.released.")) {
      releaseFailed = true;
      const error = new Error("injected capacity release failure after application publication");
      error.code = "EIO";
      throw error;
    }
    const result = originalRename(source, target);
    if (targetPath === applicationPath) applicationCommitted = true;
    return result;
  };
  try {
    await expectLockStatus(
      () => acquireRunOwners(context.input, deps),
      "state-write-failed",
      /capacity|release|publication|owner/i,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(applicationCommitted, true);
  assert.equal(releaseFailed, true);
  assert.deepEqual(
    Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)),
    [false, false, false],
    "the scope whose rename committed cannot survive as an untracked suffix",
  );
});

test("elapsed time never reaps a live owner", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root);
  const liveDeps = dependencies(root, { pid: 7101, identity: "live:old" }).value;
  const owner = await acquireRunOwners(input, liveDeps);
  const contenderDeps = dependencies(root, {
    pid: 7102,
    identity: "live:new",
    monotonicStart: 1_000_000,
    monotonicStep: 15_000,
    isProcessIdentityLive: (pid, identity) => pid === 7101 && identity === "live:old",
  }).value;
  await expectLockStatus(() => acquireRunOwners({ ...input, deadlineMonotonicMs: 2_000_000 }, contenderDeps), "run-busy");
  assert.equal(readOnlyOwner(lockPath(root, "run", RUN_ID)).token, owner.run.token);
});

test("dead owner and PID reuse are recovery-required and never silently stolen", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root);
  const first = await acquireRunOwners(input, dependencies(root, { pid: 7201, identity: "start:a" }).value);
  const dead = dependencies(root, {
    pid: 7202,
    identity: "start:b",
    isProcessIdentityLive: () => false,
  }).value;
  await expectLockStatus(() => acquireRunOwners(input, dead), "recovery-required", /dead|recovery/i);
  assert.equal(readOnlyOwner(lockPath(root, "run", RUN_ID)).token, first.run.token);

  const probes = [];
  const reused = dependencies(root, {
    pid: 7203,
    identity: "start:c",
    isProcessIdentityLive: (pid, identity) => {
      probes.push([pid, identity]);
      return pid === 7201 && identity === "start:replacement";
    },
  }).value;
  await expectLockStatus(() => acquireRunOwners(input, reused), "recovery-required", /identity|dead|recovery/i);
  assert.deepEqual(probes, [[7201, "start:a"]], "PID reuse probe consumed the stored pid plus exact process-start identity");
});

test("malformed owners and missing process identity fail closed", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root);
  const target = lockPath(root, "run", RUN_ID);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${uuidAt(50)}.owner.json`), `${canonicalJson({
    pid: 7301, token: uuidAt(50), createdAt: NOW,
  })}\n`);
  await expectLockStatus(() => acquireRunOwners(input, dependencies(root).value), "invalid-store", /owner|processIdentity|shape/i);
});

test("current process identity failure happens before any owner publication", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root);
  const deps = dependencies(root, { processIdentity: () => "" }).value;
  await expectLockStatus(() => acquireRunOwners(input, deps), "state-write-failed", /process.*identity/i);
  assert.equal(fs.existsSync(path.join(root, "locks")), false);
});

test("owner schema rejects symlinks noncanonical bytes and key-path disagreement", async (t) => {
  await t.test("symlink lock directory", async (t) => {
    const root = tempRoot(t);
    const { input } = fixtureContext(root);
    const outside = path.join(root, "outside-owner");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(root, "locks", "run"), { recursive: true });
    fs.symlinkSync(outside, lockPath(root, "run", RUN_ID));
    await expectLockStatus(() => acquireRunOwners(input, dependencies(root).value), "invalid-store", /symlink|unsafe|no-follow/i);
  });
  await t.test("noncanonical owner bytes", async (t) => {
    const root = tempRoot(t);
    const { input } = fixtureContext(root);
    const record = manualOwner(input, "run");
    writeManualOwner(root, "run", RUN_ID, record, `${JSON.stringify(record, null, 2)}\n`);
    await expectLockStatus(() => acquireRunOwners(input, dependencies(root).value), "invalid-store", /canonical/i);
  });
  await t.test("scope key path binding", async (t) => {
    const root = tempRoot(t);
    const { input } = fixtureContext(root);
    const record = manualOwner(input, "run");
    writeManualOwner(root, "run", RUN_ID_2, record);
    await expectLockStatus(() => acquireRunOwners(input, dependencies(root).value), "invalid-store", /key|path|namespace/i);
  });
});

test("every release mutation revalidates capability origin token bytes and current process identity", async (t) => {
  await t.test("identity drift", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root);
    const deps = dependencies(root, { identity: "stable-origin" }).value;
    const owners = await acquireRunOwners(context.input, deps);
    const authority = authorizeRunOwnerRelease(owners, createdChain(owners, context.locator));
    const drifted = dependencies(root, { identity: "different-origin" }).value;
    await expectLockStatus(() => releaseDefiniteOwners(owners, authority, drifted), "state-write-failed", /identity|origin/i);
    assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [true, true, true]);
  });
  await t.test("noncanonical current owner", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root);
    const deps = dependencies(root).value;
    const owners = await acquireRunOwners(context.input, deps);
    const authority = authorizeRunOwnerRelease(owners, createdChain(owners, context.locator));
    const projectFile = path.join(lockPath(root, "project", context.input.projectResourceKey), `${owners.project.token}.owner.json`);
    fs.writeFileSync(projectFile, `${JSON.stringify(owners.project.record, null, 2)}\n`);
    await expectLockStatus(() => releaseDefiniteOwners(owners, authority, deps), "invalid-store", /canonical|owner/i);
    assert.ok(fs.existsSync(lockPath(root, "project", context.input.projectResourceKey)));
  });
  await t.test("owner leaf symlink replacement", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root);
    const deps = dependencies(root).value;
    const owners = await acquireRunOwners(context.input, deps);
    const authority = authorizeRunOwnerRelease(owners, createdChain(owners, context.locator));
    const projectPath = lockPath(root, "project", context.input.projectResourceKey);
    const projectFile = path.join(projectPath, `${owners.project.token}.owner.json`);
    const outside = path.join(root, "outside-owner.json");
    fs.writeFileSync(outside, `${canonicalJson(owners.project.record)}\n`);
    fs.unlinkSync(projectFile);
    fs.symlinkSync(outside, projectFile);
    await expectLockStatus(() => releaseDefiniteOwners(owners, authority, deps), "invalid-store", /unsafe|symbolic|owner/i);
    assert.ok(fs.existsSync(projectPath));
  });
});

test("same application serializes different runs and same physical project serializes different applications", async (t) => {
  const root = tempRoot(t);
  const firstContext = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  await acquireRunOwners(firstContext.input, dependencies(root, { pid: 7401, identity: "live:first" }).value);
  const sameApp = fixtureContext(root, {
    runId: RUN_ID_2, mode: "execution", attemptId: ATTEMPT_ID_2, deadlineMonotonicMs: 2,
  });
  await expectLockStatus(() => acquireRunOwners(sameApp.input, dependencies(root, {
    pid: 7402, identity: "live:second", monotonicStep: 2,
    uuidStart: 100,
    isProcessIdentityLive: (pid, identity) => pid === 7401 && identity === "live:first",
  }).value), "run-busy");
  assert.equal(fs.existsSync(lockPath(root, "run", RUN_ID_2)), false);

  const otherApp = { ...sameApp.input, resourceKey: "f".repeat(64), deadlineMonotonicMs: 2 };
  await expectLockStatus(() => acquireRunOwners(otherApp, dependencies(root, {
    pid: 7403, identity: "live:third", monotonicStep: 2,
    uuidStart: 200,
    isProcessIdentityLive: (pid, identity) => pid === 7401 && identity === "live:first",
  }).value), "run-busy");
  assert.equal(fs.existsSync(lockPath(root, "application", otherApp.resourceKey)), false);
});

test("dead pre-target strict prefixes recover in reverse order", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquireRunOwners(input, dependencies(root, { pid: 7501, identity: "dead:prefix" }).value);
  const result = await recoverDeadPrefix({
    kind: "run-prefix",
    owners: [owners.run.record, owners.application.record, owners.project.record],
    chain: null,
    classification: "pre-target",
  }, dependencies(root, { pid: 7502, identity: "reaper", isProcessIdentityLive: () => false }).value);
  assert.equal(result.status, "recovery-required", result.detail);
  assert.deepEqual(Object.values(pathsFor(root, input)).map((target) => fs.existsSync(target)), [false, false, false]);
});

test("run-only and run-application acquisition prefixes are independently recoverable pre-target", async (t) => {
  for (const length of [1, 2]) {
    await t.test(`prefix length ${length}`, async (t) => {
      const root = tempRoot(t);
      const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
      const owners = await acquireRunOwners(context.input, dependencies(root, { pid: 7521 + length, identity: `dead:prefix:${length}` }).value);
      const records = [owners.run.record, owners.application.record, owners.project.record];
      for (let index = records.length - 1; index >= length; index -= 1) fs.rmSync(recordLockPathForTest(root, records[index]), { recursive: true });
      const result = await recoverDeadPrefix({
        kind: "run-prefix", owners: records.slice(0, length), chain: null, classification: "pre-target",
      }, dependencies(root, { pid: 7531 + length, identity: "fresh-prefix-reaper", isProcessIdentityLive: () => false }).value);
      assert.equal(result.status, "recovery-required", result.detail);
      assert.equal(fs.existsSync(recordLockPathForTest(root, records[0])), false);
    });
  }
});

test("recovery independently proves every omitted later-scope owner is absent", async (t) => {
  for (const length of [1, 2]) {
    await t.test(`run prefix length ${length} cannot omit an extant later scope`, async (t) => {
      const root = tempRoot(t);
      const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
      const owners = await acquireRunOwners(
        context.input,
        dependencies(root, { pid: 7541 + length, identity: `dead:omitted:${length}` }).value,
      );
      const records = [owners.run.record, owners.application.record, owners.project.record];
      const result = await recoverDeadPrefix({
        kind: "run-prefix",
        owners: records.slice(0, length),
        chain: null,
        classification: "pre-target",
      }, dependencies(root, {
        pid: 7549,
        identity: "reaper:omitted",
        isProcessIdentityLive: () => false,
      }).value);
      assert.equal(result.status, "invalid-store");
      assert.deepEqual(
        Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)),
        [true, true, true],
        "an unreported later-scope owner prevents every recovery mutation",
      );
    });
  }

  await t.test("public application prefix cannot omit its extant project owner", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
    const owners = await acquirePublicFleetOwners(
      context.input,
      dependencies(root, { pid: 7551, identity: "dead:public-omitted" }).value,
    );
    const result = await recoverDeadPrefix({
      kind: "public-fleet-prefix",
      owners: [owners.application.record],
      started: null,
      completed: null,
      classification: "pre-started",
    }, dependencies(root, {
      pid: 7552,
      identity: "reaper:public-omitted",
      isProcessIdentityLive: () => false,
    }).value);
    assert.equal(result.status, "invalid-store");
    assert.deepEqual(
      [owners.application, owners.project].map((owner) => fs.existsSync(recordLockPathForTest(root, owner.record))),
      [true, true],
      "an unreported public project owner prevents every recovery mutation",
    );
  });

  await t.test("run-application prefix retains all owners when the exact project path is mismatched", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
    const owners = await acquireRunOwners(
      context.input,
      dependencies(root, { pid: 7553, identity: "dead:run-project-mismatch" }).value,
    );
    const projectPath = recordLockPathForTest(root, owners.project.record);
    fs.rmSync(projectPath, { recursive: true });
    const mismatchedProject = { ...owners.project.record, attemptId: ATTEMPT_ID_2 };
    writeManualOwner(root, "project", context.input.projectResourceKey, mismatchedProject);
    const result = await recoverDeadPrefix({
      kind: "run-prefix",
      owners: [owners.run.record, owners.application.record],
      chain: null,
      classification: "pre-target",
    }, dependencies(root, {
      pid: 7554,
      identity: "reaper:run-project-mismatch",
      isProcessIdentityLive: () => false,
    }).value);
    assert.equal(result.status, "invalid-store");
    assert.deepEqual(
      [owners.run.record, owners.application.record, mismatchedProject]
        .map((record) => fs.existsSync(recordLockPathForTest(root, record))),
      [true, true, true],
      "an exact-path mismatched project owner prevents every recovery mutation",
    );
  });

  await t.test("run-only prefix retains a same-run application owner from a different process generation", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
    const owners = await acquireRunOwners(
      context.input,
      dependencies(root, { pid: 7557, identity: "dead:run-only-prefix" }).value,
    );
    fs.rmSync(recordLockPathForTest(root, owners.project.record), { recursive: true });
    const applicationPath = recordLockPathForTest(root, owners.application.record);
    fs.rmSync(applicationPath, { recursive: true });
    const mismatchedApplication = {
      ...owners.application.record,
      pid: 7558,
      processIdentity: "dead:same-run-application-generation",
    };
    writeManualOwner(root, "application", context.input.resourceKey, mismatchedApplication);
    const result = await recoverDeadPrefix({
      kind: "run-prefix",
      owners: [owners.run.record],
      chain: null,
      classification: "pre-target",
    }, dependencies(root, {
      pid: 7559,
      identity: "reaper:run-only-prefix",
      isProcessIdentityLive: () => false,
    }).value);
    assert.equal(result.status, "invalid-store");
    assert.deepEqual(
      [owners.run.record, mismatchedApplication]
        .map((record) => fs.existsSync(recordLockPathForTest(root, record))),
      [true, true],
      "a same-run omitted application owner prevents every recovery mutation",
    );
  });

  await t.test("public application prefix retains both owners when the exact project path is mismatched", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
    const owners = await acquirePublicFleetOwners(
      context.input,
      dependencies(root, { pid: 7555, identity: "dead:public-project-mismatch" }).value,
    );
    const projectPath = recordLockPathForTest(root, owners.project.record);
    fs.rmSync(projectPath, { recursive: true });
    const mismatchedProject = { ...owners.project.record, attemptId: ATTEMPT_ID_2 };
    writeManualOwner(root, "project", context.input.projectResourceKey, mismatchedProject);
    const result = await recoverDeadPrefix({
      kind: "public-fleet-prefix",
      owners: [owners.application.record],
      started: null,
      completed: null,
      classification: "pre-started",
    }, dependencies(root, {
      pid: 7556,
      identity: "reaper:public-project-mismatch",
      isProcessIdentityLive: () => false,
    }).value);
    assert.equal(result.status, "invalid-store");
    assert.deepEqual(
      [owners.application.record, mismatchedProject]
        .map((record) => fs.existsSync(recordLockPathForTest(root, record))),
      [true, true],
      "an exact-path mismatched public project owner prevents every recovery mutation",
    );
  });

});

test("run-only and run-application durable release prefixes consume exact ordinary quarantine witnesses", async (t) => {
  for (const mode of ["coordination", "execution"]) {
    for (const length of mode === "coordination" ? [1, 2] : [1]) {
      await t.test(`${mode} prefix length ${length}`, async (t) => {
        const root = tempRoot(t);
        const context = fixtureContext(root, mode === "coordination" ? {} : { mode: "execution", attemptId: ATTEMPT_ID });
        const owners = await acquireRunOwners(context.input, dependencies(root, { pid: 7541, identity: `dead:${mode}:${length}` }).value);
        const records = [owners.run.record, owners.application.record, owners.project.record];
        const chain = mode === "coordination"
          ? createdChain(owners, context.locator)
          : definiteChain(owners, context.locator);
        let cleanup = 90_000;
        for (let index = records.length - 1; index >= length; index -= 1) {
          moveOwnerToResidue(root, records[index], uuidAt(cleanup));
          cleanup += 1;
        }
        const result = await recoverDeadPrefix({
          kind: "run-prefix",
          owners: records.slice(0, length),
          chain,
          classification: mode === "coordination" ? "coordination-head" : "definite-outcome-head",
        }, dependencies(root, { pid: 7542, identity: "fresh-release-reaper", isProcessIdentityLive: () => false, uuidStart: 91_000 }).value);
        assert.equal(result.status, "unchanged", result.detail);
        assert.equal(fs.existsSync(recordLockPathForTest(root, records[0])), false);
      });
    }
  }
});

test("recovery elections are exact token-specific canonical directories acquired forward and quarantined reverse", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquireRunOwners(context.input, dependencies(root, { pid: 7551, identity: "dead:election-owner" }).value);
  const records = [owners.run.record, owners.application.record, owners.project.record];
  const electionPaths = records.map((record) => `${lockPath(
    root,
    record.scope,
    record.scope === "run" ? record.runId : record.scope === "application" ? record.resourceKey : record.projectResourceKey,
  )}.recover.${sha256(record.token)}`);
  const deps = dependencies(root, {
    pid: 7552,
    identity: "recovery-election:7552",
    isProcessIdentityLive: () => false,
    uuidStart: 3_400,
  }).value;
  let result;
  const events = await observeRenames(async () => {
    result = await recoverDeadPrefix({
      kind: "run-prefix",
      owners: records,
      chain: null,
      classification: "pre-target",
    }, deps);
  });
  assert.equal(result.status, "recovery-required", result.detail);
  const acquisitions = events.filter(({ source, target }) => source.includes(".recover.") && source.includes(".claim.") && electionPaths.includes(target));
  assert.deepEqual(acquisitions.map(({ target }) => electionPaths.indexOf(target)), [0, 1, 2]);
  const releases = events.filter(({ source, target }) => electionPaths.includes(source) && target.includes(".released."));
  assert.deepEqual(releases.map(({ source }) => electionPaths.indexOf(source)), [2, 1, 0]);
  for (const { source, target } of releases) {
    const election = readOnlyElection(target);
    const index = electionPaths.indexOf(source);
    assert.deepEqual(Object.keys(election).sort(), [
      "kind", "schemaVersion", "pid", "processIdentity", "token", "createdAt", "scope", "ownerToken", "lockPath",
    ].sort());
    assert.equal(election.ownerToken, records[index].token);
    assert.equal(election.lockPath, recordLockPathForTest(root, records[index]));
    const prefix = `${source}.released.${sha256(election.token)}.`;
    assert.ok(target.startsWith(prefix));
    assert.match(target.slice(prefix.length), UUID_V4);
    assert.equal(fs.readFileSync(path.join(target, `${election.token}.election.json`), "utf8"), `${canonicalJson(election)}\n`);
  }
});

test("a committed election publication is cleaned when enrollment release fails", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquireRunOwners(
    context.input,
    dependencies(root, { pid: 7561, identity: "dead:election-publication" }).value,
  );
  const applicationElection = `${recordLockPathForTest(root, owners.application.record)}.recover.${sha256(owners.application.token)}`;
  const activeEnrollment = path.join(root, "locks", "capacity-enrollment", "ACTIVE.json");
  const originalRename = fs.renameSync;
  let applicationCommitted = false;
  let releaseFailed = false;
  fs.renameSync = (source, target) => {
    const sourcePath = String(source);
    const targetPath = String(target);
    if (applicationCommitted && !releaseFailed && sourcePath === activeEnrollment
        && targetPath.includes("ACTIVE.released.")) {
      releaseFailed = true;
      const error = new Error("injected capacity release failure after election publication");
      error.code = "EIO";
      throw error;
    }
    const result = originalRename(source, target);
    if (targetPath === applicationElection) applicationCommitted = true;
    return result;
  };
  let result;
  try {
    result = await recoverDeadPrefix({
      kind: "run-prefix",
      owners: [owners.run.record, owners.application.record, owners.project.record],
      chain: null,
      classification: "pre-target",
    }, dependencies(root, {
      pid: 7562,
      identity: "reaper:election-publication",
      isProcessIdentityLive: () => false,
      uuidStart: 75_620,
    }).value);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(applicationCommitted, true);
  assert.equal(releaseFailed, true);
  assert.equal(result.status, "state-write-failed");
  assert.equal(fs.existsSync(applicationElection), false, "the committed current-scope election cannot become an untracked suffix");
  assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [true, true, true]);
});

test("fresh election tokens cannot reuse a recognized election residue generation", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquireRunOwners(
    context.input,
    dependencies(root, { pid: 7563, identity: "dead:election-token-owner" }).value,
  );
  const token = uuidAt(75_630);
  const election = writeElectionForOwner(root, owners.run.record, {
    pid: 7564,
    processIdentity: "reaper:election-token-residue",
    token,
  });
  const residue = `${election.target}.released.${sha256(token)}.${uuidAt(75_631)}`;
  fs.renameSync(election.target, residue);
  const result = await recoverDeadPrefix({
    kind: "run-prefix",
    owners: [owners.run.record, owners.application.record, owners.project.record],
    chain: null,
    classification: "pre-target",
  }, dependencies(root, {
    pid: 7564,
    identity: "reaper:election-token-residue",
    isProcessIdentityLive: () => false,
    uuid: () => token,
  }).value);
  assert.equal(result.status, "invalid-store");
  assert.equal(fs.existsSync(residue), true);
  assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [true, true, true]);
});

test("stale election quarantine restores rather than moving a replacement generation", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquireRunOwners(
    context.input,
    dependencies(root, { pid: 7571, identity: "dead:election-owner" }).value,
  );
  const stale = writeElectionForOwner(root, owners.run.record, {
    pid: 7572,
    processIdentity: "dead:stale-election",
    token: uuidAt(75_720),
  });
  const replacement = {
    ...stale.record,
    pid: 7573,
    processIdentity: "live:replacement-election",
    token: uuidAt(75_730),
  };
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    const sourcePath = String(source);
    const targetPath = String(target);
    if (!injected && sourcePath === stale.target && targetPath.startsWith(`${stale.target}.released.`)) {
      injected = true;
      fs.rmSync(stale.target, { recursive: true });
      writeElectionForOwner(root, owners.run.record, replacement);
    }
    return originalRename(source, target);
  };
  let result;
  try {
    result = await recoverDeadPrefix({
      kind: "run-prefix",
      owners: [owners.run.record, owners.application.record, owners.project.record],
      chain: null,
      classification: "pre-target",
    }, dependencies(root, {
      pid: 7574,
      identity: "reaper:stale-election",
      isProcessIdentityLive: (pid, identity) => pid === replacement.pid && identity === replacement.processIdentity,
      uuidStart: 75_740,
    }).value);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(injected, true);
  assert.equal(result.status, "invalid-store");
  assert.ok(fs.existsSync(stale.target), "replacement election remains at its canonical active path");
  assert.deepEqual(readOnlyElection(stale.target), replacement);
  assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [true, true, true]);
});

test("every run suffix skipped-middle and mismatched generation classification remains invalid and retained", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquireRunOwners(input, dependencies(root, { pid: 7601, identity: "dead:invalid" }).value);
  const reaper = dependencies(root, { pid: 7602, identity: "reaper", isProcessIdentityLive: () => false }).value;
  const invalidOwners = [
    ["application suffix", [owners.application.record]],
    ["project suffix", [owners.project.record]],
    ["application-project suffix", [owners.application.record, owners.project.record]],
    ["skipped middle", [owners.run.record, owners.project.record]],
    ["attempt mismatch", [owners.run.record, { ...owners.application.record, attemptId: ATTEMPT_ID_2 }]],
    ["mode mismatch", [owners.run.record, { ...owners.application.record, mode: "coordination", attemptId: null }]],
    ["run mismatch", [owners.run.record, { ...owners.application.record, runId: RUN_ID_2 }]],
    ["resource mismatch", [owners.run.record, { ...owners.application.record, resourceKey: "e".repeat(64) }]],
    ["project mismatch", [owners.run.record, { ...owners.application.record, projectResourceKey: "d".repeat(64) }]],
    ["path mismatch", [owners.run.record, { ...owners.application.record, physicalProjectDir: path.join(root, "other") }]],
    ["token mismatch", [owners.run.record, { ...owners.application.record, token: uuidAt(7603) }]],
  ];
  for (const [label, records] of invalidOwners) {
    const result = await recoverDeadPrefix({
      kind: "run-prefix", owners: records, chain: null, classification: "pre-target",
    }, reaper);
    assert.equal(result.status, "invalid-store", label);
  }
  assert.deepEqual(Object.values(pathsFor(root, input)).map((target) => fs.existsSync(target)), [true, true, true]);
});

test("recovery classification is exhaustive and pre-target independently proves durable state absence", async (t) => {
  await t.test("attempt-started cannot be mislabeled pre-target", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
    const owners = await acquireRunOwners(
      context.input,
      dependencies(root, { pid: 7651, identity: "dead:mislabeled-pretarget" }).value,
    );
    runningChain(owners, context.locator, "attempt-started");
    const result = await recoverDeadPrefix({
      kind: "run-prefix",
      owners: [owners.run.record, owners.application.record, owners.project.record],
      chain: null,
      classification: "pre-target",
    }, dependencies(root, {
      pid: 7652,
      identity: "reaper:mislabeled-pretarget",
      isProcessIdentityLive: () => false,
    }).value);
    assert.equal(result.status, "invalid-store");
    assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [true, true, true]);
  });

  await t.test("unknown run discriminator cannot fall through to quarantine", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root);
    const owners = await acquireRunOwners(
      context.input,
      dependencies(root, { pid: 7661, identity: "dead:unknown-run-classification" }).value,
    );
    const chain = createdChain(owners, context.locator);
    const result = await recoverDeadPrefix({
      kind: "run-prefix",
      owners: [owners.run.record, owners.application.record, owners.project.record],
      chain,
      classification: "definitely-safe-but-unknown",
    }, dependencies(root, {
      pid: 7662,
      identity: "reaper:unknown-run-classification",
      isProcessIdentityLive: () => false,
    }).value);
    assert.equal(result.status, "invalid-store");
    assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [true, true, true]);
  });

  await t.test("unknown public discriminator cannot release a started-only pair", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
    const owners = await acquirePublicFleetOwners(
      context.input,
      dependencies(root, { pid: 7671, identity: "dead:unknown-public-classification" }).value,
    );
    const started = writePublicStarted(root, owners);
    const result = await recoverDeadPrefix({
      kind: "public-fleet-prefix",
      owners: [owners.application.record, owners.project.record],
      started,
      completed: null,
      classification: "definitely-safe-but-unknown",
    }, dependencies(root, {
      pid: 7672,
      identity: "reaper:unknown-public-classification",
      isProcessIdentityLive: () => false,
    }).value);
    assert.equal(result.status, "invalid-store");
    assert.deepEqual(
      [owners.application, owners.project].map((owner) => fs.existsSync(recordLockPathForTest(root, owner.record))),
      [true, true],
    );
  });
});

test("token-specific recovery never touches a replacement owner generation", async (t) => {
  const root = tempRoot(t);
  const { input } = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquireRunOwners(input, dependencies(root, { pid: 7701, identity: "dead:old" }).value);
  const projectPath = lockPath(root, "project", input.projectResourceKey);
  fs.rmSync(projectPath, { recursive: true });
  const replacement = {
    ...owners.project.record,
    pid: 7702,
    processIdentity: "live:replacement",
    token: uuidAt(777),
    runId: RUN_ID_2,
    attemptId: ATTEMPT_ID_2,
  };
  fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, `${replacement.token}.owner.json`), `${canonicalJson(replacement)}\n`);
  const result = await recoverDeadPrefix({
    kind: "run-prefix",
    owners: [owners.run.record, owners.application.record, owners.project.record],
    chain: null,
    classification: "pre-target",
  }, dependencies(root, {
    pid: 7703,
    identity: "reaper",
    isProcessIdentityLive: (pid, identity) => pid === 7702 && identity === "live:replacement",
  }).value);
  assert.equal(result.status, "invalid-store");
  assert.equal(readOnlyOwner(projectPath).token, replacement.token);
  assert.ok(fs.existsSync(lockPath(root, "run", RUN_ID)));
  assert.ok(fs.existsSync(lockPath(root, "application", input.resourceKey)));
});

test("recovery revalidates the selected owner generation immediately before reverse quarantine", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquireRunOwners(context.input, dependencies(root, { pid: 7751, identity: "dead:selected" }).value);
  const records = [owners.run.record, owners.application.record, owners.project.record];
  let replacement = null;
  const reaper = dependencies(root, {
    pid: 7752,
    identity: "reaper:replacement-race",
    isProcessIdentityLive: () => false,
    uuidStart: 80_000,
  }).value;
  const projectPath = recordLockPathForTest(root, owners.project.record);
  const displaced = `${projectPath}.displaced-by-test`;
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (String(source) === projectPath && String(target).startsWith(`${projectPath}.released.`) && replacement === null) {
      originalRename(source, displaced);
      replacement = {
        ...owners.project.record,
        pid: 7753,
        processIdentity: "same-uid-replacement:7753",
        token: uuidAt(7753),
        attemptId: ATTEMPT_ID_2,
      };
      writeManualOwner(root, "project", context.input.projectResourceKey, replacement);
    }
    return originalRename(source, target);
  };
  let result;
  try {
    result = await recoverDeadPrefix({
      kind: "run-prefix", owners: records, chain: null, classification: "pre-target",
    }, reaper);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(result.status, "invalid-store");
  assert.ok(replacement);
  assert.equal(readOnlyOwner(recordLockPathForTest(root, owners.project.record)).token, replacement.token);
  assert.ok(fs.existsSync(recordLockPathForTest(root, owners.application.record)));
  assert.ok(fs.existsSync(recordLockPathForTest(root, owners.run.record)));
});

test("attempt-in-doubt recovery retains the complete exact generation", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  const { input } = context;
  const owners = await acquireRunOwners(input, dependencies(root, { pid: 7801, identity: "dead:doubt" }).value);
  const chain = runningChain(owners, context.locator, "attempt-in-doubt").chain;
  const result = await recoverDeadPrefix({
    kind: "run-prefix",
    owners: [owners.run.record, owners.application.record, owners.project.record],
    chain,
    classification: "attempt-in-doubt",
  }, dependencies(root, { pid: 7802, identity: "reaper", isProcessIdentityLive: () => false }).value);
  assert.equal(result.status, "interrupted-in-doubt");
  assert.deepEqual(Object.values(pathsFor(root, input)).map((target) => fs.existsSync(target)), [true, true, true]);
});

test("attempt-started HEAD and publication-complete lagging tail both become retained in doubt", async (t) => {
  for (const lagging of [false, true]) {
    await t.test(lagging ? "lagging linked tail" : "authoritative attempt-started", async (t) => {
      const root = tempRoot(t);
      const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
      const owners = await acquireRunOwners(context.input, dependencies(root, { pid: lagging ? 7881 : 7871, identity: `dead:attempt-started:${lagging}` }).value);
      const published = runningChain(owners, context.locator, "attempt-started", !lagging);
      const result = await recoverDeadPrefix({
        kind: "run-prefix",
        owners: [owners.run.record, owners.application.record, owners.project.record],
        chain: published.chain,
        classification: "attempt-in-doubt",
      }, dependencies(root, { pid: lagging ? 7882 : 7872, identity: "reaper", isProcessIdentityLive: () => false }).value);
      assert.equal(result.status, "interrupted-in-doubt");
      const reopened = published.store.readCommittedRun(RUN_ID, {
        parseRevision: parseRunRevision, parseHead: parseRunHead, parseSnapshot: parseSnapshotEnvelope,
      });
      assert.equal(reopened.head.revision, 1);
      assert.deepEqual(Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)), [true, true, true]);
    });
  }
});

test("lagging definite tails cannot advance or release a different execution owner generation", async (t) => {
  for (const kind of ["attempt", "target"]) {
    await t.test(`wrong ${kind}`, async (t) => {
      const root = tempRoot(t);
      const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
      const owners = await acquireRunOwners(
        context.input,
        dependencies(root, { pid: 7861, identity: `dead:wrong-tail:${kind}` }).value,
      );
      const options = { publishHead: false };
      if (kind === "attempt") options.attemptId = ATTEMPT_ID_2;
      if (kind === "target") {
        const originalTarget = targetForOwners(owners, context.locator);
        const briefInput = "Different fixture target";
        const briefId = `door${[...briefInput].reduce((value, character) => (
          (value * 31 + character.charCodeAt(0)) % 1_000_003
        ), 7)}`;
        const locator = resolveProjectLocator(projectsRoot(root), briefId);
        const app = `com.fleet.${briefId}`;
        options.target = {
          ...originalTarget,
          briefInput,
          briefId,
          app,
          briefPath: path.join(locator.requestedProjectsRoot, `${briefId}.json`),
          projectDir: locator.requestedProjectDir,
          projectLocator: locator,
          resourceKey: applicationResourceKey(app, originalTarget.executionSerial),
          projectResourceKey: projectResourceKey(locator.physicalProjectDir),
        };
      }
      const published = definitePublication(owners, context.locator, options);
      const result = await recoverDeadPrefix({
        kind: "run-prefix",
        owners: [owners.run.record, owners.application.record, owners.project.record],
        chain: published.chain,
        classification: "attempt-in-doubt",
      }, dependencies(root, {
        pid: 7862,
        identity: `reaper:wrong-tail:${kind}`,
        isProcessIdentityLive: () => false,
      }).value);
      assert.equal(result.status, "invalid-store");
      const head = JSON.parse(fs.readFileSync(path.join(root, RUN_ID, "HEAD.json"), "utf8"));
      assert.equal(head.revision, 0, "mismatched linked tail never advances HEAD");
      assert.deepEqual(
        Object.values(pathsFor(root, context.input)).map((target) => fs.existsSync(target)),
        [true, true, true],
        "mismatched linked tail retains the complete owner generation",
      );
    });
  }
});

test("a completed coordination HEAD authorizes recovery of a shorter release prefix", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root);
  const { input } = context;
  const deps = dependencies(root, { pid: 7901, identity: "dead:coordination" }).value;
  const owners = await acquireRunOwners(input, deps);
  const projectPath = lockPath(root, "project", input.projectResourceKey);
  fs.rmSync(projectPath, { recursive: true });
  const chain = createdChain(owners, context.locator);
  const result = await recoverDeadPrefix({
    kind: "run-prefix",
    owners: [owners.run.record, owners.application.record],
    chain,
    classification: "coordination-head",
  }, dependencies(root, { pid: 7902, identity: "reaper", isProcessIdentityLive: () => false }).value);
  assert.equal(result.status, "unchanged");
  assert.equal(fs.existsSync(lockPath(root, "run", RUN_ID)), false);
  assert.equal(fs.existsSync(lockPath(root, "application", input.resourceKey)), false);
});

test("public dead-prefix recovery distinguishes pre-started interrupted completed and application-only cleanup", async (t) => {
  await t.test("pre-started pair", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
    const owners = await acquirePublicFleetOwners(context.input, dependencies(root, { pid: 7921, identity: "dead:public-pre" }).value);
    const result = await recoverDeadPrefix({
      kind: "public-fleet-prefix",
      owners: [owners.application.record, owners.project.record],
      started: null,
      completed: null,
      classification: "pre-started",
    }, dependencies(root, { pid: 7922, identity: "reaper", isProcessIdentityLive: () => false }).value);
    assert.equal(result.status, "recovery-required");
    assert.equal(fs.existsSync(lockPath(root, "application", context.input.resourceKey)), false);
    assert.equal(fs.existsSync(lockPath(root, "project", context.input.projectResourceKey)), false);
  });
  await t.test("pre-started application-only reverse-cleanup prefix", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
    const owners = await acquirePublicFleetOwners(context.input, dependencies(root, { pid: 7925, identity: "dead:public-app-prefix" }).value);
    moveOwnerToResidue(root, owners.project.record, uuidAt(92_501));
    const result = await recoverDeadPrefix({
      kind: "public-fleet-prefix",
      owners: [owners.application.record],
      started: null,
      completed: null,
      classification: "pre-started",
    }, dependencies(root, { pid: 7926, identity: "fresh-public-prefix-reaper", isProcessIdentityLive: () => false, uuidStart: 92_600 }).value);
    assert.equal(result.status, "recovery-required", result.detail);
    assert.equal(fs.existsSync(recordLockPathForTest(root, owners.application.record)), false);
  });
  await t.test("started retains complete pair", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
    const owners = await acquirePublicFleetOwners(context.input, dependencies(root, { pid: 7931, identity: "dead:public-started" }).value);
    const started = writePublicStarted(root, owners);
    const result = await recoverDeadPrefix({
      kind: "public-fleet-prefix",
      owners: [owners.application.record, owners.project.record],
      started,
      completed: null,
      classification: "interrupted-in-doubt",
    }, dependencies(root, { pid: 7932, identity: "reaper", isProcessIdentityLive: () => false }).value);
    assert.equal(result.status, "interrupted-in-doubt");
    assert.ok(fs.existsSync(lockPath(root, "application", context.input.resourceKey)));
    assert.ok(fs.existsSync(lockPath(root, "project", context.input.projectResourceKey)));
  });
  await t.test("completed pair and application singleton", async (t) => {
    for (const singleton of [false, true]) {
      const root = tempRoot(t);
      const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
      const owners = await acquirePublicFleetOwners(context.input, dependencies(root, { pid: singleton ? 7941 : 7951, identity: `dead:public-complete:${singleton}` }).value);
      const started = writePublicStarted(root, owners);
      const completed = publicCompletionMarker(owners);
      fs.writeFileSync(
        path.join(lockPath(root, "application", context.input.resourceKey), "EXECUTION_COMPLETED.json"),
        `${canonicalJson(completed)}\n`,
      );
      if (singleton) fs.rmSync(lockPath(root, "project", context.input.projectResourceKey), { recursive: true });
      const result = await recoverDeadPrefix({
        kind: "public-fleet-prefix",
        owners: singleton ? [owners.application.record] : [owners.application.record, owners.project.record],
        started,
        completed,
        classification: "completed",
      }, dependencies(root, { pid: singleton ? 7942 : 7952, identity: "reaper", isProcessIdentityLive: () => false }).value);
      assert.equal(result.status, "recovery-required");
      assert.equal(fs.existsSync(lockPath(root, "application", context.input.resourceKey)), false);
      assert.equal(fs.existsSync(lockPath(root, "project", context.input.projectResourceKey)), false);
    }
  });
});

test("public prefix mismatches and unexpected quarantine are invalid and retained", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { runId: null, mode: "execution", attemptId: ATTEMPT_ID });
  const owners = await acquirePublicFleetOwners(context.input, dependencies(root, { pid: 7961, identity: "dead:public-invalid" }).value);
  const started = writePublicStarted(root, owners);
  const mismatch = await recoverDeadPrefix({
    kind: "public-fleet-prefix",
    owners: [owners.application.record, { ...owners.project.record, attemptId: ATTEMPT_ID_2 }],
    started,
    completed: null,
    classification: "interrupted-in-doubt",
  }, dependencies(root, { pid: 7962, identity: "reaper", isProcessIdentityLive: () => false }).value);
  assert.equal(mismatch.status, "invalid-store");
  const unexpected = `${lockPath(root, "project", context.input.projectResourceKey)}.released.${sha256(owners.project.token)}.${uuidAt(7963)}`;
  fs.mkdirSync(unexpected);
  fs.writeFileSync(path.join(unexpected, `${owners.project.token}.owner.json`), `${canonicalJson(owners.project.record)}\n`);
  const invalid = await recoverDeadPrefix({
    kind: "public-fleet-prefix",
    owners: [owners.application.record, owners.project.record],
    started,
    completed: null,
    classification: "interrupted-in-doubt",
  }, dependencies(root, { pid: 7964, identity: "reaper", isProcessIdentityLive: () => false }).value);
  assert.equal(invalid.status, "invalid-store");
  assert.ok(fs.existsSync(lockPath(root, "application", context.input.resourceKey)));
});

test("lock-backed revision publication rejects a valid candidate for an unowned target", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root);
  const deps = dependencies(root).value;
  const owners = await acquireRunOwners(context.input, deps);
  const store = createLockBackedRunRevisionStore(deps, { rootDir: root });
  const goal = store.publishSnapshot("goal", goalEnvelope());
  const original = baseRevision();
  const briefInput = "Different lock-backed target";
  const briefId = `door${[...briefInput].reduce((value, character) => (
    (value * 31 + character.charCodeAt(0)) % 1_000_003
  ), 7)}`;
  const locator = resolveProjectLocator(projectsRoot(root), briefId);
  const app = `com.fleet.${briefId}`;
  const target = {
    ...original.target,
    briefInput,
    briefId,
    app,
    inputBaseDir: locator.requestedProjectsRoot,
    briefPath: path.join(locator.requestedProjectsRoot, `${briefId}.json`),
    projectDir: locator.requestedProjectDir,
    projectLocator: locator,
    resourceKey: applicationResourceKey(app, original.target.executionSerial),
    projectResourceKey: projectResourceKey(locator.physicalProjectDir),
  };
  const revision = refreshRevisionId({
    ...original,
    runId: RUN_ID,
    intent: { ...original.intent, goal },
    target,
  });
  const request = { runId: RUN_ID, expectedRevision: null, ownerToken: owners.run.token, mode: "coordination" };
  assert.throws(
    () => store.publishRevision(revision, request),
    /owner|target|resource|project|path|authority/i,
  );
  assert.equal(fs.existsSync(path.join(root, RUN_ID, "revisions", "0.json")), false);
});

test("coordination store authority rejects every attempt-bound revision candidate", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root);
  const deps = dependencies(root).value;
  const owners = await acquireRunOwners(context.input, deps);
  const store = createLockBackedRunRevisionStore(deps, { rootDir: root });
  const mirrorRoot = tempRoot(t);
  const mirrorLocator = fixtureContext(mirrorRoot).locator;
  const candidate = definitePublication(owners, mirrorLocator, {
    target: targetForOwners(owners, context.locator),
    baseTarget: targetForOwners(owners, context.locator),
    publishHead: false,
  }).tail;
  const request = {
    runId: RUN_ID,
    expectedRevision: null,
    ownerToken: owners.run.token,
    mode: "coordination",
  };
  assert.throws(
    () => store.publishRevision(candidate, request),
    /coordination|attempt|mode|state-only|authority/i,
  );
  assert.equal(fs.existsSync(path.join(root, RUN_ID, "revisions", "1.json")), false);
});

test("lock-backed HEAD publication rejects raw linked revisions outside the exact owner generation", async (t) => {
  await t.test("mismatched target", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root);
    const deps = dependencies(root, { pid: 7981, identity: "head-target-owner:7981" }).value;
    const owners = await acquireRunOwners(context.input, deps);
    const store = createLockBackedRunRevisionStore(deps, { rootDir: root });
    const { revision } = initialRevisionAndHead(store, context, owners);
    const briefInput = "Different raw linked target";
    const briefId = `door${[...briefInput].reduce((value, character) => (
      (value * 31 + character.charCodeAt(0)) % 1_000_003
    ), 7)}`;
    const locator = resolveProjectLocator(projectsRoot(root), briefId);
    const app = `com.fleet.${briefId}`;
    const mismatched = refreshRevisionId({
      ...revision,
      target: {
        ...revision.target,
        briefInput,
        briefId,
        app,
        inputBaseDir: locator.requestedProjectsRoot,
        briefPath: path.join(locator.requestedProjectsRoot, `${briefId}.json`),
        projectDir: locator.requestedProjectDir,
        projectLocator: locator,
        resourceKey: applicationResourceKey(app, revision.target.executionSerial),
        projectResourceKey: projectResourceKey(locator.physicalProjectDir),
      },
    });
    const rawAuthority = createTestRunStoreAuthority();
    const rawStore = createRunRevisionStore(rawAuthority.deps, { rootDir: root });
    rawStore.publishRevision(mismatched, rawAuthority.mint(RUN_ID, null, "coordination"));
    const head = {
      kind: "pico.workflow-run-head",
      schemaVersion: 1,
      runId: RUN_ID,
      revision: 0,
      revisionId: mismatched.revisionId,
      updatedAt: NOW,
    };
    const request = {
      runId: RUN_ID,
      expectedRevision: null,
      ownerToken: owners.run.token,
      mode: "coordination",
    };
    assert.throws(
      () => store.publishHead(null, head, request),
      /owner|target|resource|project|generation|authority/i,
    );
    assert.equal(fs.existsSync(path.join(root, RUN_ID, "HEAD.json")), false);
  });

  await t.test("attempt-bound coordination tail", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root);
    const deps = dependencies(root, { pid: 7982, identity: "head-mode-owner:7982" }).value;
    const owners = await acquireRunOwners(context.input, deps);
    const published = runningChain(owners, context.locator, "attempt-started", false);
    const store = createLockBackedRunRevisionStore(deps, { rootDir: root });
    const head = {
      kind: "pico.workflow-run-head",
      schemaVersion: 1,
      runId: RUN_ID,
      revision: 1,
      revisionId: published.tail.revisionId,
      updatedAt: NOW,
    };
    const request = {
      runId: RUN_ID,
      expectedRevision: 0,
      ownerToken: owners.run.token,
      mode: "coordination",
    };
    assert.throws(
      () => store.publishHead(published.chain.head, head, request),
      /coordination|attempt|mode|generation|authority/i,
    );
    const current = JSON.parse(fs.readFileSync(path.join(root, RUN_ID, "HEAD.json"), "utf8"));
    assert.equal(current.revision, 0);
  });
});

test("lock-backed revision store keeps its exact five methods and rejects non-owner tokens", async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root);
  const deps = dependencies(root).value;
  const owners = await acquireRunOwners(context.input, deps);
  const store = createLockBackedRunRevisionStore(deps, { rootDir: root });
  assert.deepEqual(Object.keys(store).sort(), [
    "publishHead", "publishRevision", "publishSnapshot", "readCommittedRun", "recoverLinkedTail",
  ]);

  const goal = store.publishSnapshot("goal", goalEnvelope());
  const original = baseRevision();
  const target = {
    ...original.target,
    inputBaseDir: context.locator.requestedProjectsRoot,
    briefPath: path.join(context.locator.requestedProjectsRoot, `${original.target.briefId}.json`),
    projectDir: context.locator.requestedProjectDir,
    projectLocator: context.locator,
    resourceKey: context.input.resourceKey,
    projectResourceKey: context.input.projectResourceKey,
  };
  const revision = refreshRevisionId({
    ...original,
    runId: RUN_ID,
    intent: { ...original.intent, goal },
    target,
  });
  const head = {
    kind: "pico.workflow-run-head", schemaVersion: 1, runId: RUN_ID,
    revision: 0, revisionId: revision.revisionId, updatedAt: NOW,
  };
  const forged = { runId: RUN_ID, expectedRevision: null, ownerToken: uuidAt(999), mode: "coordination" };
  assert.throws(() => store.publishRevision(revision, forged), /authority|owner|token/i);
  const request = { ...forged, ownerToken: owners.run.token };
  assert.throws(() => store.publishRevision(revision, { ...request, mode: "execution" }), /authority|mode|owner/i);
  assert.throws(() => store.publishRevision(revision, { ...request, expectedRevision: 7 }), /expectedRevision|coordinate|head|authority/i);
  assert.throws(() => store.publishRevision(revision, { ...request, runId: RUN_ID_2 }), /run|target|authority/i);
  store.publishRevision(revision, request);
  store.publishHead(null, head, request);
  const chain = store.readCommittedRun(RUN_ID, {
    parseRevision: (await import("../dist/runrevisiontypes.js")).parseRunRevision,
    parseHead: (await import("../dist/runrevisiontypes.js")).parseRunHead,
    parseSnapshot: (await import("../dist/runrevisiontypes.js")).parseSnapshotEnvelope,
  });
  assert.equal(chain.head.revisionId, revision.revisionId);
  const unauthorizedRecovery = store.recoverLinkedTail(RUN_ID, {
    runId: RUN_ID,
    expectedRevision: 0,
    ownerToken: owners.run.token,
    mode: "recovery",
  });
  assert.equal(unauthorizedRecovery.status, "state-write-failed");
  const forgedRecovery = store.recoverLinkedTail(RUN_ID, {
    runId: RUN_ID,
    expectedRevision: 0,
    ownerToken: uuidAt(998),
    mode: "recovery",
  });
  assert.equal(forgedRecovery.status, "state-write-failed");
  const wrongRunRecovery = store.recoverLinkedTail(RUN_ID, {
    runId: RUN_ID_2,
    expectedRevision: 0,
    ownerToken: owners.run.token,
    mode: "recovery",
  });
  assert.equal(wrongRunRecovery.status, "invalid-store");
});

test("lock-backed revision and HEAD publication revalidate exact authority at the final reservation callback", async (t) => {
  for (const operation of ["revision-publication", "head-publication"]) {
    for (const kind of ["removal", "replacement", "malformed", "symlink", "identity-drift"]) {
      await t.test(`${operation}: ${kind}`, async (t) => {
        const root = tempRoot(t);
        const context = fixtureContext(root);
        const pid = operation === "revision-publication" ? 8111 : 8121;
        const identity = `${operation}:${kind}:${pid}`;
        const stableDeps = dependencies(root, { pid, identity }).value;
        const owners = await acquireRunOwners(context.input, stableDeps);
        const stableStore = createLockBackedRunRevisionStore(stableDeps, { rootDir: root });
        const { revision, head } = initialRevisionAndHead(stableStore, context, owners);
        const request = {
          runId: RUN_ID,
          expectedRevision: null,
          ownerToken: owners.run.token,
          mode: "coordination",
        };
        if (operation === "head-publication") stableStore.publishRevision(revision, request);

        const race = armedRaceDependencies(root, context, owners, operation, kind, { pid, identity });
        const store = createLockBackedRunRevisionStore(race.deps, { rootDir: root });
        race.state.armed = true;
        assert.throws(
          () => operation === "revision-publication"
            ? store.publishRevision(revision, request)
            : store.publishHead(null, head, request),
          /authority|owner|identity|generation|canonical|unsafe|missing|state|store/i,
        );
        assert.equal(race.state.fired, true, "race was triggered by the active final reservation rather than a call ordinal");
        const publicationTarget = operation === "revision-publication"
          ? path.join(root, RUN_ID, "revisions", "0.json")
          : path.join(root, RUN_ID, "HEAD.json");
        assert.equal(
          fs.existsSync(publicationTarget),
          false,
          "authority loss published no immutable revision/HEAD target",
        );
      });
    }
  }
});

test("recoverLinkedTail revalidates owner and election authority at its final HEAD callback", async (t) => {
  for (const kind of ["removal", "replacement", "malformed", "symlink", "identity-drift"]) {
    await t.test(kind, async (t) => {
      const root = tempRoot(t);
      const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
      const ownerPid = 8131;
      const ownerIdentity = `dead:recovery-race:${kind}`;
      const owners = await acquireRunOwners(context.input, dependencies(root, {
        pid: ownerPid,
        identity: ownerIdentity,
      }).value);
      const published = runningChain(owners, context.locator, "attempt-started", false);
      const reaperPid = 8132;
      const race = armedRaceDependencies(root, context, owners, "head-publication", kind, {
        pid: reaperPid,
        identity: `reaper-race:${kind}`,
        isProcessIdentityLive: () => false,
        uuidStart: 70_000,
      });
      race.state.armed = true;
      const result = await recoverDeadPrefix({
        kind: "run-prefix",
        owners: [owners.run.record, owners.application.record, owners.project.record],
        chain: published.chain,
        classification: "attempt-in-doubt",
      }, race.deps);
      assert.equal(race.state.fired, true, "recovery race was triggered only after the HEAD reservation became active");
      assert.equal(result.status, "state-write-failed");
      const currentHead = JSON.parse(fs.readFileSync(path.join(root, RUN_ID, "HEAD.json"), "utf8"));
      assert.equal(currentHead.revision, 0, "failed final recovery authority did not advance HEAD");
      assert.ok(fs.existsSync(path.join(root, RUN_ID, "revisions", "1.json")), "the linked immutable tail remains for diagnosis");
    });
  }
});

test("lock namespaces accept exactly 4096 each and 12288 aggregate but reject every 4097th and prospective publication", { timeout: 180_000 }, async (t) => {
  await t.test("exact per-scope and aggregate limits", async (t) => {
    const root = tempRoot(t);
    const context = fixtureContext(root);
    for (const scope of ["run", "application", "project"]) {
      for (let index = 0; index < 4_095; index += 1) writeRecognizedOwnerResidue(root, scope, index);
      assert.equal(fs.readdirSync(path.join(root, "locks", scope)).length, 4_095);
    }
    const owners = await acquireRunOwners(context.input, dependencies(root, { pid: 8001, identity: "live:bounded" }).value);
    for (const scope of ["run", "application", "project"]) {
      assert.equal(fs.readdirSync(path.join(root, "locks", scope)).length, 4_096);
    }
    await expectLockStatus(() => acquireRunOwners({ ...context.input, deadlineMonotonicMs: 100_000 }, dependencies(root, {
      pid: 8002,
      identity: "exact-bound-contender",
      monotonicStart: 0,
      monotonicStep: 15_000,
      isProcessIdentityLive: (pid, identity) => pid === 8001 && identity === "live:bounded",
    }).value), "run-busy");
    assert.equal(readOnlyOwner(lockPath(root, "run", RUN_ID)).token, owners.run.token);

    const prospective = fixtureContext(root, { runId: RUN_ID_2 });
    await expectLockStatus(
      () => acquireRunOwners(prospective.input, dependencies(root, { pid: 8003, identity: "prospective" }).value),
      "limit-exceeded",
      /4096|12288|prospective|capacity|namespace/i,
    );
    assert.equal(fs.readdirSync(path.join(root, "locks", "run")).length, 4_096, "rejected publication created no claim, active owner, or quarantine");
    assert.equal(fs.existsSync(lockPath(root, "run", RUN_ID_2)), false);
  });

  for (const scope of ["run", "application", "project"]) {
    await t.test(`${scope} 4097th recognized entry`, async (t) => {
      const root = tempRoot(t);
      for (let index = 0; index < 4_097; index += 1) writeRecognizedOwnerResidue(root, scope, 50_000 + index);
      const { input } = fixtureContext(root);
      await expectLockStatus(
        () => acquireRunOwners(input, dependencies(root).value),
        "limit-exceeded",
        /4096|entry|namespace/i,
      );
      assert.equal(fs.readdirSync(path.join(root, "locks", scope)).length, 4_097);
    });
  }
});

test("dead-owner recovery remains available at exact logical namespace capacity", { timeout: 180_000 }, async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  for (const scope of ["run", "application", "project"]) {
    for (let index = 0; index < 4_095; index += 1) {
      writeRecognizedOwnerResidue(root, scope, 210_000 + index);
    }
  }
  const owners = await acquireRunOwners(
    context.input,
    dependencies(root, { pid: 8201, identity: "dead:exact-logical-capacity" }).value,
  );
  const records = [owners.run.record, owners.application.record, owners.project.record];
  const result = await recoverDeadPrefix({
    kind: "run-prefix",
    owners: records,
    chain: null,
    classification: "pre-target",
  }, dependencies(root, {
    pid: 8202,
    identity: "reaper:exact-logical-capacity",
    isProcessIdentityLive: () => false,
    uuidStart: 400_000,
  }).value);
  assert.equal(result.status, "recovery-required", result.detail);
  for (const [scope, record] of [
    ["run", owners.run.record],
    ["application", owners.application.record],
    ["project", owners.project.record],
  ]) {
    const names = fs.readdirSync(path.join(root, "locks", scope));
    assert.equal(names.filter((name) => !name.includes(".recover.")).length, 4_096);
    assert.equal(names.filter((name) => name.includes(".recover.")).length, 1);
    assert.equal(fs.existsSync(recordLockPathForTest(root, record)), false);
  }
});

test("exact-cap recovery election and owner enrollment remain deterministically serialized", { timeout: 180_000 }, async (t) => {
  const root = tempRoot(t);
  const context = fixtureContext(root, { mode: "execution", attemptId: ATTEMPT_ID });
  for (const scope of ["run", "application", "project"]) {
    for (let index = 0; index < 4_095; index += 1) {
      writeRecognizedOwnerResidue(root, scope, 230_000 + index);
    }
  }
  const owners = await acquireRunOwners(
    context.input,
    dependencies(root, { pid: 8211, identity: "dead:exact-capacity-race" }).value,
  );
  fs.writeFileSync(path.join(root, "capacity-recovery-input.json"), `${JSON.stringify({
    owners: [owners.run.record, owners.application.record, owners.project.record],
  })}\n`);

  const recovery = spawnCapacityAbaChild(root, "capacity-recover");
  let contender = null;
  try {
    await recovery.waitBarrier("recovery-before-election-publish", 60_000);
    contender = spawnCapacityAbaChild(root, "capacity-cap-contender", 91);
    await contender.waitBarrier("contender-observed-live-enrollment", 60_000);
    contender.releaseBarrier("contender-observed-live-enrollment");
    recovery.releaseBarrier("recovery-before-election-publish");

    await recovery.waitBarrier("recovery-before-owner-quarantine", 60_000);
    const contenderResult = await contender.result;
    await contender.exited;
    assert.equal(contenderResult.status, "limit-exceeded", contenderResult.detail);
    recovery.releaseBarrier("recovery-before-owner-quarantine");
    const recoveryResult = await recovery.result;
    await recovery.exited;
    assert.equal(recoveryResult.status, "recovery-required", recoveryResult.detail);
    assert.deepEqual(
      [owners.run.record, owners.application.record, owners.project.record]
        .map((record) => fs.existsSync(recordLockPathForTest(root, record))),
      [false, false, false],
    );
    for (const scope of ["run", "application", "project"]) {
      const ownerEvidence = fs.readdirSync(path.join(root, "locks", scope))
        .filter((name) => !name.includes(".recover."));
      assert.equal(ownerEvidence.length, 4_096, `${scope} logical capacity remained exact`);
    }
  } finally {
    const childrenSettled = Promise.allSettled([
      recovery.result,
      recovery.exited,
      contender?.result,
      contender?.exited,
    ].filter(Boolean));
    await killChild(recovery.child);
    if (contender !== null) await killChild(contender.child);
    await childrenSettled;
  }
});

test("concurrent cross-process enrollment cannot cross exact lock namespace or aggregate capacity", { timeout: 180_000 }, async (t) => {
  const root = tempRoot(t);
  for (const scope of ["run", "application", "project"]) {
    for (let index = 0; index < 4_095; index += 1) writeRecognizedOwnerResidue(root, scope, 100_000 + index);
  }
  const children = [spawnCapacityChild(root, 1), spawnCapacityChild(root, 2)];
  try {
    await Promise.all(children.map(({ barrier }) => barrier));
    const barrierDirectory = path.join(root, "capacity-barrier");
    for (const index of [1, 2]) fs.writeFileSync(path.join(barrierDirectory, `${index}.release`), "release\n");
    const results = await Promise.all(children.map(({ result }) => result));
    await Promise.all(children.map(({ exited }) => exited));
    assert.ok(results.every(({ status }) => status === "acquired" || status === "limit-exceeded"), JSON.stringify(results));
    assert.ok(results.filter(({ status }) => status === "acquired").length <= 1, JSON.stringify(results));
    const counts = ["run", "application", "project"].map((scope) => (
      fs.readdirSync(path.join(root, "locks", scope)).length
    ));
    assert.ok(counts.every((count) => count <= 4_096), `concurrent enrollment crossed a scope bound: ${counts}`);
    assert.ok(counts.reduce((sum, count) => sum + count, 0) <= 12_288, `concurrent enrollment crossed aggregate capacity: ${counts}`);
    for (const scope of ["run", "application", "project"]) {
      assert.equal(
        fs.readdirSync(path.join(root, "locks", scope)).some((name) => name.includes(".claim.")),
        false,
        `${scope} retained no owned enrollment claim`,
      );
    }
  } finally {
    await Promise.all(children.map(({ child }) => killChild(child)));
  }
});

test("stale capacity reaper cannot admit a third process across an already-scanned final slot", { timeout: 180_000 }, async (t) => {
  const root = tempRoot(t);
  for (let index = 0; index < 4_095; index += 1) writeRecognizedOwnerResidue(root, "run", 170_000 + index);
  const enrollmentDirectory = path.join(root, "locks", "capacity-enrollment");
  fs.mkdirSync(enrollmentDirectory, { recursive: true });
  const dead = capacityEnrollmentRecord(88);
  fs.writeFileSync(path.join(enrollmentDirectory, "ACTIVE.json"), `${canonicalJson(dead)}\n`);

  const reaper = spawnCapacityAbaChild(root, "capacity-aba-reaper");
  let first = null;
  let third = null;
  try {
    await reaper.waitBarrier("b-before-stale-rename");
    first = spawnCapacityAbaChild(root, "capacity-aba-a", 1);
    await first.waitBarrier("a-after-dead-reap");
    third = spawnCapacityAbaChild(root, "capacity-aba-c", 2);
    await third.waitBarrier("c-before-enrollment-open");

    first.releaseBarrier("a-after-dead-reap");
    await first.waitBarrier("a-before-owner-publish");
    reaper.releaseBarrier("b-before-stale-rename");
    await reaper.waitBarrier("b-after-stale-rename");

    third.releaseBarrier("c-before-enrollment-open");
    const thirdDisposition = await Promise.race([
      third.waitBarrier("c-before-owner-publish").then(() => "owner-publication-admitted"),
      third.result.then(() => "rejected-before-owner-publication"),
    ]);
    reaper.releaseBarrier("b-after-stale-rename");
    first.releaseBarrier("a-before-owner-publish");
    if (thirdDisposition === "owner-publication-admitted") third.releaseBarrier("c-before-owner-publish");

    const results = await Promise.all([first.result, third.result, reaper.result]);
    await Promise.all([first.exited, third.exited, reaper.exited]);
    const runEntries = fs.readdirSync(path.join(root, "locks", "run"));
    assert.ok(
      runEntries.length <= 4_096,
      `stale-reaper admitted-window crossed the 4096 run namespace bound: ${runEntries.length}; ${JSON.stringify(results)}`,
    );
    assert.equal(
      results.filter(({ status }) => status === "acquired").length <= 1,
      true,
      `only one final-slot contender can complete: ${JSON.stringify(results)}`,
    );
  } finally {
    for (const name of [
      "b-before-stale-rename", "b-after-stale-rename", "a-after-dead-reap",
      "a-before-owner-publish", "c-before-enrollment-open", "c-before-owner-publish",
    ]) {
      reaper.releaseBarrier(name);
      first?.releaseBarrier(name);
      third?.releaseBarrier(name);
    }
    await Promise.all([reaper.child, first?.child, third?.child].filter(Boolean).map((child) => killChild(child)));
  }
});

test("capacity enrollment is crash-conservative strict and exactly eight-entry bounded", async (t) => {
  for (const cut of ["open", "write", "fsync", "link", "unlink"]) {
    await t.test(`SIGKILL after capacity staging ${cut} is bounded and fresh-process recoverable`, async (t) => {
      const root = tempRoot(t);
      const { child } = await spawnAtBarrier(root, "capacity-cut", cut);
      try {
        await killChild(child);
        const active = path.join(root, "locks", "capacity-enrollment", "ACTIVE.json");
        const context = fixtureContext(root);
        const owners = await acquireRunOwners(context.input, dependencies(root, {
          pid: 8052,
          identity: `fresh:capacity-reaper:${cut}`,
          isProcessIdentityLive: () => false,
          monotonicStep: 15_000,
          uuidStart: 140_000,
        }).value);
        assert.equal(owners.run.record.runId, RUN_ID);
        assert.equal(fs.existsSync(active), false);
        assert.deepEqual(fs.readdirSync(path.dirname(active)), [], "exact dead enrollment cleanup leaves no ordinary residue");
        const stagingDirectory = path.join(root, "locks", "capacity-enrollment-staging");
        if (fs.existsSync(stagingDirectory)) {
          assert.deepEqual(fs.readdirSync(stagingDirectory), [], "crash staging is bounded and cleaned without becoming authority");
        }
      } finally {
        await killChild(child);
      }
    });
  }

  for (const kind of ["active", "residue"]) {
    await t.test(`malformed ${kind} enrollment fails closed before an owner claim`, async (t) => {
      const root = tempRoot(t);
      const directory = path.join(root, "locks", "capacity-enrollment");
      fs.mkdirSync(directory, { recursive: true });
      const name = kind === "active"
        ? "ACTIVE.json"
        : `ACTIVE.released.${"a".repeat(64)}.${uuidAt(140_100)}.json`;
      fs.writeFileSync(path.join(directory, name), "{}\n");
      const context = fixtureContext(root);
      await expectLockStatus(() => acquireRunOwners(context.input, dependencies(root).value), "invalid-store", /capacity|enrollment|record/i);
      assert.equal(fs.existsSync(lockPath(root, "run", RUN_ID)), false);
    });
  }

  await t.test("fresh active enrollment token cannot reuse a recognized residue token", async (t) => {
    const root = tempRoot(t);
    const residueIndex = 61;
    const record = capacityEnrollmentRecord(residueIndex);
    const residue = writeCapacityEnrollmentResidue(root, residueIndex);
    const context = fixtureContext(root);
    await expectLockStatus(
      () => acquireRunOwners(context.input, dependencies(root, { uuid: () => record.token }).value),
      "invalid-store",
      /capacity|token|residue|generation|collision/i,
    );
    assert.equal(fs.existsSync(residue), true);
    assert.equal(fs.existsSync(lockPath(root, "run", RUN_ID)), false);
  });

  await t.test("seven residues plus active is accepted but an eighth residue leaves no active slot", async (t) => {
    const acceptedRoot = tempRoot(t);
    for (let index = 0; index < 7; index += 1) writeCapacityEnrollmentResidue(acceptedRoot, index);
    const acceptedContext = fixtureContext(acceptedRoot);
    await acquireRunOwners(acceptedContext.input, dependencies(acceptedRoot, { uuidStart: 150_000 }).value);
    assert.equal(fs.readdirSync(path.join(acceptedRoot, "locks", "capacity-enrollment")).length, 7);

    const rejectedRoot = tempRoot(t);
    for (let index = 0; index < 8; index += 1) writeCapacityEnrollmentResidue(rejectedRoot, 20 + index);
    const rejectedContext = fixtureContext(rejectedRoot);
    await expectLockStatus(
      () => acquireRunOwners(rejectedContext.input, dependencies(rejectedRoot, { uuidStart: 160_000 }).value),
      "limit-exceeded",
      /capacity|enrollment|slot|eight|8/i,
    );
    assert.equal(fs.readdirSync(path.join(rejectedRoot, "locks", "capacity-enrollment")).length, 8);
    assert.equal(fs.existsSync(lockPath(rejectedRoot, "run", RUN_ID)), false);
  });
});

test("owner election and quarantine directories distinguish exact eight entries from the ninth", async (t) => {
  async function assertDirectoryBound(kind, extraCount, expectedStatus, t) {
    const root = tempRoot(t);
    const context = fixtureContext(root);
    let target;
    if (kind === "owner") {
      await acquireRunOwners(context.input, dependencies(root, { pid: 8011, identity: "live:directory-bound" }).value);
      target = lockPath(root, "run", RUN_ID);
    } else if (kind === "election") {
      target = writeRecognizedElection(root, "run", 60_001);
    } else {
      target = writeRecognizedOwnerResidue(root, "run", 60_002);
    }
    for (let index = 0; index < extraCount; index += 1) fs.writeFileSync(path.join(target, `extra-${index}`), "x");
    await expectLockStatus(
      () => acquireRunOwners(context.input, dependencies(root, {
        pid: 8012,
        identity: "directory-bound-contender",
        isProcessIdentityLive: (pid, identity) => pid === 8011 && identity === "live:directory-bound",
      }).value),
      expectedStatus,
      expectedStatus === "limit-exceeded" ? /eight|8|entry/i : /unknown|invalid|entries/i,
    );
    assert.equal(fs.readdirSync(target).length, extraCount + 1);
  }

  for (const kind of ["owner", "election", "quarantine"]) {
    await t.test(`${kind} exact 8`, (t) => assertDirectoryBound(kind, 7, "invalid-store", t));
    await t.test(`${kind} 9th`, (t) => assertDirectoryBound(kind, 8, "limit-exceeded", t));
  }
});

test("cross-process live ownership blocks without touching the child generation", async (t) => {
  const root = tempRoot(t);
  const { child } = await spawnAtBarrier(root, "hold", "none");
  try {
    const childRun = "51000000-0000-4000-8000-000000000001";
    const context = fixtureContext(root, { runId: childRun, mode: "execution", attemptId: "51000000-0000-4000-8000-000000000002", deadlineMonotonicMs: performance.now() + 50 });
    const deps = dependencies(root, {
      monotonicMs: () => performance.now(),
      isProcessIdentityLive: (pid, identity) => {
        if (identity !== `runlock-child:${pid}`) return false;
        try { process.kill(pid, 0); return true; } catch { return false; }
      },
    }).value;
    const before = readOnlyOwner(lockPath(root, "run", childRun));
    await expectLockStatus(() => acquireRunOwners(context.input, deps), "run-busy");
    assert.equal(readOnlyOwner(lockPath(root, "run", childRun)).token, before.token);
  } finally {
    await killChild(child);
  }
});

test("cross-process dead prefix is recovered only from byte-identical records", async (t) => {
  const root = tempRoot(t);
  const { child, records } = await spawnAtBarrier(root, "hold", "none");
  await killChild(child);
  assert.ok(records);
  const result = await recoverDeadPrefix({
    kind: "run-prefix",
    owners: [records.run, records.application, records.project],
    chain: null,
    classification: "pre-target",
  }, dependencies(root, { isProcessIdentityLive: () => false }).value);
  assert.equal(result.status, "recovery-required");
  assert.equal(fs.existsSync(lockPath(root, "run", records.run.runId)), false);
});

for (const [cut, expectedScopes] of [
  ["run", ["run"]],
  ["application", ["run", "application"]],
  ["project", ["run", "application", "project"]],
]) {
  test(`SIGKILL after ${cut} acquisition leaves only the documented strict prefix`, async (t) => {
    const root = tempRoot(t);
    const { child } = await spawnAtBarrier(root, "cut-acquire", cut);
    try {
      await killChild(child);
      const childRun = "51000000-0000-4000-8000-000000000001";
      const locator = resolveProjectLocator(projectsRoot(root), BRIEF_ID);
      const keys = {
        run: childRun,
        application: applicationResourceKey(`com.fleet.${BRIEF_ID}`, "emulator-5554"),
        project: projectResourceKey(locator.physicalProjectDir),
      };
      const present = Object.entries(keys)
        .filter(([scope, key]) => fs.existsSync(lockPath(root, scope, key)))
        .map(([scope]) => scope);
      assert.deepEqual(present, expectedScopes);
      const ordered = expectedScopes.map((scope) => readOnlyOwner(lockPath(root, scope, keys[scope])));
      const recovered = await recoverDeadPrefix({
        kind: "run-prefix", owners: ordered, chain: null, classification: "pre-target",
      }, dependencies(root, { pid: 93_001, identity: `fresh-after-acquire-cut:${cut}`, isProcessIdentityLive: () => false, uuidStart: 93_100 }).value);
      assert.equal(recovered.status, "recovery-required", recovered.detail);
      assert.equal(fs.existsSync(lockPath(root, "run", childRun)), false);
    } finally {
      await killChild(child);
    }
  });
}

for (const [cut, expectedScopes] of [
  ["project", ["run", "application"]],
  ["application", ["run"]],
  ["run", []],
]) {
  test(`SIGKILL after ${cut} reverse quarantine leaves only an authorized release prefix`, async (t) => {
    const root = tempRoot(t);
    const { child, records } = await spawnAtBarrier(root, "cut-release", cut);
    try {
      await killChild(child);
      const childRun = "51000000-0000-4000-8000-000000000001";
      const locator = resolveProjectLocator(projectsRoot(root), BRIEF_ID);
      const keys = {
        run: childRun,
        application: applicationResourceKey(`com.fleet.${BRIEF_ID}`, "emulator-5554"),
        project: projectResourceKey(locator.physicalProjectDir),
      };
      const present = Object.entries(keys)
        .filter(([scope, key]) => fs.existsSync(lockPath(root, scope, key)))
        .map(([scope]) => scope);
      assert.deepEqual(present, expectedScopes);
      if (expectedScopes.length > 0) {
        const store = createRunRevisionStore({
          assertMutationAuthority: () => undefined,
          assertRecoveryAuthority: () => undefined,
          nowUtc: () => NOW,
        }, { rootDir: root });
        const chain = store.readCommittedRun(childRun, {
          parseRevision: parseRunRevision, parseHead: parseRunHead, parseSnapshot: parseSnapshotEnvelope,
        });
        const ordered = [records.run, records.application, records.project].slice(0, expectedScopes.length);
        const recovered = await recoverDeadPrefix({
          kind: "run-prefix", owners: ordered, chain, classification: "coordination-head",
        }, dependencies(root, { pid: 94_001, identity: `fresh-after-release-cut:${cut}`, isProcessIdentityLive: () => false, uuidStart: 94_100 }).value);
        assert.equal(recovered.status, "unchanged", recovered.detail);
        assert.equal(fs.existsSync(lockPath(root, "run", childRun)), false);
      }
    } finally {
      await killChild(child);
    }
  });
}
