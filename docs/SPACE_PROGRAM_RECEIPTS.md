# Space Program receipt preconditions

Timing evidence depends on the emulator window remaining visible. On macOS the
host probe reads CoreGraphics' on-screen windows in front-to-back order and
compares their rectangles with the exact bound qemu window. Receipts retain
`hostWindowProbe` and the sampled `hostWindowProbes`, including observation
times, `durationMs`, window identity, `occluded`, `frontmost`, and
`overlappingOwners`. Only layer-zero windows owned by another process can
occlude qemu. Dock/menu layers, qemu's own toolbar and child windows, invalid
helper rectangles, edge-only contact, transparent windows, and windows behind
qemu are excluded. Missing alpha is treated as opaque. A missing target window
or failed probe is unknown, never a clear-window result. Samples describe their
observation times; they do not establish continuous visibility between samples.

`capture_settled`, `capture_orbit`, and `capture_multiview` retain warnings when
qemu is covered. Calibration and navigation in `navigate_to_scene_target`, preparation and
distance measurement in `run_in_app_locomotion_route`, and timing-sensitive
boundary experiment work refuse with `host_window_occluded` and the overlapping
owners. An unavailable visibility result refuses with `host_window_unavailable`.
The probe never raises, activates, or moves windows. The separate, recorded
focus request raises the bound qemu process before the timing precondition is
sampled; a window that remains occluded still refuses measurement. Camera
actions retain their focus checks. Capture flows use one visibility snapshot
per capture and pass the existing window binding into it. The adb/bridge-only
locomotion tool treats host visibility as `not_applicable` off macOS; navigation
and boundary experiments require the macOS CGEvent lane.

## Retained settled pairs

`capture_settled` keeps the existing `path`, `sha256`, `captureRef`, and
`stablePair` meanings. A successful receipt adds `stablePairCaptureRefs`, a
two-element array of full capture references in acquisition order. The first
frame is retained beside the requested output as `<output-path>.pair-1.<unique-id>.png`; the
second uses the requested output path. Each reference includes its path,
SHA-256, byte count, dimensions, serial, and capture timestamp. A timeout has
no settled pair and retains its last valid capture as before.

`receiptPath` points to `<output-path>.receipt.json` whenever a capture artifact
was published and its receipt could be retained. Both frames and the receipt
use checked publication to an external session directory. If only receipt
publication fails, `receiptPath` is null and a `receipt_write_failed` warning
records the problem; capture status, settlement, and retained frames keep their
original meanings. Settlement proves
byte equality only: the evidence ceiling stays `structural`, and pixel claims
still require LOOK.

## Profiler command selection

`pico_perf` reads the profiler helper's version before sampling. Helper
`0.1.0` uses `perf live run ... --save -o <report>`. The previously supported
embedded pico-cli `0.3.0` command uses `perf monitor run` only after its help
confirms the command and required flags. An unknown helper version or failed
probe refuses sampling. The receipt's `profiler` field records the version
probe, and `command` records the exact executable and sampling arguments.

Profiler-cli `0.1.0` help surface verified 2026-09-08; sampling behavior unverified
live. The [retained help-only capture](evidence/perfcli-0.1.0-help-2026-09-08.txt)
contains truncated root/live help excerpts. It records bare `perf -V` returning
`0.1.0`, rejection of `monitor run`, and root help returned successfully for
`monitor run --help`. These observations establish command syntax, not sampled
performance results.

## Imported APK provenance

`select_home_environment`, `query_scene_anchors`, and
`run_immersive_boundary_experiment` accept the same explicit imported APK identity:

| Field | Meaning |
| --- | --- |
| `kind` | Literal `imported_apk`. |
| `apkPath` | Normalized absolute path to the APK. |
| `apkSha256` | SHA-256 of its bytes, as 64 lowercase hexadecimal characters. |
| `packageName` | Package declared in the compiled manifest. |
| `declaredStageStyle` | Manifest value `"1"` for Mixed or `"3"` for Full. |

The shared validator hashes the file, reads its compiled `AndroidManifest.xml`
with installed Android SDK `aapt2`, checks the declared package and stage for
the launch component with application metadata as fallback, and checks the
file hash again. Its receipt includes `manifestInspection` and
`evidenceCeiling: "structural"`. A mismatched SHA, package, or style refuses the
operation before picker or preparation effects. Without an explicit component,
inspection requires one manifest launcher. Ambiguous declarations and unresolved
metadata resources refuse inspection instead of guessing the stage style.

For `select_home_environment` actions `switch` and `verify`, supply the object
as `runtime.provenance` and omit `runtime.expectedBuildReceiptId`. The remaining
runtime fields still specify serial, package, and expected stage. Imported
runtime bindings carry `buildReceiptId: null`, `buildReceiptPath: null`, and
the inspected `imported_apk` provenance. The returned verification baseline
also binds APK, boot, PID, process start ticks, and resumed component across
the environment switch. The app must still expose the scene bridge required
by the selector.
Local APK hashing or manifest-inspection failures return `imported_apk_invalid`
at `pre_query` or `post_query`; invalid bridge results keep `bridge_result_invalid`.

For `query_scene_anchors`, supply `scenario.provenance` and omit
`scenario.expectedBuildReceiptId`. The query validates the local APK and compiled
manifest, then binds installed APK bytes and the foreground process. Imported
bindings retain inspected provenance and null native receipt fields.

For `run_immersive_boundary_experiment`, supply the object as `provenance`
with a `manifest_mixed` scenario and `route.source.kind: "replay"`. Its stage
must be `"1"`. Replay still requires an adjudicated native M0 calibration
route, exact route and runtime bindings, and reviewed waypoint continuity.
Imported worlds use `imported_mixed_environment` and reviewed landmarks, except
a `manifest_mixed` scenario with native M0 ID `boundarylab-mixed` and package
`com.fleet.boundarylabmixed`: that identity uses `boundarylab_mixed` even with
imported provenance. Imported `manifest_mixed` rows cannot author the native calibration seed or reuse
the reserved Claimsight identity. The existing Claimsight E1 route retains
its exact SHA pin. The pinned Claimsight E1 route also requires installed Android
SDK `aapt2` for compiled-manifest inspection; its exact SHA pin does not bypass
this prerequisite.

An imported Mixed route without a visually witnessed 32 m gate can report
`no_ejection_within_observed_budget` with `CHARACTERIZE`. Replaying a calibrated
script alone does not award the stronger traversal `PASS` or establish a
distance witnessed in the imported world.
