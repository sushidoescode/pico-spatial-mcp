#!/usr/bin/env node
// Source-checkout example. Nothing is registered with an installed host. Default is offline describe.
import fs from 'node:fs';
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
if(!['describe','build','scenario','replay'].includes(mode))throw new Error('Use describe | build | scenario | replay');
const native=mode==='scenario'||mode==='replay';
if(native&&(!values['native-authorized']||!/^emulator-[0-9]+$/.test(values.serial??'')||!/^[a-f0-9]{64}$/.test(values['apk-sha']??'')))
  throw new Error('Native modes need actual separately obtained ownership/start permission plus --native-authorized --serial emulator-N --apk-sha SHA256. The flag records intent only; it grants no ownership.');
const projectDir=path.resolve(values.project??path.join(root,'examples/agent-iteration-fixture'));
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js')],cwd:root,env:{...process.env,
  PICO_MCP_SURFACE:'doors',PICO_MCP_INTERACTION:'1',PICO_MCP_INTERACTION_EVIDENCE_DIR:path.join(root,'evidence','agent-iteration-example')},stderr:'inherit'});
const client=new Client({name:'agent-neutral-iteration-example',version:'1.0.0'});
let sessionId;
const call=async args=>{
  const response=await client.callTool({name:'pico_interaction',arguments:args},undefined,{timeout:1_000_000});
  const data=response.structuredContent??JSON.parse(response.content.find(c=>c.type==='text').text);
  console.log(JSON.stringify({tool:'pico_interaction',...data,inlineImageDelivered:response.content.some(c=>c.type==='image')},null,2));
  if(response.isError)throw new Error(data.reason??data.status??'interaction failed');
  return data;
};
try {
  await client.connect(transport);
  if(mode==='describe')await call({action:'describe'});
  else if(mode==='build')await call({action:'build',projectDir,...(values.gradle?{gradleExecutable:path.resolve(values.gradle)}:{})});
  else {
    const opened=await call({action:'open',serial:values.serial,packageName:'com.example.picofixture.iteration.debug',expectedApkSha256:values['apk-sha']});sessionId=opened.sessionId;
    const scenario=JSON.parse(fs.readFileSync(path.join(projectDir,'scenario.json'),'utf8'));
    await call(mode==='scenario'?{action:'scenario',sessionId,scenario}:{action:'iterate',sessionId,scenario,projectDir,allowRelaunch:true,...(values.gradle?{gradleExecutable:path.resolve(values.gradle)}:{})});
  }
} catch(error) {console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
finally {
  // Stop only the local drained session. An in_doubt fence refuses release and remains evidence.
  if(sessionId)try{await call({action:'stop',sessionId});}catch(error){console.error(String(error));process.exitCode=1;}
  await client.close();await transport.close();
}
