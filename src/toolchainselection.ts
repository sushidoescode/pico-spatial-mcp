import crypto from "node:crypto";
import path from "node:path";

/**
 * Component-valid selection of a PICO spatial toolchain.
 *
 * This module is pure: every filesystem observation arrives through an injected
 * `ToolchainIO`, so the resolver can be exercised against a simulated tree. It
 * starts no process, contacts no registry and provisions nothing — the host
 * implementation lives in `./toolchain.ts`.
 *
 * The defect it exists to remove: selecting a *version directory* and only then
 * discovering that the component the caller needs is not inside it. Here a
 * selection is only "ok" when every requested component resolved from one
 * installation, and a declared root or pin that cannot satisfy the request
 * fails closed rather than silently sliding to another one.
 *
 * Externally asserted failure codes (contract):
 *
 * | Trigger                                              | Status/code                        |
 * | ---------------------------------------------------- | ---------------------------------- |
 * | Explicit version lacks a required component           | `unavailable/component-missing`    |
 * | Requested version directory does not exist            | `unavailable/version-missing`      |
 * | Explicit root is absent or unreadable                 | `unavailable/root-unavailable`     |
 * | Explicit request contradicts supplied project pin     | `ambiguous/version-conflict`       |
 * | Equal numeric versions contain different required bytes | `ambiguous/version-alias-conflict` |
 * | Platform has no verified default root                 | `unavailable/unsupported-default-root` |
 * | Duplicate `spatial.tools.dir` keys disagree           | `ambiguous/property-conflict`      |
 *
 * The last row is an addition to the codes listed in the task brief, not a
 * change to them: a project file that declares two different tool roots is
 * exactly as unusable as a request that contradicts its own pin.
 */

export type ToolComponent = "packer" | "emulator" | "adb" | "proto";
export type RootSource = "explicit" | "local.properties" | "PICO_HOME" | "default";

export interface ToolchainRequest {
  androidProjectRoot?: string;
  toolsRoot?: string;
  toolsVersion?: string;
  projectToolsVersion?: string;
  required: readonly ToolComponent[];
}

export interface FileIdentity {
  path: string;
  sha256: string;
}

export interface SelectedToolchain {
  status: "ok";
  root: string;
  rootSource: RootSource;
  version: string;
  reason: "explicit" | "project-pin" | "newest-usable";
  files: Partial<Record<ToolComponent, FileIdentity>>;
  identity: string;
}

export interface UnusableToolchain {
  status: "unavailable" | "ambiguous";
  code: string;
  detail: string;
}

export type ToolchainSelection = SelectedToolchain | UnusableToolchain;

export interface ToolchainIO {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  read(path: string): Buffer | null;
  entries(path: string): string[] | null;
  realpath(path: string): string | null;
  executable(path: string): boolean;
}

type PathApi = typeof path.win32;

/** Components in the sorted order used for identity material and diagnostics. */
export const TOOL_COMPONENTS: readonly ToolComponent[] = ["adb", "emulator", "packer", "proto"];

/** The selection property an Android project may use to override the tools root. */
export const TOOLS_DIR_PROPERTY = "spatial.tools.dir";

interface ComponentLayout {
  /** Directory segments below `<root>/<version>/`. */
  dir: readonly string[];
  /** Base name of an executable payload, or null for a fixed data file. */
  executableBase: "adb" | "emulator" | "spatialbundle" | null;
  fixedName?: string;
}

const COMPONENT_LAYOUT: Record<ToolComponent, ComponentLayout> = {
  adb: { dir: ["emulator", "system-images", "platform-tools"], executableBase: "adb" },
  emulator: { dir: ["emulator"], executableBase: "emulator" },
  packer: { dir: ["editor", "spatialbundle"], executableBase: "spatialbundle" },
  proto: { dir: ["emulator", "lib"], executableBase: null, fixedName: "emulator_controller.proto" },
};

/**
 * Candidate file names for a tool, in probe order. Windows ships the same
 * payloads with a `.exe` suffix; every other platform uses the bare name.
 */
