// Host-only command/identity contract fixtures. Never spawn the installed CLI or touch adb.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as capabilities from "../dist/clicapabilities.js";
import * as managed from "../dist/picoclimanaged.js";
const sha = capabilities.sha256Hex;
const identity = { version: "0.6.1", executablePath: "/fixture/pico-cli", packageJsonSha256: sha("pkg"), executionTreeSha256: sha("tree"), selectionSchemaVersion: 1, selectionSha256: sha("selection") };
const successful = { exitCode: 0, timedOut: false, outputTruncated: false };
const completeHelp = "Usage:\n  $ pico-cli perf trace record [options]\n\nOptions:\n  --package <package>  Application\n  -h, --help  Display this message\n";
function root(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-cli-contract-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test("exit-zero help ending mid-option is unknown even when usage names the requested operation", () => {
  const result = capabilities.classifyHelpOutput("trace-record", ["perf", "trace", "record"], successful, completeHelp.slice(0, -20), "warning\n");
  assert.equal(result.state, "unknown");
  assert.match(result.reason, /incomplete-help/);
});
test("exit-zero usage-only prefix cannot establish a complete help contract", () => {
  const result = capabilities.classifyHelpOutput("trace-record", ["perf", "trace", "record"], successful, "Usage:\n  $ pico-cli perf trace record [options]\n", "");
  assert.equal(result.state, "unknown");
});
test("unknown flags are unavailable and a newer version never promotes incomplete output", () => {
  assert.equal(capabilities.classifyHelpOutput("trace-record", ["perf", "trace", "record"], {...successful, exitCode:3}, "", "Unknown option --invented").state, "unavailable");
  const route = capabilities.cliOperationRoutes("99.0.0").find(r => r.operation === "trace-record");
  assert.equal(capabilities.classifyOperation(route, [{ observation: {...successful,argv:["perf","trace","record","--help"]}, stdout: completeHelp.slice(0,-20), stderr: "" }]).state, "unknown");
});
test("schema-1 records are retained for inspection but cannot authorize dispatch without selection identity", () => {
  const legacy = {...identity}; delete legacy.selectionSchemaVersion; delete legacy.selectionSha256;
  const set = {schemaVersion:1, identity:legacy, checkedAt:"2026-10-23T00:00:00.000Z", operations:[]};
  assert.ok(capabilities.parseCliCapabilitySet(set));
  const result = capabilities.resolveOperationCapability({set,target:legacy,operation:"trace-record",readEvidence:()=>null});
  assert.match(result.reason, /selection-identity-required/);
});
test("selected utility bytes and nearest project environment invalidate an unchanged package identity", t => {
  const dir=root(t); const utility=path.join(dir,"profiler.mjs"); fs.writeFileSync(utility,"export const version = 1;\n");
  const cwd=path.join(dir,"project"); fs.mkdirSync(cwd);
  const options={env:{PICO_CLI_PROFILER_ENTRY_PATH:utility},platform:process.platform,homeDir:dir,cwd};
  const before=managed.cliSelectionIdentity(options);
  fs.writeFileSync(utility,"export const version = 2;\n");
  const replaced=managed.cliSelectionIdentity(options);
  assert.ok(before); assert.ok(replaced); assert.notEqual(before.sha256,replaced.sha256);
  fs.writeFileSync(path.join(cwd,".pico-env.json"),JSON.stringify({version:"0.13",platform:"spatial"}));
  const project=managed.cliSelectionIdentity(options); assert.notEqual(replaced.sha256,project.sha256);
  const changed=managed.cliSelectionIdentity({...options,env:{...options.env,PICO_HOME:path.join(dir,"sdk")}}); assert.notEqual(project.sha256,changed.sha256);
  assert.equal(capabilities.sameCliCapabilityIdentity(identity,{...identity,selectionSha256:changed.sha256}),false);
});
test("command-specific JSON distinguishes raw workflow arrays from tool-result PARTIAL exit four", async () => {
  const {parseCliCommandJson}=await import("../dist/cliworkflowreference.js");
  assert.equal(parseCliCommandJson("workflow.list",{...successful,stdout:'["spatial-design-to-app"]',stderr:""}).status,"ok");
  assert.equal(parseCliCommandJson("workflow.list",{...successful,stdout:'{"tool_status":"SUCCESS","data":[]}',stderr:""}).status,"invalid");
  assert.equal(parseCliCommandJson("tool-result",{...successful,exitCode:4,stdout:'{"tool_name":"emulator.status","tool_status":"PARTIAL","data":{}}',stderr:""}).status,"partial");
  assert.equal(parseCliCommandJson("tool-result",{...successful,stdout:'{"tool_status":"PARTIAL","data":{}}',stderr:""}).status,"invalid");
});
test("CLI run references verify retained command, path, hash and revision; a local scenario cannot revise them", async t => {
  const mod=await import("../dist/cliworkflowreference.js"); const dir=root(t); const output=path.join(dir,"read.stdout.json"); const receipt=path.join(dir,"read.json");
  const run={schemaVersion:"pico-workflow-run/v1",runId:"run-fixture",requestId:"request-fixture",workflowId:"spatial-design-to-app",workflowVersion:"1.0.0",contractVersion:"1.0.0",registration:{kind:"builtin"},runtimeKind:"domain",status:"running",revision:3,createdAt:"2026-10-23T00:00:00.000Z",updatedAt:"2026-10-23T00:00:01.000Z"};
  fs.writeFileSync(output,JSON.stringify(run)); const source={schemaVersion:1,command:"workflow.run.read",argv:["workflow","run","read",run.runId,"--format","json"],...successful,cliIdentity:identity,stdoutPath:output,stdoutSha256:sha(fs.readFileSync(output))}; fs.writeFileSync(receipt,JSON.stringify(source));
  const reference=mod.createCliWorkflowReference({receiptPath:receipt,cliIdentity:identity,expectedRunId:run.runId,expectedRevision:3});
  assert.equal(reference.revision,3); assert.equal(reference.authority,"pico-cli");
  assert.equal(mod.verifyCliWorkflowReference(reference,identity).status,"ok");
  assert.equal(mod.verifyCliWorkflowReference({...reference,revision:4},identity).status,"rejected");
  fs.writeFileSync(output,JSON.stringify({...run,revision:4}));
  assert.equal(mod.verifyCliWorkflowReference(reference,identity).status,"rejected");
  assert.throws(()=>mod.createCliWorkflowReference({receiptPath:receipt,cliIdentity:identity,expectedRunId:run.runId,expectedRevision:4}),/hash|changed/);
});

test("retained 0.6.1 streams reproduce pipe uncertainty and PTY declaration without runtime promotion", () => {
  const fixture=path.join(import.meta.dirname,"fixtures/picocli/help/0.6.1");
  const index=JSON.parse(fs.readFileSync(path.join(fixture,"index.json"),"utf8"));
  for(const observed of index.observations) {
    for(const stream of ["stdout","stderr"]) {
      const bytes=fs.readFileSync(path.join(fixture,observed[stream].path));
      assert.equal(sha(bytes),observed[stream].sha256); assert.equal(bytes.length,observed[stream].bytes);
    }
  }
  for(const [operation,stem,argv] of [["perf-live","perf-live-help",["perf","live","run"]],["trace-record","trace-record-help",["perf","trace","record"]],["trace-decode","trace-decode-help",["perf","trace","decode"]],["trace-load","trace-load-help",["perf","trace","load"]]]) {
    for(const [transport,expected] of [["pipe","unknown"],["pty","supported"]]) {
      const r=index.observations.find(r=>r.stem===`${stem}-${transport}`);
      const result=capabilities.classifyHelpOutput(operation,argv,r,fs.readFileSync(path.join(fixture,r.stdout.path),"utf8"),fs.readFileSync(path.join(fixture,r.stderr.path),"utf8"));
      assert.equal(result.state,expected,`${stem}-${transport}`);
    }
  }
  assert.equal(capabilities.cliOperationOptions("99.0.0","trace-record"),null);
  assert.equal(capabilities.cliOperationNativeDurationFlag("99.0.0","watch-crash"),null);
});

test("external CLI imported package helpers are part of its execution identity", t => {
  const dir=root(t); fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name:"@picoxr/pico-cli",version:"0.6.1"}));
  const entry=path.join(dir,"index.mjs"); fs.writeFileSync(entry,'import "./helper.mjs";\n'); fs.chmodSync(entry,0o755);
  const helper=path.join(dir,"helper.mjs"); fs.writeFileSync(helper,"export const revision=1;\n");
  const context={env:{},platform:process.platform,homeDir:dir,cwd:dir};
  const before=managed.externalCliCapabilityIdentity(entry,"0.6.1",context); assert.ok(before);
  fs.writeFileSync(helper,"export const revision=2;\n");
  const after=managed.externalCliCapabilityIdentity(entry,"0.6.1",context); assert.ok(after);
  assert.notEqual(before.executionTreeSha256,after.executionTreeSha256);
  assert.equal(before.packageJsonSha256,after.packageJsonSha256);
});

