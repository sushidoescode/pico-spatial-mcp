#!/usr/bin/env python3
"""Finite, opt-in real-host trials. Never a CI gate; uses the host's existing auth.

Usage: run-host-conformance.py codex|claude ABS_OUTPUT_DIR ABS_RETAINED_PNG SHA256 [baseline|approved|cancel|lifecycle]
Only task-owned children are signalled. No host registration/configuration is installed.
"""
import hashlib, json, os, pathlib, shutil, sys, signal, time
from contextlib import ExitStack
sys.dont_write_bytecode=True
from host_conformance_process import OwnedProcessLoop, successful_outcome

ROOT=pathlib.Path(__file__).resolve().parents[1]
host,out_arg,frame_arg,frame_sha=sys.argv[1:5]
trial=sys.argv[5] if len(sys.argv)>5 else 'baseline'
if host not in ('codex','claude'): raise SystemExit('unsupported host')
if trial not in ('baseline','approved','cancel','lifecycle') or (trial=='lifecycle' and host!='claude'):raise SystemExit('unsupported trial')
out=pathlib.Path(out_arg); frame=pathlib.Path(frame_arg)
if not out.is_absolute() or not frame.is_absolute():raise SystemExit('absolute paths required')
if hashlib.sha256(frame.read_bytes()).hexdigest()!=frame_sha:raise SystemExit('frame hash mismatch')
out.mkdir(parents=True,exist_ok=False,mode=0o700)
workspace=out/'workspace'; workspace.mkdir()
node=shutil.which('node'); executable=shutil.which(host)
probe={'command':node,'args':[str(ROOT/'scripts/host-conformance-probe.mjs'),str(out/'probe'),str(frame),frame_sha]}
prompt=('Use only the configured MCP tools. Do not use shell, files, browser or delegation. '
        'First call pico_doctor with {} and report fixture-only missing tooling without fixing it. '
        'Then call pico_interaction with action describe. Then call host_probe mode identity, '
        'mode error (this is an intentional refusal; do not retry), and mode image. '
        'Based only on the inline image returned by that tool, transcribe the visible panel heading, '
        'state transition count and panel status. If image content is unavailable, say so explicitly; '
        'do not read the file or infer its contents from metadata. Finish with a concise report that '
        'distinguishes discovery, expected error handling and historical image inspection from fresh native execution.')
if trial in ('cancel','lifecycle'):
    prompt='Use only the configured MCP host_probe tool. Call mode identity, then mode wait exactly once. The harness will interrupt the wait. Do not retry it, call other tools, read files or delegate.'
(out/'prompt.txt').write_text(prompt+'\n')
if host=='codex':
    command=[executable,'exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','--color','never','--strict-config','-C',str(workspace)]
    for feature in ['shell_tool','unified_exec','apps','plugins','hooks','multi_agent','image_generation','browser_use','computer_use','view_image','memories','skill_search','workspace_dependencies','sleep_tool','code_mode','daemon_auto_start']:
        command+=['--disable',feature]
    overrides={'features.skip_host_skill_discovery':True,'web_search':'disabled','mcp_servers.pico_iteration_fixture.command':node,
               'mcp_servers.pico_iteration_fixture.args':probe['args'],'mcp_servers.pico_iteration_fixture.required':True,
               'mcp_servers.pico_iteration_fixture.startup_timeout_sec':30,'mcp_servers.pico_iteration_fixture.tool_timeout_sec':45,
               'mcp_servers.pico_iteration_fixture.enabled_tools':['pico_doctor','pico_interaction','host_probe']}
    if trial=='approved':
        # Only safe behind this adapter's exact-argument forwarding checks.
        for tool in ('pico_doctor','pico_interaction'):
            overrides[f'mcp_servers.pico_iteration_fixture.tools.{tool}.approval_mode']='approve'
    for key,value in overrides.items(): command+=['-c',key+'='+json.dumps(value)]
    command+=[prompt]
