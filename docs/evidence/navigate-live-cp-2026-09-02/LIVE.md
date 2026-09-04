# Navigate live checkpoint — bounded scene readiness, 2026-09-04

Date: 2026-09-04

Branch: `navigate-live-cp-2026-09-02`

Base: `ce201e4f877f5f7a8bde14d4535fbfc81ad53f31`

Fix commit: `fd314e79bfc2a01c2eb9b229085cdea093c2a6eb`

Supersedes: `cafd27d9b3163e91fe68a037bf6500fd25a8c644`

Target: `emulator-5554` only

Evidence ceiling: `structural`

External evidence root:
`/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW`

## Outcome

**SCENE-READINESS FIX PROVEN LIVE; CALIBRATION/NAVIGATION BLOCKED FAIL-CLOSED BY THE
TABLE-SPECIFIC GUEST GUIDE PRODUCER.**

The corrected controller queried the real scene with the caller-visible 15-retry, 1000 ms budget.
The fallback BED scene became ready after 3 retries, returned 43 stable anchors, and selected the
only BED anchor. This passes the exact live boundary that the superseded checkpoint could not
cross with its former 2-by-10 ms hardcoded budget.

Both requested actions were then called. `calibrate` and `navigate` each stopped before any camera
input with `guide_not_acquired` because the guest rejected SHOW:

```text
guide_refused: selected TABLE runtime identity drifted
```

The navigation API accepts a free-form target label, but Swan mission table's generated guide
producer validates every SHOW against `selectedTableRuntimeUuid` at `src/missiontable.ts:420`.
The current scene has BED but no TABLE, so the authorized BED fallback cannot be displayed by this
producer. HIDE succeeded, the rejected SHOW proved the terminal guide state hidden, final cleanup
completed, and all returned settled frames are byte-identical clean frames. No drag, key hold, or
`w` was sent.

No calibration receipt, slope, residual, closure, or projection measurement was produced.
`target_centered` and the forward approach did not complete and remain **UNVERIFIED**, not failed
visual claims.

## Code correction

`navigate_to_scene_target` now exposes optional `sceneReadiness` in its real MCP `tools/list`
schema:

| Input | Default | Bounds |
| --- | ---: | ---: |
| `sceneReadiness.maxRetries` | 15 | 0 through 120 |
| `sceneReadiness.pollMs` | 1000 ms | 10 through 60000 ms |

One `query_scene_anchors` call owns the finite polling loop; navigation adds no outer retry loop.
The consecutive-read requirement remains code-owned at two. Exhaustion now stops as
`scene_not_ready`, distinct from `unsupported_backend`, before qemu, guide, capture, or input work.

TDD regressions cover a scene that becomes ready after the measured 7-retry delay, an explicitly
short 6-retry budget that ends as `scene_not_ready`, the exact partial-read trace, absence of side
effects on exhaustion, defaults and maximum bounds, and the schema actually published by an MCP
client's `tools/list`. The RED run failed all three initially targeted cases for the old behavior;
the rebuilt owning suite now passes 107/0. Independent review found no Critical or Important
issues and found no acceptance mismatches between the published registration schema and handler
schema across 20 valid, invalid, default, and boundary cases.

## Guarded preconditions

The first live call was read-only `pico_doctor {}`. It returned `preflight.status: "ok"` and the
same-boot camera proof solved at `2026-09-04T07:07:56.767Z`: focal length 1489 px, principal point
1102.2/961.5 px, eye height 1.81 m, and maximum residual 7.2 px. The only non-pass check was the
read-only Accessibility status `unknown`; the independent focus gate below supplied the required
live host proof.

The immutable Swan receipt was still exact for this boot and process, so it was not reminted:

| Binding | Observed |
| --- | --- |
| Receipt ID | `576a773051f637d2d0d98215ce9d0c20215f9c6efe004094747a95d10024d041` |
| Serial / boot | `emulator-5554` / `84e6cabf-2f79-46e5-aadd-478ab535c5a7` |
| Component | `com.fleet.swanmissiontable/.platform.LaunchActivity` |
| PID / start ticks | `32574` / `7710458` |
| APK SHA-256 | `46dea6a5ce6d1af617fba8099958a4a5e087321a26affcf0e5d7a038ad0dc3fc` |

The host gate passed before any selector click:

| Gate | Observed | Result |
| --- | --- | --- |
| Passive frontmost | Google Chrome PID `66519` | PASS: user app, not loginwindow PID `416` |
| Guardian / boot | `1`; `84e6cabf-2f79-46e5-aadd-478ab535c5a7` | PASS |
| CoreGraphics | On-screen `PICO Emulator - 6.0.0`, PID `12827`, window `16199`, `(0,33)`, 984x1012 | PASS |
| Qemu discovery | `pid_12827.ini`; serial `emulator-5554`; window owner PID `12827`; scale 2 | PASS |
| Supported focus request | Repository `frontmostQemu()` | PASS: no error |
| Independent focus readback | PID `12827` | PASS |

## Target path

### Primary selector

The guarded selector accepted the current receipt and ranked `Livingroom Day` first. It returned
`manual_switch_required` with `select_scene_button was not found`, before any tile click, and
reported `baselineSafe:true`. No coordinate or manual click was substituted.

### Authorized fallback

The run therefore stayed in the bedroom scene and selected the largest horizontal BED.

| Field | Observed |
| --- | --- |
| Query contract | 15 maximum retries, 1000 ms poll, 2 stability reads |
| Status / retries | `ready` / 3 |
| Snapshot | `bdccf8b0ab0e846c69a71c8196957f69e1a012e768abaf53a2d0e0faa6917dfc` |
| Total / matched anchors | 43 / 1 BED |
| Trace / runtime UUID | `anchor-0002` / `70e96e0f-9ca5-4a2b-8821-4607345dd2a3` |
| Bounds | `[1.4014824628829956, 0.39697787165641785, 1.3301914930343628]` m |
| Horizontal area / up dot | 1.8642400497638079 m² / 1.0 |
| Drift | Within policy; all reported transform, rotation, extent, label, topology, and unmatched deltas zero |
| Geometry | 12,332,941 bytes; SHA-256 `519614c152553809cf39e61d185157e61f10bc1267259278957fc13273c71dba` |

## Calibration and navigation results

| Action | Status | Stop | Actions | Calibration | Cleanup |
| --- | --- | --- | ---: | --- | --- |
| `calibrate` | `stopped` | `guide_not_acquired` / TABLE runtime identity drift | 0 | `not_attempted`; no receipt | Hidden proof and final clean settled |
| `navigate` | `stopped` | `guide_not_acquired` / TABLE runtime identity drift | 0 | `not_attempted`; guide context never formed | Hidden proof and final clean settled |

The navigate call was made as requested. Because SHOW was rejected before a guide-on frame, the
tool did not reach calibration lookup or any controller mode. `achievedClaims` is empty for both
calls.

### Guide acknowledgement timing

The budget remains 30 polls by 100 ms = 3000 ms. Every HIDE or rejected SHOW receipt reached the
required two stable reads in two attempts.

| Action / transaction | Ack-pull time | Broadcast start to stable ack | Margin to 3000 ms |
| --- | ---: | ---: | ---: |
| Calibrate preflight HIDE | 151.573 ms | 183.655 ms | 2816.345 ms |
| Calibrate SHOW rejection | 150.336 ms | 175.815 ms | 2824.185 ms |
| Navigate preflight HIDE | 160.059 ms | 189.780 ms | 2810.220 ms |
| Navigate SHOW rejection | 150.963 ms | 173.316 ms | 2826.684 ms |

