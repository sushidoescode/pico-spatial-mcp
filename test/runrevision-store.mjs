import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import test from "node:test";

import { canonicalJson } from "../dist/runreceiptidentity.js";
import {
  createRunRevisionStore,
  runStoreRoot,
} from "../dist/runrevisionstore.js";
import {
  parseRunHead,
  parseRunControlResult,
  parseRunRevision,
  parseSnapshotEnvelope,
} from "../dist/runrevisiontypes.js";
import {
  ATTEMPT_ID,
  RUN_ID,
  authoredSpec,
  baseRevision,
  createTestRunStoreAuthority,
  diagnostic,
  goalEnvelope,
  refreshRevisionId,
  revisionIdOf,
  sha,
  snapshotRef,
  transitionRevision,
} from "./helpers/runrevision-fixture.mjs";

const validators = { parseRevision: parseRunRevision, parseHead: parseRunHead, parseSnapshot: parseSnapshotEnvelope };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const snapshotDirectory = {
  goal: "goal", acceptance: "acceptance", "app-spec": "spec", "brief-payload": "brief",
  "external-input": "external", "compiler-ledger": "compiler", "public-result": "result",
};

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pico-runrevision-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function objectPath(root, ref) {
  return path.join(root, "objects", snapshotDirectory[ref.kind], `${ref.sha256}.json`);
}

function revisionPath(root, number) {
  return path.join(root, RUN_ID, "revisions", `${number}.json`);
}

function headPath(root) {
  return path.join(root, RUN_ID, "HEAD.json");
}

function headOf(revision, updatedAt = "2026-08-16T12:34:56.000Z") {
  return { kind: "pico.workflow-run-head", schemaVersion: 1, runId: revision.runId, revision: revision.revision, revisionId: revision.revisionId, updatedAt };
}

function fixtureStore(root) {
  const authority = createTestRunStoreAuthority();
  const store = createRunRevisionStore(authority.deps, { rootDir: root });
  return { root, authority, store, request: authority.mint() };
}

function publishRoot(fixture) {
  const goal = fixture.store.publishSnapshot("goal", goalEnvelope());
  const revision = refreshRevisionId(baseRevision({ intent: { ...baseRevision().intent, goal } }));
  fixture.store.publishRevision(revision, fixture.request);
  const head = headOf(revision);
  fixture.store.publishHead(null, head, fixture.request);
  return { goal, revision, head };
}

function planFailedEnvelope() {
  return {
    kind: "pico.workflow-public-result", schemaVersion: 1, workflow: "pico-build-app",
    status: "plan-failed", publicResult: { status: "plan-failed", detail: {}, fix: "fixture fix" },
  };
}

function makePlanFailedTail(fixture, previous) {
  const publicResult = fixture.store.publishSnapshot("public-result", planFailedEnvelope());
  const candidate = transitionRevision(
    { type: "plan-completed", outcome: "plan-failed", diagnostic: diagnostic("plan", "fixture failure") },
    { status: "paused", publicStatus: "plan-failed" },
  );
  return refreshRevisionId({
    ...candidate,
    runId: previous.runId,
    revision: previous.revision + 1,
    parent: { revision: previous.revision, revisionId: previous.revisionId },
    intent: { ...previous.intent },
    target: structuredClone(previous.target),
    projectGeneration: structuredClone(previous.projectGeneration),
    publicResult,
  });
}

