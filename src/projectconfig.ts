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

function normalizeGradleModule(module: string): string | null {
  const normalized = module.replace(/^:+|:+$/g, "");
  const parts = normalized.split(":");
  return !normalized || parts.some((part) => !part || part === "." || part === ".." || /[\\/]/.test(part))
    ? null
    : normalized;
}

type CollectedProjectFiles = { files: string[]; root?: string; normalizedModule?: string };

function collectProjectFiles(projectDir: string, module: string, errors: ProjectConfigFinding[]): CollectedProjectFiles {
  let root: string;
  try { root = fs.realpathSync(projectDir); } catch {
    errors.push({ severity: "error", code: "project-not-found", message: `Project directory cannot be resolved: ${projectDir}` });
    return { files: [] };
  }
  const normalizedModule = normalizeGradleModule(module);
  const moduleParts = normalizedModule?.split(":") ?? [];
  let moduleRoot: string | null = null;
  if (!normalizedModule) {
    errors.push({ severity: "error", code: "invalid-module", message: `Gradle module must be a contained colon-delimited path: ${module}` });
  } else {
    const candidate = path.join(root, ...moduleParts);
    try {
      const resolved = fs.realpathSync(candidate);
      if (!under(root, resolved)) errors.push({ severity: "error", code: "module-outside-project", message: `Refusing to inspect module outside project root: ${module}` });
      else if (!fs.statSync(resolved).isDirectory()) errors.push({ severity: "error", code: "module-not-directory", message: `Gradle module is not a directory: ${module}` });
      else moduleRoot = resolved;
    } catch {
      errors.push({ severity: "error", code: "module-not-found", message: `Gradle module cannot be resolved beneath the project root: ${module}` });
    }
  }
  const files: string[] = [];
  const belongsToSelectedModule = (file: string): boolean => {
    const basename = path.basename(file);
    if (path.dirname(file) === root && (basename === "build.gradle" || basename === "build.gradle.kts")) return true;
    if (!moduleRoot || !under(moduleRoot, file)) return false;
    const relative = path.relative(moduleRoot, file);
    const parts = relative.split(path.sep);
    if (parts.length === 1 && (basename === "build.gradle" || basename === "build.gradle.kts")) return true;
    if (parts[0] !== "src" || parts.length < 3) return false;
    const sourceSet = parts[1];
    if (/^(?:test|androidTest)(?:$|[A-Z])/.test(sourceSet) || sourceSet === "testFixtures") return false;
    return basename.endsWith(".kt") || basename === "AndroidManifest.xml";
  };
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
      else if (entry.isFile() && belongsToSelectedModule(entryPath)) files.push(entryPath);
    }
  };
  visit(root);
  return { files, root, ...(normalizedModule ? { normalizedModule } : {}) };
}

function fileText(file: string): string { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }

function masked(text: string): string { return text.replace(/[^\r\n]/g, " "); }

/** Remove line/block comments without treating comment markers inside quoted strings as syntax. */
function sanitizeSource(text: string, keepStrings: boolean): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const end = text.slice(i + 2).search(/[\r\n]/);
      const next = end < 0 ? text.length : i + 2 + end;
      out += masked(text.slice(i, next));
      i = next;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith("/*", i)) { depth++; i += 2; }
        else if (text.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      out += masked(text.slice(start, i));
      continue;
    }
    if (text[i] === "\"" || text[i] === "'") {
      const start = i;
      const quote = text[i];
      const delimiter = text.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
      i += delimiter.length;
      if (delimiter.length === 3) {
        const end = text.indexOf(delimiter, i);
        i = end < 0 ? text.length : end + delimiter.length;
      } else {
        while (i < text.length) {
          if (text[i] === "\\") { i = Math.min(text.length, i + 2); continue; }
          if (text[i] === quote) { i++; break; }
          i++;
        }
      }
      const token = text.slice(start, i);
      out += keepStrings ? token : masked(token);
      continue;
    }
    out += text[i++];
  }
  return out;
}

function hasContainerInvocation(code: string, name: "DefaultStage" | "DefaultWindowContainer"): boolean {
  const invocation = new RegExp(`\\b${name}\\s*(?:\\([^{};]*\\)\\s*)?\\{`, "g");
  for (const match of code.matchAll(invocation)) {
    const lineStart = code.lastIndexOf("\n", match.index ?? 0) + 1;
    const prefix = code.slice(lineStart, match.index);
    if (/\b(?:fun|import)\b[^{};=]*$/.test(prefix)) continue;
    return true;
  }
  return false;
}

function matchingDelimiter(source: string, openAt: number, open: string, close: string): number {
  if (openAt < 0) return -1;
  let depth = 0;
  for (let i = openAt; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i;
  }
  return -1;
}

