import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { classifyBriefExecution } from "../dist/briefroute.js";
import { computeSuite } from "../dist/eval.js";
import { processBrief, summarizeFactoryStatuses } from "../dist/factory.js";
import { headlessRows } from "../dist/spatialbench.js";

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
assert.ok(suite.scorecard.skipped >= 1);

const benchCameraPeek = headlessRows(["camerapeek"]).rows[0];
assert.match(benchCameraPeek.skipped, /hand-authored-classic-android/);
assert.equal(benchCameraPeek.score, 0);
assert.equal(benchCameraPeek.max, 0);

const factoryCameraPeek = processBrief({
  id: "camerapeek",
  execution: external,
  spec: {},
});
assert.equal(factoryCameraPeek.status, "external_implementation");
assert.equal(factoryCameraPeek.compileSteps, 0);

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
} finally {
  await client.close();
}

console.log("briefroute: 14/14 passed");
