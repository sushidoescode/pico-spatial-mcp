# DESIGN.md — building beautiful, working PICO spatial apps

Agent-facing design rules for the PICO OS6 spatial runtime, distilled from building
ClaimSight end-to-end. These are not style preferences — most are **correctness rules**
the runtime silently enforces (get them wrong and geometry is white, invisible, tiny, or
falls out of view). Read this before authoring scenes or spatial UI.

## 1. Color requires MATERIALS, never `displayColor`

`primvars:displayColor` renders as a **flat white UNLIT material** in the PICO runtime.
For real color you MUST bind a `Material` with a MaterialX UsdPreviewSurface shader:

```usda
def Scope "Materials" {
    def Material "Red" {
        token outputs:mtlx:surface.connect = </Root/Materials/Red/Shader.outputs:out>
        def Shader "Shader" {
            uniform token info:id = "ND_UsdPreviewSurface_surfaceshader"
            color3f inputs:diffuseColor = (0.94, 0.27, 0.27) (colorSpace = "lin_srgb")
            color3f inputs:emissiveColor = (0.5, 0.13, 0.13) (colorSpace = "lin_srgb")  # glow / ambient
            float inputs:roughness = 0.45
            token outputs:out
        }
    }
}
def Sphere "Dot" (prepend apiSchemas = ["MaterialBindingAPI"]) {
    double radius = 0.06
    rel material:binding = </Root/Materials/Red>
}
```

`compose_scene` / `compose_inspection_scene` already do this. If you hand-author USDA,
follow the pattern. A small `emissiveColor` (~0.3× diffuse) makes geometry read brightly
without depending on scene lighting (which the runtime may not apply to all geometry).

## 1b. Skybox environments: override a working sky-sphere's texture

Hand-authored image-texture materials **do not pack** in this runtime (the texture is
dropped → black). To put a 360° equirectangular image (e.g. a World Labs Marble
"panorama image" export) on the environment, **reference a sky-sphere mesh that already
has an editor-authored image material and OVERRIDE its texture node's `inputs:file`**:

```usda
def "Sky_Sphere" (prepend references = @../Assets/Sky Sphere.usdz@) {
    over "_materials" { over "Sky_Sphere_m" { over "____________" {
        asset inputs:file = @../Assets/my_panorama.png@
    } } }
}
```

`compose_inspection_scene environment={type:'skybox', asset:'pano.png'}` does this. A
skybox surrounds the user everywhere, so it **also fixes "falling out"** of a finite room
(DESIGN.md §6). It has no near geometry, so aimed placement anchors at a fixed distance.

## 1c. Aim with the HEAD pose, not the controller (in the emulator)

The emulator provides **no 6DOF controller pose** (`ControllerTrackingProvider.latestData.right`
is null) but DOES provide the **head pose** (`HMDTrackingProvider.latestData.hmdPose`,
moved by WASD). For "place where I'm looking", cast the head's forward ray
(`pose.rotation.rotateVector(Vector3.FORWARD)`) against the room AABB (a few plane
intersections — no physics colliders needed) → hit point + inward normal. Works in the
emulator and on a headset; on a real headset substitute the controller ray.

## 2. Referenced models must be TEXTURED meshes

A referenced `.glb`/`.usdz` brings its own materials — but only if it HAS them. An
untextured **collider** mesh (e.g. a Marble collider export) renders dark and is often
positioned in its own coordinate frame (off-camera). Use a **textured** mesh export, or
a 360° equirectangular image as a skybox. Verify a GLB has materials/textures before
relying on it (`import_environment` notes this; inspect the glTF `materials`/`textures`).

## 3. Place markers on the actual surface coordinates

