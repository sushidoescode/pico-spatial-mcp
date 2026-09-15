import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome, run } from "./util.js";
import {
  compareVersions,
  isVersionToken,
  registerDefaultToolchainIO,
  resolveRootCandidate,
  resolveToolchain,
  scanInstallations,
  selectInstallation,
  type FileIdentity,
  type InstallationScan,
  type SelectedToolchain,
  type ToolComponent,
  type ToolchainIO,
  type ToolchainRequest,
  type ToolchainSelection,
  type UnusableToolchain,
} from "./toolchainselection.js";

export type {
  FileIdentity,
  SelectedToolchain,
  ToolComponent,
  ToolchainIO,
  ToolchainRequest,
  ToolchainSelection,
  UnusableToolchain,
} from "./toolchainselection.js";

/**
 * Host wiring for the PICO spatial toolchain.
 *
 * All selection logic lives in ./toolchainselection.ts, which is pure and takes a
 * ToolchainIO. This file owns the production ToolchainIO built from fs/os/process,
 * plus the three legacy entry points (resolveToolsRoot / listVersions / pickVersion)
 * that existing callers still use. They are compatibility adapters: Task S2 migrates
 * consumers to resolveToolchain(), which additionally identifies the payload bytes.
 *
 * Root order (unchanged, and mirrored by the resolver): the com.pico.spatial.tools
 * Gradle plugin's local.properties[spatial.tools.dir] -> $PICO_HOME -> the default
 * install location used by the Android Studio Spatial plugin (~/Library/PICO/sdk).
 */
export const DEFAULT_TOOLS_ROOT = expandHome("~/Library/PICO/sdk");
export const AVD_HOME = expandHome("~/.pico/avd");
export const DISCOVERY_DIR = expandHome("~/Library/Caches/TemporaryItems/avd/pico_running");

/** The host-backed ToolchainIO the pure resolver runs against in production. */
export function hostToolchainIO(): ToolchainIO {
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    read(target: string): Buffer | null {
      try {
        return fs.statSync(target).isFile() ? fs.readFileSync(target) : null;
      } catch {
        return null;
      }
    },
    entries(target: string): string[] | null {
      try {
        return fs.readdirSync(target);
      } catch {
        return null;
      }
    },
    realpath(target: string): string | null {
      try {
        return fs.realpathSync(target);
      } catch {
        return null;
      }
    },
    executable: isExecutable,
  };
}
registerDefaultToolchainIO(hostToolchainIO);

/**
 * The consumer entry point: component-valid selection against the host filesystem,
 * with the ToolchainIO passed explicitly. Prefer this over `resolveToolchain(request)`
 * — the bare call depends on this module having been imported for its registration
 * side effect, and returns `unavailable/io-unavailable` when it has not been.
 */
export function resolveHostToolchain(request: ToolchainRequest): ToolchainSelection {
  return resolveToolchain(request, hostToolchainIO());
}

// ------------------------------------------------------- operation-scoped selection
//
// What a pack/launch operation resolves ONCE and then hands to every one of its stages.
// Re-resolving per stage is how a two-stage operation ended up packing with one install and
// inspecting with another; the object below is the thing that gets passed down instead.

/** The explicit $PICO_SPATIALBUNDLE binary, identified by its bytes rather than its filename. */
export interface BinaryOverride {
  file: FileIdentity;
  /** Only ever set by an actual bounded `--version` probe during packing; never guessed. */
  reportedVersion: string | null;
}

export interface OperationToolchainRequest extends ToolchainRequest {
  /** The component whose executable this operation runs. Must also appear in `required`. */
  primary: ToolComponent;
  /** Honour $PICO_SPATIALBUNDLE as an explicit packer override (packer operations only). */
  allowBinaryOverride?: boolean;
}

