# Virtual camera — three levels, three evidence boundaries (v29.2)

*(Direct-test-grounded; L2 updated 2026-07-28. “Virtual camera” here means a deterministic view
synthesized from a scanned-world model — not PICO VST, not passthrough, and not a claim about Swan
hardware. The L1 implementation shipped, but its planned Task 3 real-scene coverage bar did not
pass. **L2 is PROVEN end-to-end: an injected changing card reaches an Android app's camera preview
inside the emulator (v29.1), and the scanned room itself now makes the same trip (v29.2) — both
vision_verified.** In v29.2 the room and its run-unique nonce are legible in-app; reading the
liveness counter is `blocked` by a capture-path limit, characterised below. L3 is proposal-only.)*

## The short version

- **L1 — shipped with a disclosed acceptance miss:** three MCP tools render a host-side view,
  calculate camera-visible support surfaces, and pair that synthetic view with a
  foreground-verified emulator capture. The planned real-scene `visibleFraction >= 0.5` check did
  not pass (floor `0.3093`; no counter result). The tools prove world-model composition — they do
  not put synthetic pixels into Android's camera stack.
- **L2 — PROVEN end-to-end (v29.1), vision_verified:** an injected high-contrast nonce/card
  sequence is written to the public CoreMediaIO sink exposed by Immersed Camera; the Immersed
  extension republishes it on its source; the emulator is booted with `-camera-back webcam1`
  (mapped to the exact Immersed UUID); and a hand-authored CameraX app (CameraPeek) running inside
  the emulator **visibly displays the card** — the exact nonce `VCAM-20260724-9K2D`, `STREAMING`,
  and two different counters (`FRAME 000003` and `000001`) across a looked-at capture pair. Both the
  host source-read and the in-app preview were personally LOOKed at. This proves injected-pixel
  delivery into the emulator's camera stack from a host-side virtual camera. It is still a
  simulation of camera access — not PICO VST, passthrough, SecureMR, MRC, scene understanding, or a
  Swan-hardware claim — and no real PICO headset was used.
- **L3 — upstream proposal only:** PICO could expose the L1 RGB and surface products through an
  emulator camera/MR provider — no such SDK/runtime shim was built or verified in this repo.

No entry is `device_verified`; every L1/L2 claim is host-side or emulator evidence.

## L2 — v29.1: the full injected-pixel pipeline, proven

v28.4 proved the whole *structure* of the route (producer → Immersed sink, fresh `webcam1` mapping,
live `-camera-back webcam1` argv, CameraPeek `STREAMING`) but its final captures were byte-identical
and showed the emulator's default bedroom scene, not the card. v28.4 could not say *where* the pixels
were lost — between the Immersed sink and CameraPeek's preview. v29.1 narrowed and then closed that
gap.

**The pipeline, and where each boundary is proven:**

```text
deterministic card  →  Immersed CoreMediaIO SINK  →  Immersed SOURCE  →  qemu -camera-back webcam1  →  CameraPeek preview
   (LOOKed source)      (enqueue/removal stats)      (host AVFoundation      (live qemu argv,            (LOOKed in-app,
                                                      read, LOOKed)          adb boot, camera id 10)     two counters)
```

**1. Host source-read (the v28.4 ambiguity, resolved).** A new read-only, permission-safe macOS
diagnostic (`scripts/macos/cmio-camera-reader.m`) was added. Its `--cmio-probe-only` topology probe
showed the Immersed device exposes two streams — `ImmersedCamera.Video` (input/source) and
`ImmersedCamera.Video.Sink` (output/sink). Its authorization-gated `--avfoundation-readback` mode,
run while the producer streamed the card, captured frames from the Immersed **source** that were
**byte-identical** to the injected source frames and personally LOOKed at — the exact nonce and two
different counters (`000000`, `000001`). This proves the Immersed extension **does** republish the
injected pixels on its source, and a host client reads them. (v28.4's FFmpeg could not even open the
source; the AVFoundation client can.) Ledger: `vcam-hostsource` seq 0, `vision_verified`.

