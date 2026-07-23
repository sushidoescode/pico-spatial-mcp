# Virtual camera — three levels, three evidence boundaries (v28.0)

*(Direct-test-grounded 2026-07-22. “Virtual camera” here means a deterministic view synthesized
from a scanned-world model — not PICO VST, not passthrough, and not a claim about Swan hardware.
The L1 implementation shipped, but its planned Task 3 real-scene coverage bar did not pass; L2 is
partial and pixel-negative, and L3 is proposal-only.)*

## The short version

- **L1 — shipped with a disclosed acceptance miss:** three MCP tools render a host-side view,
  calculate camera-visible support surfaces, and pair that synthetic view with a
  foreground-verified emulator capture. The planned real-scene `visibleFraction >= 0.5` check did
  not pass (floor `0.3093`; no counter result). The tools prove world-model composition — they do
  not put synthetic pixels into Android's camera stack.
- **L2 — structurally alive, visually unresolved:** the emulator booted with
  `-camera-back webcam0`; CameraPeek opened camera ID 10 and CameraX reported `STREAMING` — but the
  LOOKed capture contained no recognizable webcam image. That is a useful negative pixel result,
  not proof of a working webcam feed.
- **L3 — upstream proposal only:** PICO could expose the L1 RGB and surface products through an
  emulator camera/MR provider — no such SDK/runtime shim was built or verified in this repo.

No v28.0 entry is `device_verified`; no real PICO headset was used.

## L1 — the world model gets a camera

### `virtual_camera_frame` — deterministic synthetic RGB

`virtual_camera_frame` accepts an app-frame position plus either a target or yaw/pitch, resolves
the scanned world's decoded `.ply`, subtracts the world's persisted `offsetApplied` to reach raw
splat coordinates, and invokes the existing NumPy/Pillow perspective renderer. It returns the PNG,
intrinsics, both app- and splat-frame poses, source paths, and rendered-point count. FOV-derived
intrinsics are supported; `calibratedIntrinsics` instead scales persisted `f/cx/cy` while requiring
the calibration aspect ratio to remain unchanged. Sampling is deterministic — the real-world smoke
test renders identical bytes for identical inputs — but the renderer draws Gaussian centers as
points, so its output is point-cloud-like rather than photoreal.

The Task 2 comparison used app position `[0.034, 1.896, 0.147]`, calibrated intrinsics, yaw `0°`,
and an explicitly selected pitch of `+20°`. The linked frame was LOOKed at — both halves show cyan
wall signs flanking the forward shelf/corridor structure. The correspondence is deliberately
qualified: the synthetic side exposes much more ceiling and shelving, while the emulator side has
a torn dark ceiling and a large brown counter mound across the lower view. This is **broad framing
correspondence, not pixel alignment, camera-HAL output, or photoreal equivalence**.

- Ledger: `vcam-ramen`, seq `0`, evidence `usd_host_render`.
- Artifact: `/Users/sushantsrikrish/.pico-mcp/artifacts/vcam-ramen-v28.0-side-by-side.png`
- SHA-256: `2abaefb2518b1aeda6bbba7c891a2d5ca9f51f8ac6145ad6be514a2ff7de96fa`
  (`2192×1128`).

### `virtual_camera_surfaces` — structural scene understanding

`virtual_camera_surfaces` loads a semantic scanned-room scene, extracts detector-labeled floor and
object-top support surfaces, projects equal-area patches through the requested camera, and reports
each retained surface's center, extent, distance, and three non-interchangeable coverage measures.
`visibleFraction` is whole-surface coverage; `detectedPatchVisibleFraction` is fill conditional on
a patch having some projected area; `visiblePatchFraction` is the share of patches detected at all.
With an occupancy grid it also ray-tests the viewer-to-surface-center line; without one,
`losClear` is `null` rather than guessed. Labels remain detector opinions and all of this is
**structural geometry evidence** — not pixels from a scene-understanding camera.

The Task 3 real-ramen run reported the floor with whole-floor visibility **0.3093** and
detected-patch fill **0.9278** — 92.78% does not mean 92.78% of the full floor was visible. The
floor-center ray was blocked (`losClear: false`), which is consistent with the counter-dominated
view. The plan's requested whole-surface `>= 0.5` acceptance did **not** pass, and no counter
surface was returned. The exact numbers are this run's observed output; `test/vcam.mjs` guards the
honest range (`0.25–0.4`) and conditional patch fill (`>= 0.5`) rather than freezing those exact
decimals. This is not a visual or hardware plane-detection claim.

### `virtual_camera_from_app` — comparison orchestration, not camera injection

`virtual_camera_from_app` selects a resumed fleet app (or checks the requested package), verifies
that package before and after an `adb screencap`, renders the synthetic frame, runs the surface
report, and composes a labeled side-by-side. It accepts emulator serials only. The bridge exposes
scene state but no live head pose, so the shipped default is stated rather than hidden — the
v27.7-derived position with yaw `0°` / pitch `+20°`. Callers can supply a pose, or set
`assumeSpawnPose: false` and fail closed when no explicit position is provided.

The Task 4 composition was LOOKed at — the emulator and synthetic halves share broad sign/shelf
structure, but the counter, ceiling, occlusion, and visible contents differ materially. The adb
half is a real emulator **display** capture; the other half remains a host-synthetic world render.
Putting them beside each other does not turn either one into a camera-HAL frame, and the assumed
pose makes pixel alignment an invalid claim.

- Ledger: `vcam-from-app-ramenlos`, seq `0`, evidence `usd_host_render`.
- Artifact: `/Users/sushantsrikrish/.pico-mcp/artifacts/vcam-from-app-ramenlos-v28.0.png`
- SHA-256: `807809587d2f69965b0005adceddb861b798e483e8f7c585b92cae18e3b5d8cd`
  (`2224×1152`).

