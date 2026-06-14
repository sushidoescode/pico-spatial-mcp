# HANDOFF — PICO-MCP, for the next chat

---
## ▶ NEXT SESSION STARTS HERE (2026-06-14, end of session 3)
**Paste `/Users/sushantsrikrish/PICO-MCP/V3.1_HANDOFF_PROMPT.md` into the next chat.** Then execute
**`V3.1_EXECUTION_GUIDE.md`** (step-by-step, written so a LOCAL model — Gemma 4 31B — can do it one small
verified task at a time; START at §2 TASK 1 = `generate_scene_understanding_kotlin`). Strategy is in
**`ROADMAP_v3.1-v4.0.md`**.

**The reframe that produced v3.1 (read this):** the user reality-checked v3.0 — the native app looked
unchanged, pins float, panels aren't interactive. Empirically proven: the native PICO **emulator cannot
verify the MR experience** (C1 no scene-understanding → 0 planes; C2 capture camera decoupled +
uncontrollable → no reliable headless screenshots; C3 no controller pointer / gated trigger → no clickable
panels; C4 stage-vs-window). v3.0's "verified" was code-level only. With **no hardware until the PICO
Swan (PICO OS6)**, v3.1→v4.0 pivots to mastering the **Spatial Editor ⇄ Emulator** toolchain + generating
the headset-only parts for Swan. **Honesty rule: never claim "renders/works" from a headless capture —
use logcat / "built for headset".** Mixed stage (manifest stage.style=1) DOES render the home env (the
sandbox `spatialdemo` proves it).

---
## 🎉 v3.0 SHIPPED (2026-06-14, session 3) — THE AUTONOMOUS SPATIAL STUDIO
**MCP @ 3.0.0 — 67 tools, 2 prompts — `npm run build && npm run smoke` → Failures: 0 — committed on `main`, NOT pushed.**