Worst observed end-to-end acknowledgement was 189.780 ms, leaving 2810.220 ms, or 93.67% of the
budget, unused. This measures protocol acknowledgement latency only; SHOW was acknowledged as a
guest rejection, not as a visible guide.

### Requested fit and projection report

| Measurement or claim | Result | Gate or reason |
| --- | --- | --- |
| Drag to yaw slope | **UNMEASURED** | SHOW rejected before trial route; minimum gate 0.01 deg/px |
| Drag to pitch slope | **UNMEASURED** | SHOW rejected before trial route; minimum gate 0.01 deg/px |
| Hold to displacement slope | **UNMEASURED** | SHOW rejected before trial route; minimum gate 0.0005 m/ms |
| Normalized RMSE | **UNMEASURED** | No fit; v2 maximum 20% |
| Maximum normalized residual | **UNMEASURED** | No fit; v2 maximum 25% |
| Yaw/pitch/forward R-squared | **UNMEASURED** | No fit; v2 minimum 0.95 |
| Per-pair restore closure | **UNMEASURED** | No trial or restore; v2 maximum 25% |
| Final closure | **UNMEASURED** | No calibration route; v2 maximum 12.5% |
| Projection/depth maximum | **UNMEASURED** | No guide-on frame; 12% gate unchanged and not loosened |
| Aspect maximum | **UNMEASURED** | No guide-on frame; 12% gate unchanged and not loosened |
| `target_centered` | **UNVERIFIED / did not complete** | No acquisition or centering action |
| Acknowledged `w` approach | **UNVERIFIED / did not complete** | No v2 calibration and no key action |

## LOOKed ordered settled frames

Every settled frame returned by both actions was opened at original resolution. Each LOOK showed
the same clean bedroom: the bed centered, lamp/window to the left, shelving to the right, and no
magenta/cyan navigation guide. Byte identity corroborates, but does not replace, these LOOKs.

| Order | Action / phase | Absolute path | Bytes | SHA-256 |
| ---: | --- | --- | ---: | --- |
| 1 | Calibrate guide-off | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/navigation-bed-calibrate/guide-off.png` | 3,946,221 | `d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb` |
| 2 | Calibrate final-clean | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/navigation-bed-calibrate/final-clean.png` | 3,946,221 | `d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb` |
| 3 | Navigate guide-off | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/navigation-bed-navigate/guide-off.png` | 3,946,221 | `d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb` |
| 4 | Navigate final-clean | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/navigation-bed-navigate/final-clean.png` | 3,946,221 | `d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb` |

Guide-on, acquisition waypoints, calibration waypoints, navigation waypoints, and final-diagnostic
frames are null/empty because the exact SHOW transaction rejected while also proving the guide
hidden. `record_verification` was not called. The evidence class remains structural.

## External evidence artifacts

