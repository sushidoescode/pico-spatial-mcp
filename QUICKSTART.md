# ⚡ Quickstart — pico-spatial-mcp

Build native PICO XR spatial apps from natural-language briefs, with **verified** results
(the agent looks at rendered frames — it never claims what it hasn't seen).

## 1. Register (once)
```bash
git clone <this repo> ~/PICO-MCP && cd ~/PICO-MCP && npm ci && npm run build
claude mcp add pico-spatial-mcp --scope user -- node ~/PICO-MCP/dist/index.js
```
Requirements: macOS, the PICO SDK 0.13 (Spatial Editor + emulator), Android Studio (its JBR),
ImageMagick (`brew install imagemagick`). Optional: Blender (custom menu panels), Filament cmgen (IBL).

## 2. Run the emulator
Open the PICO **Spatial Editor** app (it boots the emulator) or confirm `emulator-5554` via
`~/Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb devices`.

## 3. Ask for an app
Start `claude` anywhere and describe what you want:

> *Build me a physics knockdown game for the PICO emulator: throw a ball at racked targets from a
> clickable menu, with a live THROWS scoreboard. Build it, run it, and show me a captured frame
> proving the strike.*

The agent will discover the pipeline itself (templates → plan → compile → build → verify) —
this exact brief passed a cold-agent acceptance run with zero hints. See `DRY_RUN.md` for the
rehearsal script and `VIDEO_DEMO.md` to record it.

## What it can build (all verified on the emulator)
Real rigid-body **physics** (strikes, drops) · clickable in-world **menus** (custom labels; your
Mac mouse clicks them) · **live-text scoreboards/HUDs** and full **web-content panels** (live JS
DOM) · AAA fidelity (PBR, shadows, shining IBL metals, animation) · procedural props incl. lathe
silhouettes · custom World-Labs worlds · multi-scene apps. The `com.pico.hooks` gradle plugin
lints scenes in every build; `fleet_build` builds brief batches unattended with an honest
auto-judge. Boundless walk-around immersion is PICO Swan hardware territory — the emulator's
strength is bounded, eye-level content, and every claim above is backed by a looked-at frame.

## The Twelve Doors (recommended for first-time users)

190+ tools is power you don't need on day one. Start with the intent-level facade:

```bash
PICO_MCP_SURFACE=doors claude mcp add pico-spatial -- node /path/to/PICO-MCP/dist/index.js
```

Twelve doors, one per intent: `pico_build_app` (brief → verified app), `pico_scan_world`
(splat → labeled semantic scene), `pico_place` (natural-language anchors), `pico_look`
(deterministic capture — read it!), `pico_verify_app` (verify ANY apk), `pico_measure`
(calibrated placement metrics), `pico_perf` (official profiler), `pico_sdk` (exact SDK
declarations), `pico_doctor`, `pico_ship`, `pico_capabilities`, `pico_fix` (paste an error,
get the retained lesson). Every door failure returns a `fix` pointing at the exact next step.
Remove the env var to expose the full surface — the doors stay available either way.

First light in three calls: `pico_doctor` → `pico_build_app("three spinning crystals over a
stone floor")` → `pico_look` (and actually look).
