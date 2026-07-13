# pico-spatial-mcp

An MCP server that lets AI agents build **PICO XR spatial apps end-to-end on the emulator** — from a natural-language brief to a running, verified, shippable native app, no headset required. It authors scenes as text, compiles them through the real `spatialbundle`/Gradle toolchain, builds and deploys APKs, drives the PICO OS 6 emulator (lifecycle, adb, snapshots, an experimental gRPC XR layer), and — crucially — **verifies its own work by capturing rendered frames and looking at them.**

> ### The honesty invariant
> "Verified" means an agent or human **looked at a rendered frame** — never a compile, a log line, or a pixel heuristic. Every visual claim is recorded in a trust ledger that *structurally rejects* a `vision_verified` entry without a linked, looked-at capture. Honest deferral (`structural`, `built-for-Swan`, "I tried X and it failed") is always acceptable; a silent over-claim is the only unforgivable failure.

## What it can do

**Two compile lanes, fused.**

- **Native Spatial SDK** (Kotlin / Filament): real rigid-body physics, clickable in-world menus, AAA fidelity (PBR, directional shadows, IBL metals, HDR emission, point lights), runtime animation, procedural set dressing, and **baked textured signage** — real text in-world the SDK can't draw at runtime.
- **Web** (the emulator's Chromium + WebView activities): live-DOM spatial panels, multi-panel workspaces, WebSpatial React apps, three.js / WebXR 3D scenes, and live-data monitors fed by real APIs.
- **Fused**: a web↔3D bridge (HTML buttons drive the native physics scene), a unified compiler that routes any brief to the right lane(s), and a one-command hybrid builder.

**Concept → shippable, end to end.** A brief becomes a scaffolded app → an authored scene → build & deploy → capture → fidelity score → iterate → a **signed release APK**, with a perf probe and an honest ship checklist along the way. Flagship demo: a playable neon bowling alley — set dressing, real-text marquee/scoreboard, and rigid-body pins — built entirely on the emulator.

**A verification loop as the crown jewel.** `capture_frame` + a look, the trust ledger (`record_verification` / `ledger_report`), a fidelity rubric, a deterministic multi-angle capture rig, a perf probe, and a **capability matrix** that reads the ledger into an honest report of what the tool can actually do and how it's known. A cross-builder contract (`verify_pico_apk`) lets a companion builder (e.g. a Unity MCP) hand over an APK for the same verify loop.

→ See **[CAPABILITIES.md](CAPABILITIES.md)** for the honest capability matrix — every category with its strongest evidence class.

## Requirements

- macOS with the PICO Spatial toolchain installed via the Android Studio **PICO Spatial Plugin** (payloads under `~/Library/PICO/sdk/<version>/`, license accepted).
- A PICO AVD created via Android Studio Device Manager (lives in `~/.pico/avd`).
- `adb` on PATH (or the toolchain's bundled platform-tools are used).
- Node.js ≥ 20.

## Install

**As a Claude Code plugin (recommended)** — the repo is a self-contained plugin marketplace:

```bash
claude plugin marketplace add sushidoescode/PICO-MCP   # or a local clone path
claude plugin install pico-spatial-mcp@pico-mcp
```

First launch auto-installs dependencies and builds (one-time, ~1 min; progress on stderr). Works alongside PICO's official `pico-spatial-agentic-tools` plugin — theirs guides the agent with skills + SDK knowledge, this one is the build/verify/ship toolchain.

**Or as a plain MCP server:**

```bash
npm install && npm run build
claude mcp add pico-spatial -- node /path/to/PICO-MCP/dist/index.js
```

Or in any MCP client config:

```json
{ "mcpServers": { "pico-spatial": { "command": "node", "args": ["/path/to/PICO-MCP/dist/index.js"] } } }
```

## How agents use it

The server ships built-in prompts that drive the loop — the dev workflow and the autonomous build (brief → scaffold → author → build & run → **the verify gate: structural checks + a frame you LOOK at** → diagnose → iterate → ship). Two representative loops:

- **Inner loop** (fast, scene-only): edit scene text → `iterate_scene` (pack + inspect + preview + capture) → adjust → repeat.
- **Full app loop**: `emulator_boot` → `build_and_run` (build + install + launch + crash-check + capture) → drive interactions → `check_crash` / `wait_for_log` → `record_verification` on a frame you looked at.

The tools span emulator control (lifecycle, adb, snapshots, gRPC), text-first scene authoring + `spatialbundle`/Gradle compilation, the native + web codegen lanes, and the verification/ship suite. `scaffold_spatial_app` is the "start any project" entry point; the built-in `pico_spatial_dev_loop` prompt carries the full agent guidance. See **[QUICKSTART.md](QUICKSTART.md)** to get going and **[SKILLS.md](SKILLS.md)** for the agent reference.

## Honest boundaries (the emulator ceiling)

The PICO emulator renders bounded, eye-level content and floating spatial panels — **not** boundless walk-around immersion. Full-immersive OpenXR frame compositing, controller-ray input, and head-tracked depth are **PICO Swan hardware**: the tool builds for them and defers them honestly (`built-for-Swan`), then flips each row to device-verified when a headset is attached (`swan_verify_matrix`). WebSpatial spatial depth activates on **PICO OS 6** (the 2D projection is verifiable today). Programmatic head-pose driving is **gated** on this emulator build (GUI-only WASD, confirmed by pixel-diff probes) — `xr_input_status` reports the full map. Immersive 3D composites into the host GUI window only, so spatial scenes are verified via host-composited captures + the spatial runtime logcat, not display-0 screenshots.

## Documentation

- **[QUICKSTART.md](QUICKSTART.md)** — the front door
- **[CAPABILITIES.md](CAPABILITIES.md)** — the honest capability matrix (categories + evidence)
- **[DESIGN.md](DESIGN.md)** — architecture + correctness rules (runtime physics, PICO math API, editor MaterialX, the visual-ground-truth rule)
- **[PLUGINS.md](PLUGINS.md)** — plugin surfaces · **[SKILLS.md](SKILLS.md)** — agent reference
- **[docs/](docs/)** — worked examples (a ClaimSight native build, local open-weight models, the decompiled spatial interaction API) and **[examples/](examples/)** — reference scenes

## Testing

```bash
npm run smoke        # toolchain/bundle/proto tools against the real local install (no emulator boot)
npm run test:lint    # the retained-lessons lint rules fire on their fixtures
npm run test:ledger  # the trust ledger rejects an unlinked vision_verified claim
```

## Licensing

- This project: **Apache-2.0** (see `LICENSE`).
- It **wraps your locally installed, license-accepted PICO toolchain** — it contains and redistributes **no** PICO or Google SDK binaries. It discovers and invokes your own installation only, gates on your existing license-acceptance markers, and loads the emulator's gRPC `.proto` definitions from your local install at runtime.
- Known limits of the underlying surface: per-controller 6DOF pose injection and skeletal hand-tracking injection are not exposed by the emulator (controllers are keyboard-mapped; hand-tracking is GUI/webcam-bound).
