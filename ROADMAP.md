# Roadmap — where pico-spatial-mcp is going

*(Public, gate-labeled, and honest: every line is either ungated work we can do on the current
emulator, or explicitly labeled with the event that unblocks it. Nothing here is a promise of a
date; everything shipped gets a ledger entry before it gets a claim. Rejected-on-the-record
ideas are listed too — knowing what we won't do is part of the honesty contract.)*

## Just shipped (v30.x)

- **Unity lane E2E — `vision_verified`** (v30.0a–f): `unity_scaffold_project` (a packaged
  ~11-file skeleton — windowed default, immersive option, a ready SpatialAdapter slot) +
  `unity_build_apk` (the confirmed `-batchmode -executeMethod` path with a structured
  `build-result.json` contract). The windowed scaffold builds (41 s cold / 12 s warm), installs,
  and **composites as a floating Unity panel** on the emulator; the first LOOK caught a real
  payload bug (every primitive rendered InternalErrorShader magenta — fixed by shipping a built
  material asset). The focus gate is measured and documented: an unfocused panel's activity is
  paused; broadcast commands queue at the Java receiver and drain on focus. Ledger
  `com.picoagent.hellounity` seq 0–1. See [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md).
- **v30.1 RETRACTION — immersive Unity VR DOES render on the emulator; the boundary was our
  capture path.** The user challenged the "immersive OpenXR doesn't composite" claim, and they
  were right. Both Unity routes — the PICO Integration SDK (`PXR_Loader`) and the OpenXR SDK,
  via the *unchanged sha-pinned July-22 APK* — fill the emulator view with their intended
  immersive scenes when captured through the emulator window (`gui_capture`); ledgers
  `com.picoagent.pxrvr` seq 0 and `com.picospatial.helloopenxr` seq 3, both `vision_verified`.
  Root cause of the July-22 "uniformly black" result: `adb screencap` captures the SHELL
  composite and is structurally blind to XR-runtime output — Unity said so in the July-22 log
  itself (`Skip Present To Main Screen: Yes`) and we misread it. The capture-path rule is now
  enforced in the tool descriptions. NOT over-corrected: the 2026-07-02 native-NDK/WebXR probes
  observed a different symptom and were never re-tested through `gui_capture` — their status is
  OPEN, not negative (see Partner-gated below).
- **`generate_surface_placement_kotlin`** (v30.2): seat a baked model on a DETECTED real-world
  surface (semantic FLOOR/TABLE/WALL/CEILING/BED/CABINET targeting), with every silent trap from
  the hand-built MR-tabletop session generated-correct by construction and gated in
  `test:surfaceplace`: plane queries POLL (a one-shot query during the Full Space entry
  animation returns 0 — very likely the source of the historic "no scene understanding" belief),
  height is read from the plane (the emulator's bedroom FLOOR sits at y=0.40, not 0), anchor
  space converts via `convertPositionFrom`, centred-origin models get a base lift, and colliders
  are PRIMITIVE boxes with `PhysicsWorldComponent`.
- **Plane orientation is NOT portable across home environments** (v30.3, ledgered): a second
  PICO home env reports FLOOR as HORIZONTAL_DOWNWARD and CEILING as HORIZONTAL_UPWARD — the
  exact inverse of the bedroom — so any "largest HORIZONTAL_UPWARD plane" fallback picks the
  CEILING there. The generator now falls back by HEIGHT; labels stayed reliable in both rooms.
  Same release: `tools/table_drag_bridge.py` — drag the table with a real mouse, anchored to the
  detected floor on drop (Option-gated so panel drags stay with the shell), verified in the new
  environment with live Kraken values on the seated panel (LOOKed).
- **Floor placements seat in FRONT of the user, not at the plane centroid** (v30.4): a
  room-sized FLOOR plane's centroid is wherever the room's middle falls — the MR table was
  seated 1.8 m to the user's right, correct plane, correct height, invisible. FLOOR now takes
  the plane's height + a point 1.6 m ahead of the user, clamped into the plane's rectangle;
  object-sized surfaces (TABLE/CABINET/BED/WALL) still seat at the centroid. Two captures of the
  same app prove it (ledger seq 12).
- **`measure_model`** (v30.5): reads the real world-space AABB out of a glTF/GLB (composed node
  TRS, all eight corners, no buffer decoding) and reports a measured `baseLift = -min.y` instead
  of an origin-convention guess — the real Meshy table's origin sits 0.5 mm below centre, exactly
  the class of error measuring removes. The Meshy → MR path is now
  `measure_model` → `bake_textured_model` → `generate_surface_placement_kotlin` with no
  hand-typed numbers in it; `test:modelmeasure` gates it on synthesized fixtures.

## Just shipped (v29.2)

- **The scanned room reaches the emulator's camera — `vision_verified`**: a fixed-pose render of the
  scanned-world model (the `Cozy Neon Cyberpunk Ramen Bar` Marble Gaussian-splat world), stamped with
  a run-unique nonce and carrying natively-validated provenance
  (world + pose + intrinsics + renderer + base-frame hash), reaches an in-emulator CameraX preview.
  The looked-at capture shows the nonce plaque `VCAM-20260728-046A` and the room beneath it; the
  nonce was minted minutes earlier, so it cannot be a cached frame or v28.4's default-scene fallback.
  Ledger `vcam-worldframe` seq 3.
- **`blocked`, and precisely characterised**: the liveness counter could not be *read* in-app. This
  is a capture-path limit, not a delivery failure and not in-app clipping — CameraPeek's window is
  1920×1080 while `adb screencap` captures the 2160×2158 spatial display, which frames a zoomed
  portion of that panel. The system's only other display is a `FLAG_PRIVATE`/`OWN_CONTENT_ONLY`
  `VirtualDisplay` owned by `com.pxr.scenarioprovider`, and `screencap -a` returns a single file — so
  there is no second capture path to the unclipped panel. Ledger seq 4.
- **The "Immersed is slow" caveat is RETRACTED** — it was our bug, not the device's. Measured:
  Immersed republishes at a dead-steady **30.00 Hz**; the ~1 Hz in-app cadence was
  `kTicksPerSourceFrame = 60` in our own producer, and v29.1's "~15 s" was the reader perturbing its
  own run with an in-callback PNG encode, disk read-back and second SHA-256 — not source latency.
  Two host-only cells: 1.01 Hz at `--ticks-per-source-frame 60`, 30.00 Hz at
  `1`. OBS was pre-approved for this and deliberately left unspent. Ledger seq 0.
- **New hazard found**: at high cadence the single-outstanding-sample gate admits only every *other*
  scheduled tick, so enqueued frame indices acquire fixed even parity — measured `{0:109, 2:108}`,
  with indices 1 and 3 never delivered. With an even-length loop, half the frames can never reach the
  sink. A coupling to fix, not a constant to tune. Ledger seq 1.
- **Device-free tooling**: a pure throughput analyzer that refuses to publish a number it cannot
  justify (latency is always an explicit lower bound; truncated records, a non-BGRA format, or
  missing host stamps each become a `confounded` reason rather than a confident zero), a fail-closed
  materializer, a second natively-validated manifest kind with twelve required provenance rules, and
  `renderProvenance` bound to an exact-match `source.kind` so scanned-room provenance cannot be
  attached to a card run. Battery 27 → 29 `test:` suites (30 invocations), now self-checking against
  the published count. Full evidence: [docs/VIRTUAL_CAMERA.md](docs/VIRTUAL_CAMERA.md).

## Just shipped (v29.1)

- **Emulator camera-HAL — L2 PROVEN end-to-end, `vision_verified`**: an injected high-contrast
  nonce/card sequence written to the Immersed Camera CoreMediaIO sink reaches a hand-authored
  CameraX app (CameraPeek) *inside* the emulator via `-camera-back webcam1` — the looked-at in-app
  preview shows the exact nonce and two different counters (`FRAME 000003`/`000001`), `STREAMING`.
  A new read-only, permission-safe macOS host reader (`cmio-camera-reader`) first proved the same
  injected pixels are readable byte-for-byte on the Immersed **source** via AVFoundation, isolating
  v28.4's negative to its true cause: qemu's responsible app lacked macOS camera authorization and
  fell back to the default scene. Ledgers `vcam-hostsource` seq 0 and `com.pico.camerapeek` seq 1.
  Caveats: ~~the source updates slowly (seconds, not 60 fps)~~ **— retracted in v29.2, see above:
  Immersed runs at a steady 30.00 Hz and the limiter was our own producer constant**; direct CMIO
  client readback stays
  `blocked` on an undocumented ownership contract (AVFoundation is the documented source-consumer
  path); calibration is stale after camera-mode restarts. Device-free tooling: a fail-closed
  boundary-report model (`src/vcamboundary.ts`) + the native reader, gated by `test:vcamboundary`,
  `test:vcamreader`, `test:vcamreader-native`. Full evidence: [docs/VIRTUAL_CAMERA.md](docs/VIRTUAL_CAMERA.md).

## Just shipped (v28.0)

- **World-model virtual camera — L1 shipped**: `virtual_camera_frame` renders a deterministic
  perspective frame from a scanned room; `virtual_camera_surfaces` reports camera-visible
  surfaces with coverage and line-of-sight; `virtual_camera_from_app` composes the simulated
  view beside a live emulator capture. Evidence stays correctly split between host render,
  structural geometry, and looked-at comparison — it is not camera-HAL or VST emulation. The
  planned real-room coverage bar did not pass: the returned floor was `0.3093` visible, below
  `0.5`, and no counter surface was returned.
- **Emulator camera-HAL spike — L2 (v28.0/v28.4 stage, since resolved)**: camera ID 10 opened for
  CameraPeek and CameraX reached `STREAMING`, but the looked-at panel showed the emulator's default
  scene, not the card. This stage isolated a structural route without delivering pixels; **v29.1
  above closes it** (the missing piece was qemu's camera authorization).
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

## Near-term (ungated — buildable on the current emulator)

- **Live world-model webcam bridge** — the injected-pixel gate is MET (v29.1: a deterministic card
  reaches CameraPeek via the Immersed virtual camera + `-camera-back webcam1`, `vision_verified`),
  and **v29.2 pushed the scanned room itself through the same path**, `vision_verified` — the room
  and a run-unique nonce are legible in an in-emulator CameraX preview. **The "slow source" blocker
  named here previously is RETRACTED:** v29.2 measured Immersed at a dead-steady 30.00 Hz, and traced
  the ~1 Hz in-app cadence to `kTicksPerSourceFrame = 60` in our own producer. No higher-throughput
  host virtual camera is needed for that reason; OBS was pre-approved and deliberately left unspent.
  What remains: drive the sink with *continuous rendered world-model frames from a live pose* instead
  of a static sequence — which needs a different producer input contract, since the current manifest
  is a set of pre-hashed static files and structurally cannot express a stream. Two v29.2 findings
  gate that work: an even/odd aliasing coupling between the backpressure gate and the frame-advance
  rate silently drops half the frames at high cadence, and liveness must be readable from wherever
  the viewport actually looks — a redundant counter in the nonce plaque is the cheap fix.
- **Line-of-sight placement constraint — SHIPPED (v27.3)**: free-space placement queries take
  `visibleFrom` — a viewpoint from which candidates occluded by the occupancy grid are
  hard-rejected — so a solved placement is not just non-intersecting but actually seeable.
- **SpatialBench perf axis — SHIPPED**: `run_spatialbench` scores an optional `perf` column
  (tier=full + `perfAxis`): `measure_perf`'s UI/RenderThread frame p95 against a budget,
  honestly scoped to what gfxinfo measures on this emulator (Compose panels/2D activities, NOT
  the spatial engine's 3D frame pacing); briefs with no UI frame data score null — a SKIP,
  never zeroed.
- **Scaffold archetypes**: the two-step `pico_build_app` authoring flow should offer scaffold
  variants per brief archetype (display / game / data-panel), so a stranger's first authored
  spec steers toward the pipeline's proven strengths.
- **Unity lane — SHIPPED (v30)**: `unity_scaffold_project` (packaged skeleton, windowed default,
  immersive option, SpatialAdapter slot) + `unity_build_apk` (confirmed batchmode path,
  structured result). Windowed Unity content composites as a panel and is vision-verified on the
  emulator; immersive Unity VR also renders (capture it with `gui_capture` — see the correction
  above). The SpatialAdapter slot awaits PICO's Unity packages. See
  [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md).
- **17.0 tail**: semantic scan → `anchorTo` brief into a NEW splat world through the compile
  path (proving the world-model loop generalizes beyond the ramen scan).

## Partner-gated (needs PICO-side artifacts or hardware)

- **Full Space Guardian-boundary fix — PARTNER-STATED** (Matt/PICO, known issue, fix in
  progress; reported to us, **not measured by us**): Full-Space (stageStyle 3) immersive
  Spatial SDK apps hit a Guardian-boundary issue on hardware. Until PICO's fix lands and we
  re-verify on hardware, stageStyle 3 stays a first-class *explicit opt-in* while Mixed
  (stageStyle 1) is the default. Scope note: this attaches to stageStyle-3 immersion only —
  "Full Space" in the plane-detection lane means an open Stage (vs a WindowContainer),
  which Mixed apps also satisfy, and that lane is unaffected.
- **L3 emulator camera-provider shim** — propose a PICO-side provider that serves deterministic
  world-model RGB plus plane/surface metadata through camera/VST-facing APIs. Gate: PICO blessing
  and an integration surface or emulator source artifact; this repo will not claim an upstream
  path exists from public flags alone.
- **OS 6.1 emulator bring-up** — playbook ready (internal notes);
  blocked on artifact access from our side.
- **First 0.14/6.1 `vault_diff` drift report** — the multi-version vault tooling is shipped and
  waiting for a second real vault to exist locally.
- **First `device_verified` ledger entry** — protocol + evidence ask-list shipped
  ([docs/DEVICE_VERIFICATION.md](docs/DEVICE_VERIFICATION.md)); needs a real Swan run.
- **Native-NDK and WebXR immersive re-test with `gui_capture`** — the Unity routes are settled
  (they render); the 2026-07-02 native-NDK/WebXR probes reported a compositor *loading fallback*
  in the GUI viewport and were never re-run after the shell-policy fix or through the corrected
  capture path. Their immersive status is OPEN, not negative. See
  [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md).

## Blessing-gated (needs PICO's go-ahead; nothing goes public before it)

- npm publish + marketplace listing, versioned releases, semver + deprecation policy for tool
  schemas.
- The public verifiable-claims page generated from the ledger (capture hashes included).

## Rejected on the record

- **Unattended signed releases** — contradicts the honesty invariant that is this project's brand.
- **Silent auto-repair** — repair only ever happens as ledger-visible events.
- **Claiming immersive/hardware capabilities from the emulator** — deferral is honest; a silent
  over-claim is the one unforgivable failure.
