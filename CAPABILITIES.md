# 🗂️ Capabilities — what pico-spatial-mcp can do, and how we know

*Snapshot generated from the local trust ledger via `capability_matrix`; its exact generation time
is recorded in `docs/claims/claims.json`.
Every image-grounded row was re-hashed during that read; the static page does not monitor later
filesystem changes. `vision_verified` means a human or agent LOOKED at a rendered frame whose
recorded bytes were still intact at generation time. Re-run the tool before relying on current
counts. `auto_judged` and `usd_host_render` additionally require artifact-bound receipts from their
producer tools; legacy/caller-authored rows without them are structural. `device_verified`
additionally requires live-probed PICO/non-emulator identity and an exact
same-serial screencap match; this snapshot contains **zero real-hardware device_verified rows**.*

**13 capability categories have active proof across 53 apps; 147 effective proof entries. Of
those, 28 are `vision_verified` (a human/agent LOOKED); 183 former image-grounded claims are
`provenance-broken` and excluded from the categories below.**

Evidence totals: `vision_verified` 28 · `logcat` 27 · `structural` 90 · `compiles` 1 ·
`built_for_headset` 1 · `provenance-broken` 183

| Capability | Best evidence | Proofs | Apps |
|---|---|---|---|
| Real physics (native) | `vision_verified` | 46 | 22 |
| Interactive menus | `vision_verified` | 23 | 14 |
| Live-text / HUD panels | `vision_verified` | 8 | 7 |
| Web panels (live DOM) | `structural` | 6 | 4 |
| Multi-panel web workspace | `structural` | 4 | 4 |
| WebSpatial (React, OS6) | `structural` | 1 | 1 |
| Web↔3D bridge | `structural` | 9 | 4 |
| Web 3D (three.js) | `structural` | 1 | 1 |
| AAA fidelity | `vision_verified` | 15 | 12 |
| Pipeline (brief→app) | `vision_verified` | 17 | 14 |
| Unattended fleet | `vision_verified` | 31 | 26 |
| Editor integration | `vision_verified` | 10 | 10 |
| Custom worlds / env | `vision_verified` | 18 | 16 |

## Two lanes, one verification loop
- **Native Spatial SDK** (Kotlin/Filament): real rigid-body physics, clickable in-world menus,
  AAA fidelity (PBR/shadows/IBL metals/emission/animation), custom worlds, off-device USD render.
- **Web** (the emulator's Chromium 138 + WebView activities): live-DOM panels, multi-panel
  workspaces, WebSpatial React apps, three.js 3D scenes (WebGL2/WebGPU), live-data monitors.
- **Fused**: the web↔3D bridge lets HTML buttons drive the native physics scene; the unified
  `compile_spatial_experience` routes any brief to the right lane(s).

## Honest boundaries (and one retraction, on the record)
- **Native run receipt v1 is structural, debug-only provenance.** On the POSIX/emulator fleet lane,
  a producer-written receipt binds normalized/effective AppSpec identities, bounded Gradle inputs,
  one AGP-selected debug APK and installed-byte digest, package/session/PID/foreground continuity,
  and one immutable capture. `fleet_build` returns the full receipt object; Door 1 returns
  `receiptId`, `receiptPath`, and the exact `capture`. The receipt creates no ledger evidence and
  says nothing about its pixels. A separate LOOK recorded with that exact capture and
  `runReceiptId` is required. `ship_checklist` can then accept only those current debug bytes while
  remaining `NOT READY` for release APK/signing/store work. V1 establishes no web deployment,
  Swan/hardware, native-Windows, release, or rendered-appearance claim.
- **Knowledge evidence has two tiers.** `knowledge_api` provides broad contextual graph results
  through a persistent pico-cli session; availability or a graph answer is structural integration
  evidence, not proof that a symbol or signature is correct. `vault_api` remains authoritative for
  exact installed-SDK declarations and file/line citations. An opt-in `knowledgeSecondOpinion` from
  `preflight_lint` is explicitly advisory and never changes `clean`.
- **Passthrough auto-judging is conditional, not blanket-disabled.** On high-coverage Mixed-stage
  frames, count/not-black/dominant-color checks contribute zero confidence. At least two distinct
  authored colors can score through the color-key lane at its default 0.8 threshold; otherwise the
  judge escalates. `auto_judged` remains weaker than a capture someone actually LOOKED at.
- **Immersive Unity VR had looked-at emulator attestations, but their retained pixel provenance is
  now broken.** The historical v30.1 correction attributed earlier black `adb screencap` frames to
  the shell-vs-XR capture path and recorded `com.picoagent.pxrvr` seq 0 plus
  `com.picospatial.helloopenxr` seq 3. Both linked files are now missing, so the current reader
  downgrades both rows to `provenance-broken`; this snapshot does not publish that render claim as
  currently verified. Re-run each unchanged APK through the available adb and host-window capture
  paths as applicable, and LOOK again to
  restore the evidence. The shell-vs-XR capture-path hypothesis remains structural guidance, not a
  universal rule or current visual proof; collect adb and host-window captures when needed, and
  treat a black adb frame as inconclusive.
- **Native-NDK and WebXR immersive status is OPEN** — not negative, not settled. The 2026-07-02
  probes reported a compositor *loading fallback* in the GUI viewport and were never re-run
  after the shell-policy fix or through the corrected capture path.
- **Controller-ray input and head-tracked depth** remain deferred to a 6.1 emulator or PICO
  Swan hardware; they flip only after direct looked-at evidence (`swan_verify_matrix`). No Swan
  hardware run has occurred in this repository.
- **WebSpatial spatial depth** activates on **PICO OS 6**. The currently retained 2D-projection
  evidence is structural, not current visual proof.
- Physics simulates on the emulator; the Unity build lane is `unity_scaffold_project` +
  `unity_build_apk`. A compatible Unity-built APK can enter the supported install/session/capture
  workflow, but the visual tier depends on a fresh capture that is actually LOOKED at and remains
  provenance-intact — see [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md).

*Re-generate anytime: `capability_matrix`. Per-app detail: `ledger_report`. The machine-readable
dated snapshot in `docs/claims/claims.json` retains every downgraded row and its provenance reason.*

Seven ecosystem questions with narrower evidence boundaries are collected in
[Questions answered by measurement](docs/ANSWERED_BY_MEASUREMENT.md).
