import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * generate_mr_app — emit the PROVEN mixed-stage config that renders the PICO home environment +
 * spatial content together with NO "falling out" (verified: spatialdemo renders the home-env bedroom
 * + pins, captured + vision-inspected). Returns the manifest stage <meta-data> block + a minimal
 * HomeStage.kt template. Pair with scaffold_spatial_app (which clones a full buildable project).
 *
 * The recipe (proven): manifest pico.spatial.stage.style="1" (Mixed) renders virtual content over the
 * real/home environment at full intensity — solves "falling out" (the user is always enclosed).
 */
export function registerMrAppTools(server: McpServer) {
  server.registerTool(
    "generate_mr_app",
    {
      description:
        "Emit the proven MIXED-STAGE config (manifest pico.spatial.stage.style=1) that renders the PICO home environment + spatial content together with no falling-out, plus a minimal HomeStage.kt template (SpatialView + scene root + AgentBridge.attachScene hook). Vision-verified config (spatialdemo renders home-env + pins). Use with scaffold_spatial_app for a full project; this captures the stage recipe + entry point.",
      inputSchema: {
        packageName: z.string().describe("App package, e.g. com.example.mrapp"),
        stageId: z.string().optional().describe("Stage id (default 'MainStage')."),
        injectAgentBridge: z.boolean().optional().describe("Include the AgentBridge.attachScene one-liner (default true)."),
      },
    },
    async ({ packageName, stageId, injectAgentBridge }) => {
      const sid = stageId ?? "MainStage";
      const bridge = injectAgentBridge !== false;
      const contentPkg = `${packageName}.content`;
      const manifestMetaData = [
        `<!-- Mixed-stage (proven no-falling-out): renders the PICO home env + virtual content together. Place inside the launcher <activity>. -->`,
        `<meta-data android:name="pico.spatial.stage.id" android:value="${sid}" />`,
        `<!-- stage.style "1" = Mixed (virtual + real at 100% each) — the verified MR config. (3=Full virtual, 0=Auto, 2=Progressive) -->`,
        `<meta-data android:name="pico.spatial.stage.style" android:value="1" />`,
      ].join("\n");

      const homeStageKt = [
        `package ${contentPkg}`,
        "",
        "import com.pico.spatial.core.ecs.Entity",
        "import com.pico.spatial.core.ecs.TransformComponent",
        "import com.pico.spatial.core.math.Quat",
        "import com.pico.spatial.core.math.Vector3",
        "import com.pico.spatial.ui.foundation.content.SpatialView",
        "import kotlinx.coroutines.Dispatchers",
        "import kotlinx.coroutines.withContext",
        ...(bridge ? [`import ${packageName}.agent.AgentBridge`] : []),
        "",
        "/**",
        " * Mixed-stage HomeStage (generate_mr_app). The home env renders behind virtual content — no",
        " * falling-out. Add your models/pins under sceneRoot. Build the project with scaffold_spatial_app.",
        " */",
        "@androidx.compose.runtime.Composable",
        "fun HomeStage() {",
        "    SpatialView(",
        "        initial = { content, _ ->",
        "            val sceneRoot = Entity()",
        "            withContext(Dispatchers.Main) {",
        '                sceneRoot.setName("SceneRoot")',
        "                sceneRoot.components.set(TransformComponent(Vector3(0f, 0f, 0f), Quat.identity(), Vector3(1f, 1f, 1f)))",
        "                content.addEntity(sceneRoot)",
        ...(bridge ? ["                AgentBridge.attachScene(sceneRoot) // headless introspection via AGENT_CMD"] : []),
        "                // TODO: add your spatial content under sceneRoot (models, pins, lighting, UI).",
        "            }",
        "        },",
        "        attachments = {},",
        "    )",
        "}",
        "",
      ].join("\n");

      return okJson({
        manifestMetaData,
        homeStageKt,
        integration: [
          "1. Use scaffold_spatial_app to create the buildable project (it generates from the packaged skeleton).",
          "2. Ensure the launcher <activity> in AndroidManifest.xml has the stage <meta-data> above (style=1 Mixed).",
          `3. Write the HomeStage.kt to app/src/main/java/${contentPkg.replace(/\./g, "/")}/HomeStage.kt and call it from your SpatialApplication entry (DefaultStage { PicoTheme { HomeStage() } }).`,
          ...(bridge ? ["4. generate_agent_bridge + inject it so the scene is headlessly drivable/assertable."] : []),
          "5. build_and_run, then capture_frame / verify — the home env + your content should render together (no falling-out).",
        ],
        note: "Mixed stage (style=1) is the VISION-VERIFIED no-falling-out config (spatialdemo). C4 still holds: in-front interactive Compose panels are headset-only — use in-world textured-quad UI for menus.",
      });
    },
  );
}
