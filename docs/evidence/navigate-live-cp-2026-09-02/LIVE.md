# Navigate live checkpoint — 2026-09-02

Date: 2026-09-02

Branch: `navigate-live-cp-2026-09-02`

Base: `ce201e4f877f5f7a8bde14d4535fbfc81ad53f31`

Target: `emulator-5554` only

Evidence ceiling: `structural`

External evidence root:
`/private/tmp/pico-navigate-live-cp-2026-09-02.fresh-receipt.KDjl7V`

## Outcome

**BLOCKED — baseline-safe at the guarded host selector.** This record supersedes the `54f5e56`
receipt-mismatch checkpoint. The corrected unlocked-session and qemu-focus/readback gates passed,
and the authorized
`fleet_build {briefIds:["swanmissiontable"],settleSec:12}` call minted a fresh exact-boot runtime
receipt. The selector accepted that receipt, completed a stable receipt-bound 41-anchor pre-query,
and ranked `Livingroom Day` first.

The selector then returned `manual_switch_required` with
`detail: "select_scene_button was not found"` and `baselineSafe: true`. It did not click a tile or
produce a post-switch snapshot. `pico_fix` found no retained diagnosis or supported recovery for
that exact error. An unguarded/manual click was not substituted.

Livingroom Day was therefore not receipt-bound, and the prerequisite current-scene TABLE query,
navigation calibration, and navigation call were not run. No navigation guide or camera input was
issued, and the 12% projection gate was neither exercised nor loosened.

## Guard and fresh receipt

The first device-facing operation in this authorized continuation was a persisted read-only
`pico_doctor {}` call. It returned `preflight.status: "ok"` and `environment looks healthy`;
emulator, gRPC, and capture-camera calibration checks passed. Accessibility remained honestly
`unknown`.

| Gate | Required | Observed | Result |
| --- | --- | --- | --- |
| Passive pre-focus application | A real user app, not `loginwindow` PID `416` | Visual Studio Code PID `66551` | PASS — unlocked |
| Guardian | `sys.guardian.vst.status == 1` | `1` | PASS |
| Guest boot | `549c2de4-e387-4970-a5de-08ba124bd202` | Exact full ID matched | PASS |
| Serial/discovery/window bind | `emulator-5554` → qemu PID/window owner `87242` | PID `87242`, window `9850`, discovery correlation | PASS |
| Supported qemu focus | Repository `frontmostQemu()` request | `focusError: null` | PASS |
| Repository focus readback | Exactly `87242` | `87242` | PASS |
| Independent passive readback | Exactly `87242` | `87242` | PASS |

The fresh native run receipt is:

| Field | Exact value |
| --- | --- |
| Receipt ID | `2c78e53680d382d3baa151af1f243e66f4d102194ac02f4db004b67706f1e515` |
| Receipt path | `/Users/sushantsrikrish/.pico-mcp/run-receipts/native-v1/com.fleet.swanmissiontable/2c78e53680d382d3baa151af1f243e66f4d102194ac02f4db004b67706f1e515.json` |
| Package/component | `com.fleet.swanmissiontable/.platform.LaunchActivity` |
| Serial / boot | `emulator-5554` / `549c2de4-e387-4970-a5de-08ba124bd202` |
| PID / start ticks | `10824` / `14887248` |
| APK SHA-256 | `46dea6a5ce6d1af617fba8099958a4a5e087321a26affcf0e5d7a038ad0dc3fc` |
| Capture size | 2160x2158 |
| Structural build status | built, installed, receipt recorded |
| Fleet visual verdict | `ESCALATE` pending LOOK; no automated visual PASS was claimed |

## LOOKed build frame

The exact fresh-receipt build frame was opened at original resolution. It visibly shows a bed and
bedroom-style interior, with the Swan lunar diorama rendered on a dark plinth in the foreground.
This LOOK supports only that pixel description; it does not prove a scene-understanding TABLE
label, target centering, projection calibration, or navigation.

| Order | Phase/frame | Absolute path | Bytes | SHA-256 | LOOK result |
| ---: | --- | --- | ---: | --- | --- |
| 0 | Fresh Swan build receipt | `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/4df84592aa891f32a330eb9d0c1c9d2ab74b4f9233086adfa38a449215a61405.png` | 3,719,711 | `4df84592aa891f32a330eb9d0c1c9d2ab74b4f9233086adfa38a449215a61405` | Bed/interior visible; lunar diorama visible on foreground plinth |

No ordered navigation frame was produced, so there are no guide-off, guide-on, acquisition,
calibration-waypoint, navigation-waypoint, final-diagnostic, or final-clean frames to LOOK.
`record_verification` was not called and no evidence was promoted beyond structural.

## Receipt-bound scene and guarded selector

Using the fresh receipt, the selector's pre-switch query bound the exact boot, APK, PID, start
ticks, foreground component, Mixed stage, and `stage` root before reading the bridge payload.

| Selector fact | Observed value |
| --- | --- |
| Selected ranking target | `Livingroom Day` |
| Pre-query status | `ready` |
| Snapshot ID | `8b9d064c651f38dd7713ab667126b11d0bd50cf7324122d92e992132ce023332` |
| Tracking / drift | `RUNNING`; two-read drift within policy |
| Total anchors | 41 |
| Requested-label matches | 2: one FLOOR and one WALL_ART |
| TABLE count | 0 |
| Geometry bytes / SHA-256 | 11,165,203 / `8dc72c85108bb81b997af7ad81978d1ebd3f7a16a707be0e4700cbf8fa9fc65b` |
| Verification baseline | Complete and bound to the fresh receipt/boot/snapshot |
| WorldSpace marker | Emitted and observed for the pre-snapshot nonce |
| Host selection status | `manual_switch_required` |
| Host selection detail | `select_scene_button was not found` |
| Baseline safe | `true` |
| Tile clicked / post-snapshot | No / `null` |

