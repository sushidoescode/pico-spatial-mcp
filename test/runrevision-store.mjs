import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, fork } from "node:child_process";
import test from "node:test";

import { canonicalJson } from "../dist/runreceiptidentity.js";
import {
  createRunRevisionStore,
  runStoreRoot,
} from "../dist/runrevisionstore.js";
import { accumulateRunSnapshotBytes } from "../dist/runrevisionlimits.js";
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

function expectStoreStatus(fn, status, detailPattern = null) {
  let captured;
  assert.throws(fn, (error) => {
    captured = error;
    return error?.status === status && (detailPattern === null || detailPattern.test(error.message));
  }, `expected store status ${status}${detailPattern === null ? "" : ` matching ${detailPattern}`}`);
  return captured;
}

function uuidAt(index) {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function stagingName(basename, index, pid = 9000) {
  return `.${basename}.${pid}.${uuidAt(index)}.tmp`;
}

function writeStaging(directory, basename, index, bytes = "") {
  const target = path.join(directory, stagingName(basename, index));
  fs.writeFileSync(target, bytes);
  return target;
}

function createAttemptTail(fixture, committed, transitionType, disposition = "possible") {
  const appSpec = fixture.store.publishSnapshot("app-spec", { kind: "pico.workflow-app-spec", schemaVersion: 1, spec: authoredSpec });
  const briefPayload = fixture.store.publishSnapshot("brief-payload", {
    kind: "pico.workflow-brief-payload", schemaVersion: 1, id: committed.revision.target.briefId,
    brief: committed.revision.target.briefInput, spec: authoredSpec,
  });
  const external = fixture.store.publishSnapshot("external-input", {
    kind: "pico.workflow-external-input", schemaVersion: 1, policy: "pico-fleet-external-input-v1",
    appSpecSha256: appSpec.sha256, briefPayloadSha256: briefPayload.sha256,
    resourceKey: committed.revision.target.resourceKey, projectResourceKey: committed.revision.target.projectResourceKey,
    physicalProjectDir: committed.revision.target.projectDir, inputBaseDir: committed.revision.target.inputBaseDir,
    iblSelector: null, uses: [], files: [], iblChoices: [], uniqueFileCount: 0, totalBytes: 0,
  });
  const transition = transitionType === "attempt-started"
    ? { type: "attempt-started", attemptId: ATTEMPT_ID, phase: "build", iteration: null, generation: committed.revision.projectGeneration.expected, inputs: external.sha256 }
    : { type: "attempt-in-doubt", attemptId: ATTEMPT_ID, phase: "fleet-build", reason: diagnostic("in-doubt", "fixture in doubt"), externalMutationDisposition: disposition };
  let tail = transitionRevision(transition, { status: "running", phase: transitionType, attemptId: ATTEMPT_ID });
  tail = refreshRevisionId({
    ...tail,
    runId: RUN_ID,
    revision: 1,
    parent: { revision: 0, revisionId: committed.revision.revisionId },
    intent: {
      ...tail.intent,
      goal: committed.goal,
      initialSpec: appSpec,
      currentSpec: { snapshot: appSpec, origin: "caller-authored", amendsRevision: null },
      briefPayload,
    },
    target: committed.revision.target,
    attemptInputs: external,
  });
  return tail;
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
  const recovery = fixture.store.recoverLinkedTail(RUN_ID, cloned);
  assert.deepEqual(parseRunControlResult(recovery), recovery);
  assert.equal(recovery.status, "state-write-failed");
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

test("reader lstat-walks configured-root ancestors and compares complete leaf metadata", async (t) => {
  await t.test("symlinked configured-root ancestor is rejected", () => {
    const base = tempRoot(t);
    const physicalParent = path.join(base, "physical");
    const physicalRoot = path.join(physicalParent, "runs");
    fs.mkdirSync(physicalParent);
    const physical = fixtureStore(physicalRoot);
    publishRoot(physical);
    const aliasParent = path.join(base, "alias");
    fs.symlinkSync(physicalParent, aliasParent);
    const aliased = fixtureStore(path.join(aliasParent, "runs"));
    expectStoreStatus(() => aliased.store.readCommittedRun(RUN_ID, validators), "invalid-store", /component|symlink|no-follow/i);
  });

  await t.test("leaf metadata changed between lstat and descriptor inspection is rejected", (subtest) => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const directory = path.join(fixture.root, "objects", "goal");
    const staging = writeStaging(directory, `${"d".repeat(64)}.json`, 40000);
    const originalOpen = fs.openSync;
    let changed = false;
    fs.openSync = (...args) => {
      const descriptor = originalOpen(...args);
      if (!changed && args[0] === staging) {
        changed = true;
        fs.appendFileSync(staging, "x");
      }
      return descriptor;
    };
    subtest.after(() => { fs.openSync = originalOpen; });
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /changed/i);
  });

  await t.test("access-time metadata differs between path and descriptor inspection", (subtest) => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const directory = path.join(fixture.root, "objects", "goal");
    const staging = writeStaging(directory, `${"d".repeat(64)}.json`, 40004);
    const originalOpen = fs.openSync;
    const originalFstat = fs.fstatSync;
    const descriptors = new Set();
    fs.openSync = (...args) => {
      const descriptor = originalOpen(...args);
      if (args[0] === staging) descriptors.add(descriptor);
      return descriptor;
    };
    fs.fstatSync = (descriptor, ...args) => {
      const stat = originalFstat(descriptor, ...args);
      if (!descriptors.has(descriptor)) return stat;
      return {
        ...stat,
        atimeNs: stat.atimeNs + 1n,
        isFile: () => stat.isFile(),
        isDirectory: () => stat.isDirectory(),
        isSymbolicLink: () => stat.isSymbolicLink(),
      };
    };
    subtest.after(() => { fs.openSync = originalOpen; fs.fstatSync = originalFstat; });
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /changed/i);
  });

  await t.test("relevant objects namespace changes after enumeration are detected", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const directory = path.join(fixture.root, "objects", "goal");
    const transient = path.join(directory, stagingName(`${"e".repeat(64)}.json`, 40001));
    let mutated = false;
    const mutatingValidators = {
      ...validators,
      parseSnapshot(kind, value) {
        if (!mutated) {
          mutated = true;
          fs.writeFileSync(transient, "");
          fs.unlinkSync(transient);
        }
        return parseSnapshotEnvelope(kind, value);
      },
    };
    assert.throws(
      () => fixture.store.readCommittedRun(RUN_ID, mutatingValidators),
      (error) => error?.status === "run-busy" || error?.status === "invalid-store",
    );
  });

  await t.test("a selected revision changed after its read is detected", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    let mutated = false;
    const mutatingValidators = {
      ...validators,
      parseSnapshot(kind, value) {
        if (!mutated) {
          mutated = true;
          fs.appendFileSync(revisionPath(fixture.root, 0), " ");
        }
        return parseSnapshotEnvelope(kind, value);
      },
    };
    assert.throws(
      () => fixture.store.readCommittedRun(RUN_ID, mutatingValidators),
      (error) => error?.status === "run-busy" || error?.status === "invalid-store",
    );
  });

  await t.test("multiply-linked staging aliases are preserved and rejected", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const directory = path.join(fixture.root, "objects", "goal");
    const first = writeStaging(directory, `${"d".repeat(64)}.json`, 40002);
    const second = path.join(directory, stagingName(`${"d".repeat(64)}.json`, 40003));
    fs.linkSync(first, second);
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /one-link|regular|alias/i);
    assert.equal(fs.existsSync(first), true);
    assert.equal(fs.existsSync(second), true);
    assert.equal(fs.lstatSync(first).nlink, 2);
  });
});

