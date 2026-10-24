// Record only frame-specific attestations that root has already visually inspected.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const ev=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(ev,'../..');
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js')],cwd:root,env:{...process.env,PICO_MCP_SURFACE:'full',PICO_MCP_CLI_POLICY:'managed-cached',PICO_MCP_LEDGER_DIR:path.join(ev,'ledger'),PICO_ADB:'/fixture/no/such/adb'},stderr:'inherit'});
const client=new Client({name:'root-reviewed-native-frame-record',version:'1.0.0'});
try{
 await client.connect(transport);
 for(const name of process.argv.slice(2)){
  if(!/^[a-z0-9-]+-look\.json$/.test(name))throw new Error('Only retained local LOOK records accepted');
  const look=JSON.parse(fs.readFileSync(path.join(ev,name)));
  const sha=crypto.createHash('sha256').update(fs.readFileSync(look.artifactPath)).digest('hex');
  if(sha!==look.sha256)throw new Error('LOOK capture bytes changed');
  const args={app:'com.example.picofixture.iteration.debug',claim:look.claim,evidenceType:'vision_verified',artifactPath:look.artifactPath,attestation:look.attestation,cClass:'C0_emulator'};
  const result=await client.callTool({name:'record_verification',arguments:args});
  const data=result.structuredContent??JSON.parse(result.content.find(x=>x.type==='text').text);
  fs.writeFileSync(path.join(ev,'ledger-'+name),JSON.stringify({input:args,captureSha256:sha,result:data},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({name,result:data}));
  if(result.isError||data.status!=='recorded')throw new Error('Verification not recorded');
 }
}finally{await client.close();await transport.close();}
