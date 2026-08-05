#!/usr/bin/env node
/**
 * sdk-facts.mjs — re-derive the artifact-level facts about the PICO Spatial SDK
 * from resolved Gradle artifacts, so they can be re-measured against a new BOM
 * instead of re-litigated.
 *
 * Everything this prints is read out of files on disk: the resolved dependency
 * graph that Gradle itself produced, the AARs/JARs in the Gradle module cache,
 * and (when the project has been built) the app's own build outputs. Each fact
 * names the file or command it came from. Anything that cannot be read prints
 * UNKNOWN with a reason. Nothing is inferred from an artifact's *name*:
 *   - "is this a Compose fork artifact?"  -> the AAR manifest's package= attribute
 *   - "is this a lint Detector?"          -> the class file's super_class entry
 *   - "which packages does it ship?"      -> the actual entry paths in classes.jar
 *   - "where was it downloaded from?"     -> Gradle's own resource-at-url.bin index
 *
 * USAGE
 *   node scripts/sdk-facts.mjs [options]
 *
 *   --project <path>        Spatial SDK Gradle project root (has gradlew).
 *                           Default: search ~/AndroidStudioProjects for one whose
 *                           build files reference com.pico.spatial.
 *   --bom <version>         Re-resolve against a different com.pico.spatial:bom
 *                           (e.g. 6.0.0) via a generated Gradle init script. Does
 *                           not modify the project. Needs network (implies no --offline).
 *   --module <name>         Gradle module to resolve. Default :app
 *   --configuration <name>  Default debugRuntimeClasspath
 *   --group-prefix <s>      Artifact scope. Default com.pico.spatial
 *   --offline               Go straight to `--offline` (skip the online attempt).
 *   --no-gradle             Do not run Gradle; requires --deps-file.
 *   --deps-file <path>      Use a previously captured `:app:dependencies` output
 *                           instead of running Gradle (useful on CI / air-gapped).
 *   --gradle-user-home <p>  Default $GRADLE_USER_HOME or ~/.gradle
 *   --timeout-sec <n>       Per-Gradle-invocation wall clock. Default 420.
 *   --json                  Emit JSON only (machine-readable).
 *   --out <path>            Also write the JSON to this file.
 *   --help
 *
 * EXIT CODES
 *   0 ok · 1 usage/setup error · 2 dependency graph could not be resolved, or
 *   resolved with FAILED coordinates in scope (an incomplete graph is not a fact
 *   source — `:dependencies` prints FAILED inline and still exits 0, so this is
 *   checked explicitly rather than trusted to the exit code)
 *
 * KNOWN SCOPE LIMITS (things this deliberately does NOT cover)
 *   - It reads ONE runtime configuration (default debugRuntimeClasspath). The
 *     `com.pico.spatial.tools` Gradle plugin lives on the BUILDSCRIPT classpath and
 *     will not appear. To census it, re-run against that configuration, e.g.
 *     `--module "" --configuration classpath --group-prefix com.pico.spatial.tools`.
 *   - Release-only differences need `--configuration releaseRuntimeClasspath`.
 *   - It reads artifacts, not behaviour. A shipped lint.jar is not a lint run; an
 *     API-gated code path is not an executed one. It never claims otherwise.
 *   - `--bom` moves the BOM coordinate only. Artifacts on an independent version
 *     line (the Compose fork is on its own line) may not move with it — the report
 *     prints each artifact's real resolved version so you can see that.
 *
 * PLATFORM ASSUMPTIONS (be honest about these)
 *   - Written and RUN ONLY ON macOS (darwin). Pure Node, no shelling out to
 *     unzip/javap/strings/grep, so the file reading is portable by construction.
 *   - Windows/Linux code paths (gradlew.bat, SDK/JBR default locations) are
 *     written but UNTESTED. On Windows the Gradle wrapper is spawned via the
 *     shell because .bat files are not directly executable by CreateProcess.
 *   - Requires Node >= 20 (uses node:zlib inflateRawSync, structuredClone-free,
 *     no external dependencies at all).
 *   - Reads a Gradle metadata cache laid out as
 *     <gradle-user-home>/caches/modules-2/{files-2.1,metadata-*}. Verified against
 *     Gradle 8.13 / metadata-2.107. A future Gradle may move these; the script
 *     says UNKNOWN rather than guessing when it cannot find them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";

const IS_WIN = process.platform === "win32";
const HOME = os.homedir();

/* ------------------------------------------------------------------ args -- */

function parseArgs(argv) {
  const o = {
    project: null, bom: null, module: ":app", configuration: "debugRuntimeClasspath",
    groupPrefix: "com.pico.spatial", offline: false, noGradle: false, depsFile: null,
    gradleUserHome: process.env.GRADLE_USER_HOME || path.join(HOME, ".gradle"),
    timeoutSec: 420, json: false, out: null, help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) die(`${a} needs a value`); return v; };
    switch (a) {
      case "--project": o.project = next(); break;
      case "--bom": o.bom = next(); break;
      case "--module": o.module = next(); break;
      case "--configuration": o.configuration = next(); break;
      case "--group-prefix": o.groupPrefix = next(); break;
      case "--gradle-user-home": o.gradleUserHome = next(); break;
      case "--deps-file": o.depsFile = next(); break;
      case "--timeout-sec": o.timeoutSec = Number(next()); break;
      case "--out": o.out = next(); break;
      case "--offline": o.offline = true; break;
      case "--no-gradle": o.noGradle = true; break;
      case "--json": o.json = true; break;
      case "-h": case "--help": o.help = true; break;
      default: die(`unknown option ${a} (try --help)`);
    }
  }
  return o;
}
function die(msg, code = 1) { process.stderr.write(`sdk-facts: ${msg}\n`); process.exit(code); }
function helpText() {
  const src = fs.readFileSync(new URL(import.meta.url), "utf8");
  const block = src.slice(src.indexOf("/**"), src.indexOf("*/") + 2);
  return block.split("\n").map((l) => l.replace(/^\s*\/\*\*/, "").replace(/^\s*\*\/?/, "")).join("\n").trim();
}

/* --------------------------------------------------------------- toolchain */

/** JAVA_HOME resolution, mirroring src/toolchain.ts detectJavaHome(). */
function detectJavaHome() {
  const isJdk = (h) => { try { fs.accessSync(path.join(h, "bin", IS_WIN ? "java.exe" : "java"), fs.constants.X_OK); return true; } catch { return false; } };
  if (process.env.JAVA_HOME && isJdk(process.env.JAVA_HOME)) return { path: process.env.JAVA_HOME, source: "$JAVA_HOME" };
  const candidates = IS_WIN
    ? [
        "C:\\Program Files\\Android\\Android Studio\\jbr",
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Android Studio", "jbr"),
      ]
    : process.platform === "darwin"
    ? [
        "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
        "/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home",
        path.join(HOME, "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
      ]
    : [
        "/opt/android-studio/jbr",
        path.join(HOME, "android-studio/jbr"),
      ];
  for (const c of candidates) if (c && isJdk(c)) return { path: c, source: "Android Studio bundled JBR" };
  return { path: null, source: "not found" };
}

/** ANDROID_HOME: env, then the project's local.properties sdk.dir, then per-OS default. */
function detectAndroidHome(projectDir) {
  for (const v of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    if (process.env[v] && fs.existsSync(process.env[v])) return { path: process.env[v], source: `$${v}` };
  }
  if (projectDir) {
    const lp = path.join(projectDir, "local.properties");
    if (fs.existsSync(lp)) {
      const m = fs.readFileSync(lp, "utf8").match(/^sdk\.dir=(.+)$/m);
      if (m) { const p = m[1].trim().replace(/\\\\/g, "\\").replace(/\\:/g, ":"); if (fs.existsSync(p)) return { path: p, source: `${lp} sdk.dir` }; }
    }
  }
  const def = IS_WIN ? path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk")
    : process.platform === "darwin" ? path.join(HOME, "Library/Android/sdk")
    : path.join(HOME, "Android/Sdk");
  if (def && fs.existsSync(def)) return { path: def, source: "platform default location" };
  return { path: null, source: "not found" };
}

/* ----------------------------------------------------------- project find */

function looksSpatial(dir) {
  const files = ["settings.gradle.kts", "settings.gradle", "app/build.gradle.kts", "app/build.gradle", "gradle/libs.versions.toml"];
  for (const f of files) {
    const p = path.join(dir, f);
    try { if (fs.readFileSync(p, "utf8").includes("com.pico.spatial")) return p; } catch { /* missing */ }
  }
  return null;
}

function findProject(explicit) {
  if (explicit) {
    const dir = path.resolve(explicit.replace(/^~(?=$|\/|\\)/, HOME));
    if (!fs.existsSync(path.join(dir, "gradlew")) && !fs.existsSync(path.join(dir, "gradlew.bat"))) die(`no gradlew in ${dir}`);
    return { dir, why: "--project", marker: looksSpatial(dir) };
  }
  const roots = [path.join(HOME, "AndroidStudioProjects"), process.cwd()];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      if (!fs.existsSync(path.join(dir, "gradlew")) && !fs.existsSync(path.join(dir, "gradlew.bat"))) continue;
      const marker = looksSpatial(dir);
      if (!marker) continue;
      // prefer a project that has already been built: more cross-check evidence available
      const built = fs.existsSync(path.join(dir, "app", "build", "outputs"));
      found.push({ dir, marker, built });
    }
  }
  if (!found.length) die("no Spatial SDK Gradle project found; pass --project <path>");
  found.sort((a, b) => Number(b.built) - Number(a.built) || a.dir.localeCompare(b.dir));
  return { dir: found[0].dir, why: `auto-selected from ${found.length} candidate project(s) under ${roots.join(", ")}${found[0].built ? " (has build outputs)" : ""}`, marker: found[0].marker };
}

