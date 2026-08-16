import fs from "node:fs";
import path from "node:path";

import { createRunRevisionStore } from "../../dist/runrevisionstore.js";
import {
  baseRevision,
  createTestRunStoreAuthority,
  diagnostic,
  goalEnvelope,
  refreshRevisionId,
  transitionRevision,
} from "../helpers/runrevision-fixture.mjs";

const [root, barrier, scenario] = process.argv.slice(2);
const authority = createTestRunStoreAuthority();
const store = createRunRevisionStore(authority.deps, { rootDir: root });
const request = authority.mint();
let headRenamed = false;
const stop = () => {
  if (process.send) process.send(`barrier:${barrier}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const descriptors = new Map();
const realOpen = fs.openSync.bind(fs);
fs.openSync = (target, ...args) => {
  const descriptor = realOpen(target, ...args);
  descriptors.set(descriptor, String(target));
  return descriptor;
};
const realClose = fs.closeSync.bind(fs);
fs.closeSync = (descriptor) => {
  descriptors.delete(descriptor);
  return realClose(descriptor);
};

const realLink = fs.linkSync.bind(fs);
fs.linkSync = (source, target) => {
  if (target.endsWith(path.join("revisions", scenario === "initial" ? "0.json" : "1.json")) && barrier === "before-revision-link") stop();
  const result = realLink(source, target);
  if (target.endsWith(path.join("revisions", scenario === "initial" ? "0.json" : "1.json")) && barrier === "after-revision-link") stop();
  return result;
};
const realUnlink = fs.unlinkSync.bind(fs);
fs.unlinkSync = (target) => {
  const result = realUnlink(target);
  if (target.includes(path.join("revisions", ".")) && barrier === "after-staging-unlink") stop();
  return result;
};
const realFsync = fs.fsyncSync.bind(fs);
fs.fsyncSync = (descriptor) => {
  const result = realFsync(descriptor);
  const target = descriptors.get(descriptor);
  if (target?.endsWith(path.join(baseRevision().runId, "revisions")) && barrier === "after-revision-directory-flush") stop();
  if (headRenamed && target?.endsWith(baseRevision().runId) && barrier === "after-run-directory-flush") stop();
  return result;
};
const realRename = fs.renameSync.bind(fs);
fs.renameSync = (source, target) => {
  if (target.endsWith("HEAD.json") && barrier === "before-head-rename") stop();
  const result = realRename(source, target);
  if (target.endsWith("HEAD.json")) headRenamed = true;
  if (target.endsWith("HEAD.json") && barrier === "after-head-rename") stop();
  return result;
};

const goal = store.publishSnapshot("goal", goalEnvelope());
let revision;
let expected;
if (scenario === "initial") {
  revision = refreshRevisionId(baseRevision({ intent: { ...baseRevision().intent, goal } }));
  expected = null;
} else {
  const head = JSON.parse(fs.readFileSync(path.join(root, baseRevision().runId, "HEAD.json"), "utf8"));
  const prior = JSON.parse(fs.readFileSync(path.join(root, baseRevision().runId, "revisions", "0.json"), "utf8"));
  const result = store.publishSnapshot("public-result", {
    kind: "pico.workflow-public-result", schemaVersion: 1, workflow: "pico-build-app", status: "plan-failed",
    publicResult: { status: "plan-failed", detail: {}, fix: "fixture fix" },
  });
  revision = transitionRevision(
    { type: "plan-completed", outcome: "plan-failed", diagnostic: diagnostic("plan", "fixture failure") },
    { status: "paused", publicStatus: "plan-failed" },
  );
  revision = refreshRevisionId({
    ...revision, runId: prior.runId, revision: 1, parent: { revision: 0, revisionId: prior.revisionId },
    intent: prior.intent, target: prior.target, projectGeneration: prior.projectGeneration, publicResult: result,
  });
  expected = head;
}
store.publishRevision(revision, request);
store.publishHead(expected, {
  kind: "pico.workflow-run-head", schemaVersion: 1, runId: revision.runId,
  revision: revision.revision, revisionId: revision.revisionId, updatedAt: "2026-08-16T12:34:56.000Z",
}, request);
process.exit(2);
