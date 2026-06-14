#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { validateToolchain } from "./toolchain.js";
import { registerAdbTools } from "./adb.js";
import { registerEmulatorTools } from "./emulator.js";
import { registerBundleTools } from "./bundle.js";
import { registerGradleTools } from "./gradle.js";
import { registerGrpcTools } from "./grpc.js";
import { registerEditorTools } from "./editor.js";
import { registerAgentLoopTools } from "./agentloop.js";
import { registerWorkflowTools } from "./workflow.js";
import { registerSceneTools } from "./scene.js";
import { registerHostGuiTools } from "./hostgui.js";
import { registerInspectionTools } from "./inspection.js";
import { registerScaffoldTools } from "./scaffold.js";
import { registerComponentTools } from "./components.js";
import { registerAssetTools } from "./assets.js";
import { registerDiagnoseTools } from "./diagnose.js";
import { registerColliderTools } from "./collider.js";
import { registerEnvironmentTools } from "./environment.js";
import { registerRegressionTools } from "./regression.js";
import { registerSenseTools } from "./sense.js";
import { registerEditorProjectTools } from "./editorproject.js";
import { registerMaterialXTools } from "./materialx.js";
import { registerCapabilityTools } from "./capability.js";
import { registerPrompts } from "./prompts.js";

const server = new McpServer({
  name: "pico-spatial-mcp",
  version: "3.1.0",
});

server.registerTool(
  "validate_toolchain",
  {
    description:
      "Preflight the locally installed PICO spatial toolchain: resolves the tools root (local.properties spatial.tools.dir -> $PICO_HOME -> ~/Library/PICO/sdk), checks spatialbundle/emulator binaries, adb, AVDs, license acceptance, and gRPC proto availability. Run this first.",
    inputSchema: {
      projectDir: z.string().optional().describe("Android project dir whose local.properties should be honored"),
      toolsVersion: z.string().optional().describe("Pin a specific toolchain version, e.g. '0.13'"),
    },
  },
  async ({ projectDir, toolsVersion }) => okJson(await validateToolchain(projectDir, toolsVersion)),
);

registerEmulatorTools(server);
registerAdbTools(server);
registerBundleTools(server);
registerGradleTools(server);
registerGrpcTools(server);
registerEditorTools(server);
registerAgentLoopTools(server);
registerWorkflowTools(server);
registerSceneTools(server);
registerHostGuiTools(server);
registerInspectionTools(server);
registerScaffoldTools(server);
registerComponentTools(server);
registerAssetTools(server);
registerDiagnoseTools(server);
registerColliderTools(server);
registerEnvironmentTools(server);
registerRegressionTools(server);
registerSenseTools(server);
registerEditorProjectTools(server);
registerMaterialXTools(server);
registerCapabilityTools(server);
registerPrompts(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("pico-spatial-mcp ready (stdio)");
