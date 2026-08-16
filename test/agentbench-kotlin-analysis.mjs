import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../benchmarks/spatial-agent-bench/lib/identity.mjs";
import { ANALYZER_CONSTANTS, analyzeKotlin, computeKotlinInputSetSha256, computeSelectedInputSetSha256,
  describeKotlinAnalyzer, verifyAnalyzerArtifact } from "../benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs";
import { spawnFakeAnalyzer } from "./fixtures/agentbench/fake-analyzer.mjs";
const ROOT = path.resolve(import.meta.dirname, "..");
const BRIDGE = path.join(ROOT, "benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs");
const BUILD = path.join(ROOT, "benchmarks/spatial-agent-bench/analyzer/build-analyzer.mjs");
const ANALYZER_DIR = path.dirname(BUILD);
const ARTIFACT = path.join(ROOT, "benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/analyzer-v1.jar");
const RECEIPT = path.join(ROOT, "benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/analyzer-build-receipt-v1.json");
const ARTIFACTS = path.dirname(path.dirname(ARTIFACT));
const CLEAN_ENV = ["LANG=C", "LC_ALL=C", "TZ=UTC", "__CF_USER_TEXT_ENCODING=0x1F5:0x0:0x0"];
const RECEIPT_DOMAIN = Buffer.from("agentbench-analyzer-receipt-v1\0", "utf8");
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function mode(stat) { return (stat.mode & 0o777).toString(8).padStart(4, "0"); }
function treeIdentity(root) {
  const entries = []; const counts = { entries: 0, files: 0, directories: 0, symlinks: 0, fileBytes: 0 };
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name); const itemPath = relative ? `${relative}/${name}` : name; const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) { entries.push({ path: itemPath, type: "symlink", mode: mode(stat), target: fs.readlinkSync(absolute) }); counts.symlinks += 1; }
      else if (stat.isDirectory()) { entries.push({ path: itemPath, type: "dir", mode: mode(stat) }); counts.directories += 1; visit(absolute, itemPath); }
      else {
        const bytes = fs.readFileSync(absolute);
        entries.push({ path: itemPath, type: "file", mode: mode(stat), bytes: bytes.length, sha256: hash(bytes) });
        counts.files += 1; counts.fileBytes += bytes.length;
      }
    }
  }
  visit(root); counts.entries = entries.length;
  return { ...counts, sha256: hash(canonicalJson(entries)) };
}
function sourceIndex(rows) {
  const files = rows.map((row) => Object.freeze({ path: row.path, absolutePath: path.join(ROOT, row.path), kind: row.kind ?? "kotlin", original: row.content, structural: row.content }));
  return Object.freeze({
    projectDir: ROOT, files: Object.freeze(files),
    totalBytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.original), 0),
    facts: Object.freeze({ gradle: Object.freeze({}), manifest: Object.freeze({}) }),
    factEvidence: Object.freeze([]),
  });
}
async function copiedBridge(t, scenarioRef, calls, artifactRoot = null) {
  const original = fs.readFileSync(BRIDGE, "utf8");
  const marker = "const spawnAnalyzer = spawnSync;";
  assert.equal(original.includes(marker), true, "bridge must retain the single copied-module spawn seam");
  const copied = path.join(path.dirname(BRIDGE), `.kotlin-analysis-test-${process.pid}-${crypto.randomUUID()}.mjs`);
  let source = original.replace(marker, "const spawnAnalyzer = globalThis.__agentbenchSpawnAnalyzer;");
  if (artifactRoot !== null) source = source.replace('const ARTIFACT_ROOT = path.join(ANALYZER_ROOT, ".artifacts/v1");', `const ARTIFACT_ROOT = ${JSON.stringify(artifactRoot)};`);
  fs.writeFileSync(copied, source);
  t.after(() => { delete globalThis.__agentbenchSpawnAnalyzer; fs.rmSync(copied, { force: true }); });
  globalThis.__agentbenchSpawnAnalyzer = (command, args, options) => {
    calls.count += 1;
    calls.records?.push({ command, args, options });
    return spawnFakeAnalyzer(scenarioRef.value, options);
  };
  return import(`${pathToFileURL(copied).href}?nonce=${crypto.randomUUID()}`);
}
function reSelfHash(receipt) {
  const without = structuredClone(receipt);
  delete without.receiptSha256;
  return { ...without, receiptSha256: hash(Buffer.concat([RECEIPT_DOMAIN, Buffer.from(canonicalJson(without))])) };
}
function replaceRoot(value, from, to) {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((entry) => replaceRoot(entry, from, to));
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceRoot(entry, from, to)]));
  return value;
}
function copyArtifact(t) {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(ARTIFACTS, ".test-artifact-")));
  const target = path.join(container, "v1");
  fs.mkdirSync(target, { mode: 0o700 });
  t.after(() => { makeTreeWritable(container); fs.rmSync(container, { recursive: true, force: true }); });
  for (const directory of ["runtime", "run-cwd", "run-home", "run-tmp"]) fs.mkdirSync(path.join(target, directory), { mode: 0o700 });
  fs.copyFileSync(ARTIFACT, path.join(target, "analyzer-v1.jar"));
  for (const name of fs.readdirSync(path.join(path.dirname(ARTIFACT), "runtime"))) {
    fs.copyFileSync(path.join(path.dirname(ARTIFACT), "runtime", name), path.join(target, "runtime", name));
  }
  const receipt = replaceRoot(JSON.parse(fs.readFileSync(RECEIPT, "utf8")), path.dirname(ARTIFACT), target);
  fs.writeFileSync(path.join(target, "analyzer-build-receipt-v1.json"), `${canonicalJson(reSelfHash(receipt))}\n`);
  for (const name of ["analyzer-v1.jar", "analyzer-build-receipt-v1.json"]) fs.chmodSync(path.join(target, name), 0o400);
  for (const name of fs.readdirSync(path.join(target, "runtime"))) fs.chmodSync(path.join(target, "runtime", name), 0o400);
  fs.chmodSync(path.join(target, "runtime"), 0o500);
  fs.chmodSync(target, 0o500);
  return target;
}
function makeTreeWritable(root) {
  const stat = fs.lstatSync(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) makeTreeWritable(path.join(root, name));
  } else if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(root, 0o600);
}
function analyzerReplica(t) {
  const replicaRoot = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, ".agentbench-test-replica-")));
  t.after(() => { makeTreeWritable(replicaRoot); fs.rmSync(replicaRoot, { recursive: true, force: true }); });
  const analyzer = path.join(replicaRoot, "benchmarks/spatial-agent-bench/analyzer");
  const lib = path.join(replicaRoot, "benchmarks/spatial-agent-bench/lib");
  fs.cpSync(ANALYZER_DIR, analyzer, { recursive: true, filter: (source) => !source.includes(`${path.sep}.artifacts`) });
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(BRIDGE, path.join(lib, "kotlin-analysis.mjs"));
  const artifact = path.join(analyzer, ".artifacts/v1");
  for (const directory of ["runtime", "run-cwd", "run-home", "run-tmp"]) fs.mkdirSync(path.join(artifact, directory), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(artifact), 0o700);
  fs.copyFileSync(ARTIFACT, path.join(artifact, "analyzer-v1.jar"));
  for (const name of fs.readdirSync(path.join(path.dirname(ARTIFACT), "runtime"))) {
    fs.copyFileSync(path.join(path.dirname(ARTIFACT), "runtime", name), path.join(artifact, "runtime", name));
  }
  const receipt = replaceRoot(JSON.parse(fs.readFileSync(RECEIPT, "utf8")), path.dirname(ARTIFACT), artifact);
  fs.writeFileSync(path.join(artifact, "analyzer-build-receipt-v1.json"), `${canonicalJson(reSelfHash(receipt))}\n`);
  for (const name of ["analyzer-v1.jar", "analyzer-build-receipt-v1.json"]) fs.chmodSync(path.join(artifact, name), 0o400);
  for (const name of fs.readdirSync(path.join(artifact, "runtime"))) fs.chmodSync(path.join(artifact, "runtime", name), 0o400);
  fs.chmodSync(path.join(artifact, "runtime"), 0o500);
  fs.chmodSync(artifact, 0o500);
  return { replicaRoot, analyzer, artifact, build: path.join(analyzer, "build-analyzer.mjs") };
}
async function copiedReplicaBridge(t, replica, scenarioRef, calls) {
  const production = path.join(replica.replicaRoot, "benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs");
  const copied = path.join(path.dirname(production), `.kotlin-analysis-test-${crypto.randomUUID()}.mjs`);
  const source = fs.readFileSync(production, "utf8").replace("const spawnAnalyzer = spawnSync;", "const spawnAnalyzer = globalThis.__agentbenchSpawnAnalyzer;");
  fs.writeFileSync(copied, source);
  t.after(() => { delete globalThis.__agentbenchSpawnAnalyzer; fs.rmSync(copied, { force: true }); });
  globalThis.__agentbenchSpawnAnalyzer = (_command, _args, options) => {
    calls.count += 1;
    return spawnFakeAnalyzer(scenarioRef.value, options);
  };
  return import(`${pathToFileURL(copied).href}?nonce=${crypto.randomUUID()}`);
}
function refreshReplicaReceipt(replica) {
  const receiptPath = path.join(replica.artifact, "analyzer-build-receipt-v1.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.sourceInputs = receipt.sourceInputs.map((row) => {
    const bytes = fs.readFileSync(path.join(replica.replicaRoot, ...row.path.split("/")));
    return { path: row.path, bytes: bytes.length, sha256: hash(bytes) };
  });
  receipt.analyzerSourceSha256 = hash(canonicalJson(receipt.sourceInputs));
  const byName = (name) => receipt.sourceInputs.find((row) => row.path.endsWith(`/${name}`)).sha256;
  receipt.domainSha256 = byName("domain-v1.json");
  receipt.dependencyManifestSha256 = byName("dependencies-v1.json");
  receipt.toolchainManifestSha256 = byName("toolchain-v1.json");
  receipt.bridgeSha256 = byName("kotlin-analysis.mjs");
  const toolchain = JSON.parse(fs.readFileSync(path.join(replica.analyzer, "toolchain-v1.json"), "utf8"));
  const platform = toolchain.platforms.find((row) => row.platform === process.platform && row.arch === process.arch && row.uid === process.getuid());
  receipt.jdk = { root: platform.jdk.home, version: platform.jdk.version, tree: platform.jdk.tree, diagnostics: platform.jdk.diagnostics };
  receipt.launch.java = path.join(platform.jdk.home, "bin/java");
  receipt.launch.environment.JAVA_HOME = platform.jdk.home;
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, `${canonicalJson(reSelfHash(receipt))}\n`);
  fs.chmodSync(receiptPath, 0o400);
}
function runScrubbedNode(script, args = []) {
  return spawnSync("/usr/bin/env", ["-i", ...CLEAN_ENV, "/usr/local/bin/node", script, ...args], { encoding: "utf8" });
}
test("analyzer artifact and self-hashed receipt bind the exact PSI toolchain", () => {
  const verified = verifyAnalyzerArtifact();
  assert.equal(fs.statSync(ARTIFACT).size, verified.analyzerJarBytes);
  assert.equal(hash(fs.readFileSync(ARTIFACT)), verified.analyzerJarSha256);
  assert.equal(hash(fs.readFileSync(RECEIPT)), verified.receiptFileSha256);
  assert.equal(verified.runtime.length, 7);
  assert.deepEqual(verified.runtime.map((row) => row.order), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(verified.classpath.length, 8);
  assert.equal(verified.jdkTreeSha256, "89b10d67dd49a0f809716313416a78734fb3ff466ab7b9a801eabdd1e10109d7");
  assert.equal(verified.nodeSha256, "c583851fc85e4618b2374cda13399d59d373ad7cebfc4b55160820b88dcce67b");
  for (const name of ["analyzer-v1.jar", "analyzer-build-receipt-v1.json", ...fs.readdirSync(path.join(path.dirname(ARTIFACT), "runtime")).map((entry) => `runtime/${entry}`)]) {
    const stat = fs.lstatSync(path.join(path.dirname(ARTIFACT), name));
    assert.equal(stat.mode & 0o777, 0o400, `${name} must be owner-read-only`);
    assert.equal(stat.nlink, 1, `${name} must have no hard-link alias`);
  }
  assert.throws(() => fs.appendFileSync(ARTIFACT, Buffer.from([0])), /EACCES|permission denied/i);
  const description = describeKotlinAnalyzer();
  assert.equal(description.analysisStatus, "accepted");
  assert.deepEqual(description.constants, ANALYZER_CONSTANTS);
  assert.deepEqual(description.nodes, []);
  assert.deepEqual(description.claims, []);
});
test("Kotlin input identities bind every selected .kt and .kts byte independently from other selected inputs", () => {
  const index = sourceIndex([
    { path: "app/build.gradle.kts", kind: "gradle", content: "plugins {}\n" },
    { path: "app/src/A.kt", content: "package sample\nclass A\n" },
    { path: "scripts/B.kts", content: "val b = 2\n" },
    { path: "app/src/main/AndroidManifest.xml", kind: "manifest", content: "<manifest/>\n" },
  ]);
  const kotlinRows = index.files.filter((file) => file.kind === "kotlin").map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.original),
    sha256: hash(Buffer.from(file.original)),
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const selectedRows = index.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    bytes: Buffer.byteLength(file.original),
    sha256: hash(Buffer.from(file.original)),
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  assert.equal(computeKotlinInputSetSha256(index), hash(canonicalJson(kotlinRows)));
  assert.equal(computeSelectedInputSetSha256(index), hash(canonicalJson(selectedRows)));
});
test("all-or-nothing PSI parsing accepts only complete .kt indexes and emits no semantic claims", () => {
  const accepted = analyzeKotlin(sourceIndex([
    { path: "src/One.kt", content: "package sample\nimport kotlin.String as Text\nclass One(val name: Text)\n" },
    { path: "src/Two.kt", content: "package sample\nfun answer(): Int = 42\n" },
  ]));
  assert.equal(accepted.analysisStatus, "accepted");
  assert.equal(accepted.rejectionCode, null);
  assert.deepEqual(accepted.nodes, []);
  assert.deepEqual(accepted.claims, []);
  for (const [name, rows, code] of [
    ["script only", [{ path: "scripts/Only.kts", content: "val x = 1\n" }], "unsupported_script"],
    ["mixed script", [{ path: "src/Ok.kt", content: "package sample\nclass Ok\n" }, { path: "scripts/No.kts", content: "val x = 1\n" }], "unsupported_script"],
    ["malformed competing file", [{ path: "src/Ok.kt", content: "package sample\nclass Ok\n" }, { path: "src/Broken.kt", content: "package sample\nfun broken( {\n" }], "parse"],
    ["ambiguous index", [{ path: "src/A.kt", content: "package sample\nclass Same\n" }, { path: "src/B.kt", content: "package sample\nclass Same\n" }], "ambiguous_index"],
    ["same-file ambiguous index", [{ path: "src/Duplicate.kt", content: "package sample\nclass Same\nclass Same\n" }], "ambiguous_index"],
    ["incomplete imports", [{ path: "src/Star.kt", content: "package sample\nimport kotlin.*\nclass Star\n" }], "incomplete_imports"],
  ]) {
    const result = analyzeKotlin(sourceIndex(rows));
    assert.equal(result.analysisStatus, "rejected", name);
    assert.equal(result.rejectionCode, code, name);
    assert.deepEqual(result.nodes, [], name);
    assert.deepEqual(result.claims, [], name);
    assert.equal(result.kotlinInputSetSha256, computeKotlinInputSetSha256(sourceIndex(rows)), name);
  }
});
test("protocol rejects integers outside the canonical safe range", () => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const json = Buffer.from(`{"command":"analyze","files":[{"bytes":-9223372036854775808,"contentBase64":"","path":"src/Unsafe.kt","sha256":"${"0".repeat(64)}"}],"kotlinInputSetSha256":"${"0".repeat(64)}","protocolVersion":1,"subsetVersion":1}`, "utf8");
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(json.length));
  const result = spawnSync(receipt.launch.java, receipt.launch.args, {
    cwd: receipt.launch.cwd,
    env: receipt.launch.environment,
    shell: false,
    encoding: "utf8",
    input: Buffer.concat([header, json]),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /safe range|invalid integer/i);
});
test("analyzer artifact rejects a rewritten JAR and self-hashed receipt transplant", async (t) => {
  const artifactRoot = copyArtifact(t);
  const scenario = { value: "accepted" };
  const bridge = await copiedBridge(t, scenario, { count: 0 }, artifactRoot);
  assert.equal(bridge.verifyAnalyzerArtifact().analyzerJarSha256, hash(fs.readFileSync(ARTIFACT)));
  const jarPath = path.join(artifactRoot, "analyzer-v1.jar");
  fs.chmodSync(jarPath, 0o600);
  fs.appendFileSync(jarPath, Buffer.from([0]));
  fs.chmodSync(jarPath, 0o400);
  const receiptPath = path.join(artifactRoot, "analyzer-build-receipt-v1.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  const jarSha256 = hash(fs.readFileSync(jarPath));
  receipt.analyzerJar.bytes += 1;
  receipt.analyzerJar.sha256 = jarSha256;
  receipt.classpath[0] = { ...receipt.analyzerJar };
  receipt.classpathSha256 = hash(canonicalJson(receipt.classpath));
  receipt.build.cleanBuildJarSha256 = [jarSha256, jarSha256];
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, `${canonicalJson(reSelfHash(receipt))}\n`);
  fs.chmodSync(receiptPath, 0o400);
  assert.throws(() => bridge.verifyAnalyzerArtifact(), /JAR|toolchain|anchor|identity/i);
});
test("analyzer artifact rejects false receipt build vectors", async (t) => {
  const artifactRoot = copyArtifact(t);
  const bridge = await copiedBridge(t, { value: "accepted" }, { count: 0 }, artifactRoot);
  const receiptPath = path.join(artifactRoot, "analyzer-build-receipt-v1.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.build.childEnvironment.PATH = "/tmp/injected";
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, `${canonicalJson(reSelfHash(receipt))}\n`);
  fs.chmodSync(receiptPath, 0o400);
  assert.throws(() => bridge.verifyAnalyzerArtifact(), /build|environment|receipt/i);
});
test("build env verifier rejects noncanonical receipt bytes and forbidden sidecar capabilities", (t) => {
  const replica = analyzerReplica(t);
  assert.equal(runScrubbedNode(replica.build, ["verify"]).status, 0, "replica baseline must verify");
  const receiptPath = path.join(replica.artifact, "analyzer-build-receipt-v1.json");
  const canonical = fs.readFileSync(receiptPath, "utf8");
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, ` ${canonical}`);
  fs.chmodSync(receiptPath, 0o400);
  const malformed = runScrubbedNode(replica.build, ["verify"]);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /canonical JSON plus one LF/i);
  fs.chmodSync(receiptPath, 0o600);
  fs.writeFileSync(receiptPath, canonical);
  fs.chmodSync(receiptPath, 0o400);
  const mainPath = path.join(replica.analyzer, "src/main/java/com/agentbench/analyzer/Main.java");
  const main = fs.readFileSync(mainPath, "utf8");
  for (const attack of [
    main.replace("private Main() {}", 'private Main() { java.nio.file.Files.exists(java.nio.file.Path.of("/")); }'),
    main.replace("import java.nio.ByteBuffer;", "import static java.lang.Runtime.getRuntime;\nimport java.nio.ByteBuffer;"),
    main.replace("private Main() {}", 'private Main() { try { Class.forName("java.lang.Runtime"); } catch (Exception ignored) {} }'),
    main.replace("private Main() {}", "private Main() { new java.util.Scanner(System.in); }"),
  ]) {
    fs.writeFileSync(mainPath, attack);
    const rejected = runScrubbedNode(replica.build, ["clean-build-twice"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /forbidden capability|unreviewed import|class-reference inventory/i);
  }
});
test("analyzer artifact verification precedes local all-or-nothing limit rejection", async (t) => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(ARTIFACTS, ".test-missing-")));
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const missing = path.join(container, "v1");
  const bridge = await copiedBridge(t, { value: "accepted" }, { count: 0 }, missing);
  const rows = Array.from({ length: 513 }, (_, index) => ({ path: `src/TooMany${String(index).padStart(3, "0")}.kt`, content: "package sample\nclass Tiny\n" }));
  assert.throws(() => bridge.analyzeKotlin(sourceIndex(rows)), /artifact|ENOENT|missing/i);
});
test("spawnSync protocol faults fail closed before any analyzer result is accepted", async (t) => {
  const scenario = { value: "accepted" };
  const calls = { count: 0, records: [] };
  const bridge = await copiedBridge(t, scenario, calls);
  const index = sourceIndex([
    { path: "src/First.kt", content: "package sample\nclass First\n" },
    { path: "src/Second.kt", content: "package sample\nclass Second\n" },
  ]);
  const faults = [
    ["hang", /timeout|timed out|ETIMEDOUT/i],
    ["nonzero", /status|exit/i],
    ["signal", /signal/i],
    ["stderr", /stderr/i],
    ["partial", /frame|length/i],
    ["trailing", /trailing|frame/i],
    ["invalid-utf8", /UTF-8/i],
    ["duplicate-key", /duplicate|canonical|missing/i],
    ["noncanonical-whitespace", /canonical/i],
    ["out-of-order-key", /out-of-order|canonical|missing/i],
    ["negative-zero", /canonical|integer/i],
    ["fraction", /canonical|integer/i],
    ["lone-surrogate", /surrogate|canonical/i],
    ["deep-json", /depth|canonical/i],
    ["oversize-header", /frame exceeds bound/i],
    ["non-buffer", /Buffers/i],
    ["unknown-key", /unknown.*key/i],
    ["wrong-version", /protocolVersion/i],
    ["wrong-digest", /digest|kotlinInputSetSha256/i],
    ["reordered-files", /file receipts|mismatch/i],
    ["missing-file", /file receipts|mismatch/i],
    ["extra-file", /file receipts|mismatch/i],
    ["impossible-status", /accepted.*rejection/i],
    ["impossible-constants", /constants/i],
    ["stdout-overflow", /buffer|ENOBUFS|stdout/i],
    ["stderr-overflow", /buffer|ENOBUFS|stderr/i],
  ];
  for (const [fault, expected] of faults) {
    scenario.value = fault;
    assert.throws(() => bridge.analyzeKotlin(index), expected, fault);
  }
  assert.equal(calls.count, faults.length);
  for (const { command, args, options } of calls.records) {
    const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
    assert.equal(command, receipt.launch.java);
    assert.deepEqual(args, receipt.launch.args);
    assert.equal(options.cwd, receipt.launch.cwd);
    assert.deepEqual(options.env, receipt.launch.environment);
    assert.equal(options.shell, false);
    assert.equal(options.encoding, null);
    assert.equal(options.timeout, 30_000);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.maxBuffer, 4_194_312);
    assert.equal(Buffer.isBuffer(options.input), true);
    assert.equal(options.input.readBigUInt64BE(0), BigInt(options.input.length - 8));
  }
});
test("cache identity is bounded, input-keyed, and stores only validated response bytes", async (t) => {
  const scenario = { value: "accepted" };
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, scenario, calls);
  const make = (number) => sourceIndex([{ path: `src/Case${number}.kt`, content: `package sample\nclass Case${number}\n` }]);
  assert.equal(bridge.analyzeKotlin(make(0)).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(make(0)).analysisStatus, "accepted");
  assert.equal(calls.count, 1, "same validated identity must hit the cache");
  for (let index = 1; index <= 32; index += 1) bridge.analyzeKotlin(make(index));
  assert.equal(calls.count, 33);
  bridge.analyzeKotlin(make(0));
  assert.equal(calls.count, 34, "the oldest of 33 distinct entries must be evicted");
  scenario.value = "wrong-digest";
  assert.throws(() => bridge.analyzeKotlin(make(99)), /digest|kotlinInputSetSha256/i);
  scenario.value = "accepted";
  bridge.analyzeKotlin(make(99));
  assert.equal(calls.count, 36, "an invalid response must never populate the cache");
});
test("protocol and Kotlin input limits enforce exact N and N+1 boundaries", async (t) => {
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, { value: "accepted" }, calls);
  const fileCountN = Array.from({ length: 512 }, (_, index) => ({ path: `src/Count${index}.kt`, content: `class Count${index}\n` }));
  assert.equal(bridge.analyzeKotlin(sourceIndex(fileCountN)).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(sourceIndex([...fileCountN, { path: "src/Count512.kt", content: "class Count512\n" }])).rejectionCode, "limit");
  assert.equal(bridge.analyzeKotlin(sourceIndex([{ path: "a".repeat(4_093) + ".kt", content: "\n" }])).analysisStatus, "accepted");
  assert.throws(() => bridge.analyzeKotlin(sourceIndex([{ path: "a".repeat(4_094) + ".kt", content: "\n" }])), /path/i);
  assert.equal(bridge.analyzeKotlin(sourceIndex([{ path: "src/Bytes.kt", content: " ".repeat(1_048_576) }])).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(sourceIndex([{ path: "src/Bytes.kt", content: " ".repeat(1_048_577) }])).rejectionCode, "limit");
  const totalN = Array.from({ length: 8 }, (_, index) => ({ path: `src/Total${index}.kt`, content: " ".repeat(1_048_576) }));
  assert.equal(bridge.analyzeKotlin(sourceIndex(totalN)).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(sourceIndex([...totalN, { path: "src/Total8.kt", content: "x" }])).rejectionCode, "limit");
  assert.equal(calls.count, 4, "only exact-boundary requests reach the child");
});
test("cache byte budget evicts validated responses before the entry-count limit", async (t) => {
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, { value: "accepted" }, calls);
  const make = (variant) => sourceIndex(Array.from({ length: 512 }, (_, index) => ({
    path: `src/${variant}-${String(index).padStart(3, "0")}-${"p".repeat(3_400)}.kt`,
    content: `class C${variant}_${index}\n`,
  })));
  for (let index = 0; index < 10; index += 1) assert.equal(bridge.analyzeKotlin(make(index)).analysisStatus, "accepted");
  bridge.analyzeKotlin(make(0));
  assert.equal(calls.count, 11, "the 16 MiB byte budget must evict the oldest large validated response");
});
test("cache identity transition misses for receipt-only and JDK-only control changes", async (t) => {
  const replica = analyzerReplica(t);
  const calls = { count: 0 };
  const bridge = await copiedReplicaBridge(t, replica, { value: "accepted" }, calls);
  const input = sourceIndex([{ path: "src/Stable.kt", content: "class Stable\n" }]);
  assert.equal(bridge.analyzeKotlin(input).analysisStatus, "accepted");
  assert.equal(bridge.analyzeKotlin(input).analysisStatus, "accepted");
  assert.equal(calls.count, 1);
  const toolchainPath = path.join(replica.analyzer, "toolchain-v1.json");
  const toolchain = JSON.parse(fs.readFileSync(toolchainPath, "utf8"));
  toolchain.cacheIdentityRevision = 1;
  fs.writeFileSync(toolchainPath, `${JSON.stringify(toolchain, null, 2)}\n`);
  refreshReplicaReceipt(replica);
  assert.equal(bridge.analyzeKotlin(input).analysisStatus, "accepted");
  assert.equal(calls.count, 2, "a receipt-only identity transition must clear the old LRU");
  const fakeJdk = path.join(replica.replicaRoot, "cache-identity-jdk");
  for (const directory of ["bin", "lib/server"]) fs.mkdirSync(path.join(fakeJdk, directory), { recursive: true, mode: 0o755 });
  for (const [name, content, executable] of [
    ["release", "JAVA_VERSION=cache-identity\n", false], ["bin/java", "#!/bin/sh\nexit 0\n", true],
    ["bin/javac", "javac", true], ["bin/jar", "jar", true], ["lib/modules", "modules", false],
    ["lib/libjava.dylib", "libjava", false], ["lib/libjli.dylib", "libjli", false], ["lib/server/libjvm.dylib", "libjvm", false],
  ]) {
    const file = path.join(fakeJdk, ...name.split("/"));
    fs.writeFileSync(file, content, { mode: executable ? 0o755 : 0o644 });
    if (executable) fs.chmodSync(file, 0o755);
  }
  const diagnostics = ["release", "bin/java", "bin/javac", "bin/jar", "lib/modules", "lib/libjava.dylib", "lib/libjli.dylib", "lib/server/libjvm.dylib"].map((name) => {
    const bytes = fs.readFileSync(path.join(fakeJdk, ...name.split("/")));
    return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  toolchain.platforms[0].jdk = { home: fakeJdk, version: "cache-identity-jdk-v1", tree: treeIdentity(fakeJdk), diagnostics };
  fs.writeFileSync(toolchainPath, `${JSON.stringify(toolchain, null, 2)}\n`);
  refreshReplicaReceipt(replica);
  assert.equal(bridge.analyzeKotlin(input).analysisStatus, "accepted");
  assert.equal(calls.count, 3, "a JDK-only executable identity transition must clear the old LRU");
});
test("build env rejects parent and Node-option injection before publishing", () => {
  const before = fs.readFileSync(RECEIPT);
  for (const args of [
    ["-i", ...CLEAN_ENV, "NODE_OPTIONS=", "/usr/local/bin/node", BUILD, "verify"],
    ["-i", ...CLEAN_ENV, "NODE_PATH=/tmp/injected", "/usr/local/bin/node", BUILD, "verify"],
    ["-i", ...CLEAN_ENV, "/usr/local/bin/node", "--no-warnings", BUILD, "verify"],
    ["-i", ...CLEAN_ENV, "/usr/local/bin/node", BUILD, "verify", "--dependency-root", "relative"],
  ]) {
    const result = spawnSync("/usr/bin/env", args, { encoding: "utf8" });
    assert.notEqual(result.status, 0, args.join(" "));
  }
  assert.deepEqual(fs.readFileSync(RECEIPT), before);
});
test("fake JDK proves successful javac and jar children receive only frozen env and argv", (t) => {
  const replica = analyzerReplica(t);
  const fakeJdk = path.join(replica.replicaRoot, "fake-jdk");
  const fakeDependencies = path.join(replica.replicaRoot, "fake-dependencies");
  const log = path.join(replica.replicaRoot, "child-log.jsonl");
  fs.mkdirSync(path.join(fakeJdk, "bin"), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(fakeJdk, "lib/server"), { recursive: true, mode: 0o755 });
  const toolSource = (tool) => `#!/usr/bin/perl\nuse strict; use warnings; use JSON::PP; use Cwd qw(getcwd); use File::Copy qw(copy);\nopen(my $fh, ">>", ${JSON.stringify(log)}) or die $!;\nmy $row={tool=>${JSON.stringify(tool)},argv=>[\@ARGV],cwd=>getcwd(),env=>{%ENV}};\nprint $fh encode_json($row), "\\n"; close($fh);\n${tool === "jar" ? `my $at=-1; for(my $i=0;$i<scalar(@ARGV);$i++){if($ARGV[$i] eq "--file"){$at=$i;last;}} exit(91) if $at<0; copy(${JSON.stringify(ARTIFACT)},$ARGV[$at+1]) or die $!;` : ""}\n`;
  for (const tool of ["java", "javac", "jar"]) {
    const file = path.join(fakeJdk, "bin", tool);
    fs.writeFileSync(file, toolSource(tool), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  for (const [name, content] of [["release", "JAVA_VERSION=fake\n"], ["lib/modules", "modules"], ["lib/libjava.dylib", "libjava"], ["lib/libjli.dylib", "libjli"], ["lib/server/libjvm.dylib", "libjvm"]]) {
    const file = path.join(fakeJdk, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, content);
  }
  const dependenciesPath = path.join(replica.analyzer, "dependencies-v1.json");
  const dependencies = JSON.parse(fs.readFileSync(dependenciesPath, "utf8"));
  for (const entry of dependencies.dependencies) {
    entry.relativeCachePath = `fake/${entry.order}.jar`;
    const source = path.join(fakeDependencies, "fake", `${entry.order}.jar`);
    fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`dependency-${entry.order}`);
    fs.writeFileSync(source, bytes);
    entry.bytes = bytes.length;
    entry.sha256 = hash(bytes);
  }
  fs.writeFileSync(dependenciesPath, `${JSON.stringify(dependencies, null, 2)}\n`);
  const diagnostics = ["release", "bin/java", "bin/javac", "bin/jar", "lib/modules", "lib/libjava.dylib", "lib/libjli.dylib", "lib/server/libjvm.dylib"].map((name) => {
    const bytes = fs.readFileSync(path.join(fakeJdk, ...name.split("/")));
    return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  const toolchainPath = path.join(replica.analyzer, "toolchain-v1.json");
  const toolchain = JSON.parse(fs.readFileSync(toolchainPath, "utf8"));
  toolchain.platforms[0].defaultDependencyRoot = fakeDependencies;
  toolchain.platforms[0].jdk = { home: fakeJdk, version: "fake-jdk-v1", tree: treeIdentity(fakeJdk), diagnostics };
  fs.writeFileSync(toolchainPath, `${JSON.stringify(toolchain, null, 2)}\n`);
  const built = runScrubbedNode(replica.build, ["clean-build-twice"]);
  assert.equal(built.status, 0, built.stderr);
  const rows = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.tool), ["javac", "jar", "javac", "jar"]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.env).sort(), ["HOME", "JAVA_HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"]);
    assert.equal(row.env.JAVA_HOME, fakeJdk);
    assert.equal(row.env.LANG, "C"); assert.equal(row.env.LC_ALL, "C"); assert.equal(row.env.TZ, "UTC");
    assert.equal(path.isAbsolute(row.env.HOME), true); assert.equal(path.isAbsolute(row.env.TMPDIR), true);
    assert.equal(row.argv[0], `-J-Duser.home=${row.env.HOME}`);
    assert.equal(row.argv[1], `-J-Djava.io.tmpdir=${row.env.TMPDIR}`);
    assert.equal(row.cwd.endsWith(row.tool === "javac" ? "/source" : "/classes"), true);
    assert.equal(row.argv.some((value) => /JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|NODE_OPTIONS|PATH=/.test(value)), false);
  }
});
