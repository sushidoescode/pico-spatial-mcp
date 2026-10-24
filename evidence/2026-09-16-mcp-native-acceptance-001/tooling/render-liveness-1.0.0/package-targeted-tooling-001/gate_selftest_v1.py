"""Focused host tests for render-liveness/1.0.0, one per approved failure case. No device needed
except to read retained logs. Sends nothing, captures nothing."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_liveness_gate_v1 as gate
import package_target as pt

HERE = Path(__file__).resolve().parent
CP15 = HERE.parent
PKG = 'com.picoagent.rocketsim'
E0 = 1789000000.0
results = []


def line(i, *, pkg=PKG, render=None, current=None, check=None, tag='SpatialRuntimeService',
         pid=1257, at=None, text=None):
    at = E0 + i if at is None else at
    if text is not None:
        return f'         {at:.3f}  {pid}  1603 I {tag}: {text}'
    render = 500000 + i * 1000 if render is None else render
    current = render + 10 if current is None else current
    check = 100 + i if check is None else check
    return (f'         {at:.3f}  {pid}  1603 I {tag}: Watchdog: focus=78({pkg}) '
            f'lastRenderTime={render}, currentTime={current}, checkCount={check}')


def noise(n=20, fps=60.0, early=0):
    out = [f'         {E0 + i + 0.5:.3f}  1625  1700 I PxrMetric: FPS={fps}/60 GPU=0' for i in range(n)]
    out += [f'         {E0 + i + 0.7:.3f}  1625  1700 W PxrCompositor: '
            f'last_known_vsync_start is early more than 1S' for i in range(early)]
    return out


def build(rows, **kw):
    return '\n'.join(rows + noise(**kw))


def verdict(text, *, host_before=True, host_after_sample=True, host_after_capture=True,
            clean=True, identity=True, captured=False, pkg=PKG, epoch=E0):
    m = gate.measure(text, epoch, 20, pkg)
    return gate.evaluate(m, host_before=host_before, host_after_sample=host_after_sample,
                         host_after_capture=host_after_capture, clean_timed_window=clean,
                         identity_stable=identity, captured=captured), m


def case(name, fn):
    try:
        results.append(dict(case=name, passed=True, detail=fn()))
    except Exception as error:
        results.append(dict(case=name, passed=False, error=f'{type(error).__name__}: {error}'))


def fails(v, check):
    assert v['pass_'] is False, f'gate wrongly PASSED; checks={v["checks"]}'
    assert v['checks'].get(check) is False, f'expected {check} False, got {v["checks"].get(check)}'
    failed = [k for k, ok in v['checks'].items() if not ok]
    return {'rejected': True, 'failingChecks': failed}


# ---- healthy baselines -------------------------------------------------------------------------
case('healthy synthetic window passes', lambda: (lambda v, m: (
    v['pass_'] or (_ for _ in ()).throw(AssertionError(v['checks'])),
    {'advanceMs': m['lastRenderAdvanceMs'], 'maxAge': m['maxFrameAgeMs'],
     'onTarget': m['watchdogSamplesOnTarget']})[1])(*verdict(build([line(i) for i in range(20)]))))

def real_sample():
    meta = json.loads((CP15 / 'reference041-gate-002.meta.json').read_text())
    text = (CP15 / 'reference041-gate-002.log').read_text('utf-8', 'replace')
    v, m = verdict(text, captured=False, epoch=meta['deviceStartEpoch'])
    # host/timing inputs are supplied by the caller; here only the log-derived checks matter
    for k in ('R1_focusOwnedByTarget', 'R2_renderAdvanced', 'R3_noStalledSamples',
              'R4_everyFrameAgeInRange', 'watchdogWellFormed', 'noClockReset',
              'noDuplicateSamples', 'noMalformedSamples', 'singleKnownEmitter'):
        assert v['checks'][k] is True, (k, v['checks'])
    assert m['integrity']['emitterTag'] == 'SpatialRuntimeService', m['integrity']
    return dict(emitter=m['integrity'], advanceMs=m['lastRenderAdvanceMs'],
                ageRange=[m['minFrameAgeMs'], m['maxFrameAgeMs']],
                sprObserved=v['observedSpr'])
case('retained real 041 sample passes R1-R4 and integrity', real_sample)

def real_failed_gate():
    meta = json.loads((CP15 / 'preinstall-debug042-gate-004.meta.json').read_text())
    text = (CP15 / 'preinstall-debug042-gate-004.log').read_text('utf-8', 'replace')
    m = gate.measure(text, meta['deviceStartEpoch'], 20, PKG)
    v = gate.evaluate(m, host_before=True, host_after_sample=True, host_after_capture=True,
                      clean_timed_window=True, identity_stable=True, captured=False)
    assert m['pxrMetricAverageFps'] >= 50, m['pxrMetricAverageFps']
    return fails(v, 'R1_focusOwnedByTarget') | {'pxrWas': m['pxrMetricAverageFps'],
                                                'focusSeen': m['focusPackagesSeen']}
case('retained 042 gate-004 rejected despite 65 FPS', real_failed_gate)

# ---- the safeguards the user required ----------------------------------------------------------
case('negative frame age rejected', lambda: fails(verdict(build(
    [line(i, current=500000 + i * 1000 - 5) for i in range(20)]))[0], 'R4_everyFrameAgeInRange'))
case('frame age over 100 ms rejected', lambda: fails(verdict(build(
    [line(i, current=500000 + i * 1000 + 250) for i in range(20)]))[0], 'R4_everyFrameAgeInRange'))
case('clock reset rejected', lambda: fails(verdict(build(
    [line(i, current=(500000 + i * 1000 + 10) if i != 12 else 400000) for i in range(20)]))[0],
    'noClockReset'))
case('duplicate sample rejected', lambda: fails(verdict(build(
    [line(i, check=100 + min(i, 10)) for i in range(20)]))[0], 'noDuplicateSamples'))
case('out-of-order timestamps rejected', lambda: fails(verdict(build(
    [line(i, at=E0 + (i if i != 15 else 3)) for i in range(20)]))[0], 'noOutOfOrderTimestamps'))
case('malformed watchdog line rejected', lambda: fails(verdict(build(
    [line(i) for i in range(19)] + [f'         {E0 + 19:.3f}  1257  1603 I SpatialRuntimeService: '
                                    f'Watchdog: focus=78({PKG}) lastRenderTime=BROKEN']))[0],
    'noMalformedSamples'))
case('two emitters rejected', lambda: fails(verdict(build(
    [line(i, pid=1257 if i < 10 else 21870) for i in range(20)]))[0], 'singleKnownEmitter'))
case('unstable target identity rejected', lambda: fails(verdict(build(
    [line(i) for i in range(20)]), identity=False)[0], 'targetIdentityStableAcrossWindow'))

# ---- R1-R4 boundaries ---------------------------------------------------------------------------
case('frozen app rejected', lambda: fails(verdict(build(
    [line(i, render=500000, current=500000 + i * 10) for i in range(20)]))[0], 'R3_noStalledSamples'))
case('another app holding focus rejected', lambda: fails(verdict(build(
    [line(i, pkg='com.picoxr.systemui') for i in range(20)]))[0], 'R1_focusOwnedByTarget'))
case('too few on-target samples rejected', lambda: fails(verdict(build(
    [line(i) for i in range(17)]))[0], 'R1_focusOwnedByTarget'))
case('insufficient render advance rejected', lambda: fails(verdict(build(
    [line(i, render=500000 + i * 800) for i in range(20)]))[0], 'R2_renderAdvanced'))

# ---- retained requirements ----------------------------------------------------------------------
case('early-vsync warning rejected', lambda: fails(verdict(build(
    [line(i) for i in range(20)], early=1))[0], 'earlyVsyncZero'))
case('Pxr below 50 rejected', lambda: fails(verdict(build(
    [line(i) for i in range(20)], fps=31.0))[0], 'pxrMetricAtLeast50'))
case('host visibility failing after the sample rejected', lambda: fails(verdict(build(
    [line(i) for i in range(20)]), host_after_sample=False)[0], 'hostAfterSamplePass'))
case('host visibility failing AFTER THE CAPTURE rejected', lambda: fails(verdict(build(
    [line(i) for i in range(20)]), host_after_capture=False, captured=True)[0], 'hostAfterCapturePass'))
case('capture-time visibility is not even checked when no capture is taken', lambda: (lambda v: (
    v['pass_'] and 'hostAfterCapturePass' not in v['checks']
    or (_ for _ in ()).throw(AssertionError(v['checks']))) and {'noCaptureCheckAdded': True})(
        verdict(build([line(i) for i in range(20)]), host_after_capture=False, captured=False)[0]))

# ---- SPR stays an observation --------------------------------------------------------------------
case('SPR absent does not fail the gate but is reported', lambda: (lambda v: (
    v['pass_'] and v['observedSpr']['required'] is False
    and v['observedSpr']['regressionFlag'] == 'absent'
    or (_ for _ in ()).throw(AssertionError(v['observedSpr']))) and v['observedSpr'])(
        verdict(build([line(i) for i in range(20)]))[0]))
case('SPR present but below 11/s is flagged as a regression', lambda: (lambda v: (
    v['pass_'] and 'below the previous' in v['observedSpr']['regressionFlag']
    or (_ for _ in ()).throw(AssertionError(v['observedSpr']))) and v['observedSpr'])(
        verdict(build([line(i) for i in range(20)] +
                      [line(i, tag='SPR-SeethroughBufferManager', text='Texture changed.')
                       for i in range(5)]))[0]))

report = dict(gate=gate.GATE, gateVersion=gate.GATE_VERSION, atUtc=pt.now(), cases=results,
              passed=sum(r['passed'] for r in results), total=len(results),
              allPassed=all(r['passed'] for r in results),
              scope='Host-only failure-case tests for the adopted gate. No device mutation.')
path = HERE / 'GATE_SELFTEST_V1.json'
if path.exists():
    path = HERE / f'GATE_SELFTEST_V1-{int(__import__("time").time())}.json'
with path.open('x') as f:
    json.dump(report, f, indent=2); f.write('\n')
for r in results:
    print(('PASS  ' if r['passed'] else 'FAIL  ') + r['case'] + ('' if r['passed'] else '  <- ' + r['error']))
print(f"\n{report['passed']}/{report['total']} gate cases passed -> {path.name}")
raise SystemExit(0 if report['allPassed'] else 1)
