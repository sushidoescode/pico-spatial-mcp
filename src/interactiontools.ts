import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {z} from "zod";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {CallToolResult as ToolResult} from "@modelcontextprotocol/sdk/types.js";
import {resolveAdbExecutable} from "./adb.js";
import {createInteractionBridgeBackend,interactionBridgeRequestSchema} from "./interactionbridge.js";
import {acquireInteractionFence,type InteractionFence} from "./interactionfence.js";
import {bindInteractionTarget,liveInteractionTargetProbes,revalidateInteractionTarget,emulatorSerialSchema,interactionPackageSchema,sha256Schema,type InteractionTargetV1} from "./interactiontarget.js";
import {captureAdbFrame,sha256Bytes} from "./observation.js";
import {probeDeviceIdentity} from "./deviceidentity.js";
import {run} from "./util.js";
import {dispatchInteraction,type InteractionDependencies} from "./semanticinteraction.js";
import {observeInteraction,scenarioSchema,runScenario,iterateOnce,watchIterations} from "./interactionsession.js";
import {buildIterationFixture,collectFixtureInputs} from "./fixturebuild.js";
import {bindIterationWorkflow,checkIterationWorkflow,prepareIterationDeployment} from "./iterationcli.js";
import type {CliWorkflowReference} from "./cliworkflowreference.js";
import {canonicalJson} from "./runreceiptidentity.js";

const workflowInput=z.object({receiptPath:z.string(),expectedRunId:z.string().min(1),expectedRevision:z.number().int().nonnegative()}).strict();
export const interactionToolInput={
  action:z.enum(["describe","build","open","status","observe","act","scenario","iterate","watch","reference","stop"]),
  sessionId:z.string().uuid().optional(),serial:emulatorSerialSchema.optional(),packageName:interactionPackageSchema.optional(),expectedApkSha256:sha256Schema.optional(),
  request:interactionBridgeRequestSchema.optional(),scenario:scenarioSchema.optional(),projectDir:z.string().optional(),
  allowRelaunch:z.boolean().optional(),workflow:workflowInput.optional(),
  buildTimeoutMs:z.number().int().min(1000).max(900_000).optional(),
  gradleExecutable:z.string().optional(),
  maxCycles:z.number().int().min(1).max(5).optional(),maxWallTimeMs:z.number().int().min(1).max(1_800_000).optional(),
};
const inputSchema=z.object(interactionToolInput).strict();
type Input=z.infer<typeof inputSchema>;
type Connection=Pick<InteractionDependencies,"bridge"|"probes"|"capture"> & {checkBoot?:(target:InteractionTargetV1,deadline:number)=>Promise<void>};
interface ServiceOptions {
  evidenceRoot?:string;fenceRoot?:string;now?:()=>number;sleep?:(ms:number)=>Promise<void>;
  connect?:(serial:string,packageName:string,signal?:AbortSignal)=>Promise<Connection>;
  build?:typeof buildIterationFixture;
  prepareDeployment?:typeof prepareIterationDeployment;
}
async function liveConnection(serial:string,packageName:string,signal?:AbortSignal):Promise<Connection> {
  const resolved=resolveAdbExecutable();
  if(resolved.status!=="ok")throw new Error(resolved.detail);
  const adb=resolved.path;
  const bridge=createInteractionBridgeBackend({adb,serial,packageName,signal});
  return {bridge,probes:liveInteractionTargetProbes(adb,bridge.observe),
    capture:(target,timeoutMs)=>captureAdbFrame(adb,target.serial,timeoutMs,signal),
    async checkBoot(target,deadline) {
      const device=await probeDeviceIdentity(adb,serial,{deadlineEpochMs:deadline,signal});
      const boot=await run(adb,["-s",serial,"shell","cat","/proc/sys/kernel/random/boot_id"],{timeoutMs:Math.max(1,Math.min(4000,deadline-Date.now())),signal});
      if(signal?.aborted||Date.now()>=deadline||boot.code!==0||boot.timedOut||boot.stdout.trim()!==target.bootId
        ||device.bootQemu!=="1"||device.model!==target.model||device.fingerprint!==target.fingerprint)throw new Error("explicit emulator boot/family changed during deployment");
    }};
}
interface Session {id:string;target:InteractionTargetV1;fence:InteractionFence;evidenceRoot:string;busy:boolean;workflow?:CliWorkflowReference}

