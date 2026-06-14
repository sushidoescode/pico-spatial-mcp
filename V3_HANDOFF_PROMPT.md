# V3 HANDOFF PROMPT — paste this into a fresh chat

You are continuing the PICO-MCP project. **First, run `/effort ultracode`** (xhigh + dynamic workflow
orchestration), then read these in full before doing anything:
1. `/Users/sushantsrikrish/PICO-MCP/HANDOFF.md` (strategic state + the ★★★ breakthrough notes at the top)
2. the auto-memory `/Users/sushantsrikrish/.claude/projects/-Users-sushantsrikrish-PICO-MCP/memory/pico-mcp-project.md`
   (every verified fact + recipe + wall; read the ★/★★/★★★ notes especially)

## Mission
**Ship the PICO-MCP to v3.0 — the "autonomous spatial studio": an MCP that lets an AI agent build AND
verify native PICO XR spatial apps end-to-end, all on the EMULATOR (no headset).** ClaimSight is the test
bed, not the product. After v3.0 ships, resume polishing the ClaimSight native app.

Hard rules (the user enforces these):
- **Verify everything on the emulator with real captures/logcat — never hallucinate "it works".** When a
  capture looks wrong, suspect CAMERA POSITION first (navigate it into the scene), THEN content.
- Drive build/install/capture via raw `gradlew`/`adb`/`screencapture` (the pico MCP tools are NOT attached
  to the chat session). Keep `npm run build && npm run smoke` at 0 failures each MCP increment.
- For app edits, edit serially yourself; use read-only research **workflows** (ultracode) for investigation.

## Current state (all committed, NOT pushed)
- **MCP** `/Users/sushantsrikrish/PICO-MCP` @ **v2.7.0**, branch `main`, HEAD ~`8f94f89`. `npm run build &&
  npm run smoke` → Failures: 0. (dist/ is gitignored — build regenerates it.) Session added (all verified):
  `generate_collider_kotlin`, `assert_logcat`, `decode_spatial_bundle`, `app_broadcast`,
  `generate_environment_kotlin`, `bake_textured_model`, and diagnose symptoms `raycast_no_hit` /
  `texture_black` / `emulator_camera_drift`. DESIGN.md §9 = runtime physics colliders.
- **ClaimSight app** `~/AndroidStudioProjects/claimsight-native` @ ~`c1e7900`. `ENV_MODE` const in
  `app/.../content/HomeStage.kt` selects the environment: `"mesh"` (baked textured Marble apartment,
  DEFAULT, renders) | `"splat"` (3× photoreal Gaussian splat) | `"pano"` (360 backdrop) | `"home"` (PICO
  default env). Baked `apartment.bundle` ships in `app/src/main/assets`. Box-collider rig +
  adb-broadcast control + pin placement all wired.
- Emulator booted as `emulator-5554`.

## The proven recipes (DON'T re-derive — they're verified on-device this session)
- **Collider / Scene.rayCast:** set `PhysicsWorldComponent()` on the scene-root (REQUIRED on-device) +
  attach a PRIMITIVE `CollisionComponent(listOf(ShapeResource.createBox(fullExtents)), PhysicsMaterialResource(0.5f,0.5f,0f), COLLIDER_FULL, COLLISION_FILTER_DEFAULT, BRIEF)` via `entity.components.set(...)` on
  Dispatchers.Main. No RigidBody. `createBox` = FULL extents. **Mesh colliders do NOT register** → rooms use
  box "walls". (Tool: `generate_collider_kotlin`.)
- **Textured environment (the breakthrough):** **bake the GLB via spatialbundle** (`bake_textured_model` →
  PHYSICALLY_BASED material + ASTC texture), then **load the BAKED model** (`AssetBundle.load("asset://x.bundle")`
  + `Entity.loadSuspend("<stem>", bundle)`). NEVER runtime-load a raw GLB (renders black) and NEVER
  `prepend references=@x.glb@` in a USDA (USD has no glTF plugin → empty). `[Error] Failed to get material
  texture path` is non-fatal noise. Baked PBR is lit (may be dim → emissive/UNLIT/IBL).
- **Gaussian splat env:** `GaussianSplattingResource.load(path, LoadType.FROM_STORAGE)` (adb-push the .spz
  to the app external files dir; spatialbundle can't pack splats) + `GaussianSplattingComponent` (no-arg ctor
  + `gaussianSplattingResource =`). Marble frame needs `EulerAngles(0,180,0)`; scale up for a bigger room
  (blurs when scaled — splats are view-dependent). (Tool: `generate_environment_kotlin kind=splat`.)
