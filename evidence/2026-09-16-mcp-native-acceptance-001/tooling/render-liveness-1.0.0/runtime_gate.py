"""Immutable, explicitly targeted host/compositor admission evidence. No app launch/restart."""
from pathlib import Path
import datetime, hashlib, json, os, re, signal, subprocess, sys, time

ROOT = Path(__file__).resolve().parent
SWIFT = ROOT / 'window-state.swift'

def save(name, value):
    text = value if isinstance(value, str) else json.dumps(value, indent=2) + '\n'
    with (ROOT / name).open('x') as f:
        f.write(text)

def run(argv, timeout=30):
    start = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        cp = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return {'argv': argv, 'startedAt': start, 'endedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit': cp.returncode, 'stdout': cp.stdout, 'stderr': cp.stderr}
    except subprocess.TimeoutExpired as error:
        return {'argv': argv, 'startedAt': start, 'exit': None, 'error': str(error)}

def window(name):
    receipt = run(['swift', str(SWIFT)], 45)
    save(name + '.command.json', receipt)
    if receipt['exit'] != 0:
        value = {'pass': False, 'error': 'Host window inspection failed'}
    else:
        value = json.loads(receipt['stdout'])
    save(name + '.json', value)
    return value

mode, name = sys.argv[1:]
assert re.fullmatch(r'[a-z0-9_-]+', name)
if mode == 'gate':
    before = window(name + '-window-before')
    clock = run(['adb', '-s', 'emulator-5554', 'shell', 'date', '+%s.%N'])
    save(name + '-clock.json', clock)
    assert clock['exit'] == 0
    epoch = float(clock['stdout'].strip())
    argv = ['adb', '-s', 'emulator-5554', 'logcat', '-b', 'main', '-v', 'epoch', '-T', clock['stdout'].strip(), '*:V']
    env = dict(os.environ)
    env.pop('ANDROID_LOG_TAGS', None)
    start_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    start = time.monotonic()
    with (ROOT / (name + '.log')).open('xb') as out, (ROOT / (name + '.stderr.log')).open('xb') as err:
        child = subprocess.Popen(argv, stdout=out, stderr=err, env=env)
        time.sleep(20)
        running = child.poll() is None
        if running:
            child.send_signal(signal.SIGINT)
        try:
            code = child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.terminate()
            code = child.wait(timeout=5)
    elapsed = time.monotonic() - start
    meta = {'argv': argv, 'startedAt': start_iso, 'endedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'deviceStartEpoch': epoch, 'requestedSeconds': 20, 'elapsedSeconds': elapsed, 'runningAtEnd': running, 'exit': code, 'envRemoved': ['ANDROID_LOG_TAGS']}
    save(name + '.meta.json', meta)
    after = window(name + '-window-after')
    raw = (ROOT / (name + '.log')).read_text()
    lines = [line for line in raw.splitlines() if (m := re.match(r'\s*(\d+\.\d+)', line)) and epoch <= float(m[1]) < epoch + 20]
    early = sum('last_known_vsync_start is early more than 1S' in line for line in lines)
    seethrough = sum(' SPR-SeethroughBufferManager' in line for line in lines)
    metric_lines = [line for line in lines if re.search(r'\bPxrMetric:', line)]
    fps = [float(m[1]) for line in metric_lines if (m := re.search(r'FPS=(\d+(?:\.\d+)?)/', line))]
    save(name + '.pxrmetric.log', '\n'.join(metric_lines) + '\n')
    clean = running and elapsed >= 20 and code == -signal.SIGINT and not (ROOT / (name + '.stderr.log')).read_text().strip()
    value = {'rawLog': name + '.log', 'sha256': hashlib.sha256((ROOT / (name + '.log')).read_bytes()).hexdigest(), 'seconds': 20, 'earlyWarnings': early, 'seethroughCount': seethrough, 'seethroughPerSecond': seethrough / 20, 'pxrMetricSamples': len(fps), 'pxrMetricAverageFps': sum(fps) / len(fps) if fps else None, 'cleanTimedWindow': clean, 'hostBeforePass': before.get('pass'), 'hostAfterPass': after.get('pass'), 'scope': 'Admission diagnostic; not app performance or visual evidence'}
    value['pass'] = clean and bool(before.get('pass')) and bool(after.get('pass')) and early == 0 and seethrough / 20 >= 11 and bool(fps) and sum(fps) / len(fps) >= 50
    save(name + '.gate.json', value)
    print(json.dumps(value, indent=2))
    sys.exit(0 if value['pass'] else 1)
elif mode == 'raise':
    # Both permitted operations are attempted; failure never bypasses the ten-second wait.
    result = run(['osascript', '-e', 'tell application "System Events" to tell process "qemu-system-aarch64" to perform action "AXRaise" of window "PICO Emulator - 6.1.0"', '-e', 'tell application "System Events" to set frontmost of process "qemu-system-aarch64" to true'])
    save(name + '.json', result)
    if result['exit'] != 0:
        front = run(['osascript', '-e', 'tell application "System Events" to set frontmost of process "qemu-system-aarch64" to true'])
        save(name + '-frontmost.json', front)
    start = time.monotonic()
    time.sleep(10)
    save(name + '-wait.json', {'requestedSeconds': 10, 'elapsedSeconds': time.monotonic() - start})
    print(json.dumps(result, indent=2))
else:
    raise ValueError('Supported modes: gate, raise')