test("every global CAS target is validated even when unreferenced", async (t) => {
  await t.test("digest-named invalid envelope", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const canonical = canonicalJson({});
    fs.writeFileSync(path.join(fixture.root, "objects", "goal", `${sha(canonical)}.json`), `${canonical}\n`);
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /snapshot|goal|envelope|invalid/i);
  });

  await t.test("filename digest mismatch", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const canonical = canonicalJson({ kind: "pico.workflow-goal", schemaVersion: 1, goal: "Unreferenced" });
    fs.writeFileSync(path.join(fixture.root, "objects", "goal", `${"f".repeat(64)}.json`), `${canonical}\n`);
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /digest/i);
  });

  await t.test("namespace and envelope kind mismatch", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const canonical = canonicalJson({ kind: "pico.workflow-goal", schemaVersion: 1, goal: "Misfiled" });
    const directory = path.join(fixture.root, "objects", "result");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, `${sha(canonical)}.json`), `${canonical}\n`);
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /public-result|result|snapshot|invalid/i);
  });

  await t.test("only the exact publisher staging grammar is recognized", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const directory = path.join(fixture.root, "objects", "goal");
    fs.writeFileSync(path.join(directory, ".anything.tmp"), "");
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /unknown CAS|staging/i);
  });

  for (const rootEntryKind of ["regular", "fifo"]) {
    await t.test(`arbitrary root dot ${rootEntryKind} is invalid`, () => {
      const fixture = fixtureStore(tempRoot(t));
      publishRoot(fixture);
      const target = path.join(fixture.root, `.arbitrary-${rootEntryKind}`);
      if (rootEntryKind === "regular") fs.writeFileSync(target, "");
      else execFileSync("mkfifo", [target]);
      expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /root entry|unknown|unsafe/i);
    });
  }

  const namespaceBounds = {
    goal: ["goal", 4 * 1024 * 1024],
    acceptance: ["acceptance", 256 * 1024],
    "app-spec": ["spec", 2 * 1024 * 1024],
    "brief-payload": ["brief", 3 * 1024 * 1024],
    "external-input": ["external", 2 * 1024 * 1024],
    "compiler-ledger": ["compiler", 8 * 1024 * 1024],
    "public-result": ["result", 4 * 1024 * 1024],
  };
  for (const [kind, [namespace, maximum]] of Object.entries(namespaceBounds)) {
    await t.test(`${kind} exact stored bound is content-validated`, () => {
      const fixture = fixtureStore(tempRoot(t));
      publishRoot(fixture);
      const directory = path.join(fixture.root, "objects", namespace);
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, `${"e".repeat(64)}.json`);
      fs.closeSync(fs.openSync(target, "w"));
      fs.truncateSync(target, maximum + 1);
      expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store");
    });
    await t.test(`${kind} plus one is rejected by stat before content allocation`, () => {
      const fixture = fixtureStore(tempRoot(t));
      publishRoot(fixture);
      const directory = path.join(fixture.root, "objects", namespace);
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, `${"e".repeat(64)}.json`);
      fs.closeSync(fs.openSync(target, "w"));
      fs.truncateSync(target, maximum + 2);
      expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /byte bound|exceeds/i);
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

