import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { okJson } from "./util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = path.join(ROOT, "appskeleton", "gradle", "libs.versions.toml");
const APP_GRADLE = path.join(ROOT, "appskeleton", "app", "build.gradle.kts");

function value(text: string, pattern: RegExp): string | null { return text.match(pattern)?.[1] ?? null; }

/** Extract observed build values from the packaged scaffold, keeping each source path inspectable. */
export function extractBuildMatrix() {
  const catalog = fs.readFileSync(CATALOG, "utf8");
  const appGradle = fs.readFileSync(APP_GRADLE, "utf8");
  const observed = {
    compileSdk: value(appGradle, /compileSdk\s*=\s*(\d+)/), minSdk: value(appGradle, /minSdk\s*=\s*(\d+)/), targetSdk: value(appGradle, /targetSdk\s*=\s*(\d+)/),
    javaTarget: value(appGradle, /JavaVersion\.VERSION_(\d+)/), kotlinJvmTarget: value(appGradle, /jvmTarget\s*=\s*["'](\d+)/),
    agp: value(catalog, /^agp\s*=\s*["']([^"']+)/m), kotlin: value(catalog, /^kotlin\s*=\s*["']([^"']+)/m), bom: value(catalog, /^bom\s*=\s*["']([^"']+)/m),
    composePlugin: value(catalog, /^kotlin\s*=\s*["']([^"']+)/m), abi: value(appGradle, /abiFilters\.(?:add)\(\s*["']([^"']+)/), spatialToolsVersion: { status: "not-declared" as const },
  };
  return {
    observed,
    sourceFiles: [CATALOG, APP_GRADLE],
    sourcePaths: { catalog: CATALOG, appGradle: APP_GRADLE },
    extractionFailures: Object.entries(observed).filter(([key, value]) => key !== "spatialToolsVersion" && value === null).map(([key]) => key),
    caveat: "Observed source configuration only; this does not prove dependency resolution, a successful build, install, launch, or rendered result. spatialToolsVersion is not declared in the checked-in catalog.",
  };
}

export function registerBuildMatrixTools(server: McpServer): void {
  server.registerTool("build_matrix_report", {
    description: "Return observed SDK, Java, AGP, Kotlin, Compose BOM, ABI, and spatial-tools declaration state from the packaged app skeleton. This is source-grounded configuration evidence, not a build or runtime claim.",
    inputSchema: {},
  }, async () => okJson(extractBuildMatrix()));
}
