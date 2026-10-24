import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * projectidentity.ts — what SDK a project DECLARES, read statically.
 *
 * The defect this exists to remove: a host tool installation and a project's dependency
 * identity are different facts, and generation used to conflate them — it wrote the
 * host-resolved tools root into `local.properties` and said nothing about the BOM the
 * generated project actually compiles against. An agent that upgraded its host tools then
 * had no way to tell whether the app's dependencies had moved with them. (They had not,
 * and must not: `appskeleton/gradle/libs.versions.toml:5` pins `bom = "6.0.0"`, and the
 * generator copies that file byte-for-byte.)
 *
 * This module is a READER. It opens a bounded allowlist of project files with `fs` and
 * nothing else: no Gradle, no subprocess, no network, no writes. A Gradle run is the only
 * thing that can say what a build *resolves* to, so `resolvedArtifacts` is never derived
 * here — a caller that has actually run a resolution hands the verified evidence in
 * through `readProjectSdkIdentity(root, {resolvedArtifacts})`, and only then does the
 * status rise to "resolved".
 *
 * Supported declaration forms (everything else is `unknown`, with a file-specific reason —
 * a wrong version is worse than an admitted gap):
 *
 *   1. A version-catalog alias whose value is a literal version, referenced by a
 *      `com.pico.spatial*` BOM library entry. This is the exact shape the app skeleton
 *      ships:
 *          [versions]
 *          bom = "6.0.0"
 *          [libraries]
 *          bom = { group = "com.pico.spatial", name = "bom", version.ref = "bom" }
 *   2. A literal Gradle coordinate: `platform("com.pico.spatial…:…:X.Y.Z")`.
 *   3. The catalog/build-file pair `implementation(platform(libs.<alias>))`, which resolves
 *      through form 1.
 *
 * `fingerprint` is CONTENT identity: sha256 over the sorted allowlisted relative paths and
 * their file hashes, with the canonical root deliberately left out and reported separately
 * as `projectRoot`. Two checkouts of the same project therefore agree on `fingerprint` and
 * differ on `projectRoot`, which is what makes the pair usable as a cache key. Two projects
 * that declare nothing also agree — correctly, since their declared identity really is the
 * same emptiness — so a caller must pair `fingerprint` with `projectRoot`, and must read
 * `status` before trusting `declaredBom`.
 */

export interface ResolvedArtifact {
  coordinate: string;
  sha256: string;
}

export interface ProjectSdkIdentity {
  projectRoot: string;
  fingerprint: string;
  declaredBom: string | null;
  resolvedArtifacts: readonly ResolvedArtifact[];
  status: "declared" | "resolved" | "unknown";
  reasons: readonly string[];
}

export interface ProjectSdkIdentityOptions {
  /**
   * Verified evidence of what a build ACTUALLY resolved, produced by a boundary that ran a
   * resolution. Never inferred here. Malformed entries are refused rather than trusted.
   */
  resolvedArtifacts?: readonly ResolvedArtifact[];
}

/** The bounded set of project files this reader may open, sorted, all project-relative. */
export const PROJECT_IDENTITY_FILES: readonly string[] = [
  "app/build.gradle",
  "app/build.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "gradle/libs.versions.toml",
  "settings.gradle",
  "settings.gradle.kts",
];

const CATALOG_FILE = "gradle/libs.versions.toml";
const SETTINGS_FILES = ["settings.gradle", "settings.gradle.kts"];
const BUILD_FILES = ["build.gradle", "build.gradle.kts", "app/build.gradle", "app/build.gradle.kts"];
const PICO_GROUP_PREFIX = "com.pico.spatial";
/** A literal release version: two or three numeric parts, nothing dynamic and nothing interpolated. */
const LITERAL_VERSION = /^\d+\.\d+(?:\.\d+)?$/;

const sha256 = (data: crypto.BinaryLike): string => crypto.createHash("sha256").update(data).digest("hex");

// --------------------------------------------------------------------- file reads

type FileState = { rel: string; bytes: Buffer } | { rel: string; unreadable: true };

