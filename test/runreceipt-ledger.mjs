import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as store from "../dist/runreceiptstore.js";
import {
  FIXTURE_APP,
  MANUAL_NON_EMULATOR_RUNTIME,
  createRunReceiptFixture,
  makePng,
} from "./helpers/runreceipt-fixture.mjs";
import * as ledger from "../dist/ledger.js";
import * as portable from "../dist/runreceiptportable.js";

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
  return startSurface(t, fixture, "full", extraEnv);
}

async function startSurface(t, fixture, surface, extraEnv = {}) {
  return startClient(t, ["dist/index.js"], {
    HOME: fixture.scratch,
    PICO_MCP_SURFACE: surface,
    PICO_MCP_LEDGER_DIR: fixture.ledgerDir,
    PICO_MCP_RUN_RECEIPT_DIR: fixture.rootDir,
    ...extraEnv,
  });
}

async function startFocusedLedger(t, fixture, resolverSource = "", extraEnv = {}) {
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
    ...extraEnv,
  });
}

async function startFocusedPromoter(t, fixture, promoterSource) {
  const source = `
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { registerLedgerTools } from ${JSON.stringify(LEDGER_MODULE)};
    const promoteNativeRunReceipt = ${promoterSource};
    const server = new McpServer({ name: "focused-promote-boundary", version: "0.0.0" });
    registerLedgerTools(server, { promoteNativeRunReceipt });
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

function promotionRoots(fixture, suffix) {
  const targetReceiptRoot = path.join(fixture.scratch, `${suffix}-receipt-store`);
  const targetLedgerRoot = path.join(fixture.scratch, `${suffix}-ledger-store`);
  fs.mkdirSync(targetReceiptRoot);
  fs.mkdirSync(targetLedgerRoot);
  return {
    targetReceiptRoot: fs.realpathSync(targetReceiptRoot),
    targetLedgerRoot: fs.realpathSync(targetLedgerRoot),
  };
}

async function createPortableLedgerFixture(t, options = {}) {
  const owned = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pico-ledger-portable-roots-"));
  t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
  return createRunReceiptFixture(t, store, {
    ...options,
    rootDir: path.join(owned, "receipt-store"),
    ledgerDir: path.join(owned, "ledger-store"),
  });
}

function promotionAction(fixture, published, target) {
  return {
    app: FIXTURE_APP,
    action: "promote",
    sourceReceiptId: published.receiptId,
    sourceReceiptRoot: fs.realpathSync(fixture.rootDir),
    sourceLedgerRoot: fs.realpathSync(fixture.ledgerDir),
    targetReceiptRoot: target.targetReceiptRoot,
    targetLedgerRoot: target.targetLedgerRoot,
  };
}

function expectedPortableBinding(fixture, published, promoted) {
  return {
    kind: "pico.portable-native-run-receipt",
    schemaVersion: 1,
    receiptId: promoted.portableReceiptId,
    sourceReceiptId: published.receiptId,
    promotionId: promoted.promotionId,
    auditId: promoted.auditId,
    captureSha256: fixture.payload.capture.sha256,
  };
}

function assertPromotionResult(result, action, fixture) {
  assert.equal(result.status, "promoted", result.reason);
  for (const identity of ["portableReceiptId", "promotionId", "auditId"]) {
    assert.match(result[identity], /^[a-f0-9]{64}$/);
  }
  assert.equal(result.apkArtifactPath, path.join(action.targetReceiptRoot, "artifacts", "apk", `${fixture.payload.apk.sha256}.apk`));
  assert.equal(result.effectiveAppSpecArtifactPath, path.join(action.targetReceiptRoot, "artifacts", "spec", `${fixture.payload.source.effectiveAppSpec.sha256}.json`));
  assert.equal(result.captureArtifactPath, path.join(action.targetLedgerRoot, "artifacts", `${fixture.payload.capture.sha256}.png`));
  assert.equal(result.lineageReceiptPath, path.join(action.targetReceiptRoot, "portable-lineage-v1", action.app, `${action.sourceReceiptId}.json`));
  assert.equal(result.portableReceiptPath, path.join(action.targetReceiptRoot, "portable-v1", action.app, `${result.portableReceiptId}.json`));
  assert.equal(result.promotionManifestPath, path.join(action.targetReceiptRoot, "promotions-v1", action.app, `${result.promotionId}.json`));
  for (const pathname of [
    result.apkArtifactPath,
    result.effectiveAppSpecArtifactPath,
    result.captureArtifactPath,
    result.lineageReceiptPath,
    result.portableReceiptPath,
    result.promotionManifestPath,
  ]) assert.equal(fs.statSync(pathname).isFile(), true);
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

function ledgerPath(fixture) {
  return path.join(fixture.ledgerDir, `${fixture.payload.app}.json`);
}

function mutateLedger(fixture, mutate) {
  const file = ledgerPath(fixture);
  const events = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(events);
  fs.writeFileSync(file, `${JSON.stringify(events, null, 2)}\n`);
}

function writeFakeAdb(fixture, identity = MANUAL_NON_EMULATOR_RUNTIME) {
  const fakeAdb = path.join(fixture.scratch, "fake-adb.mjs");
  fs.writeFileSync(fakeAdb, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const serial = args[1] ?? "";
if (args.includes("getprop")) {
  const values = {
    "ro.product.model": ${JSON.stringify(identity.model)},
    "ro.build.fingerprint": ${JSON.stringify(identity.fingerprint)},
    "ro.boot.qemu": ${JSON.stringify(identity.bootQemu)},
  };
  process.stdout.write((values[args.at(-1)] ?? "") + "\\n");
} else if (args.includes("screencap") && serial === ${JSON.stringify(identity.serial)}) {
  if (process.env.PICO_SCREENCAP_MARKER) fs.writeFileSync(process.env.PICO_SCREENCAP_MARKER, "called\\n");
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
  const callJson = await startFullSurface(t, fixture);

  const resolved = store.validateNativeRunReceiptCaptureBinding(
    FIXTURE_APP,
    published.receiptId,
    fixture.captureSourcePath,
    fixture.storeOptions,
  );
  assert.equal(resolved.status, "valid");
  assert.deepEqual(Object.keys(resolved.binding).sort(), ["captureSha256", "kind", "receiptId", "schemaVersion"]);
  assert.deepEqual(resolved.receiptRuntime, {
    serial: fixture.payload.runtime.serial,
    model: fixture.payload.runtime.model,
    fingerprint: fixture.payload.runtime.fingerprint,
    bootQemu: fixture.payload.runtime.bootQemu,
  });
  assert.equal(Object.isFrozen(resolved.receiptRuntime), true);

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
  assert.equal(report.capabilityReport.matrix.deviceVerified.length, 0);
  assert.equal(report.capabilityReport.matrix.autoJudged.length, 0);
  assert.equal(report.capabilityReport.matrix.structuralOnly.length, 2);
  const reportedVision = report.ledger.find((entry) => entry.seq === vision.entry.seq);
  const historicalVision = report.history.find((entry) => entry.seq === vision.entry.seq);
  assert.equal(reportedVision.evidenceType, "vision_verified");
  assert.deepEqual(Object.keys(reportedVision.runReceipt).sort(), ["captureSha256", "kind", "receiptId", "schemaVersion"]);
  assert.deepEqual(Object.keys(historicalVision.runReceipt).sort(), ["captureSha256", "kind", "receiptId", "schemaVersion"]);
  assert.equal(JSON.stringify(report).includes("receiptRuntime"), false);
  assert.equal(report.ledger.find((entry) => entry.seq === structural.entry.seq).evidenceType, "structural");
});

test("device receipt admission rejects emulator and mismatched runtime before screencap, then accepts only an exact manual non-emulator fixture", async (t) => {
  const cases = [
    {
      name: "emulator receipt runtime",
      receiptRuntime: undefined,
      liveRuntime: MANUAL_NON_EMULATOR_RUNTIME,
      expected: /receipt.*(?:emulator|qemu)|(?:emulator|qemu).*receipt/i,
    },
    {
      name: "different serial",
      receiptRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, bootQemu: "0" },
      liveRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, serial: "PA9K1OTHERFIXTURE", bootQemu: "0" },
      expected: /receipt.*serial|serial.*receipt/i,
    },
    {
      name: "different model",
      receiptRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, bootQemu: "0" },
      liveRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, model: "PICO Swan other fixture", bootQemu: "0" },
      expected: /receipt.*model|model.*receipt/i,
    },
    {
      name: "different fingerprint",
      receiptRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, bootQemu: "0" },
      liveRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, fingerprint: "Pico/swan/swan:16/OTHER/2:user/release-keys", bootQemu: "0" },
      expected: /receipt.*fingerprint|fingerprint.*receipt/i,
    },
    {
      name: "different bootQemu",
      receiptRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, bootQemu: "0" },
      liveRuntime: MANUAL_NON_EMULATOR_RUNTIME,
      expected: /receipt.*bootQemu|bootQemu.*receipt/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (child) => {
      const fixture = await createRunReceiptFixture(child, store, {
        ...(scenario.receiptRuntime ? { runtimeIdentity: scenario.receiptRuntime } : {}),
      });
      const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
      const marker = path.join(fixture.scratch, "screencap-called");
      const fakeAdb = writeFakeAdb(fixture, scenario.liveRuntime);
      const callJson = await startFullSurface(child, fixture, {
        PICO_ADB: fakeAdb,
        PICO_DEVICE_FIXTURE_PATH: fixture.captureSourcePath,
        PICO_SCREENCAP_MARKER: marker,
      });
      const recorded = await callJson("record_verification", {
        app: FIXTURE_APP,
        claim: `synthetic ${scenario.name} receipt admission fixture`,
        evidenceType: "device_verified",
        artifactPath: fixture.captureSourcePath,
        attestation: "Synthetic contract fixture only; no hardware observation is claimed.",
        deviceSerial: scenario.liveRuntime.serial,
        deviceFeature: "controller_ray",
        deviceOutcome: "pass",
        runReceiptId: published.receiptId,
      });
      assert.equal(recorded.status, "rejected");
      assert.match(recorded.reason, scenario.expected);
      assert.equal(fs.existsSync(marker), false, "receipt lineage must reject before live screencap");
    });
  }

  await t.test("exact manual non-emulator runtime", async (child) => {
    const fixture = await createRunReceiptFixture(child, store, { runtimeIdentity: MANUAL_NON_EMULATOR_RUNTIME });
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const marker = path.join(fixture.scratch, "screencap-called");
    const fakeAdb = writeFakeAdb(fixture);
    const callJson = await startFullSurface(child, fixture, {
      PICO_ADB: fakeAdb,
      PICO_DEVICE_FIXTURE_PATH: fixture.captureSourcePath,
      PICO_SCREENCAP_MARKER: marker,
    });
    const recorded = await callJson("record_verification", {
      app: FIXTURE_APP,
      claim: "synthetic exact non-emulator receipt runtime contract fixture",
      evidenceType: "device_verified",
      artifactPath: fixture.captureSourcePath,
      attestation: "Synthetic same-byte contract fixture only; no hardware observation is claimed.",
      deviceSerial: MANUAL_NON_EMULATOR_RUNTIME.serial,
      deviceFeature: "controller_ray",
      deviceOutcome: "pass",
      runReceiptId: published.receiptId,
    });
    assert.equal(recorded.status, "recorded");
    assert.equal(recorded.entry.evidenceType, "device_verified");
    assert.deepEqual(recorded.entry.runReceipt, expectedBinding(published, fixture));
    assert.deepEqual(Object.keys(recorded.entry.runReceipt).sort(), ["captureSha256", "kind", "receiptId", "schemaVersion"]);
    assert.equal("receiptRuntime" in recorded.entry, false);
    assert.equal(fs.existsSync(marker), true);
  });
});

test("ledger reads strip bindings unless an injected historical validator re-earns them", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const fullCall = await startFullSurface(t, fixture);
  const recorded = await fullCall("record_verification", {
    app: FIXTURE_APP,
    claim: "synthetic default read binding fixture",
    evidenceType: "vision_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic fixture wording only; no rendered LOOK is claimed.",
    runReceiptId: published.receiptId,
  });
  assert.equal(recorded.status, "recorded");

  const noValidatorCall = await startFocusedLedger(t, fixture);
  const stripped = await noValidatorCall("ledger_report", { app: FIXTURE_APP });
  assert.equal(stripped.ledger[0].evidenceType, "vision_verified");
  assert.equal("runReceipt" in stripped.ledger[0], false);
  assert.equal("runReceipt" in stripped.history[0], false);
  assert.deepEqual(stripped.ledger[0].claimedRunReceipt, expectedBinding(published, fixture));
  assert.deepEqual(Object.keys(stripped.ledger[0].claimedRunReceipt).sort(), ["captureSha256", "kind", "receiptId", "schemaVersion"]);
  assert.deepEqual(stripped.history[0].claimedRunReceipt, expectedBinding(published, fixture));
  const approvedNoValidatorDiagnostic = {
    status: "unverifiable",
    reason: "runReceipt binding cannot be consumed because no historical receipt validator is configured",
  };
  assert.deepEqual(stripped.ledger[0].runReceiptProvenance, approvedNoValidatorDiagnostic);
  assert.deepEqual(stripped.history[0].runReceiptProvenance, approvedNoValidatorDiagnostic);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped.ledger[0], "receiptRuntime"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped.history[0], "receiptRuntime"), false);
  assert.equal(stripped.runReceiptIssues.length, 1);
  assert.match(stripped.runReceiptIssues[0].reason, /historical.*validator|validator.*configured/i);
  assert.equal(stripped.capabilityReport.matrix.visuallyVerified.length, 1);

  const validated = await fullCall("ledger_report", { app: FIXTURE_APP });
  assert.deepEqual(validated.ledger[0].runReceipt, expectedBinding(published, fixture));
  assert.equal(validated.runReceiptIssues.length, 0);
});

test("ledger reports erase every malformed persisted runReceipt without leaking private-shaped fields", async (t) => {
  const privateMarker = "must-not-cross-the-public-ledger-boundary";
  const cases = [
    ["null", () => null],
    ["false", () => false],
    ["zero", () => 0],
    ["empty string", () => ""],
    ["runtime-bearing object", (captureSha256) => ({
      kind: "pico.native-run-receipt",
      schemaVersion: 1,
      receiptId: ZERO_HASH,
      captureSha256,
      receiptRuntime: {
        serial: privateMarker,
        model: "private model",
        fingerprint: "private/fingerprint",
        bootQemu: "1",
      },
    })],
  ];

  for (const [name, malformedBinding] of cases) {
    await t.test(name, async (child) => {
      const fixture = await createRunReceiptFixture(child, store);
      const callJson = await startFullSurface(child, fixture);
      const recorded = await callJson("record_verification", {
        app: FIXTURE_APP,
        claim: `synthetic malformed ${name} receipt-binding fixture`,
        evidenceType: "vision_verified",
        artifactPath: fixture.captureSourcePath,
        attestation: "Synthetic fixture wording only; no rendered LOOK is claimed.",
      });
      assert.equal(recorded.status, "recorded");
      mutateLedger(fixture, (events) => {
        events[0].runReceipt = malformedBinding(recorded.entry.capture.sha256);
      });

      const report = await callJson("ledger_report", { app: FIXTURE_APP });
      assert.equal(report.ledger[0].evidenceType, "vision_verified");
      assert.equal(Object.prototype.hasOwnProperty.call(report.ledger[0], "runReceipt"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(report.history[0], "runReceipt"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(report.ledger[0], "claimedRunReceipt"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(report.history[0], "claimedRunReceipt"), false);
      assert.equal(report.runReceiptIssues.length, 1);
      assert.match(report.runReceiptIssues[0].reason, /runReceipt binding/i);
      assert.equal(report.capabilityReport.matrix.visuallyVerified.length, 1);
      assert.equal(JSON.stringify(report).includes("receiptRuntime"), false);
      assert.equal(JSON.stringify(report).includes(privateMarker), false);
    });
  }
});

test("ledger reports discard every persisted receipt diagnostic and synthesize only current validation results", async (t) => {
  const privateMarker = "persisted-claimed-runtime-must-not-leak";
  const maliciousClaimedBinding = {
    receiptRuntime: {
      serial: privateMarker,
      model: "private model",
      fingerprint: "private/fingerprint",
      bootQemu: "1",
    },
  };
  const maliciousProvenance = {
    status: "validated",
    reason: privateMarker,
    receiptRuntime: maliciousClaimedBinding.receiptRuntime,
  };
  const injectPersistedDiagnostics = (entry) => {
    entry.claimedRunReceipt = maliciousClaimedBinding;
    entry.runReceiptProvenance = maliciousProvenance;
    entry.receiptRuntime = maliciousClaimedBinding.receiptRuntime;
  };
  const assertDiagnosticsRemoved = (entry) => {
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "claimedRunReceipt"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "runReceiptProvenance"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "receiptRuntime"), false);
  };

  await t.test("persisted diagnostics without runReceipt", async (child) => {
    const fixture = await createRunReceiptFixture(child, store);
    const callJson = await startFullSurface(child, fixture);
    const recorded = await callJson("record_verification", {
      app: FIXTURE_APP,
      claim: "synthetic persisted claimed-only receipt fixture",
      evidenceType: "vision_verified",
      artifactPath: fixture.captureSourcePath,
      attestation: "Synthetic fixture wording only; no rendered LOOK is claimed.",
    });
    assert.equal(recorded.status, "recorded");
    mutateLedger(fixture, (events) => {
      injectPersistedDiagnostics(events[0]);
    });

    const report = await callJson("ledger_report", { app: FIXTURE_APP });
    assertDiagnosticsRemoved(report.ledger[0]);
    assertDiagnosticsRemoved(report.history[0]);
    assert.equal(report.ledger[0].evidenceType, "vision_verified");
    assert.equal(report.runReceiptIssues.length, 0);
    assert.equal(report.capabilityReport.matrix.visuallyVerified.length, 1);
    assert.equal(JSON.stringify(report).includes(privateMarker), false);
  });

  await t.test("valid runReceipt beside persisted diagnostics", async (child) => {
    const fixture = await createRunReceiptFixture(child, store);
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const callJson = await startFullSurface(child, fixture);
    const recorded = await callJson("record_verification", {
      app: FIXTURE_APP,
      claim: "synthetic valid receipt with persisted claimed-field fixture",
      evidenceType: "vision_verified",
      artifactPath: fixture.captureSourcePath,
      attestation: "Synthetic fixture wording only; no rendered LOOK is claimed.",
      runReceiptId: published.receiptId,
    });
    assert.equal(recorded.status, "recorded");
    mutateLedger(fixture, (events) => {
      injectPersistedDiagnostics(events[0]);
    });

    const report = await callJson("ledger_report", { app: FIXTURE_APP });
    assert.deepEqual(report.ledger[0].runReceipt, expectedBinding(published, fixture));
    assertDiagnosticsRemoved(report.ledger[0]);
    assertDiagnosticsRemoved(report.history[0]);
    assert.deepEqual(report.history[0].runReceipt, expectedBinding(published, fixture));
    assert.equal(report.ledger[0].evidenceType, "vision_verified");
    assert.equal(report.runReceiptIssues.length, 0);
    assert.equal(JSON.stringify(report).includes(privateMarker), false);
  });
});

test("public ledger reports fail closed on every historical receipt artifact while preserving independent LOOK evidence", async (t) => {
  const cases = [
    ["receipt JSON", (fixture, published) => fs.writeFileSync(published.receiptPath, "{}\n"), /receipt|schema|kind|JSON/i],
    ["APK CAS", (fixture) => fs.writeFileSync(fixture.payload.apk.artifactPath, "changed apk CAS"), /APK.*(?:sha256|byte)|(?:sha256|byte).*APK/i],
    ["effective AppSpec CAS", (fixture) => fs.writeFileSync(fixture.payload.source.effectiveAppSpec.artifactPath, "{}\n"), /effective AppSpec/i],
    ["binding receipt ID", (fixture) => mutateLedger(fixture, (events) => { events[0].runReceipt.receiptId = ZERO_HASH; }), /receipt|exist|ID/i],
    ["binding capture hash", (fixture) => mutateLedger(fixture, (events) => { events[0].runReceipt.captureSha256 = ZERO_HASH; }), /capture.*sha256/i],
  ];

  for (const [name, mutate, expectedIssue] of cases) {
    await t.test(name, async (child) => {
      const fixture = await createRunReceiptFixture(child, store);
      const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
      const callJson = await startFullSurface(child, fixture);
      const recorded = await callJson("record_verification", {
        app: FIXTURE_APP,
        claim: `synthetic historical ${name} fixture`,
        evidenceType: "vision_verified",
        artifactPath: fixture.captureSourcePath,
        attestation: "Synthetic fixture wording only; no rendered LOOK is claimed.",
        runReceiptId: published.receiptId,
      });
      assert.equal(recorded.status, "recorded");
      mutate(fixture, published);

      const report = await callJson("ledger_report", { app: FIXTURE_APP });
      assert.equal(report.ledger[0].evidenceType, "vision_verified");
      assert.equal("runReceipt" in report.ledger[0], false);
      assert.equal("runReceipt" in report.history[0], false);
      assert.equal(report.runReceiptIssues.length, 1);
      assert.match(report.runReceiptIssues[0].reason, expectedIssue);
      assert.equal(report.capabilityReport.matrix.visuallyVerified.length, 1);
    });
  }

  await t.test("shared capture CAS", async (child) => {
    const fixture = await createRunReceiptFixture(child, store);
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const callJson = await startFullSurface(child, fixture);
    const recorded = await callJson("record_verification", {
      app: FIXTURE_APP,
      claim: "synthetic shared capture CAS fixture",
      evidenceType: "vision_verified",
      artifactPath: fixture.captureSourcePath,
      attestation: "Synthetic fixture wording only; no rendered LOOK is claimed.",
      runReceiptId: published.receiptId,
    });
    assert.equal(recorded.status, "recorded");
    fs.writeFileSync(fixture.captureArtifactPath, makePng(201));

    const report = await callJson("ledger_report", { app: FIXTURE_APP });
    assert.equal(report.ledger[0].evidenceType, "provenance-broken");
    assert.equal("runReceipt" in report.ledger[0], false);
    assert.equal(report.runReceiptIssues.length, 1);
    assert.equal(report.capabilityReport.matrix.visuallyVerified.length, 0);
    assert.equal(report.capabilityReport.matrix.structuralOnly.length, 1);
  });

  await t.test("receipt belonging to another app", async (child) => {
    const fixture = await createRunReceiptFixture(child, store);
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const other = await createRunReceiptFixture(child, store, {
      app: "com.example.otherreceipt",
      rootDir: fixture.rootDir,
      ledgerDir: fixture.ledgerDir,
    });
    const otherPublished = store.publishNativeRunReceipt(other.payload, other.storeOptions);
    const callJson = await startFullSurface(child, fixture);
    const recorded = await callJson("record_verification", {
      app: FIXTURE_APP,
      claim: "synthetic cross-app historical binding fixture",
      evidenceType: "vision_verified",
      artifactPath: fixture.captureSourcePath,
      attestation: "Synthetic fixture wording only; no rendered LOOK is claimed.",
      runReceiptId: published.receiptId,
    });
    assert.equal(recorded.status, "recorded");
    mutateLedger(fixture, (events) => {
      events[0].runReceipt.receiptId = otherPublished.receiptId;
      events[0].runReceipt.captureSha256 = other.payload.capture.sha256;
    });

    const report = await callJson("ledger_report", { app: FIXTURE_APP });
    assert.equal(report.ledger[0].evidenceType, "vision_verified");
    assert.equal("runReceipt" in report.ledger[0], false);
    assert.equal(report.runReceiptIssues.length, 1);
    assert.match(report.runReceiptIssues[0].reason, /receipt|exist|app/i);
  });

  await t.test("broken APK CAS preserves independently intact device evidence but strips its binding", async (child) => {
    const fixture = await createRunReceiptFixture(child, store, { runtimeIdentity: MANUAL_NON_EMULATOR_RUNTIME });
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const fakeAdb = writeFakeAdb(fixture);
    const callJson = await startFullSurface(child, fixture, {
      PICO_ADB: fakeAdb,
      PICO_DEVICE_FIXTURE_PATH: fixture.captureSourcePath,
    });
    const recorded = await callJson("record_verification", {
      app: FIXTURE_APP,
      claim: "synthetic device evidence independent from later APK CAS integrity",
      evidenceType: "device_verified",
      artifactPath: fixture.captureSourcePath,
      attestation: "Synthetic same-byte contract fixture only; no hardware observation is claimed.",
      deviceSerial: MANUAL_NON_EMULATOR_RUNTIME.serial,
      deviceFeature: "controller_ray",
      deviceOutcome: "pass",
      runReceiptId: published.receiptId,
    });
    assert.equal(recorded.status, "recorded");
    fs.writeFileSync(fixture.payload.apk.artifactPath, "changed apk CAS");

    const report = await callJson("ledger_report", { app: FIXTURE_APP });
    assert.equal(report.ledger[0].evidenceType, "device_verified");
    assert.equal(report.ledger[0].deviceLineage.status, "validated");
    assert.equal("runReceipt" in report.ledger[0], false);
    assert.equal(report.runReceiptIssues.length, 1);
    assert.equal(report.capabilityReport.matrix.deviceVerified.length, 1);
  });
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
      receiptRuntime: {
        serial: "emulator-5554",
        model: "PICO Emulator",
        fingerprint: "PICO/PICO_Emulator/PICO_Emulator:14/fixture/test-keys",
        bootQemu: "1",
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

test("promote action is disjoint on the full surface and Door 13 and never touches the evidence ledger", async (t) => {
  const fixture = await createPortableLedgerFixture(t);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const appLedger = ledgerPath(fixture);
  const poisonedLedger = Buffer.from("{this is deliberately not a ledger\n", "utf8");
  fs.writeFileSync(appLedger, poisonedLedger);

  const fullTarget = promotionRoots(fixture, "full-action");
  const fullAction = promotionAction(fixture, published, fullTarget);
  const fullCall = await startFullSurface(t, fixture);
  const fullPromoted = await fullCall("record_verification", fullAction);
  assertPromotionResult(fullPromoted, fullAction, fixture);
  assert.deepEqual(fs.readFileSync(appLedger), poisonedLedger, "successful promotion must return before loading or appending the ledger");

  const refused = await fullCall("record_verification", { ...fullAction, sourceReceiptId: ZERO_HASH });
  assert.equal(refused.status, "refused");
  assert.deepEqual(fs.readFileSync(appLedger), poisonedLedger, "refused promotion must leave an existing ledger byte-identical");

  const unavailableCall = await startFullSurface(t, fixture, {
    PICO_MCP_RECEIPT_PORTABILITY_PYTHON: path.join(fixture.scratch, "missing-python"),
  });
  const unavailable = await unavailableCall("record_verification", fullAction);
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(fs.readFileSync(appLedger), poisonedLedger, "unavailable promotion must leave an existing ledger byte-identical");

  const throwingCall = await startFocusedPromoter(t, fixture, `async () => { throw new Error("synthetic promoter throw"); }`);
  const threw = await throwingCall("record_verification", fullAction);
  assert.equal(threw.status, "rejected");
  assert.match(threw.reason, /promot|synthetic promoter throw/i);
  assert.deepEqual(fs.readFileSync(appLedger), poisonedLedger, "a throwing promoter must leave an existing ledger byte-identical");

  const promoteMixed = await fullCall("record_verification", {
    ...fullAction,
    claim: "promotion must not accept record fields",
    evidenceType: "vision_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic mutual-exclusion fixture; no rendered LOOK is claimed.",
    cClass: "C0_emulator",
    reproHash: "synthetic",
    runReceiptId: published.receiptId,
    runReceiptPromotionId: fullPromoted.promotionId,
    deviceSerial: "fixture",
    deviceModel: "fixture",
    deviceFingerprint: "fixture/fingerprint",
    deviceBootQemu: "1",
    deviceFeature: "controller_ray",
    deviceOutcome: "fail",
    targetSeq: 0,
    retractionReason: "synthetic mixed action",
    retractionNote: "synthetic mixed action note",
  });
  assert.equal(promoteMixed.status, "rejected");
  assert.match(promoteMixed.reason, /mutually exclusive|promote-only|record-only|retract/i);

  const recordMixed = await fullCall("record_verification", {
    ...fullAction,
    action: "record",
    claim: "record must reject every promotion-only field",
    evidenceType: "structural",
  });
  assert.equal(recordMixed.status, "rejected");
  assert.match(recordMixed.reason, /mutually exclusive|promotion-only/i);

  const retractMixed = await fullCall("record_verification", {
    ...fullAction,
    action: "retract",
    targetSeq: 0,
    retractionReason: "retract must reject every promotion-only field",
  });
  assert.equal(retractMixed.status, "rejected");
  assert.match(retractMixed.reason, /mutually exclusive|promotion-only/i);
  assert.deepEqual(fs.readFileSync(appLedger), poisonedLedger);

  fs.rmSync(appLedger);
  const doorTarget = promotionRoots(fixture, "door-action");
  const doorAction = promotionAction(fixture, published, doorTarget);
  const doorCall = await startSurface(t, fixture, "doors");
  const doorPromoted = await doorCall("pico_record", doorAction);
  assertPromotionResult(doorPromoted, doorAction, fixture);
  assert.equal(fs.existsSync(appLedger), false, "Door promotion must not manufacture an evidence row");

  const doorReportMixed = await doorCall("pico_record", { ...doorAction, report: true });
  assert.equal(doorReportMixed.status, "rejected");
  assert.match(doorReportMixed.reason ?? doorReportMixed.error, /report|promote|mutually exclusive/i);
  assert.equal(fs.existsSync(appLedger), false, "Door report:true must reject rather than reading the ledger after promotion");
});

test("portable binding is an exact seven-field private capability with kind-specific resolution", async (t) => {
  const fixture = await createPortableLedgerFixture(t);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const target = promotionRoots(fixture, "portable-binding");
  const promoted = await portable.promoteNativeRunReceipt({
    app: FIXTURE_APP,
    sourceReceiptId: published.receiptId,
    sourceReceiptRoot: fs.realpathSync(fixture.rootDir),
    sourceLedgerRoot: fs.realpathSync(fixture.ledgerDir),
    ...target,
  });
  assert.equal(promoted.status, "promoted", promoted.reason);
  const expected = expectedPortableBinding(fixture, published, promoted);
  const targetFixture = { ...fixture, rootDir: target.targetReceiptRoot, ledgerDir: target.targetLedgerRoot };
  const callJson = await startFullSurface(t, targetFixture);

  const recorded = await callJson("record_verification", {
    app: FIXTURE_APP,
    claim: "synthetic portable exact-frame receipt-binding contract fixture",
    evidenceType: "vision_verified",
    artifactPath: promoted.captureArtifactPath,
    attestation: "Synthetic portable fixture text only; no rendered LOOK or visual result is claimed.",
    runReceiptId: promoted.portableReceiptId,
    runReceiptPromotionId: promoted.promotionId,
  });
  assert.equal(recorded.status, "recorded", recorded.reason);
  assert.deepEqual(recorded.entry.runReceipt, expected);
  assert.deepEqual(Object.keys(recorded.entry.runReceipt).sort(), [
    "auditId", "captureSha256", "kind", "promotionId", "receiptId", "schemaVersion", "sourceReceiptId",
  ]);

  const report = await callJson("ledger_report", { app: FIXTURE_APP });
  assert.deepEqual(report.ledger[0].runReceipt, expected);
  assert.deepEqual(report.history[0].runReceipt, expected);
  assert.equal(report.runReceiptIssues.length, 0);
  assert.equal(JSON.stringify(report).includes("receiptRuntime"), false);

  const callerMade = ledger.appendLedgerEntry(FIXTURE_APP, {
    claim: "caller-shaped portable capability must fail",
    evidenceType: "vision_verified",
    artifactPath: promoted.captureArtifactPath,
    attestation: "Synthetic private-capability fixture; no rendered LOOK is claimed.",
    runReceiptBinding: {
      binding: expected,
      receiptRuntime: fixture.payload.runtime,
    },
  });
  assert.equal(callerMade.status, "rejected");
  assert.match(callerMade.reason, /private|capability|resolver-origin/i);

  const wrongCapture = path.join(fixture.scratch, "portable-wrong-capture.png");
  fs.writeFileSync(wrongCapture, makePng(231));
  const rejectedInputs = [
    {
      name: "promotion-only input",
      args: { runReceiptPromotionId: promoted.promotionId, artifactPath: promoted.captureArtifactPath },
    },
    {
      name: "portable receipt without promotion",
      args: { runReceiptId: promoted.portableReceiptId, artifactPath: promoted.captureArtifactPath },
    },
    {
      name: "native receipt with promotion",
      args: { runReceiptId: published.receiptId, runReceiptPromotionId: promoted.promotionId, artifactPath: promoted.captureArtifactPath },
    },
    {
      name: "wrong promotion",
      args: { runReceiptId: promoted.portableReceiptId, runReceiptPromotionId: ZERO_HASH, artifactPath: promoted.captureArtifactPath },
    },
    {
      name: "wrong image",
      args: { runReceiptId: promoted.portableReceiptId, runReceiptPromotionId: promoted.promotionId, artifactPath: wrongCapture },
    },
  ];
  for (const scenario of rejectedInputs) {
    const result = await callJson("record_verification", {
      app: FIXTURE_APP,
      claim: `synthetic ${scenario.name} portable-binding fixture`,
      evidenceType: "vision_verified",
      attestation: "Synthetic rejection fixture text only; no rendered LOOK is claimed.",
      ...scenario.args,
    });
    assert.equal(result.status, "rejected", `${scenario.name}: ${result.reason}`);
    assert.match(result.reason, /binding|capture|promotion|receipt|selector|requires|invalid|exist/i, scenario.name);
  }

  const ledgerFile = ledgerPath(targetFixture);
  const intactLedger = fs.readFileSync(ledgerFile);
  const noValidatorCall = await startFocusedLedger(t, targetFixture);
  const stripped = await noValidatorCall("ledger_report", { app: FIXTURE_APP });
  assert.equal("runReceipt" in stripped.ledger[0], false);
  assert.equal("runReceipt" in stripped.history[0], false);
  assert.equal("claimedRunReceipt" in stripped.ledger[0], false);
  assert.equal("claimedRunReceipt" in stripped.history[0], false);
  const strippedJson = JSON.stringify(stripped);
  assert.equal(strippedJson.includes(published.receiptId), false);
  assert.equal(strippedJson.includes(promoted.promotionId), false);
  assert.equal(strippedJson.includes(promoted.auditId), false);

  const eventsWithExtra = JSON.parse(intactLedger.toString("utf8"));
  eventsWithExtra[0].runReceipt.portablePrivateMarker = "must-not-leak";
  fs.writeFileSync(ledgerFile, `${JSON.stringify(eventsWithExtra, null, 2)}\n`);
  const strictReport = await callJson("ledger_report", { app: FIXTURE_APP });
  assert.equal("runReceipt" in strictReport.ledger[0], false);
  assert.equal("claimedRunReceipt" in strictReport.ledger[0], false);
  assert.equal(JSON.stringify(strictReport).includes("must-not-leak"), false);

  const eventsWithWrongAudit = JSON.parse(intactLedger.toString("utf8"));
  eventsWithWrongAudit[0].runReceipt.auditId = ZERO_HASH;
  fs.writeFileSync(ledgerFile, `${JSON.stringify(eventsWithWrongAudit, null, 2)}\n`);
  const wrongAuditReport = await callJson("ledger_report", { app: FIXTURE_APP });
  assert.equal("runReceipt" in wrongAuditReport.ledger[0], false);
  assert.equal("claimedRunReceipt" in wrongAuditReport.ledger[0], false);
  assert.equal(wrongAuditReport.runReceiptIssues.length, 1);
  assert.equal(JSON.stringify(wrongAuditReport).includes(published.receiptId), false);
  assert.equal(JSON.stringify(wrongAuditReport).includes(promoted.promotionId), false);
  fs.writeFileSync(ledgerFile, intactLedger);

  const raceCapture = path.join(fixture.scratch, "portable-race-capture.png");
  fs.copyFileSync(promoted.captureArtifactPath, raceCapture);
  const raceResolver = `(app, selector, artifactPath) => {
    fs.copyFileSync(process.env.PICO_WRONG_CAPTURE, artifactPath);
    return {
      status: "valid",
      binding: {
        kind: "pico.portable-native-run-receipt",
        schemaVersion: 1,
        receiptId: process.env.PICO_BINDING_RECEIPT_ID,
        sourceReceiptId: process.env.PICO_BINDING_SOURCE_RECEIPT_ID,
        promotionId: process.env.PICO_BINDING_PROMOTION_ID,
        auditId: process.env.PICO_BINDING_AUDIT_ID,
        captureSha256: process.env.PICO_BINDING_CAPTURE_SHA256,
      },
      receiptRuntime: {
        serial: "emulator-5554",
        model: "PICO Emulator",
        fingerprint: "PICO/PICO_Emulator/PICO_Emulator:14/fixture/test-keys",
        bootQemu: "1",
      },
    };
  }`;
  const raceCall = await startFocusedLedger(t, targetFixture, raceResolver, {
    PICO_WRONG_CAPTURE: wrongCapture,
    PICO_BINDING_RECEIPT_ID: promoted.portableReceiptId,
    PICO_BINDING_SOURCE_RECEIPT_ID: published.receiptId,
    PICO_BINDING_PROMOTION_ID: promoted.promotionId,
    PICO_BINDING_AUDIT_ID: promoted.auditId,
    PICO_BINDING_CAPTURE_SHA256: fixture.payload.capture.sha256,
  });
  const raced = await raceCall("record_verification", {
    app: FIXTURE_APP,
    claim: "portable path replacement between resolver and ledger materialization",
    evidenceType: "vision_verified",
    artifactPath: raceCapture,
    attestation: "Synthetic portable race fixture; no rendered LOOK is claimed.",
    runReceiptId: promoted.portableReceiptId,
    runReceiptPromotionId: promoted.promotionId,
  });
  assert.equal(raced.status, "rejected");
  assert.match(raced.reason, /materialized|capture|sha256|binding|changed/i);
  const afterRace = await callJson("ledger_report", { app: FIXTURE_APP });
  assert.equal(afterRace.historyEntryCount, 1);
  assert.deepEqual(afterRace.ledger[0].runReceipt, expected);
});
