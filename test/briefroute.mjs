import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { classifyBriefExecution } from "../dist/briefroute.js";
import { computeSuite } from "../dist/eval.js";
import { processBrief, summarizeFactoryStatuses } from "../dist/factory.js";
import { headlessRows, renderBenchHtml } from "../dist/spatialbench.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cameraPeekCorpusEntry = JSON.parse(fs.readFileSync(path.join(ROOT, "briefs", "camerapeek.json"), "utf8"));

const pipeline = classifyBriefExecution({ id: "ordinary", spec: {} });
assert.deepEqual(pipeline, { route: "appspec-pipeline" });

const external = classifyBriefExecution({
  id: "camerapeek",
  execution: {
    route: "hand-authored-classic-android",
    projectPath: "/tmp/camerapeek-native",
    packageName: "com.pico.camerapeek",
    launcherActivity: ".CameraPeekActivity",
  },
});
assert.deepEqual(external, {
  route: "hand-authored-classic-android",
  projectPath: "/tmp/camerapeek-native",
  packageName: "com.pico.camerapeek",
  launcherActivity: ".CameraPeekActivity",
});

assert.throws(
  () => classifyBriefExecution({
    id: "broken",
    execution: {
      route: "hand-authored-classic-android",
      projectPath: "relative/project",
      packageName: "com.pico.broken",
      launcherActivity: ".MainActivity",
    },
  }),
  /projectPath/,
);

assert.throws(
  () => classifyBriefExecution({ id: "unknown", execution: { route: "magic" } }),
  /execution/,
);

const suite = computeSuite();
const suiteCameraPeek = suite.rows.find((row) => row.id === "camerapeek");
assert.match(suiteCameraPeek.skipped, /hand-authored-classic-android/);
assert.equal(suiteCameraPeek.compileSteps, 0);
assert.equal(suiteCameraPeek.pass, null);
assert.equal(suite.scorecard.skipped, 1);
assert.equal(suite.scorecard.corpusTotal, suite.scorecard.total + suite.scorecard.skipped);
assert.deepEqual(suite.rows.filter((row) => row.skipped).map((row) => row.id), ["camerapeek"]);

const benchCameraPeek = headlessRows(["camerapeek"]).rows[0];
assert.match(benchCameraPeek.skipped, /hand-authored-classic-android/);
assert.equal(benchCameraPeek.score, 0);
assert.equal(benchCameraPeek.max, 0);
assert.equal(benchCameraPeek.planned, null);
assert.equal(benchCameraPeek.compiled, null);
assert.equal(benchCameraPeek.shape, null);

const externalOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "briefroute-external-only-"));
fs.copyFileSync(path.join(ROOT, "briefs", "camerapeek.json"), path.join(externalOnlyDir, "camerapeek.json"));
const externalOnlySuite = computeSuite(externalOnlyDir);
assert.deepEqual(
  {
    total: externalOnlySuite.scorecard.total,
    passed: externalOnlySuite.scorecard.passed,
    failed: externalOnlySuite.scorecard.failed,
    skipped: externalOnlySuite.scorecard.skipped,
    score: externalOnlySuite.scorecard.score,
  },
  { total: 0, passed: 0, failed: 0, skipped: 1, score: null },
);

const externalOnlyHtml = renderBenchHtml({
  generatedAt: "2026-07-22T00:00:00Z",
  tier: "full",
  briefsDir: externalOnlyDir,
  summary: { total: 1, aggregate: 0, maxAggregate: 0, skipped: ["camerapeek"], escalations: [] },
  rows: [benchCameraPeek],
});
assert.match(externalOnlyHtml, /aggregate 0\/0 \(n\/a\)/);
assert.match(externalOnlyHtml, /<tr><td>camerapeek<\/td>(?:<td><span class="na">—<\/span><\/td>){8}/);

const factoryCameraPeek = processBrief({
  id: "camerapeek",
  execution: cameraPeekCorpusEntry.execution,
  spec: {},
});
assert.equal(factoryCameraPeek.status, "external_implementation");
assert.equal(factoryCameraPeek.compileSteps, 0);
assert.equal(processBrief({
  id: "camerapeek",
  execution: {
    launcherActivity: cameraPeekCorpusEntry.execution.launcherActivity,
    packageName: cameraPeekCorpusEntry.execution.packageName,
    projectPath: cameraPeekCorpusEntry.execution.projectPath,
    route: cameraPeekCorpusEntry.execution.route,
  },
  spec: {},
}).status, "external_implementation");
assert.equal(processBrief({ id: "camerapeek", execution: external, spec: {} }).status, "invalid_execution");

