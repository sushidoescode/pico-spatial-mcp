import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { canonicalJson } from "../../benchmarks/spatial-agent-bench/lib/identity.mjs";
import {
  TEST_EXECUTION_STREAM_MAX_BYTES,
  validateSubmissionTests,
  validateTestExecutionReceipt,
} from "../../benchmarks/spatial-agent-bench/lib/contract.mjs";

const RESULT_ROOT = "app/build/test-results/testDebugUnitTest";
const MAX_RESULT_FILES = 256;
const MAX_RESULT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TEST_CASES = 100_000;
const MAX_XML_DEPTH = 32;
const MAX_XML_ATTRIBUTES = 64;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const EXECUTIONS = new WeakSet();
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const SELF_PATH = fileURLToPath(import.meta.url);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function exactDataObject(value, label, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a canonical plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw new Error(`${label} must not contain symbols`);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) throw new Error(`${label} contains unknown or missing keys`);
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error(`${label}.${key} must be an enumerable own data property`);
    copy[key] = descriptor.value;
  }
  return copy;
}

function canonicalProjectDirectory(projectDir) {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) throw new Error("projectDir must be an absolute directory");
  const before = fs.lstatSync(projectDir);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("projectDir must be a regular non-symlink directory");
  const real = fs.realpathSync(projectDir);
  if (real !== path.resolve(projectDir)) throw new Error("projectDir must be canonical and must not traverse a symlink");
  const after = fs.statSync(real);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("projectDir identity changed during validation");
  return real;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function stableRead(filePath, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const beforeLink = fs.lstatSync(filePath);
  if (beforeLink.isSymbolicLink() || !beforeLink.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if (beforeLink.size > maximumBytes) throw new Error(`${label} exceeds the byte bound`);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || !sameIdentity(beforeLink, before)) throw new Error(`${label} identity changed before read`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!sameIdentity(before, after) || bytes.byteLength !== after.size) throw new Error(`${label} identity changed during read`);
    const afterLink = fs.lstatSync(filePath);
    if (afterLink.isSymbolicLink() || !sameIdentity(after, afterLink)) throw new Error(`${label} identity changed after read`);
    return { bytes, stat: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizedResultPath(projectDir, absolutePath) {
  const relative = path.relative(projectDir, absolutePath).split(path.sep).join("/");
  if (!relative.startsWith(`${RESULT_ROOT}/`) || relative.includes("\\") || path.posix.normalize(relative) !== relative || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error("JUnit result path escapes its normalized result root");
  return relative;
}

function scanResultFiles(projectDir) {
  const root = path.join(projectDir, ...RESULT_ROOT.split("/"));
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("JUnit result root must be a regular non-symlink directory");
  if (fs.realpathSync(root) !== root) throw new Error("JUnit result root must be canonical and confined");
  const absoluteFiles = [];
  const visit = (directory, depth) => {
    if (depth > MAX_XML_DEPTH) throw new Error("JUnit result directory nesting exceeds the bound");
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (/[/\\\u0000-\u001f\u007f]/.test(entry.name)) throw new Error("JUnit result entry has an unsafe name");
      const candidate = path.join(directory, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error("JUnit result entries must not be symlinks");
      if (stat.isDirectory()) visit(candidate, depth + 1);
      else if (!stat.isFile()) throw new Error("JUnit result entries must be regular files, not special files");
      else if (entry.name.endsWith(".xml")) absoluteFiles.push(candidate);
    }
  };
  visit(root, 1);
  if (absoluteFiles.length > MAX_RESULT_FILES) throw new Error(`JUnit results exceed ${MAX_RESULT_FILES} files`);
  let totalBytes = 0;
  const files = absoluteFiles.map((absolutePath) => {
    const relative = normalizedResultPath(projectDir, absolutePath);
    const { bytes, stat } = stableRead(absolutePath, relative, MAX_RESULT_FILE_BYTES);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RESULT_TOTAL_BYTES) throw new Error("JUnit results exceed the 16 MiB total byte bound");
    return {
      path: relative,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      device: String(stat.dev),
      inode: String(stat.ino),
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      content: bytes,
    };
  });
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
}

function publicSnapshot(files) {
  const normalized = files.map(({ content: _content, ...file }) => deepFreeze(file));
  return deepFreeze({ sha256: sha256(canonicalJson(normalized)), files: normalized });
}

function validateSnapshot(snapshot) {
  const value = exactDataObject(snapshot, "JUnit snapshot", ["sha256", "files"]);
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || !Array.isArray(value.files)) throw new Error("JUnit snapshot has an invalid digest or file list");
  if (value.files.length > MAX_RESULT_FILES) throw new Error(`JUnit snapshot exceeds ${MAX_RESULT_FILES} files`);
  let totalBytes = 0;
  const files = value.files.map((file, index) => {
    const row = exactDataObject(file, `JUnit snapshot files[${index}]`, ["path", "bytes", "sha256", "device", "inode", "mtimeMs", "ctimeMs"]);
    if (typeof row.path !== "string" || !row.path.startsWith(`${RESULT_ROOT}/`) || !row.path.endsWith(".xml") || path.posix.normalize(row.path) !== row.path) throw new Error("JUnit snapshot contains an invalid XML path");
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_RESULT_FILE_BYTES) throw new Error("JUnit snapshot contains invalid bytes");
    totalBytes += row.bytes;
    if (totalBytes > MAX_RESULT_TOTAL_BYTES) throw new Error("JUnit snapshot exceeds the 16 MiB total byte bound");
    if (!/^[a-f0-9]{64}$/.test(row.sha256) || typeof row.device !== "string" || typeof row.inode !== "string" || !Number.isFinite(row.mtimeMs) || !Number.isFinite(row.ctimeMs)) throw new Error("JUnit snapshot contains invalid file identity");
    return row;
  });
  for (let index = 1; index < files.length; index += 1) if (files[index - 1].path >= files[index].path) throw new Error("JUnit snapshot paths must be sorted and unique");
  if (sha256(canonicalJson(files)) !== value.sha256) throw new Error("JUnit snapshot digest mismatch");
  return deepFreeze({ sha256: value.sha256, files: files.map((file) => deepFreeze({ ...file })) });
}

