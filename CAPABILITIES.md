# 🗂️ Capabilities — what pico-spatial-mcp can do, and how we know

*Generated from the trust ledger via `capability_matrix`. Every row's "best evidence" is the
STRONGEST proof on file — `vision_verified` means a human or agent LOOKED at a rendered frame.
The honesty invariant makes this non-negotiable: nothing appears "verified" without a linked capture.*

**14 capability categories proven across 70 apps; 209 ledger entries (110 vision_verified — a human/agent LOOKED).**

Evidence totals: `vision_verified` 110 · `auto_judged` 29 · `usd_host_render` 5 · `logcat` 8 · `structural` 56 · `built_for_headset` 1

| Capability | Best evidence | Proofs | Apps |
|---|---|---|---|
| Real physics (native) | `vision_verified` | 56 | 20 |
| Interactive menus | `vision_verified` | 32 | 18 |
| Live-text / HUD panels | `vision_verified` | 16 | 9 |
| Web panels (live DOM) | `vision_verified` | 14 | 6 |
| Multi-panel web workspace | `vision_verified` | 7 | 5 |
| WebSpatial (React, OS6) | `vision_verified` | 6 | 4 |
| Web↔3D bridge | `vision_verified` | 14 | 7 |
| Web 3D (three.js) | `vision_verified` | 6 | 6 |
| AAA fidelity | `vision_verified` | 35 | 21 |
| Pipeline (brief→app) | `vision_verified` | 21 | 12 |
| Unattended fleet | `vision_verified` | 59 | 34 |
| Editor integration | `vision_verified` | 12 | 9 |
| Custom worlds / env | `vision_verified` | 38 | 25 |
| Off-device render | `vision_verified` | 6 | 5 |

## Two lanes, one verification loop
- **Native Spatial SDK** (Kotlin/Filament): real rigid-body physics, clickable in-world menus,
  AAA fidelity (PBR/shadows/IBL metals/emission/animation), custom worlds, off-device USD render.
- **Web** (the emulator's Chromium 138 + WebView activities): live-DOM panels, multi-panel
  workspaces, WebSpatial React apps, three.js 3D scenes (WebGL2/WebGPU), live-data monitors.
- **Fused**: the web↔3D bridge lets HTML buttons drive the native physics scene; the unified
  `compile_spatial_experience` routes any brief to the right lane(s).

## Honest boundaries (and one retraction, on the record)
- **Knowledge evidence has two tiers.** `knowledge_api` provides broad contextual graph results
  through a persistent pico-cli session; availability or a graph answer is structural integration
  evidence, not proof that a symbol or signature is correct. `vault_api` remains authoritative for
  exact installed-SDK declarations and file/line citations. An opt-in `knowledgeSecondOpinion` from
  `preflight_lint` is explicitly advisory and never changes `clean`.
- **Passthrough auto-judging is conditional, not blanket-disabled.** On high-coverage Mixed-stage
  frames, count/not-black/dominant-color checks contribute zero confidence. At least two distinct
  authored colors can score through the color-key lane at its default 0.8 threshold; otherwise the
  judge escalates. `auto_judged` remains weaker than a capture someone actually LOOKED at.
- **Immersive Unity VR RENDERS on the emulator** — the v30.1 retraction. The July-22 Unity
  settling test's uniformly black captures were an `adb screencap` artifact, not a compositing
  failure: screencap reads the shell composite (home env, 2D panels, native Spatial SDK apps)
  and is structurally blind to XR-runtime output (Unity's own log: `Skip Present To Main
  Screen: Yes`). Captured through the emulator window (`gui_capture`), BOTH Unity routes — the
  PICO Integration SDK (`PXR_Loader`) and the OpenXR SDK, via the unchanged sha-pinned July-22
  APK — fill the view with their intended immersive scenes. Ledgers `com.picoagent.pxrvr` seq 0
  and `com.picospatial.helloopenxr` seq 3, both `vision_verified`. Capture-path rule: shell
  content → `capture_frame`/adb; XR-runtime immersive → `gui_capture`.
- **Native-NDK and WebXR immersive status is OPEN** — not negative, not settled. The 2026-07-02
  probes reported a compositor *loading fallback* in the GUI viewport and were never re-run
  after the shell-policy fix or through the corrected capture path.
- **Controller-ray input and head-tracked depth** remain deferred to a 6.1 emulator or PICO
  Swan hardware; they flip only after direct looked-at evidence (`swan_verify_matrix`).
- **WebSpatial spatial depth** activates on **PICO OS 6** (the 2D projection is verified now).
- Physics simulates on the emulator; the Unity build lane is `unity_scaffold_project` +
  `unity_build_apk`, and any Unity-built APK can be install/session/vision-verified here through
  the right capture path — see [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md).

*Re-generate anytime: `capability_matrix`. Per-app detail: `ledger_report`.*
