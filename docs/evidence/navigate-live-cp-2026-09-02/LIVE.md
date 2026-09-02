# Navigate live checkpoint — 2026-09-02

Date: 2026-09-02

Branch: `navigate-live-cp-2026-09-02`

Base: `ce201e4f877f5f7a8bde14d4535fbfc81ad53f31`

Target: `emulator-5554` only

Evidence ceiling: `structural`

Checkpoint stop recorded at: `2026-09-02T21:46:07Z`

External evidence root:
`/private/tmp/pico-navigate-live-cp-2026-09-02.blocked-20260902T214607Z`

## Outcome

**BLOCKED — baseline-safe.** The checkpoint stopped at the first guarded host-identity gate. The
passive macOS frontmost-application read returned PID `66551`, the Visual Studio Code host process,
instead of the required qemu PID `87242`. No attempt was made to focus qemu because changing host
focus would violate the read-only initial gate.

The other values observed in the same guard phase matched their required baselines: the guardian
property was `1`, the full guest boot ID was
`549c2de4-e387-4970-a5de-08ba124bd202`, and the Swan mission-table activity was resumed. Those
independent passes do not override the frontmost-PID failure.

No environment picker, guide transition, capture, camera action, calibration trial, navigation
action, or verification write followed the failed gate.

## Guarded baseline and stop

The first device-facing operation was the required read-only `pico_doctor {}` call through the
freshly built full-surface server.

| Gate | Required | Observed | Result |
| --- | --- | --- | --- |
| `pico_doctor {}` | Healthy read-only baseline | `preflight.status: "ok"`; summary `environment looks healthy`; emulator, gRPC, and calibration checks passed | PASS |
| Accessibility diagnostic | Do not assume availability | `unknown`; doctor warned that free-camera drags can be silently dropped | HONESTLY UNKNOWN |
| Target emulator process | qemu PID `87242` | PID `87242` exists at the PICO 6.0 `qemu-system-aarch64` binary | PASS |
| Passive host frontmost PID | Exactly `87242` | `66551` | **FAIL — TERMINAL** |
| Observed frontmost process | qemu | `/Applications/Visual Studio Code 2.app/Contents/MacOS/Code` | **FAIL — TERMINAL** |
| `sys.guardian.vst.status` | `1` | `1` | PASS |
| Guest boot ID | `549c2de4-e387-4970-a5de-08ba124bd202` | `549c2de4-e387-4970-a5de-08ba124bd202` | PASS |
| Swan guest activity | `com.fleet.swanmissiontable/.platform.LaunchActivity` resumed | Exact Swan activity resumed; `com.pxr.scenarioprovider/com.unity3d.player.UnityPlayerActivity` was also resumed on its display | PASS for required Swan presence |
| Stop decision | Stop before mutation if any gate fails | Stopped before selector or navigation | PASS |

The repository's `frontmostQemu` action helper was deliberately not called: it first sends an
`osascript` focus request and only then reads the frontmost PID. The checkpoint's initial gate
requires a passive confirmation, not a focus mutation.

## External evidence artifacts

No new external session root was allocated because the stop occurred before selector/session
mutation. No ordered navigation frames were created or LOOKed.

The existing camera-calibration file was inspected read-only to bind the doctor result to the
previous same-camera proof. It is not a new navigation frame or a new visual claim.

| Artifact | Absolute path | Bytes | SHA-256 | Meaning |
| --- | --- | ---: | --- | --- |
| Guard observation record | `/private/tmp/pico-navigate-live-cp-2026-09-02.blocked-20260902T214607Z/guard-observations.json` | 2,979 | `41ce9d513ad04ef8884b2a0d56b464bc14b6b067449570a4446d6cd848b2283b` | Post-stop transcription of the already returned doctor and guard outputs; no command was rerun to create it |
| Existing capture-camera calibration | `/Users/sushantsrikrish/.pico-mcp/camera-calibration.json` | 298 | `263ec383365d14ee16ecd80507cc1ce8bf6a1639036f5ba0bea6df5f227a33df` | Existing 2160x2158 camera model (`f=1489`, `cx=1102.2`, `cy=961.5`, residual ceiling 7.2 px); not navigation calibration |

There are no guide-off, guide-on, acquisition, calibration-waypoint, navigation-waypoint,
final-diagnostic, or final-clean paths or SHA-256 values for this attempt.

## Actions not run

- `select_home_environment` was not called; Livingroom Day was not clicked or receipt-bound.
- `query_scene_anchors` was not called after a switch, so no current Livingroom `TABLE` result exists.
- `navigate_to_scene_target {action:"calibrate"}` was not called.
- `navigate_to_scene_target {action:"navigate"}` was not called.
- No navigation-guide HIDE/SHOW acknowledgement was requested.
- No look drag, pitch drag, `w` hold, or inverse restore was requested.
- No capture was available for a LOOK.
- `record_verification` was not called.

## Requested metrics and claims

| Measurement or claim | Live result | Reason |
| --- | --- | --- |
| Drag to yaw slope and margin over 0.01 deg/px | **UNMEASURED** | Guard failed before calibration |
| Drag to pitch slope and margin over 0.01 deg/px | **UNMEASURED** | Guard failed before calibration |
| Hold to displacement slope and margin over 0.0005 m/ms | **UNMEASURED** | Guard failed before calibration |
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
| Viewer-facing guide projection | **Open.** No guide pixels were captured; the 12% gate was not exercised. |
| Livingroom Day TABLE selection | **Open for this attempt.** The guarded selector was never entered. |
| Bounded target acquisition and centering | **Open live.** No controller action or waypoint exists. |
| Calibrated forward approach | **Open live.** No receipt was created or replayed and no `w` was sent. |
| Ordered LOOK evidence | **Open.** There are no checkpoint frames to inspect. |
| Hardware behavior | **Out of scope.** No command targeted a physical serial. |

## Repository gates

- `npm ci`: completed in the new worktree; package version remains `37.0.0`.
- `npm run build`: passed before the live sequence and again before every test command.
- `npm run test:docsmeta`: 0 failures.
- `npm run test:adoption-safety`: 48 checks, 0 failures.
- `npm run test:distribution-adoption`: 41 passed and the same 2 known-only baseline count
  assertions: Linux gate invocations 45 versus stale 44, and test scripts 48 versus stale 46.
- `benchmarks/**` and `test/agentbench-*`: byte-unchanged from `ce201e4`.
- The branch changes only this `LIVE.md`; `git diff --cached --check` passes.

## Terminal guard outcome and final state

The terminal outcome was the designed mandatory early stop caused by the frontmost-PID mismatch.
The selector and navigation phases were intentionally not attempted. No process was force-stopped,
no host focus was changed, no guest package was launched or stopped, and no emulator input was sent.
The guest therefore remained on the observed Swan mission-table state with guardian value `1` and
the same boot ID at the last permitted probe.
