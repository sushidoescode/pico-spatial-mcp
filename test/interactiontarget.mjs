import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const target = await import('../dist/interactiontarget.js').catch(() => ({}));
const fence = await import('../dist/interactionfence.js').catch(() => ({}));
const serial = 'emulator-5678';
const packageName = 'com.example.picofixture.iteration';
const apkSha256 = 'a'.repeat(64);
const identity = () => ({serial, packageName, model:'PICO Emulator', fingerprint:'pico/sdk/6.1', bootQemu:'1',
  bootId:'d2f1cb1e-942a-4001-8f7c-4d4aa2497fb0', apkSha256, pid:1234, pidStartTicks:'4422',
  appGeneration:'de053dc0-2f5f-4ee9-9ac1-9e4eeb4ca6d9'});
const request = () => ({serial, packageName, expectedApkSha256:apkSha256});

test('explicit emulator target binding is implemented', () => {
  assert.equal(typeof target.bindInteractionTarget, 'function');
  assert.equal(typeof target.revalidateInteractionTarget, 'function');
});
test('missing or physical serial refuses before any probe; two devices never choose for caller', async () => {
  let calls = 0;
  const probes={listOnlineSerials:async()=>{calls++; return [serial,'physical-pico'];},probe:async()=>{calls++;return identity();}};
  for (const value of ['',undefined,'physical-pico']) {
    await assert.rejects(()=>target.bindInteractionTarget({...request(),serial:value},probes));
  }
  assert.equal(calls,0);
  const bound=await target.bindInteractionTarget(request(),probes);
  assert.equal(bound.serial,serial);
  assert.equal(bound.enforcementScope,'interaction-session-only');
});
test('offline, wrong family, APK mismatch and incomplete identity fail closed', async () => {
  const probes={listOnlineSerials:async()=>[serial],probe:async()=>identity()};
  await assert.rejects(()=>target.bindInteractionTarget(request(),{...probes,listOnlineSerials:async()=>['physical-pico']}));
  for (const change of [{bootQemu:'0'}, {apkSha256:'b'.repeat(64)}, {pid:null}, {pidStartTicks:''}, {bootId:''}, {appGeneration:''}]) {
    await assert.rejects(()=>target.bindInteractionTarget(request(),{...probes,probe:async()=>({...identity(),...change})}));
  }
});
test('boot, APK, process, generation and emulator drift invalidate the same serial', async () => {
  const probes={listOnlineSerials:async()=>[serial],probe:async()=>identity()};
  const bound=await target.bindInteractionTarget(request(),probes);
  for (const change of [{bootId:'8c0a4bc1-c874-4bd4-a36e-fd5e126ed624'}, {apkSha256:'b'.repeat(64)}, {pid:5678},
    {pidStartTicks:'4423'}, {appGeneration:'4021d852-f036-4413-b99b-cbd0368a0d9b'}, {fingerprint:'other/runtime'}]) {
    await assert.rejects(()=>target.revalidateInteractionTarget(bound,{...probes,probe:async()=>({...identity(),...change})}));
  }
  await target.revalidateInteractionTarget(bound,probes);
});
test('durable target fence excludes competing callers, requires drain and never steals an old owner', () => {
  assert.equal(typeof fence.acquireInteractionFence,'function');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'interaction-fence-'));
  const owner=fence.acquireInteractionFence(root,serial);
  assert.equal(owner.enforcementScope,'interaction-session-only');
  assert.throws(()=>fence.acquireInteractionFence(root,serial),/owned|busy/);
  const other=fence.acquireInteractionFence(root,'emulator-5679');
  other.stop(); other.release();
  owner.begin('observe');
  assert.throws(()=>owner.begin('action'),/busy|flight/);
  assert.throws(()=>owner.release(),/stop|drain/);
  owner.end(); owner.stop(); owner.release();
  assert.throws(()=>owner.begin('action'),/released|stopped/);
  const successor=fence.acquireInteractionFence(root,serial);
  successor.begin('action'); successor.hold('possible mutation; acknowledgement lost');
  assert.throws(()=>successor.stop(),/doubt|uncertain/);
  assert.throws(()=>successor.release(),/stop|doubt|drain/);
  assert.throws(()=>fence.acquireInteractionFence(root,serial),/owned|busy/);
  assert.ok(fs.readdirSync(path.join(root, 'history')).length >= 2,'durable owner history retained');
});
test('modified fence owner is detected, never treated as prevented external interference', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'interaction-tamper-'));
  const owner=fence.acquireInteractionFence(root,serial);
  const record=JSON.parse(fs.readFileSync(owner.recordPath,'utf8'));
  fs.writeFileSync(owner.recordPath,JSON.stringify({...record,token:'other'}));
  assert.throws(()=>owner.begin('action'),/owner|fence|changed/);
  assert.equal(owner.enforcementScope,'interaction-session-only');
});
test('target deadline and cancellation are rechecked after each awaited probe',async()=>{
  for(const abort of [false,true]) {
    let now=0,probed=0;const controller=new AbortController();
    const probes={listOnlineSerials:async budget=>{assert.equal(budget.deadlineEpochMs,10);if(abort)controller.abort();else now=11;return [serial];},probe:async()=>{probed++;return identity();}};
    await assert.rejects(()=>target.bindInteractionTarget(request(),probes,{deadlineEpochMs:10,signal:controller.signal,now:()=>now}),/cancelled|deadline/);
    assert.equal(probed,0);
  }
});
