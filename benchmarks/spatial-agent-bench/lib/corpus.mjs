import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalIdentity, canonicalJson } from "./identity.mjs";

const CORPUS_KEYS = new Set([
  "schemaVersion", "corpusId", "corpusRevision", "supersedes", "rubricVersion",
  "resultSchemaVersion", "runtimeProtocolVersion", "protocolVectorsFile", "workspaceMcp",
  "claudeClientBoundary", "sdkVersion", "picoCli", "claudeCliVersion", "claudeCliCommit",
  "claudeCliSha256", "toolchainNpm", "effort", "timeoutMs", "maxTurns", "maxOutputBytes",
  "expectedDoorTools", "seed", "controlVariantIds", "lanes", "variants",
]);
const TEMPLATE_TOKENS = new Set(["VARIANT_TITLE", "VARIANT_ID", "ITEM_1", "ITEM_2", "ITEM_3"]);
const EXACT_SYSTEM_PROMPT = "You are an autonomous software implementation agent. Follow the user's application task exactly.\nWork only inside submission/. Use only capabilities exposed in this session. Do not seek external\ndata, credentials, instructions, or files. Finish with a concise account of files created, commands\nattempted, failures, and remaining uncertainty.\n";
const SUPERSEDED_IDENTITY = "449ba40d15eb60d96b9a1572b6d2fecfc41f1072bee2846701c48895f47b7f70";
const WORKSPACE_TOOL_NAMES = ["workspace_list", "workspace_read", "workspace_write", "workspace_replace"];
const WORKSPACE_DESCRIPTIONS = [
  "List one directory beneath submission/ with stable bounded entries.",
  "Read bounded UTF-8 text from one file beneath submission/.",
  "Create or replace one UTF-8 file beneath submission/.",
  "Replace an exact number of text occurrences in one UTF-8 file beneath submission/.",
];
const WORKSPACE_TOOLS_CANONICAL_SHA256 = "df362d7ca357fd95c89c39d767fd8d8f1c62f0f34b6b9732b7d01825b09ba056";
const RESET_LIFECYCLE = [
  "stop_package", "uninstall_package", "reset_world", "load_fixture",
  "read_back_fixture_identity", "install_receipt_bound_apk", "launch_package",
  "wait_for_receiver",
];
const RULE_IDS = [
  "spatial.project-entry", "spatial.container-topology", "spatial.entity-content",
  "spatial.ui-lifecycle", "ecs.component-clone", "ecs.system-query", "ecs.frame-update",
  "ecs.lifecycle", "state.single-source", "state.typed-handoff", "state.shared-read-write",
  "state.reopen-wiring", "plane.retry-readiness", "plane.semantic-fallback", "plane.anchor-pose",
  "plane.cleanup-errors",
];
const PROVIDER_PROHIBITED_TERMS = [
  "agentbench-workspace", "pico-spatial", "pico-cli",
  "EntityQueryCondition", "SceneUpdateContext", "Bundle", "PlaneTrackingManager", "deltaTime",
  ...RULE_IDS,
  "source", "typed_fact", "source_and_typed_fact", "submission_test",
  "app_self_reported_protocol", "external_observation", "structuralScore",
  "buildQualifiedStructuralScore", "submissionTests", "runtimeProtocolReceipts",
  "preliminary_structural", "structural_threshold_met", "instrumentation_threshold_met",
];
const REPORTED_IDENTIFIERS = [
  "spaceos", "space os", "swan_oversea", "swan_spaceos", "swan spaceos", "spacebrowser",
  "space browser", "worldspace", "world space", "com.picoxr.browser", "ro.spaceos",
  "persist.spaceos",
];
const REPORTED_IDENTIFIER_SHA256 = new Set([
  "03b840807bb6d9c7979aedf291315c97b218513aee9162986e03c3092a384d21",
  "7a77df84d41b1a3c025f69ab8928346a45c2fbf6603de8f80dc6126bc53a61f2",
  "6be342ef40e986e7d82ec373ed2896bf844e808db498589f430cbd3bdac46fa8",
  "e27ef3df860bc4cebb24690495d6f17e9c9561ffca0ea76a84c4edaa1ec61dbc",
  "8d85910355a9171f8104ff59e811e9fa0cfc5b79fe756da4407de7ffbd3204d7",
  "79e2bcb4bdef3f6cafc04d38cc8ac6f758013e2d8377ae48eabda460170df01f",
  "1ed0e2ba56fcb5aca82696b50831197ae17e1b840d9a6a100c1a16b227b3eb4f",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, label, keys) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label} contains unknown key: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required key: ${key}`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const entry of value) assertString(entry, `${label} entry`);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    assertString(item.id, `${label}.id`);
    if (ids.has(item.id)) throw new Error(`${label} contains duplicate id: ${item.id}`);
    ids.add(item.id);
  }
}

function parseJsonBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  return value;
}

function normalized(value) {
  return value.normalize("NFKC").toLowerCase();
}

function containsIdentifier(text, term) {
  const haystack = normalized(text);
  const needle = normalized(term);
  if (/^[a-z0-9_]+$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`).test(haystack);
  }
  return haystack.includes(needle);
}

