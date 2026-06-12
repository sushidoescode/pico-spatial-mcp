# pico-spatial-mcp

An MCP server that lets AI agents drive **PICO XR spatial development** end-to-end: author USDA scenes as text, compile them with the `spatialbundle`/Gradle pipeline, build & deploy APKs, drive the PICO OS6 Emulator (lifecycle, adb, snapshots), preview scenes via the editor's ScenePreview app, and observe/verify with screenshots, UI dumps, log-waits, and crash detection — plus an experimental gRPC XR layer (head pose, recenter, passthrough). Background research: [FINDINGS.md](FINDINGS.md).

**54 tools** across observe/control, the full editor+build pipeline, programmatic scene authoring (`compose_scene`, `import_asset`), autonomous-loop orchestration (`iterate_scene`, `verify_scene`, `build_and_run`), host-GUI capture/drive of the real 3D view (`gui_capture`, `gui_camera`), and a ClaimSight-style inspection-app builder (`compose_inspection_scene`, `import_environment`, `worldmodel_guide`). A built-in prompt (`pico_spatial_dev_loop`) teaches an agent the whole workflow.

### Building a real app: ClaimSight inspection scenes + world-model environments

`compose_inspection_scene` assembles a legit insurance-inspection spatial app — a damaged-room environment (procedural, or a referenced GLB/splat room from a world model), severity-colored damage markers pinned in 3D using ClaimSight's canonical 5-tier palette (green→purple) and real damage taxonomy (water/electrical/structural/wind/hail/mold/…), and an info panel. Environments can come from **World Labs Marble** (text/photo→3D world; free tier 4 gens/mo, GLB/PLY export needs a paid plan) or a free Scaniverse/Polycam scan — `import_environment` brings the GLB/skybox in, `worldmodel_guide` documents the full workflow.

### Seeing the 3D result

`gui_capture` (macOS) screenshots the emulator's **real host-composited 3D window** — the only way to see immersive 3D (display-0 screenshots can't). Needs one-time Screen Recording permission. To *navigate* the camera to framed scene content, `gui_camera` drives WASD camera mode (needs Accessibility permission); ScenePreview renders a scene as a ~2.5m "stage" diorama that spawns off the default view, so you navigate to it or grant Accessibility. Geometry correctness is always verifiable headlessly via `verify_scene`.

### Verifying spatial content (important)

The PICO emulator renders immersive 3D content host-side and composites it into the **GUI window only**. Display-0 screenshots (adb or gRPC) capture the home environment and 2D panels but **not** immersive 3D scene content — so verify spatial scenes with **`verify_scene` / `inspect_bundle`** (geometry, mesh, material, texture counts) and the spatial-runtime **logcat**, not screenshots. See `xr_input_status` and FINDINGS.md §6.

> **Status: private / pre-release.** Do not make this repository public until the licensing review in `FINDINGS.md` §5 is completed (PICO SDK License Terms + NDA scope). This server **wraps the user's locally installed, license-accepted PICO toolchain** — it contains and redistributes no PICO software, and loads the emulator's gRPC `.proto` definitions from the local installation at runtime.

## Requirements