export function executableNames(name: "adb" | "emulator" | "spatialbundle", platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${name}.exe`] : [name];
}

const VERSION_TOKEN = /^\d+\.\d+(?:\.\d+)?$/;

/** Version labels are two- or three-part numerals; separators and traversal are rejected. */
export function isVersionToken(value: string): boolean {
  return VERSION_TOKEN.test(value);
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function versionKey(token: string): string {
  const parts = token.split(".").map(Number);
  return `${parts[0] ?? 0}.${parts[1] ?? 0}.${parts[2] ?? 0}`;
}

function pathFor(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

function trimPath(value: string, P: PathApi): string {
  let normalized = P.normalize(value);
  const root = P.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(P.sep)) normalized = normalized.slice(0, -1);
  return normalized;
}

function expandTilde(value: string, io: ToolchainIO, P: PathApi): string {
  if (value === "~") return io.home;
  if (value.startsWith("~/") || (io.platform === "win32" && value.startsWith("~\\"))) {
    return P.join(io.home, value.slice(2));
  }
  return value;
}

function readEnv(io: ToolchainIO, name: string): string | undefined {
  const direct = io.env[name];
  if (direct !== undefined) return direct;
  if (io.platform !== "win32") return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(io.env)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function unavailable(code: string, detail: string): UnusableToolchain {
  return { status: "unavailable", code, detail };
}

function ambiguous(code: string, detail: string): UnusableToolchain {
  return { status: "ambiguous", code, detail };
}

function isFailure(value: unknown): value is UnusableToolchain {
  return typeof value === "object" && value !== null && "status" in (value as Record<string, unknown>);
}

// --------------------------------------------------------------- .properties

export interface PropertyEntry {
  key: string;
  value: string;
}

function trailingBackslashesAreOdd(line: string): boolean {
  let count = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

function unescapeProperty(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    i += 1;
    switch (next) {
      case "t": out += "\t"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "f": out += "\f"; break;
      case "u": {
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += "u";
        }
        break;
      }
      // `\\`, `\:`, `\=`, `\#`, `\!` and an escaped space all yield the literal char.
      default: out += next; break;
    }
  }
  return out;
}

