# Space Program receipt preconditions

Timing evidence depends on the emulator window remaining visible. On macOS the
host probe reads CoreGraphics' on-screen windows in front-to-back order and
compares their rectangles with the exact bound qemu window. Receipts retain
`hostWindowProbe` and the sampled `hostWindowProbes`, including observation
times, window identity, `occluded`, `frontmost`, and `overlappingOwners`.
Windows touching only an edge, fully transparent windows, and windows behind
qemu do not count as overlaps. A missing window or failed probe is unknown,
never a clear-window result. Samples describe their observation times; they
do not establish continuous visibility between samples.

`capture_settled`, `capture_orbit`, and `capture_multiview` retain warnings when
qemu is covered. Calibration in `navigate_to_scene_target`, preparation and
distance measurement in `run_in_app_locomotion_route`, and timing-sensitive
boundary experiment work refuse with `host_window_occluded` and the overlapping
owners. An unavailable visibility result refuses with `host_window_unavailable`.
The probe never raises, activates, or moves windows. Camera drags require qemu
to be frontmost already; a clear window can still lack keyboard focus.

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
use checked publication to an external session directory. Settlement proves
byte equality only: the evidence ceiling stays `structural`, and pixel claims
still require LOOK.

## Profiler command selection

`pico_perf` reads the profiler helper's version before sampling. Helper
`0.1.0` uses `perf live run ... --save -o <report>`. The previously supported
embedded pico-cli `0.3.0` command uses `perf monitor run` only after its help
confirms the command and required flags. An unknown helper version or failed
probe refuses sampling. The receipt's `profiler` field records the version
probe, and `command` records the exact executable and sampling arguments.

## Imported APK provenance

Both consumers accept the same explicit identity:

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

For `run_immersive_boundary_experiment`, supply the object as `provenance`
with a `manifest_mixed` scenario and `route.source.kind: "replay"`. Its stage
must be `"1"`. Replay still requires an adjudicated native M0 calibration
route, exact route and runtime bindings, and reviewed waypoint continuity.
Imported worlds use the `imported_mixed_environment` review state and their
reviewed landmarks. They cannot author the native calibration seed or reuse
the reserved Claimsight identity. The existing Claimsight E1 route retains
its exact SHA pin.

An imported Mixed route without a visually witnessed 32 m gate can report
`no_ejection_within_observed_budget` with `CHARACTERIZE`. Replaying a calibrated
script alone does not award the stronger traversal `PASS` or establish a
distance witnessed in the imported world.