/** Root allprojects/subprojects blocks apply to a selected child module; root-only declarations do not. */
function applicableRootGradle(text: string): string {
  const semantic = sanitizeSource(text, true);
  const structure = sanitizeSource(text, false);
  const blocks: string[] = [];
  for (const match of structure.matchAll(/\b(?:allprojects|subprojects)\s*\{/g)) {
    const start = match.index ?? 0;
    let outerDepth = 0;
    for (let i = 0; i < start; i++) {
      if (structure[i] === "{") outerDepth++;
      else if (structure[i] === "}") outerDepth = Math.max(0, outerDepth - 1);
    }
    if (outerDepth !== 0) continue;
    const open = structure.indexOf("{", start);
    const close = matchingDelimiter(structure, open, "{", "}");
    if (open >= 0 && close >= 0) blocks.push(semantic.slice(start, close + 1));
  }
  return blocks.join("\n");
}

/** Return only actual mainApp block bodies, never helper/preview functions elsewhere in production. */
function mainAppBodies(text: string): string[] {
  const structure = sanitizeSource(text, false);
  const bodies: string[] = [];
  for (const match of structure.matchAll(/\bfun\s+mainApp\s*\(/g)) {
    const start = match.index ?? 0;
    const openParen = structure.indexOf("(", start);
    const closeParen = matchingDelimiter(structure, openParen, "(", ")");
    if (openParen < 0 || closeParen < 0) continue;
    const openBrace = structure.indexOf("{", closeParen + 1);
    if (openBrace < 0) continue;
    const nextFunctionOffset = structure.slice(closeParen + 1, openBrace).search(/\bfun\s+[A-Za-z_]/);
    if (nextFunctionOffset >= 0) continue;
    const closeBrace = matchingDelimiter(structure, openBrace, "{", "}");
    if (closeBrace >= 0) bodies.push(structure.slice(openBrace, closeBrace + 1));
  }
  return bodies;
}

/** Static-only, realpath-contained audit. It never invokes Gradle or an emulator. */
export function auditProjectConfig(projectDir: string, module = "app"): ProjectConfigAudit {
  const errors: ProjectConfigFinding[] = [];
  const warnings: ProjectConfigFinding[] = [];
  const collected = collectProjectFiles(projectDir, module, errors);
  const files = collected.files;
  const gradleFiles = files.filter((file) => file.endsWith(".gradle") || file.endsWith(".gradle.kts"));
  const gradle = gradleFiles.map((file) => {
    const text = fileText(file);
    return collected.root && path.dirname(file) === collected.root
      ? applicableRootGradle(text)
      : sanitizeSource(text, true);
  }).join("\n");
  const globalResolution = [...gradle.matchAll(/configurations\.all\s*\{[\s\S]*?resolutionStrategy\s*\{([\s\S]*?)\}\s*\}/g)]
    .map((match) => match[1])
    .join("\n");
  for (const coordinate of FORBIDDEN_COMPOSE_MODULES) {
    const [group, name] = coordinate.split(":");
    const direct = new RegExp(`(?:implementation|api|compileOnly|runtimeOnly|debugImplementation|testImplementation|androidTestImplementation)\\s*(?:\\(\\s*)?["']${group.replace(/\./g, "\\.")}:${name.replace(/\./g, "\\.")}(?=[:@"'])[^"']*["']`, "m");
    if (direct.test(gradle)) errors.push({ severity: "error", code: "forbidden-compose-direct", message: `Forbidden Compose direct dependency: ${coordinate}` });
    // The tighter paired check permits either named-argument ordering used by Gradle Kotlin/Groovy.
    const exclusionBlocks = [...globalResolution.matchAll(/exclude\s*\(([^)]*)\)|exclude\s+([^\n}]*)/g)].map((m) => m[1] ?? m[2]);
    const hasNamedExclusion = exclusionBlocks.some((block) =>
      new RegExp(`group\\s*(?:=|:)\\s*["']${group.replace(/\./g, "\\.")}["']`).test(block) &&
      new RegExp(`(?:module|name)\\s*(?:=|:)\\s*["']${name}["']`).test(block),
    );
    const hasPositionalExclusion = exclusionBlocks.some((block) => new RegExp(`^[\\s"']*${group.replace(/\./g, "\\.")}["']\\s*,\\s*["']${name}["']\\s*$`).test(block));
    if (!hasNamedExclusion && !hasPositionalExclusion) errors.push({ severity: "error", code: "missing-compose-exclusion", message: `Missing required exclusion for ${coordinate}` });
  }

  const manifestText = files.filter((file) => path.basename(file) === "AndroidManifest.xml").map(fileText).join("\n").replace(/<!--[\s\S]*?-->/g, "");
  const hasStageMeta = /<meta-data[^>]+android:name=["']pico\.spatial\.stage\./.test(manifestText);
  const hasWindowMeta = /<meta-data[^>]+android:name=["']pico\.spatial\.windowcontainer\./.test(manifestText);
  const appRoots = files.filter((file) => file.endsWith(".kt")).flatMap((file) => mainAppBodies(fileText(file)));
  const hasStageRoot = appRoots.some((body) => hasContainerInvocation(body, "DefaultStage"));
  const hasWindowRoot = appRoots.some((body) => hasContainerInvocation(body, "DefaultWindowContainer"));
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
  const module = input.module ?? "app";
  const audit = auditProjectConfig(input.projectDir, module);
  if (!input.resolveTransitives) return audit;
  const normalizedModule = normalizeGradleModule(module);
  if (!normalizedModule) {
    return { ...audit, resolved: { status: "unavailable", findings: [], detail: "Gradle module path is invalid; the wrapper was not executed." } };
  }
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
  const configuration = input.configuration ?? "debugRuntimeClasspath";
  const result = await run(wrapper, [`:${normalizedModule}:dependencies`, "--configuration", configuration, "--console=plain"], { cwd: root, timeoutMs, maxOutputBytes: 200_000 });
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
    description: "Audit one PICO Spatial Android module (app by default): required Compose exclusions (including root allprojects/subprojects configuration that applies to it) and stage/windowcontainer metadata-to-mainApp consistency. Static analysis ignores unrelated modules, root-only declarations, helper container calls, and test source sets, and refuses escaping symlinks. Set resolveTransitives:true only for a bounded Gradle dependency report; that opt-in may populate caches and contact configured repositories, but never builds or deploys.",
    inputSchema: { projectDir: z.string(), module: z.string().optional(), configuration: z.string().optional(), resolveTransitives: z.boolean().default(false), timeoutMs: z.number().int().min(1000).max(60000).optional() },
  }, async (input) => okJson(await verifyGradleConfig(input)));
}