The exact selector error was passed to `pico_fix`. It returned `matchedSymptom: null`,
`diagnosis.status: "no-symptom-match"`, and no retained-lesson violation. The checkpoint stopped
instead of inventing a host-control route.

## External evidence artifacts

| Artifact | Absolute path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Doctor call/result | `/private/tmp/pico-navigate-live-cp-2026-09-02.fresh-receipt.KDjl7V/pico-doctor.json` | 8,918 | `71afab90f8d9283d878ef4873f5ba2a27bf81c4a351b9e055bda4519ce37db12` |
| Fleet build call/result | `/private/tmp/pico-navigate-live-cp-2026-09-02.fresh-receipt.KDjl7V/fleet-build.json` | 6,678 | `3857f6dc6515c840e4a42d0d963cc93ac053dc4fac6e872be3dd3cd9ee39f9f5` |
| Fresh immutable run receipt | `/Users/sushantsrikrish/.pico-mcp/run-receipts/native-v1/com.fleet.swanmissiontable/2c78e53680d382d3baa151af1f243e66f4d102194ac02f4db004b67706f1e515.json` | 11,764 | `f18140aa1c385c8027dd77bc93c5b8525b5616a9812789059d4a891f96c6b3ba` |
| LOOKed build frame | `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/4df84592aa891f32a330eb9d0c1c9d2ab74b4f9233086adfa38a449215a61405.png` | 3,719,711 | `4df84592aa891f32a330eb9d0c1c9d2ab74b4f9233086adfa38a449215a61405` |
| Selector call/result | `/private/tmp/pico-navigate-live-cp-2026-09-02.fresh-receipt.KDjl7V/select-livingroom-day.json` | 80,596 | `afa543dbd85ec05d3a0a1386a91a08264818fe3dd1ef72d07e67ddb538bdbec9` |
| Pre-switch lossless geometry | `/private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-scene-session-OLtluQ/scene-41-15eddcfae0124f2d9005ddd3f1dd3bbc.json` | 11,165,203 | `8dc72c85108bb81b997af7ad81978d1ebd3f7a16a707be0e4700cbf8fa9fc65b` |
| `pico_fix` call/result | `/private/tmp/pico-navigate-live-cp-2026-09-02.fresh-receipt.KDjl7V/pico-fix-select-scene-button.json` | 1,437 | `92f64758a16ffab3465ebc81b022c57c1bb20cb0b4f530bdd325eaf422ea9b4c` |
| Checkpoint summary | `/private/tmp/pico-navigate-live-cp-2026-09-02.fresh-receipt.KDjl7V/checkpoint-summary.json` | 3,928 | `ce9638d693bc4e11764e001f545494e863ced10b2d8ce7e05845bc48b9a0209e` |
| Existing capture-camera calibration | `/Users/sushantsrikrish/.pico-mcp/camera-calibration.json` | 298 | `263ec383365d14ee16ecd80507cc1ce8bf6a1639036f5ba0bea6df5f227a33df` |

## Actions not run after the blocker

- Livingroom Day was not clicked or verified from a changed post-switch scene.
- No receipt-bound post-switch TABLE query exists.
- `navigate_to_scene_target {action:"calibrate"}` was not called.
- `navigate_to_scene_target {action:"navigate"}` was not called.
- No navigation-guide HIDE/SHOW acknowledgement was requested.
- No look drag, pitch drag, `w` hold, or inverse restore was requested.
- No process was force-stopped and no unguarded host click was attempted.
- No command targeted a physical serial.

## Requested metrics and claims

| Measurement or claim | Live result | Reason |
| --- | --- | --- |
| Drag to yaw slope and margin over 0.01 deg/px | **UNMEASURED** | Selector stopped before calibration |
| Drag to pitch slope and margin over 0.01 deg/px | **UNMEASURED** | Selector stopped before calibration |
| Hold to displacement slope and margin over 0.0005 m/ms | **UNMEASURED** | Selector stopped before calibration |
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
| Livingroom Day TABLE selection | **Open for this attempt.** It ranked first, but the guarded host control was absent and no switch occurred. |
| Bounded target acquisition and centering | **Open live.** No controller action or waypoint exists. |
| Calibrated forward approach | **Open live.** No navigation-calibration receipt was created or replayed and no `w` was sent. |
| Ordered navigation LOOK evidence | **Open.** No navigation frame exists. |
| Hardware behavior | **Out of scope.** No command targeted a physical serial. |

## Repository gates

The branch changes only this `LIVE.md` relative to `54f5e56`.

- `npm run build`: passed immediately before every test command.
- `npm run test:docsmeta`: 0 failures.
- `npm run test:adoption-safety`: 48 checks, 0 failures.
- `npm run test:distribution-adoption`: 41 passed and the same 2 known-only baseline count
  assertions: Linux gate invocations 45 versus stale 44, and test scripts 48 versus stale 46.
- Tarball gate: not rerun because this checkpoint changes no tool or test count and no product or
  distribution file.
- `benchmarks/**` and `test/agentbench-*`: byte-unchanged from `ce201e4`.
- `git diff --cached --check`: run after staging and before the checkpoint commit.

## Terminal state

The corrected focus gate and fresh-receipt creation both completed. The selector stopped at its
guarded host-control boundary before a tile click. The fresh Swan app remained the owned foreground
guest state; no guide, calibration, navigation, or camera action followed the selector stop.
