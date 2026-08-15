import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as store from "../dist/runreceiptstore.js";
import {
  FIXTURE_APP,
  createRunReceiptFixture,
  makePng,
} from "./helpers/runreceipt-fixture.mjs";

const ZERO_HASH = "0".repeat(64);
const LEDGER_MODULE = pathToFileURL(path.resolve("dist/ledger.js")).href;

async function startClient(t, args, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "runreceipt-ledger-boundary", version: "0.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return async (name, toolArgs) => {
    const result = await client.callTool({ name, arguments: toolArgs });
    return JSON.parse(result.content[0].text);
  };
}

async function startFullSurface(t, fixture, extraEnv = {}) {
  return startClient(t, ["dist/index.js"], {
    HOME: fixture.scratch,
    PICO_MCP_SURFACE: "full",
    PICO_MCP_LEDGER_DIR: fixture.ledgerDir,
    PICO_MCP_RUN_RECEIPT_DIR: fixture.rootDir,
    ...extraEnv,
  });
}

async function startFocusedLedger(t, fixture, resolverSource = "") {
  const source = `
    import fs from "node:fs";
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { registerLedgerTools } from ${JSON.stringify(LEDGER_MODULE)};
    const server = new McpServer({ name: "focused-ledger-boundary", version: "0.0.0" });
    ${resolverSource
      ? `const resolveRunReceiptBinding = ${resolverSource}; registerLedgerTools(server, { resolveRunReceiptBinding });`
      : "registerLedgerTools(server);"}
    await server.connect(new StdioServerTransport());
  `;
  return startClient(t, ["--input-type=module", "--eval", source], {
    HOME: fixture.scratch,
    PICO_MCP_LEDGER_DIR: fixture.ledgerDir,
    PICO_MCP_RUN_RECEIPT_DIR: fixture.rootDir,
  });
}

function expectedBinding(published, fixture) {
  return {
    kind: "pico.native-run-receipt",
    schemaVersion: 1,
    receiptId: published.receiptId,
    captureSha256: fixture.payload.capture.sha256,
  };
}

function assertEveryEvidenceBucketEmpty(report) {
  assert.equal(report.entryCount, 0);
  assert.equal(report.historyEntryCount, 0);
  assert.deepEqual(report.ledger, []);
  assert.deepEqual(report.history, []);
  for (const [bucket, entries] of Object.entries(report.capabilityReport.matrix)) {
    assert.deepEqual(entries, [], `${bucket} must remain empty after receipt publication alone`);
  }
}