test("retained current Workflow JSON is command specific and PARTIAL read is never success", async () => {
  const {parseCliCommandJson}=await import("../dist/cliworkflowreference.js");
  const fixture=path.join(import.meta.dirname,"fixtures/picocli/help/0.6.1");
  for(const [command,stem] of [["workflow.list","workflow-list"],["workflow.describe","workflow-describe"]]) {
    const stdout=fs.readFileSync(path.join(fixture,`${stem}-pipe.stdout.txt`),"utf8");
    assert.equal(parseCliCommandJson(command,{...successful,stdout,stderr:""}).status,"ok");
    assert.equal(parseCliCommandJson(command,{...successful,exitCode:4,stdout,stderr:""}).status,"failed");
  }
  const partial={schemaVersion:"pico-workflow-result-read/v1",runId:"run-fixture",available:false,runStatus:"running",result:null};
  assert.equal(parseCliCommandJson("workflow.result.read",{...successful,exitCode:4,stdout:JSON.stringify(partial),stderr:""}).status,"partial");
});

test("a capability record cannot survive selected utility drift even at the same CLI version", t => {
  const dir=root(t); const utility=path.join(dir,"profiler.mjs"); fs.writeFileSync(utility,"one\n");
  const context={env:{PICO_CLI_PROFILER_ENTRY_PATH:utility},platform:process.platform,homeDir:dir,cwd:dir};
  const first={...identity,selectionSha256:managed.cliSelectionIdentity(context).sha256};
  const set={schemaVersion:2,identity:first,checkedAt:"2026-10-23T00:00:00.000Z",operations:[]};
  fs.writeFileSync(utility,"two\n");
  const current={...first,selectionSha256:managed.cliSelectionIdentity(context).sha256};
  let reads=0; const result=capabilities.resolveOperationCapability({set,target:current,operation:"trace-record",readEvidence:()=>{reads++;return null;}});
  assert.equal(result.state,"unknown"); assert.match(result.reason,/stale-identity:.*selectionSha256/); assert.equal(reads,0);
});