/* --------------------------------------------------------------- run gradle */

function runGradle(projectDir, args, env, timeoutSec) {
  return new Promise((resolve) => {
    const wrapper = IS_WIN ? "gradlew.bat" : path.join(projectDir, "gradlew");
    const child = spawn(IS_WIN ? path.join(projectDir, "gradlew.bat") : wrapper, args, {
      cwd: projectDir, env, timeout: timeoutSec * 1000, killSignal: "SIGKILL",
      shell: IS_WIN, windowsHide: true,
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ code: -1, out, err: err + String(e), timedOut: false }));
    child.on("close", (code, signal) => resolve({ code, out, err, timedOut: signal === "SIGKILL" }));
  });
}

function writeBomInitScript(bom, tmpDir) {
  // Substitutes only the BOM coordinate. Every com.pico.spatial.* dependency in a
  // stock Spatial project is declared without a version and constrained by the
  // platform(), so moving the BOM moves the whole first-party set with it.
  const f = path.join(tmpDir, `pico-bom-${bom.replace(/[^\w.-]/g, "_")}.init.gradle`);
  fs.writeFileSync(f, `// generated by scripts/sdk-facts.mjs --bom ${bom}; not written into the project
allprojects {
  configurations.all {
    resolutionStrategy.eachDependency { details ->
      if (details.requested.group == 'com.pico.spatial' && details.requested.name == 'bom') {
        details.useVersion '${bom}'
        details.because 'sdk-facts.mjs --bom ${bom}'
      }
    }
  }
}
`);
  return f;
}

async function resolveGraph(opts, projectDir, javaHome) {
  const attempts = [];
  if (opts.depsFile) {
    const p = path.resolve(opts.depsFile);
    if (!fs.existsSync(p)) die(`--deps-file not found: ${p}`);
    return { text: fs.readFileSync(p, "utf8"), source: `--deps-file ${p}`, attempts };
  }
  if (opts.noGradle) die("--no-gradle requires --deps-file");

  const env = { ...process.env };
  if (javaHome.path) env.JAVA_HOME = javaHome.path;
  const base = [`${opts.module}:dependencies`, "--configuration", opts.configuration, "--console=plain", "-q"];
  const initArgs = [];
  if (opts.bom) {
    const f = writeBomInitScript(opts.bom, fs.mkdtempSync(path.join(os.tmpdir(), "sdk-facts-")));
    initArgs.push("-I", f);
    attempts.push({ note: `--bom ${opts.bom} via generated init script ${f}` });
  }
  const modes = opts.offline ? ["--offline"] : opts.bom ? [null] : [null, "--offline"];
  for (const mode of modes) {
    const args = [...base, ...initArgs, ...(mode ? [mode] : [])];
    const cmd = `./gradlew ${args.join(" ")}`;
    const r = await runGradle(projectDir, args, env, opts.timeoutSec);
    attempts.push({ cmd, exit: r.code, timedOut: r.timedOut, ok: r.code === 0 });
    if (r.code === 0 && /\+---|\\---/.test(r.out)) return { text: r.out, source: `${cmd}  (cwd ${projectDir})`, attempts };
  }
  return { text: null, source: null, attempts };
}

/* --------------------------------------------------------- parse dep tree */

/**
 * Parses `gradle :app:dependencies` tree output.
 * Handles: `g:a:v`, `g:a -> v`, `g:a:v -> w`, the trailing markers
 * `(*)` already-shown subtree, `(c)` constraint only, `(n)` not resolved,
 * and the ` FAILED` suffix Gradle appends to a coordinate it could not resolve
 * (note: `:dependencies` reports those inline and still exits 0, so the caller
 * must check `failed` itself — an unresolved graph is not a fact source).
 */
function parseDepTree(text) {
  const nodes = [];       // {group,name,requested,resolved,depth,marker,failed}
  const edges = [];       // {parentIdx, childIdx}
  const stack = [];       // idx per depth
  for (const raw of text.split("\n")) {
    const m = raw.match(/^([| ]*)([+\\])--- (.*)$/);
    if (!m) continue;
    const depth = Math.round(m[1].length / 5);
    let body = m[3].trim();
    let marker = null;
    const mk = body.match(/\s\((\*|c|n)\)$/);
    if (mk) { marker = mk[1]; body = body.slice(0, mk.index).trim(); }
    let failed = false;
    if (/\sFAILED$/.test(body)) { failed = true; body = body.replace(/\sFAILED$/, "").trim(); }
    if (body.startsWith("project ")) continue;
    let requested = null, resolved = null, group = null, name = null;
    const arrow = body.split(" -> ");
    const left = arrow[0].trim();
    const parts = left.split(":");
    if (parts.length === 3) { group = parts[0]; name = parts[1]; requested = parts[2]; }
    else if (parts.length === 2) { group = parts[0]; name = parts[1]; requested = null; }
    else continue;
    resolved = arrow.length > 1 ? arrow[1].trim() : requested;
    const idx = nodes.length;
    nodes.push({ group, name, requested, resolved, depth, marker, failed, line: raw });
    stack[depth] = idx;
    if (depth > 0 && stack[depth - 1] !== undefined) edges.push({ parent: stack[depth - 1], child: idx });
  }
  return { nodes, edges };
}

/** Coordinates actually on the classpath (constraints, failures and unresolved excluded). */
function resolvedCoords(tree, groupPrefix) {
  const map = new Map();
  for (const n of tree.nodes) {
    if (n.marker === "c" || n.marker === "n" || n.failed) continue;
    if (!n.resolved) continue;
    if (groupPrefix && !n.group.startsWith(groupPrefix)) continue;
    map.set(`${n.group}:${n.name}:${n.resolved}`, { group: n.group, name: n.name, version: n.resolved });
  }
  return [...map.values()].sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name));
}

/* ------------------------------------------------------------- zip reading */

function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory record)");
  let count = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) {
        const z64 = Number(buf.readBigUInt64LE(i + 8));
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOff = Number(buf.readBigUInt64LE(z64 + 48));
        break;
      }
    }
  }
  const entries = []; let p = cdOff;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const dosTime = buf.readUInt16LE(p + 12), dosDate = buf.readUInt16LE(p + 14);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    entries.push({ name, method, csize, usize, lho, dosDate, dosTime });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}
