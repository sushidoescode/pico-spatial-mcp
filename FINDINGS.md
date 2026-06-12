# PICO Spatial MCP — Feasibility & Design Findings

**Date:** 2026-06-11
**Method:** (a) web research with adversarial claim verification — 21 sources fetched, 102 claims extracted, 25 verified by 3-vote panels (24 confirmed, 1 refuted); (b) static forensic inspection of the toolchain installed on this machine (`~/Library/PICO/sdk/0.13`, Gradle cache, Android Studio `SpatialPlugin` 0.13.2), with every claim backed by file paths / command output; (c) GitHub API license verification of prior art.

**TL;DR:** The MCP is highly feasible, and dramatically more capable than the public docs suggest. The PICO OS6 Emulator is a rebadged Google Android Emulator 35.0.1 that **retains the full gRPC/console automation stack — including XR head-pose injection RPCs that ship, compiled-in, with .proto files in the SDK**. The USDA→bundle→APK pipeline is fully headless via Gradle tasks and a standalone `spatialbundle` CLI. None of the public docs mention any of this — they describe a GUI-only workflow. The only genuine gaps are per-controller 6DOF pose injection (no RPC exists; controllers are keyboard-mapped) and skeletal hand-tracking injection. No PICO-specific MCP exists; the Android-MCP prior art is Apache-2.0 and fork-safe.

---

## 1. What the emulator and Spatial Editor expose for automation

### 1.1 PICO OS6 Emulator

**Identity (verified locally):** ByteDance fork of Google's Android Emulator **35.0.1** (`Pkg.Revision=0.13.1`, `Pkg.RevisionOld=35.0.1` in `~/Library/PICO/sdk/0.13/emulator/source.properties`; `emulator -version` prints "derivative of the QEMU CPU emulator"). It boots an **Android 16 / SDK 36 arm64 "SpaceOS / PICO OS 6"** image with `ro.test_harness=1` set by default. AVDs live at `~/.pico/avd` (`ANDROID_AVD_HOME`), with editable `config.ini`/`hardware-qemu.ini`.

**Three automation transports survive the fork, all proven present:**

**(1) Process/CLI.** The full Google emulator CLI works (captured via `emulator -help`): `-no-window`, `-grpc <port>`, `-grpc-use-token`, `-ports <console>,<adb>`, `-snapshot`/`-snapshot-list`, `-wipe-data`, `-logcat-output`, `-list-avds`, `-quit-after-boot`, `-qemu` passthrough — plus PICO-specific flags `-emulator-sn`, `-systemui-renderer`, `-support-multiple-input-modalite`. A separate **`qemu-system-aarch64-headless`** binary (45 MB) exists and contains the full gRPC/XR symbol surface — headless CI operation is designed-in. Launch recipe used by the IDE plugin itself: `emulator -avd PICO_0.13 -gpu angle_indirect [-qt-hide-window] [-grpc-use-token]` with `ANDROID_AVD_HOME=~/.pico/avd`.

**(2) Telnet console (localhost:5554).** Compiled-in commands: `sensor set <name> x:y:z`, `rotate`, `geo fix`, `screenrecord start/stop`, `event` (raw evdev injection), `automation record/play` (macro record-replay — `AutomationController.cpp` is in the build), `kill`, `restart`, `avd discoverypath`, `fold/unfold`, `redir`, `power`, `gsm`/`sms`. Auth via `~/.emulator_console_auth_token` (file exists on this machine). This matches Google's documented console behavior (verified 3-0 against [developer.android.com/studio/run/emulator-console](https://developer.android.com/studio/run/emulator-console)).

