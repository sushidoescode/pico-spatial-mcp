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

const run = promisify(execFile);

/**
 * fleetbuild.ts — v10.4 (P2): the UNATTENDED fleet builder.
 *
 * `fleet_build` takes brief ids from briefs/ and, for each (SERIALLY — one emulator):
 * scaffold → execute the compile ledger's generate steps by SELF-DRIVING this same MCP server
 * over stdio (a child `node dist/index.js`) → write emitted files (wiring/panels/menu handled) →
 * gradle assembleDebug → install + launch on the emulator → settle → deterministic forward
 * capture → `visual_judge` against the brief's expectation → a PASS records `auto_judged`
 * (NEVER vision_verified — the honesty split holds unattended).
 */

const ADB = path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb");
const JBR = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
const TEMPLATE = path.join(os.homedir(), "AndroidStudioProjects/galleryxr-native");
const MENU_BUNDLE = path.join(os.homedir(), "AndroidStudioProjects/showroomxr-native/app/src/main/assets/menu.bundle");

type Step = { order: number; tool: string; args: any; targetPath: string; note?: string };

async function selfClient() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const here = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  const transport = new StdioClientTransport({ command: "node", args: [path.join(here, "index.js")], cwd: path.dirname(here) });
  const client = new Client({ name: "fleet-executor", version: "1" });
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
  if (name && !m.includes(name)) {
    m = m.replace("    </application>", `        ${entry}\n    </application>`);
    fs.writeFileSync(mf, m);
  }
}

const PALETTE_ITEMS = [
  { id: "item0", label: "Item 0", color: [0.85, 0.12, 0.2] },
  { id: "item1", label: "Item 1", color: [0.95, 0.6, 0.1] },
  { id: "item2", label: "Item 2", color: [0.95, 0.9, 0.2] },
  { id: "item3", label: "Item 3", color: [0.15, 0.75, 0.35] },
  { id: "item4", label: "Item 4", color: [0.2, 0.45, 0.9] },
  { id: "item5", label: "Item 5", color: [0.6, 0.25, 0.85] },
];

