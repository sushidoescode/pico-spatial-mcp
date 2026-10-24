// One-off root reconciliation of one retained native attempt, never a stale-owner policy.
// No action is sent; no app lifecycle command is run; the retired nonce is never reused.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {runBinary} from '../../dist/util.js';
import {createInteractionBridgeBackend} from '../../dist/interactionbridge.js';
import {bindInteractionTarget,liveInteractionTargetProbes} from '../../dist/interactiontarget.js';
const ev=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(ev,'../..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const artifactsPath=path.join(root,'evidence/2026-10-23-agent-iteration/ARTIFACTS.json');
const originalBuild=JSON.parse(fs.readFileSync(artifactsPath)).hostRebuilds[1];
const buildRecordBytes=fs.readFileSync(path.join(root,originalBuild.record.path));
assert.equal(sha(buildRecordBytes),originalBuild.record.sha256);
const buildRecord=JSON.parse(buildRecordBytes);
assert.equal(buildRecord.apkSha256,originalBuild.apk.sha256);
assert.equal(sha(fs.readFileSync(path.join(root,originalBuild.apk.path))),originalBuild.apk.sha256);
const sourceChecks=[];
for(const name of ['AgentInteractionBridge.kt','FixtureState.kt']){
 const entry=buildRecord.inputs.inputs.entries.find(e=>e.path.endsWith('/'+name));assert.ok(entry);
 const current=sha(fs.readFileSync(path.join(root,'examples/agent-iteration-fixture',entry.path)));
 assert.equal(current,entry.sha256);sourceChecks.push(entry);
}
const attemptPath=path.join(root,'evidence/agent-iteration-example/e682ba58-24c2-4725-9cd4-3947779caa58/attempts/89fb3a53-4a09-4adb-89ac-35727280124c/result.json');
const attemptBytes=fs.readFileSync(attemptPath),attempt=JSON.parse(attemptBytes);
const serial='emulator-5554',token='ca7b0327-cc11-46a9-9ba0-a46b4eb1f642';
const key=sha(serial),fenceRoot=path.join(os.homedir(),'.pico-mcp/interaction-fences');
const ownerPath=path.join(fenceRoot,key+'.owner.json'),historyPath=path.join(fenceRoot,'history',key+'-'+token+'.jsonl');
const ownerBytes=fs.readFileSync(ownerPath),owner=JSON.parse(ownerBytes),historyBytes=fs.readFileSync(historyPath);
const pin=p=>{const s=fs.lstatSync(p);assert.ok(s.isFile()&&!s.isSymbolicLink());return {dev:s.dev,ino:s.ino,mode:s.mode,size:s.size,birthtimeMs:s.birthtimeMs,mtimeMs:s.mtimeMs};};
const ownerPin=pin(ownerPath),historyPin=pin(historyPath);
const sync=p=>{const fd=fs.openSync(p,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
assert.equal(owner.token,token);assert.equal(owner.pid,29883);assert.equal(owner.serial,serial);
assert.equal(owner.processIdentity,'node:29883:1792818339302.97');
assert.equal(JSON.parse(historyBytes.toString().trim().split('\n').at(-1)).state,'in_doubt');
assert.equal(attempt.status,'in_doubt');assert.equal(attempt.request.requestId,'04f69643-b23e-4f95-b3f4-87d26b002287');
assert.equal(attempt.before.revision,0);assert.equal(attempt.before.state.counter,0);
assert.equal(originalBuild.apk.sha256,attempt.target.apkSha256);
function absentProcess(pid){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return;throw e;}throw new Error('Original process still exists; reconciliation refused');}
absentProcess(29883);absentProcess(29805);
const adb='/Users/sushantsrikrish/Library/Android/sdk/platform-tools/adb',packageName=attempt.target.packageName;
const calls=[];
const recordRun=async(...args)=>{const r=await runBinary(...args);calls.push({argv:args.slice(0,2),...r,stdout:r.stdout.toString('utf8'),stdoutBase64:r.stdout.toString('base64')});return r;};
const hostProcesses=await recordRun('/bin/ps',['-axo','pid,ppid,lstart,command'],{timeoutMs:5000,maxOutputBytes:4*1024*1024});
assert.equal(hostProcesses.code,0);assert.equal(hostProcesses.timedOut,false);
assert.ok(hostProcesses.stdout.length<4*1024*1024);
const matchingHostProcesses=hostProcesses.stdout.toString().split('\n').filter(line=>{
 const cols=line.trim().split(/\s+/),pid=Number(cols[0]),ppid=Number(cols[1]);
 return pid===29805||pid===29883||ppid===29805||ppid===29883||line.includes(attempt.request.requestId);
});
assert.deepEqual(matchingHostProcesses,[]);
// Keep only the relevant host process lines; unrelated applications are not evidence for this operation.
calls.pop();
const nativeProcesses=await recordRun(adb,['-s',serial,'shell','ps','-A','-o','PID,PPID,ARGS','-w'],{timeoutMs:5000,maxOutputBytes:1024*1024});
assert.equal(nativeProcesses.code,0);assert.equal(nativeProcesses.timedOut,false);
assert.ok(nativeProcesses.stdout.length<1024*1024);
assert.ok(!nativeProcesses.stdout.toString().includes(attempt.request.requestId));
const bridge=createInteractionBridgeBackend({adb,serial,packageName,runBytes:recordRun});
const probes=liveInteractionTargetProbes(adb,t=>bridge.observe(t));
const targetRequest={serial,packageName,expectedApkSha256:attempt.target.apkSha256};
const checked=[];
for(let i=0;i<2;i++){
 const binding=await bindInteractionTarget(targetRequest,probes);
 assert.equal(binding.bindingSha256,attempt.target.bindingSha256);
 const state=await bridge.observe();
 assert.equal(state.generation,attempt.request.expectedGeneration);
 assert.equal(state.pid,attempt.target.pid);assert.equal(state.pidStartTicks,attempt.target.pidStartTicks);
 assert.equal(state.revision,0);assert.deepEqual(state.state,attempt.before.state);
 assert.ok(state.observedAtEpochMs>attempt.request.deadlineEpochMs);
 assert.ok(Math.abs(Date.now()-state.observedAtEpochMs)<3000);
 assert.equal(await bridge.readAck(attempt.request),null);
 const requestPath='files/agentbridge/interaction-v1/'+state.generation+'/inbox/'+attempt.request.requestId+'.json';
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 const script='test ! -e "$1" && test ! -L "$1" && test ! -e "$1.tmp" && test ! -L "$1.tmp" && printf absent';
 const command=['run-as',packageName,'sh','-c',script,'pico-reconcile',requestPath].map(quote).join(' ');
 const paths=await recordRun(adb,['-s',serial,'exec-out',command],{timeoutMs:3000,maxOutputBytes:4096});
 assert.equal(paths.code,0);assert.equal(paths.timedOut,false);assert.equal(paths.stdout.toString(),'absent');
 const dirs=['files/agentbridge/interaction-v1/'+state.generation+'/inbox','files/agentbridge/interaction-v1/'+state.generation+'/acks'];
 const listingCommand=['run-as',packageName,'ls','-la',...dirs].map(quote).join(' ');
 const listing=await recordRun(adb,['-s',serial,'exec-out',listingCommand],{timeoutMs:3000,maxOutputBytes:32768});
 assert.equal(listing.code,0);assert.equal(listing.timedOut,false);
 assert.ok(listing.stdout.length<32768);
 assert.ok(!listing.stdout.toString().includes(attempt.request.requestId));
 checked.push({binding,state,ack:null,requestAndTemporary:'absent'});
}
assert.ok(checked[1].state.observedAtEpochMs>checked[0].state.observedAtEpochMs);
const archivePath=path.join(fenceRoot,'history',key+'-'+token+'.reconciled-owner.json');
assert.ok(!fs.existsSync(archivePath));
const authority=JSON.parse(fs.readFileSync(path.join(ev,'AUTHORITY.json')));
const plan={schemaVersion:1,kind:'one-off-root-reconciliation',at:new Date().toISOString(),authority,
 attemptPath,attemptSha256:sha(attemptBytes),ownerPath,ownerSha256:sha(ownerBytes),ownerPin,historyPath,historySha256:sha(historyBytes),historyPin,
 owner,archivePath,retiredNonce:attempt.request.requestId,resendCount:0,checked,calls,
 sourceBinding:{artifactsPath,artifactsSha256:sha(fs.readFileSync(artifactsPath)),originalBuild,sourceChecks,argument:'Main-looper actions and heartbeats share one generation. panel.show monotonically sets visible and increments revision; no hide/reset route exists. Two advancing post-deadline heartbeats at revision0 establish no semantic effect and no blocked handler.'},
 outcome:'No state transition in the same bound monotonic fixture generation; no published request or ACK; original deadline expired. No action can still apply.',
 drainEvidence:{originalSend:'Returned without timeout. src/util.ts runBinary resolves after child close; exec-out exit code does not establish remote success.',runnerSourceSha256:sha(fs.readFileSync(path.join(root,'src/util.ts'))),script:'Original script contains only foreground commands; no asynchronous or background launch.',matchingHostProcesses,nativeProcessesContainOriginalNonce:false,originalClientAndServerAbsent:true,qualification:'Process absence and elapsed time alone are not the recovery basis; same-generation monotonic state establishes no effect.'},
 limitation:'Specific dedicated fixture only. Normal uncertain-session fence remains fail-closed; no stale owner recovery API added.',
 originalResultDisposition:'Original in_doubt result and journal remain unchanged; separate explicit root resolution.'};
fs.writeFileSync(path.join(ev,'reconciliation-proof.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
fs.writeFileSync(path.join(ev,'held-owner.json'),ownerBytes,{flag:'wx',mode:0o600});
fs.writeFileSync(path.join(ev,'held-history.jsonl'),historyBytes,{flag:'wx',mode:0o600});
for(const f of ['reconciliation-proof.json','held-owner.json','held-history.jsonl'])sync(path.join(ev,f));
sync(ev);
if(process.argv[2]!=='--archive-after-review'){console.log('Read-only reconciliation proof retained; owner remains held.');process.exit(0);}
assert.deepEqual(pin(ownerPath),ownerPin);assert.deepEqual(pin(historyPath),historyPin);
assert.ok(fs.readFileSync(ownerPath).equals(ownerBytes));assert.ok(fs.readFileSync(historyPath).equals(historyBytes));
absentProcess(29883);absentProcess(29805);
assert.ok(Math.abs(Date.now()-checked[1].state.observedAtEpochMs)<3000);
// Host-only hard link gives non-replacing archive semantics; Android hard links are never used here.
fs.linkSync(ownerPath,archivePath);sync(archivePath);sync(path.dirname(archivePath));
assert.ok(fs.readFileSync(archivePath).equals(ownerBytes));
assert.equal(pin(archivePath).ino,ownerPin.ino);assert.equal(pin(archivePath).dev,ownerPin.dev);
assert.deepEqual(pin(ownerPath),ownerPin);assert.deepEqual(pin(historyPath),historyPin);
assert.ok(fs.readFileSync(ownerPath).equals(ownerBytes));assert.ok(fs.readFileSync(historyPath).equals(historyBytes));
assert.ok(Math.abs(Date.now()-checked[1].state.observedAtEpochMs)<3000);
fs.unlinkSync(ownerPath);sync(fenceRoot);
fs.writeFileSync(path.join(ev,'reconciliation-result.json'),JSON.stringify({at:new Date().toISOString(),status:'explicit-root-resolution-and-owner-archived',proof:'reconciliation-proof.json',archivePath,ownerSha256:sha(ownerBytes),retiredNonce:attempt.request.requestId,resendCount:0,originalHistoryUnchanged:fs.readFileSync(historyPath).equals(historyBytes)},null,2)+'\n',{flag:'wx',mode:0o600});
sync(path.join(ev,'reconciliation-result.json'));sync(ev);
console.log('Specific failed publication resolved; original evidence retained and nonce retired.');