function validateProviderText(text, corpus, label, { includeWorkspaceToolNames = true, includeDoorToolNames = true } = {}) {
  const terms = [
    ...PROVIDER_PROHIBITED_TERMS,
    ...corpus.lanes.map((lane) => lane.id),
    ...(includeWorkspaceToolNames ? corpus.workspaceMcp.tools : []),
    ...(includeDoorToolNames ? corpus.expectedDoorTools : []),
  ];
  for (const term of terms) if (containsIdentifier(text, term)) throw new Error(`${label} contains prohibited provider hint: ${term}`);
}

function containsReportedIdentifierDigest(text) {
  const tokens = normalized(text).match(/[a-z0-9_.=]+/g) ?? [];
  for (const token of tokens) {
    for (let start = 0; start < token.length; start += 1) {
      for (let end = start + 4; end <= token.length; end += 1) {
        const digest = crypto.createHash("sha256").update(token.slice(start, end)).digest("hex");
        if (REPORTED_IDENTIFIER_SHA256.has(digest)) return true;
      }
    }
  }
  return false;
}

function validateCorpus(corpus) {
  assertExactKeys(corpus, "corpus", CORPUS_KEYS);
  if (corpus.schemaVersion !== 2 || corpus.corpusRevision !== 2 || corpus.rubricVersion !== 2 || corpus.resultSchemaVersion !== 2 || corpus.runtimeProtocolVersion !== 1 || corpus.corpusId !== "pico-spatial-agent-bench-v1") throw new Error("corpus version drift");
  assertExactKeys(corpus.supersedes, "corpus.supersedes", new Set(["identitySha256", "measuredAttempts", "reason"]));
  if (corpus.supersedes.identitySha256 !== SUPERSEDED_IDENTITY || corpus.supersedes.measuredAttempts !== 0 || corpus.supersedes.reason !== "premeasurement_contract_correction") throw new Error("corpus superseded identity drift");
  if (corpus.protocolVectorsFile !== "protocol-vectors.json") throw new Error("corpus protocol vector path drift");
  assertExactKeys(corpus.workspaceMcp, "corpus.workspaceMcp", new Set(["serverName", "tools"]));
  if (corpus.workspaceMcp.serverName !== "agentbench-workspace" || canonicalJson(corpus.workspaceMcp.tools) !== canonicalJson(WORKSPACE_TOOL_NAMES)) throw new Error("corpus workspace MCP drift");
  assertExactKeys(corpus.claudeClientBoundary, "corpus.claudeClientBoundary", new Set(["version", "clientZone", "authentication", "subprocessCredentialScrub"]));
  if (corpus.claudeClientBoundary.version !== 1 || corpus.claudeClientBoundary.clientZone !== "trusted_supervisor" || corpus.claudeClientBoundary.authentication !== "max_oauth_keychain" || corpus.claudeClientBoundary.subprocessCredentialScrub !== true) throw new Error("corpus Claude client boundary drift");
  if (corpus.sdkVersion !== "0.13.3" || corpus.claudeCliVersion !== "2.1.233" || corpus.claudeCliCommit !== "f8d57569aaf3" || corpus.claudeCliSha256 !== "bc466b6cde63edafc773f471a1fb98787fabb31f52240c8616ce7e1f587b212d") throw new Error("corpus pinned version drift");
  assertExactKeys(corpus.picoCli, "corpus.picoCli", new Set(["package", "version", "integrity"]));
  if (corpus.picoCli.package !== "@picoxr/pico-cli" || corpus.picoCli.version !== "0.4.2") throw new Error("pico-cli version drift");
  assertString(corpus.picoCli.integrity, "corpus.picoCli.integrity");
  assertExactKeys(corpus.toolchainNpm, "corpus.toolchainNpm", new Set(["version", "integrity"]));
  if (corpus.toolchainNpm.version !== "10.9.2") throw new Error("npm version drift");
  assertString(corpus.toolchainNpm.integrity, "corpus.toolchainNpm.integrity");
  if (corpus.effort !== "high") throw new Error("corpus effort drift");
  for (const [key, expected] of [["timeoutMs", 1_800_000], ["maxTurns", 100], ["maxOutputBytes", 67_108_864], ["seed", 20_260_816]]) {
    if (!Number.isSafeInteger(corpus[key]) || corpus[key] !== expected) throw new Error(`corpus ${key} drift`);
  }
  if (!Array.isArray(corpus.expectedDoorTools) || corpus.expectedDoorTools.length !== 18 || new Set(corpus.expectedDoorTools).size !== 18) throw new Error("corpus.expectedDoorTools must contain the frozen door tool set");
  for (const tool of corpus.expectedDoorTools) assertString(tool, "corpus.expectedDoorTools entry");
  if (!Array.isArray(corpus.controlVariantIds) || new Set(corpus.controlVariantIds).size !== corpus.controlVariantIds.length) throw new Error("corpus.controlVariantIds contains duplicates");
  for (const id of corpus.controlVariantIds) assertString(id, "corpus.controlVariantIds entry");
  if (!Array.isArray(corpus.lanes) || corpus.lanes.length !== 4) throw new Error("corpus.lanes must contain four lanes");
  for (const lane of corpus.lanes) {
    assertExactKeys(lane, "corpus.lanes entry", new Set(["id", "model", "treatment", "role"]));
    assertString(lane.id, "corpus lane id");
    if (!["claude-sonnet-5", "claude-opus-5"].includes(lane.model) || !["mcp", "bare"].includes(lane.treatment) || !["primary", "control"].includes(lane.role)) throw new Error("corpus lane drift");
  }
  assertIds(corpus.lanes, "corpus.lanes");
  if (corpus.lanes.filter((lane) => lane.role === "primary").length !== 2 || corpus.lanes.filter((lane) => lane.role === "control").length !== 2) throw new Error("corpus lanes must contain two primary and two control lanes");
  if (!Array.isArray(corpus.variants) || corpus.variants.length !== 5) throw new Error("corpus.variants must contain five variants");
  for (const variant of corpus.variants) {
    assertExactKeys(variant, "corpus.variants entry", new Set(["id", "title", "items"]));
    assertString(variant.id, "corpus variant id");
    assertString(variant.title, "corpus variant title");
    if (!Array.isArray(variant.items) || variant.items.length !== 3) throw new Error("each variant must contain three items");
    for (const item of variant.items) {
      assertString(item, "corpus variant item");
      if (item === "__agentbench_unknown_item__") throw new Error("corpus variant contains the frozen unknown-item literal");
    }
  }
  assertIds(corpus.variants, "corpus.variants");
  const variantIds = new Set(corpus.variants.map((variant) => variant.id));
  for (const id of corpus.controlVariantIds) if (!variantIds.has(id)) throw new Error(`corpus control variant is unknown: ${id}`);
}

