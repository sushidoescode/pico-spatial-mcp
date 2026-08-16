import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
const PINNED_NODE = Object.freeze({ path: "/usr/local/bin/node", version: "v22.14.0", bytes: 220_243_216, sha256: "c583851fc85e4618b2374cda13399d59d373ad7cebfc4b55160820b88dcce67b" });
const ORCHESTRATOR_ENV = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC", __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0" });
guardOrchestrator();
const ANALYZER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(ANALYZER_ROOT, "../../..");
const ARTIFACTS_ROOT = path.join(ANALYZER_ROOT, ".artifacts");
const PUBLISHED_ROOT = path.join(ARTIFACTS_ROOT, "v1");
const BRIDGE = path.join(ANALYZER_ROOT, "../lib/kotlin-analysis.mjs");
const SOURCE_PATHS = ["Main.java", "Protocol.java", "PsiIndex.java"]
  .map((name) => path.join(ANALYZER_ROOT, "src/main/java/com/agentbench/analyzer", name));
const CONFIG_PATHS = ["domain-v1.json", "dependencies-v1.json", "toolchain-v1.json"]
  .map((name) => path.join(ANALYZER_ROOT, name));
const RECEIPT_NAME = "analyzer-build-receipt-v1.json";
const HASH = /^[a-f0-9]{64}$/;
const RECEIPT_DOMAIN = Buffer.from("agentbench-analyzer-receipt-v1\0", "utf8");
const EXPECTED_JAR_ENTRIES = Object.freeze(["com/agentbench/analyzer/Main.class", "com/agentbench/analyzer/Protocol$Parser.class", "com/agentbench/analyzer/Protocol.class", "com/agentbench/analyzer/PsiIndex$Result.class", "com/agentbench/analyzer/PsiIndex$Source.class", "com/agentbench/analyzer/PsiIndex.class", "domain-v1.json"]);
const ALLOWED_CLASS_REFERENCES = new Set([
  "[B", "[Ljava/lang/String;", "[Lorg/jetbrains/kotlin/com/intellij/psi/PsiElement;", "com/agentbench/analyzer/Main", "com/agentbench/analyzer/Protocol", "com/agentbench/analyzer/Protocol$Parser", "com/agentbench/analyzer/PsiIndex", "com/agentbench/analyzer/PsiIndex$Result", "com/agentbench/analyzer/PsiIndex$Source",
  "java/io/IOException", "java/io/InputStream", "java/io/OutputStream", "java/io/PrintStream", "java/lang/Boolean", "java/lang/Byte", "java/lang/Character", "java/lang/Class", "java/lang/IllegalArgumentException", "java/lang/IllegalStateException", "java/lang/Integer", "java/lang/Long", "java/lang/Math", "java/lang/Number", "java/lang/NumberFormatException", "java/lang/Object", "java/lang/Record", "java/lang/Short", "java/lang/String", "java/lang/StringBuilder", "java/lang/System", "java/lang/Throwable", "java/lang/invoke/LambdaMetafactory", "java/lang/invoke/MethodHandles", "java/lang/invoke/MethodHandles$Lookup", "java/lang/invoke/StringConcatFactory", "java/lang/runtime/ObjectMethods", "java/nio/ByteBuffer", "java/nio/CharBuffer", "java/nio/charset/CharacterCodingException", "java/nio/charset/Charset", "java/nio/charset/CharsetDecoder", "java/nio/charset/CodingErrorAction", "java/nio/charset/StandardCharsets", "java/security/MessageDigest", "java/security/NoSuchAlgorithmException", "java/util/ArrayDeque", "java/util/ArrayList", "java/util/Base64", "java/util/Base64$Decoder", "java/util/Base64$Encoder", "java/util/Comparator", "java/util/HashMap", "java/util/HexFormat", "java/util/Iterator", "java/util/LinkedHashMap", "java/util/List", "java/util/Map", "java/util/Set", "java/util/regex/Matcher", "java/util/regex/Pattern",
  "org/jetbrains/kotlin/cli/common/CLIConfigurationKeys", "org/jetbrains/kotlin/cli/common/messages/MessageCollector", "org/jetbrains/kotlin/cli/common/messages/MessageCollector$Companion", "org/jetbrains/kotlin/cli/jvm/compiler/EnvironmentConfigFiles", "org/jetbrains/kotlin/cli/jvm/compiler/KotlinCoreEnvironment", "org/jetbrains/kotlin/com/intellij/openapi/Disposable", "org/jetbrains/kotlin/com/intellij/openapi/util/Disposer", "org/jetbrains/kotlin/com/intellij/psi/PsiElement", "org/jetbrains/kotlin/com/intellij/psi/util/PsiTreeUtil", "org/jetbrains/kotlin/config/CommonConfigurationKeys", "org/jetbrains/kotlin/config/CompilerConfiguration", "org/jetbrains/kotlin/name/FqName", "org/jetbrains/kotlin/name/Name", "org/jetbrains/kotlin/psi/KtCallExpression", "org/jetbrains/kotlin/psi/KtFile", "org/jetbrains/kotlin/psi/KtImportDirective", "org/jetbrains/kotlin/psi/KtNamedDeclaration", "org/jetbrains/kotlin/psi/KtPsiFactory", "org/jetbrains/kotlin/resolve/ImportPath",
]);
function fail(message) { throw new Error(`analyzer build rejected: ${message}`); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("receipt contains a non-canonical number");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("receipt contains unsupported data");
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function receiptDigest(value) { return sha256(Buffer.concat([RECEIPT_DOMAIN, Buffer.from(canonicalJson(value), "utf8")])); }
function sameStat(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function stableFile(file, label = file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(file) !== file) fail(`${label} is not a canonical regular file`);
  const bytes = fs.readFileSync(file); const after = fs.lstatSync(file);
  if (!sameStat(before, after) || bytes.length !== before.size) fail(`${label} changed while read`);
  return Object.freeze({ bytes, size: bytes.length, sha256: sha256(bytes) });
}
function guardOrchestrator() {
  const keys = Object.keys(process.env).sort(compare);
  const expectedKeys = Object.keys(ORCHESTRATOR_ENV).sort(compare);
  if (canonicalJson(keys) !== canonicalJson(expectedKeys)) fail("orchestrator environment names do not match the four-name allowlist");
  for (const key of expectedKeys) if (process.env[key] !== ORCHESTRATOR_ENV[key]) fail(`orchestrator environment ${key} mismatch`);
  if (process.execArgv.length !== 0 || Object.hasOwn(process.env, "NODE_OPTIONS") || Object.hasOwn(process.env, "NODE_PATH")) {
    fail("Node preload or exec options are forbidden");
  }
  if (process.execPath !== PINNED_NODE.path || fs.realpathSync(process.execPath) !== PINNED_NODE.path || process.version !== PINNED_NODE.version) {
    fail("Node executable identity mismatch");
  }
  const node = stableFile(PINNED_NODE.path, "pinned Node");
  if (node.size !== PINNED_NODE.bytes || node.sha256 !== PINNED_NODE.sha256) fail("Node bytes mismatch");
}
function loadJson(file) {
  const material = stableFile(file); try { return { value: JSON.parse(material.bytes.toString("utf8")), material }; } catch { fail(`${path.basename(file)} is not valid JSON`); }
}
function ensureAbsoluteOverride(value, label) {
  if (!path.isAbsolute(value)) fail(`${label} must be absolute`);
  const resolved = path.resolve(value);
  if (resolved !== value) fail(`${label} must be normalized`);
  return value;
}
function parseArguments() {
  const command = process.argv[2];
  if (!new Set(["build", "verify", "clean-build-twice"]).has(command)) fail("expected build, verify, or clean-build-twice");
  const options = {};
  for (let index = 3; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (!value || !new Set(["--dependency-root", "--jdk-root"]).has(flag) || Object.hasOwn(options, flag)) fail("unknown or incomplete option");
    options[flag] = ensureAbsoluteOverride(value, flag);
  }
  return { command, dependencyRoot: options["--dependency-root"], jdkRoot: options["--jdk-root"] };
}
function mode(stat) { return (stat.mode & 0o777).toString(8).padStart(4, "0"); }
function treeIdentity(root) {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) fail("JDK root is not canonical");
  const entries = [];
  const counts = { entries: 0, files: 0, directories: 0, symlinks: 0, fileBytes: 0 };
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort(compare)) {
      const absolute = path.join(directory, name);
      const itemPath = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        const logical = path.resolve(path.dirname(absolute), target);
        const resolved = fs.realpathSync(absolute);
        if (!(logical === root || logical.startsWith(`${root}${path.sep}`)) || !(resolved === root || resolved.startsWith(`${root}${path.sep}`))) fail(`JDK symlink escapes its root: ${itemPath}`);
        entries.push({ path: itemPath, type: "symlink", mode: mode(stat), target });
        counts.symlinks += 1;
      } else if (stat.isDirectory()) {
        entries.push({ path: itemPath, type: "dir", mode: mode(stat) });
        counts.directories += 1;
        visit(absolute, itemPath);
      } else if (stat.isFile()) {
        const file = stableFile(absolute, `JDK ${itemPath}`);
        entries.push({ path: itemPath, type: "file", mode: mode(stat), bytes: file.size, sha256: file.sha256 });
        counts.files += 1;
        counts.fileBytes += file.size;
      } else fail(`JDK contains special file ${itemPath}`);
    }
  }
  visit(root);
  counts.entries = entries.length;
  return Object.freeze({ ...counts, sha256: sha256(canonicalJson(entries)) });
}
function assertIdentity(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) if (actual[key] !== value) fail(`${label} ${key} mismatch`);
}
function assertFileIdentity(actual, expected, label) {
  if (actual.size !== expected.bytes || actual.sha256 !== expected.sha256) fail(`${label} bytes or sha256 mismatch`);
}
function platformMaterial(arguments_) {
  const toolchain = loadJson(CONFIG_PATHS[2]);
  const dependencies = loadJson(CONFIG_PATHS[1]);
  const domain = loadJson(CONFIG_PATHS[0]);
  if (toolchain.value.schemaVersion !== 1 || dependencies.value.schemaVersion !== 1 || domain.value.domainVersion !== 1) fail("manifest version mismatch");
  const row = toolchain.value.platforms.find((entry) => entry.platform === process.platform && entry.arch === process.arch && entry.uid === process.getuid());
  if (!row) fail("no reviewed toolchain row for this platform/architecture/uid");
  assertIdentity(PINNED_NODE, row.node, "toolchain Node");
  if (canonicalJson(row.orchestratorEnvironment) !== canonicalJson(ORCHESTRATOR_ENV)) fail("toolchain environment mismatch");
  const dependencyRoot = arguments_.dependencyRoot ?? row.defaultDependencyRoot;
  const jdkRoot = arguments_.jdkRoot ?? row.jdk.home;
  if (!path.isAbsolute(dependencyRoot) || fs.realpathSync(dependencyRoot) !== dependencyRoot || !fs.lstatSync(dependencyRoot).isDirectory()) fail("dependency root is not canonical");
  const jdkTree = treeIdentity(jdkRoot);
  assertIdentity(jdkTree, row.jdk.tree, "JDK tree");
  const diagnostics = row.jdk.diagnostics.map((expected) => {
    const file = stableFile(path.join(jdkRoot, ...expected.path.split("/")), `JDK ${expected.path}`);
    assertFileIdentity(file, expected, `JDK ${expected.path}`);
    return { ...expected };
  });
  const runtime = dependencies.value.dependencies.map((entry, index) => {
    if (entry.order !== index + 1 || entry.artifactName.slice(0, 2) !== String(index + 1).padStart(2, "0")) fail("dependency order mismatch");
    if (!HASH.test(entry.sha256) || entry.relativeCachePath.startsWith("/") || entry.relativeCachePath.includes("..")) fail("dependency manifest path/hash invalid");
    const source = path.join(dependencyRoot, ...entry.relativeCachePath.split("/"));
    const file = stableFile(source, entry.coordinate);
    assertFileIdentity(file, entry, entry.coordinate);
    return Object.freeze({ ...entry, source });
  });
  return Object.freeze({ row, dependencyRoot, jdkRoot, jdkTree, diagnostics, runtime, toolchain, dependencies, domain });
}
function childEnvironment(jdkRoot, home, temporary) {
  return Object.freeze({ JAVA_HOME: jdkRoot, HOME: home, TMPDIR: temporary, LANG: "C", LC_ALL: "C", TZ: "UTC" });
}
function runTool(command, args, options) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, shell: false, encoding: null, maxBuffer: 4_194_304 });
  if (result.error || result.signal || result.status !== 0 || result.stderr.length !== 0) {
    const diagnostic = Buffer.from(result.stderr ?? "").toString("utf8").replace(/[\r\n]+/g, " ").slice(0, 1_000);
    fail(`${path.basename(command)} failed (${result.error?.code ?? result.signal ?? result.status ?? "unknown"}): ${diagnostic}`);
  }
  if (result.stdout.length !== 0) fail(`${path.basename(command)} wrote unexpected stdout`);
}
function copyStable(source, target) {
  const before = stableFile(source);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);
  const after = stableFile(target);
  if (before.size !== after.size || before.sha256 !== after.sha256) fail("staged file identity mismatch");
}
function listFiles(root, relative = "") {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort(compare)) {
    const child = relative ? `${relative}/${name}` : name;
    const stat = fs.lstatSync(path.join(root, child));
    if (stat.isDirectory() && !stat.isSymbolicLink()) result.push(...listFiles(root, child));
    else if (stat.isFile() && !stat.isSymbolicLink()) result.push(child);
    else fail("class staging contains a symlink or special file");
  }
  return result;
}
function scanSourceCapabilities(javaSources) {
  const allowedImports = new Set([
    "java.io.IOException", "java.io.InputStream", "java.io.OutputStream", "java.nio.ByteBuffer",
    "java.nio.charset.CharacterCodingException", "java.nio.charset.CodingErrorAction", "java.nio.charset.StandardCharsets",
    "java.security.MessageDigest", "java.security.NoSuchAlgorithmException", "java.util.ArrayDeque", "java.util.ArrayList",
    "java.util.Arrays", "java.util.Base64", "java.util.Comparator", "java.util.HashMap", "java.util.LinkedHashMap",
    "java.util.List", "java.util.Map", "java.util.Set", "java.util.regex.Pattern",
    "org.jetbrains.kotlin.cli.common.CLIConfigurationKeys", "org.jetbrains.kotlin.cli.common.messages.MessageCollector",
    "org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles", "org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment",
    "org.jetbrains.kotlin.com.intellij.openapi.Disposable", "org.jetbrains.kotlin.com.intellij.openapi.util.Disposer",
    "org.jetbrains.kotlin.com.intellij.psi.PsiElement", "org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil",
    "org.jetbrains.kotlin.config.CommonConfigurationKeys", "org.jetbrains.kotlin.config.CompilerConfiguration",
    "org.jetbrains.kotlin.psi.KtCallExpression", "org.jetbrains.kotlin.psi.KtFile", "org.jetbrains.kotlin.psi.KtImportDirective",
    "org.jetbrains.kotlin.psi.KtNamedDeclaration", "org.jetbrains.kotlin.psi.KtPsiFactory", "org.jetbrains.kotlin.resolve.ImportPath",
  ]);
  const forbiddenText = [
    "ProcessBuilder", "ProcessHandle", "Runtime.getRuntime", "Runtime.exec", "ClassLoader", "Class.forName",
    "getClassLoader", "loadClass", "java.net.", "java.nio.file.", "java.io.File", "java.lang.reflect",
    "java.lang.invoke", "javax.script", "javax.tools", "kotlin.script", "K2JVMCompiler", "KotlinCompileDaemon",
  ];
  for (const source of javaSources) {
    const text = stableFile(source).bytes.toString("utf8");
    for (const match of text.matchAll(/^import\s+(static\s+)?([^;]+);$/gm)) {
      if (match[1] || !allowedImports.has(match[2])) fail(`sidecar source contains unreviewed import ${match[0]}`);
    }
    for (const token of forbiddenText) if (text.includes(token)) fail(`sidecar source contains forbidden capability ${token}`);
  }
}
function scanClassCapabilities(classesRoot) {
  const forbiddenBytes = [
    "java/lang/ProcessBuilder", "java/lang/ProcessHandle", "java/lang/Runtime", "java/lang/ClassLoader",
    "java/io/File", "java/nio/file/", "java/net/", "javax/net/", "javax/script/", "javax/tools/",
    "java/lang/reflect/", "kotlin/script", "K2JVMCompiler", "KotlinCompileDaemon", "loadClass", "forName",
  ].map((value) => Buffer.from(value));
  for (const relative of listFiles(classesRoot).filter((name) => name.endsWith(".class"))) {
    const bytes = stableFile(path.join(classesRoot, relative)).bytes;
    for (const token of forbiddenBytes) if (bytes.includes(token)) fail(`sidecar bytecode contains forbidden capability ${token}`);
  }
}
function classReferences(bytes) {
  if (bytes.length < 10 || bytes.readUInt32BE(0) !== 0xcafebabe) fail("invalid analyzer class file");
  const pool = new Array(bytes.readUInt16BE(8));
  let cursor = 10;
  for (let index = 1; index < pool.length; index += 1) {
    const tag = bytes.readUInt8(cursor++);
    if (tag === 1) { const length = bytes.readUInt16BE(cursor); cursor += 2; pool[index] = { tag, value: bytes.subarray(cursor, cursor + length).toString("utf8") }; cursor += length; }
    else if (tag === 7) { pool[index] = { tag, name: bytes.readUInt16BE(cursor) }; cursor += 2; }
    else if (new Set([3, 4, 9, 10, 11, 12, 17, 18]).has(tag)) cursor += 4;
    else if (new Set([5, 6]).has(tag)) { cursor += 8; index += 1; }
    else if (new Set([8, 16, 19, 20]).has(tag)) cursor += 2;
    else if (tag === 15) cursor += 3;
    else fail(`unsupported analyzer class constant-pool tag ${tag}`);
  }
  return pool.filter((entry) => entry?.tag === 7).map((entry) => pool[entry.name]?.value ?? fail("invalid analyzer class reference"));
}
function inspectJar(bytes) {
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0 || eocd + 22 !== bytes.length || bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0
      || bytes.readUInt16LE(eocd + 20) !== 0) fail("thin JAR has an invalid end record");
  const count = bytes.readUInt16LE(eocd + 10);
  if (bytes.readUInt16LE(eocd + 8) !== count) fail("thin JAR split entry count is invalid");
  const centralBytes = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  let expectedLocalOffset = 0;
  const entries = [];
  const contents = new Map();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) fail("thin JAR central directory is invalid");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const uncompressedBytes = bytes.readUInt32LE(cursor + 24);
    const nameBytes = bytes.readUInt16LE(cursor + 28);
    const extraBytes = bytes.readUInt16LE(cursor + 30);
    const commentBytes = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8");
    if (!name || name.endsWith("/") || name.startsWith("/") || name.split("/").includes("..") || contents.has(name)
        || localOffset !== expectedLocalOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50
        || bytes.readUInt16LE(cursor + 4) !== 20 || bytes.readUInt16LE(cursor + 6) !== 20 || flags !== 0x0808 || method !== 8
        || bytes.readUInt16LE(cursor + 12) !== 1 || bytes.readUInt16LE(cursor + 14) !== 33
        || bytes.readUInt16LE(cursor + 34) !== 0 || bytes.readUInt16LE(cursor + 36) !== 0 || bytes.readUInt32LE(cursor + 38) !== 0) fail("thin JAR entry metadata is invalid or duplicated");
    const localNameBytes = bytes.readUInt16LE(localOffset + 26);
    const localExtraBytes = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameBytes);
    const centralName = bytes.subarray(cursor + 46, cursor + 46 + nameBytes);
    const centralExtra = bytes.subarray(cursor + 46 + nameBytes, cursor + 46 + nameBytes + extraBytes);
    const localExtra = bytes.subarray(localOffset + 30 + localNameBytes, localOffset + 30 + localNameBytes + localExtraBytes);
    if (bytes.readUInt16LE(localOffset + 4) !== 20 || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method
        || bytes.readUInt16LE(localOffset + 10) !== 1 || bytes.readUInt16LE(localOffset + 12) !== 33 || !localName.equals(centralName)
        || !localExtra.equals(centralExtra) || !(extraBytes === 0 || (extraBytes === 4 && centralExtra.equals(Buffer.from([0xfe, 0xca, 0, 0]))))) fail("thin JAR local metadata mismatch");
    const dataStart = localOffset + 30 + localNameBytes + localExtraBytes;
    const compressed = bytes.subarray(dataStart, dataStart + compressedBytes);
    const content = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : fail("thin JAR compression is unsupported");
    if (content.length !== uncompressedBytes) fail("thin JAR entry length mismatch");
    const descriptor = dataStart + compressedBytes;
    if (bytes.readUInt32LE(descriptor) !== 0x08074b50 || bytes.readUInt32LE(descriptor + 4) !== bytes.readUInt32LE(cursor + 16)
        || bytes.readUInt32LE(descriptor + 8) !== compressedBytes || bytes.readUInt32LE(descriptor + 12) !== uncompressedBytes) fail("thin JAR data descriptor mismatch");
    expectedLocalOffset = descriptor + 16;
    entries.push(name); contents.set(name, content);
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  if (expectedLocalOffset !== centralOffset || cursor !== centralOffset + centralBytes || cursor !== eocd) fail("thin JAR central-directory extent mismatch");
  return { entries, contents };
}
function assertReviewedJar(material, inspection) {
  if (canonicalJson(inspection.entries) !== canonicalJson(EXPECTED_JAR_ENTRIES)) fail("thin JAR entries do not match the reviewed Batch 1 inventory");
  const embeddedDomain = inspection.contents.get("domain-v1.json");
  if (!embeddedDomain || sha256(embeddedDomain) !== material.domain.material.sha256) fail("thin JAR embedded domain mismatch");
  const references = new Set();
  for (const [name, content] of inspection.contents) {
    if (!name.endsWith(".class")) continue;
    for (const token of ["java/lang/ProcessBuilder", "java/lang/ProcessHandle", "java/lang/Runtime", "java/lang/ClassLoader", "java/io/File", "java/nio/file/", "java/net/", "javax/script/", "javax/tools/", "java/lang/reflect/", "kotlin/script", "K2JVMCompiler", "KotlinCompileDaemon", "loadClass", "forName"]) {
      if (content.includes(Buffer.from(token))) fail(`thin JAR bytecode ${name} contains forbidden capability ${token}`);
    }
    for (const reference of classReferences(content)) references.add(reference);
  }
  const actual = [...references].sort(compare);
  const expected = [...ALLOWED_CLASS_REFERENCES].sort(compare);
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`thin JAR bytecode class-reference inventory mismatch: ${canonicalJson(actual)}`);
}
function cleanBuild(buildRoot, material) {
  const stagedSource = path.join(buildRoot, "source");
  const classes = path.join(buildRoot, "classes");
  const buildHome = path.join(buildRoot, "home");
  const buildTmp = path.join(buildRoot, "tmp");
  for (const directory of [stagedSource, classes, buildHome, buildTmp]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const javaSources = SOURCE_PATHS.map((source) => {
    const relative = path.relative(ANALYZER_ROOT, source);
    const target = path.join(stagedSource, relative);
    copyStable(source, target);
    return target;
  }).sort(compare);
  scanSourceCapabilities(javaSources);
  const classpath = material.runtime.map((entry) => entry.source).join(path.delimiter);
  const environment = childEnvironment(material.jdkRoot, buildHome, buildTmp);
  runTool(path.join(material.jdkRoot, "bin/javac"), [
    `-J-Duser.home=${buildHome}`, `-J-Djava.io.tmpdir=${buildTmp}`,
    "--release", "17", "-encoding", "UTF-8", "-g:none", "-proc:none",
    "-classpath", classpath, "-d", classes, ...javaSources,
  ], { cwd: stagedSource, env: environment });
  copyStable(CONFIG_PATHS[0], path.join(classes, "domain-v1.json"));
  scanClassCapabilities(classes);
  const entries = listFiles(classes);
  if (!entries.includes("domain-v1.json") || entries.some((entry) => entry !== "domain-v1.json" && !entry.endsWith(".class"))) fail("thin JAR staging has an unexpected entry");
  const argumentFile = path.join(buildRoot, "jar-entries.txt");
  fs.writeFileSync(argumentFile, `${entries.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  const jar = path.join(buildRoot, "analyzer-v1.jar");
  runTool(path.join(material.jdkRoot, "bin/jar"), [
    `-J-Duser.home=${buildHome}`, `-J-Djava.io.tmpdir=${buildTmp}`,
    "--create", "--no-manifest", "--file", jar, "--date=1980-01-01T00:00:02Z", `@${argumentFile}`,
  ], { cwd: classes, env: environment });
  const identity = stableFile(jar);
  const inspection = inspectJar(identity.bytes);
  assertReviewedJar(material, inspection);
  return Object.freeze({ jar, bytes: identity.size, sha256: identity.sha256, entries: inspection.entries });
}
function relativeRepositoryPath(file) {
  const relative = path.relative(REPOSITORY_ROOT, file).split(path.sep).join("/");
  if (relative.startsWith("../") || relative === "..") fail("receipt input escapes repository");
  return relative;
}
function sourceInputs() {
  return [...SOURCE_PATHS, ...CONFIG_PATHS, fileURLToPath(import.meta.url), BRIDGE].sort(compare).map((file) => {
    const material = stableFile(file);
    return { path: relativeRepositoryPath(file), bytes: material.size, sha256: material.sha256 };
  });
}
function receiptWithoutHash(material, jar, buildHashes) {
  const runtime = material.runtime.map((entry) => ({ order: entry.order, coordinate: entry.coordinate, path: `runtime/${entry.artifactName}`, bytes: entry.bytes, sha256: entry.sha256 }));
  const classpath = [{ path: "analyzer-v1.jar", bytes: jar.bytes, sha256: jar.sha256 }, ...runtime];
  const runCwd = path.join(PUBLISHED_ROOT, "run-cwd");
  const runHome = path.join(PUBLISHED_ROOT, "run-home");
  const runTmp = path.join(PUBLISHED_ROOT, "run-tmp");
  const java = path.join(material.jdkRoot, "bin/java");
  const runtimeArgs = [
    "-Xms32m", "-Xmx512m", "-Djava.awt.headless=true", "-Dfile.encoding=UTF-8",
    "-Duser.language=en", "-Duser.country=US", "-Duser.timezone=UTC",
    `-Duser.home=${runHome}`, `-Djava.io.tmpdir=${runTmp}`, "-Dkotlin.environment.keepalive=false",
    "-cp", classpath.map((entry) => path.join(PUBLISHED_ROOT, ...entry.path.split("/"))).join(path.delimiter),
    "com.agentbench.analyzer.Main", "analyze",
  ];
  const inputs = sourceInputs();
  return {
    receiptVersion: 1,
    analyzerName: "supported-subset-abstract-interpreter-v1",
    protocolVersion: 1,
    subsetVersion: 1,
    domainVersion: 1,
    artifactRoot: PUBLISHED_ROOT,
    sourceInputs: inputs,
    analyzerSourceSha256: sha256(canonicalJson(inputs)),
    domainSha256: material.domain.material.sha256,
    dependencyManifestSha256: material.dependencies.material.sha256,
    toolchainManifestSha256: material.toolchain.material.sha256,
    bridgeSha256: stableFile(BRIDGE).sha256,
    node: { ...PINNED_NODE, execArgv: [], environment: { ...ORCHESTRATOR_ENV } },
    dependencyRoot: material.dependencyRoot,
    jdk: { root: material.jdkRoot, version: material.row.jdk.version, tree: { ...material.jdkTree }, diagnostics: material.diagnostics },
    build: {
      childEnvironmentNames: ["HOME", "JAVA_HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"],
      childEnvironment: { JAVA_HOME: "$PINNED_JDK", HOME: "$BUILD_HOME", TMPDIR: "$BUILD_TMP", LANG: "C", LC_ALL: "C", TZ: "UTC" },
      javacArgs: ["-J-Duser.home=$BUILD_HOME", "-J-Djava.io.tmpdir=$BUILD_TMP", "--release", "17", "-encoding", "UTF-8", "-g:none", "-proc:none", "-classpath", "$ORDERED_SEVEN_JARS", "-d", "$CLASSES", "$SORTED_ABSOLUTE_JAVA_SOURCES"],
      jarArgs: ["-J-Duser.home=$BUILD_HOME", "-J-Djava.io.tmpdir=$BUILD_TMP", "--create", "--no-manifest", "--file", "$ANALYZER_JAR", "--date=1980-01-01T00:00:02Z", "@$SORTED_RELATIVE_ENTRY_FILE"],
      cleanBuildJarSha256: buildHashes,
      jarEntries: jar.entries,
    },
    analyzerJar: { path: "analyzer-v1.jar", bytes: jar.bytes, sha256: jar.sha256 },
    runtime,
    classpath,
    classpathSha256: sha256(canonicalJson(classpath)),
    launch: {
      java,
      args: runtimeArgs,
      mainClass: "com.agentbench.analyzer.Main",
      cwd: runCwd,
      environment: { JAVA_HOME: material.jdkRoot, HOME: runHome, TMPDIR: runTmp, LANG: "C", LC_ALL: "C", TZ: "UTC" },
      shell: false,
    },
    bounds: {
      maxRequestJsonBytes: 52_428_800, maxResponseJsonBytes: 4_194_304, maxStderrBytes: 4_194_304,
      timeoutMs: 30_000, maxBuffer: 4_194_312, cacheMaxEntries: 32, cacheMaxEncodedBytes: 16_777_216,
    },
  };
}
function publish(material, first, second, refuseExisting) {
  if (first.sha256 !== second.sha256 || first.bytes !== second.bytes) fail("clean analyzer builds are not byte-identical");
  if (refuseExisting && fs.existsSync(PUBLISHED_ROOT)) fail("published artifact already exists");
  const stage = fs.mkdtempSync(path.join(ARTIFACTS_ROOT, ".publish-"));
  copyStable(first.jar, path.join(stage, "analyzer-v1.jar"));
  fs.mkdirSync(path.join(stage, "runtime"), { mode: 0o700 });
  for (const entry of material.runtime) copyStable(entry.source, path.join(stage, "runtime", entry.artifactName));
  for (const directory of ["run-cwd", "run-home", "run-tmp"]) fs.mkdirSync(path.join(stage, directory), { mode: 0o700 });
  const withoutHash = receiptWithoutHash(material, first, [first.sha256, second.sha256]);
  const receipt = { ...withoutHash, receiptSha256: receiptDigest(withoutHash) };
  fs.writeFileSync(path.join(stage, RECEIPT_NAME), `${canonicalJson(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
  for (const file of ["analyzer-v1.jar", RECEIPT_NAME]) fs.chmodSync(path.join(stage, file), 0o400);
  for (const file of fs.readdirSync(path.join(stage, "runtime"))) fs.chmodSync(path.join(stage, "runtime", file), 0o400);
  fs.chmodSync(path.join(stage, "runtime"), 0o500);
  fs.chmodSync(stage, 0o500);
  if (fs.existsSync(PUBLISHED_ROOT)) {
    const backup = path.join(ARTIFACTS_ROOT, `.previous-${crypto.randomUUID()}`);
    fs.renameSync(PUBLISHED_ROOT, backup);
    try { fs.renameSync(stage, PUBLISHED_ROOT); }
    catch (error) { fs.renameSync(backup, PUBLISHED_ROOT); throw error; }
    makeTreeWritable(backup);
    fs.rmSync(backup, { recursive: true, force: true });
  } else fs.renameSync(stage, PUBLISHED_ROOT);
  return verifyPublished(material);
}
function verifyPublished(material) {
  if (!fs.existsSync(PUBLISHED_ROOT) || fs.realpathSync(PUBLISHED_ROOT) !== PUBLISHED_ROOT || fs.lstatSync(PUBLISHED_ROOT).isSymbolicLink()) fail("published root is missing or non-canonical");
  const rootStat = fs.lstatSync(PUBLISHED_ROOT);
  if (rootStat.uid !== process.getuid() || mode(rootStat) !== "0500") fail("published root owner or mode mismatch");
  const expectedTop = [RECEIPT_NAME, "analyzer-v1.jar", "run-cwd", "run-home", "run-tmp", "runtime"].sort(compare);
  if (canonicalJson(fs.readdirSync(PUBLISHED_ROOT).sort(compare)) !== canonicalJson(expectedTop)) fail("published root has unexpected entries");
  for (const directory of ["run-cwd", "run-home", "run-tmp"]) {
    const absolute = path.join(PUBLISHED_ROOT, directory);
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || mode(stat) !== "0700" || fs.readdirSync(absolute).length !== 0) fail(`${directory} publication metadata mismatch`);
  }
  const runtimeStat = fs.lstatSync(path.join(PUBLISHED_ROOT, "runtime"));
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== process.getuid() || mode(runtimeStat) !== "0500") fail("runtime directory owner or mode mismatch");
  const runtimeNames = fs.readdirSync(path.join(PUBLISHED_ROOT, "runtime")).sort(compare);
  if (canonicalJson(runtimeNames) !== canonicalJson(material.runtime.map((entry) => entry.artifactName))) fail("runtime classpath file set mismatch");
  for (const entry of material.runtime) {
    const absolute = path.join(PUBLISHED_ROOT, "runtime", entry.artifactName);
    const file = stableFile(absolute);
    const stat = fs.lstatSync(absolute);
    if (stat.uid !== process.getuid() || stat.nlink !== 1 || mode(stat) !== "0400") fail(`${entry.artifactName} publication metadata mismatch`);
    assertFileIdentity(file, entry, entry.artifactName);
  }
  const jarPath = path.join(PUBLISHED_ROOT, "analyzer-v1.jar");
  const jarFile = stableFile(jarPath);
  const jarStat = fs.lstatSync(jarPath);
  if (jarStat.uid !== process.getuid() || jarStat.nlink !== 1 || mode(jarStat) !== "0400") fail("analyzer JAR publication metadata mismatch");
  const inspection = inspectJar(jarFile.bytes);
  assertReviewedJar(material, inspection);
  const receiptPath = path.join(PUBLISHED_ROOT, RECEIPT_NAME);
  const receiptFile = stableFile(receiptPath);
  const receiptStat = fs.lstatSync(receiptPath);
  if (receiptStat.uid !== process.getuid() || receiptStat.nlink !== 1 || mode(receiptStat) !== "0400") fail("receipt publication metadata mismatch");
  let receipt;
  const receiptText = receiptFile.bytes.toString("utf8");
  if (!Buffer.from(receiptText, "utf8").equals(receiptFile.bytes)) fail("receipt is not valid UTF-8");
  try { receipt = JSON.parse(receiptText); } catch { fail("receipt is not JSON"); }
  if (receiptText !== `${canonicalJson(receipt)}\n`) fail("receipt bytes are not canonical JSON plus one LF");
  const { receiptSha256, ...withoutHash } = receipt;
  if (!HASH.test(receiptSha256) || receiptSha256 !== receiptDigest(withoutHash)) fail("receipt self-hash mismatch");
  const jar = { bytes: jarFile.size, sha256: jarFile.sha256, entries: inspection.entries };
  const expected = receiptWithoutHash(material, jar, [jar.sha256, jar.sha256]);
  if (canonicalJson(withoutHash) !== canonicalJson(expected)) fail("receipt or current analyzer identity mismatch");
  return Object.freeze({ command: "verify", analyzerJarSha256: jar.sha256, receiptSha256, receiptFileSha256: receiptFile.sha256, jdkTreeSha256: material.jdkTree.sha256, classpathSha256: receipt.classpathSha256 });
}
function removeBuild(directory) {
  if (path.dirname(directory) !== ARTIFACTS_ROOT || !path.basename(directory).startsWith(".build-")) fail("refusing broad temporary cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
}
function makeTreeWritable(root) {
  const stat = fs.lstatSync(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) makeTreeWritable(path.join(root, name));
  } else if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(root, 0o600);
  else fail("refusing to remove a publication containing a symlink or special file");
}
function main() {
  const arguments_ = parseArguments();
  fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(ARTIFACTS_ROOT);
  if (fs.realpathSync(ARTIFACTS_ROOT) !== ARTIFACTS_ROOT || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid() || mode(parentStat) !== "0700") fail("artifact parent is non-canonical");
  const lock = path.join(ARTIFACTS_ROOT, ".publication-lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { fail(`artifact publication is busy: ${error.code ?? error.message}`); }
  try {
    const material = platformMaterial(arguments_);
    if (arguments_.command === "verify") return verifyPublished(material);
    const firstRoot = fs.mkdtempSync(path.join(ARTIFACTS_ROOT, ".build-a-"));
    const secondRoot = fs.mkdtempSync(path.join(ARTIFACTS_ROOT, ".build-b-"));
    try {
      const first = cleanBuild(firstRoot, material);
      const second = cleanBuild(secondRoot, material);
      return publish(material, first, second, arguments_.command === "build");
    } finally {
      removeBuild(firstRoot);
      removeBuild(secondRoot);
    }
  } finally {
    fs.rmdirSync(lock);
  }
}
try {
  process.stdout.write(`${canonicalJson(main())}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
