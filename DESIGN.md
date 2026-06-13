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

Verified working (telemetry `WindowContainer_Planar`). Note: windows spawn at a default
placement (not necessarily in front); set `ContainerProperties.placement` (a
`PlacementContext -> Placement`, anchor-relative) to position them. Make the panel
@Composables `internal` so `Main.kt` can host them outside `HomeStage`.

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
