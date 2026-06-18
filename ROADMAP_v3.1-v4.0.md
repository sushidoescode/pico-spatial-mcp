# ROADMAP v3.1 → v4.0 — The Autonomous Spatial Studio (Spatial Editor ⇄ Emulator)

> **Mission restated (2026-06-14, from the user):** make this MCP work *at the highest level* with the
> **PICO Spatial Editor** and the **PICO Emulator**, so an agent can author AND test — autonomously —
> everything the editor→emulator toolchain allows. There is **no PICO hardware** until the **PICO Swan**
> headset ships later this year (it runs **PICO OS6**, exactly what this emulator targets), so the
> emulator + editor *are* the entire test surface. This roadmap is about mastering that surface, being
> honest about its ceiling, and generating the headset-bound parts so they light up the day Swan arrives.

---

## 0. The honest emulator ceiling (empirically established, 2026-06-14)

These were each verified on `emulator-5554` this session — they are the constraints the roadmap is built around, not guesses:

| # | Limit | Evidence | Consequence |
|---|---|---|---|
| C1 | **No scene-understanding data.** `PlaneTrackingManager`/`MeshTrackingManager` start (`state=RUNNING`) but return **0 planes / 0 mesh**; no room-data loader in the emulator. | `PROBE PLANES: 0`, `PROBE MESH: 0` | Pins **cannot snap to real surfaces** on the emulator. The native equivalent of WebXR hit-test (`sense/plane`) is **headset-only**. Box colliders are a stand-in that aligns to nothing visible → floating pins. |
| C2 | **Capture camera is decoupled + uncontrollable.** `screencapture` of the qemu window grabs a free/debug camera that is *not* the HMD-rendered view, and there's no headless way to drive it (no Quartz/cliclick; arrow/WASD keys need a mouse-drag to enter camera mode). | Pins placed dead-ahead of the HMD gaze (`z=+1.5`) were absent from the capture | **Headless visual verification is unreliable.** A human navigating the emulator *can* see the content (the user's own screenshots prove it); an agent generally cannot capture it on demand. This is why all prior "verified" claims were logcat-level. |
| C3 | **No controller pointer / gated trigger.** No 6DOF controller pose; `RC_Trigger` is GUI-gated; the host mouse is camera control, not a UI pointer. | `no_controller_pose` diag; `menufire` synthetic hooks were needed | **Panel interactivity cannot be verified** on the emulator. "Clicking a button" is headset-only. |
| C4 | **Stage-vs-window dichotomy.** An immersive Stage gets 3D + tracking but Compose `WindowContainer`s spawn off the default view and `AttachmentPanel`s are crash-prone; a Window app gets in-front Compose but no 3D/tracking. | DESIGN.md §6b / ROADMAP §6.1 | No native config gives **room + spatial pins + in-front interactive panels together** the way WebXR-in-browser does. |

**Why WebXR looks better in the same emulator:** it runs in the PICO **Browser**, whose WebXR layer *simulates* MR — hit-test against a virtual room **and** mouse-as-controller. The native SDK's emulator provides **neither**. That is a platform gap, not an effort gap.

**Strategic consequence:** stop trying to make the native *emulator* deliver the full MR UX. Instead, (a) maximize what the emulator **can** show (home-env backdrop, geometry, materials, physics-rayCast, audio graph, animation), (b) make the **Spatial Editor** the agent's authoring superpower (it can do what USDA-text and the runtime can't), (c) **code-generate + statically verify** the headset-only parts (sense/plane pins, controller interaction) so they ship pre-built for Swan, and (d) be **honest in every report** about what was verified vs. only built.

---

## 1. North Star (v4.0)

> An agent takes a product brief and **autonomously drives the Spatial Editor and the Emulator end to
> end**: authors a scene + components (physics, anchors, audio, timeline) + materials in the editor
> (headless where possible, GUI-driven where required), bakes it, deploys to the emulator, verifies
> **everything the emulator allows**, self-diagnoses, iterates — and emits a truthful build report with
> an explicit *verified-on-emulator* vs *built-for-headset* split.

The current MCP (v3.0) can scaffold, bake textured models, generate collider/UI/env Kotlin, drive
broadcasts, and assert logcat. It does **not** yet (a) understand or drive the **editor's** component /
material / physics / timeline authoring, (b) verify visuals deterministically, or (c) separate
verified-vs-built. Those three gaps are the spine of v3.1 → v4.0.