function writeFakeAdb(fixture) {
  const fakeAdb = path.join(fixture.scratch, "fake-adb.mjs");
  fs.writeFileSync(fakeAdb, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const serial = args[1] ?? "";
if (args.includes("getprop")) {
  const values = {
    "ro.product.model": "PICO Swan receipt-binding fixture",
    "ro.build.fingerprint": "Pico/swan/swan:16/RECEIPT/1:user/release-keys",
    "ro.boot.qemu": "",
  };
  process.stdout.write((values[args.at(-1)] ?? "") + "\\n");
} else if (args.includes("screencap") && serial === "PA9K1RECEIPTFIXTURE") {
  process.stdout.write(fs.readFileSync(process.env.PICO_DEVICE_FIXTURE_PATH));
} else {
  process.stderr.write("unsupported fixture adb invocation: " + args.join(" "));
  process.exitCode = 2;
}
`);
  fs.chmodSync(fakeAdb, 0o755);
  return fakeAdb;
}

test("receipt publication records no evidence and exact public bindings preserve their requested classes", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const fakeAdb = writeFakeAdb(fixture);
  const callJson = await startFullSurface(t, fixture, {
    PICO_ADB: fakeAdb,
    PICO_DEVICE_FIXTURE_PATH: fixture.captureSourcePath,
  });

  assertEveryEvidenceBucketEmpty(await callJson("ledger_report", { app: FIXTURE_APP }));

  // These strings are contract fixtures only. No rendered frame or hardware was observed here.
  const vision = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "synthetic exact-frame receipt-binding contract fixture",
    evidenceType: "vision_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic fixture attestation text only; no rendered LOOK or visual result is claimed.",
    runReceiptId: published.receiptId,
  });
  assert.equal(vision.status, "recorded");
  assert.equal(vision.entry.evidenceType, "vision_verified");
  assert.deepEqual(vision.entry.runReceipt, expectedBinding(published, fixture));

  const structural = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "unbound structural fixture remains supported",
    evidenceType: "structural",
  });
  assert.equal(structural.status, "recorded");
  assert.equal(structural.entry.evidenceType, "structural");
  assert.equal("runReceipt" in structural.entry, false);

  const boundStructural = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "a receipt cannot promote structural evidence",
    evidenceType: "structural",
    artifactPath: fixture.captureSourcePath,
    runReceiptId: published.receiptId,
  });
  assert.equal(boundStructural.status, "rejected");
  assert.match(boundStructural.reason, /image|evidence|receipt/i);

  const boundAuto = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "a caller cannot promote automated fixture evidence",
    evidenceType: "auto_judged",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic automated fixture text only; this is not a human LOOK.",
    runReceiptId: published.receiptId,
  });
  assert.equal(boundAuto.status, "rejected");
  assert.match(boundAuto.reason, /visual_judge|producer|auto_judged/i);

  const device = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "synthetic device-lineage and receipt-binding contract fixture",
    evidenceType: "device_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic same-byte fixture only; no PICO hardware observation is claimed.",
    deviceSerial: "PA9K1RECEIPTFIXTURE",
    deviceFeature: "controller_ray",
    deviceOutcome: "pass",
    runReceiptId: published.receiptId,
  });
  assert.equal(device.status, "recorded");
  assert.equal(device.entry.evidenceType, "device_verified");
  assert.deepEqual(device.entry.runReceipt, expectedBinding(published, fixture));

  const injected = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "caller extra cannot inject a receipt binding",
    evidenceType: "structural",
    extra: { runReceipt: expectedBinding(published, fixture) },
  });
  assert.equal(injected.status, "recorded");
  assert.equal("runReceipt" in injected.entry, false);

  const report = await callJson("ledger_report", { app: FIXTURE_APP });
  assert.equal(report.capabilityReport.matrix.visuallyVerified.length, 1);
  assert.equal(report.capabilityReport.matrix.deviceVerified.length, 1);
  assert.equal(report.capabilityReport.matrix.autoJudged.length, 0);
  assert.equal(report.capabilityReport.matrix.structuralOnly.length, 2);
  assert.equal(report.ledger.find((entry) => entry.seq === vision.entry.seq).evidenceType, "vision_verified");
  assert.equal(report.ledger.find((entry) => entry.seq === structural.entry.seq).evidenceType, "structural");
});

test("full-surface receipt binding rejects wrong app, missing or tampered receipt, wrong bytes, and mixed retraction fields", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const wrongCapture = path.join(fixture.scratch, "wrong-capture.png");
  fs.writeFileSync(wrongCapture, makePng(177));
  const callJson = await startFullSurface(t, fixture);

  const invalidCalls = [
    await callJson("record_verification", {
      app: "com.example.other",
      claim: "wrong app fixture",
      evidenceType: "vision_verified",
      artifactPath: fixture.captureSourcePath,
      attestation: "Synthetic fixture text does not claim a rendered LOOK.",
      runReceiptId: published.receiptId,
    }),
    await callJson("record_verification", {
      app: FIXTURE_APP,
      claim: "missing receipt fixture",
      evidenceType: "vision_verified",
      artifactPath: fixture.captureSourcePath,
      attestation: "Synthetic fixture text does not claim a rendered LOOK.",
      runReceiptId: ZERO_HASH,
    }),
    await callJson("record_verification", {
      app: FIXTURE_APP,
      claim: "wrong bytes fixture",
      evidenceType: "vision_verified",
      artifactPath: wrongCapture,
      attestation: "Synthetic fixture text does not claim a rendered LOOK.",
      runReceiptId: published.receiptId,
    }),
  ];
  for (const result of invalidCalls) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason, /app|receipt|capture|sha256|exist|match/i);
  }

  const target = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "structural target for mixed retraction fixture",
    evidenceType: "structural",
  });
  assert.equal(target.status, "recorded");
  const mixedRetraction = await callJson("record_verification", {
    app: FIXTURE_APP,
    action: "retract",
    targetSeq: target.entry.seq,
    retractionReason: "runReceiptId is record-only",
    runReceiptId: published.receiptId,
  });
  assert.equal(mixedRetraction.status, "rejected");
  assert.match(mixedRetraction.reason, /mutually exclusive|record-only|runReceiptId/i);

  const receiptBytes = JSON.parse(fs.readFileSync(published.receiptPath, "utf8"));
  receiptBytes.runtime.pid += 1;
  fs.writeFileSync(published.receiptPath, `${JSON.stringify(receiptBytes)}\n`);
  const tampered = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "tampered receipt fixture",
    evidenceType: "vision_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic fixture text does not claim a rendered LOOK.",
    runReceiptId: published.receiptId,
  });
  assert.equal(tampered.status, "rejected");
  assert.match(tampered.reason, /receipt|canonical|pid|identity|invalid/i);

  const report = await callJson("ledger_report", { app: FIXTURE_APP });
  assert.equal(report.historyEntryCount, 1);
  assert.equal(report.ledger[0].evidenceType, "structural");
  assertEveryEvidenceBucketEmpty(await callJson("ledger_report", { app: "com.example.other" }));
});

test("a supplied receipt ID rejects when no resolver is configured", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const callJson = await startFocusedLedger(t, fixture);
  const result = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "missing resolver fixture",
    evidenceType: "vision_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic fixture text does not claim a rendered LOOK.",
    runReceiptId: published.receiptId,
  });
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /resolver|receipt.*(?:configured|available)|binding/i);
  assertEveryEvidenceBucketEmpty(await callJson("ledger_report", { app: FIXTURE_APP }));
});

test("capture tampering keeps the existing provenance downgrade and removes the consumable receipt binding", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const callJson = await startFullSurface(t, fixture);
  const recorded = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "synthetic receipt-bound capture tamper fixture",
    evidenceType: "vision_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic fixture attestation text only; no rendered LOOK is claimed.",
    runReceiptId: published.receiptId,
  });
  assert.equal(recorded.status, "recorded");
  assert.deepEqual(recorded.entry.runReceipt, expectedBinding(published, fixture));

  fs.writeFileSync(recorded.entry.artifactPath, makePng(199));
  const report = await callJson("ledger_report", { app: FIXTURE_APP });
  assert.equal(report.ledger[0].evidenceType, "provenance-broken");
  assert.equal("runReceipt" in report.ledger[0], false);
  assert.equal(report.runReceiptIssues.length, 1);
  assert.equal(report.capabilityReport.matrix.visuallyVerified.length, 0);
  assert.equal(report.capabilityReport.matrix.structuralOnly.length, 1);
});

test("the final materialized capture SHA must still equal the resolver binding", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const wrongCapture = path.join(fixture.scratch, "race-replacement.png");
  fs.writeFileSync(wrongCapture, makePng(211));
  const resolverSource = `(app, receiptId, artifactPath) => {
    fs.copyFileSync(process.env.PICO_WRONG_CAPTURE, artifactPath);
    return {
      status: "valid",
      binding: {
        kind: "pico.native-run-receipt",
        schemaVersion: 1,
        receiptId: process.env.PICO_BINDING_RECEIPT_ID,
        captureSha256: process.env.PICO_BINDING_CAPTURE_SHA256,
      },
    };
  }`;
  const source = `
    import fs from "node:fs";
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { registerLedgerTools } from ${JSON.stringify(LEDGER_MODULE)};
    const resolveRunReceiptBinding = ${resolverSource};
    const server = new McpServer({ name: "race-ledger-boundary", version: "0.0.0" });
    registerLedgerTools(server, { resolveRunReceiptBinding });
    await server.connect(new StdioServerTransport());
  `;
  const callJson = await startClient(t, ["--input-type=module", "--eval", source], {
    HOME: fixture.scratch,
    PICO_MCP_LEDGER_DIR: fixture.ledgerDir,
    PICO_MCP_RUN_RECEIPT_DIR: fixture.rootDir,
    PICO_WRONG_CAPTURE: wrongCapture,
    PICO_BINDING_RECEIPT_ID: published.receiptId,
    PICO_BINDING_CAPTURE_SHA256: fixture.payload.capture.sha256,
  });
  const result = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "path replacement between resolver and ledger materialization",
    evidenceType: "vision_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic race fixture text only; no rendered LOOK is claimed.",
    runReceiptId: published.receiptId,
  });
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /materialized|capture|sha256|binding|changed/i);
  assertEveryEvidenceBucketEmpty(await callJson("ledger_report", { app: FIXTURE_APP }));
});