export interface OperationToolchain {
  /** The component-valid host selection, or null when an explicit override carries the operation. */
  selection: SelectedToolchain | null;
  /** Why no selection was available, when an override is carrying the operation regardless. */
  selectionUnavailable: UnusableToolchain | null;
  /** $PICO_SPATIALBUNDLE, identity-disclosed. Structural inspection NEVER launches it. */
  binaryOverride: BinaryOverride | null;
  /** The absolute executable this operation will run for `component`. */
  bin: string;
  component: ToolComponent;
  /** The explicit version pin this operation was asked for, if any. */
  pinnedVersion: string | null;
}

/** The shared tool-schema description, so every operation documents this input identically. */
export const ANDROID_PROJECT_ROOT_DESCRIPTION =
  "Android project root (the directory holding settings.gradle/build.gradle). Used ONLY to read spatial.tools.dir from its local.properties when selecting the toolchain — it is NOT the .spatialproject directory (see projectDir).";

/** Files whose presence makes a directory a readable Android project root. */
export const ANDROID_PROJECT_MARKERS: readonly string[] = [
  "settings.gradle.kts",
  "settings.gradle",
  "build.gradle.kts",
  "build.gradle",
];

export function isToolchainFailure(value: unknown): value is UnusableToolchain {
  return typeof value === "object" && value !== null
    && (value as { status?: unknown }).status !== "ok"
    && typeof (value as { code?: unknown }).code === "string";
}

function unusable(code: string, detail: string): UnusableToolchain {
  return { status: "unavailable", code, detail };
}

/**
 * Structural, process-free preparation of one operation's toolchain: validate any supplied
 * Android project root, resolve the component-valid selection, and identify an explicit
 * $PICO_SPATIALBUNDLE override by reading its bytes. Nothing here is executed — the override's
 * version is only ever established inside the operation's own bounded probe boundary
 * (see `verifyOperationOverride`).
 */
export function resolveOperationToolchain(
  request: OperationToolchainRequest,
  io: ToolchainIO = hostToolchainIO(),
): OperationToolchain | UnusableToolchain {
  // A supplied Android project root is a claim about a directory; check it before packing
  // anything, so a typo does not surface minutes later as an opaque packer failure.
  if (request.androidProjectRoot !== undefined) {
    const declared = request.androidProjectRoot.trim();
    if (!declared) {
      return unusable("unavailable/android-project-unreadable", "androidProjectRoot was supplied but empty");
    }
    const P = io.platform === "win32" ? path.win32 : path.posix;
    const present = ANDROID_PROJECT_MARKERS.filter((marker) => io.read(P.join(declared, marker)) !== null);
    if (present.length === 0) {
      return unusable(
        "unavailable/android-project-unreadable",
        `androidProjectRoot ${declared} carries no readable Android project metadata (expected one of ${ANDROID_PROJECT_MARKERS.join(", ")} at that root)`,
      );
    }
  }

  const pinnedVersion = (request.toolsVersion || request.projectToolsVersion || "") || null;

  let binaryOverride: BinaryOverride | null = null;
  if (request.allowBinaryOverride && request.primary === "packer") {
    const declared = (io.env.PICO_SPATIALBUNDLE ?? "").trim();
    if (declared) {
      if (!io.executable(declared)) {
        return unusable(
          "unavailable/override-unusable",
          `$PICO_SPATIALBUNDLE=${declared} is not an executable file; unset it or point it at a runnable spatialbundle binary`,
        );
      }
      const bytes = io.read(declared);
      if (!bytes) {
        return unusable(
          "unavailable/override-unusable",
          `$PICO_SPATIALBUNDLE=${declared} could not be read to establish its identity`,
        );
      }
      binaryOverride = {
        file: { path: declared, sha256: createHash("sha256").update(bytes).digest("hex") },
        reportedVersion: null,
      };
    }
  }

  const selected = resolveToolchain(
    {
      androidProjectRoot: request.androidProjectRoot,
      toolsRoot: request.toolsRoot,
      toolsVersion: request.toolsVersion,
      projectToolsVersion: request.projectToolsVersion,
      required: request.required,
    },
    io,
  );
  if (selected.status !== "ok") {
    // An explicit override is the caller telling us which binary to run; it carries the
    // operation even when the host has no installed toolchain at all (the behaviour the
    // hardcoded 0.13 fallback used to provide, minus the invented path).
    if (!binaryOverride) return selected;
    return {
      selection: null,
      selectionUnavailable: selected,
      binaryOverride,
      bin: binaryOverride.file.path,
      component: request.primary,
      pinnedVersion,
    };
  }

  const file = selected.files[request.primary];
  if (!file) {
    return unusable(
      "unavailable/component-missing",
      `Selected toolchain ${selected.version} did not carry the operation's primary component ${request.primary}; list it in 'required'`,
    );
  }
  return {
    selection: selected,
    selectionUnavailable: null,
    binaryOverride,
    bin: binaryOverride ? binaryOverride.file.path : file.path,
    component: request.primary,
    pinnedVersion,
  };
}