function validatePrompt(prompt, corpus) {
  const found = new Set();
  for (const match of prompt.matchAll(/{{([^{}]+)}}/g)) {
    if (!TEMPLATE_TOKENS.has(match[1])) throw new Error(`prompt contains undeclared template token: ${match[1]}`);
    found.add(match[1]);
  }
  for (const token of TEMPLATE_TOKENS) if (!found.has(token)) throw new Error(`prompt is missing template token: ${token}`);
  for (const variant of corpus.variants) validateProviderText(renderPromptValue(corpus, prompt, variant.id), corpus, `rendered prompt ${variant.id}`);
}

function validateJsonSchema(schema, label) {
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties) || schema.additionalProperties !== false || !Array.isArray(schema.required)) throw new Error(`${label} must be a strict object schema`);
  if (new Set(schema.required).size !== schema.required.length) throw new Error(`${label}.required contains duplicates`);
  for (const key of schema.required) if (!Object.hasOwn(schema.properties, key)) throw new Error(`${label}.required names an unknown property: ${key}`);
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!isRecord(property)) throw new Error(`${label}.properties.${key} must be an object`);
    if (property.type === "object") validateJsonSchema(property, `${label}.properties.${key}`);
    if (property.type === "array") {
      if (!isRecord(property.items)) throw new Error(`${label}.properties.${key}.items must be an object`);
      if (property.items.type === "object") validateJsonSchema(property.items, `${label}.properties.${key}.items`);
    }
  }
}