- macOS with the PICO Spatial toolchain installed via the Android Studio **PICO Spatial Plugin** (payloads under `~/Library/PICO/sdk/<version>/`, license accepted).
- A PICO AVD created via Android Studio Device Manager (lives in `~/.pico/avd`).
- `adb` on PATH (or the toolchain's bundled platform-tools are used).
- Node.js ≥ 20.

## Install

```bash
npm install && npm run build
```

Register with Claude Code:

```bash
claude mcp add pico-spatial -- node /path/to/PICO-MCP/dist/index.js
```

Or in any MCP client config:

```json
{ "mcpServers": { "pico-spatial": { "command": "node", "args": ["/path/to/PICO-MCP/dist/index.js"] } } }
```

## Tools

| Tool | What it does |
|---|---|
| `validate_toolchain` | Preflight: tools root resolution (`local.properties` → `$PICO_HOME` → default), binaries, AVDs, license markers |
| `emulator_boot` / `emulator_kill` / `emulator_list` / `emulator_status` | PICO OS6 emulator lifecycle (headless by default, waits for full boot) |
| `emulator_console` | Android emulator console commands via `adb emu` (sensors, rotate, screenrecord, snapshots) |
| `adb_devices` / `app_install` / `app_launch` / `app_stop` | App lifecycle on the emulator/headset |
| `screencap` / `logcat` / `ui_input` / `adb_shell` / `file_push` / `file_pull` | Observe & control via adb |
| `pack_bundle` / `inspect_bundle` | Headless USDA→`.bundle` compilation + bundle stats/manifest (`spatialbundle` CLI) |
| `scene_schemas` | PICO's custom USD schemas (SpatialComponent/Audio/Timeline) for text-first scene authoring |
| `gradle_build` / `gradle_tasks` | Full `./gradlew` builds — the `com.pico.spatial.tools` plugin packs scenes into the APK automatically |
| `compose_scene` / `add_entity` / `import_asset` | **Author renderable scenes as text:** generate USDA from a high-level entity spec (mesh refs, primitives, lights, IBL); import meshes/textures into the project |
| `verify_scene` | Compile + inspect a scene and assert geometry (mesh/material/texture counts, expected mesh names) — the reliable spatial-content check |
| `create_scene_project` / `build_spatial_project` | Scaffold a `.spatialproject` (editor structure); build it via the editor's own headless mode (`--ide_noGraphics`) for GUI parity |
| `preview_scene` | Deploy a `.bundle` to the editor's ScenePreview app (push + `FILE_TRANSFER_COMPLETE` broadcast — the editor's real on-device-preview protocol) |
| `iterate_scene` | **Orchestration:** pack → inspect → deploy-to-preview → screenshot in one call (the inner dev loop) |
| `build_and_run` | **Orchestration:** Gradle build → install → launch → crash-check → screenshot (the full app loop) |
| `snapshot_save` / `snapshot_load` / `snapshot_list` | Emulator VM snapshots — capture a known-good state, restore it before each test for determinism |
| `ui_dump` | UI hierarchy as structured elements (text/id/bounds/center) — find elements by name instead of guessing coordinates (2D view layer) |
| `wait_for_log` / `check_crash` | Block until a logcat pattern appears; scan for crashes/ANRs and process liveness |
| `controller_map` / `controller_press` | PICO controller bindings (from the AVD's `controller_settings.ini`) and press-by-name (e.g. `RC_Trigger`) |
| `screenrecord` | Record N seconds of the screen to mp4 (verify animation a screenshot can't) |
| `xr_grpc_describe` / `xr_grpc_status` / `xr_screenshot` | gRPC control channel (protos loaded from your install); `xr_screenshot` streams a **live** display-0 frame |
| `xr_input_status` | Reports what XR input is / isn't programmatically drivable on this build — **call before attempting XR automation** |
| `xr_set_head_pose` / `xr_recenter` / `xr_set_options` / `xr_send_key` | **Experimental** XR input: head pose (gated — see below), recenter, passthrough/environment, controller keys |

> **XR head-pose is GATED (emulator 0.13.1, confirmed 2026-06-11).** The `xr_head_*` RPCs are accepted but do **not** move the rendered view: head/camera control is gated behind the GUI's WASD camera mode (`virtualscene/WASDInputHandler`), which has **no gRPC, console, or keyboard entry point** — only mouse interaction with the emulator window. Rigorous pixel-diff testing (`test/xr-gate-probe.mjs`) confirms no effect. Programmatic head-pose driving is not achievable on this build; treat it as GUI-only. What *does* work: live screenshots, sensors, keys/touch, `setXrOptions`, snapshots, and the entire build/scene pipeline. Run `xr_input_status` for the full map.

## Typical agent loop

Inner loop (fast, scene-only): `validate_toolchain` → edit USDA text → **`iterate_scene`** (pack+inspect+preview+screenshot) → adjust → repeat.

Full app loop: `emulator_boot` → **`build_and_run`** (build+install+launch+crash-check+screenshot) → `controller_press` / `ui_dump`+`ui_input` → `check_crash` / `wait_for_log` → `snapshot_save` a good state for repeatable tests.

Load the built-in `pico_spatial_dev_loop` prompt for full agent guidance.

## Testing

```bash
npm run smoke   # exercises toolchain/bundle/proto tools against the real local install (no emulator boot)
```

Live emulator tests: boot via `emulator_boot` (`headless: true`), then `xr_grpc_status` → `xr_screenshot` → `xr_set_head_pose` and diff screenshots.

## Licensing posture

- This project: Apache-2.0 (see LICENSE).
- It must **never** bundle, mirror, or auto-download PICO or Google SDK binaries — it discovers and invokes the user's own installation only, and gates on the user's existing license-acceptance markers.
- Known limits of the underlying surface: per-controller 6DOF pose injection is **not** exposed by the emulator (controllers are keyboard-mapped); skeletal hand-tracking injection is GUI/webcam-bound. See `FINDINGS.md` §4 Phase 3.