/** First dotted numeric run in a tool's version output. Never derived from a filename. */
export function extractReportedVersion(output: string): string | null {
  return output.match(/\d+(?:\.\d+)+/)?.[0] ?? null;
}

/** A pin matches a reported version when every component the pin names agrees. */
export function reportedVersionMatchesPin(pin: string, reported: string): boolean {
  if (!isVersionToken(pin)) return false;
  const wanted = pin.split(".").map(Number);
  const actual = reported.split(".").map(Number);
  return wanted.every((part, index) => part === (actual[index] ?? Number.NaN));
}

export type OverrideVersionProbe = (bin: string) => Promise<string>;

const defaultOverrideProbe: OverrideVersionProbe = async (bin) => {
  const r = await run(bin, ["--version"], { timeoutMs: 15_000 });
  return r.code === 0 ? `${r.stdout}\n${r.stderr}` : "";
};

/**
 * Inside the operation's own bounded boundary: when an explicit version pin AND an explicit
 * binary override are both present, the override must prove it is that version. An
 * unprobeable override is `override-version-unverified`; a disagreeing one is
 * `override-version-conflict`. With no pin nothing is launched and `reportedVersion` stays null.
 */
export async function verifyOperationOverride(
  context: OperationToolchain,
  probe: OverrideVersionProbe = defaultOverrideProbe,
): Promise<OperationToolchain | UnusableToolchain> {
  const override = context.binaryOverride;
  if (!override || !context.pinnedVersion) return context;
  const reported = extractReportedVersion(await probe(override.file.path));
  if (!reported) {
    return unusable(
      "unavailable/override-version-unverified",
      `$PICO_SPATIALBUNDLE=${override.file.path} was pinned to version ${context.pinnedVersion} but reported no version of its own; a binary's version is never inferred from its filename`,
    );
  }
  if (!reportedVersionMatchesPin(context.pinnedVersion, reported)) {
    return unusable(
      "unavailable/override-version-conflict",
      `$PICO_SPATIALBUNDLE=${override.file.path} reports version ${reported}, which contradicts the requested pin ${context.pinnedVersion}`,
    );
  }
  return { ...context, binaryOverride: { ...override, reportedVersion: reported } };
}

/** The provenance every pack/launch result discloses: what was selected, and what actually ran. */
export function toolchainProvenance(context: OperationToolchain): Record<string, unknown> {
  return {
    toolchain: context.selection,
    ...(context.selection ? {} : { toolchainUnavailable: context.selectionUnavailable }),
    ...(context.binaryOverride ? { binaryOverride: context.binaryOverride } : {}),
  };
}

/** One line naming the exact binary an operation ran and where it came from. */
export function toolchainProvenanceLine(context: OperationToolchain): string {
  if (context.binaryOverride) {
    const version = context.binaryOverride.reportedVersion ?? "version not probed";
    return `${context.component} from $PICO_SPATIALBUNDLE ${context.binaryOverride.file.path} (${version}, sha256 ${context.binaryOverride.file.sha256.slice(0, 12)})`;
  }
  const selection = context.selection!;
  return `${context.component} ${selection.version} from ${selection.rootSource} ${selection.root} (toolchain ${selection.identity.slice(0, 12)})`;
}

export interface ToolsRoot {
  root: string;
  source: "local.properties" | "PICO_HOME" | "default";
}