/** Pure construction/discovery. Runtime operations always require an explicit emulator binding. */
export function createInteractionService(options:ServiceOptions={}) {
  const root=options.evidenceRoot??process.env.PICO_MCP_INTERACTION_EVIDENCE_DIR??path.join(os.homedir(),".pico-mcp","interaction-evidence");
  if(!path.isAbsolute(root))throw new Error("interaction evidence root must be absolute");
  const fenceRoot=options.fenceRoot??path.join(os.homedir(),".pico-mcp","interaction-fences");
  const connect=options.connect??liveConnection,now=options.now??Date.now;
  const sessions=new Map<string,Session>();
  const sleep=options.sleep??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const dependencies=(s:Session,c:Connection,signal?:AbortSignal):InteractionDependencies=>({...c,fence:s.fence,evidenceRoot:s.evidenceRoot,now,sleep,signal,cliWorkflow:s.workflow});
  async function call(raw:unknown,signal?:AbortSignal):Promise<any> {
    const input=inputSchema.parse(raw);
    if(input.action==="describe")return {status:"available",schemaVersion:1,inputRoute:"app-semantic-debug-bridge",actions:["panel.show"],
      offlineDiscovery:true,defaultCycles:1,maxScenarioSteps:20,maxScenarioMs:90_000,lookPending:true,humanInputVerified:false,
      evidenceCeiling:"structural",enforcementScope:"interaction-session-only",cliWorkflowLifecycleOwner:"official-cli",
      nativePrerequisite:"Actual native ownership/release and an already-running explicit emulator; this tool grants no ownership and never boots or selects a headset.",
      claimLimit:"Implemented adapter; runtime/visual/host-image acceptance requires separately retained evidence. Legacy/manual/CLI writers are not fenced."};
    if(signal?.aborted)throw new Error("cancelled before operation");
    if(input.action==="build") {
      if(!input.projectDir||!path.isAbsolute(input.projectDir))throw new Error("absolute fixture projectDir required");
      return (options.build??buildIterationFixture)({projectDir:input.projectDir,evidenceRoot:root,timeoutMs:input.buildTimeoutMs,gradleExecutable:input.gradleExecutable,signal});
    }
    if(input.action==="open") {
      if(!input.serial||!input.packageName||!input.expectedApkSha256)throw new Error("explicit serial, package and expected installed APK hash required");
      const fence=acquireInteractionFence(fenceRoot,input.serial);
      try {
        const c=await connect(input.serial,input.packageName,signal);
        const target=await bindInteractionTarget({serial:input.serial,packageName:input.packageName,expectedApkSha256:input.expectedApkSha256},c.probes,{deadlineEpochMs:now()+30_000,signal,now});
        const id=crypto.randomUUID(),evidenceRoot=path.join(root,id),s:Session={id,target,fence,evidenceRoot,busy:false};
        fs.mkdirSync(evidenceRoot,{recursive:true,mode:0o700});
        const state=await observeInteraction(target,dependencies(s,c,signal));
        const recordPath=path.join(evidenceRoot,"session.json");
        const opened={status:"opened",sessionId:id,target,state,recordPath,lookPending:true,enforcementScope:fence.enforcementScope};
        fs.writeFileSync(recordPath,`${canonicalJson(opened)}\n`,{flag:"wx",mode:0o600});sessions.set(id,s);return opened;
      } catch(e) { if(fence.state==="idle"){fence.stop();fence.release();}throw e; }
    }
    const s=input.sessionId?sessions.get(input.sessionId):undefined;
    if(!s)throw new Error("unknown/stopped session; open an explicit target first");
    if(input.action==="status")return {status:s.fence.state,sessionId:s.id,target:s.target,busy:s.busy,evidenceRoot:s.evidenceRoot,workflow:s.workflow??null,lookPending:true};
    if(s.busy)throw new Error("session busy; concurrent calls cannot overlap");
    s.fence.assertOwned();s.busy=true;
    try {
      if(input.action==="stop") {s.fence.stop();s.fence.release();sessions.delete(s.id);return {status:"stopped",sessionId:s.id,appStopped:false,recordPath:s.fence.recordPath};}
      if(input.action==="reference") {
        if(!input.workflow)throw new Error("retained official CLI read receipt required");
        s.workflow=await bindIterationWorkflow(input.workflow);
        return {status:"referenced",sessionId:s.id,workflow:s.workflow,cliWorkflowLifecycleOwner:"official-cli"};
      }
      if(s.workflow)await checkIterationWorkflow(s.workflow);
      const c=await connect(s.target.serial,s.target.packageName,signal),deps=dependencies(s,c,signal);
      if(input.action==="observe")return {status:"observed",target:s.target,state:await observeInteraction(s.target,deps),workflow:s.workflow??null,lookPending:true};
      if(input.action==="act") {
        if(!input.request)throw new Error("explicit action request including generation/revision/nonce/deadline required");
        return dispatchInteraction(s.target,input.request,deps);
      }
      if(!input.scenario)throw new Error("bounded scenario required");
      if(input.action==="scenario")return {...await runScenario(input.scenario,s.target,deps),workflow:s.workflow??null};
      if(input.allowRelaunch!==true)throw new Error("explicit allowRelaunch required; replacement install and fixture stop/launch preserve app data");
      if(!input.projectDir||!path.isAbsolute(input.projectDir))throw new Error("absolute dedicated fixture projectDir required");
      if(s.target.packageName!=="com.example.picofixture.iteration.debug")throw new Error("rebuild/replay is limited to the dedicated debug fixture");
      const projectDir=input.projectDir,scenario=input.scenario;
      const cycle=async(budget:{deadlineEpochMs:number;signal:AbortSignal})=>{
        if(s.workflow)await checkIterationWorkflow(s.workflow);
        const connection=await connect(s.target.serial,s.target.packageName,budget.signal);
        const cycleDeps=dependencies(s,connection,budget.signal);
        const result=await iterateOnce({allowRelaunch:true},s.target,{
          now,signal:budget.signal,deadlineEpochMs:budget.deadlineEpochMs,
          snapshot:async()=>collectFixtureInputs(projectDir),
          build:async()=> {
            if(budget.deadlineEpochMs-now()<1000)return {status:"failed",reason:"insufficient build time remains"};
            return (options.build??buildIterationFixture)({projectDir,evidenceRoot:s.evidenceRoot,signal:budget.signal,gradleExecutable:input.gradleExecutable,
              timeoutMs:Math.min(input.buildTimeoutMs??600_000,budget.deadlineEpochMs-now())});
          },
          deploy:async build=>{
            const cli=await (options.prepareDeployment??prepareIterationDeployment)({evidenceRoot:s.evidenceRoot,deadlineEpochMs:budget.deadlineEpochMs,signal:budget.signal});
            s.fence.begin("deploy/relaunch exact source-bound fixture");
            try {
              await revalidateInteractionTarget(s.target,connection.probes,{deadlineEpochMs:budget.deadlineEpochMs,signal:budget.signal,now});
              if(!connection.checkBoot)throw new Error("deployment boot guard unavailable");
              await cli.deploy(s.target,build,()=>connection.checkBoot!(s.target,budget.deadlineEpochMs),()=>s.fence.assertOwned());
            } catch(e) {s.fence.hold(e instanceof Error?e.message:String(e));throw e;}
          },
          reconnect:async build=>{
            // Read-only readiness polling, never action/install retry.
            const deadline=Math.min(budget.deadlineEpochMs,now()+30_000);let last:unknown;
            while(now()<deadline&&!budget.signal.aborted) {
              try {
                const next=await bindInteractionTarget({serial:s.target.serial,packageName:s.target.packageName,expectedApkSha256:build.apkSha256},connection.probes,{deadlineEpochMs:deadline,signal:budget.signal,now});
                if(next.bootId!==s.target.bootId||next.appGeneration===s.target.appGeneration)throw new Error("new app generation not ready on original boot");
                s.target=next;s.fence.end();return next;
              } catch(e){last=e;await sleep(Math.min(100,Math.max(1,deadline-now())));}
            }
            s.fence.hold("reconnect incomplete after possible deployment");throw last??new Error("reconnect cancelled/deadline elapsed");
          },
          replay:target=>runScenario(scenario,target,cycleDeps),
        },s.evidenceRoot);
        if(result.status==="in_doubt"&&s.fence.state!=="in_doubt")s.fence.hold(result.reason);
        return {...result,workflow:s.workflow??null};
      };
      const maxWallTimeMs=input.maxWallTimeMs??Math.min(1_800_000,(input.buildTimeoutMs??600_000)+180_000);
      const watched=await watchIterations({maxCycles:input.action==="watch"?(input.maxCycles??1):1,maxWallTimeMs},
        {now,sleep,sourceDigest:async()=>collectFixtureInputs(projectDir).sha256,iterate:cycle,signal});
      if(input.action==="iterate"&&watched.cycles.length===1)return {...watched.cycles[0],requestedMaxWallTimeMs:watched.requestedMaxWallTimeMs,measuredDurationMs:watched.measuredDurationMs};
      return {status:watched.cycles.length&&watched.cycles.every(cycle=>cycle.status==="completed")?"completed":"failed",...watched,lookPending:true};
    } finally {s.busy=false;}
  }
  return {call};
}

