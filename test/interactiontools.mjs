import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {interactionFixture} from './helpers/interaction-fixture.mjs';
const api=await import('../dist/interactiontools.js').catch(()=>({}));
test('ordinary MCP interaction service is implemented',()=>assert.equal(typeof api.createInteractionService,'function'));
test('offline describe does not resolve a target or CLI; physical target refused before connect',async()=>{
  let calls=0;
  const service=api.createInteractionService({connect:async()=>{calls++;throw new Error('offline');}});
  const described=await service.call({action:'describe'});
  assert.equal(described.status,'available');assert.equal(described.lookPending,true);assert.equal(calls,0);
  await assert.rejects(()=>service.call({action:'open',serial:'physical-pico',packageName:'com.example.fixture',expectedApkSha256:'a'.repeat(64)}));
  assert.equal(calls,0);
});
test('public observe/action result delivers structured text, image and exact record link; stop releases only session',async()=>{
  const f=await interactionFixture();f.dependencies.fence.stop();f.dependencies.fence.release();
  const service=api.createInteractionService({evidenceRoot:path.join(f.root,'public'),fenceRoot:path.join(f.root,'fences'),
    now:f.now,sleep:f.dependencies.sleep,connect:async()=>f.dependencies});
  const opened=await service.call({action:'open',serial:f.target.serial,packageName:f.target.packageName,expectedApkSha256:f.target.apkSha256});
  const observed=await service.call({action:'observe',sessionId:opened.sessionId});
  assert.equal(observed.state.revision,0);
  const action=await service.call({action:'act',sessionId:opened.sessionId,request:f.request()});
  const content=api.interactionToolResult(action);
  assert.equal(content.isError,undefined);assert.ok(content.content.some(c=>c.type==='image'));
  assert.ok(content.content.some(c=>c.type==='resource_link'));assert.equal(content.structuredContent.lookPending,true);
  assert.ok(fs.existsSync(action.recordPath));assert.equal(f.counts().sends,1);
  const stopped=await service.call({action:'stop',sessionId:opened.sessionId});
  assert.equal(stopped.status,'stopped');assert.equal(stopped.appStopped,false);
  await assert.rejects(()=>service.call({action:'observe',sessionId:opened.sessionId}),/unknown|stopped/);
});
test('public uncertainty propagates isError and cannot be cleared by stop or retry',async()=>{
  const f=await interactionFixture({lostAck:true});f.dependencies.fence.stop();f.dependencies.fence.release();
  const service=api.createInteractionService({evidenceRoot:path.join(f.root,'public'),fenceRoot:path.join(f.root,'fences'),now:f.now,sleep:f.dependencies.sleep,connect:async()=>f.dependencies});
  const opened=await service.call({action:'open',serial:f.target.serial,packageName:f.target.packageName,expectedApkSha256:f.target.apkSha256});
  const action=await service.call({action:'act',sessionId:opened.sessionId,request:f.request()});
  assert.equal(action.status,'in_doubt');assert.equal(api.interactionToolResult(action).isError,true);
  await assert.rejects(()=>service.call({action:'stop',sessionId:opened.sessionId}),/doubt|drain/);
  const second=await service.call({action:'act',sessionId:opened.sessionId,request:f.request()});
  assert.equal(second.status,'refused');assert.equal(f.counts().sends,1);
});
test('MCP delivery never reuses changed capture bytes',async()=>{
  const f=await interactionFixture();
  const {dispatchInteraction}=await import('../dist/semanticinteraction.js');
  const action=await dispatchInteraction(f.target,f.request(),f.dependencies);
  fs.appendFileSync(action.evidence.path,'changed');
  const delivered=api.interactionToolResult(action);
  assert.equal(delivered.isError,true);assert.equal(delivered.structuredContent.status,'completed');
  assert.equal(delivered.structuredContent.attempted,true);assert.equal(delivered.structuredContent.recordPath,action.recordPath);
  assert.equal(delivered.structuredContent.delivery.status,'failed');assert.equal(delivered.content.some(c=>c.type==='image'),false);
});
test('public host fixture completes observe/action/build/reconnect/replay with a new source-bound APK identity',async()=>{
  const f=await interactionFixture({packageName:'com.example.picofixture.iteration.debug'});f.dependencies.fence.stop();f.dependencies.fence.release();
  const {collectFixtureInputs}=await import('../dist/fixturebuild.js');
  const projectDir=fileURLToPath(new URL('../examples/agent-iteration-fixture/',import.meta.url));
  const events=[];
  const service=api.createInteractionService({evidenceRoot:path.join(f.root,'public'),fenceRoot:path.join(f.root,'fences'),now:f.now,sleep:f.dependencies.sleep,
    connect:async()=>({...f.dependencies,checkBoot:async target=>assert.equal(target.serial,'emulator-5678')}),
    build:async()=>{events.push('build');return {status:'built',apkPath:'/fixture/new.apk',apkSha256:'b'.repeat(64),inputSha256:collectFixtureInputs(projectDir).sha256};},
    prepareDeployment:async()=>({identity:{},evidenceDirectory:f.root,deploy:async(target,build,checkBoot,checkFence)=>{
      checkFence();await checkBoot();events.push('deploy');
      f.identity.apkSha256=build.apkSha256;f.identity.pid++;f.identity.appGeneration=crypto.randomUUID();
      Object.assign(f.state,{generation:f.identity.appGeneration,pid:f.identity.pid,revision:0});
      f.state.state={panel:{id:'fixture.panel',visible:false},counter:0};
    }})});
  const opened=await service.call({action:'open',serial:f.target.serial,packageName:f.target.packageName,expectedApkSha256:f.target.apkSha256});
  const first=await service.call({action:'act',sessionId:opened.sessionId,request:f.request()});assert.equal(first.status,'completed');
  const scenario=JSON.parse(fs.readFileSync(path.join(projectDir,'scenario.json'),'utf8'));
  const replay=await service.call({action:'iterate',sessionId:opened.sessionId,projectDir,allowRelaunch:true,scenario,maxWallTimeMs:60000});
  assert.equal(replay.status,'completed',replay.reason);assert.deepEqual(events,['build','deploy']);
  assert.equal(replay.target.apkSha256,'b'.repeat(64));assert.notEqual(replay.target.appGeneration,f.target.appGeneration);
  assert.equal(replay.replay.actions[0].after.state.counter,1);assert.equal(f.counts().sends,2);
  assert.equal(replay.lookPending,true);assert.equal(replay.replay.humanInputVerified,false);
  assert.equal(api.interactionToolResult(replay).content.some(c=>c.type==='image'),true);
  await service.call({action:'stop',sessionId:opened.sessionId});
});