/**
 * Compatibility adapter over resolveRootCandidate(). It keeps the legacy contract
 * exactly — including returning DEFAULT_TOOLS_ROOT on a platform for which the
 * resolver refuses to invent one — because the callers that still depend on a root
 * string with no failure channel are migrated in Task S2. It also has nowhere to put
 * the resolver's ambiguous/property-conflict, so a local.properties that declares two
 * different spatial.tools.dir values degrades to the default root here; only
 * resolveToolchain() reports that condition honestly.
 */
export function resolveToolsRoot(projectDir?: string): ToolsRoot {
  const candidate = resolveRootCandidate({ androidProjectRoot: projectDir }, hostToolchainIO());
  if (!("status" in candidate) && candidate.source !== "explicit") {
    return { root: candidate.root, source: candidate.source };
  }
  return { root: DEFAULT_TOOLS_ROOT, source: "default" };
}

export interface VersionInfo {
  version: string;
  hasEditor: boolean;
  hasEmulator: boolean;
  spatialbundle: string | null;
  emulatorBin: string | null;
}

const LEGACY_COMPONENTS: readonly ToolComponent[] = ["packer", "emulator"];

function versionInfo(install: InstallationScan, io: ToolchainIO): VersionInfo {
  return {
    version: install.version,
    hasEditor: (io.entries(path.join(install.dir, "editor")) ?? []).length > 0,
    hasEmulator: (io.entries(path.join(install.dir, "emulator")) ?? []).length > 0,
    spatialbundle: install.components.packer ?? null,
    emulatorBin: install.components.emulator ?? null,
  };
}

