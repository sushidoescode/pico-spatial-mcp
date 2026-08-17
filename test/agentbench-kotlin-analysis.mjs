import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../benchmarks/spatial-agent-bench/lib/identity.mjs";
import { ANALYZER_CONSTANTS, analyzeKotlin, computeKotlinInputSetSha256, computeSelectedInputSetSha256,
  describeKotlinAnalyzer, verifyAnalyzerArtifact } from "../benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs";
import { loadSubmissionSources } from "../benchmarks/spatial-agent-bench/lib/source.mjs";
import { spawnFakeAnalyzer } from "./fixtures/agentbench/fake-analyzer.mjs";
import {
  UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS,
  writeEquivalentReopenProject,
  writeUncorrectedCheckpointProject,
} from "./helpers/agentbench-fixture.mjs";
const ROOT = path.resolve(import.meta.dirname, "..");
const BRIDGE = path.join(ROOT, "benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs");
const BUILD = path.join(ROOT, "benchmarks/spatial-agent-bench/analyzer/build-analyzer.mjs");
const ANALYZER_DIR = path.dirname(BUILD);
const ARTIFACT = path.join(ROOT, "benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/analyzer-v1.jar");
const RECEIPT = path.join(ROOT, "benchmarks/spatial-agent-bench/analyzer/.artifacts/v1/analyzer-build-receipt-v1.json");
const DOMAIN = path.join(ANALYZER_DIR, "domain-v1.json");
const JAVA_ROOT = path.join(ANALYZER_DIR, "src/main/java/com/agentbench/analyzer");
const ARTIFACTS = path.dirname(path.dirname(ARTIFACT));
const CLEAN_ENV = ["LANG=C", "LC_ALL=C", "TZ=UTC", "__CF_USER_TEXT_ENCODING=0x1F5:0x0:0x0"];
const RECEIPT_DOMAIN = Buffer.from("agentbench-analyzer-receipt-v1\0", "utf8");
const FOLLOWUP_DOMAIN_SHA256 = "6f2f241af489b70e8dfb036e82c8d33c9aa8b39dc2866f7c9f957c7b1304084a";
const RULE_ORDER = Object.freeze([
  "spatial.project-entry", "spatial.container-topology", "spatial.entity-content", "spatial.ui-lifecycle",
  "ecs.component-clone", "ecs.system-query", "ecs.frame-update", "ecs.lifecycle",
  "state.single-source", "state.typed-handoff", "state.shared-read-write", "state.reopen-wiring",
  "plane.retry-readiness", "plane.semantic-fallback", "plane.anchor-pose", "plane.cleanup-errors",
]);
const WITNESS_KINDS = Object.freeze([
  "declaration", "callable_reference", "call", "argument", "property_read", "assignment",
  "condition", "loop", "lambda", "return", "type_reference", "catch",
]);
const PROOF_FORMS_BY_RULE = Object.freeze({
  "ecs.component-clone": ["expression-component-clone", "single-return-block-component-clone"],
  "ecs.frame-update": ["assign-delta-update", "plus-assign-delta-update"],
  "ecs.lifecycle": ["paired-system-lifecycle"],
  "ecs.system-query": ["hoisted-query-scene-update"],
  "plane.anchor-pose": ["same-anchor-pose-conversion"],
  "plane.cleanup-errors": ["paired-plane-cleanup-status"],
  "plane.retry-readiness": ["bounded-retained-load-retry"],
  "plane.semantic-fallback": ["dominating-semantic-plane-fallback"],
  "spatial.container-topology": ["direct-mixed-stage-open", "one-helper-mixed-stage-open", "two-helper-mixed-stage-open"],
  "spatial.entity-content": ["spatial-view-entity-attachment"],
  "spatial.project-entry": ["application-launch-root"],
  "spatial.ui-lifecycle": ["themed-window-and-disposable-stage"],
  "state.reopen-wiring": ["retained-state-close-reopen"],
  "state.shared-read-write": ["same-authority-read-write"],
  "state.single-source": ["shared-strong-authority"],
  "state.typed-handoff": ["typed-bundle-roundtrip"],
});
const ACCEPTED_ALTERNATIVES_BY_RULE = Object.freeze({
  "ecs.component-clone": {
    "expression-component-clone": ["positional-fields", "named-fields"],
    "single-return-block-component-clone": ["positional-fields", "named-fields"],
  },
  "ecs.frame-update": {
    "assign-delta-update": ["direct-transform", "pure-helper-transform"],
    "plus-assign-delta-update": ["direct-transform", "pure-helper-transform"],
  },
  "ecs.lifecycle": { "paired-system-lifecycle": ["direct-register-unregister"] },
  "ecs.system-query": { "hoisted-query-scene-update": ["direct-query-use", "pure-helper-query-use"] },
  "plane.anchor-pose": { "same-anchor-pose-conversion": ["direct-pose-conversion", "pure-helper-pose-conversion"] },
  "plane.cleanup-errors": { "paired-plane-cleanup-status": ["direct-cleanup", "unique-helper-cleanup"] },
  "plane.retry-readiness": { "bounded-retained-load-retry": ["bounded-for", "canonical-bounded-while"] },
  "plane.semantic-fallback": { "dominating-semantic-plane-fallback": ["inline-selectors", "unique-helper-selectors"] },
  "spatial.container-topology": {
    "direct-mixed-stage-open": ["named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id", "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id"],
    "one-helper-mixed-stage-open": ["named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id", "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id"],
    "two-helper-mixed-stage-open": ["named-literal-stage-id", "named-const-stage-id", "named-source-symbol-stage-id", "positional-literal-stage-id", "positional-const-stage-id", "positional-source-symbol-stage-id"],
  },
  "spatial.entity-content": { "spatial-view-entity-attachment": ["direct-initial-entity", "unique-helper-initial-entity"] },
  "spatial.project-entry": { "application-launch-root": ["direct-launch-import", "aliased-launch-import"] },
  "spatial.ui-lifecycle": { "themed-window-and-disposable-stage": ["direct-theme-paired-dispose"] },
  "state.reopen-wiring": { "retained-state-close-reopen": ["standard-store-reopen", "equivalent-repository-reopen"] },
  "state.shared-read-write": { "same-authority-read-write": ["direct-container-summaries"] },
  "state.single-source": { "shared-strong-authority": ["top-level-val", "object-singleton", "companion-held-singleton"] },
  "state.typed-handoff": { "typed-bundle-roundtrip": ["direct-bundle-adapter", "unique-helper-bundle-adapter"] },
});
const COMPONENT_CANARY_SYMBOLS = Object.freeze([
  { arguments: [], callbacks: [], effects: ["construct"], fqn: "com.pico.spatial.core.ecs.Component", kind: "constructor", memberPrecedence: "not_applicable", receiverAbstractType: null, returnAbstractType: "component", signature: "Component()" },
  { arguments: [], callbacks: [], effects: [], fqn: "com.pico.spatial.core.ecs.Component", kind: "type", memberPrecedence: "not_applicable", receiverAbstractType: null, returnAbstractType: "component", signature: "open class Component" },
  { arguments: [], callbacks: [], effects: ["construct"], fqn: "com.pico.spatial.core.ecs.Component.clone", kind: "member_function", memberPrecedence: "sdk_member_wins", receiverAbstractType: "component", returnAbstractType: "component", signature: "clone(): Component" },
]);
const EXPECTED_JAVA_SOURCES = Object.freeze([
  "AbstractInterpreter.java", "Main.java", "Protocol.java", "PsiIndex.java", "Rules.java",
].map((name) => `benchmarks/spatial-agent-bench/analyzer/src/main/java/com/agentbench/analyzer/${name}`));
const EXPECTED_JAR_ENTRIES = Object.freeze([
  "com/agentbench/analyzer/AbstractInterpreter.class",
  "com/agentbench/analyzer/Main.class",
  "com/agentbench/analyzer/Protocol$Parser.class",
  "com/agentbench/analyzer/Protocol.class",
  "com/agentbench/analyzer/PsiIndex$Edge.class",
  "com/agentbench/analyzer/PsiIndex$EdgeRole.class",
  "com/agentbench/analyzer/PsiIndex$FileUnit.class",
  "com/agentbench/analyzer/PsiIndex$ImportEntry.class",
  "com/agentbench/analyzer/PsiIndex$Node.class",
  "com/agentbench/analyzer/PsiIndex$NodeFlag.class",
  "com/agentbench/analyzer/PsiIndex$NodeKind.class",
  "com/agentbench/analyzer/PsiIndex$Program.class",
  "com/agentbench/analyzer/PsiIndex$Result.class",
  "com/agentbench/analyzer/PsiIndex$SnapshotRejected.class",
  "com/agentbench/analyzer/PsiIndex$Source.class",
  "com/agentbench/analyzer/PsiIndex$Token.class",
  "com/agentbench/analyzer/PsiIndex$TokenKind.class",
  "com/agentbench/analyzer/PsiIndex$WitnessKind.class",
  "com/agentbench/analyzer/PsiIndex$WitnessNode.class",
  "com/agentbench/analyzer/PsiIndex.class",
  "com/agentbench/analyzer/Rules$AlternativeSpec.class",
  "com/agentbench/analyzer/Rules$Analysis.class",
  "com/agentbench/analyzer/Rules$ArgumentSpec.class",
  "com/agentbench/analyzer/Rules$CallbackSpec.class",
  "com/agentbench/analyzer/Rules$Domain.class",
  "com/agentbench/analyzer/Rules$RuleSpec.class",
  "com/agentbench/analyzer/Rules$SymbolSpec.class",
  "com/agentbench/analyzer/Rules.class",
  "domain-v1.json",
]);
const SYMBOL_KINDS = new Set(["type", "constructor", "top_level_function", "member_function", "extension_function", "member_property"]);
const MEMBER_PRECEDENCE = new Set(["not_applicable", "sdk_member_wins", "source_extension_if_no_sdk_member"]);
const CALLBACK_ROLES = new Set([
  "application_entry", "window_content", "stage_content", "launched_effect", "button_click", "coroutine_body",
  "disposable_effect", "dispose_cleanup", "spatial_initial", "spatial_attachments", "spatial_update",
  "collection_element", "collection_predicate", "collection_selector", "inline_block", "remembered_factory",
]);
const INVOCATION_MODELS = new Set([
  "source_root", "possible_path", "user_action", "launched_path", "acquire_path", "cleanup_path",
  "element_flow", "predicate_flow", "selector_flow", "immediate_inline",
]);
const EFFECTS = new Set([
  "read", "mutate", "construct", "replace", "unknown_escape", "open", "close", "acquire", "release",
  "load", "readiness", "convert", "place", "status_assign", "passthrough",
]);
const ABSTRACT_TYPES = new Set([
  "boolean", "int", "long", "float", "double", "string", "unit", "java_class", "callable",
  "immutable_iterable", "immutable_list", "integer_range", "coroutine_scope", "android_application",
  "spatial_launch_activity", "bundle", "spatial_app_scope", "spatial_navigator", "stage_style", "spatial_content",
  "component", "component_store", "entity", "entity_collection", "entity_query_condition", "ecs_system", "scene",
  "scene_update_context", "transform_component", "vector3", "quat", "cancellable", "semantic_label", "plane_anchor",
  "plane_anchor_collection", "plane_geometry", "plane_orientation", "plane_tracking_manager", "immersion", "modifier",
]);
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function exactKeys(value, keys, label) {
  assert.equal(value !== null && Object.getPrototypeOf(value) === Object.prototype, true, `${label} must be a plain object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys`);
}
function uniqueStrings(values, label) {
  assert.equal(Array.isArray(values) && values.length > 0, true, `${label} must be a nonempty array`);
  assert.equal(values.every((value) => typeof value === "string" && value.length > 0), true, `${label} strings`);
  assert.equal(new Set(values).size, values.length, `${label} uniqueness`);
}
function protocolFrame(value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([header, bytes]);
}
function framedResponse(bytes) {
  assert.equal(Buffer.isBuffer(bytes), true);
  assert.equal(bytes.length >= 8, true, "response frame header");
  assert.equal(bytes.readBigUInt64BE(0), BigInt(bytes.length - 8), "response frame length");
  const text = bytes.subarray(8).toString("utf8");
  const value = JSON.parse(text);
  assert.equal(canonicalJson(value), text, "canonical response payload");
  return value;
}
function analyzeRequest(pathName, content) {
  const bytes = Buffer.from(content, "utf8");
  const file = { path: pathName, bytes: bytes.length, sha256: hash(bytes), contentBase64: bytes.toString("base64") };
  const manifest = [{ path: file.path, bytes: file.bytes, sha256: file.sha256 }];
  return {
    protocolVersion: 1,
    subsetVersion: 1,
    command: "analyze",
    kotlinInputSetSha256: hash(canonicalJson(manifest)),
    files: [file],
  };
}
function temporaryDirectory(t, prefix) {
  const directory = path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomUUID()}`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}
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
const SEMANTIC_FAKE_SOURCE = `package fake.semantic

import com.pico.spatial.core.ecs.Component

class SignalPart(
    val active: Boolean = true,
    val phase: Int = 0,
    val marker: String = "🧭",
) : Component() {
    override fun clone(): SignalPart = SignalPart(active, phase, marker)
}
`;
const EXPRESSION_CLONE_SOURCE = `package canary.alpha

import com.pico.spatial.core.ecs.Component

