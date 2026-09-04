# Navigate live checkpoint — cold boot 2026-09-04

Date: 2026-09-04

Branch: `navigate-live-cp-2026-09-02`

Base: `ce201e4f877f5f7a8bde14d4535fbfc81ad53f31`

Supersedes: `f768155f595b7144c560be3b3add06dbb1223c32`

Target: `emulator-5554` only

Evidence ceiling: `structural`

External evidence root:
`/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7`

## Outcome

**BLOCKED — baseline-safe before navigation-guide or camera mutation.** No receipt, camera proof,
or navigation calibration from boot `549c2de4-e387-4970-a5de-08ba124bd202` was reused. A new
capture-camera model and Swan native-run receipt were created on boot
`84e6cabf-2f79-46e5-aadd-478ab535c5a7`.

The primary Livingroom Day selector path ranked the requested environment first but again returned
`manual_switch_required` before a click because `select_scene_button was not found`. Per the
authorized fallback, the run continued in the current bedroom environment. A receipt-bound query
returned one stable BED anchor among 43 anchors, so the fallback target was available.

`navigate_to_scene_target {action:"calibrate"}` then stopped before application binding, qemu
binding, guide mutation, capture, or camera action with:

```text
unsupported_backend: unfiltered mesh remained empty or lacked consecutive non-empty reads
```

The cause is reproduced at the controller's exact internal scene-query settings. The successful
public BED query required 7 polls with a 1000 ms interval; `sceneQueryInput()` in
`src/navigationtarget.ts` fixes the controller query at only 2 polls with a 10 ms interval. A
separate receipt-bound query at exactly 2 by 10 ms returned `not_ready`, 0 anchors, and the same
error. The calibration result contains no session, guide transition, capture, action, fit, or
published receipt. `pico_fix` has no retained match for the error.

Because no v2 navigation-calibration receipt was written, the subsequent `navigate` action was not
called. `target_centered` and the acknowledged `w` approach are therefore unverified rather than
failed visual claims.

## New-boot camera calibration

The first device-facing call was read-only `pico_doctor {}`. It named the prior camera model as
stale because it predated this cold boot. The only other non-pass check was Accessibility
`unknown`, which is expected for a read-only probe and was not treated as proof.

The authorized `pico_doctor {calibrate:true}` call completed and persisted this new solve:

| Measurement | Observed |
| --- | ---: |
| Capture dimensions | 2160x2158 px |
| Focal length `f` | 1489 px |
| Principal point `cx`, `cy` | 1102.2 px, 961.5 px |
| Eye height | 1.81 m |
| Maximum stored residual | 7.2 px |
| Per-marker residuals | red 2.4; green 0.8; blue 2.3; yellow 3.7; magenta 7.2 px |
| Solved at | `2026-09-04T07:07:56.767Z` |

A final read-only doctor call returned `preflight.status: "ok"` and the new calibration timestamp.

## Swan receipt on the new boot

The exact call was `fleet_build {briefIds:["swanmissiontable"],settleSec:12}`.

| Field | Exact value |
| --- | --- |
| Receipt ID | `576a773051f637d2d0d98215ce9d0c20215f9c6efe004094747a95d10024d041` |
| Receipt path | `/Users/sushantsrikrish/.pico-mcp/run-receipts/native-v1/com.fleet.swanmissiontable/576a773051f637d2d0d98215ce9d0c20215f9c6efe004094747a95d10024d041.json` |
| Serial / boot | `emulator-5554` / `84e6cabf-2f79-46e5-aadd-478ab535c5a7` |
| Component | `com.fleet.swanmissiontable/.platform.LaunchActivity` |
| PID / start ticks | `32574` / `7710458` |
| APK SHA-256 | `46dea6a5ce6d1af617fba8099958a4a5e087321a26affcf0e5d7a038ad0dc3fc` |
| Structural result | built, installed, concluded, receipt recorded |
| Fleet visual verdict | `ESCALATE`; human LOOK required |

## Focus and host-window gate

All pre-click focus requirements passed.

| Gate | Observed | Result |
| --- | --- | --- |
| Passive frontmost | Finder PID `746` | PASS — real user app, not loginwindow PID `416` |
| Guardian / boot | `1`; `84e6cabf-2f79-46e5-aadd-478ab535c5a7` | PASS |
| CoreGraphics before focus | On-screen `PICO Emulator - 6.0.0`, PID `12827`, window `16199`, `(0,33)`, 984x1012 | PASS |
| Serial/discovery binding | `pid_12827.ini`, `emulator-5554`, qemu PID `12827`, window PID `12827`, scale 2 | PASS — `discovery-pid-window` |
| Supported focus request | Repository `frontmostQemu()` | PASS — `focusError: null` |
| Repository readback | PID `12827` | PASS |
| Independent passive readback | PID `12827` | PASS |