**(3) gRPC EmulatorController — the headline finding.** Run logs on this machine show `Started GRPC server at 127.0.0.1:8554, security: Local, auth: +token`. The complete proto set **ships in the SDK** at `~/Library/PICO/sdk/0.13/emulator/lib/` (`emulator_controller.proto`, `snapshot_service.proto`, `ui_controller_service.proto`, `adb_service.proto`, `waterfall.proto`, `emulated_bluetooth.proto`, plus `emulator_access.json` defining token/JWT auth tiers) — so an MCP can codegen typed stubs directly from the user's installation. Standard RPCs: `getScreenshot`/`streamScreenshot` (faster than adb screencap), `streamLogcat`, `sendKey`/`sendTouch`/`sendMouse`, `setSensor`/`setPhysicalModel` (POSITION/ROTATION injection), `setGps`, SnapshotService save/load/pull. Token discovery dir: `~/Library/Caches/TemporaryItems/avd/pico_running` (PICO-renamed from Google's `avd/running`).

**XR-specific gRPC surface (verified in both the shipped proto and compiled binary symbols):**

- `streamInputEvent(stream InputEvent)` whose oneof includes **`xr_head_rotation_event` (RotationRadian), `xr_head_movement_event` (Translation), `xr_head_velocity_event`, `xr_head_angular_velocity_event`** — programmatic 6DOF *head*-pose injection;
- `xr_command` (`RECENTER`), `xr_hand_event` / `xr_eye_event` (MouseEvent-typed pointer-style hand/eye input);
- `setXrOptions`/`getXrOptions` — passthrough coefficient + virtual environment (`LIVING_ROOM_DAY/NIGHT`);
- Backing implementation symbols compiled into the QEMU binary: `XrInputEventSender::sendXrHeadRotation/Movement/Velocity/AngularVelocity`, `XrDeviceModel::setXrHeadRotation`, `sendXrScreenRecenter`, tracking-mode strings `SWITCH_TO_CONTROLLER_TRACKING` / `SWITCH_TO_EYE_TRACKING`.

Sources: `lib/emulator_controller.proto` lines 95–104, 279–284, 499–517, 853–878; `strings qemu-system-aarch64`. (Web verification note: an earlier claim that upstream's only XR surface is `setXrOptions` was **refuted 0-3** — the upstream emu-master-dev tree, and PICO's fork of it, carry the full XR input-event set.)

**Controller input — the genuine gap.** There is **no per-controller 6DOF pose RPC** in the proto. Controllers are driven via keyboard mapping persisted per-AVD in `~/.pico/avd/PICO_0.13.avd/controller_settings.ini` (left: Q/WASD/E/X/Z/M + joystick R; right: U/IJKL/O/Space/B/Y + camera C; plus `[Space_RayOffset]` ray-offset settings). An MCP can drive buttons/joysticks deterministically by synthesizing the mapped keys via gRPC `sendKey` or `adb shell input` — and can rewrite the mapping file itself — but cannot place a controller at an arbitrary 6DOF pose. Also not exposed as APIs: skeletal hand-joint injection (the MediaPipe webcam hand-tracking pipeline — `handtracking/hand_landmarker.task`, `PinchClassifier` — runs inside the Qt GUI process consuming a live camera) and eye gaze beyond the MouseEvent-style `xr_eye_event`.

**adb.** The VM registers as a vanilla adb device (`emulator-5554`, `host:emulator:5555` observed in run logs). PICO's docs confirm standard `adb install`/`push`/`shell` workflows (verified 3-0, [developer.picoxr.com](https://developer.picoxr.com/document/unity/pico-emulator/)). Bundled platform-tools 34.0.5 (emulator) and 36.0.0 (editor).

**Contrast with public docs:** PICO's documentation describes only GUI workflows — Device Manager creation, keyboard/mouse view control, a "Controller Mode" GUI ([manage-pico-emulator](https://developer.picoxr.com/document/spatial-toolkit/manage-pico-emulator/), verified 3-0) — and documents zero automation interfaces. Everything above was established from the shipped binaries/protos, not docs. That asymmetry is precisely the MCP's value, but it also means the surface is **undocumented and unstable by contract** (toolchain is 0.13.x-preview; emulator channel also publishes an 0.8.3-beta standalone build — two version channels exist).

### 1.2 Spatial Editor / `com.pico.spatial.tools` — build pipeline

