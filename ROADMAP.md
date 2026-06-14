# ROADMAP.md — v1.4 → v3.0, written to be executed by ANY agent (incl. a local model)

> **🎉 v3.0 IS SHIPPED — the autonomous spatial studio (67 tools, 2 prompts).** An agent can now
> BUILD AND VERIFY a native PICO XR app end-to-end on the emulator (no headset). The keystones
> landed this arc: working runtime surface physics (`generate_collider_kotlin` — `PhysicsWorldComponent`
> + primitive box room; USD/mesh colliders never become query actors on-device), rich environments
> that render (`bake_textured_model` to bake a textured GLB/Marble world + `generate_environment_kotlin`
> to load the baked mesh or a Gaussian splat — the "GLB textures render black" wall is cracked by
> baking, not runtime-loading), headless interaction (`app_broadcast`), the verification primitive
> (`assert_logcat`), and the rewritten `autonomous_spatial_build` prompt that drives the full
> proven loop. **Demonstrated on a fresh scaffolded app** (`com.example.spatialdemo`): scaffold →
> bake textured env → box-collider room → Compose menu → build → install → broadcast-driven
> placement → `assert_logcat` `rayCast HIT` + `placed pin #N` on a real wall → `gui_capture` of the
> textured room. DESIGN.md §9 = runtime physics. ClaimSight (`~/AndroidStudioProjects/claimsight-native`)
> remains the test bed; the deferred polish items (mesh brightness, collider/mesh alignment, panel
> placement) are in §6/§7.
>
> **(history)** v2.0 shipped 60 tools/2 prompts; §6 = OPEN ITEMS, §7 = the v2.1 → v3.0 arc. Start a
> new turn/chat with `autonomous_spatial_build` loaded and this file open.


This is a **self-contained handoff**. If the primary agent (Claude) is unavailable (usage
limits), a local open-weight model (e.g. Gemma 4 31B via LM Studio/llama.cpp with this MCP
attached) can pick up and execute from here. Read [SKILLS.md](SKILLS.md) and
[DESIGN.md](DESIGN.md) first — they encode the correctness rules and the self-diagnosis loop.

---

## 0. Orientation — where things are

- **MCP server (this repo):** `/Users/sushantsrikrish/PICO-MCP`. Build: `npm run build`.
  Smoke: `npm run smoke` (expect `0 failures`). 55 tools. Source in `src/*.ts`.
- **The demo app (ClaimSight, native):**
  `/Users/sushantsrikrish/AndroidStudioProjects/claimsight-native`. Two Gradle modules:
  `app` (Kotlin/Compose UI in `app/src/main/java/com/example/claimsight/content/`,
  notably `HomeStage.kt` + `PinPlacer.kt`) and `editor-asset` (the scene at
  `editor-asset/src/main/res3d/SpatialPackContent/Sources/Scenes/MyScene.usda`, plus
  `Pin.usda` and `Assets/`).
- **Build the app (CRITICAL — no `java` on PATH):**
  `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` then
  `cd <project> && ./gradlew :app:assembleDebug`. Or use the MCP `build_and_run` tool
  (auto-detects the JBR).
- **Run + see it:** `build_and_run` (build→install→relaunch→render-check→shot). On macOS,
  `gui_capture` screenshots the REAL 3D view (needs Screen Recording permission). The
  emulator is already booted; `gui_find_window` returns the window to capture.
