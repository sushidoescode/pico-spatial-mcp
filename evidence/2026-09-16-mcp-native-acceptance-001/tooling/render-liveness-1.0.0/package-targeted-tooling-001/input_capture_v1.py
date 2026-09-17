"""Identity-verified host click with its raw log window. NOT a gate and NOT acceptance.

Refuses to send input unless the named package is installed with the expected build, is running,
and the emulator window is frontmost and unoccluded. Records the raw window so a session id or a
command result can be read out of it. Producing a successful input proves only that the input was
delivered; admission still requires a separate render-liveness gate.
"""
import argparse, hashlib, json, os, re, signal, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import package_target as pt, render_liveness_gate_v1 as gate

CP15 = Path(__file__).resolve().parent.parent
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('name')
pt.add_target_args(p)
p.add_argument('--click', nargs=2, type=float, metavar=('X', 'Y'))
p.add_argument('--move', nargs=2, type=float, metavar=('X', 'Y'), help='hover only: pointer move, no button event')
p.add_argument('--broadcast', help='--es cmd value; action derived from --package')
p.add_argument('--seconds', type=int, default=12)
p.add_argument('--raise-attempts', type=int, default=6, help='Occlusion retries; occlusion is not a health hold.')
args = p.parse_args()
assert sum(map(bool, (args.click, args.move, args.broadcast))) == 1, 'give exactly one of --click, --move or --broadcast'
here = Path(__file__).resolve().parent
receipt = dict(tool='input_capture_v1', startedAtUtc=pt.now(), argv=sys.argv[1:], commands=[],
               isGate=False, isAcceptance=False,
               scope='Identity-verified app input with its raw log window. A delivered input is '
                     'not a gate pass and not native acceptance.')
out = pt.immutable(here / (args.name + '.json'))


def run(argv, timeout=180):
    r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    receipt['commands'].append(dict(argv=argv, exitCode=r.returncode, stdout=r.stdout[:2000],
                                    stderr=r.stderr[:800], atUtc=pt.now()))
    return r


try:
    args.require_running = True
    receipt['targetBefore'] = before = pt.resolve(args, receipt['commands'])
    # Occlusion is not a health hold: raise, settle ten seconds and re-check, up to --raise-attempts times.
    attempts = []
    host = {'pass': False}
    for i in range(1, args.raise_attempts + 1):
        hb = run(['swift', str(CP15 / 'window-state.swift')], 90)
        host = json.loads(hb.stdout) if hb.returncode == 0 else {'pass': False}
        attempts.append(dict(attempt=i, hostPass=bool(host.get('pass')), frontmostName=host.get('frontmostName')))
        if host.get('pass'):
            break
        run([sys.executable, str(CP15 / 'runtime_gate.py'), 'raise', f'{args.name}-raise-{i:03d}'], 120)
    receipt['hostBefore'] = host
    receipt['visibilityAttempts'] = attempts
    assert host.get('pass'), f'no input while the emulator window is covered or not frontmost after {len(attempts)} raises'
    if args.click:
        action = ['swift', str(CP15 / 'host-click.swift'), str(args.click[0]), str(args.click[1])]
    elif args.move:
        action = ['swift', str(CP15 / 'host-move.swift'), str(args.move[0]), str(args.move[1])]
    else:
        action = ['adb', '-s', args.device, 'shell', 'am', 'broadcast', '-a', before['debugAction'],
                  '--es', 'cmd', args.broadcast]
        assert action[action.index('-a') + 1].startswith(args.package + '.'), 'action must be the target'
    receipt['inputArgv'] = action
    log = pt.immutable(here / (args.name + '.log'))
    err = pt.immutable(here / (args.name + '.stderr.log'))
    clock = run(['adb', '-s', args.device, 'shell', 'date', '+%s.%N'])
    assert clock.returncode == 0
    epoch = float(clock.stdout.strip())
    env = dict(os.environ); env.pop('ANDROID_LOG_TAGS', None)
    with log.open('xb') as o, err.open('xb') as e:
        child = subprocess.Popen(pt.raw_logcat_argv(args.device, clock.stdout.strip()),
                                 stdout=o, stderr=e, env=env)
        try:
            time.sleep(1)
            r = run(action)
            receipt['inputExit'] = r.returncode
            time.sleep(max(0, args.seconds - 1))
        finally:
            child.send_signal(signal.SIGINT)
            try:
                receipt['rawExit'] = child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait(timeout=10)  # never leave a runaway logcat reader behind (2026-09-13)
                raise
    ha = run(['swift', str(CP15 / 'window-state.swift')], 90)
    receipt['hostAfter'] = json.loads(ha.stdout) if ha.returncode == 0 else {'pass': False}
    data = log.read_bytes()
    text = data.decode('utf-8', 'replace')
    receipt['raw'] = dict(path=log.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    receipt['measured'] = gate.measure(text, epoch, args.seconds, args.package)
    sessions = {}
    for m in re.finditer(r'state source=([0-9a-f-]{36}) video=(\S+)', text):
        sessions.setdefault(m[1], m[2])
    receipt['observedReplaySessions'] = [dict(sessionId=s, videoId=v) for s, v in sessions.items()]
    receipt['targetAfter'] = after = pt.resolve(args, receipt['commands'])
    receipt['identityStable'] = (after['installedSha256'] == before['installedSha256']
                                 and after['pid'] == before['pid'])
    receipt['pass'] = bool(receipt.get('inputExit') == 0 and receipt['identityStable']
                           and receipt['hostAfter'].get('pass'))
except Exception as error:
    receipt['pass'] = False
    receipt['refusal'] = dict(type=type(error).__name__, message=str(error))
finally:
    receipt['endedAtUtc'] = pt.now()
    with out.open('x') as f:
        json.dump(receipt, f, indent=2); f.write('\n')
print(json.dumps({k: receipt.get(k) for k in
                  ('pass', 'inputArgv', 'inputExit', 'observedReplaySessions', 'identityStable', 'refusal')},
                 indent=2, default=str))
raise SystemExit(0 if receipt.get('pass') else 1)
