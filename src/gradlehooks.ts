import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { okJson } from "./util.js";

/**
 * gradlehooks.ts — v9.5 the EXTERNAL GRADLE PLUGIN (com.pico.hooks).
 *
 * A real convention plugin, installed as a composite build (includeBuild), that hooks PICO's own
 * pack pipeline: `validateSpatialScenes` runs BEFORE every spatial_pack_task* (the
 * com.pico.spatial.tools plugin auto-wires pack into assemble, so the lint rides EVERY build —
 * Android Studio, CLI, CI — with no MCP in the loop). The recon (PLUGINS.md) found no public
 * action registry in com.pico.spatial.tools; tasks.matching("spatial_pack_task*") is the clean seam.
 */

const PLUGIN_BUILD = `plugins {
    \`kotlin-dsl\`
}

repositories {
    mavenCentral()
    gradlePluginPortal()
}

gradlePlugin {
    plugins {
        create("picoHooks") {
            id = "com.pico.hooks"
            implementationClass = "com.pico.hooks.PicoHooksPlugin"
        }
    }
}
`;

const PLUGIN_SETTINGS = `rootProject.name = "pico-hooks"
`;

const PLUGIN_SRC = `package com.pico.hooks

import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import java.io.File

/**
 * com.pico.hooks — external hooks riding PICO's spatial pack pipeline.
 * validateSpatialScenes lints the USD scenes in src/main/res3d BEFORE every spatial_pack_task*,
 * so verified past failures (the retained-lessons rules) block a broken bundle at BUILD time.
 */
class PicoHooksPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val validate = project.tasks.register("validateSpatialScenes") {
            group = "pico hooks"
            description = "Lint USD scenes in res3d before spatial_pack_task (retained-lessons rules)"
            doLast {
                val res3d = project.file("src/main/res3d")
                if (!res3d.exists()) { println("[pico-hooks] no res3d dir - skipping"); return@doLast }
                val usda = res3d.walkTopDown().filter { it.extension == "usda" }.toList()
                if (usda.isEmpty()) throw GradleException("[pico-hooks] no .usda scenes under res3d - spatialbundle pack will fail")
                val problems = mutableListOf<String>()
                usda.forEach { f ->
                    val text = f.readText()
                    // Rule (conditional, mirrors the MCP lint engine): displayColor WITHOUT any Material/Shader
                    // means it is the only coloring mechanism - renders FLAT UNLIT WHITE on-device. Editor-baked
                    // scenes carry displayColor alongside real materials, which is harmless.
                    if (text.contains("displayColor") && !text.contains("Material") && !text.contains("Shader")) {
                        problems.add(f.name + ": primvars:displayColor is the only coloring (no Material/Shader) - renders FLAT UNLIT WHITE on-device")
                    }
                    // Rule: relative @reference@ targets must exist on disk (broken refs fail the pack or render nothing).
                    Regex("@([^@\\n]+)@").findAll(text).forEach { m ->
                        val ref = m.groupValues[1]
                        if (!ref.startsWith("/") && !ref.startsWith("./Sources") && !File(f.parentFile, ref).exists()) {
                            problems.add(f.name + ": broken reference @" + ref + "@")
                        }
                    }
                }
                if (problems.isNotEmpty()) {
                    throw GradleException("[pico-hooks] scene lint FAILED:\\n" + problems.joinToString("\\n"))
                }
                println("[pico-hooks] validateSpatialScenes: " + usda.size + " scene(s) clean")
            }
        }
        project.plugins.withId("com.pico.spatial.tools") {
            project.tasks.matching { it.name.startsWith("spatial_pack_task") }.configureEach { dependsOn(validate) }
        }
    }
}
`;

export function registerGradleHooksTools(server: McpServer) {
  server.registerTool(
    "install_gradle_hooks",
    {
      description:
        "Install the EXTERNAL gradle plugin `com.pico.hooks` into a PICO spatial project as a composite build: writes <project>/pico-hooks/ (a real Plugin<Project>), adds includeBuild to settings.gradle.kts pluginManagement, and applies the plugin id on the editor-asset module. The plugin hooks PICO's own pipeline — `validateSpatialScenes` (USD lint: displayColor flat-white rule + broken @reference@ targets) runs BEFORE every spatial_pack_task*, and since com.pico.spatial.tools auto-wires pack into assemble, the lint rides EVERY build (Android Studio, CLI, CI) with no MCP in the loop. Verified: a planted displayColor defect FAILS the build with the rule message; clean scenes pass. Idempotent.",
      inputSchema: {
        projectDir: z.string().describe("The spatial app project root (has settings.gradle.kts + an editor-asset module applying com.pico.spatial.tools)."),
      },
    },
    async ({ projectDir }) => {
      const hooksDir = path.join(projectDir, "pico-hooks");
      fs.mkdirSync(path.join(hooksDir, "src/main/kotlin/com/pico/hooks"), { recursive: true });
      fs.writeFileSync(path.join(hooksDir, "build.gradle.kts"), PLUGIN_BUILD);
      fs.writeFileSync(path.join(hooksDir, "settings.gradle.kts"), PLUGIN_SETTINGS);
      fs.writeFileSync(path.join(hooksDir, "src/main/kotlin/com/pico/hooks/PicoHooksPlugin.kt"), PLUGIN_SRC);

      const changes: string[] = ["wrote pico-hooks/ (plugin project)"];

      // settings.gradle.kts: includeBuild inside pluginManagement
      const settingsPath = path.join(projectDir, "settings.gradle.kts");
      if (!fs.existsSync(settingsPath)) return okJson({ status: "error", error: "settings.gradle.kts not found" });
      let settings = fs.readFileSync(settingsPath, "utf8");
      if (!settings.includes('includeBuild("pico-hooks")')) {
        if (!settings.includes("pluginManagement {")) return okJson({ status: "error", error: "no pluginManagement block in settings.gradle.kts" });
        settings = settings.replace("pluginManagement {", 'pluginManagement {\n    includeBuild("pico-hooks")');
        fs.writeFileSync(settingsPath, settings);
        changes.push("settings.gradle.kts: includeBuild added to pluginManagement");
      }

      // editor-asset build file (Groovy or kts): apply the plugin id
      for (const bf of ["editor-asset/build.gradle", "editor-asset/build.gradle.kts"]) {
        const bp = path.join(projectDir, bf);
        if (!fs.existsSync(bp)) continue;
        let b = fs.readFileSync(bp, "utf8");
        if (!b.includes("com.pico.hooks")) {
          const line = bf.endsWith(".kts") ? '    id("com.pico.hooks")' : "    id 'com.pico.hooks'";
          b = b.replace("plugins {", `plugins {\n${line}`);
          fs.writeFileSync(bp, b);
          changes.push(`${bf}: plugin id applied`);
        }
        break;
      }

      return okJson({
        status: "ok",
        changes,
        verify: "Run: ./gradlew :editor-asset:spatial_pack_task — expect '[pico-hooks] validateSpatialScenes: N scene(s) clean' before pack. Plant 'displayColor' in a .usda to see the build FAIL with the rule message.",
      });
    },
  );
}
