# Scene-target navigation final checkpoint

Date: 2026-09-01

Branch: `navigate-scene-target-2026-09-01`

Base: `bc2ab58`

Target: `emulator-5554` only

This is the final checkpoint from the
[scene-target implementation plan](../../superpowers/plans/2026-09-01-navigate-scene-target-implementation.md).
The implementation and fake/unit proof are complete. The requested live Livingroom TABLE calibration
and acquisition are **UNVERIFIED** because the guarded environment switch stopped before a host click:
macOS reported `loginwindow` PID 416 as frontmost instead of the exact qemu PID 87242. No process was
force-stopped, no manual picker click was attempted, and no navigation input was sent after that stop.

## Outcome

- The repository now has one full-only `navigate_to_scene_target` tool with strict calibrate/navigate
  inputs, bounded acquisition and centering, an immutable same-context calibration receipt, structural
  evidence ceiling, ordered settled captures, and fail-closed terminal states.
- A clear initial reservation probe allowed the final checkpoint to begin. The doctor-prescribed
  same-boot capture-camera calibration and one Swan mission-table build/launch completed.
- The receipt-bound scene query then returned `label_absent`: the active bedroom-style environment had
  41 stable anchors and no `TABLE` label. The guarded selector ranked `Livingroom Day` but refused before
  clicking because its qemu focus readback was `416`, not `87242`.
- The stop rule therefore prevented the navigation calibration, animation pause, guide SHOW/HIDE,
  camera drags/holds, target acquisition, or durable visual-evidence recording. U4 remains open.

## Implementation commits and primary paths

| Commits | Result |
| --- | --- |
| `3eda833`, `f509232` | Pure two-color guide measurement, regression fits, calibration identity/quality validation, bounded controller decisions, and fixture tests. |
| `6cfe0a6`, `f45af21`, `6fd6344` | Revision-1 file-acknowledged magenta/cyan mission guide, strict lifecycle, serialized invalidation, and stale-dispatch rejection. |
| `2a56590`, `22b0fba`, `b424d27`, `112e80e`, `0d6e1f3`, `dc862b7` | Full bounded target orchestration, shared route/settle/continuity reuse, exact replay and binding checks, honest cleanup, ordered action attempts, and receipt-mismatch failure handling. |
| `a48b97f` | Five-file count chain, synchronized public metadata, installed-tarball count proof, and the re-runnable calibration guide. |

Primary implementation and owning fixtures are `src/navigationtarget.ts`, `src/navigationguide.ts`,
`src/navigationcalibration.ts`, `src/navigation.ts`, `src/cameradrive.ts`, `src/observation.ts`,
`src/runtimecontinuity.ts`, `src/agentbridge.ts`, `src/missiontable.ts`, `src/assemble.ts`,
`test/navigationtarget.mjs`, `test/navigation.mjs`, `test/observation.mjs`,
`test/runtimecontinuity.mjs`, `test/sceneanchors.mjs`, and `test/conformance.mjs`. The user workflow is
documented in [Calibrated scene-target navigation](../../NAVIGATE_SCENE_TARGET.md).

## Reservation and exact binding probe

The first live action was read-only `pico_doctor {}` followed by exact device, guest, activity, qemu
discovery, and CoreGraphics-window probes.

| Binding fact | Observed value |
| --- | --- |
| Online serial | `emulator-5554`, model `swan_arm64`, one online adb target |
| Guest boot ID | `549c2de4-e387-4970-a5de-08ba124bd202` |
| Guest fingerprint | `Pico/swan/pico_spaceos_emulator_arm64:16/BQ2A.260122.002-BP2A.250705.008/4399:user/test-keys` |
| Boot state | `sys.boot_completed=1`; gRPC port 8554 reachable with token discovery |
| Discovery | `/Users/sushantsrikrish/Library/Caches/TemporaryItems/avd/pico_running/pid_87242.ini`; qemu PID 87242 |
| Bound main window | CoreGraphics window 9850 at x=0, y=33, 816x844 logical pixels |
| Initial resumed guest activities | Expected co-resumed `com.picoxr.systemui`, `com.picoxr.launcher`, and `com.pxr.scenarioprovider`; no user app foreground |
| After owned launch | Exact `com.fleet.swanmissiontable/.platform.LaunchActivity`, PID 3478, start ticks 1599914 |

The doctor reported only the stale prior-boot camera calibration as a failure and named
`pico_doctor {calibrate:true}` as its fix. Accessibility was `unknown`, not asserted available.

## Same-boot capture-camera calibration

