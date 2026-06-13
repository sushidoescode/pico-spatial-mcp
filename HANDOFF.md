# HANDOFF — PICO-MCP, for the next chat

**Read this AND the auto-memory `…/memory/pico-mcp-project.md` first.** The memory holds the deep,
verified findings (every wall, with how it was proven). This doc is the **strategic direction + the
concrete next plan**, decided with the user on 2026-06-13 at the end of a very long session that hit
my context limit.

---

## The decision (from the user)

**Park ClaimSight polishing. Build out the MCP's Spatial-Editor + Emulator control tooling first**, so
the agent can author and *verify* native spatial apps without hand-driving the GUI editor or guessing
at interactions. ClaimSight is the **test bed**, not the product. The user's exact challenge: *"be
thorough in building the tools for the MCP to shine, that way you will have more control over the app,
because it seems like you need it."* They're right — the agent kept hitting capability gaps that only
the editor GUI could cross.

## Why (the gaps that motivated this)

Building ClaimSight natively surfaced three MCP capability gaps:
1. **Colliders / physics — the current hard blocker.** To land pins on real surfaces you need a
   collider for `Scene.rayCast`. Creating one is blocked from app code (`CollisionComponent` ctor is
   Kotlin-`internal`; `ModelViewCollisionComponent` is package-private) AND from hand-authored USD
   (even the editor's EXACT `CollisionComponent` USD format → `rayCast` returns NO HIT). It needs the
   editor's physics bake (`.Library`/`.Component`/`.CacheData`) and/or a runtime physics-init step.
2. **Editor-authored materials/textures.** Image textures render black except on editor-authored
   materials. Worked around for flat UI (bake Compose→PNG, reuse the sky-sphere material on a quad —
   this WORKS, shipped), but it's a hack, not a general capability.
3. **Interactive verification.** The agent can't easily drive the emulator's controller trigger +
   head-gaze to TEST interactions (pin placement, button clicks). The user insists on
   verified-not-hallucinated results; the MCP needs real emulator-driving for end-to-end proof.

## Current state (all committed, all real)

- **MCP**: `/Users/sushantsrikrish/PICO-MCP`, v2.1.0, **61 tools**, `main` @ `4b7105c` (NOT pushed).
  `npm run build && npm run smoke` → `Failures: 0`. The pico MCP tools are NOT attached to the Claude
  Code session — drive build/install/capture via raw `gradlew`/`adb`/`screencapture`.
- **ClaimSight native app**: `~/AndroidStudioProjects/claimsight-native` (now git-tracked) @ `dff9e80`.
  Immersive STAGE (manifest `stage.style=3`) → decayed-apartment **skybox** + a **working in-world
  Compose-quality menu panel** (baked-texture quad — the breakthrough that unblocked stage UI) +
  `PinPlacer` raycast wiring. Looks great. BLOCKED only on pin-on-surface (no collider).
- Emulator booted (`emulator-5554`). Decompiled SDK at `/tmp/pico-sdk/{core,ui-foundation,ui-platform,
  tracking,foundation}/x` — ⚠ `/tmp` is ephemeral; re-extract from the AARs if gone (unzip the SDK
  `.aar`s → `classes.jar` → classes). JBR javap: `"/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javap"`.

## The build plan (be thorough — research → build → verify each tool)

### Phase 1 — RESEARCH (use an ultracode multi-agent Workflow; parallel decompile/investigate)
- **Physics/collision pipeline**: decompile `com.pico.spatial.core.ecs.CollisionComponent`,
  `ShapeResource.create{Box,StaticMesh,ConvexMesh}` (public), `Scene.rayCast`, and the physics module
  (`spatial.physics.internal.CollisionManagerAgent` appears in the editor binary). KEY QUESTIONS: does
  `Scene.rayCast` need a physics-system enable/init in the app? Is there ANY public path to register a
  collider at runtime? Why does the editor's exact collision USD not make `rayCast` hit?
- **Editor bake**: inspect what the editor wrote into `editor-asset/.../SpatialPackContent/.Library`,
  `.Component`, `.CacheData` when the user added a Collision component (it's there now), and whether/how
  `spatialbundle` consumes it. The editor's collision USD format IS known (in memory).
- **Editor/spatialbundle headless**: `~/Library/PICO/sdk/0.13/editor/spatialbundle/spatialbundle --help`
  (+ subcommands); can the Spatial Editor itself be scripted/CLI-driven to bake collision/materials?
- **Emulator interaction**: how to programmatically drive the controller trigger + head-gaze to TEST
  interactions (`controller_map`/`controller_press` exist; the GUI controller-button-mode; `gui_camera`
  WASD; trigger key mapping). Goal: headless end-to-end interaction verification.

### Phase 2 — BUILD MCP tools (each: implement → `npm run build && npm run smoke` → REAL verify)
- **`compose_collider`** (or extend scene authoring): produce a *working* collider for a mesh — via the
  correct USD + baked data, or by shelling the editor/spatialbundle to bake it. **Verify**: `Scene.rayCast`
  hits → debug-place a pin → screenshot it on a wall.
- **Emulator interaction-test tools**: drive controller trigger + gaze to exercise + verify app
  interactions, so the agent can PROVE pin placement / button clicks (not claim them).
- **(Stretch) editor-material/asset baking bridge** + general "editor operation" automation.

### Phase 3 — RESUME ClaimSight with the new tools
Finish pin-on-surface (collider) and the **menu-button interaction**: raycast the in-world menu quad
(known world position) from the gaze → map hit to button region → `Place Pin` arms → point at a wall +
trigger → pin commits on the surface. Verify end-to-end with the new interaction tools + screenshots,
then hand to the user to test + confirm.

## Verification discipline (non-negotiable — the user enforces it)
NEVER claim something works without proving it: build → install/launch → `gui_capture`/screenshot →
LOOK. For interactions, drive the input and screenshot the result. The user has caught hallucinated
"it works" claims (pins floating in space) — earn every claim with a capture. The user tests + confirms
before we proceed to the next thing.

## Key paths / commands
- App build: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ~/AndroidStudioProjects/claimsight-native/gradlew -p ~/AndroidStudioProjects/claimsight-native :app:assembleDebug`
- Launch: `adb -s emulator-5554 shell monkey -p com.example.claimsight -c android.intent.category.LAUNCHER 1`  (activity `.platform.LaunchActivity`)
- Capture the real 3D view: `/tmp/picocap.sh <out.png>` (Swift CGWindowList owner `qemu-system-aarch64` → `screencapture -l<id>`; Screen Recording granted). If gone, the logic is in `src/hostgui.ts`.
- UI panel bake: `~/AndroidStudioProjects/claimsight-native/tools/bake_ui.swift` (Compose design → PNG). GLB→USDZ: `tools/glb2usdz.py` (Blender at `/Applications/Blender.app/Contents/MacOS/Blender`).
- In-world UI recipe (works): bake PNG → in MyScene.usda reference `Sky Sphere.usdz` a 2nd time shrunk to a point + override its texture to the PNG → bind a flat `def Mesh` quad to that material. See memory + `MyScene.usda` `UIMatMenu`/`UITestPanel`.

## Commits to know
- claimsight-native: `0037005` (v2.1 stage), `d7fe440` (in-world UI breakthrough), `f90f770` (pre-collider clean), `dff9e80` (collision-format learning, current).
- PICO-MCP: `4b7105c` (v2.1.0, current main, not pushed).