Two smaller on-screen qemu-owned `Form` windows were also present. Exact discovery-PID binding
selected the single eligible 984x1012 emulator window.

## LOOKed frames

Both exact rendered frames returned before the controller blocker were opened at original
resolution.

| Order | Phase | Absolute path | Bytes | SHA-256 | LOOK result |
| ---: | --- | --- | ---: | --- | --- |
| 0 | New-boot capture-camera solve | `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/f2e00ffadcfe5729c1d67fafd66146f7706bac7152d32e5c4607254dacb77ac0.png` | 39,142 | `f2e00ffadcfe5729c1d67fafd66146f7706bac7152d32e5c4607254dacb77ac0` | Black field with five isolated calibration blocks: green left, red center with magenta cap, blue right, yellow lower-center |
| 1 | New-boot Swan receipt | `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb.png` | 3,946,221 | `d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb` | Bedroom scene with bed centered, lamp/window left, shelving right; no lunar diorama visibly resolved |

No guide-off, guide-on, acquisition, calibration-waypoint, navigation-waypoint,
final-diagnostic, or final-clean frame was created. The calibration result's complete capture set
is null/empty, so there was no ordered navigation frame to LOOK. No app-appearance or navigation
success is inferred from the structural receipt, and `record_verification` was not called.

## Primary path: guarded Livingroom selector

The fresh receipt was accepted and the pre-switch snapshot was stable and identity-bound.

| Selector fact | Observed |
| --- | --- |
| Ranked target | `Livingroom Day` |
| Current-scene pre-query | `ready`, 43 anchors, snapshot `bdccf8b0ab0e846c69a71c8196957f69e1a012e768abaf53a2d0e0faa6917dfc` |
| Current histogram | BED 1; TABLE 0; remaining labels preserved in raw result |
| Drift | within policy; all transform, rotation, extent, label, topology, and unmatched deltas zero |
| Host result | `manual_switch_required` |
| Detail | `select_scene_button was not found` |
| Baseline safe / tile click | `true` / no |
| Post-switch snapshot | none |

No manual or coordinate fallback click was substituted. The fallback path below therefore ran in
the unchanged bedroom scene.

## Fallback path: largest horizontal BED

The explicit receipt-bound BED query used 15 maximum retries, 1000 ms polling, two stability reads,
and lossless external geometry.

| Field | Observed |
| --- | --- |
| Status / tracking | `ready` / `RUNNING` |
| Stable poll count | 7 |
| Snapshot | `bdccf8b0ab0e846c69a71c8196957f69e1a012e768abaf53a2d0e0faa6917dfc` |
| Total / matched | 43 / 1 BED |
| BED trace / runtime UUID | `anchor-0002` / `70e96e0f-9ca5-4a2b-8821-4607345dd2a3` |
| BED bounds | `[1.4014824628829956, 0.39697787165641785, 1.3301914930343628]` m |
| Horizontal area | 1.8642400497638079 m² |
| Up dot | 1.0 from the row-major identity orientation |
| Drift | within policy; every reported delta zero |

It is the only BED-labeled anchor, so it is the sole candidate for
`largest_horizontal`, `minUpDot:0.85`. The controller itself did not reach selector-receipt
publication because its separate internal scene query stopped first.

## Controller blocker and controlled reproduction

| Query | Budget | Status | Reads/polls | Anchors | Geometry |
| --- | --- | --- | ---: | ---: | --- |
| Public fallback BED query | 15 x 1000 ms, stability 2 | `ready` | 7 | 43 | 12,333,489 bytes, SHA `b23ad8c0787d6fc19624130450d9777636fc086349c2399b0e5dadf98f5232ea` |
| Controller calibration query | code-owned 2 x 10 ms, stability 2 | surfaced as `unsupported_backend` | 2 | 0 | no accepted scene |
| Direct exact-budget reproduction | 2 x 10 ms, stability 2 | `not_ready` | 2 | 0 | 1,079-byte empty receipt, SHA `466e760ec252b96876b57dd1b9f7b10b2b79d907203fb5a55ead51492d825df9` |

