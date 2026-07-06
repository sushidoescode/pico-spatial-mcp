import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

/**
 * experiences.ts — v10.21 (P19): the cross-lane EXPERIENCE library.
 *
 * Curated, COMPLETE experiences that compose multiple capabilities across lanes into one recipe —
 * the "gallery" for the whole toolkit (vs list_templates, which is native-only AppSpec skeletons,
 * and compile_spatial_experience, which routes a freeform brief). Each experience is a named,
 * ready-to-build recipe of real tool calls with the honest evidence expectation.
 */

type Step = { tool: string; args: any; note?: string };
type Experience = { name: string; title: string; lane: string; capabilities: string[]; summary: string; recipe: (cfg: any) => Step[]; evidence: string; oneCommand?: string };

const EXPERIENCES: Experience[] = [
  {
    name: "spatial-dashboard", title: "Spatial Ops Dashboard", lane: "web",
    capabilities: ["web workspace (P9)", "live data (P13)", "data connectors (P18)"],
    summary: "N floating web panels fed by real APIs — a live monitoring deck.",
    recipe: (cfg) => [
      { tool: "connect_data_source", args: { source: cfg.source ?? "weather", config: cfg.config ?? {} }, note: "get real fields + a poller" },
      { tool: "generate_web_workspace", args: { packageName: `${cfg.pkg ?? "com.demo.dashboard"}.content`, panels: (cfg.panels ?? ["weather", "repo", "market"]).map((n: string) => ({ name: n, url: `http://localhost:8794/${n}.html` })) }, note: "N named live panels" },
      { tool: "generate_live_data_panel", args: { packageName: `${cfg.pkg ?? "com.demo.dashboard"}.content`, title: "LIVE", dataUrl: "http://localhost:8794/data.json", fields: [] }, note: "bind the connector fields" },
    ],
    evidence: "vision_verified (panels render) + structural (real data flows). Web lane — verifiable now.",
  },
  {
    name: "physics-arcade", title: "Physics Arcade", lane: "hybrid",
    capabilities: ["native physics (rulebook)", "clickable menu (P6)", "web control bridge (P11)", "HUD (P13)"],
    summary: "A native physics game + an HTML control panel whose buttons drive it — one app.",
    recipe: (cfg) => [
      { tool: "build_hybrid_experience", args: { appName: cfg.appName ?? "ArcadeDeck", packageName: cfg.pkg ?? "com.demo.arcade", game: "knockdown", controls: cfg.controls ?? [{ label: "THROW", cmd: "start" }, { label: "RESET", cmd: "reset" }] }, note: "one command builds the whole hybrid" },
    ],
    evidence: "vision_verified (composited workspace) — proven by P17.",
    oneCommand: "build_hybrid_experience({appName, packageName, game:'knockdown'})",
  },
  {
    name: "product-configurator", title: "Product Configurator", lane: "web",
    capabilities: ["interactive web-3D (P16)", "web control panel", "select/data API"],
    summary: "A 3D product you rotate + click to select parts, driven by an HTML control panel.",
    recipe: (cfg) => [
      { tool: "generate_web3d_scene", args: { outPath: cfg.outPath ?? "/tmp/web3d/config.html", title: cfg.title ?? "CONFIGURATOR", preset: "grid", count: cfg.count ?? 6, interactive: true, labels: cfg.labels ?? ["BASE", "TRIM", "WHEELS", "PAINT", "SEATS", "TECH"] }, note: "clickable parts (Scene3D.select)" },
      { tool: "drive_browser", args: { url: "http://localhost:8792/config.html" }, note: "open + drive via Scene3D.select(i)/data(values)" },
    ],
    evidence: "vision_verified (select highlights a part) — proven by P16.",
  },
  {
    name: "data-command-deck", title: "Data Command Deck", lane: "web",
    capabilities: ["web-3D data viz (P16 Scene3D.data)", "live data (P13)", "connectors (P18)"],
    summary: "A 3D bar/orbit field sized by live data + live-text side panels — a command deck.",
    recipe: (cfg) => [
      { tool: "connect_data_source", args: { source: cfg.source ?? "crypto", config: cfg.config ?? { ids: "bitcoin,ethereum,solana" } }, note: "real values -> Scene3D.data()" },
      { tool: "generate_web3d_scene", args: { outPath: cfg.outPath ?? "/tmp/web3d/deck.html", title: cfg.title ?? "MARKET DECK", preset: "torusfield", count: cfg.count ?? 3, interactive: true }, note: "feed .data([v0,v1,v2]) to size rings" },
      { tool: "generate_live_data_panel", args: { packageName: `${cfg.pkg ?? "com.demo.deck"}.content`, title: "MARKET", dataUrl: "http://localhost:8794/data.json", fields: [] }, note: "live readout beside the 3D" },
    ],
    evidence: "vision_verified (3D + panels) + structural (real data). Web lane.",
  },
  {
    name: "ops-console", title: "WebSpatial Ops Console", lane: "web/os6",
    capabilities: ["WebSpatial React (P10)", "live data (P13)", "connectors (P18)"],
    summary: "A React WebSpatial app (spatial on OS 6) with live-data panels — the forward-looking console.",
    recipe: (cfg) => [
      { tool: "connect_data_source", args: { source: cfg.source ?? "github", config: cfg.config ?? { repo: "anthropics/anthropic-sdk-typescript" } } },
      { tool: "generate_webspatial_app", args: { projectDir: cfg.projectDir ?? "/tmp/webspatial/ops", title: cfg.title ?? "Ops Console", panels: cfg.panels ?? [{ title: "REPO", rows: [{ label: "STARS", value: "…" }] }] }, note: "2D verifiable now; spatial on OS 6" },
    ],
    evidence: "vision_verified (2D projection, P10) + built_for_os6 (spatial depth).",
  },
];