class RelayPart(
    val active: Boolean = true,
    val phase: Int = 0,
    val label: String = "idle",
) : Component() {
    override fun clone(): RelayPart = RelayPart(active, phase, label)
}
`;
const BLOCK_CLONE_SOURCE = `package renamed.beta

import com.pico.spatial.core.ecs.Component as SpatialComponent

class TelemetryShard(
    val ready: Boolean = true,
    val sweep: Float = 0f,
) : SpatialComponent() {
    override fun clone(): TelemetryShard {
        return TelemetryShard(ready = ready, sweep = sweep)
    }
}
`;
const DEFAULT_PACKAGE_SOURCE = `class DefaultRoot
fun answer(): Int = 42
`;
function assertCloneResponse(response, proofForm, paths) {
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  assert.equal(response.claims.length, 1);
  assert.equal(response.claims[0].ruleId, "ecs.component-clone");
  assert.equal(response.claims[0].proofForm, proofForm);
  assert.equal(response.claims[0].witnessNodeIds.length > 0, true);
  assert.equal(response.nodes.length > 0, true);
  assert.deepEqual(response.nodes.map((node) => node.nodeId), [...response.claims[0].witnessNodeIds].sort());
  assert.equal(response.nodes.every((node) => paths.has(node.path)), true);
  assert.equal(response.nodes.every((node) => node.structuralToken === true || node.kind === "argument"), true);
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
function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}
function responseBoundary(response) {
  return {
    analysisStatus: response.analysisStatus,
    rejectionCode: response.rejectionCode,
    nodes: response.nodes,
    claims: response.claims,
  };
}
function assertAcceptedEmpty(response, label) {
  assert.deepEqual(responseBoundary(response), {
    analysisStatus: "accepted",
    rejectionCode: null,
    nodes: [],
    claims: [],
  }, label);
}
function assertRejectedEmpty(response, rejectionCode, label) {
  assert.deepEqual(responseBoundary(response), {
    analysisStatus: "rejected",
    rejectionCode,
    nodes: [],
    claims: [],
  }, label);
}
function extractClosedRegistry(source, name, language, label) {
  const opener = language === "java"
    ? `private static final Set<String> ${name} = Set.of(`
    : `const ${name} = new Set([`;
  const closer = language === "java" ? ");" : "]);";
  const start = source.indexOf(opener);
  assert.notEqual(start, -1, `${label} ${name} opener`);
  assert.equal(source.indexOf(opener, start + opener.length), -1, `${label} ${name} unique opener`);
  const bodyStart = start + opener.length;
  const end = source.indexOf(closer, bodyStart);
  assert.notEqual(end, -1, `${label} ${name} closer`);
  const body = source.slice(bodyStart, end);
  assert.equal(body.replaceAll(/"[a-z][a-z0-9_]*"/g, "").replaceAll(/[\s,]/g, ""), "",
    `${label} ${name} literal-only body`);
  return [...body.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
}
function runSnapshotBoundaryProbe(t) {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const temporary = temporaryDirectory(t, "agentbench-snapshot-boundary-probe");
  const sourceRoot = path.join(temporary, "source");
  const classes = path.join(temporary, "classes");
  const home = path.join(temporary, "home");
  const temporaryFiles = path.join(temporary, "tmp");
  for (const directory of [sourceRoot, classes, home, temporaryFiles]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const constructorOne = `package followup.probe
class Box()
`;
  const constructorTwo = `package followup.probe
class Box() {
    constructor() : this()
}
`;
  const lambdaOne = `package followup.probe
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
}
`;
  const lambdaTwo = `package followup.probe
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
    consume { }
}
`;
  const siblingLocals = `package followup.probe
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { fun duplicate() = Unit }
    consume { fun duplicate() = Unit }
}
`;
  const constructorOwnerBoundary = `package followup.probe
class Box {
    constructor(value: Int) : this() {
        fun duplicate() = Unit
    }
    fun Box() {
        fun duplicate() = Unit
    }
}
`;
  const lambdaOwnerBoundary = `package followup.probe
fun consume(block: () -> Unit) = Unit
fun host() {
    fun duplicate() = Unit
    consume { fun duplicate() = Unit }
}
`;
  const probeSource = `package com.agentbench.analyzer;
