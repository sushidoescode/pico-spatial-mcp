// Public render_usd_offscreen producer regressions. The tool must render to a fresh private path,
// validate and measure those exact bytes, and only then atomically publish the caller's output.
// Run: npm run build && node test/usdrender.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { registerUsdRenderTools } from "../dist/usdrender.js";
import { appendUsdHostRenderEntry } from "../dist/ledger.js";

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}`); failures++; }
};
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
};
function makePng(width, height, shade) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const rows = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) rows.fill(shade, y * (width + 1) + 1, (y + 1) * (width + 1));
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "usd-render-producer-"));
const previousLedgerDir = process.env.PICO_MCP_LEDGER_DIR;
process.env.PICO_MCP_LEDGER_DIR = path.join(scratch, "ledgers");
const asset = path.join(scratch, "scene.usda");
fs.writeFileSync(asset, '#usda 1.0\ndef Xform "Scene" {}\n');

let nextRun = { code: 0, bytes: makePng(128, 128, 180), stderr: "" };
let nextMeasurements = {
  available: true,
  objectCount: 4,
  nonBlackCoverage: 0.42,
  mostlyBlack: false,
  dominantColors: ["AABBCC", "445566"],
};
let rejectLedger = false;
let handler = null;
const server = {
  registerTool(name, _definition, registeredHandler) {
    if (name === "render_usd_offscreen") handler = registeredHandler;
  },
};
registerUsdRenderTools(server, {
  usdrecordBinFn: () => "/fixture/usdrecord",
  runFn: async (_command, args) => {
    const freshOutput = args.at(-1);
    if (nextRun.bytes !== undefined) fs.writeFileSync(freshOutput, nextRun.bytes);
    return { code: nextRun.code, stdout: "", stderr: nextRun.stderr, timedOut: false };
  },
  analyzeFrameFn: async () => nextMeasurements,
  appendUsdHostRenderEntryFn: (app, input) => rejectLedger
    ? { status: "rejected", reason: "fixture ledger rejection" }
    : appendUsdHostRenderEntry(app, input),
});

const invoke = async (outPath, overrides = {}) => {
  const result = await handler({ assetPath: asset, outPath, width: 800, ...overrides });
  const text = result.content?.[0]?.text ?? "";
  try { return { result, body: JSON.parse(text), text }; }
  catch { return { result, body: { status: "tool_error" }, text }; }
};

// A nonzero renderer must never bless a stale caller-owned output that existed before this attempt.
const staleOut = path.join(scratch, "stale.png");
const staleBytes = makePng(128, 128, 90);
fs.writeFileSync(staleOut, staleBytes);
nextRun = { code: 9, bytes: undefined, stderr: "fixture render failed" };
let observed = await invoke(staleOut);
check(
  "nonzero usdrecord exit rejects the attempt and preserves a stale requested output",
  observed.body.status !== "rendered"
    && /code 9|render failed|nonzero/i.test(`${observed.body.reason ?? ""} ${observed.text}`)
    && sha256(fs.readFileSync(staleOut)) === sha256(staleBytes),
);

// Code zero is not evidence by itself: malformed, undersized, black, and zero-object frames fail
// before the requested output path is published.
const invalidOut = path.join(scratch, "invalid.png");
nextRun = { code: 0, bytes: Buffer.from("not a raster"), stderr: "" };
observed = await invoke(invalidOut);
check(
  "code-zero invalid output is rejected before publish",
  observed.body.status !== "rendered" && /raster|image|magic|PNG|JPEG/i.test(`${observed.body.reason ?? ""} ${observed.text}`) && !fs.existsSync(invalidOut),
);

const smallOut = path.join(scratch, "small.png");
nextRun = { code: 0, bytes: makePng(16, 16, 220), stderr: "" };
observed = await invoke(smallOut);
check(
  "too-small output is rejected before publish",
  observed.body.status !== "rendered" && /too small|16.*16/i.test(`${observed.body.reason ?? ""} ${observed.text}`) && !fs.existsSync(smallOut),
);

const blackOut = path.join(scratch, "black.png");
nextRun = { code: 0, bytes: makePng(128, 128, 0), stderr: "" };
nextMeasurements = { available: true, objectCount: 1, nonBlackCoverage: 0, mostlyBlack: true, dominantColors: ["000000"] };
observed = await invoke(blackOut);
check(
  "effectively black output is rejected before publish",
  observed.body.status !== "rendered" && /black|coverage|content/i.test(`${observed.body.reason ?? ""} ${observed.text}`) && !fs.existsSync(blackOut),
);

const emptyCompositionOut = path.join(scratch, "zero-object.png");
nextRun = { code: 0, bytes: makePng(128, 128, 180), stderr: "" };
nextMeasurements = { available: true, objectCount: 0, nonBlackCoverage: 0.42, mostlyBlack: false, dominantColors: ["AABBCC"] };
observed = await invoke(emptyCompositionOut);
check(
  "zero-object output is rejected before publish",
  observed.body.status !== "rendered" && /object|foreground|composition/i.test(`${observed.body.reason ?? ""} ${observed.text}`) && !fs.existsSync(emptyCompositionOut),
);

// A measured success records only producer-derived facts. The caller can ask for dragons, but a
// coarse object/coverage/color measurement cannot turn that semantic sentence into measured truth.
const successOut = path.join(scratch, "accepted.png");
nextRun = { code: 0, bytes: makePng(128, 128, 180), stderr: "" };
nextMeasurements = { available: true, objectCount: 4, nonBlackCoverage: 0.42, mostlyBlack: false, dominantColors: ["AABBCC", "445566"] };
rejectLedger = false;
const callerClaim = "Four dragons circle a crystal castle";
observed = await invoke(successOut, { app: "fixture.usd-canonical", claim: callerClaim, record: true });
const recorded = observed.body.ledger?.entry;
check(
  "accepted render atomically publishes and records a canonical hash/measurement claim",
  observed.body.status === "rendered"
    && fs.existsSync(successOut)
    && observed.body.sha256 === sha256(fs.readFileSync(successOut))
    && observed.body.ledger?.status === "recorded"
    && recorded?.claim === observed.body.claim
    && !/dragons|castle|circle/i.test(recorded?.claim ?? "")
    && recorded?.claim.includes(recorded?.usdRender?.assetSha256)
    && recorded?.claim.includes(recorded?.usdRender?.outputSha256)
    && /\"objectCount\":4/.test(recorded?.claim ?? "")
    && /\"nonBlackCoverage\":0.42/.test(recorded?.claim ?? ""),
);
check(
  "USD receipt binds exact measured fields and keeps caller prose explicitly unverified",
  recorded?.usdRender?.outputSha256 === observed.body.sha256
    && recorded?.usdRender?.objectCount === 4
    && recorded?.usdRender?.nonBlackCoverage === 0.42
    && JSON.stringify(recorded?.usdRender?.dominantColors) === JSON.stringify(nextMeasurements.dominantColors)
    && recorded?.usdRender?.callerContext?.text === callerClaim
    && recorded?.usdRender?.callerContext?.verified === false
    && observed.body.callerContext?.verified === false,
);

// A measured image with a rejected ledger write is useful diagnostic output, but the public result
// must not report the evidence-producing status or claim durable composition proof.
const rejectedOut = path.join(scratch, "ledger-rejected.png");
rejectLedger = true;
observed = await invoke(rejectedOut, { app: "fixture.usd-rejected", claim: "A dragon exists", record: true });
check(
  "ledger rejection is surfaced as non-rendered evidence status with no durable composition proof",
  observed.body.status !== "rendered"
    && observed.body.ledger?.status === "rejected"
    && observed.body.compositionProof?.durable === false
    && /no durable.*composition proof|not recorded/i.test(observed.body.note ?? ""),
);

if (previousLedgerDir === undefined) delete process.env.PICO_MCP_LEDGER_DIR;
else process.env.PICO_MCP_LEDGER_DIR = previousLedgerDir;
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nUSD render producer test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
