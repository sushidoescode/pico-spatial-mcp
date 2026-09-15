import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome, run } from "./util.js";
import {
  compareVersions,
  registerDefaultToolchainIO,
  resolveRootCandidate,
  scanInstallations,
  selectInstallation,
  type InstallationScan,
  type ToolComponent,
  type ToolchainIO,
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
