import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, image, okJson, run } from "./util.js";

/**
 * Self-diagnosis — the heart of v2.0. Two tools:
 *   - "diagnose": a knowledge base mapping a runtime SYMPTOM (white geometry,
 *     black environment, dead buttons, …) to its verified root cause, a concrete
 *     fix, the DESIGN.md rule it violates, and the tools to apply the fix. This
 *     encodes the project's hard-won gotchas so an agent can self-correct.
 *   - "design_review": captures the host-composited emulator GUI window (the only
 *     view of the immersive 3D scene), runs cheap dependency-free heuristics on the
 *     pixels (mean brightness / variance via sips downscale → BMP), and returns the
 *     image + a DESIGN.md rubric for the *vision-capable* driving agent to judge.
 *     The agent does the visual call; we provide capture + rubric + cheap flags.
 */

// ----------------------------------------------------------------------------
// 1) KNOWLEDGE BASE
// ----------------------------------------------------------------------------

interface DiagEntry {
  rootCause: string;
  fix: string[];
  designRule: string;
  relatedTools: string[];
}

const KB: Record<string, DiagEntry> = {
  compose_fork_conflict: {
    rootCause: "An AndroidX Compose artifact was resolved directly instead of through the PICO Spatial fork/BOM, or one of the required exclusions is missing.",
    fix: ["Remove the direct androidx.compose dependency.", "Keep all four required configurations.all exclusions and run verify_gradle_config for a read-only source check.", "Use verify_gradle_config with resolveTransitives:true only when you explicitly accept bounded Gradle resolution."],
    designRule: "Project configuration contract: PICO Compose fork exclusions.",
    relatedTools: ["verify_gradle_config", "preflight_lint"],
  },
  container_mode_mismatch: {
    rootCause: "Manifest metadata declares a Stage or WindowContainer family that does not match the Kotlin root container.",
    fix: ["Use DefaultStage with pico.spatial.stage.* metadata.", "Use DefaultWindowContainer with pico.spatial.windowcontainer.* metadata.", "Remove duplicate roots unless the project deliberately handles the ambiguity."],
    designRule: "Project configuration contract: metadata and root family must agree.",
    relatedTools: ["verify_gradle_config", "preflight_lint"],
  },
  white_geometry: {
    rootCause:
      "Geometry rendered flat white/unlit because it relies on `primvars:displayColor`, which the PICO runtime treats as a flat UNLIT white material. Color does NOT come from displayColor.",
    fix: [
      "Bind a real Material (UsdPreviewSurface) instead of using primvars:displayColor.",
      "Each colored prim needs `prepend apiSchemas = [\"MaterialBindingAPI\"]` and `rel material:binding = </Root/Materials/...>`.",
      "The Material's Shader must use `uniform token info:id = \"ND_UsdPreviewSurface_surfaceshader\"` with `color3f inputs:diffuseColor` (colorSpace=\"lin_srgb\").",
      "Add a small `inputs:emissiveColor` (~0.3x diffuse) so geometry reads brightly without depending on scene lighting.",
      "If you used compose_scene/compose_inspection_scene this is handled; if you hand-authored USDA, fix it there and re-pack.",
    ],
    designRule: "DESIGN.md §1 (Color requires MATERIALS, never displayColor)",
    relatedTools: ["compose_scene", "compose_inspection_scene", "verify_scene", "pack_bundle"],
  },

  invisible_geometry: {
    rootCause:
      "Geometry is either off-camera (wrong coordinates / its own coordinate frame) or has no bound material so it does not render. A referenced collider mesh often sits in its own frame far from the room origin.",
    fix: [
      "Run verify_scene to confirm geometry + material COUNTS — if counts are 0 the prim isn't composing.",
      "Check coordinates against the environment: for a w×h×d room centered at origin, walls are at ±w/2 / ±d/2, floor y=0, ceiling y=h. Put prims where the camera can see them.",
      "Use a TEXTURED mesh export, not an untextured collider (colliders render dark and are usually off-camera in their own frame).",
      "Ensure every visible prim has a bound Material (see white_geometry / DESIGN.md §1).",
      "Move the head with gui_camera (WASD) and re-capture to rule out the prim merely being behind/beside you.",
    ],
    designRule: "DESIGN.md §2 (referenced models must be textured) + §3 (place on actual coordinates)",
    relatedTools: ["verify_scene", "gui_capture", "gui_camera", "compose_inspection_scene"],
  },

  black_environment: {
    rootCause:
      "A hand-authored image-texture material was used for the environment. Such materials DO NOT PACK in this runtime — the texture is dropped and the surface renders black. GLB/USDZ mesh textures also render black here.",
    fix: [
      "Do NOT author a fresh image material for the environment; it will pack black.",
      "Instead override a WORKING editor-authored sky-sphere mesh's texture node: `over \"_materials\" { over \"...\" { over \"...\" { asset inputs:file = @../Assets/pano.png@ } } }`.",
      "Use compose_inspection_scene environment={type:'skybox', asset:'pano.png'} which does this override for you.",
      "Use a 360° equirectangular image (e.g. a World Labs Marble panorama export) as the skybox texture.",
      "A skybox also fixes 'falling out' of a finite room (DESIGN.md §6).",
    ],
    designRule: "DESIGN.md §1b (skybox = override a working sky-sphere's texture)",
    relatedTools: ["compose_inspection_scene", "import_environment", "verify_scene", "gui_capture"],
  },

  texture_black: {
    rootCause:
      "A textured mesh renders BLACK. CORRECTED (2026-06-13): this is the RUNTIME path, not a fundamental limit. Causes: (1) runtime-loading a raw GLB (Entity.loadSuspend(File(glb)) + a swapped PhysicallyBasedMaterial) — gltfio's async texture loader is never driven, so the sampler is unbound → black; (2) `prepend references=@x.glb@` inside a USDA — USD has no glTF plugin, so the mesh/texture never packs (empty). A spatialbundle-BAKED model renders textured fine.",
    fix: [
      "BAKE the model: use bake_textured_model (modelPath=<your .glb/.usd>, outBundle=app/src/main/assets/<name>.bundle). spatialbundle bakes a PHYSICALLY_BASED material + ASTC texture. The '[Error] Failed to get material texture path' log is NON-FATAL noise.",
      "Load the BAKED model, not the raw GLB: AssetBundle.load(\"asset://<name>.bundle\") then Entity.loadSuspend(\"<modelName>\", bundle). modelName = the file stem (bake_textured_model returns it). Renders textured, sharp, any scale.",
      "NEVER reference a GLB inside a USDA. Pack the GLB as a top-level scene file (bake_textured_model does this), or convert GLB→USD(C/Z) first (Blender wm.usd_export).",
      "Use generate_environment_kotlin(kind='texturedMesh') to emit the baked-bundle load code. For 360°/equirect imagery the skybox texture-override is still the simplest (DESIGN.md §1b).",
      "If still dark (not black): the baked PHYSICALLY_BASED material is lit — connect emissive / use the UNLIT MaterialX nodedef / add scene IBL.",
    ],
    designRule: "DESIGN.md §9 (textured meshes: BAKE via spatialbundle, load the baked model — never runtime-load raw GLB or reference GLB in USD)",
    relatedTools: ["bake_textured_model", "generate_environment_kotlin", "decode_spatial_bundle", "pack_bundle"],
  },

  emulator_camera_drift: {
    rootCause:
      "An emulator screenshot looks wrong (blob / black / the PICO home bedroom / a white shell) even though the app is healthy and logcat shows the scene/colliders/env loaded. The emulator's FREE CAMERA has drifted OUT of the app's scene (WASD nav pushes it into the home-env area; it PERSISTS across app relaunches). You are photographing the scene from outside it.",
    fix: [
      "BEFORE concluding anything from a capture, navigate the camera back INTO the scene with gui_camera(keys=['s', ...]) — it sends WASD keystrokes (W=forward, S=back; arrows look), e.g. send 's' ~10x to return from a forward-drift. (gui_camera needs Accessibility AND the emulator already in camera mode, entered by a mouse-drag in the window — if you cannot reframe headlessly, lean on assert_logcat for proof.)",
      "The view is stable WITHIN a launch but the camera pose varies ACROSS launches — re-center after each relaunch.",
      "CAPTURE PATH (corrected 2026-07-29 — measured, ledger pico-emulator-capture-paths seq 0): adb screencap (capture_frame) captures the SHELL composite — home env, 2D panels, native Spatial SDK apps — and is byte-deterministic; the qemu GUI window (gui_capture) is the FREE-CAM view that drifts across launches. BUT adb screencap returns BLACK for XR-RUNTIME immersive apps (Unity OpenXR SDK and Unity Integration SDK alike: Unity logs 'Skip Present To Main Screen: Yes' — it is presenting to the XR display, not the Android surface screencap reads). For an immersive Unity/OpenXR app, gui_capture is the ONLY path that shows the content, and a black screencap there is a capture artifact, NOT a rendering failure.",
      "Rule of thumb: when a capture looks wrong, suspect CAMERA POSITION first, then content. This single mistake caused hours of false 'it's broken' conclusions.",
    ],
    designRule: "DESIGN.md §8 (verify visually — but navigate the camera into the scene first)",
    relatedTools: ["gui_camera", "gui_capture", "assert_logcat", "build_and_run"],
  },

  tiny_panels: {
    rootCause:
      "Spatial Compose panels are sized in dp which maps to PHYSICAL size; a small panel (e.g. 560 dp) placed far away (2 m+) reads tiny and unreadable.",
    fix: [
      "Make panels large: 800–900 dp.",
      "Use big fonts: 18–40 sp.",
      "Place panels CLOSE: 1.3–1.6 m from the user.",
      "Re-capture with gui_capture after resizing to confirm readability.",
    ],
    designRule: "DESIGN.md §4 (spatial UI = Compose panels, sized for distance)",
    relatedTools: ["compose_inspection_scene", "iterate_scene", "gui_capture", "build_and_run"],
  },

  dead_buttons: {
    rootCause:
      "A static Box+Text does nothing — it isn't interactive. The runtime maps the controller ray to Compose pointer events, but only elements with a clickable modifier receive them.",
    fix: [
      "Use `Modifier.clickable { }` on the element (or a real `Button`) so onClick fires when the user points + triggers.",
      "Make the hit target large enough to aim at (tie to DESIGN.md §4 panel sizing).",
      "Confirm the panel itself is an AttachmentPanel rendered in 3D, not just drawn content.",
      "Test the interaction path with controller_press / the controller ray, then re-capture.",
    ],
    designRule: "DESIGN.md §4 (interactive elements must be actually clickable)",
    relatedTools: ["compose_inspection_scene", "controller_press", "controller_map", "iterate_scene"],
  },

  random_pins: {
    rootCause:
      "Placement is ungated. The raw controller `triggerPressed` fires constantly during normal use, so committing on every trigger press scatters pins everywhere.",
    fix: [
      "Never place/commit on every trigger press.",
      "Gate placement behind an explicit ARMED mode (a 'Place Pin' toggle) and a 'Commit' action; treat triggerPressed as a commit signal ONLY while armed.",
      "Provide a button-driven path (works in the emulator with no 6DOF controller pose) plus the controller-ray path for real headsets.",
      "Add a 'Clear All' button to recover from accidental placements.",
    ],
    designRule: "DESIGN.md §5 (interaction is intentional — never automatic)",
    relatedTools: ["compose_inspection_scene", "iterate_scene", "controller_press"],
  },

  pins_hovering: {
    rootCause:
      "A marker is oriented to the surface normal but is NOT actually AT the surface coordinate, so it floats mid-air instead of sticking.",
    fix: [
      "Place the marker at the real surface coordinate, not just oriented toward it.",
      "For a w×h×d room centered at origin: walls at ±w/2 / ±d/2, ceiling at y=h, floor at y=0. A ceiling marker belongs at y≈h-0.08, not mid-air.",
      "Use compose_inspection_scene's `surface` field to orient local +Y to the surface normal AND set the position on that surface.",
      "When aiming with the head ray, intersect the room AABB and snap the marker to the hit point + inward normal.",
    ],
    designRule: "DESIGN.md §3 (place markers on actual surface coordinates) + §1c (aim with head pose)",
    relatedTools: ["compose_inspection_scene", "verify_scene", "gui_capture", "xr_set_head_pose"],
  },

  falling_out: {
    rootCause:
      "The environment is a small finite procedural room (a box). With stage style 3 (Full), moving past its walls reveals the system environment because there is nothing enclosing the user out there. This symptom CANNOT occur in Mixed (stage style 1, the default): the passthrough home environment always encloses the user — falling_out is specific to the Full-Space (style 3) opt-in.",
    fix: [
      "Make the environment large/enveloping, or use a skybox sphere which surrounds the user everywhere.",
      "compose_inspection_scene environment={type:'skybox', asset:'pano.png'} guarantees a consistent backdrop and also fixes black environments (DESIGN.md §1b).",
      "On a headset the user stands in place; the emulator's free WASD camera can roam, so a skybox is the robust choice.",
      "If you must keep a room, make it big enough that the camera stays inside during review.",
    ],
    designRule: "DESIGN.md §6 (stage style + keeping the user inside)",
    relatedTools: ["compose_inspection_scene", "import_environment", "gui_capture", "gui_camera"],
  },

  build_failed: {
    rootCause:
      "The Gradle build failed. A common environment cause is that there is no `java` on PATH, so Gradle cannot find a JDK; other causes are USDA/bundle pack errors or app compile errors.",
    fix: [
      "There is no `java` on PATH in this setup — the build tools must supply JAVA_HOME via detectJavaHome()/gradleEnv(); use gradle_build / build_spatial_project which wire this, do not invoke gradle bare.",
      "Re-run validate_toolchain to confirm the tools root, JDK, adb, and license acceptance.",
      "Read the build output tail for the first error; pack errors usually mean malformed USDA (verify_scene first).",
      "Fix the reported error, re-pack the bundle, then build_and_run.",
    ],
    designRule: "DESIGN.md §8 (verify structurally; build_and_run confirms a frame rendered)",
    relatedTools: ["validate_toolchain", "gradle_build", "build_spatial_project", "build_and_run", "verify_scene"],
  },

  not_rendering: {
    rootCause:
      "The scene did not build/attach, OR the free camera is aimed away from the content, OR the content is unlit/off-view. NOTE: adb exec-out screencap (capture_frame / capture_canonical) DOES return the composited immersive forward view and is byte-deterministic (MAE=0 across relaunch) — it is the visual ground truth the whole v5–v9 vision-verified pipeline uses. (The GUI-window free-cam is the DRIFTING view.)",
    fix: [
      "Capture the forward view with capture_frame at the node's forward-FOV pose — this is the deterministic immersive render. If it's black, the content is off-view or unlit, not 'invisible'.",
      "Keep hero content at EYE LEVEL (y≈1.3, z≈-2.7 to -3.3) so the default forward capture frames it without touching the free cam. Panels spawn at the dock — turn the camera (emulator_look) to see those.",
      "Confirm the scene was built on Dispatchers.Main AFTER the scene loaded, and a lighting rig was applied (unlit PBR reads near-black).",
      "Run build_and_run to confirm a frame rendered and the app did not crash (check_crash / logcat for a stack trace).",
    ],
    designRule: "DESIGN.md §8 (verify visually AND structurally) — capture_frame is the deterministic immersive view; the GUI free-cam drifts",
    relatedTools: ["gui_capture", "gui_find_window", "build_and_run", "check_crash", "logcat"],
  },

  no_controller_pose: {
    rootCause:
      "The emulator provides NO 6DOF controller pose (ControllerTrackingProvider.latestData.right is null). It DOES provide the head pose (HMDTrackingProvider.latestData.hmdPose, moved by WASD). There are also no passthrough cameras in the emulator.",
    fix: [
      "Aim with the HEAD pose, not the controller: cast the head's forward ray (pose.rotation.rotateVector(Vector3.FORWARD)) against the room AABB to get a hit point + inward normal.",
      "Move the head via WASD using gui_camera (or xr_set_head_pose); the controller can't be posed in the emulator.",
      "Design a BUTTON-driven interaction path that works without aiming for the emulator, plus a controller-ray path for real headsets.",
      "Do not depend on controller 6DOF or passthrough in emulator testing.",
    ],
    designRule: "DESIGN.md §1c (aim with the head pose, not the controller) + §5",
    relatedTools: ["gui_camera", "xr_set_head_pose", "xr_input_status", "controller_press"],
  },

  raycast_no_hit: {
    rootCause:
      "Scene.rayCast returns no results. On-device causes (verified 2026-06-13): (1) NO PhysicsWorldComponent on the scene root — without it, colliders register in the SceneInspector but the queryable PhysX world is empty and rayCast returns 0 hits; (2) the collider was authored in USD — the runtime never turns USD CollisionComponent prims into live query actors; (3) a StaticMesh/ConvexMesh collider was used — mesh colliders from a loaded render mesh cook NO queryable triangles on-device (only primitives register); (4) the ray points away from the geometry or origin/units are wrong.",
    fix: [
      "Set a PhysicsWorldComponent on the scene-root entity ONCE on Dispatchers.Main: root.components.set(PhysicsWorldComponent()). This is REQUIRED on-device even though the desktop editor auto-creates the world.",
      "Attach colliders at RUNTIME, not in USD: build a PRIMITIVE shape (ShapeResource.createBox(fullExtents) / createSphere / createCapsule), then CollisionComponent(listOf(shape), PhysicsMaterialResource(0.5f,0.5f,0f), CollisionResponseMode.COLLIDER_FULL, CollisionFilter.COLLISION_FILTER_DEFAULT, CollisionInfoDetailLevel.BRIEF), then entity.components.set(collision). The 5-arg ctor is the public one; no RigidBody is needed for a static collider.",
      "Do NOT use createStaticMesh/createConvexMesh for room/world geometry — they register nothing queryable on-device. Model a room as 6 thin box 'walls' at the room AABB; model props as box/sphere/capsule.",
      "createBox takes FULL extents (a Vector3(1,1,1) box has faces at +-0.5). Place the collider entity at the world position of the surface.",
      "Use generate_collider_kotlin to emit the entire verified recipe (PhysicsWorldComponent + primitive colliders + a rayCast helper). VERIFY with assert_logcat for your own 'rayCast HIT' log line.",
    ],
    designRule: "DESIGN.md §3 (surfaces need a real collider) + §9 (runtime physics: PhysicsWorldComponent + primitive CollisionComponent; USD/mesh colliders do not register)",
    relatedTools: ["generate_collider_kotlin", "assert_logcat", "build_and_run", "logcat"],
  },

  physics_not_simulating: {
    rootCause:
      "A DYNAMIC rigid body won't move / falls through geometry / launches into the void. REAL rigid-body physics DOES simulate on the emulator (v8.8, vision-verified: a thrown ball strikes pins) — the failure is almost always an adapter-rule violation, not 'physics is headset-gated'. Causes: (1) the body's components were set across multiple frames (staged) instead of ONE batch — collision pairing is lost; (2) an individual live body was destroy+respawned (loses pairing) OR a physics-world root was destroyed (POISONS every physics world built later in-process — R3); (3) a live body was teleported (a TransformComponent set on a dynamic body is read as motion: jump/timestep becomes velocity — a meter jump launches it through the floor; kinematic mode flips are silent no-ops); (4) CollisionDetectionMode.CONTINUOUS was set (kills dynamic-vs-dynamic contacts — the ball glides through pins); (5) a velocity was set on a settled/sleeping body (ignored) or read back too soon (~2s engine batch epochs — a set velocity fires the NEXT epoch, and read-backs lag ~2s).",
    fix: [
      "Create every body with ALL components (Transform+Collision+RigidBody+Model) in ONE batch at scene build — generate_rigidbody_kotlin does this.",
      "NEVER destroy+respawn an individual live body, and NEVER destroy a tree containing a PhysicsWorldComponent. To reset a physics scene: disable the old game root (oldRoot.enabled = false) and rebuild a fresh one ~3s later — ScenePhysics.resetWorld().",
      "To throw/move a body use a cm-scale nudge + PhysicsVelocityComponent (ScenePhysics.launch), NOT a large TransformComponent teleport. Expect a ~2s beat before it moves (batch epoch); trust the visual frame, not the lagged read-back.",
      "Keep DISCRETE collision (the default) — do not set CollisionDetectionMode.CONTINUOUS.",
      "The lint rules physics-destroy-respawn / physics-kinematic-flip / physics-ccd-continuous catch these before build (preflight_lint). Verify the strike with capture_frame (before/after).",
    ],
    designRule: "aaa-fidelity-emulator memory §PHYSICS ADAPTER RULES R1-R5 (examples/BowlingGame.kt); DESIGN.md §9b",
    relatedTools: ["generate_rigidbody_kotlin", "preflight_lint", "capture_frame", "build_and_run"],
  },

  launch_blocked: {
    rootCause:
      "build_and_run reports launch ok but check_crash shows processAlive:false with crashCount:0 — NOT an app crash. A stale foreground activity (e.g. a leftover browser/WebXR or another spatial app the shell 'kept for the user') silently blocks the new activity start; adb prints only a quiet warning. Found by the P1 cold-run: this strands users who don't know adb.",
    fix: [
      "Inspect the foreground: adb shell dumpsys activity activities | grep topResumedActivity — if it's NOT your package, something is blocking the launch.",
      "Force-stop the blocker (adb shell am force-stop <blocking.package>), then relaunch YOUR app with a clean start: adb shell am start -S -n <pkg>/.platform.LaunchActivity (-S force-stops your own stale task first).",
      "Confirm with adb shell pidof <pkg> (a live PID) + the app's ready log line before trusting any capture.",
      "If it recurs across runs, force-stop known blockers (com.picoxr.browser, other com.example.* apps) before every launch — fleet_build and the acceptance loops do this.",
      "ESCALATION (v27-pre first-light): if force-stopping every app still leaves 'Activity not started… kept for the user' + an empty pidof for ALL packages, the shell's ContainerManager is wedged — cold-restart the emulator (scripts/restart-emulator.sh) and relaunch; recalibrate the capture camera afterwards if you need pico_measure.",
    ],
    designRule: "DRY_RUN.md cold-run log #4 (2026-07-06)",
    relatedTools: ["build_and_run", "check_crash", "logcat"],
  },
  emu_focus_wedge: {
    rootCause:
      "EVERY spatial-app launch ANRs with 'Input dispatching timed out ... Waited 5000ms for FocusEvent(hasFocus=true)' — after a long emulator session (many installs/launches/reboots), the emulator's window-focus subsystem degrades so the LaunchActivity can't acquire focus in time. BISECT-PROVEN environmental: the bare app with all scene content removed ANRs identically, and it persists across `adb reboot`. NOT caused by scene complexity / entity count / your code. Found chasing a set-dressing ANR (2026-07-08).",
    fix: [
      "FALSE-POSITIVE WARNING (learned 2026-07-08): `dumpsys activity | grep 'not responding'` reports the LAST-EVER ANR record, which PERSISTS after the dialog is gone — it is NOT proof of a live dialog. VERIFY by LOOKING at a capture (is a grey rounded dialog actually on screen?) or `dumpsys window | grep -i mCurrentFocus`. A fresh cold boot clears the live dialog even though the stale record remains.",
      "PROVE it's environmental before touching your app: strip the scene to bare (or launch a DIFFERENT known-good spatial app) — if that ANRs too, it's the emulator/launch, not your scene.",
      "adb reboot is INSUFFICIENT. Remedy = COLD-restart the emulator PROCESS: run scripts/restart-emulator.sh (kills qemu + relaunches with ANDROID_AVD_HOME=~/.pico/avd, ANDROID_SDK_ROOT=~/Library/PICO/sdk/0.13/emulator/system-images, and explicit -sysdir/-kernel because the AVD sysdir.1 is oddly relative and SDK-root inference fails outside the PICO app wrapper).",
      "The app itself keeps running behind the ANR dialog (pidof shows a live PID, the scene renders + animates) — the dialog is a focus-delivery artifact, not a crash. For an unattended capture, treat a persistent FocusEvent ANR as 'restart the emulator', not 'fix the app'.",
    ],
    designRule: "the honesty invariant: distinguish an ENVIRONMENTAL emulator fault from an app defect by bisection before attributing blame",
    relatedTools: ["verify_pico_apk", "build_and_run", "capture_rig"],
  },
  frozen_viewport: {
    rootCause:
      "screencap returns BYTE-IDENTICAL frames across seconds while an ANIMATED stage-3 scene is live (container visible:true, immersion=100, an animation loop logging) — the emulator's 2D viewport MIRROR froze (compositor wedge after heavy app churn: many installs/launches/panels in one session). The spatial scene keeps running; screencap serves a stale frame (often the home env), so every capture-based check silently lies. Found by the Neon Strike Alley build (2026-07-07).",
    fix: [
      "Detect: take 2 screencaps ~3s apart on a scene you KNOW animates and compare md5 — identical bytes = the frozen mirror (an animated scene never produces identical frames).",
      "Cross-check the scene is actually live before blaming the app: dumpsys shows the stage container visible:true + your animation/scene log lines still ticking.",
      "Remedy: adb reboot (wait for sys.boot_completed=1, ~60s, + ~20s settle), then relaunch the app. Do NOT keep iterating on the app — the captures are stale, not the scene.",
      "Bonus: after a reboot+relaunch the emulator free-cam is RESET — the fresh-launch pose usually frames eye-level content perfectly (use capture_rig normalize:false to sweep gently around it instead of hard-recovering away from it).",
    ],
    designRule: "the honesty invariant: a capture pipeline that can freeze must be self-checked before captures are trusted",
    relatedTools: ["capture_frame", "capture_rig", "fidelity_score"],
  },
};