test("the final HEAD authority boundary revalidates the complete next chain before rename", (t) => {
  const root = tempRoot(t);
  const authority = createTestRunStoreAuthority();
  let headChecks = 0;
  let removeTailObject = null;
  const deps = {
    ...authority.deps,
    assertMutationAuthority(request, target) {
      authority.deps.assertMutationAuthority(request, target);
      if (target.operation === "head" && ++headChecks === 2 && removeTailObject !== null) {
        fs.unlinkSync(removeTailObject);
      }
    },
  };
  const store = createRunRevisionStore(deps, { rootDir: root });
  const fixture = { root, authority, store, request: authority.mint() };
  const committed = publishRoot(fixture);
  const tail = makePlanFailedTail(fixture, committed.revision);
  store.publishRevision(tail, fixture.request);
  removeTailObject = objectPath(root, tail.publicResult);
  headChecks = 0;
  assert.throws(() => store.publishHead(committed.head, headOf(tail), fixture.request), /snapshot|CAS|chain|unavailable|missing|authority directory|changed/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(headPath(root), "utf8")), committed.head);
});

test("recovery reports publication stages conservatively and every control result parses", async (t) => {
  await t.test("rename visible but run-directory fsync failed is publication-in-doubt", (subtest) => {
    const fixture = fixtureStore(tempRoot(t));
    const committed = publishRoot(fixture);
    const tail = makePlanFailedTail(fixture, committed.revision);
    fixture.store.publishRevision(tail, fixture.request);
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    let headRenamed = false;
    fs.renameSync = (...args) => {
      const result = originalRename(...args);
      if (args[1] === headPath(fixture.root)) headRenamed = true;
      return result;
    };
    fs.fsyncSync = (descriptor) => {
      if (headRenamed) throw new Error("injected run-directory fsync failure");
      return originalFsync(descriptor);
    };
    subtest.after(() => { fs.renameSync = originalRename; fs.fsyncSync = originalFsync; });
    const result = fixture.store.recoverLinkedTail(RUN_ID, fixture.request);
    assert.deepEqual(parseRunControlResult(result), result);
    assert.equal(result.status, "state-write-failed");
    assert.equal(result.runStateByThisCall, "publication-in-doubt");
    assert.equal(result.runRevisionCommitted, null);
    assert.equal(result.runRevisionPublication, "unknown");
    assert.equal(result.revision, tail.revision);
    assert.equal(result.revisionId, tail.revisionId);
  });

  await t.test("completed writeHead remains durable when its later chain confirmation fails", (subtest) => {
    const fixture = fixtureStore(tempRoot(t));
    const committed = publishRoot(fixture);
    const tail = makePlanFailedTail(fixture, committed.revision);
    fixture.store.publishRevision(tail, fixture.request);
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    const originalOpendir = fs.opendirSync;
    let headRenamed = false;
    let headDirectoryFlushed = false;
    fs.renameSync = (...args) => {
      const result = originalRename(...args);
      if (args[1] === headPath(fixture.root)) headRenamed = true;
      return result;
    };
    fs.fsyncSync = (descriptor) => {
      const result = originalFsync(descriptor);
      if (headRenamed) headDirectoryFlushed = true;
      return result;
    };
    fs.opendirSync = (...args) => {
      if (headDirectoryFlushed) throw new Error("injected post-write chain confirmation failure");
      return originalOpendir(...args);
    };
    subtest.after(() => {
      fs.renameSync = originalRename;
      fs.fsyncSync = originalFsync;
      fs.opendirSync = originalOpendir;
    });
    const result = fixture.store.recoverLinkedTail(RUN_ID, fixture.request);
    assert.deepEqual(parseRunControlResult(result), result);
    assert.equal(result.status, "state-write-failed");
    assert.equal(result.runStateByThisCall, "durably-advanced");
    assert.equal(result.runRevisionCommitted, true);
    assert.equal(result.runRevisionPublication, "head-authoritative");
    assert.equal(result.revision, tail.revision);
    assert.equal(result.revisionId, tail.revisionId);
  });
});