**2. End-to-end into the app.** With the producer streaming and the emulator cold-restarted with
`-camera-back webcam1`, the unchanged CameraPeek APK (9,728,122 bytes, SHA-256 `9ff4d804…`) was
clean-installed and launched; camera id `10` opened for `com.pico.camerapeek`, `previewStreamState`
reached `STREAMING`, and a looked-at capture pair showed the injected card **inside the app** — nonce
`VCAM-20260724-9K2D`, counters `FRAME 000003` and `000001`. Ledger: `com.pico.camerapeek` seq 1,
`vision_verified`. Artifact: `~/.pico-mcp/artifacts/vcam-v29.1-20260724-9k2d/`.

**Root cause of the v28.4 negative.** The difference was **macOS camera authorization for qemu's
responsible app**. In v28.4 the terminal/IDE hosting the run lacked camera access, so qemu could not
open the host webcam and the emulator fell back to its default scene — hence the bedroom, not the
card. Granting the responsible app camera access (a one-time System-Settings toggle by the operator;
no TCC reset, no `requestAccessForMediaType`, no software install) let qemu acquire the Immersed
source and the injected pixels flowed all the way through.

**Honest caveats.**

- ~~**The Immersed source updates slowly.**~~ **RETRACTED in v29.2 — this was our own bug, not the
  source's.** The v29.1 figures ("a 217 ms host read froze on a single counter; only a ~15 s read
  spanned two counters") were misread as a property of the Immersed device. The 217 ms was a
  *source-timestamp* span — 8 frames at 30 Hz, all inside one 1-second producer hold, so a single
  counter is exactly what `kTicksPerSourceFrame = 60` predicts.
  v29.2 measured the rate directly: **Immersed republishes at a dead-steady 30.00 Hz**, unchanged
  whether we feed it one image per second or thirty. The ~1 Hz in-app cadence was that same producer
  constant, which held each source image for a full second; and the ~15 s was the reader perturbing
  its own run — a PNG encode, a disk read-back and a second SHA-256 *inside* the capture callback.
  v29.1's own records show 40 consecutive frames spanning just 1.28 s of source time across that read.
  The split between those three costs was never measured, because the v29.2 cells ran `--no-preview`,
  which removes the path entirely. Two host-only cells settled the rate: at
  `--ticks-per-source-frame 60` the delivered image rate was 1.01 Hz, at `1` it was 30.00 Hz, with
  `observedSourceHz` pinned at 30.00 in both. Ledger `vcam-worldframe` seq 0.
- **One thing still unmeasured.** The reader reported `dropped: 0` in both cells, but
  `alwaysDiscardsLateVideoFrames = NO` makes late frames queue rather than drop, so that zero is not
  evidence of a clean capture. Whether `didDropSampleBuffer` ever fires against real AVFoundation
  remains unmeasured, not confirmed. Ledger seq 2.
- **Direct CMIO client readback stays `blocked`, by contract.** Apple does not document the
  ownership of a `CMSampleBuffer` dequeued from a CMIO input stream (`CMSimpleQueue` delegates
  element lifetime "externally"; no retain annotation; the documented source-consumer path is
  AVFoundation). The reader therefore only *probes* CMIO topology read-only and reads pixels via
  AVFoundation — never a direct CMIO stream client. This is a deliberate blocked branch, not a
  failure.
- **Camera-mode runs invalidate calibration.** The cold restarts leave the persisted capture-camera
  calibration stale; recalibrate before any metric/placement claim.

**Device-free tooling shipped this arc (all CI-safe, no camera/emulator/Immersed required):**
`src/vcamboundary.ts` (a fail-closed boundary-report model with four first-class terminal states and
a changing-card bar that requires two distinct counters backed by two distinct captures);
`scripts/macos/cmio-camera-reader.m` (the read-only CMIO probe + permission-safe authorization-only
and AVFoundation readback modes). Gates: `test:vcamboundary`, `test:vcamreader`,
`test:vcamreader-native`.

## L2 — v29.2: the scanned room itself makes the trip

v29.1 proved the transport with a synthetic test card. v29.2 replaced the card with the world model's
own pixels: a fixed-pose render of the scanned-world model — the `Cozy Neon Cyberpunk Ramen Bar`
Gaussian-splat world — stamped with a run-unique nonce and a legible counter, carrying provenance the
native writer validates before a single sample is enqueued.

