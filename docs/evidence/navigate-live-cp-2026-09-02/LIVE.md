# Navigate live checkpoint — 2026-09-02

Date: 2026-09-02

Branch: `navigate-live-cp-2026-09-02`

Base: `ce201e4f877f5f7a8bde14d4535fbfc81ad53f31`

Target: `emulator-5554` only

Evidence ceiling: `structural`

Resumed external evidence root:
`/private/tmp/pico-navigate-live-cp-2026-09-02.resumed.lrRRVe`

## Outcome

**BLOCKED — baseline-safe at receipt binding.** This record supersedes the earlier `b3b9a90`
interpretation of the initial frontmost-PID gate. PID `66551` was Visual Studio Code, a real user
application rather than `loginwindow` PID `416`, so it correctly established an unlocked session.
The repository-supported qemu-focus request then succeeded and its fail-closed readback, followed by
an independent passive readback, both identified qemu PID `87242`. Guardian and boot identity also
remained exact.

The guarded Livingroom Day selector was then called with the existing same-boot Swan build receipt.
It ranked `Livingroom Day`, but its receipt-bound pre-switch scene query returned
`binding_failed`: the live Swan process session no longer matched the immutable native run receipt.
The selector returned `verification_failed` at `failurePhase: "pre_query"`, with no baseline,
marker, or host-selection receipt. It therefore did not open the environment picker or click a
tile.

A read-only receipt-store diagnosis found no immutable receipt for the live PID/start-tick pair.
Per the stop rule, no rebuild, relaunch, switch, calibration, guide transition, capture, or camera
input followed this failure.

## Corrected guarded host gate

The first device-facing operation for this checkpoint remained the read-only `pico_doctor {}` call
recorded by `b3b9a90`; it reported a healthy environment, with emulator, gRPC, and capture-camera
calibration checks passing. Accessibility remained honestly `unknown`.

| Gate | Required | Observed | Result |
| --- | --- | --- | --- |
| Passive pre-focus application | Any real user app; reject `loginwindow` PID `416` | Visual Studio Code PID `66551` | PASS — unlocked session |
| Guardian | `sys.guardian.vst.status == 1` | `1` | PASS |
| Guest boot | `549c2de4-e387-4970-a5de-08ba124bd202` | Exact full ID matched | PASS |
| Serial/discovery/window bind | `emulator-5554` → qemu PID/window owner `87242` by discovery correlation | PID `87242`, CoreGraphics window `9850`, x=0, y=33, 816x844, scale 2 | PASS |
| Supported qemu focus | Repository `frontmostQemu()` focus request | `focusError: null` | PASS |
| Repository focus readback | Exactly qemu PID `87242` | `87242` | PASS |
| Independent passive readback after focus | Exactly qemu PID `87242` | `87242` | PASS |
| Guardian and boot after focus | Still `1` and same full boot ID | `1`; `549c2de4-e387-4970-a5de-08ba124bd202` | PASS |

The focus operation used the merged repository path: `bindMacQemuWindow()` first established the
exact serial/discovery/CoreGraphics identity, then `frontmostQemu()` issued the supported
`osascript` focus request and rejected any mismatched readback.

## Guarded selector and terminal receipt mismatch

The selector request used:

```json
{
  "action": "switch",
  "briefId": "swanmissiontable",
  "runtime": {
    "serial": "emulator-5554",
    "packageName": "com.fleet.swanmissiontable",
    "expectedBuildReceiptId": "6c8c2623dfe6f75a2a45a8ea20f504b9f2d7ea3f6e7699f1291b4ae62eb26153",
    "expectedStageStyle": "Mixed"
  }
}
```

| Selector fact | Observed value |
| --- | --- |
| Ranked target | `Livingroom Day` |
| Result | `verification_failed` |
| Failure phase | `pre_query` |
| Error code | `bridge_binding_failed` |
| Detail | `live process identity does not match the native run receipt session` |
| Pre-query status | `binding_failed` with zero bridge retries |
| Verification baseline | `null` |
| WorldSpace marker | `null` |
| Host selection | `null` |

The immutable same-boot receipt binds package PID `3478` and start ticks `1599914`. The live Swan
process was PID `6469` with start ticks `8949576`. No other stored Swan run receipt binds that live
pair. Rebuilding or relaunching to mint a new run receipt would be an additional state change after
the explicit blocker, so it was not attempted.

## External evidence artifacts

