"""Run the adopted render-liveness/1.0.0 gate against an explicitly named package and build.

With --capture, the capture is taken inside the admitted window and host visibility is re-checked
AFTER it; that result participates in the pass decision.
"""
import argparse, hashlib, json, os, signal, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import package_target as pt, render_liveness_gate_v1 as gate

WINDOW_STATE = Path(__file__).resolve().parent.parent / 'window-state.swift'
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('name')
pt.add_target_args(p)
p.add_argument('--seconds', type=int, default=20)
p.add_argument('--capture', action='store_true')
args = p.parse_args()
here = Path(__file__).resolve().parent
receipt = dict(tool='run_gate_v1', gate=gate.GATE, gateVersion=gate.GATE_VERSION,
               startedAtUtc=pt.now(), argv=sys.argv[1:], commands=[])
out = pt.immutable(here / (args.name + '.gate.json'))


def run(argv, timeout=180):
    r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    receipt['commands'].append(dict(argv=argv, exitCode=r.returncode, stdout=r.stdout[:1500],
                                    stderr=r.stderr[:800], atUtc=pt.now()))
    return r


def host(label):
    r = run(['swift', str(WINDOW_STATE)], 90)
    value = json.loads(r.stdout) if r.returncode == 0 else {'pass': False}
    receipt.setdefault('hostChecks', {})[label] = value
    return value


try:
    args.require_running = True
    receipt['targetBefore'] = before_id = pt.resolve(args, receipt['commands'])
    hb = host('before')
    log = pt.immutable(here / (args.name + '.log'))
    err = pt.immutable(here / (args.name + '.stderr.log'))
    clock = run(['adb', '-s', args.device, 'shell', 'date', '+%s.%N'])
    assert clock.returncode == 0, 'device clock read failed'
    epoch = float(clock.stdout.strip())
    env = dict(os.environ); env.pop('ANDROID_LOG_TAGS', None)
    start = time.monotonic()
    with log.open('xb') as o, err.open('xb') as e:
        child = subprocess.Popen(pt.raw_logcat_argv(args.device, clock.stdout.strip()),
                                 stdout=o, stderr=e, env=env)
        time.sleep(args.seconds)
        running = child.poll() is None
        if running:
            child.send_signal(signal.SIGINT)
        try:
            code = child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait(timeout=10)  # never leave a runaway logcat reader behind (2026-09-13); the refusal stands
            raise
    elapsed = time.monotonic() - start
    ha = host('afterSample')
    data = log.read_bytes()
    receipt['raw'] = dict(path=log.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                          requestedSeconds=args.seconds, elapsedSeconds=round(elapsed, 3),
                          runningAtEnd=running, exit=code, stderrEmpty=not err.read_text().strip())
    clean = bool(running and elapsed >= args.seconds and code == -signal.SIGINT
                 and receipt['raw']['stderrEmpty'])
    receipt['measured'] = measured = gate.measure(data.decode('utf-8', 'replace'), epoch,
                                                  args.seconds, args.package)
    hc, captured = None, False
    if args.capture and hb.get('pass'):
        image = pt.immutable(here / (args.name + '.png'))
        r = run(['screencapture', '-o', '-x', '-l' + str(hb['target']['id']), str(image)])
        hc = host('afterCapture')
        captured = r.returncode == 0 and image.exists()
        if captured:
            raw = image.read_bytes()
            receipt['capture'] = dict(path=image.name, bytes=len(raw),
                                      sha256=hashlib.sha256(raw).hexdigest())
        else:
            receipt['capture'] = dict(status='capture_failed')
    receipt['targetAfter'] = after_id = pt.resolve(args, receipt['commands'])
    identity_stable = (after_id['installedSha256'] == before_id['installedSha256']
                       and after_id['pid'] == before_id['pid'] and before_id['pid'] is not None)
    receipt['identityStable'] = dict(stable=identity_stable,
                                     shaBefore=before_id['installedSha256'],
                                     shaAfter=after_id['installedSha256'],
                                     pidBefore=before_id['pid'], pidAfter=after_id['pid'])
    receipt['verdict'] = gate.evaluate(measured, host_before=hb.get('pass'),
                                       host_after_sample=ha.get('pass'),
                                       host_after_capture=(hc or {}).get('pass'),
                                       clean_timed_window=clean, identity_stable=identity_stable,
                                       captured=captured or (args.capture and not captured))
    receipt['pass'] = bool(receipt['verdict']['pass_'] and (not args.capture or captured))
except Exception as error:
    receipt['pass'] = False
    receipt['refusal'] = dict(type=type(error).__name__, message=str(error))
finally:
    receipt['endedAtUtc'] = pt.now()
    with out.open('x') as f:
        json.dump(receipt, f, indent=2); f.write('\n')
v = receipt.get('verdict', {})
print(json.dumps(dict(gate=f"{gate.GATE}/{gate.GATE_VERSION}", passed=receipt.get('pass'),
                      checks=v.get('checks'), observedSpr=v.get('observedSpr'),
                      identityStable=receipt.get('identityStable'),
                      capture=receipt.get('capture'), refusal=receipt.get('refusal')),
                 indent=2, default=str))
raise SystemExit(0 if receipt.get('pass') else 1)