// ----------------------------------------------------------------------------
// 2) DESIGN-REVIEW HELPERS (host GUI capture + cheap heuristics)
// ----------------------------------------------------------------------------

const EMU_OWNER = "qemu-system-aarch64";

interface Win {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Enumerate the emulator's on-screen windows via CoreGraphics (Swift one-liner),
 * exactly as gui_capture does. Needs no special permission.
 */
function listEmulatorWindows(): Win[] {
  const swift = `
import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let wl = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
  for w in wl {
    let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
    if owner == "${EMU_OWNER}" {
      let wid = (w[kCGWindowNumber as String] as? Int) ?? 0
      let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
      print("\\(wid) \\(Int((b["X"] as? Double) ?? 0)) \\(Int((b["Y"] as? Double) ?? 0)) \\(Int((b["Width"] as? Double) ?? 0)) \\(Int((b["Height"] as? Double) ?? 0))")
    }
  }
}`;
  const tmp = path.join(os.tmpdir(), `pico-review-winlist-${process.pid}.swift`);
  fs.writeFileSync(tmp, swift);
  try {
    const out = execFileSync("swift", [tmp], { timeout: 60_000, encoding: "utf8" });
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.trim().split(/\s+/).map(Number))
      .map(([id, x, y, w, h]) => ({ id, x, y, w, h }))
      .filter((win) => win.w > 0 && win.h > 0);
  } catch (e: any) {
    throw new Error(`window enumeration failed (is Xcode CLT installed? 'swift' on PATH?): ${e.message}`);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/** The main display window is the largest by area. */
function mainWindow(wins: Win[]): Win | null {
  if (!wins.length) return null;
  return [...wins].sort((a, b) => b.w * b.h - a.w * a.h)[0];
}

const PERM_HINT =
  "Grant Screen Recording to the app running this server (Terminal/iTerm/your IDE) in System Settings > Privacy & Security > Screen Recording, then fully restart that app.";

interface Heuristics {
  // 0..255 mean luminance over a small downsampled grid.
  meanBrightness: number;
  // 0..255-ish spatial std-dev of luminance across cells (variety / contrast proxy).
  brightnessStdDev: number;
  // Mean per-channel spread |max(r,g,b)-min(r,g,b)| — low => grayscale/monochrome.
  meanChroma: number;
  grid: string; // e.g. "6x6"
  // Cheap derived flags. Honest, conservative; the vision-capable agent makes the real call.
  flags: string[];
}

/**
 * Dependency-free pixel sampling: downscale the PNG to a tiny grid with `sips`,
 * convert to an uncompressed 32bpp BMP (sips writes a clean header where bytes
 * 10–13 = pixel-data offset), then parse the BGRA cells ourselves.
 *
 * LIMITS (be honest): this is a coarse global summary of a few cells, not real
 * scene understanding. It reliably catches "all black" (env didn't pack) and
 * "all flat white" (displayColor / no materials), and flags "no color variety".
 * It CANNOT tell whether panels are readable, pins are on surfaces, or buttons
 * are clickable — those are for the vision-capable agent against the rubric.
 * Returns null if sips/parse is unreliable so callers fall back to image+rubric.
 */
async function computeHeuristics(pngPath: string, gridN = 6): Promise<Heuristics | null> {
  const base = path.join(os.tmpdir(), "pico-mcp");
  fs.mkdirSync(base, { recursive: true });
  const small = path.join(base, `review-small-${Date.now()}.png`);
  const bmp = path.join(base, `review-small-${Date.now()}.bmp`);
  try {
    const ds = await run("sips", ["-z", String(gridN), String(gridN), pngPath, "--out", small], { timeoutMs: 20_000 });
    if (ds.code !== 0 || !fs.existsSync(small)) return null;
    const conv = await run("sips", ["-s", "format", "bmp", small, "--out", bmp], { timeoutMs: 20_000 });
    if (conv.code !== 0 || !fs.existsSync(bmp)) return null;

    const d = fs.readFileSync(bmp);
    if (d.length < 54 || d[0] !== 0x42 || d[1] !== 0x4d) return null; // "BM"
    const pixOff = d.readUInt32LE(10);
    const w = d.readInt32LE(18);
    const h = d.readInt32LE(22);
    const bpp = d.readUInt16LE(28);
    if (bpp !== 32 || w <= 0 || h === 0) return null; // only handle the 32bpp form sips emits
    const absH = Math.abs(h);
    const rowBytes = (((bpp * w + 31) / 32) | 0) * 4; // 4-byte aligned stride

    const lums: number[] = [];
    const chromas: number[] = [];
    for (let ry = 0; ry < absH; ry++) {
      const rowStart = pixOff + ry * rowBytes;
      if (rowStart + w * 4 > d.length) return null;
      for (let cx = 0; cx < w; cx++) {
        const p = rowStart + cx * 4;
        const b = d[p];
        const g = d[p + 1];
        const r = d[p + 2];
        // Rec.601 luma.
        lums.push(0.299 * r + 0.587 * g + 0.114 * b);
        chromas.push(Math.max(r, g, b) - Math.min(r, g, b));
      }
    }
    if (!lums.length) return null;

    const mean = lums.reduce((a, v) => a + v, 0) / lums.length;
    const variance = lums.reduce((a, v) => a + (v - mean) * (v - mean), 0) / lums.length;
    const std = Math.sqrt(variance);
    const meanChroma = chromas.reduce((a, v) => a + v, 0) / chromas.length;

    const flags: string[] = [];
    if (mean < 14 && std < 8) {
      flags.push(
        "VERY_DARK: scene reads near-black & flat — likely a black environment (texture didn't pack). See diagnose symptom=black_environment (DESIGN.md §1b).",
      );
    }
    if (mean > 235 && std < 10) {
      flags.push(
        "VERY_WHITE_FLAT: scene reads near-white & flat — likely unlit/displayColor geometry. See diagnose symptom=white_geometry (DESIGN.md §1).",
      );
    }
    if (std < 6) {
      flags.push("LOW_CONTRAST: little spatial variation — scene may be empty/off-camera or not rendering (symptom=not_rendering / invisible_geometry).");
    }
    if (meanChroma < 6 && mean >= 14 && mean <= 235) {
      flags.push("LOW_COLOR: almost no color variety (near-grayscale) — check materials are bound, not displayColor (DESIGN.md §1).");
    }

    return {
      meanBrightness: Math.round(mean * 10) / 10,
      brightnessStdDev: Math.round(std * 10) / 10,
      meanChroma: Math.round(meanChroma * 10) / 10,
      grid: `${w}x${absH}`,
      flags,
    };
  } catch {
    return null; // heuristic is best-effort; never block the review on it
  } finally {
    for (const f of [small, bmp]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}

const REVIEW_CHECKLIST: Array<{ check: string; rule: string }> = [
  { check: "Geometry is COLORED (not flat white). White => displayColor instead of bound Materials.", rule: "DESIGN.md §1" },
  { check: "Environment is VISIBLE (not black). Black => image material didn't pack; use a skybox texture override.", rule: "DESIGN.md §1b" },
  { check: "Intended geometry is ON-CAMERA (not invisible/off in its own frame).", rule: "DESIGN.md §2/§3" },
  { check: "Panels are LARGE & READABLE (800–900 dp, 18–40 sp, placed 1.3–1.6 m). Tiny text => resize/move closer.", rule: "DESIGN.md §4" },
  { check: "Content is FRAMED in view (the camera is actually looking at the scene; move head with gui_camera if not).", rule: "DESIGN.md §8" },
  { check: "Interactive elements look CLICKABLE (real Button / Modifier.clickable), not static Box+Text.", rule: "DESIGN.md §4" },
  { check: "Interaction is GATED (armed Place/Commit mode), not pins scattered everywhere from raw trigger presses.", rule: "DESIGN.md §5" },
  { check: "Pins/markers sit ON their surface (at the surface coordinate), not hovering mid-air.", rule: "DESIGN.md §3" },
  { check: "User stays INSIDE the environment (large room or skybox), not falling out past finite walls.", rule: "DESIGN.md §6" },
];

// ----------------------------------------------------------------------------
// REGISTRATION
// ----------------------------------------------------------------------------

export function registerDiagnoseTools(server: McpServer) {
  server.registerTool(
    "diagnose",
    {
      description:
        "Self-diagnosis knowledge base: given a SYMPTOM you observe in the PICO spatial runtime (white/invisible geometry, black/black-textured environment, tiny panels, dead buttons, scattered/hovering pins, falling out of the room, build failures, nothing rendering, no controller pose, Scene.rayCast returning no hit), returns the verified root cause, concrete fix steps, the DESIGN.md rule it violates, and the tools to apply the fix. Use this to self-correct instead of guessing.",
      inputSchema: {
        symptom: z
          .enum([
            "white_geometry",
            "invisible_geometry",
            "black_environment",
            "tiny_panels",
            "dead_buttons",
            "random_pins",
            "pins_hovering",
            "falling_out",
            "build_failed",
            "not_rendering",
            "no_controller_pose",
            "texture_black",
            "raycast_no_hit",
            "physics_not_simulating",
            "launch_blocked",
            "frozen_viewport",
            "emu_focus_wedge",
            "emulator_camera_drift",
            "compose_fork_conflict",
            "container_mode_mismatch",
          ])
          .describe("The observed symptom to diagnose."),
      },
    },
    async ({ symptom }) => {
      const entry = KB[symptom];
      if (!entry) {
        // Should be unreachable given the enum, but stay honest if the KB drifts.
        return fail(`No knowledge-base entry for symptom '${symptom}'. Known: ${Object.keys(KB).join(", ")}.`);
      }
      return okJson({ symptom, ...entry });
    },
  );

  if (process.platform !== "darwin") {
    // Capture is macOS-only (host screencapture of the qemu window). Register a
    // stub so the tool exists but explains the platform limit.
    server.registerTool(
      "design_review",
      {
        description: "Visual self-review of the emulator scene — macOS-only (host window capture); this server is on a non-macOS host.",
        inputSchema: {},
      },
      async () => fail(`design_review requires macOS (host is ${process.platform}). Use the 'diagnose' tool for symptom-based guidance instead.`),
    );
    return;
  }

  server.registerTool(
    "design_review",
    {
      description:
        "Orchestrate a VISUAL self-review of the live emulator scene: captures the emulator GUI free-cam window (same path as gui_capture — note this view DRIFTS across launches, C2; capture_frame's adb forward view is the deterministic ground-truth path the ledger/eye pipeline uses), runs cheap dependency-free pixel heuristics (mean brightness / contrast / color variety) to flag obvious failures (all-black env, all-white unlit geometry, low contrast), and returns the IMAGE plus a DESIGN.md rubric for YOU (the vision-capable agent) to evaluate. You make the visual judgement against the checklist; this tool supplies the capture, the rubric, and cheap heuristic flags. Pair any failing item with the 'diagnose' tool.",
      inputSchema: {
        windowId: z.number().int().optional().describe("Specific emulator window id (default: the main/largest window)."),
        checklist: z.boolean().default(true).describe("Include the DESIGN.md review rubric in the response (default true)."),
      },
    },
    async ({ windowId, checklist }) => {
      // (a) Enumerate + capture the GUI window, exactly like gui_capture.
      let wins: Win[];
      try {
        wins = listEmulatorWindows();
      } catch (e: any) {
        return fail(e.message);
      }
      const target = windowId ? wins.find((w) => w.id === windowId) : mainWindow(wins);
      if (!target) {
        return fail(
          `No emulator GUI window${windowId ? ` with id ${windowId}` : ""} found. Is the emulator running WITHOUT -no-window and not minimized? (gui_find_window lists windows.)`,
        );
      }

      const out = path.join(os.tmpdir(), "pico-mcp", `review-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });

      const cap = await run("screencapture", ["-o", "-x", `-l${target.id}`, out], { timeoutMs: 30_000 });
      const captured = cap.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000;
      if (!captured) {
        const err = (cap.stderr || cap.stdout || "").trim();
        if (fs.existsSync(out)) {
          try {
            fs.unlinkSync(out);
          } catch {}
        }
        if (/could not create image|not authorized|permission/i.test(err) || !err) {
          return fail(`Screen capture failed — likely missing Screen Recording permission.\n${PERM_HINT}\nRaw: ${err || "(no output)"}`);
        }
        return fail(`screencapture failed: ${err}`);
      }

      // (b) Cheap, dependency-free heuristics (best-effort; null if unreliable).
      const bytes = fs.readFileSync(out);
      const heuristics = await computeHeuristics(out);
      try {
        fs.unlinkSync(out);
      } catch {}

      // (c) Assemble the rubric + heuristic flags for the vision-capable agent.
      const noteLines: string[] = [
        `Emulator GUI capture for design review (window ${target.id}, ${target.w}x${target.h}, ${bytes.length} bytes). This is the host-composited immersive 3D view.`,
        "",
        "HOW TO USE: YOU evaluate the image against the rubric below — you have vision, this tool does not. The heuristics are coarse global pixel stats, not scene understanding; trust your eyes over them. For any item that FAILS, call diagnose(symptom=...) for the fix.",
      ];

      if (heuristics) {
        noteLines.push(
          "",
          `HEURISTICS (coarse, ${heuristics.grid} downsample): meanBrightness=${heuristics.meanBrightness}/255, brightnessStdDev=${heuristics.brightnessStdDev}, meanChroma=${heuristics.meanChroma}`,
        );
        if (heuristics.flags.length) {
          noteLines.push("HEURISTIC FLAGS:");
          for (const f of heuristics.flags) noteLines.push(`  - ${f}`);
        } else {
          noteLines.push("HEURISTIC FLAGS: none tripped (no obvious all-black / all-white-flat / no-color signal — judge details visually).");
        }
      } else {
        noteLines.push("", "HEURISTICS: unavailable (sips downsample/parse failed) — rely on the image + rubric below.");
      }

      if (checklist) {
        noteLines.push("", "DESIGN.md REVIEW RUBRIC (judge each against the image):");
        for (let i = 0; i < REVIEW_CHECKLIST.length; i++) {
          const c = REVIEW_CHECKLIST[i];
          noteLines.push(`  ${i + 1}. [${c.rule}] ${c.check}`);
        }
        noteLines.push(
          "",
          "If the camera isn't looking at the scene, move the head with gui_camera (WASD) and re-run design_review. If nothing renders, see diagnose(symptom=not_rendering).",
        );
      }

      return image(bytes.toString("base64"), noteLines.join("\n"));
    },
  );
}
