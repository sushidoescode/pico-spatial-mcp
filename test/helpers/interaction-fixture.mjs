import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function interactionFixture(options = {}) {
  const {bindInteractionTarget}=await import('../../dist/interactiontarget.js');
  const {acquireInteractionFence}=await import('../../dist/interactionfence.js');
  const serial='emulator-5678', packageName=options.packageName??'com.example.picofixture.iteration';
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pico-interaction-'));
  let now=Date.now(), sends=0, captures=0, reads=0, ack=null;
  const identity={serial,packageName,model:'PICO Emulator',fingerprint:'pico/sdk/6.1',bootQemu:'1',
    bootId:'d2f1cb1e-942a-4001-8f7c-4d4aa2497fb0',apkSha256:'a'.repeat(64),pid:1234,pidStartTicks:'4422',
    appGeneration:crypto.randomUUID()};
  const state={schemaVersion:1,kind:'pico.agent-bridge.semantic-state',packageName,generation:identity.appGeneration,
    revision:0,observedAtEpochMs:now,pid:identity.pid,pidStartTicks:identity.pidStartTicks,
    state:{panel:{id:'fixture.panel',visible:false},counter:0},actions:['panel.show']};
  const probes={listOnlineSerials:async()=>[serial,'physical-pico'],probe:async()=>({...identity})};
  const target=await bindInteractionTarget({serial,packageName,expectedApkSha256:identity.apkSha256},probes);
  const fence=acquireInteractionFence(path.join(root,'fences'),serial);
  const bridge={
    observe:async()=>{reads++;state.observedAtEpochMs=now;return structuredClone(state);},
    send:async r=>{
      sends++; now++;
      if(options.sendError) throw new Error('transport closed after possible write');
      if(!options.acceptOnly && !state.state.panel.visible){state.revision++;state.state.panel.visible=true;state.state.counter++;}
      ack={schemaVersion:1,packageName,requestId:r.requestId,generation:state.generation,expectedRevision:r.expectedRevision,
        actionId:r.actionId,args:r.args,status:options.acceptOnly?'accepted':'completed',revision:state.revision,
        acknowledgedAtEpochMs:now,state:structuredClone(state.state)};
      if(options.interfereAfterSend) identity.pid++;
    },
    readAck:async()=> options.lostAck?null:structuredClone(ack),
  };
  const dependencies={bridge,probes,fence,evidenceRoot:path.join(root,'evidence'),now:()=>now,
    sleep:async ms=>{now+=ms;},
    capture:async capturedTarget=>{
      captures++; if(options.captureError) throw new Error('capture failed');
      if(capturedTarget.serial!==serial) throw new Error('wrong capture target');
      now++;
      return {bytes:fs.readFileSync(fileURLToPath(new URL('../fixtures/media/valid-small.png',import.meta.url))),
        capturedAt:new Date(options.staleCapture?0:now).toISOString(),width:64,height:64};
    }};
  const request=()=>({schemaVersion:1,requestId:crypto.randomUUID(),packageName,expectedGeneration:state.generation,
    expectedRevision:state.revision,actionId:'panel.show',args:{panelId:'fixture.panel'},deadlineEpochMs:now+1000});
  return {root,identity,state,target,dependencies,request,now:()=>now,counts:()=>({sends,captures,reads})};
}
