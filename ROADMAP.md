# ROADMAP.md — v1.4 → v2.0, written to be executed by ANY agent (incl. a local model)

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

DOESN'T (open items, in priority order — these are the v1.4 work):
1. **Pin lands exactly where the controller ray points.** The aim works (arm → point →
   click) and hits a virtual AABB, but (a) the controller pose must be read correctly in
   the emulator's controller mode, and (b) the AABB should match the apparent apartment
   walls so pins read as "on the surface". Tune `PinPlacer`'s AABB; verify the controller
   pose is non-null when the user drives the right controller with the trackpad.
2. **Movable/closable/resizable panels** (like the emulator browser). API exists; not wired.
3. **Tap a pin → opens its detail card** (controller-ray-vs-pin hit-test). No public SDK
   select callback; needs a manual ray-vs-bounds test.
4. **Textured mesh environments** (GLB/USDZ textures render black in this runtime). Only
   skybox-override + USDZ-with-baked-materials render. Investigate the editor's texture
   format, or keep skybox.
5. **Real backend flow** (Generate Report → audio capture → assess API → Sonnet). Currently
   a mock panel.

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
