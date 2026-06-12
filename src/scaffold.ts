import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, okJson } from "./util.js";
import { resolveToolsRoot } from "./toolchain.js";

/**
 * Generalized native PICO spatial-app scaffolding — the core "build any project"
 * capability. Clones a known-good spatial app (the only reliable way to get a
 * buildable Gradle + PICO-SDK + modified-Compose project), renames its package,
 * sets the app name/stage, and optionally swaps in a scene — producing a fresh,
 * immediately buildable app. This is what makes the MCP a general spatial-app
 * builder, not a ClaimSight-specific one.
 */

const TEXT_EXT = new Set([".kt", ".kts", ".gradle", ".xml", ".toml", ".properties", ".pro", ".usda", ".md", ".json"]);

function detectPackage(appBuildGradle: string): string | null {
  if (!fs.existsSync(appBuildGradle)) return null;
  const m = fs.readFileSync(appBuildGradle, "utf8").match(/namespace\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

function walkFiles(dir: string, skip: (name: string) => boolean): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(p);
    }
  };
  rec(dir);
  return out;
}

export function registerScaffoldTools(server: McpServer) {
  server.registerTool(
    "scaffold_spatial_app",
    {
      description:
        "Create a fresh, immediately-buildable native PICO spatial app by cloning a known-good template app and rebranding it: renames the package across all sources + the Java dir tree, sets the app display name and stage style, points local.properties at the resolved PICO toolchain, and (optionally) installs a scene .usda. Returns the new project path — then author HomeStage.kt + a scene and run build_and_run. This is the general 'start a new spatial project' entry point (works for any app, not just ClaimSight).",
      inputSchema: {
        templateProject: z
          .string()
          .describe("Path to a working PICO spatial app to clone (has :app + :editor-asset modules, e.g. an existing built app or the PICO starter)"),
        targetDir: z.string().describe("Directory to create the new app in (must not exist)"),
        packageName: z
          .string()
          .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
          .describe("New application id / package, e.g. 'com.acme.viz'"),
        appName: z.string().describe("Display name (app_name + homepage_title)"),
        stageStyle: z.enum(["1", "2", "3"]).default("3").describe("PICO stage style: 1=Mixed, 2=Progressive, 3=Full(100% virtual, fills view)"),
        sceneUsda: z.string().optional().describe("Optional path to a .usda to install as the scene (model name becomes its filename stem; default keeps the template scene)"),
      },
    },
    async ({ templateProject, targetDir, packageName, appName, stageStyle, sceneUsda }) => {
      const src = expandHome(templateProject);
      const dst = expandHome(targetDir);
      if (!fs.existsSync(path.join(src, "settings.gradle.kts")) && !fs.existsSync(path.join(src, "settings.gradle")))
        return fail(`Template '${src}' is not a Gradle project (no settings.gradle[.kts]).`);
      if (fs.existsSync(dst)) return fail(`Target already exists: ${dst}`);

      const appGradle = fs.existsSync(path.join(src, "app/build.gradle.kts")) ? path.join(src, "app/build.gradle.kts") : path.join(src, "app/build.gradle");
      const oldPkg = detectPackage(appGradle);
      if (!oldPkg) return fail(`Could not detect the template's package (namespace) in ${appGradle}`);

      // 1. Copy the project, excluding build artifacts.
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try {
        execFileSync("rsync", ["-a", "--exclude", "build", "--exclude", ".gradle", "--exclude", ".idea", "--exclude", ".kotlin", "--exclude", ".git", `${src}/`, `${dst}/`], {
          timeout: 120_000,
        });
      } catch (e: any) {
        return fail(`Copy failed: ${e.message}`);
      }

      // 2. Rename the Java package directory tree (app module).
      const oldPath = oldPkg.replace(/\./g, "/");
      const newPath = packageName.replace(/\./g, "/");
      for (const moduleJava of ["app/src/main/java", "app/src/test/java", "app/src/androidTest/java"]) {
        const oldDir = path.join(dst, moduleJava, oldPath);
        const newDir = path.join(dst, moduleJava, newPath);
        if (fs.existsSync(oldDir)) {
          fs.mkdirSync(path.dirname(newDir), { recursive: true });
          fs.renameSync(oldDir, newDir);
          // prune now-empty old ancestor dirs
          let anc = path.dirname(oldDir);
          while (anc.startsWith(path.join(dst, moduleJava)) && fs.existsSync(anc) && fs.readdirSync(anc).length === 0) {
            fs.rmdirSync(anc);
            anc = path.dirname(anc);
          }
        }
      }

      // 3. Replace the package string everywhere in text files.
      const files = walkFiles(dst, (n) => n === "build" || n === ".gradle" || n === ".idea" || n === ".kotlin" || n === ".git");
      let replaced = 0;
      for (const f of files) {
        if (!TEXT_EXT.has(path.extname(f))) continue;
        const before = fs.readFileSync(f, "utf8");
        if (!before.includes(oldPkg)) continue;
        fs.writeFileSync(f, before.split(oldPkg).join(packageName));
        replaced++;
      }

      // 4. App name + stage style + strings.
      const stringsXml = path.join(dst, "app/src/main/res/values/strings.xml");
      if (fs.existsSync(stringsXml)) {
        let s = fs.readFileSync(stringsXml, "utf8");
        s = s.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${appName}$2`);
        s = s.replace(/(<string name="homepage_title">)[^<]*(<\/string>)/, `$1${appName}$2`);
        fs.writeFileSync(stringsXml, s);
      }
      const manifest = path.join(dst, "app/src/main/AndroidManifest.xml");
      if (fs.existsSync(manifest)) {
        let m = fs.readFileSync(manifest, "utf8");
        m = m.replace(/(pico\.spatial\.stage\.style"\s*\n?\s*android:value=")[0-9]+(")/, `$1${stageStyle}$2`);
        fs.writeFileSync(manifest, m);
      }

      // 5. local.properties: keep the copied sdk.dir etc., just ensure spatial.tools.dir.
      const { root } = resolveToolsRoot();
      const lp = path.join(dst, "local.properties");
      let lpContent = fs.existsSync(lp) ? fs.readFileSync(lp, "utf8") : "";
      if (/^\s*spatial\.tools\.dir\s*=/m.test(lpContent)) {
        lpContent = lpContent.replace(/^\s*spatial\.tools\.dir\s*=.*$/m, `spatial.tools.dir=${root}`);
      } else {
        lpContent = (lpContent.trimEnd() + `\nspatial.tools.dir=${root}\n`).replace(/^\n/, "");
      }
      fs.writeFileSync(lp, lpContent);

      // 6. Optional scene install.
      let sceneInstalled: string | null = null;
      if (sceneUsda) {
        const sceneSrc = expandHome(sceneUsda);
        if (!fs.existsSync(sceneSrc)) return fail(`sceneUsda not found: ${sceneSrc}`);
        // find the editor-asset scenes dir
        const scenesDirs = walkFiles(dst, (n) => n === "build").filter((p) => p.includes("/res3d/") && p.endsWith(".usda"));
        const scenesDir = scenesDirs.length ? path.dirname(scenesDirs[0]) : null;
        if (scenesDir) {
          const stem = path.basename(scenesDirs[0]); // keep the model name the template's HomeStage expects
          fs.copyFileSync(sceneSrc, path.join(scenesDir, stem));
          sceneInstalled = path.join(scenesDir, stem);
        } else {
          return fail("Could not locate the editor-asset res3d scenes dir to install sceneUsda.");
        }
      }

      const newJavaDir = path.join(dst, "app/src/main/java", newPath);
      return okJson({
        created: dst,
        packageName,
        renamedFrom: oldPkg,
        filesUpdated: replaced,
        appName,
        stageStyle,
        sceneInstalled,
        sourceDir: newJavaDir,
        homeStage: path.join(newJavaDir, "content/HomeStage.kt"),
        next: [
          `Author the UI in ${path.join(newJavaDir, "content/HomeStage.kt")} (SpatialView + AttachmentPanel; load the scene by model name).`,
          "Optionally compose_inspection_scene / compose_scene into the editor-asset scene, then verify_scene.",
          `build_and_run with projectDir='${dst}', packageName='${packageName}'.`,
        ],
      });
    },
  );
}