/** Ordinary MCP blocks. Paths/hashes remain usable when a client cannot render image blocks. */
export function interactionToolResult(result:any):ToolResult {
  const content:ToolResult["content"]=[];
  let deliveryFailed=false;
  const action=result.evidence?result:result.actions?.at(-1)??result.replay?.actions?.at(-1);
  if(action?.status==="completed"&&action.evidence?.status==="captured") {
    try {
      const bytes=fs.readFileSync(action.evidence.path);
      if(sha256Bytes(bytes)!==action.evidence.sha256)throw new Error("capture bytes changed before MCP delivery");
      if(bytes.length<=8*1024*1024)content.push({type:"image",data:bytes.toString("base64"),mimeType:"image/png"});
    } catch(e) {deliveryFailed=true;result={...result,delivery:{status:"failed",reason:e instanceof Error?e.message:String(e)}};}
  }
  content.unshift({type:"text",text:JSON.stringify(result,null,2)});
  if(result.recordPath&&fs.existsSync(result.recordPath))content.push({type:"resource_link",name:path.basename(result.recordPath),uri:pathToFileURL(result.recordPath).href,mimeType:"application/json"});
  return {content,structuredContent:result,...(deliveryFailed||["failed","refused","timed_out","in_doubt"].includes(result.status)?{isError:true}:{})};
}
export function registerInteractionSessionTools(server:McpServer,service=createInteractionService()) {
  server.registerTool("pico_interaction",{description:"Opt-in bounded semantic fixture session: describe/build/open/observe/act/scenario/iterate/watch/stop. Explicit emulator, APK and lifecycle binding; app debug action ACKs are not hand/controller input. Obtain actual native ownership separately. Never boots, chooses a headset, clears data, or owns CLI WorkflowRun lifecycle. Frames require LOOK. stop releases only a drained MCP session; uncertainty remains held.",inputSchema:interactionToolInput},
    async(input,extra)=>{try{return interactionToolResult(await service.call(input,extra.signal));}catch(e){return {isError:true,content:[{type:"text",text:JSON.stringify({status:"error",reason:e instanceof Error?e.message:String(e),lookPending:true,
      outcome:"Inspect retained session evidence before any repeat; this error does not certify that no action occurred."})}]};}});
}
