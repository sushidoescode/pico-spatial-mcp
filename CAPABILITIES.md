# 🗂️ Capabilities — what pico-spatial-mcp can do, and how we know

*Generated from the trust ledger via `capability_matrix`. Every row's "best evidence" is the
STRONGEST proof on file — `vision_verified` means a human or agent LOOKED at a rendered frame.
The honesty invariant makes this non-negotiable: nothing appears "verified" without a linked capture.*

**14 capability categories proven across 27 apps; 81 ledger entries (54 vision_verified — a human/agent LOOKED).**

Evidence totals: `vision_verified` 54 · `auto_judged` 6 · `usd_host_render` 3 · `structural` 17 · `built_for_headset` 1

| Capability | Best evidence | Proofs | Apps |
|---|---|---|---|
| Real physics (native) | `vision_verified` | 29 | 7 |
| Interactive menus | `vision_verified` | 13 | 9 |
| Live-text / HUD panels | `vision_verified` | 10 | 5 |
| Web panels (live DOM) | `vision_verified` | 12 | 5 |
| Multi-panel web workspace | `vision_verified` | 6 | 4 |
| WebSpatial (React, OS6) | `vision_verified` | 6 | 4 |
| Web↔3D bridge | `vision_verified` | 7 | 4 |
| Web 3D (three.js) | `vision_verified` | 6 | 6 |
| AAA fidelity | `vision_verified` | 22 | 12 |
| Pipeline (brief→app) | `vision_verified` | 9 | 4 |
| Unattended fleet | `vision_verified` | 11 | 9 |
| Editor integration | `vision_verified` | 6 | 3 |
| Custom worlds / env | `vision_verified` | 8 | 8 |
| Off-device render | `vision_verified` | 5 | 4 |

## Two lanes, one verification loop
- **Native Spatial SDK** (Kotlin/Filament): real rigid-body physics, clickable in-world menus,
  AAA fidelity (PBR/shadows/IBL metals/emission/animation), custom worlds, off-device USD render.
- **Web** (the emulator's Chromium 138 + WebView activities): live-DOM panels, multi-panel
  workspaces, WebSpatial React apps, three.js 3D scenes (WebGL2/WebGPU), live-data monitors.
- **Fused**: the web↔3D bridge lets HTML buttons drive the native physics scene; the unified
  `compile_spatial_experience` routes any brief to the right lane(s).

## Honest boundaries (deferred, never claimed)
- Boundless walk-around immersion + immersive-frame compositing (native OpenXR and WebXR) are
  **Swan-hardware** — the WebXR *session + pose* layer runs headlessly today; only the visual
  compositing waits for hardware.
- **WebSpatial spatial depth** activates on **PICO OS 6** (the 2D projection is verified now).
- Physics simulates on the emulator; Unity XR build stays in the companion Unity MCP (a Unity VR
  app can't visually verify on this emulator regardless — see ROADMAP §5).

*Re-generate anytime: `capability_matrix`. Per-app detail: `ledger_report`.*
