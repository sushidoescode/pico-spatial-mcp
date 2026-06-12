import fs from "node:fs";
import path from "node:path";
import { expandHome, run } from "./util.js";

/**
 * Resolution of the PICO spatial tools root. Mirrors the order used by the
 * com.pico.spatial.tools Gradle plugin: local.properties[spatial.tools.dir]
 * -> $PICO_HOME -> the default install location used by the Android Studio
 * Spatial plugin (~/Library/PICO/sdk on macOS).
 */
export const DEFAULT_TOOLS_ROOT = expandHome("~/Library/PICO/sdk");
export const AVD_HOME = expandHome("~/.pico/avd");
export const DISCOVERY_DIR = expandHome("~/Library/Caches/TemporaryItems/avd/pico_running");

export interface ToolsRoot {
  root: string;
  source: "local.properties" | "PICO_HOME" | "default";
}

export function resolveToolsRoot(projectDir?: string): ToolsRoot {
  if (projectDir) {
    const lp = path.join(expandHome(projectDir), "local.properties");
    if (fs.existsSync(lp)) {
      const m = fs.readFileSync(lp, "utf8").match(/^\s*spatial\.tools\.dir\s*=\s*(.+)\s*$/m);
      if (m) return { root: expandHome(m[1].trim()), source: "local.properties" };
    }
  }
  if (process.env.PICO_HOME) return { root: expandHome(process.env.PICO_HOME), source: "PICO_HOME" };
  return { root: DEFAULT_TOOLS_ROOT, source: "default" };
}

export interface VersionInfo {
  version: string;
  hasEditor: boolean;
  hasEmulator: boolean;
  spatialbundle: string | null;
  emulatorBin: string | null;
}

export function listVersions(root: string): VersionInfo[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => /^\d+\.\d+(\.\d+)?$/.test(d))
    .sort((a, b) => compareVersions(a, b))
    .map((version) => {
      const sb = path.join(root, version, "editor", "spatialbundle", "spatialbundle");
      const emu = path.join(root, version, "emulator", "emulator");
      const editorDir = path.join(root, version, "editor");
      const emulatorDir = path.join(root, version, "emulator");
      return {
        version,
        hasEditor: fs.existsSync(editorDir) && fs.readdirSync(editorDir).length > 0,
        hasEmulator: fs.existsSync(emulatorDir) && fs.readdirSync(emulatorDir).length > 0,
        spatialbundle: isExecutable(sb) ? sb : null,
        emulatorBin: isExecutable(emu) ? emu : null,
      };
    });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Pick a usable toolchain version: the requested one, or the newest with the needed payload. */
export function pickVersion(
  root: string,
  requested?: string,
  need: "editor" | "emulator" | "any" = "any",
): VersionInfo | null {
  const versions = listVersions(root);
  if (requested) return versions.find((v) => v.version === requested) ?? null;
  const usable = versions.filter((v) =>
    need === "editor" ? v.spatialbundle : need === "emulator" ? v.emulatorBin : v.spatialbundle || v.emulatorBin,
  );
  return usable.length ? usable[usable.length - 1] : null;
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
