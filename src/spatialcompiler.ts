import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * spatialcompiler.ts — v10.14 (P12): the UNIFIED lane-routing meta-compiler.
 *
 * The front door. Given a natural-language brief, it decides WHICH lane(s) actually fit and emits
 * a concrete, ordered build plan across the whole toolkit — so an agent doesn't have to know the
 * lanes. Native Spatial SDK for 3D/physics/games; the web lane for dashboards/docs/live-text/charts;
 * hybrid (native scene + web control/info panels + the web↔3D bridge) when the brief wants both.
 * Deterministic keyword scoring + lane plan templates; returns the routing rationale, the ordered
 * plan (real tool names), and the honest evidence classes per lane.
 */

const NATIVE = ["physics", "throw", "ball", "bowl", "strike", "pin", "gravity", "collision", "collide", "3d", "3-d", "scene", "model", "mesh", "orbit", "planet", "sun", "solar", "pbr", "metal", "shadow", "animate", "animation", "spin", "rotate", "game", "shoot", "drop", "fall", "menu", "gallery", "showcase", "sculpture", "diorama", "world", "environment", "room", "lathe", "particle"];
const WEB = ["dashboard", "chart", "graph", "document", "docs", "web", "html", "page", "website", "scoreboard", "score", "table", "form", "article", "feed", "text", "readout", "metric", "kpi", "report", "console", "monitor", "log", "status", "panel", "browser", "webxr", "webgl", "three.js", "threejs"];
const HYBRID = ["control panel", "control", "dashboard for the game", "with a dashboard", "hud", "scoreboard", "with controls", "and a", "plus a"];

function score(brief: string, words: string[]): { n: number; hits: string[] } {
  const b = brief.toLowerCase();
  const hits = words.filter((w) => b.includes(w));
  return { n: hits.length, hits };
}

export function registerSpatialCompilerTools(server: McpServer) {
  server.registerTool(
    "compile_spatial_experience",
    {
      description:
        "THE UNIFIED FRONT DOOR (P12): given a natural-language brief, route it to the right lane(s) and emit a concrete, ordered build plan across the WHOLE toolkit — so you don't have to know the lanes. Native Spatial SDK for 3D/physics/games; the web lane (WebView panels / WebSpatial) for dashboards/docs/live-text/charts; HYBRID (native 3D scene + web control/info panels + the web↔3D bridge) when the brief wants both. Returns {lane, rationale, plan:[ordered tool steps], evidenceClasses, honesty}. This is a PLANNER (side-effect free) — execute the returned plan with the named tools. Use it as step 0 for any 'build me a spatial …' brief.",
      inputSchema: {
        brief: z.string().describe("The natural-language experience brief."),
        prefer: z.enum(["auto", "native", "web", "hybrid"]).optional().describe("Override the lane choice (default auto = decide from the brief)."),
      },
    },
    async ({ brief, prefer }) => {
      const nat = score(brief, NATIVE);
      const web = score(brief, WEB);
      const hyb = score(brief, HYBRID);
      let lane: "native" | "web" | "hybrid";
      if (prefer && prefer !== "auto") lane = prefer;
      else if (hyb.n >= 1 && nat.n >= 1 && web.n >= 1) lane = "hybrid";
      else if (nat.n > web.n) lane = "native";
      else if (web.n > nat.n) lane = "web";
      else lane = nat.n > 0 ? "native" : "web";

      const plans: Record<string, any> = {
        native: {
          rationale: `3D/physics/scene signals dominate (native: ${nat.hits.slice(0, 6).join(", ") || "default"}). Build on the native Spatial SDK lane — real Filament rendering, rigid-body physics, clickable menus.`,
          plan: [
            "1. list_templates -> instantiate_template (knockdown for physics games, studio for AAA-metal, gallery/dashboard/showcase for data, ambient/constellation for calm) OR author an AppSpec + plan_app_spec.",
            "2. compile_app_spec(spec, projectDir) -> the build ledger (physics/menu/panel/animation steps auto-included).",
            "3. Execute the ledger: scaffold_spatial_app -> generate_* (rigidbody/lighting/game_menu/panel_compose/scene_animator/…) -> generate_app_wiring -> write files.",
            "4. build_and_run -> install + launch on emulator-5554.",
            "5. capture_frame at the forward pose -> LOOK / visual_judge -> record_verification (drive interactions via broadcast or the clickable GameMenu).",
          ],
          evidenceClasses: ["C0_emulator (vision_verified) for scene/physics/menu", "C3 built-for-Swan for controller-ray only"],
        },
        web: {
          rationale: `Web/text/data signals dominate (web: ${web.hits.slice(0, 6).join(", ") || "default"}). Build on the web lane — real HTML/CSS/JS with live runtime text (no baked-texture limit), rendered as floating spatial panels.`,
          plan: [
            "1a. For dashboards/HUD/live text: generate_web_workspace (N named panels, PANEL_CMD drive) OR generate_panel_compose_kotlin(kind='hud'|'web').",
            "1b. For a React app / OS-6 spatial web: generate_webspatial_app (2D projection verifiable now, built_for_os6 spatial depth).",
            "1c. For 3D/interactive web (three.js/WebGL/WebXR): serve a page + drive_browser (the emulator Chromium 138, WebGL2/WebGPU/WebXR).",
            "2. Build/serve, open the panel(s) (am start the activity, or drive_browser url=...).",
            "3. capture_frame + a sweep -> LOOK / visual_judge; list_spatial_panels to confirm what's on stage; record_verification.",
          ],
          evidenceClasses: ["C0_emulator (vision_verified) for 2D web panels rendering", "built_for_os6 for WebSpatial spatial depth", "structural for WebXR session support"],
        },
        hybrid: {
          rationale: `Both 3D and web/control signals present (native: ${nat.hits.slice(0, 4).join(", ")}; web: ${web.hits.slice(0, 4).join(", ")}). Build HYBRID — a native 3D scene + web panels for text/controls, fused by the web↔3D bridge.`,
          plan: [
            "1. Native scene first: instantiate_template + compile_app_spec + execute the ledger + build_and_run (the 3D/physics core).",
            "2. Add web CONTROL: generate_web_bridge_kotlin (an HTML control panel whose buttons call Native.send -> dispatchDebugCommand -> the scene).",
            "3. Add web INFO/live-text: generate_web_workspace or generate_panel_compose_kotlin(kind='hud') for scoreboards/dashboards beside the scene.",
            "4. Merge all manifest entries; build_and_run; open the scene + panels (am start each; each floats as its own spatial panel).",
            "5. Drive: web buttons (bridge) or PANEL_CMD; capture_frame -> LOOK the composited workspace; record_verification.",
          ],
          evidenceClasses: ["C0_emulator (vision_verified) for the scene + panels + bridge", "the workspace frame (all surfaces in one capture) is the flagship proof"],
        },
      };
      const chosen = plans[lane];
      return okJson({
        status: "ok",
        lane,
        scores: { native: nat.n, web: web.n, hybridSignals: hyb.n },
        rationale: chosen.rationale,
        plan: chosen.plan,
        evidenceClasses: chosen.evidenceClasses,
        honesty: "This is a routing PLAN, not a build. Every visual claim in execution needs a looked-at capture (record_verification). Boundless immersion / immersive-frame compositing stay Swan-hardware; the emulator's strength is bounded, eye-level content + floating panels.",
      });
    },
  );
}
