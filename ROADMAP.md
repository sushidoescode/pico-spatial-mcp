# Roadmap — where pico-spatial-mcp is going

*(Public, gate-labeled, and honest: every line is either ungated work we can do on the current
emulator, or explicitly labeled with the event that unblocks it. Nothing here is a promise of a
date; everything shipped gets a ledger entry before it gets a claim. Rejected-on-the-record
ideas are listed too — knowing what we won't do is part of the honesty contract.)*

## Just shipped (v28.0)

- **World-model virtual camera — L1 shipped**: `virtual_camera_frame` renders a deterministic
  perspective frame from a scanned room; `virtual_camera_surfaces` reports camera-visible
  surfaces with coverage and line-of-sight; `virtual_camera_from_app` composes the simulated
  view beside a live emulator capture. Evidence stays correctly split between host render,
  structural geometry, and looked-at comparison — it is not camera-HAL or VST emulation. The
  planned real-room coverage bar did not pass: the returned floor was `0.3093` visible, below
  `0.5`, and no counter surface was returned.
- **Emulator camera-HAL spike — partial L2, negative pixels result**: live discovery reported an
  opt-in `webcam0` boot (no separate argv artifact was retained), camera ID 10 opened for
  CameraPeek, and CameraX reached `STREAMING`; the looked-at panel still contained no recognizable
  webcam image. Emulator help advertises `videoplayback` but exposes no file/input configuration,
  so no input was invented and no playback-success claim was made.
  Full evidence and artifacts: [docs/VIRTUAL_CAMERA.md](docs/VIRTUAL_CAMERA.md).

## Just shipped (v27.x)

- **First Light**: the 15-minute stranger onboarding path, actually timed and fixed (three
  structural frictions found by running it cold); `preflight_env` read-only doctor with
  fix-pointing; docs rewritten for a PICO-internal audience.
- **Partner instrumentation**: the OS 6.1 bring-up playbook + `vault_diff` runbook, and the
  `device_verified` evidence protocol — written for machines that have what ours lacks.
- **Name-aware procedural provisioning**: data-bound briefs whose names match shape archetypes
  (gems, crystals, pins, bottles…) now get REAL baked faceted geometry instead of placeholder
  cards — vision-verified (`com.fleet.crystals`).
- **Unity hello-XR settling test**: Unity 6000.4.9f1 + the official PICO OpenXR package reached a
  healthy FOCUSED session, advanced frames at 60fps, and submitted an app-owned layer on emulator
  0.13.1 / OS 6.0; three looked-at captures across two launches were uniformly black.
  Runtime/session/layer operation is structurally proven, while the intended immersive pixels
  are absent from capture on this emulator build — not a visual-success or `vision_verified`
  claim. The test does not isolate the failing compositor/camera/render-target stage.

## Near-term (ungated — buildable on the current emulator)

- **Live virtual-webcam bridge** — route rendered world-model frames through an OBS/host virtual
  camera into `webcam<N>`. Gate: CameraPeek must show recognizable injected pixels in a looked-at
  capture; `STREAMING` or an open HAL client alone does not pass.
- **Line-of-sight placement constraint**: occupancy solving today guarantees non-intersection;
  a visibility constraint (can the camera actually SEE the placed object?) is the next honest
  step for the free-space world model.
- **SpatialBench perf axis**: add frame-budget measurement (`measure_perf`) as an optional
  scored column in the public conformance harness.
- **Scaffold archetypes**: the two-step `pico_build_app` authoring flow should offer scaffold
  variants per brief archetype (display / game / data-panel), so a stranger's first authored
  spec steers toward the pipeline's proven strengths.
- **Unity lane, optional build wrapper**: evaluate a `unity_batch_build` tool around the confirmed
  batchmode path for non-immersive/build handoffs. It would not by itself visually verify
  immersive output on the current emulator; see [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md).
- **17.0 tail**: semantic scan → `anchorTo` brief into a NEW splat world through the compile
  path (proving the world-model loop generalizes beyond the ramen scan).

## Partner-gated (needs PICO-side artifacts or hardware)

- **L3 emulator camera-provider shim** — propose a PICO-side provider that serves deterministic
  world-model RGB plus plane/surface metadata through camera/VST-facing APIs. Gate: PICO blessing
  and an integration surface or emulator source artifact; this repo will not claim an upstream
  path exists from public flags alone.
- **OS 6.1 emulator bring-up** — playbook ready ([docs/playbooks/os61-bringup.md](docs/playbooks/os61-bringup.md));
  blocked on artifact access from our side.
- **First 0.14/6.1 `vault_diff` drift report** — the multi-version vault tooling is shipped and
  waiting for a second real vault to exist locally.
- **First `device_verified` ledger entry** — protocol + evidence ask-list shipped
  ([docs/DEVICE_VERIFICATION.md](docs/DEVICE_VERIFICATION.md)); needs a real Swan run.
- **Immersive OpenXR re-test** (native, WebXR, and Unity-built) — re-test the observed 0.13.1 /
  OS 6.0 black-output boundary first thing on a 6.1 emulator or Swan hardware; do not project the
  current result onto either untested target. See [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md).

## Blessing-gated (needs PICO's go-ahead; nothing goes public before it)

- npm publish + marketplace listing, versioned releases, semver + deprecation policy for tool
  schemas.
- The public verifiable-claims page generated from the ledger (capture hashes included).

## Rejected on the record

- **Unattended signed releases** — contradicts the honesty invariant that is this project's brand.
- **Silent auto-repair** — repair only ever happens as ledger-visible events.
- **Claiming immersive/hardware capabilities from the emulator** — deferral is honest; a silent
  over-claim is the one unforgivable failure.