export function snapshotJUnitResults(projectDir) {
  const canonical = canonicalProjectDirectory(projectDir);
  return publicSnapshot(scanResultFiles(canonical));
}

function canonicalDirectory(candidate) {
  try {
    const real = fs.realpathSync(candidate);
    if (!fs.statSync(real).isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

function regularFile(candidate, { executable = false } = {}) {
  try {
    const link = fs.lstatSync(candidate);
    if (link.isSymbolicLink() || !link.isFile()) return false;
    if (executable && (link.mode & 0o111) === 0) return false;
    return true;
  } catch {
    return false;
  }
}

function resolveJavaHome() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push([process.env.JAVA_HOME, "$JAVA_HOME"]);
  const home = os.homedir();
  if (process.platform === "darwin") candidates.push(
    ["/Applications/Android Studio.app/Contents/jbr/Contents/Home", "Android Studio bundled JBR"],
    ["/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home", "Android Studio Preview bundled JBR"],
    [path.join(home, "Applications/Android Studio.app/Contents/jbr/Contents/Home"), "user Android Studio bundled JBR"],
  );
  else if (process.platform === "win32") candidates.push(
    ["C:\\Program Files\\Android\\Android Studio\\jbr", "Android Studio bundled JBR"],
    [path.join(process.env.LOCALAPPDATA || "", "Programs", "Android Studio", "jbr"), "user Android Studio bundled JBR"],
  );
  else candidates.push(["/opt/android-studio/jbr", "Android Studio bundled JBR"], [path.join(home, "android-studio/jbr"), "user Android Studio bundled JBR"]);
  for (const [candidate, source] of candidates) {
    const real = canonicalDirectory(candidate);
    const java = real && path.join(real, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (real && regularFile(java, { executable: true })) return { realpath: real, source };
  }
  throw new Error("trusted JDK could not be resolved from JAVA_HOME or platform Android Studio defaults");
}

function resolveAndroidSdk() {
  const candidates = [];
  if (process.env.ANDROID_HOME) candidates.push([process.env.ANDROID_HOME, "$ANDROID_HOME"]);
  if (process.env.ANDROID_SDK_ROOT) candidates.push([process.env.ANDROID_SDK_ROOT, "$ANDROID_SDK_ROOT"]);
  const home = os.homedir();
  const platformDefault = process.platform === "darwin"
    ? path.join(home, "Library/Android/sdk")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk")
      : path.join(home, "Android/Sdk");
  candidates.push([platformDefault, "platform Android SDK default"]);
  for (const [candidate, source] of candidates) {
    const real = canonicalDirectory(candidate);
    if (!real) continue;
    const androidJar = path.join(real, "platforms", "android-35", "android.jar");
    const aapt2 = path.join(real, "build-tools", "35.0.0", process.platform === "win32" ? "aapt2.exe" : "aapt2");
    if (regularFile(androidJar) && regularFile(aapt2, { executable: true })) return { realpath: real, source };
  }
  throw new Error("trusted compile-35 Android SDK could not be resolved from ANDROID_HOME, ANDROID_SDK_ROOT, or the platform default");
}

function validateRunner(executable, expectedSha256) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) throw new Error("Gradle executable must be absolute");
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("expected Gradle hash must be lowercase SHA-256");
  const resolved = fs.realpathSync(executable);
  if (resolved !== path.resolve(executable)) throw new Error("Gradle executable must be canonical and not a symlink");
  const link = fs.lstatSync(resolved);
  if (link.isSymbolicLink() || !link.isFile() || (link.mode & 0o111) === 0) throw new Error("Gradle executable must be an executable regular non-symlink file");
  if (typeof process.getuid === "function" && link.uid !== process.getuid()) throw new Error("Gradle executable must be runner-owned");
  const { bytes } = stableRead(resolved, "Gradle executable");
  const digest = sha256(bytes);
  if (digest !== expectedSha256) throw new Error("Gradle executable hash mismatch");
  return { realpath: resolved, sha256: digest };
}

function killProcessGroup(child) {
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already settled */ }
  }
}