function validateWorkspaceTools(tools, corpus) {
  if (!Array.isArray(tools) || tools.length !== 4) throw new Error("workspace tools must contain four provider-visible objects");
  if (canonicalJson(tools.map((tool) => tool?.name)) !== canonicalJson(corpus.workspaceMcp.tools)) throw new Error("workspace tool order or workspace tool names drift");
  for (const [index, tool] of tools.entries()) {
    assertExactKeys(tool, `workspace tool ${index}`, new Set(["name", "description", "inputSchema", "outputSchema", "annotations"]));
    if (tool.description !== WORKSPACE_DESCRIPTIONS[index]) throw new Error(`workspace tool ${tool.name} description drift`);
    validateJsonSchema(tool.inputSchema, `workspace tool ${tool.name} inputSchema`);
    validateJsonSchema(tool.outputSchema, `workspace tool ${tool.name} outputSchema`);
    assertExactKeys(tool.annotations, `workspace tool ${tool.name} annotations`, new Set(["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]));
    for (const value of Object.values(tool.annotations)) if (typeof value !== "boolean") throw new Error(`workspace tool ${tool.name} annotations must be booleans`);
  }
  const inputs = tools.map((tool) => tool.inputSchema.required);
  if (canonicalJson(inputs) !== canonicalJson([["path"], ["path"], ["path", "content"], ["path", "oldText", "newText", "expectedOccurrences"]])) throw new Error("workspace tool required input drift");
  const serialized = canonicalJson(tools);
  validateProviderText(serialized, corpus, "workspace tool provider snapshot", { includeWorkspaceToolNames: false });
  const digest = crypto.createHash("sha256").update(serialized).digest("hex");
  if (digest !== WORKSPACE_TOOLS_CANONICAL_SHA256) throw new Error("workspace tool canonical snapshot digest drift");
}

function validatePicoDoorTools(tools, corpus) {
  if (!Array.isArray(tools) || tools.length !== 18) throw new Error("PICO door provider-visible snapshot must contain eighteen tools");
  if (canonicalJson(tools.map((tool) => tool?.name)) !== canonicalJson(corpus.expectedDoorTools)) throw new Error("PICO door tool order drift");
  const allowed = new Set(["name", "title", "description", "inputSchema", "outputSchema", "annotations", "execution"]);
  for (const [index, tool] of tools.entries()) {
    if (!isRecord(tool)) throw new Error(`PICO door provider-visible snapshot ${index} must be an object`);
    for (const key of Object.keys(tool)) if (!allowed.has(key)) throw new Error(`PICO door provider-visible snapshot ${tool.name ?? index} contains unknown key: ${key}`);
    for (const key of ["name", "description", "inputSchema", "execution"]) if (!Object.hasOwn(tool, key)) throw new Error(`PICO door provider-visible snapshot ${index} is missing required key: ${key}`);
    assertString(tool.name, `PICO door ${index} name`);
    assertString(tool.description, `PICO door ${tool.name} description`);
    if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== "object" || !isRecord(tool.inputSchema.properties) || (Object.hasOwn(tool.inputSchema, "additionalProperties") && tool.inputSchema.additionalProperties !== false)) throw new Error(`PICO door ${tool.name} inputSchema drift`);
    if (Object.hasOwn(tool, "outputSchema") && (!isRecord(tool.outputSchema) || tool.outputSchema.type !== "object")) throw new Error(`PICO door ${tool.name} outputSchema drift`);
    if (!isRecord(tool.execution) || tool.execution.taskSupport !== "forbidden") throw new Error(`PICO door ${tool.name} execution drift`);
  }
  const serialized = normalized(canonicalJson(tools));
  for (const identifier of REPORTED_IDENTIFIERS) if (serialized.includes(normalized(identifier))) throw new Error(`PICO door schema contains reported confidential identifier: ${identifier}`);
  if (containsReportedIdentifierDigest(serialized)) throw new Error("PICO door schema contains reported confidential identifier digest");
}

function protocolStep(name, waitBeforeMs, comparison, request) {
  return { name, waitBeforeMs, comparison, request };
}

function expectedProtocolVectors() {
  const item = (variantItemIndex) => ({ variantItemIndex });
  const state = [
    protocolStep("fresh-baseline", 0, "fresh_baseline", { command: "snapshot", protocol_version: 1, request_id: "state-001" }),
    protocolStep("pause-before-stage", 0, "pause_accepted", { command: "pause", protocol_version: 1, request_id: "state-002" }),
    protocolStep("paused-baseline", 0, "paused_baseline", { command: "snapshot", protocol_version: 1, request_id: "state-003" }),
    protocolStep("duplicate-id", 0, "duplicate_request_id", { command: "snapshot", protocol_version: 1, request_id: "state-003" }),
    protocolStep("invalid-fields", 0, "invalid_fields", { command: "snapshot", item: item(0), protocol_version: 1, request_id: "state-004" }),
    protocolStep("unknown-item", 0, "unknown_item", { command: "select", item: "__agentbench_unknown_item__", protocol_version: 1, request_id: "state-005" }),
    protocolStep("resume-before-selection", 0, "resume_accepted", { command: "resume", protocol_version: 1, request_id: "state-006" }),
    protocolStep("select-first", 0, "first_selection", { command: "select", item: item(0), protocol_version: 1, request_id: "state-007" }),
    protocolStep("pause-retained", 0, "paused_selection", { command: "pause", protocol_version: 1, request_id: "state-008" }),
    protocolStep("close-first", 0, "close_first", { command: "close_stage", protocol_version: 1, request_id: "state-009" }),
    protocolStep("open-first", 0, "reopen_first", { command: "open_stage", protocol_version: 1, request_id: "state-010" }),
    protocolStep("snapshot-first-reopen", 0, "first_reopen_snapshot", { command: "snapshot", protocol_version: 1, request_id: "state-011" }),
    protocolStep("resume-after-first-reopen", 0, "resume_second", { command: "resume", protocol_version: 1, request_id: "state-012" }),
    protocolStep("select-second", 0, "second_selection", { command: "select", item: item(1), protocol_version: 1, request_id: "state-013" }),
    protocolStep("close-second", 0, "close_second", { command: "close_stage", protocol_version: 1, request_id: "state-014" }),
    protocolStep("open-second", 0, "reopen_second", { command: "open_stage", protocol_version: 1, request_id: "state-015" }),
    protocolStep("final-snapshot", 0, "final_snapshot", { command: "snapshot", protocol_version: 1, request_id: "state-016" }),
  ];
  const tick = [
    protocolStep("select", 0, "tick_select", { command: "select", item: item(0), protocol_version: 1, request_id: "tick-001" }),
    protocolStep("running-baseline-one", 0, "running_baseline_one", { command: "snapshot", protocol_version: 1, request_id: "tick-002" }),
  ];
  for (let id = 3; id <= 52; id += 1) tick.push(protocolStep(`running-one-${id}`, 100, "running_window_one", { command: "snapshot", protocol_version: 1, request_id: `tick-${String(id).padStart(3, "0")}` }));
  tick.push(protocolStep("pause", 0, "tick_pause", { command: "pause", protocol_version: 1, request_id: "tick-053" }));
  tick.push(protocolStep("paused-baseline", 0, "tick_paused_baseline", { command: "snapshot", protocol_version: 1, request_id: "tick-054" }));
  tick.push(protocolStep("paused-hold", 500, "tick_paused_hold", { command: "snapshot", protocol_version: 1, request_id: "tick-055" }));
  tick.push(protocolStep("resume", 0, "tick_resume", { command: "resume", protocol_version: 1, request_id: "tick-056" }));
  tick.push(protocolStep("running-baseline-two", 0, "running_baseline_two", { command: "snapshot", protocol_version: 1, request_id: "tick-057" }));
  for (let id = 58; id <= 107; id += 1) tick.push(protocolStep(`running-two-${id}`, 100, "running_window_two", { command: "snapshot", protocol_version: 1, request_id: `tick-${String(id).padStart(3, "0")}` }));
  const surface = (kind, semantic) => {
    const prefix = `surface-${kind}`;
    const steps = [protocolStep("select", 0, "surface_select", { command: "select", item: item(0), protocol_version: 1, request_id: `${prefix}-001` })];
    for (let id = 2; id <= 61; id += 1) steps.push(protocolStep(`poll-${id}`, 250, `surface_poll_${semantic}`, { command: "snapshot", protocol_version: 1, request_id: `${prefix}-${String(id).padStart(3, "0")}` }));
    return steps;
  };
  return {
    version: 1,
    encoding: "canonical-json-utf8-no-newline",
    maxPayloadBytes: 65_536,
    unknownItem: "__agentbench_unknown_item__",
    responseComparisons: {
      state: ["fresh_baseline", "pause_accepted", "paused_baseline", "duplicate_request_id", "invalid_fields", "unknown_item", "resume_accepted", "first_selection", "paused_selection", "close_first", "reopen_first", "first_reopen_snapshot", "resume_second", "second_selection", "close_second", "reopen_second", "final_snapshot"],
      tick: ["tick_select", "running_baseline_one", "running_window_one", "tick_pause", "tick_paused_baseline", "tick_paused_hold", "tick_resume", "running_baseline_two", "running_window_two"],
      surface: ["surface_select", "surface_poll_table", "surface_poll_floor"],
    },
    responsePolicy: {
      common: {
        duplicateKeyAware: true,
        rejectExtraKeys: true,
        requireSafeIntegers: true,
        requireFiniteNumbers: true,
        requireNonEmptyIdsAndNonces: true,
        canonicalPayload: "utf8-canonical-json-no-bom-padding-or-newline",
        successfulErrorCode: null,
        processInstance: "byte-identical-within-run",
      },
      state: {
        baseline: {
          step: "fresh-baseline",
          selection: null,
          visit_count: 0,
          paused: false,
          stage_open: false,
          stage_generation: 0,
          surface_status: "idle",
          surface_semantic: null,
          placement_count: 0,
        },
        negative: {
          baselineStep: "paused-baseline",
          errorSteps: [
            { step: "duplicate-id", status: "error", errorCode: "duplicate_request_id", requestId: "state-003" },
            { step: "invalid-fields", status: "error", errorCode: "invalid_fields", requestId: "state-004" },
            { step: "unknown-item", status: "error", errorCode: "unknown_item", requestId: "state-005" },
          ],
          equalToBaseline: ["selection", "title", "visit_count", "paused", "stage_open", "stage_generation", "tick_count"],
          fixedEachResponse: { surface_status: "idle", surface_semantic: null, placement_count: 0 },
        },
        milestones: [
          { step: "select-first", selectionItemIndex: 0, visit_count: 1, paused: false, stage_open: true, stage_generation: 1 },
          { step: "snapshot-first-reopen", selectionItemIndex: 0, visit_count: 1, paused: true, stage_open: true, stage_generation: 2 },
          { step: "select-second", selectionItemIndex: 1, visit_count: 2, paused: false, stage_open: true, stage_generation: 2 },
          { step: "final-snapshot", selectionItemIndex: 1, visit_count: 2, paused: false, stage_open: true, stage_generation: 3 },
        ],
        titleAfterReopen: "equals-preceding-accepted-selection-title",
      },
      tick: {
        counter: "tick_count",
        neverDecreases: true,
        runningWindows: [
          { baselineStep: "running-baseline-one", firstStep: "running-one-3", lastStep: "running-one-52", polls: 50, intervalMs: 100, requiresGreaterThanBaseline: true },
          { baselineStep: "running-baseline-two", firstStep: "running-two-58", lastStep: "running-two-107", polls: 50, intervalMs: 100, requiresGreaterThanBaseline: true },
        ],
        pausedWindow: { baselineStep: "paused-baseline", comparisonStep: "paused-hold", waitMs: 500, requiresEqual: true },
      },
      surface: {
        neverDecreases: ["placement_count", "tick_count"],
        searchingBeforeFirstReady: true,
        afterFirstReady: { placement_count: 3 },
        runs: [
          { run: "table_surface", semantic: "table", polls: 60, intervalMs: 250 },
          { run: "floor_surface", semantic: "floor", polls: 60, intervalMs: 250 },
        ],
      },
    },
    environmentFailureClassification: {
      beforeFixtureReadBack: "blocked_environment",
      afterFixtureReadBack: "fail",
    },
    runs: [
      { name: "state", fixtureId: "table-present", itemIndexes: [0, 1], resetLifecycle: [...RESET_LIFECYCLE], steps: state },
      { name: "tick", fixtureId: "table-present", itemIndexes: [0], resetLifecycle: [...RESET_LIFECYCLE], steps: tick },
      { name: "table_surface", fixtureId: "table-present", itemIndexes: [0], resetLifecycle: [...RESET_LIFECYCLE], steps: surface("table", "table") },
      { name: "floor_surface", fixtureId: "floor-only", itemIndexes: [0], resetLifecycle: [...RESET_LIFECYCLE], steps: surface("floor", "floor") },
    ],
  };
}

function validateProtocolVectors(vectors) {
  if (canonicalJson(vectors) !== canonicalJson(expectedProtocolVectors())) throw new Error("protocol vectors contain unknown keys or protocol drift");
}

function validateToolchain(packageJson, lockfile, corpus) {
  assertExactKeys(packageJson, "toolchain package.json", new Set(["name", "version", "private", "dependencies"]));
  if (packageJson.name !== "pico-spatial-agent-bench-pico-cli-toolchain" || packageJson.version !== "1.0.0" || packageJson.private !== true) throw new Error("toolchain package metadata drift");
  assertExactKeys(packageJson.dependencies, "toolchain dependencies", new Set([corpus.picoCli.package]));
  if (packageJson.dependencies[corpus.picoCli.package] !== corpus.picoCli.version) throw new Error("toolchain pico-cli version drift");
  if (!isRecord(lockfile) || lockfile.lockfileVersion !== 3 || !isRecord(lockfile.packages)) throw new Error("toolchain lockfile must use npm lockfile v3");
  const root = lockfile.packages[""];
  if (!isRecord(root) || !isRecord(root.dependencies) || root.dependencies[corpus.picoCli.package] !== corpus.picoCli.version) throw new Error("toolchain lockfile root dependency drift");
  for (const [entryPath, entry] of Object.entries(lockfile.packages)) {
    if (entryPath === "") continue;
    if (!isRecord(entry) || typeof entry.resolved !== "string" || !entry.resolved || typeof entry.integrity !== "string" || !entry.integrity) throw new Error(`toolchain lockfile package lacks resolved URL or integrity: ${entryPath}`);
  }
  const picoEntry = lockfile.packages[`node_modules/${corpus.picoCli.package}`];
  if (!isRecord(picoEntry) || picoEntry.version !== corpus.picoCli.version || picoEntry.integrity !== corpus.picoCli.integrity) throw new Error("toolchain pico-cli integrity drift");
}

function renderPromptValue(corpus, prompt, variantId) {
  const variant = corpus.variants.find((entry) => entry.id === variantId);
  if (!variant) throw new Error(`unknown corpus variant: ${variantId}`);
  const replacements = { VARIANT_TITLE: variant.title, VARIANT_ID: variant.id, ITEM_1: variant.items[0], ITEM_2: variant.items[1], ITEM_3: variant.items[2] };
  const rendered = prompt.replace(/{{([^{}]+)}}/g, (_match, token) => {
    if (!Object.hasOwn(replacements, token)) throw new Error(`prompt contains undeclared template token: ${token}`);
    return replacements[token];
  });
  if (/{{[^{}]+}}/.test(rendered)) throw new Error("prompt contains unreplaced template tokens");
  return rendered;
}

function counterStream(seed, label) {
  let counter = 0;
  return () => crypto.createHash("sha256").update(`${String(seed)}\0${label}\0${String(counter++)}`).digest().readUInt32BE(0) / 2 ** 32;
}

function fisherYates(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

export function loadCorpus(corpusDir) {
  const directory = path.resolve(corpusDir);
  const files = {
    corpus: path.join(directory, "corpus.json"),
    prompt: path.join(directory, "prompt.md"),
    systemPrompt: path.join(directory, "system-prompt.md"),
    workspaceTools: path.join(directory, "workspace-tools.json"),
    picoDoorTools: path.join(directory, "pico-door-tools.json"),
    protocolVectors: path.join(directory, "protocol-vectors.json"),
    package: path.join(directory, "pico-cli-toolchain", "package.json"),
    lock: path.join(directory, "pico-cli-toolchain", "package-lock.json"),
  };
  const bytes = Object.fromEntries(Object.entries(files).map(([name, filePath]) => [name, fs.readFileSync(filePath)]));
  const corpus = parseJsonBytes(bytes.corpus, "corpus");
  const prompt = bytes.prompt.toString("utf8");
  const systemPrompt = bytes.systemPrompt.toString("utf8");
  const workspaceTools = parseJsonBytes(bytes.workspaceTools, "workspace tools");
  const picoDoorTools = parseJsonBytes(bytes.picoDoorTools, "PICO door tools");
  const protocolVectors = parseJsonBytes(bytes.protocolVectors, "protocol vectors");
  const packageJson = parseJsonBytes(bytes.package, "toolchain package.json");
  const lockfile = parseJsonBytes(bytes.lock, "toolchain package-lock.json");
  validateCorpus(corpus);
  validatePrompt(prompt, corpus);
  if (systemPrompt !== EXACT_SYSTEM_PROMPT) throw new Error("system prompt drift");
  validateProviderText(systemPrompt, corpus, "system prompt");
  validateWorkspaceTools(workspaceTools, corpus);
  validatePicoDoorTools(picoDoorTools, corpus);
  validateProtocolVectors(protocolVectors);
  validateToolchain(packageJson, lockfile, corpus);
  const identity = canonicalIdentity({
    corpus,
    corpusBytes: bytes.corpus.toString("base64"),
    promptBytes: bytes.prompt.toString("base64"),
    systemPromptBytes: bytes.systemPrompt.toString("base64"),
    workspaceToolsBytes: bytes.workspaceTools.toString("base64"),
    picoDoorToolsBytes: bytes.picoDoorTools.toString("base64"),
    protocolVectorsBytes: bytes.protocolVectors.toString("base64"),
    toolchainPackageBytes: bytes.package.toString("base64"),
    toolchainLockBytes: bytes.lock.toString("base64"),
  });
  return deepFreeze({ corpus, prompt, systemPrompt, workspaceTools, picoDoorTools, protocolVectors, identity });
}

export function renderPrompt(loaded, variantId) {
  if (!loaded || !loaded.corpus || typeof loaded.prompt !== "string") throw new Error("loaded corpus is invalid");
  return renderPromptValue(loaded.corpus, loaded.prompt, variantId);
}

export function expectedMcpInventory(loaded, laneId) {
  if (!loaded || !loaded.corpus || !Array.isArray(loaded.workspaceTools) || !Array.isArray(loaded.picoDoorTools)) throw new Error("loaded corpus is invalid");
  const lane = loaded.corpus.lanes.find((entry) => entry.id === laneId);
  if (!lane) throw new Error(`unknown corpus lane: ${laneId}`);
  const inventory = [{ serverName: "agentbench-workspace", domain: "workspace", tools: loaded.workspaceTools }];
  if (lane.treatment === "mcp") inventory.push({ serverName: "pico-spatial", domain: "pico", tools: loaded.picoDoorTools });
  return deepFreeze(inventory);
}

export function createPreliminarySchedule(loaded) {
  const { corpus } = loaded;
  const primaryLanes = corpus.lanes.filter((lane) => lane.role === "primary");
  const primaryLaneCandidates = [...primaryLanes]
    .sort((left, right) => Number(right.treatment === "bare") - Number(left.treatment === "bare"))
    .map((lane) => lane.id);
  const controlLanes = corpus.lanes.filter((lane) => lane.role === "control").map((lane) => lane.id);
  const orderedVariants = fisherYates(corpus.variants.map((variant) => variant.id), counterStream(corpus.seed, "preliminary-primary-order"));
  const laneRandom = counterStream(corpus.seed, "preliminary-primary-lanes");
  const primary = orderedVariants.map((variantId) => ({ variantId, lanes: fisherYates(primaryLaneCandidates, laneRandom) }));
  const controlCandidates = controlLanes.flatMap((laneId) => corpus.controlVariantIds.map((variantId) => ({ variantId, laneId })));
  const controls = fisherYates(controlCandidates, counterStream(corpus.seed, "preliminary-controls"));
  return deepFreeze({ primary, controls });
}

export function createStructuralThresholdSchedule(loaded) {
  const { corpus } = loaded;
  const primaryLanes = corpus.lanes.filter((lane) => lane.role === "primary").map((lane) => lane.id);
  if (canonicalJson(primaryLanes) !== canonicalJson(["sonnet_mcp", "opus_bare"])) throw new Error("primary lane drift");
  const pairs = [0, 1].flatMap((accountBlock) => corpus.variants.map((variant) => ({ accountBlock, variantId: variant.id })));
  const orderedPairs = fisherYates(pairs, counterStream(corpus.seed, "structural-threshold-primary"));
  const laneCandidates = [
    ...Array.from({ length: 5 }, () => ["sonnet_mcp", "opus_bare"]),
    ...Array.from({ length: 5 }, () => ["opus_bare", "sonnet_mcp"]),
  ];
  const laneOrders = fisherYates(laneCandidates, counterStream(corpus.seed, "structural-threshold-primary-lanes"));
  return deepFreeze({ primary: orderedPairs.map((pair, index) => ({ ...pair, lanes: laneOrders[index] })), controls: [] });
}