The calibration result stopped with `applicationRuntimeBinding:null`, `qemuBinding:null`, no
scene-query receipt retained in the result, no guide transactions, no route traces, no actions,
all capture slots null/empty, `cleanup.attempted:false`, and `calibration:null`. This is an honest
fail-closed stop, but it makes the real guest's scene acquisition unreachable at its measured
startup latency.

## Requested navigation measurements

| Measurement or claim | Result | Gate or reason |
| --- | --- | --- |
| Drag to yaw slope | **UNMEASURED** | Calibration stopped before trials; minimum gate 0.01 deg/px |
| Drag to pitch slope | **UNMEASURED** | Calibration stopped before trials; minimum gate 0.01 deg/px |
| Hold to displacement slope | **UNMEASURED** | Calibration stopped before trials; minimum gate 0.0005 m/ms |
| Normalized RMSE | **UNMEASURED** | No fit; v2 maximum 20% |
| Maximum normalized residual | **UNMEASURED** | No fit; v2 maximum 25% |
| Yaw/pitch/forward R-squared | **UNMEASURED** | No fit; v2 minimum 0.95 |
| Per-pair restore closure | **UNMEASURED** | No actions; v2 maximum 25% |
| Final closure | **UNMEASURED** | No calibration route; v2 maximum 12.5% |
| Projection/depth maximum | **UNMEASURED** | No guide frame; 12% gate unchanged |
| Aspect maximum | **UNMEASURED** | No guide frame; 12% gate unchanged |
| Guide acknowledgement latency | **UNMEASURED** | Guide protocol not invoked; budget remains 30 x 100 ms |
| `target_centered` | **UNVERIFIED** | Controller stopped before target acquisition |
| Acknowledged `w` approach | **UNVERIFIED** | No accepted v2 calibration and `navigate` was not called |

## External evidence artifacts

| Artifact | Absolute path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Initial doctor call/result | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/01-pico-doctor.json` | 9,284 | `50276226d05d63c47326ca9c3c321d631ab2b148b36937976ef89fe04563c12a` |
| Calibrating doctor call/result | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/02-pico-doctor-calibrate.json` | 10,394 | `c52d3a8439e5dd57e4a73dfa44d398c57a1fc1088d276604e61edc1c5a473955` |
| LOOKed camera-solve frame | `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/f2e00ffadcfe5729c1d67fafd66146f7706bac7152d32e5c4607254dacb77ac0.png` | 39,142 | `f2e00ffadcfe5729c1d67fafd66146f7706bac7152d32e5c4607254dacb77ac0` |
| New camera-calibration record | `/Users/sushantsrikrish/.pico-mcp/camera-calibration.json` | 298 | `10b893d4273be29f6c6f9eecea0a020580e932637fa17af4390bb42c781db9c5` |
| Swan fleet-build call/result | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/03-fleet-build-swan.json` | 6,689 | `a1f95409f227cea4766a7ad7bd8600a5bdd2363bf8f35298e3f3d029379735ec` |
| Fresh Swan run receipt | `/Users/sushantsrikrish/.pico-mcp/run-receipts/native-v1/com.fleet.swanmissiontable/576a773051f637d2d0d98215ce9d0c20215f9c6efe004094747a95d10024d041.json` | 11,761 | `386c9c23b805820f1999c207728e0c3b56269f1f5816ab4e5de1fa766e472210` |
| LOOKed Swan receipt frame | `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb.png` | 3,946,221 | `d2e91711bb99490f21e63c5eea48acaa5782fb1f98a0a59416f250156be1f1eb` |
| Focus/window gate | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/04-focus-gate.json` | 2,307 | `964eeb18d72812ae825d4e80c5e2e16f8e89fad628a8c172c4c509a96306b972` |
| Guarded selector call/result | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/05-select-livingroom-day.json` | 80,414 | `8e646e8b04a86e34d07bd0cea937a8e5a3f46a8b7946cbaf3f85954e9b5d1a62` |
| Selector pre-query geometry | `/private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-scene-session-7WFCwy/scene-41-0e09797616144fc196ca2a056a5960e0.json` | 12,332,941 | `bfdab6319524185af69c0e9039654469b02d183e00530a7142af1fe810459367` |
| Stable BED query call/result | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/06-query-bed.json` | 58,777 | `59482af7e81f946318daf91e9fc89b1d6f78f40e8763d714b83f7eb33190450c` |
| Stable BED geometry | `/private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-scene-session-ouXXHL/scene-41-c4374b4af54545209ec5a9cba776a30d.json` | 12,333,489 | `b23ad8c0787d6fc19624130450d9777636fc086349c2399b0e5dadf98f5232ea` |
| BED calibration call/result | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/07-navigate-bed-calibrate.json` | 5,199 | `e55ac496680c31136a681097696bf5703b85543ba4ec5e54de9f9678a04999e9` |
| `pico_fix` call/result | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/08-pico-fix-navigation-backend.json` | 1,503 | `da950c7085e365b928b162c1f1117225277bceb73d035355b74a4d4936287467` |
| Exact-budget reproduction call/result | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/09-query-bed-navigation-budget.json` | 13,583 | `56dd0ae0679e5a3e8869def5bc45fff4d702964d8db2d7af330f918842ead7fd` |
| Exact-budget empty geometry receipt | `/private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-scene-session-SOoLir/scene-41-b368b066f3c3468695c0192584024925.json` | 1,079 | `466e760ec252b96876b57dd1b9f7b10b2b79d907203fb5a55ead51492d825df9` |
| Final doctor call/result | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/10-pico-doctor-final.json` | 8,928 | `d50ce1a150af157e6260264eaac45a66531127cb5d4843d2dbf80eef0ee25f82` |
| Terminal read-only state | `/private/tmp/pico-navigate-live-coldboot-20260904.Y6Xlt7/11-terminal-state.json` | 594 | `15eaa5023fcb95eabeca66a22e7987d7df646855fa7fb8018edb3c21118d3bcd` |