test("conflicting duplicate snapshot refs are rejected independent of traversal order", async (t) => {
  for (const wrongRevision of [0, 1]) {
    await t.test(`revision ${wrongRevision} declares conflicting bytes`, () => {
      const fixture = fixtureStore(tempRoot(t));
      const committed = publishRoot(fixture);
      const tail = makePlanFailedTail(fixture, committed.revision);
      fixture.store.publishRevision(tail, fixture.request);
      fixture.store.publishHead(committed.head, headOf(tail), fixture.request);
      let first = structuredClone(committed.revision);
      first.intent.goal = { ...first.intent.goal, bytes: first.intent.goal.bytes + (wrongRevision === 0 ? 1 : 0) };
      first = refreshRevisionId(first);
      let second = structuredClone(tail);
      second.parent = { revision: 0, revisionId: first.revisionId };
      second.intent.goal = { ...second.intent.goal, bytes: second.intent.goal.bytes + (wrongRevision === 1 ? 1 : 0) };
      second = refreshRevisionId(second);
      writeCanonical(revisionPath(fixture.root, 0), first);
      writeCanonical(revisionPath(fixture.root, 1), second);
      writeCanonical(headPath(fixture.root), headOf(second));
      expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "invalid-store", /conflict|byte count/i);
    });
  }

  await t.test("identical duplicate refs dedupe to one unique run snapshot", () => {
    const fixture = fixtureStore(tempRoot(t));
    const committed = publishRoot(fixture);
    const tail = makePlanFailedTail(fixture, committed.revision);
    fixture.store.publishRevision(tail, fixture.request);
    fixture.store.publishHead(committed.head, headOf(tail), fixture.request);
    const chain = fixture.store.readCommittedRun(RUN_ID, validators);
    assert.equal(chain.snapshots.has(`goal:${committed.goal.sha256}`), true);
    assert.equal([...chain.snapshots].filter(([key]) => key === `goal:${committed.goal.sha256}`).length, 1);
  });
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

test("a revisions-directory replacement at the final authority check prevents publication", (t) => {
  const root = tempRoot(t);
  const authority = createTestRunStoreAuthority();
  let revisionChecks = 0;
  let replaceDirectory = false;
  let savedDirectory = null;
  const deps = {
    ...authority.deps,
    assertMutationAuthority(request, target) {
      authority.deps.assertMutationAuthority(request, target);
      if (target.operation === "revision" && ++revisionChecks === 2 && replaceDirectory) {
        const revisions = path.dirname(revisionPath(root, 0));
        savedDirectory = `${revisions}.saved`;
        fs.renameSync(revisions, savedDirectory);
        fs.mkdirSync(revisions);
      }
    },
  };
  const store = createRunRevisionStore(deps, { rootDir: root });
  const fixture = { root, authority, store, request: authority.mint() };
  const committed = publishRoot(fixture);
  const tail = makePlanFailedTail(fixture, committed.revision);
  revisionChecks = 0;
  replaceDirectory = true;
  assert.throws(() => store.publishRevision(tail, fixture.request), /directory|replaced|changed|chain/i);
  assert.equal(fs.existsSync(revisionPath(root, 1)), false);
  assert.equal(fs.existsSync(path.join(savedDirectory, "0.json")), true);
});

test("directory-entry capacity is reserved before every store mutation", { timeout: 120_000 }, async (t) => {
  await t.test("root objects creation is preflighted", () => {
    const fixture = fixtureStore(tempRoot(t));
    fs.mkdirSync(fixture.root, { recursive: true });
    for (let index = 0; index < 4096; index += 1) fs.mkdirSync(path.join(fixture.root, uuidAt(index)));
    expectStoreStatus(() => fixture.store.publishSnapshot("goal", goalEnvelope()), "limit-exceeded");
    assert.equal(fs.existsSync(path.join(fixture.root, "objects")), false);
  });

  await t.test("run and revisions creation are independently preflighted", () => {
    const fixture = fixtureStore(tempRoot(t));
    const goal = fixture.store.publishSnapshot("goal", goalEnvelope());
    for (let index = 0; index < 4095; index += 1) fs.mkdirSync(path.join(fixture.root, uuidAt(index)));
    const revision = refreshRevisionId(baseRevision({ intent: { ...baseRevision().intent, goal } }));
    expectStoreStatus(() => fixture.store.publishRevision(revision, fixture.request), "limit-exceeded");
    assert.equal(fs.existsSync(path.join(fixture.root, RUN_ID)), false);
  });

  await t.test("revisions directory creation is preflighted", () => {
    const fixture = fixtureStore(tempRoot(t));
    const goal = fixture.store.publishSnapshot("goal", goalEnvelope());
    const runDirectory = path.join(fixture.root, RUN_ID);
    fs.mkdirSync(runDirectory);
    for (let index = 0; index < 1024; index += 1) writeStaging(runDirectory, "HEAD.json", index);
    const revision = refreshRevisionId(baseRevision({ intent: { ...baseRevision().intent, goal } }));
    expectStoreStatus(() => fixture.store.publishRevision(revision, fixture.request), "limit-exceeded");
    assert.equal(fs.existsSync(path.join(runDirectory, "revisions")), false);
  });

  await t.test("revision staging plus link peak fails unchanged at the exact limit", () => {
    const fixture = fixtureStore(tempRoot(t));
    const committed = publishRoot(fixture);
    const tail = makePlanFailedTail(fixture, committed.revision);
    const revisions = path.dirname(revisionPath(fixture.root, 0));
    for (let index = 0; index < 1022; index += 1) writeStaging(revisions, "1.json", index);
    expectStoreStatus(() => fixture.store.publishRevision(tail, fixture.request), "limit-exceeded");
    assert.equal(fs.existsSync(revisionPath(fixture.root, 1)), false);
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
  });

  await t.test("revision staging plus link peak succeeds one entry below the limit", () => {
    const fixture = fixtureStore(tempRoot(t));
    const committed = publishRoot(fixture);
    const tail = makePlanFailedTail(fixture, committed.revision);
    const revisions = path.dirname(revisionPath(fixture.root, 0));
    for (let index = 0; index < 1021; index += 1) writeStaging(revisions, "1.json", index);
    fixture.store.publishRevision(tail, fixture.request);
    assert.equal(fs.existsSync(revisionPath(fixture.root, 1)), true);
  });

  await t.test("first HEAD staging is preflighted at the direct-entry limit", () => {
    const fixture = fixtureStore(tempRoot(t));
    const goal = fixture.store.publishSnapshot("goal", goalEnvelope());
    const revision = refreshRevisionId(baseRevision({ intent: { ...baseRevision().intent, goal } }));
    fixture.store.publishRevision(revision, fixture.request);
    const runDirectory = path.join(fixture.root, RUN_ID);
    for (let index = 0; index < 1023; index += 1) writeStaging(runDirectory, "HEAD.json", index);
    expectStoreStatus(() => fixture.store.publishHead(null, headOf(revision), fixture.request), "limit-exceeded");
    assert.equal(fs.existsSync(headPath(fixture.root)), false);
  });

  await t.test("replacement HEAD staging is preflighted without changing HEAD", () => {
    const fixture = fixtureStore(tempRoot(t));
    const committed = publishRoot(fixture);
    const tail = makePlanFailedTail(fixture, committed.revision);
    fixture.store.publishRevision(tail, fixture.request);
    const runDirectory = path.join(fixture.root, RUN_ID);
    for (let index = 0; index < 1022; index += 1) writeStaging(runDirectory, "HEAD.json", index);
    expectStoreStatus(() => fixture.store.publishHead(committed.head, headOf(tail), fixture.request), "limit-exceeded");
    assert.deepEqual(JSON.parse(fs.readFileSync(headPath(fixture.root), "utf8")), committed.head);
  });
});

test("root, run-directory, and object enumeration accept exact count and reject plus one", { timeout: 120_000 }, async (t) => {
  await t.test("root 4096 / 4097", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    for (let index = 0; index < 4094; index += 1) fs.mkdirSync(path.join(fixture.root, uuidAt(index)));
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    fs.mkdirSync(path.join(fixture.root, uuidAt(4094)));
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded");
  });
  await t.test("run 1024 / 1025", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const runDir = path.join(fixture.root, RUN_ID);
    for (let index = 0; index < 1022; index += 1) writeStaging(runDir, "HEAD.json", index, "staging");
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    writeStaging(runDir, "HEAD.json", 1022, "staging");
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded");
  });
  await t.test("objects 32768 / 32769", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const directory = path.join(fixture.root, "objects", "goal");
    for (let index = 0; index < 32767; index += 1) writeStaging(directory, `${"d".repeat(64)}.json`, index);
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    const secondGoal = { kind: "pico.workflow-goal", schemaVersion: 1, goal: "Another fixture goal" };
    const secondCanonical = canonicalJson(secondGoal);
    const secondTarget = path.join(directory, `${sha(secondCanonical)}.json`);
    expectStoreStatus(() => fixture.store.publishSnapshot("goal", secondGoal), "limit-exceeded");
    assert.equal(fs.existsSync(secondTarget), false);
    fs.unlinkSync(path.join(directory, stagingName(`${"d".repeat(64)}.json`, 32766)));
    const admitted = fixture.store.publishSnapshot("goal", secondGoal);
    assert.equal(admitted.sha256, sha(secondCanonical));
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    writeStaging(directory, `${"d".repeat(64)}.json`, 32767);
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded");
  });
  await t.test("root canonical bytes 512 MiB / plus one", () => {
    const fixture = fixtureStore(tempRoot(t));
    const committed = publishRoot(fixture);
    const fixedBytes = (fs.statSync(headPath(fixture.root)).size - 1)
      + (fs.statSync(revisionPath(fixture.root, 0)).size - 1)
      + (fs.statSync(objectPath(fixture.root, committed.goal)).size - 1);
    const directory = path.dirname(objectPath(fixture.root, committed.goal));
    const fill = path.join(directory, stagingName(`${"d".repeat(64)}.json`, 0));
    fs.closeSync(fs.openSync(fill, "w"));
    fs.truncateSync(fill, 512 * 1024 * 1024 - fixedBytes);
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    writeStaging(directory, `${"d".repeat(64)}.json`, 1, "x");
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded");
  });
});

