import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson, run } from "./util.js";

/** Compose artifacts which must remain forked behind the PICO Spatial BOM. */
export const FORBIDDEN_COMPOSE_MODULES = [
  "androidx.compose.ui:ui",
  "androidx.compose.ui:ui-graphics",
  "androidx.compose.ui:ui-text",
  "androidx.compose.foundation:foundation",
] as const;

export type AuditSeverity = "error" | "warn";
export interface ProjectConfigFinding {
  severity: AuditSeverity;
  code: string;
  message: string;
  file?: string;
}
export interface ResolvedComposeFinding {
  artifact: string;
  parentChain: string[];
  line: string;
}
export interface ProjectConfigAudit {
  static: { errors: ProjectConfigFinding[]; warnings: ProjectConfigFinding[]; files: string[] };
  resolved: { status: "not-requested" | "ok" | "failed" | "timeout" | "unavailable"; findings: ResolvedComposeFinding[]; detail?: string };
  summary: string;
  evidence: string[];
  doesNotProve: string[];
}
export interface VerifyGradleConfigInput {
  projectDir: string;
  module?: string;
  configuration?: string;
  resolveTransitives?: boolean;
  timeoutMs?: number;
}
export type VerifyGradleConfigResult = ProjectConfigAudit;

function under(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== "..");
}

function collectProjectFiles(projectDir: string, errors: ProjectConfigFinding[]): string[] {
  let root: string;
  try { root = fs.realpathSync(projectDir); } catch {
    errors.push({ severity: "error", code: "project-not-found", message: `Project directory cannot be resolved: ${projectDir}` });
    return [];
  }
  const files: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if ([".gradle", "build", "node_modules", ".git"].includes(entry.name)) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(entryPath);
          if (!under(root, real)) errors.push({ severity: "error", code: "escaping-symlink", message: `Refusing to inspect symlink outside project root: ${entryPath} -> ${real}`, file: entryPath });
        } catch {
          errors.push({ severity: "error", code: "broken-symlink", message: `Cannot resolve symlink: ${entryPath}`, file: entryPath });
        }
        continue;
      }
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && (entry.name.endsWith(".gradle") || entry.name.endsWith(".gradle.kts") || entry.name.endsWith(".kt") || entry.name === "AndroidManifest.xml")) files.push(entryPath);
    }
  };
  visit(root);
  return files;
}

function fileText(file: string): string { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }

/** Static-only, realpath-contained audit. It never invokes Gradle or an emulator. */
export function auditProjectConfig(projectDir: string): ProjectConfigAudit {
  const errors: ProjectConfigFinding[] = [];
  const warnings: ProjectConfigFinding[] = [];
  const files = collectProjectFiles(projectDir, errors);
  const gradleFiles = files.filter((file) => file.endsWith(".gradle") || file.endsWith(".gradle.kts"));
  const gradle = gradleFiles.map(fileText).join("\n");
  for (const coordinate of FORBIDDEN_COMPOSE_MODULES) {
    const [group, name] = coordinate.split(":");
    const direct = new RegExp(`(?:implementation|api|compileOnly|runtimeOnly|debugImplementation|testImplementation|androidTestImplementation)\\s*(?:\\(\\s*)?["']${group.replace(/\./g, "\\.")}:${name}[^"']*["']`, "m");
    if (direct.test(gradle)) errors.push({ severity: "error", code: "forbidden-compose-direct", message: `Forbidden Compose direct dependency: ${coordinate}` });
    // The tighter paired check permits either named-argument ordering used by Gradle Kotlin/Groovy.
    const exclusionBlocks = [...gradle.matchAll(/exclude\s*\(([^)]*)\)/g)].map((m) => m[1]);
    const hasNamedExclusion = exclusionBlocks.some((block) =>
      new RegExp(`group\\s*(?:=|:)\\s*["']${group.replace(/\./g, "\\.")}["']`).test(block) &&
      new RegExp(`(?:module|name)\\s*(?:=|:)\\s*["']${name}["']`).test(block),
    );
    const hasPositionalExclusion = exclusionBlocks.some((block) => new RegExp(`^[\\s"']*${group.replace(/\./g, "\\.")}["']\\s*,\\s*["']${name}["']\\s*$`).test(block));
    if (!hasNamedExclusion && !hasPositionalExclusion) errors.push({ severity: "error", code: "missing-compose-exclusion", message: `Missing required exclusion for ${coordinate}` });
  }

  const manifestText = files.filter((file) => path.basename(file) === "AndroidManifest.xml").map(fileText).join("\n");
  const hasStageMeta = /<meta-data[^>]+android:name=["']pico\.spatial\.stage\./.test(manifestText);
  const hasWindowMeta = /<meta-data[^>]+android:name=["']pico\.spatial\.windowcontainer\./.test(manifestText);
  const kotlin = files.filter((file) => file.endsWith(".kt")).map(fileText).join("\n");
  const hasStageRoot = /\bDefaultStage\b/.test(kotlin);
  const hasWindowRoot = /\bDefaultWindowContainer\b/.test(kotlin);
  if (hasStageMeta && hasWindowMeta) warnings.push({ severity: "warn", code: "mixed-container-metadata", message: "Both pico.spatial.stage.* and pico.spatial.windowcontainer.* metadata are present." });
  if (hasStageRoot && hasWindowRoot) warnings.push({ severity: "warn", code: "duplicate-container-roots", message: "Multiple roots: both DefaultStage and DefaultWindowContainer are present." });
  if (hasStageMeta && hasWindowRoot && !hasStageRoot) errors.push({ severity: "error", code: "container-mode-mismatch", message: "Stage metadata requires DefaultStage; found DefaultWindowContainer." });
  if (hasWindowMeta && hasStageRoot && !hasWindowRoot) errors.push({ severity: "error", code: "container-mode-mismatch", message: "WindowContainer metadata requires DefaultWindowContainer; found DefaultStage." });

  return {
    static: { errors, warnings, files },
    resolved: { status: "not-requested", findings: [] },
    summary: `${errors.length} static error(s), ${warnings.length} warning(s); resolved dependency graph not requested.`,
    evidence: files,
    doesNotProve: ["Static source text cannot prove Gradle's resolved dependency graph.", "Static source text cannot prove a rendered frame or runtime behavior."],
  };
}

/** Parse a Gradle dependency tree without treating it as proof unless the explicit verifier ran it. */
export function parseResolvedComposeGraph(text: string): ResolvedComposeFinding[] {
  const parents: Array<{ indent: number; artifact: string }> = [];
  const findings: ResolvedComposeFinding[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([\s|]*)[+\\]---\s+([\w.-]+:[\w.-]+)/);
    if (!match) continue;
    const indent = match[1].replace(/\|/g, " ").length;
    const artifact = match[2];
    while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop();
    if (FORBIDDEN_COMPOSE_MODULES.includes(artifact as typeof FORBIDDEN_COMPOSE_MODULES[number])) {
      findings.push({ artifact, parentChain: parents.map((parent) => parent.artifact), line });
    }
    parents.push({ indent, artifact });
  }
  return findings;
}

