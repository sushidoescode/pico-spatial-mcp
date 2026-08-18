import fs from "node:fs";
import path from "node:path";

import { createRunRevisionStore } from "../../dist/runrevisionstore.js";
import {
  baseRevision,
  createTestRunStoreAuthority,
  goalEnvelope,
  refreshRevisionId,
} from "../helpers/runrevision-fixture.mjs";

const [root, operation, value, gate, mode] = process.argv.slice(2);
const authority = createTestRunStoreAuthority();
let paused = false;
const pause = () => {
  if (mode !== "pause" || paused) return;
  paused = true;
  process.send?.({ type: "barrier" });
  while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  fs.unlinkSync(gate);
};

const realOpen = fs.openSync.bind(fs);
fs.openSync = (target, ...args) => {
  const text = String(target);
  const flags = args[0];
  if (operation === "snapshot" && path.dirname(text) === path.join(root, "objects", "goal")
    && typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0 && (flags & fs.constants.O_EXCL) !== 0
    && path.basename(text).startsWith(".") && path.basename(text).endsWith(".tmp")) pause();
  return realOpen(target, ...args);
};

const realMkdir = fs.mkdirSync.bind(fs);
fs.mkdirSync = (target, ...args) => {
  if (operation === "revision" && path.resolve(String(target)) === path.join(root, value)) pause();
  return realMkdir(target, ...args);
};

const store = createRunRevisionStore(authority.deps, { rootDir: root });
try {
  if (operation === "snapshot") {
    const ref = store.publishSnapshot("goal", {
      kind: "pico.workflow-goal",
      schemaVersion: 1,
      goal: value,
    });
    process.send?.({ type: "result", result: { ok: true, sha256: ref.sha256 } });
  } else if (operation === "revision") {
    const goal = store.publishSnapshot("goal", goalEnvelope());
    const revision = refreshRevisionId(baseRevision({
      runId: value,
      intent: { ...baseRevision().intent, goal },
    }));
    store.publishRevision(revision, authority.mint(value));
    process.send?.({ type: "result", result: { ok: true, revisionId: revision.revisionId } });
  } else {
    throw new Error(`unknown concurrency operation '${operation}'`);
  }
} catch (error) {
  process.send?.({
    type: "result",
    result: { ok: false, status: error?.status ?? null, message: error instanceof Error ? error.message : String(error) },
  });
}
