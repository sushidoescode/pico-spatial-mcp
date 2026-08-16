import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../../benchmarks/spatial-agent-bench/lib/identity.mjs";

const MAX_RESPONSE_JSON_BYTES = 4_194_304;

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
  const response = responseFor(value);
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