**Proven, `vision_verified`.** A rendered fixed-pose scanned-room frame reaches an in-emulator CameraX
preview. The looked-at capture shows CameraPeek's `STREAMING` label, the nonce plaque reading
`VCAM-20260728-046A`, and beneath it the scanned ramen bar — cyan neon signage on both side walls and
the three-tier illuminated food display. The nonce was minted minutes before the run, so the frame
cannot be a cached image or the v28.4 default-scene fallback. Ledger `vcam-worldframe` seq 3.
Artifact: `~/.pico-mcp/artifacts/vcam-v29.2-20260728-046a/`.

**Blocked, and precisely characterised: the counter could not be *read* in-app.** This is a
capture-path limit, not a delivery failure and not in-app clipping. CameraPeek's window is 1920×1080,
but `adb screencap` captures the 2160×2158 built-in spatial display, which frames a *zoomed portion*
of that floating panel — CameraPeek's own `STREAMING` label is clipped at the top edge for the same
reason. The system's second display is a `FLAG_PRIVATE` / `OWN_CONTENT_ONLY` `VirtualDisplay` and
`screencap -a` returns a single file, so the app surface is not capturable. The full frame is on
CameraPeek's surface; the region carrying the counter simply cannot be photographed. Nothing here is
evidence that delivery is static. Ledger seq 4.

**The retraction above matters more than either.** The "Immersed is slow" caveat that shaped the
v29.1 write-up was wrong, and v29.2 measured the truth: a dead-steady 30.00 Hz source, with our own
`kTicksPerSourceFrame = 60` responsible for the ~1 Hz in-app cadence.

**A hazard found in passing.** At `--ticks-per-source-frame 1`, the producer's single-outstanding-sample
gate admits only every *other* scheduled tick, so enqueued frame indices acquire fixed even parity —
measured `{0: 109, 2: 108}`, with indices 1 and 3 never delivered at all. With an even-length frame
loop, exactly half the frames can never reach the sink. This is a coupling between the backpressure
gate and the frame-advance rate, not a tuning constant, and any streaming work must fix it rather
than merely lowering the constant. Ledger seq 1.

**A design consequence worth carrying forward.** Confining *all* per-frame variation to
`COUNTER_REGION` is what makes changing frames distinguishable from animation or encoder drift — that
invariant is load-bearing. But it also means that when the viewport omits that one region, nothing
visible varies, and liveness becomes unreadable even if delivery is perfect. A redundant counter
inside the nonce plaque, which sits comfortably in view, would have made this round a full pass at no
cost to the invariant. Ledger seq 5.

**Device-free tooling shipped this arc:** `src/vcamthroughput.ts` (a pure analyzer that correlates
producer and reader JSONL by frame hash and refuses to publish a number it cannot justify — latency
is always an explicit lower bound, and truncated records, a non-BGRA format, or missing host stamps
each become a `confounded` reason rather than a confident zero); `src/vcammaterialize.ts` (writes
frames before the manifest, indexed by array position, validating everything before writing anything);
`stampFrame`/`createFixedPoseSequence` in `src/vcamtransport.ts`; a second natively-validated manifest
kind with twelve required provenance rules; and `renderProvenance` on the boundary report, bound to an
exact-match `source.kind` so scanned-room provenance cannot be attached to a card run. New gates:
`test:vcamthroughput`, `test:vcammaterialize`.

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

### v28.4 injected-card round — complete evidence chain, negative pixels

v28.4 added CI-safe transport primitives rather than an unverified live-pose bridge. The TypeScript
module generates deterministic 1280×720 BGRA cards without fonts, FFmpeg, cameras, or wall-clock
input; parses a fresh emulator webcam listing against an exact host name and UUID; builds an
executable/argv-separated producer plan; and owns bounded fake-producer startup, abort, join, and
teardown behavior. Cooperative downstream work is joined after abort; an operation that ignores
abort gets only a bounded grace period and remains rejection-observed while producer teardown
continues. The macOS helper is separately gated on macOS and uses public CoreMediaIO APIs.
Linux CI exercises only deterministic cards, mapping, and a fake producer; it does not require the
Immersed extension, camera hardware, or an emulator.

The retained source nonce was `VCAM-20260722-7F3A`. Its four counters have distinct raw-frame
SHA-256 values, and the manifest SHA-256 is
`d3f6c4869a4804ef95cd80f8a12a5b4c0511b3dfc1c3c5bc2454da02a1751d4f`. All four preview PNGs
were personally LOOKed at: they contain the expected high-contrast bars, nonce, and counters
`000000` through `000003`. That proves the deterministic source only.