function splitProperty(logicalLine: string): PropertyEntry {
  let index = 0;
  let rawKey = "";
  let sawSeparator = false;
  while (index < logicalLine.length) {
    const ch = logicalLine[index];
    if (ch === "\\") {
      rawKey += ch + (logicalLine[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (ch === "=" || ch === ":") {
      index += 1;
      sawSeparator = true;
      break;
    }
    if (ch === " " || ch === "\t" || ch === "\f") break;
    rawKey += ch;
    index += 1;
  }
  if (!sawSeparator) {
    while (index < logicalLine.length && " \t\f".includes(logicalLine[index]!)) index += 1;
    if (index < logicalLine.length && (logicalLine[index] === "=" || logicalLine[index] === ":")) index += 1;
  }
  while (index < logicalLine.length && " \t\f".includes(logicalLine[index]!)) index += 1;
  return { key: unescapeProperty(rawKey), value: unescapeProperty(logicalLine.slice(index)) };
}

/**
 * java.util.Properties semantics: `#`/`!` comments, `=`/`:`/whitespace separators,
 * backslash escapes (including `\uXXXX`) and logical lines joined across a trailing
 * backslash with the continuation's leading whitespace stripped.
 */
export function parseJavaProperties(text: string): PropertyEntry[] {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const entries: PropertyEntry[] = [];
  let index = 0;
  while (index < lines.length) {
    let logical = (lines[index] ?? "").replace(/^[ \t\f]+/, "");
    index += 1;
    if (logical === "" || logical.startsWith("#") || logical.startsWith("!")) continue;
    while (trailingBackslashesAreOdd(logical) && index < lines.length) {
      logical = logical.slice(0, -1) + (lines[index] ?? "").replace(/^[ \t\f]+/, "");
      index += 1;
    }
    if (trailingBackslashesAreOdd(logical)) logical = logical.slice(0, -1);
    entries.push(splitProperty(logical));
  }
  return entries;
}

// ------------------------------------------------------------- root selection

export interface RootCandidate {
  root: string;
  source: RootSource;
  /** True when a human or a project file named this root, so it must fail closed. */
  declared: boolean;
}

function rootSourceLabel(source: RootSource): string {
  switch (source) {
    case "explicit": return "an explicit toolsRoot";
    case "local.properties": return `local.properties[${TOOLS_DIR_PROPERTY}]`;
    case "PICO_HOME": return "$PICO_HOME";
    case "default": return "the documented platform default location";
  }
}

/**
 * explicit toolsRoot -> project `spatial.tools.dir` -> $PICO_HOME -> documented
 * platform default. Existence is not checked here; `selectInstallation` reports
 * an unlistable root as `unavailable/root-unavailable`.
 */
export function resolveRootCandidate(
  request: Pick<ToolchainRequest, "androidProjectRoot" | "toolsRoot">,
  io: ToolchainIO,
): RootCandidate | UnusableToolchain {
  const P = pathFor(io.platform);

  const explicit = (request.toolsRoot ?? "").trim();
  if (explicit) {
    return { root: trimPath(expandTilde(explicit, io, P), P), source: "explicit", declared: true };
  }

  const projectRoot = (request.androidProjectRoot ?? "").trim();
  if (projectRoot) {
    const base = trimPath(expandTilde(projectRoot, io, P), P);
    const propertiesFile = P.join(base, "local.properties");
    const bytes = io.read(propertiesFile);
    if (bytes) {
      const declared = parseJavaProperties(bytes.toString("utf8"))
        .filter((entry) => entry.key === TOOLS_DIR_PROPERTY)
        .map((entry) => entry.value.replace(/[ \t\f]+$/, ""))
        .filter((value) => value !== "");
      const distinct = [...new Set(declared)];
      if (distinct.length > 1) {
        return ambiguous(
          "ambiguous/property-conflict",
          `${propertiesFile} declares conflicting ${TOOLS_DIR_PROPERTY} values: ${distinct.join(", ")}`,
        );
      }
      if (distinct.length === 1) {
        const declaredValue = expandTilde(distinct[0]!, io, P);
        const resolved = P.isAbsolute(declaredValue) ? declaredValue : P.join(base, declaredValue);
        return { root: trimPath(resolved, P), source: "local.properties", declared: true };
      }
    }
  }

  const envHome = (readEnv(io, "PICO_HOME") ?? "").trim();
  if (envHome) {
    return { root: trimPath(expandTilde(envHome, io, P), P), source: "PICO_HOME", declared: true };
  }

  if (io.platform === "darwin") {
    return { root: trimPath(P.join(io.home, "Library", "PICO", "sdk"), P), source: "default", declared: false };
  }
  return unavailable(
    "unavailable/unsupported-default-root",
    `No documented default PICO tools root for platform ${io.platform}; pass an explicit toolsRoot, set ${TOOLS_DIR_PROPERTY} in local.properties, or export $PICO_HOME`,
  );
}

// ---------------------------------------------------------------- installations

export interface InstallationScan {
  /** Directory name exactly as it appears under the root. */
  version: string;
  /** Three-part numeric key, so `6.1` and `6.1.0` group together. */
  key: string;
  dir: string;
  components: Partial<Record<ToolComponent, string>>;
}

function componentFile(versionDir: string, component: ToolComponent, io: ToolchainIO, P: PathApi): string | null {
  const layout = COMPONENT_LAYOUT[component];
  const dir = P.join(versionDir, ...layout.dir);
  const names = layout.executableBase
    ? executableNames(layout.executableBase, io.platform)
    : [layout.fixedName!];
  for (const name of names) {
    const file = P.join(dir, name);
    if (layout.executableBase ? io.executable(file) : io.read(file) !== null) return file;
  }
  return null;
}

function expectedComponentLocation(component: ToolComponent, platform: NodeJS.Platform): string {
  const layout = COMPONENT_LAYOUT[component];
  const name = layout.executableBase ? executableNames(layout.executableBase, platform)[0]! : layout.fixedName!;
  return [...layout.dir, name].join("/");
}

/**
 * Every readable version directory under `root`, ascending, with the requested
 * components resolved. Returns null when the root itself cannot be listed.
 */
export function scanInstallations(
  root: string,
  components: readonly ToolComponent[],
  io: ToolchainIO,
): InstallationScan[] | null {
  const P = pathFor(io.platform);
  const names = io.entries(root);
  if (names === null) return null;
  const wanted = [...new Set(components)];
  const found: InstallationScan[] = [];
  for (const name of names) {
    if (!isVersionToken(name)) continue;
    const dir = P.join(root, name);
    if (io.entries(dir) === null) continue; // a stray file, or a directory we may not read
    const resolved: Partial<Record<ToolComponent, string>> = {};
    for (const component of wanted) {
      const file = componentFile(dir, component, io, P);
      if (file) resolved[component] = file;
    }
    found.push({ version: name, key: versionKey(name), dir, components: resolved });
  }
  found.sort((a, b) => compareVersions(a.version, b.version) || a.version.localeCompare(b.version));
  return found;
}

function missingComponents(install: InstallationScan, required: readonly ToolComponent[]): ToolComponent[] {
  return required.filter((component) => !install.components[component]);
}

function samePayload(left: string, right: string, io: ToolchainIO): boolean {
  const leftReal = io.realpath(left);
  const rightReal = io.realpath(right);
  if (leftReal && rightReal && leftReal === rightReal) return true; // an alias, not a rival install
  const leftBytes = io.read(left);
  const rightBytes = io.read(right);
  if (!leftBytes || !rightBytes) return false;
  return leftBytes.equals(rightBytes);
}

/**
 * Collapse directories that share a numeric version. Aliases (symlinks) and
 * byte-identical copies are the same installation; differing payloads are not.
 */
function disambiguate(
  candidates: InstallationScan[],
  required: readonly ToolComponent[],
  root: string,
  io: ToolchainIO,
): InstallationScan | UnusableToolchain {
  const ordered = [...candidates].sort((a, b) => a.version.localeCompare(b.version));
  const first = ordered[0]!;
  for (const other of ordered.slice(1)) {
    for (const component of required) {
      const left = first.components[component];
      const right = other.components[component];
      if (!left || !right || !samePayload(left, right, io)) {
        return ambiguous(
          "ambiguous/version-alias-conflict",
          `Version directories ${ordered.map((c) => c.version).join(", ")} under ${root} share numeric version ${first.key} but their ${component} payloads differ; request one directory name explicitly`,
        );
      }
    }
  }
  return first;
}

export interface InstallationChoice {
  root: string;
  rootSource: RootSource;
  reason: "explicit" | "project-pin" | "newest-usable";
  installation: InstallationScan;
}

/**
 * Root + version + component validation, without hashing anything. `resolveToolchain`
 * adds the payload identity on top; the legacy adapters in `./toolchain.ts` use this
 * directly so hot paths never read a multi-megabyte binary just to pick a version.
 */
export function selectInstallation(request: ToolchainRequest, io: ToolchainIO): InstallationChoice | UnusableToolchain {
  const required = [...new Set(request.required)];

  const candidate = resolveRootCandidate(request, io);
  if (isFailure(candidate)) return candidate;
  const { root, source } = candidate;

  // Version tokens are validated verbatim. Whitespace is a rejected character, not
  // something to trim away, so " 6.1 " never resolves to 6.1 by accident; only an
  // absent field (or the empty string a JSON tool input degrades to) means "unpinned".
  const explicitToken = request.toolsVersion ?? "";
  const pinToken = request.projectToolsVersion ?? "";
  if (explicitToken && pinToken && explicitToken !== pinToken) {
    const bothNumeric = isVersionToken(explicitToken) && isVersionToken(pinToken);
    if (!bothNumeric || compareVersions(explicitToken, pinToken) !== 0) {
      return ambiguous(
        "ambiguous/version-conflict",
        `Requested toolchain version ${explicitToken} contradicts the supplied project pin ${pinToken}`,
      );
    }
  }
  const requestedToken = explicitToken || pinToken;
  const reason = explicitToken ? "explicit" : pinToken ? "project-pin" : "newest-usable";
  if (requestedToken && !isVersionToken(requestedToken)) {
    return unavailable(
      "unavailable/version-missing",
      `Requested toolchain version ${JSON.stringify(requestedToken)} is not a numeric version label (expected 6.1 or 6.1.0)`,
    );
  }

  const installations = scanInstallations(root, required, io);
  if (installations === null) {
    return unavailable(
      "unavailable/root-unavailable",
      `PICO tools root ${root} (from ${rootSourceLabel(source)}) does not exist or cannot be listed`,
    );
  }

  if (requestedToken) {
    const exact = installations.filter((install) => install.version === requestedToken);
    const candidates = exact.length ? exact : installations.filter((install) => install.key === versionKey(requestedToken));
    if (candidates.length === 0) {
      const present = installations.map((install) => install.version);
      return unavailable(
        "unavailable/version-missing",
        `No readable toolchain version directory ${requestedToken} under ${root}${present.length ? ` (present: ${present.join(", ")})` : ""}`,
      );
    }
    // Component validity is judged before alias ambiguity: a request that nothing
    // can satisfy is component-missing, not an ambiguity between equal non-answers.
    const viable = candidates.filter((install) => missingComponents(install, required).length === 0);
    if (viable.length === 0) {
      const named = candidates[0]!;
      const missing = missingComponents(named, required);
      return unavailable(
        "unavailable/component-missing",
        `Toolchain ${named.version} under ${root} is missing required component(s) ${missing.join(", ")}; expected ${missing.map((c) => `${named.version}/${expectedComponentLocation(c, io.platform)}`).join(", ")}`,
      );
    }
    const chosen = viable.length === 1 ? viable[0]! : disambiguate(viable, required, root, io);
    if (isFailure(chosen)) return chosen;
    return { root, rootSource: source, reason, installation: chosen };
  }

  if (installations.length === 0) {
    return unavailable("unavailable/version-missing", `No toolchain versions found under ${root}`);
  }
  const usable = installations.filter((install) => missingComponents(install, required).length === 0);
  if (usable.length === 0) {
    return unavailable(
      "unavailable/component-missing",
      `No toolchain under ${root} provides every required component (${required.join(", ")}); inspected ${installations.map((i) => i.version).join(", ")}`,
    );
  }
  const newestKey = usable[usable.length - 1]!.key;
  const group = usable.filter((install) => install.key === newestKey);
  const chosen = group.length === 1 ? group[0]! : disambiguate(group, required, root, io);
  if (isFailure(chosen)) return chosen;
  return { root, rootSource: source, reason, installation: chosen };
}

// -------------------------------------------------------------------- identity

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * sha256 over `${component}\0${path-relative-to-root}\0${sha256}\n` for each selected
 * required component, in sorted component order. Only the selected payloads are
 * hashed; separators are normalised so a relocated install keeps its identity.
 */
function toolchainIdentity(root: string, files: Partial<Record<ToolComponent, FileIdentity>>, P: PathApi): string {
  let material = "";
  for (const component of TOOL_COMPONENTS) {
    const file = files[component];
    if (!file) continue;
    const relative = P.relative(root, file.path).split(/[\\/]/).join("/");
    material += `${component}\0${relative}\0${file.sha256}\n`;
  }
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

let defaultIOFactory: (() => ToolchainIO) | null = null;

/** `./toolchain.ts` installs the host-backed implementation at import time. */
export function registerDefaultToolchainIO(factory: () => ToolchainIO): void {
  defaultIOFactory = factory;
}

function defaultIO(): ToolchainIO {
  if (!defaultIOFactory) {
    throw new Error("resolveToolchain needs a ToolchainIO: pass one, or import ./toolchain.js to install the host implementation");
  }
  return defaultIOFactory();
}

/**
 * Select one installation that carries every required component, and identify the
 * exact payload bytes it will run. Never falls back from a declared root or pin.
 */
export function resolveToolchain(request: ToolchainRequest, io: ToolchainIO = defaultIO()): ToolchainSelection {
  const chosen = selectInstallation(request, io);
  if (isFailure(chosen)) return chosen;

  const P = pathFor(io.platform);
  const required = new Set(request.required);
  const files: Partial<Record<ToolComponent, FileIdentity>> = {};
  for (const component of TOOL_COMPONENTS) {
    if (!required.has(component)) continue;
    const file = chosen.installation.components[component];
    if (!file) {
      return unavailable(
        "unavailable/component-missing",
        `Toolchain ${chosen.installation.version} under ${chosen.root} is missing required component ${component}`,
      );
    }
    const bytes = io.read(file);
    if (!bytes) {
      return unavailable(
        "unavailable/component-missing",
        `Required component ${component} at ${file} became unreadable while establishing toolchain identity`,
      );
    }
    files[component] = { path: file, sha256: sha256(bytes) };
  }

  return {
    status: "ok",
    root: chosen.root,
    rootSource: chosen.rootSource,
    version: chosen.installation.version,
    reason: chosen.reason,
    files,
    identity: toolchainIdentity(chosen.root, files, P),
  };
}
