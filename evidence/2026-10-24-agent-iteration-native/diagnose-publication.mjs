import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runBinary} from '../../dist/util.js';
const ev=path.dirname(fileURLToPath(import.meta.url));
const adb='/Users/sushantsrikrish/Library/Android/sdk/platform-tools/adb';
const quote=s=>"'"+s.replaceAll("'", "'\\''")+"'";
const target='files/agentbridge/interaction-v1/971b186f-e529-4bd6-8bab-c3b57f57d015/inbox/04f69643-b23e-4f95-b3f4-87d26b002287.json';
const probes=[
 ['paths', 'pwd; ls -ld files files/agentbridge files/agentbridge/interaction-v1 files/agentbridge/interaction-v1/971b186f-e529-4bd6-8bab-c3b57f57d015 files/agentbridge/interaction-v1/971b186f-e529-4bd6-8bab-c3b57f57d015/inbox; ls -la "$(dirname "$1")"; for p in "$1" "$1.tmp"; do if test -e "$p"; then ls -l "$p"; head -c 16384 "$p"; else printf "absent:%s\\n" "$p"; fi; done'],
 ['noclobber', 'set -C; printf noclobber-ok'],
 ['base64', "printf e30= | base64 -d; printf ':base64-exit=%s' \"$?\""],
 ['dirname', 'dirname "$1"'],
];
const records=[];
for(const [name,script] of probes){
 const command=['run-as','com.example.picofixture.iteration.debug','sh','-c',script,'pico-diagnose',target].map(quote).join(' ');
 const result=await runBinary(adb,['-s','emulator-5554','exec-out',command],{timeoutMs:5000,maxOutputBytes:65537});
 const record={name,command,...result,stdoutBase64:result.stdout.toString('base64'),stdout:result.stdout.toString('utf8'),readOnly:true};
 records.push(record); console.log(JSON.stringify(record));
}
fs.writeFileSync(path.join(ev,'publication-diagnostics.json'),JSON.stringify(records,null,2)+'\n',{flag:'wx'});
