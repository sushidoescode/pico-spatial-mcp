# SKILLS.md — what an agent can build with pico-spatial-mcp, and how

This is the operating manual for an AI agent driving `pico-spatial-mcp`. It pairs with
[DESIGN.md](DESIGN.md) (how to make it look right) and the built-in `pico_spatial_dev_loop`
prompt. The goal: take a spec from nothing to a **polished, running, native PICO spatial
APK**, and — critically — **detect what's wrong and iterate to fix it** without a human.

See **ROADMAP.md** in the git repository for the v1.4→v2.0 plan (written so a local model can execute it if the primary agent is rate-limited).

## The capability map (55 tools)

| Goal | Tools |
|---|---|
| Preflight the environment | `validate_toolchain` (tools root, JDK, AVD, license, protos) |
| Start a new app | `scaffold_spatial_app` (clone template → rename pkg → buildable) |
| Author a scene | `compose_scene`, `compose_inspection_scene`, `add_entity`, `import_asset`, `import_environment`, `scene_schemas` |
| Compile / verify a scene | `pack_bundle`, `inspect_bundle`, `verify_scene`, `build_spatial_project` |
| Build / run / verify an APK | `build_and_run` (build→install→relaunch→render-check→shot), `gradle_build` |
| Drive the emulator | `emulator_boot/kill/list/status/console`, `snapshot_*` |
| Observe & control | `screencap`, `logcat`, `ui_dump`, `ui_input`, `adb_shell`, `wait_for_log`, `check_crash`, `screenrecord` |
| See the REAL 3D view (macOS) | `gui_capture`, `gui_find_window`, `gui_camera`, `gui_permissions` |
| XR input | `xr_*` (gated — read `xr_input_status` first), `controller_map/press` |
| World-model environments | `worldmodel_guide`, `import_environment` |

## The build loop

1. **`validate_toolchain`** — fix anything it flags (missing JDK → it auto-detects the
   Android Studio JBR; no AVD; license). Don't proceed with `problems` non-empty.
2. **`scaffold_spatial_app`** (new app) or open an existing project.
3. **Author**: `compose_inspection_scene` / `compose_scene` into the editor-asset scene;
   `import_asset`/`import_environment` for meshes/rooms. Author the spatial UI in
   `HomeStage.kt` (Compose `AttachmentPanel`s; load the scene by model name).
4. **`verify_scene`** — geometry/material counts must match intent (e.g. `materialAssets`
   > 0 means real materials, not white `displayColor`).
5. **`build_and_run`** — read the result: `build/install/launch` ok, `rendered: true`,
   `crashes: []`. It returns a screenshot.
6. **`gui_capture`** (macOS) — look at the real 3D view; compare to intent.
7. Iterate.

## Self-diagnosis — the part that matters

The runtime fails silently, so VERIFY and READ FEEDBACK, never assume. A debugging
decision tree:

- **Build failed** → `build_and_run`/`gradle_build` return the Gradle tail. Kotlin
  errors point at the file:line. Missing-Java → JBR auto-detected; if still failing,
  `validate_toolchain` shows `javaHome`.
- **App launched but `rendered: false`** → it didn't draw a frame. Check `check_crash`
  and `logcat` (grep `AndroidRuntime`, `FATAL`, your package). Common: an exception in
  `HomeStage` (bundle/model name mismatch, SDK misuse).
- **Geometry is white** → `displayColor` instead of bound materials (DESIGN.md §1).
- **Geometry invisible** → off-camera, untextured collider, or no material; check the
  scene coordinates and `inspect_bundle` (is the mesh even there?).
- **Panels tiny / unreadable** → panel dp too small / too far (DESIGN.md §4).
- **Buttons don't respond** → static `Box`+`Text`; use `Modifier.clickable` (DESIGN.md §4).
- **Pins/objects appear randomly** → ungated trigger or auto-seed; gate on an armed mode
  (DESIGN.md §5).
- **User "falls out" into the system environment** → finite room; envelop with a large
  room or skybox (DESIGN.md §6).
- **Can't see immersive 3D in adb/gRPC screenshots** → expected; use `gui_capture`
  (only the GUI window has the host-composited 3D). See `xr_input_status`.

Treat each `gui_capture` like a code review: name what's wrong, map it to a DESIGN.md
rule, apply the fix, rebuild, re-capture. That loop is the whole point of the MCP.

## Hard constraints (do not violate)

- The PICO toolchain is **NDA/proprietary** — wrap the user's installed binaries, never
  bundle/redistribute PICO bits. (The MCP is built this way.)
- The emulator has **no passthrough cameras and no 6DOF controller pose** — design for a
  virtual environment + a button-driven interaction path; the controller-ray path is for
  real headsets.
- Model-agnostic: a local open-weight model can drive this (see `docs/local-models.md` in the git repository);
  prefer the high-level orchestration tools to keep chains short.

## Where these docs live

`SKILLS.md` (this file) and `DESIGN.md` ship with the package. The deeper references under
`docs/` (`spatial-interaction-api.md`, `claimsight-native.md`, `local-models.md`) live only in the
git repository — if you installed from a tarball you will not have them, and nothing here requires
them. Add
project-specific automation via Claude Code hooks in `.claude/settings.json` (e.g. run
`verify_scene` after editing a `.usda`, or `build_and_run` after editing Kotlin) — those
live with the consuming project, not here.
