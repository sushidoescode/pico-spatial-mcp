import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHostToolchain } from "./toolchain.js";
import { serializeJavaProperty, TOOLS_DIR_PROPERTY, type SelectedToolchain } from "./toolchainselection.js";
import { readProjectSdkIdentity } from "./projectidentity.js";

/**
 * projectgen.ts — v29.3: emit a complete, buildable PICO spatial Android project from the
 * PACKAGED skeleton (appskeleton/), replacing the old clone-of-~/AndroidStudioProjects/
 * galleryxr-native path that existed only on the author's machine (the tester-distribution
 * blocker: every tarball install died at `scaffold failed`).
 *
 * The skeleton is the proven template minus everything machine-local:
 *  - NO editor-asset module. Vision-verified 2026-07-28: the project assembles, installs,
 *    launches and renders without it — generated Kotlin never referenced it, and the
 *    com.pico.spatial.tools plugin only existed to bake the apartment demo scene.
 *  - NO apartment.bundle / BundleCache (~14MB of demo scene every clone used to carry in its APK).
 *  - Main.kt + HomeStage.kt are a minimal bundle-free hello scene (backdrop plane + unlit
 *    box/sphere/capsule), so a freshly generated project RENDERS with zero external assets.
 *    generate_app_wiring overwrites both when an AppSpec drives the build — same contract as
 *    the clone path had.
 *  - local.properties is GENERATED per machine (sdk.dir detection + spatial.tools.dir),
 *    never shipped. The tools root written there comes from ONE explicit toolchain selection
 *    (supplied by the caller, or resolved once before the destination is created), and it is
 *    reported back in GenerateResult — a generated project should never have to be re-probed
 *    to learn which installation it was pointed at.
 *  - The dependency catalog is COPIED, never rewritten. The host's tool installation and the
 *    project's BOM are different facts: appskeleton/gradle/libs.versions.toml pins the Spatial
 *    SDK BOM, and changing the tools a machine happens to carry must not move it. The copy is
 *    verified byte-for-byte below, and its declared BOM is disclosed as templateBom.
 *  - `_gitignore` files are stored dot-less (npm pack silently drops `.gitignore`) and emitted
 *    as `.gitignore`.
 *
 * Module-relative paths use fileURLToPath, never `new URL().pathname` — percent-encoding in a
 * spaced install path killed the whole doors surface once (scripts/verify-tarball.mjs [M6]).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKELETON_ROOT = path.join(here, "..", "appskeleton");
/** The packaged GameMenu panel bundle fleet/hybrid copy into apps that use generate_game_menu_kotlin. */
export const MENU_BUNDLE_ASSET = path.join(here, "..", "assets", "menu.bundle");
export const SKELETON_PACKAGE = "com.example.spatialapp";

const TEXT_EXT = new Set([".kt", ".kts", ".gradle", ".xml", ".toml", ".properties", ".pro", ".md", ".json"]);
const SKEL_PKG_PATH = SKELETON_PACKAGE.replace(/\./g, "/");

/** Files that must ship for the generator to work. preflight_env and the tarball gate assert these. */
export const SKELETON_CANARIES = [
  "settings.gradle.kts",
  "build.gradle.kts",
  "gradle.properties",
  "gradle/libs.versions.toml",
  "gradle/wrapper/gradle-wrapper.jar",
  "gradle/wrapper/gradle-wrapper.properties",
  "gradlew",
  "app/build.gradle.kts",
  "app/src/main/AndroidManifest.xml",
  `app/src/main/java/${SKEL_PKG_PATH}/Main.kt`,
  `app/src/main/java/${SKEL_PKG_PATH}/content/HomeStage.kt`,
  `app/src/main/java/${SKEL_PKG_PATH}/platform/LaunchActivity.kt`,
  `app/src/main/java/${SKEL_PKG_PATH}/agent/AgentBridgeInitProvider.kt`,
  "app/src/main/res/values/strings.xml",
  "app/src/main/res/values/drawables_3d.xml",
  "app/src/main/res/drawable/icon_3d_layer_0.png",
  // AndroidManifest references this as android:icon AND android:roundIcon. It shipped as a 0-byte
  // file, which debug builds tolerate (AGP passes --no-crunch) but assembleRelease does not — aapt2
  // fails with "failed to read PNG signature". Presence alone never caught it; see the size check below.
  "app/src/main/res/mipmap-xxxhdpi/ic_spatial_launcher.png",
];

/**
 * Structural payload check (stat injectable so preflight fixtures can describe other machines).
 *
 * Checks EXISTENCE and NON-EMPTINESS. Presence alone was not enough: the launcher icon shipped as a
 * 0-byte PNG and passed every gate, because `statSync(...) != null` is true for an empty file. A
 * truncated or empty payload file fails at build time, far from here, so it has to be caught at the
 * package boundary.
 */