import java.nio.charset.StandardCharsets;
import java.util.List;
public final class SnapshotBoundaryProbe {
  private SnapshotBoundaryProbe() {}
  private static PsiIndex.Source source(String content) {
    byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
    return new PsiIndex.Source("src/followup/Probe.kt", Protocol.sha256(bytes), content);
  }
  private static PsiIndex.Program snapshot(String content) {
    return PsiIndex.snapshot(List.of(source(content)));
  }
  private static String status(String content) {
    String rejectionCode = PsiIndex.analyze(List.of(source(content))).rejectionCode();
    return rejectionCode == null ? "accepted" : rejectionCode;
  }
  public static void main(String[] ignored) {
    String constructorOne = ${JSON.stringify(constructorOne)};
    String constructorTwo = ${JSON.stringify(constructorTwo)};
    String lambdaOne = ${JSON.stringify(lambdaOne)};
    String lambdaTwo = ${JSON.stringify(lambdaTwo)};
    String siblingLocals = ${JSON.stringify(siblingLocals)};
    String constructorOwnerBoundary = ${JSON.stringify(constructorOwnerBoundary)};
    String lambdaOwnerBoundary = ${JSON.stringify(lambdaOwnerBoundary)};
    System.out.print("constructorOne=" + snapshot(constructorOne).declarationCount() + "\\n"
        + "constructorTwo=" + snapshot(constructorTwo).declarationCount() + "\\n"
        + "lambdaOne=" + snapshot(lambdaOne).declarationCount() + "\\n"
        + "lambdaTwo=" + snapshot(lambdaTwo).declarationCount() + "\\n"
        + "constructorsStatus=" + status(constructorTwo) + "\\n"
        + "lambdasStatus=" + status(lambdaTwo) + "\\n"
        + "siblingLocalsStatus=" + status(siblingLocals) + "\\n"
        + "constructorOwnerStatus=" + status(constructorOwnerBoundary) + "\\n"
        + "lambdaOwnerStatus=" + status(lambdaOwnerBoundary) + "\\n");
  }
}
`;
  const probePath = path.join(sourceRoot, "com/agentbench/analyzer/SnapshotBoundaryProbe.java");
  fs.mkdirSync(path.dirname(probePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probePath, probeSource);
  const classpath = receipt.classpath
    .map((entry) => path.join(receipt.artifactRoot, ...entry.path.split("/")))
    .join(path.delimiter);
  const environment = {
    JAVA_HOME: receipt.jdk.root,
    HOME: home,
    TMPDIR: temporaryFiles,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
  const compiled = spawnSync(path.join(receipt.jdk.root, "bin/javac"), [
    `-J-Duser.home=${home}`, `-J-Djava.io.tmpdir=${temporaryFiles}`, "--release", "17", "-encoding", "UTF-8",
    "-g:none", "-proc:none", "-classpath", classpath, "-d", classes, probePath,
  ], { cwd: sourceRoot, env: environment, shell: false, encoding: "utf8", maxBuffer: 4_194_304 });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(compiled.stdout, "");
  assert.equal(compiled.stderr, "");
  const runtimeArgs = receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${temporaryFiles}`));
  const cpIndex = runtimeArgs.indexOf("-cp");
  runtimeArgs[cpIndex + 1] = `${classes}${path.delimiter}${classpath}`;
  const mainIndex = runtimeArgs.indexOf("com.agentbench.analyzer.Main");
  runtimeArgs[mainIndex] = "com.agentbench.analyzer.SnapshotBoundaryProbe";
  const executed = spawnSync(receipt.launch.java, runtimeArgs, {
    cwd: temporary,
    env: environment,
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4_194_304,
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stderr, "");
  const rows = Object.fromEntries(executed.stdout.trim().split("\n").map((row) => {
    const separator = row.indexOf("=");
    assert.equal(separator > 0, true, `probe row ${row}`);
    return [row.slice(0, separator), row.slice(separator + 1)];
  }));
  assert.deepEqual(Object.keys(rows), [
    "constructorOne", "constructorTwo", "lambdaOne", "lambdaTwo",
    "constructorsStatus", "lambdasStatus", "siblingLocalsStatus",
    "constructorOwnerStatus", "lambdaOwnerStatus",
  ]);
  assert.equal(Number(rows.constructorTwo) - Number(rows.constructorOne), 1,
    "the added KtConstructor remains in declarationCount");
  assert.equal(Number(rows.lambdaTwo) - Number(rows.lambdaOne), 1,
    "the added KtFunctionLiteral remains in declarationCount");
  assert.equal(rows.constructorsStatus, "accepted", "constructors do not enter the ambiguity map");
  assert.equal(rows.lambdasStatus, "accepted", "anonymous functions do not enter the ambiguity map");
  assert.equal(rows.siblingLocalsStatus, "ambiguous_index", "anonymous functions do not enter owner keys");
  assert.equal(rows.constructorOwnerStatus, "accepted", "constructors do not enter owner keys");
  assert.equal(rows.lambdaOwnerStatus, "ambiguous_index", "anonymous functions do not distinguish nested owners");
}
test("domain bytes freeze the canonical closed subset-v1 vocabulary and clone canary", () => {
  const domainBytes = fs.readFileSync(DOMAIN);
  const domainText = domainBytes.toString("utf8");
  const domain = JSON.parse(domainText);
  assert.equal(domainText, canonicalJson(domain), "domain must be canonical UTF-8 JSON with no BOM, whitespace, or trailing LF");
  exactKeys(domain, new Set([
    "acceptedAlternativesByRule", "analyzerName", "domainVersion", "proofFormsByRule",
    "ruleOrder", "symbols", "witnessKinds",
  ]), "domain");
  assert.equal(domain.analyzerName, "supported-subset-abstract-interpreter-v1");
  assert.equal(domain.domainVersion, 1);
  assert.deepEqual(domain.ruleOrder, RULE_ORDER);
  assert.deepEqual(domain.witnessKinds, WITNESS_KINDS);
  const sortedRules = [...RULE_ORDER].sort();
  assert.deepEqual(Object.keys(domain.proofFormsByRule), sortedRules);
  assert.deepEqual(Object.keys(domain.acceptedAlternativesByRule), sortedRules);
  assert.deepEqual(domain.proofFormsByRule, PROOF_FORMS_BY_RULE);
  assert.deepEqual(domain.acceptedAlternativesByRule, ACCEPTED_ALTERNATIVES_BY_RULE);
  assert.equal(Object.values(domain.acceptedAlternativesByRule).flatMap((forms) => Object.values(forms)).reduce((sum, alternatives) => sum + alternatives.length, 0), 50);
  for (const ruleId of RULE_ORDER) {
    const forms = domain.proofFormsByRule[ruleId];
    uniqueStrings(forms, `${ruleId} proof forms`);
    const alternatives = domain.acceptedAlternativesByRule[ruleId];
    exactKeys(alternatives, new Set(forms), `${ruleId} alternatives`);
    assert.deepEqual(Object.keys(alternatives), [...forms].sort(), `${ruleId} alternative key order`);
    for (const proofForm of forms) uniqueStrings(alternatives[proofForm], `${ruleId}/${proofForm} alternatives`);
  }
  assert.deepEqual(domain.proofFormsByRule["ecs.component-clone"], [
    "expression-component-clone", "single-return-block-component-clone",
  ]);
  assert.equal(Array.isArray(domain.symbols), true);
  const symbolIdentities = [];
  for (const [index, symbol] of domain.symbols.entries()) {
    exactKeys(symbol, new Set([
      "arguments", "callbacks", "effects", "fqn", "kind", "memberPrecedence",
      "receiverAbstractType", "returnAbstractType", "signature",
    ]), `symbols[${index}]`);
    assert.equal(typeof symbol.fqn === "string" && symbol.fqn.length > 0, true);
    assert.equal(typeof symbol.signature === "string" && symbol.signature.length > 0, true);
    assert.equal(SYMBOL_KINDS.has(symbol.kind), true, `symbols[${index}].kind`);
    assert.equal(MEMBER_PRECEDENCE.has(symbol.memberPrecedence), true, `symbols[${index}].memberPrecedence`);
    for (const [label, abstractType] of [["receiver", symbol.receiverAbstractType], ["return", symbol.returnAbstractType]]) {
      assert.equal(abstractType === null || ABSTRACT_TYPES.has(abstractType), true, `symbols[${index}] ${label} abstract type`);
    }
    assert.equal(Array.isArray(symbol.arguments), true);
    assert.deepEqual(symbol.arguments.map((argument) => argument.position), symbol.arguments.map((_, position) => position));
    for (const argument of symbol.arguments) {
      exactKeys(argument, new Set(["abstractType", "name", "position"]), "domain argument");
      assert.equal(ABSTRACT_TYPES.has(argument.abstractType), true);
      assert.equal(argument.name === null || (typeof argument.name === "string" && argument.name.length > 0), true);
    }
    assert.equal(Array.isArray(symbol.callbacks), true);
    for (const callback of symbol.callbacks) {
      exactKeys(callback, new Set(["argumentPosition", "invocationModel", "role"]), "domain callback");
      assert.equal(Number.isSafeInteger(callback.argumentPosition) && callback.argumentPosition >= 0, true);
      assert.equal(callback.argumentPosition < symbol.arguments.length, true);
      assert.equal(CALLBACK_ROLES.has(callback.role), true);
      assert.equal(INVOCATION_MODELS.has(callback.invocationModel), true);
    }
    assert.equal(Array.isArray(symbol.effects), true);
    assert.equal(new Set(symbol.effects).size, symbol.effects.length);
    assert.equal(symbol.effects.every((effect) => EFFECTS.has(effect)), true);
    symbolIdentities.push(canonicalJson({ fqn: symbol.fqn, signature: symbol.signature }));
  }
  assert.deepEqual(symbolIdentities, [...new Set(symbolIdentities)].sort(), "canonical unique symbol order");
  const cloneRows = domain.symbols.filter((symbol) => symbol.fqn === "com.pico.spatial.core.ecs.Component"
    || symbol.fqn === "com.pico.spatial.core.ecs.Component.clone");
  assert.deepEqual(cloneRows, COMPONENT_CANARY_SYMBOLS, "clone canary must preserve the three exact audited Component rows");
});
test("follow-up vocabulary mirrors the exact reviewed minimum across the domain-row transition", () => {
  const expectedRegistries = {
    CALLBACK_ROLES: [...CALLBACK_ROLES],
    INVOCATION_MODELS: [...INVOCATION_MODELS],
    EFFECTS: [...EFFECTS],
    ABSTRACT_TYPES: [...ABSTRACT_TYPES],
  };
  const productionSources = [
    ["Rules.java", fs.readFileSync(path.join(JAVA_ROOT, "Rules.java"), "utf8"), "java"],
    ["build-analyzer.mjs", fs.readFileSync(BUILD, "utf8"), "javascript"],
    ["kotlin-analysis.mjs", fs.readFileSync(BRIDGE, "utf8"), "javascript"],
  ];
  for (const [name, expected] of Object.entries(expectedRegistries)) {
    assert.equal(new Set(expected).size, expected.length, `${name} test literal uniqueness`);
    for (const [label, source, language] of productionSources) {
      const actual = extractClosedRegistry(source, name, language, label);
      assert.deepEqual(actual, expected, `${label} ${name} exact source order`);
      assert.deepEqual(new Set(actual), new Set(expected), `${label} ${name} exact membership`);
    }
  }

  const domainBytes = fs.readFileSync(DOMAIN);
  const domainText = domainBytes.toString("utf8");
  const domain = JSON.parse(domainText);
  assert.equal(domainText, canonicalJson(domain), "follow-up domain must remain canonical JSON");
  exactKeys(domain, new Set([
    "acceptedAlternativesByRule", "analyzerName", "domainVersion", "proofFormsByRule",
    "ruleOrder", "symbols", "witnessKinds",
  ]), "follow-up domain");
  assert.equal(domain.analyzerName, "supported-subset-abstract-interpreter-v1");
  assert.equal(domain.domainVersion, 1);
  const cloneRows = domain.symbols.filter((symbol) => symbol.fqn === "com.pico.spatial.core.ecs.Component"
    || symbol.fqn === "com.pico.spatial.core.ecs.Component.clone");
  assert.deepEqual(cloneRows.map(canonicalJson), COMPONENT_CANARY_SYMBOLS.map(canonicalJson),
    "the exact three clone-canary rows survive every domain phase");
  if (hash(domainBytes) === FOLLOWUP_DOMAIN_SHA256) {
    assert.deepEqual(domain.symbols.map(canonicalJson), COMPONENT_CANARY_SYMBOLS.map(canonicalJson),
      "the follow-up domain identity contains no added symbol row");
  }
});
test("follow-up snapshot excludes anonymous declarations but preserves genuine ambiguity", (t) => {
  const acceptedCases = new Map([
    ["one anonymous lambda", `package followup.single
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
}
`],
    ["two sibling lambdas", `package followup.siblings
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { }
    consume { }
}
`],
    ["Button two-callback PSI shape", `package followup.button
fun Button(onClick: () -> Unit, content: () -> Unit) = Unit
fun host() {
    Button(onClick = { }) { }
}
`],
    ["anonymous lambdas under distinct named owners", `package followup.owners
fun consume(block: () -> Unit) = Unit
fun first() {
    consume { }
}
fun second() {
    consume { }
}
`],
    ["multiple constructor declarations", `package followup.constructors
class Box() {
    constructor() : this()
}
`],
  ]);
  for (const [label, content] of acceptedCases) {
    const fileName = label.replaceAll(/[^A-Za-z0-9]+/g, "-");
    assertAcceptedEmpty(analyzeKotlin(sourceIndex([{
      path: `src/followup/accepted/${fileName}.kt`,
      content,
    }])), label);
  }

  const rejectedCases = new Map([
    ["same-owner function/property collision", `package followup.collision
fun duplicate() = Unit
val duplicate = Unit
`],
    ["same-owner real-named overload pair", `package followup.overload
fun pick(value: Int) = value
fun pick(value: String) = value
`],
    ["same-named locals under sibling anonymous lambdas", `package followup.locals
fun consume(block: () -> Unit) = Unit
fun host() {
    consume { fun duplicate() = Unit }
    consume { fun duplicate() = Unit }
}
`],
  ]);
  for (const [label, content] of rejectedCases) {
    const fileName = label.replaceAll(/[^A-Za-z0-9]+/g, "-");
    assertRejectedEmpty(analyzeKotlin(sourceIndex([{
      path: `src/followup/rejected/${fileName}.kt`,
      content,
    }])), "ambiguous_index", label);
  }

  const expressionPath = "src/followup/clone/RelayPart.kt";
  assertCloneResponse(
    analyzeKotlin(sourceIndex([{ path: expressionPath, content: EXPRESSION_CLONE_SOURCE }])),
    "expression-component-clone",
    new Set([expressionPath]),
  );
  const blockPath = "src/followup/clone/TelemetryShard.kt";
  assertCloneResponse(
    analyzeKotlin(sourceIndex([{ path: blockPath, content: BLOCK_CLONE_SOURCE }])),
    "single-return-block-component-clone",
    new Set([blockPath]),
  );

  const psiIndexSource = fs.readFileSync(path.join(JAVA_ROOT, "PsiIndex.java"), "utf8");
  assert.equal([...psiIndexSource.matchAll(/named\.getName\(\) != null/g)].length, 1,
    "exactly one outer getName accounting guard survives");
  assert.equal([...psiIndexSource.matchAll(/named\.getNameIdentifier\(\) != null/g)].length, 2,
    "exactly two real-identifier admission/owner guards exist");
  assert.match(psiIndexSource,
    /if \(element instanceof KtNamedDeclaration named && named\.getName\(\) != null\) \{\s+if \(\+\+declarationCount > Main\.MAX_DECLARATIONS\) throw new SnapshotRejected\("limit"\);\s+if \(named\.getNameIdentifier\(\) != null\) \{\s+String key = declarationKey\(file, named\);\s+if \(declarations\.putIfAbsent\(key, source\.path\(\)\) != null\) \{\s+throw new SnapshotRejected\("ambiguous_index"\);\s+\}\s+\}\s+\}/,
    "declarationCount remains outside the nested ambiguity-map admission gate");
  assert.match(psiIndexSource,
    /if \(parent instanceof KtNamedDeclaration named && named\.getNameIdentifier\(\) != null\) \{\s+owners\.push\(named\.getName\(\)\);\s+\}/,
    "only real-identifier declarations enter owner keys");
  runSnapshotBoundaryProbe(t);
});
test("follow-up snapshot recognizes exact if and while condition containers", () => {
  const controls = new Map([
    ["if bare name", "if (flag) Unit"],
    ["if call expression", "if (ready()) Unit"],
    ["if binary", "if (flag && other) Unit"],
    ["if qualified", "if (holder.ready) Unit"],
    ["if parenthesized", "if ((flag)) Unit"],
    ["while bare name", "while (flag) { break }"],
    ["while call expression", "while (ready()) { break }"],
    ["while binary", "while (flag && other) { break }"],
    ["while qualified", "while (holder.ready) { break }"],
    ["while parenthesized", "while ((flag)) { break }"],
  ]);
  for (const [label, control] of controls) {
    const content = `package followup.conditions
class Holder(val ready: Boolean)
fun ready(): Boolean = true
fun probe(flag: Boolean, other: Boolean, holder: Holder) {
    ${control}
}
`;
    assertAcceptedEmpty(analyzeKotlin(sourceIndex([{
      path: `src/followup/conditions/${label.replaceAll(/[^A-Za-z0-9]+/g, "-")}.kt`,
      content,
    }])), label);
  }
});
test("follow-up minimally amended checkpoint stays accepted across the Batch 2B transition", (t) => {
  const projectDir = writeUncorrectedCheckpointProject(t);
  const index = loadSubmissionSources(projectDir);
  const kotlinPaths = index.files.filter((file) => file.kind === "kotlin").map((file) => file.path);
  assert.deepEqual(kotlinPaths, [
    "app/src/main/java/com/agentbench/gallery/GalleryBundle.kt",
    "app/src/main/java/com/agentbench/gallery/GalleryStage.kt",
    "app/src/main/java/com/agentbench/gallery/GalleryState.kt",
    "app/src/main/java/com/agentbench/gallery/Main.kt",
    "app/src/main/java/com/agentbench/gallery/Orbit.kt",
    "app/src/main/java/com/agentbench/gallery/PlaneSession.kt",
    "app/src/main/java/com/agentbench/gallery/platform/LaunchActivity.kt",
    "app/src/main/java/com/agentbench/gallery/platform/SpatialApplication.kt",
    "app/src/test/java/com/agentbench/gallery/GalleryStateTest.kt",
  ], "the minimally amended checkpoint retains its exact nine Kotlin paths");
  const source = (pathName) => {
    const matches = index.files.filter((file) => file.path === pathName);
    assert.equal(matches.length, 1, pathName);
    return matches[0].original;
  };
  const state = source("app/src/main/java/com/agentbench/gallery/GalleryState.kt");
  assert.equal(countOccurrences(state, "val instance: BenchmarkStore get() = retained"), 1,
    "standard strong property");
  assert.equal(/\bfun\s+instance\s*\(/.test(state), false, "dead standard function is absent");
  const main = source("app/src/main/java/com/agentbench/gallery/Main.kt");
  assert.equal(main.includes('store.select("vase")'), false, "raw shared read/write defect");
  assert.equal(countOccurrences(main, "closeAndReopen("), 1,
    "raw close/reopen helper remains unreachable because only its declaration exists");
  assert.equal(main.includes("navigator.closeAndReopen(store)"), false, "raw reopen call remains absent");
  const plane = source("app/src/main/java/com/agentbench/gallery/PlaneSession.kt");
  assert.equal(countOccurrences(plane, "repeat(MAX_ANCHOR_RETRIES)"), 1, "raw retry loop");
  assert.equal(countOccurrences(plane, "return@repeat"), 1, "raw retry defect");
  assert.deepEqual(UNCORRECTED_CHECKPOINT_EXPECTED_FALSE_RULE_IDS, [
    "state.shared-read-write",
    "state.reopen-wiring",
    "plane.retry-readiness",
  ]);

  const equivalent = loadSubmissionSources(writeEquivalentReopenProject(t));
  const equivalentStates = equivalent.files.filter((file) =>
    file.path === "app/src/main/java/com/agentbench/gallery/GalleryState.kt");
  assert.equal(equivalentStates.length, 1);
  assert.equal(countOccurrences(equivalentStates[0].original,
    "fun current(): GallerySessionRepository = retained"), 1,
    "equivalent current() function remains independently named");

  const domainSha256 = hash(fs.readFileSync(DOMAIN));
  const response = analyzeKotlin(index);
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  if (domainSha256 === FOLLOWUP_DOMAIN_SHA256) {
    assert.deepEqual(response.nodes, [], "follow-up domain produces no public witness nodes");
    assert.deepEqual(response.claims, [], "follow-up domain has no Batch 2B emitters");
  }
});
test("domain build boundary rejects malformed noncanonical and closed-schema tracked bytes before publication", (t) => {
  const replica = analyzerReplica(t);
  const domainPath = path.join(replica.analyzer, "domain-v1.json");
  const canonical = fs.readFileSync(domainPath);
  const parsed = JSON.parse(canonical);
  const beforeJar = fs.readFileSync(path.join(replica.artifact, "analyzer-v1.jar"));
  const beforeReceipt = fs.readFileSync(path.join(replica.artifact, "analyzer-build-receipt-v1.json"));
  const withUnknownKey = structuredClone(parsed); withUnknownKey.surprise = true;
  const missingField = structuredClone(parsed); delete missingField.witnessKinds;
  const invalidEnum = structuredClone(parsed); invalidEnum.symbols[0].kind = "mystery_constructor";
  const invalidRegistry = structuredClone(parsed); invalidRegistry.proofFormsByRule["ecs.component-clone"] = ["expression-component-clone"];
  const attacks = [
    ["malformed", Buffer.from("{")],
    ["noncanonical whitespace", Buffer.concat([Buffer.from(" "), canonical])],
    ["duplicate key", Buffer.from(canonical.toString("utf8").replace('"domainVersion":1', '"domainVersion":1,"domainVersion":1'))],
    ["unknown field", Buffer.from(canonicalJson(withUnknownKey))],
    ["missing field", Buffer.from(canonicalJson(missingField))],
    ["closed enum", Buffer.from(canonicalJson(invalidEnum))],
    ["registry mismatch", Buffer.from(canonicalJson(invalidRegistry))],
  ];
  for (const [label, bytes] of attacks) {
    fs.writeFileSync(domainPath, bytes);
    assert.notEqual(runScrubbedNode(replica.build, ["verify"]).status, 0, `${label} verify`);
    const rejected = runScrubbedNode(replica.build, ["clean-build-twice"]);
    assert.notEqual(rejected.status, 0, `${label} clean build`);
    assert.match(rejected.stderr, /domain|canonical|JSON|schema|vocabulary|key|kind/i, label);
    assert.deepEqual(fs.readFileSync(path.join(replica.artifact, "analyzer-v1.jar")), beforeJar, `${label} JAR publication`);
    assert.deepEqual(fs.readFileSync(path.join(replica.artifact, "analyzer-build-receipt-v1.json")), beforeReceipt, `${label} receipt publication`);
    fs.writeFileSync(domainPath, canonical);
    assert.equal(runScrubbedNode(replica.build, ["verify"]).status, 0, `${label} restored verify`);
  }
});
test("analyzer artifact semantic handoff inventory binds five sources, 29 entries, and actual class references", () => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const expectedInputs = [
    "benchmarks/spatial-agent-bench/analyzer/build-analyzer.mjs",
    "benchmarks/spatial-agent-bench/analyzer/dependencies-v1.json",
    "benchmarks/spatial-agent-bench/analyzer/domain-v1.json",
    ...EXPECTED_JAVA_SOURCES,
    "benchmarks/spatial-agent-bench/analyzer/toolchain-v1.json",
    "benchmarks/spatial-agent-bench/lib/kotlin-analysis.mjs",
  ].sort();
  assert.deepEqual(receipt.sourceInputs.map((row) => row.path), expectedInputs);
  assert.deepEqual(receipt.sourceInputs.filter((row) => row.path.endsWith(".java")).map((row) => row.path), EXPECTED_JAVA_SOURCES);
  for (const relative of EXPECTED_JAVA_SOURCES) assert.equal(fs.existsSync(path.join(ROOT, ...relative.split("/"))), true, relative);
  assert.deepEqual(receipt.build.jarEntries, EXPECTED_JAR_ENTRIES);
  assert.equal(Array.isArray(receipt.build.classReferences) && receipt.build.classReferences.length > 0, true);
  assert.deepEqual(receipt.build.classReferences, [...new Set(receipt.build.classReferences)].sort());
  assert.equal(hash(fs.readFileSync(path.join(JAVA_ROOT, "Protocol.java"))), "55adda83933f1c17a366689f5e311ef8f596a157f38ea33b1c8cd882e2bf1299");
});
test("semantic handoff fake accepts canonical witnesses and describe remains semantically empty", async (t) => {
  const scenario = { value: "semantic-valid" };
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, scenario, calls);
  const index = sourceIndex([{ path: "src/fake/Semantic.kt", content: SEMANTIC_FAKE_SOURCE }]);
  const first = bridge.analyzeKotlin(index);
  assertCloneResponse(first, "expression-component-clone", new Set(["src/fake/Semantic.kt"]));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.nodes[0]), true);
  assert.equal(Object.isFrozen(first.claims[0].witnessNodeIds), true);
  assertCloneResponse(bridge.analyzeKotlin(index), "expression-component-clone", new Set(["src/fake/Semantic.kt"]));
  assert.equal(calls.count, 1, "validated semantic bytes must be cacheable");
  scenario.value = "semantic-valid-mixed";
  const mixedPath = "src/fake/MixedSemantic.kt";
  const mixedSource = `${SEMANTIC_FAKE_SOURCE}\nfun literalBoundary(): Int = listOf(7).first()\n`;
  const mixed = bridge.analyzeKotlin(sourceIndex([{ path: mixedPath, content: mixedSource }]));
  assertCloneResponse(mixed, "expression-component-clone", new Set([mixedPath]));
  assert.equal(mixed.nodes.some((node) => node.structuralToken === true), true);
  const literal = mixed.nodes.find((node) => node.structuralToken === false && node.kind === "argument");
  assert.equal(literal !== undefined, true);
  assert.equal(mixedSource.slice(literal.startUtf16, literal.endUtf16), "7", "literal witness must be a real call-argument span");
  scenario.value = "describe-semantic";
  assert.throws(() => bridge.describeKotlinAnalyzer(), /describe|semantic|nodes/i);
  assert.equal(calls.count, 3);
});
test("semantic handoff validator rejects the full response node claim witness union and cache mutation matrix", async (t) => {
  const scenario = { value: "semantic-valid" };
  const calls = { count: 0 };
  const bridge = await copiedBridge(t, scenario, calls);
  const faults = [
    ["semantic-unknown-response-key", /unknown|missing.*key/i],
    ["semantic-rejected-nodes", /rejected|nodes|semantic/i],
    ["semantic-rejected-claims", /rejected|claims|semantic/i],
    ["semantic-unknown-node-key", /node.*key|unknown|missing/i],
    ["semantic-missing-node-key", /node.*key|unknown|missing/i],
    ["semantic-unknown-node-kind", /node.*kind|witness.*kind/i],
    ["semantic-path-unnormalized", /path/i],
    ["semantic-path-unknown", /path|request file/i],
    ["semantic-file-hash", /file.*hash|sha256/i],
    ["semantic-span-negative", /span|offset|start/i],
    ["semantic-span-reversed", /span|offset|end/i],
    ["semantic-span-out-of-bounds", /span|bound|offset/i],
    ["semantic-surrogate-start", /surrogate|boundary/i],
    ["semantic-surrogate-end", /surrogate|boundary/i],
    ["semantic-text-hash", /text.*hash|substring/i],
    ["semantic-node-id", /node.*id|digest/i],
    ["semantic-node-order", /node.*order|sorted/i],
    ["semantic-node-duplicate", /node.*duplicate|unique|order/i],
    ["semantic-node-over-limit", /node.*limit|node.*bound|too many/i],
    ["semantic-unknown-claim-key", /claim.*key|unknown|missing/i],
    ["semantic-missing-claim-key", /claim.*key|unknown|missing/i],
    ["semantic-unknown-rule", /rule/i],
    ["semantic-unknown-proof", /proof/i],
    ["semantic-duplicate-claim", /claim.*duplicate|one claim|order/i],
    ["semantic-claim-order", /claim.*order|rule.*order/i],
    ["semantic-claim-over-limit", /claim.*limit|claim.*bound|too many/i],
    ["semantic-empty-witness-empty-catalog", /witness|empty/i],
    ["semantic-empty-catalog", /catalog|witness|node/i],
    ["semantic-witness-order", /witness.*order|sorted/i],
    ["semantic-witness-duplicate", /witness.*duplicate|unique|order/i],
    ["semantic-witness-unknown", /witness|catalog|node/i],
    ["semantic-witness-digest", /witness.*digest/i],
    ["semantic-witness-over-limit", /witness.*limit|witness.*bound|too many/i],
    ["semantic-total-witness-over-limit", /total.*witness|witness.*limit|too many/i],
    ["semantic-literal-only", /literal|structural/i],
    ["semantic-nonstructural-nonargument", /nonstructural|literal|argument/i],
    ["semantic-structural-type", /structural.*boolean|structural.*type/i],
    ["semantic-union-orphan", /union|orphan|catalog/i],
    ["semantic-union-missing", /union|missing|catalog|witness/i],
  ];
  for (const [index, [fault, expected]] of faults.entries()) {
    const project = sourceIndex([{
      path: `src/fake/Mutation${String(index).padStart(2, "0")}.kt`,
      content: `${SEMANTIC_FAKE_SOURCE}\n// mutation ${index}\n`,
    }]);
    scenario.value = fault;
    assert.throws(() => bridge.analyzeKotlin(project), expected, fault);
    scenario.value = "semantic-valid";
    assertCloneResponse(bridge.analyzeKotlin(project), "expression-component-clone", new Set([project.files[0].path]));
  }
  assert.equal(calls.count, faults.length * 2, "invalid semantic bytes must never enter the cache");
});
test("semantic handoff real child proves expression and renamed block clone forms all-or-nothing", () => {
  const expressionPath = "src/canary/alpha/RelayPart.kt";
  const expression = analyzeKotlin(sourceIndex([{ path: expressionPath, content: EXPRESSION_CLONE_SOURCE }]));
  assertCloneResponse(expression, "expression-component-clone", new Set([expressionPath]));

  const blockPath = "moved/renamed/beta/TelemetryShard.kt";
  const block = analyzeKotlin(sourceIndex([{ path: blockPath, content: BLOCK_CLONE_SOURCE }]));
  assertCloneResponse(block, "single-return-block-component-clone", new Set([blockPath]));

  const expressionZero = analyzeKotlin(sourceIndex([{
    path: "src/canary/negative/RelayPart.kt",
    content: EXPRESSION_CLONE_SOURCE.replace("RelayPart(active, phase, label)", "RelayPart()"),
  }]));
  assert.equal(expressionZero.analysisStatus, "accepted");
  assert.deepEqual(expressionZero.nodes, []);
  assert.deepEqual(expressionZero.claims, []);

  const blockZero = analyzeKotlin(sourceIndex([{
    path: "moved/renamed/negative/TelemetryShard.kt",
    content: BLOCK_CLONE_SOURCE.replace("TelemetryShard(ready = ready, sweep = sweep)", "TelemetryShard()"),
  }]));
  assert.equal(blockZero.analysisStatus, "accepted");
  assert.deepEqual(blockZero.nodes, []);
  assert.deepEqual(blockZero.claims, []);

  const malformed = analyzeKotlin(sourceIndex([
    { path: expressionPath, content: EXPRESSION_CLONE_SOURCE },
    { path: "src/canary/Broken.kt", content: "package canary.broken\nfun broken( {\n" },
  ]));
  assert.equal(malformed.analysisStatus, "rejected");
  assert.equal(malformed.rejectionCode, "parse");
  assert.deepEqual(malformed.nodes, []);
  assert.deepEqual(malformed.claims, []);
});
test("semantic handoff clone canary rejects shadowed, parameterized, spread, and ineligible declarations", () => {
  const variants = new Map([
    ["class type parameter shadows imported Component", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "class RelayPart<Component>(")],
    ["clone type parameter shadows RelayPart", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone(): RelayPart", "override fun <RelayPart> clone(): RelayPart")],
    ["same-file Component typealias shadows import", EXPRESSION_CLONE_SOURCE
      .replace("import com.pico.spatial.core.ecs.Component\n", "import com.pico.spatial.core.ecs.Component\n\ntypealias Component = Substitute\n")],
    ["parameterized Component super call", EXPRESSION_CLONE_SOURCE
      .replace(": Component()", ": Component<String>()")],
    ["star-projected Component super call", EXPRESSION_CLONE_SOURCE
      .replace(": Component()", ": Component<*>()")],
    ["bare Component super type", EXPRESSION_CLONE_SOURCE
      .replace(": Component()", ": Component")],
    ["additional zero-argument super constructor", EXPRESSION_CLONE_SOURCE
      .replace("import com.pico.spatial.core.ecs.Component\n", "import com.pico.spatial.core.ecs.Component\n\nopen class Other\n")
      .replace(": Component()", ": Component(), Other()")],
    ["delegated super type", EXPRESSION_CLONE_SOURCE
      .replace("import com.pico.spatial.core.ecs.Component\n", "import com.pico.spatial.core.ecs.Component\n\ninterface Marker\nval marker = object : Marker {}\n")
      .replace(": Component()", ": Component(), Marker by marker")],
    ["parameterized clone return", EXPRESSION_CLONE_SOURCE
      .replace("clone(): RelayPart", "clone(): RelayPart<String>")],
    ["foreign qualified clone return", EXPRESSION_CLONE_SOURCE
      .replace("clone(): RelayPart", "clone(): foreign.RelayPart")],
    ["parameterized RelayPart constructor call", EXPRESSION_CLONE_SOURCE
      .replace("= RelayPart(active, phase, label)", "= RelayPart<String>(active, phase, label)")],
    ["star-projected RelayPart constructor call", EXPRESSION_CLONE_SOURCE
      .replace("= RelayPart(active, phase, label)", "= RelayPart<*>(active, phase, label)")],
    ["spread RelayPart constructor argument", EXPRESSION_CLONE_SOURCE
      .replace("RelayPart(active, phase, label)", "RelayPart(*active, phase, label)")],
    ["named spread RelayPart constructor argument", EXPRESSION_CLONE_SOURCE
      .replace("RelayPart(active, phase, label)", "RelayPart(active = *active, phase = phase, label = label)")],
    ["abstract candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "abstract class RelayPart(")],
    ["annotation candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "annotation class RelayPart(")],
    ["value candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "value class RelayPart(")],
    ["enum candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "enum class RelayPart(")
      .replace(") : Component() {", ") : Component() {\n    ;")],
    ["sealed candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "sealed class RelayPart(")],
    ["mutating initializer block", EXPRESSION_CLONE_SOURCE
      .replace(") : Component() {", ") : Component() {\n    init { active = !active }")],
    ["construction-time body property initializer", EXPRESSION_CLONE_SOURCE
      .replace(") : Component() {", ") : Component() {\n    val eager = phase.also { phase += 1 }")],
    ["construction-time delegated body property", EXPRESSION_CLONE_SOURCE
      .replace(") : Component() {", ") : Component() {\n    val eager by run { phase += 1; lazy { 0 } }")],
    ["context receiver on candidate class", EXPRESSION_CLONE_SOURCE
      .replace("class RelayPart(", "context(String)\nclass RelayPart(")],
    ["context receiver on clone", EXPRESSION_CLONE_SOURCE
      .replace("    override fun clone(): RelayPart", "    context(String)\n    override fun clone(): RelayPart")],
    ["suspend clone", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone()", "override suspend fun clone()")],
    ["private clone", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone()", "private override fun clone()")],
    ["protected clone", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone()", "protected override fun clone()")],
    ["internal clone", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone()", "internal override fun clone()")],
    ["local nested candidate exclusion", `package canary.alpha

import com.pico.spatial.core.ecs.Component

fun host() {
    class RelayPart(
        val active: Boolean = true,
        val phase: Int = 0,
        val label: String = "idle",
    ) : Component() {
        override fun clone(): RelayPart = RelayPart(active, phase, label)
    }
    fun competitor() {
        val RelayPart: (Boolean, Int, String) -> RelayPart = { active, phase, label ->
            RelayPart(active, phase, label)
        }
        RelayPart(true, 0, "ready")
    }
}`],
    ["wrong-labeled block return", EXPRESSION_CLONE_SOURCE
      .replace("override fun clone(): RelayPart = RelayPart(active, phase, label)",
        "override fun clone(): RelayPart {\n        return@wrong RelayPart(active, phase, label)\n    }")],
  ]);
  for (const [name, content] of variants) {
    const response = analyzeKotlin(sourceIndex([{ path: `src/canary/negative/${name.replace(/[^A-Za-z0-9]+/g, "-")}.kt`, content }]));
    assert.equal(response.analysisStatus, "accepted", name);
    assert.equal(response.rejectionCode, null, name);
    assert.deepEqual(response.nodes, [], name);
    assert.deepEqual(response.claims, [], name);
  }
});
test("semantic handoff real child accepts a complete default-package source without claims", () => {
  const response = analyzeKotlin(sourceIndex([{
    path: "src/defaultpkg/DefaultRoot.kt",
    content: DEFAULT_PACKAGE_SOURCE,
  }]));
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  assert.deepEqual(response.nodes, []);
  assert.deepEqual(response.claims, []);
});
test("semantic handoff real analyzer accepts the exact 8388608-byte trivia-heavy boundary", () => {
  const rows = Array.from({ length: 8 }, (_, index) => {
    const prefix = `package stress.trivia${index}\n`;
    return {
      path: `src/stress/Trivia${index}.kt`,
      content: `${prefix}//${"x".repeat(1_048_576 - Buffer.byteLength(prefix) - 3)}\n`,
    };
  });
  assert.equal(rows.every((row) => Buffer.byteLength(row.content) === 1_048_576), true);
  const index = sourceIndex(rows);
  assert.equal(index.totalBytes, 8_388_608);
  const response = analyzeKotlin(index);
  assert.equal(response.analysisStatus, "accepted");
  assert.equal(response.rejectionCode, null);
  assert.deepEqual(response.nodes, []);
  assert.deepEqual(response.claims, []);
});
test("semantic handoff CatalogProbe compiles only against the receipt-bound frozen snapshot API", (t) => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const temporary = temporaryDirectory(t, "agentbench-catalog-probe");
  const sourceRoot = path.join(temporary, "source");
  const classes = path.join(temporary, "classes");
  const home = path.join(temporary, "home");
  const temporaryFiles = path.join(temporary, "tmp");
  for (const directory of [sourceRoot, classes, home, temporaryFiles]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const catalogKotlin = `package catalog.matrix

import androidx.compose.runtime.Composable
import kotlin.String as Text

// catalog-trivia-line
/* catalog-trivia-block */
annotation class Marker(val name: String)
sealed interface SealedThing
open class Base
object Singleton

@Composable
fun composed() {
    targetLambda(1) { number -> number + 1 }
}

@Marker(name = "box")
data class Box<T>(
    val value: Int = 1,
    var text: Text = "idle",
) : Base(), Runnable {
    companion object { const val CONST: Int = 1 }
    override fun run() {}
    suspend fun suspending() = target()
    private fun hidden() {}
    fun body(arg: Int): Int {
        var local = arg
        local = local + 1
        local += 1
        val binary = local + 1
        val prefix = -binary
        local++
        val indexed = listOf<Int>(1)[0]
        val conditional = if (binary > 0) binary else 0
        val chosen = when (binary) {
            in 1..2 -> 1
            is Int -> 2
            else -> 0
        }
        try { target() } catch (error: Exception) { target() }
        outer@ for (item in listOf(1)) {
            if (item == 0) continue@outer else break@outer
        }
        while (local > 0) { local-- }
        do { local-- } while (local > 0)
        val callable = ::target
        val klass = Box::class
        val lambda: (Int) -> Int = { number -> number + 1 }
        val safe = text?.length
        val qualified = this.text.length
        val template = "value=$binary"
        val floating = 1.0f
        val truth = true
        val absent: Text? = null
        val fallback = absent ?: "fallback"
        val cast = text as Text
        val named = Box<Int>(value = 1, text = "named")
        val punctuation = 1; local = punctuation
        return target()
    }
}

fun target(): Int = 1
`;
  const probeSource = `package com.agentbench.analyzer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
public final class CatalogProbe {
  private static final String LIMIT_PACKAGE = "package limits\\n";
  private static final int PSI_LINE_COMMENTS = 249_996;
  private static final int DECLARATION_LIMIT = 25_000;
  private static final int CALL_MAX_ACCEPTED = 71_425;
  private static final int CALL_LIMIT = 100_000;
  private static final int MAXIMAL_COMMENTS = 149_996;
  private static final String CATALOG = ${JSON.stringify(catalogKotlin)};
  private static final String DEFAULT_PACKAGE = ${JSON.stringify(DEFAULT_PACKAGE_SOURCE)};
  private CatalogProbe() {}

  private static final class Digest {
    private final MessageDigest value;
    Digest(String domain) {
      try { value = MessageDigest.getInstance("SHA-256"); }
      catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
      add(domain);
    }
    void add(String field) {
      if (field == null) { addLength(-1); return; }
      byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
      addLength(bytes.length);
      value.update(bytes);
    }
    void add(int field) { add(Integer.toString(field)); }
    void add(boolean field) { add(Boolean.toString(field)); }
    private void addLength(int length) {
      value.update((byte) (length >>> 24)); value.update((byte) (length >>> 16));
      value.update((byte) (length >>> 8)); value.update((byte) length);
    }
    String finish() { return hex(value.digest()); }
  }

  private static String hex(byte[] bytes) {
    StringBuilder result = new StringBuilder(bytes.length * 2);
    for (byte item : bytes) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
    return result.toString();
  }

  private static String sha256(String value) {
    try {
      MessageDigest raw = MessageDigest.getInstance("SHA-256");
      return hex(raw.digest(value.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
  }

  private static PsiIndex.Source source(String path, String content) {
    return new PsiIndex.Source(path, sha256(content), content);
  }

  private static List<PsiIndex.Source> one(String path, String content) {
    return List.of(source(path, content));
  }

  private static String comments(int count) { return LIMIT_PACKAGE + "//\\n".repeat(count); }

  private static String declarations(int count, int comments) {
    StringBuilder content = new StringBuilder(LIMIT_PACKAGE.length() + count * 14 + comments * 3);
    content.append(LIMIT_PACKAGE);
    for (int index = 0; index < count; index++) content.append("val p").append(index).append("=0\\n");
    content.append("//\\n".repeat(comments));
    return content.toString();
  }

  private static String calls(int count) {
    StringBuilder content = new StringBuilder(LIMIT_PACKAGE.length() + 16 + count * 4);
    content.append(LIMIT_PACKAGE).append("fun host(){");
    for (int index = 0; index < count; index++) content.append("f();");
    return content.append("}\\n").toString();
  }

  private static int compareEdges(PsiIndex.Edge left, PsiIndex.Edge right) {
    int order = Integer.compare(left.fromNodeId(), right.fromNodeId());
    if (order == 0) order = Integer.compare(left.role().ordinal(), right.role().ordinal());
    if (order == 0) order = Integer.compare(left.ordinal(), right.ordinal());
    if (order == 0) order = Integer.compare(left.toNodeId(), right.toNodeId());
    return order;
  }

  private static <E extends Enum<E>> String observed(E[] values, Set<E> present) {
    StringBuilder result = new StringBuilder();
    for (E value : values) {
      if (!present.contains(value)) continue;
      if (result.length() != 0) result.append(',');
      result.append(value.name());
    }
    return result.toString();
  }

  private static String filesHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-files-v1");
    for (PsiIndex.FileUnit file : program.files()) {
      digest.add(file.id()); digest.add(file.path()); digest.add(file.sha256()); digest.add(file.utf16Length());
      digest.add(file.packageName()); digest.add(file.importIds().size());
      for (int id : file.importIds()) digest.add(id);
    }
    return digest.finish();
  }

  private static String importsHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-imports-v1");
    for (PsiIndex.ImportEntry entry : program.imports()) {
      digest.add(entry.id()); digest.add(entry.fileId()); digest.add(entry.fqName()); digest.add(entry.exposedName());
      digest.add(entry.alias()); digest.add(entry.syntaxNodeId()); digest.add(entry.witnessNodeId());
    }
    return digest.finish();
  }

  private static String tokensHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-tokens-v1");
    for (PsiIndex.Token token : program.tokens()) {
      digest.add(token.id()); digest.add(token.fileId()); digest.add(token.startUtf16()); digest.add(token.endUtf16());
      digest.add(token.kind().name()); digest.add(token.value()); digest.add(token.textSha256()); digest.add(token.structuralToken());
    }
    return digest.finish();
  }

  private static String nodesHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-nodes-v1");
    for (PsiIndex.Node node : program.nodes()) {
      digest.add(node.id()); digest.add(node.fileId()); digest.add(node.kind().name()); digest.add(node.startUtf16());
      digest.add(node.endUtf16()); digest.add(node.firstTokenId()); digest.add(node.tokenCount()); digest.add(node.name());
      digest.add(node.value()); digest.add(node.flags().size());
      for (PsiIndex.NodeFlag flag : node.flags()) digest.add(flag.name());
      digest.add(node.witnessNodeId());
    }
    return digest.finish();
  }

  private static String edgesHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-edges-v1");
    for (PsiIndex.Edge edge : program.edges()) {
      digest.add(edge.fromNodeId()); digest.add(edge.role().name()); digest.add(edge.ordinal()); digest.add(edge.toNodeId());
    }
    return digest.finish();
  }

  private static String witnessesHash(PsiIndex.Program program) {
    Digest digest = new Digest("catalog-witnesses-v1");
    for (PsiIndex.WitnessNode witness : program.witnesses()) {
      digest.add(witness.nodeId()); digest.add(witness.fileId()); digest.add(witness.startUtf16()); digest.add(witness.endUtf16());
      digest.add(witness.kind().name()); digest.add(witness.textSha256()); digest.add(witness.structuralToken());
    }
    return digest.finish();
  }

  private static String witnessIdentity(PsiIndex.WitnessNode witness, PsiIndex.FileUnit file) {
    String kind = witness.kind().name().toLowerCase(Locale.ROOT);
    String canonical = "{\\\"endUtf16\\\":" + witness.endUtf16()
        + ",\\\"fileSha256\\\":\\\"" + file.sha256() + "\\\",\\\"kind\\\":\\\"" + kind
        + "\\\",\\\"path\\\":\\\"" + file.path() + "\\\",\\\"startUtf16\\\":" + witness.startUtf16()
        + ",\\\"structuralToken\\\":" + witness.structuralToken()
        + ",\\\"textSha256\\\":\\\"" + witness.textSha256() + "\\\"}";
    return sha256(canonical);
  }

  private static int expectedFirstToken(PsiIndex.Program program, PsiIndex.Node node) {
    int index = 0;
    while (index < program.tokens().size()) {
      PsiIndex.Token token = program.tokens().get(index);
      if (token.fileId() > node.fileId() || (token.fileId() == node.fileId()
          && token.startUtf16() >= node.startUtf16())) break;
      index++;
    }
    return index;
  }

  private static String summarize(PsiIndex.Program program, List<PsiIndex.Source> sources) {
    int denseErrors = 0, hashErrors = 0, rangeErrors = 0, tokenSliceErrors = 0;
    int lexicalErrors = 0, edgeErrors = 0, importErrors = 0, witnessErrors = 0, triviaErrors = 0;
    EnumSet<PsiIndex.NodeKind> nodeKinds = EnumSet.noneOf(PsiIndex.NodeKind.class);
    EnumSet<PsiIndex.NodeFlag> nodeFlags = EnumSet.noneOf(PsiIndex.NodeFlag.class);
    EnumSet<PsiIndex.EdgeRole> edgeRoles = EnumSet.noneOf(PsiIndex.EdgeRole.class);
    EnumSet<PsiIndex.TokenKind> tokenKinds = EnumSet.noneOf(PsiIndex.TokenKind.class);
    EnumSet<PsiIndex.WitnessKind> witnessKinds = EnumSet.noneOf(PsiIndex.WitnessKind.class);
    TreeSet<String> operators = new TreeSet<>();
    Map<String, PsiIndex.Source> sourceByPath = new HashMap<>();
    for (PsiIndex.Source item : sources) sourceByPath.put(item.path(), item);
    int sourceBytes = 0, maxSourceBytes = 0;
    for (PsiIndex.Source item : sources) {
      int bytes = item.content().getBytes(StandardCharsets.UTF_8).length;
      sourceBytes += bytes; maxSourceBytes = Math.max(maxSourceBytes, bytes);
    }

    int expectedImport = 0;
    for (int index = 0; index < program.files().size(); index++) {
      PsiIndex.FileUnit file = program.files().get(index);
      PsiIndex.Source original = sourceByPath.get(file.path());
      if (file.id() != index) denseErrors++;
      if (original == null || !original.sha256().equals(file.sha256())
          || original.content().length() != file.utf16Length()) hashErrors++;
      for (int importId : file.importIds()) if (importId != expectedImport++) denseErrors++;
    }
    if (expectedImport != program.imports().size()) importErrors++;

    for (int index = 0; index < program.imports().size(); index++) {
      PsiIndex.ImportEntry entry = program.imports().get(index);
      if (entry.id() != index) denseErrors++;
      if (entry.fileId() < 0 || entry.fileId() >= program.files().size()
          || entry.syntaxNodeId() < 0 || entry.syntaxNodeId() >= program.nodes().size()) importErrors++;
      else {
        PsiIndex.Node syntax = program.nodes().get(entry.syntaxNodeId());
        if (syntax.fileId() != entry.fileId() || !entry.witnessNodeId().equals(syntax.witnessNodeId())) importErrors++;
      }
    }

    int priorFile = -1, priorEnd = -1;
    for (int index = 0; index < program.tokens().size(); index++) {
      PsiIndex.Token token = program.tokens().get(index);
      tokenKinds.add(token.kind());
      if (token.id() != index) denseErrors++;
      if (token.fileId() < 0 || token.fileId() >= program.files().size()) { rangeErrors++; continue; }
      PsiIndex.Source original = sourceByPath.get(program.files().get(token.fileId()).path());
      if (token.startUtf16() < 0 || token.endUtf16() <= token.startUtf16()
          || token.endUtf16() > original.content().length()) { rangeErrors++; continue; }
      String text = original.content().substring(token.startUtf16(), token.endUtf16());
      if (!text.equals(token.value()) || !sha256(text).equals(token.textSha256())) hashErrors++;
      boolean structural = token.kind() == PsiIndex.TokenKind.IDENTIFIER || token.kind() == PsiIndex.TokenKind.KEYWORD
          || token.kind() == PsiIndex.TokenKind.OPERATOR;
      if (structural != token.structuralToken()) hashErrors++;
      if (token.fileId() < priorFile || (token.fileId() == priorFile && token.startUtf16() < priorEnd)) rangeErrors++;
      priorFile = token.fileId(); priorEnd = token.endUtf16();
      if (token.value().isBlank() || token.value().contains("catalog-trivia")
          || (token.kind() != PsiIndex.TokenKind.OPERATOR && token.kind() != PsiIndex.TokenKind.STRING_LITERAL
          && Set.of("(", ")", "{", "}", "[", "]", ",", ":", ";", ".", "@").contains(token.value()))) triviaErrors++;
    }

    int[] fileRoots = new int[program.files().size()];
    int[] lexicalInbound = new int[program.nodes().size()];
    Set<String> nodeIdentities = new HashSet<>();
    for (int index = 0; index < program.nodes().size(); index++) {
      PsiIndex.Node node = program.nodes().get(index);
      nodeKinds.add(node.kind()); nodeFlags.addAll(node.flags());
      if (node.kind() == PsiIndex.NodeKind.ASSIGNMENT || node.kind() == PsiIndex.NodeKind.BINARY
          || node.kind() == PsiIndex.NodeKind.PREFIX || node.kind() == PsiIndex.NodeKind.POSTFIX) operators.add(node.value());
      if (node.id() != index) denseErrors++;
      if (node.fileId() < 0 || node.fileId() >= program.files().size()) { rangeErrors++; continue; }
      PsiIndex.FileUnit file = program.files().get(node.fileId());
      if (node.startUtf16() < 0 || node.endUtf16() < node.startUtf16() || node.endUtf16() > file.utf16Length()) rangeErrors++;
      if (!nodeIdentities.add(node.fileId() + ":" + node.startUtf16() + ":" + node.endUtf16() + ":" + node.kind())) denseErrors++;
      int first = expectedFirstToken(program, node), count = 0;
      while (first + count < program.tokens().size()) {
        PsiIndex.Token token = program.tokens().get(first + count);
        if (token.fileId() != node.fileId() || token.startUtf16() >= node.endUtf16()) break;
        if (token.startUtf16() < node.startUtf16() || token.endUtf16() > node.endUtf16()) tokenSliceErrors++;
        count++;
      }
      if (node.firstTokenId() != first || node.tokenCount() != count) tokenSliceErrors++;
      if (node.kind() == PsiIndex.NodeKind.FILE) fileRoots[node.fileId()]++;
    }
    for (int roots : fileRoots) if (roots != 1) lexicalErrors++;

    Map<String, Integer> nextOrdinal = new HashMap<>();
    PsiIndex.Edge prior = null;
    for (PsiIndex.Edge edge : program.edges()) {
      edgeRoles.add(edge.role());
      if (edge.fromNodeId() < 0 || edge.fromNodeId() >= program.nodes().size()
          || edge.toNodeId() < 0 || edge.toNodeId() >= program.nodes().size()) { edgeErrors++; continue; }
      if (prior != null && compareEdges(prior, edge) >= 0) edgeErrors++;
      PsiIndex.Node from = program.nodes().get(edge.fromNodeId()), to = program.nodes().get(edge.toNodeId());
      if (from.fileId() != to.fileId() || from.startUtf16() > to.startUtf16() || from.endUtf16() < to.endUtf16()) edgeErrors++;
      String slot = edge.fromNodeId() + ":" + edge.role();
      int expected = nextOrdinal.getOrDefault(slot, 0);
      if (edge.ordinal() != expected) edgeErrors++;
      nextOrdinal.put(slot, expected + 1);
      if (edge.role() == PsiIndex.EdgeRole.LEXICAL_OWNER) lexicalInbound[edge.toNodeId()]++;
      prior = edge;
    }
    for (PsiIndex.Node node : program.nodes()) {
      int expected = node.kind() == PsiIndex.NodeKind.FILE ? 0 : 1;
      if (lexicalInbound[node.id()] != expected) lexicalErrors++;
    }

    Set<String> witnessIds = new HashSet<>(), nodeWitnessIds = new HashSet<>();
    String priorWitness = null;
    for (PsiIndex.WitnessNode witness : program.witnesses()) {
      witnessKinds.add(witness.kind());
      if (!witnessIds.add(witness.nodeId()) || (priorWitness != null && priorWitness.compareTo(witness.nodeId()) >= 0)) witnessErrors++;
      if (witness.fileId() < 0 || witness.fileId() >= program.files().size()) { witnessErrors++; continue; }
      PsiIndex.FileUnit file = program.files().get(witness.fileId());
      PsiIndex.Source original = sourceByPath.get(file.path());
      if (witness.startUtf16() < 0 || witness.endUtf16() > original.content().length()
          || witness.endUtf16() <= witness.startUtf16()) { witnessErrors++; continue; }
      String text = original.content().substring(witness.startUtf16(), witness.endUtf16());
      if (!sha256(text).equals(witness.textSha256()) || !witnessIdentity(witness, file).equals(witness.nodeId())) witnessErrors++;
      if (!witness.structuralToken() && witness.kind() != PsiIndex.WitnessKind.ARGUMENT) witnessErrors++;
      priorWitness = witness.nodeId();
    }
    for (PsiIndex.Node node : program.nodes()) if (node.witnessNodeId() != null) {
      if (!nodeWitnessIds.add(node.witnessNodeId()) || !witnessIds.contains(node.witnessNodeId())) witnessErrors++;
    }
    if (!nodeWitnessIds.equals(witnessIds)) witnessErrors++;

    String filesHash = filesHash(program), importsHash = importsHash(program), tokensHash = tokensHash(program);
    String nodesHash = nodesHash(program), edgesHash = edgesHash(program), witnessesHash = witnessesHash(program);
    Digest whole = new Digest("catalog-program-v1");
    whole.add(program.psiNodeCount()); whole.add(program.declarationCount()); whole.add(program.callSiteCount());
    whole.add(filesHash); whole.add(importsHash); whole.add(tokensHash); whole.add(nodesHash); whole.add(edgesHash); whole.add(witnessesHash);
    StringBuilder importSummary = new StringBuilder();
    for (PsiIndex.ImportEntry entry : program.imports()) {
      if (importSummary.length() != 0) importSummary.append(';');
      importSummary.append(entry.fqName());
      if (entry.alias() != null) importSummary.append(" as ").append(entry.alias());
      importSummary.append("->").append(entry.exposedName());
    }
    List<String> rows = new ArrayList<>();
    rows.add("status=accepted"); rows.add("psi=" + program.psiNodeCount());
    rows.add("declarations=" + program.declarationCount()); rows.add("calls=" + program.callSiteCount());
    rows.add("files=" + program.files().size()); rows.add("imports=" + program.imports().size());
    rows.add("tokens=" + program.tokens().size()); rows.add("nodes=" + program.nodes().size());
    rows.add("edges=" + program.edges().size()); rows.add("witnesses=" + program.witnesses().size());
    rows.add("sourceFiles=" + sources.size()); rows.add("maxSourceBytes=" + maxSourceBytes); rows.add("sourceBytes=" + sourceBytes);
    rows.add("nodeKinds=" + observed(PsiIndex.NodeKind.values(), nodeKinds));
    rows.add("nodeFlags=" + observed(PsiIndex.NodeFlag.values(), nodeFlags));
    rows.add("edgeRoles=" + observed(PsiIndex.EdgeRole.values(), edgeRoles));
    rows.add("tokenKinds=" + observed(PsiIndex.TokenKind.values(), tokenKinds));
    rows.add("witnessKinds=" + observed(PsiIndex.WitnessKind.values(), witnessKinds));
    rows.add("operatorValues=" + String.join(",", operators)); rows.add("importSummary=" + importSummary);
    rows.add("closureDense=" + denseErrors); rows.add("closureHash=" + hashErrors); rows.add("closureRange=" + rangeErrors);
    rows.add("closureTokenSlice=" + tokenSliceErrors); rows.add("closureLexical=" + lexicalErrors);
    rows.add("closureEdge=" + edgeErrors); rows.add("closureImport=" + importErrors);
    rows.add("closureWitness=" + witnessErrors); rows.add("closureTrivia=" + triviaErrors);
    rows.add("filesSha256=" + filesHash); rows.add("importsSha256=" + importsHash); rows.add("tokensSha256=" + tokensHash);
    rows.add("nodesSha256=" + nodesHash); rows.add("edgesSha256=" + edgesHash); rows.add("witnessesSha256=" + witnessesHash);
    rows.add("programSha256=" + whole.finish());
    return String.join("\\n", rows);
  }

  private static void accepted(String path, String content) {
    List<PsiIndex.Source> sources = one(path, content);
    System.out.print(summarize(PsiIndex.snapshot(sources), sources));
  }

  private static void defaultPackage() {
    List<PsiIndex.Source> sources = one("src/defaultpkg/DefaultRoot.kt", DEFAULT_PACKAGE);
    PsiIndex.Program program = PsiIndex.snapshot(sources);
    if (program.files().size() != 1) throw new IllegalStateException("one default-package file required");
    System.out.print(summarize(program, sources) + "\\npackageName=" + program.files().get(0).packageName());
  }

  private static void rejected(String path, String content) {
    try {
      PsiIndex.snapshot(one(path, content));
      System.out.print("status=unexpected-acceptance");
    } catch (PsiIndex.SnapshotRejected rejected) {
      System.out.print("status=rejected\\ncode=" + rejected.rejectionCode());
    }
  }

  public static void main(String[] args) {
    if (args.length != 1) throw new IllegalArgumentException("one mode required");
    switch (args[0]) {
      case "catalog" -> accepted("src/catalog/Matrix.kt", CATALOG);
      case "default-package" -> defaultPackage();
      case "psi-n" -> accepted("src/limits/Psi.kt", comments(PSI_LINE_COMMENTS));
      case "psi-n-plus-one" -> rejected("src/limits/Psi.kt", comments(PSI_LINE_COMMENTS) + "/*x*/");
      case "declarations-n" -> accepted("src/limits/Declarations.kt", declarations(DECLARATION_LIMIT, 0));
      case "declarations-n-plus-one" -> rejected("src/limits/Declarations.kt", declarations(DECLARATION_LIMIT + 1, 0));
      case "calls-0" -> accepted("src/limits/Calls.kt", calls(0));
      case "calls-1" -> accepted("src/limits/Calls.kt", calls(1));
      case "calls-2" -> accepted("src/limits/Calls.kt", calls(2));
      case "calls-max" -> accepted("src/limits/Calls.kt", calls(CALL_MAX_ACCEPTED));
      case "calls-max-plus-one" -> rejected("src/limits/Calls.kt", calls(CALL_MAX_ACCEPTED + 1));
      case "calls-limit" -> rejected("src/limits/Calls.kt", calls(CALL_LIMIT));
      case "maximal" -> accepted("src/limits/Maximal.kt", declarations(DECLARATION_LIMIT, MAXIMAL_COMMENTS));
      case "maximal-plus-one" -> rejected("src/limits/Maximal.kt", declarations(DECLARATION_LIMIT, MAXIMAL_COMMENTS) + "/*x*/");
      default -> throw new IllegalArgumentException("unknown mode");
    }
  }
}
`;
  const psiIndexSource = fs.readFileSync(path.join(JAVA_ROOT, "PsiIndex.java"), "utf8");
  for (const [label, snippet] of [
    ["Program constructor validates copied catalogs", `            validateProgram(psiNodeCount, declarationCount, callSiteCount,
                files, imports, tokens, nodes, edges, witnesses);`],
    ["PSI count covers every value catalog", `        if (psiNodeCount < nodes.size() || psiNodeCount < tokens.size() || psiNodeCount < witnesses.size()) {
            throw new IllegalArgumentException("program catalogs exceed the PSI count");
        }`],
    ["call and declaration counters cover normalized catalogs", `        if (representedCalls != callSiteCount || representedDeclarations > declarationCount) {
            throw new IllegalArgumentException("program counters do not cover the normalized catalogs");
        }`],
    ["every file has exactly one root", `        for (int roots : fileRoots) if (roots != 1) throw new IllegalArgumentException("file root closure is invalid");`],
  ]) assert.equal(psiIndexSource.includes(snippet), true, label);
  for (const type of ["FileUnit", "ImportEntry", "Token", "Node", "Edge", "WitnessNode", "Program"]) {
    assert.equal(probeSource.includes(`new PsiIndex.${type}(`), false, `CatalogProbe must not construct ${type}`);
  }
  const probePath = path.join(sourceRoot, "com/agentbench/analyzer/CatalogProbe.java");
  fs.mkdirSync(path.dirname(probePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probePath, probeSource);
  const classpath = receipt.classpath.map((entry) => path.join(receipt.artifactRoot, ...entry.path.split("/"))).join(path.delimiter);
  const environment = { JAVA_HOME: receipt.jdk.root, HOME: home, TMPDIR: temporaryFiles, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  const compiled = spawnSync(path.join(receipt.jdk.root, "bin/javac"), [
    `-J-Duser.home=${home}`, `-J-Djava.io.tmpdir=${temporaryFiles}`, "--release", "17", "-encoding", "UTF-8",
    "-g:none", "-proc:none", "-classpath", classpath, "-d", classes, probePath,
  ], { cwd: sourceRoot, env: environment, shell: false, encoding: "utf8", maxBuffer: 4_194_304 });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(compiled.stdout, "");
  assert.equal(compiled.stderr, "");
  const baseRuntimeArgs = receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${temporaryFiles}`));
  const cpIndex = baseRuntimeArgs.indexOf("-cp");
  baseRuntimeArgs[cpIndex + 1] = `${classes}${path.delimiter}${classpath}`;
  const mainIndex = baseRuntimeArgs.indexOf("com.agentbench.analyzer.Main");
  baseRuntimeArgs[mainIndex] = "com.agentbench.analyzer.CatalogProbe";
  function run(mode) {
    const runtimeArgs = [...baseRuntimeArgs];
    runtimeArgs[mainIndex + 1] = mode;
    const executed = spawnSync(receipt.launch.java, runtimeArgs, {
      cwd: temporary, env: environment, shell: false, encoding: "utf8", timeout: 30_000, maxBuffer: 4_194_304,
    });
    assert.equal(executed.status, 0, `${mode}: ${executed.stderr}`);
    assert.equal(executed.stderr, "", mode);
    return executed.stdout;
  }
  function stable(mode) {
    const first = run(mode);
    assert.equal(run(mode), first, `${mode} must be deterministic across fresh production-heap processes`);
    return first;
  }
  const defaultPackageRaw = stable("default-package");
  const results = {
    catalog: stable("catalog"),
    psiN: run("psi-n"),
    psiNPlusOne: run("psi-n-plus-one"),
    declarationsN: run("declarations-n"),
    declarationsNPlusOne: run("declarations-n-plus-one"),
    calls0: run("calls-0"),
    calls1: run("calls-1"),
    calls2: run("calls-2"),
    callsMax: run("calls-max"),
    callsMaxPlusOne: run("calls-max-plus-one"),
    callsLimit: run("calls-limit"),
    maximal: stable("maximal"),
    maximalPlusOne: run("maximal-plus-one"),
  };
  const fullNodeKinds = "FILE,CLASS_DECL,INTERFACE_DECL,OBJECT_DECL,COMPANION_DECL,FUNCTION_DECL,PROPERTY_DECL,PARAMETER_DECL,TYPE_REF,BLOCK,CALL,ARGUMENT,NAME_REF,THIS_REF,QUALIFIED,SAFE_QUALIFIED,CALLABLE_REF,CLASS_LITERAL,LAMBDA,ASSIGNMENT,BINARY,PREFIX,POSTFIX,INDEX_ACCESS,IF,WHEN,WHEN_ENTRY,TRY,CATCH,RETURN,BREAK,CONTINUE,FOR,WHILE,ANNOTATION,STRING_TEMPLATE,LITERAL";
  const fullNodeFlags = "DATA,SEALED,CONST,VAL,VAR,SUSPEND,OVERRIDE,PRIVATE,EXPRESSION_BODY,NAMED,SAFE,LABELED";
  const fullEdgeRoles = "FILE_MEMBER,LEXICAL_OWNER,RECEIVER,CALLEE,ARGUMENT,TYPE_ARGUMENT,PARAMETER,TYPE,ANNOTATION,SUPER_TYPE,DEFAULT_VALUE,INITIALIZER,BODY,CONDITION,THEN_BRANCH,ELSE_BRANCH,SUBJECT,ENTRY,LEFT,RIGHT,OPERAND,TARGET,VALUE,SELECTOR,INDEX,RANGE,LOOP_BODY,TRY_BODY,CATCH_CLAUSE,CATCH_BODY,RETURN_VALUE,LAMBDA_BODY,STRING_EXPRESSION";
  const fullTokenKinds = "IDENTIFIER,KEYWORD,OPERATOR,STRING_LITERAL,INTEGER_LITERAL,FLOAT_LITERAL,BOOLEAN_LITERAL,NULL_LITERAL";
  const fullWitnessKinds = "DECLARATION,CALLABLE_REFERENCE,CALL,ARGUMENT,PROPERTY_READ,ASSIGNMENT,CONDITION,LOOP,LAMBDA,RETURN,TYPE_REFERENCE,CATCH";
  const acceptedKeys = [
    "status", "psi", "declarations", "calls", "files", "imports", "tokens", "nodes", "edges", "witnesses",
    "sourceFiles", "maxSourceBytes", "sourceBytes", "nodeKinds", "nodeFlags", "edgeRoles", "tokenKinds",
    "witnessKinds", "operatorValues", "importSummary", "closureDense", "closureHash", "closureRange",
    "closureTokenSlice", "closureLexical", "closureEdge", "closureImport", "closureWitness", "closureTrivia",
    "filesSha256", "importsSha256", "tokensSha256", "nodesSha256", "edgesSha256", "witnessesSha256", "programSha256",
  ];
  function summary(value) {
    return Object.fromEntries(value.split("\n").map((row) => {
      const separator = row.indexOf("=");
      return [row.slice(0, separator), row.slice(separator + 1)];
    }));
  }
  const evidenceKeys = [
    "psi", "declarations", "calls", "files", "imports", "tokens", "nodes", "edges", "witnesses",
    "sourceFiles", "maxSourceBytes", "sourceBytes", "filesSha256", "importsSha256", "tokensSha256",
    "nodesSha256", "edgesSha256", "witnessesSha256", "programSha256",
  ];
  const measuredEvidence = {
    catalog: ["1017", "45", "8", "1", "2", "279", "236", "400", "132", "1", "1788", "1788", "35b425dc2a25af007dc253ab3a5e09f24203a4941c6ad6a7ab5cd970ee1caad9", "d9d745f7254c2cb0335c5942b495d34f2bcaa4b455b2c37b8428334dceb7005d", "1f061cb0fdc9863d602aa33f1fdf2f6f62492c613c3b76a494048331a24ce954", "033031403a3b76e11ba1f5f9b7a605c44d9d6456ddc1d3e54fbcac94124c721f", "ffd742d914f70f48096d297a9b3215fcd978db7536f63660b40563673afaabb9", "b70c52856f94dae1606095538fa53585d3ef673859ec5abe6f3306f32f0fdc0c", "553a2f2b28f332c7c9496fb394a9103b0e3e1cd811c771ca6eeffa515ef3e769"],
    psiN: ["500000", "0", "0", "1", "0", "2", "2", "1", "0", "1", "750003", "750003", "f8a8e567964e62f984e013d9460aad5065f4f1f8602fa024e041f5b6d80ef5f7", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "96ef13cffa319a66e584668d9cad67a1bba61cc89272c1fa46468dbcd31edd5e", "7303de69faee7dc68d9e96df2948f95b8d8ae508e684a6838644befcfb9bdbb1", "4e3a7b263a1823de738f9f6641261ec18a5f522aa5844b4f6714f089813c74f4", "d027b03b45b6d74e333138bff712d9ae956fea7b06f5e5b389207cf0e259b98c", "2e846a087a8c8a465154097485d5aa8c1413c7e5ae6bd231a18da53b83e20122"],
    declarationsN: ["200008", "25000", "0", "1", "0", "100002", "50002", "100001", "25000", "1", "313905", "313905", "7d3f06282cef2d78fd72e8abfa35540b2dc510020d2557e4625aa3660994f64f", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "21fae2c686cf27e7dec3a8f324f643426724b3feb573192181a26d2bc6b0cce3", "0cf3d417dd39a665d4f626fa80c5de07af566bdd2feeff9b2c759446fb776422", "dee1d9371f36eae9e184d12f6c40a41261d3ce2864cc15ff7fe548af312a4aa4", "2b32c6dabdc0935cf27080b5efbe0e77cc418a60c1b3f6ec86f1edb01b1c7bc7", "142f9c2c7854025e12ca9ecd32a9aec415a0cf096f53e7100fa18105a3ff2a07"],
    calls0: ["19", "1", "0", "1", "0", "4", "4", "5", "1", "1", "28", "28", "a8498f01b2f5bbf87a3e64a5893cd69e4ef6d8a020c1b2af28ec82926f63fca2", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "c1b757e3dcaab87b19f2223e0010b833d2ad0c8d287e2a2c4b5fa18b98342b5e", "4e014270700d35a15a7d1dba3faa0161bc7ec03021e87121aeec8db342ce12e2", "1e24cdb0611630ca9e692baced346bbb4857a38e6f30c7608656d4c6d0a834a8", "a3f84d1106d492fb586bebd50ff191474435f069a7d800adf4bc718b36a05d7b", "66b35eba2b809fd53241f90dd2802c6d7cbdabd04298804ffc1f82396100969e"],
    calls1: ["26", "1", "1", "1", "0", "5", "6", "8", "3", "1", "32", "32", "be091fa6d3b975857627390a44daf62d8f70f6baf5ce72c92254150a619ef99b", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "925ec2f55dce5cf7c09ebaf9c4bfa1989e73b36579b692be392407366fca99dc", "0963f516745bb40d08ee77f938d9a3cad2cecc6d353f79d0e8fc907d58011bc0", "0a8f4e85a903357a40bc539b31a6bf80016ff75075d5c7b14b1d85e525e57494", "e5f5dbf6511068dcba3391e7bb46c81d1d40220d92c4610c026213deecbd7a0c", "bdddf54634c8cbf428ae31092bc367a9293c06a15f1e0c504dc1efa60bb498b5"],
    calls2: ["33", "1", "2", "1", "0", "6", "8", "11", "5", "1", "36", "36", "3f9a42ed8b4048b186b4d528f649a0090bc4687532a75d9c1d5e5a921ab4ce0c", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "a472a49023246d29807e2eaca70b980ce28f7046daa9ff1666070e9bb9597171", "44f9e67db24314f384c33f26ba383031c5752668a46a4f21588f7b6232ebb9a3", "548740838dec9f4ed38fdcc7ef60841af69fe7a3ed46064f432bc852b4f91321", "38662cac6d000dc4b5d2927e9733c7e3a041450098dfd36a2265758ec3be9741", "bc483606cf0bc923ebbe956bc1dc5cdc06060d251272a1a79c8cfda7d1579445"],
    callsMax: ["499994", "1", "71425", "1", "0", "71429", "142854", "214280", "142851", "1", "285728", "285728", "d6937eec49ed6091c880d255eacf1cf3dc81fcc16bf09c48e4557df83d280e2a", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "7f55238e6d51c2ffc9fca22d1cb2c160ff15f5a07adc0e5e279f509537780231", "197ed3fcbaf02a39e33a87aede1532e3865d1b1039b102c09b0b47453ffdcfbb", "537ef41bc32466ccc9ded5438a442437c97cbca0aedbf50aa29ce475eafd0b78", "d3a5dfb8b0fbe5c05e76cd387c95ffd5712f28ba2eb0f2a593ac482c813487d0", "aedae1f34106ec10e589670b8bcabb812b7807fc33afc3f9a258c1dc17ed9fed"],
    maximal: ["500000", "25000", "0", "1", "0", "100002", "50002", "100001", "25000", "1", "763893", "763893", "b8734d5ae103a29390eff496709d64e63ac85a3b3852d1258257ea38f366288d", "3eefab590936f65659f83edf8d10bfd45f2582ff89d3eafb354903d24c0fa988", "21fae2c686cf27e7dec3a8f324f643426724b3feb573192181a26d2bc6b0cce3", "fc5deab0da19bac91dcb8982b0d1cf69bd7b295e0ed8acacc32ba45e24496d17", "dee1d9371f36eae9e184d12f6c40a41261d3ce2864cc15ff7fe548af312a4aa4", "37abece485ac4ade0f14ece5b452b997d86b689174f676f9353c2a48a1a37318", "5e8c3f7684d60ff05aaacc08a195733e6f6062d50cd4f20b19838c473a39ff3c"],
  };
  for (const [label, value] of Object.entries(results)) {
    if (!value.startsWith("status=accepted")) continue;
    const item = summary(value);
    assert.deepEqual(Object.keys(item), acceptedKeys, `${label} exact summary keys/order`);
    for (const key of ["closureDense", "closureHash", "closureRange", "closureTokenSlice", "closureLexical",
      "closureEdge", "closureImport", "closureWitness", "closureTrivia"]) assert.equal(item[key], "0", `${label} ${key}`);
    assert.equal(Number(item.sourceFiles) <= ANALYZER_CONSTANTS.MAX_KOTLIN_FILES, true, `${label} files envelope`);
    assert.equal(Number(item.maxSourceBytes) <= ANALYZER_CONSTANTS.MAX_KOTLIN_FILE_BYTES, true, `${label} file-byte envelope`);
    assert.equal(Number(item.sourceBytes) <= ANALYZER_CONSTANTS.MAX_KOTLIN_TOTAL_BYTES, true, `${label} total-byte envelope`);
    for (const key of ["filesSha256", "importsSha256", "tokensSha256", "nodesSha256", "edgesSha256", "witnessesSha256", "programSha256"]) {
      assert.match(item[key], /^[a-f0-9]{64}$/, `${label} ${key}`);
    }
    assert.deepEqual(evidenceKeys.map((key) => item[key]), measuredEvidence[label], `${label} exact measured evidence`);
  }
  const catalog = summary(results.catalog);
  assert.equal(catalog.nodeKinds, fullNodeKinds);
  assert.equal(catalog.nodeFlags, fullNodeFlags);
  assert.equal(catalog.edgeRoles, fullEdgeRoles);
  assert.equal(catalog.tokenKinds, fullTokenKinds);
  assert.equal(catalog.witnessKinds, fullWitnessKinds);
  assert.equal(catalog.importSummary, "androidx.compose.runtime.Composable->Composable;kotlin.String as Text->Text");
  assert.equal(catalog.operatorValues, "+,++,+=,-,--,..,=,==,>,?:,as");
  const defaultPackage = summary(defaultPackageRaw);
  assert.equal(defaultPackage.status, "accepted");
  assert.equal(defaultPackage.packageName, "");
  assert.equal(defaultPackage.files, "1");
  assert.equal(Number(defaultPackage.nodes) > 0, true);
  assert.equal(defaultPackage.nodeKinds.split(",").includes("FILE"), true);
  for (const key of ["closureDense", "closureHash", "closureRange", "closureTokenSlice", "closureLexical",
    "closureEdge", "closureImport", "closureWitness", "closureTrivia"]) assert.equal(defaultPackage[key], "0", `default-package ${key}`);
  const calls0 = summary(results.calls0);
  const calls1 = summary(results.calls1);
  const calls2 = summary(results.calls2);
  assert.equal(Number(calls1.psi) - Number(calls0.psi), 7, "one fixed f(); row has seven measured PSI rows");
  assert.equal(Number(calls2.psi) - Number(calls1.psi), 7, "minimal-call PSI delta is deterministic");
  assert.equal(Number(calls1.calls) - Number(calls0.calls), 1);
  assert.equal(Number(calls2.calls) - Number(calls1.calls), 1);
  assert.equal(Number(calls1.declarations), 1);
  assert.equal(Number(calls2.declarations), 1);
  assert.equal(71_425 < ANALYZER_CONSTANTS.MAX_CALL_SITES, true);
  assert.equal(ANALYZER_CONSTANTS.MAX_CALL_SITES * 6 > ANALYZER_CONSTANTS.MAX_PSI_NODES, true,
    "each minimal f() has disjoint CALL, callee, argument-list, identifier, and two parenthesis PSI rows");
  assert.equal(Number(summary(results.callsMax).psi) + 7, ANALYZER_CONSTANTS.MAX_PSI_NODES + 1,
    "the next minimal call reaches the dominating PSI boundary first");
  assert.equal(71_426 < ANALYZER_CONSTANTS.MAX_CALL_SITES, true, "call counter is structurally shadowed");
  assert.equal(results.psiNPlusOne, "status=rejected\ncode=limit");
  assert.equal(results.declarationsNPlusOne, "status=rejected\ncode=limit");
  assert.equal(results.callsMaxPlusOne, "status=rejected\ncode=limit");
  assert.equal(results.callsLimit, "status=rejected\ncode=limit");
  assert.equal(results.maximalPlusOne, "status=rejected\ncode=limit");
  fs.rmSync(temporary, { recursive: true, force: true });
  assert.equal(fs.existsSync(probePath), false, "CatalogProbe.java residue");
  assert.equal(fs.existsSync(path.join(classes, "com/agentbench/analyzer/CatalogProbe.class")), false, "CatalogProbe.class residue");
});
test("semantic handoff Program rejects a copied import with a missing witness", (t) => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const temporary = temporaryDirectory(t, "agentbench-import-witness-probe");
  const sourceRoot = path.join(temporary, "source");
  const classes = path.join(temporary, "classes");
  const home = path.join(temporary, "home");
  const temporaryFiles = path.join(temporary, "tmp");
  const probeClass = "com.agentbench.analyzer.ImportWitnessClosureProbe";
  const probeEntry = "com/agentbench/analyzer/ImportWitnessClosureProbe.class";
  const probePath = path.join(sourceRoot, "com/agentbench/analyzer/ImportWitnessClosureProbe.java");
  const compiledProbe = path.join(classes, probeEntry);
  const artifactBefore = fs.readFileSync(ARTIFACT);
  assert.equal(receipt.sourceInputs.some((row) => row.path.endsWith("/ImportWitnessClosureProbe.java")), false,
    "temporary import witness probe source must not be an analyzer input");
  assert.equal(receipt.build.jarEntries.includes(probeEntry), false,
    "temporary import witness probe class must not be an analyzer JAR entry");
  for (const directory of [sourceRoot, classes, home, temporaryFiles]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const importedKotlin = `package witness.closure

import kotlin.String

class ImportedRoot(val name: String)
`;
  const probeSource = `package com.agentbench.analyzer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

public final class ImportWitnessClosureProbe {
  private static final String SOURCE = ${JSON.stringify(importedKotlin)};

  private ImportWitnessClosureProbe() {}

  private static String sha256(String value) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder result = new StringBuilder(digest.length * 2);
      for (byte item : digest) result.append(String.format("%02x", item & 0xff));
      return result.toString();
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException(error);
    }
  }

  public static void main(String[] arguments) {
    PsiIndex.Source source = new PsiIndex.Source("src/witness/ImportedRoot.kt", sha256(SOURCE), SOURCE);
    PsiIndex.Program original = PsiIndex.snapshot(List.of(source));
    if (original.imports().size() != 1) throw new AssertionError("expected exactly one valid import");
    PsiIndex.ImportEntry imported = original.imports().get(0);
    if (imported.witnessNodeId() == null) throw new AssertionError("snapshot omitted the valid import witness");
    ArrayList<PsiIndex.ImportEntry> malformedImports = new ArrayList<>(original.imports());
    malformedImports.set(imported.id(), new PsiIndex.ImportEntry(
        imported.id(), imported.fileId(), imported.fqName(), imported.exposedName(), imported.alias(),
        imported.syntaxNodeId(), null));
    try {
      new PsiIndex.Program(
          original.psiNodeCount(), original.declarationCount(), original.callSiteCount(),
          original.files(), malformedImports, original.tokens(), original.nodes(), original.edges(),
          original.witnesses());
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError("Program accepted an import whose witnessNodeId is null");
  }
}
`;
  fs.mkdirSync(path.dirname(probePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probePath, probeSource, { encoding: "utf8", mode: 0o600 });
  const classpath = receipt.classpath.map((entry) => path.join(receipt.artifactRoot, ...entry.path.split("/"))).join(path.delimiter);
  const environment = { JAVA_HOME: receipt.jdk.root, HOME: home, TMPDIR: temporaryFiles, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  const compiled = spawnSync(path.join(receipt.jdk.root, "bin/javac"), [
    `-J-Duser.home=${home}`, `-J-Djava.io.tmpdir=${temporaryFiles}`, "--release", "17", "-encoding", "UTF-8",
    "-g:none", "-proc:none", "-classpath", classpath, "-d", classes, probePath,
  ], { cwd: sourceRoot, env: environment, shell: false, encoding: "utf8", maxBuffer: 4_194_304 });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(compiled.stdout, "");
  assert.equal(compiled.stderr, "");
  const runtimeArgs = receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${temporaryFiles}`));
  const cpIndex = runtimeArgs.indexOf("-cp");
  runtimeArgs[cpIndex + 1] = `${classes}${path.delimiter}${classpath}`;
  const mainIndex = runtimeArgs.indexOf("com.agentbench.analyzer.Main");
  runtimeArgs.splice(mainIndex, runtimeArgs.length - mainIndex, probeClass);
  const executed = spawnSync(receipt.launch.java, runtimeArgs, {
    cwd: temporary, env: environment, shell: false, encoding: "utf8", timeout: 30_000, maxBuffer: 4_194_304,
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stdout, "");
  assert.equal(executed.stderr, "");
  assert.deepEqual(fs.readFileSync(ARTIFACT), artifactBefore, "temporary probe must not mutate the analyzer artifact");
  fs.rmSync(temporary, { recursive: true, force: true });
  assert.equal(fs.existsSync(probePath), false, "ImportWitnessClosureProbe.java residue");
  assert.equal(fs.existsSync(compiledProbe), false, "ImportWitnessClosureProbe.class residue");
});
test("domain invalid classpath resource fails closed without publishing or caching an analyzer", (t) => {
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const temporary = temporaryDirectory(t, "agentbench-invalid-domain");
  const resource = path.join(temporary, "resource");
  const home = path.join(temporary, "home");
  const temporaryFiles = path.join(temporary, "tmp");
  for (const directory of [resource, home, temporaryFiles]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(resource, "domain-v1.json"), canonicalJson({
    analyzerName: "supported-subset-abstract-interpreter-v1", domainVersion: 1,
  }));
  const args = receipt.launch.args.map((argument) => argument
    .replace(/^-Duser\.home=.*/, `-Duser.home=${home}`)
    .replace(/^-Djava\.io\.tmpdir=.*/, `-Djava.io.tmpdir=${temporaryFiles}`));
  const cpIndex = args.indexOf("-cp");
  args[cpIndex + 1] = `${resource}${path.delimiter}${args[cpIndex + 1]}`;
  const request = analyzeRequest("src/domain/Canary.kt", EXPRESSION_CLONE_SOURCE);
  const result = spawnSync(receipt.launch.java, args, {
    cwd: temporary,
    env: { JAVA_HOME: receipt.jdk.root, HOME: home, TMPDIR: temporaryFiles, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    shell: false,
    encoding: null,
    input: protocolFrame(request),
    timeout: 30_000,
    maxBuffer: 4_194_312,
  });
  assert.equal(result.status, 0, Buffer.from(result.stderr ?? "").toString("utf8"));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  const response = framedResponse(result.stdout);
  assert.equal(response.analysisStatus, "rejected");
  assert.equal(response.rejectionCode, "internal_uncertainty");
  assert.deepEqual(response.nodes, []);
  assert.deepEqual(response.claims, []);
});
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
  const buildSource = fs.readFileSync(replica.build, "utf8");
  const reviewedJarStart = buildSource.indexOf("function assertReviewedJar(material, inspection) {");
  const reviewedJarEnd = buildSource.indexOf("\nfunction cleanBuild(", reviewedJarStart);
  assert.equal(reviewedJarStart >= 0 && reviewedJarEnd > reviewedJarStart, true, "assertReviewedJar source boundary");
  const reviewedJarSource = buildSource.slice(reviewedJarStart, reviewedJarEnd);
  const verifySemanticGuard = `    if ((name === "com/agentbench/analyzer/AbstractInterpreter.class"
        || name === "com/agentbench/analyzer/Rules.class"
        || name.startsWith("com/agentbench/analyzer/Rules$"))
        && (content.includes(Buffer.from("org/jetbrains/kotlin/")) || content.includes(Buffer.from("com/intellij/")))) {
      fail(\`semantic bytecode \${name} contains a PSI or Kotlin compiler reference\`);
    }`;
  assert.equal(reviewedJarSource.includes(verifySemanticGuard), true,
    "assertReviewedJar verify-only must apply the semantic-class raw-byte PSI/Kotlin compiler guard");
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
    assert.match(rejected.stderr, /forbidden capability|unreviewed import|class-reference (?:inventory|bounds)/i);
  }
  fs.writeFileSync(mainPath, main);
  const interpreterPath = path.join(replica.analyzer, "src/main/java/com/agentbench/analyzer/AbstractInterpreter.java");
  const interpreter = fs.readFileSync(interpreterPath, "utf8");
  const psiAttack = interpreter.replace(
    "final class AbstractInterpreter {",
    "final class AbstractInterpreter {\n    private static final Class<?> FORBIDDEN_PSI = org.jetbrains.kotlin.psi.KtFile.class;",
  );
  assert.notEqual(psiAttack, interpreter, "semantic PSI attack seam");
  fs.writeFileSync(interpreterPath, psiAttack);
  const semanticRejected = runScrubbedNode(replica.build, ["clean-build-twice"]);
  assert.notEqual(semanticRejected.status, 0);
  assert.match(semanticRejected.stderr, /semantic bytecode.*PSI|PSI or Kotlin compiler reference/i);
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