A marker "sticks to a surface" by orienting its local **+Y to the surface normal**
(`compose_inspection_scene`'s `surface` field does this). But it must also be AT the
surface: for a `w×h×d` procedural room centered at origin, walls are at `±w/2`/`±d/2`,
ceiling at `y=h`, floor at `y=0`. A ceiling marker belongs at `y≈h-0.08`, not floating
mid-air. Match coordinates to the environment.

## 4. Spatial UI = Compose panels, sized for distance

2D UI is real Jetpack-Compose (`AttachmentPanel { ... }`), rendered as a flat panel in
3D. Two rules:
- **Size generously.** dp maps to physical size; a 560 dp panel at 2 m reads tiny. Use
  **800–900 dp** panels, **18–40 sp** fonts, and place them **close (1.3–1.6 m)**.
- **Interactive elements must be actually clickable.** A static `Box`+`Text` does
  nothing. Use `Modifier.clickable { }` (or a real `Button`); the runtime maps the
  controller ray to Compose pointer events, so `onClick` fires when the user points + triggers.

## 5. Interaction is intentional — never automatic

Do NOT place/commit anything on every trigger press. Gate actions behind explicit UI:
an armed "Place Pin" mode, a "Commit" action, a "Clear All" button. The raw controller
`triggerPressed` fires constantly during normal use; treat it as a commit signal ONLY
when the relevant mode is armed. (The emulator provides trigger events but **no 6DOF
controller pose**, so design a button-driven path that works without aiming, plus the
controller-ray path for real headsets.)

## 6. Stage style + keeping the user "inside"

`pico.spatial.stage.style = 3` (Full) replaces the home environment with the app's
content. But a small procedural room is a finite box — moving past its walls reveals the
system environment. To keep the user enclosed: make the environment **large/enveloping**
(a big room or a skybox sphere), or accept that the emulator's free WASD camera can roam
(on a headset the user stands in place). A skybox sphere (large inverted sphere with a
textured/emissive material) guarantees a consistent backdrop everywhere.

## 6b. Movable / closable / resizable panels (window chrome)

Raw `AttachmentPanel`s inside `SpatialView` are fixed in place. For browser-like panels
the user can **grab, move, resize, and close**, render each panel as its own
`WindowContainer` at the `SpatialAppScope` level (alongside `DefaultStage`):

```kotlin
fun mainApp(scope: SpatialAppScope) = with(scope) {
    DefaultStage { PicoTheme { HomeStage() } }   // the immersive 3D scene
    WindowContainer("Title", Form.Planar, {
        defaultCaptionBarType = CaptionBarType.Default   // the move/close/resize chrome
        resizeType = ContainerResizeType.Automatic
    }) { PicoTheme { MyPanel() } }
}
```

Verified working (telemetry `WindowContainer_Planar`). Make the panel @Composables `internal`
so `Main.kt` can host them outside `HomeStage`.

**Placement caveat (decompilation-confirmed, SDK 0.13):** windows spawn at a system-chosen
default placement that is **not necessarily in the default camera view** — and you **cannot
reliably fix this from app code**:
- `ContainerProperties.placement` is a `(PlacementContext) -> Placement`, but `Placement`
  only anchors a window **relative to another window** (`Placement.left/right/top/bottom(peer, dp)`)
  — `PlacementContext` exposes no head/world/user anchor, and its `containers` accessor is
  `internal` (`$foundation_release`), so the lambda **does not even resolve** from an app module.
- The unanchored default is `Placement.none()` = the system spawn spot (often off-camera).

So a `WindowContainer` cannot be guaranteed "in front of the user." The proven way to put a
panel **dead-ahead** is a `SpatialView` `AttachmentPanel` positioned via its entity transform
(`attachments.entity(tag)…setPosition(Vector3(0,1.5,-1.4))`) — **but** in SDK 0.13 declaring
`AttachmentPanel`s in a `DefaultStage`+scene+`PinPlacer` SpatialView **tore the stage down on
launch** (any size form), so neither path currently delivers movable-AND-in-front panels.
Controllable window placement needs the platform window-transform API (`WindowContainerInfo`
in `ui-platform`, internal) — a future build. Until then: movable WindowContainers (may spawn
off-camera; reachable by turning on a headset) **or** a fixed dead-ahead AttachmentPanel where
the stage tolerates it.

## 7. Color & domain consistency

Reuse the app's real palette and domain vocabulary. ClaimSight: severity 1→5 =
`#22c55e #eab308 #f97316 #ef4444 #a855f7`, accent `#3b82f6`; damage taxonomy and
standards (IICRC S500/S520, Haag) are load-bearing, not decoration. Pull constants from
the source app, don't invent them.

## 8. Verify visually AND structurally

The runtime fails silently. After every change: `verify_scene` (geometry/material counts),
`build_and_run` (confirms a frame rendered + no crash), and `gui_capture` (the real 3D
view). If geometry is white → materials (rule 1). If invisible → off-camera or no
material. If tiny → panel size (rule 4). If pins everywhere → ungated placement (rule 5).

## 9. Runtime physics colliders — the ONLY way Scene.rayCast hits (verified on-device 2026-06-13)

Landing pins/markers on surfaces (or picking objects) needs `Scene.rayCast`, which is a
PhysX query. The hard-won, on-device-verified rules (use `generate_collider_kotlin` to emit
the whole recipe; `diagnose symptom=raycast_no_hit` for the fix):

- **USD-authored collision does NOT work.** The runtime never turns a `CollisionComponent`
  USD prim into a live PhysX query actor. You MUST attach the collider to a LIVE entity at
  runtime: `entity.components.set(CollisionComponent(...))` on `Dispatchers.Main`.
- **A `PhysicsWorldComponent` is REQUIRED on-device** (set it once on the scene root or a
  dedicated entity). Without it, colliders register in the SceneInspector but `rayCast`
  returns 0 hits. (The desktop editor dylib auto-creates the world; the device runtime does
  not — trust the device.)
- **Only PRIMITIVE shapes register.** `ShapeResource.createBox/createSphere/createCapsule`
  work; `createStaticMesh`/`createConvexMesh` from a loaded render mesh cook NO queryable
  triangles on-device. Model a room as 6 thin box "walls" at its AABB; model props as
  box/sphere/capsule.
- **API facts:** the `CollisionComponent` 5-arg ctor is public (the no-arg ctor is internal);
  no `RigidBodyComponent` is needed for a static collider; `createBox` takes FULL extents
  (a `Vector3(1,1,1)` box has faces at ±0.5).
- **Verify** with `assert_logcat` against your own `rayCast HIT` log line — never assume.

## 10. PICO math API — the accessor names that actually compile (sources-confirmed 0.13.3)

`Vector3`, `Quat`, `Transform` live in the **`foundation`** sources jar
(`foundation-0.13.3-sources.jar`), NOT `core`/`sense` — read those for ground truth
(`generate_scene_understanding_kotlin` embeds the verified usage).

- **`Transform` exposes `.position: Vector3`, `.quaternion: Quat`, `.scale: Vector3`, AND
  `.rotation: EulerAngles`.** `.rotation` is **Euler angles, not the quaternion** — using
  `transform.rotation.rotateVector(...)` does NOT compile. To rotate a vector by a transform's
  orientation use **`transform.quaternion.rotateVector(v)`**.
- **`Quat.rotateVector(v: Vector3): Vector3`** is the rotate API (there is no `Quat.transform`).
- **`Vector3`**: companion `Vector3.dot(a, b): Float`, constants `Vector3.UP` / `Vector3.FORWARD`;
  instance operators `plus` / `minus` / `times(scalar)` / `normalize()`.

## 11. Editor materials — MaterialX 1.38, and the bright-vs-dim trick (decoded 2026-06-14)

Use `author_materialx` to emit the editor's exact `.mtlx`; `decode_editor_project` to inspect a
project's materials. Hard facts decoded from real `MaterialCache/*.mtlx`:

- **The real material *instances* live in each project's `.CacheData/MaterialCache/`** as
  `{GUID}.{mtlx,material,mat,parameterinfo}`. The SDK *install* ships only nodedef **libraries**
  (`extend_defs.mtlx` etc.) — don't expect a ready instance there.
- **Editor `.mtlx` format:** `<materialx version="1.38" colorspace="workingspace" ...>` + the stdlib
  `xi:include` block + `<combinematerial name="USD_Default">` → shader `"Shader"`.
- **Bright vs dim is one input:** the editor's OWN bright materials set
  **`emissiveColor == diffuseColor`** (self-lit, lighting-independent); dim ones set emissive
  `(0,0,0)`. So make a `UsdPreviewSurface` bright by matching emissive to diffuse (`bright:true`),
  or use the **`ND__unlit_surfaceshader`** UNLIT path. This is the editor-grade fix for "baked mesh
  is dim" — no runtime material hacks.
- **Image textures on hand-authored materials still pack BLACK** (no cached material uses `<image>`).
  The proven textured path is `bake_textured_model` (GLB → baked PHYSICALLY_BASED + ASTC) or binding
  to an editor-authored material. An `author_materialx` `baseColorTexture` is **built-for-editor/headset,
  not emulator-verified**.

## 12. VISUAL GROUND TRUTH is mandatory — code/logcat prove existence, not appearance

**The absolute rule (the user enforces it; it has caught over-claims twice):** a feature is NOT
"verified" until an agent has **captured a frame and SEEN it render correctly** with its own vision.
`BUILD SUCCESSFUL`, `smoke Failures: 0`, and a scene-dump saying `entities=89` prove the thing
**exists in memory** — they do NOT prove a human would **see** it, or see it correct. Structural /
logcat proof is necessary but never sufficient. Treat "I didn't look" as "unverified."

- **The capture tool: `capture_frame`** → `adb exec-out screencap`. Headless, needs no macOS
  permission, returns the **clean composited immersive (HMD) view**, and is **byte-stable across
  repeated captures** (deterministic). This is the primary ground-truth path. Then READ the PNG and
  judge it.
- **Two cameras, don't confuse them (resolved 2026-06-14):** `adb exec-out screencap` = the guest's
  rendered framebuffer (the HMD view — shows gaze-placed content, clean, stable). The macOS host
  window capture (`screencapture -l<windowid>`, `picocap.sh`) = the qemu window: includes emulator
  UI chrome and can show a **decoupled free camera** that drifts. Prefer `adb screencap` for app
  content; use the host `screencapture` for the **Spatial Editor GUI** (which adb can't see).
- **What capture does NOT fix (the real frontier): viewpoint control.** The capture shows only the
  **forward** view; the emulator free camera can't be aimed headlessly (no GL-surface drug-drag from
  keystrokes — C2). So content outside the FOV (e.g. a pin ring surrounding the viewer) won't appear
  in one frame, and "looks empty" can mean "looking the wrong way", not "nothing rendered". To verify
  a whole scene you must either reposition content into the forward view, navigate the camera, or use
  a fixed-viewpoint path (ScenePreview `previewConfig` — unverified spike). A screenshot tool grounds
  *what's on screen*; it does not choose *where the camera looks*.
  - **Empirical (2026-06-15):** keystrokes (osascript `key code` WASD) do NOT move the camera (frame
    byte-identical after). `cliclick` is installed and `AXIsProcessTrusted` = true (the process CAN post
    mouse events — cursor warp works), but a left click-drag across the GL surface did NOT rotate the
    emulator camera either. So it's a GESTURE/tool question, not a permission one — untried: right/middle
    button drag, selecting a nav/orbit tool in the emulator UI first, or a modifier+drag. Treat camera
    rotation as UNSOLVED; prefer placing content in the forward FOV for visual checks.
- **Grade honestly with `capability_report`:** only `vision_verified` / `rendered_emulator` (you
  looked at a capture) count as visually verified; logcat/decoded/compiles are "EXISTS, appearance
  not confirmed".