function zipRead(buf, e) {
  const nlen = buf.readUInt16LE(e.lho + 26), elen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nlen + elen;
  const raw = buf.slice(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${e.method} for ${e.name}`);
}
function dosDateISO(dosDate, dosTime) {
  if (!dosDate) return null;
  const y = ((dosDate >> 9) & 0x7f) + 1980, mo = (dosDate >> 5) & 0x0f, d = dosDate & 0x1f;
  const h = (dosTime >> 11) & 0x1f, mi = (dosTime >> 5) & 0x3f, s = (dosTime & 0x1f) * 2;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* -------------------------------------------------------- class file reading */

const JAVA_BY_MAJOR = { 45: "1.1", 46: "1.2", 47: "1.3", 48: "1.4", 49: "5", 50: "6", 51: "7", 52: "8", 53: "9", 54: "10", 55: "11", 56: "12", 57: "13", 58: "14", 59: "15", 60: "16", 61: "17", 62: "18", 63: "19", 64: "20", 65: "21", 66: "22", 67: "23", 68: "24" };

function classMajor(b) { return b.length >= 8 && b.readUInt32BE(0) === 0xcafebabe ? b.readUInt16BE(6) : null; }

/** Full header parse: this/super/interfaces, from the constant pool. No name heuristics. */
function parseClassHeader(b) {
  if (b.length < 10 || b.readUInt32BE(0) !== 0xcafebabe) return null;
  const major = b.readUInt16BE(6), cpCount = b.readUInt16BE(8);
  const utf8 = new Map(), classRef = new Map();
  let p = 10;
  for (let i = 1; i < cpCount; i++) {
    const tag = b[p];
    if (tag === 1) { const len = b.readUInt16BE(p + 1); utf8.set(i, b.slice(p + 3, p + 3 + len).toString("utf8")); p += 3 + len; }
    else if (tag === 7) { classRef.set(i, b.readUInt16BE(p + 1)); p += 3; }
    else if (tag === 8 || tag === 16 || tag === 19 || tag === 20) p += 3;
    else if (tag === 15) p += 4;
    else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) p += 5;
    else if (tag === 5 || tag === 6) { p += 9; i++; }
    else return { major, truncated: `unknown constant-pool tag ${tag}` };
  }
  const nameOf = (ci) => (ci && classRef.has(ci) ? utf8.get(classRef.get(ci)) || null : null);
  p += 2;
  const thisName = nameOf(b.readUInt16BE(p)); p += 2;
  const superName = nameOf(b.readUInt16BE(p)); p += 2;
  const ifc = b.readUInt16BE(p); p += 2;
  const ifaces = [];
  for (let i = 0; i < ifc && p + 2 <= b.length; i++) { ifaces.push(nameOf(b.readUInt16BE(p))); p += 2; }
  return { major, thisName, superName, ifaces, strings: [...utf8.values()] };
}

/* ------------------------------------------------- gradle cache lookups */

const NON_PRIMARY = /-(sources|javadoc|samples-sources|tests)\.jar$/;

/**
 * A resolved coordinate with no file in files-2.1 is not necessarily an error:
 * platforms/BOMs and Gradle-metadata variant redirects (e.g. `:ui:1.0.1` pointing
 * at `:ui-android:1.0.1`) resolve to metadata only. Distinguish the two by asking
 * whether Gradle cached a module descriptor for it.
 */
function hasCachedDescriptor(gradleUserHome, group, name, version) {
  const base = path.join(gradleUserHome, "caches", "modules-2");
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => d.startsWith("metadata-")); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(base, d, "descriptors", group, name, version);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function locateCachedArtifact(gradleUserHome, group, name, version) {
  const dir = path.join(gradleUserHome, "caches", "modules-2", "files-2.1", group, name, version);
  if (!fs.existsSync(dir)) return { file: null, reason: `no cache dir ${dir}`, dir };
  const candidates = [];
  for (const sha of fs.readdirSync(dir)) {
    const sub = path.join(dir, sha);
    let st; try { st = fs.statSync(sub); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      if (NON_PRIMARY.test(f)) continue;
      if (/\.(aar|jar)$/.test(f)) candidates.push(path.join(sub, f));
    }
  }
  if (!candidates.length) return { file: null, reason: `no .aar/.jar under ${dir}`, dir };
  candidates.sort((a, b) => (a.endsWith(".aar") === b.endsWith(".aar") ? 0 : a.endsWith(".aar") ? -1 : 1));
  return { file: candidates[0], others: candidates.slice(1), dir };
}

/** Gradle's own download index. Answers "where did this file come from" with a URL. */
function loadResourceUrlIndex(gradleUserHome) {
  const base = path.join(gradleUserHome, "caches", "modules-2");
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => d.startsWith("metadata-")); } catch { return { urls: [], files: [], reason: `cannot read ${base}` }; }
  const urls = new Set(), files = [];
  for (const d of dirs) {
    const f = path.join(base, d, "resource-at-url.bin");
    if (!fs.existsSync(f)) continue;
    files.push(f);
    const text = fs.readFileSync(f).toString("latin1");
    for (const u of text.match(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+/g) || []) urls.add(u);
  }
  if (!files.length) return { urls: [], files: [], reason: `no resource-at-url.bin under ${base}/metadata-*` };
  return { urls: [...urls], files };
}

function originFor(index, group, name, version) {
  const gp = group.replace(/\./g, "/");
  const needle = `/${gp}/${name}/${version}/`;
  const hits = index.urls.filter((u) => u.includes(needle));
  if (!hits.length) return { host: "UNKNOWN", reason: "no matching URL in Gradle's resource-at-url.bin (artifact may predate this cache, or came from a local/offline repo)", urls: [] };
  const hosts = [...new Set(hits.map((u) => u.split("/")[2]))];
  const exts = {};
  for (const u of hits) { const e = (u.match(/\.([a-z-]+)$/) || [, "?"])[1]; exts[e] = (exts[e] || 0) + 1; }
  return { host: hosts.length === 1 ? hosts[0] : hosts.join(" + "), urls: hits.sort(), fetched: Object.keys(exts).sort() };
}

/* -------------------------------------------------------- AAR/JAR inspection */

function inspectArtifact(coord, file) {
  const rec = {
    coordinate: `${coord.group}:${coord.name}:${coord.version}`, group: coord.group, name: coord.name, version: coord.version,
    file, kind: file.endsWith(".aar") ? "aar" : "jar", sizeBytes: null,
    manifest: null, aarMetadata: null, packages: {}, classCount: 0, majors: {},
    buildTimeJars: [], soEntries: [], lint: null, errors: [],
  };
  let buf;
  try { buf = fs.readFileSync(file); rec.sizeBytes = buf.length; } catch (e) { rec.errors.push(`unreadable: ${e.message}`); return rec; }
  let entries;
  try { entries = readZipEntries(buf); } catch (e) { rec.errors.push(`zip: ${e.message}`); return rec; }
  rec.entryCount = entries.length;

  // .so anywhere in the artifact (AAR native libs live under jni/)
  rec.soEntries = entries.filter((e) => e.name.endsWith(".so")).map((e) => ({ path: e.name, bytes: e.usize }));

  // AAR manifest (plain-text XML inside an AAR; not binary AXML)
  const man = entries.find((e) => e.name === "AndroidManifest.xml");
  if (man) { try { rec.manifest = zipRead(buf, man).toString("utf8"); } catch (e) { rec.errors.push(`AndroidManifest.xml: ${e.message}`); } }

  // AAR metadata properties (minCompileSdk / minAndroidGradlePluginVersion live here)
  const meta = entries.find((e) => e.name === "META-INF/com/android/build/gradle/aar-metadata.properties");
  if (meta) {
    try {
      const props = {};
      for (const line of zipRead(buf, meta).toString("utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)$/); if (m) props[m[1]] = m[2].trim();
      }
      rec.aarMetadata = { props, entry: meta.name };
    } catch (e) { rec.errors.push(`aar-metadata.properties: ${e.message}`); }
  }

  // license markers: which vendors' META-INF LICENSE files are present
  rec.licenseEntries = entries.filter((e) => /^META-INF\/.*LICENSE(\.txt)?$/i.test(e.name)).map((e) => ({ path: e.name, bytes: e.usize }));
  // build timestamps of real entries (1980-01-01 == normalized/reproducible build)
  const stamps = entries.filter((e) => e.usize > 0).map((e) => dosDateISO(e.dosDate, e.dosTime)).filter(Boolean).sort();
  rec.entryTimestampRange = stamps.length ? { min: stamps[0], max: stamps[stamps.length - 1] } : null;

  // class census from classes.jar (the app-runtime bytecode)
  const classesJar = entries.find((e) => e.name === "classes.jar") || (rec.kind === "jar" ? null : undefined);
  const censusFrom = (jarBuf, label) => {
    const je = readZipEntries(jarBuf).filter((e) => e.name.endsWith(".class"));
    for (const c of je) {
      let cb; try { cb = zipRead(jarBuf, c); } catch { rec.errors.push(`${label}!${c.name}: inflate failed`); continue; }
      const mj = classMajor(cb);
      if (mj === null) { rec.errors.push(`${label}!${c.name}: not a class file`); continue; }
      rec.majors[mj] = (rec.majors[mj] || 0) + 1;
      rec.classCount++;
      const pkg = c.name.slice(0, c.name.lastIndexOf("/")).replace(/\//g, ".") || "(default)";
      rec.packages[pkg] = (rec.packages[pkg] || 0) + 1;
    }
  };
  try {
    if (classesJar) { rec.classesSource = "classes.jar"; censusFrom(zipRead(buf, classesJar), "classes.jar"); }
    else if (rec.kind === "jar") { rec.classesSource = path.basename(file); censusFrom(buf, path.basename(file)); }
    else rec.errors.push("no classes.jar in AAR");
  } catch (e) { rec.errors.push(`class census: ${e.message}`); }

  // build-time jars shipped inside the AAR (lint.jar, api.jar) — separate bytecode population
  for (const e of entries) {
    if (!/(^|\/)(lint|api)\.jar$/.test(e.name)) continue;
    let jb; try { jb = zipRead(buf, e); } catch (err) { rec.errors.push(`${e.name}: ${err.message}`); continue; }
    const inner = readZipEntries(jb);
    const classes = inner.filter((x) => x.name.endsWith(".class"));
    const majors = {};
    const parsed = [];
    for (const c of classes) {
      let cb; try { cb = zipRead(jb, c); } catch { continue; }
      const h = parseClassHeader(cb);
      if (!h) continue;
      majors[h.major] = (majors[h.major] || 0) + 1;
      parsed.push({ entry: c.name, thisName: h.thisName, superName: h.superName, ifaces: h.ifaces || [], strings: h.strings || [] });
    }
    const jarRec = { entry: e.name, bytes: e.usize, classCount: classes.length, majors };
    rec.buildTimeJars.push(jarRec);

    if (/lint\.jar$/.test(e.name)) {
      // registry from the jar manifest attribute + IssueRegistry subclasses (structural)
      let registryAttr = null;
      const mf = inner.find((x) => x.name === "META-INF/MANIFEST.MF");
      if (mf) { try { registryAttr = (zipRead(jb, mf).toString("utf8").match(/Lint-Registry(?:-v2)?:\s*([\w.$]+)/) || [])[1] || null; } catch { /* ignore */ } }
      const detectors = parsed
        .filter((c) => c.superName === "com/android/tools/lint/detector/api/Detector")
        .map((c) => ({
          className: (c.thisName || "").replace(/\//g, "."),
          scanners: c.ifaces.filter((i) => i && i.startsWith("com/android/tools/lint/detector/api/Detector$")).map((i) => i.split("$").pop()),
          // Issue ids / messages are string constants in the detector's own constant pool.
          issueStrings: c.strings.filter((s) => /^(Missing |Need to define |Unspecified |[A-Z][A-Za-z]+(NotFount|NotFound|Detector)$)/.test(s)).slice(0, 8),
        }))
        .sort((a, b) => a.className.localeCompare(b.className));
      const registries = parsed.filter((c) => c.superName === "com/android/tools/lint/client/api/IssueRegistry").map((c) => (c.thisName || "").replace(/\//g, "."));
      rec.lint = { entry: e.name, bytes: e.usize, classCount: classes.length, majors, registryAttribute: registryAttr, registryClasses: registries, detectors, detectorEvidence: "class file super_class == com/android/tools/lint/detector/api/Detector" };
    }
  }
  return rec;
}

/* --------------------------------------------------------- manifest parsing */

function manifestFacts(xml) {
  if (!xml) return null;
  const attr = (tag, a) => { const m = tag.match(new RegExp(`android:${a}\\s*=\\s*"([^"]*)"`)); return m ? m[1] : null; };
  const pkg = (xml.match(/<manifest[^>]*\bpackage\s*=\s*"([^"]+)"/s) || [])[1] || null;
  const usesSdk = xml.match(/<uses-sdk\b[^>]*>/s);
  const minSdk = usesSdk ? attr(usesSdk[0], "minSdkVersion") : null;
  const targetSdk = usesSdk ? attr(usesSdk[0], "targetSdkVersion") : null;
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, "");
  const appBlock = stripped.match(/<application\b[\s\S]*?<\/application>|<application\b[^>]*\/>/);
  const contributions = [];
  const collect = (scope, src) => {
    for (const m of src.matchAll(/<(meta-data|activity|service|provider|receiver|uses-permission|uses-feature|uses-library|queries|uses-native-library)\b([\s\S]*?)(\/>|>)/g)) {
      const kind = m[1], body = m[0];
      const name = attr(body, "name");
      const value = kind === "meta-data" ? attr(body, "value") : null;
      contributions.push({ scope, kind, name, value });
    }
  };
  if (appBlock) collect("application", appBlock[0]);
  collect("manifest", stripped.replace(appBlock ? appBlock[0] : "\u0000", ""));
  return { package: pkg, minSdkVersion: minSdk, targetSdkVersion: targetSdk, hasApplicationElement: !!appBlock, contributions };
}