- **Marble assets:** `/Users/sushantsrikrish/Marble Worlds/` — `*_pano.png` (the working
  skybox texture), `*_collider.glb` (untextured), `*.spz` (splat, not loadable),
  `apartment_textured.glb` (Blender-projected; GLB textures don't render in this runtime).

## 1. What works today (v1.3) and what doesn't

WORKS: scaffold→author→build→run→capture loop; `compose_inspection_scene` with real
**materials** (not displayColor); **skybox environment** via texture-override of a
sky-sphere mesh (decayed apartment renders, surrounds the user, fixes "falling out");
severity-colored saturn markers; clickable Compose menu/card buttons; **gaze/controller
aiming** (`PinPlacer` reads `HMDTrackingProvider`/`ControllerTrackingProvider`, raycasts a
virtual room AABB); Clear All; Generate Report panel; Mute toggle.

SHIPPED since (v1.4–v2.0): **movable/closable panels** (each panel a `WindowContainer`
with caption-bar chrome — DESIGN.md §6b); **`generate_spatial_ui`**; **asset pipeline**
`prepare_environment`/`list_environment_assets`; **self-diagnosis** `diagnose` +
`design_review`; **`autonomous_spatial_build`** prompt.

SHIPPED in v2.1 (2026-06-12): **tap-a-pin → its detail card** (`PinPlacer` ray-vs-sphere +
data-driven `DamageCard`, §6.2); **gated report backend** (`ClaimsApi` → real `/api/assess`
with mock fallback, §6.3); **asset-free audio feedback** (`SoundFx` synthesized click + Smith
cue via `Entity.playAudioStream`, gated by Mute, §6.5); **`run_visual_regression`** MCP tool
(snapshot capture + sips/ImageMagick perceptual diff, §6.4 — 61 tools). App `claimsight-native`
is now git-tracked.

STILL OPEN (in priority order):
1. **Panels in front of the user** (§6.1 — DEFERRED): WindowContainers can't self-anchor to the
   user (Placement API has no head/world anchor, internal accessors) and dead-ahead
   AttachmentPanels crash the stage in SDK 0.13. Needs the platform window-transform API; best
   validated on device. DESIGN.md §6b has the full findings.
2. **Pin lands exactly where the controller ray points.** Aim works against a virtual AABB; the
   controller 6DOF pose is null in the emulator (head-gaze fallback), so this is a **device** task.
3. **Interactive verification on device** (§7 v2.3): the emulator gates controller-trigger input
   and host-composites the spatial UI (not in the a11y tree), so 6.2 (tap-select), 6.5 (audio),
   and 6.3 (live API + mic) are implemented but **not interactively verifiable here** — verify on
   the attached Quest 3 / a real PICO.
4. **Textured mesh environments** (GLB/USDZ textures render black). Only skybox-override + baked
   USDZ render. Investigate the editor's texture format, or keep skybox.
5. **Real backend LIVE path** (§6.3 wired but gated `BACKEND_ENABLED=false`): stand up the
   ClaimSight API + key, flip the gate, verify the card fills from `/api/assess`.

## 2. v1.4 — Spatial UX primitives (the next build)

### 2a. Controller-ray placement that lands on the pointed surface
- File: `app/.../content/PinPlacer.kt`. It already prefers the controller pose
  (`controller.latestData.right`) over the head pose, casts the forward ray
  (`pose.rotation.rotateVector(Vector3.FORWARD)`) at a virtual AABB (`raycastRoom`), and
  commits only when armed (debounced). **Verify in the emulator:** boot app, click "Place
  Pin", drive the right controller with the trackpad, click on a wall. Check `adb logcat
  -s ClaimSightPin` for `commit at look point ...`. If the controller pose is null,
  fall back to head pose (already implemented) — but confirm which the emulator provides
  in controller mode by logging both at commit.
- Tune the AABB (`PinPlacer` ctor `halfW/height/halfD/roomCenterZ`) so committed pins
  appear on the apartment walls. Iterate with `gui_capture`.

### 2b. Movable / closable / resizable panels (HIGH user value)
- API (decompiled, see `docs/spatial-interaction-api.md` and the SDK AARs):
  `com.pico.spatial.ui.foundation.dsl.WindowContainerKt.WindowContainer(scope, name,
  form, size, resizeType, resizeRestriction, ..., captionBarType, ...) { content }` —
  gives a window with a **caption bar** (move + close + resize chrome, like the browser
  panel). Also `com.pico.spatial.ui.foundation.gesture.spatialDrag` for drag gestures.
- Task: in `app/.../Main.kt` (`DefaultStage { ... }`) and `HomeStage.kt`, render the three
  panels as `WindowContainer`s (each its own movable window with a caption bar) instead of
  raw `SpatialView` `AttachmentPanel`s. Keep `SpatialView` for the 3D scene + markers.
  Verify: build, capture, confirm the panels have a title bar and can be grabbed/closed.
- Decompile the exact enum values: `javap -p -classpath /tmp/pico-sdk/ui-foundation/x
  com.pico.spatial.ui.platform.resize.CaptionBarType` (etc.). Extract AARs first:
  `unzip -o <aar> classes.jar -d /tmp/pico-sdk/ui-foundation && unzip -o
  /tmp/pico-sdk/ui-foundation/classes.jar -d /tmp/pico-sdk/ui-foundation/x`. Use the
  Android Studio JBR's `javap` (`.../jbr/Contents/Home/bin/javap`) — there is no `java` on PATH.

### 2c. Tap a pin to open its card
- Make each placed pin selectable: add `InteractableComponent()` to the pin entity (see
  `docs/spatial-interaction-api.md`). The SDK has **no public select callback**, so detect
  selection yourself: on a controller trigger while NOT armed, cast the controller ray and
  test against each placed pin's world position (sphere of radius ~0.15). Nearest hit →
  set a shared `selectedFinding` state → the card shows that finding's details.

### 2d. Audio feedback (Mute should mean something)
- Use the SDK audio API (`com.pico.spatial.core.ecs.audio.AudioPlayerController`, see the
  core AAR) to play a soft click on commit and a Smith voice line; `smithMuted` gates it.

## 3. v1.5–v2.0 — the bigger arc (each is one focused build)

- **v1.5 Component library:** add MCP tools that emit verified Compose panels (cards,
  menus, lists, reports) and marker styles from a spec, so agents assemble UI from
  correct-by-construction primitives. New file e.g. `src/components.ts`. Encodes DESIGN.md
  as code.
- **v1.6 Self-diagnosis (HIGHEST leverage):** a `design_review` MCP tool — `gui_capture`
  the app, run a vision critique against DESIGN.md (geometry colored? panels readable?
  content framed? interaction gated? pins on surfaces?), return a defect checklist + the
  fix for each. A `diagnose` tool maps a symptom (white/invisible/tiny/crash/black-env) to
  root cause + remediation. This is the "agent reviews its own work" capability.
- **v1.7 Asset/world-model pipeline:** MCP tools to ingest Hunyuan3D/Marble/Skybox-AI/
  Scaniverse outputs (auto-detect collider-vs-textured-vs-pano; pano→skybox via the
  override trick in `src/inspection.ts`; Blender texture-projection like
  `/tmp/texture_apartment.py` for meshes; scatter props). NOTE: Hunyuan3D is CUDA-only —
  on Apple Silicon use its HF Space (no local install) and import the exported GLB.
- **v1.8 Backend integration:** patterns for the native app to call real APIs (audio
  capture → transcribe → assess → Sonnet), persistence, and live report generation.
- **v1.9 Test harness:** snapshot a known emulator state (`snapshot_save`), script
  interactions, screenshot-diff for regression; `scaffold_app_from_spec` (spec → running app).
- **v2.0 Autonomous spatial app builder:** compose all of the above so an agent takes a
  product brief → scaffolds → generates assets → composes UI from verified primitives →
  builds → **reviews its own captures, finds defects, fixes, re-verifies** → ships a
  polished APK + a build/test report. ClaimSight is one example output, not the product.

## 4. The non-negotiable gotchas (don't relearn these the hard way)

1. **Color = bound Material** (`ND_UsdPreviewSurface_surfaceshader` + `MaterialBindingAPI`),
   NEVER `primvars:displayColor` (renders white). DESIGN.md §1.
2. **Skybox = override a working sky-sphere's texture node**, not a hand-authored image
   material (those don't pack → black). DESIGN.md §1b. `compose_inspection_scene
   environment={type:'skybox'}`.
3. **GLB/USDZ mesh textures often render black** in this runtime. Prefer skybox for visuals.
4. **Emulator has head pose (WASD) but no/limited controller 6DOF pose**; aim with the head
   ray, or the controller ray when controller mode provides it. DESIGN.md §1c.
5. **No `java` on PATH** → use the Android Studio JBR for gradle/javap; the MCP auto-detects it.
6. **`gui_capture` is the only way to see immersive 3D** (adb/gRPC screenshots show display 0
   = home env + 2D panels, not the 3D stage). Needs macOS Screen Recording permission.
7. **Verify every change** with `verify_scene` + `build_and_run` (read `rendered`/`crashes`)
   + `gui_capture`. Treat each capture as a code review (SKILLS.md self-diagnosis tree).
8. **Never auto-place / never act on every trigger.** Gate on an armed mode (DESIGN.md §5).

## 5. How a local model should drive a turn

One tool call per step; read the structured result; pick the next step from the
self-diagnosis tree (SKILLS.md). Always end a build attempt with `build_and_run` +
`gui_capture`, compare to intent, and iterate. Commit small, verified changes
(`git commit` + push to the private repo `sushidoescode/pico-spatial-mcp`) with a clear
message. Update this file's §1 (works/doesn't) as items close.

---

## 6. OPEN ITEMS

> **Status (worked 2026-06-12):** 6.2 ✅, 6.3 ✅, 6.4 ✅, 6.5 ✅ implemented; **6.1 ⚠️ deferred
> with findings** (no stable app-code path to in-front panels in SDK 0.13). The app
> (`claimsight-native`, now git-tracked) builds + runs stable with 6.2/6.3/6.5 integrated;
> 6.4 ships in the MCP (`run_visual_regression`, 61 tools, smoke 0 failures). Interactive
> verification of 6.2/6.5 (controller trigger) and 6.3's live path (API + mic) is **emulator-
> blocked** — those need the real-device pipeline (§7 v2.3). See per-item notes below.

Each item: where, the API/approach, and how to verify. Build → `build_and_run` → `design_review` → `diagnose` any FAIL → fix → re-verify.

### 6.1 WindowContainer default placement (panels spawn off-screen) — ⚠️ DEFERRED (findings)
**Outcome:** neither viable path works in SDK 0.13. (a) The `Placement` API only anchors a
window **relative to a peer window** — `PlacementContext` exposes no head/world anchor and its
`containers` accessor is `internal`/`$foundation_release`, so `placement = { … }` **won't even
compile** from the app module. (b) Rendering the panels as dead-ahead `SpatialView`
`AttachmentPanel`s (the proven v0.x mechanism) **reproducibly tears the stage down on launch**
in 0.13 (every size form — default and explicit `IntSize` — `pxr_handle_spatial_app_exit`,
focus returns to launcher). So the panels stay movable/closable **WindowContainers** that spawn
off the default camera view (reachable by turning on a headset). Real fix needs the platform
window-transform API (`WindowContainerInfo`, `ui-platform`, internal) — a later build, ideally
validated on device (§7 v2.3). Full decompiled signatures + both failed attempts: DESIGN.md §6b.

### 6.1b (original 6.1 plan — kept for reference)
- WHERE: `claimsight-native/app/.../Main.kt` (the three `WindowContainer(...)` calls).
- APPROACH: set `ContainerProperties.placement` (a `(PlacementContext) -> Placement`). Decompile the constructors: `javap -p -classpath /tmp/pico-sdk/ui-foundation/x com.pico.spatial.ui.foundation.dsl.Placement$Companion` and `...PlacementContext`. `Placement` has an anchorContainer + `Placement$Orientation` + an offset (Dp). Anchor the menu/card/log left/center/right of the user at ~1.4 m. If the API proves too fiddly, an acceptable fallback is to KEEP one panel as an `AttachmentPanel` (fixed, visible) and make only the others `WindowContainer`s.
- VERIFY: launch, `gui_capture` — panels should appear in front; confirm they still drag/close.

### 6.2 Tap a pin → open its detail card — ✅ IMPLEMENTED
**Done:** `PinPlacer` keeps parallel `placedPoints`/`placedFindings`; a NOT-armed fresh trigger
press runs a manual controller/gaze ray-vs-sphere test (`dot(diff,diff) < 0.18²`, reuses
`gazePose()`) and fires `onPinSelected(findingIndex)`; `HomeStage.selectedFinding` drives a now
data-driven `DamageCard` (type/sev/note from the tapped pin's `Finding`). Compiles + app stable.
`InteractableComponent` omitted (the manual ray does the work; only `components.set(T)` exists to
add it). **Interactive proof needs a controller trigger → emulator-blocked (do on device, §7 v2.3).**
- WHERE: `PinPlacer.kt` (track placed pins + world positions; already in `placed`) and `HomeStage.kt`/card state.
- APPROACH: the SDK has NO public select callback. On a controller trigger while NOT armed, read the controller (or HMD) ray and test it against each placed pin's world position (sphere radius ~0.15 m): `t = dot(pinPos - origin, dir); closest = origin + dir*t; if (distance(closest, pinPos) < 0.15) selected = pin`. Set a shared `selectedFinding` state → the card shows that finding (give each pin a Finding via a parallel list keyed to the pin entity). Add `InteractableComponent()` to pins so they're hittable too.
- VERIFY: place 2-3 pins, point+click one (not armed), confirm its card opens.

### 6.3 Real backend wiring for Generate Report (the ClaimSight loop) — ✅ IMPLEMENTED (gated)
**Done:** new `ClaimsApi.kt` (object, `BACKEND_ENABLED=false`, `BASE_URL=http://10.0.2.2:3000`)
POSTs to the **real** ClaimSight `/api/assess` (it's an Anthropic Messages proxy, not a tidy
REST endpoint — body `{messages,system,max_tokens}`, response `content[].text`; assess JSON keys
are `damage_type`/`severity`/`documentation_note`; reports reuse `/api/assess` with
`REPORT_GENERATION_SYSTEM` — there is no `/api/report`). Uses `java.net.HttpURLConnection`
(okhttp is **not** on the classpath — confirmed) + `org.json`; every disabled/failure path
returns the existing mock so the emulator always renders. `Generate Report` opens the mock card
immediately, then launches `generateReport` on a scope. `INTERNET` permission added. Compiles +
app stable on the mock path. **Live path needs a running API + key → unverifiable here (gate off).**
- WHERE: app — add a small networking layer (HttpURLConnection — okhttp is NOT on the classpath).
- APPROACH: on pin commit, capture audio (MediaRecorder) → POST to the ClaimSight `/api/transcribe` + `/api/assess` (Claude Sonnet, already built per the ClaimSight repo) → populate the finding from the response. Generate Report → POST all findings → render the returned claims doc in `ReportCard`. Emulator has no mic in passthrough; gate behind a flag and mock when absent. This is the v1.8 "backend integration" item brought forward.
- VERIFY: with the ClaimSight API reachable, commit a finding and confirm the card fills from the API; else confirm the mock path.

### 6.4 Snapshot-based regression harness — ✅ IMPLEMENTED & VERIFIED
**Done:** new `src/regression.ts` → `run_visual_regression` (registered; **61 tools, smoke
`Failures: 0`**). Reuses the `gui_capture` window-enumeration + `screencapture -l<id>` path;
drives a resilient built-in ClaimSight step sequence (launch → arm → placed) via existing
adb/ui helpers (inapplicable steps self-skip); perceptual diff prefers ImageMagick
`compare -metric MAE`, else a **dependency-free `sips` downscale→32bpp-BMP mean-pixel diff**
(reuses diagnose.ts's decode); `updateBaseline=true` records baselines; structured errors (no
crash) on missing window / denied permission. **Diff algorithm validated on real captures:**
identical=0.0, two app-skybox frames=0.056, app-vs-home-env=0.356 (default threshold 0.06
discriminates correctly).
- WHERE: MCP — a new `src/regression.ts` tool `run_visual_regression`.
- APPROACH: `snapshot_save` a known emulator state; script a sequence (launch app, place N pins, open report) via the existing tools; `gui_capture` at each step; compare against committed baseline PNGs (perceptual diff — shell to `sips`/ImageMagick or a tiny pixel-diff). Flag regressions. Pairs with `design_review`.
- VERIFY: run twice, expect "no regression"; intentionally break a color, expect a flagged diff.

### 6.5 Audio feedback (Mute should do something) — ✅ IMPLEMENTED (asset-free)
**Done:** new `SoundFx.kt` synthesizes PCM with **no bundled asset** via
`Entity.playAudioStream(AudioStreamConfig(), AudioStreamDataCallback)` (the pull `onMoreData`
fills a ByteBuffer; default format = interleaved INT16-LE stereo @ 48 kHz, confirmed from the
default ctors). A ~60 ms decayed-sine **click** fires on pin commit and a ~220 ms two-tone
**Smith cue** on Generate Report; both gated by `muted = { smithMuted.value }` and wrapped in
`runCatching` (can never crash). Compiles + app stable. **Audibility is unverifiable on the
emulator** (no guaranteed audio device); a real recorded Smith voice would need a bundled WAV/OGG.
- WHERE: `PinPlacer`/`HomeStage`.
- APPROACH: `com.pico.spatial.core.ecs.audio.AudioPlayerController` (core AAR) — play a soft click on commit + a Smith voice line; `smithMuted` gates it. Decompile its ctor/methods with the JBR javap.

## 7. v2.1 → v3.0 — the longer arc (scope; refine when starting each)

- **v2.1 — Polish & close-out:** finish §6.1–6.5. The app becomes genuinely usable end-to-end (panels in front + movable, tap-to-select, real report, audio, regression-guarded).
- **v2.2 — Interaction depth:** multi-pin select/edit (change severity, delete one), a radial/controller-menu for damage TYPE selection at commit time, undo/redo, and gaze+controller dual-aim. New MCP `compose_interaction_kit` to emit these patterns.
- **v2.3 — Real-device pipeline:** build/deploy/launch on a PHYSICAL PICO/Quest over adb-wifi (the Quest 3 is already attached per `adb devices`). On hardware the controller 6DOF pose + passthrough + real camera capture work — the placement and photo-grounded loop become real. New tools: `device_deploy`, `device_capture`. Document the emulator-vs-device capability matrix.
- **v2.4 — Asset richness:** scatter generated PROPS (Hunyuan3D via its HF Space → GLB → place in scene); research native Gaussian-splat rendering (Spark.js bridge or a splat→mesh bake) so Marble SPZ becomes usable; crack the editor's on-mesh texture format so textured meshes stop rendering black (would unlock textured rooms with real surfaces). `place_props`, `bake_splat`.
- **v2.5 — Generalization beyond ClaimSight:** ship 3–4 app templates via `scaffold_spatial_app` (data-viz dashboard, training/sim, gallery, control room) proving the MCP builds ANY spatial app, not one. A `template` registry.
- **v2.6 — Collaboration & persistence:** session save/load, cross-device link (mirror ClaimSight's PLAN_TWIN link flow), and a reviewer surface. `session_save`/`session_link`.
- **v2.7 — Performance & QA:** frame-time/draw-call profiling (integrate PICO's XR-Profiling-Toolkit), perf budgets in `verify_scene`, and CI visual-regression. A `profile_app` tool.
- **v2.8 — Smarter agents:** upgrade `design_review` from pass/fail to a SCORED rubric with severity-weighted findings; add a corrections memory (when a human overrides a fix, record it) so the agent improves; a `critique` that proposes UX/visual improvements, not just defect detection.
- **v2.9 — Ecosystem:** after the PICO SDK License Terms / NDA review, publish the MCP (npm + MCP registry), with a public template/recipe library. (Until then it stays private — never bundle PICO bits.)
- **v3.0 — The autonomous spatial studio:** the full unattended pipeline — natural-language brief → world-model assets → composed app from verified primitives → built → self-reviewed/diagnosed/fixed → deployed to a real headset → interaction-tested → iterated to a quality bar — orchestrated as a multi-phase Workflow. The human gives a brief and a budget; the studio delivers a shippable, device-verified spatial app + a build/test report. ClaimSight is example output #1 of many.

## 8. Verify the whole MCP still works after any change
`npm run build && npm run smoke` → expect `Failures: 0` and the full tool list. Commit small + push to the private repo `sushidoescode/pico-spatial-mcp`. Update §1 (works/doesn't) and check off §6 items as they close.