/** Opt-in because Gradle can populate caches and contact repositories. */
export async function verifyGradleConfig(input: VerifyGradleConfigInput): Promise<VerifyGradleConfigResult> {
  const audit = auditProjectConfig(input.projectDir);
  if (!input.resolveTransitives) return audit;
  let root: string;
  try { root = fs.realpathSync(input.projectDir); } catch {
    return { ...audit, resolved: { status: "unavailable", findings: [], detail: "Project directory cannot be resolved for Gradle dependency resolution." } };
  }
  const wrapper = path.join(root, "gradlew");
  if (!fs.existsSync(wrapper)) return { ...audit, resolved: { status: "unavailable", findings: [], detail: "No Gradle wrapper at project root." } };
  try {
    const realWrapper = fs.realpathSync(wrapper);
    if (!under(root, realWrapper)) return { ...audit, resolved: { status: "unavailable", findings: [], detail: "Refusing a Gradle wrapper symlink outside the project root." } };
  } catch {
    return { ...audit, resolved: { status: "unavailable", findings: [], detail: "Cannot resolve the Gradle wrapper." } };
  }
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? 30_000, 60_000));
  const module = input.module ?? "app";
  const configuration = input.configuration ?? "debugRuntimeClasspath";
  const result = await run(wrapper, [`:${module}:dependencies`, "--configuration", configuration, "--console=plain"], { cwd: root, timeoutMs, maxOutputBytes: 200_000 });
  const output = `${result.stdout}\n${result.stderr}`.slice(0, 200_000);
  const resolved = result.timedOut
    ? { status: "timeout" as const, findings: parseResolvedComposeGraph(output), detail: `Gradle dependency resolution timed out after ${timeoutMs}ms.` }
    : result.code !== 0
      ? { status: "failed" as const, findings: parseResolvedComposeGraph(output), detail: `Gradle exited ${result.code}: ${output.slice(-1_000)}` }
      : { status: "ok" as const, findings: parseResolvedComposeGraph(output) };
  return { ...audit, resolved, summary: `${audit.static.errors.length} static error(s), ${audit.static.warnings.length} warning(s); resolved graph ${resolved.status}.` };
}

export function registerProjectConfigTools(server: McpServer): void {
  server.registerTool("verify_gradle_config", {
    description: "Audit a PICO Spatial Android project: required Compose exclusions and stage/windowcontainer metadata-root consistency. By default this is read-only static analysis and refuses escaping symlinks. Set resolveTransitives:true only for a bounded Gradle dependency report; that opt-in may populate caches and contact configured repositories, but never builds or deploys.",
    inputSchema: { projectDir: z.string(), module: z.string().optional(), configuration: z.string().optional(), resolveTransitives: z.boolean().default(false), timeoutMs: z.number().int().min(1000).max(60000).optional() },
  }, async (input) => okJson(await verifyGradleConfig(input)));
}
