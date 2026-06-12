# Building ClaimSight as a native PICO spatial APK

A worked example: turning the ClaimSight insurance-inspection concept into a real
native PICO OS6 app that builds, installs, and renders on the emulator — produced
end-to-end through this MCP. Verified 2026-06-11 (toolchain 0.13, emulator 0.13.1).

## Result

A Full-immersion spatial app (`pico.spatial.stage.style = 3`) that replaces the
home environment with a damaged-room inspection scene and floats a **ClaimSight
inspection-log panel** in 3D — header, "Inspection Log · 5 findings · HO-3", five
damage findings each with a canonical severity-color dot and real IICRC/Haag
adjuster notes, and a Smith AI-companion line in accent blue. The 2D panel renders
crisply in the headset view; the 3D damage markers are pinned around the room.

## Native spatial app anatomy (reverse-engineered from the PICO template)

- **Two Gradle modules:** `:app` (the Android app) + `:editor-asset` (a library
  module applying `com.pico.spatial.tools`, holding the scene under
  `src/main/res3d/<Name>/Sources/Scenes/*.usda`, packed to `assets/editor-asset.bundle`).
- **SDK:** `com.pico.spatial:bom` pins `com.pico.spatial.{core,ui,sense,tracking}`.
  The build excludes stock `androidx.compose.{ui,foundation}` — PICO ships modified
  Compose, so `Text`/`Column`/`Row`/`backgroundMaterial` resolve to PICO's versions.
- **Manifest** declares the spatial stage: `pico.spatial.stage.id`,
  `pico.spatial.stage.style` (3 = Full → 100% virtual, fills the view), and the
  `icon.3d.list`/`icon.sdf.list` meta-data the SpatialManifestValidator checks.
- **Entry:** `SpatialApplication.launch(::mainApp)` → `DefaultStage { PicoTheme { HomeStage() } }`.
- **Rendering** (`HomeStage`): `SpatialView` loads the bundle and an entity **by model
  name** (`Entity.loadSuspend(modelName = "MyScene", bundle)`), positions it via
  `TransformComponent.setPosition(Vector3(...))`, and floats 2D Compose UI via
  `AttachmentPanel(id) { ... }`. Model name == the `.usda` filename stem.

## The build recipe (what the MCP does)

1. `compose_inspection_scene` → writes the damaged-room + severity-marker scene to
   `editor-asset/.../Sources/Scenes/MyScene.usda` (model name stays `MyScene`).
2. Author `HomeStage.kt`: load `MyScene`, build the inspection-log panel in Compose
   (the canonical palette `#22c55e/#eab308/#f97316/#ef4444/#a855f7` + Smith line).
3. Set `strings.xml` branding (`app_name = ClaimSight`).
4. `build_and_run` (auto-detects Android Studio's JBR for `JAVA_HOME`): builds the
   APK via `:app:assembleDebug`, installs, clean-relaunches, and **verifies a frame
   actually rendered** (`FirstFrameRelease(Displayed)` / SpatialView RenderEntity).
5. `gui_capture` (macOS, Screen Recording permission) screenshots the real
   host-composited 3D view to confirm visually.

## The full experience (v0.8)

The native app now mirrors the WebXR ClaimSight UX, built as floating Compose
spatial panels + a 3D damage-marker scene:

- **Damage markers that stick to ANY surface** — the hard problem from WebXR. Each
  marker is a "saturn" (halo disc → stem → dome → glowing core → equator ring),
  authored by `compose_inspection_scene` with a `surface` field
  (`floor`/`ceiling`/`wall_north|south|east|west`) or an explicit `normal`. The marker
  Xform is oriented by a quaternion that rotates its local **+Y onto the surface
  normal** — the same `computePinOrientation` logic as the WebXR build (world-up snap
  for near-horizontal surfaces). Floor, walls, and ceiling all use identical geometry;
  only the orientation changes. For *live* placement, raycast the controller against the
  room mesh and apply the same quaternion to the hit normal.
- **Placement menu (ControllerMenu)** — a spatial panel with Place Pin (highlighted) /
  Generate Report / Mute Smith / Clear All, mirroring the WebXR controller menu.
- **Rich detail card** — the signature ClaimSight card: damage type + severity dot,
  the adjuster action note, IICRC standard (`– IICRC S500`) + specialist callout
  (`› iicrc_wrt`), a "Photo-grounded analysis" section with the AI text and the
  captured-photo thumbnail (with reticle), and Close/Remove. Faithful to production.
- **Inspection log** — the running severity-coded findings list + Smith's line.

All three panels render crisply (verified via `gui_capture`); the markers are pinned
to the room surfaces (geometry verified via `verify_scene`).

## Key gotchas (now handled by the MCP)

- **No `java` on PATH** → Gradle fails with "Unable to locate a Java Runtime". The
  MCP auto-detects Android Studio's bundled JBR (`detectJavaHome`/`gradleEnv`).
- **Display-0 screenshots don't show immersive 3D** — use `gui_capture` for the real
  view; a Full stage replaces the home environment so content fills the frame.
- **Default camera framing** points away from off-center content; place the primary
  UI panel dead-ahead (`Vector3(0, 1.5, -1.3)`) or navigate with `gui_camera`.
- **USD `displayColor` primitives** compile to materials but the 2D Compose panels are
  the reliable visual; for photoreal geometry, reference real GLB/USDZ meshes
  (`import_asset`) or a world-model room (`import_environment` / `worldmodel_guide`).
