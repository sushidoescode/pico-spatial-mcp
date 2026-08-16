import fs from "node:fs";
import path from "node:path";

import {
  acquireRunOwners,
  authorizeRunOwnerRelease,
  recoverDeadPrefix,
  releaseDefiniteOwners,
} from "../../dist/runlocks.js";
import {
  applicationResourceKey,
  projectResourceKey,
  resolveProjectLocator,
} from "../../dist/fleetinputidentity.js";
import { createRunRevisionStore } from "../../dist/runrevisionstore.js";
import { parseRunHead, parseRunRevision, parseSnapshotEnvelope } from "../../dist/runrevisiontypes.js";
import { baseRevision, goalEnvelope, refreshRevisionId } from "../helpers/runrevision-fixture.mjs";

const [command, rootDir, cut = "none"] = process.argv.slice(2);
const RUN_ID = "51000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "51000000-0000-4000-8000-000000000002";
const BRIEF_ID = "door238151";

function uuidAt(index) {
  return `51000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function barrier(name) {
  process.send?.({ kind: "barrier", name });
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}

function gatedBarrier(name) {
  const directory = path.join(rootDir, "capacity-aba-gates");
  const release = path.join(directory, `${name}.release`);
  fs.mkdirSync(directory, { recursive: true });
  process.send?.({ kind: "barrier", name });
  while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

function processIdentityFor(pid) {
  return `runlock-child:${pid}`;
}

const projectsRoot = `${rootDir}-projects`;
const capacityIndex = command === "capacity-acquire" || command === "capacity-aba-a" || command === "capacity-aba-c"
    || command === "capacity-cap-contender"
  ? Number.parseInt(cut, 10)
  : null;
const selectedRunId = capacityIndex === null ? RUN_ID : uuidAt(1_000 + capacityIndex);
const selectedAttemptId = capacityIndex === null ? ATTEMPT_ID : uuidAt(2_000 + capacityIndex);
const selectedBriefId = capacityIndex === null ? BRIEF_ID : `doorcapacity${capacityIndex}`;
const locator = resolveProjectLocator(projectsRoot, selectedBriefId);
const resourceKey = applicationResourceKey(`com.fleet.${selectedBriefId}`, "emulator-5554");
const projectKey = projectResourceKey(locator.physicalProjectDir);
const input = {
  runId: selectedRunId,
  mode: command === "cut-release" ? "coordination" : "execution",
  attemptId: command === "cut-release" ? null : selectedAttemptId,
  resourceKey,
  projectResourceKey: projectKey,
  projectLocator: locator,
  deadlineMonotonicMs: Number.POSITIVE_INFINITY,
};

const lockPaths = {
  run: path.join(rootDir, "locks", "run", `${selectedRunId}.lock`),
  application: path.join(rootDir, "locks", "application", `${resourceKey}.lock`),
  project: path.join(rootDir, "locks", "project", `${projectKey}.lock`),
};
const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
const originalFsyncSync = fs.fsyncSync;
const originalWriteSync = fs.writeSync;
const originalLinkSync = fs.linkSync;
const originalUnlinkSync = fs.unlinkSync;
const originalMkdirSync = fs.mkdirSync;
const originalRenameSync = fs.renameSync;
const descriptorPaths = new Map();
let pendingBarrier = null;
let capacityBarrierReached = false;
let abaReapBarrierReached = false;
let abaOwnerBarrierReached = false;
let recoveryElectionBarrierReached = false;
let recoveryOwnerBarrierReached = false;
fs.mkdirSync = (target, ...args) => {
  const targetPath = path.resolve(String(target));
  if (command === "capacity-acquire" && !capacityBarrierReached
      && targetPath.startsWith(`${lockPaths.run}.claim.`)) {
    capacityBarrierReached = true;
    const barrierDirectory = path.join(rootDir, "capacity-barrier");
    const ready = path.join(barrierDirectory, `${cut}.ready`);
    const release = path.join(barrierDirectory, `${cut}.release`);
    originalMkdirSync(barrierDirectory, { recursive: true });
    fs.writeFileSync(ready, "ready\n");
    process.send?.({ kind: "barrier", name: `capacity-preclaim-${cut}` });
    while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  if ((command === "capacity-aba-a" || command === "capacity-aba-c") && !abaOwnerBarrierReached
      && targetPath.startsWith(`${lockPaths.run}.claim.`)) {
    abaOwnerBarrierReached = true;
    gatedBarrier(command === "capacity-aba-a" ? "a-before-owner-publish" : "c-before-owner-publish");
  }
  if (command === "capacity-recover" && !recoveryElectionBarrierReached
      && targetPath.includes(".lock.recover.") && targetPath.includes(".claim.")) {
    recoveryElectionBarrierReached = true;
    gatedBarrier("recovery-before-election-publish");
  }
  return originalMkdirSync(target, ...args);
};
fs.openSync = (target, ...args) => {
  const targetPath = path.resolve(String(target));
  if (command === "capacity-acquire" && !capacityBarrierReached
      && targetPath === path.join(rootDir, "locks", "capacity-enrollment", "ACTIVE.json")) {
    capacityBarrierReached = true;
    const barrierDirectory = path.join(rootDir, "capacity-barrier");
    const ready = path.join(barrierDirectory, `${cut}.ready`);
    const release = path.join(barrierDirectory, `${cut}.release`);
    originalMkdirSync(barrierDirectory, { recursive: true });
    fs.writeFileSync(ready, "ready\n");
    process.send?.({ kind: "barrier", name: `capacity-preclaim-${cut}` });
    while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  if (command === "capacity-aba-c" && !capacityBarrierReached
      && (targetPath === path.join(rootDir, "locks", "capacity-enrollment", "ACTIVE.json")
        || targetPath === path.join(rootDir, "locks", "capacity-enrollment-staging", "STAGING.json"))) {
    capacityBarrierReached = true;
    gatedBarrier("c-before-enrollment-open");
  }
  const descriptor = originalOpenSync(target, ...args);
  descriptorPaths.set(descriptor, path.resolve(String(target)));
  if (command === "capacity-cut" && cut === "open"
      && (targetPath === path.join(rootDir, "locks", "capacity-enrollment", "ACTIVE.json")
        || targetPath === path.join(rootDir, "locks", "capacity-enrollment-staging", "STAGING.json"))) {
    barrier("capacity-enrollment-held");
  }
  return descriptor;
};
fs.writeSync = (descriptor, buffer, offset, length, ...args) => {
  if (command === "capacity-cut" && cut === "write"
      && (descriptorPaths.get(descriptor) === path.join(rootDir, "locks", "capacity-enrollment", "ACTIVE.json")
        || descriptorPaths.get(descriptor) === path.join(rootDir, "locks", "capacity-enrollment-staging", "STAGING.json"))) {
    const partialLength = Math.max(1, Math.floor(Number(length) / 2));
    const result = originalWriteSync(descriptor, buffer, offset, partialLength, ...args);
    barrier("capacity-enrollment-held");
    return result;
  }
  return originalWriteSync(descriptor, buffer, offset, length, ...args);
};
fs.linkSync = (source, target) => {
  const result = originalLinkSync(source, target);
  if (command === "capacity-cut" && cut === "link"
      && path.resolve(String(target)) === path.join(rootDir, "locks", "capacity-enrollment", "ACTIVE.json")) {
    barrier("capacity-enrollment-held");
  }
  return result;
};
fs.unlinkSync = (target) => {
  const targetPath = path.resolve(String(target));
  const result = originalUnlinkSync(target);
  if (command === "capacity-aba-a" && !abaReapBarrierReached
      && path.dirname(targetPath) === path.join(rootDir, "locks", "capacity-enrollment")
      && path.basename(targetPath).startsWith("ACTIVE.released.")) {
    abaReapBarrierReached = true;
    gatedBarrier("a-after-dead-reap");
  }
  if (command === "capacity-cut" && cut === "unlink"
      && targetPath === path.join(rootDir, "locks", "capacity-enrollment-staging", "STAGING.json")) {
    barrier("capacity-enrollment-held");
  }
  return result;
};
fs.closeSync = (descriptor) => {
  try { return originalCloseSync(descriptor); } finally { descriptorPaths.delete(descriptor); }
};
fs.renameSync = (source, target) => {
  const sourcePath = path.resolve(String(source));
  const targetPath = path.resolve(String(target));
  if (command === "capacity-aba-reaper" && !abaReapBarrierReached
      && sourcePath === path.join(rootDir, "locks", "capacity-enrollment", "ACTIVE.json")
      && targetPath.includes(`${path.sep}ACTIVE.released.`)) {
    abaReapBarrierReached = true;
    gatedBarrier("b-before-stale-rename");
    const result = originalRenameSync(source, target);
    gatedBarrier("b-after-stale-rename");
    return result;
  }
  if (command === "capacity-recover" && !recoveryOwnerBarrierReached
      && sourcePath.endsWith(".lock") && targetPath.startsWith(`${sourcePath}.released.`)) {
    recoveryOwnerBarrierReached = true;
    gatedBarrier("recovery-before-owner-quarantine");
  }
  const result = originalRenameSync(source, target);
  if (command === "cut-acquire" && targetPath === lockPaths[cut]) {
    pendingBarrier = { namespace: path.dirname(targetPath), name: `after-${cut}-owner` };
  }
  if (command === "cut-release" && sourcePath === lockPaths[cut] && targetPath.startsWith(`${lockPaths[cut]}.released.`)) {
    pendingBarrier = { namespace: path.dirname(sourcePath), name: `after-${cut}-release` };
  }
  return result;
};
fs.fsyncSync = (descriptor) => {
  const result = originalFsyncSync(descriptor);
  if (command === "capacity-cut" && (cut === "fsync" || cut === "none")
      && (descriptorPaths.get(descriptor) === path.join(rootDir, "locks", "capacity-enrollment", "ACTIVE.json")
        || descriptorPaths.get(descriptor) === path.join(rootDir, "locks", "capacity-enrollment-staging", "STAGING.json"))) {
    barrier("capacity-enrollment-held");
  }
  if (pendingBarrier !== null && descriptorPaths.get(descriptor) === pendingBarrier.namespace) {
    const selected = pendingBarrier;
    pendingBarrier = null;
    barrier(selected.name);
  }
  return result;
};

let acquireUuid = command === "capacity-cap-contender" ? 10_000 : 1;
let contenderObservedLiveEnrollment = false;
const acquireDeps = {
  rootDir,
  pid: process.pid,
  processIdentity: () => processIdentityFor(process.pid),
  isProcessIdentityLive: (pid, identity) => {
    if (identity !== processIdentityFor(pid)) return false;
    if (command === "capacity-cap-contender" && pid !== process.pid && !contenderObservedLiveEnrollment) {
      contenderObservedLiveEnrollment = true;
      gatedBarrier("contender-observed-live-enrollment");
    }
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  monotonicMs: () => performance.now(),
  nowUtc: () => "2026-08-16T12:34:56.000Z",
  uuid: () => {
    acquireUuid += 1;
    return uuidAt(acquireUuid);
  },
};

function chainFor(owners) {
  const authority = {
    assertMutationAuthority: () => undefined,
    assertRecoveryAuthority: () => undefined,
    nowUtc: () => "2026-08-16T12:34:56.000Z",
  };
  const store = createRunRevisionStore(authority, { rootDir });
  const goal = store.publishSnapshot("goal", goalEnvelope());
  const initial = baseRevision();
  const revision = refreshRevisionId({
    ...initial,
    runId: owners.run.record.runId,
    intent: { ...initial.intent, goal },
    target: {
      ...initial.target,
      inputBaseDir: locator.requestedProjectsRoot,
      briefPath: path.join(locator.requestedProjectsRoot, `${initial.target.briefId}.json`),
      projectDir: locator.requestedProjectDir,
      projectLocator: locator,
      resourceKey,
      projectResourceKey: projectKey,
    },
  });
  const request = { runId: revision.runId, expectedRevision: null, ownerToken: owners.run.token, mode: "coordination" };
  const head = {
    kind: "pico.workflow-run-head", schemaVersion: 1, runId: revision.runId,
    revision: 0, revisionId: revision.revisionId, updatedAt: "2026-08-16T12:34:56.000Z",
  };
  store.publishRevision(revision, request);
  store.publishHead(null, head, request);
  return store.readCommittedRun(revision.runId, {
    parseRevision: parseRunRevision, parseHead: parseRunHead, parseSnapshot: parseSnapshotEnvelope,
  });
}

try {
  if (command === "capacity-recover") {
    const recoveryInput = JSON.parse(fs.readFileSync(path.join(rootDir, "capacity-recovery-input.json"), "utf8"));
    const result = await recoverDeadPrefix({
      kind: "run-prefix",
      owners: recoveryInput.owners,
      chain: null,
      classification: "pre-target",
    }, acquireDeps);
    process.send?.({ kind: "capacity-result", status: result.status, detail: result.detail });
  } else if (command === "cut-acquire") {
    const owners = await acquireRunOwners(input, acquireDeps);
    process.send?.({
      kind: "owners",
      owners: {
        run: owners.run.record,
        application: owners.application.record,
        project: owners.project.record,
      },
    });
    throw new Error(`unknown acquisition cut '${cut}'`);
  } else {
    const owners = await acquireRunOwners(input, acquireDeps);
    process.send?.({
      kind: "owners",
      owners: {
        run: owners.run.record,
        application: owners.application.record,
        project: owners.project.record,
      },
    });
    if (command === "capacity-acquire" || command === "capacity-aba-a" || command === "capacity-aba-c"
        || command === "capacity-aba-reaper" || command === "capacity-cap-contender") {
      process.send?.({ kind: "capacity-result", status: "acquired" });
      process.exitCode = 0;
    } else {
    if (command === "hold") barrier("holding");
    if (command !== "cut-release") throw new Error(`unknown command '${command}'`);

    const authority = authorizeRunOwnerRelease(owners, chainFor(owners));
    let releaseUuid = 100;
    const releaseDeps = {
      ...acquireDeps,
      uuid: () => {
        releaseUuid += 1;
        return uuidAt(releaseUuid);
      },
    };
    await releaseDefiniteOwners(owners, authority, releaseDeps);
    throw new Error(`release cut '${cut}' did not stop after durable quarantine`);
    }
  }
} catch (error) {
  if (command === "capacity-acquire" || command === "capacity-aba-a" || command === "capacity-aba-c"
      || command === "capacity-aba-reaper" || command === "capacity-cap-contender"
      || command === "capacity-recover") {
    process.send?.({ kind: "capacity-result", status: error?.status ?? "error", detail: String(error?.message ?? error) });
  } else {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