export function verifySkeleton(statMtimeMs?: (p: string) => number | null): { ok: boolean; root: string; missing: string[]; empty: string[] } {
  const stat =
    statMtimeMs ??
    ((p: string) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return null;
      }
    });
  const missing = SKELETON_CANARIES.filter((rel) => stat(path.join(SKELETON_ROOT, ...rel.split("/"))) == null);
  // Size is not available through the injected stat (fixtures describe presence, not bytes), so only
  // check it when reading the real filesystem — which is every case that can actually ship a package.
  const empty = statMtimeMs
    ? []
    : SKELETON_CANARIES.filter((rel) => {
        if (missing.includes(rel)) return false;
        try {
          return fs.statSync(path.join(SKELETON_ROOT, ...rel.split("/"))).size === 0;
        } catch {
          return false;
        }
      });
  return { ok: missing.length === 0 && empty.length === 0, root: SKELETON_ROOT, missing, empty };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".DS_Store") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(p);
    }
  };
  rec(dir);
  return out;
}

/** Best-effort Android SDK location for local.properties; Gradle also honors $ANDROID_HOME. */
export function detectAndroidSdkDir(env: NodeJS.ProcessEnv = process.env, home: string = process.env.HOME ?? ""): string | null {
  const candidates = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    home && path.join(home, "Library/Android/sdk"), // macOS default
    home && path.join(home, "Android/Sdk"), // Linux default
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Android", "Sdk"), // Windows default
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Android string resources need MORE than XML-markup escaping. An apostrophe or a double quote is a
 * resource-format escape, so `Sam's Gallery` compiles to "unescaped apostrophe in string" at aapt2 —
 * long after scaffold_spatial_app has already reported success and told the caller to run a build it
 * had made impossible. Escape both here rather than at the call site: every value that reaches a
 * strings.xml goes through this function.
 */
const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "\\'").replace(/"/g, "&quot;");

export interface GenerateOptions {
  targetDir: string;
  packageName: string;
  appName: string;
  stageStyle: "1" | "2" | "3";
  rootProjectName?: string;
  /**
   * The toolchain this project is generated against. Supplied: used as-is, and its `root` is
   * what lands in local.properties — the caller has already chosen, and generation must not
   * silently re-choose. Omitted: resolved ONCE below, before the destination exists.
   */
  toolchain?: SelectedToolchain;
}

/** What the generator copied out of the packaged skeleton, so a caller can prove it was unchanged. */
export interface TemplateBomProvenance {
  /** The BOM version the template declares, read statically — null when it cannot be read. */
  declaredBom: string | null;
  /** sha256 of the GENERATED gradle/libs.versions.toml; equal to the skeleton's by construction. */
  catalogSha256: string;
}

export interface GenerateResult {
  created: string;
  packageName: string;
  appName: string;
  stageStyle: string;
  filesWritten: number;
  sourceDir: string;
  homeStage: string;
  /** The exact selection written into local.properties. Never inferred after the fact. */
  toolchain: SelectedToolchain;
  templateBom: TemplateBomProvenance;
}

const CATALOG_REL = "gradle/libs.versions.toml";
const sha256File = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * A selection reaches here from a tool input as much as from TypeScript, so its shape is checked
 * at runtime. Rejecting it BEFORE the destination is created is the point: a half-written project
 * pointed at an unusable toolchain is worse than no project.
 */
function requireUsableSelection(selection: unknown): SelectedToolchain {
  const candidate = selection as Partial<SelectedToolchain> & { code?: string; detail?: string };
  if (typeof candidate !== "object" || candidate === null || candidate.status !== "ok" || typeof candidate.root !== "string" || candidate.root === "") {
    const code = typeof candidate?.code === "string" ? candidate.code : `${candidate?.status ?? "missing"}/unusable-selection`;
    const detail = typeof candidate?.detail === "string" ? candidate.detail : "the supplied toolchain selection is not an ok selection with a root";
    throw new Error(`cannot generate a project against this toolchain: ${code} — ${detail}`);
  }
  return candidate as SelectedToolchain;
}

/**
 * Generate a fresh project at targetDir (must not exist). Substitutions keep the exact textual
 * shapes the rest of the toolchain regex-rewrites later (strings.xml app_name/homepage_title,
 * manifest pico.spatial.stage.style) — generating in a regex-incompatible shape would silently
 * break every downstream rebrand.
 */
export function generateSpatialProject(opts: GenerateOptions): GenerateResult {
  const { packageName, appName, stageStyle } = opts;
  const dst = opts.targetDir;
  const skel = verifySkeleton();
  if (!skel.ok) throw new Error(`packaged app skeleton incomplete at ${skel.root} — missing: ${skel.missing.join(", ")} (reinstall the package)`);
  if (fs.existsSync(dst)) throw new Error(`Target already exists: ${dst}`);
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName)) throw new Error(`invalid packageName: ${packageName}`);

  // ONE selection, resolved before anything is written. An unusable host toolchain is a
  // structured failure here, not a project pointed at a directory that does not exist.
  const toolchain = requireUsableSelection(opts.toolchain ?? resolveHostToolchain({ required: ["packer"] }));
  const templateCatalog = path.join(SKELETON_ROOT, ...CATALOG_REL.split("/"));
  const templateCatalogSha = sha256File(templateCatalog);
  const templateBom: TemplateBomProvenance = { declaredBom: readProjectSdkIdentity(SKELETON_ROOT).declaredBom, catalogSha256: templateCatalogSha };

  const pkgPath = packageName.replace(/\./g, "/");
  const rootName = (opts.rootProjectName ?? path.basename(dst)).replace(/[^A-Za-z0-9._-]+/g, "-") || "spatialapp";
  let filesWritten = 0;

  for (const abs of walkFiles(SKELETON_ROOT)) {
    const rel = path.relative(SKELETON_ROOT, abs).split(path.sep).join("/");
    let relOut = rel.split(`java/${SKEL_PKG_PATH}`).join(`java/${pkgPath}`);
    if (path.basename(relOut) === "_gitignore") relOut = path.join(path.dirname(relOut), ".gitignore");
    const outAbs = path.join(dst, ...relOut.split("/"));
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    if (TEXT_EXT.has(path.extname(abs))) {
      let s = fs.readFileSync(abs, "utf8").split(SKELETON_PACKAGE).join(packageName);
      if (rel === "settings.gradle.kts") s = s.replace(/rootProject\.name = "[^"]*"/, () => `rootProject.name = "${rootName}"`);
      if (rel === "app/src/main/res/values/strings.xml") {
        s = s.replace(/(<string name="app_name">)[^<]*(<\/string>)/, (_, a, b) => `${a}${xmlEscape(appName)}${b}`);
        s = s.replace(/(<string name="homepage_title">)[^<]*(<\/string>)/, (_, a, b) => `${a}${xmlEscape(appName)}${b}`);
      }
      if (rel === "app/src/main/AndroidManifest.xml") {
        s = s.replace(/(pico\.spatial\.stage\.style"\s*\n?\s*android:value=")[0-9]+(")/, (_, a, b) => `${a}${stageStyle}${b}`);
      }
      fs.writeFileSync(outAbs, s);
    } else {
      fs.copyFileSync(abs, outAbs);
    }
    filesWritten++;
  }
  fs.chmodSync(path.join(dst, "gradlew"), 0o755);
  fs.chmodSync(path.join(dst, "gradlew.bat"), 0o755);

  // The dependency catalog is the project's identity, not the machine's. Nothing above may
  // rewrite it; if anything ever does, that is a defect, not a result to hand back.
  const generatedCatalog = path.join(dst, ...CATALOG_REL.split("/"));
  const generatedCatalogSha = sha256File(generatedCatalog);
  if (generatedCatalogSha !== templateCatalogSha)
    throw new Error(`generation rewrote ${CATALOG_REL} (template ${templateCatalogSha.slice(0, 12)} -> generated ${generatedCatalogSha.slice(0, 12)}) — the project BOM must be copied verbatim`);

  // local.properties — machine-specific by definition, so always generated, never shipped.
  // Escaped per java.util.Properties.store, which is what Gradle reads it back with: a tools
  // root with a space, a drive letter, a '#' or a non-ASCII character must survive verbatim.
  const sdkDir = detectAndroidSdkDir();
  const lp = [
    "# Generated by pico-spatial-mcp (machine-specific — do not commit).",
    ...(sdkDir ? [serializeJavaProperty("sdk.dir", sdkDir.split(path.sep).join("/"))] : []),
    serializeJavaProperty(TOOLS_DIR_PROPERTY, toolchain.root.split(path.sep).join("/")),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dst, "local.properties"), lp);
  filesWritten++;

  const sourceDir = path.join(dst, "app/src/main/java", pkgPath);
  return {
    created: dst,
    packageName,
    appName,
    stageStyle,
    filesWritten,
    sourceDir,
    homeStage: path.join(sourceDir, "content/HomeStage.kt"),
    toolchain,
    templateBom: { ...templateBom, catalogSha256: generatedCatalogSha },
  };
}