function runBounded(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, shell: false, detached: process.platform !== "win32", windowsHide: true });
    const output = { stdout: [], stderr: [] };
    const lengths = { stdout: 0, stderr: 0 };
    let overflow = null;
    let spawnError = null;
    let streamError = null;
    const consume = (stream) => (chunk) => {
      if (overflow) return;
      const bytes = Buffer.from(chunk);
      if (lengths[stream] + bytes.byteLength > TEST_EXECUTION_STREAM_MAX_BYTES) {
        overflow = stream;
        killProcessGroup(child);
        return;
      }
      lengths[stream] += bytes.byteLength;
      output[stream].push(bytes);
    };
    child.stdout.on("data", consume("stdout"));
    child.stderr.on("data", consume("stderr"));
    const failStream = (stream) => (error) => {
      if (!streamError) streamError = new Error(`trusted Gradle ${stream} stream failed: ${error.message}`, { cause: error });
      killProcessGroup(child);
    };
    child.stdout.on("error", failStream("stdout"));
    child.stderr.on("error", failStream("stderr"));
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, signal) => {
      if (overflow) {
        reject(new Error(`trusted Gradle ${overflow} exceeds ${TEST_EXECUTION_STREAM_MAX_BYTES} bytes`));
        return;
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (streamError) {
        reject(streamError);
        return;
      }
      if (!Number.isSafeInteger(code)) {
        reject(new Error(`trusted Gradle ended without a numeric exit code${signal ? ` (${signal})` : ""}`));
        return;
      }
      resolve({ exitCode: code, stdout: Buffer.concat(output.stdout, lengths.stdout), stderr: Buffer.concat(output.stderr, lengths.stderr) });
    });
  });
}

