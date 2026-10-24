import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseBridgeSemanticState } from "./interactionbridge.js";
import { assertStateTarget, dispatchInteraction, type InteractionDependencies, type InteractionResultV1 } from "./semanticinteraction.js";
import { revalidateInteractionTarget, type InteractionTargetV1 } from "./interactiontarget.js";
import { canonicalJson } from "./runreceiptidentity.js";

const expectedState = z.object({panelVisible:z.boolean(),counter:z.number().int().nonnegative()}).strict();
export const scenarioSchema = z.object({
  schemaVersion:z.literal(1),name:z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  initial:expectedState,
  steps:z.array(z.object({actionId:z.literal("panel.show"),args:z.object({panelId:z.literal("fixture.panel")}).strict(),expect:expectedState}).strict()).min(1).max(20),
  limits:z.object({maxSteps:z.number().int().min(1).max(20).default(20),timeoutMs:z.number().int().min(1).max(90_000).default(90_000),
    actionTimeoutMs:z.number().int().min(1).max(60_000).default(10_000),
    captureSettleMs:z.number().int().min(0).max(3000).default(0)}).strict().default({}),
}).strict();
export type ScenarioV1=z.infer<typeof scenarioSchema>;

/** Readback under the same fence as dispatch; no 2D UI tree substitutes for the app semantic state. */
export async function observeInteraction(target:InteractionTargetV1,deps:InteractionDependencies,deadlineEpochMs=deps.now()+30_000) {
  if(deps.signal?.aborted) throw new Error("cancelled");
  if(deps.fence.serial!==target.serial) throw new Error("wrong target fence");
  deps.fence.begin("observe");
  try {
    const budget={deadlineEpochMs,signal:deps.signal,now:deps.now};
    await revalidateInteractionTarget(target,deps.probes,budget);
    const state=parseBridgeSemanticState(await deps.bridge.observe(Math.max(1,Math.min(4_000,deadlineEpochMs-deps.now()))));
    assertStateTarget(state,target,deps.now());
    await revalidateInteractionTarget(target,deps.probes,budget);
    return state;
  } finally { deps.fence.end(); }
}

export async function runScenario(raw:unknown,target:InteractionTargetV1,deps:InteractionDependencies) {
  const started=deps.now();
  const id=crypto.randomUUID();
  const recordPath=path.join(deps.evidenceRoot,"scenarios",`${id}.json`);
  const result={schemaVersion:1,kind:"pico.semantic-scenario",scenarioId:id,scenario:raw,target,
    status:"refused" as "refused"|"completed"|"failed"|"in_doubt",reason:"",actions:[] as InteractionResultV1[],
    requestedTimeoutMs:0,measuredDurationMs:0,recordPath,lookPending:true,humanInputVerified:false,
    evidenceCeiling:"structural",cliWorkflowLifecycleOwner:"official-cli",cliWorkflow:deps.cliWorkflow??null};
  try {
    const scenario=scenarioSchema.parse(raw);
    if(scenario.steps.length>scenario.limits.maxSteps) throw new Error("scenario exceeds caller's step bound");
    result.requestedTimeoutMs=scenario.limits.timeoutMs;
    const deadline=started+scenario.limits.timeoutMs;
    const check=()=>{if(deps.signal?.aborted||deps.now()>=deadline)throw new Error("scenario cancelled or deadline elapsed");};
    check();
    let state=await observeInteraction(target,deps,deadline);
    if(state.state.panel.visible!==scenario.initial.panelVisible||state.state.counter!==scenario.initial.counter) throw new Error("initial state mismatch; no implicit reset/relaunch is allowed");
    for(const step of scenario.steps) {
      check();
      const action=await dispatchInteraction(target,{schemaVersion:1,requestId:crypto.randomUUID(),packageName:target.packageName,
        expectedGeneration:target.appGeneration,expectedRevision:state.revision,actionId:step.actionId,args:step.args,
        deadlineEpochMs:Math.min(deadline,deps.now()+scenario.limits.actionTimeoutMs)},deps,{captureSettleMs:scenario.limits.captureSettleMs});
      result.actions.push(action);
      if(action.status!=="completed") {
        result.status=action.status==="in_doubt"?"in_doubt":"failed";result.reason=action.reason;break;
      }
      state=action.after!;
      if(state.state.panel.visible!==step.expect.panelVisible||state.state.counter!==step.expect.counter) {
        result.status="failed";result.reason="scenario assertion failed";break;
      }
      if(action.evidence.status!=="captured") {result.status="failed";result.reason="completed semantics lack fresh rendered evidence";break;}
      check();
      result.status="completed";result.reason="all semantic assertions passed; every frame still requires LOOK";
    }
  } catch(e:any) { result.reason=e.message??String(e); if(result.actions.length) result.status="failed"; }
  result.measuredDurationMs=deps.now()-started;
  fs.mkdirSync(path.dirname(recordPath),{recursive:true,mode:0o700});
  fs.writeFileSync(recordPath,`${canonicalJson(result)}\n`,{flag:"wx",mode:0o600});
  return result;
}

export interface IterationSnapshot {sha256:string;complete:boolean;reason?:string;[key:string]:unknown}
export type IterationBuild = {status:"failed";reason:string}|{status:"built";apkPath:string;apkSha256:string;inputSha256:string;[key:string]:unknown};
export interface IterationDependencies {
  now():number;
  snapshot():Promise<IterationSnapshot>;
  build(snapshot:IterationSnapshot):Promise<IterationBuild>;
  deploy(build:Extract<IterationBuild,{status:"built"}>):Promise<void>;
  reconnect(build:Extract<IterationBuild,{status:"built"}>):Promise<InteractionTargetV1>;
  replay(target:InteractionTargetV1):Promise<{status:string;[key:string]:unknown}>;
  signal?:AbortSignal;
  deadlineEpochMs?:number;
}