---

## 2. The Spatial Editor surface to master (what's actually there)

Installed at `~/Library/PICO/sdk/0.13/editor/`:
- **`Spatial Editor.app`** — Qt/QML GUI + a spatial engine (`spaital_engine_*.log`, `saved/config`), with a **headless build** mode (already used by `build_spatial_project`, `--ide_noGraphics`).
- **`spatialbundle`** CLI — `pack` (USD/GLTF → `.bundle`) + `info`. The only fully-CLI surface today.
- **Component / Timeline / Audio plugins** — `spatialComponent.dylib`, `spatialTimeline.dylib`, `spatialAudio.dylib` (the editor's authoring engines for components, keyframe timelines, spatial audio).
- **MaterialX** (`libMaterialX*.dylib`) — the PBR/material pipeline, incl. the `ND__unlit_surfaceshader` nodedef and the editor-authored-material path that is the **only** reliable textured-mesh route.
- The editor's baked artifacts an agent must read: `SpatialPackContent/.Library`, `.Component`, `.CacheData` (physics/collision cook), `Sources/Scenes/*.usda`, `Sources/Assets/*`.

**The thesis:** the editor can author things the runtime can't (cooked physics, editor-materials that actually render textures, timelines, audio sources, IBL/lighting). An agent that can *drive the editor* and *decode its output* unlocks the high-quality content the runtime-only path can't reach.

---

## 3. Phases

### v3.1 — Read & author the editor's output (foundation)
Goal: the agent fully **understands** an editor project and can **author editor-grade content headlessly** (no GUI driving yet).
- **`decode_editor_project`** — parse a whole `SpatialPackContent` tree (not just the compiled bundle): enumerate scenes, the `.Library`/`.Component`/`.CacheData` entries, components per prim (Collision, Anchor, Audio, Timeline, Model), materials, and assets — the agent's X-ray of the editor's GUI state. (Extends `decode_spatial_bundle`.)
- **`author_editor_component`** — emit the exact editor USD/`.Component` format for Collision / Anchor / Audio / Timeline components onto a prim (the formats are partially known — DESIGN.md collision block). Round-trip-verified against `decode_editor_project` + a `spatialbundle pack`.
- **`author_materialx`** — generate MaterialX materials (PBR + the `ND__unlit_surfaceshader` UNLIT path + texture-node overrides) so textured meshes render *bright and correct* without the runtime hacks. This directly fixes the "baked mesh is dim" gotcha.
- **`generate_scene_understanding_kotlin`** — emit the `sense/plane` + `sense/mesh` + `AnchorComponent` pin-snapping code (the *correct*, WebXR-equivalent surface-pin path). **Built now, flagged headset-only** (C1) with a `// VERIFY ON: headset` banner and an emulator no-op fallback.
- **Capability honesty:** every build report gains a **`verifiedOnEmulator` vs `builtForHeadset`** split.

### v3.2 — Drive the Spatial Editor itself (automation)
Goal: an agent can perform **editor operations** that have no CLI — physics bake, component attach, material edit, IBL/lighting, timeline keyframing — by driving the editor headlessly or via the GUI.
- **Spike first (cheapest-gate):** map the editor's headless reach — does `--ide_noGraphics` accept a *project + an operation* (bake / export) or only a full build? Probe QML/engine scripting hooks + the `saved/config` project format. Determine the boundary between "scriptable headless" and "GUI-only".
- **`editor_build_project`** (harden the existing headless build) + **`editor_export_bundle`** (editor-parity bake, incl. cooked physics that `spatialbundle` alone doesn't produce).
- **`editor_op`** — a single abstraction: request an editor action (add component, bake collision, set material, set IBL); the MCP executes it **headless if possible, else GUI-driven** (reusing `gui_capture`/`gui_camera` + accessibility) and **verifies via `decode_editor_project`**. This is the "agent has hands in the editor" capability the user asked for.
- **`editor_project_diff`** — after any editor re-save, diff the `SpatialPackContent` vs. the last-good state (the editor silently drops hand-authored `over` blocks — a known hazard). Auto-restore dropped MCP content.

### v3.3 — Make emulator verification trustworthy (kill the C2 blind spot)
Goal: turn "I can't see what I built" into deterministic, honest verification.
- **Controllable-camera capture:** investigate the only paths that may give a *known* viewpoint — the editor's **ScenePreview** app (does it expose a fixed/scriptable camera?), a stage launched at a known recenter pose, or an in-app debug "screenshot camera" entity rendered to an offscreen target the app can dump. Ship whichever yields a deterministic frame.
- **`verify_visual`** — drive that deterministic capture + perceptual diff vs. baselines (extends `run_visual_regression`/`design_review`), so visual regressions are catchable headless.
- **`assert_scene`** — a verification DSL over `decode_*` + logcat: assert geometry/material/component/anchor presence + runtime log markers in one call (structural truth even when pixels aren't capturable).
- **Auto capability report** — every `build_and_run` emits the honest matrix: what rendered/asserted vs. what is headset-gated.

### v4.0 — The autonomous editor⇄emulator studio (+ headset-ready)
Goal: the full loop, autonomous, with a clean hardware-handoff.
- **`autonomous_spatial_build` v4** — brief → `editor_op` authoring (components/materials/physics/timeline/audio/IBL) → `editor_export_bundle` → emulator deploy → `verify_visual`/`assert_scene` → `diagnose` → iterate → ship, with the verified-vs-built report.
- **Headset-readiness layer** — the C1/C3 features (sense/plane surface pins, controller-ray interaction, in-front interactive panels) are **generated, statically checked, and packaged** so they activate on PICO Swan with zero rework; the report says exactly what to re-test on hardware.
- **Richness** — spatial audio sources, timeline/keyframe animation, persisted `WorldAnchor`s, IBL lighting — authored via the editor and emulator-checked as far as C1–C4 allow.
- **Templates + a "Swan bring-up" checklist** so day-one-on-hardware is a verification pass, not a build.

---

## 4. New MCP tool inventory (concrete, ~14 tools)

| Tool | Phase | Purpose |
|---|---|---|
| `decode_editor_project` | v3.1 | X-ray a whole editor `SpatialPackContent` (scenes, components, cooked physics, materials, assets) |
| `author_editor_component` | v3.1 | Emit editor-format Collision/Anchor/Audio/Timeline components onto a prim |
| `author_materialx` | v3.1 | Generate MaterialX PBR + UNLIT + texture-override materials (fixes dim/black textures) |
| `generate_scene_understanding_kotlin` | v3.1 | `sense/plane`+`mesh`+`AnchorComponent` surface-pin code (headset-flagged) |
| `editor_build_project` | v3.2 | Hardened headless editor build |
| `editor_export_bundle` | v3.2 | Editor-parity bake incl. cooked physics |
| `editor_op` | v3.2 | Perform an editor operation (headless or GUI-driven) + verify via decode |
| `editor_project_diff` | v3.2 | Diff/auto-restore after an editor re-save |
| `verify_visual` | v3.3 | Deterministic capture + perceptual diff |
| `assert_scene` | v3.3 | One-call structural + runtime verification DSL |
| `capability_report` | v3.3 | Honest verified-vs-built matrix per build |
| `generate_mr_app` | v3.1 | Mixed-stage home-env scaffold (no falling-out) — *proven this session* |
| `deploy_to_device` | v4.0 | Headset deploy/verify path (dormant until Swan; adb-over-USB ready) |
| `autonomous_spatial_build` v4 | v4.0 | The full editor⇄emulator loop |

---

## 5. The per-run experiment protocol (the user's directive, operationalized)

> "Focus on experimenting with the Spatial Editor and all its functionalities during these runs."

Every working session runs this loop on **one** editor functionality so the MCP grows by verified
increments instead of guesses:

1. **Pick** an unmastered editor functionality (e.g. physics bake, MaterialX, timelines, audio, IBL, anchors).
2. **Drive** it in the editor (GUI or headless) on a throwaway project; capture the editor's output.
3. **Decode** what it produced (`decode_editor_project`) — the `.Library`/`.Component`/`.CacheData` deltas.
4. **Codify** the recipe as an MCP tool (`author_*` / `editor_op`), with the exact format baked in.
5. **Verify** on the emulator as far as C1–C4 allow (`assert_scene` / `verify_visual` / logcat), and
   **honestly flag** anything headset-only.
6. **Record** the finding in memory + DESIGN.md + this roadmap; ship the tool; repeat.

This is the discipline that turns "an agent can build PICO apps" into "an agent can drive the **whole
PICO authoring toolchain** at the level a human editor-user can — and knows exactly what it can and
can't prove without hardware."

---

## 6. Definition of done (per version)
- **v3.1:** `decode_editor_project` round-trips a real editor project; `author_materialx` makes a textured mesh render *bright* on the emulator; reports split verified-vs-built.
- **v3.2:** an agent attaches a component / bakes physics / edits a material **through the editor** (not USD-text) and the change is decode-verified.
- **v3.3:** a deterministic emulator capture exists; `verify_visual` catches a planted regression; the capability matrix is auto-emitted.
- **v4.0:** one brief → a polished editor-authored app, deployed + verified on the emulator with an honest report, and the headset-only parts pre-built for Swan.

---

## 7. THE REFINED v3.4 → v4.0 EXECUTION LADDER (2026-06-18 — supersedes the v3.3→v4.0 jump above)

Designed by a 3-architect panel + synthesis (workflow `roadmap-v35-to-v40`), **grounded against the live 82-tool tree** — ~16 tools the panel first called "new" already shipped, so the genuinely-unbuilt work is tight. **DONE: v3.1–v3.4** (authoring, editor headless tools, the VISION GATE + `verify`, `bundle_content_diff`, camera control). Ordering principle: **every version v3.5–v3.8 is fully emulator-verifiable** (vision where it renders, structural where vision is blind); headset-only work (C1/C3/C4) is **codegen + flag**, never blocking a DoD; v4.0 wires the unattended loop with the existing `verify` gate as the mandatory pre-ship check.

### v3.5 — Honest reporting wired into the loop
Auto-emit the verified-vs-built matrix from every build (no manual grading).
- **`capability_report` wire-in** — `build_and_run` + `iterate_scene` CALL it automatically and append the honest `verifiedOnEmulator`-vs-`builtForHeadset` matrix. _(structural)_
- **`decode_editor_project` harden** — label each decoded feature emulator-verifiable (geometry/material/physics-cook) vs headset-only (sense/plane, controller, in-front panels) to feed the matrix. _(structural)_
- **`assert_scene` harden** — formalize as the machine-backed structural arm (entity/component/anchor counts + logcat markers). _(structural)_
- **DoD:** no build finishes without a derived honest split; the loop never prints "verified" on a logcat/compile-only feature; smoke 0.

### v3.6 — Editor-parity bake (cooked physics + render-correct template)
- **`editor_export_bundle`** _(NEW)_ — invoke the editor bake (`--ide_noGraphics`; GUI fallback only if needed) to emit a bundle WITH cooked CollisionShape + PhysicsMaterial that `spatialbundle pack` alone does not cook. _(structural; rayCast HIT is logcat-asserted)_
- **`generate_mr_app`** _(NEW, lightweight)_ — mixed-stage scaffold (`stage.style=1`) where home-env + spatial pins render together (no falling-out); a `scaffold_spatial_app` template. _(vision)_
- **`author_scene_ibl`** _(NEW)_ — image-based-lighting USD/MaterialX so dim baked meshes are lit the correct way (not emissive hacks). _(vision: lit-vs-unlit delta visible)_
- **`editor_op`/`editor_project_diff` harden** — attach-component / set-material / set-IBL / bake (headless-first) + dropped-`over`-block auto-restore.
- **DoD:** `editor_export_bundle` cooked physics is decode-verified; an IBL/material chain renders BRIGHT (captured + vision-inspected); `generate_mr_app` renders home-env + pins clean.

### v3.7 — Deterministic visual verification (make `verify` the mandatory gate)
- **`verify_visual` harden + baseline** — codify a fixed verification camera pose (`emulator_look` to a content-centering framing) + baseline PNGs in `.pico/baselines/<scene>.png`; catch a PLANTED regression (diff > threshold) and report clean (~0) on an unchanged rebuild.
- **`assert_scene` finalize** — lock the 5+-fact structural DSL as the fallback when pixels are blind.
- **`verify` gate harden** — the single mandatory pre-ship check the v4 loop calls.
- **DoD:** a planted color/mesh break is caught by the diff; verify is mandatory before any done-claim.

### v3.8 — Richness codegen + Swan readiness (author audio/animation/anchors; pre-build the headset layer)
- **`generate_spatial_audio_kotlin`** _(NEW)_ — attach AudioSourceComponent (3D pos/attenuation, load clip). _(structural; PLAYBACK headset-only — flagged)_
- **`generate_animation_kotlin`** _(NEW)_ — load/play an editor-authored timeline. _(structural; keyframe PLAYBACK headset-only — flagged)_
- **`generate_persistent_anchor_kotlin`** _(NEW)_ — save/load WorldAnchor poses. _(structural; cross-launch persistence + real anchoring C1 headset-only — flagged)_
- **`generate_headset_readiness_codegen`** _(NEW)_ — for every C1/C3/C4 feature emit pre-built, runtime-gated Kotlin (sense/plane pins, ControllerInteractionManager with head-ray emulator fallback, in-front panels) that COMPILES + no-op-fallback runs without crashing. _(compile-only)_
- **`swan_bring_up_checklist`** _(NEW, meta)_ — read the capability matrix + generated headset code + emulator results → emit a keyed re-test checklist for hardware. _(structural)_
- **DoD:** each codegen COMPILES + its attach/save marker is logcat-asserted; playback/persistence honestly flagged headset-only; the checklist is emitted.

### v4.0 — The autonomous spatial studio (brief → verified app + honest report + Swan handoff)
- **`autonomous_spatial_build` V4** _(prompt rewrite)_ — unattended: scaffold → author (`editor_op` + Kotlin codegen) → bake (`editor_export_bundle`) → deploy → **`verify` GATE (structural AND inspected frames; no step advances without a machine-checkable signal)** → `diagnose` → iterate → honest auto-assembled report. Inject `generate_agent_bridge` by default.
- **`deploy_to_device`** _(NEW, dormant skeleton)_ — Swan adb-over-USB install → launch → capture → assert_scene sanity. _(headset-only; emulator proves only that it's wired + doesn't crash the loop)_
- **DoD:** the loop runs from a textual brief end-to-end and is demonstrated on **TWO distinct briefs** (ClaimSight + one new) to prove it's brief-general; emits the honest verified-vs-built report + the Swan bring-up checklist.

### Build order (18 steps)
v3.5: (1) wire capability_report into build_and_run + iterate_scene · (2) harden decode_editor_project labels · (3) formalize assert_scene structural arm.
v3.6: (4) editor_export_bundle · (5) generate_mr_app · (6) author_scene_ibl · (7) harden editor_op/editor_project_diff.
v3.7: (8) canonical verification pose + .pico/baselines · (9) harden verify_visual baseline diff + assert_scene DSL · (10) make verify mandatory.
v3.8: (11) generate_spatial_audio_kotlin · (12) generate_animation_kotlin · (13) generate_persistent_anchor_kotlin · (14) generate_headset_readiness_codegen · (15) swan_bring_up_checklist.
v4.0: (16) rewrite autonomous_spatial_build V4 · (17) deploy_to_device skeleton · (18) end-to-end demo on ClaimSight + one new brief + honest report + Swan checklist.

### Honest risks (from the synthesis)
- **`editor_export_bundle` cooked-physics headless reach** is the biggest unknown; `V3.2_EDITOR_AUTOMATION_MAP.md` de-risks it, but if `--ide_noGraphics` cannot bake cooked physics, fall back to GUI-driven bake (and say so).
- **C2 residual:** capture is byte-stable but only sees the forward FOV — `emulator_look` orbit + structural fallback covers off-FOV; don't re-litigate C2.
- **v3.8 richness is authoring-only-verifiable** — audio PLAYBACK, timeline PLAYBACK, cross-launch anchor PERSISTENCE are runtime/headset-gated; codegen + flag, never claim verified.
- **`verify_visual` perceptual diff is coarse** (MAE ~0.06) and noisy on splats/animation → lean on `assert_scene` structural facts for noisy scenes.
- **`deploy_to_device` is untestable until Swan** — a clearly-gated dormant skeleton that cannot crash the loop.
- **v4.0 demo must run on TWO briefs** (not just ClaimSight) to prove brief-general, not overfit.
- **Dropped from scope (deliberately):** mesh-collider shapes (never register on-device — box only), multi-agent parallel writers on shared app files.