test("aggregate nested and revision enumeration accept exact bounds and reject plus one", { timeout: 180_000 }, async (t) => {
  await t.test("aggregate nested run entries 65536 / 65537", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    let nextStaging = 50000;
    for (let runIndex = 0; runIndex < 64; runIndex += 1) {
      const runDirectory = path.join(fixture.root, uuidAt(50000 + runIndex));
      const revisions = path.join(runDirectory, "revisions");
      fs.mkdirSync(revisions, { recursive: true });
      const count = runIndex < 63 ? 1024 : 957;
      for (let index = 0; index < count; index += 1) {
        writeStaging(revisions, "0.json", nextStaging++);
      }
    }
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    const finalRevisions = path.join(fixture.root, uuidAt(50063), "revisions");
    writeStaging(finalRevisions, "0.json", nextStaging);
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded", /nested/i);
  });

  await t.test("aggregate revision envelopes 16384 / 16385", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    for (let runIndex = 0; runIndex < 64; runIndex += 1) {
      const revisions = path.join(fixture.root, uuidAt(51000 + runIndex), "revisions");
      fs.mkdirSync(revisions, { recursive: true });
      const count = runIndex < 63 ? 256 : 255;
      for (let index = 0; index < count; index += 1) fs.writeFileSync(path.join(revisions, `${index}.json`), "x");
    }
    assert.equal(fixture.store.readCommittedRun(RUN_ID, validators).head.revision, 0);
    fs.writeFileSync(path.join(fixture.root, uuidAt(51063), "revisions", "255.json"), "x");
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, validators), "limit-exceeded", /revision-envelope/i);
  });
});

