import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {interactionFixture} from './helpers/interaction-fixture.mjs';
import {createInteractionService,registerInteractionSessionTools} from '../dist/interactiontools.js';
const root=fileURLToPath(new URL('..',import.meta.url));
test('host trial runner bounds and owns ordinary child-process cleanup', {skip:process.platform==='win32'?'POSIX cleanup lane; Windows not exercised':false},t=>{
  const result=spawnSync('python3',[path.join(root,'test/host-conformance-process.py')],{
    cwd:root,env:{...process.env,PICO_ADB:'/fixture/no/such/adb',PYTHONDONTWRITEBYTECODE:'1'},
    encoding:'utf8',timeout:15_000,maxBuffer:1024*1024,
  });
  if(result.error?.code==='ENOENT'){t.skip('python3 unavailable; process cleanup not exercised');return;}
  assert.equal(result.error,undefined,String(result.error));
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
});
test('actual candidate stdio discovery preserves default surface and opt-in tool is offline/pure',async()=>{
  for(const enabled of [false,true]) {
    const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js')],cwd:root,
      env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',PICO_ADB:'/fixture/no/such/adb',PICO_MCP_CLI_POLICY:'disabled',PICO_MCP_SURFACE:'doors',PICO_MCP_INTERACTION:enabled?'1':'0'},stderr:'pipe'});
    const client=new Client({name:'generic-mcp-fixture',version:'1.0.0'});
    try {
      await client.connect(transport);const listed=await client.listTools();
      assert.equal(listed.tools.length,enabled?19:18);
      assert.equal(listed.tools.some(t=>t.name==='pico_interaction'),enabled);
      if(enabled) {
        const result=await client.callTool({name:'pico_interaction',arguments:{action:'describe'}});
        assert.equal(result.isError,undefined);assert.equal(result.structuredContent.offlineDiscovery,true);
        assert.equal(result.structuredContent.humanInputVerified,false);
        const refusal=await client.callTool({name:'pico_interaction',arguments:{action:'open',serial:'physical-pico',packageName:'com.example.fixture',expectedApkSha256:'a'.repeat(64)}});
        assert.equal(refusal.isError,true);
      }
    } finally {await client.close();await transport.close();}
  }
});
test('ordinary MCP transfers image/text/resource and cancellation without host-specific backend logic',async()=>{
  const f=await interactionFixture();f.dependencies.fence.stop();f.dependencies.fence.release();
  const service=createInteractionService({evidenceRoot:path.join(f.root,'public'),fenceRoot:path.join(f.root,'fences'),now:f.now,sleep:f.dependencies.sleep,connect:async()=>f.dependencies});
  const server=new McpServer({name:'semantic-protocol-fixture',version:'1.0.0'});registerInteractionSessionTools(server,service);
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);
  const client=new Client({name:'generic-mcp-fixture',version:'1.0.0'});await client.connect(ct);
  try {
    const opened=await client.callTool({name:'pico_interaction',arguments:{action:'open',serial:f.target.serial,packageName:f.target.packageName,expectedApkSha256:f.target.apkSha256}});
    const sessionId=opened.structuredContent.sessionId;
    const r=await client.callTool({name:'pico_interaction',arguments:{action:'act',sessionId,request:f.request()}});
    assert.equal(r.structuredContent.status,'completed');assert.ok(r.content.some(c=>c.type==='image'));assert.ok(r.content.some(c=>c.type==='resource_link'));
    assert.equal(r.structuredContent.lookPending,true);
    const controller=new AbortController();controller.abort();
    await assert.rejects(()=>service.call({action:'observe',sessionId},controller.signal),/cancelled/);
    assert.equal(f.counts().sends,1);
    await client.callTool({name:'pico_interaction',arguments:{action:'stop',sessionId}});
  } finally {await client.close();await server.close();}
});

test('wire cancellation after semantic dispatch retains uncertainty and refuses another action',async()=>{
  const f=await interactionFixture({lostAck:true});f.dependencies.fence.stop();f.dependencies.fence.release();
  const fakeSleep=f.dependencies.sleep;
  const service=createInteractionService({evidenceRoot:path.join(f.root,'public'),fenceRoot:path.join(f.root,'fences'),now:f.now,
    sleep:async ms=>{await new Promise(r=>setTimeout(r,10));await fakeSleep(ms);},connect:async()=>f.dependencies});
  const server=new McpServer({name:'semantic-cancellation-fixture',version:'1.0.0'});registerInteractionSessionTools(server,service);
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);
  const client=new Client({name:'cancellation-host-fixture',version:'1.0.0'});await client.connect(ct);
  try {
    const opened=await client.callTool({name:'pico_interaction',arguments:{action:'open',serial:f.target.serial,packageName:f.target.packageName,expectedApkSha256:f.target.apkSha256}});
    const sessionId=opened.structuredContent.sessionId,controller=new AbortController(),request=f.request();
    const pending=client.callTool({name:'pico_interaction',arguments:{action:'act',sessionId,request}},undefined,{signal:controller.signal});
    const rejected=assert.rejects(pending);
    const until=async predicate=>{const deadline=Date.now()+2000;while(!await predicate()){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}};
    await until(()=>f.counts().sends===1);controller.abort();await rejected;
    await until(async()=>{const s=await service.call({action:'status',sessionId});return s.status==='in_doubt'&&!s.busy;});
    const attempts=fs.readdirSync(path.join(path.dirname(opened.structuredContent.recordPath),'attempts'));
    const record=JSON.parse(fs.readFileSync(path.join(path.dirname(opened.structuredContent.recordPath),'attempts',attempts[0],'result.json'),'utf8'));
    assert.equal(record.status,'in_doubt');assert.equal(record.attempted,true);assert.equal(record.acknowledgement,null);
    assert.equal(record.reason,'cancelled');assert.ok(f.now()<request.deadlineEpochMs,'cancellation, not eventual deadline expiry, caused the hold');
    assert.equal(f.state.state.counter,1,'fixture effect happened before cancellation');
    const repeat=await client.callTool({name:'pico_interaction',arguments:{action:'act',sessionId,request:f.request()}});
    assert.equal(repeat.isError,true);assert.equal(f.counts().sends,1,'no second send after host cancellation');
  } finally {await client.close();await server.close();}
});