function writeCanonical(filePath, value) {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`);
}

function expectStoreStatus(fn, status) {
  assert.throws(fn, (error) => error?.status === status, `expected store status ${status}`);
}

async function killAtBarrier(root, barrier, scenario = "append") {
  const child = fork(new URL("./fixtures/runrevision-crash-child.mjs", import.meta.url), [root, barrier, scenario], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child barrier timeout (${barrier}): ${stderr}`)), 10_000);
    child.once("error", reject);
    child.on("message", (message) => {
      if (message === `barrier:${barrier}`) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("runStoreRoot uses the explicit root, then environment, then the home store", () => {
  const prior = process.env.PICO_MCP_RUN_DIR;
  try {
    process.env.PICO_MCP_RUN_DIR = "/tmp/pico-explicit-env-root";
    assert.equal(runStoreRoot({ rootDir: "/tmp/pico-option-root/../pico-option-final" }), "/tmp/pico-option-final");
    assert.equal(runStoreRoot(), "/tmp/pico-explicit-env-root");
    delete process.env.PICO_MCP_RUN_DIR;
    assert.equal(runStoreRoot(), path.join(os.homedir(), ".pico-mcp", "runs"));
  } finally {
    if (prior === undefined) delete process.env.PICO_MCP_RUN_DIR;
    else process.env.PICO_MCP_RUN_DIR = prior;
  }
});

test("snapshot identity excludes only the publication newline", (t) => {
  const root = tempRoot(t);
  const { store } = fixtureStore(root);
  const envelope = { kind: "pico.workflow-goal", schemaVersion: 1, goal: "room" };
  const ref = store.publishSnapshot("goal", envelope);
  const canonical = '{"goal":"room","kind":"pico.workflow-goal","schemaVersion":1}';
  assert.equal(ref.bytes, Buffer.byteLength(canonical));
  assert.equal(ref.sha256, sha(canonical));
  assert.equal(fs.readFileSync(objectPath(root, ref), "utf8"), canonical + "\n");
});

test("injected authority rejects plain, cloned, revoked, and wrong-target mutation requests", (t) => {
  const fixture = fixtureStore(tempRoot(t));
  const goal = fixture.store.publishSnapshot("goal", goalEnvelope());
  const revision = refreshRevisionId(baseRevision({ intent: { ...baseRevision().intent, goal } }));
  const plain = { runId: RUN_ID, expectedRevision: null, ownerToken: ATTEMPT_ID, mode: "coordination" };
  assert.throws(() => fixture.store.publishRevision(revision, plain), /authority rejected/);
  assert.throws(() => fixture.store.publishRevision(revision, structuredClone(fixture.request)), /authority rejected/);
  const wrong = fixture.authority.mint("87654321-4321-4321-8321-cba987654321");
  assert.throws(() => fixture.store.publishRevision(revision, wrong), /target mismatch/);
  fixture.authority.revoke(fixture.request);
  assert.throws(() => fixture.store.publishRevision(revision, fixture.request), /authority rejected/);
  assert.equal(fs.existsSync(revisionPath(fixture.root, 0)), false);
});

test("cloned authority cannot publish HEAD or recover a linked tail", (t) => {
  const fixture = fixtureStore(tempRoot(t));
  const root = publishRoot(fixture);
  const tail = makePlanFailedTail(fixture, root.revision);
  fixture.store.publishRevision(tail, fixture.request);
  const cloned = structuredClone(fixture.request);
  assert.throws(() => fixture.store.publishHead(root.head, headOf(tail), cloned), /authority rejected/);
  assert.equal(fixture.store.recoverLinkedTail(RUN_ID, cloned).status, "state-write-failed");
  assert.equal(JSON.parse(fs.readFileSync(headPath(fixture.root), "utf8")).revision, 0);
});

test("create, read, and append preserve exact parent identity and immutable old revisions", (t) => {
  const fixture = fixtureStore(tempRoot(t));
  const root = publishRoot(fixture);
  const oldBytes = fs.readFileSync(revisionPath(fixture.root, 0));
  const tail = makePlanFailedTail(fixture, root.revision);
  const published = fixture.store.publishRevision(tail, fixture.request);
  assert.equal(published.publication, "linked-head-pending");
  assert.equal(published.path, revisionPath(fixture.root, 1));
  fixture.store.publishHead(root.head, headOf(tail), fixture.request);
  assert.deepEqual(fs.readFileSync(revisionPath(fixture.root, 0)), oldBytes);
  assert.equal(tail.parent.revision, 0);
  assert.equal(tail.parent.revisionId, root.revision.revisionId);
  assert.equal(tail.revisionId, revisionIdOf(tail));
  const chain = fixture.store.readCommittedRun(RUN_ID, validators);
  assert.equal(chain.validation, "core-only");
  assert.deepEqual(chain.revisions.map((revision) => revision.revision), [0, 1]);
  assert.equal(chain.head.revisionId, tail.revisionId);
  assert.equal(chain.snapshots.get(`goal:${root.goal.sha256}`).goal, "Fixture");
  assert.equal(chain.snapshots.get(`public-result:${tail.publicResult.sha256}`).status, "plan-failed");
});

test("revision replacement is refused and HEAD compares the complete expected coordinate", (t) => {
  const fixture = fixtureStore(tempRoot(t));
  const root = publishRoot(fixture);
  assert.throws(() => fixture.store.publishRevision(root.revision, fixture.request), /already exists|immutable|existing HEAD/i);
  const tail = makePlanFailedTail(fixture, root.revision);
  fixture.store.publishRevision(tail, fixture.request);
  const wrongExpected = { ...root.head, revisionId: "f".repeat(64) };
  assert.throws(() => fixture.store.publishHead(wrongExpected, headOf(tail), fixture.request), /HEAD.*mismatch|expected/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(headPath(fixture.root), "utf8")), root.head);
  fixture.store.publishHead(root.head, headOf(tail), fixture.request);
  assert.throws(() => fixture.store.publishHead(headOf(tail), root.head, fixture.request), /forward|parent|backward/i);
  assert.equal(JSON.parse(fs.readFileSync(headPath(fixture.root), "utf8")).revision, 1);
});

test("reader rejects missing, wrong, and noncanonical referenced CAS bytes", async (t) => {
  for (const mutation of ["missing", "wrong", "noncanonical"]) {
    await t.test(mutation, () => {
      const fixture = fixtureStore(tempRoot(t));
      const root = publishRoot(fixture);
      const target = objectPath(fixture.root, root.goal);
      if (mutation === "missing") fs.unlinkSync(target);
      if (mutation === "wrong") fs.writeFileSync(target, '{}\n');
      if (mutation === "noncanonical") fs.writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, kind: "pico.workflow-goal", goal: "Fixture" })}\n`);
      expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store");
    });
  }
});

test("reader rejects revision gaps and filename, parent, and HEAD mismatches", async (t) => {
  for (const mutation of ["gap", "filename", "parent", "head"]) {
    await t.test(mutation, () => {
      const fixture = fixtureStore(tempRoot(t));
      const root = publishRoot(fixture);
      const tail = makePlanFailedTail(fixture, root.revision);
      fixture.store.publishRevision(tail, fixture.request);
      fixture.store.publishHead(root.head, headOf(tail), fixture.request);
      if (mutation === "gap") fs.renameSync(revisionPath(fixture.root, 1), revisionPath(fixture.root, 2));
      if (mutation === "filename") fs.renameSync(revisionPath(fixture.root, 1), path.join(path.dirname(revisionPath(fixture.root, 1)), "01.json"));
      if (mutation === "parent") writeCanonical(revisionPath(fixture.root, 1), { ...tail, parent: { revision: 0, revisionId: "f".repeat(64) } });
      if (mutation === "head") writeCanonical(headPath(fixture.root), { ...headOf(tail), revisionId: "f".repeat(64) });
      expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store");
    });
  }
});

test("reader refuses symlink components and symlink or multiply-linked leaves", async (t) => {
  await t.test("symlink run component", () => {
    const root = tempRoot(t);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pico-runrevision-elsewhere-"));
    t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    fs.symlinkSync(elsewhere, path.join(root, RUN_ID));
    const fixture = fixtureStore(root);
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store");
  });
  for (const leaf of ["symlink", "hardlink"]) {
    await t.test(`${leaf} HEAD leaf`, () => {
      const fixture = fixtureStore(tempRoot(t));
      publishRoot(fixture);
      const head = headPath(fixture.root);
      const saved = `${head}.saved`;
      fs.renameSync(head, saved);
      if (leaf === "symlink") fs.symlinkSync(saved, head);
      else fs.linkSync(saved, head);
      expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store");
    });
  }
});

test("unsafe run IDs are rejected before path construction", (t) => {
  const fixture = fixtureStore(tempRoot(t));
  for (const runId of ["../escape", RUN_ID.toUpperCase(), "objects", "12345678-1234-1234-1234-123456789abc"]) {
    expectStoreStatus(() => fixture.store.readCommittedRun(runId, validators), "invalid-store");
  }
});

test("authority is rechecked at the revision link, HEAD rename, and recovery commit boundaries", (t) => {
  const fixture = fixtureStore(tempRoot(t));
  const root = publishRoot(fixture);
  const calls = fixture.authority.calls.map((call) => call.operation);
  assert.ok(calls.filter((call) => call === "mutation:revision").length >= 2);
  assert.ok(calls.filter((call) => call === "mutation:head").length >= 2);
  const tail = makePlanFailedTail(fixture, root.revision);
  fixture.store.publishRevision(tail, fixture.request);
  const recovery = fixture.store.recoverLinkedTail(RUN_ID, fixture.request);
  assert.equal(recovery.status, "head-advanced");
  assert.ok(fixture.authority.calls.filter((call) => call.operation === "recovery").length >= 2);
});

test("a HEAD replacement performed by the authority boundary immediately before rename is rejected", (t) => {
  const root = tempRoot(t);
  const authority = createTestRunStoreAuthority();
  let headChecks = 0;
  let replacement;
  const deps = {
    ...authority.deps,
    assertMutationAuthority(request, target) {
      authority.deps.assertMutationAuthority(request, target);
      if (target.operation === "head" && ++headChecks === 2 && replacement) writeCanonical(headPath(root), replacement);
    },
  };
  const store = createRunRevisionStore(deps, { rootDir: root });
  const fixture = { root, authority, store, request: authority.mint() };
  const committed = publishRoot(fixture);
  const tail = makePlanFailedTail(fixture, committed.revision);
  store.publishRevision(tail, fixture.request);
  replacement = { ...committed.head, updatedAt: "2026-08-16T12:34:57.000Z" };
  headChecks = 0;
  assert.throws(() => store.publishHead(committed.head, headOf(tail), fixture.request), /HEAD.*mismatch|changed|expected/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(headPath(root), "utf8")), replacement);
});

test("a HEAD replacement at the final revision authority check prevents the stale link", (t) => {
  const root = tempRoot(t);
  const authority = createTestRunStoreAuthority();
  let revisionChecks = 0;
  let replacement;
  const deps = {
    ...authority.deps,
    assertMutationAuthority(request, target) {
      authority.deps.assertMutationAuthority(request, target);
      if (target.operation === "revision" && ++revisionChecks === 2 && replacement) writeCanonical(headPath(root), replacement);
    },
  };
  const store = createRunRevisionStore(deps, { rootDir: root });
  const fixture = { root, authority, store, request: authority.mint() };
  const committed = publishRoot(fixture);
  const tail = makePlanFailedTail(fixture, committed.revision);
  replacement = { ...committed.head, updatedAt: "2026-08-16T12:34:57.000Z" };
  revisionChecks = 0;
  assert.throws(() => store.publishRevision(tail, fixture.request), /HEAD.*match|changed|expected/i);
  assert.equal(fs.existsSync(revisionPath(root, 1)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(headPath(root), "utf8")), replacement);
});

test("root, run-directory, and object enumeration accept exact count and reject plus one", { timeout: 120_000 }, async (t) => {
  await t.test("root 4096 / 4097", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    for (let index = 0; index < 4094; index += 1) fs.mkdirSync(path.join(fixture.root, `.reserved-${index}`));
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    fs.mkdirSync(path.join(fixture.root, ".reserved-overflow"));
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded");
  });
  await t.test("run 1024 / 1025", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const runDir = path.join(fixture.root, RUN_ID);
    for (let index = 0; index < 1022; index += 1) fs.writeFileSync(path.join(runDir, `.HEAD.json.${index}.tmp`), "staging");
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    fs.writeFileSync(path.join(runDir, ".HEAD.json.overflow.tmp"), "staging");
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded");
  });
  await t.test("objects 32768 / 32769", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const directory = path.join(fixture.root, "objects", "goal");
    for (let index = 0; index < 32767; index += 1) fs.writeFileSync(path.join(directory, `.object-${index}.tmp`), "");
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    fs.writeFileSync(path.join(directory, ".object-overflow.tmp"), "");
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded");
  });
  await t.test("root canonical bytes 512 MiB / plus one", () => {
    const fixture = fixtureStore(tempRoot(t));
    const committed = publishRoot(fixture);
    const fixedBytes = (fs.statSync(headPath(fixture.root)).size - 1)
      + (fs.statSync(revisionPath(fixture.root, 0)).size - 1)
      + (fs.statSync(objectPath(fixture.root, committed.goal)).size - 1);
    const directory = path.dirname(objectPath(fixture.root, committed.goal));
    const fill = path.join(directory, ".aggregate-fill.tmp");
    fs.closeSync(fs.openSync(fill, "w"));
    fs.truncateSync(fill, 512 * 1024 * 1024 - fixedBytes);
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    fs.writeFileSync(path.join(directory, ".aggregate-overflow.tmp"), "x");
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded");
  });
});

test("SIGKILL publication cuts classify staging, aliases, tails, and committed HEAD exactly", { timeout: 120_000 }, async (t) => {
  for (const [barrier, status] of [
    ["before-revision-link", "unchanged"],
    ["after-revision-link", "invalid-store"],
    ["after-staging-unlink", "recovery-required"],
    ["after-revision-directory-flush", "recovery-required"],
    ["before-head-rename", "recovery-required"],
    ["after-head-rename", "committed"],
    ["after-run-directory-flush", "committed"],
  ]) {
    await t.test(barrier, async () => {
      const fixture = fixtureStore(tempRoot(t));
      publishRoot(fixture);
      await killAtBarrier(fixture.root, barrier);
      const fresh = fixtureStore(fixture.root);
      if (status === "unchanged") assert.equal(fresh.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
      else if (status === "committed") assert.equal(fresh.store.readCommittedRun(RUN_ID, validators).head.revision, 1);
      else expectStoreStatus(() => fresh.store.readCommittedRun(RUN_ID, validators), status);
      if (status === "invalid-store") {
        const names = fs.readdirSync(path.join(fixture.root, RUN_ID, "revisions"));
        assert.ok(names.includes("1.json") && names.some((name) => name.startsWith(".1.json.")));
        assert.equal(fs.lstatSync(revisionPath(fixture.root, 1)).nlink, 2);
      }
    });
  }
});

test("revision zero without HEAD is the only recoverable first-head cut", { timeout: 30_000 }, async (t) => {
  const fixture = fixtureStore(tempRoot(t));
  await killAtBarrier(fixture.root, "before-head-rename", "initial");
  expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "recovery-required");
  const result = fixture.store.recoverLinkedTail(RUN_ID, fixture.request);
  assert.equal(result.status, "head-advanced");
  assert.equal(result.recoveredRevision, 0);
  assert.equal(result.chain.head.revision, 0);
  fs.unlinkSync(headPath(fixture.root));
  fs.renameSync(revisionPath(fixture.root, 0), revisionPath(fixture.root, 1));
  assert.equal(fixture.store.recoverLinkedTail(RUN_ID, fixture.request).status, "invalid-store");
});

test("attempt-started tail recovery advances once and remains interrupted in doubt without owner cleanup", (t) => {
  const fixture = fixtureStore(tempRoot(t));
  const root = publishRoot(fixture);
  const appSpec = fixture.store.publishSnapshot("app-spec", { kind: "pico.workflow-app-spec", schemaVersion: 1, spec: authoredSpec });
  const briefPayload = fixture.store.publishSnapshot("brief-payload", {
    kind: "pico.workflow-brief-payload", schemaVersion: 1, id: root.revision.target.briefId,
    brief: root.revision.target.briefInput, spec: authoredSpec,
  });
  const external = fixture.store.publishSnapshot("external-input", {
    kind: "pico.workflow-external-input", schemaVersion: 1, policy: "pico-fleet-external-input-v1",
    appSpecSha256: appSpec.sha256, briefPayloadSha256: briefPayload.sha256, resourceKey: root.revision.target.resourceKey,
    projectResourceKey: root.revision.target.projectResourceKey, physicalProjectDir: root.revision.target.projectDir,
    inputBaseDir: root.revision.target.inputBaseDir, iblSelector: null, uses: [], files: [], iblChoices: [],
    uniqueFileCount: 0, totalBytes: 0,
  });
  let tail = transitionRevision(
    { type: "attempt-started", attemptId: ATTEMPT_ID, phase: "build", iteration: null, generation: root.revision.projectGeneration.expected, inputs: external.sha256 },
    { status: "running", phase: "attempt-started", attemptId: ATTEMPT_ID },
  );
  tail = refreshRevisionId({ ...tail, runId: RUN_ID, revision: 1, parent: { revision: 0, revisionId: root.revision.revisionId }, intent: root.revision.intent, target: root.revision.target, attemptInputs: external });
  tail = refreshRevisionId({
    ...tail,
    intent: {
      ...tail.intent,
      goal: root.goal,
      initialSpec: appSpec,
      currentSpec: { snapshot: appSpec, origin: "caller-authored", amendsRevision: null },
      briefPayload,
    },
    target: root.revision.target,
  });
  fixture.store.publishRevision(tail, fixture.request);
  const locks = path.join(fixture.root, "locks");
  fs.mkdirSync(locks);
  const owners = ["run-owner", "application-owner", "project-owner"].map((name) => path.join(locks, name));
  for (const owner of owners) fs.mkdirSync(owner);
  const result = fixture.store.recoverLinkedTail(RUN_ID, fixture.request);
  assert.deepEqual(parseRunControlResult(result), result);
  assert.equal(result.status, "interrupted-in-doubt");
  assert.equal(result.runRevisionCommitted, true);
  assert.equal(result.runRevisionPublication, "head-authoritative");
  assert.equal(JSON.parse(fs.readFileSync(headPath(fixture.root), "utf8")).revision, 1);
  assert.ok(owners.every((owner) => fs.existsSync(owner)));
  const second = fixture.store.recoverLinkedTail(RUN_ID, fixture.request);
  assert.deepEqual(parseRunControlResult(second), second);
  assert.equal(second.status, "interrupted-in-doubt");
  assert.equal(second.runStateByThisCall, "unchanged");
});

test("recovery never moves HEAD backward or skips a corrupt or second tail", (t) => {
  const fixture = fixtureStore(tempRoot(t));
  const root = publishRoot(fixture);
  const tail = makePlanFailedTail(fixture, root.revision);
  fixture.store.publishRevision(tail, fixture.request);
  fixture.store.publishHead(root.head, headOf(tail), fixture.request);
  assert.equal(fixture.store.recoverLinkedTail(RUN_ID, fixture.request).status, "unchanged");
  fs.writeFileSync(revisionPath(fixture.root, 2), '{}\n');
  fs.writeFileSync(revisionPath(fixture.root, 3), '{}\n');
  assert.equal(fixture.store.recoverLinkedTail(RUN_ID, fixture.request).status, "invalid-store");
  assert.equal(JSON.parse(fs.readFileSync(headPath(fixture.root), "utf8")).revision, 1);
});