function readAllowlist(root: string): FileState[] {
  const out: FileState[] = [];
  for (const rel of [...PROJECT_IDENTITY_FILES].sort()) {
    const abs = path.join(root, ...rel.split("/"));
    let isFile = false;
    try {
      isFile = fs.statSync(abs).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    try {
      out.push({ rel, bytes: fs.readFileSync(abs) });
    } catch {
      out.push({ rel, unreadable: true });
    }
  }
  return out;
}

/**
 * Content identity of the declaration surface. The canonical root is NOT hashed in (see the
 * module comment); an unreadable-but-present file contributes a distinct marker so it cannot
 * masquerade as an absent one.
 */
function fingerprintOf(files: FileState[]): string {
  let material = "pico-project-sdk-identity/1\n";
  for (const file of files) {
    material += "unreadable" in file ? `${file.rel}\0unreadable\n` : `${file.rel}\0${sha256(file.bytes)}\n`;
  }
  return sha256(material);
}

// ------------------------------------------------------------------ comment stripping

/**
 * Blank out comments while leaving every other byte (and therefore every offset) in place, so
 * a commented-out dependency cannot be read as a declaration and a `https://` inside a quoted
 * repository URL cannot be read as a comment.
 */
function stripComments(text: string, style: "toml" | "gradle"): string {
  const out = text.split("");
  let quote: string | null = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && quote !== "'") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (style === "toml" && ch === "#") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (style === "gradle" && ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (style === "gradle" && ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      while (i < stop) {
        out[i] = text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

// ------------------------------------------------------------------ catalog parsing

interface CatalogLibrary {
  alias: string;
  group: string | null;
  name: string | null;
  versionRef: string | null;
  /** A version written into the library entry itself, literal or not. */
  inlineVersion: string | null;
}

interface Catalog {
  versions: Map<string, string | null>;
  libraries: CatalogLibrary[];
}

/** Aliases are matched case-insensitively with `-`, `_` and `.` treated as the same separator. */
const normalizeAlias = (alias: string): string => alias.toLowerCase().replace(/[-_.]+/g, "-");

function unquote(raw: string): string | null {
  const trimmed = raw.trim();
  const m = /^"([^"]*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
  return m ? m[1]! : null;
}

/** `group = "x", name = "y", version.ref = "z"` -> the fields we need, quote-aware. */
function inlineTableFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const m of body.matchAll(/([A-Za-z0-9_.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,}]+)/g)) {
    fields.set(m[1]!.trim(), m[2]!.trim());
  }
  return fields;
}

function parseCatalog(text: string): Catalog {
  const catalog: Catalog = { versions: new Map(), libraries: [] };
  let section = "";
  for (const rawLine of stripComments(text, "toml").split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim().toLowerCase();
      continue;
    }
    const assign = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!assign) continue;
    const key = assign[1]!;
    const value = assign[2]!.trim();
    if (section === "versions") {
      catalog.versions.set(normalizeAlias(key), unquote(value));
      continue;
    }
    if (section !== "libraries") continue;
    const shorthand = unquote(value);
    if (shorthand !== null) {
      const parts = shorthand.split(":");
      catalog.libraries.push({
        alias: normalizeAlias(key),
        group: parts[0] ?? null,
        name: parts[1] ?? null,
        versionRef: null,
        inlineVersion: parts.length >= 3 ? parts.slice(2).join(":") : null,
      });
      continue;
    }
    if (!value.startsWith("{")) continue;
    const fields = inlineTableFields(value.replace(/^\{/, "").replace(/\}\s*$/, ""));
    const moduleField = fields.has("module") ? unquote(fields.get("module")!) : null;
    const moduleParts = moduleField ? moduleField.split(":") : null;
    const inlineVersionRaw = fields.get("version");
    catalog.libraries.push({
      alias: normalizeAlias(key),
      group: fields.has("group") ? unquote(fields.get("group")!) : (moduleParts?.[0] ?? null),
      name: fields.has("name") ? unquote(fields.get("name")!) : (moduleParts?.[1] ?? null),
      versionRef: fields.has("version.ref") ? unquote(fields.get("version.ref")!) : null,
      // A non-literal (rich or interpolated) version is kept verbatim so the reason can quote it.
      inlineVersion: inlineVersionRaw === undefined ? null : (unquote(inlineVersionRaw) ?? inlineVersionRaw),
    });
  }
  return catalog;
}

