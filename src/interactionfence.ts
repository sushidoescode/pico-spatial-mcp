import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "./runreceiptidentity.js";
import { emulatorSerialSchema } from "./interactiontarget.js";

// Same principles as runlocks: exclusive creation, process-generation ownership, durable stop
// before release, and an uncertainty hold. This is a new target scope, not an active run/app lease.
type State = "idle" | "inflight" | "in_doubt" | "stopped" | "released";
const processIdentity = `node:${process.pid}:${performance.timeOrigin}`;
export interface InteractionFence {
  readonly token: string;
  readonly serial: string;
  readonly recordPath: string;
  readonly enforcementScope: "interaction-session-only";
  readonly state: State;
  assertOwned(): void;
  begin(operation: string): void;
  end(): void;
  hold(reason: string): void;
  stop(): void;
  release(): void;
}

function directory(p: string): string {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(p).isSymbolicLink() || !fs.statSync(p).isDirectory()) throw new Error("fence directory must be a real directory");
  return fs.realpathSync(p);
}

export function acquireInteractionFence(root: string, serial: string): InteractionFence {
  emulatorSerialSchema.parse(serial);
  const base = directory(root);
  const history = directory(path.join(base, "history"));
  const key = crypto.createHash("sha256").update(serial).digest("hex");
  const recordPath = path.join(base, `${key}.owner.json`);
  const token = crypto.randomUUID();
  let state: State = "idle";
  let seq = 0;
  const owner = { schemaVersion: 1, serial, token, pid: process.pid, processIdentity,
    enforcementScope: "interaction-session-only", createdAt: new Date().toISOString() };
  const ownerBytes = canonicalJson(owner);
  try { fs.writeFileSync(recordPath, ownerBytes, { flag: "wx", mode: 0o600 }); }
  catch (e: any) { if (e.code === "EEXIST") throw new Error("target is owned/busy; elapsed time or a dead process never transfers ownership"); throw e; }
  const journal = path.join(history, `${key}-${token}.jsonl`);
  const append = (reason: string) => {
    // Sync every transition: a crashed process leaves an owner file/hold, never a claim of drain.
    const fd = fs.openSync(journal, "a", 0o600);
    try { fs.writeSync(fd, `${canonicalJson({ ...owner, seq: ++seq, state, reason, at: new Date().toISOString() })}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const assertOwned = () => {
    if (state === "released" || process.pid !== owner.pid || processIdentity !== owner.processIdentity) throw new Error("fence released or owner process changed");
    if (fs.lstatSync(recordPath).isSymbolicLink() || fs.readFileSync(recordPath, "utf8") !== ownerBytes) throw new Error("fence owner changed; refuse dispatch");
  };
  append("acquired; legacy/external/manual writers are not technically fenced");
  return {
    token, serial, recordPath, enforcementScope: "interaction-session-only",
    get state() { return state; }, assertOwned,
    begin(operation) {
      assertOwned();
      if (state !== "idle") throw new Error(`fence is ${state}; stopped, busy/inflight or uncertain work cannot dispatch`);
      state = "inflight"; append(operation);
    },
    end() { assertOwned(); if (state !== "inflight") throw new Error("no owned inflight operation to drain"); state = "idle"; append("operation drained"); },
    hold(reason) { state = "in_doubt"; append(reason.slice(0, 1000)); },
    stop() {
      assertOwned();
      if (state !== "idle") throw new Error(`cannot stop without definite drain: ${state} (uncertain work remains held)`);
      state = "stopped"; append("stopped/drained");
    },
    release() {
      assertOwned();
      if (state !== "stopped") throw new Error(`release requires stopped/drained owned execution; state=${state}`);
      state = "released"; append("released");
      fs.unlinkSync(recordPath);
    },
  };
}
