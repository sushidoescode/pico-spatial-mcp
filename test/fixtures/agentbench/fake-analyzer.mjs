import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../../benchmarks/spatial-agent-bench/lib/identity.mjs";

const MAX_RESPONSE_JSON_BYTES = 4_194_304;
const RULE_ORDER = Object.freeze([
  "spatial.project-entry", "spatial.container-topology", "spatial.entity-content", "spatial.ui-lifecycle",
  "ecs.component-clone", "ecs.system-query", "ecs.frame-update", "ecs.lifecycle",
  "state.single-source", "state.typed-handoff", "state.shared-read-write", "state.reopen-wiring",
  "plane.retry-readiness", "plane.semantic-fallback", "plane.anchor-pose", "plane.cleanup-errors",
]);
const DOMAIN_PATH = fileURLToPath(new URL("../../../benchmarks/spatial-agent-bench/analyzer/domain-v1.json", import.meta.url));

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function domainProofForm(ruleId) {
  try {
    const domain = JSON.parse(fs.readFileSync(DOMAIN_PATH, "utf8"));
    const forms = domain.proofFormsByRule?.[ruleId];
    if (Array.isArray(forms) && typeof forms[0] === "string") return forms[0];
  } catch {}
  return ruleId === "ecs.component-clone" ? "expression-component-clone" : `invalid-${ruleId}`;
}

function frame(jsonBytes) {
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(jsonBytes.length));
  return Buffer.concat([header, jsonBytes]);
}

function request() {
  const bytes = fs.readFileSync(0);
  if (bytes.length < 8) throw new Error("fake analyzer received a partial request frame");
  const length = Number(bytes.readBigUInt64BE(0));
  if (bytes.length !== length + 8) throw new Error("fake analyzer received a mismatched request frame");
  return JSON.parse(bytes.subarray(8).toString("utf8"));
}

function responseFor(value, overrides = {}) {
  return {
    protocolVersion: 1,
    subsetVersion: 1,
    command: value.command,
    analysisStatus: "accepted",
    rejectionCode: null,
    kotlinInputSetSha256: value.kotlinInputSetSha256,
    files: value.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    constants: value.command === "describe" ? {
      ANALYZER_PROTOCOL_VERSION: 1,
      ANALYZER_SUBSET_VERSION: 1,
      MAX_KOTLIN_FILES: 512,
      MAX_KOTLIN_FILE_BYTES: 1_048_576,
      MAX_KOTLIN_TOTAL_BYTES: 8_388_608,
      MAX_REQUEST_JSON_BYTES: 52_428_800,
      MAX_RESPONSE_JSON_BYTES: 4_194_304,
      MAX_STDERR_BYTES: 4_194_304,
      MAX_PATH_UTF8_BYTES: 4_096,
      MAX_JSON_DEPTH: 16,
      MAX_PSI_NODES: 500_000,
      MAX_DECLARATIONS: 25_000,
      MAX_CALL_SITES: 100_000,
      MAX_CFG_BLOCKS_PER_CALLABLE: 4_096,
      MAX_CALL_DEPTH: 8,
      MAX_FIXPOINT_ITERATIONS: 32,
      MAX_RESPONSE_NODES: 256,
      MAX_CLAIMS: 16,
      MAX_WITNESSES_PER_CLAIM: 32,
      MAX_TOTAL_WITNESSES: 256,
      CACHE_MAX_ENTRIES: 32,
      CACHE_MAX_ENCODED_BYTES: 16_777_216,
      ANALYZER_TIMEOUT_MS: 30_000,
    } : null,
    nodes: [],
    claims: [],
    ...overrides,
  };
}

function semanticSource(value) {
  const file = value.files[0];
  if (!file) throw new Error("semantic fake requires one request file");
  return { file, source: Buffer.from(file.contentBase64, "base64").toString("utf8") };
}

