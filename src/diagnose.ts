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
      "gui_capture (screencapture -l<qemu-windowid>) captures the immersive view (with Screen Recording granted); adb screencap shows the emulator reference scene, NOT the app's immersive render.",
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
      "The environment is a small finite procedural room (a box). With stage style 3 (Full), moving past its walls reveals the system environment because there is nothing enclosing the user out there.",
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
      "No frame is reaching the host-composited GUI view, OR you are looking at the guest framebuffer (adb/gRPC screenshots) which CANNOT show the immersive 3D view. The 3D view lives only in the emulator's GUI window.",
    fix: [
      "Capture the actual GUI window with gui_capture / design_review — adb screencap and xr_screenshot miss the host-composited 3D view.",
      "Confirm the emulator runs WITHOUT -no-window and is not minimized (gui_find_window must list a window).",
      "Run build_and_run to confirm a frame rendered and the app did not crash (check_crash / logcat for a stack trace).",
      "If gui_capture errors with 'could not create image', grant Screen Recording permission (see gui_permissions).",
    ],
    designRule: "DESIGN.md §8 (verify visually AND structurally) — gui_capture is the only 3D view",
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
            "emulator_camera_drift",
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
        "Orchestrate a VISUAL self-review of the live emulator scene: captures the host-composited emulator GUI window (the only view of the immersive 3D scene, same path as gui_capture), runs cheap dependency-free pixel heuristics (mean brightness / contrast / color variety) to flag obvious failures (all-black env, all-white unlit geometry, low contrast), and returns the IMAGE plus a DESIGN.md rubric for YOU (the vision-capable agent) to evaluate. You make the visual judgement against the checklist; this tool supplies the capture, the rubric, and cheap heuristic flags. Pair any failing item with the 'diagnose' tool.",
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