test('isolated host probe forwards only read-only calls, preserves image bytes, propagates MCP cancellation and changes identity on reconnect',async()=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'pico-host-probe-'));
  const png=path.join(root,'test/fixtures/media/valid-small.png');
  const hash=crypto.createHash('sha256').update(fs.readFileSync(png)).digest('hex');
  const connect=async()=>{
    const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'scripts/host-conformance-probe.mjs'),output,png,hash],env:{PICO_ADB:'/fixture/no/such/adb'},stderr:'pipe'});
    const client=new Client({name:'generic-host-probe-test',version:'1.0.0'});
    await client.connect(transport);return {client,transport};
  };
  let first;
  for(let attempt=0;attempt<2;attempt++) {
    const {client,transport}=await connect();
    try {
      assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['host_probe','pico_doctor','pico_interaction']);
      const call=(name,args,options)=>client.callTool({name,arguments:args},undefined,options);
      const identity=JSON.parse((await call('host_probe',{mode:'identity'})).content[0].text);
      if(first){assert.notEqual(identity.generation,first.generation);assert.notEqual(identity.pid,first.pid);continue;}
      first=identity;
      assert.equal((await call('pico_interaction',{action:'describe'})).structuredContent.offlineDiscovery,true);
      assert.equal((await call('pico_interaction',{action:'build',projectDir:root})).isError,true);
      assert.equal((await call('pico_doctor',{calibrate:true})).isError,true);
      const image=await call('host_probe',{mode:'image'});
      assert.equal(image.structuredContent.historicalEvidence,true);
      assert.equal(image.structuredContent.freshNativeCapture,false);
      assert.equal(crypto.createHash('sha256').update(Buffer.from(image.content.find(c=>c.type==='image').data,'base64')).digest('hex'),hash);
      assert.ok(image.content.some(c=>c.type==='resource_link'));
      assert.equal((await call('host_probe',{mode:'error'})).isError,true);
      const controller=new AbortController();
      const waiting=call('host_probe',{mode:'wait'},{signal:controller.signal});
      const rejected=assert.rejects(waiting);
      const logPath=path.join(output,identity.generation,'wire.jsonl');
      const events=()=>fs.readFileSync(logPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      const until=async predicate=>{
        const deadline=Date.now()+5000;
        while(!predicate()){assert.ok(Date.now()<deadline,'expected wire event before deadline');await new Promise(r=>setTimeout(r,20));}
      };
      await until(()=>events().some(e=>e.event==='wait_started'));
      controller.abort();await rejected;
      await until(()=>events().some(e=>e.event==='wait_cancelled'));
      assert.ok(events().some(e=>e.event==='in'&&e.message.method==='notifications/cancelled'));
      assert.deepEqual(events().filter(e=>e.event==='candidate_call').map(e=>[e.name,e.args]),[['pico_interaction',{action:'describe'}]]);
      const sentImage=events().flatMap(e=>e.message?.result?.content??[]).find(c=>c.type==='image');
      assert.equal(sentImage.sha256,hash);assert.equal(sentImage.data,undefined);
    } finally {await client.close();await transport.close();}
  }
  const {client,transport}=await connect();
  try {
  const identity=JSON.parse((await client.callTool({name:'host_probe',arguments:{mode:'identity'}})).content[0].text);
  const logPath=path.join(output,identity.generation,'wire.jsonl');
  const events=()=>fs.readFileSync(logPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const until=async predicate=>{
    const deadline=Date.now()+5000;
    while(!predicate()){assert.ok(Date.now()<deadline,'disconnect drained before deadline');await new Promise(r=>setTimeout(r,20));}
  };
  const waiting=client.callTool({name:'host_probe',arguments:{mode:'wait'}});
  const rejected=assert.rejects(waiting);
  await until(()=>events().some(e=>e.event==='wait_started'));
  const requestId=events().find(e=>e.event==='wait_started').requestId;
  const childPid=events().find(e=>e.event==='started').childPid;
  await client.close();await transport.close();await rejected;
  await until(()=>events().some(e=>e.event==='closed'));
  await until(()=>{try{process.kill(childPid,0);return false;}catch(e){return e.code==='ESRCH';}});
  assert.equal(events().some(e=>e.event==='out'&&e.message.id===requestId),false,'no late wait response after disconnect');
  } finally {await client.close();await transport.close();}
});
