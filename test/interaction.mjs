import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { interactionFixture } from './helpers/interaction-fixture.mjs';
const implementation=await import('../dist/semanticinteraction.js').catch(()=>({}));

test('semantic interaction transaction is implemented',()=>assert.equal(typeof implementation.dispatchInteraction,'function'));
test('acknowledged panel action has independent readback and fresh retained PNG, LOOK remains pending',async()=>{
  const f=await interactionFixture();
  const result=await implementation.dispatchInteraction(f.target,f.request(),f.dependencies);
  assert.equal(result.status,'completed');
  assert.equal(result.before.state.panel.visible,false);
  assert.equal(result.after.state.panel.visible,true);
  assert.equal(result.after.state.counter,1);
  assert.equal(result.evidence.status,'captured');
  assert.equal(result.lookPending,true);
  assert.ok(fs.existsSync(result.evidence.path));
  assert.equal(f.counts().sends,1);
  assert.equal(f.counts().captures,1);
  assert.equal(f.dependencies.fence.state,'idle');
});
test('invalid action, expired deadline, stale revision and target drift send nothing',async()=>{
  for(const kind of ['invalid','deadline','revision','target']){
    const f=await interactionFixture(); const req=f.request();
    if(kind==='invalid') req.actionId='shell.exec';
    if(kind==='deadline') req.deadlineEpochMs=f.now()-1;
    if(kind==='revision') req.expectedRevision=999;
    if(kind==='target') f.identity.pid++;
    const r=await implementation.dispatchInteraction(f.target,req,f.dependencies);
    assert.ok(['refused','timed_out'].includes(r.status));
    assert.equal(f.counts().sends,0);
  }
});
test('lost ACK, accepted without completion, transport failure and post-send interference retain uncertainty without retry',async()=>{
  for(const options of [{lostAck:true},{acceptOnly:true},{sendError:true},{interfereAfterSend:true}]){
    const f=await interactionFixture(options), req=f.request();
    const result=await implementation.dispatchInteraction(f.target,req,f.dependencies);
    assert.equal(result.status,'in_doubt');
    assert.equal(f.counts().sends,1);
    assert.equal(f.counts().captures,0);
    assert.equal(f.dependencies.fence.state,'in_doubt');
    await implementation.dispatchInteraction(f.target,req,f.dependencies);
    await implementation.dispatchInteraction(f.target,f.request(),f.dependencies);
    assert.equal(f.counts().sends,1);
  }
});
test('completed request ID cannot be replayed, even if expected revision is changed',async()=>{
  const f=await interactionFixture(), req=f.request();
  assert.equal((await implementation.dispatchInteraction(f.target,req,f.dependencies)).status,'completed');
  req.expectedRevision=1;
  assert.equal((await implementation.dispatchInteraction(f.target,req,f.dependencies)).status,'refused');
  assert.equal(f.counts().sends,1);
});
test('a distinct request to an already visible panel is idempotent',async()=>{
  const f=await interactionFixture();
  await implementation.dispatchInteraction(f.target,f.request(),f.dependencies);
  const next=await implementation.dispatchInteraction(f.target,f.request(),f.dependencies);
  assert.equal(next.status,'completed');assert.equal(next.after.state.counter,1);
  assert.equal(f.counts().sends,2);
});
test('external semantic mutation during capture is detected, not claimed prevented',async()=>{
  const f=await interactionFixture(), capture=f.dependencies.capture;
  f.dependencies.capture=async t=>{const frame=await capture(t);f.state.revision++;f.state.state.counter++;return frame;};
  const r=await implementation.dispatchInteraction(f.target,f.request(),f.dependencies);
  assert.equal(r.status,'in_doubt');assert.match(r.reason,/external/);
  assert.equal(f.dependencies.fence.state,'in_doubt');
});
test('stale state and stale ACK timestamps cannot authorize or complete a transaction',async()=>{
  const f=await interactionFixture(), observe=f.dependencies.bridge.observe;
  f.dependencies.bridge.observe=async()=>({...await observe(),observedAtEpochMs:f.now()-5000});
  assert.equal((await implementation.dispatchInteraction(f.target,f.request(),f.dependencies)).status,'refused');
  assert.equal(f.counts().sends,0);
  const g=await interactionFixture(), read=g.dependencies.bridge.readAck;
  g.dependencies.bridge.readAck=async r=>({...await read(r),acknowledgedAtEpochMs:g.now()-5000});
  assert.equal((await implementation.dispatchInteraction(g.target,g.request(),g.dependencies)).status,'in_doubt');
  assert.equal(g.counts().sends,1);
});
test('capture failure and stale timestamp do not erase completed semantics or manufacture visual proof',async()=>{
  for(const options of [{captureError:true},{staleCapture:true}]){
    const f=await interactionFixture(options);
    const result=await implementation.dispatchInteraction(f.target,f.request(),f.dependencies);
    assert.equal(result.status,'completed');
    assert.equal(result.evidence.status,'failed');
    assert.equal(result.lookPending,true);
    assert.equal(f.counts().sends,1);
  }
});
test('cancellation before dispatch sends nothing; cancellation after a possible mutation remains held',async()=>{
  const f=await interactionFixture(), controller=new AbortController();
  controller.abort();
  const r=await implementation.dispatchInteraction(f.target,f.request(),{...f.dependencies,signal:controller.signal});
  assert.equal(r.status,'refused');assert.equal(f.counts().sends,0);
  const g=await interactionFixture(), c=new AbortController(), send=g.dependencies.bridge.send;
  g.dependencies.bridge.send=async r=>{await send(r);c.abort();};
  const after=await implementation.dispatchInteraction(g.target,g.request(),{...g.dependencies,signal:c.signal});
  assert.equal(after.status,'in_doubt');assert.equal(g.counts().sends,1);
});