export async function runTrustedJUnitExecution(input) {
  const value = exactDataObject(input, "trusted JUnit execution input", ["projectDir", "gradleExecutable", "expectedGradleSha256"]);
  const projectDir = canonicalProjectDirectory(value.projectDir);
  const runner = validateRunner(value.gradleExecutable, value.expectedGradleSha256);
  const jdk = resolveJavaHome();
  const android = resolveAndroidSdk();
  const args = ["--offline", "--no-daemon", "--no-configuration-cache", "--console=plain", ":app:testDebugUnitTest"];
  const childEnvironment = {
    ...process.env,
    JAVA_HOME: jdk.realpath,
    ANDROID_SDK_ROOT: android.realpath,
    ANDROID_HOME: android.realpath,
  };
  const completed = await runBounded(runner.realpath, args, { cwd: projectDir, env: childEnvironment });
  const stdout = new Uint8Array(completed.stdout);
  const stderr = new Uint8Array(completed.stderr);
  const receiptWithoutHash = {
    version: 1,
    launcherSha256: sha256(stableRead(SELF_PATH, "trusted JUnit launcher").bytes),
    gradleExecutableSha256: runner.sha256,
    command: ["$PINNED_GRADLE/bin/gradle", ...args],
    workingDirectory: "submission",
    exitCode: completed.exitCode,
    stdoutBytes: stdout.byteLength,
    stdoutSha256: sha256(stdout),
    stderrBytes: stderr.byteLength,
    stderrSha256: sha256(stderr),
  };
  const receipt = validateTestExecutionReceipt({ ...receiptWithoutHash, receiptSha256: sha256(canonicalJson(receiptWithoutHash)) });
  const execution = Object.freeze({ receipt, stdout, stderr });
  EXECUTIONS.add(execution);
  return execution;
}

function parseAttributes(source, label) {
  const attributes = {};
  let rest = source;
  while (rest.trim().length > 0) {
    const match = /^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')/.exec(rest);
    if (!match) throw new Error(`JUnit XML ${label} has malformed attributes`);
    if (Object.hasOwn(attributes, match[1])) throw new Error(`JUnit XML ${label} has duplicate attributes`);
    attributes[match[1]] = match[2].slice(1, -1);
    rest = rest.slice(match[0].length);
  }
  if (Object.keys(attributes).length > MAX_XML_ATTRIBUTES) throw new Error(`JUnit XML ${label} exceeds ${MAX_XML_ATTRIBUTES} attributes`);
  for (const [name, value] of Object.entries(attributes)) {
    const localName = name.split(":").at(-1);
    if (/^xmlns(?::|$)/i.test(name)
      || /^(?:href|src|schemaLocation|noNamespaceSchemaLocation)$/i.test(localName)
      || /^(?:https?|file):/i.test(value)) throw new Error("JUnit XML external/schema/include resolution is forbidden");
  }
  return attributes;
}