else:
    config=out/'mcp.json';config.write_text(json.dumps({'mcpServers':{'pico_iteration_fixture':{'type':'stdio',**probe}}},indent=2)+'\n')
    command=[executable,'-p','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence',
             '--permission-mode','manual','--permission-prompts','host','--permission-prompt-tool','stdio','--restricted','--tools','',
             '--disable-slash-commands','--no-chrome','--strict-mcp-config','--mcp-config',str(config),
             '--setting-sources','','--settings','{"disableAllHooks":true,"disableClaudeAiConnectors":true}',
             '--max-turns','10','--max-budget-usd','2']
source_files=[pathlib.Path(__file__).resolve(),ROOT/'scripts/host_conformance_process.py',ROOT/'scripts/host-conformance-probe.mjs',ROOT/'dist/build-receipt.json']
(out/'invocation.json').write_text(json.dumps({'host':host,'trial':trial,'argv':command,'cwd':str(workspace),'deadlineSeconds':180,'usesExistingAuth':True,'credentialsCopied':False,
    'sourceIdentities':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in source_files]},indent=2)+'\n')
env=os.environ.copy()
env['DISABLE_AUTOUPDATER']='1';env['DISABLE_NONESSENTIAL_TRAFFIC']='1'
env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']='1';env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']='1'
env['PICO_ADB']='/fixture/no/such/adb';env['PICO_MCP_CLI_POLICY']='disabled'
loop=OwnedProcessLoop(command,cwd=workspace,env=env,timeout=180)
buffers={'stdout':b'','stderr':b''};permissions=[];protocol_errors=[]
prompt_sent=False;result_seen=False;closed_input=False;failure=None
phase='initial';interrupt_sent=False;interrupt_ack=False;reconnect_sent=False;initial_result=False;trial_actions=[]
def compact(value):
    if isinstance(value,list):return [compact(v) for v in value]
    if isinstance(value,dict):
        if value.get('type')=='image' and isinstance(value.get('data'),str):
            import base64
            data=base64.b64decode(value['data']);return {'type':'image','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'dataOmitted':True}
        if value.get('type')=='base64' and isinstance(value.get('data'),str):
            import base64
            data=base64.b64decode(value['data']);return {'type':'base64','media_type':value.get('media_type'),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'dataOmitted':True}
        return {k:('[account metadata omitted]' if k in ('email','account','accountInfo') else compact(v)) for k,v in value.items()}
    return value
def permitted(name,args):
    suffix=name.removeprefix('mcp__pico_iteration_fixture__')
    return name.startswith('mcp__pico_iteration_fixture__') and ((suffix=='pico_doctor' and args=={}) or
        (suffix=='pico_interaction' and args=={'action':'describe'}) or (suffix=='host_probe' and args in [{'mode':x} for x in ['identity','error','image','wait']]))

with ExitStack() as files:
    outputs={key:files.enter_context(open(out/(key+'.raw.jsonl'),'xb')) for key in buffers}
    events=files.enter_context(open(out/'host-events.jsonl','x'))
    sent=files.enter_context(open(out/'input.jsonl','x'))
    def send(value):
        encoded=json.dumps(value)+'\n'
        sent.write(encoded);sent.flush();loop.send(encoded.encode())
    def started(control):
        if host=='claude':send({'type':'control_request','request_id':'initialize-1','request':{'subtype':'initialize'}})
        else:control.close_stdin()
    def wire_events():
        found=[]
        for log in (out/'probe').glob('*/wire.jsonl'):
            for line in log.read_text().splitlines():
                try:found.append(json.loads(line))
                except ValueError:pass  # A final line can still be in flight.
        return found
    def tick(control):
        global interrupt_sent,reconnect_sent,phase
        if trial not in ('cancel','lifecycle') or control.terminating:return
        observed=wire_events()
        if not interrupt_sent and any(e['event']=='wait_started' for e in observed):
            interrupt_sent=True
            trial_actions.append({'action':'interrupt','cause':'Claude control request' if host=='claude' else 'Codex leader SIGINT','at':time.time()})
            if host=='claude':send({'type':'control_request','request_id':'interrupt-1','request':{'subtype':'interrupt'}})
            else:control.signal_leader(signal.SIGINT)
        if trial=='lifecycle' and interrupt_ack and initial_result and not reconnect_sent and any(e['event'] in ('wait_cancelled','wait_elapsed','wait_transport_closed') for e in observed):
            reconnect_sent=True;phase='reconnecting';trial_actions.append({'action':'mcp_reconnect','at':time.time()})
            send({'type':'control_request','request_id':'reconnect-1','request':{'subtype':'mcp_reconnect','serverName':'pico_iteration_fixture'}})
    def output(label,chunk,control):
        global prompt_sent,result_seen,closed_input,interrupt_ack,phase,initial_result
        outputs[label].write(chunk);outputs[label].flush();buffers[label]+=chunk
        if len(buffers[label])>16*1024*1024:raise RuntimeError('host protocol line exceeds bounded capacity')
        while b'\n' in buffers[label]:
            line,buffers[label]=buffers[label].split(b'\n',1)
            if label!='stdout':continue
            try:event=json.loads(line)
            except (ValueError,UnicodeDecodeError):
                if len(protocol_errors)<100:protocol_errors.append('non-JSON stdout')
                elif len(protocol_errors)==100:protocol_errors.append('further parse failures omitted; raw output retained')
                continue
            events.write(json.dumps(compact(event))+'\n');events.flush()
            # Cleanup retains diagnostics but never authorizes another tool or
            # blocks trying to write to a closed/non-reading host stdin.
            if host!='claude' or control.terminating:continue
            if event.get('type')=='control_response' and event.get('response',{}).get('request_id')=='interrupt-1':
                interrupt_ack=event['response'].get('subtype')=='success'
            if event.get('type')=='control_response' and event.get('response',{}).get('request_id')=='reconnect-1':
                if event['response'].get('subtype')=='success':
                    phase='after_reconnect'
                    send({'type':'user','message':{'role':'user','content':'The host reconnected the MCP adapter. Call host_probe mode identity and pico_interaction action describe, then report the new connection identity. Do not call wait again, read files or use other tools.'},'parent_tool_use_id':None,'session_id':''})
                else:control.close_stdin();closed_input=True
            if event.get('type')=='control_response' and event.get('response',{}).get('request_id')=='initialize-1' and not prompt_sent:
                if event['response'].get('subtype')=='success':
                    send({'type':'user','message':{'role':'user','content':prompt},'parent_tool_use_id':None,'session_id':''});prompt_sent=True
                else:control.close_stdin();closed_input=True
            if event.get('type')=='control_request':
                request=event['request'];name=request.get('tool_name','');args=request.get('input',{})
                allowed=request.get('subtype')=='can_use_tool' and permitted(name,args)
                decision={'behavior':'allow','updatedInput':args} if allowed else {'behavior':'deny','message':'Outside the authorized host-conformance allowlist'}
                permissions.append({'requestId':event['request_id'],'tool':name,'input':args,'decision':decision['behavior']})
                send({'type':'control_response','response':{'subtype':'success','request_id':event['request_id'],'response':decision}})
            if event.get('type')=='result' and not closed_input:
                result_seen=True
                if trial=='lifecycle' and phase=='initial':initial_result=True
                else:control.close_stdin();closed_input=True
    try:
        loop.run(started,output,on_tick=tick)
    except BaseException as error:
        failure={'type':type(error).__name__,'message':str(error)}
    finally:
        report={'host':host,'trial':trial,**loop.report(),'permissionDecisions':permissions,'protocolErrors':protocol_errors,'trialActions':trial_actions,
                'resultSeen':result_seen if host=='claude' else None,'runnerError':failure}
        (out/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
if not successful_outcome(report):raise SystemExit(1)
