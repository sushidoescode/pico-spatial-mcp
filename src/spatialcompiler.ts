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
// OS-6 WebSpatial signals: the multi-Spatial-Scene model (OS-managed windows + volumes). Distinct
// from the native WebView web-workspace (which is verifiable TODAY) — WebSpatial spatial depth is
// built_for_os6. 'volume'/'volumetric' are WebSpatial-specific; plurality words push toward multi-view.
const WEBSPATIAL = ["webspatial", "web spatial", "os 6", "os6", "os-6", "volume", "volumes", "volumetric", "multi-view", "multiview", "multi view", "install-free", "react app", "react spatial", "web app", "spatial scene", "spatial web app", "window scene", "multiple windows", "separate windows", "several windows", "several scenes", "multiple scenes", "windowed", "command center", "command deck", "mission control"];
// UNAMBIGUOUS WebSpatial vocabulary — a native physics game never says these, so they win the lane
// outright (even alongside a stray native token like '3d' from '3D globe volume').
const EXPLICIT_WS = ["webspatial", "web spatial", "os 6", "os6", "os-6", "volume", "volumes", "volumetric", "multi-view", "multiview", "multi view", "install-free", "window scene", "spatial scene", "spatial web app"];
const MULTI = ["multi-view", "multiview", "multi view", "multiple windows", "separate windows", "several windows", "several scenes", "multiple scenes", "volume", "volumes", "and a", "plus a", "windows", "scenes", "command center", "command deck", "mission control"];
// A DOWNLOADED photoreal world (World Labs / Marble export) -> the ingest_marble_world path, not codegen.
const MARBLE = ["marble", "world labs", "worldlabs", "world-labs", "gaussian splat", "gaussian-splat", "splat", "downloaded world", "downloaded scene", "photoreal capture", "scanned world", "scanned room", ".spz", ".ply"];

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
        "THE UNIFIED FRONT DOOR (P12): given a natural-language brief, route it to the right lane(s) and emit a concrete, ordered build plan across the WHOLE toolkit — so you don't have to know the lanes. Native Spatial SDK for 3D/physics/games; the WebView web lane for dashboards/docs/live-text (verifiable today); the WEBSPATIAL lane for OS-6 multi-Spatial-Scene apps (windows + volumes, multi-view, built_for_os6); HYBRID (native 3D scene + web control/info panels + the web↔3D bridge) when the brief wants both. Returns {lane, rationale, plan:[ordered tool steps], evidenceClasses, honesty}. This is a PLANNER (side-effect free) — execute the returned plan with the named tools. Use it as step 0 for any 'build me a spatial …' brief.",
      inputSchema: {
        brief: z.string().describe("The natural-language experience brief."),
        prefer: z.enum(["auto", "native", "web", "hybrid", "webspatial"]).optional().describe("Override the lane choice (default auto = decide from the brief). 'webspatial' forces the OS-6 multi-Spatial-Scene lane."),
      },
    },
    async ({ brief, prefer }) => {
      const nat = score(brief, NATIVE);
      const web = score(brief, WEB);
      const hyb = score(brief, HYBRID);
      const wsp = score(brief, WEBSPATIAL);
      const wspStrong = score(brief, EXPLICIT_WS);
      const multi = score(brief, MULTI);
      const marble = score(brief, MARBLE);
      // An explicit downloaded-world asset path in the brief (…/foo.spz|.ply|.glb) is the strongest signal.
      const worldPath = brief.match(/([~/][^\s"']*\.(?:spz|ply|glb|gltf))/i)?.[1] ?? null;
      const marbleWorld = marble.n >= 1 || !!worldPath;
      let lane: "native" | "web" | "hybrid" | "webspatial";
      if (prefer && prefer !== "auto") lane = prefer;
      // A downloaded photoreal world (Marble/World-Labs export, or an explicit .spz/.ply/.glb path) is an
      // INGEST job, not codegen — it renders on the native lane via ingest_marble_world. Wins outright
      // unless the brief ALSO carries explicit OS-6/WebSpatial vocabulary.
      else if (marbleWorld && wspStrong.n === 0) lane = "native";
      // Unambiguous WebSpatial vocabulary (os6/volume/multi-view/webspatial) wins outright — a physics
      // game never uses these, so a stray '3d'/'globe' native token doesn't pull it to the native lane.
      else if (wspStrong.n >= 1) lane = "webspatial";
      // Weaker WebSpatial signals (react/web app, command center, windows) only win when web-leaning.
      else if (wsp.n >= 1 && web.n >= nat.n) lane = "webspatial";
      else if (hyb.n >= 1 && nat.n >= 1 && web.n >= 1) lane = "hybrid";
      else if (nat.n > web.n) lane = "native";
      else if (web.n > nat.n) lane = "web";
      else lane = nat.n > 0 ? "native" : "web";
      // single vs multi WebSpatial scene: plurality signals (multiple/volumes/multi-view) -> multiview
      const wsMulti = multi.n >= 1 || /(\d+|two|three|four|several|multiple)\s+(window|scene|volume|view|panel)/i.test(brief);

      const plans: Record<string, any> = {
        native: marbleWorld ? {
          rationale: `A DOWNLOADED photoreal world is referenced (${[...marble.hits.slice(0, 4), worldPath].filter(Boolean).join(", ")}). This is an INGEST job, not codegen: ingest_marble_world turns a World-Labs/Marble .spz/.ply splat (or .glb mesh) into an interactive native scene — auto collider rig + the SplatEnvironment loader + the adb-push — then dress it with objects/physics. HONEST: a splat renders photoreal but VIEW-DEPENDENT (a dense captured band + black uncaptured regions — a diorama, not a full surround); a .glb mesh is the SOLID view-independent alternative.`,
          plan: [
            `1. ingest_marble_world(worldPath${worldPath ? `="${worldPath}"` : "=<the .spz/.ply/.glb>"}, packageName, projectDir) -> analyze_splat (bounds/floor/collider boxes) + generate_splat_colliders + SplatEnvironment.kt (or the .glb bake path) + the adb-push command.`,
            "2. Run the returned adbPush (splats ship via adb-push; spatialbundle can't pack them); wire SplatEnvironment.load(externalFilesPath) into SpatialView.initial with Modifier.fillMaxSize() (the C4 fill fix), and seat the world transform so the camera sits INSIDE (shift toward the interior center, drop ~0.4m to foot level).",
            "3. Dress the scene: add objects/physics UNDER sceneRoot (they rest on / rayCast the auto colliders); a brighter SceneLighting rig makes props POP against a dim capture (self-lit splats ignore scene lights, so light is for YOUR props).",
            "4. build_and_run -> install + launch on emulator-5554.",
            "5. capture_frame, then emulator_look to aim at the dense captured band (a splat has no full surround) -> LOOK / visual_judge -> record_verification (honest: vision_verified render + interactive objects; note the diorama limitation).",
          ],
          evidenceClasses: ["C0_emulator (vision_verified) for the photoreal world render + interactive objects on the collider rig", "structural for the diorama's uncaptured (black) regions — NOT a full surround", "a .glb re-ingest gives a SOLID view-independent render (Blender can retexture first)"],
        } : {
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
        webspatial: {
          rationale: `OS-6 WebSpatial signals fire (${wsp.hits.slice(0, 6).join(", ") || "webspatial"}${wsMulti ? "; multi-view/volume plurality" : "; single scene"}). Build on the WebSpatial lane — a React web app whose scenes become OS-managed windows/volumes on PICO OS 6 (install-free, no native code). The 2D projection is verifiable today; spatial depth = built_for_os6. NOTE: for panels that must render on the CURRENT emulator, use the native web lane (generate_web_workspace) instead — WebSpatial spatial behavior needs the OS-6 runtime.`,
          plan: wsMulti
            ? [
                "1. generate_webspatial_multiview(projectDir, title, mainScene, scenes[{name,type:'window'|'volume',title,width/height/depth}]) — a main window scene + N secondary window/volume scenes (initScene + window.open; volumes use '0.9m'-style meter sizes; correct xr_spatial_scene manifest).",
                "2. cd projectDir && npm install && npm run build (real @webspatial/react-sdk; ~vite, seconds).",
                "3. verify_webspatial_scenes(projectDir) — STATIC scene graph (scenes/types/opens/enable-xr, valid?). Then serve dist/ (python3 -m http.server + the URL) and re-call with servedUrl=... for the headless PicoWebApp boot check + a 2D screenshot.",
                "4. LOOK at the boot screenshot -> record_verification (the 2D projection of each scene is vision_verified; native OS-managed windows/volumes = built_for_os6).",
                "5. check_toolchain_updates — when the OS-6 (6.1.0) runtime/simulator ships, the built_for_os6 rows flip to device-verified.",
              ]
            : [
                "1. generate_webspatial_app(projectDir, title, panels) — a single-scene WebSpatial React app (enable-xr panels, --xr-back depth, correct xr_spatial_scene manifest) + a preview.html.",
                "2. Render the 2D projection with headless Chrome (or npm run build + serve) -> LOOK / visual_judge.",
                "3. verify_webspatial_scenes(projectDir, servedUrl=...) for the headless boot check -> record_verification (2D projection vision_verified; spatial depth built_for_os6).",
                "4. If the brief actually wants 2+ distinct windows/volumes, switch to generate_webspatial_multiview.",
              ],
          evidenceClasses: ["C0_emulator (vision_verified) for the 2D projection of each scene (headless render/boot)", "structural for the declared multi-scene graph (verify_webspatial_scenes)", "built_for_os6 for native OS-managed windows/volumes + spatial depth (needs the OS-6 runtime; watched by check_toolchain_updates)"],
        },
      };
      const chosen = plans[lane];
      return okJson({
        status: "ok",
        lane,
        scores: { native: nat.n, web: web.n, hybridSignals: hyb.n, webspatial: wsp.n, multiView: multi.n, marbleWorld: marble.n, worldPath: worldPath ?? undefined },
        rationale: chosen.rationale,
        plan: chosen.plan,
        evidenceClasses: chosen.evidenceClasses,
        honesty: "This is a routing PLAN, not a build. Every visual claim in execution needs a looked-at capture (record_verification). UNVERIFIED / OUT OF SCOPE: room-scale movement, headset depth behavior, immersive-frame compositing, Swan behavior, and hardware safety boundaries remain unverified. Receipt v1 and this routing plan make no hardware-readiness or immersion claim; emulator evidence remains bounded.",
      });
    },
  );
}
