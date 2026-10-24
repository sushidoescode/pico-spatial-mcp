import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {prepareIterationDeployment} from '../dist/iterationcli.js';
const identity={version:'0.6.1',executablePath:'/fixture/pico-cli',packageJsonSha256:'a'.repeat(64),executionTreeSha256:'b'.repeat(64),selectionSchemaVersion:1,selectionSha256:'c'.repeat(64)};
async function driver(onCommand=()=>{},helpChange=text=>text) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'iteration-cli-')),commands=[];
  const apkPath=path.join(root,'fixture.apk');fs.writeFileSync(apkPath,'fixture APK bytes');
  const dependencies={cachedTarget:async()=>({cli:{path:'/fixture/pico-cli'},identity}),identity:()=>identity,
    run:async(cli,argv,options)=>{
      if(options.beforeSpawn?.(Date.now()+1000))throw new Error('ownership changed before spawn');
      commands.push(argv);onCommand(argv);
      const isHelp=argv.at(-1)==='--help';
      const stdout=isHelp?helpChange(fs.readFileSync(new URL(`./fixtures/picocli/help/0.6.1/app-${argv[1]}-help-pipe.stdout.txt`,import.meta.url),'utf8')):'ok';
      const stderr=isHelp?fs.readFileSync(new URL(`./fixtures/picocli/help/0.6.1/app-${argv[1]}-help-pipe.stderr.txt`,import.meta.url),'utf8'):'';
      const spawnError=options.afterCompletion?.(Date.now()+1000);
      return {code:spawnError?null:0,stdout,stderr,timedOut:false,outputTruncated:false,signal:null,...(spawnError?{spawnError}:{})};
    }};
  const prepared=await prepareIterationDeployment({evidenceRoot:root,deadlineEpochMs:Date.now()+30_000},dependencies);
  return {prepared,commands,build:{apkPath,apkSha256:crypto.createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex')}};
}
test('exact colored CLI leaf help admits supported lifecycle arguments and every command uses explicit target',async()=>{
  const d=await driver();let fenceChecks=0;
  await d.prepared.deploy({serial:'emulator-5678',packageName:'com.example.fixture.debug'},d.build,async()=>{},()=>{fenceChecks++;});
  assert.deepEqual(d.commands.slice(3).map(a=>a.slice(0,2)),[['app','stop'],['app','install'],['app','launch']]);
  for(const command of d.commands.slice(3))assert.equal(command[command.indexOf('--device')+1],'emulator-5678');
  assert.ok(fenceChecks>=9);
});
test('ownership changes after first mutation refuse every subsequent command',async()=>{
  let owned=true;
  const d=await driver(argv=>{if(argv[1]==='stop'&&argv.at(-1)!=='--help')owned=false;});
  await assert.rejects(()=>d.prepared.deploy({serial:'emulator-5678',packageName:'com.example.fixture.debug'},d.build,async()=>{},()=>{if(!owned)throw new Error('fence owner changed');}),/owner|command/);
  assert.deepEqual(d.commands.slice(3).map(a=>a[1]),['stop']);
});
test('incomplete zero-exit lifecycle help refuses before any mutation',async()=>{
  await assert.rejects(()=>driver(()=>{},text=>text.slice(0,200)),/contract unavailable/);
});