/** Finite rebuild/deploy/reconnect/replay. It never controls an official WorkflowRun lifecycle. */
export async function iterateOnce(input:{allowRelaunch:boolean},previous:InteractionTargetV1,deps:IterationDependencies,evidenceRoot:string) {
  const recordPath=path.join(evidenceRoot,`iteration-${crypto.randomUUID()}.json`);
  const result={schemaVersion:1,kind:"pico.semantic-iteration",status:"refused" as "refused"|"failed"|"completed"|"in_doubt",reason:"",
    previousTarget:previous,target:null as InteractionTargetV1|null,inputs:null as IterationSnapshot|null,
    build:null as IterationBuild|null,replay:null as Awaited<ReturnType<IterationDependencies["replay"]>>|null,
    recordPath,lookPending:true,startedAt:new Date(deps.now()).toISOString()};
  let nativeStarted=false;
  const check=()=>{if(deps.signal?.aborted||(deps.deadlineEpochMs!==undefined&&deps.now()>=deps.deadlineEpochMs))throw new Error("iteration cancelled/deadline elapsed; owned child must drain before release");};
  try {
    if(input.allowRelaunch!==true) throw new Error("explicit deploy/relaunch consent required; no implicit app reset");
    check();
    const before=await deps.snapshot();result.inputs=before;
    if(!before.complete)throw new Error(before.reason??"input closure incomplete; external modules remain Stage 2 work");
    check();
    const build=await deps.build(before);result.build=build;
    if(build.status!=="built") {result.status="failed";throw new Error(build.reason);}
    check();
    const after=await deps.snapshot();
    check();
    if(!after.complete||after.sha256!==before.sha256||build.inputSha256!==before.sha256)throw new Error("source/input closure changed during build; stale APK is not deployable");
    if(build.apkSha256===previous.apkSha256)throw new Error("rebuilt APK is unchanged; no new source-bound iteration claimed");
    nativeStarted=true;
    await deps.deploy(build);
    check();
    const target=await deps.reconnect(build);result.target=target;
    if(target.serial!==previous.serial||target.packageName!==previous.packageName||target.bootId!==previous.bootId
      ||target.apkSha256!==build.apkSha256||target.appGeneration===previous.appGeneration)throw new Error("reconnect did not establish the expected new APK/app generation on the same boot/target");
    check();
    result.replay=await deps.replay(target);
    result.status=result.replay.status==="completed"?"completed":result.replay.status==="in_doubt"?"in_doubt":"failed";
    result.reason=result.status==="completed"?"new source/APK binding replayed; LOOK pending":"replay stopped without retry";
  } catch(e:any) {
    result.reason=e.message??String(e);
    if(nativeStarted)result.status="in_doubt";
  }
  fs.mkdirSync(evidenceRoot,{recursive:true,mode:0o700});
  fs.writeFileSync(recordPath,`${canonicalJson(result)}\n`,{flag:"wx",mode:0o600});
  return result;
}

/** Opt-in finite watch: sourceDigest excludes build/evidence/cache roots in the owning adapter. */
export async function watchIterations<T extends {status:string}>(
  limits:{maxCycles:number;maxWallTimeMs:number;pollMs?:number},
  deps:{now():number;sleep(ms:number):Promise<void>;sourceDigest():Promise<string>;iterate(budget:{deadlineEpochMs:number;signal:AbortSignal}):Promise<T>;signal?:AbortSignal},
) {
  if(!Number.isInteger(limits.maxCycles)||limits.maxCycles<1||limits.maxCycles>5||!Number.isFinite(limits.maxWallTimeMs)
    ||limits.maxWallTimeMs<1||limits.maxWallTimeMs>30*60_000)throw new Error("finite watch bounds required (1..5 cycles; at most 30 minutes)");
  const poll=limits.pollMs??250;
  if(!Number.isInteger(poll)||poll<1||poll>5000)throw new Error("invalid watch polling interval");
  const start=deps.now(),deadlineEpochMs=start+limits.maxWallTimeMs,cycles:T[]=[];let prior:string|null=null;
  const controller=new AbortController();
  const abort=()=>controller.abort();
  const timer=setTimeout(abort,limits.maxWallTimeMs);
  deps.signal?.addEventListener("abort",abort,{once:true});
  if(deps.signal?.aborted)abort();
  const expired=()=>controller.signal.aborted||deps.now()>=deadlineEpochMs;
  try { while(cycles.length<limits.maxCycles&&!expired()) {
    const current=await deps.sourceDigest();
    if(expired())break;
    if(current!==prior) {
      // Coalesce bursts; never run a second build concurrently with the first.
      await deps.sleep(Math.min(poll,Math.max(1,limits.maxWallTimeMs-(deps.now()-start))));
      if(expired())break;
      const settled=await deps.sourceDigest();
      if(expired())break;
      if(settled!==current)continue;
      const cycle=await deps.iterate({deadlineEpochMs,signal:controller.signal});cycles.push(cycle);prior=current;
      if(cycle.status!=="completed")break;
    } else await deps.sleep(Math.min(poll,Math.max(1,deadlineEpochMs-deps.now())));
  } } finally {clearTimeout(timer);deps.signal?.removeEventListener("abort",abort);}
  return {cycles,requestedMaxCycles:limits.maxCycles,requestedMaxWallTimeMs:limits.maxWallTimeMs,
    measuredDurationMs:deps.now()-start,cancelled:controller.signal.aborted,deadlineReached:deps.now()>=deadlineEpochMs};
}