const legacyQueueCameraPeek = processBrief({
  id: cameraPeekCorpusEntry.id,
  brief: cameraPeekCorpusEntry.brief,
  spec: cameraPeekCorpusEntry.spec,
});
assert.equal(legacyQueueCameraPeek.status, "external_implementation");
assert.equal(legacyQueueCameraPeek.compileSteps, 0);
assert.equal(legacyQueueCameraPeek.emulatorVerifiableNodes, 0);

assert.deepEqual(
  summarizeFactoryStatuses([
    { status: "ready_to_build" },
    { status: "blocked" },
    { status: "external_implementation" },
    { status: "invalid_spec" },
    { status: "invalid_execution" },
  ]),
  { readyToBuild: 1, blocked: 1, externalImplementations: 1, invalid: 2 },
);

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, PICO_MCP_SURFACE: "full" },
});
const client = new Client({ name: "briefroute-test", version: "0.0.0" });
await client.connect(transport);
try {
  const result = await client.callTool({
    name: "fleet_build",
    arguments: { briefIds: ["camerapeek"] },
  });
  assert.notEqual(result.isError, true);
  const payload = JSON.parse(result.content.find((item) => item.type === "text").text);
  assert.equal(payload.results[0].built, false);
  assert.equal(payload.results[0].externalImplementation.route, "hand-authored-classic-android");
  assert.match(payload.results[0].notes.join("\n"), /generic fleet codegen cannot build/);

  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "briefroute-full-report-"));
  const benchResult = await client.callTool({
    name: "run_spatialbench",
    arguments: { tier: "full", briefIds: ["camerapeek"], settleSec: 0, outDir: reportDir },
  });
  assert.notEqual(benchResult.isError, true);
  const benchPayload = JSON.parse(benchResult.content.find((item) => item.type === "text").text);
  assert.deepEqual(
    {
      total: benchPayload.summary.total,
      aggregate: benchPayload.summary.aggregate,
      maxAggregate: benchPayload.summary.maxAggregate,
      skipped: benchPayload.summary.skipped,
    },
    { total: 1, aggregate: 0, maxAggregate: 0, skipped: ["camerapeek"] },
  );
  assert.deepEqual(benchPayload.league, [{ id: "camerapeek", score: "0/0", skipped: benchPayload.league[0].skipped }]);
  assert.match(fs.readFileSync(path.join(reportDir, "index.html"), "utf8"), /aggregate 0\/0 \(n\/a\)/);

  const factoryResult = await client.callTool({
    name: "run_factory",
    arguments: {
      queue: [{ id: cameraPeekCorpusEntry.id, brief: cameraPeekCorpusEntry.brief, spec: cameraPeekCorpusEntry.spec }],
    },
  });
  assert.notEqual(factoryResult.isError, true);
  const factoryPayload = JSON.parse(factoryResult.content.find((item) => item.type === "text").text);
  assert.equal(factoryPayload.records[0].status, "external_implementation");
  assert.equal(factoryPayload.records[0].compileSteps, 0);
  assert.equal(factoryPayload.records[0].emulatorVerifiableNodes, 0);
  assert.equal(factoryPayload.fleetDashboard.externalImplementations, 1);
  assert.equal(factoryPayload.fleetDashboard.readyToBuild, 0);

  const emptyMetadataDir = fs.mkdtempSync(path.join(os.tmpdir(), "briefroute-empty-metadata-"));
  const factoryWithIrrelevantDir = await client.callTool({
    name: "run_factory",
    arguments: {
      queue: [{ id: cameraPeekCorpusEntry.id, brief: cameraPeekCorpusEntry.brief, spec: cameraPeekCorpusEntry.spec }],
      briefsDir: emptyMetadataDir,
    },
  });
  assert.notEqual(factoryWithIrrelevantDir.isError, true);
  const factoryWithIrrelevantDirPayload = JSON.parse(factoryWithIrrelevantDir.content.find((item) => item.type === "text").text);
  assert.equal(factoryWithIrrelevantDirPayload.records[0].status, "external_implementation");
  assert.equal(factoryWithIrrelevantDirPayload.records[0].compileSteps, 0);
} finally {
  await client.close();
}

console.log("briefroute: all assertions passed");
