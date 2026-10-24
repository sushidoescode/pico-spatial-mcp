import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  interactionBridgeRequestSchema, parseBridgeSemanticState, parseInteractionBridgeAck,
  type InteractionBridgeRequestV1, type InteractionBridgeAckV1, type BridgeSemanticStateV1,
} from "./interactionbridge.js";
import { type InteractionTargetV1, type InteractionTargetProbes, revalidateInteractionTarget } from "./interactiontarget.js";
import type { InteractionFence } from "./interactionfence.js";
import { canonicalJson } from "./runreceiptidentity.js";
import { sha256Bytes, type CapturedFrame } from "./observation.js";
import { validateCaptureBuffer } from "./evidence.js";
import type {CliWorkflowReference} from "./cliworkflowreference.js";

export interface InteractionDependencies {
  bridge: {
    observe(timeoutMs?: number): Promise<BridgeSemanticStateV1>;
    send(request: InteractionBridgeRequestV1, timeoutMs?: number): Promise<void>;
    readAck(request: InteractionBridgeRequestV1, timeoutMs?: number): Promise<InteractionBridgeAckV1 | null>;
  };
  probes: InteractionTargetProbes;
  fence: InteractionFence;
  evidenceRoot: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  capture(target: InteractionTargetV1, timeoutMs: number): Promise<CapturedFrame>;
  signal?: AbortSignal;
  cliWorkflow?: CliWorkflowReference;
}
export type InteractionEvidence = {status:"captured";path:string;sha256:string;bytes:number;capturedAt:string;width:number;height:number}
  | {status:"failed"|"not_requested";reason:string;path?:string};
export interface InteractionResultV1 {
  schemaVersion: 1;
  kind: "pico.interaction-result";
  status: "accepted" | "completed" | "refused" | "timed_out" | "in_doubt";
  request: unknown;
  target: InteractionTargetV1;
  attempted: boolean;
  before: BridgeSemanticStateV1 | null;
  acknowledgement: InteractionBridgeAckV1 | null;
  after: BridgeSemanticStateV1 | null;
  evidence: InteractionEvidence;
  evidenceCeiling: "structural";
  lookPending: true;
  inputRoute: "app-semantic-debug-bridge";
  humanInputVerified: false;
  reason: string;
  recordPath: string;
  captureSettleMs: number;
  captureSettleMeasuredMs: number;
  captureRequestedAt: string | null;
}

export function assertStateTarget(state: BridgeSemanticStateV1, target: InteractionTargetV1,now=Date.now()): void {
  if (state.packageName !== target.packageName || state.generation !== target.appGeneration
    || state.pid !== target.pid || state.pidStartTicks !== target.pidStartTicks) throw new Error("semantic state belongs to a stale target/process generation");
  if(state.observedAtEpochMs<now-2000||state.observedAtEpochMs>now+1000) throw new Error("semantic state is stale or app/host clocks disagree");
}

