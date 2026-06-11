# pico-spatial-mcp

An MCP server that lets AI agents drive **PICO XR spatial development** end-to-end: author USDA scenes as text, compile them with the `spatialbundle`/Gradle pipeline, build & deploy APKs, drive the PICO OS6 Emulator (lifecycle, adb, snapshots), preview scenes via the editor's ScenePreview app, and observe/verify with screenshots, UI dumps, log-waits, and crash detection — plus an experimental gRPC XR layer (head pose, recenter, passthrough). Background research: [FINDINGS.md](FINDINGS.md).

**42 tools** across observe/control, the full editor+build pipeline, and autonomous-loop orchestration (`iterate_scene`, `build_and_run`). A built-in prompt (`pico_spatial_dev_loop`) teaches an agent the whole workflow.

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
| `create_scene_project` / `build_spatial_project` | Scaffold a `.spatialproject` (editor structure); build it via the editor's own headless mode (`--ide_noGraphics`) for GUI parity |
| `preview_scene` | Deploy a `.bundle` to the editor's ScenePreview app (push + `FILE_TRANSFER_COMPLETE` broadcast — the editor's real on-device-preview protocol) |
| `iterate_scene` | **Orchestration:** pack → inspect → deploy-to-preview → screenshot in one call (the inner dev loop) |
| `build_and_run` | **Orchestration:** Gradle build → install → launch → crash-check → screenshot (the full app loop) |
| `snapshot_save` / `snapshot_load` / `snapshot_list` | Emulator VM snapshots — capture a known-good state, restore it before each test for determinism |
| `ui_dump` | UI hierarchy as structured elements (text/id/bounds/center) — find elements by name instead of guessing coordinates (2D view layer) |
| `wait_for_log` / `check_crash` | Block until a logcat pattern appears; scan for crashes/ANRs and process liveness |
| `controller_map` / `controller_press` | PICO controller bindings (from the AVD's `controller_settings.ini`) and press-by-name (e.g. `RC_Trigger`) |
| `screenrecord` | Record N seconds of the screen to mp4 (verify animation a screenshot can't) |
| `xr_grpc_describe` / `xr_grpc_status` / `xr_screenshot` | **Experimental** gRPC control channel (protos loaded from your install) — verified working on emulator 0.13.1 |
| `xr_set_head_pose` / `xr_recenter` / `xr_set_options` / `xr_send_key` | **Experimental** XR input: 6DOF head pose injection, recenter, passthrough/environment, controller keys |

> **Known limitation (emulator 0.13.1, tested live 2026-06-11):** the `xr_*` injection RPCs are accepted by the emulator (transport, token auth, and schema all verified; `getXrOptions` returns real state), but the SpaceOS guest does **not visibly apply** head-pose, passthrough, or physical-model rotation changes — the rendered view stays fixed. The injection path is compiled in but appears gated (candidate: the emulator's input-modality mode, cf. its `-support-multiple-input-modalite` flag and `XrInputModeDialog`). `test/xr-experiment.mjs` is the probe harness; see FINDINGS.md §6. gRPC screenshots, status, sensors, and `sendKey` work.

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
