import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseCliCapabilityIdentity, sameCliCapabilityIdentity, sha256Hex, type CliCapabilityIdentity } from "./clicapabilities.js";

/** Read-only references to official CLI lifecycle output. This module owns no run IDs, state
 * transitions, revisions, resume inputs or scheduler. A local scenario can reference the bytes
 * returned by a CLI read; it cannot advance their revision or substitute its own result. */
export type CliJsonCommand = "workflow.list" | "workflow.describe" | "workflow.run.read" | "workflow.result.read" | "tool-result";
export type CliJsonObservation = { exitCode: number | null; timedOut: boolean; outputTruncated: boolean; stdout: string; stderr: string };
export type CliJsonResult = { status: "ok" | "partial"; value: unknown } | { status: "invalid" | "failed" | "unknown"; reason: string };
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const datetime = z.string().datetime({offset:true});
const structuredError = z.object({ schemaVersion:z.literal("spatialcraft.workflow-error/v1"), code:z.string().regex(/^[A-Z][A-Z0-9_]*$/), category:z.enum(["validation","conflict","execution","cancellation","recovery","internal"]), message:z.string().min(1).max(2000), retryable:z.boolean(), details:z.record(z.unknown()).optional() }).strict();
// These fields are read from cached 0.6.1 chunk-3M44DZ5I.js's public WorkflowRun v1 schema.
// Retained contract evidence lists that member's hash. This deliberately does not import or
// execute installed CLI code and does not relax raw-json into a generic tool-result envelope.
const workflowRunSchema = z.object({
  schemaVersion:z.literal("pico-workflow-run/v1"), runId:identifier, requestId:identifier,
  workflowId:z.string().min(3).max(200).regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
  workflowVersion:version, contractVersion:version,
  registration:z.discriminatedUnion("kind", [z.object({kind:z.literal("builtin")}).strict(), z.object({kind:z.literal("installed"),packageName:z.string().min(1).max(214),packageVersion:version,digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()]),
  runtimeKind:z.enum(["domain","langgraph","compatibility"]),
  status:z.enum(["pending","running","waiting","cancelling","completed","partial","blocked","failed","cancelled"]),
  revision:z.number().int().nonnegative().safe(), createdAt:datetime, updatedAt:datetime,
  waiting:z.object({reason:z.string().min(1).optional(),handoff:z.object({kind:z.enum(["agent-task","human-input"]),taskId:identifier,instructions:z.string().min(1),inputSchema:z.record(z.unknown()),artifactDir:z.string().min(1),resumeCommand:z.string().min(1)}).strict().optional(),retryAfterMs:z.number().int().positive().safe().optional()}).strict().optional(),
  error:structuredError.optional(),
}).strict().superRefine((run,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
  if(Date.parse(run.updatedAt)<Date.parse(run.createdAt)) fail("updatedAt precedes createdAt");
  if((run.status==="waiting") !== (run.waiting!==undefined)) fail("waiting state does not match run status");
  if(run.waiting && !run.waiting.reason && !run.waiting.handoff) fail("waiting requires a reason or handoff");
  if((run.status==="failed" || run.status==="blocked") && !run.error) fail("failed or blocked requires CLI error");
  if(run.error && run.status!=="failed" && run.status!=="blocked") fail("only failed or blocked may include CLI error");
  if(run.waiting?.handoff) {
    const handoff=run.waiting.handoff;
    const words=handoff.resumeCommand.trim().split(/\s+/u);
    const resume=words.findIndex((word,index)=>word==="workflow" && words[index+1]==="resume");
    const task=words.indexOf("--task",resume+3);
    if(resume<0 || words[resume+2]!==run.runId || task<0 || words[task+1]!==handoff.taskId) fail("handoff resume command does not bind this CLI run/task");
  }
});

/** Command-specific formats and process status are both required. Exit 4 is PARTIAL only for
 * the contracts that declare it; it never becomes generic successful JSON merely by parsing. */
export function parseCliCommandJson(command: CliJsonCommand, observed: CliJsonObservation): CliJsonResult {
  if (observed.timedOut || observed.outputTruncated || observed.exitCode === null) return {status:"unknown",reason:"CLI observation is incomplete"};
  if (Buffer.byteLength(observed.stdout)>2*1024*1024) return {status:"invalid",reason:"CLI JSON exceeds the bounded output size"};
  let value:unknown;
  try { value=JSON.parse(observed.stdout); } catch { return {status:"invalid",reason:"CLI stdout is not one complete JSON value"}; }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : null;
  if(command==="tool-result") {
    if(!record || typeof record.tool_name!=="string" || !record.tool_name || !["SUCCESS","PARTIAL","FAILED"].includes(String(record.tool_status))) return {status:"invalid",reason:"Expected tool-result with tool_name and tool_status"};
    if(record.tool_status==="PARTIAL" && observed.exitCode===4) return {status:"partial",value};
    if(record.tool_status==="SUCCESS" && observed.exitCode===0) return {status:"ok",value};
    if(record.tool_status==="FAILED" && observed.exitCode!==0) return {status:"failed",reason:"CLI reported FAILED"};
    return {status:"invalid",reason:"tool-result status and exit code disagree"};
  }
  if(command==="workflow.result.read" && observed.exitCode===4 && record?.schemaVersion==="pico-workflow-result-read/v1" && record.available===false && record.result===null && typeof record.runId==="string" && typeof record.runStatus==="string") return {status:"partial",value};
  if(observed.exitCode!==0) return {status:"failed",reason:`${command} exited ${observed.exitCode}`};
  if(command==="workflow.list") {
    return Array.isArray(value) && value.every(item=>typeof item==="string" && /^[a-z][a-z0-9.-]+$/.test(item)) && new Set(value).size===value.length
      ? {status:"ok",value} : {status:"invalid",reason:"workflow.list requires its raw JSON string array"};
  }
  if(command==="workflow.describe") {
    const workflow=record?.workflow as Record<string,unknown>|undefined;
    return record?.schemaVersion==="pico-workflow-description/v1" && workflow && typeof workflow.id==="string" && typeof workflow.version==="string" && typeof workflow.contractVersion==="string" && !!record.contracts && !!record.runtime
      ? {status:"ok",value} : {status:"invalid",reason:"workflow.describe does not match its description schema"};
  }
  if(command==="workflow.run.read") {
    const parsed=workflowRunSchema.safeParse(value);
    return parsed.success ? {status:"ok",value:parsed.data} : {status:"invalid",reason:"workflow.run.read does not match public WorkflowRun v1"};
  }
  // Full WorkflowResult verification is outside this reference's scope. In particular, do not
  // call a partial/blocked terminal result success merely because its read exited zero.
  return {status:"unknown",reason:"Terminal WorkflowResult semantic validation is not implemented by this read-only reference adapter"};
}

export type CliWorkflowReference = {
  schemaVersion:1; authority:"pico-cli"; kind:"workflow-run-read";
  runId:string; revision:number; workflowId:string; workflowVersion:string;
  lifecycleStatus:string; cliIdentity:CliCapabilityIdentity;
  receiptPath:string; receiptSha256:string; stdoutPath:string; stdoutSha256:string;
};
function readBounded(file:string):Buffer {
  if(!path.isAbsolute(file)) throw new Error("CLI evidence paths must be absolute");
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>2*1024*1024) throw new Error("CLI evidence must be a bounded regular file");
  const bytes=fs.readFileSync(file); const after=fs.lstatSync(file);
  if(bytes.length!==stat.size || stat.ino!==after.ino || stat.dev!==after.dev || stat.mtimeMs!==after.mtimeMs || stat.ctimeMs!==after.ctimeMs) throw new Error("CLI evidence changed while reading");
  return bytes;
}

/** Receipt inputs are retained process observations from an actual CLI read, never scenario
 * fields. Creating this reference changes no CLI or local run revision. Provenance is local
 * evidence, not a signature: an actor that rewrites all evidence is outside this trust boundary. */
export function createCliWorkflowReference(args:{receiptPath:string;cliIdentity:CliCapabilityIdentity;expectedRunId:string;expectedRevision:number}):CliWorkflowReference {
  const receiptPath=path.resolve(args.receiptPath);
  if(!path.isAbsolute(args.receiptPath)) throw new Error("CLI receipt path must be absolute");
  const receiptBytes=readBounded(receiptPath);
  const receipt=JSON.parse(receiptBytes.toString("utf8")) as Record<string,unknown>;
  const identity=parseCliCapabilityIdentity(receipt.cliIdentity);
  if(receipt.schemaVersion!==1 || receipt.command!=="workflow.run.read" || !identity || identity.selectionSchemaVersion!==1 || !sameCliCapabilityIdentity(identity,args.cliIdentity)) throw new Error("CLI read receipt command or exact CLI identity mismatch");
  const expectedArgv=["workflow","run","read",args.expectedRunId,"--format","json"];
  if(JSON.stringify(receipt.argv)!==JSON.stringify(expectedArgv)) throw new Error("CLI read argv does not bind the expected run");
  if(receipt.exitCode!==0 || receipt.timedOut!==false || receipt.outputTruncated!==false) throw new Error("CLI read receipt did not complete successfully");
  if(typeof receipt.stdoutPath!=="string" || typeof receipt.stdoutSha256!=="string") throw new Error("CLI read receipt is missing output identity");
  const relative=path.relative(path.dirname(receiptPath),receipt.stdoutPath);
  if(relative.startsWith(".."+path.sep) || relative===".." || path.isAbsolute(relative)) throw new Error("CLI stdout must be retained beside or below its receipt");
  const realRelative=path.relative(fs.realpathSync(path.dirname(receiptPath)),fs.realpathSync(receipt.stdoutPath));
  if(realRelative.startsWith(".."+path.sep) || realRelative===".." || path.isAbsolute(realRelative)) throw new Error("CLI stdout symlink ancestry escapes its receipt directory");
  const stdout=readBounded(receipt.stdoutPath);
  if(sha256Hex(stdout)!==receipt.stdoutSha256) throw new Error("CLI read output hash changed");
  const parsed=parseCliCommandJson("workflow.run.read",{exitCode:0,timedOut:false,outputTruncated:false,stdout:stdout.toString("utf8"),stderr:""});
  if(parsed.status!=="ok") throw new Error("CLI read output is not an authoritative WorkflowRun v1 record");
  const run=parsed.value as z.infer<typeof workflowRunSchema>;
  if(run.runId!==args.expectedRunId || run.revision!==args.expectedRevision) throw new Error("CLI read run ID or revision does not match the expected observed revision");
  return {schemaVersion:1,authority:"pico-cli",kind:"workflow-run-read",runId:run.runId,revision:run.revision,workflowId:run.workflowId,workflowVersion:run.workflowVersion,lifecycleStatus:run.status,cliIdentity:identity,receiptPath,receiptSha256:sha256Hex(receiptBytes),stdoutPath:receipt.stdoutPath,stdoutSha256:receipt.stdoutSha256};
}

export function verifyCliWorkflowReference(reference:CliWorkflowReference,cliIdentity:CliCapabilityIdentity):{status:"ok"}|{status:"rejected";reason:string} {
  try {
    const fresh=createCliWorkflowReference({receiptPath:reference.receiptPath,cliIdentity,expectedRunId:reference.runId,expectedRevision:reference.revision});
    const keys:Array<keyof CliWorkflowReference>=["schemaVersion","authority","kind","runId","revision","workflowId","workflowVersion","lifecycleStatus","receiptPath","receiptSha256","stdoutPath","stdoutSha256"];
    if(keys.some(key=>fresh[key]!==reference[key]) || !sameCliCapabilityIdentity(fresh.cliIdentity,reference.cliIdentity)) throw new Error("CLI reference no longer matches the exact read receipt and output bytes");
    return {status:"ok"};
  } catch(error) { return {status:"rejected",reason:error instanceof Error?error.message:String(error)}; }
}