// ------------------------------------------------------------------ build-file parsing

/** The contents of every `platform(...)` / `enforcedPlatform(...)` call, comments removed. */
function platformArguments(text: string): string[] {
  const source = stripComments(text, "gradle");
  const out: string[] = [];
  for (const m of source.matchAll(/\b(?:enforcedPlatform|platform)\s*\(/g)) {
    let depth = 1;
    let i = m.index! + m[0]!.length;
    const start = i;
    let quote: string | null = null;
    while (i < source.length && depth > 0) {
      const ch = source[i]!;
      if (quote) {
        if (ch === "\\" && quote !== "'") i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    if (depth === 0) out.push(source.slice(start, i - 1).trim());
  }
  return out;
}

// ------------------------------------------------------------------ the reader

interface Declaration {
  version: string;
  where: string;
}

export function readProjectSdkIdentity(projectRoot: string, options?: ProjectSdkIdentityOptions): ProjectSdkIdentity {
  const resolvedRoot = path.resolve(projectRoot);
  let canonicalRoot = resolvedRoot;
  try {
    canonicalRoot = fs.realpathSync(resolvedRoot);
  } catch {
    /* an absent or unreadable root keeps its resolved spelling; the reasons below say so */
  }

  const reasons: string[] = [];
  let rootReadable = false;
  try {
    rootReadable = fs.statSync(canonicalRoot).isDirectory();
  } catch {
    rootReadable = false;
  }
  if (!rootReadable) reasons.push(`${canonicalRoot}: not a readable directory`);

  const files = rootReadable ? readAllowlist(canonicalRoot) : [];
  const fingerprint = fingerprintOf(files);
  const text = (rel: string): string | null => {
    const found = files.find((f) => f.rel === rel);
    if (!found) return null;
    if ("unreadable" in found) {
      reasons.push(`${rel}: present but unreadable`);
      return null;
    }
    return found.bytes.toString("utf8");
  };

  const declarations: Declaration[] = [];
  /** Set when a PICO BOM declaration exists but cannot be read as a literal version. */
  let indeterminate = false;

  // --- build files: literal coordinates, and the aliases they point at.
  const referencedAliases = new Set<string>();
  for (const rel of BUILD_FILES) {
    const body = text(rel);
    if (body === null) continue;
    for (const argument of platformArguments(body)) {
      const literal = unquote(argument);
      if (literal !== null) {
        const parts = literal.split(":");
        if (parts.length < 2 || !parts[0]!.startsWith(PICO_GROUP_PREFIX)) continue;
        const version = parts.slice(2).join(":");
        if (LITERAL_VERSION.test(version)) declarations.push({ version, where: `${rel}: platform("${literal}")` });
        else {
          indeterminate = true;
          reasons.push(`${rel}: platform("${literal}") does not name a literal version`);
        }
        continue;
      }
      const alias = /^libs\.([A-Za-z0-9_.]+)\s*$/.exec(argument);
      if (alias) {
        referencedAliases.add(normalizeAlias(alias[1]!));
        continue;
      }
      if (argument.includes(PICO_GROUP_PREFIX)) {
        indeterminate = true;
        reasons.push(`${rel}: platform(${argument}) is computed, not a static declaration`);
      }
    }
  }

  // --- settings: a relocated catalog means the file we can see may not be the one Gradle uses.
  let catalogTrusted = true;
  for (const rel of SETTINGS_FILES) {
    const body = text(rel);
    if (body === null) continue;
    if (/\bversionCatalogs\s*\{/.test(stripComments(body, "gradle"))) {
      catalogTrusted = false;
      reasons.push(`${rel}: declares a custom versionCatalogs source, so ${CATALOG_FILE} may not be the catalog Gradle reads`);
    }
  }

  // --- the version catalog.
  const catalogText = text(CATALOG_FILE);
  if (catalogText === null) {
    reasons.push(`${CATALOG_FILE}: not present`);
  } else if (catalogTrusted) {
    const catalog = parseCatalog(catalogText);
    const bomEntries = catalog.libraries.filter(
      (lib) => (lib.group ?? "").startsWith(PICO_GROUP_PREFIX) && (lib.name === "bom" || referencedAliases.has(lib.alias)),
    );
    if (bomEntries.length === 0) {
      reasons.push(`${CATALOG_FILE}: no com.pico.spatial BOM library entry (a library named "bom", or one referenced by platform(libs.<alias>))`);
    }
    for (const entry of bomEntries) {
      if (entry.versionRef !== null) {
        const alias = normalizeAlias(entry.versionRef);
        if (!catalog.versions.has(alias)) {
          indeterminate = true;
          reasons.push(`${CATALOG_FILE}: [libraries] ${entry.alias} has version.ref "${entry.versionRef}" with no matching [versions] entry`);
          continue;
        }
        const literal = catalog.versions.get(alias) ?? null;
        if (literal === null) {
          indeterminate = true;
          reasons.push(`${CATALOG_FILE}: [versions] ${entry.versionRef} is not a literal version string`);
          continue;
        }
        if (!LITERAL_VERSION.test(literal)) {
          indeterminate = true;
          reasons.push(`${CATALOG_FILE}: [versions] ${entry.versionRef} = "${literal}" is not a literal release version`);
          continue;
        }
        declarations.push({ version: literal, where: `${CATALOG_FILE}: [versions] ${entry.versionRef} = "${literal}" via [libraries] ${entry.alias}` });
        continue;
      }
      if (entry.inlineVersion !== null) {
        if (LITERAL_VERSION.test(entry.inlineVersion)) {
          declarations.push({ version: entry.inlineVersion, where: `${CATALOG_FILE}: [libraries] ${entry.alias} version "${entry.inlineVersion}"` });
        } else {
          indeterminate = true;
          reasons.push(`${CATALOG_FILE}: [libraries] ${entry.alias} version ${entry.inlineVersion} is not a literal release version`);
        }
        continue;
      }
      indeterminate = true;
      reasons.push(`${CATALOG_FILE}: [libraries] ${entry.alias} declares no version`);
    }
  }

  // --- reconcile.
  const distinct = [...new Set(declarations.map((d) => d.version))];
  let declaredBom: string | null = null;
  if (distinct.length > 1) {
    reasons.push(`conflicting BOM declarations: ${declarations.map((d) => `${d.where} -> ${d.version}`).join("; ")}`);
  } else if (distinct.length === 1 && !indeterminate) {
    declaredBom = distinct[0]!;
    for (const declaration of declarations) reasons.push(declaration.where);
  } else if (distinct.length === 1 && indeterminate) {
    // One readable declaration does not make the unreadable one agree with it.
    reasons.push(`a literal declaration (${declarations[0]!.where}) exists alongside a declaration that cannot be read statically`);
  }

  // --- caller-supplied resolved evidence.
  const supplied = options?.resolvedArtifacts;
  let resolvedArtifacts: ResolvedArtifact[] = [];
  if (supplied !== undefined) {
    if (!Array.isArray(supplied)) {
      reasons.push("resolvedArtifacts: not an array — refused as resolved evidence");
    } else {
      const bad = supplied.filter(
        (a) =>
          typeof a !== "object" ||
          a === null ||
          typeof (a as ResolvedArtifact).coordinate !== "string" ||
          (a as ResolvedArtifact).coordinate.trim() === "" ||
          typeof (a as ResolvedArtifact).sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test((a as ResolvedArtifact).sha256),
      );
      if (bad.length > 0) {
        reasons.push(`resolvedArtifacts: ${bad.length} entr${bad.length === 1 ? "y" : "ies"} are not {coordinate, sha256:<64 hex>} — refused as resolved evidence`);
      } else {
        resolvedArtifacts = supplied.map((a) => Object.freeze({ coordinate: a.coordinate, sha256: a.sha256 }));
      }
    }
  }

  const status: ProjectSdkIdentity["status"] = resolvedArtifacts.length > 0 ? "resolved" : declaredBom !== null ? "declared" : "unknown";

  return Object.freeze({
    projectRoot: canonicalRoot,
    fingerprint,
    declaredBom,
    resolvedArtifacts: Object.freeze(resolvedArtifacts),
    status,
    reasons: Object.freeze(reasons),
  });
}