The doctor fix internally built/launched `calib` and solved the forward capture model at
`2026-09-01T15:29:06.212Z`:

| Quantity | Measured value |
| --- | --- |
| Capture size | 2160x2158 |
| Focal length | 1489 px |
| Principal point | cx 1102.2 px, cy 961.5 px |
| Eye height | 1.81 m |
| Per-marker residuals | red 2.4 px; green 0.8 px; blue 2.3 px; yellow 3.7 px; magenta 7.2 px |
| Maximum residual | 7.2 px |
| Persisted proof | `/Users/sushantsrikrish/.pico-mcp/camera-calibration.json`, 298 bytes, SHA-256 `263ec383365d14ee16ecd80507cc1ce8bf6a1639036f5ba0bea6df5f227a33df` |

The exact solved frame was individually LOOKed. Five keyed cubes—green, red, blue, yellow, and a
magenta marker above the red cube—were visible against the black stage. This LOOK supports only that
description; the tool's numeric result remains the structural calibration receipt.

| Order | Frame | Bytes | SHA-256 | LOOK result |
| --- | --- | ---: | --- | --- |
| 0 | `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/f2e00ffadcfe5729c1d67fafd66146f7706bac7152d32e5c4607254dacb77ac0.png` | 39,142 | `f2e00ffadcfe5729c1d67fafd66146f7706bac7152d32e5c4607254dacb77ac0` | Five color-keyed calibration cubes on a black stage. |

This is the capture projection model required by navigation identity. It is **not** the U4
drag-pixels-to-yaw/pitch or hold-time-to-displacement calibration described next.

## Re-runnable navigation calibration procedure and missing measured fits

The checked-in procedure is fixed by code and documented for re-use:

1. Acquire the acknowledged guide with a settled guide-off and settled guide-on delta.
2. Run four signed yaw drag trials `[40,-40,80,-80]` px, each immediately followed by its exact inverse.
3. Run four signed pitch drag trials `[40,-40,80,-80]` px, each immediately followed by its exact inverse.
4. Run forward holds `[50,100,150,200]` ms, each immediately followed by an equal `s` restore.
5. Settle every outbound and restore separately; compute through-origin slopes, signed residuals, RMSE,
   maximum absolute residual, R-squared, projection/aspect residuals, per-pair closure, and final closure.
6. Publish the immutable receipt and same-context registry entry only if all fit, projection, slope, and
   closure thresholds pass.

No navigation calibration call was made after the host-focus stop. Consequently there is no calibration
receipt, no drag-pixels-to-yaw fit, no drag-pixels-to-pitch fit, no hold-time-to-displacement fit, and no
measured navigation residual to report for this guest/boot. Goal-directed approach remained disabled.

## Owned Swan build and failed TABLE prerequisite

`fleet_build {briefIds:["swanmissiontable"],settleSec:12}` built, installed, and launched the owned
debug app. Its structural run receipt is:

- receipt ID `6c8c2623dfe6f75a2a45a8ea20f504b9f2d7ea3f6e7699f1291b4ae62eb26153`;
- package/component `com.fleet.swanmissiontable/.platform.LaunchActivity`;
- APK SHA-256 `46dea6a5ce6d1af617fba8099958a4a5e087321a26affcf0e5d7a038ad0dc3fc`;
- receipt path `/Users/sushantsrikrish/.pico-mcp/run-receipts/native-v1/com.fleet.swanmissiontable/6c8c2623dfe6f75a2a45a8ea20f504b9f2d7ea3f6e7699f1291b4ae62eb26153.json`.

The exact receipt frame was LOOKed. It shows a bedroom-style rendered environment and a translucent
`SWAN MISSION CONTROL` panel whose surface line remains `TABLE pending`; no TABLE-target acquisition is
claimed from those pixels.

| Order | Frame | Bytes | SHA-256 | LOOK result |
| --- | --- | ---: | --- | --- |
| 1 | `/Users/sushantsrikrish/.pico-mcp/ledgers/artifacts/eac6a04628a3f32207feb93c6c559c257355d5d261a27995e5679b7553dd8eb4.png` | 3,961,840 | `eac6a04628a3f32207feb93c6c559c257355d5d261a27995e5679b7553dd8eb4` | Bedroom-style scene plus translucent Swan mission-control panel; TABLE still pending. |