function semanticNode(file, source, fields) {
  const material = {
    path: fields.path ?? file.path,
    fileSha256: fields.fileSha256 ?? file.sha256,
    startUtf16: fields.startUtf16,
    endUtf16: fields.endUtf16,
    kind: fields.kind,
    textSha256: fields.textSha256 ?? sha256(Buffer.from(source.slice(fields.startUtf16, fields.endUtf16), "utf8")),
    structuralToken: fields.structuralToken,
  };
  return { nodeId: fields.nodeId ?? sha256(Buffer.from(canonicalJson(material), "utf8")), ...material };
}

function semanticClaim(ruleId, proofForm, witnessNodeIds, witnessDigest = null) {
  const material = { ruleId, proofForm, witnessNodeIds: [...witnessNodeIds] };
  return { ...material, witnessDigest: witnessDigest ?? sha256(Buffer.from(canonicalJson(material), "utf8")) };
}

function baseSemanticResponse(value) {
  const { file, source } = semanticSource(value);
  const classStart = Math.max(0, source.search(/\b(?:data\s+)?class\s+/u));
  const lastBrace = source.lastIndexOf("}");
  const declarationEnd = lastBrace >= classStart ? lastBrace + 1 : source.trimEnd().length;
  const equals = source.lastIndexOf("=");
  const callStart = equals >= 0 ? equals + 1 + /^\s*/u.exec(source.slice(equals + 1))?.[0].length : classStart;
  const callLineEnd = source.indexOf("\n", callStart);
  const callEnd = (callLineEnd < 0 ? source.length : callLineEnd) - /\s*$/u.exec(source.slice(callStart, callLineEnd < 0 ? source.length : callLineEnd))?.[0].length;
  const nodes = [
    semanticNode(file, source, { startUtf16: classStart, endUtf16: declarationEnd, kind: "declaration", structuralToken: true }),
    semanticNode(file, source, { startUtf16: callStart, endUtf16: Math.max(callStart + 1, callEnd), kind: "call", structuralToken: true }),
  ].sort((left, right) => Buffer.compare(Buffer.from(left.nodeId), Buffer.from(right.nodeId)));
  const claim = semanticClaim("ecs.component-clone", "expression-component-clone", nodes.map((node) => node.nodeId));
  return responseFor(value, { nodes, claims: [claim] });
}

function replaceNode(response, index, next) {
  const oldId = response.nodes[index].nodeId;
  response.nodes[index] = next;
  response.nodes.sort((left, right) => Buffer.compare(Buffer.from(left.nodeId), Buffer.from(right.nodeId)));
  response.claims = response.claims.map((claim) => semanticClaim(
    claim.ruleId,
    claim.proofForm,
    claim.witnessNodeIds.map((nodeId) => nodeId === oldId ? next.nodeId : nodeId)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  ));
  return response;
}

function uniqueSemanticNodes(value, count) {
  const { file, source } = semanticSource(value);
  const nodes = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push(semanticNode(file, source, {
      startUtf16: index,
      endUtf16: index + 1,
      kind: "call",
      structuralToken: true,
    }));
  }
  return nodes.sort((left, right) => Buffer.compare(Buffer.from(left.nodeId), Buffer.from(right.nodeId)));
}

