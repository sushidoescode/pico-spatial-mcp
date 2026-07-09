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
import { registerAgentBridgeTools } from "./agentbridge.js";
import { registerCaptureTools } from "./capture.js";
import { registerEmulatorLookTools } from "./emulatorlook.js";
import { registerEditorComponentTools } from "./editorcomponent.js";
import { registerEditorV32Tools } from "./editorv32.js";
import { registerAssertSceneTools } from "./assertscene.js";
import { registerVerifyVisualTools } from "./verifyvisual.js";
import { registerBundleDiffTools } from "./bundlediff.js";
import { registerVerifyTools } from "./verify.js";
import { registerEditorExportTools } from "./editorexport.js";
import { registerLightingTools } from "./lighting.js";
import { registerMrAppTools } from "./mrapp.js";
import { registerVerifyBaselineTools } from "./verifybaseline.js";
import { registerRichnessTools } from "./richness.js";
import { registerSwanTools } from "./swan.js";
import { registerDeployTools } from "./deploy.js";
import { registerHomeEnvProxyTools } from "./homeenv.js";
import { registerMediaTools } from "./media.js";
import { registerAnimTools } from "./anim.js";
import { registerDisplayTools } from "./display.js";
import { registerPhysicsTools } from "./physics.js";
import { registerMenuTools } from "./menu.js";
import { registerMouseBridgeTools } from "./mousebridge.js";
import { registerLayoutTools } from "./layout.js";
import { registerInteractionTools } from "./interaction.js";
import { registerDataBindingTools } from "./databinding.js";
import { registerCapabilityManifestTools } from "./capabilities.js";
import { registerPlannerTools } from "./planner.js";
import { registerCompilerTools } from "./compiler.js";
import { registerSpecVerifyTools } from "./specverify.js";
import { registerLintTools } from "./lint.js";
import { registerCritiqueTools } from "./critique.js";
import { registerLedgerTools } from "./ledger.js";
import { registerStackTools } from "./stack.js";
import { registerEvalTools } from "./eval.js";
import { registerGateTools } from "./gate.js";
import { registerTemplateTools } from "./templates.js";
import { registerRemixTools } from "./remix.js";
import { registerRouterTools } from "./router.js";
import { registerCompositionTools } from "./composition.js";
import { registerInteractableRegistryTools } from "./interactables.js";
import { registerLayoutPlanTools } from "./layoutplan.js";
import { registerCatalogTools } from "./catalog.js";
import { registerSwanParityTools } from "./swanparity.js";
import { registerFactoryTools } from "./factory.js";
import { registerEyeTools } from "./eye.js";
import { registerAssembleTools } from "./assemble.js";
import { registerPanelComposeTools } from "./panelcompose.js";
import { registerGradleHooksTools } from "./gradlehooks.js";
import { registerEditorCustomComponentTools } from "./editorcomponents.js";
import { registerFleetBuildTools } from "./fleetbuild.js";
import { registerMenuTextureTools } from "./menutexture.js";
import { registerEditorPaletteTools } from "./editorpalette.js";
import { registerWebBrowserTools } from "./webbrowser.js";
import { registerWebWorkspaceTools } from "./webworkspace.js";
import { registerWebSpatialTools } from "./webspatial.js";
import { registerWebBridgeTools } from "./webbridge.js";
import { registerSpatialCompilerTools } from "./spatialcompiler.js";
import { registerLiveDataTools } from "./livedata.js";
import { registerWeb3DTools } from "./web3d.js";
import { registerCapabilityReportTools } from "./capabilityreport.js";
import { registerHybridBuildTools } from "./hybridbuild.js";
import { registerDataConnectTools } from "./dataconnect.js";
import { registerExperienceTools } from "./experiences.js";
import { registerShipTools } from "./ship.js";
import { registerVerifyApkTools } from "./verifyapk.js";
import { registerSetDressingTools } from "./setdressing.js";
import { registerSignageTools } from "./signage.js";
import { registerSignageBoardTools } from "./signageboard.js";
import { registerSplatAnalyzeTools } from "./splatanalyze.js";
import { registerToolchainWatchTools } from "./toolchainwatch.js";
import { registerWebSpatialMultiviewTools } from "./webspatialmv.js";
import { registerMarbleIngestTools } from "./marbleingest.js";
import { registerFidelityTools } from "./fidelity.js";
import { registerCaptureRigTools } from "./capturerig.js";
import { registerPerfProbeTools } from "./perfprobe.js";
import { registerAnimTimelineTools } from "./animtimeline.js";
import { registerSpatialAudioTools } from "./spatialaudio.js";
import { registerProceduralTools } from "./procedural.js";
import { registerAssetGateTools } from "./assetgate.js";
import { registerTextTo3dTools } from "./textto3d.js";
import { registerWorldEnvTools } from "./worldenv.js";
import { registerUsdRenderTools } from "./usdrender.js";
import { registerIblBakeTools } from "./iblbake.js";
import { registerPrompts } from "./prompts.js";

