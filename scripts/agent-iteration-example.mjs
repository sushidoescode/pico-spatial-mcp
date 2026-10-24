#!/usr/bin/env node
// Source-checkout example. Nothing is registered with an installed host. Default is offline describe.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const {values,positionals}=parseArgs({allowPositionals:true,options:{
  project:{type:'string'},gradle:{type:'string'},serial:{type:'string'},'apk-sha':{type:'string'},'native-authorized':{type:'boolean'},
}});
const mode=positionals[0]??'describe';
if(!['describe','build','scenario','replay','capture'].includes(mode))throw new Error('Use describe | build | scenario | replay | capture');
const native=['scenario','replay','capture'].includes(mode);
if(native&&(!values['native-authorized']||!/^emulator-[0-9]+$/.test(values.serial??'')||!/^[a-f0-9]{64}$/.test(values['apk-sha']??'')))
  throw new Error('Native modes need actual separately obtained ownership/start permission plus --native-authorized --serial emulator-N --apk-sha SHA256. The flag records intent only; it grants no ownership.');
const projectDir=path.resolve(values.project??path.join(root,'examples/agent-iteration-fixture'));
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js')],cwd:root,env:{...process.env,
  PICO_MCP_SURFACE:'doors',PICO_MCP_INTERACTION:'1',PICO_MCP_INTERACTION_EVIDENCE_DIR:path.join(root,'evidence','agent-iteration-example')},stderr:'inherit'});
const client=new Client({name:'agent-neutral-iteration-example',version:'1.0.0'});
let sessionId;
const call=async (args,name='pico_interaction')=>{
  const response=await client.callTool({name,arguments:args},undefined,{timeout:1_000_000});
  const data=response.structuredContent??JSON.parse(response.content.find(c=>c.type==='text').text);
  console.log(JSON.stringify({tool:name,...data,inlineImageDelivered:response.content.some(c=>c.type==='image')},null,2));
  if(response.isError)throw new Error(data.reason??data.status??'interaction failed');
  return data;
};
try {
  await client.connect(transport);
  if(mode==='describe')await call({action:'describe'});
  else if(mode==='build')await call({action:'build',projectDir,...(values.gradle?{gradleExecutable:path.resolve(values.gradle)}:{})});
  else {
    const opened=await call({action:'open',serial:values.serial,packageName:'com.example.picofixture.iteration.debug',expectedApkSha256:values['apk-sha']});sessionId=opened.sessionId;
    if(mode==='capture') {
      // Read-only recapture after a failed LOOK, never another panel.show. Reuse the existing
      // capture door and bind it with semantic observations on either side under this session.
      const capture=await call({serial:values.serial},'pico_look');
      const observed=await call({action:'observe',sessionId});
      if(capture.status!=='captured'||observed.target.bindingSha256!==opened.target.bindingSha256
        ||observed.state.revision!==opened.state.revision||JSON.stringify(observed.state.state)!==JSON.stringify(opened.state.state))
        throw new Error('Recapture target/state changed; do not attribute this frame');
      const bytes=fs.readFileSync(capture.path);
      if(crypto.createHash('sha256').update(bytes).digest('hex')!==capture.sha256)throw new Error('Capture bytes changed');
      const directory=path.dirname(opened.recordPath),framePath=path.join(directory,'recapture.png'),recordPath=path.join(directory,'recapture.json');
      fs.writeFileSync(framePath,bytes,{flag:'wx',mode:0o600});
      const result={status:'captured',kind:'pico.interaction-recapture',target:opened.target,before:opened.state,after:observed.state,
        capture:{...capture,path:framePath,sourcePath:capture.path},recordPath,lookPending:true,evidenceCeiling:'structural',actionSent:false};
      fs.writeFileSync(recordPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
      console.log(JSON.stringify(result,null,2));
    } else {
    const scenario=JSON.parse(fs.readFileSync(path.join(projectDir,'scenario.json'),'utf8'));
    await call(mode==='scenario'?{action:'scenario',sessionId,scenario}:{action:'iterate',sessionId,scenario,projectDir,allowRelaunch:true,...(values.gradle?{gradleExecutable:path.resolve(values.gradle)}:{})});
    }
  }
} catch(error) {console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
finally {
  // Stop only the local drained session. An in_doubt fence refuses release and remains evidence.
  if(sessionId)try{await call({action:'stop',sessionId});}catch(error){console.error(String(error));process.exitCode=1;}
  await client.close();await transport.close();
}