The exact receipt-bound `query_scene_anchors` result was `label_absent` with snapshot
`8b9d064c651f38dd7713ab667126b11d0bd50cf7324122d92e992132ce023332`: 41 total anchors, zero
TABLE matches, stable two-read drift, and a 11,165,058-byte geometry artifact at
`/private/var/folders/qq/mr_6xdvn7018qqh55db0j1wc0000gn/T/pico-scene-session-PWXRWu/scene-41-53e2ad9c99f1405687c805ad9979087d.json`
with SHA-256 `4460ec969c265862fb2ac8db01bb6226971070c4363f97af6467a24273527a0a`.
Its histogram included one BED, one FLOOR, one WALL_ART, and no TABLE.

## Guarded switch stop and live deviations

The selector ranked `Livingroom Day`, created a same-boot baseline and WorldSpace marker, then returned:

```text
manual_switch_required
frontmost PID readback mismatch: expected 87242, observed 416
baselineSafe: true
```

PID 416 is `/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow`. A second attempt
used the repository's supported qemu-focus request after re-probing the exact Swan foreground binding;
the readback remained PID 416 and the selector again refused before opening or clicking the picker.
`pico_fix` had no retained match for this exact refusal.

This final checkpoint therefore deviates from the intended live sequence only at the external-state
boundary:

- Livingroom was not selected or receipt-bound verified;
- `mission:launch` / `mission:pause` were not sent because no TABLE target existed;
- `navigate_to_scene_target {action:"calibrate"}` and `{action:"navigate"}` were not called;
- no guide-off, guide-on, waypoint, final-diagnostic, or final-clean acquisition capture exists;
- no navigation result was promoted through `record_verification`.

## UNVERIFIED register

| Item | Status after this checkpoint |
| --- | --- |
| U4 drag calibration stability | **Open.** The capture-camera model was refreshed, but navigation drag/hold trials and their residuals were not measured. |
| Disabled-until-calibrated live behavior | **Structurally covered; live replay open.** Unit fixtures prove refusal and no W without a valid same-context receipt; no real same-boot call was made. |
| Viewer-facing two-color guide | **Structurally covered; pixels open.** Generated dimensions, colors, projection, acknowledgements, and lifecycle are tested; no live guide frame was returned. |
| Livingroom largest-horizontal TABLE selection | **Open for this boot.** The active scene had no TABLE and the guarded environment switch stopped baseline-safe. |
| Bounded acquisition/centering/approach | **Open live.** No camera input or ordered navigation capture was produced. |
| Byte-exact settlement under paused mission animation | **Open live.** Animation was not paused because the TABLE prerequisite failed. |
| Hardware behavior | **Open.** This checkpoint selected no physical serial and makes no headset claim. |

## Tool counts, package state, and retained tarball

- Full surface: 254 tools measured from an installed tarball on macOS.
- Source-derived Linux/Windows surface: 251 tools.
- Doors surface: 18 tools.
- Required full-surface anchors: 42, including `navigate_to_scene_target`.
- Package version: 37.0.0; npm script keys: 53, unchanged from `bc2ab58`.
- Final retained tester package:
  `/private/tmp/pico-nav-final-tarball.AnHQdl/pico-spatial-mcp-37.0.0.tgz`,
  1,894,076 bytes, SHA-256 `07ba7f0855c4685019784b9b707c266762926c47125e991d87e0dfdff2b43c53`.

## Final local gates

Fresh post-checkpoint results:

- `npm run build`: PASS, TypeScript exit 0.
- Direct navigation/target/observation/scene/continuity boundary: 253 tests; 252 passed, 0 failed,
  1 Darwin-branch skip.
- `npm run test:emulator-restart`: 247 tests; 246 passed, 0 failed, 1 platform skip.
- `npm run test:conformance`: sample conformance exit 0 and boundary suites 69/69.
- `npm run test:doors`: exactly 18 tools; 0 failures.
- `npm run test:docsmeta`: 0 failures; the expected worktree `.git/config` warning remains.
- `npm run test:adoption-safety`: 48 checks, 0 failures.
- `npm run test:distribution-adoption`: exactly 41 passed and the same 2 known-only baseline count
  assertions: Linux gate invocations 45 versus stale 44, and test scripts 48 versus stale 46.
- `npm run test:tarball -- --publish /private/tmp/pico-nav-final-tarball.AnHQdl`: 0 failures;
  installed full macOS 254, all 42 anchors, explicit Doors 18, and default Doors 18.
- Protected `benchmarks/**` and `test/agentbench-*` diff: verified after this documentation update.
- `git diff --check`: verified after this documentation update.

Heavy captures, geometry, APKs, build receipts, and calibration state remain outside the repository.
This directory adds only the lightweight Markdown checkpoint.
