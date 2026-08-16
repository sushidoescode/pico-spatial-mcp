import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as corpusApi from "../benchmarks/spatial-agent-bench/lib/corpus.mjs";
import { canonicalJson } from "../benchmarks/spatial-agent-bench/lib/identity.mjs";

const {
  createPreliminarySchedule,
  createStructuralThresholdSchedule,
  expectedMcpInventory,
  loadCorpus,
  renderPrompt,
} = corpusApi;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = path.join(root, "benchmarks", "spatial-agent-bench", "v1");
const supersededIdentity = "449ba40d15eb60d96b9a1572b6d2fecfc41f1072bee2846701c48895f47b7f70";
const systemPrompt = "You are an autonomous software implementation agent. Follow the user's application task exactly.\nWork only inside submission/. Use only capabilities exposed in this session. Do not seek external\ndata, credentials, instructions, or files. Finish with a concise account of files created, commands\nattempted, failures, and remaining uncertainty.\n";
const resetLifecycle = [
  "stop_package",
  "uninstall_package",
  "reset_world",
  "load_fixture",
  "read_back_fixture_identity",
  "install_receipt_bound_apk",
  "launch_package",
  "wait_for_receiver",
];

function withCorpusCopy(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbench-corpus-"));
  const copiedCorpusDir = path.join(tempDir, "v1");
  fs.cpSync(corpusDir, copiedCorpusDir, { recursive: true });
  try {
    return callback(copiedCorpusDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function mutateJson(filePath, mutate) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(value);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveRequest(step, variant) {
  const request = structuredClone(step.request);
  if (request.item && typeof request.item === "object") {
    assert.deepEqual(Object.keys(request.item), ["variantItemIndex"]);
    request.item = variant.items[request.item.variantItemIndex];
  }
  return request;
}

function renderedProtocol(loaded, variant) {
  return loaded.protocolVectors.runs.map((run) => ({
    name: run.name,
    fixtureId: run.fixtureId,
    requests: run.steps.map((step) => ({
      name: step.name,
      waitBeforeMs: step.waitBeforeMs,
      comparison: step.comparison,
      raw: canonicalJson(resolveRequest(step, variant)),
    })),
  }));
}

function expectedProtocol(variant) {
  const request = (name, waitBeforeMs, comparison, value) => ({
    name,
    waitBeforeMs,
    comparison,
    raw: canonicalJson(value),
  });
  const state = [
    request("fresh-baseline", 0, "fresh_baseline", { command: "snapshot", protocol_version: 1, request_id: "state-001" }),
    request("pause-before-stage", 0, "pause_accepted", { command: "pause", protocol_version: 1, request_id: "state-002" }),
    request("paused-baseline", 0, "paused_baseline", { command: "snapshot", protocol_version: 1, request_id: "state-003" }),
    request("duplicate-id", 0, "duplicate_request_id", { command: "snapshot", protocol_version: 1, request_id: "state-003" }),
    request("invalid-fields", 0, "invalid_fields", { command: "snapshot", item: variant.items[0], protocol_version: 1, request_id: "state-004" }),
    request("unknown-item", 0, "unknown_item", { command: "select", item: "__agentbench_unknown_item__", protocol_version: 1, request_id: "state-005" }),
    request("resume-before-selection", 0, "resume_accepted", { command: "resume", protocol_version: 1, request_id: "state-006" }),
    request("select-first", 0, "first_selection", { command: "select", item: variant.items[0], protocol_version: 1, request_id: "state-007" }),
    request("pause-retained", 0, "paused_selection", { command: "pause", protocol_version: 1, request_id: "state-008" }),
    request("close-first", 0, "close_first", { command: "close_stage", protocol_version: 1, request_id: "state-009" }),
    request("open-first", 0, "reopen_first", { command: "open_stage", protocol_version: 1, request_id: "state-010" }),
    request("snapshot-first-reopen", 0, "first_reopen_snapshot", { command: "snapshot", protocol_version: 1, request_id: "state-011" }),
    request("resume-after-first-reopen", 0, "resume_second", { command: "resume", protocol_version: 1, request_id: "state-012" }),
    request("select-second", 0, "second_selection", { command: "select", item: variant.items[1], protocol_version: 1, request_id: "state-013" }),
    request("close-second", 0, "close_second", { command: "close_stage", protocol_version: 1, request_id: "state-014" }),
    request("open-second", 0, "reopen_second", { command: "open_stage", protocol_version: 1, request_id: "state-015" }),
    request("final-snapshot", 0, "final_snapshot", { command: "snapshot", protocol_version: 1, request_id: "state-016" }),
  ];
  const tick = [
    request("select", 0, "tick_select", { command: "select", item: variant.items[0], protocol_version: 1, request_id: "tick-001" }),
    request("running-baseline-one", 0, "running_baseline_one", { command: "snapshot", protocol_version: 1, request_id: "tick-002" }),
  ];
  for (let id = 3; id <= 52; id += 1) tick.push(request(`running-one-${id}`, 100, "running_window_one", { command: "snapshot", protocol_version: 1, request_id: `tick-${String(id).padStart(3, "0")}` }));
  tick.push(request("pause", 0, "tick_pause", { command: "pause", protocol_version: 1, request_id: "tick-053" }));
  tick.push(request("paused-baseline", 0, "tick_paused_baseline", { command: "snapshot", protocol_version: 1, request_id: "tick-054" }));
  tick.push(request("paused-hold", 500, "tick_paused_hold", { command: "snapshot", protocol_version: 1, request_id: "tick-055" }));
  tick.push(request("resume", 0, "tick_resume", { command: "resume", protocol_version: 1, request_id: "tick-056" }));
  tick.push(request("running-baseline-two", 0, "running_baseline_two", { command: "snapshot", protocol_version: 1, request_id: "tick-057" }));
  for (let id = 58; id <= 107; id += 1) tick.push(request(`running-two-${id}`, 100, "running_window_two", { command: "snapshot", protocol_version: 1, request_id: `tick-${String(id).padStart(3, "0")}` }));
  const surface = (kind, semantic) => {
    const prefix = `surface-${kind}`;
    const entries = [request("select", 0, "surface_select", { command: "select", item: variant.items[0], protocol_version: 1, request_id: `${prefix}-001` })];
    for (let id = 2; id <= 61; id += 1) entries.push(request(`poll-${id}`, 250, `surface_poll_${semantic}`, { command: "snapshot", protocol_version: 1, request_id: `${prefix}-${String(id).padStart(3, "0")}` }));
    return entries;
  };
  return [
    { name: "state", fixtureId: "table-present", requests: state },
    { name: "tick", fixtureId: "table-present", requests: tick },
    { name: "table_surface", fixtureId: "table-present", requests: surface("table", "table") },
    { name: "floor_surface", fixtureId: "floor-only", requests: surface("floor", "floor") },
  ];
}

test("v1 corpus revision freezes the corrected structural comparison", () => {
  const loaded = loadCorpus(corpusDir);
  assert.equal(loaded.corpus.schemaVersion, 2);
  assert.equal(loaded.corpus.corpusRevision, 2);
  assert.deepEqual(loaded.corpus.supersedes, {
    identitySha256: supersededIdentity,
    measuredAttempts: 0,
    reason: "premeasurement_contract_correction",
  });
  assert.equal(loaded.corpus.rubricVersion, 2);
  assert.equal(loaded.corpus.resultSchemaVersion, 2);
  assert.equal(loaded.corpus.runtimeProtocolVersion, 1);
  assert.equal(loaded.corpus.protocolVectorsFile, "protocol-vectors.json");
  assert.deepEqual(loaded.corpus.workspaceMcp, {
    serverName: "agentbench-workspace",
    tools: ["workspace_list", "workspace_read", "workspace_write", "workspace_replace"],
  });
  assert.deepEqual(loaded.corpus.claudeClientBoundary, {
    version: 1,
    clientZone: "trusted_supervisor",
    authentication: "max_oauth_keychain",
    subprocessCredentialScrub: true,
  });
  assert.equal(loaded.corpus.sdkVersion, "0.13.3");
  assert.equal(loaded.corpus.picoCli.version, "0.4.2");
  assert.equal(loaded.corpus.claudeCliVersion, "2.1.233");
  assert.equal(loaded.systemPrompt, systemPrompt);
  assert.match(loaded.identity.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(loaded.identity.sha256, supersededIdentity);
});

test("identity binds every provider-visible corpus file byte-for-byte", () => {
  const files = ["prompt.md", "system-prompt.md", "workspace-tools.json", "pico-door-tools.json", "protocol-vectors.json"];
  for (const relativePath of files) {
    withCorpusCopy((copy) => {
      const original = loadCorpus(copy);
      fs.appendFileSync(path.join(copy, relativePath), "\n");
      try {
        const changed = loadCorpus(copy);
        assert.notEqual(changed.identity.sha256, original.identity.sha256, relativePath);
      } catch (error) {
        assert.match(error.message, /drift|valid JSON|system prompt|protocol|tool/i, relativePath);
      }
    });
  }
});

test("loaded provider inputs and returned inventories are deeply immutable", () => {
  const loaded = loadCorpus(corpusDir);
  for (const value of [loaded.corpus, loaded.workspaceTools, loaded.picoDoorTools, loaded.protocolVectors]) assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(loaded.workspaceTools[0].inputSchema.properties), true);
  assert.equal(Object.isFrozen(loaded.picoDoorTools[0].inputSchema.properties), true);
  assert.equal(Object.isFrozen(loaded.protocolVectors.runs[0].steps[0].request), true);
  const bare = expectedMcpInventory(loaded, "opus_bare");
  const treatment = expectedMcpInventory(loaded, "sonnet_mcp");
  assert.deepEqual(bare, [{ serverName: "agentbench-workspace", domain: "workspace", tools: loaded.workspaceTools }]);
  assert.deepEqual(treatment, [
    { serverName: "agentbench-workspace", domain: "workspace", tools: loaded.workspaceTools },
    { serverName: "pico-spatial", domain: "pico", tools: loaded.picoDoorTools },
  ]);
  assert.equal(Object.isFrozen(treatment[1].tools[0].inputSchema), true);
  assert.throws(() => treatment.push({}), TypeError);
  assert.throws(() => expectedMcpInventory(loaded, "unknown_lane"), /unknown corpus lane/);
});

test("tool snapshots bind exact ordered full provider objects", () => {
  const loaded = loadCorpus(corpusDir);
  assert.deepEqual(loaded.workspaceTools.map((tool) => tool.name), loaded.corpus.workspaceMcp.tools);
  assert.deepEqual(loaded.picoDoorTools.map((tool) => tool.name), loaded.corpus.expectedDoorTools);
  assert.equal(loaded.workspaceTools.length, 4);
  assert.equal(loaded.picoDoorTools.length, 18);
  for (const tool of loaded.workspaceTools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.type, "object");
    assert.equal(tool.outputSchema.additionalProperties, false);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
  }
  const rawWorkspace = JSON.parse(fs.readFileSync(path.join(corpusDir, "workspace-tools.json"), "utf8"));
  const rawPico = JSON.parse(fs.readFileSync(path.join(corpusDir, "pico-door-tools.json"), "utf8"));
  assert.deepEqual(loaded.workspaceTools, rawWorkspace);
  assert.deepEqual(loaded.picoDoorTools, rawPico);
  assert.ok(loaded.picoDoorTools.some((tool) => Object.hasOwn(tool, "execution")), "provider-visible extension keys must be retained");
});

test("preliminary and structural-threshold schedules are deterministic and balanced", () => {
  const loaded = loadCorpus(corpusDir);
  const preliminary = createPreliminarySchedule(loaded);
  assert.deepEqual(preliminary.primary.map(({ variantId, lanes }) => [variantId, lanes]), [
    ["museum", ["sonnet_mcp", "opus_bare"]],
    ["botanical", ["opus_bare", "sonnet_mcp"]],
    ["planets", ["sonnet_mcp", "opus_bare"]],
    ["instruments", ["sonnet_mcp", "opus_bare"]],
    ["vehicles", ["sonnet_mcp", "opus_bare"]],
  ]);
  const threshold = createStructuralThresholdSchedule(loaded);
  assert.deepEqual(threshold.primary.map(({ accountBlock, variantId, lanes }) => [accountBlock, variantId, lanes]), [
    [0, "planets", ["sonnet_mcp", "opus_bare"]],
    [1, "instruments", ["opus_bare", "sonnet_mcp"]],
    [1, "botanical", ["opus_bare", "sonnet_mcp"]],
    [0, "instruments", ["opus_bare", "sonnet_mcp"]],
    [0, "museum", ["sonnet_mcp", "opus_bare"]],
    [1, "museum", ["sonnet_mcp", "opus_bare"]],
    [0, "botanical", ["sonnet_mcp", "opus_bare"]],
    [1, "vehicles", ["sonnet_mcp", "opus_bare"]],
    [1, "planets", ["opus_bare", "sonnet_mcp"]],
    [0, "vehicles", ["opus_bare", "sonnet_mcp"]],
  ]);
  assert.equal(threshold.primary.filter((pair) => pair.lanes[0] === "sonnet_mcp").length, 5);
  assert.equal(threshold.primary.filter((pair) => pair.lanes[0] === "opus_bare").length, 5);
  assert.equal(Object.hasOwn(corpusApi, "createSignoffSchedule"), false);
});

test("tracked amendment notice names only the replacement downstream surfaces", () => {
  const plan = fs.readFileSync(path.join(root, "docs", "superpowers", "plans", "2026-08-16-spatial-agent-bench.md"), "utf8");
  const notice = plan.slice(plan.indexOf("> **Premeasurement amendment"), plan.indexOf("## Global Constraints"));
  for (const replacement of [
    "createStructuralThresholdSchedule",
    "runStructuralThresholdCohort",
    "--cohort structural-threshold",
    "structural_threshold_met",
    "structural_threshold_not_met",
  ]) assert.match(notice, new RegExp(replacement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(Object.hasOwn(corpusApi, "createSignoffSchedule"), false);
});

test("protocol vectors freeze all four reset-isolated canonical request transcripts", () => {
  const loaded = loadCorpus(corpusDir);
  assert.equal(loaded.protocolVectors.version, 1);
  assert.equal(loaded.protocolVectors.encoding, "canonical-json-utf8-no-newline");
  assert.equal(loaded.protocolVectors.maxPayloadBytes, 65_536);
  assert.equal(loaded.protocolVectors.unknownItem, "__agentbench_unknown_item__");
  assert.deepEqual(loaded.protocolVectors.responsePolicy.common, {
    duplicateKeyAware: true,
    rejectExtraKeys: true,
    requireSafeIntegers: true,
    requireFiniteNumbers: true,
    requireNonEmptyIdsAndNonces: true,
    canonicalPayload: "utf8-canonical-json-no-bom-padding-or-newline",
    successfulErrorCode: null,
    processInstance: "byte-identical-within-run",
  });
  assert.deepEqual(loaded.protocolVectors.responsePolicy.state.negative, {
    baselineStep: "paused-baseline",
    errorSteps: [
      { step: "duplicate-id", status: "error", errorCode: "duplicate_request_id", requestId: "state-003" },
      { step: "invalid-fields", status: "error", errorCode: "invalid_fields", requestId: "state-004" },
      { step: "unknown-item", status: "error", errorCode: "unknown_item", requestId: "state-005" },
    ],
    equalToBaseline: ["selection", "title", "visit_count", "paused", "stage_open", "stage_generation", "tick_count"],
    fixedEachResponse: { surface_status: "idle", surface_semantic: null, placement_count: 0 },
  });
  assert.deepEqual(loaded.protocolVectors.responsePolicy.tick, {
    counter: "tick_count",
    neverDecreases: true,
    runningWindows: [
      { baselineStep: "running-baseline-one", firstStep: "running-one-3", lastStep: "running-one-52", polls: 50, intervalMs: 100, requiresGreaterThanBaseline: true },
      { baselineStep: "running-baseline-two", firstStep: "running-two-58", lastStep: "running-two-107", polls: 50, intervalMs: 100, requiresGreaterThanBaseline: true },
    ],
    pausedWindow: { baselineStep: "paused-baseline", comparisonStep: "paused-hold", waitMs: 500, requiresEqual: true },
  });
  assert.deepEqual(loaded.protocolVectors.responsePolicy.surface, {
    neverDecreases: ["placement_count", "tick_count"],
    searchingBeforeFirstReady: true,
    afterFirstReady: { placement_count: 3 },
    runs: [
      { run: "table_surface", semantic: "table", polls: 60, intervalMs: 250 },
      { run: "floor_surface", semantic: "floor", polls: 60, intervalMs: 250 },
    ],
  });
  assert.deepEqual(loaded.protocolVectors.environmentFailureClassification, {
    beforeFixtureReadBack: "blocked_environment",
    afterFixtureReadBack: "fail",
  });
  assert.deepEqual(loaded.protocolVectors.runs.map((run) => [run.name, run.fixtureId, run.steps.length]), [
    ["state", "table-present", 17],
    ["tick", "table-present", 107],
    ["table_surface", "table-present", 61],
    ["floor_surface", "floor-only", 61],
  ]);
  for (const run of loaded.protocolVectors.runs) assert.deepEqual(run.resetLifecycle, resetLifecycle);
  for (const variant of loaded.corpus.variants) {
    const actual = renderedProtocol(loaded, variant);
    const expected = expectedProtocol(variant);
    assert.deepEqual(actual, expected, variant.id);
    for (const run of actual) {
      for (const step of run.requests) {
        assert.ok(Buffer.byteLength(step.raw) <= 65_536);
        assert.equal(step.raw.endsWith("\n"), false);
      }
    }
  }
  const museum = renderedProtocol(loaded, loaded.corpus.variants[0]);
  assert.equal(museum[0].requests[0].raw, '{"command":"snapshot","protocol_version":1,"request_id":"state-001"}');
  assert.equal(museum[0].requests[1].raw, '{"command":"pause","protocol_version":1,"request_id":"state-002"}');
  assert.equal(museum[0].requests[4].raw, '{"command":"snapshot","item":"vase","protocol_version":1,"request_id":"state-004"}');
  const allBytes = canonicalJson(loaded.corpus.variants.map((variant) => renderedProtocol(loaded, variant)));
  assert.equal(crypto.createHash("sha256").update(allBytes).digest("hex"), "feb6a5bd18559fb8aaf7c8868f5965ff04c1c7e1cfabfc26a81da56dec641465");
});

test("rendered prompt is byte-identical across lanes and contains no treatment or rubric hints", () => {
  const loaded = loadCorpus(corpusDir);
  const prohibited = [
    ...loaded.corpus.lanes.map((lane) => lane.id),
    "agentbench-workspace", "pico-spatial", "pico-cli",
    ...loaded.corpus.workspaceMcp.tools,
    ...loaded.corpus.expectedDoorTools,
    "EntityQueryCondition", "SceneUpdateContext", "Bundle", "PlaneTrackingManager", "deltaTime",
    "spatial.project-entry", "state.reopen-wiring", "source_and_typed_fact", "submission_test",
    "app_self_reported_protocol", "external_observation", "structuralScore",
    "buildQualifiedStructuralScore", "submissionTests", "runtimeProtocolReceipts",
    "preliminary_structural", "structural_threshold_met", "instrumentation_threshold_met",
  ].map((value) => value.normalize("NFKC").toLowerCase());
  for (const variant of loaded.corpus.variants) {
    const rendered = renderPrompt(loaded, variant.id);
    const perLane = loaded.corpus.lanes.map(() => renderPrompt(loaded, variant.id));
    assert.ok(perLane.every((candidate) => candidate === rendered));
    const normalized = rendered.normalize("NFKC").toLowerCase();
    for (const term of prohibited) assert.equal(normalized.includes(term), false, `${variant.id}:${term}`);
  }
  const commonBare = expectedMcpInventory(loaded, "opus_bare")[0].tools;
  const commonTreatment = expectedMcpInventory(loaded, "sonnet_mcp")[0].tools;
  assert.deepEqual(commonBare, commonTreatment);
  assert.deepEqual(expectedMcpInventory(loaded, "sonnet_mcp").slice(1), [
    { serverName: "pico-spatial", domain: "pico", tools: loaded.picoDoorTools },
  ]);
});

test("provider-input neutrality rejects case-folded and compatibility-normalized hints", () => {
  withCorpusCopy((copy) => {
    fs.appendFileSync(path.join(copy, "prompt.md"), "lowercase entityquerycondition\n");
    assert.throws(() => loadCorpus(copy), /prohibited/i);
  });
  withCorpusCopy((copy) => {
    mutateJson(path.join(copy, "corpus.json"), (corpus) => { corpus.variants[0].items[0] = "PICO_BUILD_APP"; });
    assert.throws(() => loadCorpus(copy), /prohibited|treatment/i);
  });
  withCorpusCopy((copy) => {
    fs.appendFileSync(path.join(copy, "system-prompt.md"), "sonnet_mcp\n");
    assert.throws(() => loadCorpus(copy), /system prompt|prohibited/i);
  });
  withCorpusCopy((copy) => {
    fs.appendFileSync(path.join(copy, "prompt.md"), "ＥｎｔｉｔｙＱｕｅｒｙＣｏｎｄｉｔｉｏｎ\n");
    assert.throws(() => loadCorpus(copy), /prohibited/i);
  });
});

test("corpus rejects tool order drift, unknown keys, and unknown protocol items", () => {
  withCorpusCopy((copy) => {
    mutateJson(path.join(copy, "workspace-tools.json"), (tools) => tools.reverse());
    assert.throws(() => loadCorpus(copy), /workspace tool order|workspace tool names/i);
  });
  withCorpusCopy((copy) => {
    mutateJson(path.join(copy, "workspace-tools.json"), (tools) => { tools[0].outputSchema.properties.entries.items.additionalProperties = true; });
    assert.throws(() => loadCorpus(copy), /strict object schema/i);
  });
  withCorpusCopy((copy) => {
    mutateJson(path.join(copy, "pico-door-tools.json"), (tools) => { tools[0].unexpected = true; });
    assert.throws(() => loadCorpus(copy), /provider-visible snapshot|unknown|drift/i);
  });
  withCorpusCopy((copy) => {
    mutateJson(path.join(copy, "protocol-vectors.json"), (vectors) => { vectors.extra = true; });
    assert.throws(() => loadCorpus(copy), /protocol.*unknown/i);
  });
  withCorpusCopy((copy) => {
    mutateJson(path.join(copy, "corpus.json"), (corpus) => { corpus.variants[0].items[0] = "__agentbench_unknown_item__"; });
    assert.throws(() => loadCorpus(copy), /unknown-item literal/i);
  });
});

test("workspace tool snapshots reject any full-object drift", async (t) => {
  const mutations = [
    ["annotation", (tools) => { tools[0].annotations.readOnlyHint = false; }],
    ["constraint", (tools) => { tools[1].inputSchema.properties.limit.maximum = 262_143; }],
    ["nested description", (tools) => { tools[0].outputSchema.properties.entries.items.properties.path.description = "Nested provider text drift."; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    withCorpusCopy((copy) => {
      mutateJson(path.join(copy, "workspace-tools.json"), mutate);
      assert.throws(() => loadCorpus(copy), /workspace.*(snapshot|digest|drift)/i);
    });
  });
});

test("complete workspace provider bytes are scanned for prohibited guidance", () => {
  withCorpusCopy((copy) => {
    mutateJson(path.join(copy, "workspace-tools.json"), (tools) => {
      tools[0].outputSchema.properties.entries.items.properties.path.description = "EntityQueryCondition";
    });
    assert.throws(() => loadCorpus(copy), /prohibited provider hint/i);
  });
});

test("PICO schema confidentiality scan covers digest-only reported identifiers", async (t) => {
  const reportedCodePoints = [
    [83, 112, 97, 99, 101, 76, 97, 117, 110, 99, 104, 101, 114],
    [83, 112, 97, 99, 101, 70, 105, 108, 101, 115],
    [83, 112, 97, 99, 101, 87, 101, 98, 65, 112, 112],
    [83, 112, 97, 99, 101, 87, 101, 98, 65, 112, 112, 82, 117, 110, 116, 105, 109, 101],
    [83, 112, 97, 116, 105, 97, 108, 83, 121, 115, 116, 101, 109, 85, 73],
    [114, 111, 46, 115, 112, 97, 99, 101, 111, 115, 46, 98, 117, 105, 108, 100, 46, 118, 101, 114, 115, 105, 111, 110],
    [112, 101, 114, 115, 105, 115, 116, 46, 112, 118, 114, 46, 105, 115, 95, 115, 112, 97, 99, 101, 95, 111, 115, 61, 49],
  ];
  for (const [index, codePoints] of reportedCodePoints.entries()) await t.test(`digest ${index + 1}`, () => {
    withCorpusCopy((copy) => {
      mutateJson(path.join(copy, "pico-door-tools.json"), (tools) => {
        tools[0].description += ` ${String.fromCodePoint(...codePoints)}`;
      });
      const expectedFailure = index === 5 ? /confidential identifier/i : /confidential identifier digest/i;
      assert.throws(() => loadCorpus(copy), expectedFailure);
    });
  });
  await t.test("compatibility-normalized digest", () => {
    withCorpusCopy((copy) => {
      mutateJson(path.join(copy, "pico-door-tools.json"), (tools) => {
        const ascii = String.fromCodePoint(...reportedCodePoints[0]);
        const compatibilityForm = [...ascii].map((character) => String.fromCodePoint(character.codePointAt(0) + 0xfee0)).join("");
        tools[0].description += ` ${compatibilityForm}`;
      });
      assert.throws(() => loadCorpus(copy), /confidential identifier digest/i);
    });
  });
});