test("per-run unique declared snapshot bytes are charged as a complete set before reads", async (t) => {
  const rewriteSyntheticRevision = (fixture, refs) => {
    const revision = { runId: RUN_ID, revision: 0, revisionId: "a".repeat(64), parent: null, refs };
    writeCanonical(revisionPath(fixture.root, 0), revision);
    writeCanonical(headPath(fixture.root), headOf(revision));
    return {
      ...validators,
      parseRevision(value) { return value; },
    };
  };

  await t.test("exact 512 MiB reaches missing-content validation", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const refs = Array.from({ length: 64 }, (_, index) => snapshotRef("compiler-ledger", sha(`declared-${index}`), 8 * 1024 * 1024));
    const syntheticValidators = rewriteSyntheticRevision(fixture, refs);
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, syntheticValidators), "invalid-store", /unavailable|missing|required leaf/i);
  });

  await t.test("plus one byte fails aggregate admission before any missing CAS read", () => {
    const fixture = fixtureStore(tempRoot(t));
    publishRoot(fixture);
    const refs = Array.from({ length: 64 }, (_, index) => snapshotRef("compiler-ledger", sha(`declared-${index}`), 8 * 1024 * 1024));
    refs.push(snapshotRef("compiler-ledger", sha("declared-plus-one"), 1));
    const syntheticValidators = rewriteSyntheticRevision(fixture, refs);
    expectStoreStatus(() => fixture.store.readCommittedRun(RUN_ID, syntheticValidators), "limit-exceeded", /declared snapshot-byte/i);
  });
});

