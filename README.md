# pico-spatial-mcp

An MCP server that lets AI agents drive **PICO XR spatial development**: the PICO OS6 Emulator, adb automation, the `spatialbundle`/Gradle scene-compilation pipeline, and (experimentally) gRPC-based XR input injection — head pose, recenter, passthrough — discovered in [FINDINGS.md](FINDINGS.md).

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
| `xr_grpc_describe` / `xr_grpc_status` / `xr_screenshot` | **Experimental** gRPC control channel (protos loaded from your install) — verified working on emulator 0.13.1 |
| `xr_set_head_pose` / `xr_recenter` / `xr_set_options` / `xr_send_key` | **Experimental** XR input: 6DOF head pose injection, recenter, passthrough/environment, controller keys |

> **Known limitation (emulator 0.13.1, tested live 2026-06-11):** the `xr_*` injection RPCs are accepted by the emulator (transport, token auth, and schema all verified; `getXrOptions` returns real state), but the SpaceOS guest does **not visibly apply** head-pose, passthrough, or physical-model rotation changes — the rendered view stays fixed. The injection path is compiled in but appears gated (candidate: the emulator's input-modality mode, cf. its `-support-multiple-input-modalite` flag and `XrInputModeDialog`). `test/xr-experiment.mjs` is the probe harness; see FINDINGS.md §6. gRPC screenshots, status, sensors, and `sendKey` work.

## Typical agent loop

1. `validate_toolchain` → 2. edit USDA scene (plain text) → 3. `pack_bundle` → 4. `inspect_bundle` → 5. `gradle_build assembleDebug` → 6. `emulator_boot` → 7. `app_install` + `app_launch` → 8. `xr_set_head_pose` / `ui_input` → 9. `screencap` / `logcat` → iterate.

## Testing

```bash
npm run smoke   # exercises toolchain/bundle/proto tools against the real local install (no emulator boot)
```

Live emulator tests: boot via `emulator_boot` (`headless: true`), then `xr_grpc_status` → `xr_screenshot` → `xr_set_head_pose` and diff screenshots.

## Licensing posture

- This project: Apache-2.0 (see LICENSE).
- It must **never** bundle, mirror, or auto-download PICO or Google SDK binaries — it discovers and invokes the user's own installation only, and gates on the user's existing license-acceptance markers.
- Known limits of the underlying surface: per-controller 6DOF pose injection is **not** exposed by the emulator (controllers are keyboard-mapped); skeletal hand-tracking injection is GUI/webcam-bound. See `FINDINGS.md` §4 Phase 3.
