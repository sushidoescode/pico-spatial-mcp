# pico-spatial-mcp

An MCP server that lets AI agents drive **PICO XR spatial development** end-to-end: author USDA scenes as text, compile them with the `spatialbundle`/Gradle pipeline, build & deploy APKs, drive the PICO OS6 Emulator (lifecycle, adb, snapshots), preview scenes via the editor's ScenePreview app, and observe/verify with screenshots, UI dumps, log-waits, and crash detection — plus an experimental gRPC XR layer (head pose, recenter, passthrough). Background research: [FINDINGS.md](FINDINGS.md).

**v5.0 — the brief-to-app compiler — 115 tools, 3 prompts.** A PLAN → COMPILE → VERIFY-AGAINST-PLAN tier above the v4 execution spine. A natural-language brief becomes a typed **`AppSpec` IR** (a zod schema that is simultaneously the build plan AND the verification contract — every node carries its own acceptance predicate, its C1–C4 capability class, and a required forward-FOV camera pose). Thin new tools drive it: **`list_capabilities`** (the machine-readable menu the planner plans against), **`plan_app_spec`** (validate + feasibility-lint + stamp each node's C-class + honest emulator-vs-Swan preview), **`compile_app_spec`** (emit an executable *BuildLedger* mapping each spec node to the exact existing `generate_*`/scaffold/bake/build call + target file), **`verify_app_spec`** (the plan-level gate — never auto-passes a visual claim; **rejects any `vision_verified` submitted without a linked capture**, so over-claims are structurally impossible), and **`replan_spec`** (symptom-driven spec mutation). A new **`brief_to_app`** prompt wraps (does not replace) `autonomous_spatial_build` as the per-node executor. Underneath, three new compile-verified Kotlin primitives it needs: **`generate_layout_kotlin`** (analytical wall/grid/arc/shelf placement), **`generate_interaction_kotlin`** (raycast + broadcast select/hover + selection state + highlight), and **`generate_data_binding_kotlin`** (bundled JSON → N tinted-quad cards; the SDK has no `TextComponent`, so dynamic labels are a bake-time concern). All three `BUILD SUCCESSFUL` against SDK 0.13.3.

**v4.7 — interactive in-world menus you can drive with a Mac mouse — 106 tools, 2 prompts.** `generate_game_menu_kotlin` (v4.6) emits a real **in-world game menu** (START/PAUSE/RESUME/RESET or custom buttons) with an AAA 3D feel — a lit beveled backing slab, a point light, a gentle idle-bob float, and a highlight + cursor that snap to each button via per-button panel-local Y computed *analytically* from the texture rows. One `select(action)` entry point is driven by a `DEBUG_CMD` broadcast on the emulator and by gaze/controller (and optional hand-tracking pinch) on a headset. **Vision-verified across all 4 demo apps** (orrery / gravity / showroom / portal). Because the emulator has no controller or gaze pointer (C3), **`setup_mouse_bridge`** closes the loop: a host-side Quartz event tap maps the real Mac mouse over the emulator window into the framebuffer, detects which menu row it is over (scene-color robust — it finds the blue panel bbox first, then the button bars inside it), and on a **left-click** broadcasts the select — **verified end-to-end** (a real click on PAUSE moved the in-world highlight to PAUSE).

**v4.5 — the full SDK content ladder — 104 tools, 2 prompts.** Building on v4.0's autonomous loop, the v4.1→v4.9 arc closes the gap between what the Spatial Editor *understands* and what the MCP can *author*: surface-grounded placement (`generate_home_env_proxy` + `calibrate_home_env` — the honest, vision-calibrated "measure the room" since the home bedroom is a Unity black box), a **full lighting rig** (`generate_full_lighting_rig_kotlin` + `generate_ibl_kotlin` — directional/point/spot/ground-shadow + `.ktx` IBL), **particles + video** (`generate_particle_kotlin`, `generate_video_player_kotlin`), **programmatic animation** (`generate_tween_animation_kotlin` — **vision-verified: a generated tween bobs an orb across captures** — + `generate_orbit_animation_kotlin`), **display control + portals** (`generate_display_controllers_kotlin` opacity/billboard/draw-order, `generate_portal_kotlin` nested worlds), and **rigid-body physics + anchors** (`generate_rigidbody_kotlin`, `generate_anchor_kotlin`). Every codegen tool is **compile-verified against the real SDK 0.13.3** (`:app:compileDebugKotlin` BUILD SUCCESSFUL), with each tool's honest vision/structural/asset-gated/headset-only verifiability baked into its description. Constructors were extracted by reading the SDK sources directly (e.g. `ParticleComponent` has no public ctor → the tool drives an editor-authored asset; `StageEnvironmentLightingComponent` is inactive in MIXED stage).

**v4.0 — the autonomous spatial studio — 92 tools, 2 prompts.** An agent takes a product brief and **autonomously authors + bakes + deploys + VERIFIES** a native PICO XR app entirely on the emulator (no headset), gating every "done" behind the **`verify` gate** — structural `assert_scene` + a frame the agent actually **looked at** (the ground-truth rule: compiling, `smoke 0`, and logcat markers prove *existence*, never *appearance*). On top of v3.0's author/build/observe loop, v3.1→v4.0 added: **editor-grade authoring** (`author_materialx`, `author_editor_component`, `editor_export_bundle` with cooked physics, `generate_lighting_kotlin`, `generate_mr_app`); an **injectable headless control + verification plugin** (`generate_agent_bridge` — manifest-merged auto-init + an `AGENT_CMD` channel + a live scene-graph `dump_scene`); **real visual verification** (`capture_frame` + `emulator_look` camera control via CGEvent drag + `verify_visual` whole-scene sweep + `verify_baseline` deterministic regression + the **vision-gated `capability_report` auto-emitted by the build loop**); **editor X-ray + headless automation** (`decode_editor_project`/`decode_editor_settings`/`editor_op` file-levers/`editor_project_diff`/`bundle_content_diff`); **richness codegen** (spatial audio / animation / persistent anchors); and a **PICO Swan headset-readiness layer** (`generate_scene_understanding_kotlin`, `generate_headset_readiness_codegen`, `swan_bring_up_checklist`, `deploy_to_device`) that compiles + no-ops on the emulator and activates on hardware. The four proven emulator ceilings (C1–C4) and an explicit **verified-on-emulator vs built-for-headset** split are first-class. Model-agnostic ([docs/local-models.md](docs/local-models.md)).

Two built-in prompts: `pico_spatial_dev_loop` (the dev workflow) and **`autonomous_spatial_build`** (v4.0: brief → scaffold → author env/materials/lighting/colliders/UI/richness + inject the Agent Bridge → `editor_export_bundle` bake → build & run (auto capability matrix) → **the `verify` gate (structural + a frame you LOOK at)** → `diagnose` → iterate → ship with the headset-readiness layer + Swan bring-up checklist + the honest verified-vs-built report). The agent reference lives in [SKILLS.md](SKILLS.md), [DESIGN.md](DESIGN.md) (correctness rules incl. §9 runtime physics, §10 PICO math API, §11 editor MaterialX, §12 the visual-ground-truth rule), [ROADMAP.md](ROADMAP.md), and [ROADMAP_v3.1-v4.0.md](ROADMAP_v3.1-v4.0.md) (§7 the v3.5→v4.0 ladder).

**Proven brief-general — the v4.0 acceptance demo (vision-verified):** the loop was run unattended on a **fresh brief**, *GalleryXR* (distinct from the ClaimSight inspection app) — `scaffold_spatial_app` → author 3 glowing cyan orbs in a forward arc + `generate_lighting_kotlin` + injected `generate_agent_bridge` → `build_and_run` (rendered, auto capability matrix) → the free camera was decoupled and looking away (C2), so `emulator_look` aimed it and `capture_frame` confirmed **the three cyan orbs rendering over the bed in the home environment** (looked at, not asserted) → the Agent Bridge confirmed structurally (`placed pin #1/2/3` at `-Z`, `bridge_ready`) → ship with `swan_bring_up_checklist` + an honest `capability_report` (3 vision-verified / 2 structural / 2 built-for-headset). The self-correcting loop also caught + fixed real generator bugs mid-build across the session. Worked example: [docs/claimsight-native.md](docs/claimsight-native.md).

### Start any new spatial project: `scaffold_spatial_app`

The general "build any project" entry point. One call clones a known-good template app, renames the package across all sources + the Java dir tree, sets the app name/stage, points `local.properties` at the resolved toolchain, and (optionally) installs a scene — producing a **fresh, immediately-buildable native spatial app**. Then author `HomeStage.kt` + a scene and `build_and_run`. Verified: scaffold → build → install → launch end-to-end for a brand-new package.

### Use with a local open-weight model

MCP is model-agnostic and this server has no cloud dependency of its own — a local model (LM Studio, llama.cpp, or Ollama via a bridge) on capable hardware can drive it. The high-level orchestration tools (`scaffold_spatial_app`, `build_and_run`, `compose_inspection_scene`, `iterate_scene`) collapse long tool chains into single calls, which is what makes a ~30B local model reliable here. Full guidance: [docs/local-models.md](docs/local-models.md).

### Shipping a real APK (god-level build experience)

The MCP builds, installs, and runs **real native spatial-app APKs**, not just scene previews. `build_and_run` auto-detects a JDK (Android Studio's bundled JBR — no `java` on PATH needed), builds via Gradle, installs, clean-relaunches, and **verifies a frame actually rendered** (`FirstFrameRelease`) before screenshotting. A worked end-to-end example — turning ClaimSight into a native Full-immersion APK — is in [docs/claimsight-native.md](docs/claimsight-native.md). The decompiled SDK interaction API (controller ray, raycast, transforms, anchors) for building interactive apps is in [docs/spatial-interaction-api.md](docs/spatial-interaction-api.md).

### Building a real app: ClaimSight inspection scenes + world-model environments

`compose_inspection_scene` assembles a legit insurance-inspection spatial app — a damaged-room environment (procedural, or a referenced GLB/splat room from a world model) and **"saturn" damage markers that stick to ANY surface** (floor/wall/ceiling, oriented so local +Y aligns to the surface normal — the ClaimSight stick-to-surface behavior), severity-colored using the canonical 5-tier palette (green→purple) and real damage taxonomy (water/electrical/structural/wind/hail/mold/…). Environments can come from **World Labs Marble** (text/photo→3D world; free tier 4 gens/mo, GLB/PLY export needs a paid plan) or a free Scaniverse/Polycam scan — `import_environment` brings the GLB/skybox in, `worldmodel_guide` documents the full workflow.

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

### v3.0 — build & verify (the autonomous spatial studio)

| Tool | What it does |
|---|---|
| `scaffold_spatial_app` | Clone a known-good template app into a **fresh, immediately-buildable** native spatial app (renames package + Java tree, sets name/stage, points `local.properties` at the toolchain) |
| `compose_inspection_scene` / `import_environment` / `worldmodel_guide` | Inspection-app scene builder (surface-stick markers, skybox-override environments) + world-model import + a generation guide |
| `prepare_environment` / `list_environment_assets` | Auto-detect & stage environment assets (pano→skybox, textured-vs-collider GLB, splat) and emit the recommended compose call |
| `generate_spatial_ui` | Emit **verified, compilable** Jetpack-Compose spatial panels (card/menu/list; ≥800 dp, 18–40 sp, real `Modifier.clickable`, hex colors) |
| `generate_collider_kotlin` | Emit the **verified runtime-collider** recipe (`PhysicsWorldComponent` + primitive box room) so `Scene.rayCast` lands pins on walls/floor/ceiling (USD/mesh colliders never register on-device) |
| `bake_textured_model` | Bake a textured GLB/USD model into a renderable `.bundle` via `spatialbundle` (PHYSICALLY_BASED material + ASTC texture) — the way to import a textured world that actually renders |
| `generate_environment_kotlin` | Emit drop-in Kotlin to load a rich 3D environment — a baked textured mesh or a native Gaussian splat (`.spz`/`.ply`) |
| `decode_spatial_bundle` | Decode the editor's baked `.bundle` (asset-type histogram + collision/physics/scene assets) — the agent's window into editor output without the GUI |
| `app_broadcast` | Send an Android broadcast Intent — a **headless command channel** into an app's `BroadcastReceiver` (drives in-app actions past the GUI-gated controller trigger) |
| `assert_logcat` | **Verification primitive:** wait for a logcat line matching a pattern → `{matched,line,elapsedSec}`, turning `Log.*` markers into machine-checkable pass/fail |
| `gui_capture` / `gui_camera` / `gui_find_window` / `gui_permissions` | Host-GUI capture of the **real immersive 3D view** (`screencapture` of the qemu window), WASD/arrow camera driving, window enumeration, permission check (**macOS host**) |
| `diagnose` | Self-diagnosis KB: symptom (white/black/invisible geometry, `texture_black`, `raycast_no_hit`, `emulator_camera_drift`, dead buttons, …) → verified root cause + fix + the DESIGN.md rule |
| `design_review` | Capture the live 3D view + cheap pixel heuristics + a DESIGN.md rubric for the vision-capable agent to judge (**macOS host**) |
| `run_visual_regression` | Scripted capture + perceptual diff vs. baselines (**macOS host**) |

> **Tool count:** 104 distinct tools (the v4.1→v4.9 additions — `generate_home_env_proxy`, `calibrate_home_env`, `generate_full_lighting_rig_kotlin`, `generate_ibl_kotlin`, `generate_particle_kotlin`, `generate_video_player_kotlin`, `generate_tween_animation_kotlin`, `generate_orbit_animation_kotlin`, `generate_display_controllers_kotlin`, `generate_portal_kotlin`, `generate_rigidbody_kotlin`, `generate_anchor_kotlin` — are catalogued in [ROADMAP_v3.1-v4.0.md](ROADMAP_v3.1-v4.0.md) §8). Earlier counting note: 95 `registerTool` call sites — `gui_capture` / `design_review` / `run_visual_regression` each have a non-macOS stub registration that is mutually exclusive with their real macOS implementation). The v3.1→v4.0 additions (editor authoring/automation, the Agent Bridge plugin, the visual-verification suite, richness codegen, the Swan-readiness layer) are catalogued in [ROADMAP_v3.1-v4.0.md](ROADMAP_v3.1-v4.0.md) §7.

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