function mutateSemanticResponse(value, scenario) {
  const response = structuredClone(baseSemanticResponse(value));
  const { file, source } = semanticSource(value);
  const current = () => response.nodes[0];
  const rebuilt = (overrides) => semanticNode(file, source, { ...current(), nodeId: undefined, ...overrides });
  if (scenario === "semantic-valid") return response;
  if (scenario === "semantic-valid-mixed") {
    const marker = "listOf(7)";
    const markerStart = source.indexOf(marker);
    if (markerStart < 0 || source.indexOf(marker, markerStart + 1) >= 0) {
      throw new Error("mixed semantic fake requires one literal call argument");
    }
    const startUtf16 = markerStart + "listOf(".length;
    response.nodes.push(semanticNode(file, source, {
      startUtf16, endUtf16: startUtf16 + 1, kind: "argument", structuralToken: false,
    }));
    response.nodes.sort((left, right) => Buffer.compare(Buffer.from(left.nodeId), Buffer.from(right.nodeId)));
    response.claims = [semanticClaim(
      "ecs.component-clone",
      "expression-component-clone",
      response.nodes.map((node) => node.nodeId),
    )];
    return response;
  }
  if (scenario === "semantic-unknown-response-key") return { ...response, surprise: true };
  if (scenario === "semantic-rejected-nodes") return { ...response, analysisStatus: "rejected", rejectionCode: "parse", claims: [] };
  if (scenario === "semantic-rejected-claims") return { ...response, analysisStatus: "rejected", rejectionCode: "parse", nodes: [] };
  if (scenario === "semantic-unknown-node-key") { response.nodes[0].surprise = true; return response; }
  if (scenario === "semantic-missing-node-key") { delete response.nodes[0].textSha256; return response; }
  if (scenario === "semantic-unknown-node-kind") return replaceNode(response, 0, rebuilt({ kind: "unknown_kind" }));
  if (scenario === "semantic-path-unnormalized") return replaceNode(response, 0, rebuilt({ path: "../Escape.kt" }));
  if (scenario === "semantic-path-unknown") return replaceNode(response, 0, rebuilt({ path: "src/Missing.kt" }));
  if (scenario === "semantic-file-hash") return replaceNode(response, 0, rebuilt({ fileSha256: "0".repeat(64) }));
  if (scenario === "semantic-span-negative") return replaceNode(response, 0, rebuilt({ startUtf16: -1 }));
  if (scenario === "semantic-span-reversed") return replaceNode(response, 0, rebuilt({ startUtf16: 4, endUtf16: 3 }));
  if (scenario === "semantic-span-out-of-bounds") return replaceNode(response, 0, rebuilt({ endUtf16: source.length + 1 }));
  if (scenario === "semantic-surrogate-start" || scenario === "semantic-surrogate-end") {
    const emoji = [...source].findIndex((character) => character.length === 2);
    let utf16 = 0;
    for (const character of source) {
      if (character.length === 2) break;
      utf16 += character.length;
    }
    if (emoji < 0) throw new Error("surrogate mutation requires a supplementary character");
    return replaceNode(response, 0, rebuilt(scenario.endsWith("start")
      ? { startUtf16: utf16 + 1, endUtf16: utf16 + 2 }
      : { startUtf16: utf16, endUtf16: utf16 + 1 }));
  }
  if (scenario === "semantic-text-hash") return replaceNode(response, 0, rebuilt({ textSha256: "0".repeat(64) }));
  if (scenario === "semantic-node-id") {
    const oldId = response.nodes[0].nodeId;
    response.nodes[0].nodeId = "0".repeat(64);
    response.claims = response.claims.map((claim) => semanticClaim(claim.ruleId, claim.proofForm,
      claim.witnessNodeIds.map((nodeId) => nodeId === oldId ? "0".repeat(64) : nodeId).sort()));
    response.nodes.sort((left, right) => Buffer.compare(Buffer.from(left.nodeId), Buffer.from(right.nodeId)));
    return response;
  }
  if (scenario === "semantic-node-order") { response.nodes.reverse(); return response; }
  if (scenario === "semantic-node-duplicate") { response.nodes.push(structuredClone(response.nodes[0])); return response; }
  if (scenario === "semantic-node-over-limit") { response.nodes = Array.from({ length: 257 }, () => structuredClone(response.nodes[0])); return response; }
  if (scenario === "semantic-unknown-claim-key") { response.claims[0].surprise = true; return response; }
  if (scenario === "semantic-missing-claim-key") { delete response.claims[0].witnessDigest; return response; }
  if (scenario === "semantic-unknown-rule") {
    response.claims[0] = semanticClaim("unknown.rule", response.claims[0].proofForm, response.claims[0].witnessNodeIds);
    return response;
  }
  if (scenario === "semantic-unknown-proof") {
    response.claims[0] = semanticClaim(response.claims[0].ruleId, "unknown-proof-form", response.claims[0].witnessNodeIds);
    return response;
  }
  if (scenario === "semantic-duplicate-claim") { response.claims.push(structuredClone(response.claims[0])); return response; }
  if (scenario === "semantic-claim-order") {
    const project = semanticClaim("spatial.project-entry", domainProofForm("spatial.project-entry"), response.claims[0].witnessNodeIds);
    response.claims = [response.claims[0], project];
    return response;
  }
  if (scenario === "semantic-claim-over-limit") { response.claims = Array.from({ length: 17 }, () => structuredClone(response.claims[0])); return response; }
  if (scenario === "semantic-empty-witness-empty-catalog") {
    response.nodes = [];
    response.claims[0] = semanticClaim(response.claims[0].ruleId, response.claims[0].proofForm, []);
    return response;
  }
  if (scenario === "semantic-empty-catalog") { response.nodes = []; return response; }
  if (scenario === "semantic-witness-order") {
    response.claims[0] = semanticClaim(response.claims[0].ruleId, response.claims[0].proofForm, [...response.claims[0].witnessNodeIds].reverse());
    return response;
  }
  if (scenario === "semantic-witness-duplicate") {
    response.claims[0] = semanticClaim(response.claims[0].ruleId, response.claims[0].proofForm, [response.claims[0].witnessNodeIds[0], response.claims[0].witnessNodeIds[0]]);
    return response;
  }
  if (scenario === "semantic-witness-unknown") {
    response.claims[0] = semanticClaim(response.claims[0].ruleId, response.claims[0].proofForm, ["0".repeat(64)]);
    return response;
  }
  if (scenario === "semantic-witness-digest") { response.claims[0].witnessDigest = "0".repeat(64); return response; }
  if (scenario === "semantic-witness-over-limit") {
    response.claims[0] = semanticClaim(response.claims[0].ruleId, response.claims[0].proofForm, Array(33).fill(response.claims[0].witnessNodeIds[0]));
    return response;
  }
  if (scenario === "semantic-total-witness-over-limit") {
    response.nodes = uniqueSemanticNodes(value, 17);
    const witnessNodeIds = response.nodes.map((node) => node.nodeId);
    response.claims = RULE_ORDER.map((ruleId) => semanticClaim(ruleId, domainProofForm(ruleId), witnessNodeIds));
    return response;
  }
  if (scenario === "semantic-literal-only") {
    for (const node of [...response.nodes]) {
      const index = response.nodes.findIndex((candidate) => candidate.nodeId === node.nodeId);
      replaceNode(response, index, semanticNode(file, source, { ...node, nodeId: undefined, kind: "argument", structuralToken: false }));
    }
    return response;
  }
  if (scenario === "semantic-nonstructural-nonargument") return replaceNode(response, 0, rebuilt({ kind: "call", structuralToken: false }));
  if (scenario === "semantic-structural-type") return replaceNode(response, 0, rebuilt({ structuralToken: "true" }));
  if (scenario === "semantic-union-orphan") {
    const orphan = semanticNode(file, source, { startUtf16: 0, endUtf16: 1, kind: "call", structuralToken: true });
    response.nodes.push(orphan);
    response.nodes.sort((left, right) => Buffer.compare(Buffer.from(left.nodeId), Buffer.from(right.nodeId)));
    return response;
  }
  if (scenario === "semantic-union-missing") { response.nodes.pop(); return response; }
  throw new Error(`unknown semantic fake scenario ${scenario}`);
}