- **Headless interaction:** `adb shell am broadcast -a com.example.claimsight.DEBUG_CMD --es cmd
  <arm|commit|select|report|clear|mute|demo|splat>` (+ `--ei arg N` / splat `--ei tx/ty/tz/s/rx/ry/rz`).
  The controller trigger is GUI-gated; this BroadcastReceiver is the headless drive path. (Tool: `app_broadcast`.)

## Key gotchas (cost hours this session — don't repeat)
- **Emulator free camera DRIFTS out of the scene and PERSISTS across relaunches.** Before judging ANY
  capture, navigate the camera into the scene: osascript `key code 13`='W'/forward, `1`='S'/back (Accessibility
  granted). The view is stable within a launch, varies across launches.
- **Visual capture:** `screencapture -x -o -l<qemu-windowid>` works (Screen Recording granted). Resolve the
  largest `qemu-system-aarch64` window via CGWindowList. `adb screencap` shows the emulator reference scene,
  NOT the app's immersive render. Window capture fails if the qemu window is fully occluded.
- **App relaunch:** the 1st `am start` after `adb install -r` can tear the stage down; do `am force-stop;
  sleep 2; am start -n com.example.claimsight/.platform.LaunchActivity` and poll logcat (`-s ClaimSightPin:V
  *:S`) for app-live before capturing.
- **SDK getter ambiguity:** methods with a `getX$annotations()` sibling are Kotlin properties (`.mesh`,
  `.size`, `.components`, `.materials`); those without are functions (`.getName()`, `.getChildren()`,
  `.getBoundingBox()`). Confirm with javap before writing Kotlin.

## Key paths / commands
- App build: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ~/AndroidStudioProjects/claimsight-native/gradlew -p ~/AndroidStudioProjects/claimsight-native :app:assembleDebug`
- adb: `/Users/sushantsrikrish/Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb` ; launch activity `.platform.LaunchActivity`
- spatialbundle: `~/Library/PICO/sdk/0.13/editor/spatialbundle/spatialbundle` (info/pack)
- javap: `"/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javap" -p -cp <CP> <fqcn>` ;
  decompiled SDK at `/tmp/pico-sdk/{core,foundation,tracking,ui-foundation,ui-platform,sense}/x` (⚠ /tmp is
  ephemeral — re-extract from the AAR classes.jars if gone). CP = those `x` dirs joined by `:`.
- Captures live in `/tmp/pico-render/`. Marble assets in `~/Marble Worlds/`.

## THE v3.0 TASK (execute, verifying each step on the emulator)
1. **Orchestration prompt** — rewrite `autonomous_spatial_build` in `src/prompts.ts` to drive the full proven
   loop: validate_toolchain → scaffold_spatial_app → bake_textured_model (or splat) env → generate_collider_kotlin
   → generate_spatial_ui → build_and_run → **navigate camera (gui_camera) + gui_capture + assert_logcat** verify
   → diagnose(symptom) → iterate. Bake in the gotchas above (camera-drift, bake-not-runtime, mesh-colliders-don't-register).
2. **Demonstrate the loop end-to-end** on a FRESH scaffolded app (not ClaimSight): scaffold → add a baked
   textured env + a box-collider room + a Compose panel → build → install → drive (broadcast + camera-nav) →
   capture proof it renders + a pin places. This end-to-end demonstration is the honest bar for calling it v3.0.
3. **Docs + version**: update ROADMAP.md + README.md to v3.0; bump index.ts + package.json to `3.0.0`; smoke green; commit.
4. **Optional polish** (after v3.0, or fold into ClaimSight resume): mesh brightness (emissive/UNLIT MaterialX
   `ND__unlit_surfaceshader`), collider-to-mesh-room alignment, ClaimSight panel placement (the deferred
   WindowContainer-off-camera issue, ROADMAP §6.1).

Then return to the ClaimSight test bed: finish menu→pin-on-surface→DamageCard/Report end-to-end in the
chosen environment, verified with captures.

Work in verified increments: research (workflow) when needed → build → install → drive → capture/logcat →
diagnose → iterate. Update memory + HANDOFF.md as you go. Don't claim done without a capture.
