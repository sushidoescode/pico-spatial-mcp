#!/usr/bin/env node
// Manual host-conformance adapter. This is not a production MCP registration.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {interactionToolResult} from '../dist/interactiontools.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const [outputRoot,imagePath,expectedImageSha256]=process.argv.slice(2);
if(!outputRoot||!path.isAbsolute(outputRoot)||!imagePath||!path.isAbsolute(imagePath)||!/^[a-f0-9]{64}$/.test(expectedImageSha256??'')) {
  throw new Error('Usage: host-conformance-probe.mjs ABSOLUTE_OUTPUT_DIR ABSOLUTE_RETAINED_PNG SHA256');
}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const imageBytes=fs.readFileSync(imagePath);
if(hash(imageBytes)!==expectedImageSha256||imageBytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('retained PNG identity mismatch');
const generation=crypto.randomUUID();
const runDir=path.join(outputRoot,generation);
fs.mkdirSync(runDir,{recursive:true,mode:0o700});
const logPath=path.join(runDir,'wire.jsonl');
const logFd=fs.openSync(logPath,'wx',0o600);
let logOpen=true;
function compact(value) {
  if(Array.isArray(value))return value.map(compact);
  if(value&&typeof value==='object') {
    if(value.type==='image'&&typeof value.data==='string') {
      const bytes=Buffer.from(value.data,'base64');
      return {type:'image',mimeType:value.mimeType,bytes:bytes.length,sha256:hash(bytes),dataOmitted:true};
    }
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,compact(v)]));
  }
  return value;
}
const log=(event,detail={})=>{if(logOpen)fs.writeSync(logFd,JSON.stringify({at:new Date().toISOString(),generation,event,...compact(detail)})+'\n');};
const privateHome=path.join(runDir,'home'),emptyTools=path.join(runDir,'empty-tools');
fs.mkdirSync(privateHome);fs.mkdirSync(emptyTools);
const childEnv={PATH:`${path.dirname(process.execPath)}:/usr/bin:/bin`,HOME:privateHome,
  PICO_HOME:emptyTools,PICO_ADB:'/fixture/no/such/adb',PICO_MCP_CLI_POLICY:'disabled',
  PICO_MCP_SURFACE:'doors',PICO_MCP_INTERACTION:'1'};
const childTransport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js')],cwd:root,env:childEnv,stderr:'pipe'});
const client=new Client({name:'pico-host-conformance-allowlist',version:'1.0.0'});
let server,closing=false;
const pending=new Set();
async function close(reason,exitCode=0) {
  if(closing)return;closing=true;log('closed',{reason});
  // Close the SDK server first: its protocol callback aborts in-flight requests.
  await server?.close();for(const finish of pending)finish();
  await client.close();await childTransport.close();fs.closeSync(logFd);logOpen=false;
  process.exit(exitCode);
}
process.stdin.on('end',()=>{void close('stdin ended');});
process.on('SIGTERM',()=>{void close('SIGTERM');});
process.on('SIGINT',()=>{void close('SIGINT');});
process.on('uncaughtException',error=>{log('fatal',{reason:error.message});void close('startup/runtime error',1);});
process.on('unhandledRejection',error=>{log('fatal',{reason:String(error)});void close('startup/runtime rejection',1);});
childTransport.stderr?.on('data',bytes=>fs.appendFileSync(path.join(runDir,'candidate.stderr.txt'),bytes));
await client.connect(childTransport);
const candidateTools=(await client.listTools()).tools;
const tools=candidateTools.filter(t=>['pico_doctor','pico_interaction'].includes(t.name));
if(tools.length!==2)throw new Error('candidate discovery missing required tools');
const recordPath=path.join(runDir,'retained-image.json');
const historical={status:'completed',scope:'host-conformance-only',historicalEvidence:true,freshNativeCapture:false,
  actionSent:false,lookPending:true,evidenceCeiling:'structural',humanInputVerified:false,
  evidence:{status:'captured',path:imagePath,sha256:expectedImageSha256},recordPath,
  note:'Retained image bytes passed through the production interactionToolResult formatter; no current emulator state is asserted.'};
fs.writeFileSync(recordPath,JSON.stringify(historical,null,2)+'\n',{flag:'wx',mode:0o600});
tools.push({name:'host_probe',description:'Test-only read-only host conformance. image delivers a retained historical PNG via the production MCP formatter; error is intentional; wait lasts 30 seconds or ends on MCP cancellation; identity returns this connection generation. No native operations.',
  inputSchema:{type:'object',properties:{mode:{type:'string',enum:['identity','image','error','wait']}},required:['mode'],additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}});
log('started',{pid:process.pid,childPid:childTransport.pid,sourceRoot:root,childEnv,candidateToolCount:candidateTools.length,exposedTools:tools.map(t=>t.name)});
server=new Server({name:'pico-host-conformance',version:'1.0.0'},{capabilities:{tools:{}},instructions:'This is an isolated conformance adapter. Only doctor{} and interaction describe are forwarded to the actual candidate. host_probe is test-only and never accesses a device. Retained images are historical, not fresh captures.'});
server.onclose=()=>{void close('protocol closed');};
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
  const {name,arguments:args={}}=request.params;
  if(name==='pico_doctor'&&Object.keys(args).length===0 || name==='pico_interaction'&&args.action==='describe'&&Object.keys(args).length===1) {
    log('candidate_call',{name,args});
    return client.callTool({name,arguments:args},undefined,{signal:extra.signal,timeout:30_000});
  }
  if(name!=='host_probe'||Object.keys(args).length!==1||!['identity','image','error','wait'].includes(args.mode)) {
    return {isError:true,content:[{type:'text',text:JSON.stringify({status:'refused',reason:'Conformance allowlist: only doctor{}, interaction describe, and named host probes are enabled. No native action was forwarded.'})}]};
  }
  if(args.mode==='identity')return {content:[{type:'text',text:JSON.stringify({generation,pid:process.pid,scope:'host-conformance-only'})}]};
  if(args.mode==='image')return interactionToolResult(historical);
  if(args.mode==='error')return {isError:true,content:[{type:'text',text:JSON.stringify({status:'refused',code:'EXPECTED_HOST_CONFORMANCE_ERROR',actionSent:false,retryAllowed:false})}]};
  log('wait_started',{requestId:extra.requestId});
  return new Promise(resolve=>{
    let finished=false;
    const finish=reason=>{
      if(finished)return;finished=true;clearTimeout(timer);extra.signal.removeEventListener('abort',cancel);pending.delete(close);
      log(`wait_${reason}`,{requestId:extra.requestId});
      resolve({content:[{type:'text',text:JSON.stringify({status:reason,generation,actionSent:false})}]});
    };
    const cancel=()=>finish('cancelled'),close=()=>finish('transport_closed');
    const timer=setTimeout(()=>finish('elapsed'),30_000);
    pending.add(close);extra.signal.addEventListener('abort',cancel,{once:true});
    if(extra.signal.aborted)cancel();
  });
});
const transport=new StdioServerTransport();
const send=transport.send.bind(transport);
transport.send=async message=>{log('out',{message});return send(message);};
await server.connect(transport);
const onmessage=transport.onmessage;
transport.onmessage=(message,...rest)=>{log('in',{message});return onmessage?.(message,...rest);};