const server = new McpServer({
  name: "pico-spatial-mcp",
  version: "6.0.0",
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
registerAgentBridgeTools(server);
registerCaptureTools(server);
registerEmulatorLookTools(server);
registerEditorComponentTools(server);
registerEditorV32Tools(server);
registerAssertSceneTools(server);
registerVerifyVisualTools(server);
registerBundleDiffTools(server);
registerVerifyTools(server);
registerEditorExportTools(server);
registerLightingTools(server);
registerMrAppTools(server);
registerVerifyBaselineTools(server);
registerRichnessTools(server);
registerSwanTools(server);
registerDeployTools(server);
registerHomeEnvProxyTools(server);
registerMediaTools(server);
registerAnimTools(server);
registerDisplayTools(server);
registerPhysicsTools(server);
registerMenuTools(server);
registerMouseBridgeTools(server);
// v5.0 — the three interaction/layout/data primitives + the brief-to-app compiler tier
registerLayoutTools(server);
registerInteractionTools(server);
registerDataBindingTools(server);
registerCapabilityManifestTools(server);
registerPlannerTools(server);
registerCompilerTools(server);
registerSpecVerifyTools(server);
// v5.1 — the retained-lessons lint engine (executable, fixture-backed gotchas)
registerLintTools(server);
// v5.2 — the self-repair critique (LOOKED-at frame -> defect list -> replan_spec)
registerCritiqueTools(server);
// v5.3 — the trust ledger (over-claims structurally impossible) + safe stacked-worktree landing
registerLedgerTools(server);
registerStackTools(server);
// v5.4 — the eval corpus + scorecard (brief-generality as a distribution)
registerEvalTools(server);
// v5.5 — regression gate + reproducibility lockdown (block ship on any regression)
registerGateTools(server);
// v5.6 — templates + remix (reuse: parameterized AppSpec skeletons + remix an app to a new brief)
registerTemplateTools(server);
registerRemixTools(server);
// v5.7 — multi-scene orchestration (scene-graph router + USD composition)
registerRouterTools(server);
registerCompositionTools(server);
// v5.8 — data-driven at scale + generalized interaction
registerInteractableRegistryTools(server);
registerLayoutPlanTools(server);
registerCatalogTools(server);
// v5.9 — Swan on-device parity (flip built-for-headset -> device-verified when a Swan attaches)
registerSwanParityTools(server);
// v6.0 — the autonomous spatial factory (queue of briefs -> verified/ledgered/gated apps + fleet dashboard)
registerFactoryTools(server);
registerEyeTools(server);
registerAssembleTools(server);
  registerPanelComposeTools(server);
  registerGradleHooksTools(server);
  registerEditorCustomComponentTools(server);
  registerFleetBuildTools(server);
  registerMenuTextureTools(server);
  registerEditorPaletteTools(server);
  registerWebBrowserTools(server);
  registerWebWorkspaceTools(server);
  registerWebSpatialTools(server);
  registerWebBridgeTools(server);
  registerSpatialCompilerTools(server);
  registerLiveDataTools(server);
  registerWeb3DTools(server);
  registerCapabilityReportTools(server);
  registerHybridBuildTools(server);
  registerDataConnectTools(server);
  registerExperienceTools(server);
  registerShipTools(server);
  registerVerifyApkTools(server);
  registerSetDressingTools(server);
  registerSignageTools(server);
  registerSignageBoardTools(server);
  registerSplatAnalyzeTools(server);
  registerToolchainWatchTools(server);
  registerWebSpatialMultiviewTools(server);
  registerMarbleIngestTools(server);
  registerFidelityTools(server);
  registerCaptureRigTools(server);
  registerPerfProbeTools(server);
  registerAnimTimelineTools(server);
  registerSpatialAudioTools(server);
registerProceduralTools(server);
registerAssetGateTools(server);
registerTextTo3dTools(server);
registerWorldEnvTools(server);
registerUsdRenderTools(server);
registerIblBakeTools(server);
registerPrompts(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("pico-spatial-mcp ready (stdio)");
