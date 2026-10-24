#!/usr/bin/env python3
"""Bounded read-only CLI contract observations; stdout and stderr retained separately."""
import errno, fcntl, hashlib, json, os, pathlib, pty, selectors, signal, struct, subprocess, termios, time
ROOT=pathlib.Path(__file__).resolve().parent
CLI=pathlib.Path('/Users/sushantsrikrish/.pico-mcp/cli/versions/0.6.1/node_modules/.bin/pico-cli')
PACKAGE=CLI.parent.parent/'@picoxr/pico-cli'
ENV=dict(os.environ, PICO_CLI_NO_TELEMETRY='1', PICO_ADB='/fixture/no/such/adb', ADB_PATH='/fixture/no/such/adb')
CAP=1024*1024
TIMEOUT=20
commands=[('version', ['--version']), ('root-help',['--help']), ('workflow-help',['workflow','--help']), ('app-help',['app','--help']), ('emulator-help',['emulator','--help']), ('capture-help',['capture','--help']), ('workflow-list-help',['workflow','list','--help']),('workflow-describe-help',['workflow','describe','--help']), ('workflow-run-read-help',['workflow','run','read','--help']), ('workflow-result-read-help',['workflow','result','read','--help']), ('workflow-resume-help',['workflow','resume','--help']), ('workflow-cancel-help',['workflow','cancel','--help']), ('workflow-events-read-help',['workflow','events','read','--help']), ('workflow-list',['workflow','list','--format','json']), ('workflow-describe',['workflow','describe','spatial-design-to-app','--format','json']), ('knowledge-server-help',['knowledge','server','--help']),('watch-crash-help',['app','watch-crash','--help']),('capture-record-help',['capture','record','--help']),('perf-live-help',['perf','live','run','--help']),('trace-record-help',['perf','trace','record','--help']),('trace-decode-help',['perf','trace','decode','--help']),('trace-load-help',['perf','trace','load','--help']),('trace-query-help',['perf','trace','query','--help']),('project-create-help',['project','create','--help'])]
# No command with side effects is admitted by this script.
assert all(a==['--version'] or a[-1]=='--help' or a[:2] in (['workflow','list'],['workflow','describe']) for _,a in commands)
records=[]
def run(label,args,tty=False):
 stem=label+('-pty' if tty else '-pipe')
 if any((ROOT/(stem+'.'+stream+'.txt')).exists() for stream in ('stdout','stderr')): raise FileExistsError('refusing to overwrite retained evidence: '+stem)
 start=time.monotonic(); out={'stdout':bytearray(),'stderr':bytearray()}; master=slave=None; selector=selectors.DefaultSelector()
 if tty:
  master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
 child=subprocess.Popen([str(CLI),*args],stdin=subprocess.DEVNULL,stdout=slave if tty else subprocess.PIPE,stderr=subprocess.PIPE,env=ENV,cwd=str(pathlib.Path.cwd()),start_new_session=True)
 if tty: os.close(slave); selector.register(master,selectors.EVENT_READ,'stdout')
 else: selector.register(child.stdout,selectors.EVENT_READ,'stdout')
 selector.register(child.stderr,selectors.EVENT_READ,'stderr'); timed=False; truncated=False
 while selector.get_map():
  if time.monotonic()-start>TIMEOUT or sum(map(len,out.values()))>CAP:
   timed=time.monotonic()-start>TIMEOUT; truncated=not timed
   try: os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError: pass
  for key,_ in selector.select(.05):
   fd=key.fileobj if isinstance(key.fileobj,int) else key.fileobj.fileno()
   try: b=os.read(fd,65536)
   except OSError as e:
    if e.errno!=errno.EIO: raise
    b=b''
   if not b:
    selector.unregister(key.fileobj)
    if isinstance(key.fileobj,int): os.close(key.fileobj)
   else: out[key.data].extend(b)
 child.wait(); selector.close()
 stem=label+('-pty' if tty else '-pipe'); rec={'stem':stem,'argv':args,'transport':'stdout-pty/stderr-pipe' if tty else 'pipes','exitCode':child.returncode,'timedOut':timed,'outputTruncated':truncated,'durationMs':round((time.monotonic()-start)*1000),'stdout':{},'stderr':{}}
 for stream,b in out.items():
  file=ROOT/(stem+'.'+stream+'.txt'); file.write_bytes(b); rec[stream]={'path':file.name,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'newlineTerminated':b.endswith(b'\n')}
 records.append(rec)
for label,args in commands:
 run(label,args)
 if label in ('root-help','workflow-help','app-help','emulator-help','capture-help'): run(label,args,True)
files=[]
for rel in ('package.json','dist/index.js','dist/workflows/catalog.json','dist/workflows/registered-workflows.v1.json','dist/profiler-worker.js'):
 f=PACKAGE/rel; b=f.read_bytes(); files.append({'path':str(f),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
record={'schemaVersion':1,'capturedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'binary':str(CLI),'realpath':str(CLI.resolve()),'cwd':str(pathlib.Path.cwd()),'timeoutSeconds':TIMEOUT,'maxBytes':CAP,'environmentOverrides':{k:ENV[k] for k in ('PICO_CLI_NO_TELEMETRY','PICO_ADB','ADB_PATH')},'files':files,'observations':records,'nativeOperations':0,'workflowLifecycleMutations':0}
(ROOT/'READ_ONLY_CONTRACTS.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'observations':len(records),'nonzero':[r['stem'] for r in records if r['exitCode']!=0],'pipePty':[{'stem':r['stem'],'stdoutBytes':r['stdout']['bytes'],'stderrBytes':r['stderr']['bytes'],'newline':r['stdout']['newlineTerminated']} for r in records if r['stem'].split('-')[0] in ('root','workflow','app','emulator','capture') and 'help' in r['stem']]},indent=2))
