import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {interactionFixture} from './helpers/interaction-fixture.mjs';
const session=await import('../dist/interactionsession.js').catch(()=>({}));
export const scenario={schemaVersion:1,name:'show-fixture-panel',initial:{panelVisible:false,counter:0},
  steps:[{actionId:'panel.show',args:{panelId:'fixture.panel'},expect:{panelVisible:true,counter:1}}],
  limits:{maxSteps:20,timeoutMs:90000,actionTimeoutMs:1000}};

test('finite semantic scenario is implemented',()=>assert.equal(typeof session.runScenario,'function'));
test('scenario asserts independent state, retains source target action and frame evidence',async()=>{
  const f=await interactionFixture();
  const r=await session.runScenario(scenario,f.target,f.dependencies);
  assert.equal(r.status,'completed');assert.equal(r.actions.length,1);assert.equal(r.actions[0].status,'completed');
  assert.equal(r.lookPending,true);assert.equal(r.humanInputVerified,false);
  assert.equal(r.target.serial,'emulator-5678');assert.ok(fs.existsSync(r.recordPath));
  assert.equal(r.requestedTimeoutMs,90000);
});
test('scenario initial mismatch, invalid bound, or unapproved reset refuses without dispatch',async()=>{
  for(const bad of [{...scenario,initial:{panelVisible:true,counter:1}},
    {...scenario,limits:{...scenario.limits,maxSteps:21}},{...scenario,reset:true}]){
    const f=await interactionFixture();const r=await session.runScenario(bad,f.target,f.dependencies);
    assert.equal(r.status,'refused');assert.equal(f.counts().sends,0);
  }
});
test('explicit capture settling consumes the same deadline and never claims rendered correctness',async()=>{
  const f=await interactionFixture(),start=f.now();
  const r=await session.runScenario({...scenario,limits:{...scenario.limits,actionTimeoutMs:5000,captureSettleMs:2000}},f.target,f.dependencies);
  assert.equal(r.status,'completed');assert.equal(r.actions[0].captureSettleMs,2000);
  assert.equal(r.actions[0].captureSettleMeasuredMs,2000);
  assert.ok(Date.parse(r.actions[0].captureRequestedAt)>=start+2000);
  assert.ok(f.now()-start>=2000);assert.equal(f.counts().sends,1);assert.equal(f.counts().captures,1);
  assert.equal(r.lookPending,true);assert.equal(r.evidenceCeiling,'structural');
});
test('settle bounds refuse before send; cancellation or deadline during settle sends once and never captures',async()=>{
  for(const captureSettleMs of [-1,3001,1.5,1000]){
    const f=await interactionFixture();const r=await session.runScenario({...scenario,limits:{...scenario.limits,captureSettleMs}},f.target,f.dependencies);
    assert.ok(['refused','failed'].includes(r.status));assert.equal(f.counts().sends,0);
  }
  for(const cancelled of [false,true]){
    const f=await interactionFixture(),controller=new AbortController(),sleep=f.dependencies.sleep;
    f.dependencies.signal=controller.signal;
    f.dependencies.sleep=async ms=>{await sleep(ms);if(cancelled)controller.abort();else await sleep(100);};
    const r=await session.runScenario({...scenario,limits:{...scenario.limits,actionTimeoutMs:250,captureSettleMs:200}},f.target,f.dependencies);
    assert.equal(r.status,'in_doubt');assert.equal(f.counts().sends,1);assert.equal(f.counts().captures,0);
    assert.equal(f.dependencies.fence.state,'in_doubt');assert.ok(r.actions[0].acknowledgement);
  }
});
test('settling rejects target/state drift and a frame acquired before the post-wait request',async()=>{
  for(const mode of ['target','state','old-frame']){
    const f=await interactionFixture(),sleep=f.dependencies.sleep,capture=f.dependencies.capture,start=f.now();
    f.dependencies.sleep=async ms=>{await sleep(ms);if(mode==='target')f.identity.pid++;if(mode==='state'){f.state.revision++;f.state.state.counter++;}};
    if(mode==='old-frame')f.dependencies.capture=async(...args)=>({...await capture(...args),capturedAt:new Date(start+1).toISOString()});
    const r=await session.runScenario({...scenario,limits:{...scenario.limits,captureSettleMs:200}},f.target,f.dependencies);
    assert.equal(f.counts().sends,1);
    if(mode==='old-frame'){assert.equal(r.status,'failed');assert.equal(r.actions[0].status,'completed');assert.equal(r.actions[0].evidence.status,'failed');}
    else {assert.equal(r.status,'in_doubt');assert.equal(f.counts().captures,0);}
  }
});
test('slow preflight refuses before send when the requested settle interval no longer fits',async()=>{
  const f=await interactionFixture(),observe=f.dependencies.bridge.observe;
  f.dependencies.bridge.observe=async()=>{await f.dependencies.sleep(600);return observe();};
  const r=await session.runScenario({...scenario,limits:{...scenario.limits,captureSettleMs:500}},f.target,f.dependencies);
  assert.equal(r.status,'failed');assert.match(r.reason,/settle cannot fit/);
  assert.equal(f.counts().sends,0);assert.equal(f.counts().captures,0);assert.equal(f.dependencies.fence.state,'idle');
});
test('uncertain action stops scenario before the second action and never retries',async()=>{
  const f=await interactionFixture({lostAck:true});
  const r=await session.runScenario({...scenario,steps:[...scenario.steps,...scenario.steps]},f.target,f.dependencies);
  assert.equal(r.status,'in_doubt');assert.equal(f.counts().sends,1);assert.equal(r.actions.length,1);
});
test('assertion and capture failure stop the scenario without erasing completed action',async()=>{
  for(const options of [{captureError:true},{}]){
    const f=await interactionFixture(options);
    const s=options.captureError?scenario:{...scenario,steps:[{...scenario.steps[0],expect:{panelVisible:true,counter:2}}]};
    const r=await session.runScenario(s,f.target,f.dependencies);
    assert.equal(r.status,'failed');assert.equal(r.actions[0].status,'completed');assert.equal(f.counts().sends,1);
  }
});
test('failed build cannot deploy a previously successful artifact; incomplete closure refuses before build',async()=>{
  for(const badClosure of [false,true]){
    const events=[];
    const deps={now:()=>Date.now(),snapshot:async()=>({sha256:'a'.repeat(64),complete:!badClosure}),
      build:async()=>{events.push('build');return {status:'failed',reason:'compiler error'};},
      deploy:async()=>{events.push('deploy');},reconnect:async()=>{events.push('reconnect');},replay:async()=>{events.push('replay');}};
    const f=await interactionFixture();
    const result=await session.iterateOnce({allowRelaunch:true},f.target,deps,path.join(f.root,'iteration'));
    assert.equal(result.status,badClosure?'refused':'failed');
    assert.deepEqual(events,badClosure?[]:['build']);assert.ok(fs.existsSync(result.recordPath));
  }
});
test('source moving during build refuses deploy; cancellation after build leaves no native calls',async()=>{
  for(const cancel of [false,true]){
    const f=await interactionFixture(), events=[],c=new AbortController();let reads=0;
    const deps={now:()=>Date.now(),snapshot:async()=>({sha256:++reads===1||cancel?'a'.repeat(64):'b'.repeat(64),complete:true}),
      build:async()=>{if(cancel)c.abort();return {status:'built',apkPath:'/new.apk',apkSha256:'b'.repeat(64),inputSha256:'a'.repeat(64)};},
      deploy:async()=>events.push('deploy'),reconnect:async()=>events.push('reconnect'),replay:async()=>events.push('replay'),signal:c.signal};
    const r=await session.iterateOnce({allowRelaunch:true},f.target,deps,path.join(f.root,'iteration'));
    assert.ok(['refused','failed'].includes(r.status));assert.deepEqual(events,[]);
  }
});
test('cancellation during the final source snapshot cannot cross into deploy',async()=>{
  const f=await interactionFixture(), c=new AbortController();let snapshots=0,deploys=0;
  const deps={now:()=>Date.now(),signal:c.signal,snapshot:async()=>{
    if(++snapshots===2)c.abort();return {sha256:'a'.repeat(64),complete:true};},
    build:async()=>({status:'built',apkPath:'/new.apk',apkSha256:'b'.repeat(64),inputSha256:'a'.repeat(64)}),
    deploy:async()=>{deploys++;},reconnect:async()=>{},replay:async()=>{}};
  const r=await session.iterateOnce({allowRelaunch:true},f.target,deps,path.join(f.root,'iteration'));
  assert.equal(deploys,0);assert.equal(r.status,'refused');
});
test('bounded watch coalesces identical source snapshots and ignores generated-output changes',async()=>{
  const events=[], snapshots=['a','a','b','b','b','c'];let now=0;
  const r=await session.watchIterations({maxCycles:2,maxWallTimeMs:1000,pollMs:10}, {
    now:()=>now,sleep:async ms=>{now+=ms;},sourceDigest:async()=>snapshots.shift()??'c',
    iterate:async()=>{events.push('build');return {status:'completed'};},
  });
  assert.equal(r.cycles.length,2);assert.deepEqual(events,['build','build']);
});
test('watch rechecks cancellation/time after snapshot and passes its remaining budget to the owned cycle',async()=>{
  for(const cancel of [false,true]) {
    let now=0,reads=0,cycles=0;const controller=new AbortController();
    const r=await session.watchIterations({maxCycles:1,maxWallTimeMs:10,pollMs:1},{now:()=>now,sleep:async ms=>{now+=ms;},signal:controller.signal,
      sourceDigest:async()=>{if(++reads===2){if(cancel)controller.abort();else now=11;}return 'same';},iterate:async()=>{cycles++;return {status:'completed'};}});
    assert.equal(cycles,0);assert.equal(r.cycles.length,0);
  }
  let sawAbort=false;
  const r=await session.watchIterations({maxCycles:1,maxWallTimeMs:30,pollMs:1},{now:()=>Date.now(),sleep:async ms=>new Promise(r=>setTimeout(r,ms)),
    sourceDigest:async()=> 'same',iterate:async budget=>{
      assert.ok(budget.deadlineEpochMs>Date.now());
      await new Promise(resolve=>budget.signal.addEventListener('abort',()=>{sawAbort=true;resolve();},{once:true}));return {status:'failed'};
    }});
  assert.equal(sawAbort,true);assert.equal(r.cancelled,true);
});