function writeCanonical(value) {
  process.stdout.write(frame(Buffer.from(canonicalJson(value), "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scenario = process.argv[2] ?? "accepted";
  if (scenario === "hang") setInterval(() => {}, 1_000);
  else if (scenario === "nonzero") process.exit(19);
  else if (scenario === "signal") process.kill(process.pid, "SIGTERM");
  else {
  const value = request();
  const response = scenario === "describe-semantic"
    ? responseFor(value, { nodes: [{}], claims: [] })
    : scenario.startsWith("semantic-") ? mutateSemanticResponse(value, scenario) : responseFor(value);
  if (scenario === "stderr") process.stderr.write("unexpected diagnostic");
  if (scenario === "partial") process.stdout.write(frame(Buffer.from("{}", "utf8")).subarray(0, 9));
  else if (scenario === "trailing") process.stdout.write(Buffer.concat([frame(Buffer.from(canonicalJson(response))), Buffer.from([0])]));
  else if (scenario === "invalid-utf8") process.stdout.write(frame(Buffer.from([0xff])));
  else if (scenario === "duplicate-key") process.stdout.write(frame(Buffer.from('{"claims":[],"claims":[]}', "utf8")));
  else if (scenario === "noncanonical-whitespace") process.stdout.write(frame(Buffer.from(` ${canonicalJson(response)}`, "utf8")));
  else if (scenario === "out-of-order-key") process.stdout.write(frame(Buffer.from('{"subsetVersion":1,"protocolVersion":1}', "utf8")));
  else if (scenario === "negative-zero") process.stdout.write(frame(Buffer.from('{"x":-0}', "utf8")));
  else if (scenario === "fraction") process.stdout.write(frame(Buffer.from('{"x":1.0}', "utf8")));
  else if (scenario === "lone-surrogate") process.stdout.write(frame(Buffer.from('{"x":"\\ud800"}', "utf8")));
  else if (scenario === "deep-json") process.stdout.write(frame(Buffer.from(`${"[".repeat(18)}null${"]".repeat(18)}`, "utf8")));
  else if (scenario === "oversize-header") { const header = Buffer.alloc(8); header.writeBigUInt64BE(BigInt(MAX_RESPONSE_JSON_BYTES + 1)); process.stdout.write(header); }
  else if (scenario === "unknown-key") writeCanonical({ ...response, surprise: true });
  else if (scenario === "wrong-version") writeCanonical({ ...response, protocolVersion: 2 });
  else if (scenario === "wrong-digest") writeCanonical({ ...response, kotlinInputSetSha256: "0".repeat(64) });
  else if (scenario === "reordered-files") writeCanonical({ ...response, files: [...response.files].reverse() });
  else if (scenario === "missing-file") writeCanonical({ ...response, files: response.files.slice(1) });
  else if (scenario === "extra-file") writeCanonical({ ...response, files: [...response.files, { path: "src/Extra.kt", bytes: 0, sha256: "0".repeat(64) }] });
  else if (scenario === "impossible-status") writeCanonical({ ...response, analysisStatus: "accepted", rejectionCode: "parse" });
  else if (scenario === "impossible-constants") writeCanonical({ ...response, constants: {} });
  else if (scenario === "stderr-overflow") process.stderr.write(Buffer.alloc(MAX_RESPONSE_JSON_BYTES + 1, 120));
  else if (scenario === "stdout-overflow") process.stdout.write(Buffer.alloc(MAX_RESPONSE_JSON_BYTES + 9, 120));
  else writeCanonical(response);
  }
}

export function spawnFakeAnalyzer(scenarioName, options) {
  const childScenario = scenarioName === "non-buffer" ? "accepted" : scenarioName;
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), childScenario], {
    input: options.input,
    encoding: null,
    timeout: scenarioName === "hang" ? 50 : options.timeout,
    killSignal: options.killSignal,
    maxBuffer: options.maxBuffer,
    shell: false,
  });
  return scenarioName === "non-buffer" ? { ...result, stdout: result.stdout.toString("utf8") } : result;
}
