import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as store from "../dist/runreceiptstore.js";
import {
  MANUAL_NON_EMULATOR_RUNTIME,
  createRunReceiptFixture,
  makePng,
} from "./helpers/runreceipt-fixture.mjs";

const ZERO_HASH = "0".repeat(64);

async function startSurface(t, fixture, surface, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      HOME: fixture.scratch,
      PICO_MCP_SURFACE: surface,
      PICO_MCP_LEDGER_DIR: fixture.ledgerDir,
      PICO_MCP_RUN_RECEIPT_DIR: fixture.rootDir,
      ...extraEnv,
    },
  });
  const client = new Client({ name: `runreceipt-ship-${surface}`, version: "0.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    return JSON.parse(response.content[0].text);
  };
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

async function recordVision(callJson, fixture, published, withBinding = true) {
  const recorded = await callJson("record_verification", {
    app: fixture.payload.app,
    claim: "synthetic ship receipt contract fixture",
    evidenceType: "vision_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic fixture wording only; no rendered LOOK or visual result is claimed.",
    ...(withBinding ? { runReceiptId: published.receiptId } : {}),
  });
  assert.equal(recorded.status, "recorded");
  return recorded.entry;
}

function writeFakeDeviceAdb(fixture, liveRuntime = fixture.payload.runtime) {
  const fakeAdb = path.join(fixture.scratch, "fake-device-adb.mjs");
  fs.writeFileSync(fakeAdb, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const serial = args[1] ?? "";
if (args.includes("getprop")) {
  const values = {
    "ro.product.model": ${JSON.stringify(liveRuntime.model)},
    "ro.build.fingerprint": ${JSON.stringify(liveRuntime.fingerprint)},
    "ro.boot.qemu": ${JSON.stringify(liveRuntime.bootQemu)},
  };
  process.stdout.write((values[args.at(-1)] ?? "") + "\\n");
} else if (args.includes("screencap") && serial === ${JSON.stringify(liveRuntime.serial)}) {
  process.stdout.write(fs.readFileSync(process.env.PICO_DEVICE_FIXTURE_PATH));
} else {
  process.stderr.write("unsupported fixture adb invocation: " + args.join(" "));
  process.exitCode = 2;
}
`);
  fs.chmodSync(fakeAdb, 0o755);
  return fakeAdb;
}

async function recordDevice(callJson, fixture, published, outcome) {
  const recorded = await callJson("record_verification", {
    app: fixture.payload.app,
    claim: `synthetic receipt-linked device ${outcome} contract fixture`,
    evidenceType: "device_verified",
    artifactPath: fixture.captureSourcePath,
    attestation: "Synthetic same-byte fixture only; no PICO hardware observation is claimed.",
    deviceSerial: fixture.payload.runtime.serial,
    deviceFeature: "controller_ray",
    deviceOutcome: outcome,
    runReceiptId: published.receiptId,
  });
  assert.equal(recorded.status, "recorded");
  return recorded.entry;
}

function attachReceiptBinding(fixture, published) {
  mutateLedger(fixture, (events) => {
    events[0].runReceipt = {
      kind: "pico.native-run-receipt",
      schemaVersion: 1,
      receiptId: published.receiptId,
      captureSha256: fixture.payload.capture.sha256,
    };
  });
}

function shipArgs(fixture, projectDir = fixture.projectDir) {
  return { app: fixture.payload.app, lane: "native", projectDir };
}

function assertReceiptBlocker(ship, present) {
  assert.equal(
    ship.blockers.some((line) => /no verified build receipt/i.test(line)),
    present,
    JSON.stringify(ship, null, 2),
  );
}

function assertReleaseBoundary(ship) {
  assert.match(ship.verdict, /^NOT READY/);
  assert.ok(ship.blockers.some((line) => /release/i.test(line)));
  assert.ok(ship.blockers.some((line) => /sign|store/i.test(line)));
}

test("native ship has no current receipt when no producer receipt was published", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const callJson = await startSurface(t, fixture, "full");
  const ship = await callJson("ship_checklist", shipArgs(fixture));

  assert.deepEqual(ship.receipt, { status: "no-current-receipt", rejectedCandidates: [] });
  assertReceiptBlocker(ship, true);
  assertReleaseBoundary(ship);
});

test("native ship keeps the receipt blocker until the current receipt has an exact linked LOOK", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const callJson = await startSurface(t, fixture, "full");
  const ship = await callJson("ship_checklist", shipArgs(fixture));

  assert.deepEqual(ship.receipt, {
    status: "needs-linked-look",
    receiptId: published.receiptId,
    receiptPath: published.receiptPath,
    apkSha256: fixture.payload.apk.sha256,
    captureSha256: fixture.payload.capture.sha256,
    rejectedCandidates: [],
  });
  assertReceiptBlocker(ship, true);
  assertReleaseBoundary(ship);
});

test("native ship accepts current debug bytes only with one exact receipt-linked vision LOOK", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const callJson = await startSurface(t, fixture, "full");
  const looked = await recordVision(callJson, fixture, published);
  const ship = await callJson("ship_checklist", shipArgs(fixture));

  assert.deepEqual(ship.receipt, {
    status: "accepted-current-bytes",
    receiptId: published.receiptId,
    receiptPath: published.receiptPath,
    apkSha256: fixture.payload.apk.sha256,
    captureSha256: fixture.payload.capture.sha256,
    linkedLook: { seq: looked.seq, evidenceType: "vision_verified" },
    rejectedCandidates: [],
  });
  assertReceiptBlocker(ship, false);
  assert.ok(ship.ready.some((line) => line.includes(published.receiptId)
    && line.includes(fixture.payload.apk.sha256)
    && line.includes(fixture.payload.capture.sha256)
    && line.includes(String(looked.seq))));
  assertReleaseBoundary(ship);
});

test("native ship accepts a receipt-linked passing device row but never a device failure", async (t) => {
  await t.test("passing device evidence", async (child) => {
    const fixture = await createRunReceiptFixture(child, store, { runtimeIdentity: MANUAL_NON_EMULATOR_RUNTIME });
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const fakeAdb = writeFakeDeviceAdb(fixture);
    const callJson = await startSurface(child, fixture, "full", {
      PICO_ADB: fakeAdb,
      PICO_DEVICE_FIXTURE_PATH: fixture.captureSourcePath,
    });
    const looked = await recordDevice(callJson, fixture, published, "pass");
    const ship = await callJson("ship_checklist", shipArgs(fixture));
    assert.equal(ship.receipt.status, "accepted-current-bytes");
    assert.deepEqual(ship.receipt.linkedLook, { seq: looked.seq, evidenceType: "device_verified" });
    assertReceiptBlocker(ship, false);
    assertReleaseBoundary(ship);
  });

  await t.test("failing device evidence", async (child) => {
    const fixture = await createRunReceiptFixture(child, store, { runtimeIdentity: MANUAL_NON_EMULATOR_RUNTIME });
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const fakeAdb = writeFakeDeviceAdb(fixture);
    const callJson = await startSurface(child, fixture, "full", {
      PICO_ADB: fakeAdb,
      PICO_DEVICE_FIXTURE_PATH: fixture.captureSourcePath,
    });
    await recordDevice(callJson, fixture, published, "fail");
    const ship = await callJson("ship_checklist", shipArgs(fixture));
    assert.equal(ship.receipt.status, "needs-linked-look");
    assertReceiptBlocker(ship, true);
    assert.ok(ship.blockers.some((line) => /device-verified failed outcome/i.test(line)));
  });
});

test("native ship independently rejects emulator or mismatched receipt runtime for device rows", async (t) => {
  const cases = [
    {
      name: "emulator receipt runtime",
      receiptRuntime: undefined,
      liveRuntime: MANUAL_NON_EMULATOR_RUNTIME,
    },
    {
      name: "different serial",
      receiptRuntime: MANUAL_NON_EMULATOR_RUNTIME,
      liveRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, serial: "PA9K1SHIPOTHER" },
    },
    {
      name: "different model",
      receiptRuntime: MANUAL_NON_EMULATOR_RUNTIME,
      liveRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, model: "PICO Swan ship other fixture" },
    },
    {
      name: "different fingerprint",
      receiptRuntime: MANUAL_NON_EMULATOR_RUNTIME,
      liveRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, fingerprint: "Pico/swan/swan:16/SHIPOTHER/2:user/release-keys" },
    },
    {
      name: "different bootQemu",
      receiptRuntime: MANUAL_NON_EMULATOR_RUNTIME,
      liveRuntime: { ...MANUAL_NON_EMULATOR_RUNTIME, bootQemu: "0" },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (child) => {
      const fixture = await createRunReceiptFixture(child, store, {
        ...(scenario.receiptRuntime ? { runtimeIdentity: scenario.receiptRuntime } : {}),
      });
      const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
      const fakeAdb = writeFakeDeviceAdb(fixture, scenario.liveRuntime);
      const callJson = await startSurface(child, fixture, "full", {
        PICO_ADB: fakeAdb,
        PICO_DEVICE_FIXTURE_PATH: fixture.captureSourcePath,
      });
      const unbound = await callJson("record_verification", {
        app: fixture.payload.app,
        claim: `synthetic ship ${scenario.name} defense fixture`,
        evidenceType: "device_verified",
        artifactPath: fixture.captureSourcePath,
        attestation: "Synthetic same-byte contract fixture only; no hardware observation is claimed.",
        deviceSerial: scenario.liveRuntime.serial,
        deviceFeature: "controller_ray",
        deviceOutcome: "pass",
      });
      assert.equal(unbound.status, "recorded");
      attachReceiptBinding(fixture, published);

      const report = await callJson("ledger_report", { app: fixture.payload.app });
      assert.equal(report.ledger[0].evidenceType, "device_verified");
      assert.equal(report.ledger[0].runReceipt.receiptId, published.receiptId);

      const ship = await callJson("ship_checklist", shipArgs(fixture));
      assert.equal(ship.receipt.status, "needs-linked-look");
      assertReceiptBlocker(ship, true);
    });
  }
});

test("nonmatching, nonvisual, retracted, and provenance-broken rows cannot satisfy the linked LOOK gate", async (t) => {
  const cases = [
    {
      name: "unlinked historical LOOK",
      prepare: async ({ callJson, fixture, published }) => recordVision(callJson, fixture, published, false),
    },
    {
      name: "wrong receipt ID",
      prepare: async ({ callJson, fixture, published }) => {
        await recordVision(callJson, fixture, published);
        mutateLedger(fixture, (events) => { events[0].runReceipt.receiptId = ZERO_HASH; });
      },
    },
    {
      name: "wrong receipt capture hash",
      prepare: async ({ callJson, fixture, published }) => {
        await recordVision(callJson, fixture, published);
        mutateLedger(fixture, (events) => { events[0].runReceipt.captureSha256 = ZERO_HASH; });
      },
    },
    {
      name: "wrong ledger capture hash",
      prepare: async ({ callJson, fixture, published }) => {
        await recordVision(callJson, fixture, published);
        mutateLedger(fixture, (events) => { events[0].capture.sha256 = ZERO_HASH; });
      },
    },
    ...["auto_judged", "structural", "usd_host_render", "logcat"].map((evidenceType) => ({
      name: `${evidenceType} row`,
      prepare: async ({ callJson, fixture, published }) => {
        await recordVision(callJson, fixture, published);
        mutateLedger(fixture, (events) => { events[0].evidenceType = evidenceType; });
      },
    })),
    {
      name: "retracted LOOK",
      prepare: async ({ callJson, fixture, published }) => {
        const looked = await recordVision(callJson, fixture, published);
        const retracted = await callJson("record_verification", {
          app: fixture.payload.app,
          action: "retract",
          targetSeq: looked.seq,
          retractionReason: "synthetic ship rejection fixture",
        });
        assert.equal(retracted.status, "recorded");
      },
    },
    {
      name: "provenance-broken LOOK",
      prepare: async ({ callJson, fixture, published }) => {
        await recordVision(callJson, fixture, published);
        mutateLedger(fixture, (events) => { events[0].capture.bytes += 1; });
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (child) => {
      const fixture = await createRunReceiptFixture(child, store);
      const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
      const callJson = await startSurface(child, fixture, "full");
      await scenario.prepare({ callJson, fixture, published });
      const ship = await callJson("ship_checklist", shipArgs(fixture));
      assert.equal(ship.receipt.status, "needs-linked-look");
      assertReceiptBlocker(ship, true);
    });
  }
});

test("every current-project, artifact, receipt, and capture drift prevents native receipt acceptance", async (t) => {
  const cases = [
    ["current authored AppSpec drift", (fixture) => {
      const brief = JSON.parse(fs.readFileSync(fixture.briefPath, "utf8"));
      brief.spec.meta.appName = "ChangedAfterReceipt";
      fs.writeFileSync(fixture.briefPath, JSON.stringify(brief));
    }, /authored AppSpec/i],
    ["current Gradle source drift", (fixture) => {
      fs.appendFileSync(fixture.payload.source.gradleInputs.projectDir + "/app/src/main/java/com/example/MainActivity.kt", "// drift\n");
    }, /Gradle input/i],
    ["current APK drift", (fixture) => {
      fs.appendFileSync(fixture.sourceApkPath, "apk drift");
    }, /current source APK/i],
    ["current AGP metadata drift", (fixture) => {
      fs.appendFileSync(fixture.outputMetadataPath, " \n");
    }, /AGP output metadata/i],
    ["receipt core tamper", (_fixture, published) => {
      fs.writeFileSync(published.receiptPath, "{}\n");
    }, /receipt|schema|kind/i],
    ["capture CAS tamper", (fixture) => {
      fs.writeFileSync(fixture.captureArtifactPath, makePng(199));
    }, /capture.*sha256|capture.*byte/i],
  ];

  for (const [name, mutate, expectedIssue] of cases) {
    await t.test(name, async (child) => {
      const fixture = await createRunReceiptFixture(child, store);
      const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
      const callJson = await startSurface(child, fixture, "full");
      await recordVision(callJson, fixture, published);
      mutate(fixture, published);
      const ship = await callJson("ship_checklist", shipArgs(fixture));
      assert.equal(ship.receipt.status, "no-current-receipt");
      assertReceiptBlocker(ship, true);
      assert.match(ship.receipt.rejectedCandidates.flatMap((candidate) => candidate.issues).join("\n"), expectedIssue);
    });
  }

  await t.test("wrong project path", async (child) => {
    const fixture = await createRunReceiptFixture(child, store);
    const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const callJson = await startSurface(child, fixture, "full");
    await recordVision(callJson, fixture, published);
    const wrongProject = path.join(fixture.scratch, "wrong-project");
    fs.mkdirSync(wrongProject);
    const ship = await callJson("ship_checklist", shipArgs(fixture, wrongProject));
    assert.equal(ship.receipt.status, "no-current-receipt");
    assertReceiptBlocker(ship, true);
    assert.match(ship.receipt.rejectedCandidates.flatMap((candidate) => candidate.issues).join("\n"), /project real path/i);
  });

  await t.test("unreadable receipt app directory", async (child) => {
    const fixture = await createRunReceiptFixture(child, store);
    store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
    const appDirectory = path.join(fixture.rootDir, "native-v1", fixture.payload.app);
    fs.chmodSync(appDirectory, 0o000);
    const callJson = await startSurface(child, fixture, "full");
    let ship;
    try {
      ship = await callJson("ship_checklist", shipArgs(fixture));
    } finally {
      fs.chmodSync(appDirectory, 0o700);
    }
    assert.equal(ship.receipt.status, "invalid-store");
    assert.match(ship.receipt.issues.join("\n"), /could not be read|permission/i);
    assertReceiptBlocker(ship, true);
  });
});

test("a corrupt older candidate is disclosed while a newer exact linked receipt is accepted", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const olderPayload = structuredClone(fixture.payload);
  olderPayload.createdAt = "2026-08-14T11:59:55.000Z";
  const older = store.publishNativeRunReceipt(olderPayload, fixture.storeOptions);
  fs.writeFileSync(older.receiptPath, "corrupt older receipt\n");
  const newer = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const callJson = await startSurface(t, fixture, "full");
  await recordVision(callJson, fixture, newer);
  const ship = await callJson("ship_checklist", shipArgs(fixture));

  assert.equal(ship.receipt.status, "accepted-current-bytes");
  assert.equal(ship.receipt.receiptId, newer.receiptId);
  assert.deepEqual(ship.receipt.rejectedCandidates.map((candidate) => candidate.receiptId), [older.receiptId]);
  assert.match(ship.receipt.rejectedCandidates[0].issues.join("\n"), /valid JSON|receipt/i);
});

test("Door 10 transparently returns the exact accepted and drifted ship checklist fields", async (t) => {
  const fixture = await createRunReceiptFixture(t, store);
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const fullCall = await startSurface(t, fixture, "full");
  const doorCall = await startSurface(t, fixture, "doors");
  await recordVision(fullCall, fixture, published);

  const fields = ["receipt", "ready", "deferred", "blockers", "verdict"];
  const assertSameFields = (door, full) => {
    for (const field of fields) assert.deepEqual(door[field], full[field], field);
  };
  const acceptedFull = await fullCall("ship_checklist", shipArgs(fixture));
  const acceptedDoor = await doorCall("pico_ship", shipArgs(fixture));
  assertSameFields(acceptedDoor, acceptedFull);

  fs.appendFileSync(fixture.payload.source.gradleInputs.projectDir + "/app/src/main/java/com/example/MainActivity.kt", "// door drift\n");
  const driftedFull = await fullCall("ship_checklist", shipArgs(fixture));
  const driftedDoor = await doorCall("pico_ship", shipArgs(fixture));
  assert.equal(driftedFull.receipt.status, "no-current-receipt");
  assertSameFields(driftedDoor, driftedFull);
});

test("pico_next uses the newest historical receipt capture and ID instead of mutable forward.png", async (t) => {
  const id = "receipt_next_fixture";
  const fixture = await createRunReceiptFixture(t, store, { app: `com.fleet.${id}` });
  const published = store.publishNativeRunReceipt(fixture.payload, fixture.storeOptions);
  const briefsDir = path.join(fixture.scratch, ".pico-mcp", "briefs");
  fs.mkdirSync(briefsDir, { recursive: true });
  fs.writeFileSync(path.join(briefsDir, `${id}.json`), JSON.stringify({ id, brief: "historical receipt next fixture" }));
  fs.appendFileSync(fixture.payload.source.gradleInputs.projectDir + "/app/src/main/java/com/example/MainActivity.kt", "// current drift must not hide historical LOOK target\n");

  const forward = `/tmp/pico-render/fleet/${id}/forward.png`;
  fs.mkdirSync(path.dirname(forward), { recursive: true });
  fs.writeFileSync(forward, makePng(7));
  t.after(() => fs.rmSync(path.dirname(forward), { recursive: true, force: true }));

  const doorCall = await startSurface(t, fixture, "doors");
  const next = await doorCall("pico_next", {});
  const briefState = next.state.briefs.find((brief) => brief.id === id);
  assert.equal(briefState.state, "built-needs-look");
  assert.equal(briefState.capture, fixture.captureArtifactPath);
  assert.equal(briefState.receiptId, published.receiptId);
  assert.notEqual(briefState.capture, forward);

  const actions = [next.nextAction, ...next.alternatives];
  const record = actions.find((action) => action?.door === "pico_record" && action.argsExample?.app === fixture.payload.app);
  assert.ok(record, JSON.stringify(next, null, 2));
  assert.equal(record.argsExample.artifactPath, fixture.captureArtifactPath);
  assert.equal(record.argsExample.runReceiptId, published.receiptId);

  const fullCall = await startSurface(t, fixture, "full");
  await recordVision(fullCall, fixture, published);
  const afterLook = await doorCall("pico_next", {});
  const lookedState = afterLook.state.briefs.find((brief) => brief.id === id);
  assert.equal(lookedState.state, "vision-recorded");
  assert.equal(
    [afterLook.nextAction, ...afterLook.alternatives].some((action) => action?.door === "pico_record" && action.argsExample?.app === fixture.payload.app),
    false,
  );
});