/** Cross-check: what the manifest-merger blame report says each artifact ADDED. */
function readMergerBlame(projectDir) {
  const logDir = path.join(projectDir, "app", "build", "outputs", "logs");
  let files = [];
  try { files = fs.readdirSync(logDir).filter((f) => /^manifest-merger-.*-report\.txt$/.test(f)); } catch { return { file: null, reason: `no ${logDir}` }; }
  if (!files.length) return { file: null, reason: `no manifest-merger-*-report.txt in ${logDir}` };
  const file = path.join(logDir, files.sort()[0]);
  const text = fs.readFileSync(file, "utf8");
  const byArtifact = {};
  const lines = text.split("\n");
  let currentNode = null;
  for (const line of lines) {
    const node = line.match(/^([a-z-]+(?:#[^\s]+)?)\s*$/);
    if (node && !/^\s/.test(line)) currentNode = node[1];
    const m = line.match(/^(ADDED|MERGED|INJECTED|IMPLIED) from \[([^\]]+)\]/);
    if (m) {
      const art = m[2];
      (byArtifact[art] ||= []).push({ action: m[1], node: currentNode });
    }
  }
  return { file, byArtifact };
}

/* ---------------------------------------------------------- version compare */
function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+]/), pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]), nb = Number(pb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) { const c = String(pa[i] ?? "").localeCompare(String(pb[i] ?? "")); if (c) return c; continue; }
    if (na !== nb) return na - nb;
  }
  return 0;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { process.stdout.write(helpText() + "\n"); return; }

  const started = new Date().toISOString();
  const proj = findProject(opts.project);
  const javaHome = detectJavaHome();
  const androidHome = detectAndroidHome(proj.dir);

  const report = {
    tool: "scripts/sdk-facts.mjs",
    generatedAt: started,
    host: { platform: process.platform, arch: process.arch, node: process.version },
    inputs: {
      project: proj.dir, projectSelection: proj.why, spatialMarkerFile: proj.marker,
      module: opts.module, configuration: opts.configuration, groupPrefix: opts.groupPrefix,
      bomOverride: opts.bom, gradleUserHome: opts.gradleUserHome,
      javaHome: javaHome.path || "UNKNOWN", javaHomeSource: javaHome.source,
      androidHome: androidHome.path || "UNKNOWN", androidHomeSource: androidHome.source,
    },
    resolution: {}, facts: {}, notes: [],
  };
  if (!javaHome.path) report.notes.push("No JDK located — Gradle will likely fail. Set JAVA_HOME.");
  if (!androidHome.path) report.notes.push("No Android SDK located — Gradle may fail. Set ANDROID_HOME or local.properties sdk.dir.");

  const graph = await resolveGraph(opts, proj.dir, javaHome);
  report.resolution = { source: graph.source || "UNKNOWN", attempts: graph.attempts };
  if (!graph.text) {
    report.resolution.error = "dependency graph could not be resolved; every fact below would be a guess";
    emit(report, opts);
    process.exit(2);
  }

  const tree = parseDepTree(graph.text);
  const coords = resolvedCoords(tree, opts.groupPrefix);
  report.resolution.nodesParsed = tree.nodes.length;
  report.resolution.scopedArtifacts = coords.map((c) => `${c.group}:${c.name}:${c.version}`);

  // `:dependencies` prints FAILED inline and still exits 0. An incomplete graph is
  // not a fact source, so say so loudly rather than emitting a thin, plausible report.
  const failedAll = tree.nodes.filter((n) => n.failed).map((n) => `${n.group}:${n.name}${n.requested ? `:${n.requested}` : ""}${n.resolved && n.resolved !== n.requested ? ` -> ${n.resolved}` : ""}`);
  const failedScoped = failedAll.filter((c) => c.startsWith(opts.groupPrefix));
  report.resolution.failedCoordinates = [...new Set(failedAll)];
  report.resolution.failedScopedCoordinates = [...new Set(failedScoped)];
  if (failedScoped.length) {
    report.resolution.incomplete = true;
    report.notes.push(`GRAPH INCOMPLETE: ${[...new Set(failedScoped)].join(", ")} could not be resolved. Every fact below is derived from what DID resolve and is therefore partial. Re-run online, or with a BOM version that exists.`);
  }

  // BOM: what version resolved, and what it constrains (constraint-marked children)
  const bomNode = tree.nodes.find((n) => n.group === "com.pico.spatial" && n.name === "bom" && n.marker !== "c" && !n.failed);
  const bomManaged = [];
  if (bomNode) {
    const bomIdx = tree.nodes.indexOf(bomNode);
    for (const e of tree.edges) if (e.parent === bomIdx) {
      const c = tree.nodes[e.child];
      bomManaged.push(`${c.group}:${c.name}:${c.resolved}`);
    }
  }
  report.facts.bom = {
    value: bomNode ? `com.pico.spatial:bom:${bomNode.resolved}` : "UNKNOWN",
    reason: bomNode ? undefined : "no com.pico.spatial:bom node in the resolved graph",
    managedModules: bomManaged.length ? bomManaged : "UNKNOWN",
    source: graph.source,
  };

  // Inspect every scoped artifact
  const urlIndex = loadResourceUrlIndex(opts.gradleUserHome);
  const artifacts = [];
  for (const c of coords) {
    const loc = locateCachedArtifact(opts.gradleUserHome, c.group, c.name, c.version);
    if (!loc.file) {
      const desc = hasCachedDescriptor(opts.gradleUserHome, c.group, c.name, c.version);
      artifacts.push({
        coordinate: `${c.group}:${c.name}:${c.version}`, ...c, file: null, errors: [],
        metadataOnly: !!desc,
        unresolvedReason: desc
          ? `metadata-only module: descriptor cached at ${desc} but no .aar/.jar in files-2.1 (a platform/BOM, or a Gradle-metadata variant redirect). Not an error; nothing to inspect.`
          : loc.reason,
      });
      continue;
    }
    const rec = inspectArtifact(c, loc.file);
    rec.manifestFacts = manifestFacts(rec.manifest);
    rec.origin = originFor(urlIndex, c.group, c.name, c.version);
    artifacts.push(rec);
  }
  report.artifacts = artifacts.map((a) => ({
    coordinate: a.coordinate, file: a.file, sizeBytes: a.sizeBytes, classCount: a.classCount,
    metadataOnly: a.metadataOnly, unresolvedReason: a.unresolvedReason, errors: a.errors,
  }));

  const withFile = artifacts.filter((a) => a.file);

  /* ---- FACT: minSdk floor ------------------------------------------------ */
  {
    const rows = withFile.map((a) => ({
      coordinate: a.coordinate,
      minSdkVersion: a.manifestFacts?.minSdkVersion ?? "UNKNOWN",
      manifestPackage: a.manifestFacts?.package ?? "UNKNOWN",
      source: `${a.file}!AndroidManifest.xml`,
    }));
    const nums = rows.map((r) => Number(r.minSdkVersion)).filter((n) => Number.isFinite(n));
    report.facts.minSdkFloor = {
      value: nums.length ? String(Math.max(...nums)) : "UNKNOWN",
      meaning: "highest uses-sdk/@minSdkVersion across the scoped AAR manifests = the manifest-merger floor these artifacts impose",
      perArtifact: rows,
      unknown: rows.filter((r) => r.minSdkVersion === "UNKNOWN").map((r) => r.coordinate),
    };
  }

  /* ---- FACT: compileSdk floor + AGP floor + desugaring ------------------- */
  {
    const rows = withFile.map((a) => ({
      coordinate: a.coordinate,
      minCompileSdk: a.aarMetadata?.props?.minCompileSdk ?? "UNKNOWN",
      minAndroidGradlePluginVersion: a.aarMetadata?.props?.minAndroidGradlePluginVersion ?? "UNKNOWN",
      coreLibraryDesugaringEnabled: a.aarMetadata?.props?.coreLibraryDesugaringEnabled ?? "UNKNOWN",
      source: a.aarMetadata ? `${a.file}!META-INF/com/android/build/gradle/aar-metadata.properties` : `${a.file} (file absent)`,
    }));
    const cs = rows.map((r) => Number(r.minCompileSdk)).filter((n) => Number.isFinite(n));
    const agp = rows.map((r) => r.minAndroidGradlePluginVersion).filter((v) => v !== "UNKNOWN");
    report.facts.compileSdkFloor = {
      value: cs.length ? String(Math.max(...cs)) : "UNKNOWN",
      meaning: "highest minCompileSdk; AGP's check<Variant>AarMetadata hard-fails a build compiling below it",
      distinct: [...new Set(rows.map((r) => r.minCompileSdk))].sort(),
      perArtifact: rows.map((r) => ({ coordinate: r.coordinate, minCompileSdk: r.minCompileSdk, source: r.source })),
    };
    report.facts.agpFloor = {
      value: agp.length ? agp.slice().sort(cmpVersion).pop() : "UNKNOWN",
      meaning: "highest minAndroidGradlePluginVersion; below it check<Variant>AarMetadata fails naming the artifact",
      distinct: [...new Set(agp)].sort(cmpVersion),
      perArtifact: rows.map((r) => ({ coordinate: r.coordinate, minAndroidGradlePluginVersion: r.minAndroidGradlePluginVersion, source: r.source })),
    };
    report.facts.coreLibraryDesugaring = {
      value: [...new Set(rows.map((r) => r.coreLibraryDesugaringEnabled))].sort().join(", ") || "UNKNOWN",
      perArtifact: rows.map((r) => ({ coordinate: r.coordinate, coreLibraryDesugaringEnabled: r.coreLibraryDesugaringEnabled })),
    };
  }

  /* ---- FACT: java bytecode level census --------------------------------- */
  {
    const runtimeTotals = {}, perArtifact = [];
    for (const a of withFile) {
      for (const [mj, n] of Object.entries(a.majors)) runtimeTotals[mj] = (runtimeTotals[mj] || 0) + n;
      perArtifact.push({
        coordinate: a.coordinate, classes: a.classCount,
        majors: Object.fromEntries(Object.entries(a.majors).map(([m, n]) => [`major ${m} (Java ${JAVA_BY_MAJOR[m] || "?"})`, n])),
        source: `${a.file}!${a.classesSource || "classes.jar"} — class file bytes 6-7 of every .class entry`,
      });
    }
    const buildTime = [];
    for (const a of withFile) for (const j of a.buildTimeJars) {
      buildTime.push({
        coordinate: a.coordinate, entry: j.entry, classes: j.classCount,
        majors: Object.fromEntries(Object.entries(j.majors).map(([m, n]) => [`major ${m} (Java ${JAVA_BY_MAJOR[m] || "?"})`, n])),
        source: `${a.file}!${j.entry}`,
      });
    }
    const total = Object.values(runtimeTotals).reduce((x, y) => x + y, 0);
    report.facts.javaBytecode = {
      value: total ? Object.entries(runtimeTotals).sort((a, b) => b[1] - a[1]).map(([m, n]) => `major ${m} (Java ${JAVA_BY_MAJOR[m] || "?"}) × ${n}`).join(", ") : "UNKNOWN",
      meaning: "app-runtime bytecode census across every classes.jar in the scoped artifacts (full census, not a sample)",
      totalClasses: total,
      distributionRuntime: runtimeTotals,
      perArtifact,
      buildTimeJars: buildTime.length ? buildTime : "none found (no lint.jar/api.jar in the scoped artifacts)",
      note: "build-time jars shipped inside an AAR (lint.jar/api.jar) are a SEPARATE population; they run on the Gradle JVM, not the device.",
    };
  }

  /* ---- FACT: native code ------------------------------------------------ */
  {
    const perArtifact = withFile.map((a) => ({ coordinate: a.coordinate, soEntries: a.soEntries, source: `${a.file} (zip central directory)` }));
    const anySo = perArtifact.filter((r) => r.soEntries.length);
    const nativeDirs = [];
    const base = path.join(proj.dir, "app", "build", "intermediates", "merged_native_libs");
    const walkNative = (dir, rel) => {
      let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkNative(p, path.join(rel, e.name));
        else if (e.name.endsWith(".so")) nativeDirs.push({ path: path.join(rel, e.name), abi: rel.split(path.sep).pop(), bytes: fs.statSync(p).size, full: p });
      }
    };
    if (fs.existsSync(base)) walkNative(base, "");
    report.facts.nativeCode = {
      value: anySo.length ? `${anySo.length} scoped artifact(s) ship .so` : "no .so in any scoped artifact",
      perArtifact,
      appMergedNativeLibs: fs.existsSync(base)
        ? { dir: base, abis: [...new Set(nativeDirs.map((n) => n.abi))].sort(), libs: nativeDirs.map((n) => ({ path: n.path, abi: n.abi, bytes: n.bytes })) }
        : { value: "UNKNOWN", reason: `not built: no ${base}` },
    };
  }

  /* ---- FACT: artifact -> package map ------------------------------------ */
  {
    const rows = withFile.map((a) => {
      const scoped = {}, foreign = {};
      for (const [pkg, n] of Object.entries(a.packages)) {
        if (pkg.startsWith(opts.groupPrefix)) scoped[pkg] = n;
        else { const root = pkg.split(".").slice(0, 3).join("."); foreign[root] = (foreign[root] || 0) + n; }
      }
      return {
        coordinate: a.coordinate, totalClasses: a.classCount,
        scopedPackages: Object.fromEntries(Object.entries(scoped).sort((x, y) => y[1] - x[1])),
        otherPackageRoots: Object.fromEntries(Object.entries(foreign).sort((x, y) => y[1] - x[1])),
        source: `${a.file}!${a.classesSource || "classes.jar"} — entry paths of every .class`,
      };
    });
    // packages shipped by more than one artifact (split packages)
    const owners = {};
    for (const r of rows) for (const p of Object.keys(r.scopedPackages)) (owners[p] ||= []).push(r.coordinate);
    report.facts.packageMap = {
      value: `${rows.length} artifact(s) censused`,
      meaning: `which ${opts.groupPrefix}.* packages each artifact actually ships (class census, not naming)`,
      perArtifact: rows,
      splitPackages: Object.fromEntries(Object.entries(owners).filter(([, v]) => v.length > 1)),
    };
  }

  /* ---- FACT: Compose fork ----------------------------------------------- */
  {
    // Structural discriminator: a scoped artifact whose AAR manifest declares a
    // package OUTSIDE the scoped group is shipping someone else's namespace.
    const forks = withFile.filter((a) => a.manifestFacts?.package && !a.manifestFacts.package.startsWith(opts.groupPrefix));
    const forkRows = forks.map((a) => {
      const idx = tree.nodes.findIndex((n) => n.group === a.group && n.name === a.name && n.resolved === a.version && n.marker !== "c" && !n.failed);
      const declared = [];
      if (idx >= 0) for (const e of tree.edges) if (e.parent === idx) {
        const c = tree.nodes[e.child];
        if (c.marker === "c" || c.failed) continue;
        declared.push({ coordinate: `${c.group}:${c.name}`, declared: c.requested ?? "(no version)", resolved: c.resolved });
      }
      const upstreamNs = a.manifestFacts.package.split(".").slice(0, 2).join(".");
      const normalized = a.entryTimestampRange && a.entryTimestampRange.max.startsWith("1980-");
      const vendorLicense = a.licenseEntries.filter((l) => l.path.replace(/^META-INF\//, "").startsWith(opts.groupPrefix.replace(/\./g, "/")));
      return {
        coordinate: a.coordinate,
        manifestPackage: a.manifestFacts.package,
        manifestPackageSource: `${a.file}!AndroidManifest.xml package=`,
        downloadedFrom: a.origin.host,
        downloadUrls: a.origin.urls,
        downloadSource: urlIndex.files.length ? urlIndex.files.join(", ") : urlIndex.reason,
        licenseEntries: a.licenseEntries,
        addedVendorLicenseEntries: vendorLicense.map((l) => l.path),
        entryTimestampRange: a.entryTimestampRange,
        timestampsNormalized: normalized,
        declaresUpstream: declared.filter((d) => d.coordinate.startsWith(upstreamNs)),
        declaresAll: declared,
      };
    });
    // The other half of the discriminator: artifacts in the SAME upstream namespace
    // family that are published under their own group — i.e. the stock ones — and
    // where THEY came from. Uses the 2-segment root (e.g. androidx.compose) so that
    // siblings the fork does not replace (runtime, animation, material, ui-tooling)
    // are included: "which of these is forked and which is stock" is the question.
    const upstreamNamespaces = [...new Set(forks.map((a) => a.manifestFacts.package.split(".").slice(0, 2).join(".")))];
    const stock = [];
    for (const n of tree.nodes) {
      if (n.marker === "c" || n.marker === "n" || n.failed || !n.resolved) continue;
      if (n.group.startsWith(opts.groupPrefix)) continue;
      if (!upstreamNamespaces.some((ns) => n.group === ns || n.group.startsWith(ns + "."))) continue;
      const key = `${n.group}:${n.name}:${n.resolved}`;
      if (stock.some((s) => s.coordinate === key)) continue;
      const loc = locateCachedArtifact(opts.gradleUserHome, n.group, n.name, n.resolved);
      const o = originFor(urlIndex, n.group, n.name, n.resolved);
      const row = { coordinate: key, downloadedFrom: o.host, fetchedExtensions: o.fetched || "UNKNOWN", cachedFile: loc.file || `UNKNOWN (${loc.reason})` };
      // symmetric evidence: does the stock artifact carry a vendor LICENSE the fork added?
      if (loc.file) {
        try {
          const b = fs.readFileSync(loc.file);
          const es = readZipEntries(b);
          row.licenseEntries = es.filter((e) => /^META-INF\/.*LICENSE(\.txt)?$/i.test(e.name)).map((e) => e.name);
          row.addedVendorLicenseEntries = row.licenseEntries.filter((p) => p.replace(/^META-INF\//, "").startsWith(opts.groupPrefix.replace(/\./g, "/")));
          const stamps = es.filter((e) => e.usize > 0).map((e) => dosDateISO(e.dosDate, e.dosTime)).filter(Boolean).sort();
          row.entryTimestampRange = stamps.length ? { min: stamps[0], max: stamps[stamps.length - 1] } : null;
          row.timestampsNormalized = !!(row.entryTimestampRange && row.entryTimestampRange.max.startsWith("1980-"));
        } catch (e) { row.inspectError = e.message; }
      }
      stock.push(row);
    }
    stock.sort((a, b) => a.coordinate.localeCompare(b.coordinate));
    const hosts = [...new Set(forkRows.map((r) => r.downloadedFrom))];
    const stockHosts = [...new Set(stock.map((r) => r.downloadedFrom))];
    const nNorm = forkRows.filter((r) => r.timestampsNormalized).length;
    report.facts.composeFork = {
      value: forkRows.length ? `${forkRows.length} scoped artifact(s) ship a foreign manifest package` : "no forked artifacts detected",
      discriminator: "AAR manifest package= is outside the scoped group (fork), vs. the same namespace published under its own group (stock) — plus the repository host each was actually downloaded from",
      forkHosts: hosts, stockHosts,
      reliableTells: [
        "manifest package= outside the publishing group",
        `an ADDED META-INF/${opts.groupPrefix.replace(/\./g, "/")}/**/LICENSE.txt alongside the upstream one`,
        "the repository host in Gradle's download index",
      ],
      unreliableTells: nNorm
        ? [`zip entry timestamps: ${nNorm}/${forkRows.length} fork artifact(s) here are normalized to 1980 exactly like a stock Google build, so "real build timestamps" does NOT discriminate fork from stock in general — it only happened to hold for the artifact(s) that are not normalized`]
        : [],
      forkArtifacts: forkRows,
      stockSameNamespaceArtifacts: stock,
    };
  }

  /* ---- FACT: repository channels ---------------------------------------- */
  {
    const hosts = {};
    for (const u of urlIndex.urls) { const h = u.split("/")[2]; hosts[h] = (hosts[h] || 0) + 1; }
    const scopedPath = `/${opts.groupPrefix.replace(/\./g, "/")}/`;
    const scopedUrls = urlIndex.urls.filter((u) => u.includes(scopedPath));
    const scopedHosts = {};
    for (const u of scopedUrls) { const h = u.split("/")[2]; scopedHosts[h] = (scopedHosts[h] || 0) + 1; }
    report.facts.repositoryChannels = {
      value: Object.keys(scopedHosts).length ? Object.entries(scopedHosts).map(([h, n]) => `${h} (${n} URLs)`).join(", ") : "UNKNOWN",
      meaning: `every distinct URL Gradle recorded downloading under a ${opts.groupPrefix} path, by host`,
      scopedUrlCount: scopedUrls.length,
      scopedHosts,
      allHosts: hosts,
      source: urlIndex.files.length ? urlIndex.files.join(", ") : `UNKNOWN (${urlIndex.reason})`,
      caveat: "this is a whole-cache index, not scoped to this project's graph; it shows every version this machine ever fetched, including ones not resolved here",
    };
  }

  /* ---- FACT: manifest injections ---------------------------------------- */
  {
    const blame = readMergerBlame(proj.dir);
    const rows = withFile.map((a) => ({
      coordinate: a.coordinate,
      manifestPackage: a.manifestFacts?.package ?? "UNKNOWN",
      hasApplicationElement: a.manifestFacts?.hasApplicationElement ?? "UNKNOWN",
      contributions: a.manifestFacts?.contributions ?? "UNKNOWN",
      source: `${a.file}!AndroidManifest.xml`,
      mergerBlame: blame.byArtifact
        ? (Object.entries(blame.byArtifact).find(([k]) => k.includes(`${a.group}:${a.name}:${a.version}`)) || [null, "no ADDED/MERGED rows attributed to this artifact"])[1]
        : `UNKNOWN (${blame.reason})`,
    }));
    const injectors = rows.filter((r) => Array.isArray(r.contributions) && r.contributions.some((c) => c.scope === "application"));
    report.facts.manifestInjections = {
      value: injectors.length ? `${injectors.length} artifact(s) inject into <application>` : "no artifact injects into <application>",
      perArtifact: rows,
      mergerBlameReport: blame.file || `UNKNOWN (${blame.reason})`,
    };
  }

  /* ---- FACT: shipped lint ----------------------------------------------- */
  {
    const withLint = withFile.filter((a) => a.lint);
    report.facts.shippedLint = {
      value: withLint.length ? `${withLint.length} scoped artifact(s) ship a lint.jar` : "no scoped artifact ships a lint.jar",
      perArtifact: withLint.map((a) => ({
        coordinate: a.coordinate,
        entry: `${a.file}!${a.lint.entry}`,
        bytes: a.lint.bytes,
        classCount: a.lint.classCount,
        bytecodeMajors: Object.fromEntries(Object.entries(a.lint.majors).map(([m, n]) => [`major ${m} (Java ${JAVA_BY_MAJOR[m] || "?"})`, n])),
        registryAttribute: a.lint.registryAttribute || "UNKNOWN (no Lint-Registry attribute in the jar's META-INF/MANIFEST.MF)",
        registryClasses: a.lint.registryClasses.length ? a.lint.registryClasses : "UNKNOWN",
        detectors: a.lint.detectors,
        detectorEvidence: a.lint.detectorEvidence,
      })),
      neverRun: "presence in the AAR is not a lint run — verify with `./gradlew :app:lintDebug`",
    };
  }

  emit(report, opts);
  if (report.resolution.incomplete) process.exit(2);
}

/* ---------------------------------------------------------------- output */

function emit(report, opts) {
  const json = JSON.stringify(report, null, 2);
  if (opts.out) { fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true }); fs.writeFileSync(opts.out, json); }
  if (opts.json) { process.stdout.write(json + "\n"); return; }
  process.stdout.write(human(report) + "\n");
  if (opts.out) process.stdout.write(`\nJSON written to ${path.resolve(opts.out)}\n`);
}

function human(r) {
  const L = [];
  const hr = (t) => L.push("", "=".repeat(78), t, "=".repeat(78));
  const sec = (t) => L.push("", `-- ${t} ${"-".repeat(Math.max(0, 74 - t.length))}`);
  const kv = (k, v) => L.push(`  ${k.padEnd(28)} ${v}`);

  hr("PICO Spatial SDK — artifact-level facts");
  kv("generated", r.generatedAt);
  kv("host", `${r.host.platform}/${r.host.arch} node ${r.host.node}`);
  kv("project", r.inputs.project);
  kv("  selected by", r.inputs.projectSelection);
  kv("  spatial marker", r.inputs.spatialMarkerFile || "UNKNOWN");
  kv("module/configuration", `${r.inputs.module} / ${r.inputs.configuration}`);
  kv("artifact scope", `${r.inputs.groupPrefix}*`);
  kv("BOM override", r.inputs.bomOverride || "(none — project's own pin)");
  kv("gradle user home", r.inputs.gradleUserHome);
  kv("JAVA_HOME", `${r.inputs.javaHome}   [${r.inputs.javaHomeSource}]`);
  kv("ANDROID_HOME", `${r.inputs.androidHome}   [${r.inputs.androidHomeSource}]`);
  for (const n of r.notes) L.push(`  ! ${n}`);

  sec("DEPENDENCY GRAPH");
  kv("source", r.resolution.source);
  for (const a of r.resolution.attempts || []) L.push(`    attempt: ${a.cmd || a.note}${a.cmd ? ` -> exit ${a.exit}${a.timedOut ? " (TIMED OUT)" : ""}` : ""}`);
  if (r.resolution.error) { L.push(`  ERROR: ${r.resolution.error}`); return L.join("\n"); }
  kv("tree nodes parsed", r.resolution.nodesParsed);
  if (r.resolution.incomplete) {
    L.push("  !! GRAPH INCOMPLETE — Gradle marked these FAILED (`:dependencies` reports failures inline and still exits 0):");
    for (const c of r.resolution.failedScopedCoordinates) L.push(`       ${c}`);
    L.push(`     ${r.resolution.failedCoordinates.length} coordinate(s) failed in total. Facts below cover only what DID resolve.`);
  }
  kv("scoped artifacts", r.resolution.scopedArtifacts.length);
  for (const c of r.resolution.scopedArtifacts) L.push(`    ${c}`);
  const bom = r.facts.bom;
  kv("BOM", bom.value);
  if (Array.isArray(bom.managedModules)) for (const m of bom.managedModules) L.push(`    manages ${m}`);
  const metaOnly = (r.artifacts || []).filter((a) => !a.file && a.metadataOnly);
  const missing = (r.artifacts || []).filter((a) => !a.file && !a.metadataOnly);
  kv("inspected (have a file)", (r.artifacts || []).filter((a) => a.file).length);
  if (metaOnly.length) { L.push("  metadata-only modules (resolved, no artifact to inspect — expected for BOMs and variant redirects):"); for (const m of metaOnly) L.push(`    ${m.coordinate}`); }
  if (missing.length) { L.push("  ! artifacts NOT found in the Gradle cache (facts below exclude them):"); for (const m of missing) L.push(`    ${m.coordinate} — ${m.unresolvedReason}`); }
  const errs = (r.artifacts || []).filter((a) => a.errors && a.errors.length);
  if (errs.length) { L.push("  ! read errors:"); for (const e of errs) L.push(`    ${e.coordinate}: ${e.errors.join("; ")}`); }

  sec("1. minSdk FLOOR");
  const f1 = r.facts.minSdkFloor;
  kv("VALUE", f1.value);
  L.push(`  ${f1.meaning}`);
  for (const p of f1.perArtifact) L.push(`    minSdkVersion=${String(p.minSdkVersion).padEnd(6)} package=${(p.manifestPackage || "").padEnd(30)} ${p.coordinate}`);
  L.push(`  evidence: uses-sdk/@android:minSdkVersion in each artifact's AndroidManifest.xml (read from inside the AAR)`);

  sec("2. compileSdk FLOOR");
  const f2 = r.facts.compileSdkFloor;
  kv("VALUE", f2.value);
  kv("distinct values", f2.distinct.join(", "));
  L.push(`  ${f2.meaning}`);
  for (const p of f2.perArtifact) L.push(`    minCompileSdk=${String(p.minCompileSdk).padEnd(8)} ${p.coordinate}`);
  L.push(`  evidence: META-INF/com/android/build/gradle/aar-metadata.properties in each AAR`);

  sec("3. AGP FLOOR");
  const f3 = r.facts.agpFloor;
  kv("VALUE", f3.value);
  kv("distinct values", f3.distinct.join(", "));
  L.push(`  ${f3.meaning}`);
  for (const p of f3.perArtifact) L.push(`    minAndroidGradlePluginVersion=${String(p.minAndroidGradlePluginVersion).padEnd(8)} ${p.coordinate}`);
  L.push(`  evidence: same aar-metadata.properties file`);
  kv("coreLibraryDesugaring", r.facts.coreLibraryDesugaring.value);

  sec("4. JAVA BYTECODE LEVEL (full census)");
  const f4 = r.facts.javaBytecode;
  kv("VALUE (app runtime)", f4.value);
  kv("total classes", f4.totalClasses);
  for (const p of f4.perArtifact) L.push(`    ${String(p.classes).padStart(5)} classes  ${JSON.stringify(p.majors)}  ${p.coordinate}`);
  L.push(`  evidence: bytes 6-7 (major_version) of EVERY .class entry inside each classes.jar — not a sample`);
  if (Array.isArray(f4.buildTimeJars)) {
    L.push(`  build-time jars shipped inside AARs (run on the Gradle JVM, not the device):`);
    for (const b of f4.buildTimeJars) L.push(`    ${String(b.classes).padStart(5)} classes  ${JSON.stringify(b.majors)}  ${b.coordinate}!${b.entry}`);
  } else L.push(`  build-time jars: ${f4.buildTimeJars}`);

  sec("5. NATIVE CODE");
  const f5 = r.facts.nativeCode;
  kv("VALUE", f5.value);
  for (const p of f5.perArtifact) if (p.soEntries.length) for (const s of p.soEntries) L.push(`    ${p.coordinate}: ${s.path} (${s.bytes} bytes)`);
  L.push(`  evidence: zip central directory of each artifact — every entry ending .so`);
  const mnl = f5.appMergedNativeLibs;
  if (mnl.dir) {
    kv("app merged_native_libs", mnl.dir);
    kv("  ABIs present", mnl.abis.join(", ") || "(none)");
    for (const l of mnl.libs) L.push(`    ${l.path} (${l.bytes} bytes)`);
  } else kv("app merged_native_libs", `${mnl.value} — ${mnl.reason}`);

  sec("6. ARTIFACT -> PACKAGE MAP");
  for (const p of r.facts.packageMap.perArtifact) {
    L.push(`  ${p.coordinate}  (${p.totalClasses} classes)`);
    const sp = Object.entries(p.scopedPackages);
    if (!sp.length) L.push(`      (ships no ${r.inputs.groupPrefix}.* package)`);
    for (const [pkg, n] of sp) L.push(`      ${String(n).padStart(5)}  ${pkg}`);
    const op = Object.entries(p.otherPackageRoots);
    if (op.length) L.push(`      other package roots: ${op.map(([k, v]) => `${k} (${v})`).join(", ")}`);
  }
  const split = Object.entries(r.facts.packageMap.splitPackages || {});
  if (split.length) { L.push(`  SPLIT PACKAGES (shipped by >1 artifact):`); for (const [p, o] of split) L.push(`      ${p}  <-  ${o.join(", ")}`); }
  L.push(`  evidence: entry paths of every .class inside each classes.jar`);

  sec("7. COMPOSE FORK (fork-vs-stock discriminator)");
  const f7 = r.facts.composeFork;
  kv("VALUE", f7.value);
  L.push(`  discriminator: ${f7.discriminator}`);
  kv("fork served from", (f7.forkHosts || []).join(", ") || "UNKNOWN");
  kv("stock served from", (f7.stockHosts || []).join(", ") || "UNKNOWN");
  for (const t of f7.reliableTells || []) L.push(`    reliable tell   : ${t}`);
  for (const t of f7.unreliableTells || []) L.push(`    ! CAVEAT        : ${t}`);
  for (const f of f7.forkArtifacts) {
    L.push(`  ${f.coordinate}`);
    L.push(`      manifest package : ${f.manifestPackage}`);
    L.push(`      downloaded from  : ${f.downloadedFrom}`);
    L.push(`      AAR entry stamps : ${f.entryTimestampRange ? `${f.entryTimestampRange.min} .. ${f.entryTimestampRange.max}` : "UNKNOWN"}${f.timestampsNormalized ? "   (NORMALIZED — same as a stock build)" : ""}`);
    L.push(`      LICENSE entries  : ${f.licenseEntries.map((l) => l.path).join(", ") || "(none)"}`);
    L.push(`      added vendor LIC : ${f.addedVendorLicenseEntries.join(", ") || "(none)"}`);
    const up = f.declaresUpstream;
    L.push(`      declares upstream: ${up.length ? up.map((d) => `${d.coordinate}:${d.declared}${d.resolved !== d.declared ? ` -> ${d.resolved}` : ""}`).join(", ") : "UNKNOWN"}`);
  }
  if (f7.stockSameNamespaceArtifacts?.length) {
    L.push(`  same-namespace artifacts published under their OWN group (i.e. NOT forked) — ${f7.stockSameNamespaceArtifacts.length} total:`);
    for (const s of f7.stockSameNamespaceArtifacts) {
      const vend = s.addedVendorLicenseEntries && s.addedVendorLicenseEntries.length ? `  !! carries a ${r.inputs.groupPrefix} LICENSE` : "";
      L.push(`      ${s.coordinate.padEnd(56)} <- ${s.downloadedFrom}${vend}`);
    }
    L.push(`      (none of the above should carry a ${r.inputs.groupPrefix} LICENSE entry; any that does is not stock)`);
  }
  L.push(`  evidence: AAR manifest package=, Gradle's resource-at-url.bin download index, AAR zip timestamps, META-INF LICENSE entries, and declared edges in the resolved graph`);

  sec("7b. REPOSITORY CHANNELS");
  const f7b = r.facts.repositoryChannels;
  kv("VALUE", f7b.value);
  L.push(`  ${f7b.meaning}`);
  kv(`URLs under ${r.inputs.groupPrefix}/`, f7b.scopedUrlCount);
  kv("all hosts in the index", Object.entries(f7b.allHosts).map(([h, n]) => `${h} (${n})`).join(", "));
  L.push(`  evidence: ${f7b.source}`);
  L.push(`  caveat: ${f7b.caveat}`);

  sec("8. MANIFEST INJECTIONS");
  const f8 = r.facts.manifestInjections;
  kv("VALUE", f8.value);
  kv("merger blame report", f8.mergerBlameReport);
  for (const p of f8.perArtifact) {
    const c = p.contributions;
    if (!Array.isArray(c) || !c.length) { L.push(`  ${p.coordinate}: manifest declares nothing but uses-sdk (no <application>)`); continue; }
    L.push(`  ${p.coordinate}:`);
    for (const x of c) L.push(`      <${x.kind}> ${x.name}${x.value !== null && x.value !== undefined ? ` = "${x.value}"` : ""}   [${x.scope}]`);
    if (Array.isArray(p.mergerBlame)) L.push(`      merger blame: ${p.mergerBlame.map((b) => `${b.action} ${b.node}`).join("; ")}`);
    else L.push(`      merger blame: ${p.mergerBlame}`);
  }
  L.push(`  evidence: each AAR's own AndroidManifest.xml, cross-checked against the project's manifest-merger report when present`);

  sec("9. SHIPPED LINT");
  const f9 = r.facts.shippedLint;
  kv("VALUE", f9.value);
  for (const p of f9.perArtifact) {
    L.push(`  ${p.entry}  (${p.bytes} bytes, ${p.classCount} classes, ${JSON.stringify(p.bytecodeMajors)})`);
    L.push(`      registry (jar manifest attribute): ${p.registryAttribute}`);
    L.push(`      registry (class super_class)     : ${Array.isArray(p.registryClasses) ? p.registryClasses.join(", ") : p.registryClasses}`);
    L.push(`      detectors (${p.detectors.length}):`);
    for (const d of p.detectors) L.push(`        ${d.className}${d.scanners.length ? `  [${d.scanners.join(", ")}]` : ""}`);
    for (const d of p.detectors) if (d.issueStrings.length) L.push(`        ${d.className.split(".").pop()} strings: ${d.issueStrings.map((s) => JSON.stringify(s)).join(", ")}`);
  }
  L.push(`  evidence: ${f9.perArtifact[0]?.detectorEvidence || "n/a"}`);
  L.push(`  caveat: ${f9.neverRun}`);

  L.push("", "Every value above names the file or command it came from. UNKNOWN means the", "source could not be read — it is never a guess.", "");
  return L.join("\n");
}

main().catch((e) => { process.stderr.write(`sdk-facts: ${e.stack || e}\n`); process.exit(1); });
