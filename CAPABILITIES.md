# 🗂️ Capabilities — what pico-spatial-mcp can do, and how we know

*Generated from the trust ledger via `capability_matrix`. Every row's "best evidence" is the
STRONGEST proof on file — `vision_verified` means a human or agent LOOKED at a rendered frame.
The honesty invariant makes this non-negotiable: nothing appears "verified" without a linked capture.*

**14 capability categories proven across 36 apps; 97 ledger entries (67 vision_verified — a human/agent LOOKED).**

Evidence totals: `vision_verified` 67 · `auto_judged` 7 · `usd_host_render` 3 · `structural` 19 · `built_for_headset` 1

| Capability | Best evidence | Proofs | Apps |
|---|---|---|---|
| Real physics (native) | `vision_verified` | 36 | 11 |
| Interactive menus | `vision_verified` | 18 | 13 |
| Live-text / HUD panels | `vision_verified` | 11 | 6 |
| Web panels (live DOM) | `vision_verified` | 12 | 5 |
| Multi-panel web workspace | `vision_verified` | 6 | 4 |
| WebSpatial (React, OS6) | `vision_verified` | 6 | 4 |
| Web↔3D bridge | `vision_verified` | 7 | 4 |
| Web 3D (three.js) | `vision_verified` | 6 | 6 |
| AAA fidelity | `vision_verified` | 28 | 17 |
| Pipeline (brief→app) | `vision_verified` | 12 | 7 |
| Unattended fleet | `vision_verified` | 15 | 13 |
| Editor integration | `vision_verified` | 6 | 3 |
| Custom worlds / env | `vision_verified` | 21 | 14 |
| Off-device render | `vision_verified` | 5 | 4 |

## Two lanes, one verification loop
- **Native Spatial SDK** (Kotlin/Filament): real rigid-body physics, clickable in-world menus,
  AAA fidelity (PBR/shadows/IBL metals/emission/animation), custom worlds, off-device USD render.
- **Web** (the emulator's Chromium 138 + WebView activities): live-DOM panels, multi-panel
  workspaces, WebSpatial React apps, three.js 3D scenes (WebGL2/WebGPU), live-data monitors.
- **Fused**: the web↔3D bridge lets HTML buttons drive the native physics scene; the unified
  `compile_spatial_experience` routes any brief to the right lane(s).

## Honest boundaries (deferred, never claimed)
- Boundless walk-around immersion is not capture-verified on the tested **0.13.1 / PICO OS 6.0
  emulator**. Native OpenXR and WebXR previously produced the same black-output symptom; the
  Unity 6000.4.9f1 + official PICO OpenXR settling test reproduces it independently:
  FOCUSED session, running display, advancing frames, 60/60 runtime telemetry, and an app-owned
  layer were structurally proven, while three looked-at 2160×2158 captures were uniformly black.
  That is a structural runtime success with the intended immersive pixels absent from capture —
  not a visually successful or `vision_verified` Unity scene. This test does not isolate
  compositor promotion from an earlier Unity camera/render-target stage. Re-test on a 6.1
  emulator or Swan hardware.
- **WebSpatial spatial depth** activates on **PICO OS 6** (the 2D projection is verified now).
- Physics simulates on the emulator; Unity XR build stays in the companion Unity MCP. Its APKs can
  be build/install/session-verified here, while immersive pixels remain deferred on this emulator
  build — see [docs/UNITY_OPENXR.md](docs/UNITY_OPENXR.md).

*Re-generate anytime: `capability_matrix`. Per-app detail: `ledger_report`.*