test("fixed pure accumulator covers exact and plus-one unique run snapshot totals", async (t) => {
  const exact = Array.from({ length: 64 }, () => 8 * 1024 * 1024);
  const project = (sizes) => {
    let total = 0;
    for (const bytes of sizes) {
      const next = accumulateRunSnapshotBytes(total, bytes);
      if (next === null) return null;
      total = next;
    }
    return total;
  };
  await t.test("declared exact 512 MiB", () => {
    assert.equal(project(exact), 512 * 1024 * 1024);
  });
  await t.test("declared plus one", () => {
    assert.equal(project([...exact, 1]), null);
  });
  await t.test("actual exact 512 MiB", () => {
    assert.equal(project(exact), 512 * 1024 * 1024);
  });
  await t.test("actual plus one", () => {
    assert.equal(project([...exact, 1]), null);
  });
  await t.test("prospective admission starts from the prior chain total", () => {
    assert.equal(accumulateRunSnapshotBytes(512 * 1024 * 1024, 1), null);
  });
  await t.test("store surface remains the approved five methods", () => {
    const fixture = fixtureStore(tempRoot(t));
    assert.deepEqual(
      Reflect.ownKeys(fixture.store).map(String).sort(),
      ["publishSnapshot", "publishRevision", "publishHead", "readCommittedRun", "recoverLinkedTail"].sort(),
    );
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
  const invalid = fixture.store.recoverLinkedTail(RUN_ID, fixture.request);
  assert.deepEqual(parseRunControlResult(invalid), invalid);
  assert.equal(invalid.status, "invalid-store");
});

test("authoritative interrupted attempts preserve exact stored external-mutation certainty", async (t) => {
  for (const [transitionType, disposition] of [["attempt-started", "possible"], ["attempt-in-doubt", "confirmed"]]) {
    await t.test(`${transitionType} reports ${disposition}`, () => {
      const fixture = fixtureStore(tempRoot(t));
      const committed = publishRoot(fixture);
      const tail = createAttemptTail(fixture, committed, transitionType, disposition);
      fixture.store.publishRevision(tail, fixture.request);
      fixture.store.publishHead(committed.head, headOf(tail), fixture.request);
      const result = fixture.store.recoverLinkedTail(RUN_ID, fixture.request);
      assert.deepEqual(parseRunControlResult(result), result);
      assert.equal(result.status, "interrupted-in-doubt");
      assert.equal(result.runStateByThisCall, "unchanged");
      assert.equal(result.priorAttemptExternalSideEffects, disposition);
      assert.equal(result.activeAttemptExternalSideEffects, null);
      assert.equal(result.inDoubtAttemptCompletion, null);
      assert.equal(result.externalSideEffectsByThisCall, "none");
      assert.equal(result.revision, tail.revision);
      assert.equal(result.revisionId, tail.revisionId);
    });
  }
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
  const invalid = fixture.store.recoverLinkedTail(RUN_ID, fixture.request);
  assert.deepEqual(parseRunControlResult(invalid), invalid);
  assert.equal(invalid.status, "invalid-store");
  assert.equal(JSON.parse(fs.readFileSync(headPath(fixture.root), "utf8")).revision, 1);
});
