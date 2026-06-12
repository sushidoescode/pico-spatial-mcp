import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A built-in prompt teaching an agent the PICO spatial dev loop with these tools. */
export function registerPrompts(server: McpServer) {
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