function parseXmlDocument(bytes, label) {
  let source;
  try { source = UTF8.decode(bytes); } catch { throw new Error(`JUnit XML ${label} is not fatal UTF-8`); }
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("JUnit XML DOCTYPE/entity declarations are forbidden");
  if (/<!\[CDATA\[/i.test(source)) throw new Error("JUnit XML CDATA is forbidden");
  if (/&(?:#\d+|#x[0-9a-f]+|[A-Za-z_:][A-Za-z0-9_.:-]*);/i.test(source)) throw new Error("JUnit XML entity references are forbidden");
  let cursor = 0;
  if (source.startsWith("<?xml")) {
    const end = source.indexOf("?>");
    if (end < 0) throw new Error("JUnit XML declaration is malformed");
    cursor = end + 2;
  }
  if (source.slice(cursor).includes("<?")) throw new Error("JUnit XML processing instructions are forbidden");
  if (source.includes("<!--") || source.includes("<!")) throw new Error("JUnit XML unsupported declarations are forbidden");
  const stack = [];
  let root = null;
  while (cursor < source.length) {
    const next = source.indexOf("<", cursor);
    if (next < 0) {
      if (source.slice(cursor).trim() !== "") throw new Error("JUnit XML has text outside its root");
      break;
    }
    const text = source.slice(cursor, next);
    if (stack.length === 0 && text.trim() !== "") throw new Error("JUnit XML has text outside its root");
    if (/[&<>]/.test(text)) throw new Error("JUnit XML text contains forbidden markup or entity syntax");
    const end = source.indexOf(">", next + 1);
    if (end < 0) throw new Error("JUnit XML has an unterminated tag");
    const token = source.slice(next, end + 1);
    cursor = end + 1;
    if (/^<\//.test(token)) {
      const close = /^<\/\s*([A-Za-z_:][A-Za-z0-9_.:-]*)\s*>$/.exec(token);
      if (!close || stack.length === 0 || stack.at(-1).name !== close[1]) throw new Error("JUnit XML closing tags are inconsistent");
      stack.pop();
      continue;
    }
    const open = /^<\s*([A-Za-z_:][A-Za-z0-9_.:-]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!open) throw new Error("JUnit XML opening tag is malformed");
    const node = { name: open[1], attributes: parseAttributes(open[2], open[1]), children: [] };
    if (/^(?:xi:include|xinclude|stylesheet|schema)$/i.test(node.name)) throw new Error("JUnit XML external/include/stylesheet/schema elements are forbidden");
    if (stack.length === 0) {
      if (root) throw new Error("JUnit XML must contain exactly one root");
      root = node;
    } else stack.at(-1).children.push(node);
    if (open[3] !== "/") {
      stack.push(node);
      if (stack.length > MAX_XML_DEPTH) throw new Error(`JUnit XML depth exceeds ${MAX_XML_DEPTH}`);
    }
  }
  if (stack.length !== 0 || !root) throw new Error("JUnit XML must contain one closed root");
  if (root.name !== "testsuite" && root.name !== "testsuites") throw new Error("JUnit XML root must be testsuite or testsuites");
  return root;
}

function countAttribute(attributes, key, label, { optional = false } = {}) {
  if (!Object.hasOwn(attributes, key)) {
    if (optional) return null;
    throw new Error(`JUnit XML ${label} is missing ${key}`);
  }
  if (!/^(?:0|[1-9]\d*)$/.test(attributes[key])) throw new Error(`JUnit XML ${label}.${key} must be a non-negative integer`);
  const value = Number(attributes[key]);
  if (!Number.isSafeInteger(value)) throw new Error(`JUnit XML ${label}.${key} exceeds safe integer range`);
  return value;
}

function addCounts(left, right) {
  return {
    tests: left.tests + right.tests,
    failures: left.failures + right.failures,
    errors: left.errors + right.errors,
    skipped: left.skipped + right.skipped,
  };
}

function testcaseCounts(node) {
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  for (const child of node.children) {
    if (child.name === "failure") failures += 1;
    else if (child.name === "error") errors += 1;
    else if (child.name === "skipped") skipped += 1;
    else if (child.name !== "properties" && child.name !== "property") throw new Error(`JUnit XML testcase contains unsupported ${child.name}`);
  }
  if (failures > 1 || errors > 1 || skipped > 1 || failures + errors + skipped > 1) throw new Error("JUnit XML testcase has contradictory outcomes");
  return { tests: 1, failures, errors, skipped };
}

function suiteCounts(node) {
  if (node.name === "testcase") return testcaseCounts(node);
  if (node.name !== "testsuite" && node.name !== "testsuites") {
    if (node.name === "properties" || node.name === "property") return { tests: 0, failures: 0, errors: 0, skipped: 0 };
    throw new Error(`JUnit XML contains unsupported ${node.name}`);
  }
  let actual = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const child of node.children) actual = addCounts(actual, suiteCounts(child));
  const values = ["tests", "failures", "errors", "skipped"].map((key) => countAttribute(node.attributes, key, node.name, { optional: node.name === "testsuites" }));
  const anyAggregate = values.some((value) => value !== null);
  if (anyAggregate && values.some((value) => value === null)) throw new Error("JUnit XML aggregate count fields must be complete");
  if (anyAggregate) {
    const expected = Object.fromEntries(["tests", "failures", "errors", "skipped"].map((key, index) => [key, values[index]]));
    if (canonicalJson(expected) !== canonicalJson(actual)) throw new Error("JUnit XML aggregate/testcase count equation mismatch");
  }
  return actual;
}

function exactFreshTuple(file) {
  return [file.bytes, file.sha256, file.device, file.inode, file.mtimeMs, file.ctimeMs];
}

function outputFacts(execution) {
  let stdout;
  let stderr;
  try {
    stdout = UTF8.decode(execution.stdout);
    stderr = UTF8.decode(execution.stderr);
  } catch {
    throw new Error("trusted Gradle output is not fatal UTF-8");
  }
  const combined = `${stdout}\n${stderr}`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(combined)) throw new Error("trusted Gradle output contains control/ANSI spoofing bytes");
  const lines = combined.split(/\r?\n/);
  const exact = lines.filter((line) => line === "> Task :app:testDebugUnitTest NO-SOURCE");
  const targetOutcomes = lines.filter((line) => /^> Task :app:testDebugUnitTest(?:\s+\S.*)?$/.test(line));
  const anyTestNoSource = lines.some((line) => /testDebugUnitTest NO-SOURCE/.test(line));
  if (targetOutcomes.length > 1) throw new Error("trusted Gradle target outcome is duplicated or contradictory");
  if (anyTestNoSource && (exact.length !== 1 || targetOutcomes.length !== 1)) throw new Error("trusted Gradle NO-SOURCE outcome is spoofed or contradictory");
  return { exactNoSource: exact.length === 1 };
}

export function parseFreshJUnitResults(input) {
  const value = exactDataObject(input, "fresh JUnit parser input", ["projectDir", "before", "execution"]);
  const projectDir = canonicalProjectDirectory(value.projectDir);
  const before = validateSnapshot(value.before);
  const execution = value.execution;
  if (!EXECUTIONS.has(execution)) throw new Error("fresh JUnit parser requires an in-process branded trusted execution");
  const receipt = validateTestExecutionReceipt(execution.receipt);
  if (!(execution.stdout instanceof Uint8Array) || !(execution.stderr instanceof Uint8Array)) throw new Error("trusted execution streams must be Uint8Array values");
  if (execution.stdout.byteLength !== receipt.stdoutBytes || sha256(execution.stdout) !== receipt.stdoutSha256) throw new Error("trusted execution stdout bytes/hash mismatch");
  if (execution.stderr.byteLength !== receipt.stderrBytes || sha256(execution.stderr) !== receipt.stderrSha256) throw new Error("trusted execution stderr bytes/hash mismatch");
  const outcome = outputFacts(execution);
  const current = scanResultFiles(projectDir);
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const fresh = current.filter((file) => {
    const previous = beforeByPath.get(file.path);
    return !previous || canonicalJson(exactFreshTuple(file)) !== canonicalJson(exactFreshTuple(previous));
  });
  if (current.length > 0 && fresh.length === 0) throw new Error("JUnit result XML is stale; no fresh result exists");
  let counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const file of fresh) counts = addCounts(counts, suiteCounts(parseXmlDocument(file.content, file.path)));
  if (counts.tests > MAX_TEST_CASES) throw new Error(`JUnit XML exceeds ${MAX_TEST_CASES} test cases`);
  if (counts.tests !== counts.failures + counts.errors + counts.skipped + (counts.tests - counts.failures - counts.errors - counts.skipped) || counts.failures + counts.errors + counts.skipped > counts.tests) throw new Error("JUnit XML count equation is inconsistent");
  let status;
  if (fresh.length > 0) {
    if (outcome.exactNoSource) throw new Error("NO-SOURCE contradicts fresh JUnit XML");
    if (counts.tests === 0) throw new Error("fresh JUnit XML must contain a nonzero test count");
    if (counts.failures + counts.errors + counts.skipped > 0) status = "fail";
    else if (receipt.exitCode === 0) status = "pass";
    else throw new Error("fresh all-pass JUnit XML contradicts a nonzero Gradle exit");
  } else if (receipt.exitCode !== 0) {
    if (outcome.exactNoSource) throw new Error("NO-SOURCE contradicts a nonzero Gradle exit");
    status = "execution_failed";
  } else if (outcome.exactNoSource) status = "no_source";
  else throw new Error("zero-exit Gradle execution has neither fresh JUnit XML nor exact NO-SOURCE");

  const passed = counts.tests - counts.failures - counts.errors - counts.skipped;
  const recordWithoutHash = {
    evidenceClass: "submission_test",
    status,
    testCount: counts.tests,
    passedCount: passed,
    failureCount: counts.failures,
    errorCount: counts.errors,
    skippedCount: counts.skipped,
    preBuildResultsSha256: before.sha256,
    resultFiles: fresh.map(({ path: resultPath, bytes, sha256: digest }) => ({ path: resultPath, bytes, sha256: digest })),
    testExecutionReceiptSha256: receipt.receiptSha256,
  };
  const record = { ...recordWithoutHash, receiptSha256: sha256(canonicalJson(recordWithoutHash)) };
  return validateSubmissionTests(record, "pass");
}