## Terminal state and cleanup

The final read-only state is the same boot and owned app session:

- `emulator-5554` is the only targeted serial and remains online.
- Boot ID is `84e6cabf-2f79-46e5-aadd-478ab535c5a7`.
- Guardian/VST/debug is `1/1/1`.
- `/data/misc/user/0/boundary/localmode` is absent.
- `com.fleet.swanmissiontable/.platform.LaunchActivity` remains foreground.
- No guide SHOW/HIDE transaction was attempted, no drag or key hold was sent, and no process was
  force-stopped after the controller refusal.

## UNVERIFIED updates

| Item | Status after this checkpoint |
| --- | --- |
| U4 drag calibration stability | **Open.** No live yaw, pitch, or hold fit was produced. |
| Viewer-facing guide projection | **Open.** No guide frame exists; the 12% gate was not exercised or loosened. |
| Livingroom Day TABLE acquisition | **Open.** The selector failed before a tile click. |
| Bedroom BED acquisition | **Structurally available, controller-unreached.** One stable BED anchor exists, but the controller's shorter query returned empty. |
| Bounded target centering | **Open live.** No acquisition or centering action occurred. |
| Calibrated forward approach | **Open live.** No navigation receipt was published and no `w` was sent. |
| Ordered navigation LOOK evidence | **Open.** The controller produced no navigation frames. |
| Hardware behavior | **Out of scope.** No physical serial was targeted. |

## Repository gates

The branch changes only this `LIVE.md` relative to `f768155`.

- `npm run build`: passed immediately before every test command.
- `node --test test/navigationtarget.mjs`: 104 passed, 0 failed.
- `node --test test/homeenvironmentselector.mjs`: 481 passed, 0 failed.
- `node --test test/sceneanchors.mjs`: 31 passed, 0 failed.
- `npm run test:docsmeta`: 0 failures.
- `npm run test:adoption-safety`: 48 checks, 0 failures.
- `npm run test:distribution-adoption`: 41 passed and the same 2 known-only baseline count
  assertions: Linux gate invocations 45 versus stale 44, and test scripts 48 versus stale 46.
- Tarball gate: not rerun because this checkpoint changes no tool/test count, product code, or
  distribution metadata.
- `benchmarks/**` and `test/agentbench-*`: byte-unchanged from `ce201e4`.
- `git diff --cached --check`: run after staging and before the checkpoint commit.

## Deviations

- **Primary-to-fallback path:** ran as authorized. Livingroom selection failed before a click, so
  the unchanged bedroom's BED label was used.
- **Navigate call:** not run because calibration stopped before producing the exact-context v2
  receipt that the required forward approach needs. A navigate call can in principle perform
  partial guide acquisition or centering without that receipt, but it cannot validly request `w`;
  this checkpoint did not initiate a partial camera route after its calibration prerequisite
  stopped at the scene-query boundary.
- **Projection gate:** not loosened. It was not reached.
- **Repository scope:** only this `LIVE.md` is changed; heavy evidence remains outside the repo.
