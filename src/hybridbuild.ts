import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";
import { buildLedger } from "./compiler.js";
import { appSpecSchema } from "./appspec.js";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ADB = process.env.PICO_ADB ?? path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb");
const JBR = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
// v29.3: scaffold_spatial_app now generates from the packaged skeleton (no templateProject),
// and the GameMenu bundle ships in the package — no machine-local paths in the hybrid lane.
import { MENU_BUNDLE_ASSET } from "./projectgen.js";

/**
 * hybridbuild.ts — v10.19 (P17): the one-command HYBRID experience builder.
 *
 * Executes what compile_spatial_experience PLANS: from a brief, build a complete HYBRID app —
 * a native Filament 3D scene (physics game via a template) + an HTML web CONTROL panel (the
 * web↔3D bridge: buttons drive the scene) + a live-text HUD panel — scaffolded, generated, built,
 * installed, launched, and captured, all unattended. Composes the verified generators; records the
 * result honestly (auto_judged, escalates to a human LOOK).
 */
async function selfClient() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  // Pin the full surface: the SDK's whitelist child env drops PICO_MCP_SURFACE, and since v36.3
  // unset means doors — this client calls full-surface-only tools (2026-08-12 review finding).
  const transport = new StdioClientTransport({ command: "node", args: [path.join(here, "index.js")], cwd: path.dirname(here), env: { PICO_MCP_SURFACE: "full" } });
  const client = new Client({ name: "hybrid-builder", version: "1" });
  await client.connect(transport);
  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
    try { return JSON.parse(text); } catch { return text; }
  };
  return { client, call };
}
function patchManifest(projectDir: string, entry: string) {
  const mf = path.join(projectDir, "app/src/main/AndroidManifest.xml");
  let m = fs.readFileSync(mf, "utf8");
  const name = entry.match(/android:name="([^"]+)"/)?.[1] ?? "";
  if (name && !m.includes(name)) { m = m.replace("    </application>", `        ${entry}\n    </application>`); fs.writeFileSync(mf, m); }
}