export function registerExperienceTools(server: McpServer) {
  server.registerTool(
    "list_experiences",
    {
      description:
        "List the curated CROSS-LANE experiences (P19) — complete, ready-to-build recipes that compose multiple capabilities (physics + web + data + 3D) into one named experience. Each names its lane, the capabilities it uses, and its evidence expectation. Use plan_experience to get the concrete build recipe. (Distinct from list_templates = native AppSpec skeletons; and compile_spatial_experience = route a freeform brief.)",
      inputSchema: {},
    },
    async () => okJson({
      status: "ok",
      count: EXPERIENCES.length,
      experiences: EXPERIENCES.map((e) => ({ name: e.name, title: e.title, lane: e.lane, capabilities: e.capabilities, summary: e.summary, oneCommand: e.oneCommand ?? null })),
    }),
  );

  server.registerTool(
    "plan_experience",
    {
      description:
        "Get the concrete, ordered build recipe for one curated cross-lane experience (P19): the exact tool calls (with args) to build it, plus its honest evidence expectation. Fill config to customize (pkg, appName, source, panels, etc.). Execute the recipe with the named tools (physics-arcade collapses to a single build_hybrid_experience call). Use list_experiences to see the catalog.",
      inputSchema: {
        name: z.string().describe("Experience name from list_experiences (e.g. 'physics-arcade')."),
        config: z.any().optional().describe("Customization (pkg, appName, source, panels, count, labels, ...)."),
      },
    },
    async ({ name, config }) => {
      const exp = EXPERIENCES.find((e) => e.name === name);
      if (!exp) return okJson({ status: "error", error: `unknown experience '${name}'`, available: EXPERIENCES.map((e) => e.name) });
      const recipe = exp.recipe(config ?? {});
      return okJson({ status: "ok", name: exp.name, title: exp.title, lane: exp.lane, capabilities: exp.capabilities, oneCommand: exp.oneCommand ?? null, recipe, evidence: exp.evidence, honesty: "Executing the recipe still requires a looked-at capture per visual claim (record_verification). This is a build plan, not a claim." });
    },
  );
}
