import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {interactionFixture} from './helpers/interaction-fixture.mjs';
import {createInteractionService,registerInteractionSessionTools} from '../dist/interactiontools.js';
const root=fileURLToPath(new URL('..',import.meta.url));
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
