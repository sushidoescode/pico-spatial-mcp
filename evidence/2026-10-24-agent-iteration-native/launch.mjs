import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {acquireInteractionFence} from '../../dist/interactionfence.js';
import {inspectPicoCliCached,picoCliFromEnsure,picoCliExecutionIdentity,runPicoCli} from '../../dist/picocli.js';
import {sameCliCapabilityIdentity} from '../../dist/clicapabilities.js';
const ev=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(ev,'../..');
const serial='emulator-5554',packageName='com.example.picofixture.iteration.debug';
const expectedBoot=fs.readFileSync(path.join(ev,'boot-id.stdout.txt'),'utf8').trim();
if(!/^[a-f0-9-]{36}$/.test(expectedBoot))throw new Error('recorded boot required');
const artifacts=JSON.parse(fs.readFileSync(path.join(root,'evidence/2026-10-23-agent-iteration/ARTIFACTS.json'),'utf8'));
const apk=artifacts.hostRebuilds[1].apk,apkPath=path.resolve(root,apk.path);
const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex');
if(digest()!==apk.sha256)throw new Error('retained APK changed');
const inspected=await inspectPicoCliCached(),cli=picoCliFromEnsure(inspected);
if(!cli)throw new Error('existing CLI unavailable');
const identity=()=>picoCliExecutionIdentity(cli,{env:process.env,platform:process.platform,homeDir:os.homedir(),cwd:root});
const selected=identity();if(!selected)throw new Error('CLI identity unavailable');
const fence=acquireInteractionFence(path.join(os.homedir(),'.pico-mcp/interaction-fences'),serial);
let seq=0,mutating=false;
const run=async(argv,mutation=false)=>{
 fence.assertOwned();if(!sameCliCapabilityIdentity(selected,identity()))throw new Error('CLI identity drift');
 if(mutation&&digest()!==apk.sha256)throw new Error('APK drift');
 const guard=()=>{try{fence.assertOwned();return null;}catch(e){return String(e);}};
 const result=await runPicoCli(cli,argv,{cwd:root,timeoutMs:120000,maxOutputBytes:1024*1024,beforeSpawn:guard,afterCompletion:guard});
 const file=path.join(ev,'launch-'+String(++seq).padStart(2,'0')+'.json');
 fs.writeFileSync(file,JSON.stringify({argv,serial,expectedBoot,cliIdentity:selected,mutation,...result},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({argv,code:result.code,stdout:result.stdout,stderr:result.stderr,record:file}));
 if(result.code!==0||result.timedOut||result.cancelled||result.spawnError||result.outputTruncated)throw new Error('CLI operation failed/incomplete: '+file);
 return result.stdout.trim();
};
try {
 const installed=(await run(['shell','--device',serial,'pm','path',packageName])).replace(/^package:/,'');
 if(!/^\/[A-Za-z0-9_./=+@~-]+\.apk$/.test(installed))throw new Error('single installed APK path required');
 const remoteHash=(await run(['shell','--device',serial,'sha256sum',installed])).split(/\s+/)[0];
 if(remoteHash!==apk.sha256)throw new Error('installed APK differs from retained source-bound APK');
 for(const argv of [['app','launch',packageName,'--device',serial]]) {
  if(await run(['shell','--device',serial,'cat','/proc/sys/kernel/random/boot_id'])!==expectedBoot)throw new Error('boot changed');
  if(await run(['shell','--device',serial,'getprop','ro.boot.qemu'])!=='1')throw new Error('not emulator');
  fence.begin(argv[1]);mutating=true;await run(argv,true);fence.end();mutating=false;
 }
 fence.stop();fence.release();
 fs.writeFileSync(path.join(ev,'launch-result.json'),JSON.stringify({status:'installed-and-launched',serial,expectedBoot,packageName,apkSha256:apk.sha256,rootAuthority:'AUTHORITY.json',fenceScope:fence.enforcementScope,ownedExecution:'drained-and-released',readyBridgeClaim:false},null,2)+'\n',{flag:'wx'});
} catch(e) {
 if(mutating)fence.hold(String(e));else if(fence.state==='idle'){fence.stop();fence.release();}
 console.error(String(e));process.exitCode=1;
}
