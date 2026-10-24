"""render-liveness/1.0.0 — the adopted emulator acceptance gate (R1-R4 plus safeguards).

Approved 2026-09-11. Replaces the ` SPR-SeethroughBufferManager` >= 11/s requirement, whose emitter
no longer exists in the current runtime instance, with a per-app render-progress criterion. SPR is
still counted and reported as an OBSERVATION so a future regression stays visible.

What it proves: BOUNDED APP LIVENESS — that the named app held focus and kept producing fresh
frames across the window. It is NOT application FPS and NOT complete compositor health.

Everything the previous gate required is retained: host frontmost/unoccluded before and after (and
after the capture, when one is taken), a fresh clean twenty-second sample, zero early-vsync, and
PxrMetric mean >= 50 as a SECONDARY environment check.

`evaluate()` is pure so every failure case is testable without a device.
"""
import re

GATE = 'render-liveness'
GATE_VERSION = '1.0.0'

# Strict: a watchdog line that does not match this exactly is MALFORMED, never silently skipped.
WATCHDOG_STRICT = re.compile(
    r'^\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(\S+?):\s+'
    r'Watchdog: focus=(\d+)\(([^)]+)\) lastRenderTime=(\d+), currentTime=(\d+), checkCount=(\d+)\.?\s*$')
WATCHDOG_LOOSE = re.compile(r'Watchdog: focus=')
EPOCH = re.compile(r'^\s*(\d+\.\d+)\s')
PXR_FPS = re.compile(r'PxrMetric:.*?FPS=(\d+(?:\.\d+)?)/')

MIN_ON_TARGET = 18            # R1
MIN_RENDER_ADVANCE_MS = 18000  # R2
MAX_FRAME_AGE_MS = 100         # R4 upper
MIN_FRAME_AGE_MS = 0           # R4 lower: a negative age is invalid data, never a pass
MIN_PXR_FPS = 50               # retained secondary


def parse(raw_text, epoch, seconds):
    """Return (rows, integrity). Rows are strictly-parsed watchdog samples inside the window."""
    rows, malformed, in_window_lines = [], [], 0
    for line in raw_text.splitlines():
        m = EPOCH.match(line)
        if not m or not (epoch <= float(m[1]) < epoch + seconds):
            continue
        in_window_lines += 1
        if not WATCHDOG_LOOSE.search(line):
            continue
        s = WATCHDOG_STRICT.match(line)
        if not s:
            malformed.append(line[:300])
            continue
        rows.append(dict(atEpoch=float(s[1]), emitterPid=int(s[2]), emitterTid=int(s[3]),
                         level=s[4], tag=s[5], focusId=int(s[6]), focusPackage=s[7],
                         lastRenderTime=int(s[8]), currentTime=int(s[9]), checkCount=int(s[10])))
    emitters = sorted({(r['tag'], r['emitterPid']) for r in rows})
    integrity = dict(
        malformedWatchdogLines=len(malformed), malformedSamples=malformed[:5],
        emitters=[dict(tag=t, pid=p) for t, p in emitters],
        singleEmitter=len(emitters) == 1,
        emitterTag=emitters[0][0] if len(emitters) == 1 else None,
        emitterPid=emitters[0][1] if len(emitters) == 1 else None,
        timestampsNonDecreasing=all(a['atEpoch'] <= b['atEpoch'] for a, b in zip(rows, rows[1:])),
        checkCountStrictlyIncreasing=all(b['checkCount'] > a['checkCount'] for a, b in zip(rows, rows[1:])),
        duplicateCheckCounts=len(rows) - len({r['checkCount'] for r in rows}),
        runtimeClockNonDecreasing=all(b['currentTime'] >= a['currentTime'] for a, b in zip(rows, rows[1:])),
        linesInWindow=in_window_lines,
    )
    integrity['noClockReset'] = integrity['runtimeClockNonDecreasing']
    integrity['noDuplicateSamples'] = integrity['duplicateCheckCounts'] == 0
    integrity['wellFormed'] = (integrity['malformedWatchdogLines'] == 0 and integrity['singleEmitter']
                               and integrity['timestampsNonDecreasing']
                               and integrity['checkCountStrictlyIncreasing']
                               and integrity['noDuplicateSamples'] and integrity['noClockReset'])
    return rows, integrity