**Verdict: fully headless, no IDE required — empirically proven on this machine** (the `claimsight` project's `editor-asset.bundle` was produced by Gradle and found merged into `app/build/intermediates/assets/debug/mergeDebugAssets/`).

**Gradle plugin (decompiled, 0.13.1).** Plugin ID `com.pico.spatial.tools` → `SpatialPackPlugin`. Registers tasks **`spatial_pack_task`**, `spatial_pack_task_base`, and per-bundle `spatial_pack_task_<Name>`; auto-wires them into AGP (`generate<Variant>Assets` dependsOn pack; merge/compress hooks patch the `.bundle` into the APK via zipflinger → ends up as `assets/<name>.bundle`). Tools-root resolution order: `spatial { spatialEditorDirectory }` DSL → `local.properties` key **`spatial.tools.dir`** → env **`PICO_HOME`**; required binary: `<root>/<ver>/editor/spatialbundle/spatialbundle`. Incremental builds via md5 `cache_key`. Scene project location: `src/main/res3d/<Name>/<Name>.spatialproject` (exactly one per module). So `./gradlew :module:spatial_pack_task` and `./gradlew :app:assembleDebug` are the complete scriptable loop.

**`spatialbundle` CLI (run with `--help`, v0.13.2.0-alpha.17).** Self-contained 37 MB binary with an embedded Pixar **USD v24** runtime, MaterialX 1.38.7, Filament's `matc` material compiler, and PICO's custom USD schemas. Subcommands: `pack` (`-s/--scene-dir`, `-o/--output-bundle`, `--formats usda usdc usdz usd gltf glb`, `--compress-textures astc4x4..astc12x12`, `--incremental-build`/`--force-build`, `--texture-dir`, `--scene-files`, `--discard-unused-resources`; hidden flags `--material-platform`, `--verbose`) and `info` (`--input`, `--details` → Entities/Meshes/Triangles/Vertices/Texture stats). Output `.bundle` is a **zip64 archive containing `BundleInfo.json`** — directly inspectable. The Gradle plugin invokes exactly this binary (`pack -p <proj> -s <scenes> -o <out> --formats usda --override-output`).

**Scene authoring is bypassable text.** Scenes are plain-text USDA; PICO's custom schemas are themselves shipped as readable `schema.usda` files (`SpatialComponent` with `info:id`, `SpatialAudio*`, `SpatialTimeline*` under `spatialbundle/usd/*/resources/`). An agent can author/edit scenes as text and compile them without ever opening the GUI. The GUI editor additionally has a **documented headless build mode** (`ide_build.sh`: `--project=<.spatialproject> --ide_noGraphics --ide_buildOutputDir=... --ide_resultCodeFile=...`, JSON result-code file) and a named-pipe IPC channel (`__IdePipe__Editor`/`__IdePipe__Ide`) to command builds in a running editor.

**Remaining GUI-only:** interactive viewport editing/gizmos, undo, asset-library browsing, visual shader-graph authoring. None block an end-to-end *write-USDA → pack → info-verify → build APK → install → observe* loop. (Meta's parallel toolchain — `com.meta.spatial.plugin` + Spatial Editor CLI — is confirmed headless-scriptable too, verified 3-0, which validates the architecture pattern.)

---

## 2. Prior art — license-vetted (GitHub API, checked 2026-06-11)

| Repo | Capabilities | Maturity | License | Fork + republish? |
|---|---|---|---|---|
| [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) | Android/iOS device + emulator automation over adb/UI Automator: screenshots, taps, swipes, text input, app install/launch/terminate | 5,179★, pushed 2026-06-09 (very active) | **Apache-2.0** (verified 3-0 + API) | ✅ Yes |
| [minhalvp/android-mcp-server](https://github.com/minhalvp/android-mcp-server) | Python adb wrapper MCP: screenshot, UI layout, packages, shell | 761★, pushed 2025-05-28 (stale ~1yr) | **Apache-2.0** | ✅ Yes |
| [hyperb1iss/droidmind](https://github.com/hyperb1iss/droidmind) | Rich Android control MCP (adb, diagnostics, file ops, multi-device) | 406★, pushed 2026-01-07 | **Apache-2.0** | ✅ Yes |
| [landicefu/android-adb-mcp-server](https://github.com/landicefu/android-adb-mcp-server) | Minimal adb MCP (Node) | 36★, pushed 2025-03-06 | **ISC** (permissive) | ✅ Yes |
| [CyanBukkit/PicoXR-Doc-MCP](https://github.com/CyanBukkit/PicoXR-Doc-MCP) | PICO *docs* retrieval only (no device/build control) | 0★ | **No license** | ❌ Not safe |

**Key conclusions:** (a) **No PICO-emulator/spatial-toolchain MCP exists** — the niche is empty; (b) **mobile-mcp (Apache-2.0)** is the strongest fork base for the adb/device layer and already implements the Phase-1 observe/control surface (verified 3-0); (c) nothing in the ecosystem touches the gRPC XR surface, `spatialbundle`, or the PICO Gradle pipeline — that's all new code; (d) an Android-Studio-specific MCP isn't needed: the build pipeline is plain Gradle.

---

## 3. Developer pain points an MCP would solve

Grounded in verified doc claims and the local toolchain; practitioner-forum signals flagged where weaker.

1. **The entire first-party workflow is GUI-bound** (verified 3-0/2-1 across PICO doc pages): emulator creation via Device Manager clicks, deploy via the IDE Run button, adb via the PICO Developer Center GUI (which literally just prepends `adb` to typed text), XR input via keyboard focus on the emulator window. PICO documents *zero* programmatic interfaces — no CLI launch, no console, no gRPC, no Gradle task docs.
2. **No automated testing story.** PICO's docs offer no XR-input automation; the documented "default adb commands" are limited to Wi-Fi/audio/shutdown/reboot (verified 2-1). Scene-regression testing (boot → load scene → pose head → screenshot-diff) is impossible without the undocumented surfaces this research uncovered.
3. **Slow manual iteration loop.** Scene change → GUI editor → IDE build → manual emulator interaction → visual check. Meta ships hot-reload and documented headless Gradle tasks for the equivalent loop (verified 3-0); PICO does not — the gap is the MCP's opportunity.
4. **Preview-grade churn.** Toolchain 0.13.x-preview, emulator builds versioned per-toolchain (0.13.1) alongside a separate 0.8.3-beta channel; plugin DSL changed between 0.12.0 and 0.13.1 (multi-bundle DSL added). Devs must keep versions consistent (the plugin hard-errors on mixed versions) — an MCP `validate_toolchain` preflight removes a whole error class.
5. **Opaque failures.** Bundle pack errors surface as Gradle failures with internal result codes (10001–10007); the legacy pipe protocol is undocumented. An MCP that parses `spatialbundle` progress lines (regex `.*\s+(\d+)%:\s*(.*)` — the plugin's own parser) and result codes gives agents and humans legible diagnostics.
6. *(Weaker, forum-sourced, unverified):* PICO/XR practitioners report generic headset-dev friction — device-only debugging, broken preview loops (Unreal forums; PICO-Unity SDK issue #27). Directionally consistent with the above but not independently verified.

---

## 4. Phased scope

### Phase 1 — achievable now (all surfaces proven present; ~zero technical risk)

*Fork base: mobile-mcp (Apache-2.0) for the adb layer; new code for the PICO-specific tools.*

| Tool | Implementation |
|---|---|
| `validate_toolchain` | Replicate plugin resolution: DSL → `local.properties[spatial.tools.dir]` → `$PICO_HOME`; check `<root>/<ver>/editor/spatialbundle` executable + version files; check license-acceptance markers |
| `emulator_boot` / `emulator_kill` / `emulator_list` | `emulator -avd PICO_0.13 [-no-window] -gpu angle_indirect -grpc-use-token`, `ANDROID_AVD_HOME=~/.pico/avd`; kill via console or SIGTERM; `qsn` for snapshot listing |
| `apk_install` / `app_launch` / `screencap` / `logcat` / `ui_input` / `shell` | Plain adb against `emulator-5554` (mobile-mcp's existing layer) |
| `pack_bundle` | `spatialbundle pack -s <scenes> -o <out>.bundle --formats usda --override-output [...]`; stream progress lines |
| `inspect_bundle` | `spatialbundle info --input <f> --details` + unzip `BundleInfo.json` |
| `gradle_build` / `gradle_pack` | `./gradlew :app:assembleDebug` / `:m:spatial_pack_task`; verify `assets/*.bundle` in APK |
| `author_scene` / `validate_scene` | Read/write plain USDA against the shipped PICO `schema.usda` grammars; validate by compiling |
| `configure_spatial` | Edit `spatial { ... }` DSL + `local.properties` |

### Phase 2 — high confidence, needs one live verification spike (days, not weeks)

The protos ship in the SDK; the server is proven to start. Unverified only because the emulator wasn't booted during static inspection.

- **gRPC control plane:** codegen from `lib/*.proto`; token from the `pico_running` discovery dir; `getScreenshot`/`streamScreenshot`, `streamLogcat`, `sendKey`/`sendTouch`, `setSensor`/`setPhysicalModel`, GPS, SnapshotService save/load (deterministic test fixtures!).
- **XR head-pose driving:** `streamInputEvent` with `xr_head_rotation/movement/velocity/angular_velocity`; `xr_command RECENTER`; `setXrOptions` (passthrough, environment). **Spike:** boot, inject a head rotation, confirm via screenshot diff that SpaceOS honors it.
- **Controller driving (button/joystick level):** synthesize mapped keys from `controller_settings.ini` via gRPC `sendKey`; optionally rewrite the ini for canonical bindings; `xr_hand_event`/`xr_eye_event` pointer injection (guest honoring unverified — same spike).
- **Console extras:** `sensor set`, `rotate`, `screenrecord`, `automation record/play` macros.
- **Editor headless project builds:** `ide_build.sh --ide_noGraphics` for full `.spatialproject` builds (result-code vocabulary partially unknown); `ScenePreview.apk` deploy path.

### Phase 3 — research bets (no exposed API; genuine R&D)

- **Per-controller 6DOF pose injection** — no proto field exists. Avenues: guest-side prop/service hooks consumed by `XrDeviceModel` (strings hint at input modes), or BLE controller emulation via `netsimd` packet-streamer. Uncertain payoff.
- **Deterministic hand-gesture replay** — feed the MediaPipe pipeline a synthetic camera via `aemu-camera-mac-server --socket` instead of a live webcam. Plausible, unproven.
- **CI farm story** — `qemu-system-aarch64-headless` exists, but PICO licensing forbids mirroring the emulator into CI images (see §5); CI must install via official channels per-runner.
- **Hot-reload of bundles into a running app** — push bundle + app-side reload hook; depends on app architecture, not the MCP alone.

---

## 5. Licensing constraints on the MCP project itself

- **PICO toolchain:** proprietary — "Copyright © PICO Immersive Pte. Ltd. … All rights reserved", **NDA-gated** ("confidential and only available for and licensed to developers having entered into Mutual Non-Disclosure Agreement"), incorporating the [PICO SDK License Terms](https://developer.picoxr.com/document/distribute/sdk-license-terms/) by reference (URL not vetted on-disk — **must be reviewed before publishing**). Verified byte-identical across `package.xml`, the Gradle JAR's `META-INF/LICENSE.txt`, and AARs.
  - ✅ An MCP that **discovers and invokes the user's own installed binaries** contradicts nothing found on disk; shipping gRPC stubs generated at runtime from the *user's* protos is the cleanest pattern.
  - ❌ Never bundle, mirror, re-host, or auto-download-redistribute any PICO bits.
  - ⚠️ Honest flag: the toolchain is labeled *confidential*. A public MCP necessarily documents binary names, task names, and proto surfaces. These ship to every licensee via a public Android Studio plugin, which argues against trade-secret status, but the NDA scope question is real — review the SDK License Terms URL and, ideally, get clarity from PICO before publishing.
- **Google bits** (platform-tools, system image base): Android SDK ToS §3.4 forbids copying/redistribution — same wrap-don't-ship rule.
- **GPL/LGPL components** (QEMU, ffmpeg, Qt — per the 54-component `NOTICE.csv`): irrelevant for local invocation; relevant only if anyone ever mirrors the emulator.
- **Fork base:** mobile-mcp Apache-2.0 — fork + public derivative is explicitly permitted (retain NOTICE/attribution).

---

## 6. Key uncertainties (honest list)

1. **Does the SpaceOS guest honor the `xr_*` gRPC events?** ~~Unverified~~ **RESOLVED 2026-06-11 — NO, and the gate is now located.** Rigorous testing (`test/xr-gate-probe.mjs`, real RGBA pixel-diffs against a noise floor, plus live `streamScreenshot` before/after a large sustained yaw): the rendered view is **byte-identical** after `xr_head_rotation`, `xr_head_movement`, `setPhysicalModel ROTATION`, and `rotateVirtualSceneCamera`. Two compounding architectural reasons:
   - **(a) The gate is the GUI's WASD camera mode.** The head/camera is driven by `external/qemu/android/android-emu/android/virtualscene/WASDInputHandler.cpp` ("Entering camera mode", "Control view with mouse + WASDQE"). It is entered by mouse-interacting with the emulator window (`[KeyboardMode] InputMode -> CameraControlMode`). The gRPC proto exposes **no** input-mode / viewport-control / tracking-mode RPC, there is **no keyboard shortcut** in the hotkey table for it, and no console command — so `xr_head_*` events reach `XrInputEventSender` but are not applied. Programmatic head-pose driving is therefore **not achievable through the exposed gRPC/console surface** on 0.13.1; the only known path is host-level GUI automation of the emulator window (out of scope, fragile, non-headless).
   - **(b) Screenshots don't capture immersive 3D anyway.** There is a single display 0 (2160×2158). Both adb `screencap` and gRPC screenshots capture display 0 = the home environment + 2D app panels. Immersive 3D spatial content (a spatial app's `type=stage` volume, rendered host-side via gfxstream and shown in the emulator GUI window) is **not** in the captured framebuffer — confirmed by previewing a known-good scene whose 5 MB skybox sphere should have enveloped the view but didn't appear, while `SpatialRuntimeService` logs showed the app focused and actively rendering.
   - **Bonus bug found & fixed:** the unary `getScreenshot` RPC returns a **cached** frame (byte-identical across calls and across a HOME press); only `streamScreenshot` is live. The MCP's `xr_screenshot` now streams one frame and raises the gRPC receive limit (a 2160px screenshot exceeds the 4 MB default).
   - **Consequence for the MCP:** spatial-content verification is via `inspect_bundle` / `verify_scene` (geometry/material counts) + spatial-runtime logcat, **not** 3D screenshots. `xr_input_status` documents this to agents at runtime.
2. ~~gRPC token handshake details~~ **RESOLVED:** while running, `~/Library/Caches/TemporaryItems/avd/pico_running/pid_<PID>.ini` contains `grpc.port`, `grpc.token` (Bearer auth works), `grpc.allowlist`, `grpc.jwks`, adb/console ports, and the full QEMU cmdline — token auth is on by default even without `-grpc-use-token`.
3. Whether `spatialbundle pack` alone is runtime-complete for scenes using PICO custom components/timelines, vs. the editor's `--ide_noGraphics` path doing extra steps (shared libraries suggest parity).
4. ~~`--compress-textures` marked `[required]`~~ **RESOLVED 2026-06-11:** `spatialbundle pack` succeeds without it (live run against the claimsight scenes) — the `[required]` marking is a help-text bug.
5. The PICO SDK License Terms URL content and the user's actual NDA scope (blocking question for *publishing*, not for building).
6. Two emulator version channels (0.8.3-beta standalone vs 0.13.x toolchain-versioned) — which channel PICO consolidates on affects maintenance burden.
7. Headless (`-no-window`) mode: gRPC/XR surface is present in the headless binary, but whether keyboard-mapped controller input works without a Qt window needs the same live spike.

---

## Appendix — implementation findings (v0.2 / v0.3, verified live 2026-06-11)

Discovered while building and testing the server against the running emulator:

1. **Headless editor build works** (`build_spatial_project`). `Spatial Editor --project=<f>.spatialproject --ide_noGraphics --ide_buildOutputDir=... --ide_resultCodeFile=...` builds a bundle with no GUI; result code `0`/`10000` = success, written as JSON `{"data":{"code":...}}`. Respects the editor's lock file (`<proj>/.CacheData/lock` holds a live PID). Verified producing `AgentDemo.bundle`.
2. **ScenePreview on-device protocol reverse-engineered** (`preview_scene`). The editor's actual "preview on device" path is: install `ScenePreview.apk`, push the bundle to `/storage/emulated/0/Android/data/com.pico.spatial.editor.scenepreview/files/`, launch `.platform.LaunchActivity` with extras `--es sceneName <stem> --es previewConfig {} --ef cameraHeightOffset 0`, then signal load via **broadcast** `com.pico.spatial.editor.scenepreview.FILE_TRANSFER_COMPLETE` carrying `--es filePath <remote> --es sceneName <stem>`. Confirmed by recovering the command templates from the editor binary and the activity's `getStringExtra` calls from the ScenePreview dex; the app logs `Broadcast parsed values - filePath: ... sceneName: ...` and loads without a `LoadFromStorage` error. (Caveat: a scene of *primitive* USD shapes did not visibly render in the preview's default camera framing — mesh-based scenes from the editor are the normal input; this is a scene-content/camera matter, not a protocol one.)
3. **`spatialbundle pack` succeeds without `--compress-textures`** despite the `[required]` help text (confirmed: help-text bug).
4. **`.spatialproject` is a 2-line JSON** (`{"projectName","version"}`); the project dir also needs `Sources/Scenes/`, `Sources/Assets/`, `.Component/component.json`. The editor's new-scene template is an 11-line empty-Root USDA. `create_scene_project` reproduces this.
5. **Controller key map** is ASCII-coded in `controller_settings.ini` (Q=81, Space=32, …); `input keyevent` needs `KEYCODE_*`. `controller_press`/`controller_map` translate. No 6DOF controller-pose path exists (consistent with §1.1).
6. **gRPC `getStatus` exposes full VM/guest config** (CPU/RAM/hypervisor, API level) — a cheap health/identity probe used by `xr_grpc_status`.

## Sources

**Local artifacts (primary, this machine):** `~/Library/PICO/sdk/0.13/{emulator,editor}` (binaries, protos, `NOTICE.csv`, `package.xml`, `ide_build.sh`, `spatialbundle --help` output); `~/.gradle/caches/.../com.pico.spatial.tools.gradle.plugin-0.13.1.jar` (decompiled); `~/Library/Application Support/Google/AndroidStudio2025.1.4/plugins/SpatialPlugin/`; `~/.pico/avd/PICO_0.13.avd/{config.ini,controller_settings.ini,emu-launch-params.txt}`; `/tmp/android-sushantsrikrish/qemu-log/*.log`; `~/AndroidStudioProjects/claimsight` (working end-to-end example).

**Web (adversarially verified):** [developer.picoxr.com — Manage PICO Emulator](https://developer.picoxr.com/document/spatial-toolkit/manage-pico-emulator/) · [PICO Emulator (Unity)](https://developer.picoxr.com/document/unity/pico-emulator/) · [PDC adb commands](https://developer.picoxr.com/document/unity/create-and-debug-adb-commands/) · [PICO OS 6 portal](https://developer-cn.picoxr.com/en/pico-os-6/) (download URLs) · [Android Emulator console](https://developer.android.com/studio/run/emulator-console) · [AOSP emu gRPC docs + aemu-grpc](https://android.googlesource.com/platform/external/qemu/+/emu-master-dev/android/android-grpc/python/aemu-grpc) · [android-emulator crate](https://lib.rs/crates/android-emulator) · [Meta Spatial Editor + SDK](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-editor-using-with-sdk/) · GitHub API license records (2026-06-11) for the prior-art table.
