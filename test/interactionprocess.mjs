import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runPicoCliCommand} from '../dist/picocli.js';
test('pre-cancelled rebuild runner spawns no child',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pico-cancel-')), marker=path.join(root,'spawned');
  const c=new AbortController();c.abort();
  const r=await runPicoCliCommand(process.execPath,['-e',`require('fs').writeFileSync(process.argv[1],'spawned')`,marker],{signal:c.signal,timeoutMs:5000});
  assert.equal(fs.existsSync(marker),false);assert.equal(r.cancelled,true);assert.equal(r.code,null);
});
test('cancellation drains the owned child group; it is distinct from timeout',async()=>{
  const c=new AbortController();const start=Date.now();
  const promise=runPicoCliCommand(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{signal:c.signal,timeoutMs:5000,killGraceMs:20});
  const timer=setTimeout(()=>c.abort(),100);
  const r=await promise;clearTimeout(timer);
  assert.equal(r.cancelled,true);assert.equal(r.timedOut,false);assert.equal(r.code,null);
  assert.ok(Date.now()-start<2000);
});