export function listVersions(root: string): VersionInfo[] {
  const io = hostToolchainIO();
  const installs = scanInstallations(root, LEGACY_COMPONENTS, io);
  return installs ? installs.map((install) => versionInfo(install, io)) : [];
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Pick a usable toolchain version: the requested one, or the newest carrying the
 * needed payload. Unlike the pre-S1 behaviour, a requested version that does not
 * actually contain the requested component is a miss rather than a hit — that is
 * how an emulator lane used to be handed a packer-only install.
 */
export function pickVersion(
  root: string,
  requested?: string,
  need: "editor" | "emulator" | "any" = "any",
): VersionInfo | null {
  // An empty root is a caller bug, not an invitation to re-resolve the root order.
  if (!root) return null;
  if (need === "any") {
    const editor = pickVersion(root, requested, "editor");
    const emulator = pickVersion(root, requested, "emulator");
    if (!editor) return emulator;
    if (!emulator) return editor;
    return compareVersions(editor.version, emulator.version) >= 0 ? editor : emulator;
  }
  const io = hostToolchainIO();
  const chosen = selectInstallation(
    { toolsRoot: root, toolsVersion: requested, required: [need === "editor" ? "packer" : "emulator"] },
    io,
  );
  if ("status" in chosen) return null;
  const installs = scanInstallations(root, LEGACY_COMPONENTS, io) ?? [];
  const install = installs.find((candidate) => candidate.version === chosen.installation.version);
  return install ? versionInfo(install, io) : null;
}

export function emulatorLibDir(root: string, version: string): string {
  return path.join(root, version, "emulator", "lib");
}

/**
 * Locate a JDK for Gradle. Order: $JAVA_HOME, Android Studio's bundled JBR
 * (the JDK Android devs already have), then /usr/libexec/java_home (macOS).
 * Gradle builds fail with "Unable to locate a Java Runtime" without this.
 */
let cachedJavaHome: string | null | undefined;
export function detectJavaHome(): string | null {
  if (cachedJavaHome !== undefined) return cachedJavaHome;
  const isJdk = (home: string) => {
    try {
      fs.accessSync(path.join(home, "bin", "java"), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (process.env.JAVA_HOME && isJdk(process.env.JAVA_HOME)) return (cachedJavaHome = process.env.JAVA_HOME);
  const candidates = [
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    "/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home",
    expandHome("~/Applications/Android Studio.app/Contents/jbr/Contents/Home"),
  ];
  for (const c of candidates) if (isJdk(c)) return (cachedJavaHome = c);
  return (cachedJavaHome = null);
}

/** Env for Gradle invocations — injects a detected JAVA_HOME when the host has none on PATH. */
export function gradleEnv(): Record<string, string | undefined> {
  const jh = detectJavaHome();
  return jh ? { JAVA_HOME: jh } : {};
}

/** Locate adb: PATH first, then the platform-tools bundled with the emulator payload. */
export async function findAdb(root?: string, version?: string): Promise<string | null> {
  const which = await run("which", ["adb"], { timeoutMs: 5_000 });
  if (which.code === 0 && which.stdout.trim()) return which.stdout.trim();
  if (root && version) {
    const bundled = path.join(root, version, "emulator", "system-images", "platform-tools", "adb");
    if (isExecutable(bundled)) return bundled;
  }
  return null;
}

export interface ToolchainReport {
  toolsRoot: string;
  toolsRootSource: string;
  versions: VersionInfo[];
  selected: string | null;
  spatialbundleVersion: string | null;
  emulatorVersion: string | null;
  adb: string | null;
  javaHome: string | null;
  avdHome: string;
  avds: string[];
  licenseAccepted: boolean;
  protosAvailable: boolean;
  problems: string[];
}

export async function validateToolchain(projectDir?: string, requestedVersion?: string): Promise<ToolchainReport> {
  const problems: string[] = [];
  const { root, source } = resolveToolsRoot(projectDir);
  const versions = listVersions(root);
  if (!fs.existsSync(root)) problems.push(`Tools root does not exist: ${root}`);
  if (versions.length === 0) problems.push(`No toolchain versions found under ${root}`);

  const sel = pickVersion(root, requestedVersion, "any");
  let sbVersion: string | null = null;
  let emuVersion: string | null = null;
  if (sel?.spatialbundle) {
    const r = await run(sel.spatialbundle, ["--version"], { timeoutMs: 15_000 });
    sbVersion = r.code === 0 ? r.stdout.trim() : null;
    if (r.code !== 0) problems.push(`spatialbundle --version failed: ${r.stderr.trim() || r.stdout.trim()}`);
  } else {
    problems.push("No executable spatialbundle binary found (scene compilation unavailable)");
  }
  if (sel?.emulatorBin) {
    const r = await run(sel.emulatorBin, ["-version"], { timeoutMs: 15_000 });
    emuVersion = r.code === 0 ? (r.stdout.split("\n")[0] ?? "").trim() : null;
    if (r.code !== 0) problems.push(`emulator -version failed: ${r.stderr.trim() || r.stdout.trim()}`);
  } else {
    problems.push("No executable emulator binary found (emulator control unavailable)");
  }

  const adb = await findAdb(root, sel?.version);
  if (!adb) problems.push("adb not found on PATH or in bundled platform-tools");

  const javaHome = detectJavaHome();
  if (!javaHome) problems.push("No JDK found (set JAVA_HOME or install Android Studio) — Gradle APK builds will fail");

  const avds = fs.existsSync(AVD_HOME)
    ? fs.readdirSync(AVD_HOME).filter((f) => f.endsWith(".ini")).map((f) => f.replace(/\.ini$/, ""))
    : [];
  if (avds.length === 0) problems.push(`No PICO AVDs found in ${AVD_HOME} (create one via Android Studio Device Manager)`);

  const licenseAccepted = fs.existsSync(path.join(root, "licenses", "pico-spatial-tools-license"));
  if (!licenseAccepted)
    problems.push("PICO license acceptance marker not found — install/accept the toolchain via the official Spatial plugin first");

  const protosAvailable = sel ? fs.existsSync(path.join(emulatorLibDir(root, sel.version), "emulator_controller.proto")) : false;

  return {
    toolsRoot: root,
    toolsRootSource: source,
    versions,
    selected: sel?.version ?? null,
    spatialbundleVersion: sbVersion,
    emulatorVersion: emuVersion,
    adb,
    javaHome,
    avdHome: AVD_HOME,
    avds,
    licenseAccepted,
    protosAvailable,
    problems,
  };
}