/** One send at most. App ACK, independent state readback and pixels remain separate evidence. */
export async function dispatchInteraction(target: InteractionTargetV1, raw: unknown, deps: InteractionDependencies, options: {captureSettleMs?:number} = {}): Promise<InteractionResultV1> {
  const attemptDir = path.join(deps.evidenceRoot, "attempts", crypto.randomUUID());
  fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
  const result: InteractionResultV1 = {
    schemaVersion: 1, kind: "pico.interaction-result", status: "refused", request: raw, target,
    attempted: false, before: null, acknowledgement: null, after: null,
    evidence: { status: "not_requested", reason: "no completed action" }, evidenceCeiling: "structural",
    lookPending: true, inputRoute: "app-semantic-debug-bridge", humanInputVerified: false, reason: "",
    recordPath: path.join(attemptDir, "result.json"),
    captureSettleMs: options.captureSettleMs ?? 0,
    captureSettleMeasuredMs: 0, captureRequestedAt: null,
  };
  let ownsOperation = false;
  let dispatchedAt = 0;
  const finish = () => {
    fs.writeFileSync(result.recordPath, `${canonicalJson(result)}\n`, {flag:"wx",mode:0o600});
    return result;
  };
  try {
    if(!Number.isInteger(result.captureSettleMs)||result.captureSettleMs<0||result.captureSettleMs>3000)throw new Error("capture settle must be 0..3000 ms");
    const request = interactionBridgeRequestSchema.parse(raw);
    const budget={deadlineEpochMs:request.deadlineEpochMs,signal:deps.signal,now:deps.now};
    const remaining = () => Math.max(1, Math.min(4_000, request.deadlineEpochMs - deps.now()));
    const checkDeadline = () => {
      if (deps.signal?.aborted) throw new Error("cancelled");
      if (deps.now() >= request.deadlineEpochMs) throw new Error("action deadline elapsed");
    };
    const checkSettleFits = () => { if(result.captureSettleMs>=request.deadlineEpochMs-deps.now())throw new Error("capture settle cannot fit within the action deadline"); };
    if (request.packageName !== target.packageName || request.expectedGeneration !== target.appGeneration) throw new Error("request does not name the bound app generation");
    if (request.deadlineEpochMs <= deps.now()) { result.status = "timed_out"; throw new Error("action deadline elapsed before dispatch"); }
    if (request.deadlineEpochMs - deps.now() > 60_000) throw new Error("action deadline exceeds explicit 60-second limit (default is 10 seconds)");
    checkSettleFits();
    checkDeadline();
    if (deps.fence.serial !== target.serial) throw new Error("fence belongs to another target");
    deps.fence.begin("semantic action"); ownsOperation = true;
    await revalidateInteractionTarget(target, deps.probes,budget);
    checkDeadline();
    const before = parseBridgeSemanticState(await deps.bridge.observe(remaining()));
    result.before = before;
    assertStateTarget(before, target,deps.now());
    if (before.revision !== request.expectedRevision) throw new Error("semantic revision changed before dispatch; possible external writer (not prevented)");
    if (!before.actions.includes(request.actionId)) throw new Error("action is not declared by this app");
    checkDeadline();
    checkSettleFits();
    // Reserve the ID durably BEFORE dispatch. A process interruption never makes it reusable.
    const requests = path.join(deps.evidenceRoot, "requests");
    fs.mkdirSync(requests, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path.join(requests, `${request.requestId}.json`), "wx", 0o600);
    try { fs.writeSync(fd, canonicalJson({ request, target, attemptDir })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    deps.fence.assertOwned();
    checkDeadline();
    checkSettleFits();
    result.attempted = true; // From this point, a transport error can mean the app acted.
    dispatchedAt = deps.now();
    await deps.bridge.send(request, remaining());
    let completed = false;
    while (!completed) {
      checkDeadline();
      deps.fence.assertOwned();
      const rawAck = await deps.bridge.readAck(request, remaining());
      if (rawAck !== null) {
        const ack = parseInteractionBridgeAck(rawAck, request);
        if(ack.acknowledgedAtEpochMs<before.observedAtEpochMs||ack.acknowledgedAtEpochMs<dispatchedAt-1000
          ||ack.acknowledgedAtEpochMs>deps.now()+1000)throw new Error("stale/future ACK timestamp");
        if (ack.requestId !== request.requestId || ack.packageName !== request.packageName
          || ack.generation !== request.expectedGeneration || ack.expectedRevision !== request.expectedRevision
          || ack.actionId !== request.actionId || canonicalJson(ack.args) !== canonicalJson(request.args)) throw new Error("ACK identity mismatch");
        result.acknowledgement = ack;
        if (ack.status === "refused") {
          if (ack.revision !== before.revision) throw new Error("refused ACK reports an unexpected state revision");
          await revalidateInteractionTarget(target, deps.probes,budget);
          result.status = "refused"; result.reason = "app refused the action";
          deps.fence.end(); ownsOperation = false;
          return finish();
        }
        completed = ack.status === "completed";
      }
      if (!completed) await deps.sleep(Math.min(50, remaining()));
    }
    checkDeadline();
    await revalidateInteractionTarget(target, deps.probes,budget);
    const after = parseBridgeSemanticState(await deps.bridge.observe(remaining()));
    result.after = after;
    assertStateTarget(after, target,deps.now());
    const ack = result.acknowledgement!;
    const delta = before.state.panel.visible ? 0 : 1;
    if (ack.revision !== before.revision + delta || after.revision !== ack.revision
      || canonicalJson(after.state) !== canonicalJson(ack.state)
      || !after.state.panel.visible || after.state.panel.id !== request.args.panelId
      || after.state.counter !== before.state.counter + delta) throw new Error("completed ACK and independent state/assertion disagree; possible interference");
    result.status = "completed";
    result.reason = "app acknowledged panel.show; independent semantic assertion passed";
    const completedAt = deps.now();
    // Explicit compositor accommodation, never a render assertion. It consumes the existing
    // action/scenario deadline and remains interruptible; the resulting frame still needs LOOK.
    const settleUntil = completedAt + result.captureSettleMs;
    while(deps.now()<settleUntil) {
      checkDeadline();deps.fence.assertOwned();
      await deps.sleep(Math.min(50,settleUntil-deps.now(),remaining()));
      result.captureSettleMeasuredMs=deps.now()-completedAt;
    }
    checkDeadline();
    if(result.captureSettleMs) {
      await revalidateInteractionTarget(target,deps.probes,budget);
      const settledState=parseBridgeSemanticState(await deps.bridge.observe(remaining()));
      assertStateTarget(settledState,target,deps.now());
      if(settledState.revision!==after.revision||canonicalJson(settledState.state)!==canonicalJson(after.state))throw new Error("state changed while waiting for capture");
      result.after=settledState;
    }
    checkDeadline();
    try {
      const captureRequestedAt=deps.now();result.captureRequestedAt=new Date(captureRequestedAt).toISOString();
      const frame = await deps.capture(target, remaining());
      const checked = validateCaptureBuffer(frame.bytes, "interaction capture");
      const framePath = path.join(attemptDir, "frame.png");
      fs.writeFileSync(framePath, frame.bytes, {flag:"wx",mode:0o600}); // retain even a refused frame
      if (!checked.ok || checked.format !== "png" || !Number.isFinite(Date.parse(frame.capturedAt))
        || Date.parse(frame.capturedAt) < captureRequestedAt || Date.parse(frame.capturedAt) > deps.now() + 1000) {
        result.evidence = {status:"failed",reason:"invalid or stale capture; not attributable",path:framePath};
      } else {
        result.evidence = {status:"captured",path:framePath,sha256:sha256Bytes(frame.bytes),bytes:frame.bytes.length,
          capturedAt:frame.capturedAt,width:checked.width!,height:checked.height!};
      }
    } catch (e: any) {
      result.evidence = {status:"failed",reason:e.message ?? String(e)};
    }
    // A failed capture is not an uncertain action. Identity/state drift is, even after ACK.
    await revalidateInteractionTarget(target, deps.probes,budget);
    const finalState = parseBridgeSemanticState(await deps.bridge.observe(remaining()));
    assertStateTarget(finalState, target,deps.now());
    checkDeadline();
    if (finalState.revision !== after.revision || canonicalJson(finalState.state) !== canonicalJson(after.state)) throw new Error("state changed during capture; possible external writer");
    deps.fence.end(); ownsOperation = false;
  } catch (e: any) {
    result.reason = e.code === "EEXIST" ? "request ID already reserved; no replay" : e.message ?? String(e);
    if (result.attempted) {
      result.status = "in_doubt";
      if (ownsOperation) deps.fence.hold(result.reason);
      ownsOperation = false;
    } else if (result.status !== "timed_out") result.status = "refused";
    if (ownsOperation) { deps.fence.end(); ownsOperation = false; }
  }
  return finish();
}
