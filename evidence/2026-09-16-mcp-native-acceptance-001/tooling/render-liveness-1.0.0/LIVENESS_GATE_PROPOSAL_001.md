# Proposed replacement liveness criterion — evidence and exact rule

Recorded 2026-09-11. Bounded investigation under an explicit user authorization, using installed
reference build 041. **Nothing in the standing acceptance rule has been changed.** This document is
the proposal; it needs approval before it replaces anything.

Raw evidence: `package-targeted-tooling-001/diag-liveness-001` and `-002` (receipt, raw 20s log,
capture), `diag-liveness-raise-001`, and the retained samples re-measured below.

## Diagnostic exception actually used

The user authorized, for this investigation only, diagnostic captures and visual inspection despite
the missing SPR tag, provided the other existing checks pass. Both samples recorded
`originalGatePass: false` and carry the authorization text. Enforced and passed in both:
host frontmost/unoccluded before **and** after, clean timed 20s window, zero early-vsync,
PxrMetric mean ≥ 50. Waived and recorded as an observation only: ` SPR-SeethroughBufferManager`,
0 lines (0/s against the required 11/s). **These captures are diagnostic evidence. They are not a
pass of the original gate and not native acceptance of 043, which is still not installed.**

## The finding that decides it

`SpatialRuntimeService` emits, once per second, for the **focused** app:

    Watchdog: focus=78(com.picoagent.rocketsim) lastRenderTime=131720001, currentTime=131720016, checkCount=11168

`lastRenderTime` is that app's last completed render; `currentTime` is the runtime clock. So the
advance of `lastRenderTime` is direct evidence the app kept producing frames, and
`currentTime − lastRenderTime` is how stale its newest frame is. Re-measuring every retained sample
with the same extractor:

| Sample | on-target watchdog | lastRender advance | stalled | max staleness | PxrMetric | focus |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| preinstall-debug041-gate-001 *(original gate passed)* | 20 | 19015 ms | 0 | 18 ms | 60.00 | rocketsim |
| debug041-launch-gate-001 *(original gate passed)* | 20 | 19021 ms | 0 | 15 ms | 60.00 | rocketsim |
| reference041-gate-001 | 20 | 19015 ms | 0 | 17 ms | 59.90 | rocketsim |
| reference041-gate-002 | 20 | 19031 ms | 0 | 16 ms | 60.00 | rocketsim |
| diag-liveness-001 *(fresh)* | 20 | 19018 ms | 0 | 16 ms | 60.00 | rocketsim |
| diag-liveness-002 *(fresh)* | 20 | 19018 ms | 0 | 17 ms | 60.00 | rocketsim |
| **preinstall-debug042-gate-004** | **0** | **none** | — | — | **65.15** | systemui |
| **preinstall-debug042-gate-005** | **0** | **none** | — | — | **64.85** | systemui |

**The two samples with the highest compositor frame rate in the entire series had no app rendering
at all.** That is the concrete demonstration that compositor FPS is insufficient: a criterion built
on PxrMetric — at any threshold — passes gates 004 and 005, where the app was not even running.
The proposed criterion fails them for the right reason.

## Rendering *and* progressing, confirmed visually

Two frames were opened, 27s apart, both under the diagnostic exception:

- `diag-liveness-001.png` — passthrough room, wooden table carrying the original RocketSim pad and
  rocket, floating Earth showing Africa/Europe, MISSION CONTROL panel reading PHASE READY,
  ALTITUDE 0.0 KM, VELOCITY 0 M/S, TARGET MOON. No moon visible.
- `diag-liveness-002.png` — same fixed viewpoint, table, rocket and panel, but **the Earth has
  rotated to the Atlantic/Americas face and the Moon has moved into view beside it.**

So the app is not merely submitting frames: its point-gravity orbit simulation advanced, visibly,
between the two captures. Log-side, the render clock advanced **65,068 ms across a 68.5s span**,
covering the 24.2s *between* the two sampling windows — continuous, with zero stalled samples.

## Exact proposed rule

Evaluated over the **same** fresh unfiltered 20-second `adb -s <serial> logcat -b main` sample,
for an **explicitly named target package** (new: the current gate never names the app, which now
matters because two apps build from this tree).

**Retained unchanged:** host frontmost/unoccluded before and after; clean timed 20s window; zero
`last_known_vsync_start is early more than 1S`; PxrMetric mean FPS ≥ 50 as a **secondary
environment check only** (it is not application FPS and, per the table above, cannot carry liveness).

**Replaced.** Drop ` SPR-SeethroughBufferManager` ≥ 11/s as a *requirement*. Add, from the
per-second watchdog line for the target package:

| ID | Criterion | Observed in 6 positive samples | Proposed threshold |
| --- | --- | --- | --- |
| R1 | Every watchdog sample in the window names the target package, and there are ≥ 18 of them | 20/20, always on target | `focusedThroughout` **and** `onTarget ≥ 18` |
| R2 | `lastRenderTime` is monotonic non-decreasing and advances across the window | 19015–19031 ms | **≥ 18000 ms** |
| R3 | No consecutive pair where `lastRenderTime` fails to advance | 0 stalled | **stalled == 0** |
| R4 | Newest frame is fresh: `max(currentTime − lastRenderTime)` | 15–18 ms | **≤ 100 ms** |

**Not removed, not lowered.** ` SPR-SeethroughBufferManager` is still counted and recorded in every
receipt. If the emitter returns, its rate is reported, and a receipt flags the case "present but
below 11/s" so a future regression stays visible. This is a *substitution of a more specific
measurement*, not a relaxation: the old criterion measured the runtime's seethrough buffer churn —
a system property that says nothing about the app — while R1–R4 measure the app's own rendering.
Thresholds sit at the observed cluster with margin (R2 ≈ 5% below the tightest observation; R4 ≈ 5×
the worst observation, still ~6 frames at 60 Hz).

## Validation behind the proposal

Six positive samples, including three that passed the original gate before the SPR emitter vanished;
two negative samples that the original gate also failed, for which the proposal gives the *correct*
reason; and, in `package-targeted-tooling-001/SELFTEST.json` (31/31), synthetic fixtures proving the
extractor detects a frozen app (lastRenderTime stalled while the runtime clock advances) and rejects
a sample where another app holds focus.

## Limits, stated plainly

- This is an **app-render liveness** criterion. It is not evidence that the seethrough/compositor
  path is healthy, and it does not explain why the SPR emitter disappeared when
  `com.pico.spatial.runtime` PID1257 was replaced. It stops *depending* on that signal.
- The frozen-app negative is synthetic. The app was not frozen on the live device to prove it.
- PxrMetric remains not application FPS.
- Nothing here is native acceptance. Build043 is still not installed.
- R2's threshold is calibrated to a 20-second window and a 1 Hz watchdog; a different window length
  needs it rescaled, not reused.
