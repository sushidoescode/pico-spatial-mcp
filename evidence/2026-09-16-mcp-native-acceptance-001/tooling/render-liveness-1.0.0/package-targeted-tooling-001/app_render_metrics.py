"""Per-app render/progress metrics read out of a raw unfiltered epoch logcat sample.

Compositor frame rate is a property of the runtime, not of the app: PxrMetric can sit at 60 while
the app is frozen or not even focused. These metrics are per-APP and are the basis of the proposed
replacement liveness criterion. They are derived, never asserted, here; thresholds live with the
caller so this stays a measurement, not a policy.

`SpatialRuntimeService: Watchdog: focus=NN(<package>) lastRenderTime=X, currentTime=Y, checkCount=Z`
is emitted once per second by the spatial runtime for the FOCUSED app. lastRenderTime is that app's
last completed render; currentTime is the runtime clock. So (currentTime - lastRenderTime) is how
stale the app's newest frame is, and the advance of lastRenderTime across the window is direct
evidence that the app kept producing frames.
"""
import re

WATCHDOG = re.compile(
    r'Watchdog: focus=(\d+)\(([^)]+)\) lastRenderTime=(\d+), currentTime=(\d+), checkCount=(\d+)')
HWUI = re.compile(r'PXR-HWUI:.*processNodeMetrics: Activity: \S*?:([\w.]+)/\S*?#(\d+)')
EPOCH = re.compile(r'\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s')
PXR_FPS = re.compile(r'PxrMetric:.*?FPS=(\d+(?:\.\d+)?)/')


def window_lines(text, epoch, seconds):
    out = []
    for line in text.splitlines():
        m = EPOCH.match(line)
        if m and epoch <= float(m[1]) < epoch + seconds:
            out.append((float(m[1]), int(m[2]), line))
    return out


def metrics(text, epoch, seconds, package, pid=None):
    lines = window_lines(text, epoch, seconds)
    rows = []
    for t, _, line in lines:
        m = WATCHDOG.search(line)
        if m:
            rows.append(dict(atEpoch=t, focusId=int(m[1]), focusPackage=m[2],
                             lastRenderTime=int(m[3]), currentTime=int(m[4]), checkCount=int(m[5])))
    target = [r for r in rows if r['focusPackage'] == package]
    render = [r['lastRenderTime'] for r in target]
    stale = [r['currentTime'] - r['lastRenderTime'] for r in target]
    checks = [r['checkCount'] for r in target]
    frames = []
    for t, _, line in lines:
        m = HWUI.search(line)
        if m and m[1] == package:
            frames.append(int(m[2]))
    pid_lines = sum(1 for _, p, _ in lines if pid and str(p) == str(pid))
    fps = [float(m[1]) for _, _, line in lines if (m := PXR_FPS.search(line))]
    return dict(
        seconds=seconds, linesInWindow=len(lines),
        watchdogSamples=len(rows), watchdogSamplesOnTarget=len(target),
        focusPackagesSeen=sorted({r['focusPackage'] for r in rows}),
        focusedThroughout=bool(rows) and len(target) == len(rows),
        lastRenderTimeFirst=render[0] if render else None,
        lastRenderTimeLast=render[-1] if render else None,
        lastRenderAdvanceMs=(render[-1] - render[0]) if len(render) >= 2 else None,
        lastRenderMonotonic=all(b >= a for a, b in zip(render, render[1:])) if len(render) >= 2 else None,
        lastRenderStalledSamples=sum(1 for a, b in zip(render, render[1:]) if b == a),
        maxFrameStalenessMs=max(stale) if stale else None,
        meanFrameStalenessMs=round(sum(stale) / len(stale), 2) if stale else None,
        checkCountAdvance=(checks[-1] - checks[0]) if len(checks) >= 2 else None,
        hwuiNodeMetricSamples=len(frames),
        hwuiActivitySeqFirst=frames[0] if frames else None,
        hwuiActivitySeqLast=frames[-1] if frames else None,
        appPidLogLines=pid_lines,
        earlyVsyncWarnings=sum('last_known_vsync_start is early more than 1S' in line for _, _, line in lines),
        seethroughBufferManagerLines=sum(' SPR-SeethroughBufferManager' in line for _, _, line in lines),
        pxrMetricSamples=len(fps),
        pxrMetricAverageFps=round(sum(fps) / len(fps), 3) if fps else None,
        scope='Per-app render/progress measurement. Not application FPS and not visual evidence.',
    )
