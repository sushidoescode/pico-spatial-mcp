#!/usr/bin/env node
// Host-executed fixture measurement for Task C5 (single-flight doors + complete result transport).
//
// Usage (from anywhere; the script chdirs to the repo root):
//   node evidence/2026-09-15-cli050-sdk61-evolution-impl-001/doors-transport/measure-doors-transport.mjs <label>
//
// It spawns the repo's own dist/index.js on the doors surface under the SAME hermetic harness the
// doors suite uses (fixture HOME/PICO_HOME, a fake npm and a logging node proxy on PATH, PICO_ADB
// pointed at an exit-1 stub) and records, for fixed inputs:
//   - cold latency: first pico_sdk {symbol:'Entity'} call on a fresh server (includes the inner spawn)
//   - warm latency: 10 further sequential pico_sdk calls (median/min/max)
//   - serialized response bytes of pico_sdk and pico_doctor {} results
//   - pico_look through an exit-1 adb stub: whether the inner failure arrives as isError
//   - burst: a second cold server receiving 20 concurrent pico_sdk calls — inner child count + wall time
// These are host-executed fixture measurements on one machine, not promises or targets.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
process.chdir(repoRoot);
const { createManagedRuntimeHarness } = await import(path.join(repoRoot, "test", "helpers", "picocli-managed-fixture.mjs"));

const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label)) {
  console.error("usage: measure-doors-transport.mjs <label>   (label: e.g. before | after)");
  process.exit(2);
}
const WARM_CALLS = 10;
const BURST = 20;

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const bytesOf = (result) => Buffer.byteLength(JSON.stringify(result), "utf8");
const ms = (start) => Number((performance.now() - start).toFixed(1));
const median = (values) => { const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(1)); };

function coldDoorsServer(name) {
  const harness = createManagedRuntimeHarness();
  const adbStub = path.join(harness.root, "adb");
  fs.writeFileSync(adbStub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...harness.env, PICO_MCP_SURFACE: "doors", PICO_ADB: adbStub },
  });
  const client = new Client({ name, version: "0.0.0" });
  const innerStarts = () => harness.calls().filter((call) => call.role === "node-proxy" && call.args.some((arg) => /dist[/\\]index\.js$/.test(arg))).length;
  return { harness, transport, client, innerStarts, close: async () => { await client.close(); fs.rmSync(harness.root, { recursive: true, force: true }); } };
}

const statusOf = (result) => { try { return JSON.parse(result.content?.[0]?.text ?? "").status ?? null; } catch { return null; } };

// ── sequential: cold, warm, bytes, pico_look ──
const seq = coldDoorsServer("doors-transport-measure-sequential");
let sequential;
try {
  const connectStart = performance.now();
  await seq.client.connect(seq.transport);
  const doorsServerConnectMs = ms(connectStart);
  const coldStart = performance.now();
  const cold = await seq.client.callTool({ name: "pico_sdk", arguments: { symbol: "Entity" } });
  const coldMs = ms(coldStart);
  const warmMs = [];
  for (let i = 0; i < WARM_CALLS; i++) {
    const start = performance.now();
    await seq.client.callTool({ name: "pico_sdk", arguments: { symbol: "Entity" } });
    warmMs.push(ms(start));
  }
  const doctorStart = performance.now();
  const doctor = await seq.client.callTool({ name: "pico_doctor", arguments: {} });
  const doctorMs = ms(doctorStart);
  const lookStart = performance.now();
  const look = await seq.client.callTool({ name: "pico_look", arguments: {} });
  const lookMs = ms(lookStart);
  const lookText = look.content?.[0]?.text ?? "";
  sequential = {
    doorsServerConnectMs,
    picoSdk: { input: { symbol: "Entity" }, status: statusOf(cold), coldMs, warmMs, warmMedianMs: median(warmMs), warmMinMs: Math.min(...warmMs), warmMaxMs: Math.max(...warmMs), responseBytes: bytesOf(cold) },
    picoDoctor: { input: {}, ms: doctorMs, responseBytes: bytesOf(doctor), preflightChecks: (() => { try { return JSON.parse(doctor.content[0].text).preflight?.checks?.length ?? null; } catch { return null; } })() },
    picoLook: { input: {}, ms: lookMs, envelopeIsError: look.isError === true, textStatusField: statusOf(look), textHead: lookText.slice(0, 120), responseBytes: bytesOf(look) },
    innerChildrenStarted: seq.innerStarts(),
  };
} finally {
  await seq.close();
}

// ── burst: 20 concurrent first calls at a second cold server ──
const burstServer = coldDoorsServer("doors-transport-measure-burst");
let burst;
try {
  await burstServer.client.connect(burstServer.transport);
  const start = performance.now();
  const results = await Promise.all(Array.from({ length: BURST }, () => burstServer.client.callTool({ name: "pico_sdk", arguments: { symbol: "Entity" } })));
  const wallMs = ms(start);
  const statuses = results.map(statusOf);
  burst = {
    concurrentCalls: BURST,
    input: { symbol: "Entity" },
    wallMs,
    innerChildrenStarted: burstServer.innerStarts(),
    statuses: Object.fromEntries([...new Set(statuses)].map((s) => [String(s), statuses.filter((x) => x === s).length])),
    responseBytesFirst: bytesOf(results[0]),
    identicalResponses: results.every((r) => JSON.stringify(r) === JSON.stringify(results[0])),
  };
} finally {
  await burstServer.close();
}

const record = {
  label,
  kind: "host-executed fixture measurement (not a promise, not a target)",
  measuredAt: new Date().toISOString(),
  commit: git(["rev-parse", "HEAD"]),
  workingTreeDirty: git(["status", "--porcelain"]).length > 0,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  harness: "test/helpers/picocli-managed-fixture.mjs createManagedRuntimeHarness() + PICO_ADB exit-1 stub; doors surface; inner full-surface dist/index.js",
  sequential,
  burst,
};
const out = path.join(here, `${label}.json`);
fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log(`${label}: cold ${sequential.picoSdk.coldMs}ms, warm median ${sequential.picoSdk.warmMedianMs}ms, pico_sdk ${sequential.picoSdk.responseBytes}B, pico_doctor ${sequential.picoDoctor.responseBytes}B, pico_look isError=${sequential.picoLook.envelopeIsError} status=${sequential.picoLook.textStatusField}; burst of ${BURST}: ${burst.innerChildrenStarted} inner child(ren) in ${burst.wallMs}ms -> ${out}`);
