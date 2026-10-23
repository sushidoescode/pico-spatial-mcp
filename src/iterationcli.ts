import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {stripVTControlCharacters} from "node:util";
import {inspectPicoCliCached,picoCliFromEnsure,picoCliExecutionIdentity,runPicoCli,type PicoCliExecutionTarget} from "./picocli.js";
import {classifyHelpOutput,sameCliCapabilityIdentity,type CliCapabilityIdentity} from "./clicapabilities.js";
import {createCliWorkflowReference,verifyCliWorkflowReference,type CliWorkflowReference} from "./cliworkflowreference.js";
import type {InteractionTargetV1} from "./interactiontarget.js";
import {canonicalJson} from "./runreceiptidentity.js";
import {hashBuildFile} from "./fixturebuild.js";

async function cachedTarget():Promise<{cli:PicoCliExecutionTarget;identity:CliCapabilityIdentity}> {
  const inspected=await inspectPicoCliCached();
  const cli=picoCliFromEnsure(inspected);
  if(!cli)throw new Error("existing validated CLI cache unavailable; no installation or setup is performed by the interaction session");
  const identity=picoCliExecutionIdentity(cli,{env:process.env,platform:process.platform,homeDir:os.homedir(),cwd:process.cwd()});
  if(!identity)throw new Error("CLI selection identity unavailable");
  return {cli,identity};
}

/** Read-only companion reference: CLI is the sole owner of WorkflowRun IDs and revisions. */
export async function bindIterationWorkflow(input:{receiptPath:string;expectedRunId:string;expectedRevision:number}) {
  const {identity}=await cachedTarget();
  return createCliWorkflowReference({...input,cliIdentity:identity});
}
export async function checkIterationWorkflow(reference:CliWorkflowReference) {
  const {identity}=await cachedTarget();const result=verifyCliWorkflowReference(reference,identity);
  if(result.status!=="ok")throw new Error(result.reason);
}

/** Help is checked before any mutation. No CLI WorkflowRun lifecycle is created or mirrored. */
export async function prepareIterationDeployment(options:{evidenceRoot:string;deadlineEpochMs:number;signal?:AbortSignal},dependencies={
  cachedTarget,
  identity:(cli:PicoCliExecutionTarget)=>picoCliExecutionIdentity(cli,{env:process.env,platform:process.platform,homeDir:os.homedir(),cwd:process.cwd()}),
  run:runPicoCli,
}) {
  const {cli,identity}=await dependencies.cachedTarget();
  const directory=path.join(options.evidenceRoot,`cli-${crypto.randomUUID()}`);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  let sequence=0;
  const check=()=>{
    if(options.signal?.aborted||Date.now()>=options.deadlineEpochMs)throw new Error("CLI deployment cancelled/deadline elapsed");
    const current=dependencies.identity(cli);
    if(!current||!sameCliCapabilityIdentity(identity,current))throw new Error("CLI identity changed since lifecycle help discovery");
  };
  const execute=async(argv:string[],limit:number,checkFence?:()=>void)=>{
    check();
    checkFence?.();
    const recordPath=path.join(directory,`${++sequence}.json`);
    const ownershipGuard=()=>{try{checkFence?.();return null;}catch(e){return e instanceof Error?e.message:String(e);}};
    const result=await dependencies.run(cli,argv,{cwd:process.cwd(),signal:options.signal,beforeSpawn:ownershipGuard,afterCompletion:ownershipGuard,
      timeoutMs:Math.max(1,Math.min(limit,options.deadlineEpochMs-Date.now())),maxOutputBytes:1024*1024});
    fs.writeFileSync(recordPath,`${canonicalJson({schemaVersion:1,cliIdentity:identity,argv,...result})}\n`,{flag:"wx",mode:0o600});
    check();
    checkFence?.();
    if(result.code!==0||result.timedOut||result.cancelled||result.spawnError||result.outputTruncated)throw new Error(`CLI command failed or incomplete; retained ${recordPath}`);
    return result;
  };
  for(const verb of ["stop","install","launch"]) {
    const help=await execute(["app",verb,"--help"],15_000);
    const classified=classifyHelpOutput(`app-${verb}`,["app",verb],{exitCode:help.code,timedOut:help.timedOut,outputTruncated:help.outputTruncated},help.stdout,help.stderr);
    const text=stripVTControlCharacters(`${help.stdout}\n${help.stderr}`);
    if(classified.state!=="supported"||!/(?:^|\s)--device\s+<device>/.test(text)
      ||(verb==="install"&&!/(?:^|\s)--replace(?:\s|,)/.test(text)))throw new Error(`CLI lifecycle contract unavailable: ${verb}; ${classified.reason}`);
  }
  return {
    identity,evidenceDirectory:directory,
    async deploy(target:InteractionTargetV1,build:{apkPath:string;apkSha256:string},checkTargetBoot:()=>Promise<void>,checkFence:()=>void) {
      // A changed retained APK can never become an install operand.
      if(hashBuildFile(build.apkPath)!==build.apkSha256)throw new Error("retained APK hash changed before deployment");
      for(const argv of [
        ["app","stop",target.packageName,"--device",target.serial],
        ["app","install",build.apkPath,"--device",target.serial,"--replace"],
        ["app","launch",target.packageName,"--device",target.serial],
      ]) {
        check();checkFence();await checkTargetBoot();check();checkFence();
        if(hashBuildFile(build.apkPath)!==build.apkSha256)throw new Error("retained APK changed during deployment");
        await execute(argv,120_000,checkFence);
      }
      // app launch promises process creation only; the session must independently bind Bridge readiness.
    },
  };
}