The enabled host extension exposed exactly one matching write-side stream:
`Immersed Camera` / UUID `A1EA3EF8-F9D5-4BA7-827E-A26C1B27BEA2` /
`ImmersedCamera.Video.Sink`, direction `0`, 1280×720 BGRA at 60 fps, with read-only logical queue
and startup counts of `1`. Its copied `CMSimpleQueue` reported physical capacity `10`; public Apple
headers do not promise equality with the logical queue-size property. The helper therefore keeps
one effective in-flight token and treats queue-full as backpressure.

Two producer defects were found before the final round and retained rather than hidden. The first
implementation rejected copied capacity `10` before starting or enqueueing. A later implementation
enqueued once and then crashed in CoreMediaIO's sample-finalization path because the removal
callback released a borrowed token immediately before CoreMediaIO performed its own `CFRelease`.
An LLDB control skipped the callback body and the same binary remained alive for 1,800 scheduler
ticks; a device-free native regression now guards that ownership handoff. The final retry also
changed sequence numbers to advance per successful enqueue, not per backpressured scheduler tick,
as required by the CMIO sample contract. A post-proof review also found that public stop and
callback-unregistration APIs do not document consumer quiescence. Shutdown therefore does not
drain or release the copied queue and any remaining token; it intentionally retains them for the
bounded remainder of the producer process instead of racing provider work. Its last stats event is
explicitly an unquiesced `shutdown-snapshot`, not a final callback count, and handled signals return
their deterministic `128 + signal` status. The helper accepts only the proven test-card manifest;
the unattempted fixed-pose kind is not admitted without its own provenance contract.

With the corrected producer live, fresh enumeration still resolved:

```text
webcam0 -> 6C707041-05AC-0011-0008-000000000001 (physical MacBook camera, YV12)
webcam1 -> A1EA3EF8-F9D5-4BA7-827E-A26C1B27BEA2 (Immersed Camera, BGR4)
```

The decoded restart argv and live qemu argv both ended in `-camera-back webcam1`; post-start
enumeration retained the same mapping, and bundled adb reported `sys.boot_completed=1`. The
unchanged hand-authored CameraPeek APK rebuilt directly at 9,728,122 bytes with SHA-256
`9ff4d80480190cf836fbff53f4bdb76230e376b2e6cc5f2d0c2e697ffde1d383`. After a clean install it
was focused/resumed, camera service showed camera ID `10` open for its PID, and its own log advanced
`IDLE -> Bound DEFAULT_BACK_CAMERA -> STREAMING`. Those facts are structural prerequisites only.

The visual gate failed. Two final captures, taken more than one source-counter interval apart, are
byte-identical with SHA-256
`2b0f515a182ef02a23abdad836b7c7f3cb993a0a1b0f9148b8ffb6bc2ad9f5c9`. Both were personally
LOOKed at. CameraPeek visibly says `STREAMING`, while its preview contains the static emulator
bedroom scene; the nonce, bars, and changing counter are absent. The ledger entry is therefore
`structural`, not `vision_verified`. The fixed-pose scanned-room round was correctly skipped because
the card prerequisite did not pass.

The narrowest proven failure interval begins after the Immersed sink removes the writer's samples
and ends before those pixels reach CameraPeek's preview. Fresh mapping and live argv rule out an
accidentally selected index in this run, but they do not prove that the Immersed extension republishes
sink samples on its exposed source or that qemu acquired those source pixels. Host FFmpeg enumerated
the Immersed source but could not open it (`Cannot use Immersed Camera`, `Input/output error`), and no
privacy/TCC setting was changed. Distinguishing Immersed sink-to-source publication from qemu's
AVFoundation acquisition remains an external-system dependency; the current evidence cannot assign
the failure more narrowly.

Retained root:
`/Users/sushantsrikrish/.pico-mcp/artifacts/vcam-v28.4-20260722-7f3a`. CameraPeek and both producers
were stopped afterward. The normal emulator profile was cold-restored and verified booted with no
`-camera-back` argument. That final restart makes persisted camera calibration stale for any later
metric claim.

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