| Artifact | Absolute path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Initial read-only doctor | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/01-pico-doctor.json` | 8,929 | `9b42cab158ffd2570b1fac4e1e5e2dd7d06709883fb2b29b63ae60ae14c850fc` |
| Initial device state | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/02-readonly-state.json` | 594 | `e7dc5702e631f83d72b15a542a404b7a093c038ffb067d35bf46cf1b65e90c77` |
| Focus/window gate | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/03-focus-gate.json` | 2,316 | `69b631ec4234c7533d1efddac99b51660bd33fe3bb085074131f4be031dc173b` |
| Guarded selector | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/04-select-livingroom-day.json` | 80,414 | `37e6659cac94267cde146a12f628a48cfd57360dbba26377b983858c003193dd` |
| Stable BED query | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/05-query-bed.json` | 58,777 | `7bde5c30e4b9f9f4110c8bb2827971a5de164f5cf9361ecb1cba9353e9689058` |
| BED query geometry | `/private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-scene-session-Z1bMW0/scene-41-e140c9ac9f8a46f38e77c5a046025888.json` | 12,332,941 | `519614c152553809cf39e61d185157e61f10bc1267259278957fc13273c71dba` |
| Calibrate call/result | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/06-navigate-bed-calibrate.json` | 56,894 | `5777658953ab3c4569a7975c2a6e56dfbabd40b32caf262b9dd031acfc6e40d3` |
| Navigate call/result | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/07-navigate-bed.json` | 56,882 | `2bcbd4340c0a2f33a1a3c366babf24315f9f237eefb828951f20a220b6e3fd68` |
| Terminal device state | `/private/tmp/pico-navigate-live-retrycp-20260904.bqdOZW/08-terminal-state.json` | 594 | `12618edb435c578905038cd18d47d19f6bd37a3e27bd112cff4bb8857698f3fe` |

## Terminal state and cleanup

The terminal read-only state is baseline-safe:

- `emulator-5554` remains online on boot `84e6cabf-2f79-46e5-aadd-478ab535c5a7`.
- Guardian/VST/debug remains `1/1/1`.
- `/data/misc/user/0/boundary/localmode` remains absent.
- `com.fleet.swanmissiontable/.platform.LaunchActivity` remains foreground.
- Both failed SHOW acknowledgements report `guideState:"hidden"`,
  `cleanupState:"completed"`, and `cleanupProven:true`.
- No process was force-stopped, no camera drag was attempted, and no key was sent.

## UNVERIFIED updates

| Item | Status after this checkpoint |
| --- | --- |
| U4 drag calibration stability | **Open.** No live yaw, pitch, or hold fit was produced. |
| Viewer-facing guide projection | **Open.** The guide never rendered; the 12% gate was neither exercised nor loosened. |
| Livingroom Day TABLE acquisition | **Open.** The selector failed before a tile click. |
| Bedroom BED scene readiness | **Proven structural.** The corrected controller crossed the real 3-retry population delay and selected the BED. |
| Bedroom BED guide acquisition | **Blocked.** Swan's producer is TABLE-specific and rejected the BED UUID. |
| Bounded target centering | **Open live.** No controller action occurred. |
| Calibrated forward approach | **Open live.** No calibration receipt was written and no `w` was sent. |
| Ordered navigation LOOK evidence | **Partial.** All four returned clean frames were LOOKed; no guide-on or waypoint frame exists. |
| Hardware behavior | **Out of scope.** No physical serial was targeted. |

## Repository gates

- `npm run build`: passed before every test invocation.
- `node --test test/navigationtarget.mjs`: 107 passed, 0 failed.
- `npm run test:emulator-restart`: 259 passed, 0 failed, 1 skipped.
- `npm run test:docsmeta`: 0 failures.
- `npm run test:adoption-safety`: 48 checks, 0 failures.
- `npm run test:distribution-adoption`: 41 passed and exactly the 2 known-only baseline failures:
  Linux gate invocations 45 versus stale 44, and test scripts 48 versus stale 46.
- Runtime-measured macOS tools: full 254, doors 18; `navigate_to_scene_target` remains full-only.
  The unchanged three-tool host-GUI delta leaves the source-derived Linux/Windows count at 251.
- Tool-count chain, package version, npm script keys, manifests, `package-lock.json`,
  `benchmarks/**`, and `test/agentbench-*` are unchanged.
- Tarball was not rerun because no tool or test count changed.

## Deviations

- **Primary-to-fallback path:** ran exactly as authorized. The selector failed baseline-safe before
  a click, so the current scene's sole BED was selected.
- **Receipt/calibration remint:** not needed. PID, start ticks, APK SHA, serial, boot, component,
  and receipt binding all remained exact; the receipt-bound scene query accepted them.
- **Full calibration:** blocked before trials by the TABLE-specific guest producer. No fit or
  calibration receipt can honestly be reported.
- **Projection gate:** not loosened. It was not reached because no guide-on frame existed.
- **Evidence:** heavy frames and call receipts remain outside the repository; only this markdown
  index is committed.