export function registerFleetBuildTools(server: McpServer) {
  server.registerTool(
    "fleet_build",
    {
      description:
        "UNATTENDED end-to-end fleet build (P2): for each brief id (briefs/<id>.json), SERIALLY scaffold a fresh app, execute the compile ledger's generate steps (self-driving this MCP over stdio), write the emitted Kotlin/wiring/panel/menu files (manifest patched, menu.bundle + items.json provisioned), gradle-build, install + launch on emulator-5554, settle, take the deterministic forward capture, and judge it with the calibrated eye (visual_judge). A confident PASS records an `auto_judged` ledger entry — NEVER vision_verified (the honesty split holds unattended); an ESCALATE names the brief for a human LOOK. Returns the fleet-build dashboard (per brief: built/installed/verdict/artifact). Requires the local toolchain + a running emulator. Briefs whose environments need external assets (splat/pano files) are skipped with a reason.",
      inputSchema: {
        briefIds: z.array(z.string()).min(1).describe("Brief ids from briefs/ (e.g. ['knockdown','studio','console'])."),
        projectsRoot: z.string().optional().describe("Where per-brief projects go (default ~/AndroidStudioProjects). Dir per brief: fleet-<id>-native (reused if present)."),
        settleSec: z.number().optional().describe("Seconds to wait after launch before capturing (default 12)."),
        minObjects: z.record(z.number()).optional().describe("Per-brief judge expectation override, e.g. {knockdown: 2}. Default: 2 foreground objects + notMostlyBlack."),
      },
    },
    async ({ briefIds, projectsRoot, settleSec, minObjects }) => {
      const root = projectsRoot ?? path.join(os.homedir(), "AndroidStudioProjects");
      const briefsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../briefs");
      const settle = (settleSec ?? 12) * 1000;
      const results: any[] = [];
      const { client, call } = await selfClient();
      try {
        for (const id of briefIds) {
          const rec: any = { id, built: false, installed: false, verdict: null, artifact: null, notes: [] };
          results.push(rec);
          try {
            const briefPath = path.join(briefsDir, `${id}.json`);
            if (!fs.existsSync(briefPath)) { rec.notes.push("brief not found"); continue; }
            const entry = JSON.parse(fs.readFileSync(briefPath, "utf8"));
            const parsed = appSpecSchema.safeParse(entry.spec);
            if (!parsed.success) { rec.notes.push("spec invalid"); continue; }
            const spec: any = parsed.data;
            const env = spec.scenes[0]?.environment?.kind;
            if (env === "splat" || env === "pano" || env === "texturedMesh") { rec.notes.push(`skipped: env '${env}' needs an external asset`); continue; }

            // unique fleet identity so installs never collide with dev apps
            const pkg = `com.fleet.${id}`;
            spec.meta.packageName = pkg;
            spec.meta.appName = `Fleet${id[0].toUpperCase()}${id.slice(1)}`;
            const projectDir = path.join(root, `fleet-${id}-native`);

            // 1. scaffold (idempotent)
            if (!fs.existsSync(projectDir)) {
              const sc = await call("scaffold_spatial_app", { templateProject: TEMPLATE, targetDir: projectDir, packageName: pkg, appName: spec.meta.appName, stageStyle: spec.meta.stageStyle ?? "3" });
              if (!sc.created) { rec.notes.push(`scaffold failed: ${JSON.stringify(sc).slice(0, 150)}`); continue; }
            }
            const jdir = path.join(projectDir, `app/src/main/java/${pkg.replace(/\./g, "/")}`);

            // 2. execute the ledger's generate steps
            const steps = buildLedger(spec, projectDir) as Step[];
            let wiringFailed = false;
            for (const st of steps) {
              if (st.tool === "scaffold_spatial_app" || st.tool === "build_and_run" || st.tool === "generate_agent_bridge") continue; // scaffolded template already has the bridge
              const out = await call(st.tool, st.args);
              if (st.tool === "generate_app_wiring") {
                // v15.0: a wiring failure must be LOUD — an app without its wiring silently runs on
                // the scaffold template's HomeStage (spec objects never spawn; the judge counts
                // template pins). That was the pre-v15 fleet state.
                if (!Array.isArray(out.files) || out.files.length === 0) {
                  rec.notes.push(`generate_app_wiring emitted NO files (${JSON.stringify(out).slice(0, 160)}) — aborting this brief instead of shipping a template-wired app`);
                  wiringFailed = true;
                  break;
                }
                for (const f of out.files) {
                  const fp = f.path.startsWith("/") ? f.path : path.join(projectDir, f.path);
                  fs.mkdirSync(path.dirname(fp), { recursive: true });
                  fs.writeFileSync(fp, f.content);
                }
                continue;
              }
              // structured returns (panels) carry kotlin + manifestEntry; plain returns are the Kotlin text
              const kotlin = typeof out === "string" ? out : out.kotlin;
              if (typeof kotlin !== "string" || !kotlin.includes("package ")) { rec.notes.push(`${st.tool}: unexpected output`); continue; }
              const target = st.targetPath.startsWith("/") ? st.targetPath : path.join(projectDir, st.targetPath);
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, kotlin);
              if (typeof out === "object" && out.manifestEntry) patchManifest(projectDir, out.manifestEntry);
              if (st.tool === "generate_game_menu_kotlin" && fs.existsSync(MENU_BUNDLE)) {
                fs.mkdirSync(path.join(projectDir, "app/src/main/assets"), { recursive: true });
                fs.copyFileSync(MENU_BUNDLE, path.join(projectDir, "app/src/main/assets/menu.bundle"));
              }
            }
            if (wiringFailed) continue; // recorded above — do not build/judge a template-wired app
            // data briefs need the bundled catalog
            if (spec.data?.length) {
              const dd = path.join(projectDir, "app/src/main/assets/data");
              fs.mkdirSync(dd, { recursive: true });
              fs.writeFileSync(path.join(dd, "items.json"), JSON.stringify(PALETTE_ITEMS.slice(0, spec.layouts?.[0]?.count ?? 6), null, 2));
            }

            // 3. build + install + launch
            const envv = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? JBR };
            await run("./gradlew", [":app:assembleDebug", "-q"], { cwd: projectDir, env: envv, timeout: 480_000, maxBuffer: 32 * 1024 * 1024 });
            rec.built = true;
            const apk = path.join(projectDir, "app/build/outputs/apk/debug/app-debug.apk");
            await run(ADB, ["-s", "emulator-5554", "install", "-r", apk], { timeout: 240_000 });
            await run(ADB, ["-s", "emulator-5554", "shell", "am", "force-stop", pkg], { timeout: 15_000 });
            await run(ADB, ["-s", "emulator-5554", "shell", "am", "start", "-S", "-n", `${pkg}/.platform.LaunchActivity`], { timeout: 30_000 });
            // launch_blocked guard (P1 cold-run finding): a stale foreground activity can silently block the start
            const fg = await run(ADB, ["-s", "emulator-5554", "shell", "dumpsys", "activity", "activities"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
            if (!String(fg.stdout).split("topResumedActivity").slice(1, 2).join("").includes(pkg)) {
              const m = String(fg.stdout).match(/topResumedActivity=ActivityRecord\{\S+ u0 ([\w.]+)\//);
              if (m && m[1] !== pkg) {
                await run(ADB, ["-s", "emulator-5554", "shell", "am", "force-stop", m[1]], { timeout: 15_000 }).catch(() => {});
                await run(ADB, ["-s", "emulator-5554", "shell", "am", "start", "-S", "-n", `${pkg}/.platform.LaunchActivity`], { timeout: 30_000 });
                rec.notes.push(`launch_blocked by ${m[1]} — force-stopped + relaunched`);
                await new Promise((r) => setTimeout(r, settle)); // fresh settle after the recovery relaunch
              }
            }
            // final foreground check — capture only what is actually on stage (the eye catches it anyway,
            // but noting it here names the cause instead of just ESCALATE)
            const fg2 = await run(ADB, ["-s", "emulator-5554", "shell", "dumpsys", "activity", "activities"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
            if (!String(fg2.stdout).match(new RegExp(`topResumedActivity=ActivityRecord\\{\\S+ u0 ${pkg.replace(/\./g, "\\.")}[/]`))) {
              rec.notes.push("app not foreground at capture time — the frame shows whatever IS on stage");
            }
            rec.installed = true;
            await new Promise((r) => setTimeout(r, settle));

            // 4. deterministic forward capture + the calibrated eye
            const shotDir = `/tmp/pico-render/fleet/${id}`;
            fs.mkdirSync(shotDir, { recursive: true });
            const shot = path.join(shotDir, "forward.png");
            const png = await run(ADB, ["-s", "emulator-5554", "exec-out", "screencap", "-p"], { timeout: 30_000, encoding: "buffer" as any, maxBuffer: 32 * 1024 * 1024 });
            fs.writeFileSync(shot, png.stdout as any);
            rec.artifact = shot;
            const claim = entry.spec?.verificationPlan?.[0]?.claim ?? `${id} renders`;
            const judged = await call("visual_judge", {
              imagePath: shot,
              claim: `[fleet_build unattended] ${claim}`,
              expect: { minObjects: minObjects?.[id] ?? 2, notMostlyBlack: true },
              app: pkg,
              record: true,
              cClass: "C0_emulator",
            });
            rec.verdict = judged.verdict ?? judged.status ?? "unknown";
            rec.confidence = judged.confidence;
            if (rec.verdict !== "PASS") rec.notes.push("ESCALATE: a human must LOOK at the artifact");
          } catch (e: any) {
            rec.notes.push(`error: ${String(e?.message ?? e).slice(0, 300)}`);
          }
        }
      } finally {
        await client.close().catch(() => {});
      }
      const passed = results.filter((r) => r.verdict === "PASS").length;
      return okJson({
        status: "ok",
        dashboard: { queued: briefIds.length, built: results.filter((r) => r.built).length, installed: results.filter((r) => r.installed).length, autoJudgedPass: passed, escalations: results.filter((r) => r.installed && r.verdict !== "PASS").map((r) => r.id) },
        results,
        honesty: "auto_judged is a DISTINCT evidence class — a fleet PASS is the eye's count, never human sight. ESCALATEd briefs need a human LOOK at the artifact.",
      });
    },
  );
}