export function registerHybridBuildTools(server: McpServer) {
  server.registerTool(
    "build_hybrid_experience",
    {
      description:
        "ONE COMMAND -> a complete HYBRID spatial app (P17, the autonomy capstone). From a brief + config, scaffolds a fresh MIXED-stage (MR default) app, builds a native 3D physics scene (a game template: physics + clickable menu + live-text HUD), adds an HTML web CONTROL panel wired to the scene via the web↔3D bridge, builds/installs/launches, opens the scene + control panel, and captures the composited workspace — all unattended. Composes the verified generators; records the result (auto_judged via the eye's color-keyed MR lane when the template has >= 2 distinct authored colors; otherwise escalates to a human LOOK — passthrough frames never auto-pass on the count checks). Requires the toolchain + a running emulator. Returns {built, installed, artifact, verdict, surfaces}.",
      inputSchema: {
        appName: z.string().describe("App display name, e.g. 'BowlDeck'."),
        packageName: z.string().describe("applicationId, e.g. com.demo.bowldeck."),
        game: z.enum(["knockdown"]).optional().describe("The native game template (default knockdown = physics + menu + scoreboard)."),
        controls: z.array(z.object({ label: z.string(), cmd: z.string() })).optional().describe("Web control-panel buttons (default THROW->start, RESET->reset)."),
        projectsRoot: z.string().optional().describe("Where the project goes (default ~/AndroidStudioProjects)."),
      },
    },
    async ({ appName, packageName, game, controls, projectsRoot }) => {
      const root = projectsRoot ?? path.join(os.homedir(), "AndroidStudioProjects");
      const dirName = appName.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-native";
      const projectDir = path.join(root, dirName);
      const jdir = path.join(projectDir, `app/src/main/java/${packageName.replace(/\./g, "/")}`);
      const ctrls = controls ?? [{ label: "THROW", cmd: "start" }, { label: "RESET", cmd: "reset" }];
      const rec: any = { appName, packageName, projectDir, built: false, installed: false, surfaces: [], notes: [] };
      const { client, call } = await selfClient();
      try {
        // 1. scaffold — Mixed stage ("1") is the MR product default (v32); Full Space ("3") remains
        // an explicit opt-in at the scaffold_spatial_app level, not something this lane hardcodes.
        if (!fs.existsSync(projectDir)) {
          const sc = await call("scaffold_spatial_app", { targetDir: projectDir, packageName, appName, stageStyle: "1" });
          if (!sc.created) { rec.notes.push(`scaffold failed: ${JSON.stringify(sc).slice(0, 160)}`); return okJson({ status: "error", ...rec }); }
        }
        // 2. the native scene: instantiate the game template -> compile -> execute the ledger
        const inst = await call("instantiate_template", { name: game ?? "knockdown", brief: appName, appName, packageName, count: 3 });
        const spec = appSpecSchema.parse(inst.spec);
        // The Mixed-stage capture is a passthrough frame, where the eye's count/black checks are
        // advisory by design — give the judge the spec's authored body colors so the color-keyed MR
        // lane can score. A weak (mostly neutral) palette escalates honestly to a human LOOK.
        const authoredColors = (spec.objects ?? []).filter((o) => o.body?.color).map((o) => ({ name: o.id, color: o.body!.color as number[] }));
        const steps = buildLedger(spec as any, projectDir) as any[];
        for (const st of steps) {
          if (["scaffold_spatial_app", "build_and_run", "generate_agent_bridge"].includes(st.tool)) continue;
          const out = await call(st.tool, st.args);
          if (st.tool === "generate_app_wiring") {
            for (const f of out.files ?? []) { const fp = f.path.startsWith("/") ? f.path : path.join(projectDir, f.path); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, f.content); }
            continue;
          }
          const kotlin = typeof out === "string" ? out : out.kotlin;
          if (typeof kotlin !== "string" || !kotlin.includes("package ")) { rec.notes.push(`${st.tool}: unexpected output`); continue; }
          const target = st.targetPath.startsWith("/") ? st.targetPath : path.join(projectDir, st.targetPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, kotlin);
          if (typeof out === "object" && out.manifestEntry) patchManifest(projectDir, out.manifestEntry);
          if (st.tool === "generate_game_menu_kotlin" && fs.existsSync(MENU_BUNDLE_ASSET)) { fs.mkdirSync(path.join(projectDir, "app/src/main/assets"), { recursive: true }); fs.copyFileSync(MENU_BUNDLE_ASSET, path.join(projectDir, "app/src/main/assets/menu.bundle")); }
        }
        rec.surfaces.push("native 3D scene (physics + menu + HUD)");
        // 3. the web CONTROL panel (the bridge)
        const bridge = await call("generate_web_bridge_kotlin", { packageName: `${packageName}.content`, title: `${appName.toUpperCase()} CONTROL`, controls: ctrls });
        fs.writeFileSync(path.join(jdir, "content/WebControlPanel.kt"), bridge.kotlin);
        patchManifest(projectDir, bridge.manifestEntry);
        rec.surfaces.push("web control panel (HTML buttons -> native scene via bridge)");
        // 4. build
        const envv = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? JBR };
        await run("./gradlew", [":app:assembleDebug", "-q"], { cwd: projectDir, env: envv, timeout: 480_000, maxBuffer: 32 * 1024 * 1024 });
        rec.built = true;
        const apk = path.join(projectDir, "app/build/outputs/apk/debug/app-debug.apk");
        await run(ADB, ["-s", "emulator-5554", "install", "-r", apk], { timeout: 240_000 });
        // launch scene, then control panel (each its own spatial surface)
        await run(ADB, ["-s", "emulator-5554", "shell", "am", "start", "-S", "-n", `${packageName}/.platform.LaunchActivity`], { timeout: 30_000 });
        rec.installed = true;
        await new Promise((r) => setTimeout(r, 12_000));
        await run(ADB, ["-s", "emulator-5554", "shell", "am", "start", "-n", `${packageName}/${packageName}.content.WebControlPanelActivity`], { timeout: 30_000 });
        await new Promise((r) => setTimeout(r, 6_000));
        // 5. capture the composited workspace
        const shotDir = `/tmp/pico-render/hybrid/${dirName}`;
        fs.mkdirSync(shotDir, { recursive: true });
        const shot = path.join(shotDir, "workspace.png");
        const png = await run(ADB, ["-s", "emulator-5554", "exec-out", "screencap", "-p"], { timeout: 30_000, encoding: "buffer" as any, maxBuffer: 32 * 1024 * 1024 });
        fs.writeFileSync(shot, png.stdout as any);
        rec.artifact = shot;
        const judged = await call("visual_judge", { imagePath: shot, claim: `[build_hybrid_experience] ${appName}: native scene + web control panel composited`, expect: { minObjects: 2, notMostlyBlack: true, ...(authoredColors.length ? { authoredColors } : {}) }, app: packageName, record: true, cClass: "C0_emulator" });
        rec.verdict = judged.verdict ?? judged.status;
        if (rec.verdict !== "PASS") rec.notes.push("ESCALATE: LOOK at the workspace artifact (Mixed-stage passthrough capture — the eye auto-passes only via >= 2 distinct authored colors)");
        return okJson({ status: "ok", ...rec, note: "A complete hybrid app built + launched unattended. The control panel's buttons drive the native scene (web↔3D bridge). auto_judged; LOOK at the artifact to confirm the composited workspace." });
      } catch (e: any) {
        rec.notes.push(`error: ${String(e?.message ?? e).slice(0, 300)}`);
        return okJson({ status: "error", ...rec });
      } finally {
        await client.close().catch(() => {});
      }
    },
  );
}