The mission is done: an agent can now **build AND verify** a native PICO XR app end-to-end on the
emulator (no headset). Three v3.0 deliverables landed:
1. **Rewrote the `autonomous_spatial_build` prompt** (`src/prompts.ts`) to drive the REAL proven loop:
   validate → scaffold → `bake_textured_model`/`generate_environment_kotlin` env → `generate_collider_kotlin`
   → `generate_spatial_ui` → `build_and_run` → **navigate camera (`gui_camera`) + `gui_capture` + `assert_logcat`
   verify** → `diagnose` → iterate, with all the gotchas (camera-drift, bake-not-runtime, mesh-colliders-don't-register) baked in.
2. **Demonstrated the loop end-to-end on a FRESH app** — `~/AndroidStudioProjects/spatialdemo-native`
   (pkg `com.example.spatialdemo`), assembled FROM the actual MCP tool outputs (invoked the real tool
   handlers via `/tmp/pico-invoke.mjs`, a fake-server harness) + minimal hand-glue. **Verified on
   emulator-5554**: logcat `baked textured mesh attached`, `rayCast HIT pos=(0,2.52,0.44) n=(0,0,-1)`,
   `placed pin #1/2/3`, `cleared 3/3 pins`; `gui_capture` (`/tmp/pico-render/demo-1-initial.png`) shows
   the textured Marble apartment rendering (dim — baked PBR is lit). The self-correcting loop also caught
   a REAL generator bug: `generate_spatial_ui` emitted `backgroundMaterial(Material.Thick)` (missing the
   Boolean first arg) → compile error → fixed `src/components.ts` to `backgroundMaterial(true, Material.Thick)`
   → regenerated → BUILD SUCCESSFUL.
3. **Docs + version**: README + ROADMAP → v3.0; `package.json` + `src/index.ts` → `3.0.0`.

**New gotchas this session (don't repeat):**
- A PRIOR spatial app can OWN the full-space stage and BLOCK your app from launching fullscreen
  (`current full space don't allow start fullscreen` / topResumedActivity = the other app). Fix:
  `adb shell am force-stop <other.pkg>` FIRST, then launch yours.
- The emulator free camera **cannot be reframed headlessly** on this host (no Quartz/pyobjc, no
  `cliclick`; System-Events click + WASD/arrow keys did NOT move it — it needs a real GL-surface
  mouse-drag to enter camera mode). So a pretty pin-on-wall capture wasn't obtainable — **lean on
  `assert_logcat`** as the proof primitive (which is exactly what the v3.0 prompt prescribes).

**ClaimSight menu gaze-interaction — DONE (claimsight-native commit `5bfb586`).** New `MenuRaycaster`
casts the head/controller gaze ray at the in-world menu quad (`UITestPanel` / baked `ui_menu.png`),
maps the hit UV to a button band (from `tools/bake_ui.swift`), and fires its action — wired into
PinPlacer's not-armed trigger path. The full loop closes: look at "Place Pin" + trigger → arm → look
at a wall + trigger → pin on the surface; "Generate Report" → report; etc. Verified on emulator-5554
via two headless hooks (the trigger is GUI-gated): `menusweep` mapped all 4 buttons + the title gap
correctly; `menufire 0..3` resolved each via the same hit-test + fired its action; menu→arm→commit →
`placed pin #1` on a wall. Hero capture `/tmp/pico-render/claimsight-menu-e2e.png` shows the textured
apartment + the in-world menu. **GOTCHA:** the emulator free camera (what `gui_capture` sees) and the
HMD tracking pose (what the gaze logic uses) are DECOUPLED — `menuaim` can MISS even when the menu is
on-screen; trust `menusweep`/`menufire` for the logic and the capture for rendering.

**NEXT (open frontier):** the deferred WindowContainer panel placement (DamageCard/Report spawn off
the default camera view in 0.13 — needs the platform window-transform API, ROADMAP §6.1); mesh
brightness (emissive/UNLIT `ND__unlit_surfaceshader`/IBL); collider-to-mesh alignment; on-headset
interactive testing; OR codify the menu-quad raycast as an MCP tool (`generate_menu_raycaster_kotlin`).

---
## ★ PROGRESS UPDATE (2026-06-13, session 2) — COLLIDER BLOCKER SOLVED + MCP @ v2.3.0
The #1 hard blocker (Phase-1/2 below) is **DONE and verified on the emulator**. Scene.rayCast now
hits and pins land on real surfaces. The fix was NOT the editor bake — it was a RUNTIME attach:
`PhysicsWorldComponent` on a scene entity (REQUIRED on-device) + a PRIMITIVE `CollisionComponent`
via `entity.components.set(...)`. The stale "CollisionComponent ctor is internal" belief (the real
multi-session blocker) was half-wrong: the **5-arg ctor is public**. `createStaticMesh` cooks
nothing queryable on-device → rooms use box "walls". Full detail in auto-memory
(`pico-mcp-project.md`, the ★ COLLIDER SOLVED note) + DESIGN.md §9.

**Shipped this session (all committed, smoke 0 failures):**
- PICO-MCP `main`: v2.2.0 `0b4bdb0` (generate_collider_kotlin + assert_logcat + raycast_no_hit
  diagnosis), v2.3.0 `cf2532b` (decode_spatial_bundle). NOT pushed.
- claimsight-native `530158b`: runtime box-room collider + real-rayCast PinPlacer.commit() +
  **restored skybox/UI texture overrides** the editor re-save had silently dropped (decayed-apartment
  skybox + in-world ClaimSight menu now render — verified via screencapture).
- Verification path FIXED: macOS `screencapture -l<windowid>` (and `gui_capture`) WORKS now that
  Screen Recording is granted; `adb screencap` shows the emulator reference scene, not the immersive
  view — use the window capture.

**RICH ENVIRONMENT (2026-06-13 s2, later):** The app loads the REAL Marble world as a **Gaussian
splat** (`.spz`, native PICO support) — `ENV_MODE="splat"` in HomeStage.kt (also "pano" reliable
fallback, "mesh" textured-GLB WIP/dark). Splat scaled 2.5x + Sky_Sphere pano scaled 20x = a BIGGER
WALKABLE, ENCLOSED room (no PICO-home bleed). The big gremlin that wasted hours: the **emulator free
camera DRIFTS out of the scene** (osascript WASD `W`=key13 forward / `S`=key1 back; persists across
relaunches) — ALWAYS navigate into the scene before judging a capture. Splat is live-tunable via the
`splat` broadcast cmd (tx/ty/tz/s/rx/ry/rz). Verified renders: /tmp/pico-render/{edge-fwd,splat-in}.png.
★★★ TEXTURED-MESH BREAKTHROUGH + MCP @ v2.7.0 (2026-06-13 s2, latest). The "GLB textures render black"
wall is CRACKED: BAKE the GLB via spatialbundle (it makes a PHYSICALLY_BASED material + ASTC texture),
then load the BAKED model — never runtime-load the raw GLB, never `references=@x.glb@` in USD. Verified
on emulator (the Marble apartment renders textured + sharp). Codified as MCP tool **bake_textured_model**
(v2.6.0) + generate_environment_kotlin texturedMesh emits the baked-bundle load; v2.7.0 added diagnose
**texture_black** (bake recipe) + **emulator_camera_drift** (navigate the camera into the scene before
judging a capture). MCP commits: dc12a8e (v2.6.0), 6ac20ca (v2.7.0). claimsight-native: ENV_MODE in
HomeStage.kt = "mesh" (baked apartment, default) | "splat" (3x photoreal) | "pano" | "home"; the baked
apartment.bundle ships in app/src/main/assets (commit c1e7900). USER DIRECTIVE: push the MCP to v3.0
(primary); ClaimSight is the test bed; use the simplest working env; if texture-embedding works (it does)
keep building the MCP. PATH TO v3.0 (next): (1) update the autonomous_spatial_build PROMPT (prompts.ts)
to orchestrate the full proven toolset — scaffold → bake_textured_model env → generate_collider_kotlin →
generate_spatial_ui → build_and_run → gui_camera(navigate-in)+gui_capture+assert_logcat verify →
diagnose → iterate; (2) demonstrate the end-to-end autonomous loop on a fresh app; (3) ROADMAP/README to
v3.0; (4) optional polish: mesh brightness (emissive/UNLIT), collider-to-mesh alignment, ClaimSight panel
placement (the deferred WindowContainer issue). The MCP capabilities for v3.0 are largely DONE this
session (collider, env splat+mesh+bake, broadcast interaction, assert_logcat, decode_bundle, diagnose).

RICH-ENV UPDATE (later 2026-06-13 s2): splat scaled **3x** = bigger walkable room (commit a3a26e6 on
claimsight-native; ENV_MODE="splat" default; proof /tmp/pico-render/splat3x.png). The user wants a
bigger/crisper/walkable room verified ON THE EMULATOR (no headset). **TEXTURED-MESH is BLOCKED** by the
embedded-texture wall (runtime swap -> black; spatialbundle bake -> "Failed to get material texture path"
because the texture is embedded in the .glb) — see memory ★ TEXTURED-MESH note. User chose "splat now +
mesh research in parallel". **Mesh-texture research workflow RUNNING (ww9o9r5ei / wf_d9351519-df6):**
crack rendering the textured apartment mesh via GLB->USD-external-texture + the editor-material-override
trick (the only proven textured-mesh path). When it lands: build the textured mesh room (sharp at any
scale + real geometry), THEN do collider alignment on the WINNING environment (don't tune splat colliders
first — likely throwaway if the mesh wins), THEN continue the MCP toward v3.0. CAMERA: the emulator free
camera drifts; navigate with osascript key code 13=W/forward, 1=S/back before judging captures.

**NEXT (toward v3.0):** (a) `drive_interaction` — resolve whether the controller trigger can be
fired headlessly (RC_Trigger='U' host key; research says GUI-gated, UNVERIFIED — test
`ui_input keyevent` / osascript 'U' vs the GUI Controller-Button-Mode); aim head-gaze via gui_camera
(WASD) + read HMD pose. (b) ClaimSight menu-button interaction: gaze-ray vs the in-world menu quad
→ arm Place Pin → trigger → commit on a wall (pin-on-surface already works; just wire the menu).
(c) Stretch: `author_collider` USD (low value — runtime attach is the working path); more
editor-understanding decoders. App-relaunch gotcha: 1st `am start` after `adb install -r` tears the
stage down; single clean `force-stop; am start` + poll logcat for app-live, then capture.
---


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