| Artifact | Absolute path | Bytes | SHA-256 | Meaning |
| --- | --- | ---: | --- | --- |
| Raw resumed selector call/result | `/private/tmp/pico-navigate-live-cp-2026-09-02.resumed.lrRRVe/select-livingroom-day.json` | 16,639 | `42a011bd4b267b822e367d6cb029f7de947dece82a5eed4b97e39fa6a33b9573` | Exact MCP request and full fail-closed response |
| Resumed guard/binding record | `/private/tmp/pico-navigate-live-cp-2026-09-02.resumed.lrRRVe/resumed-guard-and-binding.json` | 3,182 | `76619ee1ae7142788ce0d83b6ee589fb54ec61864222baa16d39331445a95e84` | Post-stop transcription of already returned focus, readback, selector, and receipt-diagnosis outputs; no command was rerun to create it |
| Earlier passive guard record | `/private/tmp/pico-navigate-live-cp-2026-09-02.blocked-20260902T214607Z/guard-observations.json` | 2,979 | `41ce9d513ad04ef8884b2a0d56b464bc14b6b067449570a4446d6cd848b2283b` | Preserves the original doctor/passive-precondition outputs; its terminal interpretation is superseded here |
| Existing capture-camera calibration | `/Users/sushantsrikrish/.pico-mcp/camera-calibration.json` | 298 | `263ec383365d14ee16ecd80507cc1ce8bf6a1639036f5ba0bea6df5f227a33df` | Existing 2160x2158 camera model (`f=1489`, `cx=1102.2`, `cy=961.5`, residual ceiling 7.2 px); not navigation calibration |

No ordered navigation frame was created or LOOKed. There are no guide-off, guide-on, acquisition,
calibration-waypoint, navigation-waypoint, final-diagnostic, or final-clean paths or SHA-256 values
for this attempt. `record_verification` was not called.

## Actions not run after the blocker

- No environment picker was opened and Livingroom Day was not clicked or receipt-bound.
- No post-switch TABLE query exists.
- `navigate_to_scene_target {action:"calibrate"}` was not called.
- `navigate_to_scene_target {action:"navigate"}` was not called.
- No navigation-guide HIDE/SHOW acknowledgement was requested.
- No look drag, pitch drag, `w` hold, or inverse restore was requested.
- No app was rebuilt, reinstalled, relaunched, or force-stopped.
- No command targeted a physical serial.

## Requested metrics and claims

| Measurement or claim | Live result | Reason |
| --- | --- | --- |
| Drag to yaw slope and margin over 0.01 deg/px | **UNMEASURED** | Selector failed before calibration |
| Drag to pitch slope and margin over 0.01 deg/px | **UNMEASURED** | Selector failed before calibration |
| Hold to displacement slope and margin over 0.0005 m/ms | **UNMEASURED** | Selector failed before calibration |
| Per-axis normalized RMSE versus 20% | **UNMEASURED** | No v2 fit |
| Per-axis maximum normalized residual versus 25% | **UNMEASURED** | No v2 fit |
| Per-pair restore closure versus 25% | **UNMEASURED** | No trials or restores |
| Final closure versus 12.5% | **UNMEASURED** | No calibration route |
| Maximum projection/depth error versus 12% | **UNMEASURED** | No guide frame |
| Maximum aspect error versus 12% | **UNMEASURED** | No guide frame |
| Guide acknowledgement latency versus 30 by 100 ms | **UNMEASURED** | Guide protocol was not invoked |
| `target_centered` | **UNVERIFIED** | Navigation was not invoked |
| Acknowledged `w` approach | **UNVERIFIED** | Navigation was not invoked |

## UNVERIFIED updates

| Item | Status after this checkpoint |
| --- | --- |
| U4 drag calibration stability | **Open.** No live v2 drag/hold fit or residual was measured. |
| Viewer-facing guide projection | **Open.** No guide pixels were captured; the 12% gate was not exercised or loosened. |
| Livingroom Day TABLE selection | **Open for this attempt.** It ranked first, but no host switch or receipt-bound post-switch scene exists. |
| Bounded target acquisition and centering | **Open live.** No controller action or waypoint exists. |
| Calibrated forward approach | **Open live.** No receipt was created or replayed and no `w` was sent. |
| Ordered LOOK evidence | **Open.** There are no checkpoint frames to inspect. |
| Hardware behavior | **Out of scope.** No command targeted a physical serial. |

## Repository gates

The branch changes only this `LIVE.md` relative to its previous checkpoint commit.

- `npm run build`: passed before every test command.
- `npm run test:docsmeta`: 0 failures.
- `npm run test:adoption-safety`: 48 checks, 0 failures.
- `npm run test:distribution-adoption`: 41 passed and the same 2 known-only baseline count
  assertions: Linux gate invocations 45 versus stale 44, and test scripts 48 versus stale 46.
- `benchmarks/**` and `test/agentbench-*`: byte-unchanged from `ce201e4`.
- `git diff --cached --check`: passed.

## Terminal state

The corrected focus gate completed exactly as required. The later immutable receipt/live-process
identity mismatch was the terminal fail-closed outcome. The selector stopped before host selection;
no process was force-stopped, no guest app lifecycle was changed, no guide was shown, and no camera
or keyboard input was sent after the authorized qemu-focus request.
