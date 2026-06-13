import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A built-in prompt teaching an agent the PICO spatial dev loop with these tools. */
export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "autonomous_spatial_build",
    {
      description: "v2.0 autonomous build loop: take a product brief and ship a polished, self-verified native PICO spatial APK, reviewing and fixing your own work.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are an autonomous spatial-app builder driving pico-spatial-mcp. Take a product brief and deliver a polished, RUNNING native PICO spatial APK — and review and fix your OWN work until it meets the bar. Read SKILLS.md + DESIGN.md first.",
              "",
              "## The loop (repeat until the build passes review)",
              "1. PREFLIGHT — `validate_toolchain`; fix any `problems` before continuing.",
              "2. SCAFFOLD — `scaffold_spatial_app` (new app) from a template; set package, name, Full stage.",
              "3. ASSETS — for any environment/model the brief implies: `prepare_environment` (it auto-detects pano→skybox, textured-vs-collider GLB, splat-not-loadable) and follow its `recommendedCompose`. Prefer a 360 skybox for environments (mesh textures render black).",
              "4. SCENE — `compose_inspection_scene`/`compose_scene` (real materials, surface-placed markers). `verify_scene` — geometry/material counts must match intent.",
              "5. UI — `generate_spatial_ui` to emit verified Compose panels (sized, clickable, correct colors); wire them in HomeStage/Main (movable `WindowContainer`s if the brief wants window chrome). Interaction must be INTENTIONAL (armed placement, never automatic).",
              "6. BUILD & RUN — `build_and_run`; require `build/install/launch` ok, `rendered: true`, `crashes: []`.",
              "7. SELF-REVIEW — `design_review`: it captures the REAL 3D view and gives you a DESIGN.md rubric. YOU have vision — judge each rubric item against the capture. For every FAIL, call `diagnose(symptom=...)` to get the root cause + exact fix, apply it, and GOTO 4/5/6.",
              "8. SHIP — when the review passes (geometry colored, environment visible, panels readable, content framed, interaction gated, pins on surfaces, no crash), report what you built, the verification results, and any honest limitations.",
              "",
              "## Principles",
              "- The runtime fails SILENTLY. Never assume — `verify_scene` + `build_and_run` (`rendered`) + `gui_capture`/`design_review` after every change.",
              "- Treat each capture like a senior code review: name the defect, map it to a DESIGN.md rule via `diagnose`, fix the root cause (not the symptom), re-verify.",
              "- Don't relearn the gotchas: materials-not-displayColor, skybox-override-for-textures, head-gaze aiming, no-`java`-on-PATH (auto-detected), intentional interaction. `diagnose` has them all.",
              "- Model-agnostic: if you are a local model, keep one tool call per step and lean on the structured results + the self-diagnosis tree.",
              "- Commit small, verified changes. Update ROADMAP.md §1 (works/doesn't) as items close.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "pico_spatial_dev_loop",
    {
      description: "Guidance for an AI agent driving PICO spatial development end-to-end with this server's tools.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are driving PICO XR spatial development through the pico-spatial-mcp server. Follow this loop.",
              "",
              "## 0. Preflight (once)",
              "Call `validate_toolchain`. If `problems` is non-empty, stop and report — the user must fix the install/AVD/license before you can proceed.",
              "",
              "## 0a. Read the references",
              "- SKILLS.md (what you can build + the self-diagnosis decision tree) and DESIGN.md (correctness rules: materials not displayColor, panel sizing, surface placement, intentional interaction, keeping the user enclosed) — they encode the hard-won rules. Verify visually with gui_capture and treat each capture like a code review: name the defect, map it to a DESIGN.md rule, fix, rebuild, re-capture.",
              "",
              "## 0b. Start a new project",
              "- To begin a NEW spatial app (any kind, not just ClaimSight), call `scaffold_spatial_app` with a template app, a new package, and an app name — it returns a fresh, buildable project. Then author HomeStage.kt + a scene and `build_and_run`. For interactive apps (controller ray, raycast, selection), the decompiled SDK API is in docs/spatial-interaction-api.md.",
              "",
              "## 1. Author the scene (no GUI needed)",
              "- Scaffold a project with `create_scene_project`. Bring in 3D models/textures with `import_asset`. Compose a scene from a high-level spec with `compose_scene` (mesh references, primitives, lights, IBL) — or edit the plain-text USDA directly. `add_entity` appends one entity. `scene_schemas` shows PICO's custom prim types.",
              "- Author by coordinates; you cannot drag a viewport.",
              "",
              "## 2. Compile + VERIFY (read this carefully)",
              "- The emulator does NOT show immersive 3D content in screenshots (display 0 = home env + 2D panels only; 3D is host-composited into the GUI window). So VERIFY spatial scenes with `verify_scene` (compiles + checks geometry/mesh/material counts and expected mesh names) — NOT screenshots.",
              "- `iterate_scene` packs + inspects + deploys to ScenePreview + screenshots in one call (the screenshot confirms deploy/2D state; trust the geometry counts for 3D).",
              "- For editor-managed projects (components/timelines) prefer `build_spatial_project` (the editor's own headless build) for parity.",
              "",
              "## 3. Ship the real app",
              "- `build_and_run` builds the APK (scenes are packed into it automatically), installs, launches, checks for crashes, and screenshots. Use when you need the actual application, not just a scene preview.",
              "",
              "## 4. Emulator lifecycle",
              "- If no device is online (`emulator_list`), boot one with `emulator_boot` (headless by default).",
              "- Capture a known-good baseline with `snapshot_save`; restore it with `snapshot_load` before each test for determinism.",
              "",
              "## 5. Observe & verify",
              "- `screencap` (adb) or `xr_screenshot` (gRPC, works headless). `screenrecord` for animation.",
              "- `ui_dump` to find 2D panel/menu elements by name and tap their center with `ui_input` — do NOT guess coordinates.",
              "- `wait_for_log` to block on a readiness/error marker instead of sleeping. `check_crash` after launching or driving an app.",
              "",
              "## 6. XR input — call `xr_input_status` FIRST",
              "- Head pose is GATED on this build: `xr_set_head_pose` is accepted but does NOT move the view (the camera mode it needs is GUI-only). Do not build flows that depend on programmatic head movement.",
              "- Controllers are keyboard-mapped: `controller_map` to see bindings, `controller_press` to press a control by name (e.g. RC_Trigger). No 6DOF controller-pose API.",
              "- `xr_set_options` (passthrough/environment) and `xr_recenter` are accepted; `xr_send_key` drives keys.",
              "",
              "## Principles",
              "- After every build/deploy, VERIFY with a screenshot or log — never assume success.",
              "- Prefer the orchestration tools (`iterate_scene`, `build_and_run`) over hand-sequencing primitives.",
              "- When something fails, read the returned error/log tail and fix the root cause before retrying; don't loop blindly.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
