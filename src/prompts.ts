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
              "- Scenes are plain-text USDA. To scaffold a new project: `create_scene_project`. To learn PICO's prim types (SpatialComponent/Audio/Timeline): `scene_schemas`.",
              "- Edit the .usda files directly with your normal file tools. Author by coordinates; you cannot drag a viewport.",
              "",
              "## 2. Compile + see it fast",
              "- `iterate_scene` is the inner loop: it packs the scene, inspects the bundle, deploys to the ScenePreview app on the emulator, and returns a screenshot. Use it after every meaningful edit.",
              "- For compile-only checks use `pack_bundle` then `inspect_bundle` (check Model/Asset counts match what you authored).",
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
              "## 6. XR input",
              "- Head pose / recenter / passthrough: `xr_set_head_pose`, `xr_recenter`, `xr_set_options` (EXPERIMENTAL — accepted by the emulator but may not be visibly applied by the guest on current builds; verify with screenshots and don't assume).",
              "- Controllers are keyboard-mapped: `controller_map` to see the bindings, `controller_press` to press a control by name (e.g. RC_Trigger). There is no 6DOF controller-pose API.",
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