def measure(raw_text, epoch, seconds, package):
    rows, integrity = parse(raw_text, epoch, seconds)
    target = [r for r in rows if r['focusPackage'] == package]
    render = [r['lastRenderTime'] for r in target]
    ages = [r['currentTime'] - r['lastRenderTime'] for r in target]
    fps = [float(m[1]) for line in raw_text.splitlines()
           if (e := EPOCH.match(line)) and epoch <= float(e[1]) < epoch + seconds
           and (m := PXR_FPS.search(line))]
    return dict(
        seconds=seconds, watchdogSamples=len(rows), watchdogSamplesOnTarget=len(target),
        focusPackagesSeen=sorted({r['focusPackage'] for r in rows}),
        focusedThroughout=bool(rows) and len(target) == len(rows),
        lastRenderTimeFirst=render[0] if render else None,
        lastRenderTimeLast=render[-1] if render else None,
        lastRenderAdvanceMs=(render[-1] - render[0]) if len(render) >= 2 else None,
        lastRenderMonotonic=all(b >= a for a, b in zip(render, render[1:])) if len(render) >= 2 else None,
        lastRenderStalledSamples=sum(1 for a, b in zip(render, render[1:]) if b == a),
        frameAgesMs=ages, minFrameAgeMs=min(ages) if ages else None,
        maxFrameAgeMs=max(ages) if ages else None,
        negativeFrameAges=sum(1 for a in ages if a < MIN_FRAME_AGE_MS),
        overAgedFrames=sum(1 for a in ages if a > MAX_FRAME_AGE_MS),
        checkCountAdvance=(target[-1]['checkCount'] - target[0]['checkCount']) if len(target) >= 2 else None,
        earlyVsyncWarnings=sum('last_known_vsync_start is early more than 1S' in line
                               for line in raw_text.splitlines()
                               if (e := EPOCH.match(line)) and epoch <= float(e[1]) < epoch + seconds),
        seethroughBufferManagerLines=sum(' SPR-SeethroughBufferManager' in line
                                         for line in raw_text.splitlines()
                                         if (e := EPOCH.match(line)) and epoch <= float(e[1]) < epoch + seconds),
        pxrMetricSamples=len(fps),
        pxrMetricAverageFps=round(sum(fps) / len(fps), 3) if fps else None,
        integrity=integrity,
    )


def evaluate(measured, *, host_before, host_after_sample, host_after_capture,
             clean_timed_window, identity_stable, captured):
    """Pure decision. host_after_capture participates whenever a capture was taken."""
    m, g = measured, measured['integrity']
    spr_per_second = m['seethroughBufferManagerLines'] / m['seconds']
    checks = {
        # retained from the previous gate
        'hostBeforePass': bool(host_before),
        'hostAfterSamplePass': bool(host_after_sample),
        'cleanTimedWindow': bool(clean_timed_window),
        'earlyVsyncZero': m['earlyVsyncWarnings'] == 0,
        'pxrMetricAtLeast50': bool(m['pxrMetricAverageFps'] is not None
                                   and m['pxrMetricAverageFps'] >= MIN_PXR_FPS),
        # safeguards
        'targetIdentityStableAcrossWindow': bool(identity_stable),
        'watchdogWellFormed': bool(g['wellFormed']),
        'singleKnownEmitter': bool(g['singleEmitter']),
        'noMalformedSamples': g['malformedWatchdogLines'] == 0,
        'noDuplicateSamples': bool(g['noDuplicateSamples']),
        'noOutOfOrderTimestamps': bool(g['timestampsNonDecreasing']),
        'noClockReset': bool(g['noClockReset']),
        # R1-R4
        'R1_focusOwnedByTarget': bool(m['focusedThroughout'] and m['watchdogSamplesOnTarget'] >= MIN_ON_TARGET),
        'R2_renderAdvanced': bool(m['lastRenderMonotonic'] and m['lastRenderAdvanceMs'] is not None
                                  and m['lastRenderAdvanceMs'] >= MIN_RENDER_ADVANCE_MS),
        'R3_noStalledSamples': m['lastRenderStalledSamples'] == 0,
        'R4_everyFrameAgeInRange': bool(m['frameAgesMs'] and m['negativeFrameAges'] == 0
                                        and m['overAgedFrames'] == 0),
    }
    if captured:
        checks['hostAfterCapturePass'] = bool(host_after_capture)
    return dict(
        gate=GATE, gateVersion=GATE_VERSION, pass_=all(checks.values()), checks=checks,
        thresholds=dict(minOnTargetSamples=MIN_ON_TARGET, minRenderAdvanceMs=MIN_RENDER_ADVANCE_MS,
                        frameAgeMsRange=[MIN_FRAME_AGE_MS, MAX_FRAME_AGE_MS], minPxrFps=MIN_PXR_FPS),
        observedSpr=dict(lines=m['seethroughBufferManagerLines'], perSecond=spr_per_second,
                         previousGateRequirement=11, required=False,
                         regressionFlag=('present but below the previous 11/s requirement'
                                         if 0 < spr_per_second < 11 else
                                         'absent' if spr_per_second == 0 else 'at or above 11/s')),
        proves='Bounded app liveness: the named app held focus and kept producing fresh frames.',
        doesNotProve=['application FPS', 'complete compositor health', 'native acceptance of any build'],
    )
