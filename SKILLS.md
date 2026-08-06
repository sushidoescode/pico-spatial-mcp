# SKILLS.md — what an agent can build with pico-spatial-mcp, and how

This is the operating manual for an AI agent driving `pico-spatial-mcp`. It pairs with
[DESIGN.md](DESIGN.md) (how to make it look right) and the built-in `pico_spatial_dev_loop`
prompt. The goal: take a spec from nothing to a **polished, running, native PICO spatial
APK**, and — critically — **detect what's wrong and iterate to fix it** without a human.
Apps are **MR-first**: the default stage is Mixed (`1`) — the passthrough home environment
is the environment and content seats ON the real room; Full Space (`3`) is the explicit,
fully-supported opt-in for fully-virtual scenes.

See **ROADMAP.md** in the git repository for where this is going — every line gate-labeled honestly.
For the ABI, ownership, threading, model-loading, emulator/device, and pico-cli conclusions this
repository can ground today, see **[docs/ANSWERED_BY_MEASUREMENT.md](docs/ANSWERED_BY_MEASUREMENT.md)**.

## The capability map (a core sampler of the full surface: 240 tools on macOS, 237 on other hosts)

| Goal | Tools |
|---|---|
| Preflight the environment | `validate_toolchain` (tools root, JDK, AVD, license, protos) |
| Start a new app | `scaffold_spatial_app` (clone template → rename pkg → buildable) |
| Author a scene | `compose_scene`, `compose_inspection_scene`, `add_entity`, `import_asset`, `import_environment`, `scene_schemas` |
| Compile / verify a scene | `pack_bundle`, `inspect_bundle`, `verify_scene`, `build_spatial_project` |
| Build / run / verify an APK | `build_and_run` (build→install→relaunch→render-check→shot), `gradle_build` |
| Drive the emulator | `emulator_boot/kill/list/status/console`, `snapshot_*` |
| Observe & control | `screencap`, `logcat`, `ui_dump`, `ui_input`, `adb_shell`, `wait_for_log`, `check_crash`, `screenrecord` |
| Capture the host GUI window (macOS — XR-runtime immersive apps, editor GUI) | `gui_capture`, `gui_find_window`, `gui_camera`, `gui_permissions` |
| XR input | `xr_*` (gated — read `xr_input_status` first), `controller_map/press` |
| World-model environments | `worldmodel_guide`, `import_environment` |
| Query broad installed PICO context | `knowledge_api` (full surface); use `vault_api` for exact SDK declarations |

## Persistent spatial-knowledge actions

`knowledge_api` is a flattened action API over one lazy, persistent
`pico-cli mcp spatial-knowledge` process. Persistence matters: `switch_workspace` affects later
calls in the same server session. The adapter bounds startup/calls, resets after protocol failures,
and returns `status: "unavailable"` when pico-cli, transport, or graph data is absent. A valid MCP
tool-level `isError` result normally returns `status: "error"`; the explicit missing-graph form is
`unavailable`. Neither application-level result discards the persistent session or the workspace
selected by an earlier `switch_workspace` call.

| Action | Fields |
|---|---|
| `query_graph` | `question`; optional `mode`, `depth`, `token_budget`, `max_degree`, `query_variants`, `sort_by` |
| `get_node` | `label` |
| `get_neighbors` | `label`; optional `relation_filter` |
| `get_community` | nonnegative integer `community_id` |
| `god_nodes` | optional positive integer `top_n` (default 10) |
| `graph_stats` | no fields beyond `action` |
| `shortest_path` | `source`, `target`; optional positive integer `max_hops` (default 8) |
| `switch_workspace` | `workspace` |

The graph is broad contextual evidence, not an exact symbol oracle. Use `vault_api` for authoritative
SDK signatures and file/line citations. `preflight_lint(..., knowledgeSecondOpinion: "...")` opts
into `query_graph` only; its separate advisory block never changes lint `clean`.

## The build loop

1. **`validate_toolchain`** — fix anything it flags (missing JDK → it auto-detects the
   Android Studio JBR; no AVD; license). Don't proceed with `problems` non-empty.
2. **`scaffold_spatial_app`** (new app) or open an existing project.
2b. **Decide the stage style** — it's architectural, not cosmetic. Mixed (`1`, the default):
   the real room is the backdrop, content seats on detected surfaces
   (`place_model_on_surface`), and there is no void to dress. Full (`3`, explicit opt-in):
   the app replaces the environment and owns the enclosure problem (DESIGN.md §6) — and
   carries the partner-stated Guardian-boundary caveat on hardware (per Matt/PICO, fix in
   progress; not measured by us).
3. **Author**: `compose_inspection_scene` / `compose_scene` into the editor-asset scene;
   `import_asset`/`import_environment` for meshes/rooms. Author the spatial UI in
   `HomeStage.kt` (Compose `AttachmentPanel`s; load the scene by model name).
4. **`verify_scene`** — geometry/material counts must match intent (e.g. `materialAssets`
   > 0 means real materials, not white `displayColor`).
5. **`build_and_run`** — read the result: `build/install/launch` ok, `rendered: true`,
   `crashes: []`. It returns a screenshot.
6. **`capture_frame`** — look at the real render and compare to intent. adb screencap is the
   shell composite: the ground truth for native Spatial SDK apps and panels. For XR-runtime
   immersive apps (Unity), use `gui_capture` instead — screencap is blind to XR-runtime output.
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
  room or skybox (DESIGN.md §6). Full-Space (`3`) opt-in only — cannot occur in Mixed
  (`1`), the default, where the passthrough room always encloses the user.
- **Black adb/gRPC screenshot** → depends on the app's mode (the v30.1 correction). For
  native Spatial SDK apps and panels, adb `capture_frame` IS the real render — a black frame
  there is a real defect. For XR-runtime immersive apps (Unity), adb screencap is structurally
  blind to the output — capture via `gui_capture`. See `xr_input_status`.

Treat each capture like a code review: name what's wrong, map it to a DESIGN.md
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