## L2 — CameraPeek opened the path, but webcam pixels were absent

The restart helper now accepts an opt-in `PICO_EMU_CAMERA_BACK` and passes it as a separate
`-camera-back` argument; the normal profile remains unchanged. During the spike, live process
discovery reported a `webcam0` camera-back boot, but no separate argv/boot-log artifact was
retained; the linked evidence below does not independently prove that launch flag. CameraPeek is
a hand-authored classic Android activity — not output
from the Spatial AppSpec compiler — declaring `android.permission.CAMERA`, selecting
`DEFAULT_BACK_CAMERA`, and binding a CameraX 1.5.3 `Preview` to a lifecycle-owned
`PreviewView` in `COMPATIBLE` mode. That is the standard Android shape described by the official
[CameraX preview guide](https://developer.android.com/media/camera/camerax/preview),
[`ProcessCameraProvider`](https://developer.android.com/reference/androidx/camera/lifecycle/ProcessCameraProvider),
[`CameraState.ErrorType`](https://developer.android.com/reference/androidx/camera/core/CameraState.ErrorType),
and [`PreviewView.StreamState`](https://developer.android.com/reference/androidx/camera/view/PreviewView.StreamState)
references.

The probe also requests `CAMERA` at runtime on a clean install before binding; an external
`pm grant` remains a convenient automation step, not a hidden prerequisite. It observes CameraX's
camera-state error channel as well as `PreviewView.StreamState`, preserving the last full error
while continuing to show the current `IDLE`/`STREAMING` state if CameraX recovers.

`briefs/camerapeek.json` is a local-machine trace record, but its typed execution route is
`hand-authored-classic-android`. Generic fleet/factory builders skip it, and SpatialBench reports
it as `0/0` skipped; the descriptive one-panel AppSpec cannot be compiled into a generic HUD and
mistaken for this CameraX probe. The Android project's absolute path is recorded, but its source is
not committed here and the project itself has no Git history, so this L2 probe is not portable or
source-reproducible from the repository alone.

What v28.0 actually earned is narrower: `dumpsys media.camera` showed camera ID `10` open by
`com.pico.camerapeek`, and CameraPeek visibly reported `previewStreamState: STREAMING`. The
2160×2158 capture was LOOKed at — no recognizable Mac-webcam pixels appeared in the preview;
FleetAmbient's sphere, tan cube, and blue capsule remained visible through the panel. `STREAMING`
therefore stays a **structural CameraX state**, while webcam-pixel delivery is a negative visual
finding.

- Ledger: `camerapeek-webcam0`, seq `0`, evidence `structural`.
- Artifact: `/Users/sushantsrikrish/.pico-mcp/artifacts/camerapeek-webcam0-v28.0.png`
- SHA-256: `6e6cedf4dedf287df188682e2f72e482944655efbf929ed6f83261948823a595`
  (`2160×2158`).

The permission/error-history hardening was added after that `webcam0` capture. Its final APK was
unit-tested, linted, and assembled, but has no retained launch log and was not subjected to another
`webcam0` visual round. The linked negative pixel evidence therefore belongs to the captured spike
build, not the later APK.

There was no `videoplayback` round. The local emulator help exposes the mode name, but no
discoverable input/file configuration for it; more importantly, the prerequisite webcam-pixel
path had not succeeded. v28.0 did not invent an undocumented argument, feed, or success claim.

### Calibration warning after the spike

Camera-mode testing required cold restarts, and this rig's persisted capture-camera calibration is
known to become stale across a cold restart. In this run `pico_doctor` could still report that file
as passing because the freshness check compares its ISO timestamp incorrectly against numeric boot
time. Treat the current calibration file as **stale despite that pass** — recalibrate before another
calibrated render or any placement measurement. No v28.0 claim upgrades that stale file into fresh
evidence.

## L3 — the PICO-side proposal, and the live bridge before it

**[UNGATED HOST FOLLOW-UP] OBS/virtual-webcam bridge.** Render L1 frames continuously from an
explicitly sourced pose, publish them through an OBS or equivalent host virtual-camera device, and
boot the emulator against the resulting `webcam<N>`. The pass gate is a LOOKed CameraPeek capture
containing recognizable injected test pixels — enumeration, camera ID 10 opening, or `STREAMING`
alone does not pass. A live, provenance-bearing head-pose source is a separate gate; the current
assumed spawn pose is suitable for comparison demos, not a live camera loop.

**[EMULATOR-CONTRACT GATE] `videoplayback`.** Attempt this only after PICO documents or exposes the
input/file contract. The pass gate is a LOOKed in-app frame whose known injected content is
recognizable; an advertised mode name is not evidence of ingestion.

**[PICO-UPSTREAM GATE] camera/MR provider shim.** L1 is a working prototype for two provider
products — deterministic RGB from the scanned world and structural plane/surface records from the
semantic scene plus occupancy grid. PICO could wire equivalents into emulator camera-, VST-, or
scene-facing runtime APIs, with explicit synthetic-data provenance and deterministic pose control.
That requires PICO blessing plus an emulator source artifact or supported integration contract.
This repo has implemented none of that runtime plumbing and makes no SecureMR, MRC, passthrough,
VST-equivalence, or hardware claim.

The evidence boundary is the product: L1 proves composition from a real scanned-world model; L2
proves an Android camera can enumerate/open and reach a CameraX stream state on this emulator build
while recognizable webcam pixels remain absent; L3 remains a proposal until its own gate produces
looked-at evidence.
